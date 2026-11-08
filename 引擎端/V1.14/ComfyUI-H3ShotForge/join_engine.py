"""join_engine.py — V1.9 批 3 T3.4: S3 拼接合成引擎 (转场 + 响度 + 编码策略)
            V1.10 批 1 T1: match_tail 音画对齐 (流级探测 + atrim/apad).
            V1.10 批 1 T2: hard_cut 缝点 declick + 安静缝点淡化.

移植自自家脚本线 h3_engine/transition.py (build_join_command/JOIN_MODES/
LOUDNORM_FILTER, 机制语义保持原文: hard_cut/crossfade/fade/black 四模式滤镜图
+ EBU R128 逐段 loudnorm), 按 PRD §七 S3 / §十 默认值矩阵做节点包参数适配:

开发期决策登记 (2026-08-29):
- 默认 join_mode=crossfade, crossfade_frames=4 (帧驱动: fade_seconds=frames/fps,
  首段探测 fps); hard_cut 备选 — 切点类型区分本版以"全局模式选择"落地, 不做逐段
  判定 (拼接语义段本身是同场景链延续, 场景切换由用户手动选 hard_cut; 逐段判定
  后续版本, 不扩 CSV 契约)
- loudnorm 默认开 (EBU R128 I=-16:TP=-1.5:LRA=11, 复刻脚本线 LOUDNORM_FILTER)
- 重编码条件: 转场(非 hard_cut)或 loudnorm 任一开启 → 重编码路径, pix_fmt=yuv422p
  (≥4:2:2), 视频 -crf 18 -preset medium libx264, 音频 aac -b:a 192k
- 输出分辨率/fps/采样率 = 首段 ffprobe 探测注入 (不照搬脚本线 720p/24fps/32kHz)
- 全关退路: hard_cut + loudnorm=False + explicit_stream_copy=True → -f concat
  -c copy, 命令形态与 V1.8 裸拼接逐字节一致 (金标准回归路径)
- 段 mp4 为内嵌音视频: 非硬切模式 audio_paths 缺省回落 segments (同文件交替
  输入, 滤镜图索引机制同脚本线分离音视频源原文)
- 已知边界: 音轨状态按首段整链统一 (首段无音轨 → 整链按无音频拼), 段间音轨
  混合态不支持 (节点包同管线产出段音轨一致)

V1.10 批 1 T1 (2026-08-30) 决策登记 (D2 match_tail / D5 持久基线):
- match_tail 默认开: 音画时长差超出容差 (默认 5ms) 时插入 atrim=start=0:end={v_dur}
  (音频长) 或 apad=whole_dur={v_dur} (音频短); 插在每段音频链最前 (loudnorm 之前)
- probe_segment 扩展 video_duration/audio_duration (流级时长, 与 format.duration
  容器时长区分; match_tail 以流级为准)
- match_tail 开启时所有模式 (含 hard_cut / black) 逐段探测; crossfade/fade xfade
  offset 仍走容器时长, 与 match_tail 流级时长互不干扰
- fade 模式 afade t=out st 用裁齐后时长 (v_dur) 而非容器时长 (匹配音频基准)
- D5 持久基线: match_tail=False 时 build_join_command 输出与 V1.9 现状逐字符
  一致; T2 (declick/silence_fade) / T3 (BGM) 接线时沿用, 不删

V1.10 批 1 T2 (2026-08-30) 决策登记 (D3 hard_cut 缝点处理):
- hard_cut 缝点: 段 i 尾与段 i+1 头之间 (成品首尾边界不处理 — 首段头部、末段尾
  部不加任何 afade); 仅 join_mode="hard_cut" 分支生效, crossfade/fade/black
  加既有转场处理不再叠加缝点 afade.
- 安静判定: 每段头/尾各 100ms 测 RMS (dB), 钉死调用
  `ffmpeg -i {seg} -ss {pos} -t {win} -af astats=measure_perchannel=none -f null -`
  (-ss 在 -i 后, 输出侧精确定位, 避开 AAC 整包粒度偏移); 解析全部 `RMS level dB:`
  行 (每通道 + Overall) 取最大值; 解析失败按"非安静"处理 (fail-safe 加淡化).
- 淡化取大不叠加: 非安静缝点 → 两侧各 silence_fade_seconds afade (覆盖 declick);
  安静缝点 → 仅 declick_ms 短 afade; declick 开 + silence_fade 关 → 所有缝点直
  接 declick (不探测).
- 链序: hard_cut 每段音频链 = match_tail(atrim/apad) → seam_afade → loudnorm → concat.
- 流复制互斥 (行为变化): hard_cut 且 (declick 或 silence_fade 开) → 强制滤镜链
  重编码, 忽略 explicit_stream_copy=True (流复制无法加任何音频处理).
- 流级探测扩张: needs_stream_durations = match_tail OR declick OR silence_fade
  (三件套任一开 → 所有模式逐段探测; afade t=out st 需要流级 v_dur 作基准).
- declick_ms 语义: None=关闭 (不加 afade), 数值=毫秒数. 本任务默认 None (T2
  落地后 A/B 校准定稿才改默认).

本模块只构造 ffmpeg 命令参数与 ffprobe/astats 探测, 不执行拼接送 subprocess 之外
的副作用 (probe_segment 执行 ffprobe / _probe_segment_rms 执行 astats 只读探测)。
供 batch_core._concat_videos 接入与测试复用。
"""
import json
import os
import subprocess

# ---- 移植自脚本线 transition.py (机制语义保持) ----
JOIN_MODES = ("hard_cut", "crossfade", "fade", "black")

# EBU R128 响度归一(逐段应用,消除长链音频衰减带来的接缝音量阶跃,脚本线 M6.1)
LOUDNORM_FILTER = "I=-16:TP=-1.5:LRA=11"

# ---- 节点包默认值矩阵适配 (PRD §十 S3 行) ----
DEFAULT_JOIN_MODE = "crossfade"
DEFAULT_CROSSFADE_FRAMES = 4
DEFAULT_LOUDNORM = True
OUTPUT_PIX_FMT = "yuv422p"          # ≥4:2:2
DEFAULT_CRF = "18"
DEFAULT_PRESET = "medium"
DEFAULT_AUDIO_BITRATE = "192k"
DEFAULT_BLACK_SECONDS = 0.3         # black 模式段首黑场 (脚本线 PRD §4.2 原值)

