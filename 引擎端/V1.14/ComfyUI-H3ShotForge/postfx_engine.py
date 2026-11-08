"""postfx_engine.py — 1.14b U1: 后处理核心模块 (纯函数+编排)

不 import batch_core — 鸭子类型 engine (仅调 _post / _wait_shot / 可选 _fresh_id).
两件: 纯函数层 (后缀戳/分段决策/组装/取戳映射) + 编排层 run_postfx_batch.

Y1: 产物子目录 + _postfx 相对路径锚 run_dir 记账 (消费端 apply_postfx_map)
Y2: 分级回退是消费端逻辑 (U3); 本模块只保证记账完整 + 失败隔离
Y4: 分段阈值 (should_segment) 校准期可降阈, 60s 真机全链挂账待 U5
X5: 带戳跳过 (_x2/_48fps)
D3: 同 kind 连续提交 (kinds 顺序定死 upscale → interp)

U5 长视频分段: 接口桩 `segment_video()` 留 NotImplementedError, 主链先行.
"""
import copy
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import traceback


# ============================================================================
# 1. 纯函数: 后缀戳命名 / 分段决策 / 模板组装 / 取戳映射
# ============================================================================

_KIND_STAMPS = {
    "upscale": "_x2",
    "interp":  "_48fps",
}


def _num_str(v):
    """数字 → 戳串 (去尾零: 2.0 → "2" / 2.5 → "2.5")."""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


def kind_stamp(kind, params=None):
    """后缀戳派生 (R-50): params 缺省 → _KIND_STAMPS 旧值 (逐字节不变);
    带参 → 动态戳: upscale scale → _x{scale} / target → _{min(W,H)}p; interp → _{fps}fps."""
    if kind not in _KIND_STAMPS:
        raise ValueError("unknown postfx kind: %r (allowed: %s)"
                         % (kind, sorted(_KIND_STAMPS.keys())))
    if not params:
        return _KIND_STAMPS[kind]
    if kind == "interp" and "target_fps" in params:
        return "_%sfps" % _num_str(params["target_fps"])
    if kind == "upscale":
        if params.get("mode") == "scale" and "scale" in params:
            return "_x%s" % _num_str(params["scale"])
        if params.get("mode") == "target" and "width" in params and "height" in params:
            return "_%dp" % min(params["width"], params["height"])
    raise ValueError("postfx %s 参数形态非法: %r" % (kind, params))


def postfx_output_name(orig_name, kind, params=None):
    """后缀戳命名: a.mp4 + upscale → a_x2.mp4; a_x2.mp4 + interp → a_x2_48fps.mp4
    R-50: 传 params → 动态戳 (a.mp4 ×2.5 → a_x2.5.mp4); 不传 = 旧值逐字节不变."""
    stamp = kind_stamp(kind, params)
    stem, ext = os.path.splitext(orig_name)
    return stem + stamp + ext


def has_stamp_token(stem, stamp):
    """X5 戳命中判定 (R-50): 按 "_" 切词整词相等 —— 旧子串判定会让 _x2.5 误命中 _x2.
    端点 X5 全戳守卫同款调用 (同一判定单一落点, 不各写一份)."""
    token = stamp[1:] if stamp.startswith("_") else stamp
    return token in stem.split("_")


_DEFAULT_SEG_THRESHOLD = {"duration_s": 60, "frame_count": 1500}


def template_names(kind, engine_choice):
    """E1: 引擎选择 → 模板文件名 (单一落点).

    放大走 engine_choice: rtxvsr → h3_postfx_upscale_rtx.json, 其余 → h3_postfx_upscale.json
    (engine_choice 非法值按 seedvr2 兜底, 与 plan_from_flags 校验口径一致);
    **interp 不受引擎影响**.
    """
    if kind == "upscale" and engine_choice == "rtxvsr":
        return "h3_postfx_upscale_rtx.json"
    return "h3_postfx_%s.json" % kind


def log_template(path):
    """E1: 模板加载日志一行 — `[H3 postfx] 模板: <绝对路径> md5=<前8位>`.
    读文件失败 (权限/竞态) → 退化为只打路径, 不抛 (日志不该打断主链)."""
    line = "[H3 postfx] 模板: %s" % os.path.abspath(path)
    try:
        with open(path, "rb") as f:
            line += " md5=" + hashlib.md5(f.read()).hexdigest()[:8]
    except OSError:
        pass
    print(line, flush=True)


def should_segment(meta, threshold=None):
    """分段决策: duration_s>=thr 或 frame_count>=thr 触发.
    Y4 校准期可降阈 (例: {"duration_s": 8, "frame_count": 200})."""
    thr = threshold or _DEFAULT_SEG_THRESHOLD
    return (meta.get("duration_s", 0) >= thr["duration_s"]
            or meta.get("frame_count", 0) >= thr["frame_count"])


_PROBE_TIMEOUT_S = 30


def _ffprobe_exe_fallback():
    """PATH 里的 ffprobe 优先; 否则让 subprocess 报 FileNotFoundError (可读诊断).
    与 _ffmpeg_exe_fallback 同款 — 本模块不依赖 batch_core/__init__ 的可执行解析;
    批路径/端点路径调用 probe_media_meta 时传各自既有解析结果 (见其 docstring).
    """
    return shutil.which("ffprobe") or "ffprobe"


def _fps_value(raw):
    """r_frame_rate 原始串 ("30000/1001" / "24/1" / float) → float; 非法/0 → 0.0."""
    try:
        num, _, den = str(raw).partition("/")
        d = float(den or 1)
        return (float(num) / d) if d else 0.0
    except (TypeError, ValueError):
        return 0.0


