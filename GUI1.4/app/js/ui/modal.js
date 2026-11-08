// modal.js — 通用模态基础件 (S1-1 任务 T3).
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）通用 .mbox 范式 + S1-1 T1 portal.js 弹窗模式
//   - portal.js 的 openNewProjectModal（局部实现）+ v43 #tmodal（回收站）/#psmodal（项目设置）等
//   抽象为通用基础件, 主题件仍沿用 theme.css .mbox 视觉（已含）
//
// === 边界 ===
// portal.js 原则不动；本件为新建件，不反向影响 T1 已交付弹窗
// （portal 后续如要 refactor 到本件 = 独立任务；本批不做以保不超界）
//
// === API ===
//   openConfirm(opts) → 确认弹窗（标题/副/确认按钮文案/danger 标记）
//     - opts: { title, sub?, confirmText?, cancelText?, danger?, onConfirm(), onCancel? }
//     - 返回 { close, onCancel } 调用方按需监听
//   openPrompt(opts) → 输入弹窗（标题/副/输入框校验/确认）
//     - opts: { title, sub?, placeholder?, defaultValue?, validate(value) → {ok, hint?}, onConfirm(value), onCancel? }
//     - validate 返回 { ok:false, hint } 显示错误并阻止关闭；返回 { ok:true } 关闭并回调
//   open(opts) → 通用 builder（高级用法：title/sub/footer 自定义）
//     - opts: { title, sub?, contentNode?, footerButtons?, onClose?, closeOnBackdrop? }
//     - 返回 { root, box, close, setTitle, setSub, setFooter }

import { showToast } from "./toast.js";
import { t } from "../core/i18n.js";   // #89 T5a：确认/输入弹窗缺省文案入典 ui.modal.*

// ===== DOM 辅助 =====
function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = String(v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ===== 通用 builder =====
export function open(opts = {}) {
  if (typeof document === "undefined") return { close() {}, setTitle() {}, setSub() {}, setFooter() {} };
  const closeOnBackdrop = opts.closeOnBackdrop !== false;
  const root = el("div", { class: "mbox-wrap", role: "dialog", "aria-modal": "true" });
  root.style.cssText = "position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:100";
  const box = el("div", { class: "mbox" });
  root.appendChild(box);
  // 走查反馈 F17（老板「所有弹窗调节后应该持久化·每次都要调整」）：弹窗尺寸按「弹窗类」记忆
  //   （key = persistKey 或 title 主体（"编辑资产卡 · X" 取 "编辑资产卡"·同类共享）；mbox 自带
  //   resize:both——用户拖角调尺寸后 close 落 localStorage，下次开同类弹窗原样恢复）
  const sizeKey = "gui13.mbox.size." + (opts.persistKey || String(opts.title || "m").split(" · ")[0]);
  const _canStore = typeof globalThis.localStorage !== "undefined" && globalThis.localStorage;
  if (_canStore) {
    try {
      const saved = JSON.parse(globalThis.localStorage.getItem(sizeKey) || "null");
      if (saved && Number.isFinite(saved.w) && saved.w >= 320 && Number.isFinite(saved.h) && saved.h >= 140) {
        box.style.width = saved.w + "px";
        box.style.height = saved.h + "px";
      }
    } catch (_e) { /* 脏值忽略 */ }
  }
  function _persistSize() {
    if (!_canStore) return;
    try {
      const w = box.offsetWidth, h = box.offsetHeight;
      if (w > 0 && h > 0) globalThis.localStorage.setItem(sizeKey, JSON.stringify({ w, h }));
    } catch (_e) { /* 存失败忽略 */ }
  }

  const titleNode = el("h3", { text: opts.title || "" });
  box.appendChild(titleNode);
  const subNode = el("div", { class: "sub", text: opts.sub || "" });
  if (!opts.sub) subNode.style.display = "none";
  box.appendChild(subNode);

  if (opts.contentNode) box.appendChild(opts.contentNode);

  const foot = el("div", { class: "foot" });
  box.appendChild(foot);
  function setFooter(buttons) {
    while (foot.firstChild) foot.removeChild(foot.firstChild);
    for (const b of buttons || []) foot.appendChild(b);
  }
  if (Array.isArray(opts.footerButtons)) setFooter(opts.footerButtons);

  function close() {
    _persistSize(); // F17: 记住用户调过的尺寸（下次同类弹窗恢复）
    if (root.parentNode) root.parentNode.removeChild(root);
    document.removeEventListener("keydown", onEsc);
    if (typeof opts.onClose === "function") {
      try { opts.onClose(); } catch (_e) { /* swallow */ }
    }
  }
  function onEsc(e) {
    if (e && e.key === "Escape") close();
  }
  document.addEventListener("keydown", onEsc);
  if (closeOnBackdrop) {
    // F72（老板：框内按下→框外松开不该关）：判据取**按下点**（mousedown）而非 click。
    //   浏览器 click 派发在 mousedown/mouseup 两目标的共同祖先上——框内按下+遮罩松开
    //   → click target=遮罩根 → 旧判定误判外点而误关。mousedown 的 target 即按下点：
    //   框内按下 target=框内元素（≠root）不关；遮罩按下 target=root 才关。
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) close();
    });
  }

  document.body.appendChild(root);
  return {
    root,
    box,
    close,
    setTitle(t) { titleNode.textContent = t || ""; },
    setSub(s) { subNode.textContent = s || ""; subNode.style.display = s ? "" : "none"; },
    setFooter,
  };
}

