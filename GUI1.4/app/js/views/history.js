// history.js — #36 左侧栏「历史记录」tab · T1 数据层（纯函数区·视图 DOM 归 T2）
//
// 方案：开发账本\方案-#36历史记录tab-2026-10-20.md（v2+N1·两轮方案审锁定）· 侦察：侦察-#36历史记录数据面-2026-10-20.md
//
// === 出处注记 ===
// 归属 join 源（方案 D2·B1 改写）：GUI 本地数据 = data/index.json 总表 × data/projects/*.json 实体的
//   runs[].stem；**跳过带 deletedAt 的已删项目（N1）——其任务归「未关联」组·不挂已删项目名**
//   （防跳详情打开已删工作区）。runs-index.json 不作归属源（edit.js:6117-6129 回写系引擎全量快照
//   未按项目过滤·且当前为空——记档）。
// 读通道：store.js:1148 load / :1211 listProjects 先例（只读；listProjects 默认已过滤已删项目，
//   buildStemIndex 再按 deletedAt 兜一道·防调用方喂入原始实体）。
// 匹配键：引擎 listHistory 列表项 task_id = stem（引擎按 manifest 名派生·__init__.py 5496-5513），
//   folder 是段 run_dir 的 basename·非 stem·不作匹配键。
// 序数推导（方案 D3）：主链 = runs 里无 kind 的记录（store.js:669 latestMainRunStem 同口径）；
//   runs 数组为 unshift 置顶的新→旧序（submit-bar.js:78-83）·序数自最旧 1 起算。
// 30 条封顶（submit-bar.js:77-83 runs.slice(0,30)）：被挤出的旧 run 不在 GUI 账 → 序数不可得
//   → 按方案口径**截断即降级**（行名落「未关联·时间·片段n」）。
//
// === API（纯函数·T2 视图层消费）===
//   loadLocalProjects()              — 本地项目实体读通道（只读 store）
//   buildStemIndex(projects)         — 项目实体 → stem 归属索引 Map
//   resolveOwnership(task, index)    — 引擎任务列表项 → {projectId, projectName} | null
//   mainRunOrdinal(runs, stem)       — 主链全量重跑序数（1 起·自最旧）| null（封顶截断/非主链）
//   segmentLabel(sid)                — 段标签「片段n」
//   stemTimeLabel(task)              — stem 时间「YYYY-MM-DD HH:mm」（降级行名用·恒可得）
//   rowNameFor(row)                  — 行名三形态（正常全量/正常重跑代际/降级未关联）
//   groupTasksByProject(tasks, idx)  — 任务列表 → 项目分组数组（未关联组殿后·组内时间倒序）

import { listProjects } from "../store/store.js";
// T2 视图区读通道（只读/既有端点·零新端点）：
//   history_ops：listHistory（引擎全库列表）/ loadDetail（段级明细）/ deleteSoft（单删·软删进回收站）
//   open_dir：resolveRunDir（行级 run_dir 解析·带缓存）/ openDirRequest（开文件夹发包）
//   api：mediaUrl（thumb/video 通道单源）/ setMediaSrc（引擎口→本地口回落接线）/ wireLocalFallback（缩略回落）
import { listHistory as apiListHistory, loadDetail as apiLoadDetail, deleteSoft as apiDeleteSoft, listTrash as apiListTrash, restore as apiRestore } from "../core/history_ops.js";
import { resolveRunDir as apiResolveRunDir, openDirRequest as apiOpenDirRequest } from "../core/open_dir.js";
import { mediaUrl, setMediaSrc, wireLocalFallback } from "../core/api.js";
import { showToast } from "../ui/toast.js";
import { openConfirm } from "../ui/modal.js";
import { t } from "../core/i18n.js";   // #92 B1：页面文案/展示名取词（zh 与源码字面量逐字一致·数据层零改）

// 未关联组：task_id 在 GUI 本地数据里查无归属（引擎有记录·GUI 无 run 记录/已删项目/旧任务）。
export const UNLINKED_GROUP_ID = "__unlinked__";
export const UNLINKED_GROUP_NAME = "未关联";
export const UNKNOWN_TIME = "未知时间";

// 项目 runs feed 封顶 30 条（submit-bar.js:77-83）——序数推导上限来源。
// 方案 §五 附录 2（知悉级记档）：记录数超 30 的项目·幸存主链的「第 N 次」会被低估
//   （引擎侧无权威序数字段·纯 GUI 推导）。
export const RUNS_FEED_CAP = 30;

// 方案 §五 附录 1 / 3（T2/T3 落位口径·本数据层不实现·随单记账防口径走样）：
//   附录 1：清空/单删遇枚举外错误（500 move 失败/网络错）= 与 409 同款中止 + 汇总（一行写死）。
//   附录 3：单删失败 toast 复用引擎中文 error.msg 透传（rerun_flow.js:252-256 先例）。

export function loadLocalProjects() {
  return listProjects();
}

// stem 归属索引：一次扫描建表（分组聚合与逐行归属共用同一张表）。
// 同名 stem 跨项目（不该发生）→ 先到者胜（输入序决定·结果确定）。
// #53 顺手①（批5-T1·2026-10-29）：任务句柄读 stem||taskId——postfx 行（无 stem 有 taskId·
//   taskId 即主链任务号）挤占 runs 30 封顶后主行被挤出，此前该任务查无归属误落「未关联」。
export function buildStemIndex(projects) {
  const idx = new Map();
  if (!Array.isArray(projects)) return idx;
  for (const p of projects) {
    if (!p || typeof p !== "object" || !p.id || typeof p.id !== "string") continue;
    if (p.deletedAt) continue;   // N1：已删项目整条跳过
    if (!Array.isArray(p.runs)) continue;
    for (const r of p.runs) {
      const stem = (r && typeof r.stem === "string" && r.stem) ? r.stem
        : ((r && typeof r.taskId === "string") ? r.taskId : "");
      if (!stem || idx.has(stem)) continue;
      idx.set(stem, { projectId: p.id, projectName: p.name });
    }
  }
  return idx;
}

export function resolveOwnership(task, stemIndex) {
  const stem = (task && typeof task.task_id === "string") ? task.task_id : "";
  if (!stem || !stemIndex || typeof stemIndex.get !== "function") return null;
  return stemIndex.get(stem) || null;
}

// 主链全量重跑序数：runs 新→旧置顶序·主链记录（无 kind）自最旧 1 起算。
// kind 记录（rerun/resume/seg_edit）不占主链序；stem 不在列表 → null（30 封顶挤出/非本项目 run）。
export function mainRunOrdinal(runs, stem) {
  if (!Array.isArray(runs) || !stem) return null;
  const mains = runs.filter((r) => r && !r.kind && r.stem);
  const i = mains.findIndex((r) => r.stem === stem);
  if (i < 0) return null;
  return mains.length - i;
}

// 段标签：sid 形态 sNN / shot_NNN（shell.js:514 解析先例）·认不出的原样带出·不谎报段号。
export function segmentLabel(sid) {
  const s = (sid == null) ? "" : String(sid);
  const m = s.match(/shot_(\d+)/) || s.match(/^s(\d+)$/);
  if (m) return t("hist.seg.n", { n: parseInt(m[1], 10) });
  return s ? t("hist.seg.raw", { s }) : t("hist.seg.unknown");
}

// 任务时间（epoch 秒·引擎 manifest mtime）；不可用 → 0（排序退化为入参序·不谎报）。
function taskTimeSec(task) {
  const sec = (task == null) ? 0 : Number(task.time);
  return (Number.isFinite(sec) && sec > 0) ? sec : 0;
}

