// anchor.js — 弹层锚定 helper（F37 · 滚动页面时弹层跟随锚点）
//
// === 病根 ===
// 全仓弹层 position:fixed + 打开瞬间 getBoundingClientRect 算一次坐标挂 body，
// 无任何 scroll 重定位监听 → 滚动/resize 后弹层滞留原地。
//
// === 设计 ===
// 纯函数（anchorPosition 坐标计算）与 DOM 副作用（followAnchor 监听/重算）分离。
// scroll 不冒泡：内层滚动容器（div overflow:auto，如 #views）的滚动只有捕获阶段
// 能在 window 收到 → window 上 addEventListener("scroll", fn, true)。
// resize 同监听；重算统一走 rAF 节流（同一帧多次事件只算一次·防抖动）。
//
// === API ===
//   anchorPosition(anchorRect, opts?) → { left, top [, minWidth] }      纯函数
//     opts.side: "below"(默认) | "above" | "right"
//     opts.gap:  与锚点间距（默认 2·与 cbox 现网 r.bottom+2 一致）
//     opts.minWidth: >0 时产出 minWidth = max(minWidth, 锚点宽)
//   followAnchor(anchorEl, floatingEl, opts?) → { update(), detach() }  DOM 绑定
//     绑定即同步定位一次并注册监听；detach 注销监听（防泄漏·幂等）
//     opts.position(rect) → 样式对象：键=style 属性名，数字加 px、字符串原样
//                           （默认按 opts.side/gap/minWidth 走 anchorPosition）
//     opts.win / opts.raf：监听宿主与帧调度器注入（测试用）
//     无 window 或元素缺失 → 哑句柄（Node 纯逻辑环境降级不抛错）

// ===== 纯函数 =====

export function anchorPosition(anchorRect, opts = {}) {
  const r = anchorRect || {};
  const gap = typeof opts.gap === "number" ? opts.gap : 2;
  const side = opts.side || "below";
  const out = side === "above"
    ? { left: r.left || 0, top: (r.top || 0) - gap }
    : side === "right"
      ? { left: (r.right || 0) + gap, top: r.top || 0 }
      : { left: r.left || 0, top: (r.bottom || 0) + gap };
  if (opts.minWidth > 0) {
    out.minWidth = Math.max(opts.minWidth, r.width || 0);
  }
  return out;
}

// ===== DOM 绑定 =====

export function followAnchor(anchorEl, floatingEl, opts = {}) {
  const noop = { update() {}, detach() {} };
  const win = opts.win || (typeof window !== "undefined" ? window : null);
  if (!win || !anchorEl || !floatingEl) return noop;
  const raf = opts.raf
    || (typeof win.requestAnimationFrame === "function"
      ? (fn) => win.requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 16)); // 无 rAF 环境兜底
  const position = typeof opts.position === "function"
    ? opts.position
    : (rect) => anchorPosition(rect, opts);

  let active = true;
  let scheduled = false;

  function update() {
    if (!active) return;
    if (typeof anchorEl.getBoundingClientRect !== "function") return;
    const pos = position(anchorEl.getBoundingClientRect());
    if (!pos) return;
    for (const k of Object.keys(pos)) {
      if (pos[k] == null) continue;
      floatingEl.style[k] = typeof pos[k] === "number" ? pos[k] + "px" : String(pos[k]);
    }
  }

  function onReflow() {
    if (scheduled || !active) return; // rAF 节流：同一帧多次事件只算一次
    scheduled = true;
    raf(() => {
      scheduled = false;
      update();
    });
  }

  // scroll 捕获阶段（第三参 true）：内层滚动容器的 scroll 不冒泡，只有捕获能到 window
  win.addEventListener("scroll", onReflow, true);
  win.addEventListener("resize", onReflow);

  update(); // 绑定即同步定位一次（open 时立即就位）

  return {
    update,
    detach() {
      if (!active) return; // 幂等
      active = false;
      win.removeEventListener("scroll", onReflow, true);
      win.removeEventListener("resize", onReflow);
    },
  };
}
