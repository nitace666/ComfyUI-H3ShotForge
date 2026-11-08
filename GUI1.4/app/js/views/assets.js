// views/assets.js — 资产库视图 (S1-4 T1 · 基线 E001-E007).
//
// === 出处注记 (v43 原型 md5=43c85f743cfb8445f63fb8292c3355aa · 只读参照, 本体永不修改) ===
//   - 页面结构 :1668-1691 (#view-assets: proj-top + fillpanel + agrid + empty-hint)
//   - 顶栏按钮 :1672-1677 (生成三视图 / 多角度 → 本仓三视图弹窗 / 新建资产 / 搜索框·导出资产库 2026-10-25 真接) + :1674「批量导入」位 → 本仓「导入资产库」
//   - 卡面渲染 :4301-4316 (agrid innerHTML + ac-ops + ph + no)
//   - 搜索过滤 :2975-2991 (assetSearchFilter v26 W8/W11 + v27 P4 空态)
//   - 编辑弹窗 :1885-1920 (#amodal 结构) + :2880-2899 (assetEdit/assetNew)
//   - 用途复选 :2790-2802 (USE_LIST 10 项) + :2804-2857 (buildUsechks/onUsechkChange/
//     refreshKindLock/addDynDesc · v29 勾选出框 + v30 忽略词随行) + :2863-2871 (dd-row 行组)
//   - 删除确认 :3045-3057 (assetDel 双击确认 3 秒窗)
//   - 导出弹窗 :2363-2379 (#xmodal) + :2965-2973 (assetExportOpen · 本仓不恢复占位弹窗；导出改为顶栏单钮真接服务端 zip)
// 纯逻辑 (名称校验/用途目录/槽号展开/kind 锁定/搜索/回收站/导入解析) 下沉 core/assets_api.js — 本文件只做 DOM 编排.
//
// === 行为基线 ===
//   E001 卡面 4:3 缩略图 (176×132 基准) + hover .ac-ops (删除 · F64 精简后 G 块再摘导出 op, 编辑=点卡面/三视图=顶栏/裁剪=编辑弹窗)
//   E002 搜索空态 .empty-hint (v27 P4 文案)
//   E003 导出资产库（2026-10-25 老板裁决真接）: 顶栏单钮 → POST /gui13-fs/assets_export →
//        服务端读 data/asset-cards-cache.json 卡 + 卡内 media 图片打 zip（cards.json + images/）
//        → 浏览器下载；成功 toast 含卡数/图片数，空库/失败人话提示。原占位弹窗与
//        markCurrent/S.current「当前卡」基础设施仍退役（不做导出当前卡·避免第二套数据源）
//   A2 导入资产库 (快批⑥): 顶栏入口 → input[type=file].accept=".zip,.json" → File.text →
//        parseAssetImport（core · 导出格式容器 {assets:{name:card}} 与引擎 #34 响应同构 + 单条/数组容错）
//        → 逐卡 saveCard + @N 注册 + 刷新；zip（PK 头）= 登记提示（引擎侧无资产库解包通道）
//   A3 媒体行「选择文件」(快批⑥): 本机图片 → /upload/image（裁剪弹窗同通道 · UPLOAD_MEDIA_ROOT）
//        → 路径回填 + 预览即时刷新；视频/音频路径保持手输（引擎侧文件）
//   A4 用途区序 (快批⑥): 复选 DOM 序 = USAGE_CATALOG 原序；描述行按目录下标插到位（不随勾选先后排）
//   A5/A6 用途区布局 (快批⑥): usechks = 等宽网格（auto-fill 列数随弹窗宽自适应）；
//        描述行组 = 定宽标签列 .lbl + .dd-body（描述框 → 忽略词子行 .dd-ig 缩进从属 · 输入框 flex:1 到行尾）
//   E004 点卡 → media modal (名称/类型/标签/备注/图片路径行)
//   E005 用途复选 10 项 + 勾选联动描述框 (勾几出几 · 取消即删 · v29)
//   E006 用途 kind 锁定 (图片类互不锁定 · 跨类置灰 title「已选其他 kind，不可再勾」)
//   E007 回收站: 删除前缓存卡副本到 localStorage (引擎 #35 删卡为物理删除, 无软删端点 —
//        任务单钦点 GUI 侧软删缓存限实) + 回收站列表 + 恢复 (saveCard 写回)
//   F5 归档清理链 (批 3-T1): 回收站条目「彻底删除」/ 标题行「清空回收站」→ 双确认披露
//        archive_images/<名>/ 物理删除 → 引擎 #39 archive_purge → 成功才移条目 (失败保留可重试)
//   D1 入口归属 (老板走查批D): 顶栏 = 「生成三视图 / 多角度…」(v43 :1672 原型序第一位;
//        无目标卡直开 → 表单首行「目标资产」下拉) ；「一句话成片」入口移出资产页 → 门户 hero-sub
//        （本件导出 openConceptModal 供 portal 直弹, 概念环链语义不变）
//   F1 损坏库一键恢复 (批 1): 损坏提示区「备份资产库 / 重置资产库」两钮 → 引擎 #36 (reset 走二次确认)
//   F4 编辑卡双 round-trip (批 1): 卡级 + 行级未知键保存不丢 (必收键 usage/slot/media/desc 恒为表单真值)
//   T1 媒体行行号/槽号手编 (批 1): 手编 idx/slot 落 rows + 槽号脏值守卫与值域校验 (Picture 1-9 / Video·Audio 1-3)
//   T2 用途推断 kind (批 1): 勾选联动 kind 下拉 (character|scene·用户手改后不覆盖)
//   F2 标签筛选条 + 卡面 tags (批 1): 卡墙上方 tag chip 快捷交集筛选（与搜索框模糊匹配并存）
//        + 卡面 tags 只读 chips（1.0 assets.js:199/:217/:538 口径）
//   F6 灯箱视频友好态 (批 1): 视频媒体优先 #30 thumb 首帧 PNG；404 → 友好占位（真播待引擎线扩 #44 白名单）
//   T3 三视图阶段文案 (批 1): 卡面显引擎 #46 五态中文 + 已等待 X 分（前端本地提交时刻起算）

import { readAgg, writeAgg, ASSETS_META } from "../core/server_storage.js";  // 批 10-M M-T4：order / povPending 迁聚合文件
import { resolveTemplate, buildPromptText } from "../core/prompt_templates.js";   // T5 #1：模板读链 + 文本组装（core 单源）
import {
  listAssets, saveCard, deleteCard, validateAssetName, normalizeTags,
  USAGE_CATALOG, SLOT_RANGES, expandUsageRows, nextKindLock, isKindLockedOut,
  filterAssets, readTrash, trashAdd, trashRemove, submitThreepov, threepovStatus,
  submitItemCanvas, itemCanvasStatus, submitSceneCanvas, sceneCanvasStatus,
  assignRegistryN, rebindRegistryName, scanAssignRegistry, applyRowMutex, POSE_STYLE_IDS,
  buildConceptCard, CONCEPT_MEDIA_ROOT, CONCEPT_SUBFOLDER, extractFrame,
  assetThumbPath, initialCropFrame, moveCropFrame, resizeCropFrame,
  cropParamsFromFrame, cropImageToBlob, cropStamp, cropStageSize, readDormant, dormantAdd,
  dormantRemove, dormantClear,
  CROP_MEDIA_ROOT, UPLOAD_MEDIA_ROOT, parseAssetImport, readRegistry,
  recoveryAssets, normalizeSlot, inferKindFromUsage, displayKindOf, archivePurge,
} from "../core/assets_api.js";
import { mediaUrl, wireBgMediaFallback, uploadImage, request, fetchApi } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源
import { invalidateAssetsCache } from "./prompt.js";   // 任务C #55：保存链成功后失效 prompt 资产缓存（重拉→广播→画布/联想同步新图）
import { engineInputDir } from "../core/audio_upload.js"; // F33: ref2v 相对路径→引擎 input 绝对路径
import {
  generateOnly, runOnly, pollStatus, buildFormDataFromProject,
} from "../core/submit.js";
import { loadDetail } from "../core/history_ops.js";
import { createProject, getThreepovParams, setThreepovParams, latestProjectId } from "../store/store.js";
import { open as openModal, openConfirm } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import { toggleVocabPanel, appendVocabWord } from "../ui/vocab.js"; // B3-T3 F8：词库面板（F49 点钮 toggle 化）
import { openPicker } from "../ui/path_picker.js"; // 批 2-T3 F3：引擎库选图
import { buildCanvasParamsSection, collectCanvasParams } from "../ui/canvas_params.js"; // B3-T2 F7：三视图高级参数
import { GOTO_ASSET_KEY } from "../ui/guide.js"; // 批 5-T3：搜索跳转锚 gui13.gotoAsset（写点在 guide）
// S3-4 B5：首帧挂用拼装（段 prompt 末尾 " @N"·幂等）——段卡下拉同款纯函数，避免第二套拼装口径
import { appendFirstFrameRefToPrompt } from "./segcards.js";
import { t, pickDisplay } from "../core/i18n.js";   // #92 B3a：页面主体显示面取词（zh 直通·en 查典/MAPS）

// ===== DOM 构造辅助 (repo 同款) =====
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
function clearChildren(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

// ===== 批 3-T3 F8：词库插入目标解析 =====
//   聚焦的提示词框（.dyn-desc 内 textarea）优先；无聚焦 → 兜底首条提示词框；
//   聚焦忽略词框语义不匹配 → null（有意不挂·不开面板）。
//   F50: 忽略词框由 input 改 textarea（自动换行）——守卫改按 .dd-ig 行识别，语义不变。
export function resolveVocabTarget(descContainer, activeEl) {
  if (!descContainer) return null;
  const tagOf = (n) => (n && n.tagName ? String(n.tagName).toUpperCase() : "");
  const inDesc = (n) => {
    for (let cur = n; cur; cur = cur.parentNode || null) if (cur === descContainer) return true;
    return false;
  };
  const inIgnoreRow = (n) => {
    for (let cur = n; cur; cur = cur.parentNode || null) {
      if (cur === descContainer) return false;
      if (String(cur.className || "").split(/\s+/).includes("dd-ig")) return true;
    }
    return false;
  };
  const active = activeEl || null;
  if (active && inDesc(active)) {
    if (tagOf(active) === "TEXTAREA") return inIgnoreRow(active) ? null : active;
    if (tagOf(active) === "INPUT") return null;
  }
  return descContainer.querySelector("textarea");
}

// ===== 会话态 (模块级单例 · 无订阅无定时器 · unmount 置空即卸载) =====
let S = null;
// 删除二次确认臂 (v43 :3045 delAssetArm 同款: 3 秒内再点同一卡名才真删)
let _delArm = { name: null, at: 0 };
const DEL_ARM_MS = 3000;
// 批 1-F1: 损坏库恢复请求在途标志（两钮共用·防连点重发）
let _recoveryBusy = false;

// 批 R4.6 · D04/D05/D15（J14 裁决）: 类型过滤栏收窄为 全部/人物/场景 三项 —
//   引擎 kind 白名单仅 character|scene (api.md #35 · prop 已下线)；count 键与 kind 同名。
//   #39 T3（方案 D3+S2）: 补「道具」chip = 展示层第四值（displayKindOf 衍生·引擎真值不改）
const FILTER_KINDS = [["all", "assets.filter.all"], ["character", "assets.filter.character"], ["scene", "assets.filter.scene"], ["item", "assets.filter.item"]];
// 批 R4.6 · D06: 页顶常驻 inh (v43 :1687 原文) — 损坏态复用同一常量, 防两处文案漂移（值=i18n 键·渲染期取词）
const PAGE_HINT = "assets.pageHint";
// 批 R4.6 · D05 (v43 :1685 原文): 过滤栏右侧 hint（值=i18n 键·渲染期取词）
const FCHIPS_HINT = "assets.fchipsHint";
function kindLabel(kind) {
  const hit = FILTER_KINDS.find(([k]) => k === kind);
  return hit ? t(hit[1]) : t("assets.filter.all");
}

function safeStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

// ============================================================================
// 批 10-L L1-5（F78 · 方案审 P2-7）：资产列表排序稳定 · GUI 本地序表
//   真机取证（2026-10-03 · 引擎探针 · 临时卡收尾已删·快照逐字还原）：
//     改卡（同名重存）→ 该卡键跳到尾部；新建卡 → 既有卡后移。引擎 listAssets 键序不稳定，
//     renderGrid 直遍历该键序 → 老板「改档案卡保存后列表排序变化」。
//   修法：渲染序改由本地序表决定（localStorage 分离键·同 dormant 分离键实现模式）——
//     首见入序（引擎键序只作存量卡首见种子）·新卡追加尾·删卡剔除（旧名不留残项）·
//     改名 = 旧名位换新名位（位置不变·不触发重排）。读写失败静默降级为引擎首见序。
// ============================================================================
const ORDER_KEY = "gui13.assets.order";   // 仅留键名常量（迁移前 localStorage 键·M-T4 后走聚合文件）

// 批 10-M M-T4：序表读改走 server 聚合文件（server 优先 → 本地回退）
function readOrder(storage) {
  const v = readAgg(ASSETS_META, "order", storage);
  if (v == null && (!storage || typeof storage.getItem !== "function")) return [];
  try {
    const parsed = v != null ? v : JSON.parse(storage.getItem(ORDER_KEY) || "null");
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string" && n) : [];
  } catch (_e) { return []; }
}

// 写：内存 + 异步 PUT 整文件（localStorage 停写）
function writeOrder(list, storage) {
  writeAgg(ASSETS_META, "order", list);
}

// 全库卡名 → 按序表排序的结果（并把序表对齐到当前库：陌生名追加尾·已删名剔除）
export function orderNames(names, storage) {
  const all = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n) : [];
  const st = storage || safeStorage();
  const cur = readOrder(st);
  const alive = new Set(all);
  const kept = cur.filter((n) => alive.has(n));
  const added = all.filter((n) => !cur.includes(n));
  const order = kept.concat(added);
  if (kept.length !== cur.length || added.length) writeOrder(order, st);
  const pos = new Map(order.map((n, i) => [n, i]));
  return all.slice().sort((a, b) => pos.get(a) - pos.get(b));
}

// 改名：序表原位替换（位置不变）·旧名不在序表 → false（下次渲染按首见追加）
export function renameInOrder(oldName, newName, storage) {
  const st = storage || safeStorage();
  const cur = readOrder(st);
  const i = cur.indexOf(oldName);
  if (i < 0) return false;
  const next = cur.slice();
  next[i] = newName;
  writeOrder(next, st);
  return true;
}

// ===== 资产库导出（2026-10-25 老板裁决真接·顶栏单钮 → 服务端 zip）=====
const EXPORT_ENDPOINT = "/gui13-fs/assets_export";
const EXPORT_TIMEOUT_MS = 120000;   // 大库打包可能超过默认 30s
const EXPORT_TITLE_KEY = "assets.export.title";   // 值=i18n 键·渲染期取词（§4.9）
let _exportBusy = false;

function _exportStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function _exportFileName(resp) {
  const cd = (resp.headers && typeof resp.headers.get === "function") ? resp.headers.get("Content-Disposition") : "";
  const m = /filename="?([^";]+)"?/i.exec(String(cd || ""));
  return m ? m[1] : `assets-export-${_exportStamp()}.zip`;
}

function _exportCount(resp, header) {
  const v = (resp.headers && typeof resp.headers.get === "function") ? resp.headers.get(header) : null;
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
}

function _downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // 延迟移除/回收：立刻 remove/revoke 会让浏览器尚未消费完的 blob 下载被取消（真机+无头浏览器实测）；
  // Node 测试环境 unref 掉计时器，避免 60s 计时拖住测试进程退出
  const timer = setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

function _setExportBusy(btn, busy) {
  if (!btn) return;
  btn.style.opacity = busy ? "0.5" : "";
  btn.style.pointerEvents = busy ? "none" : "";
  btn.setAttribute("title", busy ? t("assets.export.busy") : t(EXPORT_TITLE_KEY));
}

async function exportLibrary(btn) {
  if (_exportBusy) return;
  _exportBusy = true;
  _setExportBusy(btn, true);
  try {
    const resp = await fetchApi(EXPORT_ENDPOINT, { self: true, method: "POST", body: {}, timeoutMs: EXPORT_TIMEOUT_MS });
    if (!resp.ok) {
      let err = "";
      try { const j = await resp.json(); err = (j && typeof j.error === "string") ? j.error : ""; } catch (_e) { /* 非 JSON 错误体 */ }
      if (resp.status === 404 && err === "empty_library") {
        showToast("info", t("assets.export.empty"));
      } else {
        showToast("error", t("assets.export.failHttp", { code: resp.status, err: err ? " · " + err : "" }));
      }
      return;
    }
    const blob = await resp.blob();
    const cards = _exportCount(resp, "X-Export-Cards");
    const images = _exportCount(resp, "X-Export-Images");
    const missing = _exportCount(resp, "X-Export-Missing") || 0;
    _downloadBlob(blob, _exportFileName(resp));
    let msg = t("assets.export.done");
    if (cards != null && images != null) {
      msg += t("assets.export.doneDetail", { cards, images, missing: missing ? t("assets.export.missingN", { n: missing }) : "" });
    }
    showToast("success", msg);
  } catch (e) {
    showToast("error", e && e.code === "timeout"
      ? t("assets.export.timeout")
      : t("assets.export.fail"));
  } finally {
    _exportBusy = false;
    _setExportBusy(btn, false);
  }
}

// ===== 挂载 =====
export function mount(container) {
  if (!container || typeof document === "undefined") return null;

  const sec = el("section", { id: "view-assets", class: "shell-view" });

  // 顶栏（F58 老板裁目标序 2026-10-02 · 导出资产库 2026-10-25 真接回归：新建资产 → 导入资产库 → 导出资产库 → 生成三视图/多角度 → 搜索）
  const top = el("div", { class: "proj-top" });
  top.appendChild(el("h2", { text: t("shell.nav.assets") }));
  // 老板走查批D：「生成三视图 / 多角度…」（v43 :1672 钦点形态：ghostbtn + data-ic image 13）·
  //   F58：挂载序移至导入资产库之后（挂载处见下）——原型语义 = 无目标卡直接开生成弹窗 →
  //   对齐现架构：直开三视图弹窗, 表单首行给「目标资产」下拉选卡。
  const btnGen = el("span", {
    class: "ghostbtn",
    title: t("assets.top.genT"),
  });
  btnGen.appendChild(el("span", { "data-ic": "image", "data-sz": "13" }));
  btnGen.appendChild(document.createTextNode(t("assets.top.gen")));
  btnGen.addEventListener("click", () => openThreepovModal(""));
  // 批 R4.6 · D17/D18: 两钮图标统一 data-ic（v43 :1673 plus / :1675 download · R0 hydrateIcons 接入）
  const btnNew = el("span", { class: "ghostbtn", title: t("assets.top.newT") });
  btnNew.appendChild(el("span", { "data-ic": "plus", "data-sz": "13" }));
  btnNew.appendChild(document.createTextNode(t("assets.top.new")));
  btnNew.addEventListener("click", () => {
    // 批A #13：离线只读——新建/编辑需引擎写卡，离线置灰禁入（refresh 按态刷 title/透明度）
    if (S && S.offline) { showToast("info", t("assets.offlineReadonly")); return; }
    openAssetModal(null);
  });
  top.appendChild(btnNew);
  // A2 快批⑥: 「导入资产库」——.json（导出格式容器）逐卡建卡；.zip 走登记提示（引擎无解包通道）
  const btnImport = el("span", {
    class: "ghostbtn",
    id: "assetImportEntry",
    title: t("assets.top.importT"),
  });
  btnImport.appendChild(el("span", { "data-ic": "folderplus", "data-sz": "13" }));
  btnImport.appendChild(document.createTextNode(t("assets.top.import")));
  const importFile = el("input", { type: "file", accept: ".zip,.json", id: "assetImportFile", style: "display:none" });
  btnImport.addEventListener("click", () => { if (importFile.click) importFile.click(); });
  importFile.addEventListener("change", () => {
    const f = importFile.files && importFile.files[0];
    importFile.value = ""; // 复位：同一文件重选也触发 change
    if (f) importLibraryFile(f);
  });
  top.appendChild(btnImport);
  top.appendChild(importFile);

  // 导出资产库（2026-10-25 老板裁决真接）：单钮全部导出 → 服务端 zip；与导入相邻成对
  const btnExport = el("span", { class: "ghostbtn", id: "assetExportEntry", title: t(EXPORT_TITLE_KEY) });
  btnExport.appendChild(el("span", { "data-ic": "download", "data-sz": "13" }));
  btnExport.appendChild(document.createTextNode(t("assets.top.export")));
  btnExport.addEventListener("click", () => exportLibrary(btnExport));
  top.appendChild(btnExport);

  // F58：「生成三视图 / 多角度…」挂载于导出资产库之后、搜索框之前（创建处见顶栏首段）
  top.appendChild(btnGen);

  const search = el("input", {
    class: "search",
    id: "assetSearch",
    type: "text",
    placeholder: t("assets.search.ph"),
    title: t("assets.search.title"),
  });
  search.style.cssText = "font-family:inherit;color:var(--txt)"; // v43 :1677 同款覆写
  search.addEventListener("input", () => applyFilter(search.value));
  top.appendChild(search);
  sec.appendChild(top);

  const panel = el("div", { class: "fillpanel" });
  // 批 R4.6 · D04/D05: 类型过滤栏 (v43 :1680-1686 · J14 收窄三项) + 页顶常驻 inh (v43 :1687)
  const fchips = el("div", { class: "fchips", id: "achips" });
  const chipNodes = {};
  for (const [kind, label] of FILTER_KINDS) {
    const chip = el("span", {
      class: "fchip" + (kind === "all" ? " on" : ""),
      "data-kind": kind,
      text: `${t(label)} 0`,
    });
    chip.addEventListener("click", () => selectKind(kind));
    chipNodes[kind] = chip;
    fchips.appendChild(chip);
  }
  fchips.appendChild(el("span", { class: "inh", style: "margin-left:auto;align-self:center", text: t(FCHIPS_HINT) }));
  panel.appendChild(fchips);
  panel.appendChild(el("div", { class: "inh", style: "margin-bottom:12px", text: t(PAGE_HINT) }));

  const agrid = el("div", { class: "agrid", id: "agrid" });
  // 批 1-F2: 标签筛选条挂点（卡墙上方·内容随库刷新重建 — 见 renderTagBar）
  const tagBar = el("div", { id: "assetTags" });
  panel.appendChild(tagBar);
  panel.appendChild(agrid);
  // E002 空态 (v43 :1689 原文案)
  const emptyHint = el("div", { class: "empty-hint", id: "assetEmpty", style: "display:none" });
  emptyHint.appendChild(document.createTextNode(t("assets.empty.pre")));
  const emptyQ = el("span", { id: "assetEmptyQ" });
  emptyHint.appendChild(emptyQ);
  emptyHint.appendChild(document.createTextNode(t("assets.empty.post")));
  panel.appendChild(emptyHint);

  // E007 回收站区 (GUI 侧软删缓存 · 引擎删卡为物理删除)
  const trashWrap = el("div", { id: "assetTrash", style: "display:none;margin-top:18px" });
  panel.appendChild(trashWrap);
  sec.appendChild(panel);
  container.appendChild(sec);

  // purgingAll: 清空回收站循环互斥态（批 4-T1 ③）——unmount/mount 重建 S 即复位（自愈，无持久化）
  S = { sec, agrid, tagBar, emptyHint, emptyQ, search, trashWrap, chipNodes, btnNew, assets: {}, error: null, offline: false, cacheEmpty: false, savedAt: "", query: "", kind: "all", tag: "", purgingAll: false };

  hydrateIcons(sec); // 批 R4.6 · D17/D18: data-ic → svg（R0 范式 · 幂等）
  refresh();
  return sec;
}

