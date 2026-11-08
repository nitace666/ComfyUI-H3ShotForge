"""分轨继承挑段 (方案 76 §3.2): 上段成片音频挑 3 秒参照窗 → 32k 立体声 wav.

纯函数模块, 无接线 (接线归 E4); stems 由 E2 提供且采样率须与输出一致 (32k).
"""
import os
import shutil
import subprocess

import numpy as np
import soundfile as sf

SR = 32000            # 音频 VAE 侧采样率
WIN_MS = 50           # RMS 短窗
HOP_MS = 25           # RMS 滑窗步长
MIN_DB = -40.0        # 人声近静音判据: 窗 RMS < 全曲峰值 −40dBFS
_FFMPEG_FIXED = r"C:\ffmpeg\bin\ffmpeg.exe"


class SilentBackgroundError(RuntimeError):
    """背景轨全窗 RMS=0 — 上层据此降单人声."""


def _ffmpeg_exe():
    """PATH → C:\\ffmpeg\\bin\\ffmpeg.exe → imageio-ffmpeg 回落 (照 batch_core._ffmpeg_exe 先例)."""
    p = shutil.which("ffmpeg")
    if p:
        return p
    if os.path.isfile(_FFMPEG_FIXED):
        return _FFMPEG_FIXED
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"  # 让 subprocess 报出可读的 FileNotFoundError


