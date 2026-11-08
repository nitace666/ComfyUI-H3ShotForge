"""解除 stock PackedLayout 的 keyframe 仅 first/last 锚点限制。

stock 构造器（model.py:304-313）只接受 resolved_frame_index == 0 或
frame_count-1，其余直接 raise。本模块包装 __init__：所有 keyframe 恒以
resolved_frame_index=0 交给 stock（永远合法），真实像素坐标挂在 MC_KEY 上，
构造完成后按 segments 表重写 position_ids 的时间列。RoPE 在 forward 时才从
position_ids 构建（model.py:451），重写发生在任何读取之前。

不复制 90 行构造器，只补一个可验证的属性：stock 改动布局算法时，自检失败
即拒绝安装，而不是默默产出错位坐标。

新版 stock 去掉 frame_count 参数、且只给带 latent 载荷的 keyframe 建 cond 段。
apply_patch 捕获 stock 构造器时用 inspect 探测一次版本，两条路径各自走自己的
调用与自检夹具；探测打在 stock 构造器上，不能在包装函数上探（会误判回旧版）。
"""

import inspect
import logging

import torch

import comfy.ldm.minimax.model as mm

MC_KEY = "motion_context_index"
MC_AUDIO_KEY = "motion_context_audio_end_frame"

# 跨包 ABI：任何 vendor 本 patch 的 pack 都靠它识别同类 patch 并让位，
# 改名必须所有 pack 同步，与 MC_KEY / MC_AUDIO_KEY 同规则。
PATCH_MARKER = "_h3_motion_context_layout_patch"

_LOG = logging.getLogger("h3_motion_context")

# apply_patch 捕获的原始构造函数；模块级暴露供测试还原。
_orig_init = None
_applied = False

# 版本探测：stock 构造器已无 frame_count 参数（新版）时为 True。
# apply_patch 捕获 _orig_init 时探测一次；None = 尚未探测。
_new_api = None

_REF_SEG_KINDS = ("ref_img", "ref_audio")


def _cond_t(text_len, latent_t, frame_count, p):
    """keyframe 锚在像素帧 p 时的时间坐标。

    端点复用 stock 的逐项累加表达式而非统一公式：两者数学等价，但 stock
    对 latent_t 个浮点数累加、统一公式只做一次乘法，结果最后几位（约
    7e-15）不同。端点 bit 级一致，既有 first/last 图在 patch 后
    position_ids 才能逐字节不变，自检的 torch.equal 也才保持严格。
    """
    if p == 0:
        return float(text_len)
    if frame_count is not None and p == frame_count - 1:
        return float(text_len) + sum(mm._video_t_spans(latent_t)) - mm.FRAME_RESCALE
    return float(text_len) + mm.FRAME_RESCALE * float(p)


def _target_origin(layout):
    """目标视频行起点坐标，从已构建的布局读回。

    不复制 stock 的光标算术：refs 每种 kind 如何推进光标是 stock 内部实现，
    本地复制一份迟早与上游失同步。目标视频段恒为最后一个 segment 且至少一
    步，_video_grid 第一行恰落在光标终值上，直接读回即可。
    """
    a, b, kind = layout.segments[-1]
    if kind != "video" or b <= a:
        raise RuntimeError(
            "h3_motion_context: 布局最后一段应为目标视频行,实际为 %r 共 %d 行。"
            "上游布局变更,拒绝重写坐标。" % (kind, b - a))
    return float(layout.position_ids[a, 0])


def _expected_ref_segments(blk):
    """一个 ref 块按 stock 构造逻辑应产出的段类型序列（按产出顺序）。

    stock 构造器分支：image 只产 ref_img；audio 在 rt>0 时才产 ref_audio
    （rt==0 时跳过段但仍推进光标）；video/video_audio 的音频行紧贴在视频行
    之前，故顺序为 ref_audio 再 ref_img。未知 kind 无法预判行归属，直接报错。
    """
    kind = blk.get("kind")
    if kind == "image":
        return ("ref_img",)
    if kind == "audio":
        return ("ref_audio",) if int(blk.get("ref_audio_t", 0)) > 0 else ()
    if kind in ("video", "video_audio"):
        if int(blk.get("ref_audio_t", 0)) > 0:
            return ("ref_audio", "ref_img")
        return ("ref_img",)
    raise RuntimeError(
        "h3_motion_context: 未知 ref kind %r,无法判断其布局行归属。" % (kind,))