def probe_media_meta(path, ffprobe_exe=None, timeout=_PROBE_TIMEOUT_S):
    """W9R W9-1: 媒体探测单一落点 — ffprobe 取 {duration_s: float, frame_count: int,
    width/height: int (R-50 增; 流未报则不带键)}。

    介质: 直接 subprocess 调 ffprobe (照 join_engine.probe_segment 先例; 不 import
    batch_core/join_engine 保低耦合). 可执行路径由调用方给: 批路径传
    batch_core._ffprobe_exe() (h3_config ffprobe_exe 可外置), 端点传 _h3_ffprobe_exe(),
    缺省回落 PATH 里的 ffprobe.
    frame_count: 流 nb_frames 优先 (容器元数据, 不解码全片), 缺则 round(fps × duration_s) 估算.
    失败 (可执行缺失/超时/非零退出/输出非 JSON/无视频流/两字段皆空) → None + 一行日志;
    绝不 raise — 调用方 meta 留空, 不阻断主链 (should_segment 对空 meta 恒 False)。
    """
    exe = ffprobe_exe or _ffprobe_exe_fallback()
    cmd = [exe, "-v", "error", "-print_format", "json",
           "-show_streams", "-show_format", path]
    fail = None
    data = None
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        if proc.returncode != 0:
            fail = "ffprobe rc=%d" % proc.returncode
        else:
            data = json.loads((proc.stdout or b"").decode("utf-8", "replace"))
    except (OSError, subprocess.TimeoutExpired) as e:
        fail = "%s" % e
    except ValueError:
        fail = "输出非 JSON"
    if fail is None and not isinstance(data, dict):
        # 1.14c C1 (挂账⑨): 合法 JSON 但非对象 (null/[]/字符串/数字) → 走既有降级,
        # 不得直呼 data.get 抛 AttributeError (docstring 声明"绝不 raise").
        fail = "输出非对象"
    if fail is None:
        v = next((s for s in (data.get("streams") or [])
                  if s.get("codec_type") == "video"), None)
        if v is None:
            fail = "无视频流"
        else:
            dur_raw = (data.get("format") or {}).get("duration") or v.get("duration")
            try:
                dur = float(dur_raw) if dur_raw not in (None, "") else 0.0
            except (TypeError, ValueError):
                dur = 0.0
            frames = 0
            nb = v.get("nb_frames")
            if nb not in (None, ""):
                try:
                    frames = int(nb)
                except (TypeError, ValueError):
                    frames = 0
            if frames <= 0 and dur > 0:
                frames = int(round(_fps_value(v.get("r_frame_rate")) * dur))
            if dur <= 0 and frames <= 0:
                fail = "时长/帧数皆缺"
            else:
                out = {"duration_s": max(dur, 0.0), "frame_count": max(frames, 0)}
                # R-50: 增 width/height 解析 (-show_streams 已有, 只加解析) —
                # seedvr2 按「源短边×倍数」换算 resolution 的输入; 流未报该字段则不带键
                # (取不到由 build_postfx_params 判 failed, 不臆造 0).
                for k in ("width", "height"):
                    try:
                        dim = int(v.get(k))
                    except (TypeError, ValueError):
                        continue
                    if dim > 0:
                        out[k] = dim
                return out
    print("[H3 postfx] 媒体探测失败 (%s): %s" % (path, fail), flush=True)
    return None


def _find_node(template, predicate):
    """模板内找第一个 class_type 匹配 predicate(class_type) 的节点 nid."""
    for nid, node in template.items():
        ct = node.get("class_type", "") or ""
        if predicate(ct):
            return nid, node
    return None, None


def _is_load_video(ct):
    return "LoadVideo" in ct  # 含 VHS_LoadVideo


def _is_save_video(ct):
    return ("SaveVideo" in ct) or ("VideoCombine" in ct)


def assemble_postfx_prompt(template, video_path, out_rel_path, params):
    """深拷贝 template, 填 LoadVideo 的 file/video 字段 + SaveVideo 的 filename_prefix.
    params 形如 {"SeedVR2Upscale": {"resolution": 2048}} — 按 class_type 覆盖 inputs.

    找不到 LoadVideo 或 SaveVideo 类节点 → ValueError 快速失败.
    """
    out = copy.deepcopy(template)
    # LoadVideo
    load_nid, load_node = _find_node(out, _is_load_video)
    if load_node is None:
        raise ValueError("template 缺 LoadVideo 类节点 (含 VHS_LoadVideo)")
    # 字段名按模板实际: 优先 "video" 再 "file"
    if "video" in load_node["inputs"]:
        load_node["inputs"]["video"] = video_path
    else:
        load_node["inputs"]["file"] = video_path
    # SaveVideo
    save_nid, save_node = _find_node(out, _is_save_video)
    if save_node is None:
        raise ValueError("template 缺 SaveVideo/VideoCombine 类节点")
    # U6 修正: filename_prefix 是"前缀"语义 — ComfyUI 会追加 _00001_.mp4 计数;
    # 传入的 out_rel_path 带 .mp4 扩展会产生 xxx.mp4_00001_.mp4 双扩展名 (U6 实证)。
    # 剥掉扩展让产物为 <dir>/<stem>_x2_00001_.mp4。
    prefix = out_rel_path
    stem, ext = os.path.splitext(prefix)
    if ext:
        prefix = stem
    save_node["inputs"]["filename_prefix"] = prefix
    # params 覆盖 — 按 class_type 匹配
    for ct, kv in (params or {}).items():
        nid, node = _find_node(out, lambda c, _ct=ct: c == _ct)
        if node is None:
            continue
        for k, v in (kv or {}).items():
            node["inputs"][k] = v
    return out


def _comfyui_actual_out_rel(out_rel):
    """SaveVideo filename_prefix 是前缀语义: 实际产物 = <prefix>_00001_.mp4 (首件计数).
    U6 实证: 记账若用传入的 out_rel (带 .mp4) 与实际落盘名不符, 消费端会误判丢失回退.
    """
    stem, ext = os.path.splitext(out_rel)
    return "%s_00001_%s" % (stem, ext or ".mp4")


def _within(child, root):
    """child 是否在 root 内 — 与 ComfyUI folder_paths.is_within_directory 同语义
    (两侧 realpath + commonpath, `..` 归一; 跨盘 ValueError → False)."""
    try:
        c = os.path.realpath(child)
        r = os.path.realpath(root)
        return os.path.commonpath([c, r]) == r
    except (OSError, ValueError):
        return False


def save_prefix(engine, run_dir, out_rel):
    """E4.1: ComfyUI 落点前缀 = <run_dir 相对 server 输出根>/<out_rel> (带扩展, 照旧).

    ComfyUI 只许写输出根之内 (folder_paths.get_save_image_path 越界即 raise) — 故落点
    必须以"相对输出根的前缀"给出, 才能与记账同锚 (run_dir/<out_rel>)。
    输出根取 engine._server_output_dir → engine.output_dir (batch_core:4432 先例);
    run_dir 不在输出根内 (归档/外置 output) → None, 调用方跳过该片 + 日志明示 (不提交);
    无输出根信息 (老调用形态) → 回落 out_rel (不猜坐标, 与改动前落点一致)。
    """
    root = getattr(engine, "_server_output_dir", None) or getattr(engine, "output_dir", None)
    if not root:
        return out_rel
    if not _within(run_dir, root):
        return None
    rel = os.path.relpath(run_dir, root)
    if rel in (os.curdir, ""):
        return out_rel
    return os.path.join(rel, out_rel)


