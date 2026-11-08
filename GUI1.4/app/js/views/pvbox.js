// pvbox.js — 设定 TAB 分镜表下方四块（批 R6 · ③b #013-#016 + CSS #021-#023）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 四块 DOM :1552-1579（.pv-box / .poolbar / .psummary / .fbx · 分镜表下方平级顺序）
//   - 选中联动 :3383-3391 selCard + :6617 初始选段1（本仓选中通道 = segcards 选中态 R6 补齐）
//   - 拖资产进段卡 :6603-6610（本模块只发拖拽载荷 text/x-asset-n，落词在 segcards drop 通道）
//   - 预检通道：views/submit-bar.js validateAssignmentPolicy（S3-1 T3 三档分配策略·提交同源）
//
// === 任务边界 ===
// 实装：四块 DOM + 数据接线（选中段切换 / store 段与全局词 / @N 注册表 / 预检纯函数）
// 不实装（按实况态呈现并汇报）：
//   - 引擎 400 detail 明细：无既有通道（renderPreflightModalContent 只在提交失败弹窗消费）
//     → fbx 末行按「尚无提交记录」实况态呈现
//   - 引擎忙真实态：409 busy 仅在提交链路产生 → fbx 保留原型 inh 指引文案
//
// === API ===
//   SHORT_PROMPT_CHARS     短提示词阈值（≤12 字判过短 · 原型 :1574「12 字」口径）
//   buildRefMap(registry, assets)      → { [n]: {n, name, desc} }（@N 注册表 + 卡 memo）
//   buildPvPreview(segPrompt, gp, refMap) → 合成预览文本（@N→卡描述 + 全局词追加）
//   sumDuration(segments)  → 段时长和（预计时长）
//   refUsage(segments, registry)       → [{n, name, count}] 按 @N 升序（count = 段数）
//   formatRefUsage(list)   → 「卡名×3 · 卡名×2 · 另有 N 项资产未被引用」/ 「—」（I 块：0 次不逐列·折叠末尾一行）
//   shortPromptWarnings(segments)      → [{segIndex, chars}]
//   unreferencedRefs(segments, registry) → [{n, name}]（0 段引用）
//   poolUsageCounts(opts)  → {Picture, Video, Audio}（批 8 T5：占用槽数 = computeOccupancy
//                             口径·绑定+手动+@N 三来源合计；入参同 computeOccupancy）
//   buildCheckLines(opts)  → [{state:'okk'|'warn', text}]（fbx 检查行）
//   mount(container, projectId) → container（四块直接平级挂入·无包裹壳）
//   refreshNow()            → 手动刷新当前挂载
//   _teardownForTests()     → 退订 + 摘除
//
// === 批 8 T5（G3 手动槽 + 真实占用 + 拖卡双通道）===
//   A. poolbar 内三 kind 手动槽胶囊行（Picture 9/Video 3/Audio 3 · SLOT_RANGES）：
//      占用态 = media 文件名缩略 + 「来自：卡名」徽标（legacy refreshOwnerMarks 语义）+
//      清除钮（setPoolManual 落库）；Picture 9 号手动可用（与绑定域 1-8 不同）；
//      绑定占用槽（computeOccupancy 标签 binding:卡名）虚线标记，与手动同 idx → 「绑定优先」
//   B. 「图 X/9」计数改占用槽数（poolUsageCounts → computeOccupancy）
//   C. 通道②：拖资产卡（ASSET_DT_MIME 卡 JSON）/素材池胶囊（text/x-asset-n @N）落
//      手动槽胶囊 = 填槽（老板待裁④：拖卡落手动槽=算填槽·usages 取卡行 usage 或默认）；
//      通道①（拖胶囊落段卡=@N）在 segcards drop 链·本模块零改；通道③在 assigner-panel
//
// === 老板裁决⑤甲（2026-10-25）：批级视频槽整排隐藏 ===
//   素材池「视频 N/3」排（计数 pill + Video 槽位行 + hover 提示文案）整排不渲染：
//   批级 Video 手动槽不参与引擎生成（引擎 F-N2 剔除·仅预览显示），留在素材池只增困惑。
//   数据域零改动：poolManual.Video 照常读写/落库（写侧克隆三 kind 容器·提交链口径不变），
//   只是素材池无入口；参考视频统一走段卡拍摄控制里的段级槽（segcards.js·不动）。

