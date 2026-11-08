// core/postfx_pipeline.js — R-57 乙档后期处理逐段串联编排（R56R57-S3 适配 T3）
//
// === 任务边界 ===
//   1. 参数装配（T1 六键 globalParams.postfx_*）→ buildPostfxPlan 纯函数：
//      postfx_upscale=true → kinds 含 "upscale"（postfx_scale 非空={mode:scale,scale}；
//      否则 postfx_w/h 均非空={mode:target,width,height}；否则缺省不发=引擎默认）；
//      postfx_fps 非空 → kinds 含 "interp"+{target_fps}；两者皆无 → null（零编排）。
//   2. 逐段串行：对 mainClips 现行段（有 sid 且产物在 run_dir 根下）逐段
//      postfxRun({taskId, kinds, sids:[sid], engineChoice, upscaleParams, interpParams})
//      → 轮询 postfxStatus 至 running=false → 下一段；段失败隔离记 failed 继续下一段。
//   3. 幂等（G4 #50-3 manifest 版）：触发前现取 detail 顶层 _postfx（引擎 E6 透出·权威
//      数据源——段账本 files 恒为无戳原件名，文件名判据恒不失效防不住重跑）→ plan.kinds
//      各 kind 子表均含 sid=已后期先跳（引擎 E7 judgment gating 同判据）；detail 取数失败
//      fail-closed 零请求零戳文件；detail 无 _postfx 键（旧引擎）降级旧文件名判据。
//   4. 生命周期：编排状态落项目 runs（kind:"postfx"·段清单+段级成败+at）；
//      重进对账 reconcilePostfx：引擎 running→重建轮询续排；空闲→按已记录段级成败收口；
//      引擎死/中断→行落中断态（不静默消失）。
//
// === 消费方（shell.js 接线·本模块零 UI）===
//   - 主链 onComplete → startPostfxForProject(projectId, io, taskId?)（任务号三路：载荷直递/
//     runs 最新非 postfx 行兜底/loadedTaskId·三路全空 onNoTask 提示；全局关零编排）；
//   - 项目视图重挂 → reconcilePostfx(projectId, io)；
//   - 进度/终态 = io.onProgress/onSettled 回调（shell 侧接 toast·「后期处理 第 N/共 M 段·超分+插帧中」）。
//
// === 未含项（方案原文）===
//   备选轨产物不入编排（只读 editingState.mainClips）；引擎仓零改。
//   （批②F-114 更新：旧「rerun/seg_edit 完成后不自动追加」注记废止——重跑链终态自动补
//   已由 supplementPostfxAfterRerun 承接·审建议 14。）
//
// ESM 依赖链（单向）：./postfx.js（postfxRun/postfxStatus/戳纯函数）+ ./api.js
//   （request·G4 detail 现取）+ ../store/store.js
//   （load/updateProjectMeta 落 runs——updateProjectMeta 白名单既有 runs 键·store 零改）。
//   io 全量可注入（传输层假件单测直拍）；本模块不 import views/ui。

import { load as storeLoad, updateProjectMeta } from "../store/store.js";
import { request } from "./api.js";
import { postfxRun, postfxStatus, upscaleStamp, interpStamp, hasStampToken, verifyPostfxFinal } from "./postfx.js";
// T3：后期行落自身快照（后期参数 + sourceRecordId 指主任务快照）；写失败不阻塞编排
import { buildRunSnapshotPayload, findMainSnapshotId, saveRunSnapshot } from "./run_snapshots.js";

// ============================================================================
// 1. 参数装配（纯函数）
// ============================================================================

