// preview.js — 项目预览 TAB（批 R3 · ② A05-A12/B07 · v43 :1194-1212）
//
// === 出处注记（v43 原型实测行号） ===
//   - 操作条 :1195-1201（审片 ghostbtn :1196 / 状态灯 :1197 / 止损 :1198 / 监控墙 :1199 / .inh :1200）
//   - .player :1202-1205（时长行 :1204 · F54 删自制播放钮 .scr）+ CSS :192/:755
//   - .filmstrip :1206-1212（4×.fsthumb 三态+审计态 + .fs-stitch-btn :1211）+ CSS :261-275
//   - 多选/拼接 JS :3075-3113（fsClick 单击多选 / fsStitch / 点空白清选）
//
// === 选型说明（任务单 shell.js 或 preview.js 二选一） ===
//   选新建本模块：与 setup.js/edit.js 同形（shell 只留一行接线），shell.js 不再膨胀。
//
// === 三按钮迁移（B07 · 剪辑 TAB → 预览操作条） ===
//   审片 = edit.openReviewModal / 止损 = edit.cutConfirm / 监控墙 = edit.monToggle+buildMonDrawer
//   —— 直接复用 edit.js 既有导出（最小改动，不搬逻辑）。剪辑工具条对应两键已迁出。
//
// === 数据接线（以既有通道为限） ===
//   - 三态 done/warn/empty：store 项目 editingState.mainClips[].state（历史载入映射既有字段）
//   - 审计态 audited-ok/bad：clip.review（approved/void · 引擎 review 语义，rerun.js 同源）；缺省不编造
//   - 拼接所选：core/concat.js（taskId=editingState.loadedTaskId · mode=global 既有口径）
//   - 播放：mainClips[].file → /h3_batch/video?path=（edit.js 播放器同通道）；无产物=占位文案态
//   - 状态灯：runs[0] 派生运行态（G1.5·#49 接通·同顶栏口径）；runs 缺席回退 proj.runState（退役字段）
//   - 批 1-T3 · C3：状态灯件内嵌统一进度条（ui/progress.js·阶段文案+已等待计时）
//
// === B7-T1 · C1 实时推流（ComfyUI 原生 /ws） ===
//   - 摘静态占位：状态灯「实时预览已开」后缀与 .inh 先行文案（v43 :1197/:1200）——真连接态归降级条
//   - .player 内 live 块：三态降级条 + 帧宿主 img（blobUrl）+ live 进度宿主（percent 态·ui/progress.js）
//     （批5-R54-T2：三件迁实时预览子页——帧/视频不同框·互挡治理；出处注记保留原位）
//   - 模块级最新帧/状态/进度缓存：帧到达时未挂载先存·mount 时消费最新 blobUrl·最新帧胜出+上帧 revoke
//     （提交点常在 setup/edit TAB——跨 TAB 重挂存活；提交侧接线在 views/submit-bar.js）
//   - 降级条三态：open=实时预览已连接 / retrying=重连中 / closed=已断开·轮询兜底中；空态隐藏
//     批2 T4 · 账本 #58 增第五态 exhausted=已断开·重连已放弃·轮询兜底中（唯一带「重新连接」钮的态）

import { load as storeLoad, removeSegment, save as storeSave, subscribe as storeSubscribe, unsubscribe as storeUnsubscribe, markClipReview, latestMainRunStem, currentRunRow, isRunPointerPinned } from "../store/store.js";
import { mediaUrl, wireBgMediaFallback } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源（引擎口优先+离线回落）
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import { openReviewModal, cutConfirm, createDualVideo, filmstripFor } from "./edit.js"; // 批 F91a：双缓冲换源件与剪辑页同源（preview→edit 依赖同向·不新建文件）
import { buildPvPreview } from "./pvbox.js"; // 批5-R54-T3：分镜提示词合成纯函数只读复用（pvbox 零改动·引擎离线可用）
// 批 J-P14：filmstripFor 同向复用剪辑页 canvas 采样（连带 Map<file,Promise> 缓存 + 串行队列·
//   并发上限 1·防 F90 那条「三段同图」的多协程互踩 src）。详见 buildFilmstrip 段注记。
import { runRerunFlow } from "./rerun_flow.js"; // F65：预览两重跑入口接 runRerunFlow 同链（落账+轮询+回轨·edit.js 同款）
import { concat as concatApi } from "../core/concat.js";
import { sameSeed } from "../core/rerun.js"; // 10-E-T3：同种子重跑（全部段·首调+force 重发）·F65：重跑此段改走 rerun_flow.js
import { approve as approveApi, voidSeg as voidSegApi } from "../core/review.js"; // F46①：审核通过/不通过
import { openConfirm, open as openModal } from "../ui/modal.js"; // F46①：删除确认（mbox 形态确认件·主代理追认②①）；R-34：错误详情只读层复用 open builder
import { request } from "../core/api.js"; // 批 L1 T2 R-27：打开成片目录直取 /h3_batch/history/detail 原始信封（concat 只在 raw 顶层）
import { openDirRequest, firstRunDirFromShots } from "../core/open_dir.js"; // R-31 收敛：open_dir 发包+三分文案 / run_dir 解析单源
// 批 1-T3 · C3：统一进度条（阶段文案+已等待计时 · 1.0 progress_bar.js 口径）
import { renderProgress, parseRunStamp, fmtElapsed } from "../ui/progress.js";
// 批2 T4（账本 #58）：降级条「重新连接」钮 → 统一重建在册 WS（core/push.js·地基批1 T3 的 rebuildAllLive）
import { rebuildAllLive } from "../core/push.js";
import { t, pickDisplay } from "../core/i18n.js";   // #89 T2：预览页用户可见文案取词（preview.*·切换=整页 reload 故模块级常量同语言一致）；#92 B7 参数块数据映射走 pickDisplay

function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// —— 胶片条段态派生（纯函数 · 经 DOM 断言覆盖）——
// 三态：clip.state done/warn → 带时长段标；其余（无 clip / empty）→ 待生成
// 审计态：clip.review approved→audited-ok / void→audited-bad（缺省 = 未审默认态，不编造）
function deriveThumb(seg, clip, n) {
  const st = clip && typeof clip === "object" ? clip.state : null;
  let cls, state, label, els = NaN; // R-33：实际渲染耗时秒（两入库通道映射·有值才展示）
  if (st === "done" || st === "warn") {
    cls = `fsthumb ${st}`;
    state = st === "done" ? "ok" : "pending";
    // 走查反馈 F26（老板「变速后预览视频时长还是原时长」）：标签按有效时长 = dur ÷ speed
    //   （与剪辑时间线 F4 同口径；speed 脏值兜底 1）
    const raw = Number(clip.dur != null ? clip.dur : (seg && seg.durationSec));
    const spd = Number(clip.speed);
    const spdSafe = Number.isFinite(spd) && spd > 0 ? spd : 1;
    const eff = Number.isFinite(raw) && raw > 0 ? raw / spdSafe : 5;
    const dur = Math.round(eff);
    label = t("preview.thumb.seg", { n, dur });
    // R-33（概况页每片段实际耗时）：done/warn 且有限数 → 段标追加「· Ns」（贴 ·Ns 短式）
    const e = Number(clip.elapsedSec);
    if (Number.isFinite(e)) { els = e; label += ` · ${Math.round(e)}s`; }
  } else {
    cls = "fsthumb empty";
    state = "pending";
    label = t("preview.thumb.pending", { n });
  }
  const rev = clip ? clip.review : null;
  // 批 F98-B（老板 2026-10-03 深夜裁 B）：未审点中性灰后与「不通过」灰同阶·仅靠色不可辨
  //   → title 挂缩略本体给三态文字（挂点位 .fsthumb-dot 有 pointer-events:none·悬停永不触发）。
  //   文案判据与上面的审计类同源（review 值），不另立口径。
  let title = t("preview.thumb.unreviewed");
  if (rev === "approved") { cls += " audited-ok"; title = t("preview.review.ok"); }
  else if (rev === "void") { cls += " audited-bad"; title = t("preview.review.bad"); }
  // R-33：title 追加渲染耗时（fmtElapsed 入参毫秒 = 秒×1000；只追加不替换审核态前缀）
  if (Number.isFinite(els)) title += t("preview.thumb.elapsed", { ms: fmtElapsed(els * 1000) });
  return { cls, state, label, title };
}