# ---- V1.10 T2 hard_cut 缝点默认值 (D3) ----
DEFAULT_DECLICK_MS = None           # None=关闭; 数值=毫秒 (15ms 由 A/B 定稿)
DEFAULT_SILENCE_FADE = True         # 安静缝点判定 + 非安静时给 silence_fade_seconds 淡化
DEFAULT_SILENCE_FADE_SECONDS = 0.375
DEFAULT_SILENCE_THRESHOLD_DB = -45.0
DEFAULT_SILENCE_PROBE_SECONDS = 0.1

# ---- V1.10 批 1 T3 BGM 通道默认值 (D1) ----
DEFAULT_BGM_MIX_MODE = "replace"    # replace=成品直接替换为 BGM; mix=段音+BGM 混合
DEFAULT_BGM_SIDE_VOLUME = 0.5       # mix 时段侧音量(-6dB, 音乐为主)


class JoinError(Exception):
    """join_engine 可预期失败 (探测失败/参数缺失), 调用方可据此降级."""


def _fmt(x):
    return "%g" % float(x)


def _pick_seam_dur(is_quiet, declick_ms, silence_fade, silence_fade_seconds):
    """缝点 afade 时长决策 (D3 淡化取大不叠加).

    - silence_fade 开 + seam 非安静 → silence_fade_seconds (覆盖 declick)
    - declick_ms 有效 (非 None) → declick_ms/1000 秒
    - 都不开 → None (不加 afade)

    `is_quiet` None 在调用方按 False (非安静) 处理 (D3 fail-safe).
    """
    if silence_fade and not is_quiet:
        return silence_fade_seconds
    if declick_ms is not None and declick_ms > 0:
        return declick_ms / 1000.0
    return None


def _seg_base_dur(seg_i, stream_durations, durations):
    """缝点 tail afade t=out 的 st 基准时长: 优先 v_dur, 其次容器 durations.
    都不可用时返回 None (调用方跳过 tail afade 防错)."""
    if stream_durations and seg_i < len(stream_durations):
        v_dur = stream_durations[seg_i][0]
        if v_dur is not None and v_dur > 0:
            return v_dur
    if durations and seg_i < len(durations) and durations[seg_i]:
        return durations[seg_i]
    return None


def _validate_join_mode(join_mode):
    if join_mode not in JOIN_MODES:
        raise ValueError(
            f"非法拼接转场模式 {join_mode}:仅支持 {'/'.join(JOIN_MODES)}"
        )


def _fps_float(fps):
    """fps 接受 ffprobe r_frame_rate 原始串("16/1"/"30000/1001")或 float."""
    if isinstance(fps, str) and "/" in fps:
        num, _, den = fps.partition("/")
        den_f = float(den)
        if den_f == 0:
            raise ValueError(f"非法帧率 {fps}:分母为 0")
        val = float(num) / den_f
    else:
        val = float(fps)
    if val <= 0:
        raise ValueError(f"非法帧率 {fps}:须为正数")
    return val


def _fps_arg(fps):
    return fps if isinstance(fps, str) else _fmt(fps)


