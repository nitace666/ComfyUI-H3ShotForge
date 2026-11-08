"""color_align.py — V1.9 批 3 T3.5: S2 色彩漂移治理 (固定参考 color_level + flatten 增益归一).

痛点: 长链逐段生成时色彩品质漂移 — 段间纹理/增益 ~1.3x 跳变累积 + 亮度偏移,
裸拼接后肉眼可见色阶断档。本模块在 S3 join 前做逐段色彩对齐预处理。

开发期决策登记 (2026-08-29):
- 固定参考 (P0): scene 模式 = 所有段只对齐**首段稳定尾段**统计 (绝不邻段互对齐,
  防累积漂移 — 段 N 的调整只由段 1 统计决定); mvgd = 以最近前 N=MVGD_WINDOW 段
  滑动均值统计为参考 (有累积风险, 供 A/B 对照); off = 不做亮度均值对齐
  (flatten 仍独立生效)。默认 scene (PRD §十 S2 行)。
- flatten: 逐段增益归一 (std 比 → eq contrast), 参考恒为首段 std (固定, 防累积
  漂移是 flatten 的核心目标, mvgd 不影响 flatten 参考)。默认开;
  >= FLATTEN_HINT_MIN_SEGMENTS 段 → flatten_hint=True (黄条建议保持, 不强制;
  引擎侧日志+manifest 留痕, 前端 UI 黄条批 4 已知待办)。
- 统计量: 每段解码帧的 Y 通道统计 (均值/标准差/中位百分位) — ffmpeg 尾窗抽帧
  (-sseof, "稳定尾段"语义: 避开段首生成 warmup 抖动) + yuv444p raw pipe 取 Y
  平面 (Y 平面逐字节保留, 探测域=滤镜域) + numpy 计算。
- 滤镜映射 (8bit Y 域几何语义): eq=contrast 增益 (Y' = c*(Y-128)+128,
  实测 std 比恢复精确) + lut=y 亮度偏移 (Y' = clip(Y+delta), 逐级精确 —
  eq=brightness 的定点缩放随 ffmpeg 版本漂移, 实测 0.1→+29 级非 255 直觉,
  弃用; delta 单位=Y 级, 与探测统计域自洽)。组合: mean' = c*(mean-128)+128
  + delta = ref_mean → delta 由均值差在 contrast 定后反解。saturation 本版
  不动 (Y 统计无色度信息, 边界登记)。
- 落地形态: S3 join 前逐段重编码预处理 — 每段 mp4 按统计差 eq 调整后暂存
  (crf 18 / preset medium, 音频 copy 保持源, pix_fmt 保持源由 join 统一),
  再进 join_engine (crossfade 衔接的是对齐后段)。
- 合成基准阈值 (开发期登记): 亮度偏移恢复误差 < BRIGHTNESS_RECOVERY_TOL (1%),
  增益恢复误差 < GAIN_RECOVERY_TOL (2%) — test_t35_color.py 合成注入用例。
- identity 死区: |mean 差| <= IDENTITY_MEAN_DEADBAND (0.75, 8bit Y) 且
  |gain-1| <= IDENTITY_GAIN_DEADBAND (0.01) → 不调整 (微小差异不值得一次
  有损重编码)。
- 保护性 clamp: contrast ∈ [0.25, 4.0], brightness ∈ [-0.5, 0.5]; seg std=0
  防呆 → contrast 恒 1。
- 失败语义: probe/重编码任何失败 raise ColorAlignError → 接入层整体降级回
  原段直接 join (拼接永远能出片; 半对齐状态不可接受)。

批 4 T1 (2026-09-03) 画质 A+D 登记:
- A 黑位/白位/色度映射: 统计扩 YMIN/YMAX + U/V 平面均值 (yuv444p 三平面数据
  现成); 滤镜升级 lutyuv 三通道 — Y 黑白位端点线性映射 (seg→ref 端点推导
  gain+offset, 端点映射为主: 隐含增益/均值/黑白位修正, 不再叠加 eq std 比,
  双重增益=过修正) + CB/CR mean 差平移; 映射量 clamp ±LUT_CLAMP 级 (端点位移/
  色度平移各自独立钳, 超限由接入层如实打日志)。统计不含端点/色度键 (旧口径/
  合成) 或动态范围退化 (span < LUT_MIN_SPAN) → 回退 eq contrast+lut=y 既有
  路径 (回归保护)。
- 全段统计 (老板规则 2, 去 V1.9 尾窗): 全帧 yuv444p raw → numpy 均值口径;
  估算帧数超上限时 -vf fps=N 均匀抽帧 (N=上限/时长, 均匀覆盖全段) + -frames:v
  封顶; 帧预算按字节收紧 — 大分辨率段 (3328×1920) 自动降到 ~10 帧。基准仍
  钉死首段 (规则 1, scene=首段固定参考, 不变)。
- D 滤镜入链: probe_and_plan (只算参数不重编码) 为主路径 — 逐段滤镜注入
  compose_join 的 filter_complex, 段只编码一次 (省一代 x264); recode_segments
  (暂存重编码, V1.9 align_segments 的重编码逻辑) 重组为对齐激活时 compose_join
  失败的降级回退; align_segments (probe+计划+重编码) 保留完整形态供该回退与
  兼容路径。

纯函数 (y_stats/compute_eq_params/compute_lut_params/plan_alignments/
build_eq_filter/build_lutyuv_filter/apply_eq) 与执行侧 (probe_y_stats/
probe_and_plan/recode_segments/align_segments) 分离: 前者毫秒级可测 (合成基准),
后者真机 ffmpeg。
"""
import os
import subprocess

