// shell.js — 应用壳+路由模块（GUI1.3 S1-1 T2）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 左栏 :21-39（#sidenav/.logo/.btn-new/.nav/.nav-item/.nav-spacer/.ws/.bell）+ :505-515（slim 态覆盖）
//   - 主区 :41-51（#main/#banner/#views/.toptest）
//   - 老板走查快批⑦（2026-09-26）：引擎芯片独立槽位 .shell-eng-slot（mount 一次常驻），
//     不随各视图顶栏行内挂载；批 10C-T1 · F57（老板裁⑤A）：槽位迁侧栏底部一行（挂 #sidenav）
//   - 工作区顶栏 :179-188（.pws-head/.pws-head h2/.pws-status/.runhint/.runbtn）
//   - 批 R2：状态条+状态灯 :1139/:175 · 重置草稿/只重渲失败段 :1142-1143 · 运行记录区 :1151-1186
//   - TAB :255-260（.ptabs/.ptab/.ptab.on/.pview）
//   - 视图切换 JS :4352-4368（showView + 路由隐含形态）
//   - pmenu :141（位置已在 theme.css）
//
// === 路由选择理由 ===
// 选择 hash 路由（带 in-memory 状态机）：
//   1. 静态服务零配置即可深链直达（不依赖 server rewrite）
//   2. Tauri 壳形态同样可用
//   3. 内存状态为权威源，hash 仅同步——单测可注入 fakeLocation/fakeHistory 跑通纯逻辑
//   4. 浏览器前进/后退（hashchange）能自然接管
//
// === 三视图路由表（hash 形态） ===
//   ''              → 门户（home）
//   '#/projects'    → 项目管理
//   '#/history'     → 历史记录（#36·全库跨项目聚合·按项目分组）
//   '#/project/<id>'→ 项目工作区（?tab=preview|setup|edit 可选，默认 preview）
//   '#/assets'      → 资产管理（占位壳）
//   '#/ai'          → AI 协作（批 R5 实装 · v43 :1693-1728 视图壳+归档真实化）
//   '#/settings'    → 设置页壳
//
// === 左栏导航命名（v35 钦点 · 详案 S1-1） ===
// 详案钦点 5 项（不与 v43 原型完全一致——v43 实测有 6 项含「首页」；
// 本任务按详案口径走 5 项，门户由 hash 空路由承载不入 nav）：
//   创作画布 / 项目管理 / 资产管理 / AI 协作 / 设置
//
// === 工作区 TAB（v43 :1187-1191 实测） ===
//   项目预览（preview） / 设定（参数 / 提示词）（setup） / 剪辑区域（edit）
//
// === API ===
//   parseRoute(hash)            → {view, projectId?, tab?}  · 路由字符串解析
//   serializeRoute(state)       → string                    · 状态→字符串
//   createRouter(opts)          → {current, go, subscribe, location}
//   NAV_ITEMS                   · v35 钦点 5 项导航常量
//   PROJ_TABS                   · v43 实测 3 TAB 常量
//   tabIndexByKey(key)          · TAB key→索引（默认 0）
//   tabKeyByIndex(idx)          · 索引→TAB key（越界→preview）
//   navItemForView(view)        · view→导航项（home 不属 nav → null）
//   getProjectName(project)     · 项目名（无则"未命名项目"）
//   mount(container, opts)      · 渲染应用壳（含左栏+主区）

import {
  load as storeLoad,
  save as storeSave,
  subscribe as storeSubscribe,
  updateProjectMeta,
  updateEditingState,
  listProjects,
  // 批 R2 · A03：重置草稿清段（remove ×N + addSegment → 逐段事件让 runhint/pws-status 订阅刷新）
  addSegment,
  removeSegment,
  // R-20③（批 10-P P-T1）：完成度实时推导（当前分镜 vs 有产物段·按 segId 对号）
  deriveProjectCompletion,
  // 批 L1 T2 R-27：「更多→打开文件夹」未设目录时的成片目录解算数据源（最近一次主链运行 stem）
  latestMainRunStem,
  // #63 T4：运行记录指针（currentRunId → runs 行·缺失/悬空回落 runs[0]）
  currentRunRow,
} from "../store/store.js";
// #63 T4：按记录载入——读快照回填全参数（T3 落盘链）；T5：+findMainSnapshotId（postfx 回溯主快照）
import { loadRunSnapshot, findMainSnapshotId } from "../core/run_snapshots.js";
// #63 T5：旧记录降级——引擎快照 config → ai_snapshot 可逆映射回填（部分恢复）
import { snapshotToStore } from "../core/ai_snapshot.js";
// W-02/W-03 转正（自主排期批 1）：导入/导出 CSV（引擎权威链路·core/csv_transfer.js）
// 批 2-T5：导入结果带出素材池三形态 + 未知列清单（hasPoolEntries/unknownColumnsNotice）
import { exportProjectCsv, importCsvText, hasPoolEntries, unknownColumnsNotice } from "../core/csv_transfer.js";
import { fetchSubmitPoolContext } from "./submit-bar.js";
import { listAssets } from "../core/assets_api.js";
// B4-T4 ④：运行备注引擎侧留底（history_ops.saveNote · ≤200 字）；T5：importConfig（旧记录引擎快照降级）
import { saveNote, importConfig } from "../core/history_ops.js";
import { openConfirm as openConfirmModal, open as openModalBox, openPrompt as openPromptModal } from "../ui/modal.js";
// 批0 · T2：任务队列入口（openQueueModal 居中弹层 + loadHistory 构建时快照计数）
import { openQueueModal, loadHistory } from "../ui/queue.js";
import { request, mediaUrl, localMediaUrl, fetchH3Version } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源（引擎口优先）；批 C #13：+localMediaUrl（看成片离线通道）；#47 档2：+fetchH3Version（引擎版本握手闸取数）
import { concat as concatApi } from "../core/concat.js";
import { loadWorkspaceRoot } from "../core/workspace.js"; // R-59-T2b：打开文件夹优先工作区根（旧 server_output_dir 退役）
import { openDirRequest, firstRunDirFromShots } from "../core/open_dir.js"; // R-31 收敛：open_dir 发包+三分文案 / run_dir 解析单源
// B4-T2 D2：顶栏「只重渲失败段」通道（defaultSelection 过滤 failed/stopped/void + runRerunFlow 共享编排）
// F70：运行记录区「重跑…」二级同种子重跑（sameSeed 二段式）
import { defaultSelection, sameSeed } from "../core/rerun.js";
import { runRerunFlow, setPostfxRerunSupplement } from "./rerun_flow.js";
import { rowsToSegments, engineGlobalsToParams } from "../core/csv_transfer.js";
import * as portal from "./portal.js";
import * as projects from "./projects.js";
// #36 左侧栏「历史记录」tab（方案 D1·与 projects 同形态的独立视图模块·挂载/卸载在 renderRoute 接线）
import * as historyView from "./history.js";
import * as setup from "./setup.js";
import * as segcards from "./segcards.js";
import * as edit from "./edit.js";
// 批 R3 · ② A05：项目预览 TAB 实装（操作条+全片预览+胶片条 · v43 :1194-1212）
import * as preview from "./preview.js";
import { showToast } from "../ui/toast.js";
// S3-4 B2 · A006：通知中心（铃铛 + notif-panel + 未读红点 · 事件源=core/submit 轮询终态）
import { mountNotifCenter } from "../ui/notif.js";
// 批 R0 · J1：原型 data-ic 图标体系（ICONS/ic/hydrateIcons 照搬 v43 :2424-2453）
import { hydrateIcons } from "../ui/icons.js";
// T8 · #52 首启体检（数据层：取数+判定·UI 渲染在本文件壳层内）
import { runHealthcheck, HEALTH_GUIDE } from "../ui/healthcheck.js";
// S1-2 T7：设置页实装包（四件 + 顶栏三态芯片真实探测）
import * as settings from "./settings.js";
import * as aiArchive from "./ai-archive.js";
// S1-4 T1：资产库视图实装包（E001-E007 · 占位壳转正）
import * as assets from "./assets.js";
// S1-4 T3：创作画布视图实装包（E008-E029 · 节点/连线/全局/历史/保存）
import * as canvas from "./canvas.js";
// S3-4 B7（A013/A014）：文档级全局键——Ctrl+K 全局搜索 / ? 快捷键帮助（任意视图可触发）
// 批 0-T4：右上工具簇搜索钮复用同款面板（openSearchModal）
import { installGlobalKeys, openSearchModal } from "../ui/guide.js";
// 批 1-T3 · C3：统一进度条（阶段文案+已等待计时 · 1.0 progress_bar.js 口径）
import { renderProgress, parseRunStamp } from "../ui/progress.js";
// 批 9 T3 · 17-4：「⋯ 更多」弹层经 anchor helper 锚定（F37 手法——resize/滚动跟随锚点）
import { followAnchor } from "../ui/anchor.js";
// T6（地基批1档2 · 账本 #59-③件 + 验收7 UI 面）：回前台全量重拉（数据服务就绪判定 + 重拉出口）
import { isReady, resyncAll } from "../core/server_storage.js";
import { t, getLang, setLang } from "../core/i18n.js";   // #89 T1b：壳层文案取词（U-批 U3 补 getLang/setLang·语言快切）

// ===== S1-2 T5：拼接口径三档（项目顶栏 + 画布 G 节点模式下拉共用）=====
// 战役批1-T6 · F-81：原为 buildProjectTopbar 内的局部 const（ES 模块禁止函数内 export），
//   画布 G 节点要同款三档 → 整段上提至模块顶层并 export（行为不变，顶栏引用改用本常量）。
export const PROJ_MODE_OPTS = [
  { value: "分镜", label: t("shell.mode.story"), title: t("shell.mode.storyTip") },
  { value: "拼接", label: t("shell.mode.concat"), title: t("shell.mode.concatTip") },
  { value: "自定义", label: t("shell.mode.custom"), title: t("shell.mode.customTip") },
];

// ===== 路由纯函数 =====

export function parseRoute(hash) {
  const s = String(hash || "").replace(/^#/, "");
  if (s === "" || s === "/") return { view: "home" };
  const [pathRaw, queryRaw] = s.split("?");
  const path = pathRaw || "";
  const params = new URLSearchParams(queryRaw || "");
  if (path === "/projects") return { view: "projects" };
  // #36 左侧栏「历史记录」tab（与项目管理平级的独立视图·非项目工作区 TAB）
  if (path === "/history") return { view: "history" };
  const mProj = path.match(/^\/project\/([^/]+)$/);
  if (mProj) {
    return {
      view: "project",
      projectId: decodeURIComponent(mProj[1]),
      tab: params.get("tab") || "preview",
    };
  }
  // S1-4 E008：/canvas?p=<projectId> 带项目进画布（空 p=独立未命名画布）
  if (path === "/canvas") return { view: "canvas", projectId: params.get("p") || null };
  if (path === "/assets") return { view: "assets" };
  // B6-T4 裁决扩界（2026-09-29 主代理）：/ai?p=<projectId> 带项目上下文进 AI 协作——
  // 智能拆镜采纳/T5 互导的「当前项目」来源；无 p → 空串（视图内无项目守卫照旧）
  if (path === "/ai") return { view: "ai", p: params.get("p") || "" };
  if (path === "/settings") return { view: "settings" };
  return { view: "home" };
}

export function serializeRoute(state) {
  const v = state && state.view;
  if (!v || v === "home") return "";
  if (v === "project") {
    const id = state.projectId || "";
    const tab = state.tab && state.tab !== "preview" ? `?tab=${encodeURIComponent(state.tab)}` : "";
    return `/project/${encodeURIComponent(id)}${tab}`;
  }
  // S1-4 E008：canvas 带项目参数（刷新/前进后退可恢复绑定）
  if (v === "canvas" && state.projectId) return `/canvas?p=${encodeURIComponent(state.projectId)}`;
  // B6-T4 裁决扩界：ai 带项目参数（同 canvas 口径——刷新/前进后退可恢复绑定）
  if (v === "ai" && state.p) return `/ai?p=${encodeURIComponent(state.p)}`;
  return "/" + v.replace(/^\//, "");
}

// ===== 路由状态机 =====

export function createRouter(opts = {}) {
  // 浏览器环境：取 globalThis.location/history；Node 测环境：fallback fakeLocation（带 pathname）
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  const hasBrowserLocation = g.location && typeof g.location.hash === "string";
  const location = opts.location || (hasBrowserLocation ? g.location : makeFakeLocation(""));
  const history = opts.history || (g.history && typeof g.history.pushState === "function" ? g.history : null);
  const subs = new Set();

  function read() {
    return parseRoute(location.hash || "");
  }

  let current = read();

  function notify(prev, next) {
    // B6-T4 裁决扩界：p 入等值比较——#/ai?p=A → #/ai?p=B 须触发重挂（AI 视图换绑项目）
    if (prev.view === next.view && prev.projectId === next.projectId && prev.tab === next.tab && prev.p === next.p) {
      return false;
    }
    current = next;
    for (const fn of subs) {
      try { fn(next, prev); } catch (_e) { /* 单订阅者错不污染主链 */ }
    }
    return true;
  }

  function go(routeStr) {
    const next = parseRoute(routeStr);
    const ok = notify(current, next);
    if (!ok) return;
    const newHash = serializeRoute(next);
    // 写入 hash：浏览器侧优先用 history.pushState（不触发 hashchange，避免回环）；
    // Node 测/无 history 时直接写 location.hash。两者都更新 location.hash 以便外部读取。
    if (history && typeof history.pushState === "function") {
      const baseUrl = (location.pathname || "/") + "#" + newHash;
      history.pushState(null, "", baseUrl);
    }
    if (location && "hash" in location) {
      location.hash = "#" + newHash;
    }
  }

  function subscribe(fn) {
    subs.add(fn);
    return function unsubscribe() { subs.delete(fn); };
  }

  function currentFn() { return current; }
  function locationFn() { return location; }

  if (typeof globalThis !== "undefined" && globalThis.addEventListener && location === globalThis.location) {
    globalThis.addEventListener("hashchange", () => {
      const next = read();
      notify(current, next);
    });
  }

  return {
    current: currentFn,
    go,
    subscribe,
    location: locationFn,
  };
}

// ===== NAV_ITEMS · 左栏导航（v43 六项形态：含"首页" · 2026-09-24 老板令恢复首页入口） =====
// 注：原详案钦点 v35 五项（门户由空 hash 路由承载不占左栏位）——老板实测反馈"左栏无首页入口，
// 占位至少要有入口并文字提示"，恢复 v43 六项（首页=门户视图）
// 批 R0 · J1：icon = 原型 data-ic 名（v43 :1042-1047 实测），替换原 unicode 字符（⌂▣▤▥✦⚙）
// #36（2026-10-20）加「历史记录」项（七项）·icon=film（胶片=历史·与项目工作区 preview TAB 同族）
export const NAV_ITEMS = [
  { view: "home", label: t("shell.nav.home"), icon: "home" },
  { view: "canvas", label: t("shell.nav.canvas"), icon: "canvas" },
  { view: "projects", label: t("shell.nav.projects"), icon: "folder" },
  { view: "history", label: t("shell.nav.history"), icon: "film" },
  { view: "assets", label: t("shell.nav.assets"), icon: "image" },
  { view: "ai", label: t("shell.nav.ai"), icon: "sparkle" },
  { view: "settings", label: t("shell.nav.settings"), icon: "sliders" },
];

// ===== NAV_PENDING_MAP · 左栏空挂角标归属（2026-09-25 对账单订正） =====
//   - canvas/assets（S1-4）已实装关账 → 撤出本表，title=label 与「设置」项同形态
//   - ai（§7.13 S3-4）批 R5 整页实装 → 同步撤出（占位壳文案在实装后就是失实登记）
//   - 本表现暂空：后续新增空挂项在此登记（机制保留，buildSidenav 查表补 title 尾缀）
const NAV_PENDING_MAP = {};

// ===== PROJ_TABS · 项目工作区 TAB（v43 :1187-1191 实测） =====
// 批 R7 · B08：icon = 原型 data-ic 名（v43 :1188-1190 film/sliders/scissors），渲染 15px
export const PROJ_TABS = [
  { key: "preview", label: t("shell.tab.preview"), icon: "film" },
  { key: "setup", label: t("shell.tab.setup"), icon: "sliders" },
  { key: "edit", label: t("shell.tab.edit"), icon: "scissors" },
];

// ===== TAB 索引转换 =====
export function tabIndexByKey(key) {
  const idx = PROJ_TABS.findIndex((tb) => tb.key === key);
  return idx >= 0 ? idx : 0;
}
export function tabKeyByIndex(idx) {
  const tb = PROJ_TABS[idx];
  return tb ? tb.key : "preview";
}

// ===== view → nav 项 =====
export function navItemForView(view) {
  if (view === "project") return NAV_ITEMS.find((i) => i.view === "projects") || null;
  // #36：「历史记录」与其它项同形态（view 一一对应·通用查找即命中）
  return NAV_ITEMS.find((i) => i.view === view) || null;
}

// ===== 项目名 =====
export function getProjectName(project) {
  if (!project) return t("shell.name.unnamed");
  const n = project.name;
  if (typeof n === "string" && n.trim() !== "") return n;
  return t("shell.name.unnamed");
}

// ===== 工具 =====
// S1-1 修 5 节点门修正：模块级单例追踪 pmenu 的 document click 监听句柄，
//   确保路由切换 / 二次 mount 时只挂一份监听（避免 N 次进入堆 N 个监听）
let _pmenuDocClickHandler = null;
// 批 9 T3 · 17-4：pmenu 锚定句柄（followAnchor·模块级单例配对 pmenu——hide 即 detach 防泄漏）
let _pmenuAnchor = null;
function _pmenuHide(pmenu) {
  pmenu.style.display = "none";
  if (_pmenuAnchor) { _pmenuAnchor.detach(); _pmenuAnchor = null; }
}
// 批1-T5 · H4：提交栏 handle 单例追踪（renderRoute 顶部 unmount·同 pmenu 防累积口径）
let _submitBarHandle = null;
function makeFakeLocation(initialHash = "") {
  let hash = initialHash;
  return {
    get hash() { return hash; },
    set hash(v) { hash = String(v); },
    pathname: "/",
  };
}

// ===== DOM 构造辅助 =====
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

// #63 T4：快照字段回填用深拷贝（快照是 JSON 态·断开与缓存对象共享）
function _jsonClone(v) {
  try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (_e) { return v; }
}

// ===== B010 菜单项（工作区顶栏「⋯ 更多」弹菜单）=====
// 批 R8 · R7-3：菜单项图标位（v43 :2098-2103 pmenu 四项 folder/download/plus/sliders 14）
function menuItem(label, onClick, icon) {
  const it = el("div", { class: "ctx-item", "data-menu-item": label });
  if (icon) it.appendChild(el("span", { "data-ic": icon, "data-sz": "14" }));
  it.appendChild(document.createTextNode(label));
  it.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof onClick === "function") onClick(e);
  });
  return it;
}

// ============================================================================
// W-02/W-03 转正（自主排期批 1·2026-09-27）：导入/导出 CSV 真链路
//   pmenu 是模块级单例（首次建 DOM 常驻），回调不能闭包 buildProjectTopbar 的
//   首次局部 state —— 模块级锚 _csvCtxProjectId 每次进入项目视图时刷新。
// ============================================================================
let _csvCtxProjectId = null;

