// GUI1.3 创作画布视图 (S1-4 任务 T3 · 行为基准 E008-E029).
//
// === 出处注记 (S1-4 取用纪律) ===
// 自 v43 原型画布 JS 转正改写 (布局示意-项目工作区交互原型-v43-2026-09-24.html):
//   CBInit/CBApplyTitle      ← v43 :4441-4510 (G 广播 + seg 按分镜表 + asset 按 @N)
//   CBRender / CBNodeInner   ← v43 :4573-4855 (global/seg/asset/proc-sr/proc-interp/preview 内 HTML)
//   CBRenderWires            ← v43 :4903-4955 (SVG 贝塞尔+marker-end 箭头+global/global-ref/dataflow)
//   CBApplyViewport/CBReset  ← v43 :4958-4989 (平移归零+缩放 100%+右键复位)
//   空白交互                 ← v43 :4990-5033 (空白拖平移+滚轮缩放+右键空白)
//   CBNodeDragStart/CBDblClick/CBNodeCtx ← v43 :5036-5163 (节点拖/双击/右键菜单)
//   CBNodeDelArm             ← v43 :5286-5329 (删除两次确认 3s)
//   CBAddNode/CBAddProc/CBConnectProcToSeg ← v43 :5332-5401 (空白右键添加+单输入)
//   CBPortDragStart/End      ← v43 :5851-5898 (端口拖线+临时线)
//   CBNodeSize/CBClientToWorld ← v43 :5949-5967 (节点尺寸+世界坐标)
//   cvSave / openCvNm        ← v43 :6319-6332 (保存二选/命名弹窗)
//   CBHist/cbHistPush/CBHistGo/cbHistApply/cbHistUi ← v43 :6345-6399 (历史 30 步·同态去重·截断 redo)
//   CBResetConfirm/CBResetGo/CBNewConfirm/CBResetToEmpty ← v43 :6387-6404 (重置/新建两次确认)
//   CBPreviewToggle/CBPreviewMax/CBPreviewClose ← v43 :6010-6143 (节点内▶/最大化弹窗)
//   CBRsyncRefs              ← v43 :6160-6260 (@N 引用 ↔ 资产节点/边同步·orphan 保留)
//   CBGpSet/CBGpVal          ← v43 :4413-4438 (14 键双向桥)
//   CB_OnCanvasGp / CBOnCanvasSeg ← 视图版: 画布 textarea → store.globalPrompt / segments[].prompt
// 域逻辑 = app/js/core/canvas.js (checkConnLegality/checkProcOrder/findOverlapSegNode/refsParse
//         /syncRefEdges/histPush/histGo/zoomAt/zoomStepScale/clientToWorld/initFromProject)
// 数据源 = store.editingState.canvas (三视图同源铁律·F009) — 本视图不在 store 之外保留第二数据源.
// 行为基准: docs\v43-行为基线清单.md E008-E029.

import {
  load as storeLoad,
  save as storeSave,
  subscribe as storeSubscribe,
  unsubscribe as storeUnsubscribe,
  updateEditingState,
  updateGlobalParams,
  addSegment, // 战役批2-T3 F-83：右键加段走 store 建段卡（画布节点由 segment:add 对账代建）
  updateSegment,
  removeSegment as storeRemoveSegment,
  createProject,
  defaultEditingState,
  INDEX_WRITE_SETTLED_EVENT,   // 批9 G4a④：「已创建」toast 挂总表写落定事件（portal/projects 同形）
} from "../store/store.js";
// 批 10-M T5：未命名画布草稿迁服务侧 data/canvas-draft.json（整文件即草稿·无子键）
import { readFile as serverReadFile, writeFile as serverWriteFile, CANVAS_DRAFT as SERVER_CANVAS_DRAFT } from "../core/server_storage.js";
import { pickLocalFile, uploadAudioToEngine } from "../core/audio_upload.js"; // W-06 音乐文件选择（批 3）
import { initDocumentDelegate } from "../ui/cbox.js"; // 走查修复⑤：G 节点下拉框点击委托（与 settings/resources 同款·幂等）
import { followAnchor } from "../ui/anchor.js"; // F37：段连接菜单滚动/resize 跟随 cbMenu
import { open as openModal } from "../ui/modal.js"; // B7-T4：生成背景图弹窗（v43 #cvgen :2346 形）
import { mediaUrl } from "../core/api.js"; // 批 B #13：媒体 URL 双通道单源（引擎口优先·基址自持；回落接线由可挂 error 的消费点承接）
import { listAssets, submitSceneCanvas, submitItemCanvas, sceneCanvasStatus, itemCanvasStatus } from "../core/assets_api.js"; // B7-T4：#47/#53 提交+#48/#54 轮询（assetThumbPath 撤——#55 起资产 thumb URL 收敛 at-mention thumbUrl 单源）；批10 T4：listAssets 供「来源资产卡」下拉
import { resolveTemplate, buildPromptText } from "../core/prompt_templates.js"; // T5 #1：背景图生成 text=模板+空行+描述（场景图取 scene 模板·道具图取 prop 模板）
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import {
  clampScale,
  zoomAt,
  zoomStepScale,
  clientToWorld,
  checkConnLegality,
  checkProcOrder,
  findOverlapSegNode,
  syncRefEdges,
  canvasSig,
  canvasSnapOf,
  histPush as coreHistPush,
  histGo as coreHistGo,
  initFromProject as coreInitFromProject,
  canvasHotkeyOf,
  nextIdOf,
  SEG_NODE_W,
  SEG_NODE_H,
  assembleSixSegSkeleton,
  hasSixSegSkeleton,
} from "../core/canvas.js";
// 战役批1-T6 · F-81：G 节点模式下拉——三档选项复用 shell 顶栏常量，写侧复用 applyTopbarChange
//   （projMode 是项目顶层字段·不走 setGlobalParam）。shell.js 已 import * as canvas（:100），
//   本处成环但安全：applyTopbarChange/PROJ_MODE_OPTS 均为模块顶层绑定，运行时才执行。
import { PROJ_MODE_OPTS, applyTopbarChange, isEditableCtxTarget } from "./shell.js";
import { getCachedAssets, loadAssets } from "./prompt.js"; // 批 L2-T2：@资产名 nameIndex 数据源（prompt 资产缓存·views 只做映射）
// 战役批2-T2 · F-79②：段分镜框接 @联想。仅 bind 一件——assets 走上方 getCachedAssets 作 assetsGetter
//   （getCachedAssets 已由 assetsToMentionList 归一；normalizeAssets/buildAssetMap 是 prompt.js chips 链用料·不引入）
import { bind as atBind, thumbUrl } from "../ui/at-mention.js";   // #55：资产来源 thumb URL 唯一构造点（携 &v=<assetsRev>·画布资产节点缩略/背景图同口径）
import { t, pickDisplay } from "../core/i18n.js";   // #92 B2：画布页文案入典 canvas.*（zh 与源码字面量逐字一致·数据值走 pickDisplay 渲染侧映射）

// ===== 会话态 (挂载期持有; 卸载即弃) =====
let S = null;          // 视图主状态
let _subFn = null;     // store 订阅句柄 (退订用)
let _assetsLoadedFn = null; // prompt:assets-loaded 文档监听句柄 (退订用·批 L2-T2)

// 删除两次确认臂 (3 秒窗 · v43 CBNodeDelArm 同款)
let _delArm = { id: null, ts: 0 };
// 新建两次确认臂 (E021 · v43 CBNewConfirm)
let _newArm = { ts: 0 };
// 重置两次确认臂 (E023 · v43 CBResetConfirm)
let _rstArm = { ts: 0 };
// R-36 键盘热键套：document keydown 单监听（挂载即挂/unmount 对位摘除+S=null 双保险）
//   + 内存剪贴板（切视图即弃·不做跨视图剪贴板）+ 连续粘贴计数（Ctrl+C 成功时重置 1）
let _kbHandler = null;
let _kbClip = null;
let _kbPasteN = 0;

const DEL_ARM_MS = 3000;
const ARM_WINDOW_MS = 3000;

// ===== DOM 构造辅助 =====
function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = String(v);
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ===== 顶条按钮（v43 :1112-1129 同款 · E020-E025） =====
// 批 R7 · D7：cvSaveBtn 补 data-ic=save 13（v43 :1107）；D8：cvRunBtn 见下方 runBtn（play 13）
// 批 R8 · D5/D6：cvNewBtn/cvResetBtn title 还原原型原文（v43 :1102/:1105）
// #92 B2：字面量改典键（buildShell 循环渲染期 t() 取词·§4.9 非顶层求值）
const TOPBAR_BTNS = [
  { id: "cvNewBtn",   labelKey: "canvas.tb.new",  titleKey: "canvas.tb.newT", act: "new" },
  { id: "cvUndoBtn",  labelKey: "canvas.tb.undo",  titleKey: "canvas.tb.undoT", act: "undo" },
  { id: "cvRedoBtn",  labelKey: "canvas.tb.redo",  titleKey: "canvas.tb.redoT", act: "redo" },
  { id: "cvResetBtn", labelKey: "canvas.tb.reset", titleKey: "canvas.tb.resetT", act: "reset" },
  { id: "cvSaveBtn",  labelKey: "settings.btn.save", titleKey: "canvas.tb.saveT", act: "save", icon: "save", sz: "13" },
  // B7-T4 接真：「生成背景图」两步异步弹窗（引擎 #47/#48 scene_canvas · #53/#54 item_canvas · text 模式）
  //   弹窗形态原型锚 v43 #cvgen :2346；入口归顶条工具区（与「运行」相邻·批 0 送审定位保留）
  { id: "cvBgGenBtn", labelKey: "canvas.tb.bg", titleKey: "canvas.tb.bgT", act: "bgen" },
];

// ===== 入口挂载 =====
export function mount(container, opts = {}) {
  if (!container || typeof document === "undefined") return null;
  const projectId = opts.projectId || null;
  // 走查修复⑤（2026-09-27 老板报：画布全局参数下拉框失效）：G 节点 cbox 的点击开菜单靠
  //   document 级委托，此前由设定页首次挂载时绑定——直接进画布（未去过设定页）则委托缺失恒失效
  initDocumentDelegate(document);

  // 站位（避免上批残留节点 / 监听到 canvas）
  clearDom(container);

  S = {
    projectId,
    root: null,           // .cb-wrap 容器
    topbar: null,
    cvBackBtn: null,      // 返回项目（默认隐藏·带项目进画布时显示）
    cbRoot: null,         // 画布根
    cbStage: null,
    cbWires: null,
    cbHelp: null,
    cbZoomPct: null,
    zoomMinBtn: null,
    zoomMaxBtn: null,
    zoomResetBtn: null,
    cbResetBtn: null,
    hint: null,
    undoBtn: null,
    redoBtn: null,
    newBtn: null,
    resetBtn: null,
    saveBtn: null,
    runBtn: null,
    menuEl: null,         // 单例 cb-menu 浮层 (文档级右键菜单)
    portDrag: null,       // 端口拖线临时态
    delArm: { id: null, ts: 0 },
    modalEl: null,        // pv-modal 单例
    previewStates: {},    // id → { playing, prog }
    procSeq: { interp: 0, sr: 0 },
    assetSeq: 0,
    title: "",
    selId: null,          // R-36 选中节点 id（单选·会话态不落盘）
  };

  // 三视图同源：按 projectId 读 store.editingState.canvas
  let persisted = null;
  if (projectId) {
    const p = storeLoad(projectId);
    persisted = (p && p.editingState && p.editingState.canvas) || null;
    S.title = p ? (p.name || "") : "";
  } else {
    // 批 10-L L1-7（F80）：未命名草稿从本地草稿键还原（切走再切回内容真还在）
    persisted = loadCanvasDraft();
  }
  // 批 10-L L1-7：进画布即记上下文（侧栏从非项目路由切回时据此恢复·不落 recent 旧项目）
  canvasCtxRemember(projectId || "");

  // initFromProject 落画布态
  let initial;
  if (persisted && Array.isArray(persisted.nodes) && Array.isArray(persisted.edges)) {
    initial = persisted;
  } else {
    const project = projectId ? storeLoad(projectId) : null;
    const { nodes, edges } = coreInitFromProject(project || {});
    initial = {
      nodes,
      edges,
      projectName: (project && project.name) || "",
      viewport: { tx: 0, ty: 0, scale: 1 },
      hist: { base: null, stack: [], idx: -1, lock: false },
    };
  }
  // 保证视口/历史字段存在（兼容旧存档）
  if (!initial.viewport) initial.viewport = { tx: 0, ty: 0, scale: 1 };
  if (!initial.hist) initial.hist = { base: null, stack: [], idx: -1, lock: false };
  // J-P8：栈随项目 JSON 落盘·重挂载即还原 —— 但 lock 是瞬态护栏（pushHist 见 true 直接 return），
  //   旧版写盘的 lock:true 会在还原后把本会话 pushHist 永久钉死。还原时一律归位 false。
  if (initial.hist.lock) initial.hist.lock = false;

  // F007/F009：持久化画布重挂时，seg 节点数据按当前 segments 对账
  // （订阅只在挂载期活着——设定页/剪辑页的改动发生在卸载期，必须挂载时补同步）
  // F-B2（B 审修正笔）：对账键从"S<数组序>"改为 data.segId 唯一关联键——
  //   按位映射在中间删段后会把段数据绑到错节点（跨段污染）；缺 segId 的旧档节点按序补挂 segId
  if (projectId) {
    const pNow = storeLoad(projectId);
    if (pNow && Array.isArray(pNow.segments)) {
      const segs = pNow.segments;
      for (const n of initial.nodes) {
        if (n.type !== "seg") continue;
        if (!n.data) n.data = {};
        if (!n.data.segId) {
          const m = String(n.id).match(/^S(\d+)$/);
          const byIdx = m ? segs[+m[1] - 1] : null;
          if (byIdx) n.data.segId = byIdx.id;
        }
        const seg = n.data.segId ? segs.find((sg) => sg.id === n.data.segId) : null;
        if (!seg) continue; // 段已删（孤儿节点）→ 下方统一移除
        n.data = Object.assign({}, n.data, {
          prompt: seg.prompt || "",
          dur: typeof seg.durationSec === "number" ? seg.durationSec : n.data.dur,
          seed: seg.seed != null ? seg.seed : "",
        });
      }
      // 段已删 → 移除节点与其全部连线；新段 → 追加节点+广播边
      const alive = new Set(segs.map((sg) => sg.id));
      initial.nodes = initial.nodes.filter((n) => {
        if (n.type !== "seg") return true;
        const keep = !n.data || !n.data.segId || alive.has(n.data.segId);
        if (!keep) initial.edges = initial.edges.filter((e) => e.from !== n.id && e.to !== n.id);
        return keep;
      });
      const bound = new Set(initial.nodes.filter((n) => n.type === "seg").map((n) => n.data.segId));
      segs.forEach((seg, i) => {
        if (bound.has(seg.id)) return;
        initial.nodes.push({
          id: nextSegIdOf(initial.nodes), type: "seg", label: "段" + (i + 1),
          x: 460, y: 60 + i * 130,
          data: { segId: seg.id, n: i + 1, prompt: seg.prompt || "", dur: typeof seg.durationSec === "number" ? seg.durationSec : 5, seed: seg.seed != null ? seg.seed : "", status: "wait", badge: "中段", badgeCls: "b-mid" },
        });
        initial.edges.push({ from: "G", to: initial.nodes[initial.nodes.length - 1].id });
      });
      // 段节点编号 n/label 重排（文档序）
      let sn = 0;
      for (const sg of segs) {
        const node = initial.nodes.find((n) => n.type === "seg" && n.data.segId === sg.id);
        if (node) { sn += 1; node.data.n = sn; node.label = "段" + sn; }
      }
    }
  }

  S.canvas = initial;

  // DOM 渲染
  buildShell(container, projectId);
  applyViewport();
  renderAll();
  bindRootDelegates();
  bindDocDelegates();
  bindHotkeys(); // R-36：画布热键套（document keydown 单监听·unmount 对位摘除）

  // 订阅 store（外部更新 → 画布同步；F009 三视图同源）
  if (_subFn) storeUnsubscribe(_subFn);
  _subFn = (ev) => {
    if (!S || !S.canvas) return;
    if (!projectId || !ev || ev.projectId !== projectId) return;
    if (ev.type === "editingState:update") {
      // 画布自写标志：跳过本次（与 edit.js 同款防回环·F1/C2）
      if (S._selfWrite) { S._selfWrite = false; return; }
      const p2 = storeLoad(projectId);
      const c2 = (p2 && p2.editingState && p2.editingState.canvas) || null;
      if (c2 && c2 !== S.canvas) {
        S.canvas = c2;
        if (!S.canvas.viewport) S.canvas.viewport = { tx: 0, ty: 0, scale: 1 };
        if (!S.canvas.hist) S.canvas.hist = { base: null, stack: [], idx: -1, lock: false };
        if (S.canvas.projectName !== S.title) {
          S.title = S.canvas.projectName || "";
          renderTitle();
        }
        renderAll();
      }
    }
    if (ev.type === "globalParams:update") {
      // G 节点 14 键镜像刷新（E014·CBGpSet 等价）
      if (S.canvas.nodes.find((n) => n.id === "G")) renderGlobalNode();
    }
    if (ev.type === "project:save") {
      // 战役批1-T6 · F-81：反向同步——设定页顶栏改 projMode 落盘后，G 节点模式下拉回显
      //   （同型先例 setup.js:554 / segcards.js:970 的 project:save 分支）。
      //   只就地改值位 span 不整节点重渲：用户在画布 G 节点 textarea 里打字时不该被打断。
      //   画布自身写入的 project:save（persistCanvas 路径）读回同一 projMode，幂等无副作用。
      const pMode = storeLoad(projectId);
      const val = (pMode && pMode.projMode) || "";
      const gEl = S.cbNodes && S.cbNodes.querySelector('[data-id="G"]');
      if (gEl) {
        gEl.querySelectorAll("[data-projmode]").forEach((c) => {
          if (c.dataset.ctrl !== "projmode") return; // 只改值位 span（cbox 容器本身不动）
          const disp = String(pickDisplay("projMode", val == null ? "" : val));   // #92 B2：显示映射·数据零改
          if (c.textContent !== disp) c.textContent = disp;
        });
      }
    }
    // F-B1（B 审修正笔）：本会话自己经 updateSegment 写段卡时的同步 notify 会先于 storeSave 到达，
    // 此刻 storeLoad 读到旧值——直接回写节点会吃掉用户输入（打字回声）。命中抑制窗则跳过本次。
    if ((ev.type === "segment:update" || ev.type === "segment:add" || ev.type === "segment:remove")
      && S._segSelfWrite && S._segSelfWrite.segmentId === ev.segmentId
      && Date.now() - S._segSelfWrite.ts < 300) {
      return;
    }
    if (ev.type === "segment:update") {
      // 段卡变化 → 画布对应 seg 节点同步（E014/F009/F007）——按 data.segId 唯一键（F-B2）
      const p3 = storeLoad(projectId);
      const seg = p3 && p3.segments && p3.segments.find((s) => s.id === ev.segmentId);
      if (!seg) return;
      const segNode = S.canvas.nodes.find((n) => n.type === "seg" && n.data && n.data.segId === ev.segmentId);
      if (segNode) {
        segNode.data = Object.assign({}, segNode.data, {
          prompt: seg.prompt || "",
          dur: typeof seg.durationSec === "number" ? seg.durationSec : segNode.data.dur,
          seed: seg.seed != null ? seg.seed : (segNode.data.seed || ""), // F007：种子同步
        });
        renderNodeById(segNode.id);
      }
      // 批 L2-T2④：段卡文本变了 → 引用边跟着重算（@名字 在此同样生效）。
      //   定位注记：按路由互斥（shell renderRoute 统一 unmount）外部段编辑发生在画布卸载期，
      //   本监听当前近死代码·防御性保留（防未来出现同页写者）；真路径是挂载补跑 + G 对账。
      rerunRefEdges();
    }
    if (ev.type === "segment:add" || ev.type === "segment:remove") {
      // F-B2：设定页增删段 → 画布节点集对账（新增追加+广播边 / 删除移除节点与连线）
      const p3 = storeLoad(projectId);
      const segs = (p3 && p3.segments) || [];
      const alive = new Set(segs.map((sg) => sg.id));
      S.canvas.nodes = S.canvas.nodes.filter((n) => {
        if (n.type !== "seg" || !n.data || !n.data.segId) return true;
        const keep = alive.has(n.data.segId);
        if (!keep) S.canvas.edges = S.canvas.edges.filter((e) => e.from !== n.id && e.to !== n.id);
        return keep;
      });
      const bound = new Set(S.canvas.nodes.filter((n) => n.type === "seg").map((n) => n.data.segId));
      segs.forEach((seg, i) => {
        if (bound.has(seg.id)) return;
        S.canvas.nodes.push({
          id: nextSegIdOf(S.canvas.nodes), type: "seg", label: "段" + (i + 1),
          x: 460, y: 60 + i * 130,
          data: { segId: seg.id, n: i + 1, prompt: seg.prompt || "", dur: typeof seg.durationSec === "number" ? seg.durationSec : 5, seed: seg.seed != null ? seg.seed : "", status: "wait", badge: "中段", badgeCls: "b-mid" },
        });
        S.canvas.edges.push({ from: "G", to: S.canvas.nodes[S.canvas.nodes.length - 1].id });
      });
      let sn = 0;
      for (const sg of segs) {
        const node = S.canvas.nodes.find((n) => n.type === "seg" && n.data.segId === sg.id);
        if (node) { sn += 1; node.data.n = sn; node.label = "段" + sn; }
      }
      renderAll();
      persistCanvas();
    }
  };
  storeSubscribe(_subFn);

  // 初始化历史基线
  if (!S.canvas.hist.base) {
    S.canvas.hist.base = canvasSnapOf({
      nodes: S.canvas.nodes,
      edges: S.canvas.edges,
      projectName: S.canvas.projectName || "",
    });
    pushHist({ silent: true });
  }
  // 批 L2-T2③：G 节点 prompt 与 project.globalPrompt 对账（对齐上面段对账先例 :196-245）——
  //   setup 页输入的全局提示词若不落到 G.data.prompt，画布 textarea（globalInner :1048 读它）
  //   显旧值、自写镜像（onGlobalPromptInput :1203）再把旧值写回 store = 老板输入被回退
  //   （gp-change 事件监听不写：唯一派发点在 setup 页·路由互斥下画布挂载期永不触发·死代码）。
  reconcileGlobalPrompt();
  // 批 L2-T2②：@资产名 引用边补跑（资产未到位时早退·广播到达后再跑）
  rerunRefEdges();
  if (_assetsLoadedFn && typeof document !== "undefined") document.removeEventListener("prompt:assets-loaded", _assetsLoadedFn);
  _assetsLoadedFn = () => rerunRefEdges({ silentHist: true });   // #55：资产触发零推历史栈
  document.addEventListener("prompt:assets-loaded", _assetsLoadedFn);
  loadAssets(); // 资产缓存此前仅 setup.js:434 触发 → 画布主动拉（缓存早退幂等·一会话至多一次广播）
  refreshHistUi();
  // M1 真机门缺陷②（8940 实测）：首渲的 renderWires 跑在节点布局稳定前，nodeSize 读数
  //   失准走 fallback（global 300×120）——G 收起态实高 270，线头错位 75px（scale=1），
  //   刷新进画布即见、后续任何重渲才自愈。rAF 帧后布局稳定再算一次。
  //   守卫照 edit.js startPhRaf：非浏览器环境（单测未注入 rAF 桩）跳过，不中断 mount。
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (S) renderWires(); });
  return S.root;
}

