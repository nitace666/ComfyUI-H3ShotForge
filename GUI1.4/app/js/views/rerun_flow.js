// views/rerun_flow.js — B4-T2 D2 重跑链共享编排（rerun/同种子/失败段/段精修共用）
//
// === 任务边界 ===
//   1. runRerunFlow({projectId, taskId, sids, keepSeed, label, kind, submit?})
//      提交步（默认 rerunSelected）→ appendRunRecord 落账 → pollAndSettle → 终态 toast
//      submit 可注入：同种子二段式 force:true 的 sameSeed 作提交步（引擎已 started 的链路
//      不得再 POST rerun——二次 POST 必 409 active_busy）
//   2. pollAndSettle(taskId, {projectId, label, kind, sids}) 导出子流程
//      轮询 + 按 stem settle + 终态回轨 + toast——不含提交步（T3 seg_edit 复用）
//   3. settleRunByStem(projectId, stem, patch) 按 stem 找 runs 记录 settle
//      （同 stem 多条 = 自顶向下首条 running 匹配·不动 submit-bar settleLatestRun）
//   4. isRerunPolling(stem) / _test_rerunActiveCount() 在跑链活链表查表口（批 M5b T2）
//
// === 引擎行为基线（双审实证·不可凭直觉）===
//   rerun 响应 task_id 恒为原值；产物落原任务 run_dir 追加 _reruns 账本（无新目录无新 CSV）；
//   引擎 _active 单任务互斥（并发 409 active_busy·引擎中文 msg 统一透传 error toast）。
//
// === 取舍注记（详案定夺·锁死）===
//   - 记录形状 {stem, sids, kind, label, running, at}——不存 total/done 计数：
//     #15 status payload 是全任务计数，与单段重跑错位（B8·buildRunRow kind 行不显示 N/M）。
//   - pollStatus 副作用（B7）：rerun 进 submitHistory + 终态通知 = 有意——用户可感「跑了」的真实事件。
//   - altClips 取舍（批 B T5 更正·B3 旧注已废止）：仍不自动 applyHistory（防 writeEs 覆写冲击
//     正在编辑的时间线），但终态改为调 rebuildAltClipsInProject 按引擎 _reruns 账本**整组重建**
//     备选轨 _reruns 系 —— 重跑完的新 take 自动进备选轨等审核（F107「重跑后备选轨不出候选」治）。
//
// ESM 依赖链（单向）: core/submit(pollStatus) + core/rerun(rerunSelected) + 同层 views/submit-bar 三导出。

import { pollStatus } from "../core/submit.js";
import { rerunSelected } from "../core/rerun.js";
import { loadDetail } from "../core/history_ops.js";
import { rebuildAltClipsInProject } from "../core/candidates.js";
import { healRenamedFiles } from "../core/rename_heal.js";
import { showToast } from "../ui/toast.js";
import { load as storeLoad, updateProjectMeta, updateEditingState } from "../store/store.js";
import { runStamp, appendRunRecord, syncRunProducts, refreshTimelineShotColors, notifyRerunBusy, notifyRerunIdle } from "./submit-bar.js";
// T3：重跑参数未变 → 不重复落快照，runs 行 recordId 指回主任务快照（sourceRecordId 语义）
import { findMainSnapshotId } from "../core/run_snapshots.js";

// ============================================================================
// 0. 在跑重跑链活链表（批 M5b T2·R-48 刷新断链对账的查表件）
//   注册=pollAndSettle 建链处（含 runRerunFlow 右键原链）；摘除=onFinal 首行 + stop 路径。
//   为何必须有摘除：rerun stem 恒为原值（引擎基线·响应 task_id 恒原值）——死链占表不摘，
//   下次刷新对账查表命中「在链跳过」=不轮询，断链以新形态复发（R-48 主诉的病根）。
// ============================================================================
const _activePolls = new Map();

/** 该 stem 是否已有在跑链（submit-bar 挂载对账步的重挂去重守卫·同任务恒一条链） */
export function isRerunPolling(stem) {
  return !!(stem && _activePolls.get(stem));
}

/** 在跑重跑链条数（单测计数手段·对齐 _test_setPollInterval 注入位惯例） */
export function _test_rerunActiveCount() { return _activePolls.size; }

// ============================================================================
// 1. settleRunByStem — 按 stem 找 runs 记录 settle（自顶向下首条 running 匹配）
// ============================================================================
export function settleRunByStem(projectId, stem, patch) {
  if (!projectId || !stem || !patch || typeof patch !== "object") return false;
  const p = storeLoad(projectId);
  if (!p || !Array.isArray(p.runs)) return false;
  const idx = p.runs.findIndex((r) => r && r.stem === stem && r.running === true);
  if (idx < 0) return false;
  const runs = p.runs.slice();
  runs[idx] = { ...runs[idx], ...patch };
  return updateProjectMeta(projectId, { runs });
}