// ===== 卸载 (幂等 — shell renderRoute 每次路由前调用, 参照 edit.unmount 模式) =====
export function unmount() {
  _recoveryBusy = false;
  S = null;
  _delArm = { name: null, at: 0 };
}

// ===== 批 5-T3（H5 搜索跳转落点）：消费 sessionStorage 锚 gui13.gotoAsset =====
//   搜索面板（ui/guide.js）点资产结果 → 写卡名锚 + 跳本页；本页 mount 即消费清锚 →
//   命中卡 scrollIntoView + goto-flash 高亮 2s（先例 gui13.gotoSeg → setup/segcards）。
export function consumeGotoAssetAnchor(root, opts = {}) {
  if (!root || typeof root.querySelectorAll !== "function") return false;
  let storage = opts.storage;
  if (storage === undefined) {
    try { storage = (typeof globalThis !== "undefined" && globalThis.sessionStorage) || null; } catch (_e) { storage = null; }
  }
  if (!storage || typeof storage.getItem !== "function") return false;
  let name = null;
  try { name = storage.getItem(GOTO_ASSET_KEY); } catch (_e) { return false; }
  if (!name) return false;
  try { storage.removeItem(GOTO_ASSET_KEY); } catch (_e) { /* 隐私模式忽略 */ }
  const card = [...root.querySelectorAll(".acard")].find(
    (c) => c && typeof c.getAttribute === "function" && c.getAttribute("data-name") === name,
  ) || null;
  if (!card) return true; // 卡已删/改名：锚已清，不炸
  if (typeof card.scrollIntoView === "function") card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("goto-flash");
  setTimeout(() => card.classList.remove("goto-flash"), opts.flashMs != null ? opts.flashMs : 2000);
  return true;
}

// ===== 数据流: GET /h3_batch/assets (真接引擎 8190 · 批A #13 离线读穿 data/asset-cards-cache.json) =====
async function refresh() {
  const r = await listAssets();
  if (!S) return; // 卸载后返回的迟到响应 — 丢弃
  // 批A #13: 离线只读态（offline=true = 引擎不可达·数据源为末次在线快照）
  S.offline = !!r.offline;
  S.savedAt = (r && r.savedAt) || "";
  // #13批A/B盲区: 离线空快照（缓存 miss）= 正常态非错误——空卡墙出指引文案，不误走恢复态
  S.cacheEmpty = !!(r && r.cacheEmpty);
  applyOfflineChrome();
  if (r.ok) {
    S.assets = r.assets;
    S.error = null;
    // S2-1 T2 注册表接线（详案任务 0）：资产页挂载刷新时为尚无 @N 的存量卡补分配
    //   scanAssignRegistry 内部去重保序；存量卡都覆盖一遍 → 全部获 @N（@ 联想 / 池装配可用）
    //   批A #13: 离线只读态跳过（写引擎注册表是在线操作，不因离线快照空转写）
    if (!S.offline) scanAssignRegistry(safeStorage(), Object.keys(S.assets));
  } else {
    S.assets = r.assets || {};
    S.error = r.error || null;
  }
  migrateLegacyPovPending(); // F68: 旧语义条目一次性迁移清扫——须在 renderGrid 之前，
  //   否则本次刷新仍会把旧条目渲染上卡面（老板复现的正是「刷新后仍见多条历史记录条」）
  renderGrid();
  renderTrash();
  // 批 5-T3：消费搜索跳转锚（命中卡滚动+2s 高亮；写点在 ui/guide.js）
  consumeGotoAssetAnchor(S.sec);
  resumePovPolling(); // F21: 刷新/重挂载恢复「生成中」轮询（提交后刷新页面不丢状态）
}

// 批A #13: 新建资产钮随离线态置灰（置灰 + title 提示；点击守卫见 mount 内监听）
function applyOfflineChrome() {
  if (!S || !S.btnNew) return;
  S.btnNew.style.opacity = S.offline ? "0.5" : "";
  S.btnNew.setAttribute("title", S.offline
    ? t("assets.offlineReadonly")
    : t("assets.top.newT"));
}

function applyFilter(q) {
  if (!S) return;
  S.query = typeof q === "string" ? q : "";
  renderGrid();
}

// 批 R4.6 · D04: 类型过滤切换（全部 = 不过滤 · 其余按 kind 白名单）
function selectKind(kind) {
  if (!S || !S.chipNodes[kind]) return;
  S.kind = kind;
  for (const [k, chip] of Object.entries(S.chipNodes)) chip.classList.toggle("on", k === kind);
  renderGrid();
}

// 批 R4.6 · D04: 过滤栏计数 = 实况张数按 displayKindOf 分桶（#39 T3: 道具卡=character 引擎
//   真值但按展示判别计入「道具」桶；非三值入参不存在——displayKindOf 恒返回白名单内 id）
function updateChipCounts() {
  if (!S || !S.chipNodes) return;
  const counts = { all: 0, character: 0, scene: 0, item: 0 };
  for (const card of Object.values(S.assets || {})) {
    counts.all += 1;
    counts[displayKindOf(card)] += 1;
  }
  for (const [kind, label] of FILTER_KINDS) {
    S.chipNodes[kind].textContent = `${t(label)} ${counts[kind]}`;
  }
}

// ===== E001 卡墙 + E002 空态 =====
// 批 1-F2: 卡标签取用（数组/字符串经 normalizeTags 规范化 — 1.0 extractTags 同口径）
function cardTags(card) { return normalizeTags(card && card.tags); }

// 批 1-F2: 全库标签聚合（去重保首现序 — 1.0 _aggregateTags :217 同口径）
function aggregateTags(assets) {
  const seen = new Set();
  const out = [];
  for (const name of Object.keys(assets || {})) {
    for (const tg of cardTags(assets[name])) {
      if (!seen.has(tg)) { seen.add(tg); out.push(tg); }
    }
  }
  return out;
}

// 批 1-F2: 标签筛选条（卡墙上方）— chip = 快捷交集筛选（精确命中 tags 项），与搜索框（模糊）并存。
//   聚合恒取全库（未过滤）：切走筛选后仍能选回（1.0 :538 口径）；空库/损坏态不出条。
function renderTagBar() {
  if (!S || !S.tagBar) return;
  clearChildren(S.tagBar);
  if (!Object.keys(S.assets || {}).length) return;
  const bar = el("div", { class: "fchips" });
  bar.appendChild(el("span", { class: "inh", style: "align-self:center", text: t("assets.tagBar.cap") }));
  const allTags = aggregateTags(S.assets);
  if (!allTags.length) {
    // 1.0 :217 空标签提示（库非空才有此条 — 卡编辑面板可加标签）
    bar.appendChild(el("span", { class: "inh", style: "color:var(--txt3);align-self:center", text: t("assets.tagBar.none") }));
  }
  for (const tg of allTags) {
    const on = tg === S.tag;
    const chip = el("span", {
      class: "fchip" + (on ? " on" : ""),
      "data-tag": tg,
      title: on ? t("assets.tagChip.off", { tag: tg }) : t("assets.tagChip.on", { tag: tg }),
      text: tg,
    });
    chip.addEventListener("click", () => { S.tag = on ? "" : tg; renderGrid(); });
    bar.appendChild(chip);
  }
  // 清筛选：当前标签可能已随卡片改名/删卡离库（聚合里没了）→ 只要有筛选态就给出路
  if (S.tag) {
    const clear = el("span", { class: "fchip", style: "border-style:dashed", title: t("assets.tagChip.clearT", { tag: S.tag }), text: t("assets.tagChip.clear") });
    clear.addEventListener("click", () => { S.tag = ""; renderGrid(); });
    bar.appendChild(clear);
  }
  S.tagBar.appendChild(bar);
}

function renderGrid() {
  if (!S) return;
  clearChildren(S.agrid);
  updateChipCounts();
  renderTagBar();

  // 批A #13: 离线只读横幅（引擎不可达·数据源=末次在线快照）——样式对齐 server_storage.showOfflineBanner
  //   先例，但渲染在卡墙内（资产页局部态）。**与损坏态严格区分**：真损坏（S.error）走下方恢复态；
  //   仅离线走只读横幅 + 只读卡墙继续渲染（图允许裂——媒体流离线依赖批 B 本地流端点）。
  if (S.offline) {
    S.agrid.appendChild(el("div", {
      style: "grid-column:1/-1;margin-bottom:10px;padding:8px 12px;background:#7a2f2f;color:#fff;"
        + "font-size:13px;text-align:center;box-shadow:0 2px 8px #0006;border-radius:6px",
      text: t("assets.offline.base") + (S.savedAt ? t("assets.offline.asOf", { ts: S.savedAt }) : "") + t("assets.offline.resume"),
    }));
  }

  // 损坏态 (api.md #34: 200 + error 仍返回 assets → 引导 recovery)
  if (S.error) {
    const hint = el("div", { class: "empty-hint", style: "grid-column:1/-1" });
    hint.appendChild(el("div", { text: t("assets.corrupt.readFail", { reason: (S.error.msg || S.error.code) || t("settings.err.unknown") }) }));
    // 批 1-F1: 引擎 #36 自助恢复两钮 (backup=字节级备份原文件; reset=备份+删损坏+写空库)
    const acts = el("div", { style: "margin-top:8px;display:flex;gap:8px;justify-content:center" });
    const btnBackup = el("span", {
      class: "ghostbtn",
      title: t("assets.corrupt.backupT"),
      text: t("assets.corrupt.backup"),
    });
    const btnReset = el("span", {
      class: "ghostbtn",
      title: t("assets.corrupt.resetT"),
      text: t("assets.corrupt.reset"),
    });
    btnBackup.addEventListener("click", () => runRecovery("backup"));
    btnReset.addEventListener("click", () => {
      openConfirm({
        title: t("assets.corrupt.confirmTitle"),
        sub: t("assets.corrupt.confirmSub"),
        confirmText: t("assets.corrupt.confirmOk"),
        danger: true,
        onConfirm: () => runRecovery("reset"),
      });
    });
    acts.appendChild(btnBackup);
    acts.appendChild(btnReset);
    hint.appendChild(acts);
    hint.appendChild(el("div", {
      style: "margin-top:6px",
      text: t("assets.corrupt.gate"),
    }));
    // 批 R4.6 · D06: 损坏态与页顶常驻 inh 共用同一文案常量（不另写一套）
    hint.appendChild(el("div", { class: "inh", style: "margin-top:6px", text: t(PAGE_HINT) }));
    S.agrid.appendChild(hint);
    S.emptyHint.style.display = "none";
    return;
  }

  // 批 10-L L1-5（F78）：渲染序走本地序表——序表对齐全库（陌生名入序·已删名剔除），
  //   过滤后的可见集按序表位次排（改卡/改名不再重排·引擎键序只作首见种子）。
  const ordered = orderNames(Object.keys(S.assets || {}), safeStorage());
  const pos = new Map(ordered.map((n, i) => [n, i]));
  const names = filterAssets(S.assets, S.query).filter((n) => {
    const card = S.assets[n];
    // #39 T3: kind 过滤按展示判别式比（道具卡引擎 kind=character 仍归「道具」chip 管）
    if (S.kind !== "all" && (!card || displayKindOf(card) !== S.kind)) return false;
    // 批 1-F2: tag chip = 快捷交集（精确命中该卡 tags 项）；搜索框仍是模糊匹配（name/tags/memo）
    return !S.tag || cardTags(card).includes(S.tag);
  }).sort((a, b) => pos.get(a) - pos.get(b));   // 批 10-L L1-5：可见集按序表位次排
  if (!names.length) {
    if (S.tag) {
      // 批 1-F2: 标签筛选空 —— 不误报空库、不误出搜索空态（标签态优先）
      S.emptyHint.style.display = "none";
      S.agrid.appendChild(el("div", {
        class: "empty-hint",
        style: "grid-column:1/-1",
        text: t("assets.empty.tagFiltered", { tag: S.tag }),
      }));
    } else if (S.query) {
      // E002 搜索空态 (v43 :2983-2989 + v27 P4 文案)
      S.emptyQ.textContent = S.query;
      S.emptyHint.style.display = "block";
    } else if (Object.keys(S.assets || {}).length) {
      // 批 R4.6 · D04: kind 过滤空（库非空）——不误报「资产库为空」
      S.emptyHint.style.display = "none";
      S.agrid.appendChild(el("div", {
        class: "empty-hint",
        style: "grid-column:1/-1",
        text: t("assets.empty.kindFiltered", { kind: kindLabel(S.kind) }),
      }));
    } else if (S.offline && S.cacheEmpty) {
      // #13批A/B盲区: 离线且暂无本地缓存 → 指引文案（离线空快照是正常态——非「资产库为空」
      //   （新建钮已置灰）更非损坏恢复态）
      S.emptyHint.style.display = "none";
      S.agrid.appendChild(el("div", {
        class: "empty-hint",
        style: "grid-column:1/-1",
        text: t("assets.empty.offlineNoCache"),
      }));
    } else {
      S.emptyHint.style.display = "none";
      S.agrid.appendChild(el("div", {
        class: "empty-hint",
        style: "grid-column:1/-1",
        // 批 R8 · R7-4：去「＋ 」（按钮已为 plus 图标+文本「新建资产」形态）
        text: t("assets.empty.libEmpty"),
      }));
    }
    return;
  }
  S.emptyHint.style.display = "none";
  for (const name of names) S.agrid.appendChild(buildCard(name, S.assets[name]));
}

