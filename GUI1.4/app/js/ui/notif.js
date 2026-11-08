// notif.js — 通知中心（GUI1.3 S3-4 B2 · A006）
//
// 形态：左栏铃铛 + .notif-panel（v43 原型 CSS 已在 theme.css：.notif-panel/.nh/.nitem/.ndot）。
//   - 条目 {id, time, type, text, read}，时间倒序渲染；未读数驱动铃铛 .dot（0 → 隐藏）
//   - 「全部已读」→ 红点清零 + toast「N 条通知已读」（A006 :3063-3064 文案）
//   - H6（T2）：「清空」→ 清列表落盘；点条目行 → 单条已读（H6 ①：id=`${time}:${text.length}`）
//   - 持久化 localStorage["gui13.notifications"]（仓内 gui13.* 键惯例）· 封顶 50 裁旧
// 通道：列表留档 + 桌面通知（ui/notification-adapter 既有底座——适配器自身契约：页面可见时不弹）。
//   toast 即时通道由事件侧既有 showToast 承接（submit-bar 终态等），本模块不重复弹。
//
// 用法（壳）：mountNotifCenter({ bell }) —— 铃铛点击开/关面板；未读变化实时同步红点。

import { createDesktopAdapter } from "./notification-adapter.js";
import { t } from "../core/i18n.js";   // #89 T5a：通知面板文案入典 ui.notif.*（桌面通知标题=品牌串 H3ShotForge·U-批 U1 解冻 #81）
import { showToast } from "./toast.js";

export const NOTIF_KEY = "gui13.notifications";
export const MAX_NOTIFS = 50;

// ===== 存储 / 适配器（可注入，默认 globalThis.localStorage / 惰性 createDesktopAdapter） =====
let storage = globalThis.localStorage;
export function setStorage(s) { storage = s; }

let adapter = null;
export function setAdapter(a) { adapter = a; }

// ===== 订阅（未读/列表变化 → 壳红点 + 面板重渲染） =====
const _subs = new Set();
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}
function _emit() {
  for (const fn of Array.from(_subs)) {
    try { fn(); } catch (_) { /* 订阅方异常不阻断通知链 */ }
  }
}

// ===== 条目规整（坏数据不落列） =====
// H6 ①：条目补 id（T2）——push 生成 id=`${time}:${text.length}`；存量旧条目（无 id）读出
//   归一兜底同式（v2-8：根除同 time 冲突的最小式；id 用于单条已读定位）。
function _norm(e) {
  if (!e || typeof e !== "object") return null;
  const text = String(e.text == null ? "" : e.text);
  if (!text) return null;
  const type = (e.type === "success" || e.type === "warn" || e.type === "error") ? e.type : "info";
  const time = Number.isFinite(e.time) ? e.time : Date.now();
  const id = (typeof e.id === "string" && e.id) ? e.id : `${time}:${text.length}`;
  return {
    id,
    time,
    type,
    text,
    read: e.read === true,
  };
}