import { load as storeLoad, subscribe as storeSubscribe, unsubscribe as storeUnsubscribe, setPoolManual } from "../store/store.js";
import {
  ASSET_DND_TYPE,
  ensureAssetContext,
  getAssetContext,
  getSelectedSegId,
  subscribeSelected,
} from "./segcards.js";
import { validateAssignmentPolicy } from "./submit-bar.js";
import { computeOccupancy } from "../core/submit.js";
import { ASSET_DT_MIME, parseAssetPayload } from "../core/assigner.js";
import { USAGE_CATALOG, SLOT_RANGES } from "../core/assets_api.js";
import { hydrateIcons } from "../ui/icons.js";
import { t } from "../core/i18n.js";   // #89 T2b：显示文案入典（zh 原文=键值·en 见 core/i18n.js）

// ===== 阈值 =====
// 原型 :1574 点名「段4 提示词过短（12 字）」→ 12 字被判过短，故阈值取 ≤12
export const SHORT_PROMPT_CHARS = 12;

// ===== 纯函数 =====

/** @N 注册表 {n: 卡名} + 引擎卡 {卡名: card} → {n: {n, name, desc}}（desc = 卡 memo） */
export function buildRefMap(registry, assets) {
  const reg = (registry && typeof registry === "object" && !Array.isArray(registry)) ? registry : {};
  const ast = (assets && typeof assets === "object" && !Array.isArray(assets)) ? assets : {};
  const out = {};
  for (const key of Object.keys(reg)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1) continue;
    const name = reg[key];
    if (typeof name !== "string" || !name) continue;
    const card = ast[name] || {};
    out[n] = { n, name, desc: typeof card.memo === "string" ? card.memo : "" };
  }
  return out;
}

/**
 * 注册表 → 名字索引 {name: {name, desc}}（@名字 通道用）——按名字长度倒序 = 最长前缀匹配，
 * 防短名先命中截断长名（registry 含「概念帧 20260926-0823」与「概念帧 20260926-0823·裁剪」）。
 */
function buildNameIndex(refMap) {
  const map = (refMap && typeof refMap === "object") ? refMap : {};
  const entries = [];
  const seen = new Set();
  for (const key of Object.keys(map)) {
    const info = map[key];
    const nm = info && typeof info.name === "string" ? info.name : "";
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    entries.push([nm, info]);
  }
  entries.sort((a, b) => b[0].length - a[0].length);
  return entries;
}

// 词边界口径同引擎 replace_cast_names（batch_core.py:1919 (?<![0-9A-Za-z_])名字(?![0-9A-Za-z_])）
//   —— 名字后紧跟标识符字符时不命中，避免 GUI 认得出名字而引擎替换不了（两端口径必须一致）
function scanMentionNames(text, refMap) {
  const entries = buildNameIndex(refMap);
  if (!entries.length) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    let info = null;
    let len = 0;
    for (const [nm, inf] of entries) {
      if (!text.startsWith(nm, at + 1)) continue;
      const after = text[at + 1 + nm.length] || "";
      if (after && /[0-9A-Za-z_]/.test(after)) continue;
      info = inf;
      len = nm.length;
      break;
    }
    if (!info) { out += text.slice(i, at + 1); i = at + 1; continue; }
    out += text.slice(i, at) + (info.desc || info.name || text.slice(at, at + 1 + len));
    i = at + 1 + len;
  }
  return out + text.slice(i);
}

/**
 * 合成预览：段词内 @N / @资产名 替换为资产卡描述（注册表内）+ 全局词前置。
 * 未注册的 @N / @名字 原样保留；全局词为空 → 不产生前置行。
 * 全局词位置=前（批 J-P10）：引擎最终拼装为 global + "\n\n" + 段词
 *   （batch_core.py merged_prompt :1732/:1747），旧预览置后与实拼不符·按实拼一致化。
 */
export function buildPvPreview(segPrompt, globalPrompt, refMap) {
  const src = (typeof segPrompt === "string") ? segPrompt : (segPrompt == null ? "" : String(segPrompt));
  const map = (refMap && typeof refMap === "object") ? refMap : {};
  const replaced = src.replace(/@(\d+)/g, (tok, d) => {
    const info = map[Number(d)];
    if (!info) return tok;
    return info.desc || info.name || tok;
  });
  const expanded = scanMentionNames(replaced, map);
  const gp = (typeof globalPrompt === "string") ? globalPrompt.trim() : "";
  return gp ? t("pvbox.preview.gpLine", { gp }) + "\n\n" + expanded : expanded;
}

