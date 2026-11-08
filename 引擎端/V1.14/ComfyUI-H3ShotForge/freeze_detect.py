"""freeze_detect.py — V1.9 批 3 T3.6: S4 冻结尾检测 (尾帧直连降级路径兜底).

痛点: 生成段尾常带"静止复制帧"(模型冻结输出 — 尾部帧反复同一画面, 常伴退化
伪影)。旧 _extract_last_frame 取字面最后一帧 (-sseof -0.1) 会把复制帧喂给下一
段首帧锚定, 下一段开场跟着静止复制。本模块把尾帧提取改为冻结尾自动检测:
**视觉静止门 + 运动幅度门双门**判定, 冻结时取**冻结起点前最后一有效帧**
(静止段之前的干净动态帧); 未冻结/检测失败 → 原行为 (字面最后一帧)。

适用边界 (PRD §七 S4): 只服务尾帧直连 (降级/让位) 路径 — latent 续接路径
不走尾帧 (S1 注入自己的 AV latent 上下文), 本模块不参与。

开发期阈值登记 (2026-08-29):
- 视觉静止门 STILL_DIFF_THRESH = 0.5: 相邻帧 Y 平面均值绝对差 < 0.5 级
  (8bit) 为一帧静止差。
- 连续静止帧数下限 STILL_MIN_FRAMES = 10: 尾段连续静止帧 >= 10 才构成冻结
  候选 (短于 10 帧的静止 = 正常运镜停顿, 不动尾帧)。
- 运动幅度门 MOTION_TOTAL_THRESH = 2.0 (Y 级累计): 静止候选段帧差累计和上
  限 — 真冻结 = 有损编码噪声级 (每帧差 ~0.05, 累计 << 2.0); 极慢移动 (每帧
  0.2~0.4 级, 单帧过静止门但持续) 累计超限 → 拒判 (双门结合语义: 尾窗视觉
  静止 且 尾窗总运动 < 阈值 → 冻结)。
- 尾窗 TAIL_SECONDS = 2.0 (PRD "如末尾 2s"); 全窗静止 (冻结起点在窗外) 时
  扩窗重试一次 TAIL_FALLBACK_SECONDS = 5.0; 扩窗后仍全静 (整段冻结坏段) →
  取尾窗第一帧 (登记边界 — 总比复制尾帧好, 且此类段本身是坏段)。
- 探测域: yuv444p raw 取 Y 平面 (与 color_align.probe_y_stats 同款 — YUV
  家族内 Y 逐字节保留, yuv→gray 的 swscale range 协商不透明, 弃用)。
- 抽帧对齐: 第二次 ffmpeg 用**同 -sseof 定位 + select 相对帧号** — 两次调
  用 seek 行为确定一致, 相对帧号即第一次抽帧的坐标, 避开 duration×fps 元
  数据推全局帧号的漂移风险。
- 帧差坐标系: diffs[i] = 帧 i→i+1 差。尾静止差游程起点 j → 帧 j 是**定格帧**
  (静止段第一帧/复制源 — 画面从它起不再变化), 静止差游程长 = len(diffs)-j
  (即复制帧数, 与"连续 >=10 帧"的帧数语义对齐)。find_freeze_start 返回 j;
  有效帧 = 起点前帧 = j-1 (最后一个动态帧)。真机验证 (lavfi testsrc→黑场
  切换样本): j=32 → 帧 32 是黑场定格, select n=31 才是 testsrc 动态帧。

纯函数 (frame_diff_stats/find_freeze_start/is_frozen) 与执行侧
(probe_tail_frames/extract_with_freeze_detect) 分离: 前者毫秒级可测 (合成
基准), 后者真机 ffmpeg。
"""
import os
import subprocess

import numpy as np

import join_engine

# ---- 双门阈值 (开发期登记, 详见模块 docstring) ----
STILL_DIFF_THRESH = 0.5      # 视觉静止门: 相邻帧 Y 均值绝对差 (8bit 级)
STILL_MIN_FRAMES = 10        # 连续静止帧数下限
MOTION_TOTAL_THRESH = 2.0    # 运动幅度门: 静止候选段帧差累计和上限 (Y 级)

