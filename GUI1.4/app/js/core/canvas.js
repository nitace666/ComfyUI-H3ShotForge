// GUI 1.3 创作画布域逻辑 — 纯函数模块 (S1-4 任务 T2).
//
// === 出处注记 (S1-4 取用纪律) ===
// 自 v43 原型画布 JS 转正改写 (布局示意-项目工作区交互原型-v43-2026-09-24.html):
//   checkConnLegality  ← v43 :5979-5997 (v19 数据流方向合法性矩阵)
//   checkProcOrder     ← v43 :5998-6009 (v19 顺序锁死: interp→sr 拒绝)
//   refsParse/syncRefEdges ← v43 :6147-6260 (v17 单2: @N 引用 ↔ 资产节点/边同步·orphan 保留)
//   histPush/histGo    ← v43 :6355-6399 (v36 画布历史 30 步·同态去重·截断 redo)
//   zoomAt/zoomStep    ← v43 :5006-5022 (v24 滚轮缩放·鼠标锚点·0.25~2.0) + :4970-4984 (步进 0.1)
//   clientToWorld      ← v43 :5957-5968
//   findOverlapSegNode ← v43 :5068-5078 (单输入拒绝的段重叠检测)
//   initFromProject    ← v43 :4441-4510 (CBInit: G 广播 + seg 按分镜表 + asset 按 @N 引用)
// v43 本体永不修改; 行为基准 = docs\v43-行为基线清单.md E 节.
//
// 依赖单向: 本模块不 import views（core 纪律）；#92 B2 起引 core/i18n.js（连线合法性 msg 白话入典
//   canvas.conn.*·zh 与源码字面量逐字一致；i18n 依赖链 server_storage 不回指本模块·无环）。
//   数据源 = store.editingState.canvas (三视图同源铁律).
import { t } from "./i18n.js";   // #92 B2：checkConnLegality/checkProcOrder msg 取词（运行期调用·非顶层）

// ===== 常量 =====
export const SCALE_MIN = 0.25;   // v21 N4: 25%~200%
export const SCALE_MAX = 2.0;
export const SCALE_STEP = 0.1;   // cb-zoombox 步进 (E010)
export const WHEEL_FACTOR = 1.1; // v24 滚轮缩放因子
export const HIST_MAX = 30;      // v36 画布历史 30 步 (E020)

// ===== 缩放/视口 =====
export function clampScale(s) {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, s));
}
// v43 :5006-5022: 滚轮缩放以鼠标为锚 — mx/my 相对 cbRoot 左上角; deltaY<0 = 放大
export function zoomAt(viewport, mx, my, deltaY) {
  const oldS = +viewport.scale || 1;
  const f = deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
  const ns = clampScale(oldS * f);
  return {
    tx: mx - (mx - (+viewport.tx || 0)) * (ns / oldS),
    ty: my - (my - (+viewport.ty || 0)) * (ns / oldS),
    scale: ns,
  };
}
// delta = 绝对步长（v43 CBZoomStep(±0.1) 口径；±1 语义为视图层方向，域层不做二次乘）
export function zoomStepScale(scale, delta) {
  return clampScale((+scale || 1) + (+delta || 0));
}
export function clientToWorld(clientX, clientY, rootRect, viewport) {
  return {
    x: (clientX - rootRect.left - (+viewport.tx || 0)) / (+viewport.scale || 1),
    y: (clientY - rootRect.top - (+viewport.ty || 0)) / (+viewport.scale || 1),
  };
}

// ===== 连线合法性 (v19·E013) =====
// fromType=上游/拖动方, toType=下游/落点; 返回 {ok} | {ok:false, msg}
export function checkConnLegality(fromType, toType) {
  if (fromType === "asset" && toType === "seg") return { ok: true };
  if (fromType === "seg" && (toType === "proc" || toType === "preview")) return { ok: true };
  if (fromType === "proc" && (toType === "proc" || toType === "preview")) return { ok: true };
  if (fromType === "preview") return { ok: false, msg: t("canvas.conn.pvEnd") };
  if (fromType === toType) return { ok: false, msg: t("canvas.conn.sameType") };
  if (fromType === "global") return { ok: false, msg: t("canvas.conn.gNoOut") };
  return { ok: false, msg: t("canvas.conn.direction") };
}
// 顺序锁死 (v19): 仅 sr→interp 允许; interp→sr 拒绝 (E016 注记: 帧率收敛归 S2-3 M4)
export function checkProcOrder(srcSub, tgtSub) {
  if (srcSub === "interp" && tgtSub === "sr") {
    return { ok: false, msg: t("canvas.conn.order") };
  }
  return { ok: true };
}