// H-T4 R-04：「⋯ 更多 → 打开文件夹」接真（W-04 registerPending 空挂退场·POST /gui13-fs/open_dir 同源伴生
//   ·edit.js gui13OpenDirPost 先例形态）；403/404/网络失败 → 白话三分（不裸抛 error code）。
//   批 L1 · T2 · R-27（口径变更）：已设 server_output_dir → 行为不变；**未设 → 不再发 {path:null}**，
//   改发「最近一次任务成片 dirname」（数据源+回退链+失败 toast 同概况页 R-27 口径·见 _openProjectFinalDir）。
//   本文件内共享小函数（不跨文件 import·R-31 登记收敛候选）。
//   R-59-T2b（2026-10-11）：workspace_root 非空 → 优先开工作区根（旧 server_output_dir 通道已退役·保留为次级回退）。
async function _openProjectFolder() {
  const ws = loadWorkspaceRoot();
  const dir = ws || settings.loadPaths().server_output_dir.trim();
  const target = dir || await _openProjectFinalDir();
  if (!target) return;   // 成片链取不到（已弹白话 toast·不发包）
  // R-31 收敛：发包+三分文案移 core/open_dir.js（动词=文件夹·网络失败白话口径·成功零 toast）
  await openDirRequest(target, { toast: showToast, verb: "文件夹", plainNetworkError: true });
}
// 批 L1 T2 R-27：未设 server_output_dir 时的成片目录解算
//   store.latestMainRunStem(runs) → GET /h3_batch/history/detail（直连 request 拿 raw·concat 只在 raw 顶层）
//   → concat.file 的 dirname；concat 空 → shots 首个非空 run_dir（sid 字典序）；全空 → 白话 toast。取不到返 ""。
async function _openProjectFinalDir() {
  const stem = latestMainRunStem((storeLoad(_csvCtxProjectId) || {}).runs);
  if (!stem) { showToast("info", t("shell.openDir.noProduct")); return ""; }
  const r = await request("/h3_batch/history/detail?task_id=" + encodeURIComponent(stem), { cache: "no-store" });
  if (!r.ok) {
    const st = (r.error && r.error.httpStatus) || 0;
    showToast("error", (!st || st >= 500) ? t("shell.openDir.histFail") : t("shell.openDir.histMissing"));
    return "";
  }
  const raw = r.data || {};
  // #26-T3b：成片取径与成片条同口径（resolveRunFilmPath）——concat.file 优先不回退，
  //   缺失（手动/自动拼新成片只落 _concat_history）→ 最新一条 output；目录推导不变（dirname 或 shots 链）。
  const film = resolveRunFilmPath(raw);
  if (film) return film.replace(/[\\/][^\\/]+$/, "");
  const runDir = firstRunDirFromShots(raw.shots);   // R-31 收敛：core/open_dir.js 单源（原内联 run_dir 解析·R-31 登记收敛候选）
  if (runDir) return runDir;
  showToast("info", t("shell.openDir.noProduct"));
  return "";
}

// W-07 六入口转正（自主排期批 4·2026-09-27）：运行记录区真功能
//   引擎通道钥匙 = 任务句柄 runTaskId（submit 落账携带 stem）；旧记录（无句柄）相关入口降级提示。
//   看成片：history/detail → 各段产物 files+run_dir → 弹窗列表 → /h3_batch/video 流式播放
//   批 1-T3 · D4：弹窗加「成片」条（concat.file）→ GUI 内浮层播放（edit.showFinalPreview）
//   按版本回退 / 导入配置：history/config（generate_csv 旁车快照）→ 复用 csv_transfer 逆向映射回填
//   按此版本拼接：concat dry_run 预演 → 确认 → 启动（edit.js 导出成片同链路·同步响应无轮询）
//   编辑：备注文字 openPrompt 改写 runs[0].memo；复制为新项目：当前项目深拷贝副本
// #53（批5-T1·2026-10-29）：postfx 行（kind:"postfx"）带 taskId 不带 stem 置顶成现行行，
//   守卫只认 stem → 六入口全拒。任务句柄统一 stem||taskId（postfx 的 taskId 即主链任务号，
//   postfx_pipeline.js:482-505）；两者皆无的真旧记录仍被守卫拒绝。
export function runTaskId(run) {
  return (run && (run.stem || run.taskId)) || "";
}

async function _runActionGuard(run, needTaskId = true) {
  if (typeof document === "undefined") return false;
  if (needTaskId && !runTaskId(run)) {
    showToast("info", t("shell.guard.noTask"));
    return false;
  }
  return true;
}

// F70（批 10-J-T3）：任务级同种子重跑（运行记录区「重跑…」二级·edit.js sameSeedRerunAll 同构）
//   二段式：首调不带 force（引擎 confirm_required）→ 确认 → force:true 重发 → runRerunFlow（submit 注入）
async function _rerunSameSeedTask(projectId) {
  if (typeof document === "undefined") return;
  const p = projectId ? storeLoad(projectId) : null;
  const run = (p && Array.isArray(p.runs)) ? p.runs[0] : null;
  if (!(await _runActionGuard(run))) return;
  const taskId = runTaskId(run);
  const first = await sameSeed({ taskId, source: "task" });
  if (!first || !first.ok) {
    showToast("error", t("shell.rerun.sameSeedFail", { msg: (first && first.error && first.error.msg) || (first && first.error && first.error.code) || t("settings.err.unknown") }));
    return;
  }
  const flow = (submit) => runRerunFlow({ projectId, taskId, sids: [], label: "同种子重跑", kind: "rerun", submit });
  if (!first.confirmRequired && first.started) { void flow(() => Promise.resolve(first)); return; }
  openConfirmModal({
    title: t("shell.rerun.sameSeedTitle"),
    sub: t("shell.rerun.sameSeedSub"),
    confirmText: t("shell.rerun.confirm"),
    onConfirm: () => { void flow(() => sameSeed({ taskId, source: "task", force: true })); },
  });
}

// F70：改参数重跑按段——运行记录区无段落选上下文（引擎任务级）→ 提示进剪辑页选段（不静默）
function _rerunParamsToEdit(projectId, router) {
  showToast("info", t("shell.rerun.toEditToast"));
  if (router && projectId) router.go(`/project/${encodeURIComponent(projectId)}?tab=edit`);
}

// F70：运行记录区「重跑…」二级弹层（轻弹层·pmenu 单例 + followAnchor 惯例·ESC/外点/选中即关）
let _runRerunMenu = null;
let _runRerunAnchor = null;
let _runRerunDocClick = null;
let _runRerunDocKey = null;
function _runRerunMenuHide() {
  if (_runRerunMenu) _runRerunMenu.style.display = "none";
  if (_runRerunAnchor) { _runRerunAnchor.detach(); _runRerunAnchor = null; }
  if (typeof document !== "undefined") {
    if (_runRerunDocClick) { document.removeEventListener("click", _runRerunDocClick); _runRerunDocClick = null; }
    if (_runRerunDocKey) { document.removeEventListener("keydown", _runRerunDocKey); _runRerunDocKey = null; }
  }
}
function _openRunRerunMenu(anchorEl, projectId, router) {
  if (typeof document === "undefined") return;
  // 每次经 document 查回单例（不靠模块级缓存指针）：document 换新（测试/清树）时旧节点成孤儿，
  //   缓存指针会指向已脱离的节点 → 菜单不可见（同 edit.js B5-T1③b pmenu 孤儿债的同款修法）
  const m = document.getElementById("runRerunMenu") || el("div", { class: "pmenu", id: "runRerunMenu", "data-pmenu": "run-rerun" });
  if (!m.parentNode) document.body.appendChild(m);
  _runRerunMenu = m;
  if (!_runRerunDocClick) {
    _runRerunDocClick = () => { _runRerunMenuHide(); };
    _runRerunDocKey = (e) => { if (e && e.key === "Escape") _runRerunMenuHide(); };
    document.addEventListener("click", _runRerunDocClick);
    document.addEventListener("keydown", _runRerunDocKey);
  }
  clearChildren(m);
  const items = [
    [t("shell.rerun.sameSeedTitle"), "refresh", () => { void _rerunSameSeedTask(projectId); }],
    [t("shell.rerun.editParams"), "sliders", () => { _rerunParamsToEdit(projectId, router); }],
  ];
  for (const [label, icon, fn] of items) {
    m.appendChild(menuItem(label, () => { _runRerunMenuHide(); fn(); }, icon));
  }
  hydrateIcons(m);
  if (_runRerunAnchor) _runRerunAnchor.detach();
  _runRerunAnchor = followAnchor(anchorEl, m, { side: "below", gap: 4 });
  m.style.display = "block";
}

// B4-T2 D2：顶栏「只重渲失败段」通道（守卫 runs[0] 无任务句柄·toast 同 _runActionGuard 口径）
async function _rerunFailedSegments(projectId) {
  if (typeof document === "undefined") return;
  const p = projectId ? storeLoad(projectId) : null;
  const run = (p && Array.isArray(p.runs)) ? p.runs[0] : null;
  if (!(await _runActionGuard(run))) return;
  const taskId = runTaskId(run);
  const r = await request(`/h3_batch/history/detail?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
  if (!r.ok || !r.data || !r.data.shots) {
    showToast("error", t("shell.rerun.detailFail", { msg: (r.error && r.error.msg) || t("shell.common.engineDownQ") }));
    return;
  }
  // detail shots 是 dict（shot_NNN 键）→ Object.entries 注入 sid 归一成数组（edit.js :3487-3490 同款）
  const shotsRaw = r.data.shots;
  const shotsObj = (shotsRaw && typeof shotsRaw === "object" && !Array.isArray(shotsRaw))
    ? shotsRaw
    : (Array.isArray(shotsRaw) ? Object.fromEntries(shotsRaw.map((s) => [s.sid, s])) : {});
  const sids = defaultSelection(Object.entries(shotsObj).map(([sid, s]) => ({ ...(s || {}), sid })));
  if (!sids.length) {
    showToast("info", t("shell.rerun.noFailed"));
    return;
  }
  void runRerunFlow({ projectId, taskId, sids, keepSeed: false, label: "只重渲失败段", kind: "rerun" });
}

// #26 T3：成片条取径——concat.file 优先不回退（自动拼接现行指针）；缺失（含空串）→
//   _concat_history 最新一条（detail 端点透出·append 末位=最新·手动/自动拼产物一致可见）；
//   两者皆缺 → ""。导出便于测试（锁④）。
// #50 调和：账本出现过后期拼接记录（E5 落账 postfx:true）→ 最新条目胜出（末位可能是
//   后期件或之后的手动件·都算用户最新行为）；末位 output 空 → 落回现行链（不硬失败）。
//   无 postfx 条目 → 现行优先级逐字节保留。output 判据=非空字符串（不做文件系统 stat——
//   GUI 不跨盘探测引擎路径）。
export function resolveRunFilmPath(data) {
  const d = data && typeof data === "object" ? data : {};
  const hist = Array.isArray(d._concat_history) ? d._concat_history : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  if (hist.some((h) => h && h.postfx === true) && last && typeof last.output === "string" && last.output) return last.output;
  if (d.concat && typeof d.concat.file === "string" && d.concat.file) return d.concat.file;
  return last && typeof last.output === "string" ? last.output : "";
}

async function _viewRunFilms(run, opts = {}) {
  if (!(await _runActionGuard(run))) return;
  const taskId = runTaskId(run);
  const r = await request(`/h3_batch/history/detail?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
  if (!r.ok || !r.data || !r.data.shots) {
    showToast("error", t("shell.films.detailFail", { msg: (r.error && r.error.msg) || t("shell.common.engineDownQ") }));
    return;
  }
  const items = [];
  // ===== 批 1-T3 · D4：成片（拼接产物）——history/detail `concat.file`（api.md #17）=====
  //   自动拼接（拼接模式批收尾）落 `_concat.file`（batch_core.py:11537 归类落账）；手动拼接
  //   （导出成片/按版本拼接）只落 `_concat_history` 账本（__init__.py:5139 注记）→ 本入口按 concat.file 挂成片条。
  //   #26 T3 裁决①：兼读 `_concat_history` 最新一条（resolveRunFilmPath）——手动/自动拼产物一致可见。
  const _film = resolveRunFilmPath(r.data);
  if (_film) items.push({ label: t("shell.films.filmChip"), path: _film, film: true });
  // ===== R-19（批 10-P P-T5）：分段列产物——段号=该次运行 sid 数值原序·失败/中止段也列出
  //   （去除旧「无 files 跳过」过滤·带成败态标记）·成功段点行播放·只读不触 mainClips。
  const _stMark = (s) => (s === "success" ? [t("shell.films.stOk"), "ok"] : (s === "failed" ? [t("shell.films.stFail"), "bad"] : (s === "stopped" ? [t("shell.films.stStop"), "stop"] : [s || t("shell.films.stUnknown"), "stop"])));
  for (const [sid, s] of Object.entries(r.data.shots)) {
    const ms = String(sid).match(/shot_(\d+)/) || String(sid).match(/^s(\d+)$/);
    const segNo = ms ? t("shell.films.segN", { n: parseInt(ms[1], 10) }) : String(sid);
    const [mark, cls] = _stMark(s && s.status);
    const files = (s && Array.isArray(s.files)) ? s.files : [];
    if (!files.length) {
      items.push({ head: `${segNo} · ${sid} · `, mark, cls, none: true });
      continue;
    }
    for (const f of files) {
      items.push({ head: `${segNo} · ${sid} · `, mark, cls, file: f, path: (s.run_dir || "") + "\\" + f });
    }
  }
  if (!items.length) { showToast("info", t("shell.films.empty")); return; }
  const body = el("div", { style: "font-size:12px;color:var(--txt2);max-height:260px;overflow:auto" });
  for (const it of items) {
    if (it.film) {
      const b = el("div", { class: "fchip", style: "padding:4px 10px;margin:4px 0;cursor:pointer;display:inline-block", text: "▶ " + it.label });
      b.addEventListener("click", () => {
        // 成片 → GUI 内浮层播放（D4·1.0 final_preview 口径）；段产物 → 新标签页流式（既有行为）
        try { edit.showFinalPreview({ path: it.path, title: t("shell.films.playTitle", { taskId }) }); }
        catch (_e) { showToast("error", t("shell.films.playFail")); }
      });
      body.appendChild(b);
      continue;
    }
    const row = el("div", { class: `vrf-row ${it.cls}${it.none ? " none" : ""}` });
    row.appendChild(document.createTextNode((it.path ? "▶ " : "") + it.head));
    row.appendChild(el("span", { class: "vrf-st", text: it.mark }));
    if (it.file) row.appendChild(document.createTextNode(" · " + it.file));
    if (it.path) {
      row.addEventListener("click", () => {
        try {
          // 批 C #13：window.open 无 onerror 回落通道——按芯片态判路：已连接=引擎口（既有）；
          // 未连接=本地流 /gui13-fs/media（引擎离线 502 白页治）+ 离线提示。
          if (settings.getChipState() === "connected") {
            window.open(mediaUrl("video", it.path), "_blank");   // 批 B #13：URL 收敛单源（引擎口直达）
          } else {
            window.open(localMediaUrl("video", it.path), "_blank");
            showToast("info", t("shell.films.localPlay"));
          }
        } catch (_e) { showToast("error", t("shell.films.openFail")); }
      });
    }
    body.appendChild(row);
  }
  const _when = run.at ? ` · ${run.at}` : "";
  const _which = opts.current ? t("shell.run.cur") : t("shell.films.hist");
  openModalBox({
    title: t("shell.films.title", { which: _which, taskId, when: _when }),
    sub: _film
      ? t("shell.films.subFilm")
      : t("shell.films.subSegs"),
    contentNode: body,
    closeOnBackdrop: true,
  });
}

function _duplicateCurrentProject(router, projectId) {
  const pid = projectId || _csvCtxProjectId;
  const src = pid ? storeLoad(pid) : null;
  if (!src) { showToast("error", t("shell.dup.notFound")); return null; }
  try {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = "p-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    copy.name = (src.name || "未命名") + "·副本";
    copy.createdAt = undefined; copy.updatedAt = undefined;
    copy.runs = []; // 副本不带运行历史（历史归属原项目）
    storeSave(copy);
    showToast("success", t("shell.dup.done", { name: copy.name }));
    if (router) router.go("/projects");
    return copy;
  } catch (_e) {
    showToast("error", t("shell.dup.fail"));
    return null;
  }
}

// #63 T5：旧记录降级常量——引擎快照恢复面=可逆键；现行 UI 生效丢弃面四键（方案 §二档2 v1.2）
const LEGACY_IRREVERSIBLE_KEYS = ["审片门", "配乐", "氛围声", "模板"];
const UNRECOVERABLE_TITLE = t("shell.run.unrecoverable");

function _markRunBtnUnavailable(btn, title) {
  if (!btn) return;
  if (btn.classList && typeof btn.classList.add === "function") btn.classList.add("off");
  try { btn.title = title; } catch (_e) { /* 非 DOM 桩 */ }
}

// #63 T5：旧记录载入降级——引擎 /h3_batch/history/config（generate_csv 旁车快照）→
//   ai_snapshot 可逆映射回填 → 段身份按同下标沿用现 id → 时间线按任务重建 → 如实标「部分恢复」。
//   引擎快照也没有（400）→ 按钮置灰 + title「该记录未留快照·不可恢复」。
export async function loadLegacyRunRecord(projectId, run, btn) {
  const taskId = runTaskId(run);
  if (!taskId) {
    _markRunBtnUnavailable(btn, UNRECOVERABLE_TITLE);
    showToast("info", UNRECOVERABLE_TITLE);
    return { ok: false, reason: "no_task" };
  }
  const cfg = await importConfig({ taskId });
  if (!cfg.ok) {
    const status = (cfg.error && cfg.error.httpStatus) || 0;
    if (status === 400) {
      _markRunBtnUnavailable(btn, UNRECOVERABLE_TITLE);
      showToast("info", UNRECOVERABLE_TITLE);
      return { ok: false, reason: "no_engine_snapshot" };
    }
    showToast("error", t("shell.legacy.snapFail", { msg: (cfg.error && (cfg.error.msg || cfg.error.code)) || t("shell.common.engineDownQ") }));
    return { ok: false, reason: "config_failed" };
  }
  const p = storeLoad(projectId);
  if (!p) { showToast("error", t("shell.legacy.noProject")); return { ok: false, reason: "no_project" }; }
  const oldIds = (Array.isArray(p.segments) ? p.segments : []).map((s) => s && s.id);
  const applied = snapshotToStore(cfg.config, p);
  if (!applied.ok) {
    showToast("error", t("shell.legacy.applyFail", { reason: applied.reason }));
    return { ok: false, reason: "apply_failed" };
  }
  // 保段身份：引擎快照行序 ↔ 现有段同下标沿用原 id（applyHistory 载入同款下标约定）
  p.segments.forEach((s, i) => { if (oldIds[i]) s.id = oldIds[i]; });
  const rowPostfx = _postfxFromRow(run);
  if (rowPostfx) _overlayPostfxParams(p.globalParams || (p.globalParams = {}), rowPostfx);
  storeSave(p);
  try {
    await edit.applyHistory(taskId, { projectId, auto: false });
  } catch (_e) { /* applyHistory 内建错误 toast；参数已生效 */ }
  const st = (storeLoad(projectId) || {}).editingState || {};
  if (st.loadedTaskId !== taskId) updateEditingState(projectId, { loadedTaskId: taskId });
  showToast("info", t("shell.legacy.partialDone", { taskId, note: t("shell.legacy.partialNote", { keys: LEGACY_IRREVERSIBLE_KEYS.join("/") }) }));
  return { ok: true, taskId, partial: true, droppedKeys: applied.droppedKeys || [] };
}

// #63 T5：历史行「载入此记录」入口——有本地快照走快照；无快照/写失败行走引擎降级。
//   快照文件被外部清理（recordId 在但读不到）→ 点击后明确报错 + 按钮置灰（选实现小者）。
export async function loadRunRecordFromRow(projectId, run, btn) {
  const r = run && typeof run === "object" ? run : {};
  const recordId = typeof r.recordId === "string" ? r.recordId : "";
  const hasLocal = !!recordId && r.snapshot !== false;
  if (hasLocal) {
    const res = await loadRunRecord(projectId, recordId);
    if (!res.ok && res.reason === "snapshot_unreadable") {
      _markRunBtnUnavailable(btn, t("shell.run.snapUnreadableTitle"));
    }
    return res;
  }
  return loadLegacyRunRecord(projectId, r, btn);
}

// #63 T5：复制为新项目——按所选记录快照生成（参数=当时值 + 时间线按该记录任务重建 + runs 清空 +
//   名称标来源项目/记录）；postfx 行回溯主任务快照并叠加该行后期参数；无可用快照 → 当前实体复制兜底。
export async function duplicateRunProject(projectId, run, router) {
  const pid = projectId || _csvCtxProjectId;
  const src = pid ? storeLoad(pid) : null;
  if (!src) { showToast("error", t("shell.dup.notFound")); return { ok: false, reason: "no_project" }; }
  const r = run && typeof run === "object" ? run : {};
  const recordId = typeof r.recordId === "string" ? r.recordId : "";
  let resolved = null;
  const own = recordId ? await loadRunSnapshot(pid, recordId) : null;
  if (own && typeof own === "object") {
    resolved = await _resolveSnapshotForParams(pid, own);
  } else if (r.kind === "postfx") {
    // 后期行自身快照缺失 → 退主任务快照 + 行内后期参数
    const mainId = await findMainSnapshotId(pid, runTaskId(r));
    const main = mainId ? await loadRunSnapshot(pid, mainId) : null;
    if (main && typeof main === "object") resolved = { params: main, postfx: _postfxFromRow(r) };
  }
  if (!resolved) {
    const fallbackCopy = _duplicateCurrentProject(router, pid);
    showToast("info", t("shell.dup.noSnap"));
    return { ok: !!fallbackCopy, fallback: true, projectId: fallbackCopy ? fallbackCopy.id : "" };
  }
  try {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = "p-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    copy.name = `${src.name || "未命名"}·副本（源记录 ${recordId || _snapTaskId(resolved.params) || "未知"}）`;
    copy.createdAt = undefined; copy.updatedAt = undefined;
    copy.runs = []; // 副本不带运行历史（历史归属原项目）
    copy.currentRunId = "";
    copy.editingState = Object.assign({}, copy.editingState || {}, {
      mainClips: [], altClips: [], loadedTaskId: null,
    });
    _applySnapshotParams(copy, resolved.params);
    if (resolved.postfx) _overlayPostfxParams(copy.globalParams || (copy.globalParams = {}), resolved.postfx);
    storeSave(copy);
    const taskId = _snapTaskId(resolved.params);
    if (taskId) {
      try {
        await edit.applyHistory(taskId, { projectId: copy.id, auto: false });
      } catch (_e) { /* applyHistory 内建错误 toast；参数已生效 */ }
      const st = (storeLoad(copy.id) || {}).editingState || {};
      if (st.loadedTaskId !== taskId) updateEditingState(copy.id, { loadedTaskId: taskId });
    }
    showToast("success", t("shell.dup.doneSnap", { name: copy.name, rid: recordId || taskId }));
    if (router) router.go("/projects");
    return { ok: true, projectId: copy.id, recordId, taskId };
  } catch (_e) {
    showToast("error", t("shell.dup.fail"));
    return { ok: false, reason: "copy_failed" };
  }
}

async function _applyRunConfig(run, projectId, actionLabel) {
  if (!(await _runActionGuard(run))) return;
  const r = await request(`/h3_batch/history/config?task_id=${encodeURIComponent(runTaskId(run))}`, { cache: "no-store" });
  if (!r.ok || !r.data || !r.data.config) {
    showToast("error", t("shell.runCfg.snapFail", { label: actionLabel, msg: (r.error && r.error.msg) || t("shell.runCfg.noSnapMsg") }));
    return;
  }
  const cfg = r.data.config;
  const segments = rowsToSegments(Array.isArray(cfg.shots) ? cfg.shots : [], _mkImportSeg);
  if (!segments.length) { showToast("error", t("shell.runCfg.noSegs", { label: actionLabel })); return; }
  const patch = engineGlobalsToParams(cfg.globals || {});
  openConfirmModal({
    title: actionLabel,
    sub: t("shell.runCfg.sub", { at: run.at || run.stem, n: segments.length, globals: Object.keys(patch).length ? t("shell.runCfg.globals") : "" }),
    confirmText: actionLabel,
    onConfirm: () => {
      const p = storeLoad(projectId);
      if (!p) return;
      p.segments = segments;
      if (!p.globalParams || typeof p.globalParams !== "object") p.globalParams = {};
      Object.assign(p.globalParams, patch);
      storeSave(p);
      showToast("success", t("shell.runCfg.done", { label: actionLabel, n: segments.length }));
    },
  });
}

// #63 T5：快照 → 项目参数回填（载入/复制共用；旧快照缺 loraOverrides/anchorMirror → 跳过保现值）
function _snapTaskId(snap) {
  return String((snap && (snap.stem || snap.taskId)) || "").trim();
}

function _applySnapshotParams(p, snap) {
  const s = snap && typeof snap === "object" ? snap : {};
  // 快照即提交时刻用户原文态：整段替换（快照内段 id 原样保留）
  p.segments = Array.isArray(s.segments) ? _jsonClone(s.segments) : p.segments;
  p.globalParams = (s.globalParams && typeof s.globalParams === "object") ? _jsonClone(s.globalParams) : {};
  p.globalPrompt = typeof s.globalPrompt === "string" ? s.globalPrompt : "";
  if (typeof s.projMode === "string") p.projMode = s.projMode;
  if (Number.isFinite(+s.runCount)) p.runCount = +s.runCount;
  p.loraChain = Array.isArray(s.loraChain) ? _jsonClone(s.loraChain) : [];
  p.modelOverrides = (s.modelOverrides && typeof s.modelOverrides === "object") ? _jsonClone(s.modelOverrides) : {};
  p.castBindings = Array.isArray(s.castBindings) ? _jsonClone(s.castBindings) : [];
  p.poolManual = (s.poolManual && typeof s.poolManual === "object") ? _jsonClone(s.poolManual) : {};
  p.loraTplState = (s.loraTplState && typeof s.loraTplState === "object") ? _jsonClone(s.loraTplState) : {};
  if (s.loraOverrides && typeof s.loraOverrides === "object") p.loraOverrides = _jsonClone(s.loraOverrides);
  if (typeof s.anchorMirror === "string") p.anchorMirror = s.anchorMirror;
}

// postfx 行参数（行内权威值；快照 postfx 分支同形）
function _postfxFromRow(run) {
  const r = run && typeof run === "object" ? run : {};
  if (r.kind !== "postfx") return null;
  return {
    kinds: Array.isArray(r.kinds) ? r.kinds.slice() : [],
    engineChoice: r.engineChoice,
    ...(r.upscaleParams ? { upscaleParams: r.upscaleParams } : {}),
    ...(r.interpParams ? { interpParams: r.interpParams } : {}),
  };
}

// 后期参数叠加到项目全局参数（plan → globalParams.postfx_* 反解·与 buildPostfxPlan 互逆）
function _overlayPostfxParams(gp, postfx) {
  if (!gp || typeof gp !== "object" || !postfx || typeof postfx !== "object") return gp;
  const kinds = Array.isArray(postfx.kinds) ? postfx.kinds : [];
  gp.postfx_upscale = kinds.includes("upscale");
  const up = (postfx.upscaleParams && typeof postfx.upscaleParams === "object") ? postfx.upscaleParams : null;
  gp.postfx_scale = ""; gp.postfx_w = ""; gp.postfx_h = "";
  if (up && up.mode === "scale" && Number.isFinite(+up.scale)) gp.postfx_scale = String(+up.scale);
  else if (up && up.mode === "target" && Number.isFinite(+up.width) && Number.isFinite(+up.height)) {
    gp.postfx_w = String(Math.round(+up.width)); gp.postfx_h = String(Math.round(+up.height));
  }
  const fps = postfx.interpParams && postfx.interpParams.target_fps;
  gp.postfx_fps = Number.isFinite(+fps) ? String(+fps) : "";
  if (typeof postfx.engineChoice === "string" && postfx.engineChoice) gp.postfx_engine = postfx.engineChoice;
  return gp;
}

// postfx 快照 → 主任务快照参数 + 该行后期参数（主快照不可读时退回自身快照）
async function _resolveSnapshotForParams(projectId, snap) {
  if (!snap || typeof snap !== "object") return null;
  const postfx = (snap.kind === "postfx" && snap.postfx && typeof snap.postfx === "object") ? snap.postfx : null;
  if (snap.kind !== "postfx") return { params: snap, postfx: null };
  if (snap.sourceRecordId) {
    const main = await loadRunSnapshot(projectId, snap.sourceRecordId);
    if (main && typeof main === "object" && main.kind !== "postfx") return { params: main, postfx };
  }
  return { params: snap, postfx };
}

// #63 T4：按记录载入——读快照 → 回填全参数（segments 保原段 id）→ currentRunId 写入 →
//   按该记录任务重建时间线（edit.applyHistory）。载入不改 runDir.current（新提交仍沿用最新目录语义）。
//   快照不可读（旧记录/文件被清）→ 白话 toast，零副作用。
export async function loadRunRecord(projectId, recordId) {
  if (!projectId || !recordId) {
    showToast("error", t("shell.load.badArgs"));
    return { ok: false, reason: "bad_args" };
  }
  const snap = await loadRunSnapshot(projectId, recordId);
  if (!snap || typeof snap !== "object") {
    showToast("error", t("shell.load.unreadable"));
    return { ok: false, reason: "snapshot_unreadable" };
  }
  const p = storeLoad(projectId);
  if (!p) {
    showToast("error", t("shell.legacy.noProject"));
    return { ok: false, reason: "no_project" };
  }
  // #63 T5：postfx 记录 = 主任务快照参数 + 该行后期参数
  const resolved = await _resolveSnapshotForParams(projectId, snap);
  _applySnapshotParams(p, resolved.params);
  if (resolved.postfx) _overlayPostfxParams(p.globalParams || (p.globalParams = {}), resolved.postfx);
  storeSave(p);
  // 指针走 meta 白名单（触发运行记录区/状态条重建）；runDir 不动
  updateProjectMeta(projectId, { currentRunId: recordId });

  const taskId = _snapTaskId(resolved.params) || _snapTaskId(snap);
  if (!taskId) {
    showToast("info", t("shell.load.noTask"));
    return { ok: true, taskId: "" };
  }
  try {
    await edit.applyHistory(taskId, { projectId, auto: false });
  } catch (_e) { /* applyHistory 内建错误 toast；参数/指针已生效 */ }
  // 契约：载入后 loadedTaskId=该记录任务（applyHistory 成功时已写；引擎离线时兜底写）
  const st = (storeLoad(projectId) || {}).editingState || {};
  if (st.loadedTaskId !== taskId) updateEditingState(projectId, { loadedTaskId: taskId });
  return { ok: true, taskId };
}

function _concatRunVersion(run) {
  if (typeof document === "undefined") return;
  const taskId = runTaskId(run);
  if (!taskId) { showToast("info", t("shell.concat.noTask")); return; }
  const body = el("div", { style: "font-size:12px;color:var(--txt2)" });
  body.textContent = t("shell.concat.previewing");
  const startBtn = el("button", { type: "button", class: "prim", text: t("shell.concat.start") });
  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("shell.common.cancel") });
  const inst = openModalBox({
    title: t("shell.concat.title", { taskId }),
    sub: t("shell.concat.sub"),
    contentNode: body,
    footerButtons: [cancelBtn, startBtn],
    closeOnBackdrop: true,
  });
  cancelBtn.addEventListener("click", () => inst.close());
  startBtn.addEventListener("click", async () => {
    inst.close();
    showToast("info", t("shell.concat.submitted"));
    const r = await concatApi({ taskId, mode: "global" });
    if (r.ok) {
      showToast("success", t("shell.concat.started", { folder: r.taskFolder || t("shell.concat.async") }));
    } else {
      showToast("error", t("shell.concat.fail", { msg: (r.error && r.error.msg) || (r.code || t("settings.err.unknown")) }));
    }
  });
  // 预演（edit.js 导出成片同款·同步响应）
  concatApi({ taskId, mode: "global", dryRun: true }).then((r) => {
    if (!r.ok && r.code === "missing_shots") {
      body.textContent = t("shell.concat.missingWarn", { n: (r.missing || []).length });
      return;
    }
    if (!r.ok) { body.textContent = t("shell.concat.dryFail", { msg: (r.error && r.error.msg) || t("settings.err.unknown") }); return; }
    const map = r.map || {};
    const keys = Object.keys(map).sort();
    body.innerHTML = t("shell.concat.dryHead") + "<br>" + keys.map((k) => `· ${k} → ${map[k]}`).join("<br>")
      + (r.fell_back ? '<br><span style="color:var(--warn)">' + t("shell.concat.fallbackWarn") + "</span>" : "");
  });
}