// ===== 确认弹窗 =====
export function openConfirm(opts = {}) {
  const danger = !!opts.danger;
  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: opts.cancelText || t("ui.modal.cancel") });
  const confirmBtn = el("button", {
    type: "button",
    class: danger ? "dangerbtn" : "prim",
    text: opts.confirmText || (danger ? t("ui.modal.confirmDelete") : t("ui.modal.confirm")),
  });
  const inst = open({
    title: opts.title || t("ui.modal.confirmTitle"),
    sub: opts.sub,
    footerButtons: [cancelBtn, confirmBtn],
    closeOnBackdrop: !danger, // 危险操作强制走按钮关闭，不点遮罩取消
    onClose: opts.onCancel,
  });
  cancelBtn.addEventListener("click", () => inst.close());
  confirmBtn.addEventListener("click", () => {
    if (typeof opts.onConfirm === "function") {
      try { opts.onConfirm(); } catch (_e) { /* swallow */ }
    }
    inst.close();
  });
  return inst;
}

// ===== 输入弹窗 =====
export function openPrompt(opts = {}) {
  const input = el("input", {
    type: "text",
    class: "ip-name",
    placeholder: opts.placeholder || "",
    value: opts.defaultValue || "",
  });
  // 入参是 defaultValue 时也同步 attr（防止 placeholder 错位）
  if (opts.defaultValue) input.setAttribute("value", opts.defaultValue);
  const hint = el("div", { class: "ip-hint", text: "" });
  const content = el("div");
  content.appendChild(input);
  content.appendChild(hint);

  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: opts.cancelText || t("ui.modal.cancel") });
  const confirmBtn = el("button", { type: "button", class: "prim", text: opts.confirmText || t("ui.modal.confirm") });
  const inst = open({
    title: opts.title || t("ui.modal.promptTitle"),
    sub: opts.sub,
    contentNode: content,
    footerButtons: [cancelBtn, confirmBtn],
    onClose: opts.onCancel,
  });
  cancelBtn.addEventListener("click", () => inst.close());
  confirmBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  function submit() {
    const v = input.value;
    if (typeof opts.validate === "function") {
      const r = opts.validate(v);
      if (!r || r.ok !== true) {
        hint.textContent = (r && r.hint) || t("ui.modal.invalidInput");
        if (typeof showToast === "function") showToast("error", hint.textContent);
        return;
      }
    }
    if (typeof opts.onConfirm === "function") {
      try { opts.onConfirm(v); } catch (_e) { /* swallow */ }
    }
    inst.close();
  }
  setTimeout(() => { try { input.focus(); input.select(); } catch (_e) { /* swallow */ } }, 0);
  return inst;
}