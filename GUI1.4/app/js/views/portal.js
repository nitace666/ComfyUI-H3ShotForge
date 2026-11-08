// portal.js — 门户视图模块（GUI1.3 S1-1 T1）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）：
//   - HTML 段 :1064-1092（view-home 区块）
//   - CSS 段 :54-69、:592-594、:632（.portal-hero/.qcard/.rcard/.hero-sub/.sec-title/.cards/.recent-row）
//   - JS 段 :2456-2478（QUICK 5 卡 + renderCards + newProject）
// 模块归属：views（页面级）；数据全部走 store（任务单 F006 铁律）。
// 视觉保留 v43 形态；行为按本任务单 + 基线 B 节实施（S1-1 详案「五卡+最近项目+新建项目弹窗填名」）。
//
// === API ===
//   mount(container)        — 渲染门户进容器；T2 路由壳会复用
//   sortByUpdatedDesc(...)  — 最近项目排序（导出便于测试）
//   formatProjectDate(...)  — ISO → v43 "YYYY-MM-DD"（导出便于测试）
//   validateProjectName(..) — 空名/纯空白拒（导出便于测试）
//   buildQuickCardsHtml()   — 5 卡 HTML（导出便于测试）
//   buildRecentProjectsHtml — 最近项目 + ghost 占位 HTML（导出便于测试）
//   openNewProjectModal()   — 新建项目弹窗
//   openQuickShotModal()    — Quick Shot 免表单弹窗（S3-4 B5·空-008）
//   （文件内）5 卡跳转映射 = QUICK_ROUTES + goRoute/openRecentProjectTab（S3-4 B9）

import { listProjects, createProject, save, INDEX_WRITE_SETTLED_EVENT } from "../store/store.js";
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import { open as openModal } from "../ui/modal.js";
// S3-4 B5（空-008）：Quick Shot 复用概念环单段生成公共底层（assets.js 抽出）
import { runSingleSegmentGeneration, listFirstFrameRefCards, openConceptModal } from "./assets.js";
// S3-4 B7（A013/A014）：三小件——新手向导 / 全局搜索 / 快捷键帮助（ui/guide.js）
// B块任务6：+isGuideSeen/markGuideSeen（首访自动弹一次向导）
import { openGuideModal, openSearchModal, guideEntryTitle, isGuideSeen, markGuideSeen } from "../ui/guide.js";
// #89 T1c：用户可见文案入典（zh 与批前原文逐字等价·等价性测试锁）
import { t } from "../core/i18n.js";
// #92 B8：最近项目卡缩略图与项目页同源口径（coverClipOf 首个带产物 clip 单源 + mediaUrl thumb·512 +
//   wireBgMediaFallback 底图离线回落——api.js 为导出源·projects.js 亦从彼导入）
import { coverClipOf } from "./projects.js";
import { mediaUrl, wireBgMediaFallback } from "../core/api.js";

// ===== 纯函数 =====
export function sortByUpdatedDesc(projects) {
  return [...projects].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || "") || 0;
    const tb = Date.parse(b.updatedAt || "") || 0;
    if (tb !== ta) return tb - ta;
    // 等值时按 id 稳定次序（避免依赖 Array.sort 实现细节）
    return String(a.id).localeCompare(String(b.id));
  });
}

