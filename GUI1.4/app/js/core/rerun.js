// core/rerun.js — 重跑族 (rerunSelected / sameSeed / editPrompt) + 段卡勾选纯函数.
//
// === 出处注记 (S1-3 T6) ===
// 改造自 legacy/app/js/domain/rerun.js（L1-240）+ 引擎端点契约 api.md #5/#6/#7;
// 改造点 = import 路径 ../core/api.js → ./api.js; 五件
// (rerunSelected/sameSeed/editPrompt/defaultSelection/voidSidsForTask) 原样.
//
// 任务边界 (api.md #5/#6/#7):
//   1. rerunSelected       — 选中段重跑 (POST /h3_batch/rerun)
//   2. sameSeed            — 同 seed 重跑, 可改 ratio/质量/步数
//                            (POST /h3_batch/rerun_same_seed, confirm_required=true 业务层透传)
//   3. editPrompt          — 改 prompt 重跑 (POST /h3_batch/rerun_edit_prompt)
//   4. defaultSelection    — 段卡勾选默认集合 (failed/stopped + success+void)
//   5. voidSidsForTask     — 段集合 → 仅 status=success && review=void 的 sid 列表
//                            (1.14c 引擎已放开 void 段重跑·本函数保留为纯函数辅助)
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层).
//   - 不反向 import views/components.

import { request } from "./api.js";

// ============================================================================
// 1. 选中段重跑 (api.md #5)
// ============================================================================
//
// sids 双格式兼容 (后端接受 list 或 string 逗号串):
//   - 调用方传 list → 业务层保持 list 形态 (后端 JSON 解析兼容)
//   - 调用方传 string → 业务层原样传
//   - 调用方传 0 长度 → 业务层 ok=false (前端层已在视图层校验, 此处兜底)
//
// keep_seed:
//   - 默认 false (换新 seed)
//   - 显式传 true → 注入恒定微扰
//   - 业务层: true 透传, false 显式 (后端默认 false 不写也可, 但明示便于 e2e 断言)

export async function rerunSelected(opts) {
  const taskId = opts.taskId || "";
  const sids = opts.sids;
  const keepSeed = !!opts.keepSeed;
  // voidSids = 哑参: 1.14c 引擎已放开·前端不拦（防误用回填）
  const voidSids = Array.isArray(opts.voidSids) ? opts.voidSids : [];
  const outputDir = opts.outputDir || "";

  const body = { task_id: taskId, sids, keep_seed: keepSeed };
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/rerun", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  return {
    ok: true,
    started: !!(r.data && r.data.started),
    taskId: (r.data && r.data.task_id) || taskId,
    sids: (r.data && r.data.sids) || [],
    raw: r.data,
  };
}

// ============================================================================
// 2. 同 seed 重跑 (api.md #6)
// ============================================================================
//
// body 字段:
//   task_id (必填)
//   source (必填, "task" 或 "rerun")
//   rerun_seq (int, source=rerun 时必填 ≥1)
//   比例/质量/步数 (str/float/str, 可选, 不填=沿原批 → 业务层省略字段)
//   force (bool, 可选, 默认 false, 二次确认后置 true)
//
// 响应:
//   {ok:true, confirm_required:true} → 业务层 confirmRequired=true (前端义务弹二次确认)
//   {ok:true, started:true, ...}    → 业务层 confirmRequired=false, 启动成功
//
// 局部记忆 (localStorage h3_same_seed_params): 由视图层管; 业务层仅负责参数序列化.

export async function sameSeed(opts) {
  const taskId = opts.taskId || "";
  const source = opts.source || "task";
  const rerunSeq = opts.rerunSeq;
  const ratio = opts.ratio || "";
  const quality = opts.quality || "";
  const steps = opts.steps || "";
  const force = !!opts.force;
  const outputDir = opts.outputDir || "";

  const body = { task_id: taskId, source };
  if (source === "rerun" && rerunSeq != null) body.rerun_seq = Number(rerunSeq);
  if (ratio) body["比例"] = ratio;
  if (quality) body["质量"] = quality;
  if (steps) body["步数"] = steps;
  if (force) body.force = true;
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/rerun_same_seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, confirmRequired: false, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    confirmRequired: !!data.confirm_required,
    started: !!data.started,
    taskId: data.task_id || taskId,
    sids: data.sids || [],
    raw: data,
  };
}

// ============================================================================
// 3. 改 prompt 重跑 (api.md #7)
// ============================================================================
//
// body 字段:
//   task_id (必填)
//   sid (单段, 非列表)
//   prompt_text (必填, 非空 — 业务层传空 → 业务层 ok=false)
//   keep_seed (bool, 可选, 默认 false)
//   output_dir / input_dir (可选)
//
// 响应:
//   {ok:true, ...} (后端不返 started 字段; seed 由 manifest 取)

export async function editPrompt(opts) {
  const taskId = opts.taskId || "";
  const sid = opts.sid || "";
  const promptText = opts.promptText || "";
  const keepSeed = !!opts.keepSeed;
  const outputDir = opts.outputDir || "";

  // 业务层前端义务: prompt_text 空 → 直接拦截 (后端也会 400, 但前端先兜底省一次往返)
  if (!promptText.trim()) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: "prompt_text 不能为空",
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const body = { task_id: taskId, sid, prompt_text: promptText, keep_seed: keepSeed };
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/rerun_edit_prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  return { ok: true, raw: r.data };
}

// ============================================================================
// 4. defaultSelection — 段卡勾选默认集合
// ============================================================================
//
// 规则 (与旧 main.js h3DefaultRerunSelection 同款纯函数):
//   - status === 'failed' || status === 'stopped' → 勾选
//   - status === 'success' && review === 'void'  → 勾选
//   - 其它                                        → 不勾选
//
// 入参: shots [{sid, status, review}, ...] (任意键缺省视为空串)
// 出参: [sid, ...] (去重 + 保持输入顺序; 缺 sid 或非对象项跳过)
//
// 纯函数, 无副作用; 视图层用此函数初始化勾选集合, 用户后续勾选/取消由
// 视图层自己维护, 本函数只负责"打开详情时预选哪些"。

export function defaultSelection(shots) {
  const out = [];
  if (!Array.isArray(shots)) return out;
  const seen = new Set();
  for (const s of shots) {
    if (!s || typeof s !== "object") continue;
    const sid = s.sid || s.id || "";
    const status = s.status || "";
    const review = s.review || "";
    if (!sid || seen.has(sid)) continue;
    const isFailed = (status === "failed" || status === "stopped");
    const isVoid = (status === "success" && review === "void");
    if (isFailed || isVoid) {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}

// ============================================================================
// 5. voidSidsForTask — 仅返 status=success && review=void 的 sid (纯函数辅助·现无生产调用方)
// ============================================================================
//
// 入参: shots [{sid, status, review}, ...] (任意键缺省视为空串)
// 出参: [sid, ...] (去重 + 保持输入顺序)
//
// 与 defaultSelection 的差异: defaultSelection 含 failed/stopped, 本函数
// 仅含已作废的 success 段 — rerunSelected 的 voidSids 哑参数据源 (1.14c 已不拦截).

export function voidSidsForTask(shots) {
  const out = [];
  if (!Array.isArray(shots)) return out;
  const seen = new Set();
  for (const s of shots) {
    if (!s || typeof s !== "object") continue;
    const sid = s.sid || s.id || "";
    const status = s.status || "";
    const review = s.review || "";
    if (!sid || seen.has(sid)) continue;
    if (status === "success" && review === "void") {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}