// ===== 批 J-P12 A：引擎实收完整格式 → 两区拆分 =====
// 老板最终口径：最终提示词预览 = 引擎收到的完整格式（非用户输入原文）。引擎 preview_prompt
//   实返样例（真机 8190 · .tmp/jp12p7-probe-text.txt）：
//     [Shot 1]
//     subject_definitions:
//     <Subject 1>: 【外貌】… 以 <Picture 1> 的… 为准      ← @名字 已展开为 Subject 定义+Picture 引用
//     summary: … / retention_analysis: …
//     detailed_description:
//     @Subject 1 一个美丽的女孩 黑发双马尾              ← 全局词
//     @Subject 1 女孩跳舞                               ← 段词（引擎把全局词前置拼在段词之前）
//     overall_soundscape: … / non_diegetic_music: …
//   → 全局区 = 六字段块（段词移出）· 分镜区 = 段词。段词恒为 detailed_description 内容的末行。
// 平铺格式（引擎未走六字段时）不猜拆分：整篇归全局区、分镜区空，由调用方按 sixField 决定标注。
const ENGINE_FIELDS = [
  "subject_definitions", "summary", "retention_analysis",
  "detailed_description", "overall_soundscape", "non_diegetic_music",
];
const ENGINE_FIELD_RE = new RegExp(`^(${ENGINE_FIELDS.join("|")}):[ \\t]*$`);

/**
 * 引擎实收文本 → 两区（纯函数）。
 * @param {string} text 引擎 preview_prompt 返回的完整文本
 * @returns {{globalZone:string, segZone:string, sixField:boolean}}
 */
export function splitEnginePreview(text) {
  const src = (typeof text === "string") ? text : (text == null ? "" : String(text));
  const lines = src.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENGINE_FIELD_RE.exec(lines[i]);
    if (m) heads.push({ field: m[1], at: i });
  }
  if (!heads.length) return { globalZone: src, segZone: "", sixField: false };

  // 段词 = detailed_description 内容的末个非空行（其后到下一字段头之间的行不属本字段）
  const dd = heads.find((h) => h.field === "detailed_description");
  let segZone = "";
  let cutAt = -1;
  if (dd) {
    const from = dd.at + 1;
    const next = heads.find((h) => h.at > dd.at);
    let end = next ? next.at : lines.length;
    while (end > from && lines[end - 1].trim() === "") end--;
    if (end > from) {
      segZone = lines[end - 1].trim();
      cutAt = end - 1;
    }
  }
  const globalZone = cutAt < 0
    ? src
    : lines.slice(0, cutAt).concat(lines.slice(cutAt + 1)).join("\n");
  return { globalZone, segZone, sixField: true };
}