// —— 全片总时长 mm:ss（纯函数）——
function fmtTotal(segs) {
  const total = (Array.isArray(segs) ? segs : []).reduce((a, s) => {
    const d = Number(s && s.durationSec);
    return a + (Number.isFinite(d) && d > 0 ? d : 0);
  }, 0);
  const t = Math.round(total);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// —— 拼接所选 → core/concat.js 既有通道（deps 可注入 stub）——
export async function stitchSelected(segs, deps = {}) {
  const toast = deps.toast || showToast;
  const concatFn = deps.concat || concatApi;
  const list = Array.isArray(segs) ? segs : [];
  if (list.length < 2) {
    toast("info", t("preview.stitch.tooFew"));
    return { ok: false, code: "too_few" };
  }
  const proj = storeLoad(deps.projectId || "");
  const st = proj && proj.editingState && typeof proj.editingState === "object" ? proj.editingState : null;
  const taskId = (st && st.loadedTaskId) || "";
  if (!taskId) {
    toast("error", t("preview.stitch.noTask"));
    return { ok: false, code: "no_task" };
  }
  // F106 B 档：过期指向改用最近一次主链全量运行（不拼出旧任务产物·resolveCurrentTaskId 见右键链）
  const r = await concatFn({ taskId: resolveCurrentTaskId(deps.projectId || "", taskId, toast), mode: "global" });
  if (r && r.ok) toast("success", t("preview.stitch.started", { n: list.length }));
  else toast("error", t("preview.stitch.fail", { msg: (r && r.error && r.error.msg) || "" }));
  return r || { ok: false };
}

// —— 监控墙入口（B07 迁入 · F31 下线：抽屉不再建——运行状态归顶栏项目概况；函数留档兼容）——
export function monWallClick(btn) {
  if (typeof document === "undefined") return;
  if (btn) btn.textContent = t("preview.monwall.offline");
}

// 批 1-T3 · C3：统一进度条句柄（挂载期持有·卸载/重挂即停表·防 interval 泄漏）
let _pvProg = null;
let _pvLastPercent = null; // G1·#49：概况页条当前 percent 基线（meta-update 比对变化才 update）
function _progDestroy() {
  if (!_pvProg) return;
  try { _pvProg.destroy(); } catch (_e) { /* 停表失败不阻卸载 */ }
  _pvProg = null;
  _pvLastPercent = null;
}

// ============================================================================
// B7-T1 · C1 实时推流消费面：模块级 live 缓存（帧/状态/进度——跨 TAB 重挂存活）
//   推送入口（submit-bar 接线 connectLive 后调）：
//     pushLiveFrame(blobUrl)           帧到达（未挂载先存·最新帧胜出+上帧 revoke）
//                                     （批 9 T3 · 18-1：push.js onFrame 第二参 meta 无消费面——死状态清理，不入缓存）
//     pushLiveStatus(kind)           open|retrying|closed|error|exhausted 五态降级条（"" 隐藏·运行结束）
//     pushLiveProgress(percent)      0..1 真进度（null=断流回退 phase 态）
// ============================================================================
const LIVE_STATUS_TEXT = {
  open: t("preview.live.open"),
  retrying: t("preview.live.retrying"),
  closed: t("preview.live.closed"),
  // 批 9 T3 · 18-3：push.js ws.onerror 实发 error 态——此前无键走「预览状态: error」兜底闪现
  error: t("preview.live.error"),
  // 批2 T4（账本 #58）：push.js 退避耗尽终态——此前与 closed 同文案，用户无从得知重连已放弃
  exhausted: t("preview.live.exhausted"),
};
let _live = { blobUrl: null, status: "", percent: null };
let _liveEls = null;   // 当前挂载的 live DOM 引用 { img, degraded, progHost }（卸载置 null·缓存保留）
let _liveProg = null;  // live 进度句柄（renderProgress·卸载/重挂即停表）

function _liveProgDestroy() {
  if (!_liveProg) return;
  try { _liveProg.destroy(); } catch (_e) { /* 停表失败不阻卸载 */ }
  _liveProg = null;
}

function _revokeLiveFrame() {
  if (!_live.blobUrl) return;
  try { URL.revokeObjectURL(_live.blobUrl); } catch (_e) { /* 已失效忽略 */ }
}

function _applyLiveFrame() {
  if (!_liveEls || !_live.blobUrl) return;
  _liveEls.img.src = _live.blobUrl;
  _liveEls.img.style.display = "";
  if (_liveEls.empty) _liveEls.empty.style.display = "none"; // 批5-R54-T2：有帧 → 空态退场（不与帧同屏）
}

// 批5-R54-T2：空态显隐（无 live 帧+无运行任务 → 占位可见）——mount 消费缓存时按当下态计算
function _applyLiveEmpty(running) {
  if (!_liveEls || !_liveEls.empty) return;
  _liveEls.empty.style.display = (!_live.blobUrl && !running) ? "" : "none";
}

// 批2 T4（账本 #58）：降级条重连钮（**仅 exhausted 态渲染**·其余四态零钮）——
//   样式循本域既有按钮类 .ghostbtn（审片/止损同款·不加新 css 文件），
//   点钮 → rebuildAllLive()：在册 WS 各重建一次（retries 归零+立即 open·既有世代号机制）；
//   连上后由既有状态机（onStatus open）把降级条带回 open 态并退场本钮（textContent 重写清子节点）。
function _liveReconnectBtn() {
  const btn = el("span", {
    class: "ghostbtn",
    "data-h3-role": "preview-reconnect",
    style: "margin-left:8px;padding:1px 8px;font-size:12px",
    title: t("preview.live.reconnectTitle"),
  }, [t("preview.live.reconnect")]);
  btn.addEventListener("click", () => { rebuildAllLive(); });
  return btn;
}

function _applyLiveStatus() {
  if (!_liveEls) return;
  const k = _live.status;
  if (!k) {
    _liveEls.degraded.style.display = "none";
    _liveProgDestroy();                       // 运行结束（onFinal 置空）→ live 进度停表隐藏
    _liveEls.progHost.style.display = "none";
    return;
  }
  _liveEls.degraded.style.display = "";
  _liveEls.degraded.textContent = LIVE_STATUS_TEXT[k] || t("preview.live.statusFallback", { k });
  if (k === "exhausted") _liveEls.degraded.appendChild(_liveReconnectBtn());
}

export function pushLiveFrame(blobUrl) {
  if (!blobUrl) return;
  _revokeLiveFrame();                         // 最新帧胜出 + 上帧 revoke（blob 内存不堆积）
  _live.blobUrl = blobUrl;
  _applyLiveFrame();
}

export function pushLiveStatus(kind) {
  _live.status = String(kind || "");
  _applyLiveStatus();
}

export function pushLiveProgress(percent) {
  const p = (typeof percent === "number" && Number.isFinite(percent)) ? percent : null;
  _live.percent = p;
  if (!_liveEls) return;
  if (p == null && !_liveProg) return;        // 无表可更（从未亮过即无事可回退）
  if (p != null && !_liveProg) {
    _liveProg = renderProgress(_liveEls.progHost, { phaseText: t("preview.prog.rendering"), startedAtMs: Date.now() });
    _liveEls.progHost.style.display = "";
  }
  _liveProg.update({ percent: p });
}

let _testDualRef = null;   // 当前概况页播放器的双缓冲句柄（测试注入位 + unmount 清理）

// #68：销毁当前双缓冲句柄（工厂 destroy 内已暂停+摘元素）——unmount / 重挂前调用，
//   杜绝脱离 DOM 的旧 video 后台放音（听位≠看位干扰复验）。
function _dualDestroy() {
  if (_testDualRef) {
    try { _testDualRef.destroy(); } catch (_e) { /* 桩缺/重复卸载不阻 */ }
  }
  _testDualRef = null;
}

// 批 10-L F91a：测试注入位——模拟备位首帧就绪（生产由 canplay 监听驱动换位）
export function _test_promotePlayer() {
  if (!_testDualRef) return false;
  _testDualRef.promote();
  return true;
}

// 测试隔离钩子（api.js _test_resetTimeoutMs 同款注入位）
export function _test_resetLive() {
  _revokeLiveFrame();
  _live = { blobUrl: null, status: "", percent: null };
  _liveProgDestroy();
}

// 走查反馈 F19（老板「项目管理里的监控墙总是遮挡元素」根因: preview 挂 body 的 monDrawer
//   单例无卸载——离开预览 TAB/项目工作区后抽屉残留 body·带到项目列表页遮挡）：
//   对称补卸载（edit.unmount 早有同款摘除；shell 路由切换统一调用·幂等）。
export function unmount() {
  _progDestroy();
  _liveProgDestroy();  // B7-T1：live 进度停表（帧/状态缓存保留——跨挂载存活）
  _filmDestroy();      // 批 J-P14：断胶片条视口观察者（防留旧挂载句柄）
  _liveEls = null;     // 摘当前挂载引用（后续推送只入缓存）
  _dualDestroy();      // #68：摘双缓冲句柄前先暂停+销毁（旧 video 不留后台放音）
  // 批 10-L L1-3 修正笔：退订产物入轨订阅 + 摘重挂句柄（否则离开项目后仍持旧 container/projectId）
  if (_subFn) { storeUnsubscribe(_subFn); _subFn = null; }
  _fsRemount = null;
  _pvSub = null;       // 批5-R54-T1：摘子页签上下文（applyPreviewSubTab 挂载期才生效·_liveEls 同款）
  onSubTabShown(null); // 批5-R54-T3：摘子页刷新钩子（防留旧挂载闭包·同 _fsRemount/_pvSub 摘除惯例）
  const d = typeof document !== "undefined" ? document.getElementById("monDrawer") : null;
  if (d) d.remove();
}

// ===== 操作条（公共区·v43 :1195-1201 · 外层内联样式照搬）=====
// 批5-R54-T1：审片钮迁视频子页左上（行为不变位置迁移）；批5-R54-T2：止损钮迁 live 子页
//   左上（click→hooks.cut 链不变·位置迁移）——本件只剩状态灯。
// G1.5·#49：runs[0] → 状态灯/进度条运行态（形态同 shell.js runStateFromRuns·仅取本件消费的四字段）
function _rsFromRun0(run0) {
  if (!run0 || typeof run0 !== "object") return null;
  return {
    running: !!run0.running,
    total: Number.isFinite(+run0.total) ? +run0.total : 0,
    done: Number.isFinite(+run0.done) ? +run0.done : 0,
    lastRunAt: run0.at || "",
  };
}

function buildOpBar(ctx) {
  const bar = el("div", {
    style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px",
  });
  // 状态灯（:1197 · 无运行态整件隐藏）。G1.5·#49 建条源接通：runs 行派生运行态（登记项 7：
  // runState 无人写已退役·submit 落账 runs 真数据；与顶栏 runStateFromRuns 同源同口径——
  // shell→preview 既有依赖不可反向 import，本地同形派生四字段）。runs 行缺席回退退役
  // runState（旧档/既有用例形态）·行在场即以行为准（僵尸陈旧值不压制活动批）。
  const rs = _rsFromRun0(ctx.run0) || ctx.runState;
  const running = !!(rs && rs.running);
  const totalN = rs && Number.isFinite(+rs.total) ? +rs.total : ctx.segs.length;
  const doneN = rs && Number.isFinite(+rs.done) ? +rs.done : 0;
  const statusSpan = el("span", {
    style: running ? "font-size:12px;color:var(--txt2)" : "font-size:12px;color:var(--txt2);display:none",
  }, [
    el("span", {
      class: "lamp",
      style: running ? "background:var(--warn);display:inline-block;margin-right:5px" : "display:none",
    }),
    // B7-T1：摘「实时预览已开」静态占位（v43 :1197）——真连接态归 live 块降级条
    t("preview.prog.segRendering", { done: doneN, total: totalN }),
  ]);
  // 批 1-T3 · C3：运行态补统一进度条（阶段+已等待·ui/progress.js）；无运行态不挂
  if (running) {
    const progHost = el("span", { class: "pv-prog", style: "display:inline-flex;align-items:center;gap:6px;margin-left:8px" });
    statusSpan.appendChild(progHost);
    _pvProg = renderProgress(progHost, { phaseText: t("preview.prog.rendering"), startedAtMs: parseRunStamp(rs && rs.lastRunAt) });
    // G1·#49：建条即喂存量 runs 行 percent（行无字段 → phase 态·progress.js 契约）；基线记档供订阅比对
    const _pct0 = (ctx.run0 && typeof ctx.run0.percent === "number" && Number.isFinite(ctx.run0.percent)) ? ctx.run0.percent : null;
    _pvLastPercent = _pct0;
    if (_pct0 != null) _pvProg.update({ percent: _pct0 });
  }
  bar.appendChild(statusSpan);
  // 批5-R54-T2：止损钮迁 live 子页左上（原 :1198 id+行内配色+文案随件·click→hooks.cut 链不变）
  // 走查反馈 F31（老板「监控墙去掉·可被项目概况取代」·2026-09-27 两连点名）：
  //   监控墙按钮下线——运行状态看顶栏项目概况（状态条/lamp 真数据·3911ee2）；
  //   monWallClick 函数保留（历史引用兼容）·不再建抽屉
  // B7-T1：.inh 先行文案（「渲染中此 TAB 自动切为实时预览」v43 :1200）已摘——
  //   自动切 TAB 未实现（登记不阻断），实时预览真画面在 .player live 块
  return bar;
}

// ===== 全片预览播放器（v43 :1202-1205 · 有产物可播/无产物占位）=====
function buildPlayer(segs, clips, toast) {
  const player = el("div", { class: "player" });
  // F 块·顺序连播位：起播后实时显示「第 N/M 段」（M=有产物可播段数·未播为空串不占位）
  const seqEl = el("span", { style: "font-size:12px" });
  player.appendChild(el("span", { style: "font-size:12px" }, [
    t("preview.player.total", { n: segs.length }),
    el("span", { class: "num", text: fmtTotal(segs) }),
    seqEl,
  ]));
  const playable = clips.filter((c) => c && c.file);   // 连播列表（段序·原 first 检出口径同源）
  const first = playable[0] || null;
  if (!first) {
    player.appendChild(el("span", { class: "phint", style: "font-size:12px" }, [
      t("preview.player.empty"),
    ]));
  }
  // B7-T1 · C1 的 live 三件（降级条/帧宿主 img/live 进度宿主）批5-R54-T2 迁实时预览子页
  //   （mount 内构造·_liveEls 登记目标随之改指 live 子页内元素·缓存语义不变）——
  //   .player 回归纯视频框：帧/视频不同框 = 「实时预览图与视频播放互挡」治理本体。
  let dual = null;   // 批 10-L F91a：双 video 交叉淡化（消换源黑窗闪烁·helper 由 edit.js 提供）
  let seqIdx = -1;   // F 块·当前连播位（-1=未起播；ended 链读它接下一段）
  function playIdx(i) {
    const c = playable[i];
    if (!c) return;
    seqIdx = i;
    // #68：点段/首播恒从 0 起——同源场景（点当前段）旧实现原地续播（老板「约第 3 秒起步」）
    show(c.file, { restart: true });
    seqEl.textContent = t("preview.player.seq", { i: i + 1, n: playable.length });
  }
  function ensureDual() {
    if (dual) return dual;
    dual = createDualVideo(player, {
      // 尺寸归 CSS：#pv-preview .player video 撑满+contain（F54·shell.css:455）
      onSwap: (v) => { const p = v.play(); if (p && typeof p.catch === "function") p.catch(() => {}); },
      // F 块·顺序连播：两 video 位都挂 ended（活动位随换源轮换）——一段播完自动接下一段，末段播完停。
      //   审核 R1 守卫（复核笔·如实口径）：①事件须发自活动位元素；②活动位源须等于连播位对应源——
      //   ②挡真机可触发窗：切段 K 在途时旧段 J 的 ended 以 seqIdx=K 读出 K+1 跳段（activePath 在
      //   备位在途期仍指旧源·与已更新的 seqIdx 对应源不等即弃）；①封非活动位 ended 口（真机靠
      //   promote 时 demoted.pause() 本不可达·防御性封口非活缺陷修复）。
      initVideo: (v) => { v.addEventListener("ended", () => {
        if (seqIdx < 0 || seqIdx + 1 >= playable.length) return;
        if (!dual || v !== dual.active()) return;
        if (dual.activePath() !== playable[seqIdx].file) return;
        playIdx(seqIdx + 1);
      }); },
    });
    _testDualRef = dual;   // 批 F91a：测试注入位（_test_promotePlayer 模拟首帧就绪）
    return dual;
  }
  function show(file, opts) {
    const d = ensureDual();
    d.show(file, opts);
    d.playWhenReady();   // 加载中 → 换位后接着播；同源 → 立即播（restart 已在 show 内归零）
  }
  function resume() {
    if (!dual) return;
    const v = dual.active();
    if (v) { const p = v.play(); if (p && typeof p.catch === "function") p.catch(() => {}); }
  }
  // F54（老板裁删自制播放钮 .scr）：播放入口收敛为 player 区点击——
  //   有产物：播/暂停切换；无产物：沿用原 .scr 守卫文案 toast 引导。
  //   点 video 本体（原生控件区）不接管，交原生行为（走查反馈⑧·controls 保留不动）。
  player.addEventListener("click", (e) => {
    const video = dual && dual.active();
    if (video && e.target === video) return;
    if (!first) {
      toast("info", t("preview.player.noProduct"));
      return;
    }
    if (!video) { playIdx(0); return; }   // 首点起播 = 从第一段起顺序连播（原 show(first.file) 收编）
    if (video.paused) resume(); else video.pause();
  });
  return {
    node: player,
    // 胶片条点段 → 切该段产物并从该段续连播（任务单：点击胶片条切段 · 尽力接）
    showSeg(clip) { if (clip && clip.file) playIdx(Math.max(0, playable.indexOf(clip))); },
  };
}

// ===== 批 10C-T3 · F46①：胶片条段右键菜单（V43 ctxFs :3116-3139 等价·edit.js ctxMenu 同款 pmenu 单例）=====
// ===== 七项序（10-E-T3 两重跑入口插「重跑此段」后）：重跑此段→修改参数并重跑…→同种子重跑（全部段）→打开项目目录→审核通过→审核不通过→删除；document click/ESC 关闭·与左键多选独立 =====
let _fsRemount = null; // 段删除后重挂句柄（mount 登记·通道 rerender 同职责·主代理追认②③）
let _subFn = null;     // 产物入轨订阅句柄（mount 登记·unmount 退订——edit.js C2 同款防跨 TAB 累积）
let _remountPending = false; // 同 tick 入轨合并闸（避免一轮 notify 内反复重挂）
let _fsCtx = null, _fsCtxDoc = null; // pmenu 单例 + 已绑关闭链的 document（edit.js :1722 孤儿防御同款）
function _fsCtxClose() { if (_fsCtx) _fsCtx.style.display = "none"; }
function _fsCtxEnsure() {
  // 孤儿判据用 body.contains 而非 parentNode——真 DOM 与本仓 fake DOM 桩（node._parent·无 parentNode）双世界一致
  if (_fsCtx && _fsCtxDoc === document && document.body.contains(_fsCtx)) return _fsCtx;
  if (_fsCtxDoc !== document) { // 跨文档（测试隔离/重启）重绑 click/ESC 关闭链
    document.addEventListener("click", _fsCtxClose);
    document.addEventListener("keydown", (e) => { if (e && e.key === "Escape") _fsCtxClose(); });
    _fsCtxDoc = document;
  }
  _fsCtx = el("div", { class: "pmenu", style: "position:fixed;display:none;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;z-index:120;min-width:190px;box-shadow:0 8px 24px #000a;font-size:12px" });
  document.body.appendChild(_fsCtx); return _fsCtx;
}
// ===== F65 二返：重跑守卫自动回退——无 loadedTaskId 但 project.runs 有运行记录（submit-bar
//   appendRunRecord 落账·倒序·每条含 stem）时自动载入最近一次运行，不再要求手动「载入历史」。
//   动态 import edit.js applyHistory（segcards openSegRerunEntry 同惯例·本件 _fsRerunParams 同款）；
//   成功 → 重读 store 返 loadedTaskId 由调用方原守卫继续；applyHistory 失败/仍无 loadedTaskId/
//   runs 空（或记录缺 stem 引擎钥匙）→ 返 null 落回原白话 toast。只挂两重跑入口（_fsRerun/
//   _fsSameSeed），审核入口 _fsAudit 不在任务单授权内不经此层。
let _applyHistoryFn = null; // 测试注入位（_test_setSegRerunEntry 同款惯例）：替身动态 import("./edit.js").applyHistory
export function _test_setApplyHistory(fn) { _applyHistoryFn = typeof fn === "function" ? fn : null; }
async function _fsAutoLoadTaskId(ctx, toast) {
  const p = storeLoad(ctx.projectId) || {};
  const es = p.editingState || {};
  if (es.loadedTaskId) return es.loadedTaskId;
  const runs = Array.isArray(p.runs) ? p.runs : [];
  if (!runs.length || !runs[0] || !runs[0].stem) return null; // 真没跑过 → 原白话 toast（提示合理）
  // R-20②（批 10-P P-T3）：kind 记录（resume 子集/变体任务）不自动载入——applyHistory 位置对位
  //   会把 s0K..s0N 子集装错段（破坏性）→ toast 引导手动「载入历史」选完整任务。
  if (runs[0].kind) {
    toast("info", t("preview.rerun.partialRun"));
    return null;
  }
  const stem = runs[0].stem;
  toast("info", t("preview.rerun.autoLoad", { stem }));
  try {
    const mod = _applyHistoryFn ? { applyHistory: _applyHistoryFn } : await import("./edit.js");
    if (mod && typeof mod.applyHistory === "function") await mod.applyHistory(stem, { projectId: ctx.projectId, auto: true }); // 批 10-G-T1 修正笔：第二参显式指项目（edit 未挂载时其 S.projectId 为空·不传=落账静默丢）·内建落 loadedTaskId+mainClips；R53变更20-T2：auto=自动载入按 localPick 守则保护本地互换段（显式载历史才重置）
  } catch (_e) { /* 载入失败 → 落回原守卫 toast（applyHistory 内建错误 toast） */ }
  const st = (storeLoad(ctx.projectId) || {}).editingState || {};
  return st.loadedTaskId || null;
}
// F106 T3（B 档）：概况页操作类入口用前校验——loadedTaskId 盲信过期指向（显式「载入历史」选旧
//   任务后即定格·无失效机制）会让右键打到过期任务。比对 store.latestMainRunStem（与 A 档落账
//   刷新同口径·最近一次主链全量运行）：不一致 → toast 告知并改用最新；无主链记录（纯查看旧
//   项目·无更优目标）→ 按原值走·不打扰。_fsAutoLoadTaskId 的 runs[0].kind 拒绝口径不动。
//   #63 T4 豁免：currentRunId 显式钉在旧记录 → 不追最新（用户显式载入是合法意图）。
export function resolveCurrentTaskId(projectId, curTaskId, toast) {
  const p = storeLoad(projectId) || {};
  if (isRunPointerPinned(p)) return curTaskId;
  const latest = latestMainRunStem(p.runs);
  if (latest && latest !== curTaskId) {
    toast("info", t("preview.task.stale"));
    return latest;
  }
  return curTaskId;
}
// 引擎段号守卫（edit.js rerunEntryGuard 同源判·sid 双命名空间 seg.id≠引擎 sid·追认②）——返 {taskId,sid}·双守卫白话 toast
function _fsEngSid(ctx, segId, toast) {
  const st = (storeLoad(ctx.projectId) || {}).editingState || {};
  if (!st.loadedTaskId) { toast("info", t("preview.rerun.noHistory")); return null; }
  const clip = (Array.isArray(st.mainClips) ? st.mainClips : []).find((c) => c && c.segId === segId) || null;
  const sid = clip && typeof clip.sid === "string" && clip.sid ? clip.sid : null;
  if (!sid) { toast("info", t("preview.rerun.noSid")); return null; }
  // 过期指向校验放在 sid 守卫之后：无 sid 本就发不出操作·先给可行动的那条提示（不叠两条 toast）
  return { taskId: resolveCurrentTaskId(ctx.projectId, st.loadedTaskId, toast), sid };
}
// F65 测试注入位（_test_setSegRerunEntry 同款惯例）：单测 stub runRerunFlow 断言 flow 注入参数
let _runRerunFlow = runRerunFlow;
export function _test_setRunRerunFlow(fn) { _runRerunFlow = typeof fn === "function" ? fn : runRerunFlow; }
async function _fsRerun(segId, ctx) {
  const toast = ctx.hooks.toast || showToast;
  await _fsAutoLoadTaskId(ctx, toast); // F65 二返：无 loadedTaskId 有运行记录 → 自动载入最近一次（失败落回 _fsEngSid 原守卫 toast）
  const g = _fsEngSid(ctx, segId, toast);
  if (!g) return;
  // F65：接 runRerunFlow 同链（edit.js rerunOneClip 同构）——提交+落账 appendRunRecord+pollAndSettle
  //   轮询+终态 syncRunProducts 回轨（剪辑页片段随产物落地增加）；提交失败/已提交 toast 由 flow 内建
  void _runRerunFlow({
    projectId: ctx.projectId, taskId: g.taskId, sids: [g.sid], keepSeed: false, label: "重跑此段", kind: "rerun",
  });
}
async function _fsAudit(segId, kind, ctx) {
  const toast = ctx.hooks.toast || showToast;
  // 批 10-O O-T3b（F100 第二层根因·真机门③打回）: 审核入口同 F65 二返两个重跑入口
  //   （_fsRerun:419 / _fsSameSeed 同款）先兜一层自动载入——跑过但没载入历史时，
  //   引擎段号守卫会拦下 early return，approve 根本发不出去（引擎侧 review 恒 None
  //   → 无回写 → 点不变绿）。载入失败时本函数内部落回原守卫 toast，_fsEngSid 照旧拦截。
  await _fsAutoLoadTaskId(ctx, toast);
  const g = _fsEngSid(ctx, segId, toast);
  if (!g) return;
  const r = kind === "ok"
    ? await ctx.hooks.approve({ stem: g.taskId, sid: g.sid })              // core/review.js:49（文案同 edit.js 审片门）
    : await ctx.hooks.voidSeg({ stem: g.taskId, sid: g.sid, solo: true }); // core/review.js:101·仅本段（裁决③）
  // 批 10-O F100：引擎裁决成功 → 回写 clip.review（缩略点 audited-ok/bad + title 的唯一
  //   数据源；此前全仓零写点 → deriveThumb 两支死码）。重渲走本页既有 store 订阅通道
  //   （mount 内 editingState:update+mainClips → _fsRemount·延后一拍防重挂风暴）。
  //   r.ok=false（含 voidSeg 幂等 400）不回写——不与已落账的裁决冲突。
  if (r && r.ok) {
    markClipReview(ctx.projectId, segId, kind === "ok" ? "approved" : "void");
    toast("success", kind === "ok" ? t("preview.audit.passed", { sid: g.sid }) : t("preview.audit.voided", { sid: g.sid }));
  } else toast("error", t("preview.audit.fail", { verb: kind === "ok" ? "approve" : "void", msg: (r && r.error && r.error.msg) || "" }));
}
// 批 L1 · T2 · R-27「打开成片目录」（口径变更 A2 裁定：无条件走成片链·无 server_output_dir 分支）
//   路径源 = 最近一次主链全量运行的成片目录：
//     store.latestMainRunStem(runs) → GET /h3_batch/history/detail 直连 request 拿 raw
//     （concat 只在 raw 顶层·loadDetail 会把 object 形 shots 归一成数组·直连最稳）
//     → raw.concat.file 的 dirname → POST /gui13-fs/open_dir
//   回退链：concat.file 空（分镜模式恒空/手动拼接不落）→ detail shots 首个非空 run_dir（sid 字典序）
//           → 全空 → 白话 toast「该项目还没有可打开的产物」
//   失败按态分化白话（不裸抛 error code）：引擎不可达（网络错/5xx）→「无法获取运行记录，请确认引擎在线」
//           ；task 404/manifest 损 → 「未找到该任务的运行记录」
//   open_dir 侧错误映射保持不变：403=不在范围 / 404=不存在 / 网络失败=服务未启动
//   依赖声明：本项由「已设目录零引擎依赖」变为**新增引擎在线依赖**（history/detail 需 8190）。
//   J-P6 的 {path:null} 发送点随本项整体删除（服务端 _open_dir_target null→roots[1] 保留为纯防御·零改）。
async function _fsOpenDir(ctx) {
  const toast = ctx.hooks.toast || showToast;
  const dir = await _fsFinalDir(ctx, toast);
  if (!dir) return;
  // R-31 收敛：发包+三分文案移 core/open_dir.js（动词=目录·网络失败白话口径·成功零 toast）
  await openDirRequest(dir, { toast, verb: "目录", plainNetworkError: true });
}
// 成片目录解算（成片 → shots run_dir 回退 → 全空 toast）；取不到时返 ""（调用方据此早退·不发包）
async function _fsFinalDir(ctx, toast) {
  const stem = latestMainRunStem((storeLoad(ctx.projectId) || {}).runs);
  if (!stem) { toast("info", t("preview.openDir.none")); return ""; }
  const r = await request("/h3_batch/history/detail?task_id=" + encodeURIComponent(stem), { cache: "no-store" });
  if (!r.ok) {
    const st = (r.error && r.error.httpStatus) || 0;
    toast("error", (!st || st >= 500) ? t("preview.openDir.detailFail") : t("preview.openDir.missing"));
    return "";
  }
  const raw = r.data || {};
  const film = (raw.concat && typeof raw.concat.file === "string") ? raw.concat.file : "";
  if (film) return film.replace(/[\\/][^\\/]+$/, "");
  const runDir = firstRunDirFromShots(raw.shots);   // R-31 收敛：core/open_dir.js 单源（原本件 _firstRunDir 内联同式）
  if (runDir) return runDir;
  toast("info", t("preview.openDir.none"));
  return "";
}
function _fsDelete(segId, ctx) {
  // 裁⑦A=直删+确认弹窗；edit.js openMbox(:3006) 私有未导出且不在改动清单 → ui/modal.js openConfirm（追认②①）
  ctx.hooks.confirm({
    title: t("preview.del.title"), sub: t("preview.del.sub"), danger: true, confirmText: t("preview.del.ok"),
    onConfirm: () => {
      const proj = storeLoad(ctx.projectId); if (!proj) return;
      ctx.hooks.removeSeg(proj, segId); // store.removeSegment（段卡删除同通道 segcards :895-897）
      ctx.hooks.save(proj);             // storeSave 落盘 + notify(project:save)
      if (_fsRemount) _fsRemount();     // 通道第三步 rerender
    },
  });
}
// 「修改参数并重跑…」跨域入口（10-E-T3）：动态 import edit.js openSegRerunBySegId（edit.js:4286 导出·
//   内建未载入历史/无 sid 白话守卫·弹 B4-T3 段编辑四区弹窗）——segcards.js openSegRerunEntry 同惯例·单测经注入位替身
let _segRerunEntry = null;
export function _test_setSegRerunEntry(fn) { _segRerunEntry = typeof fn === "function" ? fn : null; }
async function _fsRerunParams(segId, ctx) {
  if (_segRerunEntry) { await _segRerunEntry(ctx.projectId, segId); return; }
  try {
    const mod = await import("./edit.js");
    if (mod && typeof mod.openSegRerunBySegId === "function") await mod.openSegRerunBySegId(ctx.projectId, segId);
  } catch (_e) { /* 编辑域不可用不影响预览 TAB */ }
}
// 「同种子重跑（全部段）」（10-E-T3→F65 改链）：edit.js sameSeedRerunAll(:1683) 二段式同构——
//   首调不带 force（引擎不覆写参数必中 confirm_required）→ 确认 → 提交+落账+轮询+回轨全走
//   runRerunFlow（submit 注入 sameSeed force:true）；守卫同 _fsEngSid 首守卫句式
async function _fsSameSeed(ctx) {
  const toast = ctx.hooks.toast || showToast;
  const taskId = await _fsAutoLoadTaskId(ctx, toast); // F65 二返：同回退层（同种子 taskId 同来自 loadedTaskId·同受益）
  if (!taskId) { toast("info", t("preview.rerun.noHistory")); return; }
  const target = resolveCurrentTaskId(ctx.projectId, taskId, toast); // F106 B 档：过期指向改用最近一次主链全量运行
  const sameSeedFn = ctx.hooks.sameSeed || sameSeed;
  const first = await sameSeedFn({ taskId: target, source: "task" }); // 首调不带 force（api #6·引擎不覆写参数必中 confirm_required）
  if (!first || !first.ok) {
    toast("error", t("preview.sameSeed.fail", { msg: (first && first.error && first.error.msg) || (first && first.error && first.error.code) || t("settings.err.unknown") }));
    return;
  }
  // F65：提交+落账+轮询+回轨一条龙走 runRerunFlow（edit.js :1694-1710 flow() 同构）——
  //   submit 注入：引擎已 started 的链路不得再 POST rerun（二次必 409 active_busy）
  const flow = (submit) => _runRerunFlow({ projectId: ctx.projectId, taskId: target, sids: [], label: "同种子重跑", kind: "rerun", submit });
  if (!first.confirmRequired && first.started) { void flow(() => Promise.resolve(first)); return; } // 引擎直启（基线外防御）：复用本次结果·不再 POST
  ctx.hooks.confirm({ // _fsDelete 同通道（ui/modal.js openConfirm）
    title: t("preview.sameSeed.title"),
    sub: t("preview.sameSeed.sub"),
    confirmText: t("preview.sameSeed.ok"),
    onConfirm: () => { void flow(() => sameSeedFn({ taskId: target, source: "task", force: true })); },
  });
}
// ===== 老板 2026-10-07 报障 B（贴底/贴右右键菜单越界）· 视口钳制 =====
// 真机取证（agent-browser · 项目 test1 · 视口 1258×566 · 胶片条第 2 行缩略图 (1123,554) 原生右键）：
//   七项段菜单实测 menuTop=366 / menuH=210 / menuBottom=576 > innerHeight=566 → 越界 10px，
//   末项「删除」rect 541..569 底缘被切掉不可点。
// 根因：旧写死估值 `Math.min(clientY, vh - 200)`——200 是对菜单高的猜测，实测 210（超了）。
//   同款写死估值 edit.js 已于 F105（批 G-b T2）改为按渲染后实测高度钳（edit.js clampMenuTop），
//   预览页未同步。本件按同款口径补齐：按实测 w/h 双向钳制 + PAD 边距 + 下界（超高菜单贴顶）。
// 坐标系：.pmenu position:fixed 直挂 body → clientX/Y 与 rect 同视口系自洽，无需换算（同 F105 声明）。
export const CLAMP_PAD = 8;   // 视口边距（edit.js clampMenuTop 同款 8px）

export function clampMenuPos(clientX, clientY, menuW, menuH, vw, vh) {
  const w = Math.max(0, Number(menuW) || 0);
  const h = Math.max(0, Number(menuH) || 0);
  const W = Math.max(0, Number(vw) || 0);
  const H = Math.max(0, Number(vh) || 0);
  const x = Number(clientX) || 0;
  const y = Number(clientY) || 0;
  // 上限 W-w-PAD 可为负（菜单比视口还宽）→ Math.max(0,·) 兜底，落左缘而非负坐标
  return {
    left: Math.max(0, Math.min(x, W - w - CLAMP_PAD)),
    top: Math.max(0, Math.min(y, H - h - CLAMP_PAD)),
  };
}

function _vpW() {
  const v = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
  return v;
}
function _vpH() {
  return typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
}

function _fsMenuOpen(e, segId, ctx) {
  const m = _fsCtxEnsure();
  m.innerHTML = "";
  const items = [ // 10-E-T3 七项序：两重跑入口插「重跑此段」后
    [t("preview.menu.rerunOne"), () => _fsRerun(segId, ctx)],
    [t("preview.menu.rerunParams"), () => _fsRerunParams(segId, ctx)],
    [t("preview.sameSeed.title"), () => _fsSameSeed(ctx)],
    [t("preview.menu.openFilmDir"), () => _fsOpenDir(ctx)],   // 批 L1 T2 R-27：口径 = 最近一次主链运行成片目录
    [t("preview.menu.approve"), () => _fsAudit(segId, "ok", ctx)],
    [t("preview.menu.reject"), () => _fsAudit(segId, "bad", ctx)],
    [t("preview.menu.delete"), () => _fsDelete(segId, ctx), true],
  ];
  for (const [txt, fn, danger] of items) {
    const it = el("div", { text: txt });
    it.style.cssText = "padding:6px 10px;border-radius:8px;cursor:pointer;color:var(--txt2)" + (danger ? ";color:#e08c8c" : "");
    it.addEventListener("click", () => { _fsCtxClose(); fn(); });
    m.appendChild(it);
  }
  m.style.display = "block";   // 先亮再量：display:none 下 getBoundingClientRect 恒返全零
  const r = m.getBoundingClientRect ? m.getBoundingClientRect() : null;
  const pos = clampMenuPos(e.clientX, e.clientY, r ? r.width : 0, r ? r.height : 0, _vpW(), _vpH());
  m.style.left = pos.left + "px";
  m.style.top = pos.top + "px";
}

// ===== 老板 2026-10-07 功能件：全片预览/胶片条交界拖动手柄 =====
// 「交界处加个手柄 可以调节全篇预览区域的大小」——全片预览区高度可拖拽调。
// 先例侦察（沿用同款口径，不自造形态）：
//   - 拖动语义：edit.js buildSplitPv（.split-pv·拖条在播放器下方·nh = h0 + (ev.clientY - y0)
//     下拖=播放器变高·跟手；置 flex:0 0 auto 令拖定高度退出 flex 分摊不被兄弟挤回）。
//   - 记忆形态：shell.js mountSidenavResize（clamp 纯函数 + read/write + localStorage 键 +
//     拖动中不写/松手才写）——本件同款结构。
//   - 键形态：h3gui_*（1.0 遗留同语义键：h3gui_col_left_w / h3gui_timeline_collapsed）本件沿用同前缀。
// 界：下限 PREVIEW_H_MIN（防预览区被拖没致布局塌），上限视口 80%（拖不穿顶/不撑爆整页）。
export const PREVIEW_H_KEY = "h3gui_preview_player_h";   // 1.0 遗留同语义键前缀（shell.js h3gui_col_left_w 同款）
export const PREVIEW_H_MIN = 140;                        // px 下限（edit.js buildSplitPv 120px 下限同款·略放宽）
export const PREVIEW_H_MAX_RATIO = 0.8;                  // 视口高上限比例（80vh）

export function clampPreviewHeight(px, viewportH) {
  const n = Number(px);
  const vh = Number(viewportH);
  const v = Number.isFinite(vh) && vh > 0 ? vh : 800;
  // 小视口下 80vh 可能 < MIN → 上限回落下限（不得出现 max<min 的反转区间）
  const max = Math.max(PREVIEW_H_MIN, Math.floor(v * PREVIEW_H_MAX_RATIO));
  if (!Number.isFinite(n)) return PREVIEW_H_MIN;   // NaN/脏 localStorage → 下限（shell.js clampSidenavWidth 同款）
  if (n < PREVIEW_H_MIN) return PREVIEW_H_MIN;
  if (n > max) return max;
  return n;
}

function _pvStorage(storage) {
  if (storage !== undefined) return storage;
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

export function readPreviewHeight(storage) {
  try {
    const s = _pvStorage(storage);
    if (!s) return null;
    const raw = s.getItem(PREVIEW_H_KEY);
    if (raw == null) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  } catch (_e) { return null; }
}

export function writePreviewHeight(px, storage) {
  try {
    const s = _pvStorage(storage);
    if (!s) return;
    s.setItem(PREVIEW_H_KEY, String(clampPreviewHeight(px, _vpH())));
  } catch (_e) { /* localStorage 不可用（隐私模式/配额满）→ 静默吞 */ }
}

function _applyPreviewHeight(player, px) {
  if (!player || !player.style) return;
  const h = clampPreviewHeight(px, _vpH());
  player.style.height = h + "px";
  player.style.flex = "0 0 auto";   // 拖定高度退出 flex 分摊（edit.js buildSplitPv 同款）
}

// 手柄行为接线：夹在 .player 与 .filmstrip 之间的手柄，拖动实时改预览区高度，松手落记忆。
//   手柄节点由 mount 建好后传入（与本模块其余 DOM 同走 el()+appendChild 惯例·不另造插入法）。
// opts: { document, storage }（测试注入位；缺省走全局 document/localStorage）
export function mountPreviewResize(player, handle, opts = {}) {
  const doc = opts.document || (typeof document !== "undefined" ? document : null);
  if (!doc || !player || !handle) return null;
  const storage = _pvStorage(opts.storage);

  // 记忆恢复：无记忆则不动 .player（保持 CSS flex:1 + max-height:62vh 自适应）
  const restored = readPreviewHeight(storage);
  if (restored != null) _applyPreviewHeight(player, restored);

  let dragging = false;
  let startY = 0;
  let startH = 0;
  handle.addEventListener("mousedown", (ev) => {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    dragging = true;
    startY = (ev && ev.clientY) || 0;
    const r = player.getBoundingClientRect ? player.getBoundingClientRect() : null;
    startH = r && Number.isFinite(r.height) && r.height > 0 ? r.height : PREVIEW_H_MIN;
  });
  doc.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    // 拖条在预览区下方 → 下拖 = 预览区变高（跟手·edit.js buildSplitPv 同款符号）
    _applyPreviewHeight(player, startH + (((ev && ev.clientY) || 0) - startY));
  });
  doc.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    writePreviewHeight(parseFloat(player.style.height), storage);
  });

  return handle;
}

