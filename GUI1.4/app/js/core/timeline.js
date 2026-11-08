// GUI 1.3 时间线域逻辑 — 纯函数模块 (S1-3 任务 T2).
//
// === 出处注记 (S1-3 取用纪律) ===
// 自 v43 原型 (GUI1.1 布局示意 v43)
// 时间线 JS 转正改写: DOM 耦合逻辑抽为纯函数 (不可变返回, 视图层接线后经 store.updateEditingState 持久化).
//   filmEndSec        ← v43 :4086-4092 (v43 件二: 内容末端 = max(正片 Σdur+triml, 音频 Σdur+triml))
//   axisLenSec        ← v43 :4093-4095 (轴长 = ceil(内容末端)+60 固定余量; v37 无限延展口径已废)
//   clipAtPlayhead    ← v43 :2650-2660 (v38 修复: 命中窗 [acc+triml, acc+triml+d), offset 以本体起点为基准)
//   applyTrimClip     ← v43 :4187-4218 (v37 左柄方向修复 + v38 越界钳制 ml≥0 + v39 按侧剪口报告)
//   splitClipAt       ← v43 :2666-2691 (分割 0.2s 余量拒绝; 左半继承 triml+full=源全长 / 右半独立 split- 身份·triml=分割点·名"·续")
//   snapPos           ← v43 :4014-4030 (v42 件5: <8px 磁吸贴合——他段左右缘/游标线)
//   clampZoom         ← v43 :4124-4126 (PXS clamp 12~96; 33%~267% 极值)
//   rulerSteps        ← v43 :4096-4107 (刻度密度分档)
//   stepPlayhead      ← v43 :3941-3946 (←/→ 逐帧 1/24s, 钳 [0, 内容末端])
// v43 本体永不修改; 本文件为正式实现, 行为基准 = docs\v43-行为基线清单.md D 节.
//
// 依赖单向: 本模块不 import 任何模块 (纯函数); 视图层 import 本模块 + store.

// ===== 常量 =====
export const ZOOM_MIN = 12;   // px/s — 33%
export const ZOOM_MAX = 96;   // px/s — 267%
export const ZOOM_BASE = 36;  // px/s — 100% 基准 (v43 zoomPct = PXS/36*100)
export const AXIS_TAIL_SEC = 60;       // 轴长尾部固定余量
export const SNAP_THRESHOLD_PX = 8;    // 磁吸阈值
export const SPLIT_MARGIN_SEC = 0.2;   // 分割余量
export const FRAME_SEC = 1 / 24;       // 逐帧步进 (源 24fps)
export const MIN_CLIP_SEC = 1;         // 修剪最小宽 = 1s (v43 :4191 min=PXS — 拖拽最小宽恒 1 秒, 不出现 0/负时长)