/** 段时长和（预计时长 · 非数字忽略） */
export function sumDuration(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  let total = 0;
  for (const s of segs) {
    const v = Number(s && s.durationSec);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** @N 引用次数：注册表全量（含 0 次）· count = 含该 @N 的段数（同段多次只计 1）· 按 n 升序 */
export function refUsage(segments, registry) {
  const segs = Array.isArray(segments) ? segments : [];
  const reg = (registry && typeof registry === "object" && !Array.isArray(registry)) ? registry : {};
  const out = [];
  for (const key of Object.keys(reg)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1) continue;
    const name = reg[key];
    if (typeof name !== "string" || !name) continue;
    const re = new RegExp(`@${n}\\b`);
    let count = 0;
    for (const s of segs) {
      const p = (s && typeof s.prompt === "string") ? s.prompt : "";
      if (re.test(p)) count++;
    }
    out.push({ n, name, count });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/** 「卡名×3 · 卡名×2」形态（只列 >0 次引用·批5-R55 去序列号·无 @N）；0 次折叠为末尾「另有 N 项资产未被引用」；注册表空 → 「—」 */
export function formatRefUsage(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return "—";
  const used = arr.filter((r) => r.count > 0);
  const zeroN = arr.length - used.length;
  const parts = [];
  if (used.length) parts.push(used.map((r) => `${r.name}×${r.count}`).join(" · "));
  if (zeroN > 0) parts.push(t("pvbox.ref.zeroNote", { n: zeroN }));
  return parts.join(" · ");
}

/** 短提示词检测（无既有通道 → 本模块实装阈值：去空白后 ≤12 字判过短） */
export function shortPromptWarnings(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const p = (segs[i] && typeof segs[i].prompt === "string") ? segs[i].prompt : "";
    const chars = p.trim().length;
    if (chars <= SHORT_PROMPT_CHARS) out.push({ segIndex: i, chars });
  }
  return out;
}

/** 未引用 @N 检测：注册表内 0 段引用的资产（原型 :1575 口径） */
export function unreferencedRefs(segments, registry) {
  return refUsage(segments, registry).filter((r) => r.count === 0);
}

// USAGE_CATALOG id → kind（Picture/Video/Audio）
const USAGE_KIND = {};
for (const u of USAGE_CATALOG) USAGE_KIND[u.id] = u.kind;

/**
 * 批 8 T5：占用槽数（绑定+手动+@N 三来源合计 · computeOccupancy 口径）→「图 X/9」计数
 * 批 K-T3：传 segIndex → 当前段视图（批级占用 ∪ 该段 segPools 段槽·标签 "seg:@N"）。
 */
export function poolUsageCounts(opts = {}) {
  return _occCounts(computeOccupancy(opts));
}

// 批 9 T4（20-a）：occ → 三 kind 占用槽计数——refresh 已算 occ 时复用（computeOccupancy 同参双调合一）
function _occCounts(occ) {
  const o = (occ && typeof occ === "object") ? occ : {};
  return {
    Picture: Object.keys(o.Picture || {}).length,
    Video: Object.keys(o.Video || {}).length,
    Audio: Object.keys(o.Audio || {}).length,
  };
}

/**
 * fbx 检查行（okk/warn 双态）。
 * 预检 = submit-bar 既有纯函数通道（validateAssignmentPolicy · 与提交拦截同源）；
 * 引擎 400 detail 无既有通道 → 末行按实况态呈现。
 */
export function buildCheckLines(opts = {}) {
  const segs = Array.isArray(opts.segments) ? opts.segments : [];
  const registry = (opts.registry && typeof opts.registry === "object") ? opts.registry : {};
  const assets = (opts.assets && typeof opts.assets === "object") ? opts.assets : {};
  const gp = (typeof opts.globalPrompt === "string") ? opts.globalPrompt.trim() : "";
  const projMode = (typeof opts.projMode === "string") ? opts.projMode : "";

  const lines = [];
  lines.push({
    state: "okk",
    text: t("pvbox.chk.previewOk", { n: segs.length }) + (gp ? t("pvbox.chk.gpPre") : ""),
  });
  for (const w of shortPromptWarnings(segs)) {
    lines.push({ state: "warn", text: t("pvbox.chk.shortPrompt", { i: w.segIndex + 1, chars: w.chars }) });
  }
  // I 块（2026-10-25）：未引用资产逐条 warn 合并为一条汇总（名单跟在计数后·不再每资产一行）
  const unref = unreferencedRefs(segs, registry);
  if (unref.length) {
    lines.push({
      state: "warn",
      text: t("pvbox.chk.unref", { n: unref.length, names: unref.map((r) => r.name).join("、") }),
    });
  }
  const pre = validateAssignmentPolicy({ projMode, segments: segs, registry, assets });
  if (pre.ok && pre.warnings.length === 0) {
    lines.push({ state: "okk", text: t("pvbox.chk.preOk") });
  } else {
    lines.push({ state: "warn", text: t("pvbox.chk.preWarn", { n: pre.warnings.length }) });
    for (const w of pre.warnings) lines.push({ state: "warn", text: `⚠ ${w.msg}` });
  }
  lines.push({ state: "okk", text: t("pvbox.fbx.submitDetail") });
  return lines;
}

// ===== DOM 构造 =====

function _el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function _setText(node, text) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
  node.textContent = String(text == null ? "" : text);
}

function _clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// pv-box：挂载期建一次，刷新只改 #pvSeg / #pvBody 文本（保住引用 · 编辑实时刷新）
function _buildPvBox() {
  const box = _el("div", { class: "pv-box" });
  const hd = _el("div", { class: "hd" });
  hd.appendChild(document.createTextNode(t("pvbox.hd.cap")));
  const segLabel = _el("b", { id: "pvSeg" });
  segLabel.setAttribute("style", "color:var(--txt2)");
  hd.appendChild(segLabel);
  // 战役批2 T5（F-89 a 断点）：旧文案「@N/@名字 已替换为资产卡描述」只描述预览层本地合成
  //   （buildPvPreview），提交层此前原文透传 → 承诺失真（F-89 三错觉之一）。
  //   提交层改为拿引擎 preview_prompt 权威展开后回填 → 文案不再冒充提交语义。
  hd.appendChild(document.createTextNode(t("pvbox.hd.expanded")));
  const hint = _el("span", { style: "margin-left:auto;letter-spacing:0" });
  hint.textContent = t("pvbox.hd.hint");
  hd.appendChild(hint);
  box.appendChild(hd);
  const bd = _el("div", { class: "bd", id: "pvBody" });
  box.appendChild(bd);
  return { box, segLabel, bd };
}

// poolbar：每次刷新整块重建（标题 + 计数 pill×2 + 资产 pill + 手动槽胶囊行 + inh）
//   老板裁决⑤甲（2026-10-25）：批级视频槽（"视频 N/3"那一排）整排隐藏——不参与引擎生成
//   （悬停提示曾写"引擎执行侧不生效（仅预览显示）·视频参考请用段级/排戏台"·徒增困惑）
//   → 计数只留 图/音频；槽位行只渲染 Picture/Audio；参考视频统一走段卡拍摄控制里的段级槽。
function _renderPoolBar(bar, st, data) {
  _clear(bar);
  bar.appendChild(_el("span", { text: t("pvbox.pool.cap") }));
  bar.appendChild(_el("span", { class: "pill num", text: t("pvbox.pool.countPic", { n: data.counts.Picture, max: SLOT_RANGES.Picture }) }));
  bar.appendChild(_el("span", { class: "pill num", text: t("pvbox.pool.countAud", { n: data.counts.Audio, max: SLOT_RANGES.Audio }) }));
  for (const info of data.pillList) {
    // 批5-R55：pill 显示层去序列号——文案与 title 均用卡名（@N 序列号仅存 dragstart 数据载荷）
    const pill = _el("span", { class: "pill dragchip", title: t("pvbox.pool.dragTitle", { name: info.name }) });
    pill.setAttribute("draggable", "true");
    pill.appendChild(_el("span", { class: "ref", text: info.name }));
    pill.addEventListener("dragstart", (ev) => {
      const dt = ev && ev.dataTransfer;
      if (!dt || typeof dt.setData !== "function") return;
      dt.setData(ASSET_DND_TYPE, String(info.n));
    });
    bar.appendChild(pill);
  }
  bar.appendChild(_buildSlotRows(st, data.poolManual, data.occ, data.segIndex));
  // 批 K-T3 注记：选中段时池位条切「当前段视图」，段槽带「段N」徽标（每段独立分槽）
  if (Number.isInteger(data.segIndex)) {
    bar.appendChild(_el("span", { class: "poolseg-note", text: t("pvbox.pool.segNote", { n: data.segIndex + 1 }) }));
  }
  const inh = _el("span", { class: "inh" });
  inh.textContent = t("pvbox.pool.inh");
  bar.appendChild(inh);
}

// ===== 批 8 T5 A：G3 手动槽胶囊 =====

// 数据域三 kind（写侧克隆容器用·Video 也在内——UI 隐藏≠字段删除）
const POOL_KINDS = ["Picture", "Video", "Audio"];
// 池位条渲染 kind（老板裁决⑤甲：批级视频槽整排隐藏 → 不渲染 Video 行）
const POOL_ROW_KINDS = ["Picture", "Audio"];
// kind → 显示词键（kind 本身=数据域禁译·#89 T2b 显示侧入典）
const POOLSLOT_KIND_LABEL_KEY = { Picture: "pvbox.kind.pic", Video: "pvbox.kind.video", Audio: "pvbox.kind.audio" };

function _mediaBasename(media) {
  return String(media || "").split(/[\\/]/).pop() || "";
}

// 手动槽写入（不可变：克隆三 kind 容器 → 覆写/删该槽 → setPoolManual 落库·notify 即刷新）
function _writeManualSlot(projectId, kind, idx, entry) {
  const proj = storeLoad(projectId);
  if (!proj) return false;
  const src = (proj.poolManual && typeof proj.poolManual === "object" && !Array.isArray(proj.poolManual))
    ? proj.poolManual : {};
  const next = {};
  for (const k of POOL_KINDS) {
    const o = (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) ? src[k] : {};
    next[k] = Object.assign({}, o);
  }
  if (entry) next[kind][String(idx)] = entry;
  else delete next[kind][String(idx)];
  return setPoolManual(projectId, next);
}

// 段级排戏槽清空（× 入口）→ 共享实现见 segcards.js clearStagingSlot（#79 段卡紧凑条同口径同实现）

// dataTransfer 是否携带某类型（Array.from 兼容真机 DOMStringList 与测试数组）
//   #79：导出供段卡紧凑条拖放同口径复用（避免两份判定漂移）
export function dtHasType(dt, type) {
  return !!(dt && dt.types && Array.from(dt.types).indexOf(type) >= 0);
}

// 拖拽载荷 → 该 kind 填槽数据 {media, usages, cardName} | null（通道②）
//   载荷两形态：ASSET_DT_MIME 卡 JSON（资产卡）优先 · ASSET_DND_TYPE @N（素材池胶囊）次之；
//   卡数据取上下文优先（rows 新鲜），无上下文卡 → 载荷自带 rows 兜底；
//   usages 取卡行 usage；无同 kind 行但载荷带单 media → 直写（usages 默认空·legacy 覆盖按钮口径）
//   #79：导出供段卡紧凑条拖放同口径复用
export function dropPayloadToSlotFill(dt, kind, ctx) {
  const c = (ctx && typeof ctx === "object") ? ctx : {};
  const assets = (c.assets && typeof c.assets === "object" && !Array.isArray(c.assets)) ? c.assets : {};
  const registry = (c.registry && typeof c.registry === "object" && !Array.isArray(c.registry)) ? c.registry : {};
  let name = "";
  let payload = null;
  const cardPayload = parseAssetPayload(dt);
  if (cardPayload) {
    payload = cardPayload;
    name = (typeof cardPayload.name === "string") ? cardPayload.name : "";
  } else if (dt && typeof dt.getData === "function") {
    const n = Number(dt.getData(ASSET_DND_TYPE));
    if (Number.isInteger(n) && n >= 1) name = registry[String(n)] || "";
  }
  if (!name && !payload) return null;
  const card = (name && assets[name]) || payload || null;
  const rows = (card && Array.isArray(card.rows)) ? card.rows : [];
  const row = rows.find((r) => r && r.media && USAGE_KIND[r.usage] === kind);
  if (row) {
    return { media: String(row.media), usages: [row.usage], cardName: name || undefined };
  }
  const single = (payload && typeof payload.media === "string") ? payload.media.trim() : "";
  if (single) return { media: single, usages: [], cardName: name || undefined };
  return null;
}

function _buildSlotCapsule(st, kind, idx, manual, occ, segIndex) {
  const cap = _el("span", { class: "poolslot" });
  cap.setAttribute("data-h3-role", "pool-slot");
  cap.setAttribute("data-kind", kind);
  cap.setAttribute("data-idx", String(idx));
  // 占用来源标签（computeOccupancy）：binding:卡名 | manual | ref:@N（批级全局 @N）| seg:@N（段池槽·批 K-T3）
  const label = (occ && occ[kind]) ? occ[kind][idx] : undefined;
  const bindingName = (typeof label === "string" && label.indexOf("binding:") === 0) ? label.slice(8) : "";
  const segRef = (typeof label === "string" && label.indexOf("seg:") === 0) ? label.slice(4) : "";
  const occupied = !!(manual && typeof manual === "object" && manual.media);
  if (occupied) {
    cap.classList.add("is-occupied");
    cap.title = _mediaBasename(manual.media) + t("pvbox.slot.fromCard");
    cap.appendChild(document.createTextNode(_mediaBasename(manual.media)));
    if (typeof manual.cardName === "string" && manual.cardName) {
      cap.appendChild(_el("span", { class: "poolslot-owner", text: t("pvbox.slot.owner", { name: manual.cardName }) }));
    }
    if (bindingName) {
      cap.classList.add("is-binding");
      cap.appendChild(_el("span", { class: "poolslot-bind", text: t("pvbox.slot.bindPriority") }));
    }
    const clear = _el("span", { class: "poolslot-clear", text: "×", title: t("pvbox.slot.clearTitle") });
    clear.setAttribute("data-h3-role", "pool-slot-clear");
    clear.addEventListener("click", () => { _writeManualSlot(st.projectId, kind, idx, null); });
    cap.appendChild(clear);
  } else if (bindingName) {
    // 绑定占号槽（无手动 media）：虚线占位 + 卡名可判别徽标（legacy refreshOwnerMarks 语义）
    cap.classList.add("is-binding");
    cap.title = t("pvbox.slot.bindingTitle", { name: bindingName });
    cap.appendChild(_el("span", { class: "poolslot-bind", text: t("pvbox.slot.binding", { name: bindingName }) }));
  } else {
    cap.appendChild(document.createTextNode(String(idx)));
  }
  // 批 K-T3 段池槽徽标：段 N 专属素材池槽（每段独立分槽·跨段同槽号可放不同素材）
  if (segRef) {
    const segNo = (Number.isInteger(segIndex) ? segIndex : 0) + 1;
    const segTitle = t("pvbox.slot.segTitle", { n: segNo, ref: segRef });
    cap.classList.add("is-seg");
    cap.title = cap.title ? cap.title + " · " + segTitle : segTitle;
    const badge = _el("span", { class: "poolslot-seg", text: t("pvbox.slot.segBadge", { n: segNo }) });
    badge.setAttribute("data-h3-role", "pool-slot-seg");
    cap.appendChild(badge);
  }
  // 通道②：拖资产卡/胶囊落此槽 = 填槽（覆写手动槽·老板待裁④口径）
  cap.addEventListener("dragover", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (dt) dt.dropEffect = "copy";
  });
  cap.addEventListener("drop", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    const fill = dropPayloadToSlotFill(dt, kind, getAssetContext());
    if (fill) _writeManualSlot(st.projectId, kind, idx, fill);
  });
  return cap;
}

