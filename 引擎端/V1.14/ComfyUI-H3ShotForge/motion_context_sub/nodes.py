"""H3 长视频 latent 续接 4 节点(机制自研,口径见 docs/latent_continuation_study.md)。

H3MotionContext
    把上一段尾部 latent 原样切片(视频步序列 + 音频尾部),以
    resolved_frame_index=0 的 keyframe 形式交给 stock 校验,真实像素坐标挂
    MC_KEY,由 patch_layout 重写到时间轴上;音频窗口 END 与钉住视频对齐,
    overhang 补偿 + 网格取整都在本节点完成(决策记录 §7.2)。
    编码模式固定:context_latent 优先,无 latent 时像素路径一次 vae.encode
    (video 模式,把 batch 轴当时间压缩,勿逐帧编码)。

H3MotionContextTrim
    解码后裁掉钉住头部,画面和声音同步裁;match_tail 把音频尾部截到与
    剩余帧数严格等长,消除每段 ~8.3ms 的音频 overhang 累积漂移。

H3MotionContextSaveLatent / H3MotionContextLoadLatent
    AV latent 双流落盘/读回。Save 假定 streams[0]=video、[1]=audio;
    Load 返回普通 list(非 NestedTensor),只能被 context_latent 接受,
    防误接 VAE 解码。clip_index>0 固定槽位(重跑覆盖自己),0 走 auto
    编号(尾下划线,加载器排除)。
"""

import logging
import math
import os

import torch

import comfy.utils
import folder_paths
import node_helpers
from safetensors.torch import load_file, save_file

from . import patch_layout as _layout_patch
from . import patch_payload as _payload_patch

try:
    import torchaudio
except ImportError:  # 仅 context_audio 非 32kHz 重采样时需要
    torchaudio = None

# [探针改造] 原 `from h3_engine import segment_grid` 依赖已裁剪:移植为独立
# custom node 子包时只用到 validate_context_window 一个纯函数,内联如下
# (语义照抄 h3_engine/segment_grid.py,窗口集合 LATENT/PIXEL_WINDOWS)。
_LATENT_WINDOWS = (5, 22, 39)
_PIXEL_WINDOWS = (5, 22, 39, 56)


def _validate_context_window(n, path="latent"):
    """上下文窗口校验:latent 路径仅 5/22/39;像素路径另含 56。"""
    if path == "pixels":
        if n not in _PIXEL_WINDOWS:
            raise ValueError(
                "非法上下文窗口 %s:像素路径仅允许 %s" % (n, _PIXEL_WINDOWS))
        return n
    if n not in _LATENT_WINDOWS:
        if n == 56:
            raise ValueError(
                "非法上下文窗口 56:latent 路径仅允许 %s,56 仅像素路径"
                % (_LATENT_WINDOWS,))
        raise ValueError(
            "非法上下文窗口 %s:latent 路径仅允许 %s" % (n, _LATENT_WINDOWS))
    return n

_LOG = logging.getLogger("h3_motion_context")

FPS = 24  # H3 原生帧率;音频 latent 40Hz,故 FRAME_RESCALE = 5/3
AUDIO_HZ = 40
FRAME_RESCALE = 5.0 / 3.0
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)  # 每 latent 步覆盖的像素帧数,按 5 循环

# 视频 VAE 能区分的运行长度网格(17m+5 向下):编码 N 帧产出的步数覆盖的是
# 输入前 `covered` 帧而非后 N 帧,网格外的请求必须先向下吸附,否则钉住内容
# 会比坐标早结束 5+ 帧,接缝跳变。像素路径只提供到 56,但吸附逻辑认识
# 更高网格点,越界请求落到最近的真实点而非被钳到 39。
VIDEO_RUN_GRID = (124, 107, 90, 73, 56, 39, 22, 5, 1)


def _pixel_frames(latent_t):
    """latent_t 步覆盖的像素帧数。"""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(latent_t))