// ===== 胶片条缩略图 canvas 采样（批 J-P14）=====
// 根因（P12 坐实·引擎 T1 已消解）：引擎 /h3_batch/thumb 对**视频**恒返 72×128——max_size 被忽略，升档对
//   视频无效。72×128 竖帧塞进 220×64 横条 + cover 居中：按宽放大 3.06× 后只露 16.4% 画面，
//   上下各裁 41.8% → 头部整段切掉（老板报「截断」）；72px 源拉 220 宽 = 糊。
// 方案：搬剪辑页同款（edit.js sampleFilmstrip 离屏 video 多帧 seek + drawImage → dataURL
//   **整帧**）。关键差别 = 采样产物是整帧而非引擎那张预裁竖图，故 cover 居中只裁横向、恒不裁头。
//   复用 edit.js filmstripFor（不另造：连带继承缓存 + 串行队列的并发上限 1）。
// 图片产物维持引擎 thumb（max_size 对图片真实生效·R-22 提到 512 档·与剪辑页 edit.js:4599 同档）。
//
// 选型注记（截断治理·两条可选口径取其一）：
//   A 改单元格形态（把 .fsthumb 拉成竖高）→ 250 段胶片条行高暴涨，布局失控，弃。
//   B 单元格维持 220×64，采样时按格宽高比 cover 居中裁 —— 因产物是整帧，cover 按格高缩放
//     后高度恒等于格高 → 垂直裁切恒 0 → 头部完整。取 B（最小侵入 + 与剪辑页 .clipfilm 同款）。
const FILM_TILE_MIN = 2;   // 格数下限 2 是「不裁头」的几何前提：单格比 16:9 更扁会重新引入垂直裁切
const FILM_CELL_FALLBACK_W = 220; // 读不到格宽时的兜底（.fsthumb max-width·shell.css:485）

