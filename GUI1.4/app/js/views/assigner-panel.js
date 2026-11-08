// views/assigner-panel.js — 设定 TAB 分配器面板（批 8 T3 + T4）
//
// 迁移源：legacy GUI1.0 views/workbench_assigner.js 三块视觉序（①顶②中③底）：
//   ① 本批角色绑定面板（cast-bindings-panel · 批 8 T4）——绑定列表/空态/槽位联动黄条/
//      出场命中预览（250ms 防抖扫 segments prompt·命中=「本批出场」标记）/
//      按槽解绑·整卡解绑/陈旧检测提示解绑（不静默自动解绑）/cast_block 预览出场块
//   ② 本批分配卡汇总（assigned-cards-panel · 卡级去重：卡名 + Subject N + 占槽数）
//   ③ 资产库分配器（列表/卡片双视图 + 角色/场景下拉 + 「分配到表单」+ 卡网格 +
//      反馈/空态/信息行 + 面板折叠）
//
// 适配层（DOM→store · 最小化）：
//   - 写池：legacy applyCardToForm 写 poolInputs DOM → 本面板调 core/assigner.applyCardToStore
//     拿新 poolManual/castBindings 容器走 store.setPoolManual/setCastBindings 落库
//   - 资产数据源：segcards 资产上下文（ensureAssetContext —— 与 pvbox 同通道，
//     setup.mount 的 prompt.loadAssets 已装载则零额外请求）
//   - localStorage 键 legacy h3gui_ 前缀 → 1.3 gui13. 前缀（gui13.assigner.mode /
//     gui13.assigner.collapsed · 语义同 legacy：mode 仅 list|cards·非法拒写）
//   - prompt 命中监听：legacy document input 委托 [data-key=prompt] → 1.3 store
//     segment:update 订阅 + 250ms 防抖（store 为唯一数据源 · 口径同引擎档 2 名字检测）
//   - 陈旧解绑：legacy pool.js owner 槽值比较自动解绑 → 1.3 仅黄条提示+解绑钮（卡行
//     可编辑性强，静默解绑丢用户意图——提示用户决断）
//   - skipped 覆盖按钮（legacy attachOverrideButton）T3 仅返回数据 + 面板占位入口
//     （disabled 钮）；完整交互归 T5 手动槽任务（拖卡双通道）
//   - 缩略图：legacy renderThumb 无 1.3 对应组件 → 卡行以用途标签 + 媒体名呈现
//
// === API ===
//   readAssignerViewMode()/writeAssignerViewMode(mode)  视图模式持久（gui13.assigner.mode）
//   readAssignerCollapsed()/writeAssignerCollapsed(b)   折叠态持久（gui13.assigner.collapsed）
//   scanBindingHits(bindings, segments)                 命中扫描纯函数（name→bool）
//   detectStaleBindings(bindings, assets)               陈旧检测纯函数（[{name,reason,slotIdxs}]）
//   mount(container, projectId) → 面板 section（重复 mount 替换旧挂载）
//   _teardownForTests()                                  退订 + 摘除 + 清防抖定时器

import {
  load as storeLoad,
  subscribe as storeSubscribe,
  unsubscribe as storeUnsubscribe,
  setCastBindings,
  setPoolManual,
  normalizeCastBindings,
  normalizePoolManual,
} from "../store/store.js";
import { ensureAssetContext, getAssetContext } from "./segcards.js";
import { applyCardToStore, ASSET_DT_MIME, parseAssetPayload } from "../core/assigner.js";
import { USAGE_CATALOG } from "../core/assets_api.js";
import { removeBinding, removeBindingSlot } from "../core/bindings.js";
import { castBlock } from "../core/cast_block.js";
import { t } from "../core/i18n.js";   // #89 T2b：显示文案入典（zh 原文=键值·en 见 core/i18n.js）

// ===== localStorage 纯函数（legacy 视图模式/折叠三件套 · gui13. 前缀）=====

const VIEW_MODE_KEY = "gui13.assigner.mode";
const VIEW_MODE_LIST = "list";
const VIEW_MODE_CARDS = "cards";
const COLLAPSED_KEY = "gui13.assigner.collapsed";

function _storage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; } catch (_) { return null; }
}

function _normalizeViewMode(v) {
  return (v === VIEW_MODE_CARDS) ? VIEW_MODE_CARDS : VIEW_MODE_LIST;
}

export function readAssignerViewMode() {
  try {
    const s = _storage();
    const v = (s && typeof s.getItem === "function") ? s.getItem(VIEW_MODE_KEY) : null;
    return _normalizeViewMode(v);
  } catch (_) { return VIEW_MODE_LIST; }
}

export function writeAssignerViewMode(mode) {
  const m = _normalizeViewMode(mode);
  if (m !== mode) return; // 非法/null → 拒写（不污染 localStorage）
  try {
    const s = _storage();
    if (s && typeof s.setItem === "function") s.setItem(VIEW_MODE_KEY, m);
  } catch (_) { /* storage 关闭/配额超 — 不阻断 UI */ }
}

