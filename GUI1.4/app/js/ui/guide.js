// guide.js — 门户三小件：新手向导 / 全局搜索 / 快捷键帮助（GUI1.3 S3-4 B7 · 详案 §S3-4g · A013/A014）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）：
//   - 快捷键帮助形态 = #hkmodal（:2331-2342「.mbox + h3「快捷键」+ .cfg .row[k/v]」）；清单内容按
//     「本仓已实装热键」重写（原型清单为演示态；原型 :3839 的 ? 键触发照搬）。
//   - 全局搜索入口 = hero-sub :1073（原型为 toast 示意）；文档级 Ctrl+K 照搬 :3185。
//   - 门户入口文案「从零到第一条成片的分步引导」= 原型 :1072 向导 toast 文案。
//
// === 边界与取舍（S3-4 B7 任务单） ===
//   - 向导：分步弹窗序列 + 首访自动弹一次（B块任务6：弹即写 localStorage["gui13.guide.seen"] 标记，
//     之后不再自动弹）；门户入口 title 反映「可重看」。分步高亮仅文字指引（不真高亮目标 DOM 区）——最小实现已登记。
//   - 搜索：Ctrl+K（文档级·任意视图）与 hero-sub 入口；匹配项目名 + 资产卡名（子串·不区分大小写）；
//     项目点击走 onOpenProject 注入通道，资产点击跳 #/assets。
//   - 帮助入口 = 搜索弹窗内「快捷键帮助」+ 文档级 ? 键（非输入态）——不占 hero-sub 四项原型槽位。
//
// === 批 5-T3（H5 全站搜索增强） ===
//   - 三源：项目名（既有）+ 资产（名/标签/备注·core filterAssets 直喂 {name:card}）+ 历史任务
//     （listHistory limit 200·task_id/mode/note）。
//   - 结果项 <mark class="gs-mark"> 命中词高亮（highlightSnippet 搬 legacy domain/search.js:90）。
//   - 跳转三链：项目（onOpenProject）/ 资产（sessionStorage 锚 gui13.gotoAsset·assets.js mount 消费
//     → 滚动+2s 高亮该卡）/ 历史（切当前项目剪辑 TAB → edit 域 openHistoryModal 锚定行）。

import { open as openModal } from "./modal.js";
import { showToast } from "./toast.js";
import { t } from "../core/i18n.js";   // #89 T5a：向导/快捷键/搜索弹层文案入典 guide.*
import { listProjects } from "../store/store.js";
import { listAssets, filterAssets, normalizeTags } from "../core/assets_api.js";
import { listHistory } from "../core/history_ops.js";
import { projectIdFromHash } from "./queue.js";

// ===== DOM 辅助（modal.js 同范式·本模块自持） =====
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ===== ① 新手向导 =====
export const GUIDE_SEEN_KEY = "gui13.guide.seen";

// 6 步（B块任务3前插第 0 步启动引擎；步文案对齐本仓真实链路：引擎 → 门户 → 设定 → 提交 → 剪辑 → 预览）
// #89 T5a：title/body 存典键 guide.s<n>.*·渲染处 t() 取词（切语言=整页 reload·键面形状不变）
export const GUIDE_STEPS = [
  // B块任务3：生成靠本地引擎，新手第一件事=先把引擎拉起来（设置页启动钮 / 侧栏底部引擎芯片同链；
  //   三态：未连接灰 / 启动中黄 / 已连接绿——"等绿灯"即已连接）
  { title: "guide.s0.title", body: "guide.s0.body" },
  { title: "guide.s1.title", body: "guide.s1.body" },
  { title: "guide.s2.title", body: "guide.s2.body" },
  { title: "guide.s3.title", body: "guide.s3.body" },
  // B块任务4：旧文案让用户找向导内不存在的「快捷键帮助」按钮——改为真实入口（? 键 / Ctrl+K 底栏）
  { title: "guide.s4.title", body: "guide.s4.body" },
  // B块任务5：统一词表「拼接」→「合并」（仅用户可见文案；projMode 存储值/CSV 契约键/引擎 phase 豁免不动）
  { title: "guide.s5.title", body: "guide.s5.body" },
];

