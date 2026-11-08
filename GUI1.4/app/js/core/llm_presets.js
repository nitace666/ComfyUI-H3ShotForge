// core/llm_presets.js — LLM 预设 CRUD（B6-T1 A3）。
//
// === 出处注记 ===
// 取码自 legacy/app/js/domain/llm_presets.js:1-171（批 L 任务 L1·原注释「批 L」口径），
// 唯一适配 = import 路径 ../core/api.js → ./api.js（1.3 core 平铺布局）。
//
// 契约（引擎 #49 · 引擎包 __init__.py:424-430/5463-5520 已核实 + 8190 真机 curl）：
//   GET    /h3_batch/llm/presets              → {ok, presets:[{name,base_url,model,context_window,max_tokens?}]}
//   POST   /h3_batch/llm/presets  {name,base_url,api_key?,model,context_window?,max_tokens?} → {ok, preset}
//   DELETE /h3_batch/llm/presets?name=X       → ok / 404 preset_not_found
//   max_tokens（老板 2026-10-25 · AI 回复截断）：可选整数 256-32768；缺省/null = 引擎按 context_window/4 默认。
//
// 安全要点：api_key 永不下发（GET 引擎本就剥）+ 本域层再剥一道（双保险）；
//   编辑回显靠 input.placeholder「已保存则留空沿用」而非 value 注入（渲染侧责任）。
//
// 校验前置：name 1-64（禁 Windows 非法字符）；base_url http(s)://；model 1-256；context_window 整数。
//   本地校验失败 → error.code="<field>_invalid"，不发请求（避免无意义往返 + 引擎 400 兜底）。
//
// ESM 依赖链（单向）：./api.js（request 归一层）。

import { request } from "./api.js";

const URL = "/h3_batch/llm/presets";
const NAME_MAX = 64;
const MODEL_MAX = 256;
const DEFAULT_CONTEXT_WINDOW = 32000;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 32768;

// Windows 非法字符: < > : " / \ | ? *  (加控制字符 0x00-0x1F)
const NAME_FORBID_RE = /[<>:"/\\|?*\x00-\x1F]/;

// ============================================================================
// 1. validateName — 1-64 字符, 禁 Windows 非法字符 + 控制字符
// ============================================================================

export function validateName(name) {
  if (typeof name !== "string" || name.length === 0) return { ok: false, reason: "empty" };
  if (name.length > NAME_MAX) return { ok: false, reason: "too_long" };
  if (NAME_FORBID_RE.test(name)) return { ok: false, reason: "invalid_char" };
  return { ok: true };
}

// ============================================================================
// 2. validateBaseUrl — 必须 http:// 或 https:// 开头
// ============================================================================

export function validateBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return { ok: false, reason: "empty" };
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, reason: "invalid_scheme" };
  return { ok: true };
}

// ============================================================================
// 3. validateModel — 1-256 字符（不含空字符串）
// ============================================================================

export function validateModel(model) {
  if (typeof model !== "string" || model.length === 0) return { ok: false, reason: "empty" };
  if (model.length > MODEL_MAX) return { ok: false, reason: "too_long" };
  return { ok: true };
}

// ============================================================================
// 4. validateContextWindow — 整数（0 允许=不限；undefined/null 允许=用默认）
// ============================================================================

export function validateContextWindow(cw) {
  if (cw === undefined || cw === null) return { ok: true };
  if (typeof cw !== "number" || !Number.isInteger(cw)) return { ok: false, reason: "not_int" };
  if (cw < 0) return { ok: false, reason: "not_int" };
  return { ok: true };
}

// ============================================================================
// 5. validateMaxTokens — 256-32768 整数（undefined/null 允许=引擎默认）
// ============================================================================

export function validateMaxTokens(mt) {
  if (mt === undefined || mt === null) return { ok: true };
  if (typeof mt !== "number" || !Number.isInteger(mt)) return { ok: false, reason: "not_int" };
  if (mt < MAX_TOKENS_MIN || mt > MAX_TOKENS_MAX) return { ok: false, reason: "out_of_range" };
  return { ok: true };
}

// ============================================================================
// 6. validatePresetPayload — 复合校验；返回首个失败（短链路）
//   reason 命名约定: <field>_<reason> 便于上层分支定位
// ============================================================================