def resolve_actual_rel(sub_dir, prefix_stem, files, out_rel):
    """E4.4: 记账取实际产物名 — files 中按 prefix_stem 前缀匹配, 优先 .mp4, 多命中取首个.
    files 空 (远端未回文件名) → 回落 _comfyui_actual_out_rel(out_rel)。

    返回相对 run_dir 的路径 (sub_dir 已含, 故不含 run_base 段) — 与消费端
    apply_postfx_map 的 os.path.join(run_dir, rel) 同锚 (files 只给裸文件名, 不含 subfolder).
    """
    cands = [f for f in (files or []) if isinstance(f, str) and f.startswith(prefix_stem)]
    if not cands:
        return _comfyui_actual_out_rel(out_rel)
    mp4 = [f for f in cands if f.lower().endswith(".mp4")]
    return os.path.join(sub_dir, (mp4 or cands)[0])


def manifest_sid_for(manifest, path):
    """消费端 sid 解析 (单一落点): abs 路径 → manifest 段键。

    _postfx 映射的键是 **manifest 段键** (shot_001), 而段产物名 stem 是渲染名
    (w3_s01_478163327_00001_) — 按文件名推 sid 全 miss, 取戳必然降级原件
    (真机 W3 实证 2026-09-17 002522)。
    逐段拿 path 的 basename 比对 manifest[sid]["files"] 的 basename (两侧归一,
    files 可能是裸文件名/带子目录); `_` 前缀保留键跳过。未命中回落 basename 去扩展
    (旧口径, 兼容"文件名 stem == sid"的老批)。
    """
    base = os.path.basename(path)
    if isinstance(manifest, dict):
        for sid, info in manifest.items():
            if not isinstance(sid, str) or sid.startswith("_"):
                continue
            if not isinstance(info, dict):
                continue
            files = info.get("files")
            if not isinstance(files, list):
                continue
            for fn in files:
                if isinstance(fn, str) and os.path.basename(fn) == base:
                    return sid
    return os.path.splitext(base)[0]


def apply_postfx_map(parts, postfx_map, kind, run_dir):
    """消费端取戳 (Y1).

    parts: [(sid, abs_path), ...] 或 [abs_path, ...] (无 sid 时 sid 退化为 basename)
    postfx_map: manifest _postfx 结构, 可 None
    kind: "upscale" / "interp"
    run_dir: 锚定相对路径解析的批运行目录

    返回 (new_parts, warnings):
      - 映射有 + (run_dir/rel) 文件存在 → 换成绝对戳路径
      - 映射有 + 文件丢失 → 回退原件 + 一条告警串
      - 无映射 / postfx_map=None → 原件
    """
    new_parts = []
    warnings = []
    kind_map = _kind_map(postfx_map, kind)
    for entry in parts:
        if isinstance(entry, tuple) and len(entry) >= 2:
            sid, orig_abs = entry[0], entry[1]
        else:
            orig_abs = entry
            sid = os.path.basename(orig_abs)
        rel = kind_map.get(sid) if isinstance(kind_map, dict) else None
        if not rel:
            new_parts.append(orig_abs)
            continue
        candidate = os.path.normpath(os.path.join(run_dir, rel))
        if os.path.exists(candidate):
            new_parts.append(candidate)
        else:
            warnings.append("后处理 %s 戳产物 %s 丢失 (sid=%s), 回退原件 %s"
                            % (kind, rel, sid, orig_abs))
            new_parts.append(orig_abs)
    return new_parts, warnings


def _entry_path(entry):
    """parts 条目 → 原件绝对路径 (tuple (sid, path) 或裸路径)."""
    if isinstance(entry, tuple) and len(entry) >= 2:
        return entry[1]
    return entry


def _entry_sid(entry):
    """parts 条目 → sid (无 sid 时退化为 basename, 与 apply_postfx_map 同口径)."""
    if isinstance(entry, tuple) and len(entry) >= 2:
        return entry[0]
    return os.path.basename(entry)


def _kind_map(postfx_map, kind):
    """postfx_map 的 kind 子映射归一: 非 dict 映射/缺键/值非 dict → {}."""
    if not isinstance(postfx_map, dict):
        return {}
    m = postfx_map.get(kind)
    return m if isinstance(m, dict) else {}


def pick_level(parts, postfx_map, run_dir):
    """E4.3: 层级选择 (消费端优先级的唯一定义处) — 逐级 interp → upscale → None(原件)。

    判级**委托 apply_postfx_map** (改变条数 == len(parts) 即"该级全部条目都能解析到
    真实文件"), 不另写存在性判定; kind 级**全有全无** — 部分可解析即该级不可用
    (避免混帧率/尺寸), 复用其既有告警串后降级。

    W9R-W5 告警 (无整级可用时逐条给可读原因, 供黄条/日志):
      ① 该 sid 两级皆无映射 → "无后处理产物可用 (sid=..), 回落原件 ..";
      ② 该 sid 有映射、但缺某级映射且该级在批内有映射 (部分段缺失) →
         "无 <kind> 产物可用 (sid=..), 回落原件 ..";
      文件丢失由 apply_postfx_map 既有告警覆盖 (不重复)。
    返回 (level, new_parts, warnings); level ∈ {"interp", "upscale", None}。
    """
    if not parts:
        return None, [], []
    warns_all = []
    for kind in ("interp", "upscale"):
        new_parts, warns = apply_postfx_map(parts, postfx_map, kind, run_dir)
        if sum(1 for np, e in zip(new_parts, parts) if np != _entry_path(e)) == len(parts):
            return kind, new_parts, warns_all
        warns_all.extend(warns)
    mapped_kinds = [k for k in ("interp", "upscale") if _kind_map(postfx_map, k)]
    for entry in parts:
        sid = _entry_sid(entry)
        have = [k for k in ("interp", "upscale") if _kind_map(postfx_map, k).get(sid)]
        if not have:
            warns_all.append("无后处理产物可用 (sid=%s), 回落原件 %s"
                             % (sid, _entry_path(entry)))
            continue
        for k in mapped_kinds:
            if k not in have:
                warns_all.append("无 %s 产物可用 (sid=%s), 回落原件 %s"
                                 % (k, sid, _entry_path(entry)))
    return None, [_entry_path(e) for e in parts], warns_all