// 槽位行（Picture 9/Audio 3 · SLOT_RANGES——9 号手动可用）
//   批级 Video 行整排不渲染（老板裁决⑤甲·参考视频统一走段卡拍摄控制里的段级槽）
function _buildSlotRows(st, poolManual, occ, segIndex) {
  const pm = (poolManual && typeof poolManual === "object" && !Array.isArray(poolManual)) ? poolManual : {};
  const wrap = _el("div", { class: "poolslots" });
  for (const kind of POOL_ROW_KINDS) {
    const row = _el("div", { class: "poolslot-row" });
    row.setAttribute("data-kind", kind);
    row.appendChild(_el("span", { class: "poolslot-kind", text: t(POOLSLOT_KIND_LABEL_KEY[kind]) }));
    const kindObj = (pm[kind] && typeof pm[kind] === "object" && !Array.isArray(pm[kind])) ? pm[kind] : {};
    for (let idx = 1; idx <= SLOT_RANGES[kind]; idx++) {
      row.appendChild(_buildSlotCapsule(st, kind, idx, kindObj[String(idx)], occ, segIndex));
    }
    wrap.appendChild(row);
  }
  return wrap;
}

// psummary：每次刷新整块重建（段数 / 预计 / 引用 / 输出 + 提交前提示 inh）
function _renderSummary(sum, data) {
  _clear(sum);
  sum.appendChild(_el("span", { text: t("pvbox.sum.run", { n: data.segCount }) }));
  sum.appendChild(_el("span", { class: "num", text: t("pvbox.sum.eta", { sec: data.totalSec }) }));
  sum.appendChild(_el("span", { text: t("pvbox.sum.refs", { refs: data.refsText }) }));
  sum.appendChild(_el("span", { class: "num", text: t("pvbox.sum.output", { out: data.output }) }));
  const inh = _el("span", { class: "inh", style: "margin-left:auto" });
  inh.textContent = t("pvbox.sum.inh");
  sum.appendChild(inh);
}