function fmtLocalSec(sec) {
  const d = new Date(sec * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 降级行名的时间位：优先 stem 内时间戳（批次自证·恒可得）·坏 stem 回落 manifest mtime。
export function stemTimeLabel(task) {
  const stem = (task && typeof task.task_id === "string") ? task.task_id : "";
  const m = stem.match(/_(\d{8})_(\d{6})$/);
  if (m) {
    const d = m[1], t = m[2];
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
  }
  const sec = taskTimeSec(task);
  return sec ? fmtLocalSec(sec) : UNKNOWN_TIME;
}

// 行名三形态（方案 D3）：
//   ① 有归属 + 重跑代际 gen≥1 → 「片段n·第m次重跑」（gen = detail._reruns 里该 sid 的第 m 条·altChains 同源）
//   ② 有归属 + 主链序数可得    → 「项目名·第N次全量重跑·片段n」
//   ③ 其余（无归属 / 30 封顶丢序数 / 旧任务）→「未关联·<日期时间>·片段n」——三情形收敛同一形态。
export function rowNameFor(row) {
  const r = row || {};
  const own = r.ownership || null;
  const seg = segmentLabel(r.sid);
  const gen = Number(r.gen);
  if (own && Number.isInteger(gen) && gen >= 1) return t("hist.row.rerun", { seg, gen });
  const ord = Number(r.fullOrdinal);
  if (own && Number.isInteger(ord) && ord >= 1) return t("hist.row.full", { proj: own.projectName, ord, seg });
  // 常量保持中文原样（被测试逐字断言）；展示词在渲染路径经 t() 取词（zh 逐字相同）
  const timeLbl = stemTimeLabel(r.task);
  return t("hist.row.unlinked", { group: t("hist.unlinked"), time: timeLbl === UNKNOWN_TIME ? t("hist.unknownTime") : timeLbl, seg });
}

// 分组聚合：归属组在前（按组内最新时间倒序·并列按项目名/项目 id 定序），未关联组恒殿后。
export function groupTasksByProject(tasks, stemIndex) {
  if (!Array.isArray(tasks)) return [];
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const own = resolveOwnership(task, stemIndex);
    const gid = own ? own.projectId : UNLINKED_GROUP_ID;
    let g = byId.get(gid);
    if (!g) {
      g = { projectId: gid, name: own ? own.projectName : UNLINKED_GROUP_NAME, tasks: [] };
      byId.set(gid, g);
    }
    g.tasks.push(task);
  }
  const groups = [...byId.values()];
  for (const g of groups) g.tasks.sort((a, b) => taskTimeSec(b) - taskTimeSec(a));
  const topTime = (g) => (g.tasks.length ? taskTimeSec(g.tasks[0]) : 0);
  groups.sort((a, b) => {
    if (a.projectId === UNLINKED_GROUP_ID) return (b.projectId === UNLINKED_GROUP_ID) ? 0 : 1;
    if (b.projectId === UNLINKED_GROUP_ID) return -1;
    const d = topTime(b) - topTime(a);
    if (d) return d;
    const dn = String(a.name).localeCompare(String(b.name));
    return dn !== 0 ? dn : String(a.projectId).localeCompare(String(b.projectId));
  });
  return groups;
}

// ============================================================================
// T2 视图区（方案 D1/D4：挂载 + 分组折叠 + 视口懒拉 detail + 行形态三件）
//
// 视图口径（T1 数据层在上·此处只做 DOM 与行操作）：
//   进入 → listHistory（引擎全库）→ loadLocalProjects + buildStemIndex + groupTasksByProject 分组
//   分组 → 默认折叠·点组头展开/折叠；组内序 = T1 已定（时间倒序·未关联殿后）·此处不改
//   懒拉 → 展开组只生成任务块；任务块进入视口才 loadDetail（I4 硬要求）·结果进缓存 Map
//          缓存三口径：unmount 清 / 单删后失效 / 手动刷新钮清
//   行形态 → 预览图与名称分开展示（名称省略 + title 悬停全名）
//          点预览图 → 浮层播放该片段（showFinalPreview 同构·mediaUrl video 通道）
//          预览图右上「...」下拉三件：删除当前历史记录 / 打开文件夹 / 跳到项目详情（未关联行禁用）
//
// #64 T1 视图切换 + 图片墙（方案 D1/D2·挂在本视图工具区·不碰 shell.js）：
//   模式 → 会话态 s.viewMode（"list"|"grid"·初值=localStorage gui13.history.viewMode 读·坏值回落 list）
//   切钮 → 工具区「列表｜图片墙」两钮·当前态类 on·setViewMode 落 localStorage 并重渲染
//   图片墙 → 容器 .hist-grid（CSS grid 响应式）·卡 .hist-card
// #64 T2 卡粒度翻转（修订记录 2026-10-21 主代理裁决）：图片墙改**一片段一卡·与列表行同构**
//   （列表本就按片段分行·图片墙=同数据换铺法·多片段任务的其余片段不可隐没）
//   卡槽 .hist-cardslot（每任务一个·display:contents 摊平入网格）→ detail 到位后落该任务的 N 张片段卡
//     冷缓存时槽内先落真盒锚点 .hist-cardslot-anchor（槽自身无布局盒·懒载挂点挂锚点·见 renderCardSlot）
//   卡面与列表行同源：缩略图（懒载同机制）+ 名称省略/title 全名 + 右上「...」三件
//   勾选按卡记：卡键 = `${task_id}#${片段序}`·s.selectedIds（跨折叠保留·会话态）
// #64 T2b 件B 加载更多（全库可见·老板亲历「开始只展示部分历史」）：
//   底部钮「加载更多（已显示 X / 共 N 条）」·仅当 已显示任务数 < 引擎全库 N 时在位
//   点击 → listHistory({limit:50, offset:已显示数}) 追加任务 → 重渲染
//   重渲染保三样：分组展开态（s.openGroups）/ 勾选（s.selectedIds 会话态·2A 真承载）/ 视图模式（s.viewMode）
//   回收站子视图不出现·在途禁点（防重入）·引擎回短页/空页 = 取尽（钮消失）
// ============================================================================

// --- DOM 辅助（与 shell.js 同款最小实现）---
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

// --- 依赖注入位（单测替身·对齐 _test_setXxx 惯例）---
const _defaultDeps = {
  listHistory: (opts) => apiListHistory(opts),
  loadDetail: (opts) => apiLoadDetail(opts),
  deleteSoft: (opts) => apiDeleteSoft(opts),
  listTrash: (opts) => apiListTrash(opts),
  restore: (opts) => apiRestore(opts),
  resolveRunDir: (taskId) => apiResolveRunDir(taskId),
  openDirRequest: (path, opts) => apiOpenDirRequest(path, opts),
  toast: (kind, msg) => showToast(kind, msg),
  goProject: (projectId) => {
    const g = globalThis;
    if (g && g.location) g.location.hash = `#/project/${encodeURIComponent(projectId)}?tab=preview`;
  },
  makeObserver: defaultMakeObserver,
};
let _deps = Object.assign({}, _defaultDeps);
export function _test_setDeps(patch) { _deps = Object.assign({}, _deps, patch || {}); }
export function _test_resetDeps() { _deps = Object.assign({}, _defaultDeps); }
function dep(name) {
  const f = _deps[name];
  return typeof f === "function" ? f : _defaultDeps[name];
}

// 视口观察器（默认 IntersectionObserver；无此能力时退化为立即加载·不阻塞行）
function defaultMakeObserver(cb) {
  const g = globalThis;
  if (!g || typeof g.IntersectionObserver !== "function") return null;
  const io = new g.IntersectionObserver((entries) => cb(entries));
  return {
    observe: (n) => io.observe(n),
    unobserve: (n) => { try { io.unobserve(n); } catch (_e) { /* 已断开·忽略 */ } },
    disconnect: () => { try { io.disconnect(); } catch (_e) { /* 已断开·忽略 */ } },
  };
}

// --- 段级行模型（纯函数）---

// 引擎 detail 的 shots：对象形态（引擎实际回传）或数组形态（归一层兜底）都吃
function shotsOf(detail) {
  const raw = (detail && detail.raw && detail.raw.shots != null) ? detail.raw.shots
    : (detail ? detail.shots : null);
  const out = [];
  if (Array.isArray(raw)) {
    for (const s of raw) { if (s && s.sid) out.push([String(s.sid), s]); }
  } else if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) {
      const s = raw[k] || {};
      out.push([String(s.sid || k), s]);
    }
  }
  out.sort((a, b) => cmpSids(a[0], b[0]));
  return out;
}

// 引擎 manifest _reruns 账本（段×代际·段级代际行来源）
function rerunsOf(detail) {
  if (detail && detail.raw && Array.isArray(detail.raw._reruns)) return detail.raw._reruns;
  if (detail && Array.isArray(detail._reruns)) return detail._reruns;
  return [];
}

// sid 排序：尾号数字优先（s2 排在 s10 前）·同号回退字典序
function sidNum(sid) {
  const m = String(sid).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}
function cmpSids(a, b) {
  const na = sidNum(a), nb = sidNum(b);
  if (na != null && nb != null && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function firstFileOf(files) {
  if (Array.isArray(files)) return typeof files[0] === "string" ? files[0] : "";
  if (typeof files === "string") return files;
  return "";
}
function fileFromMap(files, sid) {
  if (!files || typeof files !== "object") return "";
  const v = files[sid];
  return typeof v === "string" ? v : "";
}
function joinPath(dir, file) {
  if (!file) return "";
  if (!dir) return file;
  return String(dir).replace(/[\\/]+$/, "") + "/" + file;
}

function makeRow(task, sid, gen, ownership, fullOrdinal, runDir, file) {
  return {
    taskId: (task && typeof task.task_id === "string") ? task.task_id : "",
    sid,
    gen,
    ownership: ownership || null,
    file: joinPath(runDir, file),
    name: rowNameFor({ task, sid, gen, ownership: ownership || null, fullOrdinal }),
  };
}

// 任务 → 片段行（基础行 + 该段各代际行·代际序号按该 sid 在 _reruns 中逐条计）
export function buildTaskRows(task, detail, ownership, fullOrdinal) {
  const shots = shotsOf(detail);
  if (!shots.length) return [];
  const known = new Set(shots.map(([sid]) => sid));
  const gens = new Map();
  for (const r of rerunsOf(detail)) {
    if (!r || !Array.isArray(r.sids)) continue;
    for (const sid of r.sids) {
      const k = String(sid);
      if (!known.has(k)) continue;   // 账本里的未知段不编行（不谎报段号）
      if (!gens.has(k)) gens.set(k, []);
      gens.get(k).push(r);
    }
  }
  const rows = [];
  for (const [sid, shot] of shots) {
    rows.push(makeRow(task, sid, null, ownership, fullOrdinal, shot.run_dir, firstFileOf(shot.files)));
    const list = gens.get(sid) || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      rows.push(makeRow(task, sid, i + 1, ownership, fullOrdinal, r.run_dir, fileFromMap(r.files, sid)));
    }
  }
  return rows;
}

// --- 会话态（视图级·卸载即清）---
let _session = null;
// 播放浮层（同一时刻只留一个·离页时摘除·不留残层压别的视图）
let _overlayNode = null;

// ===== #64 改错笔·工具区恒定槽位（老板裁决 A·方案 修订记录二）=====
// 工具区四钮（清空｜选择｜列表｜图片墙）恒渲染恒占位——不按模式摘挂/隐藏；
// 不适用态一律置灰禁用 + title 提示；「选择/退出选择」在固定宽槽内换文案（槽宽见 shell.css）。
// #92 B1：原 TITLE_* 常量区取消——title 文案改在 mount/updateToolbar 渲染路径 t() 取词
// （避免顶层求值跨机首访取 zh 不随服务端 pref 校正；zh 逐字不变）。

// ===== #64 T1 视图模式（列表｜图片墙）·localStorage 记忆 =====
// 键名 gui13.history.viewMode·值仅 "list"|"grid"·默认列表（现状不变）·坏值回落 list。
export const VIEWMODE_KEY = "gui13.history.viewMode";

function safeStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; } catch (_e) { return null; }
}