// "2"/" 2 "/2 → 2；空串/纯空白/非数字 → null（留空语义）
function _num(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// T1 六键 → 编排计划（唯一装配形态——T4 #31 撤段卡三勾选后，buildPostfxPlan 回退单计划；
//   旧第二入参段级分组分支/collectSegPostfxIntents/_segInfoOf/_mergeGroup 已死码退役）。
// 无勾选（kinds 空）→ null = 零编排。
//   - scale 非数字视作留空（落 target/缺省）——输入框脏值的留空语义。
//   - 宽高取整（引擎 target 模式要求整数形态）。
export function buildPostfxPlan(gp) {
  const g = gp && typeof gp === "object" ? gp : {};
  const kinds = [];
  const engine = typeof g.postfx_engine === "string" ? g.postfx_engine.trim() : "";
  const plan = { kinds, engineChoice: engine || "seedvr2" };
  if (g.postfx_upscale) {
    kinds.push("upscale");
    const s = _num(g.postfx_scale);
    if (s != null) {
      plan.upscaleParams = { mode: "scale", scale: s };
    } else {
      const w = _num(g.postfx_w);
      const h = _num(g.postfx_h);
      if (w != null && h != null) {
        plan.upscaleParams = { mode: "target", width: Math.round(w), height: Math.round(h) };
      }
    }
  }
  const fps = _num(g.postfx_fps);
  if (fps != null) {
    kinds.push("interp");
    plan.interpParams = { target_fps: fps };
  }
  return kinds.length ? plan : null;
}

// 产物在 run_dir 根下判据：父目录叶名非 upscaled/interp（引擎产物布局——
// 已后处理的产物落子目录，主链原件在根）。无目录（裸文件名）无从归属 → false。
function _inRunDirRoot(file) {
  const s = String(file == null ? "" : file).replace(/\//g, "\\");
  const i = s.lastIndexOf("\\");
  if (i < 0) return false;
  const dir = s.slice(0, i);
  const leaf = dir.slice(dir.lastIndexOf("\\") + 1).toLowerCase();
  return leaf !== "upscaled" && leaf !== "interp";
}

// mainClips 现行段清单：有 sid（引擎段号）且产物在 run_dir 根下；保 mainClips 序。
export function collectPostfxSegments(mainClips) {
  const clips = Array.isArray(mainClips) ? mainClips : [];
  const out = [];
  for (const c of clips) {
    if (!c || typeof c !== "object") continue;
    if (typeof c.sid !== "string" || !c.sid) continue;
    if (typeof c.file !== "string" || !c.file) continue;
    if (!_inRunDirRoot(c.file)) continue;
    out.push({ sid: c.sid, file: c.file });
  }
  return out;
}

// 旧文件名判据（G4 前原实现·版本降级专用）：段产物 file 名已带「全部请求 kind」的
// 目标戳（hasStampToken "_" 切词整词命中·与引擎 X5 旧判据同源）。仅当 detail 无
// _postfx 键（旧引擎未部署）时降级使用。
function _segHasTargetStampsByFile(file, plan) {
  const p = plan && typeof plan === "object" ? plan : { kinds: [] };
  const i = String(file == null ? "" : file).lastIndexOf(".");
  const stem = i < 0 ? String(file == null ? "" : file) : String(file).slice(0, i);
  for (const k of Array.isArray(p.kinds) ? p.kinds : []) {
    if (k === "upscale" && !hasStampToken(stem, upscaleStamp(p.upscaleParams || null))) return false;
    if (k === "interp" && !hasStampToken(stem, interpStamp(p.interpParams || null))) return false;
  }
  return true;
}

// 幂等判据（G4 #50-3 manifest 版·与引擎 E7 X5 judgment 分支同判据）：plan.kinds 每个
// kind 的子表（postfxMap[kind]）都含该 sid → 已后期（全齐=skip 省一次往返）；任一 kind
// 缺 → 未后期。非 kind 键（failed/skipped/template_missing/level/status/final_parts/params）
// 只按请求 kinds 取子表天然不参与。sid 精确键命中，无文件名词边界歧义。
export function segHasTargetStamps(postfxMap, sid, plan) {
  const p = plan && typeof plan === "object" ? plan : { kinds: [] };
  const m = postfxMap && typeof postfxMap === "object" && !Array.isArray(postfxMap) ? postfxMap : null;
  if (!m || typeof sid !== "string" || !sid) return false;
  for (const k of Array.isArray(p.kinds) ? p.kinds : []) {
    const sub = m[k];
    if (!sub || typeof sub !== "object" || Array.isArray(sub)
        || !Object.prototype.hasOwnProperty.call(sub, sid)) return false;
  }
  return true;
}

// ============================================================================
// 2. 进度/终态文案（纯函数·shell 侧 toast 消费）
// ============================================================================

// 「后期处理 第 N/共 M 段·超分+插帧中」；waiting 载荷（忙类 409 退避等待期）→
// 「后期处理 第 N/共 M 段·引擎忙·排队中」（#50-4）
export function postfxProgressText(prog) {
  const p = prog && typeof prog === "object" ? prog : {};
  const kinds = Array.isArray(p.kinds) ? p.kinds : [];
  if (p.waiting) return `后期处理 第 ${p.current}/共 ${p.total} 段·引擎忙·排队中`;
  const up = kinds.includes("upscale");
  const ip = kinds.includes("interp");
  const doing = up && ip ? "超分+插帧中" : (ip ? "插帧中" : "超分中");
  return `后期处理 第 ${p.current}/共 ${p.total} 段·${doing}`;
}

export function postfxSettleText(res) {
  const r = res && typeof res === "object" ? res : {};
  if (r.interrupted) {
    // #64：用户停止 ≠ 引擎故障——不冒充「引擎不可达」
    if (r.reason === "user_stopped") return "后期处理已停止 · 进度已记录";
    const why = r.reason === "reconcile_idle" ? "引擎空闲收口" : "引擎不可达";
    return `后期处理已中断（${why}）· 进度已记录`;
  }
  if (r.failed > 0) return `后期处理完成 · ${r.done}/${r.total} 段成功·${r.failed} 段失败`;
  return `后期处理完成 · ${r.done}/${r.total} 段`;
}

// 任务号三路全空（有勾选）→ shell 侧可见提示文案（R-57：不静默不中断）
export const POSTFX_NO_TASK_TEXT = "后期处理未执行：找不到本次任务号——可从运行记录手动触发";

// ============================================================================
// 3. runs 行读写（store 惯例：倒序置顶 unshift·上限 30·按 postId 定位 settle）
// ============================================================================

// at 时间戳：与 submit-bar runStamp 同款分钟精度（不 import views——core 不引 views）。
function _runStamp(d) {
  const dt = d || new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
}

function _runsOf(p) {
  return p && Array.isArray(p.runs) ? p.runs : [];
}

function _appendPostfxRow(projectId, row, io) {
  const p = io.load(projectId);
  if (!p) return false;
  const runs = _runsOf(p).slice();
  runs.unshift(row);
  return io.updateProjectMeta(projectId, { runs: runs.slice(0, 30) });
}

// 按 postId 定位 kind:"postfx" 行打补丁（重跑抢位 runs[0] 时不误写他人记录——同 settleLatestRun 按 stem 口径）
function _settlePostfxRow(projectId, postId, patch, io) {
  const p = io.load(projectId);
  if (!p) return false;
  const runs = _runsOf(p).slice();
  const idx = runs.findIndex((r) => r && r.kind === "postfx" && r.postId === postId);
  if (idx < 0) return false;
  runs[idx] = { ...runs[idx], ...patch };
  return io.updateProjectMeta(projectId, { runs });
}

function _rowDone(row) {
  return row.segs.filter((s) => s.state === "done" || s.state === "skipped").length;
}
function _rowFailed(row) {
  return row.segs.filter((s) => s.state === "failed").length;
}

// ============================================================================
// 4. 在跑链活链表（重入守卫——同项目恒一条编排链；重挂对账/二次主链完成不双跑）
// ============================================================================
const _activeProjects = new Set();

// #64 停止令牌：projectId → reason。只在「该项目编排链在跑」时登记（取消请求作用于当次在跑链），
//   链收口即清——绝不做全局后期禁用开关（后续自然触发照常跑）。
const _cancelRequests = new Map();

export function _test_resetPostfxPipelines() {
  _activeProjects.clear();
  _cancelRequests.clear();
}

function _cancelReasonOf(projectId) {
  return _cancelRequests.get(projectId) || null;
}

// #64 停止入口（views 经导入调用·ESM 纪律：core 不 import views）：
//   ① 有在跑链 → 登记取消令牌（编排器三检查点命中即 interrupted 收口·不再发下一段）；
//   ② 该项目在跑 postfx 行落墓碑 `running:false/interrupted:true/reason=user_stopped`
//      ——刷新/切页重挂 reconcilePostfx 读墓碑不续排（否则根因 C 会接着超分）。
//   无活跃行=无墓碑可落（零副作用）；io 可注入（省略走 store 默认·与模块其余入口同口径）。
export function cancelPostfxFor(projectId, reason, io) {
  const pid = typeof projectId === "string" ? projectId : "";
  if (!pid) return false;
  const why = (typeof reason === "string" && reason) ? reason : "user_stopped";
  if (_activeProjects.has(pid)) _cancelRequests.set(pid, why);
  const o = _normalizeIo(io);
  const p = o.load(pid);
  if (!p) return true;
  const runs = _runsOf(p).slice();
  let changed = false;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r && r.kind === "postfx" && r.running === true) {
      runs[i] = { ...r, running: false, currentSid: null, interrupted: true, reason: why };
      changed = true;
    }
  }
  if (changed) o.updateProjectMeta(pid, { runs });
  return true;
}