export function readAssignerCollapsed() {
  try {
    const s = _storage();
    const raw = (s && typeof s.getItem === "function") ? s.getItem(COLLAPSED_KEY) : null;
    if (raw == null) return null;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch (_) { return null; }
}

export function writeAssignerCollapsed(collapsed) {
  try {
    const s = _storage();
    if (s && typeof s.setItem === "function") s.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch (_) { /* localStorage 不可用 — 静默吞 */ }
}

// USAGE_CATALOG id → 短标签（legacy USAGE_SHORT_LABEL 同用途 · 单一真值源派生）
const USAGE_LABEL = {};
for (const u of USAGE_CATALOG) {
  const lab = String(u.label || "");
  USAGE_LABEL[u.id] = lab.includes("·") ? lab.split("·").pop() : lab;
}

// ===== ① 绑定面板纯函数（批 8 T4）=====

// 命中扫描：绑定表卡名出现在任一 segment prompt 中 → 命中（引擎档 2
// _detect_bound_names_in_text 同口径——只认绑定表内名字 · GUI 侧命中=「本批出场」）。
// legacy _scanShotRowPrompts 直迁（rows→segments · prompt 为空/segments 非法 → 全 false）。
export function scanBindingHits(bindings, segments) {
  const out = {};
  for (const b of (Array.isArray(bindings) ? bindings : [])) {
    if (b && b.name) out[b.name] = false;
  }
  const segs = Array.isArray(segments) ? segments : [];
  for (const seg of segs) {
    const txt = (seg && typeof seg.prompt === "string") ? seg.prompt : "";
    if (!txt) continue;
    for (const name of Object.keys(out)) {
      if (out[name]) continue; // 已命中跳过
      if (txt.indexOf(name) !== -1) out[name] = true;
    }
  }
  return out;
}

// 陈旧检测（legacy pool.js shouldUnbindSlot 先例适配 1.3 生命周期）：
//   ① 卡被删除：assets 上下文里无此卡名 → reason="deleted"
//   ② 卡行改动：绑定 slot 引用的 media/desc 与卡行现值（同 usage 行）任一不一致
//      → reason="row"（slot.idx 是池槽号非卡行序号，按 usage 对位卡行比较 ·
//      media/desc 均 trim 同 legacy 口径；desc 缺省两侧归一空串，无双态冲突）
// 只报告不改写——解绑由用户决断（1.3 卡行可编辑性强 · 静默解绑丢用户意图）。
export function detectStaleBindings(bindings, assets) {
  const arr = Array.isArray(bindings) ? bindings : [];
  const map = (assets && typeof assets === "object" && !Array.isArray(assets)) ? assets : {};
  const out = [];
  for (const b of arr) {
    if (!b || !b.name) continue;
    const card = map[b.name];
    if (!card) { out.push({ name: b.name, reason: "deleted", slotIdxs: [] }); continue; }
    const rows = Array.isArray(card.rows) ? card.rows : [];
    const slots = Array.isArray(b.slots) ? b.slots : [];
    const badIdxs = [];
    for (const s of slots) {
      if (!s || !Number.isInteger(s.idx)) continue;
      const slotMedia = String(s.media == null ? "" : s.media).trim();
      const slotDesc = String(s.desc == null ? "" : s.desc).trim();
      const matched = rows.some((r) => r && r.usage === s.usage
        && String(r.media == null ? "" : r.media).trim() === slotMedia
        && String(r.desc == null ? "" : r.desc).trim() === slotDesc);
      if (!matched) badIdxs.push(s.idx);
    }
    if (badIdxs.length > 0) out.push({ name: b.name, reason: "row", slotIdxs: badIdxs });
  }
  return out;
}

// ===== DOM 构造辅助 =====

function _el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  return node;
}

function _role(node, role) { node.setAttribute("data-h3-role", role); return node; }

function _clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// 反馈行（legacy setAssignerFeedback 同形 · level → 颜色类）
function _setFeedback(el, msg, level) {
  if (!el) return;
  el.classList.remove("is-hidden", "is-warn", "is-error", "is-ok");
  if (level === "error") el.classList.add("is-error");
  else if (level === "warn") el.classList.add("is-warn");
  else el.classList.add("is-ok");
  el.textContent = msg;
}

// 覆盖入口（批 8 T5 转正 · legacy :525 attachOverrideButton 语义：点击写值+勾用途+自毁）
//   skipped 槽 → 可点覆盖钮：将该卡 media/usages 强制写进对应手动槽（覆盖现有占用）
//   → setPoolManual 落库 → 按钮自毁（各自独立·互不牵连）
function _renderOverrideSlot(st, entries) {
  const wrap = st.overrideSlot;
  if (!wrap) return;
  _clear(wrap);
  if (!entries || entries.length === 0) {
    wrap.classList.add("is-hidden");
    return;
  }
  wrap.classList.remove("is-hidden");
  for (const e of entries) {
    const btn = _el("button", {
      type: "button",
      class: "assigner-override-btn",
      text: t("assigner.override.btn", { name: e.name, kind: e.slot.kind, idx: e.slot.idx }),
      title: t("assigner.override.title", { name: e.name }),
    });
    _role(btn, "assigner-override-btn");
    btn.setAttribute("data-slot-kind", e.slot.kind);
    btn.setAttribute("data-slot-idx", String(e.slot.idx));
    btn.addEventListener("click", () => {
      const proj = storeLoad(st.projectId);
      if (!proj) return;
      const src = (proj.poolManual && typeof proj.poolManual === "object" && !Array.isArray(proj.poolManual))
        ? proj.poolManual : {};
      const next = {};
      for (const k of ["Picture", "Video", "Audio"]) {
        const o = (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) ? src[k] : {};
        next[k] = Object.assign({}, o);
      }
      next[e.slot.kind][String(e.slot.idx)] = {
        media: e.slot.value,
        usages: Array.isArray(e.slot.usages) ? e.slot.usages.slice() : [],
        cardName: e.name,
      };
      setPoolManual(st.projectId, next);
      const parent = btn.parentNode || btn._parent;
      if (parent && typeof parent.removeChild === "function") parent.removeChild(btn);
    });
    wrap.appendChild(btn);
  }
}

// ===== 挂载 / 刷新 / 退订（pvbox 同形）=====

let _active = null;

function _teardown() {
  if (!_active) return;
  if (_active.unsubStore) storeUnsubscribe(_active.unsubStore);
  if (_active.bindingsTimer) { clearTimeout(_active.bindingsTimer); _active.bindingsTimer = null; }
  const node = _active.node;
  const parent = node && (node.parentNode || node._parent);
  if (parent && typeof parent.removeChild === "function") parent.removeChild(node);
  _active = null;
}

export function _teardownForTests() { _teardown(); }

// 单卡分配：资产上下文取卡 → applyCardToStore → 落库（legacy _runAssigner.applyOne 适配）
function _assignOne(projectId, name) {
  const assets = (getAssetContext() || {}).assets || {};
  const card = assets[name];
  // kind 显示词（character/scene 引擎键=数据禁译·#89 T2b 只翻显示侧）
  const kindLabel = (card && card.kind === "character") ? t("assigner.kind.character")
    : (card && card.kind === "scene") ? t("assigner.kind.scene") : t("assigner.kind.asset");
  if (!card || card._v !== 3) {
    return { error: t("assigner.err.noCard", { kind: kindLabel, name }) };
  }
  const proj = storeLoad(projectId);
  if (!proj) return { error: t("assigner.err.noProject", { kind: kindLabel }) };
  const out = applyCardToStore(card, name, {
    poolManual: normalizePoolManual(proj.poolManual),
    castBindings: normalizeCastBindings(proj.castBindings),
    asBinding: true,
  });
  if (out.poolManual) setPoolManual(projectId, out.poolManual);
  if (out.castBindings) setCastBindings(projectId, out.castBindings);
  return out;
}

// 「分配到表单」：角色 → 场景同步链（场景以角色分配后的 store 为基线 · legacy 同序）
function _runAssign(st, roleName, sceneName) {
  if (!roleName && !sceneName) {
    _setFeedback(st.feedback, t("assigner.fb.pickFirst"), "warn");
    return;
  }
  const lines = [];
  let totalSkipped = 0;
  let hasError = false;
  const overrides = [];
  for (const name of [roleName, sceneName]) {
    if (!name) continue;
    const out = _assignOne(st.projectId, name);
    if (out.error) { lines.push(out.error); hasError = true; continue; }
    lines.push(out.line);
    totalSkipped += out.skipped.length;
    for (const s of out.skipped) overrides.push({ name, slot: s });
  }
  const level = hasError ? "error" : (totalSkipped > 0 ? "warn" : "info");
  _setFeedback(st.feedback, lines.join(" | "), level);
  _renderOverrideSlot(st, overrides);
}

// 资产装载 → 双下拉填充 + 启用分配钮 + 信息行/空态（legacy _loadAssetsIntoAssigner 适配）
function _fillSelectors(st) {
  const assets = (getAssetContext() || {}).assets || {};
  const characters = [];
  const scenes = [];
  for (const [name, c] of Object.entries(assets)) {
    if (!c || c._v !== 3) continue;
    if (c.kind === "character") characters.push([name, c]);
    else if (c.kind === "scene") scenes.push([name, c]);
  }
  characters.sort((a, b) => a[0].localeCompare(b[0]));
  scenes.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [sel, items, label] of [
    [st.roleSel, characters, t("assigner.sel.rolePh")],
    [st.sceneSel, scenes, t("assigner.sel.scenePh")],
  ]) {
    _clear(sel);
    const ph = _el("option", { value: "", text: label });
    sel.appendChild(ph);
    for (const [name, c] of items) {
      const optLabel = (c.label && String(c.label).trim()) ? (name + " (" + c.label + ")") : name;
      sel.appendChild(_el("option", { value: name, text: optLabel }));
    }
    sel.disabled = items.length === 0;
  }
  st.assignBtn.disabled = (characters.length === 0 && scenes.length === 0);
  if (characters.length === 0 && scenes.length === 0) {
    st.empty.classList.remove("is-hidden");
  } else {
    st.empty.classList.add("is-hidden");
  }
  st.info.textContent = t("assigner.info.loaded", { rc: characters.length, sc: scenes.length });
}