def _step_offsets(latent_t):
    """每步的像素帧起点,步序列与全新编码同相位时可直接复用。"""
    out, acc = [], 0
    for k in range(latent_t):
        out.append(acc)
        acc += FRAME_PER_TOKEN[k % 5]
    return out


def _steps_for_frames(n):
    """恰好覆盖 n 像素帧的步数;无整步数时返回 None。"""
    k, covered = 0, 0
    while covered < n:
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    return k if covered == n else None


def _ensure_layout_patch():
    """首次运行节点时安装布局 patch;失败即响亮报错,不静默降级。"""
    if _layout_patch.is_applied():
        return
    if not _layout_patch.apply_patch():
        raise RuntimeError(
            "h3_motion_context: 布局 patch 未能安装,中间帧锚点会被 stock "
            "拒绝,链式续接不可用。原因见上方日志。")


def _ensure_payload_patch():
    """有音频续接时才需要:refs 覆盖 keyframes 的 bug 只有音频 ref 会触发。"""
    if _payload_patch.is_applied():
        return
    if not _payload_patch.apply_patch():
        raise RuntimeError(
            "h3_motion_context: payload patch 未能安装,音频 ref 会覆盖钉住"
            "的视频 latent,motion context 丢失。原因见上方日志。")


def _streams_from_latent(latent):
    """解包 H3 AV latent 的流列表。

    NestedTensor.__getitem__ 会广播索引到内部每个张量,samples[0] 会把两流
    各自剥掉 batch 维;正确解包用 unbind()。普通 list/tuple 原样返回。
    """
    samples = latent["samples"]
    if hasattr(samples, "unbind"):
        return list(samples.unbind())
    if isinstance(samples, (tuple, list)):
        return list(samples)
    raise ValueError(
        "h3_motion_context: 需要 H3 AV latent(video/audio 双流),得到 %r"
        % type(samples))


def _video_from_latent(latent):
    """取出视频流并归一为 [B, 24, T, H, W]。"""
    video = _streams_from_latent(latent)[0]
    if video.ndim == 4:  # 未加 batch [C,T,H,W]
        video = video.unsqueeze(0)
    if video.ndim != 5:
        raise ValueError(
            "h3_motion_context: 期望视频 latent [B,C,T,H,W],得到 %s"
            % (tuple(video.shape),))
    return video


def _resize_frames(frames, width, height):
    """像素帧 [B,H,W,C] -> [B,height,width,3],与 stock 同款 lanczos。"""
    samples = frames[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos",
                                         "disabled")
    return samples.movedim(1, -1)


def _video_tail_from_latent(latent, n):
    """从 latent 尾部切出恰好 n 像素帧的步序列(blocks, offsets, covered)。

    切点必须落在循环相位 0(start % 5 == 0):段长 17g+5 ↔ 步数 5g+2,减去
    窗口 2/7/12 步恒为 5 的倍数,正常段天然满足;仍用 assert 断言而非假设
    (研究 §3.2),万一不再成立,切片相位与坐标不符会静默错位接缝。
    """
    video = _video_from_latent(latent)
    total = int(video.shape[2])
    steps = _steps_for_frames(n)
    if steps is None:
        raise ValueError(
            "h3_motion_context: %d 帧窗口不是整步数,无法从 latent 切片。"
            "latent 路径仅支持 %s 帧,或改接 context_frames 走像素降级。"
            % (n, "5/22/39"))
    if steps > total:
        raise ValueError(
            "h3_motion_context: 需要 %d latent 步,context_latent 只有 %d 步。"
            % (steps, total))
    start = total - steps
    assert start % 5 == 0, (
        "h3_motion_context: %d 步尾窗起点落在循环相位 %d 而非 0,切片步序列"
        "与全新编码不同相位,_step_offsets 不能复用。拒绝继续。"
        % (steps, start % 5))
    blocks = [video[:1, :, start + k:start + k + 1].clone()
              for k in range(steps)]
    return blocks, _step_offsets(steps), _pixel_frames(steps)


