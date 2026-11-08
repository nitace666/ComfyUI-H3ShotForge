// core/cast_block.js — 出场角色预览块 API（批 8 T4 自 legacy GUI1.0 domain/cast_block.js 迁移）
//
// 端点契约（legacy cast_block.js 实况 · api.md 文档缺陷 #3 已登记，按源码为准）：
//   castBlock — POST /h3_batch/cast_block
//     body: { name(≤64), no:int, slots?:[{idx,usage,media,desc,...}], lang?:"zh"|"en" }
//     200: { blocks:list[str], fingerprint:bool }
//       - fingerprint=true 表示卡不存在/非v3/非character/slots不匹配
//     400: 旧裸 { error: "..." }
//
// 1.3 适配（与 legacy 差异 · 任务 T4 口径）：
//   - name 超 64 字符 → 截断后发送（legacy 本地拦截报错 → 1.3 截断；卡名来源是
//     绑定表条目名，脏数据不阻断预览，交引擎 fingerprint 判定）
//   - 端点调用形态对齐仓内惯例：core/api.js request + JSON.stringify body
//     （与 core/assets_api.js saveCard 同款）；旧/裸信封由 request 归一
//
// ESM 依赖链（单向）：core/api.js request（归一层）→ 本模块 → views/assigner-panel.js。

import { request } from "./api.js";

// 名称上限（与引擎契约对齐 · legacy NAME_MAX_LEN）
const NAME_MAX_LEN = 64;

/**
 * 出场角色预览块生成（POST /h3_batch/cast_block）。
 *
 * @param {object} opts
 * @param {string} opts.name    — 档案卡名（截断 ≤64 后发送）
 * @param {number} opts.no      — 出场编号（int）
 * @param {Array}  [opts.slots] — 绑定槽 [{idx,kind,usage,media,desc,...}]（空/缺省省略字段）
 * @param {"zh"|"en"} [opts.lang] — 模板语言（非 zh/en 省略 → 后端默认 zh）
 * @returns {Promise<{ok:boolean, blocks?:string[], fingerprint?:boolean, error?:object, raw?:object}>}
 *   成功: {ok:true, blocks:[...], fingerprint:bool}
 *   失败: {ok:false, error:{code,msg,detail,httpStatus}}（调用失败不抛 — 面板渲染错误态）
 */
export async function castBlock(opts = {}) {
  const name = String(opts.name == null ? "" : opts.name).slice(0, NAME_MAX_LEN);
  const no = opts.no;
  const slots = opts.slots;
  const lang = opts.lang;

  const body = { name, no };
  if (Array.isArray(slots) && slots.length > 0) body.slots = slots;
  if (lang === "zh" || lang === "en") body.lang = lang;

  const r = await request("/h3_batch/cast_block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    blocks: Array.isArray(data.blocks) ? data.blocks : [],
    fingerprint: data.fingerprint === true,
    raw: data,
  };
}