// 读视图模式：仅 "grid" 认账·其余（坏值/缺省/读失败）一律回落 "list"。
export function readViewMode(storage) {
  const st = storage !== undefined ? storage : safeStorage();
  let v = null;
  try { if (st && typeof st.getItem === "function") v = st.getItem(VIEWMODE_KEY); } catch (_e) { v = null; }
  return v === "grid" ? "grid" : "list";
}

// 写视图模式：只落 "list"|"grid"·坏值不落盘（不污染 localStorage）·读不到 localStorage 时静默吞。
export function writeViewMode(mode, storage) {
  const v = mode === "grid" ? "grid" : "list";
  const st = storage !== undefined ? storage : safeStorage();
  try { if (st && typeof st.setItem === "function") st.setItem(VIEWMODE_KEY, v); } catch (_e) { /* 隐私模式：视图态不落盘 */ }
  return v;
}

export function mount(container) {
  if (!container || typeof document === "undefined") return;
  unmount();
  const view = el("section", { id: "view-history", class: "shell-view hist-view" });
  const top = el("div", { class: "hist-top" });
  top.appendChild(el("h2", { text: t("shell.nav.history") }));
  // 左组（左侧锚定）：清空钮——钮面带全库计数（宽度随 N 变·置左组·不牵动右簇）
  const leftGroup = el("div", { class: "hist-actions-left", "data-role": "actions-left" });
  const clearBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "clear",
    title: t("hist.title.clear"), text: t("hist.btn.clearAll", { n: 0 }),
  });
  clearBtn.addEventListener("click", () => { onClearClick(); });
  leftGroup.appendChild(clearBtn);
  top.appendChild(leftGroup);
  // 右簇（margin-left:auto 锚右·子序恒定）：选择｜列表｜图片墙｜回收站｜刷新
  const actions = el("div", { class: "hist-actions" });
  // 「选择」钮（#64 改错笔·恒定槽位：恒渲染恒占位·不适用态置灰禁用·文案切换在固定宽槽内）
  const selectHolder = el("span", { class: "hist-selectholder", "data-role": "select-holder" });
  const selectBtn = el("button", {
    type: "button", class: "ghostbtn hist-selectbtn", "data-role": "select-toggle",
    title: t("hist.title.needGrid"), text: t("projects.select.enter"),
  });
  selectBtn.addEventListener("click", () => { toggleSelectMode(); });
  selectHolder.appendChild(selectBtn);
  actions.appendChild(selectHolder);
  // 视图切换（#64 T1：列表｜图片墙·当前态类 on·模式落 localStorage gui13.history.viewMode）
  const viewSwitch = el("div", { class: "hist-viewswitch", "data-role": "viewswitch" });
  const listViewBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "view-list",
    title: t("hist.title.list"), text: t("assigner.view.list"),
  });
  const gridViewBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "view-grid",
    title: t("hist.title.grid"), text: t("hist.btn.grid"),
  });
  listViewBtn.addEventListener("click", () => { setViewMode("list"); });
  gridViewBtn.addEventListener("click", () => { setViewMode("grid"); });
  viewSwitch.appendChild(listViewBtn);
  viewSwitch.appendChild(gridViewBtn);
  actions.appendChild(viewSwitch);
  const trashBtn = el("button", {
    type: "button", class: "ghostbtn hist-trashbtn", "data-role": "trash-toggle",
    title: t("hist.title.trash"), text: t("projects.tab.recycle"),
  });
  trashBtn.addEventListener("click", () => { setMode(_session && _session.mode === "trash" ? "list" : "trash"); });
  actions.appendChild(trashBtn);
  const refreshBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "refresh",
    title: t("hist.title.refresh"), text: t("hist.btn.refresh"),
  });
  refreshBtn.addEventListener("click", () => {
    const s = _session;
    if (!s) return;
    if (s.mode === "trash") { void loadTrash(); return; }
    void refreshAll();
  });
  actions.appendChild(refreshBtn);
  top.appendChild(actions);
  const status = el("div", { class: "hist-status", "data-role": "status", text: t("settings.ph.loadingText") });
  const list = el("div", { class: "hist-list", "data-role": "list" });
  // 底部「加载更多」钮（#64 T2b 件B：全库可见·按引擎默认页长 50 翻页·在位口径见 updateLoadMore）
  const moreBox = el("div", { class: "hist-morebox", "data-role": "morebox" });
  const moreBtn = el("button", {
    type: "button", class: "ghostbtn hist-loadmore", "data-role": "load-more",
    title: t("hist.title.more"), text: t("projects.more.label"),
  });
  moreBtn.addEventListener("click", () => { void onLoadMore(); });
  moreBox.appendChild(moreBtn);
  moreBox.style.display = "none";
  const trashBox = el("div", { class: "hist-list", "data-role": "trash" });
  trashBox.style.display = "none";
  // 底部选择操作条（#64 T2：选择模式内常驻·已选 N 条｜批量删除｜退出选择）
  const selbar = el("div", { class: "hist-selbar", "data-role": "selbar" });
  const selCount = el("span", { class: "hist-sel-count", "data-role": "sel-count", text: t("hist.sel.count", { n: 0 }) });
  const batchBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "batch-delete",
    title: t("hist.title.batch"), text: t("hist.btn.batch"),
  });
  batchBtn.addEventListener("click", () => { prepareBatchDelete(); });
  const selExitBtn = el("button", {
    type: "button", class: "ghostbtn", "data-role": "sel-exit",
    title: t("hist.title.selectExit"), text: t("projects.select.exit"),
  });
  selExitBtn.addEventListener("click", () => { toggleSelectMode(); });
  selbar.appendChild(selCount);
  selbar.appendChild(batchBtn);
  selbar.appendChild(selExitBtn);
  selbar.style.display = "none";
  view.appendChild(top);
  view.appendChild(status);
  view.appendChild(list);
  view.appendChild(moreBox);
  view.appendChild(trashBox);
  view.appendChild(selbar);
  container.appendChild(view);
  _session = {
    view, list, status, refreshBtn, clearBtn, trashBtn, trashBox,
    viewSwitch, listViewBtn, gridViewBtn,
    leftGroup, actions, selectHolder, selectBtn, selbar, selCount,
    moreBox, moreBtn,
    tasks: [],               // 当前已加载任务（首屏 + 翻页追加·展示用）
    total: 0,                // 全库总条数（引擎 total·钮面计数用）
    pulling: false,          // 拉全库在途（防重入）
    loadingMore: false,      // 加载更多在途（防重入·在途禁点）
    exhausted: false,        // 引擎已取尽（短页/空页·钮撤下）
    clearTargets: [],        // 清空作用域 = 拉全库取尽的全集（task 项）
    mode: "list",            // "list" | "trash"（T3 回收站子视图切换）
    viewMode: readViewMode(), // "list" | "grid"（#64 T1 视图模式·初值=localStorage 读·坏值回落 list）
    selectMode: false,       // 选择模式（#64 T2·仅图片墙）
    selectedIds: new Set(),  // 勾选卡键集（`${task_id}#${片段序}`·跨折叠保留·会话态）
    cardSlots: new Map(),    // task_id → 片段卡槽节点（删后即时下架用）
    cardNodes: new Map(),    // 卡键 → 卡节点（进选择模式时补勾选框用）
    checkNodes: new Map(),   // 卡键 → 勾选框节点（勾选态同步用）
    deleting: false,         // 批量删除在途（防重入）
    groups: null,            // 当前分组（视图切换重渲染用）
    openGroups: new Set(),   // 展开中的分组 id（视图切换重渲染时保展开态）
    clearing: false,         // 清空循环在途（防重入·禁模式切换）
    clearArmed: false,       // 清空钮武装态（armTwoStepConfirm 同构）
    clearArmTimer: null,
    cache: new Map(),        // task_id → detail 结果（缓存三口径的载体）
    loading: new Set(),      // 同一任务的并发拉取去重
    lazy: new Map(),         // 观察节点 → 触发回调（视口懒拉）
    observer: null,
    stemIndex: null,
    projectsById: new Map(),
    menu: null,
    menuDocHandler: null,
  };
  updateViewSwitch();
  updateSelbar();
  void loadList();
}