def _encode_tail_audio(audio_vae, audio, seconds):
    """用 H3 音频 VAE 编码 context_audio 的尾部,返回 (latent, ref_audio_t)。

    ref_audio_t 以 40Hz latent 步计数,与布局的 ref_audio_t 同单位。
    """
    waveform = audio["waveform"]  # [B, C, L]
    sr = int(audio["sample_rate"])
    vae_sr = int(getattr(audio_vae, "audio_sample_rate", 32000))
    if sr != vae_sr:
        if torchaudio is None:
            raise RuntimeError(
                "h3_motion_context: context_audio 是 %d Hz,音频 VAE 要 %d Hz,"
                "且 torchaudio 不可用,无法重采样。" % (sr, vae_sr))
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    want = int(round(seconds * vae_sr))
    have = int(waveform.shape[-1])
    if have < want:
        _LOG.warning("h3_motion_context: context_audio 只有 %.3fs,短于钉住"
                     "视频 %.3fs,有多少钉多少。", have / vae_sr, seconds)
    else:
        waveform = waveform[..., have - want:]
    z = audio_vae.encode(waveform[:1].movedim(1, -1))  # [1, 32, 2, T]
    return z, int(z.shape[-1])


def _audio_tail_from_latent(latent, a_frames):
    """从 latent 切出尾部音频,返回 (latent, rt, overhang)。

    overhang 是音频网格越过最后像素帧的零头:124 帧想要 206.67 步,布局
    round 到 207,尾步超出末帧 ~1/3 步 ≈ 8.3ms。解码路径由 match_tail 裁掉,
    本路径必须补偿回坐标(研究 §2.7)。正常段 0 <= overhang < 1,越界即异常
    网格,警告并按 0 处理。
    """
    parts = _streams_from_latent(latent)
    if len(parts) < 2:
        raise ValueError(
            "h3_motion_context: context_latent 无音频 stream。链中段音乐"
            "强制开启,请接 H3 AV 图(含音频)的采样输出。")
    audio = parts[1]
    if audio.ndim == 3:  # 未加 batch [C,2,T]
        audio = audio.unsqueeze(0)
    if audio.ndim != 4:
        raise ValueError(
            "h3_motion_context: 期望音频 latent [B,C,2,T],得到 %s"
            % (tuple(audio.shape),))
    total_t = int(audio.shape[-1])
    frames = _pixel_frames(int(_video_from_latent(latent).shape[2]))
    overhang = total_t - FRAME_RESCALE * frames
    if not (0.0 <= overhang < 1.0):
        _LOG.warning("h3_motion_context: context_latent 音频网格异常(%d 步对 "
                     "%d 帧),按无 overhang 处理。", total_t, frames)
        overhang = 0.0
    rt = int(round(a_frames / float(FPS) * AUDIO_HZ))
    if rt > total_t:
        _LOG.warning("h3_motion_context: 要 %d 音频步,latent 只有 %d,"
                     "全部钉上。", rt, total_t)
        rt = total_t
    if rt < 1:
        raise ValueError("h3_motion_context: 音频窗口为空")
    tail = audio[:1, ..., total_t - rt:].clone()
    return tail, rt, float(overhang)


def _audio_taper_weights(rt, steps):
    """旧端(切片首位)0.0 → 贴缝端 1.0 的半余弦渐释权重; 0/None → None (不施加)。

    仅首位 k=min(steps,rt) 步内变化, 其余恒 1.0 (滑窗不衰减到整窗)。权重
    作用于 [B,C,2,T] 的 dim=-1, 两通道同权。
    """
    k = min(int(steps or 0), rt)
    if k <= 1:
        return None
    w = [1.0] * rt
    for i in range(k):
        w[i] = 0.5 * (1.0 - math.cos(math.pi * i / (k - 1)))
    return w