let storage = globalThis.localStorage;
export function setStorage(s) { storage = s; }

function readSeen() {
  try { return !!(storage && storage.getItem(GUIDE_SEEN_KEY)); } catch (_e) { return false; }
}

export function isGuideSeen() { return readSeen(); }

export function markGuideSeen() {
  try { storage && storage.setItem(GUIDE_SEEN_KEY, "1"); } catch (_e) { /* 存储禁用 → 记忆不可用不阻断 */ }
}

// 门户入口 title（未读=引导文案 / 已读=可重看）
export function guideEntryTitle() {
  return t(readSeen() ? "guide.entry.seen" : "guide.entry.new");
}

// 分步弹窗：上一步 / 下一步（末步「开始使用」）+ 步计数；完成 → 写记忆
export function openGuideModal(opts = {}) {
  if (typeof document === "undefined") return null;

  // 视觉沿用 .mbox 主题；步区最小内联排版（不新增 CSS 文件）
  const counter = el("div", { class: "gd-counter", style: "color:var(--txt3);font-size:12px;margin-bottom:6px" });
  const stepTitle = el("div", { class: "gd-title", style: "font-size:14px;margin-bottom:6px" });
  const stepBody = el("div", { class: "gd-body", style: "font-size:13px;color:var(--txt2);line-height:1.7;min-height:44px" });
  const content = el("div", { class: "gd-step" }, [counter, stepTitle, stepBody]);
  const prevBtn = el("button", { type: "button", class: "ghostbtn", text: t("guide.wizard.prev") });
  const nextBtn = el("button", { type: "button", class: "prim", text: t("guide.wizard.next") });
  const inst = openModal({
    title: t("guide.wizard.title"),
    sub: t("guide.wizard.sub", { n: GUIDE_STEPS.length }),
    contentNode: content,
    footerButtons: [prevBtn, nextBtn],
  });

  let idx = 0;
  function render() {
    const step = GUIDE_STEPS[idx];
    counter.textContent = t("guide.wizard.step", { i: idx + 1, n: GUIDE_STEPS.length });
    stepTitle.textContent = t(step.title);
    stepBody.textContent = t(step.body);
    prevBtn.disabled = idx === 0;
    nextBtn.textContent = idx === GUIDE_STEPS.length - 1 ? t("guide.wizard.start") : t("guide.wizard.next");
  }
  prevBtn.addEventListener("click", () => { if (idx > 0) { idx--; render(); } });
  nextBtn.addEventListener("click", () => {
    if (idx < GUIDE_STEPS.length - 1) { idx++; render(); return; }
    markGuideSeen();
    inst.close();
    if (typeof opts.onFinish === "function") {
      try { opts.onFinish(); } catch (_e) { /* 回调异常不影响关闭 */ }
    }
  });
  render();
  return inst;
}

// ===== ③ 快捷键帮助（#hkmodal · 本仓已实装热键汇总） =====
// 行分类依据：edit.js 热键套（:1283-1306·Ctrl+X=剪切 edit.js:4041）+ submit-bar.js Ctrl+Enter 运行（:1613）
//   + ui/modal.js·at-mention Esc + 本模块全局键
// #89 T5a：desc 存典键 guide.hk.*·keys 列多为字面键位（t() 未命中回返键面原样·空格行走 guide.hk.keys.space）
export const SHORTCUTS = [
  { keys: "Ctrl + K", desc: "guide.hk.search.desc" },
  { keys: "?", desc: "guide.hk.help.desc" },
  { keys: "Esc", desc: "guide.hk.esc.desc" },
  { keys: "Ctrl + Z", desc: "guide.hk.undo.desc" },
  { keys: "Ctrl + Y / Ctrl + Shift + Z", desc: "guide.hk.redo.desc" },
  { keys: "Ctrl + A", desc: "guide.hk.selectAll.desc" },
  { keys: "Ctrl + C", desc: "guide.hk.copy.desc" },
  { keys: "Ctrl + V", desc: "guide.hk.paste.desc" },
  { keys: "Ctrl + X", desc: "guide.hk.cut.desc" },       // #89 T5a 补缺：剪切（edit.js G-T3 实装）
  { keys: "Ctrl + B", desc: "guide.hk.split.desc" },
  { keys: "Delete / Backspace", desc: "guide.hk.delete.desc" },
  { keys: "guide.hk.keys.space", desc: "guide.hk.play.desc" },
  { keys: "← / →", desc: "guide.hk.nudge.desc" },
  { keys: "Home / End", desc: "guide.hk.homeEnd.desc" },
  { keys: "guide.hk.keys.wheel", desc: "guide.hk.zoom.desc" },
  { keys: "Ctrl + Enter", desc: "guide.hk.run.desc" },   // #89 T5a 补缺：运行项目（submit-bar.js H4 实装）
];