// ② 本批分配卡汇总渲染（legacy _renderAssignedCardsPanel 直迁 · 数据源 store.castBindings）
function _renderAssignedCards(st) {
  const proj = storeLoad(st.projectId);
  const items = proj ? normalizeCastBindings(proj.castBindings) : [];
  _clear(st.cardsList);
  // 卡级去重: 同名条目只取首个（upsertBinding 已保 name 唯一 · 此处兜底脏数据）
  const seen = new Set();
  const cards = [];
  for (const b of items) {
    if (!b || !b.name || seen.has(b.name)) continue;
    seen.add(b.name);
    cards.push(b);
  }
  if (cards.length === 0) {
    st.cardsEmpty.classList.remove("is-hidden");
    return;
  }
  st.cardsEmpty.classList.add("is-hidden");
  for (const b of cards) {
    const slots = Array.isArray(b.slots) ? b.slots : [];
    const li = _el("li", { class: "assigned-card-item" });
    li.setAttribute("data-h3-role", "assigned-card-item");
    li.setAttribute("data-card-name", b.name);
    li.title = slots.length
      ? t("assigner.slots.title", { list: slots.map((s) => (s && s.kind ? t("assigner.slot.chip", { kind: s.kind, idx: Number.isInteger(s.idx) ? s.idx : "?" }) : t("assigner.slot.chipNoKind", { idx: Number.isInteger(s && s.idx) ? s.idx : "?" }))).join("、") })
      : t("assigner.slots.none");
    li.appendChild(_el("span", { class: "assigned-card-name", text: b.name }));
    li.appendChild(_el("span", {
      class: "assigned-card-src",
      text: t("assigner.cards.subjectSlots", { no: Number.isInteger(b.no) ? b.no : "?", n: slots.length }),
    }));
    st.cardsList.appendChild(li);
  }
}