class H3MotionContext:
    """把上一段尾部钉到本段开头:latent 原样切片,坐标由 patch_layout 重写。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "latent": ("LATENT",),
                "context_length": (["22", "5", "39", "56"], {
                    "default": "22",
                    "tooltip": "钉住的上一段画面帧数。只有这些长度是整步数,"
                               "故只提供这些。5 勉强有动感,22 接近无缝;"
                               "56 ≈2.3s 钉住内容会占 124 帧段近半,"
                               "仅像素路径可用。"}),
                "audio_context_length": ("INT", {
                    "default": 22, "min": -1, "max": 240,
                    "tooltip": "钉住的尾部音频帧数,独立于画面窗口。"
                               "0 = 跟随画面窗口;-1 = 关闭音频继承"
                               "(画面续接保留)。窗口 END 与钉住视频对齐。"}),
                "audio_taper_steps": ("INT", {
                    "default": 0, "min": 0, "max": 240,
                    "tooltip": "音频参考旧端半余弦渐释步数·0=不施加。"}),
            },
            "optional": {
                "context_frames": ("IMAGE", {
                    "tooltip": "上一段的解码帧。未接 context_latent 时用,"
                               "尾部一次 VAE encode 后钉上。"}),
                "context_latent": ("LATENT", {
                    "tooltip": "上一段采样输出 latent(与接解码节点的是同一个),"
                               "画面和声音都从它切片,跳过解码-重编码损耗。"
                               "分辨率必须与本段一致。"}),
                "audio_vae": ("VAE", {
                    "tooltip": "H3 音频 VAE。context_audio 参照编码用;"
                               "context_audio 接线时必接,否则回落到 context_latent 切片。"}),
                "context_audio": ("AUDIO", {
                    "tooltip": "上一段的解码音频,尾部编码后与画面一起钉上。"
                               "context_audio+audio_vae 均接线时音频参照优先"
                               "（挑段参照模式）；否则按 context_latent 切片。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "INT")
    RETURN_NAMES = ("conditioning", "trim_frames")
    FUNCTION = "apply"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("把上一段连续帧作为不降噪条件行钉到本段开头,模型读到"
                   "真实运动而非从单帧猜。context_latent 接线时画面和声音"
                   "都从 latent 切片,跳过解码与重编码。")

    def apply(self, conditioning, vae, latent, context_length,
              audio_context_length=22, context_frames=None,
              context_latent=None, audio_vae=None, context_audio=None,
              audio_taper_steps=0):
        _ensure_layout_patch()
        context_length = int(context_length)

        video = _video_from_latent(latent)
        latent_t = int(video.shape[2])
        width = int(video.shape[4]) * 16
        height = int(video.shape[3]) * 16
        frame_count = _pixel_frames(latent_t)

        # 先定画面来源:它决定可钉帧数。latent 路径跳过 h264 解码与 VAE
        # 编码,块与模型产出 bit 一致;像素路径只在无 latent 时用。
        if context_latent is not None:
            _validate_context_window(context_length, "latent")
            src = _video_from_latent(context_latent)
            src_w, src_h = int(src.shape[4]) * 16, int(src.shape[3]) * 16
            if src_w != width or src_h != height:
                raise ValueError(
                    "h3_motion_context: context_latent 是 %dx%d,本段是 %dx%d。"
                    "latent 不可 resize,上一段必须按本分辨率重生成,或从"
                    "本段重开链。" % (src_w, src_h, width, height))
            if int(src.shape[1]) != int(video.shape[1]):
                raise ValueError(
                    "h3_motion_context: context_latent 有 %d 通道,本段 %d,"
                    "不是同一模型的 H3 视频 latent。"
                    % (int(src.shape[1]), int(video.shape[1])))
            available = _pixel_frames(int(src.shape[2]))
        else:
            if context_frames is None:
                raise ValueError(
                    "h3_motion_context: 没有可钉的内容,请接 context_latent"
                    "(优先)或 context_frames。")
            _validate_context_window(context_length, "pixels")
            available = int(context_frames.shape[0])

        n = min(context_length, available)
        if n < 1:
            raise ValueError("h3_motion_context: 没有可钉的帧")
        if n < context_length:
            _LOG.warning("h3_motion_context: 只有 %d 帧可钉,实际钉 %d。",
                         available, n)

        if context_latent is None:
            # 像素路径必须先吸附到 VAE 网格再切片:编码 N 帧的步数覆盖的是
            # 输入前 `covered` 帧,不吸附会钉一段提前结束的内容
            snapped = next(g for g in VIDEO_RUN_GRID if g <= n)
            if snapped != n:
                _LOG.warning("h3_motion_context: %d 帧不在 VAE 网格上,改钉"
                             "最后 %d 帧(可用:5/22/39/56)。", n, snapped)
                n = snapped

        if n >= frame_count:
            raise ValueError(
                "h3_motion_context: 要把 %d 帧钉进 %d 帧的段,钉住部分必须"
                "是时间线的小比例。" % (n, frame_count))

        if context_latent is not None:
            blocks, offsets, span = _video_tail_from_latent(context_latent, n)
        else:
            # 一次 encode:VAE 把 batch 轴当时间压缩,运动留在 latent 内部,
            # 而不是跨多张静帧由模型去猜
            tail = _resize_frames(context_frames[available - n:], width, height)
            enc = vae.encode(tail)
            if getattr(enc, "ndim", 0) != 5:
                raise ValueError(
                    "h3_motion_context: 像素编码返回 %s,期望 [B,C,T,H,W]。"
                    % (tuple(getattr(enc, "shape", ())),))
            steps = int(enc.shape[2])
            offsets = _step_offsets(steps)
            span = _pixel_frames(steps)
            if span != n:
                # n 已吸附到网格,不匹配说明 VAE 降采样公式变了
                raise RuntimeError(
                    "h3_motion_context: %d 帧编码成 %d 步覆盖 %d 帧,VAE 网格"
                    "与 VIDEO_RUN_GRID 不再一致,拒绝运行。"
                    % (n, steps, span))
            blocks = [enc[:, :, k:k + 1] for k in range(steps)]

        keyframes = [{
            # stock 只认 0 或 frame_count-1;真实坐标挂在 MC_KEY 上由
            # patch_layout 重写,这里恒写 0 保证合法
            "resolved_frame_index": 0,
            _layout_patch.MC_KEY: p,
            "latent": blk,
        } for p, blk in zip(offsets, blocks)]

        values = {
            "minimax_keyframes": keyframes,
            "minimax_frame_count": frame_count,
        }

        audio_ref = None
        a_frames = int(audio_context_length)
        # -1 = 关闭音频继承: 不组装 audio ref, 视频续接锚原样保留
        if a_frames >= 0 and (
                context_latent is not None
                or (context_audio is not None and audio_vae is not None)):
            _ensure_payload_patch()
            # 音频窗口独立于画面:音频条件行只费行数,不费交付帧
            a_frames = a_frames or span
            if context_audio is not None and audio_vae is not None:
                # 分轨参照路径: 解码音频优先于 latent 切片。KEY=0 让参照块
                # 留在 stock 槽位(平移量 0);参照非时间连续,无 overhang 补偿。
                audio_latent, ref_audio_t = _encode_tail_audio(
                    audio_vae, context_audio, a_frames / float(FPS))
                audio_end = 0
            else:
                # 现行 latent 切片 (总关路径逐字节不变)
                audio_latent, ref_audio_t, overhang = _audio_tail_from_latent(
                    context_latent, a_frames)
                # overhang 补偿 + 网格取整(决策记录 §7.2,数值在节点侧):
                # 钉住音频与钉住视频同源同尾,必须落在新时间轴同一时刻
                # (head 模式下 end = span)。latent 切片的内容实际延伸到
                # 末帧后 overhang/40s,坐标加 overhang/FRAME_RESCALE;再把
                # END 坐标吸到目标音频自己的整数网格,消除恒定 ~8.3ms 偏移。
                end_frame = float(span) + overhang / FRAME_RESCALE
                end_coord = round(FRAME_RESCALE * end_frame)
                audio_end = end_coord / FRAME_RESCALE
            w = _audio_taper_weights(ref_audio_t, audio_taper_steps)
            if w is not None:
                audio_latent = audio_latent * audio_latent.new_tensor(w)
            ref = {
                "kind": "audio",
                "ref_audio_t": ref_audio_t,
                "audio_latent": audio_latent,
            }
            ref[_layout_patch.MC_AUDIO_KEY] = audio_end
            audio_ref = ref

        out = node_helpers.conditioning_set_values(conditioning, values)
        if audio_ref is not None:
            # append:REF2V 的 conditioning 已带自己的参考块,直接赋值
            # minimax_refs 会把它们全换掉
            out = node_helpers.conditioning_set_values(
                out, {"minimax_refs": [audio_ref]}, append=True)

        _LOG.info("h3_motion_context: %s/%s, %d 帧 -> %d cond 块, %d 帧段 "
                  "@%dx%d, trim %d, 音频 %s",
                  "latent" if context_latent is not None else "pixels",
                  "video", n, len(blocks), frame_count, width, height, span,
                  ("%d 帧 -> %d 步(%.3fs)"
                   % (a_frames, ref_audio_t, ref_audio_t / AUDIO_HZ))
                  if audio_ref is not None else "off")
        return (out, span)


class H3MotionContextTrim:
    """解码后裁掉钉住头部,画面与声音同步;match_tail 消除尾部漂移。

    只裁画面不裁声音,声音整段超前画面 trim_frames/24 秒;只裁头不裁尾,
    每段多出的 ~8.3ms 音频会沿链累积。两者一起处理才保证拼接严格同步。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "trim_frames": ("INT", {"default": 0, "min": 0, "max": 4096}),
            },
            "optional": {
                "audio": ("AUDIO", {
                    "tooltip": "同一段的解码音频,按相同时长同步裁。"
                               "无声片段可不接。"}),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001,
                    "tooltip": "裁头时长换算用帧率,须与成片帧率一致。"}),
                "match_tail": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "把音频尾部截到与剩余帧数严格等长。H3 音频"
                               "网格向上取整,每段多 ~8.3ms,沿链累积。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "trim"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("裁掉解码片段开头的钉住帧,画面和声音按相同时长同步裁;"
                   "match_tail 把音频尾部对齐到帧界。")

    def trim(self, images, trim_frames, audio=None, fps=24.0, match_tail=True):
        n = max(0, int(trim_frames))
        total = int(images.shape[0])
        if n >= total:
            raise ValueError(
                "h3_motion_context: 要从 %d 帧的片段裁掉 %d 帧。"
                % (total, n))
        out_images = images[n:] if n else images

        out_audio = audio
        if audio is not None:
            waveform = audio["waveform"]
            sr = int(audio["sample_rate"])
            cut = int(round(n / float(fps) * sr))
            length = int(waveform.shape[-1])
            if cut >= length:
                raise ValueError(
                    "h3_motion_context: 裁 %.3fs 会裁空音频(共 %.3fs),"
                    "检查 fps 是否与成片一致。"
                    % (n / float(fps), length / sr))
            waveform = waveform[..., cut:]

            if match_tail:
                frames_left = total - n
                want = int(round(frames_left / float(fps) * sr))
                have = int(waveform.shape[-1])
                if have > want:
                    _LOG.info("h3_motion_context: 尾部截掉 %d 样本(%.2fms),"
                              "音频与 %d 帧精确对齐。", have - want,
                              (have - want) / sr * 1000.0, frames_left)
                    waveform = waveform[..., :want]
                elif have < want:
                    # 波形无法无损补长,只警告不补
                    _LOG.warning("h3_motion_context: 音频比 %d 帧短 %.2fms,"
                                 "尾部不补。", frames_left,
                                 (want - have) / sr * 1000.0)

            out_audio = {"waveform": waveform, "sample_rate": sr}
            _LOG.info("h3_motion_context: 裁头 %d 帧,剩 %d 帧 / %.4fs 画面,"
                      "%.4fs 声音。", n, total - n, (total - n) / float(fps),
                      int(waveform.shape[-1]) / sr)
        elif n:
            _LOG.warning("h3_motion_context: 裁掉 %d 帧但 audio 未接,声音将"
                         "超前画面 %.3f 秒,请把音频接到本节点。",
                         n, n / float(fps))

        return (out_images, out_audio)


