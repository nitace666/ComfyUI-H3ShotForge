// core/review.js — 审片门裁决三端点 (approve / voidSeg / resume).
//
// === 出处注记 (S1-3 T6) ===
// 改造自 legacy/app/js/domain/review.js（L1-186）+ 引擎端点契约 api.md #2/#3/#4;
// 改造点 = import 路径 ../core/api.js → ./api.js; 三 API (approve/voidSeg/resume)
// 与 REVIEW_GATE_KINDS 枚举原样.
//
// 任务边界 (api.md #2/#3/#4):
//   1. approve      — 通过指定段 (POST /h3_batch/review/approve, body: {stem, sid})
//   2. voidSeg      — 作废指定段, solo=true 仅本段 / solo=false 级联后续 success
//                     (POST /h3_batch/review/void, body: {stem, sid, solo})
//   3. resume       — 放行继续批 (POST /h3_batch/review/resume, body: {stem} — 无 sid)
//   4. REVIEW_GATE_KINDS — 审片暂停类型枚举 ("人审" 现有; "建档确认" 留位)
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层, 旧/新/裸信封已归一).
//   - 不反向 import views/components.

import { request } from "./api.js";

// ============================================================================
// 0. 审片暂停类型枚举
// ============================================================================
//
// 当前引擎仅触发"人审"一种; 后续版本计划引入"建档确认"等类型. 本枚举只为
// 视图层/调用方提供 if-switch 锚点 — 引擎落地前不实现具体交互逻辑.

export const REVIEW_GATE_KINDS = Object.freeze({
  HUMAN_REVIEW: "人审",          // 现有: 引擎段级产出待人工裁决
  ARCHIVE_CONFIRM: "建档确认",   // 预留: 引擎触发后需用户确认归档路径/参数
});

// ============================================================================
// 1. approve — 段通过 (api.md #2)
// ============================================================================
//
// body 字段:
//   stem (必填)
//   sid (必填 — 业务层前置校验; 缺 → ok=false)
//   output_dir (可选, 非空时透传)
//
// 响应:
//   {ok:true, sid, review:"approved"}                            — 段通过
//   {ok:false, msg:"段不存在或非 success 状态"} (400 旧信封)      — 段非 success
//
// 旧信封兼容: 400 + {ok:false, msg:str} → request 归一层后 error.code="unknown"
//   error.msg 透传 (与 rerun.js editPrompt 缺 prompt_text 同模式).

export async function approve(opts) {
  const stem = opts.stem || "";
  const sid = opts.sid || "";
  const outputDir = opts.outputDir || "";

  // 业务层前端义务: 缺 sid → 直接拦截 (后端也会 400, 前端先兜底省一次往返)
  if (!sid) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: "sid 必填",
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const body = { stem, sid };
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/review/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    sid: data.sid || sid,
    review: data.review || "approved",
    raw: data,
  };
}

// ============================================================================
// 2. voidSeg — 段作废 (api.md #3)
// ============================================================================
//
// body 字段:
//   stem (必填)
//   sid (必填 — 业务层前置校验)
//   solo (bool, 必填显式 — solo=true 仅本段; solo=false 级联后续 success)
//   output_dir (可选, 非空时透传)
//
// 响应:
//   {ok:true, sid, solo:true}                                    — solo 成功
//   {ok:true, voided:[...], cascade_count:N}                     — 级联成功
//   {ok:false, msg:"段已 void (solo 幂等)"} (400)                 — solo 幂等
//   {ok:false, msg:"段已 void 且无后续 success 级联"} (400)        — 级联空

export async function voidSeg(opts) {
  const stem = opts.stem || "";
  const sid = opts.sid || "";
  const solo = !!opts.solo;
  const outputDir = opts.outputDir || "";

  if (!sid) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: "sid 必填",
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const body = { stem, sid, solo };
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/review/void", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  // solo=true → {sid, solo}; solo=false → {voided, cascade_count}
  // 业务层两边都返; 视图层按 solo 决定渲染策略.
  return {
    ok: true,
    sid: data.sid || sid,
    solo: data.solo === true,
    voided: Array.isArray(data.voided) ? data.voided : [],
    cascadeCount: typeof data.cascade_count === "number" ? data.cascade_count : 0,
    raw: data,
  };
}

// ============================================================================
// 3. resume — 放行继续批 (api.md #4)
// ============================================================================
//
// body 字段:
//   stem (必填 — 业务层前置校验; 缺 → ok=false)
//   output_dir (可选, 非空时透传)
//   **无 sid** — 放行整批, 不针对单段.
//
// 响应:
//   {ok:true, resumed:true}                                     — 放行成功
//   {ok:false, msg:"引擎未处于审片门暂停 (phase=...)"} (400)      — 未暂停
//   {ok:false, msg:"引擎未运行, 请重新提交批次任务(同 CSV)以续跑"} (400) — 未运行

export async function resume(opts) {
  const stem = opts.stem || "";
  const outputDir = opts.outputDir || "";

  if (!stem) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: "stem 必填",
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const body = { stem };
  if (outputDir) body.output_dir = outputDir;
  // 关键: 不注入 sid 字段 (端点无 sid; 注入会触发后端 400)

  const r = await request("/h3_batch/review/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    resumed: data.resumed === true,
    raw: data,
  };
}