import numpy as np

import join_engine

# ---- 默认值矩阵 (PRD §十 S2 行) ----
COLOR_LEVEL_MODES = ("off", "mvgd", "scene")
DEFAULT_COLOR_LEVEL = "scene"
DEFAULT_FLATTEN = True

# ---- 模式参数 ----
MVGD_WINDOW = 3                     # mvgd 滑动参考窗口 N 段
FLATTEN_HINT_MIN_SEGMENTS = 5       # >=5 段: flatten 默认开 + 黄条建议保持

# ---- 合成基准恢复精度阈值 (开发期登记) ----
BRIGHTNESS_RECOVERY_TOL = 0.01      # 亮度偏移恢复误差 < 1%
GAIN_RECOVERY_TOL = 0.02            # 增益恢复误差 < 2%

# ---- 死区与保护性 clamp ----
IDENTITY_MEAN_DEADBAND = 0.75       # 8bit Y 域均值死区 (±1 亮度级以内)
IDENTITY_GAIN_DEADBAND = 0.01       # 增益死区 |contrast-1|
CONTRAST_RANGE = (0.25, 4.0)
BRIGHTNESS_RANGE = (-64.0, 64.0)    # 亮度偏移 delta 级 (保护性, ~±25% 幅度)

# ---- 批 4 T1 lutyuv 映射 (A) ----
LUT_CLAMP = 20.0                    # 映射量上限 (端点位移/色度平移, Y 级)
LUT_MIN_SPAN = 16.0                 # 端点映射最小动态范围 (span 低于此回退 eq 路径)

# ---- 批 4 T1 全段统计抽样 (规则 2) ----
SAMPLE_MAX_FRAMES = 120             # 全段统计帧数上限
SAMPLE_MIN_FRAMES = 2               # 抽样下限 (保均匀覆盖)
SAMPLE_BYTES_BUDGET = 192 * 1024 * 1024   # raw 解码内存预算 (yuv444p 三平面)

# ---- 暂存重编码 (与 join_engine 编码策略一致) ----
RECODE_CRF = "18"
RECODE_PRESET = "medium"


class ColorAlignError(Exception):
    """color_align 可预期失败 (探测/重编码), 接入方据此整体降级回原段."""


