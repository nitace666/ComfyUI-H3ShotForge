// at-mention.js — @ 联想通用件（GUI1.3 S1-2 T5）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）:3262-3316
//   - AT_ASSETS 8 条（:3263-3272）{n,name,kind,desc}
//   - KMAP 4 kind（:3275）{人物,场景,道具,音频} → person/scene/prop/audio
//   - atShow 浮窗位置（:3276-3287）上下自适应 + 不出屏不遮输入框
//   - atPick 回替（:3288-3301）/@(\d*)$/ 命中 → 替换为 "@资产名 "（批 J-P10 修订·旧原型 "@N 名字 ")
//   - atBind input 事件 + /@$/ 判定（:3302-3312）
//   - document keydown Esc 关（:3313）
//   - blur 160ms 关（:3311）
//   - #atPanel CSS（:518-523）
//
// === 任务边界 ===
// 本任务（T5）实装：@联想通用件（六条口径全实现）
// 不实装：#atPanel CSS（归 T5 同批 CSS 提取）/ 数据源（归 prompt.loadAssets fetch）
//
// === 六条口径逐条对照（验收 #2 行号↔口径条目） ===
//   ① 裸 @ 才弹  → shouldTrigger(text) === /@$/.test(text)（:3308 v43 同源）
//   ② @ 后输任何字符即隐 → shouldTrigger 拒绝 @a / @123 等（输入 handler 调用 hide）
//   ③ 选中补 "@资产名 " → pick 回替 matchMention(/@(\d*)$/) → "@"+name+" "（纯名字·
//      批 J-P10 修订：旧 "@N 名字 " 带编号·老板 2026-10-06 终裁不要编号）
//   ④ 浮窗上下自适应不出屏不挡输入框 → calcPanelPosition(rect, vp)（v43 :3284-3286 同源）
//   ⑤ 带缩略图 → kindToClass(kind) → th-{person/scene/prop/audio}（v43 KMAP :3275 + :3281 th- 同源）
//   ⑥ blur 160ms 关 / Esc 关 → blurHandler setTimeout 160ms（v43 :3311）+ document keydown Esc（v43 :3313）
//
// === API ===
//   shouldTrigger(text)                   → bool                    纯函数 · 口径 ①
//   matchMention(text)                    → {match,index,n}|null    纯函数 · 口径 ③ 命中提取
//   mentionInsert(asset)                  → string                  纯函数 · 口径 ③ 选中插入文本（"@名字 "）
//   replaceMention(text,start,end,ins)    → string                  纯函数 · 口径 ③ 替换
//   calcPanelPosition(rect,vp,opts?)     → {side,left,maxHeight,*} 纯函数 · 口径 ④ 位置
//   kindToClass(kind)                     → string                  纯函数 · 口径 ⑤ 映射
//   normalizeAssets(arr)                  → [{id,n,name,kind,desc,className,media}]  数据注入标准化
//   buildAssetMap(assets)                 → {n:{name,kind,className,media}}         索引化（与 prompt 共享）
//   thumbUrl(media, size)                 → string                 纯函数 · 批 L1-6 引擎 #30 thumb 通道（空 media → ""）
//   buildPanelHTML(assets)                → string                 纯函数 · 联想面板 HTML（行缩略图叠真图）
//   bind(el, opts)                         → {destroy,refreshAssets} DOM 绑定（Node 环境返回 null）
//   loadAssets(url)                       → Promise<assets[]>       fetch 加载（Node 降级 []）

import { followAnchor } from "./anchor.js"; // F37：浮层滚动/resize 跟随输入框
import { t } from "../core/i18n.js";   // #89 T5a：面板头/kind 显示词入典 ui.at.*（解 T2b 登记长尾）
import { mediaUrl } from "../core/api.js";            // 批 10-L L1-6：thumb 通道同源（path_picker 同款）·批 B #13 收敛单源
import { assetThumbPath } from "../core/assets_api.js"; // 批 10-L L1-6：media → thumb 可消费路径

// ===== 纯函数 =====

// 口径 ①：仅光标紧跟裸"@"才返回 true（v43 :3308 /@$/.test(t) 同源）
export function shouldTrigger(text) {
  if (typeof text !== "string") return false;
  return /@$/.test(text);
}

// 口径 ③：提取光标前 /@(\d*)$/ 命中（v43 :3293 同源）
export function matchMention(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/@(\d*)$/);
  if (!m) return null;
  return { match: m[0], index: text.length - m[0].length, n: m[1] };
}

// 口径 ③：在文本 [start,end) 替换为 ins（v43 :3294 vslice(0,np)+ins+vslice(p) 同源）
export function replaceMention(text, start, end, ins) {
  const s = typeof text === "string" ? text : "";
  const safeStart = Math.max(0, Math.min(s.length, start | 0));
  const safeEnd = Math.max(safeStart, Math.min(s.length, end | 0));
  return s.slice(0, safeStart) + ins + s.slice(safeEnd);
}