// fbx：cap 折叠头挂载期建一次（点击 toggle open），body 内容随刷新重建
function _buildFbx() {
  const fbx = _el("div", { class: "fbx" });
  const cap = _el("div", { class: "fbx-cap" });
  cap.appendChild(document.createTextNode(t("pvbox.fbx.cap")));
  const icw = _el("span", { class: "icw" });
  icw.appendChild(_el("span", { "data-ic": "chev", "data-sz": "14" }));
  cap.appendChild(icw);
  // v43 :1571 onclick="this.parentElement.classList.toggle('open')"
  cap.addEventListener("click", () => { fbx.classList.toggle("open"); });
  fbx.appendChild(cap);
  const body = _el("div", { class: "fbx-body" });
  fbx.appendChild(body);
  return { fbx, body };
}

function _renderFbxBody(body, lines) {
  _clear(body);
  for (const l of lines) body.appendChild(_el("div", { class: `chkline ${l.state}`, text: l.text }));
  const inh = _el("div", { class: "inh", style: "font-size:12px;margin-top:6px" });
  inh.textContent = t("pvbox.fbx.busyInh");
  body.appendChild(inh);
}

// ===== 挂载 / 刷新 / 退订 =====

let _active = null;

function _teardown() {
  if (!_active) return;
  if (_active.unsubStore) storeUnsubscribe(_active.unsubStore);
  if (_active.unsubSel) _active.unsubSel();
  for (const node of (_active.nodes || [])) {
    const parent = node && (node.parentNode || node._parent);
    if (parent && typeof parent.removeChild === "function") parent.removeChild(node);
  }
  _active = null;
}