def _resolve_latent_path(path, clip_index=0):
    """把加载器路径输入解析成具体文件。

    接受绝对路径、相对 ComfyUI 输出目录的路径,或两者任一形式的目录。
    目录模式:
      clip_index == 0   取目录里最新的 .safetensors,但排除尾下划线 auto
                        文件——auto 编号按运行次数计数,可能是 reject。
      clip_index  > 0   精确取该 clip 的固定槽位 *_%05d.safetensors;
                        auto 文件存在时给出"重命名去尾下划线"提示。
    """
    p = (path or "").strip().strip('"').strip("'")
    if not p:
        p = "h3_context"
    for c in (p, os.path.join(folder_paths.get_output_directory(), p)):
        if os.path.isfile(c):
            return c
        if os.path.isdir(c):
            idx = int(clip_index)
            if idx > 0:
                files = [os.path.join(c, f) for f in os.listdir(c)
                         if f.endswith("_%05d.safetensors" % idx)]
                if not files:
                    near = [os.path.join(c, f) for f in os.listdir(c)
                            if f.endswith("_%05d_.safetensors" % idx)]
                    hint = ""
                    if near:
                        hint = (" 找到 %s,那是 auto 编号保存(尾下划线 = 按"
                                "运行次数编号,可能是 reject)。确认它就是"
                                "clip %d 时,重命名去掉尾下划线:%s"
                                % (near[0], idx,
                                   near[0].replace("_%05d_" % idx,
                                                   "_%05d" % idx)))
                    raise FileNotFoundError(
                        "h3_motion_context: %s 里没有 clip %d 的槽位"
                        "(*_%05d.safetensors)。%s" % (c, idx, idx, hint))
            else:
                files = [os.path.join(c, f) for f in os.listdir(c)
                         if f.endswith(".safetensors")
                         and not f.endswith("_.safetensors")]
                if not files:
                    raise FileNotFoundError(
                        "h3_motion_context: %s 里没有已保存的 latent,"
                        "先用带 Save Latent 节点的段跑一遍。" % c)
            return max(files, key=os.path.getmtime)
    raise FileNotFoundError(
        "h3_motion_context: %r 既不是文件也不是目录(也试过相对 ComfyUI "
        "输出目录)。" % p)