function _editRunMemo(run, projectId) {
  if (typeof document === "undefined") return;
  openPromptModal({
    title: t("shell.memo.title"),
    placeholder: t("shell.memo.ph"),
    defaultValue: (run && run.memo) || "",
    onConfirm: (v) => {
      const p = storeLoad(projectId);
      if (!p || !Array.isArray(p.runs) || !p.runs.length) return;
      const text = String(v == null ? "" : v);
      const runs = p.runs.slice();
      runs[0] = { ...runs[0], memo: text.slice(0, 200) };
      updateProjectMeta(projectId, { runs });
      showToast("success", t("shell.memo.updated"));
      // B4-T4 ④：引擎侧留底（fire-and-forget——本地已存，引擎结果不改本地；历史列表/详情可见）
      if (text.length > 200) {
        showToast("warn", t("shell.memo.truncated"));
      }
      const taskId = runTaskId(runs[0]);
      if (!taskId) {
        // 旧记录无任务句柄：降级提示同 _runActionGuard 口径（本地照存）
        showToast("info", t("shell.guard.noTask"));
        return;
      }
      void saveNote({ taskId, note: text }).then((r) => {
        if (!r.ok) {
          showToast("error", t("shell.memo.engineFail", { msg: (r.error && r.error.msg) || (r.error && r.error.code) || t("settings.err.unknown") }));
        }
      });
    },
  });
}

function _mkImportSeg() {
  // 与 store.addSegment 段形态逐字段一致（临时对象接 push）
  const tmp = { segments: [] };
  addSegment(tmp);
  const seg = tmp.segments[0];
  seg.id = "imp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
  return seg;
}

async function _exportCsvAction() {
  const pid = _csvCtxProjectId;
  const proj = pid ? storeLoad(pid) : null;
  if (!proj) { showToast("error", t("shell.csv.exportNotFound")); return; }
  if (typeof document === "undefined") return;
  showToast("info", t("shell.csv.exporting"));
  const poolCtx = await fetchSubmitPoolContext({
    storage: (typeof globalThis !== "undefined" && globalThis.localStorage) || null,
    listAssets,
  });
  const r = await exportProjectCsv(proj, poolCtx);
  if (!r.ok) { showToast("error", r.error); return; }
  try {
    const blob = new Blob(["\uFEFF" + r.text], { type: "text/csv;charset=utf-8" }); // BOM：Excel 中文兼容
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (proj.name || "项目") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast("success", t("shell.csv.exported", { name: a.download }));
  } catch (_e) {
    showToast("error", t("shell.csv.downloadFail"));
  }
}

// 批 2-T5（G8）：导入结果落库——分镜表整体替换 + 同名全局参数合并 + 素材池三形态透传。
//   池键名 = pool/pool_usage/pool_pose_style（与提交链 buildFormData 同形；非空才写——老 CSV 空池不覆盖现状）。
//   池展示/分配 UI 归批 8（本函数只保数据不丢·导出可读回）。
export function applyCsvImport(projectId, r) {
  const p = projectId ? storeLoad(projectId) : null;
  if (!p || !r) return false;
  p.segments = r.segments;
  if (!p.globalParams || typeof p.globalParams !== "object") p.globalParams = {};
  Object.assign(p.globalParams, r.globalParamsPatch || {});
  if (hasPoolEntries(r.pool)) {
    p.pool = r.pool;
    p.pool_usage = r.pool_usage;
    p.pool_pose_style = r.pool_pose_style;
  }
  storeSave(p);
  return true;
}

async function _handleCsvImportFile(inputEl) {
  const f = inputEl && inputEl.files && inputEl.files[0];
  if (!f) return;
  const pid = _csvCtxProjectId;
  const proj = pid ? storeLoad(pid) : null;
  if (!proj) { showToast("error", t("shell.csv.importNotFound")); return; }
  let text = "";
  try { text = await f.text(); } catch (_e) { showToast("error", t("shell.csv.readFail")); return; }
  showToast("info", t("shell.csv.parsing"));
  const r = await importCsvText(text, _mkImportSeg);
  if (!r.ok) { showToast("error", t("shell.csv.importFail", { err: r.error })); return; }
  // 批 2-T5②：未知列提示（引擎只回契约列、未知列静默丢弃 → 清单取自表头扫描）
  const unknownNotice = unknownColumnsNotice(r.unknownColumns);
  if (unknownNotice) showToast("warn", unknownNotice);
  const curCount = Array.isArray(proj.segments) ? proj.segments.length : 0;
  const globalsNote = Object.keys(r.globalParamsPatch).length ? t("shell.csv.globalsNote") : "";
  // 批 2-T5①：池非空 → 文案告知透传保留（无池 UI·数据随项目存）
  const poolNote = hasPoolEntries(r.pool) ? t("shell.csv.poolNote") : "";
  openConfirmModal({
    title: t("shell.csv.title"),
    sub: t("shell.csv.sub", { n: r.rowCount, cur: curCount, globals: globalsNote, pool: poolNote }),
    confirmText: t("shell.csv.confirm"),
    onConfirm: () => {
      if (!applyCsvImport(pid, r)) return;
      showToast("success", t("shell.csv.imported", { n: r.rowCount, name: f.name }));
    },
  });
}

function _importCsvAction() {
  if (typeof document === "undefined") return;
  let inp = document.getElementById("csvImportFile");
  if (!inp) {
    inp = document.createElement("input");
    inp.type = "file";
    inp.id = "csvImportFile";
    inp.accept = ".csv";
    inp.style.display = "none";
    inp.addEventListener("change", () => { void _handleCsvImportFile(inp); });
    document.body.appendChild(inp);
  }
  inp.value = ""; // 同文件重选可再触发 change
  inp.click();
}

// ===== 批 10C-T3 · F46②（裁⑧A·V43 :4342 同款）：document 级 contextmenu 兜底 preventDefault——浏览器默认菜单全站禁用 =====
//   输入场景（input/textarea/contenteditable·裁⑧A 豁免）放行原生菜单；自定义菜单区（canvas/edit/ctxFs）各自已 preventDefault·互不冲突 =====
export function isEditableCtxTarget(t) {
  if (!t) return false;
  const tag = String(t.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return !!t.isContentEditable;
}
export function installContextmenuGuard(doc) {
  if (!doc || typeof doc.addEventListener !== "function") return;
  doc.addEventListener("contextmenu", (e) => {
    if (isEditableCtxTarget(e && e.target)) return;
    if (e && typeof e.preventDefault === "function") e.preventDefault();
  });
}

// ===== 批 C #13：全局引擎离线横幅（芯片态单例下沉·各页统一「离线模式」提示）=====
// 对齐 server_storage.showOfflineBanner 先例（固定条·id 单例·行内样式不依赖 CSS 文件）；底边固定
// 避让数据服务只读横幅（顶部 z 9999）。idle=未连接→挂载；starting=启动中→维持既有（不闪）；
// connected→摘除。占位式：挂时 body padding-bottom 让位横幅高（原值记在横幅上）·摘时还原——
// 批 C 遗留修：原覆盖式 fixed 压住底部引擎芯片。mount 一次挂线（订阅随应用壳生命周期），广播只在变值时发 → 初始态即绘一次。
export const ENGINE_OFFLINE_BAR_ID = "gui13EngineOfflineBar";
export const ENGINE_OFFLINE_BAR_TEXT = t("shell.offline.bar");   // #89 T6：离线条文案入典（T5b LT 桶⑤收口·同 HC_* 模块级常量先例）
const ENGINE_OFFLINE_BAR_PLACEHOLDER = "32px"; // body padding-bottom 让位量≈横幅高（12px 字+12px 内边距）
export function paintEngineOfflineBar(doc, state) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.createElement !== "function") return null;
  const exist = typeof d.getElementById === "function" ? d.getElementById(ENGINE_OFFLINE_BAR_ID) : null;
  if (state === "connected") {
    if (exist) {
      if (exist.parentNode && typeof exist.parentNode.removeChild === "function") exist.parentNode.removeChild(exist);
      const bs = d.body && d.body.style;   // 占位式：还原挂横幅前的 body 原 padding（记录还原·不写死清零）
      if (bs && typeof bs === "object") bs.paddingBottom = typeof exist._bodyPadPrev === "string" ? exist._bodyPadPrev : "";
    }
    return null;
  }
  if (exist) return exist;              // idle/starting 已在 → 单例维持（不重复让位）
  if (state !== "idle") return null;    // starting 且从未显示 → 不闪横幅（芯片已示「启动中」）
  const bar = d.createElement("div");
  bar.id = ENGINE_OFFLINE_BAR_ID;
  bar.textContent = ENGINE_OFFLINE_BAR_TEXT;
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9998;padding:6px 12px;"
    + "background:#4a3b1e;color:#ffd88a;font-size:12px;text-align:center;box-shadow:0 -2px 8px #0006";
  // 体验修复 C-3：横幅内加行动件——「启动引擎」复用设置页引擎芯片同链 startEngine（启动中相位内置防重复点火）
  //   +「去设置」a 链接（href 改 hash → hashchange → 壳层路由自然接管）。
  //   fake-DOM 容错：无 appendChild 的最小桩（单测直调本函数）跳过按钮组装，不影响横幅本体。
  if (typeof bar.appendChild === "function") {
    const startBtn = d.createElement("button");
    startBtn.type = "button";
    startBtn.textContent = t("shell.offline.startBtn");   // #89 T6：启动钮入典
    startBtn.style.cssText = "margin-left:12px;padding:1px 10px;border:1px solid #ffd88a;border-radius:8px;"
      + "background:transparent;color:#ffd88a;font-size:12px;cursor:pointer";
    if (typeof startBtn.addEventListener === "function") {
      startBtn.addEventListener("click", () => {
        if (settings && typeof settings.startEngine === "function") void settings.startEngine();
      });
    }
    const settingsLink = d.createElement("a");
    settingsLink.textContent = t("shell.offline.toSettings");   // #89 T6：去设置链入典
    settingsLink.style.cssText = "margin-left:10px;color:#ffd88a;text-decoration:underline;cursor:pointer;font-size:12px";
    if (typeof settingsLink.setAttribute === "function") settingsLink.setAttribute("href", "#/settings");
    bar.appendChild(startBtn);
    bar.appendChild(settingsLink);
  }
  if (d.body && typeof d.body.appendChild === "function") {
    d.body.appendChild(bar);
    const bs = d.body.style;             // 占位式避让：横幅从「覆盖」变「占位」——body 让出横幅高·原值记在横幅上·摘时还原
    if (bs && typeof bs === "object") {
      bar._bodyPadPrev = typeof bs.paddingBottom === "string" ? bs.paddingBottom : "";
      bs.paddingBottom = ENGINE_OFFLINE_BAR_PLACEHOLDER;
    }
  }
  return bar;
}

