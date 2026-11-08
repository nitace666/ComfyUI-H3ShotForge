import asyncio
import csv
import glob
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from urllib.parse import urlsplit

from aiohttp import web
from PIL import Image
import folder_paths
import server

# 批 B 节点 B-III 终版: cv2 依赖整体退场 (老板裁决去掉自动裁脸, 端点无 cv2 用途).
# 保留 PIL 处理图片: thumb 用 PIL.Image.thumbnail, asset_crop rect 用 PIL.Image 编码 PNG,
# image_meta 用 PIL.Image.open 取尺寸. 既有 numpy/asarray 路径亦随之清理.

from . import prompt_assembler
from .batch_core import H3BatchEngine, summarize_manifest, browse_dir, DEFAULT_WORKFLOW, H3_WORKFLOW_DIR, _default_input_dir, list_h3_templates, _resolve_workflow_path, parse_queue_file, run_queue, run_repeats, ShotError, _RESERVED_KEYS, _template_mode, check_prompt_rules, check_timeline, KNOWN_USAGE_IDS, USAGE_REGISTRY, video_first_frame_png, parse_cast, resolve_cast, card_cast_rows, assign_cast_slots, _detect_bound_names_in_text, aggregate_soundscape_warns, _check_seg_pool_limits, apply_review_void, read_manifest_safe, _manifest_write, resolve_manifest_path, compute_concat_map, ASPECT_OPTIONS, _normalize_ratio, ASPECT_MAP, _validate_pdd_steps as _bc_validate_pdd_steps, CONCAT_FLAG_COL, derive_seg_flags, ARCHIVE_ROOT, _check_pool_limits, _check_global_anchor_dup, _rerun_inpaint_assemble_prompt, _probe_video_meta, _extract_audio_wav, _extract_frames, _saturation_ratio, _hue_align_video, LIPSYNC_COLOR_SKIP_TOL, _submit_error_detail
from . import batch_core  # V1.13 D1: 命名点用 batch_core._sanitize_stem/_check_stem_clobber 等模块级助手 (from-import 仅绑名字, 不绑模块)
from .csv_gen import build_csv, parse_csv_to_data
from .quick_shot import H3QuickShot, quick_payload, quick_data_to_csv_data
from .shot_vocab import load_vocab, STRUCT_FIELDS
from .resources_scan import scan_kind as _rs_scan_kind, KIND_TO_FOLDER as _RS_KIND_TO_FOLDER, discover_template_loras as _rs_discover_template_loras, discover_template_loaders as _rs_discover_template_loaders, template_has_pdd as _rs_template_has_pdd
from . import motion_context_sub  # 批 3 T3.1: motion_context 子包移植 (4 节点 + 双 patch, 惰性安装保留)
from . import threepov  # V1.11c 波1: 出三视图端点 (#45/#46) + 任务注册表 (本仓内自建模块)
# 暴露 handler 到本模块命名空间 (既供 _register_route 取用, 也供测试 getattr 取)
_h3_threepov_submit = threepov._h3_threepov_submit
_h3_threepov_status = threepov._h3_threepov_status
# V1.12 T6: 场景画布端点 (#47/#48) handler 绑定 (同 threepov 模式)
_h3_scene_canvas_submit = threepov._h3_scene_canvas_submit
_h3_scene_canvas_status = threepov._h3_scene_canvas_status
# V1.12b T3: 道具画布端点 (#53/#54) handler 绑定 (同 threepov/scene_canvas 模式)
_h3_item_canvas_submit = threepov._h3_item_canvas_submit
_h3_item_canvas_status = threepov._h3_item_canvas_status

_active_lock = threading.Lock()
_active = None  # threading.Thread 后台线程; None = 无任务
_active_engine = None  # H3BatchEngine 单实例 (普通模式) / None (队列模式 cancel 仅影响当前段)
# V1.12b v4 T4: 人物建档 占位标志 — submit pre-batch 内原子置位, try/finally 清理;
# 三端点互斥首部 getattr 查此标志 → 409 enrollment_busy. 与 _active 正交: 建档期
# _active=False, 跑批期 _enrollment_busy=False (互不重叠, 端点互斥同时查两者).
_enrollment_busy = False
# T3-甲 (契约定点二): 最近一次建档结果 {stem, status, error} — status 端点按 stem
# 匹配透传 "enrollment" 字段 (GUI 感知建档软失败; 老板既裁建档失败不挡批).
_enrollment_result = {}


def _try_claim_enrollment_busy():
    """原子占位 — 检查 + 置位 同一 _active_lock 临界区 (防双并发 submit 同时过 preflight).

    Returns:
        True  = 本次 claim 成功 (可继续建档)
        False = 已被占 (并发 / 重入) → 调用方应放弃或返 409
    """
    global _enrollment_busy
    with _active_lock:
        if _enrollment_busy:
            return False
        _enrollment_busy = True
        return True


def _release_enrollment_busy():
    """释放 _enrollment_busy 占位 — 与 _try_claim_enrollment_busy 配对, 必走 try/finally.

    即使中途抛异常 (render_sheet 失败 / card-write 软失败) 也必须清, 否则端点永久 409.
    """
    global _enrollment_busy
    with _active_lock:
        _enrollment_busy = False
# V1.11 批 1 T5: 手动拼接独占锁 — 拼接 ffmpeg 写产物 + 不可中断, 与 submit/rerun
# 双向互斥 (Windows os.rename 与 ffmpeg 读段产物冲突). 不进 _active (拼接不可 cancel),
# 用独立模块级 Lock + bool 标志.
_concat_lock = threading.Lock()
_concat_running = False
# 1.14b U4a: 后处理端点模块级锁 + 标志 — 照 concat 四重防护 (防并发 + 收尾 + active 互斥)
_postfx_lock = threading.Lock()
_postfx_running = False
# 1.14b U4b: 进度快照 (status 端点读源) — None=空闲; dict={task_id,kinds,total,time_start}
# done/failed 等细粒度进度由 postfx_engine 内部回调提供 (U5+ 范畴), U4b 仅暴露快照入口
# 验收: 空闲 running=false / current=None; 运行中 current 含上述四字段. 进度数字精度
# 不在本期承诺, U5/U6 再实装回调链.
_postfx_progress = None
# V1.13k T4 (#59 互斥): decide 端点内部独立粗锁 — 防 accept 与 discard 并发撕裂
# manifest; 锁序单向 `_decide_lock → _manifest_lock` (mp). 不能复用 _manifest_lock,
# 因 threading.Lock 不可重入且 _manifest_write 内部已持 mp 锁.
_decide_lock = threading.Lock()
# V1.11 fix2 (fix5): 收尾异步化 — 真正的 _finalize_lock / _finalizing 在 batch_core 模块级
# (那里既被线程调用、又被本模块的 status 端点 + submit 守卫读 phase)。下面从 batch_core 拉
# 一份到本模块命名空间, 让 'in __init__' 错相信也能找到 (本模块外的桥接不依赖包结构)。
from .batch_core import _finalize_lock, _finalizing


# V1.11 收尾异步化专项 T2: 端点守卫 — 收尾中(output_dir 在 _finalizing 注册表)→
# 409 finalizing_busy, 防写盘/搬运 vs 后台收尾竞态。 helper 包 normcase+abspath+查表
# 一条龙; 端点按各自既有 output_dir 取法 (request query/body 经 _status_output_dir
# 兜底) 调 _finalizing_hit, 错误前缀 finalizing_busy: 统一口径。


# 1.14 D4: postfx 运行期 409 守卫 helper — 9 个写操作端点 (submit / rerun 家族 /
# seg_edit / seg_candidates / candidate_decide / rerun_inpaint / concat) 收敛为
# 单一 helper 调用 (D2 审核观察 S3). 锁内仅查阅, 不改状态, 与既有 409 active_busy /
# finalizing_busy / concat_busy 同口径 (抄 concat_busy 在 _concat_lock 内的查阅写法,
# 写端点用 concat_lock 而 postfx_lock 同形态). helper 入参 = (); 出参 = 响应对象 or
# None. 调用方按既有 5 行写法收窄为 2 行 (resp = _postfx_busy(); if resp is not None:
# return resp). 错误信封与 D2 完全一致 — 不破坏既有契约.
def _postfx_busy():
    """postfx 运行期查询 — 占线返 409 响应对象; 空闲返 None.

    D2: 反向互斥 (9 个写端点) 锁内查 _postfx_running, 占线 → 409 postfx_busy.
    D4: 9 处内联守卫收敛为此单一 helper, 调用方按 None 判定是否阻断.
    """
    with _postfx_lock:
        if _postfx_running:
            return web.json_response({"ok": False,
                                      "error": "postfx_busy: 后处理运行中, 请稍候"},
                                     status=409)
    return None


def _attach_run_init_error(resp, stem):
    """#40: 按 stem 匹配 + running==false + 非空 三条件附 resp["run_init_error"].

    status 端点早退分支与主分支共用 (契约同口径 — 同 _enrollment_result 先例).
    模块级记录由 batch_core.run() 落盘前死时写入, 新提交受理时清零."""
    rec = getattr(batch_core, "_last_run_init_error", None) or {}
    if resp.get("running") or rec.get("stem") != stem or not rec.get("error"):
        return
    resp["run_init_error"] = rec["error"]


def _unet_family_conflict(wf_path, new_unet):
    """端点写时 unet 家族互斥判 — 与引擎 _apply_overrides 同源结构判型.

    闲时批 B (V1.14 K1-S1 收口): 旧口径按模板文件名 _family_match 猜族, 文件名
    带 fl2v 但结构 i2v 的模板 (FusedTurboINT8 04_i2v_fl2v 及 lowvram 版) 被端点
    误拒 400 而引擎放行 → 分叉. 现与引擎同口径: _template_mode 结构判型,
    仅 ref2v/fl2v 真结构维持互斥, t2v/i2v 放行任意族; 判型不出 (空路径/缺文件/
    匿名工作流) → 不拦 (同旧空名行为). wf_path 取 manifest["_workflow"] 全路径.
    """
    _n_ref, _n_fl = batch_core._family_match(str(new_unet).lower())
    if not (_n_ref or _n_fl):
        return False
    tmode = _template_mode(wf_path) if wf_path else None
    return ((tmode == "ref2v" and _n_fl and not _n_ref) or
            (tmode == "fl2v" and _n_ref and not _n_fl))


def _finalizing_hit(output_dir):
    try:
        key = os.path.normcase(os.path.abspath(output_dir))
    except Exception:
        return False
    with _finalize_lock:
        return bool(_finalizing.get(key))


# 1.14c C2 (E2): 三 rerun 家族端点 active 拦截统一文案 — 审片门暂停时引擎线程虽存活
# 但批已停, 用户想重跑只能先放行/裁决跑完或取消本批 (不放开 _active 拦截, 防丢数据).
# 须持 _active_lock 调用 (与既有端点同一临界区读 phase 快照); 不动批注册。
def _active_busy_response():
    """活跃批 409 响应: 审片门暂停给可行路径提示, 其余 phase 维持 active_busy 旧文案.

    Returns: web.json_response(409) 或 None (无活跃批, 调用方继续原流程).
    """
    if _active is None or not _active.is_alive():
        return None
    phase = getattr(_active_engine, "phase", "") or "跑批中"
    if phase == "审片门暂停":
        return web.json_response(
            {"ok": False,
             "error": "审片门暂停中：请先放行/裁决使本批跑完，或取消本批后再重跑"},
            status=409)
    return web.json_response({"ok": False,
                              "error": "active_busy: 已有批量任务在运行 (phase=%s)" % phase},
                             status=409)

# V1.11 批 2 T1: detail 端点 ffprobe 探测 — 可执行路径解析 (PATH 优先,
# 回落 C:\ffmpeg\bin\ffprobe.exe; imageio-ffmpeg 只带 ffmpeg 无 ffprobe,
# 不再回落 — 与 batch_core._ffprobe_exe 思路一致, 仅 PATH+本地两档).
def _h3_ffprobe_exe():
    p = shutil.which("ffprobe")
    if p:
        return p
    local = r"C:\ffmpeg\bin\ffprobe.exe"
    if os.path.isfile(local):
        return local
    return "ffprobe"  # 让 subprocess 报可读 FileNotFoundError


def _h3_probe_video_resolution(path):
    """单段现行产物 ffprobe 探测 width/height — 同步阻塞, 调用方需走 asyncio.to_thread.

    只取视频流 width/height (常见 16:9/9:16/1:1/4:3 等), 探测失败 raise RuntimeError.
    段文件缺失直接 raise (不跑 ffprobe — 缺文件段无从探测, 减噪声).
    """
    if not os.path.isfile(path):
        raise RuntimeError("段产物不存在: %s" % path)
    cmd = [_h3_ffprobe_exe(), "-v", "error",
           "-select_streams", "v:0",
           "-show_entries", "stream=width,height",
           "-of", "csv=p=0", path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError("ffprobe %s 异常: %s" % (path, e))
    if proc.returncode != 0:
        raise RuntimeError("ffprobe %s 失败 rc=%d" % (path, proc.returncode))
    raw = (proc.stdout or b"").decode("utf-8", "replace").strip()
    parts = raw.split(",")
    if len(parts) != 2:
        raise RuntimeError("ffprobe %s 输出非 width,height: %r" % (path, raw))
    try:
        return int(parts[0].strip()), int(parts[1].strip())
    except ValueError:
        raise RuntimeError("ffprobe %s 宽高非整数: %r" % (path, raw))


def _clean_path(v, default=""):
    s = str(v).strip() if v is not None else ""
    if s.lower() in ("", "none", "null", "undefined"):  # 工作流残留脏值
        return default
    return s


def _status_output_dir(output_dir):
    """_h3_status 兜底: 与 start() 对空 server_output_dir 同口径, 空值/脏值回退到 folder_paths.get_output_directory().
    模块级 (非 handler 闭包内) 是为了让测试能直调验证兜底口径; handler 内仅一行调用。"""
    return _clean_path(output_dir) or folder_paths.get_output_directory()


# V1.11 批 1 T6: 两级删除/回收站 — .h3_trash 作为 output 直接子目录, 软删时 manifest
# 从原位置 (run_dir 内或根层) 移入此处; 视频/拼接产物/文件夹全不动, _trash_meta 记原位置
# 供恢复使用. .h3_trash 不是时间戳子目录, history 列表扫描需显式排除其下 manifest.
_TRASH_DIR_NAME = ".h3_trash"


# V1.11 批 3 T3: 配置预设目录 — 包根 presets/, 文件 <安全名>.json. .gitignore 已加入.
# 测试可写 mod.PRESETS_DIR 替换根路径 (兼容临时目录).
PRESETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets")
os.makedirs(PRESETS_DIR, exist_ok=True)


# V1.11 批 3 T3: 预设名白名单 — 与任务单钉死 [\w\u4e00-\u9fa5-]{1,40}, 防路径穿越/超长/特殊字符.
_PRESET_NAME_RE = re.compile(r"^[\w\u4e00-\u9fa5-]{1,40}$")


# V1.12 批 L (LLM 智能分镜) 波 1 T1: LLM 模型预设存储层 — #49 端点契约支撑层.
# 单文件 <pkg>/llm_presets.json, 含 api_key (绝不下发), 原子写仿 _manifest_write 模式但不
# 注入 _schema 键 (本文件非 manifest, 仅 CRUD 载荷). 命名规则独立于既有 _PRESET_NAME_RE
# (40 上限), 改用 1-64 字符 + 仅禁 Windows 禁字符 + 禁首尾空白.
_LLM_PRESETS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm_presets.json")
# 命名规则: 1-64 字符, 字符集 [^\s\\/:*?"<>|] (允许首尾外其它空白? 否 — 显式禁首尾空白,
# 中段空白允许 — Windows 禁字符不含空格, 但首尾空白易混路径/POSIX, 锁死两端)
# 实做: 先 fullmatch 一段不含前后空白的非空字符串, 再 length 1-64.
# Windows 禁字符: \ / : * ? " < > |
# 1-64 字符; 整串由非空字符开头/结尾 (排除首尾空白); 中段任意非禁字符 (允许空格)
# 单字符名: 兜底分支仅一个非禁字符.
_LLM_PRESET_NAME_RE = re.compile(r"^\S(?:[^\s\\/:*?\"<>|]{0,62}\S)?$")

# 内置 seed 默认本地条目 (列表首次为空时插入, 用户可删可改).
_LLM_PRESET_SEEDS = [
    {"name": "ollama-local", "base_url": "http://127.0.0.1:11434/v1",
     "api_key": "", "model": "", "context_window": 8192},
    {"name": "lmstudio-local", "base_url": "http://127.0.0.1:1234/v1",
     "api_key": "", "model": "", "context_window": 8192},
]
_LLM_PRESETS_LOCK = threading.Lock()

# C4 (1.14 整改批 C): context_window 合法范围与缺省.
# 上界 2_000_000 覆盖 Gemini 1.5 Pro / Llama 3.1 405B 等当前最大公开模型.
# 下界 256 保证半窗 128 与 max_output 64 的预算仍为正 (避免半窗 ≤ 0 误判 500).
_LLM_CONTEXT_WINDOW_MIN = 256
_LLM_CONTEXT_WINDOW_MAX = 2_000_000
_LLM_CONTEXT_WINDOW_DEFAULT = 8192

# 2026-10-26 老板裁（GUI1.4 · AI 回复常被截断）：预设可选 max_tokens（最大输出 tokens）。
# 缺省/留空 = 按 context_window // 4 推（去掉旧 4096 硬顶）；显式配置则优先用配置值。
_LLM_MAX_TOKENS_MIN = 256
_LLM_MAX_TOKENS_MAX = 32768

# #60 批9 E3: 上游调用超时可配 (GUI 设置页「聊天超时」→ 请求体 timeout_sec).
# 钳制区间与 GUI 同款 (GUI1.4 app/js/core/timeouts.js: LLM_CHAT_TIMEOUT_MIN_SEC=30 /
# LLM_CHAT_TIMEOUT_MAX_SEC=900)·缺省/非法 → llm_client._DEFAULT_TIMEOUT (300s·单点).
_LLM_CHAT_TIMEOUT_MIN_SEC = 30
_LLM_CHAT_TIMEOUT_MAX_SEC = 900


# ---------- #46 引擎侧: 历史剥块 + 两段式保头保尾裁剪 (批7 · 方案 v2.1 §四) ----------
# GUI 隐藏块标记 — 与 GUI app/js/views/ai-archive.js 的 OUTPUT_SPEC_MARK /
# PROJECT_CONTEXT_MARK 逐字节一致 (GUI 发送侧 wire 形态: "\n\n---\n[输出规范]\n…").
_H3_HIDDEN_SPEC_MARK = "---\n[输出规范]"
_H3_HIDDEN_PROJ_MARK = "===\n[项目上下文]"
# 中间省略标记 (只发送不落盘) — 措辞按方案 §四.3 (不用"更早/起点"·免自相矛盾).
_H3_OMISSION_MARKER = "（中间较早的部分对话已省略，共 %d 条）"
# 标记行预留字符数 (计入本轮 user 预算 — 方案 §四.2 ① / I1: 不留就会炸半窗锚).
_H3_MARKER_RESERVE = 64
# system 预留初值 = 角色段 + 档位文档前 2000 字符 (≈2100).
# 实现期实测 (2026-10-29): 普通档文档 H3提示词规则与技巧.md (5203 字符) 前 2000
# 字符虽含 fenced 块, 但全是提示词写法示例 (❌/✅/六段式); 快照输出契约关键词
# (globals/shots/段落时长/导出文件名/snapshot/JSON) 全篇 0 命中 → 预留初值维持
# 2100 不上调 (若日后档位文档前置快照契约, 调此值至契约结束处).
_H3_SYSTEM_RESERVE = 2100
# system 压缩下限 = half×0.25 (仅小窗起作用) / 头部配额上限 = half×0.5.
_H3_SYSTEM_FLOOR_RATIO = 0.25
_H3_HEAD_RATIO = 0.5


def _h3_strip_hidden_blocks(text):
    """剥除 GUI 隐藏块 (输出规范 + 项目上下文) — 复刻 GUI stripHiddenBlocks 语义.

    口径 (与 GUI app/js/views/ai-archive.js:436-446 逐行同款): 先找输出规范标记
    (首次出现) 截断 → 再找项目上下文标记 (首次出现) 截断 → 有改动才去尾空白.
    非字符串 → 空串. 会话文件落盘原文不动 (只改发送体).
    """
    if not isinstance(text, str):
        return ""
    out = text
    i = out.find(_H3_HIDDEN_SPEC_MARK)
    if i >= 0:
        out = out[:i]
    i = out.find(_H3_HIDDEN_PROJ_MARK)
    if i >= 0:
        out = out[:i]
    if out != text:
        out = out.rstrip()
    return out


def _llm_preset_validate_name(name):
    """返回 None 通过 / str 错误信息."""
    if not isinstance(name, str):
        return "name 必为字符串"
    if not name:
        return "name 不可为空"
    if len(name) > 64:
        return "name 长度 1-64, 实 %d" % len(name)
    # 首尾空白禁
    if name != name.strip():
        return "name 禁首尾空白"
    # 禁字符
    if re.search(r'[\\/:*?"<>|]', name):
        return "name 含 Windows 禁字符"
    return None


def _llm_preset_validate_base_url(url):
    """返回 None 通过 / str 错误信息. http(s):// 开头."""
    if not isinstance(url, str):
        return "base_url 必为字符串"
    s = url.strip()
    if not s:
        return "base_url 必填"
    if not (s.startswith("http://") or s.startswith("https://")):
        return "base_url 必须 http(s):// 开头"
    return None


def _llm_preset_validate_model(model):
    """返回 None 通过 / str 错误信息. 必填, 1-256 字符."""
    if not isinstance(model, str):
        return "model 必为字符串"
    s = model.strip()
    if not s:
        return "model 必填"
    if len(s) > 256:
        return "model 长度 1-256, 实 %d" % len(s)
    return None


def _llm_preset_validate_context_window(cw):
    """context_window 校验 — None 走默认 8192; 否则须整数/数字串且在 [256, 2_000_000].

    字母/浮点/列表/空串 → 拒 (回 None 表示通过, 返回 str 表示拒绝原因).
    范围 C4 锁: 上界覆盖 Gemini 1.5 Pro / Llama 3.1 405B (2M) 等当前最大公开模型;
    下界 256 保证半窗 128 与 max_output 64 的预算仍为正 (避免半窗 ≤ 0 误判).
    """
    if cw is None:
        return None  # 走默认 8192
    if isinstance(cw, bool):
        return "context_window 必须是整数, 当前 bool: %r" % (cw,)
    if isinstance(cw, int):
        n = cw
    elif isinstance(cw, str):
        s = cw.strip()
        if not s:
            return "context_window 字符串为空"
        # 拒绝浮点 "3.14" / 指数 "1e5" / 正负号外的杂字符; 仅允许可选负号 + 数字
        if not re.fullmatch(r"-?\d+", s):
            return "context_window 必须是整数, 当前: %r" % (cw,)
        try:
            n = int(s)
        except ValueError:
            return "context_window 必须是整数, 当前: %r" % (cw,)
    else:
        return "context_window 必须是整数, 当前类型 %s" % type(cw).__name__
    if n < _LLM_CONTEXT_WINDOW_MIN or n > _LLM_CONTEXT_WINDOW_MAX:
        return "context_window 范围 %d-%d, 实 %d" % (
            _LLM_CONTEXT_WINDOW_MIN, _LLM_CONTEXT_WINDOW_MAX, n)
    return None


def _llm_preset_validate_max_tokens(mt):
    """max_tokens 校验 — None/空串 = 默认（按上下文窗口/4）；否则须整数/数字串且在 [256, 32768].

    返回 None 表示通过, str 表示拒绝原因（与 context_window 校验同口径）.
    """
    if mt is None:
        return None
    if isinstance(mt, bool):
        return "max_tokens 不可为 bool: %r" % (mt,)
    if isinstance(mt, int):
        n = mt
    elif isinstance(mt, str):
        s = mt.strip()
        if not s:
            return None  # 空串 → 走默认
        if not re.fullmatch(r"-?\d+", s):
            return "max_tokens 必须是整数, 当前: %r" % (mt,)
        try:
            n = int(s)
        except ValueError:
            return "max_tokens 必须是整数, 当前: %r" % (mt,)
    else:
        return "max_tokens 必须是整数, 当前类型 %s" % type(mt).__name__
    if n < _LLM_MAX_TOKENS_MIN or n > _LLM_MAX_TOKENS_MAX:
        return "max_tokens 范围 %d-%d, 实 %d" % (
            _LLM_MAX_TOKENS_MIN, _LLM_MAX_TOKENS_MAX, n)
    return None


def _llm_presets_validate(name, base_url, model, context_window=None, max_tokens=None):
    """组合校验 — 返回 (None, None, None) 通过, 或 (error_field, error_msg, http_status)."""
    err = _llm_preset_validate_name(name)
    if err:
        return ("name", err, 400)
    err = _llm_preset_validate_base_url(base_url)
    if err:
        return ("base_url", err, 400)
    err = _llm_preset_validate_model(model)
    if err:
        return ("model", err, 400)
    err = _llm_preset_validate_context_window(context_window)
    if err:
        return ("context_window", err, 400)
    err = _llm_preset_validate_max_tokens(max_tokens)
    if err:
        return ("max_tokens", err, 400)
    return None


def _llm_presets_load():
    """锁内读盘 — 返回 list. 文件不存在/损坏 → 返回 list (空, 由调用方决定 seed)."""
    abs_p = os.path.abspath(_LLM_PRESETS_FILE)
    with _LLM_PRESETS_LOCK:
        if not os.path.isfile(abs_p):
            return []
        try:
            with open(abs_p, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        # 仅保留合法条目 (dict + name 字段)
        out = []
        for it in data:
            if isinstance(it, dict) and isinstance(it.get("name"), str):
                out.append(it)
        return out


def _llm_presets_persist(items):
    """锁内原子写 — 仿 _manifest_write (.tmp.pid.uuid + os.replace 重试) 但不注入 _schema 键.

    items 必为 list[dict]. 抛 OSError 由调用方处理."""
    abs_p = os.path.abspath(_LLM_PRESETS_FILE)
    os.makedirs(os.path.dirname(abs_p) or ".", exist_ok=True)
    with _LLM_PRESETS_LOCK:
        tmp = "%s.tmp.%d.%s" % (abs_p, os.getpid(), uuid.uuid4().hex[:8])
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        replaced = False
        last_err = None
        for _ in range(100):
            try:
                os.replace(tmp, abs_p)
                replaced = True
                break
            except PermissionError as e:
                last_err = e
                time.sleep(0.005)
        if not replaced:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise last_err if last_err is not None else RuntimeError("llm_presets 原子替换失败")


def _llm_presets_strip_key(item):
    """剥 api_key 字段 — 返回新 dict (不改原对象). 用于任何对外响应."""
    if not isinstance(item, dict):
        return item
    return {k: v for k, v in item.items() if k != "api_key"}


def _llm_presets_list():
    """列表 — 首次为空时返回 seed 两条本地条目 (不写盘, 等用户首次 POST 时落)."""
    items = _llm_presets_load()
    if not items:
        return [_llm_presets_strip_key(dict(s)) for s in _LLM_PRESET_SEEDS]
    return [_llm_presets_strip_key(it) for it in items]


def _llm_presets_get(name):
    """单查 — 返回剥 api_key 的 dict 或 None."""
    for it in _llm_presets_load():
        if it.get("name") == name:
            return _llm_presets_strip_key(it)
    return None


def _llm_presets_get_raw(name):
    """单查 — 返回含 api_key 的完整 dict 或 None. 仅供 #50 chat handler 内部取调用凭据."""
    for it in _llm_presets_load():
        if it.get("name") == name:
            return dict(it)
    return None


def _llm_presets_save(name, base_url, model, api_key=None, context_window=None,
                      max_tokens=None):
    """存/覆盖 — api_key 缺省 (None) 时沿用旧值; context_window 缺省 8192;
    max_tokens 缺省 (None/空串) = 默认（清除旧配置，按窗口/4 推）; 返回剥 key 的 dict.

    注意: 调用方需先过 _llm_presets_validate 拒绝脏值 (字母/负数/越界);
    本函数不再二次校验, 接受 int 与纯数字字符串 (后者按 int() 解析).
    """
    items = _llm_presets_load()
    if context_window is None:
        context_window = _LLM_CONTEXT_WINDOW_DEFAULT
    # 找旧条目
    old = None
    for it in items:
        if it.get("name") == name:
            old = it
            break
    if api_key is None and old:
        # 沿用旧 key
        keep_key = old.get("api_key", "")
    elif api_key is None:
        keep_key = ""
    else:
        keep_key = str(api_key)
    new_item = {
        "name": name,
        "base_url": base_url,
        "api_key": keep_key,
        "model": model,
        "context_window": int(context_window),
    }
    # 2026-10-26（GUI1.4 max_tokens 可配）：显式值写入；None/空串=默认（清除旧值）
    if max_tokens is not None and max_tokens != "":
        new_item["max_tokens"] = int(max_tokens)
    if old:
        old.pop("max_tokens", None)  # 留空=默认 → 清除旧配置
        old.update(new_item)
        new_disk = items
    else:
        items.append(new_item)
        new_disk = items
    _llm_presets_persist(new_disk)
    return _llm_presets_strip_key(new_item)


def _llm_presets_delete(name):
    """删除 — 返回 bool (True=删了/False=原本不存在)."""
    items = _llm_presets_load()
    out = []
    hit = False
    for it in items:
        if it.get("name") == name:
            hit = True
            continue
        out.append(it)
    if not hit:
        return False
    _llm_presets_persist(out)
    return True


def _own_server_port():
    """本服务进程端口 (rerun/拼接/submit 端点构引擎用) — 钉死自实例, 不走 8188-8200 自动探测
    (探测会撞上老板桌面 8189 等其他实例, 测试/验证进程泄漏真实渲染的根因)。
    主源 comfy.cli_args.args.port (模块级单例; 2026-09-07 批 5 止损批实锤: 真实
    PromptServer.instance 无 args 属性, 旧链恒返 0 → submit 注入失效渲染仍错发 8189);
    兜底 PromptServer.instance.args.port。取不到回 0。"""
    try:
        from comfy.cli_args import args as _cli_args
        _p = int(getattr(_cli_args, "port", 0) or 0)
        if _p:
            return _p
    except Exception:
        pass
    try:
        return int(getattr(getattr(server.PromptServer.instance, "args", None), "port", 0) or 0)
    except Exception:
        return 0


def _trash_dir_for(output_dir):
    return os.path.join(os.path.abspath(output_dir), _TRASH_DIR_NAME)


def _is_in_trash(mp, output_dir=""):
    """manifest 路径是否在 output/.h3_trash/ 下 (大小写不敏感, 路径分隔符归一).

    1.11a 波 3 T1 项 7: 加可选 output_dir 参数 — 缺省走 _status_output_dir("")
    (行为完全兼容旧调用方); DELETE 端点传入实际 output_dir, 自定义目录幂等
    判定走对应 trash 根, 不再误判 (旧实现恒用默认根, 自定义目录任务软删后
    再次 DELETE 找不到对应 trash → 走到 move 路径撞重).
    """
    if not mp:
        return False
    try:
        if output_dir:
            trash = _trash_dir_for(output_dir)
        else:
            trash = _trash_dir_for(_status_output_dir(""))
    except Exception:
        return False
    mp_n = os.path.normcase(os.path.abspath(mp))
    trash_n = os.path.normcase(os.path.abspath(trash))
    # 必须真在 trash 子目录内 (前缀 + 路径分隔符, 避免误中同名父目录)
    return mp_n == trash_n or mp_n.startswith(trash_n + os.sep)


def _trash_check_response():
    """返回回收站只读 400 响应 dict (端点层用). 路径非 trash → None."""
    return {"ok": False, "error": "task_in_trash",
            "detail": "任务在 .h3_trash 回收站, 仅支持 restore 或 purge"}


def _find_in_trash(stem, output_dir):
    """在 output/.h3_trash/ 下找 stem 对应的 manifest 路径 (含 _repN 变体).

    V1.11 交付前 BE-P2-4: 精确边界 — basename 完全匹配 `<stem>.json` 或合法变体
    `<stem>_rep<digit>.json` (repeat 批已知形态; resolve_manifest_path glob `<stem>*.json` 兜底).
    旧实现 startswith 无边界 → 'abc' 误伤 'abc_rep2.json'.
    """
    trash_dir = _trash_dir_for(output_dir)
    if not os.path.isdir(trash_dir):
        return None
    # V1.13 D1: stem 防御性清洗 (上游已校验, 此处兜底), 防 stem 含非法字符触发路径错乱
    stem = batch_core._sanitize_stem(stem)
    if not stem:
        return None
    basename = "h3_batch_manifest_%s.json" % stem
    direct = os.path.join(trash_dir, basename)
    if os.path.exists(direct):
        return direct
    # 合法变体: h3_batch_manifest_<stem>_rep<digit>.json
    _variant_re = re.compile(
        r"^h3_batch_manifest_%s_rep\d+\.json$" % re.escape(stem))
    found = None
    for n in os.listdir(trash_dir):
        if not _variant_re.match(n):
            continue
        full = os.path.join(trash_dir, n)
        if found is None or os.path.getmtime(full) > os.path.getmtime(found):
            found = full
    return found


def _norm_slots(d):
    """池/池用字典的槽位 key 归一化为 int (HTTP JSON 序列化后 key 恒为字符串, 而 enrich_blocks
    用整数 key 查找 / TAG_RE 收集 (kind, int(idx)) 用于手写去重; 字符串 key 不命中会双重注入
    P9 锚定 / 漏过去重——审核发现预览 ≠ 实发 bug 根因).
    边界归一化: 不污染纯函数 enrich_blocks; 转换失败条目跳过 (与现状缺省容错一致)."""
    if not isinstance(d, dict):
        return {}
    out = {}
    for kind, slots in d.items():
        if not isinstance(slots, dict):
            continue
        norm = {}
        for k, v in slots.items():
            try:
                norm[int(k)] = v
            except (TypeError, ValueError):
                continue
        if norm:
            out[kind] = norm
    return out


# Task D3: 端点级多角色解析链辅助 — 不复制引擎方法 _prepare_cast_plan (引擎侧零改动约束),
# 仅复用 batch_core 已暴露的纯函数族 parse_cast / resolve_cast / card_cast_rows /
# assign_cast_slots; 副本 + cast_spec 构造逻辑与引擎 per_shot 同构 (独立分配, 同槽号跨行副本互不冲突).
# 批 H2-3: 扩展 bindings 参数 — 绑定卡走物理快照 (与引擎 _prepare_cast_plan 同口径)
def _cast_plan_for_row(row, pool, pool_usage, mode, assets, bindings=None):
    """端点级: 单行 cast 解析 + 副本 + cast_spec。失败/无 cast 返回 None。
    返回 dict {cast_spec, pu_copy, virtual_slots} 或 None。
    virtual_slots = {槽号(int): media(str)} 仅本行分配的虚拟槽 (供 cmode fallback union_pool)。
    失败模式 (返回 None): 行无出场角色 / 解析出空 names / resolve_cast errs 非空 /
    白名单展开为空 / assign_cast_slots 预算不足 — 这些情况下端点不注入 cast,
    错误红条归引擎 preflight, 端点不越权报错.

    批 H2-3: bindings = [{name, no, slots:[{idx, usage, media, desc, ignore_words?}]}, ...]  (ignore_words 可选, 1.11a 波1 忽略词)
    绑定卡走快照路径 (slots 直构 slot_map), 未绑定卡走 V1.7 assign_cast_slots.
    编号规则: 绑定卡按 no, 未绑定卡从 max(绑定 no)+1 按出场顺序."""
    if not isinstance(row, dict):
        return None
    cast_text = row.get("出场角色")
    # 批 H2-3: bindings 走快照 — slot 直接读绑定 slots, 编号按 no; 走与执行同口径
    binding_lookup = {}
    if isinstance(bindings, list):
        for b in bindings:
            if (isinstance(b, dict) and isinstance(b.get("name"), str)
                    and isinstance(b.get("no"), int)
                    and isinstance(b.get("slots"), list)):
                binding_lookup[b["name"]] = b
    names, _parse_warns = parse_cast(cast_text)
    # 档 2: 列空 + prompt 含绑定名 → 在场集也含绑定 (与执行 _prepare_cast_plan 同口径)
    if not names and binding_lookup:
        detected = _detect_bound_names_in_text(row.get("prompt") or "",
                                              list(binding_lookup.keys()))
        if detected:
            names = detected
    if not names:
        return None
    names_binding = [n for n in names if n in binding_lookup]
    names_unbound = [n for n in names if n not in binding_lookup]
    if not names_binding and not names_unbound:
        return None
    # resolve 未绑定卡 (走 resolve_cast)
    resolved, errs = resolve_cast(names_unbound, assets)
    if errs:
        return None
    # 构建 slot_map: 绑定卡走快照, 未绑定卡走 assign_cast_slots
    cast_rows_unbound = []
    for name, (card, _err) in zip(names_unbound, resolved):
        if card is None:
            continue
        rows_white, _skipped = card_cast_rows(card)
        for r in rows_white:
            cast_rows_unbound.append((name, r.get("usage", ""), r.get("media", ""),
                                       r.get("desc", ""), r.get("ignore_words", "")))
    slot_map = {}
    # 绑定卡 slots 快照
    for name in names_binding:
        b = binding_lookup[name]
        for s in b["slots"]:
            if not isinstance(s, dict):
                continue
            idx = s.get("idx")
            usage = s.get("usage") or ""
            media = s.get("media") or ""
            desc = s.get("desc") or ""
            if not isinstance(idx, int):
                continue
            ig = s.get("ignore_words") or ""
            slot_map[idx] = ((name, usage, media, desc, ig)
                             if ig else (name, usage, media, desc))
    # 未绑定卡分配
    if cast_rows_unbound:
        slot_map_unbound, assign_err = assign_cast_slots(
            cast_rows_unbound, pool, pool_usage, mode)
        if assign_err:
            return None
        slot_map.update(slot_map_unbound)
    if not slot_map:
        return None
    # cast_spec 构造: 绑定按 no, 未绑定从 max(no)+1 按出场顺序
    # 批 H2 fix: 绑定卡 cast_spec 行**直接由 slots 列表迭代**构造 (避免 slot_map
    # 字典同 idx 覆盖导致 co-occupy 塌缩丢行) — 与 D 节"构造保证"铁律一致;
    # 未绑定卡保留 slot_map 路径 (虚拟槽天然无共占, 安全)
    card_order_with_no = []
    for name in names_binding:
        card_order_with_no.append((binding_lookup[name]["no"], name))
    start_no = max((no for no, _ in card_order_with_no), default=0) + 1
    for idx, name in enumerate(names_unbound):
        card_order_with_no.append((start_no + idx, name))
    cast_spec_rows = {}  # no -> [(slot, usage, desc, ignore_words), ...]
    for no, name in card_order_with_no:
        rows = cast_spec_rows.setdefault(no, [])
        if name in binding_lookup:
            # 绑定卡: 直接迭代 slots 列表 (保留 co-occupy 同 idx 多行)
            for s in binding_lookup[name].get("slots", []):
                if not isinstance(s, dict):
                    continue
                idx_s = s.get("idx")
                if not isinstance(idx_s, int):
                    continue
                rows.append((idx_s, s.get("usage") or "",
                            s.get("desc") or "", s.get("ignore_words") or ""))
        else:
            # 未绑定卡: 走 slot_map 字典 (虚拟槽无共占)
            for slot in sorted(slot_map.keys()):
                mapped = slot_map[slot]
                n2, usage_s, _m, desc_s = mapped[:4]
                if n2 == name:
                    ig_s = mapped[4] if len(mapped) > 4 else ""
                    rows.append((slot, usage_s, desc_s, ig_s))
    cast_spec = [(no, cast_spec_rows.get(no, []))
                 for no, _name in card_order_with_no]
    # 逐镜副本
    pu_copy = {
        "Picture": {k: list(v) for k, v in (pool_usage.get("Picture") or {}).items()},
        "Video":   {k: list(v) for k, v in (pool_usage.get("Video")   or {}).items()},
        "Audio":   {k: list(v) for k, v in (pool_usage.get("Audio")   or {}).items()},
    }
    virtual_slots = {}
    for slot, mapped in slot_map.items():
        name, usage, media, desc = mapped[:4]
        if slot not in pu_copy["Picture"]:
            pu_copy["Picture"][slot] = []
        if usage not in pu_copy["Picture"][slot]:
            pu_copy["Picture"][slot].append(usage)
        virtual_slots[slot] = media
    return {
        "cast_spec": cast_spec,
        "pu_copy": pu_copy,
        "virtual_slots": virtual_slots,
    }


def _cmode_fallback_for_cast(cmode, mode, pool, virtual_slots):
    """PRD §3.4 cmode 分级: cmode=None (模板不可判族) + 拼接模式 + cast 存在
    → _detect_concat_mode(池∪虚拟槽并集, has_cast=True)。
    引擎 _detect_concat_mode 在 has_cast=True 时恒返回 "ref2v" (F3 修正:
    池空/恰1图+cast 也按 ref2v 族处理)。本函数为端点级镜像, 不依赖引擎实例."""
    if cmode is not None:
        return cmode
    if mode != "拼接":
        return cmode
    # has_cast=True → 引擎 _detect_concat_mode 恒返回 "ref2v"
    return "ref2v"


def _endpoint_cmode(cmode):
    """1.14 整改批 I I2b: 端点侧判族收敛 — i2v/fl2v 归 t2v (I1 起批入口即拒).

    端点下游消费面 (check_prompt_rules / assemble_final_prompt / cast 注入门控) 只分
    ref2v vs 非 ref2v, i2v/fl2v 与 t2v 在该面不可分辨 → 归 t2v 逐字节零变化 (与 I2a
    _detect_concat_mode 收敛同口径). None (模板不可判族) 保持 None —
    _cmode_fallback_for_cast 依赖该值走 has_cast 回落链.
    """
    return cmode if cmode in ("ref2v", "t2v", None) else "t2v"


# Task 4: 资产库后端 (GET/POST /h3_batch/assets)
# T3: 资产库三层 — 加文件级 schema_version (B1 文件级写回升级只加顶层键, 卡字段原样)
_H3_ASSETS_FILENAME = ".h3_assets.json"
_H3_ASSETS_BAK = ".h3_assets.json.bak"
_H3_ASSETS_SCHEMA = 2
_H3_KIND_ALLOWED = ("character", "scene")
_H3_NAME_MAX = 64
# 1.11a 波 1 T1: v3 rows[N].ignore_words 限长 (产句层 T2 消费; 校验防线, GUI 批 4 已限 64)
_H3_IGNORE_WORDS_MAX = 64
_V2_SLOT_ALLOWED = frozenset(str(i) for i in range(1, 10))
# T8 批1: v3 动态行档案 — slot 值域按 USAGE_REGISTRY[usage].kind 限定
# Picture: 1-9 (POOL_SLOTS), Video/Audio: 1-3 (前端事实 csv_form.js:7)
_V3_SLOT_RANGES = {"Picture": set(str(i) for i in range(1, 10)),
                   "Video": set(str(i) for i in range(1, 4)),
                   "Audio": set(str(i) for i in range(1, 4))}
# 批 K1: 资产库目录结构化 — archive_docs / archive_images / asset_docs / asset_images
# V1.11c 波1 (api.md "threepov 落盘声明"): 三视图直接模式 PNG 落
# asset_library/asset_images/threepov/ 嵌套子目录. 登记进 _H3_LIBRARY_SUBDIRS
# (注册语义), _h3_ensure_library_dirs 兜底创建 (asset_images/threepov/ 嵌套路径).
# V1.12 T6: 场景画布 PNG 落 asset_images/scene_canvas/, 同款双登记.
# V1.12b T3: 道具画布 PNG 落 asset_images/item_canvas/, 同款双登记.
_H3_LIBRARY_DIR = "asset_library"
_H3_LIBRARY_SUBDIRS = ("archive_docs", "archive_images", "asset_docs",
                       "asset_images", "threepov", "scene_canvas", "item_canvas")
# V1.11c 波1: 嵌套子目录 (parent, child) — 三视图 PNG 落 asset_images/threepov/.
# _H3_LIBRARY_SUBDIRS 注册表只容纳顶层, 嵌套路径显式声明 (契约落盘声明).
_H3_LIBRARY_NESTED_SUBDIRS = (("asset_images", "threepov"),
                              ("asset_images", "scene_canvas"),
                              ("asset_images", "item_canvas"))


def _h3_ensure_library_dirs():
    """惰性确保 input_dir 下资产库 4+1 顶层子目录 + 嵌套子目录存在 (exist_ok, 幂等)."""
    base = os.path.join(folder_paths.get_input_directory(), _H3_LIBRARY_DIR)
    for sub in _H3_LIBRARY_SUBDIRS:
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    for parent, child in _H3_LIBRARY_NESTED_SUBDIRS:
        os.makedirs(os.path.join(base, parent, child), exist_ok=True)
    return base


# 1.14 整改批 C C3: 卡名漏斗统一 — 单一漏斗 = `_h3_safe_filename`, 函数体迁入 batch_core.py
# (读侧 _load_primary_card_for_route / enrollment_should_run 直接用, 避免循环依赖).
# 本处改为 `from .batch_core import _h3_safe_filename` 重新导出, mod._h3_safe_filename
# 既可调用, C2 第 2 层扩字符集契约零回归 (test_c2_card_name_illegal_chars 20 例 + asset_library
# 既有 contract 全保留). 见 batch_core._h3_safe_filename 完整 docstring.
from .batch_core import _h3_safe_filename  # noqa: F401  (re-export for mod._h3_safe_filename)


def _h3_check_colon(value, field_name):
    """Windows 文件名禁用冒号 ':'; 含冒号直接 400, 拒绝比清洗更防路径逃逸.
    返回: (ok, err_response); ok=True 时 value 原样返回, ok=False 时 err_response 为 400 响应.
    1.14 整改批 C C2 保留为 archive_purge / asset_copy 的窄口径冒号检查 (A6 T1 先例);
    卡名保存入口改走 _h3_check_name_chars 扩全禁字符集."""
    if isinstance(value, str) and ":" in value:
        return False, web.json_response(
            {"error": "%s 含非法字符 ':' (Windows 文件名禁用)" % field_name},
            status=400)
    return True, value


# 1.14 整改批 C C2 第 1 层: 卡名保存入口扩全禁字符集 → 400 拒绝.
# 扩字符集 = Windows 文件名禁用字符集中的非路径分隔符部分 [:*?"<>|]
# (即除 / \\ .. 已走 _h3_safe_filename 清洗路径之外的剩余 7 字符); 沿用冒号先例的
# 拒绝型语义 (拒绝比清洗更防路径逃逸 — 直接报 400 比落 OSError 500 更契约友好).
# / \\ 由 _h3_safe_filename 兜底清洗 (路径分隔符, 既有 sanitize 行为不变).
# 报错文案列出首个非法字符, 错误信封随端点既有风格 (旧式 {"error": ...}).
def _h3_check_name_chars(value, field_name):
    """卡名/档案名 Windows 非法字符集 [:*?"<>|] 拦截 → 400.
    返回: (ok, err_response); ok=True 时 value 原样返回, ok=False 时 err_response 为 400 响应."""
    if isinstance(value, str):
        for _ch in "?:*\"<>|":
            if _ch in value:
                return False, web.json_response(
                    {"error": "%s 含非法字符 '%s' (Windows 文件名禁用)"
                               % (field_name, _ch)},
                    status=400)
    return True, value


def _h3_assets_path():
    return os.path.join(folder_paths.get_input_directory(), _H3_ASSETS_FILENAME)


def _h3_read_assets():
    """读资产文件: 返回 (assets_dict, error_msg). 缺失/损坏不抛, 由调用方决定如何响应.
    T3: 顶层 schema_version 键返回前剔除 (consumer 口径: GET/前端遍历/POST count 均按剔除后口径).
    批 K1: 追加扫描 input_dir/asset_library/archive_docs/*.json (v3 档案一档一文件),
    同名冲突时 archive_docs 优先 (新存储为准); 单文件损坏跳过 + 拼接进 error."""
    errs = []
    assets = {}
    p = _h3_assets_path()
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                errs.append("资产文件格式错误: 根应为对象")
                data = {}
            else:
                data.pop("schema_version", None)
                if isinstance(data, dict):
                    assets.update(data)
        except (OSError, ValueError) as e:
            errs.append("资产文件读取失败: %s" % e)
    # 批 K1: 扫描 archive_docs
    archive_dir = os.path.join(folder_paths.get_input_directory(),
                                _H3_LIBRARY_DIR, "archive_docs")
    if os.path.isdir(archive_dir):
        for fn in os.listdir(archive_dir):
            if not fn.endswith(".json"):
                continue
            ap = os.path.join(archive_dir, fn)
            if not os.path.isfile(ap):
                continue
            try:
                with open(ap, encoding="utf-8") as f:
                    card = json.load(f)
                if not isinstance(card, dict):
                    errs.append("%s: 根应为对象" % fn)
                    continue
                key = fn[:-5]  # 去 .json
                # 同名冲突: archive_docs 优先 (新存储为准, 直接覆盖旧文件同名条目)
                assets[key] = card
            except (OSError, ValueError) as e:
                errs.append("%s: 读取失败 %s" % (fn, e))
    return assets, "; ".join(errs)


def _h3_validate_card(name, card):
    """name/card 校验; 不通过 -> 返回 (None, 400响应); 通过 -> (clean_name, clean_card).
    批 K1: 清洗追加路径安全 — 替换 / \\ .. 为 _ (用于 archive_docs 文件名/dict key).
    批 A6 T1: 冒号 ':' 在 Windows 非法文件名, 含则直接 400 (拒绝比清洗更防路径逃逸).
    1.14 整改批 C C2: 卡名保存入口扩全禁字符集 [:*?"<>|] → 400 (拒绝型先例;
    路径分隔符 / \\ 不在 400 拒绝集, 仍走 _h3_safe_filename 兜底清洗);
    由 _h3_check_name_chars 统一执行, _h3_safe_filename (第 2 层) 仅兜底历史/内部名."""
    if not isinstance(name, str):
        return None, web.json_response(
            {"error": "name 必须为字符串"}, status=400)
    ok, err = _h3_check_name_chars(name, "name")
    if not ok:
        return None, err
    clean_name = name.strip()
    if not clean_name:
        return None, web.json_response(
            {"error": "卡名 (name) 不能为空"}, status=400)
    clean_name = _h3_safe_filename(clean_name)
    if not clean_name:
        return None, web.json_response(
            {"error": "卡名 (name) 不合法: 含路径分隔符或仅为特殊字符"}, status=400)
    if len(clean_name) > _H3_NAME_MAX:
        return None, web.json_response(
            {"error": "卡名 (name) 超过 %d 字符限制 (当前 %d)"
                       % (_H3_NAME_MAX, len(clean_name))},
            status=400)
    if not isinstance(card, dict):
        return None, web.json_response(
            {"error": "card 必须为对象或 null"}, status=400)
    if card.get("kind") not in _H3_KIND_ALLOWED:
        return None, web.json_response(
            {"error": "kind 必须是 character 或 scene, 当前: %r" % card.get("kind")},
            status=400)
    # T8 批1: v3 动态行档案校验 — 行级 (rows) 字段必须在 slots 校验之前拦截
    # (F4 位置硬约束; v3 卡无 slots 字段, 校验通过即早返, 不进入下游 v1/v2 校验;
    #  v1 / _v==2 老卡走原 slots 校验零回归 — 原校验源码逐字节不变)
    if card.get("_v") == 3:
        rows = card.get("rows")
        if not isinstance(rows, list):
            return None, web.json_response(
                {"error": "rows 必须为列表"}, status=400)
        if not rows:
            return None, web.json_response(
                {"error": "rows 不能为空列表"}, status=400)
        for _i, _row in enumerate(rows, start=1):
            if not isinstance(_row, dict):
                return None, web.json_response(
                    {"error": "rows[%d] 必须为对象" % _i}, status=400)
            _u = _row.get("usage")
            if _u not in KNOWN_USAGE_IDS:
                return None, web.json_response(
                    {"error": "rows[%d].usage 未知: %r" % (_i, _u)}, status=400)
            _kind = USAGE_REGISTRY.get(_u, {}).get("kind")
            _allowed = _V3_SLOT_RANGES.get(_kind)
            if _allowed is not None:
                _slot = _row.get("slot")
                if _slot not in _allowed:
                    return None, web.json_response(
                        {"error": "rows[%d].slot 必须是 %s 行 1-%d 字符串, 当前: %r"
                                   % (_i, _kind, max(int(s) for s in _allowed),
                                      _slot)},
                        status=400)
            if not isinstance(_row.get("media"), str):
                return None, web.json_response(
                    {"error": "rows[%d].media 必须为字符串" % _i}, status=400)
            if not isinstance(_row.get("desc"), str):
                return None, web.json_response(
                    {"error": "rows[%d].desc 必须为字符串" % _i}, status=400)
            # 1.11a 波 1 T1: ignore_words 校验 — 可选 str/限长 _H3_IGNORE_WORDS_MAX/缺省合法
            # 产句层 (T2) 仅 zh 路径消费; en/scene 暂不消费, 校验放行但预检 WARN (T2 实施)
            _ig = _row.get("ignore_words")
            if _ig is not None:
                if not isinstance(_ig, str):
                    return None, web.json_response(
                        {"error": "rows[%d].ignore_words 必须为字符串" % _i},
                        status=400)
                if len(_ig) > _H3_IGNORE_WORDS_MAX:
                    return None, web.json_response(
                        {"error": "rows[%d].ignore_words 超过 %d 字符限制 (当前 %d)"
                                   % (_i, _H3_IGNORE_WORDS_MAX, len(_ig))},
                        status=400)
        return clean_name, card
    slots = card.get("slots")
    if not isinstance(slots, dict):
        return None, web.json_response(
            {"error": "slots 必须为对象"}, status=400)
    for k_kind, kv in slots.items():
        if not isinstance(kv, dict):
            return None, web.json_response(
                {"error": "slots[%r] 必须为对象" % k_kind}, status=400)
        for slot_idx, slot_val in kv.items():
            if not isinstance(slot_val, str):
                return None, web.json_response(
                    {"error": "slots[%r][%r] 必须为字符串"
                               % (k_kind, slot_idx)}, status=400)
    # T3: v2 档案校验 (desc + slot_map); 无 _v 走原校验完全不变 (v1 兼容)
    if card.get("_v") == 2:
        desc = card.get("desc")
        if not isinstance(desc, dict):
            return None, web.json_response(
                {"error": "desc 必须为对象"}, status=400)
        for _dk in ("look", "outfit", "env"):
            if not isinstance(desc.get(_dk), str):
                return None, web.json_response(
                    {"error": "desc.%s 必须为字符串" % _dk}, status=400)
        slot_map = card.get("slot_map")
        if slot_map is not None:
            if not isinstance(slot_map, dict):
                return None, web.json_response(
                    {"error": "slot_map 必须为对象"}, status=400)
            for _sem, _slot in slot_map.items():
                if _slot not in _V2_SLOT_ALLOWED:
                    return None, web.json_response(
                        {"error": "slot_map[%r] 必须是 1-9 字符串, 当前: %r"
                                   % (_sem, _slot)}, status=400)
    return clean_name, card


def _h3_atomic_write(assets):
    """原子写: 已有文件先做 .bak 备份 (tmp + os.replace) 再写新内容; 写回内容顶层加 schema_version.
    损坏文件不允许走写入路径 (上游已拦截)."""
    p = _h3_assets_path()
    # T3 B1: 已有文件 → .bak 备份 (atomic: 读当前 → 写 tmp → os.replace)
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                _bak_src = f.read()
            bak_p = os.path.join(os.path.dirname(p), _H3_ASSETS_BAK)
            tmp_bak = bak_p + ".tmp"
            with open(tmp_bak, "w", encoding="utf-8") as f:
                f.write(_bak_src)
            os.replace(tmp_bak, bak_p)
        except OSError:
            pass  # 备份失败不阻塞主写
    # 写回内容顶层加 schema_version (B1: 只加顶层键, 卡字段原样)
    if isinstance(assets, dict):
        to_write = {"schema_version": _H3_ASSETS_SCHEMA}
        to_write.update(assets)
    else:
        to_write = assets
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(to_write, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def workflow_combo():
    """模板下拉: 有默认模板时加 "(默认) " 前缀项(与扫描结果去重); 空配置只剩扫描结果。"""
    opts = list_h3_templates()
    if DEFAULT_WORKFLOW:
        default_abs = _resolve_workflow_path(DEFAULT_WORKFLOW)
        opts = [o for o in opts
                if o != DEFAULT_WORKFLOW
                and os.path.normpath(_resolve_workflow_path(o)) != os.path.normpath(default_abs)]
        opts = ["(默认) " + DEFAULT_WORKFLOW] + opts
    return opts


def is_active():
    with _active_lock:
        return _active is not None and _active.is_alive()


# V1.11 批 1 T4: 节点 run + submit/rerun 端点共享的引擎构造器. params 键与 INPUT_TYPES
# 同名 (排除 rerun_folder/quick_data — v3 裁决: task_id 寻址取代 + generate_csv+submit
# 已覆盖); 缺省值与节点 INPUT_TYPES 默认完全一致.
# 放在 __init__.py 而非 batch_core.py: 函数 __globals__ = mod.__dict__, 既存测试
# (test_start_errors 等) patch mod.H3BatchEngine 即可拦截构造; 不必额外打 mod globals.
def build_engine_from_params(params):
    template_dir = _clean_path(params.get("template_dir"), H3_WORKFLOW_DIR) or H3_WORKFLOW_DIR
    workflow_path = _clean_path(params.get("workflow_path"), DEFAULT_WORKFLOW)
    csv_path = _clean_path(params.get("csv_path"))
    input_dir = _clean_path(params.get("input_dir"), _default_input_dir())
    server_input_dir = (_clean_path(params.get("server_input_dir"))
                        or folder_paths.get_input_directory())
    server_output_dir = (_clean_path(params.get("server_output_dir"))
                         or folder_paths.get_output_directory())
    # V1.12 批 L 波 1 批次 D T6: session_id 透传 — submit handler 已先校验 28hex;
    # 此处不重复校验 (空/缺省走"不写该键"路径, 旧任务零回归).
    # 1.13f: subject_anchors 透传 — 仅 type==str 时落位 (缺省/非 str = 不存该键 → 旧任务零回归).
    sa = params.get("subject_anchors")
    kwargs = {}
    if isinstance(sa, str):
        kwargs["subject_anchors"] = sa
    # 批 K 分镜级动态素材池: body 顶层键 seg_pools 与入参同名直通 (不重命名/不裁剪/
    # 不塞旁车)。缺省或空对象 → 不并池, 提交与渲染行为逐字节现行为。
    sp = params.get("seg_pools")
    if isinstance(sp, dict) and sp:
        kwargs["seg_pools"] = sp
    # 批 W1 S1-T3 (R-52 甲): run_subdir 透传 — GUI 指定运行子目录名 (如
    # myproj_20261010_2200 / 其 _R1). 非空 str 才落 kwargs; 缺省/空 = 引擎走
    # 时间戳目录 (逐字节现行为).
    rs = params.get("run_subdir")
    if isinstance(rs, str) and rs:
        kwargs["run_subdir"] = rs
    return H3BatchEngine(
        params.get("mode", "分镜"),
        _resolve_workflow_path(workflow_path, template_dir),
        csv_path,
        input_dir,
        server_output_dir,
        port=int(params.get("port", 0)),
        start_from=int(params.get("start_from", 0)),
        retries=int(params.get("retries", 2)),
        skip_done=bool(params.get("skip_done", True)),
        server_input_dir=server_input_dir,
        on_fail=params.get("on_fail", "阻断"),
        archive_dir=_clean_path(params.get("archive_dir")),
        resources_list=params.get("resources_list", "[]"),
        resource_overrides=params.get("resource_overrides", "{}"),
        lora_overrides=params.get("lora_overrides", "{}"),
        live_client_id=params.get("live_client_id", "") or "",
        session_id=params.get("session_id", "") or "",
        **kwargs,
    )


# 批 K rerun 族回灌助手: manifest 的 _seg_pools_raw (原始提交值, 与
# _resources_raw 同族) → 构造器 kwargs。六处硬编码重建点 (rerun / rerun_same_seed /
# rerun_edit_prompt / seg_edit / seg_candidates / candidate_decide) 统一经它回灌。
# 旧 manifest 无该 raw 键 / 非 dict / 空对象 → 返回 {} = 不回灌, rerun 行为与现状一致
# (含段池的任务 rerun 后段资产不丢, 老任务零炸)。
def _seg_pools_kwargs(manifest_data):
    sp = (manifest_data or {}).get("_seg_pools_raw")
    return {"seg_pools": sp} if isinstance(sp, dict) and sp else {}


# 1.14 整改批 I I1: 批入口专用构造器 — i2v/fl2v 全面废除 (老板令 D5, 统一 ref2v).
# 拒绝面钉在批入口 (节点 start / submit / rerun 家族), 不下沉到共享构造器
# build_engine_from_params: 画布三端点 (threepov/scene_canvas/item_canvas, threepov.py
# 直调共享构造器) 仍用 i2v 模板渲染静图, 必须照常放行.
# 判据/文案单一来源 = batch_core._retired_template_error (与引擎 preflight 同源).
def build_batch_engine_from_params(params):
    """批入口构造器: 模板属 i2v/fl2v 族 → ShotError (文案 "i2v/fl2v 已废除…"); 其余委派原构造器."""
    _tdir = _clean_path(params.get("template_dir"), H3_WORKFLOW_DIR) or H3_WORKFLOW_DIR
    _wf = _resolve_workflow_path(
        _clean_path(params.get("workflow_path"), DEFAULT_WORKFLOW), _tdir)
    _retired = batch_core._retired_template_error(_wf)
    if _retired:
        raise ShotError(_retired)
    return build_engine_from_params(params)


class H3ShotBatchRenderer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["分镜", "拼接", "自定义"], {"default": "分镜"}),
                "template_dir": ("STRING", {"default": H3_WORKFLOW_DIR, "tooltip": "模板扫描目录(可改, 刷新页面后下拉更新; 扫一级子文件夹和顶层 json)"}),
                "workflow_path": (workflow_combo(), {"default": DEFAULT_WORKFLOW}),
                "csv_path": ("STRING", {"default": ""}),
                "input_dir": ("STRING", {"default": _default_input_dir(), "tooltip": "本地素材目录(空=自动用 ComfyUI input 目录)"}),
                "server_input_dir": ("STRING", {"default": "", "tooltip": "服务器输入目录(空=自动用 ComfyUI input 目录)"}),
                "server_output_dir": ("STRING", {"default": "", "tooltip": "服务器输出目录(空=自动用 ComfyUI output 目录)"}),
                "port": ("INT", {"default": 0, "min": 0, "max": 65535, "tooltip": "0 = 自动探测 (8188-8200); 填具体端口则用指定值"}),
                "start_from": ("INT", {"default": 0, "min": 0}),
                "retries": ("INT", {"default": 2, "min": 0, "max": 10}),
                "skip_done": ("BOOLEAN", {"default": True}),
                "on_fail": (["阻断", "继续"], {"default": "阻断", "tooltip": "拼接模式段失败后: 阻断=后面不跑(强叙事推荐); 继续=跳过失败段接着跑(弱耦合流水线)。自定义模式下: 阻断=沿勾选链向后标 blocked（独立段不受影响）"}),
                "rerun_shot_id": ("STRING", {"default": "", "tooltip": "填分镜 ID 只重跑该段, 留空跑全部"}),
                "archive_dir": ("STRING", {"default": "", "tooltip": "归档目录: 批次跑完后把本次时间戳 run_dir 移到这里(manifest 路径同步更新); 留空 = 不归档"}),
                "rerun_folder": ("STRING", {"default": "", "tooltip": "重跑文件夹: 之前那组成果的时间戳文件夹, 重跑产物直接落回该文件夹(老文件改名保留); 重跑时必填"}),
                "repeat": ("INT", {"default": 1, "min": 1, "max": 50, "tooltip": "批次次数: 同一任务连跑 N 遍(每遍独立种子/时间戳文件夹/断点 manifest); 种子留空即每遍随机; 队列模式下不生效, 以清单行 repeat 为准"}),
                "queue_path": ("STRING", {"default": "", "tooltip": "队列清单 CSV(表头 csv_path,mode,repeat): 逐行串行跑多个任务; 填写后=队列模式(优先于 Quick/CSV); 与批次次数可叠加"}),
                # V1.9 T2.1: 资源编排列表(widget 持久化, ComfyUI 工作流保存即保留, 重启恢复)
                # 字段规约见 PRD §六 R1: {name, strength_model, strength_clip, order, source};
                # 引擎侧解析+规范化, 非法 JSON / 非法条目响亮报错(文案含"资源编排列表")
                "resources_list": ("STRING", {"default": "[]", "multiline": True, "tooltip": "资源编排列表(JSON 数组, 见 PRD R1): 每条 = {name, strength_model, strength_clip, order, source}; 紧凑 JSON 无多余空格; 单强度节点 strength_clip 写 null"}),
                # V1.9 T2.5: 资源覆写列表(widget 持久化) — 提交 API prompt 前对模板已有加载点 (UNETLoader/CLIPLoader/VAELoader)
                # 直接覆写 widget 值, 见 PRD §六 R2。键: {unet, clip, vae_video, vae_audio}; 缺省 = 不覆写。
                # 非法 JSON / 非对象 / 文件名类型错 → 引擎构造时响亮报错(文案含"资源覆写列表")。
                "resource_overrides": ("STRING", {"default": "{}", "multiline": True, "tooltip": "资源覆写列表(JSON 对象, 见 PRD R2): 键 ∈ {unet, clip, vae_video, vae_audio}, 值 = 文件名; 紧凑 JSON; 模板双 VAE 时按 nodes 顺序, 第 1 个 VAE=video, 第 2 个=audio; 模板 1 个 VAE 时 vae_video 覆盖, vae_audio 无效"}),
                # V1.9 T4.4b: 模板自带 LoRA 覆写列表(widget 持久化) — 提交 API prompt 前对模板自带
                # LoRA 节点强度值覆写/禁用(=0.0), 模板文件与节点结构零改动 (值覆写, R2 先例同款)。
                # 仅存被用户修改过的模板条目; 非法 JSON / 非对象 → 引擎构造时响亮报错(文案含"LoRA 覆写列表")。
                "lora_overrides": ("STRING", {"default": "{}", "multiline": True, "tooltip": "LoRA 覆写列表(JSON 对象, T4.4b): 键 = 模板自带 lora 文件名, 值 = {\"strength\": 0.7} 或 {\"disabled\": true}; 仅存被修改过的模板条目; 禁用 = 强度 0.0; 模板文件与节点结构零改动"}),
            },
            "optional": {
                "quick_data": ("STRING", {"default": "", "multiline": True, "tooltip": "Quick 输入模式: 连接 H3QuickShot 的 shots_json"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info",)
    FUNCTION = "start"
    CATEGORY = "H3/Batch"
    OUTPUT_NODE = True

    def start(self, mode, workflow_path=None, csv_path="", input_dir="", server_input_dir="", server_output_dir="", port=0,
              start_from=0, retries=2, skip_done=True, rerun_shot_id="", template_dir="", on_fail="阻断",
              quick_data="", archive_dir="", rerun_folder="", repeat=1, queue_path="", resources_list="", resource_overrides="{}", lora_overrides="{}"):
        global _active, _active_engine
        # V1.11 批 9 M-R4: 节点 start 端口钉死 — INPUT_TYPES 默认 port=0 走
        # _own_server_port() 注入本实例端口 (与 submit 路由 2095-2108 / rerun/quick
        # 四处先例 1355/1644/1791/1993 同款). 显式 port>0 仍尊重 (远程实例 /
        # 跨机调试场景). 节点共享构造行 build_engine_from_params (line 613) 不动
        # — 改它连带改所有调用方语义, 是批 5 红线.
        try:
            _port_in_int = int(port) if port not in (None, "") else 0
        except (TypeError, ValueError):
            _port_in_int = 0
        if not _port_in_int:
            port = _own_server_port()
        template_dir = _clean_path(template_dir, H3_WORKFLOW_DIR)
        workflow_path = _clean_path(workflow_path, DEFAULT_WORKFLOW)
        csv_path = _clean_path(csv_path)
        input_dir = _clean_path(input_dir, _default_input_dir())
        server_input_dir = _clean_path(server_input_dir) or folder_paths.get_input_directory()
        # F-N1 P0: 拦截 server_output_dir 与 ComfyUI 实际输出根不一致 — 留 _user_out 原值,
        # 校验后仍把 fallback 值赋给 server_output_dir (后续流程用), 用户原始意图值用于
        # 错误信息精准回显。
        _user_out = _clean_path(server_output_dir)
        server_output_dir = _user_out or folder_paths.get_output_directory()
        rerun_shot_id = _clean_path(rerun_shot_id)
        rerun_folder = _clean_path(rerun_folder)
        archive_dir = _clean_path(archive_dir)
        repeat = max(1, min(50, int(repeat)))
        queue_path = _clean_path(queue_path)
        if os.path.basename(os.path.normpath(server_output_dir)).lower() == "none":
            raise RuntimeError("输出目录异常: %s, 请用 📂 选择路径面板重设输出目录" % server_output_dir)
        # F-N1 P0 (节点路径): 用户显式传 server_output_dir 时必须等于实际输出根 — 同 submit
        # 端点语义; 错误消息与端点对齐, 文案含双路径 + "实际输出根".
        if _user_out:
            _real_out = folder_paths.get_output_directory()
            if os.path.normcase(os.path.abspath(_user_out)) != os.path.normcase(os.path.abspath(_real_out)):
                raise RuntimeError(
                    "server_output_dir 与 ComfyUI 实际输出根不一致: 您填的=%s, 实际输出根=%s。"
                    "请改为实际输出根或留空（留空自动使用实际输出根）"
                    % (_user_out, _real_out))
        workflow_path = _resolve_workflow_path(workflow_path, template_dir or H3_WORKFLOW_DIR)
        # 触发时刻捕获浏览器 sid — ComfyUI 把 execution 事件按 server.client_id 路由, 默认 "h3-batch" 没人监听,
        # 进度条收不到。触发者身份 (PromptServer.instance.client_id) 此时就是当前请求的 WS sid。
        client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        # 模式自动判定: 重跑 > 队列 > Quick > 普通 CSV
        rerun_mode = bool(rerun_shot_id)
        queue_mode = bool(queue_path) and not rerun_mode
        if rerun_mode and not rerun_folder:
            raise RuntimeError("重跑模式: 已填 rerun_shot_id=%s, 还需指定重跑文件夹 rerun_folder" % rerun_shot_id)
        if (quick_data or "").strip() and not queue_mode and not rerun_mode:
            if not os.path.isdir(input_dir):
                raise RuntimeError("输入目录不存在: %s" % input_dir)
            shots, g = quick_payload(quick_data)
            data = quick_data_to_csv_data(shots, g)
            if not data["shots"]:
                raise RuntimeError("Quick 输入模式: 没有可用的镜头")
            fp = hashlib.sha256(quick_data.encode("utf-8")).hexdigest()[:8]
            csv_path = os.path.join(input_dir, "_quick_%s.csv" % fp)
            with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
                f.write(build_csv(mode, data))
        if not queue_mode and not os.path.exists(csv_path):
            raise RuntimeError("CSV 不存在: %s" % csv_path)
        if not os.path.exists(workflow_path):
            raise RuntimeError("工作流不存在: %s" % workflow_path)
        if not os.path.isdir(input_dir):
            raise RuntimeError("输入目录不存在: %s" % input_dir)
        if not os.path.isdir(server_input_dir):
            raise RuntimeError("服务器输入目录不存在: %s" % server_input_dir)
        if queue_mode:
            print("[H3Batch] 队列模式: 节点 repeat 不生效, 以清单行 repeat 为准", flush=True)
            if not os.path.exists(queue_path):
                raise RuntimeError("队列清单不存在: %s" % queue_path)
            try:
                tasks = parse_queue_file(queue_path)
            except OSError as e:
                raise RuntimeError("队列清单读取失败: %s (%s)" % (queue_path, e))
            if not tasks:
                raise RuntimeError("队列清单里没有可用任务行: %s" % queue_path)
            progress_path = os.path.join(
                os.path.dirname(os.path.abspath(queue_path)),
                os.path.splitext(os.path.basename(queue_path))[0] + "_progress.json")

            def queue_make_engine(task, rep, suffix):
                return H3BatchEngine(
                    task["mode"], workflow_path, task["csv_path"], input_dir, server_output_dir,
                    port=port, start_from=start_from, retries=retries, skip_done=skip_done,
                    server_input_dir=server_input_dir, on_fail=on_fail, archive_dir=archive_dir,
                    manifest_suffix=suffix, client_id=client_id,
                    resources_list=resources_list,
                    resource_overrides=resource_overrides,
                    lora_overrides=lora_overrides,
                )

            with _active_lock:
                if _active is not None and _active.is_alive():
                    # V1.7 R13: 把当前 phase 一并暴露给用户 — 用户在拼接 / 归档 / 清点阶段被拦时,
                    # 知道在等什么, 不再黑箱 (实测: 用户曾被拦 2 分钟不知原因)。
                    _phase = getattr(_active_engine, "phase", "") or "跑批中"
                    raise RuntimeError("已有批量任务在后台运行(当前: %s), 请稍候或先 cancel" % _phase)
                _active_engine = None  # 队列模式: cancel 只能中断当前段; 多段新建独立 engine
                _active = threading.Thread(
                    target=_safe_queue, args=(tasks, queue_make_engine, progress_path), daemon=True)
                _active.start()
            return ("后台队列已启动: %d 个任务(断点: %s)\n进度看控制台 [H3Batch] 日志"
                    % (len(tasks), progress_path),)
        with _active_lock:
            if _active is not None and _active.is_alive():
                # V1.7 R13: 同上, 把 phase 暴露 (持锁期间一并快照, 防 _active_engine 被并发清空后崩溃)
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                raise RuntimeError("已有批量任务在后台运行(当前: %s), 请稍候或先 cancel" % _phase)
            # V1.11 fix2 (fix5): 节点 run 与 submit 同款守卫 — 同 output_dir 收尾在跑 → 409
            # (新批 vs 后台收尾 (搬运/拼接) 撞车; 不同 output_dir 放行)。 写在与 active
            # 同一锁内 (持锁检查, 短临界区), 不破坏 with 缩进/原代码位置。
            try:
                _req_out = os.path.normcase(os.path.abspath(
                    _clean_path(server_output_dir, folder_paths.get_output_directory())))
                with _finalize_lock:
                    if _finalizing.get(_req_out):
                        raise RuntimeError("上一批正在收尾(搬运/拼接), 请稍候或先 cancel (output_dir=%s)" % _req_out)
            except RuntimeError:
                raise
            except Exception:
                pass

            # V1.11 批 1 T4: 节点 run + submit 端点共享构造路径 build_engine_from_params;
            # 单一 dict 在闭包内只造一次, suffix 后补到引擎 (run_dir/_new_run_dir 前需先指好 manifest_path).
            _input_types_params = {
                "mode": mode, "template_dir": template_dir,
                "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": input_dir, "server_input_dir": server_input_dir,
                "server_output_dir": server_output_dir,
                "port": port, "start_from": start_from, "retries": retries,
                "skip_done": skip_done, "on_fail": on_fail,
                "rerun_shot_id": rerun_shot_id, "archive_dir": archive_dir,
                "repeat": repeat, "queue_path": queue_path,
                "resources_list": resources_list,
                "resource_overrides": resource_overrides,
                "lora_overrides": lora_overrides,
            }

            def make_engine(suffix):
                eng = build_batch_engine_from_params(_input_types_params)
                eng.client_id = client_id
                if suffix:
                    eng.manifest_suffix = suffix
                    # repeat 每遍需独立 manifest 文件名 — 用 _input_types_params 内的
                    # 路径 (不依赖 eng.output_dir / eng.csv_path 属性, 让桩 engine
                    # 不必必设自属性也能跑; 既存测试 test_mode_unify 的 _StubEngine
                    # 只设 csv_path, 不设 output_dir/manifest_path).
                    _out_dir = _clean_path(_input_types_params.get("server_output_dir"),
                                           folder_paths.get_output_directory())
                    _csvp = _clean_path(_input_types_params.get("csv_path"))
                    # V1.13 D1: CSV 基名清洗 (空格/点→`_`), 否则 basename 内含非法字符
                    _stem = batch_core._sanitize_stem(
                        os.path.splitext(os.path.basename(_csvp))[0])
                    # D1: 同 output_dir 内已存在撞名 manifest → 显式报错 (提示 rename)
                    _clobber = batch_core._check_stem_clobber(_stem + suffix, _out_dir)
                    if _clobber:
                        raise RuntimeError(_clobber)
                    eng.manifest_path = os.path.join(
                        _out_dir, "h3_batch_manifest_%s%s.json" % (_stem, suffix))
                return eng

            # 首遍预检同步反馈; 后台逐遍各建独立引擎(独立 manifest/种子)
            probe = make_engine("" if repeat == 1 else "_rep1")
            errs = probe.preflight()
            if errs:
                raise RuntimeError("预检未通过:\n" + "\n".join(errs))
            warns = getattr(probe, "_preflight_warns", [])
            warning_info = "\n警告:\n" + "\n".join(warns) if warns else ""
            if rerun_mode:
                reng = make_engine("")  # 重跑: 单实例, 直接发布供 cancel 链路
                _active_engine = reng
                _active = threading.Thread(target=_rerun, args=(reng, rerun_shot_id, rerun_folder), daemon=True)
                _active.start()
                return ("后台重跑已启动: %s (文件夹锚定: %s)\n进度看控制台 [H3Batch] 日志%s"
                        % (rerun_shot_id, rerun_folder, warning_info),)
            notice = ""
            csv_repeat = probe._parse_global(probe._parse_rows()).get("批次次数", "")
            if csv_repeat.strip() and csv_repeat.strip() != str(repeat):
                notice = "CSV 批次次数=%s 与节点 repeat=%d 不符, 按节点 %d 跑" % (csv_repeat.strip(), repeat, repeat)
                print("[H3Batch] " + notice, flush=True)
            # 普通/repeat 模式: _active_engine 不再预发 probe(probe 仅做预检不干活),
            # 真正的跑批引擎由 _safe_repeats 内的 wrapped 在 make_engine 后逐遍发布,
            # 保证 cancel 端点 eng = 真跑批引擎(非 probe)。
            _active = threading.Thread(target=_safe_repeats, args=(make_engine, repeat), daemon=True)
            _active.start()
        return ("后台批量已启动 [%s 模式]: %s%s%s\n进度看控制台 [H3Batch] 日志%s"
                % (mode, csv_path, "" if repeat == 1 else " x%d 遍" % repeat,
                   "\n提示: " + notice if notice else "", warning_info),)


def _safe_repeats(make_engine, repeat):
    # T7: 包一层 make_engine 把每遍真正干活的引擎发布到 _active_engine,
    # cancel 端点才能拿到跑批引擎(非 probe) set _stop。
    def wrapped(suffix):
        eng = make_engine(suffix)
        global _active_engine
        with _active_lock:
            _active_engine = eng
        return eng
    try:
        run_repeats(wrapped, repeat)
    except Exception:
        print("[H3Batch] 后台任务异常: %s" % traceback.format_exc(), flush=True)
    finally:
        _clear_active()


def _safe_queue(tasks, make_engine, progress_path):
    # T7: 同上, 把每批每遍新造的引擎发布到 _active_engine。
    def wrapped(task, rep, suffix):
        eng = make_engine(task, rep, suffix)
        # V1.10 批2 T3: 队列模式禁用审片门 — 引擎构造后立即强制 _review_every_n=0
        # (队列多任务独立引擎, 不可能停在审片门等裁决, 跨任务无 continue 语义).
        # 仅当原值 >0 (CSV 给了非零) 才打印警告, 0=关的批次不污染日志.
        if getattr(eng, "_review_every_n", 0) > 0:
            print("[H3Batch] 队列模式不支持审片门, 已忽略", flush=True)
        eng._review_every_n = 0
        global _active_engine
        with _active_lock:
            _active_engine = eng
        return eng
    try:
        run_queue(tasks, wrapped, progress_path)
    except Exception:
        print("[H3Batch] 后台队列异常: %s" % traceback.format_exc(), flush=True)
    finally:
        _clear_active()


def _rerun(engine, sid, folder):
    try:
        ok, files, err = engine.rerun_shot_in_folder(folder, sid)
        if ok:
            print("[H3Batch] 重跑 %s 完成: %s" % (sid, files), flush=True)
        else:
            print("[H3Batch] 重跑 %s 失败: %s" % (sid, err), flush=True)
    except Exception:
        print("[H3Batch] 后台任务异常: %s" % traceback.format_exc(), flush=True)
    finally:
        _clear_active()


def _clear_active():
    """引擎退出 (正常/异常) 后释放 _active 引用, 让 start() 下次守卫直接通过。
    仅 _active 当前线程本身 (即持有者) 才清; 避免 finally 段线程尚 alive 时
    'not is_alive()' 永不命中导致死引用残留 (review/resume 状态查询读到旧任
    务), 同时避免非持有者误调覆盖并发新任务的标记."""
    global _active, _active_engine
    with _active_lock:
        if _active is threading.current_thread():
            _active = None
            _active_engine = None


def _append_reruns_ledger(manifest_path, sids_sorted, results, *,
                          reason="manual", params=None, prompt_edited=False,
                          res_changed=False, candidates_group=None):
    """V1.11 批 1 T3: 端点侧追加 _reruns ledger, 走 _manifest_write (per-path 锁内原子写).

    V1.11 批 3 T1: 增 params/prompt_edited/res_changed 三个字段 —
      params={比例,质量,步数} (实际生效值, 无覆写 = 三 null);
      prompt_edited=true (改词重跑标记, 不存全文);
      res_changed=true (改分辨率触发降级锚, _reruns 跳过末次重拼).
    V1.13h 第四波: candidates_group (候选组关联, 加性默认 None = 不写该键, 既有
      调用方零变); 返回本次追加条目的 seq (int) — 调用方 (seg_candidates) 用它填组
      终态 seqs; 未写入 (无成功产物 / 写盘失败) → None.
    V1.13k T2: entry 加 `run_dir` = dirname(abspath(manifest_path)) 绝对路径 —
      #17 history/detail 响应透传; 调用点 (rerun/same_seed/prompt_edit/seg_edit/
      candidates/inpaint) 全部 manifest 与产物同目录, 内部推导零新参数零调用方改.
    写入失败不抛 (主流程已完成, 留痕尽力); 缺 successful files 直接返 (引擎未产出).
    """
    if not isinstance(results, dict):
        return None
    successful_files = {}
    seeds_used = results.get("_seeds", {}) if isinstance(results.get("_seeds"), dict) else {}
    for sid, val in results.items():
        if not isinstance(sid, str) or sid.startswith("_"):
            continue
        if not isinstance(val, tuple) or len(val) != 3:
            continue
        ok, files, err = val
        if ok and files:
            successful_files[sid] = files[0]
    if not successful_files:
        return None
    sorted_sids = H3BatchEngine._sort_numeric_sids(
        [s for s in sids_sorted if s in successful_files])
    _appended = {}

    def _mut(existing):
        if not isinstance(existing, dict) or not existing:
            return None
        existing.setdefault("_reruns", [])
        seq = len(existing["_reruns"]) + 1
        _params = params if isinstance(params, dict) else {
            "比例": None, "质量": None, "步数": None,
        }
        entry = {
            "seq": seq,
            "time": time.time(),
            "sids": list(sorted_sids),
            "files": {sid: successful_files[sid] for sid in sorted_sids},
            "seeds": {sid: seeds_used.get(sid) for sid in sorted_sids},
            "reason": reason,
            "params": _params,
            "prompt_edited": bool(prompt_edited),
            "res_changed": bool(res_changed),
            "run_dir": os.path.dirname(os.path.abspath(manifest_path)),
        }
        if candidates_group:
            entry["candidates_group"] = candidates_group
        existing["_reruns"].append(entry)
        _appended["seq"] = seq
        return existing
    try:
        _manifest_write(manifest_path, _mut)
    except OSError as e:
        print("[H3Batch] _reruns ledger 写入失败: %s" % e, flush=True)
    return _appended.get("seq")


_LIPSYNC_PROMPT_TMPL = (
    "与参考图和参考视频完全相同的同一位人物（同一张脸、完全一致的五官、相同肤色妆容、相同发型与服装），"
    "%s面部清晰精致、说话与 <Audio 1> 完全同步：自然的面部动作与精确的唇形。"
    "画面构图、场景与色调与参考视频完全一致。"
)


def _lipsync_prompt_wrap(user_text):
    """V1.13h 第二波修正: 段二提示词必须带身份锚定句 + <Audio 1> 同步句式 (F2 真机验证的关键,
    裸透传用户画质文本会丢口型锚定并致身份漂移 — T5 round3 老板审"几乎没口型+人物变外国人"实证)."""
    q = (user_text or "").strip().rstrip("。，；;.,！!？? \t")
    return _LIPSYNC_PROMPT_TMPL % ((q + "，") if q else "")


def _rerun_lipsync_stage2(eng, *, task_id, sid, folder, stage1_abs, origin_video_rel,
                          server_input_dir, prompt_text, seed):
    """V1.13h 第二波 T3: 两段式管线段二 = 备材 → Ref2VA 口型回锚 → 色彩对齐.

    返回终版 basename 列表 (1 项); 任一环节失败抛 ShotError (调用方降级记段一产物).
    素材 (原声 wav / 段一产物中尾帧 / 段一产物全片) 全部入 server input 后组装提交 —
    等待/收集复用段一同款机制 (_wait_shot + _collect_output_retry).

    origin_video_rel: **请求时**入仓的原段拷贝 basename (`inpaint_<task>_<sid>_src_<ts>.mp4`).
    原声/色对齐基准必须用它: 重跑已精修段时 `manifest[sid].files[0]` 与段一产物同路径,
    走 `_keep_old` 后即失效 (真机 T5 首轮实证), 入仓拷贝永不被改名.
    """
    meta = _probe_video_meta(stage1_abs)
    _ts = int(time.time())
    _pfx = "lipsync_%s_%s" % (task_id, sid)
    origin_abs = os.path.join(server_input_dir, origin_video_rel)
    if not os.path.exists(origin_abs):
        raise ShotError("原段入仓拷贝缺失: %s" % origin_abs)
    wav_base = "%s_audio_%d.wav" % (_pfx, _ts)
    _extract_audio_wav(origin_abs, os.path.join(server_input_dir, wav_base))
    fpaths = _extract_frames(stage1_abs, [int(meta["frames"]) // 2, -1],
                             os.path.join(server_input_dir, "%s_ref_%d" % (_pfx, _ts)))
    ref_bases = [os.path.basename(p) for p in fpaths]
    refvideo_base = "%s_refvideo_%d%s" % (
        _pfx, _ts, os.path.splitext(stage1_abs)[1] or ".mp4")
    shutil.copy2(stage1_abs, os.path.join(server_input_dir, refvideo_base))
    ls_prompt, ls_report = eng._rerun_lipsync_assemble_prompt(
        ref_video_rel=refvideo_base, ref_image_rels=ref_bases,
        drive_audio_rel=wav_base, prompt_text=_lipsync_prompt_wrap(prompt_text),
        width=meta["width"], height=meta["height"], length=meta["frames"],
        seed=int(seed or 0), filename_prefix="video/shots/%s_lipsync" % sid)
    if not ls_report.get("assembled"):
        raise ShotError("段二组装失败: %s" % ls_report.get("reason"))
    resp = eng._post("/prompt", eng._build_prompt_body(ls_prompt))
    if "prompt_id" not in resp:
        raise ShotError("段二提交被拒: %s" % json.dumps(resp, ensure_ascii=False)[:200])
    status, files2 = eng._wait_shot(resp["prompt_id"])
    if status != "success":
        raise ShotError("段二渲染 status=%s" % status)
    moved = eng._collect_output_retry(files2, sid, max_wait=5.0)
    if not moved:
        raise ShotError("段二产物未落盘")
    stage2_abs = os.path.join(folder, moved[0])
    # 色彩对齐: 原段 (入仓拷贝) vs 段二产物饱和度均值比, 偏差 <5% 跳过 —
    # 必须在 _keep_old 之前做 (段二产物仍是现行件).
    # 增强项失败不降级 (api.md 契约): 探测/对齐任一 ShotError → 保留段二原产物为终版,
    # 不得落入段二失败分支丢弃已渲染产物 (节点门返工项①).
    try:
        ratio = _saturation_ratio(origin_abs, stage2_abs)
    except ShotError as e:
        print("[H3Batch] 精修色对齐探测失败, 保留段二原产物: %s" % e, flush=True)
        ratio = None
    if ratio is None or abs(ratio - 1.0) < LIPSYNC_COLOR_SKIP_TOL:
        eng._keep_old(stage1_abs)
        return [moved[0]]
    aligned = "%s_lipsync_aligned_%d_.mp4" % (sid, _ts)
    try:
        _hue_align_video(stage2_abs, ratio, os.path.join(folder, aligned))
    except ShotError as e:
        print("[H3Batch] 精修色对齐执行失败, 保留段二原产物: %s" % e, flush=True)
        eng._keep_old(stage1_abs)
        return [moved[0]]
    # 段二未对齐件与段一中间产物依次留档 (_old_NN); 对齐件为现行终版
    eng._keep_old(stage2_abs)
    eng._keep_old(stage1_abs)
    return [aligned]


NODE_CLASS_MAPPINGS = {
    "H3ShotBatchRenderer": H3ShotBatchRenderer,
    "H3QuickShot": H3QuickShot,
}
NODE_CLASS_MAPPINGS.update(motion_context_sub.NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3ShotBatchRenderer": "H3 Shot Batch Renderer",
    "H3QuickShot": "H3 Quick Shot",
}
NODE_DISPLAY_NAME_MAPPINGS.update(motion_context_sub.NODE_DISPLAY_NAME_MAPPINGS)

WEB_DIRECTORY = "./web"


def _merge_postfx_result(prev, cur):
    """W9R-③: 端点 _postfx 记账合并 (单一落点, 复跑不抹上一轮).

    背景: 端点原实现 `_data["_postfx"] = result` 整段覆盖 — 带 `sids` 定向复跑会把
    上一轮其它段的映射与 level/status 一并抹掉 (节点门挂账③)。
    语义:
      - upscale/interp: **按 kind 合并** — 上一轮映射为底, 本轮同 sid 覆盖; 本轮未产出的
        sid 保留上一轮条目 (产物文件仍在盘上, 账目如实);
      - failed/skipped/fallback/level/status/final_parts (及 template_missing): 整体按
        **本轮结果**重算 (以 cur 为底), 不留上一轮陈迹 (level/status 由调用方在合并
        结果上按本轮 items 重算; final_parts 自 #26 T1 起仅本次 items 覆盖全部
        success 段才重写, 部分段调用由调用方保留上一轮原值)。
    """
    merged = dict(cur) if isinstance(cur, dict) else {}
    prev = prev if isinstance(prev, dict) else {}
    for kind in ("upscale", "interp"):
        old = prev.get(kind)
        new = merged.get(kind)
        if isinstance(old, dict):
            m = dict(old)
            m.update(new if isinstance(new, dict) else {})
            merged[kind] = m
    return merged


def _build_postfx_templates(eng, kinds, engine_choice, task_folder):
    """U4a T6: 模板查找 + eng.convert() → API prompt dict (postfx 端点与 #26 T2 拼接
    补跑共用单一落点; convert 内部自请求 /object_info — 调用方须在工作线程调用)。

    逐 kind 找模板文件 (仓内 docs/证据-1.14b → 仓根 → task_folder → cwd); convert
    失败 → 跳过该 kind (U6: UI 形态不可提交, 与 _run_postfx_pipeline 同语义);
    所请求 kind 的模板文件缺 → 返回 (built, 缺失文件名)。全部就绪 → (built, None)。
    """
    import postfx_engine as _pe
    built = {}
    for k in ("upscale", "interp"):
        if k not in kinds:
            continue
        # E1: 文件名由引擎选择映射 (单一落点); 候选目录顺序不变
        fname = _pe.template_names(k, engine_choice)
        found = False
        for cand in (
            os.path.join(os.path.dirname(__file__), "docs", "证据-1.14b",
                         "templates", fname),
            os.path.join(os.path.dirname(__file__), fname),
            os.path.join(task_folder, fname),
            os.path.join(os.getcwd(), fname),
        ):
            if os.path.isfile(cand):
                found = True
                _pe.log_template(cand)
                with open(cand, encoding="utf-8") as f:
                    tpl_prompt = json.loads(json.dumps(json.load(f)))
                # 1.14b 真机前置修复: eng.convert() 依赖 eng.workflow_path ——
                # 临时换到 cand, convert() 后还原. 同时 swap convert() 改写的
                # 实例属性 (状态污染防护: _template/_links/_nodes/_next_nid/
                # _prompt/_override_report/_lora_override_report/
                # _inject_report/port/base).
                orig_wf = eng.workflow_path
                orig_template = getattr(eng, "_template", None)
                orig_links = getattr(eng, "_links", None)
                orig_nodes = getattr(eng, "_nodes", None)
                orig_next_nid = getattr(eng, "_next_nid", None)
                orig_prompt = getattr(eng, "_prompt", None)
                orig_override = getattr(eng, "_override_report", None)
                orig_lora = getattr(eng, "_lora_override_report", None)
                orig_inject = getattr(eng, "_inject_report", None)
                orig_port = getattr(eng, "port", None)
                orig_base = getattr(eng, "base", None)
                try:
                    eng.workflow_path = cand
                    api_prompt = eng.convert(seed=0)
                    built[k] = api_prompt
                except Exception as ex:
                    # U6 修正: UI 形态 tpl_prompt 不能提交 /prompt (缺 API dict
                    # 结构, assemble 也会拒收) — convert 失败即跳过该 kind, 与
                    # _run_postfx_pipeline 同语义; 原 tpl_prompt 兜底已删。
                    print("[H3Batch] postfx %s 模板 convert 失败, 跳过该 kind: %s" % (k, ex),
                          flush=True)
                finally:
                    eng.workflow_path = orig_wf
                    eng._template = orig_template
                    eng._links = orig_links
                    eng._nodes = orig_nodes
                    eng._next_nid = orig_next_nid
                    eng._prompt = orig_prompt
                    eng._override_report = orig_override
                    eng._lora_override_report = orig_lora
                    eng._inject_report = orig_inject
                    eng.port = orig_port
                    eng.base = orig_base
                break
        if not found:
            # E3: 所请求 kind 的模板缺 → 400 (严禁静默换引擎)
            return built, fname
    return built, None


def _write_postfx_result(existing, result, kinds, upscale_params, interp_params,
                         engine_choice, task_folder, items):
    """_manifest_write mutator: 本轮 postfx 结果落 manifest._postfx (postfx 端点与
    #26 T2 拼接补跑共用单一落点)。

    合并语义见 _merge_postfx_result docstring (upscale/interp 按 kind 合并, 复跑不抹
    其它段; failed/skipped/fallback/level/status 按本轮重算); params 留痕按本次参数
    逐次覆盖 (#26 T1); final_parts 仅本次 items 覆盖 manifest 全部 success 段才重写
    (#26 T1 卫生修, 判据取 _manifest_write 锁内 existing 快照, 部分段调用保留原值)。
    """
    import postfx_engine as _pe
    if not isinstance(existing, dict):
        return None
    _prev_pf = existing.get("_postfx")
    existing["_postfx"] = _merge_postfx_result(_prev_pf, result)
    _pf = existing["_postfx"]
    # #26 T1: 参数留痕 — 本次参数逐次覆盖, 供拼接端点补跑失效段取参
    _pf["params"] = {"kinds": list(kinds),
                     "upscale_params": upscale_params,
                     "interp_params": interp_params,
                     "engine_choice": engine_choice}
    # Y2 分级回退
    failed = result.get("failed", {})
    if any(v == "interp" for v in failed.values()):
        _pf["fallback"] = "interp_to_upscale"
    elif any(v == "upscale" for v in failed.values()):
        _pf["fallback"] = "upscale_to_original"
    # E4.3⑤: 层级选择 (单一落点) + final_parts 路径列表
    _lvl, _fparts, _ws = _pe.pick_level(
        [(it["sid"], it["path"]) for it in items], _pf, task_folder)
    for _w in _ws:
        print("[H3Batch] " + _w, flush=True)
    _pf["level"] = _lvl or "none"
    _pf["status"] = "failed" if _lvl is None else "success"
    _succ = {k for k, v in existing.items()
             if k not in _RESERVED_KEYS and isinstance(v, dict)
             and v.get("status") == "success"}
    if _succ <= {it["sid"] for it in items}:
        _pf["final_parts"] = list(_fparts)
    elif isinstance(_prev_pf, dict) and "final_parts" in _prev_pf:
        _pf["final_parts"] = list(_prev_pf["final_parts"])
    return existing


def _concat_rerun_stale_postfx(mp, data, map_sids, output_dir, task_id):
    """#26 T2 裁决②: 拼接前自查失效段并补跑后期 (任何拼接触发源一处收口)。

    自查三条件 (任一不满足 → (None, None), 拼接路径与现状逐比特一致):
      ① manifest._postfx 有 upscale/interp 映射 (曾跑过后期);
      ② _postfx.params 留痕存在且 kinds 可用 (#26 T1 落痕; 旧任务无留痕 / CSV 后期
        通路整替抹痕 → 只拼不补, 不猜参数);
      ③ map 中存在 sid 不在 _postfx[kind] 映射 (kind 取留痕 kinds) — 重跑成功后引擎
        删该段戳键, 即失效段。
    命中 → 置 _postfx_running 互斥 + 填 _postfx_progress (补跑段 postfx_status 可见;
    try/finally 清除, 对齐 _do_postfx 先例 — 异常路径也清, 防 9 个写端点永久 409)
    → 用留痕参数补跑失效段 (parse_upscale_params/parse_interp_params/plan_from_flags/
    run_postfx_batch + _write_postfx_result 合并落账), 成功后**重读 manifest** 返回新
    _postfx (调用方 pick_level 消费 — 入口快照不含补跑产物, 不重读则补跑白补)。
    补跑失败/异常/占线让行 → (None, 失败原因): 不阻塞拼接, 该段按现状回落原件,
    调用方落账告警。
    """
    pf = data.get("_postfx") if isinstance(data, dict) else None
    if not isinstance(pf, dict):
        return None, None
    if not any(isinstance(pf.get(k), dict) and pf[k] for k in ("upscale", "interp")):
        return None, None          # ① 曾跑过后期
    params = pf.get("params")
    if not isinstance(params, dict) or not isinstance(params.get("kinds"), list):
        return None, None          # ② 留痕
    kinds = [k for k in params["kinds"] if k in ("upscale", "interp")]
    if not kinds:
        return None, None
    stale = [sid for sid in map_sids
             if any(not (isinstance(pf.get(k), dict) and pf[k].get(sid))
                    for k in kinds)]
    if not stale:
        return None, None          # ③ 失效段
    import postfx_engine as _pe
    engine_choice = params.get("engine_choice") or "seedvr2"
    try:
        upscale_params = _pe.parse_upscale_params(params.get("upscale_params"),
                                                  engine_choice)
        interp_params = _pe.parse_interp_params(params.get("interp_params"))
    except ValueError as ex:
        return None, "postfx_rerun_failed: 留痕参数非法 %s" % ex
    task_folder = os.path.dirname(os.path.abspath(mp))
    items = []
    for sid in stale:
        seg = data.get(sid) if isinstance(data, dict) else None
        files = (seg or {}).get("files") or []
        if not files:
            continue
        f = files[0]
        rd = (seg or {}).get("run_dir") or task_folder
        if not os.path.isabs(f):
            f = os.path.normpath(os.path.join(rd, f))
        items.append({"sid": sid, "path": f, "name": os.path.basename(f),
                      "meta": _pe.probe_media_meta(f, ffprobe_exe=_h3_ffprobe_exe()) or {}})
    if not items:
        return None, "postfx_rerun_failed: 失效段缺产物文件 %s" % (stale,)
    global _postfx_running, _postfx_progress
    with _postfx_lock:
        if _postfx_running:
            return None, "postfx_rerun_failed: 后处理运行中, 补跑让行 (该段回落原件)"
        _postfx_running = True
        _postfx_progress = {"task_id": task_id, "kinds": list(kinds),
                            "total": 0, "time_start": time.time()}
    try:
        print("[H3Batch] 拼接补跑失效段: %s (kinds=%s)" % (stale, kinds), flush=True)
        try:
            eng = build_engine_from_params({
                "mode": "拼接",
                "workflow_path": "",
                "csv_path": "",
                "input_dir": folder_paths.get_input_directory(),
                "server_input_dir": folder_paths.get_input_directory(),
                "server_output_dir": output_dir,
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": "[]", "resource_overrides": "{}", "lora_overrides": "{}",
            })
        except ShotError as e:
            return None, "postfx_rerun_failed: engine_init %s" % e
        eng.manifest_path = mp
        eng.run_dir = task_folder
        eng._bgm_path = ""
        eng._bgm_mix_mode = "replace"
        tpl, tpl_missing = _build_postfx_templates(eng, kinds, engine_choice, task_folder)
        if tpl_missing:
            return None, "postfx_rerun_failed: template_missing %s" % tpl_missing
        if not tpl:
            return None, "postfx_rerun_failed: 模板 convert 全失败, 该段回落原件"
        plan = _pe.plan_from_flags(
            upscale="upscale" in kinds,
            interp="interp" in kinds,
            engine_choice=engine_choice,
            timeout_s=14400,
            seg_threshold=None,
            upscale_params=upscale_params,
            interp_params=interp_params,
        )
        with _postfx_lock:
            if isinstance(_postfx_progress, dict):
                _postfx_progress["total"] = len(items) * sum(1 for k in kinds if k in tpl)
        result = _pe.run_postfx_batch(
            eng, items, plan, tpl,
            run_dir=task_folder,
            upscaled_dir="upscaled", interp_dir="interp",
        )
        _manifest_write(mp, lambda existing: _write_postfx_result(
            existing, result, kinds, upscale_params, interp_params,
            engine_choice, task_folder, items))
        # 审核阻断项 1: 重读 manifest 取新 _postfx — 入口快照不含补跑产物
        fresh, _deg = read_manifest_safe(mp)
        if not isinstance(fresh, dict) or not isinstance(fresh.get("_postfx"), dict):
            return None, "postfx_rerun_failed: 补跑后 manifest 不可读"
        rfailed = result.get("failed") or {}
        if rfailed:
            return fresh["_postfx"], ("postfx_rerun_failed: 部分段补跑失败 %s "
                                      "(该段回落原件)" % rfailed)
        return fresh["_postfx"], None
    except Exception:
        return None, "postfx_rerun_failed: %s" % traceback.format_exc()[-300:]
    finally:
        with _postfx_lock:
            _postfx_running = False
            _postfx_progress = None


# 批 0 任务 0.2: GUI 1.0 静态挂载路由 (/h3_gui/) — 不依赖 web.static (no-cache + SPA 兜底)
# 行为契约: 四场景响应 (A5/A6/A7/A8) — 200 index, 403 穿越, 503 缺目录, 200 SPA 兜底.
def _register_gui_routes():
    server_pkg = server.PromptServer.instance
    routes = server_pkg.routes
    # realpath: 节点方案经 custom_nodes 软链加载, __file__ 是软链路径而非源路径,
    # 不解析会走到 ComfyUI/GUI1.0/app (不存在). 两级向上到节点方案/ + GUI1.0/app.
    gui_root = os.path.normpath(os.path.join(
        os.path.dirname(os.path.realpath(__file__)), "..", "..", "GUI1.0", "app"))
    # 两级向上: ComfyUI-H3-BatchRenderer → V1.11 → 节点方案; +GUI1.0/app = 产品线程序目录
    gui_root_ok = os.path.isdir(gui_root)  # 缺失→路由仍注册但返回 503+日志, 不炸 ComfyUI

    @routes.get("/h3_gui/")
    @routes.get("/h3_gui/{tail:.*}")
    async def h3_gui_page(request):
        if not gui_root_ok:
            return web.Response(status=503, text="GUI1.0/app not found")
        tail = request.match_info.get("tail", "")
        rel = os.path.normpath(tail).lstrip("\\/").replace("/", os.sep)
        if rel.startswith(".."):          # 路径穿越拒绝
            return web.Response(status=403)
        full = os.path.join(gui_root, rel) if rel else os.path.join(gui_root, "index.html")
        # V1.13 D2: 解析后 abspath(normcase) 必须仍落在 gui_root 内, 否则 403
        # (盘符绝对路径 / UNC 走 os.path.join 会绕开 startswith("..") 守卫)
        full_n = os.path.normcase(os.path.abspath(full))
        gui_root_n = os.path.normcase(os.path.abspath(gui_root))
        if full_n != gui_root_n and not full_n.startswith(gui_root_n + os.sep):
            return web.Response(status=403)
        if not os.path.isfile(full):
            full = os.path.join(gui_root, "index.html")   # SPA 兜底
        return web.FileResponse(full, headers={"Cache-Control": "no-cache"})


# --- S1 (老板令 D1①): 写端点来源校验 — 跨站拒绝, 同源/缺失放行 -------------------
# 单点接线: PromptServer app 中间件 (ComfyUI main.py 先建 PromptServer 再 init_extra_nodes,
# 本模块加载期 app 已存在且未 start, middlewares 可追加)。保护面 = POST 与 DELETE
# /h3_batch/* 写端点 (K2a 1.14 批 K 把 DELETE 同族 3 端点纳入, 与 POST 族口径一致):
# Origin (优先) 或 Referer 与请求 Host 同源 → 放行; 两者都缺 (MCP/CLI/httpx 无 Origin)
# → 放行; 跨站/不可解析 → 403 cross_origin_rejected。GET 读端点与宿主其他路由不受影响。
_ORIGIN_GUARD_PATH_PREFIX = "/h3_batch/"
_ORIGIN_GUARD_WRITE_METHODS = ("POST", "DELETE")


def _origin_guard_url_host_port(url):
    """URL 文本 → (hostname, port); 无主机/非法 → None (缺端口按 scheme 默认)."""
    try:
        p = urlsplit(url)
        if not p.hostname:
            return None
        if p.port is not None:
            return (p.hostname, p.port)
        return (p.hostname, 443 if p.scheme == "https" else 80)
    except ValueError:
        return None


def _origin_guard_declared(request):
    """请求声明的来源: Origin 优先, 缺则 Referer; 都缺 → None (非浏览器直连)."""
    headers = request.headers
    return ((headers.get("Origin") or "").strip()
            or (headers.get("Referer") or "").strip() or None)


def _origin_guard_is_same_origin(request):
    """声明来源与请求 Host 同源 → True; 跨站或不可解析 → False; 未声明 → None."""
    declared = _origin_guard_declared(request)
    if not declared:
        return None
    host = (request.headers.get("Host") or "").strip()
    target = _origin_guard_url_host_port("//" + host) if host else None
    declared_hp = _origin_guard_url_host_port(declared)
    return bool(target and declared_hp and target == declared_hp)


@web.middleware
async def _h3_origin_guard_middleware(request, handler):
    if (request.method in _ORIGIN_GUARD_WRITE_METHODS
            and request.path.startswith(_ORIGIN_GUARD_PATH_PREFIX)):
        if _origin_guard_is_same_origin(request) is False:
            print("[H3Batch] 来源校验拒绝跨站写请求: %s %s origin=%r" % (
                request.method, request.path, _origin_guard_declared(request)), flush=True)
            return web.json_response(
                {"ok": False, "error": "cross_origin_rejected"}, status=403)
    return await handler(request)


def _install_origin_guard():
    """来源校验中间件挂到 PromptServer app (模块加载期, app 未 start).

    Returns:
        True 已挂载; False 无 app (测试桩/非 PromptServer 环境) 或挂载异常 (已打日志).
    """
    app = getattr(getattr(server.PromptServer, "instance", None), "app", None)
    middlewares = getattr(app, "middlewares", None)
    if middlewares is None:
        return False
    try:
        middlewares.append(_h3_origin_guard_middleware)
    except Exception as e:  # app 已冻结等异常形态: 不炸节点导入, 但必须留痕
        print("[H3Batch] 来源校验中间件挂载失败, 写端点无跨站防护: %s" % e, flush=True)
        return False
    return True


# --- S2 (老板令 D1①): 任意路径读端点越界日志 — 先记录不硬拦, 响应行为零变化 ---------
# 口径: 路径参数解析后落在引擎自用根之外 (kind=data → input 树/output 树/archive_root;
# kind=output → output 树/archive_root; kind=workflow → workflow_dir) → stdout 一行
# `[H3Batch] out-of-scope: <端点> <原样路径>`。仅观察记录: 不替代也不新增任何拦截
# (thumb 等"任意本机路径"属已文档化的本地信任模型; asset_copy 相对路径逃逸的既有 400
# 原样保留, 只是同时留痕)。
def _h3_read_scope_roots(kind):
    """S2 允许根列表 (调用时取 — 测试可注入; 空串根由调用侧跳过)."""
    if kind == "workflow":
        return [H3_WORKFLOW_DIR]
    if kind == "output":
        return [folder_paths.get_output_directory(), ARCHIVE_ROOT]
    return [folder_paths.get_input_directory(), folder_paths.get_output_directory(), ARCHIVE_ROOT]


def _h3_log_read_out_of_scope(endpoint, raw, resolved, kind):
    """S2: resolved 不在任一允许根树内 → 打越界日志一行 (仅记录; 端点响应不受影响)."""
    try:
        raw = str(raw or "").strip()
        _resolved = os.path.normcase(os.path.realpath(str(resolved or "")))
        if not raw or not _resolved:
            return
        for root in _h3_read_scope_roots(kind):
            if not root:
                continue
            _root = os.path.normcase(os.path.realpath(root))
            if _resolved == _root or _resolved.startswith(_root + os.sep):
                return
        print("[H3Batch] out-of-scope: %s %s" % (endpoint, raw), flush=True)
    except Exception:
        pass  # 日志点自身异常不得改变端点行为


if getattr(server.PromptServer, "instance", None) is not None:
    @server.PromptServer.instance.routes.post("/h3_batch/cancel")
    async def _h3_cancel(request):
        # T5 取消当前后台批量: 设 engine._stop — V1.6 起 _wait_shot 不再"立即弃等",
        # 而是继续轮询当前 pid 至完成/timeout (当前段跑完收尾), run() 收尾把余段 (未跑)
        # 显式标 "stopped" (≠pending≠success), 断点续跑可重跑 stopped 段 / 跳过 success 段。
        # repeat/队列模式传播: run_repeats 第 N 遍 stop → 余遍不跑; run_queue 任务内 stop
        # → progress[done] 不标 key (断点续跑可重扫该批), 后续批不跑。
        # 队列模式: cancel 只中断当前引擎的当前段; 后续任务/段会按传播规则停止。
        # T7: _active_engine 由 _safe_repeats / _safe_queue 内的 wrapped 在 make_engine 后
        # 发布为真跑批引擎(非 probe), cancel 端点拿到的 eng 即正在干活那个。
        global _active, _active_engine
        with _active_lock:
            t = _active
            eng = _active_engine
        if t is None or not t.is_alive():
            with _active_lock:
                _active = None
                _active_engine = None
            # V1.11 收尾异步化专项 T2: 收尾期不可中断 (ffmpeg 自身收敛先例) —
            # _finalizing 任一键非空即返明确提示, 让前端知道"生成已完成, 收尾进行中"。
            with _finalize_lock:
                if any(_finalizing.values()):
                    return web.json_response({"cancelled": False,
                                              "msg": "生成已完成, 收尾进行中(不可中断), 请稍候"})
            return web.json_response({"cancelled": False, "msg": "没有任务"})
        if eng is not None:
            eng._stop.set()
        else:
            # 队列启动窗口/批引擎切换间隙: t 已发布但 _active_engine 未发布, 无 _stop 可设.
            return web.json_response({"cancelled": False,
                                      "msg": "引擎句柄未就绪(启动窗口), 当前段无法停止, 请重试"})
        # _wait_shot 最多 10s 一轮; 12s 内 _safe_repeats 走完 finally, _active 自动清空
        t.join(timeout=12)
        with _active_lock:
            if _active is not None and not _active.is_alive():
                _active = None
                _active_engine = None
        return web.json_response({"cancelled": True,
                                  "msg": "已发出停止信号; 引擎跑完当前段后退出, 余段标记 stopped, 重跑可断点续跑"})

    # V1.10 批2 T3: 审片门三端点 (D3) — approve/void/resume. 注册模式与 cancel 端点同块.
    # 入参: {stem, sid?, output_dir?}; 缺 stem 或 approve/void 缺 sid → 400.
    # stem 校验沿 status 端点同款正则 (防路径穿越); manifest 路径复用 _status_output_dir +
    # "h3_batch_manifest_<stem>.json" 命名; 写盘统一走 batch_core._manifest_write (T1 基建,
    # per-path 锁 + 原子保存), 与引擎侧共用同一把锁, 消除端点侧丢更新窗口.
    # V1.11 批1 T2: 响应语义/幂等/solo/级联行为零变化 (既有端点测试为准, 一条不许动).
    @server.PromptServer.instance.routes.post("/h3_batch/review/approve")
    async def _h3_review_approve(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        stem = str(body.get("stem", "") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", stem):
            return web.json_response({"error": "invalid stem"}, status=400)
        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"error": "缺少参数 sid"}, status=400)
        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"error": "output_dir 不存在"}, status=400)
        # V1.11 批 1 T6: 回收站只读约束 — approve 端点禁止在 .h3_trash 内的任务操作
        if _find_in_trash(stem, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        # V1.11 批 1 T2b: 双位置寻址 — 写盘落在解析到的位置 (不搬迁文件)
        mp = resolve_manifest_path(stem, output_dir)
        if not mp:
            return web.json_response({"ok": False, "msg": "manifest 不存在"})
        # V1.11 收尾异步化 T2: 写 manifest vs 归档搬运 TOCTOU 同源 — 收尾中拒接。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)
        # T2: 锁内 read→mutate→write; 用 list 当 result_holder 让 mutator 跨闭包传信号.
        sig = ["ok"]
        def _mut(existing):
            if not isinstance(existing, dict) or not existing:
                sig[0] = "no_manifest"
                return None
            info = existing.get(sid)
            if not isinstance(info, dict) or info.get("status") != "success":
                sig[0] = "not_success"
                return None
            if info.get("review") == "approved":
                sig[0] = "idempotent"
                return None  # 已 approved 不写盘
            info["review"] = "approved"
            return existing
        try:
            _manifest_write(mp, _mut)
        except OSError as e:
            return web.json_response({"ok": False, "sid": sid,
                                      "msg": "manifest 写入失败: %s" % e})
        if sig[0] == "no_manifest":
            return web.json_response({"ok": False, "msg": "manifest 不存在"})
        if sig[0] == "not_success":
            return web.json_response({"ok": False, "sid": sid,
                                      "msg": "段不存在或非 success 状态"})
        # approved / idempotent 响应形态一致
        return web.json_response({"ok": True, "sid": sid, "review": "approved"})

    @server.PromptServer.instance.routes.post("/h3_batch/review/void")
    async def _h3_review_void(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        stem = str(body.get("stem", "") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", stem):
            return web.json_response({"error": "invalid stem"}, status=400)
        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"error": "缺少参数 sid"}, status=400)
        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"error": "output_dir 不存在"}, status=400)
        # V1.11 批 1 T6: 回收站只读约束
        if _find_in_trash(stem, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        # V1.11 批 1 T2b: 双位置寻址 — 写盘落在解析到的位置 (不搬迁文件)
        mp = resolve_manifest_path(stem, output_dir)
        if not mp:
            return web.json_response({"ok": False, "msg": "manifest 不存在"})
        # V1.11 收尾异步化 T2: 同 approve — 收尾中拒接写盘。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)
        # V1.10 批3 T4a: solo=True 时只 void 本段 (不级联); 缺省 False → 现状级联语义零变化.
        solo = bool(body.get("solo", False))
        sig = {"status": "voided", "voided": [], "info": None}
        def _mut(existing):
            if not isinstance(existing, dict) or not existing:
                sig["status"] = "no_manifest"
                return None
            # 1.11b 波2 T5: 自定义模式下, 级联范围 = 紧跟被作废段的连续勾选段.
            # 端点无引擎实例, 从 manifest._csv_path 解析回 CSV (复用 csv_gen.parse_csv_to_data);
            # 缺 _csv_path / 解析失败 / sid 不在映射中 → 回落全量级联 + WARN, 不抛错.
            cascade_pred = None
            if existing.get("_mode") == "自定义":
                _csv_path = existing.get("_csv_path")
                if _csv_path and os.path.isfile(_csv_path):
                    try:
                        _parsed = parse_csv_to_data(_csv_path)
                        _shots = _parsed.get("shots") or []
                        _seg_flags = derive_seg_flags(_shots)
                        _sid_to_flag = {}
                        for _sh, _fl in zip(_shots, _seg_flags):
                            _sid = _sh.get("ID", "") if isinstance(_sh, dict) else ""
                            if _sid:
                                _sid_to_flag[_sid] = _fl
                        if sid in _sid_to_flag:
                            def cascade_pred(k, _m=_sid_to_flag):
                                return bool(_m.get(k, False))
                        else:
                            print("[H3Batch] review/void cascade_pred: sid %r 不在 CSV 映射中, 回落全量级联" % sid, flush=True)
                    except Exception as _e:
                        print("[H3Batch] review/void cascade_pred 解析失败 (%s), 回落全量级联" % _e, flush=True)
                else:
                    print("[H3Batch] review/void cascade_pred: 缺 _csv_path 或文件不存在, 回落全量级联", flush=True)
            # 级联 helper (batch_core.apply_review_void): 幂等, 按段键数字序级联.
            voided = apply_review_void(existing, sid, solo=solo, cascade_pred=cascade_pred)
            if not voided:
                sig["status"] = "no_op"
                sig["info"] = existing.get(sid)
                return None  # 无变化不写盘
            sig["voided"] = voided
            return existing  # apply_review_void 原地改, existing 已含新 review
        try:
            _manifest_write(mp, _mut)
        except OSError as e:
            return web.json_response({"ok": False, "sid": sid,
                                      "msg": "manifest 写入失败: %s" % e})
        if sig["status"] == "no_manifest":
            return web.json_response({"ok": False, "msg": "manifest 不存在"})
        if sig["status"] == "no_op":
            info = sig["info"]
            if solo:
                # solo 路径下 voided 空的语义: target 已 void (幂等) 或 target 不在/非 success
                reason = ("段不存在或非 success 状态" if not isinstance(info, dict)
                          else "段已 void (solo 幂等)" if info.get("review") == "void"
                          else "段不在 manifest")
            else:
                reason = ("段不存在或非 success 状态" if not isinstance(info, dict)
                          else "段已 void 且无后续 success 级联" if info.get("review") == "void"
                          else "段不在 manifest")
            return web.json_response({"ok": False, "sid": sid, "msg": reason})
        if solo:
            # solo 路径响应形态: 仅 {ok, sid, solo}, 不含 voided 列表 / cascade_count.
            return web.json_response({"ok": True, "sid": sid, "solo": True})
        return web.json_response({"ok": True, "sid": sid,
                                  "voided": sig["voided"],
                                  "cascade_count": len(sig["voided"])})

    @server.PromptServer.instance.routes.post("/h3_batch/review/resume")
    async def _h3_review_resume(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        stem = str(body.get("stem", "") or "").strip()
        if not stem:
            return web.json_response({"error": "缺少参数 stem"}, status=400)
        # 与 status 端点 stem 校验同款 — 路径直查, 防穿越
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", stem):
            return web.json_response({"error": "invalid stem"}, status=400)
        # 拿 _active_engine (须存活 + phase=审片门暂停) → _gate.set() 放行.
        with _active_lock:
            eng = _active_engine
        if eng is None or not getattr(eng, "_gate", None):
            return web.json_response({"ok": False, "msg": "引擎未运行, 请重新提交批次任务(同 CSV)以续跑"})
        if getattr(eng, "phase", "") != "审片门暂停":
            return web.json_response({"ok": False, "msg": "引擎未处于审片门暂停 (phase=%r)" % getattr(eng, "phase", "")})
        # V1.11 收尾异步化 T2: 审片门暂停阶段 _gate.set() 触发收尾走归档搬运 —
        # 写 manifest 与归档搬运 TOCTOU 同源, 收尾中拒接。
        _eng_out = getattr(eng, "output_dir", "") or ""
        if _eng_out and _finalizing_hit(_eng_out):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)
        try:
            eng._gate.set()
        except Exception as e:
            return web.json_response({"ok": False, "msg": "_gate.set 失败: %s" % e})
        return web.json_response({"ok": True, "resumed": True})

    # V1.11 批 1 T3: 片段多段重跑端点 — 错误信封 {ok:false,error,detail?}
    # body: {task_id, sids(数组或逗号串), csv_path?, keep_seed?, output_dir?, input_dir?}.
    # 错误: 400 参数/预检失败; 404 manifest 不存在; 409 active 占用.
    # 三级 csv_path 解析 (body > manifest._csv_path > input_dir 复原) + 指纹校验.
    # 后台线程 + _active_lock 占用 (与节点/submit 双向互斥).
    # 引擎内联构造 (与节点 INPUT_TYPES 同名缺省, T4 抽 build_engine_from_params).
    @server.PromptServer.instance.routes.post("/h3_batch/rerun")
    async def _h3_rerun(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)

        sids_raw = body.get("sids")
        sids = []
        if isinstance(sids_raw, str):
            sids = [x.strip() for x in sids_raw.split(",") if x.strip()]
        elif isinstance(sids_raw, (list, tuple)):
            for x in sids_raw:
                if isinstance(x, str) and x.strip():
                    sids.append(x.strip())
        if not sids:
            return web.json_response({"ok": False, "error": "缺少参数 sids"}, status=400)

        # sids 在 CSV 内合法性 (预检 — 后台引擎还会再 check, 这里先挡)
        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        # V1.11 批 1 T6 真机 P0 修复: 回收站检查必须在 resolve **之前** ——
        # resolve_manifest_path 不看 .h3_trash, trash 内 manifest resolve 不到,
        # 旧实现先 404 让 trash 检查永远走不到 (T5 单测直接构造 mp 桩没抓到).
        # 改: 先查 trash, 在 trash → 400 task_in_trash; 不在 → 再走 resolve 404.
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)

        # 三级 csv_path 解析 (body > manifest._csv_path > input_dir 复原) + 指纹校验
        csv_path = str(body.get("csv_path", "") or "").strip()
        if not csv_path:
            csv_path = str(data.get("_csv_path", "") or "").strip()
        if not csv_path:
            # V1.11 批 1 T3 门审 F: 同时支持两种 stem 形态 ——
            # (a) 生产: CSV 名 = `h3_batch_<时间戳>.csv`, stem 即基名 (无后缀), 需 `<stem>.csv` 精确匹配
            # (b) 后缀变体: repeat 批等场景, 需 `<stem>_*.csv` (例 `<stem>_rep1.csv`).
            # 两套 glob 合并去重, 排序稳定; 多候选 → 400 列详情.
            input_dir = str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory()
            exact_pat = os.path.join(input_dir, "%s.csv" % task_id)
            suffix_pat = os.path.join(input_dir, "%s_*.csv" % task_id)
            candidates = sorted(set(glob.glob(exact_pat) + glob.glob(suffix_pat)))
            if not candidates:
                return web.json_response({"ok": False,
                                          "error": "未找到原 CSV (候选 0); 请在表单传 csv_path 或重新生成后用 submit",
                                          "detail": []}, status=400)
            if len(candidates) > 1:
                return web.json_response({"ok": False,
                                          "error": "原 CSV 候选 %d 个, 请在 body 显式传 csv_path" % len(candidates),
                                          "detail": candidates}, status=400)
            csv_path = candidates[0]
        csv_path = os.path.abspath(csv_path)
        if not os.path.exists(csv_path):
            return web.json_response({"ok": False,
                                      "error": "csv_path 不存在: %s" % csv_path}, status=400)
        # 指纹校验 (与 manifest._csv_fingerprint 比对)
        stored_fp = data.get("_csv_fingerprint")
        if stored_fp:
            try:
                import hashlib as _hashlib
                with open(csv_path, "rb") as _f:
                    cur_fp = _hashlib.sha256(_f.read()).hexdigest()[:16]
            except OSError as e:
                return web.json_response({"ok": False,
                                          "error": "csv_path 读取失败: %s" % e}, status=400)
            if cur_fp != stored_fp:
                return web.json_response({"ok": False,
                                          "error": "原 CSV 不可用, 请在表单重新生成后用 submit"}, status=400)

        # 1.14c C3 (E3 候选 A "放开"): 作废段不再挡 — 可直接重跑; 新 take 恒落
        # pending (C1 规则①, batch_core._rerun_generate_shot_in_folder 写盘时读),
        # 作废件被新 take 取代. (旧注释误称"void 重跑不写 _reruns" — 成功路径
        # 无条件 _append_reruns_ledger, 一并改正.)
        csv_ids = set()
        try:
            with open(csv_path, encoding="utf-8-sig") as _f:
                _reader = csv.reader(_f)
                _hdr = next(_reader, None)
                _id_col = (_hdr or []).index("ID") if _hdr and "ID" in _hdr else 0
                for _row in _reader:
                    if len(_row) > _id_col:
                        _sid = _row[_id_col].strip()
                        if _sid:
                            csv_ids.add(_sid)
        except Exception:
            csv_ids = set()
        for sid in sids:
            if sid not in csv_ids:
                return web.json_response({"ok": False,
                                          "error": "sid %s 不在 CSV 分镜表内" % sid}, status=400)

        # active 互斥 (持锁期间检查; 短临界区)
        with _active_lock:
            _busy_resp = _active_busy_response()
            if _busy_resp is not None:
                return _busy_resp
        # V1.11 收尾异步化 T2: 收尾中拒接重跑 (防重跑写文件 vs 归档搬运竞态)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)
        # V1.11 批 1 T5: 拼接锁双向互斥 — 拼接 ffmpeg 读段产物时禁止重跑改文件名
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"}, status=409)
        # 1.14 D4: postfx 运行期查 9 写端点 — 抽 _postfx_busy() helper (D2 审核观察 S3,
        # 锁内仅查阅不改状态). 旧 D2 内联守卫改 2 行 helper 调用.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        # 引擎参数从 manifest 派生 (mode/workflow); 与节点 INPUT_TYPES 同名缺省.
        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            # manifest 没记工作流 → 退化用 DEFAULT_WORKFLOW (缺省可由 _clean_path 兜底)
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        input_dir = str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory()
        server_input_dir = input_dir
        keep_seed = bool(body.get("keep_seed", False))
        # V1.11 批 1 T4: rerun 端点也走 build_engine_from_params 共享构造路径;
        # 重跑默认 (port=0/start_from=0/retries=2/skip_done=True/on_fail=继续/
        # archive_dir=""/resources/overrides 留默认) — on_fail 必须显式 "继续",
        # 与 INPUT_TYPES 默认 "阻断" 不同 (拼接单段失败不应断链整批).
        # V1.13 D25: 资源编排三 raw 键从 manifest 抽取回灌 (原批丢失 LoRA 编排/资源覆写/模板 LoRA 强度的修复点);
        # 旧 manifest 无 raw 键时回退空三元组 (与原 rerun 行为一致, 不炸).
        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": input_dir, "server_input_dir": server_input_dir,
                "server_output_dir": folder_paths.get_output_directory(),  # V1.13 D9-R: 写入基准=真实输出根 (body output_dir 仅作 manifest 定位; 归档 rerun 误作 server_root 致续接前缀错位)
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                **_seg_pools_kwargs(data),  # 批 K: 段池回灌
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        # T2b 布局: manifest 在 run_dir 内 (folder = 该批时间戳文件夹). 端点拿到的 mp
        # 是 resolve_manifest_path 已解析的绝对路径 → folder = dirname(mp), 而非 output 根.
        # 真机 P0 (第五轮): 旧版传 output_dir 导致产物落根/keep_old 不命中/parts 空—
        # 改用 dirname(mp) 一行归位 (失败路径 rename + _reruns ledger 同步自然成立).
        folder = os.path.dirname(os.path.abspath(mp))
        sids_sorted = H3BatchEngine._sort_numeric_sids(sids)

        def _do_rerun():
            try:
                results = eng.rerun_multi_shots_in_folder(folder, sids_sorted, keep_seed=keep_seed)
                _append_reruns_ledger(mp, sids_sorted, results)
            except Exception:
                print("[H3Batch] 后台多段重跑异常: %s" % traceback.format_exc(), flush=True)
            finally:
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_rerun, daemon=True)
            _active.start()
        return web.json_response({
            "ok": True,
            "started": True,
            "task_id": task_id,
            "sids": sids_sorted,
        })


    # V1.11 批 3 T1: 同 seed 重跑端点 — body = {task_id, source, rerun_seq?, 比例?, 质量?, 步数?, force?}.
    # 错误信封 {ok:false, error, detail?}; 400 参数/校验失败; 404 manifest 不存在;
    # 409 active 占用 (同 rerun 端点); trash 内 400 task_in_trash.
    # 服务端校验 (v6 P1):
    #   比例 ∈ ASPECT_OPTIONS 值集 (空=不覆写); 质量 float; 步数 AVa (大写 V/A 顺序敏感)
    #   且 A≥V (避免 audio_steps > video_steps 校验冲突).
    # 差异检测 (V1.11 批 3 T1): body 参数 vs manifest._res_summary — 全同 → confirm_required=true;
    # 旧 manifest 无 _res_summary → diff_check="skipped" (仍允许执行); force=true 跳过二次确认.
    # 种子: source=task → manifest 各段 seed (失败段 CSV → 随机); source=rerun → _reruns[seq-1].seeds 作用段集.
    # 执行: 复用 rerun_multi_shots_in_folder(res_override + 各段原 seed 作 seed_override + 恒定微扰)
    # → _reruns ledger reason="same_seed" + params/prompt_edited/res_changed 扩记.
    @server.PromptServer.instance.routes.post("/h3_batch/rerun_same_seed")
    async def _h3_rerun_same_seed(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)

        source = str(body.get("source", "") or "").strip()
        if source not in ("task", "rerun"):
            return web.json_response({"ok": False,
                                      "error": "source 必须是 'task' 或 'rerun'"},
                                     status=400)
        rerun_seq = body.get("rerun_seq")
        if source == "rerun":
            if not isinstance(rerun_seq, int) or rerun_seq < 1:
                return web.json_response({"ok": False,
                                          "error": "source=rerun 必须传 rerun_seq (正整数)"},
                                         status=400)

        ratio_raw = body.get("比例", None)
        quality_raw = body.get("质量", None)
        steps_raw = body.get("步数", None)
        ratio_norm = ratio_raw.strip() if isinstance(ratio_raw, str) and ratio_raw.strip() else ""
        quality_norm = quality_raw.strip() if isinstance(quality_raw, str) and quality_raw.strip() else ""
        steps_norm = steps_raw.strip() if isinstance(steps_raw, str) and steps_raw.strip() else ""

        # V1.11 交付前 BE-P1-2: 比例归一化收口 — 标签 ('16:9 (Widescreen)') 与裸 ('16:9')
        # 都接受, 白名单按裸比例判, 入引擎前归一为裸. 旧实现按 ASPECT_OPTIONS 标签集判
        # → 拒绝裸值; 且裸 vs 标签字符串比对恒不等 → res_changed 误判.
        if ratio_norm:
            _bc_norm = _normalize_ratio(ratio_norm)
            if _bc_norm and not re.match(r"^\d+:\d+$", _bc_norm):
                return web.json_response({"ok": False,
                                          "error": "比例 '%s' 归一后非合法裸比例 (期望 'N:N')" % ratio_norm},
                                         status=400)
            ratio_norm = _bc_norm  # 入引擎前归一为裸
        # 比例白名单 (空=不覆写; 非空必须 ∈ ASPECT_MAP keys 即已知裸比例)
        if ratio_norm and ratio_norm not in ASPECT_MAP:
            return web.json_response({"ok": False,
                                      "error": "比例 '%s' 不在白名单 (合法: %s) 内" % (
                                          ratio_norm, sorted(ASPECT_MAP.keys()))},
                                     status=400)
        # 质量 float
        if quality_norm:
            try:
                _qf = float(quality_norm)
                if _qf <= 0:
                    raise ValueError
            except (TypeError, ValueError):
                return web.json_response({"ok": False,
                                          "error": "质量 '%s' 必须为正浮点数" % quality_norm},
                                         status=400)
        # 步数 A≥V 校验 (硬规则: \d+V\d+A 大写 V/A 顺序敏感; 音频步 ≥ 视频步).
        if steps_norm:
            _m = re.match(r"^(\d+)\s*([VA])\s*(\d+)\s*([VA])$", steps_norm, re.IGNORECASE)
            if not _m:
                return web.json_response({"ok": False,
                                          "error": "步数 '%s' 格式必须为 NVNA (大写 V/A)" % steps_norm},
                                         status=400)
            _v = int(_m.group(1)) if _m.group(2).upper() == "V" else int(_m.group(3))
            _a = int(_m.group(3)) if _m.group(2).upper() == "V" else int(_m.group(1))
            if _a < _v:
                return web.json_response({"ok": False,
                                          "error": "步数 '%s' 音频步 A(%d) 必须 ≥ 视频步 V(%d)"
                                                   % (steps_norm, _a, _v)},
                                         status=400)

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        # trash 拦截 (rerun 端点同款 — 先查 trash 再走 resolve)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)

        # V1.11 批4 T4 D3: 端点 PDD 步数校验 (helper 双消费 — 与 preflight 同款).
        #   manifest data._workflow 取模板路径 (T1 先例 :1472), 判 PDDAccApply 后
        #   _validate_pdd_steps(steps_norm) → 命中 → 400 可读报错 (与上方通用 A≥V 同款风格).
        if steps_norm:
            _wf_ref = str(data.get("_workflow", "") or "").strip() or ""
            if _wf_ref:
                _wf_path = _resolve_workflow_path(_wf_ref) if _wf_ref else ""
                if _wf_path and os.path.isfile(_wf_path):
                    try:
                        with open(_wf_path, encoding="utf-8") as _wf_f:
                            _wf_doc = json.load(_wf_f)
                        if _rs_template_has_pdd(_wf_doc):
                            _pdd_err = _bc_validate_pdd_steps(steps_norm)
                            if _pdd_err is not None:
                                return web.json_response(
                                    {"ok": False, "error": _pdd_err},
                                    status=400)
                    except (OSError, ValueError):
                        pass  # 模板读不到/坏 JSON 不在端点拦 (交给引擎 preflight 报)

        # 差异检测: body 参数 vs manifest._res_summary.
        # 全空 body = 无覆写 = 与历史完全相同 → confirm_required (用户 force 才执行,
        # 防白跑; 旧实现漏判此路径 — body 三参全空 + stored 非空时归到 differs 直接执行).
        stored = data.get("_res_summary")
        diff_check = "skipped"  # 旧 manifest 无 _res_summary → 跳过检测, 仍执行
        if isinstance(stored, dict):
            body_empty = not (ratio_norm or quality_norm or steps_norm)
            # V1.11 交付前 BE-P1-2: 比例两侧都先归一为裸, 防 label vs 裸字符串恒不等
            # → 误判 differs (与 res_changed 预检同款口径).
            _stored_ratio_raw = str(stored.get("比例", "") or "")
            _stored_ratio = _normalize_ratio(_stored_ratio_raw)
            all_match = (_stored_ratio == ratio_norm
                         and str(stored.get("质量", "") or "") == quality_norm
                         and str(stored.get("步数", "") or "") == steps_norm)
            if body_empty or all_match:
                diff_check = "matched"
            else:
                diff_check = "differs"

        force = bool(body.get("force", False))
        if diff_check in ("matched", "matched_all_empty") and not force:
            return web.json_response({
                "ok": True,
                "confirm_required": True,
                "diff_check": diff_check,
                "detail": "参数与该任务历史完全相同",
            })
        # 否则继续执行; diff_check=skipped 仍执行 (旧 manifest 无基线)

        # 种子来源
        sids_for_run = []
        seeds_for_run = {}
        # 失败段兜底: CSV 种子列 (P1-8 门审真机缺口 — 旧实现只包 success 段,
        # 失败段被过滤, 弹窗种子列表不显示该段). CSV 用 data._csv_path 复原.
        csv_seed_by_sid = {}
        _csv_path = data.get("_csv_path") if isinstance(data, dict) else None
        if _csv_path and os.path.isfile(str(_csv_path)):
            try:
                with open(_csv_path, encoding="utf-8-sig") as _f:
                    _reader = csv.reader(_f)
                    _hdr = next(_reader, None)
                    if _hdr:
                        _id_idx = _hdr.index("ID") if "ID" in _hdr else 0
                        _seed_idx = _hdr.index("种子") if "种子" in _hdr else None
                        for _row in _reader:
                            if not _row:
                                continue
                            if len(_row) <= _id_idx:
                                continue
                            _sid = _row[_id_idx].strip()
                            if not _sid:
                                continue
                            _seed_val = ""
                            if (_seed_idx is not None
                                    and _seed_idx < len(_row)):
                                _seed_val = _row[_seed_idx].strip()
                            csv_seed_by_sid[_sid] = _seed_val
            except Exception:
                pass  # CSV 读失败不阻塞 — 兜底走随机
        if source == "task":
            for sid, seg in data.items():
                if sid in _RESERVED_KEYS or not isinstance(seg, dict):
                    continue
                # 成功段 + 失败段都纳入 (失败段用 CSV 种子 → 随机兜底)
                if seg.get("status") not in ("success", "failed"):
                    continue
                _s = seg.get("seed")
                if _s is not None:
                    try:
                        seeds_for_run[sid] = int(float(_s))
                    except (TypeError, ValueError):
                        pass
                if sid not in seeds_for_run:
                    # 失败段走 CSV 种子列; 解析失败 → 留 None (引擎端 random 兜底,
                    # 弹窗种子列表显示"随机" — 与 spec 对齐)
                    csv_v = csv_seed_by_sid.get(sid, "")
                    if csv_v:
                        try:
                            seeds_for_run[sid] = int(float(csv_v))
                        except (TypeError, ValueError):
                            pass
                sids_for_run.append(sid)
        else:  # source == "rerun"
            reruns = data.get("_reruns") or []
            if not isinstance(reruns, list) or not reruns:
                return web.json_response({"ok": False, "error": "_reruns 不存在"}, status=400)
            idx = rerun_seq - 1
            if idx < 0 or idx >= len(reruns):
                return web.json_response({"ok": False, "error": "rerun_seq 越界"}, status=400)
            entry = reruns[idx]
            sids_for_run = list(entry.get("sids") or [])
            seeds_map = entry.get("seeds") or {}
            for sid, v in seeds_map.items():
                if v is not None:
                    try:
                        seeds_for_run[sid] = int(float(v))
                    except (TypeError, ValueError):
                        pass

        # 1.14c C3 (E3 候选 A "放开"): void 段不再挡 — 可直接重跑; 新 take 恒落
        # pending (C1 规则①). (原 1.11a 波 3 void 闸门已移除.)

        sids_sorted = H3BatchEngine._sort_numeric_sids(sids_for_run)
        if not sids_sorted:
            return web.json_response({"ok": False, "error": "无可作用段 (无种子记录)"}, status=400)

        # active 互斥 + concat 互斥 (同 rerun 端点)
        with _active_lock:
            _busy_resp = _active_busy_response()
            if _busy_resp is not None:
                return _busy_resp
        # V1.11 收尾异步化 T2: 收尾中拒接重跑 (同 rerun 端点)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"},
                                         status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        # 构造引擎 (同 rerun 端点 build_engine_from_params 路径)
        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        csv_path = str(data.get("_csv_path", "") or "").strip() or ""
        # V1.13 D25: 资源编排三 raw 键从 manifest 抽取回灌 (同 1691 同款 — 多段重跑端点).
        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory(),
                "server_input_dir": folder_paths.get_input_directory(),
                "server_output_dir": folder_paths.get_output_directory(),  # V1.13 D9-R: 写入基准=真实输出根 (body output_dir 仅作 manifest 定位; 归档 rerun 误作 server_root 致续接前缀错位)
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                **_seg_pools_kwargs(data),  # 批 K: 段池回灌
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        folder = os.path.dirname(os.path.abspath(mp))

        # res_override 字典 (只含非空项)
        res_override = {}
        if ratio_norm:
            res_override["比例"] = ratio_norm
        if quality_norm:
            res_override["质量"] = quality_norm
        if steps_norm:
            res_override["步数"] = steps_norm

        def _do_rerun():
            try:
                results = eng.rerun_multi_shots_in_folder(
                    folder, sids_sorted, keep_seed=True,
                    res_override=res_override or None,
                    seeds_override=seeds_for_run or None)
                _params = (results.get("_params")
                           if isinstance(results.get("_params"), dict) else None)
                _append_reruns_ledger(mp, sids_sorted, results,
                                      reason="same_seed",
                                      params=_params,
                                      prompt_edited=bool(results.get("_prompt_edited")),
                                      res_changed=bool(results.get("_res_changed")))
            except Exception:
                print("[H3Batch] 后台同 seed 重跑异常: %s" % traceback.format_exc(), flush=True)
            finally:
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_rerun, daemon=True)
            _active.start()
        # res_changed 同步预检 (供前端 toast 用; 后台跑完后结果再覆盖).
        # 比例/质量任一与磁盘 _res_summary 不同 → 全批列入 res_changed_sids
        # (端点提交时一次性算清, 前端拿到响应即知降级行为, 不必轮询 detail).
        # 旧 manifest 无 _res_summary → res_changed_sids=[] (保守).
        _res_changed_sids = []
        _hist = data.get("_res_summary")
        if isinstance(_hist, dict) and (ratio_norm or quality_norm):
            # V1.11 交付前 BE-P1-2: 比例两侧都先归一为裸, 防 label vs 裸字符串恒不等
            # → 误判 res_changed → skip_concat+降级锚三重退化.
            _hist_ratio_raw = str(_hist.get("比例", "") or "")
            _hist_ratio = _normalize_ratio(_hist_ratio_raw)
            _hist_quality = str(_hist.get("质量", "") or "")
            _ratio_diff = bool(ratio_norm and ratio_norm != _hist_ratio)
            _quality_diff = bool(quality_norm and quality_norm != _hist_quality)
            if _ratio_diff or _quality_diff:
                _res_changed_sids = list(sids_sorted)
        return web.json_response({
            "ok": True,
            "started": True,
            "task_id": task_id,
            "sids": sids_sorted,
            "diff_check": diff_check,
            "source": source,
            "rerun_seq": rerun_seq,
            # res_changed 预检: 比例/质量与磁盘 _res_summary 任一不同 → 全批列入
            # (P1-6 门审缺口 — 旧版缺, 用户改了分辨率后端点响应无任何提示). 前端
            # 据此 toast "分辨率已变更, 总片未重拼, 需全段同分辨率后手动拼".
            "res_changed": bool(_res_changed_sids),
            "res_changed_sids": _res_changed_sids,
            "skip_concat": bool(_res_changed_sids),
        })


    # V1.11 批 3 T1: 改词重跑端点 — body = {task_id, sid, prompt_text, keep_seed?}.
    # 错误信封 {ok:false, error, detail?}; 400 空文本/参数; 404 manifest 不存在;
    # 409 active 占用; trash 内 400 task_in_trash.
    # 默认换新种子; keep_seed=true 钉死 manifest 段 seed + 恒定微扰.
    # 复用 _rerun_generate_shot_in_folder 单段重跑 (prompt_text_override=全文).
    @server.PromptServer.instance.routes.post("/h3_batch/rerun_edit_prompt")
    async def _h3_rerun_edit_prompt(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)

        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"ok": False, "error": "缺少参数 sid"}, status=400)

        prompt_text = body.get("prompt_text", "")
        if not isinstance(prompt_text, str) or not prompt_text.strip():
            return web.json_response({"ok": False,
                                      "error": "prompt_text 必填非空"}, status=400)
        # prompt_text 保留原文 (前后空白不动; 所见即所发, 不 strip)

        keep_seed = bool(body.get("keep_seed", False))

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)

        # 1.14c C3 (E3 候选 A "放开"): void 段不再挡 — 可改词重跑; 新 take 恒落
        # pending (C1 规则①). (原 1.11a 波 3 void 闸门已移除.)

        with _active_lock:
            _busy_resp = _active_busy_response()
            if _busy_resp is not None:
                return _busy_resp
        # V1.11 收尾异步化 T2: 收尾中拒接改词重跑 (同 rerun 端点)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"},
                                         status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        csv_path = str(data.get("_csv_path", "") or "").strip() or ""
        # V1.13 D25: 资源编排三 raw 键从 manifest 抽取回灌 (同 1691 同款 — 改词重跑端点).
        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory(),
                "server_input_dir": folder_paths.get_input_directory(),
                "server_output_dir": folder_paths.get_output_directory(),  # V1.13 D9-R: 写入基准=真实输出根 (body output_dir 仅作 manifest 定位; 归档 rerun 误作 server_root 致续接前缀错位)
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                **_seg_pools_kwargs(data),  # 批 K: 段池回灌
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        folder = os.path.dirname(os.path.abspath(mp))

        # V1.13h 第三波 T5 (2d): 改词重跑回写侧车 prompt_text — 防下次重跑被侧车旧值压掉
        # (侧车 > CSV; 本次重跑走 _current_prompt_override = 显式优先, 不受回写影响).
        # #78 B 路径: 同步打标 prompt_text_scope=segment (下次普通重跑按段词重装配).
        try:
            batch_core._seg_overrides_set(folder, eng._csv_stem() or task_id, sid,
                                          {"prompt_text": prompt_text,
                                           "prompt_text_scope": "segment"})
        except OSError as e:
            print("[H3Batch] 改词重跑侧车回写失败: %s" % e, flush=True)

        # 单段重跑: keep_seed 走 manifest 段 seed + 微扰; 默认新种子
        seed_override = None
        if keep_seed:
            seg = data.get(sid) or {}
            try:
                seed_override = int(float(seg.get("seed") or 0)) or None
            except (TypeError, ValueError):
                seed_override = None
        perturb = H3BatchEngine._make_prompt_perturb() if seed_override is not None else ""

        def _do_rerun():
            try:
                ok, files, err = eng._rerun_generate_shot_in_folder(
                    folder, sid,
                    seed_override=seed_override,
                    prompt_perturb=perturb,
                    res_override=None,
                    prompt_text_override=prompt_text,
                    prompt_text_scope="segment")
                results = {sid: (ok, files, err),
                           "_seeds": {sid: seed_override},
                           "_params": getattr(eng, "_last_res_overrides", None),
                           "_res_changed": bool(getattr(eng, "_last_res_changed", False)),
                           "_prompt_edited": True}
                # 拼接模式: 跟一次末次重拼 (除非 res_changed 已被引擎内部标记)
                if (mode == "拼接"
                        and not getattr(eng, "_rerun_skip_concat", False)):
                    eng._rerun_finalize(folder)
                # V1.13 D25: 改词重跑亦为 rerun — 单段路径不走 rerun_multi_shots_in_folder,
                # 引擎内 _rerun_generate_shot_in_folder 不刷顶层 _inject/_override/raw 三键,
                # 端点侧补刷一次 (同 1697/1996 多段端点 — 改走引擎内 helper 后只在引擎内刷).
                eng._rerun_refresh_manifest_top_level()
                if ok and files:
                    _append_reruns_ledger(mp, [sid], results,
                                          reason="prompt_edit",
                                          prompt_edited=True,
                                          res_changed=bool(results.get("_res_changed")))
            except Exception:
                print("[H3Batch] 后台改词重跑异常: %s" % traceback.format_exc(), flush=True)
            finally:
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_rerun, daemon=True)
            _active.start()
        return web.json_response({
            "ok": True,
            "started": True,
            "task_id": task_id,
            "sid": sid,
        })


    # V1.13h 第三波 T5 (#57) 段级精修覆盖端点 — body = {task_id, sid, overrides, rerun?,
    # output_dir?, input_dir?}. 覆盖值写侧车 run_dir/_seg_overrides.json (真相源, 恒优先于
    # CSV); rerun=true 走 rerun 同款编排 (#5 同路径) 并同步等结果 (响应须如实报 rerun_failed,
    # 故不 background 早返回; 重活在线程里跑, 事件循环不阻塞). 契约见 docs/api.md #57.
    # 校验失败一律不写侧车 (不入脏值); 侧车写成功 + 重跑失败 → 侧车留存供重试.
    @server.PromptServer.instance.routes.post("/h3_batch/seg_edit")
    async def _h3_seg_edit(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"ok": False, "error": "缺少参数 sid"}, status=400)
        overrides = body.get("overrides")
        if not isinstance(overrides, dict) or not overrides:
            return web.json_response({"ok": False, "error": "overrides 必填非空对象"}, status=400)
        rerun = bool(body.get("rerun", True))

        # 段落时长: 端点写入时校验 (17n+5 帧网格 + 124-362; 双点位之一), 越界侧车不入脏值
        if "段落时长" in overrides:
            try:
                batch_core._seg_duration_frames(overrides["段落时长"])
            except ShotError as e:
                return web.json_response({"ok": False, "error": "段落时长越界: %s" % e},
                                         status=400)
        # 子键形状校验 (渲染期 _apply_* 直接消费; 形状错会在段内炸, 端点先挡)
        _ov_pool = overrides.get("pool")
        if _ov_pool is not None and not isinstance(_ov_pool, dict):
            return web.json_response({"ok": False, "error": "pool 必须是对象"}, status=400)
        _ov_res = overrides.get("resources")
        if _ov_res is not None and not isinstance(_ov_res, dict):
            return web.json_response({"ok": False, "error": "resources 必须是对象"}, status=400)
        if isinstance(_ov_res, dict) and any(
                not isinstance(v, str) for v in _ov_res.values() if v is not None):
            return web.json_response({"ok": False, "error": "resources 值必须是字符串"}, status=400)
        _ov_lora = overrides.get("lora")
        if _ov_lora is not None and (not isinstance(_ov_lora, dict)
                                     or any(not isinstance(v, dict) for v in _ov_lora.values())):
            return web.json_response({"ok": False, "error": "lora 必须是 {文件名: 对象}"}, status=400)
        _pt = overrides.get("prompt_text")
        if _pt is not None and (not isinstance(_pt, str) or not _pt.strip()):
            return web.json_response({"ok": False, "error": "prompt_text 必须是非空字符串"},
                                     status=400)
        # #78 B 路径 (S-5): prompt_text_scope 只由写者语义决定 — 剔除客户端传入值;
        # 写 prompt_text 时恒打标 segment (段词重装配), 无 prompt_text 不落该键.
        overrides.pop("prompt_text_scope", None)
        if _pt is not None:
            overrides["prompt_text_scope"] = "segment"

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        if not isinstance(data.get(sid), dict):
            return web.json_response({"ok": False, "error": "段不存在: %s" % sid}, status=400)

        # 家族跨族 (双点位之一 · 端点写时): 模板家族 (manifest["_workflow"]) vs 覆盖 unet
        # 家族; 跨族 → 400 + reason, 侧车不入脏值。渲染期差分层同款硬拒 (_seg_family_guard)。
        # 闲时批 B: 判族与引擎同源改结构判型 (_unet_family_conflict), 见 helper docstring。
        if isinstance(_ov_res, dict):
            _new_unet = _ov_res.get("unet")
            if isinstance(_new_unet, str) and _new_unet.strip():
                _wf_path = str(data.get("_workflow", "") or "")
                if _unet_family_conflict(_wf_path, _new_unet):
                    return web.json_response({
                        "ok": False,
                        "error": "家族跨族: 模板 %s 与覆盖值 %r 互斥 (ref2v↔fl2v)"
                                 % (os.path.basename(_wf_path), _new_unet)}, status=400)

        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                         status=409)
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"}, status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        csv_path = str(data.get("_csv_path", "") or "").strip() or ""
        # 侧车读写键 = CSV stem (引擎读点同源); CSV 不可用 → 覆盖值成无读者死键, 先挡
        if not csv_path or not os.path.exists(csv_path):
            return web.json_response({"ok": False, "error": "csv_path 不可用: %r" % csv_path},
                                     status=400)
        input_dir = str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory()
        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": input_dir, "server_input_dir": input_dir,
                "server_output_dir": folder_paths.get_output_directory(),
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                **_seg_pools_kwargs(data),  # 批 K: 段池回灌
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        folder = os.path.dirname(os.path.abspath(mp))
        # 侧车键 = 引擎读点同源 (_csv_stem; 生产 task_id 即 CSV stem, 不符时以引擎可读者为准)
        sidecar_key = eng._csv_stem() or task_id

        # pool 素材存在性 (既有资产解析口径 _resolve_file): 缺 → 400, 侧车不入脏值
        if isinstance(_ov_pool, dict):
            for _kind, _slots in _ov_pool.items():
                if not isinstance(_slots, dict):
                    return web.json_response(
                        {"ok": False, "error": "pool.%s 必须是 {槽号: 路径}" % _kind}, status=400)
                for _slot, _val in _slots.items():
                    if not _val:
                        continue
                    try:
                        eng._resolve_file(_val)
                    except ShotError as e:
                        return web.json_response(
                            {"ok": False, "error": "pool 素材不存在: %s" % e}, status=400)

        # 侧车原子写 (校验全过才落盘); 失败 → 500
        try:
            batch_core._seg_overrides_set(folder, sidecar_key, sid, overrides)
        except OSError as e:
            return web.json_response({"ok": False, "error": "sidecar_write_failed: %s" % e},
                                     status=500)
        if not rerun:
            return web.json_response({"ok": True, "task_id": task_id, "sid": sid,
                                      "sidecar_written": True, "rerun_failed": False,
                                      "reason": ""})

        # rerun=true: rerun 同款编排 (#5 同路径 rerun_multi_shots_in_folder), 线程内跑+
        # 同步等 (响应如实报 rerun_failed); 期间 _active 占位 → 其它端点 409 互斥.
        _res = {}

        def _do_rerun():
            try:
                results = eng.rerun_multi_shots_in_folder(folder, [sid])
                _append_reruns_ledger(mp, [sid], results, reason="seg_edit")
                seg_res = results.get(sid)
                if isinstance(seg_res, tuple) and seg_res[0]:
                    _res["failed"] = False
                else:
                    _res["failed"] = True
                    _res["reason"] = (seg_res[2] if isinstance(seg_res, tuple)
                                      and len(seg_res) > 2 else "重跑未产出产物")
            except Exception as e:
                _res["failed"] = True
                _res["reason"] = "%s: %s" % (type(e).__name__, e)
                print("[H3Batch] seg_edit 重跑异常: %s" % traceback.format_exc(), flush=True)
            finally:
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_rerun, daemon=True)
            _active.start()
        _th = _active
        await asyncio.get_running_loop().run_in_executor(None, _th.join)
        _clear_active()
        return web.json_response({"ok": True, "task_id": task_id, "sid": sid,
                                  "sidecar_written": True,
                                  "rerun_failed": bool(_res.get("failed")),
                                  "reason": _res.get("reason", "")})


    # V1.13h 第四波 T1 (#58) 多候选编排端点 — body = {task_id, sid, count, base?}.
    # **异步** (3 候选 ≈ 10 分钟, 同步挂 HTTP 有超时风险): 响应即返 started + group
    # (预生成) + estimate; 结果看 manifest._candidate_runs 组终态 (后台线程收尾锁内写).
    # 校验块与 #57 同款 (~50 行编排复制, 方案 C5 明示的复用单元): base 走同一键集与
    # 双点位校验 (时长越界·家族跨族·pool 素材存在性), 全过才落侧车 (失败不入脏值).
    # 契约见 docs/api.md #58.
    @server.PromptServer.instance.routes.post("/h3_batch/seg_candidates")
    async def _h3_seg_candidates(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"ok": False, "error": "缺少参数 sid"}, status=400)
        # count: int 且 ∈[2,5]; bool 是 int 子类 — 显式拒 (否则 True 静默变 1).
        count = body.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or not (2 <= count <= 5):
            return web.json_response(
                {"ok": False, "error": "count 必须是 2-5 的整数 (拒布尔/小数/字符串)"},
                status=400)
        base = body.get("base")
        if base is None:
            base = {}   # 缺省 = 不带任何覆盖跑 (空对象等同缺省, 契约 #58)
        if not isinstance(base, dict):
            return web.json_response({"ok": False, "error": "base 必须是对象"}, status=400)

        if "段落时长" in base:
            try:
                batch_core._seg_duration_frames(base["段落时长"])
            except ShotError as e:
                return web.json_response({"ok": False, "error": "段落时长越界: %s" % e},
                                         status=400)
        _b_pool = base.get("pool")
        if _b_pool is not None and not isinstance(_b_pool, dict):
            return web.json_response({"ok": False, "error": "pool 必须是对象"}, status=400)
        _b_res = base.get("resources")
        if _b_res is not None and not isinstance(_b_res, dict):
            return web.json_response({"ok": False, "error": "resources 必须是对象"}, status=400)
        if isinstance(_b_res, dict) and any(
                not isinstance(v, str) for v in _b_res.values() if v is not None):
            return web.json_response({"ok": False, "error": "resources 值必须是字符串"}, status=400)
        _b_lora = base.get("lora")
        if _b_lora is not None and (not isinstance(_b_lora, dict)
                                    or any(not isinstance(v, dict) for v in _b_lora.values())):
            return web.json_response({"ok": False, "error": "lora 必须是 {文件名: 对象}"}, status=400)
        _b_pt = base.get("prompt_text")
        if _b_pt is not None and (not isinstance(_b_pt, str) or not _b_pt.strip()):
            return web.json_response({"ok": False, "error": "prompt_text 必须是非空字符串"},
                                     status=400)
        # #78 B 路径 (S-5): 同 #57 — 客户端 scope 剔除, 写 prompt_text 时恒打标 segment.
        base.pop("prompt_text_scope", None)
        if _b_pt is not None:
            base["prompt_text_scope"] = "segment"

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        if not isinstance(data.get(sid), dict):
            return web.json_response({"ok": False, "error": "段不存在: %s" % sid}, status=400)

        # 家族跨族 (双点位之一 · 端点写时): 同 #57 — 模板家族 vs base.resources.unet
        # 闲时批 B: 判族与引擎同源改结构判型 (_unet_family_conflict), 见 helper docstring。
        if isinstance(_b_res, dict):
            _new_unet = _b_res.get("unet")
            if isinstance(_new_unet, str) and _new_unet.strip():
                _wf_path = str(data.get("_workflow", "") or "")
                if _unet_family_conflict(_wf_path, _new_unet):
                    return web.json_response({
                        "ok": False,
                        "error": "家族跨族: 模板 %s 与覆盖值 %r 互斥 (ref2v↔fl2v)"
                                 % (os.path.basename(_wf_path), _new_unet)}, status=400)

        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                         status=409)
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"}, status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        csv_path = str(data.get("_csv_path", "") or "").strip() or ""
        if not csv_path or not os.path.exists(csv_path):
            return web.json_response({"ok": False, "error": "csv_path 不可用: %r" % csv_path},
                                     status=400)
        input_dir = str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory()
        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": input_dir, "server_input_dir": input_dir,
                "server_output_dir": folder_paths.get_output_directory(),
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                **_seg_pools_kwargs(data),  # 批 K: 段池回灌
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        folder = os.path.dirname(os.path.abspath(mp))

        # pool 素材存在性 (既有资产解析口径 _resolve_file): 缺 → 400, 侧车不入脏值
        if isinstance(_b_pool, dict):
            for _kind, _slots in _b_pool.items():
                if not isinstance(_slots, dict):
                    return web.json_response(
                        {"ok": False, "error": "pool.%s 必须是 {槽号: 路径}" % _kind}, status=400)
                for _slot, _val in _slots.items():
                    if not _val:
                        continue
                    try:
                        eng._resolve_file(_val)
                    except ShotError as e:
                        return web.json_response(
                            {"ok": False, "error": "pool 素材不存在: %s" % e}, status=400)

        # estimate = count × 该段历史 elapsed_sec; 无历史 → null (另含一次整片重拼未计入 —
        # 全仓无拼接时长留痕, 不造数; 文案归 GUI)
        estimate = None
        try:
            _el = float(data[sid].get("elapsed_sec"))
            if _el > 0:
                estimate = round(count * _el, 1)
        except (TypeError, ValueError):
            estimate = None

        # base 落侧车 (校验全过才写; 持久精修值 — candidates 结束后留盘, 与 #57 同语义)
        if base:
            try:
                batch_core._seg_overrides_set(folder, eng._csv_stem() or task_id, sid, base)
            except OSError as e:
                return web.json_response({"ok": False, "error": "sidecar_write_failed: %s" % e},
                                         status=500)
        group = "cand_%s" % time.strftime("%Y%m%d_%H%M%S")

        # 后台线程: 串行 count 次; 前 N-1 次跳末次重拼 (一次成片); 第 i 条失败继续跑后续;
        # 成功条目经 _append_reruns_ledger 记账 (reason=candidate + candidates_group);
        # 收尾写组终态 (锁内), 轮询判定见 #58。
        def _do_run():
            seqs, failed = [], 0
            try:
                for i in range(count):
                    try:
                        results = eng.rerun_multi_shots_in_folder(
                            folder, [sid], skip_finalize=(i < count - 1))
                    except Exception as e:
                        failed += 1
                        print("[H3Batch] seg_candidates 第 %d/%d 条异常: %s: %s"
                              % (i + 1, count, type(e).__name__, e), flush=True)
                        continue
                    seg_res = results.get(sid) if isinstance(results, dict) else None
                    _seq = None
                    if isinstance(seg_res, tuple) and seg_res[0] and seg_res[1]:
                        _seq = _append_reruns_ledger(mp, [sid], results,
                                                     reason="candidate",
                                                     candidates_group=group)
                    if isinstance(_seq, int):
                        seqs.append(_seq)
                        print("[H3Batch] seg_candidates %s 第 %d/%d 条入账: seq=%d"
                              % (group, i + 1, count, _seq), flush=True)
                    else:
                        failed += 1
                        _err = (seg_res[2] if isinstance(seg_res, tuple)
                                and len(seg_res) > 2 else "")
                        print("[H3Batch] seg_candidates %s 第 %d/%d 条失败: %s"
                              % (group, i + 1, count, _err or "未产出产物"), flush=True)
            finally:
                def _mut_runs(existing):
                    if not isinstance(existing, dict) or not existing:
                        return None
                    existing.setdefault("_candidate_runs", []).append({
                        "group": group, "sid": sid, "count": count,
                        "seqs": list(seqs), "failed": failed,
                        "time": time.time(), "done": True,
                    })
                    return existing
                try:
                    _manifest_write(mp, _mut_runs)
                except OSError as e:
                    print("[H3Batch] seg_candidates 组终态写入失败: %s" % e, flush=True)
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_run, daemon=True)
            _active.start()
        return web.json_response({
            "ok": True, "started": True, "task_id": task_id, "sid": sid,
            "count": count, "group": group, "estimate_seconds": estimate,
        })


    # V1.13h 第四波 T2 (#59) 候选裁决端点 — body = {task_id, sid, seq, action}.
    # accept = 磁盘交换 (方案 v2.1 A1 承重墙修正): 先腾空目标名 (现行件 _keep_old 逐个
    # 改走 — 次序钉死: 全部改走后才能落名, 否则同名占位致 Windows rename 抛错) →
    # 采纳件去 _old_NN 回原导出名 → 改名事件过 _apply_renames_to_manifest (账本跟随) →
    # 段级 files/seed/tail_frame/status 换 → 触发整片重拼 (manifest 驱动: 读写
    # manifest[sid].files, 与产物命名无关 — 成片含采纳件). 目标已是现行 → no-op 成功
    # (幂等). discard = 条目 discarded=true (文件不动; 现行/已采纳条目 400 拒).
    # 契约见 docs/api.md #59.
    @server.PromptServer.instance.routes.post("/h3_batch/candidate_decide")
    async def _h3_candidate_decide(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"ok": False, "error": "缺少参数 sid"}, status=400)
        seq = body.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int):
            return web.json_response({"ok": False, "error": "seq 必须是整数"}, status=400)
        action = str(body.get("action", "") or "").strip()
        if action not in ("accept", "discard"):
            return web.json_response({"ok": False, "error": "action 必须是 accept 或 discard"},
                                     status=400)

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        seg = data.get(sid)
        if not isinstance(seg, dict):
            return web.json_response({"ok": False, "error": "段不存在: %s" % sid}, status=400)

        reruns = data.get("_reruns") if isinstance(data.get("_reruns"), list) else []
        entry = next((e for e in reruns
                      if isinstance(e, dict) and e.get("seq") == seq), None)
        files = entry.get("files") if isinstance(entry, dict) else None
        if not isinstance(files, dict) or sid not in files:
            return web.json_response(
                {"ok": False, "error": "seq %d 不存在或不属于段 %s" % (seq, sid)}, status=400)
        folder = os.path.dirname(os.path.abspath(mp))
        cand_bn = os.path.basename(str(files.get(sid) or ""))
        if not cand_bn or not os.path.isfile(os.path.join(folder, cand_bn)):
            return web.json_response(
                {"ok": False, "error": "候选文件盘上不存在: %s" % (cand_bn or files.get(sid))},
                status=400)
        _cur_files = seg.get("files") if isinstance(seg.get("files"), list) else []
        cur_bn = os.path.basename(str(_cur_files[0])) if _cur_files else ""
        if action == "discard" and (cand_bn == cur_bn or seg.get("accepted_seq") == seq):
            return web.json_response(
                {"ok": False, "error": "discard 现行/已采纳条目: seq=%d (防 manifest 指向被废弃版本)" % seq},
                status=400)
        if action == "accept" and entry.get("discarded"):
            return web.json_response(
                {"ok": False, "error": "accept 已废弃条目: seq=%d" % seq}, status=400)

        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                         status=409)
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"}, status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        if not _decide_lock.acquire(blocking=False):
            return web.json_response(
                {"ok": False, "error": "decide_busy: 已有候选决策在执行, 请稍候"},
                status=409)
        try:
            if action == "discard":
                def _mut_discard(existing):
                    if not isinstance(existing, dict) or not existing:
                        return None
                    for e in existing.get("_reruns") or []:
                        if isinstance(e, dict) and e.get("seq") == seq:
                            e["discarded"] = True
                            break
                    return existing
                try:
                    _manifest_write(mp, _mut_discard)
                except OSError as e:
                    return web.json_response({"ok": False, "error": "manifest_write_failed: %s" % e},
                                             status=500)
                return web.json_response({"ok": True, "action": "discard", "seq": seq})

            if cand_bn == cur_bn:
                # 幂等: 目标已是该段现行 (重复 accept 同一条) — no-op 成功
                return web.json_response({"ok": True, "action": "accept", "seq": seq,
                                          "current_file": cand_bn})

            mode = str(data.get("_mode", "") or "").strip()
            if not mode:
                mode = "拼接" if "_concat" in data else "分镜"
            workflow_path = str(data.get("_workflow", "") or "").strip() or ""
            if not workflow_path or not os.path.exists(workflow_path):
                workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
            csv_path = str(data.get("_csv_path", "") or "").strip() or ""
            if not csv_path or not os.path.exists(csv_path):
                return web.json_response({"ok": False, "error": "csv_path 不可用: %r" % csv_path},
                                         status=400)
            input_dir = str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory()
            try:
                eng = build_batch_engine_from_params({
                    "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                    "input_dir": input_dir, "server_input_dir": input_dir,
                    "server_output_dir": folder_paths.get_output_directory(),
                    "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                    "on_fail": "继续", "archive_dir": "",
                    "resources_list": data.get("_resources_raw", "") or "",
                    "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                    "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
                    **_seg_pools_kwargs(data),  # 批 K: 段池回灌
                })
            except ShotError as e:
                return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
            eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
            eng.manifest_path = mp
            eng.run_dir = folder

            # 磁盘交换 (次序钉死: 先腾空目标名 → 再落名). 腾空集 = _folder_matches 全集 ∪
            # manifest 现行件 (导出文件名 ≠ sid 时前者空集 — 真实 A_baseline 形态, 现行件
            # 仍须腾空, 否则被顶替件与采纳件并存且 manifest 指向不唯一).
            final_bn = re.sub(r"_old_\d+(\.mp4)$", r"\1", cand_bn)
            rename_log = []
            try:
                # 1.13j T1: 腾空集扩展至 {sid, export_base} 双前缀 — 导出文件名 ≠ sid 时
                # (真实 A_baseline 形态) 用 _cur_files 反解出导出基名, _folder_matches 命中
                # 同前缀所有现行形态遗留件一并腾空.
                sweep = set(H3BatchEngine._folder_matches(
                    folder, sid,
                    export_base=H3BatchEngine._export_base_from_files(_cur_files)))
                if cur_bn and cur_bn != cand_bn and os.path.isfile(os.path.join(folder, cur_bn)):
                    sweep.add(cur_bn)
                for fn in sorted(sweep):
                    new_p = H3BatchEngine._keep_old(os.path.join(folder, fn))
                    rename_log.append((fn, os.path.basename(new_p)))
                # 采纳件当前名 (腾空链上解析: 采纳件若也被 _keep_old 改走, 须链式找回)
                _cand_now = cand_bn
                for old, new in rename_log:
                    if _cand_now == old:
                        _cand_now = new
                if _cand_now != final_bn:
                    os.rename(os.path.join(folder, _cand_now), os.path.join(folder, final_bn))
                    rename_log.append((_cand_now, final_bn))
            except OSError as e:
                return web.json_response({"ok": False, "error": "swap_failed: %s" % e}, status=500)

            seed = (entry.get("seeds") or {}).get(sid) if isinstance(entry.get("seeds"), dict) else None
            try:
                # 1.14 M6: ffmpeg 抽帧走 to_thread — 严禁在 async 端点同步跑 subprocess
                # (同 concat/create 先例), 否则 accept 期间 status/history 轮询整体卡死.
                tail_frame = await asyncio.to_thread(
                    eng._extract_last_frame, os.path.join(folder, final_bn))
            except Exception:
                print("[H3Batch] candidate_decide 尾帧提取失败: %s" % traceback.format_exc(),
                      flush=True)
                tail_frame = None

            def _mut_accept(existing):
                if not isinstance(existing, dict) or not existing:
                    return None
                eng._apply_renames_to_manifest(existing, rename_log)
                s = existing.get(sid)
                if not isinstance(s, dict):
                    return None
                s["status"] = "success"   # 末次失败段 (failed dict) 经 accept 恢复现行
                s["files"] = [final_bn]
                if seed is not None:
                    s["seed"] = seed
                if tail_frame:
                    s["tail_frame"] = tail_frame
                s["accepted_seq"] = seq
                return existing
            try:
                _manifest_write(mp, _mut_accept)
            except OSError as e:
                return web.json_response({"ok": False, "error": "manifest_write_failed: %s" % e},
                                         status=500)

            # 触发整片重拼 (manifest 驱动: 读写 manifest[sid].files) — 成片含采纳件;
            # 重拼失败不回滚交换 (产物/账本已一致, 重拼可人工重跑), 仅留日志.
            try:
                manifest = read_manifest_safe(mp)[0] or {}
                # 1.14 M6: 整片重拼 (ffmpeg concat) 同上走 to_thread, 不阻塞事件循环.
                await asyncio.to_thread(
                    eng._rebuild_concat, manifest, eng._parse_shots(eng._parse_rows()))
            except Exception:
                print("[H3Batch] candidate_decide 整片重拼失败: %s" % traceback.format_exc(),
                      flush=True)
            return web.json_response({"ok": True, "action": "accept", "seq": seq,
                                      "current_file": final_bn})
        finally:
            _decide_lock.release()


    # V1.13k T3: #60 候选组进度轮询 — GET ?task_id=&group=&output_dir=.
    # 只读不触 _RESERVED_KEYS; manifest._candidate_runs 末条组记录 (append 序即最新),
    # 坏条目 (非 dict) 跳过. 契约见 docs/api.md #60.
    @server.PromptServer.instance.routes.get("/h3_batch/candidate_runs")
    async def _h3_candidate_runs(request):
        task_id = str(request.query.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "missing_task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        group = str(request.query.get("group", "") or "").strip()
        if not group:
            return web.json_response({"ok": False, "error": "missing_group"}, status=400)
        output_dir = _status_output_dir(request.query.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir_not_found"}, status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        runs = data.get("_candidate_runs")
        if not isinstance(runs, list):
            runs = []
        # 同名组取最后一条 (append 序即最新); 非 dict 坏条目跳过
        last = None
        for e in runs:
            if isinstance(e, dict) and e.get("group") == group:
                last = e
        if last is None:
            return web.json_response(
                {"ok": True, "task_id": task_id, "group": group,
                 "found": False, "done": False})
        return web.json_response({
            "ok": True, "task_id": task_id, "group": group,
            "found": True,
            "done": bool(last.get("done")),
            "sid": last.get("sid"),
            "count": last.get("count"),
            "seqs": last.get("seqs"),
            "failed": last.get("failed"),
            "time": last.get("time"),
        })


    # V1.13h 段级重绘 (Fun ControlNet inpaint) 端点 — body = {task_id, sid, mask_path,
    # prompt_text?, strength?, keep_seed?, output_dir?, input_dir?}.
    # 错误信封 {ok:false, error, detail?}; 400 参数/资源缺失/锚点缺失; 404 manifest 不存在;
    # 409 active_busy / finalizing_busy / concat_busy; trash 内 400 task_in_trash.
    # 默认换新种子; keep_seed=true 钉死 manifest 段 seed + 恒定微扰 (与 #7 同款).
    # 复用 _rerun_generate_shot_in_folder 单段重跑 (prompt_override=重绘图 + prompt_text_override=新提示词).
    # 账本: _reruns 追加, reason="inpaint", 附加字段 mask_source/strength/source_video.
    @server.PromptServer.instance.routes.post("/h3_batch/rerun_inpaint")
    async def _h3_rerun_inpaint(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)

        sid = str(body.get("sid", "") or "").strip()
        if not sid:
            return web.json_response({"ok": False, "error": "缺少参数 sid"}, status=400)

        mask_path = str(body.get("mask_path", "") or "").strip()
        if not mask_path:
            return web.json_response({"ok": False, "error": "缺少参数 mask_path"}, status=400)
        # 熔断裁决收尾: 相对路径统一按 server_input_dir 解析 (契约 (2) 语义),
        # 使存在性/防越权/入仓复制全链同口径, 关闭 isabs 门外的 cwd 绕过窗口.
        if not os.path.isabs(mask_path):
            mask_path = os.path.join(folder_paths.get_input_directory(), mask_path)

        prompt_text = body.get("prompt_text", None)
        if prompt_text is not None and not isinstance(prompt_text, str):
            return web.json_response({"ok": False,
                                      "error": "prompt_text 必须为字符串"}, status=400)
        # prompt_text 缺省 = None (后续从 manifest[sid].final_prompt 取数)

        strength_raw = body.get("strength", 1.0)
        try:
            strength = float(strength_raw)
        except (TypeError, ValueError):
            return web.json_response({"ok": False,
                                      "error": "strength 必须为浮点数, 实: %r" % strength_raw},
                                     status=400)
        if not (0.0 <= strength <= 1.0):
            return web.json_response({"ok": False,
                                      "error": "strength 须 ∈ [0.0, 1.0], 实: %r" % strength},
                                     status=400)

        keep_seed = bool(body.get("keep_seed", False))

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)

        seg = data.get(sid)
        if not isinstance(seg, dict):
            return web.json_response({"ok": False,
                                      "error": "段不存在: %s" % sid}, status=400)
        # 1.14c C3 (E3 候选 A "放开"): void 段不再挡 — 可重绘; 新 take 恒落
        # pending (C1 规则①). (原 void 闸门已移除.)
        if seg.get("status") != "success":
            return web.json_response({"ok": False,
                                      "error": "sid %s 状态非 success, 不可重绘" % sid},
                                     status=400)

        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                         status=409)
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"},
                                         status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        # prompt_text 缺省 → 走该段原 prompt (基底不动, 蒙版外由 Fun ControlNet source_video 锚定)
        if prompt_text is None:
            prompt_text = seg.get("final_prompt") or ""
            if not prompt_text:
                return web.json_response({"ok": False,
                                          "error": "manifest[%s].final_prompt 缺失, 需显式 prompt_text" % sid},
                                         status=400)

        # 熔断裁决收尾: 防越权前移至存在性检查之前 — 安全检查先行,
        # 不存在的越权路径不得被 mask_not_found 提前拦截 (Z:/ 越权场景实测教训).
        # mask_path 落 server_input_dir 或 output_dir 树内才放行; realpath+normcase
        # 防前缀近邻绕过与 Junction/软链绕过 (I2-2nd M5: abspath 不解析符号链接,
        # 软链文本路径可在树内但真目标在树外; 改 realpath 后契约与 api.md:1113 一致).
        # (mask_path 已在参数校验后统一绝对化, 此处直接校验.)
        server_input_dir = folder_paths.get_input_directory()
        _si_root = os.path.normcase(os.path.realpath(server_input_dir))

        def _within(resolved, root):
            r = os.path.normcase(os.path.realpath(resolved))
            return r == root or r.startswith(root + os.sep)

        if not _within(mask_path, _si_root) and not _within(
                mask_path, os.path.normcase(os.path.realpath(output_dir))):
            return web.json_response({
                "ok": False,
                "error": "mask_path_out_of_scope: 必须在 server_input_dir 或 output_dir 树内, 实 %s"
                % mask_path}, status=400)

        # 蒙版 + 原段 mp4 资源校验
        if not os.path.isfile(mask_path):
            return web.json_response({"ok": False,
                                      "error": "mask_not_found: %s" % mask_path},
                                     status=400)
        try:
            with open(mask_path, "rb") as _f:
                _f.read(1)
        except OSError as e:
            return web.json_response({"ok": False,
                                      "error": "mask_unreadable: %s (%s)" % (mask_path, e)},
                                     status=400)

        seg_files = seg.get("files") or []
        seg_run_dir = seg.get("run_dir") or ""
        if not seg_files or not seg_run_dir:
            return web.json_response({"ok": False,
                                      "error": "source_video_missing: 段 %s files/run_dir 缺失" % sid},
                                     status=400)
        source_video_abs = os.path.join(seg_run_dir, seg_files[0])
        if not os.path.isfile(source_video_abs):
            return web.json_response({"ok": False,
                                      "error": "source_video_missing: %s" % source_video_abs},
                                     status=400)

        # 入仓处理: 复制到 server_input_dir/inpaint_<task>_<sid>_<field>_<ts>.<ext>
        # source_video_abs: 已在产物定位 (run_dir + files[0]), output_dir 子树天然合法
        # — 不需复检; 与 mask 分开处理.
        _ts = int(time.time())
        _mask_base = os.path.basename(mask_path)
        _mask_stem, _mask_ext = os.path.splitext(_mask_base)
        mask_basename = "inpaint_%s_%s_mask_%d%s" % (task_id, sid, _ts, _mask_ext or ".png")
        _dst_mask = os.path.join(server_input_dir, mask_basename)
        try:
            shutil.copy2(mask_path, _dst_mask)
        except OSError as e:
            return web.json_response({"ok": False,
                                      "error": "mask 入仓失败: %s" % e}, status=400)

        _src_base = os.path.basename(source_video_abs)
        _src_stem, _src_ext = os.path.splitext(_src_base)
        source_video_basename = "inpaint_%s_%s_src_%d%s" % (task_id, sid, _ts, _src_ext or ".mp4")
        _dst_src = os.path.join(server_input_dir, source_video_basename)
        try:
            shutil.copy2(source_video_abs, _dst_src)
        except OSError as e:
            return web.json_response({"ok": False,
                                      "error": "source_video 入仓失败: %s" % e}, status=400)

        mode = str(data.get("_mode", "") or "").strip()
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        workflow_path = str(data.get("_workflow", "") or "").strip() or ""
        if not workflow_path or not os.path.exists(workflow_path):
            workflow_path = _resolve_workflow_path(DEFAULT_WORKFLOW)
        csv_path = str(data.get("_csv_path", "") or "").strip() or ""

        try:
            eng = build_batch_engine_from_params({
                "mode": mode, "workflow_path": workflow_path, "csv_path": csv_path,
                "input_dir": str(body.get("input_dir", "") or "").strip() or folder_paths.get_input_directory(),
                "server_input_dir": folder_paths.get_input_directory(),
                "server_output_dir": folder_paths.get_output_directory(),
                "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                "on_fail": "继续", "archive_dir": "",
                "resources_list": data.get("_resources_raw", "") or "",
                "resource_overrides": data.get("_overrides_raw", "{}") or "{}",
                "lora_overrides": data.get("_lora_overrides_raw", "{}") or "{}",
            })
        except ShotError as e:
            return web.json_response({"ok": False, "error": "engine_init: %s" % e}, status=400)
        eng.client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"
        eng.manifest_path = mp
        folder = os.path.dirname(os.path.abspath(mp))

        # 单段重跑: keep_seed 走 manifest 段 seed + 微扰; 默认新种子
        seed_override = None
        if keep_seed:
            try:
                seed_override = int(float(seg.get("seed") or 0)) or None
            except (TypeError, ValueError):
                seed_override = None
        perturb = H3BatchEngine._make_prompt_perturb() if seed_override is not None else ""

        # 模型 patch basename: 固定 (老板 2026-09-15 夜令只下一份 int8 模型)
        MODEL_PATCH_NAME = "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors"

        def _do_rerun():
            try:
                # V1.13h T4 修复: 直接复用 _rerun_generate_shot_in_folder (prompt_override
                # 透传), 由该函数走完整的 _wait_shot + _collect_output_retry + manifest
                # 持久化 + 改名回滚链 (与 #7 rerun_edit_prompt 同款可靠路径).
                # 在调用前先做一次 convert + _apply_global 让 eng._prompt 落地, 然后
                # 组装 inpaint prompt 替换 self._prompt, 再透传给 _rerun_generate_shot_in_folder
                # 的 prompt_override 参数 — 该函数内部在 _apply_global 之后再覆盖一次
                # self._prompt (T2 写入), 完整覆盖我们的组装结果.
                eng.convert(seed=0)
                eng._prompt = eng._apply_global(eng._prompt, eng._parse_global(eng._parse_rows()))
                inpaint_prompt, asm_report = _rerun_inpaint_assemble_prompt(
                    eng._prompt,
                    next_nid=(max((int(nid) for nid in eng._prompt.keys()
                                   if str(nid).lstrip("-").isdigit()),
                                  default=0) + 1),
                    mask_rel=mask_basename,
                    source_video_rel=source_video_basename,
                    strength=strength,
                    model_patch_name=MODEL_PATCH_NAME,
                )
                if not asm_report.get("injected"):
                    print("[H3Batch] rerun_inpaint 组装失败: %s" % asm_report.get("reason"),
                          flush=True)
                    return

                ok, files, err = eng._rerun_generate_shot_in_folder(
                    folder, sid,
                    seed_override=seed_override,
                    prompt_perturb=perturb,
                    prompt_text_override=prompt_text,
                    prompt_override=inpaint_prompt,
                )
                if not (ok and files):
                    print("[H3Batch] rerun_inpaint 渲染失败: sid=%s err=%s"
                          % (sid, err), flush=True)
                    return
                # ---- 段二: Ref2VA 口型回锚 + 色彩对齐 (V1.13h 第二波两段式) ----
                # 段一产物是中间产物; 段二失败降级记段一产物 + lipsync_failed (T0 契约).
                final_files = files
                lipsync_failed = False
                try:
                    final_files = _rerun_lipsync_stage2(
                        eng, task_id=task_id, sid=sid, folder=folder,
                        stage1_abs=os.path.join(folder, files[0]),
                        origin_video_rel=source_video_basename,
                        server_input_dir=server_input_dir,
                        prompt_text=prompt_text, seed=seg.get("seed"))
                except Exception as _le:
                    lipsync_failed = True
                    print("[H3Batch] rerun_inpaint 段二口型回锚失败(降级记段一产物): %s"
                          % _le, flush=True)
                # 账本登记: reason="inpaint" (复用 #5/#7 同款 ledger 写入路径) + 附加字段
                results = {sid: (True, final_files, ""),
                           "_seeds": {sid: seed_override}}
                _append_reruns_ledger(
                    eng.manifest_path, [sid], results,
                    reason="inpaint",
                    prompt_edited=bool(prompt_text != (data.get(sid, {})
                                                     .get("final_prompt") or "")),
                    res_changed=False,
                )
                # 附加字段 (与 #5/#7 同级键, 不破坏旧账本解析).
                # V1.14 D M4: 改走 _manifest_write (per-path 锁 + 原子替换) —
                # 并发 (concat / candidate_decide / seg_edit 等其他端点同时写同
                # manifest) 不丢更新, 写中断不产生截断的半文件 (.tmp + os.replace).
                # mutator 基于 _manifest_write 传入的 existing 重算 (锁内读最新
                # 快照, 与 _append_reruns_ledger 同源; 旧 impl 启动期裸读 _mdict
                # 与并发写分离, 整写覆盖窗口内并发写入的 _reruns/_concat_history
                # 等其它键).
                try:
                    def _mut_inpaint_extra(existing):
                        if not isinstance(existing, dict) or not existing:
                            return None
                        _rr = existing.get("_reruns") or []
                        if not _rr:
                            return None
                        _rr[-1]["mask_source"] = mask_basename
                        _rr[-1]["strength"] = float(strength)
                        _rr[-1]["source_video"] = source_video_basename
                        _rr[-1]["pipeline"] = "v2_lipsync"
                        if lipsync_failed:
                            _rr[-1]["lipsync_failed"] = True
                        # 段 files 指向终版 (段一中间产物已 _old 留档, 不留悬空引用)
                        existing.setdefault(sid, {})["files"] = list(final_files)
                        return existing
                    _manifest_write(eng.manifest_path, _mut_inpaint_extra)
                except Exception as _e:
                    print("[H3Batch] rerun_inpaint 附加账本字段写入失败: %s" % _e,
                          flush=True)
            except Exception:
                print("[H3Batch] rerun_inpaint 后台异常: %s" % traceback.format_exc(),
                      flush=True)
            finally:
                _clear_active()

        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_do_rerun, daemon=True)
            _active.start()
        return web.json_response({
            "ok": True,
            "started": True,
            "task_id": task_id,
            "sid": sid,
            "mask_source": mask_basename,
            "strength": float(strength),
            "source_video": source_video_basename,
        })


    # V1.11 批 1 T5: 手动拼接端点 — body = {task_id, rerun_seq?, mode, dry_run?}.
    # 错误信封 {ok:false, error, detail?}; 400 参数; 404 manifest 不存在;
    # 409 active_busy / concat_busy. dry_run=true → 只返回预览不写盘.
    # 执行: 独立模块级 _concat_lock + _concat_running 标志 (不进 _active / 不进 cancel);
    # 双向互斥 — submit/rerun 发起前查 _concat_running → 409 (防 Windows os.rename
    # 与 ffmpeg 读段产物冲突). 产物落任务文件夹 (=manifest 所在 run_dir) 不落新 run_dir;
    # 产物名 concat_manual_<时间戳>_global.mp4 / concat_manual_<时间戳>_inherit_r<seq>.mp4;
    # 每次新文件不覆盖 (既有的 concat_*.mp4 不动). 写账本 _concat_history 走 _manifest_write.
    @server.PromptServer.instance.routes.post("/h3_batch/concat")
    async def _h3_concat(request):
        global _concat_running
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "body 须为 JSON 对象"}, status=400)

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)

        mode = str(body.get("mode", "") or "").strip()
        if mode not in ("global", "inherit"):
            return web.json_response({"ok": False,
                                      "error": "mode 必须为 global 或 inherit, 实: %r" % mode}, status=400)
        rerun_seq_raw = body.get("rerun_seq")
        if rerun_seq_raw is None:
            rerun_seq = None
        else:
            try:
                rerun_seq = int(rerun_seq_raw)
            except (TypeError, ValueError):
                return web.json_response({"ok": False,
                                          "error": "rerun_seq 须为整数, 实: %r" % rerun_seq_raw}, status=400)
            if rerun_seq < 1:
                return web.json_response({"ok": False,
                                          "error": "rerun_seq 须 ≥ 1, 实: %d" % rerun_seq}, status=400)

        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        # V1.11 批 1 T6: 回收站只读约束 (concat 端点)
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)

        # 组合计算 (纯函数 — 单测覆盖)
        try:
            cc = compute_concat_map(data, rerun_seq, mode)
        except ValueError as e:
            return web.json_response({"ok": False, "error": "compute_concat_map: %s" % e}, status=400)

        # active 互斥 (拼接前检查, 双向 ①): active 占用 → 409
        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                         status=409)

        # 批1 E5 (#50 报障): 请求来源标记 — 仅认 "postfx" (GUI 后期收口自动拼接);
        # 其余值/缺省一律按未传处理 → 不带 source 的既有路径零变化 (旧客户端/
        # GUI1.3/手动拼接兼容). 值经闭包传入后台线程, 仅成功写账本时置位.
        postfx_source = str(body.get("source", "") or "").strip() == "postfx"

        dry_run = bool(body.get("dry_run", False))

        # dry_run 路径 — 不写盘不写账本不构造引擎 + 不动 _concat_running (read-only,
        # 可与其他请求并发 — 用户可在拼接进行中预览基准/回退段)
        if dry_run:
            payload = {
                "ok": True,
                "dry_run": True,
                "map": cc["map"],
                "base_desc": cc["base_desc"],
                "fell_back": cc["fell_back"],
                "fallback_sids": cc["fallback_sids"],
            }
            if cc["missing"]:
                payload["missing"] = cc["missing"]
            return web.json_response(payload)

        # V1.11 收尾异步化 T2: 收尾中拒接手动拼接 (dry_run 之上已放行, 此处只拦执行路径 —
        # 防 ffmpeg 读段产物 vs 归档搬运竞态)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)

        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        # 执行前缺件 400 (与 dry_run missing 同一逻辑, execute 复查) — 不持锁
        if cc["missing"]:
            return web.json_response({"ok": False, "error": "缺件段, 无法拼接",
                                      "missing": cc["missing"]}, status=400)
        if not cc["map"]:
            return web.json_response({"ok": False, "error": "映射为空, 无可拼接段"}, status=400)

        # 产物路径: 任务文件夹 = manifest 所在 run_dir (=dirname(mp)); 不落新 run_dir
        task_folder = os.path.dirname(os.path.abspath(mp))
        suffix = "_global" if mode == "global" else "_inherit_r%d" % rerun_seq if rerun_seq else "_inherit"
        # 唯一性: 秒级时间戳 + 毫秒尾 (秒内连发也能区分)
        ts = time.strftime("%Y%m%d_%H%M%S") + ("_%03d" % (int(time.time() * 1000) % 1000))
        out_path = os.path.join(task_folder, "concat_manual_%s%s.mp4" % (ts, suffix))

        # V1.11 批 1 T5 P1-E: 拼接锁 check+set 合并到同一临界区 (防 TOCTOU 竞态 —
        # 旧实现 check 释放锁后 ~100 行才置位, 两个并发请求可双双通过检查;
        # 现合并: 锁内既检又置, 释放即已 _concat_running=True). 清理 (后台
        # 线程 finally) 同样在锁内, 防并发 set/clear 撞车.
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 已有拼接在运行, 请稍候"},
                                         status=409)
            _concat_running = True

        # 持锁执行 — 拼接不可中断, ffmpeg 自身收敛 (T1 既有 _concat_videos 300s timeout)
        def _do_concat():
            global _concat_running
            _rerun_warn = None
            try:
                # 批1 E8: 测试钩子 — 环境变量 H3_CONCAT_TEST_DELAY_MS 设值时, 拼接启动后
                # 先 sleep 该毫秒数再继续 (验收构造手段: 异步拼接耗时下限断言)。
                # 默认未设 = 零行为变化; 不进请求协议。放 try 内首句 — 解析异常走
                # 通用兜底, finally 清 _concat_running 不留死锁。
                _test_delay_ms = os.environ.get("H3_CONCAT_TEST_DELAY_MS", "")
                if _test_delay_ms:
                    time.sleep(int(_test_delay_ms) / 1000.0)
                # #26 T2 裁决②: 拼前自查 — 曾后期 + 有留痕 + 有失效段 → 补跑该段
                # 后期再拼 (互斥 try/finally 清除; 三闸+_concat_lock 之后·实际拼接
                # 之前)。零命中 (无后期/无失效段/无留痕) → (None, None), 拼接路径
                # 与现状逐比特一致。
                _pf_fresh, _rerun_warn = _concat_rerun_stale_postfx(
                    mp, data, list(cc["map"].keys()), output_dir, task_id)
                # 审核阻断项 1: 补跑成功才换重读快照消费 pick_level (入口快照不含
                # 补跑产物, 不重读则补跑白补); 失败/零命中保持入口快照 → 该段按
                # 现状回落原件。
                segs = data  # 闭包捕获的 disk snapshot
                if isinstance(_pf_fresh, dict):
                    segs = dict(data)
                    segs["_postfx"] = _pf_fresh
                if _rerun_warn:
                    print("[H3Batch] 拼接补跑告警: %s" % _rerun_warn, flush=True)
                # 拼绝对路径 (段 run_dir + map[sid] 文件名)
                parts = []
                for sid, fn in cc["map"].items():
                    seg = segs.get(sid) or {}
                    run_dir = seg.get("run_dir") or ""
                    p = os.path.join(run_dir, fn) if run_dir else fn
                    parts.append(p)
                # 1.14b U4a: Y1 消费端取戳 — 读 manifest._postfx 换戳 (U3 预放行 ≤5 行)
                # U6R E4.3②: 层级选择单一落点 (interp → upscale → 原件, kind 级全有全无)
                _pf = segs.get("_postfx") or {}
                if _pf:
                    from postfx_engine import pick_level as _pick_level
                    _sp = [(s, p) for s, p in zip(cc["map"].keys(), parts)]
                    _lvl, parts, _ws = _pick_level(_sp, _pf, task_folder)
                    for _w in _ws:
                        print("[H3Batch] " + _w, flush=True)
                # 构造最小引擎实例 — _concat_videos 依赖 self.output_dir / self._bgm / self._bgm_mix_mode
                # / self.run_dir. 用 build_engine_from_params 共享构造路径, 跟 _active 路径解耦
                # (不注册到 _active, 不阻塞 cancel).
                csv_path = str(data.get("_csv_path", "") or "").strip()
                if not csv_path:
                    input_dir = folder_paths.get_input_directory()
                    exact = os.path.join(input_dir, "%s.csv" % task_id)
                    csv_path = exact if os.path.exists(exact) else ""
                eng = build_engine_from_params({
                    "mode": "拼接",
                    "workflow_path": "",
                    "csv_path": csv_path,
                    "input_dir": folder_paths.get_input_directory(),
                    "server_input_dir": folder_paths.get_input_directory(),
                    "server_output_dir": output_dir,
                    "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                    "on_fail": "继续", "archive_dir": "",
                    "resources_list": "[]", "resource_overrides": "{}", "lora_overrides": "{}",
                })
                # _concat_videos 内部写 _concat_list.txt 落 run_dir (run() 路径惯例)
                eng.run_dir = task_folder
                eng._bgm_path = ""
                eng._bgm_mix_mode = "replace"
                ok, _cok_err = eng._concat_videos(parts, out_path)
                if not ok:
                    print("[H3Batch] 手动拼接失败: %s" % _cok_err, flush=True)
                    return
                # 写账本 _concat_history (map 记 basename, output 记绝对路径)
                # V1.11 批 1 T5 缺陷 A (P0): rerun_seq 是替换集来源事实, global 带
                # rerun_seq 时账本必须记 N (=组合来源可查 — PRD 验收 #12); inherit 无
                # rerun_seq (纯按最近快照) 时记 null. 不再按 mode 区分.
                map_snapshot = dict(cc["map"])
                ledger_entry = {
                    "time": time.time(),
                    "task_id": task_id,
                    "rerun_seq": rerun_seq,
                    "mode": mode,
                    "map": map_snapshot,
                    "output": out_path,
                }
                # 批1 E5 (#50): source=postfx 的拼接成功 → 条目打 postfx:true
                # (GUI 成片取径识别"后期版成片"; 失败路径上方已 return 不写条目).
                if postfx_source:
                    ledger_entry["postfx"] = True
                # #26 T2: 补跑失败 → 落账告警 (原因随该次拼接记录; 成功不记)
                if _rerun_warn:
                    ledger_entry["postfx_rerun_failed"] = _rerun_warn

                def _mut(existing):
                    if not isinstance(existing, dict) or not existing:
                        return None
                    history = existing.get("_concat_history")
                    if not isinstance(history, list):
                        history = []
                    history.append(ledger_entry)
                    existing["_concat_history"] = history
                    return existing
                try:
                    _manifest_write(mp, _mut)
                except OSError as e:
                    print("[H3Batch] _concat_history 写入失败: %s" % e, flush=True)
            except Exception:
                print("[H3Batch] 后台手动拼接异常: %s" % traceback.format_exc(), flush=True)
            finally:
                with _concat_lock:
                    _concat_running = False

        # 启动后台线程 (异常兜底清标志)
        try:
            asyncio.create_task(asyncio.to_thread(_do_concat))
        except Exception:
            with _concat_lock:
                _concat_running = False
            raise
        return web.json_response({
            "ok": True,
            "started": True,
            "task_id": task_id,
            "mode": mode,
            "rerun_seq": rerun_seq,
            "map": cc["map"],
            "base_desc": cc["base_desc"],
            "fell_back": cc["fell_back"],
            "fallback_sids": cc["fallback_sids"],
            "output": out_path,
            # 1.11a 波 3 T2: started 响应回产物所在任务目录 (=manifest 所在 run_dir),
            # 不再承诺产物文件 (异步执行, 报文件路径属欺骗). 前端 toast 据此显示
            # "拼接已启动, 完成后在任务目录查看: <task_folder>". 旧调用方仍可用 output 字段.
            "task_folder": task_folder,
        })


    # V1.11 批 1 T4: submit 直接提交端点 — body = INPUT_TYPES 同名全参 (排除
    # rerun_folder/quick_data); 缺省走节点 INPUT_TYPES 默认. 预检全量走
    # asyncio.to_thread (不阻塞事件循环) — 复用引擎既有 preflight + 补模板
    # JSON 解析 (引擎 preflight 不覆盖). active 占用 → 409. 通过预检 →
    # build_engine_from_params → 后台线程 eng.run() (与节点路径同款:
    # _active_lock 下 _active_engine=eng + daemon 线程 + _clear_active finally).
    # stem 已存在 + CSV 指纹同 → 走引擎既有 skip_done 语义 (submit 端点不重复
    # 实现断点续跑, 由 eng.run() 内 _csv_fingerprint 比对处理). 响应
    # {ok:true, started:true, stem, mode}.
    # 1.14b U4a: 历史记录手动触发 — 后处理端点 (POST /h3_batch/postfx)
    # 防护集 (照 concat 端点四重):
    #   1) 回收站只读 → 400
    #   2) active 批互斥 → 409
    #   3) _finalizing_hit 收尾互斥 → 409
    #   4) _postfx_lock + _postfx_running 并发 → 409
    # X5 全戳批再请求同 kind → 400 (W6)
    # Y1 落 manifest._postfx (run_postfx_batch 直接写盘, 端点层不写)
    @server.PromptServer.instance.routes.post("/h3_batch/postfx")
    async def _h3_postfx(request):
        global _postfx_running
        # D1 批: postfx check+set 临界区原子化 (I2-D1 / I1-X1, 抄 concat 先例 3533-3538).
        # 旧实现 check 在此释放锁后 ~190 行才置位 (中间夹两个 await: probe_media_meta
        # + 模板 convert 自请求), 双击双双通过检查各起一遍 → 双跑. 修法: check+set
        # 同一锁内 (锁释放即已 _postfx_running=True), 所有提前 return / except 路径
        # 由 finally 统一复位 (claimed 标) — 防 claim 后 400/404 提前 return 导致端点
        # 永久 409 (I2-D2(b) 同源, 本笔一并防御).
        claimed = False
        try:
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"ok": False,
                                          "error": "body 解析失败 (期望 JSON)"}, status=400)
            task_id = (body.get("task_id") or "").strip() if isinstance(body, dict) else ""
            if not task_id:
                return web.json_response({"ok": False,
                                          "error": "task_id 缺失"}, status=400)
            kinds = body.get("kinds") or ["upscale", "interp"]
            if not isinstance(kinds, list) or not all(k in ("upscale", "interp") for k in kinds):
                return web.json_response({"ok": False,
                                          "error": "kinds 非法 (允许 ['upscale','interp'])"},
                                         status=400)
            # W9R: postfx_engine 单点导入 (seg_threshold 校验 / items 探测 / 编排复用)
            import postfx_engine as _pe
            # W9R W9-2: 分段阈值 (可选 body 键) — X2 校准期降阈入口。
            # 口径 = parse_seg_threshold: dict, 值数字 (bool 不算), 缺键补默认 60/1500;
            # 非法 (非 dict / 值非数字) → 400 "seg_threshold 非法"。
            seg_threshold = body.get("seg_threshold")
            if seg_threshold is not None:
                try:
                    seg_threshold = _pe.parse_seg_threshold(seg_threshold)
                except ValueError:
                    return web.json_response({"ok": False, "error": "seg_threshold 非法"},
                                             status=400)
            engine_choice = (body.get("engine_choice") or "seedvr2").strip()
            # R-50 (批 M6b T2): 输出参数 (可选 body 键) — 校验按 engine_choice 分档,
            # 口径单一落点 postfx_engine.parse_upscale_params / parse_interp_params:
            #   upscale_params: {mode:"scale",scale:N} | {mode:"target",width:W,height:H}
            #     (rtxvsr 档 scale∈[1.0,4.0] 且 0.1 步; seedvr2 档 (0,8]; W/H 成对整数 ∈[64,8192])
            #   interp_params: {target_fps:F}, F∈[12,120]
            # 违例 → 400 白话; 两键全缺省 = 现状零变化 (plan 两字段 None → 不覆盖模板任何输入)。
            try:
                upscale_params = _pe.parse_upscale_params(body.get("upscale_params"),
                                                          engine_choice)
                interp_params = _pe.parse_interp_params(body.get("interp_params"))
            except ValueError as ex:
                return web.json_response({"ok": False, "error": str(ex)}, status=400)
            sids_param = body.get("sids")  # 可选, list[str]
            output_dir = (body.get("output_dir") or _MOCK_OUTPUT_DIR
                          if "_MOCK_OUTPUT_DIR" in dir() else
                          (body.get("output_dir") or "").strip()
                          or folder_paths.get_output_directory())
            if isinstance(sids_param, list) and all(isinstance(s, str) for s in sids_param):
                sids_filter = set(sids_param)
            else:
                sids_filter = None  # None = 全 manifest 段
            # 1) 回收站只读
            if os.path.isdir(os.path.join(output_dir, ".h3_trash")):
                # 任务在 trash → 400 拒绝 (端点层用 output_dir 子目录检查)
                pass  # 真正在 trash 的 task 由 resolve_manifest_path 失败/400 兜底
            # 2) active 批互斥
            with _active_lock:
                if _active is not None and _active.is_alive():
                    _phase = getattr(_active_engine, "phase", "") or "跑批中"
                    return web.json_response({"ok": False,
                                              "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                             status=409)
            # 3) _finalizing_hit 收尾互斥
            if _finalizing_hit(output_dir):
                return web.json_response({"ok": False,
                                          "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                         status=409)
            # 3.5) D4 批: 双向互斥 — 手动拼接进行中禁启 postfx (I2-2nd H2 第二件事, 防
            # postfx 启动与 _concat_running 并发互写 upscaled/interp 与 manifest._postfx).
            # 抄 concat_busy 在 concat 端点中的反向写法 (concat 端点 3557-3562 已查
            # _postfx_running; 本步对称 — postfx 启动侧查 _concat_running), 实现双向.
            # 锁内仅查阅不改状态, 与既有 409 口径一致. 检查位次: active/finalizing 之后,
            # postfx 自己的 claim 之前 — 拼接未结束则不让 postfx 启动, 反向亦同.
            with _concat_lock:
                if _concat_running:
                    return web.json_response({"ok": False,
                                              "error": "concat_busy: 拼接运行中, 请稍候"},
                                             status=409)
            # 4) D1 批: _postfx_running 临界区 check+set (原子, 抄 concat 先例 3533-3538).
            # 锁内既检又置; 释放即已 _postfx_running=True — 防两个 await 让出锁期间
            # 第二击进锁前 check 见 False → 旧实现的 TOCTOU 窗口.
            with _postfx_lock:
                if _postfx_running:
                    return web.json_response({"ok": False,
                                              "error": "postfx_busy: 后处理运行中, 请稍候"},
                                             status=409)
                _postfx_running = True
                claimed = True
                # 1.14b U4b: 进度快照预填 (total 占位 0; _build_tpl 完成 + items 算得后
                # 在同一 _postfx_lock 内回填 total, 防 postfx_status 读 tearing)
                global _postfx_progress
                _postfx_progress = {
                    "task_id": task_id,
                    "kinds": list(kinds),
                    "total": 0,
                    "time_start": time.time(),
                }
            # resolve manifest
            try:
                mp = resolve_manifest_path(task_id, output_dir)
            except Exception as e:
                return web.json_response({"ok": False,
                                          "error": "resolve_manifest_path 失败: %s" % e},
                                         status=400)
            if not mp or not os.path.isfile(mp):
                return web.json_response({"ok": False,
                                          "error": "task_id %s 不存在 (或不在 output_dir)" % task_id},
                                         status=404)
            # 回收站 read-only 二次校验 (按任务目录相对 .h3_trash)
            mp_norm = os.path.normpath(os.path.abspath(mp))
            trash_dir_norm = os.path.normpath(os.path.abspath(os.path.join(output_dir, ".h3_trash")))
            if trash_dir_norm in mp_norm:
                return web.json_response({"ok": False,
                                          "error": "trash_readonly: 任务在 .h3_trash 回收站, 仅支持 restore 或 purge"},
                                         status=400)
            # 读 manifest
            data, _deg = read_manifest_safe(mp)
            if not isinstance(data, dict):
                return web.json_response({"ok": False,
                                          "error": "manifest 不可读 (损坏/非 dict)"}, status=400)
            # E7 X5 判据 gating (方案 v5 #50-3, I5 跨端保护): 段账本 files 恒为无戳
            # 原件名 → 下方文件名判据恒不命中, 防不住同批重复后期. 请求带能力字段
            # judgment:"manifest" 时改按 manifest._postfx 现值 (权威数据源) 判定:
            # 请求计划段集 (sids 过滤后, 与下方旧判据同一遍历口径) 在请求 kinds
            # 每个 kind 子表均含 → 已后期 400 stamped_already (同款响应形态);
            # 任一 kind 缺任一段 = 未后期 → 放行. 不带 judgment / 值非 "manifest"
            # → 不进本分支, 下方既有文件名判据原样执行 (GUI1.3/拍戏台零回归).
            # _postfx 非 kind 键 (failed/skipped/template_missing/level/status/
            # final_parts/params) 不参与判定 — 只按请求 kinds 取子表.
            if body.get("judgment") == "manifest":
                _pf_map = data.get("_postfx")
                if isinstance(_pf_map, dict):
                    _plan_sids = [sid for sid, info in data.items()
                                  if not sid.startswith("_")
                                  and sid not in _RESERVED_KEYS
                                  and isinstance(info, dict)
                                  and info.get("status") == "success"
                                  and (sids_filter is None or sid in sids_filter)]
                    if _plan_sids and all(
                            isinstance(_pf_map.get(k), dict)
                            and all(sid in _pf_map[k] for sid in _plan_sids)
                            for k in kinds):
                        return web.json_response(
                            {"ok": False,
                             "error": "stamped_already: manifest._postfx 已含请求全部段 kinds=%s 后期记录, 已处理 (X5 防重, W6)" % kinds},
                            status=400)
            # X5: 全戳批再请求同 kind → 400 (W6 防重)
            # R-50: 戳按"当前请求参数"派生 (upscale_params / interp_params; 缺省 None →
            # _x2/_48fps 旧值, 逐字节不变), 判定用 postfx_engine.kind_stamp +
            # has_stamp_token 整词命中 (与编排层 skip 谓词同一落点, 不各写一份)。
            # 同参重跑 → 同戳 → 仍 400 防重; 换参 (已跑 _x2 再请求 ×2.5) → 放行。
            _x5_stamps = {k: _pe.kind_stamp(k, upscale_params if k == "upscale"
                                             else interp_params) for k in kinds}
            files_per_kind = {k: [] for k in kinds}
            for sid, info in data.items():
                if sid.startswith("_") or sid in _RESERVED_KEYS:
                    continue
                if not isinstance(info, dict) or info.get("status") != "success":
                    continue
                if sids_filter is not None and sid not in sids_filter:
                    continue
                files = info.get("files") or []
                if files:
                    name = os.path.basename(files[0])
                    for k in kinds:
                        if _pe.has_stamp_token(os.path.splitext(name)[0], _x5_stamps[k]):
                            files_per_kind[k].append(sid)
            for k in kinds:
                if files_per_kind[k]:
                    # 检查: 若 sids_filter 是 None (全批), 命中数 = 全 success 段 → 全戳
                    total_success = sum(1 for sid, info in data.items()
                                        if not sid.startswith("_")
                                        and sid not in _RESERVED_KEYS
                                        and isinstance(info, dict)
                                        and info.get("status") == "success"
                                        and (sids_filter is None or sid in sids_filter))
                    if total_success > 0 and len(files_per_kind[k]) == total_success:
                        return web.json_response({"ok": False,
                                                  "error": "stamped_already: 该批所有段已含 %s 戳, %s 已处理 (X5 防重, W6)"
                                                           % (_x5_stamps[k], k)},
                                                 status=400)
            # 构造 items 列表 (按 sids_filter 过滤) — W9R W9-1: 逐片 probe_media_meta
            # (duration_s/frame_count) 注入 meta 供长片分段决策 (缺 meta → should_segment 恒
            # False, 分段真机不可达); ffprobe 同步阻塞 → 照 _h3_probe_video_resolution
            # "调用方需走 asyncio.to_thread" 先例下放工作线程。探测失败 → meta 留空不阻断。
            def _build_postfx_items():
                _items = []
                for sid, info in data.items():
                    if sid.startswith("_") or sid in _RESERVED_KEYS:
                        continue
                    if not isinstance(info, dict) or info.get("status") != "success":
                        continue
                    if sids_filter is not None and sid not in sids_filter:
                        continue
                    files = info.get("files") or []
                    if not files:
                        continue
                    f = files[0]
                    rd = info.get("run_dir") or os.path.dirname(mp_norm)
                    if not os.path.isabs(f):
                        f = os.path.normpath(os.path.join(rd, f))
                    _items.append({"sid": sid, "path": f, "name": os.path.basename(f),
                                   "meta": _pe.probe_media_meta(
                                       f, ffprobe_exe=_h3_ffprobe_exe()) or {}})
                return _items
            items = await asyncio.to_thread(_build_postfx_items)
            if not items:
                return web.json_response({"ok": False,
                                          "error": "无可处理段 (status!=success 或 files 空)"},
                                         status=400)
            # R-50: 插帧倍率构造后自检 (M×源fps 越 CreateVideo 节点上界 120 → 整单 400 白话).
            # 探不出源帧率的片不在此拒 — 交编排层按片记 failed + 日志 (审建议 9: 不静默跳过).
            if interp_params and "interp" in kinds:
                for _it in items:
                    _src_fps = _pe.source_fps(_it.get("meta") or {})
                    if not _src_fps:
                        continue
                    try:
                        _pe.interp_plan(interp_params["target_fps"], _src_fps)
                    except ValueError as ex:
                        return web.json_response({"ok": False, "error": str(ex)},
                                                 status=400)
            # 构造最小引擎实例 (照 concat 端点 build_engine_from_params 路径)
            task_folder = os.path.dirname(mp_norm)
            try:
                eng = build_engine_from_params({
                    "mode": "拼接",
                    "workflow_path": "",
                    "csv_path": "",
                    "input_dir": folder_paths.get_input_directory(),
                    "server_input_dir": folder_paths.get_input_directory(),
                    "server_output_dir": output_dir,
                    "port": _own_server_port(), "start_from": 0, "retries": 2, "skip_done": True,
                    "on_fail": "继续", "archive_dir": "",
                    "resources_list": "[]", "resource_overrides": "{}", "lora_overrides": "{}",
                })
            except ShotError as e:
                return web.json_response({"ok": False,
                                          "error": "engine_init: %s" % e}, status=400)
            eng.manifest_path = mp
            eng.run_dir = task_folder
            eng._bgm_path = ""
            eng._bgm_mix_mode = "replace"
            # 加载模板 (U2 落盘 JSON, 优先仓内 docs/)
            _run_postfx_batch = _pe.run_postfx_batch
            # T6: 模板查找 + eng.convert() 整体进工作线程 —— convert() 内部要 HTTP
            # 请求本实例 /object_info, 跑在请求协程里会堵死事件循环 → 自请求无人
            # 应答超时 (真机实证 .tmp/t5_probe_convert_from_thread.py: 同段 convert
            # 放后台线程即成功)。构建单一落点 _build_postfx_templates (#26 T2 起
            # 拼接补跑共用)。
            tpl, _tpl_missing = await asyncio.to_thread(
                _build_postfx_templates, eng, kinds, engine_choice, task_folder)
            if _tpl_missing:
                return web.json_response({"ok": False,
                                          "error": "template_missing: %s" % _tpl_missing},
                                         status=400)
            if not tpl:
                return web.json_response({"ok": False,
                                          "error": "postfx 模板未找到 (期望 h3_postfx_upscale.json + h3_postfx_interp.json 在仓根/docs/证据-1.14b)"},
                                         status=400)
            plan = _pe.plan_from_flags(
                upscale="upscale" in kinds,
                interp="interp" in kinds,
                engine_choice=engine_choice,
                timeout_s=14400,
                seg_threshold=seg_threshold,
                upscale_params=upscale_params,
                interp_params=interp_params,
            )
            # D1 批: 回填 total (锁内, 防 postfx_status 读 tearing; 与旧实现
            # 一次性锁内 total 同语义, 区别仅在总 total 计算时机前置到此处 —
            # claim 后任何提前 return 都不再发生, 故无需额外复位)
            with _postfx_lock:
                if isinstance(_postfx_progress, dict):
                    _postfx_progress["total"] = len(items) * sum(1 for k in kinds if k in tpl)
            def _do_postfx():
                # L1-4: 补 global — 否则 finally 的 _postfx_progress=None 落本函数
                # 局部变量, 模块级快照残留 (postfx_status 端点持续读到旧快照)
                global _postfx_running, _postfx_progress
                try:
                    result = _run_postfx_batch(
                        eng, items, plan, tpl,
                        run_dir=task_folder,
                        upscaled_dir="upscaled", interp_dir="interp",
                    )
                    # 落 manifest._postfx + Y2 分级回退 + U6R E4.3⑤/E4.5 (level/status/
                    # final_parts 路径列表 — 与批路径形态对齐)
                    # W9R-③: 按 kind 合并本轮与上一轮映射 (复跑不抹其它段/其它 kind);
                    # failed/skipped/fallback/level/status 按本轮结果重算, final_parts
                    # 全覆盖才写 (#26 T1; 合并语义见 _merge_postfx_result docstring)
                    # D4 批: 合并写 (I2-2nd H2 第三件事, 防与端点并发写丢更新) —
                    # mutator 接受 _manifest_write 传入的 existing 作底 (锁内最新
                    # 快照), 仅 patch _postfx 块; 其它键 (含并发写者更新) 完整保留。
                    # 落账单一落点 _write_postfx_result (#26 T2 起拼接补跑共用)。
                    def _mut_postfx(existing):
                        return _write_postfx_result(existing, result, kinds,
                                                    upscale_params, interp_params,
                                                    engine_choice, task_folder, items)
                    _manifest_write(mp, _mut_postfx)
                except Exception:
                    print("[H3Batch] 后台 postfx 异常: %s" % traceback.format_exc(), flush=True)
                finally:
                    with _postfx_lock:
                        _postfx_running = False
                        _postfx_progress = None
            threading.Thread(target=_do_postfx, daemon=True).start()
            claimed = False  # 所有权转交 background 线程 finally 复位 (I2-D2 同源保险)
            return web.json_response({
                "ok": True,
                "started": True,
                "task_id": task_id,
                "task_folder": task_folder,
                "kinds": kinds,
                "sids": [it["sid"] for it in items],
            })
        except Exception as ex:
            print("[H3Batch] postfx 端点异常: %s" % traceback.format_exc(), flush=True)
            return web.json_response({"ok": False, "error": "postfx_endpoint_internal: %s" % ex},
                                    status=500)
        finally:
            # D1 批: claim 后任何路径提前 return / except → 复位, 防端点永久 409
            # (与 concat 先例 3624-3626 启动失败复位同源语义).
            if claimed:
                with _postfx_lock:
                    _postfx_running = False
                    _postfx_progress = None

    # 1.14b U4b: 进度查询端点 — GET 只读, 返回当前后处理运行快照.
    # 设计契约: 空闲 → {running:false, current:None}; 运行中 → {running:true, current:{...}}
    # current 字段: task_id / kinds / total / time_start (done/failed 本期不实装, U5+ 回调补).
    # 用 _postfx_lock 一致快照, 避免 reading tearing. 前端 history 列轮询 3s 一次,
    # running 转 false 后用 manifest._postfx 重新拉条目.
    @server.PromptServer.instance.routes.get("/h3_batch/postfx_status")
    async def _h3_postfx_status(request):
        try:
            with _postfx_lock:
                _running = _postfx_running
                _prog = _postfx_progress
            if not _running or not isinstance(_prog, dict):
                return web.json_response({"ok": True, "running": False, "current": None})
            return web.json_response({
                "ok": True,
                "running": True,
                "current": {
                    "task_id": _prog.get("task_id"),
                    "kinds": _prog.get("kinds") or [],
                    "total": _prog.get("total") or 0,
                    "time_start": _prog.get("time_start"),
                }
            })
        except Exception as ex:
            print("[H3Batch] postfx_status 端点异常: %s" % traceback.format_exc(), flush=True)
            return web.json_response({"ok": False, "error": "postfx_status_internal: %s" % ex},
                                    status=500)

    # 批1 E1 (#51 归档端点·方案 v5): 渲染目录归位 — GUI 渲染终态/历史行手动入口发
    # 归档请求, 409 busy 退避重试。五通道前置检查任一命中 → 409 archive_busy:
    #   ① 批在运行 (is_active) 或目标 run_dir 属于当批 (_active_engine.run_dir —
    #     引擎仅全局单批 _active, 无 run_dir 集合);
    #   ② _postfx_running (:89); ③ _concat_running (:86);
    #   ④ _finalizing 注册命中 — 命中键=引擎输出根 (经 _status_output_dir 解析·
    #     concat 端点 :4052-4056 同款; 绝不用 run_dir 查 — 注册键是输出根不是 run_dir);
    #   ⑤ _run_postfx_pipeline in-flight 标记 (batch_core 类级·纯防御纵深·与④恒重叠)。
    # 幂等: 批已在 output_root/_archive → {"ok":true,"dest":当前} 不重复搬;
    # all_existing=true 存量模式见下方 E4 分支 (一次性盘点搬运·逐批容错)。
    @server.PromptServer.instance.routes.post("/h3_batch/archive")
    async def _h3_archive(request):
        # 批9 E4: 非 409 分支统一 F1 同款 {ok:false, error:"<code>: <msg>"} —
        # GUI api.js 归一层只认 ok:false 信封 (旧裸 {error} 归一 code:"unknown");
        # 5xx 归一层更只在 ok===false && error!=null 时保体 → 500 的 detail
        # 必须折进 error 串 (加 ok:false 是保 detail 的关键)。
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response(
                {"ok": False, "error": "invalid_json: %s" % e}, status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_body: body 须为 JSON 对象"},
                status=400)

        def _busy(reason):
            # 409 体形态与全仓既有 409 同契约: {ok:False, error:"<code>: <msg>"} 冒号格式
            # (批1 F1) — GUI 归一层只认 ok:false 信封 (旧裸 {error} 归一 code:"unknown",
            # archive_busy 忙判据不命中 → 409 退避重试链路失效)。reason 键保留供排查。
            return web.json_response({"ok": False, "error": "archive_busy: %s" % reason,
                                      "reason": reason}, status=409)

        # ===== E4 存量模式 (批1 E4·#51): all_existing=true 一次性搬运存量 =====
        # 盘点 = batch_core.scan_existing_batch_dirs (两层批夹入搬运队; 一层老布局
        # 批夹只盘不搬计 skipped_legacy_layout; 指针壳只盘不搬不删计 already_archived;
        # _archive/.h3_trash 不入盘点 — 幂等: 已归档批原位只剩壳, 天然不重复搬)。
        # 与单批路径的关系: 全局通道 ②③④⑤ 仍整单 409 (拼接/后期/收尾在飞不可盘点);
        # 通道① 活动批改逐批跳过计 skipped_busy — 存量模式逐批容错不整体中断。
        # 逐批走单批归档完全同路径: archive_run_dir 内 E3 GC + 搬运 + repath +
        # 原子写回 + 空父夹清理 + 指针; 单批失败 (如文件占用) 入 failed 清单继续。
        if bool(body.get("all_existing", False)):
            bulk_out = _status_output_dir(body.get("output_dir", ""))
            if not os.path.isdir(bulk_out):
                return web.json_response(
                    {"ok": False,
                     "error": "output_dir_not_found: output_dir 不存在"},
                    status=400)
            with _postfx_lock:
                if _postfx_running:
                    return _busy("postfx")
            with _concat_lock:
                if _concat_running:
                    return _busy("concat")
            if _finalizing_hit(bulk_out):
                return _busy("finalizing")
            if getattr(_active_engine, "_postfx_pipeline_running", False):
                return _busy("postfx_pipeline")
            live, legacy, shells = batch_core.scan_existing_batch_dirs(bulk_out)

            def _trash_file_count():
                t = os.path.join(os.path.abspath(bulk_out), _TRASH_DIR_NAME)
                if not os.path.isdir(t):
                    return 0
                return sum(1 for n in os.listdir(t)
                           if os.path.isfile(os.path.join(t, n)))

            trash_before = _trash_file_count()
            archived, skipped_busy, failed = 0, 0, []
            for run_dir, mp in live:
                # ① 活动批 — 跳过计数, 不 409 整体中断 (存量逐批容错)
                if is_active():
                    skipped_busy += 1
                    continue
                # ①后半兜底: run_dir 属于当批 (_active_engine 残留窗) — 单批同款判属
                if _active_engine is not None:
                    eng_rd = getattr(_active_engine, "run_dir", "")
                    if eng_rd:
                        try:
                            rd_nc = os.path.normcase(os.path.abspath(run_dir))
                            eng_nc = os.path.normcase(os.path.abspath(eng_rd))
                            if rd_nc == eng_nc or rd_nc.startswith(eng_nc + os.sep):
                                skipped_busy += 1
                                continue
                        except (OSError, ValueError):
                            pass
                stem = os.path.basename(
                    mp)[len("h3_batch_manifest_"):-len(".json")]
                try:
                    batch_core.archive_run_dir(run_dir, bulk_out, mp)
                    archived += 1
                except Exception as ex:
                    print("[H3Batch] 存量归档单批失败 (继续下一批): %s\n%s"
                          % (run_dir, traceback.format_exc()), flush=True)
                    failed.append({"task_id": stem, "run_dir": run_dir,
                                   "error": str(ex)})
            return web.json_response({
                "ok": True, "archived": archived, "skipped_busy": skipped_busy,
                "skipped_legacy_layout": len(legacy),
                "already_archived": len(shells), "failed": failed,
                "trash_moved": _trash_file_count() - trash_before})

        task_id = str(body.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response(
                {"ok": False, "error": "missing_task_id: 缺少参数 task_id"},
                status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response(
                {"ok": False, "error": "invalid_task_id: task_id 格式非法"},
                status=400)
        output_dir = _status_output_dir(body.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response(
                {"ok": False,
                 "error": "output_dir_not_found: output_dir 不存在"},
                status=400)

        # ① 批在运行 (引擎全局单批 _active)
        if is_active():
            return _busy("active")
        # ② postfx 运行期 — 各自独立锁内一致读 (同 _postfx_busy 查阅写法)
        with _postfx_lock:
            if _postfx_running:
                return _busy("postfx")
        # ③ 拼接独占锁 — ffmpeg 在飞搬运必撞读段产物
        with _concat_lock:
            if _concat_running:
                return _busy("concat")
        # ④ 收尾注册窗 — 命中键=引擎输出根 (NOT run_dir, 见函数头注)
        if _finalizing_hit(output_dir):
            return _busy("finalizing")
        # ⑤ in-flight 标记 (防御纵深)
        if getattr(_active_engine, "_postfx_pipeline_running", False):
            return _busy("postfx_pipeline")
        # 寻批 (两层结构 glob·排除 _archive) — busy 优先于 404
        kind, run_dir, mp = batch_core.locate_run_dir_for_archive(task_id, output_dir)
        if kind is None:
            return web.json_response(
                {"ok": False, "error": "not_found: 未找到该 task_id 的批次",
                 "task_id": task_id},
                status=404)
        # ①后半: 目标 run_dir 属于当批 — is_active 已拦活批, 此处兜底
        # _active_engine 残留窗 (收尾期) 与目标重叠的边缘 (单 run_dir 前缀判属)
        if kind == "live" and _active_engine is not None:
            eng_rd = getattr(_active_engine, "run_dir", "")
            if eng_rd:
                try:
                    rd_nc = os.path.normcase(os.path.abspath(run_dir))
                    eng_nc = os.path.normcase(os.path.abspath(eng_rd))
                    if rd_nc == eng_nc or rd_nc.startswith(eng_nc + os.sep):
                        return _busy("active")
                except (OSError, ValueError):
                    pass
        # 幂等: 已归档 → 返回当前 dest 不重复搬
        if kind == "archived":
            return web.json_response({"ok": True, "dest": run_dir})
        # 搬运 (repath 补齐+原子写回+空父夹清理+指针文件在 helper 内)
        try:
            dest = batch_core.archive_run_dir(run_dir, output_dir, mp)
        except Exception as ex:
            print("[H3Batch] archive 端点搬运失败: %s\n%s"
                  % (run_dir, traceback.format_exc()), flush=True)
            return web.json_response(
                {"ok": False, "error": "archive_failed: %s" % str(ex)},
                status=500)
        return web.json_response({"ok": True, "dest": dest})

    @server.PromptServer.instance.routes.post("/h3_batch/submit")
    async def _h3_submit(request):
        global _active, _active_engine
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response(
                {"ok": False, "error": "invalid_json: %s" % e,
                 "execution_error": _submit_error_detail("submit_guard", "invalid_json", e)},
                status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "body 须为 JSON 对象",
                 "execution_error": _submit_error_detail(
                     "submit_guard", "invalid_body", "body 须为 JSON 对象")},
                status=400)
        # 显式排除 rerun_folder / quick_data (task_id 寻址取代 + 表单 generate_csv+submit 已覆盖)
        body.pop("rerun_folder", None)
        body.pop("quick_data", None)

        # V1.12 批 L 波 1 批次 D T6: session_id 校验 (与 #50/#51/#52 同码 invalid_session_id).
        # 仅在用户提交了非空 session_id 时校验; 空/缺省走"不写该键"原路径 (旧任务零回归).
        if "session_id" in body:
            _sid_in = body["session_id"]
            if _sid_in is None or _sid_in == "":
                body.pop("session_id", None)
            else:
                from . import llm_sessions as _llm_sessions
                if not isinstance(_sid_in, str) or not _llm_sessions.SESSION_ID_RE.fullmatch(_sid_in):
                    return web.json_response({
                        "ok": False, "error": "invalid_session_id", "detail": _sid_in,
                        "execution_error": _submit_error_detail(
                            "submit_guard", "invalid_session_id",
                            "session_id 非法: %s" % _sid_in),
                    }, status=400)

        # F-N1 P0: server_output_dir 必须等于 ComfyUI 实际输出根 — 产物恒落
        # folder_paths 根, 假根提交会渲染成功但收尾 missing_file (bugkb case-20260905-0003).
        # 仅当用户显式传入 (非空字符串) 时校验; 留空 / 脏值回落走既有 or get_output_directory() 放行.
        _user_out = _clean_path(body.get("server_output_dir"))
        if _user_out:
            _real_out = folder_paths.get_output_directory()
            if os.path.normcase(os.path.abspath(_user_out)) != os.path.normcase(os.path.abspath(_real_out)):
                _msg = ("server_output_dir 与 ComfyUI 实际输出根不一致: 您填的=%s, 实际输出根=%s。"
                        "请改为实际输出根或留空（留空自动使用实际输出根）"
                        % (_user_out, _real_out))
                return web.json_response({
                    "ok": False,
                    "error": _msg,
                    "execution_error": _submit_error_detail(
                        "submit_guard", "server_output_dir_mismatch", _msg),
                }, status=400)

        # V1.11 批 5 P0: 端口钉死 — GUI 仓 submit.js:108 硬编码 port:0, 引擎若
        # 透传 0, convert() 触发 _detect_port() 8188-8200 自动探测, 8189 等其他
        # 实例存活时**渲染错发到生产实例** (批 4 4.7 实锤: 产物落 Shared root + 账本
        # 分裂 missing). 此处在 submit 路由层对 port==0/缺省注入 _own_server_port()
        # (与 rerun/quick 四处先例同款 — __init__.py:1344/1633/1780/1982); 显式
        # port>0 仍尊重 (远程实例 / 跨机调试场景). 节点共享构造行 :618 不动 —
        # 改它会连带改节点 run 语义, 是红线.
        try:
            _port_in = body.get("port", 0)
            _port_in_int = int(_port_in) if _port_in not in (None, "", "0") else 0
        except (TypeError, ValueError):
            _port_in_int = 0
        if not _port_in_int:
            body["port"] = _own_server_port()

        def _build_and_preflight():
            """返 (eng, errs, stage) — stage 是首个失败阶段的 (node_type, 短码, 原文),
            供 :4588 预检未通过响应附 execution_error 汇总键 (detail 数组原样不动)."""
            try:
                eng = build_batch_engine_from_params(body)
            except ShotError as e:
                return None, ["engine_init: %s" % e], ("engine_init", "engine_init", str(e))
            errs = []
            stage = None
            # 模板 JSON 可解析 (引擎 preflight 不覆盖此条)
            if eng.workflow_path and os.path.exists(eng.workflow_path):
                try:
                    with open(eng.workflow_path, encoding="utf-8") as f:
                        json.load(f)
                except (OSError, ValueError) as e:
                    errs.append("模板 JSON 解析失败: %s" % e)
                    stage = ("template_parse", "template_parse", str(e))
            # 引擎既有 preflight (CSV 存在/列数/重复 ID/素材存在/LoRA 别名/...)
            errs.extend(eng.preflight())
            if errs and stage is None:
                stage = ("preflight", "preflight_rejected", "\n".join(errs))
            return eng, errs, stage

        try:
            eng, errs, _stage = await asyncio.to_thread(_build_and_preflight)
        except Exception as e:
            return web.json_response(
                {"ok": False, "error": "preflight 异常: %s" % e,
                 "execution_error": _submit_error_detail(
                     "preflight", "preflight_exception", e)}, status=400)
        if errs:
            # detail 数组原样保留 (预检弹窗链路唯一入口·不加第二入口)
            _nt, _code, _msg = _stage or ("preflight", "preflight_rejected", "\n".join(errs))
            return web.json_response(
                {"ok": False, "error": "预检未通过", "detail": errs,
                 "execution_error": _submit_error_detail(_nt, _code, _msg)}, status=400)


        # active 互斥 (持锁期间检查; 短临界区)
        with _active_lock:
            if _active is not None and _active.is_alive():
                _phase = getattr(_active_engine, "phase", "") or "跑批中"
                return web.json_response({"ok": False,
                                          "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase}, status=409)
        # V1.11 fix2 (fix5): 收尾异步化后补一刀 — 同 output_dir 收尾在跑 (即 _finalizing 含 output_dir)
        # 拒接新批 (搬运/拼接期间段产物 vs 新批 rename 冲突); 不同 output_dir 放行 (不同目录无冲突)。
        # 不在 _concat_lock 临界区内 (语义不同: _concat_lock 只覆盖手动拼接子步, _finalize_lock 整体收尾)
        try:
            _req_out = os.path.normcase(os.path.abspath(
                _clean_path(body.get("server_output_dir"), folder_paths.get_output_directory())))
            with _finalize_lock:
                if _finalizing.get(_req_out):
                    return web.json_response({"ok": False,
                                              "error": "finalizing_busy: 上一批正在收尾(搬运/拼接), 请稍候"}, status=409)
        except Exception:
            pass
        # V1.11 批 1 T5: 拼接锁双向互斥 — submit 跑批期间重命名段产物 vs 拼接读冲突
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"}, status=409)
        # 1.14 D4: postfx 运行期查 — 抽 _postfx_busy() helper.
        _busy_resp = _postfx_busy()
        if _busy_resp is not None:
            return _busy_resp

        # T3-甲 (2026-09-22 老板裁"先丙后甲"): 建档批提交时三端点任务活跃 → 409
        # (原建档段内检查前移至 handler — 建档挪后台线程后线程内 409 不可达).
        if getattr(eng, "_enrollment_enabled", False):
            from .batch_core import enrollment_should_run as _esr
            if _esr(eng):
                from . import threepov as _tp_mod
                if any(getattr(_tp_mod, f, False)
                       for f in ("_THREEPOV_ACTIVE", "_SCENE_CANVAS_ACTIVE",
                                 "_ITEM_CANVAS_ACTIVE")):
                    return web.json_response({"ok": False,
                                              "error": "active_busy: 三端点任务进行中, 请稍候"}, status=409)

        client_id = getattr(server.PromptServer.instance, "client_id", "") or "h3-batch"

        def _enroll_and_record():
            """T3-甲: 建档段 (原 handler 内同步等待体, 2026-09-22 后台化).
            线程内运行: claim→读卡→render_sheet 直调→结果记录→release.
            """
            # V1.12b v4 T4: pre-batch 建档钩子 — 仅 submit 主路径 (start()/queue/repeat 不建档, 方案 M1)。
            # 守卫 (方案 M1b M-1): errs 已判空 + eng._enrollment_enabled; 缺一即跳过。
            # 原子占位 + try/finally (方案 M1b M-2): _try_claim 检查+置位同一临界区, 渲染失败也清。
            # 端点互斥 (_THREEPOV/_SCENE_CANVAS/_ITEM_CANVAS_ACTIVE 互斥块首部 getattr busy)
            # 防建档期三端点双写同 output_dir / archive_images/<主卡>。
            # 1.12b v4 T-D3 修正笔: 顺序 ①查活动/_active → 409 ②claim busy ③渲染 ④release.
            # 1.12b v4 T-D1 修正笔: render_sheet 不再接收批引擎 (_eng=eng), 自建临时引擎实例,
            #                       批引擎的 _save_manifest / manifest_path 零接触.
            # 1.12b v4 T-D2 修正笔: 建档渲染包进 asyncio.to_thread, 不阻塞事件循环.
            # 1.12b v4 T-D4 修正笔: 读主卡首 subject_look 行 media 解析为 ref_src → i2v 参照;
            #                       无 media → 走 t2v (与既有 _first_look_media 同口径).
            _enr_status = "done"
            _enr_err = ""
            if getattr(eng, "_enrollment_enabled", False):
                from .batch_core import (  # 延迟导入, 与 _build_and_preflight 内部 import 同口径
                    enrollment_route_kind, enrollment_primary_card_name, enrollment_should_run,
                )
                from . import threepov as _threepov_mod
                if enrollment_should_run(eng):
                    # T3-甲: 原 ① _active/三端点 409 检查前移至 handler (本函数运行于
                    # _active 线程内 — 自查恒真不可达; 三端点检查见 submit 互斥区).
                    kind = enrollment_route_kind(eng)
                    primary = enrollment_primary_card_name(eng)
                    # 1.14 整改批 C C3: 卡名漏斗统一 — 建档口 (写卡 JSON 处) 过 _h3_safe_filename (单一漏斗,
                    # 与 batch_core 读面 / asset_copy / archive_purge 同函数). 同 raw 名经任何一面落到同
                    # 一 cleaned 名 → PNG 目录 = 卡 JSON = 资产操作名 三方一致; 漏斗后路径无 Windows 非法
                    # 字符 → 不再 threepov.py:1107 makedirs OSError 硬失败 (同源卡名两侧失败语义对齐).
                    # 注: 边界 (raw 全清洗后为空) 由上方 enrollment_should_run (batch_core 已读侧漏斗)
                    # 兜 False 提前返, 不会到达此处 — 故不再此处加 if not primary 守卫.
                    primary = _h3_safe_filename(primary)
                    # ② claim _enrollment_busy — T3-甲后本函数在 _active 线程内, claim 失败
                    # 仅手工置位/测试可达: 日志+跳过建档照跑批 (软失败不挡批, 老板既裁口径).
                    if not _try_claim_enrollment_busy():
                        print("[H3Batch] 建档跳过 (enrollment_busy 被占): 主卡待建档但占位失败, 继续跑批",
                              flush=True)
                        _enr_status = "claim_failed"
                        return
                    _enr_status = "done"
                    _enr_err = ""
                    try:
                        # 读主卡 → desc 全行拼合 (与 _extract_card_desc 同口径) + ref 按 kind 分派
                        # 1.14 整改批 C C7: 旧实现只取首 subject_look 行 → 场景/道具卡取错参照
                        # (取到人物外貌), desc 也只取片段. 现按 kind 分派 (character→look;
                        # scene→scene; item→prop), desc 扫全部 rows, 文字与参照皆空跳过.
                        _input_root = (getattr(eng, "_server_input_dir", None)
                                       or getattr(eng, "_input_dir", None)
                                       or getattr(eng, "input_dir", None) or "")
                        _archive_card = os.path.join(_input_root, "asset_library",
                                                     "archive_docs", primary + ".json")
                        _card_obj = None
                        try:
                            with open(_archive_card, encoding="utf-8") as _f:
                                _card_obj = json.load(_f)
                        except (OSError, ValueError):
                            _card_obj = None
                        _card_desc = ""
                        _card_ref_src = ""
                        # F36 E2 (方案-F36 §3.5): ref 收集改 _collect_card_media 多槽列表
                        # (与三端点同底座 — 建档即享多槽). 每项按候选目录解析为绝对路径
                        # (input 根同根 / asset_library 池), 解析不到的行剔除.
                        _card_refs = []
                        if isinstance(_card_obj, dict):
                            # desc: 全部 rows 非空 desc 用 '；' 拼接 (与 threepov._extract_card_desc 同口径)
                            _desc_parts = []
                            for _r in (_card_obj.get("rows") or []):
                                if isinstance(_r, dict):
                                    _d = str(_r.get("desc") or "").strip()
                                    if _d:
                                        _desc_parts.append(_d)
                            _card_desc = "；".join(_desc_parts)
                            # ref: 按 kind 白名单行序多槽收集 (_collect_card_media); media
                            # 文件存在 → 解析为槽源 (D4 补实同款候选目录).
                            for _media_name, _usage in _threepov_mod._collect_card_media(
                                    _card_obj, kind):
                                _media_name = str(_media_name or "").strip()
                                for _candidate in (
                                        os.path.join(_input_root, _media_name),
                                        os.path.join(_input_root, "asset_library",
                                                     "asset_images", _media_name),
                                ):
                                    if os.path.isfile(_candidate):
                                        _card_refs.append((_candidate, _usage))
                                        break
                            _card_ref_src = _card_refs[0][0] if _card_refs else ""
                        # 文字与参照皆空 → 跳过 (不建空卡; 不调 render_sheet, 但继续走批)
                        if not _card_desc and not _card_ref_src:
                            print("[H3Batch] 建档跳过: 主卡 '%s' 文字与参照皆空 (kind=%s)"
                                  % (primary, kind), flush=True)
                            _enr_status = "empty"
                        else:
                            # dst_png: archive_images/<主卡>/<kind>.png (与既有卡名模式固定名一致)
                            _dst_png = os.path.join(_input_root, "asset_library", "archive_images",
                                                    primary, _threepov_mod._kind_to_card_png_name(kind))
                            _manifest_prefix = _threepov_mod._kind_to_manifest_prefix(kind)
                            _task_prefix = _threepov_mod._kind_to_task_prefix(kind)
                            _output_subdir = _threepov_mod._kind_to_output_subdir(kind)
                            # ③ T3-甲: 本函数已在后台线程 — render_sheet 直调 (原 await
                            # to_thread 挂住 submit 响应 1-2 分钟即 T3 根因).
                            # render_sheet 自建临时引擎 (不传 _eng=eng) → 批引擎的 _save_manifest /
                            # manifest_path 零接触. 即使渲染抛异常, render_sheet 内 try/finally 也
                            # 还原其自建引擎的 monkey-patch (与 T-D1 修正笔同款).
                            try:
                                _threepov_mod.render_sheet(
                                    kind, prompt_text=_card_desc, ref_src=_card_ref_src,
                                    extra_refs=_card_refs,
                                    card_name=primary, dst_png=_dst_png,
                                    manifest_prefix=_manifest_prefix, task_prefix=_task_prefix,
                                    output_subdir=_output_subdir,
                                )
                            except Exception as _e:
                                # ④ 不抛回 — 建档软失败也不挡批 (老板裁: 跑批优先).
                                # 软失败写入 _RENDER_SHEET_SOFT_ERR 已被 render_sheet 内部消化,
                                # 这里只接硬失败 (建档引擎 run()/CSV 异常等).
                                _enr_status = "failed"
                                _enr_err = str(_e)[:200]
                                print("[H3Batch] 建档异常: %s" % traceback.format_exc(), flush=True)
                    finally:
                        # ④ release _enrollment_busy + 结果落模块级 (契约定点二)
                        global _enrollment_result
                        _enrollment_result = {"stem": stem, "status": _enr_status,
                                              "error": _enr_err}
                        _release_enrollment_busy()


        def _do_run():
            try:
                eng.client_id = client_id
                eng.run()
            except Exception:
                print("[H3Batch] 后台 submit 异常: %s" % traceback.format_exc(), flush=True)
            finally:
                _clear_active()

        def _enroll_then_run():
            # T3-甲: 建档→跑批 串联后台线程 — submit 立即回包 (原 await 建档渲染
            # 1-2 分钟挂响应 = T3 根因, 报告: T3忙窗吞吐-根因定位报告-2026-09-22.md).
            try:
                _enroll_and_record()
            finally:
                _do_run()

        stem = os.path.splitext(os.path.basename(eng.csv_path))[0]
        # #40: 受理成功即清零模块级 _last_run_init_error — 同 stem 陈值不得透传到本次
        # status (enrollment 先例从不清零的陈值窗由此堵).
        batch_core._last_run_init_error = {}
        with _active_lock:
            _active_engine = eng
            _active = threading.Thread(target=_enroll_then_run, daemon=True)
            _active.start()
        return web.json_response({
            "ok": True,
            "started": True,
            "stem": stem,
            "mode": eng.mode,
            # 1.13e: 直接 HTTP submit 无前端黄条链路 → 预检黄条随响应回传
            # (读取先例: batch_core.py 节点路径 getattr(engine, "_preflight_warns", []))
            "warns": list(getattr(eng, "_preflight_warns", None) or []),
        })


    @server.PromptServer.instance.routes.post("/h3_batch/preview_prompt")
    async def _h3_preview_prompt(request):
        # 表单实时预览(2.6): 服务端 merged_prompt 求值最终发送文本, JS 零拼装
        # 2.9: body 加 lang(中文/英文/en/english); 非法/缺省回落中文
        # V1.4 T3: 含 "workflow" 键时走 enrich_blocks 路径(代写句 + P9 锚定);
        # 缺 workflow 键或 pool/pool_usage 缺省 → 行为与 V1.3 完全一致
        # V1.4 T4: 响应加 checks (errs + warns) — 与 text 走同组输入(check_prompt_rules 同参数)
        # 缺 workflow 键时 checks 必空(向后兼容: 既有客户端读 text 不受影响)
        # 批 A 节点 1: 内联编排链收口到 prompt_assembler.assemble_final_prompt 单一入口
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        lang_v = str(body.get("lang", "") or "").strip().lower()
        lang = "en" if lang_v in ("英文", "en", "english") else "zh"
        row = body.get("row") or {}
        global_p = str(body.get("global") or "")
        # 批 A 后小迭代: 三勾选 — body 三新键优先; 旧 negative 兼容映射(true=三全勾, false=全不勾)
        neg_music = bool(body.get("negative_music", False))
        neg_dialogue = bool(body.get("negative_dialogue", False))
        neg_text = bool(body.get("negative_text", False))
        negative_legacy = body.get("negative")
        if negative_legacy is not None and not (neg_music or neg_dialogue or neg_text):
            # 三键全 False 且旧键给出时, 旧键触发兼容映射
            if bool(negative_legacy):
                neg_music = neg_dialogue = neg_text = True
        negative = bool(neg_music or neg_dialogue or neg_text)
        # T2: 请求体 audio 字段(缺省 None=V1.5 行为, 即逐字节一致); [["配乐","x"],...] 形态
        audio_raw = body.get("audio")
        if isinstance(audio_raw, list) and audio_raw:
            audio = [tuple(it) for it in audio_raw if isinstance(it, (list, tuple)) and len(it) == 2]
        else:
            audio = None
        # 1.13f: 引擎侧锚定行覆盖入口 — body 可选 string 多行文本; 缺省/空/纯空白 = 零变
        _sa_raw = body.get("subject_anchors")
        subject_anchors_for_assembler = _sa_raw if isinstance(_sa_raw, str) else None
        checks = {"errs": [], "warns": []}
        # 装配入口参数 (含 workflow 路径 / 不含 workflow 路径 = V1.3 行为零变)
        scene_nos = None
        pool_for_assembler = None
        pool_usage_for_assembler = None
        cmode_for_assembler = None
        pic9_present_for_assembler = False
        cast_spec_for_assembler = None
        # 1.14 批 L5: 段池锚定行容器 (workflow 分支内现算; 无 workflow 键 → 恒空)
        seg_anchor_rows_pv = []
        # 批 C 节点 C-II part-2 (C3): 端点 is_fl2v 默认 False (无 workflow 键时 = V1.3 行为零变)
        is_fl2v = False
        # 批 A 节点 4 (4a): 空集镜兜底反转黄条容器 — 复用 audio_warns 同源通道;
        # 提升到 workflow 分支外, 避免无 workflow 路径 (V1.3 零变) UnboundLocalError
        subject_filter_warns = []
        if "workflow" in body:
            workflow = body.get("workflow") or ""
            mode = body.get("mode", "分镜")
            # 槽 key 边界归一化为 int: HTTP JSON 序列化后 key 恒为字符串, 引擎侧 enrich_blocks
            # 用 int 查找, 字符串 key 会双重注入 P9 锚定 / 漏掉手写去重。修复: 端点边界规范化。
            pool = _norm_slots(body.get("pool") or {})
            pool_usage = _norm_slots(body.get("pool_usage") or {})
            prev_available = bool(body.get("prev_available"))
            # 1.14 整改批 I I2b: 端点判族单源 — fl2v 对齐句开关 (GUI 预览契约, 见下方
            # 透传处) 与下游 cmode 同吃这一次判族, 端点不再独立调 fl2v 判定助手.
            _wf_fam = _template_mode(workflow) if workflow else None
            is_fl2v = (_wf_fam == "fl2v")
            # 下游消费面 (check_prompt_rules / assemble_final_prompt / cast 门控) 只分
            # ref2v vs 非 ref2v → i2v/fl2v 归 t2v (批入口即拒; 逐字节零变化, 同 I2a 口径)
            cmode = _endpoint_cmode(_wf_fam)
            # 1.11b 波2 T5: 自定义模式逐行 eff_mode — 按行内 CONCAT_FLAG_COL 列值派生,
            # 分镜/拼接模式下与 mode 逐字节相等 (零回归).
            _cfc_v = str(row.get(CONCAT_FLAG_COL) or "").strip()
            eff_mode = "拼接" if (mode == "拼接" or (mode == "自定义" and _cfc_v == "是")) else "分镜"
            pic9_present = (eff_mode == "拼接" and (
                prev_available or bool((pool.get("Picture") or {}).get(9))))
            # 批 H2-3: 名字替换 — prompt 与 global 文本里 绑定名 → "Subject N"
            bindings_raw = body.get("bindings") or []
            bindings = (bindings_raw if isinstance(bindings_raw, list) else [])
            # 1.14 批 L5: 资产库提局部量 — 段池锚定行现算复用同一次读 (判据与引擎同源纯函数)
            assets_pv = _h3_read_assets()[0]
            # Task D3: 多角色解析链 — row 出场角色非空时按 PRD §3.4 接入 cast_spec
            # 批 H2-3: 透传 bindings 给 _cast_plan_for_row (绑定卡走快照, 同执行同口径)
            cast_plan = _cast_plan_for_row(row, pool, pool_usage, eff_mode,
                                           assets_pv,
                                           bindings=bindings)
            pu_for_enrich = pool_usage
            cast_spec = None
            if cast_plan is not None:
                # 模板不可判族 + 拼接模式 → cmode 回落到 ref2v (与执行 inject_ok 对齐)
                cmode = _cmode_fallback_for_cast(cmode, eff_mode, pool,
                                                 cast_plan["virtual_slots"])
                # 注入门控: 仅 ref2v (与执行 inject_ok 语义对齐, 非 ref2v 走现状批级参数)
                if cmode == "ref2v":
                    pu_for_enrich = cast_plan["pu_copy"]
                    cast_spec = cast_plan["cast_spec"]
            # I-⑤: 逐镜过滤 — 与执行端 _apply_shot_common 逐字一致
            if cast_plan is not None:
                scene_nos = {no for no, _ in (cast_plan.get("cast_spec") or [])
                             if isinstance(no, int)}
            # 批 A 节点 1 修复 (门审分叉 A + B):
            # 基线口径: check_prompt_rules 入参 = row_for_plan (replaced prompt) + global_replaced
            #                       (post-replaced + post-Subject-filter); 不传 row 原文 / global 原文
            # 基线口径: _filter_cast_spec_for_dedup 参照 = global_replaced (仅 global, 非 combined)
            # prompt_assembler.prepare_global / prepare_row 内部包换 _filter_global_subject_lines
            # 与 replace_cast_names (避免 grep 引擎模块外调用检查)
            # 批 A 节点 4 (4a): 空集镜兜底反转黄条入 subject_filter_warns — 复用 audio_warns 通道
            global_replaced = prompt_assembler.prepare_global(
                global_p, bindings, scene_nos, warn_sink=subject_filter_warns)
            row_for_plan = prompt_assembler.prepare_row(row, bindings)
            # checks 与 text 用同一组输入算(preflight 与表单实时统一)
            # 注意: check_prompt_rules 暂不扩多角色参数 (红条归预检端点)
            check_errors, check_warns = check_prompt_rules(
                row_for_plan, pool, pool_usage, global_replaced, cmode, pic9_present,
                audio_global=audio, lang="zh", cast_spec=cast_spec,
                # 1.13e: bindings 透传 ctx — L2'(绑定名冒号) 对白豁免数据源
                bindings=bindings)
            # 批B B4: 端点预览层聚合 per-row [声场空] 为一条黄条 (复用 batch_core.aggregate_soundscape_warns
            # 单一来源, 与引擎层 + 单元测试同口径 — R6(b))
            preview_rid = (str(row.get("ID", "")).strip()
                           or str(row_for_plan.get("ID", "")).strip()
                           or "预览")
            _new_warns, _agg = aggregate_soundscape_warns(check_warns, shot_ids=[preview_rid])
            check_warns = _new_warns
            checks = {"errs": check_errors, "warns": check_warns}
            # 1.13e A 件: 批级素材池官方硬参数检查 — 仅 workflow 分支内 + pool 非空才执行
            # (无 workflow 键 / 空 pool → 行为与现状零变, 锁定契约); 探测 (ffprobe/PIL/FS)
            # 走 to_thread, 严禁在 async 端点里同步跑 subprocess。
            if pool:
                pool_warns = await asyncio.to_thread(
                    _check_pool_limits, pool,
                    str(body.get("input_dir") or "").strip() or _default_input_dir())
                if pool_warns:
                    # 批级提示逐行重复显示为有意选择 (方案 §3.2R, 前端不去重)
                    checks["warns"] = checks["warns"] + pool_warns
            # 批 K: 12 槽黄条按段重算 — 与引擎 preflight 双点同源 (同判据同文案,
            # 单一来源 batch_core._check_seg_pool_limits); 单行预览传 ctx={0:...}。
            # body 无 seg_pools 键 → 恒空列表, preview 行为逐字节现行为。
            _seg_pools = body.get("seg_pools")
            # 1.14 批 L5: 段池锚定行 — preview 不走 _prepare_cast_plan, 从 body.seg_pools
            # + 已载资产库现算 (判据/形态与引擎侧同一纯函数, 不另写一份)。
            seg_anchor_rows_pv = batch_core._seg_anchor_rows_for_entry(
                batch_core._seg_pools_entry(_seg_pools, row), assets_pv, lang,
                [b.get("name") for b in bindings if isinstance(b, dict)])
            if isinstance(_seg_pools, dict) and _seg_pools:
                seg_warns = await asyncio.to_thread(
                    _check_seg_pool_limits, [row], _seg_pools,
                    str(body.get("global") or ""), pool_usage,
                    bindings, {0: {"cast_spec": cast_spec}})
                if seg_warns:
                    checks["warns"] = checks["warns"] + seg_warns
            # 1.13f: 全局手写锚定 dedup 降级黄条 — 与引擎侧 batch_core._check_global_anchor_dup 同口径
            # 预览侧扫描 global_replaced (与 dedup 基线同口径, 此处为已 Subject 行过滤后版本)
            # 抑制条件: subject_anchors 非空 (已豁免无降级)
            _anchor_dup_warns = _check_global_anchor_dup(
                global_replaced, cast_spec, subject_anchors_for_assembler)
            if _anchor_dup_warns:
                checks["warns"] = checks["warns"] + _anchor_dup_warns
            pool_for_assembler = pool
            pool_usage_for_assembler = pu_for_enrich
            cmode_for_assembler = cmode
            pic9_present_for_assembler = pic9_present
            cast_spec_for_assembler = cast_spec
            bindings_for_assembler = bindings
            # 批 A 节点 3 (C): 预览端点 retention 接线
            # 单行预览 (无可知批级出场角色列) → shots_in_scene = [[names]] (本镜),
            # current_shot_no = 1, 强制 retention 行内含 [Shot 1]
            if cast_spec:
                names_in_scene = []
                for no, _rows in cast_spec:
                    card_name = next((b["name"] for b in (bindings or [])
                                      if isinstance(b, dict) and b.get("no") == no), None)
                    if card_name and card_name not in names_in_scene:
                        names_in_scene.append(card_name)
                shots_in_scene_for_assembler = [names_in_scene] if names_in_scene else None
                current_shot_no_for_assembler = 1
            else:
                shots_in_scene_for_assembler = None
                current_shot_no_for_assembler = None
        else:
            bindings_for_assembler = []
            global_replaced = global_p
            shots_in_scene_for_assembler = None
            current_shot_no_for_assembler = None
        # 批 A 节点 1: 单入口组装 (无 workflow 键时 None 参数 = V1.3 行为零变)
        # dedup_text = global_replaced (基线口径: 仅过滤后 global, 不用 combined;
        # 行手写 <Subject N>: 不应误剔除 cast 块)
        # 批 A 节点 3 (A4 R2): 音频冲突黄条回流 — 端点预览透传 warn_sink 到 checks.warns
        audio_warns = []
        text = prompt_assembler.assemble_final_prompt(
            row=row,
            pool=pool_for_assembler,
            pool_usage=pool_usage_for_assembler,
            global_text=global_p,
            audio_blocks=audio,
            bindings=bindings_for_assembler,
            cmode=cmode_for_assembler,
            pic9_present=pic9_present_for_assembler,
            cast_spec=cast_spec_for_assembler,
            scene_nos=scene_nos,
            dedup_text=global_replaced,
            lang=lang,
            negative=negative,
            negative_music=neg_music,
            negative_dialogue=neg_dialogue,
            negative_text=neg_text,
            shots_in_scene=shots_in_scene_for_assembler,
            current_shot_no=current_shot_no_for_assembler,
            # 批 A 节点 3 (A1): 单行预览端点默认 [Shot 1] (无时间戳, 分镜模式语义)
            shot_no=1,
            cum_ms=None,
            # 批 A 节点 3 (A4 R2): 音频冲突 → checks.warns 用户可见
            warn_sink=audio_warns,
            # 批 C 节点 C-II part-2 (C3) / I2b: 透传 fl2v 对齐句开关 — 唯一保留的 fl2v
            # 专属面 (GUI 预览文本契约; fl2v 模板批入口即拒 → 执行面不可达, 登记 I3)
            is_fl2v=is_fl2v,
            # 1.13f: 引擎侧锚定行覆盖入口 (string 多行文本)
            subject_anchors=subject_anchors_for_assembler,
        )
        # 1.14 批 L5 R-26: 段池锚定块尾部追加 — 与引擎 _apply_shot_common 追加挂点同款
        # (组装结果之后, 绕开 extra_blocks 替换语义与场景/视频块过滤的静默丢弃);
        # I2 门控同口径: 非 ref2v / 零行 / 空文本 = 零追加 (老任务逐字节现行为)。
        if text and cmode_for_assembler == "ref2v":
            _anchor = batch_core._seg_anchor_block(
                seg_anchor_rows_pv,
                (global_p or "") + "\n" + (row.get("prompt") or ""))
            if _anchor:
                text = text + "\n\n" + _anchor
        # 批 A 节点 3 (A4 R2): 音频冲突黄条累加到响应 checks.warns (复用现有通道)
        if audio_warns:
            checks["warns"] = list(checks.get("warns", [])) + audio_warns
        # 批 A 节点 4 (4a): 空集镜兜底反转黄条累加到响应 checks.warns (复用同一通道)
        if subject_filter_warns:
            checks["warns"] = list(checks.get("warns", [])) + subject_filter_warns
        return web.json_response({"text": text, "checks": checks})

    # 批 H2-1: POST /h3_batch/cast_block — 按已建绑定的 slots 快照造块 (前端绑定面板用)
    #   body = {name, no, slots:[{idx, usage, media, desc}, ...]}
    #   构造 cast_spec 单角色块 (subject_no=no) → batch_core.cast_blocks 产句
    #   fingerprint = (库中该卡不存在 / 非 v3 character / slots 与库现状有差异)
    #   失联 / 失配仍产块 (跑批按快照继续, J2 — 但前端可据此黄标"档案已变化")
    #   对拍: 端点 blocks 与引擎 cast_blocks(cast_spec, lang) 逐字相等
    @server.PromptServer.instance.routes.post("/h3_batch/cast_block")
    async def _h3_cast_block(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        # name 校验
        name = body.get("name")
        if not isinstance(name, str):
            return web.json_response({"error": "name 必须为字符串"}, status=400)
        clean_name = name.strip()
        if not clean_name:
            return web.json_response({"error": "卡名 (name) 不能为空"}, status=400)
        if len(clean_name) > 64:
            return web.json_response(
                {"error": "卡名 (name) 超过 64 字符限制 (当前 %d)" % len(clean_name)},
                status=400)
        # no 校验
        no = body.get("no")
        if not isinstance(no, int):
            return web.json_response({"error": "no 必须为整数"}, status=400)
        # slots 校验 (容错: 损坏 entry 跳过)
        slots_raw = body.get("slots") or []
        if not isinstance(slots_raw, list):
            slots_raw = []
        slots_clean = []
        for s in slots_raw:
            if not isinstance(s, dict):
                continue
            idx = s.get("idx")
            usage = s.get("usage") or ""
            media = s.get("media") or ""
            desc = s.get("desc") or ""
            ig = s.get("ignore_words") or ""
            if not isinstance(idx, int):
                continue
            slots_clean.append((idx, usage, media, desc, ig))
        # lang (缺省 zh)
        lang = body.get("lang", "zh")
        if lang not in ("zh", "en"):
            lang = "zh"
        # 读资产库构造 fingerprint (与 slots 逐行比对 — 卡不存在/v2/scene 即 fingerprint)
        assets, _err = _h3_read_assets()
        card = assets.get(clean_name)
        fingerprint = True  # 默认异常
        if isinstance(card, dict) and card.get("_v") == 3 and card.get("kind") == "character":
            # v3 character → 比对 slots 与库 rows
            lib_rows = card.get("rows") or []
            # 把 slots 按 (usage, media) 多重集合 vs 库对应行 — 简化: 排序后字符串比对
            lib_sign = sorted(((r.get("usage", ""), r.get("media", ""))
                              for r in lib_rows if isinstance(r, dict)))
            slot_sign = sorted(((usage, media) for _idx, usage, media, _desc, _ig in slots_clean))
            fingerprint = (lib_sign != slot_sign)
        # cast_spec 单角色条目: subject_no = no
        cast_spec = [(no, [(idx, usage, desc, ig) for idx, usage, _media, desc, ig in slots_clean])]
        # 与引擎 cast_blocks 路径同源: 同一函数 (为前端/引擎对拍基础)
        # 批 A 节点 1: 走 prompt_assembler.cast_blocks (re-export from batch_core)
        blocks = list(prompt_assembler.cast_blocks(cast_spec, lang=lang))
        return web.json_response({"blocks": blocks, "fingerprint": fingerprint})

    @server.PromptServer.instance.routes.post("/h3_batch/generate_csv")
    async def _h3_gen_csv(request):
        # V1.4 T5: body 新增可选 "workflow" 键 — 带 workflow 时生成副本
        #   h3_batch_<时间戳>_总提示词.txt (与主 CSV 同目录), 头部两行 # 注释 + 每行 "ID\\t最终提示词"。
        #   副本编译路径与引擎 apply_shot_concat 同源 (cmode=_template_mode(workflow);
        #   enrich_blocks+merged_prompt)。不带 workflow → V1.3 行为零变 (两键响应)。
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        mode = body.get("mode", "分镜")
        data = body.get("data", {}) or {}
        # #40 I5: 生成分镜表失败也从结构化信封走 (此前裸 500 纯文本·GUI 无详情可看)
        try:
            text = build_csv(mode, data)
        except ShotError as e:
            _msg = str(e)
            return web.json_response(
                {"ok": False, "error": "csv_generate_failed: %s" % _msg,
                 "execution_error": _submit_error_detail(
                     "csv_generate", "csv_generate_failed", _msg)}, status=500)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        input_dir = folder_paths.get_input_directory()
        fname = "h3_batch_%s.csv" % stamp
        path = os.path.join(input_dir, fname)
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            f.write(text)
        resp = {"name": fname, "path": path}
        # V1.11 批 3 T2: 旁车配置快照 — 引擎首次落盘读 <csv名>.h3cfg.json 并入 manifest._config;
        # 内容是前端 serializeFormConfig() 完整表单快照 (mode/pool/pool_usage/globals/shots).
        # 缺 config 视为老客户端, 不写旁车 (兼容 V1.10 及之前手动写 CSV 的入口).
        cfg = body.get("config")
        if isinstance(cfg, dict):
            sidecar = path[:-4] + ".h3cfg.json" if path.lower().endswith(".csv") \
                else path + ".h3cfg.json"
            try:
                with open(sidecar, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=2)
            except OSError as e:
                print("[H3Batch] generate_csv 旁车写盘失败 %s (%s)" % (sidecar, e), flush=True)
        # 带 workflow 键 → 生成副本 (总提示词 .txt), 与引擎实发逐字节对齐
        workflow = body.get("workflow")
        # 1.13f: subject_anchors 透传给副本编译 (string 多行文本; 缺省/空/纯空白 = 零变)
        _sa_raw_gc = body.get("subject_anchors")
        subject_anchors_gc = _sa_raw_gc if isinstance(_sa_raw_gc, str) else None
        if workflow:
            # I2b: 端点判族收敛同 preview 端点 (i2v/fl2v 归 t2v; 原 `if workflow else None`
            # 在本分支内恒真, 随改删除)
            cmode = _endpoint_cmode(_template_mode(workflow))
            g = data.get("globals") or {}
            lang_v = str(g.get("语言", "") or "").strip().lower()
            lang = "en" if lang_v in ("英文", "en", "english") else "zh"
            # 批 A 后小迭代: 三勾选 — 新三键优先; 旧 默认负面 单键兼容(开→三全勾, 关/缺→全不勾)
            def _truthy(k):
                return str(g.get(k, "") or "").strip() == "开"
            neg_music = _truthy("关音乐")
            neg_dialogue = _truthy("关对白")
            neg_text = _truthy("关水印字幕")
            any_new = ("关音乐" in g) or ("关对白" in g) or ("关水印字幕" in g)
            if not any_new:
                legacy_on = (str(g.get("默认负面", "") or "").strip() == "开")
                neg_music = neg_dialogue = neg_text = legacy_on
            negative = bool(neg_music or neg_dialogue or neg_text)
            pool = _norm_slots(data.get("pool") or {})
            pool_usage = _norm_slots(data.get("pool_usage") or {})
            shots = data.get("shots") or []
            # 批 H2-3: 透传 bindings 给 _cast_plan_for_row
            bindings_raw = g.get("角色绑定") if isinstance(g, dict) else None
            # g["角色绑定"] 是字符串 (CSV 行值) — 解析它再传入 (与引擎 _apply_global 同源)
            bindings = []
            if isinstance(bindings_raw, str) and bindings_raw:
                try:
                    parsed = json.loads(bindings_raw)
                    if isinstance(parsed, list):
                        bindings = parsed
                except (ValueError, TypeError):
                    bindings = []
            # Task D3: 多角色解析链 — 全表预解析 (端点版, 各行独立分配, 同槽号跨行副本不冲突)
            # 失败/无 cast 行不注入 — 与单行端点版同口径
            assets = _h3_read_assets()[0]
            per_shot_cast = {}  # {行索引: cast_plan 字典}
            any_cast = False
            for i, shot in enumerate(shots):
                if not isinstance(shot, dict):
                    continue
                # 1.11b 波2 T5: 自定义模式按行内 CONCAT_FLAG_COL 派生 eff_mode
                # (cast_block 端点逐行循环内已有行对象, 与 preview 端点同源语义)
                _cfc_v_cb = str(shot.get(CONCAT_FLAG_COL) or "").strip()
                _eff_mode_cb = "拼接" if (mode == "拼接"
                                          or (mode == "自定义" and _cfc_v_cb == "是")) else "分镜"
                cp = _cast_plan_for_row(shot, pool, pool_usage, _eff_mode_cb, assets,
                                        bindings=bindings)
                if cp is not None:
                    per_shot_cast[i] = cp
                    any_cast = True
            # 模板不可判族 + 拼接 + cast 存在 → cmode 回落到 ref2v (与执行 inject_ok 对齐)
            if any_cast:
                # 全批虚拟槽并集 (用于 cmode fallback, 与引擎 union_pool 口径一致)
                all_virtual = {}
                for cp in per_shot_cast.values():
                    all_virtual.update(cp["virtual_slots"])
                cmode = _cmode_fallback_for_cast(cmode, mode, pool, all_virtual)
            lines = []
            lines.append("# 生成时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
            lines.append("# 查错参考: 引擎以运行时实际发送为准; 本副本按请求所带模板族编译")
            for i, shot in enumerate(shots):
                if not isinstance(shot, dict):
                    continue
                global_p = str(g.get("提示词", "") or "")
                # 1.11b 波2 T5: 自定义模式逐行 eff_mode — pic9_present 按行判定
                _cfc_v_p9 = str(shot.get(CONCAT_FLAG_COL) or "").strip()
                _eff_mode_p9 = "拼接" if (mode == "拼接"
                                          or (mode == "自定义" and _cfc_v_p9 == "是")) else "分镜"
                pic9_present = (_eff_mode_p9 == "拼接" and cmode == "ref2v" and (
                    i > 0 or bool((pool.get("Picture") or {}).get(9))))
                # D3: 该行有 cast 且 cmode=ref2v → 逐镜副本 + cast_spec; 否则批级参数
                pu_eff = pool_usage
                cast_spec_eff = None
                if cmode == "ref2v" and i in per_shot_cast:
                    pu_eff = per_shot_cast[i]["pu_copy"]
                    cast_spec_eff = per_shot_cast[i]["cast_spec"]
                # T2: 副本编译按 globals["配乐"/"氛围声"] 非空拼装 audio_blocks(键序固定)
                audio_blocks = [(k, g[k]) for k in ("配乐", "氛围声") if g.get(k)]
                # 批 A 节点 1: 单入口组装
                # gen_csv 路径与原内联链逐字节一致 (原 gen_csv 不调 _filter_cast_spec_for_dedup,
                # 传 dedup_text="" 跳过 dedup; 其他三处调用方默认走 text_combined dedup)
                row_text = prompt_assembler.assemble_final_prompt(
                    row=shot,
                    pool=pool,
                    pool_usage=pu_eff,
                    global_text=global_p,
                    audio_blocks=audio_blocks,
                    bindings=bindings,
                    cmode=cmode,
                    pic9_present=pic9_present,
                    cast_spec=cast_spec_eff,
                    scene_nos=None,
                    dedup_text="",
                    lang=lang,
                    negative=negative,
                    negative_music=neg_music,
                    negative_dialogue=neg_dialogue,
                    negative_text=neg_text,
                    # 1.13f: subject_anchors 透传 (与预览端点同口径)
                    subject_anchors=subject_anchors_gc,
                )
                lines.append("%s\t%s" % (str(shot.get("ID", "") or ""), row_text))
            compiled_name = "h3_batch_%s_总提示词.txt" % stamp
            compiled_path = os.path.join(input_dir, compiled_name)
            with open(compiled_path, "w", encoding="utf-8-sig", newline="") as f:
                f.write("\n".join(lines) + "\n")
            resp["compiled_name"] = compiled_name
            resp["compiled_path"] = compiled_path
        return web.json_response(resp)

    @server.PromptServer.instance.routes.get("/h3_batch/browse")
    async def _h3_browse(request):
        # S2: 越界日志 (input/output/archive 树外) — 仅记录, 下方既有列表行为不变
        _browse_path = request.query.get("path", "")
        _h3_log_read_out_of_scope("browse", _browse_path, _browse_path, "data")
        exts = [e.strip().lower() for e in request.query.get("exts", "").split(",") if e.strip()]
        return web.json_response(browse_dir(_browse_path, exts or None))

    @server.PromptServer.instance.routes.get("/h3_batch/templates")
    async def _h3_templates(request):
        d = request.query.get("dir", "").strip()
        return web.json_response({"templates": list_h3_templates(d) if d else []})

    @server.PromptServer.instance.routes.get("/h3_batch/status")
    async def _h3_status(request):
        stem = request.query.get("stem", "")
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", stem):
            return web.json_response({"error": "invalid stem"}, status=400)
        output_dir = _status_output_dir(request.query.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"error": "output_dir 不存在"}, status=400)
        # V1.11 批 1 T2b: 双位置寻址 — 优先 run_dir 子文件夹, 根层回退
        mp = resolve_manifest_path(stem, output_dir)
        if not mp or not os.path.exists(mp):
            # T3-甲 (契约定点一): 建档期 manifest 未建 — running 按 _active 真值 + phase
            # "建档中" (GUI grace 状态机据 running/phase 不误判引擎失联; api.md #9 契约).
            _enr_ph = "建档中" if _enrollment_busy else ""
            _resp = {"running": is_active(), "shots": {}, "phase": _enr_ph}
            # #40: 受理后落盘前死 (run() 首次落盘前抛死) 的原因按 stem 透传 — GUI 宽限期
            # 见此键即停止误判"引擎失联".
            _attach_run_init_error(_resp, stem)
            return web.json_response(_resp)
        try:
            with open(mp, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            # 1.11a 波 3 T1 项 6: manifest 读失败时返 running="unknown" 三态,
            # 替代旧 is_active() 混算 (前台可能误判为"运行中"显示).
            # 三态语义: 不显示运行中 / 不触发完成分支 / 继续轮询.
            return web.json_response({"running": "unknown", "shots": {}, "error": "manifest 读取失败(可能正在写入)"}, status=200)
        shots = {k: v for k, v in data.items() if k not in _RESERVED_KEYS}
        done = sum(1 for v in shots.values() if v.get("status") == "success")
        failed = sum(1 for v in shots.values() if v.get("status") == "failed")
        # V1.7 R13: 跑批收尾阶段透传 (拼接中 / 归档中 / 清点中) — 让前端在黑箱拼接/归档期间
        # 也能告诉用户后台在干什么; 空串表示未在跑批或已结束。与 _active_engine 同锁快照引用, 防竞态。
        with _active_lock:
            phase = getattr(_active_engine, "phase", "") or ""
        # T3-甲 (契约定点一): 建档期 (manifest 已建但批未开跑) phase 透传 "建档中".
        if not phase and _enrollment_busy:
            phase = "建档中"
        # V1.11 fix2 (fix5): run() 提前 return 后 _active 释放, 但 _finalizing[output_dir]
        # 仍在被后台线程更新阶段. status 端点兜底查 _finalizing (output_dir 匹配) 透传到前端,
        # 避免前端轮询误以为任务停了。 用 _finalize_lock 短临取快照防 dict 变更竞态。
        if not phase:
            try:
                _req_out = os.path.normcase(os.path.abspath(output_dir))
                with _finalize_lock:
                    phase = _finalizing.get(_req_out, "") or ""
            except Exception:
                phase = ""
        resp = {"running": is_active(), "done": done, "failed": failed,
                "total": len(shots), "shots": shots,
                "concat": data.get("_concat"), "phase": phase,
                # #40: 受理后落盘后死的批级错误 (顶层键·段级白名单是段键循环·须显式透传)
                "_batch_error": data.get("_batch_error")}
        _attach_run_init_error(resp, stem)
        # T3-甲 (契约定点二): 建档结果按 stem 匹配透传 (GUI 感知建档软失败).
        if _enrollment_result.get("stem") == stem:
            resp["enrollment"] = {"status": _enrollment_result.get("status", ""),
                                  "error": _enrollment_result.get("error", "")}
        return web.json_response(resp)

    # V1.11 批 1 T2: 历史列表端点 — 扫 output 根 glob 列出所有 manifest 任务元数据.
    # 参数: output_dir? (缺省走 _status_output_dir 兜底), limit? (默认 50), offset? (默认 0).
    # 性能口径: 414 文件全量解析仅取计数, 真机首屏 <2s; 单测不测性能.
    @server.PromptServer.instance.routes.get("/h3_batch/history")
    async def _h3_history(request):
        output_dir = _status_output_dir(request.query.get("output_dir", ""))
        # S2: 越界日志 (output/archive 树外) — 仅记录, 下方既有 400/200 行为不变
        _h3_log_read_out_of_scope("history", request.query.get("output_dir", ""),
                                  output_dir, "output")
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        try:
            limit = int(request.query.get("limit", "50"))
            offset = int(request.query.get("offset", "0"))
        except ValueError:
            return web.json_response({"ok": False, "error": "limit/offset 必须为整数"}, status=400)
        if limit < 0 or offset < 0:
            return web.json_response({"ok": False, "error": "limit/offset 必须非负"}, status=400)

        entries = []
        # V1.11 批 1 T2b: 双位置扫描 — 根层 + 子文件夹 (run_dir) 合并
        # V1.11 批 1 T6: .h3_trash 是 output 直接子目录, 其下 manifest 不进 history 扫描
        # (回收站视图走独立 /h3_batch/history/trash 端点). 排除路径: 根层 glob 子文件夹
        # 列表 (影响 dirnames[:]=[]) + 子层 walk 命中判定双层兜底.
        seen_stems = {}
        for dirpath, dirnames, filenames in os.walk(output_dir):
            # 不递归跑太深, 仅三级: output_dir/<名>/<子夹>/<file> (R-52 v2 嵌套)
            depth = os.path.relpath(dirpath, output_dir).count(os.sep)
            if depth > 1 and dirpath != output_dir:
                # 限制为 output_dir 直接子层与孙层 (避免跨 run_dir 再下钻)
                dirnames[:] = []
                continue
            # 根层扫描: 排除 .h3_trash 子目录 (它的 manifest 走 trash 视图)
            dirnames[:] = [d for d in dirnames if d != _TRASH_DIR_NAME]
            for name in filenames:
                if not (name.startswith("h3_batch_manifest_") and name.endswith(".json")):
                    continue
                # 兜底: 子层 walk 命中 trash (理论上 depth>1 已截断, 但防御性再排一次)
                if _TRASH_DIR_NAME in dirpath.split(os.sep):
                    continue
                mp = os.path.join(dirpath, name)
                try:
                    mtime = os.path.getmtime(mp)
                except OSError:
                    continue
                stem = name[len("h3_batch_manifest_"):-len(".json")]
                if stem in seen_stems:
                    # 迁移期/老代码重复: 取 mtime 新者, 日志一行
                    prev = seen_stems[stem]
                    if mtime > prev["mtime"]:
                        print("[H3Batch] history: stem %r 同处多处, 取 mtime 更新者 %s" % (stem, mp), flush=True)
                        seen_stems[stem] = {"mtime": mtime, "mp": mp}
                    else:
                        print("[H3Batch] history: stem %r 同处多处, 保留旧 %s" % (stem, prev["mp"]), flush=True)
                else:
                    seen_stems[stem] = {"mtime": mtime, "mp": mp}

        for stem, info in seen_stems.items():
            mp = info["mp"]
            mtime = info["mtime"]
            data, degraded = read_manifest_safe(mp)
            # read_manifest_safe: 损坏 → ({}, True); 文件不存在 → (None, False).
            # 损坏文件 skip (不计入 total), 日志一行 (read_manifest_safe 内部已打印).
            if not isinstance(data, dict) or not data:
                continue
            shots = {k: v for k, v in data.items() if k not in _RESERVED_KEYS
                     and isinstance(v, dict)}
            success = sum(1 for v in shots.values()
                          if v.get("status") == "success" and v.get("review") != "void")
            failed = sum(1 for v in shots.values() if v.get("status") == "failed")
            stopped = sum(1 for v in shots.values() if v.get("status") == "stopped")
            void = sum(1 for v in shots.values()
                       if v.get("status") == "success" and v.get("review") == "void")
            pending = sum(1 for v in shots.values()
                          if v.get("status") not in ("success", "failed"))
            # V1.11 fix2: 总段数 — 折叠行顶部行信息密度。
            # 五桶里 pending 口径已含 stopped/待审 (status not in success/failed),
            # 求和会双计, 直接取段总数。
            total = len(shots)
            # V1.11 fix2: 拼接徽标派生 — _concat 存在 → 取 status 派生文字 ("已拼"/"未拼"/"拼失败")
            # 不存在 → None (前端折叠行隐藏徽标, 仅分镜模式 / 拼接批未收尾 出现)。
            concat_info = data.get("_concat")
            concat_badge = None
            if isinstance(concat_info, dict):
                _cs = concat_info.get("status")
                if _cs == "success":
                    concat_badge = "已拼"
                elif _cs == "failed":
                    concat_badge = "拼失败"
                elif _cs == "skipped":
                    # #26 T2 (方案审建议 9): 兼读 _concat_history — 重跑族任务收尾
                    # 置 skipped 后, 手动拼接成功只写 _concat_history 不回写 _concat,
                    # 徽标不再误显"未拼" (history 只在拼接成功时追加, 非空=已拼过)。
                    _hist = data.get("_concat_history")
                    concat_badge = ("已拼" if isinstance(_hist, list) and _hist
                                    else "未拼")
                elif _cs == "running":
                    concat_badge = "拼接中"
            elif isinstance(data.get("_concat_history"), list) and data["_concat_history"]:
                # 批 9 B1 真机勘误: 手动拼接 (concat 端点) 只写 _concat_history 不写 _concat —
                # 派生兼读之, 否则手动拼过的任务历史列表永远不显示"已拼"徽标.
                concat_badge = "已拼"
            # 1.14b U4b: 后处理徽标派生 (照 concat_badge 派生先例) — manifest._postfx.status
            # 三态 + fallback 命中加 ⚠: success → "后处理成功"; failed → "后处理失败";
            # running → "后处理中"; 无 _postfx → None (前端折叠行隐藏徽标).
            # 注意: 运行中任务的 _postfx 是 _do_postfx 落盘前的中间态, 进度查询走 status 端点.
            postfx_info = data.get("_postfx")
            postfx_badge = None
            if isinstance(postfx_info, dict):
                _ps = postfx_info.get("status")
                if _ps == "success":
                    postfx_badge = "后处理成功⚠" if postfx_info.get("fallback") else "后处理成功"
                elif _ps == "failed":
                    postfx_badge = "后处理失败"
                elif _ps == "running":
                    postfx_badge = "后处理中"
            # mode 二元推断: _mode 有值用之; 无则 _concat 键存在 → "拼接", 否则 "分镜".
            # 误判边界 (方案 v6 §1 T2 接受): 拼接批全败 (concat_parts 空不写 _concat) 的
            # 旧批会误判为分镜; 新批引擎首盘注入 _mode 后不受影响.
            mode = data.get("_mode")
            if not mode:
                mode = "拼接" if "_concat" in data else "分镜"
            # folder = 首个 run_dir 的 basename (展示字段, 取不到空串)
            folder = ""
            for v in shots.values():
                rd = v.get("run_dir")
                if isinstance(rd, str) and rd:
                    folder = os.path.basename(rd.rstrip("\\/"))
                    break
            # archived: 任一段 run_dir 不在 output 根下 → True
            out_root = os.path.normcase(os.path.abspath(output_dir))
            archived = False
            for v in shots.values():
                rd = v.get("run_dir")
                if isinstance(rd, str) and rd:
                    if not os.path.normcase(rd).startswith(out_root + os.sep):
                        archived = True
                        break
            note = data.get("_note") or ""
            if isinstance(note, str) and len(note) > 200:
                note = note[:200]
            entries.append({
                "task_id": stem,
                "folder": folder,
                "time": mtime,
                "mode": mode,
                "success": success,
                "failed": failed,
                "stopped": stopped,
                "void": void,
                "pending": pending,
                "total": total,
                "concat": concat_info,
                "concat_badge": concat_badge,
                "postfx_badge": postfx_badge,
                "note": note,
                "archived": archived,
                "degraded": degraded,
            })

        entries.sort(key=lambda e: e["time"], reverse=True)
        total = len(entries)
        sliced = entries[offset:offset + limit] if limit else entries[offset:]
        return web.json_response({"ok": True, "tasks": sliced, "total": total})

    # V1.11 批 1 T2: 单任务明细端点 — 寻址钉死 task_id → manifest → 段 run_dir.
    # V1.11 批 1 T2b: 双位置寻址 (子文件夹 + 根层回退).
    # V1.11 批 3 T1: full_prompt=true query → 该段 final_prompt 不截断 (默认仍 800;
    # 改词弹窗拉全文用 — 列表场景省流量). 不传或非真值 → 800 截断 (旧行为零变化).
    @server.PromptServer.instance.routes.get("/h3_batch/history/detail")
    async def _h3_history_detail(request):
        # S2: 越界日志 (output/archive 树外) — 仅记录, 下方既有 4xx/200 业务行为不变
        _detail_od_raw = request.query.get("output_dir", "")
        _detail_od = _status_output_dir(_detail_od_raw)
        _h3_log_read_out_of_scope("history/detail", _detail_od_raw, _detail_od, "output")
        task_id = str(request.query.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "missing_task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        output_dir = _detail_od
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir_not_found"}, status=400)
        full_prompt = str(request.query.get("full_prompt", "") or "").strip().lower() in (
            "1", "true", "yes")
        mp = resolve_manifest_path(task_id, output_dir)
        in_trash = False
        if not mp:
            # 真机 P0 修复: 软删后 detail 应可读 (验收清单 A6 钉死只读语义).
            # resolve_manifest_path 不看 .h3_trash → 兜底查 trash, 命中则照常返回明细.
            mp = _find_in_trash(task_id, output_dir)
            if not mp:
                return web.json_response({"ok": False, "error": "not_found"}, status=404)
            in_trash = True
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        # mode 二元推断同列表端点 (_mode 优先 → _concat 键存在 → 分镜; 误判边界接受)
        mode = data.get("_mode")
        if not mode:
            mode = "拼接" if "_concat" in data else "分镜"
        note = data.get("_note") or ""
        workflow = data.get("_workflow") or ""
        try:
            mtime = os.path.getmtime(mp)
        except OSError:
            mtime = 0.0
        shots_out = {}
        # #78 B 路径: 侧车 prompt_text 条件透传 — 改词弹窗预填优先用裸段词
        # (final_prompt 已是装配全文, 二次改词作 payload 会嵌套膨胀)。侧车键域 =
        # CSV stem (与引擎 _seg_override_for 同源); 无侧车/无该段 → 不带键 (旧响应零变)。
        _sidecar_stem = os.path.splitext(os.path.basename(
            str(data.get("_csv_path") or "")))[0]
        sidecar_ov = (batch_core._seg_overrides_load(os.path.dirname(mp), _sidecar_stem)
                      if _sidecar_stem else {})
        # 1.11a 波3-T4 (延后项8): 串行逐段 await 探测改并发批 — asyncio.gather + Semaphore(4)
        # 限流 (防几十段同时 ffprobe 占满子进程); 响应字段与值不变, 仅提速.
        # 探测失败/产物缺失/归档不可达 → 不写字段 (前端显示 "--"), 与串行版语义一致.
        _probe_sem = asyncio.Semaphore(4)

        async def _probe_resolution(seg, seg_path):
            async with _probe_sem:
                try:
                    return await asyncio.to_thread(_h3_probe_video_resolution, seg_path)
                except Exception as e:
                    print("[H3Batch] detail 分辨率探测 %s 失败: %s" % (seg_path, e), flush=True)
                    return None

        _probe_jobs = []  # [(seg, seg_path, coro)]
        for k, v in data.items():
            if k in _RESERVED_KEYS or not isinstance(v, dict):
                continue
            seg = {
                "status": v.get("status"),
                "review": v.get("review"),
                "seed": v.get("seed"),
                "files": v.get("files") or v.get("file"),
                "run_dir": v.get("run_dir"),
            }
            if "seed_override" in v:
                seg["seed_override"] = v["seed_override"]
            # V1.13k T2: #17 shots 透传 4 键 — 模式对齐 seed_override (有该键才带,
            # 不造 null 键). accepted_seq = 多候选采纳条目 seq; seg_overrides_active =
            # 该段有侧车覆盖值; seg_duration_sec / seg_duration_frames = 段时长秒/帧.
            # R-33: elapsed_sec / t_start / t_end = 段级耗时留痕 (1.13h 起
            # _timing_fields 逐段落盘; 旧 manifest 段无三键 → 响应自然不带).
            # R-34: execution_error = 节点级报错详情 dict (T4 起失败段落盘; 旧段
            # 无此键 → 响应自然不带).
            for _k in ("accepted_seq", "seg_overrides_active",
                       "seg_duration_sec", "seg_duration_frames",
                       "elapsed_sec", "t_start", "t_end", "execution_error"):
                if _k in v:
                    seg[_k] = v[_k]
            # #78 B 路径: 侧车裸段词 (弹窗预填优先源; 有侧车该段才带)
            _sidecar_pt = (sidecar_ov.get(k) or {}).get("prompt_text")
            if isinstance(_sidecar_pt, str) and _sidecar_pt:
                seg["prompt_text"] = _sidecar_pt
            fp = v.get("final_prompt")
            if isinstance(fp, str):
                seg["final_prompt"] = fp if full_prompt else fp[:800]
            elif fp is not None:
                seg["final_prompt"] = str(fp) if full_prompt else str(fp)[:800]
            # V1.11 批 2 T1: detail 端点补段分辨率字段 — status=success + files 非空 + run_dir
            # 拼绝对路径 = run_dir + files[0]; asyncio.to_thread 探测避免阻塞事件循环.
            if seg.get("status") == "success" and seg.get("files") and seg.get("run_dir"):
                files_v = seg["files"]
                fname = files_v[0] if isinstance(files_v, list) and files_v else None
                if fname:
                    seg_path = os.path.join(seg["run_dir"], fname)
                    if os.path.isfile(seg_path):
                        _probe_jobs.append((seg, seg_path, _probe_resolution(seg, seg_path)))
            shots_out[k] = seg
        if _probe_jobs:
            _results = await asyncio.gather(*(job[2] for job in _probe_jobs))
            for (seg, _p, _c), wh in zip(_probe_jobs, _results):
                if wh:
                    seg["width"], seg["height"] = wh
        detail = {
            "ok": True,
            "task_id": task_id,
            "mode": mode,
            "time": mtime,
            "note": note,
            "concat": data.get("_concat"),
            # #40: 受理后落盘后死的批级错误 (顶层键·与 status 同款显式透传)
            "_batch_error": data.get("_batch_error"),
            "workflow": workflow,
            "shots": shots_out,
            "in_trash": in_trash,
            # V1.11 批 2 T3b: 版本树/拼接组合数据 — _reruns 徽标计数与 _concat_history 组合历史
            # (键名带下划线对齐前端读法 data._reruns / T5 版本树消费 _concat_history)
            "_reruns": data.get("_reruns") or [],
            "_concat_history": data.get("_concat_history") or [],
        }
        # 批1 E6 (#50): manifest._postfx 现值整表透出 — GUI 幂等判据权威数据源
        # (段账本 files 恒为无戳原件名, 文件名含戳判据恒失效). 有键才带
        # (seed_override 先例·旧批/无后期批响应无该键零变化); 值原样不做删减,
        # kind→sid→rel 子表由 GUI 侧按需取用.
        if "_postfx" in data:
            detail["_postfx"] = data["_postfx"]
        return web.json_response(detail)

    # V1.11 批 1 T6: 桩兼容 — 测试 _Router 桩无 delete 方法, 用 _register_route 统一包装,
    # 缺方法时静默 (路由不注册, 不影响主路径). 提前定义供后续 presets 端点复用.
    def _register_route(method, path, fn):
        attr = method.lower()
        m = getattr(server.PromptServer.instance.routes, attr, None)
        if m is None:
            return
        m(path)(fn)

    # V1.11 批 3 T2: 任务配置回填端点 — GET /h3_batch/history/config?task_id=
    # 寻址同 detail: resolve_manifest_path 双位置 → trash 兜底 (回收站也走 trash 寻址);
    # 但被回收的任务不可回填 (用户语义), 直接走 _trash_check_response.
    # 无 _config 键 → 400 + "该任务未留配置快照, 无法回填（V1.11 起经表单生成的任务才可回填）".
    # 错误信封同批1 起新端点口径: {ok:False, error, detail?} + 400/404.
    @server.PromptServer.instance.routes.get("/h3_batch/history/config")
    async def _h3_history_config(request):
        # S2: 越界日志 (output/archive 树外) — 仅记录, 下方既有 4xx 业务行为不变
        _cfg_od_raw = request.query.get("output_dir", "")
        _cfg_od = _status_output_dir(_cfg_od_raw)
        _h3_log_read_out_of_scope("history/config", _cfg_od_raw, _cfg_od, "output")
        task_id = str(request.query.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "missing_task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        output_dir = _cfg_od
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir_not_found"}, status=400)
        # 回收站拦截 — 与 detail 一致先 _find_in_trash, 但任务在 trash 一律拒绝回填
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        data, _deg = read_manifest_safe(mp)
        if not isinstance(data, dict) or not data:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        cfg = data.get("_config")
        if not isinstance(cfg, dict) or not cfg:
            return web.json_response(
                {"ok": False,
                 "error": "该任务未留配置快照，无法回填（V1.11 起经表单生成的任务才可回填）"},
                status=400)
        return web.json_response({"ok": True, "task_id": task_id, "config": cfg})

    # V1.11 批 3 T3: 配置预设端点 — 三合一 (GET 列表 / POST 保存 / DELETE 删除).
    # 同前缀 /h3_batch/presets, 用 HTTP 方法区分行为; 存储包根 PRESETS_DIR 下的 <安全名>.json.
    # 错误信封: {ok:False, error, detail?} + 400/404 (旧端点 V1.9 前形态不动, 不在统一范围内).
    # 桩兼容: 测试 _Router 桩无 delete 方法, 同 detail 删除端点用 _register_route 包装.
    async def _h3_presets_save(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "invalid_body"}, status=400)
        name = str(body.get("name", "") or "").strip()
        if not _PRESET_NAME_RE.fullmatch(name):
            return web.json_response(
                {"ok": False,
                 "error": "preset_name_invalid: 仅允许字母/数字/下划线/中文/连字符, 长度 1-40",
                 "detail": name}, status=400)
        cfg = body.get("config")
        if not isinstance(cfg, dict):
            return web.json_response({"ok": False, "error": "config_required"}, status=400)
        os.makedirs(PRESETS_DIR, exist_ok=True)
        path = os.path.join(PRESETS_DIR, "%s.json" % name)
        payload = {"name": name, "time": time.time(), "config": cfg}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return web.json_response({"ok": True, "name": name})

    async def _h3_presets_list(request):
        # V1.11 批 3 T3 (修): ?name= 单查 → 返回 {ok:true, name, config};
        #   不存在 → 404 preset_not_found. 无 name → 列表模式 (向后兼容).
        # 前端 加载按钮 GET /h3_batch/presets?name=X 期待单查形态, 修前此腿断链 (列表响应无 config).
        name_q = str(request.query.get("name", "") or "").strip()
        if name_q:
            if not _PRESET_NAME_RE.fullmatch(name_q):
                return web.json_response(
                    {"ok": False,
                     "error": "preset_name_invalid: 仅允许字母/数字/下划线/中文/连字符, 长度 1-40",
                     "detail": name_q}, status=400)
            path = os.path.join(PRESETS_DIR, "%s.json" % name_q)
            if not os.path.exists(path):
                return web.json_response({"ok": False, "error": "preset_not_found",
                                          "detail": name_q}, status=404)
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError) as e:
                return web.json_response({"ok": False, "error": "read_failed",
                                          "detail": str(e)}, status=500)
            if not isinstance(data, dict):
                return web.json_response({"ok": False, "error": "preset_corrupted",
                                          "detail": name_q}, status=500)
            return web.json_response({"ok": True, "name": name_q, "config": data.get("config", {})})
        if not os.path.isdir(PRESETS_DIR):
            return web.json_response({"ok": True, "presets": []})
        out = []
        for fn in os.listdir(PRESETS_DIR):
            if not fn.endswith(".json"):
                continue
            path = os.path.join(PRESETS_DIR, fn)
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            nm = data.get("name") or fn[:-5]
            tm = data.get("time") or 0.0
            try:
                tm_v = float(tm)
            except (TypeError, ValueError):
                tm_v = 0.0
            out.append({"name": nm, "time": tm_v})
        out.sort(key=lambda p: p["time"], reverse=True)
        return web.json_response({"ok": True, "presets": out})

    async def _h3_presets_delete(request):
        name = str(request.query.get("name", "") or "").strip()
        if not _PRESET_NAME_RE.fullmatch(name):
            return web.json_response(
                {"ok": False,
                 "error": "preset_name_invalid: 仅允许字母/数字/下划线/中文/连字符, 长度 1-40",
                 "detail": name}, status=400)
        path = os.path.join(PRESETS_DIR, "%s.json" % name)
        if not os.path.exists(path):
            return web.json_response({"ok": False, "error": "preset_not_found",
                                      "detail": name}, status=404)
        try:
            os.remove(path)
        except OSError as e:
            return web.json_response({"ok": False, "error": "delete_failed",
                                      "detail": str(e)}, status=500)
        return web.json_response({"ok": True, "name": name})

    _register_route("GET", "/h3_batch/presets", _h3_presets_list)
    _register_route("POST", "/h3_batch/presets", _h3_presets_save)
    _register_route("DELETE", "/h3_batch/presets", _h3_presets_delete)

    # V1.12 批 L (LLM 智能分镜) 波 1 T2: #49 端点 — /h3_batch/llm/presets
    # GET/POST/DELETE 三合一; 错误信封新口径 {ok:false, error, detail?}; DELETE 注册铁律
    # 同 V1.11 批 3 presets — 走 _register_route 包装, 桩 _Router 无 delete 也不打穿.
    async def _h3_llm_presets_list(request):
        try:
            items = _llm_presets_list()
        except (OSError, ValueError) as e:
            return web.json_response(
                {"ok": False, "error": "read_failed", "detail": str(e)}, status=500)
        return web.json_response({"ok": True, "presets": items})

    async def _h3_llm_presets_save(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_body", "detail": "object required"},
                status=400)
        name = body.get("name")
        base_url = body.get("base_url")
        model = body.get("model")
        api_key = body.get("api_key", None)
        context_window = body.get("context_window", None)
        max_tokens = body.get("max_tokens", None)  # 2026-10-26：可选最大输出 tokens（留空=默认窗口/4）
        # 组合校验 — 任一字段错返 400 + 错误前缀 (C4: 含范围/类型校验, 字母/负数/越界 400)
        v_err = _llm_presets_validate(name, base_url, model,
                                       context_window=context_window,
                                       max_tokens=max_tokens)
        if v_err is not None:
            field, msg, status = v_err
            return web.json_response(
                {"ok": False, "error": "%s: %s" % (field, msg),
                 "detail": {"name": name, "base_url": base_url, "model": model,
                            "context_window": context_window,
                            "max_tokens": max_tokens}},
                status=status)
        try:
            saved = _llm_presets_save(name, base_url, model,
                                      api_key=api_key,
                                      context_window=context_window,
                                      max_tokens=max_tokens)
        except (OSError, TypeError, ValueError) as e:
            return web.json_response(
                {"ok": False, "error": "write_failed", "detail": str(e)}, status=500)
        return web.json_response({"ok": True, "preset": saved})

    async def _h3_llm_presets_delete(request):
        name = str(request.query.get("name", "") or "").strip()
        if not _LLM_PRESET_NAME_RE.fullmatch(name):
            return web.json_response(
                {"ok": False, "error": "name: 非法名",
                 "detail": name}, status=400)
        try:
            hit = _llm_presets_delete(name)
        except OSError as e:
            return web.json_response(
                {"ok": False, "error": "delete_failed", "detail": str(e)}, status=500)
        if not hit:
            return web.json_response(
                {"ok": False, "error": "preset_not_found", "detail": name}, status=404)
        return web.json_response({"ok": True, "name": name})

    _register_route("GET", "/h3_batch/llm/presets", _h3_llm_presets_list)
    _register_route("POST", "/h3_batch/llm/presets", _h3_llm_presets_save)
    _register_route("DELETE", "/h3_batch/llm/presets", _h3_llm_presets_delete)

    # V1.12 批 L 波 1 批次 B T4: #51 端点 — /h3_batch/llm/sessions
    # GET 列表 / GET ?id=X 详情 (handler 内按 id query 切分支, 一路由两语义);
    # 错误信封同 #49: {ok:false, error, detail?} + 400/404/500;
    # 锁外调 llm_client (T5 才接), 锁内走 llm_sessions 同步读改.
    from . import llm_sessions
    _h3_llm_sessions = llm_sessions

    async def _h3_llm_sessions_get(request):
        # 当前契约: 单路由按 id 切分支 (无 id → 列表, 有 id → 详情); 保留独立 handler
        # 以便未来 #51 扩 delete/list-detail 分路由时不必破坏既有签名.
        sid = str(request.query.get("id", "") or "").strip()
        if not sid:
            # 无 id 走列表
            try:
                items = _h3_llm_sessions._list_sessions()
            except OSError as e:
                return web.json_response(
                    {"ok": False, "error": "read_failed", "detail": str(e)}, status=500)
            return web.json_response({"ok": True, "sessions": items})
        if not _h3_llm_sessions.SESSION_ID_RE.fullmatch(sid):
            return web.json_response(
                {"ok": False, "error": "invalid_session_id", "detail": sid},
                status=400)
        sess = _h3_llm_sessions._read_session(sid)
        if sess is None:
            path = _h3_llm_sessions._session_path(sid)
            if os.path.isfile(path):
                return web.json_response(
                    {"ok": False, "error": "read_failed",
                     "detail": "会话文件 JSON 损坏"}, status=500)
            return web.json_response(
                {"ok": False, "error": "session_not_found", "detail": sid},
                status=404)
        return web.json_response({"ok": True, "session": sess})

    _register_route("GET", "/h3_batch/llm/sessions", _h3_llm_sessions_get)

    # 批4 E1 (#47): DELETE /h3_batch/llm/sessions/messages?id=<sid>&index=<n>
    # 引擎侧真删历史消息 (GUI 编辑只是本地覆盖层, 消息真源在引擎). 锁内重写 messages
    # 数组 + 原子写; snapshot 不动 (项目设定快照保持); 回传删除后完整消息清单
    # (GUI 按它重键本地编辑覆盖层). 错误契约: id 非法/缺失 → 400 invalid_session_id
    # (与 #51 同码); index 形态非法 → 400 invalid_index; 会话不存在 → 404
    # session_not_found; index 越界 → 404 index_out_of_range (仓内"寻址对象不存在→404"
    # 惯例: session_not_found/preset_not_found/#63 not_found 同族).
    async def _h3_llm_sessions_message_delete(request):
        sid = str(request.query.get("id", "") or "").strip()
        if not _h3_llm_sessions.SESSION_ID_RE.fullmatch(sid):
            return web.json_response(
                {"ok": False, "error": "invalid_session_id", "detail": sid},
                status=400)
        raw_idx = str(request.query.get("index", "") or "").strip()
        try:
            idx = int(raw_idx)
        except ValueError:
            return web.json_response(
                {"ok": False, "error": "invalid_index", "detail": raw_idx},
                status=400)
        if idx < 0:
            return web.json_response(
                {"ok": False, "error": "invalid_index", "detail": raw_idx},
                status=400)
        try:
            sess = _h3_llm_sessions._delete_message(sid, idx)
        except IndexError:
            return web.json_response(
                {"ok": False, "error": "index_out_of_range", "detail": idx},
                status=404)
        except OSError as e:
            return web.json_response(
                {"ok": False, "error": "write_failed", "detail": str(e)}, status=500)
        if sess is None:
            # 与 #51 GET 同款兜底: 文件在但 JSON 损坏 → 500 read_failed; 否则 404
            path = _h3_llm_sessions._session_path(sid)
            if os.path.isfile(path):
                return web.json_response(
                    {"ok": False, "error": "read_failed",
                     "detail": "会话文件 JSON 损坏"}, status=500)
            return web.json_response(
                {"ok": False, "error": "session_not_found", "detail": sid},
                status=404)
        return web.json_response(
            {"ok": True, "session_id": sid, "messages": sess.get("messages") or []})

    _register_route("DELETE", "/h3_batch/llm/sessions/messages",
                    _h3_llm_sessions_message_delete)

    # V1.12 批 L 波 1 批次 C T5: #50 端点 — /h3_batch/llm/chat (POST)
    # 续/建会话 → 拼 system (档位文档 + 本会话 snapshot) → 超窗裁剪 → 调 llm_client
    # → 锁内追加 messages + 快照校验合并. 错误信封同 #49: {ok:false, error, detail?}.
    # LLM 调用在锁外 (锁内不能 await); 锁内仅 read→mutate→atomic write.
    from . import llm_permissions
    _h3_llm_permissions = llm_permissions
    import llm_client as _llm_client_mod  # 用模块属性查找 (供测试 monkeypatch)

    # D3 合并: shots[*] merge + globals 合并. 在锁内被 _h3_llm_chat 调用.
    # old_snapshots: 旧 session["snapshot"] (dict or None)
    # new_data: _ai_validate 规范化后数据 (含 globals / shots)
    # manual_edits: session["metadata"]["manual_edits"] (dict, 含 global/shots)
    # 返回新 snapshot 字段值 (dict).
    def _h3_llm_merge_snapshot(old_snapshot, new_data, manual_edits):
        old_shots = []
        if isinstance(old_snapshot, dict):
            old_shots_raw = old_snapshot.get("shots")
            if isinstance(old_shots_raw, list):
                old_shots = old_shots_raw
        old_shots_by_id = {}
        for sh in old_shots:
            if isinstance(sh, dict) and isinstance(sh.get("ID"), str) and sh.get("ID"):
                old_shots_by_id[sh["ID"]] = sh

        me_shots = {}
        if isinstance(manual_edits, dict):
            me_shots_raw = manual_edits.get("shots")
            if isinstance(me_shots_raw, dict):
                me_shots = me_shots_raw

        new_shots_raw = new_data.get("shots") or []
        new_shots_norm = new_shots_raw if isinstance(new_shots_raw, list) else []
        new_ids = set()
        for sh in new_shots_norm:
            if isinstance(sh, dict) and isinstance(sh.get("ID"), str) and sh.get("ID"):
                new_ids.add(sh["ID"])

        merged_shots = []
        # 旧镜 ID 中, 新快照未产出的 → 保留
        for sid, old_sh in old_shots_by_id.items():
            if sid not in new_ids:
                merged_shots.append(old_sh)
        # 模型产出 + 旧镜合并
        for new_sh in new_shots_norm:
            if not isinstance(new_sh, dict):
                continue
            sid = new_sh.get("ID") if isinstance(new_sh.get("ID"), str) else ""
            if not sid:
                merged_shots.append(new_sh)
                continue
            old_sh = old_shots_by_id.get(sid)
            if old_sh is not None and me_shots.get(sid) is True:
                # D3: 手改 shot → 保留旧 prompt, 其余按模型更新
                merged = dict(new_sh)
                merged["prompt"] = old_sh.get("prompt", new_sh.get("prompt", ""))
                merged_shots.append(merged)
            else:
                # 未手改 → 整行覆盖
                merged_shots.append(new_sh)

        # globals 合并: 提示词 特殊处理; 其他键始终模型覆盖
        old_globals = {}
        if isinstance(old_snapshot, dict):
            og = old_snapshot.get("globals")
            if isinstance(og, dict):
                old_globals = og
        new_globals = new_data.get("globals") or {}
        new_globals = new_globals if isinstance(new_globals, dict) else {}
        merged_globals = dict(new_globals)
        # 提示词: 模型产出优先, 但若手动标记 → 保留旧
        if me_shots is not None and isinstance(manual_edits, dict):
            if manual_edits.get("global") is True:
                # 手改: 保留旧值 (若无旧值则保留空)
                merged_globals["提示词"] = old_globals.get("提示词", "")
            else:
                # 未手改: 模型产出; 模型未产出 → 保留旧
                if "提示词" not in new_globals:
                    if "提示词" in old_globals:
                        merged_globals["提示词"] = old_globals["提示词"]
        else:
            if "提示词" not in merged_globals and "提示词" in old_globals:
                merged_globals["提示词"] = old_globals["提示词"]

        return {
            "mode": new_data.get("mode", "分镜"),
            "pool": new_data.get("pool", {}),
            "pool_usage": new_data.get("pool_usage", {}),
            "globals": merged_globals,
            "shots": merged_shots,
        }

    async def _h3_llm_chat(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"ok": False, "error": "invalid_json", "detail": "body 必须是合法 JSON"},
                status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_json", "detail": "body 必须是对象"},
                status=400)

        # 1. 参数解析 + 校验
        sid_in = body.get("session_id")
        sid_in = sid_in.strip() if isinstance(sid_in, str) and sid_in.strip() else None
        model = body.get("model", "")
        model = model.strip() if isinstance(model, str) else ""
        message = body.get("message", "")
        if not isinstance(message, str):
            message = ""
        tier = body.get("permission_tier", "普通")
        tier = tier if isinstance(tier, str) and tier else "普通"
        # #60 E3: 上游超时可配 (GUI 设置页「聊天超时」→ 请求体 timeout_sec).
        # 钳制 30-900 (与 GUI 区间同款)·缺省/非法 → llm_client 默认 (300s·单点).
        timeout_sec = _llm_client_mod._DEFAULT_TIMEOUT
        raw_timeout = body.get("timeout_sec")
        if isinstance(raw_timeout, (int, float)) and not isinstance(raw_timeout, bool):
            try:
                t_sec = int(raw_timeout)
            except (ValueError, OverflowError):   # nan / inf
                t_sec = None
            if t_sec is not None:
                timeout_sec = float(min(max(t_sec, _LLM_CHAT_TIMEOUT_MIN_SEC),
                                        _LLM_CHAT_TIMEOUT_MAX_SEC))

        if sid_in is not None and not _h3_llm_sessions.SESSION_ID_RE.fullmatch(sid_in):
            return web.json_response(
                {"ok": False, "error": "invalid_session_id", "detail": sid_in},
                status=400)
        if not model:
            return web.json_response(
                {"ok": False, "error": "unknown_model", "detail": "model 必填"},
                status=400)
        # 模型校验: 必须存在预设. 取含 key 版 (内部调用凭据, 不进任何对外响应).
        preset = _llm_presets_get_raw(model)
        if preset is None:
            return web.json_response(
                {"ok": False, "error": "unknown_model", "detail": model},
                status=400)
        # message 长度
        if not message:
            return web.json_response(
                {"ok": False, "error": "message_required", "detail": "message 不能为空"},
                status=400)
        if len(message) > 16384:
            return web.json_response(
                {"ok": False, "error": "message_too_long",
                 "detail": "message 长度 %d 超过 16384" % len(message)},
                status=400)
        # 档位校验 (非法值兜底为 "普通"; 严格错误码走 400)
        if tier not in ("普通", "高级", "完全"):
            return web.json_response(
                {"ok": False, "error": "permission_tier_invalid",
                 "detail": "须为 普通/高级/完全, 当前 %r" % tier},
                status=400)

        # 2. 会话续建
        if sid_in is None:
            sid, sess = _h3_llm_sessions._create_session(
                permission_tier=tier, model=model)
        else:
            sess = _h3_llm_sessions._read_session(sid_in)
            if sess is None:
                # 区分文件不存在 vs 文件坏 JSON
                path = _h3_llm_sessions._session_path(sid_in)
                if os.path.isfile(path):
                    return web.json_response(
                        {"ok": False, "error": "read_failed",
                         "detail": "会话文件 JSON 损坏"},
                        status=500)
                return web.json_response(
                    {"ok": False, "error": "session_not_found", "detail": sid_in},
                    status=404)
            sid = sid_in

        # 3. system 组装
        # D3 (1.14 整改批 D): 走异步入口 — asyncio.to_thread 包装, 高级/完全档
        # 的 os.walk + 多文件 read 移到独立线程, 不再阻塞 ComfyUI 主事件循环
        # (WS1-T5b1-必改2). 字节预算截停见 llm_permissions._FILE_READ_BUDGET.
        snapshot_for_sys = sess.get("snapshot")
        system_text = await _h3_llm_permissions.build_system_prompt_async(
            tier, snapshot_for_sys)

        # 4. messages 组装 + 过滤 (role 白名单) + #46 历史剥块 (只改发送体)
        sess_msgs = sess.get("messages") or []
        if not isinstance(sess_msgs, list):
            sess_msgs = []
        history_msgs = []
        skipped_shells = 0
        for m in sess_msgs:
            if not isinstance(m, dict):
                continue
            r = m.get("role")
            if r not in ("system", "user", "assistant"):
                continue
            c = m.get("content", "")
            if not isinstance(c, str):
                c = ""
            if r == "user":
                # #46: 历史 user 消息剥 GUI 隐藏块 (会话文件落盘原文不动)
                c = _h3_strip_hidden_blocks(c)
                if not c.strip():
                    # 剥后空壳 → 跳过 (防御分支·纯块消息无产生路径)·计入未发送数
                    skipped_shells += 1
                    continue
            history_msgs.append({"role": r, "content": c})
        # 当前 user 消息 (本轮全量保留·隐藏块不剥·省略标记只发送不落盘)
        user_ts = _h3_llm_sessions._now_ts()

        # 5. 超窗裁剪 (#46 两段式保头保尾 · 方案 v2.1 §四.2 + 批9 E1 让位步):
        #    ① 本轮 user 全额 (含省略标记预留 64) → ② system 预留 (初值 2100·
        #    紧张压至 half×0.25) → ③ 头部配额 (前 1-2 条·放不下少保不截断) →
        #    ④ 尾部全给最近 → ⑤ 富余回填 system (最多原文) →
        #    ⑥ 让位步 (system 未达全量 → 尾段最旧一条起逐条让位给文档).
        #    system 是固定档位文档 → 超预算截断 (warn, 不 500); 仅"最新 user 独条
        #    超半窗"才 500.
        checks_warns = []
        checks_errs = []
        # C4 (1.14 整改批 C): 历史脏值 / 异常路径 (字母/负数/越界/缺字段) → clamp 兜底
        # 到合法范围, 避免 "负半窗 → user > 负半窗 恒真 → 每次 chat 恒 500"; 缺/坏值走默认 8192.
        raw_cw = preset.get("context_window")
        try:
            cw_n = int(raw_cw)
        except (TypeError, ValueError):
            cw_n = _LLM_CONTEXT_WINDOW_DEFAULT
        if cw_n < _LLM_CONTEXT_WINDOW_MIN or cw_n > _LLM_CONTEXT_WINDOW_MAX:
            cw_n = _LLM_CONTEXT_WINDOW_DEFAULT
        context_window = cw_n
        half_window = context_window // 2
        # 2026-10-26（GUI1.4 老板裁·丙）：预设 max_tokens 优先；缺省/非法 = context_window//4
        # （去掉旧 4096 硬顶，响应输出截断问题）；下界由 //4 保底（窗口 256 → 64，与旧注释预算一致）。
        raw_mt = preset.get("max_tokens")
        try:
            mt_n = int(raw_mt) if raw_mt not in (None, "") else None
        except (TypeError, ValueError):
            mt_n = None
        if mt_n is not None and (mt_n < _LLM_MAX_TOKENS_MIN or mt_n > _LLM_MAX_TOKENS_MAX):
            mt_n = None
        max_output = mt_n if mt_n is not None else max(64, context_window // 4)

        def _total_chars(m_list):
            return sum(len(m["content"]) for m in m_list)

        # ① 本轮 user 全文最先全额保留 (含省略标记预留 64 字符)
        user_chars = len(message)
        if user_chars > half_window:
            # 单 user 独条超半窗 (不拆断语义) → 拒绝
            return web.json_response(
                {"ok": False, "error": "llm_context_overflow",
                 "detail": "最新 user 消息 %d 字符 > 半窗 %d"
                           % (user_chars, half_window)},
                status=500)
        marker_reserve = _H3_MARKER_RESERVE if history_msgs else 0
        budget_total = half_window - user_chars - marker_reserve
        # ② system 预留 = 角色段 + 档位文档前 2000 字符 (≈2100)
        sys_reserve = min(_H3_SYSTEM_RESERVE, len(system_text))
        sys_floor = int(half_window * _H3_SYSTEM_FLOOR_RATIO)
        if sys_reserve > budget_total:
            # 预算紧张 → system 压至下限 (half×0.25), 同时释放 64 字符标记预留
            # (降级档的省略信息由 carries_context_floor 承接·标记行不再发送)
            marker_reserve = 0
            budget_total = half_window - user_chars
            sys_reserve = min(max(sys_floor, 0), budget_total)
        sys_used = min(len(system_text), sys_reserve)
        budget_history = budget_total - sys_used
        # ③ 头部配额 = min(前 1-2 条剥块后总长, 剩余预算, half×0.5)
        #    放不下就少保 (降为 1 条或 0 条)·不截断消息内容
        head_quota = min(
            sum(len(m["content"]) for m in history_msgs[:2]),
            budget_history,
            int(half_window * _H3_HEAD_RATIO))
        head_count = 0
        head_used = 0
        for m in history_msgs[:2]:
            c = len(m["content"])
            if head_used + c <= head_quota:
                head_used += c
                head_count += 1
            else:
                break
        # ④ 尾部 = 剩余预算全给最近消息 (最新往最旧·放不下即停)
        tail_budget = budget_history - head_used
        tail_count = 0
        tail_used = 0
        for m in reversed(history_msgs[head_count:]):
            c = len(m["content"])
            if c <= tail_budget:
                tail_budget -= c
                tail_used += c
                tail_count += 1
            else:
                break
        # ⑤ 富余回填 system (最多原文)
        leftover = budget_history - head_used - tail_used
        sys_final = min(len(system_text), sys_used + max(0, leftover))
        # ⑥ 让位步 (#59 批9 E1): system 未达全量 → 从尾部保留段的**最旧一条**起逐条
        #    让位给文档 (语义: 规则文档完整性 > 最旧历史; 最新历史与本轮 user 不动).
        #    只改 tail_count/tail_used/doc_short/sys_final — **不自增 trimmed_old_count**
        #    (下方表达式按新 tail_count 自动计, 循环内自增会双重计数).
        doc_short = len(system_text) - sys_final
        while doc_short > 0 and tail_count > 0:
            oldest = history_msgs[len(history_msgs) - tail_count]
            freed = len(oldest["content"])
            tail_count -= 1
            tail_used -= freed
            doc_short -= freed
            sys_final = min(len(system_text), sys_final + freed)
        # 未发送条数 = 仅未发送 (被剥块但仍发送正文的不计·空壳跳过计入)
        trimmed_old_count = (len(history_msgs) + skipped_shells
                              - head_count - tail_count)
        # 中间省略标记 (只发送不落盘·删掉的条数=未发送数)
        marker_text = ""
        if trimmed_old_count > 0 and marker_reserve > 0:
            marker_text = _H3_OMISSION_MARKER % trimmed_old_count
            if len(marker_text) > marker_reserve:
                marker_text = ""
        user_content = (marker_text + "\n" + message) if marker_text else message
        assembled = []
        if sys_final > 0:
            assembled.append({"role": "system", "content": system_text[:sys_final]})
        assembled.extend(history_msgs[:head_count])
        assembled.extend(history_msgs[len(history_msgs) - tail_count:])
        assembled.append({"role": "user", "content": user_content, "ts": user_ts})
        if len(system_text) > sys_final:
            checks_warns.append("system 文档超预算已截断 (%d → %d 字符)"
                                % (len(system_text), sys_final))
        # 预算降级标记: 有历史但最近一条没能送出 (尾部为空)
        carries_context_floor = bool(history_msgs) and tail_count == 0 \
            and head_count < len(history_msgs)
        # 二次校验: 裁剪后仍超半窗 → 500 (防御)
        if _total_chars(assembled) > half_window:
            return web.json_response(
                {"ok": False, "error": "llm_context_overflow",
                 "detail": "裁剪后仍超半窗"},
                status=500)

        # 6. 调 LLM (锁外)
        try:
            result = await _llm_client_mod.llm_chat_completion(
                base_url=preset["base_url"],
                api_key=preset.get("api_key"),
                model=preset.get("model", model),
                messages=assembled,
                max_tokens=max_output,
                timeout=timeout_sec,
            )
        except _llm_client_mod.LLMCallError as e:
            return web.json_response(
                {"ok": False, "error": "llm_call_failed", "detail": e.detail},
                status=500)

        reply_text = result.get("content", "") if isinstance(result, dict) else ""
        finish_reason = result.get("finish_reason", "stop") if isinstance(result, dict) else "stop"

        # 1.14 追加批 T2: 剥离 mm:think / tool_call 片段 (老板实测泄漏进正常回复);
        # 同时记 checks_warns 提示剥离动作, 便于前端/审计识别模型思考/工具片段
        raw_reply_text = reply_text
        reply_text = _h3_llm_permissions._strip_llm_artifacts(reply_text)
        if isinstance(raw_reply_text, str) and reply_text != raw_reply_text.strip():
            checks_warns.append("已剥离模型思考/工具片段")

        # 7. 锁内追加 messages + 8. 快照校验合并 (在 _append_message 之后走锁内 read→mutate→atomic)
        # 用 _append_message 加 user; 再加 assistant; 然后快照合并.
        sess_after_user = _h3_llm_sessions._append_message(sid, "user", message, ts=user_ts)
        if sess_after_user is None:
            # 并发情况: 上一行 OK, 这里 OK 概率极高; 若失败, 视为 read_failed
            return web.json_response(
                {"ok": False, "error": "read_failed", "detail": "会话文件丢失"},
                status=500)
        sess_after_assistant = _h3_llm_sessions._append_message(sid, "assistant", reply_text)
        if sess_after_assistant is None:
            return web.json_response(
                {"ok": False, "error": "read_failed", "detail": "会话文件丢失"},
                status=500)
        # 快照合并 (会话级锁内)
        snapshot_response = sess_after_assistant.get("snapshot")  # 默认不动, 反映当前值
        # 只有回复含 fenced 块时才走 parse + validate 链.
        has_fence = isinstance(reply_text, str) and "```" in reply_text
        if has_fence:
            parsed, parse_errs = _ai_parse_text(reply_text)
            if parse_errs:
                # parse_errs 同口径 → snapshot=null
                checks_errs.extend(parse_errs)
                snapshot_response = None
            else:
                # 进入 _ai_validate
                errs, warns, norm = _ai_validate(parsed)
                checks_warns.extend(warns)
                if errs:
                    checks_errs.extend(errs)
                    snapshot_response = None
                else:
                    # 校验通过 → 合并写入 (锁内)
                    merged_snap = _h3_llm_merge_snapshot(
                        sess_after_assistant.get("snapshot"),
                        norm,
                        sess_after_assistant.get("metadata", {}).get("manual_edits", {}),
                    )
                    sess_final = _h3_llm_sessions._set_snapshot(sid, merged_snap)
                    snapshot_response = merged_snap if sess_final else None

        # 截断标注 (warn 级, 不阻断写入; 与 snapshot 校验无关)
        if finish_reason == "length":
            # #59 E2: 文案指对旋钮 — 截断的是**输出** (预设「最大输出 tokens」),
            # 旧文案指 context_window (输入窗) 是错旋钮。
            checks_warns.append(
                "输出被 max_tokens 截断——可在预设调大『最大输出 tokens』或缩小本轮输入")

        return web.json_response({
            "ok": True,
            "session_id": sid,
            "reply": reply_text,
            "finish_reason": finish_reason,
            "snapshot": snapshot_response,
            "checks": {"warns": checks_warns, "errs": checks_errs},
            "trimmed_old_count": trimmed_old_count,
            # #46 响应增强 (纯增量·旧 GUI 缺字段可忽略): 实际发送条数/字符数 +
            # 预算降级标记 (最近一条历史未能送出).
            "sent_messages_count": len(assembled),
            "sent_chars": _total_chars(assembled),
            "carries_context_floor": carries_context_floor,
            # #59 E2 (纯增量·旧 GUI 缺字段可忽略): 头部实际发送条数 —
            # GUI 据此精确标注头尾方向 (缺字段 → GUI 降级文案只报计数).
            "head_messages_count": head_count,
        })

    _register_route("POST", "/h3_batch/llm/chat", _h3_llm_chat)

    # #41 文档源可配置 (V41): /h3_batch/llm/chat_doc — GET 返回四字段 (方案 §2.1.2:
    # ok/path/effective_path/exists), POST {path} 写 h3_config.json 顶层键 llm_chat_doc
    # (temp+os.replace 原子写循 _llm_presets_persist 先例; 空串=删键回默认篇).
    # 校验前置在 llm_permissions._resolve_chat_doc (后缀/黑名单/存在性), 端点只校验类型.
    def _h3_config_write_key(key, value, delete=False):
        """原子写 h3_config.json 顶层键 (temp+os.replace; delete=True 删键).

        OSError/RuntimeError 由调用方处理; 保持原末尾换行 (防往返后 1 字节 diff).
        """
        cfg_path = _h3_llm_permissions._h3_config_path()
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        if delete:
            cfg.pop(key, None)
        else:
            cfg[key] = value
        os.makedirs(os.path.dirname(cfg_path) or ".", exist_ok=True)
        tmp = "%s.tmp.%d.%s" % (cfg_path, os.getpid(), uuid.uuid4().hex[:8])
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")   # 保持 h3_config.json 原末尾换行 (防往返后 1 字节 diff)
        replaced = False
        last_err = None
        for _ in range(100):
            try:
                os.replace(tmp, cfg_path)
                replaced = True
                break
            except PermissionError as e:
                last_err = e
                time.sleep(0.005)
        if not replaced:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise last_err if last_err is not None else RuntimeError(
                "h3_config 原子替换失败")

    def _h3_chat_doc_write(path_value):
        """写 h3_config.json 顶层键 llm_chat_doc; "" → 删键. 原子写, OSError/RuntimeError 由调用方处理."""
        _h3_config_write_key("llm_chat_doc", path_value, delete=(path_value == ""))

    async def _h3_llm_chat_doc_get(request):
        eff, ok, exists = _h3_llm_permissions._resolve_chat_doc()
        return web.json_response({
            "ok": ok,
            "path": _h3_llm_permissions._load_chat_doc() or "",
            "effective_path": eff,
            "exists": exists,
        })

    async def _h3_llm_chat_doc_save(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_body", "detail": "object required"},
                status=400)
        path_value = body.get("path")
        if not isinstance(path_value, str):
            return web.json_response(
                {"ok": False, "error": "path: 须为字符串", "detail": repr(path_value)},
                status=400)
        try:
            _h3_chat_doc_write(path_value.strip())
        except (OSError, RuntimeError) as e:
            return web.json_response(
                {"ok": False, "error": "write_failed", "detail": str(e)}, status=500)
        return web.json_response({"ok": True, "path": path_value.strip()})

    _register_route("GET", "/h3_batch/llm/chat_doc", _h3_llm_chat_doc_get)
    _register_route("POST", "/h3_batch/llm/chat_doc", _h3_llm_chat_doc_save)

    # #76 E5/E6: 分轨继承三键读写端点 — GET/POST /h3_batch/config/audio_ref
    # POST body {key, value: bool}; key 白名单=三键名 (防参数化端点覆写任意顶层键如 workflow_dir);
    # 原子写 h3_config 顶层键 + 写后重读回显 (引擎确认才落盘); 改键免重启 (submit 重读).
    # GET 纯读三键现值 (缺键/非 bool → false) 供 GUI 启动/开设置页回填; 读文件失败 → 500 人话.
    _AUDIO_REF_KEYS = ("h3_audio_ref_split", "h3_audio_ref_vocals",
                       "h3_audio_ref_background")

    async def _h3_audio_ref_config_save(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_body", "detail": "object required"},
                status=400)
        key = body.get("key")
        value = body.get("value")
        if not isinstance(key, str) or key not in _AUDIO_REF_KEYS:
            return web.json_response(
                {"ok": False,
                 "error": "key: 仅允许 %s" % "/".join(_AUDIO_REF_KEYS),
                 "detail": repr(key)}, status=400)
        if not isinstance(value, bool):
            return web.json_response(
                {"ok": False, "error": "value: 仅允许 bool", "detail": repr(value)},
                status=400)
        try:
            _h3_config_write_key(key, value)
        except (OSError, RuntimeError) as e:
            return web.json_response(
                {"ok": False, "error": "write_failed", "detail": str(e)}, status=500)
        # 写后重读回显 (引擎确认才落盘)
        try:
            with open(_h3_llm_permissions._h3_config_path(), encoding="utf-8") as f:
                stored = json.load(f).get(key)
        except (OSError, ValueError):
            stored = None
        if stored is not value:
            return web.json_response(
                {"ok": False, "error": "write_failed", "detail": "回读值不一致"},
                status=500)
        return web.json_response({"ok": True, "key": key, "value": stored})

    _register_route("POST", "/h3_batch/config/audio_ref", _h3_audio_ref_config_save)

    async def _h3_audio_ref_config_get(request):
        """读 h3_config 三键现值 (缺键/非 bool → false) — GUI 启动/开设置页回填用; 纯读不写."""
        try:
            with open(_h3_llm_permissions._h3_config_path(), encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError) as e:
            return web.json_response(
                {"ok": False, "error": "read_failed",
                 "detail": "读取 h3_config.json 失败: %s" % e}, status=500)
        if not isinstance(cfg, dict):
            cfg = {}
        out = {}
        for k in _AUDIO_REF_KEYS:
            v = cfg.get(k, False)
            out[k] = v if isinstance(v, bool) else False
        return web.json_response(out)

    _register_route("GET", "/h3_batch/config/audio_ref", _h3_audio_ref_config_get)

    # V1.12 批 L 波 1 批次 D T6B: #52 写端点 — /h3_batch/llm/prompts (POST)
    # 两步式 (preview → commit): preview 校验会话+目标, 返回变更清单 + 一次性 token;
    # commit 校验 token (匹配/未过期/未用), 写 snapshot + metadata._snapshot_writes +
    # manual_edits, 全部走会话级锁内原子写.
    # 错误信封同 #50/#51: {ok:false, error, detail?}.
    # token 引擎内存单例 (不落盘/不进日志/不进 #51 详情/不进错误 detail).
    import hashlib as _hashlib
    import secrets as _secrets

    # token 单例: session_id → [{token, expires_at, snapshot_hash, changes, used}]
    # 模块级 dict; 引擎进程内常驻; 30s 过期; 用后即废.
    _LLM_WRITE_TOKENS = {}
    _LLM_WRITE_TOKENS_GUARD = threading.Lock()
    _LLM_WRITE_TOKEN_TTL_S = 30  # 30s

    def _llm_prompts_now():
        # 集中 time.time 调用, 测试可 monkeypatch (handlers import 同名)
        return time.time()

    def _llm_prompts_hash(snapshot_dict, changes):
        """sha256 整个变更清单哈希 (绑定: snapshot 状态 + changes 序列化).

        snapshot_dict 锁外读 (与 token 时刻匹配, 防 TOCTOU);
        changes 是 preview 返回的 list[dict], 每项含 target/before/after.
        """
        snap_str = json.dumps(snapshot_dict or {}, sort_keys=True, ensure_ascii=False)
        chg_str = json.dumps(changes or [], sort_keys=True, ensure_ascii=False)
        h = _hashlib.sha256()
        h.update(snap_str.encode("utf-8"))
        h.update(b"\x00")
        h.update(chg_str.encode("utf-8"))
        return h.hexdigest()

    def _llm_prompts_make_token():
        """生成 token: sha256(snapshot_hash + changes_hash + 32 字节随机). 不含 PII."""
        return _secrets.token_urlsafe(24)  # 32 字符 URL-safe

    def _llm_prompts_validate_target(snapshot_dict, target):
        """校验 target 并定位 before. 返 (change_dict, error_str|None).

        error_str: "target" / "shot_not_found" / None.
        """
        if target == "global":
            gl = snapshot_dict.get("globals") or {}
            before = gl.get("提示词", "") if isinstance(gl, dict) else ""
            return {"target": "global", "before": before, "after": ""}, None
        if isinstance(target, str) and target.startswith("shot:"):
            sid_str = target[len("shot:"):]
            if not sid_str:
                return None, "target"
            shots = snapshot_dict.get("shots") or []
            for sh in shots:
                if isinstance(sh, dict) and sh.get("ID") == sid_str:
                    return {"target": target, "before": sh.get("prompt", ""), "after": ""}, None
            return None, "shot_not_found"
        return None, "target"

    def _llm_prompts_get_shot_prompt(snapshot_dict, target):
        """仅用于 commit: 拿到对应 shot dict (供 prompt 就地更新)."""
        sid_str = target[len("shot:"):]
        for sh in (snapshot_dict.get("shots") or []):
            if isinstance(sh, dict) and sh.get("ID") == sid_str:
                return sh
        return None

    async def _h3_llm_prompts(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"ok": False, "error": "invalid_json", "detail": "body 必须是合法 JSON"},
                status=400)
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": "invalid_json", "detail": "body 必须是对象"},
                status=400)

        # 1. session_id 校验 (与 #50/#51 同码 invalid_session_id)
        sid_in = body.get("session_id")
        if not isinstance(sid_in, str) or not _h3_llm_sessions.SESSION_ID_RE.fullmatch(sid_in):
            return web.json_response(
                {"ok": False, "error": "invalid_session_id", "detail": sid_in},
                status=400)
        # 2. mode 校验
        mode = body.get("mode")
        if mode not in ("preview", "commit"):
            return web.json_response(
                {"ok": False, "error": "mode 非法", "detail": "须为 preview/commit, 当前 %r" % mode},
                status=400)

        # 3. 会话读取 (commit/preview 都需要) — 锁外读; 写面在锁内 read→mutate→write
        sess = _h3_llm_sessions._read_session(sid_in)
        if sess is None:
            path = _h3_llm_sessions._session_path(sid_in)
            if os.path.isfile(path):
                return web.json_response(
                    {"ok": False, "error": "read_failed", "detail": "会话文件 JSON 损坏"},
                    status=500)
            return web.json_response(
                {"ok": False, "error": "session_not_found", "detail": sid_in},
                status=404)

        snapshot = sess.get("snapshot")
        if not isinstance(snapshot, dict):
            # snapshot=null (新会话尚无 snapshot) → 409 no_snapshot
            return web.json_response(
                {"ok": False, "error": "no_snapshot",
                 "detail": "会话尚无 snapshot, 请先经 #50 出一版快照"},
                status=409)

        # ============ preview 分支 ============
        if mode == "preview":
            # target 可选; 不传 = "全部待确认变更" (v1 简化: 视同单 global 变更, 含全部可改)
            target = body.get("target")
            content = body.get("content")
            if not isinstance(content, str):
                return web.json_response(
                    {"ok": False, "error": "content_required",
                     "detail": "content 必填且须为字符串"}, status=400)
            if content == "":
                return web.json_response(
                    {"ok": False, "error": "content_required",
                     "detail": "content 不能为空"}, status=400)
            if len(content) > 16384:
                return web.json_response(
                    {"ok": False, "error": "content_too_long",
                     "detail": "content 长度 %d 超过 16384" % len(content)},
                    status=400)

            # 计算 changes
            if not target:
                # 缺省 = 全部待确认变更: global + 每 shot 都列一条
                # v1 简化: 同一 content 用于全部
                changes = []
                gl = snapshot.get("globals") or {}
                before_global = gl.get("提示词", "") if isinstance(gl, dict) else ""
                changes.append({"target": "global", "before": before_global, "after": content})
                for sh in (snapshot.get("shots") or []):
                    if isinstance(sh, dict) and isinstance(sh.get("ID"), str) and sh.get("ID"):
                        changes.append({
                            "target": "shot:" + sh["ID"],
                            "before": sh.get("prompt", ""),
                            "after": content,
                        })
            else:
                # target 显式: 校验格式/存在性
                if not isinstance(target, str):
                    return web.json_response(
                        {"ok": False, "error": "target", "detail": "target 必须为字符串"},
                        status=400)
                ch, err = _llm_prompts_validate_target(snapshot, target)
                if err is not None:
                    return web.json_response(
                        {"ok": False, "error": err, "detail": target}, status=400)
                ch["after"] = content
                changes = [ch]

            # 生成 token + 落单例 (不落盘, 不进 detail)
            token = _llm_prompts_make_token()
            snap_hash = _llm_prompts_hash(snapshot, changes)
            expires_at = _llm_prompts_now() + _LLM_WRITE_TOKEN_TTL_S
            with _LLM_WRITE_TOKENS_GUARD:
                # 清理已过期项 + 同会话超额项
                lst = _LLM_WRITE_TOKENS.setdefault(sid_in, [])
                now = _llm_prompts_now()
                lst[:] = [e for e in lst if not e.get("used") and e["expires_at"] > now]
                lst.append({
                    "token": token,
                    "expires_at": expires_at,
                    "snap_hash": snap_hash,
                    "changes": changes,
                    "used": False,
                })

            return web.json_response({"ok": True, "changes": changes, "token": token})

        # ============ commit 分支 ============
        # mode == "commit"
        token = body.get("token")
        if not isinstance(token, str) or not token:
            return web.json_response(
                {"ok": False, "error": "token_required", "detail": "token 必填"},
                status=400)

        # 在 token 单例里查 (含过期清理 + 复用检测)
        entry = None
        saw_token = None  # None / "used" / "expired"
        with _LLM_WRITE_TOKENS_GUARD:
            lst = _LLM_WRITE_TOKENS.get(sid_in) or []
            now = _llm_prompts_now()
            # 先扫描: 命中 token; 同时清理已过期项 (无论 used 与否);
            # 保留未过期项 (含 used, 用于复用检测).
            kept = []
            for e in lst:
                if e["expires_at"] <= now:
                    # 过期 → 丢弃; 若这是我们要的 token, 记 expired
                    if e["token"] == token and saw_token is None:
                        saw_token = "expired"
                    continue
                if e["token"] == token:
                    if e.get("used"):
                        saw_token = "used"
                    else:
                        saw_token = "fresh"
                        entry = e
                kept.append(e)
            _LLM_WRITE_TOKENS[sid_in] = kept
            if entry is None:
                if saw_token == "used":
                    return web.json_response(
                        {"ok": False, "error": "token_used",
                         "detail": "token 已用过, 不可复用"}, status=409)
                if saw_token == "expired":
                    return web.json_response(
                        {"ok": False, "error": "token_expired",
                         "detail": "token 已过期 (30s 内有效)"}, status=409)
                return web.json_response(
                    {"ok": False, "error": "token_mismatch",
                     "detail": "token 与 preview 不匹配"}, status=409)

        # 复核 binding (snapshot 状态未变 + changes 一致)
        # 注意: snapshot 当前可能已被 #50 chat 更新; preview 时绑定的 snap_hash 是当时
        # snapshot 的快照; 若状态变化, 必须按 mismatch 处理 (不允许不同源写)
        cur_snap_hash = _llm_prompts_hash(snapshot, entry["changes"])
        if cur_snap_hash != entry["snap_hash"]:
            with _LLM_WRITE_TOKENS_GUARD:
                lst = _LLM_WRITE_TOKENS.get(sid_in) or []
                _LLM_WRITE_TOKENS[sid_in] = [e for e in lst if e["token"] != token]
            return web.json_response(
                {"ok": False, "error": "token_mismatch",
                 "detail": "snapshot 状态已变化, 需重新 preview"}, status=409)

        # 写面 — 锁内 read → mutate snapshot + metadata → 原子写
        changes = entry["changes"]
        lk = _h3_llm_sessions._get_lock(sid_in)
        applied = []
        with lk:
            # 锁内重读 (防 #50 chat 在 preview 与 commit 间改了 snapshot)
            path = _h3_llm_sessions._session_path(sid_in)
            data = _h3_llm_sessions._load_session_dict(path)
            if not isinstance(data, dict):
                return web.json_response(
                    {"ok": False, "error": "read_failed",
                     "detail": "会话文件 JSON 损坏"}, status=500)
            cur_snap = data.get("snapshot")
            if not isinstance(cur_snap, dict):
                return web.json_response(
                    {"ok": False, "error": "no_snapshot",
                     "detail": "snapshot 在 commit 期间被清空"}, status=409)
            # 二次复核 binding (锁内最新 snapshot)
            inner_hash = _llm_prompts_hash(cur_snap, changes)
            if inner_hash != entry["snap_hash"]:
                return web.json_response(
                    {"ok": False, "error": "token_mismatch",
                     "detail": "snapshot 在 commit 期间被更新, 需重新 preview"},
                    status=409)
            # 应用所有 changes 到 snapshot (就地)
            gl = cur_snap.get("globals")
            if not isinstance(gl, dict):
                gl = {}
                cur_snap["globals"] = gl
            for ch in changes:
                t = ch["target"]
                after = ch["after"]
                if t == "global":
                    gl["提示词"] = after
                elif isinstance(t, str) and t.startswith("shot:"):
                    sh = _llm_prompts_get_shot_prompt(cur_snap, t)
                    if sh is not None:
                        sh["prompt"] = after
                applied.append({"target": t, "after": after})
            # metadata._snapshot_writes 追加 (用 _record_snapshot_write)
            md = data.get("metadata") or {}
            writes = md.get("_snapshot_writes")
            if not isinstance(writes, list):
                writes = []
            now_ts = _llm_prompts_now()
            for ch in changes:
                writes.append({"target": ch["target"], "after": ch["after"], "ts": now_ts})
            md["_snapshot_writes"] = writes
            # manual_edits 标记
            me = md.get("manual_edits")
            if not isinstance(me, dict):
                me = {"global": False, "shots": {}}
            for ch in changes:
                t = ch["target"]
                if t == "global":
                    me["global"] = True
                elif isinstance(t, str) and t.startswith("shot:"):
                    sid_str = t[len("shot:"):]
                    shots_map = me.get("shots")
                    if not isinstance(shots_map, dict):
                        shots_map = {}
                    if sid_str:
                        shots_map[sid_str] = True
                    me["shots"] = shots_map
            md["manual_edits"] = me
            md["updated_at"] = now_ts
            data["metadata"] = md
            # 原子写
            _h3_llm_sessions._atomic_write_session(path, data)

        # 标 used (锁外; 不可再 commit — 用过的 entry 保留到 expires_at, 期间二次提交 → token_used)
        with _LLM_WRITE_TOKENS_GUARD:
            lst = _LLM_WRITE_TOKENS.get(sid_in) or []
            for e in lst:
                if e["token"] == token:
                    e["used"] = True

        return web.json_response({"ok": True, "applied": applied})

    _register_route("POST", "/h3_batch/llm/prompts", _h3_llm_prompts)

    # V1.11 批 1 T6: 两级删除/回收站端点 — 软删/真删/回收站视图/恢复.
    # 软删/真删合一走 DELETE /h3_batch/history (body 或 query 传 purge=true 即真删);
    # 视图 GET /h3_batch/history/trash; 恢复 POST /h3_batch/history/restore.
    # 错误信封同 status 端点口径; 互斥与端点级 _active_lock/_concat_running 同款.
    # V1.11 批 1 T6 桩兼容: _register_route 已上移到 detail 后 (本任务提前, 供 presets 复用).
    async def _h3_history_delete_impl(request):
        task_id = str(request.query.get("task_id", "") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        output_dir = _status_output_dir(request.query.get("output_dir", ""))
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        purge = str(request.query.get("purge", "") or "").strip().lower() in ("1", "true", "yes")

        # 互斥: _concat_running 期间禁 DELETE (T5 双向互斥同款, 防 Windows os.rename
        # 与 ffmpeg 读段产物冲突). _active 占用 → 仅拒绝"该 stem" 的批 (其他 stem 允许).
        with _concat_lock:
            if _concat_running:
                return web.json_response({"ok": False,
                                          "error": "concat_busy: 拼接运行中, 请稍候"},
                                         status=409)

        trash_dir = _trash_dir_for(output_dir)
        # V1.13 D1: task_id 防御性清洗 (上游已 regex 校验, 此处兜底), 防与 CSV 清洗 stem
        # 形成跨命名规则的拼写差异 — basename 仍以清洗后为准
        task_id = batch_core._sanitize_stem(task_id)
        basename = "h3_batch_manifest_%s.json" % task_id

        if purge:
            # 真删: 仅对 .h3_trash 内 manifest 生效 (不在回收站 → 400)
            trash_mp = os.path.join(trash_dir, basename)
            if not os.path.exists(trash_mp):
                return web.json_response({"ok": False,
                                          "error": "task_not_in_trash: 请先 DELETE 进回收站再 purge",
                                          "detail": trash_mp}, status=400)
            # active 互斥 (真删同样保护, 防 _reruns ledger 落盘与删除竞态)
            with _active_lock:
                if _active is not None and _active.is_alive():
                    _phase = getattr(_active_engine, "phase", "") or "跑批中"
                    return web.json_response({"ok": False,
                                              "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                                             status=409)
            # V1.11 收尾异步化 T2: 收尾中拒接真删 (防 _reruns ledger 落盘 vs 归档搬运)。
            if _finalizing_hit(output_dir):
                return web.json_response({"ok": False,
                                          "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                         status=409)
            os.remove(trash_mp)
            return web.json_response({"ok": True, "purged": True, "task_id": task_id,
                                      "path": trash_mp})

        # 软删: 寻址原位置 → 移入 .h3_trash; 视频/文件夹不动; _trash_meta 注入.
        # 1.11a 波 3 T1 项 7: 幂等判定走对应 output_dir 的 trash 根.
        # 顺序 = resolve-first (与 detail 端点同款): live manifest 在位 → 正常软删,
        # 不受回收站内同 stem 变体 (_repN) 干扰 (节点门复审实证: 前置 _find_in_trash
        # 会把"删原始批次"误报 already_in_trash —— _find_in_trash 变体正则匹配 _repN).
        # resolve 不到时再 _find_in_trash 兜底 (resolve_manifest_path 在 glob `*`
        # 不匹配 .h3_trash 隐藏子目录的平台上返 None, 显式 trash 寻址补足幂等判定),
        # 命中 → already_in_trash; 都无 → 404.
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            _trash_path_pre = _find_in_trash(task_id, output_dir)
            if _trash_path_pre:
                return web.json_response({"ok": False, "error": "already_in_trash"}, status=400)
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        if _is_in_trash(mp, output_dir=output_dir):
            # 已在 trash → 重复软删幂等返 ok:false (兜底, resolve_manifest_path
            # 在 Linux 等 glob `*` 匹配隐藏目录的平台上能找到 trash 内文件时
            # 仍走此分支; _is_in_trash 传 output_dir 走对应 trash 根).
            return web.json_response({"ok": False, "error": "already_in_trash"}, status=400)

        # active 互斥: 仅拒绝该 stem 的批, 其他 stem 的 active 不影响 (防止引擎写盘
        # 与文件移动竞态). _active_engine.csv_path 含 stem → 命中 → 409.
        with _active_lock:
            if _active is not None and _active.is_alive():
                _eng = _active_engine
                if _eng is not None:
                    _cur_csv = getattr(_eng, "csv_path", "") or ""
                    if _cur_csv and os.path.splitext(os.path.basename(_cur_csv))[0] == task_id:
                        _phase = getattr(_eng, "phase", "") or "跑批中"
                        return web.json_response({"ok": False,
                                                  "error": "active_busy: 该 stem 的批正在运行 (phase=%s)" % _phase},
                                                 status=409)
        # V1.11 收尾异步化 T2: 收尾中拒接软删 (防 shutil.move vs 归档搬运竞态)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"},
                                     status=409)

        os.makedirs(trash_dir, exist_ok=True)
        # 移动: 原位置 → trash (同盘符 os.rename 原子; 跨盘走 shutil.move 兜底)
        trash_mp = os.path.join(trash_dir, basename)
        # 防同名冲突 (极小概率, 同 stem 同批并发时可能撞)
        if os.path.exists(trash_mp):
            n = 2
            while os.path.exists(os.path.join(trash_dir, "%s_rep%d" % (os.path.splitext(basename)[0], n) + ".json")):
                n += 1
            trash_mp = os.path.join(trash_dir, "%s_rep%d" % (os.path.splitext(basename)[0], n) + ".json")
        orig_dir = os.path.dirname(os.path.abspath(mp))
        try:
            shutil.move(mp, trash_mp)
        except OSError as e:
            return web.json_response({"ok": False, "error": "move 失败: %s" % e}, status=500)

        # 注入 _trash_meta (原子性考量: 先移动再写, 万一写失败 manifest 仍在 trash, 但
        # 缺 orig_dir; 恢复时回 output 根层兜底. 比"先写后移动"更安全: 写失败时 manifest
        # 还在原位置, 用户无感; 而先写后移动在移动失败时原位置 manifest 已带 _trash_meta,
        # history 列表扫描虽会过滤 _trash_meta 是 _RESERVED_KEYS 不影响, 但语义错位).
        try:
            _manifest_write(trash_mp, lambda existing: _inject_trash_meta(existing, orig_dir))
        except OSError as e:
            print("[H3Batch] 软删 _trash_meta 写入失败 (manifest 仍在 trash 缺元数据): %s" % e,
                  flush=True)

        return web.json_response({"ok": True, "deleted": True, "task_id": task_id,
                                  "path": trash_mp, "orig_dir": orig_dir})

    def _inject_trash_meta(existing, orig_dir):
        if not isinstance(existing, dict):
            existing = {}
        existing["_trash_meta"] = {
            "orig_dir": orig_dir,
            "deleted_at": time.time(),
        }
        return existing

    _register_route("DELETE", "/h3_batch/history", _h3_history_delete_impl)

    @server.PromptServer.instance.routes.get("/h3_batch/history/trash")
    async def _h3_history_trash(request):
        # S2: 越界日志 (output/archive 树外) — 仅记录, 下方既有 4xx/200 业务行为不变
        _trash_od_raw = request.query.get("output_dir", "")
        _trash_od = _status_output_dir(_trash_od_raw)
        _h3_log_read_out_of_scope("history/trash", _trash_od_raw, _trash_od, "output")
        output_dir = _trash_od
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        trash_dir = _trash_dir_for(output_dir)
        if not os.path.isdir(trash_dir):
            return web.json_response({"ok": True, "tasks": [], "total": 0})

        entries = []
        for name in sorted(os.listdir(trash_dir)):
            if not (name.startswith("h3_batch_manifest_") and name.endswith(".json")):
                continue
            mp = os.path.join(trash_dir, name)
            if not os.path.isfile(mp):
                continue
            try:
                mtime = os.path.getmtime(mp)
            except OSError:
                continue
            stem = name[len("h3_batch_manifest_"):-len(".json")]
            data, degraded = read_manifest_safe(mp)
            if not isinstance(data, dict) or not data:
                continue
            shots = {k: v for k, v in data.items() if k not in _RESERVED_KEYS
                     and isinstance(v, dict)}
            success = sum(1 for v in shots.values()
                          if v.get("status") == "success" and v.get("review") != "void")
            failed = sum(1 for v in shots.values() if v.get("status") == "failed")
            void = sum(1 for v in shots.values()
                       if v.get("status") == "success" and v.get("review") == "void")
            pending = sum(1 for v in shots.values()
                          if v.get("status") not in ("success", "failed"))
            mode = data.get("_mode")
            if not mode:
                mode = "拼接" if "_concat" in data else "分镜"
            folder = ""
            for v in shots.values():
                rd = v.get("run_dir")
                if isinstance(rd, str) and rd:
                    folder = os.path.basename(rd.rstrip("\\/"))
                    break
            note = data.get("_note") or ""
            if isinstance(note, str) and len(note) > 200:
                note = note[:200]
            entries.append({
                "task_id": stem,
                "folder": folder,
                "time": mtime,
                "mode": mode,
                "success": success,
                "failed": failed,
                "void": void,
                "pending": pending,
                "note": note,
                "archived": False,
                "degraded": degraded,
                "deleted_time": mtime,
            })
        entries.sort(key=lambda e: e["time"], reverse=True)
        return web.json_response({"ok": True, "tasks": entries, "total": len(entries)})

    @server.PromptServer.instance.routes.post("/h3_batch/history/restore")
    async def _h3_history_restore(request):
        # 真机 P0 修复: 与 approve/void 同款两读法 ——
        # request.query 优先 (curl `?task_id=` 形态), 无 task_id 再尝试 body JSON,
        # 无 body / body 不是 JSON / body 缺 task_id → 缺参 400. body 传参兼容保留.
        task_id = str(request.query.get("task_id", "") or "").strip()
        output_dir_raw = request.query.get("output_dir", "")
        if not task_id:
            # body 兜底 (旧调用方/前端 fetch 的 JSON 形态)
            try:
                body = await request.json()
            except (ValueError, json.JSONDecodeError):
                body = None
            if isinstance(body, dict):
                task_id = str(body.get("task_id", "") or "").strip()
                if not output_dir_raw:
                    output_dir_raw = body.get("output_dir", "")
            if not task_id:
                return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        output_dir = _status_output_dir(output_dir_raw)
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        # V1.13 D1: 防御性清洗 (同上 — delete 端点同款口径)
        task_id = batch_core._sanitize_stem(task_id)
        basename = "h3_batch_manifest_%s.json" % task_id
        # B7 (I3-D1): 寻址统一走 _find_in_trash 边界口径 — 精确名或 <stem>_rep<digit>
        # 合法变体 (取 mtime 最新). 旧实现回退分支 startswith 前缀扫描 → trash 内只有
        # 前缀相近更长 stem (请求 '卡1'、有 '卡10') 时静默恢复并改名别的任务的 manifest.
        # 附带消除: 旧扫描 os.listdir+getmtime 在并发 purge 下 OSError 未捕获 → 500.
        trash_mp = _find_in_trash(task_id, output_dir)
        if not trash_mp:
            return web.json_response({"ok": False, "error": "not_found_in_trash"}, status=404)

        # 取 _trash_meta (若无: 回 output 根层兜底)
        data, _deg = read_manifest_safe(trash_mp)
        meta = (data or {}).get("_trash_meta") if isinstance(data, dict) else None
        orig_dir = meta.get("orig_dir") if isinstance(meta, dict) else None
        if not orig_dir or not os.path.isdir(orig_dir):
            orig_dir = os.path.abspath(output_dir)
        # 1.11a 波 3 T1 项 5: 变体恢复剥 _rep<digit> 后缀回原始 stem —
        # 旧实现直接用 basename=stem 作为 target, 但 trash 内的 _rep<N> 文件落盘后
        # 任务身份仍带 _rep<N>, 历史列表按 stem 寻址不到. 剥后缀与既有 basename
        # 同名冲突 → 走既有 409 target_exists_conflict 分支 (下面一行).
        # 正则同 _find_in_trash 变体语义 (B7 起寻址已统一走该口径).
        _variant_re = re.compile(r"^(h3_batch_manifest_.+?)_rep\d+\.json$")
        _trash_basename = os.path.basename(trash_mp)
        _m = _variant_re.match(_trash_basename)
        target_basename = _m.group(1) + ".json" if _m else basename
        target = os.path.join(orig_dir, target_basename)
        # 同 stem 已存在 → 409 冲突 (含原 stem 已有文件 vs 剥后缀等于原 stem)
        if os.path.exists(target):
            return web.json_response({"ok": False, "error": "target_exists_conflict",
                                      "detail": target}, status=409)

        os.makedirs(orig_dir, exist_ok=True)
        try:
            shutil.move(trash_mp, target)
        except OSError as e:
            return web.json_response({"ok": False, "error": "move 失败: %s" % e}, status=500)

        # 移除 _trash_meta (恢复后正常 manifest 不应带此键)
        try:
            _manifest_write(target, lambda existing: _strip_trash_meta(existing))
        except OSError as e:
            print("[H3Batch] 恢复 _trash_meta 移除失败 (manifest 已回原位置): %s" % e,
                  flush=True)
        return web.json_response({"ok": True, "restored": True, "task_id": task_id,
                                  "path": target})

    # V1.11 批 2 T4: 任务备注写入端点 — body 两读法 (query 优先, 与 approve/restore 同款).
    #   _note 截 200 字 (与列表端点一致, 防止单字段爆量); 回收站内 400 task_in_trash;
    #   _manifest_write 锁内 read→mutate→write 原子; _note 已进 _RESERVED_KEYS (批1 T2 写入,
    #   不需新增). 响应 {ok:true, note: 截断后}.
    @server.PromptServer.instance.routes.post("/h3_batch/history/note")
    async def _h3_history_note(request):
        task_id = str(request.query.get("task_id", "") or "").strip()
        note_raw = request.query.get("note", "")
        output_dir_raw = request.query.get("output_dir", "")
        if not task_id or note_raw == "":
            # body 兜底 — 与 approve/void/restore 同款 query 优先 + body 兜底
            try:
                body = await request.json()
            except (ValueError, json.JSONDecodeError):
                body = None
            if isinstance(body, dict):
                if not task_id:
                    task_id = str(body.get("task_id", "") or "").strip()
                if note_raw == "":
                    note_raw = body.get("note", "")
                if not output_dir_raw:
                    output_dir_raw = body.get("output_dir", "")
        if not task_id:
            return web.json_response({"ok": False, "error": "缺少参数 task_id"}, status=400)
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", task_id):
            return web.json_response({"ok": False, "error": "invalid_task_id"}, status=400)
        if note_raw is None:
            note_raw = ""
        if not isinstance(note_raw, str):
            note_raw = str(note_raw)
        # 截 200 (与列表端点 _note 截断口径一致)
        note = note_raw[:200]
        output_dir = _status_output_dir(output_dir_raw)
        if not os.path.isdir(output_dir):
            return web.json_response({"ok": False, "error": "output_dir 不存在"}, status=400)
        # 回收站只读约束 — 与 approve/void/rerun/concat/delete 同款
        if _find_in_trash(task_id, output_dir):
            return web.json_response(_trash_check_response(), status=400)
        mp = resolve_manifest_path(task_id, output_dir)
        if not mp:
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        # V1.11 收尾异步化 T2: 收尾中拒接 note 写盘 (同 approve/void, 防写 manifest
        # vs 归档搬运竞态 — note 端点无 active 检查, 紧靠 resolve 之后插守卫)。
        if _finalizing_hit(output_dir):
            return web.json_response({"ok": False,
                                      "error": "finalizing_busy: 上一批正在收尾(拼接/归档), 请稍候"}, status=409)
        sig = ["ok"]
        def _mut(existing):
            if not isinstance(existing, dict) or not existing:
                sig[0] = "no_manifest"
                return None
            existing["_note"] = note
            return existing
        try:
            _manifest_write(mp, _mut)
        except OSError as e:
            return web.json_response({"ok": False, "error": "manifest 写入失败: %s" % e}, status=500)
        if sig[0] == "no_manifest":
            return web.json_response({"ok": False, "error": "manifest 不存在"}, status=404)
        return web.json_response({"ok": True, "task_id": task_id, "note": note})

    def _strip_trash_meta(existing):
        if not isinstance(existing, dict):
            return existing
        existing.pop("_trash_meta", None)
        return existing

    @server.PromptServer.instance.routes.get("/h3_batch/vocab")
    async def _h3_vocab(request):
        return web.json_response(load_vocab())

    # 表单生成的 CSV 都落 input 目录; 前端 csv_path 为空时浏览从这里起跳
    @server.PromptServer.instance.routes.get("/h3_batch/input_dir")
    async def _h3_input_dir(request):
        return web.json_response({"dir": folder_paths.get_input_directory()})

    # V1.11 批 8 任务 81.3 (观察项清偿 C2): workflow 模板目录只读端点 — 与 #27 input_dir 同口径
    #   返回 h3_config.json workflow_dir 字段 (batch_core.H3_WORKFLOW_DIR 已 import :27).
    #   纯只读: 不接受 query/body 参数, 始终返回 h3_config 配值, 不发副作用.
    @server.PromptServer.instance.routes.get("/h3_batch/workflow_dir")
    async def _h3_workflow_dir(request):
        return web.json_response({"dir": H3_WORKFLOW_DIR})

    # #47 档2: 版本查询端点 — 供 GUI 零参数探活/对版 (与 workflow_dir 同纯只读口径).
    #   engine_version 取 batch_core.ENGINE_VERSION 单点 (manifest 戳记同源, 不再两处各写);
    #   min_gui_version = 引擎对 GUI 的最低要求, 首版起步值.
    @server.PromptServer.instance.routes.get("/h3_batch/version")
    async def _h3_version(request):
        return web.json_response({"engine_version": batch_core.ENGINE_VERSION,
                                  "min_gui_version": "1.0"})

    # V1.9 批 2 T2.2: 资源目录扫描端点 — kind=lora|model|clip|vae; all=1 跳过 R4 筛选。
    # 词表/官方清单从 h3_config.json 实时读 (免重启); 损坏回落默认。
    # 供批 2 后续 R1 (LoRA 增删) / R2 (模型下拉切换) 消费。
    @server.PromptServer.instance.routes.get("/h3_batch/resources")
    async def _h3_get_resources(request):
        kind = request.query.get("kind", "").strip().lower()
        if not kind:
            return web.json_response({"error": "缺少参数 kind (lora/model/clip/vae)"}, status=400)
        if kind not in _RS_KIND_TO_FOLDER:
            return web.json_response(
                {"error": "kind 必须是 lora/model/clip/vae, 收到: %s" % kind}, status=400)
        show_all = request.query.get("all", "").strip() == "1"
        try:
            body = _rs_scan_kind(kind, folder_paths, show_all=show_all)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response(body)

    # V1.13 必修 4: GET /h3_batch/clip_health — text_encoder 词嵌入层量化声明扫描
    #   替原 _CLIP_BAD_TOKENS 文件名子串黑名单. 仅读 safetensors 头 8B + JSON header
    #   + model.embed_tokens.comfy_quant 张目 data_offsets 区间原始字节, 不加载权重.
    #   header 长度 > 10MB 一律拒解析返 null (sanity cap, 防损坏文件巨读).
    #   降级契约: 单文件失败 → embed_convrot=null (前端宁放过不误伤).
    _CLIP_HEALTH_KEY = "model.embed_tokens.comfy_quant"
    _CLIP_HEALTH_MAX_HEADER = 10 * 1024 * 1024  # 10MB sanity cap

    def _clip_health_scan_one(abs_path):
        """读单 .safetensors 文件的 comfy_quant 张目声明.

        返回 (embed_convrot: bool|None) — 解析失败/损坏/超 cap → None.
        """
        try:
            with open(abs_path, "rb") as f:
                hdr_len_bytes = f.read(8)
                if len(hdr_len_bytes) < 8:
                    return None
                n = int.from_bytes(hdr_len_bytes, "little")
                # sanity cap 防损坏文件巨读
                if n <= 0 or n > _CLIP_HEALTH_MAX_HEADER:
                    return None
                hdr_raw = f.read(n)
                if len(hdr_raw) < n:
                    return None  # 截断
                try:
                    hdr = json.loads(hdr_raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None
                entry = hdr.get(_CLIP_HEALTH_KEY)
                if not isinstance(entry, dict):
                    return None  # 张目不在场
                offsets = entry.get("data_offsets")
                if not (isinstance(offsets, list) and len(offsets) == 2):
                    return None
                off, end = int(offsets[0]), int(offsets[1])
                if end < off or (end - off) > _CLIP_HEALTH_MAX_HEADER:
                    return None
                # 跳到 8B header_len + n JSON header + off 张目起始
                f.seek(8 + n + off)
                data = f.read(end - off)
                # UTF-8 / 字节两路判定 convrot
                try:
                    txt = data.decode("utf-8")
                    return "convrot" in txt
                except UnicodeDecodeError:
                    return b"convrot" in data
        except (OSError, ValueError, OverflowError):
            return None

    @server.PromptServer.instance.routes.get("/h3_batch/clip_health")
    async def _h3_get_clip_health(request):
        try:
            files = folder_paths.get_filename_list("clip") or []
        except Exception as e:
            return web.json_response(
                {"files": [], "error": "folder_paths.get_filename_list(clip) 失败: %s" % e},
                status=200)
        # folder_paths 返回的是 basename, 实际路径需调 get_full_path 才能拿到绝对路径
        out_files = []
        for fname in files:
            embed_convrot = None
            try:
                full = folder_paths.get_full_path("clip", fname)
                if full:
                    embed_convrot = _clip_health_scan_one(full)
            except Exception:
                embed_convrot = None
            out_files.append({"name": fname, "embed_convrot": embed_convrot})
        return web.json_response({"files": out_files})

    # V1.9 批 2 T2.4 R1: 模板 LoRA 发现端点 — 解析 UI 形态模板 JSON, 提取 LoRA 节点
    # (LoraLoader/LoraLoaderModelOnly/MiniMaxH3TurboLoRA) 供前端"工作流自带"列表展示 +
    # 编辑护栏 (template 源条目禁止删除/改强度)。只读扫描, 非 LoRA 节点零触碰。
    # V1.9 T2.5: 响应新增 `loaders` 字段 (R2 模型/CLIP/VAE 切换时下拉"当前值"用):
    # {unet, clip, vae_video, vae_audio}; 无则 null; 按 nodes 出现顺序。
    @server.PromptServer.instance.routes.get("/h3_batch/template_loras")
    async def _h3_get_template_loras(request):
        wf = (request.query.get("workflow_path", "") or "").strip()
        # S2: 越界日志 (workflow 树外) — 仅记录, 下方既有 400/扫描行为不变
        _h3_log_read_out_of_scope("template_loras", wf, _resolve_workflow_path(wf), "workflow")
        if not wf:
            return web.json_response(
                {"error": "缺少参数 workflow_path"}, status=400)
        try:
            loras = _rs_discover_template_loras(wf)
            loaders = _rs_discover_template_loaders(wf)
        except FileNotFoundError as e:
            return web.json_response({"error": str(e)}, status=400)
        except ValueError as e:
            # JSON 解析失败 / 路径为空 / 其他可恢复错误
            return web.json_response({"error": str(e)}, status=400)
        # V1.11 批4 T4 D6: 顶层 has_pdd 键 (端点响应 dict 内联构造, 非透传) —
        #   前端 _loadAndMergeTemplate 拿到后展示互斥预警条.
        # 门审修复: 先 _resolve_workflow_path 解析相对路径 (UI 下拉形态 'PDD/foo.json'
        #   相对 H3_WORKFLOW_DIR), 与上方 _rs_discover_* 同口径; 否则 open() 用
        #   原始相对路径 → OSError → has_pdd 静默 False → 预警条标准用法不显示.
        has_pdd = False
        try:
            _wf_resolved = _resolve_workflow_path(wf)
            with open(_wf_resolved, encoding="utf-8") as _wf:
                _wf_data = json.load(_wf)
            has_pdd = _rs_template_has_pdd(_wf_data)
        except (OSError, ValueError):
            has_pdd = False
        return web.json_response({"loras": loras, "loaders": loaders, "has_pdd": has_pdd})

    # 缩略图: 与 browse 同级的本机可读定位 (见 PRD 安全声明), 仅限图片扩展名
    # ui-thumb-cache2: 加 ETag / 304 / Cache-Control 持久缓存头; 304 必须在解码前返回
    _THUMB_DECODABLE_EXTS = (".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff")
    # T9 任务②: 视频扩展名走首帧 PNG 分支 (ffmpeg 解码, 缓存键同源); 与图片侧互不影响
    _THUMB_VIDEO_EXTS = (".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv")
    # 视频独立 Semaphore(2) (v2 建议4): 坏视频 ffmpeg 8s 占槽不影响图片缩略图, 限流峰值独立
    # 解码并发限流: 大文件夹(数百张图)同时点开, 先到先得 Semaphore(4) 槽位,
    # 其余在事件循环 await 排队 — 事件循环保持响应, 不会再被 PIL 同步解码饿死。
    # 延迟创建: asyncio.Semaphore 构造时必须绑定当前运行的事件循环, 模块 import 时
    # 通常没有 (PromptServer.instance 首次 GET 进来才进入 loop), 所以延迟到 handler 内。
    _THUMB_SEM = None
    # T9 任务②: 视频独立 Semaphore(2) — 坏视频 ffmpeg 8s 占槽不饿死图片侧
    _THUMB_VIDEO_SEM = None
    # Task 3 缩略图磁盘缓存: 两级目录 _THUMB_CACHE_DIR\<sha1(abs_path)[:8]>\<sha1(etag_src)[:16]>.png|.jpg
    # 缓存键与 ETag 同源(etag_src=path|mtime_ns|size); 源 mtime/size 变 → 键变 → 天然失效
    # 兜底: 老测试 stub 未必实现 get_temp_directory → 回退到系统 temp
    # 2026-09-20 #28: 缓存目录迁出 ComfyUI temp — main.py cleanup_temp() 启动即清空 temp,
    #   每次重启后缩略图全量重抽帧 (历史页首次浏览极慢). 改持久本地目录:
    #   H3_THUMB_CACHE_DIR 环境变量 (测试隔离/定制) > LOCALAPPDATA (Windows) > 用户主目录.
    _thumb_cache_root = (os.environ.get("H3_THUMB_CACHE_DIR")
                         or os.environ.get("LOCALAPPDATA")
                         or os.path.expanduser("~"))
    _THUMB_CACHE_DIR = os.path.join(_thumb_cache_root, "h3_thumb_cache")

    def _thumb_cache_paths(p, ext, st, max_size=128):
        """两级缓存路径 + 同源目录: cache_key = sha1(etag_src + size)[:16], 源/内容/size 变 → 键变."""
        src_abs = os.path.abspath(p)
        src_hash = hashlib.sha1(src_abs.encode("utf-8")).hexdigest()[:8]
        etag_src = "%s|%d|%d" % (p, st.st_mtime_ns, st.st_size)
        content_hash = hashlib.sha1(
            (etag_src + "|size=%d" % max_size).encode("utf-8")).hexdigest()[:16]
        is_jpeg = ext in (".jpg", ".jpeg", ".jpe")
        cache_ext = ".jpg" if is_jpeg else ".png"
        src_dir = os.path.join(_THUMB_CACHE_DIR, src_hash)
        return os.path.join(src_dir, content_hash + cache_ext), src_dir

    def _read_thumb_cache(cache_path):
        """读缓存字节; 0 字节 = 负缓存命中标记 → 返回 b"" 让调用方按 sentinel 走 404;
        非空才 PIL.verify() 校验结构 → 校验失败返 None (静默降级直解码)."""
        try:
            with open(cache_path, "rb") as f:
                data = f.read()
            if len(data) == 0:
                return b""
            try:
                Image.open(io.BytesIO(data)).verify()
            except Exception:
                return None
            return data
        except OSError:
            return None

    def _write_thumb_cache(cache_path, src_dir, data):
        """原子写: makedirs → 懒清理同源目录其他文件 → 临时文件 + os.replace; 任何异常静默吞掉."""
        try:
            os.makedirs(src_dir, exist_ok=True)
            try:
                for name in os.listdir(src_dir):
                    full = os.path.join(src_dir, name)
                    if full != cache_path:
                        try:
                            os.remove(full)
                        except OSError:
                            pass
            except OSError:
                pass
            tmp = cache_path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, cache_path)
        except Exception:
            pass
    @server.PromptServer.instance.routes.get("/h3_batch/thumb")
    async def _h3_thumb(request):
        p = request.query.get("path", "")
        # S2: 越界日志 (input/output/archive 树外) — 仅记录, 下方既有 200/404/304 行为不变
        _h3_log_read_out_of_scope("thumb", p, p, "data")
        # 批 B 节点 B-III 三修问题 3a: max_size 查询参数 — 默认 128 保持既有消费者不变;
        # 浮层大图传 max_size=1024 (PIL thumbnail 等比缩). 范围 [16, 2048] 限幅防 OOM.
        _max_size_raw = request.query.get("max_size", "")
        try:
            _max_size = int(_max_size_raw) if _max_size_raw else 128
        except ValueError:
            _max_size = 128
        _max_size = max(16, min(2048, _max_size))
        ext = os.path.splitext(p)[1].lower()
        if ext not in _THUMB_DECODABLE_EXTS:
            if ext not in _THUMB_VIDEO_EXTS or not os.path.isfile(p):
                return web.json_response({"error": "not found"}, status=404)
            # T9 任务②: 视频分支 — ffmpeg 抽首帧 PNG; 字节不复用图片侧 (elifs, 独立 Semaphore)
            try:
                st = os.stat(p)
            except OSError:
                return web.json_response({"error": "not found"}, status=404)
            etag_src = "%s|%d|%d" % (p, st.st_mtime_ns, st.st_size)
            etag = '"' + hashlib.sha1(etag_src.encode("utf-8")).hexdigest()[:16] + '"'
            cache_headers = {"ETag": etag, "Cache-Control": "private, max-age=86400"}
            if_none = request.headers.get("If-None-Match", "").strip()
            if if_none and (if_none == etag or if_none == "*"):
                return web.Response(status=304, headers=cache_headers)
            cache_path, src_dir = _thumb_cache_paths(p, ".png", st, _max_size)

            def _cache_or_extract():
                cached = _read_thumb_cache(cache_path)
                if cached is not None:
                    # 负缓存命中 (b""): 跳过 ffmpeg, 直接让上层 404
                    if cached == b"":
                        return None
                    return cached
                data = video_first_frame_png(p, _max_size)
                if data is None:
                    # 抽帧失败: 写 0 字节 sentinel, 下次同键直接命中 sentinel 不再抽帧
                    try:
                        _write_thumb_cache(cache_path, src_dir, b"")
                    except Exception:
                        pass
                    return None
                _write_thumb_cache(cache_path, src_dir, data)
                return data

            try:
                global _THUMB_VIDEO_SEM
                if _THUMB_VIDEO_SEM is None:
                    _THUMB_VIDEO_SEM = asyncio.Semaphore(2)
                async with _THUMB_VIDEO_SEM:
                    body = await asyncio.to_thread(_cache_or_extract)
            except Exception:
                return web.json_response({"error": "decode failed"}, status=404)
            if body is None:
                return web.json_response({"error": "decode failed"}, status=404)
            return web.Response(body=body, content_type="image/png", headers=cache_headers)
        if not os.path.isfile(p):
            return web.json_response({"error": "not found"}, status=404)
        # ETag = sha1(path|mtime_ns|size) 前 16 字节; 内容变 ETag 必变
        try:
            st = os.stat(p)
        except OSError:
            return web.json_response({"error": "not found"}, status=404)
        etag_src = "%s|%d|%d" % (p, st.st_mtime_ns, st.st_size)
        etag = '"' + hashlib.sha1(etag_src.encode("utf-8")).hexdigest()[:16] + '"'
        cache_headers = {"ETag": etag, "Cache-Control": "private, max-age=86400"}
        # 304 分支必须在解码前返回, 否则重复解码失去性能意义
        if_none = request.headers.get("If-None-Match", "").strip()
        if if_none and (if_none == etag or if_none == "*"):
            return web.Response(status=304, headers=cache_headers)
        # Task 3: Content-Type 与缓存键按源扩展推导 (jpg/jpeg/jpe → image/jpeg, 其余 → image/png)
        is_jpeg = ext in (".jpg", ".jpeg", ".jpe")
        ctype = "image/jpeg" if is_jpeg else "image/png"
        cache_path, src_dir = _thumb_cache_paths(p, ext, st, _max_size)
        # PIL 解码 + 缓存 IO 都同步阻塞, 一并丢进 asyncio.to_thread 让事件循环空出来,
        # 与既有 semaphore 并发模型保持一致 (限流峰值 4)
        def _cache_or_decode():
            cached = _read_thumb_cache(cache_path)
            # 0 字节 sentinel (负缓存命中标记): 按 miss 处理, 避免直出 200 空图
            if cached == b"":
                cached = None
            if cached is not None:
                return cached
            buf = io.BytesIO()
            im = Image.open(p)
            im.thumbnail((_max_size, _max_size))
            if is_jpeg:
                im.convert("RGB").save(buf, "JPEG")
            else:
                im.save(buf, "PNG")
            data = buf.getvalue()
            _write_thumb_cache(cache_path, src_dir, data)
            return data

        try:
            global _THUMB_SEM
            if _THUMB_SEM is None:
                _THUMB_SEM = asyncio.Semaphore(4)
            async with _THUMB_SEM:
                body = await asyncio.to_thread(_cache_or_decode)
        except Exception:
            return web.json_response({"error": "decode failed"}, status=404)
        return web.Response(body=body, content_type=ctype, headers=cache_headers)

    # 批 9 任务 91.5: GET /h3_batch/video — 视频文件流式下载 (替代 thumb 视频分支的
    # ffmpeg 首帧 PNG, 让浏览器 <video> 真机播放 + 进度条拖动走 HTTP Range).
    # 路径白名单: server output 目录树内 (realpath + startswith+sep 防前缀近邻绕过);
    # 仅支持单 Range (bytes=N-M 或 bytes=N-); 多 Range / 非法 Range 回退 200 全量.
    _VIDEO_EXTS = (".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv")
    _VIDEO_CONTENT_TYPES = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mpeg": "video/mpeg",
        ".mpg": "video/mpeg",
        ".mkv": "video/x-matroska",
    }
    _VIDEO_CONTENT_TYPES_DEFAULT = "video/mp4"

    @server.PromptServer.instance.routes.get("/h3_batch/video")
    async def _h3_video(request):
        path = request.query.get("path", "")
        if not isinstance(path, str) or not path:
            return web.json_response({"error": "path 必须为非空字符串"}, status=400)
        ext = os.path.splitext(path)[1].lower()
        if ext not in _VIDEO_EXTS:
            return web.json_response(
                {"error": "path 扩展名非视频 (仅支持 .mp4 .webm .mov .avi .mpeg .mpg .mkv)"},
                status=400)
        # 路径白名单: realpath + normcase + startswith(root + os.sep) 防前缀近邻绕过.
        # V1.12 #44A: 配置 archive_root 时追加该根 (归档任务在线播放 403 债清偿).
        try:
            roots = [os.path.normcase(os.path.realpath(folder_paths.get_output_directory()))]
            if ARCHIVE_ROOT:
                roots.append(os.path.normcase(os.path.realpath(ARCHIVE_ROOT)))
            resolved = os.path.normcase(os.path.realpath(path))
        except (OSError, ValueError) as e:
            return web.json_response(
                {"error": "path 路径解析失败: %s" % e}, status=400)
        if not any(resolved == r or resolved.startswith(r + os.sep) for r in roots):
            return web.json_response(
                {"error": "path 必须位于 server output 目录树内 (realpath 前缀校验不通过)"},
                status=403)
        if not os.path.isfile(resolved):
            return web.json_response({"error": "path 文件不存在"}, status=404)
        try:
            st = os.stat(resolved)
        except OSError:
            return web.json_response({"error": "path 文件不存在"}, status=404)
        size = st.st_size
        etag_src = "%s|%d|%d" % (resolved, st.st_mtime_ns, st.st_size)
        etag = '"' + hashlib.sha1(etag_src.encode("utf-8")).hexdigest()[:16] + '"'
        cache_headers = {"ETag": etag, "Cache-Control": "private, max-age=86400"}
        # ETag 缓存命中 → 304
        if_none = request.headers.get("If-None-Match", "").strip()
        if if_none and (if_none == etag or if_none == "*"):
            return web.Response(status=304, headers=cache_headers)
        ctype = _VIDEO_CONTENT_TYPES.get(ext, _VIDEO_CONTENT_TYPES_DEFAULT)
        # Range 解析: 仅单 Range; 非法 / 多 Range 回退 200 全量 (api.md 描述).
        range_hdr = request.headers.get("Range", "").strip()
        start, end, is_range = 0, size - 1, False
        if range_hdr:
            m = re.match(r"^bytes=(\d*)-(\d*)$", range_hdr)
            if m and (m.group(1) or m.group(2)) and "," not in range_hdr:
                try:
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        # 后缀区间 (bytes=-N): 取末尾 N 字节 (按 HTTP RFC 7233)
                        suffix_len = int(m.group(2))
                        start = max(0, size - suffix_len)
                        end = size - 1
                    if 0 <= start <= end < size:
                        is_range = True
                    else:
                        start, end, is_range = 0, size - 1, False
                except ValueError:
                    start, end, is_range = 0, size - 1, False
        # 读区间字节 (同步 IO 走 to_thread 不阻塞事件循环)
        def _read_bytes(s, e):
            length = e - s + 1
            with open(resolved, "rb") as f:
                f.seek(s)
                return f.read(length)
        try:
            body = await asyncio.to_thread(_read_bytes, start, end)
        except OSError:
            return web.json_response({"error": "path 文件不存在"}, status=404)
        headers = dict(cache_headers)
        headers["Content-Length"] = str(len(body))
        if is_range:
            headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
            return web.Response(status=206, body=body, content_type=ctype, headers=headers)
        return web.Response(body=body, content_type=ctype, headers=headers)

    @server.PromptServer.instance.routes.post("/h3_batch/save_queue")
    async def _h3_save_queue(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        text = str(body.get("text", ""))
        fname = "h3_batch_queue_%s.csv" % time.strftime("%Y%m%d_%H%M%S")
        path = os.path.join(folder_paths.get_input_directory(), fname)
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            f.write(text)
        return web.json_response({"name": fname, "path": path})

    @server.PromptServer.instance.routes.get("/h3_batch/queue_read")
    async def _h3_queue_read(request):
        p = request.query.get("path", "")
        # S2: 越界日志 (input/output/archive 树外) — 仅记录, 下方既有 400/200 行为不变
        _h3_log_read_out_of_scope("queue_read", p, p, "data")
        if not p.lower().endswith(".csv") or not os.path.isfile(p):
            return web.json_response({"error": "不是有效的 CSV 文件: %s" % p}, status=400)
        try:
            with open(p, encoding="utf-8-sig", errors="replace", newline="") as f:
                text = f.read()
        except OSError as e:
            return web.json_response({"error": "读取失败: %s" % e}, status=400)
        return web.json_response({"text": text})

    @server.PromptServer.instance.routes.get("/h3_batch/parse_csv")
    async def _h3_parse_csv(request):
        p = request.query.get("path", "")
        # S2: 越界日志 (input/output/archive 树外) — 仅记录, 下方既有 400/200 行为不变
        _h3_log_read_out_of_scope("parse_csv", p, p, "data")
        if not p.lower().endswith(".csv") or not os.path.isfile(p):
            return web.json_response({"error": "不是有效的 CSV 文件: %s" % p}, status=400)
        try:
            return web.json_response(parse_csv_to_data(p))
        except Exception as e:
            # csv_gen 平铺导入 batch_core, 与包内 .batch_core 可能是两个模块实例
            # (见 tests 的 sys.path/sys.modules stub), 按类名归一处理双实例 ShotError
            if isinstance(e, ShotError) or type(e).__name__ == "ShotError":
                return web.json_response({"error": str(e)}, status=400)
            raise

    # Task 4: 资产库 (角色/场景卡) — GET 读全库, POST 存卡或删卡 (card:null=删).
    # 存 <input_dir>\.h3_assets.json: 用户数据区, 升级不被覆盖; GET 损坏容错 (200+error 字段).
    @server.PromptServer.instance.routes.get("/h3_batch/assets")
    async def _h3_get_assets(request):
        assets, err = _h3_read_assets()
        body = {"assets": assets}
        if err:
            body["error"] = err
        return web.json_response(body)

    @server.PromptServer.instance.routes.post("/h3_batch/assets")
    async def _h3_post_assets(request):
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        name = body.get("name", "")
        card = body.get("card", None)
        # 批 K1: 删卡前先做名字清洗 (与存卡口径一致 — 用户可能用清洗前名删, 需按存时 key 找到)
        safe_name = _h3_safe_filename(name) if isinstance(name, str) else ""
        # 损坏文件不允许删 (无法确认卡是否在里面) → 400
        assets, err = _h3_read_assets()
        if card is None:
            if err:
                return web.json_response(
                    {"error": "资产文件损坏, 请先手动修复或删除 %s (%s)"
                               % (_H3_ASSETS_FILENAME, err)},
                    status=400)
            if not isinstance(assets, dict):
                assets = {}
            removed = False
            if safe_name and safe_name in assets:
                assets.pop(safe_name, None)
                removed = True
            # C2 修正笔 (S1, B 档实测): 1.14 清洗扩字符集后, 历史存量 v1/v2 卡 key
            # 若含新清洗字符 (如 'a?b' 被清洗成 'a_b'), 按清洗名求键不命中 → 静默 200.
            # 兜底: 同时按原样名 (raw name) 求键, 兼容旧键 (清洗前后两种 key 形态都能删).
            raw_name = name if isinstance(name, str) else ""
            if raw_name and raw_name != safe_name and raw_name in assets:
                assets.pop(raw_name, None)
                removed = True
            if removed:
                _h3_atomic_write(assets)
            # 批 K1: 同时删 archive_docs\<名>.json (v3 自然过渡场景)
            if safe_name:
                ap = os.path.join(folder_paths.get_input_directory(),
                                   _H3_LIBRARY_DIR, "archive_docs",
                                   safe_name + ".json")
                if os.path.isfile(ap):
                    try:
                        os.remove(ap)
                    except OSError:
                        pass
            return web.json_response({"ok": True, "count": len(assets)})
        clean_name, clean_card = _h3_validate_card(name, card)
        if clean_name is None:
            return clean_card  # 已是 400 响应
        # 损坏文件不允许覆写 (避免吞掉未知数据)
        if err:
            return web.json_response(
                {"error": "资产文件损坏, 请先手动修复或删除 %s (%s)"
                           % (_H3_ASSETS_FILENAME, err)},
                status=400)
        if not isinstance(assets, dict):
            assets = {}
        # 批 K1: v3 卡走 archive_docs 一档一文件 (atomic write), v1/v2 走 .h3_assets.json
        if isinstance(clean_card, dict) and clean_card.get("_v") == 3:
            _h3_ensure_library_dirs()
            # 2026-09-03 fixround: 无条件建 archive_images/<名>/ — 纯文本卡 / 图片已在库时也能落盘
            img_dir = os.path.join(folder_paths.get_input_directory(),
                                    _H3_LIBRARY_DIR, "archive_images", clean_name)
            os.makedirs(img_dir, exist_ok=True)
            ap = os.path.join(folder_paths.get_input_directory(),
                               _H3_LIBRARY_DIR, "archive_docs",
                               clean_name + ".json")
            tmp = ap + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(clean_card, f, ensure_ascii=False, indent=2)
            os.replace(tmp, ap)
            # 自然过渡: 若旧文件有同名条目, 移除并写回 (其他条目保留)
            if clean_name in assets:
                assets.pop(clean_name, None)
                _h3_atomic_write(assets)
            # count 仍按 _h3_read_assets 视野 (合并后) — 重新读一次拿到一致数
            merged, _e2 = _h3_read_assets()
            return web.json_response({"ok": True, "count": len(merged)})
        assets[clean_name] = clean_card
        _h3_atomic_write(assets)
        return web.json_response({"ok": True, "count": len(assets)})

    # 资产库损坏自助恢复: POST /h3_batch/assets/recovery {"action":"backup"|"reset"}
    # - 仅对已确认损坏的资产文件放行 (健康库 → 400 防误操作; 文件不存在 → 400)
    # - backup: 字节级拷贝损坏文件 → .corrupt-<时间戳>; 原文件不动 (用户可手动重命名/替换)
    # - reset: 备份 → os.remove 损坏文件 (避开原子写 .bak 分支 utf-8 读崩溃, 保住旧好 .bak)
    #           → 原子写空库 {}
    @server.PromptServer.instance.routes.post("/h3_batch/assets/recovery")
    async def _h3_post_assets_recovery(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"error": "请求体解析失败: %s" % e}, status=400)
        action = body.get("action", "")
        if action not in ("backup", "reset"):
            return web.json_response(
                {"error": "action 必须是 'backup' 或 'reset'"}, status=400)
        p = _h3_assets_path()
        if not os.path.isfile(p):
            return web.json_response(
                {"error": "资产文件不存在, 无需恢复"}, status=400)
        # 端点只对已确认损坏放行: 健康库拒绝 (避免误删)
        _assets, err = _h3_read_assets()
        if not err:
            return web.json_response(
                {"error": "资产文件未损坏, 拒绝恢复操作"}, status=400)
        # 备份 (字节级, 不解码) → .corrupt-<时间戳>; 与 _H3_ASSETS_BAK 互不影响
        ts = time.strftime("%Y%m%d-%H%M%S")
        backup_name = _H3_ASSETS_FILENAME + ".corrupt-" + ts
        backup_path = os.path.join(os.path.dirname(p), backup_name)
        try:
            shutil.copy2(p, backup_path)
        except OSError as e:
            return web.json_response(
                {"error": "备份失败: %s" % e}, status=400)
        if action == "backup":
            return web.json_response({"ok": True, "backup": backup_name})
        # action == "reset": ① 已备份 ② 先删损坏文件 (避开原子写 .bak 分支 utf-8 读崩溃
        # + 保住旧好 .bak) ③ 原子写空库 {}
        try:
            os.remove(p)
        except OSError as e:
            return web.json_response(
                {"error": "删除损坏文件失败: %s" % e}, status=400)
        try:
            _h3_atomic_write({})
        except OSError as e:
            return web.json_response(
                {"error": "写空库失败: %s" % e}, status=400)
        return web.json_response({"ok": True, "backup": backup_name})

    # 批 K1: 资产库图文件复制 — POST /h3_batch/asset_copy {src, archive_name, suggest_name}
    # 把库外文件 src 复制到 asset_library\archive_images\<archive_name>\<suggest 基名>.
    # 同名同内容 → 幂等返回同路径; 同名不同内容 → 自动 _1/_2 后缀; src 不存在 → 400.
    # archive_name / suggest_name 均做路径安全清洗, 防路径注入.
    @server.PromptServer.instance.routes.post("/h3_batch/asset_copy")
    async def _h3_post_asset_copy(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"error": "请求体解析失败: %s" % e}, status=400)
        src = body.get("src", "")
        archive_name = body.get("archive_name", "")
        suggest_name = body.get("suggest_name", "")
        if not isinstance(src, str) or not src:
            return web.json_response({"error": "src 必须为非空字符串"}, status=400)
        if not isinstance(archive_name, str) or not archive_name.strip():
            return web.json_response({"error": "archive_name 必须为非空字符串"}, status=400)
        if not isinstance(suggest_name, str) or not suggest_name.strip():
            return web.json_response({"error": "suggest_name 必须为非空字符串"}, status=400)
        # 批 A6 T1: 冒号 ':' 在 Windows 非法文件名, 含则直接 400 (比清洗更防路径逃逸)
        for _v, _fn in ((archive_name, "archive_name"), (suggest_name, "suggest_name")):
            _ok, _err = _h3_check_colon(_v, _fn)
            if not _ok:
                return _err
        # 批 L1: src 校验放宽 — 绝对路径任意盘符都接受 (导入本意);
        #   相对路径仍按 input_root 拼接再 realpath + commonpath (防 ../ 逃逸).
        # 写侧目标固定 archive_images\<safe_archive>\, _h3_safe_filename 清洗 + 同名幂等/_1 递增全部既有逻辑保持.
        try:
            _input_root = os.path.realpath(folder_paths.get_input_directory())
            if os.path.isabs(src):
                # 绝对路径: 直接 realpath (跨盘 I:\... 等任意盘符都接受, 不再做 input 树内约束)
                _src_real = os.path.realpath(src)
                # S2: 绝对 src 树外仅记录 (放宽为已文档化设计, 不硬拦)
                _h3_log_read_out_of_scope("asset_copy", src, _src_real, "data")
            else:
                # 相对路径: 按 input_root 拼接 → realpath → 必须落在 input 树内 (防 ../ 逃逸)
                _src_real = os.path.realpath(os.path.join(_input_root, src))
                # S2: 逃逸形态也留痕 (下方既有 400 硬拦保留, 日志不替代拦截)
                _h3_log_read_out_of_scope("asset_copy", src, _src_real, "data")
                _common = os.path.commonpath([_input_root, _src_real])
                if _common != _input_root:
                    return web.json_response(
                        {"error": "src 相对路径解析后必须位于 server input 目录树内 (realpath 前缀校验不通过)"},
                        status=400)
            src = _src_real
        except (OSError, ValueError) as e:
            return web.json_response(
                {"error": "src 路径解析失败: %s" % e}, status=400)
        if not os.path.isfile(src):
            return web.json_response({"error": "src 文件不存在或不是文件: %s" % src}, status=400)
        safe_archive = _h3_safe_filename(archive_name)
        if not safe_archive:
            return web.json_response(
                {"error": "archive_name 清洗后为空, 含路径分隔符或仅为特殊字符"}, status=400)
        # suggest_name 取基名 — 防用户传 "subdir/file.png" 整路径
        base_name = os.path.basename(suggest_name.replace("\\", "/"))
        base_name = _h3_safe_filename(base_name) or _h3_safe_filename(
            os.path.splitext(base_name)[0]) or "file"
        _h3_ensure_library_dirs()
        target_dir = os.path.join(folder_paths.get_input_directory(),
                                    _H3_LIBRARY_DIR, "archive_images", safe_archive)
        os.makedirs(target_dir, exist_ok=True)
        # 同名冲突解析: 同字节 → 幂等; 不同字节 → _1.ext / _2.ext ...
        target = os.path.join(target_dir, base_name)
        if os.path.isfile(target):
            try:
                with open(src, "rb") as f1, open(target, "rb") as f2:
                    same = f1.read() == f2.read()
            except OSError as e:
                return web.json_response({"error": "读取比较失败: %s" % e}, status=400)
            if same:
                return web.json_response({"ok": True, "path": target})
            stem, ext = os.path.splitext(base_name)
            i = 1
            while True:
                cand = os.path.join(target_dir, "%s_%d%s" % (stem, i, ext))
                if not os.path.exists(cand):
                    target = cand
                    break
                try:
                    with open(src, "rb") as f1, open(cand, "rb") as f2:
                        same2 = f1.read() == f2.read()
                except OSError:
                    same2 = False
                if same2:
                    return web.json_response({"ok": True, "path": cand})
                i += 1
        try:
            shutil.copyfile(src, target)
        except OSError as e:
            return web.json_response({"error": "复制失败: %s" % e}, status=400)
        return web.json_response({"ok": True, "path": target})

    # 批 B 节点 B-III 返工 必修 1: GET /h3_batch/image_meta?path=
    # 返回原图真实 {w, h} — 前端手动框选换算保底 (替代直接用 thumb 128px naturalWidth 导致黑底 bug)
    # 路径校验照抄 asset_copy 范式 (realpath + commonpath input 树域限定) + 相对路径按 input_root 拼
    @server.PromptServer.instance.routes.get("/h3_batch/image_meta")
    async def _h3_get_image_meta(request):
        path = request.query.get("path", "")
        if not isinstance(path, str) or not path:
            return web.json_response({"error": "path 必须为非空字符串"}, status=400)
        # 路径域校验 (照抄 asset_crop)
        try:
            _input_root = os.path.realpath(folder_paths.get_input_directory())
            _src_for_resolve = path if os.path.isabs(path) else os.path.join(_input_root, path)
            _src_real = os.path.realpath(_src_for_resolve)
        except (OSError, ValueError) as e:
            return web.json_response(
                {"error": "path 路径解析失败: %s" % e}, status=400)
        try:
            _common = os.path.commonpath([_input_root, _src_real])
        except ValueError:
            _common = ""
        if _common != _input_root:
            return web.json_response(
                {"error": "path 必须位于 server input 目录树内 (realpath 前缀校验不通过)"},
                status=400)
        if not os.path.isfile(_src_real):
            return web.json_response({"error": "path 文件不存在: %s" % path}, status=400)
        # 批 B 节点 B-III 终版: 用 PIL.Image.open 取尺寸 (无需解码像素, 仅读 header)
        try:
            with Image.open(_src_real) as _im:
                _W, _H = _im.size
        except (OSError, ValueError) as e:
            return web.json_response({"error": "读取图片失败: %s" % e}, status=400)
        return web.json_response({"ok": True, "w": int(_W), "h": int(_H)})

    # 批 K1: 档案物理清理 — POST /h3_batch/archive_purge {name}
    # 删 archive_docs\<名>.json + rmtree(archive_images\<名>); 不存在也 ok;
    # 不碰 .h3_assets.json (卡条目删除走 POST /h3_batch/assets, 前端先删卡再调本端点).
    @server.PromptServer.instance.routes.post("/h3_batch/archive_purge")
    async def _h3_post_archive_purge(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"error": "请求体解析失败: %s" % e}, status=400)
        name = body.get("name", "")
        if not isinstance(name, str) or not name.strip():
            return web.json_response({"error": "name 必须为非空字符串"}, status=400)
        # 批 A6 T1: 冒号 ':' 在 Windows 非法文件名, 含则直接 400
        _ok, _err = _h3_check_colon(name, "name")
        if not _ok:
            return _err
        safe = _h3_safe_filename(name)
        if not safe:
            return web.json_response(
                {"error": "name 清洗后为空, 含路径分隔符或仅为特殊字符"}, status=400)
        archive_dir = folder_paths.get_input_directory()
        # 删 json
        ap = os.path.join(archive_dir, _H3_LIBRARY_DIR, "archive_docs", safe + ".json")
        try:
            if os.path.isfile(ap):
                os.remove(ap)
        except OSError as e:
            return web.json_response({"error": "删除 json 失败: %s" % e}, status=400)
        # 删图夹 (幂等)
        img_dir = os.path.join(archive_dir, _H3_LIBRARY_DIR, "archive_images", safe)
        shutil.rmtree(img_dir, ignore_errors=True)
        return web.json_response({"ok": True})

    # 批 B 节点 B-III 终版: 服装图手动框选裁剪 — POST /h3_batch/asset_crop {src, mode, rect?}
    # 老板裁决: 自动裁脸功能已下线 (Haar 模型准确度不够, 多人合照/风景/建筑等场景误检率高,
    # 除非上专业人脸模型否则难以实用). 手动框选保留为唯一裁剪方式.
    # mode="auto"  -> 直接 400 + 文案「自动裁脸已下线, 请使用手动框选」(契约保留值避免破坏旧调用)
    # mode="rect"  -> 按 rect{x,y,w,h} (像素坐标) 裁剪, 文件名 _crop.png;
    #                 rect 缺/非正/越界 -> 400
    # 路径校验照抄 T2 asset_copy (realpath + commonpath input 树域限定, 防 ../ / 绝对路径逃逸)
    # 写盘 unicode 安全: PIL.Image.save(buf, "PNG") + 二进制 open 写, 兼容 unicode 路径
    # 重名自动递增 _crop2/...; 同名同内容幂等; 非破坏 (原图不动)
    @server.PromptServer.instance.routes.post("/h3_batch/asset_crop")
    async def _h3_post_asset_crop(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"error": "请求体解析失败: %s" % e}, status=400)
        src = body.get("src", "")
        mode = body.get("mode", "")
        if not isinstance(src, str) or not src:
            return web.json_response({"error": "src 必须为非空字符串"}, status=400)
        if mode not in ("auto", "rect"):
            return web.json_response(
                {"error": "mode 必须为 'auto' 或 'rect'"}, status=400)
        if mode == "auto":
            return web.json_response(
                {"error": "自动裁脸已下线, 请使用手动框选 (mode=rect)"}, status=400)
        # 路径域校验 — 照抄 T2 asset_copy 范式 (realpath + commonpath input 树域限定)
        # 批 B 节点 B-IV 修: src 相对路径先按 input_root 拼接再 realpath
        # (B-III 初版直接 realpath, 相对路径按服务进程 cwd 解析 → 不在 input 树下误拒 400.
        #  前端 path_picker 在某些模式给相对路径, 真机验收 src="468ac3c5....jpg" 被误拒.)
        # 校验通过后 src 重新绑定为绝对路径, 后续 open/basename/dirname 都基于绝对路径一致
        try:
            _input_root = os.path.realpath(folder_paths.get_input_directory())
            _src_for_resolve = src if os.path.isabs(src) else os.path.join(_input_root, src)
            src = os.path.realpath(_src_for_resolve)
        except (OSError, ValueError) as e:
            return web.json_response(
                {"error": "src 路径解析失败: %s" % e}, status=400)
        try:
            _common = os.path.commonpath([_input_root, src])
        except ValueError:
            _common = ""
        if _common != _input_root:
            return web.json_response(
                {"error": "src 必须位于 server input 目录树内 (realpath 前缀校验不通过)"},
                status=400)
        if not os.path.isfile(src):
            return web.json_response({"error": "src 文件不存在: %s" % src}, status=400)
        # 读图 (PIL, 兼容 unicode 路径)
        try:
            with Image.open(src) as _im:
                # 转 RGB 统一通道 (兼容 RGBA/灰度等源), 再用 .crop() 裁剪
                _im_rgb = _im.convert("RGB")
                _W, _H = _im_rgb.size
        except (OSError, ValueError) as e:
            return web.json_response({"error": "读取图片失败: %s" % e}, status=400)
        # === mode 分支 (mode=auto 已在上面返 400) ===
        rect = body.get("rect")
        if not isinstance(rect, dict):
            return web.json_response(
                {"error": "rect 模式必须提供 rect{x,y,w,h}"}, status=400)
        # 批 B 节点 B-III 门审必修 1: rect 字段类型硬校验
        # 修复前: int(rect.get(...)) 把 "0"/True/1.5 都吞掉转 int 放行, 违反"非整数全拒"契约
        # 修复后: 取值前 isinstance(v, int) and not isinstance(v, bool) → 字符串/bool/float 全拒 400
        _rect_vals = {}
        for _k in ("x", "y", "w", "h"):
            if _k not in rect:
                return web.json_response(
                    {"error": "rect 字段缺 %s" % _k}, status=400)
            _v = rect[_k]
            # bool 是 int 的子类, 必须先排除; float 也必须排除 (int(1.5)=1 易吞)
            if not isinstance(_v, int) or isinstance(_v, bool):
                return web.json_response(
                    {"error": "rect.%s 必须为整数 (实际类型 %s, 拒绝数字字符串/bool/float)" %
                              (_k, type(_v).__name__)}, status=400)
            _rect_vals[_k] = _v
        _rx, _ry, _rw, _rh = _rect_vals["x"], _rect_vals["y"], _rect_vals["w"], _rect_vals["h"]
        if _rx < 0 or _ry < 0 or _rw <= 0 or _rh <= 0:
            return web.json_response({"error": "rect 字段必须非负且 w/h>0"}, status=400)
        if _rx + _rw > _W or _ry + _rh > _H:
            return web.json_response(
                {"error": "rect 超出图像边界 (图 %dx%d, rect=%d,%d,%d,%d)" %
                          (_W, _H, _rx, _ry, _rw, _rh)}, status=400)
        _cropped = _im_rgb.crop((_rx, _ry, _rx + _rw, _ry + _rh))
        _suffix_base = "_crop"
        # === 写盘 (unicode 安全: PIL save + 二进制 open) ===
        try:
            _buf = io.BytesIO()
            _cropped.save(_buf, "PNG")
            _png_bytes = _buf.getvalue()
        except Exception as e:
            return web.json_response({"error": "PNG 编码异常: %s" % e}, status=400)
        # 同目录, 重名递增; 原 stem 取 basename (防用户传目录路径)
        # 批 B 节点 B-III 门审必修 3: 递增 stem 统一
        # 修复前: 非 png 源时 _stem 已拼 _suffix_base, 递增又拼一次 → 双后缀 (realface_crop_crop2.png)
        # 修复后: 一次性算出 _new_stem + _new_ext, 递增只在 _new_stem 末尾加数字 (realface_crop2.png)
        _src_base = os.path.basename(src)
        _stem_orig, _ext_orig = os.path.splitext(_src_base)
        if _ext_orig.lower() != ".png":
            _new_stem = _stem_orig + _suffix_base  # 例: "realface" + "_crop" = "realface_crop"
            _new_ext = ".png"
        else:
            _new_stem = _stem_orig + _suffix_base  # 例: "outfit" + "_crop" = "outfit_crop"
            _new_ext = _ext_orig  # 保持原 .png
        _parent_dir = os.path.dirname(src)
        _target = os.path.join(_parent_dir, _new_stem + _new_ext)
        if os.path.isfile(_target):
            try:
                with open(_target, "rb") as _f1:
                    if _f1.read() == _png_bytes:
                        # 同名同字节 → 幂等
                        return web.json_response({"ok": True, "path": _target})
            except OSError:
                pass
            _i = 2
            while True:
                _cand = os.path.join(_parent_dir, _new_stem + str(_i) + _new_ext)
                if not os.path.isfile(_cand):
                    _target = _cand
                    break
                try:
                    with open(_cand, "rb") as _f1:
                        if _f1.read() == _png_bytes:
                            return web.json_response({"ok": True, "path": _cand})
                except OSError:
                    pass
                _i += 1
        # 写盘 (二进制模式, 兼容 unicode 路径)
        try:
            with open(_target, "wb") as _f:
                _f.write(_png_bytes)
        except OSError as e:
            return web.json_response({"error": "写盘失败: %s" % e}, status=400)
        return web.json_response({"ok": True, "path": _target})

    # ---------- Task T4: AI 协作导入导出 ----------
    # 给 AI 看的格式说明: mode 枚举/九分项/用途 ID 三件套说明
    _H3_AI_GUIDE = (
        "你正在处理 H3 批量分镜渲染引擎的表单快照(JSON)。请严格按 data 字段原样修改, "
        "只输出一个合法 JSON 对象(可包 ```json ... ``` 代码围栏), 不要加任何解说文字。\n"
        "\n"
        "顶层结构: {mode, pool, pool_usage, globals, shots}\n"
        "\n"
        "mode: 字符串, 枚举四选一: 分镜 / 拼接 / 自定义 / 队列清单; 缺省分镜。\n"
        "\n"
        "pool: 对象, 键 Picture / Video / Audio; 每键再含 {槽号(1-9): 绝对路径字符串}。\n"
        "      槽值必须是字符串(绝对路径), 不存在的文件仍可导出, 导入时仅警告。\n"
        "\n"
        "pool_usage: 对象, 与 pool 同键; 每键含 {槽号: [用途 ID 列表]}。用途 ID 仅限下列白名单: "
        "subject_look, subject_outfit, subject_prop, scene, pose, first_frame, video_ref, audio_ref。"
        "其它自定义值导入会被阻止。\n"
        "\n"
        "globals: 对象, 自由键值对。比例/质量/步数/语言/默认负面/配乐/氛围声/提示词 等。\n"
        "\n"
        "shots: 数组, 每镜一个对象。键: ID / prompt / 段落时长 / 种子 / 导出文件名 / 与上一片段拼接（仅自定义模式, 值域 \"是\"/空） / 出场角色（可选）/ "
        "九分项(镜头角度/景别/运镜方式/运镜方向/运镜幅度/运镜速度/焦段/氛围/情绪)。\n"
        "      prompt 必填字符串; 段落时长非空须为正数(支持小数); 种子非空须为整数; "
        "导出文件名非空不允许含 \\ / : * ? \" < > | 字符。\n"
        "      与上一片段拼接: 仅 mode=自定义 时识别; 值域 \"是\" / 空; 脏值（如 否/1/true/abc）入 warnings 并置空; 第 1 段列值非空也入 warnings 并置空（第 1 段恒独立）。\n"
        "      出场角色（可选）: 逗号分隔的角色卡名列表, 顺序=Subject 编号顺序; 空或省略=该镜无出场角色。\n"
        "      九分项任一非空值必须落在内置词库 + 用户词库的合并枚举内(实时合并); "
        "若不在枚举, 导入被阻止。\n"
        "\n"
        "导出格式: 输出单个 JSON 对象(可包 ```json 围栏), 不要额外解说, 方便用户直接粘贴到表单。"
    )

    def _ai_strip_fence(text):
        """剥代码围栏 + 解说文字, 截最外层 {...}; 返回 (clean_text, err_msg)."""
        if not isinstance(text, str):
            return "", "AI 返回文本不是字符串"
        s = text.strip()
        # 围栏: 优先找 ```json, 否则任意 ```, 截取第一对围栏内
        # 锚行首 (允许前导空白): 推理模型 think 回显的内联 "```json" 不在行首, 不得命中
        fence_match = re.search(
            r"(?:^|\n)[ \t]*```(?:json)?[ \t]*\r?\n(.+?)\r?\n[ \t]*```", s, re.S | re.I)
        if fence_match:
            s = fence_match.group(1).strip()
        # 在剩余文本里找最外层 {...}: 第一个 { 起, 括号配平, 第一个匹配收尾
        first = s.find("{")
        if first < 0:
            return "", "AI 返回文本中找不到 JSON 对象起始 {"
        depth = 0
        end = -1
        in_str = False
        esc = False
        for i in range(first, len(s)):
            ch = s[i]
            if esc:
                esc = False
                continue
            if ch == "\\":
                esc = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end < 0:
            return "", "AI 返回文本中 JSON 大括号未闭合"
        return s[first:end + 1], ""

    def _ai_parse_text(text):
        """剥壳 + JSON 解析; 返回 (data, errors). errors 已含行号(S5 位置级).
        剥壳失败 / JSON 解析失败都返回 "JSON 解析失败: msg(行 N)" 统一形态."""
        clean, err = _ai_strip_fence(text)
        # 优先 json 解析 (剥壳结果或原文); 失败用 json.JSONDecodeError msg+lineno
        try:
            data = json.loads(clean if clean else (text if isinstance(text, str) else ""))
            return data, []
        except json.JSONDecodeError as e:
            return None, ["JSON 解析失败: %s(行 %d)" % (e.msg, e.lineno)]
        except Exception as e:
            return None, ["JSON 解析失败: %s" % e]

    def _ai_field_str(path, raw):
        """字符串字段校验; 返回 (value, error_or_None)."""
        if raw is None or (isinstance(raw, str) and raw == ""):
            return "", None
        if not isinstance(raw, str):
            return "", "%s: 须为字符串, 得到 %s" % (path, type(raw).__name__)
        return raw, None

    def _ai_field_enum(path, raw, allowed, default):
        """枚举字段校验; 非法值回落默认 + 报错."""
        if raw is None or (isinstance(raw, str) and raw == ""):
            return default, None
        if raw not in allowed:
            return default, "%s: 须为 %s, 得到 %r" % (path, "/".join(allowed), raw)
        return raw, None

    def _ai_validate(data):
        """逐字段校验净化; 返回 (errors, warnings, norm_data)."""
        errors = []
        warnings = []
        if not isinstance(data, dict):
            return ["根 JSON 必须是对象"], [], {}
        # mode
        mode, e = _ai_field_enum("mode", data.get("mode"),
                                 ("分镜", "拼接", "自定义", "队列清单"), "分镜")
        if e:
            errors.append(e)
        # pool: 三类 kind, 每类 {槽号: 绝对路径字符串}; 文件不存在 → warnings
        pool_raw = data.get("pool", {}) or {}
        if not isinstance(pool_raw, dict):
            errors.append("pool: 须为对象")
            pool_raw = {}
        norm_pool = {}
        for kind in ("Picture", "Video", "Audio"):
            slots = pool_raw.get(kind, {}) or {}
            if not isinstance(slots, dict):
                errors.append("pool.%s: 须为对象" % kind)
                continue
            norm_slots = {}
            for k, v in slots.items():
                sv, e = _ai_field_str("pool.%s[%s]" % (kind, k), v)
                if e:
                    errors.append(e)
                    continue
                norm_slots[str(k)] = sv
                if sv and not os.path.isfile(sv):
                    warnings.append("pool.%s[%s]: 文件不存在 %s" % (kind, k, sv))
            norm_pool[kind] = norm_slots
        # pool_usage: 用途 ID ∈ KNOWN_USAGE_IDS 白名单 (F5: 不并 user_vocab)
        pu_raw = data.get("pool_usage", {}) or {}
        if not isinstance(pu_raw, dict):
            errors.append("pool_usage: 须为对象")
            pu_raw = {}
        norm_usage = {}
        for kind in ("Picture", "Video", "Audio"):
            usages = pu_raw.get(kind, {}) or {}
            if not isinstance(usages, dict):
                errors.append("pool_usage.%s: 须为对象" % kind)
                continue
            norm_usages = {}
            for k, ids in usages.items():
                if not isinstance(ids, list):
                    errors.append("pool_usage.%s[%s]: 须为列表" % (kind, k))
                    continue
                clean_ids = []
                for uid in ids:
                    us, e = _ai_field_str("pool_usage.%s[%s]" % (kind, k), uid)
                    if e:
                        errors.append("pool_usage.%s[%s]: %s" % (kind, k, e))
                        continue
                    if us not in KNOWN_USAGE_IDS:
                        errors.append("pool_usage.%s[%s]: 未知用途 ID %r"
                                       % (kind, k, us))
                        continue
                    clean_ids.append(us)
                if clean_ids:
                    norm_usages[str(k)] = clean_ids
            norm_usage[kind] = norm_usages
        # globals: 自由键值对, 与 collectData 口径一致 (非空字符串值, 不强制)
        globals_raw = data.get("globals", {}) or {}
        if not isinstance(globals_raw, dict):
            errors.append("globals: 须为对象")
            globals_raw = {}
        norm_globals = {}
        for k, v in globals_raw.items():
            vs, e = _ai_field_str("globals[%s]" % k, v)
            if e:
                errors.append(e)
                continue
            norm_globals[str(k)] = vs
        # shots 全列校验; 九分项枚举 = shot_vocab.load_vocab() 实时合并 (词库+user_vocab)
        shots_raw = data.get("shots", []) or []
        if not isinstance(shots_raw, list):
            errors.append("shots: 须为列表")
            shots_raw = []
        vocab = load_vocab()
        norm_shots = []
        seen_ids = set()
        for i, shot in enumerate(shots_raw):
            if not isinstance(shot, dict):
                errors.append("shots[%d]: 须为对象" % i)
                continue
            sp = shot.get("prompt", "")
            if not isinstance(sp, str) or not sp:
                errors.append("shots[%d].prompt: 必填字符串, 当前 %r" % (i, sp))
                continue  # prompt 缺则后续无意义, 跳过
            norm_shot = {}
            # ID 可空; 跨镜查重: 空 ID 不查 (多行空合法), 非空见重复 → 报错
            sid = shot.get("ID", "")
            sid_s, sid_e = _ai_field_str("shots[%d].ID" % i, sid)
            if sid_e:
                errors.append(sid_e)
            elif sid_s and sid_s in seen_ids:
                errors.append("shots[%d].ID: 与前文重复 ('%s')" % (i, sid_s))
            elif sid_s:
                seen_ids.add(sid_s)
            norm_shot["ID"] = sid_s
            norm_shot["prompt"] = sp
            # 段落时长: 非空须正数
            dur_raw = shot.get("段落时长", "")
            dur_str = ""
            if dur_raw is not None and str(dur_raw) != "":
                try:
                    d = float(str(dur_raw).strip())
                    if d <= 0:
                        errors.append("shots[%d].段落时长: 须 > 0, 得到 %r" % (i, dur_raw))
                    else:
                        dur_str = str(d)
                except (ValueError, TypeError):
                    errors.append("shots[%d].段落时长: 须为数字, 得到 %r" % (i, dur_raw))
            norm_shot["段落时长"] = dur_str
            # 种子: 非空须整数
            seed_raw = shot.get("种子", "")
            seed_str = ""
            if seed_raw is not None and str(seed_raw) != "":
                try:
                    s = int(str(seed_raw).strip())
                    seed_str = str(s)
                except (ValueError, TypeError):
                    errors.append("shots[%d].种子: 须为整数, 得到 %r" % (i, seed_raw))
            norm_shot["种子"] = seed_str
            # 导出文件名: 非空不含 \/:*?"<>|
            fn_raw = shot.get("导出文件名", "")
            fn_str = ""
            if fn_raw is not None and str(fn_raw) != "":
                fs, fe = _ai_field_str("shots[%d].导出文件名" % i, fn_raw)
                if fe:
                    errors.append(fe)
                elif re.search(r'[\\/:*?"<>|]', fs):
                    errors.append("shots[%d].导出文件名: 含非法字符 \\/:*?\"<>|, 得到 %r"
                                   % (i, fs))
                else:
                    fn_str = fs
            norm_shot["导出文件名"] = fn_str
            # 九分项: 非空须在 vocab 枚举内
            for fld in STRUCT_FIELDS:
                v_raw = shot.get(fld, "")
                v_str = ""
                if v_raw is not None and str(v_raw) != "":
                    vs, ve = _ai_field_str("shots[%d].%s" % (i, fld), v_raw)
                    if ve:
                        errors.append(ve)
                    elif vs not in vocab.get(fld, []):
                        errors.append("shots[%d].%s: 值不在九分项枚举内, 得到 %r"
                                       % (i, fld, v_raw))
                        v_str = vs  # 留原值, 让用户看见填了什么
                    else:
                        v_str = vs
                norm_shot[fld] = v_str
            # D2 v2: 出场角色 (可选) — 字符串字段校验, 不做卡名存在性校验 (AI 端可能先改表后建卡, 分层职责)
            cast_s, cast_e = _ai_field_str("shots[%d].出场角色" % i, shot.get("出场角色", ""))
            if cast_e:
                errors.append(cast_e)
            norm_shot["出场角色"] = cast_s
            # 1.11b 波2 T5: AI 通道显式新增 CONCAT_FLAG_COL 键 (固定键集, 不加即丢)
            # 脏值/第 1 段非空 → warnings + 置空 (宽容优先, 与 CSV 侧 derive_seg_flags 一致)
            # 第 1 段恒独立优先: 即使填"是"也置空 + WARN, 不连报两条 (脏值路径 vs 第 1 段路径).
            cfc_raw = shot.get(CONCAT_FLAG_COL, "")
            cfc_str = ""
            if cfc_raw is not None and str(cfc_raw) != "":
                if i == 0:
                    warnings.append("shots[0].%s: 第 1 段恒独立, 列值 %r 被忽略"
                                    % (CONCAT_FLAG_COL, cfc_raw))
                else:
                    cfc_s = str(cfc_raw).strip()
                    if cfc_s == "是":
                        cfc_str = "是"
                    else:
                        warnings.append("shots[%d].%s: 值 %r 非法, 当否处理（仅识别 \"是\")"
                                        % (i, CONCAT_FLAG_COL, cfc_raw))
            norm_shot[CONCAT_FLAG_COL] = cfc_str
            # 时间段复用 T1: errs → 阻止 (路径前缀 shots[i].prompt), warns → 入 warnings
            tl_errs, tl_warns = check_timeline(norm_shot)
            for te in tl_errs:
                errors.append("shots[%d].prompt%s" % (i, te))
            for tw in tl_warns:
                warnings.append("shots[%d].prompt%s" % (i, tw))
            norm_shots.append(norm_shot)
        return errors, warnings, {"mode": mode, "pool": norm_pool,
                                  "pool_usage": norm_usage, "globals": norm_globals,
                                  "shots": norm_shots}

    @server.PromptServer.instance.routes.post("/h3_batch/ai_export")
    async def _h3_ai_export(request):
        # 导出: collectData() 快照透传 + 内置 guide; 后端不做二次校验
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response({"error": "invalid_json: %s" % e}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "body 必须是对象"}, status=400)
        data = {
            "mode": body.get("mode", "分镜"),
            "pool": body.get("pool", {}) or {},
            "pool_usage": body.get("pool_usage", {}) or {},
            "globals": body.get("globals", {}) or {},
            "shots": body.get("shots", []) or [],
        }
        return web.json_response({
            "format": "h3_batch_ai_interchange",
            "schema_version": 2,
            "guide": _H3_AI_GUIDE,
            "data": data,
        })

    @server.PromptServer.instance.routes.post("/h3_batch/ai_import")
    async def _h3_ai_import(request):
        # 导入: 剥壳 → JSON 解析 → 字段校验净化 → ok/errors/warnings
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError) as e:
            return web.json_response(
                {"ok": False, "errors": ["invalid_json: %s" % e]}, status=400)
        text = body.get("text", "") if isinstance(body, dict) else ""
        parsed, parse_errs = _ai_parse_text(text)
        if parse_errs:
            return web.json_response({"ok": False, "errors": parse_errs, "data": None})
        errs, warns, norm = _ai_validate(parsed)
        if errs:
            return web.json_response({"ok": False, "errors": errs, "data": None})
        return web.json_response({"ok": True, "data": norm, "warnings": warns})

    # V1.11c 波1 (#45/#46): 出三视图 — 异步两步式. handler 在 threepov.py,
    # 与跑批共用 _active (互斥 409, 锁内 _active 标志 + _THREEPOV_ACTIVE 二级门).
    # port 钉死在 handler 内 (严禁裸 0, 锁死语义与 submit/rerun/quick 同款).
    _register_route("POST", "/h3_batch/threepov", _h3_threepov_submit)
    _register_route("GET", "/h3_batch/threepov/status", _h3_threepov_status)

    # V1.12 T6 (#47/#48): 场景画布 — 同款异步两步式, 与跑批/threepov 共用 _active 互斥域.
    _register_route("POST", "/h3_batch/scene_canvas", _h3_scene_canvas_submit)
    _register_route("GET", "/h3_batch/scene_canvas/status", _h3_scene_canvas_status)

    # V1.12b T3 (#53/#54): 道具画布 — 同款异步两步式, 与跑批/threepov/scene_canvas
    # 共用 _active 互斥域 + _ITEM_CANVAS_ACTIVE 三级门 + _enrollment_busy 占位期查 busy.
    _register_route("POST", "/h3_batch/item_canvas", _h3_item_canvas_submit)
    _register_route("GET", "/h3_batch/item_canvas/status", _h3_item_canvas_status)

    # 批 0 任务 0.2: 与其他 42 路由同层追加 — 静态挂载 GUI1.0/app → /h3_gui/
    _register_gui_routes()


# S1: 来源校验中间件挂载 (模块加载期 app 未 start; 桩环境无 app → 静默跳过)
_install_origin_guard()