export function validatePresetPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "payload_empty" };
  const vName = validateName(payload.name);
  if (!vName.ok) return { ok: false, reason: "name_" + vName.reason, field: "name" };
  const vUrl = validateBaseUrl(payload.base_url);
  if (!vUrl.ok) return { ok: false, reason: "base_url_" + vUrl.reason, field: "base_url" };
  const vModel = validateModel(payload.model);
  if (!vModel.ok) return { ok: false, reason: "model_" + vModel.reason, field: "model" };
  if ("context_window" in payload) {
    const vCw = validateContextWindow(payload.context_window);
    if (!vCw.ok) return { ok: false, reason: "cw_" + vCw.reason, field: "context_window" };
  }
  if ("max_tokens" in payload) {
    const vMt = validateMaxTokens(payload.max_tokens);
    if (!vMt.ok) return { ok: false, reason: "max_tokens_" + vMt.reason, field: "max_tokens" };
  }
  return { ok: true };
}

// ============================================================================
// 7. listPresets — GET（域层剥 api_key 双保险）
// ============================================================================

export async function listPresets() {
  const r = await request(URL, { cache: "no-store" });
  if (!r.ok) return { ok: false, presets: [], error: r.error };
  const data = r.data || {};
  const presets = Array.isArray(data.presets) ? data.presets : [];
  // 安全: 即便引擎返回了 api_key, 域层也剥离
  const safe = presets.map((p) => {
    if (!p || typeof p !== "object") return p;
    const { api_key, ...rest } = p;
    return rest;
  });
  return { ok: true, presets: safe, raw: data };
}

// ============================================================================
// 8. savePreset — POST {name, base_url, api_key?, model, context_window?, max_tokens?}
//   context_window 缺省填 32000；api_key 缺省/空串不传（引擎保留旧值）；
//   max_tokens 缺省/null 不传（引擎按窗口/4 默认）。
//   base_url 裸主机（http(s) + 路径为空/仅根）保存时自动补 /v1（缺陷 #65：
//   漏 /v1 时引擎拼 {base_url}/chat/completions 打到不存在路径 → missing choices）；
//   已带 /v1 或自定义路径（如 /api·网关）原样保存，不补不拦。
// ============================================================================

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) return baseUrl;
  // 注意：模块常量 URL 遮蔽了全局 URL 构造器，这里显式取 globalThis.URL
  let u;
  try { u = new globalThis.URL(baseUrl); } catch { return baseUrl; }
  if (u.search !== "" || u.hash !== "") return baseUrl;
  if (u.pathname !== "/" && u.pathname !== "") return baseUrl;
  return baseUrl.replace(/\/+$/, "") + "/v1";
}

export async function savePreset(payload) {
  const v = validatePresetPayload(payload);
  if (!v.ok) {
    return {
      ok: false,
      error: {
        code: v.field + "_invalid",
        msg: "本地校验失败: " + v.reason,
        detail: v,
        httpStatus: 0,
      },
    };
  }
  const baseUrl = normalizeBaseUrl(payload.base_url);
  const body = {
    name: payload.name,
    base_url: baseUrl,
    model: payload.model,
    context_window: ("context_window" in payload && payload.context_window !== undefined && payload.context_window !== null)
      ? payload.context_window
      : DEFAULT_CONTEXT_WINDOW,
  };
  // api_key 存在且非空才发（空串=不变更沿用旧值=不传）
  if (typeof payload.api_key === "string" && payload.api_key.length > 0) {
    body.api_key = payload.api_key;
  }
  // max_tokens 仅数字才发（null/缺省=默认，不传）
  if (typeof payload.max_tokens === "number") {
    body.max_tokens = payload.max_tokens;
  }
  const r = await request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  // 安全: 即便引擎响应带 api_key, 域层剥离
  const data = r.data || {};
  const { api_key, ...safe } = data;
  return {
    ok: true,
    name: data.name || payload.name,
    base_url: baseUrl,
    base_url_normalized: baseUrl !== payload.base_url,
    raw: safe,
  };
}

// ============================================================================
// 9. deletePreset — DELETE ?name=X
// ============================================================================

export async function deletePreset(name) {
  const v = validateName(name);
  if (!v.ok) {
    return {
      ok: false,
      error: {
        code: "name_invalid",
        msg: "名称非法 (本地拦截)",
        detail: v,
        httpStatus: 0,
      },
    };
  }
  const qs = new URLSearchParams({ name });
  const r = await request(URL + "?" + qs.toString(), { method: "DELETE" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return { ok: true, name: data.name || name, raw: data };
}