// ===== 体验修复 C-6：提交历史角标周期刷新 =====
//   现状（批0 · T2）：角标数字=构建时快照，仅进顶栏时刷新。本修复加 30 秒周期重读
//   loadHistory（任务包钦点最小实装——不做跨文件事件通道）。
//   在册元素两处：侧栏入口角标（mount 一次常驻）+ 顶栏 chip（buildProjectTopbar 重建时替换引用）；
//   tick 只更新仍在树上的（isConnected false → 真实 DOM 已摘离，跳过）。
let _queueSideBadgeEl = null;
let _queueChipEl = null;
let _queueBadgeTimer = null;

export function queueChipText(n) {
  return "▤ " + t("shell.nav.queue") + (n > 0 ? ` ${n}` : "");
}

function _setTextNode(host, text) {
  // 兼容真实 DOM（childNodes/nodeValue）与单测 fake（_children/textContent）
  const kids = (host.childNodes || host._children) || [];
  for (let i = 0; i < kids.length; i++) {
    const nd = kids[i];
    if (nd && nd.nodeType === 3) {
      if ("nodeValue" in nd) nd.nodeValue = text; else nd.textContent = text;
      return;
    }
  }
}

/** 重读提交历史快照并刷新在册角标（导出供单测）；返回 running 计数 */
export function refreshQueueBadges() {
  let n = 0;
  try { n = loadHistory().filter((e) => e && e.status === "running").length; } catch (_e) { n = 0; }
  if (_queueSideBadgeEl && _queueSideBadgeEl.isConnected !== false) {
    if (n > 0) {
      _queueSideBadgeEl.textContent = String(n);
      _queueSideBadgeEl.style.display = "";
    } else {
      _queueSideBadgeEl.style.display = "none";
    }
  }
  if (_queueChipEl && _queueChipEl.isConnected !== false) _setTextNode(_queueChipEl, queueChipText(n));
  return n;
}

function startQueueBadgeTimer() {
  if (_queueBadgeTimer || typeof setInterval !== "function") return;
  _queueBadgeTimer = setInterval(() => { try { refreshQueueBadges(); } catch (_e) { /* 刷新错不累积 */ } }, 30000);
  if (typeof _queueBadgeTimer.unref === "function") _queueBadgeTimer.unref();   // Node 测试进程不因定时器挂起
}

// ===== #47 档2 GUI 侧：引擎版本握手闸（GUI 1.3 · 批2 T6）=====
//   基线 = 本 GUI 要求的最低引擎版本（只拦已知更老·更新版本放行）。
//   判定挂首拍探活成功（芯片态 connected）之后 —— 探活未成功不取版本（闸不误触）。
//   横幅形态循 paintEngineOfflineBar 既有横幅通道（body 底部 fixed 条 + padding 让位），
//   但**新 id 新类**——不复用离线横幅的语义（离线=引擎不可达·版本过旧=引擎能连但太老）。
export const MIN_H3_VERSION = "1.14";
export const H3_VERSION_BAR_ID = "gui13H3VersionBar";
export const H3_VERSION_BAR_CLASS = "shell-h3-version-bar";
const H3_VERSION_BAR_PLACEHOLDER = "32px";   // body padding-bottom 让位量（与离线横幅同形）

// 版本号解析 → 数值段数组（V 前缀剥离 + 字母后缀按主数值取）；解析失败 → null
function parseVersionParts(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[vV]/, "");
  const m = /^(\d+(?:\.\d+)*)/.exec(s);
  if (!m) return null;
  return m[1].split(".").map((n) => parseInt(n, 10));
}

// 脏值只 warn 一次（同一脏值不刷屏——脏值不闸·防一把脏值锁死全家）
const _warnedDirtyVersions = new Set();
function warnDirtyVersion(v) {
  const key = typeof v === "string" ? v : String(v);
  if (_warnedDirtyVersions.has(key)) return;
  _warnedDirtyVersions.add(key);
  console.warn("[gui13] 引擎版本号无法解析（按不拦截处理）:", v);
}

// cmpVersion: -1(a<b) | 0(同版/不可比) | 1(a>b)
//   三兜底：V 前缀剥离（引擎形态 "V1.14"）· 字母后缀按主数值（"V1.13h" 按 1.13）
//            · 任一侧解析失败 → 0（不闸）+ warn 一次
export function cmpVersion(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) {
    if (!pa) warnDirtyVersion(a);
    if (!pb) warnDirtyVersion(b);
    return 0;   // 脏值不闸
  }
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// 显示用版本号（剥 V 前缀·其余原样——字母后缀保留给用户看）
function displayVersion(v) {
  return String(v).trim().replace(/^[vV]/, "");
}

// 摘除版本横幅（引擎掉线时随离线横幅同链离场——避免两条横幅同占底部）
function removeH3VersionBar(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.getElementById !== "function") return null;
  const exist = d.getElementById(H3_VERSION_BAR_ID);
  if (!exist) return null;
  if (exist.parentNode && typeof exist.parentNode.removeChild === "function") exist.parentNode.removeChild(exist);
  const bs = d.body && d.body.style;
  // 只在 body padding 仍是本条横幅的让位量时才还原（不误还原离线横幅的让位）
  if (bs && typeof bs === "object" && bs.paddingBottom === H3_VERSION_BAR_PLACEHOLDER) {
    bs.paddingBottom = typeof exist._bodyPadPrev === "string" ? exist._bodyPadPrev : "";
  }
  return null;
}

// 版本过旧横幅：挂 / 更新文案 / 摘除（engineVersion 未知 → 维持现状不闪）
export function paintH3VersionBar(doc, engineVersion) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.createElement !== "function") return null;
  const exist = typeof d.getElementById === "function" ? d.getElementById(H3_VERSION_BAR_ID) : null;
  const v = typeof engineVersion === "string" ? engineVersion.trim() : "";
  if (!v) return exist;                                          // 未知（取不到版本）→ 维持现状
  if (cmpVersion(v, MIN_H3_VERSION) >= 0) { removeH3VersionBar(d); return null; }   // 达标 → 摘除
  const text = t("shell.h3ver.old", { v: displayVersion(v), min: MIN_H3_VERSION });   // #89 T6：版本拦截条入典（T5b LT 桶⑤收口）
  if (exist) { exist.textContent = text; return exist; }         // 重评 → 更新文案
  const bar = d.createElement("div");
  bar.id = H3_VERSION_BAR_ID;
  if (typeof bar.setAttribute === "function") bar.setAttribute("id", H3_VERSION_BAR_ID);
  bar.className = H3_VERSION_BAR_CLASS;
  bar.textContent = text;
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9998;padding:6px 12px;"
    + "background:#4a3b1e;color:#ffd88a;font-size:12px;text-align:center;box-shadow:0 -2px 8px #0006";
  if (d.body && typeof d.body.appendChild === "function") {
    d.body.appendChild(bar);
    const bs = d.body.style;
    if (bs && typeof bs === "object") {          // 占位式避让（同离线横幅：让出底部引擎芯片）
      bar._bodyPadPrev = typeof bs.paddingBottom === "string" ? bs.paddingBottom : "";
      bs.paddingBottom = H3_VERSION_BAR_PLACEHOLDER;
    }
  }
  return bar;
}

// 版本闸取数 + 判定 + 渲染（直连一次 fetchH3Version——不另起探测链）
export async function evaluateH3Version(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  const info = await fetchH3Version();
  const engineVersion = info && typeof info.engineVersion === "string" ? info.engineVersion : null;
  paintH3VersionBar(d, engineVersion);
  return engineVersion;
}

// 芯片态订阅处理器（挂点 = 探活成功 connected 路径；掉线 → 摘除版本横幅）
export function h3VersionGateHandler(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  return (s) => {
    if (s === "connected") { void evaluateH3Version(d); return; }
    removeH3VersionBar(d);
  };
}

// ===== T6：页面回前台 → 全量重拉（跨页/重连数据同步·账本 #59-③件 + 验收7 UI 面）=====
//   三条件全满足才重拉：document.visibilityState==="visible" + 距上次**成功** resync >5000ms
//   + 数据服务就绪（isReady）→ resyncAll() → 成功后派发 document 事件 "gui13:store-resync"
//   （projects.js 监听后重渲染列表）→ 失败挂横幅 toast（不谎报已刷新）。
export const RESYNC_THROTTLE_MS = 5000;
export const STORE_RESYNC_EVENT = "gui13:store-resync";
let _lastResyncAt = 0;                 // 上次**成功** resync 时刻（节流基准）
let _resyncClock = () => Date.now();   // 时钟注入位（测试替·_test 钩子）
export function _test_setResyncClock(fn) { _resyncClock = (typeof fn === "function") ? fn : () => Date.now(); }
export function _test_resetResyncState() { _lastResyncAt = 0; }

// 注册可见性监听（挂载期一次·返回 handler 便于测试/摘除）
export function installVisibilityResync(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.addEventListener !== "function") return null;
  const onChange = () => { void runVisibilityResync(d); };
  d.addEventListener("visibilitychange", onChange);
  return onChange;
}

export async function runVisibilityResync(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || d.visibilityState !== "visible") return false;
  const now = _resyncClock();
  if (!(now - _lastResyncAt > RESYNC_THROTTLE_MS)) return false;   // 节流窗内不重拉
  if (!isReady()) return false;                                     // 只读降级态不重拉
  const r = await resyncAll();
  if (!r || !r.ok) {
    showToast("error", t("shell.resync.fail"));
    return false;
  }
  _lastResyncAt = now;
  try { d.dispatchEvent(new CustomEvent(STORE_RESYNC_EVENT)); }
  catch (_e) { /* 无 CustomEvent 环境（老浏览器）·静默跳过 */ }
  return true;
}

// ===== T8 · #52 首启体检面板（横幅 + 明细面板；U-批 U2 摘全绿状态行）=====
//   数据层 = ui/healthcheck.js（runHealthcheck 取数判定 + HEALTH_GUIDE 白话指引）·本段只做 UI 渲染与壳层接线。
//   接线铁则（验收 9 前半）：体检请求一律在壳挂入 DOM 之后异步发起——不 await / 不阻断挂载 / 不顶层 await，
//     首屏可交互不因体检受阻（源序锁见 shell.test.mjs T8-b）。
//   渲染（U-批 U2 起·老板复验反馈）：全绿 → 不渲染任何体检 UI（原「体检 ✓」侧栏状态行摘除）；
//     有红 → 横幅（红项名 + 白话指引 +「查看详情」可点展开明细面板·七项逐行 ok/红+detail 摘要·再点收起）；
//     服务不可达 → 横幅「体检服务不可达」一行不展开。
const HC_BAR_ID = "gui13HealthBar";
const HC_STATUS_TEXT = t("hc.strip.status");   // #89 T5b：文案入典（U-批 U2 状态行渲染已摘·键值冻结保留引用防死键）
const HC_ERROR_TEXT = t("hc.strip.error");
const HC_TOGGLE_TEXT = t("hc.strip.toggle");
const HC_CLS = {
  status: "shell-hc-status",   // 侧栏状态行（全绿）
  bar: "shell-hc-bar",         // 横幅（红项 / 不可达）
  item: "shell-hc-item",       // 横幅内一行
  toggle: "shell-hc-toggle",   // 「查看详情」可点元素
  panel: "shell-hc-panel",     // 明细面板
  row: "shell-hc-row",         // 明细面板一行
  ok: "shell-hc-ok",           // 明细行·绿项形态
  bad: "shell-hc-bad",         // 明细行·红项形态
};
// detail 键 → 典键（白话标签渲染时 t() 取词·键名与服务端端点同口径·同 T5a KIND_DISPLAY_KEY 典键存表值先例）
const HC_DETAIL_LABEL = {
  version: "hc.strip.detail.version",
  vram_total_mb: "hc.strip.detail.vram_total_mb",
  error: "hc.strip.detail.error",
  ffmpeg: "hc.strip.detail.ffmpeg",
  ffprobe: "hc.strip.detail.ffprobe",
  missing: "hc.strip.detail.missing",
  engine_dir_exists: "hc.strip.detail.engine_dir_exists",
  venv_python: "hc.strip.detail.venv_python",
  listening: "hc.strip.detail.listening",
  workspace_free_gb: "hc.strip.detail.workspace_free_gb",
  engine_free_gb: "hc.strip.detail.engine_free_gb",
  installed: "hc.strip.detail.installed",
};

// 体检 UI 挂载态（挂于壳·摘于 _test_resetHealthcheck——循仓内 _test 钩子先例）
let _hcUi = null;

// 元素构造（显式 doc：体检结果可能在壳卸载后才到·不依赖全局 document）
function hcEl(doc, tag, attrs = {}) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = String(v);
    else if (k === "text") n.textContent = String(v);
    else n.setAttribute(k, String(v));
  }
  return n;
}

// detail 摘要（字符串逐字·对象键值对·数组顿号连·空 → 无）
function hcDetailText(detail) {
  if (detail === null || detail === undefined) return "—";
  if (typeof detail === "string") return detail;
  if (typeof detail === "boolean") return detail ? t("hc.strip.yes") : t("hc.strip.no");
  if (typeof detail === "number") return String(detail);
  if (Array.isArray(detail)) return detail.length ? detail.map((v) => hcDetailText(v)).join(t("hc.strip.join")) : t("hc.strip.none");
  if (typeof detail === "object") {
    const parts = Object.entries(detail).map(([k, v]) => `${HC_DETAIL_LABEL[k] ? t(HC_DETAIL_LABEL[k]) : k}=${hcDetailText(v)}`);
    return parts.length ? parts.join(" · ") : "—";
  }
  return String(detail);
}

// 摘除既有体检 UI（重挂不叠条）
function hcReset() {
  const ui = _hcUi;
  if (!ui) return;
  for (const node of [ui.bar, ui.status]) {
    const p = node && node.parentNode;
    if (p && typeof p.removeChild === "function") p.removeChild(node);
  }
  _hcUi = null;
}

// 测试钩子：摘除体检 UI（挂/摘与壳生命周期一致·循 _test_resetResyncState 先例）
export function _test_resetHealthcheck() { hcReset(); }

// 明细面板展开/收起（点「查看详情」展开·再点收起）
function hcTogglePanel() {
  const ui = _hcUi;
  if (!ui || !ui.bar || !ui.doc) return;
  if (ui.panel) { ui.bar.removeChild(ui.panel); ui.panel = null; return; }
  const panel = hcEl(ui.doc, "div", { class: HC_CLS.panel });
  for (const it of ui.items) {
    const ok = !!(it && it.ok);
    const row = hcEl(ui.doc, "div", { class: `${HC_CLS.row} ${ok ? HC_CLS.ok : HC_CLS.bad}` });
    row.appendChild(hcEl(ui.doc, "span", { text: `${ok ? "✓" : "✗"} ${it && it.id ? String(it.id) : "?"}` }));
    row.appendChild(hcEl(ui.doc, "span", { text: ` ${hcDetailText(it && it.detail)}` }));
    panel.appendChild(row);
  }
  ui.bar.appendChild(panel);
  ui.panel = panel;
}

// 三档渲染
function hcPaint(doc, main, sidenav, result) {
  hcReset();
  const r = result || { ok: false, items: [], red: [], error: true };
  const items = Array.isArray(r.items) ? r.items : [];
  const red = Array.isArray(r.red) ? r.red : [];
  if (r.error) {                                   // 服务不可达 → 横幅一行·不展开
    const bar = hcEl(doc, "div", { class: HC_CLS.bar, id: HC_BAR_ID, text: HC_ERROR_TEXT });
    main.appendChild(bar);
    _hcUi = { doc, bar, status: null, panel: null, items };
    return;
  }
  if (!red.length) {                               // 全绿 → 不渲染任何体检 UI（U-批 U2：侧栏「体检 ✓」状态行摘除）
    _hcUi = null;
    return;
  }
  const bar = hcEl(doc, "div", { class: HC_CLS.bar, id: HC_BAR_ID });
  bar.appendChild(hcEl(doc, "span", { class: HC_CLS.item, text: t("hc.strip.summary", { n: red.length }) }));
  for (const it of red) {
    const id = it && it.id ? String(it.id) : "?";
    bar.appendChild(hcEl(doc, "div", { class: HC_CLS.item, text: `${id}：${HEALTH_GUIDE[id] || ""}` }));
  }
  const toggle = hcEl(doc, "span", { class: HC_CLS.toggle, text: HC_TOGGLE_TEXT });
  toggle.addEventListener("click", () => hcTogglePanel());
  bar.appendChild(toggle);
  main.appendChild(bar);
  _hcUi = { doc, bar, status: null, panel: null, items };
}

// ===== 挂载应用壳 =====