# ---- 尾窗 ----
TAIL_SECONDS = 2.0           # 尾窗时长 (PRD §七 S4 "如末尾 2s")
TAIL_FALLBACK_SECONDS = 5.0  # 全窗静止时的扩窗重试时长

# ---- 抽帧 ----
LITERAL_TAIL_OFFSET = "-0.1" # 未冻结降级: 原字面最后一帧 -sseof 偏移 (旧行为)
EXTRACT_TIMEOUT = 120        # 抽帧/探测超时 (秒, 与 batch_core 尾帧提取一致)


class FreezeDetectError(Exception):
    """freeze_detect 可预期失败 (探测/抽帧), 调用方据此降级回字面最后一帧."""


def _stderr_tail(stderr):
    """stderr 兼容 bytes/str: 取尾 200 字符."""
    if isinstance(stderr, bytes):
        return (stderr or b"")[-200:].decode("utf-8", "replace")
    return (stderr or "")[-200:]


# ============================================================
# 纯函数 — 帧差统计 / 冻结起点 / 双门判定
# ============================================================

def frame_diff_stats(frames):
    """帧序列 (N,H,W) uint8/float → 相邻帧 Y 平面均值绝对差列表 (N-1 个).

    先转 float64 再差分 — uint8 直接 diff 会回绕 (250→2 必须算 248 不是 8)。
    少于 2 帧返回 [] (无从比较)。
    """
    arr = np.asarray(frames, dtype=np.float64)
    if arr.ndim != 3 or arr.shape[0] < 2:
        return []
    return [float(v) for v in np.abs(np.diff(arr, axis=0)).mean(axis=(1, 2))]


def find_freeze_start(diffs, still_thresh=STILL_DIFF_THRESH,
                      min_still_frames=STILL_MIN_FRAMES):
    """视觉静止门: 冻结起点 (定格帧索引), 不冻结返回 None。

    diffs[i] = 帧 i→i+1 差。找最大 j 使 diffs[j:] 全部 < still_thresh (尾段
    静止差游程), 帧 j 即定格帧 (静止段第一帧/复制源), 静止差游程长 = len-j
    (复制帧数)。游程长 >= min_still_frames → 返回 j; 否则 None (短暂停顿
    不算冻结)。
    """
    n = len(diffs)
    if n == 0:
        return None
    j = n
    while j > 0 and diffs[j - 1] < still_thresh:
        j -= 1
    if (n - j) < min_still_frames:
        return None
    return j


def is_frozen(diffs, still_thresh=STILL_DIFF_THRESH,
              min_still_frames=STILL_MIN_FRAMES,
              motion_total_thresh=MOTION_TOTAL_THRESH):
    """双门判定: 视觉静止门 (静止差游程 >= 下限) 且 运动幅度门 (游程差累计
    < 上限) → True。

    运动幅度门作用在**静止差游程本身** (diffs[start:]): 真冻结累计 = 编码噪
    声级; 极慢移动 (单帧过静止门但持续) 累计超限被拒 — 双门结合语义。进入
    定格帧的那一次大差 (diffs[start-1]) 不计入 — 它是运动的最后一步。
    """
    start = find_freeze_start(diffs, still_thresh, min_still_frames)
    if start is None:
        return False
    return sum(diffs[start:]) < motion_total_thresh


# ============================================================
# 执行侧 — 尾窗抽帧 + 冻结尾提取
# ============================================================