// 批 1-F1: 损坏库恢复执行（引擎 #36 · 两钮共用）。成功 toast 披露备份文件名；reset 后库为空库。
async function runRecovery(action) {
  if (_recoveryBusy) return;
  _recoveryBusy = true;
  const r = await recoveryAssets({ action });
  _recoveryBusy = false;
  if (!S) return; // 卸载后返回的迟到响应 — 丢弃
  if (!r.ok) {
    showToast("error", t("assets.recovery.fail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
    return;
  }
  const bk = r.backup ? t("assets.recovery.bk", { file: r.backup }) : "";
  showToast("success", action === "reset"
    ? t("assets.recovery.resetDone", { bk })
    : t("assets.recovery.backupDone", { bk }));
  refresh();
}

// #39 T3（方案 D3+S2）: 卡面角标随展示判别式——道具卡（character 引擎真值+道具多角度行）
//   cls=theme.css 现成 th-prop（:202/:205·零新增 CSS）；人物/场景行为不变
function kindVisual(card) {
  const kind = displayKindOf(card);
  if (kind === "scene") return { cls: "th-scene", label: t("assets.filter.scene") };
  if (kind === "item") return { cls: "th-prop", label: t("assets.filter.item") };
  return { cls: "th-person", label: t("assets.filter.character") };
}

// ============================================================================
// 走查反馈 F15（老板规格 2026-09-27 深夜）：三视图产物入卡 + 审核流
//   生成完 → 产物挂卡待审（不链任何槽位·待审态存 GUI localStorage——引擎 v3 rows 无「无用途行」
//   形态，写引擎须带 usage/slot；波 2 card_name 模式上线后可迁引擎侧）；
//   卡面待审条 ✓采用 = 写引擎卡 rows（usage=三视图·Picture 空槽）+ 原三视图行删除（原图断联）；
//   ✕忽略 = 不动卡·不删产物文件（引擎 threepov 目录保留·可后悔手动加回）。
// ============================================================================
const POV_KEY = "gui13.povPending";
// F68 批 10-I-T1: 待审条目版本戳——本版起写入的条目一律带 v；无戳 = 改语义前遗留，
//   挂载时由 migrateLegacyPovPending 迁为断槽图（详见该函数判别式说明）。
const POV_ENTRY_V = 2;
// 批 1-T3: 引擎 #46 状态机五态 → 中文（api.md #46: started→rendering→done/failed/interrupted）
const POV_STAGE_LABELS = { started: "排队中", rendering: "渲染中", done: "已完成", failed: "失败", interrupted: "已中断" };
// #92 B3a：阶段词显示侧走 MAPS.status（zh 直通逐字；en 查表——「排队中」为本批补项）
export function povStageLabel(status) { return pickDisplay("status", POV_STAGE_LABELS[status] || "生成中"); }
// 三件补做批 T2（账本 #29）：生成类型分派——引擎任务号前缀是单一真值源：
//   itemcv_ = 道具多角度链（#53/#54·四格），scenecv_ = 场景画布链（#47/#48·#39 接入），
//   其余（threepov_ 等）= 人物三视图链（#45/#46）。
//   各链的卡行用途恰为 povKindLabel 返回值（"三视图" / "道具多角度" / "scene"·均在 USAGE_CATALOG）。
function povKindOf(taskId) {
  const id = String(taskId || "");
  if (/^itemcv_/.test(id)) return "item";
  if (/^scenecv_/.test(id)) return "scene";
  return "person";
}
function povKindLabel(kind) {
  return kind === "item" ? "道具多角度" : (kind === "scene" ? "scene" : "三视图");
}
// #92 B3a：显示侧用途词（povKindLabel 返回值=usage id 数据契约零改；本函数只用于 toast/卡面文案）
function povKindDisp(kind) {
  const id = povKindLabel(kind);
  return id === "三视图" ? t("assets.pov.kindPov") : id === "道具多角度" ? t("assets.pov.kindMulti") : id;
}
// 批 1-T3: 已等待计时 —— 前端本地提交时刻起算（#46 响应无 ts 字段），单位分钟向下取整
export function povWaitMinutes(ts, now = Date.now()) {
  const ms = Number(ts);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / 60000));
}
// 批 10-M M-T4：povPending 迁 server 聚合文件（server 优先 → 本地回退；写内存 + PUT）
function povPendingMap() {
  const v = readAgg(ASSETS_META, "povPending", typeof localStorage !== "undefined" ? localStorage : null);
  if (v == null) return {};
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
}
function povWrite(map) {
  writeAgg(ASSETS_META, "povPending", map);
}
function povAddPending(cardName, entry) {
  const m = povPendingMap();
  (m[cardName] = m[cardName] || []).push(entry);
  povWrite(m);
}
function povUpdatePending(cardName, taskId, patch) {
  const m = povPendingMap();
  const list = m[cardName] || [];
  const hit = list.find((p) => p.taskId === taskId);
  if (hit) Object.assign(hit, patch);
  povWrite(m);
}
// 批 10-H-T2 规则②: 单条待审条目离场（✕不通过）——按 taskId 删，删空则清卡键
function povRemovePending(cardName, taskId) {
  const m = povPendingMap();
  m[cardName] = (m[cardName] || []).filter((p) => !p || p.taskId !== taskId);
  if (!m[cardName].length) delete m[cardName];
  povWrite(m);
}
// F67: 采用成功 → 该卡全部待审条目清空（pending/generating 一并离场——最新预览已接槽，
//   其余旧预览不再滞留卡面无限叠加；只在成功路径调用，saveCard 失败不清、条目保留可重试）
function povClearPending(cardName) {
  const m = povPendingMap();
  delete m[cardName];
  povWrite(m);
}
// 批 2-T4 F-77（老板定版 2026-10-03 · 档位一解耦）: directThreepov 直提入口
//   编辑弹窗页脚「生成三视图 / 多角度…」钮 = 直接出图不开弹窗。批10 T3（方案 §六.3 第 5 条）
//   改整卡模式：body 仅 card_name + writeback:false，图/描述词/忽略词由引擎读卡拼装；
//   原「仅参考图」能力保留在弹窗「以参考图生成」给法里。
//   无图卡仍拦（人物/道具链采用需原图槽位·povApprove 守卫同口径）。
// MAX_REFS = 8（引擎 image_paths 契约上限·9+ → 400 too_many_refs）——弹窗参考图给法使用；
//   整卡模式由引擎按卡收集并截断（同口径），直提不再传图路径。
const MAX_REFS = 8;
// 三件补做批 T1（账本 #28·R-03）：三视图画布三键（比例/质量/时长）持久化——
//   通道 = store 项目实体新键 threepovParams（项目级·persistEntity 单源）：弹窗设定即落值 /
//   资产卡详情页直提沿用同一份 / 清空 = 删键 = 引擎默认（16:9/0.4/2）。
//   无项目上下文边界（方案 N1）：资产库页可无项目直入（shell /assets 独立路由不带项目）——
//   store 无项目可解析时退化为会话态（模块级变量·本页会话内沿用·不持久化·不报错）。
let _threepovSessionParams = null;
function threepovParamsRead() {
  const pid = latestProjectId();
  if (!pid) return _threepovSessionParams ? Object.assign({}, _threepovSessionParams) : null;
  return getThreepovParams(pid);
}
function threepovParamsWrite(params) {
  const pid = latestProjectId();
  if (!pid) {
    _threepovSessionParams = (params && typeof params === "object" && Object.keys(params).length) ? Object.assign({}, params) : null;
    return;
  }
  setThreepovParams(pid, params);
}
async function directThreepov(cardName) {
  const rows = threepovMediaRows(cardName);
  if (!rows.length) {
    showToast("info", t("assets.pov.noImg", { name: cardName }));
    return;
  }
  const r = await submitThreepov({ cardName, writeback: false });
  if (!r.ok) {
    showToast("error", t("assets.submitFail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
    return;
  }
  if (r.taskId) {
    povAddPending(cardName, { status: "generating", taskId: r.taskId, ts: Date.now(), v: POV_ENTRY_V });
    showToast("success", t("assets.pov.submittedAuto", { kind: t("assets.pov.kindPov"), id: r.taskId, name: cardName }));
    pollThreepovIntoCard(r.taskId, cardName);
  } else {
    showToast("success", t("assets.pov.submittedOutput", { kind: t("assets.pov.kindPov"), id: r.taskId || "threepov_*" }));
  }
}
// F68 批 10-I-T1: 旧语义 povPending 条目一次性迁移清扫（老板 8946 真机复现·H 批改语义前积累的
//   旧条目永留卡面）。判别式 = **版本戳**：本版起新流程写入的条目一律带 v:2（见 povAddPending 与
//   done 落条），无戳者即改语义前遗留 → 转 dormant 断槽图留卡（规则②保留语义·编辑弹窗可见可删·
//   文件不删）+ 条目离场；status=generating 在途条目保留（轮询恢复照旧）。
//   天然幂等：清扫只吃无戳条目，新流程条目每次挂载都不受影响，无需迁移标记键。
function migrateLegacyPovPending() {
  const m = povPendingMap();
  let changed = false;
  for (const [name, list] of Object.entries(m)) {
    if (!Array.isArray(list)) continue;
    const keep = [];
    for (const p of list) {
      const legacy = p && !p.v && (p.status === "rejected" || (p.status === "pending" && p.media));
      if (legacy) { dormantAdd(safeStorage(), name, p.media); changed = true; continue; }
      keep.push(p);
    }
    if (keep.length === list.length) continue;
    if (keep.length) m[name] = keep; else delete m[name];
  }
  if (changed) povWrite(m);
}
// F21: 挂载/刷新时恢复「生成中」条目的轮询（提交后刷新页面不再丢状态——F22 根因之一）
//   条件不依赖 S.assets 就绪（listAssets 慢/失败时不阻塞轮询——done 落账与卡库无关）
function resumePovPolling() {
  const m = povPendingMap();
  for (const [name, list] of Object.entries(m)) {
    for (const p of list) {
      if (p && p.status === "generating" && p.taskId) {
        // 批 1-T3: 旧条目无本地提交时刻 → 以本次挂载起算（已等待计时不发明历史时间）
        if (!Number.isFinite(Number(p.ts))) povUpdatePending(name, p.taskId, { ts: Date.now() });
        pollThreepovIntoCard(p.taskId, name);
      }
    }
  }
}
// 提交后轮询（弹窗已关·模块级计时器；done → 待审挂卡；failed/interrupted → toast；5 分钟上限）
//   _povPolling 防重：refresh 恢复轮询与提交轮询并发时同 taskId 只挂一个 interval
const _povPolling = new Set();
function pollThreepovIntoCard(taskId, cardName) {
  if (_povPolling.has(taskId)) return;
  _povPolling.add(taskId);
  // T2（#29）: 按任务前缀分派状态端点——itemcv_ → #54 item_canvas/status，scenecv_ → #48（#39），其余 → #46
  const kind = povKindOf(taskId);
  let tries = 0;
  const timer = setInterval(() => { void tick(); }, 3000);
  async function tick() {
    tries += 1;
    if (tries > 100) { clearInterval(timer); _povPolling.delete(taskId); return; }
    let st;
    try { st = await (kind === "item" ? itemCanvasStatus(taskId) : kind === "scene" ? sceneCanvasStatus(taskId) : threepovStatus(taskId)); } catch (_e) { return; }
    if (!st.ok) return; // 网络抖动重试
    // 批 1-T3: 阶段（#46 五态）落 pending 条目 → 卡面显「排队中/渲染中…」+ 已等待 X 分；
    //   非终态本地重渲一次（不重拉引擎），计时随 3s 节拍走。
    povUpdatePending(cardName, taskId, { stage: st.status });
    if (st.status === "done" && st.resultPngPath) {
      clearInterval(timer);
      _povPolling.delete(taskId);
      // F67: 写回前查该 taskId 是否仍存在于 pending 列表——可能已被更新一轮的取代/采用清掉；
      //   已被清则只停轮询，不复活不落条不 toast（在途任务各自的 interval 到此自然熄火）
      const m = povPendingMap();
      const hit = (m[cardName] || []).find((p) => p && p.taskId === taskId);
      if (!hit) return;
      // F67: 新轮生成完成即取代——该卡其余旧条目（pending/rejected/generating）全部离场只落本条
      //   （老板语义「最新预览取代全部旧预览」·治待审条无限叠加）
      m[cardName] = [Object.assign(hit, { status: "pending", media: st.resultPngPath, v: POV_ENTRY_V })];
      povWrite(m);
      showToast("success", t("assets.pov.generated", { name: cardName, kind: povKindDisp(kind) }));
      if (S) refresh();
    } else if (st.status === "failed" || st.status === "interrupted") {
      clearInterval(timer);
      _povPolling.delete(taskId);
      const m = povPendingMap();
      m[cardName] = (m[cardName] || []).filter((p) => p.taskId !== taskId);
      if (!m[cardName].length) delete m[cardName];
      povWrite(m);
      showToast("error", t("assets.pov.taskFail", {
        kind: povKindDisp(kind),
        end: st.status === "failed" ? t("assets.pov.endFailed") : t("assets.pov.interrupted"),
        detail: st.error || t("assets.pov.seeEngine"),
      }));
      if (S) refresh();
    } else if (S) {
      renderGrid();
    }
  }
  void tick(); // 批 1-T3: 首查立即 —— 阶段/计时不必等首个 3s 周期才上卡
}
// ✓ 采用（批 10-H-T2 规则②·老板定版）：三视图**代替原图接槽**——原图的全部绑定行 media 换成
//   产物（usage/slot/desc 等全继承·多用途镜像同步换·范式同 F66 裁剪 confirmCrop），
//   原图断槽落 dormant 分离键（卡面并集仍可见·弹窗断槽行可删），旧产物行出卡。
//   槽位由接管来·天然不涨：不再算 nextSlot·也无 Picture 槽满守卫。
//   T2（#29）道具变体（taskId 前缀 itemcv_）：旧行过滤条件与写入 usage 分派为「道具多角度」
//   （引擎道具行语义·#53 建档路由判据），接管行 usage 改写为道具多角度——人物链保持全继承不回归。
//   #39 场景变体（taskId 前缀 scenecv_）：**追加不逐行**（方案 D2●B1 定案）——源行全保留·产物
//   另起一行 usage=scene·slot 接 Picture 最大号后（引擎 v3 行校验 slot 必填 1-9）；不落 dormant
//   （源行未动无断槽）；无 src 文字卡放开（产物即首行）；9 行图位饱和白话拦截。
async function povApprove(name, entry) {
  const card = S && S.assets ? S.assets[name] : null;
  if (!card) { showToast("error", t("assets.pov.cardGone")); return; }
  const kind = povKindOf(entry && entry.taskId);
  const ownUsage = povKindLabel(kind); // 各链的卡行用途："三视图" | "道具多角度" | "scene"
  const rows = Array.isArray(card.rows) ? card.rows : [];
  const src = rows.map((x) => (x && x.media)).find(Boolean) || ""; // 生成源图（directThreepov 同款·采用时现算）
  // #39: scene 采用=追加语义，无 src 文字卡也放开（产物即首行）；人物/道具链保持零图拦截
  if (!src && kind !== "scene") { showToast("error", t("assets.pov.noSlot", { name })); return; }
  if (!entry.media) { showToast("error", t("assets.pov.noProduct")); return; }
  let next;
  if (kind === "scene") {
    // 非视频/音频行均占 Picture 槽位（未知用途按图兜底）——饱和守卫 + 接最大号
    const picRows = rows.filter((r) => {
      if (!r) return false;
      const u = USAGE_CATALOG.find((c) => c.id === r.usage);
      return !u || u.kind === "Picture";
    });
    const nextSlot = picRows.reduce((m, r) => Math.max(m, parseInt(r.slot, 10) || 0), 0) + 1;
    if (picRows.length >= SLOT_RANGES.Picture || nextSlot > SLOT_RANGES.Picture) {
      showToast("info", t("assets.pov.slotsFull", { name, max: SLOT_RANGES.Picture }));
      return;
    }
    next = rows.concat([{ usage: ownUsage, media: entry.media, slot: String(nextSlot), desc: "", ignore_words: "" }]);
  } else {
    const kept = rows.filter((r) => !r || r.usage !== ownUsage || r.media === entry.media); // 旧产物行出卡
    next = kept.map((r) => {
      if (!r || r.media !== src) return r;
      return kind === "item" ? { ...r, usage: ownUsage, media: entry.media } : { ...r, media: entry.media };
    });
  }
  const r = await saveCard(name, { ...card, rows: next });
  if (r && r.ok) {
    if (kind !== "scene") dormantAdd(safeStorage(), name, src); // 原图断槽（F66 同款：成功后才登记·scene 追加语义源行未动不登记）
    // F67: 采用成功 → 清空该卡全部待审条目（不再只清自己那条——旧条一并离场）
    povClearPending(name);
    showToast("success", kind === "scene"
      ? t("assets.pov.adoptedScene")
      : t("assets.pov.adoptedTakeover", { kind: povKindDisp(kind) }));
    void invalidateAssetsCache();   // 任务C #55：采用成功 → prompt 缓存失效重拉广播（画布绑定节点同步新图）
    refresh();
  } else {
    showToast("error", t("assets.pov.adoptFail", { reason: (r && r.error && r.error.msg) || t("assets.pov.writeRejected") }));
  }
}

function buildCard(name, card) {
  const vis = kindVisual(card);
  const rows = card && Array.isArray(card.rows) ? card.rows : [];
  // 批A #13: 离线只读卡（引擎不可达·快照数据）——无操作组、点卡不开编辑弹窗
  const ro = !!(S && S.offline);
  const cardEl = el("div", {
    class: "acard",
    "data-name": name,
    title: ro ? t("assets.card.roTitle") : t("assets.card.editTitle"),
  });

  // E001 hover 操作组 (v43 :4311-4315 形态 · 原编辑/删除/导出 + R4.6 补回「三视图」) —
  //   批 10-F T3 (F64「只保留删除和导出」) 后 G 块 2026-10-25 再摘导出 op（占位弹窗死控件）→
  //   仅剩删除；编辑=点卡面重复 / 三视图·多角度=顶栏「生成三视图 / 多角度…」更好入口 /
  //   裁剪=编辑弹窗裁剪钮+双击预览更好入口
  //   批A #13: 离线只读不出操作组（删除为引擎写侧）
  if (!ro) {
    const ops = el("div", { class: "ac-ops" });
    const opDel = el("span", { class: "op", title: t("assets.card.delT"), text: t("settings.btn.delete") });
    opDel.addEventListener("click", (e) => { e.stopPropagation(); assetDelete(name); });
    ops.appendChild(opDel);
    cardEl.appendChild(ops);
  }

  // E001 4:3 缩略图 (theme.css .acard .ph 已含 aspect-ratio:4/3 基准 176×132;
  //   真图走 /h3_batch/thumb (api.md #30 · max_size=512〔R-22 提档·卡宽 184-280×DPR2〕), 失败时落回 kind 渐变底 — .ph-img 透明不遮底)
  //   走查反馈 F22（老板「三视图没出现在档案卡下·审核通过也没出现」根因之一: 卡面只显首行图）：
  //   多图卡错层叠显（.ph-stack 前 2 张 media——三视图采用后进 rows 即在卡面可见）+ F66 断槽并集:
  //   rows medias ∪ dormant 原图——裁剪接管后原图只在 GUI 分离键（引擎 rows 无原图），卡面继续可见
  const ph = el("div", { class: "ph " + vis.cls });
  const dormantMedias = readDormant(safeStorage())[name] || [];
  const medias = [...new Set([
    ...rows.map((r) => (r && typeof r.media === "string" ? r.media : "")).filter(Boolean),
    ...dormantMedias.filter((m) => typeof m === "string" && m),
  ])].slice(0, 2);
  // 批 B #13：URL 收敛 mediaUrl 单源；bg 无 error 事件 → wireBgMediaFallback 探活回落本地缩略
  //   （引擎口失败才切 /gui13-fs/thumb·离线卡墙含图判据）。Node 测试无 Image → no-op。
  const thumbUrl = (m) => `url("${mediaUrl("thumb", assetThumbPath(m), { maxSize: 512 })}")`;
  const wireThumbBg = (elm, m) => wireBgMediaFallback(elm, "thumb", assetThumbPath(m), { maxSize: 512 });
  if (medias.length >= 2) {
    const stack = el("div", { class: "ph-stack" });
    medias.forEach((m, i) => {
      const layer = el("div", { class: "layer " + (i === 0 ? "l1" : "l2") });
      layer.style.backgroundImage = thumbUrl(m);
      wireThumbBg(layer, m);
      stack.appendChild(layer);
    });
    ph.appendChild(stack);
    ph.title = medias.join("\n");
  } else if (medias.length === 1) {
    const img = el("div", { class: "ph-img" });
    // 引擎 thumb 端点对相对路径按 ComfyUI 根解析（真机实测：asset_library/… 404、input/asset_library/… 200）——
    // 概念帧卡 media 存库为相对路径（asset_library/asset_images/concept/…），消费时补 input/ 前缀；
    // 绝对路径（历史卡）或已带 input/ 前缀的 media 原样透传（谓词 = core/assets_api.js assetThumbPath）
    img.style.backgroundImage = thumbUrl(medias[0]);
    wireThumbBg(img, medias[0]);
    ph.appendChild(img);
    ph.title = medias[0];
  } else {
    ph.appendChild(el("span", { text: vis.label }));
  }
  cardEl.appendChild(ph);

  // 卡名行 (v43 :4316 .no · 引擎无编号制 — name 即标识, 不再拼 @N)
  cardEl.appendChild(el("div", { class: "no" }, [el("b", { text: name })]));
  const memo = card && typeof card.memo === "string" ? card.memo : "";
  if (memo) cardEl.appendChild(el("div", { style: "font-size:12px;color:var(--txt3);margin-top:2px", text: memo }));

  // 批 1-F2: 卡面 tags 只读 chips（1.0 assets.js:199 — 无标签不渲染空白区）
  const tags = cardTags(card);
  if (tags.length) {
    const tagWrap = el("div", { style: "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px" });
    for (const tg of tags) tagWrap.appendChild(el("span", { class: "tagc", "data-tag": tg, text: tg }));
    cardEl.appendChild(tagWrap);
  }

  // F34②: 三视图状态条两态——生成中 / 待审核（大缩略图可点开原图·✓采用/✕不通过）。
  //   批 10-I-T1 F68: 旧语义条目（pending 带 media / rejected）挂载时已由 migrateLegacyPovPending
  //   迁为断槽图并离场 → 此处只剩新流程的 generating/pending 两态，rejected 渲染分支成死支已删。
  const pend = povPendingMap()[name] || [];
  for (const p of pend) {
    const kindName = povKindDisp(povKindOf(p.taskId)); // T2 #29: 前缀分派显示词（三视图 / 道具多角度·数据侧仍 povKindLabel）
    if (p.status === "generating") {
      const gen = el("div", { class: "pov-pend gen", title: t("assets.pov.taskTitleT", { id: p.taskId || "" }) });
      gen.appendChild(el("span", { class: "pov-spin", text: "◍" }));
      // 批 1-T3: 阶段（#46 五态）+ 已等待计时（前端本地提交时刻起算 — #46 响应无 ts 字段）
      gen.appendChild(el("span", {
        class: "pov-tag",
        text: t("assets.pov.pendingGen", { kind: kindName, stage: povStageLabel(p.stage), min: povWaitMinutes(p.ts) }),
      }));
      cardEl.appendChild(gen);
      continue;
    }
    if (!p.media) continue;
    const bar = el("div", { class: "pov-pend", title: p.media });
    const thumb = el("span", { class: "pov-thumb", title: t("assets.viewOrig") });
    thumb.style.backgroundImage = `url("${mediaUrl("thumb", assetThumbPath(p.media), { maxSize: 176 })}")`;   // 批 B #13
    wireBgMediaFallback(thumb, "thumb", assetThumbPath(p.media), { maxSize: 176 });
    thumb.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(p.media); });
    bar.appendChild(thumb);
    bar.appendChild(el("span", { class: "pov-tag", text: t("assets.pov.pendingTag", { kind: kindName }) }));
    const ok = el("span", { class: "op pov-ok", text: t("assets.pov.adopt") });
    ok.addEventListener("click", (e) => { e.stopPropagation(); void povApprove(name, p); });
    const no = el("span", { class: "op pov-no", text: t("assets.pov.reject") });
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      // 批 10-H-T2 规则②（老板定版·取代 G-T2 的 rejected 滞留态）: 不通过 = 保留卡上·不接槽——
      //   三视图落断槽分离键（卡面并集可见·编辑弹窗断槽行可删·文件不删），待审条直接离场
      povRemovePending(name, p.taskId);
      dormantAdd(safeStorage(), name, p.media);
      showToast("info", t("assets.pov.rejectedDone"));
      refresh();
    });
    bar.appendChild(ok);
    bar.appendChild(no);
    cardEl.appendChild(bar);
  }

  // E004 点卡进编辑弹窗 (操作组已 stopPropagation)
  // F34 修正笔（老板澄清 2026-09-28：「我要的是弹窗里的预览图点击看原图·不是卡面放大——
  // 点图劫持让编辑功能失效」）：回滚卡面 .ph 灯箱劫持——点卡任意处仍进编辑弹窗；
  //   灯箱挂点改到编辑弹窗内（当前行预览 .mthumb + 行条缩略图 .mrow-thumb·每行可看）与
  //   待审条缩略图（三视图生成后在卡上预览·点开原图——F34② 本意保留）
  // 批A #13: 离线只读——点卡不开编辑弹窗，只读提示
  cardEl.addEventListener("click", () => {
    if (S && S.offline) { showToast("info", t("assets.card.offlineToast")); return; }
    openAssetModal(name);
  });
  return cardEl;
}

// ============================================================================
// E004/E005/E006 — 资产编辑弹窗 (v43 #amodal :1885-1920 + :2787-2899)
// 走查反馈 F32（老板「档案卡弹窗逻辑有 bug 只有一个图片·改法看 GUI1.0 结构」）：
//   对齐 GUI1.0 assets_card_dialog 媒体行区——一卡多行，每行 = 一张图 + 该行独立的
//   用途勾选/描述/忽略词；保存时逐行 expandUsageRows 拼接全卡 rows（一行勾 K 用途→K 条）。
// ============================================================================

const POSE_CATALOG_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
// 批 1-F4: 引擎 v3 行内「已知键」集——其余键为未知键（extras 原样保留）。
//   usage/slot/media/desc/ignore_words = api.md #35 行级字段（必收键四 + 可选忽略词）；
//   pose_style = GUI 扩展字段（a2）；idx = 1.0 行号字段（T1 手编）。此七键由表单重建，不进 extras。
const ROW_KNOWN_KEYS = new Set(["usage", "slot", "media", "desc", "ignore_words", "pose_style", "idx"]);

// ============================================================================
// 走查反馈 F34（老板三条：①卡预览图点击看原图 ②三视图预览上卡可点原图 ③待审/不通过都不接槽）
// 灯箱查看器：全屏遮罩 + 原图（thumb 通道 max_size=2048 近原图）·ESC/点遮罩关闭。
// 对齐 GUI1.0 components/lightbox.js 结构（简版——本仓单图查看·无缩放拖拽）。
// ============================================================================
// 批 1-F6: 视频扩展名媒体（与引擎 #30 thumb 视频分支/#44 video 支持扩展名对齐 + m4v 同族）
const VIDEO_MEDIA_EXTS = new Set(["mp4", "webm", "mov", "avi", "mpeg", "mpg", "mkv", "m4v"]);
export function isVideoMedia(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path == null ? "" : path).trim());
  return !!m && VIDEO_MEDIA_EXTS.has(m[1].toLowerCase());
}

export function openLightbox(mediaPath) {
  if (typeof document === "undefined" || !mediaPath) return null;
  const abs = assetThumbPath(mediaPath);
  const mask = el("div", { class: "lb-mask" });
  const img = el("img", { class: "lb-img", alt: t("assets.lb.origAlt") });
  img.src = mediaUrl("thumb", abs, { maxSize: 2048 });   // 批 B #13：URL 收敛单源（失败态由 1-F6 占位面板既有兜底）
  const cap = el("div", { class: "lb-cap", text: mediaPath });
  mask.appendChild(img);
  mask.appendChild(cap);
  // 批 1-F6: 视频媒体不渲染坏图 —— 优先 #30 thumb（引擎对视频走 ffmpeg 首帧 PNG · api.md #30）；
  //   首帧取不到（404/编码失败）→ 换友好占位面板，灯箱里不留破图。
  //   真播登记引擎线（降级处置·方案已声明）：#44 /h3_batch/video 白名单 = server output 树 + archive_root
  //   （api.md #44 安全边界），资产库 media（input/asset_library 树）在域外 → 一律 403，故本仓不硬播；
  //   待引擎线扩白名单（或加资产库播放端点）后，此处再切 <video> 真播。
  if (isVideoMedia(abs)) {
    img.alt = ""; // 视频无静态原图：失败不露 alt 文本，直接换面板
    img.addEventListener("error", () => {
      const ph = el("div", {
        class: "lb-video-ph",
        title: abs,
        style: "max-width:min(82vw,560px);padding:40px 24px;border:1px dashed var(--line);border-radius:10px;color:var(--txt2);font-size:13px;text-align:center;line-height:1.8",
        text: t("assets.lb.videoPh"),
      });
      if (img.parentNode === mask) { mask.removeChild(img); mask.insertBefore(ph, cap); }
    });
  }
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  };
  function onKey(e) {
    if (e && e.key === "Escape") { e.stopPropagation ? e.stopPropagation() : null; close(); }
  }
  mask.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(mask);
  return { close };
}

// 引擎 rows → 行模型逆展开（同 media 的多条 usage 行并为一行的多个勾选项）
export function groupRowsByMedia(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const idx = USAGE_CATALOG.findIndex((u) => u.id === row.usage);
    if (idx < 0) continue;
    const media = typeof row.media === "string" ? row.media : "";
    let g = out.find((x) => x.media === media);
    if (!g) { g = { media, items: [], idx: "", slot: "" }; out.push(g); }
    if (g.items.some((it) => it.idx === idx)) continue;
    const it = {
      idx,
      desc: typeof row.desc === "string" ? row.desc : "",
      ignore: typeof row.ignore_words === "string" ? row.ignore_words : "",
      // 批 1-T1: 源行行号/槽号按行保留——未手编时逐行保真回写（不把组内首行值摊给其他用途行）
      srcIdx: Number.isInteger(row.idx) && row.idx >= 1 ? row.idx : null,
      srcSlot: typeof row.slot === "string" ? row.slot : "",
    };
    // 批 1-F4 行级 round-trip: 引擎 v3 已知键之外的行内字段原样保留（保存时先铺底·见 expandUsageRows）
    const extras = {};
    for (const k of Object.keys(row)) if (!ROW_KNOWN_KEYS.has(k)) extras[k] = row[k];
    if (Object.keys(extras).length) it.extras = extras;
    if (idx === POSE_CATALOG_IDX && (row.pose_style === "skeleton" || row.pose_style === "depth")) {
      it.poseStyle = row.pose_style;
    }
    g.items.push(it);
  }
  // 手编输入框初值 = 组内首行源值（1.0 :702/:817 口径：输入框预填当前值；未手改则按行保真）
  for (const g of out) {
    const first = g.items[0];
    if (!first) continue;
    g.idx = first.srcIdx != null ? String(first.srcIdx) : "";
    g.slot = first.srcSlot || "";
  }
  return out;
}