export function mount(container, opts = {}) {
  if (!container || typeof document === "undefined") return null;
  clearChildren(container);

  const router = opts.router || createRouter();

  // C3 修正笔：onOpenProject 注入点唯一归 index.html（本处注入会与其重复——后注册覆盖前者，双源无益）。
  //   portal/projects 新建项目跳设定页走各自 onSuccess → _onOpenProject(id, "setup")（index.html 双参注入承接）。

  // 主结构：#app > #sidenav + #main
  const app = el("div", { id: "app", class: "shell-app" });

  // 左栏
  const sidenav = buildSidenav(router);
  app.appendChild(sidenav);
  startQueueBadgeTimer();   // C-6：侧栏导航提交历史角标周期刷新（buildSidenav 内注册角标后启动·单例）

  // 主区
  const main = el("main", { id: "main", class: "shell-main" });
  const topbar = el("div", { id: "topbar", class: "shell-topbar" });
  main.appendChild(topbar);
  // 批 10C-T1 · F57（老板裁⑤A=侧栏底部）：引擎芯片+铃铛槽位迁 #sidenav 底部一行（.ws 之下）
  //   ——原挂 #main 绝对定位槽（top:10 right:28）盖各页顶行右侧（仅 .pws-head 有避让补丁）；
  //   挂侧栏底部一行不遮任何页面内容，notif-panel 面板锚铃铛向上弹出（notif.js 落点 + theme.css 兜底）。
  if (settings && typeof settings.buildEngChip === "function") {
    const chip = settings.buildEngChip();
    if (chip) {
      const slot = el("div", { class: "shell-eng-slot" });
      slot.appendChild(chip);
      // 批 0-T4：工具簇加「搜索」钮 —— 点击 = Ctrl+K 同款全局搜索面板
      //   （超原型轻微 · 待老板追认（批 0 送审截图定）；样式套芯片行同款体系，.shell-eng-slot .search-btn）
      const searchBtn = el("span", { class: "search-btn", id: "shellSearchBtn", title: t("shell.nav.searchTitle") });
      searchBtn.appendChild(el("span", { "data-ic": "search", "data-sz": "16" }));
      // B5-T3: 补 opts（与 installGlobalKeys 同款）——点项目结果真跳工作区预览 TAB、资产走 #/assets；
      //   原裸调 openSearchModal() 会让项目结果落「示意」toast（顺手修）
      searchBtn.addEventListener("click", () => openSearchModal({
        onOpenProject: (id) => router.go(`/project/${encodeURIComponent(id)}?tab=preview`),
        onOpenAssets: () => router.go("/assets"),
      }));
      slot.appendChild(searchBtn);
      const bell = el("span", { class: "bell", id: "bellSide", title: t("shell.nav.bellTitle") });
      bell.appendChild(el("span", { "data-ic": "bell", "data-sz": "16" }));
      mountNotifCenter({ bell });
      slot.appendChild(bell);
      hydrateIcons(slot);
      sidenav.appendChild(slot);
      // 批 9 T2：页面载入即探测一次（17-3/18-21/20-e 同源）——此前 refreshChip 只在设置页
      //   挂载/刷新钮/startEngine 触发，非设置页芯片恒初始「未连接」而业务请求全通。
      //   经唯一探测出口 refreshChip（不新增探测链）；失败/离线自然落 idle 不崩。
      if (typeof settings.refreshChip === "function") void settings.refreshChip();
    }
  }
  // D1 修正笔（地基批1节点门·审核A §一 条 1）：常驻探活启动挂点移壳层——
  //   原唯一挂点在设置页 mount → 首页形态（不进设置页）探活永不启动，引擎死后芯片恒绿 +
  //   离线横幅永不出现（验收 1 破）。壳挂载即启动（挂侧栏引擎芯片之后）·幂等·
  //   与设置页共用同一入口 startEngineProbing（后调方 no-op·不双拍）。
  if (settings && typeof settings.startEngineProbing === "function") settings.startEngineProbing();
  // 批 C #13：全局离线横幅接线（芯片态广播驱动·壳级一次挂线）。初始态即绘——广播只在变值时发，
  //   idle→idle 无回调；在线者首轮探测成功（connected）即撤，离线者常驻各页。
  if (typeof settings.subscribeChipState === "function") {
    const _paintBar = (s) => { try { paintEngineOfflineBar(document, s); } catch (_e) { /* 绘制错不污染 */ } };
    // #47 档2：版本闸订阅（**先于**离线横幅订阅挂线——掉线时先摘版本横幅再挂离线横幅：
    //   两条横幅同占 body 让位量·顺序反了会互相抹掉 padding）。
    settings.subscribeChipState(h3VersionGateHandler(document));
    settings.subscribeChipState(_paintBar);
    _paintBar(typeof settings.getChipState === "function" ? settings.getChipState() : "idle");
  }
  // 批②F-114：重跑自动补后期——桥一次挂线（core 不反查 views·rerun_flow 桥先例位）。
  //   rerun/同种子/seg_edit/只重渲失败段四链终态经 rerun_flow onFinal 判成功段白名单后
  //   调本桥 → core supplementPostfxAfterRerun；消费 io=本壳 _postfxToastIo（进度/终态
  //   toast + settle 收口 autoConcat 照常）。T5 #31b：gpOverride（重跑弹窗「后期处理
  //   （仅本次）」）随桥透传——core 合并装配·不写回 globalParams；不传=默认全局。
  //   （老板裁决 A·2026-10-28：G6 route① 重跑链自动归档挂点撤除——跑完一律留原位·
  //   归档只走历史行「归档」手动通道。）
  setPostfxRerunSupplement(({ projectId, taskId, sids, gpOverride }) =>
    import("../core/postfx_pipeline.js").then(async (pp) => {
      const r = await pp.supplementPostfxAfterRerun({ projectId, taskId, sids, gpOverride, io: _postfxToastIo(pp, { projectId, taskId }) });
      return r;
    }));
  const views = el("div", { id: "views", class: "shell-views" });
  main.appendChild(views);
  app.appendChild(main);
  container.appendChild(app);

  renderRoute(views, topbar, router.current(), router);

  router.subscribe((next) => {
    renderRoute(views, topbar, next, router);
  });

  // S3-4 B7（A013/A014）：文档级全局键（任意视图可触发）——Ctrl+K 全局搜索 / ? 快捷键帮助
  //   搜索/帮助弹窗内的跳转走本域 router（项目 → 工作区预览 TAB；资产 → #/assets）
  installGlobalKeys(document, {
    onOpenProject: (id) => router.go(`/project/${encodeURIComponent(id)}?tab=preview`),
    onOpenAssets: () => router.go("/assets"),
  });

  // 批 10C-T3 · F46②：全局禁右键兜底（V43 :4342 同款·输入豁免见上）
  installContextmenuGuard(document);

  // T6：回前台全量重拉（可见性 → 重拉 → 派发 gui13:store-resync·壳级一次挂线）
  installVisibilityResync(document);

  // T8 · #52 首启体检：壳挂入 DOM 之后异步发起（不 await·不阻断挂载·不顶层 await·首屏可交互不受阻）
  //   取数走 ui/healthcheck.js（GET /gui13-fs/healthcheck·同源相对）·结果回来后再渲染横幅/状态行。
  const hcDoc = document;
  void runHealthcheck()
    .then((r) => hcPaint(hcDoc, main, sidenav, r))
    .catch(() => hcPaint(hcDoc, main, sidenav, { ok: false, items: [], red: [], error: true }));

  return router;
}

export function buildSidenav(router) { // 导出便于测试（T3 订正批：nav 角标断言需直构侧栏）
  const aside = el("aside", { id: "sidenav", class: "shell-sidenav" });
  // Logo（H3）—— 点击切换 slim 态
  const logo = el("div", {
    class: "logo",
    title: t("shell.nav.logoTitle"),
    "data-act": "toggle-slim",
  });
  logo.appendChild(el("span", { class: "mark", text: "H3" }));
  logo.appendChild(el("span", { class: "appname", text: "H3ShotForge" }));
  logo.addEventListener("click", () => {
    if (document && document.body) {
      document.body.classList.toggle("slim");
    }
  });
  aside.appendChild(logo);

  // 新建项目按钮（→ 跳门户页 + 开新建项目弹窗；S1-1 修 6 节点门修正）
  const btnNew = el("div", {
    class: "btn-new",
    title: t("shell.nav.newProject"),
    "data-act": "new-project",
  });
  // 批 R7 · A3：原型 data-ic=plus 14（v43 :1040），替换无图标形态
  btnNew.appendChild(el("span", { "data-ic": "plus", "data-sz": "14" }));
  btnNew.appendChild(el("span", { class: "btn-txt", text: t("shell.nav.newProject") }));
  btnNew.addEventListener("click", () => {
    // 跳门户（hash 空路由 = home 视图），然后开新建项目弹窗
    router.go("");
    // portal.mount 已挂在 #views；门户视图挂载时绑定 hero 点击；左栏快捷入口额外暴露弹窗
    // （最小侵入：直接调 portal.openNewProjectModal，无挂载时退化为 toast 示意）
    if (portal && typeof portal.openNewProjectModal === "function") {
      // S1-2 T0 修 1：传 onSuccess 回调，创建成功后调 portal 导出的 refreshRecent 刷新最近项目
      //   - 路由跳 "" 同步触发 renderRoute → portal.mount → _recentRow 已就绪（同步链）
      //   - 未挂载态：portal.refreshRecent 内部静默 no-op（防御 NPE）；此处补 toast 提示作为兜底
      portal.openNewProjectModal((project) => {
        // C3（交接§四.4）：左栏新建同样创建后跳设定页（对齐 v43；buildSidenav 域内有 router）
        if (project && project.id) {
          router.go(`/project/${encodeURIComponent(project.id)}?tab=setup`);
        }
        if (portal && typeof portal.refreshRecent === "function") {
          try { portal.refreshRecent(); }
          catch (e) {
            showToast("error", t("shell.nav.recentFail", { msg: e && e.message ? e.message : e }));
          }
        }
        // 旧 else 分支的「已创建」兜底 info toast 已摘（批6 G1 必修②·方案 v2.1 §三.2）：
        //   portal.openNewProjectModal 在手 = portal 模块必已挂载，refreshRecent 与它同模块导出恒可用；
        //   创建确认由 portal 的落定 toast（store:index-write-settled ok 后）兑现——预弹成功在
        //   总表写失败时会与失败档双弹且成功在先（侦察 UX 缺口 4）。
      });
    } else if (typeof showToast === "function") {
      showToast("info", t("shell.nav.newFallback"));
    }
  });
  aside.appendChild(btnNew);

  // nav 五项
  const nav = el("nav", { class: "nav", id: "nav" });
  for (const it of NAV_ITEMS) {
    const item = el("div", {
      class: "nav-item",
      "data-view": it.view,
      title: it.label,
    });
    // 批 R0 · J1：.ico 内嵌 data-ic span（原型 v43 :1042-1047 同款结构），svg 由 hydrateIcons 注入
    const ico = el("span", { class: "ico" });
    ico.appendChild(el("span", { "data-ic": it.icon }));
    item.appendChild(ico);
    item.appendChild(el("span", { class: "nav-label", text: it.label }));
    item.addEventListener("click", () => {
      // 批10A-T1 · F59（老板验收报料：空项目里点画布加载了别的项目分镜）：
      // 当前路由在项目内 → 带该项目 id 进画布（对齐下方 AI 项 B6-T4 同款先例）；
      // 非 project 路由 → 批 10-L L1-7（F80）：先按「上次画布上下文」记忆恢复
      //   （新建画布未命名时切去项目管理再切回，recent fallback 会回旧项目 A = 老板报的丢内容）；
      //   真无记忆时才走最近项目 fallback——2026-09-27 走查修复（老板报"画布丢内容"）
      //   引入：此前恒 /canvas（无项目空白画布·仅 G 节点），与项目顶栏入口观感割裂像"内容丢了"，故不砍。
      if (it.view === "canvas") {
        const cur = router.current();
        if (cur && cur.view === "project" && cur.projectId) {
          router.go(`/canvas?p=${encodeURIComponent(cur.projectId)}`);
          return;
        }
        // 记忆：null=无 · ""=上次未命名草稿（裸 /canvas·画布侧还原草稿）· "X"=上次项目 X
        const ctx = canvas.canvasCtxRecall();
        if (ctx === "") {
          router.go("/canvas");
          return;
        }
        if (ctx && listProjects().some((p) => p && p.id === ctx)) {
          router.go(`/canvas?p=${encodeURIComponent(ctx)}`);
          return;
        }
        const recent = listProjects()
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
        router.go(recent ? `/canvas?p=${encodeURIComponent(recent.id)}` : "/canvas");
        return;
      }
      // B6-T4 裁决扩界②：从项目路由进 AI 协作自动带 p=当前项目（智能拆镜采纳/T5 互导上下文）；
      // 从门户等非 project 路由进 = 不带参（视图内无项目守卫照旧）
      if (it.view === "ai") {
        const cur = router.current();
        if (cur && cur.view === "project" && cur.projectId) {
          router.go(`/ai?p=${encodeURIComponent(cur.projectId)}`);
          return;
        }
        router.go("/ai");
        return;
      }
      router.go("/" + it.view);
    });
    // S1-2 T0 修 2 节点门修正（B 审方案 b）：
    //   - 三项 nav（canvas / assets / ai）退出 registerPending：不再置灰（与 W-01 已实装不空挂形态统一）
    //   - 改为手动 title 注归属（视觉提示实装批次 + 占位壳可达）
    //   - 点击自然跳占位壳（无 toast 拦截），壳内 placeholderText 已含实装批次说明文案
    //   - NAV_PENDING_MAP 保留为空挂清单归属依据（不在此处触发置灰）
    //   - 2026-09-25 对账单订正：S1-4 关账，canvas/assets 撤出本表（title=label）；
    //   - 批 R5：AI 协作视图整页实装 → ai 同步撤出（title=label · NAV_PENDING_MAP 暂空）
    const titleMeta = NAV_PENDING_MAP[it.view];
    if (titleMeta) {
      const { stepLabel, featureName } = titleMeta;
      item.title = t("shell.nav.pendingTitle", { name: featureName, step: stepLabel });
    }
    nav.appendChild(item);
  }
  // 体验修复 C-5（老板走查）：提交历史从底部槽位（芯片/搜索/铃铛 4 件挤 200px 侧栏行）迁到导航列表末尾。
  //   与首页/创作画布等并列（图标+文字）；点击复用 openQueueModal；运行中角标沿用 queueChipText 的 running 计数口径。
  const queueItem = el("div", {
    class: "nav-item",
    id: "shellQueueBtn",
    "data-view": "queue",
    title: t("shell.nav.queueTitle"),
  });
  queueItem.style.position = "relative";
  const queueIco = el("span", { class: "ico" });
  queueIco.appendChild(el("span", { "data-ic": "film" }));
  queueItem.appendChild(queueIco);
  queueItem.appendChild(el("span", { class: "nav-label", text: t("shell.nav.queue") }));
  const queueBadge = el("span", { style: "display:none;position:absolute;top:6px;right:10px;background:var(--bad);color:#fff;border-radius:8px;font-size:10px;line-height:1;padding:2px 5px" });
  const _qSideRunning = loadHistory().filter((e) => e && e.status === "running").length;
  if (_qSideRunning > 0) queueBadge.textContent = String(_qSideRunning);
  queueBadge.style.display = _qSideRunning > 0 ? "" : "none";   // 初始态显式 JS 属性（与 refreshQueueBadges 同口径）
  queueItem.appendChild(queueBadge);
  queueItem.addEventListener("click", () => openQueueModal());
  nav.appendChild(queueItem);
  _queueSideBadgeEl = queueBadge;   // C-6：注册在册角标 + 启动 30 秒周期刷新（单例守卫·mount 内 startQueueBadgeTimer）
  aside.appendChild(nav);

  aside.appendChild(el("div", { class: "nav-spacer" }));

  // ws（本地工作区）—— #92 B6b：内联换行/裁剪（真机 200px 侧栏溢出修正·避免改 CSS 文件）
  const ws = el("div", { class: "ws" });
  ws.style.cssText = "flex-wrap:wrap;overflow:hidden";
  // 批 R7 · A4/A5/A6：原型 v43 :1051-1053 —— avatar=person14
  const avatar = el("span", { class: "avatar" });
  avatar.appendChild(el("span", { "data-ic": "person", "data-sz": "14" }));
  ws.appendChild(avatar);
  const wsLabel = el("span", { class: "ws-label" });
  wsLabel.appendChild(document.createTextNode(t("shell.nav.ws")));
  wsLabel.appendChild(el("small", { text: t("shell.nav.wsSub") }));
  ws.appendChild(wsLabel);
  // 铃铛（S3-4 B2 · A006 原挂此处）——F8 迁至壳层 .shell-eng-slot 与引擎芯片同排；
  //   F57（批10C-T1）槽位落侧栏底部（见 mount 内槽位组装；notif-panel 锚铃铛向上弹出）
  aside.appendChild(ws);

  // U-批 U3：侧栏底部语言快切「中｜EN」——#92 B6 并入 .ws 本地工作区卡片；#92 B6b 修正笔
  //   （真机 200px 侧栏同行右推溢出 right=239>200）：卡片内换行右对齐（width:100% 占满触发
  //   flex-wrap 换行 · justify-content:flex-end 右对齐 · margin-left:0 退役同行右推）。
  //   当前语言高亮；点击 setLang（core/i18n.js 现成：快键+服务端 pref 双写落定 → 整页 reload）。
  //   文案固定「中/EN」不入典（任务单口径）；样式复用既有 ghostbtn 类＋内联微调（零新 CSS）。
  const langQuick = el("div", { class: "shell-lang-quick", id: "shellLangQuick" });
  langQuick.style.cssText = "display:flex;gap:4px;width:100%;justify-content:flex-end;padding:2px 0 0;margin-left:0";
  for (const [code, label] of [["zh", "中"], ["en", "EN"]]) {
    const b = el("button", { type: "button", class: "ghostbtn", text: label, "data-lang": code });
    b.style.cssText = "padding:1px 9px;font-size:11px;border-radius:6px";
    if (getLang() === code) b.style.cssText += ";color:var(--txt);border-color:var(--accent-bright);background:var(--panel2)";
    b.addEventListener("click", () => { void setLang(code); });
    langQuick.appendChild(b);
  }
  ws.appendChild(langQuick);

  // 批 R0 · J1：渲染后 hydrate（原型 :2453 hydrateIcons · 原型注入口=启动/渲染后各一次）
  hydrateIcons(aside);

  // 批1-T5 · H7：侧栏宽度拖拽 + 记忆（右缘 4px 手柄；body.slim 收起态优先·互斥）
  mountSidenavResize(aside);

  return aside;
}

// ============================================================================
// 批1-T5 · H7：侧栏宽度拖拽 + 记忆（1.0 core/col_resize.js 口径）
//   - 钳制 160-480；记忆键 h3gui_col_left_w（1.0 同名键·同语义）
//   - 宽度落 documentElement 的 --navw：body.slim 的 --navw:56px 为后代就近声明 →
//     slim 收起态天然压制宽度记忆（互斥优先）
//   - body.slim 在：拖拽无效且不写记忆；手柄=侧栏右缘 4px 竖条（shell.css·hover 变亮/col-resize）
// ============================================================================
export const SIDENAV_W_KEY = "h3gui_col_left_w";
export const SIDENAV_MIN_W = 160;
export const SIDENAV_MAX_W = 480;
export const SIDENAV_DEFAULT_W = 200;   // shell.css :root --navw 缺省值

export function clampSidenavWidth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SIDENAV_MIN_W;   // 1.0 clampColWidth 口径：非有限数 → MIN
  if (n < SIDENAV_MIN_W) return SIDENAV_MIN_W;
  if (n > SIDENAV_MAX_W) return SIDENAV_MAX_W;
  return n;
}

