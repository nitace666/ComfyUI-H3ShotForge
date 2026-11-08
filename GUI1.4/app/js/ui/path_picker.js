// ui/path_picker.js — 服务器文件浏览器弹窗（批 2-T3 · B1 大件 · F3 引擎库选图基础件）
//
// 出处：legacy/app/js/domain/path_picker.js（GUI1.0 批 1.4 迁入版）整体迁出改造。
//   保留能力：目录列表逐级下钻 / 盘符枚举 / 盘根上级回盘符 / 搜索过滤 / 手输路径定位 /
//             图片缩略图网格（引擎 #30 thumb）/ 扩展名过滤（"显示全部文件"可放开）/
//             两层扫描（opts.scan）/ input_dir 起跳 / 记住上次浏览位置。
//   1.3 改造：
//     ① 引擎调用走 core/browse.js.listDirectory（core/api.js request 出口·200+{error} 归一）；
//     ② 弹窗外壳走 ui/modal.js（.mbox + .foot + ESC/遮罩关闭 + 弹窗尺寸记忆），行内样式沿用 legacy；
//     ③ 入口 opts.mode：'dir' 选目录（选择钮 = 当前目录）/ 'file' 选文件（exts 过滤）/ 'image' 选图
//        （exts 缺省 = IMAGE_EXTS）；mode 缺省时兼容 legacy 的 opts.kind（'dir'|'file'）；
//     ④ 选中登记 = name → 元素映射（手输定位与鼠标点选同一链，不查 DOM）。
//   裁剪（映射表见批 2-T3 报告）：CSV 纯函数归 core/csv_transfer.js；localStorage 选择记忆/recent
//     归 gui13.paths；扫描 30s memo（1.3 无刷新突发场景）；nativePick/webUtils（浏览器部署不接）；
//     搜索不再回取全量（exts 过滤即契约·"显示全部文件"放开）。
//
// ESM 依赖（单向）：../core/api.js（getBase/request）、../core/browse.js（listDirectory/joinPath/
//   scanTwoLevels）、../core/server_storage.js（readAgg·起跳偏好子键读）、./modal.js（弹窗外壳）。
//   不反向 import views。

import { mediaUrl, request } from "../core/api.js";   // 批 B #13：媒体 URL 收敛单源
import { t } from "../core/i18n.js";   // #89 T5a：文件浏览器弹窗文案入典 ui.path.*
import { joinPath, listDirectory, scanTwoLevels } from "../core/browse.js";
import { readAgg, SETTINGS_JSON } from "../core/server_storage.js";   // 批Gb T7：起跳偏好读 settings 聚合子键
import { open as openModal } from "./modal.js";

// image 模式缺省扩展名（与引擎 #30 thumb 图片族一致）
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff"];
const THUMB_EXTS = new Set(IMAGE_EXTS);

let lastDir = ""; // 上次浏览位置（下次打开从这继续）
let cur = null;   // 当前弹窗 { inst, els, st }

// ============================================================================
// 1. 纯函数（导出 · 单测覆盖）
// ============================================================================