// 视图切换（#64 T1）：落 localStorage + 重渲染（#64 T2：grid→list = 退出选择模式并清空勾选）
export function setViewMode(mode) {
  const s = _session;
  if (!s) return;
  if (s.mode === "trash") return;     // 回收站态切换钮恒占位但禁用（不适用态不做视图切换）
  const next = (mode === "grid") ? "grid" : "list";
  const prev = s.viewMode;
  s.viewMode = next;
  writeViewMode(next);
  if (prev === "grid" && next === "list") {
    exitSelectMode();     // 失效时机三：grid→list = 退出选择模式 + 清空勾选
  }
  updateViewSwitch();
  updateSelbar();
  if (s.groups) renderGroups(s.groups);
}

// 切钮当前态（类 on）——当前模式那一只带 on·另一只摘掉。
function updateViewSwitch() {
  const s = _session;
  if (!s) return;
  if (s.viewMode === "grid") {
    s.listViewBtn.classList.remove("on");
    s.gridViewBtn.classList.add("on");
  } else {
    s.listViewBtn.classList.add("on");
    s.gridViewBtn.classList.remove("on");
  }
}

// 卸载：摘观察器 + 清缓存 + 断会话（缓存随之失效）+ 摘视图根
export function unmount() {
  if (!_session) return;
  const s = _session;
  try {
    if (s.observer && typeof s.observer.disconnect === "function") s.observer.disconnect();
  } catch (_e) { /* 摘除失败不阻断卸载 */ }
  closeMenu();
  disarmClear();
  try { if (s.view && s.view.parentNode) s.view.parentNode.removeChild(s.view); } catch (_e) { /* 已摘除·忽略 */ }
  if (_overlayNode) {
    try { if (_overlayNode.parentNode) _overlayNode.parentNode.removeChild(_overlayNode); } catch (_e) { /* 已摘除·忽略 */ }
    _overlayNode = null;
  }
  _session = null;
}

// 手动刷新：清缓存 + 重拉列表（缓存三口径之一）
//   #64 T2 失效时机四：刷新 = 勾选清空（会话态）
async function refreshAll() {
  if (!_session) return;
  _session.cache.clear();
  _session.selectedIds.clear();
  updateSelbar();
  await loadList();
}

async function loadList() {
  const s = _session;
  if (!s) return;
  let r;
  try {
    r = await dep("listHistory")({});
  } catch (e) {
    r = { ok: false, error: { msg: (e && e.message) ? e.message : String(e) } };
  }
  if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应
  if (!r || !r.ok) {
    s.status.textContent = t("hist.loadFail", { reason: (r && r.error && r.error.msg) || t("settings.llmp.engineNotConnected") });
    // D 块任务 3：异常态加指引——「设置页」带 #/settings 跳转（路由表 shell.js 29 行）
    s.status.appendChild(document.createTextNode(t("hist.offline.go")));
    s.status.appendChild(el("a", { href: "#/settings", text: t("hist.offline.settings") }));
    s.status.appendChild(document.createTextNode(t("hist.offline.retry")));
    s.tasks = [];
    s.total = 0;
    s.groups = null;        // 无分组可重渲染（视图切换不重绘陈旧分组）
    s.clearBtn.textContent = t("hist.btn.clearAll", { n: 0 });
    updateLoadMore();
    return;
  }
  s.status.textContent = "";
  const projects = loadLocalProjects();
  s.stemIndex = buildStemIndex(projects);
  s.projectsById = new Map(projects.map((p) => [p.id, p]));
  const tasks = r.tasks || [];
  s.tasks = tasks;
  // 钮面计数 = 全库 N（引擎 total·非当前页长度）——清空范围同为全库（见 T3 清空拉全库）。
  const total = Number(r.total);
  s.total = (Number.isFinite(total) && total >= 0) ? total : tasks.length;
  s.clearBtn.textContent = t("hist.btn.clearAll", { n: s.total });
  const groups = groupTasksByProject(tasks, s.stemIndex);
  renderGroups(groups);
  s.exhausted = false;     // 重拉 = 回首屏重来·未取尽
  updateLoadMore();
}

// --- #64 T2b 件B：加载更多（全库可见）---
// 引擎列表端点默认页长 50（api.md #16）·翻页参数 {limit, offset}。
const MORE_PAGE_LIMIT = 50;

// 「加载更多」钮在位口径：列表模式 + 未取尽 + 已显示任务数 < 引擎全库 N。
//   钮文带计数「已显示 X / 共 N 条」；取尽（已显示=N 或 引擎回短页/空页）即撤下。
function updateLoadMore() {
  const s = _session;
  if (!s || !s.moreBtn || !s.moreBox) return;
  s.moreBox.style.display = s.mode === "trash" ? "none" : "";
  const shown = s.tasks.length;
  const total = Number(s.total);
  const want = s.mode !== "trash" && !s.exhausted && Number.isFinite(total) && shown < total;
  if (!want) {
    if (s.moreBtn.parentNode) s.moreBtn.parentNode.removeChild(s.moreBtn);
    return;
  }
  if (s.moreBtn.parentNode !== s.moreBox) s.moreBox.appendChild(s.moreBtn);
  s.moreBtn.disabled = !!s.loadingMore;
  s.moreBtn.textContent = s.loadingMore
    ? t("hist.more.loading", { shown, total })
    : t("hist.more.count", { shown, total });
}

// 加载更多：翻一页（offset=已显示数·追加按 task_id 去重）→ 重渲染
//   （重渲染保三样：分组展开态 s.openGroups / 勾选 s.selectedIds / 视图模式 s.viewMode·皆会话态）
async function onLoadMore() {
  const s = _session;
  if (!s || s.loadingMore || s.mode === "trash") return;   // 在途禁点（防重入）
  const shown = s.tasks.length;
  const total = Number(s.total);
  if (!Number.isFinite(total) || shown >= total) return;     // 已取尽
  s.loadingMore = true;
  updateLoadMore();
  let r;
  try {
    r = await dep("listHistory")({ limit: MORE_PAGE_LIMIT, offset: shown });
  } catch (e) {
    r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
  }
  if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应
  s.loadingMore = false;
  if (!r || !r.ok) {
    const err = (r && r.error) || null;
    dep("toast")("error", t("hist.more.fail", { reason: (err && err.msg) || (err && err.code) || t("settings.llmp.engineNotConnected") }));
    updateLoadMore();
    return;
  }
  const page = Array.isArray(r.tasks) ? r.tasks : [];
  // 追加（按 task_id 去重：翻页期间引擎新增记录会挤位重影）
  const seen = new Set();
  for (const task of s.tasks) if (task && typeof task.task_id === "string") seen.add(task.task_id);
  for (const task of page) {
    if (!task || typeof task.task_id !== "string" || !task.task_id) continue;
    if (seen.has(task.task_id)) continue;
    seen.add(task.task_id);
    s.tasks.push(task);
  }
  const t2 = Number(r.total);
  if (Number.isFinite(t2) && t2 >= 0) {
    s.total = t2;
    s.clearBtn.textContent = t("hist.btn.clearAll", { n: s.total });
  }
  if (page.length < MORE_PAGE_LIMIT) s.exhausted = true;   // 短页/空页 = 取尽
  renderGroups(groupTasksByProject(s.tasks, s.stemIndex));
  updateLoadMore();
}

function renderGroups(groups) {
  const s = _session;
  if (!s) return;
  s.groups = groups;
  clearChildren(s.list);
  if (!groups.length) {
    s.status.textContent = t("hist.empty");
    return;
  }
  for (const g of groups) {
    const sec = el("section", { class: "hist-group", "data-project-id": g.projectId, "data-role": "group" });
    const head = el("div", { class: "hist-group-head", "data-role": "group-head", title: t("hist.group.toggleTitle") });
    head.appendChild(el("span", { class: "hist-caret", "data-role": "caret", text: "▶" }));
    head.appendChild(el("span", { class: "hist-group-name", text: g.projectId === UNLINKED_GROUP_ID ? t("hist.unlinked") : g.name }));
    head.appendChild(el("span", { class: "hist-group-count", text: String(g.tasks.length) }));
    const body = el("div", { class: "hist-group-body", "data-role": "group-body" });
    sec.appendChild(head);
    sec.appendChild(body);
    head.addEventListener("click", () => toggleGroup(sec, body, g));
    s.list.appendChild(sec);
    if (s.openGroups.has(g.projectId)) {   // 视图切换重渲染·保展开态
      sec.classList.add("open");
      fillGroupBody(body, g);
    }
  }
}