function openAssetModal(name) {
  if (!S || typeof document === "undefined") return;
  const isEdit = typeof name === "string" && !!S.assets[name];
  const card = isEdit ? S.assets[name] : null;

  // ---- 基本信息 ----
  const nameInput = el("input", { type: "text", placeholder: t("assets.edit.namePh"), value: isEdit ? name : "" });
  nameInput.style.cssText = "flex:1;min-width:200px;padding:7px 10px;font-size:13px;outline:none";
  // 类型 — #39 T3 触点①（方案 D3+I4）: 值域=展示三值 {character,scene,item}（item 不与人物
  //   同 value·I4 定案）；引擎白名单仍 character|scene（保存时映射 item→character·见 saveBtn）。
  //   回显 = displayKindOf（道具卡显「道具」·三视图优先）。
  const kindSel = el("select", { title: t("assets.edit.kindT") });
  for (const [v, label] of [["character", "assets.filter.character"], ["scene", "assets.filter.scene"], ["item", "assets.filter.item"]]) {
    kindSel.appendChild(el("option", { value: v, text: t(label) }));
  }
  kindSel.value = card ? displayKindOf(card) : "character";
  // 批 1-T2: 用户手改过 kind → 用途推断不再覆盖（1.0 kindTouched 口径）
  let kindTouched = false;
  kindSel.addEventListener("change", () => { kindTouched = true; });
  // 批 R4.6 · D08 tagchips (v43 :1896): 已加标签渲染为 chip(×删除) · 输入回车/失切落 chip · 保存时拼接
  let tagList = card && Array.isArray(card.tags) ? [...card.tags] : [];
  const tagChips = el("div", { class: "tagchips" });
  const tagsInput = el("input", {
    type: "text",
    placeholder: t("assets.edit.tagsPh"),
  });
  tagsInput.style.cssText = "width:100%;padding:7px 10px;font-size:12px;outline:none";
  function renderTagChips() {
    clearChildren(tagChips);
    for (const tg of tagList) {
      const del = el("b", { text: "×", title: t("assets.edit.tagDelT", { tag: tg }) });
      del.addEventListener("click", () => { tagList = tagList.filter((v) => v !== tg); renderTagChips(); });
      tagChips.appendChild(el("span", { class: "tagc" }, [document.createTextNode(tg), del]));
    }
  }
  function commitTagsInput() {
    const add = normalizeTags(tagsInput.value);
    if (!add.length) return;
    tagList = normalizeTags([...tagList, ...add]); // 去重保序（normalizeTags 既有通道）
    tagsInput.value = "";
    renderTagChips();
  }
  renderTagChips();
  tagsInput.addEventListener("keydown", (e) => {
    if (e && e.key === "Enter") { if (e.preventDefault) e.preventDefault(); commitTagsInput(); }
  });
  tagsInput.addEventListener("blur", commitTagsInput);
  const secBase = el("div", { class: "am-sec" });
  secBase.appendChild(el("div", { class: "am-cap" }, [
    el("span", { text: t("assets.edit.secBase") }),
    el("span", { class: "inh", text: t("assets.edit.secBaseHint"), style: "margin-left:auto;letter-spacing:0" }),
  ]));
  const baseRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
  baseRow.appendChild(nameInput);
  baseRow.appendChild(kindSel);
  secBase.appendChild(baseRow);
  secBase.appendChild(el("div", { style: "height:8px" }));
  secBase.appendChild(tagChips);
  secBase.appendChild(tagsInput);

  // ---- 媒体行区 (F32: GUI1.0 结构——一行一图+行内用途勾选/描述; 单 mediaInput 时代终结) ----
  // 行模型: mediaRows = [{media, items:[{idx,desc,ignore,poseStyle?}], idx, slot, idxTouched, slotTouched}]
  //   idx/slot = 手编行号/槽号输入框值（批 1-T1）；*Touched = 用户是否手改过（未改则按行保真/自动编号）
  let mediaRows = isEdit ? groupRowsByMedia(card && card.rows) : [];
  if (!mediaRows.length) mediaRows = [newMediaRow()];
  // F66: 断槽原图（GUI 本地分离键·不进引擎 rows）——行条展示并集；保存链只重建 mediaRows，
  //   dormant 留在分离键天然不丢；批 10-H-T1 规则⑤: 断槽行也带删行钮（点 × 即摘·分离键直写）
  const dormantMedias = isEdit
    ? (readDormant(safeStorage())[name] || []).filter((m) => typeof m === "string" && m)
    : [];
  // 并集去重：media 已回到某媒体行 → 不再以断槽态重复展示
  const dormantRowsNow = () => {
    const live = new Set(mediaRows.map((r) => String(r.media || "").trim()));
    return dormantMedias.filter((m) => !live.has(String(m).trim()));
  };
  let curRowIdx = 0;
  function newMediaRow() { return { media: "", items: [], idx: "", slot: "", idxTouched: false, slotTouched: false }; }

  const mediaInput = el("input", {
    type: "text",
    placeholder: t("assets.edit.mediaPh"),
  });
  mediaInput.style.cssText = "flex:1;min-width:0;padding:5px 7px;font-size:12px;outline:none";
  const mediaPickFile = el("input", { type: "file", accept: "image/*", style: "display:none" });
  const mediaPickBtn = el("button", { type: "button", class: "fbtn", text: t("assets.edit.pickFile"), title: t("assets.edit.pickFileT") });
  // 批 2-T3 F3：引擎库 = 从服务器已有图片里选（openPicker image 模式·引擎 #30 缩略图网格）
  const mediaLibBtn = el("button", { type: "button", class: "fbtn", text: t("assets.edit.libBtn"), title: t("assets.edit.libBtnT") });
  const mediaPathRow = el("div", { class: "mrow-path" });
  mediaPathRow.appendChild(mediaInput);
  mediaPathRow.appendChild(mediaPickBtn);
  mediaPathRow.appendChild(mediaLibBtn);
  mediaPathRow.appendChild(mediaPickFile);
  const usechks = el("div", { class: "usechks" });
  const dynDesc = el("div", { class: "dyn-desc" });

  const secMedia = el("div", { class: "am-sec" });
  secMedia.appendChild(el("div", { class: "am-cap" }, [
    el("span", { text: t("assets.edit.secMedia") }),
    el("span", { class: "inh", text: t("assets.edit.secMediaHint"), style: "margin-left:auto;letter-spacing:0" }),
  ]));

  // ---- 行条列表（横向小卡：序号/缩略图/路径/用途徽标/删行；点击=切换当前编辑行） ----
  const rowsBar = el("div", { class: "mrows-bar" });
  secMedia.appendChild(rowsBar);
  const addRowBtn = el("button", { type: "button", class: "fbtn", text: t("assets.edit.addRow"), title: t("assets.edit.addRowT") });
  addRowBtn.style.marginTop = "4px";
  addRowBtn.addEventListener("click", () => {
    flushCurrentRow();
    mediaRows.push(newMediaRow());
    selectRow(mediaRows.length - 1);
  });
  secMedia.appendChild(addRowBtn);
  secMedia.appendChild(el("div", { style: "height:8px" }));

  // ---- 批 1-T1: 行号/槽号手编 (1.0 :702 idxIn / :817 slotIn) ----
  //   初值 = 源行值（未手改则逐行保真回写）；手改后该行全部展开行统一用输入值（1.0 手编值复制口径）。
  //   槽号脏值守卫 + 值域校验在保存时执行（core/assets_api.js normalizeSlot）。
  const idxInput = el("input", {
    type: "number", min: "1",
    placeholder: t("assets.edit.idx"),
    title: t("assets.edit.idxT"),
  });
  idxInput.style.cssText = "width:74px;padding:5px 7px;font-size:12px;outline:none";
  const slotInput = el("input", {
    type: "text",
    placeholder: t("assets.edit.slot"),
    title: t("assets.edit.slotT"),
  });
  slotInput.style.cssText = "width:74px;padding:5px 7px;font-size:12px;outline:none";
  const numsRow = el("div", { class: "mrow-nums", style: "display:flex;gap:8px;align-items:center;margin-top:6px;font-size:12px" });
  numsRow.appendChild(el("span", { class: "ig-lbl", text: t("assets.edit.idx") }));
  numsRow.appendChild(idxInput);
  numsRow.appendChild(el("span", { class: "ig-lbl", text: t("assets.edit.slot") }));
  numsRow.appendChild(slotInput);
  numsRow.appendChild(el("span", { class: "inh", text: t("assets.edit.numsHint") }));
  idxInput.addEventListener("input", () => {
    const row = mediaRows[curRowIdx];
    if (row) { row.idx = idxInput.value; row.idxTouched = true; }
  });
  slotInput.addEventListener("input", () => {
    const row = mediaRows[curRowIdx];
    if (row) { row.slot = slotInput.value; row.slotTouched = true; }
  });

  // ---- 当前行编辑区（路径 + 预览 + 用途 + 描述） ----
  secMedia.appendChild(el("div", { class: "inh", text: t("assets.edit.rowN", { n: curRowIdx + 1 }) , style: "font-size:12px" }));
  const curRowLabel = secMedia.lastChild;
  secMedia.appendChild(mediaPathRow);
  secMedia.appendChild(numsRow);
  secMedia.appendChild(el("div", { style: "height:6px" }));
  // S3-2 T7 (v43 :552/:1905 .mthumb 媒体行缩略框): 路径输入即出预览图 —— 编辑/新建两态同口径
  const mediaPreview = el("div", { class: "mthumb" });
  // F34 修正笔: 当前行预览图点击 = 灯箱看原图（弹窗内审图——老板本意）· F52: 双击 = 进裁剪
  mediaPreview.title = t("assets.edit.previewT");
  mediaPreview.addEventListener("click", () => {
    const v = (mediaInput.value || "").trim();
    if (v) openLightbox(v);
  });
  // F52 走查: 双击预览框 = 进裁剪（同下方裁剪钮通道·产物接管原图槽位·原图保留断槽）——
  //   视频/空路径无图可裁 → 无操作；监听绑 .mthumb 容器，renderMediaPreview 重建内层 img 不丢
  //   批 10-F-T4 修正笔: 开裁剪前先关编辑弹窗（povBtn 同款惯例）——confirmCrop 后弹窗若留驻，
  //   其 mediaRows 是打开时快照，点「保存」会以旧快照整卡重建 rows 把裁剪接管回滚成原图
  //   R-18 搁置池清点: 新建态（isEdit=false）无卡可裁，close 纯属误伤（未保存表单整窗丢）——
  //   守卫 + info toast 说明（不静默，title 仍注明「双击可裁剪」·静默会让用户以为没点上）
  mediaPreview.addEventListener("dblclick", () => {
    const v = (mediaInput.value || "").trim();
    if (!v || isVideoMedia(v)) return;
    if (!isEdit) { showToast("info", t("assets.edit.dblCropNewOnly")); return; }
    inst.close();
    openCropModal(name, mediaInput.value, card);
  });
  secMedia.appendChild(mediaPreview);
  mediaInput.addEventListener("input", () => {
    renderMediaPreview(mediaPreview, mediaInput.value);
    const row = mediaRows[curRowIdx];
    if (row) row.media = mediaInput.value;
    renderRowsBar();
  });
  // A3 快批⑥: 选本机图片 → 上传 → 路径回填 + 预览刷新（handler 排在预览节点之后）
  mediaPickBtn.addEventListener("click", () => { if (mediaPickFile.click) mediaPickFile.click(); });
  // 批 2-T3 F3: 引擎库 → openPicker(image) 选引擎已有图 → 路径回填 + 预览刷新（与上传通道同回填语义）
  mediaLibBtn.addEventListener("click", () => {
    openPicker({
      title: t("assets.edit.pickerTitle"),
      mode: "image",
      current: (mediaInput.value || "").trim(),
      onPick: (picked) => {
        if (typeof picked !== "string" || !picked) return;
        mediaInput.value = picked;
        const row = mediaRows[curRowIdx];
        if (row) row.media = picked;
        renderMediaPreview(mediaPreview, picked);
        renderRowsBar();
        showToast("success", t("assets.edit.pickedFromLib", { path: picked }));
      },
    });
  });
  mediaPickFile.addEventListener("change", async () => {
    const f = mediaPickFile.files && mediaPickFile.files[0];
    mediaPickFile.value = ""; // 复位：同一文件重选也触发 change
    if (!f) return;
    try {
      const up = await uploadImage(buildUploadFormData(f, f.name || "pick.png", UPLOAD_MEDIA_ROOT));
      if (!up || !up.name) throw new Error(t("assets.up.noName"));
      mediaInput.value = UPLOAD_MEDIA_ROOT + up.name;
      const row = mediaRows[curRowIdx];
      if (row) row.media = mediaInput.value;
      renderMediaPreview(mediaPreview, mediaInput.value);
      renderRowsBar();
      showToast("success", t("assets.edit.uploaded", { path: mediaInput.value }));
    } catch (e) {
      showToast("error", t("assets.edit.uploadFail", { reason: (e && e.message) || e }));
    }
  });
  // S3-2 T6 (E031 · v43 :1906 媒体行「裁剪」fbtn): 图片类资产才显示——
  // 可见性随 kind 锁（E006 口径：锁定 kind = Picture 才出图片类工具），由 refreshKindLock 同步。
  const cropRow = el("div", { style: "display:none;margin-top:6px" });
  if (isEdit) {
    const cropBtn = el("button", {
      type: "button", class: "fbtn", text: t("assets.edit.crop"),
      title: t("assets.edit.cropT"),
    });
    // 批 10-F-T4 修正笔: 先关编辑弹窗再开裁剪（povBtn 同款）——理由见双击入口注释
    cropBtn.addEventListener("click", () => {
      inst.close();
      openCropModal(name, mediaInput.value, card);
    });
    cropRow.appendChild(cropBtn);
  }
  secMedia.appendChild(cropRow);
  secMedia.appendChild(usechks);
  secMedia.appendChild(dynDesc);

  // ---- 行切换/回写（GUI1.0 语义：一行一勾态；切换先把当前行勾选/描述写回行模型） ----
  function flushCurrentRow() {
    const row = mediaRows[curRowIdx];
    if (!row) return;
    // 守卫：usechks 尚未按行构建（首调 selectRow 前是空容器）——collectChecked 只会得 []，
    // 此时回写会把 groupRowsByMedia 回填的 items 清掉（真机复现：行条恒「未勾用途」）
    if (!usechks.querySelector("input[type=checkbox]")) return;
    row.media = mediaInput.value;
    row.idx = idxInput.value;
    row.slot = slotInput.value;
    // DOM 勾选态重建 items 时按用途下标并回旧 item 元数据（源槽号/源行号/未知键 extras）——
    // 批 1-F4/T1：不并回则每次切行/保存都把行级 round-trip 数据丢光
    const prev = row.items || [];
    row.items = collectChecked(usechks, dynDesc).map((it) => {
      const old = prev.find((p) => p.idx === it.idx);
      return old ? Object.assign({}, old, it) : it;
    });
  }
  function selectRow(i) {
    flushCurrentRow();
    curRowIdx = Math.max(0, Math.min(i, mediaRows.length - 1));
    const row = mediaRows[curRowIdx];
    if (!row) {
      // 批 10-H-T1 规则⑤: 零图态（最后一张已删）——清编辑区不留残值，路径可再手输/加行
      mediaInput.value = "";
      idxInput.value = "";
      slotInput.value = "";
      renderMediaPreview(mediaPreview, "");
      curRowLabel.textContent = t("assets.edit.noRows");
      clearChildren(usechks);
      clearChildren(dynDesc);
      renderRowsBar();
      return;
    }
    mediaInput.value = row.media;
    idxInput.value = row.idx || "";
    slotInput.value = row.slot || "";
    renderMediaPreview(mediaPreview, row.media);
    curRowLabel.textContent = t("assets.edit.rowOf", { n: curRowIdx + 1, total: mediaRows.length });
    // 重建用途复选 + 描述行组为该行勾态（buildUsechks 既有通道复用）
    clearChildren(usechks);
    clearChildren(dynDesc);
    const checkedIdxs = row.items.map((it) => it.idx);
    const descMap = {};
    const ignoreMap = {};
    const poseStyleMap = {};
    for (const it of row.items) {
      descMap[it.idx] = it.desc || "";
      ignoreMap[it.idx] = it.ignore || "";
      if (it.poseStyle) poseStyleMap[it.idx] = it.poseStyle;
    }
    buildUsechks(usechks, dynDesc, checkedIdxs, descMap, ignoreMap, poseStyleMap, isEdit ? cropRow : null, syncKindFromUsage);
    renderRowsBar();
  }
  // 批 1-T2: 用途推断 kind (1.0 :810 口径) — 用户未手改 kind 下拉时跟随勾选用途自动切
  //   值域 = 1.3 的 character|scene（core/assets_api.js inferKindFromUsage）；null 不覆盖现有 kind。
  function collectAllCheckedIds() {
    const ids = [];
    mediaRows.forEach((r, i) => {
      if (i === curRowIdx) {
        // 当前行以 DOM 勾选态为准（勾选尚未回写 items）
        usechks.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => {
          const u = USAGE_CATALOG[Number(cb.dataset.idx)];
          if (u) ids.push(u.id);
        });
        return;
      }
      for (const it of r.items) {
        const u = USAGE_CATALOG[it.idx];
        if (u) ids.push(u.id);
      }
    });
    return ids;
  }
  function syncKindFromUsage() {
    if (kindTouched) return;
    const inferred = inferKindFromUsage(collectAllCheckedIds());
    if (inferred) kindSel.value = inferred;
  }
  // 批 1-T1: 手编行号/槽号 → expandUsageRows 第 3 参（脏值守卫 + 值域校验 · 拦截即不发请求）
  //   未手改（*Touched=false）→ 不传覆盖值，行内按源行保真回写 / 自动编号
  function rowMetaFor(r) {
    const kinds = r.items.map((it) => (USAGE_CATALOG[it.idx] || {}).kind);
    const meta = {};
    if (r.slotTouched) {
      const g = normalizeSlot(r.slot, kinds);
      if (!g.ok) {
        return {
          ok: false,
          msg: g.reason === "out_of_range"
            ? t("assets.edit.slotRange", { slot: String(r.slot).trim(), kind: g.kind, max: g.max })
            : t("assets.edit.slotInt"),
        };
      }
      meta.slot = g.slot;
    }
    if (r.idxTouched) {
      const raw = String(r.idx == null ? "" : r.idx).trim();
      if (raw) {
        if (!/^[0-9]+$/.test(raw) || parseInt(raw, 10) < 1) {
          return { ok: false, msg: t("assets.edit.idxInt") };
        }
        meta.idx = parseInt(raw, 10);
      }
    }
    return { ok: true, value: meta };
  }
  function renderRowsBar() {
    clearChildren(rowsBar);
    mediaRows.forEach((row, i) => {
      const line = el("div", { class: "mrow-item" + (i === curRowIdx ? " cur" : "") });
      const thumb = el("span", { class: "mrow-thumb" });
      if (row.media) {
        thumb.style.backgroundImage = `url("${mediaUrl("thumb", assetThumbPath(row.media), { maxSize: 64 })}")`;   // 批 B #13
        wireBgMediaFallback(thumb, "thumb", assetThumbPath(row.media), { maxSize: 64 });
        // F34 修正笔: 行条缩略图点击 = 灯箱看该行原图（stopPropagation 不切行·每行可看）
        thumb.title = t("assets.viewOrig");
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          if (row.media) openLightbox(row.media);
        });
      }
      line.appendChild(el("span", { class: "mrow-no", text: String(i + 1) }));
      line.appendChild(thumb);
      const path = el("span", { class: "mrow-path-txt", text: row.media || t("assets.edit.emptyRow") });
      path.title = row.media || "";
      line.appendChild(path);
      line.appendChild(el("span", { class: "mrow-badges", text: row.items.length ? t("assets.edit.useCount", { n: row.items.length }) : t("assets.edit.noUsage") }));
      // 批 10-H-T1 规则⑤: 删「仅剩一行不给删」守卫——最后一张图也可删（删空后保存走确认删卡）
      const del = el("span", { class: "mrow-del", text: "×", title: t("assets.edit.delRowT") });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        mediaRows.splice(i, 1);
        selectRow(Math.min(curRowIdx >= i ? curRowIdx - 1 : curRowIdx, mediaRows.length - 1));
      });
      line.appendChild(del);
      line.addEventListener("click", () => selectRow(i));
      rowsBar.appendChild(line);
    });
    // F66: 断槽行展示（断槽徽标·不可选中）+ 批 10-H-T1 规则⑤: 断槽行也可删（摘 dormant 分离键）
    for (const m of dormantRowsNow()) {
      const line = el("div", { class: "mrow-item dormant", title: t("assets.edit.dormantT") });
      const thumb = el("span", { class: "mrow-thumb", title: t("assets.viewOrigDormant") });
      thumb.style.backgroundImage = `url("${mediaUrl("thumb", assetThumbPath(m), { maxSize: 64 })}")`;   // 批 B #13
      wireBgMediaFallback(thumb, "thumb", assetThumbPath(m), { maxSize: 64 });
      thumb.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(m); });
      line.appendChild(el("span", { class: "mrow-no", text: t("assets.edit.dormantBadge") }));
      line.appendChild(thumb);
      const path = el("span", { class: "mrow-path-txt", text: m });
      path.title = m;
      line.appendChild(path);
      line.appendChild(el("span", { class: "mrow-badges", text: t("assets.edit.dormantTag") }));
      const ddel = el("span", { class: "mrow-del", text: "×", title: t("assets.edit.delDormantT") });
      ddel.addEventListener("click", (e) => {
        e.stopPropagation();
        dormantRemove(safeStorage(), name, m);
        const at = dormantMedias.indexOf(m);
        if (at >= 0) dormantMedias.splice(at, 1);
        renderRowsBar();
      });
      line.appendChild(ddel);
      // F76: 断槽行「接回」钮——恢复接槽通道但零数据层改动：该 media 以可编辑行入 mediaRows
      //   + 摘断槽分离键，走既有「选用途→保存→expandUsageRows」链自动回引擎 rows。
      //   边界（toast 已警示）：接回后取消编辑不保存 = 键已摘、行未存 → 图从卡片消失。
      const back = document.createElement("button");
      back.className = "mrow-back";
      back.textContent = t("assets.edit.rejoin");
      back.title = t("assets.edit.rejoinT");
      back.onclick = () => {
        const row = newMediaRow();
        row.media = m;
        mediaRows.push(row);
        dormantRemove(safeStorage(), name, m);
        const at = dormantMedias.indexOf(m);
        if (at >= 0) dormantMedias.splice(at, 1);
        renderRowsBar();
        selectRow(mediaRows.indexOf(row));
        showToast("info", t("assets.edit.rejoinedToast"));
      };
      line.appendChild(back);
      rowsBar.appendChild(line);
    }
  }
  selectRow(0);

  // ---- 备注 ----
  const memoInput = el("input", { type: "text", placeholder: t("assets.edit.memoPh"), value: card && typeof card.memo === "string" ? card.memo : "" });
  memoInput.style.cssText = "width:100%;padding:7px 10px;font-size:13px;outline:none";
  const secMemo = el("div", { class: "am-sec" });
  secMemo.appendChild(el("div", { class: "am-cap" }, [
    el("span", { text: t("assets.edit.secMemo") }),
    // 批 R4.6 · D29 (v43 :1924): inh 补「逗号分隔 · 」前缀，与备注 placeholder 呼应
    el("span", { class: "inh", text: t("assets.edit.secMemoHint"), style: "margin-left:auto;letter-spacing:0" }),
  ]));
  secMemo.appendChild(memoInput);

  const content = el("div");
  content.appendChild(secBase);
  content.appendChild(secMedia);
  content.appendChild(secMemo);

  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const saveBtn = el("button", { type: "button", class: "prim", text: t("settings.btn.save") });
  // 走查反馈 F12（老板「已有资产的三视图入口没有」——卡 hover op 早在（J13 裁决补回）但藏
  //   hover 里难发现）：编辑弹窗常显入口（hover op 与顶栏入口保留）；批 2-T4 F-77 起 = 直提出图（见下方 click）
  const povBtn = isEdit ? el("button", { type: "button", class: "ghostbtn", text: t("assets.top.gen") }) : null;
  // 批 3-T3 F8 词库助手（原批 0-T5 占位转正）：插入目标 = 聚焦的提示词框（.dyn-desc 内
  //   textarea）· 无聚焦兜底首条；忽略词框（input·顿号分隔负面词表）语义不匹配 → 有意不挂。
  //   面板挂 .dyn-desc（宿主随其销毁：切行重建/关弹窗即清）。
  const lexBtn = el("button", { type: "button", class: "ghostbtn", text: t("assets.edit.lex"), title: t("assets.edit.lexT") });
  // 真机点击 button 会把焦点抢走（Chrome）→ 预阻 mousedown 保提示词框焦点，插入目标不漂
  lexBtn.addEventListener("mousedown", (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); });
  lexBtn.addEventListener("click", () => {
    const active = (typeof document !== "undefined" && document) ? document.activeElement : null;
    const target = resolveVocabTarget(dynDesc, active);
    if (!target) return; // 无提示词框 / 聚焦忽略词框 → 不开
    // F49：同宿主再点「词库」→ 收起（toggle）；宿主仍是 dynDesc，迁移语义不变
    toggleVocabPanel({ host: dynDesc, onInsert: (word) => appendVocabWord(target, word) });
  });
  const footerBtns = [cancelBtn];
  if (povBtn) footerBtns.push(povBtn);
  footerBtns.push(lexBtn);
  footerBtns.push(saveBtn);
  const inst = openModal({
    title: isEdit ? t("assets.edit.titleEdit", { name }) : t("assets.edit.titleNew"),
    sub: t("assets.edit.sub"),
    contentNode: content,
    footerButtons: footerBtns,
  });
  cancelBtn.addEventListener("click", () => inst.close());
  if (povBtn) {
    // 批 2-T4 F-77（老板定版 2026-10-03 · 档位一解耦）: footer 钮 = 直提（directThreepov）——
    //   不开弹窗，按整卡生成（批10 T3：引擎读卡拼图+描述词+忽略词）。弹窗保留为手动高级入口
    //   （可改图源/参数/给法）。先关本弹窗的理由同下方裁剪钮：mediaRows 是打开时快照，
    //   留驻会与后续保存链打架。
    povBtn.title = t("assets.edit.povBtnT");
    povBtn.addEventListener("click", () => {
      inst.close();
      void directThreepov(name);
    });
  }

  // E005/E006: 用途复选构建已随 selectRow(0) 按行重建（F32 媒体行区）

  saveBtn.addEventListener("click", async () => {
    const newName = nameInput.value;
    const v = validateAssetName(newName);
    if (!v.ok) {
      showToast("error", {
        empty: t("assets.edit.nameEmpty"),
        too_long: t("assets.edit.nameTooLong"),
        invalid_char: t("assets.edit.nameInvalid"),
      }[v.reason]);
      return;
    }
    // F32: 多行保存——先把当前行勾选/描述写回，再逐行展开拼接（GUI1.0 expandFormRows 等价）
    flushCurrentRow();
    // 批 10-H-T1 规则④: 有图未勾用途的行不再拦保存——该 media 落断槽分离键（引擎 v3 usage 必填·无用途行 400）
    //   勾了用途的行照旧 expandUsageRows 进引擎 rows（口径与 F66 断槽通道同源）
    const liveRows = mediaRows.filter((r) => r.media.trim() || r.items.length);
    const rows = [];
    const noUseMedias = [];
    for (const r of liveRows) {
      const m = String(r.media || "").trim();
      if (!r.items.length) {
        if (m) noUseMedias.push(r.media);
        continue;
      }
      const meta = rowMetaFor(r);
      if (!meta.ok) { showToast("error", meta.msg); return; }
      for (const row of expandUsageRows(r.media, r.items, meta.value)) rows.push(row);
    }
    if (!rows.length) {
      // 引擎 v3 不收空 rows 卡（2026-10-02 探针 400）——编辑态零图 = 白话确认后整卡删除（规则⑤）
      if (!isEdit) {
        showToast("error", t("assets.edit.needImage"));
        return;
      }
      openConfirm({
        title: t("assets.edit.delSaveTitle"),
        sub: t("assets.edit.delSaveSub"),
        confirmText: t("assets.edit.delSaveOk"),
        danger: true,
        onConfirm: () => { void deleteCardOnEmptySave(name); },
      });
      return;
    }
    commitTagsInput(); // 未触发回车/失切的尾输入一并落 chip（保存 = chip 拼接）
    // #39 T3 触点①（方案 I4）: kind 下拉是展示三值——保存映射 item→character（引擎白名单
    //   character|scene·D4 红线）；卡上无「道具多角度」行则补一行空行（T2 场景采用追加行同形状·
    //   引擎空 media 行不 400·方案审已核）保证重开回显仍「道具」（round-trip 自洽）。
    //   选 character/scene 不删行（道具行原样保留）。
    let saveKind = kindSel.value === "scene" ? "scene" : "character";
    let saveRows = rows;
    if (kindSel.value === "item" && !rows.some((r) => r && r.usage === "道具多角度")) {
      const picRows = rows.filter((r) => {
        if (!r) return false;
        const u = USAGE_CATALOG.find((c) => c.id === r.usage);
        return !u || u.kind === "Picture"; // 非视频/音频行均占 Picture 槽位（povApprove scene 分派同口径）
      });
      const nextSlot = picRows.reduce((m, r) => Math.max(m, parseInt(r.slot, 10) || 0), 0) + 1;
      saveRows = rows.concat([{ usage: "道具多角度", media: "", slot: String(nextSlot), desc: "", ignore_words: "" }]);
    }
    // 批 1-F4 卡级 round-trip: 旧卡为底 + 表单字段覆写 —— 卡上未知键（旧版 slots/desc/slot_map/探针键）不丢
    const newCard = Object.assign({}, isEdit ? card : {}, {
      _v: 3,
      kind: saveKind,
      rows: saveRows,
      tags: normalizeTags(tagList),
      memo: memoInput.value,
    });
    // 走查修复（2026-09-27 老板报：改名保存后多出一个）：改名 = 撞名预检 + 存新卡 + @N 迁移 + 删旧卡
    const renamed = isEdit && newName !== name;
    if (renamed && S.assets && S.assets[newName]) {
      showToast("error", t("assets.edit.renameClash", { name: newName }));
      return;
    }
    const r = await saveCard(newName, newCard);
    if (!r.ok) {
      showToast("error", t("assets.saveFail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
      return; // 弹窗留驻 — 修正后重试
    }
    if (renamed) {
      // @N 迁移：旧名占的编号转给新名（分镜提示词里 @N 引用不断链）；旧名未注册过 → 新名走分配
      const rebind = rebindRegistryName(safeStorage(), name, newName);
      if (!rebind) assignRegistryN(safeStorage(), newName);
      // 删旧卡（先存后删：删失败仅残留可手动清，不丢数据）
      const d = await deleteCard(name);
      if (!d.ok) showToast("warn", t("assets.edit.oldDelFail", { name }));
      // 批 10-H-T1b: 旧卡真删掉才清它的断槽分离键（删失败旧卡仍在·断槽仍有主；
      //   不清则旧名断槽残留成孤儿——同名新卡建起来会捡到旧断槽）
      // 批 10-L L1-5（F78）：旧名真删掉才把序表位次让给新名（删失败旧卡仍在·
      //   位次须留给旧名·新名下次渲染按首见追加）→ 改名不重排
      else { dormantClear(safeStorage(), name); renameInOrder(name, newName, safeStorage()); }
    } else {
      // S2-1 T2 注册表接线（详案任务 0）：保存成功后为该卡绑 @N
      //   assignRegistryN：已绑则原样返回；新卡 → 分配最小空闲 n（跳 9，a4 保留槽）
      //   失败静默 — 注册表写不进去不阻塞主流程（@ 联想降级为空，详见 prompt.js 读取容错）
      assignRegistryN(safeStorage(), newName);
    }
    // 批 10-H-T1 规则④: 无用途 media 落断槽分离键（引擎 rows 外·同 F66 通道；写失败静默同 dormantAdd）
    for (const m of noUseMedias) dormantAdd(safeStorage(), newName, m);
    inst.close();
    showToast("success", renamed ? t("assets.edit.renamedSaved", { name: newName }) : t("assets.edit.saved", { name: newName }));
    void invalidateAssetsCache();   // 任务C #55：保存成功 → prompt 缓存失效重拉广播（画布已有资产节点同步新图）
    refresh();
  });

  // 批 10-H-T1 规则⑤: 零图保存确认后整卡删除
  // 批 10-H-T1b: 改走 cardTrashDelete（与卡面「删除」op 同口径）——零图卡也进回收站·老板可恢复；同清断槽分离键
  async function deleteCardOnEmptySave(cardName) {
    const r = await cardTrashDelete(cardName);
    if (r.unmounted) return; // 已卸载
    if (!r.ok) {
      showToast("error", deleteErrMsg(r.error));
      return;
    }
    dormantClear(safeStorage(), cardName);
    inst.close();
    showToast("success", t("assets.edit.emptyDeleted", { name: cardName }));
    refresh();
  }
}

// S3-2 T7 媒体行缩略框重渲染 (v43 :552 .mthumb 形态):
//   空路径 → 「无媒体」占位；非空 → <img> 走引擎 thumb 通道（相对路径补 input/ 前缀 = assetThumbPath）；
//   加载失败（error）→ 「预览加载失败」占位。失败标记在每次重渲染前复位。
function renderMediaPreview(box, media) {
  clearChildren(box);
  box.classList.remove("mthumb-fail");
  const s = typeof media === "string" ? media.trim() : "";
  if (!s) {
    box.appendChild(el("span", { text: t("assets.edit.noMedia") }));
    return;
  }
  const img = el("img", {
    class: "mthumb-img",
    src: mediaUrl("thumb", assetThumbPath(s), { maxSize: 512 }),   // 批 B #13：URL 收敛单源（失败态走既有 mthumb-fail 兜底）
    alt: s,
    title: s,
  });
  img.addEventListener("error", () => {
    if (box.firstChild !== img) return; // 期间路径已改 → 丢弃迟到的失败事件
    clearChildren(box);
    box.classList.add("mthumb-fail");
    box.appendChild(el("span", { text: t("assets.edit.previewFail") }));
  });
  box.appendChild(img);
}

// E005/E006: 用途复选 (v43 :2804-2857 移植 · kind 锁定纯逻辑 = nextKindLock/isKindLockedOut)
// S2-1 T2 a2：姿势行携带样式二选一（骨架/深度·默认骨架·a6 兜底）
// S2-1 T2 a6：姿势行 title 永久三边界（i2v 槽·检测不到人·旧 CSV）
function buildUsechks(container, descContainer, checkedIdxs, descMap, ignoreMap, poseStyleMap, cropRow, onUsageChange) {
  clearChildren(container);
  container.dataset.kindLocked = "";
  clearChildren(descContainer);
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  USAGE_CATALOG.forEach((u, i) => {
    const lab = el("label", { class: "usechk" });
    lab.dataset.kind = u.kind;
    lab.dataset.idx = String(i);
    if (u.id === "pose") lab.classList.add("usechk-pose");
    const inp = el("input", { type: "checkbox" });
    inp.dataset.idx = String(i);
    if (checkedIdxs.includes(i)) inp.checked = true;
    inp.addEventListener("change", () => onUsechkChange(container, descContainer, inp, cropRow, onUsageChange));
    lab.appendChild(inp);
    lab.appendChild(document.createTextNode(pickDisplay("usageLabel", u.label)));
    // a2：姿势行内嵌样式二选切换（默认隐藏·勾上才出）
    if (u.id === "pose") {
      // a6 边界文案（姿势行恒显示·与互斥 title 分层）
      lab.title = t("assets.use.poseTitle");
      const styleWrap = el("div", { class: "pose-style", style: "display:none;margin:4px 0 0 22px;font-size:11px;color:var(--txt3);align-items:center;gap:6px" });
      const curStyle = (poseStyleMap && (poseStyleMap[i] === "depth" || poseStyleMap[i] === "skeleton"))
        ? poseStyleMap[i]
        : "skeleton"; // a6 兜底：旧 CSV / 新建无 pose_style → 骨架
      lab.dataset.poseStyle = curStyle;
      for (const v of POSE_STYLE_IDS) {
        const rl = el("label", { style: "display:inline-flex;align-items:center;gap:3px;cursor:pointer;margin-right:4px" });
        const r = el("input", { type: "radio", name: `poseStyle-${container.dataset.scope || "default"}`, value: v });
        if (curStyle === v) r.checked = true;
        r.addEventListener("change", () => {
          if (r.checked) lab.dataset.poseStyle = v;
        });
        rl.appendChild(r);
        rl.appendChild(document.createTextNode(v === "skeleton" ? t("assets.use.skeleton") : t("assets.use.depth")));
        styleWrap.appendChild(rl);
      }
      // 勾上则显示样式切换
      if (checkedIdxs.includes(i)) styleWrap.style.display = "flex";
      lab.appendChild(styleWrap);
    }
    container.appendChild(lab);
  });
  // v26 修正 (v43 :2818-2821): 初始勾选也要定 kind 锁 — 此前初态绕过 change 事件导致无锁
  const kinds = checkedIdxs.map((i) => USAGE_CATALOG[i].kind);
  container.dataset.kindLocked = nextKindLock("", kinds);
  refreshKindLock(container, cropRow);
  // S2-1 T2 a3：行级互斥（初始勾选含姿势 → 同步清出其他 Picture 用途·带描述框移除）
  refreshRowMutex(container, descContainer);
  // v29/v30: 初始勾选逐项出描述框 (带既有 desc/ignore 回填)
  //   A 审修正笔 F2b: 按【互斥后仍勾选】的有效集补框——防"勾被互斥清掉、框残留"孤儿
  const effectiveIdxs = [...container.querySelectorAll("input[type=checkbox]:checked")]
    .map((x) => Number(x.dataset.idx));
  effectiveIdxs.forEach((i) => addDynDesc(descContainer, i, descMap[i] || "", ignoreMap[i] || ""));
}

function onUsechkChange(container, descContainer, input, cropRow, onUsageChange) {
  const idx = Number(input.dataset.idx);
  // S2-1 T2 a2：姿势勾上 → 显示样式切换；取消 → 隐藏
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  if (idx === POSE_IDX) {
    const lab = container.querySelector(`.usechk[data-idx="${POSE_IDX}"]`);
    const styleWrap = lab ? lab.querySelector(".pose-style") : null;
    if (styleWrap) styleWrap.style.display = input.checked ? "flex" : "none";
  }
  if (input.checked) {
    addDynDesc(descContainer, idx, "", ""); // v29 修复口径: 勾选 = 出现对应描述框
  } else {
    addDynDesc(descContainer, idx, null, null); // 取消 = 删
  }
  // 锁定重算 (v43 :2832-2841 同语义 · 纯函数化): locked 仍在勾选集 → 保持; 否则余项首 kind
  const kinds = [];
  container.querySelectorAll("input[type=checkbox]:checked").forEach((x) => {
    kinds.push(USAGE_CATALOG[Number(x.dataset.idx)].kind);
  });
  container.dataset.kindLocked = nextKindLock(container.dataset.kindLocked, kinds);
  refreshKindLock(container, cropRow);
  // S2-1 T2 a3（A 审修正笔 F2）：互斥刷新必须排在 refreshKindLock 之后——
  //   原次序下 kindLock 无条件覆写 title/disabled，互斥置灰与 a6 文案交互后即失效
  refreshRowMutex(container, descContainer);
  // 批 1-T2: 勾选变化后按用途推断 kind（互斥清出之后收口，勾态已定）
  if (typeof onUsageChange === "function") onUsageChange();
}

// S2-1 T2 a3 行级互斥 UI：勾姿势 → 同行其他 Picture 用途清出 + 描述框移除 + 复选置灰
//   纯逻辑走 core/assets_api.js applyRowMutex；本函数负责把纯结果映射到 DOM
//   走查反馈 F51：单勾姿势那一下无项被清（mutexApplied=false）也要立即置灰——
//   改按 hasPose 进互斥态（姿势已勾即置灰·取消勾姿势走下方解锁分支恢复可勾）
function refreshRowMutex(container, descContainer) {
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  // 收当前勾选态（DOM 真值）
  const cur = [];
  container.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => {
    cur.push({ idx: Number(cb.dataset.idx) });
  });
  const { checked: after, hasPose } = applyRowMutex(cur);
  if (!hasPose) {
    // 无姿势：把此前可能被 mutex 锁的项解锁（保留 kind 锁状态由 refreshKindLock 处理）
    container.querySelectorAll(".usechk").forEach((lab) => {
      const idx = Number(lab.dataset.idx);
      if (idx === POSE_IDX) return;
      lab.classList.remove("pose-mutex");
      // 不覆盖 kind-lock 的 disabled —— 由 refreshKindLock 处理
    });
    return;
  }
  // 有姿势即互斥态（F51：单勾那一下就置灰）；真有项被清时 after 已剔其他 Picture 勾——
  //   此处对 keep 之外的行：取消残留勾 + 删描述框 + 置灰 + title
  const keep = new Set(after.map((c) => c.idx));
  container.querySelectorAll(".usechk").forEach((lab) => {
    const idx = Number(lab.dataset.idx);
    const cb = lab.querySelector("input[type=checkbox]");
    if (idx === POSE_IDX) {
      // 姿势行保持解锁（互斥源）
      lab.classList.remove("pose-mutex");
      if (cb) cb.disabled = false;
      return;
    }
    if (!keep.has(idx)) {
      // 之前可能因互斥被勾上 → 取消
      if (cb && cb.checked) {
        cb.checked = false;
        // 同步删除对应描述框
        const oldRow = descContainer ? descContainer.querySelector(`[data-idx="${idx}"]`) : null;
        if (oldRow) oldRow.remove();
      }
      lab.classList.add("pose-mutex");
      lab.title = t("assets.use.mutex");
      if (cb) cb.disabled = true;
    } else {
      lab.classList.remove("pose-mutex");
      // title 恢复归 refreshKindLock（a6 文案在其内对姿势行保留——复审探针实证 else 分支不可达已删）
    }
  });
}