// 从字段当前值推断初始目录：绝对路径取其父目录，否则走调用方兜底（legacy 同口径）
export function startDirOf(current, fallbackDir) {
  const norm = String(current == null ? "" : current).replace(/\//g, "\\");
  if (/^[A-Za-z]:\\/.test(norm)) {
    const i = norm.lastIndexOf("\\");
    return i > 2 ? norm.slice(0, i) : norm.slice(0, 3);
  }
  return fallbackDir || "";
}

// 扩展名归一：小写 + 补前导点（"PNG" → ".png"）
function _normExt(e) {
  const s = String(e == null ? "" : e).trim().toLowerCase();
  if (!s) return "";
  return s.startsWith(".") ? s : "." + s;
}

function _extOf(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(i).toLowerCase() : "";
}

// 起跳目录链：current 的父目录 → fallbackDir → 起跳偏好（若设·批Gb T7 R-11）→ 上次浏览 → 引擎 input 目录
//   （失败/空 → 盘符列表）。偏好未设/空串 = 现链完全不变（lastDir 保留不死）。
// 起跳偏好 = settings 聚合子键 picker_start_dir（settings.js 同键写入·两侧契约不互引键面量；
//   server 缓存 boot 拉全量·设置页写入即更缓存）
function _pickerStartPref() {
  const v = readAgg(SETTINGS_JSON, "picker_start_dir");
  return typeof v === "string" ? v.trim() : "";
}
async function _resolveStart(opts) {
  const explicit = startDirOf(opts.current, opts.fallbackDir);
  if (explicit) return explicit;
  const pref = _pickerStartPref();
  if (pref) return pref;
  if (lastDir) return lastDir;
  const r = await request("/h3_batch/input_dir", { cache: "no-store" });
  const d = r.ok && r.data && typeof r.data.dir === "string" ? r.data.dir : "";
  return d || "";
}

// 缩略图 URL（引擎 #30 · 与 assets/submit 同款通道；批 B #13：收敛 mediaUrl 单源·基址自持）
function _thumbUrl(p, size) {
  return mediaUrl("thumb", p, { maxSize: size });
}

// ============================================================================
// 2. DOM 装配（不导出 · 交互单测走 openPicker 全链）
// ============================================================================

function _el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function _clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function _btn(text, cls) {
  const b = _el("button", cls, text);
  b.type = "button";
  return b;
}

// 选中登记：st.selEl 记录当前选中元素，_mark 由元素自带的标记函数负责视觉
function _select(el, value) {
  if (!cur) return;
  const st = cur.st;
  if (st.selEl && st.selEl !== el && st.selEl._mark) st.selEl._mark(false);
  st.selEl = el;
  if (el._mark) el._mark(true);
  st.selected = value;
  if (cur.els.selBtn.focus) cur.els.selBtn.focus();
}

function _pick(p) {
  const cb = cur && cur.st.onPick;
  closePicker();
  if (cb) cb(p);
}

function _rowBase(icon) {
  const r = _el("div");
  r.style.cssText = "display:flex;align-items:center;gap:8px;min-height:34px;padding:2px 8px;border-radius:8px;white-space:nowrap;overflow:hidden";
  r.appendChild(_el("span", null, icon)).style.cssText = "flex:none;width:22px;text-align:center";
  r.onmouseenter = () => { if (!cur || cur.st.selEl !== r) r.style.background = "#22262e"; };
  r.onmouseleave = () => { if (!cur || cur.st.selEl !== r) r.style.background = ""; };
  return r;
}

// 文件行（浏览模式 value=文件名；扫描模式 value=绝对路径 + 所在目录标注）
function _fileRow(name, opts = {}) {
  const r = _rowBase(opts.icon || "📄");
  r.dataset.name = name;
  r.style.cursor = "pointer";
  r.appendChild(_el("span", null, name)).style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
  if (opts.sub) r.appendChild(_el("span", null, opts.sub)).style.cssText = "flex:none;color:var(--txt3);font-size:11px";
  r._mark = (on) => { r.style.background = on ? "#10333a" : ""; };
  r.onclick = () => _select(r, opts.value != null ? opts.value : name);
  if (opts.onOpen) r.ondblclick = opts.onOpen;
  return r;
}

// 目录行（双击进入 = legacy 口径；盘符行的标签含尾分隔符，如 "N:\"）
function _dirRow(label, onOpen, icon) {
  const r = _rowBase(icon || "📁");
  r.dataset.name = label;
  r.style.cursor = "pointer";
  r.appendChild(_el("span", null, label)).style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
  r.ondblclick = onOpen;
  return r;
}

// 缩略图格（图片文件 · 直连引擎 #30 thumb；失败显示「图缺失」占位）
function _thumbCell(name, full) {
  const c = _el("div");
  c.dataset.name = name;
  c.title = name;
  c.style.cssText = "aspect-ratio:1/1;border-radius:8px;overflow:hidden;cursor:pointer;background:#1a1a1e;display:flex;align-items:center;justify-content:center";
  const im = _el("img");
  im.loading = "lazy";
  im.alt = name;
  im.src = _thumbUrl(full, 256);
  im.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
  im.onerror = () => {
    im.style.display = "none";
    const ph = _el("div", null, t("ui.path.thumbMissing"));
    ph.dataset.thumbState = "error";
    ph.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--txt3);font-size:11px";
    c.appendChild(ph);
  };
  c.appendChild(im);
  c._mark = (on) => {
    c.style.outline = on ? "2px solid var(--accent-bright)" : "";
    c.style.outlineOffset = on ? "-2px" : "";
  };
  c.onclick = () => _select(c, name);
  c.ondblclick = () => { _select(c, name); _pick(full); };
  return c;
}

