// GUI 1.3 导出组装器（批 H T2）— editingState → 导出 spec 纯函数族.
//
// === 出处注记（批 H 方案 v3 §一 T2 行·docs/方案-批H-导出渲染管线-2026-10-06.md）===
// spec 契约与 T1 伴生端点逐字段对齐（scripts/devserver.py _normalize_spec，消费侧已上线不可偏离）：
//   main = {file, triml, dur, speed, volume, fadeIn, fadeOut, splitAV, segId[, xfade]}
//   bgm  = {file, offset, volume, triml, winDur, fadeIn, fadeOut[, segId][, speed]}
// outDir = 可选新增顶层键（J-P5·docs/方案-JP5-导出路径可选-2026-10-07.md 裁决 1）：仅本机目录，
//   消费侧 devserver _normalize_spec 四步校验（拒 .. 段→isabs→盘符/UNC→realpath 归一）；
//   非空才落键（空=引擎 output 根·现状零变化）。
// segId = 段身份（GUI 侧关联键·服务端 _normalize_spec 不消费·锚定条 winDur 回写用）。
// winDur/offset = 组装器现算专有字段（v3 I-1 钉死·零新增 store 键）：
//   winDur = dur/speed（effDurOf 同式·timeline.js）·offset = 条在轨上的成片内起点（audioWindowAt 同式几何）。
// dur 字段值 = store 现值；真实时长由 mergeProbedDurations 在 T3 流程按 probe 源内可取窗收窄
//   （dur=min(字段, probe 全片长 - triml)·再 clamp；失败兜底 dur+clamp）。
//
// === 窗表共源选型注记（方案 v2 S2）===
// trackWindowsOf 即 audioWindowAt（edit.js）内联主轨窗累加式的抽源版，两处同 import 本函数（防复制漂移）；
// 其累加式与 timeline.clipAtPlayhead 恒等（单测探针交叉断言钉住）。不落 timeline.js 的原因：本任务
// 文件预算 3（exportSpec+test+edit.js 挂点），edit.js 反向 import core 为既有依赖方向。
//
// 锚定条（splitAV 音频半·segId 锚父段）口径：file 取条自身（split 时从父段复制的快照——
//   edit.js splitAudioFromClip 落库形态·预听 audioAlignFrame 同消费 w.clip.file，所见即所得）；
//   几何（offset/winDur/triml）随父段现值（audioWindowAt 锚定分支同式）；volume/fade 取条自身。
//
// === 批 H T7 新增三键（xfade / bgm.segId / bgm.speed）口径注记 ===
//   main[].xfade   = {name, dur}·该段与**下一段**的交界转场（编辑态挂前段·出口语义）；
//                   dur=编辑态 sec 原值；未知标签/非正时长不落键（降级硬切·列 skipped）。
//   bgm[].segId    = 仅锚定条带（关联键·mergeProbedDurations 据此回写 winDur）；轴条不带。
//   bgm[].speed    = 仅锚定条带父段 speed 且 ≠1 时落键（服务端 atempo 变速·源域读长 ×speed）；
//                   轴条不带（预听轴窗期恒 1x·与预听对齐）。
// 纯函数：不读 DOM / 不发请求 / 不改入参（不可变返回）。

import { effDurOf, axisTrimlOf, clipSpdOf } from "./timeline.js";
import { normalizeClipL2 } from "../store/store.js";

// ===== 转场映射（批 H T7·裁决 A·映射表在 GUI 组装器·伴生薄原则）=====
// 编辑态存中文标签（批 E 裁决「转场存中文标签」·edit.js TRANS_TYPES）→ 服务端 ffmpeg xfade 真名。
// 8 键一一对应·真名经 `ffmpeg -h filter=xfade` 实测枚举号钉死（0/12/13/5/6/7/8/19·TDD 注记）。
export const XFADE_MAP = Object.freeze({
  叠化: "fade",
  黑场: "fadeblack",
  白场: "fadewhite",
  左移: "slideleft",
  右移: "slideright",
  上滑: "slideup",
  下滑: "slidedown",
  圆形展开: "circleopen",
});

// hasOwnProperty 查表（原型链键如 "constructor"/"toString" 不得命中映射·脏档标签防注入）。
const xfadeNameOf = (type) =>
  typeof type === "string" && Object.prototype.hasOwnProperty.call(XFADE_MAP, type) ? XFADE_MAP[type] : null;