# ============================================================================
# 2. plan_from_flags
# ============================================================================

_ENGINE_CHOICES = ("seedvr2", "rtxvsr")


def plan_from_flags(upscale, interp, engine_choice, timeout_s=14400, seg_threshold=None,
                    upscale_params=None, interp_params=None):
    """构造编排计划. kinds 顺序定死 ["upscale", "interp"] (D3 同 kind 连续提交).
    R-50: upscale_params / interp_params 为用户给的输出参数 (归一后), 缺省 None = 现状零变化."""
    if engine_choice not in _ENGINE_CHOICES:
        raise ValueError("engine_choice 必须 ∈ %s, got %r" % (_ENGINE_CHOICES, engine_choice))
    kinds = [k for k, on in (("upscale", upscale), ("interp", interp)) if on]
    return {
        "kinds": kinds,
        "engine_choice": engine_choice,
        "timeout_s": timeout_s,
        "seg_threshold": seg_threshold,
        "upscale_params": upscale_params,
        "interp_params": interp_params,
    }


def parse_seg_threshold(raw):
    """W9R W9-2: seg_threshold 口径单一落点 (端点 body / 批路径同一套).

    合法 = dict, 键 ∈ {"duration_s", "frame_count"}, 值数字 (int/float, bool 不算);
    缺键以默认阈值 (_DEFAULT_SEG_THRESHOLD) 补齐 (should_segment 需两键齐);
    未知键忽略 (不进透传账)。
    非法 (非 dict / 值非数字) → ValueError (端点层转 400 "seg_threshold 非法")。
    """
    if not isinstance(raw, dict):
        raise ValueError("seg_threshold 须为 dict, got %r" % type(raw).__name__)
    out = dict(_DEFAULT_SEG_THRESHOLD)
    for k, v in raw.items():
        if k not in out:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError("seg_threshold 值非数字: %r=%r" % (k, v))
        out[k] = v
    return out


# ---------------------------------------------------------------------------
# R-50 (批 M6b T2): 输出参数链 — 校验分档 / params 构造 / 插帧换算
# ---------------------------------------------------------------------------

class PostfxParamsError(ValueError):
    """参数构造失败: 需源尺寸/源帧率而媒体探测取不到, 或插帧后帧率越节点上界
    (编排层: 该 sid 记 failed + 日志一行; 端点层: 整单 400 白话)。"""


# scale 分档: rtxvsr = RTX 节点硬约束 [1.0,4.0] 且 0.1 步; seedvr2 = 本端点约定 (0,8]
# (短边换算无节点硬界)。非法 engine_choice 按 seedvr2 档兜底 (同 template_names 口径)。
_RTX_SCALE_BOUNDS = (1.0, 4.0)
_SEEDVR2_SCALE_MAX = 8.0
_DIM_MIN, _DIM_MAX = 64, 8192
_FPS_MIN, _FPS_MAX = 12, 120


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def parse_upscale_params(raw, engine_choice):
    """R-50: upscale_params 校验单一落点 (端点 body / 计划同一套)。缺省 None → None。

    合法形态: {mode:"scale", scale:N} (rtxvsr 档 [1.0,4.0] 且 0.1 步; seedvr2 档 (0,8])
             | {mode:"target", width:W, height:H} (两档同界: 成对整数 ∈[64,8192])
    非法 → ValueError (端点层转 400 白话)。返回归一形态 (scale 归一为 float)。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("upscale_params 须为对象 (如 {\"mode\":\"scale\",\"scale\":2}), got %r"
                         % type(raw).__name__)
    mode = raw.get("mode")
    if mode == "scale":
        s = raw.get("scale")
        if not _is_num(s):
            raise ValueError("upscale_params.scale 须为数字, got %r" % (s,))
        s = float(s)
        if engine_choice == "rtxvsr":
            lo, hi = _RTX_SCALE_BOUNDS
            if not (lo <= s <= hi):
                raise ValueError("upscale_params.scale=%g 越界: 引擎 %s 支持 %g~%g"
                                 % (s, engine_choice, lo, hi))
            if abs(s * 10 - round(s * 10)) > 1e-6:
                raise ValueError("upscale_params.scale=%g 不是 0.1 步 (如 2 / 2.5), 引擎 %s 不吃"
                                 % (s, engine_choice))
        elif not (0 < s <= _SEEDVR2_SCALE_MAX):
            raise ValueError("upscale_params.scale=%g 越界: 引擎 %s 支持 大于0 且 不超过%g"
                             % (s, engine_choice, _SEEDVR2_SCALE_MAX))
        return {"mode": "scale", "scale": s}
    if mode == "target":
        w, h = raw.get("width"), raw.get("height")
        for k, v in (("width", w), ("height", h)):
            if not _is_int(v):
                raise ValueError("upscale_params.%s 须为整数 (width/height 成对给出), got %r"
                                 % (k, v))
            if not (_DIM_MIN <= v <= _DIM_MAX):
                raise ValueError("upscale_params.%s=%r 越界 (支持 %d~%d)"
                                 % (k, v, _DIM_MIN, _DIM_MAX))
        return {"mode": "target", "width": w, "height": h}
    raise ValueError("upscale_params.mode 只能是 \"scale\" 或 \"target\", got %r" % (mode,))


def parse_interp_params(raw):
    """R-50: interp_params 校验单一落点。缺省 None → None。
    合法: {target_fps: F}, F 数字 ∈[12,120] (CreateVideo 节点硬上界 120); 否则 ValueError。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("interp_params 须为对象 (如 {\"target_fps\":60}), got %r"
                         % type(raw).__name__)
    f = raw.get("target_fps")
    if not _is_num(f):
        raise ValueError("interp_params.target_fps 须为数字, got %r" % (f,))
    f = float(f)
    if not (_FPS_MIN <= f <= _FPS_MAX):
        raise ValueError("interp_params.target_fps=%g 越界 (支持 %d~%d)" % (f, _FPS_MIN, _FPS_MAX))
    return {"target_fps": f}