function _renderList() {
  const { els, st } = cur;
  st.selected = null;
  st.selEl = null;
  _clear(els.listEl);
  const q = els.searchEl.value.trim().toLowerCase();

  // 扫描结果（两层）渲染分支
  if (st.scanRes) {
    els.pathEl.textContent = (st.scanRes.rootDir || t("ui.path.thisPC")) + t("ui.path.scanSuffix");
    const files = st.scanRes.files.filter((f) => !q || f.name.toLowerCase().includes(q));
    for (const f of files) {
      const rel = f.dir && f.dir !== st.scanRes.rootDir
        ? "[" + (f.dir.split(/[\\/]/).pop() || f.dir) + "]" : "";
      els.listEl.appendChild(_fileRow(f.name, { sub: rel, value: f.absPath }));
    }
    if (!files.length) els.statusEl.textContent = t("ui.path.noMatch");
    return;
  }

  const dirs = q ? st.dirs.filter((d) => d.toLowerCase().includes(q)) : st.dirs;
  const files = q ? st.files.filter((f) => f.toLowerCase().includes(q)) : st.files;
  if (st.drives) {
    for (const d of dirs) {
      const label = d + "\\";
      els.listEl.appendChild(_dirRow(label, () => load(label), "🖴"));
    }
    return;
  }
  for (const d of dirs) {
    const full = joinPath(st.path, d);
    els.listEl.appendChild(_dirRow(d, () => load(full)));
  }
  const imgs = files.filter((f) => THUMB_EXTS.has(_extOf(f)));
  const others = files.filter((f) => !THUMB_EXTS.has(_extOf(f)));
  if (imgs.length) {
    const grid = _el("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;margin-bottom:6px";
    for (const f of imgs) grid.appendChild(_thumbCell(f, joinPath(st.path, f)));
    els.listEl.appendChild(grid);
  }
  for (const f of others) els.listEl.appendChild(_fileRow(f));
  if (q && !dirs.length && !files.length) els.statusEl.textContent = t("ui.path.noMatch");
}

// load(dir) — 列目录并渲染（dir 空 = 盘符列表）
async function load(dir) {
  if (!cur) return;
  const { els, st } = cur;
  st.path = dir || "";
  st.selected = null;
  st.selEl = null;
  st.scanRes = null;
  st.parent = "";
  st.dirs = [];
  st.files = [];
  st.drives = false;
  els.pathEl.textContent = st.path || t("ui.path.thisPC");
  els.statusEl.textContent = "";
  _clear(els.listEl);
  const filtered = !!(st.exts && !els.allChk.checked);
  const r = await listDirectory(st.path, filtered ? st.exts : []);
  if (!cur || cur.els !== els) return; // 期间已关闭/重开 → 丢弃本次结果
  if (!r.ok) {
    els.statusEl.textContent = r.error || t("ui.path.readFail");
    return;
  }
  st.parent = r.parent;
  st.drives = r.drives;
  st.dirs = r.dirs;
  st.files = r.files;
  lastDir = st.path;
  _renderList();
}

// 手输路径：带扩展名的末段 → 按文件定位并选中；否则当目录列
async function submitManual(raw) {
  if (!cur) return;
  const { els, st } = cur;
  const v = String(raw).replace(/^["'](.*)["']$/, "$1").trim().replace(/\//g, "\\");
  if (!v) return;
  if (/[.][^\\/.]+$/.test(v)) {
    if (!st.exts) { els.statusEl.textContent = t("ui.path.needFolder"); return; }
    const i = v.lastIndexOf("\\");
    const dir = i >= 2 ? v.slice(0, i) : v.slice(0, 3);
    const name = v.slice(i + 1);
    const r = await listDirectory(dir, []);
    if (!cur) return;
    if (r.ok && (r.files.includes(name) || r.dirs.includes(name))) {
      const ext = _extOf(name);
      if (!st.exts.includes(ext)) {
        els.statusEl.textContent = t("ui.path.extMismatch", { list: st.exts.join(",") });
        return;
      }
      await load(dir);
      if (!cur) return;
      for (const child of _iterSelectable(cur.els.listEl)) {
        if (child.dataset && child.dataset.name === name) { child.onclick(); break; }
      }
      els.statusEl.textContent = t("ui.path.located", { name });
      return;
    }
  }
  await load(v);
}

// 递归遍历可选行（缩略图格在 grid 容器内·深度 ≤2）
function _iterSelectable(root) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.dataset && c.dataset.name) out.push(c);
      if (c.children && c.children.length) walk(c);
    }
  };
  walk(root);
  return out;
}