// 视频扩展名判别（产物是视频 → 走 canvas 采样；其余图片 → 走引擎 thumb）
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
export function isVideoFile(file) { return VIDEO_EXT_RE.test(String(file || "")); }

// cover 裁切几何（纯函数·单测钉住）。返回 cover 缩放后上下/左右各裁掉多少源像素。
//   渲染不依赖本函数（CSS background-size:cover 由浏览器按采样产物固有尺寸算）——
//   它的职责是把「竖帧裁头 vs 整帧不裁头」这条判据写成可断言的数。
export function coverCrop(frameW, frameH, boxW, boxH) {
  const s = Math.max(boxW / frameW, boxH / frameH);
  return {
    scale: s,
    cropX: (frameW * s - boxW) / 2,
    cropY: (frameH * s - boxH) / 2,
    cropW: boxW / s,
    cropH: boxH / s,
  };
}

// 胶片格数：随格宽自适应（格宽/56 取整，剪映式密度），下限 FILM_TILE_MIN、上限采样帧数
export function filmTileCount(cellW, maxFrames) {
  const mx = Math.max(1, Math.floor(Number(maxFrames) || 0));
  return Math.max(FILM_TILE_MIN, Math.min(mx, Math.round((Number(cellW) || 0) / 56)));
}

// 测试注入位（同族先例 edit.js _fsSampler / _candPollInterval）：null = 生产 filmstripFor。
//   真采样走离屏 video + seek，本仓测试桩无媒体引擎，毫秒级单测不可承载（edit.js:1026 同因）。
let _fsSampler = null;
let _ioFactory = null;
export function _test_setFilmstripSampler(fn) { _fsSampler = fn; }
export function _test_setIOFactory(fn) { _ioFactory = fn; }
export function _test_resetFilmstrip() { _fsSampler = null; _ioFactory = null; _filmDisposers = []; }