export function _teardownForTests() { _teardown(); }

export function mount(container, projectId) {
  if (typeof document === "undefined" || !container || !projectId) return null;
  _teardown();
  const proj = storeLoad(projectId);
  if (!proj) return null;

  // 老板走查批C：四块直接平级挂入 col（删 section.pvbox-view 包裹壳——原型 :1552-1579 四块即 col 直接子级）
  const pv = _buildPvBox();
  const pool = _el("div", { class: "poolbar" });
  const sum = _el("div", { class: "psummary" });
  const fbx = _buildFbx();
  container.appendChild(pv.box);
  container.appendChild(pool);
  container.appendChild(sum);
  container.appendChild(fbx.fbx);

  const state = {
    projectId,
    nodes: [pv.box, pool, sum, fbx.fbx],
    pvSeg: pv.segLabel, pvBody: pv.bd,
    pool, sum, fbxBody: fbx.body,
    unsubStore: null, unsubSel: null,
  };
  _active = state;

  // 数据接线 ①：store 变化（段增删改/排序、全局词落盘）→ 全量刷新
  const storeFn = (ev) => {
    if (!ev || ev.projectId !== projectId) return;
    refresh();
  };
  storeSubscribe(storeFn);
  state.unsubStore = storeFn;
  // 数据接线 ②：segcards 选中段变化 → pv-box 刷新（v43 :1553「点段卡切换」）
  state.unsubSel = subscribeSelected(() => refresh());

  refresh();
  hydrateIcons(fbx.fbx);
  // 数据接线 ③：@N 注册表 + 引擎卡装载完成（幂等·已装载则立即）→ 药丸/替换/预检刷新
  ensureAssetContext()
    .then(() => { if (_active === state) refresh(); })
    .catch(() => { /* 资产不可达 → 保持降级空态 */ });
  return container;
}

