// notification-adapter — 桌面通知抽象层 (S1-0 任务 T6).
//
// === 出处注记 (S1-0 任务 T6 纪律) ===
// 改造自 legacy/app/js/core/notification-adapter.js（107 行）;
// 改造点 = 壳接口探测点注释预留 (总纲技术路线: 同一份代码浏览器与壳都可运行, 能力走抽象层).
// ===========================================
//
// === 壳形态预留 (S1-0 任务 T6 强制) ===
// 壳形态预留: Tauri 壳接入时在本模块 detect 处挂原生通知 API (window.__TAURI__ 探测),
//   浏览器形态走 Notification API 现状实现;
//   本批只留探测点注释标记, 不实现壳逻辑.
//
// 关键约束:
//   - 调用方必须保证 ensurePermission() 在用户手势栈内调用 (Chrome 等浏览器对
//     Notification.requestPermission() 强制要求: 仅响应用户手势, 否则静默拒).
//     模块顶部注释再申, 调用栈任何一处都不能 setTimeout/await 后才执行 ensurePermission.
//   - 桌面通知可见性策略: env.document.visibilityState==='visible' 时不弹桌面
//     (返回 false, 由调用方走收件箱) — 用户已在工作台前, 收件箱 UI 已足够.
//   - 权限被拒绝后 (permission==='denied') ensurePermission 不再重复请求, 直接
//     降级返 'denied'; show 永远 no-op.
//   - tag 参数用于同批去重 (浏览器自动替换同名 tag 的旧通知).
//
// Tauri 接口位:
//   _detectTauri(env) 探测 env.window.__TAURI__ — 当前恒无, 纯网页环境走浏览器实现.
//   批 S 填肉 (Tauri 适配层) 时: 创建 createTauriDesktopAdapter, 同签名 show, _detectTauri
//   返 true 时调用方切到 Tauri 实现. 当前不引入任何 tauri 依赖.

// ============== 内部工具: 安全取权限字符串 ==============
function _perm(NotificationCtor) {
  try {
    const p = NotificationCtor && NotificationCtor.permission;
    if (p === "granted" || p === "denied" || p === "default") return p;
    return "default";
  } catch (_) { return "default"; }
}

// ============== _detectTauri: 探测 Tauri 运行时 ==============
//  纯函数 — 接受任意 env, 仅看 env.window.__TAURI__ 存在性.
//  当前 GUI 1.0 是纯网页环境, 恒返 false; 后续批 S 切 Tauri 时用此函数分流.
//
// === 壳探测点 (S1-0 任务 T6 标记位) ===
// 探测位即此函数 — 批 S 接入 Tauri 时, 在 _detectTauri 返 true 的分支挂载
// createTauriDesktopAdapter; 浏览器形态保留现状 createDesktopAdapter 实现.
// 本批不实现壳逻辑, 仅标记探测点.
// ===========================================
export function _detectTauri(env) {
  if (!env || typeof env !== "object") return false;
  const win = env.window;
  if (!win || typeof win !== "object") return false;
  return "__TAURI__" in win && win.__TAURI__ != null;
}

// ============== createDesktopAdapter: 工厂 ==============
//  参数缺省: Notification / document 取全局 (window.Notification / window.document),
//  便于浏览器环境直接调; 单测注入假 env 不依赖全局.
//
//  返回: { supported, permission, ensurePermission(), show({title, body, tag}) }
export function createDesktopAdapter(env) {
  const _env = (env && typeof env === "object") ? env : {
    Notification: (typeof window !== "undefined" && window && window.Notification) || (typeof globalThis !== "undefined" && globalThis.Notification) || undefined,
    document: (typeof window !== "undefined" && window && window.document) || (typeof globalThis !== "undefined" && globalThis.document) || undefined,
  };
  const NotificationCtor = _env.Notification;
  const doc = _env.document;

  function supported() {
    if (!NotificationCtor) return false;
    const p = _perm(NotificationCtor);
    return p !== "denied";
  }

  function permission() {
    if (!NotificationCtor) return "denied";
    return _perm(NotificationCtor);
  }

  // ensurePermission: 用户手势栈内调用 (Chrome 强制要求)
  // - granted → 直接真
  // - denied  → 不重复请求, 降级返 'denied'
  // - default → 调 requestPermission()
  // - 无 Notification → 返 'denied' 兜底
  async function ensurePermission() {
    if (!NotificationCtor) return "denied";
    const cur = _perm(NotificationCtor);
    if (cur === "granted") return "granted";
    if (cur === "denied") return "denied";
    try {
      const next = await NotificationCtor.requestPermission();
      if (next === "granted") return "granted";
      return "denied";
    } catch (_) {
      return "denied";
    }
  }

  // show: 可见性策略
  // - visible → 不弹 (返 false)
  // - 非 visible + granted → new Notification
  // - 不支持/拒绝 → no-op 返 false
  function show(payload) {
    const args = (payload && typeof payload === "object") ? payload : {};
    const title = String(args.title || "");
    const body = args.body != null ? String(args.body) : "";
    const tag = args.tag != null ? String(args.tag) : "";
    if (!NotificationCtor) return false;
    const p = _perm(NotificationCtor);
    if (p !== "granted") return false;
    const visState = (doc && typeof doc.visibilityState === "string") ? doc.visibilityState : "visible";
    if (visState === "visible") return false;
    try {
      new NotificationCtor(title, { body, tag });
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    supported: supported(),
    permission: permission(),
    ensurePermission,
    show,
  };
}