// ============================================================================
// 5. 编排主链（runPostfxPipeline 起 run → orchestrate 逐段；reconcilePostfx 复用 orchestrate）
// ============================================================================

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _normalizeIo(io) {
  const o = io && typeof io === "object" ? io : {};
  return {
    postfxRun: o.postfxRun || postfxRun,
    postfxStatus: o.postfxStatus || postfxStatus,
    historyDetail: typeof o.historyDetail === "function" ? o.historyDetail : _historyDetail,
    load: o.load || storeLoad,
    updateProjectMeta: o.updateProjectMeta || updateProjectMeta,
    onProgress: typeof o.onProgress === "function" ? o.onProgress : null,
    onSettled: typeof o.onSettled === "function" ? o.onSettled : null,
    onNoTask: typeof o.onNoTask === "function" ? o.onNoTask : null,
    pollIntervalMs: typeof o.pollIntervalMs === "number" && o.pollIntervalMs >= 0 ? o.pollIntervalMs : 3000,
    maxPollErrors: typeof o.maxPollErrors === "number" && o.maxPollErrors > 0 ? o.maxPollErrors : 16,
    // 忙类 409 退避重试参数（真路径二实测：首请求落在引擎收尾窗内连吃 409）——
    // 全量可注入（单测假钟零真睡）；指数 2^n·单次上限 60s·总预算 15 分钟
    // （#50-4：180s→900s——共享引擎另一单渲染超 3 分钟时后期段直接放弃）。
    busyBackoffBaseMs: typeof o.busyBackoffBaseMs === "number" && o.busyBackoffBaseMs > 0 ? o.busyBackoffBaseMs : 2000,
    busyBackoffMaxMs: typeof o.busyBackoffMaxMs === "number" && o.busyBackoffMaxMs > 0 ? o.busyBackoffMaxMs : 60000,
    busyRetryBudgetMs: typeof o.busyRetryBudgetMs === "number" && o.busyRetryBudgetMs > 0 ? o.busyRetryBudgetMs : 900000,
    sleep: typeof o.sleep === "function" ? o.sleep : _sleep,
  };
}

// 忙类 409 判据：api.js 归一层 classifyBusy 四态（error.busyKind）；
// code 前缀兜底同四码（stub/归一形态差异时不漏判）。非忙类=非暂时态不重试。
// #26 T3：shell 编排收口自动拼接复用同判据 → 最小 export（消费方 shell.js autoConcatAfterSettle）。
export function _isBusyRunErr(r) {
  const e = r && r.error;
  if (!e) return false;
  if (e.busyKind) return true;
  return /^(active_busy|finalizing_busy|concat_busy|postfx_busy)/.test(String(e.code || ""));
}

// 段级 kinds/engineChoice：预检/postfxRun 载荷/对账重建三处同用 seg 级值——禁用行级 union
// kinds（union 预检会把 interp-only 已补段判 pending，引擎 X5 按 seg kinds 判全戳 →
// 400 stamped_already → 段误记 failed）。T4 #31 后新行段级值=行级同源（全局单计划）；
// 批② 段卡勾选时代旧行 segs 带段级字段（如 interp-only）→ 对账续排仍按原值（回落链保留）。
function _segKinds(row, seg) {
  return Array.isArray(seg.kinds) && seg.kinds.length ? seg.kinds : row.kinds;
}
function _segEngine(seg, plan) {
  return seg.engineChoice || plan.engineChoice;
}

