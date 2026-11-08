// core/seg_edit.js — B4-T3 D3 段级精修提交层（引擎 #57 seg_edit·rerun=false 纯写侧车通道）
//
// === 契约（api.md #57）===
//   POST /h3_batch/seg_edit body {task_id, sid, overrides(对象·至少一键), rerun}
//   overrides 可选键（未出现的键 = 不覆盖侧车既有值）:
//     段落时长  number 秒 —— 引擎帧网格吸附（17n+5）后须落 [124, 362] 帧 ≈ 5.0-15.0s·越界 400
//     pool      {族:{槽号:素材绝对路径}} —— 引擎 _resolve_file 存在性校验·缺 400 白话
//     lora      {名:{strength}} —— 模板 lora_overrides 语义
//     prompt_text 非空字符串
//   侧车 run_dir/_seg_overrides.json 恒优先 CSV；400/409 统一透传引擎中文 msg。
//
// === v2.1 终订 1（锁死）===
//   rerun 恒 false：引擎 rerun=true 是同步等待模型（挂起 HTTP 至渲染完·分钟级），
//   core/api.js 默认 30s 超时必 TimeoutError——GUI 重跑一律走显式 POST /h3_batch/rerun
//   （后台 started）+ views/rerun_flow.js runRerunFlow 轮询，不经本端点触发。
//
// ESM 依赖链（单向）: ./api.js request（归一层）。不反向 import views。

import { request } from "./api.js";

function validationError(msg) {
  return { ok: false, error: { code: "validation", msg, detail: null, httpStatus: 0 }, raw: null };
}

// 形状校验：pool {族:{槽:路径}} / lora {名:{strength}}（引擎端点 400 同口径前置·省一次往返）
function _poolShapeOk(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  return Object.values(p).every((slots) => slots && typeof slots === "object" && !Array.isArray(slots));
}
function _loraShapeOk(l) {
  if (!l || typeof l !== "object" || Array.isArray(l)) return false;
  return Object.values(l).every((v) => v && typeof v === "object" && !Array.isArray(v));
}

export async function submitSegEdit(opts = {}) {
  const taskId = opts.taskId || "";
  const sid = opts.sid || "";
  const overrides = opts.overrides;

  // 前端义务：至少一键 + 形状校验（后端同口径 400，先兜底省一次往返）
  if (!taskId || !sid) return validationError("seg_edit 缺 task_id/sid");
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return validationError("overrides 必须是对象（至少一键）");
  }
  if (Object.keys(overrides).length === 0) {
    return validationError("至少填一项精修参数（时长/参考图/LoRA/提示词）");
  }
  if ("段落时长" in overrides && (typeof overrides["段落时长"] !== "number" || !isFinite(overrides["段落时长"]))) {
    return validationError("段落时长必须是数字（约 5-15 秒）");
  }
  if (overrides.pool != null && !_poolShapeOk(overrides.pool)) {
    return validationError("pool 必须是 {族: {槽号: 路径}} 形状");
  }
  if (overrides.lora != null && !_loraShapeOk(overrides.lora)) {
    return validationError("lora 必须是 {名: {strength}} 形状");
  }

  const body = { task_id: taskId, sid, overrides, rerun: false }; // rerun 恒 false（见文件头终订注记）
  const r = await request("/h3_batch/seg_edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  return { ok: true, raw: r.data };
}