def probe_segment(path, ffprobe_exe="ffprobe"):
    """ffprobe JSON 探测单段 → {width,height,fps(原始串),fps_float,sample_rate,
    has_audio,duration,video_duration,audio_duration}。无视频流/ffprobe 失败
    raise JoinError (调用方降级). V1.10 起新增 video_duration/audio_duration:
    stream 级时长 (可能与 format.duration 容器时长不等, match_tail 以流级为准).
    """
    cmd = [ffprobe_exe, "-v", "error", "-print_format", "json",
           "-show_streams", "-show_format", path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise JoinError("ffprobe %s 异常: %s" % (path, e))
    if proc.returncode != 0:
        stderr_tail = (proc.stderr or b"")[-200:].decode("utf-8", "replace")
        raise JoinError("ffprobe %s 失败 rc=%d %s"
                        % (path, proc.returncode, stderr_tail))
    try:
        data = json.loads((proc.stdout or b"").decode("utf-8", "replace"))
    except ValueError:
        raise JoinError("ffprobe %s 输出非 JSON" % path)
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        raise JoinError("段无视频流: %s" % path)
    dur = (data.get("format") or {}).get("duration") or v.get("duration")
    sr = a.get("sample_rate") if a else None
    v_dur_raw = v.get("duration")
    a_dur_raw = a.get("duration") if a else None
    return {
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": str(v.get("r_frame_rate") or ""),
        "fps_float": _fps_float(str(v.get("r_frame_rate") or "0/1")),
        "sample_rate": int(sr) if sr else None,
        "has_audio": a is not None,
        "duration": float(dur) if dur not in (None, "") else None,
        "video_duration": float(v_dur_raw) if v_dur_raw not in (None, "") else None,
        "audio_duration": float(a_dur_raw) if a_dur_raw not in (None, "") else None,
    }


def probe_audio_duration(path, ffprobe_exe="ffprobe"):
    """ffprobe 取纯音频时长 (秒): format.duration 优先, 退化到音频流 duration。

    失败/无音频流/时长缺失 → raise JoinError (调用方降级跳过)。超时 3s —
    1.13e 批级池检查逐文件探测, 不复用 probe_segment 的 60s 拼接超时。
    """
    cmd = [ffprobe_exe, "-v", "error", "-print_format", "json",
           "-show_streams", "-show_format", "-select_streams", "a:0", path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise JoinError("ffprobe 音频 %s 异常: %s" % (path, e))
    if proc.returncode != 0:
        stderr_tail = (proc.stderr or b"")[-200:].decode("utf-8", "replace")
        raise JoinError("ffprobe 音频 %s 失败 rc=%d %s"
                        % (path, proc.returncode, stderr_tail))
    try:
        data = json.loads((proc.stdout or b"").decode("utf-8", "replace"))
    except ValueError:
        raise JoinError("ffprobe 音频 %s 输出非 JSON" % path)
    streams = data.get("streams") or []
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if a is None:
        raise JoinError("音频无音轨: %s" % path)
    dur = (data.get("format") or {}).get("duration") or a.get("duration")
    if dur in (None, ""):
        raise JoinError("音频时长缺失: %s" % path)
    try:
        return float(dur)
    except (TypeError, ValueError):
        raise JoinError("音频时长非数字: %s" % path)


def probe_audio_sample_rate(path, ffprobe_exe="ffprobe"):
    """ffprobe 取 BGM 采样率 (D1 BGM 预检). 失败/无音频 → raise JoinError.

    不得复用 probe_segment (它要求视频流, BGM 是纯音频). 仅返回采样率, 不需
    视频时长/分辨率, 用最简 ffprobe 调用减少噪声 (无 -show_format)。
    """
    cmd = [ffprobe_exe, "-v", "error", "-select_streams", "a:0",
           "-print_format", "json", "-show_streams", path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise JoinError("ffprobe BGM %s 异常: %s" % (path, e))
    if proc.returncode != 0:
        stderr_tail = (proc.stderr or b"")[-200:].decode("utf-8", "replace")
        raise JoinError("ffprobe BGM %s 失败 rc=%d %s"
                        % (path, proc.returncode, stderr_tail))
    try:
        data = json.loads((proc.stdout or b"").decode("utf-8", "replace"))
    except ValueError:
        raise JoinError("ffprobe BGM %s 输出非 JSON" % path)
    streams = data.get("streams") or []
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if a is None:
        raise JoinError("BGM 无音轨: %s" % path)
    sr = a.get("sample_rate")
    if not sr:
        raise JoinError("BGM 采样率缺失: %s" % path)
    return int(sr)


def _parse_rms_max(text):
    """从 astats 子进程输出解析所有 `RMS level dB:` 行, 返回最大值 (float).
    解析失败 (无 RMS 行 / 全部无法 float) 返回 None — 调用方按"非安静"处理
    (D3 fail-safe: 不漏加淡化).

    astats 输出对每通道各出一行 "RMS level dB:", 末尾还有 "Overall" 行;
    多通道多 RMS 取大不去 abs — 自然比较 (dB 已经是负值, 越大越响).
    """
    rms_values = []
    for line in (text or "").splitlines():
        if "RMS level dB:" not in line:
            continue
        try:
            val = float(line.split("RMS level dB:")[-1].strip())
        except (ValueError, TypeError):
            continue
        rms_values.append(val)
    if not rms_values:
        return None
    return max(rms_values)


def _probe_segment_rms(seg, pos, win, ffmpeg_exe="ffmpeg"):
    """探测段某位置后续 win 秒的 RMS dB (段头/尾安静判定用).
    调用方式钉死 (D3): ffmpeg -i {seg} -ss {pos} -t {win}
                           -af astats=measure_perchannel=none -f null -
    -ss 在 -i 之后 (输出侧精确定位, 避免输入侧快 seek 的 AAC 整包粒度 ~21ms 偏移).

    返回 max RMS (float) 或 None 解析失败 / 子进程失败 (failsafe 非安静).
    """
    cmd = [ffmpeg_exe, "-i", seg, "-ss", _fmt(pos), "-t", _fmt(win),
           "-af", "astats=measure_perchannel=none", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    text = ((proc.stdout or b"") + (proc.stderr or b"")).decode("utf-8", "replace")
    return _parse_rms_max(text)


def build_join_command(segments, join_mode, out_path, fps=None, sample_rate=None,
                       durations=None, resolution=None, has_audio=True,
                       crossfade_frames=DEFAULT_CROSSFADE_FRAMES, fade_seconds=None,
                       black_seconds=DEFAULT_BLACK_SECONDS,
                       loudnorm=DEFAULT_LOUDNORM, explicit_stream_copy=False,
                       ffmpeg_exe="ffmpeg", stream_copy_listfile=None,
                       match_tail=True, match_tail_tolerance_ms=5,
                       stream_durations=None,
                       declick_ms=DEFAULT_DECLICK_MS,
                       silence_fade=DEFAULT_SILENCE_FADE,
                       silence_fade_seconds=DEFAULT_SILENCE_FADE_SECONDS,
                       silence_threshold_db=DEFAULT_SILENCE_THRESHOLD_DB,
                       silence_probe_seconds=DEFAULT_SILENCE_PROBE_SECONDS,
                       seam_quiet=None,
                       # V1.10 批 1 T3 BGM 通道 (D1)
                       bgm_path=None, bgm_mix_mode=DEFAULT_BGM_MIX_MODE,
                       bgm_side_volume=DEFAULT_BGM_SIDE_VOLUME,
                       total_duration=None,
                       # 批 4 T1 D 色彩对齐滤镜入链
                       force_filter=False, seg_filters=None):
    """拼接层 ffmpeg 命令构造 (脚本线 transition.py 机制移植, 只拼参数不执行)。

    segments 为段视频路径列表 (节点包段 mp4 内嵌音频; 非硬切模式需要分离音视频源
    标签, audio_paths 缺省回落 segments 同文件交替输入)。durations 为各段时长秒
    (crossfade/fade 必须); crossfade xfade offset = 各段时长累积 - fade_seconds;
    black 在段首插 black_seconds 黑场并段首音频静音。fade_seconds 缺省由
    crossfade_frames/fps 换算 (4 帧@16fps → 0.25s)。

    参数适配 (默认值矩阵): 重编码路径输出 -r fps(首段探测) -pix_fmt yuv422p
    -c:v libx264 -crf 18 -preset medium + 有音频时 -ar sample_rate -c:a aac
    -b:a 192k。has_audio=False (首段探测无音轨) → 音频滤镜/映射/编码参数全省。
    全关退路 (hard_cut + loudnorm=False + explicit_stream_copy=True +
    declick_ms=None + silence_fade=False) → concat demuxer 流复制 (-c copy, 无滤镜
    无编码), 与 V1.8 裸拼接命令形态逐字节一致。

    V1.10 批 1 T1 (D2 match_tail 音画对齐): match_tail=True + stream_durations
    注入时, 每段音频链最前 (loudnorm 之前) 插入 atrim=start=0:end={v_dur}
    (音频长于视频) 或 apad=whole_dur={v_dur} (音频短于视频); 容差内 (默认 5ms)
    不插入。fade 模式 afade t=out st 用裁齐后时长 (v_dur) 而非容器时长。
    match_tail=False → D5 持久基线, 输出与 V1.9 现状逐字符一致 (T2/T3 沿用)。

    V1.10 批 1 T2 (D3 hard_cut 缝点):
    - 仅 join_mode="hard_cut" 分支生效 (crossfade/fade/black 不加缝点处理).
    - declick_ms: None=不加 declick afade; 数值=毫秒 (本任务 API 默认 None).
    - silence_fade: True (默认) 时需 seam_quiet (compose_join 探测后注入) 决
      定每缝点行为; False 时 seam_quiet 被忽略, 与 declick 互斥.
    - 规则: silence_fade 开 + 非安静 → silence_fade_seconds 覆盖 declick;
      silence_fade 开 + 安静 → 仅 declick; silence_fade 关 → 仅 declick (或不加).
    - 链序: 段音频 = match_tail(atrim/apad) → seam_head_afade → seam_tail_afade
      → loudnorm (D3 fail-safe: seam_quiet=None 按非安静处理).
    - 流复制互斥: hard_cut + (declick_ms 数值 OR silence_fade=True) → 即使
      explicit_stream_copy=True 也走滤镜链重编码 (流复制无法加任何音频处理).

    返回 {"command": [argv...], "extra_inputs": [...]}: 流复制路径 extra_inputs
    为 concat 列表文件路径 (调用方写入内容), 其余模式为空列表。

    V1.10 批 1 T3 (D1 BGM 通道):
    - bgm_path 非空时启用 BGM 通道: BGM 作为尾部追加 -i (hard_cut 索引=n,
      其他模式索引=2n, 双 -i 布局), filter_complex 收尾追加 BGM 归一链
      `[bgm_i:a]aresample={sr},aformat=sample_fmts=fltp:channel_layouts=stereo[bgmn]`
    - bgm_mix_mode="replace" (默认) 或 has_audio=False → 段音频链不构建, filter_complex
      无任何 [N:a] 段引用; bgm 链输出直接命名 [aout] 保持 -map 一致 (ffmpeg 不引用不
      解码段音频, 省一遍 loudnorm 白算)
    - bgm_mix_mode="mix" + has_audio=True → 段音链照旧产出 [aout], 接段侧 aformat+
      volume=`bgm_side_volume` → [side], 再 amix `[bgmn][side]amix=inputs=2:duration=
      longest:normalize=0[aout2]`; -map 改为 [aout2]
    - has_audio=False + BGM: 输出音频编码参数 (-ar/-c:a/-b:a 与 -map [aout]) 不受
      has_audio 门控 (BGM 提供音轨); sample_rate 由 compose_join 注入 (BGM 预检)
    - total_duration 非 None → 命令追加 `-t {total_duration}` 置于 out_path 之前
      (BGM 短于画面时替换=末尾静音, 混合=只剩段音轨, 不报错也不写 manifest)
    - bgm_path 非空 → 强制走滤镜链, 忽略 explicit_stream_copy=True (T2 已禁 seam
      流复制; T3 同理禁 BGM 流复制, 流复制无法加 BGM 处理)
    - bgm_path=None 时命令与 T2 后现状逐字符一致 (D5 持久基线延伸)

    批 4 T1 D (色彩对齐滤镜入链):
    - seg_filters: 逐段视频滤镜串列表 (与 segments 对齐, None=该段不调) — 接入
      各模式段视频源链最前 (hard_cut 替代 null 链, crossfade/fade/black 先产
      [vf{i}] 再进转场/concat), 段只编码一次 (省一代重编码)。
    - force_filter: 照 BGM 禁流复制先例 — True 时即使全关退路形态也不落流复制
      (色彩对齐激活时由接入层置 True; 滤镜链是唯一能承载逐段滤镜的路径)。
    - seg_filters=None 且 force_filter=False 时命令与既有现状逐字符一致
      (D5 持久基线延伸)。
    """
    _validate_join_mode(join_mode)
    if not segments:
        raise ValueError("段列表为空:至少需要 1 个段")
    bgm_active = bool(bgm_path)
    if bgm_active and bgm_mix_mode not in ("replace", "mix"):
        raise ValueError("bgm_mix_mode 仅支持 replace/mix, 实得 %s" % bgm_mix_mode)
    seg_filters = [f or None for f in (seg_filters or [])]
    filters_active = any(seg_filters)
    if filters_active and len(seg_filters) != len(segments):
        raise ValueError("seg_filters 数量 %d 与段数量 %d 不一致"
                         % (len(seg_filters), len(segments)))

    def _segf(i):
        return seg_filters[i] if i < len(seg_filters) else None

    # 流复制互斥 (T2 + T3 + 批4 T1): seam 处理开 OR BGM 启用 OR 逐段滤镜/强制
    # 滤镜 → 必须走滤镜链, 即便 explicit_stream_copy=True 也不退化. V1.9 全关
    # 退路仅在 seam+bgm+色彩滤镜全关时生效.
    seam_off = (declick_ms is None and not silence_fade)
    if (join_mode == "hard_cut" and not loudnorm and explicit_stream_copy
            and seam_off and not bgm_active
            and not force_filter and not filters_active):
        listfile = stream_copy_listfile or (
            os.path.splitext(out_path)[0] + ".concat.txt")
        return {
            "command": [ffmpeg_exe, "-y", "-f", "concat", "-safe", "0",
                        "-i", listfile, "-c", "copy", out_path],
            "extra_inputs": [listfile],
        }
    if fps is None:
        raise ValueError("重编码路径必须提供 fps(首段 ffprobe 探测注入)")
    # 输出音频门控: has_audio 或 BGM 启用 → 需要 sample_rate + 音频编码参数
    audio_output = has_audio or bgm_active
    if audio_output and sample_rate is None:
        raise ValueError("输出音频必须提供 sample_rate (段探测或 BGM 预检注入)")
    if crossfade_frames <= 0:
        raise ValueError(f"crossfade_frames 须为正整数: {crossfade_frames}")
    if fade_seconds is None:
        fade_seconds = crossfade_frames / _fps_float(fps)

    # V1.13 D13: fade_seconds 上限 = 参与段最短时长, 防 offset/st 为负.
    # clamp 与 offset/st 计算同源 — 用 stream_durations 优先的同一时长口径 (与
    # :561-565 一致). 超出钳制 + 一条日志 (不阻断, 命令照旧生成 — ffmpeg 自然截断).
    if durations:
        _shortest_candidates = []
        _sd_list = stream_durations if stream_durations else [None] * len(durations)
        for _i, _dur in enumerate(durations):
            _sd = _sd_list[_i] if _i < len(_sd_list) else None
            if _sd and isinstance(_sd, tuple) and _sd[0] is not None:
                _shortest_candidates.append(_sd[0])
            else:
                _shortest_candidates.append(_dur)
        _shortest_dur = min(_shortest_candidates) if _shortest_candidates else None
        if _shortest_dur and fade_seconds > _shortest_dur:
            print("[H3Join] D13: fade_seconds=%.4f > 最短段=%.4f, 钳制为最短段 (防负 offset/st)"
                  % (fade_seconds, _shortest_dur), flush=True)
            fade_seconds = _shortest_dur

    if join_mode == "hard_cut":
        inputs = []
        for seg in segments:
            inputs += ["-i", seg]
    else:
        # 内嵌音视频: audio_paths 缺省回落 segments (同文件交替输入保持脚本线
        # 分离音视频源的输入布局, 滤镜图 [2i:v]/[2i+1:a] 索引机制不变)
        audio_paths = segments
        inputs = []
        for seg, aud in zip(segments, audio_paths):
            inputs += ["-i", seg, "-i", aud]
    # BGM 尾部追加输入 (T3): hard_cut 索引=len(segments), 其他模式 (双 -i 布局)
    # 索引=2*len(segments). 该索引必须在 segments 全部入栈后才能确定.
    bgm_idx = None
    if bgm_active:
        bgm_idx = len(segments) if join_mode == "hard_cut" else 2 * len(segments)
        inputs += ["-i", bgm_path]
    if join_mode in ("crossfade", "fade"):
        if durations is None:
            raise ValueError(f"{join_mode} 转场需要提供 durations 段时长列表(秒)")
        if len(durations) != len(segments):
            raise ValueError(
                f"durations 数量 {len(durations)} 与段数量 {len(segments)} 不一致")
        if any(d is None or d <= 0 for d in durations):
            raise ValueError("durations 含空值/非正值:无法计算转场 offset")
    if join_mode == "crossfade" and len(segments) < 2:
        raise ValueError("叠化转场至少需要 2 个段")
    if join_mode == "black" and not resolution:
        raise ValueError("black 转场需要提供 resolution(首段 ffprobe 探测注入)")

    def audio_loud(seg_i, audio_i, parts):
        """音频源标签; match_tail (T1) → seam_afade (T2, hard_cut) → loudnorm.
        seg_i 为段索引 (match_tail/seam 标签命名), audio_i 为音频输入索引 (loudnorm
        标签命名, 与既有 V1.9 标签体系一致).
        T2 seam afade 仅在 hard_cut 模式 + has_audio 下生效: 首段头部、末段尾部不
        处理, 内部缝点按 seam_quiet 决定 silence_fade/declick; chain 顺序在
        match_tail 之后, loudnorm 之前 (链序见任务简报 D3)."""
        src = f"[{audio_i}:a]"
        # 1. match_tail (T1)
        if match_tail and has_audio and stream_durations \
                and seg_i < len(stream_durations):
            v_dur, a_dur = stream_durations[seg_i]
            if v_dur is not None and a_dur is not None:
                diff = a_dur - v_dur
                tol_s = match_tail_tolerance_ms / 1000.0
                if abs(diff) > tol_s:
                    if diff > 0:
                        # 音频长于视频: 显式 start=0 裁到视频时长
                        parts.append(f"{src}atrim=start=0:end={_fmt(v_dur)}[ta{seg_i}]")
                    else:
                        # 音频短于视频: 补静音到视频时长
                        parts.append(f"{src}apad=whole_dur={_fmt(v_dur)}[ta{seg_i}]")
                    src = f"[ta{seg_i}]"
        # 2. seam afade (T2, hard_cut only)
        n = len(segments)
        if join_mode == "hard_cut" and has_audio:
            # Head seam afade (between seg_i-1 and seg_i) — only if internal
            if seg_i > 0 and (declick_ms is not None or silence_fade):
                seam_idx = seg_i - 1
                seam_is_quiet = (
                    seam_quiet is not None
                    and seam_idx < len(seam_quiet)
                    and seam_quiet[seam_idx])
                hd = _pick_seam_dur(seam_is_quiet, declick_ms, silence_fade,
                                    silence_fade_seconds)
                if hd is not None:
                    head_label = f"[sh{seg_i}]"
                    parts.append(
                        f"{src}afade=t=in:st=0:d={_fmt(hd)}{head_label}")
                    src = head_label
            # Tail seam afade (between seg_i and seg_i+1) — only if internal
            if seg_i < n - 1 and (declick_ms is not None or silence_fade):
                seam_idx = seg_i
                seam_is_quiet = (
                    seam_quiet is not None
                    and seam_idx < len(seam_quiet)
                    and seam_quiet[seam_idx])
                td = _pick_seam_dur(seam_is_quiet, declick_ms, silence_fade,
                                    silence_fade_seconds)
                if td is not None:
                    base = _seg_base_dur(seg_i, stream_durations, durations)
                    if base is not None and base > td:
                        tail_label = f"[st{seg_i}]"
                        st_out = base - td
                        parts.append(
                            f"{src}afade=t=out:st={_fmt(st_out)}:d={_fmt(td)}"
                            f"{tail_label}")
                        src = tail_label
        # 3. loudnorm
        if not loudnorm:
            return src
        parts.append(f"{src}loudnorm={LOUDNORM_FILTER}[la{audio_i}]")
        return f"[la{audio_i}]"

    n = len(segments)
    # BGM 启用 + has_audio/mix 决定段音链是否构建 (D1):
    #   bgm_active + (replace or !has_audio) → 纯 BGM, 段音链全跳过
    #   bgm_active + mix + has_audio       → 段音链照旧 + 后续 amix
    #   !bgm_active                          → 段音链照旧 (T2 既有行为)
    bgm_replace = bgm_active and (bgm_mix_mode == "replace" or not has_audio)
    build_seg_audio = has_audio and not bgm_replace
    final_audio_label = "[aout]"                          # 默认输出标签 (replace / 无 BGM)
    if bgm_active and has_audio and bgm_mix_mode == "mix":
        final_audio_label = "[aout2]"                      # mix 末轮 (amix 输出)
    audio_maps = ["-map", final_audio_label] if audio_output else []
    video_map = "[vout]"                                   # 默认视频输出标签
    if join_mode == "hard_cut":
        # loudnorm 开启:逐段响度归一 + filter concat 重编码(替代 concat copy)
        parts = []
        alabels = ""
        for i in range(n):
            f = _segf(i)
            if f:                                     # 批4 T1: 滤镜链替代 null
                parts.append(f"[{i}:v]{f}[v{i}]")
            else:
                parts.append(f"[{i}:v]null[v{i}]")
            if build_seg_audio:
                src = audio_loud(i, i, parts)
                parts.append(f"{src}anull[a{i}]")
        vlabels = "".join(f"[v{i}]" for i in range(n))
        if build_seg_audio:
            alabels = "".join(f"[a{i}]" for i in range(n))
        parts.append(f"{vlabels}concat=n={n}:v=1:a=0[vout]")
        if build_seg_audio:
            parts.append(f"{alabels}concat=n={n}:v=0:a=1[aout]")
        command = [ffmpeg_exe, "-y"] + inputs + [
            "-filter_complex", ";".join(parts), "-map", video_map] + audio_maps
    elif join_mode == "crossfade":
        video_map = f"[v{n - 1}]"
        parts = []
        for i in range(n):                            # 批4 T1: 逐段滤镜预链
            f = _segf(i)
            if f:
                parts.append(f"[{2 * i}:v]{f}[vf{i}]")

        def _vin(i):
            return f"[vf{i}]" if _segf(i) else f"[{2 * i}:v]"

        for k in range(1, n):
            left = _vin(0) if k == 1 else f"[v{k - 1}]"
            offset = sum(durations[:k]) - fade_seconds * k
            parts.append(f"{left}{_vin(k)}"
                         f"xfade=transition=fade:duration={_fmt(fade_seconds)}"
                         f":offset={_fmt(offset)}[v{k}]")
        if build_seg_audio:
            # acrossfade 是双输入滤镜, 串接 N 个输入会触发 ffmpeg 滤镜图链接失败
            # (More input link labels ... than it has inputs); 改为两两链式, 中间
            # 结果命名 [ad1]/[ad2]/..., 末轮输出 [aout]. audio_loud 在 loudnorm 关
            # 时直返当前 src 标签 (match_tail 也可能不附加, 取决于流级时长), 链式
            # 写法对两种情况都成立.
            prev = audio_loud(0, 2 * 0 + 1, parts)
            for k in range(1, n):
                src = audio_loud(k, 2 * k + 1, parts)
                dst = "[aout]" if k == n - 1 else f"[ad{k}]"
                parts.append(f"{prev}{src}acrossfade=d={_fmt(fade_seconds)}{dst}")
                prev = f"[ad{k}]"
        command = [ffmpeg_exe, "-y"] + inputs + [
            "-filter_complex", ";".join(parts),
            "-map", video_map] + audio_maps
    elif join_mode == "fade":
        parts = []
        for i, dur in enumerate(durations):
            # match_tail 开启且流级时长齐备 → afade t=out st 用裁齐后时长 (v_dur);
            # 否则维持 V1.9 容器时长基准. 视频侧 fade st 与音频侧对齐 (基准同步).
            if match_tail and build_seg_audio and stream_durations \
                    and i < len(stream_durations) \
                    and stream_durations[i][0] is not None:
                base_dur = stream_durations[i][0]
            else:
                base_dur = dur
            st_out = base_dur - fade_seconds
            f = _segf(i)                              # 批4 T1: 逐段滤镜预链
            if f:
                parts.append(f"[{2 * i}:v]{f}[vf{i}]")
            seg_in = f"[vf{i}]" if f else f"[{2 * i}:v]"
            parts.append(f"{seg_in}fade=t=in:st=0:d={_fmt(fade_seconds)},"
                         f"fade=t=out:st={_fmt(st_out)}:d={_fmt(fade_seconds)}[v{i}]")
            if build_seg_audio:
                src = audio_loud(i, 2 * i + 1, parts)
                parts.append(f"{src}afade=t=in:st=0:d={_fmt(fade_seconds)},"
                             f"afade=t=out:st={_fmt(st_out)}:d={_fmt(fade_seconds)}[a{i}]")
        vlabels = "".join(f"[v{i}]" for i in range(n))
        parts.append(f"{vlabels}concat=n={n}:v=1:a=0[vout]")
        if build_seg_audio:
            alabels = "".join(f"[a{i}]" for i in range(n))
            parts.append(f"{alabels}concat=n={n}:v=0:a=1[aout]")
        command = [ffmpeg_exe, "-y"] + inputs + [
            "-filter_complex", ";".join(parts), "-map", video_map] + audio_maps
    else:  # black
        w, h = resolution
        parts = []
        for i in range(n):
            if i == 0:
                f0 = _segf(0)                          # 批4 T1: 逐段滤镜预链
                if f0:
                    parts.append(f"[0:v]{f0}[v0]")
                else:
                    parts.append("[0:v]null[v0]")
                if build_seg_audio:
                    parts.append(f"{audio_loud(0, 1, parts)}anull[a0]")
            else:
                parts.append(f"color=black:size={w}x{h}:rate={_fmt(_fps_float(fps))}"
                             f":duration={_fmt(black_seconds)}[b{i}]")
                fi = _segf(i)
                if fi:
                    parts.append(f"[{2 * i}:v]{fi}[vf{i}]")
                seg_in = f"[vf{i}]" if fi else f"[{2 * i}:v]"
                parts.append(f"[b{i}]{seg_in}concat=n=2:v=1:a=0[v{i}]")
                if build_seg_audio:
                    src = audio_loud(i, 2 * i + 1, parts)
                    parts.append(f"{src}volume=0:enable=between(t\\,0\\,"
                                 f"{_fmt(black_seconds)})[a{i}]")
        vlabels = "".join(f"[v{i}]" for i in range(n))
        parts.append(f"{vlabels}concat=n={n}:v=1:a=0[vout]")
        if build_seg_audio:
            alabels = "".join(f"[a{i}]" for i in range(n))
            parts.append(f"{alabels}concat=n={n}:v=0:a=1[aout]")
        command = [ffmpeg_exe, "-y"] + inputs + [
            "-filter_complex", ";".join(parts), "-map", video_map] + audio_maps
    # BGM 收尾 (T3): 替换模式直接命名 BGM 归一链输出为 final_audio_label;
    # 混合模式: 段音链已产出 [aout], 接 aformat+volume → [side], 再 amix → [aout2].
    if bgm_active:
        # BGM 归一: aresample 到目标采样率 + 强制 stereo fltp (amix 协商一致).
        # 替换模式: 归一链一行直接命名 final_audio_label (避免空滤镜链
        # `[bgmn]<lbl>` 在 filter_complex 里触发 ffmpeg "No such filter: ''").
        # 混合模式: 归一链输出 [bgmn] 中间标签供 amix 输入引用.
        if bgm_replace:
            bgm_norm = (f"[{bgm_idx}:a]aresample={sample_rate},"
                        f"aformat=sample_fmts=fltp:channel_layouts=stereo"
                        f"{final_audio_label}")
        else:
            bgm_norm = (f"[{bgm_idx}:a]aresample={sample_rate},"
                        f"aformat=sample_fmts=fltp:channel_layouts=stereo[bgmn]")
        parts.append(bgm_norm)
        if not bgm_replace:
            # 混合: 段侧 aformat+volume 防协商上混不一致 + amix normalize=0 防压半
            parts.append(
                f"[aout]aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"volume={_fmt(bgm_side_volume)}[side]")
            parts.append(
                f"[bgmn][side]amix=inputs=2:duration=longest:normalize=0"
                f"{final_audio_label}")
        command = [ffmpeg_exe, "-y"] + inputs + [
            "-filter_complex", ";".join(parts), "-map", video_map] + audio_maps
    command += ["-r", _fps_arg(fps), "-pix_fmt", OUTPUT_PIX_FMT,
                "-c:v", "libx264", "-crf", DEFAULT_CRF, "-preset", DEFAULT_PRESET]
    if audio_output:
        command += ["-ar", str(sample_rate), "-c:a", "aac",
                    "-b:a", DEFAULT_AUDIO_BITRATE]
    # T3: BGM 启用时输出侧显式 -t (置于 out_path 之前; 短于画面 = 替换末尾静音/
    # 混合仅剩段音, 不报错不写 manifest 字段, 仅引擎控制台一行日志)
    if bgm_active and total_duration is not None and total_duration > 0:
        command += ["-t", _fmt(total_duration)]
    command.append(out_path)
    return {"command": command, "extra_inputs": []}


def compose_join(segments, out_path, join_mode=DEFAULT_JOIN_MODE,
                 loudnorm=DEFAULT_LOUDNORM, explicit_stream_copy=False,
                 crossfade_frames=DEFAULT_CROSSFADE_FRAMES,
                 black_seconds=DEFAULT_BLACK_SECONDS,
                 ffmpeg_exe="ffmpeg", ffprobe_exe="ffprobe",
                 stream_copy_listfile=None,
                 match_tail=True, match_tail_tolerance_ms=5,
                 declick_ms=DEFAULT_DECLICK_MS,
                 silence_fade=DEFAULT_SILENCE_FADE,
                 silence_fade_seconds=DEFAULT_SILENCE_FADE_SECONDS,
                 silence_threshold_db=DEFAULT_SILENCE_THRESHOLD_DB,
                 silence_probe_seconds=DEFAULT_SILENCE_PROBE_SECONDS,
                 # V1.10 批 1 T3 BGM 通道 (D1)
                 bgm_path=None, bgm_mix_mode=DEFAULT_BGM_MIX_MODE,
                 bgm_sample_rate=None, bgm_side_volume=DEFAULT_BGM_SIDE_VOLUME,
                 # 批 4 T1 D 色彩对齐滤镜入链
                 force_filter=False, seg_filters=None):
    """探测 + 构造一步到位 (batch_core._concat_videos 接入入口)。

    首段 ffprobe 探测注入 fps/采样率/分辨率/音轨状态; crossfade/fade 逐段补探测
    duration (xfade offset 需要)。全关退路不探测直接流复制。非法模式/探测失败/
    参数缺失 raise JoinError (调用方回落 V1.8 流复制)。

    V1.10 批 1 T1 (D2 match_tail): match_tail=True 时所有模式逐段探测 (含
    hard_cut / black), 收集 stream-level video_duration/audio_duration 注入
    build_join_command 做音画对齐 (atrim/apad); match_tail=False 时退回 V1.9
    探测策略 (crossfade/fade 全段, hard_cut/black 仅首段)。

    V1.10 批 1 T2 (D3 hard_cut 缝点): needs_stream_durations 扩为 "三件套任一开"
    (match_tail / declick_ms / silence_fade). silence_fade 开 + hard_cut + 有音
    频 → 每缝点探测两侧 RMS (2*(N-1) 次 astats 子进程), 注入 seam_quiet; 探测
    失败按 fail-safe 非安静处理 (silence_fade 覆盖 declick).

    返回 {"command", "extra_inputs", "mode"(实际生效模式或 "stream_copy"),
    "probe"(首段探测 dict 或 None)}。

    V1.10 批 1 T3 (D1 BGM 通道):
    - bgm_path 非空时启用 BGM 通道 (BGM 预检由 _concat_videos 在调用前完成, 这里
      仅消费 bgm_sample_rate 用于 has_audio=0 组合); BGM 启用时强制走滤镜链, 即便
      explicit_stream_copy=True 也忽略 (流复制无法加 BGM 处理).
    - 探测策略扩: bgm_active + join_mode != "crossfade" → 触发 stream_durations
      探测 (用于 total_duration 计算).
    - total_duration 计算: hard_cut/fade = sum(video_duration); crossfade =
      sum(container_duration) − fade×(n−1); black = sum(video_duration) +
      black_seconds×(n−1).
    - 任何探测失败/参数缺失 raise JoinError (BGM 启用时 _concat_videos 不再降级
      流复制, 错误透传到 manifest._concat.error).

    批 4 T1 D (色彩对齐滤镜入链): force_filter (照 BGM 禁流复制先例) +
    seg_filters (逐段视频滤镜串, 注入 build_join_command 各模式段视频源链最前)
    透传; 两者任一激活时不走流复制早退路。默认 False/None 时行为与既有现状
    逐字符一致 (D5 持久基线延伸)。
    """
    if not segments:
        raise JoinError("段列表为空:至少需要 1 个段")
    try:
        _validate_join_mode(join_mode)
    except ValueError as e:
        raise JoinError(str(e))
    bgm_active = bool(bgm_path)
    # 流复制早退路 (T2 + T3 + 批4 T1 互斥): seam 处理开 OR BGM 启用 OR 滤镜
    # 入链/强制滤镜 → 必须走滤镜链.
    seam_off = (declick_ms is None and not silence_fade)
    filters_active = bool(seg_filters and any(seg_filters))
    if (join_mode == "hard_cut" and not loudnorm and explicit_stream_copy
            and seam_off and not bgm_active
            and not force_filter and not filters_active):
        res = build_join_command(list(segments), join_mode, out_path,
                                 fps=None, sample_rate=None, loudnorm=False,
                                 explicit_stream_copy=True,
                                 ffmpeg_exe=ffmpeg_exe,
                                 stream_copy_listfile=stream_copy_listfile,
                                 match_tail=match_tail,
                                 match_tail_tolerance_ms=match_tail_tolerance_ms,
                                 stream_durations=None,
                                 declick_ms=declick_ms,
                                 silence_fade=silence_fade,
                                 silence_fade_seconds=silence_fade_seconds,
                                 silence_threshold_db=silence_threshold_db,
                                 silence_probe_seconds=silence_probe_seconds,
                                 seam_quiet=None,
                                 bgm_path=bgm_path,
                                 bgm_mix_mode=bgm_mix_mode,
                                 bgm_side_volume=bgm_side_volume,
                                 total_duration=None)
        return {"command": res["command"], "extra_inputs": res["extra_inputs"],
                "mode": "stream_copy", "probe": None}
    first = probe_segment(segments[0], ffprobe_exe=ffprobe_exe)
    has_audio = first["has_audio"]
    # 探测策略: crossfade/fade 需要容器 duration; 三件套任一开 → 流级时长 (T2 扩);
    # T3: BGM 启用 + 非 crossfade 模式 → 需要 video_duration 算 total_duration.
    needs_container_durations = join_mode in ("crossfade", "fade")
    needs_stream_durations = (match_tail or declick_ms is not None
                               or silence_fade
                               or (bgm_active and join_mode != "crossfade"))
    stream_durations = None
    durations = None
    if needs_container_durations or needs_stream_durations:
        probes = [first]
        for seg in segments[1:]:
            probes.append(probe_segment(seg, ffprobe_exe=ffprobe_exe))
        if needs_container_durations:
            durations = [p["duration"] for p in probes]
        if needs_stream_durations:
            stream_durations = [(p["video_duration"], p["audio_duration"])
                                for p in probes]
    # T2 seam afade 安静判定: 仅 hard_cut + has_audio + silence_fade 才跑 RMS.
    seam_quiet = None
    if (join_mode == "hard_cut" and has_audio and silence_fade
            and len(segments) >= 2):
        seam_quiet = []
        win = silence_probe_seconds
        n = len(segments)
        for i in range(n - 1):
            # Tail of seg_i at v_dur - win; head of seg_i+1 at 0.
            v_dur_i = (stream_durations[i][0]
                       if (stream_durations and i < len(stream_durations))
                       else None)
            v_dur_next = (stream_durations[i + 1][0]
                          if (stream_durations
                              and i + 1 < len(stream_durations))
                          else None)
            tail_rms = None
            if v_dur_i is not None and v_dur_i > win:
                tail_rms = _probe_segment_rms(segments[i], v_dur_i - win, win,
                                              ffmpeg_exe=ffmpeg_exe)
            head_rms = _probe_segment_rms(segments[i + 1], 0.0, win,
                                          ffmpeg_exe=ffmpeg_exe)
            tail_q = (tail_rms is not None
                      and tail_rms < silence_threshold_db)
            head_q = (head_rms is not None
                      and head_rms < silence_threshold_db)
            # 缝点安静 = 两侧 RMS 均 < 阈值; 失败按 loud (覆盖 declick).
            seam_quiet.append(tail_q and head_q)
    # T3 BGM 启用时, has_audio=False → sample_rate 由 BGM 预检注入 (D1).
    effective_sample_rate = first["sample_rate"]
    if not has_audio and bgm_active and bgm_sample_rate is not None:
        effective_sample_rate = bgm_sample_rate
    # T3 BGM total_duration 计算 (D1):
    #   hard_cut/fade = sum(video_duration); crossfade = sum(container) − fade×(n−1);
    #   black = sum(video_duration) + black_seconds × (n−1).
    total_duration = None
    if bgm_active:
        n = len(segments)
        if join_mode == "crossfade":
            if not durations or any(d is None or d <= 0 for d in durations):
                raise JoinError("BGM + crossfade 需要有效 durations")
            # fade_seconds = crossfade_frames / fps (与 build_join_command 同源)
            fade_for_total = crossfade_frames / _fps_float(first["fps"])
            total_duration = sum(durations) - fade_for_total * (n - 1)
        elif join_mode in ("hard_cut", "fade"):
            if not stream_durations:
                raise JoinError("BGM + %s 需要 stream_durations (video_duration)"
                                % join_mode)
            v_durs = [vd[0] for vd in stream_durations if vd[0] is not None]
            if len(v_durs) != n:
                raise JoinError("BGM + %s: 部分段 video_duration 缺失" % join_mode)
            total_duration = sum(v_durs)
        elif join_mode == "black":
            if not stream_durations:
                raise JoinError("BGM + black 需要 stream_durations (video_duration)")
            v_durs = [vd[0] for vd in stream_durations if vd[0] is not None]
            if len(v_durs) != n:
                raise JoinError("BGM + black: 部分段 video_duration 缺失")
            total_duration = sum(v_durs) + black_seconds * (n - 1)
    res = build_join_command(
        list(segments), join_mode, out_path,
        fps=first["fps"], sample_rate=effective_sample_rate,
        durations=durations,
        resolution=(first["width"], first["height"])
        if first["width"] and first["height"] else None,
        has_audio=has_audio,
        crossfade_frames=crossfade_frames, black_seconds=black_seconds,
        loudnorm=loudnorm, explicit_stream_copy=explicit_stream_copy,
        ffmpeg_exe=ffmpeg_exe, stream_copy_listfile=stream_copy_listfile,
        match_tail=match_tail,
        match_tail_tolerance_ms=match_tail_tolerance_ms,
        stream_durations=stream_durations,
        declick_ms=declick_ms, silence_fade=silence_fade,
        silence_fade_seconds=silence_fade_seconds,
        silence_threshold_db=silence_threshold_db,
        silence_probe_seconds=silence_probe_seconds,
        seam_quiet=seam_quiet,
        bgm_path=bgm_path, bgm_mix_mode=bgm_mix_mode,
        bgm_side_volume=bgm_side_volume, total_duration=total_duration,
        force_filter=force_filter, seg_filters=seg_filters)
    return {"command": res["command"], "extra_inputs": res["extra_inputs"],
            "mode": join_mode, "probe": first}