export function formatProjectDate(iso) {
  if (typeof iso !== "string" || iso === "") return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function validateProjectName(name) {
  if (typeof name !== "string") return { ok: false, reason: "empty" };
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  return { ok: true, name: trimmed };
}

// ===== HTML 构造（纯字符串，便于测试；视觉对齐 v43） =====
// S1-1 修 8 节点门修正：data-act 移除死属性字符串（portalOpenCanvasStub 等无分发器，纯占位会误导阅读）。
// S3-4 B9：5 卡空挂接管退场——各卡按 QUICK_ROUTES 直达对应视图（跳转接线见文件内映射段）。
// 批 R7 · A8：icn = 原型 QUICK 卡 data-ic 名（v43 :2464-2466），图标位 24px（原型 ic(c.icn,24)）
const QUICK_CARDS = [
  { k: "canvas", icn: "canvas", nm: t("portal.quick.canvas") },
  // B块任务2：三卡名「×生成」→「×参数」——点击去向=最近项目的设定页（QUICK_ROUTES title 如实），
  //   旧名让用户误以为点了就开始生成
  { k: "video",  icn: "film", nm: t("portal.quick.video") },
  { k: "image",  icn: "image", nm: t("portal.quick.image") },
  { k: "audio",  icn: "wave", nm: t("portal.quick.audio") },
  { k: "edit",   icn: "scissors", nm: t("portal.quick.edit") },
];

export function buildQuickCardsHtml() {
  return QUICK_CARDS.map((c) =>
    `<div class="qcard" data-quick="${c.k}">` +
      `<span class="qi" data-ic="${c.icn}" data-sz="24"></span>` +
      `<span class="nm">${c.nm}</span>` +
    `</div>`
  ).join("");
}

export function buildRecentProjectsHtml(projects, opts = {}) {
  const maxReal = typeof opts.maxReal === "number" ? opts.maxReal : 5;
  const sorted = sortByUpdatedDesc(projects).slice(0, maxReal);
  const cards = sorted.map((p, idx) => {
    // #92 B8：真实缩略图（老板 2026-11-07 反馈 mock 渐变退役）——coverClipOf 首个带产物 clip +
    //   mediaUrl thumb·512（与项目页 buildProjectCardHtml 同源同参）；无产物 → film 20 兜底
    //   （v43 首卡恒 .pic 特殊分支随之移除）
    const cc = coverClipOf(p);
    const thumb = cc
      ? `<span class="thumb" style="background-image:url('${mediaUrl("thumb", cc.file, { maxSize: 512 })}');background-size:cover;background-position:center"></span>`
      : `<span class="thumb"><span data-ic="film" data-sz="20"></span></span>`;
    const date = formatProjectDate(p.updatedAt || p.createdAt);
    // 项目名 HTML 转义（最小集，防 XSS；v43 原型为静态字符串故未转义）
    const safeName = String(p.name ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return (
      `<div class="rcard" data-proj-id="${p.id}" data-proj-idx="${idx}">` +
        thumb +
        `<span><div class="nm">${safeName || t("portal.name.unnamed")}</div>` +
        `<div class="dt num">${date}</div></span>` +
      `</div>`
    );
  });
  // 末位 ghost 占位（v43 :1091）
  cards.push(`<div class="rcard ghost"><span class="thumb"><span data-ic="chev" data-sz="16"></span></span></div>`);
  return cards.join("");
}

// ===== DOM 渲染 =====
function el(tag, attrs = {}, children = []) {
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
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ===== 批6 G1 必修②：「已创建」toast 时序（方案 v2.1 §三.2）=====
//   旧形态：save 是 fire-and-forget·提交瞬间即弹成功 → 总表写失败时成功/失败双弹且成功在先
//   （侦察报告 UX 缺口 4）。新形态：提交时挂起登记，store 的总表写落定事件（store:index-write-settled）
//   到来且 ok=true 才弹；ok=false 不弹成功（store 侧已按 code 弹准确失败档）——成功/失败互斥·无双弹。
//   projects.js 的同形弹窗按仓惯例（views 互不交叉依赖·validateProjectName 先例）各自持有同形实现。
const _createdPending = new Map();   // id → onSettled（连建多项目各占一槽·settled 按 id 消费）
export function armCreatedToast(id, name) {
  if (typeof document === "undefined" || !document || typeof document.addEventListener !== "function") return;
  disarmCreatedToast(id);
  const onSettled = (ev) => {
    const d = (ev && ev.detail) || {};
    if (String(d.id || "") !== String(id)) return;   // 只认本次新建的项目
    disarmCreatedToast(id);
    if (d.ok) showToast("success", t("portal.created.done", { name }));
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

// 创建项目弹窗（沿用 .mbox 通用模态，theme.css 已有）：填名→createProject→save→toast 成功→刷新最近项目
// S1-1 修 6 节点门修正：导出供 shell.js 左栏「新建项目」按钮直调（最小侵入，未注入时退化为 toast）
export function openNewProjectModal(onSuccess) {
  // 复用 v43 的 mbox 结构（最小版：本任务不挂载整组按钮，只实装填名/确认/取消）
  const modal = el("div", { id: "portalNewProjectModal", class: "mbox-wrap" });
  const box = el("div", { class: "mbox" });
  const h3 = el("h3", { text: t("portal.new.title") });
  const sub = el("div", { class: "sub", text: t("portal.new.sub") });
  const input = el("input", { type: "text", class: "ip-name", placeholder: t("portal.new.ph"), maxlength: "64" });
  const hint = el("div", { class: "ip-hint", text: "" });
  const ok = el("button", { type: "button", class: "prim ip-ok", text: t("portal.new.ok") });
  const cancel = el("button", { type: "button", class: "ghostbtn ip-cancel", text: t("portal.common.cancel") });
  const foot = el("div", { class: "foot" }, [cancel, ok]);
  box.append(h3, sub, input, hint, foot);
  modal.appendChild(box);
  modal.style.cssText = "position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:100";

  function close() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onEsc);

  cancel.addEventListener("click", close);
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  function submit() {
    const r = validateProjectName(input.value);
    if (!r.ok) {
      hint.textContent = t("portal.common.emptyName");
      showToast("error", t("portal.common.emptyName"));
      return;
    }
    try {
      const p = createProject(r.name);
      armCreatedToast(p.id, r.name);   // G1 必修②：「已创建」挂总表写落定后弹（失败不弹成功）
      save(p);
      close();
      if (typeof onSuccess === "function") onSuccess(p);
    } catch (e) {
      showToast("error", t("portal.new.fail", { msg: e && e.message ? e.message : e }));
    }
  }

  document.body.appendChild(modal);
  setTimeout(() => input.focus(), 0);
  return modal;
}

// ===== Quick Shot · 一句话快跑（S3-4 B5 · 空-008）=====
// 门户免表单简易提交：一句话（必填）+ 素材选（可选·资产库首帧参考卡）→ 复用概念环单段生成公共底层
//   （assets.js runSingleSegmentGeneration：1 段·2 秒·分镜 → generate_csv → submit → 轮询至 done）
// 与概念环入口的差异：不抽帧、不入资产库——完成态留在弹窗内（产物路径）+ toast。
const QUICK_SHOT_EMPTY_MSG = t("portal.qs.empty");

export function openQuickShotModal() {
  if (typeof document === "undefined") return null;

  const ta = el("textarea", {
    class: "qs-prompt",
    rows: "3",
    placeholder: t("portal.qs.ph"),
  });
  ta.style.cssText = "width:100%;padding:10px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);resize:vertical";

  // 素材选（可选）：资产库可作首帧参考的卡 → @N 注册表通道挂 first_frame
  const refSel = el("select", { class: "qs-ref", title: t("portal.qs.refTitle") });
  refSel.appendChild(el("option", { value: "", text: t("portal.qs.noRef") }));
  const refRow = el("div", { class: "qs-refrow" }, [el("label", { text: t("portal.qs.refLabel") }), refSel]);

  const hint = el("div", { class: "ip-hint", text: "" });
  const status = el("div", { class: "qs-status", text: "" });
  const content = el("div", { class: "qs-form" }, [ta, refRow, hint, status]);

  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("portal.common.cancel") });
  const goBtn = el("button", { type: "button", class: "prim", text: t("portal.qs.run") });
  const inst = openModal({
    title: t("portal.qs.title"),
    sub: t("portal.qs.sub"),
    contentNode: content,
    footerButtons: [cancelBtn, goBtn],
  });
  cancelBtn.addEventListener("click", () => inst.close());

  // 素材选数据源异步填充；库不可用 → 只剩「不挂参考图」，不阻断快跑
  listFirstFrameRefCards()
    .then((names) => { for (const name of names) refSel.appendChild(el("option", { value: name, text: name })); })
    .catch(() => { /* 库不可用 → 保持不挂参考图 */ });

  function idle() {
    cancelBtn.disabled = false;
    goBtn.disabled = false;
    goBtn.textContent = t("portal.qs.run");
  }

  goBtn.addEventListener("click", async () => {
    const prompt = String(ta.value || "").trim();
    if (!prompt) {
      hint.textContent = QUICK_SHOT_EMPTY_MSG;
      showToast("error", QUICK_SHOT_EMPTY_MSG);
      return;
    }
    hint.textContent = "";
    cancelBtn.disabled = true;
    goBtn.disabled = true;
    goBtn.textContent = t("portal.qs.running");
    status.textContent = t("portal.qs.running");
    try {
      const { stem, videoPath } = await runSingleSegmentGeneration(prompt, {
        refName: refSel.value || "",
        onTick: (data) => {
          const total = (data && typeof data.total === "number") ? data.total : 0;
          const done = (data && typeof data.done === "number") ? data.done : 0;
          status.textContent = total > 0 ? t("portal.qs.runningN", { done, total }) : t("portal.qs.running");
        },
      });
      status.textContent = videoPath ? t("portal.qs.donePath", { path: videoPath }) : t("portal.qs.doneTask", { stem });
      showToast("success", videoPath ? t("portal.qs.toastDonePath", { path: videoPath }) : t("portal.qs.toastDoneTask", { stem }));
      idle();
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      status.textContent = "";
      hint.textContent = t("portal.qs.fail", { msg });
      showToast("error", t("portal.qs.toastFail", { msg }));
      idle();
    }
  });

  return inst;
}

// ===== 主入口 =====
export function mount(container) {
  // 幂等：替换旧子树，避免双挂
  clearChildren(container);

  const view = el("section", { id: "view-home" });

  // ① 新建项目虚框 hero（B001 视觉）
  // 批 R7 · A6：plus 26 取代「＋」字符（v43 :1066）
  const hero = el("div", {
    class: "portal-hero",
    title: t("portal.new.heroTitle"),
    "data-act": "new-project",
  });
  const heroPlus = el("span", { class: "plus" });
  heroPlus.appendChild(el("span", { "data-ic": "plus", "data-sz": "26" }));
  hero.appendChild(heroPlus);
  hero.appendChild(el("span", { text: t("portal.new.title") }));
  // 批 R8 · ①B1：cap 文案 = 总清单 B1 折中口径（原型 :1068 说「直接…并进入设定页」，
  // GUI 真实链路=弹窗填名 → 创建 → 进设定页，故补「填名」步骤与「完成后」去向）
  hero.appendChild(el("span", { class: "cap", text: t("portal.new.heroCap") }));
  hero.addEventListener("click", () => {
    // C3（交接§四.4）：创建后跳设定页（对齐 v43「新建项目并进入设定页」）——经 onOpenProject 注入通道，
    // 未注入时保持既有停留门户行为（弹窗自身已 toast 创建成功）
    openNewProjectModal((p) => {
      refreshRecent(recentRow, secTitle);
      if (typeof _onOpenProject === "function") {
        try { _onOpenProject(p.id, "setup"); } catch (_e) { /* 注入通道异常不阻断创建成功态 */ }
      }
    });
  });
  view.appendChild(hero);

  // ② hero-sub 链接群（v43 形态 + 批D 第 5 项「一句话成片」；空挂项 = 无：Quick Shot B5 / 新手向导·Ctrl+K B7 均已实装接线）
  // 批 R7 · A7：图标 span（v43 :1071-1074 play/person/search/bell · 12px）取代字符 ▶/👤/⌕/⚠；
  //   老板走查批D 增第 5 项「一句话成片」（film·12）——原型四项相对序不变
  const heroSub = el("div", { class: "hero-sub" });
  // S3-4 B5（空-008）：Quick Shot 空挂退场——点击开免表单简易提交弹窗；title 回原型文案（v43 :1071）
  const qsLink = subLink([iconSpan("play", "12"), t("portal.qs.title")], () => openQuickShotModal());
  qsLink.title = t("portal.qs.linkTitle");
  heroSub.appendChild(qsLink);
  // 老板走查批D：成片入口归门户（资产页定位 = 做资产图）——「一句话成片」直弹概念环弹窗
  //   （assets.js openConceptModal 既有通道跨视图复用：成片 → 抽帧 → 概念帧落资产库，链语义不变）
  const cptLink = subLink([iconSpan("film", "12"), t("portal.cpt.link")], () => openConceptModal());
  cptLink.title = t("portal.cpt.linkTitle");
  heroSub.appendChild(cptLink);
  // S3-4 B7（A013/A014）：两入口空挂退场——新手向导 → 分步弹窗（B块任务6起首访自动弹一次·弹即写标记）；
  //   Ctrl+K 全局搜索 → 搜索弹窗（项目 / 资产·子串不区分大小写）
  const nwLink = subLink([iconSpan("person", "12"), t("portal.guide.link")], () => openGuideModal({
    onFinish: () => { nwLink.title = guideEntryTitle(); },
  }));
  nwLink.title = guideEntryTitle();
  heroSub.appendChild(nwLink);
  const ksLink = subLink([iconSpan("search", "12"), t("portal.search.link")], () => openSearchModal({
    onOpenProject: openProjectById,
  }));
  ksLink.title = t("portal.search.linkTitle");
  heroSub.appendChild(ksLink);
  view.appendChild(heroSub);

  // ③ 快捷入口 · 5 卡（S3-4 B9 跳转接线：映射见 QUICK_ROUTES「登记即裁决」）
  const secTitle1 = el("div", { class: "sec-title", text: t("portal.sec.quick") });
  view.appendChild(secTitle1);
  const cardsWrap = el("div", { class: "cards", id: "qcards" });
  cardsWrap.innerHTML = buildQuickCardsHtml();
  hydrateIcons(cardsWrap); // 批 R7 · A8：data-ic → svg（R0 范式 · 幂等）
  // 5 卡直连目标视图（空挂退场）
  cardsWrap.querySelectorAll(".qcard").forEach((card) => {
    const spec = QUICK_ROUTES[card.dataset.quick];
    if (!spec) return; // 未知卡不接线（防御）
    card.title = spec.title;
    card.addEventListener("click", () => {
      if (spec.hash) { goRoute(spec.hash); return; }
      openRecentProjectTab(spec.tab);
    });
  });
  view.appendChild(cardsWrap);

  // ④ 最近项目（B003 视觉）
  const secTitle = el("div", { class: "sec-title", text: t("portal.sec.recent") });
  view.appendChild(secTitle);
  const recentRow = el("div", { class: "recent-row", id: "recentRow" });
  view.appendChild(recentRow);

  // 渲染最近项目
  refreshRecent(recentRow, secTitle);

  // 缓存节点引用（S1-2 T0 修 1：shell.js onSuccess 回调刷新用）
  _recentRow = recentRow;
  _recentTitle = secTitle;

  hydrateIcons(view); // 批 R7：hero plus / hero-sub 四项 data-ic → svg（R0 范式 · 幂等）

  // 挂载
  container.appendChild(view);

  // B块任务6：首访自动弹一次向导——未读 → 先写已读标记再弹出（弹即写=无论用户何时关闭，
  //   都保证只自动弹这一次）；用户走完末步「开始使用」markGuideSeen 幂等再写，无妨
  if (!isGuideSeen()) {
    markGuideSeen();
    openGuideModal({ onFinish: () => { nwLink.title = guideEntryTitle(); } });
  }
}

function subLink(children, onClick) {
  const a = el("a");
  for (const c of [].concat(children)) {
    if (c == null) continue;
    a.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  if (typeof onClick === "function") {
    a.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
  }
  return a;
}

// 批 R7：data-ic 图标 span（原型 :1071-1074 同款结构）
function iconSpan(name, sz) {
  return el("span", { "data-ic": name, "data-sz": sz });
}

// ===== 5 卡跳转接线（S3-4 B9 · 详案 §S3-4j 映射「登记即裁决」）=====
//   - 创作画布卡 → 画布视图（#/canvas）
//   - 视频 / 图片 / 音频生成卡 → 设定 TAB（有最近项目=其设定 TAB；无=新建项目弹窗，建成后进设定 TAB）
//   - 智能剪辑卡 → 剪辑 TAB（最近项目；同上无则新建弹窗）
//   取舍：图片生成语义亦可归资产管理（#/assets），详案字面未裁 → 按字面落设定 TAB，角标注明去向。
//   跳转形态 = 写 location.hash（shell 路由 hashchange 接管；与 index.html 注入的 openProject 同机制）——
//   #/canvas 不在 onOpenProject 通道（该通道只承载带项目 id 的工作区跳转），故 5 卡统一走 hash。
const QUICK_ROUTES = {
  canvas: { title: t("portal.route.canvas"), hash: "#/canvas" },
  video:  { title: t("portal.route.video"), tab: "setup" },
  image:  { title: t("portal.route.image"), tab: "setup" },
  audio:  { title: t("portal.route.audio"), tab: "setup" },
  edit:   { title: t("portal.route.edit"), tab: "edit" },
};

// 写 hash 跳转；Node 无 location 时静默 false
function goRoute(hash) {
  const loc = (typeof globalThis !== "undefined") ? globalThis.location : null;
  if (!loc || typeof loc !== "object" || !("hash" in loc)) return false;
  try { loc.hash = hash; return true; } catch (_e) { return false; }
}

// 最近项目 id（按最近访问倒序取首；无则 null）
function recentProjectId() {
  const list = sortByUpdatedDesc(listProjects());
  return list.length > 0 ? list[0].id : null;
}

// 工作区 TAB 入口：有最近项目 → 其 TAB；无 → 新建项目弹窗（建成后进该 TAB）
function openRecentProjectTab(tab) {
  const id = recentProjectId();
  if (id) {
    goRoute(`#/project/${encodeURIComponent(id)}?tab=${encodeURIComponent(tab)}`);
    return;
  }
  openNewProjectModal((p) => {
    refreshRecent();
    goRoute(`#/project/${encodeURIComponent(p.id)}?tab=${encodeURIComponent(tab)}`);
  });
}

// ===== B004 回调注入（S1-1 T2 最小侵入）=====
// 设计：portal 不直接依赖 shell/router；通过 onOpenProject(fn) 注入回调；
// 未注入时退化为 toast 示意（保留 T1 行为，向后兼容）
let _onOpenProject = null;
export function onOpenProject(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== "function") {
    throw new TypeError("onOpenProject: fn must be a function or null");
  }
  _onOpenProject = fn;
}

// 进入项目工作区统一出口（B004）：注入 onOpenProject 时调之；未注入时退回 toast 示意（T1 行为）
//   - 最近项目卡（refreshRecent）与 S3-4 B7 全局搜索结果点击共用
function openProjectById(id) {
  if (typeof _onOpenProject === "function") {
    try {
      _onOpenProject(id);
    } catch (_e) {
      showToast("error", t("portal.open.fail", { msg: _e && _e.message ? _e.message : _e }));
    }
  } else {
    showToast("info", t("portal.open.stub", { id }));
  }
}

// 最近项目区节点引用（mount 时更新，供 S1-2 T0 修 1 shell.js 左栏新建项目 onSuccess 回调刷新）
//   - 未挂载时为 null；shell.js 调 refreshRecent() 需先确认 portal 已挂载（btnNew 触发 router.go("") → renderRoute → portal.mount 同步赋值）
let _recentRow = null;
let _recentTitle = null;

// 最近项目区渲染（提为函数，便于 modal 创建后回调）
//   - S1-2 T0 修 1：导出供 shell.js 左栏「新建项目」按钮 onSuccess 调用；
//     shell 触发新建成功后调此函数（无参走模块级缓存；测试/外部亦可显式传 row+secTitle）
export function refreshRecent(row, secTitle) {
  const r = row || _recentRow;
  const secTitleEl = secTitle || _recentTitle;   // #89 T1c：原名 t 遮蔽 i18n t()·改名让位（T1b 同例）
  if (!r) return; // 未挂载或被外部卸：静默 no-op（避免 NPE）
  const projects = listProjects();
  r.innerHTML = buildRecentProjectsHtml(projects);
  // #92 B8：底图离线回落接线（background-image 无 error 事件·探活制；projects.js refreshGrid 同款——
  //   Node 测试环境无 Image/fetch → no-op）。rcard[data-proj-id] 只含真实卡·DOM 序 = sorted 序。
  const thumbEls = r.querySelectorAll(".rcard[data-proj-id] .thumb");
  sortByUpdatedDesc(projects).slice(0, thumbEls.length).forEach((p, i) => {
    const cc = coverClipOf(p);
    if (cc && thumbEls[i]) wireBgMediaFallback(thumbEls[i], "thumb", cc.file, { maxSize: 512 });
  });
  hydrateIcons(r); // 批 R7 · A9：thumb film / ghost chev → svg（幂等）
  r.querySelectorAll(".rcard[data-proj-id]").forEach((card) => {
    card.addEventListener("click", () => openProjectById(card.dataset.projId));
  });
  // 0 项时空列表只露 ghost——给个温和提示
  if (secTitleEl && projects.length === 0) {
    secTitleEl.textContent = t("portal.sec.recentEmpty");
  } else if (secTitleEl) {
    secTitleEl.textContent = t("portal.sec.recent");
  }
}