// ===== 单输入拒绝 (v19·E013): 段节点 220×130 命中检测 (v43 :5068-5078) =====
export const SEG_NODE_W = 220;
export const SEG_NODE_H = 130;
export function findOverlapSegNode(nodes, procNode) {
  if (!procNode || procNode.type !== "proc") return null;
  const px = (+procNode.x || 0) + 105;
  const py = (+procNode.y || 0) + 60;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.type !== "seg") continue;
    if (px >= (+node.x || 0) && px <= (+node.x || 0) + SEG_NODE_W
      && py >= (+node.y || 0) && py <= (+node.y || 0) + SEG_NODE_H) {
      return node;
    }
  }
  return null;
}

// ===== @N / @资产名 引用 ↔ 资产节点/边同步 (v17 单2·E015) =====
// segN=null 表示全局提示词; 引用消失删边但保留资产节点标 orphan (Q3 拍板)
// nameIndex: 可选 [{n, name, kind?, media?}] 视图注入（T2·prompt.getCachedAssets 映射）；
//   本模块不构建不 import（core 纯函数铁律）·未注册名跳过不建节点不建边（J-P10 同口径）
// 一位一匹配（重要3）: 每个 @ 位先按名字最长前缀命中并消费该位·未命中再按数字
//   —— 防「注册名数字开头」双规则齐中产生双节点脏数据
export function refsParse(text, nameIndex) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  const seen = new Set();
  const names = [];
  for (const it of Array.isArray(nameIndex) ? nameIndex : []) {
    if (!it || typeof it.name !== "string" || !it.name || !Number.isFinite(+it.n)) continue;
    names.push(it);
  }
  names.sort((a, b) => b.name.length - a.name.length); // 最长前缀优先（本地副本排序·不改入参）
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf("@", i);
    if (at < 0) break;
    let len = 0; // 命中后需跳过的字符数（@ + 名字/数字）
    for (const it of names) {
      if (!s.startsWith(it.name, at + 1)) continue;
      const after = s[at + 1 + it.name.length] || "";
      if (after && /[0-9A-Za-z_]/.test(after)) continue; // 词边界（引擎同款·submit.js scanMentionNames）
      const n = +it.n;
      if (!seen.has(n)) { seen.add(n); out.push(n); }
      len = 1 + it.name.length;
      break;
    }
    if (!len) {
      const m = /^\d+/.exec(s.slice(at + 1));
      if (m) {
        const n = +m[0];
        if (!seen.has(n)) { seen.add(n); out.push(n); }
        len = 1 + m[0].length;
      }
    }
    i = len ? at + len : at + 1; // 未命中 → 位进 1 防死循环
  }
  return out;
}
// 返回 {nodes, edges, changed}; nodes/edges 为新数组 (原位元素保留引用);
// changed = 终态(边集/节点集/orphan 标记)相对入参是否变化 (幂等重放 → false·终态对比不按过程计)
// nameIndex 仅透传给 refsParse —— @名字解析出的 n 与 @数字同路（节点 id="A"+n·删除边判定/orphan 判定零改）
export function syncRefEdges(nodes, edges, text, segN, nameIndex) {
  const refs = refsParse(text, nameIndex);
  const isGlobal = segN == null;
  const segId = isGlobal ? null : "S" + segN;
  // 1. 删范围内旧引用边 (v43 :6163-6170 destroy-rebuild 语义)
  const kept = [];
  for (const e of edges) {
    const drop = isGlobal
      ? (e.from === "G" && /^A\d+$/.test(e.to))
      : (e.to === segId && /^A\d+$/.test(e.from));
    if (!drop) kept.push(e);
  }
  // 2. 新引用集: 缺则建节点 (orphan 初始) + 建边
  const nextNodes = nodes.slice();
  const srcNode = isGlobal
    ? nextNodes.find((n) => n.id === "G")
    : nextNodes.find((n) => n.id === segId);
  refs.forEach((n, i) => {
    const aid = "A" + n;
    let node = nextNodes.find((x) => x.id === aid);
    if (!node) {
      node = {
        id: aid, type: "asset", label: "@" + n,
        x: srcNode ? (+srcNode.x || 0) + 60 : 40,
        y: srcNode ? (+srcNode.y || 0) + 160 + i * 120 : 320 + i * 120,
        data: { n, name: "@" + n, kind: "prop", orphan: true }, // 名字由资产库缓存填充
      };
      nextNodes.push(node);
    }
    const edge = isGlobal ? { from: "G", to: aid } : { from: aid, to: segId };
    if (!kept.some((e) => e.from === edge.from && e.to === edge.to)) kept.push(edge);
  });
  // 3. orphan 统一判定: 无任何边触及的资产节点 = orphan (引用消失删边保留节点·Q3 拍板)
  for (const node of nextNodes) {
    if (node.type !== "asset") continue;
    const touched = kept.some((e) => e.from === node.id || e.to === node.id);
    if (!!node.data.orphan !== !touched) node.data = { ...node.data, orphan: !touched };
  }
  // 4. 终态对比定 changed
  const edgeKeys = (arr) => arr.map((e) => e.from + "→" + e.to).sort().join("|");
  const orphanSig = (arr) => arr.filter((n) => n.type === "asset")
    .map((n) => n.id + ":" + (n.data.orphan ? 1 : 0)).sort().join("|");
  const changed = edgeKeys(edges) !== edgeKeys(kept)
    || nodes.length !== nextNodes.length
    || orphanSig(nodes) !== orphanSig(nextNodes);
  return { nodes: nextNodes, edges: kept, changed };
}

