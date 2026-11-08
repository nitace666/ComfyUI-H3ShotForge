// core/concat.js — 手动拼接 (dry_run 预览 / execute 执行).
//
// === 出处注记 (S1-3 T6) ===
// 改造自 legacy/app/js/domain/concat.js（L1-75）+ 引擎端点契约 api.md #8;
// 改造点 = ①import 路径 ../core/api.js → ./api.js
//        ②task_id 缺参前置拦截 (legacy 无校验, T6 测试口径 ① 补)
//        ③dry_run 响应 missing 非空 → 业务层拦截 {ok:false, code:"missing_shots", missing, raw}
//          (T6 任务单契约 "缺件警告语义"; legacy 旧口径为 ok:true 透传 missing 仅由视图层告警,
//           本仓改为业务层拦截 — 缺件时不得进入真拼接流程)
//        ④execute 归一新增 taskFolder (契约响应 task_folder 字段透出).
//
// 任务边界 (api.md #8):
//   concat — POST /h3_batch/concat
//     - dry_run=true → 200 + {ok:true, dry_run:true, map, base_desc, fell_back,
//                              fallback_sids, missing}
//       → missing 非空 → 业务层 {ok:false, code:"missing_shots", missing, raw} (缺件警告语义)
//       → missing 空   → 业务层归一: {ok, dryRun, map, baseDesc, fellBack, fallbackSids, missing, raw}
//     - dry_run=false → 200 + {ok:true, started:true, ..., output:"绝对路径...", task_folder}
//       → 业务层归一: {ok, started, output, taskFolder, taskId, mode, rerunSeq,
//                      map, baseDesc, fellBack, fallbackSids, raw}
//     - 400 missing_segments → ok=false, error.code=missing_segments
//     - 409 concat_busy      → ok=false, error.code=concat_busy + busyKind="concat"
//     - 404 / 400 其它       → ok=false, error 透传
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层).
//   - ./timeouts.js : TIMEOUTS (全仓 HTTP 超时集中表·批2 #57 档2).
//   - 不反向 import views/components.

import { request } from "./api.js";
import { TIMEOUTS } from "./timeouts.js";

/**
 * 手动拼接 (dry_run 预览 / execute 执行).
 *
 * @param {Object} opts
 * @param {string} opts.taskId     — 任务 ID (必填, 缺 → 业务层前置拦截)
 * @param {"global"|"inherit"} opts.mode — 拼接模式 (必填)
 * @param {boolean} [opts.dryRun=false] — true=预览, false=执行
 * @param {number} [opts.rerunSeq]     — mode=inherit 时建议传 (≥1)
 * @param {string} [opts.outputDir]    — 输出目录 (可选)
 * @returns {Promise<Object>} 规范化结果 — 详见上方任务边界
 */
export async function concat(opts) {
  const taskId = opts.taskId || "";
  const mode = opts.mode || "";
  const dryRun = !!opts.dryRun;
  const rerunSeq = opts.rerunSeq;
  const outputDir = opts.outputDir || "";

  // 业务层前端义务: 缺 task_id → 直接拦截 (后端也会 400, 前端先兜底省一次往返)
  if (!taskId) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: "task_id 必填",
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const body = { task_id: taskId, mode, dry_run: dryRun };
  if (mode === "inherit" && rerunSeq != null) body.rerun_seq = Number(rerunSeq);
  if (outputDir) body.output_dir = outputDir;

  // 批2 #57 档2: 受理拍显式引集中超时表 (原无 timeoutMs·吃 30s 默认·改引不改值)
  const r = await request("/h3_batch/concat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUTS.default,
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };

  const data = r.data || {};
  if (data.dry_run === true) {
    const missing = Array.isArray(data.missing) ? data.missing : [];
    // T6 缺件警告语义: dry_run 发现缺件 → 业务层拦截, 视图层不得进入真拼接流程
    if (missing.length) {
      return { ok: false, code: "missing_shots", missing, raw: data };
    }
    return {
      ok: true,
      dryRun: true,
      map: data.map || {},
      baseDesc: data.base_desc || "",
      fellBack: !!data.fell_back,
      fallbackSids: Array.isArray(data.fallback_sids) ? data.fallback_sids : [],
      missing,
      raw: data,
    };
  }
  return {
    ok: true,
    started: !!data.started,
    taskId: data.task_id || taskId,
    mode: data.mode || mode,
    rerunSeq: data.rerun_seq != null ? data.rerun_seq : null,
    map: data.map || {},
    baseDesc: data.base_desc || "",
    fellBack: !!data.fell_back,
    fallbackSids: Array.isArray(data.fallback_sids) ? data.fallback_sids : [],
    output: data.output || "",          // 产物路径严格用响应 output 字段
    taskFolder: data.task_folder || "", // T6 契约: task_folder 透出
    raw: data,
  };
}
