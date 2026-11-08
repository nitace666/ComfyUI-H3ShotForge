import copy
import csv
import filecmp
import glob
import hashlib
import json
import os
import queue
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import urllib.request
import urllib.error

# 兼容包内(__init__.py)与平铺(mcp_server)两种导入方式
_SELF_DIR = os.path.dirname(os.path.abspath(__file__))


# V1.11 fix2 (fix5): 收尾异步化 — 模块级 _finalize_lock 串行化多批并发收尾 (防 archive 撞车);
# _finalizing dict 跟踪在跑收尾 (output_dir_normcase → 当前阶段), 供 __init__.py 的
# status 端点透传 phase + submit 守卫拦同 output 单锁语义与既有 _concat_lock 同款。
# 放 batch_core 模块级而非 __init__ 是为了: 平铺加载场景 (mcp_server) 与测试桩 spec_from_file_location
# 都能直接拿到, 无需从 __init__ re-import。
_finalize_lock = threading.Lock()
_finalizing = {}  # output_dir (normcase abspath) -> phase str
_finalize_threads = {}  # output_dir (normcase abspath) -> 收尾 daemon 线程 (T1: 用于 join / 防键覆盖误 pop)
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)
from shot_vocab import (STRUCT_FIELDS, CONCAT_FLAG_COL, assemble_prompt,
                        _MARKER_SOUND, _MARKER_MUSIC,
                        _MARKER_SOUND_EN, _MARKER_MUSIC_EN)
# V1.9 批 3 T3.4: S3 拼接合成引擎 (转场+响度+编码策略, 移植脚本线 transition.py)
import join_engine
# V1.9 批 3 T3.5: S2 色彩漂移治理 (固定参考 color_level + flatten 增益归一)
import color_align
# V1.9 批 3 T3.6: S4 冻结尾检测 (尾帧直连降级路径: 视觉静止+运动幅度双门)
import freeze_detect

try:
    import folder_paths
except ImportError:  # 离线测试环境无 ComfyUI
    folder_paths = None


# 1.14 整改批 C C3: 卡名漏斗统一 — 单一漏斗函数定义在 batch_core.py (读侧 _load_primary_card_for_route /
# enrollment_should_run 直接用, 避免与 __init__.py 循环依赖). __init__.py 顶部 `from .batch_core import
# _h3_safe_filename` 重新导出 (mod._h3_safe_filename 仍可调用, 既有 contract 零回归).
# C2 第 2 层扩展后的清洗: ? * " < > | / \ .. 一律 _; 与路径分隔符兜底, 落盘名 Windows 合法.
def _h3_safe_filename(name):
    """卡名/档案名安全文件名清洗 (C2 第 2 层 + C3 漏斗统一用, 见 __init__.py:749 同款契约)."""
    if not isinstance(name, str):
        name = str(name)
    s = name.strip()
    while ".." in s:
        s = s.replace("..", "_")
    s = s.replace("/", "_").replace("\\", "_")
    for _ch in "?:*\"<>|":
        s = s.replace(_ch, "_")
    return s.strip().strip(".")


def _load_h3_config(path=None):
    """读取节点目录下的 h3_config.json(机器相关配置外置); 缺失/损坏/非对象一律返回 {}。"""
    p = path or os.path.join(_SELF_DIR, "h3_config.json")
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


_H3_CONFIG = _load_h3_config()


def _cfg_int(cfg, key, default):
    try:
        return int(cfg.get(key, default))
    except (TypeError, ValueError):
        return default


def _cfg_bool(cfg, key, default=False):
    v = cfg.get(key, default)
    return v if isinstance(v, bool) else default


def _audio_continuation_params():
    """续接音频五键 (submit 时重读文件, 三臂切键免重启; 同 threepov._canvas_config).

    h3_audio_context_frames: 缺省 22 (现行为); -1=关闭音频继承 (画面续接保留);
    0=显式传 0 (节点语义=跟随画面窗); N=直传帧数.
    h3_audio_taper_steps: 缺省 0 (不施加旧端半余弦渐释).
    h3_audio_ref_split: 分轨继承总开关, 缺省 false; 开时分轨参照替代尾窗继承.
    h3_audio_ref_vocals/background: 人声/背景子轨开关, 缺省 false; 总关时一律忽略.
    缺键/损坏/类型不符 → 各回缺省值.
    """
    cfg = _load_h3_config()
    return (_cfg_int(cfg, "h3_audio_context_frames", 22),
            _cfg_int(cfg, "h3_audio_taper_steps", 0),
            _cfg_bool(cfg, "h3_audio_ref_split", False),
            _cfg_bool(cfg, "h3_audio_ref_vocals", False),
            _cfg_bool(cfg, "h3_audio_ref_background", False))


# V1.4 T2: 用途注册表 — 用途定义唯一真相源(数据驱动; 加用途=加条目不改骨架)
# zh/en 为代写句模板: {N}=单标签槽号, {LIST}=多标签列表; block 决定产句分组与顺序
# subject_outfit/subject_prop 的模板是并入 Subject 单句的尾部件; ref 块按 (槽,kind) 升序逐槽产句
USAGE_REGISTRY = {
    "subject_look": {
        "label": "人物·外貌", "kind": "Picture", "block": "subject",
        "zh": "[主体定义] Subject {S} 是<Picture {N}>中的角色: 面部与外貌以此为准",
        "en": "[Subject] Subject {S} is the character in <Picture {N}>: face and appearance follow this reference",
        "zh_extra": "外貌参照{LIST}", "en_extra": "appearance reference {LIST}",
    },
    "subject_outfit": {
        "label": "人物·服装", "kind": "Picture", "block": "subject",
        "zh": "服装以{LIST}为准", "en": "outfit follows {LIST}",
    },
    "subject_prop": {
        "label": "人物·道具", "kind": "Picture", "block": "subject",
        "zh": "手持道具以{LIST}为准", "en": "held prop follows {LIST}",
    },
    # 1.11c 波2-T4: 三视图条目 — block="subject" 使其不进参考句豁免正则 (:109-121)
    # / 不进双锚计数 (选这两个值就是让既有豁免/计数逻辑零感知, 方案 §二.5 定稿)。
    # 模板由 _H3_SEG_TAG/_ATTR 承载 (zh/en 留 None, 走 H3 主体行拼装)
    "三视图": {
        "label": "人物·三视图", "kind": "Picture", "block": "subject",
    },
    "scene":     {"label": "场景·环境", "kind": "Picture", "block": "ref", "zh": "场景以<Picture {N}>为准", "en": "scene follows <Picture {N}>"},
    # 批 A 节点 2: pose 归位 — block "ref"→"subject", label "姿态·动作"→"人物·姿势"
    # 模板维持旧形态 (人物姿势以<Picture {N}>为准) — 仅池用途无绑定时仍以裸行产出 (无 Subject 可挂)
    # 绑定场景下, 引擎组装层将 pose 段归入对应 Subject 的 H3 交替式行 (prompt_assembler._build_h3_subject_lines)
    "pose":      {"label": "人物·姿势", "kind": "Picture", "block": "subject", "zh": "人物姿势以<Picture {N}>为准", "en": "character pose follows <Picture {N}>"},
    "first_frame": {
        "label": "首帧锚定", "kind": "Picture", "block": "anchor",
        "zh": "[画面锚定] 视频第一帧与<Picture {N}>的构图、机位、人物姿态完全一致",
        "en": "[Frame anchor] The first video frame exactly matches the composition, camera position and pose of <Picture {N}>",
    },
    "video_ref": {
        "label": "视频·动作参考", "kind": "Video", "block": "ref",
        # #42 W3 替换版: 单视频段 (槽数=1) 产「动作复刻」句; 多视频段 (槽数>=2) 走 legacy 句
        # (锁现状) — 两句同款约束: 只迁移动作/节奏, 九项不得迁移; en 逐字嵌 toyxyz motion 句
        # (vendoring 副本 tests/fixtures/minimax_h3_system_prompts.json · W3-1 锁)
        "zh": ("以 <Video {N}> 为源片动作复刻：源片人物形象与场景环境替换为本段提示词所描述的内容；"
               "仅迁移参考中人物的动作与节奏，不得迁移源片的身份、服装、环境、风格、光照、构图、运镜、"
               "剪辑与音频，除非另行要求。"),
        "en": ("Recast <Video {N}> as the source video: keep subject motion timing exactly; "
               "replace its figures and environment with the content described in this shot. "
               "Transfer only evidenced subject motion and timing: pose progression, direction, "
               "speed, rhythm, contacts, interaction timing, and final motion state. "
               "Do not transfer source identity, clothing, environment, style, lighting, "
               "composition, camera, cuts, or audio unless separately requested."),
        "zh_legacy": ("动作参照<Video {N}>（仅迁移人物动作与节奏，不得迁移源片的身份、服装、环境、"
                      "风格、光照、构图、运镜、剪辑与音频，除非另行要求）"),
        "en_legacy": ("Motion reference <Video {N}>. Transfer only evidenced subject motion and "
                      "timing: pose progression, direction, speed, rhythm, contacts, "
                      "interaction timing, and final motion state. Do not transfer source "
                      "identity, clothing, environment, style, lighting, composition, camera, "
                      "cuts, or audio unless separately requested."),
    },
    # W2a-E: voice_delivery 定稿句 — 仅参考音色/口音/情绪/语速/唱念质感, 参考不复制;
    # <Subject N> 的 N 是字面占位 (Subject 编号与音频槽号不同域, 不做 {N} 替换)
    "audio_ref": {
        "label": "音频参考", "kind": "Audio", "block": "ref",
        "zh": ("音频参照<Audio {N}>：仅参考音色、口音、情绪、语速与唱念质感；"
               "参考不复制，不得照搬或虚构源音频中的歌词、台词、音乐或环境声；"
               "仅当明确指明说话人时绑定到 <Subject N>。"),
        "en": ("audio reference <Audio {N}>: use only its timbre, accent, emotion, pace "
               "and speech/singing delivery quality; reference is not copied — do not "
               "replicate or invent lyrics, dialogue, music or ambience from the source "
               "audio; bind to <Subject N> only when a speaker is explicitly specified."),
    },
    # 1.12b v4 M4: 道具多角度 — 与 scene 同构, block=ref/kind=Picture; zh/en 模板
    # 用于 ref 通用路径自动产句 (见 batch_core.py:297-314); 不在端点 prompt 中直接出现,
    # 消费位置在 prompt_assembler._filter_scene_video_motion_blocks keep 分支 (T5)。
    "道具多角度": {
        "label": "道具·多角度", "kind": "Picture", "block": "ref",
        "zh": "道具以<Picture {N}>为准", "en": "prop follows <Picture {N}>",
    },
}

# V1.4 T1: 池行用途标注合法 ID 集合 — 单源化派生自 USAGE_REGISTRY
KNOWN_USAGE_IDS = frozenset(USAGE_REGISTRY)

# 1.14a T1: 姿势样式合法值 — 池行三段式 "文件名|pose|样式" 的第三段
POSE_STYLE_IDS = ("skeleton", "depth")


# #76: 池内标注 video_ref 的 Video 槽号 (升序) — 产句分支与六字段四要素共用同一口径
# (槽数=1 → 复刻框架; 槽数>=2 → 多视频段锁现状; 键为 int 或数字串均归一为 int)
def video_ref_slots(pool_usage):
    """池内标注 video_ref 的 Video 槽号列表 (升序)."""
    video = (pool_usage or {}).get("Video") or {}
    out = []
    for slot, uids in video.items():
        if not isinstance(uids, list) or "video_ref" not in uids:
            continue
        try:
            out.append(int(slot))
        except (TypeError, ValueError):
            continue
    return sorted(out)


# V1.7 R14: 参考句豁免 pattern 列表 — 数据驱动, 不写死文案
# USAGE_REGISTRY 中 block=="ref" 条目的代写句模板是非帧锚定的参考句, 在双锚点计数时跳过
# {N} 视为槽号数字; 按行整行匹配 (strip 后)
#
# 批 A 节点 2 修正: pose 已 block="subject", 数据驱动派生不再含 pose
# 但 pose 裸行 (仅池用途无绑定, block="subject" 也不进 H3 行的场景) 仍是参考句语义
# — 豁免表附补 pose 的 zh/en 模板 (boundary ②: pose+first_frame 不得误触双锚 ERR)
_REF_LINE_RES = []
for _uid, _meta in USAGE_REGISTRY.items():
    if _meta.get("block") == "ref":
        for _tpl in (_meta.get("zh"), _meta.get("en")):
            if _tpl:
                _pat = "^" + re.escape(_tpl).replace(re.escape("{N}"), r"\d+") + "$"
                _REF_LINE_RES.append(re.compile(_pat))
# 批 A 节点 2: pose 裸行豁免补偿 (block 虽迁出 ref, 模板语义仍是参考句)
_pose_meta = USAGE_REGISTRY.get("pose") or {}
for _tpl in (_pose_meta.get("zh"), _pose_meta.get("en")):
    if _tpl:
        _pat = "^" + re.escape(_tpl).replace(re.escape("{N}"), r"\d+") + "$"
        _REF_LINE_RES.append(re.compile(_pat))


def _default_input_dir():
    """分层兜底: config input_dir -> ComfyUI input 目录 -> 空。"""
    v = str(_H3_CONFIG.get("input_dir", "") or "").strip()
    if v:
        return v
    if folder_paths is not None:
        return folder_paths.get_input_directory()
    return ""


def _default_output_dir():
    v = str(_H3_CONFIG.get("output_dir", "") or "").strip()
    if v:
        return v
    if folder_paths is not None:
        return folder_paths.get_output_directory()
    return ""


# 机器路径全部来自 h3_config.json(相对 workflow_dir), 分发时随附 h3_config.json.example
H3_WORKFLOW_DIR = str(_H3_CONFIG.get("workflow_dir", "") or "").strip()
DEFAULT_WORKFLOW = str(_H3_CONFIG.get("default_workflow", "") or "").strip()
DEFAULT_INPUT_DIR = _default_input_dir()
DEFAULT_OUTPUT_DIR = _default_output_dir()
# V1.12 #44A: 统一归档根 — 相对 archive_dir 的锚点 + #44 video 白名单扩根依据.
ARCHIVE_ROOT = str(_H3_CONFIG.get("archive_root", "") or "").strip()

TAG_RE = re.compile(r"<(?P<kind>Picture|Video|Audio)\s*(?P<idx>\d+)>", re.IGNORECASE)
_DIALOGUE_RE = re.compile(r"<d\b[^>]*>.*?</d>", re.IGNORECASE | re.DOTALL)
# 批 C 节点 C-I: (S N) 说话人位行内检测 — 用于预检黄条"手写 <d> 且无 (SN) → 建议补说话人"
_SN_INLINE_RE = re.compile(r"\(S\d+\)")


def _ffmpeg_exe():
    """PATH 里的 ffmpeg 优先; 没有则回落 ComfyUI 自带的 imageio-ffmpeg."""
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"  # 让 subprocess 报出可读的 FileNotFoundError


# V1.9 批 3 T3.4: ffprobe 探测可执行 — 机器路径可经 h3_config.json ffprobe_exe
# 外置 (imageio-ffmpeg 只带 ffmpeg 无 ffprobe, 不设回落; PATH 找不到时让
# subprocess 报可读 FileNotFoundError, 探测失败由 _concat_videos 降级链兜底).
def _ffprobe_exe():
    p = str(_H3_CONFIG.get("ffprobe_exe", "") or "").strip()
    return p or "ffprobe"


# T9 任务①: 视频首帧 PNG 助手 — 给 __init__.py thumb 端点视频分支调用
# 2026-10-08 批 L4 T1: max_side 外提为参数 (默认 128 = 旧行为), 视频侧与图片侧对称遵守 max_size
def video_first_frame_png(path, max_side=128):
    """从 path 抽一帧 PNG bytes, 缩放最长边到 max_side; 任一失败返 None. 8s 超时防坏视频占槽."""
    cmd = [_ffmpeg_exe(), "-i", path, "-frames:v", "1", "-f", "image2",
           "-c:v", "png", "pipe:1"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        return None
    raw = proc.stdout or b""
    if proc.returncode != 0 or len(raw) < 8:
        return None
    try:
        from PIL import Image
        import io as _io
        im = Image.open(_io.BytesIO(raw))
        im.thumbnail((max_side, max_side))
        buf = _io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return None


# ============ V1.13h 第二波 T1: 两段式精修素材工具 ============
# 段二 Ref2VA 口型回锚的三类素材 (原声 wav / 段一产物中尾帧 PNG / 段一产物全片) 的
# ffmpeg/ffprobe 工具. 模块级纯 IO, 供端点编排与单测直调; 失败统一 ShotError.

def _run_media_cmd(cmd, what, timeout=600):
    """跑 ffmpeg/ffprobe: 不可用/超时/非零退出 → ShotError (带 stderr 摘要)."""
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError as e:
        raise ShotError("%s 不可用 (%s): %s" % (cmd[0], what, e))
    except subprocess.TimeoutExpired:
        raise ShotError("%s 超时 (%s, %ds)" % (cmd[0], what, timeout))
    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace")[-300:]
        raise ShotError("%s 失败 (%s, rc=%d): %s" % (cmd[0], what, proc.returncode, tail))
    return proc


def _probe_video_meta(mp4):
    """ffprobe 取 {width, height, frames}. 段二的分辨率/长度口径 = 段一产物实测."""
    cmd = [_ffprobe_exe(), "-v", "error", "-select_streams", "v:0", "-count_frames",
           "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", mp4]
    proc = _run_media_cmd(cmd, "探测视频元数据", timeout=120)
    try:
        streams = json.loads(proc.stdout.decode("utf-8", "replace")).get("streams") or []
        st = streams[0]
        return {"width": int(st["width"]), "height": int(st["height"]),
                "frames": int(st["nb_read_frames"])}
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ShotError("探测视频元数据失败 (%s): %s" % (mp4, e))


def _extract_audio_wav(mp4, dst):
    """抽 16kHz mono PCM wav (段二 drive_audio = 原段原声). 返回 dst."""
    cmd = [_ffmpeg_exe(), "-y", "-i", mp4, "-vn", "-ac", "1", "-ar", "16000",
           "-c:a", "pcm_s16le", dst]
    _run_media_cmd(cmd, "抽原声 wav")
    return dst


def _extract_frames(mp4, indices, dst_prefix):
    """按帧号抽 PNG → `<dst_prefix>_f%05d.png`; 返回路径列表 (顺序同 indices).

    indices: 帧号 (0-based); 负值自末尾计 (-1 = 末帧). 越界 → ShotError
    (不静默出空文件).
    """
    total = _probe_video_meta(mp4)["frames"]
    outs = []
    for raw_i in indices:
        i = int(raw_i)
        if i < 0:
            i = total + i
        if i < 0 or i >= total:
            raise ShotError("抽帧越界: 帧号 %s 超出 [0, %d) (%s)" % (raw_i, total, mp4))
        dst = "%s_f%05d.png" % (dst_prefix, i)
        cmd = [_ffmpeg_exe(), "-y", "-i", mp4, "-vf", "select=eq(n\\,%d)" % i,
               "-vsync", "0", "-frames:v", "1", dst]
        _run_media_cmd(cmd, "抽帧 %d" % i)
        outs.append(dst)
    return outs


def _mean_hsv_saturation(mp4, n):
    """均匀抽 n 帧, 返回逐像素 HSV 饱和度 (max-min)/max 的帧均值."""
    import numpy as np
    total = _probe_video_meta(mp4)["frames"]
    if total < 1:
        raise ShotError("视频无帧: %s" % mp4)
    idxs = [total // 2] if n <= 1 else [
        int(round(i * (total - 1) / (n - 1))) for i in range(n)]
    vals = []
    for i in idxs:
        cmd = [_ffmpeg_exe(), "-v", "error", "-i", mp4, "-vf",
               "select=eq(n\\,%d),format=rgb24" % i, "-vsync", "0",
               "-frames:v", "1", "-f", "rawvideo", "pipe:1"]
        proc = _run_media_cmd(cmd, "饱和度探测抽帧 %d" % i)
        arr = np.frombuffer(proc.stdout or b"", dtype=np.uint8)
        if arr.size < 3:
            continue
        arr = arr[:(arr.size // 3) * 3].reshape(-1, 3).astype("float32")
        mx = arr.max(axis=1)
        mn = arr.min(axis=1)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
        vals.append(float(sat.mean()))
    if not vals:
        raise ShotError("饱和度探测未取到任何帧: %s" % mp4)
    return sum(vals) / len(vals)


def _saturation_ratio(mp4_a, mp4_b, n=3):
    """原段 (a) vs 段二产物 (b) 的 HSV 饱和度均值比 sat_b/sat_a.

    返回值 <1 表示 b 偏饱和 → `_hue_align_video(b, ratio, dst)` 压回 a 的水准.
    a 饱和度≈0 (全黑/灰度参考) → 返 1.0 (无参考不动).
    """
    if n < 1:
        raise ShotError("_saturation_ratio: n 须 >= 1")
    sa = _mean_hsv_saturation(mp4_a, n)
    sb = _mean_hsv_saturation(mp4_b, n)
    if sa <= 1e-9:
        return 1.0
    return sb / sa


def _hue_align_video(src, ratio, dst):
    """按 ratio 压饱和度 (ffmpeg hue 滤镜); clamp ∈[0.5, 1.0] (只压不抬), 音轨直通."""
    r = min(1.0, max(0.5, float(ratio)))
    cmd = [_ffmpeg_exe(), "-y", "-i", src, "-vf", "hue=s=%s" % round(r, 4),
           "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
           "-c:a", "copy", dst]
    _run_media_cmd(cmd, "色彩对齐")
    return dst


def list_h3_templates(base_dir=H3_WORKFLOW_DIR):
    """扫描方案目录, 返回相对路径列表(按绝对路径排序, 跳过备份目录)。
    os.walk 递归全部层级; 相对路径 '/' 分隔; 任一级目录名含"备份"整枝跳过
    (S2: 先按绝对路径排序再转相对显示, 保证一级顺序与 V1.4 严格不变)。"""
    out = []
    base = os.path.normpath(base_dir)
    if not os.path.isdir(base):
        return out
    abs_paths = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if "备份" not in d]
        for f in files:
            if f.endswith(".json"):
                abs_paths.append(os.path.join(root, f))
    for p in sorted(abs_paths):
        out.append(os.path.relpath(p, base).replace("\\", "/"))
    return out


def _resolve_workflow_path(value, base_dir=None):
    if base_dir is None:
        base_dir = H3_WORKFLOW_DIR
    value = value or ""
    if not value.strip():
        value = DEFAULT_WORKFLOW
    if value.startswith("(默认) "):
        value = value[len("(默认) "):]
    if not value:
        return ""
    if os.path.isabs(value):
        return value
    return os.path.join(base_dir, value.replace("/", "\\"))


def usages_to_blocks(pool_usage, lang="zh", skip_subject=False, audio_slots=None):
    # V1.4 T2: 纯函数 — 把池行用途标注组装成代写句块列表(供 T3 发送链路 "\n\n" 拼接)
    # 拦截/警告归后续任务的规则检查器; 本函数只按注册表机械产句
    # V1.4 T6: 池行值恒 list[str]; 槽的用途集判定 "subject_look" in usages
    # ref / anchor 通用遍历: 按 kind 分桶, 收集 block 匹配的所有 usage, 槽号升序逐条产句
    # V1.7 B2: skip_subject=True 时跳过 subject 块 (cast 镜主体块唯一来源是 cast 路径, F4)
    # W2a-E: <Audio N> 的 N = 模型侧出现序号 (tokenizer 按独立音频出现顺序编号), 不是池槽号;
    # audio_slots = 序号源 (去重前并池 Audio 槽集 — 被手写标签剔除但仍接线的槽占位次),
    # 缺省取本 pool 的 Audio 槽集
    use_en = (lang == "en")
    list_sep = ", " if use_en else "、"
    blocks = []

    pool = pool_usage or {}
    picture = pool.get("Picture") or {}
    video   = pool.get("Video")   or {}
    audio   = pool.get("Audio")   or {}
    by_kind = {"Picture": picture, "Video": video, "Audio": audio}
    audio_rank = {s: i + 1 for i, s in enumerate(
        sorted(audio.keys() if audio_slots is None else audio_slots))}

    def _usages(slots, slot):
        # V1.4 T8 (登记 A): 值恒 list[str]; 旧 str 形态调用方已统一, 删除容错分支
        return slots.get(slot) or []

    # --- subject 块(唯一载体单句; 无 look 则整个 subject 块不产, 含 outfit / prop 同型合并) ---
    look_slots   = sorted([s for s, u in picture.items() if "subject_look" in _usages(picture, s)])
    outfit_slots = sorted([s for s, u in picture.items() if "subject_outfit" in _usages(picture, s)])
    prop_slots   = sorted([s for s, u in picture.items() if "subject_prop" in _usages(picture, s)])

    if not skip_subject and look_slots:
        parts = []
        first = look_slots[0]
        meta = USAGE_REGISTRY["subject_look"]
        template = meta["en"] if use_en else meta["zh"]
        parts.append(template.replace("{N}", str(first)).replace("{S}", "1"))

        if len(look_slots) > 1:
            extra_template = meta["en_extra"] if use_en else meta["zh_extra"]
            extra_tags = [f"<Picture {s}>" for s in look_slots[1:]]
            parts.append(extra_template.replace("{LIST}", list_sep.join(extra_tags)))

        if outfit_slots:
            outfit_meta = USAGE_REGISTRY["subject_outfit"]
            outfit_template = outfit_meta["en"] if use_en else outfit_meta["zh"]
            outfit_tags = [f"<Picture {s}>" for s in outfit_slots]
            parts.append(outfit_template.replace("{LIST}", list_sep.join(outfit_tags)))

        if prop_slots:
            prop_meta = USAGE_REGISTRY["subject_prop"]
            prop_template = prop_meta["en"] if use_en else prop_meta["zh"]
            prop_tags = [f"<Picture {s}>" for s in prop_slots]
            parts.append(prop_template.replace("{LIST}", list_sep.join(prop_tags)))

        blocks.append(", ".join(parts))

    # --- ref 块(通用遍历: 所有 block="ref" 条目, 跨 kind 按槽号升序逐条产句) ---
    # 批 A 节点 2 修正: pose 即便 block="subject", 仍以 (slot,kind) 排序混入 ref_items
    # (保证池路径字节锁定: pose 与 scene 等 ref 句按 (slot,kind) 升序逐条产句);
    # cast 路径 (skip_subject=True) 在 emit 时跳过 pose 句, 由 prompt_assembler H3 交替式承担
    ref_items = []  # [(slot, kind, usage_id)]
    for kind, slots in by_kind.items():
        for s, u in slots.items():
            for uid in _usages(slots, s):
                if USAGE_REGISTRY.get(uid, {}).get("block") == "ref":
                    ref_items.append((s, kind, uid))
    _pose_meta = USAGE_REGISTRY.get("pose") or {}
    if _pose_meta:
        for s, u in picture.items():
            if "pose" in _usages(picture, s):
                ref_items.append((s, "Picture", "pose"))
    ref_items.sort(key=lambda x: (x[0], x[1]))
    # #76: video_ref 产句按该段 video_ref 槽数分支 — 槽数=1 产复刻句;
    # 槽数>=2 产 legacy 旧句 (多视频段行为与现状逐字节一致·方案 §二 范围条款)
    _video_ref_count = len(video_ref_slots(pool))
    for slot, kind, uid in ref_items:
        # 批 A 节点 2: cast 路径 (skip_subject=True) 时 pose 句让位给 H3 交替式
        if uid == "pose" and skip_subject:
            continue
        meta = USAGE_REGISTRY[uid]
        template = meta["en"] if use_en else meta["zh"]
        if uid == "video_ref" and _video_ref_count >= 2:
            template = meta["en_legacy"] if use_en else meta["zh_legacy"]
        # W2a-E: audio_ref 的 N 用模型侧出现序号 (键序位次), 其余用途仍是池槽号
        n = audio_rank[slot] if uid == "audio_ref" else slot
        blocks.append(template.replace("{N}", str(n)))

    # --- anchor 块(通用遍历: 所有 block="anchor" 条目, 槽号升序) ---
    anchor_items = []
    for kind, slots in by_kind.items():
        for s, u in slots.items():
            for uid in _usages(slots, s):
                if USAGE_REGISTRY.get(uid, {}).get("block") == "anchor":
                    anchor_items.append((s, kind, uid))
    anchor_items.sort(key=lambda x: (x[0], x[1]))
    for slot, kind, uid in anchor_items:
        meta = USAGE_REGISTRY[uid]
        template = meta["en"] if use_en else meta["zh"]
        blocks.append(template.replace("{N}", str(slot)))

    return blocks


# V1.4 T3: 拼接 ref2v 专属 P9 锚定句常量(逐字锁定 — 改一处必须三处同改)
P9_ANCHOR_SENTENCE_ZH = "[画面锚定] 镜头从<Picture 9>的构图、场景与人物姿态开始（首帧锚点）"
P9_ANCHOR_SENTENCE_EN = "[Frame anchor] Start with the composition, scene and pose of <Picture 9> (first-frame anchor)"


def enrich_blocks(pool_usage, row_text_combined, cmode, pic9_present, lang="zh", warns=None, cast_spec=None):
    # V1.4 T3: 发送链路 enrich — 代写句组装 + P9 锚定句三重去重(纯函数零 IO)
    # V1.7 B2: cast_spec 非 None 时, 主体定义块唯一来源是 cast 路径 (F4); ref/anchor 照常
    # 模板族抑制: 非 ref2v (i2v/fl2v/t2v/None) → 不接参考槽, 句必悬空, 整体 []
    if cmode != "ref2v":
        return []

    # 手写去重: TAG_RE 扫 row_text_combined, 命中的 (Kind.title(), 槽号) 从 pool_usage 副本剔除
    filtered = {
        "Picture": dict(pool_usage.get("Picture") or {}),
        "Video":   dict(pool_usage.get("Video")   or {}),
        "Audio":   dict(pool_usage.get("Audio")   or {}),
    }
    # W2a-E: <Audio> 序号按去重前并池槽集计 — 手写标签剔除的槽仍接线, 仍占模型侧序号
    audio_slots_all = sorted(filtered["Audio"].keys())
    handwritten = set()
    for m in TAG_RE.finditer(row_text_combined or ""):
        handwritten.add((m.group("kind").title(), int(m.group("idx"))))

    for kind in ("Picture", "Video", "Audio"):
        slots = filtered[kind]
        for slot in list(slots.keys()):
            if (kind, slot) in handwritten:
                uids = slots.pop(slot)
                # V1.4 T8 (登记 A): uids 恒 list[str]; 整槽剔除, 警告文案说明该槽 N 个用途全跳过
                if warns is not None and uids:
                    n = len(uids)
                    warns.append("%s 槽 %d 已有手写标签, %d 个用途全部跳过(手写优先)"
                                 % (kind, slot, n))

    if cast_spec is not None:
        # F4: cast 镜主体块唯一来源是 cast 路径; ref/anchor 块照常从 filtered 产句
        blocks = usages_to_blocks(filtered, lang=lang, skip_subject=True,
                                  audio_slots=audio_slots_all)
        # 过滤 cast_spec: 副本虚拟槽用途未在 filtered (手写去重后) → 从该角色移除
        cast_spec_filt = _filter_cast_spec_by_filtered(cast_spec, filtered)
        # cast 主体块放 blocks 最前 (与现状 subject 块位置同构 — blocks 列表开头)
        blocks = list(cast_blocks(cast_spec_filt, lang=lang)) + blocks
    else:
        # 现状路径: 主体块 + ref + anchor 三类全部由 usages_to_blocks 产句
        blocks = usages_to_blocks(filtered, lang=lang, audio_slots=audio_slots_all)

    # P9 注入三重去重 — 全部满足才追加, 任一命中不注入, 绝不双句
    if cmode == "ref2v" and pic9_present:
        pic9_uids = filtered.get("Picture", {}).get(9) or []
        # V1.4 T8 (登记 A): pic9_uids 恒 list[str]; 用 in 判定 first_frame 是否在该槽
        is_first_frame = "first_frame" in pic9_uids
        has_p9_in_combined = ("Picture", 9) in handwritten
        if not is_first_frame and not has_p9_in_combined:
            blocks.append(P9_ANCHOR_SENTENCE_EN if lang == "en" else P9_ANCHOR_SENTENCE_ZH)

    return blocks


def _filter_cast_spec_by_filtered(cast_spec, filtered):
    """V1.7 B2: cast_spec 按 filtered (手写去重后存活集) 过滤副本虚拟槽。
    副本虚拟槽被手写命中剔除 → 该行从该角色移除 (无 look 行则 cast_blocks 自跳过整块)。
    cast_spec 顺序 = 出场顺序 = Subject 编号顺序, 保留不动。"""
    pic_filt = (filtered or {}).get("Picture") or {}
    out = []
    for subject_no, rows in (cast_spec or []):
        kept = []
        for row in (rows or []):
            slot, usage, desc = row[0], row[1], row[2]
            ig = row[3] if len(row) > 3 else ""
            uids = pic_filt.get(slot) or []
            if usage in uids:
                kept.append((slot, usage, desc, ig))
        out.append((subject_no, kept))
    return out


# V1.7 A2: 多角色出场角色解析 — 纯函数族(零 IO; 资产库由调用方传入, 本层不读盘)
# 出场角色列分隔符: 半角 , 与全角 ， 均合法; 连续分隔符产生的空名静默丢弃不警告
_CAST_NAME_SEP_RE = re.compile(r"[,，]")
# v3 character 卡参与多角色合成的行用途白名单(pose/first_frame/video_ref/audio_ref 等不入)
# 1.11c 波2-T4: 纳入"三视图" — 跑批锚定优先三视图行的实现位; 白名单过滤天然支持删行回退, 零额外代码
# 1.11d: 纳入"scene" — 卡上场景行自动带图 (场景漂移第三根因缺口); scene block=ref 走参考句路径
# (usages_to_blocks ref 遍历产"场景以<Picture N>为准", 双锚豁免表 _REF_LINE_RES 数据驱动命中),
# 有意不进 _H3_SEG 段表 — 不产 Subject 段不占锚位 (区别于三视图 block=subject)
CAST_ROW_USAGES = frozenset({"subject_look", "subject_outfit", "subject_prop", "三视图", "scene", "道具多角度"})


def parse_cast(text):
    """解析分镜行"出场角色"列原始值(str|None) → (names, warns)。
    names = 保序去重卡名列表; warns = 仅重复名警告(每名恰一条, 文案不拼镜号 —
    镜号由预检层调用时包装): 出场角色「{名}」重复, 已按一次计。
    None / 空串 / 纯分隔符 → ([], [])。"""
    if not text:
        return [], []
    names = []
    seen = set()
    warned = set()
    warns = []
    for token in _CAST_NAME_SEP_RE.split(str(text)):
        name = token.strip()
        if not name:
            continue  # 连续分隔符产生的空名静默丢弃
        if name in seen:
            if name not in warned:
                warned.add(name)
                warns.append("出场角色「%s」重复, 已按一次计" % name)
            continue
        seen.add(name)
        names.append(name)
    return names, warns


# ============ V1.12b v4 T4: 人物建档 路由 + 编排 静态判定 ============
# 判据 (v6 设计定稿): 池用途 (`_pool_usage` 完整判 character/scene/prop) + 卡行
# scene/prop (素材在卡上的真机姿势, 与 v4 同路径读主卡).
# 卡行 subject_look/outfit/pose/三视图 **不参与** route_kind 类型判定 —
# 它们是承接待卡标志 (建档产物消费承接, 非建档对象素材), 由 `enrollment_should_run`
# 守卫按 character→look / scene→scene 承接判定. 一票否决顺序 (人物>场景>道具) 仍钉死.
#
# V1.12b v4 真机修正: 池空 + 素材在主卡卡行 → 路由 None → 建档永不触发.
# V1.12b v6 修正: 卡行 look/outfit/pose/三视图 错判 character 的 bug.
# 池空 + 卡行仅 look → None (承接-only, 无建档对象素材, 跳过). 真正的 character
# 路由由池的 look 素材提供 (test_route_kind_character_when_subject_look_only).

_CHARACTER_USAGE_IDS = frozenset({"subject_look", "subject_outfit", "pose", "三视图"})
# v6: 卡行判据的 character 用途集 (空) — 实际不参与类型判定.
_CARD_ROW_CHARACTER_USAGE_IDS = frozenset()  # 占位, 便于读者理解意图
_CARD_ROW_KIND_USAGE_IDS = frozenset({"scene", "subject_prop"})


def enrollment_route_kind(eng):
    """V1.12b v4 T4 + v6 修正: 池用途 + 卡行 scene/prop 一票否决判定建档产物 kind.

    Args:
        eng: H3BatchEngine 实例 (只需 _pool_usage 属性).

    Returns:
        "character" / "scene" / "item" / None.
        - 池任一 character 用途 (subject_look/outfit/pose/三视图) → "character" (一票否决).
        - 池无 character + 任一 scene → "scene".
        - 池无 character/scene + 任一 subject_prop → "item".
        - 无任何建档对象素材 → None (静默跳过).

    V1.12b v6 语义定稿 (f91b0fa 修正):
      - 判据源 = 池用途 (_pool_usage: character/scene/prop 全判)
              + 卡行 scene/prop (f91b0fa 服务真机"素材在卡上"姿势).
      - 卡行 subject_look/outfit/pose/三视图 **不参与** 类型判定 — 承接待卡标志,
        由 enrollment_should_run 守卫管 (character→enrollment_card_has_look,
        scene→enrollment_card_has_scene).
      - 池空 + 卡行仅 look → None (承接-only, 无建档对象素材, 跳过).

    主卡路径 = `server_input_dir/asset_library/archive_docs/<主卡>.json`,
    server_input_dir 取 `_server_input_dir/_input_dir/input_dir` 兜底链.
    主卡文件不存在/坏 JSON → 静默忽略卡行判据 (仅用 CSV 池).
    """
    pu = getattr(eng, "_pool_usage", None) or {}
    picture = pu.get("Picture") or {}
    has_character = False
    has_scene = False
    has_prop = False
    for _slot, uids in picture.items():
        uids_list = uids if isinstance(uids, (list, tuple)) else [uids]
        for uid in uids_list:
            if uid in _CHARACTER_USAGE_IDS:
                has_character = True
            elif uid == "scene":
                has_scene = True
            elif uid == "subject_prop":
                has_prop = True
    # V1.12b v4 + v6 真机姿势: 叠加主卡卡行判据 (素材在卡上而非 CSV 池).
    # v6 修正: 卡行仅 scene/prop 参与类型判定, look/outfit/pose/三视图 是承接不计入.
    _card = _load_primary_card_for_route(eng)
    if _card is not None:
        for _row in (_card.get("rows") or []):
            if not isinstance(_row, dict):
                continue
            _uid = _row.get("usage")
            if _uid in _CARD_ROW_KIND_USAGE_IDS:
                if _uid == "scene":
                    has_scene = True
                elif _uid == "subject_prop":
                    has_prop = True
            # else: 承接标记 (subject_look/outfit/pose/三视图/道具多角度) — 不计入
    if has_character:
        return "character"
    if has_scene:
        return "scene"
    if has_prop:
        return "item"
    return None


def _load_primary_card_for_route(eng):
    """V1.12b v4 真机修正辅助: 读主卡 (v3 character) 卡 dict; 不可用 → None.

    与 `enrollment_should_run` 既有主卡读取同路径 (server_input_dir 兜底链 + 静默
    OSError/ValueError 兜底). 无主卡 / 无 server_input_dir / 卡坏 → None (调用方
    退化为仅 CSV 池判据, 不抛).
    """
    primary = enrollment_primary_card_name(eng)
    if not primary:
        return None
    # 1.14 整改批 C C3: 卡名漏斗统一 — 读面过 _h3_safe_filename (单一漏斗), 与建档口 __init__.py
    # 写面 / asset_copy / archive_purge 三方一致; 同 raw 名经任何一面落到同一 cleaned 名.
    primary = _h3_safe_filename(primary)
    if not primary:
        return None
    server_input_dir = (getattr(eng, "_server_input_dir", None)
                        or getattr(eng, "_input_dir", None)
                        or getattr(eng, "input_dir", None) or "")
    if not server_input_dir:
        return None
    card_path = os.path.join(server_input_dir, "asset_library",
                             "archive_docs", primary + ".json")
    if not os.path.isfile(card_path):
        return None
    try:
        with open(card_path, encoding="utf-8") as f:
            _obj = json.load(f)
    except (OSError, ValueError):
        return None
    # 1.14 整改批 C 双审 B1-F1 修正笔承接: 卡 JSON 顶层非对象 (如 []/标量) → 软失败返 None.
    # 否则下游 `_card.get("rows")` AttributeError → submit 500 (B 档实测复现).
    if not isinstance(_obj, dict):
        return None
    return _obj


def enrollment_primary_card_name(eng):
    """V1.12b v4 T4: 主卡判定 (cast_plan["shots_in_scene"] 首个非空 list 首个角色名).

    方案 M2 三轮 E 修正: 不取 [0] —— 首行可能空名单; 全空 → None 兜底.
    _cast_plan 缺失 (预检失败 / 未跑预解析) → None 兜底.
    """
    cp = getattr(eng, "_cast_plan", None)
    if not isinstance(cp, dict):
        return None
    sis = cp.get("shots_in_scene")
    if not isinstance(sis, list):
        return None
    for row in sis:
        if isinstance(row, list) and row:
            first = row[0]
            if isinstance(first, str) and first:
                return first
    return None


def enrollment_card_has_look(card):
    """V1.12b v4 T4: 承接待卡判定 (M2 三轮 M-3) — 卡 rows 中任一 usage=="subject_look".

    建档产物须能被本批消费, 承接待卡无 look 行 → 整卡被 assign_cast_slots 跳过 → 跳过.
    """
    if not isinstance(card, dict):
        return False
    rows = card.get("rows") or []
    if not isinstance(rows, list):
        return False
    for r in rows:
        if isinstance(r, dict) and r.get("usage") == "subject_look":
            return True
    return False


def enrollment_card_has_scene(card):
    """V1.12b v5: 场景建档承接待卡判定 — 卡 rows 中任一 usage=="scene".

    与 enrollment_card_has_look 同构: 场景建档产物 (scene_canvas.png) 须 scene 行承接,
    scene 卡天然含 scene 行; 主卡缺 scene 行 (空 rows / 错卡) → 跳过 (产物无处承接).
    """
    if not isinstance(card, dict):
        return False
    rows = card.get("rows") or []
    if not isinstance(rows, list):
        return False
    for r in rows:
        if isinstance(r, dict) and r.get("usage") == "scene":
            return True
    return False


def enrollment_card_has_prop(card):
    """1.14 整改批 J J4: 道具承接待卡判定 — 卡 rows 中任一 usage=="subject_prop".

    与 enrollment_card_has_scene / enrollment_card_has_look 同构: 道具建档产物
    (item_canvas.png → 卡 `道具多角度` 行) 须道具卡承接, 道具卡天然无 subject_look 行
    (生产实测: 道具卡 = subject_prop 行 + 无 look 行) — 无 prop 行 → 无道具对象素材, 跳过.
    """
    if not isinstance(card, dict):
        return False
    rows = card.get("rows") or []
    if not isinstance(rows, list):
        return False
    for r in rows:
        if isinstance(r, dict) and r.get("usage") == "subject_prop":
            return True
    return False


def enrollment_should_run(eng):
    """V1.12b v4 T4 + v5 T-BugFix + 1.14 批 J J4: 守卫 — 三条件全满足才建档.

    ① eng._enrollment_enabled (CSV 开关/批级门控).
    ② 路由有解 (enrollment_route_kind 返非 None, 即有素材).
    ③ 主卡可判 (cast_plan shots_in_scene 非空) + 按路由分派承接待卡判定:
       - scene → enrollment_card_has_scene (主卡有 scene 行; scene 卡天然如此)
       - item → enrollment_card_has_prop(有 subject_prop 行) 或 enrollment_card_has_look
         (三审裁 A 联合判据: 道具卡天然无 look 行, 旧 look 判定恒 False → 道具建档永不
          触发; 补 subject_prop 承接判据打通建档, 既有 look 承接不放宽亦不收紧)
       - character → enrollment_card_has_look (主卡有 subject_look 行)
    任一不满足 → 静默跳过 (False).

    V1.12b v5 真机修正: scene 路由主卡是 scene 卡 (无 subject_look 行), 旧逻辑
    `enrollment_card_has_look` 恒 False → scene 建档永不触发. 现按路由分派, scene
    路由走 scene 行判定 (scene 卡天然满足), 不再误杀.
    J4 同型修正: item 路由按 subject_prop 行判定 (产物 `道具多角度` 行可被批消费),
    同时保留 look 承接 (池 prop + 仅 look 主卡的既有真机姿势零回归).
    """
    if not getattr(eng, "_enrollment_enabled", False):
        return False
    kind = enrollment_route_kind(eng)
    if kind is None:
        return False
    primary = enrollment_primary_card_name(eng)
    if not primary:
        return False
    # 1.14 整改批 C C3: 卡名漏斗统一 — 读面过 _h3_safe_filename (单一漏斗, 与 _load_primary_card_for_route
    # 同口径), 与建档口 __init__.py 写面 / asset_copy / archive_purge 三方一致. 同 raw 名经任何一面
    # 落到同一 cleaned 名 → 路径段无 Windows 非法字符 → 不再 threepov.py:1107 makedirs OSError 硬失败.
    primary = _h3_safe_filename(primary)
    if not primary:
        return False
    # 主卡读 — 从 server_input_dir/asset_library/archive_docs/<主卡>.json
    server_input_dir = (getattr(eng, "_server_input_dir", None)
                        or getattr(eng, "_input_dir", None)
                        or getattr(eng, "input_dir", None) or "")
    if not server_input_dir:
        return False
    card_path = os.path.join(server_input_dir, "asset_library",
                             "archive_docs", primary + ".json")
    if not os.path.isfile(card_path):
        return False
    try:
        with open(card_path, encoding="utf-8") as f:
            card = json.load(f)
    except (OSError, ValueError):
        return False
    # V1.12b v5: 按路由分派承接待卡判定
    if kind == "scene":
        return enrollment_card_has_scene(card)
    # 1.14 批 J J4 (三审裁 A 联合判据): item 路由按 subject_prop 行判定 (道具卡无 look 行,
    # 旧 look 判定恒 False → 建档永不触发); 同时保留 look 承接 (池 prop + 仅 look 主卡的
    # 既有真机姿势零回归, test_enrollment 两向用例夹定)
    if kind == "item":
        return enrollment_card_has_prop(card) or enrollment_card_has_look(card)
    # character 维持 look 判定 (M3 character 契约不变)
    return enrollment_card_has_look(card)


def resolve_cast(names, assets):
    """卡名列表 → (resolved, errs)。assets = 资产库 dict(调用方传入, 本函数不读盘),
    顶层形状 {"schema_version": 2, "<label>": 卡对象, ...}, 卡按 label 平铺。
    resolved 与 names 等长同序, 每项 (卡对象 | None, 错误码 | None);
    errs = 失败名按序 (卡名, 错误码), 与 resolved 中 None 项一一对应。
    错误码仅两个: not_found(名不在库) / not_v3_character(卡非 _v=3 的 character/scene/item,
    含 v1 老卡[无 _v] / v2 卡 / v3 异常 kind)。V1.12: scene 卡放行 (消费链路由
    _prepare_cast_plan 分流为"只占 Picture 槽、不产 Subject 行", 见 docs/api.md 契约)。
    1.14 批 J J4: item 卡 (= 道具卡) 同款放行 (道具多角度 ref 句承接)。"""
    resolved = []
    errs = []
    for name in names or []:
        card = (assets or {}).get(name)
        if not isinstance(card, dict):
            resolved.append((None, "not_found"))
            errs.append((name, "not_found"))
        elif card.get("_v") != 3 or card.get("kind") not in ("character", "scene", "item"):
            resolved.append((None, "not_v3_character"))
            errs.append((name, "not_v3_character"))
        else:
            resolved.append((card, None))
    return resolved, errs


def card_cast_rows(card):
    """v3 character 卡 → (rows_white, skipped), 均保持卡内行序。
    rows_white = 白名单用途行(subject_look/subject_outfit/subject_prop/三视图/scene);
    skipped = 白名单外用途行(pose/first_frame/video_ref/audio_ref 等),
    供预检 WARN 第 8 条使用(文案归后续任务, 本函数只返回行)。"""
    rows = (card or {}).get("rows") or []
    rows_white = []
    skipped = []
    for r in rows:
        if r.get("usage") in CAST_ROW_USAGES:
            rows_white.append(r)
        else:
            skipped.append(r)
    return rows_white, skipped


# 1.14 批 L5 R-26: 段池资产提示词锚定句 (GUI 零改 · 引擎侧闭环)
# 段池通道 (批 K) 现状只有裸 <Picture N> 接线 + 卡名原文, 无 desc 锚定句 (老 @N 通道
# 有) → 同域竞争时 B 维画面特征偏弱。本段两个纯函数 = 该特性的全部判据来源。
SEG_ANCHOR_MAX_DESC = 120          # desc 截断 (code points, 防 prompt 膨胀)
_SEG_ANCHOR_USAGES = frozenset({"subject_look", "subject_outfit",
                                "subject_prop", "三视图"})


def _seg_media_norm(media):
    """media → 归一化比对键 (normcase + 分隔符统一 "/")。

    真机实测两侧形态不一致: 引擎档案卡 rows[].media 存**相对短形态**
    (library\\archive_images\\双马尾\\x.png), 而 GUI seg_pools 下发**绝对全路径**
    (N:\\...\\input\\asset_library\\archive_images\\双马尾\\x.png) —— 等值比对必 miss。
    先统一形态再比, 才能让两侧对上。
    """
    return os.path.normcase((media or "").replace("\\", "/")).replace("\\", "/").strip()


def _seg_media_hit(sending, card_media):
    """段池发送侧 media 与卡行 media 是否同一素材。

    ① 归一后精确等值 (同形态绝对/相对路径) → 命中;
    ② 不等再判**卡行形态是否为发送侧的后缀** (方向单向: 只有短的卡行相对形态能命中
       长的发送侧绝对路径, 反向不命中 —— 防不同素材互撞)。

    ② 刻意用**纯字符串后缀**、不要求卡前是路径分隔符 —— 真机形态下卡行首段会落在
    发送侧某个目录名的中间 (卡 "library\\archive_images\\..." vs 绝对路径
    "...\\input\\asset_library\\archive_images\\..."), 段边界规则会把真机形态判否。
    """
    s = _seg_media_norm(sending)
    c = _seg_media_norm(card_media).lstrip("/")
    if not s or not c:
        return False
    return s == c or s.endswith(c)


def _seg_anchor_desc_lookup(assets, media, binding_names=None):
    """段池槽 media → 卡行反查 → {"name","kind","desc"} 或 None (纯函数零 IO)。

    比对走 _seg_media_hit (归一等值或卡行后缀, 见其两侧形态说明); 多卡平局 =
    绑定卡优先 + 其余 sorted(卡名) —— os.listdir 序不稳定, 不排即每次可能选到不同卡。
    """
    hits = []
    for name, card in (assets or {}).items():
        if not isinstance(card, dict) or not isinstance(name, str) or not name:
            continue
        for row in (card.get("rows") or []):
            if isinstance(row, dict) and _seg_media_hit(media, row.get("media")):
                hits.append((name, card, row))
                break  # 同卡同 media 多行 → 取卡内首行
    if not hits:
        return None
    bound = set(binding_names or ())
    hits.sort(key=lambda h: (0 if h[0] in bound else 1, h[0]))
    name, card, row = hits[0]
    return {"name": name, "kind": card.get("kind") or "",
            "desc": row.get("desc") or ""}


def _seg_anchor_line(kind, usage, slot, card, lang):
    """段池槽 → `[分镜参考]` 锚定句; B1 门控不过返 None (静默, 不产退化句)。

    B1 三重门控 (硬红线): Picture 槽 ∧ usage∈人物四用途 ∧ 卡 kind==character ——
    scene/video_ref/audio_ref 槽与无卡/非人物卡一律不产句。
    zh-only 门控: en 任务不注入 (声明不猜 en 模板)。
    card = {"name","kind","desc"} (来自 _seg_anchor_desc_lookup)。
    """
    if kind != "Picture" or usage not in _SEG_ANCHOR_USAGES:
        return None
    if lang != "zh":
        return None
    if not isinstance(card, dict) or card.get("kind") != "character":
        return None
    pic = "<Picture %d>" % int(slot)
    desc = (card.get("desc") or "").strip()
    if desc:
        name = card["name"]
        return ("[分镜参考] %s: %s——%s；画面中 %s 的外貌与特征以 %s 为准"
                % (pic, name, desc[:SEG_ANCHOR_MAX_DESC], name, pic))
    return ("[分镜参考] %s: %s——画面中该参考图的人物外貌与特征以 %s 为准"
            % (pic, card["name"], pic))


def _seg_anchor_rows_for_entry(entry, assets, lang, binding_names=None):
    """段池条目 → [(槽号, 锚定行), ...] 槽号升序 (纯函数零 IO; 判据全在 _seg_anchor_line)。

    同槽多个人物用途只产一行 (锚定句只说一件事, 重复即 prompt 膨胀)。
    """
    rows = []
    slots = (entry or {}).get("Picture") or {}
    if not isinstance(slots, dict):
        return rows
    for raw_slot, spec in slots.items():
        if not isinstance(spec, dict):
            continue
        usages = [u for u in (spec.get("usages") or []) if u in _SEG_ANCHOR_USAGES]
        media = spec.get("media") or ""
        if not usages or not media:
            continue
        try:
            slot = int(raw_slot)   # JSON 槽号是字符串 (同 _merge_seg_pools_entry 口径)
        except (TypeError, ValueError):
            continue
        line = _seg_anchor_line("Picture", usages[0], slot,
                                _seg_anchor_desc_lookup(assets, media, binding_names),
                                lang)
        if line:
            rows.append((slot, line))
    rows.sort(key=lambda r: r[0])
    return rows


def _seg_anchor_block(rows, row_text):
    """锚定行集 → 追加块文本 (块间 \\n\\n); 手写 <Picture N> 槽跳过; 空 → ""。

    手写同口径 = enrich_blocks 的 TAG_RE(row_text_combined) 整槽剔除 (集合不外露, 此处重扫):
    手写已含锚定意的槽不重复追加。
    """
    handwritten = {(m.group("kind").title(), int(m.group("idx")))
                   for m in TAG_RE.finditer(row_text or "")}
    return "\n\n".join(line for slot, line in (rows or [])
                       if ("Picture", slot) not in handwritten)


def _seg_pools_entry(seg_pools, row):
    """段池表 → 该行的段级池条目 (按段行 ID 命中); 无键/无条目/行无 ID = None。

    键域 = 提交时段行 ID (s01 式零填充两位) — GUI submit.js 与引擎同源同序,
    引擎不重编号、不按行序猜测 (契约 #12)。引擎 self._seg_pools 与端点预览的
    body["seg_pools"] 同键域, 故同走本函数 (单一来源, 不两处各抄一遍键规则)。
    """
    sp = seg_pools or {}
    if not isinstance(sp, dict) or not sp:
        return None
    rid = str(row.get("ID") or "").strip() if isinstance(row, dict) else ""
    if not rid:
        return None
    entry = sp.get(rid)
    return entry if isinstance(entry, dict) and entry else None


# V1.7 A3: 多角色虚拟槽位分配 — 槽域 Picture 1-8; 9 永不分配
# (保留首帧锚定/拼接尾帧语义, 分镜与拼接两模式一致)
CAST_SLOT_DOMAIN = tuple(range(1, 9))


def assign_cast_slots(cast_rows, pool, pool_usage, mode, scene_card_names=None,
                     bound_slots=None, item_card_names=None):
    """多角色出场角色的白名单行分配到 Picture 虚拟槽(纯函数零 IO)。

    cast_rows = [(卡名, usage, media, desc), ...] 扁平行(调用方从 A2 白名单 +
    卡内行序展开而来); pool / pool_usage 槽号键为 int, 本函数只看 Picture;
    mode = "分镜" 或 "拼接"(两模式分配规则一致, 参数仅供调用方传语境)。
    scene_card_names = None(缺省) → 旧行为不变, 全部卡按 character 规则 (无 look 整卡跳过);
      非 None 集合内的卡名 (kind=="scene", 扁平行不带 kind 由调用方判定) 跳过
      "无 subject_look 前置" 直接参与分配 (V1.12 场景卡消费)。
    item_card_names = None(缺省) → 旧行为不变; 非 None 集合内的卡名 (道具卡, 扁平行不带
      kind 由调用方判定) 同 scene 通道参与分配 (1.14 批 J J4 道具卡消费)。
    bound_slots = None 或 整数槽号可迭代对象 (V1.13 波2 D4): 绑定卡已占槽集,
      分配时**排除**这些槽位 (避免未绑定卡分到绑定卡槽 → slot_map.update 覆盖 +
      pool_copy 换图). 容量预检 (required > 可用空槽数) 也以此为基线.
    返回 (slot_map, err):
      slot_map = {槽号(int): (卡名, usage, media, desc[, ignore_words])} — 值保留 usage 与 desc
      (下游产句依赖: outfit/prop 分句、首槽主锚点判定、特征带出); cast 行带 ignore_words 时
      值尾部追加第五位 (1.11a 波1: 忽略词透传产句层, 空位缺省兼容); err 成功为 ""。
    分配规则: 槽域 1-8; 占用 = 池有文件 / pool_usage 有标注 / 绑定卡已占 (三者任一);
    从 1 起升序取空槽; 无 subject_look 行的卡整卡跳过(不分配不占槽, 警告文案归
    预检层); 有 look 的卡全部白名单行按行序依次占槽, 同卡多行同 usage 各占一槽,
    首槽 = 主锚点; 卡间按出场顺序(cast_rows 中首现顺序)。
    预算不足(所需空槽数 > 可用空槽数) → err 非空(文案素材
    `需 {X} 个空槽, 素材池仅剩 {Y} 个（Picture 9 保留）`, 调用方拼镜号前缀).
    V1.13 波2 D4 扩: 有 bound_slots 时, 文案追加绑定卡占用说明 (`绑定卡已占 N 槽`)
    便于调用方区分根因. 此时 slot_map = {}(全有或全无, 不返回部分分配)。"""
    rows = list(cast_rows or [])

    # 卡分组与出场顺序(首现顺序); 无 look 卡整卡跳过(不分配、不占槽、不计需求)
    has_look = set()
    rows_by_card = {}
    ordered_cards = []
    for row in rows:
        name, usage = row[0], row[1]
        if name not in rows_by_card:
            rows_by_card[name] = []
            ordered_cards.append(name)
        rows_by_card[name].append(row)
        if usage == "subject_look":
            has_look.add(name)
    # 参与分配的卡: 有 look 的 character 卡 ∪ scene 卡 ∪ 道具卡 (后两类无 look 亦参与)
    participating = set(has_look)
    if scene_card_names:
        participating |= {n for n in ordered_cards if n in scene_card_names}
    if item_card_names:
        participating |= {n for n in ordered_cards if n in item_card_names}
    required = sum(len(rows_by_card[n]) for n in ordered_cards if n in participating)

    # 绑定卡已占槽集 (V1.13 波2 D4) — 从可用空槽集合排除, 避免未绑定卡分到绑定卡槽
    # 仅 1-8 视为虚拟槽域; 越界值 (如 idx=0 / idx>=9) 静默忽略, 不污染可用空槽
    bound_set = {int(s) for s in (bound_slots or [])
                 if isinstance(s, int) and 1 <= int(s) <= 8}

    # 可用空槽 = 1-8 中未被占用者(占用 = 池有文件 / pool_usage 有标注 / 绑定卡已占, 任一)
    # V1.7 B2 门审修复: 槽号键统一 int (与生产 _parse_pool / _pool_usage 一致),
    # 此前 str(s) 判定在 int 键池上恒假, 导致已占槽被误判为空闲、虚拟槽与用户素材撞车
    pic_pool = (pool or {}).get("Picture") or {}
    pic_usage = (pool_usage or {}).get("Picture") or {}
    free_slots = [s for s in CAST_SLOT_DOMAIN
                  if s not in pic_pool and s not in pic_usage and s not in bound_set]

    if required > len(free_slots):
        # V1.13 波2 D4: 有绑定卡占用时, 报错文案追加说明, 调用方可区分"绑定卡+未绑定卡"
        # 合计超容量 vs 单边未绑定超容量两种根因
        if bound_set:
            return {}, ("需 %d 个空槽, 绑定卡已占 %d 槽, "
                        "素材池仅剩 %d 个（Picture 9 保留）"
                        % (required, len(bound_set), len(free_slots)))
        return {}, "需 %d 个空槽, 素材池仅剩 %d 个（Picture 9 保留）" % (
            required, len(free_slots))

    slot_map = {}
    idx = 0
    for name in ordered_cards:
        if name not in participating:
            continue
        for row in rows_by_card[name]:
            ig = row[4] if len(row) > 4 else ""
            slot_map[free_slots[idx]] = ((row[0], row[1], row[2], row[3], ig)
                                         if ig else (row[0], row[1], row[2], row[3]))
            idx += 1
    return slot_map, ""


# 批 A 节点 2: H3 交替式 Subject 行 — 单一实现 (cast_blocks 与 _compose_subject_line 并轨)
# 段落标签映射: subject_look→外貌/人物外貌; subject_outfit→服装/人物服装;
#               subject_prop→道具/人物道具; pose→姿势/人物姿势
# 锚定句同构: "以 <Picture M> 的人物<属性名>为准"
# 段间用中文分号"；"连接; desc 空 → 省 desc 段, 锚定句保留;
#             desc 非空 → "【属性】<desc>，人物<属性名>，以 <Picture M> 的人物<属性名>为准"
# 段顺序: 外貌 → 三视图 → 服装 → 道具 → 姿势 (按卡内行序, 同 usage 多槽按 slot 升序)
# 1.11c 波2-T4: 三视图插于外貌后 — 三视图作为外貌的另一类参考图, 段序紧随; 服装/道具/姿势维持原序
_H3_SEG_ORDER = ("subject_look", "三视图", "subject_outfit", "subject_prop", "pose")
_H3_SEG_TAG = {  # 段落标签 (方括号内)
    "subject_look": "外貌",
    "三视图": "三视图",
    "subject_outfit": "服装",
    "subject_prop": "道具",
    "pose": "姿势",
}
_H3_SEG_ATTR = {  # 锚定句中的属性名 (人物外貌/人物服装/...)
    "subject_look": "人物外貌",
    "三视图": "人物三视图",
    "subject_outfit": "人物服装",
    "subject_prop": "人物道具",
    "pose": "人物姿势",
}


def _build_h3_subject_line(subject_no, rows, lang="zh"):
    """H3 交替式 Subject 行 — 单一实现 (供 cast_blocks 与 _compose_subject_line 共用)。

    subject_no: int, Subject 编号;
    rows: list[(slot, usage, desc), ...] — 卡内行序, 单 subject 行集;
    lang: "zh" / "en" — zh 走全字段 (【】/，/；); en 走英文冒号拼接, 段间 " ; "。
    无 look 行 → 返回 None (调用方自决定整块跳过)。
    """
    # 按 usage 分桶 (保卡内行序); 仅保留 H3 段落映射的四种 usage
    buckets = {u: [] for u in _H3_SEG_ORDER}
    for row in (rows or []):
        slot, usage, desc = row[0], row[1], row[2]
        ig = row[3] if len(row) > 3 else ""
        if usage in buckets:
            desc_s = (desc or "").strip() if isinstance(desc, str) else ""
            ig_s = ig if isinstance(ig, str) else ""
            words = "、".join(w.strip() for w in re.split(r"[、,，]", ig_s) if w.strip())
            buckets[usage].append((slot, desc_s, words))
    if not buckets["subject_look"]:
        return None  # 无 look 行 → 整块跳过
    use_en = (lang == "en")
    # 段顺序遍历, 各 usage 内按 slot 升序
    seg_parts = []
    for u in _H3_SEG_ORDER:
        for slot, desc_s, ignore_s in sorted(buckets[u], key=lambda x: x[0]):
            tag = _H3_SEG_TAG[u]
            attr = _H3_SEG_ATTR[u]
            pic_m = "<Picture %d>" % slot
            if use_en:
                # en: 段格式 "tag: <desc>, <attr>, follow <Picture M>" (en 路径未启用 H3 交替式, 维持基线旧形态)
                # desc 空 → 段: "tag: <attr>, follow <Picture M>"
                if desc_s:
                    seg = "%s: %s, %s, follow %s" % (tag, desc_s, attr, pic_m)
                else:
                    seg = "%s: %s, follow %s" % (tag, attr, pic_m)
                seg_parts.append(seg)
            else:
                # zh: 段格式 "【<tag>】<desc>，人物<attr>以 <Picture M> 的人物<attr>为准"
                # (批 B-0 节点 0 修: 删除 attr 后多余逗号; desc 后逗号保留)
                if desc_s:
                    seg = "【%s】%s，%s以 %s 的%s为准" % (tag, desc_s, attr, pic_m, attr)
                else:
                    seg = "【%s】%s以 %s 的%s为准" % (tag, attr, pic_m, attr)
                if ignore_s and not use_en:
                    seg += "；忽略 %s 中的%s" % (pic_m, ignore_s)
                seg_parts.append(seg)
    if not seg_parts:
        return None
    # 段间连接: zh 用 "；"; en 用 " ; "
    sep = " ; " if use_en else "；"
    return "<Subject %d>: %s" % (subject_no, sep.join(seg_parts))


# V1.7 B1: 多角色主体定义块 — zh 走 H3 交替式 (批 A 节点 2), en 走基线旧形态 (V1.7 锁定)
def cast_blocks(cast_spec, lang="zh"):
    """多角色主体定义块产句 (纯函数零 IO)。

    cast_spec = [(subject_no, [(slot, usage, desc), ...]), ...]
    —— 调用方从 assign_cast_slots 的 slot_map 按卡分组构造;
       subject_no = 出场编号 1..N; 内部 (slot, usage, desc) 三元组按卡内行序。

    批 A 节点 2: zh 走 H3 交替式 (单一实现, 与 _compose_subject_line 并轨);
    en 路径维持基线旧形态逐字节不变 (六字段+H3 交替式仅 zh 定稿, en 留后批)。

    zh: 每角色产恰一个单行块: <Subject N>: 【外貌】...；【服装】...；【道具】...；【姿势】...
    en (基线): 每角色产恰一个单行块: "[Subject] Subject S is the character in <Picture N>: face and appearance follow this reference[, appearance reference <LIST>][, outfit follows <LIST>][, held prop follows <LIST>][; traits: <LIST>]"
    段顺序: 外貌 → 服装 → 道具 → 姿势 (zh 按卡内行序, 同 usage 多槽按 slot 升序);
    无 look 行的角色整块跳过; 块顺序 = cast_spec 顺序 (出场顺序)。
    返回 list[str] — 每角色一行 (供前端/引擎对拍)。
    """
    use_en = (lang == "en")
    if use_en:
        # en: 基线 V1.7 旧形态逐字节还原 (六字段+H3 交替式仅 zh 定稿)
        list_sep = ", "
        look_meta = USAGE_REGISTRY["subject_look"]
        outfit_meta = USAGE_REGISTRY["subject_outfit"]
        prop_meta = USAGE_REGISTRY["subject_prop"]
        look_tpl = look_meta["en"]
        look_extra_tpl = look_meta["en_extra"]
        outfit_tpl = outfit_meta["en"]
        prop_tpl = prop_meta["en"]
        traits_sep = ", "
        traits_label = "traits: "
        blocks = []
        for subject_no, rows in (cast_spec or []):
            look_slots = []
            look_extra_slots = []
            outfit_slots = []
            prop_slots = []
            trait_descs = []
            for row in rows or []:
                slot, usage, desc = row[0], row[1], row[2]
                if usage == "subject_look":
                    look_slots.append(slot)
                elif usage == "subject_outfit":
                    outfit_slots.append(slot)
                elif usage == "subject_prop":
                    prop_slots.append(slot)
                else:
                    # 白名单外 usage 行不产句不进任何 {LIST}, 也不进特征
                    continue
                if desc:
                    trait_descs.append(desc)
            if not look_slots:
                # 无 look 行 → 整块跳过不产句
                continue
            first = look_slots[0]
            look_sentence = look_tpl.replace("{N}", str(first)).replace("{S}", str(subject_no))
            if look_extra_slots := look_slots[1:]:
                extra_tags = ["<Picture %s>" % s for s in look_extra_slots]
                look_sentence = look_sentence + ", " + look_extra_tpl.replace(
                    "{LIST}", list_sep.join(extra_tags))
            parts = [look_sentence]
            if outfit_slots:
                outfit_tags = ["<Picture %s>" % s for s in outfit_slots]
                parts.append(outfit_tpl.replace("{LIST}", list_sep.join(outfit_tags)))
            if prop_slots:
                prop_tags = ["<Picture %s>" % s for s in prop_slots]
                parts.append(prop_tpl.replace("{LIST}", list_sep.join(prop_tags)))
            if trait_descs:
                parts[0] = parts[0] + "; " + traits_label + traits_sep.join(trait_descs)
            blocks.append(", ".join(parts))
        return blocks
    # zh: H3 交替式 — 单一实现 (与 _compose_subject_line 并轨)
    blocks = []
    for subject_no, rows in (cast_spec or []):
        line = _build_h3_subject_line(subject_no, rows, lang=lang)
        if line is not None:
            blocks.append(line)
    return blocks


# V1.4 T4: 提示词规则检查 — 数据驱动的规则表 + 阈值字典(加规则=加条目, 不改骨架)
# 规则签名: (row, pool, pool_usage, global_prompt, cmode, pic9_present, ctx)
#   ctx = {"errs": [...], "warns": [...], "combined": str, "full_text": str, "blocks": list}
# 规则修改 ctx["errs"] / ctx["warns"]; 异常被主函数兜底不阻断其他规则。
# 批 H 形态: "Subject 1 是..." 绑定块; 批I I-⑤ 形态: "<Subject 1>: ..." 注入行。
# 批J: 豁免正则补新形态 — 此前只认"是/is", <Subject N>: 行内的 <Picture> 标签被
#   _rule_double_anchor 误计为双帧锚 → 用户真机预检误拦。
_SUBJECT_DEF_RE = re.compile(
    r"(?:<\s*)?[Ss]ubject\s*\d+\s*(?:>\s*[:：]\s*|[:：]\s*|是|is\b|=)"
)  # 批B B2: 放宽官方变体 — 小写 subject / 冒号前后空格 / 等号 Subject N = Picture N ... 形态
  # (1.8提示词.md Ref2VA 拆解表);
  # 严格命中范围仍覆盖批 H `<Subject N>:` / 旧教科书写法 `Subject N 是/ is`
  # 不触 _SUBJECT_PRESENCE_RE (dedup 独立正则 :1205) — 仍只识别严格 `<Subject N>:` 形态
RULE_THRESHOLDS = {
    "scene_min_chars": 10,        # scene 用途存在 + combined 剔除标签后低于此值 → 黄条
    "pose_min_chars": 8,          # pose 用途存在 + row.prompt 剔除标签后低于此值 → 黄条
    "look_min_global_chars": 6,   # subject_look 用途存在 + global 剔除标签后低于此值 → 黄条
}

# V1.6 T1: 行首时间段; 全角连字符/波浪/至/中文秒兼容; 冒号不参与匹配
_TIME_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*[-－~～至]\s*(\d+(?:\.\d+)?)\s*[sS秒]", re.M)
_TIMELINE_TOLER_OVERLAP = 0.001   # 重叠判定容差: prev_end > next_start + 容差
_TIMELINE_TOLER_BLANK = 1.0       # 留白阈值: 时长内空隙 > 此值 → 警告
_TIMELINE_PREFIX = "[时间轴] "    # errs/warns 前缀, 前端按此前缀加"忽略"按钮


def parse_timeline(text):
    """解析 text 内全部行首时间段; 返回 [(start, end, 行号), ...]; 无 → []"""
    if not text:
        return []
    out = []
    for m in _TIME_RE.finditer(text):
        s = float(m.group(1))
        e = float(m.group(2))
        line = text.count("\n", 0, m.start()) + 1  # 1-based
        out.append((s, e, line))
    return out


def check_timeline(row):
    """分镜行时间段三规则: ①重叠 errs ②超时 errs ③留白 warns;
    无时间轴 → ([], []) 零打扰; 段落时长非数字/缺键 → 跳过②③."""
    row = row or {}
    items = parse_timeline(row.get("prompt") or "")
    if not items:
        return [], []
    items = sorted(items, key=lambda x: (x[0], x[2]))
    errs = []
    # 规则① 重叠
    for i in range(1, len(items)):
        prev_e = items[i - 1][1]
        s, e, line = items[i]
        if prev_e > s + _TIMELINE_TOLER_OVERLAP:
            errs.append("%s第 %d 段 %s-%ss 与前段重叠, 请改起点"
                        % (_TIMELINE_PREFIX, line, _fmt_num(s), _fmt_num(e)))
    # 段落时长口径: 数字用之; 空 → 5s 默认; 非数字/缺键 → 跳过 ②③
    dur_raw = row.get("段落时长", None)
    skip_dur = True
    dur = None
    if dur_raw is not None:
        s = str(dur_raw).strip()
        if s == "":
            dur = 5.0; skip_dur = False
        else:
            try:
                dur = float(s); skip_dur = False
            except ValueError:
                pass
    warns = []
    if not skip_dur:
        last_end = max(e for _, e, _ in items)
        first_start = min(s for s, _, _ in items)
        # 规则② 超时: 末时间点 > 时长值
        if last_end > dur:
            errs.append("%s末时间点 %ss 超时 (段落时长 %ss), 请调整"
                        % (_TIMELINE_PREFIX, _fmt_num(last_end), _fmt_num(dur)))
        # 规则③ 留白: 起点前留白 (0 → 首段起点) + 段间空隙 + 末段后留白
        if first_start > _TIMELINE_TOLER_BLANK:
            warns.append("%s起点前留白 %ss, 请从 0 起或注明片头黑场"
                         % (_TIMELINE_PREFIX, _fmt_num(first_start)))
        gap_start = items[0][1]
        for i in range(1, len(items)):
            prev_e = items[i - 1][1]
            s, e, _ = items[i]
            if prev_e > s:  # 重叠吞掉间隙
                gap_start = max(gap_start, prev_e); continue
            gap = s - gap_start
            if gap > _TIMELINE_TOLER_BLANK:
                warns.append("%s段间留白 %ss, 请缩短或补段"
                             % (_TIMELINE_PREFIX, _fmt_num(gap)))
            gap_start = e
        tail_gap = dur - gap_start
        if tail_gap > _TIMELINE_TOLER_BLANK:
            warns.append("%s段后留白 %ss, 请补段或缩短时长"
                         % (_TIMELINE_PREFIX, _fmt_num(tail_gap)))
    return errs, warns


def _fmt_num(x):
    """数字格式: 整数显 0 / 小数保精度; 与契约文案风格一致"""
    return "%d" % int(x) if x == int(x) else "%g" % x


def _any_usage(pool_usage, uid):
    """pool_usage 三 kind 任一 value (list[str]) 含 uid → True (用于判断某用途是否标注)"""
    for slots in pool_usage.values():
        if isinstance(slots, dict):
            for v in slots.values():
                if uid in v:
                    return True
    return False


def _rule_double_anchor(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """ERR 级(1 条): 双帧锚点。
    计数单一真相源 = combined + enrich_blocks 产出; 行匹配 Subject 定义的内嵌标签不计;
    只计 Picture(Video/Audio 不占帧锚点语义); combined 含'转场' → 放行。
    V1.7 R12: 同一张图多用途引用按图去重(同槽号算一个帧参考;两个不同槽的 Picture 标签同时锚定才拦)。
    批B B1: cmode=='ref2v'(工作流接线判族, 拼接/分镜统一口径 batch_core.py:3349-3374) → 放行
    (ref2v 模板族多 Picture 引用是合法语义, 长相图+服装图等多锚并行属于正常用法);
    非 ref2v (i2v/fl2v/t2v) 维持原拦截与文案。cmode=None (模板文件缺, 旧解析路径) → 维持拦截。"""
    if cmode == "ref2v":
        return
    combined = ctx.get("combined") or ""
    if "转场" in combined:
        return
    anchor_strs = []
    seen_idx = set()
    for line in (ctx.get("full_text") or "").splitlines():
        if _SUBJECT_DEF_RE.search(line):
            continue
        # V1.7 R14: block=="ref" 的引擎代写句行整体豁免 (如 "人物姿势以<Picture 2>为准")
        # anchor 句 (first_frame) / P9 注入句 (P9_ANCHOR_SENTENCE_*) / 手写标签不被匹配, 真帧锚定语义保持拦截
        if any(p.fullmatch(line.strip()) for p in _REF_LINE_RES):
            continue
        for m in TAG_RE.finditer(line):
            if m.group("kind").lower() == "picture":
                idx = m.group("idx")
                if idx in seen_idx:
                    continue
                seen_idx.add(idx)
                anchor_strs.append(m.group(0))
    if len(anchor_strs) >= 2:
        a, b = anchor_strs[0], anchor_strs[1]
        ctx["errs"].append(
            "分镜同时锚定两个帧参考(%s, %s): 保留一个帧锚点或将另一处藏进 Subject 定义行; "
            "有意转场请在文本写明'转场'" % (a, b))


def _rule_usage_in_nonref2v(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级(1 条): 用途标注 × cmode != 'ref2v' → 模板族不接参考槽, N 处不生效"""
    if cmode == "ref2v":
        return
    n = 0
    for slots in pool_usage.values():
        if isinstance(slots, dict):
            for v in slots.values():
                n += len(v)
    if n > 0:
        ctx["warns"].append("该模板族不接参考槽, %d 处用途标注不生效" % n)


def _rule_scene_short(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级(2 条): scene 用途 + combined 剔除标签后字符数 < 阈值 → 建议补场景文字"""
    if not _any_usage(pool_usage, "scene"):
        return
    text = TAG_RE.sub("", ctx.get("combined") or "")
    threshold = RULE_THRESHOLDS["scene_min_chars"]
    if len(text) < threshold:
        ctx["warns"].append(
            "场景用途已标注, 但分镜与全局合计文字仅 %d 字(少于建议的 %d 字): 请补充场景描述文字"
            % (len(text), threshold))


def _rule_pose_short(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级(3 条): pose 用途 + row.prompt 剔除标签后字符数 < 阈值 → 建议补姿态"""
    if not _any_usage(pool_usage, "pose"):
        return
    text = TAG_RE.sub("", row.get("prompt") or "")
    threshold = RULE_THRESHOLDS["pose_min_chars"]
    if len(text) < threshold:
        ctx["warns"].append(
            "姿态用途已标注, 但分镜行仅 %d 字(少于建议的 %d 字): 请在分镜行补充姿态动作"
            % (len(text), threshold))


def _rule_look_short_global(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级(4 条): subject_look 用途 + global_prompt 剔除标签后字符数 < 阈值 → 建议补外貌"""
    if not _any_usage(pool_usage, "subject_look"):
        return
    text = TAG_RE.sub("", g or "")
    threshold = RULE_THRESHOLDS["look_min_global_chars"]
    if len(text) < threshold:
        ctx["warns"].append(
            "外貌用途已标注, 但全局提示词仅 %d 字(少于建议的 %d 字): 请在全局补充外貌特征"
            % (len(text), threshold))


_SHOT_MARKER_RE = re.compile(r"\[\s*Shot\s*(\d+)\s*\]", re.IGNORECASE)


def _rule_shot_marker_missing(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级(批B B3): 单行解析出 ≥2 时间段, 而行文本缺对应 [Shot 2..M] 标记
    → 一条黄条列缺失序号 + 补救指引 (补 [Shot N] 标记或拆行)。
    谓词 (写死):
      ① parse_timeline(row.prompt) ≥ 2 段
      ② 扫描 row.prompt 已有 [Shot N] 标记; 计算 missing = sorted({2..M} - present)
      ③ missing 非空 → ctx.warns 1 条; 否则静默。
    出口走 warns 通道, 与现有 "[时间轴]" / 阈值类同级; 不产生 errs 不拦截。"""
    text = row.get("prompt") or ""
    items = parse_timeline(text)
    if len(items) < 2:
        return
    m_total = len(items)
    expected = set(range(2, m_total + 1))
    present = set()
    for tm in _SHOT_MARKER_RE.finditer(text):
        try:
            present.add(int(tm.group(1)))
        except (TypeError, ValueError):
            pass
    missing = sorted(expected - present)
    if not missing:
        return
    listed = ", ".join("[Shot %d]" % n for n in missing)
    ctx["warns"].append(
        "本行解析出 %d 段时间段, 缺 [Shot N] 标记: %s; 补救: 在对应时间段前后补写 [Shot N] 标记, 或拆为多个分镜行"
        % (m_total, listed))


# 批B B4: 六字段 (仅 zh + ref2v) overall_soundscape 缺值检测 — 每行产一条前缀稳定的 WARN,
# 由引擎 _preflight_loop / 端点路径聚合为一条黄条列出涉及分镜号。
# 行级判定信号: row.prompt 文本含官方/兼容字段写法 (overall_soundscape: / 氛围声: / 环境音: /
# sound:), OR 全局 audio_global 已含 氛围声/声音/sound 键 → 行级声场补足。
# 触发面门闸: ctx.cast_spec 非 None (六字段 use_six_field 真正开) — 否则行不走六字段, 不飘黄。
# 与负面三拆 (关音乐 → non_diegetic_music: N/A) 零交互: 关音乐只重写 music 字段, 不影响 sound 判空。
# B-I 修复 (N2): 补官方 shot_vocab `_MARKER_SOUND` 中的 zh 标签 `声音:` 到行级备选, 与全局键集合对齐.
# 空值档修补 (规格"overall_soundscape 为空/缺失都报"):
#   - 官方头 `overall_soundscape:` 存在 → body 必须有非空值; 空即视为空值 (报).
#   - 兼容头 (氛围声/声音/环境音/sound) 设计如此 → 兼容头存在即静默, 不论值空.
_SOUNDSCAPE_FIELD_RE = re.compile(
    r"(?:^|\n)\s*(?:overall_soundscape|氛围声|声音|环境音|sound)\s*[:：]",
    re.IGNORECASE | re.MULTILINE,
)
# 官方头 (含空值): 校验 body 是否非空; 空值仍报黄.
# 重要: `\s*` 在行末会吞掉换行 → 用 `[ \t]*` 只匹配空格/制表符, 强制 [^\n]* 锚定到行内.
_SOUNDSCAPE_OFFICIAL_HEADER_LINE_RE = re.compile(
    r"(?:^|\n)\s*overall_soundscape[ \t]*[:：][ \t]*([^\n]*)",
    re.IGNORECASE,
)
_SOUNDSCAPE_WARN_PREFIX = "[声场空]"  # 聚合键前缀, 引擎 _preflight_loop 据此前缀聚合
# 全局 audio_blocks 中"算氛围声补足"的键集合 (与 _AUDIO_OFFICIAL_FIELDS / shot_vocab `_MARKER_SOUND` `_MARKER_MUSIC` 中文标签对齐)
_SOUNDSCAPE_GLOBAL_KEYS = frozenset({"氛围声", "声音", "sound", "Sound"})


def _rule_soundscape_empty_zh(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级 (B4): 仅 zh 路径 + ref2v + use_six_field 真开 (ctx.cast_spec 非 None) 触发。
    判定 (N1/N2/空值档合并):
      1. 行 prompt 含官方头 `overall_soundscape:` (B-I N2) → 校验 body 非空; 空 = 报黄 (空值档).
         非空 = 静默 (有值)。
      2. 行 prompt 含兼容头 (氛围声/声音/环境音/sound, B-I N2 补 声音) → 兼容头设计如此,
         存在即视为行级声场已声明 (含空值也静默, 不强求兼容头填值)。
      3. 行 prompt 完全无声字段名 → 触发"行级缺声场"判定。
      4. R2 必修: 全局 audio_global 已含 氛围声/声音/sound 键且值非空 → 行级缺声场也视为补足, 静默。
      5. R3 必修: ctx.cast_spec is None → 整段静默 (六字段 use_six_field 没开)。
    与负面三拆零交互: 关音乐只动 non_diegetic_music 字段, 本规则只盯 sound 字段判空。
    触发产 ws 前缀 warn, 由预检层按前缀聚合为一条黄条 (B4 聚合口径: 每批聚合一条)。
    引擎 _preflight_loop 与端点路径同源, 共用 _soundscape_warn_template + aggregate_soundscape_warns。"""
    if lang != "zh" or cmode != "ref2v":
        return
    if ctx.get("cast_spec") is None:
        return
    text = row.get("prompt") or ""
    # 1. 官方头 → body 非空即静默; 空值视作"写头不写值", 仍报黄
    off_match = _SOUNDSCAPE_OFFICIAL_HEADER_LINE_RE.search(text)
    if off_match:
        body = (off_match.group(1) or "").strip()
        if body:
            return  # 官方头有值, 行级声场已声明
        # 官方头空值 → 视作"为空/缺失", 飘黄 (其他兼容头即使存在也不能代替)
        # (继续向下走, 不 return)
    else:
        # 2. 兼容头 (氛围声/声音/环境音/sound) → 存在即视为行级声明, 静默
        if _SOUNDSCAPE_FIELD_RE.search(text):
            return
    # 3/4. 行级完全无声明 → 查全局 audio_global 补足
    audio_global = ctx.get("audio_global") or []
    if isinstance(audio_global, (list, tuple)):
        for kv in audio_global:
            if isinstance(kv, (list, tuple)) and len(kv) == 2 and kv[0] in _SOUNDSCAPE_GLOBAL_KEYS:
                v = kv[1]
                if isinstance(v, str) and v.strip():
                    return  # 全局氛围声已补足, 行级无需提示
    ctx["warns"].append(_soundscape_warn_template())


def _soundscape_warn_template():
    """B4 单条 per-row 提示文案: 行级 overall_soundscape 字段缺值。
    官方文案用"几乎无声背景"原词 (与批 A 后小迭代 zh 六字段音字段名对齐)。"""
    return ("%s本行 zh 六字段渲染时 overall_soundscape 将为空, 几乎无声背景; "
            "补救: 在六字段 overall_soundscape: 行补写场景音描述 (雨声/虫鸣/城市底噪等), "
            "或在分镜行加 overall_soundscape: <描述> 字段") % _SOUNDSCAPE_WARN_PREFIX


def _soundscape_aggregate_template(rid_list, n_total):
    """B4 聚合条文案: 每批一条黄条, 列出涉及分镜号 + 总数。
    与 per-row 文案保持同口径, 引官方"几乎无声背景"原词。
    n_total = 涉及分镜号数 (B-I N1 修复后, 计数 = rid 数, 而非 matched_idx 数;
    引擎内联用 placeholder 单条喂聚合器的口径下, n_total 必须 = len(shot_ids) 才能保证
    "(合计 N 镜)" 与列出的 rid 数同源)."""
    return ("%s 本批 %s 行 zh 六字段渲染时 overall_soundscape 将为空, 几乎无声背景; "
            "补救: 在六字段 overall_soundscape: 行补写场景音描述 (雨声/虫鸣/城市底噪等), "
            "或在分镜行加 overall_soundscape: <描述> 字段") % (_SOUNDSCAPE_WARN_PREFIX, rid_list)


def aggregate_soundscape_warns(warns, shot_ids=None):
    """B4 聚合器 (B-I 修复 · 单一文案源): 把 per-row `[声场空]...` 折叠为单条黄条列出涉及分镜号。
    文案统一走 _soundscape_aggregate_template (引擎层 + 端点层 + 单元测试同源)。
    输入 warns 列表 (允许混合其他类别), shot_ids 为本批涉及的 rid 列表 (按调用方记账)。
    输出 (new_warns, aggregated_msg): aggregated_msg 为 None 表示无聚合信号, 调用方无需追加。
    计数 (B-I N1 修复): `n = max(len(matched_idx), len(shot_ids))` — 引擎层每行 per-row 信号已收集
    进 matched_idx, 端点层 per-row + shot_ids=[rid] 平行, 两者同源不应错位; 但兜底用 max
    防单边传漏."""
    matched_idx = []
    rest = []
    for w in warns:
        if isinstance(w, str) and w.startswith(_SOUNDSCAPE_WARN_PREFIX):
            matched_idx.append(w)
        else:
            rest.append(w)
    if not matched_idx:
        return warns, None
    rids = sorted(set(shot_ids or []), key=lambda r: (len(r), r))
    n = max(len(matched_idx), len(rids)) if rids else len(matched_idx)
    if not rids:
        rid_list = "%d 行" % n
    else:
        first5 = rids[:5]
        rid_list = ", ".join(first5)
        if len(rids) > 5:
            rid_list += " 等 (合计 %d 镜)" % n
        else:
            rid_list = "%s (合计 %d 镜)" % (rid_list, n)
    aggregated = _soundscape_aggregate_template(rid_list, n)
    return rest + [aggregated], aggregated


# ===== 1.13e A 件: 官方 6 条硬参数检查 (全部 WARN 黄条, 零阻断) =====
# 官方硬参数 (锁定): 跨类槽位合计 / 视频+音频时长合计 / 单视频时长 / 图片尺寸与宽高比
POOL_MAX_FILES = 12
POOL_MAX_TOTAL_SEC = 15.0
VIDEO_SEG_MIN_SEC = 2.0
VIDEO_SEG_MAX_SEC = 15.0
IMAGE_SIDE_MIN_PX = 256
IMAGE_SIDE_MAX_PX = 5760
IMAGE_RATIO_MIN = 0.4
IMAGE_RATIO_MAX = 2.5

# 探测缓存: {(绝对路径, mtime): {"video"|"audio"|"image": 结果}} — 单请求内与逐行并发
# 预览间共享 (10 行同池只探测一次); 失败不入缓存 (瞬时失败下次重试)。
_MEDIA_PROBE_CACHE = {}


def _probe_media(kind, path):
    """单文件探测: video→probe_segment / audio→probe_audio_duration / image→PIL 尺寸。
    任何失败返 None (调用方跳过该文件对应检查)。"""
    try:
        if kind == "video":
            return join_engine.probe_segment(path)
        if kind == "audio":
            return join_engine.probe_audio_duration(path)
        from PIL import Image  # 惰性导入 (异常全吞), 只读头不加载像素
        im = Image.open(path)
        try:
            return im.size
        finally:
            im.close()
    except Exception:
        return None


def _cached_probe(kind, path):
    """带 (路径, mtime) 缓存的探测: 命中直接返回; 成功才写缓存, 失败返 None 不写。"""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    key = (os.path.abspath(path), mtime)
    entry = _MEDIA_PROBE_CACHE.get(key)
    if isinstance(entry, dict) and kind in entry:
        return entry[kind]
    val = _probe_media(kind, path)
    if val is None:
        return None
    if not isinstance(entry, dict):
        entry = {}
        _MEDIA_PROBE_CACHE[key] = entry
    entry[kind] = val
    return val


def _slot_sort_key(kv):
    """槽号键排序 (int 键自然序, 混入非数字键时不抛)。"""
    try:
        return (0, int(kv[0]), "")
    except (TypeError, ValueError):
        return (1, 0, str(kv[0]))


def _f_n2_keep_set(shot_text, cast_spec=None, keep_slots=None, bindings=None):
    """F-N2 keep 集 (四类) — 逐镜过滤与批 K 段级 12 槽计数共用单源。

    ① shot_text (global_prompt + row prompt) 中 <Picture|Video|Audio N> TAG 命中
    ② 全批绑定卡槽全集 (不经场景过滤; 档 3 cast_spec=None 但副本须保卡槽)
    ③ cast_spec 中在场卡槽 (Picture only; 与 ② 等价于"在场卡槽", 双保险)
    ④ 调用方显式传入的槽 — scene/道具卡虚拟槽 (int = Picture 槽) 与段级 seg_pools
       槽 ((kind, slot) 元组)。两类都恒保留, 不经 F-N2 剔除 (契约 #12)。
    返回 set[(kind, slot)]; kind 恒为 Picture/Video/Audio 标题式。
    """
    keep = set()
    for m in TAG_RE.finditer(shot_text or ""):
        keep.add((m.group("kind").title(), int(m.group("idx"))))
    for b in (bindings or []):
        if not (isinstance(b, dict) and isinstance(b.get("name"), str) and b["name"]):
            continue
        for s in (b.get("slots") or []):
            if isinstance(s, dict) and isinstance(s.get("idx"), int):
                keep.add(("Picture", s["idx"]))
    if cast_spec:
        for _, rows in cast_spec:
            for row in (rows or []):
                slot = row[0]
                if isinstance(slot, int):
                    keep.add(("Picture", slot))
    for slot in (keep_slots or ()):
        if (isinstance(slot, tuple) and len(slot) == 2
                and slot[0] in ("Picture", "Video", "Audio")
                and isinstance(slot[1], int)):
            keep.add((slot[0], slot[1]))
        elif isinstance(slot, int):
            keep.add(("Picture", slot))
    return keep


def _check_seg_pool_limits(rows, seg_pools, global_prompt, pool_usage,
                           bindings=None, ctx=None):
    """批 K: 12 槽黄条**按段重算** → 黄条列表, 永不抛出 (全 WARN 零阻断)。

    每段计数 = (全局池中被该段 keep 的槽数) + (该段 seg_pools 槽数); > POOL_MAX_FILES
    → 该段一条黄条。计数跨三类合计, 与批级检查 1 同阈值常量。
    keep 口径 = F-N2 四类 (与 _filter_unreferenced_pool_usage 同源单源)。
    段 seg_pools 槽恒计入 (等同显式 keep, 不经 F-N2 剔除)。

    ctx = {行索引: {"cast_spec":..., "keep_slots":...}} — 引擎传 cast_plan.per_shot,
    预览端点单行传 {0: {...}}; 缺省 = 无 cast_spec / 无显式槽 (F-N2 ①②)。
    无 seg_pools → 恒空列表 (段级黄条是批级检查 1 之外的新增面, 二者可并存)。
    """
    warns = []
    if not seg_pools:
        return warns
    ctx = ctx or {}
    for i, row in enumerate(rows or []):
        if not isinstance(row, dict):
            continue
        entry = seg_pools.get(str(row.get("ID") or "").strip()) or {}
        seg_n = 0
        for kind in ("Picture", "Video", "Audio"):
            slots = entry.get(kind) if isinstance(entry, dict) else None
            if isinstance(slots, dict):
                seg_n += len([s for s, spec in slots.items()
                              if isinstance(spec, dict) and (spec.get("media") or "")])
        if seg_n <= 0:
            continue  # 该段无条目 → 沿用批级池现状, 不新增黄条
        c = ctx.get(i) or {}
        shot_text = (global_prompt or "") + "\n" + (row.get("prompt") or "")
        keep = _f_n2_keep_set(shot_text, c.get("cast_spec"),
                              c.get("keep_slots"), bindings)
        kept_n = sum(1 for kind in ("Picture", "Video", "Audio")
                     for slot in (pool_usage.get(kind) or {}) if (kind, slot) in keep)
        total = kept_n + seg_n
        if total > POOL_MAX_FILES:
            rid = str(row.get("ID") or "").strip() or ("第%d行" % (i + 1))
            warns.append("分镜 %s 参考文件总数 %d，官方上限 %d（含分镜级素材池）"
                         % (rid, total, POOL_MAX_FILES))
    return warns


def _check_pool_limits(pool, input_dir):
    """批级素材池官方硬参数检查 (检查 1/2/3/4/6) → 黄条列表, 永不抛出。

    容错铁则: 文件找不到 / 探测失败 → 跳过该文件对应检查, 逐文件捕获。
    调用方 (预览端点) 仅在 pool 非空时调用; 空池 / 无 workflow 键 = 行为零变。
    """
    warns = []
    try:
        pool = pool or {}
        pics = pool.get("Picture") or {}
        vids = pool.get("Video") or {}
        auds = pool.get("Audio") or {}
        base = input_dir or ""
        # 逐文件探测 (失败即跳过)
        v_dur = {}
        total_sec = 0.0
        v_has_audio = False
        for idx, fname in sorted(vids.items(), key=_slot_sort_key):
            p = os.path.join(base, fname)
            if not os.path.isfile(p):
                continue
            info = _cached_probe("video", p)
            if not isinstance(info, dict) or info.get("duration") is None:
                continue
            try:
                d = float(info["duration"])
            except (TypeError, ValueError):
                continue
            v_dur[idx] = d
            total_sec += d
            if info.get("has_audio"):
                v_has_audio = True
        for idx, fname in sorted(auds.items(), key=_slot_sort_key):
            p = os.path.join(base, fname)
            if not os.path.isfile(p):
                continue
            d = _cached_probe("audio", p)
            if d is None:
                continue
            try:
                total_sec += float(d)
            except (TypeError, ValueError):
                continue
        # 检查 1: 跨类槽位合计 > 官方上限
        total = len(pics) + len(vids) + len(auds)
        if total > POOL_MAX_FILES:
            warns.append("参考文件总数 %d，官方上限 %d（跨类合计）"
                         % (total, POOL_MAX_FILES))
        # 检查 2: 视频 + 音频时长合计 (图片不计时长)
        if total_sec > POOL_MAX_TOTAL_SEC:
            warns.append("参考视频与音频合计 %.1f 秒，官方上限 15 秒（图片不计时长）"
                         % total_sec)
        # 检查 3: 单视频出 [2, 15] 秒
        for idx, fname in sorted(vids.items(), key=_slot_sort_key):
            d = v_dur.get(idx)
            if d is None:
                continue
            if d < VIDEO_SEG_MIN_SEC or d > VIDEO_SEG_MAX_SEC:
                warns.append("参考视频「%s」时长 %.1f 秒，官方单段区间 2-15 秒"
                             % (fname, d))
        # 检查 4: 图片单边出 [256, 5760]px 或宽高比出 [0.4, 2.5]
        for idx, fname in sorted(pics.items(), key=_slot_sort_key):
            p = os.path.join(base, fname)
            if not os.path.isfile(p):
                continue
            size = _cached_probe("image", p)
            try:
                w, h = int(size[0]), int(size[1])
            except (TypeError, ValueError, IndexError):
                continue
            if not w or not h:
                continue
            ratio = float(w) / h
            if (w < IMAGE_SIDE_MIN_PX or w > IMAGE_SIDE_MAX_PX
                    or h < IMAGE_SIDE_MIN_PX or h > IMAGE_SIDE_MAX_PX
                    or ratio < IMAGE_RATIO_MIN or ratio > IMAGE_RATIO_MAX):
                warns.append("参考图片「%s」尺寸 %d×%d，宽高比 %.2f，"
                             "官方区间 256-5760 像素、宽高比 0.4-2.5"
                             % (fname, w, h, ratio))
        # 检查 6: 存在带音轨视频 且 Audio 池非空 (无音轨视频无物理压制前提, 不提示)
        if v_has_audio and auds:
            warns.append("参考视频自带音轨可能压过音频参考（官方 8 次实测）；"
                         "若音频参考是配音请注意成片听感")
    except Exception:
        pass
    return warns


# 检查 5 折算口径: 等效词数 = 英文词数 (空白分词) + 汉字数 × 0.7 (常量可调)
BODY_WORD_MIN = 350
BODY_HAN_WEIGHT = 0.7
_HAN_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")
_EN_WORD_RE = re.compile(r"[A-Za-z]+")


def _row_has_dialogue(text, bindings, lang="zh"):
    """对白四形态判定 (与引擎对白转换同口径, 复用 prompt_assembler 原语):
    手写 <d> / L1 引号对 / L2 冒号 / L2'(绑定名冒号) / L3 裸动词 — 任一命中即豁免。"""
    if not text:
        return False
    from prompt_assembler import convert_dialogue, _line_has_dialogue_tag
    for line in text.split("\n"):
        if _line_has_dialogue_tag(line):
            return True
    new_text, events = convert_dialogue(text, bindings=bindings or [], lang=lang)
    if new_text != text:
        return True
    return any(ev[0] == "bare_verb" for ev in events)


def _rule_body_words(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh"):
    """WARN 级 (1.13e 检查 5): 正文等效词数 < 350 且该行无对白 → 提示官方 350-500 词口径。

    计数文本 = row 原文描述字段 (prompt 列, 不含全局拼接与词库扩充); 对白四形态经
    convert_dialogue 同口径判定, 命中即豁免 (台词密集场景官方明示豁免)。"""
    text = row.get("prompt") or ""
    if _row_has_dialogue(text, ctx.get("bindings"), lang):
        return
    words = (len(_EN_WORD_RE.findall(text))
             + len(_HAN_CHAR_RE.findall(text)) * BODY_HAN_WEIGHT)
    if words < BODY_WORD_MIN:
        ctx["warns"].append(
            "正文约 %d 词（英文按词/中文按字×0.7 折算），官方建议 350-500 词"
            "（生成任务口径；台词密集场景官方明示豁免）" % int(words))


# 规则表(数据驱动: 加规则=在末尾 append 一个签名为 (row, pool, pool_usage, g, cmode, pic9_present, ctx, lang="zh") 的 callable)
PROMPT_RULES = [
    _rule_double_anchor,
    _rule_usage_in_nonref2v,
    _rule_scene_short,
    _rule_pose_short,
    _rule_look_short_global,
    _rule_shot_marker_missing,
    _rule_soundscape_empty_zh,
    _rule_body_words,
]


def check_prompt_rules(row, pool, pool_usage, global_prompt, cmode, pic9_present=False,
                      audio_global=None, lang="zh", cast_spec=None, bindings=None):
    """V1.4 T4: 提示词规则检查(preflight 双时机统一入口)
    复用 enrich_blocks 拿到实际会发送的代写块(单一真相源),
    按 PROMPT_RULES 顺序逐条执行, 异常规则被兜底不阻断其他规则。
    返回 (errs, warns): errs 用于拦截; warns 仅黄条(用户工程要求"拿不准进警告")。
    T2: audio_global 非空 + 行 prompt 含音频标签(中英两语)→ warns 一条"行内音频标签与全局配乐并存, 请确认"。
    1.13e: bindings 透传 ctx — _rule_body_words 据此判 L2'(绑定名冒号)对白豁免。"""
    row = row or {}
    pool = pool or {}
    pool_usage = pool_usage or {}
    g = global_prompt or ""
    combined = g + "\n" + (row.get("prompt") or "")
    blocks = enrich_blocks(pool_usage, combined, cmode, pic9_present)
    full_text = combined + "\n" + "\n".join(blocks)
    ctx = {"errs": [], "warns": [], "combined": combined, "full_text": full_text,
           "blocks": blocks,
           # B-I 修复: ctx 携带 cast_spec / audio_global — _rule_soundscape_empty_zh 据此判定
           # use_six_field 门是否真开 + 全局氛围声是否已补足 (R2 / R3 必修)
           "cast_spec": cast_spec,
           "audio_global": audio_global,
           "bindings": bindings or []}
    for rule in PROMPT_RULES:
        try:
            rule(row, pool, pool_usage, g, cmode, pic9_present, ctx, lang=lang)
        except Exception as ex:
            print("[H3Batch] 规则 %s 异常: %s"
                  % (getattr(rule, "__name__", repr(rule)), ex), flush=True)
    # V1.6 T1: 时间轴冲突检查 (重叠/超时/留白) — errs/warns 已带 "[时间轴] " 前缀
    tl_errs, tl_warns = check_timeline(row)
    ctx["errs"].extend(tl_errs)
    ctx["warns"].extend(tl_warns)
    # T2: 静默矛盾检测 — audio_global 非空 + 行内已有音频标签(中英)→ 黄条提醒
    if audio_global:
        for ln in (row.get("prompt") or "").splitlines():
            if (_MARKER_SOUND.match(ln) or _MARKER_MUSIC.match(ln)
                    or _MARKER_SOUND_EN.match(ln) or _MARKER_MUSIC_EN.match(ln)):
                ctx["warns"].append("行内音频标签与全局配乐并存, 请确认")
                break
    return ctx["errs"], ctx["warns"]


# 批 A 后小迭代: 三勾选语义常量 (逐字锁定)
NEGATIVE_SUFFIX_EN = "no narration, no voiceover, no subtitles, no text watermark, no music"
NEG_MUSIC_LINE_ZH = "non_diegetic_music: N/A"
NEG_MUSIC_VALUE_ZH = "N/A"
NEG_DIALOGUE_ZH = "人物全程不张嘴、不说话，无旁白。"
NEG_TEXT_ZH = "无字幕，无文字水印。"
_NEG_ITEMS_EN = ["no narration", "no voiceover", "no subtitles", "no text watermark", "no music"]


def merged_prompt(row, global_prompt, lang="zh", extra_blocks=None, negative=False,
                   audio_blocks=None, warn_sink=None,
                   negative_music=False, negative_dialogue=False, negative_text=False):
    # 2.6: 服务端预览与引擎共用的最终拼装单一真相源(分项行=编译块空行接全局/手写行=v1 逗号/仅全局/空=不写)
    # 2.9: 加可选 lang 参数("zh"/"en"); 透传给 assemble_prompt
    # V1.4 T3: 加 extra_blocks; None/[] → 行为与 V1.3 逐字节一致; 非空 → 统一 "\n\n" 形态
    # Task 1: negative=False (缺省) → 行为与 V1.4 逐字节一致; negative=True → 条目级去重
    #   (查重范围仅 global_prompt, 分镜行 prompt 内含默认项不去重 S7) 后, 在最终字符串末尾独立一行追加
    # 批 A 节点 3 (A4): 全局音频段(配乐/氛围声) 改走官方字段 overall_soundscape/non_diegetic_music,
    #   与行级 shot_vocab 产出合并; 不再以裸 '配乐: '/ '氛围声: ' 中文标签追加 (旧机制被取代)
    text = assemble_prompt(row, lang=lang)
    blocks = list(extra_blocks) if extra_blocks else []
    if not blocks:
        compiled = any(str(row.get(f, "") or "").strip() for f in STRUCT_FIELDS)
        if global_prompt and compiled and text:
            base = global_prompt + "\n\n" + text
        elif global_prompt and text:
            base = global_prompt + ", " + text
        elif global_prompt:
            base = global_prompt
        else:
            base = text
    else:
        # blocks 非空: 统一 "\n\n" 形态
        parts = []
        if global_prompt:
            parts.append(global_prompt)
        parts.extend(blocks)
        if text:
            parts.append(text)
        base = "\n\n".join(parts)
    # 批 A 后小迭代: 三勾选 (旧 negative 入口兼容: 三键全 False 且 negative=True → 三键全 True)
    # 提前到此 — 关音乐判定需在 audio_blocks 合并前就位
    neg_m = bool(negative_music)
    neg_d = bool(negative_dialogue)
    neg_t = bool(negative_text)
    if negative and not neg_m and not neg_d and not neg_t:
        neg_m = neg_d = neg_t = True
    # 批 A 节点 3 (A4): 全局音频段 → 合并进官方字段 overall_soundscape / non_diegetic_music
    # 行级 audio (由 assemble_prompt/shot_vocab 产出) 已在 text 中以官方标签形式存在;
    # 全局 audio 仅在行级对应字段为空时入位; 不另起中文标签头、不重复标签头。
    # 批 A 后小迭代: zh 路径关音乐优先 — 仅跳过 配乐 (music) 合并, 氛围声 (sound) 仍照常入字段
    # en 路径维持现状语义 (任一勾选=整句 en; audio 行照样进字段)
    if audio_blocks:
        if neg_m and lang == "zh":
            filtered = [kv for kv in audio_blocks
                        if not (isinstance(kv, (list, tuple)) and len(kv) == 2
                                and kv[0] in ("配乐", "音乐", "music", "Music"))]
            if filtered:
                base = _merge_global_audio_into_official_fields(base, filtered, warn_sink=warn_sink)
        else:
            base = _merge_global_audio_into_official_fields(base, audio_blocks, warn_sink=warn_sink)
    # 关音乐时: 关音乐 + 全局 audio_blocks 配乐非空 → 黄条 (走批后端点 / 引擎 warn_sink 通道)
    # 仅 zh 路径触发 (en 路径下 audio 行照样进, 整句 en 维持)
    if neg_m and lang == "zh" and audio_blocks and warn_sink is not None:
        has_global_music = False
        neg_variants = _AUDIO_NEG_VARIANTS
        for kv in audio_blocks:
            if isinstance(kv, (list, tuple)) and len(kv) == 2 and kv[0] in ("配乐", "音乐", "music", "Music"):
                v = kv[1]
                if isinstance(v, str) and v.strip() and v.strip() not in neg_variants:
                    has_global_music = True
                    break
        if has_global_music:
            warn_sink.append("[音频冲突][负面选项] 关音乐已勾选, 全局配乐描述被忽略")
    if not neg_m and not neg_d and not neg_t:
        return base
    # en 路径: 任一勾选 → 整句 NEGATIVE_SUFFIX_EN (维持旧 en 语义, en 三拆文案未定稿)
    if lang == "en":
        remaining = [it for it in _NEG_ITEMS_EN if it not in (global_prompt or "")]
        if not remaining:
            return base
        sentence = NEGATIVE_SUFFIX_EN if len(remaining) == len(_NEG_ITEMS_EN) else ", ".join(remaining)
        if base:
            return base + "\n" + sentence
        return sentence
    # zh 路径: 三勾选各自注入 (按 music → dialogue → text 调用顺序)
    extras = []
    if neg_m:
        extras.append(NEG_MUSIC_LINE_ZH)
    if neg_d:
        extras.append(NEG_DIALOGUE_ZH)
    if neg_t:
        extras.append(NEG_TEXT_ZH)
    if not extras:
        return base
    if base:
        return base + "\n" + "\n".join(extras)
    return "\n".join(extras)


# ===== 批 A 节点 3 (A4): 全局音频段 → 官方字段合并 =====

_AUDIO_OFFICIAL_LABEL = {
    "配乐": "non_diegetic_music",
    "音乐": "non_diegetic_music",
    "music": "non_diegetic_music",
    "Music": "non_diegetic_music",
    "氛围声": "overall_soundscape",
    "声音": "overall_soundscape",
    "sound": "overall_soundscape",
    "Sound": "overall_soundscape",
}
_AUDIO_OFFICIAL_FIELDS = ("overall_soundscape:", "non_diegetic_music:")

# 行级否定语义变体集合 — 用于行级字段值为"无/静音"等场景时触发冲突告警。
# 节点 3 起步条目覆盖常见英文与单字 "无"/"none"/"no music" 等;
# 节点 3 补丁扩充: 中文常见变体 (无音乐/无配乐/没有音乐/没有配乐/静音/无声/无音效)
# 触发行级优先 + 黄条警告 (与原有 "无"/"无音乐"/"无声音"/"none"/"no music"/"no sound" 同档语义)。
_AUDIO_NEG_VARIANTS = frozenset({
    # zh — 节点 3 起步条目 (保留)
    "无", "无音乐", "无声音",
    # zh — 节点 3 补丁扩充条目
    "无配乐", "没有音乐", "没有配乐", "静音", "无声", "无音效",
    # en — 节点 3 起步条目 (保留)
    "none", "None", "no music", "no sound",
})


def _row_level_audio_value(base, official_label):
    """扫描 base 内官方字段行, 返回行级值 (去除字段头后); 不存在 → None.

    用于 '行级优先' 判定: 若行级已有该字段, 全局应被抑制 (除冲突情况外).
    """
    head = official_label + ":"
    idx = base.find("\n" + head)
    if idx < 0 and base.startswith(head):
        head_start = 0
    elif idx >= 0:
        head_start = idx + 1  # 跳过 \n
    else:
        return None
    # head_start 处即为 head; 找字段体终止位置 (下一官方字段头 / 段尾)
    body_start = head_start + len(head)
    end = len(base)
    for other in _AUDIO_OFFICIAL_FIELDS:
        if other == head:
            continue
        nxt = base.find("\n" + other, body_start)
        if nxt >= 0 and nxt < end:
            end = nxt
    body = base[body_start:end]
    return body.strip()


def _append_official_field(base, official_label, value):
    """在 base 末尾追加官方字段行 'official_label: value' (若 base 非空则前置 \\n)."""
    line = "%s %s" % (official_label + ":", value)
    if not base:
        return line
    return base + "\n" + line


def _merge_global_audio_into_official_fields(base, audio_blocks, warn_sink=None):
    """合并全局 配乐/氛围声 进官方字段; 行级 (已含官方字段) 优先, 全局被抑制 (不重复).

    冲突场景 (行级已含 '无' 类语义 + 全局非空) → 行级优先 + 黄条警告.

    参数:
      base        — 现有 base 文本 (含行级 shot_vocab 产出)
      audio_blocks — [(k, v), ...] 全局音频段
      warn_sink   — 可选 list; 检测到冲突时 append 一条黄条警告

    返回: 合并后的 base str
    """
    if not audio_blocks:
        return base
    out = base
    for kv in audio_blocks:
        if not (isinstance(kv, (list, tuple)) and len(kv) == 2):
            continue
        k, v = kv
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        v_stripped = v.strip()
        if not v_stripped:
            continue
        official = _AUDIO_OFFICIAL_LABEL.get(k)
        if official is None:
            continue  # 未知键: 静默忽略 (CSV 中文键 = 配乐/氛围声; 其他键不计)
        # 行级已含该官方字段 → 行级优先
        row_value = _row_level_audio_value(out, official)
        if row_value is not None:
            # 冲突场景: 行级 = "无"/"none"/"静音" 等否定语义 + 全局非空 → 黄条
            if row_value in _AUDIO_NEG_VARIANTS:
                if warn_sink is not None:
                    warn_sink.append(
                        "[音频冲突] 行级 %s 字段已声明 '%s', 全局 '%s' (%s) 被抑制"
                        % (official + ":", row_value, k, v_stripped))
            # 沉默抑制: 全局被丢弃, 文本不变
            continue
        # 行级无该字段 → 全局入位 (独立官方字段行)
        out = _append_official_field(out, official, v_stripped)
    return out


# 批 H1: 纯函数 — 名字替换。绑定表 (批H 角色绑定数组) 中的卡名 → "Subject N"
# 全词匹配: (?<![\w])name(?![\w]) (Python3 \w 含下划线与汉字)
# - "Subject N" 手写不动 (用户已手写即终值, 不再覆盖)
# - 损坏 binding (name 缺/非 str) 静默跳过, 不抛
# 词边界: 只防 ASCII 词字符续撞("测试1"不得命中"测试11"); 汉字邻接放行——
# "少女1和测试1"中的名字是连词/句子紧邻, 属合法引用(\w 在 Python str 模式含汉字, 会误杀中文邻接)
_CAST_WORD_BOUNDARY_RE_TEMPLATE = r"(?<![0-9A-Za-z_])%s(?![0-9A-Za-z_])"


def replace_cast_names(text, bindings):
    """批 H1: 名字替换纯函数 — text 中出现的每个绑定表 name → "Subject N"。
    全词匹配 (Python3 \\w 含下划线与汉字)。
    bindings = [{"name": str, "no": int, "slots": [...]}..]; 损坏 entry 静默跳过。
    Subject N (用户手写 Subject 数字) 永不替换 (手写即终值)。
    返回新字符串 (text 为空 → "")."""
    if not text or not bindings:
        return text or ""
    # 收集有效 (name, no) — 按 name 长度倒序排, 让更长的名字优先匹配 (防 "测试1" 撞 "测试")
    pairs = []
    for b in (bindings or []):
        if not isinstance(b, dict):
            continue
        name = b.get("name")
        no = b.get("no")
        if not isinstance(name, str) or not name or not isinstance(no, int):
            continue
        pairs.append((name, no))
    if not pairs:
        return text
    pairs.sort(key=lambda p: (-len(p[0]), p[0]))
    out = text
    for name, no in pairs:
        pattern = _CAST_WORD_BOUNDARY_RE_TEMPLATE % _re_escape(name)
        out = _re_sub(pattern, "Subject %d" % no, out)
    return out


def _re_escape(s):
    """re.escape 的内联封装 — 集中 re 引用便于测试隔离 (单元可 monkey-patch _re_sub)."""
    import re as _re
    return _re.escape(s)


def _re_sub(pattern, repl, string):
    import re as _re
    return _re.sub(pattern, repl, string)


# I-⑤: 合成 Subject 行 — 前端绑定面板/全局提示词注入用; 引擎防双份 / 逐镜过滤同源
# 批 A 节点 2: 与 cast_blocks 并轨为 H3 交替式 — 单一实现 (调用 _build_h3_subject_line)
# slots = [{idx, usage, desc}, ...] — 来自 binding slots 列表, 顺序 = 卡内行序
def _compose_subject_line(no, slots, lang="zh"):
    """合成单 Subject 的 H3 交替式行 (供前端绑定面板/全局提示词注入)。

    返回 "<Subject N>: 【外貌】...；【服装】...；【道具】...；【姿势】..."
    无 look 行 → 返回 "<Subject N>" (兜底形态, 不产段)。
    slots 中 idx 非 int 项静默跳过 (与 _build_h3_subject_line 内部桶分规则同源)。
    """
    rows = []
    for s in (slots or []):
        idx = s.get("idx")
        if not isinstance(idx, int):
            continue
        rows.append((idx, s.get("usage") or "", s.get("desc") or "", s.get("ignore_words") or ""))
    line = _build_h3_subject_line(no, rows, lang=lang)
    if line is None:
        return "<Subject %d>" % no
    return line


# I-⑤: 逐镜过滤 — 剔除不在场 Subject 行 (含其尾随空行)
# 行匹配 ^\s*<Subject (\d+)>: 且该编号不在 scene_nos 集 → 剔除该行及其紧邻的空行
# 批 A 节点 4 (4a): scene_nos 为空集 (∅ 或 None) → 全保留 Subject 行 + 黄条入 warn_sink
# (用户描述用代词省略卡名时, 在场检测检不到 Subject, 旧行为=全剔=裸奔;
#  改为全保留 + 黄条, 防模型绑崩/服装互换; 黄条含稳定标记 "在场过滤" 可 grep)
# 旧行为零变化: text 中无 <Subject 行时 → 透传 + 不发黄条 (无可保可剔不报警)
_SUBJECT_LINE_RE = re.compile(r"^\s*<Subject\s+(\d+)>:")


def _filter_global_subject_lines(text, scene_nos, warn_sink=None):
    if not text:
        return text or ""
    # 批 A 节点 4 (4a): 空集兜底反转 — scene_nos 为任意空容器或 None 时全保留 Subject 行,
    # 避免代词省略卡名描述时 Subject 定义被全删导致模型绑崩 (C 轮真机踩坑)
    # 顺手 1: 统一空容器判定 — list/tuple/set/frozenset/None 任何空形态都走"全保留 + 黄条"路径,
    # 防旧"空 list/tuple 走全剔"陷阱 (空 list 与空 set 语义分裂)
    scene_nos_eff = scene_nos
    empty_scene = (scene_nos is None
                   or (hasattr(scene_nos, "__len__") and len(scene_nos) == 0))
    if empty_scene:
        # 仅在 global 中实际存在 Subject 行时才报警 (无可保可剔 = 不报警)
        if _SUBJECT_LINE_RE.search(text) and warn_sink is not None:
            warn_sink.append(
                "[在场过滤] 未检测到任何在场 Subject (描述可能用代词省略卡名), "
                "已保留全部 Subject 定义行"
            )
        # 空集 → 不过滤, 原样透传 (含其尾随空行; 行为与"无 Subject 行"时一致)
        return text
    lines = text.split("\n")
    out = []
    skip_next_blank = False
    for line in lines:
        if skip_next_blank and line.strip() == "":
            skip_next_blank = False
            continue
        skip_next_blank = False
        m = _SUBJECT_LINE_RE.match(line)
        if m:
            try:
                no = int(m.group(1))
            except (TypeError, ValueError):
                out.append(line)
                continue
            if no not in scene_nos_eff:
                skip_next_blank = True  # 紧邻空行也剔除
                continue
        out.append(line)
    return "\n".join(out)


# I-⑤: 防双份 — global 已有 Subject N 行 → cast_spec 中 no=N 移除 (不再产 cast_blocks 块)
# 旧行为零变化: global 无 <Subject 行时 → cast_spec 透传
_SUBJECT_PRESENCE_RE = re.compile(r"<Subject\s+(\d+)>:")


def _check_global_anchor_dup(global_text, cast_spec, subject_anchors=None):
    """1.13f: 全局手写锚定 dedup 降级黄条 — 命中数 N>0 且有 cast_spec 且 subject_anchors 空。

    参数:
      global_text     — 扫描文本 (预览侧 = global_replaced, 已 Subject 行过滤;
                                 preflight 侧 = 作用域裸 g 解析后全局, 早于 _apply_global)
      cast_spec       — 本批 cast_spec 列表; 空/None = 无黄条
      subject_anchors — 用户入参覆盖文本; 非空 (strip 后) → 抑制黄条 (已豁免, 无降级)

    返回: 黄条列表 (0 或 1 条, 文案钉死).
    复用 _SUBJECT_PRESENCE_RE (ASCII 冒号 + 任意空白, 与 dedup 基线同口径).
    """
    if not global_text or not cast_spec:
        return []
    # subject_anchors 非空 (strip 后) → 已豁免, 抑制黄条
    if subject_anchors and (subject_anchors or "").strip():
        return []
    n = sum(1 for _ in _SUBJECT_PRESENCE_RE.finditer(global_text or ""))
    if n <= 0:
        return []
    return ["全局提示词含锚定行（%d 条）: 对应角色不再保证自动注入锚定（防重复）; "
            "建议移除全局手写锚定, 或在 GUI 锚定区编辑后提交（subject_anchors）" % n]


def _filter_cast_spec_for_dedup(cast_spec, global_text):
    if not cast_spec or not global_text:
        return cast_spec or []
    present = set()
    for m in _SUBJECT_PRESENCE_RE.finditer(global_text):
        try:
            present.add(int(m.group(1)))
        except (TypeError, ValueError):
            pass
    if not present:
        return cast_spec
    return [(no, rows) for no, rows in (cast_spec or []) if no not in present]


def _detect_bound_names_in_text(text, binding_names):
    """批 H1 档2: prompt 文本里命中绑定名字的卡名 → 集合 (保序去重).
    全词匹配 (与 replace_cast_names 同语义), 与 replace_cast_names 共享边界规则.
    binding_names = set|list of str; 返回 list[str]."""
    if not text or not binding_names:
        return []
    import re as _re
    out = []
    seen = set()
    # 按 name 长度倒序排, 防 "测试1" 撞 "测试" (与 replace_cast_names 一致)
    sorted_names = sorted(binding_names, key=lambda n: (-len(str(n)), str(n)))
    for name in sorted_names:
        if name in seen:
            continue
        seen.add(name)
        pat = _CAST_WORD_BOUNDARY_RE_TEMPLATE % _re.escape(str(name))
        if _re.search(pat, text):
            out.append(name)
    return out


def _declared_mode(workflow_path):
    """模板文件名声明的模式: 接线判不出时的补充(ClipProj 家族存盘无接线)。
    fl2v 属 i2v 族。"""
    name = os.path.basename(workflow_path or "").lower()
    for pat, mode in (("ref2v", "ref2v"), ("fl2v", "i2v"), ("i2v", "i2v"), ("t2v", "t2v")):
        if pat in name:
            return mode
    return None


def _template_mode(path):
    """模板模式判定: 接线优先——ReferenceToVideo 节点即 ref2v; ImageToVideo:
    last_frame 接线→fl2v, 仅 first_frame→i2v, 都不接线→按文件名声明补判
    (匿名工作流默认 t2v); 无 H3 节点→文件名声明。文件名与接线不同族时提示。"""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        nodes = d.get("nodes", [])
    except (OSError, ValueError):
        return _declared_mode(path)
    types = [n.get("type", "") for n in nodes]
    if "MiniMaxH3ReferenceToVideo" in types:
        structural = "ref2v"
    elif "MiniMaxH3ImageToVideo" in types:
        def wired(slot_name):
            return any(slot.get("name") == slot_name and slot.get("link") is not None
                       for n in nodes if n.get("type") == "MiniMaxH3ImageToVideo"
                       for slot in (n.get("inputs") or []))
        if wired("last_frame"):
            structural = "fl2v"
        elif wired("first_frame"):
            structural = "i2v"
        else:
            # ClipProj 家族存盘无首尾帧接线, 按文件名补判; 匿名工作流默认 t2v
            structural = ("fl2v" if "fl2v" in os.path.basename(path).lower()
                          else _declared_mode(path) or "t2v")
    else:
        return _declared_mode(path)
    name_mode = _declared_mode(path)
    same_family = name_mode == structural or (name_mode == "i2v" and structural == "fl2v")
    if name_mode and not same_family:
        print("[H3Batch] 文件名声明 %s, 模板结构实为 %s, 以结构为准" % (name_mode, structural), flush=True)
    return structural


# 1.14 整改批 I I2c: 引擎侧 fl2v 判定助手 _is_fl2v 已删 (I2a 删 _endpoint_frame 后无消费方;
# fl2v 批入口即拒 → 引擎侧对齐句不可达). 保留面 = 端点层预览对齐句 (GUI 契约, 走
# prompt_assembler is_fl2v 参数, 由端点 _template_mode 判族单源派生 — 与引擎无关).

# 1.14 整改批 I I1: i2v/fl2v 全面废除 (老板令 D5, 统一 ref2v) — 拒绝面统一判据 + 文案单一来源.
RETIRED_TEMPLATE_MSG = "i2v/fl2v 已废除，请改用 ref2v 模板"


def _retired_template_error(workflow_path):
    """模板属 i2v/fl2v 族 → 返回拒绝文案 (含模板名); ref2v/t2v/判不出 → None。

    判据 = _template_mode (保留不删, 本函数即其消费方); 引擎内 i2v/fl2v 分支清理由 I2a 另做。
    """
    _p = str(workflow_path or "")
    if _template_mode(_p) not in ("i2v", "fl2v"):
        return None
    return "%s (当前模板: %s)" % (RETIRED_TEMPLATE_MSG, os.path.basename(_p) or _p)


def browse_dir(path, exts=None):
    """列目录给前端路径选择面板。exts 如 [".csv"] 时只列匹配文件(大小写不敏感)。
    path 为空列盘符; 目录不可读返回 {"error": ...}。"""
    path = (path or "").strip().strip('"').replace("/", "\\")
    # "N:" 是盘相对路径(指向进程 cwd), 归一成盘根
    if len(path) == 2 and path[1] == ":":
        path += "\\"
    if not path:
        drives = [l + ":" for l in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(l + ":\\")]
        return {"path": "", "parent": "", "dirs": drives, "files": [], "drives": True}
    if not os.path.isdir(path):
        return {"error": "目录不存在: %s" % path}
    try:
        names = os.listdir(path)
    except OSError as e:
        return {"error": "无法读取目录: %s" % e}
    dirs, files = [], []
    for n in sorted(names, key=str.lower):
        if n.startswith("."):
            continue
        p = os.path.join(path, n)
        if os.path.isdir(p):
            dirs.append(n)
        elif not exts or os.path.splitext(n)[1].lower() in exts:
            files.append(n)
    base = path.rstrip("\\/")
    drive = os.path.splitdrive(base)[0]
    # 盘根的 parent 置空 -> 前端进入盘符列表, 用户可换盘
    parent = "" if (drive and base == drive) else os.path.dirname(base)
    return {"path": path, "parent": parent, "dirs": dirs, "files": files}


_RESERVED_KEYS = ("_concat", "_csv_fingerprint", "_workflow",
                 "_resources", "_overrides", "_inject", "_override",  # T2.7 批2: 资源编排元信息
                 "_color",  # V1.9 批 3 T3.5: S2 色彩对齐批级留痕
                 "_review",  # V1.9 批 3 T3.7: S5 审片报告批级留痕
                 "_schema",  # V1.11 批 1 T1: manifest schema 版本自描述
                 "_mode",  # V1.11 批 1 T2: history 列表 mode 字段; 引擎首次落盘写入
                 "_csv_path",  # V1.11 批 1 T2: history 列表 csv_path 字段; 引擎首次落盘写入
                 "_reruns",  # V1.11 批 1 T3: 多段重跑 ledger (seq/time/sids/files/seeds/reason)
                 "_concat_history",  # V1.11 批 1 T5: 手动拼接账本 (time/task_id/rerun_seq/mode/map/output)
                 "_trash_meta",  # V1.11 批 1 T6: 回收站元信息 (orig_dir/deleted_at), 仅在 .h3_trash 期间存在; 恢复后移除
                 "_note",  # V1.11 批 2 T4: 任务备注 (字符串; 不进保留清单则段遍历把 str 当段崩)
                 "_res_summary",  # V1.11 批 3 T1: 重跑参数覆写差异检测基线 (输入值原样: 比例/质量/步数/lora)
                 "_config",  # V1.11 批 3 T2: 表单生成任务时引擎首次落盘从旁车注入的配置快照 (mode/pool/globals/shots)
                 "session_id",  # V1.12 批 L 波 1 批次 D T6: 任务 ↔ LLM 会话 1:N 弱锚定 (28hex str; 同 _note 先例, 不进段遍历)
                 "_resources_raw", "_overrides_raw", "_lora_overrides_raw",  # V1.13 D25: 原串三键 (str; 同 _note 教训, 不进段遍历)
                 "_candidate_runs",  # V1.13h 第四波: 多候选组终态记录 (list; 同 _note 教训 — 不登记则 _rebuild_concat/_rerun_finalize 的缺段收集把 list 当段 dict 崩 "AttributeError: 'list' object has no attribute 'get'", 真机复跑 ②③ 暴露)
                 "_postfx",  # 1.14b U3: 后处理记账 (dict; 同 _note 教训, 不进段遍历)
                 "_adapter_report",  # 1.14 P6: AdapterPlan 报告 (dict; 同 _note 教训, 不进段遍历)
                 "_batch_error")  # #40: 受理后落盘后死的批级错误 (五键 dict; 同 _note 教训, 不进段遍历)

# #40 提交期错误结构化: 受理后段前死亡的落盘前通道 — 模块级 {stem, 五键 dict}.
# run() 首次 _save_manifest 成功前抛死 → 记此处; status 端点按 stem 匹配 +
# running==false 且非空才透传 resp["run_init_error"]; 新提交受理时清零 (堵陈值窗).
_last_run_init_error = {}


def _submit_error_detail(node_type, exception_type, message):
    """#40 提交期错误结构化五键 dict (R-34 四键 + error_source="submit_validation").

    node_id 恒空串: 提交期校验发生在送进 ComfyUI 之前, 没有节点可指.
    exception_message 取原文并截断 1000 (同 _last_execution_error_detail 口径)."""
    return {
        "node_id": "",
        "node_type": node_type,
        "exception_type": exception_type,
        "exception_message": str(message or "")[:1000],
        "error_source": "submit_validation",
    }


def _record_run_init_error(stem, exc):
    """#40: 记落盘前死的批级错误 (模块级状态 — __init__.py 端点读它做 status 透传)."""
    global _last_run_init_error
    _last_run_init_error = {"stem": stem,
                            "error": _submit_error_detail("run_init", "run_init", exc)}

# V1.11 批 1 T1: manifest 顶层 _schema 字段版本; 仅 1 起步. 后续演进 +1 并保证旧版可读.
_MANIFEST_SCHEMA_VERSION = 1

# V1.11 批 1 T1: per-path 锁注册表, 模块级 dict 按 manifest 绝对路径寻址.
# 引擎为同进程单例, threading.Lock + 原子写已足, 不引跨进程文件锁 (msvcrt/fcntl 禁用).
_MANIFEST_LOCKS = {}
_MANIFEST_LOCKS_GUARD = threading.Lock()


def _manifest_lock(path):
    abs_p = os.path.abspath(path)
    with _MANIFEST_LOCKS_GUARD:
        lock = _MANIFEST_LOCKS.get(abs_p)
        if lock is None:
            lock = threading.Lock()
            _MANIFEST_LOCKS[abs_p] = lock
        return lock


def read_manifest_safe(path):
    """V1.11 批 1 T1: 容错读 manifest.

    返回 (data, degraded):
      - 文件不存在 → (None, False)
      - JSON 损坏 → ({}, True) (日志登记, 不抛)
      - _schema 缺失或 ≠ _MANIFEST_SCHEMA_VERSION → (data, True) (警告日志, 仍返回数据)
      - 正常 v1 → (data, False)
    """
    if not os.path.exists(path):
        return None, False
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print("[H3Batch] read_manifest_safe: 解析失败 %s (%s)" % (path, e), flush=True)
        return {}, True
    if not isinstance(data, dict):
        print("[H3Batch] read_manifest_safe: 顶层非 dict %s" % path, flush=True)
        return {}, True
    schema = data.get("_schema")
    if schema != _MANIFEST_SCHEMA_VERSION:
        print("[H3Batch] read_manifest_safe: _schema=%r, 期望 %d (degraded)"
              % (schema, _MANIFEST_SCHEMA_VERSION), flush=True)
        return data, True
    return data, False


def _manifest_write(path, mutator_fn):
    """V1.11 批 1 T1: 锁内 read → mutator_fn(dict) → 原子保存. 供后续端点侧统一写盘.

    mutator_fn 签名: (existing: dict | None) -> dict | None
      - 接收当前磁盘数据 (None = 文件不存在; {} = JSON 损坏/非 dict).
      - 返回要写入的数据 (None = 不写, 跳过).
    返回最终写入的 dict (或 None = 未写入).

    失败模式: 写盘异常抛 OSError; mutator 抛异常向上传, 锁释放, 磁盘未动.
    """
    abs_p = os.path.abspath(path)
    os.makedirs(os.path.dirname(abs_p) or ".", exist_ok=True)
    lock = _manifest_lock(abs_p)
    with lock:
        existing, _deg = read_manifest_safe(abs_p)
        new_data = mutator_fn(existing)
        if new_data is None:
            return None
        if not isinstance(new_data, dict):
            raise TypeError("mutator_fn 必须返回 dict 或 None, 实 %r" % type(new_data))
        new_data["_schema"] = _MANIFEST_SCHEMA_VERSION
        tmp = "%s.tmp.%d.%s" % (abs_p, os.getpid(), uuid.uuid4().hex[:8])
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
        _replaced = False
        _last_err = None
        for _attempt in range(100):
            try:
                os.replace(tmp, abs_p)
                _replaced = True
                break
            except PermissionError as _e:
                _last_err = _e
                time.sleep(0.005)
        if not _replaced:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise _last_err if _last_err is not None else RuntimeError(
                "manifest 原子替换耗尽 (无 PermissionError 留痕)")
        return new_data


# V1.11 批 3 T2: 旁车配置快照 — <csv名>.h3cfg.json 与 CSV 同目录, 内容是前端
# 表单 serializeFormConfig() 返回的快照 (mode/pool/pool_usage/globals/shots).
# 引擎首次落盘读它并入 manifest._config; 缺文件返回 None 不报错 (手填 CSV 场景).
def _load_sidecar_config(csv_path):
    if not csv_path or not os.path.isabs(csv_path):
        return None
    sidecar = csv_path[:-4] + ".h3cfg.json" if csv_path.lower().endswith(".csv") \
        else csv_path + ".h3cfg.json"
    if not os.path.exists(sidecar):
        return None
    try:
        with open(sidecar, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print("[H3Batch] 旁车 %s 读取失败 (%s), 跳过注入 _config" % (sidecar, e), flush=True)
        return None
    return data if isinstance(data, dict) else None


# ===== 1.13h 第三波 T1: 段级覆盖侧车 (run_dir/_seg_overrides.json) =====
# 真相源: 每任务目录一份总文件; 顶层 task_id 隔离 → 其下 sid → 该段覆盖项, 未覆盖段不出现.
# 优先级 侧车 > CSV (精修不被下次全量提交冲掉). 契约见 docs/api.md #57 行为契约段.
_SEG_OVERRIDES_FILE = "_seg_overrides.json"


def _seg_overrides_path(run_dir):
    return os.path.join(run_dir, _SEG_OVERRIDES_FILE)


def _seg_overrides_load(run_dir, task_id):
    """读 task_id 子表 → {sid: 覆盖项}. 缺文件/损坏/结构不符 → {} (静默兜底, 不抛不写)."""
    try:
        with open(_seg_overrides_path(run_dir), encoding="utf-8") as f:
            all_ov = json.load(f)
    except (OSError, ValueError):
        return {}
    task_ov = all_ov.get(str(task_id)) if isinstance(all_ov, dict) else None
    if not isinstance(task_ov, dict):
        return {}
    return {sid: ov for sid, ov in task_ov.items() if isinstance(ov, dict)}


def _seg_overrides_merge_for_sid(run_dir, task_id, sid):
    """取该段覆盖项; 未覆盖/缺文件 → {}."""
    return _seg_overrides_load(run_dir, task_id).get(sid) or {}


def _seg_overrides_save(run_dir, task_id, overrides_by_sid):
    """锁内 reload → 只替换本 task 子表 → tmp + os.replace 原子落盘.

    同目录其它 task_id 子表原样保留 (多批隔离). Windows 上 reader 持句柄时 replace 会
    PermissionError → 短重试 (同 _manifest_write 先例).
    """
    path = os.path.abspath(_seg_overrides_path(run_dir))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    lock = _manifest_lock(path)
    with lock:
        all_ov = {}
        try:
            with open(path, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                all_ov = loaded
        except (OSError, ValueError):
            pass
        all_ov[str(task_id)] = overrides_by_sid if isinstance(overrides_by_sid, dict) else {}
        tmp = "%s.tmp.%d.%s" % (path, os.getpid(), uuid.uuid4().hex[:8])
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(all_ov, f, ensure_ascii=False, indent=2)
        for _ in range(100):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                time.sleep(0.005)
        else:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return all_ov


def _seg_overrides_set(run_dir, task_id, sid, patch):
    """合并写该段覆盖项: patch 逐键并入 (值 None → 删键), 该段空则整段移除.

    其余段 / 其余 task_id 子表原样保留 (复用 _seg_overrides_save 锁内读改写)。
    调用方: #57 seg_edit 端点 (整体覆盖值) / #7 rerun_edit_prompt (回写 prompt_text)。
    """
    cur = _seg_overrides_load(run_dir, task_id)
    seg = dict(cur.get(sid) or {})
    for k, v in (patch or {}).items():
        if v is None:
            seg.pop(k, None)
        else:
            seg[k] = v
    if seg:
        cur[sid] = seg
    else:
        cur.pop(sid, None)
    _seg_overrides_save(run_dir, task_id, cur)
    return cur


# V1.11 批 1 T2b: manifest 双位置寻址 — 子文件夹 (新位置, run_dir 内) 优先, 根层回退.
# 过渡期兼容根层老位置 (老板 8189 还在跑 V1.10 老代码, 升级前继续在根层产生新 manifest).
_STEM_RE = re.compile(r"[A-Za-z0-9_\-\u4e00-\u9fff]+")


# V1.13 D1: CSV 基名清洗 — 白名单字符保留 (与 _STEM_RE 同源), 非法字符 `_` 替代,
# 段间用 `_` 拼接, 首尾 `_` 剥除. 三处命名点 (CSV→新 manifest / trash 查找 / 端点寻址)
# 共用本函数 — 避免三处复制. 输入允许任意字符串, 输出满足 _STEM_RE.fullmatch.
def _sanitize_stem(raw):
    if not isinstance(raw, str):
        return ""
    parts = _STEM_RE.findall(raw)
    if not parts:
        return ""
    return "_".join(parts).strip("_")


# 批 W1 R-52 v2：run_subdir 支持嵌套子路径（GUI 发 项目名/项目名_时间戳）——
# 分段清洗逐段过 _sanitize_stem；穿越段（.. / .）整串拒收回退时间戳。
def _sanitize_run_subdir(raw):
    if not raw or not isinstance(raw, str):
        return ""
    parts = [p for p in re.split(r"[\\/]+", raw.strip())]
    if any(p in ("..", ".") for p in parts):
        return ""
    segs = [_sanitize_stem(p) for p in parts]
    segs = [s for s in segs if s]
    if not segs or len(segs) > 4:
        return ""
    return os.sep.join(segs)


# V1.13 D1: 撞名检测 — 同 output_dir 内 cleaned stem 已被旧 manifest 占, 新批应显式报错
# (提示 rename, 不静默覆盖/跳过). 返回 None 表示无撞名, 返回 str 表示撞名错误信息.
def _check_stem_clobber(stem, output_dir):
    if not stem or not output_dir or not os.path.isdir(output_dir):
        return None
    basename = "h3_batch_manifest_%s.json" % stem
    # 双位置 (run_dir 子文件夹 + 根层) 都要查; 任一命中即撞名
    for parent in (output_dir,):
        direct = os.path.join(parent, basename)
        if os.path.isfile(direct):
            return ("clobber_exists: output_dir=%s 内已有同名 manifest %s — "
                    "请改 CSV 文件名 (清洗后撞名) 或先挪走旧 manifest"
                    % (output_dir, basename))
        # run_dir 子文件夹 (V1.11 T2b 新位置)
        for n in os.listdir(parent) if os.path.isdir(parent) else []:
            sub = os.path.join(parent, n)
            if not os.path.isdir(sub):
                continue
            cand = os.path.join(sub, basename)
            if os.path.isfile(cand):
                return ("clobber_exists: output_dir=%s 的子文件夹 %s 内已有同名 manifest %s — "
                        "请改 CSV 文件名 (清洗后撞名) 或先挪走旧 manifest"
                        % (output_dir, n, basename))
    return None


# V1.11 批 1 T3 门审真机 P1: resolve_manifest_path 多命中日志刷屏 (status 轮询每 10s
# 触发). 同 (stem, output_root, kind, count) 组合只打一次, 重复静默 ——
# 选择变化 (新文件入选) 才再打 (模块级 set 记忆).
_RESOLVE_MANIFEST_LOGGED = set()


def _manifest_boundary_hits(hits, stem):
    """glob 命中按边界口径过滤: 仅精确名 `h3_batch_manifest_<stem>.json` 或合法变体
    `<stem>_rep<digit>.json` (同 __init__._find_in_trash 口径).
    I3-D2: 旧兜底直接吃 `<stem>*` 前缀兄弟 → '卡1' 误中 '卡10' 的 manifest,
    detail/config/软删/note 寻址全落到别的任务."""
    exact = "h3_batch_manifest_%s.json" % stem
    variant_re = re.compile(r"^h3_batch_manifest_%s_rep\d+\.json$" % re.escape(stem))
    return [p for p in hits
            if os.path.basename(p) == exact or variant_re.match(os.path.basename(p))]


def resolve_manifest_path(stem, output_root):
    """返回 stem 对应 manifest 的绝对路径; 不存在 → None.

    优先级 ① 子夹一层/两层 (新位置, v2 嵌套 run_dir=output/<名>/<子夹>/, 合并取 mtime 新)
    → ② 根层 (旧 V1.10 位置) → ③ None.
    精确命中优先于变体; 同级多命中 → 取 mtime 最新 (迁移期/老代码重复), 日志一行.
    stem 不合法 (路径穿越/空/正则元字符) → 直接 None.
    suffix 变体 (_rep1/_rep2 等) 按 `<stem>_rep<digit>` 边界兜底, 前缀兄弟不命中 (I3-D2).
    """
    if not isinstance(stem, str) or not _STEM_RE.fullmatch(stem):
        return None
    if not output_root or not os.path.isdir(output_root):
        return None
    pattern_sub = os.path.join(output_root, "*",
                               "h3_batch_manifest_%s*.json" % stem)
    # 批 W1 R-52 v2 (T-C): v2 嵌套 run_dir 多一层 — 补两层 glob, 与一层命中合并
    # 按既有 mtime 口径取新 (两 glob 深度无交集不重复); 根层回退优先级不变.
    pattern_sub2 = os.path.join(output_root, "*", "*",
                                "h3_batch_manifest_%s*.json" % stem)
    sub_hits = _manifest_boundary_hits(
        [p for p in glob.glob(pattern_sub) + glob.glob(pattern_sub2)
         if os.path.isfile(p)], stem)
    if sub_hits:
        sub_hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        if len(sub_hits) > 1:
            _key = ("sub", stem, output_root, len(sub_hits), sub_hits[0])
            if _key not in _RESOLVE_MANIFEST_LOGGED:
                _RESOLVE_MANIFEST_LOGGED.add(_key)
                print("[H3Batch] resolve_manifest_path: %d 处子文件夹命中, 取 mtime 最新 %s"
                      % (len(sub_hits), sub_hits[0]), flush=True)
        return sub_hits[0]
    pattern_root = os.path.join(output_root, "h3_batch_manifest_%s*.json" % stem)
    root_hits = _manifest_boundary_hits(
        [p for p in glob.glob(pattern_root) if os.path.isfile(p)], stem)
    if root_hits:
        root_hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        if len(root_hits) > 1:
            _key = ("root", stem, output_root, len(root_hits), root_hits[0])
            if _key not in _RESOLVE_MANIFEST_LOGGED:
                _RESOLVE_MANIFEST_LOGGED.add(_key)
                print("[H3Batch] resolve_manifest_path: 根层 %d 处命中, 取 mtime 最新 %s"
                      % (len(root_hits), root_hits[0]), flush=True)
        return root_hits[0]
    return None


# ===== 批1 E1 (#51 渲染目录归位): 端点归档寻批 + 搬运 helper =====
# GUI 渲染终态/手动入口发 POST /h3_batch/archive, 按 task_id(stem) 把 output 根两层
# 结构 (项目名/项目名_分钟戳) 的批夹平铺搬进 output_root/_archive/。dest 命名/撞名
# 后缀/repath 沿 _archive_run 现例; 空父夹清理对表 :11406"死壳堆积"; 指针文件供
# E2 接力回找消费 (本任务只写)。
_ARCHIVE_DIR_NAME = "_archive"
_ARCHIVED_POINTER_NAME = ".h3_archived"
# E3 孤儿戳文件 GC 落点 — 引擎既有回收站名 (同 __init__.py _TRASH_DIR_NAME;
# batch_core 不可反向 import __init__ (循环依赖), 字面量在此对齐)
_TRASH_DIR_NAME = ".h3_trash"


def locate_run_dir_for_archive(stem, output_root):
    """E1 归档寻批 — 两层结构 glob (`*/*`·同 resolve_manifest_path 子夹口径), 排除
    _archive 自身 (已归档批不当活动批二次搬)。同级多命中取 mtime 最新, 名单边界
    过滤同 _manifest_boundary_hits (精确名 + _repN 变体, 防前缀兄弟误中)。

    返回 (kind, run_dir, manifest_path):
      ("live", run_dir, mp)        活动位找到 (run_dir=manifest 所在两层夹)
      ("archived", dest, mp)       _archive 下找到 (幂等命中, dest=现归档夹)
      (None, None, None)           均未找到 → 端点 404
    """
    if not isinstance(stem, str) or not _STEM_RE.fullmatch(stem):
        return (None, None, None)
    if not output_root or not os.path.isdir(output_root):
        return (None, None, None)
    arch_nc = os.path.normcase(os.path.join(os.path.abspath(output_root),
                                            _ARCHIVE_DIR_NAME))
    pattern = os.path.join(output_root, "*", "*",
                           "h3_batch_manifest_%s*.json" % stem)
    live = _manifest_boundary_hits(
        [p for p in glob.glob(pattern)
         if os.path.isfile(p)
         and not os.path.normcase(os.path.abspath(p)).startswith(arch_nc + os.sep)],
        stem)
    if live:
        live.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        mp = live[0]
        return ("live", os.path.dirname(os.path.abspath(mp)), mp)
    # 幂等探测: 已归档批在 _archive/<尾段>/ 内 (深度 2 同款寻址)
    pattern_arch = os.path.join(os.path.abspath(output_root), _ARCHIVE_DIR_NAME,
                                "*", "h3_batch_manifest_%s*.json" % stem)
    arch = _manifest_boundary_hits(
        [p for p in glob.glob(pattern_arch) if os.path.isfile(p)], stem)
    if arch:
        arch.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        mp = arch[0]
        return ("archived", os.path.dirname(os.path.abspath(mp)), mp)
    return (None, None, None)


def scan_existing_batch_dirs(output_root):
    """E4 存量模式盘点 — output 根下两层结构批夹清单 (与 locate_run_dir_for_archive
    同口径: 项目名/项目名_时间戳; 排除 _archive 与 .h3_trash; 点头目录同 glob `*`
    口径不匹配)。

    返回 (live, legacy, shells):
      live   = [(run_dir, manifest_path)]  两层批夹 (内含 h3_batch_manifest_*.json,
                 多份取 mtime 最新 — 同 locate 现例), 供端点逐批走单批归档同路径
      legacy = [dir]  一层老布局批夹 (manifest 直接在夹内, 如 quick 产物时间戳夹)
                 — 只盘不搬, 端点计 skipped_legacy_layout; 判老布局即不下钻
      shells = [dir]  指针壳 (仅 .h3_archived 无 manifest — E1 归档残壳) — 只盘
                 不搬不删, 端点计 already_archived
    判定顺序: 先 manifest 后指针 — 两者并存 (E1 机制下不存在) 以 manifest 为准当活批;
    其余两层夹 (无 manifest 无指针, 如普通子目录) 不入任何清单零触碰。
    """
    if not output_root or not os.path.isdir(output_root):
        return ([], [], [])
    root_nc = os.path.normcase(os.path.abspath(output_root))
    skip_nc = {os.path.normcase(os.path.join(root_nc, n))
               for n in (_ARCHIVE_DIR_NAME, _TRASH_DIR_NAME)}
    live, legacy, shells = [], [], []

    def _manifests_in(d):
        hits = [p for p in glob.glob(os.path.join(d, "h3_batch_manifest_*.json"))
                if os.path.isfile(p)]
        hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        return hits

    for e1 in os.scandir(output_root):
        if not e1.is_dir(follow_symlinks=False) or e1.name.startswith("."):
            continue
        if os.path.normcase(os.path.abspath(e1.path)) in skip_nc:
            continue
        if _manifests_in(e1.path):
            legacy.append(e1.path)
            continue
        for e2 in os.scandir(e1.path):
            if not e2.is_dir(follow_symlinks=False) or e2.name.startswith("."):
                continue
            hits = _manifests_in(e2.path)
            if hits:
                live.append((os.path.abspath(e2.path), hits[0]))
            elif os.path.isfile(os.path.join(e2.path, _ARCHIVED_POINTER_NAME)):
                shells.append(e2.path)
    return (live, legacy, shells)


def _archive_repath_manifest(manifest, src, dest):
    """E1 repath 补齐 — 段级 run_dir/file 沿 _archive_run 现例 (:10131-10137 同款)
    之上补两族: _concat_history[].output 与 _postfx.final_parts (均绝对路径,
    改 dest 前缀新绝对路径; 相对路径原样保留)。就地改写 manifest。"""
    def repath(p):
        if p == src:
            return dest
        if p and os.path.normcase(p).startswith(os.path.normcase(src) + os.sep):
            return os.path.join(dest, p[len(src) + 1:])
        return p

    for v in manifest.values():
        if not isinstance(v, dict):
            continue
        if v.get("run_dir"):
            v["run_dir"] = repath(v["run_dir"])
        if v.get("file"):
            v["file"] = repath(v["file"])
    hist = manifest.get("_concat_history")
    if isinstance(hist, list):
        for entry in hist:
            if isinstance(entry, dict) and isinstance(entry.get("output"), str) \
                    and entry["output"]:
                entry["output"] = repath(entry["output"])
    pf = manifest.get("_postfx")
    if isinstance(pf, dict) and isinstance(pf.get("final_parts"), list):
        pf["final_parts"] = [repath(p) if isinstance(p, str) else p
                             for p in pf["final_parts"]]


# E3 孤儿戳文件 GC 面 — (目录名, kind) 对, 目录名为 postfx_engine.run_postfx_batch
# 默认落盘目录 (upscaled_dir="upscaled" / interp_dir="interp")。
_GC_POSTFX_DIRS = (("upscaled", "upscale"), ("interp", "interp"))


def _gc_orphan_postfx_files(run_dir, manifest, output_root):
    """E3 孤儿后期戳文件 GC — 归档搬运前于原 run_dir 执行 (#50 伴生: 重复触发后期
    时旧计数器戳文件成孤儿只增不删, 全仓零 GC)。

    目标集: run_dir 内 upscaled/ 与 interp/ 平铺文件中、basename stem 经
    postfx_engine.has_stamp_token 命中的文件 (与 X5 同源整词判定, 不按文件名形态
    硬编码 — 产物名由 workflow 实际输出决定)。戳值取 kind_stamp 缺省 _x2/_48fps:
    归档时点无 postfx 请求参数, 动态戳 (_x2.5/_720p/_32fps) 不在判定面, 已知边界。
    run_dir 根级产物 (段文件/成片/manifest) 永不入 GC 面; 不按扩展名过滤
    (postfx 产物带戳即视频件, 扩展名白名单属多余形态硬编码)。

    引用集六族 (任一族指向者不动, 比对前一律归一 basename — 六族存储形态不一):
      段 files (裸名/带子目录) / _postfx.final_parts (绝对) /
      _postfx[kind][sid] (相对 run_dir) / _concat_history[].map (basename) /
      _reruns[*].files[*] (basename) / _concat_history[].output (绝对)
    前三族与引擎改名跟随集 _apply_renames_to_manifest 同源。

    未引用者移入 output 根 .h3_trash (引擎既有回收站定位, 暂存缓冲 — 不承诺端点
    可恢复; 撞名加 _2 后缀沿 _archive 现例, 不覆写既有件)。单件失败只记日志不阻断
    归档 (该件随批归档不丢)。返回实际移入件数。
    """
    import postfx_engine  # 引擎既有惰性 import 惯例 (模块顶部不挂)
    stamps = [postfx_engine.kind_stamp(k) for _d, k in _GC_POSTFX_DIRS]

    refs = set()

    def _ref(v):
        if isinstance(v, str) and v:
            refs.add(os.path.basename(v))

    for sid, info in manifest.items():
        if sid.startswith("_") or sid in _RESERVED_KEYS:
            continue
        if isinstance(info, dict):
            for f in info.get("files") or []:
                _ref(f)
    pf = manifest.get("_postfx")
    if isinstance(pf, dict):
        for f in pf.get("final_parts") or []:
            _ref(f)
        for _dir_name, kind in _GC_POSTFX_DIRS:
            sub = pf.get(kind)
            if isinstance(sub, dict):
                for v in sub.values():
                    _ref(v)
    hist = manifest.get("_concat_history")
    if isinstance(hist, list):
        for entry in hist:
            if not isinstance(entry, dict):
                continue
            m_map = entry.get("map")
            if isinstance(m_map, dict):
                for v in m_map.values():
                    _ref(v)
            _ref(entry.get("output"))
    reruns = manifest.get("_reruns")
    if isinstance(reruns, list):
        for entry in reruns:
            if not isinstance(entry, dict):
                continue
            files = entry.get("files")
            if isinstance(files, dict):
                for v in files.values():
                    _ref(v)

    trash = os.path.join(os.path.abspath(output_root), _TRASH_DIR_NAME)
    moved = 0
    for d, _k in _GC_POSTFX_DIRS:
        dpath = os.path.join(run_dir, d)
        if not os.path.isdir(dpath):
            continue
        for name in os.listdir(dpath):
            full = os.path.join(dpath, name)
            if not os.path.isfile(full):
                continue
            stem = os.path.splitext(name)[0]
            if not any(postfx_engine.has_stamp_token(stem, s) for s in stamps):
                continue
            if name in refs:
                continue
            try:
                os.makedirs(trash, exist_ok=True)
                dst = os.path.join(trash, name)
                if os.path.exists(dst):
                    ext = os.path.splitext(name)[1]
                    n = 2
                    while os.path.exists(os.path.join(trash, "%s_%d%s" % (stem, n, ext))):
                        n += 1
                    dst = os.path.join(trash, "%s_%d%s" % (stem, n, ext))
                shutil.move(full, dst)
                moved += 1
            except OSError as e:
                print("[H3Batch] 孤儿戳文件移入回收站失败 (随批归档): %s (%s)"
                      % (full, e), flush=True)
    if moved:
        print("[H3Batch] 孤儿后期戳文件 GC: %d 个移入 %s" % (moved, trash), flush=True)
    return moved


def archive_run_dir(run_dir, output_root, manifest_path):
    """E1 归档搬运 — 把 run_dir 整体平铺搬进 output_root/_archive/<尾段> (撞名加
    _2 后缀沿 _archive_run 现例), manifest 随批走, 善后顺序 (对表任务单):
    孤儿戳文件 GC (E3·搬运前于原 run_dir) → repath 补齐 → manifest 原子写回
    (_manifest_write·锁内 tmp+replace) → 空父夹清理 → 指针文件 (原 run_dir 位置
    重建壳, 内容=dest 绝对路径一行)。

    返回 dest; 搬运/写回失败向上抛 (端点转 500, 成果保留原位); 空父夹清理与指针
    文件为善后步骤, 失败只记日志不回滚 (主目标已达成 — 空父夹清理先于指针壳重建,
    壳写不进时项目夹保持已清, 不残留死壳)。
    """
    src = os.path.abspath(run_dir)
    base = os.path.basename(src)
    arch_root = os.path.join(os.path.abspath(output_root), _ARCHIVE_DIR_NAME)
    dest = os.path.join(arch_root, base)
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(arch_root, "%s_%d" % (base, n))
        n += 1
    os.makedirs(arch_root, exist_ok=True)
    # E3 孤儿戳文件 GC — 搬运前于原 run_dir 执行 (端点五通道前置检查已保证批
    # 静默, 无在飞竞态); manifest 读不出 (缺失/损坏) → 引用集无从谈起, GC 整体
    # 跳过 (fail-closed 不误收)。
    try:
        with open(manifest_path, encoding="utf-8") as f:
            gc_manifest = json.load(f)
    except (OSError, ValueError) as e:
        print("[H3Batch] 孤儿戳文件 GC 跳过 (manifest 不可读): %s (%s)"
              % (manifest_path, e), flush=True)
        gc_manifest = None
    if isinstance(gc_manifest, dict) and gc_manifest:
        try:
            _gc_orphan_postfx_files(src, gc_manifest, output_root)
        except Exception:
            print("[H3Batch] 孤儿戳文件 GC 异常 (归档继续):\n%s"
                  % traceback.format_exc()[-300:], flush=True)
    shutil.move(src, dest)
    # manifest 跟随 run_dir (T2b 位置) — repath 后锁内原子写回归位
    new_mp = os.path.join(dest, os.path.basename(manifest_path))
    with open(new_mp, encoding="utf-8") as f:
        manifest = json.load(f)
    if isinstance(manifest, dict) and manifest:
        _archive_repath_manifest(manifest, src, dest)
        _manifest_write(new_mp, lambda _existing: manifest)
    # 空父夹清理: 搬移后项目根夹已空 (仅剩本批) → rmdir 防死壳堆积 (:11406);
    # 多批同项目父夹非空本就跳过; 指针壳 (下一步) 重建后父夹含壳亦不算空 —
    # 双行为互不破坏, 壳写不进时本清理保证无残留。
    parent = os.path.dirname(src)
    root_nc = os.path.normcase(os.path.abspath(output_root))
    try:
        if (parent and os.path.normcase(os.path.abspath(parent)) != root_nc
                and os.path.isdir(parent) and not os.listdir(parent)):
            os.rmdir(parent)
            print("[H3Batch] 已清空父夹: %s" % parent, flush=True)
    except OSError as e:
        print("[H3Batch] 空父夹清理跳过: %s (%s)" % (parent, e), flush=True)
    # 指针文件: 原位置重建 run_dir 壳 (接力批 _new_run_dir exist_ok 复用) +
    # 写 dest 绝对路径一行 (E2 指针识别消费)
    try:
        os.makedirs(src, exist_ok=True)
        with open(os.path.join(src, _ARCHIVED_POINTER_NAME), "w",
                  encoding="utf-8") as f:
            f.write(dest + "\n")
    except OSError as e:
        print("[H3Batch] 指针文件写入失败 (归档本体已完成): %s (%s)" % (src, e),
              flush=True)
    print("[H3Batch] 已归档: %s -> %s" % (src, dest), flush=True)
    return dest


def _seg_review(mdict):
    """V1.10 批2 T1: 段 review 裁决 — success+无 review/"approved" → "approved" (通过);
    success+review=void/pending → 原值 (未通过, 走断点续跑);
    非 success 状态 → 返回 status 或 "pending" (未通过).
    供 run() 新批判定 + T2 审片机制复用. 非 dict / None → 视同 pending."""
    if not isinstance(mdict, dict):
        return "pending"
    status = mdict.get("status")
    if status != "success":
        return status if status else "pending"
    rev = mdict.get("review")
    if rev in (None, "", "approved"):
        return "approved"
    return rev


# V1.10 批2 T3: void 级联 helper — 端点层 (POST /h3_batch/review/void) 与单测共用.
# 在批 2 T1 _seg_review 基础上落地 void 级联. 排序口径 (D3 + T3 brief 钉死):
# 按 manifest 段键解析数字后缀排序 (s2 < s10 按数字比较; 无数字后缀的键按字符串序排在其后).
# 局限: ID 非数字序命名 (字母序或随机串) 的批次级联顺序可能不准 — 已知边界, 报告登记.
# _RESERVED_KEYS 不参与排序与级联.
_REVIEW_VOID_KEY_RE = re.compile(r"(\d+)$")


def _review_void_key_sort(keys):
    """段键按"数字后缀升序 + 无数字后缀字符串序末尾"排序 (稳定)."""
    def _k(k):
        m = _REVIEW_VOID_KEY_RE.search(k)
        if m:
            return (0, int(m.group(1)), k)  # 数字键优先, 数字升序, 同数字按 key 字符串 tie-break
        return (1, k)  # 非数字键末尾
    return sorted(keys, key=_k)


def apply_review_void(manifest, sid, solo=False, cascade_pred=None):
    """V1.10 批2 T3: 作废 sid 段 + (solo=False 时) 级联其后的已生成段. 返回实际 void 化的 sid 列表.

    规则: 该段 (须 status=="success") review="void"; 按 manifest 段键数字序,
    该段之后所有 status=="success" 且 review 不为 "void" 的段 review="void"
    (pending/failed/stopped 段不动). manifest 原地修改.

    V1.10 批3 T4a (solo=True): 只作废本段, 不级联其后的 success 段.
    适用场景: 用户在审片门里只重做本段 (二选一); 端点 /h3_batch/review/void
    接收 solo=True 时走此路径. solo=False (缺省) 行为逐字节不变.

    V1.11b 波2 T5: 新增 cascade_pred 可选入参 (仅供自定义模式端点传).
    cascade_pred(k) 接收 sid (非索引) 返回 bool = 是否继续级联到该段; 首次返回
    False 即停止级联. 缺省 None = 现状全量级联, 拼接/分镜路径逐字节不变.
    写入仍只对 status=="success" 段; 中间非 success 段不写 review 但不打断链.

    边界:
    - target sid 不在 manifest / target status 非 success → voided 空列表, 无副作用.
    - target 已 void → 不重复写 (幂等); 但后续级联仍照走 (solo=False).
    - 已是 void 的级联段 → 跳过 (幂等, 不计入 voided).
    - _RESERVED_KEYS 跳过.
    - solo=True 时级联步骤整体跳过 (target 段已 void 也按上面 target 段语义返回空).
    """
    if not isinstance(manifest, dict):
        return []
    target = manifest.get(sid)
    if not isinstance(target, dict):
        return []
    if target.get("status") != "success":
        return []

    # 收集候选段键 (排除 _RESERVED_KEYS)
    keys = [k for k in manifest.keys() if k not in _RESERVED_KEYS]
    keys = _review_void_key_sort(keys)
    if sid not in keys:
        return []

    idx = keys.index(sid)
    voided = []

    # target 段本身: 已 void 跳过 (幂等), 否则写 void
    if target.get("review") != "void":
        target["review"] = "void"
        voided.append(sid)

    # solo=True: 只动本段, 不级联. 级联步骤整体跳过 (target 段已 void → voided 空).
    if solo:
        return voided

    # 级联: idx 之后所有 status==success 且 review!="void" 的段
    # cascade_pred=None → 现状全量级联 (零回归, 拼接/分镜路径逐字节不变).
    # cascade_pred 非 None → 谓词控制级联范围 (自定义模式: 仅下游连续勾选段).
    for k in keys[idx + 1:]:
        info = manifest.get(k)
        if not isinstance(info, dict):
            continue
        if info.get("status") != "success":
            continue  # pending/failed/stopped 不动
        if info.get("review") == "void":
            continue  # 已是 void, 跳过 (幂等, 不计入 voided)
        if cascade_pred is not None and not cascade_pred(k):
            break  # 谓词拒绝该段 → 停止级联 (连续勾选链断)
        info["review"] = "void"
        voided.append(k)

    return voided


def derive_seg_flags(shots):
    """1.11b 波1 T2: 自定义模式逐段勾选派位 — 模块级纯函数（端点侧也要用, §二.9）。

    值域: 去空白 == "是" → True; 其余（含空/否/1/true/脏值）→ False。
    flags[0] = False 无条件（第 1 段恒独立, 列值忽略）。
    长度 == 段数。空列表 → []。

    防递归契约（v3 N6）:
    - 不得在本函数内调用 _seg_mode / _parse_shots / _derive_seg_flags / 实例方法 —
      否则 _parse_shots 末尾缓存 (self._seg_flags = derive_seg_flags(shots)) 会无限递归。
      本函数不访问 self, 纯输入→输出映射, 调用栈独立。
    - WARN 由调用方 (H3BatchEngine._derive_seg_flags) 按 mode 决定, 本函数保持沉默。
    """
    flags = []
    for i, row in enumerate(shots):
        if not isinstance(row, dict):
            flags.append(False)
            continue
        v = str(row.get(CONCAT_FLAG_COL, "") or "").strip()
        flags.append(v == "是")
    if flags:
        flags[0] = False
    return flags


# ---- V1.9 批 3 T3.7: S5 审片报告补列阈值 (开发期登记, 2026-08-29) ----
# 色彩报警 (与 S2 阈值联动): 亮度偏差 > 5% 满量程 (0.05*255 = 12.75 Y 级) 或
# 增益偏差 |contrast-1| > 5% → alarm + color_alarms; 死区内段 (adjusted=False,
# 数值 None, 偏差 <=0.75 Y 级/1%) 不报警。
REVIEW_BRIGHTNESS_ALARM_FRAC = 0.05
REVIEW_GAIN_ALARM_FRAC = 0.05
_REVIEW_BRIGHTNESS_ALARM_Y = REVIEW_BRIGHTNESS_ALARM_FRAC * 255.0
# 链长提示: 连续 latent 续接 >= 3 段 → "建议场景切点重开链" (PRD §七 S5)。
REVIEW_CHAIN_HINT_MIN = 3

# 衔接方式列文案 (continuation.mode → 审片可读)
_CONTINUATION_LABELS = {
    "latent": "latent 续接",
    "save": "首段落盘(save)",
    "tail_frame": "尾帧降级",       # 降级原因拼接在括号里 (T3.3 downgrade_reason)
}


def build_review_report(manifest):
    """V1.9 批 3 T3.7: S5 审片报告补列 — 读 manifest 生成三列报告 dict。

    复用 V1.5 报告骨架 (manifest JSON + summarize_manifest): 本函数产出
    {"segments": [{id, status, continuation, color_deviation, chain_length}],
    "chain_hints": [...], "color_alarms": [...]} — 引擎收尾写 manifest["_review"]
    批级留痕 + 控制台提示; 旧 manifest (无 continuation/_color 键) 兼容, 缺省
    显示 "未启用" 不炸不缺行。纯函数 (只读 manifest, 不落盘)。

    - 衔接方式: 段键 continuation.mode (T3.3) → latent 续接 / 首段落盘(save) /
      尾帧降级(原因); 无键 = "未启用" (V1.8 / 机制 off)
    - 每段色彩偏差: manifest["_color"].per_seg_adjust (T3.5) 的
      brightness/contrast (相对首段的调整量 = 偏差估计) — 按 file 前缀匹配段
      id, 匹配不上按 index 对齐成功段序列 (parts 序); 报警阈值见上方登记
    - 链长提示: 连续 mode=latent 段计数, >= REVIEW_CHAIN_HINT_MIN 段提示
      "已连续 N 段（latent 续接链），建议场景切点重开链" (save/tail_frame/
      无键断链重计)
    """
    color = manifest.get("_color") if isinstance(manifest.get("_color"), dict) \
        else None
    per_seg = color.get("per_seg_adjust") if color else None
    segments = []
    color_alarms = []
    chain = 0
    chain_hints = []
    shot_keys = [k for k in manifest if k not in _RESERVED_KEYS]
    for pos, sid in enumerate(shot_keys):
        info = manifest[sid] if isinstance(manifest[sid], dict) else {}
        # -- 衔接方式列 --
        cont = info.get("continuation") or {}
        mode = cont.get("mode") if isinstance(cont, dict) else None
        if mode in _CONTINUATION_LABELS:
            label = _CONTINUATION_LABELS[mode]
            reason = str(cont.get("downgrade_reason") or "").strip()
            continuation = "%s(%s)" % (label, reason) if reason else label
        else:
            continuation = "未启用"
            mode = None
        # -- 每段色彩偏差列 --
        entry = None
        if per_seg:
            entry = next((a for a in per_seg
                          if isinstance(a.get("file"), str)
                          and a["file"].startswith(sid)), None)
            if entry is None and isinstance(per_seg, list) and pos < len(per_seg):
                entry = per_seg[pos]                  # file 无段 id → index 对齐
        if entry is None:
            color_dev = "未启用" if not per_seg else None
        else:
            b, c = entry.get("brightness"), entry.get("contrast")
            alarm = ((b is not None and abs(b) > _REVIEW_BRIGHTNESS_ALARM_Y)
                     or (c is not None and abs(c - 1.0) > REVIEW_GAIN_ALARM_FRAC))
            color_dev = {"brightness": b, "contrast": c, "alarm": alarm}
            if alarm:
                color_alarms.append(sid)
        # -- 链长列 --
        if mode == "latent":
            chain += 1
        else:
            chain = 0
        segments.append({"id": sid, "status": info.get("status"),
                         "continuation": continuation,
                         "color_deviation": color_dev,
                         "chain_length": chain if mode == "latent" else None,
                         # V1.10 批2 T1: review 列 — 段 review 裁决 (approved/void/pending),
                         # 走 _seg_review 与 run() 新批判定同源; 缺省 "approved" (兼容旧 manifest).
                         # T2 审片机制据此决定是否触发审片点; 旧 manifest 无 review 键 → "approved".
                         "review": _seg_review(info)})
    # 链长提示: 每条 >= 阈值的链在链尾段生成一条 (链长增长到 3/4/5... 只在尾段记)
    chain = 0
    for seg_info in (manifest[k] if isinstance(manifest[k], dict) else {}
                     for k in shot_keys):
        m = ((seg_info.get("continuation") or {}).get("mode")
             if isinstance(seg_info.get("continuation"), dict) else None)
        chain = chain + 1 if m == "latent" else 0
        if chain == REVIEW_CHAIN_HINT_MIN:
            chain_hints.append(
                "已连续 %d 段（latent 续接链），建议场景切点重开链" % chain)
    return {"segments": segments, "chain_hints": chain_hints,
            "color_alarms": color_alarms}


def summarize_manifest(mpath):
    """读 manifest 返回 {done, failed, stopped, missing_file, total, concat}。mpath 不存在返回 None。

    V1.9 批 3 T3.7: 新增 review 键 (manifest._review 审片报告补列透传);
    旧字段 (done/failed/stopped/missing_file/total/concat) 不动。"""
    if not os.path.exists(mpath):
        return None
    with open(mpath, encoding="utf-8") as f:
        data = json.load(f)
    shots = {k: v for k, v in data.items() if k not in _RESERVED_KEYS}
    done = sum(1 for v in shots.values() if v.get("status") == "success")
    failed = sum(1 for v in shots.values() if v.get("status") == "failed")
    stopped = sum(1 for v in shots.values() if v.get("status") == "stopped")
    missing_file = sum(1 for v in shots.values() if v.get("status") == "missing_file")
    return {"done": done, "failed": failed, "stopped": stopped,
            "missing_file": missing_file, "total": len(shots),
            "concat": data.get("_concat"),
            "review": data.get("_review")}


ASPECT_OPTIONS = ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)",
                  "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"]
ASPECT_MAP = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}


# Excel 把 "16:9" 读成时间 "16:09", 与 ASPECT_MAP 对齐时常见
# V1.8 fix: 手填 CSV 用户也可能输入全角冒号 "1：1" (U+FF1A) — 入口归一化为半角
# (表单端 csv_form.js 不强制转半角, 由引擎侧宽容处理)
def _normalize_aspect_token(v):
    """把 '16:09' 之类 Excel 时间串识别成 '16:9'; 全角冒号 '1：1' 归一化为 '1:1'。
    已知串以外的格式保持不变, 让上层兜底逻辑决定下一步。"""
    if not isinstance(v, str):
        return v
    v = v.replace("：", ":")
    m = re.match(r"^(\d+):0(\d)$", v.strip())
    if m and (m.group(1) + ":" + m.group(2)) in ASPECT_MAP:
        return m.group(1) + ":" + m.group(2)
    return v


# V1.11 交付前 BE-P1-2: 比例值域归一化 — ASPECT_OPTIONS 标签与裸比例统一为裸比例
# ('16:9 (Widescreen)' → '16:9'; '9:16 (Portrait Widescreen)' → '9:16').
# 复覆盖 _normalize_aspect_token 的 Excel 时间/全角冒号纠正, 再剥括号尾缀.
# 不可识别格式保持原值 (上层兜底决定下一步).
def _normalize_ratio(v):
    """ASPECT_OPTIONS 标签 ('16:9 (Widescreen)') 与裸比例 ('16:9') 统一归一.
    返回裸比例 'N:N'; '' → ''; None/非字符串 → 原样."""
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s:
        return s
    s = _normalize_aspect_token(s)
    m = re.match(r"^(\d+\s*:\s*\d+)", s)
    if m:
        return m.group(1).replace(" ", "")
    return s


def _parse_aspect_ratio_to_decimal(v):
    """'9:16' → 0.5625; '1:1' → 1.0. 失败返回 None(防御用, 不是 throw)。
    V1.11 交付前 BE-P1-2: 改用 _normalize_ratio (覆盖标签 + Excel 时间 + 全角冒号).
    """
    if not isinstance(v, str):
        return None
    v = _normalize_ratio(v)
    m = re.match(r"^(\d+):(\d+)$", v)
    if not m:
        return None
    a, b = int(m.group(1)), int(m.group(2))
    if b == 0:
        return None
    return a / b


def _video_wh_from_aspect(ratio_decimal, megapixels):
    """面积 = megapixels * 1e6, w*h/ratio_decimal = area (w/h = ratio_decimal)。
    w/h 取整后对齐 16 倍, 极端值回升到 256 (含原始 H3 节点 multiple 默认)。"""
    try:
        m = float(megapixels)
    except (TypeError, ValueError):
        return None
    if m <= 0 or not ratio_decimal or ratio_decimal <= 0:
        return None
    area = m * 1_000_000
    import math as _m
    w = _m.sqrt(area * ratio_decimal)
    h = _m.sqrt(area / ratio_decimal)
    w = max(256, round(w / 16) * 16)
    h = max(256, round(h / 16) * 16)
    return int(w), int(h)


def _search_tree_hint(root, basename, deadline):
    # V1.7 T6: 素材池缺失时给个全树搜索提示 — 用户挪进子目录后免排查
    # 共享 deadline 防止多素材拖死同步端点; 找到返回相对路径, 未找到/超时返回固定文案
    if not root or not os.path.isdir(root):
        return "（已在素材目录全树搜索未找到）"
    for dirpath, dirnames, filenames in os.walk(root):
        if time.time() > deadline:
            break
        if basename in filenames:
            return "（全树搜索: 在 %s 下找到同名文件）" % os.path.relpath(dirpath, root)
    return "（已在素材目录全树搜索未找到）"


class ShotError(Exception):
    pass


ENGINE_VERSION = "V1.14"  # manifest 自描述用; 版本收尾时随版本说明同步


QUEUE_MODES = ("分镜", "拼接", "自定义")
QUEUE_MODE_ALIASES = {"分镜": "分镜", "shot": "分镜", "shots": "分镜",
                      "拼接": "拼接", "concat": "拼接", "video_concat": "拼接",
                      "自定义": "自定义", "custom": "自定义"}


def _inject_h3_length_for_no_va(prompt, sec):
    """ref2v/ref2va 系等无 values.a 换算节点的模板专用: 按帧公式把秒数换算并写进 H3 节点 length 整型 widget。
    公式来源: task-3/duration-evidence.md §3 (naughty 模板同款: max(5, round(a*24)) + (5-f%17)%17)。
    守卫:
      - 整图任一节点存在数值型 values.a → 不写 length (避免双写, 零回归)
      - H3 条件节点 length 非数值型 widget → 不写 (避免戳坏连线/非数值配置)
      - 找不到 H3 条件节点 → 不写 (维持现有行为, 不报错)
    """
    for node in prompt.values():
        for k, v in node["inputs"].items():
            if k == "values.a" and isinstance(v, (int, float)):
                return  # 主力模板已有 values.a 链路, length 一律不碰
    f = max(5, round(sec * 24))
    f += (5 - (f % 17)) % 17
    for node in prompt.values():
        if node["class_type"] in ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"):
            cur = node["inputs"].get("length")
            if isinstance(cur, (int, float)):
                node["inputs"]["length"] = f
                return  # 找到了, 写完即返回 (多个 H3 节点时只动首个, 与现有 values.a 路径同款单点语义)


# ===== 批 A 节点 3 (A1): 时序标记辅助 — 帧网格换算 + 时长累加 =====

def _frame_grid_frames_for_seconds(sec):
    """按帧网格公式把秒数换算成帧数 (与 _inject_h3_length_for_no_va 同源).
    f = max(5, round(sec*24)) + (5 - f%17) % 17
    实测锚点: sec=5.0 → 124 帧 (124/24=5.16666s ≈ 5.167s)
    """
    f = max(5, round(sec * 24))
    f += (5 - (f % 17)) % 17
    return f


# 1.13h 2a: 段级覆盖时长合法区间 (帧, 17n+5 网格值): 124 (5.0s) ~ 362 (15.0s).
SEG_DURATION_MIN_FRAMES = 124
SEG_DURATION_MAX_FRAMES = 362


def _seg_duration_frames(sec):
    """侧车段级时长 (秒) → 帧: 帧网格吸附 (17n+5, 同 _frame_grid_frames_for_seconds) +
    124-362 帧校验. 非数字/越界 → ShotError (端点写入时 400 判据; 装配期同口径防御).
    """
    try:
        f = _frame_grid_frames_for_seconds(float(str(sec).strip()))
    except (TypeError, ValueError):
        raise ShotError("段级覆盖时长非数字: %r" % (sec,))
    if not (SEG_DURATION_MIN_FRAMES <= f <= SEG_DURATION_MAX_FRAMES):
        raise ShotError("段级覆盖时长 %r → %d 帧超出合法范围 [%d, %d]"
                        % (sec, f, SEG_DURATION_MIN_FRAMES, SEG_DURATION_MAX_FRAMES))
    return f


def _row_duration_ms(row, seg_override_dur=None):
    """从 row['段落时长'] 解析该镜渲染时长 (ms). 缺键/非数字/留空 → None (5.0s 默认).
    返回 None 表示调用方应跳过 timestamp 累加 (未知长度).
    帧网格公式: round(frames / 24 * 1000) (与 prompt_assembler._format_shot_prefix 同口径).

    注: R4 修复后, 累计多个镜时间戳应累加帧数再统一换算 ms (避免逐段 ms 舍入漂移);
    本函数保留用于"单镜渲染时长"语义, 累计路径应改用 _row_duration_frames + 末尾换算。

    1.13h 2a: seg_override_dur = 侧车段级时长 (秒), 优先级高于 CSV; 透传给 _row_duration_frames.
    """
    frames = _row_duration_frames(row, seg_override_dur)
    if frames is None:
        return None
    return int(round(frames / 24.0 * 1000))


def _row_duration_frames(row, seg_override_dur=None):
    """从 row['段落时长'] 解析该镜渲染时长 (帧数). 缺键/非数字/留空 → None (5.0s 默认).

    R4 修复: 累计多镜时间戳时, 应累加**帧数**再统一换算 ms, 避免逐段 ms 舍入累积漂移。
    例如: 两段 124 帧 (5167ms) 累计, 旧路径 5167+5167=10334ms, 新路径 248 帧 → round(248/24*1000)
    = 10333ms (差 1ms, 12 镜 ≈ 4ms 漂移)。

    返回 None 表示调用方应跳过 timestamp 累加 (未知长度)。

    1.13h 2a: seg_override_dur (侧车段级时长/秒) 非空时优先于 CSV (侧车 > CSV);
    越界/非数字 → 打印原因并回落 CSV (装配期防御, 不崩批 — 写入时已由
    _seg_duration_frames 在端点侧拒绝, 此处只防手改侧车/旧版侧车)。
    """
    if seg_override_dur is not None and str(seg_override_dur).strip():
        try:
            return _seg_duration_frames(seg_override_dur)
        except ShotError as e:
            print("[H3Batch] 段级时长覆盖非法, 回落 CSV: %s" % e, flush=True)
    dur_raw = row.get("段落时长")
    if dur_raw is None:
        return None
    s = str(dur_raw).strip()
    if not s:
        sec = 5.0  # 留空 = 5s 默认 (与 _apply_shot_common 行为一致)
    else:
        try:
            sec = float(s)
        except ValueError:
            return None
    return _frame_grid_frames_for_seconds(sec)


def _frames_to_ms(frames):
    """R4 辅助: 帧数 → ms (一次换算, 与 _format_shot_prefix 同口径: round(frames/24*1000))."""
    return int(round(frames / 24.0 * 1000))


def parse_queue_file(path):
    """解析队列清单 CSV(utf-8-sig, 表头 csv_path,mode,repeat)。
    mode 空=分镜, repeat 空/非数字=1(合法范围 1-50); 无 csv_path 或 mode/repeat 非法的行
    print 原因后跳过, 不整体报错。返回 [{csv_path, mode, repeat}, ...]。"""
    tasks = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            cells = [c.strip() for c in row]
            if not any(cells) or cells[0].lower() == "csv_path":
                continue
            csv_path, mode, rep = (cells + ["", "", ""])[:3]
            if not csv_path:
                print("[H3Batch] 队列行缺少 csv_path, 跳过: %s" % ",".join(cells), flush=True)
                continue
            mode = QUEUE_MODE_ALIASES.get((mode or "分镜").lower(), mode or "分镜")
            if mode not in QUEUE_MODES:
                print("[H3Batch] 队列行 mode 非法(%r, 只支持 分镜/拼接/自定义), 跳过: %s"
                      % (mode, csv_path), flush=True)
                continue
            if rep == "" or not rep.isdigit():
                if rep != "":
                    print("[H3Batch] 队列行 repeat 非数字(%r), 按 1 处理: %s" % (rep, csv_path), flush=True)
                repeat = 1
            elif 1 <= int(rep) <= 50:
                repeat = int(rep)
            else:
                print("[H3Batch] 队列行 repeat 超范围(%r, 合法 1-50), 跳过: %s" % (rep, csv_path), flush=True)
                continue
            tasks.append({"csv_path": os.path.abspath(csv_path), "mode": mode, "repeat": repeat})
    return tasks


def _load_progress(progress_path):
    if os.path.exists(progress_path):
        try:
            return json.load(open(progress_path, encoding="utf-8"))
        except Exception:
            pass
    return {"done": {}}


def _save_progress(progress_path, progress):
    json.dump(progress, open(progress_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def _run_engine_once(engine):
    errs = engine.preflight()
    if errs:
        print("[H3Batch] 预检未通过: %s\n  %s" % (engine.csv_path, "\n  ".join(errs)), flush=True)
        return False
    for w in getattr(engine, "_preflight_warns", []):
        print("[H3Batch] 警告: %s" % w, flush=True)
    engine.run()
    return True


def run_repeats(make_engine, repeat):
    """单任务连跑 repeat 遍: make_engine(suffix) 每遍新建引擎(独立 manifest/种子)。
    某遍失败继续下一遍, 结束 print 汇总。
    T1: 下一遍 make_engine 前 join 上一引擎收尾线程 (含跨 task 边界, getattr 防护桩引擎)。"""
    failed = []
    last_eng = None
    for i in range(1, repeat + 1):
        # T5: 上一遍引擎被 cancel → 余遍不跑 (F4 段归属传播到 repeat)
        if last_eng is not None and getattr(last_eng, "_stop", None) is not None and last_eng._stop.is_set():
            print("[H3Batch] 上一遍引擎已停止, 余遍不跑 (cancel 已传播到 repeat)", flush=True)
            failed.append(i)
            break
        # T1 (D4): 下一引擎构造前等上一引擎收尾完成 (getattr 防护测试桩引擎无 join_finalize)
        if last_eng is not None:
            _j = getattr(last_eng, "join_finalize", None)
            if _j:
                _j()
        suffix = "" if repeat == 1 else "_rep%d" % i
        try:
            eng = make_engine(suffix)
            last_eng = eng
            _run_engine_once(eng)
        except Exception:
            failed.append(i)
            print("[H3Batch] 第 %d/%d 遍异常:\n%s" % (i, repeat, traceback.format_exc()), flush=True)
    if repeat > 1:
        print("[H3Batch] 批次次数汇总: %d 遍, 失败 %d 遍%s"
              % (repeat, len(failed), ("(" + ",".join(map(str, failed)) + ")") if failed else ""),
              flush=True)


def run_queue(tasks, make_engine, progress_path):
    """队列串行执行: 每行按 repeat 逐遍跑, 逐项落 progress(done 标记),
    重跑队列时跳过 done 项; 行失败不中断后续行。make_engine(task, rep, suffix)。
    T5: cancel 命中引擎后, 当前批余段已由 run() 标 stopped, progress[done] 不标 key
    (断点续跑可重扫该批), 后续批不跑。
    T1: 跨 task 边界也 join 上一引擎收尾 (getattr 防护桩引擎), 防同目录键覆盖误 pop。"""
    progress = _load_progress(progress_path)
    last_eng = None
    for task in tasks:
        cancelled_in_batch = False
        for rep in range(1, task["repeat"] + 1):
            key = "%s|%s|%d" % (task["csv_path"], task["mode"], rep)
            if progress["done"].get(key):
                print("[H3Batch] 队列项已完成, 跳过: %s" % key, flush=True)
                continue
            if not os.path.exists(task["csv_path"]):
                print("[H3Batch] 队列项 csv 不存在, 跳过: %s" % task["csv_path"], flush=True)
                continue
            suffix = "" if task["repeat"] == 1 else "_rep%d" % rep
            eng = None
            try:
                # T1 (D4): 下一引擎构造前等上一引擎收尾完成 (跨 task 边界亦生效)
                if last_eng is not None:
                    _j = getattr(last_eng, "join_finalize", None)
                    if _j:
                        _j()
                eng = make_engine(task, rep, suffix)
                last_eng = eng
                _run_engine_once(eng)
                # 引擎 _stop set (cancel) → 不标 done (断点续跑可重扫该批)
                if getattr(eng, "_stop", None) is not None and eng._stop.is_set():
                    cancelled_in_batch = True
                    print("[H3Batch] 队列项已被停止, 不标 done, 余批不跑: %s" % key, flush=True)
                else:
                    progress["done"][key] = True
            except Exception:
                # 引擎构造失败等意外也记 done, 不阻塞其余行
                progress["done"][key] = True
                print("[H3Batch] 队列项异常(跳过):\n%s" % traceback.format_exc(), flush=True)
            _save_progress(progress_path, progress)
            if cancelled_in_batch:
                # 跳出 repeat 循环, 后续 task 不跑
                break
        if cancelled_in_batch:
            # 跳出 tasks 循环
            break
    print("[H3Batch] 队列结束: %s" % progress_path, flush=True)


def join_all_finalize(timeout=60):
    """T1: 锁内快照遍历 join 全部在途收尾线程 (conftest/teardown 收口用)。
    锁外 join 避免与 _finalize_async 注册/start 同锁串行。"""
    with _finalize_lock:
        threads = list(_finalize_threads.values())
    deadline = time.time() + timeout
    for t in threads:
        t.join(max(0.1, deadline - time.time()))


def _retry_delay(attempt):
    """段重试指数退避: 第 attempt 次失败后等 5*2^attempt 秒, 上限 60 秒。"""
    return min(5 * (2 ** attempt), 60)


# V1.9 T4.5 D1 — 确定性错误分类: 重试注定失败的错误不退避不重试 (真机案例:
# turbo LoRA 与主模型不配套 → shape '[96768,16]' invalid for input of size 534484,
# retries=2 重试 2 次全炸纯浪费)。瞬时错误 (网络/超时/OSError 族) 保持现有重试。
_DETERMINISTIC_EXC_NAMES = ("TypeError", "ValueError", "KeyError", "RuntimeError", "NoCapableBackendError")
_DETERMINISTIC_MSG_PATTERNS = (
    "shape",               # shape '[96768, 16]' is invalid for input of size ... / shape mismatch
    "invalid for input",   # torch view/reshape 尺寸对不上 (LoRA 与主模型不配套)
    "unexpected keyword",  # ...() got an unexpected keyword argument ... (签名不匹配)
    "not recognized",
    "no such file",
    "dimension",           # Dimension out of range / dimensions mismatch
    "no backend can handle",  # comfy_kitchen NoCapableBackendError (算子 dtype 契约不匹配, 重试无意义)
)


def _is_deterministic_error(exc_type, message):
    """V1.9 T4.5 D1 确定性错误判定 (纯函数)。

    exc_type: 异常类, 或服务端 history execution_error.exception_type 字符串
              (如 "RuntimeError" / "builtins.RuntimeError" / "torch.OutOfMemoryError");
    message:  异常消息 str。
    True = 类型 ∈ (TypeError, ValueError, KeyError, RuntimeError, NoCapableBackendError)
            且消息匹配确定性模式 → 重试注定失败, 不重试; 其余 (含网络/超时/OSError 族) → False。
    """
    if isinstance(exc_type, type):
        known = issubclass(exc_type, (TypeError, ValueError, KeyError, RuntimeError)) or exc_type.__name__ in _DETERMINISTIC_EXC_NAMES
    else:
        known = str(exc_type or "").split(".")[-1] in _DETERMINISTIC_EXC_NAMES
    if not known:
        return False
    msg = str(message or "").lower()
    return any(p in msg for p in _DETERMINISTIC_MSG_PATTERNS)


# V1.9 T2.3 R3 LoRA 链式注入引擎 — 常量
# - LORA_CLASS_TYPES: 模板链上需要识别的三类 LoRA 节点 (T0.4 实测签名)
# - MODEL_LOADER_TYPES: 无 LoRA 时的锚点候选 (UNETLoader 等 model 输出加载点)
# - INJECT_CLASS: 注入使用标准 LoraLoaderModelOnly (单强度, 模板广泛使用)
# - FINGERPRINT_VERSION: 指纹常量, 注入算法变化时 bump 版本号让旧指纹失效
LORA_CLASS_TYPES = ("LoraLoader", "LoraLoaderModelOnly", "MiniMaxH3TurboLoRA")
MODEL_LOADER_TYPES = ("UNETLoader", "CheckpointLoader", "CheckpointLoaderSimple")
INJECT_CLASS = "LoraLoaderModelOnly"
FINGERPRINT_VERSION = "h3-r3-v3"  # V1.9 T4.4b: bump for lora_overrides 维度加入 (旧 v2 指纹失效)
# V1.11 批4 T5: UI-only 节点白名单 — 无 API 提交意义, convert 不触发未注册类型拦截
_UI_ONLY_NODE_TYPES = frozenset({"Note", "MarkdownNote", "Reroute"})
# 1.14 整改批 F · P3: 未知节点三态 (T-B 预案③ — 报告 :36 "未知节点隔离")
# 服务器 /object_info 不含 (且非 Primitive / 非 UI-only 白名单) 的节点类型处理策略:
#   error       = 现状零回归: 收集类型名, convert 收尾抛 ShotError (默认)
#   passthrough = 未知节点原样透传: 仅转写模板显式连线, 禁 widget 回填/禁改 link
#                 (opaque 深比较不变), 可行性交给服务器端判定
#   strip       = 未知节点剔除 + 下游引用等价 UI bypass (单入线链直连上游; 不可解剔除该输入)
# 运行时读环境变量 (先例 H3_DISABLE_PORT_DETECT @_detect_port), 白名单外取值即抛 (不静默退化).
UNKNOWN_POLICY_ENV = "H3_UNKNOWN_POLICY"
_UNKNOWN_POLICIES = ("error", "passthrough", "strip")


def _read_unknown_policy():
    """读 H3_UNKNOWN_POLICY; 未设/空 = error (默认零回归)。"""
    p = (os.environ.get(UNKNOWN_POLICY_ENV) or "").strip() or "error"
    if p not in _UNKNOWN_POLICIES:
        raise ShotError("%s 只支持 error|passthrough|strip, 收到: %r" % (UNKNOWN_POLICY_ENV, p))
    return p


def _strip_rewire(nodes, links, origin, oidx, strip_ids):
    """strip 等价 UI bypass: 沿被剔除节点的单入线链向上解析直连来源.

    strip_ids: 被剔除节点 id 集 (模板 JSON 原 id). 返回 (origin, oidx);
    不可解 (0/多入线、断链、环) 返回 None → 调用方剔除该输入.
    """
    seen = set()
    cur, cur_slot = origin, oidx
    while cur in strip_ids:
        if cur in seen:
            return None
        seen.add(cur)
        node = nodes.get(cur) or {}
        in_links = [i["link"] for i in node.get("inputs", []) if i.get("link") is not None]
        if len(in_links) != 1:
            return None
        row = links.get(in_links[0])
        if row is None:
            return None
        cur, cur_slot = row[1], row[2]
    return cur, cur_slot


# RTXVideoSuperResolution V3 quality 白名单 (V3 DynamicCombo 节点合法档)
_RTX_QUALITY_OPTIONS = ("LOW", "MEDIUM", "HIGH", "ULTRA")
# 1.14b U2: SeedVR2 + RIFE VFI 节点枚举白名单 (本机源码 2026-09-16 核对 — seedvr2_videoupscaler/src/interfaces/video_upscaler.py:158, ComfyUI-Frame-Interpolation/vfi_models/rife/__init__.py)
_SEEDVR2_COLOR_CORRECTION = ("lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none")
_SEEDVR2_OFFLOAD_DEVICE = ("none", "cpu")  # 简化白名单; 真枚举含 cuda:X — 任务单让 options 兜底
_RIFE_CKPT_DEFAULT = "rife49.pth"
# V1.11 批4 T4 D3: PDD 加速节点 — MiniMaxH3PDDAccApply 节点带 PDD 加速文件,
#   nfe 参数只支持 4/6/8 (字符串 combo); 风格 lora 需挂在 SigmaShift 与本节点之间 (D4)
PDD_ACC_CLASS = "MiniMaxH3PDDAccApply"
_PDD_NFE_VALID = (4, 6, 8)


def _compute_inject_fingerprint(resources, overrides=None, lora_overrides=None,
                                adapter_plan=None):
    """V1.9 T4.4b 三联合指纹 (纯函数): 版本常量 + resources + overrides + lora_overrides
    各维 canonical JSON sha256[:12].

    canonical: 排序键 + 紧凑分隔符 + utf-8 + 非 ASCII 保留; 同输入永远同指纹.
    lora_overrides 加入后: 模板 LoRA 强度/禁用覆写变化 → 指纹变 → 缓存自然失效
    (T2.5 双维度升级为 T4.4b 三维度).

    Args:
        resources: list[dict] (实际注入集, template 源已被 _inject_loras 过滤)
        overrides: dict 资源覆写 (unet/clip/vae_*); 缺省 None → 视作空 (向后兼容 T2.3/T2.5)
        lora_overrides: dict 模板 LoRA 覆写 ({文件名: {strength|disabled}});
                        缺省 None → 视作空 (向后兼容)
        adapter_plan: dict (P6 新增, 可选); AdapterPlan 报告稳定事实投影 =
                      重跑指纹第 4 维 (报告字段参与重跑指纹, T-B 预案⑥ :42);
                      缺省 None → 该维度不参与 (旧 manifest/旧调用方指纹逐字节
                      不变, 故不 bump FINGERPRINT_VERSION).
    """
    canonical_res = json.dumps(list(resources or []), sort_keys=True,
                               separators=(",", ":"), ensure_ascii=False)
    canonical_over = json.dumps(overrides or {}, sort_keys=True,
                                separators=(",", ":"), ensure_ascii=False)
    canonical_lora = json.dumps(lora_overrides or {}, sort_keys=True,
                                separators=(",", ":"), ensure_ascii=False)
    h = hashlib.sha256()
    h.update(FINGERPRINT_VERSION.encode("utf-8"))
    h.update(b"|")
    h.update(canonical_res.encode("utf-8"))
    h.update(b"|")
    h.update(canonical_over.encode("utf-8"))
    h.update(b"|")
    h.update(canonical_lora.encode("utf-8"))
    if adapter_plan is not None:
        h.update(b"|")
        h.update(json.dumps(adapter_plan, sort_keys=True,
                            separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    return h.hexdigest()[:12]


def _find_chain_tail_nid(prompt):
    """在 API 形态 prompt 中找 LoRA 链的"末端"节点 nid.

    末端定义 (主规则): 该 LoRA 的 model 输出 (slot 0) 的"直接下游"中存在非 LoRA 节点
    (BasicGuider 等) — 这是规范链尾, 即"链上最后一个 LoRA, 之后接消费者".

    兜底: 若所有 LoRA 的直接下游都是 LoRA (如 A → B 串联但 B 无下游, 死端),
    则用传递可达性选"传递可达非 LoRA 数最多"的 LoRA, 平局选 nid 最小.
    所有 LoRA 都无传递可达非 LoRA → None (调用方回退到 MODEL_LOADER_TYPES).

    Returns:
        str or None — 若 prompt 内无任何 LORA_CLASS_TYPES 节点 → None
                       (此时调用方应回退到 MODEL_LOADER_TYPES 锚点)

    选择规则:
    1. 直接非 LoRA 下游数最多者胜 (主规则)
    2. 平局 nid 最小者
    3. 兜底: 传递可达非 LoRA 数最多者; 平局 nid 最小
    """
    lora_set = {nid for nid, n in prompt.items()
                if n.get("class_type") in LORA_CLASS_TYPES}
    if not lora_set:
        return None
    # 构建 forward map: nid -> [(dst, iname)] (沿 model 输出 slot 0 走)
    forward = {}
    for nid, n in prompt.items():
        for iname, val in (n.get("inputs") or {}).items():
            if isinstance(val, list) and len(val) == 2:
                s_nid, s_slot = val
                try:
                    if int(s_slot) == 0:
                        forward.setdefault(str(s_nid), []).append((str(nid), iname))
                except (TypeError, ValueError):
                    pass
    # 主规则: 直接非 LoRA 下游
    direct_candidates = []
    for lora in lora_set:
        outs = forward.get(str(lora), [])
        direct_nonlora = [d for d, _ in outs if d not in lora_set]
        if direct_nonlora:
            direct_candidates.append((str(lora), len(direct_nonlora)))
    if direct_candidates:
        direct_candidates.sort(key=lambda x: (-x[1], int(x[0])))
        return direct_candidates[0][0]
    # 兜底: 传递可达非 LoRA
    transitive_candidates = []
    for lora in lora_set:
        nonlora = set()
        seen = set()
        queue = [str(lora)]
        while queue:
            cur = queue.pop()
            if cur in seen:
                continue
            seen.add(cur)
            if cur != str(lora) and cur not in lora_set:
                nonlora.add(cur)
            for dst, _ in forward.get(cur, []):
                if dst not in seen:
                    queue.append(dst)
        if nonlora:
            transitive_candidates.append((str(lora), len(nonlora)))
    if not transitive_candidates:
        return None
    transitive_candidates.sort(key=lambda x: (-x[1], int(x[0])))
    return transitive_candidates[0][0]


def _find_model_loader_nid(prompt):
    """无 LoRA 时回退锚点: 找 MODEL_LOADER_TYPES 节点 (按 nid 最小稳定可重现)."""
    loaders = [nid for nid, n in prompt.items()
               if n.get("class_type") in MODEL_LOADER_TYPES]
    if not loaders:
        return None
    return min(loaders, key=lambda x: int(x))


def _find_model_downstream(prompt, src_nid):
    """找 src_nid 的 model 输出 (slot 0) 所连的"第一个非 LoRA 下游"输入 slot.

    Returns:
        (downstream_nid_str, input_name_str) or None
        None = src 的 model 输出无任何下游 / 全流向 LoRA (循环, 罕见).

    优先级(V1.11 批4 T5 前向修复):
    1. BasicGuider.model — 采样唯一前向消费点 (SamplerCustomAdvanced 无独立 model
       入参, 走 guider 间接消费). 注入挂 BasicGuider.model 而非调度支/悬空支, 防
       LoRA 注入从未生效. 多 BasicGuider 取 nid 最小.
    2. 无 BasicGuider → 既有排序: 非 LoRA 节点优先 (1 > 0); 平局 nid 最大.

    BasicGuider 在 EXPT8/PDD/CK 等多模板族里与 SigmaShift/BasicScheduler 共用
    同源 model 输出 (fan-out). 选调度支会让注入挂死节点; 选悬空支 EXPT8 model
    入参完全无下游. 选 BasicGuider.model 是唯一前向路径.
    """
    target = str(src_nid)
    candidates = []
    lora_set = {nid for nid, n in prompt.items()
                if n.get("class_type") in LORA_CLASS_TYPES}
    for nid, n in prompt.items():
        for iname, val in (n.get("inputs") or {}).items():
            if not (isinstance(val, list) and len(val) == 2):
                continue
            s_nid, s_slot = val
            try:
                if str(s_nid) == target and int(s_slot) == 0:
                    # 评分: 非 LoRA 优先 (1) > LoRA (0); 平局 nid 最大
                    score = 0 if nid in lora_set else 1
                    candidates.append((score, -int(nid), nid, iname))
            except (TypeError, ValueError):
                continue
    if not candidates:
        return None
    # 前向优先: BasicGuider.model (采样唯一消费点)
    bg_candidates = [(nid, iname) for score, _, nid, iname in candidates
                     if score and prompt[nid].get("class_type") == "BasicGuider"
                     and iname == "model"]
    if bg_candidates:
        bg_nid, bg_iname = min(bg_candidates, key=lambda x: int(x[0]))
        return str(bg_nid), bg_iname
    candidates.sort(key=lambda x: (-x[0], x[1], x[2]))
    score, _, nid, iname = candidates[0]
    if score == 0:
        # 全是 LoRA (循环), 无可重连的下游
        return None
    return str(nid), iname


# 1.14 整改批 F · P4: discover_io 插入点精确化 (T-B 预案③ — 报告 :38)
# 现状判边 = 位置猜测 (src 槽硬编码 0 + 硬编码类型表), 多候选靠 nid/类名启发式.
# 本节以 schema (object_info input/output 声明) 精确判定 MODEL 边:
#   src 输出槽声明类型 == "MODEL" 且 dst 输入声明接受 MODEL ("MODEL" 或通配 "*").
# 未知类型端点 (引擎不认识但 schema 有声明) 可参与; 类型不可证的一端不猜 → 不计入.
# schema=None (离线/旧调用) → 调用方走旧启发式, 行为逐字节不变.
MODEL_EDGE_CAND_LIMIT = 20  # no_model_edge 诊断候选上限 (防大图报告膨胀)


def _schema_out_types(schema, class_type):
    """object_info[class_type]["output"] 槽类型表; 无记录 → None (不可判定)."""
    e = schema.get(class_type) if isinstance(schema, dict) else None
    if not isinstance(e, dict):
        return None
    o = e.get("output")
    return o if isinstance(o, list) else None


def _schema_input_spec(schema, class_type, in_name):
    """输入声明 (required 优先, optional 次之); 无记录 → None (不可判定)."""
    e = schema.get(class_type) if isinstance(schema, dict) else None
    if not isinstance(e, dict):
        return None
    ins = e.get("input")
    if not isinstance(ins, dict):
        return None
    spec = (ins.get("required") or {}).get(in_name)
    if spec is None:
        spec = (ins.get("optional") or {}).get(in_name)
    return spec


def _schema_accepts_model(schema, class_type, in_name):
    """dst 输入是否声明接受 MODEL. True/False; None = 不可判定 (类或输入不在 schema)."""
    spec = _schema_input_spec(schema, class_type, in_name)
    if spec is None:
        return None
    t = spec if isinstance(spec, str) else (spec[0] if isinstance(spec, list) and spec else None)
    if isinstance(t, str):
        return t in ("MODEL", "*")  # "*" = ComfyUI 通配输入, 接受任意类型
    return False  # COMBO/嵌套声明不是 MODEL 链接输入


def _discover_model_edges(prompt, schema):
    """schema 可证 MODEL 边全枚举: src MODEL 输出槽 → dst 接受 MODEL 的输入.

    返回 list[dict] = {src, out_slot, dst, in_name, src_class, dst_class},
    确定序: (src nid 数值, out_slot, dst nid 数值, in_name) 升序。
    """
    edges = []
    for nid, n in prompt.items():
        if not isinstance(n, dict):
            continue
        for iname, val in (n.get("inputs") or {}).items():
            if not (isinstance(val, list) and len(val) == 2):
                continue
            try:
                snid, slot = str(val[0]), int(val[1])
            except (TypeError, ValueError):
                continue
            src = prompt.get(snid)
            if not isinstance(src, dict):
                continue
            outs = _schema_out_types(schema, src.get("class_type"))
            if not outs or not (0 <= slot < len(outs)) or outs[slot] != "MODEL":
                continue
            if _schema_accepts_model(schema, n.get("class_type"), iname) is not True:
                continue
            edges.append({"src": snid, "out_slot": slot, "dst": str(nid), "in_name": iname,
                          "src_class": src.get("class_type"), "dst_class": n.get("class_type")})
    edges.sort(key=lambda e: (int(e["src"]), e["out_slot"], int(e["dst"]), e["in_name"]))
    return edges


def _model_edge_candidates(prompt, schema):
    """no_model_edge 诊断候选: 单端 MODEL 可证/单端不可判定的近失边.

    rejected ∈ {dst_input_not_model, dst_input_unverified,
                src_output_not_model, src_output_unverified};
    确定序同 _discover_model_edges; 上限 MODEL_EDGE_CAND_LIMIT。
    """
    cands = []
    for nid, n in prompt.items():
        if not isinstance(n, dict):
            continue
        for iname, val in (n.get("inputs") or {}).items():
            if not (isinstance(val, list) and len(val) == 2):
                continue
            try:
                snid, slot = str(val[0]), int(val[1])
            except (TypeError, ValueError):
                continue
            src = prompt.get(snid)
            if not isinstance(src, dict):
                continue
            outs = _schema_out_types(schema, src.get("class_type"))
            if outs is None:
                src_t = None
            elif 0 <= slot < len(outs):
                src_t = outs[slot]
            else:
                continue  # 槽越界: 模板坏边, 非 MODEL 近失诊断对象
            dst_ok = _schema_accepts_model(schema, n.get("class_type"), iname)
            if src_t != "MODEL" and dst_ok is not True:
                continue  # 两端都与 MODEL 无关
            if src_t == "MODEL" and dst_ok is True:
                continue  # 完整 MODEL 边 (调用方仅在全图无边时使用本函数)
            if src_t == "MODEL":
                why = "dst_input_not_model" if dst_ok is False else "dst_input_unverified"
            else:
                why = "src_output_not_model" if src_t is not None else "src_output_unverified"
            cands.append({"src": snid, "out_slot": slot, "dst": str(nid), "in_name": iname,
                          "rejected": why})
    cands.sort(key=lambda e: (int(e["src"]), e["out_slot"], int(e["dst"]), e["in_name"]))
    return cands[:MODEL_EDGE_CAND_LIMIT]


def _pick_edge_for_anchor(edges, anchor, prompt):
    """锚点档内选择 (与 _find_model_downstream 同序): BasicGuider.model (dst nid 最小) 优先;
    否则非 LoRA 下游优先、dst nid 最大; 全 LoRA 环 → None."""
    cands = [e for e in edges if e["src"] == anchor]
    if not cands:
        return None
    bg = [e for e in cands if e["in_name"] == "model" and e["dst_class"] == "BasicGuider"]
    if bg:
        return min(bg, key=lambda e: (int(e["dst"]), e["out_slot"], e["in_name"]))
    lora_set = {nid for nid, n in prompt.items()
                if isinstance(n, dict) and n.get("class_type") in LORA_CLASS_TYPES}
    scored = [(0 if e["dst"] in lora_set else 1, e) for e in cands]
    scored.sort(key=lambda x: (-x[0], -int(x[1]["dst"]), x[1]["out_slot"], x[1]["in_name"]))
    if scored[0][0] == 0:
        return None  # 下游全是 LoRA (环), 无可重连
    return scored[0][1]


def _select_model_edge(prompt, schema):
    """P4 插入点优先序 (确定性; 仅 schema 可证 MODEL 边参与):

    1) 模板 LoRA 链尾锚点 (_find_chain_tail_nid) 的 MODEL 边 — 档内序同 legacy;
    2) model loader 锚点 (_find_model_loader_nid, nid 最小) 的 MODEL 边 — 档内序同上;
    3) schema 兜底 (引擎硬编码类型表外的端点): 消费端优先 (dst 不产出 MODEL, 即
       guider/sampler 类 model 入参边) → BasicGuider 优先 → src nid 升序 → out_slot →
       dst nid 升序 → 输入名。

    返回边 dict; 无任何 schema 可证 MODEL 边 → None (调用方报 no_model_edge)。
    """
    edges = _discover_model_edges(prompt, schema)
    if not edges:
        return None
    tail = _find_chain_tail_nid(prompt)
    if tail is not None:
        e = _pick_edge_for_anchor(edges, str(tail), prompt)
        if e is not None:
            return e
    loader = _find_model_loader_nid(prompt)
    if loader is not None:
        e = _pick_edge_for_anchor(edges, str(loader), prompt)
        if e is not None:
            return e

    def _sink(e):
        return "MODEL" not in (_schema_out_types(schema, e["dst_class"]) or [])

    return min(edges, key=lambda e: (0 if _sink(e) else 1,
                                     0 if e["dst_class"] == "BasicGuider" else 1,
                                     int(e["src"]), e["out_slot"], int(e["dst"]),
                                     e["in_name"]))


# V1.11 批4 T4 D2/D5: LoRA 类别归类 — 与前端 classify_resource / 后端 _parse_resources_list
#   的 category 字段同源; 编排条目 category 字段优先, 缺省走文件名启发式 (turbo/h3/minimax).
#   None → style (安全侧: 与风格 lora 同组, 注入链后段, 不破坏样式; 而 turbo 前段需
#   显式命中, 避免误把风格类当加速类).
def _classify_injectable(entry):
    """单条 LoRA 编排条目的类别归类 (D2 排序 + D5 互斥判定同源).

    Args:
        entry: dict with optional "category" and "name".

    Returns:
        "turbo" | "style"
    """
    if not isinstance(entry, dict):
        return "style"
    cat = entry.get("category")
    if cat in ("turbo", "style"):
        return cat
    name = (entry.get("name") or "").lower()
    if "turbo" in name:
        return "turbo"
    return "style"


def _sort_injectable_for_chain(injectable):
    """D2: turbo 组前, style 组后; 组内保数组序 (stable sort by key).

    输入/输出均为 list[dict], 返回新列表 (不修改入参, 利于单测)。
    """
    return sorted(injectable, key=lambda e: 0 if _classify_injectable(e) == "turbo" else 1)


def _has_pdd_accelerator(prompt):
    """D3/D4/D5: prompt 图是否含 MiniMaxH3PDDAccApply 节点 (纯函数)."""
    if not isinstance(prompt, dict):
        return False
    return any(n.get("class_type") == PDD_ACC_CLASS for n in prompt.values())


def _validate_pdd_steps(steps_raw):
    """D3 + D5: 校验步数串是否适合 PDD 模板.

    返回 None = 通过; str = 报错文案.
    - 空串: 返回 None (不写 nfe, 用模板默认 8)
    - 非空但不可解析: 返回 报错
    - 可解析但 V != A: 返回 报错
    - 可解析但 V ∉ {4,6,8}: 返回 报错
    """
    if not steps_raw:
        return None
    m = re.match(r"(\d+)\s*([VA])\s*(\d+)\s*([VA])", steps_raw, re.IGNORECASE)
    if not m:
        return ("PDD 模板步数 '%s' 无法识别, 应为 NVNA (大写 V/A)" % steps_raw)
    v = int(m.group(1)) if m.group(2).upper() == "V" else int(m.group(3))
    a = int(m.group(3)) if m.group(2).upper() == "V" else int(m.group(1))
    if a != v:
        return ("PDD 模板步数视频/音频必须一致 (收到 %dV%d, "
                "PDD 仅支持等步如 8V8A)" % (v, a))
    if v not in _PDD_NFE_VALID:
        return ("PDD 模板步数 %d 只支持 4/6/8, 当前 %d" % (v, v))
    return None


def _inject_loras(prompt, resources, fresh_id, overrides=None, lora_overrides=None,
                  schema=None):
    """V1.9 T2.5 注入引擎 (纯函数): 编排 LoRA 链按数组序串接在模板 model 链末端之后.

    Args:
        prompt: API 形态 dict {str(nid): {"class_type": str, "inputs": dict}}, 只读
                (函数内对 inputs 做浅拷贝; 不修改原 dict)
        resources: list[dict], 每条 5 字段 (来自 _parse_resources_list)
        fresh_id: 无参回调 → 返回新 int 节点 id (引擎 self._fresh_id 即可)
        overrides: dict (V1.9 T2.5 新增, 可选); 资源覆写 (来自 _parse_overrides);
                   联合指纹计算包含此维度; 缺省 None → 视作空 dict (向后兼容 T2.3 单维度指纹)
        lora_overrides: dict (V1.9 T4.4b 新增, 可选); 模板 LoRA 覆写
                        (来自 _parse_lora_overrides); 三联合指纹计算包含此维度;
                        缺省 None → 视作空 dict (向后兼容 T2.5 双维度指纹).
                        注: 本函数不执行覆写 (结构不动), 只把该维度纳入指纹;
                        实际值覆写在 _apply_lora_overrides (convert 同环节, 先于注入).
        schema: dict (P4 新增, 可选); object_info 形态 {class_type: {input, output}}.
                提供 → 插入点按 schema 类型声明精确发现 (_select_model_edge 优先序),
                找不到 MODEL 边 → reason="no_model_edge" + candidates;
                缺省 None → 旧启发式路径 (无 schema 环境/旧调用), 行为逐字节不变.

    Returns:
        (new_prompt: dict, report: dict)
        report = {
            "injected": bool,
            "reason": str,
            "anchor": str,           # 锚点 nid (str) 或 ""
            "nodes": [int, ...],     # 注入的 LoRA 节点 nid 列表
            "fingerprint": str,      # 12-hex sha256 前缀 (V1.9 T4.4b 起 = resources + overrides + lora_overrides 三联合)
            "candidates": [dict],    # 仅 schema 路径 no_model_edge 失败时: 近失边诊断
        }

    失败语义:
    - resources=[] → (浅拷贝 prompt, {injected:False, reason:"", ...}), 不污染图
    - 无锚点 (无 LoRA + 无 model loader) → 同上 + reason 明确
    - 锚点无下游可重连 → 同上 + reason 明确
    - schema 路径无 MODEL 边 → reason="no_model_edge" + candidates (结构化)

    T2.7 防御层: 跳过 source=="template" 条目 — 模板自带 LoRA 由模板自带节点承担,
    不应被注入引擎二次实例化 (否则双重叠加). 指纹按"实际注入集"计算,
    保证同实际注入 → 同指纹 (template 增删不改指纹).

    V1.11 批4 T4 D2: 排序 — turbo 组前, style 组后 (组内数组序保序); 指纹按排序后序列计算
    (等价列表仅排序不同 → 同指纹, 避免仅因类别推断缓存失效).
    V1.11 批4 T4 D4: PDD 模板 (含 MiniMaxH3PDDAccApply) → 锚点改为该节点 model 上游,
    下游即 PDDAccApply 的 model 槽 (风格 lora 官方位置). 非 PDD 模板零变化.
    """
    # 浅拷贝 (每节点 inputs 单独 dict 拷贝, 顶层 nid 拷贝; 不递归深拷避免大图开销)
    new_prompt = {nid: {"class_type": n["class_type"],
                         "inputs": dict(n.get("inputs") or {})}
                  for nid, n in prompt.items()}
    # T2.7: 过滤 template 源条目; D2: 排序 (turbo 前, style 后, 组内保序)
    injectable = [e for e in (resources or []) if e and e.get("source") != "template"]
    injectable = _sort_injectable_for_chain(injectable)
    fingerprint = _compute_inject_fingerprint(injectable, overrides=overrides,
                                              lora_overrides=lora_overrides)

    # 空列表 (含全部被过滤掉): 正常状态, 不报错, 不修改图
    if not injectable:
        return new_prompt, {
            "injected": False, "reason": "", "anchor": "",
            "nodes": [], "fingerprint": fingerprint,
        }

    # D4: PDD 模板锚点 — PDDAccApply 的 model 输入上游; 下游即 PDDAccApply.model 槽
    anchor_nid = None
    downstream_nid = None
    downstream_iname = None
    anchor_out_slot = 0  # P4: schema 路径的真实 MODEL 输出槽; legacy/PDD 恒 0 (现状不变)
    if _has_pdd_accelerator(new_prompt):
        pdd_nid = next((nid for nid, n in new_prompt.items()
                        if n.get("class_type") == PDD_ACC_CLASS), None)
        if pdd_nid is not None:
            src = new_prompt[pdd_nid]["inputs"].get("model")
            if isinstance(src, list) and len(src) == 2:
                anchor_nid = str(src[0])
                downstream_nid = pdd_nid
                downstream_iname = "model"

    # 锚点: 先 LoRA 链末端, 失败回退到 model loader (D4 未命中时走既有路径)
    if anchor_nid is None:
        if schema is not None:
            # P4: schema 精确 MODEL 边 (类型声明比对; 优先序见 _select_model_edge)
            edge = _select_model_edge(new_prompt, schema)
            if edge is None:
                return new_prompt, {
                    "injected": False, "reason": "no_model_edge", "anchor": "",
                    "nodes": [], "fingerprint": fingerprint,
                    "candidates": _model_edge_candidates(new_prompt, schema),
                }
            anchor_nid, anchor_out_slot = edge["src"], edge["out_slot"]
            downstream_nid, downstream_iname = edge["dst"], edge["in_name"]
        else:
            # schema 不可用 (离线/旧调用): 旧启发式路径, 行为逐字节不变
            anchor_nid = _find_chain_tail_nid(new_prompt)
            if anchor_nid is None:
                anchor_nid = _find_model_loader_nid(new_prompt)
            if anchor_nid is None:
                return new_prompt, {
                    "injected": False,
                    "reason": ("工作流无可识别 LoRA 锚点: model 链上未见 "
                               "LoraLoader/LoraLoaderModelOnly/MiniMaxH3TurboLoRA 或加载点"),
                    "anchor": "", "nodes": [], "fingerprint": fingerprint,
                }

            # 找锚点的 model 输出所连的第一个非 LoRA 下游 (D4 已确定时跳过)
            downstream = _find_model_downstream(new_prompt, anchor_nid)
            if downstream is None:
                return new_prompt, {
                    "injected": False,
                    "reason": "锚点 model 输出无可重连的下游 (工作流 model 链为孤立链, 无法注入)",
                    "anchor": str(anchor_nid), "nodes": [],
                    "fingerprint": fingerprint,
                }
            downstream_nid, downstream_iname = downstream

    # 构造注入链: 每条 = LoraLoaderModelOnly (单强度), model 输入 = 上一个节点输出
    # (链首取锚点真实输出槽 anchor_out_slot — schema 路径可能非 0; 链内恒 slot 0)
    prev_nid = str(anchor_nid)
    injected_nids = []
    for entry in injectable:
        nid = fresh_id()
        sm = entry.get("strength_model")
        if sm is None:
            sm = 1.0
        new_prompt[str(nid)] = {
            "class_type": INJECT_CLASS,
            "inputs": {
                "model": [prev_nid, anchor_out_slot if not injected_nids else 0],
                "lora_name": entry["name"],
                "strength_model": sm,
            },
        }
        prev_nid = str(nid)
        injected_nids.append(int(nid))

    # 最后一条注入节点 model 输出 → 原下游 (取代旧连线)
    new_prompt[downstream_nid]["inputs"][downstream_iname] = [prev_nid, 0]

    return new_prompt, {
        "injected": True, "reason": "", "anchor": str(anchor_nid),
        "nodes": injected_nids, "fingerprint": fingerprint,
    }


# ===== 1.14 整改批 F · P5: 不变量 I1-I6 自检 (T-B 预案④ — 报告 :40) =====
# 六不变量 (T-B 报告 :40 原文): I1 required 全绑定; I2 新增节点均在反向可达集
# (复用 _prune_orphans keep 集); I3 opaques 深比较零改动; I4 链接端点/slot 合法;
# I5 inputs 键 ∈ schema (∪前缀键); I6 未声明的边引用语义不变。
# 两步法: 默认 shadow 只记录 (self._invariant_report + 日志, 不 block);
# H3_INVARIANT_POLICY=block 时违规 → 段 failed error="invariant:<Ix>" 且不 POST。
# 落点 = _run_one 于 _prune_orphans 之后、_post("/prompt") 之前 (T-B 指定)。
# 判定口径 (与现有实现/服务端语义对齐, 细节见各不变量注释):
# - I1 前缀键满足 required: 服务端对 v3 节点按 finalize_prefix 组键 (MathExpression
#   values.a / RTX resize_type.scale 先例), 与 I5 "∪前缀键" 同口径;
# - I2 只查引擎新增节点 (id ∉ 模板); 引擎声明的终端节点 (续接 H3MotionContextSaveLatent
#   尾挂 — 设计允许不在 Save 根可达集) 由 declared_ids 放行;
# - I3 以 convert 时 opaque 快照 (仅 passthrough 态存在) 深比较 — 后续环节
#   (apply_shot_*/续接/剪枝) 不得改动或丢失未知节点;
# - I4 链接引用形态 = 2 元 list 且首元素 str (引擎输出形态); 端点必须存在、slot 非负
#   且在 schema output 槽数内 (schema 可证时);
# - I5 放行模板显式声明的输入名 (schema 快照可能落后于模板; 服务端忽略未声明多键);
# - I6 模板边与提交图逐边比对: 改指引擎新增节点 / 原来源节点被移除 = 声明类改写,
#   其余引用错位 (改指另一模板节点或改槽) = 违规; literal 覆盖不属边引用域。
INVARIANT_POLICY_ENV = "H3_INVARIANT_POLICY"
_INVARIANT_POLICIES = ("shadow", "block")


def _read_invariant_policy():
    """读 H3_INVARIANT_POLICY; 未设/空 = shadow (两步法第一步, 零回归)。"""
    p = (os.environ.get(INVARIANT_POLICY_ENV) or "").strip() or "shadow"
    if p not in _INVARIANT_POLICIES:
        raise ShotError("%s 只支持 shadow|block, 收到: %r" % (INVARIANT_POLICY_ENV, p))
    return p


def _invariant_name_bound(inputs, name):
    """I1/I5 键绑定判定: 精确名或 "<name>." 前缀子键 (服务端 finalize_prefix 口径)。"""
    return name in inputs or any(k.startswith(name + ".") for k in inputs)


def _invariant_keep_set(prompt):
    """Save 根反向可达集 (_prune_orphans 同口径的独立实现: 悬空引用不入集, 不抛)。"""
    import postfx_engine
    keep = {nid for nid, node in prompt.items()
            if postfx_engine._is_save_video((node.get("class_type") or ""))}
    changed = True
    while changed:
        new = set()
        for nid in keep:
            for v in (prompt[nid].get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2:
                    new.add(str(v[0]))
        before = len(keep)
        keep |= {n for n in new if n in prompt}
        changed = len(keep) > before
    return keep


def check_invariants(prompt, template=None, schema=None, opaque_snapshot=None,
                     declared_ids=()):
    """六不变量自检 (纯函数; T-B 报告 :40 I1-I6), 不改图。

    返回 [{"invariant": "I1"|..., "detail": str}, ...] (序 I1→I6, 同不变量内按图序);
    上下文缺省即跳过对应不变量 (template=None → 跳过 I2/I6; schema=None → 跳过
    I1/I5 与 I4 槽上界; opaque_snapshot=None → 跳过 I3)。
    """
    violations = []
    tpl_ids = set()
    tpl_nodes = {}
    if isinstance(template, dict):
        for n in template.get("nodes") or []:
            if isinstance(n, dict) and "id" in n:
                tpl_ids.add(str(n["id"]))
                tpl_nodes[str(n["id"])] = n

    # I1 / I5: schema 可证的输入面 (opaque 节点归 I3 域)
    if isinstance(schema, dict):
        for nid, node in prompt.items():
            ct = (node or {}).get("class_type")
            entry = schema.get(ct)
            if not isinstance(entry, dict):
                continue
            spec = entry.get("input") if isinstance(entry.get("input"), dict) else {}
            ins = node.get("inputs") or {}
            for name in (spec.get("required") or {}):
                if not _invariant_name_bound(ins, name):
                    violations.append({"invariant": "I1", "detail": (
                        "节点 %s(%s) required 输入 %s 未绑定" % (nid, ct, name))})
            names = set(spec.get("required") or {}) | set(spec.get("optional") or {})
            tpl_node = tpl_nodes.get(nid) or {}
            declared = {i.get("name") for i in (tpl_node.get("inputs") or []) if i.get("name")}
            allowed = names | declared
            for key in ins:
                if key in allowed or any(key.startswith(n + ".") for n in allowed):
                    continue
                violations.append({"invariant": "I5", "detail": (
                    "节点 %s(%s) 输入键 %s 不在 schema/模板声明 (含前缀键) 内" % (nid, ct, key))})

    # I2: 引擎新增节点必须反向可达 (Save 根) 或经 declared_ids 声明
    if isinstance(template, dict):
        keep = _invariant_keep_set(prompt)
        declared_new = {str(x) for x in (declared_ids or ())}
        for nid, node in prompt.items():
            if nid in tpl_ids or nid in keep or nid in declared_new:
                continue
            violations.append({"invariant": "I2", "detail": (
                "新增节点 %s(%s) 不在反向可达集" % (nid, (node or {}).get("class_type")))})

    # I3: opaque 深比较零改动 (快照 = convert passthrough 态)
    for nid, snap in (opaque_snapshot or {}).items():
        cur = prompt.get(nid)
        if cur is None:
            violations.append({"invariant": "I3", "detail": "opaque 节点 %s 丢失" % nid})
        elif (cur.get("inputs") or {}) != snap:
            violations.append({"invariant": "I3", "detail": "opaque 节点 %s inputs 被改动" % nid})

    # I4: 链接端点/slot 合法
    for nid, node in prompt.items():
        for name, val in ((node or {}).get("inputs") or {}).items():
            if not (isinstance(val, list) and len(val) == 2 and isinstance(val[0], str)):
                continue  # 非链接引用 (literal/其它 list widget) 不属本域
            if val[0] not in prompt:
                violations.append({"invariant": "I4", "detail": (
                    "节点 %s(%s).%s 链接悬空: 目标节点 %s 不存在"
                    % (nid, node.get("class_type"), name, val[0]))})
                continue
            if not isinstance(val[1], int) or isinstance(val[1], bool) or val[1] < 0:
                violations.append({"invariant": "I4", "detail": (
                    "节点 %s(%s).%s 链接 slot 非法: %r" % (nid, node.get("class_type"), name, val[1]))})
                continue
            if isinstance(schema, dict):
                src_entry = schema.get((prompt[val[0]] or {}).get("class_type"))
                outs = src_entry.get("output") if isinstance(src_entry, dict) else None
                if isinstance(outs, list) and val[1] >= len(outs):
                    violations.append({"invariant": "I4", "detail": (
                        "节点 %s(%s).%s 链接 slot 越界: %s 输出槽 %d ≥ %d"
                        % (nid, node.get("class_type"), name,
                           prompt[val[0]].get("class_type"), val[1], len(outs)))})

    # I6: 未声明的边引用语义不变 (模板边逐条比对提交图)
    if isinstance(template, dict):
        links = {}
        for row in template.get("links") or []:
            if isinstance(row, list) and len(row) >= 5:
                links[row[0]] = row
        for tn in template.get("nodes") or []:
            if not isinstance(tn, dict) or "id" not in tn:
                continue
            dst = str(tn["id"])
            if dst not in prompt:
                continue
            ins = prompt[dst].get("inputs") or {}
            for inp in tn.get("inputs") or []:
                lk = inp.get("link")
                if lk is None or lk not in links:
                    continue
                row = links[lk]
                src, slot, iname = str(row[1]), row[2], inp.get("name")
                if not iname or iname not in ins:
                    continue
                cur = ins[iname]
                if not (isinstance(cur, list) and len(cur) == 2 and isinstance(cur[0], str)):
                    continue  # 值形态改写 (literal 覆盖) 不属边引用错位域
                if str(cur[0]) == src and cur[1] == slot:
                    continue
                if src not in prompt:
                    continue  # 原来源节点已被移除 (lora disable / strip 等声明类)
                if str(cur[0]) not in tpl_ids:
                    continue  # 改接引擎新增节点 (注入/续接等声明类)
                violations.append({"invariant": "I6", "detail": (
                    "模板边 %s → %s.%s 被改指 %s (未声明)" % (src, dst, iname, cur))})
    return violations


# V1.9 批 2 T2.5 R2 — 模型/CLIP/VAE 值覆写 + 双 VAE 槽位 + 类型检查
# 优先路径: 提交 API prompt 前, 对模板已有加载点 (UNETLoader/CLIPLoader/VAELoader)
# 直接覆写 widget 值 (unet_name/clip_name/vae_name 输入键; 与 batch_core.convert 同口径).
# 改连线兜底仅登记 (本任务不做), 模板无加载点 → 明确报告 injected=False + reason.
# 联合指纹: 资源覆写改动 → 指纹变 → 缓存失效.

_OVERRIDE_KEYS = ("unet", "clip", "vae_video", "vae_audio")


def _parse_overrides(raw):
    """V1.9 T2.5 资源覆写 JSON 解析与规范化(纯函数, 可独立单测)。

    规格(任务单):
    - 输入: widget 字符串(JSON 对象紧凑文本; 非字符串 / 非法 JSON / 非对象 / 文件名类型错 → 报错)
    - 输出: dict, 键 ∈ {"unet","clip","vae_video","vae_audio"}; 值 = 文件名字符串
    - 校验失败 → 抛 RuntimeError, 文案含 "资源覆写列表" (与 T2.1 资源编排列表一致)
    - 未知键忽略 (不报错, 兼容后续扩展)
    - 空串 / "{}" → 空 dict
    - 空串值 → 跳过 (视为显式清空 = 缺省)
    """
    if not isinstance(raw, str):
        raise RuntimeError("资源覆写列表损坏, 复制备份后清空该字段(期望字符串, 收到: %s)" % type(raw).__name__)
    s = raw.strip()
    if not s:
        return {}
    try:
        parsed = json.loads(s)
    except (ValueError, TypeError) as e:
        raise RuntimeError("资源覆写列表损坏, 复制备份后清空该字段(非法 JSON: %s)" % e)
    if not isinstance(parsed, dict):
        raise RuntimeError("资源覆写列表损坏, 复制备份后清空该字段(顶层必须是 JSON 对象, 收到: %s)" % type(parsed).__name__)
    out = {}
    for k, v in parsed.items():
        if k not in _OVERRIDE_KEYS:
            continue  # 未知键忽略 (向前兼容, 防旧客户端多写键)
        if v is None:
            continue
        if not isinstance(v, str):
            raise RuntimeError("资源覆写列表损坏, 复制备份后清空该字段(%s 值必须是字符串, 收到: %s)" % (k, type(v).__name__))
        sv = v.strip()
        if not sv:
            continue  # 空串 = 跳过 (等价于缺省)
        out[k] = v  # 保留原串 (信任输入)
    return out


# V1.9 收尾 T4.4b — 模板自带 LoRA 放开编辑 (用户 2026-08-29 拍板)
# 数据入口: widget `lora_overrides` (STRING multiline, 默认 "{}"); JSON 对象
#   {"<lora 文件名>": {"strength": 0.7}} / {"<lora 文件名>": {"disabled": true}} /
#   {"<lora 文件名>": {"name": "新文件名.safetensors"}} (R4 换文件)
#   仅含被用户修改过的模板条目 (UI 侧只写改动过的键).
# 铁律: 模板工作流文件字节级不动。strength/name 经值覆写 (R2 先例模式, 节点/连线零增删);
#   disabled 经 D2 结构变换 — 生成的 API prompt 中摘除该节点、下游改接其上游
#   (等价画布 bypass; 结构变换先例: _inject_loras 加节点 / S1 降级链摘 patch)。
def _parse_lora_overrides(raw):
    """V1.9 T4.4b 模板 LoRA 覆写 JSON 解析与规范化 (纯函数, 可独立单测)。

    规格(任务单):
    - 输入: widget 字符串; JSON 对象 {"<lora 文件名>": {"strength": 0.7} | {"disabled": true} | {"name": str}}
    - 输出: dict {文件名: {"strength": float} / {"name": str} 和/或 {"disabled": bool}}
    - 校验失败 → 抛 RuntimeError, 文案含 "LoRA 覆写列表" (与 T2.1/T2.5 同口径)
    - strength 数值 (拒 bool 避开 True=1 歧义); disabled 布尔; name 非空字符串 (strip 后非空);
      值内未知键忽略 (向前兼容)
    - 空串 / "{}" → 空 dict; 空键 / 空对象值 → 跳过
    """
    if not isinstance(raw, str):
        raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(期望字符串, 收到: %s)" % type(raw).__name__)
    s = raw.strip()
    if not s:
        return {}
    try:
        parsed = json.loads(s)
    except (ValueError, TypeError) as e:
        raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(非法 JSON: %s)" % e)
    if not isinstance(parsed, dict):
        raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(顶层必须是 JSON 对象, 收到: %s)" % type(parsed).__name__)
    out = {}
    for k, v in parsed.items():
        if not isinstance(k, str) or not k.strip():
            continue  # 空键跳过
        if v is None:
            continue
        if not isinstance(v, dict):
            raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(%s 值必须是对象, 收到: %s)" % (k, type(v).__name__))
        entry = {}
        if "strength" in v:
            sv = v["strength"]
            if isinstance(sv, bool) or not isinstance(sv, (int, float)):
                raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(%s.strength 必须是数值, 收到: %s)" % (k, type(sv).__name__))
            entry["strength"] = float(sv)
        if "disabled" in v:
            dv = v["disabled"]
            if not isinstance(dv, bool):
                raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(%s.disabled 必须是布尔, 收到: %s)" % (k, type(dv).__name__))
            entry["disabled"] = dv
        if "name" in v:
            nv = v["name"]
            if not isinstance(nv, str) or not nv.strip():
                raise RuntimeError("LoRA 覆写列表损坏, 复制备份后清空该字段(%s.name 必须是非空字符串, 收到: %s)" % (k, type(nv).__name__))
            entry["name"] = nv
        if entry:
            out[k] = entry
    return out


# 模板 LoRA 节点的"强度 widget"对应 API 形态 inputs 键 (三类节点, T0.4 实测签名):
#   LoraLoader / LoraLoaderModelOnly → "strength_model" (LoraLoader 另有 strength_clip, 不动 — 单强度口径)
#   MiniMaxH3TurboLoRA → "strength" (第二 widget; convert 特判同口径)
_LORA_STRENGTH_KEY = {
    "LoraLoader": "strength_model",
    "LoraLoaderModelOnly": "strength_model",
    "MiniMaxH3TurboLoRA": "strength",
}

# V1.9 D2: 三类模板 LoRA 节点的输出槽 → 摘除 (bypass) 时透传的节点输入名。
# 输出序 (object_info): LoraLoader = MODEL,CLIP; LoraLoaderModelOnly / MiniMaxH3TurboLoRA = MODEL。
_LORA_BYPASS_SLOT_INPUT = {0: "model", 1: "clip"}


def _bypass_lora_nodes(prompt, bypass_ids):
    """V1.9 D2 从 API prompt 摘除禁用的模板 LoRA 节点 (纯函数, 结构变换).

    等价用户在画布上 bypass 该节点 (前端 bypass 的序列化产物 = 摘节点 + 改连线):
    摘除 X 时, 全图 inputs 中 ["X", slot] 引用改接 X 的同名语义输入来源
    (slot 0=MODEL → X.inputs.model; slot 1=CLIP → X.inputs.clip);
    X 的上游若同样被禁用则级联追到最上游 (不动点)。模板文件零改动 —
    变换只发生在引擎每段生成的 API prompt dict (结构变换先例: _inject_loras / S1 降级链).

    Args:
        prompt: API 形态 dict {str(nid): {"class_type": str, "inputs": dict}}, 只读
        bypass_ids: set[str] 待摘除节点 id 集 (prompt 键同型)

    Returns:
        新 prompt dict (不含 bypass_ids 节点; 其余节点 inputs 浅拷贝)
    """
    def _passthrough(nid, in_name, seen):
        # 沿被禁用链解析最上游来源; 返回上游引用 list, 无法解析 (非连线) 返回 None
        src = (prompt[nid].get("inputs") or {}).get(in_name)
        if not (isinstance(src, list) and len(src) == 2 and str(src[0]) not in seen):
            return None
        seen.add(str(src[0]))
        up = str(src[0])
        if up in bypass_ids:
            return _passthrough(up, in_name, seen)
        return [up, src[1]]

    out = {}
    for nid, node in prompt.items():
        if nid in bypass_ids:
            continue  # 摘除
        new_inputs = {}
        for k, v in node["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) \
                    and isinstance(v[1], int) and v[0] in bypass_ids:
                in_name = _LORA_BYPASS_SLOT_INPUT.get(v[1])
                rewired = _passthrough(v[0], in_name, {v[0]}) if in_name else None
                if rewired is not None:
                    v = rewired
            new_inputs[k] = v
        out[nid] = {"class_type": node["class_type"], "inputs": new_inputs}
    return out


def _apply_lora_overrides(prompt, lora_overrides):
    """V1.9 T4.4b / D2 / R4 模板自带 LoRA 覆写执行 (纯函数, 提交前图变换, _apply_overrides 同环节).

    Args:
        prompt: API 形态 dict {str(nid): {"class_type": str, "inputs": dict}}, 只读
                (函数内对 inputs 做浅拷贝; 不修改原 dict)
        lora_overrides: dict (来自 _parse_lora_overrides); 键 = lora 文件名,
                        值 = {"strength": float} / {"name": str} 和/或 {"disabled": True}

    Returns:
        (new_prompt, report)
        report = {
            "applied": [ {"node": str, "lora": str,
                          "action": "strength"|"name"|"bypass",  # D2: disabled → bypass (摘除);
                                                             # R4: name → 换文件 (值覆写)
                          "bypass": True},  # 仅 bypass 条目携带 (含义 = 从执行链摘除)
                          ...],
            "unmatched": [文件名, ...],  # 覆写键在模板中找不到对应 LoRA 节点 (不报错仅记录)
        }

    语义:
    - 按 lora_name widget 值精确匹配覆写键; 同 lora 名多节点 → 全部覆写
    - strength → 覆写该节点强度键 (节点/连线零增删, R2 值覆写口径不变)
    - name → R4 换文件: 覆写该节点 lora_name (加载另一个已安装 LoRA 文件),
      与 strength 同环节的值覆写 (节点/连线零增删); 同条目 name+strength 共存时两者都执行
    - disabled → D2 结构变换: 该节点从生成的 API prompt 摘除 (等价画布 bypass),
      下游对应输入改接其上游来源 (级联至不动点) — 文件不加载, 坏 LoRA 文件
      禁用后不再炸; 同条目 disabled 与 name/strength 共存时 disabled 最高优先
      (其余忽略 — 摘除的节点无 widget 可言)
    - 模板工作流文件字节级零改动 (铁律; 变换仅在内存中的 API prompt 上)
    - 未命中键 → unmatched 记录, 图不动, 不报错
    - 空 lora_overrides → (prompt 浅拷贝, {applied: [], unmatched: []}) 零改动
    """
    # 浅拷贝 (与 _apply_overrides / _inject_loras 同模式)
    new_prompt = {nid: {"class_type": n["class_type"],
                        "inputs": dict(n.get("inputs") or {})}
                  for nid, n in prompt.items()}
    applied = []
    if not lora_overrides:
        return new_prompt, {"applied": applied, "unmatched": []}
    matched = set()
    bypass_loras = {}  # nid -> lora_name (D2: 禁用节点收集后统一摘除)
    for nid in sorted(new_prompt.keys(), key=lambda x: int(x)):
        node = new_prompt[nid]
        key = _LORA_STRENGTH_KEY.get(node["class_type"])
        if key is None:
            continue  # 非模板 LoRA 节点 (loader/消费端等) 零触碰
        lora_name = (node.get("inputs") or {}).get("lora_name")
        if not isinstance(lora_name, str) or lora_name not in lora_overrides:
            continue
        ov = lora_overrides[lora_name] or {}
        sv = ov.get("strength")
        nv = ov.get("name")
        if ov.get("disabled") is True:
            # D2: 不再置 0 — 节点直接从执行链摘除 (收集后统一结构变换);
            #   disabled 最高优先, name/strength 均忽略
            bypass_loras[nid] = lora_name
            matched.add(lora_name)
            continue
        if isinstance(nv, str) and nv.strip():
            # R4 换文件: lora_name 值覆写 (与 strength 同环节, 零结构变换)
            node["inputs"]["lora_name"] = nv
            applied.append({"node": nid, "lora": lora_name, "action": "name"})
            matched.add(lora_name)
        if isinstance(sv, (int, float)) and not isinstance(sv, bool):
            node["inputs"][key] = float(sv)
            applied.append({"node": nid, "lora": lora_name, "action": "strength"})
            matched.add(lora_name)
    if bypass_loras:
        new_prompt = _bypass_lora_nodes(new_prompt, set(bypass_loras))
        for nid in sorted(bypass_loras.keys(), key=lambda x: int(x)):
            applied.append({"node": nid, "lora": bypass_loras[nid],
                            "action": "bypass", "bypass": True})
    applied.sort(key=lambda e: int(e["node"]))
    unmatched = [k for k in lora_overrides if k not in matched]
    return new_prompt, {"applied": applied, "unmatched": unmatched}


# T4.4b 后: 模板 LoRA 名自动解析 (用户改名/移动 LoRA 后批任务全挂的容错)
# 根因: 模板 JSON 的 lora_name widget 写 `xxx.safetensors`; 用户改文件名/挪目录后,
# `folder_paths.get_filename_list("loras")` 枚举里旧名消失 → ComfyUI /prompt
# 校验 400 "Value not in list" → 全批失败。兜底: 按 stem 唯一候选自动替换。
# 两处复用, 语义互不重叠:
#   convert  → 唯一命中自动替换 (静默 + 日志)
#   preflight → 解析失败时报清晰错误 (引导用户改文件名 / 二选一)
def _resolve_lora_alias(name, installed):
    """模板 LoRA 名 → 当前磁盘枚举名 解析. 返回 (resolved_name, candidates).

    - name 已在 installed → (name, []) 零改动
    - 不在: 按 stem 匹配 (大小写不敏感; installed 项可带子目录前缀, 取 basename
      的 stem 比较):
        * stem_ref == stem_cand → 命中
        * stem_cand 以 stem_ref 为前缀 (用户给磁盘文件加了后缀, 如 ..._H3), 且
          剩余部分 ≤8 字符且仅由 [A-Za-z0-9_] 组成 (短后缀别名守卫) → 命中
        * stem_ref 以 stem_cand 为前缀 (用户从模板名删了后缀, 反向场景), 同上
          守卫 → 命中
    - 唯一命中 → (候选, [])
    - 多命中/零命中 → (原 name, 命中候选列表) 供预检报错, 不猜
    """
    if not name or not installed:
        return name, []
    # 精确命中优先 (大小写敏感, 与 ComfyUI 枚举口径一致)
    if name in installed:
        return name, []
    # 按 stem 比对: 大小写不敏感 (NTFS case-insensitive 默认); 命中取 basename 的 stem
    # 注意: installed 项可能带子目录前缀 (如 "子目录/xxx.safetensors"), 必须先取 basename
    # 再 splitext, 否则 splitext 会把路径里的点号当扩展名分隔, 结果错位。
    target_stem = os.path.splitext(os.path.basename(name))[0].lower()

    def _stem_match(stem_ref, stem_cand):
        """短后缀别名守卫: 余下非空, 长度 ≤8, 仅 [A-Za-z0-9_] 视为别名; 否则不算."""
        if stem_ref == stem_cand:
            return True
        tail = ""
        if stem_cand.startswith(stem_ref) and len(stem_cand) > len(stem_ref):
            tail = stem_cand[len(stem_ref):]
        elif stem_ref.startswith(stem_cand) and len(stem_ref) > len(stem_cand):
            tail = stem_ref[len(stem_cand):]
        if not tail:
            return False
        if len(tail) > 8:
            return False
        return all(ch.isalnum() or ch == "_" for ch in tail)

    candidates = []
    for item in installed:
        if not isinstance(item, str):
            continue
        cand_stem = os.path.splitext(os.path.basename(item))[0].lower()
        if _stem_match(target_stem, cand_stem):
            candidates.append(item)
    if len(candidates) == 1:
        # 唯一命中: 返回 installed 里的原样字符串 (保留子目录/大小写)
        return candidates[0], []
    # 多命中或零命中: 原样 name 返回, 候选列表供调用方判断 (convert 静默 / preflight 报错)
    return name, candidates


# 类型互斥词 (小写比对)
_UNET_MUTEX_WORDS = ("ref2v", "fl2v")  # 互斥家族词; 含其一即属该家族
_VAE_VIDEO_WORD = "video"
_VAE_AUDIO_WORD = "audio"


def _family_match(name_lower):
    """返回 (has_ref2v, has_fl2v) 二元组."""
    has_ref2v = "ref2v" in name_lower
    has_fl2v = "fl2v" in name_lower
    return has_ref2v, has_fl2v


def _apply_overrides(prompt, overrides, workflow_path=""):
    """V1.9 T2.5 R2 值覆写执行 (纯函数).

    Args:
        prompt: API 形态 dict {str(nid): {"class_type": str, "inputs": dict}}, 只读
                (函数内对 inputs 做浅拷贝; 不修改原 dict)
        overrides: dict (来自 _parse_overrides); 键 ∈ {unet, clip, vae_video, vae_audio}
        workflow_path: 模板文件路径; 提供时 unet 互斥按 _template_mode 真实工作流
                结构判型 (V1.14 K1 修复: t2v/i2v 模板放行任意族底模, 仅 ref2v/fl2v
                真结构维持互斥). 缺省退回旧口径 (模板现值文件名判族, 兼容调用).

    Returns:
        (new_prompt, report)
        report = {
            "injected": bool,
            "reason": str,    # 顶层失败原因 (任一槽位成功的清况下为空; 全失败时为首个非空 reason 摘要)
            "applied": {
                "unet": {"ok": bool, "from": str|None, "to": str|None, "reason": str},
                "clip": {...},
                "vae_video": {...},
                "vae_audio": {...},
            },
            "warnings": [str, ...],   # 全局警告列表 (如 VAE 错配词, 提示但未拦截)
        }

    失败语义:
    - overrides={} → (prompt 浅拷贝, {injected:False, reason:"无覆写请求", ...}), 不污染图
    - 模板无任何 loader 节点 (UNETLoader/CLIPLoader/VAELoader 全部缺失) →
      同上 + reason "模板无 UNETLoader/CLIPLoader/VAELoader"
    - 单槽位失败 (类型不匹配/槽位缺失) → applied[slot].ok=False + warn; 其它槽位照常执行
    - 所有 requested 槽位均失败 → injected=False + reason 概括
    """
    # 浅拷贝 (与 _inject_loras 同模式)
    new_prompt = {nid: {"class_type": n["class_type"],
                         "inputs": dict(n.get("inputs") or {})}
                  for nid, n in prompt.items()}

    # 空模板 applied 骨架 (ok=False 默认; reason="" 默认; from/to=None)
    def _empty_applied():
        return {"ok": False, "from": None, "to": None, "reason": ""}

    applied = {
        "unet": _empty_applied(),
        "clip": _empty_applied(),
        "vae_video": _empty_applied(),
        "vae_audio": _empty_applied(),
    }
    warnings = []

    # 0) 空覆写 → 直接返回 (不污染图)
    if not overrides:
        return new_prompt, {
            "injected": False, "reason": "无覆写请求",
            "applied": applied, "warnings": [],
        }

    # 1) 锚点识别: 按 nid 升序 (即 nodes 列表顺序) 找各类 loader
    #    多 UNETLoader 时取 nid 最小 (本任务假设模板单 UNETLoader, 多余情况退化)
    unet_ids = []
    clip_ids = []
    vae_ids = []
    for nid in sorted(new_prompt.keys(), key=lambda x: int(x)):
        n = new_prompt[nid]
        ct = n["class_type"]
        if ct == "UNETLoader":
            unet_ids.append(nid)
        elif ct == "CLIPLoader":
            clip_ids.append(nid)
        elif ct == "VAELoader":
            vae_ids.append(nid)

    # 2) 模板完全无 loader 节点 → 不做兜底连线, 仅返回明确报告 (登记批 4 评估)
    if not (unet_ids or clip_ids or vae_ids):
        return new_prompt, {
            "injected": False,
            "reason": "模板无 UNETLoader/CLIPLoader/VAELoader",
            "applied": applied, "warnings": [],
        }

    any_succeeded = False

    # 3) unet 覆写
    if overrides.get("unet"):
        new_name = overrides["unet"]
        if not unet_ids:
            applied["unet"]["reason"] = "模板无 UNETLoader"
        else:
            nid = unet_ids[0]
            old_name = new_prompt[nid]["inputs"].get("unet_name", "")
            new_ref, new_fl = _family_match(new_name.lower())
            # V1.14 K1 修复: 互斥按真实工作流结构判型. 旧口径按模板现值文件名猜族,
            # t2v 模板 (现值恰为 fl2va 名) 被误判 fl2v 工作流 → 跨族覆写被误拒
            # (GUI 编排器选底模不生效). t2v/i2v 工作流对底模族无约束 (H3 底模多态
            # 通用: t2v+Ref2VA 与 t2v+fl2va 均有真实成功批次); 仅 ref2v/fl2v 真结构
            # 维持互斥. 无 workflow_path 的兼容调用退回旧口径.
            if workflow_path:
                tmode = _template_mode(workflow_path)
                conflict = ((tmode == "ref2v" and new_fl and not new_ref) or
                            (tmode == "fl2v" and new_ref and not new_fl))
            else:
                old_ref, old_fl = _family_match((old_name or "").lower())
                conflict = (old_ref and new_fl) or (old_fl and new_ref)
            if conflict:
                # ref2v ↔ fl2v 互斥 → 拒绝
                applied["unet"]["reason"] = "类型不匹配 (ref2v↔fl2v 互斥): 模板原值 %r, 覆写值 %r" % (old_name, new_name)
                applied["unet"]["from"] = old_name
            else:
                new_prompt[nid]["inputs"]["unet_name"] = new_name
                applied["unet"] = {"ok": True, "from": old_name, "to": new_name, "reason": ""}
                any_succeeded = True

    # 4) clip 覆写 (同族变体不拦截; 当前无 clip 类型互斥词, 直接覆写)
    if overrides.get("clip"):
        new_name = overrides["clip"]
        if not clip_ids:
            applied["clip"]["reason"] = "模板无 CLIPLoader"
        else:
            nid = clip_ids[0]
            old_name = new_prompt[nid]["inputs"].get("clip_name", "")
            new_prompt[nid]["inputs"]["clip_name"] = new_name
            applied["clip"] = {"ok": True, "from": old_name, "to": new_name, "reason": ""}
            any_succeeded = True

    # 5) vae_video 覆写 (第 1 个 VAELoader; 错配词 warning 但不拦截)
    if overrides.get("vae_video"):
        new_name = overrides["vae_video"]
        if not vae_ids:
            applied["vae_video"]["reason"] = "模板无 VAELoader"
        else:
            nid = vae_ids[0]
            old_name = new_prompt[nid]["inputs"].get("vae_name", "")
            new_prompt[nid]["inputs"]["vae_name"] = new_name
            applied["vae_video"] = {"ok": True, "from": old_name, "to": new_name, "reason": ""}
            any_succeeded = True
            if _VAE_AUDIO_WORD in new_name.lower():
                w = "vae_video 槽位写入的文件名含 'audio' 词, 可能类型不匹配: %s" % new_name
                applied["vae_video"]["reason"] = w
                warnings.append(w)

    # 6) vae_audio 覆写 (第 2 个 VAELoader; 仅 1 个 VAE 时 vae_audio 无效 + 提示)
    if overrides.get("vae_audio"):
        new_name = overrides["vae_audio"]
        if len(vae_ids) >= 2:
            nid = vae_ids[1]
            old_name = new_prompt[nid]["inputs"].get("vae_name", "")
            new_prompt[nid]["inputs"]["vae_name"] = new_name
            applied["vae_audio"] = {"ok": True, "from": old_name, "to": new_name, "reason": ""}
            any_succeeded = True
            if _VAE_VIDEO_WORD in new_name.lower():
                w = "vae_audio 槽位写入的文件名含 'video' 词, 可能类型不匹配: %s" % new_name
                applied["vae_audio"]["reason"] = w
                warnings.append(w)
        elif len(vae_ids) == 1:
            w = "vae_audio 槽位: 模板仅 1 个 VAELoader, vae_video 已占用, vae_audio 无效"
            applied["vae_audio"]["reason"] = w
            warnings.append(w)
        else:
            applied["vae_audio"]["reason"] = "模板无 VAELoader"

    # 7) 汇总 — 失败时把首个非空 reason 提到顶层 (供前端黄条 / 日志直观定位)
    top_reason = ""
    if not any_succeeded:
        for slot in ("unet", "clip", "vae_video", "vae_audio"):
            if applied[slot]["reason"]:
                top_reason = applied[slot]["reason"]
                break
        if not top_reason:
            top_reason = "所有覆写槽位均失败 (见 applied.reason)"

    return new_prompt, {
        "injected": any_succeeded,
        "reason": "" if any_succeeded else top_reason,
        "applied": applied,
        "warnings": warnings,
    }


def _parse_resources_list(raw):
    """V1.9 T2.1 资源编排列表解析与规范化(纯函数, 可独立单测)。

    规格(任务单):
    - 输入: widget 字符串(JSON 数组紧凑文本; 非字符串 / 非法 JSON / 非数组 / 条目非法 → 报错)
    - 输出: list[dict]; 每条规范化 5 字段 — {name, strength_model, strength_clip, order, source}
    - 校验失败(非法 JSON / 非数组 / 条目非法 / 字段类型错) → 抛 RuntimeError, 文案含 "资源编排列表"
    - name 非空字符串; strength_model/strength_clip 数值或 None(拒绝 bool 避开 True=1 歧义);
      order 缺省按数组索引补 0..N-1; source 缺省默认 "edited"; 重复 name 允许
    - 单强度节点(LoraLoaderModelOnly/MinimaxH3TurboLoRA)只写 strength_model, 解析层不强求双字段
    - 测试: 非法 JSON / 非数组 / 条目非法 / 字段类型错 全部响亮报错; 不静默降级
    """
    if not isinstance(raw, str):
        # 鲁棒性: widget 总是字符串, 但代码路径可能被复用; 非字符串显式拒收
        raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(期望字符串, 收到: %s)" % type(raw).__name__)
    s = raw.strip()
    if not s:
        # 空串视作空列表(向后兼容; 但 widget 默认 "[]" 不会走到这里, 仅手动清空场景)
        return []
    try:
        parsed = json.loads(s)
    except (ValueError, TypeError) as e:
        raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(非法 JSON: %s)" % e)
    if not isinstance(parsed, list):
        raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(顶层必须是 JSON 数组, 收到: %s)" % type(parsed).__name__)
    out = []
    for i, item in enumerate(parsed):
        if not isinstance(item, dict):
            raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条不是对象: %s)" % (i, type(item).__name__))
        # name: 必须是非空字符串
        name = item.get("name", "")
        if not isinstance(name, str) or not name.strip():
            raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 name 非空字符串缺失: %r)" % (i, name))
        # strength_model / strength_clip: 数值或 None; 拒 bool(避免 True/False 误为 1/0)
        def _norm_strength(v):
            if v is None:
                return None
            if isinstance(v, bool):
                raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 strength 收到 bool, 应为数值或 null: %r)" % (i, v))
            if isinstance(v, (int, float)):
                return v
            raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 strength 必须是数值或 null: %r)" % (i, v))
        sm = _norm_strength(item.get("strength_model"))
        sc = _norm_strength(item.get("strength_clip"))
        # order: 缺省按索引补(显式给定也接受, 但仍是 0..N-1 的语义, 不强校验 — 后续重排任务可写任意值)
        order = item.get("order", i)
        if not isinstance(order, int) or isinstance(order, bool):
            raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 order 必须是整数: %r)" % (i, order))
        # source: 仅 "template"/"edited"; 缺省 "edited"
        src = item.get("source", "edited")
        if src not in ("template", "edited"):
            raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 source 必须是 template/edited: %r)" % (i, src))
        # V1.11 批4 T4 D1: category 可选字段 — turbo/style; 缺省=None 不写键,
        # 非 turbo/style 视为非法 (与 source 白名单报错同款风格, :3030-3031 先例)
        cat = item.get("category", None)
        if "category" in item and cat is not None:
            if cat not in ("turbo", "style"):
                raise RuntimeError("资源编排列表损坏, 复制备份后清空该字段(第 %d 条 category 必须是 turbo/style: %r)" % (i, cat))
        else:
            cat = None
        entry = {
            "name": name,  # 保留原串 (不 strip — 前端可能用空格对齐, 信任输入)
            "strength_model": sm,
            "strength_clip": sc,
            "order": order,
            "source": src,
        }
        if cat is not None:
            entry["category"] = cat
        out.append(entry)
    return out


# V1.9 批 3 T3.2 — S1 latent 尾窗续接图变换 (纯函数, 参照 _inject_loras 模式)
# 拼接模式: 段 N 提交图追加 H3MotionContextSaveLatent (尾挂 OUTPUT_NODE 落盘 AV latent);
# 段 N+1 提交图注入 LoadLatent + H3MotionContext + Trim 三节点并重接四链,
# 与 apply_shot_concat 的 9 号槽尾帧图注入 (prev_frame 路径) 互斥让位。
# 落盘目标 = run_dir/intermediates/h3_ctx/clip_%05d.safetensors (clip 编号 = 段序号,
# 固定槽位重跑覆盖自己的 reject; 引擎恒引用具体编号, 禁用"目录最新文件"模式)。

CONTINUATION_SUBDIR = ("intermediates", "h3_ctx")


def _find_first_node(prompt, class_type):
    """按 nid 升序找第一个指定类名节点; 无 → None。"""
    for nid in sorted(prompt.keys(), key=lambda x: int(x)):
        if prompt[nid].get("class_type") == class_type:
            return nid
    return None


def _inject_continuation_save(prompt, fresh_id, filename_prefix, clip_index):
    """段 N 提交图追加 H3MotionContextSaveLatent (尾挂, 不改原链)。

    latent = SamplerCustomAdvanced 输出 slot 0 (AV 采样输出 — SaveVideo 模板无
    latent 直通, 借节点自身 OUTPUT_NODE 落盘, 引擎无需自己编码);
    clip_index = 段序号 (固定槽位 *_%05d.safetensors, 重跑覆盖自己的 reject);
    filename_prefix = 相对 ComfyUI 输出根的路径 (服务端 get_save_image_path 有
    is_within_directory 限制, 引擎 run_dir 即输出根下时间戳目录, 相对前缀合法)。

    Returns:
        (new_prompt, report); report = {"injected": bool, "reason": str, "save_nid": int}
    无 SamplerCustomAdvanced → 不注入 + reason (无采样 latent 可落盘)。
    """
    new_prompt = {nid: {"class_type": n["class_type"],
                        "inputs": dict(n.get("inputs") or {})}
                  for nid, n in prompt.items()}
    sampler_nid = _find_first_node(new_prompt, "SamplerCustomAdvanced")
    if sampler_nid is None:
        return new_prompt, {"injected": False,
                            "reason": "图无 SamplerCustomAdvanced, 无采样 latent 可落盘",
                            "save_nid": -1}
    nid = fresh_id()
    new_prompt[str(nid)] = {
        "class_type": "H3MotionContextSaveLatent",
        "inputs": {
            "latent": [sampler_nid, 0],
            "filename_prefix": filename_prefix,
            "clip_index": int(clip_index),
        },
    }
    return new_prompt, {"injected": True, "reason": "", "save_nid": int(nid)}


def _inject_continuation_apply(prompt, fresh_id, latent_path, clip_index,
                               context_length="22", audio_context_length=22,
                               audio_taper_steps=0, audio_ref_wav=None,
                               audio_vae_link=None):
    """段 N+1 提交图注入 LoadLatent + H3MotionContext + Trim 并重接 (链式锚点)。

    分轨参照: audio_ref_wav + audio_vae_link 均给 → 新建 LoadAudio 节点,
    MC inputs 增 context_audio/audio_vae 并覆写 audio_context_length=72/
    audio_taper_steps=0 (设计保证); 缺一 → 现行 inputs 逐键不变。

    锚点识别 (参照 T2.3 链式锚点思路 — 找 conditioning 链与 latent 链):
    - sampler = SamplerCustomAdvanced; guider = sampler.inputs["guider"] (BasicGuider)
      → guider.conditioning 的原来源接 MC.conditioning, guider.conditioning 重接 MC 输出
    - sampler.inputs["latent_image"] 原来源 (模板空 latent) → MC.latent
    - VAEDecode.inputs["vae"] 原来源 (模板 video VAE) → MC.vae
    - 视频汇: CreateVideo 存在 → 其 images/audio 双输入改接 Trim; 否则 SaveVideo.video

    V1.11 批 4 T1: Trim 插在视频汇原上游末端, VAEDecode→视频汇之间的处理节点
    (如 RTX 超分 / AILab FlashVSR) 保留 — 读取视频汇 images/audio 输入的
    原上游连线作为 Trim 输入, 而非硬接 VAEDecode/VAEDecodeAudio.
    直连模板下, 视频汇原上游 == VAEDecode/VAEDecodeAudio, 行为零变化 (回归锁).
    原上游缺失 (非 [nid, slot] 形态) → 并入"连线不完整"失败分支, reason 指明.

    Returns:
        (new_prompt, report); report = {"injected": bool, "reason": str,
                                        "nodes": {"load": int, "mc": int, "trim": int}}
    任一锚点缺失 → 整段原子性不注入 + reason 指明缺哪个。
    """
    new_prompt = {nid: {"class_type": n["class_type"],
                        "inputs": dict(n.get("inputs") or {})}
                  for nid, n in prompt.items()}
    sampler_nid = _find_first_node(new_prompt, "SamplerCustomAdvanced")
    if sampler_nid is None:
        return new_prompt, {"injected": False, "reason": "图无 SamplerCustomAdvanced",
                            "nodes": {}}
    guider_nid = _find_first_node(new_prompt, "BasicGuider")
    if guider_nid is None:
        return new_prompt, {"injected": False, "reason": "图无 BasicGuider (conditioning 锚点)",
                            "nodes": {}}
    vae_decode_nid = _find_first_node(new_prompt, "VAEDecode")
    vae_decode_audio_nid = _find_first_node(new_prompt, "VAEDecodeAudio")
    if vae_decode_nid is None or vae_decode_audio_nid is None:
        return new_prompt, {"injected": False,
                            "reason": "图无 VAEDecode/VAEDecodeAudio (解码双流锚点)",
                            "nodes": {}}

    def _link(v):
        return list(v) if isinstance(v, list) and len(v) == 2 else None

    cond_src = _link(new_prompt[guider_nid]["inputs"].get("conditioning"))
    latent_src = _link(new_prompt[sampler_nid]["inputs"].get("latent_image"))
    vae_src = _link(new_prompt[vae_decode_nid]["inputs"].get("vae"))
    if cond_src is None or latent_src is None or vae_src is None:
        return new_prompt, {"injected": False,
                            "reason": "conditioning/latent_image/vae 锚点连线不完整",
                            "nodes": {}}
    # 视频汇: 模板链 VAEDecode->CreateVideo->SaveVideo 时改接 CreateVideo 双输入
    # (等价于 SaveVideo 的 video 上游收到 Trim 输出), 无 CreateVideo 时直接改 SaveVideo.video
    create_nid = _find_first_node(new_prompt, "CreateVideo")
    if create_nid is not None:
        sink_nid, sink_img_key, sink_audio_key = create_nid, "images", "audio"
    else:
        save_nid = _find_first_node(new_prompt, "SaveVideo")
        if save_nid is None:
            return new_prompt, {"injected": False, "reason": "图无 CreateVideo/SaveVideo (视频汇锚点)",
                                "nodes": {}}
        sink_nid, sink_img_key, sink_audio_key = save_nid, "video", None

    # V1.11 批 4 T1: 读取视频汇原上游作为 Trim 接线源 (保中间节点).
    # 原上游缺失 → 并入"连线不完整"失败分支, 不注入.
    orig_img_src = _link(new_prompt[sink_nid]["inputs"].get(sink_img_key))
    orig_audio_src = (_link(new_prompt[sink_nid]["inputs"].get(sink_audio_key))
                      if sink_audio_key else None)
    if orig_img_src is None or (sink_audio_key and orig_audio_src is None):
        return new_prompt, {"injected": False,
                            "reason": "视频汇 images/audio 原连线不完整",
                            "nodes": {}}

    load_nid = fresh_id()
    new_prompt[str(load_nid)] = {
        "class_type": "H3MotionContextLoadLatent",
        "inputs": {"latent_path": latent_path, "clip_index": int(clip_index)},
    }
    mc_inputs = {
        "conditioning": cond_src,
        "vae": vae_src,
        "latent": latent_src,
        "context_length": context_length,
        "audio_context_length": int(audio_context_length),
        "audio_taper_steps": int(audio_taper_steps),
        "context_latent": [str(load_nid), 0],
    }
    if audio_ref_wav is not None and audio_vae_link is not None:
        audio_nid = fresh_id()
        new_prompt[str(audio_nid)] = {
            "class_type": "LoadAudio",
            "inputs": {"audio": audio_ref_wav},
        }
        mc_inputs["context_audio"] = [str(audio_nid), 0]
        mc_inputs["audio_vae"] = list(audio_vae_link)
        mc_inputs["audio_context_length"] = 72
        mc_inputs["audio_taper_steps"] = 0
    mc_nid = fresh_id()
    new_prompt[str(mc_nid)] = {
        "class_type": "H3MotionContext",
        "inputs": mc_inputs,
    }
    trim_nid = fresh_id()
    new_prompt[str(trim_nid)] = {
        "class_type": "H3MotionContextTrim",
        "inputs": {
            "images": orig_img_src,
            "audio": orig_audio_src,
            "trim_frames": [str(mc_nid), 1],
            "fps": 24,
            "match_tail": True,
        },
    }
    # 重接: conditioning 消费端 (BasicGuider) 改接 MC 输出
    new_prompt[guider_nid]["inputs"]["conditioning"] = [str(mc_nid), 0]
    # 视频汇改接 Trim (画面+声音同步过裁头)
    new_prompt[sink_nid]["inputs"][sink_img_key] = [str(trim_nid), 0]
    if sink_audio_key is not None:
        new_prompt[sink_nid]["inputs"][sink_audio_key] = [str(trim_nid), 1]
    return new_prompt, {"injected": True, "reason": "",
                        "nodes": {"load": int(load_nid), "mc": int(mc_nid),
                                  "trim": int(trim_nid)}}


def _rerun_inpaint_assemble_prompt(prompt, *, next_nid, mask_rel, source_video_rel,
                                    strength, model_patch_name):
    """V1.13h 段级重绘 (Fun ControlNet inpaint) prompt 组装 — 纯函数.

    入参:
      prompt: dict[str, dict] (基线, 通常 = eng._prompt 的复制; 不污染原 dict)
      next_nid: 基础 nid (调用方预占 = max(现存 nid) + 1); 五新节点严格递增分配
      mask_rel: 蒙版 PNG basename (已落 server input)
      source_video_rel: 原段 mp4 basename (已落 server input)
      strength: float ∈ [0.0, 1.0]
      model_patch_name: 模型 basename (落 models/model_patches/)

    出参:
      (new_prompt, report)
        new_prompt = prompt 深拷贝 + 改造
        report = {
          "injected": bool, "reason": str,
          "nodes": {"loader": int, "video": int, "load_image": int,
                    "mask": int, "apply": int},
          "removed_continuation": [int, ...],
        }

    行为:
      1. 删续接节点 (H3MotionContextLoadLatent / H3MotionContext / H3MotionContextTrim).
         节点从 new_p 摘除, 原引用 (guider.conditioning / sampler.latent_image / VAEDecode.vae
         / CreateVideo.images+audio) 不在本函数内复位 — 调用方契约: 调用前 ensure baseline
         prompt 已是"无续接"形态 (分镜模式 / _rerun_generate_shot_in_folder 内)。
         (本函数保纯 — 续接摘除仅做节点摘除, 不写回原上游; 真机 T4 + 与 _apply_continuation
         协同验证不撞链路。摘除事件记录到 report.removed_continuation 供端点日志。)

      2. 插五节点 (ModelPatchLoader / VHS_LoadVideo / LoadImage / ImageToMask /
         MiniMaxH3FunControlNetApply, model/vae 复用图内现有引用 — BasicGuider.model /
         VAEDecode.vae) + 模型链改接 (BasicGuider.model → Apply; BasicScheduler.model
         与 guider 同源时改接, 异源保留原链) + denoise 强制 1.0.

      3. 错点缺失 → report.injected=False + reason 指明; 不抛异常.
    """
    import copy
    new_prompt = copy.deepcopy(prompt)
    nodes_report = {}
    removed_continuation = []

    # 1. 摘续接三件
    for nid_key in list(new_prompt.keys()):
        node = new_prompt.get(nid_key) or {}
        if node.get("class_type") in ("H3MotionContextLoadLatent",
                                       "H3MotionContext",
                                       "H3MotionContextTrim"):
            try:
                removed_continuation.append(int(nid_key))
            except (TypeError, ValueError):
                pass
            del new_prompt[nid_key]

    # 2. 锚点校验
    def _find_first(class_type):
        for nid, node in new_prompt.items():
            if isinstance(node, dict) and node.get("class_type") == class_type:
                return nid
        return None

    sched_nid = _find_first("BasicScheduler")
    if sched_nid is None:
        return new_prompt, {"injected": False,
                            "reason": "图无 BasicScheduler (denoise/model 锚点)",
                            "nodes": {}, "removed_continuation": removed_continuation}
    guider_nid = _find_first("BasicGuider")
    if guider_nid is None:
        return new_prompt, {"injected": False,
                            "reason": "图无 BasicGuider (model 锚点)",
                            "nodes": {}, "removed_continuation": removed_continuation}
    # 模型链锚点: 复用 BasicGuider.model 现有引用 (引用形态 [str, int]; 悬空即拒,
    # 含续接摘除后悬空情形) — 不写死节点号
    model_ref = (new_prompt[guider_nid].get("inputs") or {}).get("model")
    if not (isinstance(model_ref, list) and len(model_ref) == 2):
        return new_prompt, {"injected": False,
                            "reason": "图无模型链锚点 (BasicGuider.model)",
                            "nodes": {}, "removed_continuation": removed_continuation}
    if model_ref[0] not in new_prompt:
        return new_prompt, {"injected": False,
                            "reason": "模型链锚点引用不存在节点 %s" % model_ref[0],
                            "nodes": {}, "removed_continuation": removed_continuation}
    # VAE 锚点: 复用 VAEDecode.vae 现有引用 (不设 VAELoader 次选)
    vae_decode_nid = _find_first("VAEDecode")
    vae_ref = None
    if vae_decode_nid is not None:
        vae_ref = (new_prompt[vae_decode_nid].get("inputs") or {}).get("vae")
    if not (isinstance(vae_ref, list) and len(vae_ref) == 2
            and vae_ref[0] in new_prompt):
        return new_prompt, {"injected": False,
                            "reason": "图无 VAE 锚点 (VAEDecode.vae)",
                            "nodes": {}, "removed_continuation": removed_continuation}

    # 3. 插五节点 (next_nid 严格递增分配)
    loader_nid = next_nid
    video_nid = next_nid + 1
    load_image_nid = next_nid + 2
    mask_nid = next_nid + 3
    apply_nid = next_nid + 4

    new_prompt[str(loader_nid)] = {
        "class_type": "ModelPatchLoader",
        "inputs": {"name": model_patch_name},
    }
    # VHS_LoadVideo: 不写 force_size (新版 VHS 已废弃, 真机 8190_c.log 实证 warning)
    new_prompt[str(video_nid)] = {
        "class_type": "VHS_LoadVideo",
        "inputs": {
            "video": source_video_rel,
            "force_rate": 24,
            "custom_width": 0,
            "custom_height": 0,
            "frame_load_cap": 0,
            "skip_first_frames": 0,
            "select_every_nth": 1,
        },
    }
    new_prompt[str(load_image_nid)] = {
        "class_type": "LoadImage",
        "inputs": {"image": mask_rel},
    }
    new_prompt[str(mask_nid)] = {
        "class_type": "ImageToMask",
        "inputs": {"image": [str(load_image_nid), 0], "channel": "red"},
    }
    new_prompt[str(apply_nid)] = {
        "class_type": "MiniMaxH3FunControlNetApply",
        "inputs": {
            "model": list(model_ref),
            "model_patch": [str(loader_nid), 0],
            "vae": list(vae_ref),
            "strength": float(strength),
            "start_percent": 0.0,
            "end_percent": 1.0,
            "mask": [str(mask_nid), 0],
            "source_video": [str(video_nid), 0],
        },
    }

    # 4. 模型链改接 + denoise 强制
    # sched 仅当原 model 引用与 guider 原 model 引用同源 (逐元素相等) 才改接: 同源模板
    # 与现行行为全等; 异源模板 (ref2v 的 sched 接 MiniMaxH3SigmaShift) 保留原链, 避免把
    # sigma 偏移节点从 sigma 计算链上丢掉.
    sched_model_ref = (new_prompt[sched_nid].get("inputs") or {}).get("model")
    if isinstance(sched_model_ref, list) and sched_model_ref == model_ref:
        new_prompt[sched_nid]["inputs"]["model"] = [str(apply_nid), 0]
    new_prompt[guider_nid]["inputs"]["model"] = [str(apply_nid), 0]
    new_prompt[sched_nid]["inputs"]["denoise"] = 1.0

    return new_prompt, {
        "injected": True, "reason": "",
        "nodes": {"loader": int(loader_nid), "video": int(video_nid),
                  "load_image": int(load_image_nid), "mask": int(mask_nid),
                  "apply": int(apply_nid)},
        "removed_continuation": removed_continuation,
    }


_LIPSYNC_FPS = 24
# 色彩对齐死区: 饱和度比偏差 < 5% → 跳过 (不值一次有损重编码)
LIPSYNC_COLOR_SKIP_TOL = 0.05


def _rerun_lipsync_assemble_prompt(*, models, ref_video_rel, ref_image_rels,
                                   drive_audio_rel, prompt_text, width, height,
                                   length, seed, filename_prefix, fps=_LIPSYNC_FPS):
    """V1.13h 第二波 T2: 段二 Ref2VA 口型回锚 prompt 组装 — 纯函数.

    与真机验证过的 `docs/证据-1.13h/F组/F2_workflow.json` 同构: 16 核心节点
    (模型链 turbo LoRA / LoadAudio+AudioWindow / AudioConditioningT8 / 双时钟采样 4 件 /
    AVDecodeT8 / OutputTrimT8 mux / VHS_VideoCombine) + 2 个 ref LoadImage = 18 节点.
    关键约束 (F 组试错教训):
      - autogrow 键名是**点号** `ref_images.ref_image_N` / `ref_videos.ref_video_N`;
      - 走**纯 Ref2VA** (Hybrid 路径被 T8 包禁用; ref2va 任务不接受 first_frame) —
        故不写 first_frame;
      - `audio_mode=lock_source` 锁原声, 口型被音频硬锚定;
      - 音频从 `conditioning` 输出槽 2 进 `OutputTrimT8` 做 mux (原音轨).
      - 潜变量 length 引用 AudioWindowT8 窗帧数输出 (["7",1]): 短场景 <124 帧时 T8 扩窗,
        潜变量须与窗同长, trim 才能切出主场景段不越界 (3s 片窗=124).
      - width/height 向上对齐 32 倍数 (T8 硬校验 %32==0; ref2v 族段一 848 宽产物对齐为 864)

    入参:
      models: {unet, clip, vae_video, vae_audio, lora} (段一模板同源名, 不硬编码)
      ref_video_rel: 段一产物全片入仓 basename (VHS_LoadVideo)
      ref_image_rels: [中帧, 尾帧] 两张入仓 PNG basename (→ ref_image_0/1)
      drive_audio_rel: 原段原声 wav 入仓 basename (16kHz mono)
      width/height/length: 段一产物实测 (ffprobe) 分辨率/帧数
      seed: manifest[sid].seed
      filename_prefix: VHS_VideoCombine 输出前缀 (调用方给 run 目录相对前缀)
    出参: (prompt, report); report = {assembled, reason, nodes}
    """
    if not isinstance(ref_image_rels, (list, tuple)) or len(ref_image_rels) != 2:
        return {}, {"assembled": False,
                    "reason": "ref_image_rels 须为 [中帧, 尾帧] 两项"}
    try:
        w, h, ln, sd = int(width), int(height), int(length), int(seed)
    except (TypeError, ValueError):
        return {}, {"assembled": False,
                    "reason": "width/height/length/seed 须为整数"}
    if w <= 0 or h <= 0 or ln <= 0:
        return {}, {"assembled": False, "reason": "width/height/length 须 > 0"}
    need = ("unet", "clip", "vae_video", "vae_audio", "lora")
    missing = [k for k in need if not (models or {}).get(k)]
    if missing:
        return {}, {"assembled": False, "reason": "模型名缺失: %s" % ",".join(missing)}

    # T8 包 width/height 硬校验 %32==0 (跨包契约, conditioning.py:151); ref2v 族段一产物
    # 848x480 走 16 对齐 (:2819-2834) 非 32 倍数, 向上对齐消除 (848→864, 与 t2v 族统一)。
    # 参照图/视频由 T8 自动 resize 适配 (match/adapt_canvas), 潜变量对齐即可; cap 附近极端值
    # 向上取整后报错口径从 %32 变 cap exceed, 仍走 lipsync_failed 可见降级。
    w = ((w + 31) // 32) * 32
    h = ((h + 31) // 32) * 32

    p = {}
    p["1"] = {"class_type": "UNETLoader",
              "inputs": {"unet_name": models["unet"], "weight_dtype": "default"}}
    p["2"] = {"class_type": "CLIPLoader",
              "inputs": {"clip_name": models["clip"], "type": "minimax",
                         "device": "default"}}
    p["3"] = {"class_type": "VAELoader", "inputs": {"vae_name": models["vae_video"]}}
    p["4"] = {"class_type": "VAELoader", "inputs": {"vae_name": models["vae_audio"]}}
    p["5"] = {"class_type": "MiniMaxH3TurboLoRA",
              "inputs": {"model": ["1", 0], "lora_name": models["lora"],
                         "strength": 1.0, "low_vram": False}}
    p["6"] = {"class_type": "LoadAudio", "inputs": {"audio": drive_audio_rel}}
    p["7"] = {"class_type": "MiniMaxH3AudioWindowT8",
              "inputs": {"audio": ["6", 0], "scene_start_seconds": 0.0,
                         "scene_duration_seconds": ln / float(fps),
                         "warmup_seconds": 0.0, "cooldown_seconds": 0.0,
                         "ensure_minimum_context": True}}
    p["8"] = {"class_type": "VHS_LoadVideo",
              "inputs": {"video": ref_video_rel, "force_rate": fps,
                         "custom_width": 0, "custom_height": 0,
                         "frame_load_cap": ln, "skip_first_frames": 0,
                         "select_every_nth": 1}}
    p["9"] = {"class_type": "MiniMaxH3AudioConditioningT8",
              "inputs": {
                  "clip": ["2", 0], "video_vae": ["3", 0], "audio_vae": ["4", 0],
                  "prompt": prompt_text, "width": w, "height": h,
                  # 潜变量 length 引用窗帧数 (AudioWindowT8 槽 1 输出): 短场景 <124 帧时
                  # T8 扩窗, 潜变量须与窗同长, trim 才能切出主场景段不越界 (3s 片窗=124)
                  "length": ["7", 1],
                  "task_type": "Ref2VA", "audio_mode": "lock_source",
                  "audio_denoise_strength": 0.35, "add_source_as_reference": True,
                  "prompt_primary_audio_ordinal": 1, "strict_prompt_tags": True,
                  "ref_image_size": "match",
                  "reference_video_policy": "official_2_to_15s",
                  "drive_audio": ["7", 0],
                  "ref_videos": {"ref_video_0": ["8", 0]},
                  "ref_images.ref_image_0": ["17", 0],
                  "ref_images.ref_image_1": ["18", 0],
              }}
    p["10"] = {"class_type": "MiniMaxH3DualClockSamplerT8",
               "inputs": {"model": ["5", 0], "av_latent": ["9", 1], "steps": 4,
                          "shift_video": 12.0, "shift_audio": 3.0}}
    p["11"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": sd}}
    p["12"] = {"class_type": "BasicGuider",
               "inputs": {"model": ["10", 0], "conditioning": ["9", 0]}}
    p["13"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["11", 0], "guider": ["12", 0],
                          "sampler": ["10", 1], "sigmas": ["10", 2],
                          "latent_image": ["9", 1]}}
    p["14"] = {"class_type": "MiniMaxH3AVDecodeT8",
               "inputs": {"av_latent": ["13", 0], "video_vae": ["3", 0],
                          "audio_vae": ["4", 0]}}
    p["15"] = {"class_type": "MiniMaxH3OutputTrimT8",
               "inputs": {"frames": ["14", 0], "start_seconds": ["7", 2],
                          "duration_seconds": ["7", 3], "fps": float(fps),
                          "audio": ["9", 2]}}
    p["16"] = {"class_type": "VHS_VideoCombine",
               "inputs": {"frame_rate": fps, "loop_count": 0,
                          "filename_prefix": filename_prefix,
                          "format": "video/h264-mp4", "pix_fmt": "yuv420p",
                          "crf": 19, "save_metadata": True,
                          "trim_to_audio": False, "pingpong": False,
                          "save_output": True, "images": ["15", 0],
                          "audio": ["15", 1]}}
    p["17"] = {"class_type": "LoadImage", "inputs": {"image": ref_image_rels[0]}}
    p["18"] = {"class_type": "LoadImage", "inputs": {"image": ref_image_rels[1]}}

    return p, {"assembled": True, "reason": "",
               "nodes": {"unet": 1, "clip": 2, "vae_video": 3, "vae_audio": 4,
                         "lora": 5, "load_audio": 6, "audio_window": 7, "video": 8,
                         "cond": 9, "sampler": 10, "noise": 11, "guider": 12,
                         "sampler_custom": 13, "decode": 14, "trim": 15,
                         "combine": 16, "ref_image_0": 17, "ref_image_1": 18}}


# ===== 1.14 整改批 F · F1: widget 按名绑定 (最高优先) =====
# 背景 (T-B R1/R2): 旧通用兜底 = 纯位置游标, 分支已消费的参数不推进游标 (游标恒从 0 起)
#   → 任何"分支少枚举尾部 widget / schema 增参"都会把 wv[0] 静默填到尾部参数
#   (R1 实证: SeedVR2LoadVAEModel.cache_model 被填成 model 名, ComfyUI bool() 强转 True).
# 修法: 按名绑定 — schema 名序中每个 widget 参数取其名次槽位; 已消费槽位 (UI widget 槽
#   实读下标 + 分支/连线按名取值的参数名次) 不复用; 槽位耗尽 (模板槽数 < schema widget
#   参数数 = 数量不符) → 弃填, 绝不借别的槽位顶替 + widget_count_mismatch 黄条
#   (required 缺 → ComfyUI 400 → 段 failed 可见; optional 缺 → 节点默认值生效).
_WIDGET_BASE_TYPES = ("INT", "FLOAT", "STRING", "BOOLEAN")


def _widget_param_names(input_spec):
    """schema (object_info[t]["input"]) 中可作为 widget 的参数名 (名序 = schema 序)。

    连接类型 (MODEL/IMAGE/AUDIO/自定义) 不占 widgets_values 槽位 → 不收;
    combo (列表形态) 与基础类型收 (与既有兜底判据同口径);
    字符串 "COMBO" 哨兵形态也收 (object_info 真机形态: H3SLAAttention.block_size /
    UpscaleModelLoader.model_name / KSamplerSelect.sampler_name 等常见节点都以此形态
    暴露, 旧判据不收该形态会令该名不入名序, 后续 widget 槽位错位).
    """
    names = []
    for section in ("required", "optional"):
        for name, spec in (input_spec.get(section) or {}).items():
            ptype = spec[0] if isinstance(spec, (list, tuple)) and spec else None
            if isinstance(ptype, (list, tuple)) or ptype in _WIDGET_BASE_TYPES or ptype == "COMBO":
                names.append(name)
    return names


def bind_widgets(input_spec, wv, consumed_idx, skip=()):
    """F1 按名绑定: widget 参数 (schema 名序) ↔ widgets_values 槽位 (纯函数)。

    - 逐个未绑定参数按名序取下一个**未消费**槽位 (consumed_idx 内的下标不复用);
    - 槽位耗尽 → 该参数**弃填** (不拿别的槽位顶替 — 旧位置游标会错填), 交调用方报黄条;
    - skip: 本次不绑定的参数名 (连线值 / 分支已写入 / UI 槽位占位)。
    返回 (bindings, abandoned): bindings=[(name, value)]; abandoned=[name, ...] 弃填名单。
    """
    avail = [i for i in range(len(wv)) if i not in consumed_idx]
    bindings, abandoned = [], []
    for name in _widget_param_names(input_spec):
        if name in skip:
            continue
        if avail:
            bindings.append((name, wv[avail.pop(0)]))
        else:
            abandoned.append(name)
    return bindings, abandoned


# ===== 1.14 整改批 F · P2: convert() 分支注册表化 (T-B 预案②) =====
# 背景: convert() 热路径的 21 条类特判 if/elif 内联在节点循环里 — 加一类节点要动主干,
#   漏登记无护栏; 分支消费的 widgets_values 槽位靠事后"名次推导"回补 (F1 过渡形态).
# 本批: 各分支原地改造为 apply_* 模块级纯函数 (函数体 = 原分支体逐行搬运, 含注释);
#   BRANCH_REGISTRY 单一注册表 + convert() 查表分发; apply_* 返回 literal consumed_idx
#   (本次消费的槽位集合, 通用兜底不再复用 — T-B "分支返回 consumed_idx" 形态);
#   模块加载自检 key 集合 == 权威清单 _BRANCH_CLASSES (缺/多即 RuntimeError).
# 行为口径: 逐字节等价 — 返回值只增补"槽位消费"语义; F1 名次推导保留 (连线型 widget
#   参数槽 + 无分支节点仍由它兜底), 二者取并集。真机 schema 逐类核对 (除下述例外) literal ⊇
#   推导集, 且 literal 独占槽位对应参数名均已由分支写入 (bind 结果不变); 例外 —
#   MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo literal = ∅: 这两类的 widget 绑定
#   由 convert() 内 F1 名次推导兜住, **不得移除该推导**, 否则这两类行为改变;
#   见 test_p2_branch_registry.py.


def _branch_slots(wv, n):
    """literal 消费集: 分支布局前 n 槽 ∩ 模板实存槽位 (槽数不足 = 尾部缺槽, 不虚占)."""
    return set(range(min(n, len(wv))))


def apply_random_noise(inputs, wv, seed):
    inputs["noise_seed"] = seed
    return _branch_slots(wv, 1)


def apply_vae_loader(inputs, wv, seed):
    inputs["vae_name"] = wv[0]
    return _branch_slots(wv, 1)


def apply_clip_loader(inputs, wv, seed):
    inputs["clip_name"] = wv[0]; inputs["type"] = wv[1]; inputs["device"] = wv[2]
    return _branch_slots(wv, 3)


def apply_unet_loader(inputs, wv, seed):
    inputs["unet_name"] = wv[0]; inputs["weight_dtype"] = wv[1]
    return _branch_slots(wv, 2)


def apply_load_image(inputs, wv, seed):
    inputs["image"] = wv[0]
    return _branch_slots(wv, 1)


def apply_load_video(inputs, wv, seed):
    inputs["file"] = wv[0]
    return _branch_slots(wv, 1)


def apply_resolution_selector(inputs, wv, seed):
    inputs["aspect_ratio"] = wv[0]; inputs["megapixels"] = wv[1]; inputs["multiple"] = wv[2]
    return _branch_slots(wv, 3)


def apply_comfy_math_expression(inputs, wv, seed):
    if "expression" not in inputs:
        inputs["expression"] = wv[0]
    if "values.a" not in inputs:
        inputs["values.a"] = 5.0
    return _branch_slots(wv, 1)


def apply_minimax_h3_turbo_lora(inputs, wv, seed):
    inputs["lora_name"] = wv[0]; inputs["strength"] = wv[1]; inputs["low_vram"] = wv[2]
    return _branch_slots(wv, 3)


def apply_rtx_video_super_resolution(inputs, wv, seed):
    # V3 DynamicCombo 节点: widgets_values 平铺 [resize_type, scale|w, h, quality]
    # V1 prompt 权威形态 = 选择键 + 带前缀子参数键 (comfy_api _io.finalize_prefix
    # "." 连接: "resize_type.scale"; 服务端校验按前缀键查 required, 执行期
    # build_nested_inputs 组嵌套 TypedDict). 平级裸键/嵌套 dict 均过不了
    # outputs 校验 (2026-09-03 真机三形态实证). list 形态内值兼容:
    # scale 是 [2], w/h 在变体模板里也可能包 list.
    def _rtx_inner(v, default):
        return v[0] if isinstance(v, list) and v else (v if v is not None else default)
    _rt = wv[0] if len(wv) > 0 else "scale by multiplier"
    inputs["resize_type"] = _rt
    if _rt == "scale by multiplier":
        inputs["resize_type.scale"] = _rtx_inner(wv[1] if len(wv) > 1 else None, 2)
    else:
        inputs["resize_type.width"] = _rtx_inner(wv[1] if len(wv) > 1 else None, 1920)
        inputs["resize_type.height"] = _rtx_inner(wv[2] if len(wv) > 2 else None, 1080)
    # quality 仅当尾串在合法白名单才透传, 否则兜底 ULTRA
    _q = wv[-1] if wv and isinstance(wv[-1], str) else None
    inputs["quality"] = _q if _q in _RTX_QUALITY_OPTIONS else "ULTRA"
    return set(range(len(wv)))


def apply_save_video(inputs, wv, seed):
    inputs["filename_prefix"] = wv[0]; inputs["format"] = wv[1]; inputs["codec"] = wv[2]
    return _branch_slots(wv, 3)


def apply_seedvr2_video_upscaler(inputs, wv, seed):
    # widget 顺序: seed(0), resolution(1), max_resolution(2), batch_size(3),
    #              uniform_batch_size(4), temporal_overlap(5), prepend_frames(6),
    #              color_correction(7), input_noise_scale(8), latent_noise_scale(9),
    #              offload_device(10), enable_debug(11)
    # image/dit/vae 是 Image/Custom 连接型 — 上面 inputs 循环已处理连线
    _def = lambda i, d=None: (wv[i] if i < len(wv) else d)
    inputs["seed"] = _def(0, 42)
    inputs["resolution"] = _def(1, 1080)
    inputs["max_resolution"] = _def(2, 0)
    inputs["batch_size"] = _def(3, 5)
    inputs["uniform_batch_size"] = _def(4, False)
    inputs["temporal_overlap"] = _def(5, 0)
    inputs["prepend_frames"] = _def(6, 0)
    # 颜色校正: 合法枚举内透传, 否则兜底 "wavelet" (源码 default)
    _cc = _def(7, "wavelet")
    inputs["color_correction"] = _cc if _cc in _SEEDVR2_COLOR_CORRECTION else "wavelet"
    inputs["input_noise_scale"] = _def(8, 0.0)
    inputs["latent_noise_scale"] = _def(9, 0.0)
    _od = _def(10, "cpu")
    inputs["offload_device"] = _od if _od in _SEEDVR2_OFFLOAD_DEVICE else "cpu"
    inputs["enable_debug"] = _def(11, False)
    return _branch_slots(wv, 12)


def apply_seedvr2_load_dit_model(inputs, wv, seed):
    # widget 顺序: model(0), device(1), blocks_to_swap(2), swap_io_components(3),
    #              offload_device(4), cache_model(5), attention_mode(6)
    _def = lambda i, d=None: (wv[i] if i < len(wv) else d)
    inputs["model"] = _def(0, "")
    inputs["device"] = _def(1, "auto")
    inputs["blocks_to_swap"] = _def(2, 0)
    inputs["swap_io_components"] = _def(3, False)
    inputs["offload_device"] = _def(4, "cpu")
    inputs["cache_model"] = _def(5, True)
    inputs["attention_mode"] = _def(6, "sdpa")
    return _branch_slots(wv, 7)


def apply_seedvr2_load_vae_model(inputs, wv, seed):
    # widget 顺序: model(0), device(1), encode_tiled(2), encode_tile_size(3),
    #              encode_tile_overlap(4), decode_tiled(5), decode_tile_size(6),
    #              decode_tile_overlap(7), tile_debug(8), offload_device(9)
    # C5: 真机 schema 第 11 项 cache_model (BOOLEAN 默认 False) — 模板 widgets_values
    # 只有 10 项无此槽, 旧分支只枚举 10 项 → 通用兜底把 wv[0]="ema_vae_fp16.safetensors"
    # 填给 cache_model, ComfyUI execution.py 对 BOOLEAN 静默 bool() 强转 → True.
    # 显式补默认 False (T3-cache_model + T-B R1), 模板零改动 / N 盘零写入.
    _def = lambda i, d=None: (wv[i] if i < len(wv) else d)
    inputs["model"] = _def(0, "")
    inputs["device"] = _def(1, "auto")
    inputs["encode_tiled"] = _def(2, True)
    inputs["encode_tile_size"] = _def(3, 512)
    inputs["encode_tile_overlap"] = _def(4, 64)
    inputs["decode_tiled"] = _def(5, True)
    inputs["decode_tile_size"] = _def(6, 512)
    inputs["decode_tile_overlap"] = _def(7, 64)
    inputs["tile_debug"] = _def(8, "false")  # 真机候选 ["false","encode","decode"], 旧默认 "off" 非法
    inputs["offload_device"] = _def(9, "cpu")
    inputs["cache_model"] = False
    return _branch_slots(wv, 11)


def apply_rife_vfi(inputs, wv, seed):
    # widget 顺序: ckpt_name(0), frames(1) 连接型已处理, clear_cache_after_n_frames(2),
    #              multiplier(3), fast_mode(4), ensemble(5), scale_factor(6),
    #              dtype(7), torch_compile(8), batch_size(9)
    # frames 在 inputs list 中是连接型 — 上面 inputs 循环已处理
    # 1.14b U6 修正: required 尾部含 batch_size (object_info 实测 10 项) —
    # 分支漏填会触发通用补齐游标错位 (batch_size 收到 wv[0]=ckpt 名, 400 实证)
    _def = lambda i, d=None: (wv[i] if i < len(wv) else d)
    inputs["ckpt_name"] = _def(0, _RIFE_CKPT_DEFAULT)
    # index 1 是 frames 连接型, 不在 wv 中; clear_cache_after_n_frames 在 wv[1]
    inputs["clear_cache_after_n_frames"] = _def(1, 10)
    inputs["multiplier"] = _def(2, 2)
    inputs["fast_mode"] = _def(3, True)
    inputs["ensemble"] = _def(4, True)
    inputs["scale_factor"] = _def(5, 1.0)
    inputs["dtype"] = _def(6, "float32")
    inputs["torch_compile"] = _def(7, False)
    inputs["batch_size"] = _def(8, 1)
    return _branch_slots(wv, 9)


def apply_create_video(inputs, wv, seed):
    inputs["fps"] = wv[0]; inputs["bit_depth"] = wv[1]
    return _branch_slots(wv, 2)


def apply_basic_scheduler(inputs, wv, seed):
    if "scheduler" not in inputs:
        inputs["scheduler"] = wv[0]; inputs["steps"] = wv[1]; inputs["denoise"] = wv[2]
    return _branch_slots(wv, 3)


def apply_ksampler_select(inputs, wv, seed):
    if "sampler_name" not in inputs:
        inputs["sampler_name"] = wv[0]
    return _branch_slots(wv, 1)


def apply_minimax_h3_reference_to_video(inputs, wv, seed):
    inputs["ref_image_size"] = "match"
    return set()


def apply_minimax_h3_image_to_video(inputs, wv, seed):
    pass
    return set()


def apply_model_attention_backend(inputs, wv, seed):
    inputs["attention"] = wv[0]
    return _branch_slots(wv, 1)


BRANCH_REGISTRY = {
    "RandomNoise": apply_random_noise,
    "VAELoader": apply_vae_loader,
    "CLIPLoader": apply_clip_loader,
    "UNETLoader": apply_unet_loader,
    "LoadImage": apply_load_image,
    "LoadVideo": apply_load_video,
    "ResolutionSelector": apply_resolution_selector,
    "ComfyMathExpression": apply_comfy_math_expression,
    "MiniMaxH3TurboLoRA": apply_minimax_h3_turbo_lora,
    "RTXVideoSuperResolution": apply_rtx_video_super_resolution,
    "SaveVideo": apply_save_video,
    "SeedVR2VideoUpscaler": apply_seedvr2_video_upscaler,
    "SeedVR2LoadDiTModel": apply_seedvr2_load_dit_model,
    "SeedVR2LoadVAEModel": apply_seedvr2_load_vae_model,
    "RIFE VFI": apply_rife_vfi,
    "CreateVideo": apply_create_video,
    "BasicScheduler": apply_basic_scheduler,
    "KSamplerSelect": apply_ksampler_select,
    "MiniMaxH3ReferenceToVideo": apply_minimax_h3_reference_to_video,
    "MiniMaxH3ImageToVideo": apply_minimax_h3_image_to_video,
    "ModelAttentionBackend": apply_model_attention_backend,
}

# 权威分支清单 = convert() 原 if/elif 链实测 21 条 (与 registry 独立拼写 — 互为对照才拦得住
# "漏登记"与"类名漂移"; 与 test_p2_branch_registry.py 的清单三处同源)
_BRANCH_CLASSES = (
    "RandomNoise", "VAELoader", "CLIPLoader", "UNETLoader", "LoadImage", "LoadVideo",
    "ResolutionSelector", "ComfyMathExpression", "MiniMaxH3TurboLoRA",
    "RTXVideoSuperResolution", "SaveVideo", "SeedVR2VideoUpscaler",
    "SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel", "RIFE VFI", "CreateVideo",
    "BasicScheduler", "KSamplerSelect", "MiniMaxH3ReferenceToVideo",
    "MiniMaxH3ImageToVideo", "ModelAttentionBackend",
)


def _selfcheck_branch_registry():
    """启动自检: registry key 集合 == 权威清单, 处理器均可调用; 违例 RuntimeError。"""
    keys, want = set(BRANCH_REGISTRY), set(_BRANCH_CLASSES)
    if keys != want:
        raise RuntimeError("BRANCH_REGISTRY 与分支清单不一致: 缺=%s 多=%s (漏登记会静默退化到通用兜底)"
                           % (sorted(want - keys), sorted(keys - want)))
    bad = sorted(k for k, fn in BRANCH_REGISTRY.items() if not callable(fn))
    if bad:
        raise RuntimeError("BRANCH_REGISTRY 处理器不可调用: %s" % bad)


_selfcheck_branch_registry()  # 模块加载即跑: 漏登记 = import 失败, 不留静默退化空间


class H3BatchEngine:
    # 批1 E1 (#51 归档端点前置⑤): _run_postfx_pipeline in-flight 标记类级默认 —
    # 端点五通道检查 getattr 兜底读; 实例置位/finally 清除见 _run_postfx_pipeline.
    _postfx_pipeline_running = False

    def __init__(self, mode, workflow_path, csv_path, input_dir, output_dir, port=0,
                 start_from=0, retries=2, skip_done=True, client_id="h3-batch",
                 server_input_dir=None, on_fail="阻断", archive_dir="",
                 manifest_suffix="", resources_list="", resource_overrides="{}",
                 lora_overrides="{}", continuation_enabled=True,
                 live_client_id="", session_id="",
                 subject_anchors=None, seg_pools=None, run_subdir=""):
        if on_fail not in ("阻断", "继续"):
            raise ShotError("on_fail 只支持 阻断/继续, 收到: %r" % on_fail)
        self.mode = mode
        self.workflow_path = os.path.abspath(workflow_path) if workflow_path else ""
        self.csv_path = os.path.abspath(csv_path)
        self.input_dir = os.path.abspath(input_dir)
        self.output_dir = os.path.abspath(output_dir)
        # V1.13 波 3 T11 (D9): SaveLatent 服务端写入坐标 = 服务端输出根 (output_dir 校验后
        # 等于 folder_paths.get_output_directory()). 续接查/清以本基准 + basename(run_dir)
        # 推导, 与写入坐标一致 — 归档批重跑 run_dir 非输出根直接子目录时也命中.
        self._server_output_dir = self.output_dir
        self.server_input_dir = os.path.abspath(server_input_dir if server_input_dir is not None else _default_input_dir())
        self.port = port
        self.base = "http://127.0.0.1:%d" % (port or 8188)
        self.start_from = start_from
        self.retries = retries
        self.skip_done = skip_done
        self.on_fail = on_fail
        # V1.12 #44A: archive_dir 相对路径 + archive_root 非空 → 锚到根下; 绝对路径/未配根行为不变.
        if archive_dir and not os.path.isabs(archive_dir) and ARCHIVE_ROOT:
            self.archive_dir = os.path.abspath(os.path.join(ARCHIVE_ROOT, archive_dir))
        else:
            self.archive_dir = os.path.abspath(archive_dir) if archive_dir else ""
        self.client_id = client_id
        # V1.11 批 5 P0 (F-LIVE 生产化透传): GUI 实时预览需定向发给 GUI 自身 sid —
        # ComfyUI preview_state/progress_state 按 server_instance.client_id 路由 ws 帧
        # (comfy_execution/execution.py:736-737), 而 ComfyUI 默认 NoPreviews / preview_method
        # 关闭 (latent_preview.set_preview_method 必须显式调用 — execution.py:731). 因此
        # GUI 要收到帧, 引擎 POST /prompt body 必须: client_id 替换 + 增 extra_data
        # {preview_method="auto", client_id=GUI sid}. 非空时 _run_one 透传; 空值时
        # payload 逐字节回归锁 (与现状一致).
        self.live_client_id = live_client_id or ""
        # V1.12 批 L 波 1 批次 D T6: 任务 ↔ LLM 会话 1:N 弱锚定 — submit 透传后注入 manifest 顶层键.
        # 非空 (已校验 ^[0-9a-f]{28}$) → 写入 manifest.session_id; 空/缺省 → 不写该键 (旧任务零回归).
        self.session_id = session_id or ""
        # 1.13f: 引擎侧锚定行覆盖入口 — submit 透传 → 装配单点 :4727 传参; rerun 不消费 (键保留)
        # 缺省 / 空 / 非 str = 不存该键 (旧任务零回归, _apply_shot_common getattr 兜底)
        self._subject_anchors = subject_anchors if isinstance(subject_anchors, str) else ""
        # 批 K 分镜级动态素材池 — body 顶层键同名直通 (契约 #9/#12, api.md 2546284)。
        # 形态 {sid: {Picture:{槽:{media,usages}}, Video:{}, Audio:{}}}; 键域 = 段行 ID
        # (s01 式, GUI submit.js 与引擎同源同序, 引擎不重编号)。缺省/非 dict = {}
        # → 不并池, 逐字节现行为 (无键兼容铁律)。
        self._seg_pools = seg_pools if isinstance(seg_pools, dict) else {}
        self._stop = threading.Event()
        self._global_prompt = ""
        self._preflight_warns = []
        self._pool_usage = {"Picture": {}, "Video": {}, "Audio": {}}  # V1.4 T1: 池行用途标注(槽号→用途ID)
        self._pose_style = {"Picture": {}}  # 1.14a T1: 姿势样式登记(槽号→"skeleton"|"depth", 仅 Picture 单 pose 槽落键)
        self._lang = "zh"  # 2.9: 批级语言开关, 默认中文; _apply_global 时按 g["语言"] 覆盖
        # 批 A 后小迭代: 三独立勾选状态 — 构造即置 False(防属性未定义); _apply_global 按三键/旧 默认负面 覆盖
        # 保留 _negative_on 属性别名以兼容旧测试探测 (值 = 三键任一为 True)
        self._negative_music = False
        self._negative_dialogue = False
        self._negative_text = False
        self._negative_on = False  # 旧别名 (any of three), 旧调用方可读
        # V1.12 T4: 关场景 批次开关 — 构造即置 False 防属性未定义;
        # _apply_global / preflight 按 CSV 全局键覆盖 (见两处落位)
        self._scene_disabled = False
        # V1.12b v4 M5: 人物建档 批次开关 — 构造即置 False 防属性未定义;
        # _apply_global / preflight 按 CSV 全局键「人物建档」覆盖 (开 → 跑批前建档路由)
        self._enrollment_enabled = False
        self._audio_blocks = []  # T2: 全局音频段(配乐/氛围声)— _apply_global 按 g["配乐"/"氛围声"] 非空填充; 构造即置 [] 防属性未定义
        self._last_final_prompt = ""  # T7: 每段实发文本暂存(供 manifest[sid]["final_prompt"] 落盘; 初始空串, 真实反映未写 prompt 输入的场景)
        self.phase = ""  # V1.7 R13: 跑批收尾阶段白箱 (拼接中/归档中/清点中), 由 status 端点透传到前端; 异常路径由 run() finally 清空
        # V1.9 T2.1 资源编排数据 — widget JSON 字符串解析+规范化(单字段/双字段混存,
        # 重叠排除/模板发现交集语义由批 2 后续任务负责; 本任务只解析+存储, 不注入)
        self._resources = _parse_resources_list(resources_list)
        # V1.9 T2.5 R2 资源覆写 — widget JSON 对象解析+规范化; 非法 JSON 构造时直接抛
        self._overrides = _parse_overrides(resource_overrides)
        # V1.9 T4.4b 模板自带 LoRA 覆写 — widget JSON 对象解析+规范化;
        # 非法 JSON 构造时直接抛 (文案含 "LoRA 覆写列表"); 仅存被用户改过的模板条目
        self._lora_overrides = _parse_lora_overrides(lora_overrides)
        # V1.13 D25: 重跑需从 manifest 原串回灌 (widget 三键), 解析产物丢 strength_clip/order
        # /category 等字段, 解析路径非逐字节复现 ⇒ 仅存 raw 字符串, 重跑端点取回传 build_engine_from_params
        self._resources_raw = resources_list or ""
        self._overrides_raw = resource_overrides or "{}"
        self._lora_overrides_raw = lora_overrides or "{}"
        # V1.9 T2.3 R3 LoRA 链式注入报告 — 构造时置 None, convert() 后填充;
        # UI/日志读取入口 (status 端点 / 前端黄条)
        self._inject_report = None
        # V1.9 T2.5 R2 资源覆写报告 — 构造时置 None, convert() 后填充;
        # UI 黄条/日志读取入口 (类型/槽位警告); 与 _inject_report 同生命周期
        self._override_report = None
        # V1.9 T4.4b 模板 LoRA 覆写报告 — 构造时置 None, convert() 后填充;
        # {applied: [{node, lora, action}], unmatched: [...]}; 与 _override_report 同生命周期
        self._lora_override_report = None
        # V1.9 批 3 T3.2 S1 latent 尾窗续接开关 — 拼接模式生效 (分镜/Quick/队列不触发);
        # 开启时段 N 图追加 SaveLatent 落盘, 段 N+1 图注入 LoadLatent+MotionContext+Trim,
        # 并替代 9 号槽尾帧图注入 (apply_shot_concat prev_frame 路径让位)。
        # "每段可关" CSV 级开关由 T3.3 登记。
        self.continuation_enabled = bool(continuation_enabled)
        # V1.10 批 1 T3 BGM 通道 (D1) — 引擎侧属性 + 读取; 表单/CSV 解析接入
        # 由 T4 完成, 本任务仅构造时置默认值, _concat_videos 内部直接读 (走
        # 英文值保持自洽; 表单中文 "替换"/"混合" 在 T4 由解析层翻译).
        self._bgm_path = ""
        self._bgm_mix_mode = "replace"
        # V1.10 批2 T1: 审片门 (D1) — 0=关(默认, 防旧 CSV 误启审片),
        # N≥1=每渲染 N 段插入一个审片点 (T2 接出暂停/审片报告);
        # _parse_global + _apply_global 链路从 CSV 行覆盖此值 (非负整数, ≤50).
        self._review_every_n = 0
        # V1.11 批 1 T6: 自动拼接开关 (CSV 全局键 "自动拼接", 白名单 "自动"/"不拼") —
        # 旧 CSV 无键 → 构造默认 True (零回归); 不拼 → run/rerun/_rerun_finalize 三处
        # 收尾拼接全部跳过, manifest._concat 写 {status:"skipped", reason:"auto_concat_off"}.
        self._auto_concat = True
        # 1.14b U3: 后处理三键状态 (构造默认 = 不勾 → 旧行为零变化, _finalize_body 短路)
        self._postfx_upscale = False
        self._postfx_interp = False
        self._postfx_engine_choice = "seedvr2"
        # W9R W9-2: 分段阈值下达口 (None = 默认阈值; dict 口径 = postfx_engine.parse_seg_threshold,
        # 缺键补默认)。CSV 未开新键 (避开解析面), 设值由调用方直接赋属性。
        self._postfx_seg_threshold = None
        # V1.10 批2 T2: 审片门暂停门闩 (D2) — _gate.set()=通行(默认), _gate.clear()=暂停;
        # 等待循环在 gate.wait(0.5) 上阻塞, 周期响应 _stop (cancel 可中断暂停).
        # T3 resume 端点会 _gate.set() 放行, T4 引擎死场景无门闩 (用户重提批次).
        self._gate = threading.Event()
        self._gate.set()
        # V1.10 批2 T2: 本检查点窗口的"已成功完成段数"基线 (D2.5) — 醒来时
        # 重置为当前完成段数, 下一次窗口重新累计; 与 _review_every_n 配合判定.
        self._gate_origin = 0
        # S1 注入报告 (每段覆盖; 供 T3.3 降级矩阵/审片报告消费):
        # {active, shot_index, clip_index, mode: save/latent/tail_frame/off..., nodes, reason,
        #  downgrade_reason (T3.3: 降级段非空, latent/save 段空串)}
        self._continuation_report = None
        # 1.11b 波1 T2: 自定义模式逐段勾选派位缓存（_parse_shots 末尾写一次; 懒派生依赖 is None 判定）
        self._seg_flags = None
        # 1.13h 第三波 T4: 段级覆盖现场 (每段 _run_one 入口重置)
        # _last_seg_override = 该段侧车覆盖项; _last_seg_inject_report = 差分应用报告 (_inject_seg);
        # _seg_swap_own = 该段自身换 VAE/UNET; _seg_swap_reason = 本段跳续接原因 (自身换 or 前驱标记)
        self._last_seg_override = {}
        self._last_seg_inject_report = None
        self._seg_swap_own = False
        self._seg_swap_reason = ""
        # V1.9 批 3 T3.3 触发矩阵 a: motion_context_sub patch 预检粘性失败原因
        # (空 = 未失败)。一旦失败本段及后续段全部降级尾帧直连 (不重试, 批不断跑)。
        self._continuation_patch_fail = ""
        # V1.11 批 1 T1: 引擎本次运行新构造段 dict 的 sid 集合; save 前 reload+merge 时
        # 脏 sid 跳过采纳磁盘 review, 保护"首次写盘"防旧 void 复活; 首盘后从集合移除.
        self._manifest_dirty_sids = set()
        # V1.11 批 1 T2b: manifest 文件名依赖 stem + manifest_suffix; 留底便于
        # _new_run_dir/rerun_shot_in_folder/_archive_run 重算 manifest_path.
        self.manifest_suffix = manifest_suffix
        stem = os.path.splitext(os.path.basename(csv_path))[0]
        # 构造时 run_dir 未知, manifest_path 落在 output_dir (向后兼容既有桩测);
        # _new_run_dir() 后会重新指向 run_dir.
        self.manifest_path = os.path.join(
            self.output_dir, "h3_batch_manifest_%s%s.json" % (stem, manifest_suffix))
        # 批 W1 S1-T3 (R-52 甲)·R-52 v2: run_subdir = GUI 指定的运行子目录 (空/缺省 =
        # 时间戳目录, 逐字节现行为). v2 起分段清洗 _sanitize_run_subdir (嵌套子路径,
        # 穿越段整串拒收); 清洗后为空串则自然回落时间戳目录. 非空时构造期即锚定
        # manifest: run() 先 _load_manifest 后 _new_run_dir, 同 stem 多夹时
        # 多夹时 glob/mtime 回退可能拾到错夹的账本 (批 W1 侦察风险 1) — 预写消除该窗口.
        self.run_subdir = _sanitize_run_subdir(run_subdir)
        if self.run_subdir:
            self.manifest_path = os.path.join(
                self.output_dir, self.run_subdir,
                "h3_batch_manifest_%s%s.json" % (stem, manifest_suffix))

    # V1.9 T2.1: _parse_resources_list 暴露为静态方法(供单测 + 外部显式调用)
    # 实现委托给模块级 _parse_resources_list(无状态, 易测)
    @staticmethod
    def _parse_resources_list(raw):
        return _parse_resources_list(raw)

    # V1.9 T2.3 R3: _inject_loras / _compute_inject_fingerprint 暴露为静态方法
    # (供单测 + 外部显式调用); 实现委托给模块级同名函数 (无状态, 易测)
    # V1.9 T2.5: 签名扩展 overrides 参数 (向后兼容 T2.3 调用方)
    # V1.9 T4.4b: 签名扩展 lora_overrides 参数 (向后兼容 T2.5 调用方)
    # 1.14 P4: 签名扩展 schema 参数 (object_info; 缺省 None = 旧启发式路径)
    @staticmethod
    def _inject_loras(prompt, resources, fresh_id, overrides=None, lora_overrides=None,
                      schema=None):
        return _inject_loras(prompt, resources, fresh_id, overrides=overrides,
                             lora_overrides=lora_overrides, schema=schema)

    @staticmethod
    def _compute_inject_fingerprint(resources, overrides=None, lora_overrides=None):
        return _compute_inject_fingerprint(resources, overrides=overrides,
                                           lora_overrides=lora_overrides)

    # V1.9 T2.5: _parse_overrides / _apply_overrides 暴露为静态方法
    @staticmethod
    def _parse_overrides(raw):
        return _parse_overrides(raw)

    @staticmethod
    def _apply_overrides(prompt, overrides, workflow_path=""):
        return _apply_overrides(prompt, overrides, workflow_path=workflow_path)

    # V1.9 T4.4b: _parse_lora_overrides / _apply_lora_overrides 暴露为静态方法 (同款先例)
    @staticmethod
    def _parse_lora_overrides(raw):
        return _parse_lora_overrides(raw)

    @staticmethod
    def _apply_lora_overrides(prompt, lora_overrides):
        return _apply_lora_overrides(prompt, lora_overrides)

    # W9R: postfx 分段链路按鸭子类型契约消费 engine._run_media_cmd
    # (postfx_engine _segment_video/_concat_segments) — 委托模块级同名函数 (无状态, 易测)。
    # 缺此接线时 _has_method 判 False → TypeError → 长片分段真机必失败 (U5 只有单测)。
    _run_media_cmd = staticmethod(_run_media_cmd)

    @staticmethod
    def _detect_port():
        if os.environ.get("H3_DISABLE_PORT_DETECT"):
            # 测试环境保险丝 (conftest 置位): 测试进程永不探测/提交到真实 ComfyUI
            # 实例 — 2026-09-04 泄漏事故根因 (桩窗口外构造的真引擎撞上老板 8189)。
            raise ShotError("测试环境禁用 ComfyUI 端口探测 (H3_DISABLE_PORT_DETECT)")
        for p in range(8188, 8201):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/system_stats" % p, timeout=1) as r:
                    if r.status == 200:
                        return p
            except Exception:
                continue
        raise ShotError("未找到运行中的 ComfyUI(扫描 8188-8200 无响应), 请手动指定 port")

    # ---------------- API ----------------
    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=30) as r:
            return json.loads(r.read().decode())

    def _post(self, path, payload):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())

    # ---------------- CSV 解析 ----------------
    def _parse_rows(self):
        raw = []
        with open(self.csv_path, encoding="utf-8-sig") as f:
            for row in csv.reader(f):
                row = [c.strip() if isinstance(c, str) else c for c in row]
                if any(c not in ("", None) for c in row):
                    raw.append(row)
        return raw

    def _parse_pool(self, raw):
        # V1.4 T1: 槽位值可写 "文件名|用途ID"; V1.4 T6: 支持 "+" 分隔多用途 → 值恒 list[str]
        # 1.14a T1: 三段式 "文件名|用途|样式" — 样式仅对 Picture 单 pose 槽生效, 两段式旧行为不变
        pool = {"Picture": {}, "Video": {}, "Audio": {}}
        for row in raw:
            key = row[0] if row else ""
            if key in pool:
                for i, cell in enumerate(row[1:], start=1):
                    if cell:
                        if "|" in cell:
                            fname, _, rest = cell.partition("|")
                            usage_raw, _, style_raw = rest.partition("|")
                            fname = fname.strip()
                            pool[key][i] = fname
                            if usage_raw.strip():
                                # 多用途 + 分隔; 已知按顺序保留; 未知逐个剔除各告警
                                ids = [s.strip() for s in usage_raw.split("+") if s.strip()]
                                kept = []
                                for uid in ids:
                                    if uid in KNOWN_USAGE_IDS:
                                        kept.append(uid)
                                    else:
                                        self._preflight_warns.append(
                                            "%s 槽 %d 用途 ID 未知, 按未指定处理: %r"
                                            % (key, i, uid)
                                        )
                                if kept:
                                    self._pool_usage[key][i] = kept
                            if style_raw.strip():
                                # 1.14a T1: 第三段=姿势样式; 仅 Picture 单 pose 槽落 _pose_style (S3)
                                # 混标槽带样式同此出口不落表; 9 号槽即使单 pose 也黄条忽略 (L8)
                                if key != "Picture" or self._pool_usage.get(key, {}).get(i) != ["pose"]:
                                    self._preflight_warns.append(
                                        "%s 槽 %d 的姿势样式仅对 Picture 姿势槽有效, 已忽略"
                                        % (key, i)
                                    )
                                elif i == 9:
                                    self._preflight_warns.append(
                                        "Picture 9 号槽为动态衔接槽, 姿势标注与样式无效, 已忽略")
                                else:
                                    st = style_raw.strip()
                                    if st in POSE_STYLE_IDS:
                                        self._pose_style[key][i] = st
                                    else:
                                        self._preflight_warns.append(
                                            "Picture 槽 %d 姿势样式未知, 按骨架处理: %r" % (i, st))
                                        self._pose_style[key][i] = "skeleton"
                        else:
                            pool[key][i] = cell
        # 1.14a T1: 混用途检查(Picture 专属) + 9 号槽姿势黄条 — 挂 usage 落表处,
        # 与样式第三段无关(两段式 9 号 pose 也触发); 姿势从 9 号用途剔除落表(全空删键)
        for i, ids in list(self._pool_usage["Picture"].items()):  # list 快照: 循环内可能删 9 号键
            if "pose" in ids and len(ids) > 1:
                self._preflight_warns.append(
                    "Picture 槽 %d 姿势与其他用途混标, 本次按原图直通不转换, 请拆槽" % i)
            elif i == 9 and "pose" in ids:
                self._preflight_warns.append(
                    "Picture 9 号槽为动态衔接槽, 姿势标注无效, 已忽略")
                kept9 = [u for u in ids if u != "pose"] or []
                if kept9:
                    self._pool_usage["Picture"][9] = kept9
                else:
                    del self._pool_usage["Picture"][9]
        return pool

    def _parse_global(self, raw):
        g = {}
        for row in raw:
            if not row or len(row) < 2 or not row[1]:
                continue
            if row[0] == "提示词":
                # 未加引号时逗号会切到多列, 容错拼回
                g["提示词"] = ", ".join(c for c in row[1:] if c)
            elif row[0] in ("比例", "质量", "步数", "批次次数"):
                g[row[0]] = row[1]
            elif row[0] == "语言":  # 2.9: 批级语言开关(中文/英文, 缺省回落中文)
                g["语言"] = row[1]
            elif row[0] in ("关音乐", "关对白", "关水印字幕", "关场景", "人物建档"):
                # 批 A 后小迭代: 三独立勾选 — 值开/关; 旧 CSV 无此键 → 不落键, 视作关
                # V1.12 T4: 并入 关场景 (批次开关, 同款解析; 值="开" 才生效)
                # V1.12b v4 M5: 并入 人物建档 (跑批前建档路由开关, 同款解析; 值="开" 才生效)
                g[row[0]] = row[1]
            elif row[0] == "默认负面":
                # Task 1 兼容 anchor: 旧 CSV 单开关, _apply_global 阶段映射三全勾/全不勾
                # 引擎侧独立解析; 与新三键并存时, 新键优先(见 _apply_global)
                g["默认负面"] = row[1]
            elif row[0] in ("配乐", "氛围声"):  # T2: 音频二态全局键 — 值=非空描述文本, 落键供 _apply_global 拼装
                g[row[0]] = row[1]
            elif row[0] == "音乐文件":  # V1.10 批1 T4: BGM 通道 D2 — 值=路径串, _apply_global 去空白落 _bgm_path
                g["音乐文件"] = row[1]
            elif row[0] == "音乐混入方式":  # V1.10 批1 T4: 脏值防御在解析层做 — 白名单 替换/混合, 其他(含空/乱串)落默认 替换
                v = str(row[1] or "").strip()
                g["音乐混入方式"] = v if v in ("替换", "混合") else "替换"
            elif row[0] == "审片门":  # V1.10 批2 T1: 脏值防御在解析层做 — 非负整数 & ≤50, 其他(含空/乱串/负数)不落键 (回落默认 0)
                v = str(row[1] or "").strip()
                if v.isdigit() and int(v) <= 50:
                    g["审片门"] = v
                # 非法值 (含 "-1", "abc", "99", "1.5", 空) 不落键, _apply_global 走构造默认 0
            elif row[0] == "自动拼接":  # V1.11 批 1 T6: 自动拼接开关 — 白名单 自动/不拼, 脏值不落键 (回落默认 自动)
                v = str(row[1] or "").strip()
                if v in ("自动", "不拼"):
                    g["自动拼接"] = v
            elif row[0] in ("放大", "插帧"):  # 1.14b U3: 后处理二态开关 — 白名单 开/关, 脏值不落键 (回落默认 关)
                v = str(row[1] or "").strip()
                if v in ("开", "关"):
                    g[row[0]] = v
            elif row[0] == "放大引擎":  # 1.14b U3: 引擎白名单 seedvr2/rtxvsr; 脏值不落键 (回落默认 seedvr2)
                v = str(row[1] or "").strip()
                if v in ("seedvr2", "rtxvsr"):
                    g["放大引擎"] = v
            elif row[0] == "角色绑定":
                # 批 H1 角色绑定 — Excel 切列时多列是同一 JSON 值的子串,
                # 用 ",".join row[1:] 无空格拼回 (C4 规范); json.loads 容错
                # (损坏 = 忽略该键 + 预检 WARN, 由 _apply_global/_load_assets 串联告知)
                joined = ",".join(c for c in row[1:] if c)
                if not joined:
                    continue
                try:
                    parsed = json.loads(joined)
                except (ValueError, TypeError):
                    continue  # 损坏 — 忽略, 后续 preflight 报告 WARN
                if isinstance(parsed, list):
                    g["角色绑定"] = parsed
                else:
                    continue  # 非数组也忽略, 防前端错值击穿类型契约
        return g

    def _parse_shots(self, raw):
        shots = []
        idx = None
        for i, row in enumerate(raw):
            if row and row[0] == "ID":
                idx = i + 1
                break
        if idx is None:
            raise ShotError("找不到分镜表头行(ID,prompt,...)")
        headers = raw[idx - 1]
        col = {h: j for j, h in enumerate(headers) if h}
        p_idx = col.get("prompt")
        # 第一遍: 收集幸存行 + 其显式非空 ID (供补号防撞 — bugfix: 显式 shot_002 时位置 2 的空 ID 行要跳号)
        survivors = []
        used_ids = set()
        for row in raw[idx:]:
            if not row:
                continue
            p_val = row[p_idx] if p_idx is not None and p_idx < len(row) else ""
            # bugfix: 半空残留行 (整行非全空, 但 ID 与 prompt 列均空) 跳过,
            # 防被自动补号转正成正式分镜污染批次
            if not (row[0] or "").strip() and not (p_val or "").strip():
                continue
            if (row[0] or "").strip():
                used_ids.add((row[0] or "").strip())
            survivors.append(row)
        # 第二遍: 空 ID 行分配未占用编号; 已用编号 → 递增到下一个空号
        for i, row in enumerate(survivors, start=1):
            if not (row[0] or "").strip():
                new_id = "shot_%03d" % i
                while new_id in used_ids:
                    i += 1
                    new_id = "shot_%03d" % i
                row[0] = new_id
                used_ids.add(new_id)
            shots.append({h: (row[j] if j < len(row) else "") for h, j in col.items()})
        # 1.11b 波1 T2: 单一漏斗 — 9 处 _parse_shots 调用全经此缓存 _seg_flags,
        # 替代逐入口枚举（v3 N6 闭环; csv_path 不可变, 无跨批覆盖, 已由复核独立取证）。
        self._seg_flags = derive_seg_flags(shots)
        return shots

    def _derive_seg_flags(self, shots):
        """1.11b 波1 T2: 薄封装调纯函数 — 仅当 self.mode == "自定义" 时,
        对"非空且非 是" 的列值打 WARN 并入 self._preflight_warns（脏值兼容 + 第 1 段忽略提示）。
        非自定义模式调用 = 沉默（保留纯函数值域语义, 不污染分镜/拼接模式日志）。

        1.11b 波2 T5: 第 1 段列值非空 → WARN ("第 1 段恒独立, 该列值被忽略")
        与脏值 WARN 共享同一通道, 不连报两条 (脏值非空且非"是"已涵盖第 1 段填"是"场景 —
        此处只补"第 1 段填 非 是"语义)。
        """
        if self.mode == "自定义":
            for i, row in enumerate(shots):
                if not isinstance(row, dict):
                    continue
                v = row.get(CONCAT_FLAG_COL, None)
                if v is None:
                    continue
                s = str(v or "").strip()
                if not s:
                    continue
                # 第 1 段列值非空（含"是" 与脏值）→ 统一走"恒独立"提示；不与脏值 WARN 连报两条
                if i == 0:
                    self._preflight_warns.append(
                        "自定义模式第 1 段「%s」列值 %r 被忽略（第 1 段恒独立）"
                        % (CONCAT_FLAG_COL, v))
                    continue
                if s == "是":
                    continue
                # 脏值 (非空且非"是") 在非首段 → 脏值提示
                self._preflight_warns.append(
                    "自定义模式「%s」列值 %r 非法, 当否处理（仅识别 \"是\")"
                    % (CONCAT_FLAG_COL, v))
        return derive_seg_flags(shots)

    def _ensure_seg_flags(self):
        """1.11b 波2 T9 节点门补件: 单一漏斗 — `_seg_mode` 与 `_any_seg_concat` 共用
        懒派生 + fail-loud 路径。

        `_parse_shots` 末尾已缓存 `_seg_flags` (见其实现), 此处**不得再赋值** —
        否则会把 shots 列表覆盖到 `_seg_flags` 上, 使其变成 dict 列表 → 每段被误判为
        "勾选" (T2R4 bug)。

        返回当前 `_seg_flags` (bool 列表); None 时调一次 `_parse_shots` 强制派生,
        仍未派生 raise ShotError (与"未派生"语义严格分离)。
        """
        if self._seg_flags is None:
            self._parse_shots(self._parse_rows())
            if self._seg_flags is None:
                raise ShotError("_seg_flags 未派生: _parse_shots 未走缓存路径")
        return self._seg_flags

    def _seg_mode(self, i):
        """1.11b 波1 T2: 逐段有效模式判定（核心机制, §二.1）。
        - self.mode != "自定义" → 返回 self.mode（零回归; 分镜/拼接照旧）。
        - self.mode == "自定义" → 懒派生一次（_parse_shots 末尾已缓存, 此处只补漏）;
          i 越界 raise ShotError（越界语义与"未派生"严格分离）。
        """
        if self.mode != "自定义":
            return self.mode
        flags = self._ensure_seg_flags()
        if i < 0 or i >= len(flags):
            raise ShotError("_seg_mode 越界: i=%d, seg_flags 长度=%d" % (i, len(flags)))
        return "拼接" if flags[i] else "分镜"

    def _any_seg_concat(self):
        """1.11b 波1 T2: 批级判据 — 拼接模式 True; 自定义 = 任一 flags[1:] 真; 分镜 False。
        用途: B 类批级判定统一走它（不得用 self.mode in (...) 否则全不勾的自定义批
        不再精确等价分镜, 冲突验收 6①）。"""
        if self.mode == "拼接":
            return True
        if self.mode == "分镜":
            return False
        return any(self._ensure_seg_flags()[1:])

    def _should_accumulate_cum(self, ok):
        """V1.13 D7: 拼接/自定义模式 cum_frames 累加决策.
        - 拼接模式: 仅成功段累加 (失败段不计入 → 下游 [Shot N] At 时间戳不错位)
        - 自定义模式: 全批累计, 失败段仍计入 (与 blocked 段同口径, :8398-8399 注释明确)
        - 分镜模式: 不在本函数判断 (上游 _any_seg_concat() 已屏蔽)
        """
        if self.mode == "拼接":
            return bool(ok)
        # 自定义模式: 全批累计, ok 与否都累加
        return True

    def _warn_widget_count_mismatch(self, nid, ctype, nslot, ntotal, abandoned):
        """F1: widget 数量不符 → 弃填留痕 (stdout + _preflight_warns 黄条; 同键去重).

        弃填后果两类: required 参数缺 → ComfyUI 400 → 段 failed 可见;
        optional 参数缺 → 节点默认值生效 + 本黄条.
        """
        key = (ctype, nslot, ntotal, tuple(abandoned))
        seen = getattr(self, "_widget_warn_seen", None)
        if seen is None:
            seen = self._widget_warn_seen = set()
        if key in seen:
            return
        seen.add(key)
        msg = ("widget_count_mismatch: 节点 %s(%s) 模板 widgets_values %d 项 / schema widget 参数 "
               "%d 项 — 无槽位参数弃填(不静默错填, 用节点默认值): %s"
               % (nid, ctype, nslot, ntotal, ", ".join(abandoned)))
        print("[H3Batch] " + msg, flush=True)
        pw = getattr(self, "_preflight_warns", None)
        if not isinstance(pw, list):
            pw = self._preflight_warns = []
        pw.append(msg)

    # ---------------- 模板 -> API ----------------
    def convert(self, seed):
        if not self.workflow_path:
            raise ShotError("请先配置模板: 在 h3_config.json 填 default_workflow/workflow_dir, 或显式传入 workflow_path")
        if self.port == 0:
            self.port = self._detect_port()
            self.base = "http://127.0.0.1:%d" % self.port
        d = json.load(open(self.workflow_path, encoding="utf-8"))
        try:
            obj_info = self._get("/object_info")
        except Exception as e:
            raise ShotError("无法连接 ComfyUI 服务器 (%s): 检查 port 参数(%s)" % (self.base, e))
        known = set(obj_info.keys())
        self._template = d
        # 1.14 P5: 六不变量自检 schema 来源 (I1/I5/I4 槽上界) — 与 known 同源, 零额外请求
        self._obj_info = obj_info
        self._links = {l[0]: l for l in d["links"]}
        self._nodes = {n["id"]: n for n in d["nodes"]}
        self._next_nid = max([n["id"] for n in d["nodes"]] + [l[0] for l in d["links"]] + [0]) + 1

        primitives = {}
        linked_prims = set()
        for n in d["nodes"]:
            # K6: PrimitiveStringMultiline 收法同款 (object_info 单 required 'value' 槽,
            # 模板 widgets_values 单值) — 漏收则引用者存 ["<psm>", 0] 悬空 link, 双
            # ImageToVideo 模板第二路非 ref_node 时 _prune_orphans 反向 BFS KeyError
            # R-60 甲案: 有输入连线的 Primitive 是计算链一环 (如 math→PrimitiveInt→H3.length),
            # 拍平会把链断成 widgets_values[0] 死常量 (CSV 填时长不生效) → 不收拍平表,
            # 节点照常走主循环出图, inputs.value 由连线喂入; 无连线 Primitive 照旧拍平。
            if n["type"] in ("PrimitiveFloat", "PrimitiveInt", "PrimitiveString",
                             "PrimitiveBoolean", "PrimitiveStringMultiline"):
                if any(inp.get("link") is not None for inp in n.get("inputs", [])):
                    linked_prims.add(n["id"])
                else:
                    primitives[n["id"]] = n.get("widgets_values", [None])[0]

        prompt = {}
        unknown_types = set()
        # 1.14 P5: I3 深比较基线 — 仅 passthrough 态填充 (opaque 节点转写后 inputs 快照)
        self._opaque_snapshot = {}
        # 1.14 P3: 未知节点三态 (默认 error = 现状零回归; 见 _read_unknown_policy)
        policy = _read_unknown_policy()
        strip_ids = {n["id"] for n in d["nodes"]
                     if not n["type"].startswith("Primitive")
                     and n["type"] not in known
                     and n["type"] not in _UI_ONLY_NODE_TYPES} \
            if policy == "strip" else set()
        for n in d["nodes"]:
            t = n["type"]
            if t.startswith("Primitive") and n["id"] not in linked_prims:
                continue
            if t not in known:
                if t not in _UI_ONLY_NODE_TYPES:
                    unknown_types.add(t)
                    if policy == "passthrough":
                        # 原样透传: 仅转写模板显式连线 (opaque 深比较不变 — 禁回填/禁改 link)
                        pt_inputs = {}
                        for inp in n.get("inputs", []):
                            lk = inp.get("link")
                            if lk is None:
                                continue
                            src = self._links.get(lk)
                            if src is None:
                                continue
                            origin, oidx = src[1], src[2]
                            if origin in primitives:
                                pt_inputs[inp["name"]] = primitives[origin]
                            else:
                                pt_inputs[inp["name"]] = [str(origin), oidx]
                        prompt[str(n["id"])] = {"class_type": t, "inputs": pt_inputs}
                        # P5 I3 基线: 深拷贝 (后续环节原地改 list 也能被检出)
                        self._opaque_snapshot[str(n["id"])] = copy.deepcopy(pt_inputs)
                continue
            inputs = {}
            wv = n.get("widgets_values", [])
            wi = 0
            # F1: 已消费槽位 / UI widget 槽实读参数名 — 兜底按名绑定时不复用这些下标
            consumed_idx = set()
            ui_filled = set()
            for inp in n.get("inputs", []):
                name = inp["name"]
                lk = inp.get("link")
                if lk is not None:
                    src = self._links.get(lk)
                    if src is None:
                        continue
                    origin, oidx = src[1], src[2]
                    if origin in strip_ids:
                        # P3 strip: 引用被剔除节点的输入 → 等价 UI bypass 直连其上游;
                        # 拓扑不可解 → 剔除该输入 (不悬空引用被剔节点)
                        rewired = _strip_rewire(self._nodes, self._links, origin, oidx, strip_ids)
                        if rewired is None:
                            continue
                        origin, oidx = rewired
                    if origin in primitives:
                        inputs[name] = primitives[origin]
                    else:
                        inputs[name] = [str(origin), oidx]
                elif inp.get("widget"):
                    if wi < len(wv):
                        inputs[name] = wv[wi]
                        consumed_idx.add(wi)
                        ui_filled.add(name)
                    wi += 1
            _apply_branch = BRANCH_REGISTRY.get(t)
            if _apply_branch is not None:
                # P2 查表分发 — 返回值 = 本节点消费的 widgets_values 槽位 (literal)
                consumed_idx |= _apply_branch(inputs, wv, seed)
            # F1 通用兜底: 按名绑定 (bind_widgets). UI 老格式下纯 widget 参数不出现在 inputs
            # 列表(只有连线槽), 上面循环消费不到 → 这里按 schema 名序补; 已被消费的槽位
            # (UI widget 槽实读 + 分支 literal 返回 + 连线按名写入的参数名次) 不复用; 槽位耗尽 = 数量不符
            # → 弃填 + widget_count_mismatch 黄条 (旧实现: 位置游标恒从 0 起, 会把 wv[0]
            # 静默填给尾部参数 — R1/R2 根因). 只补不覆盖 (连线值/特判值不动).
            spec_in = (obj_info.get(t) or {}).get("input") or {}
            ui_slots = {inp["name"] for inp in n.get("inputs", [])}
            _wnames = _widget_param_names(spec_in)
            consumed_idx |= {i for i, nm in enumerate(_wnames)
                             if nm in inputs and nm not in ui_filled and i < len(wv)}
            bindings, abandoned = bind_widgets(spec_in, wv, consumed_idx,
                                               skip=ui_slots | set(inputs))
            for _bn, _bv in bindings:
                inputs[_bn] = _bv
            if abandoned:
                self._warn_widget_count_mismatch(str(n["id"]), t, len(wv), len(_wnames), abandoned)
            prompt[str(n["id"])] = {"class_type": t, "inputs": inputs}
        # V1.11 批4 T5: 未注册节点类型拦截 — 模板含服务器不认识的类型 → 抛 ShotError
        # (UI-only 白名单 {Note, MarkdownNote, Reroute} 豁免, 它们无 API 提交意义)
        # 1.14 P3: 拦截仅 error 态 (默认); passthrough/strip 见 _UNKNOWN_POLICIES 注释
        if unknown_types and policy == "error":
            raise ShotError(
                "模板含服务器不认识的节点类型: %s —— 请安装对应节点包后重试"
                % ", ".join(sorted(unknown_types))
            )
        # V1.9 T2.5 R2 资源覆写 — 模板加载点 (UNETLoader/CLIPLoader/VAELoader) widget 值直接覆写;
        # 改连线兜底本任务不做 (模板无加载点 → 明确报告), 后续任务可补。覆写在注入之前,
        # 确保联合指纹计算基于覆写后状态。
        prompt, self._override_report = _apply_overrides(prompt, self._overrides,
                                                         workflow_path=self.workflow_path)
        # V1.9 T4.4b / D2 模板自带 LoRA 覆写 — 模板 LoRA 节点 (三类 class_type):
        # strength → 强度 widget 值覆写 (零结构改动); disabled → 节点从生成的 API
        # prompt 摘除、下游改接其上游 (等价画布 bypass, 文件不加载)。模板文件零改动
        # (变换仅在内存 prompt; _apply_overrides 同环节, 先于注入执行)。
        # 未命中键仅记 unmatched, 不报错。
        prompt, self._lora_override_report = _apply_lora_overrides(prompt, self._lora_overrides)
        # T4.4b 后: 模板 LoRA 名自动解析 — 用户改名/移动 LoRA 文件后, 模板引用的旧名
        # 不在当前 LoRA 库枚举里时, 按 stem 唯一候选静默替换; 多/零命中不猜, 交给
        # preflight / ComfyUI 服务端校验兜底。folder_paths=None (离线/测试) 时跳过整段。
        prompt = self._resolve_lora_aliases(prompt)
        # V1.9 T2.3 R3 LoRA 链式注入 — 转换产出 prompt 后立即注入, 后续 _apply_global
        # / apply_shot_* 都基于注入后图工作 (注入是纯函数: 不污染原 prompt 也不写盘)
        # T2.5: 联合指纹 = resources + overrides (T2.3 单维度升级)
        # T4.4b: 三联合指纹 = resources + overrides + lora_overrides (T2.5 双维度升级)
        # 1.14 P4: 传入 object_info → 插入点按 schema 类型声明精确发现 (no_model_edge 结构化失败)
        prompt, self._inject_report = _inject_loras(prompt, self._resources, self._fresh_id,
                                                     overrides=self._overrides,
                                                     lora_overrides=self._lora_overrides,
                                                     schema=obj_info)
        self._prompt = prompt
        return prompt

    def _fresh_id(self):
        nid = self._next_nid
        self._next_nid += 1
        return nid

    def _resolve_lora_aliases(self, prompt):
        """T4.4b 后: convert() 提交前对 prompt 中 LoRA 节点 lora_name 做实时别名解析.

        - folder_paths 为 None 或缺 get_filename_list (离线/测试) → 直接返回原 prompt
        - 遍历 class_type ∈ LORA_CLASS_TYPES 的节点, 对 inputs["lora_name"] 跑
          _resolve_lora_alias; 唯一命中时替换并打印日志
        - 多/零命中不改值 (保持原样, 交给 preflight 报错或 ComfyUI 服务端校验兜底)
        """
        if folder_paths is None or not hasattr(folder_paths, "get_filename_list"):
            return prompt
        try:
            installed = folder_paths.get_filename_list("loras")
        except Exception:
            return prompt
        for nid, node in prompt.items():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") not in LORA_CLASS_TYPES:
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            name = inputs.get("lora_name")
            if not isinstance(name, str) or not name:
                continue
            resolved, candidates = _resolve_lora_alias(name, installed)
            if not candidates and resolved != name:
                # 唯一命中: 替换 + 日志 (旧 → 新)
                inputs["lora_name"] = resolved
                print("[H3Batch] LoRA 名自动匹配: %s → %s" % (name, resolved), flush=True)
        return prompt

    def _resolve_file(self, name):
        if not name:
            return None
        # CSV 可能写真绝对路径(M:\...\x.jpg); os.path.join 在第二段为绝对时会丢掉第一段, 所以单独判一下
        p = name if os.path.isabs(name) else os.path.join(self.input_dir, name)
        if not os.path.exists(p):
            raise ShotError("素材不存在: %s (在 %s)" % (name, self.input_dir))
        # 永远只把 basename 喂给 LoadImage (ComfyUI 服务端只认自己 input 目录里的 basename, 不接外部绝对路径)
        base = os.path.basename(p)
        os.makedirs(self.server_input_dir, exist_ok=True)
        dst = os.path.join(self.server_input_dir, base)
        # 同位置 (输入已经在 server_input_dir 里) 不重写文件
        if os.path.abspath(p) == os.path.abspath(dst):
            return base
        # 同名异内容: 后者别覆盖前者 — 加路径 sha1 前缀区分, 让两个素材共存
        if os.path.exists(dst) and not filecmp.cmp(p, dst, shallow=False):
            stem, ext = os.path.splitext(base)
            base = "%s__%s%s" % (stem, hashlib.sha1(os.path.abspath(p).encode("utf-8")).hexdigest()[:8], ext)
            dst = os.path.join(self.server_input_dir, base)
        if not os.path.exists(dst):
            shutil.copy2(p, dst)
        return base

    def _apply_global(self, prompt, g):
        self._global_prompt = g.get("提示词", "")
        # 批 H1: 角色绑定表落进实例状态 (空/缺 = []) — _prepare_cast_plan 后续消费
        # 数据契约: 列表元素 {"name": str, "no": int, "slots": [{idx, usage, media, desc}..]}
        # 损坏 entry 在 _parse_global 已过滤; 此处再兜底过滤一遍 (调用方可能直接传 g)
        _cb_raw = g.get("角色绑定", [])
        self._cast_bindings = _cb_raw if isinstance(_cb_raw, list) else []
        # 2.9: 批级语言开关 — 中文/英文/en/english 走英文; 非法/缺省回落中文(不告警)
        v = str(g.get("语言", "") or "").strip().lower()
        self._lang = "en" if v in ("英文", "en", "english") else "zh"
        # 批 A 后小迭代: 三勾选 + 旧 默认负面 兼容 — 新键优先
        # 优先级: 三新键 > 旧 默认负面 单键 (后者仅在前者全缺时生效)
        def _truthy(k):
            return str(g.get(k, "") or "").strip() == "开"
        self._negative_music = _truthy("关音乐")
        self._negative_dialogue = _truthy("关对白")
        self._negative_text = _truthy("关水印字幕")
        any_new = ("关音乐" in g) or ("关对白" in g) or ("关水印字幕" in g)
        if not any_new:
            # 旧 默认负面 单键映射 — 三全勾或全不勾
            legacy_on = (str(g.get("默认负面", "") or "").strip() == "开")
            self._negative_music = legacy_on
            self._negative_dialogue = legacy_on
            self._negative_text = legacy_on
        # 旧别名 _negative_on = 任一勾选 (供旧探测 / 旧调用方兼容)
        self._negative_on = bool(self._negative_music or self._negative_dialogue or self._negative_text)
        # V1.12 T4: 关场景 批次开关 → 场景参考句全关 (卡→自动带图链路; 池底手动标注不受管)
        # 与三勾选同款 _truthy 判定; 缺省/空 (旧 CSV) → False, 行为与 T3 现状一致
        self._scene_disabled = _truthy("关场景")
        # T2: 全局音频段(配乐/氛围声) — 键序固定 [("配乐",..), ("氛围声",..)]; 任一为空则对应元组不进 list
        self._audio_blocks = [(k, g[k]) for k in ("配乐", "氛围声") if g.get(k)]
        # V1.10 批1 T4: BGM 通道 D2 — 表单 → CSV → 引擎属性全链尾段:
        # _bgm_path: 路径串去空白, 空串 → "" (功能关, 由 join_engine 判空走 BGM off 路径)
        # _bgm_mix_mode: 中文 "替换"/"混合" → 英文 "replace"/"mix"; 键缺失/空 → 构造默认 "replace"
        #   (解析层 _parse_global 已对 音乐混入方式 落白名单 替换/混合, 此处中文→英文一一映射)
        # 与 self._negative_music (关音乐勾选) 正交: 后者仅影响 prompt 文本 (注入 non_diegetic_music: N/A),
        # 前者是物理音轨通道 (替换/混入原始视频音轨). 关音乐勾选 + 配 BGM 通道同时启用为合法组合.
        self._bgm_path = str(g.get("音乐文件", "") or "").strip()
        _mix_zh = str(g.get("音乐混入方式", "") or "").strip()
        self._bgm_mix_mode = "mix" if _mix_zh == "混合" else "replace"
        # V1.10 批2 T1: 审片门 → self._review_every_n (T2 消费) — 0=关(默认), N≥1=每 N 段审片点.
        # 解析层 _parse_global 已对 审片门 落非负整数 & ≤50 白名单 (脏值不落键),
        # 此处 try/except 是防御层 (调用方可能直接传 g, 绕过解析层): 兜底 0.
        try:
            self._review_every_n = int(str(g.get("审片门", "") or "0").strip() or 0)
        except (TypeError, ValueError):
            self._review_every_n = 0
        # V1.11 批 1 T6: 自动拼接开关 → self._auto_concat (三处收尾消费) —
        # 解析层已对 自动拼接 落白名单 (自动/不拼); 兜底 (调用方可能直接传 g) = 默认 自动.
        self._auto_concat = str(g.get("自动拼接", "") or "").strip() != "不拼"
        # 1.14b U3: 后处理三键 — 解析层已对 放大/插帧 落白名单 (开/关), 放大引擎 落 seedvr2/rtxvsr;
        # 兜底: 缺/空 = 不勾 (旧 CSV 零回归), 引擎默认 seedvr2
        def _on(k):
            return str(g.get(k, "") or "").strip() == "开"
        self._postfx_upscale = _on("放大")
        self._postfx_interp = _on("插帧")
        _ec = str(g.get("放大引擎", "") or "").strip()
        self._postfx_engine_choice = _ec if _ec in ("seedvr2", "rtxvsr") else "seedvr2"
        has_rs = any(n["class_type"] == "ResolutionSelector" for n in prompt.values())
        has_multirate = any(n["class_type"] == "MiniMaxH3MultiRateSamplerEXPT8"
                            for n in prompt.values())
        video_steps = None
        if g.get("步数"):
            m = re.match(r"(\d+)\s*([VA])\s*(\d+)\s*([VA])", g["步数"], re.IGNORECASE)
            if m:
                video_steps = int(m.group(1)) if m.group(2).upper() == "V" else int(m.group(3))
        # 兜底 1: 没有 ResolutionSelector → 按比例+质量算 width/height, 写回 ref 节点。
        # 模板若写死 1344x768 / 832x480, 兜底后才能让 CSV 全局参数真正生效。
        # 拼接模式 (self.mode == "拼接") 续接走 H3 model patchify_video (w_full//2 floor),
        # 任一边/16 为奇数即 reshape 崩 → 这里把 w/h 各自吸附到 32 倍 (round(w/32)*32, 不低于 256).
        # 分镜模式行为零变化 (保持 16 倍) — _video_wh_from_aspect 是通用纯函数, 不动它.
        if not has_rs and g.get("比例") and g.get("质量"):
            ratio = _parse_aspect_ratio_to_decimal(g["比例"])
            wh = _video_wh_from_aspect(ratio, g["质量"])
            if wh is None and ratio is None:
                # V1.11 交付前 BE-P1-2: 解析失败 (标签/非法格式) → 一行日志 (不再静默)
                print("[H3Batch] 无 RS 模板: 比例 '%s' 解析失败, 跳兜底写回 (保留模板默认 width/height)"
                      % g["比例"], flush=True)
            if wh is not None:
                w, h = wh
                w_orig, h_orig = w, h
                # 1.11b 波1 T2: 批级 B 类 — 自定义下任一段勾选也走 32 倍对齐 (与拼接侧同口径)
                if self._any_seg_concat():
                    w = max(256, round(w / 32) * 32)
                    h = max(256, round(h / 32) * 32)
                applied = 0
                for node in prompt.values():
                    if node["class_type"] in ("MiniMaxH3ReferenceToVideo",
                                              "MiniMaxH3ImageToVideo"):
                        inp = node["inputs"]
                        if "width" in inp and "height" in inp:
                            inp["width"] = w
                            inp["height"] = h
                            applied += 1
                if applied:
                    print("[H3Batch] 无 ResolutionSelector 模板: 按 %s @ %sMP 写回 %dx%d (%d 个 ref 节点)"
                          % (g["比例"], g["质量"], w, h, applied), flush=True)
                    if self._any_seg_concat() and (w != w_orig or h != h_orig):
                        print("[H3Batch] 拼接模式续接需 32 倍对齐: %dx%d -> %dx%d"
                              % (w_orig, h_orig, w, h), flush=True)
        for node in prompt.values():
            t = node["class_type"]
            if t == "ResolutionSelector":
                if g.get("比例"):
                    # V1.8 fix: 全角冒号 / Excel 时间格式归一化复用 _normalize_aspect_token,
                    # 避免与 _parse_aspect_ratio_to_decimal 重复维护同一纠正规则。
                    ratio_raw = g["比例"]
                    ratio_norm = _normalize_aspect_token(ratio_raw)
                    if ratio_norm != ratio_raw:
                        print("[H3Batch] 比例 '%s' 已归一化为 '%s'" % (ratio_raw, ratio_norm), flush=True)
                    val = ASPECT_MAP.get(ratio_norm, ratio_norm)
                    if val in ASPECT_OPTIONS:
                        node["inputs"]["aspect_ratio"] = val
                    else:
                        print("[H3Batch] 比例 '%s' 无法识别, 用模板默认" % g["比例"], flush=True)
                if g.get("质量"):
                    try:
                        node["inputs"]["megapixels"] = float(g["质量"])
                    except ValueError:
                        print("[H3Batch] 质量 '%s' 无法识别, 用模板默认" % g["质量"], flush=True)
            elif t == "MiniMaxH3MultiRateSamplerEXPT8":
                if g.get("步数"):
                    if video_steps is not None:
                        node["inputs"]["video_steps"] = video_steps
                        node["inputs"]["audio_steps"] = int(m.group(3)) if m.group(2).upper() == "V" else int(m.group(1))
                    else:
                        print("[H3Batch] 步数 '%s' 无法识别, 用模板默认" % g["步数"], flush=True)
            elif (t == "BasicScheduler"
                  and not has_multirate
                  and video_steps is not None):
                # 兜底 2: 没有 MultiRateSamplerEXPT8 时同步所有 BasicScheduler 的 video_steps。
                # 音频步数 BasicScheduler 节点本身表达不了, 这是已知局限(报告中写明)。
                # 若 steps 是链路输入 (list), 跳过以免戳坏; 只改写已经落盘的数值。
                if "steps" in node["inputs"] and isinstance(node["inputs"]["steps"], (int, float)):
                    node["inputs"]["steps"] = video_steps
            elif (t == PDD_ACC_CLASS
                  and not has_multirate
                  and video_steps is not None):
                # V1.11 批4 T4 D3: PDD 加速节点步数通道 (nfe 为字符串 combo 4/6/8) —
                # 模板若无 MultiRateSamplerEXPT8 且含 PDDAccApply, 写入 video_steps.
                # 留空 (video_steps 为 None) 不写 → 用模板默认 (8).
                node["inputs"]["nfe"] = str(video_steps)
        return prompt

    def _apply_shot_common(self, prompt, row, extra_blocks=None, per_shot_plan=None,
                            cmode=None, pic9_present=False,
                            shot_no=None, cum_ms=None, warn_sink=None,
                            seg_override=None, slot_descs=None):
        # 分项行=编译器三字段输出(2.2), 纯手写行=原样直发; 素材标签只认分镜里的
        # 2.9: 透传 _lang 到 merged_prompt(英文路径走词库查表)
        # V1.4 T3: extra_blocks 透传给 merged_prompt; None → 行为与 V1.3 逐字节一致
        # Task 1: 透传 _negative_on → 默认负面清单按需在发送层追加(永不进 prompt 文本/CSV 行)
        # 批 H1: 名字替换 — merged_prompt 调用前, 替换 row prompt 与 global 文本
        # (无 _cast_bindings 时 skip, 旧表/cast_bindings=[] 行为逐字节不变)
        # I-⑤: 逐镜过滤 — global 中 <Subject N> 行剔除不在本镜在场 no 集的行 + 紧邻空行
        #       per_shot_plan 非 None 时, scene_nos = 该镜 cast_spec 的 no 集
        #       per_shot_plan 为 None 时 (旧路径 / 旧行为零变化) — 不过滤
        # 批 A 节点 1: 走 prompt_assembler.assemble_final_prompt 单一入口
        # (extra_blocks 预计算 = 上游 apply_shot_pool/concat 已算好, 透传给组装模块)
        # 批 A 节点 2: cast_spec / pool_usage / shots_in_scene / cmode 透传 — 让引擎组装层走六字段结构
        # 批 A 节点 3 (A1): 透传 shot_no / cum_ms → prompt_assembler 前插 [Shot N] 时序标记
        # 批 A 节点 3 (A4 R2): warn_sink 透传 — 音频冲突黄条经此回流到引擎 warns 聚合通道
        # 1.14 批 I I2c: is_fl2v 透传面已删 (引擎侧对齐句不可达; 端点预览走 assembler 直调)
        from prompt_assembler import assemble_final_prompt
        bindings = getattr(self, "_cast_bindings", None) or []
        # V1.12 T3 契约 3 + J4: 场景卡/道具卡不是人物 — 名字替换链路 (replace_cast_names)
        # 须跳过, 否则 prompt 正文卡名被换成不存在的 <Subject N> (两类卡均不占 Subject 编号)。
        # 卡名集由 _prepare_cast_plan 落位 (同批绑定表内的场景卡/道具卡同样命中)。
        _no_subject_names = (getattr(self, "_cast_scene_names", None) or set()) \
            | (getattr(self, "_cast_item_names", None) or set())
        if _no_subject_names:
            bindings = [b for b in bindings
                        if not (isinstance(b, dict) and b.get("name") in _no_subject_names)]
        scene_nos = None
        cast_spec = None
        pool_usage = self._pool_usage
        # 批 A 节点 2 修复: shots_in_scene 与 current_shot_no 来自 per_shot_plan
        # (per_shot[i] 在 _prepare_cast_plan 阶段已显式注入这两个字段; 移除 ghost 属性探测
        # — 本仓风格: 显式属性优于 getattr 探测)
        shots_in_scene = None
        current_shot_no = None
        if per_shot_plan is not None:
            scene_nos = set()
            for _no, _ in (per_shot_plan.get("cast_spec") or []):
                if isinstance(_no, int):
                    scene_nos.add(_no)
            cast_spec = per_shot_plan.get("cast_spec")
            pool_usage = per_shot_plan.get("pool_usage", pool_usage)
            shots_in_scene = per_shot_plan.get("shots_in_scene", shots_in_scene)
            current_shot_no = per_shot_plan.get("current_shot_no")
        # 批 A 节点 2: cmode 由上游 apply_shot_pool/concat 计算并透传 (供 prompt_assembler
        # 触发六字段结构判定); 缺省回落 = _template_mode (与 enrich_blocks 同口径)
        if cmode is None:
            cmode = _template_mode(self.workflow_path) if self.workflow_path else None
        text = assemble_final_prompt(
            row=row,
            extra_blocks=extra_blocks,
            global_text=self._global_prompt,
            audio_blocks=self._audio_blocks,
            bindings=bindings,
            scene_nos=scene_nos,
            lang=self._lang,
            negative=self._negative_on,
            negative_music=self._negative_music,
            negative_dialogue=self._negative_dialogue,
            negative_text=self._negative_text,
            cast_spec=cast_spec,
            pool_usage=pool_usage,
            shots_in_scene=shots_in_scene,
            current_shot_no=current_shot_no,
            cmode=cmode,
            pic9_present=pic9_present,
            # #83: 段级槽摘要透传 (复刻句替换目标; 空 → 与 #76 现状逐字一致)
            slot_descs=slot_descs,
            # 批 A 节点 3 (A1): 时序标记透传 (上游 apply_shot_pool/concat / _run_one 算好传入)
            shot_no=shot_no,
            cum_ms=cum_ms,
            # 批 A 节点 3 (A4 R2): 音频冲突黄条回流 — 与端点/旧 merged_prompt 同源 warn_sink
            warn_sink=warn_sink,
            # 1.13f: 引擎侧锚定行覆盖入口 — submit 时入参 → self._subject_anchors;
            # 缺省/空/纯空白时 getattr 兜底传 None (与 assembler 缺省零变口径一致)
            subject_anchors=getattr(self, "_subject_anchors", None) or None,
        )
        # 批 A 节点 3 (A4 R2): 音频冲突黄条累加到 _preflight_warns 聚合通道 — 复用现有 warns 通道,
        # 不新造 (用户要求: manifest/预检结果里用户可见的 warns 列表; 现有 _preflight_warns
        # 是 _run_engine_once 行 1467-1468 打印的预检警告聚合; 音频冲突与预检警告同级黄条,
        # 故合并到此聚合。不会影响 preflight 拦截逻辑 (preflight errs 在另一条 errs 路径上))
        if warn_sink:
            pw = getattr(self, "_preflight_warns", None)
            if isinstance(pw, list):
                pw.extend(warn_sink)
        # 1.14 批 L5 R-26: 段池锚定块尾部追加 —— **特性生死位**, 钉在 assemble 返回与
        # _last_final_prompt 暂存之间。manifest final_prompt 落盘与节点写入的唯一暂存源
        # 就是 _last_final_prompt, 追加若落在本函数之外 (apply_shot_pool / concat 两调用点
        # 都在其外) 则两处都拿不到 = 特性静默失效; concat/apply 共用本函数 → 一处覆盖两 batch 路径。
        # 设计性绕开两个陷阱: extra_blocks 的替换语义 (会吞既有句) 与
        # _filter_scene_video_motion_blocks 的静默丢弃。
        # I2 门控: 仅 cmode==ref2v (与 enrich_blocks 非 ref2v 整体抑制同口径, 防 t2v 悬空
        # <Picture N> 引用); 零行/零文本 = 零追加 (老任务逐字节零变化)。
        if text and cmode == "ref2v":
            if per_shot_plan is not None:
                _anchor_rows = per_shot_plan.get("seg_anchor_rows") or []
                # 手写重扫口径 = enrich_blocks 的 row_text_combined (调用点同款:
                # 过滤后 global + 行 prompt); warn_sink=None 防重复黄条。
                _anchor_src = (_filter_global_subject_lines(
                    self._global_prompt or "", scene_nos, warn_sink=None)
                    + "\n" + (row.get("prompt") or ""))
            else:
                # cast_plan 缺席 (路径 c 兜底): assets 不在作用域 → self 级缓存现算
                _anchor_rows = self._seg_anchor_rows_cached(self._seg_pools_for_row(row))
                _anchor_src = (self._global_prompt or "") + "\n" + (row.get("prompt") or "")
            _anchor = _seg_anchor_block(_anchor_rows, _anchor_src)
            if _anchor:
                text = text + "\n\n" + _anchor
        # T7: 暂存实发文本 — 三个成功写点都从这里读, 追到 manifest[sid]["final_prompt"]
        self._last_final_prompt = text
        if text:
            ref_nid = self._ref_node_id(prompt)
            prompt[ref_nid]["inputs"]["prompt"] = text
        dur = row.get("段落时长")
        # 1.13h 2a: 侧车段级时长覆盖 > CSV (精修不被下次全量提交冲掉); 无覆盖时零变化.
        # 装配期双点校验之二: 越界/非数字覆盖一律忽略回落 CSV (写入时由端点拒绝, 此处防手改
        # 侧车) — 与 _row_duration_frames 同口径, 避免时间轴与渲染时长分叉.
        _ov_dur = (seg_override or {}).get("段落时长")
        if _ov_dur is not None and str(_ov_dur).strip():
            try:
                _seg_duration_frames(_ov_dur)
                dur = _ov_dur
            except ShotError as e:
                print("[H3Batch] 段级时长覆盖非法, 回落 CSV: %s" % e, flush=True)
        if dur:
            try:
                dur = float(dur)
            except ValueError:
                # preflight 已拦主路径; rerun/边角路径容错: 保持模板默认(不写 values.a)
                print("[H3Batch] 段落时长 %r 非数字, 该镜保持模板默认时长" % dur, flush=True)
                dur = None
            if dur is not None:
                for node in prompt.values():
                    for k, v in node["inputs"].items():
                        if k == "values.a" and isinstance(v, (int, float)):
                            node["inputs"][k] = dur
        elif dur == "":
            # 留空 = 5 秒
            for node in prompt.values():
                for k, v in node["inputs"].items():
                    if k == "values.a" and isinstance(v, (int, float)):
                        node["inputs"][k] = 5.0
        # 第二路径: ref2v/ref2va 系等 23 个模板无 ComfyMathExpression 数值型 values.a
        # 换算节点时, CSV 时长无落点被静默忽略——本段不存在数值型 values.a 时,
        # 把秒数按帧公式换算(17k+5 网格对齐, 帧数下限 5), 写进 H3 条件节点的 length 整型 widget。
        # 守卫: 图已有数值型 values.a (61 个主力模板) → length 一律不碰 (零回归)
        if isinstance(dur, (int, float)):
            _inject_h3_length_for_no_va(prompt, dur)
        export_name = str(row.get("导出文件名") or "").strip() or str(row.get("ID") or "").strip()
        if export_name:
            for node in prompt.values():
                if node["class_type"] == "SaveVideo":
                    node["inputs"]["filename_prefix"] = "video/shots/" + export_name
        return prompt

    def _ref_node_id(self, prompt):
        for nid, node in prompt.items():
            if node["class_type"] in ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"):
                return nid
        raise ShotError("模板里没有 MiniMaxH3 条件节点")

    def _inject_bound_pose_style(self, snap_slot, idx):
        # 1.14a T2: 绑定快照姿势样式注入 — usage="pose" 时同步 self._pose_style;
        # 缺省走 "skeleton" 静默路径(老板拍板默认值, 缺省无黄条 — 见 v3 风险表)
        if snap_slot.get("usage") == "pose":
            self._pose_style["Picture"][idx] = snap_slot.get("pose_style") or "skeleton"

    def _inject_pose_convert(self, prompt, src, style):
        # 1.14a T2/T3: 姿势参考转换支线 — 骨架(默认) / 白底深度
        # 返回链尾 output; src = LoadImage nid(已用 _resolve_file 归一过)
        # 链序守卫 (B3): DA 对原图取深度, 白底合成放 DA 之后 (避免白背景被归一化出深度)
        if style == "depth":
            session = str(self._fresh_id())
            prompt[session] = {"class_type": "RemBGSession+", "inputs": {
                "model": "u2net_human_seg: human segmentation",  # essentials/image.py:773 枚举完整串
                "providers": "CPU"}}
            rm = str(self._fresh_id())
            prompt[rm] = {"class_type": "ImageRemoveBackground+", "inputs": {
                "rembg_session": [session, 0], "image": [src, 0]}}
            inv = str(self._fresh_id())
            prompt[inv] = {"class_type": "InvertMask", "inputs": {
                "mask": [rm, 1]}}  # 通道 1 = MASK (essentials/image.py:830/844)
            da = str(self._fresh_id())
            prompt[da] = {"class_type": "DepthAnythingV2Preprocessor", "inputs": {
                "image": [src, 0], "resolution": 1024,
                "ckpt_name": "depth_anything_v2_vitb.pth"}}
            white = str(self._fresh_id())
            prompt[white] = {"class_type": "EmptyImage", "inputs": {
                "width": 64, "height": 64, "batch_size": 1, "color": 16777215}}  # 0xFFFFFF = 白
            comp = str(self._fresh_id())
            prompt[comp] = {"class_type": "ImageCompositeMasked", "inputs": {
                "destination": [da, 0], "source": [white, 0],
                "x": 0, "y": 0, "resize_source": True, "mask": [inv, 0]}}
            return [comp, 0]
        pose = str(self._fresh_id())
        prompt[pose] = {"class_type": "DWPreprocessor", "inputs": {
            "image": [src, 0], "resolution": 1024,
            "detect_hand": "enable", "detect_body": "enable", "detect_face": "disable",
            "bbox_detector": "yolox_l.onnx",
            "pose_estimator": "dw-ll_ucoco_384_bs5.torchscript.pt",
            "scale_stick_for_xinsr_cn": "disable"}}
        return [pose, 0]

    # ---------------- 分镜模式 ----------------
    def apply_shot_pool(self, prompt, row, pool, cast_plan=None,
                         shot_no=None, cum_ms=None, seg_override=None):
        # V1.7 B2: cast_plan=None (默认) → 现状路径逐字节不变; 显式传时用逐镜副本 (F1 一票否决)
        prompt = json.loads(json.dumps(prompt))
        # 1.13h 2b: 段级池覆盖 (无覆盖 → 原对象, 零变化)
        pool = self._merge_seg_pool(pool, seg_override)
        # 1.13h 2c: 段级资源差分 (批级已应用之上再覆盖; 无覆盖 → 原图)
        prompt = self._apply_seg_resource_diff(prompt, seg_override, sid=(row.get("ID") or ""))
        ref_nid = self._ref_node_id(prompt)
        ref_node = prompt[ref_nid]
        for key in list(ref_node["inputs"].keys()):
            if key.startswith(("ref_images.", "ref_videos.", "ref_video_audios.", "ref_audios.",
                               "first_frame", "last_frame")):
                del ref_node["inputs"][key]
        # 逐镜副本 vs 批级 — cast_plan 存在时使用副本 (含虚拟槽); None 时现状
        # 1.13h 2b: 段级池覆盖同样作用于 cast 副本 (merge 返回新 dict, 不污染 cast_plan)
        # #83: 段级槽的场景文字摘要随并池带出 (复刻句替换目标) — cast 路径取逐镜副本内值
        slot_descs = {}
        if cast_plan:
            pool_eff = self._merge_seg_pool(cast_plan["pool"], seg_override)
            pu_eff = cast_plan["pool_usage"]
            slot_descs = cast_plan.get("slot_descs") or {}
        else:
            pool_eff = pool
            pu_eff = self._pool_usage
            # 批 K 路径 c: cast_plan 缺席 (逐镜副本未覆盖该行) → apply 期兜底并入
            # 段级池, 沿 _merge_seg_pool 先例扩展 pu_eff, 段资产不静默丢。
            pool_eff, pu_eff, _, slot_descs = self._merge_seg_pools_entry(
                pool_eff, pu_eff, self._seg_pools_for_row(row))
        # 1.14 批 I I2a: i2v/fl2v 模板的分镜首帧接管分支已删 (I1 起 i2v/fl2v 批入口即拒,
        # 分支不可达); t2v/ref2v 走下方标签路由与 ref2v 族接线, 行为零变化.
        # 标签可写在分镜行或全局提示词里, 两处合并解析
        # 批 A 节点 4 (4a): warns 列表前置到逐镜过滤前 — 空集镜兜底反转黄条入此通道
        warns = []
        # I-⑤: 逐镜过滤 — 先剔除 global 中不在场 Subject 行 (含其尾随空行)
        # 必须早于 used 计算: <Picture N> 来自 Subject 行, 剔除后 N 不再被加入 used 集合,
        # 避免对不在场角色快照槽发配线 (used 不存在即不进入下方 ShotError 硬崩分支)
        # 批 A 节点 4 (4a): 透传 warns → 空集镜兜底反转黄条入此通道 (与下方 audio 冲突同源)
        if cast_plan is not None:
            scene_nos = {no for no, _ in (cast_plan.get("cast_spec") or [])
                         if isinstance(no, int)}
            global_eff = _filter_global_subject_lines(
                self._global_prompt or "", scene_nos, warn_sink=warns)
        else:
            global_eff = self._global_prompt or ""
        text = global_eff + "\n" + (row.get("prompt") or "")
        used = set()
        for m in TAG_RE.finditer(text):
            kind = m.group("kind").lower()
            idx = int(m.group("idx"))
            used.add((kind, idx))
        # V1.4 T3: 用途标注合并入 used-set(只要 pu_eff 任一 kind 非空即展开)
        # V1.7 B2: pu_eff 为副本 (cast_plan 含虚拟槽用途); cast_plan=None 时 pu_eff=self._pool_usage, 行为零变化
        if any(pu_eff.values()):
            used |= {(kind.lower(), idx) for kind, slots in pu_eff.items()
                     for idx in slots}
        for kind, idx in sorted(used):
            slot = pool_eff[kind.title()].get(idx)
            if not slot:
                raise ShotError("分镜引用了 <%(k)s %(i)d> 但素材池里没有: 请在素材池对应槽位上传素材" % {"k": kind.title(), "i": idx})
            fname = self._resolve_file(slot)
            if kind == "picture":
                nid = str(self._fresh_id())
                prompt[nid] = {"class_type": "LoadImage", "inputs": {"image": fname}}
                if ref_node["class_type"] == "MiniMaxH3ImageToVideo":
                    # 新版节点包 ImageToVideo 无 ref_images Autogrow 槽(first_frame/
                    # last_frame 形态), 老前缀键会被 execute 拒收 (unexpected keyword)
                    if idx == 1:
                        ref_node["inputs"]["first_frame"] = [nid, 0]
                    elif idx == 2:
                        # 1.14 批 I I2a: i2v 判定分支删除 (I1 后不可达) — t2v/匿名模板照常接
                        # last_frame (批4 T5 a7d46d8 钉过的历史行为, 全量回归
                        # test_pool_picture2_tag_routes_to_last_frame 实证不可收窄).
                        ref_node["inputs"]["last_frame"] = [nid, 0]
                    else:
                        raise ShotError("ImageToVideo 模板图片参考槽只有 first/last 两个: <Picture %d> 超出" % idx)
                else:
                    # 1.14a T2: ref2v + Picture 单 pose 槽 → 经姿势转换接 ref_images
                    # 守卫: 严格单用途 == ["pose"]; ImageToVideo 一律不转 (first/last 锚定语义)
                    # style 缺省 skeleton (T1 解析层单 pose 落表 + 缺省=接线兜底)
                    target = [nid, 0]
                    if (ref_node["class_type"] == "MiniMaxH3ReferenceToVideo"
                            and (pu_eff.get("Picture") or {}).get(idx) == ["pose"]):
                        style = self._pose_style.get("Picture", {}).get(idx) or "skeleton"
                        target = self._inject_pose_convert(prompt, nid, style)
                    ref_node["inputs"]["ref_images.ref_image_%d" % (idx - 1)] = target
            elif kind == "video":
                lv = str(self._fresh_id())
                gc = str(self._fresh_id())
                prompt[lv] = {"class_type": "LoadVideo", "inputs": {"file": fname}}
                prompt[gc] = {"class_type": "GetVideoComponents", "inputs": {"video": [lv, 0]}}
                ref_node["inputs"]["ref_videos.ref_video_%d" % (idx - 1)] = [gc, 0]
            elif kind == "audio":
                la = str(self._fresh_id())
                prompt[la] = {"class_type": "LoadAudio", "inputs": {"audio": fname}}
                ref_node["inputs"]["ref_audios.ref_audio_%d" % (idx - 1)] = [la, 0]
        # V1.4 T3: 发送链路 enrich — 代写句组装; 分镜模式 pic9_present 恒 False(P9 动态衔接是拼接专属语义)
        cmode = _template_mode(self.workflow_path)
        pic9_present = False  # 批 A 节点 2: 分镜模式默认 False, 与 enrich_blocks 路径同口径
        # 批 A 节点 4 (4a): warns 已前置到逐镜过滤前, 此处复用同一 list (音频冲突黄条继续追加)
        # V1.7 B2: enrich_blocks 透传 cast_spec (cast 镜主体块唯一来源是 cast 路径, F4)
        cast_spec = cast_plan["cast_spec"] if cast_plan else None
        # I-⑤: 防双份 — global 已有 Subject N 行 → cast_spec 中 no=N 移除
        # (Subject 行在前端绑定面板注入或模板自带; 旧行为零变化: global 无 <Subject 行时透传)
        if cast_spec is not None and cast_spec:
            cast_spec = _filter_cast_spec_for_dedup(cast_spec, text)
        blocks = enrich_blocks(pu_eff, text, cmode, pic9_present=pic9_present,
                               lang=self._lang, warns=warns, cast_spec=cast_spec)
        # I-⑤: 逐镜过滤 — 透传 cast_plan (per_shot_plan) 给 _apply_shot_common
        # 批 A 节点 3 (A4 R2): 同 warns 列表复用 — 音频冲突黄条 (assemble_final_prompt 产出)
        # 与 enrich_blocks 手写去重警告共用同一用户可见通道。
        # _apply_shot_common 返回后再统一 for-print (enrich 警告 + 音频冲突 同通道, 避免双重 print)
        ret = self._apply_shot_common(prompt, row, extra_blocks=blocks or None,
                                      per_shot_plan=cast_plan,
                                      cmode=cmode, pic9_present=pic9_present,
                                      shot_no=shot_no, cum_ms=cum_ms,
                                      warn_sink=warns, seg_override=seg_override,
                                      slot_descs=slot_descs)
        for w in warns:
            print("[H3Batch] 警告: %s" % w, flush=True)
        return ret

    # ---------------- 拼接模式 ----------------
    # 1.14 批 I I2a: _endpoint_frame (fl2v 全片终点帧) 已删 — fl2v 批入口即拒 (I1),
    # 两消费点 (_void_tail_anchor 优先级 1 / rerun_shot 末段补尾锚) 同批删除.

    # V1.7 B2: 资产库只读加载 — 真实路径 server_input_dir/.h3_assets.json;
    # 缺失/损坏 → 空 dict (静默兜底, 不写不报错); 仅供 _prepare_cast_plan 单点调用
    def _load_assets_for_cast_plan(self):
        # 1.11a 波4 真机勘误: v3 档案一档一文件存 asset_library/archive_docs/ (批K1 新存储),
        # GET /assets 走 _h3_read_assets 合并口径; 执行链此处原只读主库 .h3_assets.json
        # → MCP/表单新存的 v3 卡执行时 not_found (存/读不对称, 真机 A/B 实锤)。
        # 修复: 主库 + archive_docs 合并, archive_docs 优先 (与 _h3_read_assets 同口径)。
        path = os.path.join(self.server_input_dir, ".h3_assets.json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        assets = data if isinstance(data, dict) else {}
        archive_dir = os.path.join(self.server_input_dir,
                                   "asset_library", "archive_docs")
        if os.path.isdir(archive_dir):
            for fn in os.listdir(archive_dir):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(archive_dir, fn), encoding="utf-8") as f:
                        card = json.load(f)
                except (OSError, ValueError):
                    continue  # 单文件损坏跳过 (与 _h3_read_assets 同口径)
                if isinstance(card, dict):
                    assets[fn[:-5]] = card  # 同名冲突: archive_docs 优先
        return assets

    def _seg_anchor_rows_cached(self, entry):
        """1.14 批 L5 (I3b): 段池条目 → 锚定行集, 资产走 self 级缓存懒加载一次。

        与 _cast_plan 同生命周期: _prepare_cast_plan 落过 self._seg_anchor_assets 时直接复用,
        未落位 (cast_plan 缺席的 apply/concat 兜底路径) 时懒加载一次 —— 防逐行重读主库+archive。
        产物与行循环 (T2 落位) 同口径: 同一个 _seg_anchor_rows_for_entry。
        """
        assets = getattr(self, "_seg_anchor_assets", None)
        if assets is None:
            assets = self._load_assets_for_cast_plan()
            self._seg_anchor_assets = assets
        return _seg_anchor_rows_for_entry(entry, assets, self._lang,
                                          self._binding_name_set())

    # V1.7 B2: 批级预解析 — 全表出场角色列解析一次, 每行构造逐镜副本 + cast_spec
    # 幂等缓存到 self._cast_plan; preflight/run/rerun 三处入口共用同一产物 (F5)
    def _prepare_cast_plan(self, shots, pool, bindings=None):
        """返回 {"any_cast": bool, "inject_ok": bool, "union_pool": dict, "per_shot": {行索引: plan},
                  "shots_in_scene": list[list[str]],
                  "resolve_errs", "assign_errs", "parse_warns", "no_look_cards", "cards",
                  "binding_names_in_scene", "unbound_names_in_scene", "all_empty_in_scene"}
        any_cast = 全表任一行出场角色解析出 names
        inject_ok = effective cmode == "ref2v" (执行侧注入开关, 非 ref2v 模板族不注入)
        union_pool = 池∪全批虚拟槽并集 (cmode 判定输入; any_cast=False 时 = 原池 deepcopy)
        per_shot[i] = {"names", "slot_map", "cast_spec", "pool", "pool_usage", "no_look_cards"}
          pool/pool_usage 是该行的逐镜副本 (deepcopy 隔离, 行间互不影响)
          cast_spec=None 表示空集镜 (C5 强化)
          seg_anchor_rows (1.14 批 L5) = [(槽号, "[分镜参考]" 行), ...] 槽号升序;
            段池锚定行 (B1 门控后产物), 注入侧在 final_prompt 尾部追加
        shots_in_scene (批 A 节点 2): 每行 (1-indexed) 出场角色名列表, 来自 CSV 出场角色列;
          供 retention_analysis (appears in [Shot N], ...) 渲染用;
          缺失/空行 = [], 全部空 = 列缺失/空 (兜底全部行号)
          复用 parse_cast 不新造平行解析
        bindings (T1): 局部绑定表 — preflight 早于 _apply_global 时 self._cast_bindings
          恒空, 调用方按 B6 双路口径显式传 g["角色绑定"]; None/非 list 回落 self
          (run/rerun 调用点在 _apply_global 之后, 回落即全表). 不回填 self._cast_bindings
          (守 B6 先例 — _preflight_binding_check 空表短路是已锁行为面)。
        V1.7 C1 诊断扩展 (执行侧行为零变化 — 仅加信息不改现有键语义):
          resolve_errs[i] = [(name, code), ...]   卡名解析失败 (not_found / not_v3_character)
          assign_errs[i] = err 字符串              assign_cast_slots 返回的 err (预算不足等)
          parse_warns[i] = [warn, ...]             parse_cast 的 warns 列表 (同名重复)
          no_look_cards[i] = [name, ...]           resolve 成功但白名单展开后无 subject_look 行的卡
          scene_no_row_cards[i] = [name, ...]      V1.12: scene 卡点名但卡上无 scene 行 (预检 WARN)
          scene_filtered_cards[i] = [name, ...]    V1.12 T4/T4R: scene 卡名被 关场景 开关预筛剔除 (预检 WARN)
          cards[i] = {name: card}                  resolve 成功的卡对象 (供预检 Rule 8/10 读取 rows)
        批 H1 诊断扩展:
          binding_names_in_scene[i] = [name, ...]  在场集中属于绑定表的卡 (走快照)
          unbound_names_in_scene[i] = [name, ...] 在场集中未在绑定表的卡 (走 V1.7 虚拟槽)
          all_empty_in_scene = bool                全批在场集均为空 (信息条提示)
        出场角色列解析失败 (卡名找不到 / 非 v3 character / 无 look 卡整卡跳过 / 预算不足)
        → 该行进对应 errs 不进 per_shot (执行侧静默不注入; 完整错误归 C1 预检层读取).
        """
        if getattr(self, "_cast_plan", None) is not None:
            return self._cast_plan
        # T1: 局部绑定表落位 (幂等门后单点) — None/非 list 回落 self._cast_bindings
        bindings = bindings if isinstance(bindings, list) else (getattr(self, "_cast_bindings", None) or [])

        assets = self._load_assets_for_cast_plan()
        # 1.14 批 L5 I3b: 资产库挂 self 级缓存 — 段池锚定兜底 (cast_plan 缺席的 apply/concat
        # 路径) 在本方法作用域外, 无缓存就得逐行重读主库+archive。
        self._seg_anchor_assets = assets
        # V1.12 T3: 场景卡名集 — kind=="scene" 的 v3 卡 (库级判定, 扁平行不带 kind 的
        # assign_cast_slots 与 replace_cast_names 消费此集)。场景卡不产 Subject 行、
        # 不占编号; 名字替换链路须跳过 (场景卡不是人物), 见 docs/api.md 契约 2/3。
        scene_card_names = {n for n, c in (assets or {}).items()
                            if isinstance(c, dict) and c.get("_v") == 3
                            and c.get("kind") == "scene"}
        self._cast_scene_names = scene_card_names
        # 1.14 批 J J4: 道具卡名集 — v3 卡有 subject_prop 行且无 subject_look 行 (生产道具卡
        # 形态: 无 look 行 → assign_cast_slots 整卡跳过 → 消费链断)。与 scene_card_names
        # 同通道消费: 白名单行占 Picture 槽 (道具媒体进逐镜副本), 不产 Subject 行/不占编号,
        # 产"道具以<Picture N>为准"句 (道具多角度 行 = 道具画布产物, 建档写回待消费)。
        # 有 look 的卡 (含 look+prop 同卡) 不在此列 — 其道具行随 Subject 行消费, 现状零变化。
        item_card_names = set()
        for _n, _c in (assets or {}).items():
            if not (isinstance(_c, dict) and _c.get("_v") == 3):
                continue
            _uids = {_r.get("usage") for _r in (card_cast_rows(_c)[0] or [])}
            if "subject_prop" in _uids and "subject_look" not in _uids:
                item_card_names.add(_n)
        self._cast_item_names = item_card_names
        # V1.12 T4R: 有 scene 行的 scene 卡集 — 卡级预筛区分 "被开关滤空" 与 "本无 scene 行"
        # 两档诊断 (scene_filtered_cards / scene_no_row_cards, 预检 WARN 文案不变)。
        scene_cards_with_row = {
            n for n in scene_card_names
            if any(r.get("usage") == "scene"
                   for r in (card_cast_rows((assets or {}).get(n))[0] or []))}
        per_shot = {}
        any_cast = False
        # V1.7 C1: 预检层消费 — 这些信息 B2 现状被丢弃, 现扩展到 plan 顶层供 preflight 读取
        resolve_errs = {}
        assign_errs = {}
        parse_warns = {}
        no_look_cards = {}
        # V1.12 T3: scene 卡点名但卡上无 scene 行 → 预检 WARN (不阻断)
        scene_no_row_cards = {}
        # V1.12 T4: scene 卡有 scene 行但被 关场景 开关滤空 → 预检 WARN (独立文案)
        scene_filtered_cards = {}
        # V1.12b: 空 media 行 (任何用途, subject/scene) — 预检 WARN (不阻断)
        empty_media_rows = {}
        cards_by_row = {}
        # 批 H1: 绑定路径诊断
        binding_names_in_scene = {}
        unbound_names_in_scene = {}
        binding_set = self._binding_name_set(bindings)  # 空表 = set()
        any_binding_in_csv = bool(binding_set)
        # 批 A 节点 2 修复项 2: 每行 CSV 出场角色列解析结果缓存 (供 shots_in_scene 复用,
        # 避免 parse_cast 二次调用 — B2-9 守护: parse_cast 调用次数 = 行数)
        names_per_row = []

        # ---- 三档在场集: 出场角色列(1) > prompt 名字检测(2) > 空集(3) ----
        for i, row in enumerate(shots or []):
            # 批 K 路径 a+b: 行循环顶部并入该行段级池 (契约 #12 合并点矩阵 a/b)。
            # 一处并入, tier-3 空集镜与 tier1/2 有名字行共用同一份 — 段槽对
            # assign_cast_slots 占用判定可见 (虚拟槽避让), 逐镜副本也自带段槽。
            seg_entry_row = self._seg_pools_for_row(row)
            pool_row, pu_row, seg_slots_row, seg_descs_row = self._merge_seg_pools_entry(
                pool, self._pool_usage, seg_entry_row)
            # 1.14 批 L5: 段池锚定行与段池并池同步产出 (路径 a/b 同源) —— assets 在本方法
            # 作用域, 直接反查卡行; tier-3 空集镜与 tier1/2 共用同一份 (下方两个 per_shot
            # 构造点各落位一次)。union_pool 隔离路径 (路径 d) 不带本键 (契约 #12)。
            seg_anchor_rows_row = _seg_anchor_rows_for_entry(
                seg_entry_row, assets, self._lang, binding_set)
            text = row.get("出场角色") if isinstance(row, dict) else None
            names, _parse_warns = parse_cast(text)
            # 缓存当前行 CSV 解析结果 (即便后续档 2/3 改名也保留 CSV 列值)
            names_per_row.append(list(names))
            tier = 1  # 1=列, 2=prompt, 3=空集
            if _parse_warns:
                parse_warns[i] = list(_parse_warns)
            if not names:
                tier = 2  # 列空 → 进档 2 名字检测
                # 批 K B4: 档 2 在场集 = 全局提示词 + 行提示词 **两源命中名并集**
                # (旧: 只扫行提示词 → 全局 @资产 的绑定槽在逐镜过滤里被当
                # "本镜完全未引用"剥掉, 全局引用静默消失)。
                # 无条件改动, 不随 seg_pools 键开关 — 含全局 @名字 的老项目按
                # 设计变化 (契约「验收 4 例外」); 无全局 @名字 逐字节现行为。
                prompt_text = (((self._global_prompt or "") + "\n")
                               + ((row.get("prompt") or "") if isinstance(row, dict) else ""))
                names = _detect_bound_names_in_text(prompt_text, binding_set)
            # V1.12 T4R: 卡级预筛 — 关场景=开 时 scene 卡名不进在场集 (不顶 any_cast /
            # 不占槽 / 不产句); character 卡 scene 行的行级过滤 (下方 rows_white) 保留。
            # 剔除名按"卡上有无 scene 行"归入既有 T3/T4 诊断 (预检 WARN 文案不变);
            # 绑定 scene 卡名另记 bound_scene_named — 槽位沿绑定路径补回 (契约 1b 保留)。
            bound_scene_named = []
            if self._scene_disabled and names:
                kept = []
                for n in names:
                    if n in scene_card_names:
                        if n in scene_cards_with_row:
                            scene_filtered_cards.setdefault(i, []).append(n)
                        else:
                            scene_no_row_cards.setdefault(i, []).append(n)
                        if n in binding_set:
                            bound_scene_named.append(n)
                        continue
                    kept.append(n)
                names = kept
            if not names:
                tier = 3
                names = []

            # 批 H1: 诊断: 拆分 绑定卡 vs 未绑定卡
            if names:
                binding_here = [n for n in names if n in binding_set]
                unbound_here = [n for n in names if n not in binding_set]
                if binding_here:
                    binding_names_in_scene[i] = binding_here
                if unbound_here:
                    unbound_names_in_scene[i] = unbound_here
                any_cast = True

            # 档 3: 空集镜 — 也建 per_shot 但 cast_spec=None (C5 强化,
            # enrich_blocks :305 is not None 判定, [] 会误杀手动素材句)
            if tier == 3:
                pool_copy = {
                    "Picture": dict(pool_row.get("Picture") or {}),
                    "Video":   dict(pool_row.get("Video")   or {}),
                    "Audio":   dict(pool_row.get("Audio")   or {}),
                }
                pu_copy = {
                    "Picture": {k: list(v) for k, v in (pu_row.get("Picture") or {}).items()},
                    "Video":   {k: list(v) for k, v in (pu_row.get("Video")   or {}).items()},
                    "Audio":   {k: list(v) for k, v in (pu_row.get("Audio")   or {}).items()},
                }
                # 空集镜不剔绑定卡快照槽 — 与 4a 保留 Subject 行对齐: 行既然保留定义、
                # 引用就要配线、槽就必须在; 旧"全剔"会把全局 H3 Subject 行的 <Picture N>
                # 引用对到空 pool 触发 ShotError (空集镜误报素材池缺槽 bug)
                # F-N2: 多镜共用池不串味 — 逐镜副本过滤"未引用且非绑定卡"槽位
                # shot_text 含 global + row prompt (与 apply_shot_pool :4190 同源;
                # global 引用槽对空集镜同样生效 — global 算"批级共享", 不漏)
                self._filter_unreferenced_pool_usage(
                    pu_copy,
                    shot_text=((self._global_prompt or "")
                               + "\n"
                               + ((row.get("prompt") or "") if isinstance(row, dict) else "")),
                    cast_spec=None,
                    keep_slots=seg_slots_row,
                    bindings=bindings)
                per_shot[i] = {
                    "names": [],
                    "slot_map": {},
                    "cast_spec": None,  # 空集镜 = None, 显式区分 (见 C5)
                    "pool": pool_copy,
                    "pool_usage": pu_copy,
                    "no_look_cards": [],
                    "seg_slots": seg_slots_row,
                    "seg_anchor_rows": seg_anchor_rows_row,
                    "slot_descs": seg_descs_row,   # #83: 段级槽摘要 (复刻句替换目标)
                }
                continue

            # 档 1+2: 有 names → 走旧路径 (resolve_cast → resolve 失败的卡静默)
            resolved, errs = resolve_cast(names, assets)
            if errs:
                # 任何卡名失败 → 完整报错归 C1; 执行侧静默不注入
                # V1.7 B2 门审遗留: resolve 失败行仍计入 any_cast (前置位,
                # 详见 _cast_plan 设计意图), 整批 cmode 判定走 ref2v 是有意的;
                # 完整错误拦截 + cmode 口径归属 C1 预检层 (执行侧 ERR 拦截后不可达)
                resolve_errs[i] = list(errs)
                # 即使 resolve 失败, 也建 per_shot (档 2/3 的纯空集语义变体)
                # 保留——但 cast_spec=None (执行侧不注入)
                # 旧路径: resolve 失败行不进 per_shot, 但 批 H1 因为有绑定可能, 也保留 None 语义
                # 为最小回归风险, 这里保留旧行为 — resolve 失败行不进 per_shot
                continue
            # 展开白名单行 (subject_look/outfit/prop) 为 (卡名, usage, media, desc) 扁平行
            cast_rows = []
            no_look_this_row = []
            scene_no_row_this_row = []
            scene_filtered_this_row = []
            # V1.12b: 空 media 行不进 cast_rows — 对齐前端 web/js/assets.js:152
            # `if (!media) continue;` 约定 (B4 修订); 空 media 行不触碰池槽,
            # 不产句, 仅记预检 WARN (不阻断)。修前空 outfit 行占 idx=2, 写空串进
            # pool_copy, 跑批抛"分镜引用了 <Picture N> 但素材池里没有" 硬失败。
            empty_media_warns_this_row = []
            cards_this_row = {}
            for name, (card, _err) in zip(names, resolved):
                if card is None:
                    continue
                cards_this_row[name] = card
                rows_white, _skipped = card_cast_rows(card)
                is_scene_card = card.get("kind") == "scene"
                _has_scene_row = any(r.get("usage") == "scene" for r in rows_white)
                # V1.12 T4: 关场景=开 → 卡→自动带图链路的 scene 行滤空 (不占 Picture 槽/不产句);
                # 绑定快照路径在下方 pu_copy 注入处单独收口 (槽位 media 保留)
                if self._scene_disabled and _has_scene_row:
                    rows_white = [r for r in rows_white if r.get("usage") != "scene"]
                # V1.12b: 过滤空 media 行 — 主体 / scene 同源处理 (不产句不占槽);
                # 行跳过信息存 (name, usage, desc) 供预检 WARN 提示用户补图
                rows_white_eff = []
                for r in rows_white:
                    media_v = (r.get("media") or "").strip()
                    if not media_v:
                        empty_media_warns_this_row.append(
                            (name, r.get("usage", ""), r.get("desc", "")))
                        continue
                    rows_white_eff.append(r)
                rows_white = rows_white_eff
                # V1.12 T3: scene 卡豁免 Rule 3 ("无外貌行" 对场景卡不适用);
                # 改判"无 scene 行" → 预检 WARN (契约 5, 不阻断);
                # T4: 有 scene 行但被开关滤空 → 独立 WARN 文案 (契约 4), 不重复报"无 scene 行"
                # V1.12b: scene 卡点名 + 唯一 scene 行被空 media 滤空 → 视同"无 scene 行"
                # (与契约 5 同档, 预检 WARN 不阻断)
                if is_scene_card:
                    if not _has_scene_row or not any(
                            r.get("usage") == "scene" for r in rows_white):
                        scene_no_row_this_row.append(name)
                    elif self._scene_disabled:
                        scene_filtered_this_row.append(name)
                elif name in item_card_names:
                    pass  # J4: 道具卡无 look 属自然形态 (走 ref 通道) — 同 scene 卡豁免 Rule 3
                elif not any(r.get("usage") == "subject_look" for r in rows_white):
                    # V1.7 C1: 跟踪无 subject_look 的卡 — 预检 Rule 3 消费
                    no_look_this_row.append(name)
                for r in rows_white:
                    cast_rows.append((name, r.get("usage", ""), r.get("media", ""),
                                      r.get("desc", ""), r.get("ignore_words", "")))
            # 即使 cast_rows 为空 (所有卡都无白名单行) 也记录诊断信息, 不进 per_shot
            if no_look_this_row:
                no_look_cards[i] = no_look_this_row
            if scene_no_row_this_row:
                scene_no_row_cards[i] = scene_no_row_this_row
            if scene_filtered_this_row:
                scene_filtered_cards[i] = scene_filtered_this_row
            if empty_media_warns_this_row:
                empty_media_rows[i] = list(empty_media_warns_this_row)
            if cards_this_row:
                cards_by_row[i] = cards_this_row
            if not cast_rows:
                continue

            # ---- 批 H1 编号 + 路径分流: 绑定卡走快照槽, 未绑定卡走旧虚拟槽 ----
            # 1) 收集绑定卡的 slots 快照路径 (不走 assign_cast_slots 虚拟槽域 1-8)
            # V1.12 T4R: 被预筛剔除的绑定 scene 卡计入在场集 — 其快照槽位保留 (契约 1b)
            scene_names = set(names) | set(bound_scene_named)
            # T1: 绑定表消费改局部 bindings (preflight 局部注入; run/rerun 回落同值)
            binding_lookup = {b["name"]: b for b in bindings
                              if isinstance(b, dict) and isinstance(b.get("name"), str)
                              and isinstance(b.get("no"), int)}
            # 分配: 绑定卡按全局 no (批 H1 Z2 编号规则)
            binding_in_scene_sorted = sorted(
                [n for n in names if n in binding_lookup],
                key=lambda n: binding_lookup[n]["no"])
            unbound_in_scene = [n for n in names if n not in binding_lookup]
            # V1.12 T3 契约 2/3 + J4: scene/道具卡不占 Subject 编号 — 绑定/未绑定两路编号
            # 序列均剔除; 槽位照分 (下方 slot_map), 绑定 no 不吃编号 (start_no 只看人物绑定卡)
            _no_subject_names = scene_card_names | item_card_names
            numbered_bindings = [n for n in binding_in_scene_sorted
                                 if n not in _no_subject_names]
            unbound_char = [n for n in unbound_in_scene if n not in _no_subject_names]
            # 起点 = 绑定卡最大 no + 1; 无绑定时从 1 起
            start_no = max((binding_lookup[n]["no"] for n in numbered_bindings),
                           default=0) + 1
            # 注: 未绑定卡在 (start_no, start_no+1, ...) 区间按出场顺序编号

            # 2) 给绑定卡构造虚拟 slot_map (slot=idx 来自快照, usage/media/desc 直读)
            # bound_scene_named: T4R 预筛剔除的绑定 scene 卡 — 槽位补回 (不进 cast_spec/编号)
            slot_map = {}
            for name in (binding_in_scene_sorted + bound_scene_named):
                b = binding_lookup[name]
                for s in (b.get("slots") or []):
                    if not isinstance(s, dict):
                        continue
                    idx = s.get("idx")
                    usage = s.get("usage") or ""
                    media = s.get("media") or ""
                    desc = s.get("desc") or ""
                    if not isinstance(idx, int):
                        continue
                    slot_map[idx] = (name, usage, media, desc, s.get("ignore_words") or "")
                    # 1.14a T2: 绑定快照姿势样式注入 — usage="pose" 时同步 self._pose_style,
                    # 缺省走 "skeleton" 静默路径(老板拍板默认值, 缺省无黄条)
                    self._inject_bound_pose_style(s, idx)
            # 3) 未绑定卡走旧 V1.7 虚拟槽域 (assign_cast_slots 用 pool/pool_usage 占用判定)
            # V1.13 波2 D4: 排除绑定卡已占槽集 (避 slot_map.update 覆盖 + pool_copy 换图)
            if unbound_in_scene:
                # 只对未绑定卡展开 cast_rows (bindings 的已跳过)
                unbound_cast_rows = [r for r in cast_rows if r[0] not in binding_lookup]
                if unbound_cast_rows:
                    # 收集绑定卡已占槽 (整数 idx 集合, 限定 1-8 = 虚拟槽域)
                    # 同时计入 binding_in_scene_sorted (Subject 编号内) + bound_scene_named (T4R
                    # 预筛剔除的绑定 scene 卡, 槽位保留不进 cast_spec — 仍占虚拟槽, 需排除)
                    bound_slot_idxs = set()
                    for nm in (binding_in_scene_sorted + bound_scene_named):
                        for s in (binding_lookup[nm].get("slots") or []):
                            if isinstance(s, dict) and isinstance(s.get("idx"), int):
                                if 1 <= s["idx"] <= 8:
                                    bound_slot_idxs.add(s["idx"])
                    unbound_slot_map, assign_err = assign_cast_slots(
                        unbound_cast_rows, pool_row, pu_row, self.mode,
                        scene_card_names=scene_card_names,
                        bound_slots=bound_slot_idxs,
                        item_card_names=item_card_names)
                    if assign_err:
                        assign_errs[i] = assign_err
                        continue
                    slot_map.update(unbound_slot_map)

            # cast_spec: 编号 = 绑定卡按全局 no (1..max), 未绑定卡从 max+1 起按出场顺序
            # 批 H2 fix: 绑定卡 cast_spec 行**直接由 slots 列表迭代**构造,
            # 跨 slot_map 字典 — slot_map[idx]=(name,usage,media,desc) 同 idx 会被后者覆盖,
            # 致 co-occupy (同 idx 多 usage) 塌缩丢行 — 与 D 节"构造保证"铁律冲突;
            # 未绑定卡保留 slot_map 路径 (虚拟槽天然无共占, 安全)
            card_order_with_no = []  # [(no, name), ...] — 仅人物卡 (scene 卡不进编号)
            for n in numbered_bindings:
                card_order_with_no.append((binding_lookup[n]["no"], n))
            for idx, n in enumerate(unbound_char):
                card_order_with_no.append((start_no + idx, n))
            cast_spec_rows = {}  # no -> [(slot, usage, desc, ignore_words), ...] 顺序为构造顺序
            for no, name in card_order_with_no:
                rows = cast_spec_rows.setdefault(no, [])
                if name in binding_lookup:
                    # 绑定卡: 直接迭代 slots 列表 (保留 co-occupy 同 idx 多行)
                    for s in (binding_lookup[name].get("slots") or []):
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
                        ig_s = mapped[4] if len(mapped) > 4 else ""
                        if n2 == name:
                            rows.append((slot, usage_s, desc_s, ig_s))
            cast_spec = [(no, cast_spec_rows.get(no, []))
                         for no, _name in card_order_with_no]

            # 逐镜副本: deepcopy 隔离; 虚拟槽写入副本
            pool_copy = {
                "Picture": dict(pool_row.get("Picture") or {}),
                "Video":   dict(pool_row.get("Video")   or {}),
                "Audio":   dict(pool_row.get("Audio")   or {}),
            }
            pu_copy = {
                "Picture": {k: list(v) for k, v in (pu_row.get("Picture") or {}).items()},
                "Video":   {k: list(v) for k, v in (pu_row.get("Video")   or {}).items()},
                "Audio":   {k: list(v) for k, v in (pu_row.get("Audio")   or {}).items()},
            }
            for slot, mapped in slot_map.items():
                name, usage, media, desc = mapped[:4]
                pool_copy["Picture"][slot] = media
                if slot not in pu_copy["Picture"]:
                    pu_copy["Picture"][slot] = []
                # V1.12 T4: 关场景=开 → 绑定快照 scene usage 不注入产句链 (不产句;
                # 槽位 media 已保留 — 用户手动指定的 idx 不动), 槽键留空 list
                if not (self._scene_disabled and usage == "scene"):
                    if usage not in pu_copy["Picture"][slot]:
                        pu_copy["Picture"][slot].append(usage)
            # 副本过滤 (C5): 剔除不在场绑定卡的快照槽 (pool/pool_usage 同步)
            self._filter_unscene_binding_slots(pool_copy, pu_copy,
                                               binding_set, scene_names=scene_names,
                                               bindings=bindings)
            # V1.12 T3 契约 1 + J4: scene/道具卡槽不进 cast_spec (不占 Subject 编号),
            # 逐镜副本保留该槽只能靠 keep ④ 显式传入 — 否则过滤后场景/道具句静默消失
            keep_slots = {slot for slot, mapped in slot_map.items()
                          if mapped[0] in _no_subject_names}
            # F-N2: 多镜共用池不串味 — 逐镜副本过滤"未引用且非绑定卡"槽位
            # shot_text 与 apply_shot_pool :4190 global_eff + row prompt 同源 (TAG
            # 命中规则一致; Subject 行剔除对 TAG 无影响, 无需走 _filter_global_subject_lines)
            self._filter_unreferenced_pool_usage(
                pu_copy,
                shot_text=((self._global_prompt or "")
                           + "\n"
                           + (row.get("prompt") or "")
                           if isinstance(row, dict) else (self._global_prompt or "")),
                cast_spec=cast_spec if cast_spec else None,
                keep_slots=(set(keep_slots) | seg_slots_row),
                bindings=bindings)
            per_shot[i] = {
                "names": list(names),
                "slot_map": slot_map,
                "cast_spec": cast_spec if cast_spec else [],
                "pool": pool_copy,
                "pool_usage": pu_copy,
                "no_look_cards": list(no_look_this_row),
                # 批 K: 段级槽标记 (union_pool 隔离) + F-N2 keep ④ 显式槽
                # (段级 12 槽黄条计数同口径, 见 _check_seg_pool_limits)
                "seg_slots": seg_slots_row,
                "keep_slots": set(keep_slots),
                "seg_anchor_rows": seg_anchor_rows_row,
                "slot_descs": seg_descs_row,   # #83: 段级槽摘要 (复刻句替换目标)
            }

        # union_pool = deepcopy(pool) + 全批虚拟槽 media (同槽冲突时先到先得, 仅用于 cmode 判定
        # 的"有没有图"计数 — 不要求文件一致, 见 PRD §3.4 union 注释)
        # 批 H1: union_pool 基底始终是完整物理池, 不因副本过滤侵蚀 (cmode 判定输入保真)
        union_pool = {
            "Picture": dict(pool.get("Picture") or {}),
            "Video":   dict(pool.get("Video")   or {}),
            "Audio":   dict(pool.get("Audio")   or {}),
        }
        for i, plan in per_shot.items():
            # 批 K 路径 d: 段级槽不进 union_pool (契约 #12 隔离) — 否则段素材把批级
            # 并集的"图数"抬高, _detect_concat_mode 会隐式翻模板族。
            seg_slots = plan.get("seg_slots") or set()
            for slot, fname in (plan["pool"].get("Picture") or {}).items():
                if ("Picture", slot) in seg_slots:
                    continue
                if slot not in union_pool["Picture"]:
                    union_pool["Picture"][slot] = fname

        # 批 A 节点 2 修复项 2: shots_in_scene — 复用 names_per_row (loop 内已解析过),
        # 收集每行 (1-indexed) 的出场角色名列表 → cast_plan["shots_in_scene"]
        # (供 retention_analysis (appears in [Shot N], ...) 集合渲染用)
        shots_in_scene = list(names_per_row)

        # 批 A 节点 2 修复: 把 shots_in_scene 与 current_shot_no 同步注入每个 per_shot[i]
        # 让执行链路 (_run_one / rerun / folder 透传 per_shot) 在 assemble_final_prompt
        # 阶段能直接读到这两个值, 无需 ghost 属性兜底; 行号按 1 起 (与 _build_retention_lines
        # 全集 (range(1, N+1)) 对齐)。
        for _i, _plan in per_shot.items():
            _plan["shots_in_scene"] = shots_in_scene
            _plan["current_shot_no"] = _i + 1

        # inject_ok: 分镜 / 自定义无勾选 = _template_mode(ref2v); 拼接 / 自定义有勾选 = effective cmode(ref2v) (declared 优先)
        # 1.11b 波1 T2: B 类批级门控走 _any_seg_concat (含"全不勾自定义批"精确等价分镜, 验收 6①)
        if not self._any_seg_concat():
            template_m = _template_mode(self.workflow_path) if self.workflow_path else None
            inject_ok = (template_m == "ref2v")
        else:
            declared = getattr(self, "_declared", None)
            if declared:
                cmode_eff = declared
            else:
                cmode_eff = self._detect_concat_mode(union_pool, has_cast=any_cast)
            inject_ok = (cmode_eff == "ref2v")

        # 批 H1: 全批空集判定 (信息条): 存在绑定 + 全批 names 集合为空
        all_empty_in_scene = bool(any_binding_in_csv) and not any_cast

        self._cast_plan = {
            "any_cast": any_cast,
            "inject_ok": inject_ok,
            "union_pool": union_pool,
            "per_shot": per_shot,
            # 批 A 节点 2 修复项 2: shots_in_scene — 从 CSV 出场角色列构造,
            # 供 retention_analysis (appears in [Shot N], ...) 渲染用
            "shots_in_scene": shots_in_scene,
            # V1.7 C1 诊断扩展
            "resolve_errs": resolve_errs,
            "assign_errs": assign_errs,
            "parse_warns": parse_warns,
            "no_look_cards": no_look_cards,
            # V1.12 T3: scene 卡点名但无 scene 行 → 预检 WARN (不阻断)
            "scene_no_row_cards": scene_no_row_cards,
            # V1.12 T4: scene 卡 scene 行被 关场景 开关滤空 → 预检 WARN (独立文案)
            "scene_filtered_cards": scene_filtered_cards,
            # V1.12b: 空 media 行 (任何用途, subject/scene) — 预检 WARN (不阻断)
            # 与 web/js/assets.js:152 `if (!media) continue;` 约定对齐
            "empty_media_rows": empty_media_rows,
            "cards": cards_by_row,
            # 批 H1 诊断扩展
            "binding_names_in_scene": binding_names_in_scene,
            "unbound_names_in_scene": unbound_names_in_scene,
            "all_empty_in_scene": all_empty_in_scene,
        }
        return self._cast_plan

    def _binding_name_set(self, bindings=None):
        """批 H1: 收集当前批绑定表 name 集合 (供名字检测/过滤用);
        bindings=None 回落 self._cast_bindings (T1: 局部注入路径显式传参)"""
        out = set()
        for b in (bindings if bindings is not None
                  else (getattr(self, "_cast_bindings", None) or [])):
            if isinstance(b, dict) and isinstance(b.get("name"), str) and b["name"]:
                out.add(b["name"])
        return out

    def _filter_unscene_binding_slots(self, pool_copy, pu_copy, binding_set, scene_names,
                                      bindings=None):
        """批 H1 C5: pool/pool_usage 副本同步剔除不在场绑定卡的快照槽
        (手动素材槽永远保留 — 池里手动填的池底文件不属于绑定快照)
        binding_set = 全批 binding names; scene_names = 本镜 names (空集 = ∅)
        bindings (T1): 局部绑定表, None 回落 self._cast_bindings
        """
        if not binding_set:
            return
        # 不在场绑定卡 = binding_set - scene_names
        unscene_bindings = binding_set - scene_names
        if not unscene_bindings:
            return
        # 收集其 slot idx: 来自快照
        binding_lookup = {b["name"]: b for b in (bindings if bindings is not None
                                                 else (getattr(self, "_cast_bindings", None) or []))
                          if isinstance(b, dict) and isinstance(b.get("name"), str)}
        unscene_slots = set()
        for name in unscene_bindings:
            b = binding_lookup.get(name) or {}
            for s in (b.get("slots") or []):
                if isinstance(s, dict) and isinstance(s.get("idx"), int):
                    unscene_slots.add(s["idx"])
        # pool_copy: 剔除 idx (任何来源 — 池底 or 快照写的)
        for idx in unscene_slots:
            pool_copy["Picture"].pop(idx, None)
            # pool_usage: 同步剔除 (避开 :1612-1615 ShotError 硬崩)
            pu_copy["Picture"].pop(idx, None)

    def _filter_unreferenced_pool_usage(self, pu_copy, shot_text, cast_spec, keep_slots=None,
                                        bindings=None):
        """F-N2: 多镜共用素材池时, 逐镜副本 pu_copy 剔除"本镜完全未引用"的槽位。

        保留条件 (满足其一即留):
          ① shot_text (global_prompt + row prompt) 中 TAG <Picture|Video|Audio N> 命中
          ② 全批绑定卡快照槽 (取绑定表全集 — 不走场景过滤;
             档 3 不调 _filter_unscene_binding_slots, 绑定卡槽须保留; 档 1/2 经
             _filter_unscene_binding_slots 后, 副本里只剩在场卡槽, 与全集取交集等价)
          ③ cast_spec 绑定卡槽 (在场卡, 与 ② 等价于"在场卡槽"; 双保险兼容)
        剔除: 其他手动标记槽位 — 防止批池全量用法被串到本镜 enrich_blocks / 接线。

        pose 是场景级语义, 只对"被引用/被绑定的槽位"生效 — pose 槽同样适用本过滤。
        pu_copy 原位修改 (dict.pop) — 调用方负责副本隔离, 本函数不复制。
        keep 集判据单源 = _f_n2_keep_set (批 K 段级 12 槽黄条同口径共用)。
        bindings (T1): 局部绑定表, None 回落 self._cast_bindings。
        """
        keep = _f_n2_keep_set(shot_text, cast_spec, keep_slots,
                              bindings if bindings is not None
                              else getattr(self, "_cast_bindings", None))
        # 剔除 (list 快照防迭代中修改 dict)
        for kind in ("Picture", "Video", "Audio"):
            slots = pu_copy.get(kind) or {}
            for slot in list(slots.keys()):
                if (kind, slot) not in keep:
                    slots.pop(slot, None)

    def _detect_concat_mode(self, pool, has_cast=False):
        # V1.7 B2: has_cast=True → 池空/恰1图也返回 "ref2v" (含虚拟图即至少按 ref2v 族处理, F3)
        # 1.14 批 I I2a 收敛: i2v 语义废除 (老板令 D5) — 自动选型只产 ref2v|t2v.
        # 1 图无 vid/aud 不再判 i2v: 唯一可达消费面 (preflight 的 cmode/pic9 与
        # _prepare_cast_plan inject_ok) 对 i2v/t2v 不可分辨 (判据只分 == "ref2v"),
        # 归 t2v 保持逐字节零变化; 归 ref2v 会翻转 ref2v 单图批 preflight 判定面.
        if has_cast:
            return "ref2v"
        pics = [v for v in pool["Picture"].values()]
        vids = [v for v in pool["Video"].values()]
        auds = [v for v in pool["Audio"].values()]
        if len(pics) <= 1 and not vids and not auds:
            return "t2v"
        return "ref2v"

    def apply_shot_concat(self, prompt, row, pool, prev_frame, next_frame=None, cast_plan=None,
                           shot_no=None, cum_ms=None, seg_override=None):
        # V1.7 B2: cast_plan=None (默认) → 现状路径逐字节不变; 显式传时用逐镜副本 (F1 一票否决)
        prompt = json.loads(json.dumps(prompt))
        # 1.13h 2b: 段级池覆盖 (无覆盖 → 原对象, 零变化); cmode 判定/挑选同吃覆盖
        pool = self._merge_seg_pool(pool, seg_override)
        # 1.13h 2c: 段级资源差分 (批级已应用之上再覆盖; 无覆盖 → 原图)
        prompt = self._apply_seg_resource_diff(prompt, seg_override, sid=(row.get("ID") or ""))
        # V1.9 批 3 T3.2 S1: latent 续接激活时尾帧图注入让位 (ref2v 9 号动态衔接槽 +
        # t2v first_frame 的 prev_frame 路径) — 上段尾窗 AV latent 由 H3MotionContext
        # 钉进本段开头, 同段再挂单帧尾图会双重锚定。CSV 手填 9 号槽不受影响。
        # T3.3 触发矩阵: 让位判定带完整降级链 (patch 预检粘性/latent 缺失/锚点探测) —
        # 任一触发即不让位, prev_frame 照常走尾帧直连 (降级段开关位恢复)。
        if prev_frame and self._continuation_load_ready(shot_no, prompt):
            prev_frame = None
        elif prev_frame is not None and not isinstance(prev_frame, str):
            # 批 W1 R-62 (P-2): prev_frame 为后台流水线延迟引用 — 降级路径 (不让位)
            # 此处按需阻塞取上段尾帧 (等 collect+抽帧作业完成, 锚不丢·禁盲异步);
            # 让位 (latent 续接就绪) 不取值不等 — 尾帧由作业后台补记账 (P-5)。
            prev_frame = self._pipe_resolve_prev(prev_frame)
        ref_nid = self._ref_node_id(prompt)
        ref_node = prompt[ref_nid]
        # 模板声明了模式则以声明为准(用户显式选择), 否则按素材自动选型 (I2a 后只产 ref2v|t2v)
        declared = getattr(self, "_declared", None)
        # V1.7 B2: cmode 检测统一口径 — self._cast_plan 存在且 any_cast → union_pool + has_cast=True
        # declared 优先不变; any_cast=False 时使用批级 pool (现状路径)
        _cp = getattr(self, "_cast_plan", None)
        if _cp is not None and _cp.get("any_cast"):
            cmode = declared or self._detect_concat_mode(_cp["union_pool"], has_cast=True)
        else:
            cmode = declared or self._detect_concat_mode(pool)
        # 清空模板自带参考/首尾帧槽
        for key in list(ref_node["inputs"].keys()):
            if key.startswith(("ref_images.", "ref_videos.", "ref_video_audios.", "ref_audios.",
                               "first_frame", "last_frame")):
                del ref_node["inputs"][key]
        # 逐镜副本 vs 批级 — cast_plan 存在时使用副本 (含虚拟槽); None 时现状
        # 1.13h 2b: 段级池覆盖同样作用于 cast 副本 (merge 返回新 dict, 不污染 cast_plan)
        # #83: 段级槽的场景文字摘要随并池带出 (复刻句替换目标)
        slot_descs = {}
        if cast_plan:
            pool_eff = self._merge_seg_pool(cast_plan["pool"], seg_override)
            pu_eff = cast_plan["pool_usage"]
            slot_descs = cast_plan.get("slot_descs") or {}
        else:
            # 批 K 路径 c (拼接链路同一条件): 与 apply_shot_pool 同款兜底 — cast_plan
            # 缺席时并入段级池, 否则拼接批的段资产在 resolve 失败/无白名单行上静默丢。
            pool_eff, pu_eff, _, slot_descs = self._merge_seg_pools_entry(
                self._merge_seg_pool(pool, seg_override), self._pool_usage,
                self._seg_pools_for_row(row))
        if cmode == "t2v":
            if declared and not getattr(self, "_trim_noted", False):
                pics = {k: v for k, v in pool["Picture"].items() if (v or "").strip()}
                vids_auds = sum(1 for kind in ("Video", "Audio") for v in pool[kind].values() if (v or "").strip())
                if pics or vids_auds:
                    print("[H3Batch] t2v 模板: 忽略全部 %d 张参考图和 %d 个视频/音频素材"
                          % (len(pics), vids_auds), flush=True)
                    self._trim_noted = True
            if prev_frame:
                # t2v 拼接续接 (I2a 保留项): 上段尾帧直连本段 first_frame
                nid = str(self._fresh_id())
                prompt[nid] = {"class_type": "LoadImage", "inputs": {"image": prev_frame}}
                ref_node["inputs"]["first_frame"] = [nid, 0]
            # 双锚定重跑: 尾帧锁到下一段首帧 (ImageToVideo 节点才接 last_frame)
            if next_frame and ref_node["class_type"] == "MiniMaxH3ImageToVideo":
                nid = str(self._fresh_id())
                prompt[nid] = {"class_type": "LoadImage", "inputs": {"image": next_frame}}
                ref_node["inputs"]["last_frame"] = [nid, 0]
        elif cmode == "ref2v":
            # prompt 带 <Picture/Video/Audio N> 标签时只接被引用的槽(9 号动态槽除外);
            # 无标签保持全池接线(老用法兼容)
            used = set()
            # 标签可写在分镜行或全局提示词里, 两处合并解析
            for m in TAG_RE.finditer((self._global_prompt or "") + "\n" + (row.get("prompt") or "")):
                used.add((m.group("kind").title(), int(m.group("idx"))))
            # V1.4 T3: 用途标注合并入 used-set(只要 pu_eff 任一 kind 非空即展开)
            # V1.7 B2: pu_eff 为副本 (cast_plan 含虚拟槽用途); cast_plan=None → pu_eff=self._pool_usage, 行为零变化
            if any(pu_eff.values()):
                used |= {(kind, idx) for kind, slots in pu_eff.items()
                         for idx in slots}
            if used:
                for kind, idx in sorted(used):
                    if not pool_eff[kind].get(idx):
                        # 9 号动态衔接槽: 第 2 段起由引擎注入上一段尾帧, 引用可正常解析;
                        # 第 1 段无尾帧可注入时, 引用了却没上传 = 锚定落空的不合格任务, 阻断并提示
                        if kind == "Picture" and idx == 9:
                            if prev_frame:
                                continue
                            raise ShotError("第 1 段引用了 <Picture 9> 但素材池 9 号留空: "
                                            "请上传 9 号起点图(第 2 段起自动接上一段尾帧, 不受影响)")
                        raise ShotError("分镜引用了 <%(k)s %(i)d> 但素材池里没有: 请在素材池对应槽位上传素材" % {"k": kind, "i": idx})
            for kind, slotkey, prefix in (("Picture", "Picture", "ref_images.ref_image_%d"),
                                          ("Video", "Video", "ref_videos.ref_video_%d"),
                                          ("Audio", "Audio", "ref_audios.ref_audio_%d")):
                # V1.7 B2: 遍历 pool_eff 副本 (cast_plan 含虚拟槽)
                for idx, fname in sorted(pool_eff[slotkey].items()):
                    if kind == "Picture" and idx == 9:
                        # 9 号槽是动态衔接槽, 不做静态接线(见下方 prev_frame 逻辑)
                        continue
                    if used and (kind, idx) not in used:
                        continue
                    fname = self._resolve_file(fname)
                    if kind == "Picture":
                        nid = str(self._fresh_id())
                        prompt[nid] = {"class_type": "LoadImage", "inputs": {"image": fname}}
                        if ref_node["class_type"] == "MiniMaxH3ImageToVideo":
                            # 同分镜模式: 新版 ImageToVideo 无 ref_images Autogrow 槽
                            if idx == 1:
                                ref_node["inputs"]["first_frame"] = [nid, 0]
                            elif idx == 2:
                                ref_node["inputs"]["last_frame"] = [nid, 0]
                            else:
                                raise ShotError("ImageToVideo 模板图片参考槽只有 first/last 两个: <Picture %d> 超出" % idx)
                        else:
                            # 1.14a T3: concat 路径 pose 路由 — 与 apply_shot_pool 同构守卫:
                            # ref2v + 单 pose → _inject_pose_convert; i2v 不转 (9 号已在上层 continue)
                            # style 缺省 skeleton (T1 解析层兜底)
                            target = [nid, 0]
                            if (ref_node["class_type"] == "MiniMaxH3ReferenceToVideo"
                                    and (pu_eff.get("Picture") or {}).get(idx) == ["pose"]):
                                style = self._pose_style.get("Picture", {}).get(idx) or "skeleton"
                                target = self._inject_pose_convert(prompt, nid, style)
                            ref_node["inputs"][prefix % (idx - 1)] = target
                    elif kind == "Video":
                        lv = str(self._fresh_id())
                        gc = str(self._fresh_id())
                        prompt[lv] = {"class_type": "LoadVideo", "inputs": {"file": fname}}
                        prompt[gc] = {"class_type": "GetVideoComponents", "inputs": {"video": [lv, 0]}}
                        ref_node["inputs"][prefix % (idx - 1)] = [gc, 0]
                    elif kind == "Audio":
                        la = str(self._fresh_id())
                        prompt[la] = {"class_type": "LoadAudio", "inputs": {"audio": fname}}
                        ref_node["inputs"][prefix % (idx - 1)] = [la, 0]
            # Picture 9 = 动态衔接槽: 第 2 段起接上一段尾帧; 第 1 段可用 CSV 手填图做起点
            # V1.7 B2: 读 pool_eff (cast 不动 9 号, 与 pool 等价; 保持副本口径一致)
            pic9 = prev_frame
            if not pic9 and pool_eff["Picture"].get(9):
                pic9 = self._resolve_file(pool_eff["Picture"][9])
            if pic9:
                nid = str(self._fresh_id())
                prompt[nid] = {"class_type": "LoadImage", "inputs": {"image": pic9}}
                ref_node["inputs"]["ref_images.ref_image_8"] = [nid, 0]
        # V1.4 T3: 发送链路 enrich — 代写句组装 + P9 锚定句三重去重
        # pic9_present 与 1020-1023 行 pic9 接线同源(cmoke==ref2v 时才计算, 否则 enrich_blocks 内 cmode 抑制)
        # 批 A 节点 3 (A4 R2): warns 列表前置声明 — 非 ref2v 模板走 _apply_shot_common
        # 也可被音频冲突黄条 (assemble_final_prompt 产出) 填充, 通道与 ref2v 同源
        # 批 A 节点 4 (4a): 前置到逐镜过滤前 — 空集镜兜底反转黄条也入此通道 (复用 audio 通道)
        warns = []
        # I-⑤: 逐镜过滤 — 先剔除 global 中不在场 Subject 行, 早于 enrich/wiring 避免悬空 <Picture N>
        # 批 A 节点 4 (4a): 透传 warns → 空集镜兜底反转黄条入此通道 (与下方 audio 冲突同源)
        if cast_plan is not None:
            scene_nos = {no for no, _ in (cast_plan.get("cast_spec") or [])
                         if isinstance(no, int)}
            global_eff = _filter_global_subject_lines(
                self._global_prompt or "", scene_nos, warn_sink=warns)
        else:
            global_eff = self._global_prompt or ""
        pic9_present = False  # 批 A 节点 2: 默认 False, ref2v 分支按 prev_frame/pool 9 重写
        if cmode == "ref2v":
            text_combined = global_eff + "\n" + (row.get("prompt") or "")
            pic9_present = bool(prev_frame or (pool_eff["Picture"].get(9) or "").strip())
            # V1.7 B2: enrich_blocks 透传 cast_spec (cast 镜主体块唯一来源是 cast 路径, F4)
            cast_spec = cast_plan["cast_spec"] if cast_plan else None
            # I-⑤: 防双份 — global 已有 Subject N 行 → cast_spec 中 no=N 移除
            if cast_spec is not None and cast_spec:
                cast_spec = _filter_cast_spec_for_dedup(cast_spec, text_combined)
            blocks = enrich_blocks(pu_eff, text_combined, cmode, pic9_present,
                                   lang=self._lang, warns=warns, cast_spec=cast_spec)
        else:
            blocks = None
        # I-⑤: 逐镜过滤 — 透传 cast_plan 给 _apply_shot_common
        # 批 A 节点 3 (A4 R2): 同 warns 列表复用 — 音频冲突黄条 + enrich 警告同通道
        # _apply_shot_common 返回后再统一 for-print (避免双重 print)
        ret = self._apply_shot_common(prompt, row, extra_blocks=blocks or None,
                                      per_shot_plan=cast_plan,
                                      cmode=cmode, pic9_present=pic9_present,
                                      shot_no=shot_no, cum_ms=cum_ms,
                                      warn_sink=warns, seg_override=seg_override,
                                      slot_descs=slot_descs)
        for w in warns:
            print("[H3Batch] 警告: %s" % w, flush=True)
        return ret

    def _extract_last_frame(self, video_path):
        name = os.path.splitext(os.path.basename(video_path))[0] + "_tail.png"
        # V1.6: 中间帧归档到 intermediates/<run_dir_basename>/, 避免污染 input 根目录
        # run_dir 在 rerun 模式沿用原批文件夹, 实时取 basename 反映当前批身份
        run_base = os.path.basename(self.run_dir) if getattr(self, "run_dir", None) else "rerun"
        sub_dir = os.path.join(self.server_input_dir, "intermediates", run_base)
        os.makedirs(sub_dir, exist_ok=True)
        rel = os.path.join("intermediates", run_base, name)
        out = os.path.join(self.server_input_dir, rel)
        # V1.9 批 3 T3.6: S4 冻结尾检测 — 尾帧直连(降级/让位)路径的尾帧提取
        # 从"字面最后一帧"改为双门检测 (视觉静止+运动幅度), 冻结时取冻结起点前
        # 最后一有效帧 (避开模型冻结输出的复制帧); 未冻结 → 原行为; 检测任何
        # 失败 → 降级原 -sseof -0.1 路径 (拼接永远能跑, 不向上抛断批)。
        # latent 续接路径不走尾帧 (S1 注入), 本改造只影响降级/让位路径。
        try:
            info = freeze_detect.extract_with_freeze_detect(
                video_path, out, ffmpeg_exe=_ffmpeg_exe(),
                ffprobe_exe=_ffprobe_exe())
            if info.get("frozen"):
                print("[H3Batch] 尾帧提取: 冻结尾检出 (静止起点前帧 %s, 窗口 %ss)"
                      % (info.get("frame"), info.get("window")), flush=True)
            if os.path.exists(out):
                return rel
        except Exception as e:  # 检测是尽力而为的增强: 任何失败 (含探测/解码/
            # numpy/环境异常) 一律降级字面最后一帧 — 拼接永远能跑, 不向上抛断批
            print("[H3Batch] 冻结尾检测降级, 取字面最后一帧 (%s): %s"
                  % (video_path, e), flush=True)
        # 降级/兜底: 原字面最后一帧路径 (V1.8 行为)
        cmd = [_ffmpeg_exe(), "-y", "-sseof", "-0.1", "-i", video_path,
               "-frames:v", "1", out]
        try:
            subprocess.run(cmd, capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as e:
            print("[H3Batch] 提取尾帧失败 (%s): %s" % (video_path, e), flush=True)
            return None
        if os.path.exists(out):
            return rel
        return None

    def _extract_first_frame(self, video_path):
        name = os.path.splitext(os.path.basename(video_path))[0] + "_head.png"
        # V1.6: 与 _extract_last_frame 对称 — 同落 intermediates/<run_dir_basename>/
        run_base = os.path.basename(self.run_dir) if getattr(self, "run_dir", None) else "rerun"
        sub_dir = os.path.join(self.server_input_dir, "intermediates", run_base)
        os.makedirs(sub_dir, exist_ok=True)
        rel = os.path.join("intermediates", run_base, name)
        out = os.path.join(self.server_input_dir, rel)
        cmd = [_ffmpeg_exe(), "-y", "-i", video_path, "-frames:v", "1", out]
        try:
            subprocess.run(cmd, capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as e:
            print("[H3Batch] 提取首帧失败 (%s): %s" % (video_path, e), flush=True)
            return None
        if os.path.exists(out):
            return rel
        return None

    def _prealign_colors(self, parts):
        """V1.9 批 3 T3.5 → 批 4 T1 D 重组: S2 色彩对齐 — 只算逐段滤镜参数。

        滤镜入链 (省一代编码): probe 全段统计 (基准钉死首段) → 计划 →
        self._color_filters (逐段 lutyuv/eq 滤镜串, None=参考段/死区) — 滤镜
        注入 _concat_videos → compose_join 的 filter_complex, 段只编码一次;
        不再独立重编码/不建 _color_align 暂存目录 (对齐激活且 compose_join
        失败时由降级链回退暂存重编码, 同套参数 self._color_plan)。全关
        (color_level=off + flatten=False) → 零改动零留痕 (V1.8 一致路径);
        任何失败 → 降级原段直接 join (拼接永远能出片) + manifest._color.degraded
        留痕。映射量 clamp 超限如实打日志。结果写 self._color_info (调用链
        manifest._color 批级留痕)。
        """
        self._color_info = None
        self._color_tmp = None
        self._color_plan = None
        self._color_filters = None
        parts = list(parts)
        if len(parts) < 2:
            return parts
        try:
            color_level, flatten = color_align.resolve_config(
                _H3_CONFIG.get("color"))
        except ValueError as e:
            print("[H3Batch] 色彩对齐配置非法, 跳过预处理: %s" % e, flush=True)
            return parts
        if color_level == "off" and not flatten:
            return parts
        try:
            plan, info = color_align.probe_and_plan(
                parts, color_level=color_level, flatten=flatten,
                ffmpeg_exe=_ffmpeg_exe(), ffprobe_exe=_ffprobe_exe())
        except (color_align.ColorAlignError, join_engine.JoinError,
                OSError, ValueError) as e:
            print("[H3Batch] 色彩对齐探测失败·已跳过对齐继续拼接 (%s): %s"
                  % (type(e).__name__, e), flush=True)
            self._color_info = {"mode": color_level, "flatten": flatten,
                                "segments": len(parts), "per_seg_adjust": [],
                                "degraded": "%s: %s" % (type(e).__name__, e)}
            return parts
        self._color_plan = plan
        filters = [item["filter"] for item in plan]
        if any(filters):
            self._color_filters = filters
        for item in plan:                       # clamp 超限如实打 (纯函数登记)
            clamped = item["adjust"].get("clamped") if item["adjust"] else None
            if clamped:
                print("[H3Batch] 色彩对齐 clamp: 段 %d 映射量超 ±%g 已钳制 (%s)"
                      % (item["index"], color_align.LUT_CLAMP,
                         "/".join(clamped)), flush=True)
        adjusted = sum(1 for s in info["per_seg_adjust"] if s["adjusted"])
        hint = " (>=5 段, 建议 flatten 增益归一保持开启)" \
            if info.get("flatten_hint") else ""
        print("[H3Batch] 色彩对齐: mode=%s flatten=%s%s — 调整 %d/%d 段 (滤镜入链)"
              % (info["mode"], "on" if info["flatten"] else "off", hint,
                 adjusted, info["segments"]), flush=True)
        self._color_info = info
        return parts

    def _write_color_manifest(self, manifest):
        """V1.9 批 3 T3.5: S2 色彩对齐批级留痕 — manifest._color =
        {mode, flatten, per_seg_adjust, ...} (全关无痕, 与 V1.8 一致)。"""
        if getattr(self, "_color_info", None):
            manifest["_color"] = self._color_info

    def _write_review_manifest(self, manifest):
        """V1.9 批 3 T3.7: S5 审片报告补列批级留痕 — manifest._review =
        {segments(衔接方式/色彩偏差/链长), chain_hints, color_alarms}。
        链长提示/色彩报警同步控制台 (黄条的引擎侧形态); 生成失败只打日志,
        不影响产物 (报告是留痕增强, 不是批流程环节)。"""
        try:
            review = build_review_report(manifest)
            manifest["_review"] = review
            for sid in review["color_alarms"]:
                print("[H3Batch] 审片色彩报警: %s (相对首段偏差超 5%% 阈值)" % sid,
                      flush=True)
            for hint in review["chain_hints"]:
                print("[H3Batch] 审片链长提示: %s" % hint, flush=True)
        except Exception as e:
            print("[H3Batch] 审片报告生成失败(不影响产物): %s" % e, flush=True)

    def _concat_videos(self, parts, out_mp4, crossfade_frames=None):
        """1.14b U3 Y3: crossfade_frames 可选覆盖参数 — 不传走 cfg 基值, 传则用调用方值
        (后处理含插帧时×2, 含放大但无插帧时×1)."""
        """拼接 parts → out_mp4。失败时返回 (False, err), err 含 returncode/截断 stderr
        或 OSError/TimeoutExpired 异常串 — 让 run() 写到 manifest._concat.error,
        前端 / 用户能看到失败原因(而非静默丢控制台日志)。

        V1.11 批 4 T2: 拼接入口尺寸一致性检测 (兜底). 逐段 probe 宽高 —
        不一致 → 返回 (False, "size_mismatch: s01:WxH,s02:WxH,..."), 三处收尾
        点识别该前缀转 manifest._concat.skipped (避免拼出 0 字节空片 + 账本留痕).
        probe 异常/无 ffprobe → 跳过预检 + 照常拼 (test_ffmpeg_fallback.py:88
        降级先例). 空产物清理: 所有 return False 路径删 0 字节空产物 (非空保留供排查).

        V1.9 批 3 T3.4: 拼接合成升级 — join_engine 转场+响度+编码策略。默认
        crossfade 4 帧 + loudnorm 开 → 重编码 (首段 ffprobe 探测 fps/采样率/分辨率,
        pix_fmt yuv422p ≥4:2:2 / crf18 / preset medium / aac 192k); 全关退路
        (h3_config.json "join" 块: join_mode=hard_cut + loudnorm=false +
        explicit_stream_copy=true) → 与 V1.8 逐字节一致的 -f concat -c copy 流复制
        (金标准回归路径)。配置/探测/构造任何异常一律降级回 V1.8 流复制 (拼接永远
        能出片) + 日志明示。
        V1.9 批 3 T3.5: join 前先 S2 色彩对齐逐段预处理 (_prealign_colors,
        color_level=off|mvgd|scene 默认 scene + flatten 增益归一默认开, h3_config
        "color" 块); 暂存段随拼接收尾 finally 清理。
        V1.10 批 1 T1: 音画对齐 match_tail (h3_config "join" 块 match_tail /
        match_tail_tolerance_ms; 默认 match_tail=True / 容差 5ms).
        V1.10 批 1 T2: hard_cut 缝点 declick + silence_fade 安静判定 (h3_config
        "join" 块 declick/declick_ms/silence_fade/silence_fade_seconds/
        silence_threshold_db/silence_probe_seconds; 默认 declick=False + 留 cfg
        declick_ms 兜底 12 (A/B 定稿); silence_fade 默认 True 即默认做安静判定).
        V1.10 批 1 T3: BGM 通道 (D1) — 引擎读 self._bgm_path / self._bgm_mix_mode;
        bgm_active=True → 文件存在/可读预检 (bgm_missing / bgm_unreadable), 探
        测后传入 compose_join; JoinError 降级链禁用 (降级流复制会丢 BGM), 错误
        经现有通道落 manifest._concat.error.
        批 4 T1 D: 色彩对齐滤镜入链 — _prealign_colors 只算参数, 逐段滤镜注入
        compose_join (force_filter=True 照 BGM 禁流复制先例); 对齐激活 +
        compose_join 异常 → 回退暂存重编码 (同套参数) + 不带滤镜常规 join,
        不落流复制 (v3 P1 修复: 流复制拼的是未对齐原件), 回退事实写日志.
        V1.7 R13 收紧拼接上限 (600s→180s, 长时间卡死用户干等无意义); 批1 E8 放宽
        180s→300s (长片/慢盘拼接 180s 误杀 → TimeoutExpired 判失败)。
        返回 (bool, str): 成功 (True, ""), 失败 (False, err_detail)。"""
        parts = self._prealign_colors(parts)
        # V1.11 批 4 T2: 拼接前尺寸一致性检测 (兜底). probe 异常 → 跳过预检
        # (沿用 test_ffmpeg_fallback.py:88 降级先例, 无 ffprobe 机器不阻断拼接).
        if len(parts) >= 2:
            try:
                sizes = []
                for p in parts:
                    info = join_engine.probe_segment(p, ffprobe_exe=_ffprobe_exe())
                    w, h = info.get("width"), info.get("height")
                    sid = os.path.splitext(os.path.basename(p))[0]
                    if w is None or h is None:
                        raise join_engine.JoinError("段无 width/height: %s" % p)
                    sizes.append((sid, int(w), int(h)))
                distinct = {(w, h) for _, w, h in sizes}
                if len(distinct) > 1:
                    err = "size_mismatch: " + ",".join(
                        "%s:%dx%d" % (s, w, h) for s, w, h in sizes)
                    print("[H3Batch] 拼接尺寸不一致, 跳过拼接 (%s): %s"
                          % (out_mp4, err), flush=True)
                    return False, err
            except (join_engine.JoinError, OSError, ValueError) as e:
                print("[H3Batch] 尺寸预检跳过 (%s): %s"
                      % (type(e).__name__, e), flush=True)
        # V1.11 批 1 T3 门审真机 P0: lst 落点跟随 run_dir (拼接用完即删的临时件, 不该污染 output 根 —
        # 老板裁决根目录只留时间戳文件夹). 所有调用点 (run / _rebuild_concat / rerun_shot_in_folder /
        # _rerun_finalize) 调用前都已 set self.run_dir; 兜底回 output_dir 防 None.
        _lst_dir = getattr(self, "run_dir", None) or self.output_dir
        lst = os.path.join(_lst_dir, "_concat_list.txt")

        def _write_lst(items):
            with open(lst, "w", encoding="utf-8") as f:
                for p in items:
                    f.write("file '%s'\n" % p.replace("'", "'\\''"))

        _write_lst(parts)
        # T3 BGM 通道读取 + 预检 (D1): 文件不存在 / 不可读 → 硬失败不降级.
        bgm_path = getattr(self, "_bgm_path", "") or ""
        bgm_mix_mode = (getattr(self, "_bgm_mix_mode", "replace") or "replace")
        bgm_active = bool(bgm_path)
        bgm_sample_rate = None
        if bgm_active:
            if not os.path.isfile(bgm_path):
                err = "bgm_missing: %s" % bgm_path
                print("[H3Batch] BGM 预检失败 (%s): %s" % (out_mp4, err), flush=True)
                return False, err
            try:
                bgm_sample_rate = join_engine.probe_audio_sample_rate(
                    bgm_path, ffprobe_exe=_ffprobe_exe())
            except (join_engine.JoinError, OSError,
                    subprocess.TimeoutExpired) as e:
                err = "bgm_unreadable: %s" % bgm_path
                print("[H3Batch] BGM 预检失败 (%s): %s" % (out_mp4, e), flush=True)
                return False, err

        def _make_composer():
            """join cfg 解析 + compose_join 封装 (批 4 T1: 色彩滤镜入链一并注入).
            降级链可重复解析 — cfg 非法时每次都 raise (由调用方定失败语义)."""
            cfg = _H3_CONFIG.get("join")
            cfg = cfg if isinstance(cfg, dict) else {}
            join_mode = str(cfg.get("join_mode") or join_engine.DEFAULT_JOIN_MODE)
            loudnorm = bool(cfg.get("loudnorm", join_engine.DEFAULT_LOUDNORM))
            explicit = bool(cfg.get("explicit_stream_copy", False))
            frames = (int(crossfade_frames) if crossfade_frames is not None
                      else int(cfg.get("crossfade_frames")
                               or join_engine.DEFAULT_CROSSFADE_FRAMES))
            match_tail = bool(cfg.get("match_tail", True))
            match_tail_tol_ms = int(cfg.get("match_tail_tolerance_ms", 5))
            # T2 缝点开关: declick 布尔 + declick_ms 数值; silence_fade 5 项.
            # V1.10 批 1 收尾 A/B 定稿: 12ms (41 号对照先例; 真机 12/15ms 缝点
            # RMS 阶跃客观等效, 台账留数) — h3_config join.declick_ms 可覆盖.
            cfg_declick_on = bool(cfg.get("declick", False))
            cfg_declick_ms = cfg.get("declick_ms", 12)
            declick_ms = int(cfg_declick_ms) if cfg_declick_on else None
            silence_fade = bool(cfg.get(
                "silence_fade", join_engine.DEFAULT_SILENCE_FADE))
            silence_fade_seconds = float(cfg.get(
                "silence_fade_seconds",
                join_engine.DEFAULT_SILENCE_FADE_SECONDS))
            silence_threshold_db = float(cfg.get(
                "silence_threshold_db",
                join_engine.DEFAULT_SILENCE_THRESHOLD_DB))
            silence_probe_seconds = float(cfg.get(
                "silence_probe_seconds",
                join_engine.DEFAULT_SILENCE_PROBE_SECONDS))
            # T3: bgm_side_volume 从 cfg 读, 缺省 0.5.
            bgm_side_volume = float(cfg.get(
                "bgm_side_volume",
                join_engine.DEFAULT_BGM_SIDE_VOLUME))

            def _compose(join_parts, color_on):
                return join_engine.compose_join(
                    join_parts, out_mp4, join_mode=join_mode, loudnorm=loudnorm,
                    explicit_stream_copy=explicit, crossfade_frames=frames,
                    ffmpeg_exe=_ffmpeg_exe(), ffprobe_exe=_ffprobe_exe(),
                    stream_copy_listfile=lst,
                    match_tail=match_tail,
                    match_tail_tolerance_ms=match_tail_tol_ms,
                    declick_ms=declick_ms, silence_fade=silence_fade,
                    silence_fade_seconds=silence_fade_seconds,
                    silence_threshold_db=silence_threshold_db,
                    silence_probe_seconds=silence_probe_seconds,
                    bgm_path=bgm_path, bgm_mix_mode=bgm_mix_mode,
                    bgm_sample_rate=bgm_sample_rate,
                    bgm_side_volume=bgm_side_volume,
                    # 批 4 T1: 对齐激活 → 滤镜入链 + 强制滤镜链 (禁流复制)
                    force_filter=color_on,
                    seg_filters=(getattr(self, "_color_filters", None)
                                 if color_on else None))

            return join_mode, _compose

        try:
            try:
                color_active = bool(getattr(self, "_color_filters", None))
                join_mode, _compose = _make_composer()
                spec = _compose(parts, color_active)
                cmd = spec["command"]
                mode = spec["mode"]
            except (join_engine.JoinError, ValueError, TypeError, KeyError,
                    OSError) as e:
                if bgm_active:
                    # T3: BGM 启用时, 配置非法/探测失败 → 不降级流复制, 透传
                    # 错误经现有拼接失败通道落 manifest._concat.error.
                    err = "ffmpeg/bgm %s: %s" % (type(e).__name__, e)
                    print("[H3Batch] 拼接失败 (BGM 启用, 禁止降级): %s" % err,
                          flush=True)
                    return False, err
                if color_active:
                    # 批 4 T1 D (v3 P1 修复): 色彩对齐激活 → 不降流复制 (拼的是
                    # 未对齐原件); 回退暂存重编码 (同一套参数, 首段基准统计已有)
                    # + 不带滤镜常规 join; 回退事实写日志; 暂存随 finally 清理.
                    print("[H3Batch] 拼接合成失败, 色彩对齐激活 → "
                          "回退暂存重编码 (%s): %s" % (type(e).__name__, e),
                          flush=True)
                    try:
                        tmp = os.path.join(self.output_dir, "_color_align")
                        parts, _ = color_align.recode_segments(
                            parts, self._color_plan, tmp, self._color_info,
                            ffmpeg_exe=_ffmpeg_exe())
                        self._color_tmp = tmp
                        _write_lst(parts)
                    except (color_align.ColorAlignError, OSError,
                            ValueError) as e2:
                        err = "ffmpeg/color-fallback %s: %s" \
                            % (type(e2).__name__, e2)
                        print("[H3Batch] 拼接失败 (%s): %s"
                              % (out_mp4, err), flush=True)
                        return False, err
                    try:
                        join_mode, _compose = _make_composer()
                        spec = _compose(parts, False)
                        cmd = spec["command"]
                        mode = spec["mode"]
                    except (join_engine.JoinError, ValueError, TypeError,
                            KeyError, OSError) as e2:
                        err = "ffmpeg/color-fallback %s: %s" \
                            % (type(e2).__name__, e2)
                        print("[H3Batch] 拼接失败 (%s): %s"
                              % (out_mp4, err), flush=True)
                        return False, err
                else:
                    # T1/T2 既有降级链: 配置非法/ffprobe 探测失败/参数缺失 → V1.8 流
                    # 复制退路 (BGM 关, 拼接永远能出片 + 日志明示).
                    print("[H3Batch] 拼接合成降级为流复制 (%s): %s"
                          % (type(e).__name__, e), flush=True)
                    cmd = [_ffmpeg_exe(), "-y", "-f", "concat", "-safe", "0", "-i", lst,
                           "-c", "copy", out_mp4]
                    mode = "stream_copy"
                    cfg_j = _H3_CONFIG.get("join")
                    join_mode = str(
                        (cfg_j.get("join_mode") if isinstance(cfg_j, dict) else None)
                        or join_engine.DEFAULT_JOIN_MODE)
            print("[H3Batch] 拼接合成模式: %s (%s)" % (mode, join_mode), flush=True)
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            except (OSError, subprocess.TimeoutExpired) as e:
                err = "ffmpeg %s 异常: %s" % (type(e).__name__, e)
                print("[H3Batch] 拼接失败 (%s): %s" % (out_mp4, err), flush=True)
                return False, err
            if proc.returncode != 0 or not os.path.exists(out_mp4):
                stderr_tail = (proc.stderr or "")[-300:]
                err = "ffmpeg returncode=%d stderr=%s" % (proc.returncode, stderr_tail)
                print("[H3Batch] 拼接失败 (%s): %s" % (out_mp4, err), flush=True)
                return False, err
            return True, ""
        finally:
            if getattr(self, "_color_tmp", None):
                shutil.rmtree(self._color_tmp, ignore_errors=True)
            # V1.11 批 4 T2: 空产物清理 — exists 且 size==0 时删 (非空保留供排查).
            _cleanup_empty_output(out_mp4)
            # V1.11 批 1 T3 门审真机 P0 第四轮: _concat_list.txt 拼接完 (无论成败) 清理 —
            # 上一轮把 lst 挪进 run_dir 后未清理, 真机 folder 内残留 _concat_list.txt 污染根目录.
            # 兜底 (OSError 不抛, 不影响主流程返回).
            try:
                os.remove(lst)
            except OSError:
                pass
                self._color_tmp = None

    # ---------------- 执行 ----------------
    def _prune_orphans(self, prompt):
        # F2 (T-B R4): 出参根集合与 postfx 口径统一 — 收尾节点判定复用 postfx 单一判定
        # (SaveVideo/VideoCombine 族/自定义 Save*); 旧实现只认精确 SaveVideo → 非
        # SaveVideo 收尾模板 keep 集空, 提交空 prompt {} (无告警). 局部 import 沿本文件
        # 既有风格 (postfx_engine 不 import batch_core, 无环).
        import postfx_engine
        keep = set()
        for nid, node in prompt.items():
            if postfx_engine._is_save_video(node.get("class_type") or ""):
                keep.add(nid)
        changed = True
        while changed:
            new = set()
            for nid in keep:
                for v in prompt[nid]["inputs"].values():
                    if isinstance(v, list) and len(v) == 2:
                        new.add(str(v[0]))
            before = len(keep)
            # K6: 悬空引用不入 keep (同 _invariant_keep_set 口径) — 旧实现并集后下一轮
            # 访问 prompt[nid] 抛 KeyError, 段 failed
            keep |= {n for n in new if n in prompt}
            changed = len(keep) > before
        return {nid: node for nid, node in prompt.items() if nid in keep}

    def _archived_manifest_via_pointer(self):
        """批1 E2 (#51 接力回找): manifest_path 所在目录 (构造期 = run_subdir 锚定的
        原批位置; _new_run_dir 后 = 复用的 run_dir 壳) 存在 .h3_archived 指针 → 沿
        dest 找本 stem 的归档 manifest 并返回其路径; 任一环不成立返回 None (调用方
        回退常态解析)。dest 内多命中取 mtime 最新, 边界过滤同 resolve_manifest_path。
        """
        mp = getattr(self, "manifest_path", None)
        if not mp:
            return None
        ptr = os.path.join(os.path.dirname(mp), _ARCHIVED_POINTER_NAME)
        if not os.path.isfile(ptr):
            return None
        try:
            with open(ptr, encoding="utf-8") as f:
                dest = f.readline().strip()
        except OSError:
            return None
        if not dest or not os.path.isdir(dest):
            return None
        stem = os.path.splitext(os.path.basename(self.csv_path))[0]
        hits = _manifest_boundary_hits(
            [p for p in glob.glob(os.path.join(dest, "h3_batch_manifest_%s*.json" % stem))
             if os.path.isfile(p)], stem)
        if not hits:
            return None
        hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        return hits[0]

    def _load_manifest(self):
        # V1.11 批 1 T2b: resume 双位置解析 — 优先 self.manifest_path (run 后已更新到
        # run_dir; 归档后跟到 archive_dir), 找不到再走 resolve_manifest_path 双位置回退
        # (构造时 manifest_path 还在 output_dir, 历史批可能在 run_dir 子文件夹内).
        mp = getattr(self, "manifest_path", None)
        if mp and os.path.exists(mp):
            try:
                return json.load(open(mp, encoding="utf-8"))
            except Exception:
                pass
        # 批1 E2 (#51 接力回找·口径 a): 原批已走归档端点 → 原位置只剩指针壳, 沿指针
        # 加载归档夹 manifest 作内存初始态 (只读 — 写回仍落 self.manifest_path 新位置,
        # 归档快照不覆写)。指针命中先于 glob/mtime 抽签: 同 stem 干扰物在场时确定取
        # 本批归档账本; 指针缺失/失效静默落回下方既有路径, 无指针场景字节级零变化。
        archived_mp = self._archived_manifest_via_pointer()
        if archived_mp:
            try:
                return json.load(open(archived_mp, encoding="utf-8"))
            except Exception:
                pass
        stem = os.path.splitext(os.path.basename(self.csv_path))[0]
        resolved = resolve_manifest_path(stem, self.output_dir)
        if resolved and os.path.exists(resolved):
            try:
                return json.load(open(resolved, encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _manifest_mark_dirty(self, sid):
        """V1.11 批 1 T1: 把 sid 加入本次运行的脏集合 (新构造段 dict 首盘保护).

        兜底: __new__ 桩测可能缺 _manifest_dirty_sids; 自动初始化.
        """
        ds = self.__dict__.get("_manifest_dirty_sids")
        if not isinstance(ds, set):
            ds = set()
            self._manifest_dirty_sids = ds
        ds.add(sid)

    def _manifest_resources_meta_direct(self):
        """V1.9 批 2: manifest 资源编排配置快照 (run 开始写入; 直测入口).

        V1.13 D25: 增 _resources_raw / _overrides_raw / _lora_overrides_raw 三键 —
        解析产物丢 strength_clip/order/category 等字段, 重跑仅靠解析产物无法逐字节
        复现 ⇒ 存 widget 原串供重跑端点回灌 (有损摘要键保留不动, 后向兼容旧 manifest).

        V1.13f: 增 _subject_anchors 键 — 仅非空才写 (缺省/空字符串 = 旧任务零回归);
        rerun 收尾 manifest.update 合并天然保留 (测试 6 锁死).
        """
        resources = getattr(self, "_resources", None) or []   # 旧式构造(测试/迁移)可能无此属性
        overrides = getattr(self, "_overrides", None) or {}
        meta = {
            "_resources": [
                {"name": e.get("name"), "strength_model": e.get("strength_model")}
                for e in resources if e and e.get("source") != "template"],
            "_overrides": dict(overrides),
            # D25: 3 raw 键 — 重跑端点原串回灌 (manifest 不存在此键 → 旧式构造, 不影响)
            "_resources_raw": getattr(self, "_resources_raw", "") or "",
            "_overrides_raw": getattr(self, "_overrides_raw", "{}") or "{}",
            "_lora_overrides_raw": getattr(self, "_lora_overrides_raw", "{}") or "{}",
        }
        # 1.13f: subject_anchors 仅非空才写键 (旧式构造/缺省 = 不写 → 旧 manifest 零变)
        _sa = getattr(self, "_subject_anchors", None)
        if isinstance(_sa, str) and _sa.strip():
            meta["_subject_anchors"] = _sa
        # 批 K: 段级素材池 raw 键 (rerun 族回灌用; 原始提交值, 非 _config 旁车)。
        # 仅非空才写 — 老任务 manifest 逐字节零变, rerun 端点无键即不回灌。
        _sp = getattr(self, "_seg_pools", None)
        if isinstance(_sp, dict) and _sp:
            meta["_seg_pools_raw"] = _sp
        return meta

    def _manifest_report_inject_direct(self):
        """V1.9 批 2: 注入报告摘要 (收尾写入; 直测入口)."""
        return getattr(self, "_inject_report", None) or {}

    def _manifest_report_override_direct(self):
        """V1.9 批 2: 覆写报告摘要, 含类型拦截/错配警告 (收尾写入; 直测入口)."""
        return getattr(self, "_override_report", None) or {}

    def _manifest_report_adapter_direct(self):
        """1.14 P6: AdapterPlan 报告 (T-B 预案⑥ :42 "AdapterPlan 落 manifest 参与重跑指纹").

        结构 {"inject": P4 注入报告, "invariant": P5 不变量报告, "fingerprint": 重跑指纹}.
        指纹 = _compute_inject_fingerprint(实际注入集 + 覆写, adapter_plan=<稳定事实投影>):
        只收同批重跑可复现的字段 (injected/reason/anchor/节点数/candidates 数/不变量编号);
        nodes 是每次注入新分配的 run-local id, 入指纹会把同批重跑误判成编排变化, 故以节点数
        代理. 旧 manifest 无报告键 → 该维度不参与 (adapter_plan=None) → 旧指纹逐字节不变.
        两份报告皆空 (旧式构造/未跑 convert) → {} (调用方不写键, 旧 manifest 零变).
        """
        inj = self._manifest_report_inject_direct()
        inv = getattr(self, "_invariant_report", None) or {}
        if not inj and not inv:
            return {}
        # 实际注入集 — 与 _inject_loras 指纹同口径 (模板自带源由注入层过滤)
        injectable = _sort_injectable_for_chain(
            [e for e in (getattr(self, "_resources", None) or [])
             if e and e.get("source") != "template"])
        plan = {
            "injected": bool(inj.get("injected")),
            "reason": str(inj.get("reason") or ""),
            "anchor": str(inj.get("anchor") or ""),
            "nodes": len(inj.get("nodes") or []),
            "candidates": len(inj.get("candidates") or []),
            "policy": str(inv.get("policy") or ""),
            "violations": [str(v.get("invariant") or "")
                           for v in (inv.get("violations") or [])],
        }
        return {
            "inject": inj,
            "invariant": inv,
            "fingerprint": _compute_inject_fingerprint(
                injectable, overrides=getattr(self, "_overrides", None),
                lora_overrides=getattr(self, "_lora_overrides", None),
                adapter_plan=plan),
        }

    def _write_adapter_report_manifest(self, manifest):
        """1.14 P6: AdapterPlan 报告写入 manifest; 空报告 (旧式构造) → 不写键 (旧 manifest 零变)."""
        rep = self._manifest_report_adapter_direct()
        if rep:
            manifest["_adapter_report"] = rep

    def _save_manifest(self, manifest):
        """V1.11 批 1 T1: 原子化 + reload+merge (S1 裁决竞态修复核心).

        锁内: reload 磁盘 → 合并"外部可写键" → 注入 _schema → 原子落盘 → 清脏.
        合并规则 (钉死):
          - 顶层 _note: 磁盘恒胜 (引擎不写 _note, 保留未来 note 端点写入).
          - 段 review: 脏 sid 不采纳磁盘 review (保护"新段首次写盘"避免旧 void 复活);
            非脏 sid 磁盘 review 为 approved/void (终态) 时采纳磁盘值.
          - 脏 sid: 引擎本次运行新构造段 dict 的 sid; 首盘后从集合移除.
        """
        mp = self.manifest_path
        abs_mp = os.path.abspath(mp)
        os.makedirs(self.output_dir, exist_ok=True)
        lock = _manifest_lock(abs_mp)
        dirty = getattr(self, "_manifest_dirty_sids", None)
        if not isinstance(dirty, set):
            dirty = set()
            self._manifest_dirty_sids = dirty
        # B3-D3: 失败分支不清 dirty — 脏 sid 保留供下次 save 重试,
        # 否则 save 失败 + 脏集被清 → 下次 save 走"非脏 sid 采纳磁盘 approved/void"
        # → 新 take 的 pending 被旧 take 的 approved/void 覆盖, 违反"新 take 恒 pending".
        with lock:
            disk, _deg = read_manifest_safe(abs_mp)
            if isinstance(disk, dict):
                # _note: 磁盘恒胜
                if "_note" in disk:
                    manifest["_note"] = disk["_note"]
                # V1.11 交付前 BE-P2-2: 合并白名单扩 _reruns/_concat_history —
                # 端点 ledger 写入 (跨进程 MCP / 端点并发) 不被引擎 save 抹掉.
                # 引擎 run() 主循环从不写这两键 (账本由端点/手动拼接锁内 _manifest_write 写入),
                # 采纳磁盘 = 不丢账本. 引擎侧确要写时 (如未来加), 改为"长度长者胜"再汇报.
                for _k in ("_reruns", "_concat_history"):
                    if _k in disk and disk[_k] is not None and _k not in manifest:
                        manifest[_k] = disk[_k]
                # 段 review: 非脏 sid 采纳磁盘终态
                for sid, dseg in list(disk.items()):
                    if sid in _RESERVED_KEYS or sid in dirty:
                        continue
                    if not isinstance(dseg, dict):
                        continue
                    drev = dseg.get("review")
                    if drev in ("approved", "void"):
                        mseg = manifest.get(sid)
                        if isinstance(mseg, dict):
                            mseg["review"] = drev
                        else:
                            manifest[sid] = {"status": dseg.get("status", "success"),
                                             "review": drev}
            manifest["_schema"] = _MANIFEST_SCHEMA_VERSION
            # V1.11 批 1 T2: history 端点识别字段 — 每次 save 从引擎内存写
            # (沿用 self.mode/self.csv_path, 不读磁盘, 避免历史批混窜).
            # getattr 兜底: T1 测试桩引擎绕过 __init__ 时无 mode/csv_path 属性.
            manifest["_mode"] = getattr(self, "mode", "") or ""
            manifest["_csv_path"] = getattr(self, "csv_path", "") or ""
            # V1.11 批 3 T1: 同 seed 重跑差异检测基线 — run() 首次落盘前由
            # self._res_summary 注入; 重跑期间不重写 (避免同一任务内 _res_summary 漂移).
            _rs = getattr(self, "_res_summary", None)
            if isinstance(_rs, dict):
                manifest["_res_summary"] = _rs
            # V1.11 批 3 T2: 旁车配置快照 — self.csv_path 同目录 <csv名>.h3cfg.json
            # 存在则 load 注入 manifest._config; 缺失跳过不报错 (手填 CSV 场景).
            # 仅首次落盘 (disk 尚无 _config) 走旁车; 之后 disk 合并守门会保留
            # 已注入值, 旁车不再被重读.
            if not isinstance(disk, dict) or "_config" not in disk:
                _sc = _load_sidecar_config(getattr(self, "csv_path", ""))
                if isinstance(_sc, dict):
                    manifest["_config"] = _sc
            # tmp 文件用唯一后缀防并发 save 撞名 (同一 lock 串行化但跨 path 仍可能冲突)
            tmp = "%s.tmp.%d.%s" % (abs_mp, os.getpid(),
                                    uuid.uuid4().hex[:8])
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            # Windows 上 reader 持有目标文件句柄时 os.replace 会 PermissionError;
            # 短退避重试 (100×5ms≈0.5s 窗口), 读方很快释放. 耗尽时重抛最后一次 PermissionError,
            # 严禁裸 raise (无 active exception → RuntimeError 掩盖真实故障).
            _replaced = False
            _last_err = None
            for _attempt in range(100):
                try:
                    os.replace(tmp, abs_mp)
                    _replaced = True
                    break
                except PermissionError as _e:
                    _last_err = _e
                    time.sleep(0.005)
            if not _replaced:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise _last_err if _last_err is not None else RuntimeError(
                    "manifest 原子替换耗尽 (无 PermissionError 留痕)")
            dirty.clear()

    def _wait_shot(self, pid, timeout=3600):
        # T5: cancel 命中 self._stop 不再"立即弃等"——继续轮询当前 pid 至完成/timeout,
        # 当前段跑完收尾, 不产生孤儿任务/重复提交 (F4 段归属契约)。
        # execution_interrupted (ComfyUI 主界面用户取消) 仍立即返, 让 _run_one 走中断链路。
        # V1.11 fix2: 检到 execution_interrupted 后**此处就**置 self._stop, 引擎快速退场
        # 释放 _active (不再等 _run_one caller 反应), 区分于引擎自身 execution_error
        # (后者走既有重试链路, 不触发全局停止)。
        # V1.11 批5.0b: cancel 触发 self._stop 后立即 POST /interrupt (同 pid 幂等),
        # 让 ComfyUI 中断当前 prompt 写入 execution_interrupted, ≤2s 内该段 history 可读到,
        # _wait_shot 返 "interrupted", _run_one 返 (False, [], "用户中断") → run() 落库 stopped.
        _interrupted_sent = getattr(self, "_interrupt_sent", None)
        if _interrupted_sent is None:
            _interrupted_sent = set()
            self._interrupt_sent = _interrupted_sent
        t0 = time.time()
        # V1.13b: queue+history 双查皆空连续轮次计数 (局部: 每 pid 调用独立, 不跨段泄漏)
        _dropped = 0
        while time.time() - t0 < timeout:
            # 批5.0b热修2b: 0.5s 分段等待 — cancel 置位后 ≤0.5s 醒发 /interrupt (止损时延;
            # 真机实锤 sleep(10) 睡满才醒 → cancel→stopped 14s)。保留 time.sleep 原语:
            # Event.wait 不吃既有测试的 sleep mock, 全量终验 3 failed 根因
            for _ in range(20):
                if self._stop.is_set():
                    break
                time.sleep(0.5)
            # 批5.0b: _stop 命中 → POST /interrupt 一次 (幂等: 同 pid 仅一次)
            if self._stop.is_set() and pid not in _interrupted_sent:
                try:
                    self._post("/interrupt", {})
                except Exception:
                    # /interrupt 失败兜底: 让 ComfyUI 自然跑完, _wait_shot 仍能命中 history
                    pass
                _interrupted_sent.add(pid)
            q = self._get("/queue")
            running = [str(x[1]) for x in q.get("queue_running", [])]
            pending = [str(x[1]) for x in q.get("queue_pending", [])]
            if pid in running or pid in pending:
                _dropped = 0  # 在队列=活着, 重置连续计数
                continue
            h = self._get("/history/" + pid)
            if pid in h:
                self._last_output_item = h[pid]
                # ComfyUI 用户取消会落 execution_interrupted 到 messages 但 status_str 仍是 'error',
                # 不区分会被 _run_one 当真错误重试再跑下一段, 后台线程活着锁住后续 start()
                msgs = h[pid].get("status", {}).get("messages") or []
                if any(isinstance(m, (list, tuple)) and m and m[0] == "execution_interrupted" for m in msgs):
                    # 主动中断 (≠ 引擎自身 execution_error): 直接置 _stop (快速退场)
                    try:
                        self._stop.set()
                    except Exception:
                        pass
                    return "interrupted", []
                return h[pid].get("status", {}).get("status_str"), self._collect_files(h[pid])
            # V1.13b: queue+history 双查皆空 ⇒ prompt 已被丢弃 (加载/排队期点 X:
            # ComfyUI 丢弃且不写 history — 第四种中断时机; 连续 3 轮 ≈30s+ 判定, 防提交→入队间隙误杀)。
            _dropped += 1
            if _dropped >= 3:
                print("[H3Batch] %s 提交后 %ds 内 queue+history 连续 %d 轮皆空, "
                      "判 prompt 已被丢弃(加载期中断), 快速退场"
                      % (pid, int(time.time() - t0), _dropped), flush=True)
                try:
                    self._stop.set()
                except Exception:
                    pass
                return "interrupted", []
        return "timeout", []

    def _last_execution_error(self):
        """V1.9 T4.5 D1: 从 _wait_shot 存下的本段 history 条目提取 execution_error。

        返回 (exception_type, exception_message) 字符串二元组; 无条目/无消息 → None。
        仅在 _wait_shot 找到本段 history 后调用 (status='error' 时条目必新鲜: 每 attempt
        一个新 prompt_id, timeout 路径不落条目, 调用方按 status 门控防读到陈旧值)。
        """
        item = getattr(self, "_last_output_item", None)
        if not isinstance(item, dict):
            return None
        for m in (item.get("status", {}) or {}).get("messages") or []:
            if (isinstance(m, (list, tuple)) and m and m[0] == "execution_error"
                    and len(m) > 1 and isinstance(m[1], dict)):
                return (str(m[1].get("exception_type") or ""),
                        str(m[1].get("exception_message") or ""))
        return None

    def _last_execution_error_detail(self):
        """R-34: 从 _wait_shot 存下的本段 history 条目提取节点级报错详情。

        返回 {"node_id","node_type","exception_type","exception_message"} 四键 dict
        (exception_message 在此单点截断 1000 字符, 防 manifest 膨胀; traceback /
        current_inputs 不落); 无条目/无消息 → None。与 _last_execution_error
        (二元组·重试决策消费者) 并行互不影响。调用方须按 err=="status=error" 门控
        (timeout/interrupted 路径不换条目, 乱读会拿到上一段陈旧值)。
        """
        item = getattr(self, "_last_output_item", None)
        if not isinstance(item, dict):
            return None
        for m in (item.get("status", {}) or {}).get("messages") or []:
            if (isinstance(m, (list, tuple)) and m and m[0] == "execution_error"
                    and len(m) > 1 and isinstance(m[1], dict)):
                d = m[1]
                return {
                    "node_id": str(d.get("node_id") or ""),
                    "node_type": str(d.get("node_type") or ""),
                    "exception_type": str(d.get("exception_type") or ""),
                    "exception_message": str(d.get("exception_message") or "")[:1000],
                }
        return None

    def _collect_files(self, item):
        # 批 K-F2: 只收**输出型节点**的 outputs 登记名 —— H3 族 LoadVideo 会把加载的
        # 源文件名登记进 outputs(images key·真机 20261008_013116 s11 实证: LoadVideo
        # 登记 AIWarper_H3_demo_1280x720.mp4 而该文件不在任何输出根) → 旧实现全收
        # 把它当产物期望名 → D8 等满判段 missing_file → 后续段 blocked。
        # 输出型白名单 = class_type 以 "Save" 开头(SaveVideo/SaveImage/SaveAudio…)
        # 或 VHS_VideoCombine(视频汇)。graph 不可得(旧调用面/形态异常)时不过滤 =
        # 既有行为零回归(tests/test_1_14_kf2_collect_files_filter.py 四用例锁)。
        node_class = {}
        prompt = item.get("prompt")
        if isinstance(prompt, (list, tuple)) and len(prompt) > 2 and isinstance(prompt[2], dict):
            for nid, node in prompt[2].items():
                if isinstance(node, dict) and node.get("class_type"):
                    node_class[str(nid)] = str(node["class_type"])
        files = []
        for nid, o in item.get("outputs", {}).items():
            if node_class:
                cls = node_class.get(str(nid), "")
                if not (cls.startswith("Save") or cls == "VHS_VideoCombine"):
                    continue  # 消费型节点(Load*)的 outputs 登记名非产物
            for v in o.values():
                if isinstance(v, list):
                    for f in v:
                        if isinstance(f, dict) and f.get("filename"):
                            files.append(f["filename"])
        return files

    # V1.7 C1: 多角色预检 11 条 — 批级 Rule 5 + 逐镜 Rule 1-4/6-11
    # 消费 self._cast_plan 已扩展的诊断字段 (resolve_errs/assign_errs/parse_warns/
    # no_look_cards/cards); 文案逐字按 PRD §4.1 表; 镜号 {N} = rid.
    def _preflight_cast_batch_check(self, shots, errs, bindings=None):
        """Rule 5 (批 H1 修订): 池手动勾 subject_look (非绑定快照) +
        任一镜在场集含**未绑定**卡 → ERR; N=首个含未绑定卡的镜 rid, 只报一次
        旧表全部未绑定卡行为逐字不变; 绑定卡与手动 look 混镜不触发 ERR (C1)

        B6 局部注入 (B3-M2 必改): preflight 早于 _apply_global, self._cast_bindings
        恒空 → 必须由 preflight 解析 g["角色绑定"] 后显式注入才能命中 C1 混镜豁免.
        bindings=None 兜底读 self._cast_bindings (向后兼容 rerun/直调等非 preflight
        调用面, 那时 _cast_bindings 已被 _apply_global 填过). 不回填 self._cast_bindings
        — 时序不变, 全局状态保护."""
        cp = getattr(self, "_cast_plan", None)
        # 批 H1: 池手动勾 subject_look (排绑定快照注入 — _pool_usage 批级, 不含绑定副本)
        if not _any_usage(self._pool_usage, "subject_look"):
            return
        # 首个在场集含未绑定卡的镜 rid
        if bindings is None:
            bindings = getattr(self, "_cast_bindings", None) or []
        binding_lookup = {b.get("name") for b in bindings
                          if isinstance(b, dict) and isinstance(b.get("name"), str)}
        first_i = None
        for i, row in enumerate(shots or []):
            text = row.get("出场角色") if isinstance(row, dict) else None
            names, _ = parse_cast(text)
            # 档 1 (列优先)
            if names and any(n not in binding_lookup for n in names):
                first_i = i
                break
            # 档 2 (prompt 检测): 必须至少含未绑定卡
            if not names:
                # 列空, 走档 2 检查
                binding_here = (cp.get("binding_names_in_scene", {}) or {}).get(i, []) if cp else []
                unbound_here = (cp.get("unbound_names_in_scene", {}) or {}).get(i, []) if cp else []
                if unbound_here:
                    first_i = i
                    break
        if first_i is None:
            return
        rid = str((shots[first_i] or {}).get("ID") or "").strip() or ("第%d行" % (first_i + 1))
        # H2 编排授权: 触发可来自 prompt 名字检测, 提示补"prompt 中的角色名"
        errs.append("本批素材池已勾\"人物·外貌\"用途, 与镜%s出场角色（或 prompt 中的角色名）冲突: "
                    "两者请二选一（清掉池用途或清空角色列）" % rid)

    # 批 H1: 绑定专项预检 — 失联/失配/混镜手动 look 抑制/i2v-fl2v 绑定提示/全批空集信息条
    def _preflight_binding_check(self, shots, errs, warns, bindings=None):
        """绑定表专项 WARN 族; ERR 不在此处 (绑定表破坏不阻断跑批, J2)
        - 失联绑定 (WARN): 跑批按快照继续, 用户感知黄标
        - 失配 (WARN): slots 中某 idx 在池中已不存在
        - 混镜手动 subject_look 抑制 (WARN): C1 抑制 + 文案引导建卡分配
        - i2v/fl2v 模板族 + 绑定 (WARN): 当前模板族不注入角色定义块, 名字替换仍生效
        - 全批空集 (WARN 信息条): 存在绑定 + 全批名字为空
        bindings (T1): 局部绑定表 — preflight 早于 _apply_global 时 self._cast_bindings
          恒空, 调用方按 B6 双路口径显式传; None 回落 self (向后兼容直注入调用面)。
          不回填 self._cast_bindings。
        """
        bindings = bindings if bindings is not None else (getattr(self, "_cast_bindings", None) or [])
        if not bindings:
            return
        binding_lookup = {b.get("name"): b for b in bindings
                          if isinstance(b, dict) and isinstance(b.get("name"), str)}
        binding_set = set(binding_lookup.keys())
        cp = getattr(self, "_cast_plan", None)

        # 模板族判定 (i2v/fl2v → 抑制注入的预检层 + 信息条)
        if self.workflow_path:
            template_m = _template_mode(self.workflow_path)
            non_inject = template_m in ("i2v", "fl2v", "t2v", None)
            if non_inject:
                warns.append("当前模板族不注入角色定义块, 名字替换仍生效")

        # 失联 (WARN): 绑定表 name 不在资产库 / 不是 v3 character
        assets = self._load_assets_for_cast_plan() or {}
        for b in bindings:
            if not isinstance(b, dict):
                continue
            name = b.get("name")
            if not isinstance(name, str) or not name:
                continue
            card = assets.get(name)
            if not isinstance(card, dict):
                warns.append("绑定卡「%s」在资产库中不存在: 跑批按快照继续, "
                             "建议重新分配或重建卡" % name)
                continue
            if not (card.get("_v") == 3 and card.get("kind") == "character"):
                warns.append("绑定卡「%s」非 v3 角色卡: 跑批按快照继续, "
                             "建议替换为 v3 角色卡" % name)

        # 失配 (WARN): 绑定 slots idx 指向的快照与当前池槽现状比对
        # H2 小授权: 与素材池现状比对 (而非磁盘文件存在性) — 更直接判定
        # "快照所指的素材是否还留在池里"
        pool_now = (self._pool_usage or {}).get("Picture") or {}
        # 读池底真实文件 — 通过 _parse_pool 缓存到 self._pool_dict
        pool_dict = getattr(self, "_pool_dict", None)
        for b in bindings:
            if not isinstance(b, dict):
                continue
            name = b.get("name")
            slots = b.get("slots") or []
            if not isinstance(name, str) or not isinstance(slots, list):
                continue
            for s in slots:
                if not isinstance(s, dict):
                    continue
                idx = s.get("idx")
                snap_media = s.get("media") or ""
                if not isinstance(idx, int):
                    continue
                # 比对快照媒体 vs 池现状 idx=idx 媒体的差异 (字符串不等即失配)
                cur_media = pool_dict.get("Picture", {}).get(idx, "") if pool_dict else ""
                if cur_media and cur_media != snap_media:
                    warns.append("绑定卡「%s」槽 %d 与池现状失配 (快照: %s, 池: %s): "
                                 "已按快照继续注入, 建议重新分配"
                                 % (name, idx, snap_media or "<空>", cur_media))
                elif not cur_media and snap_media:
                    warns.append("绑定卡「%s」槽 %d 池槽已空 (快照原: %s): "
                                 "已按快照继续注入, 建议重新分配"
                                 % (name, idx, snap_media))

        # 混镜手动 subject_look 抑制 (C1 WARN): 列填绑定名 + 手动 subject_look 池底勾
        # 在场集含绑定卡时手动 look 仅接线不产主体句 (避免与绑定卡撞 Subject 号)
        if cp and _any_usage(self._pool_usage, "subject_look"):
            for i, row in enumerate(shots or []):
                binding_here = (cp.get("binding_names_in_scene", {}) or {}).get(i, [])
                if binding_here:
                    rid = str((row or {}).get("ID") or "").strip() or ("第%d行" % (i + 1))
                    warns.append("镜%s 池勾\"人物·外貌\"用途与绑定卡同行: 该素材仅作参考图接线; "
                                 "需成为角色请建卡分配 (该素材的 Subject 句已抑制)" % rid)

        # 全批空集信息条
        if cp and cp.get("all_empty_in_scene"):
            warns.append("本批已绑定角色但全批所有镜均未引用: "
                         "可在镜 prompt 里直接写角色名 (如 \"测试1\"), "
                         "或在出场角色列填名")

    # 批 A 节点 4 (4b): 跨角色素材 MD5 去重黄条 — C 轮真机踩坑:
    # 同一图被两角色两种用途引用 → 模型绑定崩溃/服装互换 (旧文字写法掩盖,
    # 六字段图绑定放大暴露)。仅 "同一 MD5 被不同 Subject/绑定引用" 报黄条;
    # 同 Subject 同图多用途 (H3 交替式合法: 外貌+服装锚同一 Picture) 不报。
    # 实现层: hashlib 按文件内容算, 单批内同文件重复算可接受 (局部 dict 缓存, 无全局/实例级)
    def _preflight_cross_subject_md5_check(self, bindings, warns):
        if not bindings:
            return
        # 局部 md5 缓存 (本仓风格: 无跨执行状态)
        md5_cache = {}
        # md5 -> [(name, no, idx, usage, media), ...]
        md5_refs = {}
        for b in bindings:
            if not isinstance(b, dict):
                continue
            name = b.get("name")
            no = b.get("no")
            if not isinstance(name, str) or not isinstance(no, int):
                continue
            for s in (b.get("slots") or []):
                if not isinstance(s, dict):
                    continue
                media = (s.get("media") or "").strip()
                idx = s.get("idx")
                usage = s.get("usage") or ""
                if not media or not isinstance(idx, int):
                    continue
                # 路径归一化: 同 _resolve_file 风格 (绝对/相对)
                full_path = media if os.path.isabs(media) else os.path.join(self.input_dir, media)
                if not os.path.exists(full_path):
                    continue  # 缺失走 ERR 通道, 不归本预检
                try:
                    m = md5_cache.get(full_path)
                    if m is None:
                        # 顺手 2: GB 级视频素材内存风险 — 改 1MB 分块读
                        # (行为不变: 同文件同 MD5; 现有测试以小文件自动覆盖)
                        _h = hashlib.md5()
                        with open(full_path, "rb") as f:
                            while True:
                                _chunk = f.read(1024 * 1024)
                                if not _chunk:
                                    break
                                _h.update(_chunk)
                        m = _h.hexdigest()
                        md5_cache[full_path] = m
                except OSError:
                    continue
                md5_refs.setdefault(m, []).append((name, no, idx, usage, media))
        # 跨角色重复检测: md5 对应多个不同 Subject 才报
        for m, refs in md5_refs.items():
            if len(refs) <= 1:
                continue
            subjects = {(r[0], r[1]) for r in refs}
            if len(subjects) <= 1:
                continue  # 同 Subject 多槽位 = H3 交替式合法 (look+outfit 共图)
            # 冲突详情: 列出所有冲突 (Subject 编号/槽位/用途) + MD5 前 8 位
            detail = ", ".join("[%s(no=%s)槽 %d(%s)]"
                               % (n, no_, idx_, u_ or "?")
                               for n, no_, idx_, u_, _m in refs)
            warns.append(
                "跨角色素材 MD5 重复 (md5=%s): %s 引用同一图; "
                "建议为不同角色分配不同素材, 避免模型绑定/服装互换"
                % (m[:8], detail)
            )

    def _preflight_ignore_words_check(self, shots, warns, bindings=None):
        """Warn when ignore_words is present on paths that do not consume it.
        bindings (T4·T1 记档遗留): 局部绑定表, None 回落 self._cast_bindings —
        preflight 早于 _apply_global, 直读恒空 self → 绑定槽 ignore_words WARN
        预检期不可达; 与 D4a 同款回落门 (不回填 self)。"""
        assets = self._load_assets_for_cast_plan() or {}
        bindings = (bindings if bindings is not None
                    else (getattr(self, "_cast_bindings", None) or []))
        binding_lookup = {b.get("name"): b for b in bindings
                          if isinstance(b, dict) and isinstance(b.get("name"), str)}
        is_en = getattr(self, "_lang", "zh") == "en"
        for row in shots or []:
            names, _ = parse_cast((row or {}).get("出场角色"))
            for name in names:
                card = assets.get(name) if isinstance(assets, dict) else None
                source_rows = []
                if isinstance(card, dict):
                    source_rows.extend(card.get("rows") or [])
                bound = binding_lookup.get(name)
                if isinstance(bound, dict):
                    source_rows.extend(bound.get("slots") or [])
                for item in source_rows:
                    if not isinstance(item, dict) or not str(item.get("ignore_words") or "").strip():
                        continue
                    # 1.11a 波3-T3: v3 卡行槽号键是 slot, 绑定卡 slots 是 idx — 双键取, 兜底 "?"
                    slot = item.get("idx", item.get("slot", "?"))
                    usage = item.get("usage", "")
                    if is_en:
                        warns.append("[忽略词] 语言=英文, 忽略词字段暂不生效（仅中文提示词支持）: %s/%s" % (name, slot))
                    elif usage == "scene":
                        warns.append("[忽略词] scene 用途暂不消费忽略词: %s/%s" % (name, slot))

    def _preflight_cast_shot_check(self, i, row, cmode, rid,
                                   errs, warns, search_deadline, g_prompt="",
                                   bindings=None):
        """Rules 1-4, 6-11 逐镜多角色预检 (无出场角色行直接 short-circuit 返回)
        bindings (T1): 局部绑定表, None 回落 self._cast_bindings (Rule 9 WARN 面一致性)"""
        cp = getattr(self, "_cast_plan", None)
        if not cp:
            return
        # 解析本镜出场角色名 (cheap, in-memory dict lookup); 无 cast → 全不触发
        text = row.get("出场角色") if isinstance(row, dict) else None
        names, _ = parse_cast(text)
        if not names:
            return

        # ---------- Rule 1, 2: 卡名解析失败 ----------
        # 卡形态判定文案: 非 v3 的 scene 卡 > v2(_v==2) > 其余 (v1 老卡 / v3 异常 kind)
        # — 与 resolve_cast 互补: _v==3 + kind in (character, scene) 已放行, 不进此分支
        for name, code in cp.get("resolve_errs", {}).get(i, []):
            if code == "not_found":
                errs.append("镜%s 出场角色「%s」在资产库中不存在: 请核对卡名或先建卡"
                            % (rid, name))
            elif code == "not_v3_character":
                assets = self._load_assets_for_cast_plan()
                card = (assets or {}).get(name)
                if isinstance(card, dict) and card.get("kind") == "scene":
                    kind_label = "场景卡"
                elif isinstance(card, dict) and card.get("_v") == 2:
                    kind_label = "v2 卡"
                else:
                    kind_label = "v1 老卡"
                errs.append("镜%s「%s」是%s, 出场角色须为 v3 角色卡"
                            % (rid, name, kind_label))

        # ---------- Rule 3: 卡无 subject_look 行 ----------
        for name in cp.get("no_look_cards", {}).get(i, []):
            warns.append("镜%s 出场角色「%s」未设外貌图, 该角色不会注入"
                         "（无 Subject 定义句）: 请在卡内补一张外貌图"
                         % (rid, name))

        # ---------- Rule 3b: 场景卡点名但卡上无 scene 行 (V1.12 T3, WARN 不阻断) ----------
        # Rule 3 "无外貌行" 对 scene 卡不适用 (scene 卡本就不产 Subject 行)
        # V1.12 T4: 有 scene 行但被 关场景 开关滤空 → 独立文案 (与"本就无场景行"区分)
        for name in cp.get("scene_filtered_cards", {}).get(i, []):
            warns.append("镜%s 场景卡「%s」场景行已因 关场景 开关过滤, 未产生场景参考"
                         % (rid, name))
        for name in cp.get("scene_no_row_cards", {}).get(i, []):
            warns.append("镜%s 场景卡「%s」无场景行, 未产生场景参考" % (rid, name))

        # ---------- Rule 3c: 空 media 行已跳过 (V1.12b, WARN 不阻断) ----------
        # 对齐前端 web/js/assets.js:152 `if (!media) continue;` 约定;
        # 卡上勾了用途但 media 为空 → 引擎不占槽不产句, 仅提示用户补图
        for row_name, row_usage, _row_desc in cp.get("empty_media_rows", {}).get(i, []):
            warns.append("镜%s 角色「%s」的 %s 行未传图已跳过"
                         % (rid, row_name, row_usage))

        # ---------- Rule 4: 空槽预算不足 ----------
        # assign err = "需 {X} 个空槽, 素材池仅剩 {Y} 个（Picture 9 保留）"
        # 绑定卡占用时变体 = "需 {X} 个空槽, 绑定卡已占 {N} 槽, 素材池仅剩 {Y} 个（Picture 9 保留）"
        # (V1.13 波2 D4): 1.14 批B B5 修复 — 正则放宽兼容绑定变体, 避免槽位不足错误被静默吞掉
        # 文案从 err 重算 X/Y (与 assign 同源数字, 不重算避免口径漂移; 绑定占用数 N 仅作根因说明)
        aerr = cp.get("assign_errs", {}).get(i)
        if aerr:
            m = re.match(
                r"需 (\d+) 个空槽, (?:绑定卡已占 (\d+) 槽, )?素材池仅剩 (\d+) 个",
                aerr,
            )
            if m:
                x = m.group(1)
                y = m.group(3)
                bound_note = ""
                if m.group(2) is not None:
                    bound_note = "（绑定卡已占 %s 槽）" % m.group(2)
                errs.append("镜%s 出场角色共需 %s 个空槽, 素材池仅剩 %s 个"
                            "（Picture 9 保留）%s: 请清出槽位或减少角色/服装道具行"
                            % (rid, x, y, bound_note))

        # ---------- Rule 6: 非 ref2v 模板族 + 出场角色非空 ----------
        # cmode 已是 effective 模式 (preflight 入口计算同源); 出场角色数 = parse 出的 names 数
        if cmode != "ref2v":
            warns.append("该模板族不接参考槽, 镜%s 出场角色 %d 个不生效"
                         % (rid, len(names)))

        # ---------- Rule 7: 同镜同名重复 (parse_cast warns 前缀拼镜号) ----------
        for w in cp.get("parse_warns", {}).get(i, []):
            warns.append("镜%s %s" % (rid, w))

        # ---------- Rule 8: 卡 rows 含白名单外用途行 ----------
        # 一行一条 WARN, 用 USAGE_REGISTRY[usage]["label"] 作文案片段
        cards = cp.get("cards", {}).get(i, {})
        for name, card in cards.items():
            _, skipped = card_cast_rows(card)
            for s in skipped:
                usage = s.get("usage", "")
                label = USAGE_REGISTRY.get(usage, {}).get("label", usage)
                warns.append("镜%s 出场角色「%s」的「%s」行不支持随角色注入, 已跳过"
                             % (rid, name, label))

        # ---------- Rule 9: 手写标签撞虚拟槽首 look 槽 → WARN ----------
        # 只对撞"该角色首 look 槽(主锚点)"报; 撞次 look/outfit/prop 槽不报
        # 批 H3 修复: 取数从 binding slots 直迭代而非 slot_map 字典
        # 共占卡 (同 idx 多 usage) slot_map 字典塌缩丢 subject_look 行 →
        # card_first_slot 空 → BUG 漏报. 改用 binding slots 直迭代 (保留 co-occupy 多行).
        row_per_shot = cp.get("per_shot", {}).get(i)
        if row_per_shot:
            slot_map = row_per_shot["slot_map"]
            cast_spec = row_per_shot["cast_spec"]
            # 绑定卡的 in-scene 名集合 — 用 binding_lookup 直迭代 (不塌缩)
            # T1: 改局部 bindings (None 回落 self; 原直读 self._cast_bindings 恒空)
            binding_lookup = {b.get("name"): b for b in (
                bindings if bindings is not None
                else (getattr(self, "_cast_bindings", None) or []))
                if isinstance(b, dict) and isinstance(b.get("name"), str)}
            # 卡名 → 首 look slot:
            #   绑定卡 — 走 binding slots 列表 (找首个 subject_look usage, 一次性 idx)
            #   未绑定卡 — 走 slot_map 字典 (虚拟槽天然无共占)
            card_first_slot = {}
            for name_b, b in binding_lookup.items():
                for s in (b.get("slots") or []):
                    if not isinstance(s, dict):
                        continue
                    usage_s = s.get("usage") or ""
                    if usage_s == "subject_look":
                        card_first_slot[name_b] = s.get("idx")
                        break  # 该卡首 look 取定
            for slot, mapped in slot_map.items():
                n, usage, _m, _d = mapped[:4]
                if usage == "subject_look" and n not in card_first_slot:
                    card_first_slot[n] = slot
            # 卡名 → subject_no: 从 cast_spec 首 look 行反查
            #   绑定卡 — 通过 (slot, usage) 在 binding slots 列表中配对
            #   未绑定卡 — 走 slot_map[slot][0] 反查
            subject_no_map = {}
            for subj_no, rows in (cast_spec or []):
                for row_spec in rows:
                    slot, usage, _desc = row_spec[0], row_spec[1], row_spec[2]
                    if usage != "subject_look":
                        continue
                    # 名字反查
                    name_match = None
                    # 绑定卡路径 — 找 (slot, usage) 双键匹配
                    for nm, b in binding_lookup.items():
                        for s in (b.get("slots") or []):
                            if (isinstance(s, dict)
                                    and s.get("idx") == slot
                                    and (s.get("usage") or "") == usage):
                                name_match = nm
                                break
                        if name_match:
                            break
                    if not name_match and slot in slot_map:
                        name_match = slot_map[slot][0]
                    if name_match and name_match not in subject_no_map:
                        subject_no_map[name_match] = subj_no
                    break  # 一个 no 一名字 即可
            # 行文本扫 <Picture N>: 撞某卡主锚点即报
            prompt_text = (row.get("prompt") or "")  # 仅镜内 prompt (行内手写)
            for m in TAG_RE.finditer(prompt_text):
                kind = m.group("kind").title()
                idx = int(m.group("idx"))
                if kind != "Picture":
                    continue
                for name, first_slot in card_first_slot.items():
                    if first_slot == idx:
                        subj_no = subject_no_map.get(name, "?")
                        warns.append("镜%s 手写标签 <Picture %d> 与出场角色「%s」"
                                     "的外貌图槽位相同, 该角色 Subject 句将被手写优先规则剔除: "
                                     "请改用 \"Subject %s\" 文字引用"
                                     % (rid, idx, name, subj_no))
                        break  # 一个标签只报一次

        # ---------- Rule 10: 卡 desc 已在全局提示词 → WARN (一卡一条, 撞第一个即报) ----------
        g_text = g_prompt or ""
        for name, card in cards.items():
            for r in (card.get("rows") or []):
                desc = r.get("desc") or ""
                if desc and desc in g_text:
                    warns.append("镜%s 出场角色「%s」的特征描述已存在于全局提示词, "
                                 "将重复带入: 建议清理全局提示词中的残留描述"
                                 % (rid, name))
                    break  # 一卡一条

        # ---------- Rule 11: 虚拟槽文件不存在 → ERR (复用 _search_tree_hint 3s 共享预算) ----------
        if row_per_shot:
            slot_map = row_per_shot["slot_map"]
            pool_eff = row_per_shot["pool"]
            for slot, fname in (pool_eff.get("Picture") or {}).items():
                if slot == 9 or not fname:
                    continue
                if slot not in slot_map:
                    continue  # 非虚拟槽, 由现有池缺失检查处理
                p = os.path.join(self.input_dir, fname)
                if not os.path.exists(p):
                    name = slot_map[slot][0]
                    hint = _search_tree_hint(self.input_dir,
                                              os.path.basename(fname),
                                              search_deadline)
                    errs.append("镜%s 出场角色「%s」的素材文件「%s」找不到: %s"
                                % (rid, name, fname, hint))

    def preflight(self):
        errs = []
        self._preflight_warns = []
        # 批B B4: zh 六字段声场空聚合追踪器 — 每行 [声场空] 信号收口, 循环后聚合一条黄条
        _soundscape_empty_rids = set()
        # V1.7 B2: 预解析幂等 — 与 run()/rerun 共享同一 _cast_plan 产物 (F5)
        # 重置缓存以确保本次 preflight 用最新 CSV/资产库状态
        self._cast_plan = None
        # V1.11 批4 T4 (门审): g 兜底 — CSV 缺失或解析 ShotError 时下方 PDD 步数 / PDD×turbo
        # 校验块在 csv_path 门外仍会跑; 不兜底则 UnboundLocalError 致 preflight 整段崩.
        g = {}
        if not os.path.exists(self.csv_path):
            errs.append("CSV 不存在: %s" % self.csv_path)
        if not self.workflow_path:
            errs.append("请先配置模板: 在 h3_config.json 填 default_workflow/workflow_dir, 或显式传入 workflow_path")
        elif not os.path.exists(self.workflow_path):
            errs.append("工作流不存在: %s" % self.workflow_path)
        else:
            # 1.14 整改批 I I1: i2v/fl2v 全面废除 — 直达 preflight 的路径 (队列模式
            # _run_engine_once / 直调引擎) 在此拒; submit/rerun 主路径由批入口构造器先拒.
            _retired = _retired_template_error(self.workflow_path)
            if _retired:
                errs.append(_retired)
        # T4.4b 后: 模板 LoRA 存在性预检 — 模板 JSON 引用的 lora_name 不在当前 LoRA
        # 库枚举里时, 按 stem 解析; 解析失败 (零命中 / 多命中) 报清晰错误, 引导用户
        # 改文件名一致或在表单 LoRA 覆写里二选一指定。convert 阶段已经自动唯一命中替换
        # (静默 + 日志), 这里只报解析失败; 同 lora_name 在多个节点出现去重一次。
        # folder_paths=None (离线/测试) 或缺 get_filename_list → 跳过整段 (与 convert 口径一致).
        if (folder_paths is not None
                and hasattr(folder_paths, "get_filename_list")
                and self.workflow_path and os.path.exists(self.workflow_path)):
            try:
                installed = folder_paths.get_filename_list("loras")
                with open(self.workflow_path, encoding="utf-8") as _wf:
                    _wf_data = json.load(_wf)
                _reported = set()
                for _n in _wf_data.get("nodes") or []:
                    if _n.get("type") not in LORA_CLASS_TYPES:
                        continue
                    _wv = _n.get("widgets_values") or []
                    if not _wv or not isinstance(_wv[0], str) or not _wv[0]:
                        continue
                    _name = _wv[0]
                    if _name in _reported:
                        continue
                    # 精确命中 → 放行 (跳过)
                    if _name in installed:
                        _reported.add(_name)
                        continue
                    _resolved, _cands = _resolve_lora_alias(_name, installed)
                    # 唯一命中 → 已自动解析 (与 convert 同语义) → 放行
                    if _resolved != _name:
                        _reported.add(_name)
                        continue
                    # 多命中 (有候选) 或 零命中 (无候选) → 报清晰错误
                    _candidate_str = " / ".join(_cands[:5]) if _cands else "(无)"
                    errs.append("模板 LoRA '%s' 在 LoRA 库中不存在; 候选: %s (请改名一致或二选一后在表单资源编排/LoRA覆写中指定)" % (_name, _candidate_str))
                    _reported.add(_name)
            except (OSError, ValueError):
                # 模板 JSON 损坏/读不到 — 留给后续步骤报错, 这里不阻塞 LoRA 预检
                pass
        if not os.path.isdir(self.input_dir):
            errs.append("素材目录不存在: %s" % self.input_dir)
        if not os.path.isdir(self.server_input_dir):
            errs.append("服务器输入目录不存在: %s" % self.server_input_dir)
        # output_dir 必须是服务器 output 根: 判据 = 存在 video\shots(模板 SaveVideo 落盘路径)。
        # 指错位置(如上一级)会导致产物找不到、归档静默丢失; 全新空目录放行(用户自建归档根)。
        if os.path.isdir(self.output_dir):
            has_shots = os.path.isdir(os.path.join(self.output_dir, "video", "shots"))
            if not has_shots and os.listdir(self.output_dir):
                errs.append("output_dir 疑似不是服务器输出根目录: %s (应有 video\\shots 子目录; "
                            "请填 ComfyUI --output-directory 指定的目录)" % self.output_dir)
        if os.path.exists(self.csv_path):
            try:
                raw = self._parse_rows()
                pool = self._parse_pool(raw)
                # 批 H2 小授权: 缓存池底真实文件给绑定失配 WARN 比对
                self._pool_dict = pool
                shots = self._parse_shots(raw)
                g = self._parse_global(raw)
                self._lang = "en" if str(g.get("语言", "") or "").strip().lower() in ("英文", "en", "english") else "zh"
                # V1.12 T4: 关场景 开关 — preflight 早于 _apply_global, 此处同 self._lang 口径
                # 先行落位, 否则预检 Rule 3b 看不到开关态 (契约 4 WARN 不可达)
                self._scene_disabled = (str(g.get("关场景", "") or "").strip() == "开")
                # V1.12b v4 M5: 人物建档 开关 — preflight 早于 _apply_global, 同 _scene_disabled 口径
                # 裸比较, 不用 _truthy 局部闭包 (二轮 A4 已证 preflight 取不到)
                self._enrollment_enabled = (str(g.get("人物建档", "") or "").strip() == "开")
                # T1 (@mention 预检): 绑定表局部注入单点 — preflight 早于 _apply_global,
                # self._cast_bindings 恒空 (唯一回填点 :6247)。B6 双路口径: g["角色绑定"]
                # 为非空 list 走 CSV 局部表, 否则 None 回落 self (测试直注入路径兼容)。
                # _cb_use = 门式消费点用 (None-able); _cb_list = 具表消费点用 (含 self 回落)。
                # 不回填 self._cast_bindings — _preflight_binding_check 首遍空跑是已锁行为面。
                _cb_local = g.get("角色绑定")
                _cb_use = _cb_local if isinstance(_cb_local, list) and _cb_local else None
                _cb_list = (_cb_use if _cb_use is not None
                            else (getattr(self, "_cast_bindings", None) or []))
                # V1.7 B2: 预解析 — 失败 (资产库损坏等) 静默兜底 any_cast=False, 不影响后续流程
                try:
                    self._prepare_cast_plan(shots, pool, bindings=_cb_use)
                except Exception:
                    self._cast_plan = None
                # 1.13f: 全局手写锚定 dedup 降级黄条 — preflight 早于 _apply_global, 禁读
                # self._global_prompt (恒空); 改读作用域裸 g["提示词"] (与扫描口径二审 D 同源)
                # cast_spec 来源 = _cast_plan["any_cast"] 布尔 (与 _preflight_cast_batch_check 同源)
                _cp = getattr(self, "_cast_plan", None)
                _any_cast_for_preflight = bool(_cp.get("any_cast")) if isinstance(_cp, dict) else False
                _cast_spec_for_preflight = [(1, [])] if _any_cast_for_preflight else []
                _g_text = g.get("提示词", "") or ""
                _anchor_warns_pre = _check_global_anchor_dup(
                    _g_text, _cast_spec_for_preflight,
                    getattr(self, "_subject_anchors", None))
                if _anchor_warns_pre:
                    self._preflight_warns.extend(_anchor_warns_pre)
                # T4 (T1 记档遗留): ignore_words WARN 同款局部通道 — 传 _cb_list
                # (含 self 回落), 直读恒空 self 的绑定槽路径预检期转可达。
                self._preflight_ignore_words_check(shots, self._preflight_warns,
                                                   bindings=_cb_list)
                # V1.7 C1: Rule 5 批级混用 — 池勾 subject_look + 任一镜填角色, 仅报一次
                # B6 (B3-M2 必改): 局部注入解析后 bindings 供 Rule 5 检查 — preflight 早于
                # _apply_global, 旧实现读 self._cast_bindings 恒空 → 绑定批 + 池手勾
                # subject_look 被误报 ERR (挡死合法 C1 混镜用法). 显式传 g["角色绑定"]
                # 局部入参即可命中 C1 豁免, 不回填 self._cast_bindings (_apply_global 才做).
                # CSV 行 / 直接 e._cast_bindings = [...] 注入两路并存: g["角色绑定"] 非空走 CSV
                # 解析结果 (生产真实路径), 空则保留 self._cast_bindings (测试直注入路径,
                # 与既有 _h1_setup cast_bindings=... 兼容, 不破 _preflight_cast_batch_check
                # 内部 `bindings is None → getattr(self, "_cast_bindings")` 兜底双保险).
                _cb_pre_batch = g.get("角色绑定")
                if isinstance(_cb_pre_batch, list) and _cb_pre_batch:
                    self._preflight_cast_batch_check(shots, errs, bindings=_cb_pre_batch)
                else:
                    self._preflight_cast_batch_check(shots, errs)
                # 批 H1: 绑定专项预检 (失联/失配/混镜手动 look 抑制/i2v-fl2v/全批空集)
                # T1: 局部表透传 (None 回落 self — 测试直注入路径与 B6 同款双保险)
                self._preflight_binding_check(shots, errs, self._preflight_warns,
                                              bindings=_cb_use)
                # 批 A 节点 4 (4b): 跨角色素材 MD5 去重黄条 — 局部传 bindings 给 MD5 检查
                # (关键: 不回填 self._cast_bindings — 那是 _apply_global 才做的事;
                # preflight() 在 _apply_global 之前跑, 旧实现读 self._cast_bindings 恒空 → 黄条 100% 不可达。
                # 同时禁回填是因批 H1 的 _preflight_binding_check 读同一属性 (_apply_global 才赋);
                # 2026-10-20 引擎批 D4a 起: 该检查经局部绑定表入参预检期可达, 旧「首遍空跑」
                # 工程范围决策已解锁 (旧锁 test_preflight_md5_dedup 重锁新面))
                _cb_raw_pre = g.get("角色绑定")
                _cb_pre = _cb_raw_pre if isinstance(_cb_raw_pre, list) else []
                self._preflight_cross_subject_md5_check(
                    _cb_pre, self._preflight_warns)
                if not shots:
                    errs.append("CSV 里没有分镜行(ID 表头之后为空)")
                # 重复 ID 硬错误: manifest 按 ID 键存储, 重复会互相覆盖状态, 拦截 (空 ID 不报, 补号机制已防撞)
                _id_count = {}
                for _sr in shots:
                    _sr_id = str(_sr.get("ID") or "").strip()
                    if _sr_id:
                        _id_count[_sr_id] = _id_count.get(_sr_id, 0) + 1
                for _did, _dn in _id_count.items():
                    if _dn > 1:
                        errs.append("分镜 ID 重复: %s (出现 %d 次)" % (_did, _dn))
                # 素材池缺失只报一次, 不随分镜行数重复
                # V1.7: 附全树搜索提示 — 共享 3s 预算防拖死同步端点
                search_deadline = time.time() + 3.0
                for kind in ("Picture", "Video", "Audio"):
                    for idx, fname in sorted(pool.get(kind, {}).items()):
                        p = os.path.join(self.input_dir, fname)
                        if not os.path.exists(p):
                            errs.append("素材池 %s 槽 %d 文件不存在: %s%s"
                                        % (kind, idx, fname,
                                           _search_tree_hint(self.input_dir,
                                                             os.path.basename(fname),
                                                             search_deadline)))
                # 1.13e A 件: 批级素材池硬参数检查 (池非空时才有信号; 全 WARN 零阻断)
                self._preflight_warns.extend(
                    _check_pool_limits(pool, self.input_dir))
                # 批 K: 12 槽黄条按段重算 (批级检查 1 不动, 两条黄条可并存);
                # 与预览端点 checks.warns 双点同源 (_check_seg_pool_limits 单一判据)
                _seg_cp = getattr(self, "_cast_plan", None) or {}
                self._preflight_warns.extend(_check_seg_pool_limits(
                    shots, getattr(self, "_seg_pools", None),
                    g.get("提示词", "") or "", self._pool_usage,
                    bindings=_cb_list,
                    ctx={i: {"cast_spec": p.get("cast_spec"),
                             "keep_slots": p.get("keep_slots")}
                         for i, p in (_seg_cp.get("per_shot") or {}).items()}))
                # T1: 绑定快照槽集 — TAG 池校验豁免数据源。绑定卡快照槽只在 run 期写进
                # 逐镜副本, 池校验查 raw pool 会把绑定通道提交误拦 400。绑定快照槽全链
                # 只写 Picture (_f_n2_keep_set :1688 同源) — 豁免必须限 kind=="Picture",
                # 不限会把同号 Video/Audio 真缺料误放行到 run 期 ShotError 硬崩。
                binding_pic_slots = {
                    s["idx"] for b in (g.get("角色绑定") or []) if isinstance(b, dict)
                    for s in (b.get("slots") or [])
                    if isinstance(s, dict) and isinstance(s.get("idx"), int)}
                for i, row in enumerate(shots):
                    text = (g.get("提示词", "") or "") + "\n" + (row.get("prompt") or "")
                    rid = str(row.get("ID") or "").strip() or ("第%d行" % (i + 1))
                    # bugfix: ID 有值但 prompt 为空 → 黄条 (不拦截, 仅提示)
                    if rid and not str(row.get("prompt") or "").strip():
                        self._preflight_warns.append(
                            "分镜 %s 未写提示词, 将仅以全局提示词生成, 请确认" % rid)
                    # 批 C 节点 C-I 门审 D1/D3 修复 (2026-08-28): 跑一遍 convert_dialogue
                    # 抓 missing_speaker + collision_d_neg 事件 → 黄条入 _preflight_warns
                    # (与端点 checks.warns 同源). 仅关心这两类 — bare_verb 等其他事件不动.
                    try:
                        from prompt_assembler import convert_dialogue
                        _row_p = row.get("prompt") or ""
                        if _row_p.strip():
                            _cb = _cb_list  # T1: 局部绑定表 (原直读 self._cast_bindings 恒空)
                            _, _d_ev = convert_dialogue(
                                _row_p, bindings=_cb, lang=self._lang,
                                warn_sink=None, shot_id=rid,
                                negative_dialogue=self._negative_dialogue)
                            for _ev in _d_ev:
                                if _ev[0] == "missing_speaker":
                                    _, _name, _ = _ev
                                    self._preflight_warns.append(
                                        "分镜 %s 台词说话人「%s」未绑定, "
                                        "已只包 <d> 未加 (SN); 建议在表单绑定该角色"
                                        % (rid, _name))
                                elif _ev[0] == "collision_d_neg":
                                    self._preflight_warns.append(
                                        "分镜 %s 已含 <d> 台词 × 关对白开关同开 (语义对撞), "
                                        "请二选一 (保留台词则取消关对白, 或保留关对白则去掉 <d> 行)"
                                        % rid)
                    except Exception:
                        pass  # 预检层任何失败兜底不拦截 (既有防御策略)
                    for m in TAG_RE.finditer(text):
                        kind, idx = m.group("kind").title(), int(m.group("idx"))
                        if pool.get(kind, {}).get(idx):
                            continue
                        # T1: 绑定快照槽豁免 (限 Picture) — 与下方 <Picture 9> 段豁免
                        # 语义正交, 放 continue 位即可
                        if kind == "Picture" and idx in binding_pic_slots:
                            continue
                        # 1.11b 波1 T2: A 类 — 自定义下只有勾选段才走"9 号槽尾帧"豁免 (与拼接侧同口径)
                        _seg_concat = (self._seg_mode(i) == "拼接")
                        if _seg_concat and kind == "Picture" and idx == 9 and i > 0:
                            continue
                        if _seg_concat and kind == "Picture" and idx == 9:
                            errs.append("第 1 段引用了 <Picture 9> 但素材池 9 号留空: "
                                        "请上传 9 号起点图(第 2 段起自动接上一段尾帧, 不受影响)")
                        else:
                            errs.append("分镜 %s 引用了 <%s %d> 但素材池里没有: 请在素材池对应槽位上传素材"
                                        % (rid, kind, idx))
                    if _DIALOGUE_RE.search(row.get("prompt") or ""):
                        # 批 C 节点 C-I: 手写 <d> 且无 (SN) → 建议补说话人 (替代旧 V1.5 提示文案)
                        # 仅在行内未含 (S N) 形态时提示 (避免重复包/已正确)
                        row_prompt_for_check = row.get("prompt") or ""
                        has_sn = bool(_SN_INLINE_RE.search(row_prompt_for_check))
                        if not has_sn:
                            self._preflight_warns.append(
                                "分镜 %s 手写 <d> 且无 (SN) 说话人位, "
                                "建议补说话人 (例: `(S1) 少女1说：<d>[中文] 台词</d>`)" % rid)
                    # V1.11 批 4 T3b: 关对白 × <d> 对撞黄条已由上方 convert_dialogue 通道 (D3)
                    # 统一覆盖 (扩展到也检手写 <d> 行, 见 prompt_assembler.convert_dialogue).
                    # 此处旧手写块删除, 避免双报. "建议补说话人" 黄条 (上面 5968-5976) 保留.
                    # V1.4 T4: 提示词规则检查(preflight 双时机) — cmode 与 pic9_present 计算同源
                    # apply_shot_pool / apply_shot_concat (declared+detect); pic9 接线逻辑也同源
                    # V1.7 B2: cmode 计算改用与执行同一口径 (拼接: declared 优先否则 detect(union, has_cast))
                    # 1.11b 波1 T2: cmode 保持批级门控 (_any_seg_concat), pic9_present 逐行 (§二.3 A 表)
                    if not self._any_seg_concat():
                        cmode = _template_mode(self.workflow_path)
                        pic9_present = False
                    else:
                        declared = getattr(self, "_declared", None)
                        _cp = getattr(self, "_cast_plan", None)
                        if _cp is not None and _cp.get("any_cast"):
                            cmode = declared or self._detect_concat_mode(
                                _cp["union_pool"], has_cast=True)
                        else:
                            cmode = declared or self._detect_concat_mode(pool)
                        if cmode == "ref2v":
                            # 逐行: 仅勾选段才允许 i>0 带来的 pic9_present; 独立段(自定义下未勾选段) pic9_present=False
                            if self._seg_mode(i) == "分镜":
                                pic9_present = False
                            else:
                                pic9_present = (i > 0) or bool(pool.get("Picture", {}).get(9))
                        else:
                            pic9_present = False
                    # V1.7 C1: 多角色预检 Rules 1-4, 6-11 (Rule 5 在循环外已跑) — 消费 self._cast_plan
                    # 位置: TAG_RE 检查后 / check_prompt_rules 前; 与现有池缺失共用 search_deadline 3s 预算
                    self._preflight_cast_shot_check(i, row, cmode, rid, errs,
                                                    self._preflight_warns,
                                                    search_deadline,
                                                    g_prompt=g.get("提示词", "") or "",
                                                    bindings=_cb_use)
                    # B-I 修复: per-row cast_spec 透传 → use_six_field 门判定 (R3 必修)
                    _row_cast_spec = None
                    _cp = getattr(self, "_cast_plan", None)
                    if _cp is not None:
                        _per_shot = _cp.get("per_shot") or {}
                        _ps_entry = _per_shot.get(i) if isinstance(_per_shot, dict) else None
                        if isinstance(_ps_entry, dict):
                            _row_cast_spec = _ps_entry.get("cast_spec")
                    r_errs, r_warns = check_prompt_rules(
                        row, pool, self._pool_usage,
                        g.get("提示词", "") or "", cmode, pic9_present,
                        audio_global=self._audio_blocks,
                        cast_spec=_row_cast_spec,
                        # 1.13e: L2'(绑定名冒号) 对白豁免数据源 — 与方案 §3.1R 同款
                        # (T1: 改局部绑定表, 原直读 self._cast_bindings 恒空 = 豁免不可达)
                        bindings=_cb_list)
                    for em in r_errs:
                        # V1.6 T1: 时间轴 errs 降级为 _preflight_warns, 不拦截
                        # (PRD 有意偏差 F1: 时间段写法自由度高, 锁跑批过激)
                        if em.startswith("[时间轴] "):
                            self._preflight_warns.append("分镜 %s %s" % (rid, em))
                        else:
                            errs.append("分镜 %s %s" % (rid, em))
                    # 批B B4: 收集每行 [声场空] 信号 → 引擎预检聚合为一条黄条
                    # (列入 _soundscape_empty_rids; 后循环统一折叠, 不逐行飘)
                    _ws_rids_for_row = set()
                    _ws_warns_clean = []
                    for _w in r_warns:
                        if isinstance(_w, str) and _w.startswith(_SOUNDSCAPE_WARN_PREFIX):
                            _ws_rids_for_row.add(rid)
                        else:
                            _ws_warns_clean.append(_w)
                    self._preflight_warns.extend(_ws_warns_clean)
                    if _ws_rids_for_row:
                        _soundscape_empty_rids.update(_ws_rids_for_row)
                    # 3B 段落时长 linter: 范围 [0.04, 900] 秒(引擎 DurationPlanner 硬约束); 留空=5 秒放行
                    dur_raw = str(row.get("段落时长", "") or "").strip()
                    if dur_raw:
                        try:
                            dur_v = float(dur_raw)
                        except ValueError:
                            errs.append("分镜 %s 段落时长非数字: %r: 请填秒数(如 5), 留空=5 秒"
                                        % (rid, dur_raw))
                        else:
                            if not (0.04 <= dur_v <= 900):
                                errs.append("分镜 %s 段落时长 %s 秒超出合法范围 [0.04, 900] 秒(引擎硬约束): 请调整"
                                            % (rid, dur_raw))
                steps_raw = str(g.get("步数", "") or "").strip()
                if steps_raw:
                    m = re.match(r"(\d+)\s*([VA])\s*(\d+)\s*([VA])", steps_raw, re.IGNORECASE)
                    if m:
                        v = int(m.group(1)) if m.group(2).upper() == "V" else int(m.group(3))
                        a = int(m.group(3)) if m.group(2).upper() == "V" else int(m.group(1))
                        if a < v:
                            errs.append("步数 %s: 音频步 %d < 视频步 %d (硬规则 audio_steps ≥ video_steps, "
                                        "合法如 8V8A/4V8A)" % (steps_raw, a, v))
            except ShotError as e:
                errs.append(str(e))
        # V1.11 批4 T4 D3: PDD 模板步数专属校验 (与通用 A≥V 校验并行) —
        #   模板含 MiniMaxH3PDDAccApply 时步数必须可解析 + V==A + V∈{4,6,8}.
        #   留空不写 nfe 走模板默认 (8); 仅在 steps_raw 非空时校验.
        if self.workflow_path and os.path.isfile(self.workflow_path):
            try:
                with open(self.workflow_path, encoding="utf-8") as _wf:
                    _wf_data = json.load(_wf)
                _nodes = _wf_data.get("nodes") or []
                _is_pdd = any(n.get("type") == PDD_ACC_CLASS for n in _nodes
                              if isinstance(n, dict))
                if _is_pdd:
                    _steps_raw = str(g.get("步数", "") or "").strip()
                    _pdd_err = _validate_pdd_steps(_steps_raw)
                    if _pdd_err is not None:
                        errs.append(_pdd_err)
            except (OSError, ValueError):
                pass
        # V1.11 批4 T4 D5: PDD × turbo 互斥预检 — 模板含 PDDAccApply 且
        #   编排条目归类 turbo 或 模板自带 lora 归类 turbo → 拦截.
        #   离线可直测 (只依赖模板 JSON + self._resources, 不依赖 folder_paths).
        if self.workflow_path and os.path.isfile(self.workflow_path):
            try:
                with open(self.workflow_path, encoding="utf-8") as _wf:
                    _wf_data2 = json.load(_wf)
                _nodes2 = _wf_data2.get("nodes") or []
                _is_pdd2 = any(n.get("type") == PDD_ACC_CLASS for n in _nodes2
                               if isinstance(n, dict))
                if _is_pdd2:
                    _pdd_turbo_hit = False
                    for _r in (self._resources or []):
                        if _classify_injectable(_r) == "turbo":
                            _pdd_turbo_hit = True
                            break
                    if not _pdd_turbo_hit:
                        # 模板自带 lora 归类 — 复用 discover_template_loras 的同源规则
                        # (节点类型 + 文件名 turbo 补偿), 离线可调 (仅读 JSON + 词表)
                        try:
                            from resources_scan import discover_template_loras as _rs_discover
                            _tpl_loras = _rs_discover(self.workflow_path)
                        except Exception:
                            _tpl_loras = []
                        for _tl in _tpl_loras:
                            if _tl.get("category") == "turbo":
                                _pdd_turbo_hit = True
                                break
                    if _pdd_turbo_hit:
                        errs.append("PDD 加速与 turbo 类蒸馏 lora 互斥, 请移除")
            except (OSError, ValueError):
                pass
        # 批B B4: zh 六字段声场空聚合 — B-I 修复后, per-row [声场空] 已被前置过滤不写入
        # _preflight_warns (引擎层此处仅接其他类别); 聚合调用 aggregate_soundscape_warns 单一来源
        # (R6(b)): 引擎 + 端点 + 单元测试共用同一聚合条文案
        if _soundscape_empty_rids:
            # 用一个虚拟的 [_声场空] 占位喂给聚合器, 让聚合器输出聚合条统一文案 (不重复写文案)
            placeholder = [_soundscape_warn_template()]
            new_warns, agg = aggregate_soundscape_warns(
                placeholder, shot_ids=list(_soundscape_empty_rids))
            if agg is not None:
                self._preflight_warns.append(agg)
        if self.archive_dir:
            try:
                os.makedirs(self.archive_dir, exist_ok=True)
            except OSError as e:
                errs.append("归档目录不可用: %s (%s)" % (self.archive_dir, e))
        return errs

    def _new_run_dir(self):
        # 批 W1 S1-T3: run_subdir 非空 → 用指定名 (构造期已清洗, 已存在目录静默复用
        # = 接力复用); 空/缺省 = 每次运行独立时间戳文件夹, 防止同名覆盖
        name = getattr(self, "run_subdir", "") or time.strftime("%Y%m%d_%H%M%S")
        self.run_dir = os.path.join(self.output_dir, name)
        os.makedirs(self.run_dir, exist_ok=True)
        # V1.11 批 1 T2b: manifest 跟随批次文件夹 — 落盘位置改在 run_dir 内
        # (output 根平铺的 h3_batch_manifest_*.json 太乱, 老板裁决入 run_dir).
        # 既有根层文件保留不动, 新位置 = 本次 run_dir; 端点通过 resolve_manifest_path 双位置寻址.
        stem = os.path.splitext(os.path.basename(self.csv_path))[0]
        suffix = getattr(self, "manifest_suffix", "")
        self.manifest_path = os.path.join(
            self.run_dir, "h3_batch_manifest_%s%s.json" % (stem, suffix))
        print("[H3Batch] 输出文件夹: %s" % self.run_dir, flush=True)
        return self.run_dir

    def _inject_seed(self, prompt, seed):
        for node in prompt.values():
            if node["class_type"] == "RandomNoise":
                node["inputs"]["noise_seed"] = seed

    # ---------------- V1.9 批 3 T3.2: S1 latent 尾窗续接 ----------------

    def _continuation_run_rel(self):
        """S1 intermediates 相对服务端输出根的坐标 = relpath(run_dir, 输出根).

        嵌套 run_subdir (项目名/项目名_时间戳) 必须保留完整相对路径 — basename 会丢项目夹段,
        intermediates 散落输出根成残壳 (#51). 不读 run_subdir 属性: rerun 端点建批不传该
        字段, 值为空串. 越界 (run_dir 不在输出根下, 如归档批重跑/跨盘) 回退现行 basename
        行为并告警 — 不炸批.
        """
        server_root = getattr(self, "_server_output_dir", None) or self.output_dir
        run_dir = getattr(self, "run_dir", None) or ""
        if not server_root or not run_dir:
            return ""
        try:
            rel = os.path.relpath(run_dir, server_root)
        except ValueError:  # Windows 跨盘符
            rel = os.pardir
        if rel == os.pardir or rel.startswith(os.pardir + os.sep):
            print("[H3Batch] S1 续接坐标越界 (run_dir 不在输出根下): %s → 回退 basename %s"
                  % (run_dir, os.path.basename(run_dir)), flush=True)
            return os.path.basename(run_dir)
        return rel

    def _continuation_ctx_dir(self):
        """S1 latent 落盘目录绝对路径 (服务端输出根 + relpath(run_dir, 输出根) 推导,
        与 SaveLatent 写入坐标一致 — 归档批重跑时 run_dir 非输出根直接子目录
        (e.g. 归档/<time>) 回退 basename 也命中, 修复 D9 写/查基准分叉)."""
        server_root = getattr(self, "_server_output_dir", None) or self.output_dir
        return os.path.join(server_root, self._continuation_run_rel(),
                            *CONTINUATION_SUBDIR)

    def _continuation_clip_path(self, clip_index):
        """clip_N 固定槽位文件绝对路径 (clip_%05d.safetensors, 重跑覆盖自己的 reject).

        V1.13 T11-R: 双候选 — 真机 8190 实证 (2026-09-13 归档批重跑): 非 --cache-none
        实例 LoadLatent 句柄未放 ⇒ 收尾清理放行 ⇒ latent 随 run_dir 整体归档搬走, 写入
        坐标 (输出根/<relpath>) 下已无文件而 run_dir/intermediates 下有。先查 run_dir
        实际位置再查写入坐标, 命中任一返回; 都无返回写入坐标 (供 isfile 判 False)。"""
        fn = "clip_%05d.safetensors" % int(clip_index)
        if self.run_dir:
            p = os.path.join(self.run_dir, *CONTINUATION_SUBDIR, fn)
            if os.path.isfile(p):
                return p
        return os.path.join(self._continuation_ctx_dir(), fn)

    def _prepare_continuation_dir(self):
        """批开始时创建 intermediates/h3_ctx (SaveLatent 服务端写盘时也会建,
        引擎侧预建便于存在性检查与生命周期管理)。返回目录绝对路径。"""
        d = self._continuation_ctx_dir()
        os.makedirs(d, exist_ok=True)
        return d

    def _cleanup_continuation(self):
        """批收尾: intermediates 随批清理 (rmtree) — 必须在归档搬运前调用,
        否则 run_dir 整体 move 会把中间 latent 带进 archive。幂等, 不抛。
        Windows 平台注意: LoadLatent 读过的 clip 若仍被 ComfyUI 执行缓存以
        mmap 持有 (默认缓存策略), 句柄未放前 rmtree 会拒绝访问 — 短重试覆盖
        句柄延迟关闭; 仍残留则警告并放行 (残留随 run_dir 走, 归档已有容错),
        不阻塞批结束。生产 8189 --cache-none 形态无此缓存持有。

        V1.13 波 3 T11 (D9): 清理坐标改 服务端输出根/<relpath(run_dir)>/intermediates,
        与 SaveLatent 写入位置一致 — 归档批重跑也能清到服务端侧的 intermediates.
        #51 E1: 写入坐标父壳清空后一并删除 (预建空壳/整批无 clip 不留残壳); 批次夹
        run_dir 本体永不删.
        同名碰撞说明: 若归档批与活动批 basename 一致 (e.g. 都叫 20260910_120000),
        本清理会同时删活动批的 intermediates — 同名碰撞本批不引入新机制, 调用方
        (重跑端点) 应保证归档前已 _archive_run 落走旧批, 活动批不会同期活批; 注释
        留痕, 后续若引入同名检测在此处接入.
        """
        server_root = getattr(self, "_server_output_dir", None) or self.output_dir
        run_rel = self._continuation_run_rel()
        if not server_root or not run_rel or not getattr(self, "run_dir", None):
            return
        write_intermediates = os.path.join(server_root, run_rel, "intermediates")
        # V1.13 T11-R: 双处清理 — run_dir/intermediates (T11-R 真机场景: latent 随归档
        # 整体搬走残留在 run_dir 下) + 写入坐标 intermediates (常规未搬位置)
        targets = [os.path.join(self.run_dir, "intermediates")]
        if os.path.normcase(write_intermediates) != os.path.normcase(targets[0]):
            targets.append(write_intermediates)
        for d in targets:
            for attempt in range(3):
                if not os.path.isdir(d):
                    break
                shutil.rmtree(d, ignore_errors=True)
                if not os.path.isdir(d):
                    break
                time.sleep(1.0)
            if os.path.isdir(d):
                leftovers = []
                for root, _dirs, files in os.walk(d):
                    leftovers.extend(os.path.join(root, f) for f in files)
                print("[H3Batch] S1 intermediates 清理残留 %d 个文件 (ComfyUI 缓存持有"
                      " latent 句柄, Windows 拒删): %s" % (len(leftovers),
                      ", ".join(os.path.basename(f) for f in leftovers[:6])), flush=True)
        # #51 E1: 删到父壳 — 写入坐标父壳 (归档回退的扁平 basename 目录) 清空即删;
        # 嵌套形态父壳即 run_dir 本体, 跳过 (rmdir 亦只删空目录, 有产物/账本不受影响)
        shell = os.path.dirname(write_intermediates)
        if (os.path.normcase(shell) != os.path.normcase(os.path.abspath(self.run_dir))
                and os.path.isdir(shell)):
            try:
                os.rmdir(shell)
            except OSError:
                pass

    def _continuation_enabled_now(self, shot_no):
        """S1 机制激活前提 (1.11b 波1 T2: 单签名无默认值, §二.4):
        拼接模式行为不变; 自定义按 self._seg_mode(shot_no - 1) 判定;
        仍须满足 continuation_enabled + run_dir.
        (run_dir 未建立 = rerun_shot_in_folder 等不落 run_dir 的路径, 不注入。)"""
        if self.mode == "自定义":
            try:
                i = int(shot_no or 0) - 1
                if i < 0 or self._seg_mode(i) != "拼接":
                    return False
            except (TypeError, ValueError):
                return False
        elif self.mode != "拼接":
            return False
        return (bool(getattr(self, "continuation_enabled", True))
                and bool(getattr(self, "run_dir", None)))

    def _continuation_patch_preflight(self):
        """V1.9 批 3 T3.3 触发矩阵 a: 段提交前预检 motion_context_sub 双 patch 状态
        (惰性安装语义, 参照 nodes._ensure_*_patch — 引擎侧提前到提交前, 失败可降级
        而不是提交后节点运行时炸段)。
        任一 patch is_applied() False → 尝试 apply_patch(); 返回 False 或抛异常
        (含子包 import 失败) → 记粘性失败原因 (本段及后续段全部降级尾帧直连,
        不重试, 批不断跑), 返回该原因; 全部通过返回 ""。
        幂等: 已粘性失败直接短路, 已生效不再安装。"""
        if self._continuation_patch_fail:
            return self._continuation_patch_fail
        try:
            from motion_context_sub import patch_layout, patch_payload
            for name, mod in (("patch_layout", patch_layout),
                              ("patch_payload", patch_payload)):
                if not mod.is_applied() and not mod.apply_patch():
                    raise RuntimeError("%s.apply_patch() 返回 False" % name)
        except Exception as exc:
            summary = ("%s: %s" % (type(exc).__name__, exc)).strip()[:160]
            self._continuation_patch_fail = "patch 自检失败: %s" % summary
            return self._continuation_patch_fail
        return ""

    def _audio_ref_context(self, prompt, shot_no, fresh=False):
        """每段一次: 读五键 + 备分轨参照 wav (让位探针/注入探针/生产同值复用).

        返回 {a_frames, taper_steps, split, vocals, background, wav, vae_link}.
        分轨总关 → wav/vae_link 恒 None (现行为零变化)。分轨开:
          ① 上段成片缺失 → 不产 wav, 回落现行为 (不得走轻量版: 轻量版读同一 mp4);
          ② 上段在 → 按子开关分离/轻量版挑段; 处理失败 → 轻量版; 再失败 → 回落现行为;
          ③ 音频 VAE 锚缺失 → 不产 wav, 回落现行为 (不让整条续接降级尾帧).
        fresh=True (探针路径) 强制重读, 生产侧单次消费后清缓存 — 同一段两次独立
        submit 仍各读一次文件 (submit 重读契约), 探针+生产共享同一次读取。
        """
        try:
            n = int(shot_no or 0)
        except (TypeError, ValueError):
            n = 0
        cache = getattr(self, "_audio_ref_ctx", None)
        if (not fresh and isinstance(cache, dict) and cache.get("run_dir") == self.run_dir
                and cache.get("shot") == n):
            return cache
        a_frames, taper_steps, split, vocals, background = _audio_continuation_params()
        sig = (a_frames, taper_steps, split, vocals, background)
        if (fresh and isinstance(cache, dict) and cache.get("run_dir") == self.run_dir
                and cache.get("shot") == n and cache.get("sig") == sig):
            # 同段同配置重试: 复用已产 wav (探针失败段分离产物保留复用)
            return cache
        ctx = {"run_dir": self.run_dir, "shot": n, "sig": sig,
               "a_frames": a_frames, "taper_steps": taper_steps,
               "split": split, "vocals": vocals, "background": background,
               "wav": None, "vae_link": None}
        self._audio_ref_ctx = ctx
        if not split or n < 2:
            return ctx
        try:
            shots = self._parse_shots(self._parse_rows())
            prev = shots[n - 2]
            sid = prev.get("ID") or ("shot_%03d" % (n - 1))
        except Exception as exc:
            print("[H3Batch] 分轨参照跳过: 段%d 上段序号解析失败 (%s), 回落尾窗继承"
                  % (n, exc), flush=True)
            return ctx
        info = self._load_manifest().get(sid) or {}
        files = info.get("files") or []
        mp4 = self._video_path_old(files, info.get("run_dir") or self.run_dir)
        if not mp4:
            print("[H3Batch] 分轨参照跳过: 段%d 上段成片未落盘 (%s), 回落尾窗继承"
                  % (n, ", ".join(files) or "无产物记录"), flush=True)
            return ctx
        va_nid = _find_first_node(prompt, "VAEDecodeAudio")
        link = (prompt.get(va_nid, {}).get("inputs", {}).get("vae")
                if va_nid is not None else None)
        if not (isinstance(link, list) and len(link) == 2):
            print("[H3Batch] 分轨参照跳过: 段%d 音频 VAE 锚缺失 (VAEDecodeAudio.vae 未连), "
                  "回落现行为" % n, flush=True)
            return ctx
        seg = "seg_%05d.wav" % (n - 1)
        # E8: 本机 ComfyUI annotated_filepath 注解剥离差一字符 ([output] 实长 8 用
        # name[:-9]), 带注解路径恒 "Invalid audio file"; 且 ComfyUI 只读 input 根 —
        # 参照 wav 按既有中间帧范式落 server_input_dir/intermediates/<run_base>/.
        run_base = os.path.basename(self.run_dir) if getattr(self, "run_dir", None) else "rerun"
        rel = os.path.join("intermediates", run_base, seg)
        wav_abs = os.path.join(self.server_input_dir, rel)
        os.makedirs(os.path.dirname(wav_abs), exist_ok=True)
        import audio_ref_pick
        import audio_ref_separate

        out = None
        if vocals or background:
            try:
                out = audio_ref_separate.separate_and_pick(mp4, wav_abs, vocals, background)
                if out is None:
                    print("[H3Batch] 分轨参照降级: 段%d 分离失败, 改用轻量版挑段"
                          % n, flush=True)
            except Exception as exc:
                out = None
                print("[H3Batch] 分轨参照降级: 段%d 分离失败 (%s), 改用轻量版挑段"
                      % (n, exc), flush=True)
            if out is None:
                try:
                    out = audio_ref_pick.pick_reference(mp4, wav_abs)
                except Exception as exc:
                    print("[H3Batch] 分轨参照降级: 段%d 轻量版挑段异常 (%s)"
                          % (n, exc), flush=True)
                    out = None
        else:
            try:
                out = audio_ref_pick.pick_reference(mp4, wav_abs)
            except Exception as exc:
                print("[H3Batch] 分轨参照降级: 段%d 轻量版挑段异常 (%s)"
                      % (n, exc), flush=True)
                out = None
        if out is None:
            print("[H3Batch] 分轨参照降级: 段%d 轻量版挑段失败, 回落尾窗继承"
                  % n, flush=True)
            return ctx
        # stock LoadAudio 按 input 根解析裸相对路径; 不拼 [output] 注解 (本机注解
        # 剥离差一字符恒失效, 见上).
        ctx["wav"] = rel.replace(os.sep, "/")
        ctx["vae_link"] = list(link)
        return ctx

    def _continuation_anchor_ok(self, prompt, audio_ctx=None):
        """V1.9 批 3 T3.3 触发矩阵 b: 模板锚点探测 (让位判定用, 先于真注入)。
        试注入到图深副本上 (哨兵 id 空间, 不占 self._fresh_id 序列, 不改入参);
        任一锚点缺失 (SamplerCustomAdvanced/BasicGuider/VAEDecode 双流/视频汇/
        连线不完整) → False → 本段不让位 + 不注入, 尾帧直连照常。
        分轨参数与生产同值透传 (audio_ctx 由 _audio_ref_context 每段一次产出)。"""
        probe_prompt = json.loads(json.dumps(prompt))
        sentinel = iter(range(10 ** 9, 10 ** 9 + 8))
        ctx = audio_ctx if audio_ctx is not None else self._audio_ref_context(prompt, None)
        _, arep = _inject_continuation_apply(
            probe_prompt, lambda: next(sentinel), "", 0,
            audio_context_length=ctx["a_frames"], audio_taper_steps=ctx["taper_steps"],
            audio_ref_wav=ctx["wav"], audio_vae_link=ctx["vae_link"])
        return bool(arep["injected"])

    def _continuation_load_ready(self, shot_no, prompt=None):
        """段 shot_no 是否走 latent 续接 (V1.9 批 3 T3.3 触发矩阵, 逐段判定):
        前提: 拼接 + 开关开 + run_dir (矩阵 c) + 段号 >= 2;
        矩阵 d: 上段固定槽位 latent 已落盘 (先查 — patch 预检有全局安装副作用,
        只在真要续接时才值得跑);
        矩阵 a: motion_context_sub 双 patch 预检 (粘性失败即降级);
        矩阵 b: 传 prompt 时探测模板锚点 (让位判定在 apply_shot_concat 内先于
        真注入 — 缺锚点段不让位, prev_frame 尾帧直连照常)。
        任一不过 → False (让位回落尾帧图路径, 每段重新判定 = 自然恢复)。"""
        # 1.13h 2c③: 段级换 VAE/UNET (本段自身或前驱) → latent 不可跨空间续接;
        # 不加载 latent 即 prev_frame 不让位 → 降级尾帧直连 (_apply_continuation 同款 gate)
        if getattr(self, "_seg_swap_reason", ""):
            return False
        if not self._continuation_enabled_now(shot_no):
            return False
        try:
            n = int(shot_no or 0)
        except (TypeError, ValueError):
            return False
        if n < 2:
            return False
        if not os.path.isfile(self._continuation_clip_path(n - 1)):
            return False
        if self._continuation_patch_preflight():
            return False
        if prompt is not None:
            ctx = self._audio_ref_context(prompt, shot_no, fresh=True)
            if not self._continuation_anchor_ok(prompt, ctx):
                return False
        return True

    def _apply_continuation(self, prompt, shot_no):
        """S1 主入口 (_run_one 内、_prune_orphans 后调用):
        - 拼接+开关开: 每段图追加 SaveLatent (clip_index=段号, 固定槽位)
        - 且触发矩阵全过 (a patch/d latent/b 锚点): 注入 LoadLatent+MotionContext+Trim
          (mode=latent); 首段只落盘 (mode=save)
        - 任一触发降级: 不注入, 让位开关位恢复走 9 号槽尾帧直连 (mode=tail_frame +
          downgrade_reason), 仍照常出片落盘, 批不断跑; 下段重新判定 (自然恢复)
        每段覆盖 self._continuation_report (供 T3.3 降级矩阵/审片报告消费)。
        非拼接/开关关 → 原图原样返回 (开关关按矩阵 c 记 tail_frame+原因)。"""
        try:
            shot_index = int(shot_no or 0)
        except (TypeError, ValueError):
            shot_index = 0
        if not self._continuation_enabled_now(shot_no):
            # 触发矩阵 c: 用户关闭开关 → 不走 latent, 尾帧直连 + mode=tail_frame 明示;
            # 非拼接/无 run_dir (rerun 等不落 run_dir 的路径) → 机制不适用 (off), 不属降级
            # 1.11b 波1 T2: 自定义模式按 _seg_mode(shot_index - 1) 判定 (本段勾选), 否则写 off 而非 tail_frame
            if (self.mode == "拼接" and getattr(self, "run_dir", None)
                    and not self.continuation_enabled):
                mode, reason = "tail_frame", "开关关闭"
                print("[H3Batch] 续接降级: 段%d %s" % (shot_index, reason), flush=True)
            elif (self.mode == "自定义" and getattr(self, "run_dir", None)
                    and shot_index >= 2
                    and self._seg_mode(shot_index - 1) == "拼接"
                    and not self.continuation_enabled):
                mode, reason = "tail_frame", "开关关闭"
                print("[H3Batch] 续接降级: 段%d %s" % (shot_index, reason), flush=True)
            else:
                mode, reason = "off", ""
            self._continuation_report = {"active": False, "shot_index": shot_index,
                                         "clip_index": None, "mode": mode,
                                         "nodes": [], "reason": reason,
                                         "downgrade_reason": reason}
            return prompt
        if getattr(self, "_seg_swap_reason", ""):
            # 1.13h 2c③: 段级换 VAE/UNET (本段自身或前驱) → latent 空间不同, 既不入盘
            # (SaveLatent 会把新空间 latent 喂给后段) 也不加载; 降级尾帧直连 + 记 reason.
            reason = self._seg_swap_reason
            print("[H3Batch] 续接降级: 段%d %s" % (shot_index, reason), flush=True)
            self._continuation_report = {"active": False, "shot_index": shot_index,
                                         "clip_index": None, "mode": "tail_frame",
                                         "nodes": [], "reason": reason,
                                         "downgrade_reason": reason}
            return prompt
        # #51 E1: 前缀 = relpath(run_dir, 输出根) 完整相对路径 (嵌套 run_subdir 不丢项目夹段)
        run_rel = self._continuation_run_rel()
        prefix = os.path.join(run_rel, *CONTINUATION_SUBDIR, "clip")
        nodes = []
        reasons = []
        prompt, srep = _inject_continuation_save(prompt, self._fresh_id, prefix,
                                                 shot_index)
        if srep["injected"]:
            nodes.append(srep["save_nid"])
        else:
            reasons.append(srep["reason"])
        # 矩阵 a (patch 粘性) + d (latent 缺失) 在 _continuation_load_ready 内判定
        load_ready = self._continuation_load_ready(shot_no)
        applied_latent = False
        downgrade_reason = ""
        if load_ready:
            # V1.13 T11-R2: 读取路径按写入坐标可读性分流 — 归档形态 latent 随 run_dir
            # 搬走后, 相对输出根的写入前缀 LoadLatent 读不到 (真机 8190: h3_motion_context
            # '既不是文件也不是目录'); 写入坐标读不到时改喂 run_dir 绝对目录,
            # 正常形态 (latent 在写入坐标) 保持原设计相对前缀 (t32 锁)。
            # 配套: rerun 端点 server_output_dir 已改传真实输出根 (body output_dir 仅作
            # manifest 定位), 归档 rerun 的写入坐标不再被归档目录错位 (D9-R)
            _fn = "clip_%05d.safetensors" % int(shot_index - 1)
            if os.path.isfile(os.path.join(self._continuation_ctx_dir(), _fn)):
                lpath = os.path.join(run_rel, *CONTINUATION_SUBDIR)
            else:
                lpath = os.path.join(self.run_dir, *CONTINUATION_SUBDIR)
            ctx = self._audio_ref_context(prompt, shot_index)
            prompt, arep = _inject_continuation_apply(
                prompt, self._fresh_id, lpath, shot_index - 1,
                audio_context_length=ctx["a_frames"], audio_taper_steps=ctx["taper_steps"],
                audio_ref_wav=ctx["wav"], audio_vae_link=ctx["vae_link"])
            self._audio_ref_ctx = None  # 单次消费: 下次 submit/重试重新读文件
            if arep["injected"]:
                applied_latent = True
                nodes.extend([arep["nodes"]["load"], arep["nodes"]["mc"],
                              arep["nodes"]["trim"]])
            else:
                # 触发矩阵 b: 工作流无可注入锚点 → 降级 (原因 = 注入报告 reason)
                downgrade_reason = arep["reason"]
                reasons.append(downgrade_reason)
        elif shot_index >= 2:
            pf = self._continuation_patch_fail
            downgrade_reason = pf if pf else "latent 缺失: %s" % (
                self._continuation_clip_path(shot_index - 1))
            reasons.append(downgrade_reason)
        mode = ("latent" if applied_latent
                else ("save" if shot_index <= 1 else "tail_frame"))
        if not applied_latent and shot_index <= 1 and not srep["injected"]:
            # D15: 首段存底注入失败 = 真实降级 (无 latent 可续) — mode 如实标 tail_frame,
            # 并把注入失败原因写进 downgrade_reason (否则审片报告只显示"尾帧降级"无原因)
            mode = "tail_frame"
            downgrade_reason = srep["reason"]
        if downgrade_reason:
            print("[H3Batch] 续接降级: 段%d %s" % (shot_index, downgrade_reason), flush=True)
        self._continuation_report = {
            "active": True,
            "shot_index": shot_index,
            # latent: 续接源(上段)编号; save/tail_frame: 本段落盘编号
            "clip_index": (shot_index - 1) if applied_latent else shot_index,
            "mode": mode,
            "nodes": nodes,
            "reason": "; ".join(r for r in reasons if r),
            "downgrade_reason": downgrade_reason,
        }
        return prompt

    def _continuation_manifest_fields(self):
        """V1.9 批 3 T3.3 留痕: manifest 段键 continuation = {mode, downgrade_reason}
        (success 段也记 — latent/save 无 reason, tail_frame 降级带 reason;
        off = 机制不适用/未执行, 不记键)。接口对齐批 2 manifest 资源节的段内键模式,
        不动 _RESERVED_KEYS。审片报告补列 = T3.7 消费。"""
        rep = getattr(self, "_continuation_report", None)
        if not isinstance(rep, dict) or rep.get("mode") not in ("latent", "save",
                                                                "tail_frame"):
            return {}
        return {"continuation": {"mode": rep.get("mode"),
                                 "downgrade_reason": rep.get("downgrade_reason", "")}}


    def _csv_stem(self):
        return os.path.splitext(os.path.basename(getattr(self, "csv_path", "") or ""))[0]

    # ----- 1.13h 第三波 T1/T2: 段级覆盖侧车读点 (真相源 run_dir/_seg_overrides.json) -----

    def _seg_override_for(self, sid):
        """该段侧车覆盖项 dict; run_dir 未定/该段未覆盖 → {}."""
        run_dir = getattr(self, "run_dir", None)
        if not run_dir or not sid:
            return {}
        return _seg_overrides_merge_for_sid(run_dir, self._csv_stem(), sid)

    def _seg_dur_override(self, sid):
        """该段侧车 段落时长 (秒); 无覆盖 → None."""
        return self._seg_override_for(sid).get("段落时长")

    def _seg_duration_record(self, seg_override):
        """侧车生效时长留痕 (manifest[sid] 用): {秒, 帧}; 无覆盖/非法 → None (不写键)."""
        ov_dur = (seg_override or {}).get("段落时长")
        if ov_dur is None or not str(ov_dur).strip():
            return None
        try:
            frames = _seg_duration_frames(ov_dur)
        except ShotError as e:
            print("[H3Batch] 段级时长覆盖非法, 不写生效留痕: %s" % e, flush=True)
            return None
        return {"seg_duration_sec": float(str(ov_dur).strip()),
                "seg_duration_frames": frames}

    def _row_dur_frames_eff(self, row, idx):
        """该行生效时长帧数 (侧车 > CSV). idx 用于缺 ID 时推 sid (与调用方同口径)."""
        sid = row.get("ID") or ("shot_%03d" % (idx + 1))
        return _row_duration_frames(row, self._seg_dur_override(sid))

    def _merge_seg_pool(self, pool, seg_override):
        """1.13h 2b: 段级池覆盖合并 — 仅替换覆盖项涉及的 kind/槽, 返回池副本.

        语义 = **批级池区上的段级替换** (非 CSV 行级); 未覆盖部分共享原引用.
        无覆盖 → 原对象 (调用方/既有桩测零变化). 覆盖素材走既有资产解析口径
        (_resolve_file) 做存在性校验 — 缺 → ShotError.
        """
        ov = (seg_override or {}).get("pool")
        if not isinstance(ov, dict) or not ov:
            return pool
        merged = dict(pool)
        for kind, slots in ov.items():
            if not isinstance(slots, dict) or not slots:
                continue
            base = dict(merged.get(kind) or {})
            for slot, val in slots.items():
                if val:
                    self._resolve_file(val)  # 存在性校验 (既有解析口径)
                key = slot
                if slot not in base:
                    try:
                        key = int(slot)   # 侧车 JSON 槽号是字符串; 池内槽号是 int
                    except (TypeError, ValueError):
                        pass
                base[key] = val
            merged[kind] = base
        return merged

    # ----- 批 K: 分镜级动态素材池 (契约 #12 seg_pools) -----

    def _seg_pools_for_row(self, row):
        """批 K: 取该行的段级池条目 (见 _seg_pools_entry 的键域契约)。"""
        return _seg_pools_entry(getattr(self, "_seg_pools", None), row)

    def _merge_seg_pools_entry(self, pool, pu, entry):
        """批 K: 段级池条目并入逐镜副本的 pool / pool_usage → (pool_m, pu_m, seg_slots, seg_descs)。

        段级条目形态钉死对齐 pool_usage: {Picture:{槽:{media,usages}}, ...};
        段槽与批级池同槽空间 — 跨段同槽号可放不同素材, 段池值赢 (段级一等槽)。
        返回 seg_slots = {(kind, slot)} 本条目引入的槽 — union_pool 隔离据此剔除
        (段池不进批级并集, 防 _detect_concat_mode 隐式翻模板族, 契约 #12)。
        返回 seg_descs = {kind: {槽号: desc}} — #83 段级槽的场景文字摘要 (复刻句替换目标);
        无 desc 的槽不带 (空值不外扩 → 引擎侧回落 #76 现状逐字)。
        无条目 → (原对象, 原对象, set(), {}) 零变化。
        """
        seg_slots = set()
        seg_descs = {}
        if not isinstance(entry, dict) or not entry:
            return pool, pu, seg_slots, seg_descs
        pool_m = {k: dict(pool.get(k) or {}) for k in ("Picture", "Video", "Audio")}
        pu_m = {k: {s: list(v) for s, v in (pu.get(k) or {}).items()}
                for k in ("Picture", "Video", "Audio")}
        for kind in ("Picture", "Video", "Audio"):
            slots = entry.get(kind) or {}
            if not isinstance(slots, dict) or not slots:
                continue
            base_p = pool_m[kind]
            base_u = pu_m[kind]
            for slot, spec in slots.items():
                if not isinstance(spec, dict):
                    continue
                media = spec.get("media") or ""
                if not media:
                    continue  # 无素材的槽无接线意义 (与 _merge_seg_pool 空值口径同)
                try:
                    key = int(slot)   # JSON 槽号是字符串; 池内槽号是 int
                except (TypeError, ValueError):
                    continue
                base_p[key] = media
                usages = [u for u in (spec.get("usages") or []) if u]
                base_u[key] = list(usages)
                seg_slots.add((kind, key))
                desc = spec.get("desc")
                if isinstance(desc, str) and desc.strip():
                    seg_descs.setdefault(kind, {})[key] = desc
        return pool_m, pu_m, seg_slots, seg_descs

    # ----- 1.13h 第三波 T4: 段级资源差分 (2c) -----

    # 段级换以下槽 → latent 空间变化, 该段及后邻段均不能跨空间续接
    _SEG_SWAP_KEYS = ("unet", "vae_video", "vae_audio")

    def _seg_family_guard(self, prompt, ov_res):
        """家族跨族硬拒 (渲染期防御; 双点位之二, 防手改侧车/旧版侧车).

        原料 = 图中 UNETLoader 现值 + _family_match (与批级 :3819 同口径, 差别仅在
        批级记 reason 不落地, 段级直接抛 — 段级覆盖无声不生效即 D9 静默降级).
        V1.14 K1 修复: 判型与批级同款改真实工作流结构 (_template_mode) — t2v/i2v
        模板放行跨族覆写, 仅 ref2v/fl2v 真结构硬拒; 无 workflow_path 退回旧口径.
        """
        new_unet = (ov_res or {}).get("unet")
        if not isinstance(new_unet, str) or not new_unet.strip():
            return
        old_name = ""
        for nid in sorted(prompt.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
            n = prompt[nid]
            if n.get("class_type") == "UNETLoader":
                old_name = (n.get("inputs") or {}).get("unet_name", "") or ""
                break
        new_ref, new_fl = _family_match(new_unet.lower())
        if self.workflow_path:
            tmode = _template_mode(self.workflow_path)
            conflict = ((tmode == "ref2v" and new_fl and not new_ref) or
                        (tmode == "fl2v" and new_ref and not new_fl))
        else:
            old_ref, old_fl = _family_match(str(old_name).lower())
            conflict = (old_ref and new_fl) or (old_fl and new_ref)
        if conflict:
            raise ShotError("段级资源覆盖跨族 (ref2v↔fl2v 互斥): 模板原值 %r, 覆盖值 %r"
                            % (old_name, new_unet))

    def _seg_lora_alias_map(self, prompt, ov_lora):
        """段级 lora 覆盖键按 convert 同口径别名解析 (键 = 模板声明名 → 图内实际名).

        差分层在 convert 之后 (那里 _resolve_lora_aliases 已把图内 lora_name 换成磁盘名),
        覆盖键仍是模板声明名 → 不解析会 unmatched。folder_paths 不可用 (离线) → 原样返回。
        """
        if folder_paths is None or not hasattr(folder_paths, "get_filename_list"):
            return ov_lora
        names = set()
        for n in prompt.values():
            if isinstance(n, dict):
                ln = (n.get("inputs") or {}).get("lora_name")
                if isinstance(ln, str):
                    names.add(ln)
        need = [k for k in ov_lora if k not in names]
        if not need:
            return ov_lora
        try:
            installed = folder_paths.get_filename_list("loras")
        except Exception:
            return ov_lora
        out = dict(ov_lora)
        for k in need:
            resolved, candidates = _resolve_lora_alias(k, installed)
            if not candidates and resolved != k:
                out[resolved] = out.pop(k)
                print("[H3Batch] 段级 LoRA 覆写键自动匹配: %s → %s" % (k, resolved), flush=True)
        return out

    def _apply_seg_resource_diff(self, prompt, seg_override, sid=""):
        """段级资源差分应用层: 批级已应用之上再覆盖 (调用点 = 段深拷贝之后).

        `lora` → 复用 _apply_lora_overrides 语义 (强度/换名/禁用); `resources` →
        复用 _apply_overrides 语义 (unet/clip/vae_*)。报告存 self._last_seg_inject_report
        (manifest[sid]._inject_seg) + 引擎日志。无覆盖 → 原 prompt, 报告 None (零变)。
        """
        ov_res = (seg_override or {}).get("resources")
        ov_lora = (seg_override or {}).get("lora")
        has_res = isinstance(ov_res, dict) and bool(ov_res)
        has_lora = isinstance(ov_lora, dict) and bool(ov_lora)
        if not (has_res or has_lora):
            self._last_seg_inject_report = None
            return prompt
        report = {}
        if has_res:
            self._seg_family_guard(prompt, ov_res)   # 跨族 → ShotError (硬拒)
            prompt, res_rep = _apply_overrides(prompt, ov_res,
                                               workflow_path=self.workflow_path)
            applied = {k: v for k, v in (res_rep.get("applied") or {}).items() if ov_res.get(k)}
            for w in res_rep.get("warnings") or []:
                print("[H3Batch] 段级资源覆盖 %s 警告: %s" % (sid, w), flush=True)
            report["resources"] = applied
        if has_lora:
            ov_lora_eff = self._seg_lora_alias_map(prompt, ov_lora)
            prompt, lora_rep = _apply_lora_overrides(prompt, ov_lora_eff)
            entries = []
            for e in lora_rep.get("applied") or []:
                item = dict(e)
                ov = ov_lora_eff.get(e["lora"]) or {}
                if e["action"] == "strength":
                    item["strength"] = ov.get("strength")
                elif e["action"] == "name":
                    item["name"] = ov.get("name")
                elif e["action"] == "bypass":
                    item["disabled"] = True
                entries.append(item)
            report["lora"] = entries
            if lora_rep.get("unmatched"):
                report["lora_unmatched"] = list(lora_rep["unmatched"])
        report["fingerprint"] = _compute_inject_fingerprint(
            [], overrides=ov_res if has_res else None,
            lora_overrides=(ov_lora_eff if has_lora else None))
        self._last_seg_inject_report = report
        print("[H3Batch] 段级资源覆盖 %s: %s" % (sid, json.dumps(report, ensure_ascii=False)),
              flush=True)
        return prompt

    def _seg_prompt_text_and_scope(self, seg_override):
        """2d 生效提示词 + 作用域: 显式 rerun 文本 > 侧车 prompt_text > CSV.

        配对规则 (S-2): 文本与 scope 恒同源 — 显式文本配显式 scope (缺省 "final");
        侧车文本配侧车 prompt_text_scope 键 (缺省/非法 → "final", 老侧车保守)。
        返回 (text|None, scope); 无覆盖 → (None, "final")。
        """
        explicit = getattr(self, "_current_prompt_override", None)
        if explicit:
            return explicit, getattr(self, "_current_prompt_text_scope", None) or "final"
        ov = seg_override or {}
        scope = ov.get("prompt_text_scope")
        return ov.get("prompt_text") or None, ("segment" if scope == "segment" else "final")

    def _seg_prompt_text(self, seg_override):
        """2d 生效提示词: 显式 rerun 文本 > 侧车 prompt_text > CSV (无 → None, 不替换)."""
        return self._seg_prompt_text_and_scope(seg_override)[0]

    def _seg_manifest_fields(self):
        """段级覆盖留痕 (并入 manifest[sid] 替换字典 — 防整字典替换丢键, 同 _timing_fields)"""
        if not getattr(self, "_last_seg_override", None):
            return {}
        out = {"seg_overrides_active": True}
        if self._last_seg_inject_report:
            out["_inject_seg"] = self._last_seg_inject_report
        if getattr(self, "_seg_swap_own", False):
            out["seg_resource_swap"] = True
        return out

    def _prev_seg_swap_reason(self, i):
        """前驱段 manifest seg_resource_swap 标记 → 该标记说明 (无 → ""). i = 本段 0-based 索引."""
        if i is None or i <= 0:
            return ""
        try:
            shots = self._parse_shots(self._parse_rows())
        except Exception:
            return ""
        if i - 1 >= len(shots):
            return ""
        prev_sid = (shots[i - 1].get("ID") or "").strip()
        if not prev_sid:
            return ""
        try:
            m = self._load_manifest() or {}
        except Exception:
            return ""
        seg = m.get(prev_sid)
        if isinstance(seg, dict) and seg.get("seg_resource_swap"):
            return ("前驱段 %s 换 VAE/UNET (latent 空间不同, 不跨空间续接)" % prev_sid)
        return ""

    def _seg_swap_skip(self, seg_override, i):
        """本段跳续接原因: 自身换 VAE/UNET 优先, 否则读前驱标记; 无 → "" (同时写 _seg_swap_own)."""
        res = (seg_override or {}).get("resources")
        if isinstance(res, dict):
            hit = [k for k in self._SEG_SWAP_KEYS if res.get(k)]
            if hit:
                self._seg_swap_own = True
                return "段级换 %s (latent 空间不同, 不跨空间续接)" % "/".join(hit)
        self._seg_swap_own = False
        return self._prev_seg_swap_reason(i)

    def _timing_fields(self):
        t_end = time.time()
        fields = {"t_start": round(self._shot_t0, 3), "t_end": round(t_end, 3),
                  "elapsed_sec": round(t_end - self._shot_t0, 1),
                  "engine_version": ENGINE_VERSION}
        # 1.13h 2a: 侧车段级时长生效时并入留痕 (无覆盖段不写键, 旧 manifest 零变)
        _sd = getattr(self, "_last_seg_duration", None)
        if _sd:
            fields.update(_sd)
        return fields

    def _invariant_gate(self, prompt, sid):
        """1.14 P5: 提交前六不变量自检关口 (T-B 报告 :40)。

        默认 shadow: 违规只记录 (self._invariant_report + 日志), 返回 None 放行 (零回归);
        H3_INVARIANT_POLICY=block: 有违规 → 返回 "invariant:<Ix>" (调用方不 POST, 段 failed)。
        declared_ids = 本段续接注入节点 (H3MotionContextSaveLatent 尾挂为终端节点,
        设计允许不在 Save 根反向可达集 — 见 _apply_continuation 注释)。
        返回 None (放行) 或 "invariant:<Ix>" (拦截)。
        """
        policy = _read_invariant_policy()
        _cont = getattr(self, "_continuation_report", None) or {}
        declared = [str(x) for x in (_cont.get("nodes") or [])]
        violations = check_invariants(
            prompt,
            template=getattr(self, "_template", None),
            schema=getattr(self, "_obj_info", None),
            opaque_snapshot=getattr(self, "_opaque_snapshot", None),
            declared_ids=declared,
        )
        self._invariant_report = {"policy": policy, "violations": violations}
        if not violations:
            return None
        _brief = "; ".join("%s %s" % (v["invariant"], v["detail"]) for v in violations[:3])
        if policy == "block":
            print("[H3Batch] %s 不变量自检 block: %d 处违规 → 段失败(不提交): %s"
                  % (sid, len(violations), _brief), flush=True)
            return "invariant:%s" % violations[0]["invariant"]
        print("[H3Batch] %s 不变量自检 shadow: %d 处违规(只记录, 不拦截): %s"
              % (sid, len(violations), _brief), flush=True)
        return None

    def _build_prompt_body(self, prompt):
        """V1.11 批 5 P0 (F-LIVE 生产化透传): 组装 POST /prompt body.
        live_client_id 非空 → client_id 替换为 GUI 自身 sid + 增 extra_data
        {preview_method="auto", client_id=GUI sid} (execution.py:731 set_preview_method
        + :736-737 server.client_id 覆写, 让 ws preview_state 路由到 GUI sid).
        live_client_id 空 → payload 逐字节回归锁 (现状: {prompt, client_id: 引擎自造},
        不出现 extra_data 键)."""
        body = {"prompt": prompt, "client_id": self.client_id}
        _lcv = getattr(self, "live_client_id", "") or ""
        if _lcv:
            body["client_id"] = _lcv
            body["extra_data"] = {"preview_method": "auto", "client_id": _lcv}
        return body

    def _run_one(self, i, row, pool, prev_frame, next_frame=None, cast_plan=None,
                 shot_no=None, cum_ms=None):
        """执行单段, 返回 (ok, files, err)。不写 manifest, 由调用方处理。
        V1.7 B2: cast_plan=None (默认) → 现状行为逐字节不变; 显式传时透传给 apply_shot_*
        (F1 一票否决: 默认缺省路径不变, 新参数仅在 cast 路径下使用)
        V1.11 批 1 T3: 端点重跑显式种子从 self._current_seed_override 读 (兼容旧 stub
        不改签名; 调用方在 _rerun_generate_shot_in_folder 内 set/del 配对). None 时
        走原 CSV/void 路径, 非 None 时**优先级最高** (覆盖 CSV seed + void seed_override).
        中断响应: 循环顶查 _stop (与主循环顶和 _wait_shot 的 2s 响应习惯一致);
                 retry sleep 拆为可中断分段, _stop 命中立即提前结束。
        """
        sid = row.get("ID") or ("shot_%03d" % (i + 1))
        last_err = ""
        # V1.10 批2 T2: void 段重跑新 seed (D4) — 用户作废段 status=success + review=void,
        # 重跑时不读 CSV 种子列, 服务端随机新 seed; 写 manifest seed_override 落盘
        # (供审计/T3 报表) + 主循环的 _last_seed 透传为新 seed (避免覆盖丢失).
        # 衔接方式: _run_one 独立 load/save 写盘, 另用 self._last_seed_override 边带传给
        # run() 成功段 dict 构造点 (主循环内存 dict 由 run() 自管, 不接受外部覆盖).
        # 重写每次进入 _run_one 都做: 再次作废会再生成新 seed 覆盖 (PRD"放行前再次作废"语义).
        _void_seed_override = None
        try:
            _mm = self._load_manifest()
            if (_mm.get(sid) or {}).get("review") == "void":
                _void_seed_override = random.randrange(2 ** 31)
                _mm[sid]["seed_override"] = _void_seed_override
                self._save_manifest(_mm)
                print("[H3Batch] %s 作废重跑, 新 seed: %s" % (sid, _void_seed_override),
                      flush=True)
        except Exception:
            # void 检测是优化路径, load/save 失败不阻塞本段正常跑 (回退到 CSV seed).
            _void_seed_override = None
        self._last_seed_override = _void_seed_override
        # 1.13h 第三波 T2: 段级覆盖侧车 = 本段装配的时长/素材/提示词生效源;
        # 时长生效留痕 (_timing_fields 并入 manifest[sid]); 无覆盖段零变.
        _seg_override = self._seg_override_for(sid)
        self._last_seg_duration = self._seg_duration_record(_seg_override)
        # 1.13h 2c: 段级覆盖现场 — 资源差分报告 / 换 VAE-UNET 跳续接原因 (含前驱标记)
        self._last_seg_override = _seg_override
        self._last_seg_inject_report = None
        self._seg_swap_reason = self._seg_swap_skip(_seg_override, i)
        if self._seg_swap_own:
            print("[H3Batch] 段级换 VAE/UNET %s: 跳续接注入 + 降级尾帧锚" % sid, flush=True)
        for attempt in range(self.retries + 1):
            # 中断检查: 与主循环顶 (run() ~3849) 和 _wait_shot 的 stop 响应习惯一致
            # cancel 端点已 _stop.set() 时, 跳出重试不提交新 prompt, 与"interrupted"分支同口径返回
            if self._stop.is_set():
                print("[H3Batch] %s 检测到停止信号, 跳过 attempt %d" % (sid, attempt + 1), flush=True)
                return False, [], "用户中断"
            try:
                # 批 A6 T4: 种子列空时改用 random.randrange(2**31) — 均匀分布 [0, 2**31),
                # 不再依赖 time.time()*1000 % 2**31 (毫秒取模串行会撞值).
                seed = random.randrange(2 ** 31)
                seed_raw = row.get("种子")
                if seed_raw not in (None, ""):
                    try:
                        parsed = int(float(seed_raw))
                    except ValueError:
                        parsed = 0
                    if parsed:
                        seed = parsed
                    elif seed_raw.strip() != "0":
                        print("[H3Batch] %s 种子 '%s' 无法解析, 改用随机种子" % (sid, seed_raw), flush=True)
                # V1.10 批2 T2: void 重跑 seed 覆盖 (D4) — 已在进入 _run_one 前算出 _void_seed_override
                # (写入 manifest. seed_override); 此处直接覆盖 seed 变量, 不读 CSV 种子列.
                if _void_seed_override is not None:
                    seed = _void_seed_override
                # V1.11 批 1 T3: 端点重跑显式 seed — 优先级最高, 覆盖 void override + CSV.
                # 从 self 读 (调用方在 _rerun_generate_shot_in_folder 内 set/del), 保持
                # _run_one 签名不变 → 旧测试桩 (FolderRerunFake 等) 无需改动.
                _explicit_seed = getattr(self, "_current_seed_override", None)
                if _explicit_seed is not None:
                    seed = _explicit_seed
                # #78 A 路径: 生效文本与 scope 同源读出 (显式文本配显式 scope;
                # 侧车文本配侧车 scope; 配对规则 S-2, 严禁混搭)
                _prompt_ov, _prompt_ov_scope = self._seg_prompt_text_and_scope(_seg_override)
                # scope=segment: 段词写回本段运行时 row 副本 → 装配前参与 used 扫描/
                # 富化/六字段, 最终提示词自然=装配全文 (不动原 CSV/manifest)
                _row_eff = row
                if _prompt_ov and _prompt_ov_scope == "segment":
                    _row_eff = dict(row)
                    _row_eff["prompt"] = _prompt_ov
                # 1.11b 波1 T2: A 类逐段化 — 自定义按 _seg_mode(i) 判定, 分镜/拼接零回归
                # 1.13h 第三波: 无覆盖时保持原调用签名 (既有桩测/调用方零感知)
                _seg_kw = {"seg_override": _seg_override} if _seg_override else {}
                if self._seg_mode(i) == "拼接":
                    prompt = self.apply_shot_concat(self._prompt, _row_eff, pool, prev_frame, next_frame,
                                                    cast_plan=cast_plan,
                                                    shot_no=shot_no, cum_ms=cum_ms, **_seg_kw)
                else:
                    prompt = self.apply_shot_pool(self._prompt, _row_eff, pool, cast_plan=cast_plan,
                                                   shot_no=shot_no, cum_ms=cum_ms, **_seg_kw)
                # V1.11 批 3 T1: 改词重跑 — scope=final (默认) 保持装配后整段替换
                # (所见即所发, 不与 CSV 词再合并); scope=segment 已在装配前生效,
                # 不再整段替换 (_last_final_prompt=装配全文).
                # 1.13h 2d: 优先级 显式 rerun 文本 > 侧车 prompt_text > CSV (无 → 不替换)
                if _prompt_ov and _prompt_ov_scope != "segment":
                    self._apply_prompt_text_override(prompt, _prompt_ov)
                prompt = self._prune_orphans(prompt)
                # V1.9 批 3 T3.2: S1 注入必须在孤儿剪枝后 — SaveLatent 是 OUTPUT_NODE
                # 但非 SaveVideo 反向可达, 先注入会被 _prune_orphans 剪掉
                prompt = self._apply_continuation(
                    prompt, shot_no if shot_no is not None else i + 1)
                self._inject_seed(prompt, seed)
                # 输出文件名带种子: seg01_70929970_00001_.mp4 (SaveVideo 的计数后缀保留)
                for node in prompt.values():
                    if node["class_type"] == "SaveVideo":
                        prefix = node["inputs"].get("filename_prefix", "")
                        if prefix:
                            node["inputs"]["filename_prefix"] = prefix + "_" + str(seed)
                # 1.14 P5: 提交前六不变量自检 (T-B 落点: _prune_orphans 后、POST 前);
                # shadow 只记录, block 违规短路 (不 POST, 段 failed "invariant:<Ix>")
                _inv_err = self._invariant_gate(prompt, sid)
                if _inv_err:
                    return False, [], _inv_err
                resp = self._post("/prompt", self._build_prompt_body(prompt))
                if "prompt_id" not in resp:
                    last_err = json.dumps(resp, ensure_ascii=False)[:300]
                    print("[H3Batch] %s 校验失败(第%d次): %s" % (sid, attempt + 1, last_err), flush=True)
                else:
                    pid = resp["prompt_id"]
                    print("[H3Batch] %s 提交: %s" % (sid, pid), flush=True)
                    # V1.11 批 4 T3a: 渲染中中间态 — 提交拿到 prompt_id 后、写 _wait_shot 前
                    # 落 status="rendering" + _save_manifest (一次写盘). 数分钟渲染期前端能
                    # 看到 rendering 而不是 pending 挂死; 续跑 (skip_done) 走 status 在
                    # ("success", "failed") 之外 → rendering 段被重跑 (正确, 无需改豁免集).
                    # 桶决策钉死: summarize_manifest 四桶 (done/failed/stopped/missing_file) 不动,
                    # rendering 不计入 done (不入 success 桶). h3_mcp 侧 else 分支天然兼容.
                    try:
                        _rm = self._load_manifest()
                        _rsid = _rm.get(sid) or {}
                        _rsid["status"] = "rendering"
                        _rsid["prompt_id"] = pid
                        _rm[sid] = _rsid
                        self._manifest_mark_dirty(sid)
                        self._save_manifest(_rm)
                    except Exception:
                        pass  # rendering 中间态落盘是优化路径, 失败兜底走 pending 不阻塞本段
                    status, files = self._wait_shot(pid)
                    if status == "interrupted":
                        # 用户按了 ComfyUI 取消 = 停整批; 不重试不跑下一段, 已成功段保留供续跑
                        self._stop.set()
                        print("[H3Batch] %s 被用户中断, 停止整批(重跑时已成功段自动跳过)" % sid, flush=True)
                        return False, [], "用户中断"
                    if status == "success":
                        if getattr(self, "_pipe_collect_in_run_one", True):
                            # 非 run() 主循环调用方 (rerun 族等): 同步 collect 语义零变
                            # V1.13 D8: 有界等待 + 二次 collect — 异步落盘竞态防护;
                            # 失败判据限定 mp4 子集 (非 mp4 .json sidecar 等不计入).
                            moved = self._collect_output_retry(files, sid)
                            expected_mp4 = [f for f in (files or [])
                                            if isinstance(f, str) and f.endswith(".mp4")]
                            missing_mp4 = [f for f in expected_mp4 if f not in moved]
                            if expected_mp4 and missing_mp4:
                                # 等满 max_wait 仍缺任一 mp4 → 段失败, 不写幽灵 files
                                print("[H3Batch] %s 产物缺失 (D8: 等满 max_wait 仍未命中): %s"
                                      % (sid, ",".join(missing_mp4)), flush=True)
                                return False, [], "missing_file: %s" % ",".join(missing_mp4)
                            self._last_pid = pid
                            self._last_seed = seed
                            return True, moved, ""
                        # 批 W1 R-62: run() 主循环 — collect (含 D8 防抖) 挪后台流水线作业,
                        # 渲完即返 (P-1); missing 改判由主循环 drain 收割按既有失败分支收敛。
                        self._last_pid = pid
                        self._last_seed = seed
                        return True, files, ""
                    last_err = "status=%s" % status
                    # V1.9 T4.5 D1: 服务端执行失败 (status='error') 时, history 带
                    # execution_error 且为确定性错误 (如 LoRA shape 不配套) → 不重试
                    # (interrupted 分支已在上面优先返回, 优先级不变; timeout 无条目, 恒重试)
                    if status == "error":
                        _exec_err = self._last_execution_error()
                        if _exec_err and _is_deterministic_error(_exec_err[0], _exec_err[1]):
                            print("[H3Batch] %s 确定性错误(%s: %s), 不重试"
                                  % (sid, _exec_err[0], _exec_err[1][:160]), flush=True)
                            return False, [], last_err
                    print("[H3Batch] %s 失败(%s), 重试 %d/%d" % (sid, last_err, attempt + 1, self.retries + 1), flush=True)
            except ShotError as e:
                print("[H3Batch] %s 素材/参数错误: %s" % (sid, e), flush=True)
                return False, [], str(e)
            except urllib.error.HTTPError as e:
                # V1.11 T3 门审真机 P1 (C 缺陷): HTTP 4xx/5xx 拒绝 = 服务端明确拒绝
                # (典型 400 Bad Request: 校验失败/枚举值不匹配/参数错误). 重试无意义 —
                # 服务端不会因等待而改变判断. 5xx (服务端内部错误) 仍按重试链路走
                # (网络/服务端瞬时问题); 4xx 直接失败 + body 摘要进 last_err
                # (排查 "HTTP Error 400: Bad Request" 拿不到原因, 这次真机排查就被拖长).
                body_text = ""
                try:
                    body_text = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    pass
                last_err = "HTTP %d %s%s" % (e.code, e.reason or "",
                                            (": " + body_text) if body_text else "")
                if 400 <= e.code < 500:
                    print("[H3Batch] %s HTTP %d (%s), 不重试: %s"
                          % (sid, e.code, e.reason or "", body_text[:300]), flush=True)
                    return False, [], last_err
                print("[H3Batch] %s HTTP %d (%s), 重试 %d/%d: %s"
                      % (sid, e.code, e.reason or "", attempt + 1, self.retries,
                         body_text[:200]), flush=True)
            except Exception as e:
                last_err = str(e)
                # V1.9 T4.5 D1: 确定性异常 (类型+消息双匹配) → 不重试, 与重试耗尽同失败路径
                if _is_deterministic_error(type(e), str(e)):
                    print("[H3Batch] %s 确定性错误(%s: %s), 不重试"
                          % (sid, type(e).__name__, str(e)[:160]), flush=True)
                    return False, [], last_err
                print("[H3Batch] %s 异常(%s), 重试 %d/%d" % (sid, last_err, attempt + 1, self.retries + 1), flush=True)
            if attempt < self.retries:
                # 可中断退避: 5-60s 单段 sleep 拆为 1s 段, 期间 _stop 命中即提前结束
                # (对照 _wait_shot `sleep(2 if _stop.is_set() else 10)` 的分段响应模式)
                # 用剩余时长计数器而非 time.time() (测试 mock time.sleep 时不前进, 不能用 wall clock)
                remaining = float(_retry_delay(attempt))
                while remaining > 0:
                    if self._stop.is_set():
                        print("[H3Batch] %s 退避等待中被中断, 停止整批" % sid, flush=True)
                        return False, [], "用户中断"
                    chunk = min(1.0, remaining)
                    time.sleep(chunk)
                    remaining -= chunk
        return False, [], last_err

    def _rerun_anchors(self, sid):
        """重跑段的双锚定: 返回 (first_frame, last_frame) 文件名。
        first = 前一个成功段尾帧; last = 后一个成功段首帧(无则 None)。"""
        raw = self._parse_rows()
        shots = self._parse_shots(raw)
        manifest = self._load_manifest()
        idx = next((i for i, r in enumerate(shots) if (r.get("ID") or "").strip() == sid), None)
        if idx is None:
            return None, None
        first = None
        for j in range(idx - 1, -1, -1):
            info = manifest.get(shots[j].get("ID") or ("shot_%03d" % (j + 1)), {})
            if info.get("status") == "success" and info.get("tail_frame"):
                first = info["tail_frame"]
                break
        last = None
        for j in range(idx + 1, len(shots)):
            info = manifest.get(shots[j].get("ID") or ("shot_%03d" % (j + 1)), {})
            if info.get("status") == "success":
                vpath = self._video_path_old(info.get("files", []), info.get("run_dir"))
                if vpath:
                    last = self._extract_first_frame(vpath)
                    if last:
                        break
        return first, last

    def _void_tail_anchor(self, manifest, shots, i):
        """V1.10 批3 T4a: void 段重跑尾帧锚.

        拼接模式 + 本段 review=void → 后向扫描, 取首个 status=success 段的
        _extract_first_frame; 否则 None (分镜模式 / 非 void / 无后继 success 段).

        分镜模式无续接概念 (D10), 永远不进扫描; 拼接模式 _apply_continuation 已自动带
        前段尾 latent 续接 (头锚 ✓), 本方法只补尾锚 (后继首帧).
        1.11b 波1 T2: A 类逐段化 — 自定义下仅本段勾选才走后向扫描 (与拼接侧同口径).
        1.14 批 I I2a: fl2v 末段 endpoint_frame 优先级 1 已删 (fl2v 批入口即拒).
        """
        if self._seg_mode(i) != "拼接":
            return None
        sid = shots[i].get("ID") or ("shot_%03d" % (i + 1))
        if manifest.get(sid, {}).get("review") != "void":
            return None
        for j in range(i + 1, len(shots)):
            jsid = shots[j].get("ID") or ("shot_%03d" % (j + 1))
            info = manifest.get(jsid, {})
            if info.get("status") == "success":
                vpath = self._video_path_old(info.get("files", []), info.get("run_dir"))
                if vpath:
                    frame = self._extract_first_frame(vpath)
                    if frame:
                        return frame
        return None

    def _rebuild_concat(self, manifest, shots):
        """按 CSV 顺序收集全部成功段文件重新拼接。"""
        import postfx_engine
        parts = []
        for row in shots:
            info = manifest.get(row.get("ID") or "", {})
            if info.get("status") != "success":
                continue
            vpath = self._video_path_old(info.get("files", []), info.get("run_dir"))
            if vpath:
                parts.append(vpath)
        if not parts:
            return
        # 1.14b U3 Y1 / U6R E4.3③: 消费端取戳 — 层级选择单一落点 (interp → upscale → 原件)
        postfx_map = manifest.get("_postfx") or {}
        _level = None
        if postfx_map:
            # parts 列表是 abs 路径, 拼成 (sid, path) 元组喂 pick_level
            # U6R T7-fix: sid 走 manifest 段键解析 (真机 W3: 文件名 stem ≠ 段键)
            sid_path = [(postfx_engine.manifest_sid_for(manifest, p), p) for p in parts]
            _level, parts, warns = postfx_engine.pick_level(sid_path, postfx_map, self.run_dir)
            for w in warns:
                print("[H3Batch] " + w, flush=True)
                if not getattr(self, "_preflight_warns", None):
                    self._preflight_warns = []
                self._preflight_warns.append(w)
        out = os.path.join(self.run_dir, "concat_%s.mp4" % _concat_stamp())
        # Y3: 实际选中层级 == interp → crossfade_frames×2 (放大/原件档不变)
        if _level == "interp":
            _cf = self._postfx_crossfade_frames(doubled=True)
        elif _level == "upscale":
            _cf = self._postfx_crossfade_frames(doubled=False)
        else:
            _cf = None
        if _cf is not None:
            ok, _concat_err = self._concat_videos(parts, out, crossfade_frames=_cf)
        else:
            ok, _concat_err = self._concat_videos(parts, out)
        missing = sorted(k for k, v in manifest.items()
                         if k not in _RESERVED_KEYS
                         and v.get("status") in ("failed", "blocked"))
        status_label = "OK" if ok else "失败"
        if not ok and isinstance(_concat_err, str) and _concat_err.startswith("size_mismatch:"):
            status_label = "跳过"
        print("[H3Batch] 重拼完成: %s (%s)%s" % (out, status_label,
              (" 缺段: " + ",".join(missing)) if missing else ""), flush=True)
        # V1.11 批 4 T2: size_mismatch 前缀 → status=skipped (账本留痕, 避免 0 字节空片).
        concat_info = _classify_concat_result(ok, _concat_err, out)
        if missing:
            concat_info["missing"] = missing
        manifest["_concat"] = concat_info
        self._write_color_manifest(manifest)   # T3.5: S2 色彩对齐批级留痕
        self._write_review_manifest(manifest)  # T3.7: S5 审片报告补列留痕
        self._save_manifest(manifest)

    def _archive_run(self, manifest):
        """批次收尾: 把本次 run_dir 从 output 根搬到 archive_dir, manifest 跟随走。
        搬运失败不 raise, 成果保留原位。
        返回值: 成功搬运返回 dest(str); 未配置 archive_dir 或搬运失败返回 None。"""
        if not self.archive_dir:
            return None
        src = self.run_dir
        base = os.path.basename(src)
        dest = os.path.join(self.archive_dir, base)
        n = 2
        while os.path.exists(dest):
            dest = os.path.join(self.archive_dir, "%s_%d" % (base, n))
            n += 1
        try:
            os.makedirs(self.archive_dir, exist_ok=True)
            shutil.move(src, dest)
        except OSError as e:
            print("[H3Batch] 归档失败, 成果保留原位: %s (%s)" % (src, e), flush=True)
            return None

        def repath(p):
            if p == src:
                return dest
            if p and os.path.normcase(p).startswith(os.path.normcase(src) + os.sep):
                return os.path.join(dest, p[len(src) + 1:])
            return p

        for v in manifest.values():
            if not isinstance(v, dict):
                continue
            if v.get("run_dir"):
                v["run_dir"] = repath(v["run_dir"])
            if v.get("file"):
                v["file"] = repath(v["file"])
        # V1.11 批 1 T2b: manifest 在 run_dir 内, 随 run_dir 一起被 move;
        # 更新 self.manifest_path 到新位置, 后续 _save_manifest 写到归档目录 (不写回根层).
        self.manifest_path = os.path.join(dest, os.path.basename(self.manifest_path))
        self._save_manifest(manifest)
        print("[H3Batch] 已归档: %s -> %s" % (src, dest), flush=True)
        return dest

    def rerun_shot(self, sid):
        """只重跑指定段。返回 (ok, files, err)。"""
        raw = self._parse_rows()
        pool = self._parse_pool(raw)
        shots = self._parse_shots(raw)
        idx = None
        for i, row in enumerate(shots):
            if (row.get("ID") or "").strip() == sid:
                idx = i
                break
        if idx is None:
            return False, [], "找不到分镜 %s" % sid
        # 1.11b 波1 T2: B 类批级 — 自定义下任一段勾选也按拼接侧取模板判族
        if self._any_seg_concat():
            self._declared = _template_mode(self.workflow_path)
        print("[H3Batch] 工作流: %s" % self.workflow_path, flush=True)
        self._new_run_dir()
        self.convert(seed=0)
        self._prompt = self._apply_global(self._prompt, self._parse_global(raw))
        prev_frame = None
        next_frame = None
        # 1.11b 波1 T2: A 类逐段化 — 自定义下仅本段勾选才进双锚定路径
        if self._seg_mode(idx) == "拼接":
            prev_frame, next_frame = self._rerun_anchors(sid)
            if next_frame:
                print("[H3Batch] 双锚定: 头=%s 尾=%s" % (prev_frame, next_frame), flush=True)
        self._shot_t0 = time.time()
        # V1.7 B2: rerun 单段重跑路径同样预解析 cast_plan (与 run()/preflight 同源; 透传给 _run_one)
        try:
            self._cast_plan = None
            self._prepare_cast_plan(shots, pool)
        except Exception:
            self._cast_plan = None
        rerun_cast = (self._cast_plan["per_shot"].get(idx)
                      if (self._cast_plan and self._cast_plan.get("inject_ok"))
                      else None)
        # 批 A 节点 3 (A1): rerun 单段重跑, 拼接模式按 idx 推算 shot_no, cum_ms 按 idx 前段累加
        # R4 修复: 累加**帧数**再统一换算 ms (避免逐段 ms 舍入漂移)
        # 1.11b 波1 T2: A 类逐段化 — 自定义下勾选段也走 shot_no=i+1 (按 _seg_mode(idx) 判定)
        if self._seg_mode(idx) == "拼接":
            _shot_no = idx + 1
            _cum_ms = None
            if idx > 0:
                _cum_frames = 0
                for _j in range(idx):
                    _fr = self._row_dur_frames_eff(shots[_j], _j)
                    if _fr is not None:
                        _cum_frames += _fr
                _cum_ms = _frames_to_ms(_cum_frames)
        else:
            _shot_no = 1
            _cum_ms = None
        ok, files, err = self._run_one(idx, shots[idx], pool, prev_frame, next_frame,
                                       cast_plan=rerun_cast,
                                       shot_no=_shot_no, cum_ms=_cum_ms)
        if ok:
            manifest = self._load_manifest()
            manifest[sid] = {"status": "success", "files": files, "prompt_id": self._last_pid,
                             "seed": self._last_seed, "run_dir": self.run_dir,
                             **self._timing_fields(), "final_prompt": self._last_final_prompt}
            self._manifest_mark_dirty(sid)
            # V1.9 批 3 T3.3: S1 降级链留痕 (manifest 段键, success 段也记)
            manifest[sid].update(self._continuation_manifest_fields())
            # 1.13h T4/T5: 段级覆盖留痕并入替换字典之后 (整字典替换会丢键 — 同源注记)
            manifest[sid].update(self._seg_manifest_fields())
            # 1.11b 波1 T2: 自定义下勾选段也写 tail_frame (供下段锚定), 拼接模式行为不变
            if self._seg_mode(idx) == "拼接":
                vpath = self._video_path(files)
                if vpath:
                    manifest[sid]["tail_frame"] = self._extract_last_frame(vpath)
            manifest.pop("_concat", None)
            self._save_manifest(manifest)
            # 1.11b 波1 T2: C 类 — 自定义模式不重拼大片 (沿用分镜侧语义)
            if self.mode == "拼接":
                self._rebuild_concat(self._load_manifest(), shots)
            # V1.9 批 3 T3.2: S1 intermediates 随批清理 (与 run() 收尾同口径, 归档前)
            self._cleanup_continuation()
            self._archive_run(self._load_manifest())
        return ok, files, err

    # ---------------- 文件夹锚定重跑 ----------------
    @staticmethod
    def _export_base_from_files(files):
        """1.13j T1: 从 files 取首个可解析的 .mp4, 反解出 CSV 导出基名 (供 _folder_matches
        双前缀扩展). 例: a_s01_831560315_00001_.mp4 → a_s01. 失败 (空/None/全不可解析/无
        扩展名) → None. 二审修订: 取首个**可解析** mp4, 不整支退化."""
        if not files:
            return None
        for fn in files:
            if not isinstance(fn, str) or not fn.lower().endswith(".mp4"):
                continue
            stem = os.path.splitext(fn)[0]
            m = re.match(r"^(.*)_[^_]+_\d{5,}_$", stem)
            if m:
                return m.group(1)
        return None

    @staticmethod
    def _folder_matches(folder, sid, export_base=None):
        """folder 下的现行 mp4: 文件名以任一前缀 (sid ∪ export_base) 开头且下一字符是 _
        或 ., 排除 _old_NN 改名件. export_base=None 或 ==sid → 前缀集去重为单元素."""
        prefixes = {sid}
        if export_base and export_base != sid:
            prefixes.add(export_base)
        out = []
        for fn in sorted(os.listdir(folder)):
            if not fn.lower().endswith(".mp4"):
                continue
            if not any(fn.startswith(p) for p in prefixes):
                continue
            # 下一字符边界取首个匹配前缀的长度
            hit_p = next(p for p in prefixes if fn.startswith(p))
            nxt = fn[len(hit_p):len(hit_p) + 1]
            if nxt not in ("_", ".") or re.search(r"_old_\d+$", os.path.splitext(fn)[0]):
                continue
            out.append(fn)
        return out

    @staticmethod
    def _keep_old(path):
        """改名保留: {stem}_old_NN.mp4(已有 _old_NN 后缀先归一), 序号递增, 不删除不覆盖。"""
        stem, ext = os.path.splitext(path)
        stem = re.sub(r"_old_\d+$", "", stem)
        n = 1
        while os.path.exists("%s_old_%02d%s" % (stem, n, ext)):
            n += 1
        dst = "%s_old_%02d%s" % (stem, n, ext)
        os.rename(path, dst)
        return dst

    def _old_concats(self, folder):
        """folder 里既有的拼接成品: *_concat*.mp4 加 manifest _concat 指向的文件。

        V1.11 批 1 T5 缺陷 (P0): 手动拼接产物 (concat_manual_*.mp4) 是版本树资产
        (PRD F7 不覆盖承诺 + 账本 _concat_history[*].output 引用), 不参与自动改名 —
        重跑触发 _keep_old 时遇到 concat_manual_* 会改名为 _old_NN, 导致账本
        output 悬空 (指向磁盘不存在的旧名). 排除: 文件名以 concat_manual_ 开头
        的不纳入 found; manifest._concat.file 指向 concat_manual_ 也跳过.
        自动拼接产物 (concat_<时间戳>.mp4) 仍走改名保留 (现行仅最新, 改名保历史).
        """
        found = []
        for fn in sorted(os.listdir(folder)):
            if not fn.lower().endswith(".mp4"):
                continue
            if "concat" not in fn.lower():
                continue
            if fn.startswith("concat_manual_"):  # 手动拼接产物 — 版本树资产, 跳过
                continue
            found.append(os.path.join(folder, fn))
        info = self._load_manifest().get("_concat") or {}
        mf = info.get("file")
        if mf and os.path.exists(mf) and mf not in found:
            # manifest._concat.file 指向的若是手动拼接产物 (concat_manual_*.mp4), 也跳过
            if not os.path.basename(mf).startswith("concat_manual_"):
                found.append(mf)
        return found

    def rerun_shot_in_folder(self, folder, sid):
        """文件夹锚定重跑: 定位之前那组时间戳文件夹, 老产物改名保留, 用前后段
        首尾帧做锚, 只重跑该段, 新产物直接落回该文件夹 (裁决 C: 完成后不自动重拼)。

        T5 S7: 此路径不做缺产物清点 (_sweep_missing_files); 单段重跑语义由调用方
        自行核验产物文件 (文件夹锚定场景下产物就落在指定 folder, 天然可见)。
        V1.11 批 1 T3: 拆出 _rerun_generate_shot_in_folder + _rerun_finalize 两步,
        复用底层给多段重跑; 失败路径加 _keep_old 改名回滚 + 段置 failed (multi-shot 同款)."""
        folder = os.path.abspath(folder)
        if not os.path.isdir(folder):
            return False, [], "重跑文件夹不存在: %s" % folder
        raw = self._parse_rows()
        shots = self._parse_shots(raw)
        ids = [(r.get("ID") or "").strip() for r in shots]
        idx = next((i for i, s in enumerate(ids) if s == sid), None)
        if idx is None:
            return False, [], "找不到分镜 %s" % sid
        # 1.13j T1 (修正笔): 导出基名 (CSV 导出文件名) 可能 ≠ sid — 优先取 manifest 现行件
        # 反解. manifest 缺 sid 段记录 → _eb=None → 退化为仅 sid 前缀 → 导出名≠sid 时
        # 空集, 安全拒跑 (不跨段误匹配: folder 是批次目录, 多段产物是常态, 严禁用 folder
        # 内 mp4 反解 fallback, 会把别段基名误用击穿 :8634 → _keep_old 误删别段数据).
        _man = self._load_manifest() if (os.path.exists(self.manifest_path)
                                          or resolve_manifest_path(
                                              os.path.splitext(os.path.basename(self.csv_path))[0],
                                              self.output_dir)) else {}
        _cur_files_seg = (isinstance(_man.get(sid), dict)
                          and _man[sid].get("files")) or []
        _eb = self._export_base_from_files(_cur_files_seg)
        cur = self._folder_matches(folder, sid, export_base=_eb)
        if not cur:
            return False, [], "文件夹里找不到 %s 的现行视频: %s" % (sid, folder)

        ok, files, err = self._rerun_generate_shot_in_folder(folder, sid)
        if not ok:
            return ok, files, err

        # 拼接模式: 段 dict + _concat 一起写
        # 裁决 C (老板 2026-10-15): 重跑族完成不再自动重拼 — 与 _rerun_finalize 恒置
        # 跳过同款通路, 恒置 skipped 落账 (成片由用户手动拼); 旧单段内联重拼机制退役.
        if self.mode == "拼接":
            concat_info = {"status": "skipped",
                           "reason": "rerun_no_auto_concat: 重跑完成不自动重拼, 请手动拼接"}
            print("[H3Batch] 重拼跳过: 重跑完成不自动重拼, 请手动拼接 (folder=%s)"
                  % folder, flush=True)
        else:
            concat_info = None
            out = None
        # V1.11 批 1 T2b: 双位置存在检查 — _load_manifest 已走 resolve_manifest_path 双位置回退.
        if os.path.exists(self.manifest_path) or resolve_manifest_path(
                os.path.splitext(os.path.basename(self.csv_path))[0],
                self.output_dir):
            manifest = self._load_manifest()
            # 1.14c C1 (B4-D1): 内层 _rerun_generate_shot_in_folder 已按 C1 规则落好
            # review (新 take=pending / 复活=旧值), 本重载快照即该值; 下方整字典替换
            # + 标脏后合并规则救不回 (脏 sid 不采纳磁盘 review, pending 非终态)
            # → 先取后回填, 防节点单端重跑把待审抹成隐式已通过.
            _seg = manifest.get(sid)
            _prev_review = (_seg.get("review") if isinstance(_seg, dict) else None)
            vpath = self._video_path(files)
            tail_frame = self._extract_last_frame(vpath) if vpath else None
            manifest[sid] = {"status": "success", "files": files, "prompt_id": self._last_pid,
                             "seed": self._last_seed, "run_dir": folder,
                             **self._timing_fields(), "final_prompt": self._last_final_prompt}
            if _prev_review is not None:
                manifest[sid]["review"] = _prev_review
            self._manifest_mark_dirty(sid)
            # V1.9 批 3 T3.3: S1 降级链留痕 (manifest 段键, success 段也记)
            manifest[sid].update(self._continuation_manifest_fields())
            # 1.13h T4/T5: 段级覆盖留痕并入替换字典之后 (整字典替换会丢键 — 同源注记)
            manifest[sid].update(self._seg_manifest_fields())
            if tail_frame:
                manifest[sid]["tail_frame"] = tail_frame
            if concat_info:
                manifest["_concat"] = concat_info
                self._write_color_manifest(manifest)  # T3.5: S2 留痕
                self._write_review_manifest(manifest)  # T3.7: S5 留痕
            self._save_manifest(manifest)
        return ok, files, err

    # ============== V1.11 批 1 T3: 多段重跑底层 (rerun_shot_in_folder 拆出来) ==============

    def _rerun_generate_shot_in_folder(self, folder, sid, seed_override=None,
                                        prompt_perturb="", rename_log=None,
                                        res_override=None,
                                        prompt_text_override=None,
                                        prompt_override=None,
                                        prompt_text_scope="final"):
        """生成单段 (无最终重拼, 无 _concat 写入). 由 rerun_shot_in_folder / rerun_multi_shots_in_folder 共用.

        失败路径 (V1.11 T3 P1):
          - _keep_old 改名回滚 (旧名还原); 回滚失败 → 留 _old_NN (引用仍指向磁盘件)
          - 段 status=failed 写入 manifest
        rename_log: 可选, 用于跨多段循环累积 rename 事件, 末尾跟随改写 _reruns[*].files[*].
          元素 = (old_basename, new_basename) 文件名 (不含路径), 索引按发生顺序.
        V1.11 批 3 T1: res_override={比例,质量,步数} 在 _apply_global(历史 CSV) 之后二次
          应用, 压过历史; prompt_text_override 在 _run_one 装配最终 prompt 后整段替换
          (所见即所发). 末次重拼跳过标记 → self._rerun_skip_concat (调用方读此决定
          _rerun_finalize 路径).
        V1.13h T2: prompt_override 整体替换 self._prompt (在 _apply_global 后, 与
          prompt_text_override 同源 try/finally). 用于重绘等"换图"场景 (Fun ControlNet
          inpaint 等)。None → 现状逐字节不变。
        #78 A 路径: prompt_text_scope 与 prompt_text_override 同组透传 (配对规则 S-2) —
          "segment" = 段词前置重装配; 缺省 "final" = 装配后整段替换 (现行为)。
        """
        if rename_log is None:
            rename_log = []
        # 改分辨率逐段记录 (供调用方如 rerun_multi_shots_in_folder 读,
        # 也允许直接 _rerun_generate_shot_in_folder 单段测试桩路径 — 桩实例
        # 无 _res_changed_sids 时退化空 list, 不抛 AttributeError).
        if not hasattr(self, "_res_changed_sids"):
            self._res_changed_sids = []
        folder = os.path.abspath(folder)
        raw = self._parse_rows()
        pool = self._parse_pool(raw)
        shots = self._parse_shots(raw)
        ids = [(r.get("ID") or "").strip() for r in shots]
        idx = next((i for i, s in enumerate(ids) if s == sid), None)
        if idx is None:
            return False, [], "找不到分镜 %s" % sid

        # 当前文件 (允许空: 失败/停止段无产物)
        # 1.13j T1 (修正笔): 导出基名 (CSV 导出文件名) 可能 ≠ sid — 优先取 manifest 现行件
        # 反解. manifest 缺 sid 段记录 → _eb_inner=None → 仅 sid 前缀 → 安全拒跑
        # (严禁 folder 内 mp4 反解 fallback, 跨段误匹配会破坏别段数据, 见主代理打回).
        _man_inner = self._load_manifest() if (os.path.exists(self.manifest_path)
                                                or resolve_manifest_path(
                                                    os.path.splitext(os.path.basename(self.csv_path))[0],
                                                    self.output_dir)) else {}
        _cur_files_seg_inner = (isinstance(_man_inner.get(sid), dict)
                                and _man_inner[sid].get("files")) or []
        _eb_inner = self._export_base_from_files(_cur_files_seg_inner)
        cur = self._folder_matches(folder, sid, export_base=_eb_inner)

        # 邻居现行视频做锚 (允许空)
        # 1.13j T1 步骤 C: 优先取 manifest[邻段].files 中 folder 内存在者, 缺位退化
        # _folder_matches 取尾/取首 (维持原取法, 防错锚到陈旧件; 兜底走 sid 单前缀旧语义,
        # 不扩 export_base: 邻段账本缺位时无来源, 防止跨段误锚).
        prev_v = next_v = None
        for j in range(idx - 1, -1, -1):
            _seg_files = (isinstance(_man_inner.get(ids[j]), dict)
                          and _man_inner[ids[j]].get("files")) or []
            _seg_files = [fn for fn in _seg_files
                          if isinstance(fn, str) and os.path.exists(os.path.join(folder, fn))]
            if _seg_files:
                prev_v = os.path.join(folder, _seg_files[-1])
                break
            m = self._folder_matches(folder, ids[j])
            if m:
                prev_v = os.path.join(folder, m[-1])
                break
        for j in range(idx + 1, len(ids)):
            _seg_files = (isinstance(_man_inner.get(ids[j]), dict)
                          and _man_inner[ids[j]].get("files")) or []
            _seg_files = [fn for fn in _seg_files
                          if isinstance(fn, str) and os.path.exists(os.path.join(folder, fn))]
            if _seg_files:
                next_v = os.path.join(folder, _seg_files[0])
                break
            m = self._folder_matches(folder, ids[j])
            if m:
                next_v = os.path.join(folder, m[0])
                break

        # 老产物改名保留 (失败时回滚)
        renamed = []
        for fn in cur:
            old_path = os.path.join(folder, fn)
            new_path = self._keep_old(old_path)
            renamed.append((old_path, new_path))
            rename_log.append((os.path.basename(old_path), os.path.basename(new_path)))
        for p in self._old_concats(folder):
            old_path = p
            new_path = self._keep_old(p)
            renamed.append((old_path, new_path))
            rename_log.append((os.path.basename(old_path), os.path.basename(new_path)))

        if self._any_seg_concat():
            self._declared = _template_mode(self.workflow_path)
        print("[H3Batch] 工作流: %s" % self.workflow_path, flush=True)
        self.run_dir = folder
        # V1.11 批 1 T2b: manifest 跟随 folder
        # V1.11 交付前 BE-P1-1: 端点已注入 variant manifest_path (含 _repN 变体)
        # 且指向 folder → 保留, 不重置为裸名 (否则 repeat>=2 任务重跑分裂成两个
        # manifest: 端点 ledger 写 variant, 引擎 save 写裸名).
        _injected_mp = getattr(self, "manifest_path", None)
        if (_injected_mp
                and os.path.dirname(os.path.abspath(_injected_mp)) == folder
                and os.path.exists(_injected_mp)):
            pass  # honor endpoint resolution (variant path)
        else:
            stem = os.path.splitext(os.path.basename(self.csv_path))[0]
            suffix = getattr(self, "manifest_suffix", "")
            self.manifest_path = os.path.join(
                folder, "h3_batch_manifest_%s%s.json" % (stem, suffix))
        self.convert(seed=0)
        self._prompt = self._apply_global(self._prompt, self._parse_global(raw))
        # V1.11 批 3 T1: 同 seed 重跑参数覆写 — 在历史 CSV 之后二次 _apply_global,
        # 复用既有三分支 (RS/MultiRate + 兜底 BasicScheduler/ref.w-h). 与历史比例/质量
        # 不一致 → 标记 self._rerun_skip_concat ("res_changed") + 改写 _rerun ledger.
        if isinstance(res_override, dict) and any(res_override.get(k)
                                                  for k in ("比例", "质量", "步数")):
            g_full = self._parse_global(raw)
            g_ov = dict(g_full)
            for k in ("比例", "质量", "步数"):
                v = res_override.get(k)
                if v:
                    g_ov[k] = v
            self._prompt = self._apply_global(self._prompt, g_ov)
            # 改分辨率降级锚: 与磁盘 manifest._res_summary 比对 (比例/质量).
            # - 端点 build_engine_from_params 构造的引擎实例不会进 run(),
            #   故 self._res_summary 为空 — 必须从磁盘 read_manifest_safe 读,
            #   否则 self._res_summary 兜底恒空, 改步数也会误判 res_changed.
            # - 旧 manifest 无 _res_summary → 无基线, 不触发 res_changed
            #   (保守: 走正常流程; 旧批没有跨任务基线无从比较, 如实执行).
            # - 步数变更不触发 res_changed (拼接模式步数与分辨率正交,
            #   跨段拼接只关心空间维度, 步数变化不引入黑边).
            ratio_now = res_override.get("比例") or g_full.get("比例") or ""
            quality_now = res_override.get("质量") or g_full.get("质量") or ""
            steps_now = res_override.get("步数") or g_full.get("步数") or ""
            data = self._load_manifest() or {}
            hist_summary = data.get("_res_summary") if isinstance(data, dict) else None
            res_changed = False
            if isinstance(hist_summary, dict):
                hist_ratio = str(hist_summary.get("比例") or "")
                hist_quality = str(hist_summary.get("质量") or "")
                # BE-P1-2 收口: 两侧归一后比对 (手填标签形态 CSV 的历史任务不误判 res_changed)
                if ratio_now and _normalize_ratio(ratio_now) != _normalize_ratio(hist_ratio):
                    res_changed = True
                elif quality_now and quality_now != hist_quality:
                    res_changed = True
            self._last_res_overrides = {
                "比例": ratio_now or None, "质量": quality_now or None, "步数": steps_now or None,
            }
            self._last_res_changed = res_changed
            if res_changed:
                # 显式降级锚: 续接跳过 latent 装载 — _apply_continuation 自动落到
                # tail_frame 模式 (R 排查确认过 latent 缺失路径自动降级; 这里把
                # 上段 latent 路径标为不可用, 不删磁盘 latent, 留给 batch 收尾自清).
                self._continuation_patch_fail = (
                    "res_changed: 改分辨率触发尾帧锚降级 (段 %s 比例/质量变更)" % sid)
                self._rerun_skip_concat = True
                # 收集 res_changed 段 id (供端点响应/前端 toast 用).
                self._res_changed_sids.append(sid)
        else:
            self._last_res_overrides = None
            self._last_res_changed = False
        if prompt_perturb:
            self._apply_prompt_perturb(prompt_perturb)
        # V1.13h T2: prompt_override 整体替换 self._prompt (在 _apply_global 之后,
        # _apply_prompt_perturb 之后). 用于重绘 (Fun ControlNet inpaint) 等"换图"场景.
        # 调用方构造完整图后传入, 替换后下游 apply_shot_common / assemble_final_prompt
        # 在 inpaint 图上工作; prompt_text_override (V1.11 批 3 T1) 仍在 _run_one 装配
        # 最终 prompt 后整段替换, 与 prompt_override 兼容叠加.
        if prompt_override is not None:
            self._prompt = prompt_override
        # V1.11 批 3 T1: 改词重跑 — 透传到 _run_one (assemble_final_prompt 之后替换
        # 该段最终提示词全文). try/finally 复位, 与 _current_seed_override 同口径.
        # #78: scope 与文本同组 set (配对规则 S-2, 严禁混搭).
        self._current_prompt_override = prompt_text_override
        self._current_prompt_text_scope = prompt_text_scope
        prev_frame = self._extract_last_frame(prev_v) if prev_v else None
        next_frame = self._extract_first_frame(next_v) if next_v else None
        print("[H3Batch] 重跑 %s (文件夹锚定): 头=%s 尾=%s" % (sid, prev_frame, next_frame), flush=True)
        self._shot_t0 = time.time()
        # V1.7 B2: 预解析 cast_plan
        try:
            self._cast_plan = None
            self._prepare_cast_plan(shots, pool)
        except Exception:
            self._cast_plan = None
        folder_cast = (self._cast_plan["per_shot"].get(idx)
                       if (self._cast_plan and self._cast_plan.get("inject_ok"))
                       else None)
        # 1.11b 波1 T2: A 类逐段化 — 自定义下勾选段也按 idx 推算 shot_no
        if self._seg_mode(idx) == "拼接":
            _shot_no = idx + 1
            _cum_ms = None
            if idx > 0:
                _cum_frames = 0
                for _j in range(idx):
                    _fr = self._row_dur_frames_eff(shots[_j], _j)
                    if _fr is not None:
                        _cum_frames += _fr
                _cum_ms = _frames_to_ms(_cum_frames)
        else:
            _shot_no = 1
            _cum_ms = None
        # 1.14c C1 真机 #13 修复: 新 take 判据基线 = **生成前**段状态 — 生产 _run_one
        # 提交渲染后会把该段 status 改写为 "rendering" 落盘 (:8453-8460, 保留其余键),
        # 生成后快照的 status 已非旧 take 终态; 旧实现读生成后快照 → 判据恒失配,
        # 重跑成功写 (整字典替换) 抹掉旧 review (真机 run 20260917_101010 实证:
        # approved 段与 void 段重跑后 review 键均消失, _seg_review 静默判 approved).
        # 生成期外部写只有 approve/void (只改 review 不改 status), 且端点/续跑互斥,
        # 基线稳定. manifest_path 已在上方定型 (:9064-9073).
        _pre_m = self._load_manifest() or {}
        _pseg = _pre_m.get(sid) if isinstance(_pre_m, dict) else None
        _prev_take_status = _pseg.get("status") if isinstance(_pseg, dict) else None
        # V1.11 T3: 显式 seed 经 self._current_seed_override 透传给 _run_one (保持
        # _run_one 签名向后兼容, 旧测试桩无需改). prompt_perturb 已在 _apply_global 后
        # 注入 self._prompt (实际生效), 此处再记一份用于测试桩审计.
        self._current_seed_override = seed_override
        self._current_prompt_perturb = prompt_perturb
        try:
            ok, files, err = self._run_one(idx, shots[idx], pool, prev_frame, next_frame,
                                           cast_plan=folder_cast,
                                           shot_no=_shot_no, cum_ms=_cum_ms)
        finally:
            self._current_seed_override = None
            self._current_prompt_perturb = ""
            self._current_prompt_override = None
            self._current_prompt_text_scope = None
        if not ok:
            # 失败路径: 改名回滚 (旧名还原) + 段置 failed
            for old_path, new_path in renamed:
                if os.path.exists(new_path) and not os.path.exists(old_path):
                    try:
                        os.rename(new_path, old_path)
                        rename_log.append((os.path.basename(new_path),
                                           os.path.basename(old_path)))
                    except OSError:
                        # 回滚失败 → 留 _old_NN, 不记录 (引用仍指向磁盘件, 文件存在)
                        pass
            if os.path.exists(self.manifest_path) or resolve_manifest_path(
                    os.path.splitext(os.path.basename(self.csv_path))[0],
                    self.output_dir):
                manifest = self._load_manifest()
                # V1.13 D8: 产物缺失分流 missing_file (与 run() 主循环同口径, 四桶契约)
                _st = "missing_file" if str(err).startswith("missing_file") else "failed"
                if _st == "missing_file":
                    # V1.13 D8-R: 判定后复活清点 — ComfyUI 输出缓存命中不产新文件, 上方
                    # 改名回滚已把旧产物还原回 folder; err 期望名 × folder 现行件非空 ⇒
                    # 产物在盘, 复活 success (真机 8190 实证: 判 missing 后 concat 用同
                    # 一文件拼成功, 段账本与磁盘失守)
                    _want = [w.strip() for w in str(err)[len("missing_file:"):].split(",") if w.strip()]
                    _revived = [w for w in _want if w.endswith(".mp4")
                                and os.path.exists(os.path.join(folder, w))]
                    if _revived:
                        print("[H3Batch] %s 产物复活 (判定后回滚/物化已落盘): %s"
                              % (sid, ",".join(_revived)), flush=True)
                        # 1.14c C1 (E1 规则② 复活路径 vs 规则① 新 take 的区分): 复活 = 产物
                        # 未变 (同一文件物化), 用户原裁决仍有效 → **保留**该段旧 review
                        # (含 void 不抹; 缺省不写键). 旧值取 :9192 刚重载的**生成后**快照
                        # (生成期间用户可能刚 approve/void, 生成前旧快照会静默抹掉).
                        _rev_seg = manifest.get(sid)
                        _old_rev = (_rev_seg.get("review")
                                    if isinstance(_rev_seg, dict) else None)
                        vpath = self._video_path(_revived)
                        manifest[sid] = {"status": "success", "files": _revived,
                                         "prompt_id": self._last_pid, "seed": self._last_seed,
                                         "run_dir": folder,
                                         **self._timing_fields(),
                                         "final_prompt": self._last_final_prompt}
                        if _old_rev is not None:
                            manifest[sid]["review"] = _old_rev
                        self._manifest_mark_dirty(sid)
                        manifest[sid].update(self._seg_manifest_fields())
                        self._save_manifest(manifest)
                        return True, _revived, ""
                manifest[sid] = {"status": _st, "error": err,
                                 "run_dir": folder, **self._timing_fields()}
                # R-34: ComfyUI 执行失败 (err 恰为 "status=error") → 落节点级报错详情
                # (rerun_shot / rerun_shot_in_folder / rerun_multi_shots_in_folder
                # 三入口共用本写点); 门控排除本地异常路径误读陈旧条目。
                if err == "status=error":
                    _exec_detail = self._last_execution_error_detail()
                    if _exec_detail is not None:
                        # #40: 与提交期校验面 (error_source="submit_validation") 对偶 —
                        # 运行期 ComfyUI 执行面标 comfyui_execution, GUI 据此显示来源行。
                        manifest[sid]["execution_error"] = dict(
                            _exec_detail, error_source="comfyui_execution")
                self._manifest_mark_dirty(sid)
                self._save_manifest(manifest)
            return ok, files, err

        # 成功: 兜底再 collect 一次 (对齐 run() 主循环 ~5892 口径; _run_one 内部已调
        # 但 ComfyUI worker 异步落盘存在竞态, 文件可能 _collect_output 跑时还没写盘
        # → 漏移; 此处再 collect 一次兜底, 第二次 src 不存在也无副作用).
        # V1.13 D8: 复用 _collect_output_retry (有界等待 + 二次 collect) — 与 _run_one
        # 同口径; 不补幽灵 (moved 只含真落盘项); manifest files 写实际 moved 集.
        try:
            moved = self._collect_output_retry(files, sid, max_wait=2.0, interval=0.5)
            if moved:
                files = moved
            else:
                # V1.13 D8: 等满 max_wait 仍无 moved → 段失败 (兜底兜不住的真失败)
                # 写段 dict 前发现全空, 降级为 failed (status 端点 + 拼接链路能识别).
                print("[H3Batch] %s 兜底 collect_output 全空, 降级为 failed" % sid, flush=True)
                return False, [], "missing_file: 兜底 collect 全空"
        except Exception as _ce:
            print("[H3Batch] %s 兜底 collect_output 异常: %s" % (sid, _ce), flush=True)
        # 成功: 写段 dict 到 manifest
        if os.path.exists(self.manifest_path) or resolve_manifest_path(
                os.path.splitext(os.path.basename(self.csv_path))[0],
                self.output_dir):
            manifest = self._load_manifest()
            vpath = self._video_path(files)
            tail_frame = self._extract_last_frame(vpath) if vpath else None
            manifest[sid] = {"status": "success", "files": files,
                             "prompt_id": self._last_pid, "seed": self._last_seed,
                             "run_dir": folder,
                             **self._timing_fields(),
                             "final_prompt": self._last_final_prompt}
            self._manifest_mark_dirty(sid)
            # 1.14c C1 (E1 规则①): 新 take 恒落 pending — 判据 = 生成前基线
            # _prev_take_status (:9165 附近): 旧段 status ∈ ("success","failed") =
            # 该段已有上一 take (重跑/续跑) → 新产物须重审, 不继承 approved/void;
            # 旧段为本批占位 {"status":"pending"} = 首次渲染 (规则④) → 不加不改
            # (沿用既有语义, 见 test_b1t1_manifest_io 护栏).
            if _prev_take_status in ("success", "failed"):
                manifest[sid]["review"] = "pending"
            manifest[sid].update(self._continuation_manifest_fields())
            # 1.13h T4/T5: 段级覆盖留痕并入替换字典之后 (整字典替换会丢键 — 同源注记)
            manifest[sid].update(self._seg_manifest_fields())
            if tail_frame:
                manifest[sid]["tail_frame"] = tail_frame
            # 1.14 整改批B B3: 重跑成功后剔除该 sid 的 _postfx 旧戳条目, 配双通道告警.
            # 必须在 save 前调, 让落盘 manifest 同时带 _postfx 失效态.
            self._invalidate_postfx_for_sid(manifest, sid)
            self._save_manifest(manifest)
        return ok, files, err

    def _rerun_inpaint_assemble_prompt(self, *, mask_rel, source_video_rel,
                                        strength, model_patch_name):
        """V1.13h 端点侧入口: 在 self._prompt 上做重绘 prompt 组装 (纯函数包装).

        负责: 深拷贝 self._prompt + 计算 next_nid + 调用模块级 _rerun_inpaint_assemble_prompt.
        不污染 self._prompt; 实际提交图由调用方拿 new_prompt 走 eng._run_one.
        """
        import copy
        if not isinstance(self._prompt, dict) or not self._prompt:
            return copy.deepcopy(self._prompt), {
                "injected": False,
                "reason": "self._prompt 为空/非 dict (引擎尚未 convert 或 prompt 未生成)",
                "nodes": {}, "removed_continuation": [],
            }
        # 计算 next_nid: max(现存 nid) + 1, 与 convert() 内的 self._next_nid 起始口径一致
        try:
            max_nid = max((int(nid) for nid in self._prompt.keys()
                           if str(nid).lstrip("-").isdigit()), default=0)
        except (TypeError, ValueError):
            max_nid = 0
        next_nid = max_nid + 1
        new_prompt, report = _rerun_inpaint_assemble_prompt(
            self._prompt, next_nid=next_nid,
            mask_rel=mask_rel, source_video_rel=source_video_rel,
            strength=strength, model_patch_name=model_patch_name,
        )
        return new_prompt, report

    def _rerun_lipsync_assemble_prompt(self, *, ref_video_rel, ref_image_rels,
                                       drive_audio_rel, prompt_text, width, height,
                                       length, seed, filename_prefix):
        """V1.13h 第二波 T3: 段二 Ref2VA 组装入口 (纯函数包装).

        从 self._prompt (段一模板, 已 convert/_apply_global) 提取模型链文件名 —
        与段一同源, 不硬编码; 缺任一 → report.assembled=False.
        两个 VAELoader 按名字含 "audio" 区分音频/视频 VAE (与 F2 节点 3/4 同序).
        """
        models = {}
        vae_names = []
        for node in (self._prompt or {}).values():
            if not isinstance(node, dict):
                continue
            t = node.get("class_type")
            ins = node.get("inputs") or {}
            if t == "UNETLoader":
                models.setdefault("unet", ins.get("unet_name"))
            elif t == "CLIPLoader":
                models.setdefault("clip", ins.get("clip_name"))
            elif t == "VAELoader":
                vae_names.append(ins.get("vae_name"))
            elif t == "MiniMaxH3TurboLoRA":
                models.setdefault("lora", ins.get("lora_name"))
        for name in vae_names:
            if not isinstance(name, str):
                continue
            if "audio" in name.lower():
                models.setdefault("vae_audio", name)
            else:
                models.setdefault("vae_video", name)
        return _rerun_lipsync_assemble_prompt(
            models=models, ref_video_rel=ref_video_rel,
            ref_image_rels=ref_image_rels, drive_audio_rel=drive_audio_rel,
            prompt_text=prompt_text, width=width, height=height, length=length,
            seed=seed, filename_prefix=filename_prefix)

    def _rerun_finalize(self, folder):
        """末次统一重拼入口 (拼接模式). 多段重跑结束后调用一次.

        裁决 C (老板 2026-10-15): 重跑族完成不再自动重拼 — 恒置跳过 (沿 res_changed
        跳过同款通路), 成片改由用户手动拼 (GUI 现有导出入口). 全量生成完成后的
        自动拼接走 _finalize_body, 不经此处, 零影响. res_changed 既有语义保留:
        改分辨率时 reason 仍带 res_changed (账本留痕/前端提示同旧). 旧末次重拼
        机制 (parts 收集/无现行段短路/auto_concat 开关/postfx 取层级/_concat_videos)
        随本裁决整体退役, 回滚见 git 历史.
        """
        if self.mode != "拼接":
            return
        _res_changed = bool(getattr(self, "_rerun_skip_concat", False))
        # 消费后清零 (避免影响下次 _rerun).
        self._rerun_skip_concat = False
        folder = os.path.abspath(folder)
        manifest = self._load_manifest()
        manifest["_concat"] = {
            "status": "skipped",
            "reason": ("res_changed: 改分辨率后该批不能整拼, 请全段同分辨率后手动拼"
                       if _res_changed else
                       "rerun_no_auto_concat: 重跑完成不自动重拼, 请手动拼接"),
        }
        self._save_manifest(manifest)
        print("[H3Batch] 重拼跳过: %s" % manifest["_concat"]["reason"], flush=True)

    def _invalidate_postfx_for_sid(self, manifest, sid):
        """1.14 整改批B B3: 重跑成功后使该 sid 的后处理戳失效.

        重跑成功 → manifest[sid].files 已替换为新 take 的产物, 但 _postfx[kind][sid]
        仍指旧 take 的戳产物 (upscaled/<旧stem>_x2_00001_.mp4 等); 消费端 pick_level
        按 sid 查表命中旧戳 + 磁盘旧戳件仍在 → 应用到成片 → **成片用了旧 take 的画面**
        且无告警 (apply_postfx_map 既有告警只覆盖文件不存在情形). 修法: 剔除该 sid
        在 _postfx["upscale"]/_postfx["interp"]/_postfx["failed"] 中的条目 + 落双通道
        告警 (stdout print + self._preflight_warns 给黄条). 旁 sid 不动.

        返回: 是否真剔除了至少一条 (供调用方决定是否打日志).
        """
        pf = manifest.get("_postfx")
        if not isinstance(pf, dict):
            return False
        removed = False
        for kind in ("upscale", "interp"):
            km = pf.get(kind)
            if isinstance(km, dict) and sid in km:
                del km[sid]
                removed = True
        # failed 字典: kind 维度的失败记录 (例: {"shot_002": "interp"}) 也清,
        # 否则新 take 重跑后 processing 该 kind 时该 sid 会带错失败态.
        fl = pf.get("failed")
        if isinstance(fl, dict) and sid in fl:
            del fl[sid]
            removed = True
        if removed:
            msg = ("[H3Batch] WARN: 重跑 sid=%s 后该段后处理戳已失效 "
                   "(成片将回落原件), 请重跑后处理" % sid)
            print(msg, flush=True)
            if not getattr(self, "_preflight_warns", None):
                self._preflight_warns = []
            self._preflight_warns.append(msg)
        return removed

    def _postfx_crossfade_frames(self, doubled):
        """1.14b U3 Y3: 拼接转场 crossfade_frames 计算 — 后处理含插帧时×2.
        doubled=True → 读 cfg 基数×2 (24fps 源插帧后 48fps, wall-clock 减半);
        doubled=False → 仅放大, 不变. 读 _H3_CONFIG["join"]["crossfade_frames"]
        (与 _make_composer 同源), 缺键走缺省链 DEFAULT_CROSSFADE_FRAMES.
        边界: 仍受 D13 钳制 (compose_join 内 fade_seconds ≤ 最短段)."""
        cfg = _H3_CONFIG.get("join")
        cfg = cfg if isinstance(cfg, dict) else {}
        try:
            base = int(cfg.get("crossfade_frames") or join_engine.DEFAULT_CROSSFADE_FRAMES)
        except (TypeError, ValueError):
            return None
        if base <= 0:
            return None
        return base * 2 if doubled else base

    def _run_postfx_pipeline(self, manifest, concat_parts):
        """1.14b U3: 拼接前调 postfx_engine.run_postfx_batch, 落 manifest._postfx,
        Y2 分级回退替换 concat_parts → 写回 manifest._postfx['final_parts'] (嵌套)."""
        # 批1 E1 (#51 归档端点前置⑤): in-flight 标记 — 纯防御纵深 (调用点在
        # _finalize_body 内, 恒在 _finalizing 注册窗内, 此标记为注册表外的第二道
        # 保险); 入口置位, finally 清除 (异常路径同清).
        self._postfx_pipeline_running = True
        try:
            import postfx_engine
            # 加载 2 模板 (U2 落盘的 A/B JSON, 双处事实源优先仓内 docs/; E1: 文件名由引擎选择映射,
            # 候选目录顺序不变 = 工作流同目录 → run_dir, 命中即记日志)
            tpl = {}
            for kind in ("upscale", "interp"):
                fname = postfx_engine.template_names(
                    kind, getattr(self, "_postfx_engine_choice", "seedvr2"))
                for p in (os.path.join(os.path.dirname(self.workflow_path or ""), fname),
                          os.path.join(self.run_dir, fname)):
                    if not os.path.isfile(p):
                        continue
                    postfx_engine.log_template(p)
                    # C6: 模板读取包 try → 异常视为该候选模板缺失 (continue 试下一候选);
                    # 修前 open/json.load 在 try 之外, 模板手改/损坏抛 JSONDecodeError →
                    # 异常外溢 → _finalize_body 中断于拼接前 → 拼接/归档/清点/报告全链断
                    # (B4-D4). 此处只验"文件可读 + JSON 合法"作为可消费前提; 真转换交给
                    # 下方的 try convert() 既有保护, 与 convert 失败同款 → api_prompt=None.
                    try:
                        with open(p, encoding="utf-8") as f:
                            json.load(f)
                    except Exception as ex:
                        print("[H3 postfx] 模板读取失败 %s: %s (视为模板缺失, 试下一候选)"
                              % (p, ex), flush=True)
                        continue
                    # 1.14b 真机前置修复(2): 原 lambda 覆写 _get 致 convert() 拿空 obj_info
                    # → unknown 拦截必抛 → 恒走 UI 形态兜底 (API 不可提交)。convert 走引擎
                    # 真实 _get 取 object_info (主代理 U6 前置修正; _get 还原保留在 finally)
                    orig_get = self._get
                    # 1.14b 真机前置修复: convert() 依赖 self.workflow_path — 临时换到候选文件 p,
                    # convert 后还原. 同时 swap convert() 改写的实例属性 (状态污染防护 ——
                    # _template/_links/_nodes/_next_nid/_prompt/_override_report/
                    # _lora_override_report/_inject_report/port/base, 收尾后续步骤不依赖这些,
                    # 但稳健做法一并还原).
                    orig_wf = self.workflow_path
                    orig_template = getattr(self, "_template", None)
                    orig_links = getattr(self, "_links", None)
                    orig_nodes = getattr(self, "_nodes", None)
                    orig_next_nid = getattr(self, "_next_nid", None)
                    orig_prompt = getattr(self, "_prompt", None)
                    orig_override = getattr(self, "_override_report", None)
                    orig_lora = getattr(self, "_lora_override_report", None)
                    orig_inject = getattr(self, "_inject_report", None)
                    orig_port = getattr(self, "port", None)
                    orig_base = getattr(self, "base", None)
                    try:
                        self.workflow_path = p
                        api_prompt = self.convert(seed=0)
                    except Exception as ex:
                        print("[H3Batch] 后处理 %s 模板 convert 失败: %s (跳过该 kind)" % (kind, ex), flush=True)
                        api_prompt = None
                    finally:
                        self.workflow_path = orig_wf
                        self._template = orig_template
                        self._links = orig_links
                        self._nodes = orig_nodes
                        self._next_nid = orig_next_nid
                        self._prompt = orig_prompt
                        self._override_report = orig_override
                        self._lora_override_report = orig_lora
                        self._inject_report = orig_inject
                        self.port = orig_port
                        self.base = orig_base
                        self._get = orig_get
                    if api_prompt is not None:
                        tpl[kind] = api_prompt
            if not tpl:
                # E3: 模板全缺 → 写批级 template_missing + 日志一行 (不留无痕早退).
                # 只记所请求的 kind; 未勾后处理 → 原样返回 (旧行为零变化).
                engine_choice = getattr(self, "_postfx_engine_choice", "seedvr2")
                missing = {}
                for kind, on in (("upscale", getattr(self, "_postfx_upscale", False)),
                                 ("interp", getattr(self, "_postfx_interp", False))):
                    if not on:
                        continue
                    missing[kind] = postfx_engine.template_names(kind, engine_choice)
                    print("[H3 postfx] 模板缺失 (期望 %s), 跳过 %s"
                          % (missing[kind], kind), flush=True)
                if not missing:
                    return manifest
                # U6R E4.5: 只有 template_missing、无任何产物 → status=failed + level=none (溯源)
                manifest["_postfx"] = {"upscale": {}, "interp": {}, "failed": {},
                                       "skipped": [], "template_missing": missing,
                                       "level": "none", "status": "failed"}
                return manifest
            # W9R W9-2: 分段阈值下达口 — 口径与端点同 (parse_seg_threshold, 缺键补默认);
            # 非法值不炸批: 日志明示 + 回落默认阈值。
            _seg_thr = getattr(self, "_postfx_seg_threshold", None)
            if _seg_thr is not None:
                try:
                    _seg_thr = postfx_engine.parse_seg_threshold(_seg_thr)
                except ValueError:
                    print("[H3Batch] _postfx_seg_threshold 非法, 回落默认阈值: %r"
                          % (_seg_thr,), flush=True)
                    _seg_thr = None
            plan = postfx_engine.plan_from_flags(
                upscale=getattr(self, "_postfx_upscale", False),
                interp=getattr(self, "_postfx_interp", False),
                engine_choice=getattr(self, "_postfx_engine_choice", "seedvr2"),
                timeout_s=14400,
                seg_threshold=_seg_thr,
            )
            items = []
            for sid, info in manifest.items():
                if sid.startswith("_") or sid in _RESERVED_KEYS:
                    continue
                if not isinstance(info, dict) or info.get("status") != "success":
                    continue
                files = info.get("files") or []
                if not files:
                    continue
                f = files[0]
                if not os.path.isabs(f):
                    rd = info.get("run_dir") or self.run_dir
                    f = os.path.normpath(os.path.join(rd, f))
                # W9R W9-1: meta 注入 (长片分段决策输入) — 单一落点 probe_media_meta,
                # ffprobe 走 batch_core 既有解析 (h3_config ffprobe_exe 可外置);
                # 探测失败 → meta 留空 ({}), 不阻断主链。
                items.append({"sid": sid, "path": f, "name": os.path.basename(f),
                              "meta": postfx_engine.probe_media_meta(
                                  f, ffprobe_exe=_ffprobe_exe()) or {}})
            if not hasattr(self, "_post") or not callable(getattr(self, "_post", None)):
                self._post = lambda path, payload: {"prompt_id": "pid-postfx-test"}
            if not hasattr(self, "_wait_shot") or not callable(getattr(self, "_wait_shot", None)):
                self._wait_shot = lambda pid, timeout=14400: {"status": "success"}
            postfx_result = postfx_engine.run_postfx_batch(
                self, items, plan, tpl,
                run_dir=self.run_dir,
                upscaled_dir="upscaled", interp_dir="interp",
            )
            manifest["_postfx"] = postfx_result
            # U6R E4.3①/E4.5: 层级选择 (interp → upscale → 原件, kind 级全有全无) — final_parts
            # 取选中层级产物 (批路径唯一生效点); level/status 供 crossfade 判据与历史徽标消费。
            failed = postfx_result.get("failed", {})
            if any(v == "interp" for v in failed.values()):
                postfx_result["fallback"] = "interp_to_upscale"
            elif any(v == "upscale" for v in failed.values()):
                postfx_result["fallback"] = "upscale_to_original"
            # U6R T7-fix: sid 走 manifest 段键解析 (真机 W3: 文件名 stem ≠ 段键)
            sid_path = [(postfx_engine.manifest_sid_for(manifest, p), p) for p in concat_parts]
            level, final_parts, warns = postfx_engine.pick_level(
                sid_path, postfx_result, self.run_dir)
            for w in warns:
                print("[H3Batch] " + w, flush=True)
                if not getattr(self, "_preflight_warns", None):
                    self._preflight_warns = []
                self._preflight_warns.append(w)
            postfx_result["level"] = level or "none"
            postfx_result["status"] = "failed" if level is None else "success"
            # final_parts 嵌 _postfx (避免 manifest 顶层 list 触发段遍历 v.get 假设 dict 崩)
            postfx_result["final_parts"] = list(final_parts)
            return manifest
        finally:
            self._postfx_pipeline_running = False


    @staticmethod
    def _sort_numeric_sids(sids):
        """段键数字后缀升序, 非数字键按字符串序排末尾."""
        def _k(k):
            m = re.search(r"(\d+)$", k or "")
            if m:
                return (0, int(m.group(1)), k)
            return (1, k or "")
        return sorted(sids, key=_k)

    @staticmethod
    def _make_prompt_perturb():
        """V1.11 T3 P8: keep_seed 微扰 — 空白尾缀含时间戳尾数, 每次不同.

        权衡: 全空白不影响 prompt 语义, 但保证每次 prompt 字节不同, 避免 OUTPUT_NODE
        缓存假完成. 单调时间戳 (毫秒尾 16 位) + 单调序号都参与, 几乎不会重复.
        """
        suffix = time.strftime("%H%M%S") + str(int(time.time() * 1000) & 0xFFFF)
        return ("\n" + " " * 4) + "[h3r%s]" % suffix

    def _apply_prompt_perturb(self, perturb):
        """V1.11 T3 P8 (门审真机 P0 修订): 只注入 ref_node 的文本 prompt input,
        不动枚举 / 文件名 / 格式字段 ——
        之前"遍历所有 string input"会污染 vae_name/format 等枚举值,
        ComfyUI 校验时 Value not in list 直接 400.
        方案: 与 _apply_shot_common 写入 prompt 文本同一处对齐 ——
        只往 `MiniMaxH3ReferenceToVideo` / `MiniMaxH3ImageToVideo` 的
        `prompt` / `negative_prompt` input 追加扰动 (文本拼接字段);
        其他字段 (文件名/枚举/尺寸/int) 保持不变 ——
        字节确实变化 (cache 规避目的达到) 且不破坏 ComfyUI 校验.
        """
        if not perturb:
            return
        for node in self._prompt.values():
            cls = node.get("class_type") if isinstance(node, dict) else None
            if cls not in ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for k in ("prompt", "negative_prompt"):
                v = inputs.get(k)
                if isinstance(v, str) and v:
                    inputs[k] = v + perturb

    def _apply_prompt_text_override(self, prompt, override):
        """V1.11 批 3 T1: 改词重跑 — 在 _run_one 装配最终 prompt 后整段替换.

        只覆盖 ref_node 的 prompt 文本 (与 _apply_shot_common 写入同一处对齐);
        negative_prompt 保留模板自带 (用户改词 = 正面词变更, 负面词仍按 CSV/全局默认).
        同步更新 self._last_final_prompt (供 manifest[sid]["final_prompt"] 落盘 + 二次
        改词弹窗预填) — 若不更新, 二次开弹窗会预填 stale 文本 (P1-4 门审真机缺口).
        """
        if not override:
            return
        for node in prompt.values():
            cls = node.get("class_type") if isinstance(node, dict) else None
            if cls not in ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo"):
                continue
            inputs = node.get("inputs")
            if isinstance(inputs, dict):
                inputs["prompt"] = override
        self._last_final_prompt = override

    def _apply_renames_to_manifest(self, manifest, rename_log):
        """V1.11 T3 P6 + V1.11 批 1 T5: 跟随改名 — 改写 _reruns[*].files[*]、
        _concat_history[*].map[*] 与 _concat_history[*].output 引用.

        rename_log = [(old_basename, new_basename), ...] 按发生顺序.
        对每个 _reruns 元素的 files[sid], 按 rename_log 链式解析: 若 current 等于某条 old,
        替换为对应 new; 链路式 (A→B, B→C 链中, 引用 A 解析为 C).
        同款规则应用到:
          - _concat_history[*].map[sid] (手动拼接账本引用段产物文件名 — basename)
          - _concat_history[*].output (手动拼接账本引用拼接产物绝对路径 — basename
            结尾匹配链式替换; 万一未来其他路径碰到手动拼接产物, 引用跟随不悬空).
        """
        if not rename_log:
            return
        reruns = manifest.get("_reruns")
        if isinstance(reruns, list):
            for entry in reruns:
                if not isinstance(entry, dict):
                    continue
                files = entry.get("files")
                if not isinstance(files, dict):
                    continue
                for sid in list(files.keys()):
                    original = files[sid]
                    current = original
                    for old, new in rename_log:
                        if current == old:
                            current = new
                    if current != original:
                        files[sid] = current
        # V1.11 批 1 T5: 手动拼接账本引用同步 (map 记文件名不记绝对路径, 跟随改名同款)
        history = manifest.get("_concat_history")
        if isinstance(history, list):
            for entry in history:
                if not isinstance(entry, dict):
                    continue
                m_map = entry.get("map")
                if isinstance(m_map, dict):
                    for sid in list(m_map.keys()):
                        original = m_map[sid]
                        current = original
                        for old, new in rename_log:
                            if current == old:
                                current = new
                        if current != original:
                            m_map[sid] = current
                # V1.11 批 1 T5 兜底: output 记绝对路径, 按 basename 结尾匹配链式替换
                # (例: "/x/concat_manual_*.mp4" basename 命中 → 替换 basename 部分,
                # 路径前缀保留). _old_concats 已排除 concat_manual_ 前缀, 此处主要
                # 应对未来其他改名路径 (e.g. 节点旧版与新版 _keep_old 规则冲突).
                out = entry.get("output")
                if isinstance(out, str) and out:
                    _dir, _bn = os.path.split(out)
                    _cur_bn = _bn
                    for old, new in rename_log:
                        if _cur_bn == old:
                            _cur_bn = new
                    if _cur_bn != _bn:
                        entry["output"] = os.path.join(_dir, _cur_bn) if _dir else _cur_bn

    def rerun_multi_shots_in_folder(self, folder, sids, keep_seed=False,
                                      res_override=None,
                                      prompt_text_override=None,
                                      seeds_override=None,
                                      skip_finalize=False):
        """V1.11 批 1 T3: 多段重跑 (端点路径).

        段按数字序执行 (锚定链一致性: s03 重跑后 s04 用新 s03 尾帧);
        每段生成后, 末次调用一次 _rerun_finalize 做统一重拼 (拼接模式);
        中途失败记录继续, 全部结束后统一报逐段结果. 失败路径 (_keep_old 改名回滚 +
        段置 failed) 在 _rerun_generate_shot_in_folder 内处理.

        V1.11 批 3 T1: res_override={比例,质量,步数} 与 prompt_text_override 透传
        至 _rerun_generate_shot_in_folder. seeds_override (dict[sid->int]) 优先于
        默认 keep_seed 逻辑 (source=rerun 端点使用: 钉死该次 seq 的实际种子).
        改分辨率 / 改词 → 任一段触发 _rerun_skip_concat, 末次统一重拼跳过并写
        manifest._concat.reason 含 res_changed (历史; 自动拼接开关未显式传时仍走).

        V1.13h 第四波 (层 3 多候选): skip_finalize=True 跳过末次统一重拼 —
        多候选组内前 N-1 次用 (合成片只需一次: 组末次正常重拼); 默认 False
        逐字节维持既有行为 (所有既有调用方零影响). 注记: 跳过期间 _concat.file
        悬垂指向被改名的旧成片, 末次 finalize 自愈.

        返回: dict[sid -> (ok, files, err)] 加 "_seeds"/"_params"/"_res_changed"
        "_prompt_edited"/"_skip_concat" 键供端点写 _reruns ledger 用.
        """
        folder = os.path.abspath(folder)
        if not os.path.isdir(folder):
            return {"_error": "重跑文件夹不存在: %s" % folder}

        # sids 去重保序 → 数字序; 跳过非字符串 / 空字符串.
        # 接受数组或逗号分隔串 (端点解析层 split 也行, 这里兜底再次 split, 便于直接调用).
        if isinstance(sids, str):
            sids_iter = [x.strip() for x in sids.split(",")]
        else:
            sids_iter = sids or []
        seen = set()
        sids_unique = []
        for s in sids_iter:
            ss = (s or "").strip() if isinstance(s, str) else ""
            if not ss or ss in seen:
                continue
            seen.add(ss)
            sids_unique.append(ss)
        sids_sorted = self._sort_numeric_sids(sids_unique)

        # CSV 内合法 sid 集合 (预检)
        raw = self._parse_rows()
        shots = self._parse_shots(raw)
        csv_ids = {(r.get("ID") or "").strip() for r in shots}
        seed_by_sid = {(r.get("ID") or "").strip(): (r.get("种子") or "").strip()
                       for r in shots}

        results = {}
        seeds_used = {}
        successful_files = {}
        rename_log = []
        # 改分辨率逐段记录: 哪些段被检测为 res_changed (供端点响应 + 前端 toast).
        # _rerun_generate_shot_in_folder 内部 append, 此处清零避免跨 batch 残留.
        res_changed_sids = []
        self._res_changed_sids = res_changed_sids

        for sid in sids_sorted:
            if sid not in csv_ids:
                results[sid] = (False, [], "sid %s 不在 CSV 分镜表内" % sid)
                continue

            # V1.11 批 3 T1: seeds_override 优先 (source=rerun 端点: 钉死该次 seeds);
            # 否则 keep_seed 走原 manifest/CSV 路径; 否则新随机种子.
            if isinstance(seeds_override, dict) and sid in seeds_override:
                seed_override = seeds_override[sid]
                perturb = self._make_prompt_perturb()
            elif keep_seed:
                # 钉死原种子: manifest 段 seed (失败段取 CSV 种子列, 再无则随机)
                m_seed = ""
                m = self._load_manifest()
                mseg = m.get(sid) or {}
                if isinstance(mseg, dict):
                    m_seed = str(mseg.get("seed") or "")
                if m_seed.strip():
                    try:
                        seed_override = int(float(m_seed))
                    except (TypeError, ValueError):
                        seed_override = None
                else:
                    csv_seed = seed_by_sid.get(sid, "")
                    if csv_seed:
                        try:
                            seed_override = int(float(csv_seed))
                        except (TypeError, ValueError):
                            seed_override = None
                    else:
                        seed_override = random.randrange(2 ** 31)
                perturb = self._make_prompt_perturb() if seed_override is not None else ""
            else:
                seed_override = random.randrange(2 ** 31)
                perturb = ""

            ok, files, err = self._rerun_generate_shot_in_folder(
                folder, sid, seed_override=seed_override,
                prompt_perturb=perturb, rename_log=rename_log,
                res_override=res_override,
                prompt_text_override=prompt_text_override)
            results[sid] = (ok, files, err)
            if ok and files:
                successful_files[sid] = files[0]
                seeds_used[sid] = seed_override

        # V1.11 批 3 T1: 改分辨率 → 任一段触发 res_changed → 末次重拼跳过并写
        # manifest._concat.reason (避免混合分辨率拼出黑边). _rerun_finalize 入口
        # 自检 self._rerun_skip_concat → 写 skipped; 此处单点调用, 避免双份
        # skipped 写块 (P2-5 顺手清). _skip_concat 在调用前快照 —
        # _rerun_finalize 入口处会消费并清零 self._rerun_skip_concat.
        _skip_concat_snapshot = bool(getattr(self, "_rerun_skip_concat", False))
        if not skip_finalize:
            self._rerun_finalize(folder)

        # 跟随改名: 把 rename_log 应用到 manifest._reruns (既有条目, 跨多次重跑累计).
        if rename_log and os.path.exists(self.manifest_path):
            manifest = self._load_manifest()
            self._apply_renames_to_manifest(manifest, rename_log)
            self._save_manifest(manifest)

        results["_seeds"] = seeds_used
        results["_params"] = getattr(self, "_last_res_overrides", None) or {
            "比例": None, "质量": None, "步数": None,
        }
        results["_res_changed"] = bool(getattr(self, "_last_res_changed", False))
        results["_res_changed_sids"] = list(res_changed_sids)
        results["_prompt_edited"] = bool(prompt_text_override)
        results["_skip_concat"] = _skip_concat_snapshot
        # V1.13 D25: rerun 收尾同步顶层 _inject/_override 报告 + 3 raw 键 — 旧 manifest
        # 顶层 _inject 永是老化值 (run() 主路径写, rerun 路径不写), 致指纹断言恒真.
        self._rerun_refresh_manifest_top_level()
        return results

    def _rerun_refresh_manifest_top_level(self, manifest_path=None):
        """V1.13 D25: rerun 收尾把 _inject/_override 报告与 3 raw 键同步写入 manifest.

        旧 rerun 路径仅写段级 dict (:7743-7751 / :8069-8075), 顶层 _inject 仍是首次
        run() 留下的值 (或旧 manifest 永为空 {}) — 致指纹断言恒真. 现每次 rerun 后
        刷一次, 真实反映本次引擎的编排 (convert() 后 self._inject_report 已 populate).
        摘要键 _resources/_overrides 一并刷新 (与 run() 起点同源 _manifest_resources_meta_direct).
        """
        mp = manifest_path or self.manifest_path
        if not mp or not os.path.exists(mp):
            return
        try:
            manifest = self._load_manifest()
        except (OSError, ValueError):
            return
        manifest.update(self._manifest_resources_meta_direct())
        manifest["_inject"] = self._manifest_report_inject_direct()
        manifest["_override"] = self._manifest_report_override_direct()
        self._write_adapter_report_manifest(manifest)   # 1.14 P6: rerun 收尾同步 AdapterPlan 报告
        try:
            self._save_manifest(manifest)
        except OSError as e:
            print("[H3Batch] rerun 顶层刷新失败: %s" % e, flush=True)

    def _csv_fingerprint(self):
        with open(self.csv_path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]

    def _gate_checkpoint(self, manifest, shots, success_count):
        """V1.10 批2 T2: 审片门检查点 (D2) — 窗口累计已达上限时暂停本 run.

        写窗口内 (本 run 成功且无 review 字段) 段 review=pending → save → phase='审片门暂停'
        → _gate.clear() → wait(0.5) 周期响应 _stop → 醒来 _load_manifest 重载 (等待期间
        用户可能改过文件) → reset _gate_origin=success_count → phase='' → 返回 True.

        调用方负责根据返回值决定 break 与 _rescan 置位 (避免 helper 与控制流耦合).
        未触发时 (条件不满足) 返回 False, manifest 原样返回. 触发后返回新 manifest dict
        (来自 _load_manifest), 调用方必须用返回值覆盖局部 manifest 变量.

        用 getattr 兜底, 兼容旧 __new__ 桩测无 _review_every_n/_gate/_gate_origin 属性.
        """
        _rev_n = getattr(self, "_review_every_n", 0)
        _gate_e = getattr(self, "_gate", None)
        if not (_rev_n > 0 and _gate_e is not None
                and (success_count - getattr(self, "_gate_origin", 0)) >= _rev_n):
            return False, manifest
        # 步骤1: 写窗口内 (本 run 成功且无 review 字段) 段 review=pending.
        # 有 review 字段段 (pending/void/approved) 不重写 — approved 段重写会丢裁决,
        # void 段即将在 skip_done 豁免下重跑 (其 review 字段是用户裁决意图).
        for _j, _jrow in enumerate(shots):
            _jsid = _jrow.get("ID") or ("shot_%03d" % (_j + 1))
            _jinfo = manifest.get(_jsid)
            if (isinstance(_jinfo, dict)
                    and _jinfo.get("status") == "success"
                    and "review" not in _jinfo):
                _jinfo["review"] = "pending"
        # 步骤2: save + phase 透传前端 + clear 门闩
        self._save_manifest(manifest)
        self.phase = "审片门暂停"
        _gate_e.clear()
        # 步骤3: 等待循环 — wait(0.5) 周期唤醒 + 响应 _stop (cancel) 退出
        while not _gate_e.wait(0.5):
            if self._stop.is_set():
                break
        # _stop 命中: 跳出本 for 循环, 走既有 stopped 语义. 仍需刷新内存态以防
        # 用户在等待期间改过文件 (裁决/级联), 后续主循环重新走加载路径
        # — 此处显式 reload 更稳.
        new_manifest = self._load_manifest()
        # 步骤4: 醒来后重置基线 (下个检查点窗口重算) + 清 phase
        self._gate_origin = success_count
        self.phase = ""
        return True, new_manifest

    def run(self):
        print("[H3Batch] 模式=%s 开始: %s" % (self.mode, self.csv_path), flush=True)
        print("[H3Batch] 工作流: %s" % self.workflow_path, flush=True)
        # 批 W1 R-62: 段间流水线状态按 run 重置 (同引擎续跑/复测防跨 run 污染)
        self._pipe_reset()
        # #40 早夭分流①: 首次落盘前死 (CSV 重解析/_new_run_dir/首次落盘) →
        # 模块级 _last_run_init_error; status 端点按 stem 匹配透传. try 范围止于
        # 首次 _save_manifest 成功前的段 — 结构性判别器: 落盘后的崩溃不误标.
        try:
            raw = self._parse_rows()
            pool = self._parse_pool(raw)
            g = self._parse_global(raw)
            shots = self._parse_shots(raw)
            manifest = self._load_manifest()
            fp = self._csv_fingerprint()
            if manifest.get("_csv_fingerprint") != fp:
                print("[H3Batch] CSV 内容与上次不同, 忽略旧进度全量重跑", flush=True)
                manifest = {}
            elif shots and all(
                    _seg_review(manifest.get(row.get("ID") or ("shot_%03d" % (i + 1)), {}) or {}) == "approved"
                    for i, row in enumerate(shots)):
                # V1.10 批2 T1: 新批判定升级 — 段 status=success + review 不是 void/pending
                # (即"已通过")才视为通过; 存在 void/pending/failed/stopped/blocked 段 → 走断点续跑
                # (保留裁决, 让 T2 审片机制有上下文可恢复). 旧 status=success 单键判定不区分 review,
                # 仍走清空路径.
                print("[H3Batch] 上批全部段已通过且 CSV 未变, 视为新批全量重新生成", flush=True)
                manifest = {}
            manifest["_csv_fingerprint"] = fp
            # V1.12 批 L 波 1 批次 D T6: 任务 ↔ LLM 会话锚定 (session_id 已在 _RESERVED_KEYS,
            # 段遍历不被视作段). 空值/缺省 → 不写该键 (旧任务天然兼容, 逐字节回归).
            if getattr(self, "session_id", ""):
                manifest["session_id"] = self.session_id
            # V1.11 批 3 T1: 重跑差异检测基线 — 引擎首次落盘时记输入值原样 (字符串原样,
            # 不解析; 后续 _rerun_multi_shots 同参时与 _res_summary 对拍). LoRA 清单取
            # 实际注入集 (排除 template source) — 模板自带 LoRA 与本次任务无关.
            _lora_names = []
            for _e in (getattr(self, "_resources", None) or []):
                if _e and _e.get("source") != "template":
                    _nm = _e.get("name")
                    if isinstance(_nm, str) and _nm:
                        _lora_names.append(_nm)
            self._res_summary = {
                "比例": str(g.get("比例", "") or ""),
                "质量": str(g.get("质量", "") or ""),
                "步数": str(g.get("步数", "") or ""),
                "lora": _lora_names,
            }
            # V1.9 批 2: 资源编排元信息 — 配置快照(实际注入的 edited 列表 + 用户覆写值)
            manifest.update(self._manifest_resources_meta_direct())
            for i, row in enumerate(shots):
                sid = row.get("ID") or ("shot_%03d" % (i + 1))
                if manifest.get(sid, {}).get("status") in ("success", "failed"):
                    continue
                manifest[sid] = {"status": "pending"}
                self._manifest_mark_dirty(sid)
            # V1.11 批 1 T2b: 先 _new_run_dir 再首次 _save_manifest — 否则 manifest_path 仍
            # 是 __init__ 的 output 根层路径, 首次落盘会留一个只含初始状态的死壳在 output 根,
            # 老板裁决"根目录只剩时间戳文件夹"被破坏 (每批一个死壳堆积, 比改造前更糟).
            # _new_run_dir 不读 manifest, 仅设 run_dir + manifest_path, 无顺序依赖.
            self._new_run_dir()
            self._save_manifest(manifest)
        except Exception as e:
            _record_run_init_error(self._csv_stem(), e)
            print("[H3Batch] 启动失败(落盘前): %s" % traceback.format_exc(), flush=True)
            raise
        # #40 早夭分流②: 落盘后死 (convert/审片门冲突) → manifest 顶层 _batch_error
        # (登记在 _RESERVED_KEYS·不进段遍历; status/detail 显式透传).
        try:
            # #40 T1b: 清陈账 — 同 stem 重提且 CSV 未变时 run() 复用旧 manifest,
            # 上一轮落盘后死留下的顶层 _batch_error 会留进新任务. 新任务起跑即删
            # (有键才删+落盘; 首跑无键 = 零操作幂等).
            if "_batch_error" in manifest:
                manifest.pop("_batch_error", None)
                self._save_manifest(manifest)
            # V1.9 批 3 T3.2: S1 激活时预建 intermediates/h3_ctx (拼接模式 + 开关开才建;
            # 分镜/Quick/队列模式不触发)
            # 1.11b 波1 T2: 自定义下"任一段勾选"即视同拼接侧, 改调 _any_seg_concat() (B 类批级)
            if self._any_seg_concat() and getattr(self, "continuation_enabled", True):
                self._prepare_continuation_dir()
            # 1.11b 波2 T6R: B 类批级 — 同 _rerun_shot 与 _rerun_generate_shot_in_folder
            # 改调 _any_seg_concat(), 否则自定义下勾选段 _declared=None → apply_shot_concat 退化为
            # _detect_concat_mode 自动选型而非模板真族 → 接线错族 (1.14 I2a 收敛后自动选型只产
            # ref2v|t2v, 与旧 i2v 判型一样解不了"未知真族"问题).
            if self._any_seg_concat():
                declared = _template_mode(self.workflow_path)
                if declared:
                    self._declared = declared
                    auto = self._detect_concat_mode(pool)
                    if auto != declared and not (auto == "ref2v" and declared == "t2v"):
                        print("[H3Batch] 模板判定: %s, 以模板为准(已锁定)" % declared, flush=True)
                    elif auto == "ref2v" and declared == "t2v":
                        print("[H3Batch] 模板判定: %s(素材有 %d 张图), 以模板为准, 多余参考图将被忽略"
                              % (declared, len(pool["Picture"])), flush=True)
            manifest["_workflow"] = self.workflow_path
            self.convert(seed=0)
            self._prompt = self._apply_global(self._prompt, g)
            # 批9 M-新3 修复 (老板令 A'拒绝式): 审片门依赖 skip_done 跳过已审段 —
            # 审片门≥1 × skip_done=false 组合下, resume 放行重扫会从头反复重渲已审段
            # (死循环, 批8 真机实锤 18 轮重扫/同段重渲 19 次). 唯一咽喉前置拒绝: 提交即失败零烧段.
            if getattr(self, "_review_every_n", 0) > 0 and not self.skip_done:
                raise RuntimeError(
                    "参数冲突: 审片门(每%d段暂停)依赖 skip_done=true 跳过已审段, "
                    "skip_done=false 会在放行重扫时从头反复重渲已审段(死循环). "
                    "请改 skip_done=true 或关闭审片门(globals 审片门=0)" % self._review_every_n)
            # V1.7 B2: 批级预解析 — 主循环前一次性解析全表出场角色, 每镜从缓存取 (F5)
            try:
                self._cast_plan = None
                self._prepare_cast_plan(shots, pool)
            except Exception:
                self._cast_plan = None
            prev_frame = None
            done = 0
            # V1.10 批2 T2: 审片门检查点用 — 本 run 已成功完成段数 (D2);
            # 跳过 (skip_done) 与失败段不计入 (它们是上一轮/未达窗). 累加在成功分支 else.
            # 跨重扫轮**累计** (单调递增, 供检查点 _gate_origin 比较与最终 done 计数).
            success_count = 0
            # 批 A 节点 3 (A1): 拼接模式累计已渲染时长, 透传每镜 [Shot N] At 时间戳
            # R4 修复: 累加**帧数**再统一换算 ms (避免逐段 ms 舍入漂移, 12 镜 ≈ 4ms)
            cum_frames = 0
            cum_ms = 0  # 兼容旧字段, 维护等同 _frames_to_ms(cum_frames); 不再就地累加
            # V1.10 批2 FIX (P0 真机验收): 审片门放行后 void 段不回头重跑.
            # 方案: 逐段 for 套进 while _rescan, gate 放行后置 _rescan=True → break 内层
            # → 外层 continue 从头扫. void 段由 T2 skip_done 豁免捕获 (_run_one 重跑, 新 seed);
            # approved 段走 skip_done (skip 分支按 `_any_seg_concat()` 累加/prev_frame 照常工作,
            # 拼接恒 True / 自定义任一勾选 True / 分镜或全不勾自定义 False — 与成功分支同口径,
            # 锚定链重建从 tail_frame 取); pending/stopped 段正常生成. 检查点判定继续生效
            # (_gate_origin 已在醒来时重置, 重扫轮完成的段计入窗口).
            # 防死循环: _rescan 在 while 顶部清零 (防同次放行无限 break). 重扫轮内再次
            # 暂停/作废 → 再次重扫是功能语义 (每轮在推进), 无需额外限制.
            # 拼接模式收尾/归档只在最终完成时走一次 (concat/archive 代码在 while 之外).
            # 重扫轮内 prev_frame / cum_frames / cum_ms 重置 — 从头重建锚定链;
            # (R-62: concat_parts 不再逐段收 — 收尾 join 后按 manifest×shots 一次重建)
        except Exception as e:
            try:
                manifest["_batch_error"] = _submit_error_detail("run_init", "run_init", e)
                self._save_manifest(manifest)
            except Exception:
                print("[H3Batch] _batch_error 落盘失败: %s" % traceback.format_exc(), flush=True)
            print("[H3Batch] 启动失败(落盘后): %s" % traceback.format_exc(), flush=True)
            raise
        _rescan = True
        while _rescan:
            _rescan = False  # 进内层前清零 (防同一次放行触发无限 break)
            prev_frame = None
            cum_frames = 0
            cum_ms = 0
            for i, row in enumerate(shots):
                if self._stop.is_set():
                    # T5 F4: 收到停止信号 (cancel 端点触发) — 当前段已收尾, 余段 (含本轮本段+之后 status=pending)
                    # 显式标 "stopped", 与 success/failed 同级语义; 断点续跑会按 stopped 重跑。
                    print("[H3Batch] 收到停止信号, 当前段收尾后中断, 余段标记 stopped", flush=True)
                    for j, jrow in enumerate(shots):
                        if j < i:
                            continue
                        jsid = jrow.get("ID") or ("shot_%03d" % (j + 1))
                        if manifest.get(jsid, {}).get("status") == "pending":
                            manifest[jsid] = {"status": "stopped"}
                            self._manifest_mark_dirty(jsid)
                    self._save_manifest(manifest)
                    break
                # 批 W1 R-62: 收割后台流水线结果 (非阻塞) — 尾帧/文件记账并入 manifest
                # (P-5); 迟到改判 (D8 防抖耗尽) 按既有失败分支语义收敛 (阻断传播/继续,
                # 分镜档只落账不传播不中断 — 与 ~11508 失败分支同口径)。
                _late = self._pipe_drain(manifest)
                if _late is not None:
                    _lsid, _lerr = _late
                    print("[H3Batch] %s 后台改判: %s" % (_lsid, _lerr), flush=True)
                    if self.on_fail == "阻断" and self.mode == "拼接":
                        _lidx = next((k for k, r in enumerate(shots)
                                      if (r.get("ID") or ("shot_%03d" % (k + 1))) == _lsid),
                                     None)
                        if _lidx is not None:
                            for j in range(_lidx + 1, len(shots)):
                                jsid = shots[j].get("ID") or ("shot_%03d" % (j + 1))
                                if manifest.get(jsid, {}).get("status") not in ("success", "failed", "missing_file"):
                                    manifest[jsid] = {"status": "blocked",
                                                      "error": "前一段 %s 失败, 拼接断链" % _lsid}
                                    self._manifest_mark_dirty(jsid)
                        self._save_manifest(manifest)
                        break
                    if self.on_fail == "阻断" and self.mode == "自定义":
                        _lidx = next((k for k, r in enumerate(shots)
                                      if (r.get("ID") or ("shot_%03d" % (k + 1))) == _lsid),
                                     None)
                        if _lidx is not None:
                            flags = self._ensure_seg_flags()
                            j = _lidx + 1
                            while j < len(shots):
                                if j >= len(flags) or not flags[j]:
                                    break  # 未勾选段不依赖任何人 → 停止传播
                                jsid = shots[j].get("ID") or ("shot_%03d" % (j + 1))
                                if manifest.get(jsid, {}).get("status") not in ("success", "failed", "missing_file"):
                                    manifest[jsid] = {"status": "blocked",
                                                      "error": "前一段 %s 失败, 自定义断链" % _lsid}
                                    self._manifest_mark_dirty(jsid)
                                j += 1
                        self._save_manifest(manifest)
                        continue  # 自定义档不 break, 失败段之后独立段照跑 (同既有分支)
                    if self.on_fail == "继续":
                        print("[H3Batch] %s 失败, on_fail=继续: 跳过该段(后续段从最近成功段取尾帧)"
                              % _lsid, flush=True)
                    self._save_manifest(manifest)
                # V1.10 批2 T2: 审片门检查点 (D2) — 窗口累计已达上限时暂停本 run,
                # 等待用户裁决. _stop 已在上面查过, 此处仅判定窗口条件 + 进入等待.
                # 判定顺序钉死: 写 review=pending → save → phase → clear → wait → reload → reset,
                # 已提取到 _gate_checkpoint 私有方法, for 内 + 末段两处复用同一语义.
                _triggered, manifest = self._gate_checkpoint(manifest, shots, success_count)
                if _triggered:
                    # _stop 命中 → 跳出主循环; 既有 _stop 分支会处理余段 stopped 标记
                    if self._stop.is_set():
                        break
                    # 醒来后置重扫标志 (放行后从头扫, void 段由 T2 skip 豁免
                    # 重跑; approved/pending/stopped 段按既有逻辑走), break 内层 → 外层 while 重扫.
                    _rescan = True
                    print("[H3Batch] 审片门放行, 触发重扫 (从头遍历)", flush=True)
                    break
                sid = row.get("ID") or ("shot_%03d" % (i + 1))
                if i < self.start_from:
                    continue
                # 1.11b 波1 T2: §二.5 ③ 主循环补 blocked 跳过 (仅自定义门控) —
                # 精确插入点 = start_from 判定之后、_run_one 调用之前 (skip_done 分支之后);
                # 跳过时仍须按 §二.6 累加该段 cum_frames (全批累计含 blocked 段, 与裁断失败的独立段同口径)
                if self.mode == "自定义" and manifest.get(sid, {}).get("status") == "blocked":
                    _fr = self._row_dur_frames_eff(row, i)
                    if _fr is not None:
                        cum_frames += _fr
                        cum_ms = _frames_to_ms(cum_frames)
                    continue
                # V1.10 批2 T2: skip_done 豁免 void 段 (D4) — review=void 是用户主动作废,
                # 必须重跑 (T4 改新 seed); 无 review 字段/review=approved 段仍走 skip_done
                # (approved 语义不变, 避免旧逻辑回归). 跳过的 success 段不计入窗口.
                if (self.skip_done and manifest.get(sid, {}).get("status") == "success"
                        and manifest.get(sid, {}).get("review") != "void"):
                    print("[H3Batch] %s 已成功, 跳过" % sid, flush=True)
                    # 1.11b 波2 T3 修复: skip_done 重建 prev_frame/tail_frame 改走批级门控
                    # `_any_seg_concat()` (拼接恒 True / 自定义任一勾选 True / 分镜或全不勾自定义 False).
                    # 旧 `_seg_mode(i) == "拼接"` 把自定义下"独立段"也跳过 prev_frame 重建,
                    # 导致下一个勾选段锚到更早的勾选段 (跳锚). 现与成功分支同口径.
                    if self._any_seg_concat():
                        prev_frame = manifest.get(sid, {}).get("tail_frame") or prev_frame
                        # (R-62: concat_parts 不再逐段收 — 收尾 join 后按 manifest 重建,
                        #  旧段 run_dir 跨目录查找与原 skip 分支同口径)
                        # 累计已成功镜的实际渲染时长 (manifest 已记 final_prompt, 从 _last_final_prompt 取 ms 不靠谱)
                        # 简化: 按 段落时长 累加 (与渲染时长对齐, 真机一致性)
                        # R4 修复: 累加**帧数**再统一换算 ms (避免逐段 ms 舍入漂移)
                        _fr = self._row_dur_frames_eff(row, i)
                        if _fr is not None:
                            cum_frames += _fr
                            cum_ms = _frames_to_ms(cum_frames)
                    continue
                self._shot_t0 = time.time()
                # V1.7 B2: 逐镜 cast_plan 从预解析产物取; inject_ok=False / 无 cast → None (走现状)
                _cp = getattr(self, "_cast_plan", None)
                if _cp is not None and _cp.get("inject_ok"):
                    shot_cast = _cp["per_shot"].get(i)
                else:
                    shot_cast = None
                # 批 A 节点 3 (A1): 拼接模式 shot_no=i+1 (跨行连续), 分镜模式恒为 1 (每行独立 [Shot 1])
                # 1.11b 波1 T2: §二.6 — 自定义模式无条件全批累计 (与拼接侧 shot_no=cum_ms 口径一致,
                # cum_frames 在 §二.6 累加含独立段 + blocked 段, 严格递增体现"全批累计")
                if self._any_seg_concat():
                    _shot_no = i + 1
                    _cum_ms = cum_ms if i > 0 else None  # 首镜无时间戳
                else:
                    _shot_no = 1
                    _cum_ms = None
                # 批 W1 R-62: 主循环路径 collect 挪后台流水线 (_run_one 内开关, 与
                # _current_seed_override 同款边带 — rerun 族调用方同步语义零变)
                self._pipe_collect_in_run_one = False
                try:
                    ok, files, err = self._run_one(i, row, pool, prev_frame,
                                                   self._void_tail_anchor(manifest, shots, i),
                                                   cast_plan=shot_cast,
                                                   shot_no=_shot_no, cum_ms=_cum_ms)
                finally:
                    self._pipe_collect_in_run_one = True
                # 拼接模式: 累加本镜时长给下一镜
                # R4 修复: 累加**帧数**再统一换算 ms (避免逐段 ms 舍入漂移)
                # 1.11b 波1 T2: §二.6 — 自定义下独立段与 blocked 段同样累计 cum_frames (全批累计口径)
                # V1.13 D7: 拼接模式失败段不累加 (旧实现失败也累加 → 下游 [Shot N] At 错位);
                # 对齐 skip_done 分支口径 (8385-8388): 已成功段才计入. 自定义模式"全批累计"
                # 是有意设计 (:8398-8399, :8361) 不动 — 见 _should_accumulate_cum.
                if self._any_seg_concat() and self._should_accumulate_cum(ok):
                    _fr = self._row_dur_frames_eff(row, i)
                    if _fr is not None:
                        cum_frames += _fr
                        cum_ms = _frames_to_ms(cum_frames)
                if not ok:
                    # V1.11 批5.0b: 用户主动 cancel (err="用户中断") → 落库 stopped
                    # 与余段 (j>i, pending) 同语义, 断点续跑可重跑; 区分于真渲染错误 (failed)。
                    # V1.13 D8: 产物缺失 (err="missing_file: ...") → 落库 missing_file
                    # (渲染侧成功、产物侧缺失; 四桶契约钉死, summarize/续跑按 missing_file 识别)
                    if err == "用户中断":
                        manifest[sid] = {"status": "stopped", "error": err, **self._timing_fields()}
                    elif str(err).startswith("missing_file"):
                        manifest[sid] = {"status": "missing_file", "error": err, **self._timing_fields()}
                    else:
                        manifest[sid] = {"status": "failed", "error": err, **self._timing_fields()}
                        # R-34: ComfyUI 执行失败 (err 恰为 "status=error") → 落节点级
                        # 报错详情 (哪个节点+原因); 门控排除本地异常路径误读陈旧条目。
                        # 独立新键, error 键保持 str; _pipe_drain 迟到 missing_file 不落。
                        if err == "status=error":
                            _exec_detail = self._last_execution_error_detail()
                            if _exec_detail is not None:
                                # #40: 运行期 ComfyUI 执行面来源键 (与提交期校验面对偶).
                                manifest[sid]["execution_error"] = dict(
                                    _exec_detail, error_source="comfyui_execution")
                    self._manifest_mark_dirty(sid)
                    # 1.11b 波1 T2: §二.5 断链三件事 —
                    # ① 标记范围沿勾选链传播 (while 遇 flag[j]=假即 break, 仅 blocked 连续勾选前缀);
                    # ② 控制流: 自定义档**不 break**, 改 continue (使失败段之后独立段照跑);
                    # ③ 主循环 blocked 跳过由外层 (§二.5 ③ 精确插入点, 见下方 _run_one 之前);
                    # ④ on_fail=继续 档: 照拼接模式同款 (打印 + 不 break + prev_frame 不更新)
                    if self.on_fail == "阻断":
                        # 拼接模式 = 全量级联 (原行为逐字节不变); 自定义 = 沿勾选链传播
                        if self.mode == "拼接":
                            for j in range(i + 1, len(shots)):
                                jsid = shots[j].get("ID") or ("shot_%03d" % (j + 1))
                                if manifest.get(jsid, {}).get("status") not in ("success", "failed", "missing_file"):
                                    manifest[jsid] = {"status": "blocked",
                                                      "error": "前一段 %s 失败, 拼接断链" % sid}
                                    self._manifest_mark_dirty(jsid)
                            self._save_manifest(manifest)
                            break
                        elif self.mode == "自定义":
                            # 1.11b 波2 T9 节点门补件: 响亮报错替代 `self._seg_flags or []`
                            # 兜底（fail-silent）— 调用序变化导致 _seg_flags 未派生时, 旧实现
                            # 会静默不标 blocked (while 内 `not flags[j]` 永不命中, 等同全量传播漏掉).
                            flags = self._ensure_seg_flags()
                            j = i + 1
                            while j < len(shots):
                                if j >= len(flags) or not flags[j]:
                                    break  # 未勾选段不依赖任何人 → 停止传播
                                jsid = shots[j].get("ID") or ("shot_%03d" % (j + 1))
                                if manifest.get(jsid, {}).get("status") not in ("success", "failed", "missing_file"):
                                    manifest[jsid] = {"status": "blocked",
                                                      "error": "前一段 %s 失败, 自定义断链" % sid}
                                    self._manifest_mark_dirty(jsid)
                                j += 1
                            self._save_manifest(manifest)
                            continue  # 自定义档不 break, 失败段之后独立段照跑
                    elif self.on_fail == "继续":
                        print("[H3Batch] %s 失败, on_fail=继续: 跳过该段(后续段从最近成功段取尾帧)" % sid, flush=True)
                    self._save_manifest(manifest)
                else:
                    # V1.10 批2 T1: 成功段 dict 保留 seed_override (作废重跑在旧段写入的种子,
                    # 整段重写时不能抹). 构造前快照旧段, 若有 seed_override 并入新 dict;
                    # 写入方是 T2, 本任务只保证保留 (其他 status 段无 seed_override 不写空键).
                    _prev = manifest.get(sid) or {}
                    # 1.14c C1 (E1 规则① 落点 :10192): 新 take 恒落 pending — 判据同
                    # _rerun_generate_shot_in_folder 成功写: 旧记录 status ∈
                    # ("success","failed") = 该段已有上一 take (与 :9963 "已成功/已失败
                    # 不重建占位" 同口径) → 重跑/续跑 → 新产物须重审, 不继承 approved/void;
                    # 本批新段是 :9965 注入的占位 {"status":"pending"} → 不加不改 (规则④).
                    # 时点与陈旧风险: _prev 是 run() 开头的**生成前**内存快照 — 生成期间
                    # 用户外部写盘的 approve/void 不反映进来, 且 _run_one 独立 load/save 的
                    # 新值也不回填 (同下方 `_lsr` seed_override 陈旧教训, 故其有覆写机制)。
                    # 本处只用它判"是否重跑段" (status 存在性, 单调不回退), **不读其 review
                    # 值**, 故陈旧不改变判据; 落盘合流由 _save_manifest 脏 sid 语义兜底
                    # (脏 sid 不吃磁盘终态 → 旧 void 不复活)。
                    _prev_status = _prev.get("status")
                    _tf = self._timing_fields()
                    manifest[sid] = {"status": "success", "files": files, "prompt_id": self._last_pid,
                                     "seed": self._last_seed, "run_dir": self.run_dir,
                                     **_tf, "final_prompt": self._last_final_prompt}
                    self._manifest_mark_dirty(sid)
                    if _prev_status in ("success", "failed"):
                        manifest[sid]["review"] = "pending"
                    if _prev.get("seed_override") is not None:
                        manifest[sid]["seed_override"] = _prev["seed_override"]
                    # V1.10 批2 T2: void 重跑 — _run_one 在独立 load/save 时把新 seed_override
                    # 落盘, 但主循环内存 manifest dict 是 run() 开头加载的旧值 (_prev),
                    # 再次 void 重跑时 _prev 含旧 seed_override 会覆盖 _run_one 的新值.
                    # 修复: _last_seed_override (本段 _run_one 算出的新值) 优先级**高于** _prev.
                    _lsr = getattr(self, "_last_seed_override", None)
                    if _lsr is not None:
                        manifest[sid]["seed_override"] = _lsr
                    self._last_seed_override = None  # 单次消费
                    # V1.9 批 3 T3.3: S1 降级链留痕 (manifest 段键, success 段也记)
                    manifest[sid].update(self._continuation_manifest_fields())
                    # 1.13h T4/T5: 段级覆盖留痕并入替换字典之后 (整字典替换会丢键 — 同源注记)
                    manifest[sid].update(self._seg_manifest_fields())
                    print("[H3Batch] %s 完成: %s" % (sid, files), flush=True)
                    # 批 W1 R-62 (老板定版 2026-10-11「s1渲染后 s2渲染 搬运-s2抽帧-1」):
                    # collect (含 D8 防抖) + 尾帧抽帧 + tail_frame/文件记账挪后台流水线
                    # 作业 — 主循环渲完立即提交下段 (P-1)。prev_frame 传延迟引用, 降级
                    # 路径由 apply_shot_concat 让位判定处按需阻塞取 (P-2, 禁盲异步)。
                    # 门控沿旧 `_any_seg_concat()` 批级判据 (1.11b 波2 T3 修复语义不变):
                    # 拼接恒 True; 自定义任一勾选 True → 全部段抽帧记账 (含未勾选段);
                    # 自定义全不勾/分镜 False → 不抽帧 (验收 6①, 省一次抽帧)。
                    self._pipe_submit(sid, files, item=getattr(self, "_last_output_item", None),
                                      timing=_tf, want_tail=self._any_seg_concat())
                    if self._any_seg_concat() and files:
                        prev_frame = self._pipe_defer(sid)
                self._save_manifest(manifest)
                done += 1
                # V1.10 批2 T2: 成功完成段计数 (审片门窗口用) — 与 done 同步, 但排除失败/跳过.
                # 写在 save 之后: 检查点判定时 manifest 已含本段 dict.
                if ok:
                    success_count += 1
            else:
                # V1.10 批2 T2 FIX (真机 bug h3_batch_20260831_112048 shot_005 无 review):
                # for 自然跑完 (非 break 退出) → 末段门补判定. 之前检查点只在 for 开头
                # 触发, 末段完成进入下一轮 while 时 _gate_origin 已被醒来 reset, 窗口差=0
                # 不触发, 直接拼接收尾. 现在 for-else 在末段位置补一次与循环内完全相同
                # 语义的检查点: 写末段 review=pending + 暂停 + 醒来后 _rescan=True 重扫.
                # 防死循环 (规格要求 #4): 放行后重扫 → 全段 skip_done → success_count 不
                # 增长 → _gate_origin 已=success_count → 窗口差=0 → 末段门不再触发 → while
                # 退出 → 收尾. void 末段重跑后 success_count+1 → 窗口差=1 → 再次末段门
                # (重跑段待审, 语义正确). break 路径 (_stop / on_fail=阻断) 不进入 else,
                # 末段门不触发 (规格要求 #2).
                _last_triggered, manifest = self._gate_checkpoint(manifest, shots, success_count)
                if _last_triggered:
                    _rescan = True
                    # _stop 命中场景: 醒来后下一次 while 顶部 _stop.is_set() 立即 break
                    # 走既有 stopped 语义, 末段门不再二次触发 — 保持 _rescan=True 不影响
                    # 退出路径 (while 顶部 _rescan=False 然后 for-else 不再触发因为 break).
                    print("[H3Batch] 末段审片门, 触发重扫 (从头遍历)", flush=True)
        # while _rescan 结束 — 内层自然跑完 (rescan=False) 或 _stop 命中 (既有 stopped 语义)
        # V1.11 真异步化 (T1): 收尾 (拼接/归档/清点) 挪后台 daemon 线程,
        # run() 立即返回 → _clear_active 释放 active 锁 → 新批 (不同目录) 立即可受理。
        # 阶段值/失败文案/成功文案/raise RuntimeError("全部 %d 段失败, 无产物") 留痕于既有契约。
        # 批 W1 R-62 (P-3/P-4): 全收尾路径 (完成/停止/失败) 先 join 流水线作业 (带超时,
        # 最坏不挂死收尾) + 终收割, 再落终版 manifest 与拼接门 — 产物搬完才核对
        # (T3 gate 语义零改动, join 必须排在 _eval_concat_gate 之前)。
        self._pipe_join()
        self._pipe_drain(manifest)
        self._last_done_count = done
        # 批 W1 R-62/R-61 (老板定版 2026-10-11): 拼接时机门 + 接力产物核对 —
        # run() 返回前同步完成 (毫秒级 dict 状态扫描 + 文件在位检查), 缺段信息随终态
        # 一次到位; 拼接本体仍在 _finalize_body 后台线程 (线程域 T4 不动)。
        # 拼接件重建排在门判定**之后**: 门只做纯在位核对 (不因重建查找改判);
        # 新段产物在门前的在位性由流水线作业的 vpath 查找保证。
        self._last_concat_gate = self._eval_concat_gate(manifest, shots)
        self._last_concat_parts = self._pipe_build_concat_parts(manifest, shots)
        # 批 W1 R-62 收尾小笔: gate 结果同步写 _concat — 消 run() 返回 (GUI 终态
        # 首拍读盘) 与 _finalize_body 后台写 _concat 之间的毫秒级信息缺位窗口。
        # 形态与 _finalize_body gate-fail 分支逐字一致 (后台同值幂等覆盖); 落盘
        # 由下一行既有终版 save 承担, 不新增落盘时点。
        if not self._last_concat_gate.get("ok"):
            manifest["_concat"] = {"status": "skipped",
                                   "reason": self._last_concat_gate.get("reason") or "concat_gate_blocked",
                                   "missing": self._last_concat_gate.get("missing") or []}
        self._save_manifest(manifest)
        self._pipe_shutdown()
        # 启后台收尾线程; run() 立即返回 (不等收尾完成)
        self._finalize_async(manifest)
        # 既契约锚点 (阶段字串/失败文案/全败 raise, 实际执行已挪至 _finalize_body, 字串保留供源码断言):
        # self.phase = "拼接中"; self.phase = "归档中"; self.phase = "清点中"; self.phase = ""
        # 拼接失败，任务未完整完成 醒目头行 (manifest._concat.status == "failed" 触发)
        # 拼接失败原因 摘要头
        # 任务完成，视频保存在 ([H3Batch] 任务完成，视频保存在: %s)
        # 全部 %d 段失败, 无产物 (raise RuntimeError)

    def _finalize_async(self, manifest):
        """V1.11 真异步化 (T1): run() 生成完即返回, 拼接/归档/清点由 daemon 线程执行;
        _finalizing 注册窗口=整个收尾期 (status phase 透传 + 同目录守卫由此生效);
        active 锁随 run() 返回释放 → GPU 空后下一批 (不同 output_dir) 立即可受理。

        契约: 返回 Thread (供调用方 join 等待); 异常不向上传播, 由 _finalize_thread_body
        内 try/except 打印 traceback (start 失败除外 — 注册回滚后向上 raise)。
        """
        out_key = os.path.normcase(os.path.abspath(self.output_dir))
        self._finalize_error = None  # 批 B: 重置上一轮残留 (join_finalize 重抛后防误抛)
        with _finalize_lock:
            _finalizing[out_key] = "收尾中"
            t = threading.Thread(target=self._finalize_thread_body,
                                 args=(manifest, out_key), daemon=True)
            _finalize_threads[out_key] = t
            try:
                t.start()
            except Exception:
                # start 失败回滚注册 (防永久卡同目录守卫)
                _finalizing.pop(out_key, None)
                _finalize_threads.pop(out_key, None)
                raise
        self._finalize_thread = t
        return t

    def _finalize_thread_body(self, manifest, out_key):
        # 线程体: 调实际收尾 body, 异常吞掉打 traceback (收尾失败不阻塞 run() 返);
        # finally 内持锁清注册 (所有权判断防误删后继注册) + 清 phase.
        # 批 B: 异常暂存 _finalize_error 供 join_finalize 重抛 (测试直调路径保真
        # 全败 raise 契约; 生产 submit 路径不调 join_finalize, 零影响).
        try:
            self._finalize_body(manifest)
        except Exception as e:
            self._finalize_error = e
            print("[H3Batch] 后台收尾异常:\n%s" % traceback.format_exc(), flush=True)
        finally:
            with _finalize_lock:
                if _finalize_threads.get(out_key) is threading.current_thread():
                    _finalize_threads.pop(out_key, None)
                    _finalizing.pop(out_key, None)
            try:
                self.phase = ""
            except Exception:
                pass

    def _touch_finalizing(self, phase):
        """收尾期 granular phase 透传: 仅更新已注册键 (注册权在 _finalize_async)。
        供 _finalize_body 在拼接中/归档中/清点中三处调用, status 端点据此细化前端提示。
        """
        try:
            key = os.path.normcase(os.path.abspath(self.output_dir))
            with _finalize_lock:
                if key in _finalizing:
                    _finalizing[key] = phase
        except Exception:
            pass

    def join_finalize(self, timeout=120):
        """等当前引擎收尾线程结束 (生产不用, 测试/适配用)。

        批 B: join 完成后重抛收尾线程暂存的异常 (消费后清空, 二次调用不再抛)。
        join_all_finalize 保持纯 join 不重抛 (conftest teardown 收口用)。
        """
        t = getattr(self, "_finalize_thread", None)
        if t is not None and t.is_alive():
            t.join(timeout)
        err = getattr(self, "_finalize_error", None)
        if err is not None:
            self._finalize_error = None
            raise err

    def _eval_concat_gate(self, manifest, shots=None):
        """批 W1 R-62 拼接时机门 + R-61 接力核对 (老板定版 2026-10-11)。

        收尾拼接条件判定: run() 返回前同步调用 (毫秒级 dict 状态扫描 + 文件在位检查,
        不违反「不等拼接」— 核对≠拼接), 结果随终态一次到位; 拼接本体仍在
        _finalize_body 后台线程。返回 {"ok", "reason", "missing", "relay_parts"}。

        判定顺序 (2026-10-11 修正笔·真机代测缺口: 接力批裸 pending 误判
        failed_segments → relay 核对分支永不可达, 真机证据 测试W1补R62_163121):
        ①stopped 段 → 不拼 (reason=stopped);
        ②failed/blocked/missing_file 段 → 不拼 (reason=failed_segments);
        ③pending 段 — 非接力批 (start_from<=0) 收尾不应有 pending, 仍算
          failed_segments (保守); 接力批 (start_from>0) = 本批未跑复用旧产物
          (真机形态: GUI「继续」重新落 CSV → manifest stem 跟 CSV 名走 →
          _load_manifest 找不到旧账本 → 旧段裸 pending 无记录), 不触发
          failed_segments → 交给全段产物在位核对: 记录在案段走 files×run_dir
          多基序 (_video_path_old), 裸段走 _folder_matches 文件系统兜底
          (rerun 先例同款: sid 单前缀+边界·排除 _old_NN, 防跨段误匹配);
          齐=拼 (relay_parts 含旧段), 不齐=relay_missing+missing 清单。
        shots 缺省时从 manifest 键取 (直调 _finalize_body 的测试路径兜底·
        不重解析 CSV)。
        """
        if shots is None:
            # 兜底 (直调 _finalize_body 的测试路径): 从 manifest 键取段清单 —
            # 不重解析 CSV (桩测 CSV 可能无分镜表头行); 真实链路恒经 run() 传入
            # shots (分镜行序), manifest 键序仅影响兜底路径 relay_parts 排序。
            shots = [{"ID": k} for k in manifest
                     if k not in _RESERVED_KEYS and isinstance(manifest.get(k), dict)]
        _start = getattr(self, "start_from", 0)
        stopped, failed, pending = [], [], []
        for i, row in enumerate(shots):
            sid = row.get("ID") or ("shot_%03d" % (i + 1))
            info = manifest.get(sid)
            st = info.get("status") if isinstance(info, dict) else None
            if st == "success":
                continue
            if st == "stopped":
                stopped.append(sid)
            elif st == "pending":
                pending.append(sid)
            else:
                failed.append(sid)
        if stopped:
            return {"ok": False, "reason": "stopped",
                    "missing": stopped + failed + pending, "relay_parts": None}
        if failed or (pending and _start <= 0):
            return {"ok": False, "reason": "failed_segments",
                    "missing": failed + pending, "relay_parts": None}
        if _start > 0:
            relay_parts = []
            missing = []
            for i, row in enumerate(shots):
                sid = row.get("ID") or ("shot_%03d" % (i + 1))
                info = manifest.get(sid) or {}
                vpath = self._video_path_old(info.get("files") or [], info.get("run_dir"))
                if vpath:
                    relay_parts.append(vpath)
                    continue
                # 兜底: 裸 pending 段 (真机形态·账本无记录) 按 sid 前缀在产物目录
                # 找现行件 — _folder_matches rerun 先例同款 (边界 _/. ·排除 _old_NN,
                # 防跨段误匹配); 记录在案段优先走上面 files×run_dir 多基序。
                folder = info.get("run_dir") or self.run_dir
                seg_files = self._folder_matches(folder, sid)
                if seg_files:
                    relay_parts.extend(os.path.join(folder, fn) for fn in seg_files)
                else:
                    missing.append(sid)
            if missing:
                return {"ok": False, "reason": "relay_missing",
                        "missing": missing, "relay_parts": None}
            return {"ok": True, "reason": "", "missing": [], "relay_parts": relay_parts}
        return {"ok": True, "reason": "", "missing": [], "relay_parts": None}

    def _finalize_body(self, manifest):
        """run() 主循环后的拼接/归档/清点收尾体 (由 _finalize_async 持锁调用).

        保留全部 phase 赋值 (拼接中/归档中/清点中) + 醒目失败文案 + 全败 raise, 与既有 V1.7 R13
        / V1.9 批 2 等阶段契约一字不动 (仅换宿主: run() → _finalize_body)。
        """
        concat_parts = getattr(self, "_last_concat_parts", []) or []
        done = getattr(self, "_last_done_count", 0)
        if self.mode == "拼接" and concat_parts:
            if not getattr(self, "_auto_concat", True):
                # V1.11 批 1 T6: CSV 自动拼接=不拼 → 跳过收尾拼接; manifest 写独立
                # reason 区分 T3 P0 (B 缺陷) 短路 skipped reason="无现行段产物".
                print("[H3Batch] 拼接开关=不拼, 跳过自动重拼（可用历史任务手动拼接）", flush=True)
                manifest["_concat"] = {"status": "skipped", "reason": "auto_concat_off"}
                self._write_color_manifest(manifest)
                self._write_review_manifest(manifest)
                self._save_manifest(manifest)
            else:
                # 批 W1 R-62 拼接时机门 (老板定版 2026-10-11): 全部段 success (含接力
                # 核对通过) 才拼; 停止/有失败段/接力核对不齐 → 不拼, skipped + 缺段清单
                # 落 manifest._concat (落盘三件套与 auto_concat_off 同款)。
                gate = getattr(self, "_last_concat_gate", None)
                if gate is None:  # 兜底: 直调 _finalize_body 的测试路径无 run() 预计算
                    gate = self._eval_concat_gate(manifest)
                if not gate.get("ok"):
                    _gmissing = gate.get("missing") or []
                    manifest["_concat"] = {"status": "skipped",
                                           "reason": gate.get("reason") or "concat_gate_blocked",
                                           "missing": _gmissing}
                    self._write_color_manifest(manifest)
                    self._write_review_manifest(manifest)
                    self._save_manifest(manifest)
                    print("[H3Batch] 不拼接(%s): 批未全段成功或接力核对不齐, 缺段: %s"
                          % (gate.get("reason"), ",".join(_gmissing) or "无"), flush=True)
                else:
                    if getattr(self, "start_from", 0) > 0 and gate.get("relay_parts"):
                        # R-61: 接力批改用 manifest 全段清单产物 (含旧段) — 主循环
                        # start_from 跳过旧段不收 concat_parts, 漏段在此补齐。
                        concat_parts = gate["relay_parts"]
                    # 1.14b U3: 自动接力 — 拼接分支前, 勾选任一 → 调 postfx_engine.run_postfx_batch
                    # Y1: 记账 _postfx 相对路径锚 run_dir; Y2: 分级回退 (interp 失败→x2; upscale 失败→原件)
                    # Y3: 实际选中层级 == interp → crossfade_frames×2 (见下)
                    _pf = {}
                    if getattr(self, "_postfx_upscale", False) or getattr(self, "_postfx_interp", False):
                        print("[H3Batch] 后处理自动接力: 放大=%s 插帧=%s 引擎=%s" % (
                            getattr(self, "_postfx_upscale", False),
                            getattr(self, "_postfx_interp", False),
                            getattr(self, "_postfx_engine_choice", "seedvr2")), flush=True)
                        manifest = self._run_postfx_pipeline(manifest, concat_parts)
                        # Y2 回退后 parts 已替换; _concat_videos 用 manifest 内的最终 parts
                        _pf = manifest.get("_postfx") or {}
                        # #26 T1 读侧防御: final_parts 长度 ≠ concat_parts (部分段调用
                        # 时代写侧曾留单段列表脏数据) → 弃用回落原件清单。
                        if isinstance(_pf.get("final_parts"), list) \
                                and len(_pf["final_parts"]) == len(concat_parts):
                            concat_parts = _pf["final_parts"]
                    # V1.7 R13: 拼接前暴露阶段, 让 status 端点透传到前端 (用户能看到"拼接中"而非黑箱)
                    self.phase = "拼接中"
                    self._touch_finalizing("拼接中")
                    out = os.path.join(self.run_dir, "concat_%s.mp4" % _concat_stamp())
                    # Y3: 实际选中层级 == interp → crossfade_frames×2 (从 cfg 读基值;
                    # U6R E4.3: 判据改"实际选中层级", 原 interp 勾选标志已不适用)
                    _cf_frames = None
                    if _pf.get("level") == "interp":
                        _cf_frames = self._postfx_crossfade_frames(doubled=True)
                    elif _pf.get("level") == "upscale":
                        _cf_frames = self._postfx_crossfade_frames(doubled=False)
                    if _cf_frames is not None:
                        ok, concat_err = self._concat_videos(concat_parts, out, crossfade_frames=_cf_frames)
                    else:
                        ok, concat_err = self._concat_videos(concat_parts, out)
                    # 批 W1 R-62: 拼接已过时机门 (全段 success), 旧 failed/blocked missing
                    # 扫描恒空已摘除 — 缺段清单唯一来源=拼接门 (gate-fail 分支 _concat.missing)。
                    print("[H3Batch] 拼接完成: %s (%s)" % (out, "OK" if ok else "失败"), flush=True)
                    # V1.11 批 4 T2: size_mismatch 前缀 → status=skipped (账本留痕, 避免 0 字节空片).
                    # 与 _rebuild_concat / rerun_shot_in_folder / _rerun_finalize 三处收尾点同语义;
                    # 手动拼接端点 (:7673) 与 __init__.py:1950 不改 (保持 failed 语义, 对用户报错合理).
                    concat_info = _classify_concat_result(ok, concat_err, out)
                    manifest["_concat"] = concat_info
                    self._write_color_manifest(manifest)   # T3.5: S2 色彩对齐批级留痕
                    self._write_review_manifest(manifest)  # T3.7: S5 审片报告补列留痕
                    self._save_manifest(manifest)
        # V1.7 R13: 归档前暴露阶段, 收尾透明化 (包括非拼接模式也走归档)
        self.phase = "归档中"
        self._touch_finalizing("归档中")
        try:
            # V1.9 批 3 T3.2: S1 intermediates (AV latent) 随批清理 — 必须在归档搬运前,
            # 否则 run_dir 整体 move 会把中间 latent 带进 archive
            self._cleanup_continuation()
            dest = self._archive_run(manifest)
            # V1.7 R13: 缺产物清点前暴露阶段, 与归档区分 (前者"挪产物"、后者"核产物在不在")
            self.phase = "清点中"
            self._touch_finalizing("清点中")
            # T5 F7: 缺产物清点 — 归档后对 status=success 段核验产物文件存在; 不存在改 missing_file
            # (保留原 files 记录便于排查); 拼接批失败段 (failed/blocked) 不参与清点。
            # 与 _concat.missing (拼接缺段 ID 列表) 语义不同, 键名不撞。
            # rerun_shot_in_folder 单段重跑路径不做清点 (S7 已知边界, 见该方法注释)。
            self._sweep_missing_files(manifest, dest)
            # V1.9 批 2: 收尾写注入/覆写最终报告 (含类型拦截/错配警告 — manifest 可查实际所用)
            manifest["_inject"] = self._manifest_report_inject_direct()
            manifest["_override"] = self._manifest_report_override_direct()
            self._write_adapter_report_manifest(manifest)   # 1.14 P6: AdapterPlan 报告落 manifest
            self._save_manifest(manifest)
            print("[H3Batch] 批量结束: %d 条处理完" % done, flush=True)
            s = summarize_manifest(self.manifest_path)
            if s:
                print("[H3Batch] 汇总: %d 成功, %d 失败" % (s["done"], s["failed"]), flush=True)
                # 全军覆没必须炸出来: 静默"空结果"用户看不到任何原因(manifest 里有但没人翻)
                if s["done"] == 0 and s["failed"]:
                    err = next((v.get("error") for k, v in manifest.items()
                                if k not in _RESERVED_KEYS
                                and v.get("status") == "failed" and v.get("error")), "")
                    raise RuntimeError("全部 %d 段失败, 无产物%s" % (s["failed"], (": " + err) if err else ""))
            # 用户可读: 一眼告诉"我的视频在哪"; 全败时此处不达(已被上面 raise 拦截)
            # 拼接失败时 (manifest._concat.status == "failed") 不能再静默报"任务完成":
            # 拼接产物实际不存在, 用户误以为全部成功. 改用醒目失败文案告知, 段产物仍保留
            # 在归档目录供排查.
            _concat_failed = (manifest.get("_concat") or {}).get("status") == "failed"
            if _concat_failed:
                _concat_err = (manifest.get("_concat") or {}).get("error", "") or "(无错误详情)"
                # 摘要截断 200 字 (控制台/前端可视范围足够, 比 120 略宽以保留 stderr 关键行)
                if len(_concat_err) > 200:
                    _concat_err = _concat_err[:200] + "..."
                print("[H3Batch] *** 拼接失败，任务未完整完成 *** 段产物已保留在: %s" % (dest or self.run_dir), flush=True)
                print("[H3Batch] *** 拼接失败原因: %s" % _concat_err, flush=True)
            else:
                print("[H3Batch] 任务完成，视频保存在: %s" % (dest or self.run_dir), flush=True)
        finally:
            # V1.7 R13: 异常路径也必须清 phase, 否则前端 status 永远卡在"归档中/清点中"。
            # start() 守卫拿到的 phase 就是"上一次没清"的脏值, 用户更困惑。
            self.phase = ""

    def _video_path(self, files):
        # V1.11 批 5 P0: 双基兼容 — 产物可能在本实例 run_dir, 也可能在
        # self.output_dir 或 DEFAULT_OUTPUT_DIR (folder_paths 根; 跨实例
        # /不同 ComfyUI 实例渲染错位场景, 批 4 4.7 实锤). 复用 _video_path_old
        # 同款 5 层基序 (run_dir → output_dir/video/shots → output_dir →
        # DEFAULT_OUTPUT_DIR/video/shots → DEFAULT_OUTPUT_DIR), 跑批拼接/单段
        # 重跑/skip-done 收集 concat_parts 都能命中错位产物. _video_path_old
        # 保留旧签名兼容既有调用方.
        return self._video_path_old(files or [], self.run_dir)

    def _sweep_missing_files(self, manifest, dest):
        """T5 F7: 跑批收尾清点产物文件。status=success 但 files[0] 不在任何已知位置
        → 改 status=missing_file (保留原 files 记录便于排查), save manifest。
        按优先级查: info["run_dir"] > dest (归档后) > self.run_dir
        > output_dir/video/shots/ (分镜模式 SaveVideo 落点) > output_dir
        > DEFAULT_OUTPUT_DIR/video/shots/ > DEFAULT_OUTPUT_DIR (V1.11 批 5 P0:
        双基兼容, 跨实例渲染错位场景产物落 ComfyUI folder_paths 根而非本实例
        output_dir, 必须仍能被清点识别 — 不然会误标 missing_file)。
        无 archive_dir 时也执行清点: 用户默认跑批 (不归档) 产物缺失会静默标 success,
        必须如实改 missing_file 供续跑识别。"""
        swept = []
        for sid, info in list(manifest.items()):
            if sid in _RESERVED_KEYS:
                continue
            if not isinstance(info, dict) or info.get("status") != "success":
                continue
            files = info.get("files") or []
            if not files:
                continue
            info_run_dir = info.get("run_dir")
            bases = [b for b in (info_run_dir, dest, self.run_dir,
                                 os.path.join(self.output_dir, "video", "shots"),
                                 self.output_dir,
                                 os.path.join(DEFAULT_OUTPUT_DIR, "video", "shots"),
                                 DEFAULT_OUTPUT_DIR) if b]
            found = False
            for base in bases:
                for fn in files:
                    if not fn.endswith(".mp4"):
                        continue
                    if os.path.exists(os.path.join(base, fn)):
                        found = True
                        break
                if found:
                    break
            if not found:
                manifest[sid]["status"] = "missing_file"
                swept.append(sid)
        if swept:
            self._save_manifest(manifest)
            print("[H3Batch] 缺产物清点: %d 段无产物文件, 标 missing_file: %s"
                  % (len(swept), ",".join(swept)), flush=True)

    def _video_path_old(self, files, run_dir):
        # 断点续跑时, 从旧运行的时间戳文件夹找文件
        # V1.11 批 5 P0: 默认根用模块级常量 DEFAULT_OUTPUT_DIR (与 _collect_output /
        # _sweep_missing_files 一致), 便于测试 monkeypatch 覆盖双基回退场景.
        for fn in files or []:
            if fn.endswith(".mp4"):
                for c in (os.path.join(run_dir, fn) if run_dir else None,
                          os.path.join(self.output_dir, "video", "shots", fn),
                          os.path.join(self.output_dir, fn),
                          os.path.join(DEFAULT_OUTPUT_DIR, "video", "shots", fn),
                          os.path.join(DEFAULT_OUTPUT_DIR, fn)):
                    if c and os.path.exists(c):
                        return c
        return None

    def _collect_output(self, files, sid):
        """把本段产物从服务器 output 目录移到本次运行的时间戳文件夹。
        V1.11 批 5 P0: 双基兼容 — 候选列表扩 DEFAULT_OUTPUT_DIR 系列
        (DEFAULT_OUTPUT_DIR/video/shots/ 与 DEFAULT_OUTPUT_DIR/). 跨实例渲染
        (本实例 output_dir 与 ComfyUI folder_paths 根=DEFAULT_OUTPUT_DIR 不一致)
        场景下, 产物落 DEFAULT_OUTPUT_DIR, 搬运仍能找到并 move 到本实例 run_dir.

        V1.13 D8: 未找到不计入 moved (旧实现恒 append, 调用方 if moved 恒真 →
        files 被替换为含幽灵列表). 仅 mp4 文件参与搬运 — 非 mp4 (.json sidecar 等)
        本就不在搬运范围, 不计入也不计入失败判据.

        V1.13j D26: 同名多候选取 mtime 最新. 旧实现按候选序 exists 命中即 break,
        零新鲜度校验 → run_dir 旧件先命中 → 新件滞留 output. 修复后: 所有存在的
        同名候选中取 mtime 最新 (同 mtime 维持原候选序首位, D8 优先级保持).
        stat 异常 (Windows 文件被锁/竞态) → 该候选按"无 mtime"处理退化原候选序,
        不得外溢触发重渲 (collect 位于 _run_one attempt try 内).
        """
        sub_by_fn = {}
        item = getattr(self, "_last_output_item", None)
        if item:
            for o in item.get("outputs", {}).values():
                for v in o.values():
                    if isinstance(v, list):
                        for f in v:
                            if isinstance(f, dict) and f.get("filename"):
                                sub_by_fn[f["filename"]] = f.get("subfolder", "")
        moved = []
        for fn in files or []:
            if not fn.endswith(".mp4"):
                continue  # 非 mp4 不搬运 (sidecar 等) — 不计入 moved 不计入失败判据
            sub = sub_by_fn.get(fn, "")
            src = None
            # V1.13 D8: 候选含 run_dir (产物已被先前 collect 搬到最终位置时不再搬, 只计入 moved;
            # 否则 rerun 收尾兜底 collect 在输出根找不到已搬文件, 误判全空降级 failed)
            # V1.13j D26: 同名多候选取 mtime 最新 (同 mtime 维持原候选序首位, 锁 D8 优先级)
            candidates = (os.path.join(self.run_dir, fn),
                          os.path.join(self.output_dir, sub, fn),
                          os.path.join(self.output_dir, "video", "shots", fn),
                          os.path.join(self.output_dir, fn),
                          os.path.join(DEFAULT_OUTPUT_DIR, "video", "shots", fn),
                          os.path.join(DEFAULT_OUTPUT_DIR, fn))
            existing = [c for c in candidates if os.path.exists(c)]
            if existing:
                # mtime 失败 (Windows 文件被锁/竞态) → 该候选按"无 mtime"处理
                # 退化原候选序比较; 不得外溢触发 _run_one 重渲
                def _mtime_or_none(p):
                    try:
                        return os.path.getmtime(p)
                    except OSError:
                        return None
                mtimes = [_mtime_or_none(c) for c in existing]
                best_idx = 0
                for i in range(1, len(existing)):
                    mi, mb = mtimes[i], mtimes[best_idx]
                    if mi is None:
                        continue  # 该候选无 mtime, 不参选
                    if mb is None or mi > mb:
                        best_idx = i
                src = existing[best_idx]
            if src:
                dst = os.path.join(self.run_dir, fn)
                if os.path.abspath(src) != os.path.abspath(dst):
                    shutil.move(src, dst)
                moved.append(fn)
            else:
                # V1.13 D8: 未找到不再 append; 改记日志由调用方走有界等待 retry 收口
                print("[H3Batch] %s 输出文件未找到(可能 ComfyUI worker 仍在写盘): %s"
                      % (sid, fn), flush=True)
        return moved

    def _collect_output_retry(self, files, sid, max_wait=5.0, interval=0.5):
        """V1.13 D8: 有界等待 + 二次 collect — 首 collect 全中则零等待,
        仍有 mp4 缺失则轮询间隔 interval (秒), 最长 max_wait 秒.
        ComfyUI worker 异步落盘竞态 (7729-7731 注释自证): 文件可能首 collect
        时还没写盘, 等待期内落盘 → 段 success; 等满 max_wait 仍缺 → 段失败
        (由调用方按 missing 列表判定).

        返回: 实际 moved 集 (含首 collect + 后续轮询找到的并集).
        """
        moved = self._collect_output(files, sid)
        expected_mp4 = [f for f in (files or []) if isinstance(f, str) and f.endswith(".mp4")]
        if not expected_mp4:
            return moved
        # 首 collect 全中 → 零等待
        missing = [f for f in expected_mp4 if f not in moved]
        if not missing:
            return moved
        # 有缺失 → 有界等待 + 再次 collect (移完的不再动, 只针对 missing 二次找)
        deadline = time.time() + max_wait
        while missing and time.time() < deadline:
            time.sleep(interval)
            retry = self._collect_output(missing, sid)
            moved = list(moved) + retry
            missing = [f for f in expected_mp4 if f not in moved]
        return moved

    # ---------------- 批 W1 R-62: 段间流水线 (老板定版 2026-10-11) ----------------
    # 口径「s1渲染后 s2渲染 搬运-s2抽帧-1」: 主循环渲完一段立即提交下段, 本段的
    # collect (含 D8 防抖) + 尾帧抽帧 + tail_frame/文件记账全部挪单 Worker 后台线程
    # (FIFO 保序) 并行于下段渲染。降级路径 (latent 续接不可用) 的尾帧消费方在
    # apply_shot_concat 让位判定处按需阻塞取 (P-2, 禁盲异步); 全收尾路径在拼接门
    # (_eval_concat_gate, T3 域) 与终版 manifest 落盘之前 join (P-3, 带超时 P-4)。

    def _pipe_reset(self):
        """R-62: run() 开头清上一轮流水线状态 — 同引擎续跑/复测多次 run() 时,
        结果/事件/收割标记按 run 重来 (防跨 run 陈旧结果污染: defer 误读旧尾帧 /
        drain 跳过本轮结果 / join 等旧事件), 队列重建 (旧挂死作业不拖累新 run)。"""
        self._pipe_queue = queue.Queue()
        self._pipe_results = {}
        self._pipe_events = {}
        self._pipe_drained = set()
        self._pipe_worker = None   # 旧 Worker (若有) 随旧队列隔离, 新 Worker 惰性重建

    def _pipe_ensure_worker(self):
        """惰性初始化流水线队列 + 单 Worker daemon 线程 (线程起不来 → 退化为同步执行)。
        同引擎多次 run() (续跑/复测): 上一 run 的 Worker 已被 sentinel 退出 — 死线程
        不得复用, 按 is_alive 重建 (否则作业无人消费, join 必超时)。"""
        if getattr(self, "_pipe_queue", None) is None:
            self._pipe_queue = queue.Queue()
            self._pipe_results = {}
            self._pipe_events = {}
            self._pipe_drained = set()
        w = getattr(self, "_pipe_worker", None)
        if w is not None and w.is_alive():
            return
        self._pipe_worker = None
        try:
            t = threading.Thread(target=self._pipe_worker_body, daemon=True,
                                 name="H3Batch-Pipe")
            t.start()
            self._pipe_worker = t
        except Exception as exc:
            print("[H3Batch] R-62 流水线线程启动失败, 退化为同步执行: %s" % exc, flush=True)
            self._pipe_worker = None

    def _pipe_submit(self, sid, files, item=None, timing=None, want_tail=True):
        """单段后台作业入队: collect (含防抖) + 尾帧抽帧 + 结果记账 (P-1/P-5)。
        item = 本段 history 条目快照 (_collect_output 子目录映射源, 防 _wait_shot
        下段覆盖); timing = 本段计时快照 (迟到改判落账用, 不读渲染中的 _shot_t0)。"""
        self._pipe_ensure_worker()
        job = {"sid": sid, "files": list(files or []), "item": item,
               "timing": dict(timing or {}), "want_tail": bool(want_tail),
               "event": threading.Event()}
        self._pipe_events[sid] = job["event"]
        if getattr(self, "_pipe_worker", None) is None:
            res = self._pipe_new_result()
            try:
                self._pipe_run_job(job, res)
            except Exception:
                res["worker_error"] = "sync fallback"
            self._pipe_results[sid] = res
            job["event"].set()
            return
        self._pipe_queue.put(job)

    @staticmethod
    def _pipe_new_result():
        return {"ok": True, "missing": [], "moved": None, "tail": None,
                "has_video": False, "worker_error": ""}

    def _pipe_worker_body(self):
        while True:
            job = self._pipe_queue.get()
            if job is None:
                break
            res = self._pipe_new_result()
            try:
                self._pipe_run_job(job, res)
            except Exception as exc:
                res["worker_error"] = "%s: %s" % (type(exc).__name__, exc)
                print("[H3Batch] R-62 流水线作业异常 %s: %s\n%s"
                      % (job.get("sid"), res["worker_error"], traceback.format_exc()),
                      flush=True)
            finally:
                self._pipe_results[job["sid"]] = res
                job["event"].set()
                self._pipe_queue.task_done()

    def _pipe_run_job(self, job, res):
        sid, files, item = job["sid"], job["files"], job["item"]
        # _collect_output 子目录映射读 _last_output_item — 短暂换入本段快照;
        # 恢复条件: 期间未被主循环写入新值 (新值=下段 history, 保留之)。
        old_item = getattr(self, "_last_output_item", None)
        self._last_output_item = item
        try:
            moved = self._collect_output(files, sid)
            expected = [f for f in (files or [])
                        if isinstance(f, str) and f.endswith(".mp4")]
            missing = [f for f in expected if f not in moved]
            # D8 防抖等待与缺失改判只对「有 history 条目背书」的产物声明生效 —
            # 生产链路 _wait_shot success 前必写 _last_output_item (恒有背书, 语义零变);
            # 无条目 (桩 _run_one 直返等) = 无服务端产物声明, 不等待不改判不覆盖 files。
            if missing and item is not None:
                if all(self._video_path([f]) for f in missing):
                    # 产物在任一已知基位 (collect 子目录候选之外) — 不等待不重搬
                    moved = list(moved) + missing
                    missing = []
                else:
                    # D8 防抖量级等待只在真缺件时发生 (后台, 不阻塞下段提交)
                    moved = self._collect_output_retry(missing, sid)
                    missing = [f for f in expected if f not in moved]
            res["ok"] = not (missing and item is not None)
            res["missing"] = missing
            res["moved"] = list(moved) if not missing else None
            if job.get("want_tail"):
                vpath = self._video_path(moved or files)
                res["has_video"] = vpath is not None
                if vpath:
                    res["tail"] = self._extract_last_frame(vpath)
        finally:
            if getattr(self, "_last_output_item", None) is item:
                self._last_output_item = old_item

    def _pipe_defer(self, sid):
        """尾帧延迟引用: 主循环传给下段的 prev_frame 占位 (P-1 轻路径不取值)。"""
        return _PipeTailRef(sid)

    def _pipe_resolve_prev(self, ref):
        """R-62 P-2 降级路径按需阻塞取尾帧: 等待该段后台作业 (collect+抽帧) 完成并
        返回尾帧相对名。超时/缺席 → None + 响亮日志 (禁盲异步: 锚丢失必须留痕)。"""
        sid = getattr(ref, "sid", None)
        ev = (getattr(self, "_pipe_events", None) or {}).get(sid)
        if ev is None:
            print("[H3Batch] R-62 尾帧作业缺席 (%s), 降级段无锚续跑" % sid, flush=True)
            return None
        timeout = getattr(self, "_pipe_join_timeout", 150.0)
        if not ev.wait(timeout):
            print("[H3Batch] R-62 尾帧等待超时 (%ss): %s — 降级段无锚续跑"
                  % (timeout, sid), flush=True)
            return None
        return (getattr(self, "_pipe_results", {}) or {}).get(sid, {}).get("tail")

    def _pipe_join(self, timeout_per_job=None):
        """R-62 P-3/P-4: 等待全部在途流水线作业完成 (单 Worker FIFO 依序 join)。
        总预算 = 每作业超时 × 在途数 (默认 150s ≥ 尾帧 ffmpeg 120s 超时兜底量级);
        超时如实记日志并返回 False, 收尾继续不挂死。"""
        events = getattr(self, "_pipe_events", None) or {}
        pending = [(sid, ev) for sid, ev in events.items() if not ev.is_set()]
        if not pending:
            return True
        per = float(timeout_per_job) if timeout_per_job else getattr(
            self, "_pipe_join_timeout", 150.0)
        deadline = time.time() + per * len(pending)
        for sid, ev in pending:
            remaining = deadline - time.time()
            if remaining <= 0 or not ev.wait(remaining):
                stuck = [s for s, e2 in pending if not e2.is_set()]
                print("[H3Batch] R-62 流水线 join 超时 (%.1fs/作业), 未完成段: %s "
                      "(收尾继续, 不挂死)" % (per, ",".join(stuck)), flush=True)
                return False
        return True

    def _pipe_shutdown(self):
        q = getattr(self, "_pipe_queue", None)
        if q is not None:
            try:
                q.put_nowait(None)   # Worker 排空作业后退出 (daemon 兜底)
            except Exception:
                pass
        # Worker 引用置空 — 下次 run() 由 _pipe_ensure_worker 按 is_alive 重建
        # (死线程引用不复用, 防「作业无人消费」挂死)
        self._pipe_worker = None

    def _pipe_drain(self, manifest):
        """R-62: 收割已完成作业结果进主循环 manifest (主线程单点写, 无锁竞争)。
        成功 → files=moved + tail_frame 记账 (P-5, 消费方: 审片重扫 prev_frame 重建
        + rerun 首锚 _rerun_anchors); D8 防抖耗尽 → 迟到改判 missing_file, 返回
        (sid, err) 供主循环按既有失败分支语义收敛 (阻断/继续)。worker 异常只留痕
        不改判 (代码故障≠产物缺失, 收尾清点 _sweep_missing_files 兜底)。"""
        results = getattr(self, "_pipe_results", None) or {}
        drained = getattr(self, "_pipe_drained", None)
        if drained is None:
            drained = self._pipe_drained = set()
        late = None
        for sid, res in list(results.items()):
            if sid in drained:
                continue
            drained.add(sid)
            if res.get("worker_error"):
                continue
            info = manifest.get(sid)
            if not isinstance(info, dict):
                continue
            if res.get("ok"):
                if res.get("moved") is not None and res["moved"] != info.get("files"):
                    info["files"] = res["moved"]
                if res.get("has_video"):
                    info["tail_frame"] = res.get("tail")
            elif late is None:
                err = "missing_file: %s" % ",".join(res.get("missing") or [])
                manifest[sid] = {"status": "missing_file", "error": err,
                                 **(res.get("timing") or {})}
                self._manifest_mark_dirty(sid)
                late = (sid, err)
        return late

    def _pipe_build_concat_parts(self, manifest, shots):
        """R-62: 收尾拼接件重建 (保分镜行序) — collect 挪后台后主循环不再边跑边收,
        join 后按 manifest×shots 一次重建。门控与旧逐段 append 语义等价:
        _any_seg_concat() 下逐段查找 (自定义也查 — 与旧 skip/成功分支同口径),
        仅拼接模式入 parts (自定义沿用收尾不自动拼大片裁决 A)。查找统一走
        _video_path_old (旧 skip 分支同款跨目录候选, run_dir 缺省回退本批)。"""
        if not self._any_seg_concat():
            return []
        parts = []
        for i, row in enumerate(shots):
            sid = row.get("ID") or ("shot_%03d" % (i + 1))
            info = manifest.get(sid)
            if not isinstance(info, dict) or info.get("status") != "success":
                continue
            files = info.get("files") or []
            if not files:
                continue
            vpath = self._video_path_old(files, info.get("run_dir"))
            if vpath and self.mode == "拼接":
                parts.append(vpath)
        return parts


# 批 W1 R-62: 尾帧延迟引用 (主循环 prev_frame 占位, 降级路径由
# apply_shot_concat 让位判定处按需 resolve — P-2 禁盲异步)。
class _PipeTailRef(object):
    __slots__ = ("sid",)

    def __init__(self, sid):
        self.sid = sid


# 批 W1 R-62: 自动拼接产物命名 — 秒级 + _%03d 毫秒尾 (抄 __init__.py 手动拼接端点
# 先例, 同款格式)。秒级命名 + ffmpeg -y 同秒重拼会静默覆盖, 毫秒尾保证同秒互不相同。
def _concat_stamp():
    return time.strftime("%Y%m%d_%H%M%S") + ("_%03d" % (int(time.time() * 1000) % 1000))


# V1.11 批 4 T2: _concat_videos 三处收尾点的统一结果分类 + 空产物清理.
def _classify_concat_result(ok, err, out_path):
    """size_mismatch 前缀 → status=skipped (避免拼出 0 字节空片, 账本留痕 +
    sizes 解析, 后续可手动处理); 其余失败 → status=failed + error 落账;
    成功 → status=success. Returns: dict, 供 manifest._concat 直接 update
    (调用方按需补 missing/file)."""
    if ok:
        return {"status": "success", "file": out_path}
    if isinstance(err, str) and err.startswith("size_mismatch:"):
        sizes = {}
        body = err[len("size_mismatch:"):].strip()
        for chunk in body.split(","):
            chunk = chunk.strip()
            if not chunk or ":" not in chunk:
                continue
            sid, _, sz = chunk.partition(":")
            sizes[sid.strip()] = sz.strip()
        return {"status": "skipped", "reason": "size_mismatch", "sizes": sizes}
    info = {"status": "failed"}
    if err:
        info["error"] = err
    return info


def _cleanup_empty_output(out_mp4):
    """空产物统一清理 (exists 且 size==0 时删; 非空保留供排查)."""
    try:
        if out_mp4 and os.path.exists(out_mp4) and os.path.getsize(out_mp4) == 0:
            os.remove(out_mp4)
    except OSError:
        pass


# V1.11 批 1 T5: 手动拼接组合映射纯函数.
def compute_concat_map(manifest, rerun_seq, mode):
    """按 mode/global/inherit 计算拼接映射 + 缺件/回退段标注.

    入参:
      manifest: dict (V1.11 T1 schema); 非 dict → 视作 {}
      rerun_seq: int | None (global 缺省 None; inherit 必传 seq)
      mode: "global" | "inherit"

    返回 dict:
      map: {sid: 文件名} (basename, 不含路径; 归档 repath 后仍有效)
      fallback_sids: list[str] (回退基准的段 ID)
      fell_back: bool (inherit 无历史 → 等同 global + fell_back=True)
      base_desc: str (基准来源 + 时间描述)
      missing: list[str] (映射中文件实际不存在的段 ID)

    段序 = manifest 段键数字序 (与 CSV 解析序等价 — run() 主循环同款口径).
    文件存在性按段 run_dir 拼绝对路径核.
    """
    if mode not in ("global", "inherit"):
        raise ValueError("mode 必须为 'global' 或 'inherit', 实 %r" % mode)
    if not isinstance(manifest, dict):
        manifest = {}

    # 段键 (排除 _RESERVED_KEYS); 数字序
    sids_all = [k for k in manifest.keys() if k not in _RESERVED_KEYS]
    sids_sorted = H3BatchEngine._sort_numeric_sids(sids_all)

    # 1. 基准映射
    history = manifest.get("_concat_history")
    inherit_snapshot = None
    inherit_time = None
    fell_back = False
    if mode == "inherit":
        if isinstance(history, list) and history:
            latest = history[-1]
            if isinstance(latest, dict) and isinstance(latest.get("map"), dict):
                inherit_snapshot = latest["map"]
                inherit_time = latest.get("time")
        if inherit_snapshot is None:
            # 无历史 → 等同 global + fell_back=True
            fell_back = True
            mode = "global"

    base_map = {}
    # base_desc 构造: 前缀如实反映基准来源, 后缀反映替换集来源 (如有).
    # 原则: 二选一"原始任务" / "继承上次拼接" — fell_back 时等同原始任务,
    # 不得出现"继承"字样; rerun 拼接到后缀 (不覆盖前缀).
    base_prefix = ""
    if mode == "global":
        for sid in sids_sorted:
            seg = manifest.get(sid)
            if not isinstance(seg, dict):
                continue
            files = seg.get("files") or []
            if files:
                base_map[sid] = files[0]
        # V1.11 批 1 T5 缺陷 B (P1): fell_back 是 inherit 无历史的退化 — 基准仍是
        # 原始任务 (各段现行 files[0]), 不是"继承上次拼接". 措辞如实: "无拼接历史".
        base_prefix = "原始任务（无拼接历史）" if fell_back else "原始任务"
    else:
        # inherit: 历史快照 (已确认非空)
        for sid in sids_sorted:
            base_map[sid] = inherit_snapshot.get(sid)
        if inherit_time:
            try:
                base_prefix = "继承上次拼接(%s)" % time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(float(inherit_time)))
            except (TypeError, ValueError, OSError):
                base_prefix = "继承上次拼接"
        else:
            base_prefix = "继承上次拼接"
    base_desc = base_prefix

    # 2. 替换集 (rerun_seq 指向 _reruns[seq-1].files)
    fallback_sids = []
    # V1.11 交付前 BE-P2-1: failed 段 (base_map 不含) 若 rerun files_map 有产物
    # → 纳入 (用户点该重跑记录"拼接"的意图); 仍无产物 → 并入 missing 披露.
    rerun_missing = []  # declared 但无产物的 failed 段 (披露给上游)
    if rerun_seq is not None and isinstance(rerun_seq, int):
        reruns = manifest.get("_reruns")
        if not isinstance(reruns, list):
            raise ValueError("rerun_seq=%d 但 _reruns 不存在" % rerun_seq)
        idx = rerun_seq - 1
        if idx < 0 or idx >= len(reruns):
            raise ValueError("rerun_seq=%d 越界 (有效: 1..%d)" % (rerun_seq, len(reruns)))
        entry = reruns[idx]
        files_map = entry.get("files") if isinstance(entry, dict) else None
        if not isinstance(files_map, dict):
            files_map = {}
        for sid, fn in files_map.items():
            # BE-P2-1: 失败段但 rerun 有产物 → 用 rerun 产物 (旧实现 continue 静默少段)
            base_map[sid] = fn
        declared_sids = entry.get("sids") if isinstance(entry, dict) else None
        if isinstance(declared_sids, list):
            for sid in declared_sids:
                if sid in base_map and sid not in files_map:
                    fallback_sids.append(sid)
                elif sid not in base_map and sid not in files_map:
                    # declared 但无产物 → missing 披露
                    rerun_missing.append(sid)
        # 拼接而非覆盖: 前缀 (基准来源) + 重跑记录seq=N (替换集来源)
        base_desc = "%s + 重跑记录seq=%d" % (base_prefix, rerun_seq)

    # 3. inherit 基准缺段回补 (基准快照没某段但 manifest 有)
    if not fell_back and mode == "inherit":
        for sid in sids_sorted:
            if sid not in base_map or base_map[sid] is None:
                seg = manifest.get(sid)
                if isinstance(seg, dict):
                    files = seg.get("files") or []
                    if files:
                        base_map[sid] = files[0]
                        if sid not in fallback_sids:
                            fallback_sids.append(sid)

    # 4. 文件存在性核 (按段 run_dir)
    # V1.11 批 5 P0: 双基兼容 — run_dir 缺件时, 还查 output_dir 与 DEFAULT_OUTPUT_DIR
    # 的 video/shots/ 子层及裸目录. 跨实例渲染 (本实例 output_dir 与 ComfyUI
    # folder_paths 根=DEFAULT_OUTPUT_DIR 不一致) 场景下产物在 DEFAULT_OUTPUT_DIR,
    # 不应再判 missing.
    missing = list(rerun_missing)  # V1.11 交付前 BE-P2-1: 初始含 rerun 无产物的 failed 段
    # 静态常量: 默认产物根 (folder_paths.get_output_directory()); 双基找产物的回退层.
    _dflt_out_root = DEFAULT_OUTPUT_DIR
    for sid, fn in base_map.items():
        if not fn or not isinstance(fn, str):
            continue
        seg = manifest.get(sid) or {}
        run_dir = seg.get("run_dir") or ""
        if not fn:
            continue
        # 候选基序 (与 _video_path_old 同款): run_dir (段级) → output_dir +
        # video/shots → output_dir → DEFAULT_OUTPUT_DIR/video/shots →
        # DEFAULT_OUTPUT_DIR. 注意 compute_concat_map 是模块级函数 (无 self),
        # 此处不取 self.output_dir, 仅走段 run_dir + 模块级 DEFAULT_OUTPUT_DIR 双基.
        bases = []
        if run_dir:
            bases.append(run_dir)
        bases.append(os.path.join(_dflt_out_root, "video", "shots"))
        bases.append(_dflt_out_root)
        if not any(os.path.exists(os.path.join(b, fn)) for b in bases if b):
            missing.append(sid)

    return {
        "map": base_map,
        "fallback_sids": sorted(set(fallback_sids)),
        "fell_back": fell_back,
        "base_desc": base_desc,
        "missing": sorted(set(missing)),
    }