// cropRow（S3-2 T6 媒体行「裁剪」行）: 仅图片类出——锁定 kind = Picture 才显示（E006 口径）
function refreshKindLock(container, cropRow) {
  const locked = container.dataset.kindLocked || "";
  if (cropRow) cropRow.style.display = locked === "Picture" ? "" : "none";
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  container.querySelectorAll(".usechk").forEach((lab) => {
    const isLocked = isKindLockedOut(lab.dataset.kind, locked);
    lab.classList.toggle("locked", isLocked);
    // S2-1 修正笔②（复审探针实证）：姿势行 title=a6 三边界文案在此保留——
    //   原 :529 无条件清 title 是 a6 不可见的根因；姿势行不受 kind 锁（Picture 恒 false）
    const isPoseRow = Number(lab.dataset.idx) === POSE_IDX;
    lab.title = isLocked ? t("assets.use.locked")
      : (isPoseRow ? t("assets.use.poseTitle") : "");
    const inp = lab.querySelector("input");
    if (inp) inp.disabled = isLocked; // v26 修正: 锁定要真禁用, 不能只变灰
  });
}

// v30 口径: 每个用途描述框带忽略词行; 与勾选同生共死 (val=null 即删)
// A4/A6 快批⑥: ① 行序 = USAGE_CATALOG 原序（勾选先后不定 → 按目录下标插到位，不追点选序）
//               ② 行组 = .lbl 定宽标签列 + .dd-body（描述框 → 忽略词子行 .dd-ig 缩进从属·输入框到行尾）
function addDynDesc(descContainer, idx, val, ignoreVal) {
  const old = descContainer.querySelector(`[data-idx="${idx}"]`);
  if (val === null) {
    if (old) old.remove();
    return;
  }
  if (old) old.remove(); // 重开弹窗回填时去旧建新
  const u = USAGE_CATALOG[idx];
  const row = el("div", { class: "dd-row" });
  row.dataset.idx = String(idx);
  const ta = el("textarea", { rows: "3", placeholder: t("assets.use.descPh", {
    label: pickDisplay("usageLabel", u.label),
    tip: u.label.indexOf("三视图") >= 0 ? t("assets.use.descTipPov") : t("assets.use.descTipGeneric"),
  }) });
  ta.value = val || "";
  const ig = el("textarea", { placeholder: t("assets.use.igPh") });
  ig.value = ignoreVal || "";
  // 走查反馈 F16（老板「提示词忽略词在新的一行·输入框过短」·截图定谳）：原「左定宽标签列 +
  //   右行组」结构输入框只占行宽 ~60%——改纵向：用途标签独立一行，提示词/忽略词在其下占满全宽
  const body = el("div", { class: "dd-body" });
  const descRow = el("div", { class: "dd-main" });
  descRow.appendChild(el("span", { class: "ig-lbl desc-lbl", text: t("assets.use.promptLbl") }));
  descRow.appendChild(ta);
  body.appendChild(descRow);
  const igRow = el("div", { class: "dd-ig" });
  igRow.appendChild(el("span", { class: "ig-lbl", text: t("assets.use.igLbl") }));
  igRow.appendChild(ig);
  body.appendChild(igRow);
  row.appendChild(el("div", { class: "dd-lblrow", text: pickDisplay("usageLabel", u.label) }));
  row.appendChild(body);
  // 插入到位：目录序（idx 递增）——勾选先后不改变行序
  const next = Array.from(descContainer.querySelectorAll(".dd-row")).find((r) => Number(r.dataset.idx) > idx);
  if (next) descContainer.insertBefore(row, next);
  else descContainer.appendChild(row);
}