def _stderr_tail(stderr):
    """stderr 兼容 bytes (capture_output) / str (text=True): 取尾 200 字符."""
    if isinstance(stderr, bytes):
        return (stderr or b"")[-200:].decode("utf-8", "replace")
    return (stderr or "")[-200:]


# ============================================================
# 纯函数 — 统计 / 系数计算 / 计划
# ============================================================

def y_stats(frames):
    """帧序列 (N,H,W) uint8/float → Y 通道统计 {"mean","std","p50","ymin","ymax"}.

    批 4 T1: 增 ymin/ymax (黑位/白位端点, 全段 min/max 口径)."""
    arr = np.asarray(frames, dtype=np.float64)
    if arr.size == 0:
        raise ValueError("空帧序列:无法计算 Y 统计")
    return {"mean": float(arr.mean()), "std": float(arr.std()),
            "p50": float(np.percentile(arr, 50)),
            "ymin": float(arr.min()), "ymax": float(arr.max())}


def compute_eq_params(ref_stats, seg_stats, flatten=True, align_mean=True):
    """统计差 → 滤镜参数 {"brightness": delta(Y 级), "contrast": c}.

    滤镜几何语义: eq=contrast 增益 Y1 = c*(Y-128)+128, lut=y 亮度偏移
    Y' = clip(Y1+delta, 0, 255) → mean' = c*(mean-128)+128+delta。
    ref_stats: 参考统计 (flatten 开启时其 std 为增益归一目标, contrast =
    ref_std/seg_std); seg_stats: 被调段统计; align_mean: 亮度均值对齐
    (color_level=off 时 False → delta=0)。
    死区内 (mean 差与增益都微小) → None (无需调整, 不重编码)。
    off + flatten=False (全关) → 无任何对齐目标, 恒 None。
    """
    if not align_mean and not flatten:
        return None
    if flatten and ref_stats["std"] > 0 and seg_stats["std"] > 0:
        contrast = ref_stats["std"] / seg_stats["std"]
    else:
        contrast = 1.0
    contrast = min(max(contrast, CONTRAST_RANGE[0]), CONTRAST_RANGE[1])
    if align_mean:
        brightness = ref_stats["mean"] - 128.0 - contrast * (seg_stats["mean"] - 128.0)
    else:
        brightness = 0.0
    brightness = min(max(brightness, BRIGHTNESS_RANGE[0]), BRIGHTNESS_RANGE[1])
    if (abs(ref_stats["mean"] - seg_stats["mean"]) <= IDENTITY_MEAN_DEADBAND
            and abs(contrast - 1.0) <= IDENTITY_GAIN_DEADBAND):
        return None
    return {"brightness": brightness, "contrast": contrast}