// ===== 节点 ID 生成（三审裁决修复·F-B3 终解） =====
// 按存量节点最大数字后缀+1（修正笔②的 "(\d+)" 字符串转义退化教训——此处用 [0-9] 无转义歧义）
export function nextIdOf(nodes, prefix) {
  let max = 0;
  for (const n of nodes || []) {
    const m = String(n.id).match(new RegExp("^" + prefix + "([0-9]+)$"));
    if (m) max = Math.max(max, +m[1]);
  }
  return prefix + (max + 1);
}

// ===== 六段式骨架预填装配（S2-4 d4 · 引擎 api.md:676-684） =====
// 段序固定·无图版（t2v）口径；中文 desc 经 {DESC} 槽位直嵌 subject_definitions 首行
// （老板裁：中文直接嵌英文骨架·不加翻译；保留 token = partially_preserved 仅 ref2v 用·本函数不触及）
export const SIX_SEG_SKELETON_LABELS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];
export const SIX_SEG_RETENTION_T2V = "No reference image is used. The subject is generated strictly from the written description above.";
export function assembleSixSegSkeleton(existingText) {
  const raw = (existingText == null ? "" : String(existingText)).replace(/\s+/g, " ").trim();
  const subject = raw || "<DESC>";
  return [
    "subject_definitions: " + subject,
    "summary: <一句话英文概述>",
    "retention_analysis: " + SIX_SEG_RETENTION_T2V,
    "detailed_description: <画面细节英文描述>",
    "overall_soundscape: <环境声描述>",
    "non_diegetic_music: N/A",
  ].join("\n");
}
// 二次点击防护：节点已有六段结构（检测 subject_definitions: 行）→ toast 提示不重复插入
export function hasSixSegSkeleton(text) {
  if (!text) return false;
  return /(^|\n)\s*subject_definitions\s*:/m.test(String(text));
}

// ===== 画布历史 30 步 (v36·E020/E022) =====
export function canvasSig(snap) {
  return JSON.stringify([snap.nodes, snap.edges, snap.projectName || ""]);
}
export function canvasSnapOf(canvas) {
  return {
    nodes: (canvas.nodes || []).map((n) => ({ ...n, data: JSON.parse(JSON.stringify(n.data || {})) })),
    edges: (canvas.edges || []).map((e) => ({ from: e.from, to: e.to })),
    projectName: canvas.projectName || "",
  };
}
export function histPush(hist, snap) {
  const sig = canvasSig(snap);
  const top = hist.stack[hist.idx];
  if (top && canvasSig(top) === sig) return { hist, changed: false }; // 同态去重
  const stack = hist.stack.slice(0, hist.idx + 1); // 截断 redo 尾巴
  stack.push(snap);
  if (stack.length > HIST_MAX) stack.shift();
  return { hist: { base: hist.base, stack, idx: stack.length - 1, lock: hist.lock }, changed: true };
}
export function histGo(hist, dir) {
  const i = hist.idx + dir;
  if (i < 0) return { hist, atStart: true };
  if (i >= hist.stack.length) return { hist, atEnd: true };
  return { hist: { ...hist, idx: i, lock: true }, snap: hist.stack[i], atStart: false, atEnd: false };
}