class H3MotionContextSaveLatent:
    """把段采样 latent 落盘,供下一段加载。

    Stock Save/Load Latent 序列化不了 H3 的 video/audio 双流,这里两键并排
    存成 safetensors。clip_index>0 固定槽位:重跑本段覆盖自己的 reject,
    不堆文件也不污染下游;0 走 auto 编号(尾下划线),加载器故意排除。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT", {
                    "tooltip": "采样输出 latent(与接解码节点的是同一个)。"}),
                "filename_prefix": ("STRING", {
                    "default": "h3_context/clip",
                    "tooltip": "存到 ComfyUI 输出目录下。默认把所有链 latent "
                               "收在一个目录,Load 节点总能取到。"}),
                "clip_index": ("INT", {
                    "default": 0, "min": 0, "max": 9999,
                    "tooltip": "本段在链中的序号:重跑覆盖自己的 reject。"
                               "0 = 每次运行新编号文件(编号按运行次数)。"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("latent_path",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("保存 H3 AV latent(video/audio 双流),供下一段的 "
                   "Motion Context 从它钉画面和声音。")

    def save(self, latent, filename_prefix, clip_index=0):
        parts = _streams_from_latent(latent)
        if len(parts) < 2:
            raise ValueError(
                "h3_motion_context: latent 无音频 stream,无法保存。链中段"
                "音乐强制开启,请用含音频的 H3 AV 图采样输出。")
        video = parts[0].cpu().contiguous()
        audio = parts[1].cpu().contiguous()
        folder, filename, counter, _, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory())
        if int(clip_index) > 0:
            # 固定槽位:clip 2 -> *_00002.safetensors,重跑覆盖自己的 reject
            path = os.path.join(folder, "%s_%05d.safetensors"
                                % (filename, int(clip_index)))
        else:
            # auto:尾下划线区分于槽位文件,加载器按槽位取时不会命中
            path = os.path.join(folder, "%s_%05d_.safetensors"
                                % (filename, counter))
        save_file({"video": video, "audio": audio}, path,
                  metadata={"format": "h3_motion_context_av_v1"})
        _LOG.info("h3_motion_context: AV latent 已保存 %s (video %s, audio %s)",
                  path, tuple(video.shape), tuple(audio.shape))
        return (path,)


class H3MotionContextLoadLatent:
    """加载保存的 AV latent,只给 context_latent 输入用。

    clip_index 语义:设为要续接的那一段的序号。生成段 2 接段 1:Load 节点
    填 1,Save 节点填 2。0 = 目录最新文件(不防重跑,reject 会被加载)。
    输出是普通 list 而非 NestedTensor,只有本包的 context_latent 接受它,
    误接 VAE 解码会响亮失败。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent_path": ("STRING", {
                    "default": "h3_context",
                    "tooltip": "保存的 latent 文件,或目录(相对路径按 ComfyUI "
                               "输出目录解析)。指定具体文件时忽略 clip_index。"}),
                "clip_index": ("INT", {
                    "default": 0, "min": 0, "max": 9999,
                    "tooltip": "续接自哪一段:该段的固定槽位被加载。"
                               "0 = 目录最新文件(不防重跑)。"}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "load"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("加载 H3 Motion Context Save Latent 保存的 AV latent,"
                   "只供 Motion Context 的 context_latent 输入。")

    @classmethod
    def IS_CHANGED(cls, latent_path, clip_index=0):
        # 路径字符串不变而文件在变(最新保存 / 槽位被覆盖),缓存键用
        # 解析后的文件身份 + mtime;解析失败返回 NaN 让 ComfyUI 不缓存
        try:
            p = _resolve_latent_path(latent_path, clip_index)
            return "%s:%d" % (p, os.stat(p).st_mtime_ns)
        except Exception:
            return float("NaN")

    def load(self, latent_path, clip_index=0):
        path = _resolve_latent_path(latent_path, clip_index)
        data = load_file(path)
        if "video" not in data or "audio" not in data:
            raise ValueError(
                "h3_motion_context: %s 不是 h3_motion_context 保存的 latent"
                "(缺 video/audio 流)。是不是 stock Save Latent 存的?" % path)
        _LOG.info("h3_motion_context: 已加载 AV latent %s", path)
        # 普通 list 而非 NestedTensor:只有 context_latent 接受它,这就是
        # 它不会被当成可解码 latent 的原因(研究 §1.3)
        return ({"samples": [data["video"], data["audio"]]},)


NODE_CLASS_MAPPINGS = {
    "H3MotionContext": H3MotionContext,
    "H3MotionContextTrim": H3MotionContextTrim,
    "H3MotionContextSaveLatent": H3MotionContextSaveLatent,
    "H3MotionContextLoadLatent": H3MotionContextLoadLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3MotionContext": "H3 Motion Context",
    "H3MotionContextTrim": "H3 Motion Context Trim",
    "H3MotionContextSaveLatent": "H3 Motion Context Save Latent",
    "H3MotionContextLoadLatent": "H3 Motion Context Load Latent",
}