def source_fps(meta):
    """源帧率: meta['fps'] 优先, 否则 frame_count/duration_s 估算; 取不到 → 0.0"""
    meta = meta or {}
    f = meta.get("fps")
    if _is_num(f) and float(f) > 0:
        return float(f)
    dur, cnt = meta.get("duration_s") or 0, meta.get("frame_count") or 0
    if dur > 0 and cnt > 0:
        return float(cnt) / float(dur)
    return 0.0


def interp_plan(target_fps, src_fps):
    """R-50 插帧换算: M = max(1, round(target_fps / 源fps)); 实际帧率 = M×源fps。
    M 与实际帧率配套下发 (时长保真, 不按所填帧率硬写); 越 CreateVideo 节点上界 120 → 抛错。"""
    if not src_fps or src_fps <= 0:
        raise PostfxParamsError("取不到源视频帧率 (媒体探测失败), 插帧换算需源帧率")
    m = max(1, int(round(float(target_fps) / float(src_fps))))
    fps = round(m * float(src_fps), 1)
    if fps > _FPS_MAX:
        raise PostfxParamsError(
            "插帧后帧率 %gfps 越上界 %dfps (目标 %g / 源 %g → 倍率 %d), 请调低目标帧率"
            % (fps, _FPS_MAX, float(target_fps), float(src_fps), m))
    return m, fps


def build_postfx_params(kind, engine_choice, params, meta):
    """R-50: 按引擎档 + 用户参数 + 源媒体 meta 构造 assemble_postfx_prompt 的 params 覆盖层。
    params 缺省 (None) → {} (缺省零变化, 模板原值直发)。
    需源尺寸/源帧率而 meta 取不到 → PostfxParamsError (编排层该 sid 记 failed + 日志一行)。"""
    if not params:
        return {}
    meta = meta or {}
    if kind == "interp":
        m, fps = interp_plan(params["target_fps"], source_fps(meta))
        return {"RIFE VFI": {"multiplier": m}, "CreateVideo": {"fps": fps}}
    mode = params.get("mode")
    if mode == "scale":
        if engine_choice == "rtxvsr":
            return {"RTXVideoSuperResolution": {"resize_type": "scale by multiplier",
                                                "resize_type.scale": params["scale"]}}
        w, h = meta.get("width"), meta.get("height")
        if not (_is_int(w) and _is_int(h) and w > 0 and h > 0):
            raise PostfxParamsError(
                "取不到源视频宽高 (媒体探测失败), seedvr2 按「源短边×倍数」换算需源尺寸")
        return {"SeedVR2VideoUpscaler":
                {"resolution": int(min(w, h) * float(params["scale"]))}}
    if mode == "target":
        if engine_choice == "rtxvsr":
            return {"RTXVideoSuperResolution": {
                "resize_type": "target dimensions",
                "resize_type.width": params["width"],
                "resize_type.height": params["height"]}}
        return {"SeedVR2VideoUpscaler":
                {"resolution": min(params["width"], params["height"])}}
    raise PostfxParamsError("postfx %s 参数形态非法: %r" % (kind, params))


# ============================================================================
# 3. 编排: run_postfx_batch
# ============================================================================

def _has_method(obj, name):
    return hasattr(obj, name) and callable(getattr(obj, name))


def _stem_of(name):
    return os.path.splitext(name)[0]


def _ffmpeg_exe_fallback():
    """PATH 里的 ffmpeg 优先; 否则让 subprocess 报 FileNotFoundError (可读诊断).
    照 batch_core._ffmpeg_exe 同款语义但本模块不依赖 batch_core (低耦合, 鸭子类型约定).
    """
    p = shutil.which("ffmpeg")
    return p or "ffmpeg"


def _segment_video(engine, video_path, seg_len_s, work_dir):
    """长视频分段切分 — ffmpeg 流复制 (-c copy) 按 seg_len_s 切段, 输出 work_dir/seg_%03d.mp4.
    段接缝处少 1 帧语义由 ffmpeg 原生切分特性自然产生 (草案 §3.3 注释).

    engine 必须提供 _run_media_cmd(cmd, what, timeout=...) 方法 — 缺则 TypeError 快速失败
    (鸭子类型约定, 照 U1 契约).

    返回 [seg_path, ...] 已排序 (seg_001/seg_002/...). 调用方负责把段产物路径喂给 _post.
    """
    if not _has_method(engine, "_run_media_cmd"):
        raise TypeError(
            "engine 需提供 _run_media_cmd (postfx_engine 鸭子类型契约, 见 U1); "
            "缺该方法时无法切分长视频")
    out_template = os.path.join(work_dir, "seg_%03d.mp4")
    # 26-T2c: segment muxer 默认 0 起编号 (生产 ffmpeg 实证, 单段切出 seg_000.mp4),
    # _validate_seg_paths 契约是 1..N — 显式 1 起对齐, 否则任何分段后处理必炸
    # 「段号不连续 实=[0] 期望=[1]」(真机 2026-10-16 测试2 补跑 s02 实证)。
    # 真机缺陷 #11: cmd 元素必须全 str/PathLike — subprocess 逐个 os.fsdecode,
    # int 会让真机抛 TypeError (2026-09-17 run 20260917_900001); 整值/小数值都留
    # 原样的字符串形式 ("15" / "12.5"), ffmpeg -segment_time 两者皆吃.
    cmd = [_ffmpeg_exe_fallback(), "-y", "-i", video_path,
           "-c", "copy", "-f", "segment",
           "-segment_time", str(seg_len_s),
           "-segment_start_number", "1",
           "-reset_timestamps", "1",
           out_template]
    engine._run_media_cmd(cmd, "长视频切分(ffmpeg流复制)")
    # 切完后扫描 work_dir 找 seg_*.mp4 — 按自然序 (seg_001 < seg_002 < ...).
    pattern = os.path.join(work_dir, "seg_*.mp4")
    segs = sorted(glob.glob(pattern))
    return segs