// 组体内容（按当前视图模式分流）：列表=任务块（片段行）·图片墙=网格卡（.hist-grid）
function fillGroupBody(body, g) {
  const s = _session;
  if (!s) return;
  clearChildren(body);
  if (s.viewMode === "grid") {
    const grid = el("div", { class: "hist-grid", "data-role": "grid" });
    for (const task of g.tasks) grid.appendChild(renderCardSlot(task));
    body.appendChild(grid);
    return;
  }
  for (const task of g.tasks) body.appendChild(renderTaskBlock(task));
}

function toggleGroup(sec, body, g) {
  const s = _session;
  if (!s) return;
  if (sec.classList.contains("open")) {
    sec.classList.remove("open");
    s.openGroups.delete(g.projectId);
    clearChildren(body);
    return;
  }
  sec.classList.add("open");
  s.openGroups.add(g.projectId);
  fillGroupBody(body, g);
}

// 任务块（批次）：只落壳 + 视口懒拉钩子·detail 到位后才长出行
function renderTaskBlock(task) {
  const s = _session;
  const own = resolveOwnership(task, s.stemIndex);
  const proj = own ? s.projectsById.get(own.projectId) : null;
  const fullOrdinal = proj ? mainRunOrdinal(proj.runs, task.task_id) : null;
  const block = el("div", { class: "hist-task", "data-task-id": task.task_id });
  const head = el("div", { class: "hist-task-head" });
  head.appendChild(el("span", { class: "hist-task-id", text: task.task_id }));
  head.appendChild(el("span", { class: "hist-task-time", text: taskTimeText(task.time) }));
  const rows = el("div", { class: "hist-rows", "data-role": "rows" });
  block.appendChild(head);
  block.appendChild(rows);
  observeLazy(block, () => { void ensureDetail(task, own, fullOrdinal, rows, renderRows); });
  return block;
}

function taskTimeText(time) {
  const sec = Number(time);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const d = new Date(sec * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

async function ensureDetail(task, own, fullOrdinal, target, render) {
  const s = _session;
  if (!s) return;
  const tid = task.task_id;
  if (s.cache.has(tid)) {
    render(target, task, s.cache.get(tid), own, fullOrdinal);
    return;
  }
  if (s.loading.has(tid)) return;
  s.loading.add(tid);
  let r;
  try {
    r = await dep("loadDetail")({ taskId: tid });
  } catch (e) {
    r = { ok: false, error: { msg: (e && e.message) ? e.message : String(e) } };
  }
  s.loading.delete(tid);
  if (_session !== s) return;      // 卸载后丢弃迟到响应
  s.cache.set(tid, r);
  render(target, task, r, own, fullOrdinal);
}

function renderRows(rowsEl, task, detail, own, fullOrdinal) {
  clearChildren(rowsEl);
  if (!detail || !detail.ok) {
    rowsEl.appendChild(el("div", {
      class: "hist-row degraded", "data-role": "degraded",
      text: t("hist.detail.fail", { reason: (detail && detail.error && detail.error.msg) || t("settings.llmp.engineNotConnected") }),
    }));
    return;
  }
  const rows = buildTaskRows(task, detail, own, fullOrdinal);
  if (!rows.length) {
    rowsEl.appendChild(el("div", { class: "hist-row degraded", text: t("hist.detail.empty") }));
    return;
  }
  for (const row of rows) rowsEl.appendChild(renderRow(row));
}

// 缩略图盒（列表行与图片墙卡共用一构造·懒载/回落接线同源；容器类不同→两模式样式不串）
function buildThumbBox(file, name, cls) {
  const thumb = el("div", {
    class: cls, "data-role": "thumb",
    title: file ? t("hist.thumb.play") : t("hist.thumb.noFile"),
  });
  if (file) {
    const img = el("img", { class: "hist-thumb-img", "data-role": "thumb-img", alt: name });
    img.dataset.thumbSrc = mediaUrl("thumb", file, { maxSize: 512 });
    // 取图失败：先让引擎口→本地口回落接线接手（wireLocalFallback 注册在后者），
    //   两通道皆失败才落占位——失败不阻塞行（行名与「...」照常可用）。
    img.addEventListener("error", () => {
      if (img.dataset.localFb !== "1") return;      // 首次失败 = 回落中·等本地口
      const ph = el("div", { class: "hist-thumb-none", "data-role": "thumb-none", text: t("hist.thumb.none") });
      if (img.parentNode) img.parentNode.removeChild(img);
      thumb.appendChild(ph);
    });
    observeLazy(img, () => { img.src = img.dataset.thumbSrc; });
    wireLocalFallback(img, "thumb", file, { maxSize: 512 });
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el("div", { class: "hist-thumb-none", "data-role": "thumb-none", text: t("hist.thumb.none") }));
  }
  return thumb;
}

// 行：预览图（可点播放 + 右上「...」）与名称（分开展示·省略 + title 全名）
function renderRow(row) {
  const wrap = el("div", {
    class: "hist-row", "data-task-id": row.taskId, "data-sid": row.sid,
    "data-gen": row.gen == null ? "" : String(row.gen),
  });
  const thumb = buildThumbBox(row.file, row.name, "hist-thumb");
  const more = el("button", {
    type: "button", class: "hist-more", "data-role": "more",
    title: t("hist.more.title"), text: "…",
  });
  more.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    openMenu(row, more);
  });
  thumb.appendChild(more);
  const name = el("div", { class: "hist-name", "data-role": "name", text: row.name, title: row.name });
  wrap.appendChild(thumb);
  wrap.appendChild(name);
  thumb.addEventListener("click", () => { if (row.file) playClip(row.file, row.name); });
  return wrap;
}

// 图片墙片段卡（#64 T2 卡粒度翻转·修订记录 2026-10-21：一片段一卡·与列表行同构）
//   卡键 = `${task_id}#${片段序}`（片段序 = 该任务片段行序·含重跑代际行·组内唯一）
//   卡面 = 缩略图（懒载同源）+ 名称省略/title 全名 + 右上「...」三件 + 选择模式下的勾选框
function renderCard(row, segIdx) {
  const s = _session;
  const key = cardKeyOf(row.taskId, segIdx);
  const card = el("div", {
    class: "hist-card", "data-role": "card",
    "data-task-id": row.taskId, "data-card-key": key,
  });
  const thumb = buildThumbBox(row.file, row.name, "hist-card-thumb");
  const more = el("button", {
    type: "button", class: "hist-more", "data-role": "more",
    title: t("hist.more.title"), text: "…",
  });
  more.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    openMenu(row, more);
  });
  thumb.appendChild(more);
  thumb.addEventListener("click", () => { if (row.file) playClip(row.file, row.name); });
  const name = el("div", { class: "hist-card-name", "data-role": "name", text: row.name, title: row.name });
  card.appendChild(thumb);
  card.appendChild(name);
  if (s && s.selectMode) card.appendChild(buildCardCheck(key));
  s.cardNodes.set(key, card);
  return card;
}

// 图片墙卡槽（每任务一个·装该任务的 N 张片段卡）
//   冷缓存 → 槽内先落真盒锚点 .hist-cardslot-anchor（卡槽 display:contents 自身不生成布局盒
//            → 真机 IO 对卡槽永不 intersect → 懒拉不发起 → 片段卡永不渲染·冷缓存空墙）
//            懒载挂点改挂锚点（锚点有盒 → 会 intersect）→ detail 到位后锚点被 N 张片段卡替换
//            （槽仍 display:contents → 卡照旧摊平入网格·视觉不变）
//   热缓存（detail 已在）→ 直接落卡面·不落锚点（无需再拉·不闪空墙）
function renderCardSlot(task) {
  const s = _session;
  const own = resolveOwnership(task, s.stemIndex);
  const proj = own ? s.projectsById.get(own.projectId) : null;
  const fullOrdinal = proj ? mainRunOrdinal(proj.runs, task.task_id) : null;
  const slot = el("div", { class: "hist-cardslot", "data-role": "cardslot", "data-task-id": task.task_id });
  s.cardSlots.set(task.task_id, slot);
  const cached = s.cache.get(task.task_id);
  if (cached) {
    renderCardSlotBody(slot, task, cached, own, fullOrdinal);
  } else {
    const anchor = el("div", {
      class: "hist-cardslot-anchor", "data-role": "cardslot-anchor", "data-task-id": task.task_id,
    });
    slot.appendChild(anchor);
    observeLazy(anchor, () => { void ensureDetail(task, own, fullOrdinal, slot, renderCardSlotBody); });
  }
  return slot;
}

function renderCardSlotBody(slot, task, detail, own, fullOrdinal) {
  clearChildren(slot);
  if (!detail || !detail.ok) {
    slot.appendChild(el("div", {
      class: "hist-card-degraded", "data-role": "degraded",
      text: t("hist.detail.fail", { reason: (detail && detail.error && detail.error.msg) || t("settings.llmp.engineNotConnected") }),
    }));
    return;
  }
  const rows = buildTaskRows(task, detail, own, fullOrdinal);
  if (!rows.length) {
    slot.appendChild(el("div", { class: "hist-card-degraded", "data-role": "degraded", text: t("hist.detail.empty") }));
    return;
  }
  rows.forEach((row, i) => { slot.appendChild(renderCard(row, i)); });
}