// ===== 卸载 (幂等 — shell renderRoute 每次路由前调用) =====
export function unmount() {
  if (_subFn) { storeUnsubscribe(_subFn); _subFn = null; }
  if (_assetsLoadedFn) {
    if (typeof document !== "undefined") document.removeEventListener("prompt:assets-loaded", _assetsLoadedFn);
    _assetsLoadedFn = null;
  }
  unbindHotkeys(); // R-36：热键监听对位摘除 + 剪贴板清空（切视图即弃）
  if (S && S.menuEl && S.menuEl.parentNode) S.menuEl.parentNode.removeChild(S.menuEl);
  if (S && S.modalEl && S.modalEl.parentNode) S.modalEl.parentNode.removeChild(S.modalEl);
  S = null;
  _delArm = { id: null, ts: 0 };
  _newArm = { ts: 0 };
  _rstArm = { ts: 0 };
  // #56：摘除全部 @ 挂起提交槽（timer + commit 闭包随挂载即弃·防跨挂载补提交）
  for (const p of _refPending.values()) { if (p.timer) clearTimeout(p.timer); }
  _refPending.clear();
}

// ============================================================================
// 批 10-L L1-7（F80）：未命名画布草稿持久 + 画布上下文记忆
//   根因（主代理 8953 真机坐实）：新建画布（无 projectId）→ 切去项目管理 → 切回画布，
//   侧栏走 recent fallback 回旧项目 A；且 persistCanvas → writeEs 在无 projectId 时直接 return，
//   未命名草稿从不落盘 → 切走再挂（mount 重建 S）内容一并丢。
//   修法：①无项目态落 GUI 本地草稿键（挂载时还原·切走再切回内容真还在）
//        ②进画布即记上下文（项目 id 或未命名草稿标记·sessionStorage·同 gui13.gotoSeg 惯例），
//          侧栏非项目路由切画布据此恢复（见 shell.js 侧栏分支）。
//   草稿不存 hist（重挂时重建·省体积）；命名保存成项目后清草稿键（不留孤儿·同 dormantClear 口径）。
// ============================================================================
const DRAFT_KEY = "gui13.canvas.draft";
const CTX_KEY = "gui13.canvas.ctx";

function _ls() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}
function _ss() {
  try { return (typeof globalThis !== "undefined" && globalThis.sessionStorage) || null; }
  catch (_e) { return null; }
}

export function saveCanvasDraft(canvas, storage) {
  const st = storage || _ls();
  if (!st || !canvas) return;
  // 批 10-M T5：草稿迁服务侧 data/canvas-draft.json（整文件即草稿·无子键）
  serverWriteFile(SERVER_CANVAS_DRAFT, {
    nodes: canvas.nodes || [],
    edges: canvas.edges || [],
    projectName: typeof canvas.projectName === "string" ? canvas.projectName : "",
    viewport: canvas.viewport || { tx: 0, ty: 0, scale: 1 },
  }, st);
}

export function loadCanvasDraft(storage) {
  const st = storage || _ls();
  if (!st) return null;
  const p = serverReadFile(SERVER_CANVAS_DRAFT, st);   // M-T5：server 优先 → 本地回退（迁移前存量）
  return (p && Array.isArray(p.nodes) && Array.isArray(p.edges)) ? p : null;
}

export function clearCanvasDraft(storage) {
  const st = storage || _ls();
  if (!st) return;
  serverWriteFile(SERVER_CANVAS_DRAFT, null, st);   // M-T5：清整文件（不留孤儿草稿）
}

// 上下文记忆：null = 无记忆 · "" = 上次是未命名草稿 · "X" = 上次是项目 X
export function canvasCtxRemember(projectId, storage) {
  const st = storage || _ss();
  if (!st) return;
  try { st.setItem(CTX_KEY, JSON.stringify(projectId || "")); } catch (_e) { /* 隐私模式 */ }
}

export function canvasCtxRecall(storage) {
  const st = storage || _ss();
  if (!st) return null;
  try {
    const raw = st.getItem(CTX_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch (_e) { return null; }
}

// ===== 数据快速通道 =====
function es() {
  const p = storeLoad(S.projectId);
  return (p && p.editingState && typeof p.editingState === "object")
    ? p.editingState
    : defaultEditingState();
}

function writeEs(patch) {
  if (!S || !S.projectId) return;
  S._selfWrite = true;
  updateEditingState(S.projectId, patch);
}

function persistCanvas() {
  // 有项目 → 把 S.canvas 整体写到 store（白名单 canvas）—— 单源三视图
  // 无项目（未命名草稿）→ 落 GUI 本地草稿键（批 10-L L1-7：原路径 writeEs 无 projectId 直接
  //   return，草稿从不落盘·切走再挂即丢；此处补持久位，有项目态路径一字未变）
  if (!S) return;
  if (!S.projectId) { saveCanvasDraft(S.canvas); return; }
  writeEs({ canvas: S.canvas });
}

function persistNode(nodeId) {
  // 单节点更新（边集不变）—— 整体写以保一致
  persistCanvas();
  // 顺手更新标题（项目名）
  if (nodeId === "G") renderGlobalNode();
  renderNodeById(nodeId);
}

// ===== DOM 构建 =====
function clearDom(container) {
  while (container && container.firstChild) container.removeChild(container.firstChild);
}

function buildShell(container, projectId) {
  const wrap = el("div", { class: "cb-wrap" });
  S.root = wrap;

  // 顶条
  const topbar = el("div", { class: "cb-topbar", id: "cbTopbar" });
  // 批 R8 · D1/D23：cvBack 返回项目（v43 :1098）——默认 display:none（原型同款）；
  //   反向入口（项目顶栏「创作画布」→ /canvas?p=<id>）动态显示：有 projectId 才亮（无项目=无返回目标，保持隐藏）
  const cvBack = el("span", { class: "ghostbtn", id: "cvBack", title: t("canvas.back") });
  cvBack.style.display = "none";
  cvBack.appendChild(el("span", { "data-ic": "chev", "data-sz": "13", style: "transform:rotate(90deg)" }));
  cvBack.appendChild(document.createTextNode(t("canvas.back")));
  cvBack.addEventListener("click", () => {
    if (!S || !S.projectId) return;
    window.location.hash = `#/project/${encodeURIComponent(S.projectId)}?tab=setup`;
  });
  topbar.appendChild(cvBack);
  S.cvBackBtn = cvBack;
  if (projectId) cvBack.style.display = ""; // 反向入口（带项目进画布）→ 显示返回项目
  const title = el("h2", { id: "cvTitle" });
  S.titleEl = title; // 先挂引用再刷标题（renderTitle 以 S.titleEl 判空早退——原顺序致标题永空）
  renderTitle();
  topbar.appendChild(title);
  // 批 R8 · D2：h2 后说明 span（v43 :1100 逐字）
  const note = el("span", { style: "color:var(--txt2);font-size:12px",
    text: t("canvas.topbar.note") });
  topbar.appendChild(note);
  S.topbar = topbar;

  for (const b of TOPBAR_BTNS) {
    const btn = el("span", { class: "ghostbtn btn-tool", id: b.id, title: t(b.titleKey) });
    if (b.icon) btn.appendChild(el("span", { "data-ic": b.icon, "data-sz": b.sz || "13" }));
    btn.appendChild(document.createTextNode(t(b.labelKey)));
    btn.addEventListener("click", () => topbarAct(b.act));
    topbar.appendChild(btn);
    if (b.act === "undo") S.undoBtn = btn;
    if (b.act === "redo") S.redoBtn = btn;
    if (b.act === "new") S.newBtn = btn;
    if (b.act === "reset") S.resetBtn = btn;
    if (b.act === "save") S.saveBtn = btn;
  }
  // 运行按钮（青色主行动）
  // 批 R7 · D8/D24：play 13 取代「▶ 」字符（v43 :1109）
  const runBtn = el("span", { class: "runbtn btn-tool", id: "cvRunBtn", title: t("canvas.run.title") });
  runBtn.appendChild(el("span", { "data-ic": "play", "data-sz": "13" }));
  runBtn.appendChild(document.createTextNode(t("canvas.run")));
  runBtn.addEventListener("click", () => topbarAct("run"));
  topbar.appendChild(runBtn);
  S.runBtn = runBtn;

  wrap.appendChild(topbar);

  // 画布根
  const cbRoot = el("div", { class: "cb-root", id: "cbRoot" });
  S.cbRoot = cbRoot;

  // 三层原则折叠提示 (E027)
  // 批 R7 · D9：sliders 13 前缀 + chev 14 箭头（v43 :1113 · 取代「▾」字符）
  const help = el("div", { class: "cb-help open", id: "cbHelp" });
  const hd = el("div", { class: "cb-help-hd" });
  hd.appendChild(el("span", { "data-ic": "sliders", "data-sz": "13" }));
  hd.appendChild(document.createTextNode(t("canvas.help.head")));
  const arrow = el("span", { class: "cb-help-arrow" });
  arrow.appendChild(el("span", { "data-ic": "chev", "data-sz": "14" }));
  hd.appendChild(arrow);
  help.appendChild(hd);
  help.appendChild(el("div", { class: "cb-help-bd", text: t("canvas.help.body") }));
  hd.addEventListener("click", () => {
    help.classList.toggle("open");
  });
  cbRoot.appendChild(help);
  S.cbHelp = help;

  // 空白处右键提示
  const hint = el("div", { class: "cb-hint", id: "cbHint" });
  hint.innerHTML = t("canvas.hint");   // #92 B2：提示含 <b> 标记·保持 innerHTML（字典值带 HTML 有先例）
  cbRoot.appendChild(hint);
  S.hint = hint;

  // stage（承载 svg + 节点）
  const stage = el("div", { class: "cb-stage", id: "cbStage" });
  cbRoot.appendChild(stage);
  S.cbStage = stage;

  // 背景层（B7-T4：editingState.canvas.background · stage 首子节点 = 线/节点之下最底层）
  //   图片经引擎 thumb 通道加载（assets.js 卡面缩略图同款谓词 assetThumbPath 补 input/ 前缀）
  const bgLayer = el("div", { class: "cb-bg", id: "cbBg" });
  bgLayer.style.cssText = "position:absolute;left:0;top:0;width:3200px;height:2400px;pointer-events:none;background-size:cover;background-position:center";
  bgLayer.style.display = "none";
  stage.appendChild(bgLayer);
  S.cbBg = bgLayer;

  // svg 连线层
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "cb-wires");
  svg.setAttribute("id", "cbWires");
  svg.setAttribute("width", "3200");
  svg.setAttribute("height", "2400");
  stage.appendChild(svg);
  S.cbWires = svg;

  // 节点层
  const nodes = el("div", { id: "cbNodes" });
  stage.appendChild(nodes);
  S.cbNodes = nodes;

  // 复位视图按钮（悬浮右下·E026）
  // 批 R7 · D10：refresh 12 取代「↺ 」字符（v43 :1121）
  const cbReset = el("span", { class: "cb-reset", id: "cbReset", title: t("canvas.resetView.title") });
  cbReset.appendChild(el("span", { "data-ic": "refresh", "data-sz": "12" }));
  cbReset.appendChild(document.createTextNode(t("canvas.resetView")));
  cbReset.addEventListener("click", () => resetViewport());
  cbRoot.appendChild(cbReset);
  S.cbResetBtn = cbReset;

  // 右下缩放控件组（E009/E010）
  const zoombox = el("div", { class: "cb-zoombox", id: "cbZoombox" });
  const zMin = el("button", { type: "button", title: t("canvas.zoom.minT"), text: "−" });
  zMin.addEventListener("click", () => zoomStep(-0.1));
  const pct = el("span", { class: "cb-zoom-pct", id: "cbZoomPct", text: "100%" });
  const zMax = el("button", { type: "button", title: t("canvas.zoom.maxT"), text: "＋" });
  zMax.addEventListener("click", () => zoomStep(0.1));
  const zSep = el("span", { class: "cb-zoom-sep" });
  const zReset = el("button", { type: "button", title: t("canvas.zoom.resetT"), text: t("canvas.zoom.reset") });
  zReset.addEventListener("click", () => resetViewport());
  zoombox.appendChild(zMin);
  zoombox.appendChild(pct);
  zoombox.appendChild(zMax);
  zoombox.appendChild(zSep);
  zoombox.appendChild(zReset);
  cbRoot.appendChild(zoombox);
  S.zoomMinBtn = zMin;
  S.zoomMaxBtn = zMax;
  S.zoomResetBtn = zReset;
  S.cbZoomPct = pct;

  wrap.appendChild(cbRoot);

  // 单例右键菜单（v43 cbmenu/cnmenu → 一个浮层）
  const menu = el("div", { class: "cb-menu", id: "cbMenu", style: "display:none" });
  document.body.appendChild(menu);
  S.menuEl = menu;

  // 单例预览最大化弹窗（v43 pvmodal）
  const pvModal = el("div", { class: "pv-modal", id: "pvModal" });
  // F72：点遮罩关预览窗——判 mousedown（按下点）非 click（click 落共同祖先会误判外点）
  pvModal.addEventListener("mousedown", (e) => { if (e.target === pvModal) closePreviewModal(); });
  document.body.appendChild(pvModal);
  S.modalEl = pvModal;

  hydrateIcons(wrap); // 批 R7 · D7-D10：顶栏 save/play、帮助 sliders+chev、复位 refresh → svg
  container.appendChild(wrap);

  // E025：若有 projectId，把运行主链（顶栏）注入画布顶条右侧——读 submit 复用
  // 注：submit-bar 现仅注入到 buildProjectTopbar（项目视图）。画布视图无项目顶栏。
  // 本批按任务钦点：有项目名走提交链 toast 占位 + 登记；不强行侵入 submit-bar（其 mount 容器为 #submitBarSlot）。
  // 空项目态弹命名弹窗 → createProject 后 storeSave(canvas 同步落) → 顶条 toast 示意。
}

function renderTitle() {
  if (!S || !S.titleEl) return;
  const nm = (S.title || "").trim();
  S.titleEl.textContent = nm ? t("canvas.title.named", { name: nm }) : t("canvas.title.unnamed");
}

// ===== 视口（v43 CBApplyViewport·E009） =====
function applyViewport() {
  if (!S || !S.cbStage) return;
  const v = S.canvas.viewport;
  S.cbStage.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
  if (S.cbZoomPct) S.cbZoomPct.textContent = Math.round(v.scale * 100) + "%";
}

function resetViewport() {
  S.canvas.viewport = { tx: 0, ty: 0, scale: 1 };
  applyViewport();
  showToast("info", t("canvas.viewReset.done"));
  // 视口调整不入历史栈（v43 CBReset 也不入）—— 但 viewport 是画布态的子对象；
  // 为防止下次进入丢视口，统一 persist 一次
  persistCanvas();
}

function zoomStep(delta) {
  if (!S) return;
  const r = S.cbRoot.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const oldS = S.canvas.viewport.scale;
  const ns = zoomStepScale(oldS, delta);
  if (ns === oldS) return;
  // 以中心为锚
  S.canvas.viewport.tx = cx - (cx - S.canvas.viewport.tx) * (ns / oldS);
  S.canvas.viewport.ty = cy - (cy - S.canvas.viewport.ty) * (ns / oldS);
  S.canvas.viewport.scale = ns;
  applyViewport();
  persistCanvas();
}

// ===== 渲染主入口 =====
function renderAll() {
  if (!S || !S.cbNodes) return;
  const focusBack = captureCanvasFocus();   // #56 伴随：重建前抓焦点（仅当焦点本就在画布 textarea）
  clearDom(S.cbNodes);
  for (const n of S.canvas.nodes) {
    S.cbNodes.appendChild(buildNodeEl(n));
  }
  applySel(); // R-36：重建后回贴选中描边（选中节点已不在画布 → 选中态随之失效）
  applyViewport();
  renderBackground(); // B7-T4：背景层随画布重渲（store 外部更新换 S.canvas 后同步）
  renderWires();
  renderHelpPersist();
  refreshHistUi();
  restoreCanvasFocus(focusBack); // #56 伴随：恢复焦点与 selection（焦点已移别处时不抢回）
}

// #56 焦点恢复（必修伴随）：renderAll 全量重建会换掉正在打字的 textarea（丢焦+丢光标）。
//   限定条件：renderAll 前焦点本就在画布节点内的 textarea——否则（用户已移往别处，
//   如 600ms 兜底提交触发时）一律不抢回焦点。
function captureCanvasFocus() {
  const ae = (typeof document !== "undefined" && document.activeElement) || null;
  if (!ae || String(ae.tagName || "").toLowerCase() !== "textarea") return null;
  if (!S.root || typeof S.root.contains !== "function" || !S.root.contains(ae)) return null;
  let cur = ae;
  let nodeId = null;
  while (cur) {
    if (cur.dataset && cur.dataset.id) { nodeId = cur.dataset.id; break; }
    cur = cur.parentNode || cur._parent || null;
  }
  if (!nodeId) return null;
  return { nodeId, ss: ae.selectionStart, se: ae.selectionEnd };
}
function restoreCanvasFocus(f) {
  if (!f || !S || !S.cbNodes) return;
  const wrap = S.cbNodes.querySelector('[data-id="' + f.nodeId + '"]');
  const ta = wrap && wrap.querySelector("textarea");
  if (!ta || typeof ta.focus !== "function") return;
  ta.focus();
  if (f.ss != null && typeof ta.setSelectionRange === "function") {
    try { ta.setSelectionRange(f.ss, f.se); } catch (_e) { /* 桩或类型不符时忽略 */ }
  }
}

// ===== 背景层（B7-T4 · editingState.canvas.background）=====
function renderBackground() {
  if (!S || !S.cbBg) return;
  const bg = S.canvas && S.canvas.background;
  const media = bg && typeof bg.media === "string" ? bg.media.trim() : "";
  if (!media) {
    S.cbBg.style.display = "none";
    S.cbBg.style.backgroundImage = "";
    return;
  }
  S.cbBg.style.backgroundImage =
    `url("${thumbUrl(media, 2048)}")`;   // #55：资产来源 thumb URL 走 thumbUrl 单源（携 &v=<assetsRev>·改图后背景图同步新图）
  S.cbBg.style.display = "block";
}

function renderNodeById(id) {
  if (!S || !S.cbNodes) return;
  const old = S.cbNodes.querySelector(`[data-id="${id}"]`);
  if (!old) return;
  const n = S.canvas.nodes.find((x) => x.id === id);
  if (!n) return;
  const newEl = buildNodeEl(n);
  old.parentNode.replaceChild(newEl, old);
  applySel(); // R-36：单节点重建后回贴选中描边
  renderWires(); // M1 统一修：本函数是节点内容/尺寸重渲染的统一出口，尾部统一重算连线（G 展开/proc 折叠/resize 同根一处修·renderWires 自带 cbWires 空守卫）
}

// ===== R-36 选中态（单选·S.selId 单源·DOM .sel 类为视觉镜像） =====
function applySel() {
  if (!S || !S.cbNodes) return;
  // 单类查询（复合选择器超出测试桩支持·同 cnodeByType_ 口径）
  S.cbNodes.querySelectorAll(".cnode").forEach((x) => x.classList.remove("sel"));
  if (!S.selId) return;
  const elx = S.cbNodes.querySelector('[data-id="' + S.selId + '"]');
  if (elx) elx.classList.add("sel");
  else S.selId = null; // 选中节点已不在画布（删除/undo 回退）
}
function selectNode(n) { if (S) { S.selId = n.id; applySel(); } }
function clearSel() { if (S) { S.selId = null; applySel(); } }
// 热键分派取选中节点（null = 无选中）
function selNodeOf() {
  if (!S || !S.selId || !S.canvas) return null;
  return S.canvas.nodes.find((n) => n.id === S.selId) || null;
}

function renderHelpPersist() {
  // 三层原则折叠态从 hist 恢复时按 cnode 简态：本期固定默认 open
  if (S.cbHelp && !S.cbHelp.classList.contains("open") && !S.cbHelp.dataset.user) {
    S.cbHelp.classList.add("open");
  }
}

// ===== 批 10-L F79①：节点尺寸手柄（自定义·替掉原生 CSS resize）=====
//   老板一手复现：拖手柄变成拖节点 + 手柄区域过小 + 尺寸不持久。
//   尺寸数据化落 n.data.w/h（可选字段·缺省走 CSS 定宽）→ 重建不丢·随 canvas 态落盘。
//   delta ÷ viewport.scale：画布缩放态下拖 1 屏幕 px = 1 逻辑 px。
const NODE_SIZE_MIN = { w: 260, h: 120 };   // 与 .cnode 的 min-width/min-height 同源
const NODE_SIZE_MAX = { w: 640, h: 1200 };  // max-width 640（CSS 同源）·高上限防拖到离谱
// 菜单定位钳制（老板 2026-10-07 报障同根：底部右键菜单溢出屏幕——preview.js 同日修复·canvas 两处
//   右键菜单的写死估值 innerWidth-220/innerHeight-200 遇超高/超宽菜单仍越界·改按实测尺寸钳·贴边 8px）
export function clampMenuXY(x, y, vw, vh, mw, mh) {
  return [Math.max(8, Math.min(x, vw - mw - 8)), Math.max(8, Math.min(y, vh - mh - 8))];
}
export function clampNodeSize(w, h) {
  const cw = Math.min(NODE_SIZE_MAX.w, Math.max(NODE_SIZE_MIN.w, Math.round(+w) || NODE_SIZE_MIN.w));
  const ch = Math.min(NODE_SIZE_MAX.h, Math.max(NODE_SIZE_MIN.h, Math.round(+h) || NODE_SIZE_MIN.h));
  return { w: cw, h: ch };
}
export function computeNodeResize(startW, startH, dx, dy, scale) {
  const s = Number.isFinite(+scale) && +scale > 0 ? +scale : 1;
  return clampNodeSize((+startW || 0) + (+dx || 0) / s, (+startH || 0) + (+dy || 0) / s);
}
// 批 M6 F94：节点移动换算（computeNodeResize 同款 ÷scale + 防除零兜底 1）——缩放态拖 1 屏幕 px = 1/s 逻辑 px
export function computeNodeMove(snx, sny, dx, dy, scale) {
  const s = Number.isFinite(+scale) && +scale > 0 ? +scale : 1;
  return { x: (+snx || 0) + (+dx || 0) / s, y: (+sny || 0) + (+dy || 0) / s };
}

// 手柄拖动：实时改行内尺寸（不重建 DOM·防拖动中丢焦点）·mouseup 落 n.data.w/h + 重建 + 落盘
//   Esc = 取消回起始尺寸（老板误拖可回退）
function nodeResizeStart(e, n, wrap) {
  if (e.button !== 0) return;
  e.stopPropagation();   // 不冒泡到 wrap 的节点移动（手柄拖动 ≠ 拖节点）
  e.preventDefault();
  const sw = (+(n.data && n.data.w)) || (+wrap.offsetWidth) || 0;
  const sh = (+(n.data && n.data.h)) || (+wrap.offsetHeight) || 0;
  if (!sw || !sh) return;   // 量不到尺寸（无布局环境）→ 不起拖
  const sx = e.clientX, sy = e.clientY;
  const scale = (S.canvas && S.canvas.viewport && +S.canvas.viewport.scale) || 1;
  let cur = { w: sw, h: sh };
  wrap.classList.add("resizing");
  const mv = (ev) => {
    cur = computeNodeResize(sw, sh, ev.clientX - sx, ev.clientY - sy, scale);
    wrap.style.width = cur.w + "px";
    wrap.style.height = cur.h + "px";
  };
  const done = (commit) => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKey);
    wrap.classList.remove("resizing");
    if (!commit) {
      wrap.style.width = sw + "px";
      wrap.style.height = sh + "px";
      return;
    }
    n.data = n.data || {};
    n.data.w = cur.w;
    n.data.h = cur.h;
    renderNodeById(n.id);   // 按新尺寸重建·连线随之重算（renderNodeById 统一出口）
    persistCanvas();        // w/h 随画布态落盘（项目态 store 或未命名草稿键都带上）
  };
  const onUp = () => done(true);
  const onKey = (ev) => { if (ev && ev.key === "Escape") { ev.preventDefault(); done(false); } };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("keydown", onKey);
}

