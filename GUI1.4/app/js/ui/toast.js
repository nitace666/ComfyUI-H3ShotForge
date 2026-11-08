// toast 通知基础件 (S1-0 任务 T6).
//
// === 出处注记 (S1-0 任务 T6 纪律) ===
// 搬自 legacy/app/js/core/toast.js（130 行），原样取用.
// 模块归属: ui = 组件 (详案 4. ui/toast.js + 通知基础件).
// 仅 import 路径适配: legacy "./api.js" → 本仓 "../core/api.js" (ui/ 是 core/ 的兄弟目录).
// S1-0 节点门修正：busy 分类补第四态 postfx_busy（与 api.js 四 busy 口径对齐）.
// ===========================================
//
// 设计要点:
//   - 栈式渲染: 同 kind 多次叠加 (不覆盖), 每条独立计时.
//   - 三种 kind: success / info / error. 业务调用方可显式传, 也可传 code 让 classify 推断.
//   - 自动消失: 默认 4000ms; timeout=0 = 持久 (需手动关闭).
//   - 桥接 api.js: setToastBridge(fn) 收 (code, msg, detail) → showToast(code, msg, {detail}).
//   - DOM 未就绪或未 init: showToast no-op, 不抛错.
//
// 用法:
//   import { showToast, classify, initToast, registerApiBridge } from "./toast.js";
//   initToast();                       // 启动时调用一次, 创建挂载点
//   registerApiBridge();               // 把 showToast 灌进 api.js 的 setToastBridge
//   showToast("success", "保存成功");
//   showToast("http_500", "server", { detail: null });  // 自动归类为 error

import { t } from "../core/i18n.js";   // #89 T5a：关闭钮 aria 标签入典 ui.toast.*（静态 ui→core 单向·与 i18n 的 setLang 动态 import ui/toast 不成环）

const DEFAULT_TIMEOUT_MS = 4000;

let container = null;  // .gui-toast-container, lazy init

// ============== classify: 纯函数 (code 前缀 → kind) ==============
//
// 业务规则 (沿用 docs/迁移切换单-连接层.md §1 setToastBridge 注释):
//   active_busy / finalizing_busy / concat_busy / postfx_busy → info (409 业务提示, 非错误)
//   http_5xx / network_error / assets_corrupted → error (致命, 需关注)
//   soft_error → warn (status 读取失败, 不致命)
//   其它 → warn (默认)
const _RE_BUSY = /^(active_busy|finalizing_busy|concat_busy|postfx_busy)/;
const _RE_HTTP5XX = /^http_5\d\d/;
const _RE_FATAL = /^(network_error|assets_corrupted)/;

export function classify(code) {
  if (typeof code !== "string" || code === "") return "warn";
  if (_RE_BUSY.test(code)) return "info";
  if (_RE_HTTP5XX.test(code)) return "error";
  if (_RE_FATAL.test(code)) return "error";
  if (code === "soft_error") return "warn";
  return "warn";
}

// ============== initToast: 创建挂载点 ==============
//
// 业务可在 boot 阶段调一次; 若未调, showToast 仍 no-op (lazy fallback).
export function initToast() {
  if (typeof document === "undefined") return;  // SSR / node 测试无 DOM
  if (container && document.body.contains(container)) return;
  container = document.createElement("div");
  container.className = "gui-toast-container";
  container.dataset.role = "toast-container";
  document.body.appendChild(container);
}

// ============== showToast: 弹一条 toast ==============
//
// 签名 (向后兼容 + 业务直通):
//   showToast(kind, msg, opts?)              // kind 显式
//   showToast(code, msg, {detail}?)          // bridge 入口, 用 classify(code) 归类
//
// opts: { timeout?: number, detail?: any }
export function showToast(kindOrCode, msg, opts) {
  if (typeof document === "undefined") return;
  const opts2 = (opts && typeof opts === "object") ? opts : {};
  let kind;
  let usedAsCode = false;
  // 启发: kind ∈ {"success","info","warn","error"} 走显式; 其它视为 code
  if (kindOrCode === "success" || kindOrCode === "info" || kindOrCode === "warn" || kindOrCode === "error") {
    kind = kindOrCode;
  } else {
    kind = classify(kindOrCode);
    usedAsCode = true;
  }
  // DOM 未就绪: no-op
  if (!container || !document.body.contains(container)) {
    initToast();
    if (!container) return;
  }
  const node = document.createElement("div");
  node.className = `gui-toast gui-toast--${kind}`;
  node.dataset.kind = kind;
  if (usedAsCode) node.dataset.code = String(kindOrCode);

  const text = document.createElement("span");
  text.className = "gui-toast__text";
  text.textContent = String(msg ?? "");
  node.appendChild(text);

  if (opts2.detail != null) {
    const detail = document.createElement("span");
    detail.className = "gui-toast__detail";
    detail.textContent = typeof opts2.detail === "string" ? opts2.detail : JSON.stringify(opts2.detail);
    node.appendChild(detail);
  }

  const close = document.createElement("button");
  close.className = "gui-toast__close";
  close.type = "button";
  close.setAttribute("aria-label", t("ui.toast.closeAria"));
  close.textContent = "×";
  close.addEventListener("click", () => dismiss(node));
  node.appendChild(close);

  container.appendChild(node);
  const timeout = opts2.timeout === 0 ? 0 : (typeof opts2.timeout === "number" ? opts2.timeout : DEFAULT_TIMEOUT_MS);
  if (timeout > 0) {
    node._toastTimerId = setTimeout(() => dismiss(node), timeout);
  } else {
    node._toastTimerId = null;
  }
}

function dismiss(node) {
  if (!node || !node.parentNode) return;
  if (node._toastTimerId != null) {
    clearTimeout(node._toastTimerId);
    node._toastTimerId = null;
  }
  node.parentNode.removeChild(node);
}

// ============== registerApiBridge: 一键接管 api.js 的 setToastBridge ==============
//
// 用法: 在 main-gui.js boot() 调 registerApiBridge(); 之后任何 request() 报错自动 toast.
// 与 toast.js 自初始化不冲突: main-gui 调用前若未 initToast, 此函数再保险 init 一次.
export async function registerApiBridge() {
  initToast();
  const apiMod = await import("../core/api.js");
  apiMod.setToastBridge((code, msg, detail) => {
    showToast(code, msg, { detail: detail ?? null });
  });
}