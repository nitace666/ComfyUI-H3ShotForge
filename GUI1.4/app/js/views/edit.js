// GUI 1.3 剪辑 TAB — 三轨时间线 + 播放器 (S1-3 任务 T3/T4/T5).
//
// === 出处注记 (S1-3 取用纪律) ===
// 视图结构与交互自 v43 原型时间线 JS 转正改写 (布局示意-项目工作区交互原型-v43-2026-09-24.html):
//   DOM 骨架      ← v43 :1610-1639 (tlPanel/ruler/mainTrack/altTrack/audioTrack/playhead)
//   relayout 链   ← v43 :4108-4130 (buildRuler/zoomSet/轴与内容对齐)
//   修剪手柄      ← v43 :4178-4218 (域逻辑在 core/timeline.js — 本文件只做指针接线)
//   游标 scrub    ← v43 :4137-4163
//   多选/复制/热键 ← v43 :3864-3964 (v42 件2/3/4)
//   拖拽磁吸      ← v43 :4006-4071 (v42 件5)
//   轨道静音      ← v43 :3866-3875 (v42 件1)
//   播放器        ← v43 :6396-6431 (pvTogglePlay)
// 域逻辑纯函数 = core/timeline.js (S1-3 T2); 数据源 = store.editingState (三视图同源铁律, T1).
// 审核流/历史载入/重跑/多版对比真弹窗/导出 = T6 (本文件留按钮占位, 不删键).

import { readAgg, writeAgg, saveAggAwait, USER_JSON, SETTINGS_JSON, getKey, putKey } from "../core/server_storage.js";  // 批 10-M T5：收藏迁 data/user.json（saveAggAwait=批3 T5 可等待保存通道）
import {
  load as storeLoad,
  save as storeSave,
  subscribe as storeSubscribe,
  unsubscribe as storeUnsubscribe,
  updateEditingState,
  reconcileMainClips,
  markClipReview,
  defaultEditingState,
  trackFlag,
  withTrackFlag,
  normalizeClipL2,
  defaultClipL2,
  latestMainRunStem,
  // #63 T4：currentRunId 指针（显式载入旧记录 → 挂载对账豁免「最新自愈」）
  isRunPointerPinned,
  // 批A #13：detail 快照缓存三件（写点 applyHistory / 消费点挂载对账失败兜底 / 语义③芯片转已连接失效）
  putDetailSnapshot,
  getDetailSnapshot,
  invalidateDetailSnapshots,
} from "../store/store.js";
import { showToast } from "../ui/toast.js";
import { t, getLang } from "../core/i18n.js";   // #89 T3a：显示文案入典（zh 原文=键值·en 见 core/i18n.js）；#92 B6 dispClip* 渲染侧映射取 lang
import { hydrateIcons } from "../ui/icons.js";
import {
  filmEndSec,
  actualFilmEndSec,
  axisLenSec,
  clipAtPlayhead,
  applyTrimClip,
  splitClipAt,
  snapPos,
  clampZoom,
  zoomPct,
  rulerSteps,
  stepPlayhead,
  fmtClock,
  fmtDur,
  effDurOf,
  axisTrimlOf,
} from "../core/timeline.js";
// 批 H T2：窗表共源（方案 v2 S2）——audioWindowAt 主轨窗累加式抽源为 trackWindowsOf，与导出组装器同消费
// 批 H T3：导出弹窗消费组装器（buildExportSpec/mergeProbedDurations——真实时长 probe 合并）
import { trackWindowsOf, buildExportSpec, mergeProbedDurations } from "../core/exportSpec.js";
// S1-3 T6: 历史/审片/重跑/拼接域 (executor T6a 改造自 legacy·出处见各文件头)
import { listHistory, loadDetail, loadRunsIndexTasks, refreshRunsIndex } from "../core/history_ops.js";
import { openDirRequest, resolveRunDir, clearRunDirCache } from "../core/open_dir.js"; // R-31 收敛：open_dir 发包+三分文案 / run_dir 解析单源
import { normFileKey, isCurrentPick } from "../core/filekey.js"; // R53变更20-T2/T3：路径归一键+现行判定单一事实源（守则/显示/拦截共用）
import { approve, voidSeg, resume } from "../core/review.js";
import { sameSeed } from "../core/rerun.js"; // editPrompt 通道已被 B4-T3 seg_edit 四区弹窗取代
// 批 H T3：D032 引擎拼接入口退役（openExportModal 改走伴生管线）——core/concat.js 至此无 edit.js 消费方
import { postfxRun, postfxStatus, composeBadge, resolveKindPreset, resolveEngineSid } from "../core/postfx.js";
// R56R57-S3 T4: 显示源解析胶合层（播放/导出/缩略图经此取最终版·读层派生不改写数据层）
import { postfxDisplaySource } from "../core/postfx_pipeline.js";
import { request, fetchApi, mediaUrl, localMediaUrl, setMediaSrc, wireLocalFallback, wireBgMediaFallback } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源（引擎口优先+离线回落）·fetchApi=同源伴生通道统一出口（#57 档2 T1）
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件超时值引表·不得就地内联。
import { TIMEOUTS } from "../core/timeouts.js";
// B5-T2 ④（H6）：停止类通知条目——与 pollStatus.stop()/submit-bar 取消链同语义
// B5-T4 C2：段状态着色映射（success→green/rendering→yellow/failed|void→red/else gray）
import { stoppedNotifEntry, shotColor } from "../core/submit.js";
// S2-3 T3 (c4/D8): 目录浏览 (GET /h3_batch/browse) — 引擎 browse_dir 封装, 数据装配纯函数.
import { browseDirectory, formatBrowseEntries } from "../core/browse.js";
import { pickLocalFile, uploadAudioToEngine, readAudioDuration } from "../core/audio_upload.js"; // W-08 BGM（批 3）
// S3-3 T8：调色面板的作用域 / 片段 / 滤镜三下拉复用 cbox 通用件（拍板 12-19 文档级委托）
import { setCurrentValue, initDocumentDelegate } from "../ui/cbox.js";
import { postfxLinkInitialState, postfxLinkInitGates, postfxLinkGates, postfxLinkStep } from "../ui/postfx_linkage.js";   // #32 单驱动源联动（与参数页同规则·纯函数状态机）
// S3-4 B6：收藏夹变体重跑 —— 复用 B5 抽出的单段生成公共底层（seed 参数化）
import { runSingleSegmentGeneration } from "./assets.js";
// B7-T3 E2：多候选域层（#58 发起 / #60 轮询 / #59 采纳·废弃）
// 批5-R53-TC：buildAltChains —— altChains 权威分组模型（动态多轨代际解析读侧）
import {
  submitCandidates, pollCandidateRuns,
  validateCount, estimateText, buildLaunchText, mapRunsData, rebuildAltClips,
  buildAltChains, convergeAltClips,
} from "../core/candidates.js";
import { loadWorkspaceRoot } from "../core/workspace.js"; // R-59-T2b 补切：预听 output 根优先工作区根（旧通道退役收口）
// B4-T2 D2：重跑链共享编排（rerunSelected 提交→落账→轮询→按 stem settle→回轨）
import { runRerunFlow } from "./rerun_flow.js";
// B4-T3 D3：段级精修提交层（引擎 #57 seg_edit·rerun=false 纯写侧车）+ 引擎库选图
import { submitSegEdit } from "../core/seg_edit.js";
// P0-#17：打开项目对账回填——回轨函数 syncRunProducts 改对账点内动态 import（见
//   reconcileRunProductsOnMount 注记）——T8 环消除：静态边 edit→submit-bar→preview→edit 三节环在此断开
import { openPicker } from "../ui/path_picker.js";
// 批A #13 语义③：芯片态订阅源 = settings 同源单例（refreshChip 唯一探测出口翻态）
import { subscribeChipState } from "./settings.js";
// 批Gb T6（R-09）：精修弹窗第五区「底模」下拉源（引擎 #28 resources?kind=model·复用不重造）
import { fetchResourceItems } from "./resources.js";

// ===== 会话态 (挂载期持有; 卸载即弃) =====
let S = null;
let _subFn = null;
let _rerunPoll = null;   // 批3-T1 R2：当前重跑旁观轮询环句柄（单页同刻只一环·卸载即停·不建注册表）
let _chipUnsub = null;   // 批A #13 语义③：芯片态订阅句柄（mount 注册·unmount 摘除防跨挂载累积）

// #63 T4：挂载对账的「最新任务」对账号——显式载入旧记录（currentRunId 钉在非最新行）时豁免，
//   不被自动纠正为最新；无指针/指针=最新/已是最新 → 返回最新 stem（既有行为）。
export function mountStemFixFor(project, loadedTaskId) {
  const runs = Array.isArray(project && project.runs) ? project.runs : [];
  const latestStem = latestMainRunStem(runs);
  if (!loadedTaskId || !latestStem || latestStem === loadedTaskId) return "";
  if (isRunPointerPinned(project)) return "";
  return latestStem;
}

export function mount(container, projectId) {
  container.innerHTML = "";
  const proj = storeLoad(projectId);
  if (!proj) {
    container.innerHTML = '<div class="shell-tab-placeholder"><div class="ph-cap">' + t("edit.mount.noProject") + '</div></div>';
    return;
  }

  // 三视图同源对账: segments 真源 → mainClips 演化 (T1 reconcile), 有变化即持久化
  const rec = reconcileMainClips(proj);
  if (rec.changed) {
    updateEditingState(projectId, { mainClips: rec.clips });
  }
  if (!proj.editingState || typeof proj.editingState !== "object") {
    updateEditingState(projectId, { ...defaultEditingState(), mainClips: rec.clips });
  }
  // #23 二轮案①: 挂载即收敛（无 loadedTaskId 退化路·同步纯函数零引擎请求）——altClips 存量
  //   按 R2/R3/R4 规则去重一次（主轨计代表·优先级退化 pinned>数组靠前·ver/gen 校正跳过），
  //   零剔除返回同引用不落盘（幂等·再挂载零改写）。有 loadedTaskId 的全量收敛路（引擎
  //   detail→rebuildAltClipsInProject·与载入历史同链）由 reconcileRunProductsOnMount
  //   →syncRunProducts 既有挂载链承担——二轮新语义（主轨计代表/每段链深度重排）落在
  //   candidates.js 域层，两路同源收敛。
  //   最新任务语义（二期门审最终缺口·测试4 真机形态）: loadedTaskId ≠ runs 最新主链行 stem
  //   时——含 loaded 缺行（9958968 补位第三形态）与旧行仍在 runs（本次实证·此前错用旧账本
  //   对账致终态错）——一律用最新主链行 stem 对账，与 loadedTaskIdOrFix「任务指向已过期，
  //   已改用最新运行任务」同语义（loadedTaskId 本身不回写）；补位分支被此式覆盖合并，防重入
  //   仍由 _reconciledRunKeys 同键承担（同会话同 stem 恰一次 detail）。runs 无主链行（全空/
  //   全 postfx/kinded 子集）→ 回路②纯收敛。
  let mountStemFix = "";   // 最新任务对账号（挂载块与下方直调共用·防双链双 detail）
  {
    const es0 = proj.editingState || {};
    const runs0 = Array.isArray(proj.runs) ? proj.runs : [];
    const latestStem = latestMainRunStem(runs0);   // 口径同 loadedTaskIdOrFix（无 kind 主链行·置顶序取首）
    mountStemFix = mountStemFixFor(proj, es0.loadedTaskId);
    const prevAlts = Array.isArray(es0.altClips) ? es0.altClips : [];
    const convergeSync = () => {
      const next = convergeAltClips(prevAlts, { clips: Array.isArray(es0.mainClips) ? es0.mainClips : [] });
      if (next && next !== prevAlts) {
        updateEditingState(projectId, { altClips: next, altChains: buildAltChains(next) });
      }
    };
    if (prevAlts.length) {
      const loaded = es0.loadedTaskId;
      if (!loaded) {
        convergeSync();   // 路②（原语义零变化）
      } else if (mountStemFix) {
        reconcileRunProductsOnMount(projectId, mountStemFix);   // 最新任务 stem 走路①全量链
      } else if (!latestStem) {
        convergeSync();   // runs 无主链行 → 回路②（陈旧号不发 detail·回落锁）
      }
      // loaded === latestStem → 路①既有链由下方 reconcileRunProductsOnMount(projectId, mountStemFix) 承担
    }
  }

  _loopMode = 0;   // 批 A T4：循环是纯视图态·每次进剪辑页回「关」（不进项目数据·不留跨会话残留）
  // 批3-T2 R1：覆盖 S 前清旧 monTimer——路由重入（连续进出剪辑页）时旧 S 连句柄一并失管成孤儿轮询（真浏览器同款洞）。
  //   取舍：只清 monTimer（无界 interval·最致命）；pvTimer/_freezeTimer 同款洞不在本口径·留待后续。
  if (S && S.monTimer) clearInterval(S.monTimer);
  S = {
    projectId,
    pxs: clampZoom(proj.editingState.zoom || 36),
    phTime: 0,
    root: null,
    pvTimer: null,
    monTimer: null,
    // 批 E-T8 定格预演轻版（方案 §三裁决 3）：hold = 段内容末定格暂停期（播放态保持·不换源不记位置）；
    //   _freezeTimer = hold 期计时句柄（到点接下段·任何停播/起播/切段路径都要清）
    _freezeHold: false,
    _freezeTimer: 0,
  };

  const root = document.createElement("div");
  root.className = "edit-root";
  // contain:inline-size: 根容器 inline 轴尺寸与内容解耦——否则时间线 ruler(min-width:max-content)
  // 的 min-content 沿列 flex 链上传, 把壳层主区撑到 2434px（对账单 §5.1 播放器容器溢出根因）
  root.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0;gap:0;contain:inline-size";
  // 老板 2026-09-26 UI 结构核对修正（v43 :1586-1614 实测）：player → split-pv → tools → split-h → timeline
  root.appendChild(buildPlayer());
  root.appendChild(buildSplitPv());
  root.appendChild(buildSplitH());
  root.appendChild(buildTimeline());
  container.appendChild(root);
  S.root = root;
  // J-P8 撤销栈种子：state.hist 有合法持久化栈（关项目重开）→ 还原它；否则退回挂载态空种子。
  //   口径变更（老板 2026-10-06）：推翻 S3-4「栈是会话内存态·不落项目 JSON·刷新即清」——
  //   栈随项目 JSON 落盘，重挂载后 Ctrl+Z/Ctrl+Y 仍可回退/重做。
  S.hist = restoreHist(proj.editingState.hist) || { stack: [esHistSnap(es())], idx: 0, key: null, ts: 0 };
  _clipGeom.clear();   // TE: 几何快照随挂载清零——重挂载/切项目不背旧位（挂载首帧无换序动画）
  // 走查反馈 F31（老板 2026-09-27 两连点名「监控墙去掉·被项目概况取代」）：
  //   抽屉不再建（原 buildMonDrawer() 此处调用移除）；startMonPoll 数据通道保留（历史弹窗复用）
  // F1（B 审修正笔）：track 级拖拽监听每挂载绑定（track DOM 随路由重建，单例绑定致 TAB 往返后 drop 失效）
  root.querySelectorAll(".tl-track").forEach(bindTrackDropListeners);

  renderAll();
  refreshHistUi();

  // 批 J-P13：产物实测时长校正（探测异步·不阻塞挂载渲染·测完静默回写并重渲）
  void syncProbedDurs();

  // 文档级委托 (v43 形态: 多选/热键/修剪/拖拽全走文档委托, 剪辑 TAB 活跃判定守门)
  bindDocumentDelegates();
  // S3-3 T8：cbox 文档级委托（幂等）——调色面板三下拉的菜单开/关/选
  if (typeof document !== "undefined") initDocumentDelegate(document);

  // store 订阅: 编辑态外部变化 → 重渲染 (退订接 C2 同款防累积)
  if (_subFn) storeUnsubscribe(_subFn);
  _subFn = (ev) => {
    if (!ev || ev.projectId !== projectId) return;
    // F3（B 审修正笔）：自写事件到达即复位标志——否则首次自写后标志恒 true，后续外部
    // editingState:update（S1-4 画布接入后）会被永久吞掉
    if (ev.type === "editingState:update" && S._selfWrite) {
      S._selfWrite = false;
      return;
    }
    if (ev.type === "editingState:update" || ev.type === "segment:add"
      || ev.type === "segment:remove" || ev.type === "segment:move" || ev.type === "segment:update") {
      // 外部来源(设定页/画布) → 重读缩放态并重渲染
      S._selfWrite = false;
      const p2 = storeLoad(projectId);
      S.pxs = clampZoom((p2.editingState && p2.editingState.zoom) || S.pxs);
      renderAll();
    }
  };
  storeSubscribe(_subFn);

  // P0-#17：打开项目即对账回填一次（异步·不阻塞挂载渲染；回填落盘经上方订阅触发重渲染）。
  //   mountStemFix: 最新任务语义（上方挂载块）判得的最新主链行 stem——loadedTaskId 过期时
  //   由此覆盖直调的 stem 取序（同键防重入·不会双 detail）。
  reconcileRunProductsOnMount(projectId, mountStemFix);

  // 批A #13 语义③：芯片转「已连接」即主动失效当前项目 detail 快照（下次读取重拉引擎真相·
  //   快照不残留冒充）。挂载期注册、卸载摘除（settings._chipSubs 单例集合防累积）。
  if (_chipUnsub) { try { _chipUnsub(); } catch (_e) { /* 句柄已失效忽略 */ } }
  _chipUnsub = subscribeChipState((v) => {
    if (v === "connected" && S && S.projectId) invalidateDetailSnapshots(S.projectId);
  });

  // T6: 监控墙 3s 轮询（loadedTaskId 就绪后自动消费 status）
  startMonPoll();
  // 批F F-T4：/view 两根（input/output）模块级取一次（失败下次 mount 重试）
  ensureAudioRoots();
  // F1: 原生播放游标跟随 rAF 循环（unmount 摘除）
  startPhRaf();
}

export function unmount() {
  if (_subFn) { storeUnsubscribe(_subFn); _subFn = null; }
  // 批A #13 语义③：摘芯片态订阅（跨挂载不累积）
  if (_chipUnsub) { try { _chipUnsub(); } catch (_e) { /* 句柄已失效忽略 */ } _chipUnsub = null; }
  // 批3-T1 R2：页面卸载即停重跑旁观轮询——环是 ref 自续期定时器·不停则离开剪辑页后仍在打 status
  //   （Node 单测进程被钉住·套件跑完不退出；真浏览器端即后台空转）。
  // 批3-T5：quiet 深度静默——卸载=旁观停（引擎侧任务实际仍在跑）·不落「已取消」队列历史
  //   （否则重跑中切页队列暂显「已取消」假态·切回由 submit-bar 对账步 removeRunningByTaskId
  //   删旧 running 行重挂收口·只删不校正）；用户主动取消不受影响。
  if (_rerunPoll) { const p = _rerunPoll; _rerunPoll = null; try { p.stop({ quiet: true }); } catch (_e) { /* 幽灵轮询清理失败不阻塞卸载 */ } }
  stopPlay();
  stopPhRaf();
  if (S && S.monTimer) clearInterval(S.monTimer);
  // S2-2 T5: 离开页面顺手清 postfx 轮询定时器 (不欠债)
  stopPostfxPoll();
  // M6 真机门补: 轮询清了但弹窗挂 body 存活 → 回页残留「后处理中…」冻结假态——
  //   卸载时顺带关闭现存 postfx 弹窗（走 close=尺寸记忆+onClose 链·对齐 monDrawer 随手摘先例）
  if (_postfxModalClose) {
    const _c = _postfxModalClose;
    _postfxModalClose = null;
    try { _c(); } catch (_e) { /* 幽灵弹窗清理失败不阻塞卸载 */ }
  }
  // S2-2 T6: 清 postfx_status 缓存 + history badge 缓存 (TAB 切换不残留)
  _postfxStatusCache = null;
  for (const k of Object.keys(_histBadgeCache)) delete _histBadgeCache[k];
  // S2-3 T3 修正笔: 清 run_dir 行缓存 (TAB 切换不残留; 不欠债·缓存随 R-31 迁 core/open_dir.js)
  clearRunDirCache();
  const drawer = document.getElementById("monDrawer");
  if (drawer) drawer.remove(); // 抽屉挂 body——卸载时随手摘（v43 单例形态）
  _editDual = null;   // 批 F91a：摘双缓冲句柄（防留旧容器引用·下次 mount 重建）
  // 批 L3 T-C：摘转场模拟层 + 清兜底定时器句柄（元素随 root 弃·定时器不留野）
  clearTransOverlay();
  _audioEl = null;    // 批F F-T4：摘预听音频元素引用（元素随 root 一并弃·下次 mount 重建）
  S = null;
}

// ===== 数据快速通道 =====
// 批 R3：抽出 esOf(projectId) —— 预览 TAB（edit 未挂载 · S=null）经 openReviewModal(projectId)
//          直读 store editingState；edit 域内 es() 行为不变。
function esOf(projectId) {
  const p = projectId ? storeLoad(projectId) : null;
  return (p && p.editingState && typeof p.editingState === "object") ? p.editingState : defaultEditingState();
}
function es() {
  return esOf(S && S.projectId);
}
// 批 M3 T2 测试缝：连播态直置（拖自绘条「只移游标不换源」用例用·startPlaylist 需勾选 UI 前置）
export function _test_setPlaylist(pl) { if (S) S.playlist = pl || null; }
export function _test_es() { return es(); }
// 秒数文案去尾零（15 → "15"·29.97 → "29.97"）——进度条总时长显示用·不四舍五入。
function trimZero(sec) {
  const n = +sec || 0;
  return String(Math.round(n * 100) / 100);
}
// F106 C-T5：loadedTaskId 过期校验（九读点统一入口·口径同 preview.js:416-423 resolveCurrentTaskId）
//   显式「载入历史」选旧任务后 st.loadedTaskId 即定格·无失效机制 → 直剪操作（后处理/重跑/审片门/
//   导出…）会打到过期任务。比对 store.latestMainRunStem（最近一次主链全量运行）：不一致 → 改用最新
//   stem 并 toast 告知；runs 无主链记录（纯查看旧项目）→ 按原值走·不打扰。
//   **不写回 store**（用户显式载旧任务是合法意图·自动改写会破坏对比/审片场景）。
//   防连弹：同一次操作链多读点只提示一次（_fixToastedKey 记「项目|旧|新」对·换对才再弹）。
//   projectId 缺省取 S.projectId；跨域入口（预览 TAB 直调 openReviewModal/openRerunModal/openSegRerunBySegId
//   传显式 projectId·此时 S 可能未挂载）由调用方传入。
// P0-#17：打开项目对账回填（治死路径再生+存量自愈）——重跑后引擎把旧产物改名（_old_NN 链），
//   项目档里的旧绝对路径 404。syncRunProducts 本身会按引擎 detail 回填新文件名，但既有触发点
//   只挂在重跑旁观链（rerun_flow/submit-bar 轮询终态）——旁观链不存活（关弹层/切页）则永缺；
//   applyHistory 载入历史证明按引擎 detail 刷新主轨 file 的自愈机制已存在，缺「打开项目」触发。
//   取序：loadedTaskId 优先（用户显式载入的现行任务），空则回退 latestMainRunStem（runs 最新
//   主链·runs[0] 语义的既有判定口）。**门：stem 必须在 runs 里有运行记录**——只对项目档真实
//   跑过的任务对账（纯查看/未载入项目不打引擎；载入历史全量刷新走 applyHistory 既有通道）。
//   stemFix（最新任务语义·二期门审）: 挂载钩传入的最新主链行 stem（loadedTaskId 过期时
//   挂载块判得）——优先于 loadedTaskId；仍须过 runs 匹配门（stem 本就取自 runs·门是
//   防错传护栏），防重入键同口径（projectId|stem）。
//   防重入：同项目同 stem **成功**对账本会话只打一次引擎（跨 mount 记账）；失败态（syncRunProducts
//   自返 {ok:false}·不抛，submit-bar.js:123-127 同款口径——按返回值判；意外异常同）即释放 key，
//   同会话下次 mount 可重试（T8：引擎不可达不再永久跳过）。静默不阻塞打开项目。
//   T8 环消除：syncRunProducts 改对账点内动态 import——静态边 edit→submit-bar(:50)→preview(:34)
//   →edit 三节环在此断开（本文件唯一调用点·运行时取件）。
let _reconciledRunKeys = new Set();
function reconcileRunProductsOnMount(projectId, stemFix) {
  const proj = storeLoad(projectId);
  if (!proj) return;
  const st = proj.editingState || {};
  const runs = Array.isArray(proj.runs) ? proj.runs : [];
  const stem = stemFix || st.loadedTaskId || latestMainRunStem(runs) || "";
  if (!stem || !runs.some((r) => r && r.stem === stem)) return;
  const key = projectId + "|" + stem;
  if (_reconciledRunKeys.has(key)) return;
  _reconciledRunKeys.add(key);
  void (async () => {
    try {
      const { syncRunProducts } = await import("./submit-bar.js");
      const r = await syncRunProducts(projectId, stem);
      if (!r || r.ok !== true) {
        _reconciledRunKeys.delete(key);   // T8：失败释放·本会话可重试
        showDetailSnapshotFallback(projectId, stem);   // 批A #13 语义①：离线兜底渲染快照（标注数据时点）
      }
    } catch (_e) {
      _reconciledRunKeys.delete(key);   // 异常同释放
    }
  })();
}

// 批A #13 语义①：对账失败（引擎不可达）时用项目实体 detail 快照兜底显示——
//   段墙在位（预览页监控抽屉开着）→ 就地快照渲染 + 「数据截至」标注；剪辑页本体不出监控抽屉
//   （F31 走查口径·抽屉不随 mount 建）→ toast 标注数据时点。仅显示兜底不冒充引擎真相；
//   引擎可达时 syncRunProducts 成功，本函数不被调用，mount 对账链照跑（语义②）。已卸载/换项目 → 丢弃。
function showDetailSnapshotFallback(projectId, stem) {
  if (!S || S.projectId !== projectId) return;
  const snap = getDetailSnapshot(projectId, stem);
  if (!snap || !snap.shots || typeof snap.shots !== "object" || Array.isArray(snap.shots)) return;
  const savedAt = snap.savedAt || "";
  if (document.getElementById("segWall")) renderSegWall(snap.shots, { fallbackSavedAt: savedAt });
  showToast("info", t("edit.snap.fallbackToast", { stem, ts: savedAt || t("edit.snap.timeUnknown") }));
}

let _fixToastedKey = "";
// #63 T4 第四处豁免（T5 收口）：currentRunId 钉旧记录（显式载入）时保持原值——
//   不纠正为最新、不 toast；无指针/指针=最新照旧自愈。
export function loadedTaskIdOrFix(st, projectId) {
  const cur = st && st.loadedTaskId;
  if (!cur) return "";
  const pid = projectId || (S && S.projectId) || "";
  const proj = pid ? storeLoad(pid) : null;
  if (isRunPointerPinned(proj)) return cur;
  const latest = latestMainRunStem(proj && proj.runs);
  if (!latest || latest === cur) return cur;
  const key = pid + "|" + cur + "|" + latest;
  // 批 C C-F1（P-2）: taskId 改指最新 stem 时，sid 缓存仍是旧任务轮的轮询结果 → 配对必错
  //   （approve({stem:新, sid:旧}) 必 400）。同步清缓存：审片门三钮走既有拒发路径（toast·零请求）。
  if (S) S._lastPendingSid = null;
  if (key !== _fixToastedKey) {
    _fixToastedKey = key;
    showToast("info", t("edit.loaded.staleToast"));
  }
  return latest;
}
// J-P8 撤销栈落盘：栈随项目 JSON 持久化（关项目重开仍可撤销/重做）。
//   走 storeSave 而非 updateEditingState —— 后者有键白名单（store.js EDITING_STATE_KEYS），
//   hist 不在其中，写入会被静默丢弃（实测返回 false）；save 是同款既有通道
//   （canvas.js onGlobalPromptInput 写 globalPrompt 同款：白名单外字段经 save 落盘）。
//   只落 {stack, idx}：key/ts 是手势合并的会话态（合并时间窗跨会话无意义）。
//   hist 不在 ES_HIST_KEYS 内 → 快照不含 hist，无自嵌套膨胀。
function persistHist() {
  if (!S || !S.hist || !S.projectId) return;
  const p = storeLoad(S.projectId);
  if (!p || !p.editingState || typeof p.editingState !== "object") return;
  p.editingState.hist = { stack: S.hist.stack, idx: S.hist.idx };
  storeSave(p);
}
// 还原持久化栈：结构不合法（无 stack / 非数组 / 空 / idx 越界 / 元素非对象）→ null（退回空种子）
function restoreHist(h) {
  if (!h || !Array.isArray(h.stack) || h.stack.length === 0) return null;
  if (!Number.isInteger(h.idx) || h.idx < 0 || h.idx >= h.stack.length) return null;
  if (!h.stack.every((s) => s && typeof s === "object" && !Array.isArray(s))) return null;
  return { stack: h.stack, idx: h.idx, key: null, ts: 0 };  // key/ts 复位：合并链不跨会话
}

// coalesceKey（可选）: 连续手势合并键 —— 透传 pushHist（同键同窗只更新栈顶·见下）
function writeEs(patch, coalesceKey) {
  S._selfWrite = true;
  if (Object.prototype.hasOwnProperty.call(patch, "zoom")) {
    S.pxs = clampZoom(patch.zoom); // 同步会话缩放态（renderAll 以 S.pxs 渲染）
  }
  const histWorthy = ES_HIST_KEYS.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
  updateEditingState(S.projectId, patch);
  if (histWorthy) pushHist(coalesceKey);
  // updateEditingState 触发订阅, 但本会话写回时订阅侧被 _selfWrite 拦下 — 这里直接渲染
  renderAll();
  refreshHistUi();
}

// ===== 撤销/重做快照栈 (S3-4 B4·空-017) =====
// 选型: editingState 快照栈 —— writeEs 是唯一写入口 (S3-2 起收敛), 一次写=一次快照,
//   天然覆盖片段增删/拖拽调序/跨轨移动/修剪/分割/Alt 复制/L2 写入全部操作, 无逐命令侵入。
// 栈形: 状态序列 (挂载种子 + 每次写后入栈·等价于「下一写的前态」), idx 指向当前状态;
//   新写截断 redo 尾; 上限 30 与画布 HIST_MAX (core/canvas.js:22) 同口径 —— 含种子最多回退 29 步。
// 不入栈: zoom 属视图态 (滑杆/滚轮高频写, 入栈会冲刷真实编辑步); 栈是会话内存态,
//   不落 editingState/项目 JSON —— 刷新 (重挂载) 即清, 与画布 30 步同语义。
// 合并键 (老板走查快批④ 第②件): 连续手势逐值写 (音量滑杆 input) 传 coalesceKey →
//   同键 + 距上次写 ≤HIST_COALESCE_MS 时只更新栈顶快照不新增条目 —— 一次连续拖动 = 一个撤销单元。
const UNDO_MAX = 30;
const HIST_COALESCE_MS = 1500;
// deletedSegIds 入快照（批 D D-T2）: 撤销删除 = 片段 + 墓碑标记同回（Ctrl+Z 一步复原）
const ES_HIST_KEYS = ["mainClips", "altClips", "audioClips", "mutedMain", "mutedAudio", "loadedTaskId", "tracks", "markers", "color", "deletedSegIds"];

// 快照 = 入栈字段的深拷贝 (缺键不补齐: 旧档编辑态不因撤销凭空多字段)
function esHistSnap(state) {
  const snap = {};
  for (const k of ES_HIST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(state, k)) continue;
    snap[k] = JSON.parse(JSON.stringify(state[k]));
  }
  return snap;
}
// coalesceKey: 同手势合并键 (无则每次写各占一步)。合并条件三者齐备 —— 键同、位于栈顶 (回退后不并)、
//   距上次写入在时间窗内; 合并 = 覆盖栈顶为最新态 (拖动前态仍是下一层, 撤销一次即回溯整段拖动)。
function pushHist(coalesceKey) {
  const h = S.hist;
  const snap = esHistSnap(es());
  if (JSON.stringify(h.stack[h.idx]) === JSON.stringify(snap)) return; // 同态去重
  if (coalesceKey && h.key === coalesceKey && h.idx === h.stack.length - 1
    && Date.now() - h.ts <= HIST_COALESCE_MS) {
    const merged = h.stack.slice();
    merged[h.idx] = snap;
    S.hist = { stack: merged, idx: h.idx, key: coalesceKey, ts: Date.now() };
    persistHist();
    return;
  }
  const stack = h.stack.slice(0, h.idx + 1); // 截断 redo 尾
  stack.push(snap);
  if (stack.length > UNDO_MAX) stack.shift(); // 第 31 步丢最旧
  S.hist = { stack, idx: stack.length - 1, key: coalesceKey || null, ts: Date.now() };
  persistHist();
}
// 回退/前进一步: 栈端零操作 (按钮同态灰显), 命中即整体回写编辑态并重渲染
function histStep(dir) {
  if (!S || !S.hist) return;
  const i = S.hist.idx + dir;
  if (i < 0 || i >= S.hist.stack.length) return;
  S.hist.idx = i;
  S.hist.key = null; // 回退/重做打断手势链: 后续写另起撤销单元（否则会并进上一拖动、吞掉其前态）
  S._selfWrite = true;
  const patch = JSON.parse(JSON.stringify(S.hist.stack[i]));
  // 批 D D-T3 改动4: 快照缺 deletedSegIds 键（旧档种子快照·esHistSnap 缺键不补齐）→ 恢复时补落
  //   [] —— 否则删除步写入的墓碑残留成陈旧值（Ctrl+Z 片段回来了标记还在·重挂载即被闸门再清）。
  //   快照缺键 = 该时点尚无任何墓碑 → 语义即空标记集。
  if (!Object.prototype.hasOwnProperty.call(patch, "deletedSegIds")) patch.deletedSegIds = [];
  updateEditingState(S.projectId, patch);
  persistHist();   // J-P8: 回退位（idx）随栈落盘 —— 重开后 redo 尾仍可用
  renderAll();
  refreshHistUi();
}
function refreshHistUi() {
  if (!S || !S.hist) return;
  if (S.undoBtn) S.undoBtn.classList.toggle("dim", S.hist.idx <= 0);
  if (S.redoBtn) S.redoBtn.classList.toggle("dim", S.hist.idx >= S.hist.stack.length - 1);
}

// ===== DOM 构建 =====

// 批 R7：工具条图标 HTML（mk 走 innerHTML · 文本随其后）
function iconHtml(name, sz) {
  return `<span data-ic="${name}" data-sz="${sz}"></span>`;
}

// 播放器 (D026): <video> 真源 (T6 历史载入后接 /h3_batch/video?path=), 无产物时占位
// F75（老板 2026-10-02 复验回执⑥第 3 项「播放器下面有一行文字 删除了」）：状态行整行退场
//   （原 R1 ④ A02·v43 :1588 的 状态词 + 右键引导 + 游标时间/全片总时长），构造与三处更新器一并清除。
// 走查反馈 F3（老板 2026-09-27「导出成片/载入历史放工具条不合适」）：两钮自编辑工具条迁播放器区
//   右上（全局完成动作与片段编辑工具分家——导出=主按钮·剪映「导出」在预览区右上同款心智）
function buildPlayer() {
  const pl = document.createElement("div");
  pl.className = "edit-player";
  pl.id = "editPlayer";
  const actions = document.createElement("div");
  actions.className = "pv-actions";
  // W-08 BGM（#81 D4 自剪辑工具条迁入·原 :565-577 逐字平移）：挂 BGM = 本机音频 → 引擎 input（供导出/提交链消费）+ 音频轨挂一条（所见即所得）
  const bgmBtn = document.createElement("span");
  bgmBtn.className = "ghostbtn";
  bgmBtn.title = t("edit.bgm.title");
  bgmBtn.innerHTML = iconHtml("music", 14) + "BGM";
  bgmBtn.addEventListener("click", async () => {
    const f = await pickLocalFile("audio/*", "gui13-bgm-pick");
    if (!f) return;
    showToast("info", t("edit.bgm.uploading", { name: f.name }));
    const up = await uploadAudioToEngine(f);
    if (!up.ok) { showToast("error", t("edit.bgm.uploadFail") + up.error); return; }
    const dur = await readAudioDuration(f);
    const label = "BGM · " + (f.name || up.name);
    const st = es(); // 挂载后音频轨可能已被编辑——实时取最新 editingState
    // 批 F F-T1: file 落 absPath（反斜杠原始形态·与 mainClips.file 同形）——预听/导出消费源
    writeEs({ audioClips: [...(st.audioClips || []), { id: "bgm-" + Date.now(), label, dur: dur > 0 ? dur : 30, triml: 0, file: up.absPath }] });
    showToast("success", t("edit.bgm.attached", { label, durTail: dur > 0 ? t("edit.bgm.durTail", { sec: dur.toFixed(1) }) : t("edit.bgm.durUnknown") }));
  });
  actions.appendChild(bgmBtn);
  const histBtn = document.createElement("span");
  histBtn.className = "ghostbtn";
  histBtn.title = t("edit.hist.btnTitle");
  histBtn.innerHTML = iconHtml("refresh", 13) + t("edit.hist.btn");
  histBtn.addEventListener("click", () => openHistoryModal());
  actions.appendChild(histBtn);
  const expBtn = document.createElement("span");
  expBtn.className = "prim";
  expBtn.title = t("edit.export.btnTitle");
  expBtn.innerHTML = iconHtml("download", 13) + t("edit.export.btn");
  expBtn.addEventListener("click", () => openExportModal());
  actions.appendChild(expBtn);
  // 批 0 T1 收藏夹归位（F24 撤工具条入口·老板钦点播放器区）：☆ 即原型 v43 :1597 字面图形
  const favBtn = document.createElement("span");
  favBtn.className = "ghostbtn";
  favBtn.title = t("edit.fav.title");
  favBtn.innerHTML = t("edit.fav.cap");
  favBtn.addEventListener("click", () => openFavoritesModal());
  actions.appendChild(favBtn);
  // B5-T5① 勾选连播（H8）：勾选多段 → 按时间线序链式连播（一段播完自动接下一段）
  const playSelBtn = document.createElement("span");
  playSelBtn.className = "ghostbtn";
  playSelBtn.title = t("edit.playlist.btnTitle");
  playSelBtn.textContent = t("edit.playlist.btn");
  playSelBtn.addEventListener("click", () => startPlaylist());
  actions.appendChild(playSelBtn);
  // 批 A T4：循环三态钮（关 / 段 / 全片）·点按轮换·title 随态提示当前档。
  //   纯视图态（模块级 _loopMode·不入项目数据）——播放行为差异见 continueNextClip/onQueueEnded。
  const loopBtnEl = document.createElement("span");
  loopBtnEl.className = "ghostbtn";
  loopBtnEl.textContent = t("edit.loop.btn", { mode: LOOP_NAMES[_loopMode] });
  loopBtnEl.title = loopTitle();
  loopBtnEl.addEventListener("click", () => {
    _loopMode = (_loopMode + 1) % 3;
    loopBtnEl.textContent = t("edit.loop.btn", { mode: LOOP_NAMES[_loopMode] });
    loopBtnEl.title = loopTitle();
  });
  actions.appendChild(loopBtnEl);
  // F97b：容器全屏——原生 ⛶ 全屏的是 video 元素本身，promote 降位/清源后全屏画面即死
  //   （第二段 promote 复用备位装新源更会 emptied 退出全屏）→ 全屏下永远只播一段。
  //   全屏容器 = 双缓冲换源在全屏元素内部进行·跨段连播不断。
  // F97-f1（老板 2026-10-07 报「全屏钮灰了·点不了」）：原生 ⛶ 真摘除（initVideo 的
  //   hideNativeFullscreen）——controlsList=nofullscreen 是 WebKit 专有·Chrome 不认·原生
  //   ⛶ 仍在控件条上（播放中随控件条淡出近乎不可见 = 观感「灰」·且点它是全屏 video 元素 =
  //   F97b 老死局）。摘除后全屏入口唯一 = 本钮。
  const fsBtn = document.createElement("span");
  fsBtn.className = "ghostbtn";
  fsBtn.title = t("edit.fs.title");
  fsBtn.textContent = t("edit.fs.btn");
  fsBtn.addEventListener("click", () => {
    const pl = document.getElementById("editPlayer");
    if (!pl) return;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      return;
    }
    // 全屏被浏览器拒（无用户激活/策略禁）时给反馈——静默 = 老板观感「点了没反应」
    if (pl.requestFullscreen) pl.requestFullscreen().catch(() => showToast("error", t("edit.fs.denied")));
    else showToast("error", t("edit.fs.unsupported"));
  });
  actions.appendChild(fsBtn);
  pl.appendChild(actions);
  // 批F F-T4（方案 §三裁决 2）：预听 audio 元素——挂 #editPlayer 容器内·无视觉面纯发声
  //   （src/起停/速率/音量面全由 audioAlignFrame 归口驱动·禁旁路直写）。
  _audioEl = document.createElement("audio");
  _audioEl.preload = "auto";
  // 批 B #13：音频引擎口（/view）失败 → 本地流兜底（/gui13-fs/media?path=·一次性防循环）；
  //   回落目标 = 当前条目 file（audioAlignFrame 每次换条目写 dataset.audioFbFile）
  _audioEl.addEventListener("error", () => {
    const a = _audioEl;
    if (!a || !a.dataset || a.dataset.localFb === "1" || !a.dataset.audioFbFile) return;
    a.dataset.localFb = "1";
    a.src = localMediaUrl("audio", a.dataset.audioFbFile);
  });
  pl.appendChild(_audioEl);
  // 批 M3 T2 · R-43 自绘全片进度条 + 自绘播控（原生 controls 于 T3 隐藏·屏上进度/播控不可缺）：
  //   · .pv-scrub 轨道 + .pv-knob 游标点（**无缓冲条**——桩无 buffered 通道 + 本批播放域开销敏感）
  //   · 拖动热区 ≥14px（透明 ::before 撑高·视觉轨道仍 4-6px）+ hover 游标放大（CSS 侧）
  //   · .pv-time 文案「段i · 全片 x.xs / 总 ys」·刷新在 renderPlayhead（帧内已过此口·零新循环）
  //   · .pv-play/.pv-pause 两元素·图标态由既有 playing 类驱动（edit.css:41-42 现成规则·
  //     **不归 renderPlayhead**——其调用点在 playing&&!frozen 分支内·停播后不被调→图标卡暂停形态）
  //   · 像素换算按本条自身 rect（禁复用 beginScrub/applyScrub 的 #mainTrack 口径·时间线坐标系）
  const pvRow = document.createElement("div");
  pvRow.className = "pv-bar-row";
  const playBtn = document.createElement("span");
  playBtn.className = "pv-play";
  playBtn.title = t("edit.pv.playTitle");
  playBtn.innerHTML = iconHtml("play", 18);
  playBtn.addEventListener("click", () => togglePlay());
  const pauseBtn = document.createElement("span");
  pauseBtn.className = "pv-pause";
  pauseBtn.title = t("edit.pv.playTitle");
  // 批 M3 D1（节点门 B 档打回）：播放中 .pv-play 被 .edit-player.playing 规则隐藏（edit.css:41）
  //   → 屏上唯一可见播控 = .pv-pause。此前此处无绑定 = 死键，鼠标暂停不可达（原生条已由 T3 隐藏）。
  pauseBtn.addEventListener("click", () => togglePlay());
  const scrub = document.createElement("div");
  scrub.className = "pv-scrub";
  scrub.title = t("edit.pv.scrubTitle");
  const knob = document.createElement("span");
  knob.className = "pv-knob";
  scrub.appendChild(knob);
  const timeLabel = document.createElement("span");
  timeLabel.className = "pv-time";
  scrub.addEventListener("mousedown", (e) => beginPvScrub(e));
  pvRow.appendChild(playBtn);
  pvRow.appendChild(pauseBtn);
  pvRow.appendChild(scrub);
  pvRow.appendChild(timeLabel);
  pl.appendChild(pvRow);
  hydrateIcons(pl);
  return pl;
}
// 批 M3 T2：自绘进度条拖动链（beginScrub :2493 同款范式——document 级 move/up·防拖出松手卡旗）。
//   move：像素按**本条自身 rect** 换算（禁复用 #mainTrack 口径——那是时间线坐标系·复用则全链静默错位）
//   → scrubClampSec 钳位（与时间线尺同钳·门在本处 _scrubbing 已置真）→ seekTo → 视口跟随。
function beginPvScrub(e) {
  const bar = S && S.root && S.root.querySelector("#editPlayer .pv-scrub");
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const width = rect.width || 0;
  if (!width) return;                          // 桩无布局引擎·零宽不动作（无从换算）
  S._scrubbing = true;
  document.body.classList.add("noselect");
  const mv = (ev) => {
    if (!S || !S._scrubbing) return;
    const rr = bar.getBoundingClientRect();
    const w = rr.width || 0;
    if (!w) return;
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rr.left) / w));
    // 插播改口径（老板 2026-10-09「进度条进度节点和鼠标错位」）：换算分母与 knob 渲染同源
    //   actualFilmEndSec——旧乘 filmEndSec 在含占位段项目（计划>实际）上：鼠标 50% →秒=计划半程
    //   →knob=秒/实际 钳 100% 冲顶=错位。统一后进度条全域=实际成片（渲染/拖动/文案三口径一致·
    //   占位区在轨道上无区域=与 R-41「游标只可在已完成片段拖」同精神）。
    const end = actualFilmEndSec(es().mainClips, es().audioClips);
    seekTo(scrubClampSec(es().mainClips || [], ratio * end));
    followPlayheadIntoView();
  };
  const up = () => {
    if (S) S._scrubbing = false;
    document.body.classList.remove("noselect");
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  mv(e);   // 按下即落点（与 beginScrub 的 applyScrub(e) 同款·按下即定位）
}
export { buildPlayer, buildClipEl };

function buildSplitH() {
  const sp = document.createElement("div");
  sp.className = "split-h";
  sp.id = "splitEdit";
  sp.title = t("edit.splitBar.hTitle");
  sp.addEventListener("mousedown", (e) => {
    const tl = document.querySelector(".edit-root .timeline, .edit-root [class*=timeline]");
    if (!tl) return;
    const h0 = tl.getBoundingClientRect().height;
    const y0 = e.clientY;
    document.body.classList.add("noselect");
    const mv = (ev) => {
      // 老板走查快批④：dy 方向对齐原型 v43 :4229-4234（nh = h + (y - ev.clientY)）——拖条跟手：
      //   下拖 = 时间线变矮 / 播放器变高（修复批 264e7d2 落时 dy 反号 → 拖条逆着手上滑，老板实测「方向反了」）
      const nh = Math.max(120, Math.min(560, h0 + (y0 - ev.clientY)));
      tl.style.height = nh + "px";
      tl.style.flex = "0 0 auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("noselect");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });
  return sp;
}

function buildSplitPv() {
  const sp = document.createElement("div");
  sp.className = "split-pv";
  sp.title = t("edit.splitBar.pvTitle");
  sp.addEventListener("mousedown", (e) => {
    const player = document.getElementById("editPlayer");
    if (!player) return;
    const h0 = player.getBoundingClientRect().height;
    const y0 = e.clientY;
    document.body.classList.add("noselect");
    const mv = (ev) => {
      // 老板走查快批⑤：dy 方向对齐原型 v43 :6599（nh = h + (ev.clientY - y)）——拖条在播放器下方，
      //   下拖 = 播放器变高（跟手）；旧实现 dy 反号（下拖反把播放器压扁、拖条逆手），同快批④ split-h 同款符号错。
      // F75（老板 2026-10-02 复验回执⑥第 3 项「播放器的放大有限制」）：原型的 min(520, ·) 天花板撤除，
      //   放大只受拖拽行程约束；120px 下限保留（防播放器被拖没致布局塌）。flex:0 0 auto 令用户拖定的
      //   高度退出 flex 分摊——不被兄弟节点/回缩挤回（初始未拖时仍 flex:1 自适应填充，不受影响）。
      const nh = Math.max(120, h0 + (ev.clientY - y0));
      player.style.height = nh + "px";
      player.style.flex = "0 0 auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("noselect");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
  return sp;
}

// T5 F-2: 缩放锚点补偿（增量式·批 G-a 裁决 2）——scrollLeft += t×(pxs新−pxs旧)：
//   视口位 t 不变的充要式，与 gutter 常数/rect 取值时机全解耦，上限交浏览器钳。
//   调用方须在 writeEs→renderAll 同步返回后执行（内容仍旧宽时浏览器按旧 scrollWidth
//   上限钳位 → 锚漂·B-E4）；Δpxs=0（clampZoom 边界）零动作。
function zoomAnchorNudge(tlScroll, t, pxsOld) {
  const d = S.pxs - pxsOld;
  if (!d || !tlScroll) return;
  S._progScroll = true;   // T6：程序化赋值豁免——缩放锚补偿的 scroll 事件不得置用户抑制窗（§五 跟随优先）
  tlScroll.scrollLeft += t * d;
}

// T6 F-1（批 G-a）：自动跟随——游标出视口右缘 → 推式推 scrollLeft（不跳变·游标落右缘内 40px）。
//   内容坐标式：contentX = phRect.left − tlRect.left + tl.scrollLeft（实测 rect·不引入 104 常数）；
//   仅右缘：contentX > scrollLeft+clientWidth−40 → scrollLeft = contentX−clientWidth+40
//   （播放/拖游标=时间前进向·左缘无对称·方案 §六 5）。推进点三处共用：phRafLoop 播放分支 /
//   pvTick 壁钟 / applyScrub（拖游标）；不挂 renderPlayhead（6 处调用含暂停态 seek·会误跟）。
//   用户滚动抑制窗：wheel 横滚/滚动条拖动（scroll 事件）置 _userScrollUntil=now+2000，窗内不推
//   （用户回滚不打架·游标重新入窗自然恢复）；程序化豁免 _progScroll——scroll 事件不区分程序赋值，
//   跟随/缩放锚自身赋值触发的 scroll 事件消费之不置窗（否则推一次停 2s 跳跟·v3 B-E2）。
function followPlayheadIntoView() {
  const tl = S.root.querySelector("#tlScroll");
  const ph = S.root.querySelector("#playhead");
  if (!tl || !ph || !tl.clientWidth) return;    // 折叠/无视口几何不推（clientWidth 0 = 无从跟随）
  if (Date.now() < S._userScrollUntil) return;  // 用户滚动抑制窗内不抢
  const contentX = ph.getBoundingClientRect().left - tl.getBoundingClientRect().left + tl.scrollLeft;
  if (contentX > tl.scrollLeft + tl.clientWidth - 40) {
    S._progScroll = true;                       // 程序化豁免：自身赋值触发的 scroll 事件不置抑制窗
    tl.scrollLeft = contentX - tl.clientWidth + 40;
  }
}

function buildTimeline() {
  const tl = document.createElement("div");
  tl.className = "timeline";
  tl.id = "tlPanel";
  tl.innerHTML = `
    <div class="edit-title">
      <span class="hint-main">${t("edit.tl.hint")}<b>${t("edit.tl.hintZoom")}</b></span>
      <span class="zoomctl">
        <span class="zbtn" data-zoom="-">－</span>
        <input type="range" id="zoomRange" min="12" max="96" step="2" value="${S.pxs}">
        <span class="zbtn" data-zoom="+">＋</span>
        <b id="zoomPct" class="num">${zoomPct(S.pxs)}%</b>
      </span>
      <span id="phTime" class="num" title="${t("edit.tl.phTimeTitle")}">00:00</span>
      <span class="tl-collapse" id="tlCollapseBtn" data-h3-role="timeline-collapse-toggle" title="${t("edit.tl.collapseTitle")}" style="border:1px solid var(--line);border-radius:8px;padding:1px 8px;cursor:pointer;color:var(--txt2);user-select:none">⌄</span>
    </div>
    <div class="tl-scroll" id="tlScroll">
      <div class="ruler" id="ruler"></div>
      <div class="tl-row" data-track="main"><span class="tl-lab">${t("edit.tl.trackMain")}<span class="tbtns"><span class="mbtn" id="muteMain" title="${t("edit.tl.muteTitle")}">M</span><span class="mbtn ico" data-flag="locked" title="${t("edit.tl.lockTitle")}">🔒</span><span class="mbtn ico" data-flag="hidden" title="${t("edit.tl.hideTitle")}">👁</span></span></span>
        <div class="tl-track" id="mainTrack"><span class="playhead" id="playhead" style="left:0"><span class="ph-head" id="phHead">00:00</span></span></div>
      </div>
      <!-- 批5-R53-TC：备选轨改动态多轨——行按代际需要生成（[data-track="alt-N"]·renderTracks），
           无该代际候选不出现（单条硬编码常显行退役·R-S1 静态 alt 键随件退役） -->
      <div class="tl-row" data-track="audio"><span class="tl-lab">${t("edit.tl.trackAudio")}<span class="tbtns"><span class="mbtn" id="muteAudio" title="${t("edit.tl.muteTitle")}">M</span><span class="mbtn ico" data-flag="locked" title="${t("edit.tl.lockTitle")}">🔒</span><span class="mbtn ico" data-flag="hidden" title="${t("edit.tl.hideTitle")}">👁</span></span></span>
        <div class="tl-track" id="audioTrack"></div>
      </div>
      <div class="tl-row" data-track="audio"><span class="tl-lab">${t("edit.tl.trackBgm")}<span class="tbtns"><span class="mbtn" id="muteBgm" title="${t("edit.tl.muteTitle")}">M</span><span class="mbtn ico" data-flag="locked" title="${t("edit.tl.lockTitle")}">🔒</span><span class="mbtn ico" data-flag="hidden" title="${t("edit.tl.hideTitle")}">👁</span></span></span>
        <div class="tl-track" id="bgmTrack"></div>
      </div>
    </div>`;
  // 缩放（T5 F-2：三入口统一增量式锚点补偿——滑杆/±钮锚=游标 S.phTime·wheel 锚=鼠标位）
  const tlScroll = tl.querySelector("#tlScroll");
  tl.querySelector("#zoomRange").addEventListener("input", (e) => {
    const pxsOld = S.pxs;
    writeEs({ zoom: clampZoom(+e.target.value) });
    zoomAnchorNudge(tlScroll, S.phTime, pxsOld);
  });
  tl.querySelectorAll(".zbtn").forEach((b) => {
    b.addEventListener("click", () => {
      const pxsOld = S.pxs;
      writeEs({ zoom: clampZoom(S.pxs + (b.dataset.zoom === "+" ? 8 : -8)) });
      zoomAnchorNudge(tlScroll, S.phTime, pxsOld);
    });
  });
  tl.querySelector("#muteMain").addEventListener("click", () => toggleMute("main"));
  tl.querySelector("#muteAudio").addEventListener("click", () => toggleMute("audio"));
  // 批 J-P4：BGM 轨与分离音频轨同属 data-track="audio"（音频一条轨·两个显示 lane）——M/🔒/👁
  //   三钮两行各一组、口径同一（mutedAudio / tracks.audio 不新增 store 键·数据层零改）
  tl.querySelector("#muteBgm").addEventListener("click", () => toggleMute("audio"));
  // S3-2 T1：轨道头 🔒 / 👁 两钮（各轨一行一组·形态同款 .mbtn；批 J-P4 后 audio 头两行）
  tl.querySelectorAll(".mbtn[data-flag]").forEach((b) => {
    b.addEventListener("click", () => toggleTrackFlag(b.closest(".tl-row").getAttribute("data-track"), b.dataset.flag));
  });
  // 游标 scrub（ruler / 游标头两入口·v43 :4155-4161）——批 I-P2 T10（F-10）起主轨空白
  //   改框选，scrub 收敛到刻度尺与游标头（方案 §一 T10：空白拖改框选·ruler 保持 scrub）
  const ruler = tl.querySelector("#ruler");
  const mainTrack = tl.querySelector("#mainTrack");
  ruler.addEventListener("mousedown", (e) => beginScrub(e, 0));
  mainTrack.addEventListener("mousedown", (e) => {
    if (e.target.closest(".clip, .trans-btn")) return; // T7: 段体/转场标记走各自入口·不起框选
    beginMarquee(e);   // 批 I-P2 T10（F-10）：主轨空白按下起框选
  });
  // 批 I-P2 T10（F-10）：音频轨空白同起框选（批5-R53-TC 起备选为动态多轨——框选/双击监听随行挂·renderTracks）
  tl.querySelector("#audioTrack").addEventListener("mousedown", (e) => {
    if (e.target.closest(".clip-audio")) return; // 音频条走拖拽/修剪入口·不起框选（同主轨 T7/备选 10cc8a3 口径）
    beginMarquee(e);
  });
  tl.querySelector("#bgmTrack").addEventListener("mousedown", (e) => {
    if (e.target.closest(".clip-audio")) return; // 同款：BGM 条走拖拽/修剪入口·不起框选
    beginMarquee(e);   // 批 J-P4：BGM lane 同起框选
  });
  // 批1-T5 · T4②：段块双击 → 跳分镜表行（1.0 timeline.js:237 段块 dblclick → :961 _jumpToShotRow）
  mainTrack.addEventListener("dblclick", (e) => {
    const tb = e && e.target;   // #89 FIX-1：局部名 t→tb（原名影蔽 i18n 取词函数·块内取词调用会变 TypeError）
    const clip = (tb && typeof tb.closest === "function") ? tb.closest(".clip") : null;
    if (!clip) return;
    const segId = (clip.dataset && clip.dataset.segId) || "";
    if (!segId) {
      showToast("info", t("edit.tl.noShotAnchor"));
      return;
    }
    jumpToShotRow(segId);
  });
  // 批 B T2: 备选轨段块双击 → 播该候选（F107「无法播放」治）——批5-R53-TC 起随动态行挂（renderTracks）。
  //   与正片轨 dblclick 语义分道: 正片双击跳分镜行, 备选双击弹播放浮层（候选是版本不是段行）。
  // 批1-T5 · T4①：折叠钮 + 状态记忆（1.0 timeline.js:1690-1732 口径）
  const collapseBtn = tl.querySelector("#tlCollapseBtn");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const willCollapse = !tl.classList.contains("is-timeline-collapsed");
      applyTimelineCollapsed(tl, willCollapse);
      writeTimelineCollapsed(willCollapse);
    });
  }
  applyTimelineCollapsed(tl, readTimelineCollapsed() === true);
  tl.querySelector("#phHead").addEventListener("mousedown", (e) => {
    e.stopPropagation();
    const r = mainTrack.getBoundingClientRect();
    beginScrub(e, e.clientX - (r.left + S.phTime * S.pxs));
  });
  // 滚轮横滚 + Ctrl+滚轮缩放（v43 :4131-4134 · T5 F-3/F-2 改造）
  tlScroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) {
      e.preventDefault();   // 时间线内消费滚轮·页面不同滚（F-3）
      S._userScrollUntil = Date.now() + 2000;   // T6：用户横滚 → 2s 抑制窗（跟随不抢·过期自然恢复）
      tlScroll.scrollLeft += (e.deltaY || 0) + (e.deltaX || 0);
      return;
    }
    e.preventDefault();
    const pxsOld = S.pxs;
    const t = secAtClientX(e.clientX);   // 锚=鼠标位·须按旧 pxs 取（写后 S.pxs 已变·鼠标下真实秒）
    writeEs({ zoom: clampZoom(S.pxs + (e.deltaY < 0 ? 6 : -6)) });
    zoomAnchorNudge(tlScroll, t, pxsOld);   // 补偿须在 writeEs→renderAll 同步返回后（B-E4）
  }, { passive: false });
  // T6 F-1：滚动条拖动信号（scroll 事件）→ 用户滚动抑制窗。程序化豁免=一次性消费 flag：
  //   跟随/缩放锚赋值前置 _progScroll，其触发的 scroll 事件在此消费掉不置窗（v3 B-E2——
  //   不豁免则跟随自身赋值自我置位 → 推一次停 2s 跳跟）；真机 scroll 事件滞后一帧，消费式
  //   与赋值时序解耦（wrap 式同步 flag 挡不住异步事件）。
  tlScroll.addEventListener("scroll", () => {
    if (S._progScroll) { S._progScroll = false; return; }
    S._userScrollUntil = Date.now() + 2000;
  });
  return tl;
}

// ============================================================================
// 批1-T5 · T4①：时间线折叠（1.0 components/timeline.js:1690-1732 口径）
//   折叠 = 时间线区收为条状（.tl-scroll 隐藏 + 高度 32px）；展开 = 还原 CSS 默认态；
//   状态记忆 localStorage h3gui_timeline_collapsed（1.0 :1545 同名键·"1"/"0"）。
// ============================================================================
const TL_COLLAPSED_KEY = "h3gui_timeline_collapsed";
const TL_COLLAPSED_H = 32;   // 1.0 :1542

function _tlStorage(storage) {
  if (storage !== undefined) return storage;
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

export function readTimelineCollapsed(storage) {
  try {
    const s = _tlStorage(storage);
    if (!s) return null;
    const raw = s.getItem(TL_COLLAPSED_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch (_e) { return null; }
}

export function writeTimelineCollapsed(collapsed, storage) {
  try {
    const s = _tlStorage(storage);
    if (!s) return;
    s.setItem(TL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch (_e) { /* localStorage 不可用（隐私模式/配额满）→ 静默吞 */ }
}

export function applyTimelineCollapsed(tl, collapsed) {
  if (!tl) return;
  const scroll = tl.querySelector(".tl-scroll");
  const btn = tl.querySelector("#tlCollapseBtn");
  if (collapsed) {
    tl.classList.add("is-timeline-collapsed");
    tl.style.height = TL_COLLAPSED_H + "px";
    tl.style.minHeight = "0";
    tl.style.padding = "6px 12px";
    if (scroll) scroll.style.display = "none";
  } else {
    tl.classList.remove("is-timeline-collapsed");
    tl.style.height = "";
    tl.style.minHeight = "";
    tl.style.padding = "";
    if (scroll) scroll.style.display = "";
  }
  if (btn) {
    btn.textContent = collapsed ? "⌃" : "⌄";
    btn.setAttribute("title", collapsed ? t("edit.tl.expandTitle") : t("edit.tl.collapseTitle"));
  }
}

// ============================================================================
// 批1-T5 · T4②：段块双击 → 跳分镜表对应行（1.0 timeline.js:237,961 口径）
//   跨 TAB：写 sessionStorage 锚 gui13.gotoSeg（与画布双击段节点同通道·canvas.js:1769）
//   + 路由 hash 切 setup TAB（壳无 showView 函数——切 TAB 走路由状态赋值重渲·shell.js:1295-1345）；
//   落点消费在 segcards.mount（[data-sid] 行 scrollIntoView + 1.5s 高亮闪烁）。
// ============================================================================
export function jumpToShotRow(segId) {
  const id = String(segId || "");
  if (!id) return false;
  const pid = (S && S.projectId) || "";
  if (!pid) return false;
  try { sessionStorage.setItem("gui13.gotoSeg", id); } catch (_e) { /* 隐私模式忽略 */ }
  if (typeof window !== "undefined" && window && window.location) {
    window.location.hash = `#/project/${encodeURIComponent(pid)}?tab=setup`;
  }
  return true;
}

// ===== 渲染 =====

// 批 J-P4：BGM 条判据 = id 带 bgm- 前缀（工具条「BGM」上传落库形态·:402 同款）——
//   显示层分 lane 用（BGM 轨 / 分离音频轨）；数据层不据此分流（导出/预听仍一条 audioClips 数组）。
function isBgmClipOf(clip) { return String((clip && clip.id) || "").startsWith("bgm-"); }

function renderAll() {
  if (!S || !S.root) return;
  const state = es();
  const pxs = S.pxs;
  // 缩放控件文本同步（zoomRange/zoomPct 随每次渲染刷新——zbtn/Ctrl+滚轮/store 外部变更三入口同源）
  const range = S.root.querySelector("#zoomRange");
  const pct = S.root.querySelector("#zoomPct");
  if (range && +range.value !== pxs) range.value = pxs;
  if (pct) pct.textContent = zoomPct(pxs) + "%";
  renderTracks(state, pxs);
  renderRuler(state, pxs);
  renderPlayhead(pxs);
  renderMute(state);
  renderTrackFlags(state);
  renderPlayer(state);
}

// 批1-T7（F-111）音频轴条左沿 = 自身轴窗起点：前序兄弟按**全量 audioClips** 累加
//   （锚定条也占轴位·哑位语义）+ 自身轴边距 axisTrimlOf(clip)。
//   与预听 audioWindowAt（clipAtPlayhead 全量数组直用）/ 导出 trackWindowsOf(auds) 三处同式，
//   改渲染不得单侧偏离（"看着在 A、听着/导出在 B"）。clip 可传预览态替换条（修剪拖拽中 triml 未落库）。
function axStartAt(auds, idx, clip) {
  const w = trackWindowsOf(auds)[idx];
  return w ? (w.start - axisTrimlOf(w.clip) + axisTrimlOf(clip)) : axisTrimlOf(clip);
}

// ===== 批5-R53-TE：换序动画（剪映式观感·工程裁量记档：left/transform transition·弃 FLIP）=====
//   renderTracks 全量重建 DOM → transition 无从自发触发。改按 **数据几何快照** 驱动：上一帧
//   各片段轴位（秒·缩放不变量）存 _clipGeom（clipKey → {x, si}），本次渲染逐片段对位——位变者
//   挂 .tl-anim（CSS transition:transform）+ 初始 translateX(旧−新) 双 rAF 归零 → 滑向终位。
//   弃 FLIP：无需量 DOM（无布局环境同可算·秒几何纯数据）。transform 布局中性 → offsetLeft/
//   offsetWidth 恒终位，拖拽落点判定（insertionIndex/computeSnap 全读 offsetLeft + 数据式
//   clipBodyStart）不被动画中间态污染 → 拖拽中无需禁用 transition（记档·无拖拽中禁用类）。
//   R53域重对齐-T3: 上岗=对调（只换 file/ver·槽位不动·不新建 retired）→ 无新条目无位变
//   → 对调不触发过渡类（原「新 retired 滑入」签名随 retired 建账退役）。
//   无 rAF 环境（Node 桩）只挂类不设初始位移——断言面稳定；zoom 改 pxs 不改秒几何 → 缩放不触发动画。
const _clipGeom = new Map();       // clipKey → { x: 秒轴位, si: 组内步进序 }（每次渲染重建）
let _animSettleRaf = 0;
const _animPendingEls = [];
// 位变片段：挂过渡类 +（有位移且环境有 rAF 才）设初始位移排队归零。dx=0 只挂类
//   ——transition 无属性变化不触发·纯语义标记）。时长见 edit.css .tl-anim（.18s micro-transition 惯例）。
function animClipSlide(el, dxPx) {
  el.classList.add("tl-anim");
  if (!dxPx || typeof requestAnimationFrame !== "function") return;
  el.style.transform = "translateX(" + dxPx + "px)";
  _animPendingEls.push(el);
  if (_animSettleRaf) return;
  _animSettleRaf = requestAnimationFrame(() => {
    _animSettleRaf = 0;
    // 双 rAF：首帧让初始位移提交参与样式重算，次帧归零 → transition 从旧位滑向终位
    requestAnimationFrame(() => {
      const els = _animPendingEls.splice(0, _animPendingEls.length);
      for (const n of els) n.style.transform = "";
    });
  });
}

function renderTracks(state, pxs) {
  const main = S.root.querySelector("#mainTrack");
  const audio = S.root.querySelector("#audioTrack");
  const bgm = S.root.querySelector("#bgmTrack");   // 批 J-P4：BGM 轨（与分离音频轨同属 audio 数据·显示分 lane）
  // 批 C T4（①A6）多选态保持: 选中态 = 纯 DOM class .sel（写入仅 click 委托 / Ctrl+A 两处），
  //   本函数全量重建三轨片段 → 任何 writeEs / 撤销 / 重做后选中集全丢。重建前快照选中键集，
  //   重建后按 clipKey 回查回填（键带轨前缀 main:/alt:/audio: → 主备选同 segId 不串选）。
  //   查无此键者（已删/已移轨）自然不回填 → 不复活。
  const selKeys = new Set(selAll().map((el) => el.dataset.clipKey).filter(Boolean));
  // TE: 上一帧几何快照（比较用只读副本）+ 本帧快照（渲染中逐片段回填·函数出口即换代）
  const prevGeom = new Map(_clipGeom);
  _clipGeom.clear();
  // 保留 playhead 节点
  const ph = main.querySelector(".playhead");
  main.querySelectorAll(".clip, .trans-btn").forEach((n) => n.remove());
  // TE: 主轨换序动画——flow 轴位（秒）= 前序 width+marginLeft 累计 + 自身 marginLeft（同 flex 流几何）
  let mainCum = 0;
  (state.mainClips || []).forEach((c) => {
    const el = buildClipEl(c, pxs);
    const key = "main:" + (c.segId || c.n);
    const x = mainCum + axisTrimlOf(c);
    mainCum += effDurOf(c) + axisTrimlOf(c);
    const prev = prevGeom.get(key);
    if (prev && (prev.x !== x || prev.si !== 0)) animClipSlide(el, (prev.x - x) * pxs);
    _clipGeom.set(key, { x, si: 0 });
    main.appendChild(el);
  });
  if (ph) main.appendChild(ph);
  // S3-3 T7: 交界转场标记（相邻两项之间·重渲染即重建）——绝对定位 x = 前段累积末端（F4: 有效时长轴）
  let jx = 0;
  const mains = state.mainClips || [];
  for (let i = 0; i < mains.length - 1; i++) {
    jx += (effDurOf(mains[i]) + axisTrimlOf(mains[i])) * pxs;
    main.appendChild(buildTransBtn(mains[i], mains[i + 1], jx));
  }

  // 批5-R53-TA（#18）锚点查表（备选/音频锚定共用）: segId → 主轨轴窗（F-111 同式）
  const parentWins = new Map(trackWindowsOf(state.mainClips || []).map((w) => [String((w.clip || {}).segId || ""), w]));
  const contentEndSec = axisLenSec(filmEndSec(state.mainClips, state.audioClips));   // #21② 右界钳制备用（内容末·与 :minW 同源）
  // ===== 批5-R53-TC：备选轨 = 动态多轨（行按代际需要生成）=====
  //   行清单 = 本次渲染实际需要的代际（altChains 权威分组·buildAltChains 随渲染重建读取）；
  //   无该代际候选不出现（单条硬编码常显行退役·R-S1 静态 alt 键随件退役）；行名「备选轨道 N」。
  //   行内落位沿用 T-A 锚点（父段轴窗起点）+ B1 组内步进（组 = 同 segId 同代·右缘 si×step
  //   比例自适应收边·#21②/B审M1'）；现行候选回落 buildClipEl 通用路径=全尺寸块（徽章退役·
  //   R53域重对齐-T4·版本区分靠块上 ver 显示）；
  //   B4 动态轨形态 {hidden} —— locked 非动态轨语义（行头只挂 👁）。行随渲染整行重建 →
  //   框选/双击/隐藏钮监听随行挂。altIdx 戳 = 平铺数组序（ensureAltCid 多 lane data 直查回填锚）。
  for (const r of altRowEls()) r.remove();
  const altGenMap = altGenMapOf(state.altClips || []);
  const byGen = new Map();   // gen -> [{c, i}]（i = 平铺数组序）
  (state.altClips || []).forEach((c, i) => {
    const g = altGenOf(c, altGenMap);
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push({ c, i });
  });
  // R53域重对齐-T4（P4）: 渲染中灰占位块——扫描 project.runs 行（running:true &&
  //   kind∈{rerun,seg_edit} && sids 非空 && 行龄<24h·同 submit-bar 对账行龄门口径），
  //   行内每个 sid 按 clip.sid 对号（F106 口径·无 sid 段跳过），同段多行去重，该段现有
  //   代际 maxGen+1（逐段算·I2-3 并发多段各占各轨）落灰占位块。纯 DOM 态：不写 altClips，
  //   非 .clip 类 → 拖拽/✕/✓/双击预览/框选/落点计数天然不认；行 running 清除（终态）后
  //   重渲即消失——出真条目由 rebuild 接管；刷新时 running 行仍在 → 灰块重现。
  const grayByGen = new Map();   // gen -> [segId, ...]（不同段可撞同代际·各一枚）
  if (S && S.projectId) {
    const proj = storeLoad(S.projectId);
    const segBySid = new Map((state.mainClips || []).filter((c) => c && c.sid).map((c) => [String(c.sid), c]));
    const seenSegs = new Set();
    for (const r of ((proj && Array.isArray(proj.runs)) ? proj.runs : [])) {
      if (!r || r.running !== true || (r.kind !== "rerun" && r.kind !== "seg_edit")) continue;
      if (!Array.isArray(r.sids) || !r.sids.length) continue;
      if (!(Date.parse(r.at) > Date.now() - 24 * 3600 * 1000)) continue;
      for (const sid of r.sids) {
        const seg = segBySid.get(String(sid));
        if (!seg || !seg.segId || seenSegs.has(String(seg.segId))) continue;
        seenSegs.add(String(seg.segId));
        let maxGen = 0;
        for (const a of (state.altClips || [])) {
          if (a && String(a.segId || "") === String(seg.segId)) maxGen = Math.max(maxGen, altGenOf(a, altGenMap));
        }
        const gg = maxGen + 1;
        if (!grayByGen.has(gg)) grayByGen.set(gg, []);
        grayByGen.get(gg).push(String(seg.segId));
      }
    }
  }
  const tlScroll = S.root.querySelector("#tlScroll");
  const refRow = tlScroll ? tlScroll.querySelector('.tl-row[data-track="audio"]') : null;
  const altLanes = [];
  for (const g of [...new Set([...byGen.keys(), ...grayByGen.keys()])].sort((a, b) => a - b)) {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.setAttribute("data-track", "alt-" + g);
    row.innerHTML = '<span class="tl-lab">' + t("edit.tl.altTrack") + g
      + '<span class="tbtns"><span class="mbtn ico" data-flag="hidden" title="${t("edit.tl.hideTitle")}">👁</span></span></span>'
      + '<div class="tl-track"></div>';
    const laneEl = row.querySelector(".tl-track");
    row.querySelector(".mbtn[data-flag]").addEventListener("click", () => toggleTrackFlag("alt-" + g, "hidden"));
    laneEl.addEventListener("mousedown", (e) => {
      if (e.target.closest(".clip")) return; // 段体走自有入口·不起框选（同主轨 T7 口径·备选轨无 trans-btn）
      beginMarquee(e);   // 批 I-P2 T10（F-10）：空白框选（三轨统一语义）
    });
    // 批 B T2：备选段块双击 → 播该候选（F107·与正片轨 dblclick 分道: 双击弹播放浮层不跳分镜行）
    laneEl.addEventListener("dblclick", (e) => {
      const t = e && e.target;
      if (t && typeof t.closest === "function" && t.closest(".cplay")) return; // ▶ 钮自有 click 入口
      const clip = (t && typeof t.closest === "function") ? t.closest(".clip") : null;
      if (!clip) return;
      previewClip(clip);
    });
    // 组内序按（segId|代际）计——B1: 同代同轨·轨内同锚组内步进偏移（跨代不同轨·不混计）
    //   R53域重对齐-T4: 徽章退役 → 现行候选回归全块通用路径，组内序/计数含现行
    //   （left 恒=锚点·右缘按组内序内缩 si×step 比例自适应防重叠防越界——B审M1/M1'·落位式见下方锚定分支）
    const grpCount = new Map();   // segId -> 该代组全块数（title「第i条/共n条」）
    const genEntries = byGen.get(g) || [];   // 灰块独占代际（P4 maxGen+1）无既有条目 → 空组
    for (const { c } of genEntries) {
      const k0 = String(c.segId || "");
      grpCount.set(k0, (grpCount.get(k0) || 0) + 1);
    }
    const grpSeen = new Map();    // segId -> 已落位组内序（i·第 i 条右缘内缩 i×step）
    let laneFlowCum = 0;          // TE: 无父段回退条目的 flow 轴位累计（秒·绝对定位条不占流）
    for (const { c, i } of genEntries) {
      const k = String(c.segId || "");
      const pw = parentWins.get(k);
      const el = buildClipEl(c, pxs);
      el.dataset.altIdx = String(i);
      const key = "alt:" + (c.cid || c.segId || c.n);   // TE 对位键（同 buildClipEl clipKey 口径）
      let gx = 0, gsi = 0, leftPx = 0;   // TE 几何: 秒轴位 + 组内步进序 + 实际落位 px（位变动画补偿用）
      if (pw) {
        const si = grpSeen.get(k) || 0;
        grpSeen.set(k, si + 1);
        el.style.position = "absolute";
        el.style.top = "0px";
        el.style.height = "100%";   // 复验修复①（R-53 打回）: 绝对定位脱离 .tl-track stretch 拉伸, 高度须自补（机制同 .clip-audio 基类 height:100%）——否则塌为内容高
        // #21②+B审M1 右缘收缩: left 恒=锚点（零漂移·治老板「向右飘逸几十像素」感知的根），
        //   组内第 si 条改从右缘内缩 si×step: width = min(块宽,窗宽) − si×step——右缘恒 ≤ 窗末不越界
        //   （旧 left=min(锚+si×24, 窗末−块宽) 钳制在宽=窗宽时整组钳回同位完全重叠·B审M1）。
        //   M1'（复核B §4-1）: 固定 24 步长+60px 地板是绝对像素——有效宽 ≤84px 时组内第 2 块起即与
        //   前块完全同位（低缩放/窄块形态）→ step/floor 随有效宽比例化: step=clamp(有效宽×0.12,8,24)
        //   （相邻块差 ≥8px 恒可分辨）·floor=clamp(有效宽×0.3,24,60)（防负/零宽可点下限）。
        //   极端多块（si×step 吃穿有效宽）多块同 floor rect 全同（后者被盖·弹窗仍可访问）——取舍记档。
        leftPx = pw.start * pxs;
        el.style.left = leftPx + "px";
        const availPx = Math.min(effDurOf(c) * pxs, Math.min(pw.end, contentEndSec) * pxs - leftPx);
        const step = Math.min(24, Math.max(8, availPx * 0.12));
        const floorPx = Math.min(60, Math.max(24, availPx * 0.3));
        el.style.width = Math.max(floorPx, availPx - si * step) + "px";
        el.style.marginLeft = "0px";
        el.title = (el.title ? el.title + " " : "") + t("edit.alt.groupTitle", { i: si + 1, n: grpCount.get(k) });
        gx = pw.start; gsi = si;
      } else {
        gx = laneFlowCum + axisTrimlOf(c);
        laneFlowCum += effDurOf(c) + axisTrimlOf(c);
        leftPx = gx * pxs;
      }
      const prev = prevGeom.get(key);
      if (prev && (prev.x !== gx || prev.si !== gsi)) {
        // TE: 轨内位变（含 B1 组内步进序互换）→ 旧实际位横滑向新实际位（快照恒存实际落位 left）
        //   （B审M1 后 left 恒=锚点: 组内换序只变 width·补偿量恒 0 不闪跳；跨锚位变/回退条入锚
        //   仍按两帧实际落位滑——补偿与落位同读 leftPx 单一几何源·两处同步）
        animClipSlide(el, prev.left - leftPx);
      }
      _clipGeom.set(key, { x: gx, si: gsi, left: leftPx });
      laneEl.appendChild(el);
    }
    // P4 灰占位块: 落本代际轨·锚父段轴窗（宽=段有效时长·与真条目落位同式）；无交互见组头注
    for (const segId of (grayByGen.get(g) || [])) {
      const segWin = parentWins.get(String(segId));
      const el = document.createElement("span");
      el.className = "clip-rendering";
      el.dataset.segId = segId;
      el.textContent = t("edit.rendering");
      if (segWin) {
        const seg = (state.mainClips || []).find((c) => c && String(c.segId || "") === String(segId));
        el.style.position = "absolute";
        el.style.top = "0px";
        el.style.height = "100%";
        el.style.left = (segWin.start * pxs) + "px";
        el.style.width = ((seg ? effDurOf(seg) : (segWin.end - segWin.start)) * pxs) + "px";
      }
      laneEl.appendChild(el);
    }
    if (refRow) tlScroll.insertBefore(row, refRow); else tlScroll.appendChild(row);
    // F1（B 审修正笔）同款纪律: 动态行随渲染重建 → dragover/drop 监听随行挂（挂载时静态行才有）
    bindTrackDropListeners(laneEl);
    altLanes.push(laneEl);
  }

  audio.querySelectorAll(".clip-audio").forEach((n) => n.remove());
  bgm.querySelectorAll(".clip-audio").forEach((n) => n.remove());
  // 批 J-P4（老板 2026-10-07 两条合并）分轨 + 初始位置对齐：
  //   ① 分轨判据（数据层零改）：id 带 bgm- 前缀 = 工具条 BGM 上传条目 → BGM 轨；其余音频条
  //      （splitAV 锚定半 / 跨轨移入条 / 旧档无 id 条）→ 分离音频轨。两条 lane 同属 data-track=audio。
  //   ② 初始位置对齐：锚定半（主轨存在同 segId 段）不再按 audioClips 累积流落位，改按**父段轴窗**
  //      绝对定位（left=父段窗起点×pxs·宽=父段窗长）——与预听/导出同口径（audioWindowAt 锚定分支
  //      + exportSpec 几何随父段），故「分离后音频初始位置与对应视频对齐」。
  const auds = state.audioClips || [];
  auds.forEach((c, i) => {
    const el = document.createElement("span");
    el.className = "clip-audio";
    el.dataset.dur = c.dur;
    if (c.triml) el.dataset.triml = c.triml;
    if (c.id) el.dataset.audioId = c.id; // F2：id 身份（旧档无 id 兜底 label）
    // 批F F-T3 (F-11·顺手修不一致①): 宽=有效时长 effDur×pxs（triml 不占宽）。
    // 批1-T7（F-111）轴条分支改按**自身轴窗**绝对定位：原走 flex 流内（triml 以 margin-left 表达），
    //   而同轨锚定条皆 absolute 脱流 → 脱锚条成唯一流内子元素时落 left:0+marginLeft = 轨道最左
    //   （老板「分离音频调整后位置闪现到轨道左」根因）。改后 left = axStartAt（=导出 trackWindowsOf(auds)
    //   同式·锚定条亦占轴位）→ 与预听/导出三处同口径；BGM 条无 segId 恒走此分支，落位随之由
    //   「bgm 轨左缘」改为按轴窗（顺带修正一处既有渲染/导出不）。
    const pw = parentWins.get(String(c.segId || ""));
    if (pw) {
      el.classList.add("anchored");        // 绝对定位（edit.css .clip-audio.anchored）
      el.style.left = (pw.start * pxs) + "px";
      el.style.width = ((pw.end - pw.start) * pxs) + "px";
      el.style.marginLeft = "0px";
    } else {
      el.classList.add("axpos");            // 绝对定位（edit.css .clip-audio.axpos·与 .anchored 同式）
      el.style.left = (axStartAt(auds, i, c) * pxs) + "px";
      el.style.width = (effDurOf(c) * pxs) + "px";
    }
    el.draggable = true;
    el.textContent = c.label;
    el.dataset.clipKey = "audio:" + (c.id || c.label || "");
    appendVolBar(el, c);
    appendFadeBar(el, c); // S3-3 T9: 下缘淡化渐变条（淡入/淡出 值>0 才挂·纯视觉）
    (isBgmClipOf(c) ? bgm : audio).appendChild(el);
  });

  // 轨 minWidth = 轴长 × pxs (轴与内容对齐·v43 :4119)；备选动态行随需入列（批5-R53-TC）
  const minW = contentEndSec * pxs;
  [main, ...altLanes, audio, bgm].forEach((t) => { t.style.minWidth = minW + "px"; });
  // 修剪手柄补挂 (主轨片段)
  main.querySelectorAll(".clip").forEach((el) => {
    if (!el.querySelector(".hnd")) {
      el.insertAdjacentHTML("beforeend", '<span class="hnd L"></span><span class="hnd R"></span>');
    }
  });
  // 批F F-T3 (F-11): 音频轨片段同挂修剪手柄（空 span 不污染 label 文本·显形靠 .clip-audio:hover 规则）
  // 批 J-P4: BGM 轨同挂（两条 lane 各按自身内容补挂）
  [audio, bgm].forEach((lane) => lane.querySelectorAll(".clip-audio").forEach((el) => {
    if (!el.querySelector(".hnd")) {
      el.insertAdjacentHTML("beforeend", '<span class="hnd L"></span><span class="hnd R"></span>');
    }
  }));
  // 批 C T4（①A6）多选态回填: 三轨重建后按 clipKey 把重建前的选中集打回新节点。
  //   逐元素比对 dataset 而非 CSS.escape 选择器 —— clipKey 含 id/label 自由文本（引号等），
  //   拼进选择器需转义；且本仓测试桩无 CSS.escape。Set 命中即 O(1)，不引入转义分支。
  if (selKeys.size) {
    S.root.querySelectorAll(".clip, .clip-audio").forEach((el) => {
      if (selKeys.has(el.dataset.clipKey)) el.classList.add("sel");
    });
  }
}

// ===== 走查反馈 F6: 时间线片段多帧胶片底（老板「居中平铺+多帧叠加·类剪映」）=====
// 引擎 thumb 仅首帧（api.md §30 无 time 参数）→ 前端 canvas 采样：离屏 video 按 8 个时间点
// seek + drawImage → dataURL（同源 8940 反代·canvas 可绘）。缓存 Map<file, Promise>——固定 8 帧
// 与 zoom 无关；格数随片段宽度自适应从缓存均匀抽取。采样失败回退 .done 渐变纯色底（不阻塞渲染）。
const FS_FRAMES = 8;
const _filmCache = new Map();
let _fsVideo = null;
// 批 10-L L1-8（F90）：离屏 video 是模块级单例，采样必须串行——renderAll 一次建全部片段 DOM，
//   多段 fillFilmstrip 并发时三协程共享同一 video 互相换 vd.src → 全采到同一视频的帧
//   （老板报「三段预览图同图」），_filmCache 再把错帧钉死。串行后单例安全（src 赋值按 HTML
//   媒体元素装载算法同步把 readyState 归 HAVE_NOTHING → 下面的 loadedmetadata 等待照常生效）。
function _fsSeek(vd, t, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const on = () => { if (!done) { done = true; vd.removeEventListener("seeked", on); resolve(true); } };
    vd.addEventListener("seeked", on);
    setTimeout(() => { if (!done) { done = true; vd.removeEventListener("seeked", on); resolve(false); } }, timeoutMs);
    try { vd.currentTime = t; } catch (_e) { on(); }
  });
}
// 批 L4 · T3（R-22）: 采样画布定尺常量与纯函数——格高 64px（.fsthumb height:64·
//   .clipfilm 铺格同高）× DPR2 = 128；宽按源 vw/vh 保比。取整用 floor（与方案 T3 记的
//   16:9 → 227×128·9:16 → 72×128 一致）。元数据缺失（videoWidth/Height 读不到）回 16:9 档。
const FS_CANVAS_H = 128;
function fsCanvasWidth(vw, vh) {
  const w = Number(vw), h = Number(vh);
  if (!(w > 0 && h > 0)) return Math.floor(FS_CANVAS_H * 16 / 9);
  return Math.max(1, Math.floor(FS_CANVAS_H * w / h));
}
// 批 J-P14：导出给概况页胶片条复用（preview.js 搬同款 canvas 采样·替引擎 thumb 恒 72×128）。
//   惰性改动——只加 export 关键字，既有剪辑页内部调用与对外行为一字未动。
export async function sampleFilmstrip(file, durSec) {
  if (typeof document === "undefined") return null;
  if (!_fsVideo) {
    _fsVideo = document.createElement("video");
    _fsVideo.muted = true;
    _fsVideo.preload = "auto";
    _fsVideo.style.display = "none";
  }
  if (!_fsVideo.parentElement) document.body.appendChild(_fsVideo);
  const vd = _fsVideo;
  const key = encodeURIComponent(file);
  if (!String(vd.src || "").includes(key)) setMediaSrc(vd, "video", file);   // 批 B #13：URL 收敛单源+回落接线
  await new Promise((res) => {
    if (vd.readyState >= 1) return res();
    const on = () => { vd.removeEventListener("loadedmetadata", on); res(); };
    vd.addEventListener("loadedmetadata", on);
    setTimeout(() => { vd.removeEventListener("loadedmetadata", on); res(); }, 4000);
  });
  if (vd.readyState < 1) return null;
  const dur = Number.isFinite(vd.duration) && vd.duration > 0 ? vd.duration : (+durSec || FS_FRAMES);
  const cv = document.createElement("canvas");
  // 批 L4 · T3（R-22「全站缩略图提清晰」）: F10 的 96×54 固定档 → 按**源视频宽高比**定尺。
  //   高恒 = 格高 64 × DPR2 = 128（54 塞 64 格是放大糊·64 源按 DPR2 采样才够清晰）；
  //   宽按 vw/vh 保比（16:9 → 227×128·9:16 竖 → 72×128），drawImage 铺满同比率画布即保比不形变
  //   （旧固定档把竖版源横向拉扁 1.33×）。元数据缺失兜底回 16:9 档 = 旧 96×54 形不劣化。
  cv.height = FS_CANVAS_H;
  cv.width = fsCanvasWidth(vd.videoWidth, vd.videoHeight);
  const ctx = cv.getContext && cv.getContext("2d");
  if (!ctx) return null;
  const out = [];
  for (let i = 0; i < FS_FRAMES; i++) {
    const t = Math.min(Math.max(0.02, dur * (i + 0.5) / FS_FRAMES), Math.max(0.02, dur - 0.05));
    const ok = await _fsSeek(vd, t, 1500);
    if (!ok) { out.push(null); continue; }
    try {
      ctx.drawImage(vd, 0, 0, cv.width, cv.height);
      out.push(cv.toDataURL("image/jpeg", 0.72));
    } catch (_e) {
      out.push(null);
    }
  }
  return out.some(Boolean) ? out : null;
}
// 批 10-L L1-8（F90）：采样串行互斥队列（后到文件排队等前一个采完再换 src）
//   前一个 reject 时链继续（then(task, task) 双回调）——失败不阻断后续片段采样。
export function makeSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const p = tail.then(task, task);
    tail = p.then(() => {}, () => {});
    return p;
  };
}
let _fsEnqueue = makeSerialQueue();
// 批Gb T1（F104）单测注入位：null = 生产 sampleFilmstrip。测试注入以钉死「失败不入缓/
//   成功钉缓存」语义（桩无媒体引擎·真采样走 4s loadedmetadata 超时链路不可入毫秒级单测
//   ——同族注入位先例 _test_setCandPollInterval）。入队时捕获（采样器选择属当次渲染，
//   不随队列执行时刻漂移）。reset 同时清缓存+重建串行队列（甩掉前序用例积压的真采样任务）。
let _fsSampler = null;
export function _test_setFilmstripSampler(fn) { _fsSampler = fn; }
export function _test_resetFilmstrip() {
  _filmCache.clear(); _fsEnqueue = makeSerialQueue();
  // 批 1-T3: 连带清重试记账与在途定时器——否则 reset 后仍会补采（跨用例污染）
  for (const t of filmRetryTimers.values()) clearTimeout(t);
  filmRetryTimers.clear(); filmRetryDone.clear();
}
// R56R57-S3 T4 显示源接缝（_test_setFilmstripSampler 同族）: 播放/导出/缩略图三链取源统一走
//   postfxSrcOf——null = 生产胶合层 postfxDisplaySource（core/postfx_pipeline.js §6）。
//   播放超时上限可注入（毫秒级单测锁「3s 防卡弹窗」容错分支）。
let _postfxSrc = null;
let _previewSrcTimeoutMs = 3000;
export function _test_setPostfxDisplaySource(fn) { _postfxSrc = typeof fn === "function" ? fn : null; }
export function _test_setPreviewSrcTimeoutMs(ms) { _previewSrcTimeoutMs = typeof ms === "number" && ms > 0 ? ms : 3000; }
function postfxSrcOf(clip) {
  const pid = (S && S.projectId) || "";
  return (_postfxSrc || postfxDisplaySource)(pid, clip);
}
// 批 1-T3（F-104 残留②）: 失败摘键后不等下次 renderAll——按 file 记账（每 file 每会话一次，
//   Set 上限防永久坏源反复重采）延迟 2s 重采一次；成功则对在场 .clipfilm（该 file 对应段）
//   定向重渲回写 DOM。失败即留在 Set 内不再重试，等下次 renderAll 走常规入队链。
//   只碰剪辑页在场元素（selector 限 .clipfilm + 宿主 data-film-file 匹配），不动缓存语义
//   ——_filmCache 与概况页共用（preview.js fillFilm），重试仅补 DOM 不改共享缓存语义。
const filmRetryDone = new Set();
const filmRetryTimers = new Map();
function retryFilmstrip(file, durSec) {
  if (filmRetryDone.has(file)) return;
  filmRetryDone.add(file);
  filmRetryTimers.set(file, setTimeout(() => {
    filmRetryTimers.delete(file);
    filmstripFor(file, durSec).then((frames) => {
      if (!frames || typeof document === "undefined") return;
      document.querySelectorAll(".clipfilm").forEach((strip) => {
        const el = strip.parentElement;
        if (el && el.dataset.filmFile === file) fillFilmstrip(el, file, durSec);
      });
    });
  }, 2000));
}
// 批 J-P14：同 sampleFilmstrip —— 导出给概况页胶片条复用（连带 Map<file,Promise> 缓存 +
//   串行队列的并发上限 1）。惰性改动：剪辑页内部调用点与行为不变。
export function filmstripFor(file, durSec) {
  if (!_filmCache.has(file)) {
    const sample = _fsSampler || sampleFilmstrip;
    // F104（走查）: 采样失败（null 或 reject）不钉死缓存——摘键，下次渲染重新入队重试
    //   （此前 null 永久缓存=缩略图永久灰）。catch 仍返 null 防未处理 rejection
    //   （fillFilmstrip 的 .then 无 rejection 臂）。
    // 批 1-T3（F-104 残留①）: 含 null 的半帧数组按整体失败处理——半帧钉进缓 = 那几格恒灰到
    //   刷新。判据落在缓存闸（此处的「失败不入缓」判据）而非采样器内部：闸是唯一写 _filmCache
    //   的地方，对生产采样器与注入采样器一视同仁。
    // 批 1-T3: 摘键同时排一次延迟重试（此前只等下次 renderAll——无编辑动作则灰到刷新）。
    const onFail = () => { _filmCache.delete(file); retryFilmstrip(file, durSec); return null; };
    const ok = (frames) => frames && !frames.some((f) => !f);
    _filmCache.set(file, _fsEnqueue(() => sample(file, durSec))
      .then((frames) => (ok(frames) ? frames : onFail()))
      .catch(() => onFail()));
  }
  return _filmCache.get(file);
}
function fillFilmstrip(el, file, durSec) {
  const widthPx = parseFloat(el.style.width) || 40;
  const cells = Math.max(2, Math.min(FS_FRAMES, Math.round(widthPx / 56)));
  filmstripFor(file, durSec).then((frames) => {
    if (!frames || !el.isConnected) return;
    const strip = el.querySelector(".clipfilm");
    if (!strip) return;
    const step = FS_FRAMES / cells;
    let html = "";
    for (let i = 0; i < cells; i++) {
      const url = frames[Math.min(FS_FRAMES - 1, Math.floor(i * step))];
      html += url ? `<i style="background-image:url(${url})"></i>` : "<i></i>";
    }
    strip.innerHTML = html;
    el.classList.add("hasfilm");
  });
}

// 批5-R53-TF 命名显示层（老板口径 ledger:1919-1921/Q6/Q9/Q10）: 备选条目显示名从 clip.file 派生
//   _rN 代际——名字跟文件走·显示层·不改物理文件名/不写引擎。R-52 引擎侧文件夹命名树已上线
//   （重跑产物 file 落在 s2_r1 类目录，或文件名带 _rN）。取路径中最靠近文件的一段 `_rN` 链整段
//   （s2_r1_r1 每级独立计数·不拆末段）；只认小写 _rN（Q6/Q9 冲突裁定，大写 _R1 旧全量重跑不误吞）；
//   无 _rN 返空串 → 显示层回退现 label。纯函数随测。
export function altGenTagOf(file) {
  const parts = String(file || "").split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const stem = i === parts.length - 1 ? parts[i].replace(/\.[^.]+$/, "") : parts[i];
    if (/^(.+)(?:_r\d+)+$/.test(stem)) return stem;
  }
  return "";
}

// #92 B6：时间线/属性面板数据名显示映射（老板复验 2026-11-07：EN 模式「段1」「原版」仍中文）。
//   纯显示派生·数据零改（label/ver 生成点原样入库）；zh 模式逐字直通，en 按形态映射，
//   用户自定义名两语原样。导出仅供行为断言（同 altGenTagOf「纯函数随测」口径）。
export function dispClipLabel(label) {
  if (typeof label !== "string" || getLang() !== "en") return label;
  let m = /^段(\d+)$/.exec(label);
  if (m) return t("edit.clip.segN", { n: m[1] });
  m = /^段(\d+)·音$/.exec(label);
  if (m) return t("edit.clip.segNAudio", { n: m[1] });
  if (label === "新段·待生成") return t("edit.clip.newPending");
  m = /^重制·第(\d+)次$/.exec(label);
  if (m) return t("edit.clip.rerunLabel", { n: m[1] });
  return label;
}
export function dispClipVer(ver) {
  if (typeof ver !== "string" || getLang() !== "en") return ver;
  if (ver === "原版") return t("edit.clip.verOriginal");
  if (ver === "（新）") return t("edit.clip.verNew");
  if (ver === "副本") return t("edit.clip.verCopy");
  const m = /^第(\d+)次重制$/.exec(ver);
  if (m) return t("edit.clip.verRerun", { n: m[1] });
  return ver;
}

function buildClipEl(c, pxs) {
  const el = document.createElement("span");
  // 备选轨三系: 候选组系 cand（多候选弹层落轨）/ 旧版系 retired（✓ 采纳后的旧主轨）/
  //   重跑系 rerun（批 B T5 rebuildAltClips 落轨）——三者都在备选轨，按 isAlt 统一取
  //   备选轨身份键与外观；className 沿用 .cand 样式（rerun 系无专属 CSS 规则·不引新文件）
  const isAlt = c.kind === "cand" || c.kind === "retired" || c.kind === "rerun";
  el.className = "clip " + (c.kind === "rerun" ? "cand rerun" : (c.kind || c.state || "empty"));
  if (c.state === "done") el.classList.add("done");
  if (c.state === "warn") el.classList.add("warn");
  // B5-T4 C2：段状态左边条四色（.done/.warn 底色不动）——status 原值 → shotColor 静态映射；
  //   旧档 clip 无 status → gray 兜底（保守正确）。运行期由 submit-bar/rerun_flow onTick
  //   每 tick 幂等重刷（renderAll 重建片段 DOM 会丢属性·3s 重刷自愈）。
  el.dataset.shotColor = shotColor(c.status);
  el.dataset.segId = c.segId || "";
  el.dataset.cid = c.cid || "";   // 批 B T1: 备选候选身份（老档无此字段 → 读侧懒生成补齐）
  el.dataset.n = c.n || "";
  el.dataset.dur = c.dur;
  el.dataset.triml = c.triml || 0;
  el.dataset.full = c.full != null ? c.full : c.dur;
  el.dataset.ver = c.ver || "";
  // 批 B T1 ⑤: 备选候选 clipKey 走 "alt:"+cid —— 旧口径错标 "main:"+segId, 与主轨同段片段同名
  //   → 属性面板/淡化按 clipKey 回查轨内节点会抓回主轨元素, 编辑落到主轨片段上（④N7）
  el.dataset.clipKey = isAlt ? "alt:" + (c.cid || c.segId || c.n) : "main:" + (c.segId || c.n);
  // B4-T3 黄条（title 级最小视觉）：已精修段 hover 提示（applyHistory 装配 segEdited ← seg_overrides_active）
  if (c.segEdited) el.title = t("edit.clip.segEditedTitle");
  el.style.width = (effDurOf(c) * pxs) + "px";
  el.style.marginLeft = (axisTrimlOf(c) * pxs) + "px";
  el.draggable = true;
  // 走查反馈 F6（老板「时间线预览图截断→居中平铺+多帧叠加·类剪映」）：反馈⑧首帧 cover 底
  //   （宽片段单帧拉伸截断）→ 多帧胶片条 .clipfilm（异步 canvas 采样·格数随宽度自适应）；
  //   采样失败回退 .done 渐变纯色底（fillFilmstrip 成功才挂 .hasfilm 切白字）。
  const hasFilm = !!(c.file && (c.state === "done" || c.state === "warn"));
  // 批 1-T3（F-104 残留②）: 宿主标源文件——失败延迟重试据此只定向重渲该 file 的在场胶片条
  //   （同 file 可被多段复用，不按 segId 匹配）。
  if (hasFilm) el.dataset.filmFile = c.file;
  // 走查反馈 F4（老板 2026-09-27「变速后时间线片段仍显示原时长」——推翻 S3-3 T2 定案②）:
  //   几何与时长文字统一按有效时长 = dur ÷ speed（剪映口径）; 速度角标仍挂（定案③不变）
  // S3-3 T3: 倒放 ⟲ / 定格 ⏸ 同款角标形态（均只标注, 不参与几何）
  // S3-3 T4: 分离音视频 🔇（-an 语义 = 该视频段静音）
  const spd = clipSpeedOf(c);
  const frz = clipFreezeOf(c);
  // 批5-R53-TF: 备选条目显示名带 _rN 代际后缀（名字跟文件走）——纯显示派生·数据 label 不动。
  //   R53域重对齐-T4: 块上 ver 角标（原版/第N次重制·渲染层从条目 ver 字段读）——徽章退役后
  //   现行候选回归全块，版本区分靠本角标（主轨对调后同样显示）。
  const genTag = isAlt ? altGenTagOf(c.file) : "";
  el.innerHTML = (hasFilm ? '<span class="clipfilm"></span>' : "")
    + `<span class="cap">${(isAlt && genTag) ? `${dispClipLabel(c.label)} · ${genTag}` : dispClipLabel(c.label)}${c.ver ? ` <span class="vr">${dispClipVer(c.ver)}</span>` : ""}${spd === 1 ? "" : ` <span class="spd">${fmtSpeed(spd)}</span>`}`
    + (clipReverseOf(c) ? ' <span class="rev">⟲</span>' : "")
    + (frz ? ` <span class="frz">${fmtFreeze(frz.sec)}</span>` : "")
    + (clipSplitAVOf(c) ? ' <span class="avs">🔇</span>' : "")
    + ` <span class="dur">${fmtDur(effDurOf(c))}s</span></span>`
    // F23: 关键帧 ◆ 菱形常显（位置 = 源时间点占 dur 比例·点击删除——文档委托处理）
    + [...new Set(kfReadOf(c).map((k) => k.t))].map((t) => {
      const durSrc = +c.dur || 0;
      const pct = durSrc > 0 ? Math.min(100, Math.max(0, (t / durSrc) * 100)) : 0;
      return `<i class="kf-dot" data-kft="${t}" style="left:${pct}%" title="${fmtDur(t)}s 关键帧（点击删除）"></i>`;
    }).join("")
    // R53域重对齐-T3 撤退休拦截: retired 视同普通块——✓（对调上岗）/✕（纯本地废弃）/▶（播放）三钮齐备
    + (isAlt ? `<span class="cok">${t("edit.cand.ok")}</span><span class="cno">${t("edit.cand.no")}</span>` : "")
    // 批 B T2: 备选候选常显 ▶ 播放钮（样式内联 cssText·不引 CSS 文件；点击播该候选）
    + (isAlt ? `<span class="cplay" title="${t("edit.cand.playTitle")}">▶</span>` : "");
  if (isAlt) {
    const pbtn = el.querySelector(".cplay");
    pbtn.style.cssText = "position:absolute;top:2px;right:2px;z-index:2;cursor:pointer;font-size:11px;line-height:1;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,.45);color:#fff;user-select:none";
    pbtn.addEventListener("click", () => previewClip(el));
  }
  if (hasFilm) fillFilmstrip(el, c.file, +c.dur || 0);
  // R56R57-S3 T4 缩略图换源: 首渲不阻塞（原产物先行）；解析命中非 none → 以最终版路径再调
  //   一次 fillFilmstrip 重采样替换；失败静默保持原产物。只换采样源·数据层零写。
  if (hasFilm) {
    const filmDur = +c.dur || 0;
    postfxSrcOf(c).then((src) => {
      if (src && src.level !== "none" && src.file && src.file !== c.file && el.isConnected) {
        fillFilmstrip(el, src.file, filmDur);
      }
    }).catch(() => {});
  }
  appendVolBar(el, c); // S3-3 T5: 下缘音量条（volume<1 才挂·绝对定位不参与几何）
  appendFadeBar(el, c); // S3-3 T9: 下缘淡化渐变条（淡入/淡出 值>0 才挂·绝对定位不参与几何）
  return el;
}

// 交界转场标记 (S3-3 T7) — 正片轨相邻片段交界窄标记: 绝对定位在交界 x（不参与片段流几何）;
//   未设 = hover 出「+转场」, 已设 = 「⇄类型」常显（CSS 两态）; 点击 → 转场弹窗（文档级委托收口）。
//   transition 挂前一片段（交界语义）——故标记身份 data-seg-id = 前一片段。
function buildTransBtn(prev, next, xPx) {
  const tr = clipTransitionOf(prev);
  const el = document.createElement("span");
  el.className = "trans-btn" + (tr ? " on" : "");
  el.dataset.segId = prev.segId || "";
  el.style.left = xPx + "px";
  el.title = tr
    ? t("edit.trans.onTitle", { type: tr.type, sec: fmtDur(tr.sec) })
    : t("edit.trans.offTitle", { prev: prev.label || t("edit.trans.thisSeg"), next: next.label || t("edit.trans.nextSeg") });
  el.textContent = tr ? `⇄${tr.type}` : t("edit.trans.add");
  return el;
}

function renderRuler(state, pxs) {
  const ruler = S.root.querySelector("#ruler");
  const L = axisLenSec(filmEndSec(state.mainClips, state.audioClips));
  const { labelStep, minorStep } = rulerSteps(pxs);
  let h = "";
  for (let s = 0; s <= L; s += minorStep) {
    const major = s % labelStep === 0;
    h += `<i class="tick${major ? " M" : ""}" style="left:${s * pxs}px">${major ? `<b>${s}s</b>` : ""}</i>`;
  }
  ruler.innerHTML = h;
  ruler.style.width = ruler.style.minWidth = (L * pxs) + "px";
}

// 客户端 x → 时间线秒数。几何同 applyScrub：ruler 左缘与主轨左缘对齐
//   （edit.css .ruler margin-left 104px = 轨头 96px + gap 8px），故取主轨 rect。
function secAtClientX(clientX) {
  const r = S.root.querySelector("#mainTrack").getBoundingClientRect();
  return Math.max(0, clientX - r.left) / S.pxs;
}

function mkBtn(txt, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghostbtn";
  b.textContent = txt;
  b.addEventListener("click", fn);
  return b;
}

// ===== S3-4 B6（空-015）：收藏夹 —— 按 seed 收藏 + 一键同 seed 变体 =====
// 语义（详案 空-015「按 seed 收藏一键变体·端点 #6」）：
//   收藏 = 记下该段生成条件（seed + 提示词）；变体 = 用同 seed 重跑该段单段生成 ——
//     落点走 B5 抽出的公共底层 runSingleSegmentGeneration（assets.js · seed 参数化）：
//     单段项目（分镜·2 秒）→ generate_csv → submit → 轮询至 done → 产物路径。
//   入口（最小侵入）: 段右键「收藏此段的 seed」+ 播放器区 .pv-actions「☆ 收藏夹」开列表（变体/删除在列表内）。
//   条目身份 = seed + prompt（生成条件本身）——重复收藏幂等（刷新时间·不并排重占位）。
//   持久化 localStorage gui13.favorites（仓内 gui13.* 键惯例 · 跨会话共享）；
//   存储不可用（隐私模式等）→ 读空/写静默，收藏是附加能力，不阻断编辑链。
const FAV_KEY = "gui13.favorites";

function favStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}
// 读侧兜底：非 JSON / 非数组 / 脏条目（缺 id 或非空 seed）一律跳过 —— 不抛
function readFavorites() {
  const st = favStorage();
  if (!st) return [];
  try {
    const v = readAgg(USER_JSON, "favorites", st);   // M-T5：收藏迁 data/user.json
    const arr = Array.isArray(v) ? v
      : (st.getItem(FAV_KEY) ? JSON.parse(st.getItem(FAV_KEY)) : null);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e === "object" && String(e.id || "") !== "" && String(e.seed || "") !== "")
      .map((e) => ({
        id: String(e.id),
        name: String(e.name == null ? "" : e.name),
        seed: String(e.seed),
        prompt: String(e.prompt == null ? "" : e.prompt),
        ts: Number(e.ts) || 0,
      }));
  } catch (_e) { return []; }
}
// 入库：同 (seed+prompt) 幂等 —— 保留原 id、刷新收藏时间、置顶；返回 {list, dup}
function addFavorite(list, entry) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const i = arr.findIndex((e) => e && e.seed === entry.seed && e.prompt === entry.prompt);
  const dup = i >= 0;
  const id = dup ? arr[i].id : "fav-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  if (dup) arr.splice(i, 1);
  arr.unshift({ ...entry, id });
  return { list: arr, dup };
}
function removeFavorite(list, id) {
  return (Array.isArray(list) ? list : []).filter((e) => e && e.id !== id);
}
function saveFavorites(list) {
  const st = favStorage();
  if (!st) return;
  writeAgg(USER_JSON, "favorites", list);   // M-T5：内存 + 异步 PUT（localStorage 停写）
}
// 收藏时间（本地时区·分钟精度）——列表行展示用
function fmtFavTs(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 右键「收藏此段的 seed」——seed 真源同属性面板口径：clip.seed 优先，缺则按 segId 回落 segments
function favoriteClip(el) {
  const { clip } = resolveTrackClip(el);
  if (!clip) { showToast("info", t("edit.fav.notInTrack")); return; }
  const proj = storeLoad(S.projectId);
  const seg = ((proj && proj.segments) || []).find((s) => s.id === clip.segId);
  const seedRaw = clip.seed != null && clip.seed !== "" ? clip.seed : (seg ? seg.seed : "");
  const seed = seedRaw == null ? "" : String(seedRaw);
  const name = String(clip.label || (seg && seg.prompt) || "片段");
  if (!seed) { showToast("info", t("edit.fav.noSeed", { name })); return; }
  const { list, dup } = addFavorite(readFavorites(), {
    name, seed, prompt: String((seg && seg.prompt) || ""), ts: Date.now(),
  });
  saveFavorites(list);
  showToast(dup ? "info" : "success", dup
    ? t("edit.fav.dup", { name, seed })
    : t("edit.fav.done", { name, seed }));
}

export function openFavoritesModal() {
  const body = document.createElement("div");
  openMbox(t("edit.fav.cap"),
    t("edit.fav.sub"),
    body, [[t("edit.common.close"), null]]);
  renderFavRows(body);
}
function renderFavRows(box) {
  const favs = readFavorites();
  box.innerHTML = "";
  if (!favs.length) {
    const empty = document.createElement("div");
    empty.className = "phint";
    empty.textContent = t("edit.fav.empty");
    box.appendChild(empty);
    return;
  }
  favs.forEach((f) => {
    const row = document.createElement("div");
    row.className = "fav-row";
    row.dataset.fid = f.id;
    row.style.cssText = "display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:13px";
    const name = document.createElement("span");
    name.className = "fav-name";
    name.style.cssText = "flex:1;min-width:0;word-break:break-all";
    name.textContent = f.name || t("edit.fav.unnamed");
    const meta = document.createElement("span");
    meta.className = "fav-meta";
    meta.style.cssText = "color:var(--txt3);font-size:12px;flex-shrink:0";
    meta.textContent = `seed ${f.seed} · ${fmtFavTs(f.ts)}`;
    const runBtn = mkBtn(t("edit.fav.variant"), () => runFavoriteVariant(f, runBtn));
    const delBtn = mkBtn(t("edit.common.delete"), () => {
      saveFavorites(removeFavorite(readFavorites(), f.id));
      renderFavRows(box);
    });
    row.appendChild(name);
    row.appendChild(meta);
    row.appendChild(runBtn);
    row.appendChild(delBtn);
    box.appendChild(row);
  });
}
// 批 G-a G-T8b（F-18 续）: 变体产物真实时长探测——真机抽验 ffprobe 实测 rerun 产物 5.167s，
//   dur:2 假设失配坐实（方案 §六.6 门「失配则改读产物元数据」→ 本函数兑现）。
//   游离 video（preload=metadata·src 走 /h3_batch/video 代理同源可读·播放器同口径 :1476/:897）
//   → loadedmetadata 读 duration；error/超时（默认 3s 不悬挂）→ 兜底 2s 维持原假设档；
//   非有限值（Infinity/NaN）同兜底·有限值 clamp [0.1, 600] 防脏元数据落轨；取完清源摘监听。
// 探测底座（M6b-T3 R-50 承）：游离 video 元数据读取共用一份——read(v) 返元数据值；
//   loadedmetadata/error/超时 任一先到即 resolve·取完清源摘监听·恒 resolve 不 reject（防悬挂）。
export function probeVideoMeta(videoPath, read, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    let done = false;
    let timer = 0;
    let onMeta = null, onErr = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("error", onErr);
      v.src = "";
      resolve(val);
    };
    onMeta = () => finish(read(v));
    onErr = () => finish(null);
    timer = setTimeout(() => finish(null), timeoutMs);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("error", onErr);
    v.src = mediaUrl("video", videoPath);   // 批 B #13：URL 收敛单源（error 早退语义不动·离线退 2s 假设档）
  });
}
export function probeVideoDuration(videoPath, timeoutMs = 3000, fallback = 2) {
  return probeVideoMeta(videoPath, (v) => v.duration, timeoutMs).then((d) => {
    const n = Number(d);
    return (d != null && Number.isFinite(n)) ? Math.min(600, Math.max(0.1, n)) : fallback;
  });
}

// ===== 批 J-P13：产物实测时长校正接线（老板「拼接重叠致第二段实际 4.5s·游标卡 90%」）=====
// 读侧唯一收敛口在 core/timeline.js effDurOf：prodDur 机会式字段 {file, dur} 与 clip.file 对位才生效。
// 本函数只负责「测出来写回去」：探测复用上条 probeVideoDuration（不造第二套），
//   fallback=0 → 探测失败/超时不写盘（回落分镜 dur·现行为），不像 G-T8b 变体流那样兜底 2s（那里无 dur 可依）。
// 静默回写（同 ensureAltCid 读侧懒生成先例）：派生测量值不压撤销栈、不触发订阅重渲，末尾手工 renderAll。
// 无需在换源/重生成/载入历史各写点清字段 —— prodDur.file 与 clip.file 不等即自失效（timeline.js 读侧判），
//   边界外 submit-bar.js syncRunProducts 直接改 clip.file 的形态天然安全。
let _prodDurProbe = null;                                   // null = 用 probeVideoDuration（单测注入位）
export function _test_setProdDurProbe(fn) { _prodDurProbe = fn || null; }
async function syncProbedDurs() {
  if (!S || !S.projectId) return;
  const projectId = S.projectId;
  const probe = _prodDurProbe || ((f) => probeVideoDuration(f, 3000, 0));
  const clips = es().mainClips || [];
  const byFile = new Map();                                 // 同路径多段只测一次
  const todo = [];
  for (const c of clips) {
    const f = String((c && c.file) || "");
    if (!c || !f) continue;
    if (c.prodDur && String(c.prodDur.file) === f) continue; // 已对位校正
    if (!byFile.has(f)) byFile.set(f, Promise.resolve().then(() => probe(f)).catch(() => 0));
    todo.push({ f, p: byFile.get(f) });
  }
  if (!todo.length) return;
  const measured = await Promise.all(todo.map((t) => t.p));
  if (!S || S.projectId !== projectId) return;               // 已卸载/换项目 → 丢弃（unmount 置 S=null）
  const hit = new Map();
  todo.forEach((t, i) => { if (measured[i] > 0) hit.set(t.f, measured[i]); });
  if (!hit.size) return;
  let changed = false;
  const next = clips.map((c) => {
    const d = hit.get(String((c && c.file) || ""));
    if (!(d > 0) || (c.prodDur && String(c.prodDur.file) === String(c.file))) return c;
    changed = true;
    return { ...c, prodDur: { file: String(c.file), dur: d } };
  });
  if (!changed) return;
  writeEsSilent({ mainClips: next });
  renderAll();
}
export function _test_runProdDurSync() { return syncProbedDurs(); }

// 一键变体：同 seed 重跑该段（列表内轮询态 → 完成/失败 toast）
// 批 G-a G-T8（F-18）: 产物落时间线——videoPath 有 → pasteClips 同款落 mainClips 一条
//   （paste- 前缀 store 对账孤儿保留·段号铁律 n=max+1·dur=probeVideoDuration 产物真实时长
//   〔G-T8b·真机抽验 5.167s 失配坐实·失败兜底 2s〕·state:done+file 真产物段），插游标命中
//   段后（死区/空轨尾插兜底·pasteClips 同式）·writeEs 单笔入撤销栈可撤销；无 videoPath →
//   维持「变体完成」toast 不落轨。
async function runFavoriteVariant(fav, btn) {
  const name = fav.name || "收藏段";
  if (!String(fav.prompt || "").trim()) {
    showToast("info", t("edit.fav.noPrompt", { name }));
    return;
  }
  btn.textContent = t("edit.fav.gen");
  btn.disabled = true;
  showToast("info", t("edit.fav.submitting", { name, seed: fav.seed }));
  try {
    const r = await runSingleSegmentGeneration(fav.prompt, { seed: fav.seed });
    if (r.videoPath) {
      // G-T8b: 落轨前探测产物真实时长（真机抽验 5.167s ≠ dur:2 假设·失配坐实）——探测完成再
      //   writeEs（变体流程本就异步轮询完·再等一个 metadata 用户无感·toast 顺序不变）；
      //   探测失败/超时兜底 2s 维持原假设档（probeVideoDuration 恒 resolve·catch 防御同兜底）。
      const dur = await probeVideoDuration(r.videoPath).catch(() => 2);
      const clips = (es().mainClips || []).slice();
      const hit = clipAtPlayhead(clips, S.phTime); // 插游标处（pasteClips 同式·死区/空轨尾插兜底）
      const n = nextClipN(clips);
      clips.splice(hit ? hit.index + 1 : clips.length, 0, {
        segId: "paste-" + Math.random().toString(36).slice(2, 10),
        n,
        label: `${name} 变体`,
        dur, triml: 0, full: dur,
        state: "done",
        file: r.videoPath,
      });
      writeEs({ mainClips: clips });
      showToast("success", t("edit.fav.added", { name, seed: fav.seed, path: r.videoPath }));
    } else {
      showToast("success", t("edit.fav.finished", { name, seed: fav.seed }));
    }
  } catch (e) {
    showToast("error", t("edit.fav.fail", { msg: (e && e.message) || e }));
  } finally {
    btn.textContent = t("edit.fav.variant");
    btn.disabled = false;
  }
}

function renderPlayhead(pxs) {
  const end = filmEndSec(es().mainClips, es().audioClips);
  S.phTime = Math.min(S.phTime, end);
  const ph = S.root.querySelector("#playhead");
  if (ph) ph.style.left = (S.phTime * pxs) + "px";
  const tb = fmtClock(S.phTime);   // #89 FIX-1：局部名 t→tb（原名影蔽 i18n 取词函数·下方 pvTime 取词调用会变 TypeError）
  const phTimeEl = S.root.querySelector("#phTime");
  const phHead = S.root.querySelector("#phHead");
  if (phTimeEl) phTimeEl.textContent = tb;
  // 批 A T4：游标头显「当前 · 总时长」（体验修复 A3：斜杠改点分隔）——总时长口径批M2 R-38 起改 actualFilmEndSec
  //   （只计有产物段·诚实反馈）；拖动域钳制（上行 Math.min）仍走 filmEndSec（计划口径·
  //   显示与钳制分离·拖动域由 R-41 管）。标尺读数 #phTime 是尺上刻度、不加总时长。
  if (phHead) phHead.textContent = `${tb} · ${fmtClock(actualFilmEndSec(es().mainClips, es().audioClips))}`;
  // 批 M3 T2：自绘全片进度条刷新（游标点位置 + 文案）——每帧经 phRafLoop 已过此口·零新循环。
  //   分母插播改口径（老板 2026-10-09「进度条的时长是总任务的时长而不是已生成有效视频的时长」）：
  //   actualFilmEndSec（只计有产物段·与文案「总」同源一致）·phTime 超实际总长（占位区播放/End）时
  //   钳 100% 不越轨（Math.min(1,·) 原样保留）；零分母兜底 ||1（空项目不出 NaN）。
  //   播控图标态**不在此刷新**——由 playing 类驱动（edit.css:41-42）·停播后 renderPlayhead
  //   仍被调用但图标须停在正确形态。
  const knob = S.root.querySelector("#editPlayer .pv-knob");
  if (knob) knob.style.left = (100 * Math.min(1, Math.max(0, S.phTime / (actualFilmEndSec(es().mainClips, es().audioClips) || 1)))) + "%";
  const pvTime = S.root.querySelector("#editPlayer .pv-time");
  if (pvTime) {
    const hit2 = clipAtPlayhead(es().mainClips || [], S.phTime);
    const segNo = hit2 && hit2.index >= 0 ? hit2.index + 1 : 0;
    // 全片位固定一位小数（游标在动·定宽免抖）；总时长去尾零（方案文案样例「总 30s」·
    // 非「总 30.0s」）——非整数总长（如 29.97）仍照实显示不四舍五入成 30。
    pvTime.textContent = t("edit.pv.time", { seg: segNo, cur: S.phTime.toFixed(1), total: trimZero(actualFilmEndSec(es().mainClips, es().audioClips)) });
  }
  // 走查反馈⑨（老板要求：拖游标播放器帧级同步）：游标位置 → 当前 clip 源内时间 → video seek
  //   （批 F91a：逻辑抽到 seekActiveToPlayhead·换位补 seek 与拖动共用一段）
  seekActiveToPlayhead();
  updateActiveClip();
}

function renderMute(state) {
  const main = S.root.querySelector("#mainTrack");
  const audio = S.root.querySelector("#audioTrack");
  const bgm = S.root.querySelector("#bgmTrack");   // 批 J-P4：BGM 轨同挂 muted（mutedAudio 一口口径）
  const mBtn = S.root.querySelector("#muteMain");
  const aBtn = S.root.querySelector("#muteAudio");
  const bBtn = S.root.querySelector("#muteBgm");
  if (!mBtn || !aBtn) return;
  main.classList.toggle("muted", !!state.mutedMain);
  audio.classList.toggle("muted", !!state.mutedAudio);
  if (bgm) bgm.classList.toggle("muted", !!state.mutedAudio);
  mBtn.classList.toggle("on", !!state.mutedMain);
  aBtn.classList.toggle("on", !!state.mutedAudio);
  if (bBtn) bBtn.classList.toggle("on", !!state.mutedAudio);
  mBtn.title = state.mutedMain ? t("edit.tl.muteOnTitle") : t("edit.tl.muteTitle");
  const aTitle = state.mutedAudio ? t("edit.tl.muteOnTitle") : t("edit.tl.muteTitle");
  aBtn.title = aTitle;
  if (bBtn) bBtn.title = aTitle;
}

// ============================================================================
// 批 10-L F91a：双 video 交叉淡化换源（消黑窗闪烁）
//   老板一手指：概况/剪辑「切换播放视频时闪烁」。黑窗 = 浏览器换源标准行为
//   （旧画面清空 → 网络加载 → 首帧出现的空档）。
//   修法：容器内两个 video——A 显示位 / B 预载位。换源时 B 预载新源，B 的 canplay
//   （首帧就绪）后 opacity 交叉 120ms 并换位；同源重复切换不动作。
//   不变式（关键）：活动 video 恒为容器内第一个 video（DOM 序）——edit.js 十余处
//   querySelector("video") 取用点（:1171/:1232/:1257/:1265/:1336/:1343/:1353/:1370/:1397）
//   一律拿活动位，换位时把新活动位 insertBefore 到首位 → 取用点零改动。
//   供 views/preview.js 概况页播放器复用（preview→edit 依赖同向·不新建文件）。
// ============================================================================
export function createDualVideo(container, opts = {}) {
  const initVideo = typeof opts.initVideo === "function" ? opts.initVideo : null;
  const onSwap = typeof opts.onSwap === "function" ? opts.onSwap : null;
  // F97e：换位闸（可选）——预热源 canplay 时游标未必已跨界，过早换位=未到段界就切画面。
  //   闸不过 → 备位保持就绪待命，由跨界分支/接续链的 ready() 判定后 promote()。不传 = 旧行为。
  const canPromote = typeof opts.canPromote === "function" ? opts.canPromote : null;
  // P0-#17：备位加载失败回调（可选）——edit 侧接降级提示+坏文件记账；preview.js 不传 = 仅解卡。
  const onErr = typeof opts.onError === "function" ? opts.onError : null;
  const fadeMs = Number.isFinite(+opts.fadeMs) ? +opts.fadeMs : 120;
  // 批 M3 T3 · R-43 nativeControls 旁路：原生 controls 在剪辑页隐藏（edit 传 false）——
  //   原生条段级钳位（phTargetFromVideo 架构死锁 = 走查反馈⑨ 病根），屏上控制改走
  //   自绘全片进度条 + 自绘播控（T2）。**缺省 true** = preview.js 概况页 + final_preview
  //   overlay 零改动。controls 四处写点（mk 初始 / promote 翻转 / 退位 / restoreControls）
  //   全部门控——漏任一处即闪出/复活。
  const nativeControls = opts.nativeControls !== false;
  let aEl = null, bEl = null;      // a=活动位 · b=预载位
  let activePath = "";             // 显示位当前路径（空=尚未起播）
  let pendingPath = "";            // 预载位在途路径
  let wantPlay = false;            // 「就绪即播」意图（连播/播放中切段·换位后接着播）
  let clearTimer = 0;              // 批 10-O F91-3：旧源延迟清理句柄（#12-T2 起兼作退位清源兜底钟）
  let clearOnFrame = null;         // #12-T2：新位首帧实证监听句柄 { el, fn }（与 clearTimer 同点撤·防误清复用备位）
  // #12-T2：退位清源兜底上限——新位 timeupdate 实证（首帧已出=解码器已建）先清，此为未实证时的到期强制清
  const DEMOTED_CLEAR_FALLBACK_MS = 1200;
  // 清源动作本身（批 F91a 原口径不变）——#12-T2 起被推到「新位首帧实证或兜底到期」之后调用
  function clearSource(v) {
    try { v.removeAttribute && v.removeAttribute("src"); } catch (_e) { /* 桩无 removeAttribute */ }
    v.src = "";
  }
  function cancelClear() {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = 0; }
    // #12-T2：首帧实证监听随清源句柄一并撤——show 备位复用（cancelClear 调用点）/destroy 时
    //   同步撤除，防旧轮监听把已被复用为备位的在途新预热源误清（=下一帧永不 ready 卡黑）。
    if (clearOnFrame) {
      try { clearOnFrame.el.removeEventListener && clearOnFrame.el.removeEventListener("timeupdate", clearOnFrame.fn); } catch (_e) { /* 桩缺 */ }
      clearOnFrame = null;
    }
  }

  function styleOf(v, isActive) {
    v.style.transition = "opacity " + fadeMs + "ms linear";
    v.style.opacity = isActive ? "1" : "0";
    v.style.pointerEvents = isActive ? "auto" : "none";
    // 两态恒铺满（M-T8 真机 F95c+e：旧实现活动位走「清空回落文档流」分支——容器无
    //   video{width:100%} 规则时露 300×150 裸默认尺寸=老板「极小的视频播放器」根因；
    //   铺满三件套两态恒设·交叉淡化全程同尺寸不闪现。参照系由 ensure() 的容器
    //   position:relative 兜底——两页播放器容器都可能是 flex 布局，不设会按最近定位祖先错位）
    v.style.position = "absolute";
    v.style.top = "0";
    v.style.left = "0";
    v.style.width = "100%";
    v.style.height = "100%";
  }
  function mk() {
    const v = document.createElement("video");
    // 写点①（mk 初始）：走查反馈⑧（老板要求）：原生播放器（进度条/音量/全屏）；
    //   批 M3 T3：旁路态（nativeControls=false）恒隐藏——首载 show() 返 ready 不走 promote，
    //   漏此处则首段原生条直接可见。
    v.controls = nativeControls;
    v.preload = "metadata";
    if (initVideo) initVideo(v);
    // F97e：canplay 换位过闸——预热源就绪时游标可能还没跨界（canPromote 判）·闸不过先待命
    v.addEventListener("canplay", () => { if (v === bEl && (!canPromote || canPromote(pendingPath))) promote(); });
    // P0-#17：备位加载失败兜底（404/文件被引擎改名）——此前备位无 error 监听，失败后
    //   pendingPath 永不清 → needsLoad 恒 false（预热不重试）+ isReady 恒 false（就绪闸
    //   永不满足）→ promote/playWhenReady 死等 = 段接口卡死。失败即清在途态撤起播意图；
    //   降级提示由消费方 onError 接（活动位失败走 initVideo 链批 A T3 兜底·此处不重复）。
    v.addEventListener("error", () => {
      if (v !== bEl || !pendingPath) return;   // 活动位失败/已在途态作废（promote 后残源清空 src 的迟到 error）→ 不响应
      const bad = pendingPath;
      pendingPath = "";
      wantPlay = false;
      _preloadSince = null;                    // 兜底钟复位（无在途预热·同 show same 分支语义）
      if (onErr) onErr(bad);
    });
    return v;
  }
  function ensure() {
    if (!aEl) {
      // 预载位绝对定位的参照系（两页播放器容器都可能是 flex 布局·不设会按最近定位祖先错位淡入）
      if (container.style && !container.style.position) container.style.position = "relative";
      aEl = mk(); styleOf(aEl, true);
      container.insertBefore(aEl, container.firstChild);
      bEl = mk(); styleOf(bEl, false);
      container.appendChild(bEl);
    }
    return aEl;
  }
  function playEl(v) {
    if (v && typeof v.play === "function") { const p = v.play(); if (p && typeof p.catch === "function") p.catch(() => {}); return p; }
    return null;
  }
  // F97e：备位预热源是否就绪（跨界立即换位的判据）。批 M3-T1③ 门槛 2→3：
  //   readyState≥3 = HAVE_FUTURE_DATA（缓冲够无停等续播）；≥2 只有一帧·换位后起播仍可能
  //   停等（=把「段尾停等」换成「换位后停等」的新停等病）。超时兜底：预热起算超阈值仍未达 3
  //   → 回落 ≥2 放行（防 readyState 卡 2 时游标钉死段尾永不换位·回退到提档前行为）。
  //   兜底钟源由 edit 侧预热点写（_preloadSince·模块级）——本工厂只读·不记起算
  //   （防 preview.js 概况页同链外溢）。_preloadLeadMs/_preloadNow 经 _test_setPreloadClock 注入。
  //   批 M7-T1 三条件 OR 精准化：readyState≥3 / buffered 覆盖 [_pendingSrcTime, +2.0s) /
  //   （1.2s 兜底且 ≥2·原语义不变）——buffered 覆盖=数据实证提前放行（锚=预热点写的待播
  //   起点·单向向后）。readyState<2 恒不放行守卫（下条）原样不动·buffered 缺失/undefined
  //   判据 false 不抛（存量桩无 buffered 通道）。#12-T3 窗 0.5→2.0（老板②档·攒够 2-3 秒才播·区间下沿）。
  function isReady() {
    if (!bEl) return false;
    if (bEl.readyState >= 3) return true;
    if (!(bEl.readyState >= 2)) return false;   // 兜底只放松 3→2·绝不放行未就绪（判据写成 !(>=2)：
                                                //   readyState 缺失时 >=2 为 false·若写 <2 则 undefined<2 也为 false
                                                //   → 未就绪件会落进兜底分支误判就绪）
    // 批 M7-T1 buffered 覆盖判据（守卫之后·提前放行）：[_pendingSrcTime, +2.0) 被 buffered
    //   某 range 覆盖即真（#12-T3 窗 0.5→2.0）；preview 复用工厂零感知（锚缺省 0·桩无 buffered → 恒 false）。
    const b = bEl.buffered;
    if (b && b.length > 0 && typeof b.start === "function" && typeof b.end === "function") {
      const from = _pendingSrcTime || 0;
      const to = from + PRELOAD_BUFFER_COVER_S;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= from && b.end(i) >= to) return true;
      }
    }
    return !!(_preloadSince != null && _preloadNow() - _preloadSince > _preloadLeadMs);
  }
  function promote() {
    if (!aEl || !bEl || !pendingPath) return;
    const wasPlaying = aEl.paused === false;   // 续播：换源前在播 → 新位接着播
    const play = wantPlay || wasPlaying;
    wantPlay = false;
    // F97a：揭示瞬间新活动位仍 paused（playEl 在下方才调）——Chrome 对暂停态 video 恒渲染
    //   原生 controls（鼠标不在播放器内也显示）→ 换源瞬间进度条/按钮整条闪出 ~300ms。
    //   续播场景先摘 controls 再揭示；还原点=「playing」（Chrome 完成播放态切换后——真机
    //   v-158 帧实证：同步还原会在「暂停=显示」内部态下重新点亮）；兜底 pause（用户暂停/
    //   停播）与 play() 拒绝时同样还原，任何暂停态控件都可用。暂停态换段不摘（原生基线）。
    //   批 M3 T3 写点②（promote 翻转）：旁路态两侧都恒 false——否则暂停上架分支会把
    //   原生条点亮（换段闪出·F97a 复发）。
    if (play) bEl.controls = false;
    else bEl.controls = nativeControls;   // F97a：该元素退位期被摘过 controls·暂停上架须恢复（基线）
    styleOf(bEl, true);
    styleOf(aEl, false);
    // 活动位 = 容器内第一个 video：先把备位摘出再插到活动位之前（显式摘+插，
    //   不依赖 insertBefore 的「移动」语义在各种 DOM 替身里都一致）
    const host = bEl.parentNode || container;
    if (host && typeof host.removeChild === "function") host.removeChild(bEl);
    container.insertBefore(bEl, aEl);
    const t = aEl;
    aEl = bEl; bEl = t;
    activePath = pendingPath;
    pendingPath = "";
    // 批 10-O F91-3：旧源延到换位动作完成后再清——旧画面还在上层淡出 fadeMs，立即清=黑闪
    //   （细采样铁证 t=5405：旧源已空而 opacity 0.88 的旧画面仍盖在最上层）。
    //   句柄落在刚退位的那个元素上（不是活读 bEl·防复用后误清新源）。
    //   #12-T2 退位清源错峰（T0-C 定案·治段首 1s 帧断供）：fadeMs+60 即清仍会与
    //   新位建解码器在 GPU 侧串行争抢——改双闸：**新位首帧实证**（新活动位 timeupdate
    //   once=解码器已建可推进）**或** 1200ms 兜底，先到者清；退位即 pause（立即停解码
    //   供给·不清源不销毁）。句柄并入 clearTimer 体系——show 备位复用 cancelClear 时
    //   连监听一并撤（防旧轮监听误清在途新预热源）。
    const demoted = bEl;
    // F97a：退位元素禁 controls——淡出尾段它若 ended/emptied，Chrome 会点亮其控件
    //   （半透明残闪 ~180ms·真机 v-172/v-178 帧实证）。重用上架时由下方按播放意图恢复。
    //   批 M3 T3 写点③（退位）：旁路态恒 false（缺省路径与 F97a 同值·无行为变化）。
    demoted.controls = false;
    try { demoted.pause && demoted.pause(); } catch (_e) { /* 桩缺 pause */ }
    const newActive = aEl;
    const doDemotedClear = () => { cancelClear(); clearSource(demoted); };
    clearTimer = setTimeout(doDemotedClear, DEMOTED_CLEAR_FALLBACK_MS);
    newActive.addEventListener("timeupdate", doDemotedClear);
    clearOnFrame = { el: newActive, fn: doDemotedClear };
    // #12-T7（T0-3 定案）rate 后置：play() 先于 onSwap——消费方 onSwap 内设 playbackRate
    //   （onSwap「S3-3 T2 定案①」写点·段速联动），play 前设速率迫使解码管线按新速率重定位
    //   关键帧（换位首帧滞后半边·锁B 实证序列 rate,play,play）。play 先起（管线按当前位起播）
    //   再设速率+seek：同一 JS 任务内 currentTime/playbackRate 均在任何媒体任务/首帧渲染前落定，
    //   观察序 play → rate。paused 换段（play=false）不涉 play·本次序移动对它无感。
    if (play) {
      // 还原监听挂在新活动位（swap 之后 aEl 已是换入元素·playing/pause 双兜底+play 拒绝还原）
      // 批 M3 T3 写点④（restoreControls）：旁路态不得点亮原生条（否则换段后原生条复活）。
      const restoreControls = () => { aEl.controls = nativeControls; };
      aEl.addEventListener("playing", restoreControls, { once: true });
      aEl.addEventListener("pause", restoreControls, { once: true });
      const p = playEl(aEl);
      if (p && typeof p.catch === "function") p.catch(restoreControls);
    }
    if (onSwap) onSwap(aEl, { wasPlaying, wantPlay: play, path: activePath });   // 批 F97：传本次换入的源（消费方按它解析目标片段·不靠闭包捕获）
  }
  return {
    container,
    active() { return aEl; },
    activePath() { return activePath; },
    pendingPath() { return pendingPath; },
    // 换源：同源 → "same"（不动作）；首载（显示位还空·屏上无旧画面）→ 直落显示位 "ready"；
    //   换段（显示位已有画面）→ 落预载位 "loading"（保旧画面·无黑窗）
    //   #68：opts.restart（仅同源生效）——活动位 currentTime 归零后再由消费方 playWhenReady
    //   从 0 起播（概况页点段/首播）；缺省不传 = 旧行为（剪辑页同源切回续播）。
    show(file, opts = {}) {
      if (typeof document === "undefined" || !container) return "skip";
      ensure();
      const f = String(file || "");
      if (activePath === f) {
        // 批 G-b T4（批 E 遗留⑥）：same 分支清过期预载——用户切回活动源时在途预载作废；
        //   过期 canplay → promote 首行 !pendingPath 早退（:1491 现有守卫）= 过期源 G 永不上场
        //   正是正确语义；bEl 残源待下次 show 覆写（无害·零额外 canplay 改写）。
        //   pendingPath !== f 守卫：activePath 与 pendingPath 同值不可达（预载期 activePath 恒旧源），保幂等。
        if (pendingPath && pendingPath !== f) pendingPath = "";
        // 批 M7-T1：same 分支一并重置兜底纪元/待播起点——在途预载随本分支作废，锚不得残留
        //   （null=无在途预热·模块级伴生语义同 _preloadSince 注释）。
        _preloadSince = null;
        _pendingSrcTime = 0;
        if (opts.restart) aEl.currentTime = 0;   // #68：同源重播从 0 起（缺省不传=续播）
        return "same";
      }
      if (pendingPath === f) return "loading";
      if (!activePath) { activePath = f; setMediaSrc(aEl, "video", f); return "ready"; }   // 批 B #13：URL 收敛单源
      cancelClear();          // 批 10-O F91-3：备位要装新源 → 取消上一轮挂在它身上的延迟清理（否则新源被误清）
      pendingPath = f;
      // 批 M7-T1：纪元与 pendingPath 同点重置——兜底钟从本次换源起算（拖游标等非预热点换源
      //   不再恒过期=readyState 一到 2 即盲放行）；待播起点同点复位 0（预热点在 show 返回后再写
      //   真实 srcTime·防先写后被此处复位自相残杀）。
      _preloadSince = _preloadNow();
      _pendingSrcTime = 0;
      setMediaSrc(bEl, "video", f);   // 批 B #13：赋值+回落目标随源刷新（引擎口失败 → 本地流拖动可续）
      return "loading";
    },
    // 起播意图：加载中 → 换位后播；已在显示该源 → 立刻播（切回同一段续播）
    playWhenReady() {
      if (pendingPath) {
        wantPlay = true;
        // F97e：预热源已就绪（canplay 被 gate 拦下·不会再触发）→ 立即换位接续
        if (isReady()) promote();
        return;
      }
      wantPlay = false;
      playEl(aEl);
    },
    // F97e：对外只读探针（跨界换位分支/单测用）
    ready: isReady,
    wantsPlay() { return wantPlay; },
    // 批 A T1：停播清「就绪即播」意图——否则停播后换位仍会自己播起来（幽灵续播）。
    //   只加不改签名（preview.js:34 消费本工厂·形状变更会连带波及概况页播放器）。
    clearIntent() { wantPlay = false; },
    // 是否还需要为 file 换源（false = 已在显示或在途加载·供 rAF/pvTimer 每帧判据用）
    needsLoad(file) {
      const f = String(file || "");
      return !(activePath === f || pendingPath === f);
    },
    promote,     // 首帧就绪即换位（生产走 canplay 监听；测试直调注入）
    destroy() {
      cancelClear();          // 批 10-O F91-3：句柄随实例走（不留下野定时器）
      for (const v of [aEl, bEl]) {
        if (!v) continue;
        // #68：摘节点不会停播（媒体元素脱离 DOM 仍可放音）——先暂停再摘（卸载/重挂不留后台声）
        try { v.pause && v.pause(); } catch (_e) { /* 桩缺 pause */ }
        if (v.parentNode && typeof v.parentNode.removeChild === "function") v.parentNode.removeChild(v);
        else if (typeof v.remove === "function") v.remove();
      }
      aEl = null; bEl = null; activePath = ""; pendingPath = ""; wantPlay = false;
    },
  };
}

// ===== 批 10-L F91b：剪辑页段落播放位置记忆（老板「剪辑切换段落时会重置视频位置」）=====
//   timeupdate 节流记录当前段源内时间；换源就绪后若有记忆且 < duration-0.3s 则 seek 恢复
//   并保持暂停（尊重用户「切过去看看」的意图·不自动播）。Map 保序 + 50 条上限（防无界增长）。
//   有起播意图（连播 / 播放中跨段推进）时不恢复——那条路要按游标走，否则会跳播。
const SEG_POS_MAX = 50;
const SEG_POS_TICK_MS = 500;
const SEG_POS_TAIL = 0.3;
const _segPos = new Map();
let _segPosLast = 0;

function segPosKey(clip) {
  if (!clip) return "";
  return String(clip.segId || clip.file || "");
}
export function recordSegPos(clip, t, now) {
  const k = segPosKey(clip);
  if (!k) return;
  const ts = Number.isFinite(+now) ? +now : Date.now();
  if (ts - _segPosLast < SEG_POS_TICK_MS) return;
  _segPosLast = ts;
  _segPos.delete(k);            // Map 保序：重记的项排到尾部 → 上限清理时先清最旧
  _segPos.set(k, { t: +t || 0, file: String((clip && clip.file) || ""), at: ts });
  while (_segPos.size > SEG_POS_MAX) {
    const oldest = _segPos.keys().next().value;
    _segPos.delete(oldest);
  }
}
export function recallSegPos(clip, duration) {
  const k = segPosKey(clip);
  if (!k) return null;
  const rec = _segPos.get(k);
  if (!rec) return null;
  // #22 记忆带 file 维度：换产物（重制上岗/重跑落卡）后 segId 不变，旧 file 的记忆被新 file
  //   recall = 老板复验「重跑片段播放时不是从头播放·会跳过前面 4 秒左右」→ 归一化比对
  //   （normFileKey 单一事实源）不符即弃按默认起播；换回旧 file 记忆仍在照常命中。
  //   recall 不带 file（旧调用形态兜底）不做校验，行为不变。
  if (rec.file && clip && clip.file && normFileKey(rec.file) !== normFileKey(clip.file)) return null;
  const d = +duration;
  if (Number.isFinite(d) && d > 0 && rec.t >= d - SEG_POS_TAIL) return null;  // 超时长记忆不 seek
  return rec.t;
}
export function _test_resetSegPosMem() { _segPos.clear(); _segPosLast = 0; }

// M-T8 F95d：清除该段的位置记忆（用户拖游标落点时调）——游标落点=用户显式起点意图，
//   过时段记忆若留着，切换换源 onSwap 会把视频拉回旧位置（老板序列「拖到段首→点播放→跳到第 4 秒」）。
export function clearSegPos(clip) {
  const k = segPosKey(clip);
  if (k) _segPos.delete(k);
}

// 活动视频当前显示的产物 = file？（口径同 playerNeedsSource·批 F97 抽此共用判据）
//   换源窗口（备位预载中·活动位仍是上一段源）用它把「游标命中片段」与「实际在播的源」对齐判定。
function srcMatches(video, file) {
  if (!video || !video.src || !file) return false;
  return video.src.includes(encodeURIComponent(file));
}

// F97 换源补 seek 的目标解析（导出纯函数·onSwap 消费）——按**换入段自身几何**定位：
//   旧实现按「游标命中的片段」算 seek 目标，而换源窗口游标还停在上一段区间 → 新段视频被
//   seek 到旧段几何（实测段2/段3 各自被拉到自身片尾 4.9s → 全程未播 → 级联跳段）。
//   目标片段：clipAtPlayhead 命中片段 file===path 优先（游标已进新段时），否则 mainClips
//   首个 file===path 的片段（游标还在旧段区间时 = 本次真正换入的段）。
//   源内时间 = triml + clamp(phTime − acc − triml, 0, effDur − 0.01) × speed
//     —— acc = 前序 effDur+triml 累加（同 syncPhFromVideo）；clamp 只钳轴域 offset，
//     之后才 ×speed 转源域（effDur−0.01 是轴域尾差·直加源域会越界）。
export function computeSwapSeekTarget(clips, path, phTime) {
  const arr = Array.isArray(clips) ? clips : [];
  if (!path) return null;
  const hit = clipAtPlayhead(arr, phTime);
  let clip = (hit && hit.clip && hit.clip.file === path) ? hit.clip : arr.find((c) => c && c.file === path);
  if (!clip) return null;
  const index = arr.indexOf(clip);
  let acc = 0;
  for (let i = 0; i < index; i++) acc += effDurOf(arr[i]) + axisTrimlOf(arr[i]);
  const trimlSrc = +clip.triml || 0;                        // 源域：源内起点（split- 段=分割点）
  const trimlAxis = axisTrimlOf(clip);                       // 轴域：本体左缘偏移（split- 段=0）
  const spd = clipSpeedOf(clip);
  const off = Math.max(0, (+phTime || 0) - acc - trimlAxis); // 轴域 offset（与 acc 同域）
  const offset = Math.min(Math.max(0, effDurOf(clip) - 0.01), off);
  return { clip, srcTime: trimlSrc + offset * spd };
}

// 换源补 seek：抽出 renderPlayhead 的暂停态 seek 段（换位后与游标拖动共用一段逻辑）
function seekActiveToPlayhead() {
  if (!S || !S.root) return;
  const _hit = clipAtPlayhead(es().mainClips || [], S.phTime);
  const _vd = S.root.querySelector("#editPlayer video");   // 活动位（双缓冲不变式）
  // 批 A T2：解除 paused-only 守卫——播放态拖游标也要让视频跟到新位（原先只认暂停态·
  //   播放中拖动画面不跟 = 画面与游标脱节）。设 currentTime 不打断播放（真机语义），
  //   故此处既不 pause 也不重起 play。
  if (!_hit || !_vd || !_hit.clip || !_hit.clip.file) return;
  // F97 守卫：命中片段≠活动视频源（备位预载中·活动位还是上一段）→ 本轮跳过
  //   （否则拿新段几何 seek 旧源：旧实现是级联跳段的环①之一）
  if (!srcMatches(_vd, _hit.clip.file)) return;
  const _t = (+_hit.clip.triml || 0) + _hit.offset * clipSpeedOf(_hit.clip);
  // 批 A T3 复查（T2 遗留⑤）：0.04 死区**维持不变**，但语义已变——
  //   派生时钟落地前，phTime 由 rAF 独立外推推进，两者每帧天然差一帧量（≈0.042s），
  //   死区恰在边缘 → 播放中可能每帧写一次 currentTime（真机卡顿风险·T2 风险2）。
  //   派生后 phTime 每帧由 video.currentTime 反算，_t 与 currentTime 恒等（浮点级差），
  //   死区不再被跨越 → 稳态零写入（已由「稳态不逐帧重写 currentTime」用例钉住）。
  //   此刻死区的职责 = 「已在目标位就别写」+ 吸收用户 seek 后的残差。
  //   注：真机门（批 A §四）仍需看「播放中拖动是否掉帧」，掉帧则上调而非删除。
  if (Number.isFinite(_t) && Math.abs((+_vd.currentTime || 0) - _t) > 0.04) {
    try { _vd.currentTime = _t; } catch (_e) { /* metadata 未就绪 seek 拒绝：忽略（下次渲染补 seek） */ }
  }
}

// 批C C-T2（②A5）：无命中段时是否保留最后画面——双缓冲两个条件都满足才保：
//   ①轨非全空（正片/音频任一有内容 = 只是游标落在主轨之外或占位段，不是「片子空了」）；
//   ②容器内有活动 video（_editDual 已建或单 video 在——二者的 video 元素都在容器内，
//     统一按 DOM 判，不必分别问句柄）。任一不满足 → 走原清理分支。
function keepLastFrame(state, pl) {
  if (!(state.mainClips || []).length && !(state.audioClips || []).length) return false;
  return !!(pl && pl.querySelector("video"));
}

// ===== 批 E-T1（方案 §三裁决 1）：预览表现归口函数 =====
// 纯函数·一段在预览里的真实表现（st = editingState·不读 S 故可单测）：
//   muted = 轨静音 || 片段已分离音视频（主轨该 clip = 视频半·-an 语义·音频半走音频轨·批 F 预留）
//   volume = clipVolumeOf × fadeGain（srcSec 处的线性淡化包络·批 E-T4）
//   filter = 片段调色优先（clipColorOf 非 isColDefault）→ 全局兜底（normalizeColor(st.color)）→ 皆默认返 null
//   transform = kfTransformOf（srcSec 处的关键帧插值串·批 E-T9）
//   opacity = kfOpacityOf（srcSec 处的透明度插值·批 G-b T8·无关键帧返 null）
// 三个挂点（renderPlayer 活动/备位 · onSwap promote 后 · 同源显示分支）一律走它取表现，
//   禁止旁路直写 video 的 muted/volume/style.filter——各自内联算必互相覆盖（换源交叉淡化 120ms
//   窗口两 video 表现串扰：游标已进新段而活动 video 还在放旧段）。
export function previewSurfaceOf(clip, st, srcSec) {
  const seg = clipColorOf(clip);                    // 无 clip → normalizeColor(null) = 全默认
  const gCol = normalizeColor(st && st.color);
  let filter = null;
  if (!isColDefault(seg)) filter = colPreviewCss(seg);
  else if (!isColDefault(gCol)) filter = colPreviewCss(gCol);
  const vol = clipVolumeOf(clip) * fadeGainOf(clip, srcSec);
  return {
    muted: !!((st && st.mutedMain) || clipSplitAVOf(clip)),
    // 消费侧防御钳制（E-T3 遗留 1 收编）：本函数是 volume 落到 video.volume 的唯一路径，
    //   越界值（项目 JSON 脏值等）打过去会抛 IndexSizeError。控件/存储侧的 clampVolume 口径
    //   不动（那里管「写什么进库」），只在归口消费点钳一道。
    volume: Math.min(1, Math.max(0, vol)),
    filter,
    transform: kfTransformOf(clip, srcSec),
    // 批 G-b T8（F-15a·与 T10 同步交付）: 第五字段 opacity = kfOpacityOf 独立插值轨
    //   （值域 [0,1]·无关键帧返 null → 挂点清空串）。消费侧窗口期协调见 applyPreviewSurface。
    opacity: kfOpacityOf(clip, srcSec),
  };
}
// 批 E-T4（方案 §三裁决 1「淡化语义=音量包络」）：片段在**源内秒** srcSec 处的线性淡化增益。
//   fadeIn ：srcSec ∈ [0, fadeIn] 线性 0→1，≥ fadeIn 恒 1
//   fadeOut：以内容末（= dur·内容相对域·与 fadeIn 窗同域）倒数 fadeOut 秒线性 1→0
//     —— 窗终点是 dur 不是 triml+dur：srcSec 值域恒 [0, dur]（见下），源域末那截永不可达。
//   两窗相乘（旧档默认读侧 clipFadeInOf 兜 0·两窗皆 0 时恒 1=无淡化）。
//   srcSec 语义 = 源内秒（调用方给 video.currentTime − raw triml·timeline.js:45「源域照读 raw
//   triml」·split- 段走源域 triml），故变速段包络按源内秒走、轴内被压成 1/speed 倍长。
function fadeGainOf(clip, srcSec) {
  const fin = clipFadeInOf(clip);
  const fout = clipFadeOutOf(clip);
  if (!(fin > 0) && !(fout > 0)) return 1;
  const t = Number.isFinite(+srcSec) ? +srcSec : 0;
  let g = 1;
  if (fin > 0) g *= t <= 0 ? 0 : (t >= fin ? 1 : t / fin);
  if (fout > 0) {
    const end = +(clip && clip.dur) || 0;
    g *= t >= end ? 0 : (t <= end - fout ? 1 : (end - t) / fout);
  }
  return g;
}
// 源内秒（= video.currentTime − raw triml·源域）——三个挂点算 srcSec 的唯一口径，
//   免得各挂点各写一遍减法（日后改口径必漏一处）。
function srcSecOf(v, clip) {
  return (+(v && v.currentTime) || 0) - (+(clip && clip.triml) || 0);
}
// 归口面 → video 元素（唯一写口）·filter/transform 空态（null）直清空串
// 批 G-a G-T1（批 E 遗留③）：同值跳过——rAF 帧内每帧重算同一 surface，四字段零重复赋值。
//   muted/volume 直接比较；filter/transform 比较「上次设置的值」缓存（CSSOM style 读回
//   序列化可能不同形；本函数是唯一写口〔上方禁旁路直写注〕→ 缓存与实值不漂）。
const _surfaceLast = new WeakMap();
function applyPreviewSurface(v, s, opts) {
  if (!v || !s) return;
  if (v.muted !== !!s.muted) v.muted = !!s.muted;
  if (v.volume !== s.volume) v.volume = s.volume;
  let last = _surfaceLast.get(v);
  // 首触从元素实值播种（勿臆断 ""——桩节点未写过时读得 undefined·空态直清须真写一次建立属性）
  if (!last) { last = { filter: v.style.filter, transform: v.style.transform }; _surfaceLast.set(v, last); }
  const f = s.filter == null ? "" : s.filter;
  if (last.filter !== f) { v.style.filter = f; last.filter = f; }
  // 批 E-T9：无关键帧段返 null → 直清空串（换源到无关键帧段不得残留上一段的 transform）
  const t = s.transform == null ? "" : s.transform;
  if (last.transform !== t) { v.style.transform = t; last.transform = t; }
  // 批 G-b T10（F-15c·裁决 5 窗口期暂停）: opacity 直写（null 清 ""·不残留）——_surfaceLast 缓存
  //   **不扩 opacity**（逐帧时变项·无同值跳过意义）；opts.skipOpacity=true（换源窗口判据
  //   kfOpacitySkipOf）时只跳过 opacity 写——窗口内交叉淡化交给 styleOf，其余四字段照常。
  if (!(opts && opts.skipOpacity)) v.style.opacity = s.opacity == null ? "" : String(s.opacity);
}
// 容器内非活动位的那个 video（备位/退位元素·双缓冲容器恒两元素）——不经句柄取
// （createDualVideo 只暴露 active()·其内部不动·方案 §六）
function standbyVideoOf(pl, activeEl) {
  for (const n of pl.querySelectorAll("video")) if (n !== activeEl) return n;
  return null;
}
// 批 G-b T10（F-15c·方案 §一 T10 行 v3/§二裁决 5）：opacity 预演窗口期暂停判据（座位区分·v3 钉死）。
//   备位（standbyVideoOf 判）且 pendingPath 非空 → skip（预载新源·交叉淡化 styleOf 管·帧内不写）；
//   活动位仅查 promote 时间戳——promote 后 fadeMs ms 内 skip（CSS transition 完成点·非 180ms——180 是
//   清理 timer），窗外照写；**活动位在 pendingPath 期照写**（旧源在播·关键帧照常生效——防
//   「pendingPath 期全局 skip」误实现）。now 由调用方注入（单测直测判据·生产传 Date.now()）。
const KF_PROMOTE_FADE_MS = 0;   // 批 L3 T-B（R-23②·方案 T-B 节档 A）：120→0（剪辑页硬切·窗口零宽）·
                                //   与剪辑页 createDualVideo 的 fadeMs:0 同调（两处常量须同改）；
                                //   preview.js 概况页走缺省 120 不受此常量影响。
function kfOpacitySkipOf(pl, v, now) {
  if (!v || !_editDual) return false;
  const active = _editDual.active();
  if (!active) return false;
  if (standbyVideoOf(pl, active) === v) return !!_editDual.pendingPath();
  const t0 = S ? +S._lastPromoteAt : NaN;
  return Number.isFinite(t0) && now - t0 < KF_PROMOTE_FADE_MS;
}
export function _test_kfOpacitySkipOf(pl, v, now) { return kfOpacitySkipOf(pl, v, now); }

// ===== 批F F-T4（方案 §三裁决 2·v5 锁定）：预听引擎 =====
//   audio 元素挂 #editPlayer 容器内（buildPlayer 建·unmount/stopPlay 清·无视觉面纯发声）
//   + /view 源拼装（absPath → type=input|output + filename + subfolder·根外哑条）
//   + 对表（锚定优先/哑位静默/轴窗回落）+ 七驱动路径 + 音频面归口 + 相位回正。
// ---- /view 根（模块级取一次）----
//   input 根 = GET /h3_batch/input_dir（audio_upload.js 同端点）；output 根三级解析（R-59-T2b 补切：⓪ workspace_root 非空优先·shell.js C 同款优先链·旧通道退役收口）：
//   ①gui13.paths.server_output_dir（次级回退·退役后仅存量残留值可吃）②input 根同级 output 段推导
//   推不出 output 根 → output 域哑条（splitAV 半静默·防御性登记 §七.16 同族）。
let _audioRoots = null;
export function _test_setAudioRoots(roots) { _audioRoots = roots || null; }
function ensureAudioRoots() {
  if (_audioRoots) return;
  request("/h3_batch/input_dir", { cache: "no-store" }).then((r) => {
    if (_audioRoots) return;
    const dir = r && r.ok && r.data && typeof r.data.dir === "string" ? r.data.dir.trim() : "";
    if (!dir) return;   // 失败留 null：下次 mount 重试
    _audioRoots = { input: dir, output: audioOutputRootOf(dir) };
  }).catch(() => {});
}
function audioOutputRootOf(inputDir) {
  const ws = loadWorkspaceRoot(); if (ws) return ws;   // R-59-T2b 补切：工作区根非空优先（旧值/同级推导降为次级回退）
  try {
    const ls = (typeof globalThis !== "undefined") ? globalThis.localStorage : null;
    const raw = ls && ls.getItem ? ls.getItem("gui13.paths") : null;
    const cfg = raw ? JSON.parse(raw) : null;
    const p = cfg && typeof cfg.server_output_dir === "string" ? cfg.server_output_dir.trim() : "";
    if (p) return p;
  } catch (_e) { /* 坏 JSON：走同级推导 */ }
  const trimmed = String(inputDir || "").replace(/[\\/]+$/, "");
  const m = /^(.*[\\/])input$/i.exec(trimmed);
  return m ? (m[1] + "output") : "";
}
export function _test_audioOutputRootOf(inputDir) { return audioOutputRootOf(inputDir); }   // 测试接缝（_test_kfOpacitySkipOf 同款）
// abs 是否落在 root 下 → 相对子路径（原大小写保真·反/正斜杠统一）；根外或恰等于根 → null
function underRootRel(abs, root) {
  const a = String(abs).replace(/[\\/]+/g, "/");
  const r = String(root).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!a || !r) return null;
  return a.toLowerCase().startsWith(r.toLowerCase() + "/") ? a.slice(r.length + 1) : null;
}
// /view 源拼装纯函数（裁决 1：filename=basename·type=input|output·subfolder=子路径正斜杠·全 encodeURIComponent）
export function audioSrcOf(file, roots) {
  const R = roots || _audioRoots || {};
  const abs = String(file == null ? "" : file).trim();
  if (!abs) return null;
  for (const type of ["input", "output"]) {
    const rel = underRootRel(abs, R[type]);
    if (rel == null) continue;
    const segs = rel.split("/").filter(Boolean);
    const filename = segs.pop();
    if (!filename) return null;
    const sub = segs.join("/");
    // 批 B #13：URL 收敛 mediaUrl 单源（/view 已构造路径直通归一——同源部署输出与旧裸相对逐字节同形）
    return mediaUrl("audio", "/view?filename=" + encodeURIComponent(filename) + "&type=" + type
      + (sub ? "&subfolder=" + encodeURIComponent(sub) : ""));
  }
  return null;   // 两根之外（理论不可达）→ 哑条
}

// ---- 对表纯函数（裁决 2 v5：锚定优先→哑位轴窗）----
//   返回 { kind:"anchor"|"axis", clip, seg, offset } | null：
//   · anchor：clip=音频半（file/音量面）·seg=主轨同 segId 段（现值跟随：视频半修剪后按主轨新窗几何）
//   · axis：seg=clip 自身（id 制·seek/包络取自身字段）
//   · null：无窗·或轴窗命中锚定条（哑位：占轴位但轴位期恒静默·视觉与发声窗严格一致）
//   锚定判断式统一=「主轨存在同 segId 段」（split- 右半主轨必无同段=天然非锚定）。
export function audioWindowAt(audioClips, mainClips, phTime) {
  const auds = Array.isArray(audioClips) ? audioClips : [];
  const mains = Array.isArray(mainClips) ? mainClips : [];
  const hasMainSeg = (sid) => {
    const s = String(sid || "");
    return !!s && mains.some((c) => String((c || {}).segId || "") === s);
  };
  // 主轴窗 [start, start+effDur)（clipAtPlayhead 同口径·0.001 容差在下方命中比较）——
  // 批 H T2 起走 trackWindowsOf 共源（与导出组装器同消费·防复制漂移）
  const wins = trackWindowsOf(mains);
  for (const a of auds) {
    if (!a || !hasMainSeg(a.segId)) continue;
    const w = wins.find((x) => String((x.clip || {}).segId || "") === String(a.segId));
    if (!w) continue;
    if (phTime >= w.start - 0.001 && phTime < w.end - 0.001) {
      return { kind: "anchor", clip: a, seg: w.clip, offset: phTime - w.start };
    }
  }
  const hit = clipAtPlayhead(auds, phTime);   // 全量数组（泛型直用·不过滤=哑位语义）
  if (!hit) return null;
  if (hasMainSeg(hit.clip.segId)) return null;   // 命中锚定条 → 视为未命中（静默）
  return { kind: "axis", clip: hit.clip, seg: hit.clip, offset: hit.offset };
}

// ---- 音频面归口（照批 E previewSurfaceOf 模式）----
//   muted = 轨静音 mutedAudio；volume = clipVolumeOf × fadeGainOf（srcSec=源内秒·消费侧钳制）。
//   applyAudioSurface 是唯一写口——禁止旁路直写 audio.muted/volume。
export function audioSurfaceOf(clip, st, srcSec) {
  return {
    muted: !!(st && st.mutedAudio),
    volume: Math.min(1, Math.max(0, clipVolumeOf(clip) * fadeGainOf(clip, srcSec))),
  };
}
function applyAudioSurface(a, s) {
  if (!a || !s) return;
  a.muted = !!s.muted;
  a.volume = s.volume;
}

// ---- 驱动引擎（七路径共用的唯一音频驱动口）----
let _audioEl = null;                  // buildPlayer 建·unmount 摘引用
let _audioAlignKey = "";              // 在播窗身份（clip 身份|kind）——窗/源切换才全量重寻
let _audioAutoplayToasted = false;    // autoplay 拦截降级 toast 一次性去重
const AUDIO_PHASE_EPS = 0.08;         // 相位回正阈值（秒·仅对表段 speed=1 适用·变速全豁 §七.19）

function audioPauseIfSounding() {
  const a = _audioEl;
  if (a && a.paused !== true) a.pause();   // pause 不 stop：随窗恢复自动续
}
function audioStop() {   // 路径 4（stopPlay）/unmount：停+清
  const a = _audioEl;
  if (!a) return;
  audioPauseIfSounding();
  if (typeof a.removeAttribute === "function") a.removeAttribute("src");
  else a.src = "";                          // 桩无 removeAttribute
  if (typeof a.load === "function") a.load();
  _audioAlignKey = "";
}
// 对表帧：查窗→/view 换源→按公式 seek→速率→归口面→起播（play=播放意图·吞拒降级 toast）
function audioAlignFrame(play) {
  const a = _audioEl;
  if (!a || !S || !S.root) return;
  const st = es();
  const w = audioWindowAt(st.audioClips || [], st.mainClips || [], S.phTime);
  if (!w) { audioPauseIfSounding(); return; }   // 无窗/哑位：静默（不清 src·随窗恢复自动续）
  const src = audioSrcOf(w.clip.file);
  if (!src) { audioPauseIfSounding(); return; } // 根外/无 file（F-T1 前旧档）：哑条
  const spd = clipSpeedOf(w.seg);
  const target = (+w.seg.triml || 0) + w.offset * spd;   // 入窗 seek = rawTriml + offset×speed（锚定/轴窗各取对表段字段）
  const key = String(w.clip.id || w.clip.label || "") + "|" + w.kind;
  if (!String(a.src || "").endsWith(src)) {
    a.src = src;                          // 换条目=src 切换+seek（单 audio 元素·轴窗互斥不做混音）
    if (a.dataset) a.dataset.audioFbFile = w.clip.file || "";   // 批 B #13：回落目标随条目刷新
    try { a.currentTime = target; } catch (_e) { /* metadata 未就绪：规格上记默认起播位·就绪即生效 */ }
    _audioAlignKey = key;
  } else if (key !== _audioAlignKey) {    // 同源换窗（分割两半同 file）
    try { a.currentTime = target; } catch (_e) { /* 同上 */ }
    _audioAlignKey = key;
  } else if (spd === 1 && Math.abs((+a.currentTime || 0) - target) > AUDIO_PHASE_EPS) {
    // 相位回正（仅 speed=1·speed≠1 窗内按 1x 推进而期望按 speed 增长→重 seek=整窗 stutter·全豁）
    try { a.currentTime = target; } catch (_e) { /* 同上 */ }
  }
  a.playbackRate = w.kind === "anchor" ? spd : 1;   // 锚定期跟随主轨 speed·轴窗期恒 1x（边界②）
  applyAudioSurface(a, audioSurfaceOf(w.clip, st, srcSecOf(a, w.seg)));   // 包络 srcSec = 实际播放体域秒实算
  if (play && a.paused !== false && typeof a.play === "function") {
    const p = a.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {   // autoplay 吞拒 + 一次性降级提示（不再静默哑火）
        if (_audioAutoplayToasted) return;
        _audioAutoplayToasted = true;
        showToast("info", t("edit.audio.autoplayBlocked"));
      });
    }
  }
}

// F97-f1：摘除原生控件条全屏钮（Chrome 私有伪元素）——controls 不可链，只能给元素挂标记 +
//   全局样式一次注入（每个 media 元素·幂等）。留 controlsList=nofullscreen 作 Safari/WebKit
//   口径。命中伪元素：fullscreen-button（Chrome 新版）/ fullscreen-start-button（旧版）；
//   exit-button 同样摘（进全屏后钮条上的「退出」会退回元素全屏·双入口不一致）。
const NATIVE_FS_HIDE_ID = "ip1-native-fs-hide";
const NATIVE_FS_CSS = [
  "video[__mediaCtlHidden]{::-webkit-media-controls-fullscreen-button{display:none!important}",
  "video[__mediaCtlHidden]{::-webkit-media-controls-fullscreen-start-button{display:none!important}",
  "video[__mediaCtlHidden]{::-webkit-media-controls-fullscreen-exit-button{display:none!important}",
  "audio[__mediaCtlHidden]{::-webkit-media-controls-fullscreen-button{display:none!important}",
].join("");
function hideNativeFullscreen(v) {
  if (!v || v.__mediaCtlHidden) return;
  v.__mediaCtlHidden = true;
  try {
    if (typeof document === "undefined" || !document.head || !document.createElement) return;
    if (document.getElementById && document.getElementById(NATIVE_FS_HIDE_ID)) return;
    const st = document.createElement("style");
    st.id = NATIVE_FS_HIDE_ID;
    st.textContent = NATIVE_FS_CSS;
    (document.head || document.documentElement).appendChild(st);
  } catch (_e) { /* 无 DOM 桩环境：标记已挂·样式注入失败不影响判定 */ }
}

function renderPlayer(state) {
  const pl = S.root.querySelector("#editPlayer");
  if (!pl) return;
  // T6 历史载入后 mainClips 条目带 file（产物绝对路径）→ video 真源; 未载入 → 占位
  const cur = clipAtPlayhead(state.mainClips || [], S.phTime);
  const file = cur && cur.clip && cur.clip.file;
  if (file) {
    // 批 10-L F91a：双缓冲句柄（容器重建时重挂）·换源走备位预载·canplay 后换位
    if (!_editDual || _editDual.container !== pl) {
      _editDual = createDualVideo(pl, {
        // 批 L3 T-B（R-23②·方案 T-B 节档 A）：未选转场段 = 硬切——淡化时长传 0（去 120ms
        //   观感淡化）。双缓冲预载 / 延迟清源 / F97a controls / 退位静音 / 恒铺满五项防黑闪
        //   机制不动（清源窗 fadeMs+60=60ms·换入位 canplay 已就绪必有一帧·充足）。
        //   与下方 KF_PROMOTE_FADE_MS 同调（两处常量·回闪兜底 16~40ms 见方案 §已知边界）。
        //   缺省 120 保留不动——preview.js 概况页与 O-T2 独立用例走缺省路径（旧行为哨）。
        fadeMs: 0,
        // 批 M3 T3 · R-43：剪辑页隐藏原生 controls（段级钳位死锁 = 走查反馈⑨ 病根）·
        //   屏上进度/播控改走 T2 自绘全片进度条 + 自绘播控。preview.js 概况页与
        //   final_preview overlay 不传此项 = 缺省 true 零改动。
        nativeControls: false,
        initVideo: (v) => {
          v.style.maxWidth = "100%";
          v.style.maxHeight = "100%";
          // F97b + F97-f1：原生 ⛶ 全屏 video 元素（promote 换位即死）→ 摘走·容器全屏钮接管。
          //   controlsList 是 WebKit 专有·Chrome 不认（暂停态控件条截图实证原生 ⛶ 仍在），
          //   故补 Chrome 私有伪元素隐藏（controls 不可链，只能每元素挂隐藏标记 → 全局样式）。
          v.controlsList = "nofullscreen";
          hideNativeFullscreen(v);
          // 走查反馈 F1（老板 2026-09-27「游标和预览视频没有帧级同步」）：原生播放键播放不走 GUI
          //   pvTimer（视频自播·游标不动）→ timeupdate 校准反推游标（rAF 外推见 startPhRaf）
          v.addEventListener("timeupdate", () => syncPhFromVideo());
          // 批 A T1：原生 play/pause/ended 接入 GUI 播放态（原先原生键完全不通知 GUI·
          //   原生暂停后 pvTimer 照跑 = 壁钟劫持游标）。三个监听器首行统一走活动位守卫——
          //   换位/淡出清源会在非活动位元素上触发 pause·ended，误响应=播放态被竞态劫持。
          v.addEventListener("play", () => onActiveMediaEvent(v, "play"));
          v.addEventListener("pause", () => onActiveMediaEvent(v, "pause"));
          v.addEventListener("ended", () => onActiveMediaEvent(v, "ended")); // 无 playlist 时走单段接续
          // 批 A T3（F103 老板场景「点了播放没反应·不知道哪错了」）：加载异常兜底。
          //   error = 真失败（产物缺失/解码失败）→ 报错 + 停播；stalled/waiting = 缓冲（正常态）
          //   → 轻提示且不判停。三个监听器与上方同款活动位守卫（在 onActiveMediaEvent 首行）。
          v.addEventListener("error", () => onActiveMediaEvent(v, "error"));
          v.addEventListener("waiting", () => onActiveMediaEvent(v, "waiting"));
          v.addEventListener("stalled", () => onActiveMediaEvent(v, "stalled"));
          // #12-T4（R-46 项③）：缓冲指示三清除源——playing/canplay/timeupdate 任一即清
          //   （走 onActiveMediaEvent 活动位守卫·同上方监听器惯例）
          v.addEventListener("playing", () => onActiveMediaEvent(v, "playing"));
          v.addEventListener("canplay", () => onActiveMediaEvent(v, "canplay"));
          v.addEventListener("timeupdate", () => onActiveMediaEvent(v, "timeupdate"));
        },
        // F97e：预热源换位闸——预热就绪时游标未必已跨界，只有游标真正跨进预热段区间
        //   （或活动位已 ended·ended 链接续前置态）才放行换位。既有路径 show() 均在游标
        //   跨界后调 → 闸恒放行（行为不变）；仅预热路径会短暂被拦。
        canPromote: (f) => {
          if (!f) return true;
          const hit = clipAtPlayhead(es().mainClips || [], S.phTime);
          if (hit && hit.clip && hit.clip.file === f) return true;
          const av = _editDual ? _editDual.active() : null;
          return !!(av && av.ended);
        },
        // P0-#17：备位加载失败降级——toast 一条（每文件每次挂载至多一条）+ 坏文件记账
        //   （S._badSegFiles）。记账后三闸收口：预热不再重发（preheatStandby）、换源不再发起
        //   （playerNeedsSource）、ended 接续目标段坏即停（continueNextClip）——不死等
        //   promote/playWhenReady，本段播完即停（与活动位 error「报错+停播」A-T3 同惯例）。
        onError: (badPath) => {
          if (!badPath || !S) return;
          if (!S._badSegFiles) S._badSegFiles = new Set();
          if (S._badSegFiles.has(badPath)) return;
          S._badSegFiles.add(badPath);
          showToast("error", t("edit.player.badFile"));
        },
        onSwap: (v, info) => {
          // 批 G-b T10（F-15c）: 回调**首行**记 promote 时间戳（v3 钉死：先于本回调内的
          //   applyPreviewSurface 调用点——记晚了首帧读到旧时间戳会立即覆写淡入）；消费见 kfOpacitySkipOf。
          if (S) S._lastPromoteAt = Date.now();
          // 批 F97 环①/环③：换入段按 info.path 现解析（闭包 cur 恒为「建双缓冲那一次」的片段——
          //   容器不重建即永为首次渲染片段，变速段速率/记忆键必错）；seek 目标按换入段几何算。
          const tgt = computeSwapSeekTarget(es().mainClips || [], info.path, S.phTime);
          // 批 L3 T-C（R-23①）预览转场模拟层：退位段出口转场（相邻交界 + 播放序才播·判据见
          //   playSwapTransOverlay 注释）。挂点在本行之后·改写 S._activeClipRef 之前——那时
          //   _activeClipRef 仍指着退位段（retire 身份口径·E-T6 对号在 activeClipIndex 内）。
          playSwapTransOverlay(pl, tgt && tgt.clip, info.wantPlay || info.wasPlaying);
          const tClip = tgt ? tgt.clip : cur.clip;
          // 批E T1 退位元素（身份矩阵）：promote 后原活动位立即静音——R-23② 硬切口径下视觉
          //   同刻切换（fadeMs=0·无淡出），音频仍瞬时止（否则两段声音叠加）。执行位置=本挂点
          //   在更新 _activeClipRef 前对原活动位 video 引用设·只设 volume 不动其余表现（不动
          //   createDualVideo 内部·方案 §六）。批 L3 T-B：原「120ms 淡出/叠加」为陈文·注释勘正。
          // 批 M3-T1④：退位同时 pause——退位源继续播到 fadeMs+60ms 清理点仍占一份解码
          //   （显存 + CPU 各一份 = 交接卡顿半边）。同点一行·活动位守卫（onActiveMediaEvent
          //   首行「容器第一 video」）拦其 pause 事件·不误改 GUI 播放态。
          const demoted = standbyVideoOf(pl, v);
          if (demoted) { demoted.volume = 0; demoted.pause(); }
          // 批C C-T2：记下「活动 video 此刻在播哪个 clip 实例」——接续定位按它走（见
          //   activeClipIndex）。tgt=null = 本次换入的源不在轨内 → 清引用（接续回退反查）。
          if (S) S._activeClipRef = tgt ? tgt.clip : null;
          // S3-3 T2 定案①（T3 顺手项修正速率方向）: playbackRate = speed（speed 是快放倍速语义 ·
          //   与「有效时长 = dur ÷ speed」同向; 详案原文 1/speed 系笔误·主代理裁决）
          v.playbackRate = clipSpeedOf(tClip);
          // 批E T1：换位后活动位表现按现解析段（tClip）设；opacity 窗口判据（首行刚记时间戳 → 此处必 skip·淡入让位）
          // 批E T4：srcSec 取 promote 当下**已知**的源内秒（活动 video 此刻真实位置；备位预载从未 seek
          //   → 恒为预载起点 0），起播首帧即有包络值，随后由帧内更新跟随（seek 落在下方·此刻不算）。
          applyPreviewSurface(v, previewSurfaceOf(tClip, es(), srcSecOf(v, tClip)), { skipOpacity: kfOpacitySkipOf(pl, v, Date.now()) });
          // 批 10-L F91b：段落位置记忆——有起播意图（连播/播放中推进）时按游标走（防跳播），
          //   否则有记忆且未超时长 → seek 恢复并保持暂停（用户切段意图是「看」不是「接着播」）
          const mem = info.wantPlay ? null : recallSegPos(tClip, v.duration);
          if (mem != null) {
            try { v.currentTime = mem; } catch (_e) { /* metadata 未就绪：忽略 */ }
            syncPhFromVideo();   // 游标跟到记忆位置（否则下次 renderPlayhead 会把视频 seek 回段首）
          } else if (tgt) {
            // 无记忆 → 按换入段几何定位（游标此刻停在哪就接哪·不按上一段残留位置）
            try { v.currentTime = tgt.srcTime; } catch (_e) { /* metadata 未就绪：忽略 */ }
          } else {
            seekActiveToPlayhead();   // path 不在轨内（编辑态已变）→ 回落旧路
          }
        },
      });
    }
    // P0-#17 T8：第四路径补闸（坏文件记账口径同 playerNeedsSource）——store 事件驱动的
    //   renderAll 重入不得对已记账坏段重发 show（404 重放 + error 处理器误杀 wantPlay）。
    //   非坏文件路径不动：needsLoad 在途/同源态由 show 自身幂等兜（same 分支清过期预载语义保留），
    //   故闸只收坏文件一条。
    const skippedBad = S && S._badSegFiles && S._badSegFiles.has(file);
    if (!skippedBad) _editDual.show(file);
    // 非加载中（同源已在显示）→ 直接补速率；加载中由 onSwap 补（换位后生效）
    // P0-#17 T9：下游身份分支同拦——坏段跳过期 pendingPath 恒空=假「非加载中」，禁把坏段速率/包络/身份套上活动位（走 else 语义）
    if (!skippedBad && !_editDual.pendingPath()) {
      const v = _editDual.active();
      if (v) v.playbackRate = clipSpeedOf(cur.clip);
      // 批E T1 活动位表现：同源/首载无换源窗口 → 活动 video 正在放的就是 cur.clip
      //   （分割双半同 file 时 _activeClipRef 还指着左半·按 cur.clip 取才不会串段表现）
      if (v) applyPreviewSurface(v, previewSurfaceOf(cur.clip, es(), srcSecOf(v, cur.clip)), { skipOpacity: kfOpacitySkipOf(pl, v, Date.now()) });
      // 批C C-T2：活动位已在显示本源且无在途换源 → 活动实例即 cur.clip（记引用给接续定位）。
      //   覆盖 onSwap 触不到的两种同源形态：首载落显示位（activePath 空·无 promote）与
      //   分割双半同 file 相邻推进（show 返 "same"·不换源不换位）——缺这一步右半播毕
      //   会按 file 反查首条接回右半自身。
      if (v && S) S._activeClipRef = cur.clip;
    } else {
      // 批E T1 身份矩阵·换源在途：活动 video 还在放上一段（游标已进新段·srcMatches 守卫区）→
      //   活动位取 S._activeClipRef（null 回落命中段·禁按游标命中段取：会把新段表现套上旧段画面）；
      //   备位取即将上场的 cur.clip——交叉淡化 120ms 窗口两 video 表现一致（新段视觉+听觉同步进场）。
      // 批E T6（同 E-F1 死区分支口径）：_activeClipRef 可能指向**陈旧实例**——改片段的写入都换新
      //   对象（音量/调色面板写 nextClips[i] = {...}）→ 直接按引用取会读到改前值（换源在途窗口改
      //   段音量不反映画面即此）。按 segId 对号取活实例；对不上（多段同 segId/无 segId）→ 回落
      //   引用自身，无引用 → 回落命中段 cur.clip（原行为不变）。
      const v = _editDual.active();
      if (v) {
        const ref = S && S._activeClipRef;
        const ai = ref ? activeClipIndex(state.mainClips || []) : -1;
        const actClip = (ai >= 0 ? state.mainClips[ai] : ref) || cur.clip;
        // 批 G-b T10：活动位仅查时间戳（pendingPath 期照写——旧源在播·关键帧照常生效）；备位仅预载在途 skip
        applyPreviewSurface(v, previewSurfaceOf(actClip, es(), srcSecOf(v, actClip)), { skipOpacity: kfOpacitySkipOf(pl, v, Date.now()) });
        const b = standbyVideoOf(pl, v);
        // 备位按即将上场段 · srcSec=0（预载起点=该段源内 0·备位从未 seek）
        if (b) applyPreviewSurface(b, previewSurfaceOf(cur.clip, es(), 0), { skipOpacity: kfOpacitySkipOf(pl, b, Date.now()) });
      }
    }
  } else if (keepLastFrame(state, pl)) {
    // 批C C-T2（②A5）：死区/占位段保最后画面——无命中段即摧毁双缓冲，会让「游标在主轨
    //   之外（拖过末沿/End 之外）时做任一编辑」= 黑屏。轨全空或容器内无 video → 照旧清理。
    // 批E E-F1（真机抽验抓出·修正笔）：保画面 = 保表现。活动画面显示的仍是 _activeClipRef
    //   那段，死区期间的编辑态变化（静音/音量/调色/淡化）不得停在旧值——真机症状：段3 播毕
    //   phTime 停在片尾 15.0，点钮恢复静音后按钮/数据侧都翻回而 video.muted 卡 true，
    //   须游标拉回段内才自愈。_activeClipRef 为 null（首载前·无段可依）则不设；
    //   备位/退位不动（身份矩阵口径不变·它们此刻也不在显示位）。
    const dv = _editDual && _editDual.active();
    if (dv && S && S._activeClipRef) {
      // 引用可能是**陈旧实例**：改片段的写入都换新对象（调色/音量面板写 nextClips[i] = {...}），
      //   直接按引用取会读到改前值（死区改调色不生效即此）。按 segId 对号取活实例——同一口径见
      //   activeClipIndex（同 segId 命中多条/无 segId → 不认·回落引用自身·行为兜底不变）。
      const ai = activeClipIndex(state.mainClips || []);
      const dclip = ai >= 0 ? state.mainClips[ai] : S._activeClipRef;
      applyPreviewSurface(dv, previewSurfaceOf(dclip, es(), srcSecOf(dv, dclip)), { skipOpacity: kfOpacitySkipOf(pl, dv, Date.now()) });
    }
  } else if (_editDual) {
    // 批 L3 T-C：轨清空销毁双缓冲时同摘在位转场模拟层（不摘=残层压住占位/末帧画面）
    clearTransOverlay();
    _editDual.destroy();
    _editDual = null;
  } else {
    const video = pl.querySelector("video");
    if (video) video.remove();
  }
}

// 批 F97 测试注入位：模拟备位首帧就绪（生产由 canplay 监听驱动 promote）——
//   单测据此打在 edit 侧 onSwap 真接线上（既有 F91a 用例只独立驱动 createDualVideo·覆盖不到接线）
export function _test_promoteEditDual() {
  if (!_editDual) return false;
  _editDual.promote();
  return true;
}

// 批 M7-T2 修正笔测试探针：读「就绪即播」意图置位态（未 ready 跨界 wantPlay 先置位·
//   晚到 canplay promote 收 true 跳 F91b 记忆分支——病灶锁可观察量）
export function _test_editDualWantsPlay() {
  return _editDual ? _editDual.wantsPlay() : false;
}

// 起播意图（连播/播放中跨段切换）：就绪即播·同源立即播（双缓冲下换源后活动位会变）
function playActiveWhenReady() {
  clearFreezeHold();   // 批E E-T8：任何起播路径同清 hold/timer（机制 4·内部起播意图入口）
  audioAlignFrame(true);   // 批F F-T4 七路径 3：起播同起（音频与视频同帧对表+起播）
  if (_editDual) { _editDual.playWhenReady(); return; }
  const v = S && S.root && S.root.querySelector("#editPlayer video");
  if (v && typeof v.play === "function") { const p = v.play(); if (p && typeof p.catch === "function") p.catch(() => {}); }
}

// 是否还需为 file 换源（在途加载也算「已安排」·防 rAF/pvTimer 每帧重复发起）。
//   P0-#17：已记账坏文件同「已安排」口径——error 清 pendingPath 后 needsLoad 复真，
//   不闸则游标停在坏段时每帧重发 show→error（404 风暴）。
function playerNeedsSource(file) {
  if (_editDual) return _editDual.needsLoad(file) && !(S && S._badSegFiles && S._badSegFiles.has(file));
  const v = S && S.root && S.root.querySelector("#editPlayer video");
  return !srcMatches(v, file);
}

// F1 反向同步: 播放器当前源内时间 → 有效轴游标位置。
//   定位 = 游标当前命中的片段（clipAtPlayhead）——不能用 vd.src 反查：同一产物 file 可被
//   副本片段共享（paste- 副本同源），按 src 定位歧义会把游标拉回首段区（真机实测死循环重播）。
//   F9 软校准: 偏差 <0.15s 不回拉（rAF 外推继续·抹平视频 decode 波动的微锯齿），仅大偏差
//   （换片段/缓冲停顿累积）才校正——游标平滑与准确两全。
// 批 A T3：视频时钟 → 游标的**唯一**几何口径（rAF 派生与 timeupdate 校准共用·不重写公式）。
//   target = acc + triml + min(effDur, max(0, (currentTime − triml) / speed))（同 F91b 既有公式）。
//   守卫不过（无源 / 占位段 / 换源窗口 / seek 途中）返回 null，由调用方各自回落：
//     · rAF —— 本帧不派生（沿用当前 phTime）；
//     · timeupdate —— 本轮不校准不记位。
//   位置语义与 srcMatches 守卫前置到 recordSegPos 之前（否则错片段的位置记忆被污染）。
function phTargetFromVideo(clips, vd) {
  if (!vd || !vd.src) return null;
  const hit = clipAtPlayhead(clips, S.phTime);
  if (!hit || !hit.clip || !hit.clip.file) return null;
  // F97 守卫：换源窗口（活动位还是上一段源·备位在途）→ 不派生
  //   （否则把视频时间映射进「游标命中的别段」→ 游标被推至该段末尾 → raf 再触发下一段换源 → 级联）。
  if (!srcMatches(vd, hit.clip.file)) return null;
  // 批 A T2：seek 途中 currentTime 在途 → 不派生（游标会被拽回 seek 起点）。
  if (vd.seeking === true) return null;
  let acc = 0;
  for (let i = 0; i < hit.index; i++) acc += effDurOf(clips[i]) + axisTrimlOf(clips[i]);
  const c = hit.clip;
  // 批 C C-T1 §2.2 双域拆变量：acc/target 是轴域（split- 段轴贡献 0），off 算的是源域（减 raw triml）。
  const trimlSrc = +c.triml || 0;
  const trimlAxis = axisTrimlOf(c);
  const off = Math.min(effDurOf(c), Math.max(0, ((+vd.currentTime || 0) - trimlSrc) / clipSpeedOf(c)));
  return { hit, target: acc + trimlAxis + off };
}
// F1/F9：timeupdate 校准（抹视频时钟与游标的累积偏差）——派生后 rAF 已逐帧跟随，
//   此处降级为「大偏差才回拉」的兜底校准，不再是游标的主推进源。
function syncPhFromVideo() {
  if (!S || !S.root) return;
  if (S._freezeHold) return;   // 批E E-T8：定格 hold 期不派生游标、不记位置记忆（暂停期禁 recordSegPos）
  // F97d：拖拽期不校准不记位——拖拽中早先发起的 seek 落定（ct 停在旧位）后 timeupdate 触发
  //   软校准，会把游标拽回旧 ct（真机 705→660 残余回跳根因）。拖拽期游标以用户落点为准。
  if (S._scrubbing) return;
  const vd = S.root.querySelector("#editPlayer video");
  const r = phTargetFromVideo(es().mainClips || [], vd);
  if (!r) return;
  // 批 10-L F91b：timeupdate 落点即记录本段源内位置（节流 500ms·换段回来可恢复）
  recordSegPos(r.hit.clip, +vd.currentTime || 0);
  if (Math.abs(r.target - S.phTime) > 0.15) {   // F9 软校准：偏差 <0.15s 不回拉
    S.phTime = r.target;
    renderPlayhead(S.pxs);
  }
}

// F1/F9 rAF 外推: 播放中（空格或原生播放键·video 非暂停）游标一律由视频时钟驱动——
//   rAF 逐帧外推（平滑）+ timeupdate 每次到点校准（抹 decode 漂移）+ 跨片段自动换源续播。
//   F9 根因（老板「游标有问题」·真机采样实锤）: 原实装空格播放 pvTimer(+0.2/200ms 壁钟) 与
//   timeupdate 校准互拉 → 游标 7/14px 交替蠕动走停。统一时钟源后 pvTimer 只管无视频占位段。
let _phRafId = 0;
let _editDual = null;   // 剪辑页双缓冲句柄（容器重建/无产物时置 null）
// F97e：距段内容尾不足此值即预热下一段（秒）·#12 三件套 T1 2.5→0.3（ε 窗·老板 2026-10-13 批
//   ·取证=.tmp/#12取证：旧窗预热落源即建第二解码器与活动位在 GPU 侧串行争抢=段尾卡顿根因，
//   落源延迟到段尾 ε 内）。
//   短段边界（段长≤0.3s）：预热起点=段首·提前量>段长·全程预热——设计内（短段本就快换）。
const F97E_PRELOAD_LEAD = 0.3;   // #12 三件套 T1：预热落源延迟到段尾 ε 窗（原 2.5→0.3·治段尾解码器争抢·老板 2026-10-13 批·取证=.tmp/#12取证）
// 批 M3-T1③：预热门槛 3 的超时兜底钟（模块级·edit 侧预热点写·工厂 isReady 只读）。
//   _preloadSince = 本轮预热起算时刻（null=无在途预热）·now/阈值经 _test_setPreloadClock
//   注入（单测 withRafStub 不推进 Date.now·不可注入则兜底断言不可测·probeVideoDuration
//   timeoutMs 注入同款理由）。
const PRELOAD_READY_LEAD_MS = 1200;
let _preloadSince = null;
let _preloadNow = () => Date.now();
let _preloadLeadMs = PRELOAD_READY_LEAD_MS;
// 批 M7-T1：buffered 覆盖判据窗（秒·单向：待播起点向后覆盖 2.0s = 数据实证可无停等换位）。
//   #12-T3 判据反转 0.5→2.0（W1 §3-C ②档·老板勾选「攒够 2-3 秒才播」·取区间下沿保起播速度）。
const PRELOAD_BUFFER_COVER_S = 2;
// 批 M7-T1：待播起点伴生（_preloadSince 同款模块级·预热点写·show() 复位·工厂 isReady 只读）。
//   预热点写 computeSwapSeekTarget(mainClips, nx.file, S.phTime).srcTime（游标在旧段→offset
//   钳 0→=triml）；非预热点换源=0；preview 复用工厂零感知（缺省 0·preview 域不写）。
let _pendingSrcTime = 0;
export function _test_setPreloadClock(now, ms) {
  _preloadNow = (typeof now === "function") ? now : () => Date.now();
  _preloadLeadMs = (typeof ms === "number") ? ms : PRELOAD_READY_LEAD_MS;
  _preloadSince = null;
}
// 批 M7-T2b 预定位 seek 武装（预热点共用）：triml>0 段预载起点 0≠srcTime → promote 瞬间
//   mid-file seek 在关键路径（方案 §〇.3 残余 3）。预热 show() 落位后挂 loadedmetadata 一次性
//   监听把备位加载起点推进到 srcTime；触发时守卫「该元素仍是备位且 pendingPath 未变」（防晚到
//   覆写活动位/新预载源——promote 后 pendingPath 清空·元素换位身份不再匹配）。纯段（srcTime=0）
//   不武装。与 F91b 关系：promote 时 recallSegPos/onSwap 仍按用户游标权威覆写——先行预定位白做无害。
function armStandbyPreSeek(file, srcTime) {
  if (!(srcTime > 0) || !_editDual || !S || !S.root) return;
  const vd = S.root.querySelector("#editPlayer video");
  const sb = vd ? standbyVideoOf(vd.closest("#editPlayer") || S.root, vd) : null;
  if (!sb || typeof sb.addEventListener !== "function") return;
  const path = String(file || "");
  const onMeta = () => {
    sb.removeEventListener("loadedmetadata", onMeta);   // 一次性（桩 addEventListener 丢 once 选项·手动摘保语义）
    const vd2 = S && S.root && S.root.querySelector("#editPlayer video");
    const cur = vd2 ? standbyVideoOf(vd2.closest("#editPlayer") || S.root, vd2) : null;
    if (cur !== sb || !_editDual || _editDual.pendingPath() !== path) return;   // 已 promote/已换源 → 不 seek
    try { sb.currentTime = srcTime; } catch (_e) { /* seek 拒绝（元数据竞态）忽略 */ }
  };
  sb.addEventListener("loadedmetadata", onMeta);
}
// 批 M7-T2a 预热执行体（rAF 段尾预热 / pvTick 爬行预热两热点共用）：备位提档 auto + show 换源
//   + 预热纪元/待播起点锚（写序钉死：**show() 返回之后**再写——T1 惯例·防 show 内与 pendingPath
//   同点复位把管道打回自相残杀形态）+ T2b 预定位 seek 武装。
function preheatStandby(nx) {
  if (!_editDual || !nx || !nx.file) return;
  // P0-#17：已记账坏文件不再预热——error 清 pendingPath 后 needsLoad 复真，rAF/pvTick
  //   预热窗内会每帧重发 show→error（404 请求风暴）·记账收口。
  if (S && S._badSegFiles && S._badSegFiles.has(nx.file)) return;
  // 批 M3-T1①：备位 preload 提档 auto（工厂缺省 metadata 只读元数据·不拉媒体数据=预热没真预热
  //   ·交接仍顿）。落点=edit 预热点·**不进 createDualVideo.show()**（防 preview.js:331 概况页同链外溢）。
  const vd = S && S.root && S.root.querySelector("#editPlayer video");
  const sb = vd ? standbyVideoOf(vd.closest("#editPlayer") || S.root, vd) : null;
  if (sb) sb.preload = "auto";
  _editDual.show(nx.file);
  _preloadSince = _preloadNow();   // T1③ 预热起算（isReady 超时兜底钟的起点）
  const srcTime = computeSwapSeekTarget(es().mainClips || [], nx.file, S.phTime)?.srcTime || 0;   // M7-T1 待播起点锚（游标在旧段→offset 钳 0→=triml·纯段=0）
  _pendingSrcTime = srcTime;
  armStandbyPreSeek(nx.file, srcTime);   // M7-T2b 预定位 seek（srcTime>0 才武装·备位守卫见函数注）
}
function phRafLoop() {
  if (!S || !S.root) { _phRafId = 0; return; }
  const vd = S.root.querySelector("#editPlayer video");
  const playing = vd && !vd.paused && !vd.ended;
  // 批E E-T8：定格判据排在播放分支**之前**——内容末那一刻 phTargetFromVideo 派生出的 phTime
  //   恰落在段界（clipAtPlayhead 半开区间命中下一段），晚一步就被下方换源分支抢走换源；换源后
  //   continueNextClip 按新 _activeClipRef 接续 = 跳段。进 hold 即本帧不再派生游标、不换源
  //   （机制 1：游标停走 + 暂停期禁换源/recordSegPos）。
  const frozen = playing ? freezeHoldEnter(vd) : false;
  if (playing && !frozen) {
    // 批 A T3（F103 治根）：游标**由视频时钟派生**，rAF 不再独立壁钟累加 phTime。
    //   原实现 `S.phTime += min(0.1, dt)` 与 timeupdate 的视频时钟校准是两套独立推进源，
    //   变速段（speed=2）两套速率不一致 → 游标锯齿抖动（A10）。派生后只有一处时钟。
    //   占位段（命中段无 file）派生返回 null → phTime 不动，由 pvTick 壁钟推进（clip 口径）。
    // F97d：拖拽进行期不派生——mousemove 间隙视频 seek 已落定的旧位置会把游标拽回拖点
    //   后方（真机锯齿回跳实测多组）。拖拽期游标以用户落点为准（renderPlayhead→
    //   seekActiveToPlayhead 反向驱动视频）·松手后恢复派生（视频已在落点·无缝续接）。
    const r = S._scrubbing ? null : phTargetFromVideo(es().mainClips || [], vd);
    if (r) S.phTime = r.target;
    const hit = clipAtPlayhead(es().mainClips || [], S.phTime);
    // F97e 预热：距本段内容尾不足 F97E_PRELOAD_LEAD（#12-T1 起 ε=0.3s）预载下一段（gated promote——游标跨界/队列推进
    //   才换位）。换源触发点游标（被 effDur 钳制）恒先到段界·彼时才开载 → 游标在「下一段
    //   左缘」停等（真机实测停等窗 = 文件尾 + 预载全程）。提前预热后跨界即换位·停等归零。
    if (hit && hit.clip && hit.clip.file && !S._scrubbing) {
      const nx = (es().mainClips || [])[hit.index + 1];
      if (nx && nx.file && (effDurOf(hit.clip) - hit.offset) < F97E_PRELOAD_LEAD
        && _editDual && _editDual.needsLoad(nx.file)) {
        preheatStandby(nx);   // 批 M7-T2a：预热执行体抽共用（rAF 段尾/爬行两热点同款·T1 写序不变）
      }
    }
    // B5-T5①：连播期换源由 ended 链驱动——raf 分支不抢换源（防跳播未勾选段 / 换源回跳打断连播）
    if (!S.playlist && hit && hit.clip && hit.clip.file && playerNeedsSource(hit.clip.file)) {
      renderPlayer(es()); // 游标进入下一片段 → 换源（批 F91a：落备位预载·就绪才换位）
      playActiveWhenReady();   // 就绪即播（同源则立即播）
      syncPhFromVideo();
    } else if (!S.playlist && hit && hit.clip && hit.clip.file
      && _editDual && _editDual.pendingPath() === hit.clip.file && _editDual.ready()) {
      // F97e：预热源已就绪且游标已跨界 → 立即换位（canplay 被闸拦下不会再来·见 createDualVideo）。
      // #12-T7（T0-3 定案）：playActiveWhenReady **单调用**——内部 playWhenReady 先置 wantPlay →
      //   ready 即刻 promote，续播由 promote 收敛为 play 恰一次。原 promote()+playActiveWhenReady()
      //   两连调用使一次换位 play() 双发（promote 内 playEl 续播 + playWhenReady 同源立即播·锁A 实证
      //   ×2）。单一调用先例 = M7-T2 pvTick 镜像分支（禁 promote-then-play 次序同口径）。
      playActiveWhenReady();
    }
    renderPlayhead(S.pxs);
    followPlayheadIntoView();   // T6 F-1：播放推进跟随（游标出视口右缘 → 推 scrollLeft·抑制窗内不推）
    // 批E T4/T9：时变项（淡化音量包络 + 关键帧 transform）帧内跟随——挂点只给首帧快照，得逐帧重算。
    //   取段按身份矩阵（活动位 = _activeClipRef·null 回落 r.hit 即 clipAtPlayhead 命中段·禁按帧内
    //   新游标取，换源在途期会把新段包络套上还在放旧段的 video）；srcSec = vd.currentTime − raw triml
    //   （源内秒·timeline.js:45 源域照读）。**只读 vd.currentTime，不写游标派生/时钟**（批 A 回归约束）。
    //   门控同 phTargetFromVideo：seek 在途/占位段返回 null 时本帧不重算（避免在途 currentTime 的瞬时包络）。
    // 批E E-F1 遗留 3（主代理裁决随 E-T7 清·同 E-F1 死区分支 / E-T6 换源在途分支口径·三处最后一处）：
    //   _activeClipRef 可能指向**陈旧实例**——改片段的写入都换新对象（音量/调色面板写 nextClips[i]={...}）。
    //   挂点那次按旧引用读得到当时的值，此后**每帧**再按旧引用读 = 每帧把改后的值覆回改前的值
    //   （真机症状：播放中拖音量滑杆拉到一半自己弹回）。按 segId 对号取活实例（同 segId 命中多条/
    //   无 segId → 不认·回落引用自身；无引用 → 回落 r.hit.clip·行为兜底不变）。
    if (r && _editDual && _editDual.active() === vd) {
      // 批 G-b T10：帧内 opacity 同走窗口判据（活动位 promote 后 120ms 内不写·让位交叉淡化）
      // #12-T6（T5 取证定案·老板 2026-10-14 真机亲历界前 ~0.25s 预闪）：本写点只服务「在播活动位」
      //   的表现跟随。视频钟到段界的同一帧内，帧顶派生 r 按旧活动位算得（srcMatches 过），而帧中
      //   镜像分支/就绪即播已把 vd 换位成备位——对陈旧引用照写会把 styleOf 的退位隐藏态（opacity 0）
      //   清成 ""（无关键帧段 null→""）：该元素被复用为备位预载下一段时首帧一落源即盖住在播段
      //   （T5 实测 promote 前 ~240-280ms 备位 opC=1·4/5 界）=界前预闪，亦即界后旧帧残留同源。
      //   非活动位本帧跳写零损失（新活动位 surface 已由 onSwap 挂点全量写过·下一帧重取活动位续写）；
      //   promote 显形仍由 styleOf 同步翻转承担（防黑闪五机制不触·F-91 族锁口径不变）。
      const ref = S && S._activeClipRef;
      const ai = ref ? activeClipIndex(es().mainClips || []) : -1;
      const actClip = (ai >= 0 ? es().mainClips[ai] : ref) || r.hit.clip;
      applyPreviewSurface(vd, previewSurfaceOf(actClip, es(), srcSecOf(vd, actClip)),
        { skipOpacity: kfOpacitySkipOf(vd.closest("#editPlayer"), vd, Date.now()) });
    }
    // 批F F-T4 七路径 1：播放分支音频对表+音量包络帧内跟随（audioSurfaceOf）
    audioAlignFrame(true);
  } else if (!S._freezeHold && !S.pvTimer) {
    // 批F F-T4 七路径 2：非播放（含原生暂停后的停走态）音频随停（pause 不 stop·随窗恢复自动续）。
    //   豁免两态：定格 hold（路径 7·音频照常）；壁钟推进期 pvTimer 在（路径 6·占位段音频由 pvTick 对表续响）
    audioPauseIfSounding();
  }
  _phRafId = requestAnimationFrame(phRafLoop);
}
function startPhRaf() {
  // 无 rAF 环境（Node 单测/SSR）no-op——批 A T3 起 rAF 主循环进了单测（测试注入 rAF 桩），
  // 但守卫仍须留：非浏览器环境没有该全局，直接调用会抛并中断 mount。
  if (typeof requestAnimationFrame !== "function") return;
  if (!_phRafId) _phRafId = requestAnimationFrame(phRafLoop);
}
function stopPhRaf() {
  if (typeof cancelAnimationFrame === "function" && _phRafId) cancelAnimationFrame(_phRafId);
  _phRafId = 0;
}

function updateActiveClip() {
  const main = S.root && S.root.querySelector("#mainTrack");
  if (!main) return;
  main.querySelectorAll(".clip.active").forEach((n) => n.classList.remove("active"));
  const hit = clipAtPlayhead(es().mainClips || [], S.phTime);
  if (hit && hit.index >= 0) {
    const el = main.querySelectorAll(".clip")[hit.index];
    if (el) el.classList.add("active");
  }
}

// ===== 游标 scrub (v43 :4137-4163) =====
function beginScrub(e, grab) {
  S._grabX = Math.max(-60, Math.min(60, grab || 0));
  S._scrubbing = true;
  document.body.classList.add("noselect");
  applyScrub(e);
  const mv = (ev) => { if (S && S._scrubbing) applyScrub(ev); };
  const up = () => {
    if (S) S._scrubbing = false;
    document.body.classList.remove("noselect");
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  e.preventDefault();
}

// ===== 框选 marquee（批 I-P2 T10 · F-10 对齐剪映 rubber band）=====
// 三轨空白（非段体/ruler/轨头 .tl-lab）mousedown 起 → 拖拽画选择框（.marquee-box，
//   fixed 挂 body：与事件/段体 rect 同 client 坐标系，不引入 gutter 常数·不进滚动容器
//   不撑滚动区）→ mouseup 框内段体（.clip/.clip-audio 与框矩形相交）加 .sel 多选。
//   与点击选择同一事实源（.sel class）：框选 = selClear 后按框收录（互斥替换）；
//   未拖动的单击框退化为点 → 净效果 selClear = 空白单击清选现行为保持。ruler 不绑本入口。
let _marquee = null;       // 框选手势态（mousedown→mouseup 非空）
let _marqueeDrag = false;  // 本次框选发生拖动 → 抑制紧随合成 click 清选（一次性·click 委托消费）
function beginMarquee(e) {
  if (!S || !S.root || e.button) return;   // 左键才框选（右键 = 空白菜单）
  const box = document.createElement("div");
  box.className = "marquee-box";
  box.style.left = e.clientX + "px";
  box.style.top = e.clientY + "px";
  document.body.appendChild(box);
  _marquee = { x0: e.clientX, y0: e.clientY, box };
  _marqueeDrag = false;
  document.body.classList.add("noselect");
  const mv = (ev) => {
    if (!_marquee) return;
    const w = Math.abs(ev.clientX - _marquee.x0), h = Math.abs(ev.clientY - _marquee.y0);
    if (w > 2 || h > 2) _marqueeDrag = true;   // 2px 死区：手抖不算拖
    box.style.left = Math.min(_marquee.x0, ev.clientX) + "px";
    box.style.top = Math.min(_marquee.y0, ev.clientY) + "px";
    box.style.width = w + "px";
    box.style.height = h + "px";
  };
  const up = (ev) => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("noselect");
    const m = _marquee;
    _marquee = null;
    if (m && m.box) m.box.remove();
    if (!m || !S || !S.root) return;
    selClear();
    if (!_marqueeDrag) return;   // 单击未拖动 → 到此即清选（现行为保持）
    const L = Math.min(m.x0, ev.clientX), R = Math.max(m.x0, ev.clientX);
    const T = Math.min(m.y0, ev.clientY), B = Math.max(m.y0, ev.clientY);
    S.root.querySelectorAll(".clip, .clip-audio").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < R && r.right > L && r.top < B && r.bottom > T) el.classList.add("sel");
    });
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
  e.preventDefault();
}
// 批 A T2：游标定位纯函数（applyScrub 的坐标签名抽离）——把「像素 → 落点 → 换源」
//   收成一处，拖拽 / 方向键 / Home·End / 标记跳转四类入口共用同款语义：
//   落点即用户显式起点意图 → clearSegPos（清过时位置记忆·F95d 同款），
//   跨段则按 F99 修法驱动换源（不自动播——调用方各自决定是否起播）。
//   不碰 S.playlist：连播换源由 ended 链独占（:1540/:1605 守卫语义保持）。
function seekTo(sec) {
  clearFreezeHold();   // 批E E-T8：切段早退（机制 4·用户拖游标/方向键/Home·End/标记跳转 = 放弃定格）
  const end = filmEndSec(es().mainClips, es().audioClips);
  S.phTime = Math.max(0, Math.min(end, +sec || 0));
  // M-T8 F95d：显式落点 = 起点意图 → 清落点段的过时位置记忆
  //   （否则换源 onSwap 会按记忆 seek 回旧位置·覆盖用户意图）
  const hit = clipAtPlayhead(es().mainClips || [], S.phTime);
  if (hit && hit.clip) clearSegPos(hit.clip);
  renderPlayhead(S.pxs);
  // 批 10-O F99：跨段也得换源——换源驱动原本只有 rAF/pvTimer/连播队列/拖拽四处，
  //   方向键/Home·End/标记跳转不在其中，跨段跳转后画面还冻在原段源。
  //   守卫同 rAF 分支：!S.playlist（连播换源由 ended 链独占·不抢源）+ needsSource 幂等。
  //   刻意不调 playActiveWhenReady——是否起播由调用方决定（跳转不自动播）。
  if (!S.playlist && hit && hit.clip && hit.clip.file && playerNeedsSource(hit.clip.file)) {
    renderPlayer(es());
  }
  // 批F F-T4 七路径 5：对表跳（seek 目标按公式重寻·播放意图随 GUI 播放态——暂停态只对位不起播）
  audioAlignFrame(!!S.pvTimer);
  return S.phTime;
}
// 批 M2 R-41 拖动域限（批 M3 T2 抽纯函数·自绘进度条与时间线尺两消费点同钳）：
//   落点命中无产物段 → 钳到该段轴域起点（clipBodyStart·不跳越：游标最多停在占位段左边界）。
//   落产物段/轴尾死区/占位段 triml>0 的轴左边距带（命中窗不含边距带 → hit=null）不拦。
//   快拖单次步长可越过短占位段（hit 落其后产物段=合法落点·静止落点恒不在占位段本体内）。
//   hasBefore 门（主代理 2026-10-09 T4 停报裁决二）：命中占位段且其前存在有产物段才钳——
//   全占位项目/开头占位段=守卫无价值场景（无产物可跳越·钳只会推离真实落点）→ 不钳。
//   签名纯 (clips, sec)：**不含 _scrubbing 门**——门留在各消费点（合成链 _scrubbing=false
//   不钳语义保持 + 自绘条拖动链各自守门）·不塞进 seekTo（键盘/标记/爬行域不动）。
export function scrubClampSec(clips, sec) {
  const arr = clips || [];
  const hit = clipAtPlayhead(arr, sec);
  if (hit && hit.clip && !hit.clip.file) {
    const hasBefore = arr.slice(0, hit.index).some((c) => c.file);
    if (hasBefore) return clipBodyStart(arr, hit.index);
  }
  return sec;
}

function applyScrub(e) {
  const mainTrack = S.root.querySelector("#mainTrack");
  const r = mainTrack.getBoundingClientRect();
  const px = e.clientX - (S._grabX || 0) - r.left;
  let sec = px / S.pxs;
  // 批M2 R-41 拖动域限（批 M3 T2 抽 scrubClampSec 纯函数·门留在本调用处）
  if (S._scrubbing) sec = scrubClampSec(es().mainClips || [], sec);
  seekTo(sec);
  followPlayheadIntoView();   // T6 F-1：拖游标跟随（B 档阻断 1 需求半边·continueNextClip 换源落点同经此）
}

// 段本体起点（轴内秒）= 自身轴左边距 + 前序 (effDur+轴左边距) 累加（同 playQueueItem 口径）。
//   T1 接续与 T4 循环共用一处公式，避免两处各写一份漂移。
function clipBodyStart(clips, idx) {
  let start = axisTrimlOf(clips[idx]);
  for (let i = 0; i < idx; i++) start += effDurOf(clips[i]) + axisTrimlOf(clips[i]);
  return start;
}
// F97 修二（老板 2026-10-07 口径·覆盖批 C C-T2 爬行设计）：占位段其后**再无产物段** = 尾部占位。
//   true  → 播完最后产物段即停（游标停在最后产物段末尾·不爬占位段——「后面全是没生成的段
//           还在滑行」观感已否决）；false → 占位段在中间·其后还有产物段·保留壁钟爬行
//   （F97c 段3 接播链路依赖）。空轨兜底 true（无产物可等）。
export function trailingPlaceholderFrom(clips, idx) {
  const arr = Array.isArray(clips) ? clips : [];
  for (let i = idx + 1; i < arr.length; i++) if (arr[i] && arr[i].file) return false;
  return true;
}
// 停止口径的完整判据（两个出口共用·防口径分叉）：占位段在其后无产物段**且**其前已有产物段
//   （老板口径字面场景=「播完最后一个有产物段后」）。全程无产物段 → 不停——占位段试听
//   （批 F 音频链路用例形态：占位段 + BGM 走轴）不纳入停止口径。
export function stopAtTrailingPlaceholder(clips, idx) {
  const arr = Array.isArray(clips) ? clips : [];
  let hasBefore = false;
  for (let i = 0; i < idx; i++) if (arr[i] && arr[i].file) { hasBefore = true; break; }
  return hasBefore && trailingPlaceholderFrom(arr, idx);
}
// J-P1（老板 2026-10-07 复验卡「一段分成100份 播放完毕后 游标应在片尾 但是结束播放时游标在90的位置」
//   ·新口径覆盖 F97 修二「停在最后产物段末尾」）：尾部占位播完 → 游标**一次性落到整片末尾**
//   （片尾=filmEndSec·与 End 键/游标头总时长同源），不停在最后产物段末尾、也不沿占位段爬行。
//   ended 接续与壁钟 pvTick 两个停止出口共用本函数（防口径分叉）。
function stopAtFilmEnd() {
  S.phTime = filmEndSec(es().mainClips, es().audioClips);
  renderPlayhead(S.pxs);   // 游标落位（命中段=null → seekActiveToPlayhead 早退·画面留末帧）
  stopPlay();
}
// 批 A T4：循环三态（纯视图态·模块级变量·不入项目数据·每次 mount 复位为「关」）。
//   关 = 现状（T1 单段接续 + 连播队列自然结束）；段 = 本段播完回本段起点；全片 = 播完绕回片头。
const LOOP_NAMES = [t("edit.loop.off"), t("edit.loop.seg"), t("edit.loop.all")];
let _loopMode = 0;
function loopTitle() {
  return [t("edit.loop.titleOff"), t("edit.loop.titleSeg"), t("edit.loop.titleAll")][_loopMode];
}
// 批C C-T2：活动源实例定位——S._activeClipRef 指向「活动 video 此刻正在播的那个 clip」
//   （renderPlayer 的 onSwap 换源时写 + 同源已在显示时写）。continueNextClip 优先按它
//   定位刚播完的段：分割双半同 file 时，file 反查首条恒命中左半 → target=右半自身
//   = 重播右半死循环。引用按 segId 对号（reconcile 换过对象也能对上）·命中多条
//   （存量同 segId 双半形态）或无 segId → 不认，回退原反查链（行为兜底不变）。
function activeClipIndex(clips) {
  const ref = S && S._activeClipRef;
  const sid = String((ref && ref.segId) || "");
  if (!sid) return -1;
  let idx = -1;
  for (let i = 0; i < clips.length; i++) {
    if (String((clips[i] || {}).segId || "") !== sid) continue;
    if (idx >= 0) return -1;              // 同 segId 命中多条 → 无法唯一定位实例
    idx = i;
  }
  return idx;
}

// 批 A T1：单段 ended 接续（无连播时）——当前段播毕 → 换源下一段 + 起播。
//   刚播完的段按 **ended 元素的源** 反查（不用游标命中段）：真机时序是「播到片尾 →
//   timeupdate 把游标反推到段界（clipAtPlayhead 命中下一段）→ 才 fire ended」，
//   按游标接续会整段跳过刚跨到的那一段（与 F97 级联跳段同款·实测复现）。
//   不写 S.playlist：拖拽/rAF 的 !S.playlist 守卫（:1540/:1605）语义保持·连播态走队列不误入。
function continueNextClip(v) {
  const clips = es().mainClips || [];
  if (!clips.length) return false;
  // 游标在段界时命中下一段·且下一段源已换入时，活动位就是下一段——此时 ended 属上一段，
  //   按源反查即可定位；源不在轨内（编辑态已变）时回落游标命中段。
  const hit = clipAtPlayhead(clips, S.phTime);
  let idx = activeClipIndex(clips);
  if (idx < 0) {                          // 批C C-T2：引用失效（未记/已删/对不上）→ 回退原反查
    idx = clips.findIndex((c) => c && c.file && srcMatches(v, c.file));
    if (idx < 0) idx = hit ? hit.index : -1;
  }
  if (idx < 0) return false;
  // 批 A T4：目标段随循环模式定——段循环=本段、全片=下一段（末段绕回片头）、关=下一段。
  let target = idx + 1;
  if (_loopMode === 1) target = idx;
  else if (_loopMode === 2 && target >= clips.length) target = 0;
  const tclip = clips[target];
  if (!tclip) return false;                 // 末段播毕且循环=关：无下一段可接
  // P0-#17：目标段产物已坏（预热/换源 error 已记账）→ 不发起换源死等——本段播完即停
  //   （游标停在坏段左缘=本段末；toast 已在 error 时发过·此处静默停·A-T3 error 停播同惯例）。
  if (tclip.file && S._badSegFiles && S._badSegFiles.has(tclip.file)) { stopPlay(); return true; }
  S._grabX = 0;                            // 无拖拽上下文·抓取偏移归零（applyScrub 按此反解 clientX）
  const trk = S.root.querySelector("#mainTrack");
  const left = trk ? trk.getBoundingClientRect().left : 0;
  applyScrub({ clientX: left + clipBodyStart(clips, target) * S.pxs });  // 换源（命中段有 file 时由 applyScrub 内部驱动）
  renderPlayer(es());
  // F97c：目标段无产物（占位段）时不起播——playEl 落在已 ended 的活动视频上会被浏览器
  //   自动回卷重放（真机复现：占位段爬行期前一段视频反复回卷·下一段从未播出）。
  //   占位段游标由壁钟推进（pause 事件已清场·此处重启 pvTimer 保 GUI 播放态）·爬进
  //   下一个有产物段时由 pvTick 的 want 分支接续换源起播（既有路径）。
  // F97 修二：目标占位段且其后已无产物段 = 片尾（其后无产物段可播）
  //   J-P1 新口径：游标**直接落整片末尾**并停播（不停在最后产物段末尾·不沿占位段爬行）；
  //   循环档=段/全片不受此限（target 恒为有产物段·走上面的起播分支）。
  if (tclip.file) playActiveWhenReady();
  else if (!stopAtTrailingPlaceholder(clips, target)) startPlayState();
  else stopAtFilmEnd();
  return true;
}

// ===== 批 E-T8：定格预演轻版（方案 §三裁决 3 四机制·freeze 不计入 effDur·timeline.js:31「另案」口径维持）=====
//   内容末 = raw triml + dur（**源域**·split- 右半同口径）− ε——**非文件末**：修剪段的内容末远早于
//   文件末，'ended' 链不会自然触发，接续须主动驱动（机制 3）。
const FREEZE_END_EPS = 0.05;   // 内容末判据容差（秒·帧内 currentTime 不必精确落在末帧上）
// 进 hold → true；不满足判据 → false。取段按身份矩阵（活动位 = _activeClipRef·批 E-T7 F 活实例口径：
//   游标命中段在内容末那一刻已跨到下一段·按它取会拿错段的 freeze）。
function freezeHoldEnter(vd) {
  if (!S || !vd || S._freezeHold) return false;
  const clips = es().mainClips || [];
  const ref = S._activeClipRef;
  const ai = ref ? activeClipIndex(clips) : -1;
  const clip = ai >= 0 ? clips[ai] : ref;
  const frz = clip ? clipFreezeOf(clip) : null;
  if (!frz || +vd.currentTime < (+clip.triml || 0) + (+clip.dur || 0) - FREEZE_END_EPS) return false;
  S._freezeHold = true;
  vd.pause();     // 标志先置：pause 事件 → onActiveMediaEvent 守卫（hold 期保播放态·不清 pvTimer）
  S._freezeTimer = setTimeout(() => {
    S._freezeTimer = 0;
    S._freezeHold = false;
    // 与 ended 事件同路（批 E-F2 同款分支式：判定须在 onQueueEnded 之前取·队列尾它会 stopPlay 清 playlist）
    if (S.playlist) onQueueEnded(); else continueNextClip(vd);
  }, frz.sec * 1000);
  return true;
}
// 早退清理（机制 4）：任何停播 / 起播 / 切段路径都要走它——留着 timer 则到点跳段
//   （用户在 hold 期手动恢复播放后被劫持切段）。
function clearFreezeHold() {
  if (!S) return;
  if (S._freezeTimer) { clearTimeout(S._freezeTimer); S._freezeTimer = 0; }
  S._freezeHold = false;
}

// 批 A T1：壁钟推进判据钉死 clip 口径——「命中段无 file（占位段）」才走壁钟。
//   原判据是元素口径「video && !video.paused」：占位段期间旧 video 仍在 DOM
//   （换源三处条件均「命中段有 file」·:1540/:1605/本函数）且可能仍非暂停 → 误判为
//   「视频时钟接管」→ 占位段壁钟冻死（游标卡在占位段）。
//   有视频段仍由 rAF+timeupdate 视频时钟驱动（壁钟推进会与之互拉致蠕动走停·F9 根因）。
function pvTick() {
  if (!S) { stopPlay(); return; }
  if (S._freezeHold) return;   // 批E E-T8：定格 hold 期壁钟不得推进游标（占位段）也不得触底停播
                               //   （末段定格尤其：phTime 落在内容末端 = filmEndSec·会当场 stopPlay 掐掉定格）
  const end2 = filmEndSec(es().mainClips, es().audioClips);
  const clips = es().mainClips || [];
  const hit = clipAtPlayhead(clips, S.phTime);
  if (!hit || !hit.clip || !hit.clip.file) {
    // J-P1（老板 2026-10-07 新口径·覆盖 F97 修二「游标退回本段起点」）：占位段且其后已无产物段
    //   = 片尾 → 游标**直接落整片末尾**并停播（不停在最后产物段末尾、也不沿占位段空滑）。
    //   覆盖拖游标进占位段后起播等非 ended 路径；中间占位段（其后还有产物段）照旧爬行。
    if (hit && hit.clip && !hit.clip.file && stopAtTrailingPlaceholder(clips, hit.index) && _loopMode === 0) {
      stopAtFilmEnd();
      return;
    }
    const before = hit;                            // 本拍所属段（占位段无源可换·只能壁钟走）
    S.phTime = Math.min(end2, S.phTime + 0.2);
    renderPlayhead(S.pxs);
    followPlayheadIntoView();   // T6 F-1：壁钟推进跟随（占位段期 rAF 播放分支不可达·此处为有效推进点）
    const clipHit = clipAtPlayhead(clips, S.phTime);
    // 批 A T4：段循环含占位段——壁钟走完本段（跨进下一段）即回本段起点。
    //   取 before（本拍起点所属段）而非 clipHit（跨过去的下一段），否则会循环到下一段去。
    if (_loopMode === 1 && before && clipHit && clipHit.index !== before.index) {
      seekTo(clipBodyStart(clips, before.index));
      return;
    }
    // 批 M7-T2a 爬行预热补线：占位段爬行期 video paused → rAF 预热分支不可达（方案 §〇.2 残余
    //   路径 2）——取「下一个产物段」（hit.index+1 起向后扫·跳过连续占位·首个有 file 者），距其
    //   轴起点不足 F97E_PRELOAD_LEAD（clipBodyStart(nx)−phTime<ε=0.3）即执行同款预热——游标跨进
    //   该段时 pendingPath 已就位，由下方镜像分支 promote+续播（不现场换源停等）。
    if (hit && _editDual) {
      let ni = hit.index + 1;
      while (ni < clips.length && !(clips[ni] && clips[ni].file)) ni++;
      const nx = clips[ni];
      if (nx && nx.file && _editDual.needsLoad(nx.file)
        && clipBodyStart(clips, ni) - S.phTime < F97E_PRELOAD_LEAD) {
        preheatStandby(nx);
      }
    }
    // 占位段走进有产物片段 → 接续起播（rAF 只在 video 非暂停时接管）
    const want = clipHit && clipHit.clip && clipHit.clip.file;
    if (want && playerNeedsSource(want)) {
      renderPlayer(es());
      // 跨片段切换 → 速率跟随该片段 speed（定案① speed=playbackRate 口径·由 onSwap 补）
      playActiveWhenReady();
    } else if (want && _editDual && _editDual.pendingPath() === want) {
      // 批 M7-T2 短路回归补丁（复核必改 1）：预热后 needsLoad=false → 上分支 renderPlayer+
      //   playActiveWhenReady 全跳（爬到产物段全静默=回归）。镜像：游标已跨界且预热源在途 →
      //   **单一调用** playActiveWhenReady()——内部 playWhenReady 先置 wantPlay → ready 即刻
      //   promote：onSwap 收 wantPlay=true 跳过 F91b recallSegPos 陈旧记忆分支+controls 暂停
      //   上架不复发（禁 promote-then-play 次序：爬行期 aEl.paused=true→wasPlaying=false·
      //   wantPlay 晚置会走记忆分支从陈旧位起播+拽游标）。修正笔（主代理裁决）：去 ready()
      //   前提——备位未就绪跨界（加载慢于预热提前窗）时 ready()=false 不进镜像 → wantPlay
      //   不置位 → 晚到 canplay promote 收 false 走记忆分支+不续播（病灶残留）；无条件置位
      //   后未 ready 等 canplay（promote 收 true 跳记忆分支·A3/A5 锁）。
      playActiveWhenReady();
    }
  }
  // 批F F-T4 七路径 6：补一次音频对表（video ended/保帧态 rAF 播放分支不可达·200ms 粒度够窗切换
  //   ——BGM 长窗跨占位段不漏；路径 2 的 !S.pvTimer 豁免保证本拍不被 rAF 掐停）
  audioAlignFrame(true);
  if (S.phTime >= end2) stopPlay();
}

// ===== 播放 (v43 pvTogglePlay·D026) =====
// 批 A T1：GUI 播放态真值统一到 S.pvTimer——原生 play/pause/ended 与空格共用同一对
//   置起/停函数（原先只有 togglePlay 内联置起·原生键完全不通知 GUI）。
//   置起须幂等：置起前判 !S.pvTimer——盲 setInterval 重赋值会泄漏旧句柄，两份壁钟并跑=倍速推进。
function startPlayState() {
  if (!S || S.pvTimer) return;
  const pl = S.root && S.root.querySelector("#editPlayer");
  if (pl) pl.classList.add("playing");
  S.pvTimer = setInterval(pvTick, 200);
}
function stopPlayState() {
  if (S && S.pvTimer) { clearInterval(S.pvTimer); S.pvTimer = null; }
  const pl = S && S.root && S.root.querySelector("#editPlayer");
  if (pl) pl.classList.remove("playing");
}
// ===== #12-T4（R-46 项③）waiting 内嵌缓冲指示 =====
//   真数据不足（断网/慢盘 → waiting）起 800ms 计时，到点播放器容器内嵌「缓冲中…」
//   （现状画面卡住零反馈——批M2 R-39 删「视频加载中…」toast 后缓冲期再无任何提示）。
//   800ms = 30fps 缺帧观感阈值同量级经验值（取证停滞判定同量级），无硬依据。
//   非 toast 形态（A-T3 锁：播放期 waiting/stalled 零 toast——容器内元素不算 toast）。
//   计时句柄 stopPlay 必清（unmount 经 stopPlay 同清）——本仓孤儿定时器前科 +
//   套件自然退出门禁。
let _bufTimer = null;
function clearBuffering() {
  if (_bufTimer) { clearTimeout(_bufTimer); _bufTimer = null; }
  const pl = S && S.root && S.root.querySelector("#editPlayer");
  const el = pl && pl.querySelector(".pv-buffering");
  if (el) el.remove();
}
function startBuffering(v) {
  clearBuffering();   // 幂等：waiting 重入不叠加计时
  const pl = S && S.root && S.root.querySelector("#editPlayer");
  if (!pl) return;
  _bufTimer = setTimeout(() => {
    _bufTimer = null;
    const host = S && S.root && S.root.querySelector("#editPlayer");
    if (!host || host.querySelector("video") !== v) return;   // 活动位守卫（同 onActiveMediaEvent 首行）
    if (host.querySelector(".pv-buffering")) return;
    const d = document.createElement("div");
    d.className = "pv-buffering";
    d.textContent = t("edit.player.buffering");
    // 容器为 flex 列布局（edit.css:20）——绝对定位居中悬浮，不挤占 video/播控行（白名单无 css 文件·样式内联）
    d.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:6px 14px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;z-index:4;pointer-events:none";
    host.appendChild(d);
  }, 800);
}
// 原生媒体事件统一入口（initVideo 三个监听器共用·含活动位守卫）。
//   活动位不变式：容器内首个 video（:1198-1200）——demoted 元素 clearSource/淡出
//   窗口触发的 pause·ended 一律不响应（换源竞态不得改 GUI 播放态）。
function onActiveMediaEvent(v, kind) {
  if (!S || !S.root) return;
  const pl = S.root.querySelector("#editPlayer");
  if (!pl || pl.querySelector("video") !== v) return;   // 守卫：非活动位一律不响应
  if (kind === "play") { clearFreezeHold(); startPlayState(); return; }
  // 批E E-T8：定格 hold 期的 pause 是**我们自己**发起的（内容末定格·机制 1）→ 保持播放态不清场；
  //   否则 stopPlayState 摘 playing 类 + 清 pvTimer = 定格一进 GUI 就显示「已暂停」，且到点接续
  //   的壁钟兜底（占位段路径）被摘。用户主动暂停（native pause 键）不在 hold 期，照旧清场。
  if (kind === "pause") { if (S._freezeHold) return; stopPlayState(); return; }
  // 批 A T3：加载异常兜底。error = 真失败（无产物/解码失败）→ 报错 + 停播（画面停在
  //   坏帧上继续跑只会让老板以为在播）。批M2 R-39：waiting/stalled = 跨段缓冲（正常态），
  //   「视频加载中…」toast 彻底删（老板裁「彻底」）——但 return 骨架必留：阻断穿透到
  //   下方 ended 接续链，否则缓冲一下就误换源/误起播。
  if (kind === "error") {
    showToast("error", t("edit.player.loadFail"));
    stopPlay();
    return;
  }
  // #12-T4：真数据不足可见化——waiting 起 800ms 计时到点内嵌指示；stalled 保持静默
  //   （R-39 骨架）。playing/canplay/timeupdate = 数据恢复三清除源。一律 return：
  //   不穿透下方 ended 接续链（缓冲一下就误换源/误起播的既有防穿透口径不变）。
  if (kind === "waiting") { startBuffering(v); return; }
  if (kind === "stalled") return;
  if (kind === "playing" || kind === "canplay" || kind === "timeupdate") { clearBuffering(); return; }
  // ended：连播走队列（队列推进 / 队列尾停 + 「连播结束」）；无连播 → 单段接续
  //   （换源下一段 + 起播·不写 S.playlist·拖拽/rAF 的 !S.playlist 守卫语义保持）。
  //   批 E-F2：**分支式**——顺序式「先 onQueueEnded 再判 !S.playlist」在队列尾恒真
  //   （onQueueEnded → stopPlay 清 S.playlist → 返回后判定已失效 → toast「连播结束」后又误播下一段）。
  if (S.playlist) onQueueEnded(); else continueNextClip(v);
}
export function togglePlay() {
  if (!S) return;
  // 批 A T1：判真源——活动 video 在播（原生播放键起播·pvTimer 未必已起）也算在播 → 走停播分支，
  //   否则空格对原生键起播的态是幂等 no-op（按一次没反应·老板「连播空格一键可停」的根因之一）
  const pl0 = S.root && S.root.querySelector("#editPlayer");
  const vd0 = pl0 && pl0.querySelector("video");
  if (S.pvTimer || (vd0 && vd0.paused === false)) {
    stopPlay();
    showToast("info", t("edit.player.paused", { t: fmtClock(S.phTime) }));
    return;
  }
  const end = filmEndSec(es().mainClips, es().audioClips);
  if (S.phTime >= end) S.phTime = 0;
  clearFreezeHold();   // 批E E-T8：起播早退（机制 4·空格起播 = 用户覆盖定格·timer 不清则到点劫持跳段）
  if (pl0) {
    const video = pl0.querySelector("video");
    if (video) video.play().catch(() => {});
  }
  startPlayState();
}
export function stopPlay() {
  clearFreezeHold();   // 批E E-T8：停播早退（机制 4·用户点停/换播/卸载 → 不接续）
  stopPlayState();
  clearBuffering();    // #12-T4：缓冲计时随停播清（unmount 经此同清·孤儿定时器门禁）
  if (S) S.playlist = null; // B5-T5① 连播链随停播终止（暂停/换播/卸载）
  if (_editDual) _editDual.clearIntent(); // 批 A T1：清「就绪即播」意图（防停播后幽灵续播）
  const pl = S && S.root && S.root.querySelector("#editPlayer");
  const video = pl && pl.querySelector("video");
  if (video) video.pause();
  audioStop();   // 批F F-T4 七路径 4：音频停+清（src 清空·窗身份复位）
}

// ===== B5-T5① 勾选连播（H8）=====
//   队列 = selAll() 主轨 .clip 按 DOM 序 + file 有值过滤（无产物段/音频段/备选轨候选不入队——
//     播放器按主轴 phTime 定位换源，备选候选无主轴几何）→ 各入选段的本体起点（轴内秒）；
//   播放 = video.ended → 下一队列项换源 play；v2-4：换源后校准 S.phTime 到新片段本体起点
//     （syncPhFromVideo 同源几何），防 phRafLoop raf 换源分支按旧 phTime 命中回跳打断连播。
function queueStartsFromSelection() {
  const starts = [];
  for (const el of selAll()) {
    if (!el.classList.contains("clip")) continue; // 音频片段不参与
    const { kind, list, index, clip } = resolveTrackClip(el);
    if (kind !== "main" || !clip || !clip.file) continue;
    let start = axisTrimlOf(clip);
    for (let i = 0; i < index; i++) start += effDurOf(list[i]) + axisTrimlOf(list[i]);
    starts.push(start);
  }
  return starts;
}
function playQueueItem(i) {
  // P0-#17：队列项产物已坏（error 记账）→ 跳到再下一项（连播不断在好段上·「跳到再下一段」降级）；
  //   其后尽皆坏 → 按队列终局收束（与队列尾同惯例·toast 已在 error 时发过）。
  const qClips = es().mainClips || [];
  while (i < S.playlist.starts.length) {
    const qc = clipAtPlayhead(qClips, S.playlist.starts[i]);
    if (!(qc && qc.clip && qc.clip.file && S._badSegFiles && S._badSegFiles.has(qc.clip.file))) break;
    i++;
  }
  if (i >= S.playlist.starts.length) { stopPlay(); showToast("success", t("edit.playlist.done")); return; }
  S.playlist.i = i;
  S.phTime = S.playlist.starts[i]; // v2-4 校准：命中新片段（raf 换源分支不再按旧位置回跳）
  renderPlayer(es());              // 换源（renderPlayer 按 phTime 命中片段设 src/playbackRate）
  renderPlayhead(S.pxs);           // 暂停态 seek 到本体起点（triml）+ 游标/状态行刷新
  playActiveWhenReady();           // 起播意图（批 F91a：换源走备位·就绪即播）
}
function startPlaylist() {
  const starts = queueStartsFromSelection();
  if (!starts.length) { showToast("info", t("edit.playlist.none")); return; }
  stopPlay();
  S.playlist = { starts, i: 0 };
  const pl = S.root.querySelector("#editPlayer");
  if (pl) {
    pl.classList.add("playing");
  }
  playQueueItem(0);
}
// ended 链：换下一队列项续播；尾段播毕 → 停 + 「连播结束」
function onQueueEnded() {
  if (!S || !S.playlist) return;
  const next = S.playlist.i + 1;
  if (next < S.playlist.starts.length) { playQueueItem(next); return; }
  // 批 A T4：全片循环 → 队列尽后回队首再播一轮（连播是用户显式勾选的循环单元）；
  //   段循环不劫持连播（队列顺序本身是用户意图）——故只有全片档在此生效。
  if (_loopMode === 2) { playQueueItem(0); return; }
  stopPlay();
  showToast("success", t("edit.playlist.done"));
}

// ===== 轨道锁定 / 隐藏 (S3-2 T1) =====
// 双态按轨入 editingState.tracks（store 持久化·刷新后保持）。
//   locked: 该轨片段禁拖禁修剪 —— 守卫挂在拖拽/修剪入口（dragstart / .hnd mousedown / drop）
//   hidden: 轨内视觉消失（.tl-track display:none）—— 轴长计算仍含该轨时长（D024: 隐藏≠缩短时间线）
//   轨道头 .tl-lab 保留（按钮可达，隐藏轨可再点 👁 恢复）
// 批5-R53-TC（R-S1）：静态 alt 键退役 —— TRACK_KINDS 收窄为静态两键；备选轨 = 动态多轨
//   （[data-track="alt-N"]·按需生成），行名随代际派生（trackLabelOf）。
const TRACK_LABEL = { main: t("edit.track.main"), audio: t("edit.track.audio") };
const TRACK_FLAG_VERB = { locked: [t("edit.track.verbLock"), t("edit.track.verbUnlock")], hidden: [t("edit.track.verbHide"), t("edit.track.verbShow")] };
// 动态备选轨 kind（与 store ALT_DYNAMIC_TRACK_RE 同口径·store 未导出·勿单边改）
const ALT_TRACK_RE = /^alt-\d+$/;
const isAltKind = (kind) => ALT_TRACK_RE.test(String(kind));
const trackLabelOf = (kind) => {
  if (TRACK_LABEL[kind]) return TRACK_LABEL[kind];
  const m = /^alt-(\d+)$/.exec(String(kind));
  return m ? t("edit.track.altLabel", { n: m[1] }) : String(kind || "");
};
// 当前渲染中的动态备选行（renderTracks 重建前清旧行用）
function altRowEls() {
  if (!S || !S.root) return [];
  return [...S.root.querySelectorAll(".tl-row[data-track]")].filter((r) => isAltKind(r.getAttribute("data-track")));
}
// 备选条目代际解析: altChains 权威分组（buildAltChains·T-B 模型随渲染重建读取）cid→gen 直读优先；
//   未入链条目（老档无 cid/无 segId）按 R1 兜底句：条目 gen>0 优先 → seq>0 → 代际 1。
function altGenMapOf(alts) {
  const chains = buildAltChains(Array.isArray(alts) ? alts : []);
  const m = new Map();
  for (const k of Object.keys(chains)) for (const it of chains[k].items) m.set(it.cid, it.gen);
  return m;
}
function altGenOf(c, genMap) {
  const g = c && genMap ? genMap.get(c.cid) : null;
  if (typeof g === "number" && g > 0) return g;
  const cg = c && typeof c.gen === "number" ? c.gen : 0;
  if (cg > 0) return cg;
  const sq = c && typeof c.seq === "number" ? c.seq : 0;
  return sq > 0 ? sq : 1;
}

function renderTrackFlags(state) {
  // 批5-R53-TC：行清单以 DOM 为准（静态 main/audio 行 + 按需生成的 alt-N 动态行）——
  //   旗标读侧经 trackFlag（alt-N 经 normalizeTracks 只认 hidden·B4 形态）。
  // 批 J-P4：audio 一行拆「分离音频/BGM」两 lane 的同步语义由逐行遍历天然覆盖。
  for (const row of S.root.querySelectorAll(".tl-row[data-track]")) {
    const kind = row.getAttribute("data-track");
    const locked = trackFlag(state.tracks, kind, "locked");
    const hidden = trackFlag(state.tracks, kind, "hidden");
    const track = row.querySelector(".tl-track");
    // 走查反馈 F27（老板「点隐藏整个轨道都消失了·应半透明预览图表达」）：display:none →
    //   半透明 35% 预览（隐藏轨内容仍可看到轮廓·轴长仍含该轨·D024 口径不变）
    if (track) track.style.opacity = hidden ? "0.35" : "";
    const lk = row.querySelector('.mbtn[data-flag="locked"]');
    if (lk) {
      lk.classList.toggle("on", locked);
      lk.title = locked ? t("edit.tl.lockedTitle") : t("edit.tl.lockTitle");
    }
    const hd = row.querySelector('.mbtn[data-flag="hidden"]');
    if (hd) {
      hd.classList.toggle("on", hidden);
      hd.title = hidden ? t("edit.tl.hiddenTitle") : t("edit.tl.hideTitle2");
    }
  }
}

function toggleTrackFlag(kind, flag) {
  const cur = es();
  const on = !trackFlag(cur.tracks, kind, flag);
  writeEs({ tracks: withTrackFlag(cur.tracks, kind, flag, on) });
  showToast("info", t("edit.track.flagToast", { label: trackLabelOf(kind), verb: on ? TRACK_FLAG_VERB[flag][0] : TRACK_FLAG_VERB[flag][1] }));
}

// 片段/轨道 DOM → 所属轨 kind（经 .tl-row[data-track] 上溯）
function elTrackKind(el) {
  const row = el && el.closest ? el.closest(".tl-row[data-track]") : null;
  return row ? row.getAttribute("data-track") : null;
}
function elTrackLocked(el) {
  const kind = elTrackKind(el);
  return kind ? trackFlag(es().tracks, kind, "locked") : false;
}
function elTrackHidden(el) {
  const kind = elTrackKind(el);
  return kind ? trackFlag(es().tracks, kind, "hidden") : false;
}

// ===== 静音 (v42 件1·D017/D018) =====
function toggleMute(kind) {
  const state = es();
  if (kind === "main") {
    const on = !state.mutedMain;
    writeEs({ mutedMain: on });
    showToast("info", on ? t("edit.track.mutedMain") : t("edit.track.unmutedMain"));
  } else {
    const on = !state.mutedAudio;
    writeEs({ mutedAudio: on });
    showToast("info", on ? t("edit.track.mutedAudio") : t("edit.track.unmutedAudio"));
  }
}

// ===== 分割 (D019/D020) =====
// 入口两处: 工具条「✂ 分割」钮 + 热键 Ctrl+B (S3-2 T3) —— 同一函数同一语义。
// 锁定轨: 分割属修剪类操作, 与 T1 锁定守卫同口径 (禁拖禁修剪禁分割)。
// 批F F-T3 (F-11): 增音频命中路（方案 §三裁决 3）——优先级：
//   ① 选中集含音频条且游标在其轴窗内 → 优先分割选中音频（BGM 压视频段常态下主轨处处命中，
//     不设优先级则音频分割 Ctrl+B 不可达 = 功能降级·v3 A 档复核建议 6）；
//   ② 主轨命中（既有行为不变）；
//   ③ 主轨无命中再查音频轨（泛型 clipAtPlayhead·timeline.js·不新造函数）。
//   音频轨锁 = trackFlag("audio")（此前只查 main 轨锁）。
// 分割命中裁决（doSplit 与菜单置灰同源·避免两处各判一次漂移）
function splitHitOf(state) {
  const audioHit = clipAtPlayhead(state.audioClips || [], S.phTime);
  const selAudClips = selAll()
    .filter((el) => el.classList.contains("clip-audio"))
    .map((el) => resolveTrackClip(el))
    .filter((rc) => rc.kind === "audio" && rc.clip)
    .map((rc) => rc.clip);
  const mainHit = clipAtPlayhead(state.mainClips || [], S.phTime);
  if (audioHit && selAudClips.includes(audioHit.clip)) return { kind: "audio", hit: audioHit };
  if (mainHit) return { kind: "main", hit: mainHit };
  if (audioHit) return { kind: "audio", hit: audioHit };
  return null;
}
// 批 G-a G-T3（F-5）：右键「分割」置灰守卫——游标是否落在该片段上（与 doSplit 命中裁决同源）
function splitHitsClip(el) {
  const r = splitHitOf(es());
  const rc = el ? resolveTrackClip(el) : null;
  return !!(r && rc && rc.clip && r.hit.clip === rc.clip);
}
function doSplit() {
  const state = es();
  const r0 = splitHitOf(state);
  if (!r0) { showToast("error", t("edit.split.noHit")); return; }
  const { kind, hit } = r0;
  if (trackFlag(state.tracks, kind, "locked")) { showToast("info", t("edit.common.trackLocked")); return; }
  const r = splitClipAt(hit.clip, hit.offset);
  if (!r.ok) { showToast("error", r.reason); return; }
  if (kind === "main") {
    const clips = (state.mainClips || []).slice();
    clips.splice(hit.index, 1, r.left, r.right);
    writeEs({ mainClips: clips });
  } else {
    // 音频身份 = id 制（resolveTrackClip）：右半后处理覆写独立 aud- id（splitClipAt 只改 segId·零 core
    //   改动·两轨身份制各自成对）；segId 沿用 split- 覆写——主轨必无同段 = 天然非锚定（脱锚分工）。
    //   左半清 segId（splitAV 锚定半分割即脱锚·转自身轴窗）；split- 前缀是轴语义标记（axisTrimlOf=0），
    //   清了轴边距会跳到分割点秒 → 保留（与修剪写库清 segId 同规则）。
    let left = r.left;
    if (left.segId && !String(left.segId).startsWith("split-")) left = { ...left, segId: undefined };
    const right = { ...r.right, id: newCopyId("aud-") };
    const clips = (state.audioClips || []).slice();
    clips.splice(hit.index, 1, left, right);
    writeEs({ audioClips: clips });
  }
  showToast("success", t("edit.split.done", { a: fmtDur(r.left.dur), b: fmtDur(r.right.dur) }));
}

// ===== 文档级委托 (v43 形态) =====
function editTabActive() {
  return !!(S && S.root && S.root.offsetParent !== null);
}
function selAll() {
  return S && S.root ? [...S.root.querySelectorAll(".clip.sel, .clip-audio.sel")] : [];
}
function selClear() {
  selAll().forEach((el) => el.classList.remove("sel"));
}

let _delegatesBound = false;
let _trim = null;
let _dragEl = null;
let _dragAlt = false;
// S3-3 T9b 拖拽态扩展: 源轨 + 源片段身份（跨轨移动要按源轨移除; 目标轨由 drop 事件给）
//   身份口径同 F2/resolveTrackClip —— 正片/备选 = segId; 音频 = id 优先（旧档无 id 兜底 label）
let _dragIdent = null;
// 快批⑧ 落点/吸附参考口径: 指针在拖动片段内的水平偏移（dragstart 记录·整组以组首片段左缘为准）
//   —— dragover/drop 用 clientX − 本偏移 还原「片段左缘参考位」再算吸附与插入序
let _pointerOffX = 0;

function bindDocumentDelegates() {
  if (_delegatesBound) return;
  _delegatesBound = true;

  // ---- 多选 (v42 件2·D008): 文档级委托点击 ----
  document.addEventListener("click", (e) => {
    if (!S || !S.root || !S.root.contains(e.target)) return;
    // F23: 关键帧 ◆ 标记点击 = 删除该时间点全部关键帧条目（先于选中逻辑·不打选中）
    const kd = e.target.closest ? e.target.closest(".kf-dot") : null;
    if (kd && S.root.contains(kd)) {
      const clipEl = kd.closest(".clip");
      const t = +kd.dataset.kft;
      if (clipEl && Number.isFinite(t)) {
        const { clip } = resolveTrackClip(clipEl);
        if (clip) {
          writeClipL2(clipEl, { keyframes: kfReadOf(clip).filter((k) => k.t !== t) });
          showToast("info", `已删除 ${fmtDur(t)}s 的关键帧`);
        }
      }
      return;
    }
    // S3-3 T7: 交界转场标记（hover 出的「+转场」/ 已设的「⇄类型」）→ 转场弹窗（不参与多选）
    const tb = e.target.closest ? e.target.closest(".trans-btn") : null;
    if (tb && S.root.contains(tb)) { openTransitionDialog(tb); return; }
    // 批 B T4: 候选徽章「✓ 通过 / ✕ 不通过」接活 —— 走 decideCandidateByClip 域级通道
    //   （与多候选弹窗行内钮同一落账 → 两入口状态一致）；先于下方选中逻辑
    const bd = e.target.closest ? e.target.closest(".cok, .cno") : null;
    if (bd && S.root.contains(bd)) {
      const cdEl = bd.closest(".clip");
      const cdo = cdEl ? resolveTrackClip(cdEl).clip : null;
      if (cdo) void decideCandidateByClip(cdo, bd.classList.contains("cok") ? "accept" : "discard");
      return;
    }
    const c = e.target.closest(".clip, .clip-audio");
    if (c && S.root.contains(c)) {
      if (e.ctrlKey || e.metaKey) c.classList.toggle("sel");
      else { selClear(); c.classList.add("sel"); }
      return;
    }
    // 批 G-a G-T3（F-5）：.pmenu 入白名单——菜单项点击不误清选中（菜单挂在 body·先于下方 selClear 的
    //   S.root.contains 早退多半拦得住，本行为冗余防御：防日后菜单挂进剪辑区根内时退化）
    if (e.target.closest(".mbtn,.zbtn,#zoomRange,input,select,textarea,.hnd,.ph-head,.playhead,.cok,.cno,.pmenu")) return;
    // 批 I-P2 T10（F-10）：框选拖动收尾的合成 click 一次性抑制——不清选（否则刚框中的多段
    //   立即被下方 selClear 抹掉）；普通空白 click 仍清选（现行为保持）。
    if (_marqueeDrag) { _marqueeDrag = false; return; }
    selClear();
  });

  // ---- 修剪手柄 (v43 :4178-4218·域函数 applyTrimClip) ----
  document.addEventListener("mousedown", (e) => {
    if (!S || !S.root) return;
    const h = e.target.closest(".hnd");
    if (!h || !S.root.contains(h)) return;
    const el = h.parentElement;
    // S3-2 T1 锁定守卫: 修剪入口拦截（解除即恢复）
    if (elTrackLocked(el)) { showToast("info", t("edit.common.trackLocked")); e.preventDefault(); return; }
    _trim = {
      el,
      side: h.classList.contains("L") ? "L" : "R",
      startX: e.clientX,
      startW: el.getBoundingClientRect().width,
    };
    document.body.classList.add("noselect");
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener("mousemove", (e) => {
    if (!_trim || !S) return;
    // 批F F-T3 (F-11): 查表改 resolveTrackClip（三轨通用·音频按 id 身份）——治同 segId 双半
    //   陷阱：splitAV 音频半带 segId，旧 mainClips findIndex(segId) 硬编码查不到音频条。
    const rc = resolveTrackClip(_trim.el);
    if (!rc.clip) return;
    const dx = e.clientX - _trim.startX;
    const r = applyTrimClip(rc.clip, _trim.side, dx, S.pxs);
    // 拖拽中仅原位预览样式, mouseup 才写 store (v43 行为); F4: 预览宽度/文字 = 有效时长
    _trim.el.style.width = (effDurOf(r.clip) * S.pxs) + "px";
    // 批 C C-F1（P-3）: 预览边距走轴域 — raw triml 是源域（split- 段=分割点）·当轴边距用会瞬态右推
    // 批1-T7（F-111）: 音频条（.axpos 轴窗绝对定位类）改写 left —— margin-left 对绝对定位元素是
    //   left 之上的叠加偏移·继续写它会让拖左柄预览往右飘；主轨片段仍流内·照旧写 marginLeft。
    //   锚定条（.anchored）几何随父段·预览期不位移·故按类分派而非按轨分派。
    if (_trim.side === "L") {
      if (_trim.el.classList.contains("axpos")) {
        _trim.el.style.left = (axStartAt(rc.list, rc.index, r.clip) * S.pxs) + "px";
      } else {
        _trim.el.style.marginLeft = (axisTrimlOf(r.clip) * S.pxs) + "px";
      }
    }
    const durEl = _trim.el.querySelector(".dur");
    if (durEl) durEl.textContent = fmtDur(effDurOf(r.clip)) + "s";
    _trim._pending = r;
  }, true);
  document.addEventListener("mouseup", () => {
    document.body.classList.remove("noselect");
    if (!_trim || !S) { _trim = null; return; }
    const r = _trim._pending;
    if (r) {
      const state = es();
      const rc = resolveTrackClip(_trim.el);
      if (rc.index >= 0) {
        const key = rc.kind === "main" ? "mainClips" : isAltKind(rc.kind) ? "altClips" : "audioClips";
        const clips = (state[key] || []).slice();
        // 批F F-T3: 音频修剪写库——带 segId 条目清 segId（脱锚机制信号：splitAV 半一经修剪即
        //   转自身轴窗·方案 §三裁决 2）；split- 前缀是分割身份+轴语义标记（axisTrimlOf=0），
        //   清除会让轴边距跳到分割点秒 → 保留（与 doSplit 音频左半清 segId 同规则）。
        clips[rc.index] = rc.kind === "audio" && r.clip.segId && !String(r.clip.segId).startsWith("split-")
          ? { ...r.clip, segId: undefined }
          : r.clip;
        writeEs({ [key]: clips });
        // v39 按侧报告 (D007)
        if (r.lcut > 0.05 && r.rcut > 0.05) showToast("info", t("edit.trim.both", { a: r.lcut.toFixed(1), b: r.rcut.toFixed(1) }));
        else if (r.lcut > 0.05) showToast("info", t("edit.trim.left", { a: r.lcut.toFixed(1) }));
        else if (r.rcut > 0.05) showToast("info", t("edit.trim.right", { b: r.rcut.toFixed(1) }));
      }
    }
    _trim = null;
  }, true);

  // ---- 拖拽 (v43 :4006-4071·整组+磁吸) ----
  document.addEventListener("dragstart", (e) => {
    if (!S || !S.root) return;
    if (e.target.closest && e.target.closest(".hnd")) { e.preventDefault(); return; }
    const c = e.target.closest(".clip, .clip-audio");
    if (!c || !S.root.contains(c)) return;
    // S3-2 T1 锁定守卫: 拖拽起手拦截
    if (elTrackLocked(c)) { e.preventDefault(); showToast("info", t("edit.common.trackLocked")); return; }
    // 批 G-a G-T4（F-10 拖未选中先选中）：起手段未选中 → 先 selClear 再选中它。
    //   次序铁律「先清后加」：只加不清 = 组拖全组陷阱（{A,C} 选中拖 B → 选中集含全组）。
    //   Alt 起手是复制语义（_dragAlt·只复制所拖对象）·不进此逻辑。
    if (!e.altKey && !c.classList.contains("sel")) { selClear(); c.classList.add("sel"); }
    _dragEl = c;
    // S3-2 T2: 起手按住 Alt = 复制语义（副本落点·原片段留原位；Alt 优先于整组拖动）
    _dragAlt = !!e.altKey;
    _dragIdent = clipIdentity(c); // S3-3 T9b: 源轨 + 源片段身份（drop 分派用; 落点文档结构可能已重建）
    // 快批⑧: 记录指针在拖动片段（整组 = 组首片段）内的水平偏移 —— 落点参考 = 片段左缘
    //   无坐标的合成 dragstart（键盘/自动化）→ 偏移 0（退化为左缘口径）
    const cx = Number(e.clientX);
    _pointerOffX = Number.isFinite(cx) ? cx - dragGroupEls()[0].getBoundingClientRect().left : 0;
    c.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", "clip"); } catch (_err) { /* IE 兼容占位 */ }
  });
  document.addEventListener("dragend", () => {
    if (_dragEl) { _dragEl.classList.remove("dragging"); _dragEl = null; }
    _dragAlt = false;
    _dragIdent = null;
    _pointerOffX = 0;
    if (S && S.root) S.root.querySelectorAll(".tl-track").forEach((t) => t.classList.remove("drop-hint"));
    hideSnapLines();
  });

  // ---- 右键菜单 (v43 :3845-3862): 删除/复制/插入/改参数重跑 ----
  //   S2-2 T2+T11: 增「超分（单段）」「插帧（单段）」两项 — 段级后处理通道
  //   复用 openPostfxDialog(taskId, {presetKinds, presetEngine, presetSids})
  //   段级 srMode 直译 quick→rtxvsr / seedvr→seedvr2 (S1-4 锁定)
  let ctxTarget = null;
  let ctxMenu = null;
  // 段级右键入口: 查找 clip + seg + sid; 缺 sid (新建/粘贴) 或未载入历史→toast 兜底
  function openSegPostfxDialog(ctxEl, kindAction) {
    const st = es();
    const taskId = loadedTaskIdOrFix(st);
    if (!taskId) { showToast("info", t("edit.postfx.needHistory")); return; }
    const segId = ctxEl && ctxEl.dataset.segId;
    const clip = (st.mainClips || []).find((c) => c.segId === segId) || null;
    const sid = resolveEngineSid(clip);
    if (!sid) { showToast("info", t("edit.postfx.noSid", { name: clip ? clip.label : segId || "?" })); return; }
    const proj = S.projectId ? storeLoad(S.projectId) : null;
    openPostfxDialog(taskId, {
      presetKinds: resolveKindPreset(kindAction),
      presetEngine: postfxGlobalEngine(proj),   // T4 #31：全局引擎键预选（段卡 超分模式 休眠退役）
      presetSids: [sid],
    });
  }
  // ---- B4-T2 D2：右键重跑两入口（「重新生成」=老板钦点 /「同种子重跑」=二段式接真）----
  //   入口守卫（B2 统一口径）：无 loadedTaskId → 先载入历史任务；
  //   clip 无 sid（syncRunProducts 补轨 clip 无键）→ 白话该片段无引擎段号
  function rerunEntryGuard(ctxEl) {
    const st = es();
    if (!st.loadedTaskId) { showToast("info", t("edit.rerun.needHistory")); return null; }
    const segId = ctxEl && ctxEl.dataset.segId;
    const clip = (st.mainClips || []).find((c) => c && c.segId === segId) || null;
    const sid = resolveEngineSid(clip);
    if (!sid) { showToast("info", t("edit.rerun.noSid")); return null; }
    // 过期校验放 sid 守卫之后（同 preview.js _fsEngSid 口径）：无 sid 本就发不出操作·先给可行动的那条
    return { taskId: loadedTaskIdOrFix(st), sid };
  }
  function rerunOneClip(ctxEl) {
    const g = rerunEntryGuard(ctxEl);
    if (!g) return;
    void runRerunFlow({ projectId: S.projectId, taskId: g.taskId, sids: [g.sid], keepSeed: false, label: "重新生成", kind: "rerun" })
      .then((r) => { _rerunPoll = (r && r.poll) || null; });
  }
  function sameSeedRerunAll() {
    const st = es();
    if (!st.loadedTaskId) { showToast("info", t("edit.rerun.needHistory")); return; }
    const taskId = loadedTaskIdOrFix(st);
    void (async () => {
      // 首调（不带 force）：引擎不覆写参数必中 confirm_required（api #6·引擎行为基线）
      const first = await sameSeed({ taskId, source: "task" });
      if (!first.ok) {
        showToast("error", t("edit.rerun.fail", { msg: (first.error && first.error.msg) || (first.error && first.error.code) || t("edit.common.unknownErr") }));
        return;
      }
      // 确认 → force:true 重发 → started 后走 runRerunFlow（kind:"rerun"·label 同种子重跑）
      //   submit 注入：引擎已 started 的链路不得再 POST rerun（二次必 409 active_busy）
      const flow = (submit) => runRerunFlow({
        projectId: S.projectId, taskId, sids: [], label: "同种子重跑", kind: "rerun", submit,
      }).then((r) => { _rerunPoll = (r && r.poll) || null; return r; });
      if (!first.confirmRequired && first.started) {
        // 引擎直启（基线外防御）：复用本次结果·不再 POST
        void flow(() => Promise.resolve(first));
        return;
      }
      const body = document.createElement("div");
      body.style.cssText = "font-size:12px;color:var(--txt2)";
      body.textContent = t("edit.rerun.confirmBody");
      openMbox(t("edit.rerun.confirmTitle"), t("edit.rerun.confirmAsk"), body, [
        [t("edit.common.cancel"), null],
        [t("edit.rerun.confirmGo"), () => { void flow(() => sameSeed({ taskId, source: "task", force: true })); }, "prim"],
      ]);
    })();
  }
  // F70（批 10-J-T3）：重跑类三项收进「重跑…」二级入口（老板「散在长菜单里难找」）
  //   二级复用同一 pmenu 单例（点开替换内容 + 贴锚项右缘）——不另造嵌套浮层
  //   ESC / 外点 / 选中即关三条与一级同语义（共用 hideCtx）
  const RERUN_SUB_ITEMS = () => [
    // 重新生成=老板钦点（B4-T2·rerunSelected 单段换新种子）
    [t("edit.menu.regen"), () => rerunOneClip(ctxTarget)],
    // B4-T2 接真：同种子重跑=二段式（首调 confirm→确认弹窗→force:true 重发）
    //   v43 挂点为片段级但引擎仅任务级映射——title 注（全部段）防回溯争议
    [t("edit.menu.sameSeed"), () => sameSeedRerunAll(), false, t("edit.menu.sameSeedTip")],
    [t("edit.menu.paramsRerun"), () => openRerunModal(ctxTarget)],
  ];
  // 渲染 items 到 pmenu 单例（一级/二级共用）；keepOpen 项点开不关菜单（stopPropagation 挡 document 外点）
  function renderCtxItems(items, footText) {
    ctxMenu.innerHTML = "";
    items.forEach(([txt, fn, off, tip, keepOpen]) => {
      const it = document.createElement("div");
      it.textContent = txt;
      // B4-T2：非占位项可带 tip（同种子重跑 title 注全部段）
      if (tip) it.title = tip;
      // S3-3 T4: 不可用项置灰（.off + opacity）—— 点击仍走入口守卫, toast 说明原因
      it.style.cssText = "padding:6px 10px;border-radius:8px;cursor:pointer;color:var(--txt2)" + (off ? ";opacity:.45" : "");
      if (off) it.classList.add("off");
      if (!off) {
        it.addEventListener("mouseenter", () => { it.style.background = "var(--panel2)"; it.style.color = "var(--txt)"; });
        it.addEventListener("mouseleave", () => { it.style.background = ""; it.style.color = ""; });
      }
      if (keepOpen) it.addEventListener("click", (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(it); });
      else it.addEventListener("click", () => { hideCtx(); fn(); });
      ctxMenu.appendChild(it);
    });
    const small = document.createElement("div");
    small.textContent = footText;
    small.style.cssText = "padding:4px 10px;color:var(--txt3);font-size:11px";
    ctxMenu.appendChild(small);
    ctxMenu.style.display = "block";
  }
  document.addEventListener("contextmenu", (e) => {
    if (!S || !S.root) return;
    const c = e.target.closest ? e.target.closest(".clip, .clip-audio") : null;
    const hitClip = c && S.root.contains(c) ? c : null;
    // 批 G-a G-T3（F-5）空白处新分支：#tlScroll 内且非片段/非轨头（.tl-lab 排按钮·排除）。
    const scrollEl = (!hitClip && e.target.closest) ? e.target.closest("#tlScroll") : null;
    const onBlank = !!(scrollEl && S.root.contains(scrollEl) && !(e.target.closest && e.target.closest(".tl-lab")));
    if (!hitClip && !onBlank) return;
    e.preventDefault();
    ctxTarget = hitClip;
    // B5-T1③b（批 4 遗留·测试基建）：清树后单例菜单成孤儿（parentNode=null）须重挂——
    //   原判据只认 !ctxMenu，孤儿后不再 append → 右键链路断（真机清树路径同受益）
    if (!ctxMenu || !ctxMenu.parentNode) {
      ctxMenu = document.createElement("div");
      ctxMenu.className = "pmenu";
      ctxMenu.style.cssText = "position:fixed;display:none;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;z-index:120;min-width:190px;box-shadow:0 8px 24px #000a;font-size:12px";
      document.body.appendChild(ctxMenu);
    }
    // 批 G-a G-T3（F-5）空白处两项：粘贴/分割落游标（文案明示·防右键 B 却分 A）
    const blankItems = [
      [t("edit.menu.pasteAtCursor"), () => pasteClips(), !_pasteboard.length],
      [t("edit.menu.splitAtCursor"), () => doSplit(), !splitHitOf(es())],
    ];
    const items = onBlank
      ? blankItems
      : [
        // F70：重跑三项收进二级（置首·原「重新生成」位——老板钦点打破「属性置首防误点」惯例）
        //   keepOpen：点开只换内容不关菜单（stopPropagation 挡 document 外点关闭）
        [t("edit.menu.rerunRoot"), (anchorEl) => openRerunSub(anchorEl), false, t("edit.menu.rerunRootTip"), true],
        // B5-T5② 弹窗播放（H8）：浮层原生 controls 播放该片段产物（无产物 → 守卫 toast）
        [t("edit.menu.play"), () => previewClip(ctxTarget)],
        // 批 L1 T2 R-27：开该片段视频所在目录（无产物 → 置灰 + 入口守卫早退）
        [t("edit.menu.openDir"), () => openClipDir(ctxTarget), !clipFileOf(ctxTarget), t("edit.clip.noOutputYet")],
        // 属性置首（只读·无副作用）—— 误点也不会落到下方「删除」上
        [t("edit.menu.props"), () => openClipProps(ctxTarget)],
        // S3-3 T2 变速入口（滑杆弹窗·确认才写 clip.speed）
        [t("edit.menu.speed"), () => openSpeedDialog(ctxTarget)],
        // #81 D4b（P6·多版对比补右键入口——工具条 :555 版随 D2 退场后右键为主入口）
        [t("edit.menu.compare"), () => openCompareModal(ctxTarget)],
        // 批 G-a G-T3（F-5）分割入口：按游标口径（doSplit 同源）——游标不在本片段上则置灰防误分
        [t("edit.menu.split"), () => doSplit(), !splitHitsClip(ctxTarget), t("edit.menu.splitTip")],
        // S3-3 T4 分离音视频（正片轨才可用；已拆片段置灰防重复）
        [t("edit.menu.splitAV"), () => splitAudioFromClip(ctxTarget), !canSplitAVOf(ctxTarget)],
        [t("edit.common.delete"), () => deleteClips([ctxTarget])],
        [t("edit.menu.copy"), () => copySel([ctxTarget])],
        [t("edit.menu.insert"), () => insertAfter(ctxTarget)],
        // S3-4 B6（空-015）：按 seed 收藏该段（生成条件 seed+提示词）——列表内一键变体重跑
        [t("edit.menu.favSeed"), () => favoriteClip(ctxTarget)],
        // B7-T3 E2 接真（批 0-T4 占位退役）：多候选渲染 = count 弹层 → #58 → #60 轮询 → 备选轨 → #59 采纳/废弃
        [t("edit.menu.cand"), () => openCandidatesDialog(ctxTarget)],
        [t("edit.menu.upscale"), () => openSegPostfxDialog(ctxTarget, "upscale")],
        [t("edit.menu.interp"), () => openSegPostfxDialog(ctxTarget, "interp")],
      ];
    ctxMenu.innerHTML = "";
    renderCtxItems(
      items,
      onBlank ? t("edit.menu.footBlank")
        : t("edit.menu.footPaste"),
    );
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
    ctxMenu.style.top = clampMenuTop(e.clientY) + "px";
  });
  // F105（批 G-b T2）：底部钳制按渲染后实测高度（getBoundingClientRect().height）——
  //   旧 innerHeight-160 写死估计：长菜单贴底仍被吞下半；实测 height 才是真实占位。
  //   坐标系候选②排除声明：pmenu position:fixed 直挂 body → clientY 与 rect 同视口系
  //   自洽，无需换算（一级/二级共用本钳制·renderCtxItems 已置 display:block 再量）。
  // 战役批1-T2（F105 残留）：补下界——菜单实高 > 视口高时上限 innerHeight-h-8 为负，
  //   top 落负坐标顶边出屏（贴底右键长菜单/嵌套二级高发）；Math.max(0,·) 兜底贴顶
  //   （对齐 preview.js clampMenuPos 双边界口径·pad 同为 8）。
  function clampMenuTop(clientY) {
    const h = (ctxMenu && ctxMenu.getBoundingClientRect ? ctxMenu.getBoundingClientRect().height : 0) || 0;
    return Math.max(0, Math.min(clientY, window.innerHeight - h - 8));
  }
  // F70：二级「重跑…」——同 pmenu 单例换内容 + 贴锚项右缘（无 hover 交互·点开即换）
  function openRerunSub(anchorEl) {
    if (!ctxMenu) return;
    // 修正笔（审核打回）：rect 须在 renderCtxItems 之前取——其首行 innerHTML="" 会把锚点项摘离 DOM，
    //   真机脱离节点 getBoundingClientRect 恒返全零 → left 退成 2 / top 退成 0，二级菜单跳视口左上角
    const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    renderCtxItems(RERUN_SUB_ITEMS(), t("edit.menu.rerunSubFoot"));
    const left = r ? Math.min(r.right + 2, window.innerWidth - 220) : 40;
    const top = r ? clampMenuTop(r.top) : 40;
    ctxMenu.style.left = left + "px";
    ctxMenu.style.top = top + "px";
  }
  function hideCtx() { if (ctxMenu) ctxMenu.style.display = "none"; }
  document.addEventListener("click", hideCtx);

  // ---- 热键套 (v42 件4·D014/D015: 输入保护 + 非剪辑 TAB 不响应) ----
  document.addEventListener("keydown", (e) => {
    if (!S || !editTabActive()) return;
    const t = e.target || {};
    // 登记项 6：range 滑杆无打字语义——不算输入保护对象（Ctrl+Z 在滑杆上仍可用）；
    // 单键（方向键/空格/Delete）保持滑杆原生行为（下方 inRange 守门）
    const inRange = t.tagName === "INPUT" && String(t.type || (t.getAttribute && t.getAttribute("type")) || "") === "range";
    const typing = (t.tagName === "INPUT" && !inRange) || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
    if (typing) return; // 输入保护
    const k = (e.key || "").toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === "a") {
        e.preventDefault();
        selClear();
        // S3-2 T1 (任务6.5): 隐藏轨的片段不计入全选集合；其余集合沿用既有口径（D009）
        S.root.querySelectorAll(".clip, .clip-audio").forEach((el) => {
          if (elTrackHidden(el)) return;
          el.classList.add("sel");
        });
      } else if (k === "c") { e.preventDefault(); copySel(); }
      // 批 G-a G-T3（F-5）剪切：Ctrl+X（守卫同 Ctrl+C·typing/inRange 已在套首统一守门）
      else if (k === "x") { e.preventDefault(); cutSel(); }
      else if (k === "v") { e.preventDefault(); pasteClips(); }
      else if (k === "b") { e.preventDefault(); doSplit(); } // S3-2 T3: 游标处分割（复用既有分割链）
      // S3-4 B4（空-017）：撤销/重做接真（栈端零操作; 输入保护 D015 由上方 typing 守门）
      else if (k === "z" && !e.shiftKey) { e.preventDefault(); histStep(-1); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); histStep(1); }
      return;
    }
    if (inRange) return; // 登记项 6：滑杆聚焦时单键走原生（←→ 调值），只放行上方 Ctrl 组合键
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      const sel = selAll();
      if (sel.length) { e.preventDefault(); deleteClips(sel); }
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); nudgePlayhead(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nudgePlayhead(1); }
    // S3-2 T4: Home/End 跳位 —— End 落正片末段本体末端（D025 同源·非轴长末端）
    // 批 A T2：Home/End 走 seekTo（跨段换源 + 清落点段位置记忆·不再裸改 phTime）
    else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
    else if (e.key === "End") { e.preventDefault(); seekTo(mainBodyEndSec(es().mainClips)); }
    // 批 G-a G-T2（F-9）：Esc 三重守卫——①右键菜单开 → 只关菜单（不清选中·return）
    //   ②弹层开（mbox / 成片预览 overlay）→ 不清选中（Esc 归弹层）③否则清空选中。
    else if (e.key === "Escape") {
      if (ctxMenu && ctxMenu.style.display === "block") { hideCtx(); return; }
      if (document.querySelector(".mbox-wrap,[data-h3-role=final-preview-overlay]")) return;
      selClear();
    }
  });
  // F70：ESC 关菜单（与 preview.js 段菜单同口径——一级二级共用 hideCtx）
  // 批 G-a G-T2：注册搬至热键套之后——热键套先执行（守卫①见菜单可见即关并 return），
  //   本条后执行幂等收尾不再动作（单动作达成）；非剪辑 TAB 热键套早退时仍由本条关菜单。
  document.addEventListener("keydown", (e) => { if (e && e.key === "Escape") hideCtx(); });
}

// ---- 热键辅助 ----
// 批C C-T2（②A5）：End 落主轨末段本体末端（末段 acc+effDur−0.01·clipBodyStart 同口径）。
//   旧口径 filmEndSec 含音频轨且上取整——音频更长时落点在主轨之外死区（命中 null），
//   任一编辑触发 renderAll 就摧毁双缓冲 = 黑屏。裁定：「跳到片尾」以正片为准，
//   音频尾仍可拖拽/方向键到达；主轨空（只有音频）→ 维持 filmEndSec 原值。
function mainBodyEndSec(mainClips) {
  const arr = Array.isArray(mainClips) ? mainClips : [];
  if (!arr.length) return filmEndSec(es().mainClips, es().audioClips);
  const last = arr.length - 1;
  return clipBodyStart(arr, last) + effDurOf(arr[last]) - 0.01;
}
let _pasteboard = [];
function nudgePlayhead(frames) {
  if (!S) return;
  const end = filmEndSec(es().mainClips, es().audioClips);
  // 批 A T2：逐帧步进也走 seekTo（跨段换源 + 清落点位置记忆·与拖拽/Home/End/标记同款）
  seekTo(stepPlayhead(S.phTime, frames, end));
}

// floating 段前缀（与 store.js FLOATING_SEG_PREFIX 同口径——store 未导出·本地同正则·勿单边改）
//   split- = 分割右半（批 C C-T1）：删右半是真删·不记墓碑（不牵连整段）。
const FLOATING_SEG_PREFIX = /^(paste-|new-|split-)/;

// ---- 删除 (v42 件4·toast 已删除 N 个片段) ----
function deleteClips(els) {
  if (!els || !els.length) return;
  // S3-2 T4 锁定守卫: 锁定轨片段禁删（与 T1 拖/修、T3 分割同口径; 守卫挂在删除唯一入口——
  //   键盘 Delete 与右键「删除」两路同源, 任一选中项落在锁定轨即整批拒）
  if (els.some((el) => elTrackLocked(el))) { showToast("info", t("edit.common.trackLocked")); return; }
  const state = es();
  // 批 B T1 ④ 分轨分流: alt 元素按 cid 删 altClips, 不进 mainIds ——
  //   旧口径 mainIds 只看 dataset.segId, alt 候选元素也带 segId → 删候选连带删主轨同段（N1 误删主轨）
  //   批5-R53-TC: 备选轨 = 动态多轨 → 轨 kind 判据 isAltKind（alt-<N>）
  const altCids = els.filter((el) => isAltKind(elTrackKind(el))).map((el) => ensureAltCid(el)).filter(Boolean);
  const mainIds = els.filter((el) => !isAltKind(elTrackKind(el)) && el.dataset.segId).map((el) => el.dataset.segId);
  // F2：音频删除按 id 身份优先（同 label 副本不再整组误删）；旧档无 id 兜底 label
  const audioIds = els.filter((el) => el.classList.contains("clip-audio") && el.dataset.audioId).map((el) => el.dataset.audioId);
  const audioLabels = els.filter((el) => el.classList.contains("clip-audio") && !el.dataset.audioId).map((el) => el.textContent.trim());
  const patch = {};
  if (mainIds.length) {
    patch.mainClips = (state.mainClips || []).filter((c) => !mainIds.includes(c.segId));
    // 批 D D-T2 删除写墓碑（R-21 甲·方案 §四.5 口径）: 删主轨「有产物」片段（c.file 真值）且 segId 非
    //   floating 前缀 → 并入 deletedSegIds（与 mainClips 过滤同一 patch 一笔写 = 一步撤销）。
    //   floating 前缀一律不记（Alt 复制副本 spread 带 file 但 segId 永不进 segments·删即真删）；
    //   空片段不记（R-21 ②「删空片段=删行」收口前维持现状：空壳重挂载补回）。
    const marks = (state.mainClips || [])
      .filter((c) => mainIds.includes(c.segId) && c.file && !FLOATING_SEG_PREFIX.test(String(c.segId || "")))
      .map((c) => c.segId);
    if (marks.length) {
      // 批 C C-T3：存量「同 segId 双半」（批 C 前分割产物）整组删除时 marks 可重复 → Set 去重
      //   （重复墓碑 = 同键在快照/撤销链里反复读写）。
      patch.deletedSegIds = [...new Set([...(Array.isArray(state.deletedSegIds) ? state.deletedSegIds : []), ...marks])];
    }
  }
  if (altCids.length) patch.altClips = (es().altClips || []).filter((c) => !altCids.includes(c.cid)); // 懒生成已改写列表 → 重读
  if (audioIds.length || audioLabels.length) {
    patch.audioClips = (state.audioClips || []).filter((c) => !audioIds.includes(c.id) && !audioLabels.includes(c.label));
    // 批1-T7b（F-111）删除=恢复通道：删掉分离音频条 → 同批清父段 splitAV（-an 静音解除·🔇 角标消失·
    //   预览恢复有声）。不补则音频已不在轨而视频段仍静音 = 声音凭空丢失（老板定版行为锁的缺失通道）。
    //   口径：判据 = 被删条自身 segId（音频元素不落 dataset.segId·身份取自 store 条·与上行 audioIds
    //   同款身份口径）。带 segId = 锚定半 → 恢复父段；segId 已清（修剪/分割左半脱锚）、独立条、
    //   BGM 条 → 无归属·不动父段（保守·不猜）。同批多删逐条命中（Set 去重）。
    const cutSegIds = new Set(
      (state.audioClips || [])
        .filter((c) => audioIds.includes(c.id) || audioLabels.includes(c.label))
        .map((c) => (c.segId ? String(c.segId) : ""))
        .filter(Boolean)
    );
    if (cutSegIds.size) {
      // 基线取已算好的 patch.mainClips（主段同批被删时以其为准·否则清 splitAV 会把已删段复活）
      const base = patch.mainClips || state.mainClips || [];
      const mains = base.map((c) => (cutSegIds.has(String(c.segId || "")) && clipSplitAVOf(c) ? { ...c, splitAV: false } : c));
      if (mains.some((c, i) => c !== base[i])) patch.mainClips = mains; // 无实际变化不写键（不空耗撤销单元）
    }
  }
  writeEs(patch);
  selClear();
  showToast("info", t("edit.clip.deleted", { n: els.length }));
}

// ---- 复制/粘贴 (v42 件3·D010/D011) ----
// 剪贴板规格（DOM 同步读取口径·copy 与 cut 共用同一条组装线）
function clipSpecOf(el) {
  const isAudio = el.classList.contains("clip-audio");
  // 批 F F-T1: 音频条顺带 file（从 store 解析源——粘贴不丢源）
  const audSrc = isAudio ? resolveTrackClip(el).clip : null;
  return {
    audio: isAudio,
    audioId: isAudio ? (el.dataset.audioId || null) : null,
    dur: +el.dataset.dur || (+el.textContent.replace(/[^\d.]/g, "") || 4),
    label: isAudio ? el.textContent.trim() : `段${el.dataset.n} 副本`,
    srcN: el.dataset.n || "",
    ...(audSrc && audSrc.file ? { file: audSrc.file } : {}),
  };
}
function copySel(elsOverride) {
  const sel = elsOverride && elsOverride.length ? elsOverride : selAll();
  if (!sel.length) { showToast("info", t("edit.clip.selRequired")); return; }
  _pasteboard = sel.map(clipSpecOf);
  showToast("info", t("edit.clip.copied", { n: _pasteboard.length }));
}
// 批 G-a G-T3（F-5）剪切 = 复制（带产物规格）+ 删除：主轨规格补 file/state/ver —— 粘回即真视频段
//   （copy 语义不动·空壳副本维持现状）。先复制后删·删除只一笔 writeEs = 一步撤销；
//   撤销后剪贴板规格仍在，仍可再粘贴。
function cutSel(elsOverride) {
  const sel = elsOverride && elsOverride.length ? elsOverride : selAll();
  if (!sel.length) { showToast("info", t("edit.clip.selRequired")); return; }
  _pasteboard = sel.map((el) => {
    const spec = clipSpecOf(el);
    if (spec.audio) return spec; // 音频 file 已由 clipSpecOf 带上
    const c = resolveTrackClip(el).clip;
    if (!c) return spec;
    return {
      ...spec,
      ...(c.file ? { file: c.file } : {}),
      ...(c.state ? { state: c.state } : {}),
      ...(c.ver ? { ver: c.ver } : {}),
    };
  });
  deleteClips(sel);
}
function pasteClips() {
  if (!_pasteboard.length) { showToast("info", t("edit.clip.pasteEmpty")); return; }
  const state = es();
  const hit = clipAtPlayhead(state.mainClips || [], S.phTime); // 粘贴到游标处
  const newMain = [];
  const newAudio = [];
  _pasteboard.forEach((spec) => {
    if (spec.audio) {
      newAudio.push({ id: "aud-" + Math.random().toString(36).slice(2, 10), label: spec.label, dur: spec.dur, triml: 0, ...(spec.file ? { file: spec.file } : {}) }); // F-T1: file 随剪贴板规格随行
    } else {
      // 批 G-a G-T3（F-5·消费端闭环）：剪切规格带 file/state/ver 一并透传——否则粘回是空壳段
      //   （copy 规格无 file/state → 仍回落「副本/empty」现状）
      newMain.push({
        segId: "paste-" + Math.random().toString(36).slice(2, 10),
        label: spec.label, dur: spec.dur, triml: 0, full: spec.dur,
        ver: spec.ver || "副本", state: spec.state || "empty",
        ...(spec.file ? { file: spec.file } : {}),
      });
    }
  });
  const patch = {};
  if (newMain.length) {
    const clips = (state.mainClips || []).slice();
    const at = hit ? hit.index + 1 : clips.length;
    // 段号铁律（批 D D-T2）: 新段 n=max(存量 n)+1·一次插多条逐条递增·label 空则「段{n}」非空保留
    let n = nextClipN(clips);
    for (const c of newMain) { c.n = n++; if (!c.label) c.label = `段${c.n}`; }
    clips.splice(at, 0, ...newMain);
    patch.mainClips = clips;
  }
  if (newAudio.length) patch.audioClips = [...(state.audioClips || []), ...newAudio];
  writeEs(patch);
  showToast("info", t("edit.clip.pasted", { n: _pasteboard.length }));
}

// 段号铁律（批 D D-T2·段号永不自动重排）: 新段 n = max(存量 n)+1·label 空则「段{n}」·非空保留；
//   存量片段 n/label 一律不碰（删段3 后显示 1,2,4 不重排）。供粘贴/插占位/Alt 复制/跨轨四路复用。
function nextClipN(clips) {
  let maxN = 0;
  for (const c of clips) {
    if (typeof c.n === "number" && Number.isFinite(c.n) && c.n > maxN) maxN = c.n;
  }
  return maxN + 1;
}

// ---- 右键插入 (v43 ctxIns) ----
function insertAfter(ctxTarget) {
  const state = es();
  const segId = ctxTarget && ctxTarget.dataset.segId;
  const clips = (state.mainClips || []).slice();
  const idx = clips.findIndex((c) => c.segId === segId);
  const newClip = {
    segId: "new-" + Math.random().toString(36).slice(2, 10),
    n: nextClipN(clips), label: "新段·待生成", dur: 4, triml: 0, full: 4, ver: "（新）", state: "empty",
  };
  if (idx >= 0) clips.splice(idx + 1, 0, newClip); else clips.push(newClip);
  writeEs({ mainClips: clips });
  showToast("info", t("edit.clip.inserted"));
}

// B5-T5② 片段弹窗播放（H8）：复用 showFinalPreview 浮层（单 clip 参数化·原生 controls+ESC 全齐·零改造）
//   批 B T2 提为域级函数 —— 右键「弹窗播放」/ 备选轨 dblclick / 候选 ▶ 钮三入口同源，
//   播哪条由 resolveTrackClip 决定（备选轨按 cid 取对·非同段首条）。
//   R56R57-S3 T4: 等待显示源解析后播最终版（有 postfx 行时）；无行=胶合层零解析直通原产物；
//   解析失败/超时（上限 3s 防卡弹窗）容错回原产物。
async function previewClip(ctxEl) {
  const { clip } = resolveTrackClip(ctxEl);
  if (!clip || !clip.file) { showToast("info", t("edit.clip.noOutput")); return; }
  let file = clip.file;
  try {
    let timer = null;
    const src = await Promise.race([
      postfxSrcOf(clip),
      new Promise((res) => { timer = setTimeout(() => res(null), _previewSrcTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (src && src.level !== "none" && src.file) file = src.file;
  } catch (_e) { /* 容错: 解析故障回原产物 */ }
  showFinalPreview({ path: file, title: t("edit.preview.clipTitle", { name: clip.label || clip.segId || "" }) });
}

// ---- 批 L1 · T2 · R-27：片段右键「打开所在目录」----
//   链路：resolveTrackClip（三轨身份权威解析）→ clip.file → dirname（:6825 同式 replace）→ core/open_dir.js openDirRequest（R-31 收敛）
//   空守卫双层：①菜单项置灰（渲染期·clipFileOf 无 file 返 false）②fn 内早退+toast
//   （renderCtxItems 置灰仅视觉 .off+opacity·点击仍无条件挂 fn·防置灰失效路径直发垃圾包）
//   失败三分白话（主代理裁决②·文案照 preview.js _fsOpenDir:495-498 同源语义·防静默无反馈变报障源）
function clipFileOf(ctxEl) {
  const { clip } = resolveTrackClip(ctxEl);
  return (clip && typeof clip.file === "string") ? clip.file : "";
}
async function openClipDir(ctxEl) {
  const file = clipFileOf(ctxEl);
  if (!file) { showToast("info", t("edit.clip.noOutputYet")); return; }
  // R-31 收敛：发包+三分文案移 core/open_dir.js（动词=目录·网络失败走兜底文案=原 gui13Json network_error 同语义）
  await openDirRequest(file.replace(/[\\/][^\\/]+$/, ""), { toast: showToast, verb: "目录" });
}

// ---- 备选轨候选身份键 cid（批 B T1 · 方案 §一 身份键统一口径）----
//   segId = 段身份（主轨/分镜表/引擎产物）; cid = 候选身份（域 = altClips·每候选唯一）。
//   cid 内嵌 segId 可拆：分组展示用 segId, 个体操作（解析/删除/复制/排序）用 cid。
//   形态 alt-<segId>-<ts>-<n>: ts = 落轨时刻, 同 ts 递增 n 兜底 → 同循环同 sid 批量零撞键。
//   ts 由调用点注入: 批量落轨须 hoist 一次读钟传同一 ts（循环内逐条读钟跨毫秒 → 同 sid 批量
//   ts 互异，n 序号兜底失效 = 批3-T3 真竞态）；单次调用点走默认参零影响。
function newAltCid(segId, taken, ts = Date.now()) {
  const base = `alt-${segId || "x"}-${ts}`;
  let n = 0;
  let cid = `${base}-${n}`;
  while (taken && taken.has(cid)) { n += 1; cid = `${base}-${n}`; }
  if (taken) taken.add(cid);   // 登记入池 —— 同 ts 的后续条目顺延到 n=1,2,3…（序号兜底）
  return cid;
}
const cidsOf = (list) => new Set((list || []).map((c) => c && c.cid).filter(Boolean));

// 静默回写（读侧懒生成专用）: 借 _selfWrite 拦下 store 订阅重渲 + 不走 pushHist ——
//   读函数不得有可见写副作用（一次重渲会重建片段 DOM, 调用方持有的 el 脱档; 入撤销栈则「读一下多一步可撤销」）。
function writeEsSilent(patch) {
  if (!S || !S.projectId) return;
  S._selfWrite = true;
  updateEditingState(S.projectId, patch);
}

// 存量兜底: 老档候选无 cid 字段 → 读侧一次性补齐整表 cid 并回写（首次读后 cid 成为列表不变量）。
//   整表补齐（而非只补命中的那一条）是为让同轨其余候选元素同步拿到 dataset.cid ——
//   批5-R53-TC: 备选轨 = 动态多轨, 片段节点带 altIdx 戳（renderTracks 落·平铺数组序）——
//   回填改按 [data-alt-idx] 直查对位（多 lane 下 closest('.tl-track') 取 lane 局部序索引会错位）。
function ensureAltCid(el) {
  if (!el || !isAltKind(elTrackKind(el))) return null;
  if (el.dataset.cid) return el.dataset.cid;
  const list = es().altClips || [];
  if (!list.some((c) => c.segId === el.dataset.segId)) return null;   // 条目已不在轨内 → 零写入
  const taken = cidsOf(list);
  const next = list.slice();
  const now = Date.now();   // 批3-T3: 整表补齐同属一次批量 → hoist 一次读钟（同 sid 批量共用 ts·n 顺延）
  next.forEach((c, k) => { if (c && !c.cid) next[k] = { ...c, cid: newAltCid(c.segId, taken, now) }; });
  next.forEach((c, k) => {
    const el2 = S && S.root ? S.root.querySelector(`[data-alt-idx="${k}"]`) : null;
    if (el2) el2.dataset.cid = c.cid;
  });
  writeEsSilent({ altClips: next });
  return el.dataset.cid || null;   // 回本元素自身 cid（老档同段多条时不可退回 segId 首条）
}

// ---- 候选裁决域级通道（批 B T4）: 轨道徽章 .cok/.cno 与弹窗行内钮共用 ----
//   R53域重对齐-T3（方案 v3 §P2）: 两动作均纯本地·零引擎请求。
//   accept = 对调: mainClips[k] 与该条目只交换 file/ver——主轨得 {file:cur.file, ver:cur.ver||第N次重制}
//   （存量 retired 无 seq 兜底「原版」），条目得旧主 {file, ver:旧主ver||原版}；槽位（cid/seq/sid/
//   gen/label）全不动；上任清 discarded（I2-1·防正片播已废弃标记的文件）；主轨落 localPick
//   （applyHistory/inpaint 守则消费）；不再新建 retired 条目（退位视频=对调后的条目本身）。
//   discard = 纯本地标记: discarded+state warn（I2-2 label 冻结不动·I2-4 真源本地声明）；
//   现行（isCurrentPick·正片在播）废弃仍拦——防「已废弃但主轨仍播」卡死。
async function decideCandidateByClip(c, action) {
  const altState = es().altClips || [];
  const i = (c && c.cid) ? altState.findIndex((a) => a && a.cid === c.cid) : -1;
  if (i < 0) { showToast("info", t("edit.cand.gone")); return null; }
  const cur = altState[i];
  const mainOfSeg = () => (es().mainClips || []).find((cc) => cc && cc.segId === cur.segId);
  // 卫生3b accept 幂等前门: 候选已是现行（isCurrentPick file 归一判）再 ✓ = 纯重复对调 → 拦·零写入。
  if (action === "accept" && isCurrentPick(mainOfSeg(), cur)) {
    showToast("info", t("edit.cand.alreadyCurrent"));
    return null;
  }
  if (action !== "accept") {
    // 现行废弃拦（R53变更20-T3 延续）: 它就是正片在播的版本 → 拦 + 指引。
    if (isCurrentPick(mainOfSeg(), cur)) {
      showToast("info", t("edit.cand.currentNoDiscard"));
      return null;
    }
    cur.discarded = true;
    cur.state = "warn";
    writeEs({ altClips: altState.slice() });
    showToast("success", t("edit.cand.discarded"));
    return cur;
  }
  // 批 9 T3 · 18-13: 段已移出时间线（弹层开着时被移除的极边缘）→ 不落账、不谎报成功
  const clips = (es().mainClips || []).slice();
  const k = clips.findIndex((cc) => cc && cc.segId === cur.segId);
  if (k < 0) { showToast("info", t("edit.cand.movedOut")); return null; }
  if (!cur.file) {
    showToast("info", t("edit.cand.noFile"));   // 话术定稿 T3（语义「该候选无文件，无法上岗」）
    return null;
  }
  const oldFile = clips[k].file || "";
  const oldVer = clips[k].ver || "原版";
  const newVer = cur.ver || (cur.seq != null ? `第${cur.seq}次重制` : "原版");
  const fileChanged = oldFile !== cur.file;
  clips[k] = { ...clips[k], file: cur.file, ver: newVer, state: "done", status: "success", localPick: { file: cur.file } };
  if (fileChanged) clips[k].review = null;   // F101④ 同款: file 真变化 → 审核清回未审
  cur.file = oldFile;
  cur.ver = oldVer;
  // DEFECT-1 修正（节点门 A 审·主代理定调）: 对调钉住标记——rebuild 合并制凭 pinned 判「动过」
  //   （引擎正名复用下对调持有 file 与账本推导值恒同茎·纯茎比对判不出 → 静默回写撤销对调）；
  //   撤销栈整态快照回滚连带清标。pinned 排除在挤出上限对象外（candidates.js 动过口径）。
  cur.pinned = { file: oldFile };
  cur.discarded = false;   // 对调上任清废弃（上岗=复活）
  cur.state = "done";      // R53域重对齐-T4（主代理裁定·T3 遗留1）: state 一并回写——完整复活（否则曾废弃条上岗仍挂 warn 弱化底色）
  writeEs({ mainClips: clips, altClips: altState.slice() });
  showToast("success", t("edit.cand.swapped"));   // 话术定稿 T4（主代理裁定·T3 遗留2）
  return cur;
}
// 测试接缝（_test_es 同族）: ✓ 钮/拖拽/弹窗三入口汇流于 decideCandidateByClip——
//   用例经此直调锁守卫（按钮接线由候选用例覆盖）
export function _test_decideCandidateByClip(c, action) { return decideCandidateByClip(c, action); }

// ---- 片段元素 → store clip 解析（属性面板 / 变速共用·身份口径沿用 F2）----
//   音频按 id 优先（旧档无 id 兜底 label）; 正片按 segId; 备选按 cid（老档先懒生成兜底）。
//   查不到 → clip=null。
function resolveTrackClip(el) {
  const kind = elTrackKind(el);
  let list = kind === "main" ? es().mainClips : isAltKind(kind) ? es().altClips : kind === "audio" ? es().audioClips : null;
  if (!list) return { kind, list: null, index: -1, clip: null };
  let index;
  // 备选按 cid 反查: 同段多候选不再恒取首条（F107 撞车根治）; 懒生成改写了 altClips, 须重读
  if (isAltKind(kind) && ensureAltCid(el)) {
    list = es().altClips;
    index = list.findIndex((c) => c.cid === el.dataset.cid);
  } else {
    index = kind === "audio"
      ? list.findIndex((c) => (el.dataset.audioId ? c.id === el.dataset.audioId : c.label === el.textContent.trim()))
      : list.findIndex((c) => c.segId === el.dataset.segId);
  }
  return { kind, list, index, clip: index >= 0 ? list[index] : null };
}

// ===== 变速编辑态（S3-3 T2·R7 三定案锁定口径·不可偏离）=====
//   ① 播放器 playbackRate = speed 联动（speed=2 → 2 倍速快放 · 真机 video 直设。
//      T3 顺手项：速率方向经主代理裁决修正 —— speed 是快放倍速语义（有效时长 = dur ÷ speed），
//      详案 §S3-3 任务 2 ①原文「1/speed」系笔误，T2 原实现随之纠正）
//   ② 时间线片段宽度按有效时长计 —— 宽度 = effDur × pxs（effDur = dur ÷ speed·F4 口径·变速即重算；本行原「宽度恒 = dur × pxs，speed 不参与几何」系 F4 前陈文·批 F P0 勘正）
//   ③ 片段名旁速度角标（speed≠1）+ 属性面板「速度 / 有效时长」只读两行
//   读侧口径（T1 登记）: 读 clip.speed 一律先经 normalizeClipL2（旧档无字段 → 1.0 兜底）
const SPEED_MIN = 0.1;      // 批E E-T6 域放宽 0.5→0.1
const SPEED_MAX = 10;       // 批E E-T6 域放宽 2→10
const SPEED_STEP = 0.1;
function clipSpeedOf(clip) { return normalizeClipL2(clip).speed; }
// 位数口径：round(×10)/10 → 10 显示「10x」而非「10.0x」（E-T6 域放宽后上端点恰为整十·须核过）
function fmtSpeed(speed) { return `${Math.round(speed * 10) / 10}x`; }
// 滑杆值 → [0.1, 10] 且对齐 0.1 步进（浮点尾差抹平）; 非数字回 1.0（原速）
function clampSpeed(raw) {
  const n = +raw;
  const v = Number.isFinite(n) ? n : 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v * 10) / 10));
}
// J-P2（老板 2026-10-07「淡入淡出无效」·主代理裁决方案 A 写侧级联）：fadeIn/fadeOut/volume 是
//   **段级**意图——splitAV 段视频半按 -an 语义静音（previewSurfaceOf.muted 含 clipSplitAVOf），
//   声音走音频轨半；只写视频半 ⇒ 该段永远听不到（真机：video muted · audio vol 恒 1）。
//   配对判据与消费侧同源（audioWindowAt 锚定式 = 主轨同 segId）；单向：只在 main 侧级联，
//   音频条上的写入不反向回写视频半（防乒乓）。覆盖风险（裁决已知悉并承担）：音频半单独设过的
//   值会被视频半的写入覆盖 —— 仍可在音频条上单独改回（下次写即生效）。
const SEG_AUDIO_FIELDS = ["volume", "fadeIn", "fadeOut"];
function splitAvAudioPatch(st, mainClip, patch) {
  if (!mainClip || !clipSplitAVOf(mainClip)) return null;
  if (!SEG_AUDIO_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(patch, k))) return null;
  const segId = String(mainClip.segId || "");
  if (!segId) return null;
  const audio = (st.audioClips || []).slice();
  let hit = false;
  for (let i = 0; i < audio.length; i++) {
    if (String((audio[i] || {}).segId || "") === segId) { audio[i] = { ...audio[i], ...patch }; hit = true; }
  }
  return hit ? { audioClips: audio } : null;
}
// 右键编辑态写入共用路（T2 变速 / T3 倒放·定格）: 解析 clip → 浅拷贝合入字段 → 落 store。
//   查不到（已不在轨内）→ toast 兜底 + 零写入, 返 null。
//   coalesceKey（可选）: 连续手势撤销合并键（音量滑杆逐值写用·一次拖动 = 一个撤销单元）
function writeClipL2(el, patch, coalesceKey) {
  const { kind, list, index } = resolveTrackClip(el);
  if (index < 0) { showToast("info", t("edit.l2.gone")); return null; }
  const key = kind === "main" ? "mainClips" : isAltKind(kind) ? "altClips" : "audioClips";
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  // J-P2：段级音频字段（音量/淡化）写在 splitAV 视频半时，同一次 writeEs 级联配对音频半（一次撤销单元）
  const extra = kind === "main" ? splitAvAudioPatch(es(), next[index], patch) : null;
  writeEs(extra ? { [key]: next, ...extra } : { [key]: next }, coalesceKey);
  return next[index];
}
function applyClipSpeed(el, raw) {
  const speed = clampSpeed(raw);
  const c = writeClipL2(el, { speed });
  if (!c) return;
  showToast("info", t("edit.speed.applied", { name: c.label || t("edit.common.clip"), spd: fmtSpeed(speed) }));
}
// 变速弹窗（mbox 惯例 + 滑杆 zoomRange 先例）: 默认=当前 speed; 确认才写, 取消零副作用。
function openSpeedDialog(el) {
  if (!S || !el) return;
  const { kind, clip } = resolveTrackClip(el);
  if (!kind || !clip) { showToast("info", t("edit.speed.gone")); return; }
  const cur = clipSpeedOf(clip);
  const body = document.createElement("div");
  body.innerHTML = '<div style="display:flex;gap:10px;align-items:center;font-size:13px">'
    + '<span style="color:var(--txt3);flex-shrink:0">' + t("edit.common.speed") + '</span>'
    + `<input type="range" id="speedRange" min="${SPEED_MIN}" max="${SPEED_MAX}" step="${SPEED_STEP}" value="${cur}" style="flex:1;accent-color:var(--accent)">`
    + `<b class="spd-cur num">${fmtSpeed(cur)}</b></div>`;
  const range = body.querySelector("#speedRange");
  // 桩环境无属性反射（真机 min/max/step 属性 ↔ property 同源）——双写使两种读法一致
  range.min = String(SPEED_MIN); range.max = String(SPEED_MAX); range.step = String(SPEED_STEP);
  const curText = body.querySelector(".spd-cur");
  range.addEventListener("input", () => { curText.textContent = fmtSpeed(clampSpeed(range.value)); });
  const note = document.createElement("div");
  note.style.cssText = "font-size:12px;color:var(--txt3);margin-top:8px";
  note.textContent = t("edit.speed.note");
  body.appendChild(note);
  openMbox(t("edit.speed.cap", { name: clip.label }), t("edit.speed.sub"), body, [
    [t("edit.common.cancel"), null],
    [t("edit.common.confirm"), () => applyClipSpeed(el, range.value), "prim"],
  ]);
}

// ===== 倒放 / 定格编辑态（S3-3 T3）=====
//   倒放 = clip.reverse 翻转标记: 右键「倒放」开、再点关; ⟲ 角标（片段名旁·同 .spd 形态）。
//   定格 = clip.freeze 冻结 N 秒标记: 右键「定格」→ 数字输入（默认 2s）→ {sec:N}; ⏸ 角标;
//     清空输入 + 确认 = 取消定格（本无定格在身时零写入·不凭空写 freeze:null）。
//   形态按最小实现: freeze = { sec } —— 详案留的 at（冻结起点）当前无消费方（引擎侧 tpad
//     转正批再定），不落字段。持久化/读侧口径同 T2（随项目 JSON · 读值先经 normalizeClipL2）。
const FREEZE_DEFAULT_SEC = 2;
function clipReverseOf(clip) { return normalizeClipL2(clip).reverse; }
// freeze 形态已由本任务定为 {sec:N} → 读侧只认有限正数 sec（脏档 {} / sec 非法 = 无定格）
function clipFreezeOf(clip) {
  const frz = normalizeClipL2(clip).freeze;
  return frz && Number.isFinite(frz.sec) && frz.sec > 0 ? frz : null;
}
function fmtFreeze(sec) { return `⏸${fmtDur(sec)}s`; }
// 倒放: 翻转标记（writeClipL2 写后即重渲染 → 角标随之增删）
function toggleClipReverse(el) {
  const { kind, clip } = resolveTrackClip(el);
  if (!kind || !clip) { showToast("info", t("edit.reverse.gone")); return; }
  const next = !clipReverseOf(clip);
  const c = writeClipL2(el, { reverse: next });
  if (!c) return;
  showToast("info", next ? t("edit.reverse.on", { name: c.label || t("edit.common.clip") }) : t("edit.reverse.off", { name: c.label || t("edit.common.clip") }));
}
// 输入解析: 空/非正数 → null（= 取消定格）
function parseFreezeSec(raw) {
  const txt = String(raw == null ? "" : raw).trim();
  const n = txt ? Number(txt) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function applyClipFreeze(el, raw) {
  const { kind, clip } = resolveTrackClip(el);
  if (!kind || !clip) { showToast("info", t("edit.freeze.gone")); return; }
  const sec = parseFreezeSec(raw);
  const cur = clipFreezeOf(clip);
  if (sec == null && !cur) { showToast("info", t("edit.freeze.none", { name: clip.label || t("edit.common.clip") })); return; }
  const c = writeClipL2(el, { freeze: sec == null ? null : { sec } });
  if (!c) return;
  showToast("info", sec == null ? t("edit.freeze.off", { name: c.label || t("edit.common.clip") }) : t("edit.freeze.on", { name: c.label || t("edit.common.clip"), sec: fmtDur(sec) }));
}
// 定格弹窗（数字输入惯例同 mbox + 变速滑杆域）: 默认 2s / 回显当前秒数; 确认才写, 取消零副作用。
function openFreezeDialog(el) {
  if (!S || !el) return;
  const { kind, clip } = resolveTrackClip(el);
  if (!kind || !clip) { showToast("info", t("edit.freeze.gone")); return; }
  const cur = clipFreezeOf(clip);
  const body = document.createElement("div");
  body.innerHTML = '<div style="display:flex;gap:10px;align-items:center;font-size:13px">'
    + '<span style="color:var(--txt2);flex-shrink:0">' + t("edit.freeze.label") + '</span>'
    + `<input type="number" id="freezeSec" min="0.1" step="0.1" value="${cur ? cur.sec : FREEZE_DEFAULT_SEC}" style="flex:1;min-width:0">`
    + "</div>";
  const inp = body.querySelector("#freezeSec");
  // 桩环境无属性反射（真机 min/max/step 属性 ↔ property 同源）——双写使两种读法一致
  inp.min = "0.1"; inp.step = "0.1";
  const note = document.createElement("div");
  note.style.cssText = "font-size:12px;color:var(--txt3);margin-top:8px";
  note.textContent = t("edit.freeze.note");
  body.appendChild(note);
  openMbox(t("edit.freeze.cap", { name: clip.label }), t("edit.freeze.sub"), body, [
    [t("edit.common.cancel"), null],
    [t("edit.common.confirm"), () => applyClipFreeze(el, inp.value), "prim"],
  ]);
}

// ===== 分离音视频编辑态（S3-3 T4）=====
//   ① 正片片段 splitAV=true（-an 语义: 该视频段静音）+ 片段名旁 🔇 角标（同 .spd/.rev 形态·不参与几何）。
//   ② 音频轨新建对应 clip（-vn 语义）: id 走「aud-」前缀（S3-2 T2 音频副本惯例）/ label「段N·音」（N=段号）/
//      同 segId 关联 / dur·triml·full 对齐原片段；只落必要字段 —— 音量按最小实现 volume=1.0
//      （不继承原片段音量）；file 随父段复制（批 F F-T1 四口全落·预听/导出消费源）；state/ver 等
//      其余衍生态与 L2 字段不复制（读侧 normalizeClipL2 兜默认）。
//   ③ 防重复: 已 splitAV 片段菜单项置灰（.off）+ 入口守卫双保险 —— 再点不重复创建音频 clip；
//      取消/合并通道不做（合并属执行层转正批语义·详案未定义, 按最小实现定）。
//   读侧口径（T1 登记）: 读 clip.splitAV 一律先经 normalizeClipL2（旧档无字段 → false 兜底）。
function clipSplitAVOf(clip) { return normalizeClipL2(clip).splitAV; }
// 音频 clip 名「段N·音」: N=段号 —— 时间线序号 n 优先; 旧档/浮动段无 n → 从 label「段N」提取兜底
function audioLabelFor(clip) {
  const n = +clip.n;
  const no = Number.isFinite(n) && n > 0 ? n : (/段(\d+)/.exec(String(clip.label || "")) || [])[1];
  return no ? `段${no}·音` : `${clip.label || "段"}·音`;
}
// 菜单可用判定: 正片轨 + clip 在轨 + 未拆 → 可点; 其余置灰（点击仍走入口守卫, toast 说明原因）
function canSplitAVOf(el) {
  const { kind, clip } = resolveTrackClip(el);
  return kind === "main" && !!clip && !clipSplitAVOf(clip);
}
// 一次 writeEs 同写两列表（splitAV 标记 + 音频轨新增）—— 刷新保持（随项目 JSON 落盘）
function splitAudioFromClip(el) {
  const { kind, list, index, clip } = resolveTrackClip(el);
  if (kind !== "main" || !clip) { showToast("info", t("edit.splitav.mainOnly")); return null; }
  if (clipSplitAVOf(clip)) { showToast("info", t("edit.splitav.dupe", { name: clip.label || t("edit.common.clip") })); return null; }
  const dur = +clip.dur || 0;
  const aud = {
    id: newCopyId("aud-"),
    label: audioLabelFor(clip),
    segId: clip.segId,
    dur,
    triml: +clip.triml || 0,
    full: clip.full != null ? +clip.full : dur,
    volume: 1.0,
    ...(clip.file ? { file: clip.file } : {}), // 批 F F-T1: 复制父段 file（不做 segId 反查·父段换产物后半段停留旧值·方案 §七.9）
  };
  const clips = list.slice();
  clips[index] = { ...clips[index], splitAV: true };
  writeEs({ mainClips: clips, audioClips: [...(es().audioClips || []), aud] });
  showToast("info", t("edit.splitav.done", { name: clip.label || t("edit.common.clip"), label: aud.label }));
  return aud;
}

// ===== 音量编辑态（S3-3 T5·单值）=====
//   ① 属性面板「音量」滑杆（0-1·步进 0.05）: 拖动即写 clip.volume（writeClipL2 既有通道·
//      滑杆不弹 toast 防刷屏，值显示即反馈）。
//   ② 片段下缘音量条: 高度 = volume 百分比（纯 CSS 高度·绝对定位·不参与片段几何）。
//      定案: volume===1 不渲染（默认态不干扰视觉）· volume<1 才显示 · volume=0 → 0% 视觉无条。
//      条不带文本 —— 音频片段身份解析有 label 兜底路（el.textContent.trim()），带文本会污染。
//   读侧口径（T1 登记）: 读 clip.volume 一律先经 normalizeClipL2（旧档无字段 → 1.0 兜底）；
//      范围钳制 0-1 属编辑控件口径（store.js normalizeClipL2 注释登记）—— 控件侧 clamp。
//   包络编辑随执行层转正升级，本批 = 单值（详案 §S3-3 任务 5）。
const VOL_MIN = 0;
const VOL_MAX = 1;
const VOL_STEP = 0.05;
function clipVolumeOf(clip) { return normalizeClipL2(clip).volume; }
function fmtVolume(v) { return v.toFixed(2); }
// 滑杆值 → [0, 1] 且对齐 0.05 步进（浮点尾差抹平）; 非数字回 1.0（原音量）
function clampVolume(raw) {
  const n = +raw;
  const v = Number.isFinite(n) ? n : 1;
  return Math.min(VOL_MAX, Math.max(VOL_MIN, Math.round(v * 100) / 100));
}
// 音量条高度百分比: volume=1（默认态）→ null（不渲染）; 其余取整（0.5 → "50%"）
function volBarPct(clip) {
  const v = clampVolume(clipVolumeOf(clip));
  return v < VOL_MAX ? Math.round(v * 100) + "%" : null;
}
// 挂下缘音量条（正片/音频片段共用·纯视觉）
function appendVolBar(el, clip) {
  const pct = volBarPct(clip);
  if (!pct) return;
  const bar = document.createElement("i");
  bar.className = "vbar";
  bar.style.height = pct;
  el.appendChild(bar);
}

// ===== 淡化编辑态（S3-3 T9·单值秒数）=====
//   ① 属性面板「淡入 / 淡出」两输入行（0-5s·步进 0.1）: change 即写 clip.fadeIn / clip.fadeOut
//      （writeClipL2 既有通道·同 T5 音量口径）。
//   ② 片段下缘淡化渐变条: 左条 = 淡入（左浓右透）/ 右条 = 淡出（右浓左透），
//      条宽 = 淡化秒数 ÷ 片段时长（纯 CSS 线性渐变·绝对定位·不参与片段几何）。
//      定案（同 T5 音量条）: 值 0 不渲染（默认态不干扰视觉）· 值>0 才挂 · 条不带文本
//      （音频片段身份解析有 label 兜底路 el.textContent.trim()，带文本会污染）。
//   读侧口径（T1 登记）: 读 clip.fadeIn/fadeOut 一律先经 normalizeClipL2（旧档无字段 → 0 兜底）；
//      0-5 域钳制属编辑控件口径（store.js normalizeClipL2 注释登记）—— 控件侧 clamp。
//   包络/曲线淡化随执行层转正升级，本批 = 单值（详案 §S3-3 任务 9）。
const FADE_MIN = 0;
const FADE_MAX = 5;
const FADE_STEP = 0.1;
function clipFadeInOf(clip) { return clampFade(normalizeClipL2(clip).fadeIn); }
function clipFadeOutOf(clip) { return clampFade(normalizeClipL2(clip).fadeOut); }
function fmtFade(v) { return v.toFixed(1); }
// 输入值 → [0, 5] 且对齐 0.1 步进（浮点尾差抹平）; 空/非数字回落 0（默认）
function clampFade(raw) {
  const n = +raw;
  const v = Number.isFinite(n) ? n : FADE_MIN;
  return Math.min(FADE_MAX, Math.max(FADE_MIN, Math.round(v * 10) / 10));
}
// 淡化条宽百分比: 秒数>0 且片段时长>0 才有条（宽度按占比·超时长按满宽 100%）
function fadeBarPct(sec, dur) {
  if (!(sec > 0) || !(dur > 0)) return null;
  return Math.min(100, Math.round((sec / dur) * 100)) + "%";
}
// 挂下缘淡化渐变条（正片/备选/音频片段共用·纯视觉）: 淡入挂左条、淡出挂右条, 各自值>0 才挂
function appendFadeBar(el, clip) {
  const dur = +clip.dur || 0;
  [["in", clipFadeInOf(clip)], ["out", clipFadeOutOf(clip)]].forEach(([side, sec]) => {
    const pct = fadeBarPct(sec, dur);
    if (!pct) return;
    const bar = document.createElement("i");
    bar.className = "fbar " + side;
    bar.style.width = pct;
    el.appendChild(bar);
  });
}

// ===== 关键帧读侧（#81 D3b：编辑弹窗/打点入口已删·clip.keyframes 数据容忍）=====
//   条目形态: {t, param, value} 单条目单参数（+ easing 可缺省 = linear·旧档零迁移）。
//   读侧（T1 登记）: 读 clip.keyframes 一律先经 normalizeClipL2（旧档无字段 → [] 兜底）;
//     脏条目（param 非法 / t、value 非有限数）读时跳过。
//   预览消费 = previewSurfaceOf（kfTransformOf/kfOpacityOf 插值·源内秒域）。
const KF_PARAM_DEF = {
  scale: { min: 0.5, max: 3, def: 1, step: 0.1 },
  x: { min: -100, max: 100, def: 0, step: 1 },
  y: { min: -100, max: 100, def: 0, step: 1 },
  opacity: { min: 0, max: 1, def: 1, step: 0.05 },
};
// 读侧: 只认四参数且 t/value 有限的条目（脏条目跳过·不渲染 NaN）; 按时间点升序（与草稿同规范序）
function kfSort(list) { return list.slice().sort((a, b) => a.t - b.t); }
function kfReadOf(clip) {
  return kfSort(normalizeClipL2(clip).keyframes
    .filter((k) => k && KF_PARAM_DEF[k.param] && Number.isFinite(k.t) && Number.isFinite(k.value)));
}
// 批 E-T9（方案 §五 T9 /§三裁决 1 transform 项）：关键帧 → 预览 transform 串（纯函数·不读 S）。
//   三参各自在相邻关键帧间插值（缓动见下方 KF_EASINGS·T8 起 ease-in/ease-out 分支），
//   t 落在两帧之间才算·端点取帧值；t < 首帧 = 首帧值、t > 末帧 = 末帧值（越界夹取·不外插）；
//   某参无关键帧 = 该参默认值（恒等段不写多余值）。多参独立插值后合成 `translate(X%, Y%) scale(S)`——
//   顺序固定（先位移后缩放），x/y 是画面百分比（KF_PARAM_DEF -100~100·不做像素换算：
//   画面百分比随容器尺寸自适应，比写死像素更贴预演语义）。
//   t 域 = **源内秒**（关键帧编辑态 t ∈ [0, clip.dur]·openKeyframeDialog maxT=clip.dur）——
//   与 fadeGainOf 同一源内秒域，故变速段（speed=2）关键帧按源内秒走、轴内被压成 1/speed 倍长。
//   opacity 参数不入本串（T8 起走独立插值轨 kfOpacityOf+KF_OPACITY_PARAMS——原「归批 G F-15」
//   收窄在此兑现；与 styleOf 交叉淡化的窗口期协调见 applyPreviewSurface/T10）。
//   三参皆无关键帧 = 恒等 → 返 null（挂点直清空串·同 filter 空态口径·不得留残留串）。
const KF_TF_PARAMS = ["scale", "x", "y"];
// 批 G-b T8（F-15a·裁决 4）: opacity 参数独立插值轨（B 建议 3 分层）——transform 轨不吃 opacity 帧，
//   opacity 轨不吃 transform 帧（与 styleOf 换源交叉淡化的正面对撞由 T10 窗口期暂停消解）。
const KF_OPACITY_PARAMS = ["opacity"];
// F-15a 缓动三档（裁决 4·CSS 对齐·渲染端批 H 若扩缓动同枚举名）: 条目 easing 字段可缺省 =
//   linear（旧档零迁移），脏值回落 linear；**区间系数取起点帧 easing**（A 建议 4）。
const KF_EASINGS = ["linear", "ease-in", "ease-out"];
function kfEaseOf(k) { return k && KF_EASINGS.includes(k.easing) ? k.easing : "linear"; }
function kfEaseCoef(easing, u) {
  if (easing === "ease-in") return u * u;                    // t²
  if (easing === "ease-out") return 1 - (1 - u) * (1 - u);   // 1−(1−t)²
  return u;
}
function kfTransformOf(clip, srcSec) {
  const kf = kfReadOf(clip).filter((k) => KF_TF_PARAMS.includes(k.param));
  if (!kf.length) return null;
  const t = Number.isFinite(+srcSec) ? +srcSec : 0;
  // 单参取值：首帧前夹首值 / 末帧后夹末值（越界夹取·不外插）；无关键帧 = 该参默认（恒等）
  const at = (param) => {
    const rows = kf.filter((k) => k.param === param);
    return rows.length ? kfLerpAt(rows, t) : KF_PARAM_DEF[param].def;
  };
  // 两位小数抹浮点尾差（1/3 插值会出 1.6666666666666667·串进 style 不可预期·同 kfClampVal 口径）
  const num = (v) => Math.round(v * 100) / 100;
  return `translate(${num(at("x"))}%, ${num(at("y"))}%) scale(${num(at("scale"))})`;
}
// 单参关键帧插值（rows = 该参数按 t 升序的条目）：端点夹取帧值，两帧间按**起点帧** easing 缓动。
function kfLerpAt(rows, t) {
  if (t <= rows[0].t) return rows[0].value;
  for (let i = 1; i < rows.length; i++) {
    if (t <= rows[i].t) {
      const a = rows[i - 1], b = rows[i];
      const u = kfEaseCoef(kfEaseOf(a), (t - a.t) / (b.t - a.t));
      return a.value + (b.value - a.value) * u;
    }
  }
  return rows[rows.length - 1].value;
}
// F-15a opacity 插值轨（T8 与 T10 同步交付·B 重要 5）: 无关键帧返 null（挂点清空串·不回流默认 1）；
//   值域钳 [0,1]（KF_PARAM_DEF.opacity 域·脏值防御同 previewSurfaceOf.volume 消费侧口径），两位小数。
function kfOpacityOf(clip, srcSec) {
  const rows = kfReadOf(clip).filter((k) => KF_OPACITY_PARAMS.includes(k.param));
  if (!rows.length) return null;
  const t = Number.isFinite(+srcSec) ? +srcSec : 0;
  return Math.round(Math.min(1, Math.max(0, kfLerpAt(rows, t))) * 100) / 100;
}

// ===== 转场编辑态（S3-3 T7·批E E-T7 扩容 8 类型 + 时长域 0.1-3s）=====
//   ① 入口: 正片轨相邻两项交界渲染 .trans-btn（buildTransBtn）——未设 = hover 出「+转场」;
//      已设 = 「⇄类型」常显（再点 = 打开弹窗可改 / 删除）。
//   ② 落库形态: clip.transition = {type, sec} —— 写在前一片段（交界语义 = 前段出口转场·后段不落字段）。
//   ③ 数值口径: type ∈ 8 种中文标签（批E E-T7 按裁决 4 扩容·编辑态**继续存中文标签**·旧档「叠化/黑场」
//      零迁移；xfade key 映射 = 批 H 伴生服务侧建立）; sec 0.1-3s（默认 0.5）; 清空时长输入 + 确认 =
//      清空转场（transition:null·沿用 T3 定格「清空输入再确认」惯例）; 本无转场时清空确认 = 零写入。
//   读侧口径（T1 登记）: 读 clip.transition 一律先经 normalizeClipL2（旧档无字段 → null 兜底）;
//     脏档（type 非八选项 / sec 非有限正数）按未设处理（不渲染脏值）。
const TRANS_TYPES = ["叠化", "黑场", "白场", "左移", "右移", "上滑", "下滑", "圆形展开"];
const TRANS_SEC_MIN = 0.1;
const TRANS_SEC_MAX = 3;
const TRANS_SEC_DEFAULT = 0.5;
// 读侧规范形: 只认合法 type + 有限正数 sec; 其余（含 0 / NaN / 脏对象）→ null（= 未设转场）
function clipTransitionOf(clip) {
  const tr = normalizeClipL2(clip).transition;
  if (!tr || !TRANS_TYPES.includes(tr.type)) return null;
  const sec = +tr.sec;
  return Number.isFinite(sec) && sec > 0 ? { type: tr.type, sec } : null;
}
// ----- 批 L3 T-C（R-23①）预览 8 型转场模拟层（CSS 近似·不碰渲染管线）-----
//   语义对齐: 转场 = 前段出口交界语义 + xfade 只在**相邻交界**生效 → 预览模拟必须同判据。
//   合并判据（onSwap 挂点·三项全过才播）: ①退位段取活实例（segId 对号·E-T6 同口径）且其有转场
//   ②换入段 = 退位段在 mainClips 数组序的相邻后继（引用比对·tgt 已由 computeSwapSeekTarget 解析·
//   避同 segId 多条歧义）③播放序（info.wantPlay || info.wasPlaying·:1672 换位快照·**不读 _scrubbing**
//   无时序竞态）。不相邻（跳段/游标跳选/ruler 定位）与非播放序（暂停态拖游标）一律不播。
//   overlay 生命周期: 新 promote 先摘上一个（连续跨段不叠加·tr.sec 上限 3s 可大于段 effDur）·
//   过渡事件 + tr.sec*1000+200ms 兜底定时器双保险移除 · unmount/destroy 清句柄防泄漏。
//   样式全内联（edit.css 零改动）；模拟 ≠ xfade 曲线（副标题「预览为近似模拟」预期管理）。
const TRANS_OV_CLASS = "tr-ov";
const TRANS_OV_Z = "2";          // 压在两 video 之上（容器内 video 皆 absolute·z auto·DOM 序不可依赖）；
                                //   取 2 不取 3 = 低于 .pv-actions（z-index:3）——转场幕只盖画面不盖导出/载入历史钮
const TRANS_OV_GRACE_MS = 200;   // 兜底余量（事件不到时定时器兜底）
// 八型近似形态: 幕底色 + 起始态 → 终止态（键为内联样式属性名）
const TRANS_OV_SHAPE = {
  "叠化": { bg: "rgba(0,0,0,0.35)", from: { opacity: "1" }, to: { opacity: "0" } },
  "黑场": { bg: "#000", from: { opacity: "1" }, to: { opacity: "0" } },
  "白场": { bg: "#fff", from: { opacity: "1" }, to: { opacity: "0" } },
  "左移": { bg: "#000", from: { opacity: "1", transform: "translateX(0)" }, to: { opacity: "0", transform: "translateX(-100%)" } },
  "右移": { bg: "#000", from: { opacity: "1", transform: "translateX(0)" }, to: { opacity: "0", transform: "translateX(100%)" } },
  "上滑": { bg: "#000", from: { opacity: "1", transform: "translateY(0)" }, to: { opacity: "0", transform: "translateY(-100%)" } },
  "下滑": { bg: "#000", from: { opacity: "1", transform: "translateY(0)" }, to: { opacity: "0", transform: "translateY(100%)" } },
  "圆形展开": { bg: "#000", from: { opacity: "1", clipPath: "circle(0% at 50% 50%)" }, to: { opacity: "1", clipPath: "circle(75% at 50% 50%)" } },
};
let _transOvEl = null;    // 在位 overlay（防连续跨段叠加）
let _transOvTimer = 0;    // 兜底移除句柄

function clearTransOverlay() {
  if (_transOvTimer) { clearTimeout(_transOvTimer); _transOvTimer = 0; }
  if (_transOvEl) { try { _transOvEl.remove(); } catch (_e) { /* 已随容器卸载 */ } _transOvEl = null; }
}

// 挂一层并起过渡（时长 = tr.sec·单元素幕·起止态两帧法）
function playTransOverlay(pl, tr) {
  const shape = tr && TRANS_OV_SHAPE[tr.type];
  if (!pl || !shape) return;
  clearTransOverlay();                                    // 新 promote 先摘上一个
  const el = document.createElement("div");
  el.className = TRANS_OV_CLASS;
  el.dataset.trType = tr.type;
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.left = "0";
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.zIndex = TRANS_OV_Z;
  el.style.pointerEvents = "none";                        // 不挡原生 controls 命中
  el.style.background = shape.bg;
  el.style.transition = "none";                           // 起始态先落地·回流后才允许过渡
  for (const k in shape.from) el.style[k] = shape.from[k];
  pl.appendChild(el);
  _transOvEl = el;
  const ms = Math.round(tr.sec * 1000);
  const done = () => { if (_transOvEl === el) clearTransOverlay(); };
  el.addEventListener("transitionend", done);
  el.addEventListener("animationend", done);
  void el.offsetWidth;                                    // 强制回流：起始态先被计算·终止态才被当「变更」
  el.style.transition = "opacity " + ms + "ms linear, transform " + ms + "ms linear, clip-path " + ms + "ms linear";
  for (const k in shape.to) el.style[k] = shape.to[k];
  _transOvTimer = setTimeout(done, ms + TRANS_OV_GRACE_MS);   // 兜底：事件不到（后台页/被打断）也必摘
}

// onSwap 判据合并（调用点=computeSwapSeekTarget 之后·改写 _activeClipRef 之前·退位段身份仍有效）
function playSwapTransOverlay(pl, tgtClip, playingOrder) {
  if (!pl || !tgtClip || !playingOrder) return;
  const arr = es().mainClips || [];
  const ai = activeClipIndex(arr);                        // 退位活实例下标（segId 对号·E-T6 同口径）
  if (ai < 0 || arr[ai + 1] !== tgtClip) return;          // 非相邻后继 → 不播
  playTransOverlay(pl, clipTransitionOf(arr[ai]));
}

// 时长输入 → 钳到 [0.1, 3] 且对齐 0.1 步进（浮点尾差抹平）; 空/非数字 → null（= 清空转场）
function parseTransSec(raw) {
  const txt = String(raw == null ? "" : raw).trim();
  const n = txt ? Number(txt) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(TRANS_SEC_MAX, Math.max(TRANS_SEC_MIN, Math.round(n * 10) / 10));
}
function applyClipTransition(el, rawType, rawSec) {
  const { kind, clip } = resolveTrackClip(el);
  if (kind !== "main" || !clip) { showToast("info", t("edit.trans.mainOnly")); return; }
  const cur = clipTransitionOf(clip);
  const sec = parseTransSec(rawSec);
  if (sec == null && !cur) { showToast("info", t("edit.trans.noneYet")); return; }
  const c = writeClipL2(el, { transition: sec == null ? null : { type: rawType, sec } });
  if (!c) return;
  showToast("info", sec == null
    ? t("edit.trans.cleared", { name: c.label || t("edit.common.clip") })
    : t("edit.trans.applied", { name: c.label || t("edit.common.clip"), type: rawType, sec: fmtDur(sec) }));
}
// 转场弹窗（mbox 惯例）: 默认 = 当前转场（未设 → 叠化 / 0.5s）; 确认才写, 取消零副作用。
//   交界已不存在（前段现为末段）→ 不弹窗（防把转场写到无出口的片段上）。
function openTransitionDialog(el) {
  if (!S || !el) return;
  const { kind, list, index, clip } = resolveTrackClip(el);
  const next = clip && kind === "main" ? (list[index + 1] || null) : null;
  if (!next) { showToast("info", t("edit.trans.notAtJoint")); return; }
  const cur = clipTransitionOf(clip);
  const body = document.createElement("div");
  body.innerHTML = '<div style="display:flex;gap:10px;align-items:center;font-size:13px">'
    + '<span style="color:var(--txt3);flex-shrink:0">' + t("edit.common.type") + '</span>'
    + `<select id="transType" style="flex:1;min-width:0">${TRANS_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>`
    + "</div>"
    + '<div style="display:flex;gap:10px;align-items:center;font-size:13px;margin-top:8px">'
    + '<span style="color:var(--txt3);flex-shrink:0">' + t("edit.trans.secLabel") + '</span>'
    + `<input type="number" id="transSec" min="${TRANS_SEC_MIN}" max="${TRANS_SEC_MAX}" step="0.1" value="${cur ? cur.sec : TRANS_SEC_DEFAULT}" style="flex:1;min-width:0">`
    + "</div>";
  const sel = body.querySelector("#transType");
  // 桩环境无属性反射（真机 option 的 selected ↔ select.value 同源）——显式回显使两种读法一致
  sel.value = cur ? cur.type : TRANS_TYPES[0];
  const inp = body.querySelector("#transSec");
  inp.min = String(TRANS_SEC_MIN); inp.max = String(TRANS_SEC_MAX); inp.step = "0.1";
  const note = document.createElement("div");
  note.style.cssText = "font-size:12px;color:var(--txt3);margin-top:8px";
  note.textContent = t("edit.trans.note1", { types: TRANS_TYPES.join(" / "), min: TRANS_SEC_MIN, max: TRANS_SEC_MAX })
    + t("edit.trans.note2", { def: TRANS_SEC_DEFAULT });
  body.appendChild(note);
  openMbox(t("edit.trans.cap", { name: clip.label, next: next.label }), t("edit.trans.sub"), body, [
    // 批 L3 T-A（R-23④）：删除钮仅在本交界已有转场时给（无物可删不给钮·脚下留白），
    //   走既有清空路径——传 cur.type 不依赖弹窗 select 内态（改了下拉也照删）。
    ...(cur ? [[t("edit.trans.delBtn"), () => applyClipTransition(el, cur.type, "")]] : []),
    [t("edit.common.cancel"), null],
    [t("edit.common.confirm"), () => applyClipTransition(el, sel.value, inp.value), "prim"],
  ]);
}

// ===== 调色读侧（#81 D3a：编辑面板已删·clip.color / editingState.color 数据容忍）=====
//   落库形态 {bright, contrast, sat, temp, filter}（4 数 + 1 枚举字符串）；
//   读侧归一沿用 T5/T7 兜底口径（非数字/越界/非白名单滤镜回各参数默认）；
//   预览消费 = previewSurfaceOf（下方归口函数·filter 字段）。
const COL_ROWS = { bright: "亮度", contrast: "对比度", sat: "饱和度", temp: "色温" };
// 走查反馈 F30（老板「预设再多一些+选预设后参数跟随同步」）：4 款 → 10 款；
//   「暖色/冷色」更名「暖阳/冷调」（读侧别名兼容旧档）；每预设带推荐参数——选择即同步滑杆。
const COL_FILTERS = ["无", "暖阳", "冷调", "胶片", "黑白", "褪色", "鲜艳", "柔和", "夜景", "复古"];
const COL_FILTER_ALIAS = { "暖色": "暖阳", "冷色": "冷调" }; // 旧档读侧映射
// 预览近似（原型 :6434 COL_FILTER / colRender 逐字）：编辑态 CSS 近似，引擎侧滤镜链见协调单
const COL_FILTER_CSS = {
  "无": "",
  "暖阳": "sepia(.3) saturate(1.15)",
  "冷调": "hue-rotate(-12deg) saturate(.92)",
  "胶片": "sepia(.18) contrast(1.12) saturate(.85)",
  "黑白": "grayscale(1)",
  "褪色": "sepia(.12) saturate(.75) contrast(.95)",
  "鲜艳": "saturate(1.35) contrast(1.05)",
  "柔和": "saturate(.9) brightness(1.05) contrast(.92)",
  "夜景": "brightness(.88) contrast(1.1) hue-rotate(-6deg) saturate(.95)",
  "复古": "sepia(.4) contrast(1.08) saturate(.8) hue-rotate(4deg)",
};
const COL_MIN = -100;
const COL_MAX = 100;
const COL_FILTER_DEFAULT = "无";
function colDefaults() { return { bright: 0, contrast: 0, sat: 0, temp: 0, filter: COL_FILTER_DEFAULT }; }
// 滑杆值 → [-100, 100] 整数（浮点尾差抹平）；非数字回 0（原型 range 控件边界口径）
function clampCol(raw) {
  const n = +raw;
  const v = Number.isFinite(n) ? n : 0;
  return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(v)));
}
// 读侧归一：非对象 / 缺字段 / 脏值 → 各参数默认（不渲染脏值）
function normalizeColor(raw) {
  const out = colDefaults();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of Object.keys(COL_ROWS)) {
    if (typeof raw[k] === "number" && Number.isFinite(raw[k])) out[k] = clampCol(raw[k]);
  }
  // F30: 旧档预设名（暖色/冷色）经别名映射到新名（暖阳/冷调）——存量档不丢预设
  const f = COL_FILTER_ALIAS[raw.filter] || raw.filter;
  if (COL_FILTERS.includes(f)) out.filter = f;
  return out;
}
function isColDefault(c) { return Object.keys(COL_ROWS).every((k) => c[k] === 0) && c.filter === COL_FILTER_DEFAULT; }
// 预览近似串（原型 colRender 逐字：temp≥0 sepia / <0 hue-rotate）
function colPreviewCss(c) {
  const temp = c.temp >= 0 ? `sepia(${(c.temp / 240).toFixed(3)})` : `hue-rotate(${(c.temp * 0.1).toFixed(1)}deg)`;
  return `brightness(${(1 + c.bright / 100).toFixed(2)}) contrast(${(1 + c.contrast / 100).toFixed(2)}) `
    + `saturate(${(1 + c.sat / 100).toFixed(2)}) ${temp} ${COL_FILTER_CSS[c.filter] || ""}`;
}
function clipColorOf(clip) { return normalizeColor(normalizeClipL2(clip).color); }

// ---- 片段属性面板（只读·S3-2 T4）----
// 数据源 = store 该 clip 对象（逐字段直读, 不另存快照）。
//   剪量口径: store clip 无 trimr 字段 —— 左剪 = triml, 右剪 = full - triml - dur
//     （与 core/timeline.js applyTrimClip 的 rcut 同公式; full 缺省按 dur+triml 兜底）。
//   缺字段（音频 clip 无 ver/seed）→ 显示「—」, 不发明值。
// 只读行 + 音量滑杆一行（S3-3 T5 起·面板唯一可编辑控件; 其余改参数走「修改参数并重跑」/ 设定页）。
function openClipProps(el) {
  if (!S || !el) return;
  const { kind, clip } = resolveTrackClip(el);
  if (!kind) return;
  if (!clip) { showToast("info", t("edit.props.gone")); return; }
  const dash = (v) => (v == null || v === "" ? "—" : String(v));
  const dur = +clip.dur || 0;
  const triml = +clip.triml || 0;
  const full = clip.full != null ? +clip.full : dur + triml;
  // S3-2 T5 顺手项: 种子回落真源 —— 正片 clip 无 seed 字段（reconcileMainClips 不搬 seed）,
  //   故按 segId 回 segments 取; 浮动段(paste-/new-)查不到匹配仍显示「—」。
  const proj = storeLoad(S.projectId);
  const seg = (proj && proj.segments || []).find((s) => s.id === clip.segId);
  // S3-3 T2 定案③: 变速只读两行 —— 有效时长 = dur ÷ speed（只读估算·不改时间线几何）
  const spd = clipSpeedOf(clip);
  const rows = [
    [t("edit.props.kName"), dash(dispClipLabel(clip.label))],
    [t("edit.props.kDur"), `${fmtDur(dur)}s`],
    [t("edit.props.kTriml"), `${fmtDur(triml)}s`],
    [t("edit.props.kTrimr"), `${fmtDur(Math.max(0, full - triml - dur))}s`],
    [t("edit.props.kVer"), dash(dispClipVer(clip.ver))],
    [t("edit.props.kTrack"), `${trackLabelOf(kind)}（${kind}）`],
    [t("edit.props.kSeed"), dash(clip.seed ?? (seg ? seg.seed : null))],
    [t("edit.common.speed"), fmtSpeed(spd)],
    [t("edit.props.kEffDur"), `${fmtDur(dur / spd)}s`],
  ];
  const body = document.createElement("div");
  rows.forEach(([k, v]) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.cssText = "display:flex;gap:12px;align-items:center;margin-bottom:8px;font-size:13px";
    const key = document.createElement("span");
    key.className = "k";
    key.style.cssText = "color:var(--txt2);flex-shrink:0;width:72px"; // F71: --txt3 在 --panel 底上 3.54:1 不过 AA · 提一档
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "v";
    val.style.cssText = "color:var(--txt);flex:1;min-width:0;word-break:break-all";
    val.textContent = v;
    row.appendChild(key);
    row.appendChild(val);
    body.appendChild(row);
  });
  // S3-3 T5: 音量滑杆行（面板唯一可编辑控件）——拖动即写 clip.volume; 显示值沿用 .k/.v 惯例
  const vol = clampVolume(clipVolumeOf(clip));
  const vrow = document.createElement("div");
  vrow.className = "row";
  vrow.style.cssText = "display:flex;gap:12px;align-items:center;margin-bottom:8px;font-size:13px";
  vrow.innerHTML = '<span class="k" style="color:var(--txt2);flex-shrink:0;width:72px">' + t("edit.props.kVol") + '</span>' // F71: 同上提一档
    + `<input type="range" id="volRange" min="${VOL_MIN}" max="${VOL_MAX}" step="${VOL_STEP}" value="${vol}" style="flex:1;min-width:0;accent-color:var(--accent)">`
    + `<b class="v vol-cur num" style="flex-shrink:0;width:34px;text-align:right">${fmtVolume(vol)}</b>`;
  const range = vrow.querySelector("#volRange");
  // 桩环境无属性反射（真机 min/max/step 属性 ↔ property 同源）——双写使两种读法一致（同 T2 变速滑杆）
  range.min = String(VOL_MIN); range.max = String(VOL_MAX); range.step = String(VOL_STEP);
  const cur = vrow.querySelector(".vol-cur");
  range.addEventListener("input", () => {
    const v = clampVolume(range.value);
    cur.textContent = fmtVolume(v);
    // 写入前按剪贴键回查轨内当前节点：首次写入触发 renderAll 重建片段节点, 弹窗内旧引用已脱档
    //   —— resolveTrackClip 靠节点轨别解析, 脱档节点解析不到（连续拖动会只写一次）
    const live = S.root.querySelector(`[data-clip-key="${el.dataset.clipKey}"]`) || el;
    // 合并键 = 音量 + 片段身份：一次连续拖动的逐值写合成一个撤销单元（老板走查快批④ 第②件）
    writeClipL2(live, { volume: v }, "vol:" + live.dataset.clipKey); // 查不到（片段已不在轨内）由 writeClipL2 兜底提示
  });
  body.appendChild(vrow);
  // S3-3 T9: 淡化两输入行（淡入/淡出 · 0-5s 步进 0.1 · change 即写 clip.fadeIn/fadeOut）
  [[t("edit.props.fadeIn"), "fadeIn"], [t("edit.props.fadeOut"), "fadeOut"]].forEach(([label, field]) => {
    const cur = field === "fadeIn" ? clipFadeInOf(clip) : clipFadeOutOf(clip);
    const frow = document.createElement("div");
    frow.className = "row";
    frow.style.cssText = "display:flex;gap:12px;align-items:center;margin-bottom:8px;font-size:13px";
    frow.innerHTML = `<span class="k" style="color:var(--txt2);flex-shrink:0;width:72px">${label}</span>` // F71: 同上提一档
      + `<input type="number" id="${field}" min="${FADE_MIN}" max="${FADE_MAX}" step="${FADE_STEP}" value="${cur}" style="flex:1;min-width:0">`
      + `<b class="v num" style="flex-shrink:0;width:34px;text-align:right">${fmtFade(cur)}</b>`;
    const finp = frow.querySelector("#" + field);
    // 桩环境无属性反射（真机 min/max/step 属性 ↔ property 同源）——双写使两种读法一致（同音量滑杆）
    finp.min = String(FADE_MIN); finp.max = String(FADE_MAX); finp.step = String(FADE_STEP);
    const fcur = frow.querySelector(".v");
    finp.addEventListener("change", () => {
      const v = clampFade(finp.value);
      finp.value = fmtFade(v);
      fcur.textContent = fmtFade(v);
      // 写入前按剪贴键回查轨内当前节点：首次写入触发 renderAll 重建片段节点, 弹窗内旧引用已脱档
      //   —— resolveTrackClip 靠节点轨别解析, 脱档节点解析不到（同音量滑杆口径）
      const live = S.root.querySelector(`[data-clip-key="${el.dataset.clipKey}"]`) || el;
      writeClipL2(live, { [field]: v }); // 查不到（片段已不在轨内）由 writeClipL2 兜底提示
    });
    body.appendChild(frow);
  });
  openMbox(t("edit.props.cap", { name: clip.label }), t("edit.props.sub"), body, [[t("edit.common.close"), null]]);
}

// ---- 拖拽磁吸辅助 (v43 :4014-4071) ----
function dragGroupEls() {
  if (!_dragEl || !_dragEl.classList.contains("sel")) return [_dragEl];
  const grp = [..._dragEl.parentElement.querySelectorAll(".clip.sel, .clip-audio.sel")];
  return grp.length ? grp : [_dragEl];
}
// 数据片段 → clipKey（组成同 buildClipEl 的 dataset.clipKey :981/:835——altClips 条目恒带
//   cand/retired/rerun kind，按所属列表取前缀即同值；磁吸跨轨候选的拖拽组剔除用）
function dataClipKey(kind, c) {
  if (kind === "audio") return "audio:" + (c.id || c.label || "");
  if (kind === "alt") return "alt:" + (c.cid || c.segId || c.n);
  return "main:" + (c.segId || c.n);
}
function computeSnap(track, clientX) {
  const rect = track.getBoundingClientRect();
  const bl = parseFloat(getComputedStyle(track).borderLeftWidth) || 0;
  const grp = dragGroupEls();
  const cands = [...track.querySelectorAll(".clip, .clip-audio")]
    .filter((c) => !grp.includes(c))
    .map((c) => ({ left: c.offsetLeft, right: c.offsetLeft + c.offsetWidth }));
  // 批 G-a G-T7（F-4）: 跨轨双缘候选——三轨全部片段按轴域秒×pxs 取双缘（clipBodyStart 已含自身
  //   axisTriml+前缀累积，与轨内 DOM offsetLeft 同刻度——不读该轨 DOM 几何）；拖拽组自身仍剔除（键口径同渲染器）。
  const grpKeys = new Set(grp.map((el) => el.dataset.clipKey).filter(Boolean));
  const st = es();
  for (const [kind, list] of [["main", st.mainClips], ["alt", st.altClips], ["audio", st.audioClips]]) {
    (list || []).forEach((c, i) => {
      if (grpKeys.has(dataClipKey(kind, c))) return;
      const l = clipBodyStart(list, i) * S.pxs;
      cands.push({ left: l, right: l + effDurOf(c) * S.pxs });
    });
  }
  const ph = S.root.querySelector("#playhead");
  const phX = ph ? ph.offsetLeft : null;
  // 快批⑧: 吸附/插入序的参考位 = 拖动片段左缘（指针位 − 起手偏移）——抓中部拖到左缘贴边界即紧贴落位
  return snapPos(cands, clientX - _pointerOffX - rect.left - bl, phX).x;
}
function showSnapLine(track, x) {
  let line = track.querySelector(".snap-line");
  if (!line) { line = document.createElement("span"); line.className = "snap-line"; track.appendChild(line); }
  line.style.left = x + "px";
  line.style.display = "block";
}
function hideSnapLines() {
  document.querySelectorAll(".snap-line").forEach((el) => { el.style.display = "none"; });
}
function insertionIndex(track, x, groupEls) {
  // R53域重对齐-T4: 现行徽章退役（全块回归）——lane 成员=普通块，特批计数随徽章形态一并撤除
  const clips = [...track.querySelectorAll(".clip, .clip-audio")].filter((c) => !groupEls.includes(c));
  for (let i = 0; i < clips.length; i++) {
    if (x < clips[i].offsetLeft + clips[i].offsetWidth / 2) return i;
  }
  return clips.length;
}
// 批5-R53-TC（R-S2 同类适配）: lane 局部序插回——insertionIndex 是 **lane 内** 局部序（动态多轨后
//   一行只放同代际条目），直接对全量 altClips splice 会跨 lane 错位。本 helper 按 laneGen 把 moved
//   条目插到「lane 内第 insertAt 个未拖条目」之前（落点在 lane 尾则追加）；其余条目（含其他 lane）
//   相对序保持。moved 须已不在 altList（排序：走 movedSet 跳过；复制：copy 是新条目）。
function altLaneInsert(altList, moved, laneGen, insertAt, genMap) {
  const movedSet = new Set(moved.map((c) => c && c.cid));
  const out = [];
  let laneSeen = 0;
  let inserted = false;
  for (const c of altList) {
    if (movedSet.has(c && c.cid)) continue;
    const isLane = altGenOf(c, genMap) === laneGen;
    if (!inserted && isLane && laneSeen === insertAt) { out.push(...moved); inserted = true; }
    if (isLane) laneSeen++;
    out.push(c);
  }
  if (!inserted) out.push(...moved);
  return out;
}

// ---- 跨轨移动 (S3-3 T9b) ----
// 拖拽源身份（dragstart 记录; drop 时源轨 DOM 可能已重建, 不能只靠 _dragEl 反查）
function clipIdentity(el) {
  const kind = elTrackKind(el);
  if (kind === "audio") {
    const id = el.dataset.audioId; // F2: id 优先, 旧档无 id 兜底 label
    return { kind, key: id || el.textContent.trim(), idKey: !!id };
  }
  return { kind, key: el.dataset.segId || "", idKey: false };
}
// 按拖拽源身份在源轨列表内定位（-1 = 已不在轨内）
function identIndex(list, ident) {
  if (!Array.isArray(list) || !ident) return -1;
  if (ident.kind === "audio") return list.findIndex((c) => (ident.idKey ? c.id === ident.key : c.label === ident.key));
  return list.findIndex((c) => (c.segId || "") === ident.key);
}
// main↔audio 双向移动: 源轨列表移除所拖片段 + 目标轨列表按落点插入, 一次 writeEs 同写两列表
//   （S3-2 T4 splitAudioFromClip 同款: 单次落盘, 不留只写一半的中间态）。
//   形态换算（跨轨 = 该片段换挂目标轨, 内容/几何随行）:
//     main→audio: 音频轨身份 = 新 aud- id + audioLabelFor「段N·音」标签（segId 留档溯源·同 splitAV 口径）
//       + file 随行（批 F F-T1 音频条 file 四口全落）;
//     audio→main: floating segId（paste- 前缀——store 对账只保 paste-/new- 孤儿, 否则下次 mount 被删）,
//       标签随行（原型跨轨 = 元素带文本换轨, 不重编「段N」; n=max(存量)+1·段号铁律不随落点）。
  //   音量/淡化/变速随行（音频语义字段·读侧口径同 T5/T9 normalizeClipL2；speed 为批 F 遗留③
  //     补齐——音→主后变速此前丢失）; 视频专属 L2 字段（color/
  //     transition/keyframes 等）不入目标轨——跨轨即换语义, 目标轨按自身字段口径演化。
  function moveClipAcross(srcKind, dstKind, track, x) {
    const state = es();
    const srcList = (srcKind === "main" ? state.mainClips : state.audioClips) || [];
    const i = identIndex(srcList, _dragIdent);
    if (i < 0) { showToast("info", t("edit.dnd.moveGone")); return; }
    const clip = srcList[i];
    const rest = srcList.slice();
    rest.splice(i, 1);
    const dur = +clip.dur || 0;
    const l2 = normalizeClipL2(clip);
    const audioFields = { volume: l2.volume, fadeIn: l2.fadeIn, fadeOut: l2.fadeOut, speed: l2.speed };
  if (dstKind === "audio") {
    const dst = (state.audioClips || []).slice();
    dst.splice(Math.min(insertionIndex(track, x, []), dst.length), 0, {
      id: newCopyId("aud-"),
      label: audioLabelFor(clip),
      segId: clip.segId,
      dur,
      triml: +clip.triml || 0,
      full: clip.full != null ? +clip.full : dur,
      ...audioFields,
      ...(clip.file ? { file: clip.file } : {}), // 批 F F-T1: 跨轨移入条带源 file（四口全落）
    });
    writeEs({ mainClips: rest, audioClips: dst });
  } else {
    const dst = (state.mainClips || []).slice();
    const at = Math.min(insertionIndex(track, x, []), dst.length);
    // 批 C C-T3 ④N7 幽灵绿条：state 按可播源判（音频段无 file 落 empty——旧口径无条件 done
    //   = 时间线上顶一条点不动的绿条）。有 file 随行（跨轨换语义·产物跟片段走）。
    const playable = clip.file || "";
    dst.splice(at, 0, {
      segId: newCopyId("paste-"), // floating 身份（非 floating 前缀的孤儿会被 store 对账删）
      n: nextClipN(dst), // 段号铁律（批 D D-T2）: 新段 n=max(存量)+1·不随落点·存量 n/label 不重编
      label: clip.label || "片段",
      dur,
      triml: +clip.triml || 0,
      full: clip.full != null ? +clip.full : dur,
      ver: "原版",
      state: playable ? "done" : "empty",
      ...(playable ? { file: playable } : {}),
      ...audioFields,
    });
    writeEs({ mainClips: dst, audioClips: rest });
  }
  showToast("info", t("edit.dnd.movedTo", { label: TRACK_LABEL[dstKind] }));
}

// ---- Alt 复制拖放 (S3-2 T2) ----
// 语义: 起手按住 Alt → 拖放 = 复制该片段到落点, 原片段留在原位不动（不按 Alt = 移动, 行为不变）。
//   Alt 优先于 D013 整组拖动: 按 Alt 时即便命中整组场景, 也只复制所拖的那一个对象, 组内其余不动。
// 副本 = 新 clip 实体（新 id·同内容）: trim/版本/时长等字段随原片段复制。
//   segId 惯例: 正片副本走 store 既有复制惯例 paste- 前缀（reconcileMainClips 的 floating 段,
//     否则下次 mount 会被判真孤儿删掉——见 store.js FLOATING_SEG_PREFIX）;
//     备选轨副本沿用同 segId（候选版本身份 = 该段的一个版本, 与多版对比 openCompareModal 的口径一致）。
function newCopyId(prefix) { return prefix + Math.random().toString(36).slice(2, 10); }
function copySuffix(s) { return s ? s + " 副本" : "副本"; }
function dropCopy(track, clientX) {
  const state = es();
  const x = computeSnap(track, clientX);
  // 落点插入序: 复制语义下原片段不腾位, 故排除组为空（否则插入点会跳过原片段自身）
  const kind = elTrackKind(track);
  if (kind === "main") {
    const src = (state.mainClips || []).find((c) => c.segId === _dragEl.dataset.segId);
    if (!src) { showToast("info", t("edit.dnd.copyGone")); return; }
    const clips = (state.mainClips || []).slice();
    // 段号铁律（批 D D-T2）: 副本 n=max(存量)+1·label 非空保留（copySuffix 恒非空）·存量 n/label 不碰
    const copy = { ...src, segId: newCopyId("paste-"), label: copySuffix(src.label), n: nextClipN(clips) };
    clips.splice(Math.min(insertionIndex(track, x, []), clips.length), 0, copy);
    writeEs({ mainClips: clips });
  } else if (kind === "audio") {
    const isIdKey = !!_dragEl.dataset.audioId;
    const key = isIdKey ? _dragEl.dataset.audioId : _dragEl.textContent.trim();
    const src = (state.audioClips || []).find((c) => (isIdKey ? c.id : c.label) === key);
    if (!src) { showToast("info", t("edit.dnd.copyGone")); return; }
    const arr = (state.audioClips || []).slice();
    const copy = { ...src, id: newCopyId("aud-"), label: copySuffix(src.label) };
    arr.splice(Math.min(insertionIndex(track, x, []), arr.length), 0, copy);
    writeEs({ audioClips: arr });
  } else {
    // 备选轨: Alt 复制落点（普通拖入 = 同组内调序·见 drop 分发 alt 分支；跨向在下方拦截）
    //   批 B T1 ⑥: 按 cid 取源（旧口径按 segId find → 同段多候选恒取首条·F107 撞车）
    const cid = ensureAltCid(_dragEl);
    const list = es().altClips || [];
    const src = cid ? list.find((c) => c.cid === cid) : list.find((c) => c.segId === _dragEl.dataset.segId);
    if (!src) { showToast("info", t("edit.dnd.copyGone")); return; }
    const arr = list.slice();
    const genMapC = altGenMapOf(list);
    const copy = {
      ...src,
      cid: newAltCid(src.segId, cidsOf(list)), // 副本是新候选 → 另取新 cid, 不沿用源的
      kind: "cand", // 备选轨 = 新版本等审核（沿用载入历史写入的 cand 口径）
      label: copySuffix(src.label),
      ver: `${src.ver || "原版"} 副本`,
      // 批5-R53-TC（R1② 落轨链写条目 gen）: 副本落轨持久化其代际（源条代际解析·入组不因缺 gen 甩回兜底）
      gen: altGenOf(src, genMapC),
    };
    // 批5-R53-TC（R-S2 同类适配）: 落点插回按 lane 局部序（altLaneInsert）——不再对全量
    //   altClips 直接 splice lane 内序引（多 lane 下错位）；副本落源条所在代际 lane。
    writeEs({ altClips: altLaneInsert(arr, [copy], altGenOf(src, genMapC), insertionIndex(track, x, []), genMapC) });
  }
  showToast("info", t("edit.dnd.copiedTo", { label: trackLabelOf(kind) }));
}

// ---- 同链备选↔正片拖拽交换（批5-R53-TD·R-53 位阶=同链）----
//   位阶判定 = segId 相等（B5 消歧·老板原话「备选轨↔正片轨支持拖拽交换·仅限同位阶」·双向）:
//   落点近邻（insertionIndex 落点两侧·口径同备选轨内排序分支）含同段对象即同链。
//   alt→main: 所拖备选落点近邻正片 = 其同段 → 该候选上岗;
//   main→alt: 所拖正片落点近邻备选含同段 → 近邻候选上岗;
//   放行面（R53 回炉修复② + R53域重对齐-T3 撤退休拦截）: cand/rerun/retired 三系双向放行——
//   retired 视同普通块（存量兼容·呈报6），上岗 = 对调（decideCandidateByClip accept·file/ver 互换
//   槽位不动·kind 不变）。其余跨向（跨链/音频↔备选/备选跨行）维持拦截（通用跨段话术）。
function altMainSwapOrBlock(srcKind, dstKind, track, x) {
  const pickCand = (c) => (c && (c.kind === "cand" || c.kind === "rerun" || c.kind === "retired") ? c : null);
  let cand = null;
  if (isAltKind(srcKind) && dstKind === "main") {
    const dragSegId = _dragEl && _dragEl.dataset.segId;
    const mains = es().mainClips || [];
    const at = Math.min(insertionIndex(track, x, [_dragEl]), mains.length);
    // 同链判定纯读（dataset.segId）——ensureAltCid 有懒生成回写副作用，留到放行后（写被采纳落账吸收），
    //   拦截路径保持零写入（S3-3 T9b 零写入锁口径）
    const sameChain = [mains[at - 1], mains[at]].some((c) => c && dragSegId && c.segId === dragSegId);
    if (sameChain) {
      const cid = ensureAltCid(_dragEl);
      cand = pickCand(cid ? (es().altClips || []).find((c) => c.cid === cid) : null);
      if (cand && cand.segId === dragSegId) { void decideCandidateByClip(cand, "accept"); return; }
    }
  } else if (srcKind === "main" && isAltKind(dstKind)) {
    const mainClip = (es().mainClips || []).find((c) => c.segId === (_dragEl && _dragEl.dataset.segId));
    if (mainClip) {
      const laneGen = Number(String(dstKind).slice(4));
      const lane0 = (es().altClips || []).filter((c) => altGenOf(c, altGenMapOf(es().altClips || [])) === laneGen);
      const at0 = Math.max(0, Math.min(insertionIndex(track, x, [_dragEl]), lane0.length));
      // 同链判定纯读（segId）——懒补 cid 有静默回写副作用，留到放行后（写被采纳落账吸收），
      //   拦截路径保持零写入（S3-3 T9b 零写入锁口径）
      const sameChain = [lane0[at0], lane0[at0 - 1]].some((c) => pickCand(c) && c.segId === mainClip.segId);
      if (sameChain) {
        ensureAltCid(track.querySelector(".clip"));   // 老档候选无 cid → 整表懒补（读侧惯例·静默回写）
        const laneItems = (es().altClips || []).filter((c) => altGenOf(c, altGenMapOf(es().altClips || [])) === laneGen);
        const at = Math.max(0, Math.min(insertionIndex(track, x, [_dragEl]), laneItems.length));
        cand = [laneItems[at], laneItems[at - 1]].map(pickCand).find((c) => c && c.segId === mainClip.segId) || null;
        if (cand) { void decideCandidateByClip(cand, "accept"); return; }
      }
    }
  }
  // 跨链/跨行拦截（R-S3 通用话术·三系同口径——retired 特判话术随撤退休拦截退役）
  showToast("info", t("edit.dnd.sameChainOnly"));
}

// ---- track 级拖拽监听（B 审修正笔 F1：每挂载绑定——track DOM 随 renderRoute 重建，
//      单例绑定会让 TAB 往返后 drop 静默失效；document 级委托保持单例不变）----
function bindTrackDropListeners(track) {
  track.addEventListener("dragover", (e) => {
    if (!_dragEl) return;
    e.preventDefault();
    track.classList.add("drop-hint");
    const x = computeSnap(track, e.clientX);
    showSnapLine(track, x);
  });
  track.addEventListener("dragleave", () => { track.classList.remove("drop-hint"); hideSnapLines(); });
  track.addEventListener("drop", (e) => {
    e.preventDefault();
    track.classList.remove("drop-hint");
    hideSnapLines();
    if (!_dragEl) return;
    // S3-2 T1 锁定守卫: 源轨或目标轨锁定即拒（跨轨拖入不得绕过锁定）；_dragEl 留给 dragend 清
    //   S3-3 T9b: 源轨锁定以起手记录的源轨判（drop 时源片段 DOM 可能已重建）
    const srcKind = _dragIdent ? _dragIdent.kind : null;
    const dstKind = elTrackKind(track);
    if ((srcKind ? trackFlag(es().tracks, srcKind, "locked") : elTrackLocked(_dragEl)) || elTrackLocked(track)) {
      showToast("info", t("edit.common.trackLocked"));
      return;
    }
    // S3-2 T2: Alt 起手 = 复制语义 —— 原片段留原位, 副本按落点插入
    //   Alt 优先于整组（此处先于下方 D013 整组判定返回: 只复制所拖对象, 组内其余不动）
    //   S3-3 T9b 核对: 本分支早返回 → Alt+跨轨不触发下方跨轨移动（T2 复制语义原样保留）
    if (_dragAlt) { dropCopy(track, e.clientX); _dragAlt = false; _dragEl = null; _dragIdent = null; return; }
    const state = es();
    // 整组: 同轨选中集合按文档序 (D013); 跨轨混选只带走本轨
    const selEls = [...track.querySelectorAll(".clip.sel, .clip-audio.sel")];
    const grpEls = (selEls.length && selEls.some((el) => el === _dragEl)) ? selEls : [_dragEl];
    const x = computeSnap(track, e.clientX);
    if (dstKind === srcKind) {
      if (dstKind === "main") {
        const segIds = grpEls.map((el) => el.dataset.segId).filter(Boolean);
        const grp = segIds.map((id) => (state.mainClips || []).find((c) => c.segId === id)).filter(Boolean);
        const others = (state.mainClips || []).filter((c) => !segIds.includes(c.segId));
        const insertAt = insertionIndex(track, x, grpEls);
        const before = others[insertAt] || null;
        const out = [];
        let inserted = false;
        for (const c of others) {
          if (!inserted && before && c.segId === before.segId) { grp.forEach((g) => out.push(g)); inserted = true; }
          out.push(c);
        }
        if (!inserted) grp.forEach((g) => out.push(g));
        writeEs({ mainClips: out });
      } else if (dstKind === "audio") {
        // 音频轨拖动 = 重排 audioClips（F2：id 身份优先，旧档无 id 兜底 label）
        const isIdKey = grpEls.every((el) => !!el.dataset.audioId);
        const keys = grpEls.map((el) => isIdKey ? el.dataset.audioId : el.textContent.trim());
        const moved = (state.audioClips || []).filter((c) => isIdKey ? keys.includes(c.id) : keys.includes(c.label));
        const others = (state.audioClips || []).filter((c) => !moved.includes(c));
        const insertAt = insertionIndex(track, x, grpEls);
        const out = others.slice();
        out.splice(Math.min(insertAt, out.length), 0, ...moved);
        writeEs({ audioClips: out });
      } else {
        // 备选轨轨内拖拽 = altClips 组内重排（批 B T3 实装·形态照抄音频轨同轨重排）:
        //   按 cid 定位被拖项（批 B T1 身份键）→ 移除 → 按落点插回 + writeEs 持久化（组序 = 优先级）
        //   限同 sid 组内 —— 落点若落在别的段候选组的位置, 只给指引 + 零写入（组是版本集合·不跨组混排）
        //   批5-R53-TC（R-S2）: 动态多轨后 insertionIndex 是 **lane 内** 局部序 —— 近邻判定与插回
        //   位置一律按本 lane（同代际）条目局部化, 不得再索引全量 altClips 取近邻（跨 lane 错位）。
        const cids = grpEls.map((el) => ensureAltCid(el)).filter(Boolean);
        const altList = cids.length ? (es().altClips || []) : [];
        const moved = altList.filter((c) => cids.includes(c.cid));
        if (!moved.length) { showToast("info", t("edit.dnd.sortGone")); return; }
        const sid = moved[0].sid;
        const genMap = altGenMapOf(altList);
        const laneGen = altGenOf(moved[0], genMap);
        const laneOthers = altList.filter((c) => !cids.includes(c.cid) && altGenOf(c, genMap) === laneGen);
        const insertAt = insertionIndex(track, x, grpEls);
        const near = [laneOthers[insertAt - 1], laneOthers[insertAt]].filter(Boolean);
        if (near.some((c) => c.sid !== sid)) {
          showToast("info", t("edit.dnd.sameGroupOnly"));
          return;
        }
        const out = altLaneInsert(altList, moved, laneGen, insertAt, genMap);
        // 批5-R53-TC（R1① 随件）: 落笔时给缺 gen 条目冻结当前代际——组内排序不改 gen（headSeq
        //   兜底不再随平铺序漂移 → 整组跳轨）；新落轨条目已在落轨链带 gen·此处只补存量。
        const out2 = out.map((c) => (typeof c.gen === "number" && c.gen > 0) ? c : { ...c, gen: altGenOf(c, genMap) });
        writeEs({ altClips: out2 });
      }
      showToast("info", grpEls.length > 1 ? t("edit.dnd.groupMoved", { n: grpEls.length }) : t("edit.dnd.moved"));
    } else if (isAltKind(srcKind) || isAltKind(dstKind)) {
      // 批5-R53-TD（R-53 位阶=同链·B5/B6）: 同链（segId 相等）备选↔正片拖拽 = 隐式采纳上岗——
      //   复用 decideCandidateByClip 的 accept 落账链（禁裸数组搬移）; 其余跨向维持拦截（话术 R-S3 改写）。
      //   （S3-3 T9b 旧口径「备选轨跨向一律禁用」随 R-53 同位阶交换退役；alt↔alt 跨行仍拦。）
      altMainSwapOrBlock(srcKind, dstKind, track, x);
    } else {
      // S3-3 T9b: 余下方向即 main↔audio 跨轨移动（置换落点插入 + 源轨移除, 同一次落盘）
      moveClipAcross(srcKind, dstKind, track, x);
    }
    _dragEl = null;
    _dragIdent = null;
  });
}

// ============================================================================
// S1-3 T6: 历史载入 / 审片门弹窗 / 重跑弹窗 / 多版对比 / 导出成片 / 监控墙轮询
// 域逻辑 = core/history_ops.js·review.js·rerun.js·concat.js（T6a 改造自 legacy）
// ============================================================================

// ---- 通用小弹窗（mbox 形态）----
//   onClose (可选, S2-2 T5 新增): 关闭前回调, 返 false 则中止关闭 — 用于清理轮询等异步资源.
//   现有 6 个调用方均未传 onClose, 行为不变 (向后兼容).
function openMbox(title, subHtml, bodyNode, footBtns, onClose) {
  const wrap = document.createElement("div");
  wrap.className = "mbox-wrap";
  const box = document.createElement("div");
  box.className = "mbox";
  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);
  if (subHtml) {
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.innerHTML = subHtml;
    box.appendChild(sub);
  }
  if (bodyNode) box.appendChild(bodyNode);
  const foot = document.createElement("div");
  foot.className = "foot";
  (footBtns || []).forEach(([txt, fn, cls]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls || "ghostbtn";
    b.textContent = txt;
    b.addEventListener("click", () => { close(); if (fn) fn(); });
    foot.appendChild(b);
  });
  box.appendChild(foot);
  wrap.appendChild(box);
  function close() {
    if (onClose && onClose() === false) return;
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }
  // F72：点遮罩关·判 mousedown（按下点）非 click——click 落共同祖先会误判外点
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  return { wrap, box, close };
}

// ---- A. 历史载入弹窗（任务列表 → 载入映射时间线）----
//   S2-2 T5: 每行尾部加「后处理」按钮 → 打开后处理配置弹窗 (openPostfxDialog).
//   _histRefresh: 模块级刷新钩子 — postfx 完成时被 openPostfxDialog 调起,
//                  把历史列表按当前任务重拉, 徽标渲染归 T6 (本任务把钩子留出即可).
let _histRefresh = null;

export function openHistoryModal(opts = {}) {
  // 批 5-T3：参数化 —— 搜索跳转传 {limit:200, anchorTaskId}（与搜索源同域 + 锚定行落点）；
  //   缺省 limit 20 不变（剪辑 TAB「载入历史」原有口径）。
  const limit = (opts && opts.limit != null) ? opts.limit : 20;
  const anchorTaskId = (opts && opts.anchorTaskId) ? String(opts.anchorTaskId) : "";
  const projectId = S && S.projectId;   // 批A #13：本地索引按项目承载
  const body = document.createElement("div");
  body.textContent = t("edit.hist.loading");
  const { box, close } = openMbox(t("edit.hist.cap"), t("edit.hist.sub"), body, [[t("edit.common.close"), null]], () => {
    // onClose: 清掉刷新钩子, 防止外部在关闭后误调
    _histRefresh = null;
  });
  // 批A #13：弹窗读本地索引（data/runs-index.json）先行——离线可开（行+离线标注数据时点）；
  //   引擎成功应答后以引擎数据为准（本地慢到不再上屏）；引擎失败 → 本地行兜底。
  //   在线成功顺手回写索引（合并他项目键）。
  let engineAnswered = false;   // 引擎成功应答（此后本地索引不再上屏·引擎数据为准）
  let engineFailed = false;
  let engineErrMsg = "";
  let localTasks = null;        // null=本地索引未应答 · []=已应答但无索引
  let localSavedAt = "";
  const offlineNoteNode = () => {
    const note = document.createElement("div");
    note.style.cssText = "padding:6px 10px;margin-bottom:8px;background:#7a2f2f;color:#fff;font-size:12px;border-radius:6px";
    note.textContent = t("edit.hist.offlineNote", { tail: localSavedAt ? t("edit.hist.offlineTail", { ts: localSavedAt }) : "" });
    return note;
  };
  const renderLocalRows = () => {
    if (engineAnswered || !localTasks || !localTasks.length) return;
    renderHistRows(body, { ok: true, tasks: localTasks }, {});
    if (engineFailed) body.insertBefore(offlineNoteNode(), body.firstChild);
  };
  if (projectId) {
    loadRunsIndexTasks(projectId).then((local) => {
      localTasks = (local && Array.isArray(local.tasks)) ? local.tasks : [];
      localSavedAt = (local && local.savedAt) || "";
      if (engineAnswered) return;
      if (localTasks.length) { renderLocalRows(); return; }
      if (engineFailed) body.textContent = t("edit.hist.failNoLocal", { msg: engineErrMsg || t("edit.hist.engineNoAnswer") });
    }).catch(() => { localTasks = []; });
  }
  const onEngine = (r, anchorId) => {
    if (r.ok) {
      engineAnswered = true;
      if (projectId) void refreshRunsIndex(projectId, r.tasks).catch(() => { /* 索引回写失败静默 */ });
      renderHistRows(body, r, { anchorTaskId: anchorId });
      return;
    }
    engineFailed = true;
    engineErrMsg = (r.error && r.error.msg) || t("edit.hist.engineNoAnswer");
    if (localTasks === null) body.textContent = t("edit.hist.waitLocal");   // 本地未应答·等它
    else if (!localTasks.length) body.textContent = t("edit.hist.fail", { msg: engineErrMsg });
    else renderLocalRows();   // 本地行已在 → 补离线标注
  };
  function refresh() {
    body.textContent = t("edit.hist.loading");
    return listHistory({ limit }).then((r) => onEngine(r, ""));
  }
  _histRefresh = refresh;
  listHistory({ limit }).then((r) => onEngine(r, anchorTaskId));
}

// 抽出渲染逻辑（行级结构 + 后处理按钮 + 徽标）— postfx 完成时复用刷新
// S2-2 T6: 徽标 = composeBadge(historyBadge, statusResult=当前缓存, taskId) 四态; statusResult
//          来自 _postfxStatusCache（startMonPoll 3s 轮询缓存, 全局单例; 不为每行单跑请求）.
// S2-3 T3 (c4/D8): 行级「复制路径」+「目录」两入口 — 复制走 navigator.clipboard+降级 toast;
//                   目录走 GET /h3_batch/browse 简版弹窗. 入口数据源 run_dir 见
//                   resolveRunDir 注释 (core/open_dir.js).
// 批 5-T3：opts.anchorTaskId（搜索跳转落点）— 命中行 scrollIntoView + goto-flash 高亮 2s；
//           行不在本列表（任务较早）→ toast 降级提示.
const HIST_ANCHOR_FLASH_MS = 2000;
function renderHistRows(body, r, opts = {}) {
  if (!r.ok) { body.textContent = t("edit.hist.fail", { msg: (r.error && r.error.msg) || t("edit.hist.engineNoAnswer") }); return; }
  const tasks = r.tasks || [];
  if (!tasks.length) { body.textContent = t("edit.hist.empty"); return; }
  body.innerHTML = "";
  tasks.forEach((t) => {
    const row = document.createElement("div");
    row.className = "hist-row";
    row.dataset.taskId = t.task_id || "";  // 实时态覆盖用 (T6 轮询)
    const dt = t.time ? new Date(t.time * 1000).toLocaleString("zh-CN", { hour12: false }) : "";
    const stats = `<span>✓${t.success != null ? t.success : 0} ✕${t.failed != null ? t.failed : 0} / ${t.total != null ? t.total : 0}</span>`;
    const meta = `<span class="meta">${dt}</span>`;
    // 后处理按钮（行级·阻止冒泡以免误触「载入历史」）
    const btn = document.createElement("span");
    btn.className = "fchip";
    btn.textContent = t("edit.postfx.tag");
    btn.title = t("edit.hist.postfxTitle");
    btn.style.cssText = "margin-left:8px;cursor:pointer";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPostfxDialog(t.task_id);
    });
    // S2-3 T3 (c4/D8): 「复制路径」入口 — 复制 run_dir 到剪贴板, 失败降级 toast 直接显示路径.
    const copyBtn = document.createElement("span");
    copyBtn.className = "fchip";
    copyBtn.textContent = t("edit.hist.copyBtn");
    copyBtn.title = t("edit.hist.copyTitle");
    copyBtn.style.cssText = "margin-left:8px;cursor:pointer";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyRunPath(t.task_id);
    });
    // S2-3 T3 (c4/D8): 「目录」入口 — 弹窗列出 run_dir 文件清单 (browse 端点).
    const dirBtn = document.createElement("span");
    dirBtn.className = "fchip";
    dirBtn.textContent = t("edit.hist.dirBtn");
    dirBtn.title = t("edit.hist.dirTitle");
    dirBtn.style.cssText = "margin-left:8px;cursor:pointer";
    dirBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBrowseModal(t.task_id);
    });
    // S2-2 T6: 徽标 (historyBadge 字面量 + postfx_status 实时态, 见 composeBadge)
    const badge = document.createElement("span");
    badge.className = "postfx-badge";
    if (t.task_id) _histBadgeCache[t.task_id] = t.postfx_badge || null;
    applyBadge(badge, t.postfx_badge, t.task_id);
    const info = document.createElement("span");
    info.style.cssText = "display:flex;align-items:center;gap:8px;flex:1";
    info.innerHTML = `<b>${t.task_id}</b><span>${t.mode || ""}</span>${stats}${meta}`;
    row.appendChild(info);
    row.appendChild(badge);
    row.appendChild(btn);
    row.appendChild(copyBtn);
    row.appendChild(dirBtn);
    row.addEventListener("click", () => {
      const wrapEl = row.closest(".mbox-wrap");
      if (wrapEl && wrapEl.parentNode) wrapEl.parentNode.removeChild(wrapEl);
      _histRefresh = null; // 载入历史走的也是关闭路径, 清钩子
      applyHistory(t.task_id);
    });
    body.appendChild(row);
  });
  // 批 5-T3：搜索跳转锚定行（一次性）—— 滚动 + 高亮 2s；任务较早不在本列表 → 白话降级
  if (opts.anchorTaskId) {
    const rows = typeof body.querySelectorAll === "function" ? [...body.querySelectorAll(".hist-row")] : [];
    const hit = rows.find((n) => n && n.dataset && n.dataset.taskId === opts.anchorTaskId) || null;
    if (hit) {
      if (typeof hit.scrollIntoView === "function") hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.classList.add("goto-flash");
      setTimeout(() => hit.classList.remove("goto-flash"), HIST_ANCHOR_FLASH_MS);
    } else {
      showToast("info", t("edit.hist.anchorMiss"));
    }
  }
}

// 应用徽标 DOM (history badge + 当前 postfx_status 缓存 → composeBadge)
// statusResult 走 _postfxStatusCache (startMonPoll 3s 轮询写); 缺省 null → 仅字面量映射.

// ---- S2-3 T3 (c4/D8): 行级 run_dir 解析已迁 core/open_dir.js（R-31 收敛·taskId 维度包装+每任务缓存）----
// ---- S2-3 T3 (c4/D8): 「复制路径」入口 — navigator.clipboard.writeText + 降级 toast ----
//   成功 → toast "已复制产物路径"; 失败 (非安全上下文 / 权限拒绝) → toast 直接显示完整路径文本
//   (用户可手动复制 — D8 降级口径). deps.clipboard 注入便于单测桩模拟.
//   真机读回断言归节点里程碑 (剪贴板读回 = 跨权限边界, 测试环境不可达).
export async function copyRunPath(taskId, deps = {}) {
  const resolved = await resolveRunDir(taskId, { loader: deps.loader, skipCache: deps.skipCache });
  if (!resolved.ok) {
    showToast("error", resolved.error === "no_run_dir"
      ? t("edit.hist.noRunDir")
      : t("edit.hist.resolveFail", { err: resolved.error }));
    return { ok: false, error: resolved.error };
  }
  const runDir = resolved.runDir;
  // 注入口优先 (单测桩); 缺则走全局 navigator.clipboard
  const clipboardApi = deps.clipboard
    || (typeof navigator !== "undefined" && navigator.clipboard)
    || null;
  let mode = "clipboard";
  try {
    if (clipboardApi && typeof clipboardApi.writeText === "function") {
      await clipboardApi.writeText(runDir);
    } else {
      throw new Error("clipboard_unavailable");
    }
    showToast("success", t("edit.hist.copied"));
  } catch (_e) {
    // 降级: toast 直接显示完整路径文本 (8s 长显让用户手动复制)
    mode = "fallback";
    showToast("info", runDir, { timeout: 8000 });
  }
  return { ok: true, runDir, mode };
}

// ---- S2-3 T3 (c4/D8): 「目录」入口 — 弹窗列出 run_dir 文件清单 (browse 端点) ----
//   GET /h3_batch/browse?path=<run_dir> (exts 不传 = 全列). 复用 openMbox 惯例; 复用
//   resolveRunDir 取路径. 错误/空目录如实提示, 不静默.
//   deps.openMbox 注入便于单测桩 (默认走模块内 openMbox, 测时替身).
export async function openBrowseModal(taskId, deps = {}) {
  const mb = deps.openMbox || openMbox;
  const resolved = await resolveRunDir(taskId, { loader: deps.loader, skipCache: deps.skipCache });
  if (!resolved.ok) {
    showToast("error", resolved.error === "no_run_dir"
      ? t("edit.browse.noRunDir")
      : t("edit.hist.resolveFail", { err: resolved.error }));
    return { ok: false, error: resolved.error };
  }
  const runDir = resolved.runDir;
  const body = document.createElement("div");
  body.textContent = t("edit.browse.loading");
  mb(t("edit.browse.cap", { taskId }), t("edit.browse.path", { path: runDir }), body, [[t("edit.common.close"), null]]);
  const browse = deps.browse || browseDirectory;
  const r = await browse(runDir);
  if (!r.ok) {
    body.textContent = t("edit.browse.fail", { err: r.error || t("edit.hist.engineNoAnswer") });
    return { ok: false, error: r.error };
  }
  const entry = formatBrowseEntries(r.data);
  // 清空 loading, 渲染整理后形 (纯函数已就绪, 数据展示本身不接 DOM 渲染是分离)
  body.innerHTML = "";
  if (entry.error) {
    body.textContent = entry.error;
    return { ok: false, error: entry.error };
  }
  if (entry.empty) {
    body.textContent = t("edit.browse.empty");
    return { ok: true, runDir, empty: true };
  }
  // 渲染: 文件名分行 (按 browse_dir 返回顺序); 区分 dirs / files 两段
  if (entry.dirs.length) {
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:var(--txt3);margin-bottom:4px";
    head.textContent = t("edit.browse.dirs", { n: entry.dirs.length });
    body.appendChild(head);
    entry.dirs.forEach((n) => body.appendChild(makeLine(n, true)));
  }
  if (entry.files.length) {
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:var(--txt3);margin:6px 0 4px";
    head.textContent = t("edit.browse.files", { n: entry.files.length });
    body.appendChild(head);
    entry.files.forEach((n) => body.appendChild(makeLine(n, false)));
  }
  return { ok: true, runDir, dirs: entry.dirs.length, files: entry.files.length };
}

function makeLine(name, isDir) {
  const span = document.createElement("div");
  span.style.cssText = "font-size:12px;padding:2px 4px;font-family:monospace;color:var(--txt2)";
  span.textContent = (isDir ? "[D] " : "    ") + name;
  return span;
}

// (applyBadge 在原位保留, 不动)
function applyBadge(el, historyBadge, taskId) {
  const sr = _postfxStatusCache || null;
  const r = composeBadge({ historyBadge, statusResult: sr, taskId: taskId || "" });
  if (r.state === "none") {
    el.style.display = "none";
    el.textContent = "";
    el.className = "postfx-badge";
    return;
  }
  el.style.display = "";
  el.textContent = r.label;
  el.className = "postfx-badge " + (r.severity || "");
  el.title = r.label;
}

// 全局单例: startMonPoll 3s 轮询 postfx_status, 历史弹窗 / 监控墙两处复用 (避免每行单跑请求).
let _postfxStatusCache = null;

// ---- B. 历史行「后处理」弹窗（S2-2 T5·api.md #61 / __init__.py :4254）----
//
// 设计契约 (D5):
//   - 三选 kinds: 仅放大 / 仅插帧 / 放大+插帧 (存储 ["upscale"] / ["interp"] / ["upscale","interp"])
//   - 二选引擎: SeedVR2 · 正片 / RTX VSR · 快速 (存储 seedvr2 / rtxvsr)
//   - 提交 → POST postfx → 成功后轮询 postfx_status 两态:
//       running=true  → 「后处理中…」
//       running=false → 「完成」
//     引擎当前实现无 done/failed 字段, 不发明失败态轮询文案.
//   - 错误透传 (b9): 任何非 2xx → toast + 弹窗内显示引擎 message, 不重写不静默.
//   - N3 两路 400: stamped_already / 无可处理段 — 同上透传（stamped_already 在 X5 防重按段文件名戳
//     判定的当前真实链路不可达；契约缺口登记 S2-3 PRD 附录，弹窗/hint 不再断言与自动接力的因果关系）.
//   - 重复点保护: submitting 标志禁重复 POST.
//   - 关闭清理: onClose 清轮询定时器 (离开页面/关弹窗均清理, 不欠债).

let _postfxTimer = null;
// M6 真机门补（切页假态治理）: 现存 postfx 弹窗 close 登记——unmount 时顺带关闭。
//   缘由: postfx 轮询中切页 → unmount 清轮询定时器（S2-2 既有防泄漏）但弹窗挂 body 级存活，
//   回剪辑页残留「后处理中…」冻结假态（真机实证·右键弹窗同患）——对齐 monDrawer 卸载随手摘先例。
let _postfxModalClose = null;
function stopPostfxPoll() {
  if (_postfxTimer) {
    clearInterval(_postfxTimer);
    _postfxTimer = null;
  }
}

// M6-T1（B4 抬升）: enterPollingState 原为 openPostfxDialog 内嵌闭包——功能区新面板
//   openPostfxPick 与右键弹窗共用同一份轮询环（防两份实现漂移），抬升为模块级、
//   显式传 body/taskId（行为等价重构·右键入口/守卫链/hint/预选零改动）。
// 轮询态渲染 — 替换 body 内容为两态提示 (D5: 不发明失败态文案)
function enterPollingState(body, taskId, kindsList, engineChoice) {
  body.innerHTML = "";
  const status = document.createElement("div");
  status.style.cssText = "font-size:14px;line-height:1.6;padding:4px 0;color:var(--txt)";
  status.textContent = t("edit.postfx.running");
  body.appendChild(status);
  const meta = document.createElement("div");
  meta.style.cssText = "font-size:11px;color:var(--txt3);margin-top:6px;line-height:1.5";
  meta.textContent = t("edit.postfx.meta", { taskId, kinds: kindsList.join("+"), engine: engineChoice === "seedvr2" ? "SeedVR2" : "RTX VSR" });
  body.appendChild(meta);
  const startTs = Date.now();

  _postfxTimer = setInterval(async () => {
    const sr = await postfxStatus();
    if (!sr.ok) {
      // b9: 状态查询失败 — toast + 弹窗内同步, 关闭轮询
      const msg = (sr.error && sr.error.msg) || t("edit.postfx.statusFail");
      const code = (sr.error && sr.error.code) || "postfx_status_error";
      stopPostfxPoll();
      status.textContent = t("edit.postfx.statusFail");
      status.style.color = "#ffb4b4";
      meta.textContent = `[${code}] ${msg}`;
      showToast("error", t("edit.postfx.statusFailToast", { msg }));
      return;
    }
    if (sr.running) {
      const sec = Math.floor((Date.now() - startTs) / 1000);
      status.textContent = t("edit.postfx.runningSec", { sec });
      status.style.color = "var(--txt)";
      if (sr.current && Array.isArray(sr.current.kinds) && sr.current.kinds.length) {
        meta.textContent = t("edit.postfx.metaTotal", { taskId: sr.current.taskId || taskId, kinds: sr.current.kinds.join("+"), engine: engineChoice === "seedvr2" ? "SeedVR2" : "RTX VSR", total: sr.current.total });
      }
    } else {
      stopPostfxPoll();
      status.textContent = t("edit.postfx.done");
      status.style.color = "var(--txt)";
      meta.textContent = t("edit.postfx.doneMeta", { taskId, sec: Math.floor((Date.now() - startTs) / 1000) });
      // 刷新历史列表（徽标渲染归 T6; 本任务只把钩子调起）
      if (typeof _histRefresh === "function") {
        try { _histRefresh(); } catch (_e) { /* 不阻塞弹窗 */ }
      }
    }
  }, 3000);
}

// ============================================================================
// M6b-T3 R-50（方案-批M6b §三）: 两处高级区共用构建 buildPostfxAdvanced
//   「输出」组（放大倍数 / 目标宽×高 / 目标帧率）+「长片分段阈值」组（duration_s/frame_count 原样）。
//   两入口同用一份：openPostfxPick（功能区·剪辑区超分/插帧钮）· openPostfxDialog（右键/历史行）。
//   联动: 填倍数→宽高=源×倍数（改倍数覆盖宽高）；倍数清空·只改宽(或高)→另一维=源比例换算·偶数对齐。
//   基准源分辨率通道钉死（方案 §三.4 审建议 8）: /h3_batch/video 代理 + video 元素读
//   videoWidth/videoHeight（与 probeVideoDuration 同底座 probeVideoMeta——raw 路径浏览器不可读）。
//   源帧率通道: /gui13-export op=probe（HTML video 无 fps API·GUI 既有同款调用 = 导出窗开窗探首段）。
//   读不到基准（引擎死·常态分支）→ 自动填跳过（宽高留 placeholder）·倍数与帧率仍可单独填发·不阻断。
// ============================================================================

// 放大倍数校验分档（引擎 __init__.py 端点校验同档·GUI 侧白话前置拦截为第二道）
const POSTFX_SCALE_TIER = {
  rtxvsr: { min: 1, max: 4, lo: "[1.0, 4.0]", loOpen: false },   // RTX scale FLOAT[1.0,4.0]
  seedvr2: { min: 0, max: 8, lo: "(0, 8]", loOpen: true },        // SeedVR2 (0,8] 短边换算
};
// 基准源分辨率探测——同 probeVideoMeta 通道（/h3_batch/video 代理），仅取宽高（duration 不参与本联动）
function probeVideoDims(videoPath, timeoutMs = 3000) {
  return probeVideoMeta(videoPath,
    (v) => (v.videoWidth > 0 && v.videoHeight > 0 ? { w: v.videoWidth, h: v.videoHeight } : null),
    timeoutMs);
}
// #32 修复（2026-10-20）：单测注入缝——单测环境 video 永不 loadedmetadata（edit.test.mjs:361 自述）
let _testPostfxProbeOverride = null;
export function _test_setPostfxProbe(fn) { _testPostfxProbeOverride = fn || null; }

// 基准段选取: 仅选中 → 选中段产物文件; 全部 → 第一成功段（带 sid+file 的已载入段=可处理段）
//   n = 目标列表内序号（1 起）·多段异尺寸时供「按段 N 基准」小字
function postfxBaseTargets(scope) {
  const clips = (es().mainClips || []).filter((c) => c && resolveEngineSid(c) && c.file);
  const sids = scope && scope.sids;
  const list = (scope && scope.onlySelected && sids && sids.length)
    ? clips.filter((c) => sids.indexOf(resolveEngineSid(c)) >= 0)
    : clips;
  return list.map((c, i) => ({ file: String(c.file), n: i + 1 }));
}

// 两处高级区共用构建（body 内挂 折叠开关 + advBox·展开时懒挂全部 input·默认折叠零 input）
//   ctx = { engine: () => "seedvr2"|"rtxvsr", scope: () => ({onlySelected, sids}),
//           initial?: {scale,w,h,fps}（T5 #31b 重跑弹窗后期区按全局回填·其余入口不传=零变化）,
//           omitSegThreshold?: bool（T5 #31b 补链编排不携带 seg_threshold·重跑弹窗省此组） }
//   返回 { parse(), refreshHints(), clearUpscaleInputs(), clearInterpInput() }
//   ——clear 两柄供开关关闭时清参（setup 参数页「取消勾选清值」同款语义·防脏值拦提交）
function buildPostfxAdvanced(body, ctx) {
  const advToggle = document.createElement("span");
  advToggle.className = "fchip";
  advToggle.style.cssText = "cursor:pointer";
  advToggle.textContent = t("edit.postfx.advToggle");
  advToggle.setAttribute("data-postfx-adv-toggle", "1");
  body.appendChild(advToggle);

  const advBox = document.createElement("div");
  advBox.style.cssText = "display:none;margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.04);border-radius:6px";
  body.appendChild(advBox);

  function subtitle(text) {
    const d = document.createElement("div");
    d.style.cssText = "font-size:12px;color:var(--txt);margin:2px 0 6px;font-weight:600";
    d.textContent = text;
    return d;
  }
  function hint() {
    const d = document.createElement("div");
    d.style.cssText = "font-size:11px;color:var(--txt3);margin:2px 0 6px;line-height:1.5";
    return d;
  }
  function numInput(id, placeholder, step) {
    const input = document.createElement("input");
    input.setAttribute("id", id);
    input.type = "number";
    input.step = step;
    input.placeholder = placeholder;
    input.style.cssText = "flex:1;min-width:0;padding:4px;background:var(--bg2);color:var(--txt);border:1px solid var(--bd);border-radius:4px";
    return input;
  }
  function numRow(label, id, placeholder, step) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";
    const lb = document.createElement("span");
    lb.style.cssText = "font-size:12px;color:var(--txt2);width:80px;flex-shrink:0";
    lb.textContent = label;
    row.appendChild(lb);
    const input = numInput(id, placeholder, step);
    row.appendChild(input);
    return { row, input };
  }

  // ---- 「输出」组 ----
  const scaleRow = numRow(t("edit.postfx.scaleLabel"), "postfx-up-scale", t("edit.postfx.phEngineDefault"), "0.1");
  const whRow = document.createElement("div");
  whRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";
  const whLabel = document.createElement("span");
  whLabel.style.cssText = "font-size:12px;color:var(--txt2);width:80px;flex-shrink:0";
  whLabel.textContent = t("edit.postfx.targetRes");
  whRow.appendChild(whLabel);
  const wInput = numInput("postfx-up-w", t("edit.postfx.phAutoByScale"), "1");
  const whX = document.createElement("span");
  whX.style.cssText = "font-size:12px;color:var(--txt3)";
  whX.textContent = "×";
  const hInput = numInput("postfx-up-h", t("edit.postfx.phAutoByScale"), "1");
  whRow.appendChild(wInput);
  whRow.appendChild(whX);
  whRow.appendChild(hInput);
  const fpsRow = numRow(t("edit.postfx.fpsLabel"), "postfx-interp-fps", t("edit.postfx.phFpsDefault"), "1");
  const outHint = hint();
  const fpsHint = hint();

  // ---- 「长片分段阈值」组（原样·仅归位子标题）----
  const durRow = numRow(t("edit.postfx.durLabel"), "postfx-seg-dur", t("edit.postfx.phAuto"), "1");
  durRow.input.min = "0";
  const fcRow = numRow(t("edit.postfx.fcLabel"), "postfx-seg-fc", t("edit.postfx.phAuto"), "1");
  fcRow.input.min = "0";
  const advNote = hint();
  advNote.textContent = t("edit.postfx.advNote");

  const scaleInput = scaleRow.input;
  const fpsInput = fpsRow.input;
  const durInput = durRow.input;
  const fcInput = fcRow.input;

  // T5 #31b：初值预填（重跑弹窗后期区按全局六键回填·空值跳过=留空语义；懒挂不碍——
  //   input 节点创建即持值·parse 读闭包引用与是否已挂 DOM 无关）
  const pfInitial = ctx.initial && typeof ctx.initial === "object" ? ctx.initial : null;
  if (pfInitial) {
    for (const [inp, v] of [[scaleInput, pfInitial.scale], [wInput, pfInitial.w], [hInput, pfInitial.h], [fpsInput, pfInitial.fps]]) {
      if (v != null && String(v).trim() !== "") inp.value = String(v);
    }
  }

  // 基准态: null = 读不到/未探（引擎死为常态）·h.srcFps=0 = 源帧率未读到（预告不显）
  let base = null;
  let probed = false;
  function baseDims() { return base && base.w > 0 && base.h > 0 ? base : null; }

  // ---- #32 单驱动源联动（与参数页 setup.js buildPostProcGroup 同一状态机 postfx_linkage.js·两页同规则）----
  //   input 事件 → postfxLinkStep（写值 + disabled/title/placeholder 门控）·基准读不到=无基准分支
  //   （倍数驱动只锁不填·宽高驱动不锁可手填——A7 引擎死不阻断填写提交不变）。
  //   初值治理：预填含倍数 → 宽/高即只读（与编排层倍数优先同源·重开恢复锁定态）；
  //   基准迟到补算：驱动在位=基准到即重驱动补算·无驱动不追补（#32 修复 2026-10-20·旧「探到不回溯」口径作废）。
  let _link = postfxLinkInitialState();
  const _POSTFX_FIELDS = [
    ["scale", scaleInput, t("edit.postfx.phEngineDefault")],
    ["w", wInput, t("edit.postfx.phAutoByScale")],
    ["h", hInput, t("edit.postfx.phAutoByScale")],
  ];
  function applyGate(inp, gate, staticPh) {
    inp.disabled = gate.disabled;
    inp.setAttribute("title", gate.title);
    inp.setAttribute("placeholder", gate.placeholder || staticPh);
  }
  function applyGates(gates) {
    for (const [f, inp, ph] of _POSTFX_FIELDS) applyGate(inp, gates[f], ph);
  }
  {
    const init = postfxLinkInitGates(pfInitial ? { scale: pfInitial.scale, w: pfInitial.w, h: pfInitial.h } : null);
    _link = init.state;
    applyGates(init.gates);
  }
  function govern(field) {
    const ent = _POSTFX_FIELDS.find((x) => x[0] === field);
    const r = postfxLinkStep(_link, { field, raw: String(ent[1].value || "") }, baseDims());
    _link = r.state;
    for (const [f, inp, ph] of _POSTFX_FIELDS) {
      if (r.writes[f] != null) inp.value = r.writes[f];   // 直写不派发 input——防重入覆盖手填（既有口径）
      applyGate(inp, r.gates[f], ph);
    }
    refreshHints();
  }

  function refreshHints() {
    // 帧率预告（引擎侧 M=round(target_fps/源fps)·实际输出=M×源fps·源帧率读不到则不显·不编造）
    const src = base ? base.srcFps : 0;
    const f = Number((fpsInput.value || "").trim());
    let fpsNote = "";
    if (src > 0 && Number.isFinite(f) && f > 0) {
      const m = Math.max(1, Math.round(f / src));
      fpsNote = t("edit.postfx.fpsNote", { src, m, out: Math.round(m * src) });
    }
    fpsHint.textContent = fpsNote;
    const b = baseDims();
    const targetOn = (wInput.value || "").trim() !== "" || (hInput.value || "").trim() !== "";
    outHint.textContent = (!b || !b.hetero) ? ""
      : t("edit.postfx.baseSeg", { seg: b.segNo }) + (ctx.engine() === "rtxvsr" && targetOn
        ? t("edit.postfx.baseSegWarn") : "");
  }

  // 首次展开时探基准（懒探·默认折叠态零网络零 video·与既有默认行为零差异）
  function armProbe() {
    if (probed) return;
    probed = true;
    const targets = postfxBaseTargets(ctx.scope());
    if (!targets.length) return;
    const head = targets[0];
    (_testPostfxProbeOverride || probeVideoDims)(head.file).then((d) => {
      if (!d) return;                       // 基准读不到 → 自动填跳过·不阻断填写
      base = { w: d.w, h: d.h, segNo: head.n, srcFps: 0, hetero: false };
      // 源帧率 + 多段异尺寸（一次 probe 拿全部段·video 元素无 fps 亦无批量宽高）
      return gui13ExportPost({ op: "probe", files: targets.map((t) => t.file) }).then((r) => {
        const files = (r && r.ok && r.data && Array.isArray(r.data.files)) ? r.data.files : [];
        if (!files.length) return;
        const f0 = files[0] || {};
        base.srcFps = Number(f0.fps) > 0 ? Number(f0.fps) : 0;
        base.hetero = targets.length > 1 && files.some((f) => f && f.w > 0 && f.h > 0
          && Math.abs(f.w * base.h - f.h * base.w) > Math.max(1, base.w * base.h * 0.001));
      });
    }).then(() => { refreshHints(); if (_link.driver) govern(_link.driver); });   // 驱动在位=基准到即补算·无驱动不追补·#32 修复 2026-10-20 口径
  }

  // R56R57 T1 Q14②：倍数失焦一位小数归一（显示精度口径；留空=target 语义不动·非数字交 parse 白话拒；
  // 归一不派发 input——数值不变时不重算，数值有移时引擎侧以倍数为准、宽高联动值不回写覆盖手填；只读态用户不可达）
  scaleInput.addEventListener("blur", () => {
    const raw = String(scaleInput.value || "").trim();
    if (raw === "") return;
    const n = Number(raw);
    if (Number.isFinite(n)) scaleInput.value = n.toFixed(1);
  });
  // #32：联动入口统一走状态机（写值+门控）·帧率独立（超分与插帧互不影响）
  scaleInput.addEventListener("input", () => govern("scale"));
  wInput.addEventListener("input", () => govern("w"));
  hInput.addEventListener("input", () => govern("h"));
  fpsInput.addEventListener("input", refreshHints);

  // 折叠状态变量 (DOM stub 的 style.display 未解析, 用闭包变量钉死状态)
  let _advExpanded = false;
  advToggle.addEventListener("click", () => {
    if (!_advExpanded) {
      _advExpanded = true;
      advBox.style.display = "block";
      if (!advBox.contains(scaleInput)) {
        advBox.appendChild(subtitle(t("edit.postfx.subOutput")));
        advBox.appendChild(scaleRow.row);
        advBox.appendChild(whRow);
        advBox.appendChild(fpsRow.row);
        advBox.appendChild(outHint);
        advBox.appendChild(fpsHint);
        // T5 #31b：重跑弹窗后期区不带「长片分段阈值」组——补链编排不携带 seg_threshold
        if (!ctx.omitSegThreshold) {
          advBox.appendChild(subtitle(t("edit.postfx.subSegThreshold")));
          advBox.appendChild(durRow.row);
          advBox.appendChild(fcRow.row);
          advBox.appendChild(advNote);
        }
      }
      armProbe();
      advToggle.textContent = t("edit.postfx.advToggleOpen");
    } else {
      _advExpanded = false;
      advBox.style.display = "none";
      advToggle.textContent = t("edit.postfx.advToggle");
    }
  });

  // 提交前白话校验（留空=不传该键·引擎 400 为第二道）——两入口共用一份
  function parse() {
    const segThreshold = {};
    const durRaw = (durInput.value || "").trim();
    if (durRaw !== "") {
      const n = Number(durRaw);
      if (!Number.isFinite(n)) return { error: t("edit.postfx.errDurNum", { raw: durRaw }) };
      segThreshold.duration_s = n;
    }
    const fcRaw = (fcInput.value || "").trim();
    if (fcRaw !== "") {
      const n = Number(fcRaw);
      if (!Number.isFinite(n)) return { error: t("edit.postfx.errFcNum", { raw: fcRaw }) };
      segThreshold.frame_count = n;
    }

    // 超分: 倍数优先（联动会把宽高自动覆盖成源×倍数·两者同填时以倍数为准），
    //       倍数空 → 走 target 模式（宽高成对）
    let upscaleParams = null;
    const scaleRaw = (scaleInput.value || "").trim();
    if (scaleRaw !== "") {
      const n = Number(scaleRaw);
      if (!Number.isFinite(n)) return { error: t("edit.postfx.errScaleNum", { raw: scaleRaw }) };
      const tier = POSTFX_SCALE_TIER[ctx.engine()] || POSTFX_SCALE_TIER.seedvr2;
      if ((tier.loOpen ? n <= tier.min : n < tier.min) || n > tier.max) {
        return { error: t("edit.postfx.errScaleTier", { tier: tier.lo, raw: scaleRaw }) };
      }
      upscaleParams = { mode: "scale", scale: n };
    } else {
      const wRaw = (wInput.value || "").trim();
      const hRaw = (hInput.value || "").trim();
      if ((wRaw === "") !== (hRaw === "")) {
        return { error: t("edit.postfx.errWhPair") };
      }
      if (wRaw !== "") {
        const w = Number(wRaw);
        const h = Number(hRaw);
        if (!Number.isFinite(w) || !Number.isFinite(h)) {
          return { error: t("edit.postfx.errWhNum", { w: wRaw, h: hRaw }) };
        }
        if (w % 2 !== 0 || h % 2 !== 0) {
          return { error: t("edit.postfx.errWhEven", { w: wRaw, h: hRaw }) };
        }
        upscaleParams = { mode: "target", width: w, height: h };
      }
    }

    // 插帧: 帧率独立（不参与分辨率联动）·源帧率读不到 → 跳过「须高于源」这条
    let interpParams = null;
    const fpsRaw = (fpsInput.value || "").trim();
    if (fpsRaw !== "") {
      const n = Number(fpsRaw);
      if (!Number.isFinite(n)) return { error: t("edit.postfx.errFpsNum", { raw: fpsRaw }) };
      const src = base ? base.srcFps : 0;
      if (src > 0 && n <= src) return { error: t("edit.postfx.errFpsSrc", { src, n }) };
      interpParams = { target_fps: n };
    }

    return {
      segThreshold: Object.keys(segThreshold).length ? segThreshold : undefined,
      upscaleParams,
      interpParams,
    };
  }

  return {
    parse, refreshHints,
    // T5 #31b：开关关闭清参（超分=倍数+宽高·插帧=帧率）——与 setup 参数页取消勾选清值同语义
    clearUpscaleInputs() {
      scaleInput.value = ""; wInput.value = ""; hInput.value = "";
      _link = postfxLinkInitialState();                       // #32：清参同时复位联动（全解锁）
      applyGates(postfxLinkGates(_link, null));
    },
    clearInterpInput() { fpsInput.value = ""; },
  };
}

// ============================================================================
// M6-T1 R-45（方案-批M6 §一）: 功能区超分/插帧全参数面板——「超分/插帧」选态哑弹
//   接上真执行链（演化非回归·批F F-T2 指引 toast 止损文案随真执行链退役）。
//   面板 = 作用域组（复用 buildScopeGroup·确认时读 chips .on）+ 类型三选 + 引擎二选 +
//   高级折叠（M6b-T3 R-50 起 =「输出」组+「长片分段阈值」组·两入口共用 buildPostfxAdvanced）。
//   载荷驼峰入参契约 postfx.js:54-66
//   （postfxRun 内部转 task_id/engine_choice/seg_threshold 线上格式）。
//   守卫序照抄右键链 openSegPostfxDialog: loadedTaskId 缺 → toast（引文与右键守卫逐字一致）；
//   作用域=仅选中 → selAll() 收集 sid（resolveEngineSid·缺 sid 逐段报段号·全缺拦截）；
//   作用域=全部 → sids 不发（postfx.js:41「缺省=全 success 段」·零成功段走引擎 400 中文透传）。
//   单例义务两条（B5）: 开启先 stopPostfxPoll（防右键轮询中开面板→旧 interval 泄漏）；
//   onClose 挂 stopPostfxPoll（防关面板残留轮询）。
// ============================================================================

// 全局引擎键读取（T4 #31）：postfx_engine 未设/非串/空 → 兜底 seedvr2（与编排装配同口径）。
//   段卡 超分模式 存量值休眠不读（「勾选=该段定制」口径反转·2026-10-18）。
function postfxGlobalEngine(proj) {
  const gp = proj && proj.globalParams && typeof proj.globalParams === "object" ? proj.globalParams : {};
  const e = typeof gp.postfx_engine === "string" ? gp.postfx_engine.trim() : "";
  return e || "seedvr2";
}

// S2-2 T2+T11: 段级右键入口 — presetKinds/presetEngine/presetSids 可预选.
//   T5 历史行调用: openPostfxDialog(taskId) — 缺省走原有三选/both/无 sids 路径 (向后兼容).
//   段级右键调用: openPostfxDialog(taskId, {presetKinds:["upscale"], presetEngine:"rtxvsr", presetSids:["shot_001"]})
//   presetKinds = ["upscale","interp"] → 三选联动回 "both"; presetSids 写入 body.sids 单段定向.
export function openPostfxDialog(taskId, preset) {
  // 关闭任何遗留轮询 (单例, 全局唯一正在跑的 postfx 弹窗)
  stopPostfxPoll();

  const presetKinds = (preset && Array.isArray(preset.presetKinds)) ? preset.presetKinds : null;
  const presetEngine = (preset && typeof preset.presetEngine === "string") ? preset.presetEngine : null;
  const presetSids = (preset && Array.isArray(preset.presetSids)) ? preset.presetSids : null;
  // kinds 预选→三选键: ["upscale","interp"]→"both", 单选→对应键
  const initialKind = presetKinds
    ? (presetKinds.length >= 2 ? "both" : (presetKinds[0] === "interp" ? "interp" : "upscale"))
    : "both";
  const initialEngine = (presetEngine === "rtxvsr" || presetEngine === "seedvr2")
    ? presetEngine
    : "seedvr2";

  const body = document.createElement("div");
  body.style.cssText = "min-width:300px";

  // ---- 类型三选 ----
  const kindRow = document.createElement("div");
  kindRow.style.cssText = "display:flex;gap:8px;margin-bottom:10px;align-items:center";
  const kindLabel = document.createElement("span");
  kindLabel.style.cssText = "font-size:12px;color:var(--txt2);width:60px;flex-shrink:0";
  kindLabel.textContent = t("edit.common.type");
  kindRow.appendChild(kindLabel);
  // 存储键: "upscale" | "interp" | "both" (both 展开为 ["upscale","interp"])
  const kindOptions = [
    ["upscale", t("edit.postfx.upscaleOnly")],
    ["interp", t("edit.postfx.interpOnly")],
    ["both", t("edit.postfx.both")],
  ];
  let selectedKind = initialKind;
  const kindChips = {};
  kindOptions.forEach(([k, label]) => {
    const c = document.createElement("span");
    c.className = "fchip" + (k === selectedKind ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => {
      selectedKind = k;
      Object.entries(kindChips).forEach(([kk, v]) => v.classList.toggle("on", kk === k));
    });
    kindChips[k] = c;
    kindRow.appendChild(c);
  });
  body.appendChild(kindRow);

  // ---- 引擎二选 ----
  const engineRow = document.createElement("div");
  engineRow.style.cssText = "display:flex;gap:8px;margin-bottom:10px;align-items:center";
  const engineLabel = document.createElement("span");
  engineLabel.style.cssText = "font-size:12px;color:var(--txt2);width:60px;flex-shrink:0";
  engineLabel.textContent = t("edit.postfx.engineLabel");
  engineRow.appendChild(engineLabel);
  const engineOptions = [
    ["seedvr2", t("edit.postfx.engSeed")],
    ["rtxvsr", t("edit.postfx.engRtx")],
  ];
  let selectedEngine = initialEngine;
  const engineChips = {};
  engineOptions.forEach(([e, label]) => {
    const c = document.createElement("span");
    c.className = "fchip" + (e === selectedEngine ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => {
      selectedEngine = e;
      Object.entries(engineChips).forEach(([ee, v]) => v.classList.toggle("on", ee === e));
      adv.refreshHints();   // 引擎档切换影响 RTX target 不保比警示
    });
    engineChips[e] = c;
    engineRow.appendChild(c);
  });
  body.appendChild(engineRow);

  // ---- 提示 ----
  // S2-2 FIX-2 双审修正笔：删除「stamped_already = 自动接力过」断言。X5 防重按段文件名戳判定
  // （__init__.py:4016），自动接力与手动 postfx 均只 patch manifest._postfx、不回写段文件名 →
  // 「已自动接力过再手动」实测返回 200 并产生计数器去重副本（_x2_00002_…），400 stamped_already
  // 在真实链路不可达。引擎其他 400/409（如无可处理段、postfx_busy）将如实透传至 toast + 弹窗。
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;color:var(--txt3);margin-bottom:10px;line-height:1.5";
  const baseHint = t("edit.postfx.baseHint");
  hint.textContent = (presetSids && presetSids.length)
    ? t("edit.postfx.singleSegHint", { sids: presetSids.join(", "), hint: baseHint })
    : baseHint;
  body.appendChild(hint);

  // ---- 高级区（M6b-T3 R-50）: 「输出」组 + 「长片分段阈值」组·与功能区面板共用一份构建 ----
  //   输入元素懒挂载: 默认不挂 DOM, 折叠开关首次点击时挂入 advBox;
  //   countInputs(doc) 此时返回 0 (默认折叠·无 input 节点);
  //   提交时读闭包引用（无论是否挂载 仍可读）.
  const adv = buildPostfxAdvanced(body, {
    engine: () => selectedEngine,
    // 单段定向（右键入口 presetSids）→ 基准=该段；其余（历史行/全部）→ 第一成功段
    scope: () => ({ onlySelected: !!(presetSids && presetSids.length), sids: presetSids }),
  });

  // ---- 主操作按钮（放在 body 内·不复用 foot·避免 openMbox 自动关闭） ----
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "prim";
  submitBtn.style.cssText = "margin-top:6px";
  submitBtn.textContent = t("edit.postfx.startBtn");
  body.appendChild(submitBtn);

  // ---- 错误显示区（弹窗内显示, 与 toast 同步; b9 不静默） ----
  const errBox = document.createElement("div");
  errBox.style.cssText = "display:none;margin-top:8px;padding:8px;background:#3a1f1f;border:1px solid #6a2a2a;border-radius:8px;color:#ffd7d7;font-size:12px;line-height:1.5;white-space:pre-wrap";
  body.appendChild(errBox);

  let submitting = false;

  submitBtn.addEventListener("click", async () => {
    if (submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("edit.postfx.submitting");
    errBox.style.display = "none";
    errBox.textContent = "";

    // 高级区字段解析（M6b-T3 R-50 两入口共用一份）: 留空=不传该键; 非数字字符被浏览器数字输入
    // 约束丢弃→按留空=自动 (引擎 400 为拒绝通道·S2-4 修正笔②口径); 白话拦截回灌 errBox+toast
    // 引擎契约 postfx_engine.py:407-424: 合法=dict {duration_s?, frame_count?}, 值数字
    const advParsed = adv.parse();
    if (advParsed.error) {
      submitBtn.disabled = false;
      submitBtn.textContent = t("edit.postfx.startBtn");
      submitting = false;
      errBox.style.display = "block";
      errBox.textContent = advParsed.error;
      showToast("error", t("edit.postfx.submitFailToast", { msg: advParsed.error }));
      return;
    }

    const kindsList = selectedKind === "both" ? ["upscale", "interp"] : [selectedKind];
    const r = await postfxRun({
      taskId,
      kinds: kindsList,
      engineChoice: selectedEngine,
      sids: presetSids && presetSids.length ? presetSids : null,
      segThreshold: advParsed.segThreshold,
      upscaleParams: advParsed.upscaleParams,
      interpParams: advParsed.interpParams,
    });
    if (!r.ok) {
      // b9: 非 2xx → toast + 弹窗内同步显示引擎 message, 原样不改写
      const msg = (r.error && r.error.msg) || t("edit.hist.engineNoAnswer");
      const code = (r.error && r.error.code) || "postfx_error";
      submitBtn.disabled = false;
      submitBtn.textContent = t("edit.postfx.startBtn");
      submitting = false;
      errBox.style.display = "block";
      errBox.textContent = t("edit.postfx.submitFailCode", { code, msg });
      showToast("error", t("edit.postfx.submitFailToast", { msg }));
      return;
    }
    // 成功 → 进入轮询态 (弹窗不关闭, body 替换为轮询视图)
    // M6-T1（B4 抬升）: 轮询环已升模块级, 显式传 body/taskId（行为等价·见模块级函数注）
    enterPollingState(body, taskId, kindsList, selectedEngine);
  });

  // onClose 回调: 关弹窗 / 离开页面 均清轮询定时器 (不欠债)
  // S2-2 FIX-2 双审修正笔：删除「stamped_already = 自动接力过」断言（见 body 内 hint 同笔说明）；
  // 该 400 在 X5 防重按段文件名戳判定的当前真实链路不可达。
  const _dlgModal = openMbox(
    t("edit.postfx.cap") + taskId,
    t("edit.postfx.pickHint"),
    body,
    [[t("edit.common.close"), null]],
    () => {
      stopPostfxPoll();
      _postfxModalClose = null;
    },
  );
  _postfxModalClose = _dlgModal.close;
}
// 批 D D-T3②: L2 转移键集 = store.js defaultClipL2 十字段白名单（键集单一真源·防两边漂移）
const L2_TRANSFER_KEYS = Object.keys(defaultClipL2());
// 批 C C-T6 §2.3a: file 路径比较归一键 normFileKey → R53变更20-T2 上提 core/filekey.js
//   （edit.js / submit-bar.js syncRunProducts / inpaint_dialog.js landProductOnClip 三落点守则共用）；
//   实现零语义变化：反斜杠→斜杠 + 去尾斜杠 + 小写。仅比较侧用·不改存储值。
// 载入映射：detail.shots（dict 形态 shot_001…）→ mainClips 刷新 + segwall 状态
export async function applyHistory(taskId, opts = {}) {
  const r = await loadDetail({ taskId });
  if (!r.ok) { showToast("error", t("edit.hist.fail", { msg: (r.error && r.error.msg) || t("edit.hist.engineNoAnswer") })); return; }
  const detail = r.raw || {};
  const shotsObj = (detail.shots && typeof detail.shots === "object" && !Array.isArray(detail.shots))
    ? detail.shots
    : (Array.isArray(detail.shots) ? Object.fromEntries((detail.shots).map((s) => [s.sid, s])) : {});
  const sids = Object.keys(shotsObj).sort();
  // R53变更20-T2 载入历史守则（AC10 口径·方案 §六呈报2）：opts.auto=true = 自动载入
  //   （preview.js _fsAutoLoadTaskId 等热路径）→ 按 localPick 守则保护本地互换段；
  //   缺省 = 用户显式在历史列表选任务载入 → 重置意图，按该任务重建（localPick 不随迁·正常覆写）。
  const auto = opts.auto === true;
  const state = es();
  const prevClips = state.mainClips || [];
  // 批 10-G-T1 二次修正笔（真机 8943 复验打回）+ 批 D D-T3① 改写: segId 解析链 =
  //   prev(按 sid 命中).segId → project.segments[i].id → hist-<sid>。mainClips 空（跨视图首载·
  //   reconcile 未跑）或 sid 未命中时按同下标取段卡（段序=镜头序·reconcile 既有约定·存量兼容
  //   路径·批 C 右半独立化后收紧），再无该下标才落 hist-<sid>。projectId=opts.projectId
  //   （跨视图旁路）优先·缺省 S.projectId（域内载入）——两路径读同一落账目标项目的 segs。
  const segProjId = opts.projectId || (S && S.projectId);
  const segProj = segProjId ? storeLoad(segProjId) : null;
  const projSegs = (segProj && Array.isArray(segProj.segments)) ? segProj.segments : [];
  // 版本标注：_reruns 里该 sid 的最大 seq（引擎重跑后主 files 已指向最新产物）
  const reruns = Array.isArray(detail._reruns) ? detail._reruns : [];
  // 批A #13：detail 快照落项目实体（shots/_reruns 关键面 + savedAt）——离线显示兜底数据源；
  //   不冒充引擎真相：引擎可达后仍走既有对账链（语义②），芯片转已连接即主动失效（语义③）。
  if (segProjId) {
    putDetailSnapshot(segProjId, taskId, {
      savedAt: new Date().toISOString(),
      shots: shotsObj,
      reruns,
      concat: detail.concat !== undefined ? detail.concat : null,
    });
  }
  const latestSeqBySid = {};
  reruns.forEach((rr) => {
    if (!rr || !Array.isArray(rr.sids)) return;
    rr.sids.forEach((sid) => {
      const seq = (rr && rr.seq) || 0;
      if (!latestSeqBySid[sid] || seq > latestSeqBySid[sid]) latestSeqBySid[sid] = seq;
    });
  });
  // 批 D D-T3①: 对号键 = Map<sid, prevClip>（方案 §四.6 裁决）——逐 shot 按 sid 取 prev，替代
  //   prevClips[i] 位置对位（调序持久化后 mainClips 数组序≠shots 序·位置对位必错配）。
  //   同 sid 多条（分割双半）取数组序第一条，其余丢弃（§四.2 口径·批 C 右半独立化后自然消解）。
  // 批 C C-T6 ①（§2.1.4）: 对号链一律排除 floating prev（paste-/new-/split-）——防「左半被删后 split-
  //   右半带 sid 带 file 泄入首条 → 重建 clip 顶 floating segId + 同分镜造双条」。段身份在左半。
  // 批 C C-T6 ②（§2.3a·批 D 遗留 a）: 第二_chance = file 路径对号 Map —— 仅收 sid 未命中（其 sid 不在
  //   本次 shots 键集）且非 floating 且有 file 的 prev（无 sid 存量 clip 载入历史不丢 L2/triml/label/n），
  //   同 file 取数组序首条（口径同 sid Map）。
  const shotSidSet = new Set(sids);
  const prevBySid = new Map();
  const fileByPath = new Map();
  prevClips.forEach((c) => {
    if (!c || FLOATING_SEG_PREFIX.test(String(c.segId || ""))) return;
    if (c.sid && !prevBySid.has(String(c.sid))) prevBySid.set(String(c.sid), c);
    const sidNotHit = !shotSidSet.has(String(c.sid || ""));
    if (sidNotHit && c.file && !fileByPath.has(normFileKey(c.file))) fileByPath.set(normFileKey(c.file), c);
  });
  // 批 D D-T3③ 已删段不复活: 墓碑读侧守卫（D-T1 同口径·旧档无键按空标记集）
  const tombstones = Array.isArray(state.deletedSegIds) ? state.deletedSegIds : [];
  // 批 D D-T3④ 兜底新建段段号起步 = 存量 max(n)（D-T1 补新段同口径·防与冻结段撞号）
  let nextN = prevClips.reduce((m, c) => (c && Number.isFinite(c.n) && c.n > m ? c.n : m), 0);
  const clips = [];
  sids.forEach((sid, i) => {
    const s = shotsObj[sid] || {};
    const f = (Array.isArray(s.files) && s.files.length) ? (String(s.run_dir || "").replace(/[\\/]+$/, "") + "\\" + s.files[0]) : null;
    // 对号序（批 C C-T6 ③）: sid Map → file Map → 兜底新建。命中任一走下面同一套剪辑态转移。
    const prev = prevBySid.get(String(sid)) || (f ? (fileByPath.get(normFileKey(f)) || null) : null);
    const dur = (typeof s.seg_duration_sec === "number" && s.seg_duration_sec > 0)
      ? s.seg_duration_sec
      : (prev ? prev.dur : 5);
    const full = (typeof s.seg_duration_sec === "number" && s.seg_duration_sec > 0) ? s.seg_duration_sec : (prev ? prev.full : dur);
    const rerunSeq = latestSeqBySid[sid] || 0;
    // segId 解析链: prev(按 sid 命中).segId → projSegs[i].id → hist-<sid>（下标兜底仅当 sid 未命中·存量兼容）
    const segId = (prev && prev.segId) ? prev.segId : ((projSegs[i] && projSegs[i].id) ? projSegs[i].id : ("hist-" + sid));
    // 批 D D-T3③: 命中墓碑 → 整段跳过不出 clip（标记保持·R-21 甲载入历史通道同构收口）
    if (tombstones.includes(segId)) return;
    // 批 D D-T3② 剪辑态转移: L2 十字段照搬（prev 无该键落默认·每段独立默认对象防数组键共引用）+
    //   triml clamp=保 dur 压 triml（时间线显示时长不动·左偏移收回）。
    //   不搬: review（新源重算）/state/status/file/ver（引擎重算）/n（段号铁律·见下）。
    //   R53变更20-T2 例外（仅 auto）: prev 带 localPick 且引擎 file 归一化不等 → 该段 file 覆写
    //   跳过（file/ver 随 prev·localPick 保留）；相等 = 引擎已追上 → 清标记正常写入。
    const pick = auto ? (prev && prev.localPick) : null;
    const pickHold = !!(pick && pick.file && (!f || normFileKey(f) !== normFileKey(pick.file)));
    const l2 = {};
    const d2 = defaultClipL2();
    for (const k of L2_TRANSFER_KEYS) {
      l2[k] = (prev && Object.prototype.hasOwnProperty.call(prev, k)) ? prev[k] : d2[k];
    }
    // 段号铁律: 命中 = 冻结 prev.n（存量不碰）; 未命中新建 = 已产 max+1（不再用 i+1·防撞冻结段号）
    const n = (prev && Number.isFinite(prev.n)) ? prev.n : ++nextN;
    clips.push({
      segId,
      sid,
      n,
      // 批 D D-T3b: label 兜底 = 段{n}（n=该段最终编号·与 n 对位·D-T1/D-T2 同口径·不再 shots 下标 i+1）;
      //   prev 命中段 prev.label 胜出口径不变
      label: prev && prev.label ? prev.label : `段${n}`,
      dur,
      triml: Math.min((prev && Number.isFinite(prev.triml)) ? prev.triml : 0, Math.max(0, full - dur)),
      full,
      ver: (pickHold && prev && prev.ver) ? prev.ver : (rerunSeq ? `第${rerunSeq}次重制` : "原版"),
      state: s.status === "success" ? "done" : (s.status === "failed" || s.status === "stopped" ? "warn" : "empty"),
      // B5-T4 C2（v2-3 定夺）：status 原值透传（着色数据源·state 三态保留既有语义不动）
      status: s.status,
      // R-33：实际耗时透传（引擎 detail 有键才带·无键 undefined→概况页不显示·与 syncRunProducts 同口径）
      elapsedSec: s.elapsed_sec,
      // R-34：失败原因透传（引擎 detail 有键才带·dict 四键·无键 undefined→详情层走兜底·与通道①同口径）
      executionError: s.execution_error,
      file: pickHold ? pick.file : f,
      // B4-T3 黄条数据源：detail 透传 manifest[sid].seg_overrides_active（#17·有键才带）
      segEdited: !!s.seg_overrides_active,
      ...l2,
      ...(pickHold ? { localPick: pick } : {}), // R53变更20-T2：auto 载入守则拦下段保留互换标记
    });
  });
  // 备选轨候选：重跑账本条目（files 为 {sid: 文件名} dict·引擎 1.14 实测形态）
  //   批 B T5：装配收口到 core/candidates.js 的 rebuildAltClips —— 本段原有的
  //   「全局 slice(0,4) + sids 只取 [0] + dur 取 clips[0]」三缺陷由域层统一修掉
  //   （按 sid 整组重建·每 sid 限 4·sids 全量映射·dur 取本段·补 taskId）。
  //   裁决标记（#59 discarded 跨会话真源 + 本地 accepted/discarded）由 rebuild 内同款逻辑还原。
  //   登记限实注记更正（B3 旧注「引擎不保留被替换旧版本文件路径」已不成立：
  //   引擎 _reruns 账本逐事件带 run_dir+files，候选格显示的正是各次重制产物本身）。
  const prevAlts = Array.isArray(state.altClips) ? state.altClips : [];
  const altClips = rebuildAltClips(prevAlts, detail, null, { clips });
  // 批 10-G-T1 修正笔（真机打回）：跨视图调用（preview 自动载入）时 edit 未挂载·S=null，
  //   writeEs 落账目标 S.projectId 不存在 → 载入结果静默丢。opts.projectId 提供时绕过 writeEs
  //   直写指定项目 store（不触碰渲染/撤销栈——edit 挂载时从 store 读态渲染，现状本就如此）；
  //   缺省走原 writeEs 路径（域内载入历史弹窗等既有调用零变化）。
  if (opts.projectId) {
    updateEditingState(opts.projectId, { mainClips: clips, altClips, loadedTaskId: taskId });
  } else {
    writeEs({ mainClips: clips, altClips, loadedTaskId: taskId });
    S.phTime = 0;
    renderAll();
    renderSegWall(shotsObj);
  }
  showToast("success", t("edit.hist.loaded", { taskId, n: sids.length }));
}

// ---- B7-T3 E2：右键「多候选渲染」count 弹层 → #58 提交 → #60 轮询 → 候选全进备选轨 → #59 采纳/废弃 ----
//   守卫链复用 rerunEntryGuard 口径（loadedTaskId → clip.sid）+ 段 success（多候选基于成功段换种子）；
//   候选条目形态对齐 applyHistory altClips 先例（:3681）+ seq/group 决策元数据；
//   采纳 = 本地落账零引擎请求（R53变更20·正片轨换新 + localPick 标记）；
//   废弃 = decide discard → 备选轨标记（state warn）。
let _candPollIntervalMs = 0; // 0 = 域层默认 3s（单测注入位·_test_setCandPollInterval）
export function _test_setCandPollInterval(ms) { _candPollIntervalMs = ms; }

function openCandidatesDialog(ctxEl) {
  const st = es();
  if (!st.loadedTaskId) { showToast("info", t("edit.rerun.needHistory")); return; }
  const segId = ctxEl && ctxEl.dataset.segId;
  const clip = (st.mainClips || []).find((c) => c && c.segId === segId) || null;
  const sid = resolveEngineSid(clip);
  if (!sid) { showToast("info", t("edit.cand.noSidMulti")); return; }
  if (clip.status !== "success") { showToast("info", t("edit.cand.noSuccess")); return; }
  const taskId = loadedTaskIdOrFix(st);

  const body = document.createElement("div");
  body.style.cssText = "font-size:12px;color:var(--txt2)";

  // count 选择（2-5 默认 3）+ 倍率文案常显（提交前明示）
  const countRow = document.createElement("div");
  countRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
  const countLab = document.createElement("span");
  countLab.textContent = t("edit.cand.countLabel");
  countRow.appendChild(countLab);
  const sel = document.createElement("select");
  for (const n of [2, 3, 4, 5]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    sel.appendChild(opt);
  }
  sel.value = "3";
  countRow.appendChild(sel);
  body.appendChild(countRow);

  const launchText = document.createElement("div");
  launchText.setAttribute("data-h3-role", "cand-launch-text");
  launchText.style.cssText = "margin-bottom:8px;padding:5px 8px;border:1px solid #5a7aaa;background:rgba(90,122,170,.12);border-radius:3px;color:#cfe0f5;font-size:12px;line-height:1.6;";
  const paintLaunch = () => {
    const v = validateCount(sel.value) == null ? 3 : validateCount(sel.value);
    launchText.textContent = buildLaunchText(v) + t("edit.cand.countNote");
  };
  sel.addEventListener("change", paintLaunch);
  paintLaunch();
  body.appendChild(launchText);

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.setAttribute("data-h3-role", "cand-submit-btn");
  submitBtn.textContent = t("edit.cand.launchBtn");
  submitBtn.style.cssText = "padding:6px 14px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:3px;";
  body.appendChild(submitBtn);

  const estEl = document.createElement("div");
  estEl.setAttribute("data-h3-role", "cand-estimate");
  estEl.style.cssText = "margin:8px 0 4px;color:var(--txt3);font-size:11px;min-height:14px;";
  body.appendChild(estEl);

  const statusEl = document.createElement("div");
  statusEl.setAttribute("data-h3-role", "cand-status");
  statusEl.style.cssText = "color:var(--txt3);font-size:11px;min-height:16px;";
  body.appendChild(statusEl);

  const rowsHost = document.createElement("div");
  rowsHost.setAttribute("data-h3-role", "cand-rows");
  body.appendChild(rowsHost);

  let poll = null;
  let cands = []; // 本组候选（altClips 条目形态·含 seq 决策元数据）
  const stopPoll = () => { if (poll) { poll.stop(); poll = null; } };
  // 批 9 T3 · 18-14：采纳/废弃在途互斥——两钮 disabled + 连点拦下（不再纯靠引擎 409 decide_busy 兜底）；
  //   落定（含失败路径）finally 统一 renderRows 重建行 → 按钮态复位。
  let deciding = false;
  function decideGuarded(fn, c, accBtn, disBtn) {
    if (deciding) return;
    deciding = true;
    accBtn.disabled = true;
    disBtn.disabled = true;
    void fn(c).finally(() => { deciding = false; renderRows(); });
  }

  // 备选轨写入：该 sid 的旧 _reruns 系让位 + 本组全进
  //   批 B T5：让位范围收窄到「同系」——只清 _reruns 系（重建时会按引擎账本整组回来），
  //   候选组系（其它 group 的多候选）与 retired 系（旧主轨）保留不动。
  function writeAlts() {
    const kept = (es().altClips || []).filter((a) => !(a && a.kind === "rerun" && a.sid === sid));
    writeEs({ altClips: kept.concat(cands) });
  }

  // 候选行渲染（data-cand-seq 标记 + 采纳/废弃；已废弃/已采纳转只读标签）
  //   R53域重对齐-T4（主代理裁定③）: 「已采纳（现行）」live 标注退役——T3 对调语义下 accepted
  //   不再落笔（存量 accepted 仅「曾上岗」弱语义），现行显示归渲染层 ver 角标；本行保留
  //   discarded 只读标签与存量 accepted 的「已采纳」显示。
  function renderRows() {
    rowsHost.innerHTML = "";
    cands.forEach((c) => {
      const row = document.createElement("div");
      row.setAttribute("data-h3-role", "cand-row");
      row.setAttribute("data-cand-seq", String(c.seq));
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--line);font-size:12px;";
      const name = document.createElement("span");
      name.style.cssText = "flex:1;";
      name.textContent = `${c.label} · ${c.file ? String(c.file).split(/[\\/]/).pop() : t("edit.cand.noFileTag")}`;
      row.appendChild(name);
      if (c.discarded || c.accepted) {
        const tag = document.createElement("span");
        tag.textContent = c.discarded ? t("edit.cand.tagDiscarded") : t("edit.cand.tagAccepted");
        tag.style.cssText = `color:${c.discarded ? "var(--txt3)" : "#52c878"};font-size:11px;`;
        row.appendChild(tag);
      } else {
        const accBtn = document.createElement("button");
        accBtn.type = "button";
        accBtn.setAttribute("data-h3-role", "cand-accept-btn");
        accBtn.textContent = t("edit.cand.acceptBtn");
        accBtn.style.cssText = "padding:2px 10px;cursor:pointer;font-size:11px;background:transparent;color:#52c878;border:1px solid #3a7a52;border-radius:3px;";
        accBtn.addEventListener("click", () => decideGuarded(accept, c, accBtn, disBtn));
        row.appendChild(accBtn);
        const disBtn = document.createElement("button");
        disBtn.type = "button";
        disBtn.setAttribute("data-h3-role", "cand-discard-btn");
        disBtn.textContent = t("edit.cand.discardBtn");
        disBtn.style.cssText = "padding:2px 10px;cursor:pointer;font-size:11px;background:transparent;color:var(--txt2);border:1px solid var(--line);border-radius:3px;";
        disBtn.addEventListener("click", () => decideGuarded(discard, c, accBtn, disBtn));
        row.appendChild(disBtn);
      }
      rowsHost.appendChild(row);
    });
  }

  // 落轨：#60 终态 → 重取 detail 取本组账本（candidates_group 过滤·reason=manual 旧账本不入）
  async function landCandidates(group) {
    statusEl.textContent = t("edit.cand.landing");
    const r = await loadDetail({ taskId });
    if (!r.ok) {
      statusEl.textContent = t("edit.cand.landingFail");
      return;
    }
    const reruns = Array.isArray(r.raw && r.raw._reruns) ? r.raw._reruns : [];
    const main = (es().mainClips || []).find((c) => c && c.segId === segId) || clip;
    // 批 B T1 ①: 落轨逐条生成 cid —— taken 播种既有 cid, 同循环同 sid 批量靠同 ts 序号兜底零撞键
    const taken = cidsOf(es().altClips);
    const now = Date.now();   // 批3-T3: 落轨同属一次批量 → hoist 一次读钟（本组同 sid 共享 ts·n 兜底）
    cands = reruns
      .filter((rr) => rr && rr.candidates_group === group && rr.files && rr.files[sid])
      .map((rr, i) => ({
        kind: "cand",
        cid: newAltCid(segId, taken, now),
        segId,
        sid,
        n: 1,
        label: `候选${i + 1}`,
        dur: main.dur || 5,
        triml: 0,
        full: main.full || main.dur || 5,
        ver: `第${rr.seq}次重制`,
        state: "done",
        file: rr.run_dir ? (String(rr.run_dir).replace(/[\\/]+$/, "") + "\\" + rr.files[sid]) : null,
        seq: rr.seq,
        group,
        taskId,
      }));
    // 批5-R53-TC（R1① 落轨链写条目 gen）: cand 组统一代际 = 组首 seq（全组同一 gen·不按条目
    //   各自 seq——防组内 seq 不一致撒到不同轨）；gen 落笔后 F-107 组内排序不改 gen（headSeq
    //   兜底不再随平铺序漂移 → 整组跳轨）。
    const headSeq = (cands.length && typeof cands[0].seq === "number" && cands[0].seq > 0) ? cands[0].seq : null;
    if (headSeq != null) for (const c of cands) c.gen = headSeq;
    writeAlts();
    renderRows();
    statusEl.textContent = cands.length
      ? t("edit.cand.done", { n: cands.length })
      : t("edit.cand.doneNone");
  }

  // 采纳/废弃 = 域级 decideCandidateByClip（批 B T4：与轨道徽章双入口同源·同落账）
  //   R53域重对齐-T3: accept = 对调（file/ver 互换·槽位不动·localPick 落主轨）；
  //   discard = 纯本地标记（discarded+state warn·label 冻结）——均零引擎请求。
  function accept(c) { return decideCandidateByClip(c, "accept"); }
  function discard(c) { return decideCandidateByClip(c, "discard"); }

  // #60 轮询（3s/墙钟 20min·域层收口）；关闭弹层 = 停轮询（引擎渲染继续）
  function startPoll(group) {
    stopPoll();
    poll = pollCandidateRuns({
      taskId,
      group,
      intervalMs: _candPollIntervalMs,
      onTick: (data) => { statusEl.textContent = mapRunsData(data).phaseText + "…"; },
      onFinal: () => { void landCandidates(group); },
      onTimeout: () => { statusEl.textContent = t("edit.cand.timeoutLong"); },
      onError: () => { statusEl.textContent = t("edit.cand.timeout"); },
    });
  }

  submitBtn.addEventListener("click", async () => {
    if (submitBtn.disabled) return;
    const count = validateCount(sel.value);
    if (count == null) { showToast("error", t("edit.cand.errCount")); return; }
    submitBtn.disabled = true;
    const r = await submitCandidates(taskId, sid, count, "");
    submitBtn.disabled = false;
    if (!r.ok) {
      const e = r.error || {};
      if (e.busyKind) { statusEl.textContent = t("edit.cand.busy"); return; }
      if (e.code === "timeout") { statusEl.textContent = t("edit.cand.submitTimeout"); return; }
      showToast("error", t("edit.cand.submitFail", { msg: e.msg || e.code || t("edit.common.unknownErrOffline") }));
      return;
    }
    estEl.textContent = estimateText(r.estimateSeconds);
    statusEl.textContent = t("edit.cand.generating");
    startPoll(r.group);
  });

  openMbox(t("edit.cand.cap", { name: clip.label || segId || sid }), t("edit.cand.sub"), body, [[t("edit.common.close"), null]], stopPoll);
}

// ---- G. 监控墙轮询（3s · status 端点 → segwall 四态）----
// S2-2 T6: 同一 3s 定时器复用, 顺带查 postfx_status (后处理行 + 历史行徽标实时态驱动).
//          单实例 — startMonPoll 调用前先 clearInterval, unmount 时亦清 (不欠债).
export function startMonPoll() {
  if (S.monTimer) clearInterval(S.monTimer);
  S.monTimer = setInterval(async () => {
    if (!S || !S.projectId) return;
    const st = es();
    if (!st.loadedTaskId) return;
    const r = await request("/h3_batch/status?stem=" + encodeURIComponent(st.loadedTaskId), { cache: "no-store" });
    if (r.ok && r.data && r.data.shots && typeof r.data.shots === "object") {
      renderSegWall(r.data.shots);
      // 审片门待裁决段缓存（D030 弹窗用）
      const sid = Object.keys(r.data.shots).sort().find((k) => r.data.shots[k] && r.data.shots[k].status === "success" && (r.data.shots[k].review == null || r.data.shots[k].review === ""));
      if (sid) S._lastPendingSid = sid;
    }
    // S2-2 T6: 顺带轮询 postfx_status, 写 _postfxStatusCache 全局缓存;
    //          历史弹窗 / 监控墙两处统一消费 — 避免每行单跑请求 (与 T5 modal 内部
    //          _postfxTimer 错开 3s 节奏, 各写各的 DOM, 无后写者胜冲突).
    const sr = await postfxStatus();
    _postfxStatusCache = sr.ok ? sr : null;
    renderPostfxLine(st.loadedTaskId);
    refreshHistBadges();
  }, 3000);
}

// S2-2 T6: 监控墙后处理行渲染（loadedTaskId 的 history 项 badge + 实时 status 合成）.
//          数据源: loadedTaskId 对应 history 项的 postfx_badge 字段（首次载入时缓存）.
//          历史项 postfx_badge 字段由 listHistory 端点直出, 不为后处理行单跑请求.
function renderPostfxLine(taskId) {
  const line = document.getElementById("postfxLine");
  if (!line) return;
  if (!taskId) { line.style.display = "none"; return; }
  const historyBadge = _histBadgeCache[taskId] || null;
  const sr = _postfxStatusCache || null;
  const r = composeBadge({ historyBadge, statusResult: sr, taskId });
  if (r.state === "none") {
    line.style.display = "none";
    line.innerHTML = "";
    return;
  }
  line.style.display = "flex";
  line.innerHTML = `<span class="postfx-tag">${t("edit.postfx.tag")}</span><span class="postfx-badge ${r.severity || ""}">${r.label}</span>`;
}

// S2-2 T6: 历史弹窗行徽标就地刷新（postfx_status 实时态驱动, 不重拉 history 列表）.
//          仅改 .postfx-badge 文本+类名, 不动 row 结构 / 按钮 — 与 _histRefresh 重渲染互补.
function refreshHistBadges() {
  const rows = document.querySelectorAll(".mbox-wrap .hist-row[data-task-id]");
  rows.forEach((row) => {
    const tid = row.dataset.taskId;
    const badge = row.querySelector(".postfx-badge");
    if (!badge) return;
    const historyBadge = _histBadgeCache[tid] || null;
    applyBadge(badge, historyBadge, tid);
  });
}

// S2-2 T6: history.postfx_badge 按 taskId 缓存, 给监控墙 / 历史弹窗复用.
//          renderHistRows 写入; 用户重新打开历史弹窗时覆写.
const _histBadgeCache = {};

// segwall 四态渲染（ok/run/bad/wait · D028）
function renderSegWall(shotsObj, opts = {}) {
  const wall = document.getElementById("segWall");
  if (!wall) return;
  const sids = Object.keys(shotsObj || {}).sort();
  if (!sids.length) {
    wall.innerHTML = '<span class="phint" style="padding:6px 4px">' + t("edit.segwall.empty") + '</span>';
    return;
  }
  // 批A #13 语义①：快照兜底渲染时标注数据时点（仅显示兜底·不冒充引擎真相）
  const note = (opts && opts.fallbackSavedAt !== undefined)
    ? `<span class="phint" style="display:block;padding:4px 6px;color:#c0392b">${t("edit.segwall.offline", { ts: opts.fallbackSavedAt || t("edit.segwall.timeUnknown") })}</span>`
    : "";
  wall.innerHTML = note + sids.map((sid) => {
    const s = shotsObj[sid] || {};
    const st2 = s.status === "success" ? "ok" : (s.status === "failed" || s.status === "stopped" ? "bad" : (s.status === "running" || s.status === "pending" ? "run" : "wait"));
    const mark = st2 === "ok" ? "✓" : st2 === "bad" ? "⚠" : st2 === "run" ? "▓" : "…";
    return `<span class="segcell ${st2}" title="${sid} ${s.status || ""}">${sid.replace("shot_", "段")}<small>${mark} ${s.status || "wait"}</small></span>`;
  }).join("");
}

// 批 C C-T3 ④N4 审片门拒发：三钮共用取段口——待裁决 sid 唯一来源 = 监控墙轮询缓存
//   S._lastPendingSid（startMonPoll 写）。缓存空（未起监控墙 / 引擎尚未回任何 success 段）
//   旧口径盲发 "shot_001" → 引擎拿不存在的段号裁决（approve/void 打错段 = 误伤别段）。
//   改：空缓存 → toast 提示 + 返 null（三钮各自 return·零请求）。
function pendingSidOrToast() {
  const sid = S && S._lastPendingSid;
  if (!sid) { showToast("info", t("edit.review.noPending")); return null; }
  return sid;
}

// 批 10-O F100：审片门只有引擎段号 sid（无 segId 上下文）→ 按 mainClips.find(c=>c.sid===sid)
//   反查 segId 再回写 clip.review（缩略点 audited-ok/bad + title 的唯一数据源）。
//   paste 副本无 sid 不会多命中；反查未命中跳过不抛（引擎已裁决·只是没对应 GUI 段）。
//   重渲走本页既有 store 订阅通道（editingState:update → renderAll）。
function _auditMarkReview(st, pid, sid, review) {
  const clips = Array.isArray(st && st.mainClips) ? st.mainClips : [];
  const clip = clips.find((c) => c && c.sid === sid);
  if (!clip || !clip.segId) return false;
  return markClipReview(pid, clip.segId, review);
}

// ---- C. 审片门弹窗（D030 四选项·真端点）----
// 批 R3 · B07: 接受可选 projectId —— 预览 TAB（edit 未挂载）直读该段 store editingState；
//              edit 域内无参调用行为不变。
export function openReviewModal(projectId) {
  const pid = projectId || (S && S.projectId) || "";
  const st = esOf(pid);
  const taskId = loadedTaskIdOrFix(st, pid);
  const body = document.createElement("div");
  if (!taskId) {
    body.textContent = t("edit.review.needHistory");
    openMbox(t("edit.review.cap"), "", body, [[t("edit.common.close"), null]]);
    return;
  }
  body.innerHTML = t("edit.review.body")
    + '<div class="exwarn">' + t("edit.review.warn") + "</div>";
  openMbox(t("edit.review.capTask") + taskId, "", body, [
    [t("edit.review.approveBtn"), async () => {
      const sid = pendingSidOrToast();
      if (!sid) return;
      const r = await approve({ stem: taskId, sid });
      if (r.ok) _auditMarkReview(st, pid, sid, "approved");
      showToast(r.ok ? "success" : "error", r.ok ? t("edit.review.approved", { sid }) : t("edit.review.approveFail", { msg: (r.error && r.error.msg) || "" }));
    }],
    [t("edit.review.voidSoloBtn"), async () => {
      const sid = pendingSidOrToast();
      if (!sid) return;
      const r = await voidSeg({ stem: taskId, sid, solo: true });
      if (r.ok) _auditMarkReview(st, pid, sid, "void");
      showToast(r.ok ? "success" : "error", r.ok ? t("edit.review.voidSoloDone", { sid }) : t("edit.review.voidFail", { msg: (r.error && r.error.msg) || "" }));
    }],
    [t("edit.review.voidCascadeBtn"), async () => {
      const sid = pendingSidOrToast();
      if (!sid) return;
      const r = await voidSeg({ stem: taskId, sid, solo: false });
      // 级联一次作废多段（core/review.js:135 返 voided[]）——逐段回写，漏一段 = 该段点色不更新
      if (r.ok) (Array.isArray(r.voided) ? r.voided : []).forEach((v) => _auditMarkReview(st, pid, v, "void"));
      showToast(r.ok ? "success" : "error", r.ok ? t("edit.review.cascadeDone", { n: r.cascadeCount }) : t("edit.review.voidFail", { msg: (r.error && r.error.msg) || "" }));
    }],
    [t("edit.review.resumeBtn"), async () => {
      const r = await resume({ stem: taskId });
      showToast(r.ok ? "success" : "error", r.ok ? t("edit.review.resumed") : t("edit.review.resumeFail", { msg: (r.error && r.error.msg) || "" }));
    }],
    [t("edit.common.close"), null],
  ]);
}

// ---- D. 重跑弹窗（B4-T3 D3 四区升级：改词/时长/参考图/LoRA → 引擎 #57 seg_edit；批Gb T6 扩第五区「底模」）----
//   批Gb T6（R-09）：区五底模 → overrides.resources.unet（裁决 2 仅 unet 单槽）——下拉源=
//   resources.js fetchResourceItems("model")（#28 直取·复用不重造）；拉取失败=离线兜底：
//   下拉仅「不覆盖」+置灰+灰提示「引擎未连接·暂不可选底模」（其余域照常提交）。
//   提交通道（v2.1 终订 1·锁死）：seg_edit(rerun:false) 纯写侧车即返 → 显式 POST /h3_batch/rerun
//   （后台 started）→ runRerunFlow(kind:"seg_edit"·label 精修重跑)——禁用 rerun=true（引擎同步等
//   渲染完才返·GUI 30s 超时必炸）；seg_edit 已返回故 rerun 不撞 409，装配先读侧车与 rerun=true 同路径。
//   空区不传键 = 不覆写侧车既有值（#57「未出现的键=不覆盖」·安全）。
//   预填（v2.1 终订 3）：时长=引擎真值优先（detail #17 seg_duration_sec·已精修段重开=覆盖值）
//   → fallback seg.durationSec；改词=seg.prompt；参考图/LoRA 恒空（引擎无端点回传侧车内容）。
// B4-T3 顺手修 O3：旧 `clips.find(...) || clips[0]` 匹配不到静默改第 1 段 → 收紧为精确匹配+白话 toast。
// gui13.paths.workflow_path 只读消费（settings.PATHS_KEY 同源·views 不互引键字面量=两侧契约·resources.js 同款先例）
function _readWorkflowPath() {
  try {
    const ls = (typeof globalThis !== "undefined") ? globalThis.localStorage : null;
    const raw = ls && ls.getItem ? ls.getItem("gui13.paths") : null;
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o.workflow_path === "string") ? o.workflow_path.trim() : "";
  } catch (_e) { return ""; }
}
async function _fetchTemplateLoraNames(wfPath) {
  try {
    const r = await request("/h3_batch/template_loras?workflow_path=" + encodeURIComponent(wfPath), { cache: "no-store" });
    if (!r.ok || !r.data || !Array.isArray(r.data.loras)) return null;
    return r.data.loras.map((l) => (l && typeof l.name === "string") ? l.name : "").filter(Boolean);
  } catch (_e) { return null; }
}
export async function openRerunModal(clipEl, opts = {}) {
  // B5-T6 G6（v2-6）：参数化——clipEl（既有 DOM 入口）或 { projectId, clip }（跨域入口·
  //   esOf(projectId) 直读 store：载入历史后持久，edit 未 mount 亦可调）；四区弹窗照旧。
  const projectId = opts.projectId || (S && S.projectId) || "";
  const st = projectId ? esOf(projectId) : es();
  const taskId = loadedTaskIdOrFix(st, projectId);
  if (!taskId) { showToast("info", t("edit.segedit.needHistory")); return; }
  let clip = opts.clip || null;
  if (!clip) {
    const segId = clipEl && clipEl.dataset ? clipEl.dataset.segId : "";
    const clips = st.mainClips || [];
    clip = clips.find((c) => c && c.segId === segId) || null; // O3 收紧：精确匹配
  }
  if (!clip) { showToast("info", t("edit.segedit.noTarget")); return; }
  if (!clip.sid) { showToast("info", t("edit.rerun.noSid")); return; }
  const proj = projectId ? storeLoad(projectId) : null;
  const seg = proj && proj.segments ? proj.segments.find((sg) => sg.id === clip.segId) : null;

  // 预填数据（并行拉取·失败静默回落）：detail 引擎真值 + 模板 LoRA 选项（#29·已选模板才查）
  //   + 底模清单（批Gb T6·#28 model·request 网络失败归一 ok:false 不抛 → 离线兜底路径）
  const wfPath = _readWorkflowPath();
  const [det, loraNames, modelRes] = await Promise.all([
    loadDetail({ taskId }).catch(() => null),
    wfPath ? _fetchTemplateLoraNames(wfPath) : Promise.resolve(null),
    fetchResourceItems("model"),
  ]);
  const rawShots = (det && det.raw && det.raw.shots && typeof det.raw.shots === "object" && !Array.isArray(det.raw.shots))
    ? det.raw.shots : {};
  const segInfo = rawShots[clip.sid] || {};
  const engDur = (typeof segInfo.seg_duration_sec === "number" && segInfo.seg_duration_sec > 0)
    ? segInfo.seg_duration_sec : null;
  const durPrefill = engDur != null ? engDur
    : (seg && typeof seg.durationSec === "number" ? seg.durationSec : "");

  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const zoneLab = (t) => {
    const l = document.createElement("div");
    l.style.cssText = "font-size:11px;color:var(--txt3)";
    l.textContent = t;
    return l;
  };
  const inputCss = "background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 8px;color:var(--txt);font-size:12px;box-sizing:border-box";

  // 区一：改词（预填 seg.prompt·留空 = 不覆盖侧车提示词）
  body.appendChild(zoneLab(t("edit.segedit.zPrompt")));
  const ta = document.createElement("textarea");
  ta.id = "segedit-prompt";
  ta.rows = 3;
  ta.style.cssText = "width:100%;" + inputCss + ";font-family:inherit;resize:vertical";
  ta.value = (seg && seg.prompt) || "";
  body.appendChild(ta);

  // 区二：时长（引擎真值优先·帧网格 124-362 帧 ≈ 5.0-15.0s·越界前端拒）
  body.appendChild(zoneLab(t("edit.segedit.zDur")));
  const durIn = document.createElement("input");
  durIn.id = "segedit-dur";
  durIn.type = "number";
  durIn.step = "0.1";
  durIn.placeholder = t("edit.segedit.phDur");
  durIn.style.cssText = "width:140px;" + inputCss;
  durIn.value = durPrefill === "" ? "" : String(durPrefill);
  body.appendChild(durIn);

  // 区三：参考图（pool Picture 槽 1·绝对路径·引擎存在性校验 400 白话兜底）
  body.appendChild(zoneLab(t("edit.segedit.zPool")));
  const poolRow = document.createElement("div");
  poolRow.style.cssText = "display:flex;gap:6px;align-items:center";
  const poolIn = document.createElement("input");
  poolIn.id = "segedit-pool";
  poolIn.placeholder = t("edit.segedit.phPool");
  poolIn.style.cssText = "flex:1;min-width:0;" + inputCss;
  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "ghostbtn";
  pickBtn.textContent = t("edit.segedit.pickBtn");
  pickBtn.addEventListener("click", () => {
    openPicker({
      title: t("edit.segedit.pickTitle"),
      mode: "image",
      current: poolIn.value.trim(),
      onPick: (picked) => { if (typeof picked === "string" && picked) poolIn.value = picked; },
    });
  });
  poolRow.appendChild(poolIn);
  poolRow.appendChild(pickBtn);
  body.appendChild(poolRow);

  // 区四：LoRA（模板 lora_overrides 语义·名可联想可手输·强度 0-1）
  body.appendChild(zoneLab(wfPath ? t("edit.segedit.zLoraTpl") : t("edit.segedit.zLoraManual")));
  const loraRow = document.createElement("div");
  loraRow.style.cssText = "display:flex;gap:6px;align-items:center";
  const loraNameIn = document.createElement("input");
  loraNameIn.id = "segedit-lora-name";
  loraNameIn.setAttribute("list", "segedit-lora-list");
  loraNameIn.placeholder = t("edit.segedit.phLora");
  loraNameIn.style.cssText = "flex:1;min-width:0;" + inputCss;
  const loraStrIn = document.createElement("input");
  loraStrIn.id = "segedit-lora-strength";
  loraStrIn.type = "number";
  loraStrIn.step = "0.05";
  loraStrIn.min = "0";
  loraStrIn.max = "1";
  loraStrIn.value = "0.8";
  loraStrIn.title = t("edit.segedit.tLoraStrength");
  loraStrIn.style.cssText = "width:80px;" + inputCss;
  loraRow.appendChild(loraNameIn);
  loraRow.appendChild(loraStrIn);
  body.appendChild(loraRow);
  const dl = document.createElement("datalist");
  dl.id = "segedit-lora-list";
  (loraNames || []).forEach((n) => {
    const o = document.createElement("option");
    o.setAttribute("value", n);
    dl.appendChild(o);
  });
  body.appendChild(dl);

  // 区五：底模（主模型·批Gb T6 R-09·overrides.resources.unet 单槽——裁决 2：clip/vae 段级覆盖不做）
  //   下拉源 = fetchResourceItems("model")（#28 直取）；拉取失败 = 离线兜底：仅「不覆盖」+置灰+灰提示（其余域照常）
  body.appendChild(zoneLab(t("edit.segedit.zUnet")));
  const unetSel = document.createElement("select");
  unetSel.id = "segedit-unet";
  unetSel.style.cssText = "width:100%;" + inputCss;
  const mkUnetOpt = (v, t) => {
    const o = document.createElement("option");
    o.setAttribute("value", v);
    o.textContent = t;
    return o;
  };
  unetSel.appendChild(mkUnetOpt("", t("edit.segedit.unetKeep")));
  const modelNames = (modelRes && modelRes.ok && Array.isArray(modelRes.items)) ? modelRes.items : [];
  for (const n of modelNames) unetSel.appendChild(mkUnetOpt(n, n));
  if (!(modelRes && modelRes.ok)) {
    unetSel.disabled = true;
    const unetOff = document.createElement("div");
    unetOff.id = "segedit-unet-offline";
    unetOff.style.cssText = "font-size:11px;color:var(--txt3)";
    unetOff.textContent = t("edit.segedit.unetOffline");
    body.appendChild(unetSel);
    body.appendChild(unetOff);
  } else {
    body.appendChild(unetSel);
  }

  // 区六（T5 #31b）：后期处理（仅本次）——默认按全局六键回填；超分/插帧两开关+引擎+参数
  //   只影响本次重跑终态后的自动补（supplementPostfxAfterRerun gpOverride 纯装配·不写回全局）
  const gp = (proj && proj.globalParams && typeof proj.globalParams === "object") ? proj.globalParams : {};
  body.appendChild(zoneLab(t("edit.segedit.zPostfx")));
  const pfBox = document.createElement("div");
  pfBox.setAttribute("data-rerun-postfx", "1");
  pfBox.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const pfHint = document.createElement("div");
  pfHint.style.cssText = "font-size:11px;color:var(--txt3);line-height:1.5";
  pfHint.textContent = t("edit.segedit.pfHint");
  pfBox.appendChild(pfHint);
  // 开关行：超分/插帧（复用 openPostfxDialog fchip chips 写法·默认态按全局派生：
  //   超分=postfx_upscale 真值；插帧=postfx_fps 非空——与参数页派生口径一致）
  const pfOn = {
    upscale: gp.postfx_upscale === true,
    interp: String(gp.postfx_fps == null ? "" : gp.postfx_fps).trim() !== "",
  };
  const pfRow = document.createElement("div");
  pfRow.style.cssText = "display:flex;gap:8px;align-items:center";
  const pfChips = {};
  for (const [k, label] of [["upscale", t("edit.segedit.chipUpscale")], ["interp", t("edit.segedit.chipInterp")]]) {
    const c = document.createElement("span");
    c.id = "segedit-postfx-" + k;
    c.className = "fchip" + (pfOn[k] ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => {
      pfOn[k] = !pfOn[k];
      c.classList.toggle("on", pfOn[k]);
      // 关=本次不做该类·参数一并清（setup 参数页取消勾选清值同款·防脏值拦提交）
      if (!pfOn[k]) {
        if (k === "upscale") adv.clearUpscaleInputs();
        else adv.clearInterpInput();
      }
    });
    pfChips[k] = c;
    pfRow.appendChild(c);
  }
  pfBox.appendChild(pfRow);
  // 引擎行（超分引擎二选·默认=全局 postfx_engine·写法同 openPostfxDialog）
  const pfEngineRow = document.createElement("div");
  pfEngineRow.style.cssText = "display:flex;gap:8px;align-items:center";
  const pfEngineLabel = document.createElement("span");
  pfEngineLabel.style.cssText = "font-size:12px;color:var(--txt2);width:60px;flex-shrink:0";
  pfEngineLabel.textContent = t("edit.segedit.pfEngineLabel");
  pfEngineRow.appendChild(pfEngineLabel);
  let pfEngine = gp.postfx_engine === "rtxvsr" ? "rtxvsr" : "seedvr2";
  const pfEngineChips = {};
  for (const [e, label] of [["seedvr2", t("edit.postfx.engSeed")], ["rtxvsr", t("edit.postfx.engRtx")]]) {
    const c = document.createElement("span");
    c.id = "segedit-postfx-eng-" + e;
    c.className = "fchip" + (e === pfEngine ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => {
      pfEngine = e;
      Object.entries(pfEngineChips).forEach(([ee, v]) => v.classList.toggle("on", ee === e));
      adv.refreshHints();   // 引擎档影响倍数区间/RTX 警示（buildPostfxAdvanced 同款）
    });
    pfEngineChips[e] = c;
    pfEngineRow.appendChild(c);
  }
  pfBox.appendChild(pfEngineRow);
  // 高级参数（输出组按全局回填·无「长片分段阈值」组——补链编排不携带 seg_threshold；
  //   基准探针定向本段。chips 句柄引用 adv=用户点击时已完成初始化·同 openPostfxDialog 先例）
  const adv = buildPostfxAdvanced(pfBox, {
    engine: () => pfEngine,
    scope: () => ({ onlySelected: true, sids: [clip.sid] }),
    initial: { scale: gp.postfx_scale, w: gp.postfx_w, h: gp.postfx_h, fps: gp.postfx_fps },
    omitSegThreshold: true,
  });
  body.appendChild(pfBox);

  // 「同时重跑」勾选（默认开；取消 = 只写侧车不渲染）
  const chkRow = document.createElement("label");
  chkRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;color:var(--txt2);cursor:pointer;margin-top:2px";
  const chk = document.createElement("input");
  chk.id = "segedit-rerun-chk";
  chk.type = "checkbox";
  chk.checked = true;
  chkRow.appendChild(chk);
  const chkTxt = document.createElement("span");
  chkTxt.textContent = t("edit.segedit.chkRerun");
  chkRow.appendChild(chkTxt);
  body.appendChild(chkRow);

  const meta = document.createElement("div");
  meta.style.cssText = "font-size:11px;color:var(--txt3)";
  meta.textContent = t("edit.segedit.meta", { sid: clip.sid, prefill: engDur != null ? t("edit.segedit.metaPrefill") : "" });
  body.appendChild(meta);

  openMbox(t("edit.segedit.cap") + clip.sid, t("edit.segedit.sub"), body, [
    [t("edit.common.cancel"), null],
    [t("edit.segedit.goBtn"), async () => {
      const overrides = {};
      const text = ta.value.trim();
      if (text) overrides.prompt_text = text;
      const dv = durIn.value.trim();
      if (dv) {
        const n = Number(dv);
        if (!isFinite(n) || n < 5 || n > 15) { showToast("error", t("edit.segedit.errDurRange")); return; }   // F块：删引擎帧网格术语·留人话
        overrides["段落时长"] = n;
      }
      const pv = poolIn.value.trim();
      if (pv) overrides.pool = { Picture: { "1": pv } };
      const ln = loraNameIn.value.trim();
      if (ln) {
        const s = loraStrIn.value.trim() === "" ? NaN : Number(loraStrIn.value.trim());
        if (!isFinite(s) || s < 0 || s > 1) { showToast("error", t("edit.segedit.errLoraRange")); return; }
        overrides.lora = { [ln]: { strength: s } };
      }
      const uv = (typeof unetSel.value === "string") ? unetSel.value.trim() : "";
      if (uv) overrides.resources = { ...(overrides.resources || {}), unet: uv };
      if (!Object.keys(overrides).length) { showToast("error", t("edit.segedit.errEmpty")); return; }
      // T5 #31b：后期（仅本次）装配——parse 白话拦截在前（合法才提交）；gpOverride=六键子集
      //   （supplementPostfxAfterRerun {...globalParams, ...gpOverride} 纯装配·不写回全局）
      const advParsed = adv.parse();
      if (advParsed.error) { showToast("error", advParsed.error); return; }
      if (pfOn.interp && !advParsed.interpParams) {
        showToast("error", t("edit.segedit.errInterpFps")); return;
      }
      const gpOverride = {
        postfx_upscale: pfOn.upscale === true,
        postfx_engine: pfEngine,
        postfx_fps: (pfOn.interp && advParsed.interpParams) ? String(advParsed.interpParams.target_fps) : "",
      };
      if (pfOn.upscale && advParsed.upscaleParams) {
        if (advParsed.upscaleParams.mode === "scale") gpOverride.postfx_scale = String(advParsed.upscaleParams.scale);
        else {
          gpOverride.postfx_w = String(advParsed.upscaleParams.width);
          gpOverride.postfx_h = String(advParsed.upscaleParams.height);
        }
      }
      const r = await submitSegEdit({ taskId, sid: clip.sid, overrides, rerun: false });
      if (!r.ok) {
        const e = r.error || {};
        // 信封归一后 code/msg 分载——两者拼接还原引擎中文原文（409/400 统一透传口径）
        const em = e.msg ? (e.code && e.code !== "validation" ? `${e.code}：${e.msg}` : e.msg) : (e.code || t("edit.common.unknownErrOffline"));
        showToast("error", t("edit.segedit.saveFail", { msg: em }));
        return;
      }
      if (!chk.checked) {
        showToast("success", t("edit.segedit.savedNoRender"));
        return;
      }
      // v2.1 终订链路：显式 rerun（后台 started）→ runRerunFlow 全复用（落账+轮询+回轨）
      //   T5 #31b：gpOverride 随链透传——重跑终态自动补按弹窗设定（仅本次·不写回全局）
      void runRerunFlow({ projectId, taskId, sids: [clip.sid], keepSeed: false, label: "精修重跑", kind: "seg_edit", gpOverride })
        .then((r) => { _rerunPoll = (r && r.poll) || null; });
    }, "prim"],
  ]);
}

// B5-T6 G6：分镜卡墙（段卡 ↻ 钮）跨域入口——按 (projectId, segId) 构造 clip 上下文走四区弹窗。
//   守卫链白话降级：未载入历史 → 「先载入历史任务」；该段无 sid（含未载入到该段）→ 无引擎段号。
//   edit 未 mount 可调（esOf(projectId) 直读 store·载入历史后持久）。
export async function openSegRerunBySegId(projectId, segId) {
  const st = esOf(projectId);
  // 空值守卫走 helper（无 loadedTaskId → 返 "" → 原「先载入历史任务」toast 照旧）
  if (!loadedTaskIdOrFix(st, projectId)) { showToast("info", t("edit.segedit.needHistoryShort")); return; }
  const clip = (Array.isArray(st.mainClips) ? st.mainClips : []).find((c) => c && c.segId === segId) || null;
  if (!clip || !clip.sid) { showToast("info", t("edit.segedit.noSidSeg")); return; }
  // 过期校验提示已由本读点给出（openRerunModal 内同 key 不再重复弹）
  await openRerunModal(null, { projectId, clip });
}

// ---- E. 多版对比（D031·≤4 并排·B5-T5③：只主格出声 + range 同步条）----
// 出处：legacy/app/js/components/compare.js:100 computeSyncTimes（进度 → 各源按 duration 比例映射）+
//   :217 自绘同步条（原生单进度条无法驱动多格同进度）——1.3 版泛化为 N 格 durations 数组；
//   假时钟（cmpT 定时器 + 「同步播放」钮）退役：range 0-1000 驱动各格按各自 duration 比例 seek，
//   主格（第一格）controls 出声、其余格 muted（≤4 格防混音）；主格 timeupdate → 同步条跟随。
export function computeSyncTimes(opts) {
  const o = opts || {};
  const p = o.progress;
  const durs = o.durations;
  if (typeof p !== "number" || !isFinite(p) || p < 0 || p > 1) {
    throw new Error("computeSyncTimes: progress must be a finite number in [0,1], got " + String(p));
  }
  if (!Array.isArray(durs) || !durs.length) {
    throw new Error("computeSyncTimes: durations must be a non-empty array, got " + String(durs));
  }
  return durs.map((d) => {
    if (typeof d !== "number" || !isFinite(d) || d <= 0) {
      throw new Error("computeSyncTimes: duration must be a finite number > 0, got " + String(d));
    }
    return p * d;
  });
}
// ===== 多版对比面板同步播放（批 B T6 · F108「不同步/只有原版可播」治）=====
//   主格（controls 出声）事件 → 广播到其余 muted 格：play 同步 seek+播 · pause 全停 ·
//   seeking/seeked 同步 seek；播放中 rAF 纠偏（漂移超阈值才写·seeking 守卫同批 A 口径）。
//   面板关闭必须停 rAF + 解监听（A9 防泄漏）——故监听句柄挂模块级，closeCompareSync 统一收口。
const CMP_DRIFT = 0.3;      // 纠偏阈值（秒）·阈值内不写 currentTime（防逐帧微写抖动）
let _cmp = null;            // 当前面板的同步上下文 {main, unbind, rafId, closed}

// 其余格按主格进度比例 seek（metadata 未就绪的格跳过——computeSyncTimes 拒非正 duration）
function cmpSeekOthers(ctx) {
  const mv = ctx.main;
  const d = mv && mv.duration;
  if (!(Number.isFinite(d) && d > 0)) return;
  const p = Math.max(0, Math.min(1, (+mv.currentTime || 0) / d));
  const others = ctx.vidsOf().slice(1).filter((v) => Number.isFinite(v.duration) && v.duration > 0);
  if (!others.length) return;
  const times = computeSyncTimes({ progress: p, durations: others.map((v) => v.duration) });
  others.forEach((v, i) => {
    try { v.currentTime = Math.min(times[i], v.duration); } catch (_e) { /* metadata 未就绪 seek 拒绝：忽略 */ }
  });
}
function cmpStartVideo(ctx, v) {
  if (v.seeking !== true) {
    const p = (Number.isFinite(ctx.main.duration) && ctx.main.duration > 0)
      ? (+ctx.main.currentTime || 0) / ctx.main.duration : 0;
    if (Number.isFinite(v.duration) && v.duration > 0) {
      try { v.currentTime = Math.min(p * v.duration, v.duration); } catch (_e) { /* 忽略 */ }
    }
  }
  try { void v.play(); } catch (_e) { /* 浏览器自动播放被拒：忽略（muted 格可自动播） */ }
}
function cmpPlayAll(ctx) {
  cmpSeekOthers(ctx);
  for (const v of ctx.vidsOf().slice(1)) {
    // 就绪门控：未拿到 metadata 的格先挂一次性 loadedmetadata·就绪后再对齐起播
    if (v.readyState >= 1) { cmpStartVideo(ctx, v); continue; }
    v.addEventListener("loadedmetadata", () => { if (!ctx.closed) cmpStartVideo(ctx, v); }, { once: true });
  }
  cmpStartDrift(ctx);
}
function cmpPauseAll(ctx) {
  for (const v of ctx.vidsOf().slice(1)) { try { v.pause(); } catch (_e) { /* 忽略 */ } }
}
function cmpDriftLoop() {
  const ctx = _cmp;
  if (!ctx || ctx.closed) { if (_cmp === ctx) _cmp = null; return; }
  const mv = ctx.main;
  if (mv.paused === false) {
    const d = mv.duration;
    if (Number.isFinite(d) && d > 0) {
      const p = Math.max(0, Math.min(1, (+mv.currentTime || 0) / d));
      for (const v of ctx.vidsOf().slice(1)) {
        if (v.seeking === true) continue;                        // seek 途中不写（批 A 同口径）
        if (!(Number.isFinite(v.duration) && v.duration > 0)) continue;
        const want = p * v.duration;
        if (Math.abs((+v.currentTime || 0) - want) > CMP_DRIFT) {
          try { v.currentTime = want; } catch (_e) { /* 忽略 */ }
        }
      }
    }
  }
  ctx.rafId = (typeof requestAnimationFrame === "function") ? requestAnimationFrame(cmpDriftLoop) : 0;
}
function cmpStartDrift(ctx) {
  if (ctx.rafId || ctx.closed) return;
  if (typeof requestAnimationFrame !== "function") return;   // 无 rAF 环境（Node 无桩）no-op
  ctx.rafId = requestAnimationFrame(cmpDriftLoop);
}
export function bindCompareSync(mainVideo, grid, vidsOf) {
  if (_cmp) closeCompareSync();
  const ctx = { main: mainVideo, vidsOf, rafId: 0, closed: false };
  const onPlay = () => cmpPlayAll(ctx);
  const onPause = () => cmpPauseAll(ctx);
  const onSeek = () => cmpSeekOthers(ctx);
  mainVideo.addEventListener("play", onPlay);
  mainVideo.addEventListener("pause", onPause);
  mainVideo.addEventListener("seeking", onSeek);
  mainVideo.addEventListener("seeked", onSeek);
  ctx.unbind = () => {
    mainVideo.removeEventListener("play", onPlay);
    mainVideo.removeEventListener("pause", onPause);
    mainVideo.removeEventListener("seeking", onSeek);
    mainVideo.removeEventListener("seeked", onSeek);
  };
  _cmp = ctx;
  return ctx;
}
// 面板关闭收口：停 rAF + 解主格监听 + 置终止标志（漂移环下一拍自行退出）
export function closeCompareSync() {
  const ctx = _cmp;
  if (!ctx) return;
  ctx.closed = true;
  if (ctx.rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(ctx.rafId);
  ctx.rafId = 0;
  if (ctx.unbind) ctx.unbind();
  _cmp = null;
}

export function openCompareModal(clipEl) {
  const st = es();
  const segId = clipEl && clipEl.dataset.segId;
  const main = (st.mainClips || []).find((c) => c.segId === segId);
  if (!main) return;
  // 批 B T6 收集口径（治 B-T1 遗留 3）：同段全部版本入格——_reruns 系（重跑）+ retired 系
  //   （✓ 采纳后的旧主轨）+ cand 系（多候选）三系同权，按 altClips 序（新→旧）；上限仍是
  //   主格 + 3 候选 = 4 格（横向对比读得动），超出给指引 toast（账本全量可对拍）
  const sameSeg = (st.altClips || []).filter((c) => c && c.segId === segId);
  const cands = sameSeg.slice(0, 3);
  const versions = [{ name: main.ver || "原版", file: main.file }].concat(
    cands.map((c) => ({ name: c.ver || c.label || t("edit.cmp.oldVer"), file: c.file })),
  );
  while (versions.length < 2) versions.push({ name: t("edit.cmp.noCandVer", { n: versions.length }), file: null });
  if (versions.length > 4) versions.length = 4;
  if (sameSeg.length > 3) showToast("info", t("edit.cmp.tooMany", { n: sameSeg.length }));
  const body = document.createElement("div");
  const grid = document.createElement("div");
  grid.className = "cmp-grid" + (versions.length === 4 ? " four" : "");
  // 主格（i=0）= controls 出声；其余格 muted（只主格出声·防 ≤4 格混音）
  //   preload=auto（批 B T6）：其余格要跟随播就得先有数据·metadata 不足以起播
  grid.innerHTML = versions.map((v, i) => `
    <div class="cmp-cell" data-i="${i}">
      <span class="cmp-tag">${v.name}</span>
      ${v.file ? `<video src="${mediaUrl("video", v.file)}"${i === 0 ? " controls" : " muted loop"} preload="auto" style="width:100%;height:100%;object-fit:cover"></video>`
               : `<span style="font-size:12px">${t("edit.cmp.noPreview")}</span>`}
      <span class="cmp-tc">00:00</span>
      <span class="cmp-bar"><i></i></span>
    </div>`).join("");
  body.appendChild(grid);
  const sync = document.createElement("input");
  sync.type = "range";
  sync.className = "cmp-sync";
  sync.min = "0";
  sync.max = "1000";
  sync.value = "0";
  sync.title = t("edit.cmp.syncTitle");
  sync.style.cssText = "width:100%;margin-top:8px;accent-color:var(--accent)";
  body.appendChild(sync);

  const cells = () => [...grid.querySelectorAll(".cmp-cell")];
  const vidsOf = () => cells().map((cell) => cell.querySelector("video")).filter(Boolean);
  // 批 B #13：各版本视频离线回落接线（引擎口失败 → 本地流；cells 序=versions 序·一一对应）
  cells().forEach((cell, i) => {
    const cv = cell.querySelector("video");
    if (cv && versions[i] && versions[i].file) wireLocalFallback(cv, "video", versions[i].file);
  });
  // 批 L1 T3②（R-24 甲）：按视频实际比例显示——metadata 就绪后内联覆盖 .cmp-cell 的 16/9 兜底
  //   （CSS 不动）+ video 内联 object-fit cover→contain；尺寸读不到（404/坏元数据·assets_api.js:923
  //   同款防御读口）或 metadata 永不触发 → 不写内联 → 保持 16/9 现状（零回归）
  cells().forEach((cell) => {
    const v = cell.querySelector("video");
    if (!v) return;
    v.addEventListener("loadedmetadata", () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!(typeof w === "number" && w > 0 && typeof h === "number" && h > 0)) return;
      cell.style.aspectRatio = w + "/" + h;
      v.style.objectFit = "contain";
    }, { once: true });
  });
  // 格内标签刷新：时间码 = 该格当前 currentTime（各格时长不同 → 各显各的源内时间）
  function refreshCellUi(cell) {
    const v = cell.querySelector("video");
    if (!v || !(Number.isFinite(v.duration) && v.duration > 0)) return;
    const p = Math.max(0, Math.min(1, (+v.currentTime || 0) / v.duration));
    const tc = cell.querySelector(".cmp-tc");
    const bar = cell.querySelector(".cmp-bar i");
    if (tc) tc.textContent = fmtClock(v.currentTime || 0);
    if (bar) bar.style.width = (p * 100) + "%";
  }
  // 拖动同步条：各格按 loadedmetadata 各自 duration 比例 seek（metadata 未就绪的格跳过）
  function seekAll(p) {
    const vids = vidsOf().filter((v) => Number.isFinite(v.duration) && v.duration > 0);
    if (!vids.length) return;
    const times = computeSyncTimes({ progress: p, durations: vids.map((v) => v.duration) });
    vids.forEach((v, i) => {
      try { v.currentTime = Math.min(times[i], v.duration); } catch (_e) { /* metadata 未就绪 seek 拒绝：忽略 */ }
    });
    cells().forEach(refreshCellUi);
  }
  sync.addEventListener("input", () => {
    seekAll(Math.max(0, Math.min(1, (+sync.value || 0) / 1000)));
  });
  // 主格播放联动：timeupdate → 同步条位置跟随（只刷标签·不 seek 其余格——其余格保持各自位置供比对）
  const mainVideo = grid.querySelector(".cmp-cell video");
  if (mainVideo) {
    const mainCell = mainVideo.closest(".cmp-cell") || cells()[0];
    mainVideo.addEventListener("timeupdate", () => {
      const d = mainVideo.duration;
      if (!(Number.isFinite(d) && d > 0)) return;
      const p = Math.max(0, Math.min(1, (+mainVideo.currentTime || 0) / d));
      sync.value = String(Math.round(p * 1000));
      refreshCellUi(mainCell);
    });
    bindCompareSync(mainVideo, grid, vidsOf);
  }
  const { box } = openMbox(t("edit.cmp.cap", { name: main.label, n: versions.length, layout: versions.length === 4 ? t("edit.cmp.layoutGrid") : t("edit.cmp.layoutRow") }), "", body, [[t("edit.common.close"), null]], () => {
    // 关窗停声（主格出声 → 浮层离场前必须先 pause，防声音残留）
    closeCompareSync();
    vidsOf().forEach((v) => { try { v.pause(); } catch (_e) { /* 停播失败不阻关闭 */ } });
  });
  // 批 L1 T3①（R-24 甲）：对比弹窗加大（默认 440px 过小）——width 与 maxWidth 双设：
  //   单设 width 会被 .mbox 的 max-width:720px（edit.css:170）静默钳制。openMbox 工厂本体零改。
  box.style.width = "min(960px,92vw)";
  box.style.maxWidth = "96vw";
}

// ---- D4：成片 GUI 内播放（完成检测 + 浮层）----
// 出处：legacy/app/js/components/final_preview.js:48 showFinalPreview（批 3 F-FINAL）。
// 1.3 差异：不在 components 层建件（本批文件边界只到 views）→ 落在剪辑域（导出成片同文件），
//   shell.js「看成片」/ 预览拼接所选同为消费方；播放走 #44 /h3_batch/video 流式（Range 拖动）。

// 浮层播放（原生 controls；ESC / 点遮罩关闭；close 幂等）
export function showFinalPreview(opts) {
  const o = opts || {};
  if (typeof o.path !== "string" || !o.path) throw new Error("showFinalPreview: path required");
  const title = (typeof o.title === "string" && o.title) ? o.title : t("edit.preview.cap");

  const overlay = document.createElement("div");
  overlay.dataset.h3Role = "final-preview-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:11000;display:flex;align-items:center;justify-content:center;padding:24px";
  const box = document.createElement("div");
  box.style.cssText = "width:min(960px,95vw);max-height:90vh;background:#17171b;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:10px;font-size:13px;color:var(--txt2,#cfd8ff)";
  const titleEl = document.createElement("span");
  titleEl.style.cssText = "flex:1;word-break:break-all";
  titleEl.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghostbtn";
  closeBtn.textContent = t("edit.preview.close");
  head.appendChild(titleEl);
  head.appendChild(closeBtn);
  box.appendChild(head);

  const video = document.createElement("video");
  video.controls = true; // 原生播放器（进度条/音量/全屏）——1.0 final_preview 口径（复用 player.js mountNative）
  video.preload = "metadata";
  video.style.cssText = "width:100%;max-height:70vh;background:#000";
  setMediaSrc(video, "video", o.path);   // 批 B #13：URL 收敛单源+回落接线（引擎口失败 → 本地流）
  box.appendChild(video);

  overlay.appendChild(box);

  let closed = false;
  function onEsc(ev) {
    if (ev && (ev.key === "Escape" || ev.keyCode === 27)) close();
  }
  function close() {
    if (closed) return;
    closed = true;
    try { if (typeof video.pause === "function") video.pause(); } catch (_e) { /* 停播失败不阻关闭 */ }
    try { document.removeEventListener("keydown", onEsc); } catch (_e) { /* 无 document 级监听时忽略 */ }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  closeBtn.addEventListener("click", close);
  // 点遮罩关闭（target === overlay；mousedown 防按钮 click 冒泡误关）
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", onEsc);
  document.body.appendChild(overlay);
  return { overlay, close };
}

// ---- F. 导出成片（批 H T3·伴生渲染管线——执行依据 docs/方案-批H-导出渲染管线-2026-10-06.md）----
//   〔I-P3 收官〕D032 引擎拼接完成检测三件（concatBaseline/concatDonePath/watchConcatDone）已删：
//   批 H T3 双轨接管后全仓零生产消费方（仅自测消费·I-P3 预授权裁决删）——完成检测现走
//   openExportModal 内 job 轮询（下方 F 块）。
//   旧形态 = D032 引擎拼接入口（concat dry_run→真拼接·按版本语义）；批 H 方案 v3 §五 S4 双轨接管：
//   本弹窗改走 /gui13-export 伴生管线（mainClips 序+剪辑态进成片），引擎拼接余两入口
//   （shell.js 按版本拼接 / preview.js 拼接所选）不动。
//   deps（测试注入·缺省真实现）: { api{probe,execute,job,cancel,openDir,ledgerRead,ledgerWrite},
//   toast, intervalMs, maxTicks, preview }；模块级 job 记忆用 _test_resetExportState 清（测试用）。

// 三键档位几何（方案 v3 S-3）：原始=探测尺寸偶数化；1080p/720p=短边对齐目标（横屏=高、竖屏=宽）
//   ·宽高按比例·偶数维（yuv420p/concat 段间硬一致前提）。
export function exportDimsOf(preset, pw, ph) {
  const w0 = Math.max(2, Math.round(+pw || 0));
  const h0 = Math.max(2, Math.round(+ph || 0));
  if (preset !== "1080p" && preset !== "720p") return { w: evenize(w0), h: evenize(h0) };
  const target = preset === "720p" ? 720 : 1080;
  if (w0 >= h0) return { w: evenize((w0 * target) / h0), h: target };
  return { w: target, h: evenize((h0 * target) / w0) };
}
function evenize(n) {
  n = Math.round(+n || 0);
  if (n < 2) return 2;
  return n % 2 ? n - 1 : n;   // 下取偶（防越档放大）
}

// 帧率就近档（24/30/60·探测失败/脏值兜底 30=弹窗缺省档）
export function nearestFpsTier(fps) {
  const f = +fps;
  if (!Number.isFinite(f) || f <= 0) return 30;
  let best = 24;
  for (const t of [24, 30, 60]) if (Math.abs(t - f) < Math.abs(best - f)) best = t;
  return best;
}

// ---- 同源伴生通道（/gui13-* 挂 devserver 8940 同源——server_storage.js 同款理由：
//      走 api.js fetchApi 统一出口 + self 档（恒同源相对·不拼引擎 BASE；地基批1档2 T2 起可用·
//      旧『走该出口会 404』注释作废）；受理/轮询/取消/开目录统一钉 30s 超时（原裸 fetch 零超时·
//      挂死永等·#57 档2 T1）；应答为 devserver 直出 JSON 非引擎信封）----
async function gui13Json(url, init) {
  let resp;
  try {
    resp = await fetchApi(url, { ...init, self: true, timeoutMs: TIMEOUTS.exportAccept });
  } catch (e) {
    return { ok: false, error: (e && e.code === "timeout") ? e.message : "network_error", status: 0 };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { json = null; }
  if (!resp.ok || !json || json.ok !== true) {
    // 批3 T5：400 族带服务端白话 msg（如 bad_outdir 指路文案）·原样带出供调用方逐字承接
    return { ok: false, error: (json && json.error) || ("http_" + resp.status), status: resp.status, msg: (json && json.msg) || "" };
  }
  return { ok: true, data: json, status: resp.status };
}
function gui13ExportPost(body) {
  return gui13Json("/gui13-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function gui13ExportJobGet(id) {
  return gui13Json("/gui13-export?job=" + encodeURIComponent(id), { cache: "no-store" });
}
function gui13OpenDirPost(path) {
  return gui13Json("/gui13-fs/open_dir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
}

const EXPORT_LEDGER_KEY = "data/export_ledger.json";   // 方案 v2 S6 键名（DATA_KEY_RE 白名单内）

// J-P5 裁决 2：导出输出目录持久化 = data/settings.json 聚合子键 export_out_dir（edit.js 本地
//   readAgg/writeAgg 直读写·照 path_picker.js:65 _pickerStartPref 先例·零触碰 settings.js）。
//   空串 = 未选（现状落引擎 output 根·spec 不发 outDir 键）。
//   批3 T5（#51 档2）：写走 saveAggAwait（可等待通道·写语义同 writeAgg）——导出发起前要等
//   这笔保存落定（登记链·方案 v3 §二），故此处交回落定 promise。
function loadExportOutDir() {
  const v = readAgg(SETTINGS_JSON, "export_out_dir");
  return typeof v === "string" ? v.trim() : "";
}
function saveExportOutDir(v) {
  return saveAggAwait(SETTINGS_JSON, "export_out_dir", String(v == null ? "" : v));
}

// J-P5 裁决 5：导出成功自动预览判据——job 回传 outPath（devserver realpath 后下发）的 dirname
//   相对前端两级 output 根解析（_audioRoots.output：①localStorage server_output_dir ②同级推导·
//   audioOutputRootOf 同式）做 underRootRel 同式归一前缀判定。根内=true（现状自动预览）；
//   根外=false；两级根解析失败走缺省分支——outDir 非空按根外（false）·空=现状落位（true）。
//   前端无 realpath·误差方向=误抑制=安全侧可接受。
function exportAutoPreviewOf(outPath, outDirVal) {
  const dir = String(outPath || "").replace(/[\\/][^\\/]+$/, "");
  if (!dir) return true;   // 无 outPath 无判据 → 现状链（showFinalPreview 路径校验兜底）
  const root = (_audioRoots && String(_audioRoots.output || "").trim()) || "";
  if (!root) return !String(outDirVal || "").trim();
  // underRootRel 对「恰等于根」返 null（函数注释口径）——outPath 直接落 output 根是默认形态
  // （空目录=现状落 roots[1]），dirname==root 必须判根内（J4 现状回归·补 dir+"/" 腿）
  return underRootRel(dir, root) !== null || underRootRel(dir + "/", root) !== null;
}

// 模块级 job 记忆：execute 受理的 job_id+账本元数据跨弹窗实例保留（409 busy 恢复轮询用）；
//   轮询单例（防双写账本/双浮层）。_test_resetExportState 供测试清态（api.js _test_setTimeoutMs 先例）。
let _activeExportJobId = "";
let _activeExportMeta = null;
let _activeExportPoll = null;
export function _test_resetExportState() {
  if (_activeExportPoll) _activeExportPoll.stop();
  _activeExportJobId = "";
  _activeExportMeta = null;
  _activeExportPoll = null;
}

// 副标题四要点（裁决 6 非所见即所得项 + S4 双轨预期管理·方案 v3 锁定文案）
//   〔H-P4 D1 修正〕转场行 T7 后改为真实进片口径（音轨硬切如实告知·acrossfade 迭代再裁）
const EXPORT_SUBTITLES = [
  t("edit.export.sub1"),
  t("edit.export.sub2"),
  t("edit.export.sub3"),
];

export function openExportModal(deps = {}) {
  const d = deps || {};
  const toast = d.toast || showToast;
  const preview = d.preview || showFinalPreview;
  const intervalMs = d.intervalMs || 1000;
  const maxTicks = d.maxTicks || 1800;   // 30min 上限=服务端 job 超时窗对齐
  const api = d.api || {
    probe: (files) => gui13ExportPost({ op: "probe", files }).then((r) => (r.ok ? { ok: true, files: r.data.files } : r)),
    execute: (spec) => gui13ExportPost({ op: "execute", spec }).then((r) => (r.ok ? { ok: true, job_id: r.data.job_id } : r)),
    job: (id) => gui13ExportJobGet(id).then((r) => (r.ok ? { ok: true, job: r.data.job, status: r.status } : r)),
    cancel: (id) => gui13ExportPost({ op: "cancel", id }).then((r) => (r.ok ? { ok: true, status: r.data.status } : r)),
    openDir: (path) => gui13OpenDirPost(path),
    ledgerRead: () => getKey(EXPORT_LEDGER_KEY),
    ledgerWrite: (v) => putKey(EXPORT_LEDGER_KEY, v),
  };

  const st = es();
  if (!(st.mainClips || []).some((c) => c && c.file)) {
    const body = document.createElement("div");
    body.textContent = t("edit.export.empty");
    openMbox(t("edit.export.cap"), "", body, [[t("edit.common.close"), null]]);
    return;
  }

  // 三键（方案 v3 S-3）+ 探测默认值（用户显式选择恒优先·S1）
  const probedDims = { w: 1280, h: 720 };   // probe 失败兜底（任务口径 1280x720/30）
  const sel = { res: "orig", fps: 30 };   // fmt 仅 mp4 单选无态（webm 随 T7·不放键）
  let fpsTouched = false;

  function chipRow(labelText, chips, initialKey, onPick) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;color:var(--txt2)";
    const lab = document.createElement("span");
    lab.style.cssText = "width:44px;flex-shrink:0";
    lab.textContent = labelText;
    wrap.appendChild(lab);
    const els = [];
    for (const c of chips) {
      const chip = document.createElement("span");
      chip.className = "fchip" + (c.key === initialKey ? " on" : "");
      chip.textContent = c.text;
      chip.addEventListener("click", () => {
        els.forEach((e) => e.classList.remove("on"));
        chip.classList.add("on");
        onPick(c.key);
      });
      els.push(chip);
      wrap.appendChild(chip);
    }
    return { wrap, els };
  }

  const body = document.createElement("div");
  const resRow = chipRow(t("edit.export.res"), [
    { key: "orig", text: t("edit.export.orig") },
    { key: "1080p", text: "1080p" },
    { key: "720p", text: "720p" },
  ], sel.res, (k) => { sel.res = k; });
  const fpsRow = chipRow(t("edit.export.fps"), [
    { key: "24", text: "24" },
    { key: "30", text: "30" },
    { key: "60", text: "60" },
  ], String(sel.fps), (k) => { sel.fps = +k; fpsTouched = true; });
  const fmtRow = chipRow(t("edit.export.fmt"), [{ key: "mp4", text: "mp4" }], "mp4", () => {});
  const origChip = resRow.els[0];
  body.appendChild(resRow.wrap);
  body.appendChild(fpsRow.wrap);
  body.appendChild(fmtRow.wrap);

  // 输出目录行（J-P5 裁决 2/3）：输入+浏览钮（openPicker dir 模式·settings.js _browseBtn 接法——
  //   选中回填+派发 change 走既有落盘链）。空 = 现状引擎 output 根（零变化·不复用 server_output_dir）。
  const outDirRow = document.createElement("div");
  outDirRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;color:var(--txt2)";
  const outDirLab = document.createElement("span");
  outDirLab.style.cssText = "width:56px;flex-shrink:0";
  outDirLab.textContent = t("edit.export.outDir");
  outDirRow.appendChild(outDirLab);
  const outDirInput = document.createElement("input");
  outDirInput.type = "text";
  outDirInput.dataset.h3Role = "export-out-dir";
  outDirInput.placeholder = t("edit.export.outDirPh");
  outDirInput.title = t("edit.export.outDirTitle");
  outDirInput.style.cssText = "flex:1;min-width:0";
  outDirInput.value = loadExportOutDir();
  // 批3 T5（#51 档2·方案 v3 §二「登记=GUI 显式动作 + 导出发起前 await 保存链完成」）：
  //   change 触发的写是异步的（PUT 可能还在途）——记下它的落定 promise，导出发起前先等它落定
  //   （登记链：导出发起时服务端须已认得这个目录，否则回 400 bad_outdir 白话）。
  let outDirSavePending = null;
  outDirInput.addEventListener("change", () => { outDirSavePending = saveExportOutDir(outDirInput.value); });
  outDirRow.appendChild(outDirInput);
  const outDirBrowseBtn = document.createElement("button");
  outDirBrowseBtn.type = "button";
  outDirBrowseBtn.className = "ghostbtn";
  outDirBrowseBtn.title = t("edit.export.browseTitle");
  outDirBrowseBtn.textContent = t("edit.common.browse");
  outDirBrowseBtn.addEventListener("click", () => {
    openPicker({
      title: t("edit.export.browseTitle"),
      mode: "dir",
      current: outDirInput.value,
      onPick: (p) => {
        outDirInput.value = p;
        outDirInput.dispatchEvent(new Event("change"));
      },
    });
  });
  outDirRow.appendChild(outDirBrowseBtn);
  body.appendChild(outDirRow);

  // skipped 列明（验收 4）：开窗即按当前状态预渲染·点导出时重算
  const skippedEl = document.createElement("div");
  skippedEl.dataset.h3Role = "export-skipped";
  skippedEl.style.cssText = "display:none;font-size:12px;color:var(--warn);margin-top:10px;line-height:1.7";
  body.appendChild(skippedEl);

  // 进度区（轮询中现值）+ 失败重试 + 完成打开文件夹
  const progressEl = document.createElement("div");
  progressEl.dataset.h3Role = "export-progress";
  progressEl.style.cssText = "display:none;font-size:12px;color:var(--txt2);margin-top:10px;line-height:1.7";
  const phaseEl = document.createElement("div");
  progressEl.appendChild(phaseEl);
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "ghostbtn";
  retryBtn.textContent = t("edit.export.retry");
  retryBtn.style.display = "none";
  retryBtn.addEventListener("click", () => { void doExport(); });
  progressEl.appendChild(retryBtn);
  const openDirBtn = document.createElement("button");
  openDirBtn.type = "button";
  openDirBtn.className = "ghostbtn";
  openDirBtn.textContent = t("edit.export.openDir");
  openDirBtn.style.display = "none";
  let doneOutPath = "";
  openDirBtn.addEventListener("click", async () => {
    if (!doneOutPath) return;
    const r = await api.openDir(doneOutPath.replace(/[\\/][^\\/]+$/, ""));
    if (!r || !r.ok) toast("error", t("edit.export.openDirFail") + ((r && r.error) || ""));
  });
  progressEl.appendChild(openDirBtn);
  body.appendChild(progressEl);

  // 动作行：导出钮不进 openMbox foot（foot 点击先关窗·而导出要留在弹窗内看进度）
  const actRow = document.createElement("div");
  actRow.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:12px";
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "prim";
  exportBtn.textContent = t("edit.export.cap");
  exportBtn.addEventListener("click", () => { void doExport(); });
  actRow.appendChild(exportBtn);
  const cancelJobBtn = document.createElement("button");
  cancelJobBtn.type = "button";
  cancelJobBtn.className = "ghostbtn";
  cancelJobBtn.textContent = t("edit.export.cancelJob");
  cancelJobBtn.style.display = "none";
  let pollingJobId = "";
  cancelJobBtn.addEventListener("click", async () => {
    if (!pollingJobId) return;
    const r = await api.cancel(pollingJobId);
    if (!r || !r.ok) toast("error", t("edit.export.cancelFail") + ((r && r.error) || ""));
    // 终态由下一轮轮询呈现（status=cancelled）
  });
  actRow.appendChild(cancelJobBtn);
  body.appendChild(actRow);

  // 忙态三控件同翻转（J-P5 T3·P1）：导出链各臂 exportBtn 翻转时目录输入/浏览钮同步（六处翻转臂共用）
  function setExportBusy(b) {
    exportBtn.disabled = b;
    outDirInput.disabled = b;
    outDirBrowseBtn.disabled = b;
  }

  openMbox(t("edit.export.cap"), "· " + EXPORT_SUBTITLES.join("<br>· "), body, [[t("edit.common.close"), null]]);

  function renderSkipped(list) {
    skippedEl.textContent = "";
    if (!list || !list.length) { skippedEl.style.display = "none"; return; }
    const head = document.createElement("div");
    head.textContent = t("edit.export.skippedHead", { n: list.length });
    skippedEl.appendChild(head);
    for (const s of list) {
      const row = document.createElement("div");
      row.textContent = (s.n ? t("edit.export.skippedSeg", { n: s.n }) : "") + `${s.label}：${s.reason}`;
      skippedEl.appendChild(row);
    }
    skippedEl.style.display = "block";
  }
  renderSkipped(buildExportSpec(st, { w: probedDims.w, h: probedDims.h, fps: sel.fps }).skipped);

  // 开窗即探首个有 file 段取默认 w/h/fps（不阻塞弹窗·失败保持兜底值）
  const firstFile = ((st.mainClips || []).find((c) => c && c.file) || {}).file;
  if (firstFile) {
    api.probe([firstFile]).then((r) => {
      const f = (r && r.ok && r.files && r.files[0]) || null;
      if (f && f.w && f.h) {
        probedDims.w = f.w;
        probedDims.h = f.h;
        origChip.textContent = t("edit.export.origDims", { w: f.w, h: f.h });
        if (!fpsTouched && f.fps) {
          sel.fps = nearestFpsTier(f.fps);
          fpsRow.els.forEach((e) => e.classList.toggle("on", e.textContent === String(sel.fps)));
        }
      } else {
        origChip.textContent = t("edit.export.origFallback", { w: probedDims.w, h: probedDims.h });
      }
    }).catch(() => {
      origChip.textContent = t("edit.export.origFallback", { w: probedDims.w, h: probedDims.h });
    });
  }

  // 导出账本（方案 v3 S-4）：GET 旧账（缺键=null→[]）→追加→PUT 回写·失败明示不静默丢
  async function writeLedger(job, meta) {
    try {
      const old = await api.ledgerRead();
      const arr = Array.isArray(old && old.data) ? old.data : [];
      arr.push({
        ts: new Date().toISOString(),
        jobId: job.id || _activeExportJobId,
        outPath: job.outPath,
        wh: meta.wh, fps: meta.fps, segs: meta.segs, bgm: meta.bgm, skipped: meta.skipped,
      });
      const r = await api.ledgerWrite(arr);
      if (!r || !r.ok) toast("error", t("edit.export.ledgerFail"));
    } catch (_e) {
      toast("error", t("edit.export.ledgerFail"));
    }
  }

  function enterProgress(jobId, meta) {
    if (_activeExportPoll) _activeExportPoll.stop();   // 轮询单例（busy 恢复/重开弹窗防双写）
    pollingJobId = jobId;
    progressEl.style.display = "block";
    retryBtn.style.display = "none";
    openDirBtn.style.display = "none";
    cancelJobBtn.style.display = "";
    setExportBusy(true);
    let ticks = 0;
    let stopped = false;
    let timer = null;
    const handle = {
      stop() {
        stopped = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (_activeExportPoll === handle) _activeExportPoll = null;
      },
    };
    _activeExportPoll = handle;
    function finishFail(msg) {
      handle.stop();
      phaseEl.textContent = t("edit.export.fail") + msg;
      cancelJobBtn.style.display = "none";
      retryBtn.style.display = "";
      setExportBusy(false);
    }
    function finishCancelled() {
      handle.stop();
      phaseEl.textContent = t("edit.export.cancelled");
      cancelJobBtn.style.display = "none";
      setExportBusy(false);
    }
    async function finishOk(job) {
      handle.stop();
      phaseEl.textContent = t("edit.export.done");
      cancelJobBtn.style.display = "none";
      doneOutPath = String(job.outPath || "");
      openDirBtn.style.display = "";
      setExportBusy(false);
      await writeLedger(job, meta);
      const outPath = String(job.outPath || "");
      if (!exportAutoPreviewOf(outPath, outDirInput.value)) {
        // 裁决 5：根外/缺省分支——引擎 /h3_batch/video 根外 400·跳自动预览出指引（打开文件夹钮在位可开目录）
        toast("info", t("edit.export.doneAt") + outPath.replace(/[\\/][^\\/]+$/, "") + t("edit.export.doneAtTail"));
        return;
      }
      try {
        preview({ path: job.outPath, title: t("edit.export.filmTitle") + outPath.replace(/^.*[\\/]/, "") });
      } catch (_e) {
        toast("error", t("edit.export.playFail"));
      }
    }
    async function tick() {
      if (stopped) return;
      ticks++;
      let r = null;
      try { r = await api.job(jobId); } catch (_e) { r = null; }
      if (stopped) return;
      const job = (r && r.ok && r.job) || null;
      if (job) {
        if (job.phase) phaseEl.textContent = t("edit.export.progress") + job.phase;
        if (job.status === "success") { void finishOk(job); return; }
        if (job.status === "failed") { void finishFail(job.error || t("edit.export.errFfmpeg")); return; }
        if (job.status === "cancelled") { void finishCancelled(); return; }
        if (job.status === "timeout") { void finishFail(job.error || t("edit.export.errTimeout")); return; }
      } else if (r && r.status === 404) {
        void finishFail(t("edit.export.errLost"));
        return;
      }
      if (ticks >= maxTicks) { void finishFail(t("edit.export.errPollTimeout")); return; }
      timer = setTimeout(() => { void tick(); }, intervalMs);
    }
    void tick();   // 首拍立即（不等首个周期）
  }

  async function doExport() {
    const dims = exportDimsOf(sel.res, probedDims.w, probedDims.h);
    const { spec, skipped } = buildExportSpec(es(), { w: dims.w, h: dims.h, fps: sel.fps, outDir: outDirInput.value.trim() });
    renderSkipped(skipped);
    if (!spec.main.length) { toast("error", t("edit.export.noClips")); return; }
    setExportBusy(true);
    progressEl.style.display = "block";
    retryBtn.style.display = "none";
    phaseEl.textContent = t("edit.export.probing");
    // R56R57-S3 T4: 导出清单逐段经显示源解析换最终版（显式动作可等；胶合层 miss/IO 故障
    //   容错=原产物路径原样·level none 不落替换）。只换 file·triml/dur/segId 等字段原样。
    const srcs = await Promise.all(spec.main.map((m) => postfxSrcOf({ file: m.file })));
    spec.main = spec.main.map((m, i) =>
      (srcs[i] && srcs[i].level !== "none" && srcs[i].file) ? { ...m, file: srcs[i].file } : m);
    // probe 全段（file 去重·逐文件失败容忍——T1 probe 端点 all-or-nothing，坏一档不拖累其余真实时长）
    const uniq = [...new Set(spec.main.map((m) => m.file))];
    const files = (await Promise.all(uniq.map((f) =>
      api.probe([f]).then((r) => ((r && r.ok && r.files && r.files[0]) || null)).catch(() => null)
    ))).filter(Boolean);
    const meta = { wh: dims.w + "x" + dims.h, fps: sel.fps, segs: spec.main.length, bgm: spec.bgm.length, skipped: skipped.length };
    // 批3 T5（#51 档2·方案 v3 §二）：导出发起（受理请求）前先等 export_out_dir 的保存链落定
    //   ——弹窗 change 触发的写是异步的，未落定就发导出请求会撞上「目录未登记」400。
    if (outDirSavePending) await outDirSavePending;
    let r = null;
    try { r = await api.execute(mergeProbedDurations(spec, files)); } catch (_e) { r = null; }
    if (!(r && r.ok && r.job_id)) {
      setExportBusy(false);
      progressEl.style.display = "none";
      if (r && r.status === 409) {
        toast("info", t("edit.export.busy"));
        if (_activeExportJobId) enterProgress(_activeExportJobId, _activeExportMeta || meta);
        return;
      }
      // 400 bad_outdir 白话承接（批3 T4 服务端落的指路文案）：逐字透传服务端 msg（无 msg 才回退本地文案）
      //   ·不进既有错误链（非系统错误·是「目录未登记·去弹窗存一次」的自愈指路）
      if (r && r.status === 400 && r.error === "bad_outdir") {
        toast("info", (r && r.msg) || t("edit.export.badOutdir"));
        return;
      }
      toast("error", t("edit.export.startFail") + ((r && r.error) || t("edit.export.netUnreach")));
      return;
    }
    _activeExportJobId = r.job_id;
    _activeExportMeta = meta;
    enterProgress(r.job_id, meta);
  }
}

// ============================================================================
// S1-3 T6d → M6-T1 演化: 剪辑区「超分/插帧」两钮 = openPostfxPick 全参数面板直执行
//   （方案-批M6 §一·真执行链取代批F 指引 toast 哑弹止损）+ 止损（D037·真 cancel 端点）
// ============================================================================

// D037 止损（v43 cutConfirm 两次确认 + 引擎 cancel 真端点）
let _cutArm = 0;
export async function cutConfirm(btn) {
  if (Date.now() - _cutArm < 3000) {
    _cutArm = 0;
    if (btn) btn.textContent = t("edit.cut.cap");
    const r = await request("/h3_batch/cancel", { method: "POST" });
    // cancel 响应 = 旧信封 {cancelled, msg}（归一层 → ok:true, data:{cancelled, msg}）
    if (r.ok && r.data && r.data.cancelled === true) {
      showToast("success", t("edit.cut.done"));
      // B5-T2 ④：引擎确认停止 → 通知中心留档（编辑视图无段级数据 → 无 N 兜底文案；动态 import 同 core 惯例）
      try {
        import("../ui/notif.js").then((m) => {
          if (m && typeof m.push === "function") m.push(stoppedNotifEntry(null));
        }).catch(() => { /* 通知中心不可用不影响止损链 */ });
      } catch (_) { /* 静默 */ }
    } else {
      showToast("info", (r.data && r.data.msg) || t("edit.cut.none"));
    }
  } else {
    _cutArm = Date.now();
    if (btn) btn.textContent = t("edit.cut.arm");
    showToast("info", t("edit.cut.armHint"));
    setTimeout(() => { if (btn && _cutArm && Date.now() - _cutArm >= 2900) { _cutArm = 0; btn.textContent = t("edit.cut.cap"); } }, 3100);
  }
}