def _ref_segment_map(layout, refs):
    """每个 ref 块实际产出的布局段：{block_index: {kind: (start, stop)}}。

    不用坐标推算块的落点：那要复制 stock 的光标算术，且 stock 的 keyframe
    行也会落在同一坐标区间，坐标法还得显式排除它们。layout.segments 已按
    顺序发布每个 ref_img/ref_audio 段，refs 按列表顺序逐块产出，直接 zip
    即精确映射，无需排除任何东西。
    """
    got = [(a, b, k) for a, b, k in layout.segments if k in _REF_SEG_KINDS]
    want = [(i, k) for i, blk in enumerate(refs or [])
            for k in _expected_ref_segments(blk)]
    if len(want) != len(got):
        raise RuntimeError(
            "h3_motion_context: %d 个 ref 块应产出 %d 个布局段,实际 %d 个。"
            "上游布局变更,拒绝移动行。" % (len(refs or []), len(want), len(got)))
    out = {}
    for (i, kind), (a, b, got_kind) in zip(want, got):
        if got_kind != kind:
            raise RuntimeError(
                "h3_motion_context: ref 块 %d (%r) 应产出 %s 段,布局给出 %s。"
                "上游布局变更,拒绝移动行。" % (i, refs[i].get("kind"), kind, got_kind))
        out.setdefault(i, {})[kind] = (a, b)
    return out


def _fixup(layout, text_len, latent_t, frame_count, keyframes, refs=None):
    """把带 MC_KEY 的 cond 行时间列重写为通用坐标公式。

    offset 是 refs 欠锚点的补偿：stock 的 keyframe 坐标直接从 text_len 算、
    从不补偿，一旦有 ref，锚点相对目标整体后移。从布局读回目标原点而非
    重算光标，上游改动自动跟随。refs 参数保留只为签名与调用点一致，算术
    不再读它。

    无 MC_KEY 的 keyframe 保持 stock 原样，也就得不到 ref 补偿；与 MC
    keyframe 混在同一图里时两组锚点会互相错位。当前没有图这么用，遇到就
    响亮拒绝。
    """
    offset = _target_origin(layout) - float(text_len)
    if offset and any(kf.get(MC_KEY) is None for kf in keyframes):
        raise RuntimeError(
            "h3_motion_context: 同一图里混用了 stock 与 motion-context "
            "keyframe 且带 ref,两者坐标会不一致。请给每个 keyframe 加 %s "
            "或去掉 refs。" % MC_KEY)
    cond_spans = [(a, b) for a, b, kind in layout.segments if kind == "cond"]
    if len(cond_spans) != len(keyframes):
        raise RuntimeError(
            "h3_motion_context: 应得 %d 个 cond 段,布局有 %d 个。拒绝重写坐标。"
            % (len(keyframes), len(cond_spans)))
    for (a, b), kf in zip(cond_spans, keyframes):
        p = kf.get(MC_KEY)
        if p is None:
            continue
        layout.position_ids[a:b, 0] = _cond_t(text_len, latent_t, frame_count, p) + offset