// ===== 键盘热键守门+动作分派（批 M1 R-36·方案 §三 R-36.2/3/4）=====
// 纯函数：视图层薄壳绑定（监听+分派+DOM 操作），守门语义全在此判定。
// 返回 {act, payload}|"none"；state = {hasSel, selType, typing, modalOpen, clip}。
//   act: copy/paste/del/delDenied/undo/redo；"none" = 未命中或被守门拦下（视图不 preventDefault）。
//   payload 仅在有可携数据时给：paste 携剪贴节点（视图直落 dupNode 链路），其余省略。
// 守门链（照抄 edit.js A13 先例）：typing 全放行原生 → modalOpen 全不响应 → 组合分派。
//   seg 禁复制（A11 复制体共享 segId 数据破坏隐患）；global 禁复制不可删。
export function canvasHotkeyOf(ev, state) {
  if (!ev || !state) return "none";
  if (state.typing) return "none";      // 输入保护：INPUT(非 range)/TEXTAREA/SELECT/contentEditable 全放行
  if (state.modalOpen) return "none";   // 弹窗豁免（.mbox-wrap / 预览弹窗 show）：热键全不响应
  const k = (ev.key || "").toLowerCase();
  if (ev.ctrlKey || ev.metaKey) {
    if (k === "c") {
      if (!state.hasSel) return "none";
      if (state.selType === "seg" || state.selType === "global") return "none";
      return { act: "copy" };
    }
    if (k === "v") {
      if (!state.clip) return "none";
      return { act: "paste", payload: state.clip };
    }
    if (k === "z" && !ev.shiftKey) return { act: "undo" };
    if (k === "y" || (k === "z" && ev.shiftKey)) return { act: "redo" };
    return "none";
  }
  if (ev.key === "Delete" || ev.key === "Backspace") {
    if (!state.hasSel) return "none";
    if (state.selType === "global") return { act: "delDenied" };
    return { act: "del" };
  }
  return "none";
}

// ===== 从项目初始化画布 (v43 CBInit :4441-4510 转正·三视图同源) =====
// G 广播节点 + seg 节点(按 segments) + G→S 全量广播边 + asset 节点(按各段/全局提示词 @N/@名字) + A→S 引用边
// nameIndex 可选: 同 syncRefEdges —— 首次开项目 @名字也连线（views 注入·本模块不构建）
export function initFromProject(project, nameIndex) {
  const segments = (project && Array.isArray(project.segments)) ? project.segments : [];
  const nodes = [{
    id: "G", type: "global", label: "全局参数", x: 40, y: 60,
    data: { expanded: false, prompt: (project && project.globalPrompt) || "" },
  }];
  const edges = [];
  const usedAssets = new Set();
  const globalRefs = refsParse((project && project.globalPrompt) || "", nameIndex);
  segments.forEach((seg, i) => {
    const n = i + 1;
    nodes.push({
      id: "S" + n, type: "seg", label: "段" + n,
      x: 460, y: 60 + i * 130,
      data: {
        segId: seg.id, n,
        prompt: seg.prompt || "",
        dur: typeof seg.durationSec === "number" ? seg.durationSec : 5,
        seed: seg.seed != null ? seg.seed : "",
        status: "wait",
      },
    });
    edges.push({ from: "G", to: "S" + n });
    for (const r of refsParse(seg.prompt || "", nameIndex)) usedAssets.add({ n: r, segN: n });
  });
  // 资产节点 + 引用边 (名字填充交给资产库缓存通道; 摆位在 G 下方纵列)
  let ay = 320;
  const assetNs = [...new Set([...globalRefs, ...[...usedAssets].map((u) => u.n)])];
  for (const an of assetNs) {
    nodes.push({ id: "A" + an, type: "asset", label: "@" + an, x: 40, y: ay, data: { n: an, name: "@" + an, kind: "prop", orphan: true } });
    ay += 120;
  }
  for (const u of usedAssets) edges.push({ from: "A" + u.n, to: "S" + u.segN });
  for (const g of globalRefs) edges.push({ from: "G", to: "A" + g });
  return { nodes, edges };
}