def probe_tail_frames(path, window=TAIL_SECONDS, ffmpeg_exe="ffmpeg",
                      ffprobe_exe="ffprobe"):
    """段尾窗口抽帧 → Y 平面帧序列 (N,H,W) uint8。

    ffmpeg -sseof 尾窗 + yuv444p raw pipe (探测域与判定域同源, 见 docstring);
    ffprobe (复用 join_engine.probe_segment) 取宽高切帧。文件不存在直接
    raise (不跑 ffmpeg); 解码失败/无完整帧 raise FreezeDetectError。
    """
    if not os.path.exists(path):
        raise FreezeDetectError("段文件不存在: %s" % path)
    info = join_engine.probe_segment(path, ffprobe_exe=ffprobe_exe)
    w, h = info.get("width"), info.get("height")
    if not w or not h:
        raise FreezeDetectError("段无分辨率信息: %s" % path)
    cmd = [ffmpeg_exe, "-v", "error", "-sseof", str(-float(window)), "-i", path,
           "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=EXTRACT_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise FreezeDetectError("尾窗抽帧 %s 异常: %s" % (path, e))
    if proc.returncode != 0 or not proc.stdout:
        raise FreezeDetectError("尾窗抽帧 %s 失败 rc=%d %s"
                                % (path, proc.returncode, _stderr_tail(proc.stderr)))
    plane = w * h
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    n = len(buf) // (plane * 3)
    if n == 0:
        raise FreezeDetectError("尾窗无完整帧: %s" % path)
    frames = buf[:n * plane * 3].reshape(n, 3, h, w)
    return frames[:, 0, :, :]                     # 只取 Y 平面


def _run_cut(cmd):
    """执行抽帧命令; 失败/产物缺失 raise FreezeDetectError."""
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=EXTRACT_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise FreezeDetectError("尾帧抽取异常: %s" % e)
    if proc.returncode != 0 or not os.path.exists(cmd[-1]):
        raise FreezeDetectError("尾帧抽取失败 rc=%d %s"
                                % (proc.returncode, _stderr_tail(proc.stderr)))


def extract_with_freeze_detect(video_path, out_png, ffmpeg_exe="ffmpeg",
                               ffprobe_exe="ffprobe"):
    """冻结尾检测提取尾帧 → 写 out_png, 返回判定信息 dict。

    返回 {"frozen": bool, "mode": "freeze_cut"|"last", "frame": int|None,
    "window": float} — freeze_cut = 冻结, frame = 起点前有效帧的尾窗相对
    帧号; last = 未冻结/降级, 取字面最后一帧 (-sseof -0.1, 旧行为)。
    全窗静止先扩窗重试一次 (TAIL_FALLBACK_SECONDS), 仍全静取尾窗第一帧
    (登记边界)。任何失败 raise FreezeDetectError (调用方降级, 拼接永远能跑)。
    """
    frames = probe_tail_frames(video_path, window=TAIL_SECONDS,
                               ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)
    diffs = frame_diff_stats(frames)
    frozen = is_frozen(diffs)
    start = find_freeze_start(diffs)
    used_window = TAIL_SECONDS
    if frozen and start == 0:
        # 尾窗首帧即定格 → 冻结起点在窗外更早, 扩窗重试一次
        wide = probe_tail_frames(video_path, window=TAIL_FALLBACK_SECONDS,
                                 ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)
        wide_diffs = frame_diff_stats(wide)
        if is_frozen(wide_diffs):
            diffs, start = wide_diffs, find_freeze_start(wide_diffs)
            used_window = TAIL_FALLBACK_SECONDS
    if frozen and start is not None:
        frame = max(0, start - 1)                 # 定格帧前一帧 = 最后动态有效帧
        cmd = [ffmpeg_exe, "-y", "-sseof", str(-used_window), "-i", video_path,
               "-vf", "select='eq(n,%d)'" % frame, "-frames:v", "1", out_png]
        _run_cut(cmd)
        return {"frozen": True, "mode": "freeze_cut", "frame": frame,
                "window": used_window}
    # 未冻结 / 双门拒绝 (极慢移动) → 原行为: 字面最后一帧
    cmd = [ffmpeg_exe, "-y", "-sseof", LITERAL_TAIL_OFFSET, "-i", video_path,
           "-frames:v", "1", out_png]
    _run_cut(cmd)
    return {"frozen": False, "mode": "last", "frame": None,
            "window": TAIL_SECONDS}
