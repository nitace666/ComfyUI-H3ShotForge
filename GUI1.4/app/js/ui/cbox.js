// cbox.js — 自制下拉 cbox 通用件（GUI1.3 S1-2 T2）
//
// === 拍板 12-19 ===
// 打开 = document 级事件委托（动态插入自动覆盖）。
// v43 修正笔 1217：cbox 文档委托适配动态插入；
// 实现：initDocumentDelegate(doc) 一次性绑 click 委托（按目标 cbox 自动 open/close/选择），
// 任何后续插入的 cbox 都被覆盖到。
//
// === 设计 ===
// options 从 .cbox[data-opts] 读（管道 | 分隔），值存于：
//   - 普通 cbox  → .cb-v textContent
//   - 可手输 cbox.edit → .cb-in value
// 数据流：applyOption(cbox, value) → setCurrentValue + 派发 CustomEvent('change', {detail:{value}})
// 视图层在 cbox 上 addEventListener('change', e) → 拿到 e.detail.value → 调 store 更新。
//
// === API ===
//   parseOpts(optsString)        → string[]        纯函数
//   isEditCbox(cboxEl)           → boolean
//   getCurrentValue(cboxEl)      → string          读 .cb-v / .cb-in
//   setCurrentValue(cboxEl, v)   → void            写 .cb-v / .cb-in
//   applyOption(cboxEl, value)   → void            写值 + 派发 change 事件
//   openMenu(cboxEl)             → void            弹下拉菜单（DOM 副作用）
//   closeAllMenus()              → void            关所有打开的菜单
//   initDocumentDelegate(doc)    → void            document 级点击委托（开/关/选）

import { followAnchor } from "./anchor.js";

// ===== 纯函数 =====

export function parseOpts(optsString) {
  if (typeof optsString !== "string" || optsString === "") return [];
  return optsString.split("|");
}

export function isEditCbox(cboxEl) {
  if (!cboxEl || typeof cboxEl !== "object" || !cboxEl.classList) return false;
  return cboxEl.classList.contains("edit");
}

export function getCurrentValue(cboxEl) {
  if (!cboxEl || typeof cboxEl !== "object") return "";
  if (isEditCbox(cboxEl)) {
    const inp = cboxEl.querySelector && cboxEl.querySelector(".cb-in");
    if (inp && typeof inp.value === "string") return inp.value;
    return "";
  }
  const v = cboxEl.querySelector && cboxEl.querySelector(".cb-v");
  if (v && typeof v.textContent === "string") return v.textContent;
  return "";
}

export function setCurrentValue(cboxEl, value) {
  if (!cboxEl || typeof cboxEl !== "object") return;
  const v = value == null ? "" : String(value);
  if (isEditCbox(cboxEl)) {
    const inp = cboxEl.querySelector && cboxEl.querySelector(".cb-in");
    if (inp) inp.value = v;
    return;
  }
  const span = cboxEl.querySelector && cboxEl.querySelector(".cb-v");
  if (span) span.textContent = v;
}

export function applyOption(cboxEl, value) {
  if (!cboxEl || typeof cboxEl !== "object") return;
  // S2-2 T3 后处理：opts 可写 "value=label|value=label" 形态（value 存 store、label 显示）——
  // 入参若含 "="（即来自 openMenu 的 data-co），则写 label 到 cb-v，dispatch 原始 value
  let storedValue = value;
  if (typeof value === "string") {
    const eq = value.indexOf("=");
    if (eq > 0) {
      storedValue = value.slice(0, eq);
      setCurrentValue(cboxEl, value.slice(eq + 1));
    } else {
      setCurrentValue(cboxEl, value);
    }
  } else {
    setCurrentValue(cboxEl, value);
  }
  // 派发 change 事件 — 上层 view 钩子拿到值后写 store
  if (typeof cboxEl.dispatchEvent === "function" && typeof cboxEl.addEventListener === "function") {
    // 浏览器侧必须用真 CustomEvent 实例（普通对象会被 dispatchEvent 拒收——
    // 里程碑①真机补验发现的桩/实机差异：测试桩的假 dispatchEvent 两者都吃，浏览器只认 Event 实例）
    const dispatched = String(storedValue == null ? "" : storedValue);
    if (typeof CustomEvent === "function") {
      cboxEl.dispatchEvent(new CustomEvent("change", { detail: { value: dispatched } }));
    } else {
      cboxEl.dispatchEvent({ type: "change", detail: { value: dispatched } });
    }
  }
}