def compute_lut_params(ref_stats, seg_stats):
    """全段统计 (含 ymin/ymax/u_mean/v_mean) → lutyuv 三通道参数, 死区 None.

    批 4 T1 A: Y 黑白位端点线性映射 — (seg_ymin,seg_ymax)→(ref_ymin,ref_ymax)
    推导 y' = y_gain*val + y_offset (端点映射为主: 隐含增益/均值/黑白位修正,
    不再叠加 eq std 比, 双重增益=过修正); CB/CR 平移 = mean 差。映射量 clamp
    ±LUT_CLAMP 级 (端点目标钉在被调段端点 ±20 内, 防离群统计拉飞映射; 色度
    平移同钳); 增益沿用 CONTRAST_RANGE 保护性钳制 (黑位锚定)。超限项登记
    "clamped" 元组 (接入层如实打日志)。统计缺端点/色度键 → ValueError
    (路由层 plan_alignments 保证不进入)。
    """
    missing = [k for k in ("ymin", "ymax", "u_mean", "v_mean")
               if k not in ref_stats or k not in seg_stats]
    if missing:
        raise ValueError("lutyuv 参数需要全段统计 (缺 %s)" % "/".join(missing))
    d_lo = ref_stats["ymin"] - seg_stats["ymin"]
    d_hi = ref_stats["ymax"] - seg_stats["ymax"]
    u_shift = ref_stats["u_mean"] - seg_stats["u_mean"]
    v_shift = ref_stats["v_mean"] - seg_stats["v_mean"]
    seg_span = seg_stats["ymax"] - seg_stats["ymin"]
    ref_span = ref_stats["ymax"] - ref_stats["ymin"]
    # 死区: 端点/色度映射量与增益全微小 → None (不值得入滤镜)
    if (abs(d_lo) <= IDENTITY_MEAN_DEADBAND
            and abs(d_hi) <= IDENTITY_MEAN_DEADBAND
            and abs(u_shift) <= IDENTITY_MEAN_DEADBAND
            and abs(v_shift) <= IDENTITY_MEAN_DEADBAND
            and abs(ref_span / seg_span - 1.0) <= IDENTITY_GAIN_DEADBAND):
        return None
    clamped = []

    def _clamp_end(ref_v, seg_v, name):
        v = min(max(ref_v, seg_v - LUT_CLAMP), seg_v + LUT_CLAMP)
        if abs(v - ref_v) > 1e-9:
            clamped.append(name)
        return v

    ref_lo = _clamp_end(ref_stats["ymin"], seg_stats["ymin"], "ymin")
    ref_hi = _clamp_end(ref_stats["ymax"], seg_stats["ymax"], "ymax")
    gain = (ref_hi - ref_lo) / seg_span
    if gain < CONTRAST_RANGE[0] or gain > CONTRAST_RANGE[1]:
        gain = min(max(gain, CONTRAST_RANGE[0]), CONTRAST_RANGE[1])
        clamped.append("gain")
    u_cl = min(max(u_shift, -LUT_CLAMP), LUT_CLAMP)
    v_cl = min(max(v_shift, -LUT_CLAMP), LUT_CLAMP)
    if abs(u_cl - u_shift) > 1e-9:
        clamped.append("u")
    if abs(v_cl - v_shift) > 1e-9:
        clamped.append("v")
    return {"y_gain": gain, "y_offset": ref_lo - gain * seg_stats["ymin"],
            "u_shift": u_cl, "v_shift": v_cl, "clamped": tuple(clamped)}


def reference_stats(stats_list, mode, idx):
    """段 idx 的亮度参考统计: scene/off → 首段 (固定参考); mvgd → 前窗口均值.

    批 4 T1: mvgd 均值改为对窗口首项全部统计键泛化平均 (覆盖 ymin/ymax/
    u_mean/v_mean 端点/色度键, lutyuv 路径不 KeyError)。"""
    if mode in ("scene", "off"):
        return stats_list[0]
    if mode == "mvgd":
        window = stats_list[max(0, idx - MVGD_WINDOW):idx]
        n = len(window)
        return {k: sum(s[k] for s in window) / n for k in window[0]}
    raise ValueError(f"非法色彩对齐模式 {mode}:仅支持 {'/'.join(COLOR_LEVEL_MODES)}")