// 口径 ③（批 J-P10 修订）：选中后插入的文本 = "@资产名 "（纯名字·不带编号）
//   老板 2026-10-06 两轮澄清终裁：弹窗选「安安2」→ 期望文本「@安安2」，
//   旧形态「@15 安安2」带编号·老板不要编号。
//   提交侧同口径消费（core/submit.js applyMentionBindings：@名字 → castBindings）；
//   @数字 语法全保留（J-P9 通道不拆·资产卡/存量文本场景仍可用）。
//   尾随空格保留（与旧 "@N 名字 " 尾空格同款·接词用）。
export function mentionInsert(a) {
  const name = (a && typeof a.name === "string") ? a.name : "";
  return name ? "@" + name + " " : "@";
}

// 口径 ④：浮窗位置（v43 :3284-3286 同源）
//   入参 rect = {left,right,top,bottom,width}, viewport = {width,height}
//   返回 {side:'up'|'down', left, maxHeight, topPx?, bottomPx?}
export function calcPanelPosition(rect, viewport, opts = {}) {
  const PANEL_W = 300;
  const MARGIN = 8;
  const MIN_UP_SPACE = 210; // 上方空间够的阈值（v43 :3285 r.top>=210）
  const SIDE_GAP = 6;
  const panelMaxHeight = opts.panelMaxHeight || 250;
  const left = Math.max(MARGIN, Math.min(rect.left, viewport.width - PANEL_W - MARGIN));
  if (rect.top >= MIN_UP_SPACE) {
    return {
      side: "up",
      left,
      maxHeight: Math.min(panelMaxHeight, Math.max(0, rect.top - 12)),
      bottomPx: viewport.height - rect.top + SIDE_GAP,
    };
  }
  return {
    side: "down",
    left,
    maxHeight: Math.min(panelMaxHeight, Math.max(0, viewport.height - rect.bottom - 12)),
    topPx: rect.bottom + SIDE_GAP,
  };
}

// 口径 ⑤：kind → css 类（v43 KMAP :3275 同源）
const KIND_MAP = { "人物": "person", "场景": "scene", "道具": "prop", "音频": "audio" };
export function kindToClass(kind) {
  if (typeof kind !== "string") return "prop";
  return KIND_MAP[kind] || "prop";
}

// ===== assetsRev：资产数据版本（任务C #55·2026-10-28 方案 v2.1 务实推荐档）=====
//   资产缩略 URL 追加 &v=<assetsRev>：改图保存 → invalidateAssetsCache 置新 rev →
//   重渲即换 URL（同名重传同路径覆盖场景的浏览器缓存击穿手段·引擎 thumb 24h 缓存）。
//   单源在本模块：写侧唯一=views/prompt.js（资产缓存属主·ui 不反查 views）；读侧=thumbUrl
//   自动携带——资产来源 4 注入点（画布资产节点缩略/画布背景图/@ 面板缩略/提示词页 chip）
//   全部流经 thumbUrl，媒体通用 mediaUrl 零改动（非资产消费方 URL 行为零变化结构性保证）。
let _assetsRev = null;
export function setAssetsRev(v) { _assetsRev = (v == null || v === "") ? null : v; }
export function getAssetsRev() { return _assetsRev; }

// 缩略图 URL（批 10-L L1-6 · 引擎 #30 · 与 path_picker.js:68-70 同款通道）
//   media 走 assetThumbPath 归一：引擎 thumb 按 ComfyUI 根解析相对路径（真机实测
//   asset_library/… 404、input/asset_library/… 200·assets_api.js:1083 同源口径）。
//   无 media → 空串（调用方回退 th-{kind} 色块）。
//   批 B #13：URL 收敛 mediaUrl 单源（引擎口优先·joinBase 基址自持——输出形态与旧 getBase 拼接逐字节同形）。
//   任务C #55：rev 非空时追加 &v=<rev>（引擎 thumb 忽略未知参数·实测 200/ETag 同·节点记录 C 前置验证）。
export function thumbUrl(media, size) {
  const p = assetThumbPath(media);
  if (!p) return "";
  const u = mediaUrl("thumb", p, { maxSize: size });
  return _assetsRev == null ? u : u + "&v=" + encodeURIComponent(_assetsRev);
}

// 资产注入标准化（v43 AT_ASSETS {n,name,kind,desc} → 内部统一结构）
export function normalizeAssets(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => ({
    id: a.id != null ? String(a.id) : (a.n != null ? String(a.n) : null),
    n: typeof a.n === "number" ? a.n : (a.id != null && !Number.isNaN(Number(a.id)) ? Number(a.id) : null),
    name: typeof a.name === "string" ? a.name : "",
    kind: typeof a.kind === "string" ? a.kind : "",
    desc: typeof a.desc === "string" ? a.desc : "",
    className: kindToClass(a.kind),
    media: typeof a.media === "string" ? a.media : "",   // 批 10-L L1-6：卡 media 透传（真图源）
  }));
}