export function openShortcutHelpModal() {
  if (typeof document === "undefined") return null;
  const cfg = el("div", { class: "cfg" });
  for (const s of SHORTCUTS) {
    cfg.appendChild(el("div", { class: "row hk-row" }, [
      el("span", { class: "k", text: t(s.keys) }),
      el("span", { class: "v", text: t(s.desc) }),
    ]));
  }
  return openModal({
    title: t("guide.hk.title"),
    sub: t("guide.hk.sub"),
    contentNode: cfg,
  });
}

// ===== ② 全局搜索 =====
// B6-T1 清偿 b（批 5 遗留）：搜索数据来自引擎/本地（可含 < &），line.innerHTML 直拼会注入。
//   转义函数就地复制 at-mention.js:134（五字符集 & < > " '）。
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// 命中词高亮（纯函数 · 口径搬 legacy domain/search.js:90 highlightSnippet；
//   差异 = <mark> 加 class="gs-mark" 供 shell.css 着色）
// B6-T1 清偿 b：before/hit/after 三段**分别** escapeHtml 再拼 mark——
//   整体 escape 会把 mark 标签本身转义掉，且命中词偏移错位。
export function highlightSnippet(text, kw) {
  const s = (typeof text === "string") ? text : "";
  const q = (typeof kw === "string") ? kw.trim() : "";
  if (!q) return escapeHtml(s);
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return escapeHtml(s);
  return escapeHtml(s.slice(0, idx))
    + '<mark class="gs-mark">' + escapeHtml(s.slice(idx, idx + q.length)) + "</mark>"
    + escapeHtml(s.slice(idx + q.length));
}

// 三源匹配（纯函数）：项目名 + 资产（filterAssets 走 名/标签/备注）+ 历史任务（task_id/mode/note）
export function matchItems(query, data = {}) {
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return { projects: [], assets: [], tasks: [] };
  const hit = (v) => String(v == null ? "" : v).toLowerCase().includes(q);
  return {
    projects: (data.projects || []).filter((p) => p && hit(p.name)),
    assets: filterAssets(data.assets || {}, q),
    tasks: (data.tasks || []).filter((t) => t && (hit(t.task_id) || hit(t.mode) || hit(t.note))),
  };
}

// 资产跳转锚键（写点本件，消费点 app/js/views/assets.js）
export const GOTO_ASSET_KEY = "gui13.gotoAsset";

function goAssets() {
  try { if (globalThis.location) globalThis.location.hash = "#/assets"; } catch (_e) { /* 无 location → 静默 */ }
}