// ============================================================================
// #64 T2 选择模式 + 勾选批量删除（老板三选 1B/2A/3B）
//
// 选择模式（仅图片墙）：「选择」钮仅 viewMode==="grid" 渲染 → 进入 s.selectMode
//   → 片段卡显勾选框 .hist-card-check（可勾/取消）→ 底部操作条 .hist-selbar 常驻
//   → 「已选 N 条｜批量删除｜退出选择」。勾选按卡记（s.selectedIds = Set<卡键>）·跨折叠保留。
// 批量删除：勾选按卡计 → 映射去重后的所属 task_id 集（引擎软删=任务级·同任务多片段只删一次）
//   → 危险确认弹窗（写明 N 张片段 / M 条完整历史记录）→ 串行 deleteSoft
//   → 进度「已删 X / 共 M」→ 409 busy=中止+汇总 · already_in_trash/not_found/http_404（按 error.code）计成功继续
//   → 结束汇总 toast → 已删项的卡即时下架 → 勾选清空 → 自动退出选择模式。
// 失效时机四锁：删除完成清空 / 退出选择清空 / grid→list=退出并清空 / 刷新清空（会话态）。
// ============================================================================

// 卡键 = `${task_id}#${片段序}`（引擎 task_id=stem·不含 #·故取末个 # 切分即还原 task_id）
function cardKeyOf(taskId, segIdx) { return `${taskId}#${segIdx}`; }
function taskIdOfCardKey(key) {
  const k = String(key);
  const i = k.lastIndexOf("#");
  return i < 0 ? k : k.slice(0, i);
}

// 勾选卡键 → 去重后的所属 task_id 集（顺序=勾选顺序·同任务多片段只删一次）
function selectedTaskIds(s) {
  const seen = new Set();
  const out = [];
  for (const key of s.selectedIds) {
    const tid = taskIdOfCardKey(key);
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    out.push(tid);
  }
  return out;
}

// 勾选框（仅选择模式渲染·卡左上·勾选态回填自 s.selectedIds）
function buildCardCheck(key) {
  const s = _session;
  const box = el("input", { type: "checkbox", class: "hist-card-check", "data-role": "card-check", "data-card-key": key });
  setCheckState(box, s.selectedIds.has(key));
  box.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    toggleSelect(key);
  });
  s.checkNodes.set(key, box);
  return box;
}

function setCheckState(box, on) {
  if (!box) return;
  box.checked = !!on;
  box.setAttribute("data-checked", on ? "1" : "0");
}

// 勾选/取消一张片段卡（勾选态同步勾选框·计数同步操作条）
export function toggleSelect(cardKey) {
  const s = _session;
  if (!s || !s.selectMode || !cardKey) return;
  if (s.selectedIds.has(cardKey)) s.selectedIds.delete(cardKey);
  else s.selectedIds.add(cardKey);
  setCheckState(s.checkNodes.get(cardKey), s.selectedIds.has(cardKey));
  updateSelbar();
}

// 选择模式进出（进：补勾选框·清勾选；退：撤勾选框·清勾选·操作条撤下）
export function toggleSelectMode() {
  const s = _session;
  if (!s) return;
  if (s.selectMode) { exitSelectMode(); return; }
  if (s.viewMode !== "grid" || s.mode === "trash") return;   // 选择模式仅图片墙
  s.selectMode = true;
  s.selectedIds.clear();
  for (const [key, card] of s.cardNodes) {
    if (!card || !card.parentNode) continue;                // 已撤下的卡（折叠中）跳过·重建时自带勾选框
    const old = s.checkNodes.get(key);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    card.appendChild(buildCardCheck(key));
  }
  updateSelbar();
}

function exitSelectMode() {
  const s = _session;
  if (!s) return;
  s.selectMode = false;
  s.selectedIds.clear();
  for (const [, box] of s.checkNodes) {
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }
  s.checkNodes.clear();
  updateSelbar();
}

// 操作条同步：显示态（选择模式内常驻）+「已选 N 条」计数 + 工具区状态（见 updateToolbar）
function updateSelbar() {
  const s = _session;
  if (!s || !s.selbar) return;
  s.selbar.style.display = s.selectMode ? "" : "none";
  s.selCount.textContent = t("hist.sel.count", { n: s.selectedIds.size });
  updateToolbar();
}

// 工具区状态同步（#64 改错笔·老板裁决 A·恒定槽位）：
//   四钮（清空｜选择｜列表｜图片墙）恒渲染恒占位——不摘挂/不隐藏；
//   不适用态一律置灰禁用 + title 提示：列表态选择钮「切到图片墙可用」·回收站态四钮「回到列表可用」；
//   「选择/退出选择」只换文案（固定宽槽内·槽宽见 shell.css .hist-selectbtn）→ 进出零位移。
function updateToolbar() {
  const s = _session;
  if (!s || !s.selectBtn) return;
  const trash = s.mode === "trash";
  const grid = s.viewMode === "grid";
  s.clearBtn.disabled = trash;
  s.listViewBtn.disabled = trash;
  s.gridViewBtn.disabled = trash;
  s.selectBtn.disabled = trash || !grid;    // 选择功能仍仅图片墙可用
  if (trash) {
    s.clearBtn.title = t("hist.title.backToList");
    s.listViewBtn.title = t("hist.title.backToList");
    s.gridViewBtn.title = t("hist.title.backToList");
    s.selectBtn.title = t("hist.title.backToList");
  } else {
    s.clearBtn.title = t("hist.title.clear");
    s.listViewBtn.title = t("hist.title.list");
    s.gridViewBtn.title = t("hist.title.grid");
    s.selectBtn.title = grid ? (s.selectMode ? t("hist.title.selectExit") : t("hist.title.select")) : t("hist.title.needGrid");
  }
  s.selectBtn.textContent = s.selectMode ? t("projects.select.exit") : t("projects.select.enter");
}

// 已删任务的片段卡即时下架（撤下该任务的卡槽·其下全部卡随之撤下）
function dropTaskCards(taskId) {
  const s = _session;
  if (!s) return;
  const slot = s.cardSlots.get(taskId);
  if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
  s.cardSlots.delete(taskId);
}

// 良性删除回话（按 error.code 命中·计成功继续）——三条删除路径（批量/清空/单删）共用本判定：
//   already_in_trash（引擎 400·:6624/:6630）= 已在回收站·幂等（400 形态由 code 命中·不靠 http_400）
//   not_found = 记录已不存在·幂等
//   http_404（404·空/非预期响应体归一码）= 记录已不在原位·幂等
//   裸 http_400 = 引擎真报 400 校验错（非 already_in_trash 形态）→ 不计成功·与 409 同款中止+汇总
//     （口径依据 #36 方案 D5「404/400 already_in_trash 计成功继续」+ 附录 1「枚举外错误中止+汇总」）
//   409 busy（active/finalizing/concat/postfx）不在此列 → 中止 + 汇总。
const BENIGN_DELETE_CODES = new Set(["already_in_trash", "not_found", "http_404"]);
export function isBenignDeleteErr(err) {
  return !!(err && err.code && BENIGN_DELETE_CODES.has(String(err.code)));
}

// 批量删除起手：危险确认弹窗（文案写明 N 张片段 / M 条完整历史记录）
export function prepareBatchDelete() {
  const s = _session;
  if (!s) return;
  const n = s.selectedIds.size;
  const m = selectedTaskIds(s).length;
  if (!n || !m) {
    dep("toast")("info", t("hist.sel.none"));
    return;
  }
  openConfirm({
    title: t("hist.batch.title"),
    sub: t("hist.batch.sub", { n, m }),
    confirmText: t("hist.btn.batch"),
    danger: true,
    onConfirm: () => { void doBatchDelete(); },
  });
}

// 批量删除主循环（串行逐任务·错误口径循 T3 doClearAll·作用域=勾选映射去重后的 task_id 集）
export async function doBatchDelete() {
  const s = _session;
  if (!s || s.deleting) return;
  const taskIds = selectedTaskIds(s);
  const total = taskIds.length;
  if (!total) {
    dep("toast")("info", t("hist.sel.none"));
    return;
  }
  s.deleting = true;
  let done = 0;
  let abortReason = "";
  const setProgress = (d) => { s.status.textContent = t("hist.batch.progress", { done: d, total }); };
  setProgress(0);
  for (const tid of taskIds) {
    let r;
    try {
      r = await dep("deleteSoft")({ taskId: tid });
    } catch (e) {
      r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
    }
    if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应
    const err = (r && r.error) || null;
    if ((r && r.ok) || isBenignDeleteErr(err)) {
      done += 1;
      s.cache.delete(tid);
      dropTaskCards(tid);            // 已删项的卡即时下架
      setProgress(done);
      continue;
    }
    abortReason = (err && err.msg) || (err && err.code) || t("edit.common.unknownErrOffline");
    break;
  }
  s.deleting = false;
  if (_session !== s) return;
  if (abortReason) {
    dep("toast")("error", t("hist.batch.abort", { done, total, reason: abortReason }));
  } else {
    dep("toast")("success", t("hist.batch.done", { done }));
  }
  exitSelectMode();     // 失效时机一：删除完成 → 勾选清空 + 自动退出选择模式
  await loadList();     // 重拉（已删任务下架）
}