// ===== 单节点 HTML 构建 (v43 CBNodeInner :4675-4855 转正) =====
function buildNodeEl(n) {
  const wrap = el("div", { class: "cnode " + n.type });
  wrap.dataset.id = n.id;
  wrap.style.left = (n.x || 0) + "px";
  wrap.style.top = (n.y || 0) + "px";
  // 批 10-L F79①：用户拉过尺寸才写行内宽高（缺省走 CSS 定宽·不与设计值打架）
  if (n.data && +n.data.w > 0) wrap.style.width = (+n.data.w) + "px";
  if (n.data && +n.data.h > 0) wrap.style.height = (+n.data.h) + "px";
  if (n.type === "asset" && n.data && n.data.orphan) wrap.classList.add("orphan");
  if (n.type === "proc") {
    wrap.classList.add("proc-" + ((n.data && n.data.sub) || "interp"));
    if (!getUpSegIds(n.id).length) wrap.classList.add("orphan");
  }
  // 内 HTML
  // 端口（v18 单1/v19 :4592-4599 转正）：出口=右缘（除 global/preview）·入口=左缘装饰点（seg/proc/preview）·proc 拖线提示
  // R-37：G 补出口装饰点（.cb-port-deco·纯视觉锚不绑拖线——G→A/G→S 是系统维持边）+ asset 补入口装饰点（复用 .cb-port-in 先例）
  const outPort = (n.type !== "global" && n.type !== "preview")
    ? `<span class="cb-port" data-port="${n.id}" title="${escapeHtml(t("canvas.port.out"))}"></span>`
    : (n.type === "global" ? `<span class="cb-port-deco"></span>` : "");
  const inPort = (n.type === "seg" || n.type === "proc" || n.type === "preview" || n.type === "asset")
    ? `<span class="cb-port-in" title="${escapeHtml(t("canvas.port.in"))}"></span>` : "";
  const dragHint = (n.type === "proc") ? `<div class="cnode-hint">${escapeHtml(t("canvas.proc.dragHint"))}</div>` : "";
  const resizeHandle = `<span class="cnode-rs" title="${escapeHtml(t("canvas.node.resizeT"))}"></span>`; // 批 10-L F79①
  wrap.innerHTML = nodeInnerHtml(n) + outPort + inPort + dragHint + resizeHandle;
  hydrateIcons(wrap); // 批 R7 · D14/D17/D18/D19：节点内 data-ic（role sliders / proc chev / expand / play）→ svg
  // 端口（v18 单1）
  const portEl = wrap.querySelector(".cb-port");
  if (portEl) {
    portEl.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      portDragStart(e, n);
    });
  }
  // 缩放手柄（批 10-L F79①）：stopPropagation 后独立拖拽·不与节点移动/画布平移打架
  const rsEl = wrap.querySelector(".cnode-rs");
  if (rsEl) rsEl.addEventListener("mousedown", (e) => nodeResizeStart(e, n, wrap));
  // 节点拖拽 (E011) + R-36 按下即选中（与剪辑区手感一致·交互子元素命中不改选中·.sel 与 .dragging 并存拖后留选中）
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("textarea,input,select,button,.ctx-item,.sr-opt,.interp-toggle,.sr-res-input,.proc-adv-t,.expand,.cb-port,.pv-play,.cnode-preview-max,.cbox,.cbox-menu,.krow,.cnode-rs")) return;
    selectNode(n);
    nodeDragStart(e, n);
  });
  // 双击 (v43 CBDblClick)
  wrap.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    onNodeDblClick(n);
  });
  // 右键 (v43 CBNodeCtx · E012/E029)
  wrap.addEventListener("contextmenu", (e) => {
    if (isEditableCtxTarget(e.target)) return;   // 输入框（提示词 textarea 等）放行原生菜单（体验修复 A1）
    e.preventDefault();
    e.stopPropagation();
    showNodeMenu(e, n);
  });
  // global 节点：textarea → 同步 store.globalPrompt（E014·双向）
  if (n.type === "global") {
    const ta = wrap.querySelector("textarea.gp");
    if (ta) {
      // #56（2026-10-28）：input 携事件与元素（IME isComposing 守卫）+ compositionstart/end
      //   元素态标记 + blur 失焦提交挂起引用（无挂起即空转·flushRefPending 内部守卫）。
      ta.addEventListener("input", (e) => onGlobalPromptInput(ta.value, e, ta));
      ta.addEventListener("compositionstart", () => { ta._imeComposing = true; });
      ta.addEventListener("compositionend", () => { ta._imeComposing = false; });
      ta.addEventListener("blur", () => flushRefPending("ref:G"));
      ta.addEventListener("mousedown", (e) => e.stopPropagation());
      // #54（2026-10-28）：G 节点接 @联想，与段节点（F-79②）同款。落点本函数（每节点渲染路径）
      //   ——onGlobalPromptInput→syncRefEdges→renderAll 会重建 textarea，挂载期一次性绑定会失效。
      //   onPick 必须派发 input：pick() 直设 el.value 不派发事件，不接则点选不落库不连边。
      atBind(ta, {
        assets: getCachedAssets(),
        assetsGetter: () => getCachedAssets(),
        onPick: () => ta.dispatchEvent(new Event("input", { bubbles: true })),
      });
    }
    // 折叠/展开
    const exp = wrap.querySelector(".expand");
    if (exp) {
      exp.addEventListener("mousedown", (e) => e.stopPropagation());
      exp.addEventListener("click", (e) => {
        e.stopPropagation();
        n.data.expanded = !n.data.expanded;
        renderNodeById(n.id);
        persistCanvas();
      });
    }
    // 全局 14 键完整区双向
    wrap.querySelectorAll(".full .krow [data-gpk]").forEach((ctrl) => {
      bindFullCtrl(ctrl, n);
    });
    // 战役批1-T6 · F-81：「模式」下拉（项目顶层 projMode 域·写侧走 applyTopbarChange）
    //   按 cbox 类筛出下拉容器本身（值位 span 同带 data-projmode·但非 cbox）——同 bindFullCtrl 口径。
    wrap.querySelectorAll("[data-projmode]").forEach((ctrl) => {
      if (!ctrl.classList || !ctrl.classList.contains("cbox")) return;
      ctrl.addEventListener("mousedown", (e) => e.stopPropagation());
      ctrl.addEventListener("change", (e) => {
        const v = e && e.detail && e.detail.value !== undefined ? e.detail.value : undefined;
        if (v === undefined) return;
        setProjectMode(v);
      });
    });
  }
  // seg 节点：双击弹段卡编辑（与 setup.js 段卡同款数据回写）
  if (n.type === "seg") {
    // 节点内可点 textarea → 同步该段 prompt + 重建引用边（E015·F009）
    const ta = wrap.querySelector("textarea.seg-prompt");
    if (ta) {
      // #56（2026-10-28）：input 携事件与元素（IME isComposing 守卫）+ compositionstart/end
      //   元素态标记 + blur 失焦提交挂起引用（槽=ref:<nodeId>·与 G 槽独立互不吞没）。
      ta.addEventListener("input", (e) => onSegPromptInput(n, ta.value, e, ta));
      ta.addEventListener("compositionstart", () => { ta._imeComposing = true; });
      ta.addEventListener("compositionend", () => { ta._imeComposing = false; });
      ta.addEventListener("blur", () => flushRefPending("ref:" + n.id));
      ta.addEventListener("mousedown", (e) => e.stopPropagation());
      // 战役批2-T2 · F-79②：@联想（面板挂 doc.body·不在 wrap 内→拖拽排除名单无需改）
      //   落点在本函数（每节点渲染路径）而非挂载期：onSegPromptInput→syncRefEdges→renderAll 会重建
      //   textarea，挂载期一次性绑定的 el._atb 随之失效。
      //   onPick 必须派发 input：at-mention pick() 对 TEXTAREA 直设 el.value 且不派发事件，
      //   不接则点选后段卡不保存、syncRefEdges 不连边（口径=点选即保存·先例 prompt.js:362）。
      atBind(ta, {
        assets: getCachedAssets(),
        assetsGetter: () => getCachedAssets(),
        onPick: () => ta.dispatchEvent(new Event("input", { bubbles: true })),
      });
    }
    // 走查反馈⑥：节点内时长/种子小输入框（基础参数就地改·写 store 段卡单源）
    const durIn = wrap.querySelector("input.seg-dur-in");
    if (durIn) {
      durIn.addEventListener("mousedown", (e) => e.stopPropagation());
      durIn.addEventListener("change", () => {
        const v = Number(durIn.value);
        if (Number.isFinite(v) && v > 0) onSegFieldInput(n, "dur", v);
      });
    }
    const seedIn = wrap.querySelector("input.seg-seed-in");
    if (seedIn) {
      seedIn.addEventListener("mousedown", (e) => e.stopPropagation());
      seedIn.addEventListener("change", () => onSegFieldInput(n, "seed", seedIn.value.trim()));
    }
    // 六段骨架预填小按钮（S2-4 d4）：走 textarea input 同款路径以触发既有双向桥 + 引用边同步 + 历史
    const skelBtn = wrap.querySelector(".seg-skel-btn");
    if (skelBtn && ta) {
      skelBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      skelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        prefillSixSegSkeleton(n, ta);
      });
    }
  }
  // proc 节点：高级折叠条（v43 CBAdvToggle）
  if (n.type === "proc") {
    const adv = wrap.querySelector(".proc-adv-t");
    if (adv) {
      adv.addEventListener("click", (e) => {
        e.stopPropagation();
        n.data.advOpen = !n.data.advOpen;
        renderNodeById(n.id);
        persistCanvas();
      });
    }
    // SR 模式切换 (E017)
    wrap.querySelectorAll(".sr-opt").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const m = opt.dataset.mode;
        n.data.mode = m === "final" ? "final" : "quick";
        showToast("info", m === "final" ? t("canvas.proc.switchedFinal") : t("canvas.proc.switchedQuick"));
        renderNodeById(n.id);
        persistCanvas();
      });
    });
    // 插帧开关（S2-2 T9：帧率档位收敛 → 引擎唯一 48fps 开/关）
    const interpToggle = wrap.querySelector(".interp-toggle");
    if (interpToggle) {
      interpToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        n.data.interpOn = !n.data.interpOn;
        n.data.fps = 48; // 兜底固定 48（与渲染端读法对齐）
        renderNodeById(n.id);
        persistCanvas();
      });
      interpToggle.addEventListener("mousedown", (e) => e.stopPropagation());
    }
    // 超分分辨率
    const resInp = wrap.querySelector(".sr-res-input");
    if (resInp) {
      resInp.addEventListener("input", (e) => {
        e.stopPropagation();
        let v = parseInt(resInp.value, 10);
        if (Number.isNaN(v)) return;
        if (v < 256) v = 256;
        if (v > 3840) v = 3840;
        n.data.res = v;
        const unitEl = wrap.querySelector(".sr-res-unit");
        if (unitEl) unitEl.textContent = "×" + v;
        const headEl = wrap.querySelector(".proc-head-summary");
        if (headEl) headEl.textContent = n.data.mode === "final"
          ? t("canvas.proc.finalRes", { res: v })
          : t("canvas.proc.quickRes", { res: v });
        persistCanvas();
      });
      resInp.addEventListener("mousedown", (e) => e.stopPropagation());
    }
  }
  // asset 节点：缩略图加载失败（文件失联/路径错）→ 移除 <img>，露出 .cnode-thumb 色块底
  //   （渲染后 addEventListener 挂 error·不写内联 onerror——对齐仓内防内联惯例 at-mention.js:214；
  //     素材节点内唯一 <img> 即该缩略图·hydrateIcons 只产 svg）
  if (n.type === "asset") {
    const thumbImg = wrap.querySelector("img");
    if (thumbImg) {
      thumbImg.addEventListener("error", () => {
        if (thumbImg.parentNode) thumbImg.parentNode.removeChild(thumbImg);
      });
    }
  }
  // preview 节点：▶/最大化 (E018/E019)
  if (n.type === "preview") {
    // 批 L2-T4：真产物的 <video>（渲染后挂监听·不写内联属性——同 asset 缩略图口径）
    //   loadedmetadata → 时长角标填实测值（clip.dur 是计划时长·与产物常失配）
    //   error → 摘 video 退占位文案（不留黑框）
    const pvVid = wrap.querySelector("video");
    if (pvVid) {
      const durTag = wrap.querySelector(".pv-dur");
      pvVid.addEventListener("loadedmetadata", () => {
        if (!durTag) return;
        const d = Number(pvVid.duration);
        if (isFinite(d) && d > 0) durTag.textContent = (Math.round(d * 10) / 10) + "s";
      });
      pvVid.addEventListener("error", () => {
        if (pvVid.parentNode) pvVid.parentNode.removeChild(pvVid);
        const box = wrap.querySelector(".cnode-preview-img");
        if (box) box.innerHTML = `<div class="pv-empty" style="color:var(--txt3)">${escapeHtml(t("canvas.preview.vidFail"))}</div>`;
      });
      // 批 L2-T5 断播自愈：timeupdate 记断点 t；整树重建（renderAll）后据此复位并按 playing 续播
      //   ——渲染后回调域随每次重建重挂（重建产出新 <video>·监听不跨元素存活）
      const st = S.previewStates[n.id] || (S.previewStates[n.id] = { playing: false, t: 0 });
      pvVid.addEventListener("timeupdate", () => {
        st.t = Number(pvVid.currentTime) || 0;
      });
      if (st.t > 0) pvVid.currentTime = st.t;
      if (st.playing) {
        const p = pvVid.play();
        if (p && typeof p.catch === "function") p.catch(() => { st.playing = false; });
      }
      const pvBtn0 = wrap.querySelector(".pv-play");
      if (pvBtn0) pvBtn0.classList.toggle("on", !!st.playing);
      const pvBar0 = wrap.querySelector(".pv-progress");
      if (pvBar0) pvBar0.classList.toggle("running", !!st.playing);
    }
    const pvPlay = wrap.querySelector(".pv-play");
    if (pvPlay) {
      pvPlay.addEventListener("mousedown", (e) => e.stopPropagation());
      pvPlay.addEventListener("click", (e) => {
        e.stopPropagation();
        previewToggle(n.id);
      });
    }
    const pvMax = wrap.querySelector(".cnode-preview-max");
    if (pvMax) {
      pvMax.addEventListener("mousedown", (e) => e.stopPropagation());
      pvMax.addEventListener("click", (e) => {
        e.stopPropagation();
        previewMaximize(n.id);
      });
    }
  }
  return wrap;
}

