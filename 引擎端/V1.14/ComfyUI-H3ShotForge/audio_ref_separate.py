"""分轨继承分离 (方案 76 §3.2): 上段成片音频 HDemucs 四轨分离 → 32k 挑段参照.

无接线 (接线归 E4); 真权重首次联网下载并缓存 torch/hub, 任何异常返回 None 由上层降级.
"""
import os
import tempfile

import numpy as np
import soundfile as sf

import audio_ref_pick

SR44 = 44100
SR32 = 32000


def separate(wav_44k_stereo_path):
    """HDemucs (HDEMUCS_HIGH_MUSDB_PLUS) 四轨分离 → {drums,bass,other,vocals: pcm[2,L]} 或 None."""
    try:
        import torch
        import torchaudio
        from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS as bundle

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = bundle.get_model().to(device)
        # torchaudio 2.11 load 强依赖 torchcodec (本机 venv 无) → 用 soundfile 读回中间 wav
        wav_np, sr = sf.read(str(wav_44k_stereo_path), dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(wav_np.T))
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]
        if sr != bundle.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
        with torch.no_grad():
            out = model(wav[None].to(device))[0].cpu()
        return {name: out[i].numpy().astype(np.float32) for i, name in enumerate(model.sources)}
    except Exception:
        return None


def accompaniment(stems):
    """背景轨 = drums+bass+other 线性求和 (标准 MSS accompaniment 口径)."""
    parts = [np.asarray(stems[k], dtype=np.float32) for k in ("drums", "bass", "other")]
    n = min(p.shape[-1] for p in parts)
    mix = np.zeros((2, n), dtype=np.float32)
    for p in parts:
        mix += p[:, :n]
    return mix


def resample_32k(pcm_44k):
    """44.1k → 32k (E1 pick_reference stems 契约), 保持 [2,L] float32."""
    import torch
    import torchaudio

    x = torch.from_numpy(np.asarray(pcm_44k, dtype=np.float32))
    return torchaudio.functional.resample(x, SR44, SR32).numpy().astype(np.float32)


def separate_and_pick(mp4_path, out_wav, vocals_on, background_on):
    """编排级: 44.1k 解码→分离→32k 挑段参照 wav; 返回 out_wav, 解码/分离失败返回 None (降级信号).

    每段批前调用一次, 双开关共享一次分离; 背景纯静音时降单人声重挑.
    """
    try:
        pcm, sr = audio_ref_pick.extract_audio(mp4_path, sr_out=SR44)
    except (OSError, RuntimeError):
        return None
    with tempfile.TemporaryDirectory(prefix="h3_audio_ref_") as td:
        src = os.path.join(td, "src44k.wav")
        sf.write(src, np.ascontiguousarray(pcm.T), sr, subtype="FLOAT")
        stems44 = separate(src)
        if stems44 is None:
            return None
        stems = {
            "vocals": resample_32k(stems44["vocals"]),
            "accompaniment": resample_32k(accompaniment(stems44)),
        }
        try:
            return audio_ref_pick.pick_reference(
                mp4_path, out_wav, stems=stems,
                vocals_on=vocals_on, background_on=background_on)
        except audio_ref_pick.SilentBackgroundError:
            return audio_ref_pick.pick_reference(
                mp4_path, out_wav, stems=stems, vocals_on=True, background_on=False)