// ===== ① 本批角色绑定面板（批 8 T4 · legacy _buildCastBindingsPanel/_renderCastBindingsPanel 迁移）=====

// prompt 命中重扫防抖窗（legacy _PROMPT_DEBOUNCE_MS = 250 同值）
const BINDINGS_DEBOUNCE_MS = 250;

function _currentBindings(projectId) {
  const proj = storeLoad(projectId);
  return proj ? normalizeCastBindings(proj.castBindings) : [];
}

// 整卡解绑（legacy _onBindingRemove 适配：T1 removeBinding → setCastBindings 落库；
//   池槽清理不在本任务——1.3 池槽由 poolManual 域管，改/清槽联动归 T5 手动槽任务）
function _unbindCard(st, name) {
  if (!name) return;
  setCastBindings(st.projectId, removeBinding(_currentBindings(st.projectId), name));
}

// 按槽解绑（T1 removeBindingSlot → setCastBindings；末槽删净整条移除为函数内建语义）
function _unbindSlot(st, name, slotIdx) {
  setCastBindings(st.projectId, removeBindingSlot(_currentBindings(st.projectId), name, slotIdx));
}

// 预览出场块：调 core/castBlock（POST /h3_batch/cast_block）→ blocks 文本列表 +
//   fingerprint 状态；失败渲染错误态（不崩）。lang 随项目全局「语言」（英文→en·否则 zh）。
function _runPreview(st, name, previewArea) {
  const cur = _currentBindings(st.projectId).find((x) => x && x.name === name);
  if (!cur) return; // 条目已被解绑（列表重渲换钮，防御旧闭包点击）
  const proj = storeLoad(st.projectId);
  const lang = (proj && proj.globalParams && proj.globalParams["语言"] === "英文") ? "en" : "zh";
  _clear(previewArea);
  previewArea.appendChild(_el("div", { class: "binding-preview-loading", text: t("assigner.preview.loading") }));
  const done = (render) => {
    if (!_active || _active !== st) return; // 面板已拆挂 → 弃渲染
    _clear(previewArea);
    render();
  };
  castBlock({ name: cur.name, no: cur.no, slots: cur.slots, lang })
    .then((r) => done(() => {
      if (!r.ok) {
        const err = _el("div", {
          class: "binding-preview-error",
          text: t("assigner.preview.fail", { msg: (r.error && r.error.msg) || t("assigner.preview.unknownErr") }),
        });
        _role(err, "binding-preview-error");
        previewArea.appendChild(err);
        return;
      }
      for (const line of (Array.isArray(r.blocks) ? r.blocks : [])) {
        previewArea.appendChild(_el("div", { class: "binding-preview-line", text: line }));
      }
      const fp = _el("span", {
        class: "binding-preview-fp" + (r.fingerprint ? " is-warn" : ""),
        text: r.fingerprint ? t("assigner.fp.mismatch") : t("assigner.fp.match"),
      });
      _role(fp, "binding-preview-fp");
      previewArea.appendChild(fp);
    }))
    .catch(() => done(() => {
      const err = _el("div", { class: "binding-preview-error", text: t("assigner.preview.failNet") });
      _role(err, "binding-preview-error");
      previewArea.appendChild(err);
    }));
}