function nodeInnerHtml(n) {
  if (n.type === "global") return globalInner(n);
  if (n.type === "seg") return segInner(n);
  if (n.type === "asset") return assetInner(n);
  if (n.type === "proc") return procInner(n);
  if (n.type === "preview") return previewInner(n);
  return "";
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- 全局参数节点 (v43 :4676-4710 · E014 · 14 键镜像) ----
//   批9 G4a⑤：三难词 tip 与「合并成」显示措辞对齐 setup.js GLOBAL_KEYS（三难词定义=体验修复8块 I 块；
//   键名=存储契约键一字不动·显示词走 GP_LABEL_KEY→setup.key.* 复用）。
//   #92 B2：tip/ph 字面量改键名（逐字等于 setup 同名键·渲染期 t()）；「质量」现盘无「（可选可手输）」
//   后缀≠setup.key.quality → 新键 canvas.gp.quality 保 zh 逐字；k/opts=数据契约零改。
const GP_LABEL_KEY = {
  "比例": "setup.key.ratio",
  "语言": "setup.key.lang",
  "质量": "canvas.gp.quality",
  "生成步数": "setup.key.steps",
  "配乐": "setup.key.soundtrack",
  "氛围声": "setup.key.ambience",
  "音乐混入": "setup.key.musicMix",
  "审片门": "setup.key.reviewGate",
  "默认负面": "setup.key.negDefault",
  "音乐文件": "setup.key.musicFile",
  "关音乐": "setup.key.muteMusic",
  "关对白": "setup.key.muteDialog",
  "关水印字幕": "setup.key.muteWatermark",
};
const GP_FULL = [
  { k: "比例", ctrl: "cbox", opts: "9:16 竖屏|16:9 横屏|1:1|4:3|3:4" },
  { k: "语言", ctrl: "cbox", opts: "中文|英文" },
  { k: "质量", ctrl: "cboxEdit", opts: "0.4 · 流畅|1.0 · 高清|2.0 · 超清" },
  { k: "生成步数", ctrl: "cboxEdit", opts: "8A8V|6A6V|4V4A" },
  { k: "配乐", ctrl: "cbox", opts: "自动|无" },
  { k: "氛围声", ctrl: "cbox", opts: "自动|无" },
  { k: "音乐混入", ctrl: "cbox", opts: "覆盖|混音", tipKey: "setup.key.musicMix.title" },
  { k: "审片门", ctrl: "cbox", opts: "关|开 · 宽松|开 · 严格", tipKey: "setup.key.reviewGate.title" },
  { k: "默认负面", ctrl: "text", phKey: "setup.ph.negDefault", tipKey: "setup.key.negDefault.title" },
  { k: "音乐文件", ctrl: "file" },
  { k: "关音乐", ctrl: "chk" },
  { k: "关对白", ctrl: "chk" },
  { k: "关水印字幕", ctrl: "chk" },
  { k: "全部段生成完自动接成一条片", lblKey: "setup.key.autoMerge", ctrl: "chk" },
];

function globalInner(n) {
  const expanded = !!(n.data && n.data.expanded);
  const proj = S.projectId ? storeLoad(S.projectId) : null;
  const gp = (proj && proj.globalParams) || {};
  // 战役批1-T6 · F-81：「模式」下拉（projMode 是项目顶层字段·不在 globalParams 域）
  //   初值取本函数既有 storeLoad 的 proj.projMode（与 globalParams 同一个 proj·不另发读请求）；
  //   选项复用 shell.PROJ_MODE_OPTS 三档。
  const projMode = (proj && proj.projMode) || "";
  const modeOpts = PROJ_MODE_OPTS.map((o) => `${o.value}=${o.label}`).join("|");
  // 折叠态摘要：5 键（#92 B2：键名走 GP_LABEL_KEY 取词·值走 pickDisplay 显示映射·数据零改）
  const simpleKeys = ["比例", "质量", "生成步数", "配乐", "审片门"];
  const kv = expanded ? "" : simpleKeys.map((k) =>
    `<div style="display:flex;justify-content:space-between;margin-bottom:3px;gap:8px"><span style="font-size:12px;color:var(--txt3);min-width:0;flex-shrink:1">${t(GP_LABEL_KEY[k] || k)}</span><span style="font-size:12px;color:var(--txt);min-width:0;flex-shrink:1;text-align:right">${escapeHtml(pickDisplay("globalParams", gp[k] == null ? "" : String(gp[k])))}</span></div>`
  ).join("");
  // 完整区（14 键 · 与设定页逐一对齐）
  //   #92 B2 / M1：非 edit 型 cbox 的 data-opts 拼 `value=label`（value=中文数据值·label=pickDisplay
  //   显示词·点选派发 value 写库零污染）；cboxEdit 型（质量/生成步数）保持裸原串——cbox.js 点选会把
  //   label 写进 .cb-in input，input 值经 bindFullCtrl 原样写 globalParams，拼英文即污染数据。
  const full = GP_FULL.map((f) => {
    const cur = gp[f.k] == null ? "" : gp[f.k];
    const lbl = t(GP_LABEL_KEY[f.k] || f.k);
    if (f.ctrl === "cbox" || f.ctrl === "cboxEdit") {
      const isEdit = f.ctrl === "cboxEdit";
      const optsAttr = isEdit ? f.opts : f.opts.split("|").map((o) => `${o}=${pickDisplay("globalParams", o)}`).join("|");
      const valSpan = isEdit
        ? `<input class="cb-in num" style="width:118px" value="${escapeHtml(cur)}" data-gpk="${f.k}" data-ctrl="cboxEdit">`
        : `<span class="cb-v" data-gpk="${f.k}" data-ctrl="cbox">${escapeHtml(pickDisplay("globalParams", cur))}</span>`;
      return `<div class="krow"><span class="kk"${f.tipKey ? ` title="${escapeHtml(t(f.tipKey))}"` : ""}>${lbl}</span>`
        + `<div class="cbox${isEdit ? " edit" : ""}" data-opts="${optsAttr}" data-gpk="${f.k}">${valSpan}<span class="cb-a">▾</span></div></div>`;
    }
    if (f.ctrl === "text") {
      return `<div class="krow"><span class="kk"${f.tipKey ? ` title="${escapeHtml(t(f.tipKey))}"` : ""}>${lbl}</span>`
        + `<input type="text" style="width:118px" placeholder="${escapeHtml(t(f.phKey || ""))}" value="${escapeHtml(cur)}" data-gpk="${f.k}" data-ctrl="text"></div>`;
    }
    if (f.ctrl === "file") {
      return `<div class="krow"><span class="kk">${lbl}</span>`
        + `<span class="num" style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(cur || "")}</span>`
        + `<span class="fbtn" data-gpk="${f.k}" data-ctrl="file">${t("canvas.gp.pick")}</span></div>`;
    }
    // chk
    return `<div class="krow" style="justify-content:flex-start;gap:6px;cursor:pointer"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;width:100%"><input type="checkbox"${cur ? " checked" : ""} data-gpk="${f.k}" data-ctrl="chk"><span class="kk" style="flex:1">${f.lblKey ? t(f.lblKey) : lbl}</span></label></div>`;
  }).join("");

  // 批 R7 · D14：.role 补 sliders 12（v43 :4705）
  return `<div class="role"><span data-ic="sliders" data-sz="12"></span><span>${escapeHtml(t("canvas.gp.role"))}</span></div>`
    + `<div class="cnode-hd"><span class="lbl">${escapeHtml(n.type === "global" ? t("setup.grp.globalParams") : (n.label || ""))}</span></div>`
    + `<div style="margin:6px 0 4px">${kv}</div>`
    + `<button class="expand" type="button">${expanded ? t("canvas.gp.collapse") : t("canvas.gp.expand")}</button>`
    + `<div class="full${expanded ? " show" : ""}"><div class="krow"><span class="kk">${t("shell.top.mode")}</span>`
    + `<div class="cbox" data-opts="${escapeHtml(modeOpts)}" data-projmode="1" title="${escapeHtml(PROJ_MODE_OPTS.map((o) => o.title).join(" / "))}">`
    + `<span class="cb-v" data-projmode="1" data-ctrl="projmode">${escapeHtml(pickDisplay("projMode", projMode))}</span><span class="cb-a">▾</span></div></div>${full}</div>`
    + `<textarea class="gp" rows="2" placeholder="${escapeHtml(t("canvas.gp.promptPh"))}">${escapeHtml((n.data && n.data.prompt) || "")}</textarea>`;
}

function bindFullCtrl(ctrl, n) {
  const gpk = ctrl.dataset.gpk;
  const ctype = ctrl.dataset.ctrl;   // #92 B2：局部 t → ctype 改名（i18n t import 防遮蔽·原语义零变）
  if (!gpk) return;
  if (ctrl.classList && ctrl.classList.contains("cbox") && ctype !== "cboxEdit") {
    // 走查修复⑤b（2026-09-27）：applyOption 把 change 派发在外层 cbox div 上（data-ctrl 挂在
    //   值位 span 上收不到）——监听须绑 div 本身；此前画布侧无监听 → 下拉选值只改显示不入库
    ctrl.addEventListener("mousedown", (e) => e.stopPropagation());
    ctrl.addEventListener("change", (e) => {
      const v = e && e.detail && e.detail.value !== undefined ? e.detail.value : undefined;
      if (v !== undefined) setGlobalParam(gpk, v, false);
    });
  } else if (ctype === "cboxEdit") {
    ctrl.addEventListener("mousedown", (e) => e.stopPropagation());
    ctrl.addEventListener("input", () => setGlobalParam(gpk, ctrl.value, true));
  } else if (ctype === "text") {
    ctrl.addEventListener("mousedown", (e) => e.stopPropagation());
    ctrl.addEventListener("input", () => setGlobalParam(gpk, ctrl.value, true));
  } else if (ctype === "file") {
    ctrl.addEventListener("mousedown", (e) => e.stopPropagation());
    // W-06 转正（批 3·与设定页同链路）：本机音频 → 引擎 input → 绝对路径写 globalParams
    ctrl.addEventListener("click", async () => {
      const f = await pickLocalFile("audio/*", "gui13-music-pick-canvas");
      if (!f) return;
      showToast("info", t("canvas.up.loading", { name: f.name }));
      const up = await uploadAudioToEngine(f);
      if (!up.ok) { showToast("error", t("canvas.up.fail", { err: up.error })); return; }
      setGlobalParam(gpk, up.absPath, false);
      // 节点内显示同步（file 行的值 span = ctrl 内前一个兄弟文本位）
      const valSpan = ctrl.previousElementSibling;
      if (valSpan) { valSpan.textContent = up.absPath; valSpan.title = up.absPath; }
      showToast("success", t("canvas.up.done", { name: f.name }));
    });
  } else if (ctype === "chk") {
    ctrl.addEventListener("click", (e) => e.stopPropagation());
    ctrl.addEventListener("change", () => setGlobalParam(gpk, !!ctrl.checked, false));
  }
}

function setGlobalParam(key, val, silent) {
  if (!S || !S.projectId) return;
  // 写 store（单一真相）
  updateGlobalParams(S.projectId, { [key]: val });
  // 节点内同步值（不重渲染整节点以保输入焦点）
  const nodeEl = S.cbNodes.querySelector('[data-id="G"]');
  if (nodeEl) {
    nodeEl.querySelectorAll("[data-gpk]").forEach((c) => {
      if (c.dataset.gpk !== key) return;
      // #92 B2 / M1：cboxEdit/text 输入位保持原值（不映射——输入即写库，映射英文会污染数据）；
      // 只读 cbox 值位 span 走 pickDisplay 显示映射。
      if (c.dataset.ctrl === "cboxEdit" || c.dataset.ctrl === "text") c.value = String(val == null ? "" : val);
      else if (c.dataset.ctrl === "cbox") c.textContent = String(pickDisplay("globalParams", val == null ? "" : String(val)));
      else if (c.dataset.ctrl === "chk") c.checked = !!val;
    });
    // 折叠态摘要同步（5 键）——统一刷新整节点（F-B5：原死变量 idx/spans 清理）
    renderNodeById("G");
  }
  if (!silent) showToast("info", t("canvas.gp.setToast", { key, val: typeof val === "boolean" ? (val ? "✓" : "✗") : val }));
}

// ===== 战役批1-T6 · F-81：G 节点「模式」下拉写侧 =====
// projMode 是项目顶层字段（store.js TOP_LEVEL_KEY_ORDER），不在 globalParams 域——
//   故不走 setGlobalParam，直接复用顶栏同款 applyTopbarChange（Object.assign + storeSave +
//   segcards.rerenderSegcardsByProject），设定页顶栏与段卡同源同步，零语义复刻防漂移。
// 焦点保护照 setGlobalParam 同款（就地改值位 span·不整节点重渲），不打断用户正在输入的其它 G 字段。
function setProjectMode(val) {
  if (!S || !S.projectId) return;
  applyTopbarChange(null, S.projectId, { projMode: val });
  const nodeEl = S.cbNodes.querySelector('[data-id="G"]');
  if (nodeEl) {
    nodeEl.querySelectorAll("[data-projmode]").forEach((c) => {
      if (c.dataset.ctrl !== "projmode") return; // 只改值位 span（cbox 容器本身不动）
      c.textContent = String(pickDisplay("projMode", val == null ? "" : val));   // #92 B2：显示映射·数据零改
    });
  }
}

// ===== 批 L2-T2：@资产名 引用边接线（nameIndex 注入 + 跨页对账 + 防 hist 污染）=====
// nameIndex 构建：prompt 资产缓存形态 {n, name, className, media}
//   → core refsParse 名字通道所需 {n, name, kind, media}（className 即画布色块档位·作 kind 透传）
function buildNameIndex() {
  return getCachedAssets().map((a) => ({
    n: a.n, name: a.name, kind: a.className || "", media: a.media || "",
  }));
}

// 战役批4-T2 · F-79：删指定 n 的**全部** @ 引用片段（断线同步删文本用）
//   扫描口径与 core refsParse 同款：名字最长前缀优先 + 词边界，未命中再按数字，一位一消费
//     —— 删完的文本再跑 refsParse 必不再产出 n（文本单源自洽·断开后不复活）。
//     只删首个命中不够：残留文本立即重建边 = 断开闪回。
//   尾随空格口径：删 @+名 后若紧邻一个空格则一并删（@联想回替形态固定带尾空格）；
//     行尾 / 后跟标点形态其后无空格 → 只删 @+名。
//   无命中返回原串（调用方据此判定「文本未动」·不触写链不推历史）。
function stripRefMentions(text, n, nameIndex) {
  const s = String(text == null ? "" : text);
  if (!s) return s;
  const names = [];
  for (const it of Array.isArray(nameIndex) ? nameIndex : []) {
    if (!it || typeof it.name !== "string" || !it.name || !Number.isFinite(+it.n)) continue;
    names.push(it);
  }
  names.sort((a, b) => b.name.length - a.name.length); // 最长前缀优先（本地副本·不改入参）
  let out = "";
  let i = 0;
  let changed = false;
  while (i < s.length) {
    const at = s.indexOf("@", i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    let len = 0, hit = null;
    for (const it of names) {
      if (!s.startsWith(it.name, at + 1)) continue;
      const after = s[at + 1 + it.name.length] || "";
      if (after && /[0-9A-Za-z_]/.test(after)) continue; // 词边界（引擎同款·core refsParse 一致）
      hit = +it.n; len = 1 + it.name.length;
      break;
    }
    if (!len) {
      const m = /^\d+/.exec(s.slice(at + 1));
      if (m) { hit = +m[0]; len = 1 + m[0].length; }
    }
    if (hit === n) {
      let end = at + len;
      if (s[end] === " ") end += 1; // 紧邻一个尾随空格一并删
      changed = true;
      i = end;
    } else {
      out += s.slice(at, at + (len || 1));
      i = len ? at + len : at + 1; // 未命中 → 位进 1（refsParse 同款·防死循环）
    }
  }
  return changed ? out : s;
}

// G 节点 prompt 与 store.globalPrompt 对账（挂载期跑一次）——跨页输入不再被画布旧值回写回退
function reconcileGlobalPrompt() {
  if (!S || !S.projectId || !S.canvas) return false;
  const p = storeLoad(S.projectId);
  const gp = (p && typeof p.globalPrompt === "string") ? p.globalPrompt : "";
  const g = S.canvas.nodes.find((n) => n.id === "G");
  if (!g) return false;
  if ((g.data && g.data.prompt) === gp) return false;
  g.data = Object.assign({}, g.data || {}, { prompt: gp });
  return true;
}

// 段号（syncRefEdges 的 segN 位）：data.n 优先（挂载段对账已按文档序重排）·退节点 id 后缀
function segNOf(node) {
  const d = node.data || {};
  if (Number.isFinite(+d.n) && +d.n > 0) return +d.n;
  const m = String(node.id).match(/^S([0-9]+)$/);
  return m ? +m[1] : null;
}

// 素材节点 data 回填（任务C #55 改版）：media/kind **按 n 强制刷新**（资产库改图保存后画布
//   已有节点同步新图——旧守卫「只回填占位名」是快照永不更新的主根因）；name 不覆盖手动改过
//   的名（占位态 "@N"/"新素材" 才回填注册真名）。
//   残留（已知边界）：已改名节点与注册 n 撞号时边仍按 id 错挂（core 查重语义 core/canvas.js:151）
function fillAssetData(nodes, nameIndex) {
  const byN = new Map();
  for (const it of nameIndex) byN.set(+it.n, it);
  let filled = false;
  for (const node of nodes) {
    if (node.type !== "asset") continue;
    const d = node.data || {};
    const it = byN.get(+d.n);
    if (!it) continue;
    const nm = d.name || "";
    const isPlaceholder = /^@[0-9]+$/.test(nm) || nm === "新素材";
    const next = { name: isPlaceholder ? it.name : nm, kind: it.kind || d.kind || "prop", media: it.media || "" };
    if (nm === next.name && d.kind === next.kind && (d.media || "") === next.media) continue; // 终态一致·幂等跳过
    node.data = Object.assign({}, d, next);
    filled = true;
  }
  return filled;
}

// 引用边补跑：全局 + 逐段（与 textarea 输入路径同款 syncRefEdges 调用点）
//   入口：挂载 / prompt:assets-loaded 广播 / segment:update
//   nameIndex 空 = 资产尚未到位 → 无新信息可解（@数字 的既有落盘态不动·不多跑一遍旧语义）
//   历史策略：栈未被用户推动（idx==0 且栈深==1）→ 以终态重建 base + 单帧栈
//     （对齐挂载基线先例·undo 不出现「撤自动边」步）；已被推动 → 正常 pushHist
//     （防会话中期到达时抹掉用户已积累的历史·J-P8 落盘固化）。
//   任务C #55（2026-10-28）：opts.silentHist=true（资产触发=prompt:assets-loaded 广播路径）
//     → 已被推动时**零推栈**只 persistCanvas——资产库每次保存不给画布历史栈推一步挤占
//     30 步栈，undo 第一步仍是用户自己的操作（不会把刚刷新的 media 又撤回旧图）。
function rerunRefEdges(opts = {}) {
  if (!S || !S.canvas || !Array.isArray(S.canvas.nodes)) return;
  const ni = buildNameIndex();
  if (!ni.length) return;
  let nodes = S.canvas.nodes;
  let edges = S.canvas.edges || [];
  let changed = false;
  const g = nodes.find((n) => n.id === "G");
  if (g) {
    const r = syncRefEdges(nodes, edges, (g.data && g.data.prompt) || "", null, ni);
    nodes = r.nodes; edges = r.edges; changed = changed || r.changed;
  }
  for (const n of nodes.filter((x) => x.type === "seg")) {
    const segN = segNOf(n);
    if (segN == null) continue; // 认不出段号 → 不猜（猜错会把全局边当段边重算）
    const r = syncRefEdges(nodes, edges, (n.data && n.data.prompt) || "", segN, ni);
    nodes = r.nodes; edges = r.edges; changed = changed || r.changed;
  }
  const filled = fillAssetData(nodes, ni);
  if (!changed && !filled) return; // 终态一致 → 不重渲不落盘（幂等·补跑零风暴）
  S.canvas.nodes = nodes;
  S.canvas.edges = edges;
  renderAll();
  const h = S.canvas.hist;
  if (h && h.idx === 0 && (h.stack || []).length === 1) {
    const snap = canvasSnapOf({ nodes, edges, projectName: S.canvas.projectName || "" });
    S.canvas.hist = { ...h, base: snap, stack: [snap], idx: 0, lock: false };
    refreshHistUi();
    persistCanvas();
  } else if (opts.silentHist === true) {
    persistCanvas();   // #55 资产触发：零推栈，仅落盘（media 刷新进项目 JSON）
  } else {
    pushHist();
  }
}

// ===== 任务B #56（2026-10-28）：@ 尾部歧义延迟提交（方案 v2.1 提交 B·选项 1） =====
// 资产库有 A/AB/ABC 时逐字手输 @ABC：旧实现每个前缀即时 syncRefEdges 各建一节点
// （A/AB 变 orphan 残留 + hist 逐字污染·老板项目「小女孩/1/2」1:1 复现）。改法：光标前尾名
// 「是另一注册名的严格前缀」且其后无分隔符时不立即 sync，失焦 / 空格·标点 / 点选 /
// 600ms 空闲四触发器之一时按 data.prompt 镜像提交；非歧义名保持即时同步。
// refsParse 终态语义零改动（core 红线）——分隔符闭合/点选回替形态天然走既有即时路径。
const REF_COMMIT_IDLE_MS = 600;
// 挂起槽按节点独立（要点 c）：G 与各段互不吞没——G 打到歧义态后点进段打字，段 input 只动段槽
const _refPending = new Map(); // "ref:<nodeId>" → { timer, commit }
// 尾名歧义判定：最后一个 @ 之后到文本尾为「裸尾巴」（无空格/标点/符号分隔·分隔符已闭合
// = 引用已定形）且存在比它更长的注册名以它为严格前缀 → 用户可能还在续字，先不提交
function refTailIsAmbiguous(text, nameIndex) {
  const s = String(text == null ? "" : text);
  const at = s.lastIndexOf("@");
  if (at < 0) return false;
  const tail = s.slice(at + 1);
  if (!tail || /[\s\p{P}\p{S}]/u.test(tail)) return false;
  return (Array.isArray(nameIndex) ? nameIndex : []).some((it) =>
    it && typeof it.name === "string" && it.name.length > tail.length && it.name.startsWith(tail));
}
// IME 组合态守卫：InputEvent.isComposing 或 compositionstart/end 元素态标记（兼容不派
// isComposing 的环境）。组合期间不 sync 不 renderAll（断流会打断输入法）不推历史。
function imeComposing(ev, ta) {
  if (ev && ev.isComposing === true) return true;
  return !!(ta && ta._imeComposing === true);
}
function armRefPending(slot, commit) {
  const prev = _refPending.get(slot);
  if (prev && prev.timer) clearTimeout(prev.timer);   // 要点 b：每次 input 取消并重置旧 timer
  const timer = setTimeout(() => {
    if (!_refPending.has(slot)) return;
    flushRefPending(slot);
  }, REF_COMMIT_IDLE_MS);
  _refPending.set(slot, { timer, commit });
}
function cancelRefPending(slot) {
  const prev = _refPending.get(slot);
  if (prev && prev.timer) clearTimeout(prev.timer);
  _refPending.delete(slot);
}
// 提交读值不持旧 textarea 引用（要点 a）：renderAll 会重建 DOM，这里按槽主键重查
// S.canvas.nodes 取最新节点读 data.prompt 镜像——两槽并行时一槽提交触发 renderAll
// 重建另一槽 textarea，凭镜像读值自洽
function flushRefPending(slot) {
  const p = _refPending.get(slot);
  if (!p) return;
  _refPending.delete(slot);
  if (p.timer) clearTimeout(p.timer);
  if (!S || !S.canvas || typeof p.commit !== "function") return;
  const node = S.canvas.nodes.find((n) => n.id === slot.slice(4));
  if (node) p.commit((node.data && node.data.prompt) || "");
}
// 测试口（同 store._test_flushDebounce 先例·生产无调用方）：假时钟兜底——立即触发全部挂起提交
export function _test_flushRefPending() {
  for (const slot of [..._refPending.keys()]) flushRefPending(slot);
}

function onGlobalPromptInput(text, ev, ta) {
  if (!S || !S.projectId) return;
  // 节点 data 镜像
  const g = S.canvas.nodes.find((n) => n.id === "G");
  if (g) g.data.prompt = text;
  // 写 store.globalPrompt
  const p = storeLoad(S.projectId);
  if (p) {
    p.globalPrompt = text;
    storeSave(p);
  }
  // 同步引用边（E015·syncRefEdges 全局语义）——#56 起经 commitLatest 即时/延迟两态提交
  const commitLatest = (txt) => {   // #92 B2：形参 t → txt 改名（i18n t import 防遮蔽）
    const r = syncRefEdges(S.canvas.nodes, S.canvas.edges, txt, null, buildNameIndex());
    S.canvas.nodes = r.nodes;
    S.canvas.edges = r.edges;
    if (r.changed) {
      renderAll();
    }
    pushHist();
  };
  if (imeComposing(ev, ta)) return;
  const ni = buildNameIndex();
  if (refTailIsAmbiguous(text, ni)) { armRefPending("ref:G", commitLatest); return; }
  cancelRefPending("ref:G");
  commitLatest(text);
}

// ---- 段节点 (v43 :4712-4728 · E015/E014) ----
// #92 B2：状态词走 pickDisplay("status")（4/4 命中）；「中段」徽标数据值零改·显示复用 seg.badge.mid
function segInner(n) {
  const rawP = (n.data && n.data.prompt) || "";
  const p = escapeHtml(rawP).replace(/@(\d+)/g, '<span class="ref">@$1</span>');
  const stMap = { ok: ["st-ok", "✓ ", "完成"], bad: ["st-bad", "⚠ ", "失败"], run: ["st-run", "◐ ", "渲染中"], wait: ["st-wait", "", "待生成"] };
  const status = (n.data && n.data.status) || "wait";
  const st = stMap[status] || stMap.wait;
  const badge = (n.data && n.data.badge) || "中段";
  const badgeDisp = badge === "中段" ? t("seg.badge.mid") : badge;
  const badgeCls = (n.data && n.data.badgeCls) || "b-mid";
  const dur = (n.data && typeof n.data.dur === "number") ? n.data.dur : 5;
  // 待审角标（v43 :4718 模板·:830 规则已在 canvas.css）：data.pending 有值才渲染（现无数据源 → 不显示）
  const pend = (n.data && n.data.pending) ? `<span class="cb-pend">${escapeHtml(t("canvas.seg.pendingAlt"))}</span>` : "";
  const outChain = segOutChainHtml(n.id);
  const isProjBound = !!S.projectId;
  // F007：种子展示（设定 TAB 段卡改种子 → segment:update 订阅 → 此处即时刷新）
  const seedVal = n.data && n.data.seed != null && n.data.seed !== "" ? n.data.seed : t("canvas.seg.seedFallback");
  return `<div class="cnode-hd"><span class="badge ${badgeCls}">${escapeHtml(badgeDisp)}</span><span class="${st[0]}">${st[1]}${escapeHtml(pickDisplay("status", st[2]))}</span></div>`
    + `<div class="cnode-title-row"><span class="cnode-title">${t("canvas.seg.titleN", { n: n.data && n.data.n ? n.data.n : "" })}</span>${pend}</div>`
    + `<div class="pcard-prompt" title="${escapeHtml(rawP)}">${p}</div>`
    + `<div class="cnode-foot"><span class="num" title="${escapeHtml(t("canvas.seg.durT"))}"><input class="seg-dur-in" type="number" min="1" max="60" step="1" value="${dur}" style="width:42px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 4px;color:var(--txt);font-size:12px;outline:none">s</span><span class="num cb-seg-seed" title="${escapeHtml(t("canvas.seg.seedT"))}">🌱 <input class="seg-seed-in" type="text" value="${escapeHtml(String(n.data && n.data.seed != null ? n.data.seed : ""))}" placeholder="${escapeHtml(pickDisplay("segField", "跟随全局"))}" style="width:86px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 4px;color:var(--txt);font-size:12px;outline:none"></span>${isProjBound ? `<span class="cnode-foot-tip">${escapeHtml(t("canvas.seg.dblEdit"))}</span>` : ""}</div>`
    + outChain
    + (isProjBound ? `<textarea class="seg-prompt" rows="2" style="width:100%;margin-top:6px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);font-size:12px;padding:4px 6px;resize:vertical;min-height:36px;outline:none;font-family:inherit;cursor:text;box-sizing:border-box" placeholder="${escapeHtml(t("canvas.seg.promptPh"))}">${escapeHtml(rawP)}</textarea>`
      + `<span class="ghostbtn btn-tool seg-skel-btn" title="${escapeHtml(t("canvas.seg.skelT"))}" style="margin-top:4px;font-size:11px;padding:2px 8px">${escapeHtml(t("canvas.seg.skelBtn"))}</span>` : "");
}

function onSegFieldInput(node, field, value) {
  if (!S || !S.projectId) return;
  if (field !== "dur" && field !== "seed") return;
  node.data[field] = value;
  let segId = node.data && node.data.segId;
  const p = storeLoad(S.projectId);
  if (!segId && p && p.segments) {
    const idx0 = parseInt(String(node.id).replace(/^S/, ""), 10);
    const byIdx = Number.isInteger(idx0) ? p.segments[idx0 - 1] : null;
    if (byIdx) { segId = byIdx.id; node.data.segId = segId; }
  }
  if (p && segId) {
    const patch = field === "dur" ? { durationSec: value } : { seed: value };
    markSegSelfWrite(segId);
    updateSegment(p, segId, patch);
    storeSave(p);
    persistCanvas();
  }
  showToast("success", t("canvas.seg.fieldUpdated", {
    n: node.data && node.data.n,
    f: field === "dur" ? t("canvas.seg.fDur") : t("canvas.seg.fSeed"),
  }));
}

function onSegPromptInput(node, text, ev, ta) {
  if (!S || !S.projectId) return;
  // 节点 data
  node.data.prompt = text;
  // 写 store 段卡（单源）——F-B2：按 data.segId 唯一键反查（旧档无 segId 按序兜底）
  let segId = node.data && node.data.segId;
  const p = storeLoad(S.projectId);
  if (!segId && p && p.segments) {
    const idx0 = parseInt(String(node.id).replace(/^S/, ""), 10);
    const byIdx = Number.isInteger(idx0) ? p.segments[idx0 - 1] : null;
    if (byIdx) { segId = byIdx.id; node.data.segId = segId; }
  }
  if (p && segId) {
    markSegSelfWrite(segId); // F-B1：抑制订阅回声（notify 先于 storeSave 到达）
    updateSegment(p, segId, { prompt: text });
    storeSave(p); // updateSegment 只改内存（store 语义：调用方负责落盘）
  }
  // 同步引用边（E015·段级语义）——段号取当前文档序；#56 起经 commitLatest 即时/延迟两态提交
  const idx = p && p.segments ? p.segments.findIndex((sg) => sg.id === segId) + 1 : parseInt(String(node.id).replace(/^S/, ""), 10);
  const commitLatest = (txt) => {   // #92 B2：形参 t → txt 改名（i18n t import 防遮蔽）
    const r = syncRefEdges(S.canvas.nodes, S.canvas.edges, txt, idx, buildNameIndex());
    S.canvas.nodes = r.nodes;
    S.canvas.edges = r.edges;
    if (r.changed) {
      renderAll();
    }
    pushHist();
  };
  if (imeComposing(ev, ta)) return;
  const ni = buildNameIndex();
  if (refTailIsAmbiguous(text, ni)) { armRefPending("ref:" + node.id, commitLatest); return; }
  cancelRefPending("ref:" + node.id);
  commitLatest(text);
}

// ===== 六段式骨架预填（S2-4 d4 · 走 textarea input 同款路径触发既有双向桥） =====
function prefillSixSegSkeleton(node, ta) {
  const cur = ta ? (ta.value || "") : (node.data && node.data.prompt) || "";
  if (hasSixSegSkeleton(cur)) {
    showToast("info", t("canvas.skel.dupe"));
    return;
  }
  const filled = assembleSixSegSkeleton(cur);
  ta.value = filled;
  // 触发既有 onSegPromptInput（input 事件 → 节点 data.prompt + store updateSegment + 引用边同步 + pushHist）
  onSegPromptInput(node, filled);
}

function segOutChainHtml(segId) {
  const out = S.canvas.edges.filter((e) => e.from === segId);
  if (!out.length) return "";
  const items = [];
  out.forEach((e) => {
    const n = S.canvas.nodes.find((x) => x.id === e.to);
    if (!n) return;
    let kind = null, nm = "";
    if (n.type === "proc") {
      const sub = n.data && n.data.sub;
      kind = sub; nm = sub === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp");   // #92 B2：复用既有 chip 词
    } else if (n.type === "preview") {
      kind = "preview"; nm = t("canvas.node.preview");
    } else return;
    items.push({ kind, nm });
  });
  if (!items.length) return "";
  let sN = 0, iN = 0;
  const rendered = items.map((it) => {
    let num;
    if (it.kind === "sr") { sN++; num = sN; }
    else if (it.kind === "interp") { iN++; num = sN + iN; }
    else { num = sN + iN + 1; }
    const cls = it.kind === "interp" ? "interp" : (it.kind === "preview" ? "preview" : "");
    return `<span class="ic-chip ${cls}">${it.nm}<b>${num}</b></span>`;
  });
  return `<div class="out-chain">${t("canvas.seg.outchain", { list: rendered.join(" · ") })}</div>`;
}

// ---- 资产节点 (v43 :4729-4735) ----
// 缩略图/显示名数据源：node.data 为主源（T2 占位回填已落地）；存量节点 data.media 空时
//   渲染时现查 prompt 资产缓存按 n 兜底（只读查表·对齐 views/prompt.js getCachedAssets）。
//   占位名 "@N" 同源取注册真名（兑现 core/canvas.js 造节点处「名字由资产库缓存填充」既注释）；
//   手动改名的节点不覆盖（与 T2 fillAssetData 占位判定同口径）。
function assetInfoOf(n) {
  const d = n.data || {};
  const cached = getCachedAssets().find((a) => +a.n === +d.n) || null;
  const nm = d.name || "";
  return {
    media: d.media || (cached && cached.media) || "",
    name: /^@[0-9]+$/.test(nm) && cached && cached.name ? cached.name : nm,
  };
}

function assetInner(n) {
  const d = n.data || {};
  const info = assetInfoOf(n);
  // 有 media → th-${kind} 色块（回退底）上叠真缩略图（引擎 #30 thumb 通道·形态同 at-mention.js）；
  //   真图加载失败由 buildNodeEl 的 error 监听摘掉 img 露回色块。无 media → 纯色块（既有形态不变）。
  const src = info.media
    ? thumbUrl(info.media, 512)   // #55：资产来源 thumb URL 走 thumbUrl 单源（携 &v=<assetsRev>）
    : "";
  const img = src
    ? `<img alt="" src="${escapeHtml(src)}" style="display:block;width:100%;height:100%;object-fit:contain;border-radius:inherit">`
    : "";
  return `<div class="cnode-thumb th-${d.kind || "prop"}">${img}</div>`
    + `<div class="atno">${escapeHtml(info.name)}</div>`
    + `<div class="atname" title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</div>`;
}

// ---- 处理节点 (v43 :4736-4808 · E016/E017) ----
// #92 B2：超分/插帧词复用 edit.segedit.chip*；未连段走 MAPS.status（数据值显示映射）
function procInner(n) {
  const sub = (n.data && n.data.sub) || "interp";
  const badgeCls = sub === "sr" ? "b-proc-sr" : "b-proc-interp";
  const badgeText = sub === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp");
  const chipOf = (p) => ((p.data && p.data.sub) === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp"));
  const upSegIds = getUpSegIds(n.id);
  const segLabels = upSegIds.map((segId) => {
    const segNode = S.canvas.nodes.find((x) => x.id === segId);
    return segNode ? t("canvas.seg.tag", { n: segNode.data && segNode.data.n ? segNode.data.n : "?" }) : "";
  }).filter(Boolean);
  const upTxt = segLabels.length ? t("canvas.proc.from", { list: segLabels.join("·") }) : (() => {
    const upProc = S.canvas.edges.filter((e) => e.to === n.id)
      .map((e) => S.canvas.nodes.find((x) => x.id === e.from))
      .filter((x) => x && x.type === "proc");
    return upProc.length ? t("canvas.proc.from", { list: upProc.map(chipOf).join("·") }) : `<span style="color:var(--txt3)">${escapeHtml(pickDisplay("status", "未连段"))}</span>`;
  })();
  const downCnt = getDownCount(n.id);
  const downTxt = downCnt > 0 ? t("canvas.proc.down", { n: downCnt }) : "";
  const mode = (n.data && n.data.mode) || "quick";
  const isQuick = mode !== "final";
  // 插帧档位收敛（S2-2 T9）：引擎唯一 48fps·开关两态·旧 fps 字段读时兜底
  const interpOn = !!(n.data && n.data.interpOn);
  const fps = 48; // 收敛后不再展示档位；旧帧率值读入时按"有值≠空→开"兜底
  const res = (n.data && n.data.res) || (isQuick ? 1280 : 720);
  const headSummary = (sub === "sr")
    ? (isQuick ? t("canvas.proc.quickRes", { res }) : t("canvas.proc.finalRes", { res }))
    : (interpOn ? "48fps" : t("canvas.proc.headInterpOff"));
  const opened = !!(n.data && n.data.advOpen);
  let advBody = "";
  if (sub === "sr") {
    advBody = `<div class="sr-toggle">`
      + `<div class="sr-opt${isQuick ? " on" : ""}" data-mode="quick">${escapeHtml(t("canvas.proc.quickMode"))}<small>1280×1280</small></div>`
      + `<div class="sr-opt${!isQuick ? " on" : ""}" data-mode="final">${escapeHtml(t("canvas.proc.finalMode"))}<small>720×720</small></div>`
      + `</div>`
      + `<div class="sr-res-row">`
        + `<label class="sr-res-label">${escapeHtml(t("canvas.proc.res"))}</label>`
        + `<input type="number" min="256" max="3840" step="32" class="sr-res-input" value="${res}" title="${escapeHtml(t("canvas.proc.resT"))}">`
        + `<span class="sr-res-unit">×${res}</span>`
      + `</div>`
      + `<div class="sr-note">${escapeHtml(t("canvas.proc.resNote"))}</div>`;
  } else {
    // 插帧：引擎唯一 48fps（S2-2 T9）· 多档帧率选择是假功能，全部收敛为开/关开关
    const interpOn = !!n.data.interpOn;
    advBody = `<div class="interp-fps-row">`
      + `<label class="interp-fps-label">${escapeHtml(t("edit.segedit.chipInterp"))}</label>`
      + `<span class="interp-toggle${interpOn ? " on" : ""}" data-on="${interpOn ? "1" : "0"}" title="${escapeHtml(t("canvas.proc.interpToggleT"))}">${escapeHtml(interpOn ? t("canvas.proc.interpOn48") : t("canvas.proc.off"))}</span>`
      + `<span class="interp-fps-hint">${escapeHtml(t("canvas.proc.interpHint"))}</span>`
      + `</div>`;
  }
  return `<div class="cnode-hd">`
    + `<span class="badge ${badgeCls}">${badgeText}</span>`
    + `<span class="proc-head-summary">${escapeHtml(headSummary)}</span>`
    + `</div>`
    + `<div class="proc-title">${sub === "sr" ? (isQuick ? t("canvas.proc.quickMode") : t("canvas.proc.finalMode")) : t("canvas.proc.interpTitle", { st: interpOn ? "48fps" : t("canvas.proc.off") })}</div>`
    + `<div class="cnode-foot proc-updown"><span>${upTxt}${downTxt}</span></div>`
    // 批 R7 · D17：proc 高级条箭头 data-ic=chev 12（v43 :4805 · 取代「▾」字符 · .open 旋转 180° 由 CSS 承接）
    + `<div class="proc-adv-t${opened ? " open" : ""}"><span>${escapeHtml(t("canvas.proc.adv"))}</span><span class="proc-adv-arrow"><span data-ic="chev" data-sz="12"></span></span></div>`
    + `<div class="proc-adv${opened ? " show" : ""}">${advBody}</div>`;
}

function getUpSegIds(procId) {
  return S.canvas.edges.filter((e) => e.to === procId && /^S\d+$/.test(e.from)).map((e) => e.from);
}
function getDownCount(procId) {
  return S.canvas.edges.filter((e) => e.from === procId).length;
}

// ---- 预览节点 (v43 :4810-4854 · E018/E019) ----
// 批 L2-T4：产物源从 seg.data.status（死通道——建节点恒写 wait·零回写·ok 分支线上走不到）
//   改读 store.editingState.mainClips：按 segId 对号（禁位置对号），门 = file 非空 +
//   state ∈ {done,warn}（同 store.js:617-638 deriveProjectCompletion 的 file 门·防 file 空
//   的 warn 段被计为有产物）。渲染时现查（只读不写·零第二写者·对齐 globalInner 的 storeLoad 口径）。
function previewClipOf(segN) {
  if (!segN || !segN.data || segN.data.segId == null || !S.projectId) return null; // 无项目草稿画布 → 无产物
  const p = storeLoad(S.projectId);
  const clips = (p && p.editingState && p.editingState.mainClips) || [];
  return clips.find((c) => c && c.segId === segN.data.segId) || null;
}
function previewInner(n) {
  const segEdge = S.canvas.edges.find((e) => e.to === n.id && /^S\d+$/.test(e.from));
  const segN = segEdge ? S.canvas.nodes.find((x) => x.id === segEdge.from) : null;
  const segNo = segN && segN.data ? segN.data.n : null;
  // 批 R8 · D20：完成态图变体按段 kind 分支（v43 :4817/:4824）
  const kind = (segN && segN.data && segN.data.kind) || "scene";
  const clip = previewClipOf(segN);
  const hasProd = !!(clip && clip.file && (clip.state === "done" || clip.state === "warn"));
  let imgCls = "", tagHtml = "", emptyHtml = "", vidHtml = "";
  let playHtml = `<span class="pv-play" title="${escapeHtml(t("canvas.preview.playT"))}"><span data-ic="play" data-sz="18"></span></span>`;
  if (!segN) {
    imgCls = "";
    tagHtml = "";
    emptyHtml = `<div class="pv-empty">${escapeHtml(t("canvas.preview.emptyNoSeg"))}</div>`;
  } else if (hasProd) {
    imgCls = kind === "scene" ? "th-scene" : kind === "person" ? "th-person" : "";
    // 时长角标走 video loadedmetadata 实测（clip.dur 是计划时长·常与产物失配）→ 先留空位
    tagHtml = `<div class="pv-tag pv-dur"></div>`
      + (clip.state === "warn" ? `<div class="pv-tag bad" style="right:5px;top:5px;bottom:auto">⚠ ${escapeHtml(pickDisplay("status", "失败"))}</div>` : "");
    vidHtml = `<video src="${escapeHtml(mediaUrl("video", clip.file))}"`   // 批 B #13：URL 收敛单源
      + ` preload="metadata" playsinline style="display:block;width:100%;height:100%;object-fit:contain;background:#000"></video>`;
  } else {
    imgCls = "";
    tagHtml = `<div class="pv-tag">${escapeHtml(pickDisplay("status", "待生成"))}</div>`;
    emptyHtml = `<div class="pv-empty" style="color:var(--txt3)">${escapeHtml(pickDisplay("status", "待生成"))}</div>`;
  }
  const progId = "pvBar_" + n.id;
  const st = S.previewStates[n.id] || (S.previewStates[n.id] = { playing: false, prog: 0 });
  const animRun = st.playing ? " running" : "";
  return `<div class="cnode-hd"><span class="badge b-preview">${escapeHtml(t("canvas.node.preview"))}</span></div>`
    + `<div class="cnode-title-row"><span class="cnode-title">${t("canvas.node.preview")}${segNo ? t("canvas.preview.segSuffix", { n: segNo }) : ""}</span></div>`
    + `<div class="cnode-preview-img ${imgCls || "th-empty"}">${emptyHtml || ""}${vidHtml}${playHtml}${tagHtml}</div>`
    + `<div class="pv-progress${animRun}" id="${progId}"><i></i></div>`
    // 批 R7 · D18：expand 13 取代「⛶」字符（v43 :4852）
    + `<div class="cnode-preview-max" title="${escapeHtml(t("canvas.preview.maxT"))}"><span data-ic="expand" data-sz="13"></span></div>`;
}

// 批 L2-T5：预览节点 ▶ 直控 video 播放/暂停（演示级假动画退役）
//   不再重建节点 DOM——renderNodeById 会当场销毁正播的 <video>（重渲即从头），
//   只切钮态类；playing 是 UI 态，真实播放进度由 video 自身 currentTime 持有。
function previewToggle(id) {
  if (!id || !S.cbNodes) return;
  const st = S.previewStates[id] || (S.previewStates[id] = { playing: false, t: 0 });
  const wrap = S.cbNodes.querySelector(`[data-id="${id}"]`);
  const vid = wrap ? wrap.querySelector("video") : null;
  if (!vid) return;                       // 无产物（占位态）→ 无可播对象
  if (st.playing) {
    st.playing = false;
    st.t = Number(vid.currentTime) || 0;   // 记断点（暂停后重渲可复位）
    vid.pause();
  } else {
    st.playing = true;
    const p = vid.play();
    if (p && typeof p.catch === "function") p.catch(() => { st.playing = false; });
  }
  const btn = wrap.querySelector(".pv-play");
  if (btn) btn.classList.toggle("on", st.playing);
  const bar = wrap.querySelector(".pv-progress");
  if (bar) bar.classList.toggle("running", st.playing);
}

function previewMaximize(id) {
  if (!id) return;
  const n = S.canvas.nodes.find((x) => x.id === id);
  if (!n) return;
  const segEdge = S.canvas.edges.find((e) => e.to === id && /^S\d+$/.test(e.from));
  const segN = segEdge ? S.canvas.nodes.find((x) => x.id === segEdge.from) : null;
  const st = S.previewStates[id] || (S.previewStates[id] = { playing: false, t: 0 });
  const modal = S.modalEl;
  while (modal.firstChild) modal.removeChild(modal.firstChild);
  const stage = el("div", { class: "pv-stage" });
  const h3 = el("h3", { text: t("canvas.node.preview") + (segN ? t("canvas.preview.segSuffix", { n: segN.data && segN.data.n }) : "") });
  const x = el("span", { class: "pv-x", text: "✕" });
  x.addEventListener("click", () => closePreviewModal());
  h3.appendChild(x);
  stage.appendChild(h3);
  const sub = el("div", { class: "pv-sub", text: t("canvas.pv.sub", { excerpt: segN && segN.data && segN.data.prompt ? segN.data.prompt.slice(0, 40) + (segN.data.prompt.length > 40 ? "…" : "") : t("canvas.pv.noSeg") }) });
  stage.appendChild(sub);
  const frame = el("div", { class: "pv-frame" });
  // 批 L2-T5：弹窗内换真 <video controls>（产物源同 previewClipOf · 无产物则留空框+占位文案）
  const clip = previewClipOf(segN);
  const mVid = (clip && clip.file)
    ? el("video", {
      class: "pv-video",
      src: mediaUrl("video", clip.file),   // 批 B #13：URL 收敛单源
      controls: "", autoplay: "", playsinline: "",
      style: "display:block;width:100%;height:100%;object-fit:contain;background:#000",
    })
    : null;
  if (mVid) {
    mVid.muted = true;   // 真 DOM 语义：muted 是属性不是 HTML attribute
    if (st.t > 0) mVid.currentTime = st.t;   // 续播位置（弹窗随节点断点）
    frame.appendChild(mVid);
  } else {
    frame.style.background = "#000";
    const empty = el("div", { class: "pv-empty", text: segN ? pickDisplay("status", "待生成") : pickDisplay("status", "未连段") });
    frame.appendChild(empty);
  }
  stage.appendChild(frame);
  const toolbar = el("div", { class: "pv-toolbar" });
  const bar = el("div", { class: "pv-progress" + (st.playing ? " running" : "") });
  bar.appendChild(el("i"));
  toolbar.appendChild(bar);
  // 批 L2-T5：钮态跟弹窗 video 实际播放态（autoplay muted → 开窗即播·真浏览器自动起播；
  //   原生 controls 也可被用户直接操作，故判据取 video.paused 而非节点 previewStates）
  const mPlaying = !!mVid;   // 有 video 即处于 autoplay 播放态
  const btn = el("span", { class: "ghostbtn", text: mPlaying ? t("canvas.pv.stop") : t("canvas.pv.play") });
  btn.addEventListener("click", () => {
    // 直控弹窗 video（明确对象·不再经节点 ▶ 路径——两处 video 各自独立）
    if (!mVid) return;
    if (mVid.paused) {
      const p = mVid.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      mVid.pause();
    }
    btn.textContent = mVid.paused ? t("canvas.pv.play") : t("canvas.pv.stop");
    bar.classList.toggle("running", !mVid.paused);
  });
  toolbar.appendChild(btn);
  stage.appendChild(toolbar);
  const meta = el("div", { class: "pv-meta" });
  if (segN) {
    meta.innerHTML = `<span>${escapeHtml(t("canvas.pv.metaPrompt", { txt: ((segN.data.prompt || "")).slice(0, 30) + ((segN.data.prompt && segN.data.prompt.length > 30) ? "…" : "") }))}</span>`
      + `<span>${escapeHtml(t("canvas.pv.metaDur", { dur: segN.data.dur }))}</span>`
      + `<span>${escapeHtml(t("canvas.pv.metaState", { state: clip && clip.file ? (clip.state === "warn" ? t("canvas.pv.stateWarn") : pickDisplay("status", "完成")) : pickDisplay("status", "待生成") }))}</span>`;
  } else {
    meta.innerHTML = `<span>${escapeHtml(pickDisplay("status", "未连段"))}</span>`;
  }
  stage.appendChild(meta);
  modal.appendChild(stage);
  hydrateIcons(stage); // 批 R7 · D19：弹窗内 play 26 → svg
  modal.classList.add("show");
  // 拖动（标题 = move handle）
  enableStageDrag(h3, stage);
}

let _pvDragCleanup = null;
function closePreviewModal() {
  if (_pvDragCleanup) { _pvDragCleanup(); _pvDragCleanup = null; }
  // 批 L2-T5：关窗停播释放（真 video 会继续出声——controls 播放不受画布态约束）
  if (S && S.modalEl) {
    const mVid = S.modalEl.querySelector("video");
    if (mVid) { mVid.pause(); }
    S.modalEl.classList.remove("show");
  }
}

function enableStageDrag(handle, stage) {
  // F-B4（B 审修正笔）：document 级监听具名化，关窗时移除（原实现每开一次预览永久累积 +2 监听）
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const mv = (e) => {
    if (!dragging) return;
    stage.style.left = (ox + (e.clientX - sx)) + "px";
    stage.style.top = (oy + (e.clientY - sy)) + "px";
  };
  const up = () => { dragging = false; };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  _pvDragCleanup = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
  };
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".pv-x")) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const rect = stage.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    stage.style.position = "fixed";
    stage.style.left = ox + "px";
    stage.style.top = oy + "px";
    stage.style.margin = "0";
    e.preventDefault();
  });
}