function _sidenavStorage(storage) {
  if (storage !== undefined) return storage;
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

export function readSidenavWidth(storage) {
  try {
    const s = _sidenavStorage(storage);
    if (!s) return null;
    const raw = s.getItem(SIDENAV_W_KEY);
    if (raw == null) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  } catch (_e) { return null; }
}

export function writeSidenavWidth(v, storage) {
  try {
    const s = _sidenavStorage(storage);
    if (!s) return;
    s.setItem(SIDENAV_W_KEY, String(clampSidenavWidth(v)));
  } catch (_e) { /* localStorage 不可用（隐私模式/配额满）→ 静默吞 */ }
}

export function applySidenavWidth(doc, w) {
  if (!doc || !doc.documentElement || !doc.documentElement.style) return;
  doc.documentElement.style.setProperty("--navw", clampSidenavWidth(w) + "px");
}

// opts: { document, storage }（测试注入位；缺省走全局 document/localStorage）
export function mountSidenavResize(aside, opts = {}) {
  const doc = opts.document || (typeof document !== "undefined" ? document : null);
  if (!doc || !aside || !doc.documentElement) return null;
  const storage = _sidenavStorage(opts.storage);

  // boot 恢复（slim 在时 --navw 被 body.slim 压制，无需分支）
  const restored = readSidenavWidth(storage);
  let curW = clampSidenavWidth(restored != null ? restored : SIDENAV_DEFAULT_W);
  applySidenavWidth(doc, curW);

  const handle = doc.createElement("div");
  handle.className = "sidenav-resize";
  handle.setAttribute("data-h3-role", "sidenav-resize");
  handle.setAttribute("title", t("shell.nav.resizeTitle"));
  aside.appendChild(handle);

  let dragging = false;
  let startX = 0;
  let startW = 0;
  const slimOn = () => !!(doc.body && doc.body.classList && doc.body.classList.contains("slim"));

  handle.addEventListener("pointerdown", (ev) => {
    if (slimOn()) return;   // slim 收起态优先：拖拽无效
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    dragging = true;
    startX = (ev && ev.clientX) || 0;
    startW = curW;
    if (aside.classList && typeof aside.classList.add === "function") aside.classList.add("resizing");
  });
  doc.addEventListener("pointermove", (ev) => {
    if (!dragging || slimOn()) return;
    curW = clampSidenavWidth(startW + (((ev && ev.clientX) || 0) - startX));
    applySidenavWidth(doc, curW);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (aside.classList && typeof aside.classList.remove === "function") aside.classList.remove("resizing");
    if (slimOn()) return;   // slim 在：不写记忆
    writeSidenavWidth(curW, storage);
  };
  doc.addEventListener("pointerup", endDrag);
  doc.addEventListener("pointercancel", endDrag);

  return { handle };
}

function buildTopbar(state, router) {
  // 批 1-T3 · C3：顶栏每次重建先销毁旧进度条（.pws-prog 随顶栏走·防 interval 泄漏到别的视图）
  _pwsProgressDestroy();
  if (state.view === "project") return buildProjectTopbar(state, router);
  // S1-2 T7：顶栏三态芯片（非项目视图挂载，与设置页同源双向 — settings.buildEngChip）
  // （局部名原为 t·与 i18n 取词函数 t() 同名遮蔽·T1b 改名 bar 让位）
  const bar = el("div", { class: "shell-topbar-empty" });
  if (state.view === "home") {
    bar.appendChild(el("span", { class: "topbar-title", text: t("shell.top.portal") }));
  } else if (state.view === "settings") {
    bar.appendChild(el("span", { class: "topbar-title", text: t("shell.nav.settings") }));
  } else {
    const label = navItemForView(state.view);
    bar.appendChild(el("span", { class: "topbar-title", text: label ? label.label : "" }));
  }
  // 老板走查快批⑦：芯片已移出顶栏行内（原为 t.appendChild(chip) → 紧贴标题）——
  //   现挂壳层 .shell-eng-slot（F57 起落侧栏底部，mount 内一次挂载），顶栏恒无芯片。
  return bar;
}

// ============================================================================
// 批 R2 · S4（单元② 顶栏信息区 · v43 :1139-1186 / :175 / :364-372 / :692-699）
// ============================================================================

// —— A02/A07 状态条文案（形态照搬 v43 :1139「渲染中 · 2/4 段完成 · 上次运行 …」）——
// 数据源侦察（2026-09-26 全文核对）：store.js 无 runState/runs 字段、submit.js 不落提交历史
// （仅 in-memory 轮询 phase）→ 生产态恒走空态；store 一旦落 runState 就位即接通运行中态。
export function formatRunStatus(runState, segCount, completion) {
  const n = Number.isFinite(+segCount) ? +segCount : 0;
  if (!runState || typeof runState !== "object") return t("shell.run.idle", { n });
  const last = runState.lastRunAt ? t("shell.run.lastAt", { at: runState.lastRunAt }) : "";
  // B5-T1②（批 4 遗留③）：重跑链记录（有 kind）落账无 total/done（B8）→ 计数段恒 0/0 外观瑕疵；
  //   以 label 行形态替代 N/M 计数（running/终态同款）
  const total = Number.isFinite(+runState.total) ? +runState.total : n;
  const done = Number.isFinite(+runState.done) ? +runState.done : 0;
  const _comp = completion && typeof completion === "object" ? completion : null;
  const _dc = _comp && Number.isFinite(+_comp.doneCount) ? +_comp.doneCount : 0;
  const _sc = _comp && Number.isFinite(+_comp.segCount) ? +_comp.segCount : n;
  // R-20②（批 10-P P-T3 + 收尾·主代理裁定 2026-10-04）：resume 记录——running=子集口径
  //   「继续中 · 从第 K 段起」（K 从落账 label 回读·脏 label 占位 ? 不崩）；终态且有 completion
  //   → 回落实时推导（验收3「全部产物齐→已完成 N/N」优先于 kind 行）；终态无 completion
  //   （旧调用面）保持子集行。
  if (runState.kind === "resume" && (runState.running || !_comp)) {
    const mk = /从第 (\d+) 段/.exec(runState.label || "");
    return `${runState.running ? t("shell.run.cont") : t("shell.run.done")} · ${t("shell.run.fromSeg", { k: mk ? mk[1] : "?" })} · ${t("shell.run.segDone", { done, total })}${last}`;
  }
  if (runState.kind === "resume") {
    return _comp.complete
      ? `${t("shell.run.done")} · ${t("shell.run.segDone", { done: _dc, total: _sc })}${last}`
      : `${t("shell.run.unfinished")} · ${t("shell.run.segHas", { done: _dc, total: _sc })}${last}`;
  }
  if (runState.kind) return `${runState.running ? t("shell.run.rerunning") : t("shell.run.done")} · ${runState.label}${last}`;
  // R-20③：running 态现行轮询文案链优先不破坏（runs[0] 计数原样）
  if (runState.running) return `${t("shell.run.rendering")} · ${t("shell.run.segDone", { done, total })}${last}`;
  // R-20③：终态不再卡 runs[0] 旧 done/total（新加分镜不回退问题）——按当前分镜 vs 有产物段实时推导。
  //   completion = deriveProjectCompletion 第三参（可省略·既有 2 参调用面走旧链零变化）；
  //   ran=false（无 runs 且零产物）在真实链路恒伴 runState=null → 上方空态分支已覆盖（ran 定义见 store）。
  if (_comp) {
    return _comp.complete
      ? `${t("shell.run.done")} · ${t("shell.run.segDone", { done: _dc, total: _sc })}${last}`
      : `${t("shell.run.unfinished")} · ${t("shell.run.segHas", { done: _dc, total: _sc })}${last}`;
  }
  return `${t("shell.run.done")} · ${t("shell.run.segDone", { done, total })}${last}`;
}

// —— A01 运行记录折叠头文案（v43 :1152「运行 3 次 · 现行 2026-09-20 19:26」）——
export function runsCapText(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return t("shell.run.capEmpty");
  const cur = (runs[0] && runs[0].at) || "—";
  return t("shell.run.capText", { n: runs.length, cur });
}

// —— 登记项 7（老板裁决 2026-09-27）：project.runs[0] → runState（formatRunStatus 入参形态）——
//   真运行历史数据源就位：submit 成功落账（running 态）→ 轮询终态更新 → 状态条/记录区真数据。
export function runStateFromRuns(runs0) {
  if (!runs0 || typeof runs0 !== "object") return null;
  return {
    running: !!runs0.running,
    total: Number.isFinite(+runs0.total) ? +runs0.total : 0,
    done: Number.isFinite(+runs0.done) ? +runs0.done : 0,
    lastRunAt: runs0.at || "",
    // B5-T1②：重跑链记录（rerun/seg_edit）透传 kind/label → formatRunStatus 走 label 行分支
    kind: runs0.kind || "",
    label: runs0.label || "",
  };
}

// ===== 批 1-T3 · C3：统一进度条消费点①（.pws-status 运行态 · 同区挂 .pws-prog）=====
//   形态：阶段文案 + 已等待计时（ui/progress.js）；起算 = runs[0].at（分钟精度·parseRunStamp）
//   生命周期：运行态建/更新；终态销毁；顶栏重建（buildTopbar）先销毁旧表——防 interval 泄漏。
let _pwsProg = null;

function _pwsProgressDestroy() {
  if (!_pwsProg) return;
  const { host, handle, parent } = _pwsProg;
  _pwsProg = null;
  try { handle.destroy(); } catch (_e) { /* 单点失败不阻顶栏重建 */ }
  try {
    if (parent && host && typeof parent.removeChild === "function") parent.removeChild(host);
  } catch (_e) { /* 顶栏已整块丢弃时无需摘 */ }
}

function _pwsProgressSync(head, statusEl, runState, run0) {
  if (typeof document === "undefined") return;
  if (!(runState && runState.running)) { _pwsProgressDestroy(); return; }
  // G1·#49：runs 行 percent（settleLatestRun 落账统一换算）→ update 喂条（phaseText 保留）。
  //   行无 percent（旧档/total=0）→ null → 组件回退 phase 态（progress.js 契约·不造假百分比）。
  const _pct = (run0 && typeof run0.percent === "number" && Number.isFinite(run0.percent)) ? run0.percent : null;
  if (_pwsProg) { _pwsProg.handle.update({ phaseText: t("shell.run.rendering"), percent: _pct }); return; }   // #89 T6：phaseText 复用 T1b 既有键（最小面=消费侧实参·progress.js 零改）
  const host = el("span", { class: "pws-prog", style: "display:inline-flex;align-items:center;gap:6px;margin-left:6px" });
  const parent = (statusEl && statusEl.parentNode) || head;
  _pwsProg = {
    host,
    parent,
    handle: renderProgress(host, { phaseText: t("shell.run.rendering"), startedAtMs: parseRunStamp(run0 && run0.at) }),
  };
  // G1·#49：建条即喂存量 percent（中途换页/刷新回顶栏直接就位，不等下一拍 meta-update）
  if (_pct != null) _pwsProg.handle.update({ percent: _pct });
  const anchor = statusEl && statusEl.nextSibling;
  if (anchor && typeof parent.insertBefore === "function") parent.insertBefore(host, anchor);
  else parent.appendChild(host);
}

// —— 体验修复 C-7：每段几版钳制（1-50）——非数/越界一律收敛到界内（纯函数便于单测）
export function clampRunCount(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(50, Math.max(1, n));
}

// —— A03 清段数据：segments 回 createProject 初始单段形态 ——
// 范围 = 段数据（prompt/seed/镜头九项等随段整体回初始）；
// globalParams / projMode / runCount 不在「清段数据」范围，不动。
export function applyResetDraft(projectId) {
  const fresh = storeLoad(projectId);
  if (!fresh || !Array.isArray(fresh.segments)) return false;
  for (const s of fresh.segments.slice()) removeSegment(fresh, s.id);
  addSegment(fresh);
  storeSave(fresh);
  return true;
}

// —— A01 运行记录区（结构照搬 v43 :1151-1186）——
// 读侧记录契约（store.project.runs · 时间倒序、现行置顶）：
//   { at: "2026-09-20 19:26", total: 段数, done: 完成数, failed: 失败数, memo?: 备注, verNote?: 版本树提示 }
// 段 chips 由 done/failed 计数派生（v43 :1156：ok→wait→bad 序），不另存数组。
// 数据源侦察同上：无历史落盘 → 读到空数组时渲染实况空态（不编造演示数据）。
export function buildRunsBlock(runs, opts = {}) {
  const list0 = Array.isArray(runs) ? runs : [];
  const block = el("div", { class: "runs" });
  const cap = el("span", { class: "runs-cap", title: t("shell.run.capTitle") });
  cap.appendChild(el("span", { "data-ic": "refresh", "data-sz": "13" }));
  cap.appendChild(document.createTextNode(runsCapText(list0)));
  cap.appendChild(el("span", { "data-ic": "chev", "data-sz": "13" }));
  block.appendChild(cap);

  const list = el("div", { id: "runsList" });
  if (list0.length === 0) {
    list.appendChild(el("div", {
      style: "font-size:12px;color:var(--txt3);padding:7px 4px",
      text: t("shell.run.emptyHint"),
    }));
  } else {
    list0.forEach((run, i) => {
      const pair = buildRunRow(run, i, list0.length, opts);
      list.appendChild(pair.row);
      list.appendChild(pair.det);
    });
  }
  block.appendChild(list);
  cap.addEventListener("click", () => list.classList.toggle("show"));
  return block;
}

function buildRunRow(run, idx, count, opts) {
  const r = run && typeof run === "object" ? run : {};
  const n = count - idx; // 倒序置顶：idx 0 = 第 count 次（现行）
  const current = idx === 0;
  const total = Number.isFinite(+r.total) ? +r.total : 0;
  const done = Number.isFinite(+r.done) ? +r.done : 0;
  const failed = Number.isFinite(+r.failed) ? +r.failed : 0;

  const row = el("div", { class: "runrow" });
  if (current) row.appendChild(el("span", { class: "cur", text: t("shell.run.cur") }));
  // #63 T4：指针行标「当前」（非最新行才加——最新行已有「现行」）
  const isPointerRow = !!(r.recordId && opts.currentRecordId && r.recordId === opts.currentRecordId);
  if (isPointerRow && !current) row.appendChild(el("span", { class: "cur", text: t("shell.run.pointer") }));
  if (r.kind) {
    // B4-T2：重跑链记录（rerun/seg_edit）不显示 N/M 段计数——#15 status payload 为全任务计数
    //   与单段重跑错位（B8）·记录不存 total/done → 显示 label+状态。
    //   批 M5b T2（T1 落 result 字段的渲染侧兑现）：running:false + result==="failed" = 中断终态
    //   （引擎不可达·M5b T1 落字段 / T2 对账步翻终态）→ 显「已中断」；漏判则恒显「已重跑」=谎报。
    //   #53（批5-T1）：postfx 行按自身生命周期分支（完成/失败/中断/进行中）——复用重跑态文案
    //   对后期处理语义错（postfx 不是重跑·完成行曾显「后期处理 · 已重跑」）。
    const _kindState = (r.kind === "postfx")
      ? (r.running ? t("shell.run.processing")
        : (r.interrupted
          ? (r.reason === "user_stopped" ? t("shell.run.stopped") : t("shell.run.interrupted"))   // #64：用户停止≠引擎故障
          : (r.result === "failed" ? t("shell.run.failed") : t("shell.run.done"))))
      : (r.running ? t("shell.run.rerunningEll") : (r.result === "failed" ? t("shell.run.interrupted") : t("shell.run.rerunDone")));
    row.appendChild(document.createTextNode(`${r.label || r.kind} · ${_kindState}`));
  } else {
    row.appendChild(document.createTextNode(
      t("shell.run.rowN", { n, total, tail: done >= total ? t("shell.run.allDone") : t("shell.run.doneN", { n: done }) })
    ));
  }
  row.appendChild(el("small", { text: r.at || "" }));

  const det = el("div", { class: "rundet", id: `det${n}` });
  // 段 chips 只由非 kind 记录派生（kind 记录无 total/done 可派生·不显示 N/M）
  if (!r.kind) {
    for (let k = 1; k <= total; k++) {
      const state = k <= done ? "ok" : (k <= done + failed ? "bad" : "wait");
      const label = state === "ok" ? t("shell.run.segOk", { k }) : (state === "bad" ? t("shell.run.segBad", { k }) : t("shell.run.segWait", { k }));
      det.appendChild(el("span", { class: `runchip ${state}`, text: label }));
    }
  }
  // 现行 run：版本树提示 + 备注 fchip 行（v43 :1167-1174 · 内容依赖真实运行数据，缺字段不渲染）
  if (current) {
    if (r.verNote) {
      det.appendChild(el("div", { style: "font-size:12px;color:var(--txt3);margin:8px 0 0", text: r.verNote }));
    }
    const memoRow = el("div", { style: "font-size:12px;margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" });
    memoRow.appendChild(document.createTextNode(t("shell.run.memoColon")));
    memoRow.appendChild(el("span", { style: "color:var(--txt2)", text: r.memo || "—" }));
    // W-07 转正（批 4）：四 chip 接真（编辑备注 / 按版本回退 / 按此版本拼接 / 导入配置）
    const chipActions = [
      [t("shell.act.editMemo"), () => _editRunMemo(r, opts.projectId)],
      [t("shell.act.revertVersion"), () => { void _applyRunConfig(r, opts.projectId, t("shell.act.revertVersion")); }],
      [t("shell.act.concatVersion"), () => _concatRunVersion(r)],
      [t("shell.act.importConfig"), () => { void _applyRunConfig(r, opts.projectId, t("shell.act.importConfig")); }],
    ];
    for (const [label, fn] of chipActions) {
      const chip = el("span", { class: "fchip", style: "padding:1px 8px;cursor:pointer", text: label });
      chip.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      memoRow.appendChild(chip);
    }
    det.appendChild(memoRow);
  }
  // 操作行（v43 :1177-1183：现行 4 件（F70 加「重跑…」）· 历史 2 件 + #63 T4「载入此记录」）
  const btnRow = el("div", { style: "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap" });
  // #63 T5：历史行统一挂「载入此记录」——有本地快照走快照；无快照/写失败行走引擎降级（部分恢复）；
  //   无 recordId 且无任务号 → 置灰 + title 不可恢复（方案 §二档2「不可恢复的置灰+原因」）。
  const hasLocalSnap = !!r.recordId && r.snapshot !== false;
  const loadReady = hasLocalSnap || !!runTaskId(r);
  const specs = current
    ? [[t("shell.act.viewFilms"), "films"], [t("shell.act.loadTimeline"), "goEdit"], [t("shell.act.rerun"), "rerun"], [t("shell.act.dup"), "dup"]]
    : [[t("shell.act.viewFilms"), "films"], [t("shell.act.loadRecord"), "load"], [t("shell.act.dup"), "dup"]];
  for (const [label, kind] of specs) {
    const b = el("span", { class: "ghostbtn", text: label });
    if (kind === "goEdit") {
      // 实况通道：v43 goProject('edit') 等价 → 本项目剪辑 TAB
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (opts.router && opts.projectId) {
          opts.router.go(`/project/${encodeURIComponent(opts.projectId)}?tab=edit`);
        }
      });
    } else if (kind === "films") {
      b.addEventListener("click", (e) => { e.stopPropagation(); void _viewRunFilms(r, { current }); });
    } else if (kind === "rerun") {
      // F70：重跑二级入口（老板「概况里有重跑了」——同种子/改参数收进一个入口）
      //   stopPropagation 必带：否则点击冒泡到 document 触发刚挂的外点关闭
      b.setAttribute("id", "runRerunBtn");
      b.title = t("shell.act.rerunTip");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        _openRunRerunMenu(b, opts.projectId, opts.router);
      });
    } else if (kind === "dup") {
      b.addEventListener("click", (e) => { e.stopPropagation(); void duplicateRunProject(opts.projectId, r, opts.router); });
    } else if (kind === "load") {
      // #63 T4/T5：载入此记录（历史行·快照回填参数+指针+时间线；旧记录走引擎快照降级）
      b.title = hasLocalSnap
        ? t("shell.act.loadSnapTip")
        : (loadReady ? t("shell.act.loadLegacyTip") : UNRECOVERABLE_TITLE);
      if (!loadReady) b.classList.add("off");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!loadReady) { showToast("info", UNRECOVERABLE_TITLE); return; }
        void loadRunRecordFromRow(opts.projectId, r, b);
      });
    }
    btnRow.appendChild(b);
  }
  det.appendChild(btnRow);

  row.addEventListener("click", () => det.classList.toggle("show"));
  return { row, det };
}