function _buildBindingItem(st, b, hitMap) {
  const slots = Array.isArray(b.slots) ? b.slots : [];
  const li = _el("li", { class: "binding-item" });
  _role(li, "binding-item");
  li.setAttribute("data-binding-name", b.name || "");
  li.appendChild(_el("span", {
    class: "binding-name",
    text: (b.name || t("assigner.item.unnamed")) + " = Subject " + (Number.isInteger(b.no) ? b.no : "?"),
  }));
  if (b.name && hitMap[b.name]) {
    const hit = _el("span", { class: "binding-hit", text: t("assigner.hit") });
    _role(hit, "binding-hit");
    li.appendChild(hit);
  }
  // slots 概要：chip（kind 槽 idx）+ 每槽解绑钮
  const slotWrap = _el("div", { class: "binding-slots" });
  for (const s of slots) {
    if (!s) continue;
    const chip = _el("span", {
      class: "binding-slot",
      text: s.kind ? t("assigner.slot.chip", { kind: s.kind, idx: Number.isInteger(s.idx) ? s.idx : "?" }) : t("assigner.slot.chipNoKind", { idx: Number.isInteger(s.idx) ? s.idx : "?" }),
    });
    _role(chip, "binding-slot");
    slotWrap.appendChild(chip);
    if (Number.isInteger(s.idx)) {
      const btn = _el("button", { type: "button", class: "binding-slot-remove-btn", text: t("assigner.unbindSlot") });
      _role(btn, "binding-slot-remove");
      btn.title = t("assigner.unbindSlotTitle");
      btn.setAttribute("data-slot-idx", String(s.idx));
      btn.addEventListener("click", () => _unbindSlot(st, b.name, s.idx));
      slotWrap.appendChild(btn);
    }
  }
  li.appendChild(slotWrap);
  // 预览出场块入口 + 渲染区
  const previewBtn = _el("button", { type: "button", class: "binding-preview-btn", text: t("assigner.previewBtn") });
  _role(previewBtn, "binding-preview-btn");
  previewBtn.setAttribute("data-binding-name", b.name || "");
  const previewArea = _el("div", { class: "binding-preview" });
  _role(previewArea, "binding-preview");
  previewBtn.addEventListener("click", () => _runPreview(st, b.name, previewArea));
  li.appendChild(previewBtn);
  li.appendChild(previewArea);
  // 整卡解绑
  const removeBtn = _el("button", { type: "button", class: "binding-remove-btn", text: t("assigner.unbindCard") });
  _role(removeBtn, "binding-remove");
  removeBtn.addEventListener("click", () => _unbindCard(st, b.name));
  li.appendChild(removeBtn);
  return li;
}

// 陈旧黄条（v2-7 生命周期）：卡删除/卡行 media·desc 改动 → 提示 + 解绑钮（用户决断·不静默自动解绑）
function _renderBindingStale(st, items) {
  const assets = (getAssetContext() || {}).assets || {};
  // 批 9 T4（20-b）：assets 上下文未装载/装载降级（空）→ 不判陈旧——否则绑定卡全被误判
  //   「卡已删除」假阳性；装载完成有卡数据后补刷自愈（mount ensureAssetContext.then /
  //   store castBindings:update 均会重渲染本函数）
  if (Object.keys(assets).length === 0) {
    _clear(st.bindStale);
    st.bindStale.classList.add("is-hidden");
    return;
  }
  const staleList = detectStaleBindings(items, assets);
  _clear(st.bindStale);
  if (staleList.length === 0) {
    st.bindStale.classList.add("is-hidden");
    return;
  }
  for (const s of staleList) {
    const reason = s.reason === "deleted"
      ? t("assigner.stale.deleted")
      : t("assigner.stale.row", { slots: s.slotIdxs.map((i) => t("assigner.stale.slot", { idx: i })).join("、") });
    const row = _el("div", { class: "binding-stale-row" });
    row.appendChild(_el("span", {
      class: "binding-stale-text",
      text: t("assigner.stale.decide", { name: s.name, reason }),
    }));
    const btn = _el("button", { type: "button", class: "binding-remove-btn", text: t("assigner.unbindSlot") });
    _role(btn, "stale-unbind-btn");
    btn.setAttribute("data-binding-name", s.name);
    btn.addEventListener("click", () => _unbindCard(st, s.name));
    row.appendChild(btn);
    st.bindStale.appendChild(row);
  }
  st.bindStale.classList.remove("is-hidden");
}

function _renderBindings(st) {
  const proj = storeLoad(st.projectId);
  const items = proj ? normalizeCastBindings(proj.castBindings) : [];
  _clear(st.bindList);
  if (items.length === 0) {
    st.bindEmpty.classList.remove("is-hidden");
    _clear(st.bindStale);
    st.bindStale.classList.add("is-hidden");
    return;
  }
  st.bindEmpty.classList.add("is-hidden");
  const segs = (proj && Array.isArray(proj.segments)) ? proj.segments : [];
  const hitMap = scanBindingHits(items, segs);
  for (const b of items) st.bindList.appendChild(_buildBindingItem(st, b, hitMap));
  _renderBindingStale(st, items);
}

