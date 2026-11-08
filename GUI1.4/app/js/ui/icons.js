// icons.js — data-ic 线性图标基础设施（批 R0 · J1 裁决：还原原型 data-ic 图标体系）
//
// === 出处注记（v43 原型实测 · 布局示意-项目工作区交互原型-v43-2026-09-24.html） ===
//   - ICONS path 映射 :2424-2451（24 网格 · 1.8px 描边 · 规范 §五：禁 emoji 当功能图标）
//   - ic() :2452 —— SVG 字符串（默认 16px · viewBox 0 0 24 24 · stroke=currentColor）
//   - hydrateIcons() :2453 —— 扫 [data-ic] · data-sz 控尺寸 · 缺省 16
//   - 原型注入口：启动一次 :6613 / CBRender 渲染后 :4631（渲染后 hydrate 范式）
//   - check 原型为后注入 :3165-3166；pencil/link/expand 原型有用点
//     （:5107/:5134/:4852）但 ICONS 未定义（原型渲染空 svg 的缺口）——
//     本模块按同风格补定义，凑齐原型全部 29 个 data-ic 名称。
//
// 用法：
//   import { ic, hydrateIcons } from "./icons.js";
//   el("span", { "data-ic": "home" });   // 模板期写属性（可选 data-sz）
//   hydrateIcons(root);                  // 渲染后调用 → data-ic 元素内注 <svg class="ic">

export const ICONS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  canvas: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h6M10 4v16"/>',
  folder: '<path d="M3 19V6h6l2 2h10v11z"/>',
  folderplus: '<path d="M3 19V6h6l2 2h10v11z"/><path d="M12 11v5M9.5 13.5h5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-5 4 4 2-2 3 3"/>',
  sliders: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="17" r="2"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10.5 20a1.8 1.8 0 0 0 3 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L21 21"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M16 5v14M3.5 9H8M3.5 15H8M16 9h4.5M16 15h4.5"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.4"/><circle cx="6.5" cy="17" r="2.4"/><path d="M8.6 8.4L20 19M8.6 15.6L20 5"/>',
  music: '<path d="M9 17V6l11-2v11"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="15" r="2.5"/>',
  shuffle: '<path d="M3 8h5l10 8h4M3 16h5l3-2.4M14 16h4"/><path d="M19 5l3 3-3 3M19 13l3 3-3 3"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  upload: '<path d="M12 20V9M8 13l4-4 4 4"/><path d="M5 4h14"/>',
  compare: '<rect x="4" y="4" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="10" height="10" rx="1.5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  sparkle: '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chevup: '<path d="M7 14l5-5 5 5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h7V4M8 20v-6h8v6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  // 原型后注入（:3165-3166 · 复用 sparkle 风格小对勾）
  check: '<path d="M5 12l4 4 10-10"/>',
  // 原型缺口补位（data-ic 有用点 · ICONS 未定义 · 按 24 网格/1.8 描边同风格补）
  pencil: '<path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>',
  link: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
};

// SVG 字符串（照搬原型 :2452 · 未知名回空内容）
export function ic(name, size) {
  const s = size || 16;
  return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

// 扫描作用域内 [data-ic]，按 data-sz（缺省 16）注入 SVG（照搬原型 :2453）
export function hydrateIcons(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-ic]").forEach((el) => {
    el.innerHTML = ic(el.dataset.ic, el.dataset.sz || 16);
  });
}