// 视口懒拉：节点进入视口才触发回调（无 IntersectionObserver 时退化为立即触发）
function observeLazy(node, fn) {
  const s = _session;
  if (!s) return;
  if (!s.observer) {
    const obs = dep("makeObserver")(onIntersect);
    if (!obs || typeof obs.observe !== "function") { fn(); return; }
    s.observer = obs;
  }
  s.lazy.set(node, fn);
  s.observer.observe(node);
}

function onIntersect(entries) {
  const s = _session;
  if (!s) return;
  for (const e of entries || []) {
    if (!e || !e.isIntersecting) continue;
    const fn = s.lazy.get(e.target);
    if (!fn) continue;
    s.lazy.delete(e.target);
    fn();
  }
}

// 「...」下拉三件（预览图右上）
function openMenu(row, anchor) {
  const s = _session;
  if (!s) return;
  closeMenu();
  const menu = el("div", { class: "hist-menu", "data-role": "menu" });
  const mkItem = (act, label, icon) => {
    const it = el("div", { class: "hist-menu-item", "data-role": "menu-item", "data-act": act, title: label });
    if (icon) it.appendChild(el("span", { "data-ic": icon, "data-sz": "14" }));
    it.appendChild(document.createTextNode(label));
    return it;
  };
  const del = mkItem("delete", t("hist.menu.delete"), "trash");
  del.addEventListener("click", () => { closeMenu(); void doDelete(row); });
  const openDir = mkItem("open-dir", t("shell.menu.openFolder"), "folder");
  openDir.addEventListener("click", () => { closeMenu(); void doOpenFolder(row); });
  const jump = mkItem("goto-project", t("hist.menu.jump"), "folderplus");
  if (!row.ownership) {
    jump.disabled = true;
    jump.classList.add("disabled");
    jump.setAttribute("title", t("hist.menu.jumpDisabled"));
  } else {
    jump.addEventListener("click", () => { closeMenu(); dep("goProject")(row.ownership.projectId); });
  }
  menu.appendChild(del);
  menu.appendChild(openDir);
  menu.appendChild(jump);
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + "px";
    menu.style.top = Math.round(r.bottom) + "px";
  }
  document.body.appendChild(menu);
  s.menu = menu;
  // 外点关闭（document 级·菜单与触发钮之外的一律收起·用后即摘）
  const onDocClick = (ev) => {
    const target = ev && ev.target;
    if (target && menu.contains && menu.contains(target)) return;
    if (target && anchor && anchor.contains && anchor.contains(target)) return;
    closeMenu();
  };
  if (typeof document.addEventListener === "function") {
    document.addEventListener("click", onDocClick);
    s.menuDocHandler = onDocClick;
  }
}

function closeMenu() {
  const s = _session;
  if (!s) return;
  if (s.menuDocHandler) {
    try { if (typeof document.removeEventListener === "function") document.removeEventListener("click", s.menuDocHandler); } catch (_e) { /* 无监听·忽略 */ }
    s.menuDocHandler = null;
  }
  if (!s.menu) return;
  try { if (s.menu.parentNode) s.menu.parentNode.removeChild(s.menu); } catch (_e) { /* 已摘除·忽略 */ }
  s.menu = null;
}

// 单删：引擎软删（记录下架进回收站·视频文件不动）·失败透传引擎中文 msg
async function doDelete(row) {
  const s = _session;
  if (!s) return;
  let r;
  try {
    r = await dep("deleteSoft")({ taskId: row.taskId });
  } catch (e) {
    r = { ok: false, error: { msg: (e && e.message) ? e.message : String(e) } };
  }
  if (_session !== s) return;
  if (!r || !r.ok) {
    const err = (r && r.error) || null;
    // 良性回话（already_in_trash/not_found/http_404）= 记录已不在原位·视同已删（口径同批量/清空·不误报失败）
    if (isBenignDeleteErr(err)) {
      dep("toast")("info", t("hist.del.benign"));
      s.cache.delete(row.taskId);
      await loadList();
      return;
    }
    // 方案 §五 附录 3：失败 reason = msg → code → 兜底（rerun_flow.js:252-256 同构——
    //   引擎裸 error 码归一后 msg 为空·回落 code 不误报「引擎未连接」）
    const reason = (err && err.msg) || (err && err.code) || t("edit.common.unknownErrOffline");
    dep("toast")("error", t("hist.del.fail", { reason }));
    return;
  }
  dep("toast")("success", t("hist.del.done"));
  s.cache.delete(row.taskId);      // 删后失效（缓存三口径之一）
  await loadList();
}

// ============================================================================
// T3 范围清空 + 回收站子视图（方案 D5）
//
// 清空口径（#36 老板 2026-10-21 裁决②·清空拉全库）：点清空 = 拉取引擎全库全部页
//   得到全集 N → 二次确认（armTwoStepConfirm 同构·文案带真实 N）→ 串行逐任务 deleteSoft。
//   钮面计数与实际清空范围均为全库 N（钮面取引擎 total·清空范围取翻页取尽的全集）。
//   拉全库分页：GET /h3_batch/history?limit=&offset=（api.md #16·limit 默认 50）·逐页翻到底；
//   页数上限 CLEAR_MAX_PAGES（防死循环）·取不尽 = 中止不清空（防漏清残留）。
//   错误口径：409 busy（concat/active/finalizing）= 中止 + 汇总提示稍后再清；
//   already_in_trash（引擎 :6624/:6630·归一后 error.code 命中）= 幂等计成功继续；
//   枚举外错误（500 move 失败/网络错/404）= 与 409 同款中止 + 汇总（方案 §五 附录 1）。
// 回收站子视图：页内模式切换（列表 ↔ 回收站·零路由改动）·listTrash 真数据渲染 + 一键
//   restore·恢复后重拉回收站（行消失）·切回列表重拉（恢复任务回分组）。
// ============================================================================

const CLEAR_ARM_WINDOW_MS = 3000;
// 拉全库单页条数（= 引擎列表端点默认页长 api.md #16）与页数上限（防死循环·上限 = 页数 × 单页）
export const CLEAR_PAGE_LIMIT = 50;
export const CLEAR_MAX_PAGES = 100;
const CLEAR_MAX_TASKS = CLEAR_MAX_PAGES * CLEAR_PAGE_LIMIT;   // 5000 条

// 拉全库全集：逐页取尽（limit/offset 分页）·按 task_id 去重（翻页期间引擎新增记录会挤位重影）·
// 页数上限保护。返回 {ok:true, tasks:[task…]} | {ok:false, error:{code,msg}}。
// 取不尽（撞页数上限）= 中止——不清半个库（防老板亲历的「清空后又冒新历史」残留）。
async function pullAllHistoryTasks() {
  const all = [];
  const seen = new Set();
  let offset = 0;
  let total = -1;
  let exhausted = false;
  for (let page = 0; page < CLEAR_MAX_PAGES; page++) {
    let r;
    try {
      r = await dep("listHistory")({ limit: CLEAR_PAGE_LIMIT, offset });
    } catch (e) {
      r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
    }
    if (!r || !r.ok) {
      const err = (r && r.error) || null;
      return { ok: false, error: { code: (err && err.code) || "network_error", msg: (err && err.msg) || (err && err.code) || t("settings.llmp.engineNotConnected") } };
    }
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    if (page === 0) {
      const n = Number(r.total);
      if (Number.isFinite(n) && n >= 0) {
        total = n;
        if (total > CLEAR_MAX_TASKS) {
          return { ok: false, error: { code: "too_many", msg: t("hist.clear.tooMany", { n: total, max: CLEAR_MAX_TASKS }) } };
        }
      }
    }
    for (const task of tasks) {
      const tid = (task && typeof task.task_id === "string") ? task.task_id : "";
      if (!tid || seen.has(tid)) continue;
      seen.add(tid);
      all.push(task);
    }
    if (tasks.length < CLEAR_PAGE_LIMIT) { exhausted = true; break; }    // 短页/空页 = 取尽
    if (total >= 0 && seen.size >= total) { exhausted = true; break; }   // 已达引擎 total
    offset += tasks.length;
  }
  if (!exhausted) {
    return { ok: false, error: { code: "too_many", msg: t("hist.clear.tooManyUnfinished", { max: CLEAR_MAX_TASKS }) } };
  }
  return { ok: true, tasks: all };
}

// 清空起手：拉引擎全库全部页 → 全集 N → 二次确认（文案带真实 N）→ 确认后逐条软删。
async function prepareClear() {
  const s = _session;
  if (!s) return;
  const prevStatus = s.status.textContent;
  s.pulling = true;
  s.status.textContent = t("hist.clear.pullStatus");
  const r = await pullAllHistoryTasks();
  if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应
  s.pulling = false;
  s.status.textContent = prevStatus;
  if (!r.ok) {
    dep("toast")("error", t("hist.clear.pullFail", { reason: r.error.msg }));
    return;
  }
  const n = r.tasks.length;
  if (!n) {
    dep("toast")("info", t("hist.clear.none"));
    return;
  }
  s.clearTargets = r.tasks;
  openConfirm({
    title: t("hist.clear.title"),
    sub: t("hist.clear.sub", { n }),
    confirmText: t("ui.notif.clear"),
    danger: true,
    onConfirm: () => { void doClearAll(); },
  });
}