// ============================================================================
// G4 #50-3: 幂等判据数据源——触发前现取 detail（GET /h3_batch/history/detail?task_id=）
// 取顶层 _postfx（引擎 E6：manifest 现值整表·有键才带）。上下文 (stem, ok, fetchedAt,
// postfxMap)：ok=false（取数失败）→ fail-closed 跳过本次触发（零请求零戳文件）；
// ok=true 有 _postfx → manifest 判据；ok=true 无键（旧引擎未部署）→ 降级旧文件名判据。
// ============================================================================

// detail 请求（submit-bar syncRunProducts 同款请求形态·全量可注入 io.historyDetail）
async function _historyDetail(taskId) {
  return request(`/h3_batch/history/detail?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
}

async function _fetchPostfxContext(io, taskId) {
  const ctx = { stem: taskId, ok: false, fetchedAt: Date.now(), postfxMap: null };
  try {
    const r = await io.historyDetail(taskId);
    if (r && r.ok && r.data && typeof r.data === "object") {
      ctx.ok = true;
      const m = r.data._postfx;   // 无键/非表 = 旧引擎 → postfxMap 保持 null（降级）
      if (m && typeof m === "object" && !Array.isArray(m)) ctx.postfxMap = m;
    }
  } catch (_e) { /* ok=false → fail-closed */ }
  return ctx;
}

// 段级幂等判定：新引擎（detail 带 _postfx）走 manifest 判据；旧引擎降级旧文件名判据。
function _segAlreadyPostfx(ctx, seg, plan) {
  if (ctx && ctx.ok && ctx.postfxMap) return segHasTargetStamps(ctx.postfxMap, seg.sid, plan);
  return _segHasTargetStampsByFile(seg.file, plan);
}

// 400 stamped_already 前缀匹配（归一层 error.code=错误串冒号前段·带说明后缀容错）
function _isStampedAlready(r) {
  const e = r && r.error;
  return !!e && /^stamped_already/.test(String(e.code || ""));
}

// 段级 postfxRun + 忙类退避重试（真路径二 2026-10-15：首请求落在引擎收尾窗内
// 约 1.5s → 连吃 409 active_busy/finalizing_busy——引擎 postfx 端点硬闸；
// postfx_status 通道只透出 postfx 自身 running 两态不透主链收尾态 → 以忙类
// 409 响应为收尾窗信号等待重试，不强造新通道）。忙=暂时态：同参重试，
// 指数退避 base·2^n 上限 maxMs，累计等待超预算 → 段失败（busyTimeout）。
// #64：每次重发前查停止令牌（忙等退避期停止 → 零重发，返回 cancelled）。
// 返回 { r, retries, cancelled? }——r=末次 postfxRun 原样返回，retries=忙类重试次数。
async function _runSegWithRetry(projectId, row, seg, plan, io, onBusyWait) {
  let attempt = 0;
  let waited = 0;
  for (;;) {
    if (_cancelReasonOf(projectId)) return { r: null, retries: attempt, cancelled: true };
    const r = await io.postfxRun({
      taskId: row.taskId,
      kinds: _segKinds(row, seg),
      sids: [seg.sid],
      engineChoice: _segEngine(seg, plan),
      upscaleParams: plan.upscaleParams,
      interpParams: plan.interpParams,
      judgment: "manifest",   // G4: 引擎 E7 X5 gating 能力字段（旧引擎忽略该键·行为零变化）
    });
    if (!r || !r.ok) {
      if (!_isBusyRunErr(r)) return { r, retries: attempt };
      const delay = Math.min(io.busyBackoffBaseMs * 2 ** attempt, io.busyBackoffMaxMs);
      if (waited + delay > io.busyRetryBudgetMs) return { r, retries: attempt, busyTimeout: true };
      waited += delay;
      attempt++;
      if (onBusyWait) onBusyWait();
      await io.sleep(delay);
      continue;
    }
    return { r, retries: attempt };
  }
}

// 轮询引擎 postfx_status 至 running=false。返回 {alive, cancelled?}——连续失败超限 =
// 引擎死（alive:false）；#64 停止令牌命中 = cancelled:true（不再等当前段跑完）。
async function _waitEngineIdle(io, projectId) {
  let errStreak = 0;
  for (;;) {
    if (_cancelReasonOf(projectId)) return { alive: true, cancelled: true };
    let st = null;
    try {
      st = await io.postfxStatus();
    } catch (_e) {
      st = { ok: false };
    }
    if (st && st.ok) {
      if (!st.running) return { alive: true };
      errStreak = 0;
    } else {
      errStreak++;
      if (errStreak > io.maxPollErrors) return { alive: false };
    }
    await _sleep(io.pollIntervalMs);
  }
}

// 逐段串行编排（段清单/成败镜像在 row.segs·每段一落盘）。
//   幂等短路段（skipped）不调引擎不计进度；段失败隔离记 failed 继续下一段；
//   引擎死 → 行落中断态（pending 段如实保留）并返回 {ok:false, interrupted:true}；
//   #64 停止令牌命中 → 同形 interrupted 收口·不再发下一段（在飞段不谎报 done）。
function _settleCancelled(projectId, row, reason, io, total) {
  const done = _rowDone(row);
  const failed = _rowFailed(row);
  _settlePostfxRow(projectId, row.postId, {
    running: false, currentSid: null, result: "failed", resultAck: true,
    interrupted: true, reason,
    segs: row.segs.map((s) => ({ ...s })), done, failed,
  }, io);
  const res = { ok: false, interrupted: true, reason, done, failed, total };
  if (io.onSettled) io.onSettled(res);
  return res;
}

async function _orchestrate(projectId, row, plan, io) {
  // 锁（_activeProjects）由入口（runPostfxPipeline/reconcilePostfx）持有——本函数不自管
  const total = row.segs.length;
  for (let i = 0; i < total; i++) {
    const stopReason = _cancelReasonOf(projectId);   // #64 检查点①：循环顶
    if (stopReason) return _settleCancelled(projectId, row, stopReason, io, total);
    const seg = row.segs[i];
    if (seg.state !== "pending") continue;
    const segKinds = _segKinds(row, seg);   // 段级 kinds（进度文案按该段实际在做的事）
    if (io.onProgress) io.onProgress({ current: i + 1, total, kinds: segKinds });
    _settlePostfxRow(projectId, row.postId, { currentSid: seg.sid }, io);
    const { r, retries, cancelled } = await _runSegWithRetry(projectId, row, seg, plan, io, () => {
      // 忙等期间进度提示「引擎忙·排队中」（postfxProgressText waiting 分支·shell 零改透传）
      if (io.onProgress) io.onProgress({ current: i + 1, total, kinds: segKinds, waiting: true });
    });
    // #64 检查点②：忙等退避期停止 → 该段零重发·按停止收口
    if (cancelled) return _settleCancelled(projectId, row, _cancelReasonOf(projectId) || "user_stopped", io, total);
    seg.retries = retries;   // 忙类重试计数落行（零重试=0）
    if (!r || !r.ok) {
      if (_isStampedAlready(r)) {
        // G4 #50-3: 引擎判"已后期"400 → 归一 skip 不计 failed（已后期段无需再跑；防
        // G3 误判"有段失败不拼"·防 settle 报错）。预检后 manifest 才补齐的取数竞态在此收口。
        seg.state = "skipped";
        _settlePostfxRow(projectId, row.postId, { segs: row.segs.map((s) => ({ ...s })), done: _rowDone(row), failed: _rowFailed(row) }, io);
        continue;
      }
      seg.state = "failed";
      _settlePostfxRow(projectId, row.postId, { segs: row.segs.map((s) => ({ ...s })), done: _rowDone(row), failed: _rowFailed(row) }, io);
      continue;
    }
    const wait = await _waitEngineIdle(io, projectId);
    // #64 检查点③：等引擎空闲期间停止 → 不再等当前段收尾·不发下一段（该段保持 pending）
    if (wait.cancelled) return _settleCancelled(projectId, row, _cancelReasonOf(projectId) || "user_stopped", io, total);
    if (!wait.alive) {
      _settlePostfxRow(projectId, row.postId, {
        running: false, currentSid: null, result: "failed", resultAck: true,
        interrupted: true, reason: "engine_unreachable",
        segs: row.segs.map((s) => ({ ...s })), done: _rowDone(row), failed: _rowFailed(row),
      }, io);
      const res = { ok: false, interrupted: true, reason: "engine_unreachable", done: _rowDone(row), failed: _rowFailed(row), total };
      if (io.onSettled) io.onSettled(res);
      return res;
    }
    seg.state = "done";
    _settlePostfxRow(projectId, row.postId, { segs: row.segs.map((s) => ({ ...s })), done: _rowDone(row), failed: _rowFailed(row) }, io);
  }
  // 收口前再查一次：末段完成瞬间的停止请求同样不得走到「完成 + 自动拼接」
  const stopReason = _cancelReasonOf(projectId);
  if (stopReason) return _settleCancelled(projectId, row, stopReason, io, total);
  const done = _rowDone(row);
  const failed = _rowFailed(row);
  _settlePostfxRow(projectId, row.postId, {
    running: false, currentSid: null, result: failed > 0 ? "failed" : "done", resultAck: true,
    done, failed,
  }, io);
  const res = { ok: true, result: failed > 0 ? "failed" : "done", done, failed, total };
  if (io.onSettled) io.onSettled(res);
  return res;
}

// 编排入口：装配段清单 → 落活跃行 → 逐段串行。
//   无现行段 → {ok:true, total:0, noop:true}（无可跑·不落行）。
//   opts.sids（批②F-114 重跑补·非空数组才生效）：白名单过滤——只装配/跑这些段
//   （行 segs/组产出全随过滤·runs 落账/显示缓存清/409 退避/onSettled 四件套全保留）。
export async function runPostfxPipeline(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const io = _normalizeIo(o.io);
  const projectId = o.projectId || "";
  const plan = o.plan && typeof o.plan === "object" ? o.plan : null;
  const taskId = typeof o.taskId === "string" ? o.taskId : "";
  if (!projectId || !plan || !Array.isArray(plan.kinds) || plan.kinds.length === 0 || !taskId) {
    return { ok: false, reason: "bad_args" };
  }
  const sidsFilter = Array.isArray(o.sids) && o.sids.length ? o.sids.map(String) : null;
  if (_activeProjects.has(projectId)) return { ok: false, reason: "already_running" };
  _activeProjects.add(projectId);
  try {
    return await _runPostfxPipelineLocked(projectId, taskId, plan, io, sidsFilter);
  } finally {
    _activeProjects.delete(projectId);
    _cancelRequests.delete(projectId);   // 停止令牌只作用于当次在跑链（收口即清·不是全局禁用）
    postfxDisplayCacheClear();   // T4: run 收口清显示源缓存（重跑产物落位后下次解析重验存在性）
  }
}

async function _runPostfxPipelineLocked(projectId, taskId, plan, io, sidsFilter) {
  const p = io.load(projectId);
  if (!p) return { ok: false, reason: "no_project" };
  const mainClips = (p.editingState && Array.isArray(p.editingState.mainClips)) ? p.editingState.mainClips : [];
  let found = collectPostfxSegments(mainClips);
  if (found.length === 0) return { ok: true, total: 0, noop: true };
  if (sidsFilter) {
    const keep = new Set(sidsFilter);
    found = found.filter((s) => keep.has(s.sid));
    if (found.length === 0) return { ok: true, total: 0, noop: true, reason: "sids_not_found" };
  }
  // G4: 触发前现取 detail（幂等判据权威数据源）——noop 零取（既有零请求行为保留）；
  // 取数失败 fail-closed：跳过本次触发·零引擎请求·零落行。
  const ctx = await _fetchPostfxContext(io, taskId);
  if (!ctx.ok) return { ok: false, reason: "detail_unavailable" };
  // 单行单计划（T4 #31 后全局六键同源）：segs 逐段落 kinds/engineChoice（预检/载荷/对账
  // 三消费同源·见 _segKinds 注）；shell 三消费方（reconcile 取首行/显示源读行参数/
  // autoConcat 取 taskId）零适配。
  const row = {
    kind: "postfx",
    at: _runStamp(),
    postId: `postfx:${taskId}:${Date.now()}`,
    taskId,
    label: "后期处理",
    running: true,
    total: found.length,
    done: 0,
    failed: 0,
    kinds: plan.kinds.slice(),
    // 参数随行落账——重进恢复续排必须按原参数发 postfxRun（否则恢复段落引擎缺省戳=错产物名）
    engineChoice: plan.engineChoice,
    upscaleParams: plan.upscaleParams,
    interpParams: plan.interpParams,
    segs: found.map((s) => ({
      sid: s.sid,
      file: s.file,
      kinds: plan.kinds.slice(),
      engineChoice: plan.engineChoice,
      state: _segAlreadyPostfx(ctx, s, plan) ? "skipped" : "pending",
    })),
  };
  // T3：后期自身快照（项目参数全貌 + 本次后期参数 + sourceRecordId 指主任务快照）；
  //   写失败 → 行标 snapshot:false·编排照常（saveRunSnapshot 内部 toast·不抛不重试）
  const _sourceRecordId = await findMainSnapshotId(projectId, taskId);
  const _extra = {
    at: row.at,
    stem: taskId,
    taskId,
    kind: "postfx",
    postfx: {
      kinds: plan.kinds.slice(),
      engineChoice: plan.engineChoice,
      ...(plan.upscaleParams ? { upscaleParams: plan.upscaleParams } : {}),
      ...(plan.interpParams ? { interpParams: plan.interpParams } : {}),
    },
  };
  if (_sourceRecordId) _extra.sourceRecordId = _sourceRecordId;
  const _snap = await saveRunSnapshot(projectId, Object.assign(buildRunSnapshotPayload(p), _extra));
  if (_snap.recordId) row.recordId = _snap.recordId;
  if (!_snap.ok) row.snapshot = false;
  _appendPostfxRow(projectId, row, io);
  return _orchestrate(projectId, row, plan, io);
}

// runs 兜底行任务号：最新一条非 postfx 行（主链/resume/重跑行字段=stem·unshift 置顶序取首）
function _latestNonPostfxTaskId(p) {
  const row = _runsOf(p).find((r) => r && r.kind !== "postfx" && typeof r.stem === "string" && r.stem);
  return row ? row.stem : "";
}

// shell onComplete 便捷入口：globalParams 六键装配（全局关→零编排）+ 任务号三路——
//   ① 直递 taskId（onComplete 载荷·R-57 直递链路保持有效）→ ② runs 最新非 postfx
//   行 stem 兜底 → ③ loadedTaskId；三路全空 → onNoTask 提示（shell 侧 toast·零静默不中断）。
//   T4 #31：全局单计划（段卡勾选退役·一切按全局六键）。
export async function startPostfxForProject(projectId, io, taskId) {
  const merged = _normalizeIo(io);
  if (!projectId) return { ok: false, reason: "bad_args" };
  const p = merged.load(projectId);
  if (!p) return { ok: false, reason: "no_project" };
  const plan = buildPostfxPlan(p.globalParams);   // 无现行段=无可跑由 runPostfxPipeline noop 收口
  if (!plan) return { ok: false, reason: "no_plan" };
  const direct = typeof taskId === "string" ? taskId : "";
  const tid = direct || _latestNonPostfxTaskId(p) || (p.editingState && p.editingState.loadedTaskId) || "";
  if (!tid) {
    if (merged.onNoTask) merged.onNoTask();
    return { ok: false, reason: "no_task" };
  }
  return runPostfxPipeline({ projectId, taskId: tid, plan, io: merged });
}

// ============================================================================
// 7. 重跑自动补（批②F-114 笔1 → T4 #31 口径反转 → T5 #31b 仅本次 override）——
//    四链（rerun/同种子/seg_edit/只重渲失败段）终态后的段级后期补跑入口（views/rerun_flow
//    onFinal 经 shell 桥调用·触发定序=先 await syncRunProducts 回轨再判补发）。判补语义=
//    buildPostfxPlan({ ...globalParams, ...gpOverride })：默认按全局六键；gpOverride（重跑
//    弹窗「后期处理（仅本次）」随链透传·六键子集）合并于其上——纯装配**不调
//    updateGlobalParams 不写回项目**（验收④）。全局关且无 override 开键 → null=noop 不补
//    （设计内静默——非 ok 返回才由调用侧可见提示）。
//    复用 runPostfxPipeline 扩 opts.sids：sids 白名单/幂等预检/runs 落账/显示缓存清/
//    409 退避/onSettled 四件套全保留。
// ============================================================================
export async function supplementPostfxAfterRerun(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const io = _normalizeIo(o.io);
  const projectId = typeof o.projectId === "string" ? o.projectId : "";
  const taskId = typeof o.taskId === "string" ? o.taskId : "";
  const want = (Array.isArray(o.sids) ? o.sids : []).map(String).filter(Boolean);
  if (!projectId || !taskId || !want.length) return { ok: false, reason: "bad_args" };
  const p = io.load(projectId);
  if (!p) return { ok: false, reason: "no_project" };
  const mainClips = (p.editingState && Array.isArray(p.editingState.mainClips)) ? p.editingState.mainClips : [];
  const found = collectPostfxSegments(mainClips);
  const keep = new Set(want);
  const targets = found.filter((s) => keep.has(s.sid));
  if (!targets.length) return { ok: true, total: 0, noop: true, reason: "sids_not_found" };
  const plan = buildPostfxPlan({ ...(p.globalParams || {}), ...(o.gpOverride || {}) });
  if (!plan) return { ok: true, total: 0, noop: true, reason: "not_covered" };
  return runPostfxPipeline({ projectId, taskId, plan, io, sids: targets.map((s) => s.sid) });
}

// 重进对账（刷新/切页重进·shell 项目视图挂载触发）：
//   查 runs 活跃行（kind:"postfx" 且 running:true）→ postfxStatus 对账三态：
//   ① 引擎 running → 重建轮询：等当前段完（标 done·已记录段零重调）→ 续排 pending 段；
//   ② 引擎空闲 → 按已记录段级成败收口（未决段=failed·行落中断态不静默消失）；
//   ③ status 不可达 → 行落中断态（engine_unreachable·pending 如实保留）。
//   无活跃行 / 活链已在跑（tab 重挂去重）→ {resumed:false}。
export async function reconcilePostfx(projectId, io) {
  const merged = _normalizeIo(io);
  if (!projectId) return { resumed: false };
  const p = merged.load(projectId);
  if (!p) return { resumed: false };
  const row = _runsOf(p).find((r) => r && r.kind === "postfx" && r.running === true);
  if (!row) return { resumed: false };
  // #64 墓碑优先：停止落账（user_stopped）→ 不续排·清运行态但保留已停止语义
  //   （重挂/刷新是缺陷 #64 的放大路径——读不到墓碑会接着超分）
  if (row.reason === "user_stopped") {
    _settlePostfxRow(projectId, row.postId, { running: false, currentSid: null }, merged);
    return { resumed: false, reason: "user_stopped" };
  }
  if (_activeProjects.has(projectId)) return { resumed: false };
  _activeProjects.add(projectId); // 对账全程持锁（status 请求前）——双挂载/与 startPostfxForProject 竞态不双跑
  try {
    return await _reconcilePostfxLocked(projectId, row, merged);
  } finally {
    _activeProjects.delete(projectId);
    _cancelRequests.delete(projectId);   // 停止令牌随对账链收口清除（同 run 收口口径）
    postfxDisplayCacheClear();   // T4: 对账收口清显示源缓存（同 run 收口口径）
  }
}

async function _reconcilePostfxLocked(projectId, row, merged) {
  // G4: 对账续排可能重发 pending 段=触发链——执行前现取 detail，取数失败 fail-closed：
  // 零请求零改行（行保持 running·下次重挂重试取数），不静默改判段级成败。
  const ctx = await _fetchPostfxContext(merged, row.taskId);
  if (!ctx.ok) return { resumed: false, reason: "detail_unavailable" };
  const segs = (Array.isArray(row.segs) ? row.segs : []).map((s) => ({ ...s }));
  const plan = {
    kinds: Array.isArray(row.kinds) ? row.kinds.slice() : [],
    engineChoice: row.engineChoice || "seedvr2",
    upscaleParams: row.upscaleParams || undefined,
    interpParams: row.interpParams || undefined,
  };
  let st = null;
  try {
    st = await merged.postfxStatus();
  } catch (_e) {
    st = { ok: false };
  }
  if (st && st.ok && st.running) {
    // ① 重建轮询续排：等 in-flight 完 → currentSid 段（若仍 pending）标 done → 复用编排主链续排
    const wait = await _waitEngineIdle(merged, projectId);
    if (wait.cancelled) {
      // #64：对账等待期收到停止 → 同编排口径收口（在飞段保持 pending·不谎报 done）
      return { resumed: true, settled: "interrupted", ..._settleCancelled(projectId, { postId: row.postId, segs }, _cancelReasonOf(projectId) || "user_stopped", merged, segs.length) };
    }
    if (!wait.alive) {
      _settlePostfxRow(projectId, row.postId, {
        running: false, currentSid: null, result: "failed", resultAck: true,
        interrupted: true, reason: "engine_unreachable", segs, done: _rowDone({ segs }), failed: _rowFailed({ segs }),
      }, merged);
      return { resumed: true, settled: "interrupted" };
    }
    const cur = row.currentSid ? segs.find((s) => s.sid === row.currentSid && s.state === "pending") : null;
    if (cur) {
      cur.state = "done";
      _settlePostfxRow(projectId, row.postId, { segs: segs.map((s) => ({ ...s })), done: _rowDone({ segs }), failed: _rowFailed({ segs }) }, merged);
    }
    const mirror = { postId: row.postId, taskId: row.taskId, kinds: plan.kinds, segs };
    const res = await _orchestrate(projectId, mirror, plan, merged);
    return { resumed: true, settled: "resumed", ok: res.ok, done: res.done, failed: res.failed, total: res.total };
  }
  if (st && st.ok && !st.running) {
    // ② 空闲收口：按已记录段级成败收口——未决段（含 in-flight 未落账）= failed；全记录则按记录收口
    let unresolved = 0;
    for (const seg of segs) {
      if (seg.state === "pending") {
        seg.state = "failed";
        unresolved++;
      }
    }
    const done = _rowDone({ segs });
    const failed = _rowFailed({ segs });
    _settlePostfxRow(projectId, row.postId, {
      running: false, currentSid: null, result: failed > 0 ? "failed" : "done", resultAck: true,
      ...(unresolved > 0 ? { interrupted: true, reason: "reconcile_idle" } : {}),
      segs: segs.map((s) => ({ ...s })), done, failed,
    }, merged);
    const res = { ok: failed === 0, interrupted: unresolved > 0, reason: unresolved > 0 ? "reconcile_idle" : undefined, done, failed, total: segs.length };
    if (merged.onSettled) merged.onSettled(res);
    return { resumed: true, settled: "idle" };
  }
  // ③ status 不可达：行落中断态（pending 如实保留——引擎可能仍在慢跑·不判段级成败）
  _settlePostfxRow(projectId, row.postId, {
    running: false, currentSid: null, result: "failed", resultAck: true,
    interrupted: true, reason: "engine_unreachable",
    segs: segs.map((s) => ({ ...s })), done: _rowDone({ segs }), failed: _rowFailed({ segs }),
  }, merged);
  const res = { ok: false, interrupted: true, reason: "engine_unreachable", done: _rowDone({ segs }), failed: _rowFailed({ segs }), total: segs.length };
  if (merged.onSettled) merged.onSettled(res);
  return { resumed: true, settled: "unreachable" };
}

// ============================================================================
// 6. 显示源解析胶合层（R56R57-S3 适配 T4——播放/导出/缩略图经此取最终版）
// ============================================================================
//
// 设计（主代理裁决·不可改）: 读层派生，绝不改写 mainClips.file/altClips（防与 rebuild
//   合并/pinned/重跑链打架）。最终版 = 显示源；数据层原始产物指针不动；中间产物
//   （upscaled/interp 子目录文件）只作显示/导出源，永不写回片段集。
//
// 解析链（每 clip）:
//   ① 读项目 runs 最新一条 kind:"postfx" 行（unshift 置顶序）的随行参数
//      （T3 落账 upscaleParams/interpParams）；无行 → 原产物直通（零解析开销）。
//   ② 有参精确模式: verifyPostfxFinal(原产物, 随行参数)（T2 解析器·存在性验证）；
//   ③ miss 回落无参清单模式: verifyPostfxFinal(原产物, null)（T2 concerns② 裁定）；
//   ④ 再 miss / IO 故障 → 原产物 {level:"none"}。
// 缓存: Map·键 = 原 file + 参数摘要·会话级——run 收口清（runPostfxPipeline/reconcilePostfx
//   finally 钩·重跑产物落位/更名后下次解析重验存在性 = Q15 失效感知）。
// 纯函数核心（参数→期望→比对）在 postfx.js §5 resolvePostfxFinal；本层只做 runs 读行、
//   回落编排与缓存——IO（load/verify）全量可注入，单测假件直拍。消费方: views/edit.js。

const _displayCache = new Map();

export function _test_resetPostfxDisplayCache() {
  _displayCache.clear();
}

// run 落行/收口时清缓存（T4 失效钩——重跑产物更名/新增后下次解析重验存在性）
export function postfxDisplayCacheClear() {
  _displayCache.clear();
}

// 行随行参数 → 解析器参数形态（缺段不落键——resolvePostfxFinal 以键存在判定该 kind 被请求）
function _rowParams(row) {
  const p = {};
  if (row.upscaleParams != null) p.upscaleParams = row.upscaleParams;
  if (row.interpParams != null) p.interpParams = row.interpParams;
  return p;
}

// 最新一条 kind:"postfx" 行的随行参数；无行 → null（调用方零解析直通原产物）
function _latestPostfxParams(project) {
  const runs = project && Array.isArray(project.runs) ? project.runs : [];
  const row = runs.find((r) => r && r.kind === "postfx");
  return row ? _rowParams(row) : null;
}

function _normalizeDisplayIo(io) {
  const o = io && typeof io === "object" ? io : {};
  return {
    load: o.load || storeLoad,
    verify: typeof o.verify === "function" ? o.verify : verifyPostfxFinal,
  };
}

// clip 显示源解析: (projectId|project, clip, io?) → Promise<{file, level:"interp"|"upscale"|"none"}>
export async function postfxDisplaySource(projectRef, clip, io) {
  const d = _normalizeDisplayIo(io);
  const orig = clip && typeof clip.file === "string" ? clip.file : "";
  if (!orig) return { file: orig, level: "none" };
  const project = typeof projectRef === "string" ? d.load(projectRef) : projectRef;
  const params = _latestPostfxParams(project);
  if (params === null) return { file: orig, level: "none" };   // 无 postfx 行·零解析开销
  const key = orig + "|" + JSON.stringify(params);
  if (_displayCache.has(key)) return _displayCache.get(key);
  let res = { file: orig, level: "none" };
  try {
    res = await d.verify(orig, params);
    if (params.upscaleParams != null || params.interpParams != null) {
      if (!res || !res.file || res.level === "none") {
        res = await d.verify(orig, null);   // miss 回落无参清单模式（T2 concerns② 裁定）
      }
    }
    if (!res || !res.file) res = { file: orig, level: "none" };
  } catch (_e) {
    res = { file: orig, level: "none" };   // IO 故障容错回原产物
  }
  _displayCache.set(key, res);
  return res;
}