// ③ 卡网格渲染（legacy _renderAssignerCardGrid 适配：renderThumb 无 1.3 对应 → 行标签化）
function _renderCardGrid(st) {
  const grid = st.grid;
  _clear(grid);
  const assets = (getAssetContext() || {}).assets || {};
  const buckets = { characters: [], scenes: [] };
  for (const [name, c] of Object.entries(assets)) {
    if (!c || c._v !== 3) continue;
    if (c.kind === "character") buckets.characters.push([name, c]);
    else if (c.kind === "scene") buckets.scenes.push([name, c]);
  }
  const all = []
    .concat(buckets.characters.map(([n, c]) => [n, c, "character"]))
    .concat(buckets.scenes.map(([n, c]) => [n, c, "scene"]));
  if (all.length === 0) {
    const ph = _el("div", { class: "assigner-card-empty", text: t("assigner.grid.empty") });
    ph.setAttribute("data-h3-role", "assigner-card-empty");
    grid.appendChild(ph);
    return;
  }
  // 绑定映射（tile 已入池高亮 + 槽位徽标）
  const proj = storeLoad(st.projectId);
  const bindings = proj ? normalizeCastBindings(proj.castBindings) : [];
  const bindingByName = {};
  for (const b of bindings) if (b && b.name) bindingByName[b.name] = b;

  for (const [name, card, kind] of all) {
    const rows = (card && Array.isArray(card.rows)) ? card.rows : [];
    const entry = bindingByName[name];
    const isAssigned = !!(entry && Array.isArray(entry.slots) && entry.slots.length > 0);
    const tile = _el("div", { class: "assigner-card-tile" + (isAssigned ? " is-assigned" : "") });
    tile.setAttribute("data-h3-role", "assigner-card-tile");
    tile.setAttribute("data-card-name", name);
    tile.setAttribute("data-card-kind", kind);
    tile.title = isAssigned
      ? t("assigner.tile.assignedTitle", { n: entry.slots.length })
      : t("assigner.tile.assignHint");
    // 行区：每非空 media 行一用途标签 + 媒体名（全空 → 一行占位）
    const thumbs = _el("div", { class: "assigner-card-thumbs" });
    thumbs.setAttribute("data-h3-role", "assigner-card-thumbs");
    const mediaRows = rows.filter((r) => r && typeof r.media === "string" && r.media);
    const displayRows = mediaRows.length > 0 ? mediaRows : [null];
    for (const row of displayRows) {
      const rowWrap = _el("div", { class: "assigner-card-row" });
      const usageId = (row && typeof row.usage === "string") ? row.usage : "";
      const label = usageId ? (USAGE_LABEL[usageId] || usageId) : t("assigner.usage.none");
      const tag = _el("span", { class: "assigner-card-usage", text: label });
      tag.setAttribute("data-h3-role", "assigner-card-row-usage");
      rowWrap.appendChild(tag);
      rowWrap.appendChild(_el("span", {
        class: "assigner-card-media",
        text: (row && row.media) ? String(row.media) : "—",
      }));
      thumbs.appendChild(rowWrap);
    }
    tile.appendChild(thumbs);
    tile.appendChild(_el("div", { class: "assigner-card-tile-name", text: name }));
    // kind 徽标 + 已入池槽位徽标
    const badgeRow = _el("div", { class: "assigner-card-badges" });
    const kindBadge = _el("span", { class: "assigner-kind-badge", text: kind });
    kindBadge.setAttribute("data-h3-role", "assigner-card-tile-kind");
    badgeRow.appendChild(kindBadge);
    if (isAssigned) {
      const slotBadge = _el("span", {
        class: "assigner-slots-badge",
        text: t("assigner.tile.slotsBadge", { n: entry.slots.length }),
      });
      slotBadge.setAttribute("data-h3-role", "assigner-card-tile-slots");
      badgeRow.appendChild(slotBadge);
    }
    tile.appendChild(badgeRow);
    // 「分配」按钮 — 点按钮才入池（legacy T5.3 语义）
    const btn = _el("button", { type: "button", class: "assigner-card-assign-btn", text: t("assigner.tile.assign") });
    btn.setAttribute("data-h3-role", "assigner-card-assign-btn");
    btn.setAttribute("data-card-name", name);
    btn.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      const out = _assignOne(st.projectId, name);
      if (out.error) { _setFeedback(st.feedback, out.error, "error"); return; }
      _setFeedback(st.feedback, out.line, out.skipped.length > 0 ? "warn" : "info");
      _renderOverrideSlot(st, out.skipped.map((s) => ({ name, slot: s })));
    });
    tile.appendChild(btn);
    // 批 8 T5：tile 拖拽起点 — ASSET_DT_MIME 卡载荷（parseAssetPayload 契约 {name,kind,rows,media}；
    //   消费方 = pvbox 手动槽胶囊〔通道②填槽〕/ 本面板 drop〔通道③绑定语义〕）
    tile.setAttribute("draggable", "true");
    tile.addEventListener("dragstart", (ev) => {
      const dt = ev && ev.dataTransfer;
      if (!dt || typeof dt.setData !== "function") return;
      const mediaRow = mediaRows[0];
      dt.setData(ASSET_DT_MIME, JSON.stringify({
        name,
        kind: card && card.kind,
        rows,
        media: (mediaRow && mediaRow.media) || "",
      }));
      dt.effectAllowed = "copy";
    });
    grid.appendChild(tile);
  }
}

// 视图模式应用（单一入口 · 切显隐 + 按钮高亮）
function _applyViewMode(st, mode) {
  st.view = mode;
  const cardsMode = (mode === VIEW_MODE_CARDS);
  if (cardsMode) st.grid.classList.add("is-on"); else st.grid.classList.remove("is-on");
  if (cardsMode) st.assignerRow.classList.add("is-hidden"); else st.assignerRow.classList.remove("is-hidden");
  for (const b of (st.viewBtns || [])) {
    const active = b.getAttribute("data-view-mode") === mode;
    if (active) b.classList.add("active"); else b.classList.remove("active");
  }
}

