// projects.js — 项目管理视图模块（GUI1.3 S1-1 T3）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）行为基线清单 B006-B009：
//   - B006 项目列表页（v43 :1644-1666）· 搜索/新建/网格卡
//   - B007 实时搜索过滤（v43 :2993-3014）· 无结果空态（v43 :88-89 / :1655）
//   - B008 卡片 hover 操作组（v43 :542-546）· 重命名/导出/删除三选（v43 :3045-3057 / :1658-1659）
//   - B009 删除进回收站 · 危险两次确认（v43 :3030-3042）· 回收站可恢复（v43 :2174-2185）
// 模块归属：views（页面级）；数据全部走 store（任务单 F006 铁律）。
// 视觉保留 v43 形态；行为按本任务单 + 基线 B006-B009 实施。
// store 扩展（软删）走主代理裁定授权：deletedAt / listDeleted / restore / remove 改软删
//
// === API ===
//   mount(container)            — 渲染项目管理视图进容器；T2 路由壳会复用
//   filterByQuery(projects, q)  — 名称模糊匹配（导出便于测试）
//   sortByUpdatedDesc(...)      — 按 updatedAt 倒序（导出便于测试）
//   buildProjectCardHtml(p)     — 单卡 HTML（导出便于测试）
//   buildRecycleRowHtml(p)      — 回收站单行 HTML（导出便于测试）
//   validateProjectName(...)    — 空名/纯空白拒（导出便于测试；与 portal 同形，独立导出避免交叉依赖）
//   exportProjectFilename(p)    — 导出文件名（导出便于测试；空名 fallback「未命名项目」）
//   triggerDeleteTwoStep(op, name) — 两次确认武装态（导出便于测试；3000ms 内再点生效）
//     S1-1 修 12 节点门修正：API 注释原误写 armDeleteTwoStep，函数实现名为 triggerDeleteTwoStep，已统一

import {
  listProjects,
  listDeleted,
  load as storeLoad,
  save as storeSave,
  createProject,
  remove as storeRemove,
  restore as storeRestore,
  purgeProject,
  exportJSON as storeExportJSON,
  importJSON as storeImportJSON,
  subscribe as storeSubscribe,
  unsubscribe as storeUnsubscribe,
  INDEX_WRITE_SETTLED_EVENT,
} from "../store/store.js";
import { showToast } from "../ui/toast.js";
import { openConfirm, openPrompt } from "../ui/modal.js";
// 批 R4.5 · J1：data-ic 图标体系（渲染后 hydrate · 原型 :2453 范式）
import { hydrateIcons } from "../ui/icons.js";
import { mediaUrl, wireBgMediaFallback } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源（引擎口优先+离线回落）
// #89 T1c：用户可见文案入典（zh 与批前原文逐字等价·等价性测试锁）
import { t } from "../core/i18n.js";

// ===== 纯函数 =====

export function sortByUpdatedDesc(projects) {
  return [...projects].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || "") || 0;
    const tb = Date.parse(b.updatedAt || "") || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function filterByQuery(projects, q) {
  if (typeof q !== "string" || q.trim() === "") return [...projects];
  const needle = q.trim().toLowerCase();
  return projects.filter((p) => String(p.name || "").toLowerCase().includes(needle));
}

export function validateProjectName(name) {
  if (typeof name !== "string") return { ok: false, reason: "empty" };
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  return { ok: true, name: trimmed };
}