// ============================================================================
// 4. 重跑自动补后期桥（批②F-114 笔1·core 不反查 views·对齐 setToastBridge 桥先例）
//   shell mount 一次挂线注入：({projectId,taskId,sids}) → core supplementPostfxAfterRerun
//   （消费 io=shell _postfxToastIo·toast+settle 收口 autoConcat 照常）。未注册=不补
//   （无消费 io 宁缺不误）；四链（rerun/同种子/seg_edit/只重渲失败段）全消费方=本文件
//   onFinal 唯一终态收口，另含 submit-bar 挂载对账重建链（同走 pollAndSettle）。
// ============================================================================
let _postfxRerunSupplement = null;
export function setPostfxRerunSupplement(fn) {
  _postfxRerunSupplement = typeof fn === "function" ? fn : null;
}
export function getPostfxRerunSupplement() { return _postfxRerunSupplement; }
export function _test_resetPostfxRerunSupplement() { _postfxRerunSupplement = null; }

// 重跑成功段白名单：payload.shots status==="success" 过滤（sids 空=全段重跑形态→取全部
// 成功键；shots 缺失=零补）。deadByNull 合成终态 shots:{} → 天然空数组。
function _rerunSuccessSids(payload, sids) {
  const shots = (payload && payload.shots && typeof payload.shots === "object" && !Array.isArray(payload.shots))
    ? payload.shots : null;
  if (!shots) return [];
  const want = (Array.isArray(sids) && sids.length) ? new Set(sids.map(String)) : null;
  const out = [];
  for (const [sid, shot] of Object.entries(shots)) {
    if (shot && shot.status === "success" && (!want || want.has(String(sid)))) out.push(String(sid));
  }
  return out;
}

// 补链（异步·不阻断终态收尾）：非 ok 返回可见提示不静默吞（实施条件 2——already_running
//   =info 跳过·其余 warn）；引擎失联/无响应合成终态零补（任务未完成·补在半成品上=错产物）。
async function _postRerunSupplement(taskId, opts, payload, syncP) {
  if (!_postfxRerunSupplement || !Array.isArray(opts.sids)) return;
  if (payload && (payload._engineDeadByNull === true || payload._engineDeadAfterEmpty === true)) return;
  const sids = _rerunSuccessSids(payload, opts.sids);
  if (!sids.length) return;
  // 定序（方案钦定）：先 await syncRunProducts 回轨（补预检 segHasTargetStamps 须读到
  //   回轨后产物名）；回轨失败照发补（预检读现态）——不因回轨失败静默吞补。
  try { await syncP; } catch (_e) { /* 同 void 时代容错 */ }
  try {
    const r = await _postfxRerunSupplement({ projectId: opts.projectId, taskId, sids, gpOverride: opts.gpOverride });
    if (r && r.ok === false) {
      if (r.reason === "already_running") showToast("info", "后期自动补：已有后期编排进行中·本次跳过");
      else showToast("warn", `后期自动补未执行（${String((r && r.reason) || "未知原因")}）`);
    }
  } catch (_e) { /* 桥异常无可恢复动作——终态 toast 已发·不外抛炸轮询收尾 */ }
}