def _fixup_audio(layout, text_len, refs):
    """把标记音频 ref 的行整体平移到目标时间轴上。

    ref 与 keyframe 的行机制完全相同，模型把它读成"另一段要模仿的片段"
    还是"本片段在继续"，全靠坐标落在目标之前还是之后。音频 ref 走完整
    stock 路径构建（行、latent 填充全不动），只平移时间列，让窗口 END 落在
    目标帧 MC_AUDIO_KEY —— 与钉住视频结束的同一时刻。

    平移而非逐行赋值：stock 按 channel-major 铺音频行（每声道同一组 rt 坐
    标），整体平移保持块内结构，本代码无需知道行内布局。块保留在光标序列
    原位置，让出的坐标留空，音频窗口比视频窗口长时向后溢入空区而非压到
    text 行上。其他 ref 块一概不碰，REF2V 自带参考块原样保留。
    """
    marked = [i for i, r in enumerate(refs or [])
              if r.get(MC_AUDIO_KEY) is not None]
    if len(marked) != 1:
        raise RuntimeError(
            "h3_motion_context: 音频时间轴定位需要恰好 1 个带 %s 的 ref,"
            "当前 %d 个 ref 中标记了 %d 个。若出现在启动期,检查 custom_nodes "
            "里是否有多份 H3 Motion Context。" % (MC_AUDIO_KEY, len(refs or []), len(marked)))
    blk = refs[marked[0]]
    if blk.get("kind") != "audio":
        raise RuntimeError(
            "h3_motion_context: %s 标在 %r ref 上,只有 audio ref 能平移到时间轴上。"
            % (MC_AUDIO_KEY, blk.get("kind")))
    rt = int(blk.get("ref_audio_t", 0))
    if rt <= 0:
        # 空窗口:stock 根本不产段,没有行可平移
        return
    a, b = _ref_segment_map(layout, refs)[marked[0]]["ref_audio"]
    if b - a != 2 * rt:
        # 精确计数而非容差:stock 每声道恰好 rt 行,行内结构一旦变化,
        # 平移所依赖的 channel-major 布局就不再成立
        raise RuntimeError(
            "h3_motion_context: 标记音频 ref 有 %d 行,%d 个 latent 步,应为 "
            "%d 行(立体声 channel-major)。上游布局变更,拒绝移动行。"
            % (b - a, rt, 2 * rt))
    slot_start = float(layout.position_ids[a, 0])
    desired_start = (_target_origin(layout)
                     + mm.FRAME_RESCALE * float(blk[MC_AUDIO_KEY]) - float(rt))
    layout.position_ids[a:b, 0] = (layout.position_ids[a:b, 0]
                                   + (desired_start - slot_start))


def _patched_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                  keyframes=None, refs=None, frame_count=None):
    if _new_api:
        # 新版 stock 无 frame_count 参数，收到即丢：坐标一律走通式，
        # _cond_t 的 sum 端点分支（依赖 frame_count）自然禁用。
        frame_count = None
        _orig_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                   keyframes=keyframes, refs=refs)
    else:
        _orig_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                   keyframes=keyframes, refs=refs, frame_count=frame_count)
    has_mc_kf = bool(keyframes) and any(
        kf.get(MC_KEY) is not None for kf in keyframes)
    has_mc_audio = bool(refs) and any(
        r.get(MC_AUDIO_KEY) is not None for r in refs)
    if has_mc_kf:
        _fixup(self, text_len, latent_t, frame_count, keyframes, refs)
    if has_mc_audio:
        _fixup_audio(self, text_len, refs)
    # 两者都未标记:stock 图,保持原样


setattr(_patched_init, PATCH_MARKER, True)