// {n:{name,kind,className}} 快速索引（拼装函数复用）
export function buildAssetMap(assets) {
  const map = {};
  if (!Array.isArray(assets)) return map;
  for (const a of assets) {
    if (a && typeof a.n === "number") {
      map[a.n] = { name: a.name, kind: a.kind, className: a.className, media: a.media || "" };  // 批 10-L L1-6：带 media（预览区 chip 消费）
    }
  }
  return map;
}

// kind 显示词（#89 T5a·解 T2b 登记长尾 prompt.js amKind 场景/人物）：数据 kind 值禁译
//   （KIND_MAP 键/kindToClass 反算依赖中文数据值）·仅 kd 徽标渲染词走典；未登记 kind 原样透传。
const KIND_DISPLAY_KEY = { "人物": "ui.at.kind.person", "场景": "ui.at.kind.scene", "道具": "ui.at.kind.prop", "音频": "ui.at.kind.audio" };   // #92 B2：prop/audio 补齐（数据键零改·显示词走典）
function kindDisplay(kind) {
  const key = kind != null ? KIND_DISPLAY_KEY[kind] : null;
  return key ? t(key) : String(kind == null ? "" : kind);
}

// ===== DOM 绑定（Node 环境降级） =====

let _panelRef = null;
function ensurePanel(doc) {
  if (typeof document === "undefined" || !doc) return null;
  if (_panelRef && _panelRef._doc === doc) return _panelRef;
  const p = doc.createElement("div");
  p.id = "atPanel";
  p.style.display = "none";
  doc.body.appendChild(p);
  p._doc = doc;
  _panelRef = p;
  return p;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function buildPanelHTML(assets) {
  const head = '<div class="at-hd">' + t("ui.at.head") + "</div>";
  const rows = assets.map((a) => {
    const n = a.n != null ? a.n : a.id;
    const cls = a.className || "prop";
    // 批 10-L L1-6：卡有 media → 在 .at-th 色块上叠真图 <img>（引擎 #30 thumb 通道）；
    //   色块类保留作回退底（真图未达/加载失败仍见 kind 渐变）；无 media → 纯色块（既有形态不变）。
    //   尺寸走行内样式（不引新 CSS 文件·随 .at-th 32×32 拉伸铺满·圆角随父）。
    const src = thumbUrl(a.media, 120);
    const img = src
      ? `<img alt="" src="${escapeHtml(src)}" style="display:block;width:100%;height:100%;object-fit:cover;border-radius:inherit">`
      : "";
    return `<div class="at-row" data-n="${escapeHtml(n)}">`
      + `<span class="at-th th-${escapeHtml(cls)}">${img}</span>`
      + `<span>${escapeHtml(a.name)}<span style="color:var(--txt3)"> · ${escapeHtml(a.desc)}</span></span>`
      + `<span class="kd">${escapeHtml(kindDisplay(a.kind))}</span>`
      + `</div>`;
  }).join("");
  return head + rows;
}

function panelPosStyle(el) {
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  const vpW = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vpH = typeof window !== "undefined" ? window.innerHeight : 768;
  const pos = calcPanelPosition(rect, { width: vpW, height: vpH });
  if (pos.side === "up") {
    return { left: pos.left, top: "auto", bottom: pos.bottomPx, maxHeight: pos.maxHeight };
  }
  return { left: pos.left, top: pos.topPx, bottom: "auto", maxHeight: pos.maxHeight };
}

let _activeState = null; // F37：当前展示浮层的 state（Esc 关走 hidePanel 统一注销锚定监听）

function showPanel(state) {
  const panel = state.panel;
  if (!panel) return;
  panel.innerHTML = buildPanelHTML(state.assets);
  panel.style.display = "block";
  // F37：经 anchor helper 锚定输入框——绑定即同步定位一次，滚动/resize 时跟随（旧实现只在此算一次）
  if (state.anchorH) state.anchorH.detach();
  state.anchorH = followAnchor(state.el, panel, { position: () => panelPosStyle(state.el) });
  _activeState = state;
  // 事件委托：at-row 点击 → pick（v43 onmousedown 用元素属性挂，本任务改为 addEventListener 防止依赖 inline JS）
  panel.querySelectorAll(".at-row").forEach((row) => {
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const raw = row.getAttribute("data-n");
      const n = Number(raw);
      const a = state.assets.find((x) => x.n === n)
        || state.assets.find((x) => String(x.id) === String(raw));
      if (a) pick(state, a);
    });
  });
}