// 观察者句柄（unmount/重挂时断开·不留旧挂载引用·同 _progDestroy/_liveProgDestroy 惯例）
let _filmDisposers = [];
function _filmDestroy() { _filmDisposers.forEach((f) => { try { f(); } catch (_e) { /* 断观察失败不阻塞重挂 */ } }); _filmDisposers = []; }

function _alive(n) { return !!n && n.isConnected !== false; }

// 视口内优先（性能口径）：250 段项目全渲染时不让所有段同时抢离屏 video 的 src——逐格入
//   IntersectionObserver，入视口才入采样队列。环境无 IO 时降级为「立即全部入队」，行为不退化。
function observeInView(nodes, onEnter) {
  const IO = _ioFactory || (typeof IntersectionObserver !== "undefined" ? IntersectionObserver : null);
  if (!IO) { nodes.forEach(onEnter); return null; }
  const io = new IO((ents) => {
    for (const e of ents || []) if (e && e.isIntersecting) onEnter(e.target);
  });
  nodes.forEach((n) => io.observe(n));
  return io;
}

// 铺格：采样产物按格数均匀抽取（与 edit.js fillFilmstrip 同款算法）。失败/未入视口 → 不铺。
function fillFilm(th, layer, file, dur) {
  const run = _fsSampler || filmstripFor;
  run(file, dur).then((frames) => {
    if (!frames || !frames.length || !_alive(th) || !_alive(layer)) return;
    const w = (th.getBoundingClientRect && th.getBoundingClientRect().width) || FILM_CELL_FALLBACK_W;
    const cells = filmTileCount(w, frames.length);
    const step = frames.length / cells;
    let html = "";
    for (let i = 0; i < cells; i++) {
      const url = frames[Math.min(frames.length - 1, Math.floor(i * step))];
      html += url ? `<i style="background-image:url(${url})"></i>` : "<i></i>";
    }
    layer.innerHTML = html;
    th.classList.add("hasfilm");
  }).catch(() => { /* 采样失败：保留 .fsthumb.done 渐变底（不铺破图格·不回落引擎 thumb） */ });
}