def _self_test():
    """安装前证明重写与 stock 行为一致。

    先复现 stock 唯一支持的两个锚点，一次走 stock 路径、一次走本机制路径，
    要求 position_ids 逐字节相等；再覆盖 stock 没有的部分：中间帧锚点、
    ref 补偿、音频平移，以及同一平移发生在多 ref REF2V 布局里的情形。
    ComfyUI 若改动了坐标算术或 segments 表，这里即失败，patch 不予安装。

    夹具按版本走：新版 stock 只给带 latent 载荷的 keyframe 建 cond 段，故夹具
    带单步 latent（每锚点行数因此仍恰为 frame_rows）且调用不传 frame_count；
    旧版不看 latent、端点公式要 frame_count，两样都保留。
    """
    text_len, latent_t, lh, lw, audio_t = 7, 7, 22, 38, 16
    frame_count = sum(mm.FRAME_PER_TOKEN[k % 5] for k in range(latent_t))
    step_latent = torch.zeros(1, 24, 1, 1, 1) if _new_api else None

    def mk(index, mc=None):
        kf = {"resolved_frame_index": index}
        if mc is not None:
            kf[MC_KEY] = mc
        if step_latent is not None:
            kf["latent"] = step_latent
        return kf

    def build(keyframes=None, refs=None, fix=False, move=False):
        lay = mm.PackedLayout.__new__(mm.PackedLayout)
        kwargs = {} if _new_api else {"frame_count": frame_count}
        _orig_init(lay, text_len, latent_t, lh, lw, audio_t,
                   keyframes=keyframes, refs=refs, **kwargs)
        if fix:
            fc = None if _new_api else frame_count
            _fixup(lay, text_len, latent_t, fc, keyframes, refs)
        if move:
            _fixup_audio(lay, text_len, refs)
        return lay

    def cond_ts(lay):
        return [float(lay.position_ids[a, 0])
                for a, _, k in lay.segments if k == "cond"]

    # 1. stock 支持的两个端点必须 bit 级一致
    stock_kf = [mk(0), mk(frame_count - 1)]
    ours_kf = [mk(0, 0), mk(0, frame_count - 1)]
    a = build(keyframes=stock_kf)
    b = build(keyframes=ours_kf, fix=True)
    if a.position_ids.shape != b.position_ids.shape:
        raise RuntimeError("h3_motion_context: 自检 position_ids 形状不一致")
    if not torch.equal(a.position_ids, b.position_ids):
        bad = (a.position_ids != b.position_ids).any(dim=1).nonzero().flatten()
        raise RuntimeError(
            "h3_motion_context: 端点重写与 stock 不一致,行 %s"
            % bad[:8].tolist())

    # 2. 连续中间帧锚点严格递增,且落在两端点定义的区间内
    run = [mk(0, i) for i in range(4)]
    c = build(keyframes=run, fix=True)
    ts = cond_ts(c)
    if len(ts) != len(run):
        raise RuntimeError(
            "h3_motion_context: 应得 %d 个 cond 段,实际 %d" % (len(run), len(ts)))
    if any(ts[i] >= ts[i + 1] for i in range(len(ts) - 1)):
        raise RuntimeError(
            "h3_motion_context: 连续锚点未严格递增: %s" % ts)
    t_last = float(text_len) + mm.FRAME_RESCALE * (frame_count - 1)
    if not (ts[0] == float(text_len) and ts[-1] < t_last):
        raise RuntimeError(
            "h3_motion_context: 锚点越出 [%.4f, %.4f] 区间: %s"
            % (float(text_len), t_last, ts))

    # 3. 加 ref 后锚点相对目标不得移动。ground truth 是目标行本身:
    # 锚点与目标末端(时间列最大值)的间隔,有 ref 与无 ref 必须相同;
    # 且每个锚点的位移量一致(都等于 offset)。
    ref = [{"kind": "audio", "ref_audio_t": 8}]
    d = build(keyframes=run, refs=ref, fix=True)
    ts_ref = cond_ts(d)
    if len(ts_ref) != len(ts):
        raise RuntimeError("h3_motion_context: 加 ref 后 cond 段数量变化")
    tol = 1e-3
    gap = float(c.position_ids[:, 0].max()) - ts[0]
    gap_ref = float(d.position_ids[:, 0].max()) - ts_ref[0]
    if abs(gap - gap_ref) > tol:
        raise RuntimeError(
            "h3_motion_context: ref 补偿偏差 %.6f:无 ref 时锚点-目标间距 "
            "%.6f,有 ref %.6f。读回的起点与光标算术不符。"
            % (gap_ref - gap, gap, gap_ref))
    shifts = [y - x for x, y in zip(ts, ts_ref)]
    if any(abs(sh - shifts[0]) > tol for sh in shifts):
        raise RuntimeError(
            "h3_motion_context: ref 对各锚点位移不一致: %s" % shifts)

    # 4. 音频平移:只动标记块的行、只动时间列、同一平移量,窗口 END 落在
    #    目标时间轴 FRAME_RESCALE*end_frame 处
    end_frame, rt = 4, 8
    ref_mc = [{"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}]
    e = build(keyframes=run, refs=ref_mc, fix=True, move=True)
    _check_move(d, e, ref_mc, 0, "single-ref")

    # 5. 同一平移发生在多 ref REF2V 布局里:图自带的 image/video/audio 参考
    #    块必须原样,标记块排在列表中间(定位只靠 segments,与位置无关)
    r_lh, r_lw, r_vt = 8, 12, 3
    others = [
        {"kind": "image", "latent_h": r_lh, "latent_w": r_lw},
        {"kind": "video_audio", "latent_h": r_lh, "latent_w": r_lw,
         "latent_t": r_vt, "ref_audio_t": 5},
        {"kind": "audio", "ref_audio_t": 3},
    ]
    marked = {"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}
    plain = {"kind": "audio", "ref_audio_t": rt}
    multi_plain = others[:2] + [plain] + others[2:]
    multi_marked = others[:2] + [marked] + others[2:]
    f = build(keyframes=run, refs=multi_plain, fix=True)
    g = build(keyframes=run, refs=multi_marked, fix=True, move=True)
    _check_move(f, g, multi_marked, 2, "multi-ref")

    # 6. segments 映射与真实布局的结构性质一致:ref 块按列表顺序排列、
    #    互不重叠、全部落在目标起点之前。不重算光标,只查平移依赖的结构。
    smap = _ref_segment_map(f, multi_plain)
    prev_hi = float(text_len) - 1e-9
    origin = _target_origin(f)
    for i in range(len(multi_plain)):
        spans = smap.get(i)
        if not spans:
            continue
        rows = [r for a0, b0 in spans.values() for r in range(a0, b0)]
        lo = min(float(f.position_ids[r, 0]) for r in rows)
        hi = max(float(f.position_ids[r, 0]) for r in rows)
        if lo < prev_hi - 1e-9:
            raise RuntimeError(
                "h3_motion_context: ref 块 %d 起点 %.6f 落在块 %d 终点 %.6f 之前,"
                "ref 块未按列表顺序排列。" % (i, lo, i - 1, prev_hi))
        if hi >= origin - 1e-9:
            raise RuntimeError(
                "h3_motion_context: ref 块 %d 到达 %.6f,触到目标起点 %.6f。"
                "ref 行应全部位于目标之前。" % (i, hi, origin))
        prev_hi = hi


def _check_move(before, after, refs, idx, label):
    """只有标记块的行、只在时间列、以同一平移量移动。"""
    if after.position_ids.shape != before.position_ids.shape:
        raise RuntimeError("h3_motion_context: %s 平移改变了布局形状" % label)
    if not torch.equal(before.position_ids[:, 1:], after.position_ids[:, 1:]):
        raise RuntimeError(
            "h3_motion_context: %s 平移触碰了非时间坐标列" % label)
    a, b = _ref_segment_map(before, refs)[idx]["ref_audio"]
    expect_moved = set(range(a, b))
    tb, ta = before.position_ids[:, 0], after.position_ids[:, 0]
    moved = set(i for i in range(len(tb)) if float(tb[i]) != float(ta[i]))
    if not moved:
        raise RuntimeError("h3_motion_context: %s 平移没有移动任何行" % label)
    if moved != expect_moved:
        raise RuntimeError(
            "h3_motion_context: %s 平移触及错误行:移动 %d 行,应 %d 行,示例 %s"
            % (label, len(moved), len(expect_moved),
               sorted(moved ^ expect_moved)[:8]))
    deltas = [float(ta[i]) - float(tb[i]) for i in sorted(moved)]
    if any(abs(dd - deltas[0]) > 1e-9 for dd in deltas):
        raise RuntimeError(
            "h3_motion_context: %s 各行平移量不一致: %s"
            % (label, deltas[:4]))
    # 平移量本身刻意不断言:它取决于光标推进了多远,那是 stock 的事,
    # 钉死在这里等于把那段算术又复制一份。必须成立的是窗口 END:
    # 在目标时间轴上 FRAME_RESCALE*end_frame 处。
    blk = refs[idx]
    rt = int(blk["ref_audio_t"])
    want_end = (_target_origin(after)
                + mm.FRAME_RESCALE * float(blk[MC_AUDIO_KEY]))
    got_end = float(after.position_ids[a, 0]) + float(rt)
    if abs(got_end - want_end) > 1e-9:
        raise RuntimeError(
            "h3_motion_context: %s 音频窗口结束于 %.6f,应在 %.6f"
            % (label, got_end, want_end))


def _already_patched():
    """是否已有另一份本文件包住了构造函数。

    多份 vendor / fork 并存是常态。后加载者若再包一层,每一层的自检都打在
    上一层的行为上,较新的测试可能因旧行为而误判拒绝。按可信度递减检测:

    - PATCH_MARKER:本代码够新的副本都会设,同类直接让位;
    - __name__:同名无 marker 的是本代码旧版或 fork,同样让位(先加载者
      决定支持范围);
    - __wrapped__ / __module__:别的 pack 的包装。stock __init__ 与类同模块,
      包装函数来自别处;functools.wraps 会拷贝 __module__,故再查 __wrapped__。
      两者都藏住的包装与 stock 无法区分,只能视为无 patch。
    """
    cls = getattr(mm, "PackedLayout", None)
    init = getattr(cls, "__init__", None)
    if init is None:
        return None
    if getattr(init, PATCH_MARKER, False):
        return "same"
    if getattr(init, "__name__", "") == "_patched_init":
        return "other"
    if hasattr(init, "__wrapped__"):
        return "foreign"
    home = getattr(cls, "__module__", None)
    where = getattr(init, "__module__", None)
    if home and where and where != home:
        return "foreign"
    return None


def apply_patch():
    """安装布局 patch;返回是否生效(含别的副本已生效)。

    foreign 时拒绝:两个 pack 不能同时占有构造器,包上包会产出两边都
    没打算要的接缝。自检失败同样拒绝安装,依赖方靠 is_applied() 走降级。
    """
    global _orig_init, _applied, _new_api
    if _applied:
        return True
    who = _already_patched()
    if who == "foreign":
        _LOG.warning(
            "h3_motion_context: 另一 pack 已 patch H3 布局 "
            "(PackedLayout.__init__ 现来自 %r)。多个 pack 独立解同一限制,"
            "不能同时持有构造器,本副本拒绝再包。禁用其一后重启。",
            getattr(getattr(getattr(mm, "PackedLayout", None), "__init__",
                            None), "__module__", "?"))
        return False
    if who:
        # 别的副本已生效:报告成功,调用方节点靠 is_applied() 决定运行
        _applied = True
        if who == "same":
            _LOG.info("h3_motion_context: 另一 pack 已启用中间帧锚点,本副本让位")
        else:
            _LOG.warning(
                "h3_motion_context: 布局 patch 已由本代码的另一份副本安装 "
                "(旧版或 fork)。让位;支持范围由那份副本决定,其后新增功能"
                "可能不可用。custom_nodes 里有多份 H3 Motion Context 时保留"
                "一份,其余移除(改名不会阻止加载)。")
        return True
    if not hasattr(mm, "PackedLayout") or not hasattr(mm, "FRAME_RESCALE"):
        _LOG.warning("h3_motion_context: MiniMax H3 模型模块缺少预期属性,patch 未安装")
        return False
    _orig_init = mm.PackedLayout.__init__
    _new_api = "frame_count" not in inspect.signature(_orig_init).parameters
    try:
        _self_test()
    except Exception as exc:
        _orig_init = None
        _LOG.warning("h3_motion_context: 自检失败(%s),patch 未安装,中间帧锚点不可用。"
                     "若 custom_nodes 有多份本包(fork/备份/手动克隆),通常即此因:"
                     "每份自检都打在先加载的那份上。保留一份其余移除;否则是上游 "
                     "ComfyUI 布局变更,上面的报错说明哪里变了。", exc)
        return False
    mm.PackedLayout.__init__ = _patched_init
    _applied = True
    _LOG.info("h3_motion_context: 中间帧 keyframe 锚点已启用")
    return True


def is_applied():
    return _applied