// B6-T1 清偿 a（批 5 遗留·同页锚）：当前已经在资产页时，hash 写同值不触发重挂
//   （shell router 同路由去抖）→ 锚滞留 sessionStorage，直到下次重挂才消费。
//   写锚后直接惰性 import assets.js 消费（ui 层不静态反向 import views，path_picker.js:18 口径）；
//   非同页不提前消费——锚留给 assets mount（死锚即清行为在 consume 内保留）。
function isOnAssetsPage() {
  const loc = globalThis.location;
  const hash = loc && typeof loc.hash === "string" ? loc.hash : "";
  return hash.replace(/^#/, "").split("?")[0] === "/assets";
}

function consumeAnchorSamePage() {
  import("../views/assets.js")
    .then((m) => m.consumeGotoAssetAnchor(globalThis.document))
    .catch(() => { /* 消费失败不阻断跳转（锚留待下次 mount） */ });
}

// 历史任务跳转：切当前项目剪辑 TAB → 开 edit 域历史弹窗（limit 200 + 锚定行）。
// ui 层不静态反向 import views（path_picker.js:18 口径）→ 惰性 import 取 openHistoryModal。
function goHistoryTask(taskId) {
  const loc = globalThis.location;
  const pid = projectIdFromHash(loc && loc.hash);
  if (pid && loc) loc.hash = `#/project/${encodeURIComponent(pid)}?tab=edit`;
  import("../views/edit.js")
    .then((m) => m.openHistoryModal({ limit: 200, anchorTaskId: taskId }))
    .catch((e) => showToast("error", t("guide.toast.historyFail", { msg: e && e.message ? e.message : e })));
}

// 资产结果副文本：命中备注/标签 → 展示命中字段（mark 可见）；名称命中 → 展示标签/备注上下文
function assetSubText(card, q) {
  const tags = normalizeTags(card && card.tags).join(" ");
  const memo = (card && typeof card.memo === "string") ? card.memo : "";
  const ql = String(q || "").toLowerCase();
  const has = (s) => !!s && s.toLowerCase().includes(ql);
  if (has(memo)) return memo;
  if (has(tags)) return tags;
  return [tags, memo].filter(Boolean).join(" · ");
}

// opts: { onOpenProject(id), onOpenAssets(name), listAssetsFn, listHistoryFn }（后三者为注入通道/单测替身）
export function openSearchModal(opts = {}) {
  if (typeof document === "undefined") return null;

  const input = el("input", {
    type: "text",
    class: "gs-input",
    placeholder: t("guide.search.placeholder"),
    style: "width:100%;padding:8px 10px;font-size:13px;box-sizing:border-box;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);outline:none",
  });
  const results = el("div", { class: "gs-results", style: "margin-top:8px;max-height:260px;overflow:auto" });
  const content = el("div", { class: "gs-form" }, [input, results]);
  const helpBtn = el("button", { type: "button", class: "ghostbtn", text: t("guide.search.helpBtn") });
  const closeBtn = el("button", { type: "button", class: "prim", text: t("guide.search.closeBtn") });
  const inst = openModal({
    title: t("guide.search.title"),
    sub: t("guide.search.sub"),
    contentNode: content,
    footerButtons: [helpBtn, closeBtn],
  });

  function makeItem(kind, id, label, subs) {
    const it = el("div", {
      class: "gs-item",
      "data-kind": kind,
      "data-id": id,
      style: "padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px",
    });
    const q = String(input.value || "").trim();
    const line = el("div", { class: "gs-line" });
    line.innerHTML = highlightSnippet(label, q);
    it.appendChild(line);
    for (const s of (subs || [])) {
      if (!s) continue;
      const meta = el("div", { class: "gs-meta" });
      meta.innerHTML = highlightSnippet(s, q);
      it.appendChild(meta);
    }
    it.addEventListener("click", () => {
      inst.close();
      if (kind === "project") {
        if (typeof opts.onOpenProject === "function") {
          try { opts.onOpenProject(id); } catch (_e) { showToast("error", t("guide.toast.openProjectFail", { msg: _e && _e.message ? _e.message : _e })); }
        } else showToast("info", t("guide.search.demoOpen", { name: label }));
      } else if (kind === "asset") {
        // 资产跳转锚：assets.js mount 消费即清 → 滚动 + 高亮该卡 2s（先例 gui13.gotoSeg）
        try { globalThis.sessionStorage && globalThis.sessionStorage.setItem(GOTO_ASSET_KEY, String(id)); } catch (_e) { /* 隐私模式忽略 */ }
        // 清偿 a：已在资产页 → 写锚后直接消费（实施点在 onOpenAssets 调用之前；跳转语义不动）
        if (isOnAssetsPage()) consumeAnchorSamePage();
        if (typeof opts.onOpenAssets === "function") {
          try { opts.onOpenAssets(id); } catch (_e) { showToast("error", t("guide.toast.gotoAssetsFail", { msg: _e && _e.message ? _e.message : _e })); }
        } else goAssets();
      } else if (kind === "history") {
        goHistoryTask(id);
      }
    });
    return it;
  }

  function render() {
    clearChildren(results);
    const qRaw = String(input.value || "").trim();
    if (!qRaw) {
      results.appendChild(el("div", { class: "gs-hint", text: t("guide.search.hint"), style: "color:var(--txt3);font-size:12px;padding:6px 2px" }));
      return;
    }
    const { projects, assets, tasks } = matchItems(qRaw, { projects: listProjects(), assets: assetMap, tasks: historyTasks });
    if (!projects.length && !assets.length && !tasks.length) {
      results.appendChild(el("div", { class: "gs-hint", text: t("guide.search.noMatch"), style: "color:var(--txt3);font-size:12px;padding:6px 2px" }));
      return;
    }
    const groupStyle = "color:var(--txt3);font-size:12px;margin:8px 0 4px";
    if (projects.length) {
      results.appendChild(el("div", { class: "gs-group", text: t("guide.search.groupProjects"), style: groupStyle }));
      for (const p of projects) results.appendChild(makeItem("project", p.id, p.name || t("guide.search.unnamed")));
    }
    if (assets.length) {
      results.appendChild(el("div", { class: "gs-group", text: t("guide.search.groupAssets"), style: groupStyle }));
      for (const name of assets) results.appendChild(makeItem("asset", name, name, [assetSubText(assetMap[name], qRaw)]));
    }
    if (tasks.length) {
      results.appendChild(el("div", { class: "gs-group", text: t("guide.search.groupTasks"), style: groupStyle }));
      for (const t of tasks) {
        const meta = `${t.mode || ""} · ✓${t.success != null ? t.success : 0} ✕${t.failed != null ? t.failed : 0} / ${t.total != null ? t.total : 0}`;
        const note = typeof t.note === "string" ? t.note : "";
        const subs = [meta];
        // 备注命中才展示备注行（可见 mark；未命中不噪声）
        if (note && note.toLowerCase().includes(qRaw.toLowerCase())) subs.push(note);
        results.appendChild(makeItem("history", t.task_id, t.task_id || "", subs));
      }
    }
  }

  // 三源异步装载（引擎不可用 → 该源空置，不阻断其余源搜索）
  let assetMap = {};
  let historyTasks = [];
  const assetsLoader = typeof opts.listAssetsFn === "function" ? opts.listAssetsFn : listAssets;
  Promise.resolve()
    .then(() => assetsLoader())
    .then((r) => { assetMap = (r && r.ok && r.assets) ? r.assets : {}; render(); })
    .catch(() => { assetMap = {}; render(); });
  const historyLoader = typeof opts.listHistoryFn === "function" ? opts.listHistoryFn : listHistory;
  Promise.resolve()
    .then(() => historyLoader({ limit: 200 }))
    .then((r) => { historyTasks = (r && r.ok && Array.isArray(r.tasks)) ? r.tasks : []; render(); })
    .catch(() => { historyTasks = []; render(); });

  input.addEventListener("input", render);
  helpBtn.addEventListener("click", () => { inst.close(); openShortcutHelpModal(); });
  closeBtn.addEventListener("click", () => inst.close());
  render();
  // 真机 UX：唤起即聚焦输入框（node stub 无 focus → 跳过）
  if (typeof input.focus === "function") {
    setTimeout(() => { try { input.focus(); } catch (_e) { /* 忽略 */ } }, 0);
  }
  return inst;
}

// ===== ④ 文档级全局键（Ctrl+K 全局搜索 / ? 快捷键帮助 · 任意视图可触发·A013/A014） =====
// 返回卸载函数（壳/测试用；重复安装由调用方自行避免）
export function installGlobalKeys(doc, opts = {}) {
  if (!doc || typeof doc.addEventListener !== "function") return () => {};

  function isTyping(node) {
    const t = node || {};
    return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable === true;
  }
  function onKey(e) {
    if (!e || !e.key) return;
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      openSearchModal(opts);
      return;
    }
    // 原型 :3839：输入态不抢 ?（该键是正常输入字符）
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !isTyping(doc.activeElement)) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      openShortcutHelpModal();
    }
  }
  doc.addEventListener("keydown", onKey);
  return () => { try { doc.removeEventListener("keydown", onKey); } catch (_e) { /* 忽略 */ } };
}