// 批5-R54-T4：渲染中段判定（账本 Q11 三分流口径·纯函数独立可测）
//   isRenderingSeg(proj, segId) = proj.runState.running && 该段无产物；
//   「有产物」判据与 buildFilmstrip hasProduct 同源：clip.file 且 state done|warn。
export function isRenderingSeg(proj, segId) {
  const running = !!(proj && proj.runState && proj.runState.running);
  if (!running) return false;
  const st = proj.editingState && typeof proj.editingState === "object" ? proj.editingState : null;
  const clips = st && Array.isArray(st.mainClips) ? st.mainClips : [];
  const clip = clips.find((c) => c && c.segId === segId) || null;
  const hasProduct = !!(clip && clip.file && (clip.state === "done" || clip.state === "warn"));
  return !hasProduct;
}

// R-34：失败段「错误详情」只读弹层（ui/modal.js open builder 复用·只读形态先例=pvbox）——
//   兜底链：executionError 四键 dict → 节点 ID/节点类型/异常类型/原因文本 四行
//   （message 多行文本原样展示·引擎已截 1000 字符）/ clip.status 串 / 「无详情」
//   （旧任务/非 ComfyUI 失败兜底）。persistKey 统一尺寸记忆（标题带段号·按 title 会逐段散落 localStorage）。
// #40 T2 · I4：详情层加第 5 行「来源」（error_source 变体键 → 白话）·空 node_id 兜底「——（<来源>·无节点）」；
//   行构建与弹层开法抽成 export——submit-bar.js 提交期错误详情入口复用同一形态（不复制四行布局）。
const _EXEC_ERROR_SOURCE_LABEL = {
  submit_validation: t("preview.err.srcSubmit"),   // 引擎提交期拒点族（8 处 A 类拒点 + generate_csv 面）
  comfyui_execution: t("preview.err.srcExec"),     // 引擎运行期 R-34 两写点
};

// error_source → 白话来源（未知值原样透出·缺省「未知来源」）
function execErrorSourceLabel(errorSource) {
  const raw = (errorSource == null) ? "" : String(errorSource).trim();
  if (!raw) return t("preview.err.srcUnknown");
  return _EXEC_ERROR_SOURCE_LABEL[raw] || raw;
}

// 详情层行构建（四字段 + 来源行）——纯函数
function execErrorRows(executionError) {
  const ee = (executionError && typeof executionError === "object") ? executionError : {};
  const source = execErrorSourceLabel(ee.error_source);
  const nodeId = (ee.node_id == null || String(ee.node_id) === "")
    ? t("preview.err.noNode", { src: source })
    : String(ee.node_id);
  return [
    { label: t("preview.err.nodeId"), value: nodeId },
    { label: t("preview.err.nodeType"), value: ee.node_type },
    { label: t("preview.err.excType"), value: ee.exception_type },
    { label: t("preview.err.excMsg"), value: ee.exception_message, pre: true },
    { label: t("preview.err.src"), value: source },
  ];
}

// 错误详情只读弹层（四字段 + 来源行）——片段层与提交期层共用
export function openExecErrorModal(executionError, title) {
  const body = el("div", { class: "seg-err" });
  for (const r of execErrorRows(executionError)) {
    body.appendChild(el("div", { class: "seg-err-row", style: "margin-bottom:6px" }, [
      el("b", { text: r.label + t("preview.err.colon") }),
      el("span", { text: r.value == null ? "" : String(r.value), style: r.pre ? "white-space:pre-wrap" : "" }),
    ]));
  }
  openModal({ title: title || t("preview.err.title"), contentNode: body, persistKey: "错误详情" });
}

function openSegErrorModal(clip, n) {
  const ee = (clip.executionError && typeof clip.executionError === "object") ? clip.executionError : null;
  if (ee) { openExecErrorModal(ee, t("preview.err.segTitle", { n })); return; }
  const body = el("div", { class: "seg-err" });
  if (clip.status) {
    body.appendChild(el("div", { text: String(clip.status) }));
  } else {
    body.appendChild(el("div", { text: t("preview.err.none") }));
  }
  openModal({ title: t("preview.err.segTitle", { n }), contentNode: body, persistKey: "错误详情" });
}

// ===== 胶片条（v43 :1206-1212 · 三态+审计态+多选拼接）=====
function buildFilmstrip(segs, clips, ctx) {
  const strip = el("div", { class: "filmstrip" });
  const clipBySeg = new Map();
  for (const c of clips) {
    if (c && c.segId && !clipBySeg.has(c.segId)) clipBySeg.set(c.segId, c);
  }
  const thumbs = [];
  const pending = []; // 待采样的视频格（视口内才入队）
  segs.forEach((s, i) => {
    const clip = clipBySeg.get(s.id) || null;
    const tb = deriveThumb(s, clip, i + 1);   // #89 FIX-1：局部名 t→tb（原名影蔽 i18n 取词函数·下方 auditBtn 取词调用会变 TypeError）
    // 批 J-P14：走查反馈⑧（老板「项目概况要有预览图」）done 态以产物画面为底。
    //   批 J-P7 B3：引擎 thumb 与剪辑页统一档位（.fsthumb 宽至 220px，低档源被拉伸 = 老板报的「截断」）。
    //   批 J-P14：当时 max_size 对**视频**恒无效（引擎 thumb 对视频恒 72×128·裁头且糊）→ 视频段改挂
    //   .fsthumb-film 走 canvas 采样（整帧多格横铺·头不裁）；图片段沿用引擎 thumb（R-22 已提到 512 档）。
    //   批 L4 · T1：引擎放开视频侧 max_size → 视频段亦可回引擎通道，采样位升分辨率改由 T3 承接（另案）。
    const hasProduct = !!(clip && clip.file && (clip.state === "done" || clip.state === "warn"));
    const isVideo = hasProduct && isVideoFile(clip.file);
    // 胶片层只挂视频格（图片/待生成格不留空 div）；段标包 .fsthumb-cap
    //   （position:relative;z-index:1·edit.css .cap 同款）——胶片层是绝对定位元素，
    //   不给段标堆叠上下文就会被盖住。
    const film = isVideo ? el("span", { class: "fsthumb-film" }) : null;
    // F 块·段落审核一级入口：显式「审」小钮——点开与右键同款菜单（_fsMenuOpen 原函数复用·选项逐项相同）。
    //   左上角定位避让右上审计点 .fsthumb-dot（top:4/right:4·shell.css:498）；内联样式=本块白名单不含 css 文件。
    const auditBtn = el("span", {
      class: "fsthumb-audit",
      title: t("preview.strip.auditTitle"),
      style: "position:absolute;top:2px;left:2px;z-index:2;padding:1px 5px;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font-size:11px;font-weight:400;line-height:1.4;cursor:pointer",
    }, [t("preview.strip.auditBtn")]);
    auditBtn.addEventListener("click", (e) => {
      if (e.stopPropagation) e.stopPropagation();   // 阻断 th 单击多选分流 + document 关菜单链（菜单刚开不被同次 click 关掉）
      if (e.preventDefault) e.preventDefault();
      const r = auditBtn.getBoundingClientRect ? auditBtn.getBoundingClientRect() : null;
      _fsMenuOpen({ clientX: r ? r.left : 0, clientY: r ? r.bottom + 2 : 0 }, s.id, ctx);   // 合成定位事件：_fsMenuOpen 只读 clientX/clientY（:600）
    });
    const th = el("span", { class: tb.cls, title: tb.title, "data-n": i + 1, "data-state": tb.state, "data-sid": s.id }, [
      film,
      auditBtn,
      el("span", { class: "fsthumb-dot" }),
      el("span", { class: "fsthumb-cap" }, [tb.label]),
    ]);
    if (isVideo) {
      pending.push({ th, film, file: clip.file, dur: Number(clip.dur) || Number(s.durationSec) || 0, queued: false });
    } else if (hasProduct) {
      th.style.backgroundImage = `url("${mediaUrl("thumb", clip.file, { maxSize: 512 })}")`;   // 批 B #13：URL 收敛单源
      th.style.backgroundSize = "cover";
      th.style.backgroundPosition = "center";
      wireBgMediaFallback(th, "thumb", clip.file, { maxSize: 512 });   // 批 B #13：引擎口失败 → 本地缩略兜底
    }
    // 单击 = 多选切换（原型 fsClick :3075）+ R-34 失败段最前分流（warn 格→弹「错误详情」层·本格短路：
    //   多选不 toggle、三分流不切——含 warn 且有 file 的原「切 video」让位·关层后不补切）
    //   + 批5-R54-T4 点击三分流（账本 Q11 定稿·唯一依据）：
    //   done|warn 且有 file → 切 video 子页 + 播该段；渲染中（isRenderingSeg）→ 切 live 子页；
    //   其余 → 切 prompt 子页 + 写模块级 _curSegId（onSubTabShown 已激活态重复调用刷新——T3 已铺）。
    //   多选 toggle 三分支全部保持（先 toggle 后分流·v2·S1）。
    th.addEventListener("click", () => {
      if (clip && clip.state === "warn") { openSegErrorModal(clip, i + 1); return; }
      th.classList.toggle("sel");
      updateStitch();
      if (hasProduct) {
        applyPreviewSubTab("video");
        ctx.player.showSeg(clip);
      } else if (isRenderingSeg(storeLoad(ctx.projectId), s.id)) {
        applyPreviewSubTab("live");
      } else {
        _curSegId = s.id; // 先写当前段再切入：prompt 页钩子重读渲染（含已激活态重复调用）
        applyPreviewSubTab("prompt");
      }
    });
    // 批 10C-T3 · F46①：右键 = 段菜单（V43 ctxFs 等价·单选目标=所点 thumb·与左键多选独立）
    th.addEventListener("contextmenu", (e) => {
      if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
      _fsMenuOpen(e, s.id, ctx);
    });
    thumbs.push(th);
    strip.appendChild(th);
  });
  const nEl = el("b", { class: "num", id: "fsStitchN", text: "0" });
  const btn = el("span", {
    class: "fs-stitch-btn",
    id: "fsStitchBtn",
    title: t("preview.strip.stitchTitle"),
  }, [el("span", { "data-ic": "plus", "data-sz": "13" }), t("preview.strip.stitch"), nEl]);
  function selected() {
    return thumbs.filter((t) => t.classList.contains("sel"));
  }
  function clearSel() {
    thumbs.forEach((t) => t.classList.remove("sel"));
  }
  function updateStitch() {
    const n = selected().length;
    btn.classList.toggle("show", n >= 2);
    if (nEl) nEl.textContent = String(n);
  }
  btn.addEventListener("click", async () => {
    const picked = selected().map((t) => Number(t.getAttribute("data-n")));
    const r = await stitchSelected(picked, {
      projectId: ctx.projectId,
      concat: ctx.hooks.concat,
      toast: ctx.hooks.toast,
    });
    if (r && r.ok) { clearSel(); updateStitch(); }
  });
  strip.appendChild(btn);
  // 批 J-P14：视频格入视口观察（单例 IO 统管全胶片条）；无 IO 环境降级为立即入队。
  if (pending.length) {
    const io = observeInView(pending.map((p) => p.th), (node) => {
      const p = pending.find((q) => q.th === node);
      if (p && !p.queued) { p.queued = true; fillFilm(p.th, p.film, p.file, p.dur); }
    });
    if (io) _filmDisposers.push(() => io.disconnect());
  }
  return { node: strip, clearSel, updateStitch };
}