export function buildProjectTopbar(state, router) {
  // W-02/W-03：每次进入项目视图刷新 pmenu 单例回调的当前项目锚
  _csvCtxProjectId = state && state.projectId ? state.projectId : null;
  // 老板 2026-09-26 走查指令：顶栏对齐 v43 两行结构——第一行 .pws-head（操作行）+ 第二行 .ptabs（独立 TAB 行），
  // 此前 TAB/模式/次数/提交/芯片全挤进一行即"乱的没对齐"的根因。行序对齐原型 v43 :1136-1151。
  const wrap = el("div", { class: "proj-topbar", id: "projTopbar" });
  const head = el("div", { class: "pws-head" });
  wrap.appendChild(head);
  // 批 1-T3 · C3：顶栏重建（同视图重渲）先销毁旧进度条——进度表随本次新建的 .pws-status 走
  _pwsProgressDestroy();

  // —— 第一行 .pws-head（操作行）——
  // 返回项目列表（v43 :1136 原型钦点文案与去向）
  // 批 R7 · B02：chev 13 + rotate(90deg) 取代「← 」字符（原型 v43 :1137 同款形态）
  const back = el("span", { class: "ghostbtn", title: t("shell.top.back") });
  back.appendChild(el("span", { "data-ic": "chev", "data-sz": "13", style: "transform:rotate(90deg)" }));
  back.appendChild(document.createTextNode(t("shell.top.back")));
  back.addEventListener("click", () => router.go("/projects"));
  head.appendChild(back);

  // 项目名
  const proj = storeLoad(state.projectId);
  const projName = getProjectName(proj);
  // 走查快批②：窄屏档项目名限宽省略（shell.css ≤1490）→ title 兜底全文案，不静默截断
  head.appendChild(el("h2", { id: "projTitle", text: projName, title: projName }));

  const _segCount0 = Array.isArray(proj.segments) ? proj.segments.length : 0;

  // ===== 批 R2 · A02/A07：.pws-status 状态条 + .lamp 状态灯（v43 :1139 · 落位 h2 后、runhint 前）=====
  //   文案 = formatRunStatus(运行态, 段数)；#63 T4：运行态从 currentRunId 指针行派生
  //   （缺失/悬空回落 runs[0]·旧项目兼容）——不再硬编码 runs[0]。
  const _curRun0 = currentRunRow(proj);
  const _runState0 = runStateFromRuns(_curRun0);
  // R-20③：完成度实时推导入参。仅在项目确有 mainClips 数据时接入——无剪辑态数据
  //   （旧存档未开过剪辑页/未跑过运行落轨）不虚构「零产物」，走既有 runs[0] 链不动。
  const _mc0 = proj && proj.editingState && proj.editingState.mainClips;
  const _comp0 = Array.isArray(_mc0)
    ? deriveProjectCompletion(proj && proj.segments, _mc0, proj && proj.runs)
    : null;
  const status = el("span", {
    class: "pws-status",
    title: t("shell.top.willSubmit", { n: _segCount0 }),
  });
  const lamp = el("span", {
    class: "lamp",
    style: _runState0 && _runState0.running ? "margin-right:5px;background:var(--warn)" : "margin-right:5px",
  });
  status.appendChild(lamp);
  const statusText = document.createTextNode(formatRunStatus(_runState0, _segCount0, _comp0));
  status.appendChild(statusText);
  head.appendChild(status);
  // 批 1-T3 · C3：运行态在 .pws-status 紧邻右侧挂统一进度条（阶段+已等待）；非运行态不挂
  _pwsProgressSync(head, status, _runState0, _curRun0);

  // ===== 批0 · T2：队列入口 chip（老板钦点归位：顶栏运行状态区 · edit.js:300 注记兑现）=====
  //   数字 = 构建时快照：loadHistory（try/catch 降级同源·解析失败当 0）计 status==="running"；
  //   不建事件通道——弹窗内数据由 openQueueModal 实时读（既有行为）。
  //   体验修复 C-6：chip 注册模块级引用 + 30 秒周期刷新（refreshQueueBadges）——不再「仅进顶栏时刷新」。
  const _qRunning = loadHistory().filter((e) => e.status === "running").length;
  const queueChip = el("span", {
    class: "ghostbtn queue-entry",
    title: t("shell.nav.queueTitle"),
  });
  queueChip.appendChild(document.createTextNode(queueChipText(_qRunning)));   // G4b①：文案唯一定义点（与 C-6 刷新同源）
  queueChip.addEventListener("click", () => openQueueModal());
  head.appendChild(queueChip);
  _queueChipEl = queueChip;   // C-6：重建顶栏时替换引用（旧 chip 摘离后 tick 自动跳过）

  // ===== T10 C031：顶栏「将提交 · N 段」实时段数提示（v43 :1140）=====
  //   最小实装：DOM 上挂 .runhint span + text 初始化 = project.segments.length
  //   段数变化（add/remove/move）→ 走 store subscribe 通道统一刷新此 span text
  //   已知边界：buildProjectTopbar 每次路由进入重建 — 段数在进入时即时正确；
  //   段内增删后刷新走 subscribe 回调, 回调内 storeLoad 拿最新值 (避免操作 in-memory proj)
  //   路由离开未摘订阅 — store.subscribe 当前实现无 cleanup, 累积 set 项, 回调内 projectId 守门防误更新
  //   批 R2 · B03：title 改「将提交 · N 段」口径（原「当前项目共 N 段…」）；.pws-status 同口径
  const runhint = el("span", {
    id: "runhint",
    class: "runhint num",
    title: t("shell.top.willSubmit", { n: _segCount0 }),
    text: t("shell.top.willSubmit", { n: _segCount0 }),
  });
  head.appendChild(runhint);
  if (typeof storeSubscribe === "function") {
    storeSubscribe((evt) => {
      if (!evt || evt.projectId !== state.projectId) return;
      // 批 R2 补 project:save：store 的 removeSegment/addSegment 只改内存 + notify，
      // 落盘在随后 storeSave → project:save；本回调读 storeLoad（落盘态），故需放行该事件
      // R-20③：白名单补 editingState:update 且 keys 只认 mainClips——画布 persistCanvas 拖节点/
      //   改参数高频写 keys=["canvas"] 等不进顶栏（preview.js:628-640 keys 过滤先例）。
      //   顶栏回调仅刷文本非重挂，不采 preview 的延后一拍（无重挂风暴问题）。
      if (evt.type !== "segment:add" && evt.type !== "segment:remove" && evt.type !== "segment:move"
        && evt.type !== "segment:update" && evt.type !== "project:save"
        && evt.type !== "project:meta-update") {
        if (evt.type !== "editingState:update" || !Array.isArray(evt.keys) || !evt.keys.includes("mainClips")) return;
      }
      const _p = storeLoad(state.projectId);
      const _n = _p && Array.isArray(_p.segments) ? _p.segments.length : 0;
      const _t = t("shell.top.willSubmit", { n: _n });
      runhint.textContent = _t;
      runhint.title = _t;
      status.title = _t;
      // R-20③：与初始挂载同口径——确有 mainClips 数据才实时推导（见 _comp0 注记）
      const _mc = _p && _p.editingState && _p.editingState.mainClips;
      const _comp = Array.isArray(_mc)
        ? deriveProjectCompletion(_p && _p.segments, _mc, _p && _p.runs)
        : null;
      // #63 T4：状态条/进度条随 currentRunId 指针行（缺失/悬空回落 runs[0]）
      const _curRun = currentRunRow(_p);
      const _rs = runStateFromRuns(_curRun);
      statusText.textContent = formatRunStatus(_rs, _n, _comp);
      // F102（走查）：灯色随运行态翻转——与挂载 :1361-1364 同口径（running→warn 黄·终态清空）。
      //   此前回调只刷文案/进度条：挂载时 running 的项目跑完后灯恒黄，须重进页面才翻绿。
      lamp.setAttribute("style", _rs && _rs.running ? "margin-right:5px;background:var(--warn)" : "margin-right:5px");
      // 批 1-T3 · C3：进度条随运行态同步（在跑 → 挂/续计时；终态 → 摘除停表）
      _pwsProgressSync(head, status, _rs, _curRun);
      // 登记项 7：runs 区随 meta-update 刷新（submit 落账/终态更新 → 重建记录区·现行置顶）
      // B4-T2 旧债清偿：原判据 `_runsBlockEl._parent` 是 fake-DOM 专属属性（真 DOM 无 _parent
      //   → 真机恒假 → 重跑/提交落账后 runs 区从不就地刷新，仅路由重进重建）——改真 DOM 连接态判据。
      if (evt.type === "project:meta-update" && _runsBlockEl && _runsBlockEl.isConnected !== false) {
        const _nb = buildRunsBlock(Array.isArray(_p && _p.runs) ? _p.runs : [], {
          router, projectId: state.projectId, currentRecordId: (_p && _p.currentRunId) || "",
        });
        _runsBlockEl.replaceWith(_nb);
        _runsBlockEl = _nb;
      }
    });
  }

  // S1-4 E008：创作画布入口（v43 .canvas-entry · 带当前项目 id 进画布）
  // 批 R7 · B02：canvas 13 取代「▣ 」字符（原型 v43 :1141）
  const cvEntry = el("span", {
    class: "ghostbtn canvas-entry",
    title: t("shell.top.canvasTitle"),
  });
  cvEntry.appendChild(el("span", { "data-ic": "canvas", "data-sz": "13" }));
  cvEntry.appendChild(document.createTextNode(t("shell.nav.canvas")));
  cvEntry.addEventListener("click", () => {
    router.go(`/canvas?p=${encodeURIComponent(state.projectId)}`);
  });
  head.appendChild(cvEntry);

  // ===== 批 R2 · A03：重置草稿（v43 :1142 dangerbtn#resetBtn · 清段数据）=====
  // 批 R8（R2 遗留订正）：title 去掉原型「旧稿可从回收站找回」句——GUI 无草稿快照通道，承诺不成立
  // 体验修复 C-8：3 秒两次点击臂退役 → 确认弹窗（openConfirm danger 形态·文案说明清空范围）
  const resetBtn = el("span", {
    class: "dangerbtn",
    id: "resetBtn",
    title: t("shell.top.resetTitle"),
  });
  resetBtn.appendChild(el("span", { "data-ic": "trash", "data-sz": "13" }));
  resetBtn.appendChild(document.createTextNode(t("shell.top.reset")));
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openConfirmModal({
      title: t("shell.top.reset"),
      sub: t("shell.top.resetSub"),
      danger: true,
      confirmText: t("shell.top.resetConfirm"),
      onConfirm: () => {
        if (applyResetDraft(state.projectId)) {
          showToast("success", t("shell.top.resetDone"));
        } else {
          showToast("error", t("shell.top.resetFail"));
        }
      },
    });
  });
  head.appendChild(resetBtn);

  // ===== 批 R2 · A04：只重渲失败段（v43 :1143 · 批 0-T3 占位 · B4-T2 接真）=====
  //   通道（B4-T2 D2）：runs[0].stem（守卫不测 loadedTaskId——两键可分叉）→ GET history/detail
  //   拉 shots（dict 形态·Object.entries 注入 sid 转数组——edit.js applyHistory :3487-3490 同款）
  //   → defaultSelection 过滤（core/rerun.js:186-188 含 failed/stopped/void·勿用 voidSidsForTask
  //   ——其只返 success+void）→ 空集 toast「无失败段」→ 非空 runRerunFlow（label 只重渲失败段）。
  //   shell.css 档2 ≤1490 图标化锚改挂 #rerunFailedBtn（原 .ghostbtn.pending-off 随接真退役）。
  const rerunFailed = el("span", {
    class: "ghostbtn",
    id: "rerunFailedBtn",
    title: t("shell.top.rerunFailedTitle"),
  });
  rerunFailed.appendChild(el("span", { "data-ic": "refresh", "data-sz": "13" }));
  rerunFailed.appendChild(document.createTextNode(t("shell.top.rerunFailed")));
  rerunFailed.addEventListener("click", () => { void _rerunFailedSegments(state.projectId); });
  head.appendChild(rerunFailed);

  // ===== S1-2 T5：拼接口径三档 + 次数 顶栏控件（v43 :1145-1147 · v25 W6）=====
  // 三档 select 写 store.projMode；次数 number 写 store.runCount
  // projMode 变更 → 调度 segcards 重渲染（段徽标重派生 + 拼接 chk 联动）
  // 战役批1-T6 · F-81：三档常量已上提至模块顶层（PROJ_MODE_OPTS·画布 G 节点共用）
  const modeLabel = el("span", { style: "font-size:12px;color:var(--txt3)", text: t("shell.top.mode") });
  head.appendChild(modeLabel);
  const projModeSel = el("select", { id: "projMode", class: "selx", title: PROJ_MODE_OPTS.map((o) => o.title).join(" / ") });
  for (const opt of PROJ_MODE_OPTS) {
    const o = el("option", { value: opt.value, text: opt.label });
    if (proj.projMode === opt.value) o.selected = true;
    projModeSel.appendChild(o);
  }
  projModeSel.addEventListener("change", () => applyTopbarChange(proj, state.projectId, { projMode: projModeSel.value }));
  head.appendChild(projModeSel);

  // 老板 2026-09-27 走查：label 文案「次数」→「每段几版」（title 保持原型原文）
  const countLabel = el("span", { style: "font-size:12px;color:var(--txt3)", title: t("shell.top.perRunTitle"), text: t("shell.top.perRun") });
  head.appendChild(countLabel);
  const runCountIn = el("input", { id: "runCount", class: "selx", type: "number", min: "1", max: "50", value: String(proj.runCount || 1) });
  runCountIn.style.cssText = "width:54px;padding:7px 6px";
  runCountIn.title = t("shell.top.perRunTitle");
  runCountIn.addEventListener("input", () => {
    const v = parseInt(runCountIn.value, 10);
    if (!Number.isNaN(v) && v > 0) applyTopbarChange(proj, state.projectId, { runCount: v });
  });
  // 体验修复 C-7：change（失焦/回车）时钳制 1-50——越界自动修正 + toast 说明；input 中途不打断输入
  runCountIn.addEventListener("change", () => {
    const v = parseInt(runCountIn.value, 10);
    const c = clampRunCount(v);
    if (c !== v) {
      runCountIn.value = String(c);
      applyTopbarChange(proj, state.projectId, { runCount: c });
      showToast("warn", t("shell.top.perRunClamp", { n: c }));
    }
  });
  head.appendChild(runCountIn);

  // ===== S1-2 T6: 提交按钮挂载点（最小侵入 — 仅占位 div, mountSubmitBar 由调用方按需注入）=====
  // 右缘组起点（原型 v43 :1148 runbtn 靠右：运行项目/更多/芯片）
  const submitSlot = el("div", { id: "submitBarSlot", class: "submit-bar-slot" });
  submitSlot.style.marginLeft = "auto";
  head.appendChild(submitSlot);

  // 「⋯ 更多」按钮（B010：本任务实装 .pmenu 弹菜单 4 项）
  // 批 R2 · B04：title 还原 v43 :1149 三入口原文（原「项目菜单」）
  const more = el("span", {
    class: "ghostbtn",
    id: "projMoreBtn",
    title: t("shell.top.moreTitle"),
  });
  more.appendChild(document.createTextNode(t("shell.top.more")));
  head.appendChild(more);
  // B010 菜单本体（.pmenu 样式已在 theme.css）
  // S1-1 修 5 节点门修正：模块级单例复用 — 路由切换 / 二次进入项目视图时，
  // 旧的 pmenu DOM 节点 + document click 监听如不摘除，会无限堆叠。
  // 策略：首次进入项目视图建 DOM + 绑监听；后续路由进入前先摘旧监听并移除旧 DOM；
  //       路由离开 / 切到非 project 视图时仅隐藏（DOM 与 document 监听均单例常驻复用，不重复挂载）
  // 批 9 T3 · 17-4：pmenu position:fixed + 打开瞬间一次性坐标 → resize 后错位；
  //   改经 ui/anchor.js followAnchor 锚定（F37 同款——绑即定位 + scroll/resize 跟随），
  //   右对齐口径不变（left = 锚右缘-190·.pmenu min-width 190 / top = 锚下缘+4）。
  //   锚句柄模块级单例配对 pmenu：hide（含 document 外点关闭）即 detach 防监听泄漏。
  const ensurePmenu = () => {
    if (typeof document === "undefined") return { pmenu: null, hide: () => {}, toggle: () => {} };
    let pmenu = document.getElementById("projMoreMenu");
    let onDocClick = _pmenuDocClickHandler;
    if (!pmenu) {
      pmenu = el("div", { class: "pmenu", id: "projMoreMenu", "data-pmenu": "project" });
      pmenu.appendChild(menuItem(t("shell.menu.projectSettings"), () => router.go("/settings"), "sliders"));
      // W-02/W-03 转正：导入/导出 CSV 真链路（模块级锚 _csvCtxProjectId·pmenu 单例回调不闭包旧 state）
      pmenu.appendChild(menuItem(t("shell.menu.importCsv"), () => { _importCsvAction(); }, "plus"));
      pmenu.appendChild(menuItem(t("shell.menu.exportCsv"), () => { void _exportCsvAction(); }, "download"));
      // H-T4 R-04：接真（registerPending 空挂退场·W-04）——路径源见 _openProjectFolder 注记
      pmenu.appendChild(menuItem(t("shell.menu.openFolder"), () => { void _openProjectFolder(); }, "folder"));
      document.body.appendChild(pmenu);
      pmenu.style.display = "none";
      hydrateIcons(pmenu); // 批 R8 · R7-3：菜单项 data-ic → svg（幂等·单例建一次）
    }
    if (!onDocClick) {
      onDocClick = () => { _pmenuHide(pmenu); };
      _pmenuDocClickHandler = onDocClick;
      document.addEventListener("click", onDocClick);
    }
    return {
      pmenu,
      hide: () => { _pmenuHide(pmenu); },
      toggle: () => {
        const show = pmenu.style.display !== "block";
        if (show) {
          if (_pmenuAnchor) _pmenuAnchor.detach(); // 幂等防御：无 hide 落档的旧句柄先摘
          _pmenuAnchor = followAnchor(more, pmenu, {
            position: (r) => ({ left: Math.max(8, r.right - 190), top: r.bottom + 4 }),
          });
        } else {
          _pmenuHide(pmenu);
          return;
        }
        pmenu.style.display = "block";
      },
    };
  };
  const pmenuApi = ensurePmenu();
  // 切显隐
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof document === "undefined" || !pmenuApi.pmenu) return;
    pmenuApi.toggle();
  });
  // 离开项目视图：仅隐藏 DOM（单例常驻，下次进入复用；document 监听单份不重复挂）
  // 注意：项目视图顶栏由 buildProjectTopbar 每次路由进入重建；此处仅在函数返回前同步隐藏即可
  if (pmenuApi.pmenu) pmenuApi.hide();

  // 老板走查快批⑦：芯片已移出本行（原为 head.appendChild(chip) → 贴「⋯ 更多」行尾）——
  //   现挂壳层 .shell-eng-slot（F57 起落侧栏底部）；原 .pws-head padding-right 避让补丁已随 F57 摘除。

  // ===== 批 R2 · A01：.runs 运行记录区（v43 :1151-1186 · 落位第一行与 TAB 行之间）=====
  //   数据源：project.runs（倒序·现行置顶）——store/submit 均无历史落盘 → 读到 [] 走实况空态
  const _runs = Array.isArray(proj && proj.runs) ? proj.runs : [];
  // 登记项 7：let 持引用——上方 storeSubscribe 回调里 meta-update 时整块替换刷新（真数据源）
  let _runsBlockEl = buildRunsBlock(_runs, {
    router, projectId: state.projectId, currentRecordId: (proj && proj.currentRunId) || "",
  });
  wrap.appendChild(_runsBlockEl);

  // —— 第二行 .ptabs（独立 TAB 行·v43 :1187-1191 / :256 .ptabs 独立块级带底边线）——
  const ptabs = el("div", { class: "ptabs", id: "ptabs" });
  PROJ_TABS.forEach((tb) => {
    const ptab = el("span", {
      class: "ptab" + (tb.key === state.tab ? " on" : ""),
      "data-t": tb.key,
      title: tb.label,
    });
    // 批 R7 · B08：TAB 图标 span（原型 v43 :1188-1190 data-ic 15px · frame 未渲染的补渲染）
    ptab.appendChild(el("span", { "data-ic": tb.icon, "data-sz": "15" }));
    ptab.appendChild(document.createTextNode(tb.label));
    ptab.addEventListener("click", () => {
      router.go(`/project/${encodeURIComponent(state.projectId)}?tab=${tb.key}`);
    });
    ptabs.appendChild(ptab);
  });
  wrap.appendChild(ptabs);

  // 批 R2 · A01/A03/A04：顶栏新增 data-ic（runs-cap refresh/chev、resetBtn trash、只重渲 refresh）
  // —— 渲染后 hydrate（v43 :2453 同款注入口）
  hydrateIcons(wrap);

  return wrap;
}

// ===== S1-2 T5：顶栏控件变更统一入口 =====
// 数据流：patch → storeLoad 新鲜读 → merge → storeSave → notify → segcards rerender
// 调度策略（任务验收 #4）：projMode 改 → segcards rerenderSegcardsByProject（段徽标重派生 / 拼接 chk 联动）
// S2-2 FIX-1：必须 storeLoad 新鲜读再改写——storeSave 是整体保存（JSON.stringify 整对象），
// 持挂载时的副本做 Object.assign 后 storeSave 会把其他控件（setup 后处理三键/全局参数等）
// 写入同一 store 的并发字段覆写回旧值。
// proj 参数签名保留（向后兼容调用方），但内部不再用 proj 做整体保存。
export function applyTopbarChange(proj, projectId, patch) {
  if (!projectId || !patch) return;
  const fresh = storeLoad(projectId);
  if (!fresh) return;
  Object.assign(fresh, patch);
  storeSave(fresh);
  if ("projMode" in patch) {
    // 段徽标重派生 + 拼接 chk 联动 → segcards 全段重渲染
    if (segcards && typeof segcards.rerenderSegcardsByProject === "function") {
      try { segcards.rerenderSegcardsByProject(projectId); }
      catch (_e) { /* 段卡未挂载时静默 */ }
    }
  }
}