// ============================================================================
// 2. pollAndSettle — 轮询 + 按 stem settle + 终态回轨 + toast（不含提交步·T3 复用）
// ============================================================================
// 批 B T5：终态同步重建备选轨 _reruns 系（core 层函数·经 store 读写 altClips）。
//   自取一次 detail 后整组替换受影响 sid 的重跑系候选；与 submit-bar.syncRunProducts
//   内的重建构成双触发——由 rebuildAltClips 的幂等键（sid+引擎 seq）去重·不翻倍。
async function rebuildAfterRerun(projectId, taskId, sids) {
  if (!projectId || !taskId) return null;
  const d = await loadDetail({ taskId });
  if (!d.ok || !d.raw) return null;
  return rebuildAltClipsInProject(projectId, d.raw, Array.isArray(sids) && sids.length ? sids : null);
}
export function pollAndSettle(taskId, opts = {}) {
  const projectId = opts.projectId || "";
  const label = opts.label || "重跑";
  // 批 10-L L1-3：入轨节流计数（链级）——done 变化才调 syncRunProducts，禁每拍必调
  let lastSyncDone = 0;
  const h = pollStatus({
    stem: taskId,
    outputDir: "",
    intervalMs: opts.intervalMs || 3000,   // 批 10-L L1-3：opts 可注入轮询节奏（单测提速；缺省 3000 不变）
    // 批 M5b T1（F109·R-48）：重跑链接入引擎无响应阈值——与主链 startPoll 同口径 16 拍
    //   （submit-bar.js:865·缺省 3s 间隔下 ≈80s）。引擎进程被 kill 后 status 恒失败拍，
    //   阈值内由 core 合成中断终态走 onFinal 原路——否则重跑行恒「重跑中…」至天荒地老。
    deadAfterNulls: 16,
    // G2·#57：队列行来源字段透传（rerun/seg_edit——heal/attach 对真重跑行零触碰的判别地基）
    historyKind: opts.kind || "rerun",
    // B5-T4 C2：每 tick 幂等重刷片段状态左边条（DOM-only·不写 store）
    onTick: (data) => {
      // G-T0（P-4 收口·批 C 遗留）：与主链（submit-bar onTick）同款传 clip 数据——着色走
      //   sid 对号（split- 双半同色 / 调序不错染）；每拍活读不外提（增量入轨会改 mainClips 序/sid）。
      const pc = projectId ? storeLoad(projectId) : null;
      refreshTimelineShotColors(
        data && data.shots,
        null,
        (pc && pc.editingState && Array.isArray(pc.editingState.mainClips)) ? pc.editingState.mainClips : null,
      );
      // 批 10-L L1-3（F92a）：与主提交链同款——done 变化即增量入轨（重跑期间片段条/剪辑页
      //   即时可见）；红线同款：detail 端点压引擎侧并发探测 Semaphore(4)·未变拍零动作。
      const d = data && typeof data.done === "number" ? data.done : null;
      if (d != null && d !== lastSyncDone) {
        lastSyncDone = d;
        void syncRunProducts(projectId, taskId);
      }
    },
    onError: () => {},
    onFinal: (payload) => {
      // 批 M5b T2：终态首行摘除活链表（对齐主链 submit-bar.js:902 摘除形态）——摘在业务动作之前，
      //   终态回调里再发起同 stem 新链也能立刻登记。
      if (_activePolls.get(taskId) === h) _activePolls.delete(taskId);
      // 批 W1 F113a：副态摘除与活链表同拍（按钮角标复位——防终态后仍显「重跑中…」）
      notifyRerunIdle(taskId);
      const failed = (payload && typeof payload.failed === "number") ? payload.failed : 0;
      // 批 M5b T1（F109）：引擎失联（core 合成终态·引擎进程已死）——settle 补中断终态字段
      //   （result=failed 供渲染侧显「已中断」·shell.js buildRunRow 已随批 M5b T2 落地）
      const deadByNull = !!(payload && payload._engineDeadByNull === true);
      // 按 stem settle（退出 running·不写 done/failed——全任务计数与单段重跑错位）
      settleRunByStem(
        projectId,
        taskId,
        deadByNull
          ? { running: false, result: "failed", interrupted: true, reason: "engine_unreachable" }
          : { running: false },
      );
      // 终态回轨（mainClips 填最新 take）——批②F-114：句柄化供补链 await 定序（void 语义
      //   由紧跟 catch 保住：无人消费时不产生未处理拒绝·行为与原 void 等价）。
      const _syncP = syncRunProducts(projectId, taskId);
      _syncP.catch(() => {});
      // 批 B T5：终态同步重建备选轨 _reruns 系（重跑完的新 take 自动进备选轨等审核）
      //   受影响 sid = 本次重跑的 sids（opts.sids）——与 syncRunProducts 内的重建同批幂等，不翻倍
      void rebuildAfterRerun(projectId, taskId, opts.sids);
      // 批 M5b T1（F109）：_engineDeadByNull 分支排最前（与主链 pollFailedToast 同序）——
      //   合成终态载荷无 done/failed·落其后会走「完成」成功分支=谎报。
      if (deadByNull) {
        showToast("error", `${label}中断 · 引擎失联·任务未完成`);
      } else if (payload && payload._engineDeadAfterEmpty) {
        showToast("error", `${label}失败 · 引擎无响应`);
      } else if (failed > 0) {
        showToast("warn", `${label}完成 · ${failed} 段失败`);
      } else {
        showToast("success", `${label}完成`);
      }
      // 批②F-114 重跑自动补（四链全消费方）：判成功段白名单 → 桥发补（异步·不阻断终态收尾）
      //   T5 #31b：gpOverride（重跑弹窗「后期处理（仅本次）」）随链透传——不传=undefined 默认全局
      void _postRerunSupplement(taskId, { projectId, sids: opts.sids, gpOverride: opts.gpOverride }, payload, _syncP);
    },
  });
  // 批 M5b T2：建链即登记活链表（供挂载对账步查重）——stop() 路径同步摘除，
  //   否则手动停止的链留在表里·下次刷新对账被误判「在链」跳过（=不轮询的断链新形态）。
  _activePolls.set(taskId, h);
  // 批 W1 F113a：建链同拍登记副态（按钮角标数据源——与活链表同生命周期）
  notifyRerunBusy(taskId);
  if (typeof h.stop === "function") {
    const _rawStop = h.stop;
    h.stop = (stopOpts) => {
      if (_activePolls.get(taskId) === h) _activePolls.delete(taskId);
      // 批 W1 F113a：手动停止=结束·副态同拍摘除（防角标悬挂）
      notifyRerunIdle(taskId);
      return _rawStop(stopOpts);
    };
  }
  return h;
}