// ============================================================================
// 批5-R54-T1：页内三子页签（F-62 先例·setup.js :441-476 applySubTab 同款）
//   结构裁决（实施计划 v2.1）：操作条（公共区）→ .fchips 页签条 → 三子页区（video/live/prompt·
//   同挂 DOM display:none 显隐——零销毁重挂保 live 缓存语义）→ 拖高手柄（随 video 子页显隐）
//   → 胶片条（公共区）。
//   手柄缺陷路径锁：display:none 下 getBoundingClientRect().height=0 会把记忆高度打回
//   PREVIEW_H_MIN=140（mountPreviewResize mousedown 实链）——手柄仅 video 激活时可见可拖。
// ============================================================================
const PREVIEW_SUB_KEY = "gui13.previewSubTab"; // 记忆键（setup.js gui13.setupSubTab 同形态）
const PREVIEW_SUBS = [["video", t("preview.sub.video")], ["live", t("preview.sub.live")], ["prompt", t("preview.sub.prompt")]];
let _pvSub = null;          // 当前挂载子页签上下文 { chips, pages, handle }（unmount 置 null·_liveEls 同款）
let _onSubTabShown = null;  // 子页激活刷新钩子（T3 提示词页重读 / T4 已激活再点段依赖）
export function onSubTabShown(fn) { _onSubTabShown = typeof fn === "function" ? fn : null; }

// 当前段自持位（T3/T4 消费）：必须模块级——F-92a mainClips 订阅触发整页重挂会清掉 mount 闭包
//   变量，渲染落轨时停在提示词 tab 的当前段会跳回段 1（实施计划 v2.1 P2 裁决·_live 同先例）。
let _curSegId = null;
export function _test_setCurSegId(id) { _curSegId = typeof id === "string" && id ? id : null; }
export function _test_getCurSegId() { return _curSegId; }

// 子页切换：chip.on 态 + 子页 display 显隐 + 手柄随 video 显隐 + localStorage 记忆 +
//   刷新钩子（每次调用都触发·含已激活态重复调用——T3/T4 依赖）。
export function applyPreviewSubTab(name) {
  const next = name === "live" || name === "prompt" ? name : "video";
  if (!_pvSub) return;
  for (const [k, chip] of Object.entries(_pvSub.chips)) {
    if (k === next) chip.classList.add("on"); else chip.classList.remove("on");
  }
  for (const [k, page] of Object.entries(_pvSub.pages)) {
    page.style.display = k === next ? "" : "none";
  }
  if (_pvSub.handle) _pvSub.handle.style.display = next === "video" ? "" : "none";
  try { localStorage.setItem(PREVIEW_SUB_KEY, next); } catch (_e) { /* 无 localStorage（单测桩/隐私态）→ 不记忆 */ }
  if (_onSubTabShown) _onSubTabShown(next);
}

// ===== 批5-R54-T3：提示词预览子页（只读面板·纯读零写）=====
//   渲染触发=onSubTabShown('prompt')（mount 注册·含已激活态重复调用——T4「已在 prompt 再点
//   另一段」依赖）；每次进入重读 store（零订阅扩 keys·侦察陷阱①规避——重挂/切 tab 重读即可，
//   重挂后 _curSegId 由 T1 用例⑦的模块级自持位保活）；零 store 写调用+零引擎在线依赖
//   （不用 fetchInlinePreview；buildPvPreview refMap 传空表——未注册 @N 原样保留·离线可合成）。
//   老板原话"当前段参数（分辨率/质量/步数等）"：段级无独立分辨率/质量/步数·全继承 globalParams
//   （侦察 Q3）→「比例」行以「比例（分辨率）」标注并挂映射说明行。
const RATIO_MAP_NOTE = t("preview.prompt.ratioNote");   // #89 T2：切换=整页 reload 故模块级常量同语言一致

function _phint(text) {
  return el("div", { class: "phint", style: "font-size:12px" }, [text]);
}

function renderPromptPage(page, projectId) {
  while (page.firstChild) page.removeChild(page.firstChild);
  const proj = storeLoad(projectId);
  if (!proj) { page.appendChild(_phint(t("preview.ph.noProject"))); return; }
  const segs = Array.isArray(proj.segments) ? proj.segments : [];
  // 当前段：模块级 _curSegId（null/查无该段 → 回退第一段·v2.1 复审 R2 跨项目切换残留边）
  let idx = segs.findIndex((s) => s && s.id === _curSegId);
  if (idx < 0) idx = 0;
  page.appendChild(el("div", {
    class: "ph-cap", "data-h3-role": "pv-prompt-seg",
    text: segs.length ? t("preview.prompt.curSeg", { n: idx + 1 }) : t("preview.prompt.noSegs"),
  }));
  // 参数镜像：proj.globalParams 键值逐行（只读·键序=createProject 全局序）；「比例」行挂映射说明
  //   #89 T2：参数键 k 与值 v=数据（键值零改动·写盘/镜像链零触）
  //   #92 B7：显示面 pickDisplay 映射（键名=MAPS.globalParamKeys·值=MAPS.globalParams·未覆盖直通）——
  //   zh 模式原值直通（渲染逐字同批前）；「比例」行显示名仍走 preview.prompt.ratioRes 特殊键
  const params = el("div", { "data-h3-role": "pv-prompt-params", style: "font-size:12px;color:var(--txt2);line-height:1.9;margin:6px 0 12px" });
  const gp = proj.globalParams && typeof proj.globalParams === "object" ? proj.globalParams : null;
  if (!gp) {
    params.appendChild(_phint(t("preview.ph.noGlobals")));
  } else {
    let ratioSeen = false;
    for (const [k, v] of Object.entries(gp)) {
      const isRatio = k === "比例";
      if (isRatio) ratioSeen = true;
      params.appendChild(el("div", { text: t("preview.prompt.paramLine", { k: isRatio ? t("preview.prompt.ratioRes") : pickDisplay("globalParamKeys", k), v: pickDisplay("globalParams", String(v)) }) }));
      if (isRatio) params.appendChild(el("div", { style: "color:var(--txt3)", text: RATIO_MAP_NOTE }));
    }
    if (!ratioSeen) params.appendChild(el("div", { style: "color:var(--txt3)", text: RATIO_MAP_NOTE }));
  }
  page.appendChild(params);
  // 全局提示词区（原文镜像·空 → 占位）
  page.appendChild(el("div", { class: "ph-cap", text: t("preview.prompt.global") }));
  const gHost = el("div", { "data-h3-role": "pv-prompt-global", style: "font-size:12px;white-space:pre-wrap;margin:6px 0 12px" });
  const gText = typeof proj.globalPrompt === "string" ? proj.globalPrompt.trim() : "";
  gHost.appendChild(gText ? el("div", { text: gText }) : _phint(t("preview.prompt.noGlobal")));
  page.appendChild(gHost);
  // 分镜提示词区（pvbox buildPvPreview 同源合成·空段词 → 占位）
  page.appendChild(el("div", { class: "ph-cap", text: t("preview.prompt.segText") }));
  const sHost = el("div", { "data-h3-role": "pv-prompt-segtext", style: "font-size:12px;white-space:pre-wrap;margin:6px 0" });
  const segObj = segs[idx];
  const composed = segObj ? buildPvPreview(segObj.prompt, proj.globalPrompt, {}) : "";
  sHost.appendChild(composed ? el("div", { text: composed }) : _phint(t("preview.prompt.noSegText")));
  page.appendChild(sHost);
}