/** 手动刷新当前挂载（测试 / 外部数据注入后调用） */
export function refreshNow() { refresh(); }

function refresh() {
  const st = _active;
  if (!st) return;
  const proj = storeLoad(st.projectId);
  if (!proj) return;
  const ctx = getAssetContext();
  const registry = ctx.registry || {};
  const assets = ctx.assets || {};
  const refMap = buildRefMap(registry, assets);
  const segs = Array.isArray(proj.segments) ? proj.segments : [];
  const selId = getSelectedSegId();
  const selIdx = segs.findIndex((s) => s && s.id === selId);

  // pv-box：选中段合成预览 / 无选中段态
  _setText(st.pvSeg, selIdx >= 0 ? t("pvbox.pv.seg", { n: selIdx + 1 }) : t("pvbox.pv.unselected"));
  _setText(
    st.pvBody,
    selIdx >= 0
      ? buildPvPreview(segs[selIdx].prompt, proj.globalPrompt, refMap)
      : t("pvbox.pv.empty"),
  );

  const poolManual = (proj.poolManual && typeof proj.poolManual === "object" && !Array.isArray(proj.poolManual))
    ? proj.poolManual : {};
  // 批 9 T4（20-a）：occ 单次计算复用——计数（poolUsageCounts 口径）与槽位行共用同一份
  // 批 J-P7 B5（P9 遗留①）：补 globalPrompt——全局词里的 @N 与段 @N 同池占槽（引擎 scanRefSlotAllocation
  //   扫描源含全局词且先于段序占槽），展示层此前漏传 = 池位条少计（提交链本就正确）。
  // 批 K-T3：选中段时传 segIndex → 池位条切「当前段视图」（批级占用 ∪ 该段 segPools 段槽·标签 seg:@N）。
  const occ = computeOccupancy({
    castBindings: proj.castBindings,
    poolManual,
    segments: segs,
    globalPrompt: proj.globalPrompt,
    registry,
    assets,
    segIndex: selIdx >= 0 ? selIdx : undefined,
  });

  // 批级视频槽整排隐藏（老板裁决⑤甲）→ 池位条只渲染 Picture/Audio 两 kind 槽行；
  //   段级参考视频槽不在池位条呈现，统一走段卡拍摄控制（segcards.js·不动）。
  _renderPoolBar(st.pool, st, {
    counts: _occCounts(occ),
    pillList: Object.values(refMap).sort((a, b) => a.n - b.n),
    poolManual,
    occ,
    segIndex: selIdx >= 0 ? selIdx : undefined,
  });

  _renderSummary(st.sum, {
    segCount: segs.length,
    totalSec: sumDuration(segs),
    refsText: formatRefUsage(refUsage(segs, registry)),
    output: `${proj.name || t("pvbox.unnamed")}/`,
  });

  _renderFbxBody(st.fbxBody, buildCheckLines({
    segments: segs,
    globalPrompt: proj.globalPrompt,
    registry,
    assets,
    projMode: proj.projMode,
  }));
}