def _concat_segments(engine, seg_paths, out_path):
    """段回拼 — ffmpeg concat demuxer 流复制 (-f concat -c copy), 照 join_engine 流复制先例.
    写 listfile (每行 'file <abs_path>'), 再调 engine._run_media_cmd 跑 ffmpeg.
    """
    if not _has_method(engine, "_run_media_cmd"):
        raise TypeError("engine 需提供 _run_media_cmd (postfx_engine 鸭子类型契约)")
    if not seg_paths:
        raise ValueError("_concat_segments: seg_paths 为空")
    listfile = os.path.splitext(out_path)[0] + ".concat.txt"
    with open(listfile, "w", encoding="utf-8") as f:
        for sp in seg_paths:
            # 转义单引号 (concat demuxer 用 single quote 包路径)
            escaped = sp.replace("'", "'\\''")
            f.write("file '%s'\n" % escaped)
    cmd = [_ffmpeg_exe_fallback(), "-y", "-f", "concat", "-safe", "0",
           "-i", listfile, "-c", "copy", out_path]
    engine._run_media_cmd(cmd, "段回拼(ffmpeg concat流复制)")


_SEG_FILE_RE = re.compile(r"^seg_(\d+)\.mp4$")


def _validate_seg_paths(seg_paths, sid):
    """B4 T3-必改3: 回拼前段数校验。
    seg_paths 中 basename 须形如 seg_NNN.mp4 且段号 1..N 连续无缺口;
    缺口/多出/格式错 → RuntimeError("段数/段文件校验未通过 ...") 显式失败,
    不静默拼出旧尾巴/缺口/半成品。
    注: 文件存在性/非空不在本函数校验范围内 — 那是 _segment_video 的契约。
    本函数专注"段数/段号形态"校验, 与 _segment_video 的实现解耦。"""
    if not seg_paths:
        raise RuntimeError("段数/段文件校验未通过 (sid=%s): seg_paths 为空" % sid)
    indices = []
    for p in seg_paths:
        m = _SEG_FILE_RE.match(os.path.basename(p))
        if not m:
            raise RuntimeError(
                "段数/段文件校验未通过 (sid=%s): basename 非 seg_NNN.mp4 形态 %r"
                % (sid, os.path.basename(p)))
        indices.append(int(m.group(1)))
    expected = list(range(1, len(seg_paths) + 1))
    if sorted(indices) != expected:
        raise RuntimeError(
            "段数/段文件校验未通过 (sid=%s): 段号不连续 实=%r 期望=%r"
            % (sid, sorted(indices), expected))


def _wait_status_files(wait):
    """_wait_shot 契约归一: 真机 = (status, files) 元组 (batch_core.py 实证, files 为裸
    文件名); dict 形态保留兼容测试桩。返回 (status, files)。"""
    if isinstance(wait, dict):
        files = wait.get("files") or []
        return wait.get("status"), (files if isinstance(files, list) else [])
    if isinstance(wait, (tuple, list)) and wait:
        files = wait[1] if len(wait) > 1 else []
        return wait[0], (files if isinstance(files, list) else [])
    return None, []