export function mount(container, projectId) {
  if (typeof document === "undefined" || !container || !projectId) return null;
  _teardown();
  const proj = storeLoad(projectId);
  if (!proj) return null;

  // ---- 面板壳（legacy 章节壳形态：标题 + 折叠钮 + body）----
  const sec = _el("section", { class: "assigner-sec" });
  sec.setAttribute("data-h3-role", "assigner-section");
  const h = _el("h3", { class: "assigner-title" });
  h.appendChild(_el("span", { class: "assigner-title-text", text: t("assigner.title") }));
  const collapseToggle = _el("button", { type: "button", class: "assigner-collapse-toggle", text: "⌄" });
  collapseToggle.setAttribute("aria-label", t("assigner.collapse"));
  collapseToggle.setAttribute("data-h3-role", "assigner-collapse-toggle");
  h.appendChild(collapseToggle);
  sec.appendChild(h);
  const body = _el("div", { class: "assigner-body" });
  sec.appendChild(body);

  // ---- ① 本批角色绑定（T4 · legacy _buildCastBindingsPanel 迁移 · 视觉值在 assigner.css）----
  const bindPanel = _el("div", { class: "cast-bindings-panel" });
  _role(bindPanel, "cast-bindings-panel");
  bindPanel.appendChild(_el("div", { class: "cast-bindings-cap", text: t("assigner.bind.cap") }));
  const bindList = _el("ul", { class: "cast-bindings-list" });
  _role(bindList, "cast-bindings-list");
  bindPanel.appendChild(bindList);
  const bindEmpty = _el("div", {
    class: "binding-empty is-hidden",
    text: t("assigner.bind.empty"),
  });
  _role(bindEmpty, "binding-empty");
  bindPanel.appendChild(bindEmpty);
  const bindStale = _el("div", { class: "binding-stale is-hidden" });
  _role(bindStale, "binding-stale");
  bindPanel.appendChild(bindStale);
  const bindHint = _el("div", {
    class: "bindings-slot-hint",
    text: t("assigner.bind.hint"),
  });
  _role(bindHint, "bindings-slot-hint");
  bindPanel.appendChild(bindHint);
  body.appendChild(bindPanel);

  // ---- ② 本批分配卡汇总 ----
  const cardsPanel = _el("div", { class: "assigned-cards-panel" });
  _role(cardsPanel, "assigned-cards-panel");
  cardsPanel.appendChild(_el("div", { class: "assigned-cards-cap", text: t("assigner.cards.cap") }));
  const cardsList = _el("ul", { class: "assigned-cards-list" });
  _role(cardsList, "assigned-cards-list");
  cardsPanel.appendChild(cardsList);
  const cardsEmpty = _el("div", {
    class: "assigned-cards-empty",
    text: t("assigner.cards.empty"),
  });
  _role(cardsEmpty, "assigned-cards-empty");
  cardsPanel.appendChild(cardsEmpty);
  body.appendChild(cardsPanel);

  // ---- ③ 资产库分配器 ----
  // 视图切换（列表/卡片 · 持久键 gui13.assigner.mode）
  const viewToggle = _el("div", { class: "assigner-view-toggle" });
  _role(viewToggle, "assigner-view-toggle");
  viewToggle.appendChild(_el("span", { class: "assigner-view-label", text: t("assigner.view.label") }));
  const viewBtns = [];
  for (const mode of [VIEW_MODE_LIST, VIEW_MODE_CARDS]) {
    const b = _el("button", {
      type: "button",
      class: "assigner-view-btn",
      text: (mode === VIEW_MODE_LIST) ? t("assigner.view.list") : t("assigner.view.cards"),
    });
    b.setAttribute("data-h3-role", "assigner-view-" + mode);
    b.setAttribute("data-view-mode", mode);
    viewBtns.push(b);
    viewToggle.appendChild(b);
  }
  body.appendChild(viewToggle);

  // 卡网格（卡片模式显 · 列表模式隐）
  const grid = _el("div", { class: "assigner-card-grid" });
  _role(grid, "assigner-card-grid");
  body.appendChild(grid);

  // 列表模式行：双下拉 + 分配按钮
  const assignerRow = _el("div", { class: "assigner-row" });
  _role(assignerRow, "assigner-panel");
  const roleSel = _el("select", { class: "assigner-select" });
  _role(roleSel, "assigner-role-select");
  roleSel.appendChild(_el("option", { value: "", text: t("assigner.sel.rolePh") }));
  roleSel.disabled = true;
  const sceneSel = _el("select", { class: "assigner-select" });
  _role(sceneSel, "assigner-scene-select");
  sceneSel.appendChild(_el("option", { value: "", text: t("assigner.sel.scenePh") }));
  sceneSel.disabled = true;
  const assignBtn = _el("button", {
    type: "button",
    class: "assigner-assign-btn",
    text: t("assigner.assignBtn"),
  });
  _role(assignBtn, "assigner-assign-btn");
  assignBtn.disabled = true;
  assignerRow.appendChild(roleSel);
  assignerRow.appendChild(sceneSel);
  assignerRow.appendChild(assignBtn);
  body.appendChild(assignerRow);

  // 反馈行 / 覆盖占位 / 空态 / 信息行
  const feedback = _el("div", { class: "assigner-feedback is-hidden" });
  _role(feedback, "assigner-feedback");
  body.appendChild(feedback);
  const overrideSlot = _el("div", { class: "assigner-override-slot is-hidden" });
  _role(overrideSlot, "assigner-override-slot");
  body.appendChild(overrideSlot);
  const empty = _el("div", {
    class: "assigner-empty is-hidden",
    text: t("assigner.grid.empty"),
  });
  _role(empty, "assigner-empty");
  body.appendChild(empty);
  const info = _el("div", { class: "assigner-info", text: "" });
  _role(info, "assigner-loaded-info");
  body.appendChild(info);

  container.appendChild(sec);

  const st = {
    projectId,
    node: sec,
    body, bindList, bindEmpty, bindStale, cardsList, cardsEmpty, grid, assignerRow,
    roleSel, sceneSel, assignBtn, feedback, overrideSlot, empty, info,
    viewBtns, unsubStore: null, view: VIEW_MODE_LIST, bindingsTimer: null,
  };
  _active = st;

  // 初始渲染（同步 — 资产上下文已装载时立即出数据；未装载由 ensure 补刷）
  _fillSelectors(st);
  _renderAssignedCards(st);
  _renderBindings(st);

  // 折叠态：boot 读键 → 应用；click → 写键（legacy 同形）
  const applyCollapsed = (collapsed) => {
    if (collapsed) sec.classList.add("is-assigner-collapsed");
    else sec.classList.remove("is-assigner-collapsed");
    body.hidden = !!collapsed;
    collapseToggle.textContent = collapsed ? "⌃" : "⌄";
    collapseToggle.setAttribute("aria-label", collapsed ? t("assigner.expand") : t("assigner.collapse"));
  };
  // 批 J-P7 B1（老板裁 A）：默认折叠——键缺省（首次进入）收起，仅显式 0（用户曾展开）才展开。
  //   入口不删（老板观察期后再裁去留）；折叠壳与样式沿既有 is-assigner-collapsed 惯例不动。
  applyCollapsed(readAssignerCollapsed() !== false);
  collapseToggle.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    const willCollapse = !sec.classList.contains("is-assigner-collapsed");
    applyCollapsed(willCollapse);
    writeAssignerCollapsed(willCollapse);
  });

  // 视图模式：boot 读键 → 应用；点击切换 → 写键 + 重渲网格（legacy 同形 ·
  //   legacy 监听挂 wrap 靠冒泡，此处逐钮直挂——语义等价且不依赖事件冒泡）
  for (const b of viewBtns) {
    b.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      const mode = b.getAttribute("data-view-mode");
      if (!mode || mode === st.view) return;
      writeAssignerViewMode(mode);
      _applyViewMode(st, mode);
      if (mode === VIEW_MODE_CARDS) _renderCardGrid(st);
    });
  }
  _applyViewMode(st, readAssignerViewMode());
  if (st.view === VIEW_MODE_CARDS) _renderCardGrid(st);

  // 「分配到表单」→ 计算 + 落库 + 反馈
  assignBtn.addEventListener("click", () => {
    _runAssign(st, roleSel.value || "", sceneSel.value || "");
  });

  // 批 8 T5 通道③：面板内拖卡落池 = 绑定语义分配（ASSET_DT_MIME 卡载荷 →
  //   _assignOne asBinding:true · applyCardToStore 既有链——面板整体为 drop 区）
  sec.addEventListener("dragover", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dt || !dt.types || Array.from(dt.types).indexOf(ASSET_DT_MIME) < 0) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    dt.dropEffect = "copy";
  });
  sec.addEventListener("drop", (ev) => {
    const dt = ev && ev.dataTransfer;
    const payload = parseAssetPayload(dt);
    if (!payload || typeof payload.name !== "string" || !payload.name) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    const name = payload.name;
    const out = _assignOne(st.projectId, name);
    if (out.error) { _setFeedback(st.feedback, out.error, "error"); return; }
    _setFeedback(st.feedback, out.line, out.skipped.length > 0 ? "warn" : "info");
    _renderOverrideSlot(st, out.skipped.map((s) => ({ name, slot: s })));
  });

  // store 变更（本面板写入/其他视图写入 castBindings·poolManual）→ 汇总块/绑定面板/网格刷新；
  //   segment:update（分镜 prompt 编辑）→ 250ms 防抖重扫绑定命中（legacy prompt input
  //   委托的 store 通道适配）
  const storeFn = (ev) => {
    if (!ev || ev.projectId !== projectId) return;
    if (!_active || _active !== st) return;
    if (ev.type === "segment:update") {
      if (st.bindingsTimer) clearTimeout(st.bindingsTimer);
      st.bindingsTimer = setTimeout(() => {
        st.bindingsTimer = null;
        if (_active === st) _renderBindings(st);
      }, BINDINGS_DEBOUNCE_MS);
      return;
    }
    if (ev.type !== "castBindings:update" && ev.type !== "poolManual:update") return;
    _renderAssignedCards(st);
    _renderBindings(st);
    if (st.view === VIEW_MODE_CARDS) _renderCardGrid(st);
  };
  storeSubscribe(storeFn);
  st.unsubStore = storeFn;

  // 资产装载完成（幂等·已装载立即）→ 下拉/信息行/绑定面板（陈旧对比）补刷
  ensureAssetContext()
    .then(() => {
      if (_active !== st) return;
      _fillSelectors(st);
      _renderBindings(st);
      if (st.view === VIEW_MODE_CARDS) _renderCardGrid(st);
    })
    .catch(() => { /* 资产不可达 → 保持降级空态 */ });

  return sec;
}