// ===== 挂载（shell renderRoute 分支调用）=====
// hooks 可选：{review, cut, monWall, concat, toast} —— 缺省绑定 edit.js/concat 既有实现；测试可注入 stub
export function mount(container, projectId, hooks) {
  if (typeof document === "undefined" || !container) return null;
  _progDestroy(); // 重挂先停上一张表（幂等）
  _liveProgDestroy(); // B7-T1：live 进度同款重挂先停（帧/状态缓存保留·下方消费）
  _filmDestroy(); // 批 J-P14：断上一挂载的胶片条观察者（不漏旧 IntersectionObserver）
  const proj = storeLoad(projectId);
  if (!proj) {
    container.appendChild(el("div", { class: "shell-tab-placeholder" }, [
      el("div", { class: "ph-cap", text: t("preview.ph.noProject") }),
    ]));
    return null;
  }
  const segs = Array.isArray(proj.segments) ? proj.segments : [];
  const st = proj.editingState && typeof proj.editingState === "object" ? proj.editingState : {};
  const clips = Array.isArray(st.mainClips) ? st.mainClips : [];
  while (container.firstChild) container.removeChild(container.firstChild);

  const H = Object.assign({
    review: () => openReviewModal(projectId),
    cut: (btn) => cutConfirm(btn),
    monWall: (btn) => monWallClick(btn),
    // 批 10C-T3 · F46：右键菜单动作接真缺省（测试经 hooks 注入 stub）——core/review.js:49/:101
    sameSeed, approve: approveApi, voidSeg: voidSegApi, // 10-E-T3：+sameSeed（同种子重跑·首调+force 消费）·F65：rerun 缺省摘（无消费面·改走 runRerunFlow）
    confirm: openConfirm, removeSeg: removeSegment, save: storeSave, // ui/modal.js mbox 确认件·store.js:466/:803
  }, hooks || {});

  const root = el("div", { class: "pview", id: "pv-preview" });
  // G1·#49：run0 = runs 行快照（建条种子 percent 数据源）；#63 T4：随 currentRunId 指针行
  //   （缺失/悬空回落 runs[0]·旧项目兼容）
  root.appendChild(buildOpBar({ runState: proj.runState || null, segs, run0: currentRunRow(proj) })); // 公共区：状态灯（R54-T2 止损迁 live 子页）
  // 批5-R54-T1：页内三子页签条（F-62 .fchips 全局件·零新增 chip CSS）
  const subBar = el("div", { class: "fchips" });
  const subChips = {};
  for (const [key, label] of PREVIEW_SUBS) {
    const chip = el("span", { class: "fchip", "data-h3-role": "pv-subtab", "data-subtab": key, text: label });
    chip.addEventListener("click", () => applyPreviewSubTab(key));
    subChips[key] = chip;
    subBar.appendChild(chip);
  }
  root.appendChild(subBar);
  // 视频预览子页：审片钮左上（原操作条审片键·行为不变位置迁移）+ 播放器
  const videoPage = el("div", { class: "pv-subpage", "data-h3-role": "pv-subpage-video" });
  const reviewBtn = el("span", {
    class: "ghostbtn",
    "data-h3-role": "reviewBtn",
    style: "align-self:flex-start;margin-bottom:8px",
    title: t("preview.op.reviewTitle"),
  }, [el("span", { "data-ic": "compare", "data-sz": "13" }), t("preview.op.review")]);
  reviewBtn.addEventListener("click", () => H.review());
  videoPage.appendChild(reviewBtn);
  const player = buildPlayer(segs, clips, H.toast || showToast);
  videoPage.appendChild(player.node);
  // live/prompt 子页容器（同挂 DOM 零销毁）——live 子页：止损钮左上 + live 三件 + 空态占位
  const livePage = el("div", { class: "pv-subpage", "data-h3-role": "pv-subpage-live" });
  // 批5-R54-T2：止损钮从操作条迁入 live 子页左上（id/配色/文案/click→hooks.cut 链原样·位置迁移）
  const cutBtn = el("span", {
    class: "ghostbtn",
    id: "cutBtn",
    style: "align-self:flex-start;margin-bottom:8px;color:#d98c8c;border-color:#4a2a2a",
    title: t("preview.op.cutTitle"),
  }, [t("preview.op.cut")]);
  cutBtn.addEventListener("click", () => H.cut(cutBtn));
  livePage.appendChild(cutBtn);
  // 批5-R54-T2：live 三件迁入（B7-T1 件·原 .player 内——帧/视频不同框·默认全隐，live 信号逐件亮；
  //   降级条样式沿用 legacy preview_canvas.js:137 黄警示形态）
  const degraded = el("div", {
    "data-h3-role": "preview-degraded",
    style: "display:none;padding:3px 10px;border-radius:3px;font-size:12px;background:rgba(249,168,37,.18);color:#f9a825;border:1px solid #f9a825",
  });
  const frameImg = el("img", {
    "data-h3-role": "preview-frame-img",
    alt: t("preview.live.frameAlt"),
    style: "display:none;max-width:100%;max-height:360px;object-fit:contain;background:#000;border-radius:4px",
  });
  const liveProgHost = el("span", {
    "data-h3-role": "preview-live-prog",
    style: "display:none",
  });
  livePage.appendChild(degraded);
  livePage.appendChild(frameImg);
  livePage.appendChild(liveProgHost);
  // 批5-R54-T2：空态占位（无 live 帧+无运行任务 → 可见；.player 占位 .phint 同风格·显隐归 _applyLiveEmpty）
  const liveEmpty = el("div", {
    class: "phint",
    "data-h3-role": "pv-live-empty",
    style: "display:none;font-size:12px;padding:18px 0",
  }, [t("preview.live.empty")]);
  livePage.appendChild(liveEmpty);
  const promptPage = el("div", { class: "pv-subpage", "data-h3-role": "pv-subpage-prompt" });
  _liveEls = { img: frameImg, degraded, progHost: liveProgHost, empty: liveEmpty }; // B7-T1：登记本次挂载的 live 宿主（R54-T2 目标=live 子页内元素·卸载置 null·缓存跨挂载存活）
  root.appendChild(videoPage);
  root.appendChild(livePage);
  root.appendChild(promptPage);
  // 老板 2026-10-07：全片预览/胶片条交界手柄（显隐随 video 子页·applyPreviewSubTab 裁决）
  const resizeHandle = el("div", { class: "pv-resize", "data-h3-role": "pv-resize", title: t("preview.resize.title") });
  root.appendChild(resizeHandle);
  const strip = buildFilmstrip(segs, clips, { projectId, hooks: H, player });
  root.appendChild(strip.node);
  mountPreviewResize(player.node, resizeHandle);
  // 子页签生效：恢复记忆（脏值/无键 → 默认视频预览）·含手柄显隐与刷新钩子首触发
  _pvSub = { chips: subChips, pages: { video: videoPage, live: livePage, prompt: promptPage }, handle: resizeHandle };
  // 批5-R54-T3：进入 prompt 子页即重读渲染（钩子含已激活态重复调用——T4 再点段依赖）；
  //   须在 applyPreviewSubTab 恢复记忆前注册（localStorage 恢复到 prompt 时首渲染即发生）
  onSubTabShown((name) => { if (name === "prompt") renderPromptPage(promptPage, projectId); });
  let subTab = "video";
  try {
    const saved = localStorage.getItem(PREVIEW_SUB_KEY);
    if (saved === "live" || saved === "prompt") subTab = saved;
  } catch (_e) { /* 无 localStorage（单测桩/隐私态）→ 默认视频预览 */ }
  applyPreviewSubTab(subTab);
  container.appendChild(root);
  _fsRemount = () => { _dualDestroy(); mount(container, projectId, hooks); }; // 批 10C-T3 · F46：段删除后重挂（含本次注入 hooks）；#68 重挂前销毁旧双缓冲
  // 批 10-L L1-3 修正笔：产物入轨 → 重挂（预览页此前无 store 订阅·运行完成仍显示「待生成」，
  //   手动刷新才正常——store 有数据、纯视图未重渲）。
  //   keys 只认 mainClips：画布 persistCanvas 在拖节点/改参数时高频写 keys=["canvas"]，
  //   不过滤会引发预览页重挂风暴（重挂重建整棵 .pview 并停进度表）。
  //   必须延到本轮 notify 之后再重挂：store.notify 用 Set 迭代器遍历，重挂若在回调内同步发生，
  //   新订阅者会被同一轮 notify 立即回调 → 反复重挂（实测挂死进程）。
  if (_subFn) storeUnsubscribe(_subFn);
  _subFn = (ev) => {
    if (!ev || ev.projectId !== projectId) return;
    // G1·#49：runs 落账必经链（settleLatestRun→updateProjectMeta→notify）→ 概况页条喂 percent。
    //   先判空（重挂/终态销毁后 _pvProg=null·防 NPE）→ storeLoad 自取 runs 行 → percent 变化才
    //   update（行失字段 → pct=null 守卫跳过·显示冻结不回退 phase 态）。
    if (ev.type === "project:meta-update") {
      if (!_pvProg) return;
      const pr = storeLoad(projectId);
      const r0 = currentRunRow(pr);   // #63 T4：进度条随 currentRunId 指针行（缺失回落 runs[0]）
      const pct = (r0 && typeof r0.percent === "number" && Number.isFinite(r0.percent)) ? r0.percent : null;
      if (pct == null || pct === _pvLastPercent) return;
      _pvLastPercent = pct;
      _pvProg.update({ percent: pct });
      return;
    }
    if (ev.type !== "editingState:update") return;
    if (!Array.isArray(ev.keys) || !ev.keys.includes("mainClips")) return;
    if (_remountPending) return;   // 同 tick 多次入轨只重挂一次
    _remountPending = true;
    setTimeout(() => {
      _remountPending = false;
      if (_fsRemount) _fsRemount();
    }, 0);
  };
  storeSubscribe(_subFn);
  // B7-T1：消费模块级 live 缓存（挂载前到达的最新帧/状态/进度即刻呈现）
  _applyLiveFrame();
  _applyLiveStatus();
  // 批5-R54-T2：空态按当下态计算（有缓存帧→已被 _applyLiveFrame 退场；无帧+无运行任务→占位）
  _applyLiveEmpty(!!(proj.runState && proj.runState.running));
  if (_live.percent != null) pushLiveProgress(_live.percent);
  // 点胶片条/拼接钮以外区域 → 清多选（原型 document 委托 :3110-3113 的 root 级等价 · 随 DOM 重建自动回收）
  root.addEventListener("click", (e) => {
    let n = e.target;
    while (n && n !== root) {
      const cls = String(n.className || "").split(/\s+/);
      if (cls.includes("fsthumb") || cls.includes("fs-stitch-btn")) return;
      n = n.parentElement || n._parent || null;
    }
    strip.clearSel();
    strip.updateStitch();
  });
  hydrateIcons(container);
  return root;
}