// ============================================================================
// 3. runRerunFlow — 提交步 + 落账 + 发起时自愈 + pollAndSettle（一条龙）
// ============================================================================
// R53 域重对齐 P1-c（发起时机）：rerun POST 成功瞬间引擎已把该 sid 全部现行 takes 改名
//   {原名}_old_NN.mp4（生成之前）——主轨/备选条目里的原路径即刻成死链（渲染窗主轨死路径·B-B2-1）。
//   此刻 browse 该 run_dir 反查自愈（工具内按目录去重·通常一次）；browse 失败保留原 file 不阻塞
//   提交链（B-S2-3）；只写 file，不动 localPick/ver/review/state。终态/挂载兜底在 syncRunProducts ③。
async function healRenamesAfterSubmit(projectId, sids) {
  const p = storeLoad(projectId);
  const es = p && p.editingState;
  if (!es) return 0;
  const sidSet = new Set((Array.isArray(sids) ? sids : []).map(String));
  const hit = (c) => ((c && sidSet.has(String(c.sid)) && typeof c.file === "string" && c.file) ? c : null);
  const entries = [];
  for (const c of (Array.isArray(es.mainClips) ? es.mainClips : [])) { const x = hit(c); if (x) entries.push(x); }
  for (const a of (Array.isArray(es.altClips) ? es.altClips : [])) { const x = hit(a); if (x) entries.push(x); }
  if (!entries.length) return 0;
  const healed = await healRenamedFiles(entries, ""); // runDir 空 → 按 entry 自身目录分组（同目录去重一次 browse）
  if (healed > 0) updateEditingState(projectId, { mainClips: es.mainClips, altClips: es.altClips });
  return healed;
}

export async function runRerunFlow(opts = {}) {
  const { projectId, taskId, sids, keepSeed } = opts;
  const label = opts.label || "重跑";
  const kind = opts.kind || "rerun";
  if (!projectId || !taskId || !Array.isArray(sids)) {
    return { ok: false, error: { code: "validation", msg: "runRerunFlow 缺 projectId/taskId/sids", detail: null, httpStatus: 0 } };
  }
  // 提交步：默认 rerunSelected；同种子二段式注入 sameSeed(force:true)（不得二次 POST rerun）
  const submitFn = typeof opts.submit === "function"
    ? opts.submit
    : () => rerunSelected({ taskId, sids, keepSeed: !!keepSeed });
  const r = await submitFn();
  if (!r || !r.ok) {
    const err = (r && r.error) || null;
    // 引擎 409 四态/400 统一透传引擎中文 msg（error toast·全入口一致口径）
    const reason = (err && err.msg) || (err && err.code) || "未知错误（引擎未连接？）";
    // B5-T1①（批 4 遗留②）：seg_edit 链路精修已落侧车——缺「已保存」语义用户会误判编辑全丢
    //   （其余 kind 文案不变：不得无条件加前缀）
    showToast("error", kind === "seg_edit" ? `精修已保存，但重跑提交失败：${reason}` : `${label}提交失败：${reason}`);
    // 批 W1 F113a：失败路径防御性复位（同种子二段式注入场景本 taskId 可能已登记副态）
    notifyRerunIdle(taskId);
    return { ok: false, error: err };
  }
  // 落账：{stem, sids, kind, label, running, at}——不存 total/done（B8）
  // T3：参数未变 → 不落新快照；recordId 指向同任务主快照（无主快照=旧记录·不写该字段）
  const _sourceRecordId = await findMainSnapshotId(projectId, taskId);
  appendRunRecord(projectId, {
    stem: taskId,
    sids: sids.slice(),
    kind,
    label,
    running: true,
    at: runStamp(),
    ...(_sourceRecordId ? { recordId: _sourceRecordId } : {}),
  });
  showToast("info", `${label}已提交——轮询中（task_id=${taskId}）`);
  // R53 P1-c：发起时自愈（POST 成功=改名已发生·生成未始）——await 完成再建轮询链，
  //   主轨在渲染窗全程可播不断；终态/挂载兜底由 syncRunProducts ③ 同款逻辑接管。
  await healRenamesAfterSubmit(projectId, sids);
  // T5 #31b：gpOverride 随链透传（openRerunModal「后期处理（仅本次）」→ 补链装配·仅本次）
  const poll = pollAndSettle(taskId, { projectId, label, kind, sids, gpOverride: opts.gpOverride });
  return { ok: true, poll };
}
