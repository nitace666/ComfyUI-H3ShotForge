// core/archive.js — 渲染产物归档 (POST /h3_batch/archive).
//
// === 出处注记 (G6·#51 报障批次修复·批1) ===
// 引擎端点契约 E1-E4（引擎仓已交付）：POST /h3_batch/archive
//   body {task_id, output_dir?, all_existing?}
//   成功 200 {ok, dest}；幂等（已归档再调）= 同形 {ok:true, dest}（调用方零特判）
//   五通道前置检查任一命中 → 409 archive_busy（忙=暂时态 → 退避重试）
//   其它 4xx/5xx = 非暂时态 → 零重试透传
//
// 忙类退避重试内置（对齐 postfx_pipeline._runSegWithRetry / shell autoConcatAfterSettle
// 同口径：base 2s·单次上限 60s·总预算 900s=#50-4 放宽值·预算检查先于等待）；
// 预算耗尽返回 {ok:false, busyTimeout:true}（可识别返回态·调用方 toast 分态）。
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层).
//   - ./timeouts.js : TIMEOUTS (全仓 HTTP 超时集中表·不得就地内联).
//   - 不反向 import views/components.

import { request } from "./api.js";
import { TIMEOUTS } from "./timeouts.js";

// 归档忙判据：409 archive_busy（api.js 归一层 code=错误串冒号前段·classifyBusy 四态
// 不含 archive_busy → busyKind 为 null → 按 code 前缀识别）+ 四忙类 busyKind 同族兼容
// （引擎收尾窗内归档也可能吃到 active/finalizing busy·同为暂时态）。
export function isArchiveBusyErr(r) {
  const e = r && r.error;
  if (!e) return false;
  if (e.busyKind) return true;
  return /^archive_busy/.test(String(e.code || ""));
}

/**
 * 归档任务产物（409 忙类退避重试内置）。
 *
 * @param {Object} opts
 * @param {string} opts.taskId   — 任务 ID（必填，缺 → 业务层前置拦截）
 * @param {string} [opts.outputDir] — 输出目录（可选，缺省不带键=引擎按 manifest 自寻）
 * @param {number} [opts.busyBackoffBaseMs] — 忙类退避基值 ms（缺省 2000）
 * @param {number} [opts.busyBackoffMaxMs]  — 忙类退避单次上限 ms（缺省 60000）
 * @param {number} [opts.busyRetryBudgetMs] — 忙类重试总预算 ms（缺省 900000·与 G5 同口径）
 * @param {Function} [opts.sleep] — 等待注入（单测假钟；缺省真 setTimeout）
 * @returns {Promise<Object>} {ok:true, dest, raw} | {ok:false, busyTimeout:true, error, raw}
 *                            | {ok:false, error, raw} | {ok:false, error(=validation)}
 */
export async function archiveTask(opts) {
  const o = opts || {};
  const taskId = typeof o.taskId === "string" ? o.taskId.trim() : "";
  // 业务层前端义务: 缺 task_id → 直接拦截（后端也会 400, 前端先兜底省一次往返）
  if (!taskId) {
    return {
      ok: false,
      error: { code: "validation", msg: "task_id 必填", detail: null, httpStatus: 0 },
    };
  }
  const body = { task_id: taskId };
  if (o.outputDir) body.output_dir = o.outputDir;

  const baseMs = typeof o.busyBackoffBaseMs === "number" && o.busyBackoffBaseMs > 0 ? o.busyBackoffBaseMs : 2000;
  const maxMs = typeof o.busyBackoffMaxMs === "number" && o.busyBackoffMaxMs > 0 ? o.busyBackoffMaxMs : 60000;
  const budgetMs = typeof o.busyRetryBudgetMs === "number" && o.busyRetryBudgetMs > 0 ? o.busyRetryBudgetMs : 900000;
  const sleep = typeof o.sleep === "function" ? o.sleep : ((ms) => new Promise((done) => setTimeout(done, ms)));

  let attempt = 0;
  let waited = 0;
  for (;;) {
    const r = await request("/h3_batch/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUTS.default,
    });
    if (r.ok) {
      const data = r.data || {};
      return { ok: true, dest: typeof data.dest === "string" ? data.dest : "", raw: data };
    }
    if (!isArchiveBusyErr(r)) return { ok: false, error: r.error, raw: r.data };   // 非忙类=非暂时态不重试
    const delay = Math.min(baseMs * 2 ** attempt, maxMs);
    if (waited + delay > budgetMs) return { ok: false, busyTimeout: true, error: r.error, raw: r.data };
    waited += delay;
    attempt++;
    await sleep(delay);
  }
}