// 勾选态收集 (弹窗保存用): [{idx, desc, ignore, poseStyle?}]
// S2-1 T2 a2：姿势行携带选中样式（默认骨架·a6 兜底）传给 expandUsageRows 落 pose_style 字段
function collectChecked(usechks, descContainer) {
  const out = [];
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  usechks.querySelectorAll("input[type=checkbox]:checked").forEach((inp) => {
    const idx = Number(inp.dataset.idx);
    const row = descContainer.querySelector(`[data-idx="${idx}"]`);
    const ta = row ? row.querySelector("textarea") : null;
    // F50: 忽略词已改 textarea（自动换行）——按 .dd-ig 子行定位，.value 读写链不变
    const igRow = row ? row.querySelector(".dd-ig") : null;
    const ig = igRow ? igRow.querySelector("textarea") : null;
    const item = {
      idx,
      desc: ta ? ta.value : "",
      ignore: ig ? ig.value : "",
    };
    if (idx === POSE_IDX) {
      const poseLab = usechks.querySelector(`.usechk[data-idx="${POSE_IDX}"]`);
      const radioChecked = poseLab
        ? poseLab.querySelector("input[type=radio]:checked")
        : null;
      const styleVal = radioChecked ? radioChecked.value : (poseLab && poseLab.dataset.poseStyle) || "skeleton";
      item.poseStyle = (styleVal === "depth" || styleVal === "skeleton") ? styleVal : "skeleton";
    }
    out.push(item);
  });
  return out;
}

// ============================================================================
// E031 — 资产编辑弹窗图片裁剪 (v43 v26⑫ 全手势复刻)
//   原型锚: :136-145 (裁剪弹窗 CSS) / :1906 (媒体行「裁剪」入口) / :2377-2391 (#cropmodal 结构)
//           / :3015-3026 (open/close/confirm/ESC)
//   手势清单 (逐项对齐 v26⑫ 原文):
//     ① 全屏遮罩弹窗·图居中 (.crop-stage)  ② 中央 80% 白色虚线框 (初值 10/10/80/80)
//     ③ 四角手柄拖角改框                    ④ 框内拖动 = 整体平移
//     ⑤ 右下 .h-se 向外拉伸                  ⑥ 双击框内 / 「确认裁剪」= 确认
//     ⑦ ESC / 点遮罩空白 / 「取消」= 取消（零副作用）
//   产物链: canvas 裁剪 → toBlob → /upload/image (multipart) → 同名覆写原卡（裁剪图接管原图槽位·
//           原图保留断槽——F66 老板定版「不建新卡」）
//   框几何纯逻辑 (百分比框 → 像素矩形) 走 core/assets_api.js；本节只做 DOM 编排。
// ============================================================================

function openCropModal(cardName, media, card) {
  if (typeof document === "undefined") return;
  if (!media) { showToast("error", t("assets.crop.noPath")); return; }
  if (!card) { showToast("error", t("assets.crop.needEdit")); return; }

  const root = el("div", { class: "crop-modal", role: "dialog", "aria-modal": "true" });
  // 图纸 = thumb 通道消费媒体路径（相对路径补 input/ 前缀见 assetThumbPath；同源静态页加载·canvas 不 taint）
  const img = document.createElement("img");
  img.className = "crop-img";
  img.crossOrigin = "anonymous";
  img.src = mediaUrl("thumb", assetThumbPath(media), { maxSize: 2048 });   // 批 B #13：URL 收敛单源
  const stage = el("div", { class: "crop-stage" });
  stage.appendChild(img);
  // J-P15 老板报障「裁剪尺寸好像写死了·怎么拖都是细长条」：框百分比按舞台算、裁剪按原图像素换算，
  //   两者同源须舞台盒 ≡ 图显示盒。图加载后把舞台收成原图等比内接盒（.crop-stage 定尺作可视上限，
  //   object-fit:contain 的黑边随之消失——所见框形 = 所裁形态）。
  img.addEventListener("load", () => {
    const r = stage.getBoundingClientRect();
    const sz = cropStageSize(img.naturalWidth, img.naturalHeight, r.width, r.height);
    if (!sz.w || !sz.h) return;              // 图未就绪 → 留 CSS 原盒（确认链另有 not-loaded 提示）
    stage.style.width = `${sz.w}px`;
    stage.style.height = `${sz.h}px`;
  });

  let frame = initialCropFrame();
  const frameNode = el("div", { class: "crop-frame" });
  applyCropFrame(frameNode, frame);
  for (const corner of ["tl", "tr", "bl", "br"]) {
    const handle = el("div", { class: `handle h-${corner}` });
    handle.addEventListener("mousedown", (e) => {
      if (e && e.stopPropagation) e.stopPropagation(); // 手柄命中优先于框内平移
      startCropDrag("resize", corner, e);
    });
    frameNode.appendChild(handle);
  }
  // 右下大号拉伸柄（v43 .h-se ⇲）：与 br 同语义·命中区更大
  const se = el("div", { class: "handle h-se", text: "⇲" });
  se.addEventListener("mousedown", (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    startCropDrag("resize", "se", e);
  });
  frameNode.appendChild(se);
  frameNode.addEventListener("mousedown", (e) => startCropDrag("move", null, e));
  frameNode.addEventListener("dblclick", () => confirmCrop());
  stage.appendChild(frameNode);

  root.appendChild(el("div", {
    class: "crop-hint",
    text: t("assets.crop.hint"),
  }));
  root.appendChild(stage);

  const foot = el("div", { class: "crop-foot" });
  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const confirmBtn = el("button", { type: "button", class: "prim", text: t("assets.crop.confirm") });
  foot.appendChild(cancelBtn);
  foot.appendChild(confirmBtn);
  root.appendChild(foot);

  function close() {
    if (root.parentNode) root.parentNode.removeChild(root);
    document.removeEventListener("keydown", onKey, true);
  }
  // ESC = 取消：capture 阶段拦下并阻断冒泡，避免连带关掉下层资产编辑弹窗（取消 = 零副作用）
  function onKey(e) {
    if (!e || e.key !== "Escape") return;
    if (e.stopPropagation) e.stopPropagation();
    close();
  }
  document.addEventListener("keydown", onKey, true);
  // 点遮罩空白 = 取消（点图纸/框内 target 非遮罩本体 → 不关）
  // F72：判 mousedown（按下点）非 click——框内按下+遮罩松开时 click 落共同祖先会误判外点
  root.addEventListener("mousedown", (e) => { if (e && e.target === root) close(); });
  cancelBtn.addEventListener("click", () => close());
  confirmBtn.addEventListener("click", () => confirmCrop());

  // 拖拽：像素位移 → 舞台百分比增量（框几何纯逻辑走 moveCropFrame/resizeCropFrame）
  function startCropDrag(mode, corner, e) {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startFrame = { ...frame };
    const onMove = (ev) => {
      // 舞台尺寸为 0（未布局/隐藏）时位移按 0 计，框不动
      const dLeft = rect.width ? ((ev.clientX - startX) / rect.width) * 100 : 0;
      const dTop = rect.height ? ((ev.clientY - startY) / rect.height) * 100 : 0;
      frame = mode === "move"
        ? moveCropFrame(startFrame, dLeft, dTop)
        : resizeCropFrame(startFrame, corner, dLeft, dTop);
      applyCropFrame(frameNode, frame);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // 确认链路：canvas 裁剪 → /upload/image → 同名覆写原卡（裁剪图接管原图槽位）→ 原图登记断槽
  //   F66 老板定版「不建新卡」：凡原图绑定行 media 换裁剪产物（usage/slot/desc/ignore_words/pose_style
  //   等全继承）·原图行不再发引擎（引擎 v3 契约无断槽表达·探针实证 400）——原图落 dormant 分离键
  async function confirmCrop() {
    close();
    const natW = Number(img.naturalWidth) || 0;
    const natH = Number(img.naturalHeight) || 0;
    if (!natW || !natH) {
      showToast("error", t("assets.crop.notLoaded"));
      return;
    }
    const rect = cropParamsFromFrame(frame, natW, natH);
    try {
      const blob = await cropImageToBlob({ img, canvas: document.createElement("canvas"), rect });
      const ts = cropStamp();
      const up = await uploadImage(buildUploadFormData(blob, `crop_${ts}.png`, CROP_MEDIA_ROOT));
      if (!up || !up.name) throw new Error(t("assets.up.noName"));
      const mediaPath = CROP_MEDIA_ROOT + up.name;
      const rows = Array.isArray(card.rows) ? card.rows : [];
      const sr = await saveCard(cardName, {
        ...card,
        rows: rows.map((r) => (r && typeof r === "object" && r.media === media ? { ...r, media: mediaPath } : r)),
      });
      if (!sr.ok) throw new Error(t("assets.crop.saveFail", { reason: (sr.error && (sr.error.msg || sr.error.code)) || t("settings.err.unknown") }));
      dormantAdd(safeStorage(), cardName, media);
      showToast("success", t("assets.crop.done"));
      void invalidateAssetsCache();   // 任务C #55：裁剪成功 → prompt 缓存失效重拉广播（画布绑定节点同步新图）
      refresh();
    } catch (e) {
      showToast("error", t("assets.crop.fail", { reason: e && e.message ? e.message : String(e) }));
    }
  }

  document.body.appendChild(root);
}

// 框几何 → 行内样式（百分比口径·与 v43 .crop-frame 初值同源）
function applyCropFrame(frameNode, frame) {
  frameNode.style.left = `${frame.l}%`;
  frameNode.style.top = `${frame.t}%`;
  frameNode.style.width = `${frame.w}%`;
  frameNode.style.height = `${frame.h}%`;
}

// FormData 构造：image + subfolder + type=input + overwrite=true（概念环/裁剪/选择文件同款落库通道）
function buildUploadFormData(blob, fileName, subfolder) {
  const fd = new FormData();
  // 走查反馈 F35（老板报「选图报错·不支持 jfif」）：jfif 本质即 JPEG（JFIF 交换格式）——
  //   引擎 upload 扩展名校验不识 .jfif → 前端改名 .jpg 转传（字节不动·同宗格式）
  const safeName = String(fileName || "pick.png").replace(/\.jfif$/i, ".jpg");
  fd.append("image", blob, safeName);
  fd.append("subfolder", String(subfolder).replace(/\/$/, ""));
  fd.append("type", "input");
  fd.append("overwrite", "true");
  return fd;
}

// ============================================================================
// E003 — 导出弹窗: 2026-10-25 G 块摘除（引擎 api.md 无资产库 zip 导出端点, #41 ai_export
//   为 AI 协作快照导出非资产库——原 UI 占位 + 「示意」toast 属死控件；待引擎侧提供端点后重做真接）
// ============================================================================

// ============================================================================
// A2 快批⑥ — 导入资产库（.json 逐卡建卡 · .zip 登记提示）
//   格式 = 导出格式容器 {assets:{name:card}}（与引擎 #34 响应同构）+ 单条/数组容错
//   （解析漏斗走 core.parseAssetImport；本函数只做文件读 → 建卡 → 刷新编排）
// ============================================================================

async function importLibraryFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    showToast("error", t("assets.import.readFail", { reason: (e && e.message) || e }));
    return;
  }
  const r = parseAssetImport(text);
  if (!r.ok) {
    showToast(r.error.code === "zip_pending" ? "info" : "error", r.error.msg);
    return;
  }
  if (!r.cards.length) {
    showToast("info", r.skipped ? t("assets.import.noneSkipped", { n: r.skipped }) : t("assets.import.none"));
    return;
  }
  const existing = Object.keys((S && S.assets) || {});
  let done = 0;
  let overwritten = 0;
  let failed = 0;
  for (const entry of r.cards) {
    if (existing.includes(entry.name)) overwritten += 1;
    const sr = await saveCard(entry.name, entry.card);
    if (sr.ok) {
      done += 1;
      assignRegistryN(safeStorage(), entry.name);
    } else {
      failed += 1;
    }
  }
  if (!S) return; // 已卸载
  refresh();
  const parts = [t("assets.import.partDone", { n: done })];
  if (overwritten) parts.push(t("assets.import.partOverwrite", { n: overwritten }));
  if (failed) parts.push(t("assets.import.partFailed", { n: failed }));
  showToast(failed ? "error" : "success", t("assets.import.done", { parts: parts.join(" · "), name: file.name || t("assets.import.srcFallback") }));
}

// ============================================================================
// E007 — 删除 → 回收站 → 恢复
// ============================================================================

// 批 10-H-T1b: 删卡统一通道 —— 引擎删卡 + 删前卡副本缓存进回收站（软删缓存·可恢复）。
//   卡面「删除」op（assetDelete）与编辑弹窗零图保存删卡（deleteCardOnEmptySave）共用，避免口径分叉。
//   返回 {ok:true} = 已删且已入回收站；{ok:false, error} = 引擎删失败；{unmounted:true} = 视图已卸载（调用方收手不出 toast）。
async function cardTrashDelete(name) {
  const card = S && S.assets[name]; // 删除前捕获副本 — 回收站恢复用
  const r = await deleteCard(name);
  if (!S) return { ok: false, unmounted: true }; // 已卸载
  if (!r.ok) return { ok: false, error: r.error };
  trashAdd(safeStorage(), name, card || { name });
  return { ok: true };
}

// 删卡失败白话（引擎错误 msg 优先·退 code·再退兜底）
const deleteErrMsg = (e) => t("assets.delFail", { reason: (e && e.msg) || (e && e.code) || t("settings.err.unknown") });

async function assetDelete(name) {
  // v43 :3045-3057 双击确认 (3 秒窗) — 文案披露引擎侧为物理删除
  const now = Date.now();
  if (_delArm.name === name && now - _delArm.at < DEL_ARM_MS) {
    _delArm = { name: null, at: 0 };
    const r = await cardTrashDelete(name);
    if (r.unmounted) return; // 已卸载
    if (!r.ok) {
      showToast("error", deleteErrMsg(r.error));
      return;
    }
    showToast("success", t("assets.trash.moved", { name }));
    refresh();
  } else {
    _delArm = { name, at: now };
    showToast("info", t("assets.trash.armToast", { name }));
  }
}

