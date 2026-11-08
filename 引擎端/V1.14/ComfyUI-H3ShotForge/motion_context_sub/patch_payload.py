"""让 keyframes 与 refs 共存(patch_layout 的 payload 面)。

stock MiniMaxH3.extra_conds(model_base.py:2156-2165)里,keyframes 分支先写
payload["cond_video_latents"],refs 分支随后整列表覆盖:音频 ref 没有 latent
键,覆盖后视频 latent 列表被清空,布局为 keyframes 建好的 cond 行无内容可填,
钉住的画面全丢。本包装在带本包 marker 的图上把两分支结果串接:
keyframes 在前、refs 按列表序在后,与 PackedLayout 的行序(text, cond, refs)
一致;cond_audio_latents 只从 refs 取。frame_count 只在 kwargs 真提供了
时才写,防覆盖 stock 已设的合法值。

门控与 patch_layout 同款:单机制(无 keyframes 或无 refs)或无关图(无
marker)原样返回,stock 行为逐位不变——stock Ref2VA + last_frame 锚点图
照旧走 stock 的覆盖语义。

真 MiniMaxH3 在 apply_patch 时惰性导入:comfy.model_base 离线不可导入
(依赖 comfy_kitchen),测试向 sys.modules 注入替身;导入失败降级为未安装,
节点侧对音频续接报明确错误。

新版 stock(model_base.py:2189-2196)把 refs 分支改成 append,keyframes 的
cond_video_latents 不再被清空,本 patch 已无必要:自检①以专用信号
_StockAlreadyMerges 抛出,apply_patch 识别后返成功但不安装(装上只是个空
包装),其余自检失败仍返 False 走降级。探测面独立于 patch_layout 的签名
探测,只认这条信号。
"""

import functools
import logging

import torch

from .patch_layout import MC_KEY, MC_AUDIO_KEY

# 跨包 ABI:任何 vendor 本 patch 的 pack 都靠它识别同类 patch 并让位,
# 改名必须所有 pack 同步。MC_KEY / MC_AUDIO_KEY 直接复用 patch_layout
# 的值(它是唯一权威来源,两模块对同一图上的标记必须同值)。
PATCH_MARKER = "_h3_motion_context_payload_patch"

_LOG = logging.getLogger("h3_motion_context")

# apply_patch 捕获的原始方法;模块级暴露供测试还原。
_orig_extra_conds = None
_applied = False

# payload 侧版本探测:新版 stock 已自行合并 refs 与 keyframes,本 patch 无必要
# (自检①信号)。与 patch_layout 的签名探测互相独立。
_stock_merges_refs = False


class _StockAlreadyMerges(Exception):
    """自检①的专用信号:stock 已自行合并 refs+keyframes,本 patch 无必要。

    只有这一种情况走"返成功但不安装";其余自检失败仍是普通异常,apply_patch
    照旧返 False 让依赖方降级。
    """


class _FakeMiniMaxH3:
    """stock extra_conds 的 H3 片段副本,只用于自检。

    真模块离线不可导入,自检打在这个最小可测类上:keyframes 分支设
    cond_video_latents、refs 分支整列表覆盖,与 model_base.py 的写序一致。
    返回裸 dict 而非 CONDConstant,包装器对两种形态都接受。
    """

    def extra_conds(self, **kwargs):
        payload = {}
        keyframes = kwargs.get("minimax_keyframes", None)
        if keyframes is not None:
            payload["keyframes"] = keyframes
            payload["frame_count"] = kwargs.get("minimax_frame_count", None)
            payload["cond_video_latents"] = [kf["latent"] for kf in keyframes]
        refs = kwargs.get("minimax_refs", None)
        if refs is not None:
            payload["refs"] = refs
            payload["cond_video_latents"] = [r["latent"] for r in refs
                                             if "latent" in r]
            payload["cond_audio_latents"] = [r["audio_latent"] for r in refs
                                             if r.get("audio_latent") is not None]
        return {"minimax_payload": payload}


def _patched_extra_conds(self, **kwargs):
    out = _orig_extra_conds(self, **kwargs)

    keyframes = kwargs.get("minimax_keyframes", None)
    refs = kwargs.get("minimax_refs", None)
    if not keyframes or not refs:
        return out  # 单机制:stock 行为本来就对
    if not (any(MC_KEY in kf for kf in keyframes)
            or any(MC_AUDIO_KEY in r for r in refs)):
        # 无关图:布局 patch 同样被门控,payload 也必须不动,两条路径一致
        return out

    payload = out.get("minimax_payload", None)
    if not isinstance(payload, dict):
        payload = getattr(payload, "cond", None)  # CONDConstant 形态
    if not isinstance(payload, dict):
        _LOG.warning("h3_motion_context: 取不到 H3 payload,keyframe 画面可能"
                     "已被 refs 覆盖")
        return out

    payload["cond_video_latents"] = (
        [kf["latent"] for kf in keyframes if "latent" in kf]
        + [r["latent"] for r in refs if "latent" in r])
    payload["cond_audio_latents"] = [r["audio_latent"] for r in refs
                                     if r.get("audio_latent") is not None]
    fc = kwargs.get("minimax_frame_count", None)
    if fc is not None:
        payload["frame_count"] = fc
    return out