// ===== 连线渲染 (v43 CBRenderWires :4903-4955) =====
// G→A 引用线右键禁断文案：title + toast 同源一份（防两处漂移）。
//   战役批4-T2：@名字 与 @N 已同源（refsParse 名字通道）→ 文案同步写明两条通道。
//   #92 B2：字面量改键常量（渲染/事件期 t() 取词·单源保持）
const GREF_COPY_KEY = "canvas.wire.grefCopy";
function renderWires() {
  if (!S || !S.cbWires) return;
  const svg = S.cbWires;
  // 一次性定义箭头 marker
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<marker id="cbArrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" fill="currentColor"/></marker>`;
    svg.appendChild(defs);
  }
  // 清空旧 path 保留 defs
  [...svg.childNodes].forEach((n) => { if (n.nodeName.toLowerCase() !== "defs") svg.removeChild(n); });
  S.canvas.edges.forEach((e) => {
    const a = S.canvas.nodes.find((n) => n.id === e.from);
    const b = S.canvas.nodes.find((n) => n.id === e.to);
    if (!a || !b) return;
    const aS = nodeSize(a), bS = nodeSize(b);
    const ax = a.x + aS.w, ay = a.y + aS.h / 2;
    const bx = b.x, by = b.y + bS.h / 2;
    const mx = (ax + bx) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let cls = "cb-wire";
    let arrow = false;
    const isGRef = e.from === "G" && /^A\d+$/.test(e.to);
    if (isGRef) { cls += " global-ref"; }
    else if (e.from === "G") { cls += " global"; }
    else { cls += " dataflow"; arrow = true; }
    // R-37.3：带箭头 dataflow 线头回拉 6px 让出箭头；G 系无箭头线贴节点缘（线头对齐端口圆点中心）
    const tipBack = arrow ? 6 : 0;
    const endX = bx - (dx / len) * tipBack;
    const endY = by - (dy / len) * tipBack;
    const d = "M" + ax + "," + ay + " C" + mx + "," + ay + " " + mx + "," + endY + " " + endX + "," + endY;
    p.setAttribute("d", d);
    p.setAttribute("class", cls);
    if (arrow) p.setAttribute("marker-end", "url(#cbArrow)");
    p.style.pointerEvents = "stroke";
    // R-37.4：G 系右键禁断 toast/title 两分支文案（G→A 引用线 / G→S 广播线）
    p.title = isGRef ? t(GREF_COPY_KEY)
      : (e.from === "G" ? t("canvas.wire.gbroadcast") : t("canvas.wire.disconnectT"));
    p.addEventListener("contextmenu", (ev) => {
      if (isEditableCtxTarget(ev.target)) return;   // 输入框放行原生菜单（体验修复 A1·三处监听同口径）
      ev.preventDefault();
      ev.stopPropagation();
      if (e.from === "G") {
        showToast("info", isGRef ? t(GREF_COPY_KEY) : t("canvas.wire.gbroadcast"));
        return;
      }
      // v22：断线联动段卡勾选 / 同步 store 边
      S.canvas.edges = S.canvas.edges.filter((x) => !(x.from === e.from && x.to === e.to));
      // 段→proc/preview 断线 → 联动段卡对应字段（v43 CBSyncCardFromProc 等价）
      if (a.type === "seg" && b.type === "proc" && S.projectId) {
        syncProcCardFromSeg(a, b, false);
      }
      // 战役批4-T2 · F-79：A→S 引用边断开 = 同步删源段提示词里的全部 @片段（文本单源）
      //   只删边不碰文本 → 残留 @ 会经打字 input / 段卡更新 / 资产补跑 / 跨页对账四链
      //   原样重建边与素材节点（老板真机复验：删线后资产节点不断重弹）。
      //   undo 粒度：断开原为零 hist 步，改文本后经 onSegPromptInput 走一步 pushHist
      //     —— 一次断开 = 一个 undo 单元。
      let synced = "";
      if (/^A\d+$/.test(e.from) && b.type === "seg" && S.projectId) {
        const ni = buildNameIndex();
        const nRef = +e.from.slice(1);
        const old = (b.data && b.data.prompt) || "";
        const next = stripRefMentions(old, nRef, ni);
        if (next !== old) {
          const hit = ni.find((it) => +it.n === nRef);
          onSegPromptInput(b, next); // 既有写链：节点 data + 段卡落库 + syncRefEdges + pushHist
          synced = String((hit && hit.name) || nRef);
        }
      }
      renderAll();
      persistCanvas();
      showToast("info", synced ? t("canvas.wire.synced", { name: synced })
        : t("canvas.wire.disconnected", { a: nodeLabel(a), b: nodeLabel(b) }));
    });
    svg.appendChild(p);
  });
}

function nodeSize(n) {
  // v20：实际尺寸优先，未渲染时回退硬编码表
  const el = S.cbNodes.querySelector('[data-id="' + n.id + '"]');
  if (el && el.offsetWidth) return { w: el.offsetWidth, h: el.offsetHeight };
  const ty = n.type;   // #92 B2：局部 t → ty 改名（i18n t import 防遮蔽）
  return {
    w: ty === "global" ? 300 : ty === "seg" ? 220 : ty === "proc" ? 210 : ty === "preview" ? 240 : 170,
    h: 120,
  };
}

// #92 B2：节点 label 渲染侧映射（持久化值零改——label 按类型取词·asset 名=数据原样）
function nodeLabel(n) {
  if (n.type === "global") return t("setup.grp.globalParams");
  if (n.type === "seg") return t("canvas.seg.tag", { n: (n.data && n.data.n) || "?" });
  if (n.type === "asset") return assetInfoOf(n).name || "?";   // #19⑤：标签显卡名（原 @N 编号撤）
  if (n.type === "proc") return (n.data && n.data.sub) === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp");
  if (n.type === "preview") return t("canvas.node.preview");
  return n.label || n.id;
}

// ===== 段卡 ↔ proc/preview 联动（v43 CBSyncCardFromProc 同款） =====
function syncProcCardFromSeg(segNode, procNode, on) {
  if (!S || !S.projectId) return;
  const sub = procNode.data && procNode.data.sub;
  if (!sub) return;
  const field = sub === "sr" ? "超分" : "插帧";
  const p = storeLoad(S.projectId);
  if (!p || !p.segments) return;
  // F-B2：segId 唯一键反查（旧档无 segId 按序兜底）
  let segId = segNode.data && segNode.data.segId;
  if (!segId) {
    const idx = parseInt(String(segNode.id).replace(/^S/, ""), 10);
    const byIdx = Number.isInteger(idx) ? p.segments[idx - 1] : null;
    if (!byIdx) return;
    segId = byIdx.id;
    if (!segNode.data) segNode.data = {};
    segNode.data.segId = segId;
  }
  markSegSelfWrite(segId); // F-B1
  updateSegment(p, segId, { [field]: !!on });
  storeSave(p); // updateSegment 不落盘，需显式 save（段卡勾选联动回写）
}

// ===== 节点拖拽 (E011) =====
function nodeDragStart(e, n) {
  if (e.button !== 0) return;
  const el = S.cbNodes.querySelector('[data-id="' + n.id + '"]');
  if (!el) return;
  el.classList.add("dragging");
  document.body.classList.add("noselect");
  const sx = e.clientX, sy = e.clientY;
  const snx = n.x, sny = n.y;
  const scale = (S.canvas && S.canvas.viewport && +S.canvas.viewport.scale) || 1;   // F94：起手快照（对齐 nodeResizeStart）
  let moved = { dx: 0, dy: 0, hit: null };
  const mv = (ev) => {
    const p = computeNodeMove(snx, sny, ev.clientX - sx, ev.clientY - sy, scale);   // F94：÷scale（屏幕位移→逻辑坐标·缩放态跟手）
    n.x = p.x;
    n.y = p.y;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    moved.dx = ev.clientX - sx;
    moved.dy = ev.clientY - sy;
    if (n.type === "proc") {
      // proc 拖拽时检测重叠（单输入约束：拖到段节点上 = 自动连线）
      const cand = findOverlapSegNode(S.canvas.nodes, n);
      if (cand) {
        moved.hit = cand;
        cand.__cbPortTarget = true;
        const segEl = S.cbNodes.querySelector('[data-id="' + cand.id + '"]');
        if (segEl) segEl.classList.add("cb-port-target");
      } else if (moved.hit) {
        moved.hit.__cbPortTarget = false;
        const segEl = S.cbNodes.querySelector('[data-id="' + moved.hit.id + '"]');
        if (segEl) segEl.classList.remove("cb-port-target");
        moved.hit = null;
      }
    }
    renderWires();
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    el.classList.remove("dragging");
    document.body.classList.remove("noselect");
    if (n.type === "proc" && moved.hit) {
      const segEl = S.cbNodes.querySelector('[data-id="' + moved.hit.id + '"]');
      if (segEl) segEl.classList.remove("cb-port-target");
      connectProcToSeg(n.id, moved.hit.id, true);
    }
    if (moved.dx || moved.dy) pushHist();
    persistCanvas();
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  e.preventDefault();
  e.stopPropagation();
}

function connectProcToSeg(procId, segId, fromDrag) {
  const procN = S.canvas.nodes.find((x) => x.id === procId);
  const segN = S.canvas.nodes.find((x) => x.id === segId);
  if (!procN || procN.type !== "proc" || !segN || segN.type !== "seg") return false;
  if (S.canvas.edges.some((e) => e.from === segId && e.to === procId)) {
    if (fromDrag) showToast("info", t("canvas.conn.dupSeg", { n: segN.data && segN.data.n }));
    return false;
  }
  if (S.canvas.edges.some((e) => e.to === procId)) {
    if (fromDrag) showToast("info", t("canvas.conn.busy", { kind: (procN.data && procN.data.sub) === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp") }));
    return false;
  }
  S.canvas.edges.push({ from: segId, to: procId });
  // 反向联动段卡
  syncProcCardFromSeg(segN, procN, true);
  renderAll();
  persistCanvas();
  showToast("info", t("canvas.conn.segProc", { n: segN.data && segN.data.n, kind: (procN.data && procN.data.sub) === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp") }));
  return true;
}

// ===== 端口拖线 (v43 CBPortDragStart/End :5851-5898) =====
function portDragStart(e, srcN) {
  const svg = S.cbWires;
  const szS = nodeSize(srcN);
  const start = { x: srcN.x + szS.w, y: srcN.y + szS.h / 2 };
  S.portDrag = { srcId: srcN.id, srcType: srcN.type, start, line: null };
  const drawWire = (ex, ey) => {
    const mx = (start.x + ex) / 2;
    return "M" + start.x + "," + start.y + " C" + mx + "," + start.y + " " + mx + "," + ey + " " + ex + "," + ey;
  };
  const initW = clientToWorldLocal(e.clientX, e.clientY);
  let path = null;
  if (svg) {
    path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "cb-dragwire");
    path.setAttribute("d", drawWire(initW.x, initW.y));
    svg.appendChild(path);
    S.portDrag.line = path;
  }
  const mv = (ev) => {
    const w = clientToWorldLocal(ev.clientX, ev.clientY);
    S.portDrag.cur = w;
    if (path) path.setAttribute("d", drawWire(w.x, w.y));
  };
  const up = (ev) => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("noselect");
    const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const targetNodeEl = targetEl ? targetEl.closest(".cnode") : null;
    let tgt = null;
    if (targetNodeEl) {
      const tid = targetNodeEl.dataset.id;
      tgt = S.canvas.nodes.find((x) => x.id === tid);
    }
    portDragEnd(srcN, tgt, ev);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  if (path) e.preventDefault();
}

function clientToWorldLocal(clientX, clientY) {
  if (!S.cbRoot) return { x: clientX, y: clientY };
  const r = S.cbRoot.getBoundingClientRect();
  const s = S.canvas.viewport.scale;
  return clientToWorld(clientX, clientY, { left: r.left, top: r.top }, S.canvas.viewport);
}

function portDragEnd(srcN, tgtN, _e) {
  if (S.portDrag && S.portDrag.line && S.portDrag.line.parentNode) {
    S.portDrag.line.parentNode.removeChild(S.portDrag.line);
  }
  S.portDrag = null;
  if (!tgtN) {
    showToast("info", t("canvas.port.dropHint"));
    return;
  }
  if (tgtN.id === srcN.id) {
    showToast("info", t("canvas.conn.self"));
    return;
  }
  const legal = checkConnLegality(srcN.type, tgtN.type);
  if (!legal.ok) {
    showToast("info", t("canvas.conn.illegal", { msg: legal.msg }));
    return;
  }
  // 单输入约束：proc/preview 已有入边 → 拒绝
  if ((tgtN.type === "proc" || tgtN.type === "preview") && S.canvas.edges.some((x) => x.to === tgtN.id)) {
    showToast("info", t("canvas.conn.hasInput", { name: nodeLabel(tgtN) }));
    return;
  }
  // 顺序锁死（proc→proc）
  if (srcN.type === "proc" && tgtN.type === "proc") {
    const ord = checkProcOrder(srcN.data && srcN.data.sub, tgtN.data && tgtN.data.sub);
    if (!ord.ok) { showToast("info", t("canvas.conn.illegal", { msg: ord.msg })); return; }
  }
  // global→seg/asset 已有自动线防重边
  if (S.canvas.edges.some((x) => x.from === srcN.id && x.to === tgtN.id)) {
    showToast("info", t("canvas.conn.linked"));
    return;
  }
  S.canvas.edges.push({ from: srcN.id, to: tgtN.id });
  // 段→proc 联动段卡勾选
  if (srcN.type === "seg" && tgtN.type === "proc") syncProcCardFromSeg(srcN, tgtN, true);
  renderAll();
  persistCanvas();
  showToast("info", t("canvas.conn.created", { a: nodeLabel(srcN), b: nodeLabel(tgtN) }));
}

// ===== 画布根交互：空白拖平移/滚轮缩放/右键空白（E009/E010/E026） =====
function bindRootDelegates() {
  if (!S || !S.cbRoot) return;
  const root = S.cbRoot;
  root.addEventListener("mousedown", (e) => {
    if (e.target.closest(".cnode,.cb-reset,.cb-help,.cb-zoombox,.cb-help-hd,.cb-help-bd")) return;
    if (e.button !== 0) return;
    clearSel(); // R-36：点击空白清选中（平移起手同路径·右键不清）
    const sx = e.clientX, sy = e.clientY;
    const stx = S.canvas.viewport.tx, sty = S.canvas.viewport.ty;
    root.classList.add("panning");
    document.body.classList.add("noselect");
    const mv = (ev) => {
      S.canvas.viewport.tx = stx + (ev.clientX - sx);
      S.canvas.viewport.ty = sty + (ev.clientY - sy);
      applyViewport();
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      root.classList.remove("panning");
      document.body.classList.remove("noselect");
      persistCanvas();
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = root.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const next = zoomAt(S.canvas.viewport, mx, my, e.deltaY);
    S.canvas.viewport = next;
    applyViewport();
    persistCanvas();
  }, { passive: false });
  root.addEventListener("contextmenu", (e) => {
    if (isEditableCtxTarget(e.target)) return;   // 输入框右键放行原生菜单（体验修复 A1）
    if (e.target.closest(".cnode")) return;
    e.preventDefault();
    hideMenu();
    showBlankMenu(e);
  });
}

// ===== 文档级委托（菜单关闭 / 通用键盘） =====
// F-B4（B 审修正笔）：文档级监听改模块单例——handler 自带 S 守门，重挂不重复绑定
//   （同一 document + 同一函数引用重复 addEventListener 为无操作；单测换 document 桩时仍能挂上）
let _docMousedownHandler = null;
let _docClickHandler = null;
function bindDocDelegates() {
  if (typeof document === "undefined") return;
  if (!_docMousedownHandler) {
    // F72：判 mousedown（按下点）非 click——按下在菜单项、松开在菜单外时 click 落共同祖先，
    //   closest("#cbMenu") 判空 → 同款误关。判据语义不变（点在菜单外才收），只换取事件源。
    _docMousedownHandler = (e) => {
      if (!S) return;
      if (!e.target.closest("#cbMenu")) hideMenu();
    };
    // 体验修复 A1：输入框内 mousedown 被 stopPropagation（提示词 textarea 防拖拽），mousedown 关闭链
    //   收不到 → 补 click 链（click 不被输入框拦），点菜单外空白即关；与 mousedown 同例防累积绑定。
    _docClickHandler = (e) => {
      if (!S) return;
      if (!e.target.closest("#cbMenu")) hideMenu();
    };
  }
  document.addEventListener("mousedown", _docMousedownHandler);
  document.addEventListener("click", _docClickHandler);
}

function hideMenu() {
  if (S && S.menuEl) S.menuEl.style.display = "none";
}

// ===== R-36 键盘热键套（视图薄壳：监听+喂数+分派+DOM 操作·守门语义在 core canvasHotkeyOf） =====
function bindHotkeys() {
  if (_kbHandler || typeof document === "undefined") return;
  _kbHandler = (ev) => {
    if (!S || !S.canvas) return;
    // 守门链喂数（edit.js A13 先例）：输入保护 target 判定 + 弹窗豁免（.mbox-wrap / 预览弹窗 show）
    const tgt = ev.target || {};   // #92 B2：局部 t → tgt 改名（i18n t import 防遮蔽）
    const inRange = tgt.tagName === "INPUT" && String(tgt.type || (tgt.getAttribute && tgt.getAttribute("type")) || "") === "range";
    const typing = (tgt.tagName === "INPUT" && !inRange) || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable;
    const modalOpen = !!document.querySelector(".mbox-wrap") || !!(S.modalEl && S.modalEl.classList.contains("show"));
    const sel = selNodeOf();
    const r = canvasHotkeyOf(ev, { hasSel: !!sel, selType: sel ? sel.type : null, typing, modalOpen, clip: _kbClip });
    if (r === "none") return; // 未命中组合不 preventDefault（原生行为不动）
    ev.preventDefault();
    if (r.act === "copy") {
      _kbClip = JSON.parse(JSON.stringify(sel));
      _kbPasteN = 1; // 新复制从 +40 起（连续粘贴 +40/+80 递增·每次成功复制重置）
      showToast("info", t("canvas.node.copied") + " " + nodeLabel(sel));
    } else if (r.act === "paste") {
      dupNode(r.payload, 40 * _kbPasteN, 40 * _kbPasteN, t("canvas.node.pasted")); // dupNode 链路：深拷+落地+renderAll+persist+hist
      _kbPasteN += 1;
    } else if (r.act === "del") {
      deleteNodeArm(sel); // 两次确认臂共用（首按提示·3 秒内再按真删）
    } else if (r.act === "delDenied") {
      showToast("info", t("canvas.node.gNoDel"));
    } else if (r.act === "undo") {
      histGo(-1);
    } else if (r.act === "redo") {
      histGo(1);
    }
  };
  document.addEventListener("keydown", _kbHandler);
}

function unbindHotkeys() {
  if (_kbHandler) {
    if (typeof document !== "undefined") document.removeEventListener("keydown", _kbHandler);
    _kbHandler = null;
  }
  _kbClip = null; // 切视图即弃剪贴板（根绝跨项目误粘）
  _kbPasteN = 0;
}

// ===== 空白右键菜单（E012：复位视图 / 添加节点） =====
// 批 R8 · R7-2：字符前缀 → data-ic（v43 :2069-2079：refresh/plus/image/film/film/play · 14px）
function showBlankMenu(e) {
  if (!S || !S.menuEl) return;
  const items = [
    { icon: "refresh", label: t("canvas.resetView"), act: () => { resetViewport(); hideMenu(); } },
    { sep: true },
    { icon: "plus", label: t("canvas.menu.nSeg"), act: () => { addNodeByMenu("seg"); hideMenu(); } },
    { icon: "image", label: t("canvas.menu.nAsset"), act: () => { addNodeByMenu("asset"); hideMenu(); } },
    { icon: "film", label: t("canvas.menu.nInterp"), act: () => { addNodeByMenu("interp"); hideMenu(); } },
    { icon: "film", label: t("canvas.menu.nSr"), act: () => { addNodeByMenu("sr"); hideMenu(); } },
    { icon: "play", label: t("canvas.menu.nPreview"), act: () => { addNodeByMenu("preview"); hideMenu(); } },
  ];
  renderMenu(items);
  const m = S.menuEl;
  m.style.display = "block";
  const [mx, my] = clampMenuXY(e.clientX, e.clientY, window.innerWidth, window.innerHeight, m.offsetWidth, m.offsetHeight);
  m.style.left = mx + "px";
  m.style.top = my + "px";
}

// F-B3 终解（三审裁决修复）：nextIdOf 下沉 core/canvas.js 纯函数（[0-9] 写法·带回归测试）——
//   本视图删本地实现；nextSegIdOf 委托之（消除双套段 id 生成并存·三审风格级项一并清）
function nextSegIdOf(nodes) {
  return nextIdOf(nodes, "S");
}
// F-B1 助手：本会话自写段卡 → 记抑制标记（订阅回声窗 300ms 内跳过该 segmentId）
function markSegSelfWrite(segmentId) {
  if (S) S._segSelfWrite = { segmentId, ts: Date.now() };
}
function addNodeByMenu(type) {
  if (!S) return;
  // 以画布当前中心世界坐标为摆位起点
  const r = S.cbRoot.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const w = clientToWorldLocal(r.left + cx, r.top + cy);
  let x = w.x, y = w.y;
  // ID 生成：按存量节点取最大数字后缀+1（修正笔：procSeq 会话态重挂归零致 ID 重复·边解析错乱）
  if (type === "seg") {
    // 战役批2-T3 · F-83：绑定态不再自造节点，改走 addSegment 借 B 向对账代建
    //   （store 同步 notify → segment:add 分支按 segId 代建 seg 节点·自带 G 边与段号标签）。
    //   零抑制零重复：抑制标记（markSegSelfWrite 按 segmentId 匹配）在这条路径上永远设不进去
    //   ——新段 id 是 addSegment 内部 uuid() 生成的，notify 早于返回；故不复用它，
    //   直接按 segId 精确配对返回的段卡定位代建节点，摆位到菜单点击坐标 + 改标签。
    //   未绑定态保留原 push + toast：addSegment(null) 会抛 TypeError（store.js project.segments.push）。
    const p = S.projectId ? storeLoad(S.projectId) : null;
    if (p && Array.isArray(p.segments)) {
      const seg = addSegment(p);   // 同步 notify → 对账代建在返回前完成
      const born = S.canvas.nodes.find((n) => n.type === "seg" && n.data && n.data.segId === seg.id);
      if (born) {
        born.x = x + 60;
        born.y = y + 30;
        born.label = "段" + born.data.n;
      }
      storeSave(p); // addSegment 只改内存（store 语义：调用方负责落盘）
    } else {
      // 段节点 id 用 max(S\d+)+1，但段号 n 取 max(data.n)+1（与段卡编号解耦）
      const newId = nextIdOf(S.canvas.nodes, "S");
      const newN = S.canvas.nodes.filter((n) => n.type === "seg").reduce((m, n) => Math.max(m, (n.data && n.data.n) || 0), 0) + 1;
      S.canvas.nodes.push({ id: newId, type: "seg", label: "段" + newN, x: x + 60, y: y + 30, data: { n: newN, badge: "中段", badgeCls: "b-mid", status: "wait", prompt: "", dur: 5 } });
      S.canvas.edges.push({ from: "G", to: newId });
      showToast("info", t("canvas.add.seg"));
    }
  } else if (type === "asset") {
    const maxN = S.canvas.nodes.filter((n) => n.type === "asset").reduce((m, n) => Math.max(m, (n.data && n.data.n) || 0), 0);
    const newN = maxN + 1;
    const newId = nextIdOf(S.canvas.nodes, "A");
    S.canvas.nodes.push({ id: newId, type: "asset", label: "新素材", x: x + 30, y: y + 30, data: { n: newN, name: "新素材", kind: "prop" } });
    showToast("info", t("canvas.add.asset", { n: newN }));
  } else if (type === "interp" || type === "sr") {
    const sub = type;
    const id = nextIdOf(S.canvas.nodes, sub === "sr" ? "PS" : "PI");
    const data = { sub };
    if (sub === "sr") data.mode = "quick";
    S.canvas.nodes.push({ id, type: "proc", label: sub === "sr" ? "超分" : "插帧", x: x + 30, y: y + 30, data });
    showToast("info", t("canvas.add.proc", { kind: sub === "sr" ? t("canvas.add.procSr") : t("canvas.add.procInterp") }));
  } else if (type === "preview") {
    const id = nextIdOf(S.canvas.nodes, "PV");
    S.canvas.nodes.push({ id, type: "preview", label: "预览", x: x + 30, y: y + 30, data: {} });
    showToast("info", t("canvas.add.preview"));
  }
  renderAll();
  persistCanvas();
  pushHist();
}

// ===== 节点右键菜单（E012/E029） =====
// 批 R8 · R7-2：字符前缀 → data-ic（v43 :5106-5151 逐项对照；✦ 后续单实装项原型亦无图标）
function showNodeMenu(e, n) {
  if (!S || !S.menuEl) return;
  const items = [];
  if (n.type === "global") {
    items.push({ icon: "chev", label: n.data && n.data.expanded ? t("canvas.menu.collapseFull") : t("canvas.menu.expandFull"), act: () => { n.data.expanded = !n.data.expanded; renderNodeById(n.id); persistCanvas(); } });
    items.push({ icon: "pencil", label: t("canvas.menu.editGp"), act: () => {
      const ta = S.cbNodes.querySelector('[data-id="G"] textarea.gp');
      if (ta) { ta.focus(); ta.select(); }
    } });
  } else if (n.type === "seg") {
    items.push({ icon: "sliders", label: t("canvas.menu.editSeg"), act: () => onNodeDblClick(n) });
    items.push({ icon: "play", label: t("canvas.menu.addPreview"), act: () => addPreviewToSeg(n) });
    // R-36：seg 禁复制（A11——复制体共享 data.segId，删除复制体真删段卡是数据破坏隐患·热键同禁）
    items.push({ sep: true });
    items.push({ icon: "refresh", label: t("canvas.menu.rerunSeg"), act: () => { showToast("info", t("canvas.menu.rerunToast")); } });
    items.push({ sep: true });
    items.push({ icon: "trash", label: t("canvas.menu.delSeg"), danger: true, act: () => deleteNodeArm(n) });
  } else if (n.type === "asset") {
    items.push({ icon: "pencil", label: t("canvas.menu.editAsset"), act: () => { showToast("info", t("canvas.menu.editAssetToast")); } });
    items.push({ icon: "copy", label: t("canvas.menu.copyNode"), act: () => dupNode(n) });
    items.push({ sep: true });
    items.push({ icon: "trash", label: t("canvas.menu.delNode"), danger: true, act: () => deleteNodeArm(n) });
  } else if (n.type === "proc") {
    items.push({ icon: "link", label: t("canvas.menu.connSegProc"), act: () => showConnectSegMenu(n) });
    items.push({ icon: "copy", label: t("canvas.menu.copyNode"), act: () => dupNode(n) });
    if (S.canvas.edges.some((e) => e.to === n.id)) {
      items.push({ sep: true });
      items.push({ icon: "x", label: t("canvas.menu.disconnAll"), act: () => disconnAll(n) });
    }
    items.push({ sep: true });
    items.push({ icon: "trash", label: t("canvas.menu.delNode"), danger: true, act: () => deleteNodeArm(n) });
  } else if (n.type === "preview") {
    items.push({ icon: "play", label: t("canvas.menu.playStop"), act: () => previewToggle(n.id) });
    items.push({ icon: "expand", label: t("canvas.menu.maximize"), act: () => previewMaximize(n.id) });
    items.push({ icon: "copy", label: t("canvas.menu.copyNode"), act: () => dupNode(n) });
    if (!S.canvas.edges.some((e) => e.to === n.id)) {
      items.push({ icon: "link", label: t("canvas.menu.connSegPreview"), act: () => showConnectSegMenu(n) });
    }
    items.push({ sep: true });
    items.push({ icon: "trash", label: t("canvas.menu.delNode"), danger: true, act: () => deleteNodeArm(n) });
  }
  renderMenu(items);
  const m = S.menuEl;
  m.style.display = "block";
  const [mx, my] = clampMenuXY(e.clientX, e.clientY, window.innerWidth, window.innerHeight, m.offsetWidth, m.offsetHeight);
  m.style.left = mx + "px";
  m.style.top = my + "px";
}

function renderMenu(items) {
  const m = S.menuEl;
  while (m.firstChild) m.removeChild(m.firstChild);
  items.forEach((it) => {
    if (it.sep) {
      m.appendChild(el("div", { class: "ctx-sep" }));
      return;
    }
    const it1 = el("div", { class: "ctx-item" + (it.danger ? " danger" : "") });
    // 批 R8 · R7-2：菜单图标 data-ic（14px · v43 :5106-5151）
    if (it.icon) it1.appendChild(el("span", { "data-ic": it.icon, "data-sz": "14" }));
    it1.appendChild(document.createTextNode(it.label));
    it1.addEventListener("click", (e) => {
      e.stopPropagation();
      try { it.act && it.act(); } catch (_e) { /* swallow */ }
    });
    m.appendChild(it1);
  });
  hydrateIcons(m); // 批 R8 · R7-2：菜单项 data-ic → svg（幂等）
}

function onNodeDblClick(n) {
  if (!S || !S.projectId) {
    showToast("info", t("canvas.noProject"));
    return;
  }
  if (n.type === "seg") {
    // 跳设定页 + 滚动定位到对应段卡（v43 CBDblClick 等价·走查反馈⑥：定位由 setup 消费锚点）
    if (n.data && n.data.segId) {
      try { sessionStorage.setItem("gui13.gotoSeg", String(n.data.segId)); } catch (_e) { /* 隐私模式 */ }
    }
    showToast("info", t("canvas.seg.gotoSetup", { n: n.data && n.data.n }));
    window.location.hash = `#/project/${encodeURIComponent(S.projectId)}?tab=setup`;
  } else if (n.type === "asset") {
    showToast("info", t("canvas.asset.goto", { n: n.data && n.data.n }));
    window.location.hash = "#/assets";
  }
}