function renderTrash() {
  if (!S) return;
  const wrap = S.trashWrap;
  clearChildren(wrap);
  const list = readTrash(safeStorage());
  if (!list.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const cap = el("div", { class: "am-cap" }, [
    el("span", { text: t("assets.trash.cap", { n: list.length }) }),
    el("span", { class: "inh", text: t("assets.trash.hint"), style: "margin-left:auto;letter-spacing:0" }),
  ]);
  // 批 3-T1 F5: 清空回收站（逐条 purge 引擎归档·双确认）
  const clearBtn = el("button", { type: "button", class: "fbtn", text: t("projects.recycle.clear") });
  clearBtn.addEventListener("click", () => confirmPurgeAll());
  cap.appendChild(clearBtn);
  wrap.appendChild(cap);
  for (const entry of list) {
    if (!entry || !entry.name) continue;
    const row = el("div", { class: "recycle-row" });
    row.appendChild(el("span", { class: "nm", text: entry.name }));
    row.appendChild(el("span", { class: "meta", text: t("assets.trash.deletedAt", { ts: entry.deletedAt || "—" }) }));
    const btn = el("button", { type: "button", class: "fbtn", text: t("projects.recycle.restore") });
    // 批 4-T1 ③: 清空循环期互斥——行内两钮禁用（防恢复/单删与逐条 purge 竞态）
    if (S.purgingAll) { btn.disabled = true; btn.title = t("assets.trash.purging"); }
    btn.addEventListener("click", () => restoreTrashEntry(entry.name));
    row.appendChild(btn);
    // 批 3-T1 F5: 彻底删除（引擎 #39 归档清理·双确认）
    const purgeBtn = el("button", { type: "button", class: "fbtn", text: t("projects.recycle.purge") });
    if (S.purgingAll) { purgeBtn.disabled = true; purgeBtn.title = t("assets.trash.purging"); }
    purgeBtn.addEventListener("click", () => confirmPurgeEntry(entry.name));
    row.appendChild(purgeBtn);
    wrap.appendChild(row);
  }
}

// ============================================================================
// 批 3-T1 F5 — 归档清理链（回收站彻底删除 / 清空）
//   1.3 删卡进回收站（图留=恢复完整），故 purge 时机 = 回收站彻底删除（1.0「删卡即 purge」不适用）。
//   引擎 #39 archive_purge：删 archive_docs/<名>.json + rmtree archive_images/<名>/（api.md #39）。
//   口径：双确认披露物理删除范围；purge 成功才移条目；失败条目保留可重试；清空逐条 + 失败跳过计数。
// ============================================================================

function confirmPurgeEntry(name) {
  openConfirm({
    title: t("assets.trash.purgeTitle"),
    sub: t("assets.trash.purgeSub", { name }),
    confirmText: t("projects.recycle.purge"),
    danger: true,
    onConfirm: () => purgeTrashEntry(name),
  });
}

async function purgeTrashEntry(name) {
  const r = await archivePurge(name);
  if (!S) return; // 已卸载
  if (!r.ok) {
    showToast("error", t("assets.trash.purgeFail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
    return;
  }
  trashRemove(safeStorage(), name); // 引擎清理成功才移出缓存
  showToast("success", t("assets.trash.purged", { name }));
  renderTrash();
}

function confirmPurgeAll() {
  openConfirm({
    title: t("assets.trash.clearTitle"),
    sub: t("assets.trash.clearSub"),
    confirmText: t("projects.recycle.clear"),
    danger: true,
    onConfirm: () => purgeAllTrash(),
  });
}

async function purgeAllTrash() {
  const list = readTrash(safeStorage());
  let done = 0;
  let failed = 0;
  // 批 4-T1 ③: 循环前置互斥态 + 重渲（行内恢复/彻底删除钮转 disabled）；
  //   循环中卸载即早退（重挂载重建 S·purgingAll 自愈复位）
  if (S) { S.purgingAll = true; renderTrash(); }
  for (const entry of list) {
    if (!entry || !entry.name) continue;
    const r = await archivePurge(entry.name);
    if (!S) return; // 已卸载
    if (r.ok) {
      trashRemove(safeStorage(), entry.name);
      done += 1;
    } else {
      failed += 1; // 单项失败跳过 — 条目保留，继续下一条
    }
  }
  if (S) S.purgingAll = false; // 循环毕复位 → renderTrash 行钮恢复可用
  renderTrash();
  showToast(failed ? "error" : "success", t("assets.trash.clearDone", { done, failed }));
}

async function restoreTrashEntry(name) {
  const list = readTrash(safeStorage());
  const entry = list.find((it) => it && it.name === name);
  if (!entry || !entry.card) {
    trashRemove(safeStorage(), name);
    renderTrash();
    return;
  }
  const r = await saveCard(name, entry.card);
  if (!S) return;
  if (!r.ok) {
    showToast("error", t("assets.recovery.fail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
    return;
  }
  trashRemove(safeStorage(), name); // 写回成功才移出缓存
  showToast("success", t("assets.trash.restored", { name }));
  refresh();
}

// ============================================================================
// B7-T5 F36（批 9 T1 多选化）: 三视图 ref2v 参考图选择——引擎 #45 已支持多图参照
//   （image_paths 1-8 张·槽 1=主锚定句同单图·槽 2-8 通用参照句）。多 media 卡（外貌+服装等）
//   提交前弹层勾选（checkbox 多选·默认勾首行=现行首行取图语义零回归·同图去重·勾满 8 禁用
//   未勾项）；取消/ESC/遮罩/空选关层 = 不提交。单值 image_path（单图卡）通道语义不变。
// ============================================================================
// 卡内含 media 的行（机械口径与既有取图一致：不按 kind 过滤·行序原样）
function threepovMediaRows(name) {
  const card = (S && S.assets && S.assets[name]) || {};
  const rows = Array.isArray(card.rows) ? card.rows : [];
  return rows.filter((r) => r && r.media);
}

// 行名 = rows 现有 desc/usage 字段（desc 优先 · usage 走既有 USAGE_CATALOG 标签回退——不造新数据）
function threepovRowLabel(r) {
  if (r && r.desc) return String(r.desc);
  const u = USAGE_CATALOG.find((c) => c.id === (r && r.usage));
  return (u && u.label) || (r && r.usage) || t("assets.tpv.unnamedRow");
}

// F33（批 9 T1·18-24 清偿）: 引擎 #45 对 image_path/image_paths 逐项校验存在性——库内 media 多为
//   相对路径（asset_library/…）→ engineInputDir 拼引擎 input 绝对；已是绝对直传。全绝对时不发
//   input_dir 请求；读取失败返回 null（调用方 toast 不提交）。
async function toEngineInputPaths(paths) {
  const isAbs = (p) => /^(?:[a-zA-Z]:[\\/]|\/)/.test(p);
  if (paths.every(isAbs)) return paths;
  const d = await engineInputDir();
  if (!d.ok) return null;
  const base = String(d.dir).replace(/[\\/]+$/, "");
  return paths.map((p) => (isAbs(p) ? p : base + "/" + p.replace(/^[\\/]+/, "")));
}

// ============================================================================
// E004 修正笔：三视图 / 多角度生成入口（v43 :1914 媒体行「三视图/多角度 → 去生成」+ :4313 卡面 op）
// 真端点 = api.md #45 POST /h3_batch/threepov（text/image_path/image_paths/card_name 四法·批10 T3 接整卡）。
// 状态轮询 #46 归 S2-2 待审流。
// ============================================================================
// mode: "ref2v" → 预选「以卡首图生成」（卡面「三视图」入口）· 其余 → 预选 t2v（「多角度」入口）
//   批10 T3: mode 显式传入时优先于「按整卡生成」默认（无 mode 且卡 kind 匹配/有图才默认整卡）。
// 老板走查批D: name 为空的调用（顶栏「生成三视图 / 多角度…」= v43 :1672 genOpen 语义「无目标卡直开」）
//   → 表单首行给「目标资产」下拉（原型 :1938 同款行）选卡；卡面 op 传卡名时不渲染此行（形态不变）。
// 仅导出供单测覆盖（显式 mode 行为锁；现网入口只有顶栏无 mode 直开）。
export function openThreepovModal(name, mode) {
  if (!S || typeof document === "undefined") return;
  const names = Object.keys(S.assets || {}).sort();
  const preset = (typeof name === "string" && S.assets[name]) ? name : "";
  if (!preset) {
    if (typeof name === "string" && name !== "") { showToast("error", t("assets.tpv.notFound", { name })); return; }
    // 三件补做批 T3（账本 #30）: 空库不再 toast 拦截——弹窗直开，目标资产行「新建」即建卡路径
    //   （迷你表单需一张已勾参考图源作初始图行，「本地上传 / 从引擎库选图」可先行补图）。
  }
  let target = preset || names[0] || "";

  const wrap = document.createElement("div");
  wrap.className = "cfg";

  // 目标资产行（仅无卡直开）：生成结果并入所选卡。三件补做批 T3（账本 #30）：
  //   行尾「新建」入口 → 内嵌迷你表单（名称预填自动时间戳可改 + 类别 character/scene·默认 character）
  //   —— 弹窗内直接建一张资产卡作为目标（不跳外部流程）。
  //   硬约束（引擎 v3）：新卡必带初始图行且行必带用途——无用途行落断槽致 rows 空（保存必 400·
  //   编辑弹窗保存链同口径），零图卡 povApprove「没有槽位可接管」拦死（F-48 换槽链断）。
  //   图行源 = 弹窗已勾参考图源首张（槽 1 主锚定）；用途按新卡 kind 给默认（character→subject_look /
  //   scene→scene·迷你表单不露用途选择）；未选图源「新建」禁用+提示。
  //   media 用图源路径原形（引擎卡行常规形态·相对路径引擎自解析——与提交链 toEngineInputPaths
  //   绝对化互不影响：卡行存相对形，提交时才转绝对）。
  let syncNewBtn = null; // 图源变化同步「新建」可用态（renderSrc 汇点回调·srcItems 初始化后接线）
  const targetSel = preset ? null : el("select", {
    class: "selx",
    style: "flex:1",
    title: t("assets.tpv.targetT"),
  });
  if (targetSel) {
    for (const n of names) targetSel.appendChild(el("option", { value: n, text: n }));
    if (target) targetSel.value = target; // 空库直开无 option 可选·建卡后再追加
    const newBtn = el("button", {
      type: "button", class: "fbtn", text: t("assets.tpv.newBtn"),
      title: t("assets.tpv.newBtnT"),
    });
    newBtn.setAttribute("data-h3-role", "threepov-new-btn");
    const newNameInput = el("input", {
      type: "text", value: `资产卡 ${_conceptTs()}`,
      title: t("assets.tpv.newNameT"),
    });
    newNameInput.setAttribute("data-h3-role", "threepov-new-name");
    newNameInput.style.cssText = "flex:1;min-width:160px;padding:6px 9px;font-size:12px;outline:none";
    // #39 T3 触点④（方案 I4）: 值域同触点①三值——选「道具」= 建卡 kind=character（引擎真值）
    //   + 初始行 usage=道具多角度（expandUsageRows 链通）+ 生成类型联动切「道具」（见 newSaveBtn）。
    const newKindSel = el("select", { class: "selx", title: t("assets.tpv.newKindT") });
    newKindSel.setAttribute("data-h3-role", "threepov-new-kind");
    newKindSel.appendChild(el("option", { value: "character", text: t("assets.filter.character") }));
    newKindSel.appendChild(el("option", { value: "scene", text: t("assets.filter.scene") }));
    newKindSel.appendChild(el("option", { value: "item", text: t("assets.filter.item") }));
    newKindSel.value = "character";
    const newSaveBtn = el("button", {
      type: "button", class: "prim", text: t("assets.tpv.create"),
      title: t("assets.tpv.createT"),
    });
    newSaveBtn.setAttribute("data-h3-role", "threepov-new-save");
    const newForm = el("div", { class: "row", "data-h3-role": "threepov-new-form" },
      [el("span", { class: "k", text: t("assets.tpv.newCardLbl") }), newNameInput, newKindSel, newSaveBtn]);
    newForm.style.display = "none";
    syncNewBtn = () => {
      const has = srcItems.some((s) => s.on);
      newBtn.disabled = !has;
      newBtn.title = has
        ? t("assets.tpv.newBtnT")
        : t("assets.tpv.newBtnBlocked");
    };
    newBtn.addEventListener("click", () => {
      if (newBtn.disabled) return;
      const show = newForm.style.display === "none";
      newForm.style.display = show ? "" : "none";
      if (show) newNameInput.value = `资产卡 ${_conceptTs()}`; // 每次展开重置时间戳预填
    });
    newSaveBtn.addEventListener("click", async () => {
      const newName = String(newNameInput.value || "").trim();
      const v = validateAssetName(newName);
      if (!v.ok) {
        showToast("error", {
          empty: t("assets.edit.nameEmpty"),
          too_long: t("assets.edit.nameTooLong"),
          invalid_char: t("assets.edit.nameInvalid"),
        }[v.reason]);
        return;
      }
      if (S.assets[newName]) { showToast("error", t("assets.tpv.clash", { name: newName })); return; }
      const media = srcItems.filter((s) => s.on).map((s) => s.path)[0] || "";
      if (!media) { showToast("info", t("assets.tpv.newBtnBlocked")); return; }
      // #39 T3 触点④: 道具 = 展示态——引擎真值 kind=character + 初始行 usage=道具多角度（D4 红线）
      const selKind = newKindSel.value;
      const kind = selKind === "scene" ? "scene" : "character";
      const usageId = selKind === "scene" ? "scene" : (selKind === "item" ? "道具多角度" : "subject_look");
      const uIdx = USAGE_CATALOG.findIndex((u) => u.id === usageId);
      if (uIdx < 0) { showToast("error", t("assets.tpv.catalogMissing")); return; } // 防 rows 空卡（引擎必 400）
      const card = { _v: 3, kind, rows: expandUsageRows(media, [{ idx: uIdx }]), tags: [], memo: "" };
      const r = await saveCard(newName, card);
      if (!S) return; // 卸载后迟到的保存响应 — 丢弃（同 refresh 迟到守卫口径·本行回填 S.assets 前置）
      if (!r.ok) {
        showToast("error", t("assets.saveFail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
        return;
      }
      // 新卡立即成为当前目标：本地先挂卡（refresh 异步回填同真值）→ 下拉追加+选中+改绑+标题
      S.assets[newName] = card;
      target = newName;
      targetSel.appendChild(el("option", { value: newName, text: newName }));
      targetSel.value = newName;
      bindTarget(newName);
      inst.setTitle(t("assets.tpv.title", { name: target }));
      newForm.style.display = "none";
      // #39 T3 触点④: 联动——选「道具」建卡后生成类型自动切「道具」（三键区随 syncKindMode 隐藏）
      if (selKind === "item") { kindSel.value = "item"; syncKindMode(); }
      showToast("success", t("assets.tpv.created", { name: newName }));
      refresh(); // 卡墙与 @N 注册表异步回填（refresh 内 scanAssignRegistry）
    });
    wrap.appendChild(el("div", { class: "row" }, [el("span", { class: "k", text: t("assets.tpv.targetLbl") }), targetSel, newBtn]));
    wrap.appendChild(newForm);
  }

  // 三件补做批 T2（账本 #29）+ #39：生成类型三选项——人物（默认·#45/#46 三视图）/
  //   道具（#53/#54 道具多角度四格）/ 场景（#47/#48 场景画布·采用=追加语义 D2●B1）。
  //   口径：道具 = character 卡 + 道具多角度行，卡 kind 下拉不加第三项；
  //   道具/场景模式隐藏 R-03 三键区（两链均无 aspect/megapixels/duration 契约·api.md）。
  let mediaKeysBox = null; // 高级区三键容器（advSec 构建后回填·选道具/场景整区隐藏）
  const kindSel = el("select", {
    class: "selx",
    style: "flex:1",
    title: t("assets.tpv.kindT"),
  });
  kindSel.appendChild(el("option", { value: "character", text: t("assets.tpv.kindPerson") }));
  kindSel.appendChild(el("option", { value: "item", text: t("assets.tpv.kindItem") }));
  kindSel.appendChild(el("option", { value: "scene", text: t("assets.tpv.kindScene") }));
  kindSel.value = "character"; // 人物默认（显式置值——浏览器 select 默认取首项，此处显式同义）
  wrap.appendChild(el("div", { class: "row" }, [el("span", { class: "k", text: t("assets.tpv.kindLbl") }), kindSel]));

  // 给法选择（引擎四选一互斥：text / image_path / card_name）——批10 T3 增第三法「按整卡生成」
  //   （值=i18n 键·渲染/事件路径取词·§4.9）
  const MODE_TA_PH = "assets.tpv.taPh";
  const CARD_TA_PH = "assets.tpv.cardTaPh";
  const byText = document.createElement("label");
  byText.style.cssText = "display:flex;gap:6px;align-items:center;margin:6px 0;font-size:12px";
  const rbText = document.createElement("input");
  rbText.type = "radio"; rbText.name = "tpvMode"; // checked 由 initMode 决定（依赖目标卡 kind/图数）
  byText.appendChild(rbText);
  byText.appendChild(document.createTextNode(t("assets.tpv.modeText")));
  const byImg = document.createElement("label");
  byImg.style.cssText = "display:flex;gap:6px;align-items:center;margin:6px 0;font-size:12px";
  const rbImg = document.createElement("input");
  rbImg.type = "radio"; rbImg.name = "tpvMode";
  byImg.appendChild(rbImg);
  byImg.appendChild(document.createTextNode(t("assets.tpv.modeImg")));
  const byCard = document.createElement("label");
  byCard.style.cssText = "display:flex;gap:6px;align-items:center;margin:6px 0;font-size:12px";
  const rbCard = document.createElement("input");
  rbCard.type = "radio"; rbCard.name = "tpvMode";
  byCard.appendChild(rbCard);
  byCard.appendChild(document.createTextNode(t("assets.tpv.modeCard")));
  wrap.appendChild(byText);
  wrap.appendChild(byImg);
  wrap.appendChild(byCard);
  rbText.checked = false; rbImg.checked = false; rbCard.checked = false; // 初值显式化（initMode 只置一项 true）
  // 整卡禁用原因提示（人物/道具无图 · kind 不匹配）
  const cardHint = document.createElement("div");
  cardHint.className = "exwarn";
  cardHint.style.cssText = "display:none;font-size:12px;color:var(--txt3);margin:0 0 6px";
  wrap.appendChild(cardHint);

  // 文字法输入（预填卡 memo/描述行拼接）
  const ta = document.createElement("textarea");
  ta.rows = 3;
  // 批 R4.6 · D34 (v43 :1944): 补 placeholder（首次进入即有引导）
  ta.setAttribute("placeholder", t(MODE_TA_PH));
  ta.style.cssText = "width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px;color:var(--txt);font-size:12px;font-family:inherit;box-sizing:border-box";
  wrap.appendChild(ta);
  const imgNote = document.createElement("div");
  imgNote.style.cssText = "font-size:12px;color:var(--txt3);margin-top:6px";
  wrap.appendChild(imgNote);
  const note = document.createElement("div");
  note.className = "exwarn";
  note.style.display = "flex";
  note.textContent = t("assets.tpv.note");
  wrap.appendChild(note);

  // ---- 批 10-K-T1 F74（老板复验回执⑥②「ref 模式没有上传图片入口」）: 参考图源区 ----
  //   常驻弹窗内（取代 F36「点去生成才弹选择层」旧形态：上传/选图入口在 ref 模式直接可见）。
  //   图源三类同池：①本卡图片（默认勾首图·卡 rows 全部图可勾）②本地上传（多选·逐张 uploadImage）
  //   ③引擎库选图（openPicker·可反复追加）。逐项可移除；计数 1-8（引擎 image_paths 契约上限）。
  //   提交：0 张=白话提示不提交 / 1 张=image_path / ≥2 张=image_paths（相对路径同 F33 口径转绝对）。
  // MAX_REFS = 8（引擎 image_paths 契约上限·9+ → 400 too_many_refs）已提模块级（批 2-T4 F-77）·与直提同源。
  const srcBox = el("div", { "data-h3-role": "threepov-srcbox" });
  const srcList = el("div", { "data-h3-role": "threepov-src-list" });
  const srcCount = el("div", { "data-h3-role": "threepov-src-count", style: "font-size:12px;color:var(--txt3);margin-top:2px" });
  const upFile = el("input", { type: "file", accept: "image/*", multiple: "", style: "display:none" });
  const upBtn = el("button", { type: "button", class: "fbtn", text: t("assets.tpv.upBtn"), title: t("assets.tpv.upBtnT") });
  const libBtn = el("button", { type: "button", class: "fbtn", text: t("assets.tpv.libBtn"), title: t("assets.tpv.libBtnT") });
  const srcBtns = el("div", { style: "display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap" }, [upBtn, libBtn, upFile]);
  const srcCap = el("div", {
    class: "exwarn",
    style: "display:flex",
    text: t("assets.tpv.srcCap", { max: MAX_REFS }),
  });
  srcBox.appendChild(srcList);
  srcBox.appendChild(srcBtns);
  srcBox.appendChild(srcCount);
  srcBox.appendChild(srcCap);
  wrap.appendChild(srcBox);

  // 图源条目：{path, label}——本卡图与上传/库选图同池（本卡行序在先，追加在后）
  let srcItems = [];
  function renderSrc() {
    clearChildren(srcList);
    const n = srcItems.filter((s) => s.on).length;
    for (const s of srcItems) {
      const cb = el("input", { type: "checkbox", name: "threepovRefPick", value: s.path });
      cb.checked = !!s.on;
      // 上限拦截（契约限提交项数非行位）：勾满后禁用未勾项、回落即恢复——不让必 400 的请求凑成
      if (!s.on && n >= MAX_REFS) cb.disabled = true;
      cb.addEventListener("change", () => { s.on = cb.checked; renderSrc(); });
      const del = el("button", { type: "button", class: "fbtn", text: t("assets.tpv.remove"), title: t("assets.tpv.removeT") });
      del.setAttribute("data-h3-role", "threepov-src-del");
      del.addEventListener("click", () => {
        srcItems = srcItems.filter((x) => x !== s);
        renderSrc();
      });
      srcList.appendChild(el("div", {
        "data-h3-role": "threepov-src-item",
        style: "display:flex;gap:6px;align-items:center;margin:6px 0;font-size:12px",
      }, [
        el("label", { style: "display:flex;gap:6px;align-items:center;flex:1" }, [cb, document.createTextNode(`${pickDisplay("usageLabel", s.label)} · ${s.path}`)]),
        del,
      ]));
    }
    srcCount.textContent = t("assets.cvp.refCount", { n, max: MAX_REFS }) + (n >= MAX_REFS ? t("assets.cvp.refMax", { max: MAX_REFS }) : "");
    if (syncNewBtn) syncNewBtn(); // T3（#30）: 图源勾选变化 → 同步「新建」可用态
  }
  // 追加入列（超上限=白话提示不入列·引擎 9+ 必 400）
  function addSrcs(list) {
    const fresh = list.filter((p) => p && !srcItems.some((s) => s.path === p));
    if (srcItems.length + fresh.length > MAX_REFS) {
      showToast("info", t("assets.tpv.srcCapHit", { max: MAX_REFS }));
      return;
    }
    for (const p of fresh) srcItems.push({ path: p, label: t("assets.tpv.refImgLbl"), on: true });
    renderSrc();
  }

  upBtn.addEventListener("click", () => { if (upFile.click) upFile.click(); });
  upFile.addEventListener("change", async () => {
    const files = Array.isArray(upFile.files) ? upFile.files.slice() : [];
    upFile.value = ""; // 复位：同一批文件重选也触发 change
    if (!files.length) return;
    for (const f of files) {
      try {
        const up = await uploadImage(buildUploadFormData(f, f.name || "pov.png", UPLOAD_MEDIA_ROOT));
        if (!up || !up.name) throw new Error(t("assets.up.noName"));
        addSrcs([UPLOAD_MEDIA_ROOT + up.name]);
      } catch (e) {
        showToast("error", t("assets.edit.uploadFail", { reason: (e && e.message) || e }));
      }
    }
  });
  // 引擎库选图（批 2-T3 F3 同款 picker·此处可反复调用追加）
  libBtn.addEventListener("click", () => {
    openPicker({
      title: t("assets.tpv.pickerTitle"),
      mode: "image",
      onPick: (picked) => {
        if (typeof picked !== "string" || !picked) return;
        addSrcs([picked]);
      },
    });
  });

  // B3-T2 F7：高级参数折叠区（引擎 #45 J2b 覆盖参数）——默认收起。三件补做批 T1（#28·R-03）：
  //   三键项目级记忆——开弹窗读持久值回填（initial）·change 落值/删键（onParamChange）·
  //   提交成功兜底再落一次（防改后未失焦直点「去生成」change 未触发漏记）；
  //   模板/LoRA/底模覆写仍会话态不记忆（每次开弹窗重建全空）。无项目上下文 → 会话态（不持久化·不报错）。
  const tpSaved = threepovParamsRead() || {};
  const tpWork = Object.assign({}, tpSaved);   // 本弹窗工作副本（change 逐键增删）
  const advSec = buildCanvasParamsSection({
    panelKind: "threepov",
    initial: tpSaved,
    onParamChange: (key, value) => {
      if (value == null || value === "") delete tpWork[key];
      else tpWork[key] = value;
      threepovParamsWrite(Object.keys(tpWork).length ? Object.assign({}, tpWork) : null);
    },
  });
  if (advSec) {
    wrap.appendChild(advSec);
    mediaKeysBox = advSec.querySelector('[data-h3-role="canvas-params-media-keys"]');
  }
  // T2（#29）: 生成类型 → 三键区显隐（人物=显示·道具/场景=整区隐藏——两链均无三键契约·#39）
  //   批10 T3: 同步整卡给法可用态与目标卡下拉过滤（整卡模式才按 kind 过滤）。
  function syncKindMode() {
    if (mediaKeysBox) mediaKeysBox.style.display = (kindSel.value === "item" || kindSel.value === "scene") ? "none" : "";
    const before = target;
    syncTargetOptions();
    if (target !== before) bindTarget(target);
    syncMode();
    syncCardOption();
    if (inst) inst.setTitle(t("assets.tpv.title", { name: target }));
  }
  kindSel.addEventListener("change", syncKindMode);

  // 表单随目标卡绑定（描述预填 / 图源列表 / 图像法可用性）
  function bindTarget(n) {
    const card = S.assets[n] || {};
    const rows = Array.isArray(card.rows) ? card.rows : [];
    const descLine = rows.map((r) => r.desc).filter(Boolean).join("，");
    ta.value = descLine || String(card.memo || "") || `${n} 三视图参考`;
    // 批 10-K-T1 F74: 图源池随目标卡重建——本卡全部含图行去重入列。
    //   批 G-b T5（R-07 · 18-23·裁决 1）：预填默认全勾（直发跟随卡多图配置）·≥9 图钳
    //   MAX_REFS 前 8（引擎 image_paths 契约上限·9+ 必 400）；单图卡行为不变（i<8 与 i===0 同值）。
    //   （同图去重：多行引用同一 media 只出一项·勾选项数 = 提交项数 = 唯一图数）
    const seen = new Set();
    srcItems = threepovMediaRows(n).filter((r) => {
      if (seen.has(r.media)) return false;
      seen.add(r.media);
      return true;
    }).map((r, i) => ({ path: r.media, label: threepovRowLabel(r), on: i < MAX_REFS }));
    renderSrc();
    const nMedia = srcItems.length;
    imgNote.textContent = nMedia
      ? t("assets.tpv.imgNote", { n: nMedia, max: MAX_REFS })
      : t("assets.tpv.noImgNote");
  }
  bindTarget(target);
  // 批10 T3（方案 §六.3）: 整卡给法状态机。
  //   可用条件 = 目标卡 kind 与生成类型匹配（人物/道具→character·场景→scene）且人物/道具有图；
  //   场景无图放行（采用=追加行·povApprove 守卫不拦）。
  let inst = null;
  let lastMode = null;
  const genWantedKind = () => (kindSel.value === "scene" ? "scene" : "character");
  const cardKindOf = (n) => {
    const c = (S && S.assets && S.assets[n]) || {};
    return c.kind === "scene" ? "scene" : "character";
  };
  // 批10 T9（T5 真机验收发现）: 有图判定按引擎收集白名单 usage（threepov.py
  //   _CANVAS_MEDIA_WHITELIST：character=[subject_look,三视图,subject_outfit,subject_prop]·
  //   item=[subject_prop,道具多角度]）——audio_ref 等非图槽行 media 非空不算图
  //   （否则整卡走 t2v 能生成，GUI 采用侧无图槽可接管=死路）。场景模式放行不看图，不走此判定。
  const CARD_MEDIA_USAGES = {
    person: ["subject_look", "三视图", "subject_outfit", "subject_prop"],
    item: ["subject_prop", "道具多角度"],
  };
  const cardHasMedia = (n) => {
    const card = (S && S.assets && S.assets[n]) || {};
    const rows = Array.isArray(card.rows) ? card.rows : [];
    const allow = CARD_MEDIA_USAGES[kindSel.value === "item" ? "item" : "person"];
    return rows.some((r) => r && r.media && allow.indexOf(r.usage) >= 0);
  };
  function cardAllowed() {
    if (!target || !(S && S.assets && S.assets[target])) return false;
    if (cardKindOf(target) !== genWantedKind()) return false;
    return kindSel.value === "scene" || cardHasMedia(target);
  }
  function cardBlockedHint() {
    if (!target || !(S && S.assets && S.assets[target])) return "";
    if (cardKindOf(target) !== genWantedKind()) {
      return t("assets.tpv.kindMismatch");
    }
    return t("assets.tpv.noImgBlocked");
  }
  const currentMode = () => (rbCard.checked ? "card" : (rbImg.checked ? "ref2v" : "t2v"));
  // 目标卡下拉只过滤整卡模式；旧三法保持全卡列表（方案 §六.3 第 2 条）
  function syncTargetOptions() {
    if (!targetSel) return;
    const all = Object.keys((S && S.assets) || {}).sort();
    const list = rbCard.checked ? all.filter((n) => cardKindOf(n) === genWantedKind()) : all;
    clearChildren(targetSel);
    for (const n of list) targetSel.appendChild(el("option", { value: n, text: n }));
    if (!list.includes(target)) target = list[0] || "";
    if (target) targetSel.value = target;
  }
  // 整卡可用态 + 禁用提示；失配/无图时回退文字法（不发必 400、也无法采用的任务）
  function syncCardOption() {
    const allowed = cardAllowed();
    rbCard.disabled = !allowed;
    const hint = allowed ? "" : cardBlockedHint();
    cardHint.textContent = hint;
    cardHint.style.display = hint ? "" : "none";
    if (!allowed && rbCard.checked) {
      rbCard.checked = false;
      rbText.checked = true;
      lastMode = "t2v";
      bindTarget(target);
      syncMode();
    }
  }
  // 图源区仅 ref2v 显示；整卡态清空文字框改 placeholder（否则与引擎读卡 desc 重复两遍）
  function syncMode() {
    srcBox.style.display = rbImg.checked ? "" : "none";
    if (rbCard.checked) {
      ta.value = "";
      ta.setAttribute("placeholder", t(CARD_TA_PH));
    } else {
      ta.setAttribute("placeholder", t(MODE_TA_PH));
    }
  }
  // 给法切换：离开整卡 → 重跑 bindTarget 恢复 desc 预填（往返一致）
  function onModeChange() {
    const prev = lastMode;
    lastMode = currentMode();
    const before = target;
    syncTargetOptions();
    if (target !== before || (prev === "card" && lastMode !== "card")) bindTarget(target);
    syncMode();
    syncCardOption();
    if (inst) inst.setTitle(t("assets.tpv.title", { name: target }));
  }
  rbText.addEventListener("change", onModeChange);
  rbImg.addEventListener("change", onModeChange);
  rbCard.addEventListener("change", onModeChange);
  // 初始给法：显式 mode 优先；无显式 mode 时整卡可用即默认整卡，其余文字法
  if (typeof mode === "string") {
    rbText.checked = mode !== "ref2v";
    rbImg.checked = mode === "ref2v";
  } else if (cardAllowed()) {
    rbCard.checked = true;
  } else {
    rbText.checked = true;
  }
  lastMode = currentMode();
  syncTargetOptions();
  syncMode();
  syncCardOption();
  syncKindMode();

  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const goBtn = el("button", { type: "button", class: "prim", text: t("assets.tpv.go") });
  inst = openModal({
    title: t("assets.tpv.title", { name: target }),
    sub: t("assets.tpv.sub"),
    contentNode: wrap,
    footerButtons: [cancelBtn, goBtn],
  });
  cancelBtn.addEventListener("click", () => inst.close());
  if (targetSel) {
    targetSel.addEventListener("change", () => {
      target = targetSel.value;
      bindTarget(target);
      syncMode();
      syncCardOption();
      inst.setTitle(t("assets.tpv.title", { name: target }));
    });
  }
  goBtn.addEventListener("click", async () => {
    // T3（#30）: 空库直开未建卡时无目标——拦下白话提示（不发无卡可挂、产物必丢的生成请求）
    if (!target) { showToast("info", t("assets.tpv.needTarget")); return; }
    // T2（#29）+ #39: 提交分派——人物 → submitThreepov（#45）/ 场景 → submitSceneCanvas（#47）/
    //   道具 → submitItemCanvas（#53）。
    const submitKind = kindSel.value === "scene" ? "scene" : (kindSel.value === "item" ? "item" : "person");
    const isCardMode = rbCard.checked;
    let adv = null;
    let opts;
    if (isCardMode) {
      // 批10 T3（方案 §六.3 第 4 条）: 整卡模式——只发 card_name/prompt_extra/writeback:false，
      //   图/描述词/忽略词由引擎读卡拼装（域层 card 模式同口径，不走模板/图源/画布参数）。
      if (!cardAllowed()) {
        showToast("info", cardBlockedHint() || t("assets.tpv.cardModeUnavailable"));
        return;
      }
      opts = { cardName: target, promptExtra: ta.value.trim(), writeback: false };
    } else {
      // 批 10-K-T1 F74: 图源常驻弹窗内，提交直接读勾选池——0 张=白话提示不提交（弹窗留存可补图/改文字法）、
      //   1 张=image_path 单值、≥2 张=image_paths 数组（引擎三法互斥·同 F33 换算口径）。
      let imgPick = null; // { paths: string[] }——非空 = 走图像法
      if (rbImg.checked) {
        const picked = srcItems.filter((s) => s.on).map((s) => s.path);
        if (!picked.length) {
          showToast("info", t("assets.tpv.needRef"));
          return;
        }
        // F33（18-24 清偿）: 相对路径 → 引擎 input 绝对（引擎对 image_path(s) 逐项校验存在性）
        const abs = await toEngineInputPaths(picked);
        if (!abs) { showToast("error", t("assets.tpv.inputDirFail")); return; }
        imgPick = { paths: abs };
      }
      const useImg = rbImg.checked && imgPick;
      // B3-T2 F7: 高级参数真值透传（collect 空值不出键 → body 与现状逐键一致；400/409 走现状 error toast 透传引擎中文 msg）
      adv = collectCanvasParams(advSec);
      opts = useImg
        ? (imgPick.paths.length >= 2 ? { imagePaths: imgPick.paths } : { imagePath: imgPick.paths[0] })
        : {};
      if (adv.workflow_path) opts.workflowPath = adv.workflow_path;
      if (adv.lora_overrides) opts.loraOverrides = adv.lora_overrides;
      if (adv.resource_overrides) opts.resourceOverrides = adv.resource_overrides;
      // T5 #1（复验整改）: 文本法提交 = 模板正文 + "\n\n" + 描述——按 submitKind 取模板
      //   （character→threepov / scene→scene / item→prop·resolveTemplate 四态：留空/占位=新默认·自定义=原值）。
      //   描述空 → 只发模板正文；拼接超 4000 → 截模板保描述（core buildPromptText）。
      //   图片法分支不带 text（引擎三法互斥）。
      if (!useImg) {
        opts.text = buildPromptText(
          resolveTemplate(submitKind === "item" ? "prop" : submitKind === "scene" ? "scene" : "threepov"),
          ta.value.trim()
        );
      }
      //   R-03 三键仅人物链透传（#47/#53 均无三键契约——模式控件已隐藏，collect 残值也不发）。
      if (submitKind === "person") {
        if (adv.aspect) opts.aspect = adv.aspect;
        if (adv.megapixels != null) opts.megapixels = adv.megapixels;
        if (adv.duration_seconds != null) opts.durationSeconds = adv.duration_seconds;
      }
    }
    const r = await (submitKind === "item" ? submitItemCanvas(opts)
      : submitKind === "scene" ? submitSceneCanvas(opts) : submitThreepov(opts));
    if (r.ok) {
      const kindName = povKindDisp(submitKind);
      // T1 提交兜底落三键仅非整卡人物链（整卡体不含三键·#39）
      if (!isCardMode && submitKind === "person") {
        // 三件补做批 T1（#28）兜底：提交成功按 collect 真值再落一次三键（防改后未失焦直点「去生成」漏记）；
        //   全空 = 写 null = 删键（store 侧无键时幂等零写，不虚刷 updatedAt）
        const tpFinal = {};
        if (adv.aspect) tpFinal.aspect = adv.aspect;
        if (adv.megapixels != null) tpFinal.megapixels = adv.megapixels;
        if (adv.duration_seconds != null) tpFinal.duration_seconds = adv.duration_seconds;
        threepovParamsWrite(Object.keys(tpFinal).length ? tpFinal : null);
      }
      inst.close();
      // F15: 提交即挂轮询——生成完自动入卡待审（✓ 采用/✕ 忽略），不再只留"去引擎 output 查看"
      if (r.taskId && target) {
        // F21（批 4-T1 ②补弹窗路径·与直提 directThreepov 同款）: 提交即挂 pending——刷新页面卡面恢复「◍ 渲染中」并续轮询
        // 批 10-I 修正笔（I 批审核保留条件）: 本写点补版本戳 v——与直提 :624 同款；无戳条目会被
        //   migrateLegacyPovPending 判成改语义前遗留、当场扫成 dormant 断槽离场，刚提交的任务在卡面瞬间消失
        povAddPending(target, { status: "generating", taskId: r.taskId, ts: Date.now(), v: POV_ENTRY_V });
        showToast("success", t("assets.pov.submittedAuto", { kind: kindName, id: r.taskId, name: target }));
        pollThreepovIntoCard(r.taskId, target);
      } else {
        showToast("success", t("assets.pov.submittedOutput", { kind: kindName, id: r.taskId || (submitKind === "item" ? "itemcv_*" : submitKind === "scene" ? "scenecv_*" : "threepov_*") }));
      }
    } else {
      showToast("error", t("assets.submitFail", { reason: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
    }
  });
}

// ============================================================================
// S3-1 T2: 概念环入口 — 一句话成片 + 抽帧落库建卡
//   弹窗 → 一句话 textarea → 生成概念帧按钮 →
//     ① 构造单段项目（1 段·时长 2s·模式分镜·提示词=用户输入）；use createProject + 单段 — 公共底层
//     ② 走 submit 主链 generateOnly + runOnly → 拿到 stem — 公共底层
//     ③ 轮询 pollStatus 到 done / failed（前端简单轮询·复用既有通道）— 公共底层
//     ④ 拿历史详情 loadDetail 找到产物视频路径 — 公共底层
//     ⑤ 抽帧 extractFrame（隐藏 video + canvas）→ blob
//     ⑥ 上传 /upload/image (subfolder=asset_library/asset_images/concept)
//     ⑦ saveCard 创建概念帧卡（kind=Picture, 用途 first_frame, 卡名=概念帧 YYYYMMDD-HHMM）
//     ⑧ 资产列表刷新 + toast「概念帧已入资产库」
//   S3-4 B5：①②③④ 抽为公共底层 runSingleSegmentGeneration（下方）——概念环=底层+⑤⑥⑦⑧，
//     Quick Shot（views/portal.js 表单）=底层+完成态（不抽帧·不入资产库）。
// ============================================================================

// 概念卡命名时间戳 "YYYYMMDD-HHMM"
function _conceptTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 仅导出供单测覆盖（构造单段项目——本函数走 store.createProject + 写入 segments，零网络可测）
// S3-4 B6：opts.seed 固定种子（收藏夹「一键变体」= 同 seed 重跑）；缺省空串 = 既有语义（引擎随机）
export function buildConceptOneSegmentProject(prompt, opts = {}) {
  const seed = (opts && opts.seed != null) ? String(opts.seed) : "";
  const proj = createProject("");
  proj.projMode = "分镜";
  proj.runCount = 1;
  proj.globalPrompt = "";
  // 单段：覆盖默认 segments[0]（保留 createProject 默认字段，prompt/durationSec 改写）
  proj.segments = [{
    ...proj.segments[0],
    prompt,
    durationSec: 2,
    seed,
    checked: true,
    concat: false,
    "分段模式": "自动（引擎派生）",
    "角度": "",
    "景别": "",
  }];
  return proj;
}

// ============================================================================
// S3-4 B5: 单段生成公共底层（概念环 / Quick Shot 共用）
//   一句话 → 单段项目（分镜·2 秒·1 段）→ generate_csv → submit → 轮询至 done → 产物视频路径
//   refName 给了就复用 @N 注册表通道挂首帧：prompt 末尾补 " @N"（段卡下拉同款拼装），
//     registry/assets 随 formData 装配进 pool（first_frame 行入 Picture 池 + 帧锚点句）。
// ============================================================================

/** 卡可作首帧参考 = rows 含 first_frame 且 media 非空（与 buildPool 装配口径同源） */
export function isFirstFrameRefCard(card) {
  return !!(card && Array.isArray(card.rows)
    && card.rows.some((r) => r && r.usage === "first_frame" && r.media));
}

/** 素材选数据源：库内可作首帧参考的卡名（升序） */
export async function listFirstFrameRefCards() {
  const r = await listAssets();
  const assets = (r && r.assets) || {};
  return Object.keys(assets).filter((n) => isFirstFrameRefCard(assets[n])).sort();
}

/**
 * 单段生成公共底层：提交 → 轮询至 done → 产物路径。
 * @param {string} prompt - 一句话提示词
 * @param {{refName?: string, seed?: string, onTick?: function}} [opts]
 *   refName: 资产库卡名（须可作首帧参考）；seed: 固定种子（缺省 = 引擎随机，既有语义）；
 *   onTick: 轮询节拍回灌（调用方做进度显示）
 * @returns {Promise<{stem: string, videoPath: string|null}>}
 */
export async function runSingleSegmentGeneration(prompt, opts = {}) {
  const refName = (opts && typeof opts.refName === "string") ? opts.refName : "";
  const seed = (opts && opts.seed != null) ? String(opts.seed) : "";
  const onTick = (opts && typeof opts.onTick === "function") ? opts.onTick : null;

  let promptText = prompt;
  let registry = {};
  let assets = {};
  if (refName) {
    const loaded = await listAssets();
    assets = (loaded && loaded.assets) || {};
    if (!isFirstFrameRefCard(assets[refName])) {
      throw new Error(t("assets.refNotCard", { name: refName }));
    }
    const storage = safeStorage();
    const n = assignRegistryN(storage, refName);
    registry = readRegistry(storage);
    promptText = appendFirstFrameRefToPrompt(prompt, n);
  }

  const proj = buildConceptOneSegmentProject(promptText, { seed });
  const formData = buildConceptFormData(proj, { registry, assets });

  const gen = await generateOnly(formData);
  if (!gen.ok) {
    throw new Error(t("assets.concept.errGen", { reason: (gen.error && gen.error.msg) || (gen.error && gen.error.code) || t("sb.common.unknown") }));
  }
  const run = await runOnly(formData, gen.csv_path);
  if (!run.ok) {
    throw new Error(t("assets.concept.errSubmit", { reason: (run.error && run.error.msg) || (run.error && run.error.code) || t("sb.common.unknown") }));
  }
  const stem = run.stem;
  if (!stem) throw new Error(t("assets.concept.errNoStem"));

  const finalPayload = await pollConceptToDone(stem, onTick);
  if (!finalPayload) throw new Error(t("assets.concept.errPollTimeout"));
  // 产物路径（按 applyHistory 同款: shots dict 第一条 files[0]）；取不到回 null 由调用方定夺
  return { stem, videoPath: await loadConceptVideoPath(stem) };
}

// 老板走查批D：导出供门户（portal.js hero-sub「一句话成片」）跨视图直弹 ——
//   本通道不依赖 assets 视图挂载（未挂载时链尾 refresh 略过, 落卡/注册表仍走既有通道）。
export function openConceptModal() {
  if (typeof document === "undefined") return;

  const ta = el("textarea", {
    rows: "4",
    placeholder: t("assets.concept.ph"),
  });
  ta.style.cssText = "width:100%;padding:10px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);resize:vertical";

  const tHint = el("div", { style: "font-size:11px;color:var(--txt3);margin-top:6px" });
  tHint.appendChild(document.createTextNode(t("assets.concept.hint")));

  const tWrap = el("div");
  tWrap.appendChild(ta);
  tWrap.appendChild(tHint);

  const note = el("div", { class: "exwarn", style: "display:flex;margin-top:8px" });
  note.appendChild(document.createTextNode(t("assets.concept.note")));

  const content = el("div");
  content.appendChild(tWrap);
  content.appendChild(note);

  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const goBtn = el("button", { type: "button", class: "prim", text: t("assets.concept.go") });
  let inst = openModal({
    title: t("assets.concept.title"),
    sub: t("assets.concept.sub"),
    contentNode: content,
    footerButtons: [cancelBtn, goBtn],
  });
  cancelBtn.addEventListener("click", () => inst.close());

  // submit 主链复用 submit-bar 的 runFlow 思路（generate_csv → submit → pollStatus），
  // 此处不调 mountSubmitBar（避免 shell 顶栏耦合，assets 视图内自走）。
  goBtn.addEventListener("click", async () => {
    const prompt = String(ta.value || "").trim();
    if (!prompt) {
      showToast("error", t("assets.concept.needPrompt"));
      return;
    }
    // 进入"生成中"态：禁用按钮 + 文本切换 + toast
    cancelBtn.disabled = true;
    goBtn.disabled = true;
    const oldGoText = goBtn.textContent;
    goBtn.textContent = t("assets.concept.generating");
    showToast("info", t("assets.concept.submitted", { prompt }));

    try {
      const ts = await runConceptChain(prompt);
      // 成功路径：弹窗关闭 + toast 概念帧已入资产库（ts=链内实建卡名的时间戳，防跨分钟窗口错位）
      showToast("success", t("assets.concept.done", { name: `概念帧 ${ts}` }));
      inst.close();
      if (S) refresh();
    } catch (e) {
      // 失败路径：toast 不静默（按要求"抽帧失败如实 toast 不静默"）
      showToast("error", t("assets.concept.fail", { reason: e && e.message ? e.message : String(e) }));
      cancelBtn.disabled = false;
      goBtn.disabled = false;
      goBtn.textContent = oldGoText;
    }
  });
}

// 完整链：公共底层（构造 → submit → poll → 产物路径）+ 抽帧 → 上传 → saveCard
async function runConceptChain(prompt) {
  // 公共底层（S3-4 B5 抽出；概念环仅取产物路径，挂用/进度等参数不用）
  const { videoPath } = await runSingleSegmentGeneration(prompt);
  if (!videoPath) throw new Error(t("assets.concept.errNoVideo"));

  // 抽帧（隐藏 video + canvas）
  const blob = await extractConceptFrame(videoPath, 1.0);
  if (!blob) throw new Error(t("assets.concept.errExtract"));

  // 6) /upload/image 落盘
  const ts = _conceptTs();
  const fileName = `concept_${ts}.png`;
  const up = await uploadImage(buildConceptUploadFormData(blob, fileName));
  if (!up || !up.name) throw new Error(t("assets.concept.errNoName"));

  // 7) saveCard: 卡名 = 概念帧 YYYYMMDD-HHMM
  const card = buildConceptCard({ prompt, ts, mediaName: up.name });
  const cardName = `概念帧 ${ts}`;
  const sr = await saveCard(cardName, card);
  if (!sr.ok) throw new Error(t("assets.crop.saveFail", { reason: (sr.error && sr.error.msg) || (sr.error && sr.error.code) || t("sb.common.unknown") }));

  // 8) 注册表分配 @N（与 openAssetModal 末尾同款，最小一致）
  assignRegistryN(safeStorage(), cardName);
  return ts;
}

// formData 装配：复用 core/submit.buildFormDataFromProject（ctx = registry/assets，供 @N → pool/帧锚点装配）
function buildConceptFormData(proj, ctx) {
  const c = ctx || {};
  return buildFormDataFromProject(proj, {
    registry: (c.registry && typeof c.registry === "object") ? c.registry : {},
    assets: (c.assets && typeof c.assets === "object") ? c.assets : {},
  });
}

// 轮询到 done（包装 pollStatus，timeout 360s——真机 2s 片段含模型加载 3-4 分钟）
function pollConceptToDone(stem, onTick) {
  return new Promise((resolve) => {
    let finished = false;
    const ph = pollStatus({
      stem,
      outputDir: "",
      intervalMs: 3000,
      emptyGraceMs: 20000,
      historyKind: "concept",   // G2·#57：队列行来源字段（概念帧链）
      onTick: typeof onTick === "function" ? onTick : () => {},
      onError: () => {},
      onFinal: (payload) => {
        if (finished) return;
        finished = true;
        const failed = (payload && typeof payload.failed === "number") ? payload.failed : 0;
        const total = (payload && typeof payload.total === "number") ? payload.total : 0;
        if (total > 0 && failed >= total) resolve(null); // 全失败
        else resolve(payload || null);
      },
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (ph && typeof ph.stop === "function") ph.stop({ silent: true }); // B5-T6 清偿 B：前端放弃等待≠用户停止，静默防误发「已停止」
      resolve(null);
      // 360s：真机实测 2s 片段含模型加载/排队约 3-4 分钟（首跑 08:01 提交→08:04 完成·90s 超时先到致链断）
    }, 360000);
    // Node 单测：超时哨兵不吊住测试进程（浏览器 setTimeout 无 unref，guard 后不影响真机）
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

// 历史详情 → 第一段产物视频绝对路径（edit.js applyHistory 同款: run_dir + files[0]）
async function loadConceptVideoPath(stem) {
  // 走 core/history_ops.js loadDetail（信封已规整）。
  // 引擎 detail 的 shots 为对象形态（{"shot_001":{...}}），loadDetail 会把非数组归一成 []
  // （history_ops.js:267·edit.js:1106 同坑登记）——故从 raw.shots 对象消费，取法与 edit.js 重跑链同款。
  const r = await loadDetail({ taskId: stem });
  if (!r || !r.ok) return null;
  const shots = (r.raw && r.raw.shots && typeof r.raw.shots === "object") ? r.raw.shots : {};
  const sid = Object.keys(shots).sort().find((k) => {
    const s = shots[k];
    return s && s.status === "success" && Array.isArray(s.files) && s.files.length > 0;
  });
  if (!sid) return null;
  const s = shots[sid];
  const f = s.files[0];
  const rd = String(s.run_dir || "").replace(/[\\/]+$/, "");
  return rd ? (rd + "\\" + f) : f;
}

// 抽帧：DOM 端——动态建 hidden video + canvas，crossOrigin+mute 防 tainted（落本地 /h3_batch/video 直连 8190）
async function extractConceptFrame(videoPath, seekT) {
  if (typeof document === "undefined") throw new Error(t("assets.concept.errNoDoc"));
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // blob URL / 直接路径都行——引擎 /h3_batch/video?path= 接受路径（批 B #13：URL 收敛单源·&t= 防缓存旁路位保留）
  video.src = mediaUrl("video", videoPath) + "&t=" + seekT;

  const canvas = document.createElement("canvas");
  canvas.style.display = "none";
  try {
    // 等待当前帧数据就绪（readyState>=2 = HAVE_CURRENT_DATA，drawImage 才有帧可画；
    // loadedmetadata 只到 1，曾在真机上 readyState=1 就放行导致 extractFrame 拒绝）
    if (video.readyState < 2) {
      await new Promise((resolve, reject) => {
        let done = false;
        const ok = () => { if (done) return; if (video.readyState >= 2) { done = true; resolve(); } };
        const err = () => { if (done) return; done = true; reject(new Error(t("assets.concept.errVideoLoad"))); };
        video.addEventListener("loadeddata", ok, { once: true });
        video.addEventListener("canplay", ok, { once: true });
        video.addEventListener("loadedmetadata", ok, { once: true });
        video.addEventListener("error", err, { once: true });
        setTimeout(() => { if (!done) { done = true; reject(new Error(t("assets.concept.errVideoTimeout"))); } }, 15000);
      });
    }
    const blob = await extractFrame({ video, canvas, t });
    return blob;
  } finally {
    video.remove && video.remove();
  }
}

// FormData 构造：image + subfolder + type=input + overwrite=true
function buildConceptUploadFormData(blob, fileName) {
  const fd = new FormData();
  fd.append("image", blob, fileName);
  fd.append("subfolder", CONCEPT_MEDIA_ROOT.replace(/\/$/, ""));
  fd.append("type", "input");
  fd.append("overwrite", "true");
  return fd;
}