export function exportProjectFilename(project) {
  // 文件名清洗：去除路径分隔符与控制字符；空名 fallback「未命名项目」
  const raw = (project && typeof project.name === "string") ? project.name.trim() : "";
  const base = raw || "未命名项目";
  // Windows / * ? < > | " 全部替换为 _
  const safe = base.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  return `${safe || "未命名项目"}.json`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 格式化 updatedAt 为 v43 形态：YYYY-MM-DD HH:MM 更新（v43 :1658-1662）
function formatUpdated(iso) {
  if (typeof iso !== "string" || iso === "") return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} ${t("projects.dt.updated")}`;
}

// 封面片段（F18 口径：第一个带产物 clip·done|warn 且有 file；无 → null=film 兜底）
//   批 B #13 提取导出：卡面 HTML 与注入后离线回落接线（refreshGrid）同源共用，防两处口径漂移。
export function coverClipOf(p) {
  return ((p && p.editingState && Array.isArray(p.editingState.mainClips)) ? p.editingState.mainClips : [])
    .find((c) => c && c.file && (c.state === "done" || c.state === "warn")) || null;
}

// 单卡 HTML（v43 :1658-1662 形态：cover + nm + dt + tags）
//   B4-T4 ③：selectMode 时卡面加行 checkbox（多选批量删除）
export function buildProjectCardHtml(p, opts = {}) {
  const safeId = escapeHtml(p.id);
  const safeName = escapeHtml(p.name || t("projects.common.unnamed"));
  const dt = formatUpdated(p.updatedAt || p.createdAt);
  const pick = opts.selectMode
    ? `<input type="checkbox" class="pcard-pick" data-pick="1" title="${t("projects.card.pickTitle")}">`
    : "";
  // 封面（走查反馈 F18·老板「未进入项目前项目预览图没有」——推翻批 R4.5 A05 的原型静态
  //   演示分流：原按 updatedAt 奇偶假分流 .pic 色块/film；改真产物首帧缩略图——
  //   第一个带产物的 clip（thumb 通道·与预览胶片条/剪辑 clip 同款）；无产物 → film 兜底）
  const coverClip = coverClipOf(p);
  const coverClass = coverClip ? "cover pic" : "cover";
  const coverBg = coverClip
    ? ` style="background-image:url('${mediaUrl("thumb", coverClip.file, { maxSize: 512 })}');background-size:cover;background-position:center"`
    : "";
  const coverIcon = coverClip ? "" : `<span data-ic="film" data-sz="26"></span>`;
  // tags 行（批 R4.5 · A06 · J3 裁决）：项目数据 tags 字段；空/缺 → 不渲染该行（v43 :1658/:1661）
  const tags = Array.isArray(p.tags) && p.tags.length > 0
    ? `<div class="tags">${p.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  return (
    `<div class="pcard" data-proj-id="${safeId}" data-proj="${safeName}" title="${t("projects.card.enterTitle")}">` +
      pick +
      `<div class="pc-ops">` +
        `<span class="op" data-act="rename" title="${t("projects.card.renameTitle")}">${t("projects.card.rename")}</span>` +
        `<span class="op" data-act="export" title="${t("projects.card.exportTitle")}">${t("projects.card.export")}</span>` +
        `<span class="op danger" data-act="delete" title="${t("projects.card.delTitle")}">${t("projects.card.del")}</span>` +
      `</div>` +
      `<div class="${coverClass}"${coverBg}>${coverIcon}</div>` +
      `<div class="nm">${safeName}</div>` +
      `<div class="dt num">${escapeHtml(dt)}</div>` +
      tags +
    `</div>`
  );
}

// 回收站单行 HTML（v43 :2179-2181 形态：.row 含 k / v / 恢复 fbtn）
//   B4-T4 ②：页签化后行内补「彻底删除」（物理删 · 走 store.purgeProject）
export function buildRecycleRowHtml(p) {
  const safeId = escapeHtml(p.id);
  const safeName = escapeHtml(p.name || t("projects.common.unnamed"));
  const dt = formatUpdated(p.deletedAt || p.updatedAt || p.createdAt);
  return (
    `<div class="recycle-row" data-rec-id="${safeId}">` +
      `<span class="nm">${safeName}</span>` +
      `<span class="meta num">${escapeHtml(dt)}</span>` +
      `<span class="fbtn" data-act="restore" title="${t("projects.recycle.restoreTitle")}">${t("projects.recycle.restore")}</span>` +
      `<span class="fbtn" data-act="purge" title="${t("projects.recycle.purgeTitle")}">${t("projects.recycle.purge")}</span>` +
    `</div>`
  );
}

// ===== DOM 辅助 =====
function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
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

// 触发浏览器下载（a[download] + Blob）
function downloadBlob(blob, filename) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

// 真实导出：B008 导出按钮触发
function exportProject(project) {
  try {
    const json = storeExportJSON(project);
    const blob = new Blob([json], { type: "application/json" });
    const filename = exportProjectFilename(project);
    downloadBlob(blob, filename);
    showToast("success", t("projects.export.done", { name: project.name || t("projects.common.unnamed") }));
  } catch (e) {
    showToast("error", t("projects.export.fail", { msg: e && e.message ? e.message : e }));
  }
}

// ===== 导入项目（老板裁决 2026-09-27 深夜「早晚得加 现在加」）=====
// 原型无此件（v43 :1649 后仅「导入表格（高级）」示意位）· 套原型 ghostbtn+data-ic 体系；
// 换浏览器/备份搬家通道（项目数据事实源=localStorage · 引擎侧迁移长期方案见节点记录 §一.7）

// 判重副本化（纯函数·单测覆盖）：id 已在库 → 新 id + 名字「·导入」后缀（同 shell _duplicateCurrentProject
// 模式，但保留 runs——导入=搬家不是复制，运行历史一并带回）
export function resolveImportConflict(project, idExists) {
  if (typeof idExists !== "function" || !idExists(project.id)) return { project, asCopy: false };
  const copy = JSON.parse(JSON.stringify(project));
  copy.id = "p-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  copy.name = (project.name || "未命名项目") + "·导入";
  return { project: copy, asCopy: true };
}

// importJSON 错误码 → 白话（纯函数·单测覆盖）
export function importErrorMessage(code) {
  if (code === "schema_newer") return t("projects.imp.errSchemaNewer");
  if (code === "schema_older_unsupported") return t("projects.imp.errSchemaOlder");
  return t("projects.imp.errNotOurs");
}

// 批量导入入口：files = File 桩（{name, text()}）或真 File；返回 {imported, copies, failures}
export async function importProjectFiles(files) {
  const failures = [];
  let imported = 0;
  let copies = 0;
  for (const f of files) {
    let text = "";
    try {
      text = await f.text();
    } catch (_e) {
      failures.push(t("projects.imp.readFail", { name: f.name }));
      continue;
    }
    const r = storeImportJSON(text);
    if (!r.ok) {
      failures.push(t("projects.imp.itemFail", { name: f.name, msg: importErrorMessage(r.error) }));
      continue;
    }
    const resolved = resolveImportConflict(r.project, (id) => !!storeLoad(id));
    storeSave(resolved.project);
    if (resolved.asCopy) copies += 1;
    else imported += 1;
  }
  const done = imported + copies;
  if (done > 0 && failures.length > 0) {
    showToast("success", t("projects.imp.doneWithFails", { done, fails: failures.length }));
  } else if (done > 0) {
    showToast("success", copies > 0
      ? t("projects.imp.doneCopies", { done, copies })
      : t("projects.imp.done", { n: done }));
  } else if (failures.length > 0) {
    showToast("error", t("projects.imp.fail", {
      first: failures[0],
      more: failures.length > 1 ? t("projects.imp.more", { n: failures.length }) : "",
    }));
  }
  return { imported: done, copies, failures };
}

// 两次确认武装态（v43 :3030-3042 形态：3 秒内再点；armed 视觉：颜色转红 + 底色 #1a1212）
//   返回函数：true=执行；false=超时未武装或非首次点击
//   为便于测试导出，副作用（toast / 计时器）放外面处理；本函数只算时间窗
const ARM_WINDOW_MS = 3000;
export function isSecondClickWithinWindow(armedAt, now = Date.now()) {
  if (!armedAt) return false;
  return now - armedAt < ARM_WINDOW_MS;
}
export function armWindowMs() { return ARM_WINDOW_MS; }

// ===== B4-T4 ① 分页（列表态首屏 12 + 「加载更多」逐页放行 · 搜索态全量） =====
export const PAGE_SIZE = 12;

// 页切片（纯函数）：平铺态按 shown 放行；搜索态结果集小 → 全量（不出加载更多）
export function pageSlice(matched, opts = {}) {
  const q = typeof opts.query === "string" ? opts.query.trim() : "";
  const shown = Number.isFinite(opts.shown) && opts.shown > 0 ? Math.floor(opts.shown) : PAGE_SIZE;
  if (q !== "") return { items: [...matched], hasMore: false };
  return { items: matched.slice(0, shown), hasMore: matched.length > shown };
}

// ===== B009 残余修复（S1-2 T0 修 3）：防重入标志 =====
// 现状：窗口内第二次点删除按钮时，capture 阶段 onSecondClick 先命中开确认弹窗，
//   冒泡阶段 mount 监听器又触发 triggerDeleteTwoStep → 双 toast + 武装态泄漏
// 修法：模块级标志位记录当前武装的 opBtn；mount 监听器先检查标志位（armed 态直接 return，
//   只让 capture 的 onSecondClick 处理）；onSecondClick 命中后 + armTimer 超时均清空标志位
//   （确认弹窗打开期间也 return —— 标志位为 null 时即使点 opBtn 也走不进去）
let _deleteArmedOp = null;
export function getArmedDeleteOp() { return _deleteArmedOp; }
export function _setArmedDeleteOpForTests(op) { _deleteArmedOp = op; }
export function _resetDeleteArmedForTests() { _deleteArmedOp = null; }

// 危险两次确认武装（v43 :3031-3042 形态 · B4-T4 ②③ 复用同一实现）：
//   - 首次点 → toast 披露 + 按钮 armed 红态
//   - 3 秒内再点 → 弹第二次危险确认弹窗（danger 模式）→ 确认后执行 run()
//   - 3 秒后再点 / 改点别的 → 自动超时复位
function armTwoStepConfirm(opBtn, { toast, confirm, run }) {
  // 双保险：mount/行委托已用 _deleteArmedOp === opBtn 拦过一次；这里再守一道（防未来路径变化）
  if (_deleteArmedOp === opBtn) return;
  _deleteArmedOp = opBtn;
  // armed 态视觉切换（.op 有 CSS；页签内 fbtn/fchip 无对应规则 → 同步内联，色值同 projects.css :86）
  opBtn.classList.add("armed");
  opBtn.style.color = "#ff9a9a";
  opBtn.style.background = "#1a1212";
  showToast("info", toast);
  // 二次点击命中（捕获阶段拦截，避免冒泡触发卡 click = 入项目）
  const onSecondClick = (e) => {
    if (!opBtn.classList.contains("armed")) return;
    e.preventDefault();
    e.stopPropagation();
    disarm();
    // B009 收口：命中后延迟到下一 tick 再清标志——同一次点击事件仍在派发链上，
    //   立即清会让后续委托路径重入再武装一次（第二个 toast）
    setTimeout(() => { _deleteArmedOp = null; }, 0);
    openConfirm({ ...confirm, onConfirm: () => run() });
  };
  function disarm() {
    opBtn.classList.remove("armed");
    opBtn.style.color = "";
    opBtn.style.background = "";
    opBtn.removeEventListener("click", onSecondClick, true);
    clearTimeout(armTimer);
  }
  // 3.1s 后自动复位（同步移除 capture 监听：避免残留监听器在超时后被下一次单击误触发二次确认）
  const armTimer = setTimeout(() => {
    disarm();
    _deleteArmedOp = null; // 超时清标志（3.1s 后再点才允许再次武装）
  }, ARM_WINDOW_MS + 100);
  // 挂载捕获监听
  opBtn.addEventListener("click", onSecondClick, true);
}

// 删除危险两次确认（v43 :3031-3042）：软删进回收站
function triggerDeleteTwoStep(opBtn, project, refresh) {
  const name = project.name || t("projects.common.unnamed");
  armTwoStepConfirm(opBtn, {
    toast: t("projects.del.arm", { name, sec: Math.round(ARM_WINDOW_MS / 1000) }),
    confirm: {
      title: t("projects.del.confirmTitle"),
      sub: t("projects.del.confirmSub", { name }),
      confirmText: t("projects.del.confirmOk"),
      danger: true,
    },
    run: () => {
      try {
        storeRemove(project.id);
        showToast("success", t("projects.del.done", { name }));
        refresh();
      } catch (e) {
        showToast("error", t("projects.del.fail", { msg: e && e.message ? e.message : e }));
      }
    },
  });
}

// 重命名弹窗：填名 → store.save → 刷新
function renameProject(project, refresh) {
  openPrompt({
    title: t("projects.rename.title"),
    sub: t("projects.rename.sub"),
    placeholder: t("projects.rename.ph"),
    defaultValue: project.name || "",
    validate: (v) => {
      const r = validateProjectName(v);
      if (!r.ok) return { ok: false, hint: t("projects.common.emptyName") };
      return { ok: true };
    },
    onConfirm: (v) => {
      const r = validateProjectName(v);
      if (!r.ok) { showToast("error", t("projects.common.emptyName")); return; }
      try {
        const fresh = storeLoad(project.id);
        if (!fresh) { showToast("error", t("projects.rename.gone")); refresh(); return; }
        fresh.name = r.name;
        storeSave(fresh);
        showToast("success", t("projects.rename.done", { name: r.name }));
        refresh();
      } catch (e) {
        showToast("error", t("projects.rename.fail", { msg: e && e.message ? e.message : e }));
      }
    },
  });
}

// ===== 批6 G1 必修②：「已创建」toast 时序（与 portal.openNewProjectModal 同形实现·§三.2）=====
//   按仓惯例 views 互不交叉依赖（validateProjectName 先例）故各自持有；语义=提交时挂起登记，
//   总表写落定事件 ok=true 才弹「已创建」，失败不弹成功（store 已弹准确失败档·成功/失败互斥）。
const _createdPending = new Map();   // id → onSettled（连建多项目各占一槽·settled 按 id 消费）
export function armCreatedToast(id, name) {
  if (typeof document === "undefined" || !document || typeof document.addEventListener !== "function") return;
  disarmCreatedToast(id);
  const onSettled = (ev) => {
    const d = (ev && ev.detail) || {};
    if (String(d.id || "") !== String(id)) return;   // 只认本次新建的项目
    disarmCreatedToast(id);
    if (d.ok) showToast("success", t("projects.created.done", { name }));
  };
  document.addEventListener(INDEX_WRITE_SETTLED_EVENT, onSettled);
  _createdPending.set(String(id), onSettled);
}
function disarmCreatedToast(id) {
  const key = String(id);
  const onSettled = _createdPending.get(key);
  if (!onSettled) return;
  try { document.removeEventListener(INDEX_WRITE_SETTLED_EVENT, onSettled); }
  catch (_e) { /* 测试环境 document 更替·静默 */ }
  _createdPending.delete(key);
}

// 新建项目弹窗（与 portal 同形；走 ui/modal.js）
function openNewProjectModal(onSuccess) {
  openPrompt({
    title: t("projects.new.title"),
    sub: t("projects.new.sub"),
    placeholder: t("projects.new.ph"),
    validate: (v) => {
      const r = validateProjectName(v);
      if (!r.ok) return { ok: false, hint: t("projects.common.emptyName") };
      return { ok: true };
    },
    onConfirm: (v) => {
      const r = validateProjectName(v);
      if (!r.ok) { showToast("error", t("projects.common.emptyName")); return; }
      try {
        const p = createProject(r.name);
        armCreatedToast(p.id, r.name);   // G1 必修②：「已创建」挂总表写落定后弹（失败不弹成功）
        storeSave(p);
        // C3（交接§四.4）：创建后跳设定页（对齐 v43；经 onOpenProject 注入通道，未注入时保持停留本页）
        if (typeof _onOpenProject === "function") {
          try { _onOpenProject(p.id, "setup"); } catch (_e) { /* 注入通道异常不阻断创建成功态 */ }
        }
        if (typeof onSuccess === "function") onSuccess(p);
      } catch (e) {
        showToast("error", t("projects.new.fail", { msg: e && e.message ? e.message : e }));
      }
    },
  });
}

// ===== T6：跨页 / 重连刷新订阅（地基批1档2 · 账本 #59-③件 + 验收7 UI 面）=====
//   三个入口 → 同一动作（重读列表 + 重渲染主列表与回收站视图）：
//     ① store notify「project:invalidate」——他页改了实体键（T5 跨页广播转来·内存镜像已摘）
//     ② document「gui13:store-resync」——壳层回前台全量重拉成功（shell.js 派发）
//     ③ document「gui13:index-conflict」——总表写前对账判冲突·本地写被弃（server_storage 派发）
//   事件名与派发方逐字对齐：server_storage.js 的 INDEX_CONFLICT_EVENT / shell.js 的
//     STORE_RESYNC_EVENT（壳层→视图不可反向 import·故此处字面常量·测试锁两侧一致）。
const RESYNC_EVENT = "gui13:store-resync";
const INDEX_CONFLICT_EVENT = "gui13:index-conflict";
// 上一轮挂载的订阅句柄（重挂载先摘·防一次事件触发多次重渲染）
let _subCleanup = null;

// ===== 主入口 =====
export function mount(container) {
  if (!container || typeof document === "undefined") return;
  // 幂等：清旧
  clearChildren(container);

  const view = el("section", { id: "view-projects", class: "shell-view" });

  // 顶部工具行（v43 :1645-1651）
  //   走查反馈 F11（老板「项目管理和资产管理抬头差太多·统一结构」）：DOM 序统一为
  //   h2 → 功能按钮组 → 搜索框最右（与 assets 页同构；原搜索框在 h2 后·margin-left:auto
  //   把搜索与按钮簇一起推右——视觉序与资产页「按钮组贴标题+搜索独右」相反）
  const top = el("div", { class: "proj-top" });
  top.appendChild(el("h2", { text: t("projects.title") }));
  const search = el("input", {
    type: "text",
    class: "search",
    id: "projSearch",
    placeholder: t("projects.search.ph"),
    style: "font-family:inherit;color:var(--txt)",
  });
  search.addEventListener("input", refreshGrid);
  // 批 R4.5 · A03/A04：两钮补 data-ic 图标（v43 :1648/:1649 · 图标在文本前）
  const recycleBtn = el("span", { class: "ghostbtn", title: t("projects.recycle.openTitle") });
  recycleBtn.appendChild(el("span", { "data-ic": "trash", "data-sz": "14" }));
  recycleBtn.appendChild(document.createTextNode(t("projects.tab.recycle")));
  // B4-T4 ②：原入口按钮改切页签（弹窗形态退役）· F58：挂载序在导入项目之后（「导入表格（高级）」已随 D 块摘除）
  recycleBtn.addEventListener("click", () => showTab("recycle"));
  const newBtn = el("span", { class: "ghostbtn", title: t("projects.new.btnTitle") });
  newBtn.appendChild(el("span", { "data-ic": "folderplus", "data-sz": "14" }));
  newBtn.appendChild(document.createTextNode(t("projects.new.title")));
  newBtn.addEventListener("click", () => openNewProjectModal(refreshGrid));
  top.appendChild(newBtn);
  // 导入项目（老板裁决 2026-09-27 深夜）· 原型无此件，套 ghostbtn 体系；多选 .json 批量恢复（形态同 assets A2 导入资产库）
  const importProjBtn = el("span", {
    class: "ghostbtn",
    id: "projImportEntry",
    title: t("projects.imp.btnTitle"),
  });
  importProjBtn.appendChild(el("span", { "data-ic": "upload", "data-sz": "14" }));
  importProjBtn.appendChild(document.createTextNode(t("projects.imp.btn")));
  const importProjFile = el("input", { type: "file", accept: ".json,application/json", id: "projImportFile", multiple: "multiple", style: "display:none" });
  importProjBtn.addEventListener("click", () => { if (importProjFile.click) importProjFile.click(); });
  importProjFile.addEventListener("change", () => {
    const picked = Array.from(importProjFile.files || []);
    importProjFile.value = ""; // 复位：同一文件重选也触发 change
    void importProjectFiles(picked).then((r) => { if (r.imported > 0) refreshGrid(); });
  });
  top.appendChild(importProjBtn);
  top.appendChild(importProjFile);
  // 「导入表格（高级）」死按钮已摘除（D 块任务 1·2026-10-25）：原为 registerPending 空挂占位·点击只弹「暂未实装」
  // F58 老板裁目标序（2026-10-02）：新建项目 → 导入项目 → 回收站 → 选择/批量 → 搜索
  top.appendChild(recycleBtn);
  // F56：多选模式入口 + 批量删除钮迁入 proj-top 按钮簇——原挂页签条（B4-T4 ③）右端，
  //   未进项目时孤悬页签行右缘观感诡异；样式沿用 .fchip，margin-left:auto 右推随页签条退役
  let selectMode = false;
  const picked = new Set();
  const selectBtn = el("span", {
    class: "fchip", id: "projSelectBtn",
    title: t("projects.select.enterTitle"),
    text: t("projects.select.enter"),
  });
  selectBtn.addEventListener("click", toggleSelectMode);
  top.appendChild(selectBtn);
  const bulkBtn = el("button", {
    type: "button", class: "fbtn", id: "projBulkDel",
    text: t("projects.bulk.label", { n: 0 }), title: t("projects.bulk.labelTitle"),
  });
  bulkBtn.style.display = "none";
  bulkBtn.disabled = true;
  bulkBtn.addEventListener("click", () => {
    if (!picked.size) return;
    const ids = [...picked];
    armTwoStepConfirm(bulkBtn, {
      toast: t("projects.bulk.arm", { n: ids.length, sec: Math.round(ARM_WINDOW_MS / 1000) }),
      confirm: {
        title: t("projects.bulk.confirmTitle"),
        sub: t("projects.bulk.confirmSub", { n: ids.length }),
        confirmText: t("projects.del.confirmOk"),
        danger: true,
      },
      run: () => {
        let done = 0;
        for (const id of ids) {
          try { storeRemove(id); done += 1; } catch (_e) { /* 单项失败跳过（他项继续） */ }
        }
        showToast("success", t("projects.bulk.done", { n: done }));
        picked.clear();
        selectMode = false;
        refreshGrid();
        syncSelectUi();
      },
    });
  });
  top.appendChild(bulkBtn);
  // F11: 搜索框收尾挂最右（DOM 序 = 视觉序：标题 → 按钮组 → 搜索）
  top.appendChild(search);
  view.appendChild(top);

  // 主体 fillpanel（v43 :1652）
  const panel = el("div", { class: "fillpanel" });
  // B4-T4 ②：页签条（项目 / 回收站）——形态照资产页 tag bar（.fchips/.fchip.on）
  let tab = "projects";
  let emptyShown = false;
  let hasMore = false;
  const tabBar = el("div", { class: "fchips", id: "projTabBar" });
  const tabChips = {};
  for (const [key, label] of [["projects", t("projects.tab.projects")], ["recycle", t("projects.tab.recycle")]]) {
    const chip = el("span", {
      class: "fchip" + (key === "projects" ? " on" : ""),
      "data-tab": key,
      title: key === "projects" ? t("projects.tab.projectsTitle") : t("projects.tab.recycleTitle"),
      text: label,
    });
    chip.addEventListener("click", () => showTab(key));
    tabChips[key] = chip;
    tabBar.appendChild(chip);
  }
  // F56：多选模式入口 + 批量删除钮已迁 proj-top 按钮簇（见上方挂载处）——页签条只留两个页签 chip
  panel.appendChild(tabBar);
  panel.appendChild(el("div", {
    class: "inh",
    text: t("projects.inh.records"),
    style: "margin-bottom:12px",
  }));
  const grid = el("div", { class: "pgrid", id: "pgrid" });
  panel.appendChild(grid);
  // B4-T4 ①：列表态分页游标（mount 重建即复位）
  let shownCount = PAGE_SIZE;
  const loadMoreBtn = el("button", {
    type: "button", class: "fbtn", id: "projLoadMore",
    text: t("projects.more.label"), title: t("projects.more.title", { n: PAGE_SIZE }),
  });
  loadMoreBtn.style.display = "none";
  loadMoreBtn.addEventListener("click", () => { shownCount += PAGE_SIZE; refreshGrid(); });
  panel.appendChild(loadMoreBtn);
  // 搜索空态（挂 panel 而非 grid：refreshGrid 每次重写 grid.innerHTML，挂 grid 内会被抹掉——S1-1 T5 真机走查修正）
  // 批 R4.5 · B02/J9：引号对齐原型 ASCII 双引号（v43 :1655）
  const empty = el("div", { class: "empty-hint", id: "projEmpty", style: "display:none" });
  empty.appendChild(document.createTextNode(t("projects.empty.pre")));
  const emptyQ = el("span", { id: "projEmptyQ" });
  empty.appendChild(emptyQ);
  empty.appendChild(document.createTextNode(t("projects.empty.post")));
  panel.appendChild(empty);

  // B4-T4 ②：回收站页内区（原弹窗内容迁入）
  const recycleWrap = el("div", { id: "projRecycle", style: "display:none" });
  panel.appendChild(recycleWrap);

  view.appendChild(panel);
  container.appendChild(view);

  // 首次渲染
  refreshGrid();

  // ===== 内部函数 =====

  // T6：三入口刷新（重读列表 + 重渲染主列表与回收站视图）
  function refreshAll() {
    refreshGrid();
    refreshRecycle();
  }

  // T6：订阅挂载（重挂载先摘上一轮·防重复刷新）
  //   store 通道走既有 subscribe 机制（store.js notify 族）；document 通道走自定义事件。
  if (_subCleanup) { try { _subCleanup(); } catch (_e) { /* 摘旧订阅失败不阻新挂载 */ } _subCleanup = null; }
  const onStoreEvent = (ev) => {
    if (!ev || ev.type !== "project:invalidate") return;
    refreshAll();
  };
  const onDocEvent = (ev) => {
    if (!ev) return;
    if (ev.type === RESYNC_EVENT || ev.type === INDEX_CONFLICT_EVENT) refreshAll();
  };
  const doc = (typeof document !== "undefined") ? document : null;
  storeSubscribe(onStoreEvent);
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener(RESYNC_EVENT, onDocEvent);
    doc.addEventListener(INDEX_CONFLICT_EVENT, onDocEvent);
  }
  _subCleanup = () => {
    storeUnsubscribe(onStoreEvent);
    if (doc && typeof doc.removeEventListener === "function") {
      doc.removeEventListener(RESYNC_EVENT, onDocEvent);
      doc.removeEventListener(INDEX_CONFLICT_EVENT, onDocEvent);
    }
  };

  // 页签切换（项目 / 回收站）
  function showTab(next) {
    tab = next === "recycle" ? "recycle" : "projects";
    for (const [k, chip] of Object.entries(tabChips)) {
      if (k === tab) chip.classList.add("on"); else chip.classList.remove("on");
    }
    if (tab === "recycle") refreshRecycle();
    applyChrome();
  }

  // 页签态显隐（刷新函数只改数据与自身样式，显隐统一在此裁决）
  function applyChrome() {
    const isProj = tab === "projects";
    grid.style.display = isProj ? "" : "none";
    empty.style.display = (isProj && emptyShown) ? "block" : "none";
    loadMoreBtn.style.display = (isProj && hasMore) ? "" : "none";
    bulkBtn.style.display = (isProj && selectMode) ? "" : "none";
    // 战役批2-T6 · F-56 残留：回收站页签多选无意义（行内无 checkbox）→ 「选择」钮随页签显隐
    selectBtn.style.display = isProj ? "" : "none";
    recycleWrap.style.display = isProj ? "none" : "";
  }

  // 多选模式（进入/退出）· 选中计数同步到批量删除钮
  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) picked.clear();
    refreshGrid();
    syncSelectUi();
  }
  function syncSelectUi() {
    selectBtn.textContent = selectMode ? t("projects.select.exit") : t("projects.select.enter");
    if (selectMode) selectBtn.classList.add("on"); else selectBtn.classList.remove("on");
    bulkBtn.textContent = t("projects.bulk.label", { n: picked.size });
    bulkBtn.disabled = picked.size === 0;
    applyChrome();
  }
  function togglePick(id, card) {
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    const on = picked.has(id);
    const cb = card.querySelector(".pcard-pick");
    if (cb) cb.checked = on;
    if (on) card.classList.add("picked"); else card.classList.remove("picked");
    syncSelectUi();
  }

  // 回收站区渲染（行 = buildRecycleRowHtml；恢复 / 彻底删除逐行挂载）
  function refreshRecycle() {
    clearChildren(recycleWrap);
    const list = listDeleted();
    const cap = el("div", { class: "fchips", style: "margin-bottom:10px" });
    cap.appendChild(el("span", { class: "inh", style: "align-self:center", text: t("projects.recycle.cap", { n: list.length }) }));
    const clearBtn = el("button", {
      type: "button", class: "fbtn", id: "projPurgeAll",
      text: t("projects.recycle.clear"), title: t("projects.recycle.clearTitle"),
    });
    clearBtn.style.marginLeft = "auto";
    if (!list.length) { clearBtn.disabled = true; clearBtn.title = t("projects.recycle.empty"); }
    clearBtn.addEventListener("click", () => {
      if (clearBtn.disabled) return;
      armPurgeAll(clearBtn, list);
    });
    cap.appendChild(clearBtn);
    recycleWrap.appendChild(cap);
    if (!list.length) {
      recycleWrap.appendChild(el("div", { class: "empty-hint", text: t("projects.recycle.empty") }));
      return;
    }
    const rows = el("div");
    rows.innerHTML = list.map(buildRecycleRowHtml).join("");
    recycleWrap.appendChild(rows);
    rows.querySelectorAll(".recycle-row").forEach((row) => {
      const proj = list.find((p) => p.id === row.dataset.recId);
      if (!proj) return;
      const restoreBtn = row.querySelector('[data-act="restore"]');
      if (restoreBtn) restoreBtn.addEventListener("click", () => restoreFromRecycle(proj));
      const purgeBtn = row.querySelector('[data-act="purge"]');
      if (purgeBtn) purgeBtn.addEventListener("click", () => armPurgeOne(purgeBtn, proj));
    });
  }

  function restoreFromRecycle(proj) {
    try {
      if (storeRestore(proj.id)) {
        showToast("success", t("projects.restore.done", { name: proj.name || t("projects.common.unnamed") }));
        refreshRecycle();
        refreshGrid();
        return;
      }
      showToast("error", t("projects.restore.failMissing"));
    } catch (err) {
      showToast("error", t("projects.restore.fail", { msg: err && err.message ? err.message : err }));
    }
  }

  // 彻底删除（本地物理删 · 双确认披露不可恢复）
  function armPurgeOne(purgeBtn, proj) {
    const name = proj.name || t("projects.common.unnamed");
    armTwoStepConfirm(purgeBtn, {
      toast: t("projects.purge.arm", { name, sec: Math.round(ARM_WINDOW_MS / 1000) }),
      confirm: {
        title: t("projects.purge.confirmTitle"),
        sub: t("projects.purge.confirmSub", { name }),
        confirmText: t("projects.recycle.purge"),
        danger: true,
      },
      run: () => {
        try {
          purgeProject(proj.id);
          showToast("success", t("projects.purge.done", { name }));
          refreshRecycle();
          refreshGrid();
        } catch (err) {
          showToast("error", t("projects.purge.fail", { msg: err && err.message ? err.message : err }));
        }
      },
    });
  }

  // 清空回收站（逐行 purge · 双确认）
  function armPurgeAll(clearBtn, list) {
    armTwoStepConfirm(clearBtn, {
      toast: t("projects.purgeAll.arm", { n: list.length, sec: Math.round(ARM_WINDOW_MS / 1000) }),
      confirm: {
        title: t("projects.purgeAll.confirmTitle"),
        sub: t("projects.purgeAll.confirmSub", { n: list.length }),
        confirmText: t("projects.purgeAll.confirmOk"),
        danger: true,
      },
      run: () => {
        let done = 0;
        for (const p of list) {
          try { if (purgeProject(p.id)) done += 1; } catch (_e) { /* 单项失败跳过（他项继续） */ }
        }
        showToast(done === list.length ? "success" : "error", t("projects.purgeAll.done", { done, fails: list.length - done }));
        refreshRecycle();
        refreshGrid();
      },
    });
  }

  function refreshGrid() {
    const all = listProjects();
    const sorted = sortByUpdatedDesc(all);
    const q = search.value || "";
    const matched = filterByQuery(sorted, q);
    // B4-T4 ①：列表态分页放行（搜索态 pageSlice 内部走全量）
    const page = pageSlice(matched, { query: q, shown: shownCount });
    // 卡面：第一张是「+ 开始创作」占位卡（v43 :1656）；其余真卡
    const html = [
      `<div class="pcard proj-newcard" data-act="new" title="${t("projects.new.title")}">` +
        `<div class="cover proj-cover-new">` +
          `<span data-ic="plus" data-sz="22"></span>` +
          `<span style="font-size:12px">${t("projects.newcard.cta")}</span>` +
        `</div>` +
        `<div class="nm">${t("projects.newcard.nm")}</div>` +
      `</div>`,
      ...page.items.map((p) => buildProjectCardHtml(p, { selectMode })),
    ].join("");
    grid.innerHTML = html;
    // 批 B #13：封面底图离线回落接线（background-image 无 error 事件·探活制：引擎口失败才切本地缩略；
    //   Node 测试环境无 Image → no-op）。DOM 序 = page.items 序（首张为占位卡·:not 排除）。
    const coverEls = grid.querySelectorAll(".pcard:not(.proj-newcard) .cover");
    page.items.forEach((p, i) => {
      const cc = coverClipOf(p);
      if (cc && coverEls[i]) wireBgMediaFallback(coverEls[i], "thumb", cc.file, { maxSize: 512 });
    });
    emptyShown = page.items.length === 0 && q.trim() !== "";
    hasMore = page.hasMore;
    emptyQ.textContent = q;
    applyChrome();
    // 批 R4.5 · R0 范式：渲染后 hydrate（顶栏 trash/folderplus + 占位 plus + 封面 film 全量成 svg · 幂等）
    hydrateIcons(container);

    // 委托：占位卡点击 → 新建
    grid.querySelector('[data-act="new"]').addEventListener("click", () => {
      openNewProjectModal(refreshGrid);
    });
    // 多选：清掉已不在列表的选中 id（删/导入/搜索后计数不悬空）
    const liveIds = new Set(all.map((p) => p.id));
    for (const id of [...picked]) if (!liveIds.has(id)) picked.delete(id);
    // 委托：真卡 hover 操作组点击
    grid.querySelectorAll(".pcard[data-proj-id]").forEach((card) => {
      const id = card.dataset.projId;
      const proj = all.find((p) => p.id === id);
      if (!proj) return;
      // 多选态：重渲后恢复勾选态（翻页/刷新不丢选中）
      if (selectMode && picked.has(id)) {
        card.classList.add("picked");
        const cb = card.querySelector(".pcard-pick");
        if (cb) cb.checked = true;
      }
      // 卡面点击 → 入项目（占位走 router；通过 _onOpenProject 注入）；多选态=勾选
      card.addEventListener("click", (e) => {
        if (e.target.closest(".pc-ops")) return; // 操作组内点击不触发入项目
        if (selectMode) { togglePick(id, card); return; }
        if (typeof _onOpenProject === "function") {
          try { _onOpenProject(id); }
          catch (err) { showToast("error", t("projects.open.fail", { msg: err && err.message ? err.message : err })); }
        } else {
          showToast("info", t("projects.open.stub", { id }));
        }
      });
      // 操作组三选
      card.querySelectorAll(".pc-ops .op").forEach((op) => {
        op.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          const act = op.dataset.act;
          if (act === "rename") renameProject(proj, refreshGrid);
          else if (act === "export") exportProject(proj);
          else if (act === "delete") {
            // S1-2 T0 修 3（B009 残余）：armed 态下 mount 监听器直接 return，
            //   只让 capture 阶段的 onSecondClick 处理（避免双 toast + 重复武装）
            if (_deleteArmedOp === op) return;
            triggerDeleteTwoStep(op, proj, refreshGrid);
          }
        });
      });
    });
  }
}

// ===== 进入项目回调注入（与 portal.js 同模式）=====
let _onOpenProject = null;
export function onOpenProject(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== "function") {
    throw new TypeError("onOpenProject: fn must be a function or null");
  }
  _onOpenProject = fn;
}