// 两层扫描（仅 file 模式 + exts + opts.scan 时按钮可见）
async function runScan() {
  if (!cur) return;
  const { els, st } = cur;
  if (!st.exts || !st.path) { els.statusEl.textContent = t("ui.path.scanNoArgs"); return; }
  els.statusEl.textContent = t("ui.path.scanning");
  if (els.scanBtn.disabled !== undefined) els.scanBtn.disabled = true;
  const res = await scanTwoLevels(st.path, st.exts);
  if (!cur || cur.els !== els) return;
  if (els.scanBtn.disabled !== undefined) els.scanBtn.disabled = false;
  if (!res.files.length) {
    els.statusEl.textContent = t("ui.path.scanNone", { list: st.exts.join(",") });
    return;
  }
  st.scanRes = res;
  st.selected = null;
  st.selEl = null;
  _renderList();
  els.statusEl.textContent = t("ui.path.scanDone", { n: res.files.length });
}

// ============================================================================
// 3. 弹窗入口 / 出口
// ============================================================================

// openPicker(opts) — opts: {title, mode:'dir'|'file'|'image', kind（legacy 兼容）, exts, current,
//   fallbackDir, onPick, scan}
export function openPicker(opts = {}) {
  if (typeof document === "undefined") return;
  closePicker();

  const isImage = opts.mode === "image";
  const mode = (opts.mode || opts.kind) === "dir" ? "dir" : "file";
  const given = (Array.isArray(opts.exts) ? opts.exts : (opts.exts ? [opts.exts] : [])).map(_normExt).filter(Boolean);
  const exts = given.length ? given : (isImage ? [...IMAGE_EXTS] : null);

  // --- 构件 ---
  const bar = _el("div");
  bar.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px";
  const pathEl = _el("div");
  pathEl.dataset.h3Role = "path-picker-path";
  pathEl.style.cssText = "flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 10px;color:var(--txt2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const upBtn = _btn(t("ui.path.up"), "ghostbtn");
  bar.appendChild(pathEl);
  bar.appendChild(upBtn);

  const searchEl = _el("input");
  searchEl.type = "text";
  searchEl.value = "";
  searchEl.placeholder = t("ui.path.searchPh");
  searchEl.dataset.h3Role = "path-picker-search";
  searchEl.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:6px";

  const listEl = _el("div");
  listEl.dataset.h3Role = "path-picker-list";
  // 高度随风箱弹性收缩（flex + min-height）——短视口下不让 mbox 出滚动条压住「⬆ 上级」
  listEl.style.cssText = "border:1px solid var(--line);border-radius:8px;background:var(--panel2);flex:1 1 auto;min-height:140px;overflow:auto;padding:6px";

  const allChk = _el("input");
  allChk.type = "checkbox";
  allChk.dataset.h3Role = "path-picker-allchk";
  const allChkLabel = _el("label");
  allChkLabel.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
  allChkLabel.appendChild(document.createTextNode(t("ui.path.allFiles")));
  allChkLabel.appendChild(allChk);
  const optRow = _el("div");
  optRow.style.cssText = "display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12px;color:var(--txt2)";
  optRow.appendChild(allChkLabel);

  const statusEl = _el("div");
  statusEl.dataset.h3Role = "path-picker-status";
  statusEl.style.cssText = "min-height:18px;color:#ff9a62;font-size:12px;margin-bottom:6px";

  const content = _el("div");
  content.style.cssText = "display:flex;flex-direction:column;flex:1 1 auto;min-height:0";
  content.appendChild(bar);
  content.appendChild(searchEl);
  content.appendChild(listEl);
  content.appendChild(optRow);
  content.appendChild(statusEl);

  const manualEl = _el("input");
  manualEl.type = "text";
  manualEl.placeholder = t("ui.path.manualPh");
  manualEl.dataset.h3Role = "path-picker-manual";
  manualEl.style.cssText = "flex:1;min-width:120px";
  const scanBtn = _btn(t("ui.path.scanBtn"), "ghostbtn");
  scanBtn.dataset.h3Role = "path-picker-scan";
  scanBtn.style.display = "none";
  const selBtn = _btn(mode === "dir" ? t("ui.path.selDirBtn") : t("ui.path.selBtn"), "prim");
  selBtn.dataset.h3Role = "path-picker-select";
  const cancelBtn = _btn(t("ui.path.cancelBtn"), "ghostbtn");
  cancelBtn.dataset.h3Role = "path-picker-cancel";

  let inst = null;
  inst = openModal({
    title: opts.title || (mode === "dir" ? t("ui.path.dirTitle") : t("ui.path.fileTitle")),
    contentNode: content,
    footerButtons: [manualEl, scanBtn, selBtn, cancelBtn],
    onClose: () => { if (cur && cur.inst === inst) cur = null; },
  });
  inst.box.style.width = "min(920px,94vw)";
  inst.box.style.maxHeight = "88vh";
  inst.box.style.display = "flex";
  inst.box.style.flexDirection = "column";

  const els = { inst, pathEl, upBtn, searchEl, listEl, allChk, allChkLabel, statusEl, manualEl, scanBtn, selBtn, cancelBtn };
  const st = {
    mode,
    exts,
    onPick: typeof opts.onPick === "function" ? opts.onPick : null,
    path: "", parent: "", dirs: [], files: [], drives: false,
    selected: null, selEl: null, scanRes: null,
  };
  cur = { inst, els, st };

  // --- 接线 ---
  upBtn.addEventListener("click", () => { void load(st.parent); });
  searchEl.addEventListener("input", () => { if (cur) _renderList(); });
  allChk.addEventListener("change", () => { void load(st.path); });
  manualEl.addEventListener("keydown", (e) => {
    if (e && e.key === "Enter" && manualEl.value.trim()) void submitManual(manualEl.value.trim());
  });
  cancelBtn.addEventListener("click", () => closePicker());
  scanBtn.addEventListener("click", () => { void runScan(); });
  selBtn.addEventListener("click", () => {
    if (st.mode === "dir") { if (st.path) _pick(st.path); return; }
    if (!st.selected) return;
    _pick(st.scanRes ? st.selected : joinPath(st.path, st.selected));
  });

  allChkLabel.style.display = exts ? "flex" : "none";
  allChk.checked = false;
  scanBtn.style.display = (opts.scan && mode === "file" && exts) ? "" : "none";
  manualEl.value = String(opts.current || "");

  void _resolveStart(opts).then((d) => load(d));
}

// closePicker — 关闭当前弹窗（无弹窗时 no-op）
export function closePicker() {
  const inst = cur && cur.inst;
  cur = null;
  if (inst && typeof inst.close === "function") inst.close();
}

// __test_reset — 单测钩子：关弹窗 + 清「上次浏览位置」（模块级状态跨用例隔离）
export function __test_reset() {
  closePicker();
  lastDir = "";
}