def extract_audio(mp4_path, sr_out=SR):
    """ffmpeg pipe 解码 mp4 音频 → (pcm[2,L] float32, sr); 强制 32k 立体声."""
    cmd = [_ffmpeg_exe(), "-v", "error", "-i", str(mp4_path), "-vn",
           "-ac", "2", "-ar", str(int(sr_out)),
           "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RuntimeError("ffmpeg 音频解码失败: %s" % err[-300:])
    raw = np.frombuffer(proc.stdout or b"", dtype="<f4")
    if raw.size % 2:  # 截断的尾帧丢弃, 保持立体声帧对齐
        raw = raw[:-1]
    return raw.reshape(-1, 2).T.copy().astype(np.float32, copy=False), int(sr_out)


def rms_series(pcm, sr, win_ms=WIN_MS, hop_ms=HOP_MS):
    """逐短窗 RMS 序列 (通道合并); 不足一窗返回空数组."""
    x = np.asarray(pcm, dtype=np.float64)
    if x.ndim == 1:
        x = x[None, :]
    win = max(1, int(round(sr * win_ms / 1000.0)))
    hop = max(1, int(round(sr * hop_ms / 1000.0)))
    if x.shape[1] < win:
        return np.zeros(0, dtype=np.float64)
    frames = np.lib.stride_tricks.sliding_window_view(x, win, axis=1)[:, ::hop]
    return np.sqrt(np.mean(frames ** 2, axis=2)).mean(axis=0)


def align_800(n):
    """向下取整 800 样本倍数 (音频 VAE 中心裁防护)."""
    return int(n) // 800 * 800


def pick_window(rms, sr, seconds=3.0, mode="brightest"):
    """3 秒滑窗评分选段: brightest=窗均值最大 / steadiest=窗方差最小; 并列取最早窗.

    rms 须为 rms_series 默认参数 (50ms 窗/25ms 步) 的产出; 返回样本起止 (已 800 对齐).
    """
    r = np.asarray(rms, dtype=np.float64).ravel()
    hop = max(1, int(round(sr * HOP_MS / 1000.0)))
    nwin = max(1, int(round((seconds * 1000.0 - WIN_MS) / HOP_MS)) + 1)
    if r.size < nwin:
        raise ValueError("素材不足一个完整窗: rms=%d 帧, 需 %d 帧" % (r.size, nwin))
    view = np.lib.stride_tricks.sliding_window_view(r, nwin)
    if mode == "brightest":
        idx = int(np.argmax(view.mean(axis=1)))
    elif mode == "steadiest":
        idx = int(np.argmin(view.var(axis=1)))
    else:
        raise ValueError("未知挑段 mode: %r" % (mode,))
    start = align_800(idx * hop)
    end = align_800(start + int(round(seconds * sr)))
    return start, end


def _stereo(pcm):
    """(L,) 或 (1,L) → (2,L): 单声道 replicate 成双声道."""
    x = np.asarray(pcm, dtype=np.float32)
    if x.ndim == 1:
        x = x[None, :]
    if x.shape[0] == 1:
        x = np.repeat(x, 2, axis=0)
    return x


def slice_to_wav(pcm, sr, start, end, out_path):
    """切 [start,end) 写立体声 wav (float32 保真)."""
    data = _stereo(pcm)[:, int(start):int(end)]
    sf.write(str(out_path), np.ascontiguousarray(data.T), int(sr), subtype="FLOAT")


def _sum_stems(stems):
    """各 stem 线性求和 (混回/全曲基线); 缺轨跳过."""
    tracks = [_stereo(v) for v in stems.values() if v is not None]
    if not tracks:
        return None
    n = min(t.shape[1] for t in tracks)
    mix = np.zeros((2, n), dtype=np.float32)
    for t in tracks:
        mix += t[:, :n]
    return mix


def _vocal_span(vocals, mix, sr):
    """人声最亮窗; 近静音 (窗 RMS < 全曲峰值−40dBFS) 回退全曲最亮窗 → (start, end, 是否回退)."""
    start, end = pick_window(rms_series(vocals, sr), sr, mode="brightest")
    win_rms = float(np.sqrt(np.mean(_stereo(vocals)[:, start:end].astype(np.float64) ** 2)))
    peak = float(np.max(np.abs(mix))) if mix is not None else 0.0
    if peak <= 0.0 or win_rms < peak * 10 ** (MIN_DB / 20.0):
        return pick_window(rms_series(mix, sr), sr, mode="brightest") + (True,)
    return start, end, False


def _stems_pick(stems, vocals_on, background_on):
    """按子开关取轨并切窗 → (pcm, sr)."""
    vocals = stems.get("vocals")
    accomp = stems.get("accompaniment")
    mix = _sum_stems(stems)
    if background_on and accomp is not None:
        bg_rms = rms_series(accomp, SR)
        if bg_rms.size and not bg_rms.any():
            raise SilentBackgroundError("背景轨全窗 RMS=0")
    short = mix.shape[1] < int(round(3.0 * SR))
    fell_back = False
    if vocals_on and vocals is not None:
        if short:
            start, end = 0, align_800(mix.shape[1])
        else:
            start, end, fell_back = _vocal_span(vocals, mix, SR)
    elif background_on and accomp is not None:
        start, end = ((0, align_800(mix.shape[1])) if short
                      else pick_window(rms_series(accomp, SR), SR, mode="steadiest"))
    else:
        start, end = ((0, align_800(mix.shape[1])) if short
                      else pick_window(rms_series(mix, SR), SR, mode="brightest"))
    if fell_back:
        return mix[:, start:end], SR
    if vocals_on and background_on and vocals is not None and accomp is not None:
        return _stereo(vocals)[:, start:end] + _stereo(accomp)[:, start:end], SR
    if vocals_on and vocals is not None:
        return _stereo(vocals)[:, start:end], SR
    if background_on and accomp is not None:
        return _stereo(accomp)[:, start:end], SR
    return mix[:, start:end], SR


def pick_reference(mp4_path, out_wav, stems=None, vocals_on=False, background_on=False):
    """编排级挑段: 写 32k 立体声参照 wav 并返回路径; 解码失败返回 None (降级信号).

    stems=None (轻量版): 全曲挑最亮原样; stems 由 E2 提供 (32k·键 vocals/accompaniment),
    按子开关取轨; 双轨开=人声窗为准·背景同窗·两轨线性求和.
    背景纯静音抛 SilentBackgroundError (上层降单人声).
    """
    if stems:
        pcm, sr = _stems_pick(stems, vocals_on, background_on)
    else:
        try:
            pcm, sr = extract_audio(mp4_path)
        except (OSError, RuntimeError):
            return None
        n = pcm.shape[1]
        if n < int(round(3.0 * sr)):
            start, end = 0, align_800(n)
        else:
            start, end = pick_window(rms_series(pcm, sr), sr, mode="brightest")
        pcm = pcm[:, start:end]
    slice_to_wav(pcm, sr, 0, pcm.shape[1], out_wav)
    return str(out_wav)