setattr(_patched_extra_conds, PATCH_MARKER, True)


def _payload_equal(a, b):
    """递归逐键对比:dict/list 结构 + torch.equal 语义。"""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_payload_equal(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(
            _payload_equal(x, y) for x, y in zip(a, b))
    if torch.is_tensor(a) and torch.is_tensor(b):
        return torch.equal(a, b)
    return a == b


def _already_patched(cls):
    """是否已有另一份本文件包住了 extra_conds;语义与 patch_layout 同款。

    marker 只认够新的副本;同名无 marker 的是旧版/fork;别的包装函数按
    __wrapped__ / 模块归属识别。都无法区分的只能视为未 patch。
    """
    fn = getattr(cls, "extra_conds", None)
    if fn is None:
        return None
    if getattr(fn, PATCH_MARKER, False):
        return "same"
    if getattr(fn, "__name__", "") == "_patched_extra_conds":
        return "other"
    if hasattr(fn, "__wrapped__"):
        return "foreign"
    home = getattr(cls, "__module__", None)
    where = getattr(fn, "__module__", None)
    if home and where and where != home:
        return "foreign"
    return None


def _self_test():
    """安装前自检;真模块可用(ComfyUI 运行时/完整环境)时打真 MiniMaxH3,
    否则降级到 _FakeMiniMaxH3 副本。任一不符即拒绝安装。

    真路径(M4 硬验收项):用 __new__ 构造无权重 stub(latent_shapes=None
    短路 audio_scale、concat_keys=[] 短路 concat_cond),在真实 stock
    extra_conds 上先复现"refs 覆盖清空 keyframes"的 bug(证明 patch 仍有
    必要),再验证包装后合并顺序与无关图门控。
    """
    cls = _real_target()
    if cls is not None:
        return _self_test_real(cls)
    return _self_test_fake()


def _self_test_fake():
    """在 _FakeMiniMaxH3 副本上的自检(真模块不可用的离线环境)。

    ① keyframes+refs 合并后 keyframes 在前、refs 按列表序在后,
       cond_audio_latents 只取音频 ref;
    ② 无关图(无 marker)输出与 stock 逐键一致;
    ③ 三态检测各分支按预期。
    """
    global _orig_extra_conds
    orig = _FakeMiniMaxH3.extra_conds
    saved = _orig_extra_conds
    try:
        _orig_extra_conds = orig
        _FakeMiniMaxH3.extra_conds = _patched_extra_conds

        kf_latents = [torch.zeros(1, 24, 1, 1, 1), torch.zeros(1, 24, 1, 1, 1)]
        keyframes = [{"resolved_frame_index": 0, MC_KEY: i, "latent": z}
                     for i, z in enumerate(kf_latents)]
        img_z = torch.zeros(1, 24, 2, 8, 12)
        aud_z = torch.zeros(1, 32, 2, 8)
        vid_z = torch.zeros(1, 24, 3, 8, 12)
        refs = [
            {"kind": "image", "latent_h": 8, "latent_w": 12, "latent": img_z},
            {"kind": "audio", "ref_audio_t": 8, "audio_latent": aud_z,
             MC_AUDIO_KEY: 4.0},
            {"kind": "video", "latent_h": 8, "latent_w": 12, "latent_t": 3,
             "latent": vid_z},
        ]
        out = _FakeMiniMaxH3.extra_conds(
            _FakeMiniMaxH3(), minimax_keyframes=keyframes, minimax_refs=refs,
            minimax_frame_count=22)
        payload = out["minimax_payload"]
        got = payload["cond_video_latents"]
        want = kf_latents + [img_z, vid_z]
        if len(got) != len(want) or any(a is not b for a, b in zip(got, want)):
            raise RuntimeError(
                "h3_motion_context: 自检失败,合并顺序不是 keyframes 在前")
        if payload["cond_audio_latents"] != [aud_z]:
            raise RuntimeError(
                "h3_motion_context: 自检失败,cond_audio_latents 提取不符")
        if payload["frame_count"] != 22:
            raise RuntimeError(
                "h3_motion_context: 自检失败,frame_count 未写入")

        # 无关图:包装输出与 stock 原方法输出逐键一致
        stock_kf = [{"resolved_frame_index": 0,
                     "latent": torch.zeros(1, 24, 1, 1, 1)},
                    {"resolved_frame_index": 1,
                     "latent": torch.zeros(1, 24, 1, 1, 1)}]
        plain_refs = [{"kind": "audio", "ref_audio_t": 8,
                       "audio_latent": aud_z}]
        kwargs = dict(minimax_keyframes=stock_kf, minimax_refs=plain_refs,
                      minimax_frame_count=22)
        if not _payload_equal(
                orig(_FakeMiniMaxH3(), **kwargs),
                _FakeMiniMaxH3.extra_conds(_FakeMiniMaxH3(), **kwargs)):
            raise RuntimeError(
                "h3_motion_context: 自检失败,无关图输出与 stock 不一致")

        # 三态检测:其余分支
        def _marker_fn():
            pass
        setattr(_marker_fn, PATCH_MARKER, True)
        _FakeMiniMaxH3.extra_conds = _marker_fn
        if _already_patched(_FakeMiniMaxH3) != "same":
            raise RuntimeError(
                "h3_motion_context: 自检失败,marker 分支检测不符")

        def _old_copy():
            pass
        _old_copy.__name__ = "_patched_extra_conds"
        _FakeMiniMaxH3.extra_conds = _old_copy
        if _already_patched(_FakeMiniMaxH3) != "other":
            raise RuntimeError(
                "h3_motion_context: 自检失败,同名旧副本分支检测不符")

        def _pack_inner():
            pass
        _FakeMiniMaxH3.extra_conds = functools.wraps(_pack_inner)(lambda: None)
        if _already_patched(_FakeMiniMaxH3) != "foreign":
            raise RuntimeError(
                "h3_motion_context: 自检失败,包装函数分支检测不符")

        def _other_pack():
            pass
        _other_pack.__module__ = "some.other.pack"
        _FakeMiniMaxH3.extra_conds = _other_pack
        if _already_patched(_FakeMiniMaxH3) != "foreign":
            raise RuntimeError(
                "h3_motion_context: 自检失败,跨模块分支检测不符")

        _FakeMiniMaxH3.extra_conds = orig
        if _already_patched(_FakeMiniMaxH3) is not None:
            raise RuntimeError(
                "h3_motion_context: 自检失败,未安装的方法被误判为已 patch")
    finally:
        _FakeMiniMaxH3.extra_conds = orig
        _orig_extra_conds = saved


def _self_test_real(cls):
    """在真 MiniMaxH3 类上的自检(M4 硬验收项)。

    无权重 stub:__new__ 构造 + latent_shapes=None(短路 audio_scale,
    不碰 model_sampling)+ concat_keys=[](短路 concat_cond)。真 stock
    extra_conds 只在这些属性之外走 kwargs 分支,不上任何权重。
    验证:
    ① 真 stock 仍把 keyframes 的 cond_video_latents 覆盖清空(上游行为
       没变,patch 有必要);新版 stock 已 append 合并,则抛专用信号
       _StockAlreadyMerges;
    ② 包装后合并顺序 = keyframes 在前,cond_audio_latents 只取音频 ref;
    ③ 无关图(无 marker)包装输出与真 stock 逐键一致(含 CONDConstant 形态)。
    """
    global _orig_extra_conds
    obj = cls.__new__(cls)
    obj.latent_shapes = None
    obj.concat_keys = []
    stock = cls.extra_conds
    saved = _orig_extra_conds
    kf_z = torch.zeros(1, 24, 1, 1, 1)
    aud_z = torch.zeros(1, 32, 2, 8)
    try:
        # ① 旧版 stock 覆盖 bug 必须仍在:证明 patch 有必要;
        #    新版 stock 已自行合并,抛专用信号让 apply_patch 不安装
        kfs = [{"resolved_frame_index": 0, MC_KEY: 0, "latent": kf_z}]
        refs = [{"kind": "audio", "ref_audio_t": 8, "audio_latent": aud_z,
                 MC_AUDIO_KEY: 4.0}]
        stock_out = stock(obj, minimax_keyframes=kfs, minimax_refs=refs,
                          minimax_frame_count=22)
        stock_payload = stock_out["minimax_payload"]
        stock_payload = getattr(stock_payload, "cond", stock_payload)
        if stock_payload["cond_video_latents"]:
            raise _StockAlreadyMerges(
                "h3_motion_context: 新版 stock 已自行合并 refs 与 keyframes,"
                "payload patch 无必要")
        if len(stock_payload["cond_audio_latents"]) != 1:
            raise RuntimeError(
                "h3_motion_context: 真模块自检失败,stock 音频分支行为变化")

        # ② 包装后合并顺序与音频提取
        _orig_extra_conds = stock
        cls.extra_conds = _patched_extra_conds
        patched = _patched_extra_conds(
            obj, minimax_keyframes=kfs, minimax_refs=refs,
            minimax_frame_count=22)
        payload = patched["minimax_payload"]
        payload = getattr(payload, "cond", payload)
        got = payload["cond_video_latents"]
        if len(got) != 1 or got[0] is not kf_z:
            raise RuntimeError(
                "h3_motion_context: 真模块自检失败,合并顺序不是 keyframes 在前")
        if payload["cond_audio_latents"] != [aud_z]:
            raise RuntimeError(
                "h3_motion_context: 真模块自检失败,cond_audio_latents 提取不符")
        if payload["frame_count"] != 22:
            raise RuntimeError(
                "h3_motion_context: 真模块自检失败,frame_count 未写入")

        # ③ 无关图(无 marker):包装输出与真 stock 逐键一致
        plain_kf = [{"resolved_frame_index": 0, "latent": kf_z}]
        plain_refs = [{"kind": "audio", "ref_audio_t": 8,
                       "audio_latent": aud_z}]
        kwargs = dict(minimax_keyframes=plain_kf, minimax_refs=plain_refs,
                      minimax_frame_count=22)
        stock_plain = stock(obj, **kwargs)
        stock_plain = getattr(stock_plain["minimax_payload"], "cond",
                              stock_plain["minimax_payload"])
        got_plain = _patched_extra_conds(obj, **kwargs)["minimax_payload"]
        got_plain = getattr(got_plain, "cond", got_plain)
        if not _payload_equal(stock_plain, got_plain):
            raise RuntimeError(
                "h3_motion_context: 真模块自检失败,无关图输出与 stock 不一致")
    finally:
        cls.extra_conds = stock
        _orig_extra_conds = saved


def _real_target():
    """真 MiniMaxH3 类;惰性导入使离线测试能注入替身模块。"""
    try:
        import comfy.model_base
    except ImportError:
        return None
    return getattr(comfy.model_base, "MiniMaxH3", None)


def apply_patch():
    """安装 payload patch;返回是否生效(含别的副本已生效/新版无必要)。

    foreign 时拒绝:两个 pack 不能同时持有 extra_conds。自检失败同样拒绝,
    依赖方靠 is_applied() 走降级。新版 stock 已自行合并 refs 与 keyframes
    时返成功但不安装——stock 行为本就正确,装上去只是空包装。
    """
    global _orig_extra_conds, _applied, _stock_merges_refs
    if _applied:
        return True
    cls = _real_target()
    if cls is None:
        _LOG.warning("h3_motion_context: 找不到 MiniMaxH3.extra_conds,"
                     "keyframes 与 refs 无法共存,音频续接不可用")
        return False
    who = _already_patched(cls)
    if who == "foreign":
        _LOG.warning(
            "h3_motion_context: 另一 pack 已 patch MiniMaxH3.extra_conds "
            "(现来自 %r)。两个 pack 独立解同一冲突,不能同时持有,"
            "本副本拒绝再包。禁用其一后重启。",
            getattr(getattr(cls, "extra_conds", None), "__module__", "?"))
        return False
    if who:
        # 别的副本已生效:报告成功,节点靠 is_applied() 决定运行
        _applied = True
        if who == "same":
            _LOG.info("h3_motion_context: keyframe/ref 共存已由另一 pack "
                      "启用,本副本让位")
        else:
            _LOG.warning("h3_motion_context: payload patch 已由本代码的另一份"
                         "副本安装(旧版或 fork),让位;custom_nodes 里有多份 "
                         "H3 Motion Context 时保留一份,其余移除。")
        return True
    _orig_extra_conds = cls.extra_conds
    try:
        _self_test()
    except _StockAlreadyMerges:
        # 新版 stock 自己就对:报告成功但不安装,装上去只是空包装。
        # 置 _applied 免每次 apply 重探;未装则 _already_patched 仍报 None。
        _orig_extra_conds = None
        _applied = True
        _stock_merges_refs = True
        _LOG.info("h3_motion_context: 新版 stock 已自行合并 refs 与 keyframes,"
                  "payload patch 无必要,不安装")
        return True
    except Exception as exc:
        _orig_extra_conds = None
        _LOG.warning("h3_motion_context: 自检失败(%s),patch 未安装,音频续接"
                     "不可用。上面的报错说明哪里变了。", exc)
        return False
    cls.extra_conds = _patched_extra_conds
    _applied = True
    _LOG.info("h3_motion_context: keyframe/ref 共存已启用")
    return True


def is_applied():
    return _applied