def run_postfx_batch(engine, items, plan, templates,
                     run_dir, upscaled_dir="upscaled", interp_dir="interp",
                     on_progress=None, seg_len_s=15):
    """编排: 按 plan.kinds 顺序, 每 kind 全批跑完再下一个 (D3).
    单片失败隔离 (Y2 编排侧): 记 failed[sid]=kind, 继续下片 (提交失败不重跑,
    首次失败如实落账 — 显存不足直接失败).
    X5: item.name 已含当前 kind 后缀戳 → 跳过.
    Y4/U5: 长片 (duration_s/frame_count >= plan.seg_threshold) → 切分→逐段过模板→回拼;
    整片产物记戳 (out_rel 仍是原文件名的 kind 戳, 不带 seg_xxx). 段接缝少 1 中间帧由
    ffmpeg 切分原生特性自然产生 (草案 §3.3 注释: 1/48s 级, 看片无感).
    on_progress(done, total, sid, ok): 每片完成回调 — 单片/分段整片视为 1 票.
    done 累加 (从 1 开始); total = len(items); ok 反映该片最终成败.

    返回 _postfx 结构: {"upscale":{sid:rel}, "interp":{...}, "failed":{sid:stage}, "skipped":[...]};
    所请求 kind 的模板缺时另加 "template_missing": {kind: 期望文件名} (该 kind 不产出、不入 failed)."""
    if not _has_method(engine, "_post") or not _has_method(engine, "_wait_shot"):
        raise ValueError("engine 需具备 _post(path,payload) 与 _wait_shot(pid,timeout) 方法")
    fresh_id = getattr(engine, "_fresh_id", None)
    if not callable(fresh_id):
        # 鸭子类型退化: 不重编号 nid, template 自带 nid 直接用
        fresh_id = lambda: None  # noqa: E731

    postfx = {"upscale": {}, "interp": {}, "failed": {}, "skipped": []}
    kinds = plan.get("kinds") or []
    if not kinds or not items:
        return postfx

    total = len(items)
    done_counter = [0]  # 闭包递增 (避免全局)

    def _emit_progress(sid, ok):
        done_counter[0] += 1
        if callable(on_progress):
            try:
                on_progress(done_counter[0], total, sid, ok)
            except Exception:
                # 回调异常不影响主链 (fail loud 但不拖死批量)
                print("[H3 postfx] on_progress 回调异常: %s" % traceback.format_exc(),
                      flush=True)

    for kind in kinds:
        template = templates.get(kind)
        if not template:
            # E3: 所请求 kind 的模板缺 → 批级 template_missing + 日志一行; 该 kind 不产出,
            # 不写 failed (failed 只记真实执行失败), 另一档照常跑 (严禁静默换引擎).
            fname = template_names(kind, plan.get("engine_choice") or "seedvr2")
            postfx.setdefault("template_missing", {})[kind] = fname
            print("[H3 postfx] 模板缺失 (期望 %s), 跳过 %s" % (fname, kind), flush=True)
            continue
        # R-50: 本 kind 的输出参数 (缺省 None = 现状零变化) + 其派生戳 (skip 谓词用)
        kind_params = plan.get("upscale_params" if kind == "upscale" else "interp_params")
        stamp = kind_stamp(kind, kind_params)
        sub_dir = upscaled_dir if kind == "upscale" else interp_dir
        for it in items:
            sid = it["sid"]
            name = it.get("name") or os.path.basename(it.get("path") or "")
            # X5: 带戳跳过 (R-50: 按当前参数派生戳的整词命中, 非子串 —— _x2.5 不误命中 _x2)
            if has_stamp_token(_stem_of(name), stamp):
                postfx["skipped"].append(sid)
                continue
            # E4.2 链式: interp 源优先取该 sid 的放大产物 (存在即用), 否则回落原件;
            # 源名用"意图名" (去计数器) → 产物 <stem>_x2_48fps(计数器).mp4 (R5 期望串).
            src_path = it["path"]
            src_name = name
            if kind == "interp":
                up_rel = (postfx.get("upscale") or {}).get(sid)
                if up_rel:
                    cand = os.path.normpath(os.path.join(run_dir, up_rel))
                    if os.path.exists(cand):
                        src_path = cand
                        src_name = postfx_output_name(name, "upscale",
                                                       plan.get("upscale_params"))
            out_rel = os.path.join(sub_dir, postfx_output_name(src_name, kind,
                                                               kind_params))
            # E4.1 落点: 提交用相对 server 输出根的前缀 (记账仍锚 run_dir 的 out_rel);
            # run_dir 不在输出根内 → 跳过该片 + 日志明示, 零提交 (不靠远端异常).
            prefix = save_prefix(engine, run_dir, out_rel)
            if prefix is None:
                print("[H3 postfx] run_dir 不在输出根内, 跳过 (sid=%s kind=%s): run_dir=%s"
                      % (sid, kind, run_dir), flush=True)
                postfx["skipped"].append(sid)
                continue
            # 真机前置修复(4): LoadVideo/VHS_LoadVideo 的 file 校验均限 ComfyUI input 目录 —
            # 段产物在 output 下会被 custom_validation_failed 拒绝 (U6 实证)。
            # 落地 staging: 复制到 engine 的 server input 目录, 以 basename 引用
            # (1.13h rerun_inpaint 同款先例: source_video_rel "已落 server input").
            # 文件名带 kind: interp 的链式源与 upscale 的源同名不同物 (同名缓存会留旧件)。
            video_ref = src_path
            # C1: 兜底链 _server_input_dir → server_input_dir → input_dir.
            # batch_core.py 只设公开 server_input_dir (生产) — 私有 _server_input_dir 全仓仅测试设置,
            # 旧链 _server_input_dir → input_dir 在生产下恒回退到 input_dir (本地素材目录),
            # staging 拷到素材目录 → LoadVideo 校验仍限 server input → 400 (T3-必改1).
            in_dir = (getattr(engine, "_server_input_dir", None)
                      or getattr(engine, "server_input_dir", None)
                      or getattr(engine, "input_dir", None))
            if in_dir and os.path.isfile(src_path):
                try:
                    stage_name = "_postfx_%s_%s_%s" % (sid or "seg", kind, name)
                    stage_path = os.path.join(in_dir, stage_name)
                    if not os.path.isfile(stage_path) or \
                            os.path.getsize(stage_path) != os.path.getsize(src_path):
                        shutil.copy2(src_path, stage_path)
                    video_ref = stage_name
                except Exception:
                    # staging 失败回落原路径 (绝对路径仅 VHS 变体可能接受)
                    print("[H3 postfx] input staging 失败, 回退原路径: %s" % traceback.format_exc()[-200:],
                          flush=True)
                    video_ref = src_path
            ok_flag = False
            try:
                # R-50: 按引擎档 + 当前参数 + 源媒体 meta 构造 params 覆盖层
                # (缺省 None → {} 零变化; 探测取不到源尺寸/帧率 → PostfxParamsError 落 failed)
                params_over = build_postfx_params(
                    kind, plan.get("engine_choice") or "seedvr2", kind_params,
                    it.get("meta") or {})
                # Y4/U5 长片命中 → 切分→逐段→回拼 (整片 out_rel)
                meta = it.get("meta") or {}
                if should_segment(meta, plan.get("seg_threshold")):
                    if not _process_segmented(engine, dict(it, path=src_path), kind, template,
                                              plan, run_dir, sub_dir, out_rel, seg_len_s,
                                              params=params_over):
                        raise RuntimeError("长片分段处理未成功 (sid=%s kind=%s)" % (sid, kind))
                    # E4.4: 回拼件是 ffmpeg 产物 (无计数器) → 记账 out_rel (修 C5 回归)
                    postfx[kind][sid] = out_rel
                    ok_flag = True
                else:
                    # 短片直通 — 复用原 _post/_wait_shot 单片语义
                    # 真机前置修复(3): _post 不做包装直发 body — ComfyUI /prompt
                    # 需要 {"prompt": api_dict} 形态, 裸 dict 被 400 拒绝 (U6 实证)
                    payload = assemble_postfx_prompt(template, video_ref, prefix, params_over)
                    resp = engine._post("/prompt", {"prompt": payload,
                                                    "client_id": getattr(engine, "client_id", None) or "h3-postfx"})
                    pid = (resp or {}).get("prompt_id") or ""
                    wait = engine._wait_shot(pid, timeout=plan.get("timeout_s", 14400))
                    # 真机前置修复(5): _wait_shot 真实契约=("(success|timeout|interrupted|error)", files)
                    # 元组 (batch_core.py 实证) — U1 假设 dict 契约致 .get 抛 AttributeError
                    # (U6 实证: 提交成功但等待即失败)。dict 形态保留兼容测试桩。
                    status, files = _wait_status_files(wait)
                    if status and status != "success":
                        raise RuntimeError("postfx %s 失败 (sid=%s status=%s)"
                                           % (kind, sid, status))
                    if status is None:
                        raise RuntimeError("postfx %s 等待无结果 (sid=%s)" % (kind, sid))
                    # E4.4: 记账吃实际产物名 (files), 不再用 _00001_ 猜名
                    postfx[kind][sid] = resolve_actual_rel(
                        sub_dir, _stem_of(os.path.basename(out_rel)), files, out_rel)
                    ok_flag = True
            except Exception as ex:
                # U6 真机排障增补: 吞异常不留痕 → 失败原因黑箱 (2026-09-16 实证 6 次静默失败)
                # R-50: 参数构造失败 (探测缺源尺寸/帧率 · 插帧越上界) → 一行白话日志, 免栈噪声
                if isinstance(ex, PostfxParamsError):
                    print("[H3 postfx] %s 参数构造失败 (sid=%s): %s" % (kind, sid, ex),
                          flush=True)
                else:
                    print("[H3 postfx] %s 单片失败 (sid=%s): %s"
                          % (kind, sid, traceback.format_exc()[-400:]), flush=True)
                postfx["failed"][sid] = kind
                ok_flag = False
            _emit_progress(sid, ok_flag)
    return postfx