function addPreviewToSeg(segNode) {
  const id = nextIdOf(S.canvas.nodes, "PV"); // F-B3（B 审修正笔）：计数式 ID 删除后撞车——统一走最大后缀+1
  S.canvas.nodes.push({ id, type: "preview", label: "预览", x: (segNode.x || 0) + 260, y: (segNode.y || 0), data: {} });
  S.canvas.edges.push({ from: segNode.id, to: id });
  renderAll();
  persistCanvas();
  pushHist();
  showToast("info", t("canvas.preview.addedSeg", { n: segNode.data && segNode.data.n }));
}

// 复制落地链路（右键菜单 / R-36 Ctrl+V 粘贴共用）：深拷+偏移落地+renderAll+persist+hist
//   dx/dy 缺省 +40/+40（右键现状）；verb 缺省取词（粘贴路径传入已取词动词·#92 B2）
function dupNode(n, dx = 40, dy = 40, verb) {
  const newId = n.id + "c" + Math.random().toString(36).slice(2, 6);
  const clone = JSON.parse(JSON.stringify(n));
  clone.id = newId;
  clone.x = (n.x || 0) + dx;
  clone.y = (n.y || 0) + dy;
  clone.data = JSON.parse(JSON.stringify(n.data || {}));
  S.canvas.nodes.push(clone);
  renderAll();
  persistCanvas();
  pushHist();
  showToast("info", (verb || t("canvas.node.copied")) + " " + nodeLabel(n));
}