def plan_alignments(stats_list, color_level, flatten):
    """逐段对齐计划: [{index, adjust(参数|None), filter(滤镜串|None), reference}].

    参考段 (index 0) 恒不调; 其余段 adjust 由统计差计算。
    亮度参考按模式 (scene=首段固定 / mvgd=滑动); flatten 增益参考恒首段 std
    (防累积漂移)。off 模式只保留 flatten 增益归一, 不做均值对齐。
    批 4 T1 双路径: 双方统计含端点/色度键 (全段口径) 且 span >= LUT_MIN_SPAN
    且非 off → lutyuv 三通道 (端点映射为主, eq std 比不再叠加); 否则回退
    eq contrast+lut=y 既有路径 (回归保护)。
    """
    if color_level not in COLOR_LEVEL_MODES:
        raise ValueError(
            f"非法色彩对齐模式 {color_level}:仅支持 {'/'.join(COLOR_LEVEL_MODES)}")
    plans = []
    first = stats_list[0]
    lut_keys = ("ymin", "ymax", "u_mean", "v_mean")
    for i, seg in enumerate(stats_list):
        if i == 0:
            plans.append({"index": 0, "adjust": None, "filter": None,
                          "reference": "none(参考段)"})
            continue
        ref = reference_stats(stats_list, color_level, i)
        # flatten 增益参考恒首段 (mvgd 只影响亮度均值参考)
        effective = {"mean": ref["mean"], "std": first["std"], "p50": ref["p50"]}
        if (color_level != "off"
                and all(k in ref and k in seg for k in lut_keys)
                and (seg["ymax"] - seg["ymin"]) >= LUT_MIN_SPAN
                and (ref["ymax"] - ref["ymin"]) >= LUT_MIN_SPAN):
            adjust = compute_lut_params(ref, seg)
        else:
            adjust = compute_eq_params(effective, seg, flatten=flatten,
                                       align_mean=(color_level != "off"))
        filt = None
        if adjust is not None:
            filt = (build_lutyuv_filter(adjust) if "y_gain" in adjust
                    else build_eq_filter(adjust))
        plans.append({"index": i, "adjust": adjust, "filter": filt,
                      "reference": ("first" if color_level == "scene"
                                    else "mvgd[%d..%d]" % (max(0, i - MVGD_WINDOW),
                                                           i - 1))})
    return plans


def build_eq_filter(params):
    """参数 → ffmpeg -vf 滤镜串: eq=contrast(增益) + lut=y(亮度偏移, 逐级精确).

    eq=brightness 弃用: 其定点缩放随 ffmpeg 版本漂移 (实测 0.1→+29 级非 255
    直觉); lut 直接在 Y 级域平移, 与探测统计域自洽。clip() 内逗号按滤镜图
    转义惯例写成 "\\," (同 join_engine volume enable=between)。saturation
    不动不写。
    """
    delta = params["brightness"]
    return "eq=contrast=%g,lut=y=clip(val%+g\\,0\\,255)" % (params["contrast"], delta)


def build_lutyuv_filter(params):
    """lutyuv 参数 → ffmpeg 滤镜串: Y=clip(gain*val+offset), CB/CR=clip(val±shift).

    批 4 T1 A: 探测域 (yuv444p raw) 与滤镜域同为 8bit YUV 平面, 端点/平移逐级
    自洽; clip() 内逗号转义 \\, 同 build_eq_filter 惯例。
    """
    return ("lutyuv=y=clip(%g*val%+g\\,0\\,255)"
            ":u=clip(val%+g\\,0\\,255):v=clip(val%+g\\,0\\,255)"
            % (params["y_gain"], params["y_offset"],
               params["u_shift"], params["v_shift"]))


def apply_eq(frames, params):
    """滤镜组合几何语义模拟 (8bit 量化): 合成基准恢复精度验证用."""
    arr = np.asarray(frames, dtype=np.float64)
    out = (params["contrast"] * (arr - 128.0) + 128.0 + params["brightness"])
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def resolve_config(cfg):
    """h3_config.json "color" 块 → (color_level, flatten)。非法模式 raise."""
    cfg = cfg if isinstance(cfg, dict) else {}
    level = str(cfg.get("color_level") or DEFAULT_COLOR_LEVEL)
    if level not in COLOR_LEVEL_MODES:
        raise ValueError(
            f"非法色彩对齐模式 {level}:仅支持 {'/'.join(COLOR_LEVEL_MODES)}")
    flatten = bool(cfg.get("flatten", DEFAULT_FLATTEN))
    return level, flatten


def flatten_hint(n_segments, flatten):
    """>=FLATTEN_HINT_MIN_SEGMENTS 段且 flatten 开 → True (黄条建议保持, 不强制)."""
    return bool(flatten and n_segments >= FLATTEN_HINT_MIN_SEGMENTS)


# ============================================================
# 执行侧 — 尾窗统计探测 + 逐段预处理
# ============================================================