def _process_segmented(engine, it, kind, template, plan,
                       run_dir, sub_dir, out_rel, seg_len_s, params=None):
    """长片分段处理: 切分 → 逐段过模板 → 回拼.
    段提交前 staging 到 server input 目录, LoadVideo 引用 basename (缺陷 #12: LoadVideo
    校验限 input 目录, 段绝对路径被 400 拒); 段产物落点 = save_prefix(run_dir, sub_dir/seg_NNN_<out_name>) (输出根内);
    回拼输入 = 每段 _wait_shot files 解析出的**实际段产物** (含计数器) — 调用方已验
    run_dir 在输出根内, 故此处 save_prefix 必不为 None。
    回拼件 (ffmpeg 产物, 无计数器) 落 run_dir/<out_rel>, 记账由调用方写 out_rel。
    任一段失败 → 整片失败 (返回 False).

    R-50: params = 编排层按引擎档构造的输出参数覆盖层 (缺省 None = 零变化, 与旧 `{}` 同).
    返回: True=全部段+回拼成功, False=失败 (调用方走 failed 路径).
    """
    sid = it["sid"]
    src = it["path"]
    timeout_s = plan.get("timeout_s", 14400)
    # 段工作目录: 跑批下唯一子目录 (按 sid 命名避免并发批撞)
    seg_work = os.path.join(run_dir, "_postfx_segs_%s_%s" % (sid, kind))
    # B4 T3-必改3: 切分前清旧段 — 二次处理更短源片时, 上一轮 seg_(M+1)... 残留会被
    # _segment_video 的 glob(seg_*.mp4) 扫到并喂回回拼, 静默产出多余尾巴。
    # shutil.rmtree + makedirs (而非单删 seg_*.mp4, 防御外部注入的非段件残留)。
    shutil.rmtree(seg_work, ignore_errors=True)
    os.makedirs(seg_work, exist_ok=True)
    # 1) 切分 (用 globals() 解析, 支持测试 monkey-patch)
    seg_paths = globals()["_segment_video"](engine, src, seg_len_s, seg_work)
    if not seg_paths:
        return False
    # B4 T3-必改3: 回拼前段数校验 — 段号须 1..N 连续无缺口, 命名形态 seg_NNN.mp4。
    # 缺口/多出/格式错 → 显式 RuntimeError, 不静默拼出旧尾巴或半成品。
    # 注: 文件存在性/非空不在本层校验 — 那是 _segment_video 的契约。
    _validate_seg_paths(seg_paths, sid)
    # 2) 逐段过模板 (段产物名 = sub_dir/seg_NNN_<out_name>)
    # out_name = basename(out_rel); 段产物按 seg_NNN 前缀命名避免覆盖
    out_name = os.path.basename(out_rel)
    seg_out_abs_paths = []
    for i, seg_path in enumerate(seg_paths, start=1):
        seg_out_rel = os.path.join(sub_dir, "seg_%03d_%s" % (i, out_name))
        # 真机缺陷 #12: LoadVideo 的 file 校验限 server input 目录 — 段文件在 run_dir 下,
        # 直接喂绝对路径被 custom_validation_failed 拒 (2026-09-17 run 20260917_900001)。
        # 同单片分支前置修复(4) idiom: 暂存到 input 目录, 以 basename 引用 (段号入名, 段间不互相覆盖,
        # 也不撞单片命名); 大小不同才重拷; 失败/无 input 目录 → 回落原路径 + 一行日志, 不阻断。
        video_ref = seg_path
        # C1: 兜底链 _server_input_dir → server_input_dir → input_dir (同上单片分支)
        in_dir = (getattr(engine, "_server_input_dir", None)
                  or getattr(engine, "server_input_dir", None)
                  or getattr(engine, "input_dir", None))
        if in_dir and os.path.isfile(seg_path):
            try:
                stage_name = "_postfx_%s_%s_seg_%03d_%s" % (
                    sid, kind, i, os.path.basename(seg_path))
                stage_path = os.path.join(in_dir, stage_name)
                if not os.path.isfile(stage_path) or \
                        os.path.getsize(stage_path) != os.path.getsize(seg_path):
                    shutil.copy2(seg_path, stage_path)
                video_ref = stage_name
            except Exception:
                print("[H3 postfx] 分段 input staging 失败, 回退原路径: %s"
                      % traceback.format_exc()[-200:], flush=True)
                video_ref = seg_path
        elif not in_dir:
            print("[H3 postfx] 分段 staging 无 server input 目录, 回退原路径: %s" % seg_path,
                  flush=True)
        # LoadVideo 喂暂存 basename (回落态才喂原路径); SaveVideo 写 seg_out_rel 相对输出根的前缀 (E4.1)
        # 同短片直通: /prompt 需要 {"prompt": api_dict} 包装 (U6 实证修复)
        payload = assemble_postfx_prompt(
            template, video_ref, save_prefix(engine, run_dir, seg_out_rel), params or {})
        resp = engine._post("/prompt", {"prompt": payload,
                                        "client_id": getattr(engine, "client_id", None) or "h3-postfx"})
        pid = (resp or {}).get("prompt_id") or ""
        wait = engine._wait_shot(pid, timeout=timeout_s)
        # 真机前置修复(5) 同款: _wait_shot 返回元组 (见短片直通处注释)
        status, files = _wait_status_files(wait)
        if status and status != "success":
            raise RuntimeError("分段失败 sid=%s seg=%d status=%s" % (sid, i, status))
        # E4.4: 段产物实际名 (含计数器) 由 files 解析 — 回拼输入必须真实存在 (修 C6 假绿)
        seg_out_abs_paths.append(os.path.join(run_dir, resolve_actual_rel(
            sub_dir, _stem_of(os.path.basename(seg_out_rel)), files, seg_out_rel)))
    # 3) 回拼段产物 (真实存在的段产物路径)
    out_abs = os.path.join(run_dir, out_rel)
    # 用 globals() 解析以支持测试 monkey-patch (与测试桩对齐)
    globals()["_concat_segments"](engine, seg_out_abs_paths, out_abs)
    return True