function showConnectSegMenu(node) {
  const segs = S.canvas.nodes.filter((x) => x.type === "seg");
  if (!segs.length) { showToast("info", t("canvas.conn.noSegs")); return; }
  if (node.type === "preview" && S.canvas.edges.some((e) => e.to === node.id)) {
    showToast("info", t("canvas.conn.pvBusy"));
    return;
  }
  const menu = el("div", { class: "cbox-menu", id: "cbSegLinkMenu" });
  menu.style.cssText = "position:fixed;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;z-index:121;min-width:160px;box-shadow:0 8px 24px #000a;font-size:12px";
  segs.forEach((s) => {
    const connected = S.canvas.edges.some((e) => e.from === s.id && e.to === node.id);
    const item = el("div", { class: "co", text: node.type === "preview"
      ? t("canvas.conn.menuSegPrev", { mark: connected ? "✓ " : "  ", n: s.data && s.data.n })
      : t("canvas.conn.menuSegTo", { mark: connected ? "✓ " : "  ", n: s.data && s.data.n }) });
    item.style.cssText = "padding:6px 10px;border-radius:8px;cursor:" + (connected ? "default" : "pointer") + ";opacity:" + (connected ? "0.5" : "1") + ";color:var(--txt2)";
    if (!connected) {
      item.addEventListener("click", () => {
        // 单输入约束
        if ((node.type === "proc" || node.type === "preview") && S.canvas.edges.some((e) => e.to === node.id)) {
          showToast("info", t("canvas.conn.hasInputShort"));
          closeMenu();
          return;
        }
        S.canvas.edges.push({ from: s.id, to: node.id });
        if (node.type === "proc") syncProcCardFromSeg(s, node, true);
        closeMenu();
        renderAll();
        persistCanvas();
        pushHist();
        showToast("info", t("canvas.conn.linkedSeg", { n: s.data && s.data.n, kind: node.type === "preview" ? t("canvas.node.preview") : ((node.data && node.data.sub) === "sr" ? t("edit.segedit.chipUpscale") : t("edit.segedit.chipInterp")) }));
      });
    }
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  // 定位贴近 cbMenu —— F37：经 anchor helper 锚定 cbMenu 右侧（绑定即定位一次·滚动/resize 跟随·旧实现只算一次）
  let anchorH = null;
  if (S.menuEl && S.menuEl.style.display === "block") {
    anchorH = followAnchor(S.menuEl, menu, { side: "right", gap: 4 });
  } else {
    menu.style.left = "100px";
    menu.style.top = "100px";
  }
  // F37：统一关闭口（注销锚定监听 + 移除菜单）
  const closeMenu = () => {
    if (anchorH) anchorH.detach();
    if (document.body.contains(menu)) document.body.removeChild(menu);
  };
  setTimeout(() => {
    // F72：判 mousedown（按下点）非 click——按下在菜单项、松开在外时 click 落共同祖先误判外点
    const off = (ev) => {
      if (!ev.target.closest("#cbSegLinkMenu")) {
        closeMenu();
        document.removeEventListener("mousedown", off);
      }
    };
    document.addEventListener("mousedown", off);
  }, 0);
}

function disconnAll(procN) {
  const upSegs = S.canvas.edges.filter((e) => e.to === procN.id && /^S\d+$/.test(e.from)).map((e) => e.from);
  const before = S.canvas.edges.length;
  S.canvas.edges = S.canvas.edges.filter((e) => e.from !== procN.id && e.to !== procN.id);
  const removed = before - S.canvas.edges.length;
  upSegs.forEach((segId) => {
    const segN = S.canvas.nodes.find((x) => x.id === segId);
    if (segN) syncProcCardFromSeg(segN, procN, false);
  });
  renderAll();
  persistCanvas();
  pushHist();
  showToast("info", t("canvas.conn.disconnAllDone", { n: removed }));
}

// ===== 删除两次确认（E012·3 秒窗） =====
function deleteNodeArm(n) {
  // asset 节点：被任何提示词引用 → 阻断
  if (n.type === "asset") {
    const refSegs = [];
    S.canvas.edges.forEach((e) => {
      if (e.to === n.id && /^S\d+$/.test(e.from)) refSegs.push(t("canvas.seg.tag", { n: e.from.slice(1) }));
    });
    const usedByGlobal = S.canvas.edges.some((e) => e.from === "G" && e.to === n.id);
    if (refSegs.length || usedByGlobal) {
      const who = refSegs.length ? refSegs.join("、") : t("canvas.wire.globalPrompt");
      showToast("info", t("canvas.asset.stillRef", { who, n: n.data && n.data.n }));
      return;
    }
  }
  const now = Date.now();
  if (_delArm.id === n.id && now - _delArm.ts < DEL_ARM_MS) {
    _delArm = { id: null, ts: 0 };
    actuallyDeleteNode(n);
  } else {
    _delArm = { id: n.id, ts: now };
    showToast("info", t("canvas.node.delArm", { name: nodeLabel(n) }));
    setTimeout(() => {
      if (_delArm.id === n.id && Date.now() - _delArm.ts >= 2900) {
        _delArm = { id: null, ts: 0 };
      }
    }, 3100);
  }
}

function actuallyDeleteNode(n) {
  // 段节点删除：联动 store.segments 删除（单源）——F-B2 复核②清偿：
  //   按位映射 S<序号>→segments[idx-1] 在中间删段后误删他段段卡（数据丢失）——改 data.segId 唯一键，旧档按序兜底
  if (n.type === "seg" && S.projectId) {
    const p = storeLoad(S.projectId);
    let segId = n.data && n.data.segId;
    if (!segId && p && p.segments) {
      const idx = parseInt(String(n.id).replace(/^S/, ""), 10);
      const byIdx = Number.isInteger(idx) ? p.segments[idx - 1] : null;
      if (byIdx) segId = byIdx.id;
    }
    if (p && segId && p.segments.some((sg) => sg.id === segId)) {
      markSegSelfWrite(segId); // F-B1：抑制订阅回声（segment:remove 对账分支不再重复执行）
      storeRemoveSegment(p, segId);
      storeSave(p); // removeSegment 只改内存（store 语义）——漏 save 致画布删段不落 store
    }
  }
  // proc 节点：先解相关段卡勾选
  if (n.type === "proc") {
    const connSegIds = S.canvas.edges.filter((e) => e.to === n.id).map((e) => e.from);
    connSegIds.forEach((segId) => {
      const segN = S.canvas.nodes.find((x) => x.id === segId);
      if (segN) syncProcCardFromSeg(segN, n, false);
    });
  }
  S.canvas.nodes = S.canvas.nodes.filter((x) => x.id !== n.id);
  S.canvas.edges = S.canvas.edges.filter((e) => e.from !== n.id && e.to !== n.id);
  renderAll();
  persistCanvas();
  pushHist();
  showToast("info", t("canvas.node.deleted", { name: nodeLabel(n) }) + (n.type === "seg" ? t("canvas.node.deletedSegTail") : ""));
}

// ===== 顶条按钮分发（E020/E021/E022/E023/E024/E025） =====
function topbarAct(act) {
  if (act === "new") newConfirm();
  else if (act === "undo") histGo(-1);
  else if (act === "redo") histGo(1);
  else if (act === "reset") resetConfirm();
  else if (act === "save") saveProject();
  else if (act === "run") runProject();
  else if (act === "bgen") openBgGenDialog(); // B7-T4：生成背景图（两步异步）
}

// ===== 生成背景图（B7-T4 · v43 #cvgen :2346 形）=====
// 两步异步：提交描述 → 渲染中可关闭弹层 → 完成自动应用 = 画布背景层（editingState.canvas.background）。
// 引擎 #47/#48 scene_canvas / #53/#54 item_canvas · text 模式起步（D4 最小口径）。
function openBgGenDialog() {
  if (!S) return;
  const wrap = el("div", { class: "cfg" });

  // 生成类型（场景图 = #47 scene_canvas / 道具图 = #53 item_canvas）
  const sel = el("select", { class: "selx", style: "flex:1", title: t("canvas.bg.typeT") });
  sel.appendChild(el("option", { value: "scene", text: t("canvas.bg.scene") }));
  sel.appendChild(el("option", { value: "item", text: t("canvas.bg.item") }));
  wrap.appendChild(el("div", { class: "row" }, [el("span", { class: "k", text: t("canvas.bg.kind") }), sel]));

  // 批 10 T4：来源资产卡（可选）——空 = 现状文字法；选卡 = 整卡模式（引擎读卡图+描述词+忽略词）
  const cardSel = el("select", { class: "selx bgcard-sel", style: "flex:1", title: t("canvas.bg.cardT") });
  wrap.appendChild(el("div", { class: "row" }, [el("span", { class: "k", text: t("canvas.bg.cardLabel") }), cardSel]));

  // 卡下拉过滤（方案 §六.4）：场景=kind scene；道具=character 且含 subject_prop/道具多角度 行
  //   （引擎契约：道具卡是 character 卡 + 道具行）。切生成类型重建，选中回空。
  let cardNames = { scene: [], item: [] };
  function rebuildCardSel() {
    const kind = sel.value === "item" ? "item" : "scene";
    cardSel.innerHTML = "";
    cardSel.appendChild(el("option", { value: "", text: t("canvas.bg.noCard") }));
    for (const name of cardNames[kind]) cardSel.appendChild(el("option", { value: name, text: name }));
  }
  rebuildCardSel();
  sel.addEventListener("change", rebuildCardSel);
  listAssets().then((r) => {
    if (!r || !r.ok) return;
    const scene = [];
    const item = [];
    for (const [name, card] of Object.entries(r.assets || {})) {
      const c = card || {};
      if (c.kind === "scene") { scene.push(name); continue; }
      if (c.kind !== "character") continue;
      const rows = Array.isArray(c.rows) ? c.rows : [];
      if (rows.some((row) => row && (row.usage === "subject_prop" || row.usage === "道具多角度"))) item.push(name);
    }
    cardNames = { scene, item };
    rebuildCardSel();
  });

  // 描述（text 模式必填）
  const ta = el("textarea", {
    rows: "3",
    placeholder: t("canvas.bg.descPh"),
    style: "width:100%;margin-top:8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);font-size:12px;padding:8px;resize:vertical;outline:none;font-family:inherit;box-sizing:border-box",
  });
  wrap.appendChild(ta);

  // 渲染中行（v43 #cvgenSt）+ 错误行（失败红字）
  const stLine = el("div", { class: "pfline cvgen-st", text: t("canvas.bg.rendering") });
  stLine.style.marginTop = "8px";
  stLine.style.display = "none";
  wrap.appendChild(stLine);
  const errLine = el("div", { class: "cvgen-err" });
  errLine.style.marginTop = "8px";
  errLine.style.color = "#e5484d";
  errLine.style.fontSize = "12px";
  errLine.style.display = "none";
  wrap.appendChild(errLine);

  const closeBtn = el("button", { type: "button", class: "ghostbtn", text: t("edit.common.close") });
  const goBtn = el("button", { type: "button", class: "prim", text: t("canvas.bg.go") });
  const inst = openModal({
    title: t("canvas.bg.title"),
    sub: t("canvas.bg.sub"),
    contentNode: wrap,
    footerButtons: [closeBtn, goBtn],
  });
  closeBtn.addEventListener("click", () => inst.close());

  const projectId = S.projectId;
  let polling = false; // 本弹窗防重复提交（弹层关闭后轮询仍续）
  goBtn.addEventListener("click", async () => {
    if (polling) return;
    errLine.style.display = "none";
    errLine.textContent = "";
    const kind = sel.value === "item" ? "item" : "scene";
    const desc = (typeof ta.value === "string" ? ta.value : "").trim();
    const cardName = String(cardSel.value || "");
    // 未选卡 = 文字法（描述必填）；选卡 = 整卡模式（描述仅作 prompt_extra·可留空）
    if (!cardName && !desc) {
      errLine.textContent = t("canvas.bg.needDesc");
      errLine.style.display = "block";
      return;
    }
    // 批 10 T4：选卡 → 整卡模式（writeback:false 只出图不写卡）；未选卡 → 旧 text 法逐键不变
    const r = await (kind === "item" ? submitItemCanvas : submitSceneCanvas)(
      cardName
        ? { cardName, promptExtra: desc, writeback: false }
        : { text: buildPromptText(resolveTemplate(kind === "item" ? "prop" : "scene"), desc) }
    );
    if (!r.ok || !r.taskId) {
      errLine.textContent = t("canvas.bg.submitFail", { msg: (r.error && (r.error.msg || r.error.code)) || t("canvas.bg.busy") });
      errLine.style.display = "block";
      return;
    }
    // 两步异步第二步：渲染中可关闭弹层，完成自动应用
    stLine.style.display = "block";
    goBtn.style.opacity = "0.45";
    polling = true;
    pollBgGen(r.taskId, kind, projectId, {
      onDone: (media) => {
        applyBackgroundFromPoll(projectId, media, kind);
        inst.close();
        showToast("success", t("canvas.bg.done"));
      },
      onFail: (msg) => {
        stLine.style.display = "none";
        goBtn.style.opacity = "";
        polling = false;
        errLine.textContent = msg;
        errLine.style.display = "block";
        showToast("error", t("canvas.bg.fail", { msg }));
      },
    });
  });
}

// 轮询收口（3s · 墙钟 10min 绝对截止 · setTimeout 链 unref——candidates.pollCandidateRuns 同款，
// Node 单测轮询定时器不吊测试进程）。首查立即；started/rendering 续轮；done/failed/interrupted 终态。
// 批 9 T4（18-20）：连续 3 次 400/网络错误提前终态（此前 st.ok=false 静默续轮至墙钟）；
//   成功一拍即清零——间歇抖动恢复不误杀；opts.intervalMs 注入位 = pollCandidateRuns 同款。
const BG_POLL_MS = 3000;
const BG_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const BG_POLL_MAX_ERRS = 3;
export function pollBgGen(taskId, kind, projectId, cb, opts = {}) {
  const intervalMs = (typeof opts.intervalMs === "number" && opts.intervalMs > 0) ? opts.intervalMs : BG_POLL_MS;
  let timer = null;
  let stopped = false;
  let errStreak = 0;
  const startedAtMs = Date.now();
  function stop() {
    stopped = true;
    if (timer != null) { clearTimeout(timer); timer = null; }
  }
  async function tick() {
    if (stopped) return;
    if (Date.now() - startedAtMs >= BG_POLL_TIMEOUT_MS) {
      stop();
      cb.onFail(t("canvas.bg.timeout"));
      return;
    }
    const st = await (kind === "item" ? itemCanvasStatus(taskId) : sceneCanvasStatus(taskId));
    if (stopped) return;
    if (st.ok) {
      errStreak = 0;
      if (st.status === "done" && st.resultPngPath) {
        stop();
        cb.onDone(st.resultPngPath);
        return;
      }
      if (st.status === "failed" || st.status === "interrupted") {
        stop();
        cb.onFail(t("canvas.bg.genResult", {
          st: st.status === "failed" ? pickDisplay("status", "失败") : t("canvas.bg.interrupted"),
          msg: st.error || t("canvas.bg.seeLog"),
        }));
        return;
      }
      // started / rendering → 续轮
    } else {
      // 400 / 网络错误 → 计连败；连续 3 次提前终态（不再静默至墙钟）
      errStreak++;
      if (errStreak >= BG_POLL_MAX_ERRS) {
        stop();
        const why = (st.error && (st.error.msg || st.error.code)) || t("canvas.bg.unreachable");
        cb.onFail(t("canvas.bg.pollFail", { n: BG_POLL_MAX_ERRS, why }));
        return;
      }
    }
    // 网络抖动/读取失败（连败未达阈值）→ 静默重试
    timer = setTimeout(tick, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  tick();
  return stop;
}

// 完成自动应用：画布在位 → 单源通道写背景并渲染；视图已切走 → 直接落 store（updateEditingState 按 projectId 白名单，不扰当前视图）
function applyBackgroundFromPoll(projectId, media, kind) {
  if (S && S.projectId === projectId && S.canvas) {
    S.canvas.background = { media, kind, ts: Date.now() };
    persistCanvas();
    renderBackground();
    return;
  }
  const p = storeLoad(projectId);
  if (!p || !p.editingState || !p.editingState.canvas) return;
  p.editingState.canvas.background = { media, kind, ts: Date.now() };
  updateEditingState(projectId, { canvas: p.editingState.canvas });
}

function newConfirm() {
  const now = Date.now();
  if (now - _newArm.ts < ARM_WINDOW_MS) {
    _newArm = { ts: 0 };
    resetToEmpty();
  } else {
    _newArm = { ts: now };
    showToast("info", t("canvas.confirm.new"));
    setTimeout(() => { if (_newArm.ts && Date.now() - _newArm.ts >= 2900) _newArm = { ts: 0 }; }, 3100);
  }
}

function resetToEmpty() {
  // E021：仅含全局参数节点（CBResetToEmpty 等价）
  S.canvas.nodes = [{ id: "G", type: "global", label: "全局参数", x: 40, y: 60, data: { expanded: false, prompt: "" } }];
  S.canvas.edges = [];
  S.canvas.projectName = "";
  S.canvas.viewport = { tx: 0, ty: 0, scale: 1 };
  S.canvas.hist = { base: null, stack: [], idx: -1, lock: false };
  S.title = "";
  S.previewStates = {};
  S.procSeq = { interp: 0, sr: 0 };
  applyViewport();
  renderTitle();
  renderAll();
  persistCanvas();
  S.canvas.hist.base = canvasSnapOf({ nodes: S.canvas.nodes, edges: S.canvas.edges, projectName: "" });
  pushHist({ silent: true });
  refreshHistUi();
  showToast("info", t("canvas.confirm.resetEmptyDone"));
}

function resetConfirm() {
  const now = Date.now();
  if (now - _rstArm.ts < ARM_WINDOW_MS) {
    _rstArm = { ts: 0 };
    resetGo();
  } else {
    _rstArm = { ts: now };
    showToast("info", t("canvas.confirm.reset"));
    setTimeout(() => { if (_rstArm.ts && Date.now() - _rstArm.ts >= 2900) _rstArm = { ts: 0 }; }, 3100);
  }
}

function resetGo() {
  S.canvas.hist.stack = []; S.canvas.hist.idx = -1;
  const snap = S.canvas.hist.base || canvasSnapOf({
    nodes: S.canvas.nodes, edges: S.canvas.edges, projectName: S.canvas.projectName || "",
  });
  // 应用 base 快照
  S.canvas.nodes = snap.nodes.map((n) => ({ ...n, data: JSON.parse(JSON.stringify(n.data || {})) }));
  S.canvas.edges = snap.edges.map((e) => ({ from: e.from, to: e.to }));
  S.canvas.projectName = snap.projectName || "";
  S.title = S.canvas.projectName || "";
  applyViewport();
  renderTitle();
  renderAll();
  persistCanvas();
  S.canvas.hist.stack = [canvasSnapOf({ nodes: S.canvas.nodes, edges: S.canvas.edges, projectName: S.canvas.projectName })];
  S.canvas.hist.idx = 0;
  refreshHistUi();
  showToast("info", t("canvas.confirm.resetDone"));
}

// ===== 历史 30 步 (E020/E022) =====
function pushHist(opts = {}) {
  const silent = opts.silent === true;
  if (!S || !S.canvas || !S.canvas.hist) return;
  if (S.canvas.hist.lock) return;
  const snap = canvasSnapOf({
    nodes: S.canvas.nodes, edges: S.canvas.edges, projectName: S.canvas.projectName || "",
  });
  const r = coreHistPush(S.canvas.hist, snap);
  S.canvas.hist = r.hist;
  refreshHistUi();
  if (!silent) persistCanvas();
}

function histGo(dir) {
  if (!S || !S.canvas || !S.canvas.hist) return;
  const r = coreHistGo(S.canvas.hist, dir);
  if (r.atStart) {
    showToast("info", t("canvas.hist.atStart"));
    refreshHistUi();
    return;
  }
  if (r.atEnd) {
    showToast("info", t("canvas.hist.atEnd"));
    refreshHistUi();
    return;
  }
  // 应用快照（lock 防同帧 push 递归）
  S.canvas.hist = r.hist;
  // J-P8：lock 是「同帧防递归」瞬态护栏，不是历史语义的一部分——栈随项目 JSON 落盘后
  //   它会被一并存下并在重挂载时还原（pushHist 见 lock 直接 return），致「回退一次后
  //   本会话再编辑永不入栈」的永久死栈。此处显式复位（快照已应用完毕·同帧递归已过）。
  S.canvas.hist.lock = false;
  S.canvas.nodes = r.snap.nodes.map((n) => ({ ...n, data: JSON.parse(JSON.stringify(n.data || {})) }));
  S.canvas.edges = r.snap.edges.map((e) => ({ from: e.from, to: e.to }));
  S.canvas.projectName = r.snap.projectName || "";
  S.title = S.canvas.projectName || "";
  applyViewport();
  renderTitle();
  renderAll();
  refreshHistUi();
  persistCanvas();
  showToast("info", dir < 0 ? t("canvas.hist.undone") : t("canvas.hist.redone"));
}

function refreshHistUi() {
  if (!S || !S.canvas || !S.canvas.hist) return;
  const h = S.canvas.hist;
  if (S.undoBtn) S.undoBtn.classList.toggle("dim", h.idx <= 0);
  if (S.redoBtn) S.redoBtn.classList.toggle("dim", h.idx >= h.stack.length - 1);
}

// ===== 批9 G4a④（批6 G1 遗留）：「已创建项目」toast 时序（portal/projects 同形实现·§三.2）=====
//   旧形态：storeSave 后立即预弹成功 toast——save 是 fire-and-forget，总表写失败时成功/失败双弹且
//   成功在先。新形态：提交时挂起登记，store 的总表写落定事件（store:index-write-settled）ok=true
//   才弹；失败不弹成功（store 已按 code 弹准确失败档）。按仓惯例（views 互不交叉依赖）各自持有；
//   画布两条建项目链文案/档位不同 → type+text 参数化（机制与 portal/projects 逐字同形）。
const _createdPending = new Map();   // id → onSettled（连建多项目各占一槽·settled 按 id 消费）
export function armCreatedToast(id, type, text) {
  if (typeof document === "undefined" || !document || typeof document.addEventListener !== "function") return;
  disarmCreatedToast(id);
  const onSettled = (ev) => {
    const d = (ev && ev.detail) || {};
    if (String(d.id || "") !== String(id)) return;   // 只认本次新建的项目
    disarmCreatedToast(id);
    if (d.ok) showToast(type, text);
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

// ===== 保存（E024） =====
function saveProject() {
  if (!S || !S.projectId) {
    // 无项目 = 空项目态 → 弹命名弹窗 → createProject
    openNameModal("save", (name) => {
      const p = createProject(name);
      armCreatedToast(p.id, "success", t("canvas.save.created", { name }));   // G4a④：挂总表写落定后弹（失败不弹成功）
      storeSave(p);
      S.projectId = p.id;
      S.canvas.projectName = name;
      S.title = name;
      renderTitle();
      pushHist();
      persistCanvas();
      // 批 10-L L1-7：草稿升格为真项目（保存/运行两条建项目路径）→ 清草稿键，不留孤儿
      clearCanvasDraft();
      // 跳到项目页（setup TAB）
      window.location.hash = `#/project/${encodeURIComponent(p.id)}?tab=setup`;
    });
    return;
  }
  // 有项目：二选一弹窗
  openSaveModal((choice) => {
    const p = storeLoad(S.projectId);
    if (!p) return;
    if (choice === "overwrite") {
      // 当前画布态 = canvas 字段同步落 store
      S.canvas.projectName = p.name || S.title || "";
      persistCanvas();
      showToast("success", t("canvas.save.overwritten", { name: p.name }));
    } else if (choice === "saveas") {
      openNameModal("save", (name) => {
        const np = createProject(name);
        // 复制当前画布态（含 nodes/edges/viewport/hist）
        np.editingState.canvas = JSON.parse(JSON.stringify(S.canvas));
        np.editingState.canvas.projectName = name;
        storeSave(np);
        S.projectId = np.id;
        S.title = name;
        renderTitle();
        showToast("success", t("canvas.save.savedAs", { name }));
      });
    }
  });
}

function openSaveModal(onPick) {
  const wrap = el("div", { class: "mbox-wrap", style: "position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:140" });
  const box = el("div", { class: "mbox" });
  // 批 R8 · D22：title/sub 按原型 svmodal（v43 :1977-1978）——项目名落 sub
  box.appendChild(el("h3", { text: t("canvas.save.title") }));
  box.appendChild(el("div", { class: "sub", text: t("canvas.save.sub", { name: S.title || t("canvas.save.unnamed") }) }));
  const foot = el("div", { class: "foot" });
  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const overBtn = el("button", { type: "button", class: "prim", text: t("canvas.save.overwrite") });
  const asBtn = el("button", { type: "button", class: "prim", text: t("canvas.save.saveas") });
  foot.appendChild(cancelBtn);
  foot.appendChild(asBtn);
  foot.appendChild(overBtn);
  box.appendChild(foot);
  wrap.appendChild(box);
  cancelBtn.addEventListener("click", () => document.body.removeChild(wrap));
  overBtn.addEventListener("click", () => { document.body.removeChild(wrap); onPick("overwrite"); });
  asBtn.addEventListener("click", () => { document.body.removeChild(wrap); onPick("saveas"); });
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) document.body.removeChild(wrap); }); // F72：点遮罩关·判按下点（click 落共同祖先会误判外点）
  document.body.appendChild(wrap);
}

// 批 R8 · D21：命名弹窗 run/save 双模态文案（v43 :1953-1981 动态 title/sub/ok；GUI 保存为真实建项 → save sub 去原型「（演示）」尾注）
// #92 B2：字面量改键名（弹窗打开=事件路径取词·§4.9 非顶层求值）
const NAME_MODAL_TEXT = {
  save: {
    titleKey: "canvas.nameModal.saveTitle",
    subKey: "canvas.nameModal.saveSub",
    okKey: "settings.btn.save",
  },
  run: {
    titleKey: "canvas.nameModal.runTitle",
    subKey: "canvas.nameModal.runSub",
    okKey: "canvas.nameModal.runOk",
  },
};

function openNameModal(mode, onConfirm) {
  const txt = NAME_MODAL_TEXT[mode === "run" ? "run" : "save"];
  const wrap = el("div", { class: "mbox-wrap", style: "position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:140" });
  const box = el("div", { class: "mbox" });
  box.appendChild(el("h3", { text: t(txt.titleKey) }));
  box.appendChild(el("div", { class: "sub", text: t(txt.subKey) }));
  const input = el("input", { type: "text", class: "ip-name", placeholder: t("canvas.nameModal.namePh"), value: "" });
  input.style.cssText = "width:100%;padding:7px 10px;font-size:13px;outline:none;margin-top:8px";
  box.appendChild(input);
  const foot = el("div", { class: "foot" });
  const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
  const okBtn = el("button", { type: "button", class: "prim", text: t(txt.okKey) });
  foot.appendChild(cancelBtn);
  foot.appendChild(okBtn);
  box.appendChild(foot);
  wrap.appendChild(box);
  cancelBtn.addEventListener("click", () => document.body.removeChild(wrap));
  okBtn.addEventListener("click", () => {
    const v = input.value.trim();
    if (!v) { showToast("error", t("canvas.nameModal.emptyName")); return; }
    document.body.removeChild(wrap);
    onConfirm(v);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") okBtn.click(); });
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) document.body.removeChild(wrap); }); // F72：点遮罩关·判按下点（click 落共同祖先会误判外点）
  document.body.appendChild(wrap);
  setTimeout(() => { try { input.focus(); } catch (_e) { /* swallow */ } }, 0);
}

// ===== 运行（E025） =====
function runProject() {
  if (!S || !S.projectId) {
    openNameModal("run", (name) => {
      const p = createProject(name);
      storeSave(p);
      S.projectId = p.id;
      S.canvas.projectName = name;
      S.title = name;
      renderTitle();
      pushHist();
      persistCanvas();
      // 批 10-L L1-7：草稿升格为真项目（保存/运行两条建项目路径）→ 清草稿键，不留孤儿
      clearCanvasDraft();
      // 跳项目页跑提交流程（复用 submit-bar）
      window.location.hash = `#/project/${encodeURIComponent(p.id)}?tab=setup`;
      // 批 R8 · R7-4：去「▶ 」（顶栏按钮已为 play 图标+文本「运行项目」形态）
      armCreatedToast(p.id, "info", t("canvas.run.createdJump", { name }));   // G4a④：挂总表写落定后弹（失败不弹成功）
    });
    return;
  }
  // 有项目 → 跳项目页并自动触发提交流程（走查反馈⑥：老板报"点运行跳到设定"——
  //   此前只跳页让老板再点一次；现跳转后 submit-bar 挂载即自动点「运行项目」走真链）
  try { sessionStorage.setItem("gui13.autorun", "1"); } catch (_e) { /* 隐私模式 */ }
  window.location.hash = `#/project/${encodeURIComponent(S.projectId)}?tab=setup`;
  showToast("info", t("canvas.run.starting"));
}

// ===== 全局参数节点重新渲染（订阅回调·E014） =====
function renderGlobalNode() {
  if (!S) return;
  renderNodeById("G");
}