def probe_y_stats(path, ffmpeg_exe="ffmpeg", ffprobe_exe="ffprobe"):
    """单段全段 Y/UV 统计 (批 4 T1 规则 2): 全帧 yuv444p raw → numpy 三平面。

    全段口径 (去 V1.9 -sseof 尾窗, 均值口径防异常帧带偏): 估算帧数超上限时
    -vf fps=N 均匀抽帧 (N=上限/时长, 均匀覆盖全段) + -frames:v 封顶; 帧预算 =
    min(SAMPLE_MAX_FRAMES, 字节预算/单帧字节) — 大分辨率段自动收紧 (3328×1920
    → ~10 帧); fps/时长不可得 → 全段解码 (60s 超时兜底)。
    段文件不存在直接 raise (不跑 ffmpeg); ffprobe (复用
    join_engine.probe_segment) 取宽高/fps/时长。pix_fmt yuv444p 语义同 V1.9
    (YUV 家族内 Y 平面逐字节保留, 探测域=滤镜域)。每帧平面布局 Y|U|V 各 w*h。
    解码失败/无帧 raise ColorAlignError。返回 y_stats (含 ymin/ymax) +
    u_mean/v_mean。
    """
    if not os.path.exists(path):
        raise ColorAlignError("段文件不存在: %s" % path)
    info = join_engine.probe_segment(path, ffprobe_exe=ffprobe_exe)
    w, h = info.get("width"), info.get("height")
    if not w or not h:
        raise ColorAlignError("段无分辨率信息: %s" % path)
    frame_bytes = w * h * 3
    max_frames = max(SAMPLE_MIN_FRAMES,
                     min(SAMPLE_MAX_FRAMES, SAMPLE_BYTES_BUDGET // frame_bytes))
    fps, dur = info.get("fps_float"), info.get("duration")
    sample_args = []
    if fps and dur and fps * dur > max_frames:
        sample_args = ["-vf", "fps=%g" % (max_frames / dur),
                       "-frames:v", str(max_frames)]
    cmd = ([ffmpeg_exe, "-v", "error", "-i", path] + sample_args
           + ["-f", "rawvideo", "-pix_fmt", "yuv444p", "-"])
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ColorAlignError("ffmpeg 全段解码 %s 异常: %s" % (path, e))
    if proc.returncode != 0 or not proc.stdout:
        raise ColorAlignError("ffmpeg 全段解码 %s 失败 rc=%d %s"
                              % (path, proc.returncode, _stderr_tail(proc.stderr)))
    plane = w * h
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    n = len(buf) // (plane * 3)
    if n == 0:
        raise ColorAlignError("全段无完整帧: %s" % path)
    frames = buf[:n * plane * 3].reshape(n, 3, h, w)
    stats = y_stats(frames[:, 0, :, :])              # Y 平面 (含 ymin/ymax)
    stats["u_mean"] = float(frames[:, 1, :, :].mean())
    stats["v_mean"] = float(frames[:, 2, :, :].mean())
    return stats


def probe_and_plan(parts, color_level=DEFAULT_COLOR_LEVEL,
                   flatten=DEFAULT_FLATTEN, ffmpeg_exe="ffmpeg",
                   ffprobe_exe="ffprobe"):
    """批 4 T1 D: probe 全段统计 → 对齐计划 (不重编码 — 滤镜入链的参数侧).

    返回 (plan, info): plan = plan_alignments 输出 (含逐段 filter 滤镜串);
    info = {"mode", "flatten", "flatten_hint", "segments", "per_seg_adjust":
    [{index, file, adjusted, brightness, contrast, filter}]} — batch_core 写
    manifest["_color"] 批级留痕。lutyuv 路径的 brightness/contrast 为留痕换算
    (Y 均值等效移位 / 端点跨度增益), 供审片报告色彩偏差列与报警阈值沿用。
    单段 (无参考可对齐) → ([], info) 不 probe。probe 失败 raise
    ColorAlignError (接入方整体降级回原段 — 半对齐状态不可接受)。
    """
    parts = list(parts)
    info = {"mode": color_level, "flatten": bool(flatten),
            "segments": len(parts),
            "flatten_hint": flatten_hint(len(parts), flatten),
            "per_seg_adjust": []}
    if len(parts) < 2:
        return [], info
    stats = [probe_y_stats(p, ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)
             for p in parts]
    plan = plan_alignments(stats, color_level, flatten)
    for item in plan:
        adj = item["adjust"]
        entry = {"index": item["index"],
                 "file": os.path.basename(parts[item["index"]]),
                 "adjusted": adj is not None,
                 "brightness": None, "contrast": None, "filter": item["filter"]}
        if adj is not None:
            if "y_gain" in adj:                       # lutyuv 留痕换算
                seg = stats[item["index"]]
                entry["brightness"] = (adj["y_gain"] * seg["mean"]
                                       + adj["y_offset"] - seg["mean"])
                entry["contrast"] = adj["y_gain"]
            else:
                entry["brightness"] = adj["brightness"]
                entry["contrast"] = adj["contrast"]
        info["per_seg_adjust"].append(entry)
    return plan, info


def recode_segments(parts, plan, tmp_dir, info, ffmpeg_exe="ffmpeg"):
    """批 4 T1 D 降级路径: 计划滤镜 → 逐段暂存重编码 (同一套参数, 不再 probe).

    对齐激活时 compose_join 失败的回退 (v3 P1 修复: 不降流复制拼未对齐原件)。
    被调段写出 tmp_dir/seg_NNN_align.mp4 (crf18/preset medium, 音频 copy,
    pix_fmt 保持源); 参考段/死区内段保持原路径; info 对应条目补 file_out。
    重编码任何失败 raise ColorAlignError。返回 (new_parts, info)。
    """
    parts = list(parts)
    new_parts = list(parts)
    if any(item["filter"] for item in plan):
        os.makedirs(tmp_dir, exist_ok=True)
    for i, item in enumerate(plan):
        filt = item["filter"]
        if filt is None:
            continue
        out = os.path.join(tmp_dir, "seg_%03d_align.mp4" % i)
        cmd = [ffmpeg_exe, "-y", "-i", parts[i], "-vf", filt,
               "-c:v", "libx264", "-crf", RECODE_CRF,
               "-preset", RECODE_PRESET, "-c:a", "copy", out]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ColorAlignError("色彩对齐重编码 %s 异常: %s" % (parts[i], e))
        if proc.returncode != 0 or not os.path.exists(out):
            raise ColorAlignError("色彩对齐重编码 %s 失败 rc=%d %s"
                                  % (parts[i], proc.returncode,
                                     _stderr_tail(proc.stderr)))
        new_parts[i] = out
        info["per_seg_adjust"][i]["file_out"] = os.path.basename(out)
    return new_parts, info


def align_segments(parts, tmp_dir, color_level=DEFAULT_COLOR_LEVEL,
                   flatten=DEFAULT_FLATTEN, ffmpeg_exe="ffmpeg",
                   ffprobe_exe="ffprobe"):
    """join 前逐段色彩对齐预处理 (V1.9 落地形态, 批 4 T1 起主路径改为滤镜入链
    probe_and_plan + compose_join filter_complex; 本函数保留完整形态作兼容与
    降级链入口): probe 全段统计 → 计划 → 暂存重编码。

    被调段写出 tmp_dir/seg_NNN_align.mp4; 参考段/死区内段保持原路径。单段
    列表直接原样返回。probe/重编码任何失败 raise ColorAlignError (接入方整体
    降级回原段 — 半对齐状态不可接受)。返回 (new_parts, info) (info 形态同
    probe_and_plan, 重编码段补 file_out)。
    """
    parts = list(parts)
    plan, info = probe_and_plan(parts, color_level=color_level, flatten=flatten,
                                ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)
    if len(parts) < 2:
        return parts, info
    return recode_segments(parts, plan, tmp_dir, info, ffmpeg_exe=ffmpeg_exe)