// ===== DOM 副作用（菜单开/关/选） =====

let _openMenu = null; // 当前打开的菜单节点引用（最多一个）
let _menuAnchor = null; // F37：菜单的锚定句柄（滚动/resize 跟随锚点·close 时注销）

export function openMenu(cboxEl) {
  if (typeof document === "undefined" || !cboxEl) return;
  closeAllMenus();
  const opts = parseOpts(cboxEl.getAttribute && cboxEl.getAttribute("data-opts"));
  if (!opts.length) return;
  const menu = document.createElement("div");
  menu.className = "cbox-menu";
  menu.setAttribute("data-cbox-menu", "1");
  for (const opt of opts) {
    const item = document.createElement("div");
    item.className = "co";
    item.setAttribute("data-co", opt);
    // S2-2 T3 后处理：opts "value=label|value=label" → 菜单项显示 label（等号后），
    // data-co 仍存完整 "value=label"（applyOption 据此拆 value 派发）
    const eq = typeof opt === "string" ? opt.indexOf("=") : -1;
    item.textContent = eq > 0 ? opt.slice(eq + 1) : opt;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      applyOption(cboxEl, opt);
      closeAllMenus();
    });
    menu.appendChild(item);
  }
  // 定位：用 fixed 定位（与 v43 .cbox-menu 同形），贴在 cbox 下方
  // F37：经 anchor helper 锚定——绑定即同步定位一次，滚动/resize 时跟随锚点（旧实现只在打开瞬间算一次）
  menu.style.display = "block";
  document.body.appendChild(menu);
  _openMenu = menu;
  _menuAnchor = followAnchor(cboxEl, menu, { side: "below", gap: 2, minWidth: 150 });
}

export function closeAllMenus() {
  if (typeof document === "undefined") return;
  if (_menuAnchor) { // F37：注销滚动/resize 监听（防泄漏）
    _menuAnchor.detach();
    _menuAnchor = null;
  }
  if (_openMenu && _openMenu.parentNode) {
    _openMenu.parentNode.removeChild(_openMenu);
  }
  // 兜底：清掉残留（动态插入/外部脚本可能直挂 DOM）
  const rest = document.querySelectorAll && document.querySelectorAll(".cbox-menu");
  if (rest) for (const n of rest) if (n.parentNode) n.parentNode.removeChild(n);
  _openMenu = null;
}

// 找事件目标最近的 .cbox 祖先
function findCboxAncestor(target) {
  let n = target;
  while (n && n !== document.body) {
    if (n.classList && n.classList.contains("cbox")) return n;
    n = n.parentNode;
  }
  return null;
}

// document 级事件委托（拍板 12-19）：cbox 点击开菜单；菜单外点击关菜单；菜单内选项点击回填
// 一次性绑定，动态插入的 cbox 自动覆盖
let _delegateBound = null;
export function initDocumentDelegate(doc) {
  if (typeof doc === "undefined" || !doc || !doc.addEventListener) return;
  if (_delegateBound === doc) return; // 幂等
  // 关菜单：document click 在 cbox 外时关
  doc.addEventListener("click", (e) => {
    const t = e.target;
    // 菜单内点击由 openMenu 注册的 stopPropagation 截胡；
    // 此处只处理：cbox 自身 → 打开；其它 → 关闭
    const cbox = findCboxAncestor(t);
    if (cbox) {
      // 若是 cbox.edit 上的输入框（cb-in），不打开（让用户继续手输）
      if (t && t.classList && t.classList.contains("cb-in")) return;
      openMenu(cbox);
      return;
    }
    closeAllMenus();
  });
  _delegateBound = doc;
}