// ===== 轨窗表（共源底座）=====
// 累加式 = audioWindowAt 主轨窗内联式逐字同源：start = acc + axisTrimlOf(c)，acc += effDurOf(c) + axisTrimlOf(c)。
// 返回 [{clip, start, end}]（数组序·1:1 对应入参序）；split- 段轴贡献 0 由 axisTrimlOf 分派。
export function trackWindowsOf(clips) {
  const arr = Array.isArray(clips) ? clips : [];
  const wins = [];
  let acc = 0;
  for (const c of arr) {
    const d = effDurOf(c), ml = axisTrimlOf(c);
    const start = acc + ml;
    wins.push({ clip: c, start, end: start + d });
    acc += d + ml;
  }
  return wins;
}

// ===== 读侧钳制（口径对齐既有消费点·防脏档打穿 T1 硬门槛）=====
const clampDur = (n) => Math.min(600, Math.max(0.1, n));            // G-T8b probe 域（edit.js probeVideoDuration 同式）
const clampFade5 = (v) => Math.min(5, Math.max(0, Math.round((+v || 0) * 10) / 10)); // edit.js clampFade 读侧口径
const clampVol = (v) => Math.min(1, Math.max(0, v));                // previewSurfaceOf 消费侧钳制同式
const num0 = (v) => Math.max(0, +v || 0);

// ===== buildExportSpec(state, opts) → { spec, skipped } =====
// opts = {w, h, fps, out?, outDir?}（T3 传用户选定值·本函数只透传；out 缺省不落键=T1 服务端默认名·
// outDir 缺省不落键=引擎 output 根·J-P5）。
// 无 file 段（new- 占位段）/时长非正段跳过 → skipped（T3 弹窗列明用）；mutedAudio=true → bgm 产出为空（裁决 5）。
export function buildExportSpec(state, opts) {
  const st = state || {};
  const o = opts || {};
  const mains = Array.isArray(st.mainClips) ? st.mainClips : [];
  const auds = Array.isArray(st.audioClips) ? st.audioClips : [];
  const skipped = [];
  const main = [];
  const mainMeta = [];   // 与 main 同序：{segId, n, label, tr}（交界转场按前段取用·段数变化不影响配对）
  for (const c of mains) {
    const meta = { segId: (c && c.segId) || undefined, n: c && c.n, label: (c && c.label) || "片段" };
    if (!c || !c.file) { skipped.push({ ...meta, reason: "无源产物（占位段）" }); continue; }
    const dur = +c.dur || 0;
    if (!(dur > 0)) { skipped.push({ ...meta, reason: "时长非正" }); continue; }   // T1 dur>0 硬门槛·防整体 400
    const l2 = normalizeClipL2(c);
    main.push({
      file: c.file,
      triml: num0(c.triml),
      dur,
      speed: clipSpdOf(c),       // 非正脏值回 1（与 effDurOf 同式·防 T1 speed<=0 拒收）
      volume: clampVol(l2.volume),
      fadeIn: clampFade5(l2.fadeIn),
      fadeOut: clampFade5(l2.fadeOut),
      splitAV: l2.splitAV,
      segId: (c && c.segId) || undefined,   // 段身份·锚定条 winDur 回写的关联键（裁决 D·服务端不消费）
    });
    mainMeta.push({ ...meta, tr: l2.transition });
  }
  // 交界转场 → main[i].xfade（侦察：clip.transition 挂前一片段·交界语义 = 前段出口·末段无交界不落）。
  // 未知标签/时长非正 → 不进 spec（该交界退化为硬切）且各列一条 skipped（T3 弹窗列明用）。
  for (let i = 0; i < main.length - 1; i++) {
    const tr = mainMeta[i].tr;
    if (!tr) continue;
    const { segId, n, label } = mainMeta[i];
    const name = xfadeNameOf(tr.type);
    if (!name) { skipped.push({ segId, n, label, reason: `未知转场类型「${tr.type}」·该交界不转场` }); continue; }
    const d = +tr.sec;
    if (!(d > 0) || !Number.isFinite(d)) { skipped.push({ segId, n, label, reason: "转场时长非正·该交界不转场" }); continue; }
    main[i].xfade = { name, dur: d };
  }
  const bgm = [];
  if (!st.mutedAudio) {          // 轨级过滤在组装器（裁决 5：BGM 轴窗条+锚定条全体不进成片）
    const byMainSeg = new Map(); // 锚定判断式 = audioWindowAt 同款「主轨存在同 segId 段」·首个同段（wins.find 同序）
    for (const w of trackWindowsOf(mains)) {
      const s = String((w.clip && w.clip.segId) || "");
      if (s && !byMainSeg.has(s)) byMainSeg.set(s, w);
    }
    const audWins = trackWindowsOf(auds);   // 全量数组（锚定条占轴位——clipAtPlayhead 同式·轴条 offset 不漂）
    for (let i = 0; i < auds.length; i++) {
      const a = auds[i];
      const anchor = byMainSeg.get(String((a && a.segId) || ""));
      const label = (a && a.label) || "音频条";
      if (!a || !a.file) { skipped.push({ label, reason: anchor ? "锚定条无源文件" : "无源文件" }); continue; }
      const geo = anchor ? anchor.clip : a; // 锚定：几何随父段现值·轴条：几何取自身
      const winDur = effDurOf(geo);
      if (!(winDur > 0)) { skipped.push({ label, reason: "窗长非正" }); continue; }   // T1 winDur>0 硬门槛
      const l2 = normalizeClipL2(a);
      const extra = {};
      if (anchor) {
        // 锚定条：speed 取父段（预听锚定期跟随主轨 speed·edit.js:1929 边界①）+ segId 供 probe 回写关联。
        // 轴条不带 speed（预听轴窗期恒 1x·edit.js:1929 边界②·服务端缺省 1）。
        extra.segId = String(a.segId);
        const spd = clipSpdOf(anchor.clip);
        if (spd !== 1) extra.speed = spd;
      }
      bgm.push({
        file: a.file,
        offset: anchor ? anchor.start : audWins[i].start,
        volume: clampVol(l2.volume),
        triml: num0(geo.triml),
        winDur,
        fadeIn: clampFade5(l2.fadeIn),
        fadeOut: clampFade5(l2.fadeOut),
        ...extra,
      });
    }
  }
  const spec = { video: { w: o.w, h: o.h, fps: o.fps }, mutedMain: !!st.mutedMain, main, bgm };
  if (o.out) spec.out = String(o.out);
  if (o.outDir) spec.outDir = String(o.outDir);   // J-P5 可选新增·仅本机目录（消费侧 devserver 四步校验）
  return { spec, skipped };
}