// ===== 变速几何（走查反馈 F4·老板 2026-09-27「变速后时间线片段仍显示原时长」推翻 S3-3 T2 定案②）=====
// 有效时长 effDur = dur ÷ speed —— 时间线几何统一按有效时长（剪映口径：2x 速 5s 源片段显示 2.5s 宽）。
// triml / freeze 不参与换算（triml=流内偏移语义直映；freeze 几何另案）；speed 容错同 store.normalizeClipL2 读侧兜底。
export function clipSpdOf(clip) {
  const n = +((clip && clip.speed));
  return Number.isFinite(n) && n > 0 ? n : 1;
}
// 批 J-P13：产物实测时长校正通道 —— 老板「拼接重叠致第二段实际 4.5s·游标卡 90%」。
//   prodDur = 机会式字段 {file, dur}（产物 loadedmetadata 实测·不进 L2 十字段·由 edit.js 探测写回）。
//   分镜 dur（clip.dur）不覆写 —— 数据层留原值·校正只在读侧生效，撤销栈/CSV 语义零变化。
//   自失效：prodDur.file 与 clip.file 不等即回落 dur —— 换源/重生成/载入历史重建 clip 后旧实测值
//   自动失效，各产物写回点无需各自清字段（submit-bar.js syncRunProducts 等边界外写点天然安全）。
function prodDurOf(clip) {
  const p = clip && clip.prodDur;
  if (!p || typeof p !== "object") return 0;
  if (String(p.file || "") !== String(clip.file || "")) return 0;
  const n = +p.dur;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export function effDurOf(clip) {
  const d = prodDurOf(clip) || (+((clip && clip.dur)) || 0);
  return d / clipSpdOf(clip);
}

// ===== 轴/源职责分离（批 C C-T1 §2.2）=====
// 本仓 triml 兼任双职：①源内起点（srcTime = triml + offset×speed）②轴左边距（marginLeft / acc 累加）。
// split- 右半 triml 存的是【分割点·源秒】（接续播放起点）——若仍当轴边距用，右半会被右推一个分割点秒：
// 两半之间出空隙、轴总长虚涨。axisTrimlOf 是消费点的唯一分派口：
//   轴域（边距/累加/命中窗/几何终点）→ 走 axisTrimlOf；源域（currentTime/关键帧/源内秒）→ 照读 raw triml。
// 非 split- 前缀段轴贡献 = triml（既有语义逐点零变化）。
export function axisTrimlOf(clip) {
  return String((clip && clip.segId) || "").startsWith("split-") ? 0 : (+(clip && clip.triml) || 0);
}

// ===== 内容末端 / 轴长 =====
// clips/audioClips 形态 = store editingState.mainClips/audioClips 条目: {dur, triml, speed?, ...}
export function filmEndSec(clips, audioClips) {
  const sum = (arr) => (Array.isArray(arr) ? arr : []).reduce(
    (acc, c) => acc + effDurOf(c) + axisTrimlOf(c), 0,
  );
  const end = Math.max(sum(clips), sum(audioClips));
  return Math.ceil(end * 10) / 10;
}

// ===== 实际成片末端（批M2 R-38：游标头总时长只按有产物片段累加）=====
// 与 filmEndSec 同形状（Σ effDurOf + axisTrimlOf 取 max·ceil10），但只计 !!c.file 段——
// 未完成（占位）段不进总时长。全无产物 → 0。与游标「当前」值同系（轴域含 triml）。
export function actualFilmEndSec(clips, audioClips) {
  const sum = (arr) => (Array.isArray(arr) ? arr : []).reduce(
    (acc, c) => (c && c.file ? acc + effDurOf(c) + axisTrimlOf(c) : acc), 0,
  );
  const end = Math.max(sum(clips), sum(audioClips));
  return Math.ceil(end * 10) / 10;
}

export function axisLenSec(endSec) {
  return Math.ceil(endSec) + AXIS_TAIL_SEC;
}

// ===== 游标命中 (v38 口径 + F4 有效时长轴) =====
// 返回 { index, clip, offset } | null; offset 以片段本体起点为基准的有效轴内偏移（F4 起）——
// 消费方换算源内时间 = 片段 raw triml + offset × speed（源域直映 raw·不经 axisTrimlOf）。
export function clipAtPlayhead(clips, phTime) {
  let acc = 0;
  const arr = Array.isArray(clips) ? clips : [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    const d = effDurOf(c);
    const mlAxis = axisTrimlOf(c);
    const start = acc + mlAxis; // 本体起点 = 流位置 + 左缘偏移（轴域）
    if (phTime >= start - 0.001 && phTime < start + d - 0.001) {
      return { index: i, clip: c, offset: phTime - start };
    }
    acc += d + mlAxis;
  }
  return null;
}

// ===== 修剪 (非破坏·v37/v38/v39 三笔口径 + F4 变速换算) =====
// side="L": 向右拖(dx>0)=左缘右移(变短), 向左拖=左缘左移(变长, 入点前移); ml≥0 钳制(左缘贴前片右缘, 重叠 0)
// side="R": 宽 = startW + dx, 钳 [min, full]
// F4: 手感全程显示域（px ↔ 有效秒），落库换算源域: dur = 显示宽/pxs × speed。
// 批 C C-F1（§2.2 轴/源分离·split- 段）: L 侧 triml 写回分两域——
//   普通段 triml 兼任轴边距（axisTrimlOf ≡ raw triml）→ 轴增量直映，既有 F4 口径逐值不变；
//   split- 段轴贡献钉 0、triml 纯源域（= 分割点）→ 新 triml = 原 raw + 轴增量×speed（源秒），
//   dur 同步减同量源秒；左拉恢复的越界下界亦按源域算（不早于源起点），不越过源全长。
// 返回新 clip 对象 (不可变); dur/triml 为浮点源秒.
export function applyTrimClip(clip, side, dxPx, pxs) {
  const pxsSafe = pxs > 0 ? pxs : ZOOM_BASE;
  const spd = clipSpdOf(clip);
  const dur0 = +clip.dur || 0;
  const triml0 = +clip.triml || 0;
  const full = clip.full != null ? +clip.full : dur0 + triml0;
  const startW = (dur0 / spd) * pxsSafe;
  const minW = MIN_CLIP_SEC * pxsSafe;
  const maxW = Math.max((full / spd) * pxsSafe, minW);
  const splitSeg = String((clip && clip.segId) || "").startsWith("split-");
  const srcPerAxis = splitSeg ? spd : 1; // 轴增量 → 源秒换算系数（split- 段×speed·普通段直映）

  let w;
  let newTriml = triml0;   // 源域流内起点（L 侧回写·R 侧不动）
  let clampedL = false;
  if (side === "L") {
    w = Math.max(minW, Math.min(maxW, startW - dxPx));
    newTriml = triml0 + ((startW - w) / pxsSafe) * srcPerAxis;
    if (newTriml < 0) {
      // v38: 越界下界 = 0（左缘贴前片右缘·真实重叠 0）
      clampedL = true;
      if (splitSeg) {
        // split- 段: 源域下界 = 不早于源起点（triml_src→0·dur 回满窗宽·左拉不侵占窗口右缘）
        w = Math.max(minW, Math.min(maxW, ((triml0 + dur0) / spd) * pxsSafe));
        newTriml = Math.max(0, triml0 + ((startW - w) / pxsSafe) * spd);
      } else {
        // 普通段: 既有 v38 口径逐值不变（左缘贴回源起点·轴 margin 0）
        w = Math.max(minW, Math.min(maxW, startW + triml0 * pxsSafe));
        newTriml = 0;
      }
    }
  } else {
    w = Math.max(minW, Math.min(maxW, startW + dxPx));
  }
  const dur = (w / pxsSafe) * spd;
  const triml = side === "L" ? newTriml : triml0;
  // 剪掉量: 左剪 = ml; 右剪 = full - ml - dur (v39 按侧报告; 源秒域)
  const lcut = triml;
  const rcut = Math.max(0, full - triml - dur);
  return {
    clip: { ...clip, dur, triml, full },
    lcut,
    rcut,
    clampedL,
  };
}

// ===== 分割 (0.2s 余量拒绝 · F4: offsetSec 为有效轴内偏移 · 批C C-T1 右半独立身份) =====
// 返回 { ok: false, reason } | { ok: true, left, right }
//   left: 原位片段 (dur=offSrc, 继承 triml, full=F0 源全长)
//   right: 独立身份片段 (segId="split-"+rand, dur=dur-offSrc, triml=分割点源秒, full=F0,
//          label=base+"·续"; sid/file/n 与全部 L2 随 spread 保留)
//   余量判断在显示域（游标贴显示边缘即拒）; 落库左右 dur 为源秒（offSrc = offset × speed）。两半继承 speed。
// 批 C C-T1 裁决（docs/方案-批C-数据安全 §2.1/§2.2）：
//   ① 右半取 split- 独立身份 → 删一双/修右改左/组拖丢半段四连根治（独立命中键）。
//   ② right.triml = leftTriml + leftD = 分割点（源秒）→ 播控链原样取源内起点即续播（源域只读不换）。
//      轴位不随之外推靠 axisTrimlOf：split- 段轴贡献 0，两半相邻无缝。
//   ③ 两半 full=F0（源全长）→ 左半 full≠dur（leftD<F0 恒成立·余量拒绝保证）逃出 store noEdit 判据，
//      remount 不被涨回段全长。
export function splitClipAt(clip, offsetSec) {
  const dur = +clip.dur || 0;
  const spd = clipSpdOf(clip);
  const eff = dur / spd;
  const off = +offsetSec || 0;
  if (off < SPLIT_MARGIN_SEC || off > eff - SPLIT_MARGIN_SEC) {
    return { ok: false, reason: "游标太贴近片段边缘，没有分割余量" };
  }
  const leftD = off * spd;
  const rightD = dur - leftD;
  const leftTriml = +clip.triml || 0;
  const F0 = clip.full != null ? +clip.full : dur;   // 源全长
  const base = clip.label || `段${clip.n}`;
  const left = {
    ...clip,
    dur: leftD,
    triml: leftTriml,
    full: F0,
  };
  const right = {
    ...clip,
    segId: `split-${Math.random().toString(36).slice(2, 10)}`,
    dur: rightD,
    triml: leftTriml + leftD,
    full: F0,
    label: `${base}·续`,
  };
  return { ok: true, left, right };
}

// ===== 磁吸 (v42 件5) =====
// candidates: [{ left, right }] 侯选边缘 (轨内容 px 坐标, 已剔除拖动组自身);
// playheadX: 游标线 px; x: 指针位 px.
// 返回 { x, snapped: "edge"|"playhead"|null }
export function snapPos(candidates, x, playheadX, threshold = SNAP_THRESHOLD_PX) {
  let best = null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    for (const edge of [c.left, c.right]) {
      if (edge == null) continue;
      const d = Math.abs(edge - x);
      if (d <= threshold && (!best || d < best.d)) best = { d, x: edge, kind: "edge" };
    }
  }
  if (playheadX != null) {
    const dph = Math.abs(playheadX - x);
    if (dph <= threshold && (!best || dph < best.d)) best = { d: dph, x: playheadX, kind: "playhead" };
  }
  return best ? { x: best.x, snapped: best.kind } : { x, snapped: null };
}