// 清空钮点击：未武装 → 武装（armed 视觉态 + 确认提示 toast，3 秒超时自动复位）；
// 已武装 → 复位并拉全库 → 弹危险确认（openConfirm danger·同 projects.js 批删形态）。
function onClearClick() {
  const s = _session;
  if (!s || s.clearing || s.pulling) return;
  if (s.mode === "trash") return;     // 回收站态清空钮恒占位但禁用（清空作用域=历史列表）
  if (!s.clearArmed) {
    s.clearArmed = true;
    try { s.clearBtn.classList.add("armed"); } catch (_e) { /* 视觉态失败不阻流程 */ }
    const n = Number(s.total);
    const scope = (Number.isFinite(n) && n > 0) ? t("hist.clear.armScope", { n }) : "";
    dep("toast")("info", t("hist.clear.arm", { scope, sec: Math.round(CLEAR_ARM_WINDOW_MS / 1000) }));
    s.clearArmTimer = setTimeout(() => disarmClear(), CLEAR_ARM_WINDOW_MS + 100);
    return;
  }
  disarmClear();
  void prepareClear();
}

function disarmClear() {
  const s = _session;
  if (!s) return;
  s.clearArmed = false;
  if (s.clearArmTimer) { clearTimeout(s.clearArmTimer); s.clearArmTimer = null; }
  try { s.clearBtn.classList.remove("armed"); } catch (_e) { /* 节点已不在·忽略 */ }
}

// 清空主循环（串行逐任务·错误口径见上节注记·作用域 = 拉全库取尽的全集）
async function doClearAll() {
  const s = _session;
  if (!s || s.clearing) return;
  const tasks = (s.clearTargets || [])
    .map((task) => (task && typeof task.task_id === "string") ? task.task_id : "")
    .filter(Boolean);
  if (!tasks.length) {
    dep("toast")("info", t("hist.clear.none"));
    return;
  }
  s.clearing = true;
  const total = tasks.length;
  let done = 0;
  let abortReason = "";
  const setProgress = (d) => { s.status.textContent = t("hist.clear.progress", { done: d, total }); };
  setProgress(0);
  for (const tid of tasks) {
    let r;
    try {
      r = await dep("deleteSoft")({ taskId: tid });
    } catch (e) {
      r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
    }
    if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应（进度态随会话走）
    const err = (r && r.error) || null;
    // 良性回话（already_in_trash/not_found/http_404）= 幂等·计成功继续（口径同批量删除）
    if ((r && r.ok) || isBenignDeleteErr(err)) { done += 1; s.cache.delete(tid); setProgress(done); continue; }
    abortReason = (err && err.msg) || (err && err.code) || t("edit.common.unknownErrOffline");
    break;
  }
  s.clearing = false;
  s.clearTargets = [];
  disarmClear();
  if (_session !== s) return;
  if (abortReason) {
    dep("toast")("error", t("hist.clear.abort", { done, total, reason: abortReason }));
  } else {
    dep("toast")("success", t("hist.clear.done", { done }));
  }
  await loadList();   // 重拉（中止也重拉——已删部分先下架）
}

// 列表 ↔ 回收站 模式切换（页内子视图·清空钮仅作用于列表模式）
function setMode(mode) {
  const s = _session;
  if (!s || s.clearing) return;
  s.mode = mode;
  const trash = mode === "trash";
  s.list.style.display = trash ? "none" : "";
  s.trashBox.style.display = trash ? "" : "none";
  updateLoadMore();                                  // 回收站子视图不涉翻页（加载更多钮撤下）
  s.trashBtn.textContent = trash ? t("hist.trash.back") : t("projects.tab.recycle");
  s.trashBtn.title = trash ? t("hist.trash.backTitle") : t("hist.title.trash");
  if (trash) exitSelectMode();                       // 回收站子视图不涉勾选·退出选择模式
  updateSelbar();                                    // → updateToolbar：回收站态四钮置灰禁用（恒占位·不隐藏）
  if (trash) { void loadTrash(); } else { void loadList(); }
}

async function loadTrash() {
  const s = _session;
  if (!s) return;
  s.status.textContent = t("hist.trash.loading");
  clearChildren(s.trashBox);
  let r;
  try {
    r = await dep("listTrash")({});
  } catch (e) {
    r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
  }
  if (_session !== s) return;      // 卸载/重挂后丢弃迟到响应
  clearChildren(s.trashBox);
  if (!r || !r.ok) {
    const err = (r && r.error) || null;
    // G4b②：失败态带人话指引——不止报错，还告诉用户下一步（稍后重试/查引擎）
    s.status.textContent = t("hist.trash.fail", { reason: (err && err.msg) || (err && err.code) || t("settings.llmp.engineNotConnected") });
    return;
  }
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  if (!tasks.length) {
    s.status.textContent = t("hist.trash.empty");
    return;
  }
  s.status.textContent = t("hist.trash.count", { n: tasks.length });
  for (const task of tasks) {
    if (task && typeof task.task_id === "string" && task.task_id) s.trashBox.appendChild(renderTrashRow(task));
  }
}

function renderTrashRow(task) {
  const row = el("div", { class: "hist-row", "data-task-id": task.task_id, "data-role": "trash-row" });
  row.appendChild(el("div", { class: "hist-name", "data-role": "name", text: task.task_id, title: task.task_id }));
  const when = taskTimeText(task.deleted_time || task.time);
  row.appendChild(el("div", {
    class: "hist-meta",
    text: `${when} · ${task.mode || "分镜"} · 成功${Number(task.success) || 0} 失败${Number(task.failed) || 0}`,
  }));
  const btn = el("button", {
    type: "button", class: "ghostbtn hist-restore", "data-role": "restore",
    title: t("hist.trash.restoreTitle"), text: t("projects.recycle.restore"),
  });
  btn.addEventListener("click", () => { void doRestore(task.task_id); });
  row.appendChild(btn);
  return row;
}

// 一键恢复：成功 → 重拉回收站（行消失）；切回列表时 loadList 重拉（任务回分组）
async function doRestore(taskId) {
  const s = _session;
  if (!s) return;
  let r;
  try {
    r = await dep("restore")({ taskId });
  } catch (e) {
    r = { ok: false, error: { code: "network_error", msg: (e && e.message) ? e.message : String(e) } };
  }
  if (_session !== s) return;
  if (!r || !r.ok) {
    const err = (r && r.error) || null;
    const reason = (err && err.msg) || (err && err.code) || t("edit.common.unknownErrOffline");
    dep("toast")("error", t("hist.restore.fail", { reason }));
    return;
  }
  dep("toast")("success", t("hist.restore.done", { id: taskId }));
  await loadTrash();
}

// 打开文件夹：resolveRunDir 解析 run_dir → openDirRequest 发包（零新端点）
async function doOpenFolder(row) {
  const s = _session;
  if (!s) return;
  let r;
  try {
    r = await dep("resolveRunDir")(row.taskId);
  } catch (e) {
    r = { ok: false, error: (e && e.message) ? e.message : "engine_no_response" };
  }
  if (_session !== s) return;
  if (!r || !r.ok) {
    const why = (r && r.error) || "engine_no_response";
    dep("toast")("error", why === "no_run_dir" ? t("hist.openDir.noRunDir") : t("hist.openDir.fail", { reason: why }));
    return;
  }
  await dep("openDirRequest")(r.runDir, { verb: "文件夹", plainNetworkError: true, toast: dep("toast") });
}

// 浮层播放（showFinalPreview 同构：原生 controls + ESC/遮罩关闭 + 引擎口→本地口回落）
function playClip(file, title) {
  if (typeof document === "undefined") return;
  const overlay = el("div", { class: "hist-overlay", "data-role": "overlay" });
  const box = el("div", { class: "hist-overlay-box" });
  const head = el("div", { class: "hist-overlay-head" });
  head.appendChild(el("div", { class: "hist-overlay-title", text: title || t("hist.preview.title") }));
  const closeBtn = el("button", { type: "button", class: "ghostbtn", "data-role": "overlay-close", text: t("edit.preview.close") });
  head.appendChild(closeBtn);
  const video = el("video", { class: "hist-video", controls: "", preload: "metadata" });
  setMediaSrc(video, "video", file);
  box.appendChild(head);
  box.appendChild(video);
  overlay.appendChild(box);
  let closed = false;
  const onEsc = (ev) => { if (ev && (ev.key === "Escape" || ev.keyCode === 27)) close(); };
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (typeof video.pause === "function") video.pause(); } catch (_e) { /* 停播失败不阻关闭 */ }
    try { if (typeof document.removeEventListener === "function") document.removeEventListener("keydown", onEsc); } catch (_e) { /* 无监听·忽略 */ }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (_overlayNode === overlay) _overlayNode = null;
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (ev) => { if (ev && ev.target === overlay) close(); });
  if (typeof document.addEventListener === "function") document.addEventListener("keydown", onEsc);
  if (_overlayNode && _overlayNode.parentNode) _overlayNode.parentNode.removeChild(_overlayNode);
  _overlayNode = overlay;
  document.body.appendChild(overlay);
}