// ===== mergeProbedDurations(spec, probed) → 新 spec =====
// probed = T1 probe 端点应答 files（[{file, w, h, fps, duration}]·缺省/失败容错）。
// dur 收窄为 min(字段 dur, 源内可取窗)·可取窗 = probe 全片长 - triml（H-T6 真机门缺陷修复：
//   旧实现用全片长盲覆盖 dur 未扣 triml → devserver total=Σdur/speed 虚长 Σ(triml/speed)·
//   apad 补静音·成片音轨长于视频轨）；同 file 多段共享；缺项/非有限 → 沿用 dur 字段；
//   两路同过 clamp [0.1,600]（G-T8b）。字段 dur 本身正确时不被顶大。
// bgm 不动（winDur=窗长非源长·probe 时长语义不适用）。
export function mergeProbedDurations(spec, probed) {
  const byFile = new Map();
  for (const p of Array.isArray(probed) ? probed : []) {
    const d = p && +p.duration;
    if (p && typeof p.file === "string" && Number.isFinite(d)) byFile.set(p.file, d);
  }
  const main = ((spec && spec.main) || []).map((m) => {
    const d = +m.dur || 0;
    const avail = byFile.has(m.file) ? byFile.get(m.file) - num0(m.triml) : d;
    return { ...m, dur: clampDur(Math.min(d, avail)) };
  });
  // 锚定条 winDur 随父段修正值回写（批 H T7·裁决 D）：按 segId 关联（组装器已把 segId 带进 bgm），
  //   winDur = 修正后父段 dur/speed（effDurOf 同式）——父段产物被截短时锚定音频窗不再超视频。
  //   轴条（无 segId）与未被 probe 收窄的父段 → 窗长维持组装器现算值。
  const bySeg = new Map();
  for (const m of main) if (m.segId) bySeg.set(String(m.segId), m);
  const bgm = ((spec && spec.bgm) || []).map((b) => {
    const p = b.segId ? bySeg.get(String(b.segId)) : null;
    return p ? { ...b, winDur: (+p.dur || 0) / (+p.speed || 1) } : b;
  });
  return { ...(spec || {}), main, bgm };
}