// ===== R56R57-S3 T3：乙档后期处理编排接线（core/postfx_pipeline.js）=====
//   进度/终态消费 = toast（既有件·不新造 UI 组件）：「后期处理 第 N/共 M 段·超分+插帧中」。
//   触发：主链 onComplete（主生成链完成&&参数有勾·无勾选零编排在模块内闸）；
//   onFailed（引擎中断合成终态）→不编排；重进对账挂项目视图 mount。
//   #26 裁决①：ctx={projectId, taskId?}——settle 收口自动拼接取编排所用任务号。
function _postfxToastIo(pp, ctx = {}) {
  return {
    onProgress: (prog) => showToast("info", pp.postfxProgressText(prog)),
    onSettled: (res) => {
      showToast(
        res && res.interrupted ? "error" : (res && res.result === "failed" ? "warn" : "success"),
        pp.postfxSettleText(res),
      );
      // #26 裁决①：settle 收口自动拼接（ok 且零失败才拼·异步不阻断终态 toast）——
      //   本消费端一处覆盖全部 settle 点（中断收口/编排收口/对账空闲收口/全完成收口）。
      //   （老板裁决 A·2026-10-28：G6 route② settle 收口自动归档钩子撤除——跑完一律
      //   留原位·归档只走历史行「归档」手动通道。）
      void autoConcatAfterSettle(pp, res, ctx).catch(() => { /* 失败已 toast 收尾·不外抛 */ });
    },
    // R-57：有勾选但任务号三路（直递/runs 兜底/loadedTaskId）全空 → 可见提示（不静默不中断）
    onNoTask: () => showToast("warn", pp.POSTFX_NO_TASK_TEXT),
  };
}

// ===== #26 裁决① T3：后期编排 settle 收口自动拼接成片 =====
//   settle ok 且零失败 → toast「后期完成·正在拼接成片」→ concatApi({taskId, mode:"global"})。
//   409 忙类（引擎拼接/收尾窗互斥）退避重试：判据复用 postfx_pipeline._isBusyRunErr（本笔最小
//   export）+ 同源指数退避参数（base 2s·单次上限 60s·总预算 900s=模块 _normalizeIo 同值·
//   #50-4 由 180s 放宽——共享引擎另一单渲染超 3 分钟时收口拼接不再直接放弃）；
//   超预算最终失败 → toast「自动拼接未完成·可稍后在历史行手动拼接」收尾（方案审建议 11）。
//   有失败段 → 不自动拼（避免拼出半后期成片）+ 失败说明 toast。
//   任务号 = settle 时编排所用任务号：ctx.taskId（主链直递）→ runs 最新 postfx 行 taskId
//   （对账路径·行即编排上下文落账·零另查）。导出便于测试（deps 全量可注入·假钟零真睡）。
const POSTFX_AUTO_CONCAT_START_TEXT = () => t("shell.postfx.autoStart");
const POSTFX_AUTO_CONCAT_FAIL_TEXT = () => t("shell.postfx.autoFail");

function _latestPostfxRowTaskId(projectId) {
  const p = projectId ? storeLoad(projectId) : null;
  const row = (p && Array.isArray(p.runs))
    ? p.runs.find((r) => r && r.kind === "postfx" && typeof r.taskId === "string" && r.taskId)
    : null;
  return row ? row.taskId : "";
}

export async function autoConcatAfterSettle(pp, res, ctx, deps = {}) {
  const r = res && typeof res === "object" ? res : {};
  const o = deps && typeof deps === "object" ? deps : {};
  const concatFn = typeof o.concatApi === "function" ? o.concatApi : concatApi;
  const isBusyRunErr = typeof o.isBusyRunErr === "function"
    ? o.isBusyRunErr
    : (pp && typeof pp._isBusyRunErr === "function" ? pp._isBusyRunErr : () => false);
  const baseMs = typeof o.busyBackoffBaseMs === "number" && o.busyBackoffBaseMs > 0 ? o.busyBackoffBaseMs : 2000;
  const maxMs = typeof o.busyBackoffMaxMs === "number" && o.busyBackoffMaxMs > 0 ? o.busyBackoffMaxMs : 60000;
  const budgetMs = typeof o.busyRetryBudgetMs === "number" && o.busyRetryBudgetMs > 0 ? o.busyRetryBudgetMs : 900000;
  const sleep = typeof o.sleep === "function" ? o.sleep : ((ms) => new Promise((done) => setTimeout(done, ms)));
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const taskId = (typeof c.taskId === "string" && c.taskId) || _latestPostfxRowTaskId(c.projectId);
  if (!r.ok || r.failed > 0) {
    // 有失败段 → 不自动拼 + 说明（中断/不可达收口由终态 toast 自述·此处只认失败段）
    if (r.failed > 0) showToast("warn", t("shell.postfx.segFailed", { n: r.failed }));
    return { ok: false, skipped: true };
  }
  if (!taskId) {
    showToast("warn", POSTFX_AUTO_CONCAT_FAIL_TEXT());
    return { ok: false, reason: "no_task" };
  }
  showToast("success", POSTFX_AUTO_CONCAT_START_TEXT());
  let attempt = 0;
  let waited = 0;
  for (;;) {
    const cr = await concatFn({ taskId, mode: "global" });
    if (cr && cr.ok) {
      return { ok: true, r: cr };
    }
    if (!isBusyRunErr(cr)) break;   // 非忙类=非暂时态不重试
    const delay = Math.min(baseMs * 2 ** attempt, maxMs);
    if (waited + delay > budgetMs) break;   // 超预算（检查先于等待·对齐 _runSegWithRetry 口径）
    waited += delay;
    attempt++;
    showToast("info", t("shell.postfx.busy"));   // #50-4: 等待期可见反馈（镜像 postfx 侧逐次忙等提示）
    await sleep(delay);
  }
  showToast("warn", POSTFX_AUTO_CONCAT_FAIL_TEXT());
  return { ok: false, reason: "concat_failed" };
}

// #64：在飞后期编排链登记（原 void 空投无句柄可查/可等）——取消本身走 core
//   cancelPostfxFor 按项目令牌（views→core 导入调用·ESM 单向），此处持句柄供生命周期观测。
const _postfxChains = new Map();   // projectId → Promise（收口即摘）

function _trackPostfxChain(projectId, chain) {
  const pid = typeof projectId === "string" ? projectId : "";
  if (!pid || !chain || typeof chain.then !== "function") return chain;
  _postfxChains.set(pid, chain);
  const drop = () => { if (_postfxChains.get(pid) === chain) _postfxChains.delete(pid); };
  chain.then(drop, drop);
  return chain;
}

// 测试观测面：在飞编排链数（句柄登记/摘除断言）
export function _test_postfxChainCount() { return _postfxChains.size; }

function _startPostfxOrchestration(projectId, taskId) {
  return _trackPostfxChain(projectId, import("../core/postfx_pipeline.js")
    .then((pp) => pp.startPostfxForProject(projectId, _postfxToastIo(pp, { projectId, taskId }), taskId))
    .then((r) => {
      // #33 C 档（可观测性）：no_plan（全局六键未开）与空集 noop（无可处理段——#33 形态下
      //   即「回轨未落盘即被读」的痕迹面）此前全静默零痕迹；主链消费端补可见提示
      //   （重跑侧先例 rerun_flow.js:107-110）。仅本消费端——重跑补链走
      //   supplementPostfxAfterRerun 桥不经此，重跑侧行为零变化。
      if (r && r.ok === false && r.reason === "no_plan") {
        showToast("info", t("shell.postfx.noPlan"));
      } else if (r && r.ok && r.noop) {
        showToast("warn", t("shell.postfx.noop"));
      }
      return r;
    })
    .catch(() => { /* 编排启动失败不阻断主链收尾 */ }));
}
function _reconcilePostfxOnMount(projectId) {
  return _trackPostfxChain(projectId, import("../core/postfx_pipeline.js")
    .then((pp) => pp.reconcilePostfx(projectId, _postfxToastIo(pp, { projectId })))
    .catch(() => { /* 对账失败不阻断页面渲染 */ }));
}

// ===== 视图渲染 =====
function renderRoute(viewsEl, topbarEl, state, router) {
  if (!viewsEl) return;
  // S1-3 T3：剪辑 TAB 会话态卸载（订阅/定时器/文档委托守门清位）——幂等，非 edit 路由也安全
  if (edit && typeof edit.unmount === "function") edit.unmount();
  // 走查反馈 F19：预览 TAB 会话态卸载（monDrawer 摘除——此前 preview 无 unmount·抽屉残留 body
  //   带到项目列表页遮挡元素；edit↔preview 互切时另侧 mount 重建·幂等）
  if (preview && typeof preview.unmount === "function") preview.unmount();
  // S1-4 T1：资产库会话态卸载（同 edit 模式·幂等）——视图无订阅/定时器，置空会话态 + 迟到响应丢弃
  if (assets && typeof assets.unmount === "function") assets.unmount();
  // S1-4 T3：创作画布会话态卸载（订阅退订 + 单例菜单/弹窗/确认臂清位·幂等）
  if (canvas && typeof canvas.unmount === "function") canvas.unmount();
  // #36：历史记录视图会话态卸载（观察器摘除 + detail 缓存清·幂等）
  if (historyView && typeof historyView.unmount === "function") historyView.unmount();
  // 批1-T5 · H4：提交栏会话态卸载（摘文档键监听——重挂/离页不累积；下次进项目视图重挂）
  if (_submitBarHandle && typeof _submitBarHandle.unmount === "function") {
    try { _submitBarHandle.unmount(); } catch (_e) { /* 摘除失败不阻断渲染 */ }
    _submitBarHandle = null;
  }
  clearChildren(viewsEl);
  clearChildren(topbarEl);
  topbarEl.appendChild(buildTopbar(state, router));
  highlightNav(state);

  if (state.view === "home") {
    if (portal && typeof portal.mount === "function") {
      portal.mount(viewsEl);
    } else {
      const ph = el("section", { id: "view-home", class: "shell-view" });
      ph.appendChild(el("div", { class: "shell-tab-placeholder" }, [
        el("div", { class: "ph-cap", text: t("shell.ph.portalMissing") }),
      ]));
      viewsEl.appendChild(ph);
    }
    return;
  }
  if (state.view === "projects") {
    // S1-1 T3 接管项目管理视图：替换原占位壳
    if (projects && typeof projects.mount === "function") {
      projects.mount(viewsEl);
    } else {
      const ph = el("section", { id: "view-projects", class: "shell-view" });
      ph.appendChild(el("div", { class: "shell-tab-placeholder" }, [
        el("div", { class: "ph-cap", text: t("shell.ph.projectsMissing") }),
      ]));
      viewsEl.appendChild(ph);
    }
    return;
  }
  if (state.view === "history") {
    // #36 左侧栏「历史记录」：接管历史记录视图（全库聚合·按项目分组·行操作）
    if (historyView && typeof historyView.mount === "function") {
      historyView.mount(viewsEl);
    } else {
      const ph = el("section", { id: "view-history", class: "shell-view" });
      ph.appendChild(el("div", { class: "shell-tab-placeholder" }, [
        el("div", { class: "ph-cap", text: t("shell.ph.historyMissing") }),
      ]));
      viewsEl.appendChild(ph);
    }
    return;
  }
  if (state.view === "project") {
    const sec = el("section", { id: "view-project", class: "shell-view" });
    const tabWrap = el("div", { class: "pview", id: "projTabContent" });
    tabWrap.setAttribute("data-tab", state.tab || "preview");
    // S1-2 T2 接入：setup TAB 实装（输出开关 + 后处理网格；全局参数经 S2-2 T1 涟漪为 17 键）
    // S1-3 T3 接入：edit TAB 实装（三轨时间线 + 播放器）
    // 批 R3 · ② A05 接入：preview TAB 实装（操作条+全片预览+胶片条 · v43 :1194-1212）
    if (state.tab === "setup" && setup && typeof setup.mount === "function") {
      setup.mount(tabWrap, state.projectId);
    } else if (state.tab === "edit" && edit && typeof edit.mount === "function") {
      edit.mount(tabWrap, state.projectId);
    } else if (state.tab !== "setup" && state.tab !== "edit" && preview && typeof preview.mount === "function") {
      // preview 为默认/兜底 tab（与 tabKeyByIndex 越界→preview 惯例一致）
      preview.mount(tabWrap, state.projectId);
    } else {
      const ph = el("div", { class: "shell-tab-placeholder" });
      ph.appendChild(el("div", {
        class: "ph-cap",
        text: t("shell.ph.tabMissing", { name: PROJ_TABS.find((tb) => tb.key === state.tab)?.label || state.tab || "" }),
      }));
      tabWrap.appendChild(ph);
    }
    sec.appendChild(tabWrap);
    viewsEl.appendChild(sec);

    // ===== S1-2 T6: 顶栏提交按钮挂载（最小侵入 — 路由进项目视图后调 mountSubmitBar）=====
    //   顶栏 #submitBarSlot 占位 div 已在 buildProjectTopbar 创建
    //   S2-2 FIX-1：传 getProject 活读取（穿透 setup/段卡后续编辑的 store 更新），
    //   挂载时刻的 project 快照仅作向后兼容保留——mountSubmitBar 内部点击时优先解 getProject()。
    if (typeof document !== "undefined") {
      // 用 setTimeout 让顶栏 DOM 先落地, 再注入按钮 (避免同步链上的顺序耦合)
      setTimeout(() => {
        const slot = document.getElementById("submitBarSlot");
        // T9 真机走查修正：原代码引用的局部变量 proj 不在本函数域（buildProjectTopbar 内），
        // 致挂载条件永假且异步 ReferenceError 被 catch 链吞掉无痕——真机上提交按钮从未渲染
        const proj = storeLoad(state.projectId);
        if (slot && proj) {
          // 动态 import 避免 shell.js 直接依赖 submit-bar 链路
          import("./submit-bar.js").then((mod) => {
            if (mod && typeof mod.mountSubmitBar === "function") {
              // 批1-T5 · H4：持 handle（renderRoute 顶部统一 unmount·防 Ctrl+Enter 文档键监听累积）
              _submitBarHandle = mod.mountSubmitBar({
                container: slot,
                project: proj,
                getProject: () => storeLoad(state.projectId),
                // 批 9 T3 · 18-8：提交受理成功 → 自动切 preview TAB（v43 .inh「渲染中此 TAB 自动切为
                //   实时预览」承诺兑现——router 既有机制纯接线；已在 preview 不重跳·恢复链不触发）
                onSubmitted: () => {
                  if (state.tab !== "preview") {
                    router.go(`/project/${encodeURIComponent(state.projectId)}?tab=preview`);
                  }
                },
                // R56R57-S3 T3 + R-57 真机修复：主链终态钩子 → 乙档逐段串联编排（全模式接管
                //   含拼接模式·CSV 通道休眠无双跑）。任务号直递=onComplete 载荷 taskId（submit-bar
                //   onFinal 补带本次 stem）——R-57 直递链路保持有效（#27 后 loadedTaskId 已恒持
                //   最新主链 stem）；直递缺失时模块内落 runs 兜底/loadedTaskId 两路，三路全空 toast 提示。
                //   onFailed（引擎中断合成终态）→ 不编排。
                onComplete: (payload) => {
                  _startPostfxOrchestration(state.projectId, payload && payload.taskId);
                  // （老板裁决 A·2026-10-28：G6 route① 渲染终态自动归档挂点撤除——跑完一律
                  //   留原位·归档只走历史行「归档」手动通道。）
                },
                onFailed: () => {},
              });
            }
          }).catch(() => { /* submit-bar 未就位时静默 */ });
          // R56R57-S3 T3：重进对账——刷新/切页重挂查 runs 活跃 postfx 行 × 引擎态：
          //   running→重建轮询续排；空闲→按已记录段级成败收口；不可达→行落中断态。
          //   同项目活链在跑去重在模块内（重挂不双跑）。
          void _reconcilePostfxOnMount(state.projectId);
        }
      }, 0);
    }
    return;
  }
  if (state.view === "assets") {
    // S1-4 T1 接管资产管理视图：替换原占位壳（E001-E007）
    if (assets && typeof assets.mount === "function") {
      assets.mount(viewsEl);
    } else {
      const ph = el("section", { id: "view-assets", class: "shell-view" });
      ph.appendChild(el("div", { class: "shell-tab-placeholder" }, [
        el("div", { class: "ph-cap", text: t("shell.ph.assetsMissing") }),
      ]));
      viewsEl.appendChild(ph);
    }
    return;
  }
  if (state.view === "ai") {
    // 批 R5 · S3-4d：AI 协作视图整页实装（v43 :1693-1728 · 视图壳+归档真实化 · LLM 后端远期专项）
    // B6-T4 裁决扩界③：挂载带项目上下文（#/ai?p= → 智能拆镜采纳/T5 互导的当前项目）
    if (aiArchive && typeof aiArchive.mount === "function") {
      aiArchive.mount(viewsEl, { projectId: state.p || "" });
    } else {
      const ph = el("section", { id: "view-ai", class: "shell-view" });
      ph.appendChild(el("div", { class: "shell-tab-placeholder" }, [
        el("div", { class: "ph-cap", text: t("shell.ph.aiMissing") }),
      ]));
      viewsEl.appendChild(ph);
    }
    return;
  }
  const sec = el("section", { id: "view-" + state.view, class: "shell-view" });
  if (state.view === "canvas") {
    // S1-4 T3：创作画布视图实装（E008-E029 · 节点/连线/全局/历史/保存）
    if (canvas && typeof canvas.mount === "function") {
      canvas.mount(sec, { projectId: state.projectId });
    } else {
      const ph = el("div", { class: "shell-tab-placeholder" });
      ph.appendChild(el("div", { class: "ph-cap", text: t("shell.ph.canvasMissing") }));
      sec.appendChild(ph);
    }
    viewsEl.appendChild(sec);
    return;
  }
  if (state.view === "settings") {
    // S1-2 T7：设置页实装包（四件 + 顶栏三态芯片真实探测）
    // 批 R5：AI 归档组迁出设置页（B-1 ①）→ 不再挂 onArchiveMount 钩子
    if (settings && typeof settings.mount === "function") {
      settings.mount(sec);
    } else {
      const ph = el("div", { class: "shell-tab-placeholder" });
      ph.appendChild(el("div", { class: "ph-cap", text: t("shell.ph.settingsMissing") }));
      sec.appendChild(ph);
    }
    viewsEl.appendChild(sec);
    return;
  }
  // 占位壳（2026-09-24 老板反馈修正：占位页要有入口+文字提示，不能只一行干巴巴文字）
  const phCap = el("div", { class: "ph-cap", text: placeholderText(state.view) });
  const phSub = el("div", {
    class: "ph-sub",
    style: "color:var(--txt3);font-size:13px;margin-top:8px",
    text: t("shell.ph.sub"),
  });
  const phBtns = el("div", { style: "display:flex;gap:10px;margin-top:16px" });
  const goHome = el("span", { class: "ghostbtn", text: t("shell.ph.goHome"), title: t("shell.ph.goHomeTitle") });
  goHome.addEventListener("click", () => router.go(""));
  const goProj = el("span", { class: "ghostbtn", text: t("shell.ph.goProjects"), title: t("shell.ph.goProjectsTitle") });
  goProj.addEventListener("click", () => router.go("/projects"));
  phBtns.appendChild(goHome);
  phBtns.appendChild(goProj);
  const phWrap = el("div", { class: "shell-tab-placeholder" }, [phCap, phSub, phBtns]);
  sec.appendChild(phWrap);
  viewsEl.appendChild(sec);
}

function placeholderText(view) {
  // P1 扫描 2026-09-27：占位壳兜底文案去批次承诺（S1-4/S3-4 已结束·三视图均已实装仅余兜底）
  switch (view) {
    case "assets":   return t("shell.ph.assets");
    case "ai":       return t("shell.ph.ai");
    case "canvas":   return t("shell.ph.canvas");
    default:         return t("shell.ph.default");
  }
}

function highlightNav(state) {
  if (typeof document === "undefined") return;
  const item = navItemForView(state.view);
  const viewKey = item ? item.view : null;
  const items = document.querySelectorAll("#nav .nav-item");
  items.forEach((n) => {
    if (viewKey && n.getAttribute("data-view") === viewKey) {
      n.classList.add("active");
    } else {
      n.classList.remove("active");
    }
  });
}