function hidePanel(state) {
  if (state && state.panel) state.panel.style.display = "none";
  if (state && state.anchorH) { // F37：隐藏即注销滚动/resize 监听（防泄漏）
    state.anchorH.detach();
    state.anchorH = null;
  }
  if (_activeState === state) _activeState = null;
}

function pick(state, a) {
  const el = state.el;
  const ins = mentionInsert(a);   // 批 J-P10：纯名字「@安安2 」（回替 matchMention 对 "@"/"@15" 同款适配）
  if (el.tagName === "TEXTAREA") {
    const p = el.selectionStart == null ? el.value.length : el.selectionStart;
    const v = el.value || "";
    const m = matchMention((v || "").slice(0, p));
    if (m) {
      const np = m.index;
      el.value = v.slice(0, np) + ins + v.slice(p);
      if (typeof el.focus === "function") el.focus();
      if (typeof el.setSelectionRange === "function") {
        el.setSelectionRange(np + ins.length, np + ins.length);
      }
    } else {
      el.value = v + ins;
    }
  } else {
    const txt = el.textContent || "";   // #92 B2：局部 t → txt 改名（i18n t import 防遮蔽·原语义零变）
    const m = matchMention(txt);
    el.textContent = m ? txt.slice(0, m.index) + ins : txt + ins;
  }
  if (typeof state.onPick === "function") {
    try { state.onPick({ el, asset: a, inserted: ins }); } catch (_e) {}
  }
  hidePanel(state);
}

// 文档级 Esc 关（v43 :3313 同源）——F37：改走 hidePanel（连带注销锚定监听）
let _escBound = false;
function bindEscOnce(doc) {
  if (_escBound || typeof doc === "undefined") return;
  _escBound = true;
  doc.addEventListener("keydown", (e) => {
    if (e && e.key === "Escape" && _panelRef) {
      hidePanel(_activeState);
      _panelRef.style.display = "none";
    }
  });
}

// bind(el, opts) —— 口径 ① ② ③ ⑤ ⑥ 全实现
// opts: { assets, assetsGetter?, panel?, onPick? }
//   - assets: 数组（初始）
//   - assetsGetter: ()=>assets[]（每次 input 重新读，用于"晚加载资产"场景——assets 异步加载后再展示）
//   - panel: 自定义浮窗 DOM（可选；默认 document.body #atPanel 单例）
//   - onPick({el, asset, inserted}) 选中后回调（用于写入 store）
export function bind(el, opts) {
  if (typeof document === "undefined" || !el) return null;
  if (el._atb) return el._atb;
  const doc = el.ownerDocument || document;
  bindEscOnce(doc);
  const state = {
    el,
    assets: Array.isArray(opts && opts.assets) ? opts.assets.slice() : [],
    assetsGetter: opts && typeof opts.assetsGetter === "function" ? opts.assetsGetter : null,
    panel: (opts && opts.panel) || ensurePanel(doc),
    onPick: opts && opts.onPick,
    hideTimer: null,
  };
  function getCurrentAssets() {
    if (state.assetsGetter) {
      const cur = state.assetsGetter();
      if (Array.isArray(cur)) state.assets = cur;
    }
    return state.assets;
  }
  function onInput() {
    const text = el.tagName === "TEXTAREA"
      ? (el.value || "").slice(0, el.selectionStart == null ? el.value.length : el.selectionStart)
      : (el.textContent || "");
    if (shouldTrigger(text)) {
      state.assets = getCurrentAssets();
      showPanel(state);
    } else {
      hidePanel(state);
    }
  }
  function onBlur() {
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => hidePanel(state), 160);
  }
  el.addEventListener("input", onInput);
  el.addEventListener("blur", onBlur);
  const api = {
    state,
    destroy() {
      el.removeEventListener("input", onInput);
      el.removeEventListener("blur", onBlur);
      hidePanel(state); // F37：销毁即隐藏 + 注销锚定监听
      delete el._atb;
    },
    refreshAssets(list) {
      state.assets = Array.isArray(list) ? list.slice() : [];
    },
  };
  el._atb = api;
  return api;
}

// fetch 加载资产（Node 环境无 fetch → 降级空数组；浏览器环境失败降级 + console.warn）
export async function loadAssets(url) {
  if (typeof fetch !== "function") {
    if (typeof console !== "undefined") console.warn("[at-mention] fetch 不可用 · @联想数据源降级为空");
    return [];
  }
  try {
    const resp = await fetch(url);
    if (!resp || !resp.ok) {
      if (typeof console !== "undefined") console.warn("[at-mention] 资产加载失败", resp && resp.status);
      return [];
    }
    const data = await resp.json();
    return normalizeAssets(Array.isArray(data) ? data : []);
  } catch (e) {
    if (typeof console !== "undefined") console.warn("[at-mention] 资产加载异常", e && e.message ? e.message : e);
    return [];
  }
}