export function loadList() {
  try {
    const raw = storage && storage.getItem(NOTIF_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(_norm).filter(Boolean);
  } catch (_) { return []; }
}

function _save(list) {
  try { storage && storage.setItem(NOTIF_KEY, JSON.stringify(list)); } catch (_) { /* 存储满/禁用 → 静默 */ }
}

// ===== push: 事件入列（头插 + 封顶 + 落盘 + 桌面通知） =====
export function push(entry) {
  const n = _norm(entry);
  if (!n) return null;
  _save([n, ...loadList()].slice(0, MAX_NOTIFS));
  try {
    const a = adapter || (adapter = createDesktopAdapter());
    if (a && typeof a.show === "function") {
      a.show({ title: "H3ShotForge", body: n.text, tag: "gui13-notif" });   // U-批 U1：品牌串改 H3ShotForge（#81 冻结随老板复验解冻·2026-11-06）
    }
  } catch (_) { /* 桌面通知失败不影响留档 */ }
  _emit();
  return n;
}

export function unreadCount(list) {
  const l = Array.isArray(list) ? list : loadList();
  return l.filter((x) => x && x.read !== true).length;
}

// 全部已读：返回清零前未读数（0 = 无未读，不重复 toast）
export function markAllRead() {
  const list = loadList();
  const n = unreadCount(list);
  if (n === 0) return 0;
  _save(list.map((x) => (x.read === true ? x : { ...x, read: true })));
  _emit();
  return n;
}

// H6 ③：单条已读（行点击）——按 id 定位，标 read + 落盘；返回本次标读数（0=无命中/已读）
export function markOneRead(id) {
  if (!id) return 0;
  const list = loadList();
  const hit = list.find((x) => x.id === id);
  if (!hit || hit.read === true) return 0;
  _save(list.map((x) => (x.id === id ? { ...x, read: true } : x)));
  _emit();
  return 1;
}

// H6 ②：清空列表（面板头「清空」）——清列表落盘 + 未读随之归零（订阅驱动空态重渲染）
export function clearAll() {
  _save([]);
  _emit();
}

export function formatTime(ts) {
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ===== 面板 DOM =====
const DOT_COLOR = { success: "var(--ok)", warn: "var(--warn)", error: "var(--bad)", info: "var(--accent-bright)" };

function _el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function _clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

// createPanel(opts?) → { el, render, open, close, toggle, isOpen }
//   opts.onUnreadChange(n)：「全部已读」后回传新未读数（壳侧同步红点）
export function createPanel(opts) {
  if (typeof document === "undefined") return null;
  const o = opts || {};

  const panel = _el("div", "notif-panel");
  panel.setAttribute("id", "notifPanel");
  const head = _el("div", "nh", t("ui.notif.title"));
  const readBtn = _el("span", null, t("ui.notif.readAll"));
  head.appendChild(readBtn);
  const clearBtn = _el("span", null, t("ui.notif.clear"));   // H6 ②：清空列表（.nh span 自带 margin-left:auto，首钮占弹性空间，本钮贴其右）
  clearBtn.style.marginLeft = "10px";
  head.appendChild(clearBtn);
  panel.appendChild(head);
  const list = _el("div", null);
  list.setAttribute("id", "notifList");
  list.style.cssText = "max-height:50vh;overflow-y:auto";
  panel.appendChild(list);

  function render() {
    _clear(list);
    const items = loadList().slice().sort((a, b) => b.time - a.time);
    if (items.length === 0) {
      const empty = _el("div", "nitem", t("ui.notif.empty"));
      empty.style.color = "var(--txt3)";
      list.appendChild(empty);
      return;
    }
    for (const it of items) {
      const row = _el("div", "nitem");
      row.style.cursor = "pointer";
      // H6 ③：单条已读——点行标读；已读/无命中不回传（不空发角标刷新）
      row.addEventListener("click", () => {
        if (markOneRead(it.id) > 0) {
          render();
          _notifyUnread();
        }
      });
      const dot = _el("span", "ndot");
      dot.style.background = DOT_COLOR[it.type] || DOT_COLOR.info;
      row.appendChild(dot);
      const body = document.createElement("div");
      body.appendChild(_el("div", null, it.text));
      body.appendChild(_el("small", null, formatTime(it.time)));
      row.appendChild(body);
      list.appendChild(row);
    }
  }

  function isOpen() { return panel.classList.contains("show"); }
  function open() { render(); panel.classList.add("show"); }
  function close() { panel.classList.remove("show"); }
  function toggle() { if (isOpen()) close(); else open(); }

  function _notifyUnread() {
    if (typeof o.onUnreadChange === "function") {
      try { o.onUnreadChange(unreadCount()); } catch (_) { /* 壳侧异常不阻断 */ }
    }
  }

  readBtn.addEventListener("click", () => {
    const n = markAllRead();
    render();
    if (n > 0) showToast("info", t("ui.notif.readCount", { n }));
    _notifyUnread();
  });

  clearBtn.addEventListener("click", () => {
    clearAll();
    render();
    _notifyUnread();
  });

  return { el: panel, render, open, close, toggle, isOpen };
}

// ===== mountNotifCenter: 铃铛接线（红点由未读数驱动；面板挂 document.body——fixed 浮层） =====
// 返回 { panel, el, sync }：sync 供外部手动刷新红点。
export function mountNotifCenter(opts) {
  if (typeof document === "undefined" || !opts || !opts.bell) return null;
  const bell = opts.bell;
  const dot = _el("span", "dot");
  bell.appendChild(dot);

  const panel = createPanel({ onUnreadChange: () => sync() });
  document.body.appendChild(panel.el);

  // 批 10C-T1 · F57（老板裁⑤A=侧栏底部）：铃铛随芯片槽位落侧栏底部 → 面板锚铃铛向上弹出。
  //   开面板前按铃铛实时几何落点（fixed 坐标：left=铃铛左缘·bottom=视口高−铃铛顶+8）；
  //   取不到几何（fake DOM/零矩形）→ 不写内联，走 theme.css 兜底位（left:10 bottom:64）。
  function _placeAboveBell() {
    if (typeof bell.getBoundingClientRect !== "function") return;
    const r = bell.getBoundingClientRect();
    if (!r || (!r.top && !r.left)) return;
    panel.el.style.left = Math.max(10, r.left) + "px";
    panel.el.style.bottom = Math.max(64, (globalThis.innerHeight || 800) - r.top + 8) + "px";
  }

  function sync() {
    const n = unreadCount();
    dot.textContent = n > 0 ? String(n) : "";
    dot.style.display = n > 0 ? "inline-block" : "none";
  }
  sync();

  bell.addEventListener("click", () => { _placeAboveBell(); panel.toggle(); });

  // R-35（F72→R-35）：面板开着点面板外 → 关。判按下点 mousedown（F72 惯例，同 modal.js）。
  //   必须排除铃铛：否则开面板后点铃铛，外点关先于 click toggle 触发 → 关了又被 toggle 开回（永远关不上）。
  //   mount 一次挂线，与铃铛 click 监听同寿（面板随页面存在，无 per-open 解绑面）。
  document.addEventListener("mousedown", (e) => {
    if (!panel.isOpen()) return;
    const t = e && e.target;
    if (t && (panel.el.contains(t) || bell.contains(t))) return;
    panel.close();
  });

  subscribe(() => {
    sync();
    if (panel.isOpen()) panel.render();
  });

  return { panel, el: panel.el, sync };
}