// ===== 缩放 =====
export function clampZoom(v) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v)));
}
export function zoomPct(pxs) {
  return Math.round((pxs / ZOOM_BASE) * 100);
}

// ===== 刻度尺 =====
// 返回 { labelStep, minorStep } (v43 :4099-4100 分档)
export function rulerSteps(pxs) {
  return {
    labelStep: pxs >= 48 ? 1 : pxs >= 24 ? 2 : pxs >= 14 ? 5 : 10,
    minorStep: pxs >= 24 ? 1 : pxs >= 14 ? 2 : 5,
  };
}

// ===== 游标逐帧步进 =====
export function stepPlayhead(phTime, frames, endSec) {
  const next = phTime + frames * FRAME_SEC;
  return Math.max(0, Math.min(endSec, next));
}

// ===== 格式化 (游标标签：<1h 用 MM:SS·≥1h 用 H:MM:SS) =====
//   批 A T4：原口径硬编码 "00:"+SS → 超 1 分钟显示 00:75（老板「时间显示正确」）。
//   下游六处消费同源受益：游标头 #phHead / 标尺读数 #phTime / 暂停 toast /
//     标记列表三处（打点 toast·旗标 title·行内位置）/ 对比窗时间码。
export function fmtClock(sec) {
  const t = Math.floor(Math.max(0, sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function fmtDur(sec) {
  return (+sec).toFixed(1).replace(/\.0$/, "");
}
