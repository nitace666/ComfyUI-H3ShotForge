// core/llm_chat.js — LLM 会话/对话（B6-T2 A1）。
//
// === 出处注记 ===
// 取码自 legacy/app/js/domain/llm_chat.js:1-228（批 L 任务 L2），适配点:
//   ① 会话键族 h3gui_llm_session → gui13.llm.session（1.3 口径 · 主代理定夺 3）;
//   ② sendChat 超时取值链 payload.timeoutMs ?? readChatTimeoutMs() ?? TIMEOUTS.llmChat
//      （老板 2026-10-26 本地模型慢：设置页 pref.chatTimeoutSec 可配 30-900s·默认 300s; 原 90s 兜底）;
//   ③ storage 适配 getItem/setItem/removeItem（1.3 房风 · submit.js:218 同款注入位）。
//
// 契约（引擎 docs/api.md #50/#51 + 8190 真机 curl 实测）:
//   POST /h3_batch/llm/chat {session_id?, model,
//     message, timeout_sec?（批9 G1③·秒·取整·引擎 E3 钳 30-900·缺省走引擎默认）}
//     — model=预设 name（引擎实体, 非预设内 model 字段）
//     → {ok, session_id, reply, finish_reason, snapshot, checks:{warns,errs}, trimmed_old_count}
//     + #46 批7 三新字段（引擎 docs/api.md §65·纯增量）：sent_messages_count（实际发给模型的
//       messages 条数·含 system 与本轮 user → 历史条数 = 值 − 2）/ sent_chars /
//       carries_context_floor（预算降级标记·最近一条历史未能送出）
//     + #59 批9 E2 新字段：head_messages_count（头部实发条数·缺 → null=可见性指示降级只报计数）
//     400 unknown_model / 404 session_not_found / 500 llm_call_failed / llm_context_overflow
//   旧引擎（未重启·无新字段）→ 新字段归一为 null（视图据此不显示可见性指示/降级·零报错）
//   GET  /h3_batch/llm/sessions [?id=X] → 列表 / {session:{id, messages, snapshot, metadata}}
//   DELETE /h3_batch/llm/sessions/messages?id=<sid>&index=<n>（#47/E1·引擎仓 7dbaa5a）
//     → {messages:[删除后完整清单]}；404 index_out_of_range / session_not_found；snapshot 不动
//
// 关键约束（引擎 S2）: GUI 恒不传 permission_tier（后端缺省「普通」档）; message 1-16384 本地预校验。
// 404 session_not_found: 域层只透传 code, 视图层 resetCurrentSession 后重发一次（不静默自杀态）。

import { request } from "./api.js";
import { t } from "./i18n.js";   // #92 B4：七条错误 msg 入典 llm.*（可见 toast 面·方案 §9-U2）
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件超时值引表·不得就地内联。
import {
  TIMEOUTS,
  LLM_CHAT_TIMEOUT_DEFAULT_MS,
  LLM_CHAT_TIMEOUT_MIN_SEC,
  LLM_CHAT_TIMEOUT_MAX_SEC,
} from "./timeouts.js";
// 设置偏好（M-T4/M-T7：server 聚合文件读·localStorage 仅旧存量兼容）
import { readAgg, SETTINGS_JSON } from "./server_storage.js";

export const CHAT_URL = "/h3_batch/llm/chat";
export const SESSIONS_URL = "/h3_batch/llm/sessions";
export const SESSION_STORAGE_KEY = "gui13.llm.session";
export const CHAT_TIMEOUT_PREF_KEY = "gui13.settings.pref";
export const CHAT_TIMEOUT_MS = TIMEOUTS.llmChat; // 原常量（末级兜底）

const MESSAGE_MAX = 16384;
const SID_REGEX = /^[0-9a-f]{28}$/;

// ============================================================================
// 1. 纯函数: validateMessage / validateSessionId / generateSessionId
// ============================================================================

export function validateMessage(msg) {
  if (typeof msg !== "string" || msg.length === 0) return { ok: false, reason: "empty" };
  if (msg.length > MESSAGE_MAX) return { ok: false, reason: "too_long" };
  return { ok: true };
}

export function validateSessionId(sid) {
  if (typeof sid !== "string" || !SID_REGEX.test(sid)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

export function generateSessionId() {
  // 14 字节 = 28 hex（引擎 uuid4().hex[:28] 同形）; crypto 优先, fallback Math.random
  const bytes = new Uint8Array(14);
  if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// ============================================================================
// 2. 模块态会话 id（内存态 + 持久化）
// ============================================================================

let _currentSessionId = null;

export function getCurrentSessionId() {
  return _currentSessionId;
}

export function resetCurrentSession() {
  _currentSessionId = null;
  const s = _getStorage();
  if (s) {
    try { s.removeItem(SESSION_STORAGE_KEY); } catch (_e) { /* 存储不可用不阻断 */ }
  }
}

// storage 注入位（测试用; 缺省 globalThis.localStorage）
let _storage = null;
export function _test_setStorage(s) { _storage = s; }
export function _test_clearStorage() { _storage = null; }

function _getStorage() {
  if (_storage) return _storage;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

export function persistSessionId(sid) {
  if (!validateSessionId(sid).ok) return; // 非 28hex 拒绝写入
  const s = _getStorage();
  if (!s) return;
  try { s.setItem(SESSION_STORAGE_KEY, sid); } catch (_e) { /* 存储不可用不阻断 */ }
}

// 恢复四态: 合法→回值并同步内存态 / 非法→静默清键 / 无键→null / 无 storage→null（均不抛）
export function restoreSessionId() {
  const s = _getStorage();
  if (!s) return null;
  let v = null;
  try { v = s.getItem(SESSION_STORAGE_KEY); } catch (_e) { return null; }
  if (validateSessionId(v).ok) {
    _currentSessionId = v; // 同步内存态（下次 sendChat 自动续用）
    return v;
  }
  try { s.removeItem(SESSION_STORAGE_KEY); } catch (_e) { /* 同上 */ }
  return null;
}

// ============================================================================
// 3. 超时读取（老板 2026-10-26：本地模型反应慢 → 设置页可配·默认 300s）
//   设置页写 pref.chatTimeoutSec（秒·30-900 钳制）；本函数转 ms。
//   读源顺序 = server 聚合件（M-T7 纯 server 主源）→ 旧 localStorage 键（迁移前存量兼容）。
//   未配置/非法/越界 → 默认 300s（不钳制：越界值视为脏数据）。
// ============================================================================

export function readChatTimeoutMs(storage) {
  const s = storage || _getStorage();
  let pref = readAgg(SETTINGS_JSON, "pref");
  if (!pref || typeof pref !== "object") {
    try {
      const raw = s ? s.getItem(CHAT_TIMEOUT_PREF_KEY) : null;
      pref = raw ? JSON.parse(raw) : null;
    } catch (_e) { pref = null; }
  }
  const sec = Number(pref && pref.chatTimeoutSec);
  if (Number.isFinite(sec) && sec >= LLM_CHAT_TIMEOUT_MIN_SEC && sec <= LLM_CHAT_TIMEOUT_MAX_SEC) {
    return Math.round(sec) * 1000;
  }
  return LLM_CHAT_TIMEOUT_DEFAULT_MS;
}

// ============================================================================
// 4. sendChat — POST #50
//   session_id 优先级: payload.sessionId > 内存态; 成功即更新内存态 + 落键.
// ============================================================================

export async function sendChat(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: { code: "message_invalid", msg: t("llm.err.payloadMissing"), detail: null, httpStatus: 0 } };
  }
  const vMsg = validateMessage(payload.message);
  if (!vMsg.ok) {
    return {
      ok: false,
      error: { code: "message_invalid", msg: t("llm.err.messageInvalid", { reason: vMsg.reason }), detail: vMsg, httpStatus: 0 },
    };
  }
  const sid = (typeof payload.sessionId === "string" && SID_REGEX.test(payload.sessionId))
    ? payload.sessionId
    : _currentSessionId;
  const body = { model: payload.model, message: payload.message };
  if (sid) body.session_id = sid;
  // GUI 恒不传 permission_tier（引擎缺省「普通」档）

  // 超时取值顺序（任务单 2）：调用方显式 > 设置页偏好 > 集中表原常量兜底
  const timeoutMs = payload.timeoutMs ?? readChatTimeoutMs() ?? TIMEOUTS.llmChat;
  // #60 批9 G1③：请求体带 timeout_sec（引擎 E3 可选·秒·取整；有限值才带·旧引擎忽略未知字段向后兼容）
  if (Number.isFinite(timeoutMs)) body.timeout_sec = Math.round(timeoutMs / 1000);
  const r = await request(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!r.ok) {
    // 引擎 400/404/500 透传 code+msg+detail; 404 session_not_found 由视图层决定重建
    return { ok: false, error: r.error, raw: r.data };
  }
  const data = r.data || {};
  const newSid = (typeof data.session_id === "string" && SID_REGEX.test(data.session_id))
    ? data.session_id
    : sid;
  if (newSid) {
    _currentSessionId = newSid;
    persistSessionId(newSid); // 落键（刷新后恢复）
  }
  return {
    ok: true,
    session_id: newSid,
    reply: typeof data.reply === "string" ? data.reply : "",
    finish_reason: typeof data.finish_reason === "string" ? data.finish_reason : "stop",
    snapshot: (data.snapshot && typeof data.snapshot === "object") ? data.snapshot : null,
    checks: (data.checks && typeof data.checks === "object")
      ? {
          warns: Array.isArray(data.checks.warns) ? data.checks.warns : [],
          errs: Array.isArray(data.checks.errs) ? data.checks.errs : [],
        }
      : { warns: [], errs: [] },
    trimmed_old_count: typeof data.trimmed_old_count === "number" ? data.trimmed_old_count : 0,
    // #46 批7（引擎 api.md §65）：三新字段纯增量——旧引擎缺字段 → null（视图据此不显示·不断言）
    sent_messages_count: typeof data.sent_messages_count === "number" ? data.sent_messages_count : null,
    sent_chars: typeof data.sent_chars === "number" ? data.sent_chars : null,
    carries_context_floor: typeof data.carries_context_floor === "boolean" ? data.carries_context_floor : null,
    // #59 批9 G1（引擎 E2）：head_messages_count=头部实发条数——E2 未落地缺字段 → null（指示降级只报计数）
    head_messages_count: typeof data.head_messages_count === "number" ? data.head_messages_count : null,
    raw: data,
  };
}

// ============================================================================
// 5. listSessions / getSessionDetail — GET #51（T3 会话列表复用）
// ============================================================================

export async function listSessions() {
  const r = await request(SESSIONS_URL, { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, sessions: [] };
  const data = r.data || {};
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  return { ok: true, sessions, raw: data };
}

export async function getSessionDetail(id) {
  const v = validateSessionId(id);
  if (!v.ok) {
    return {
      ok: false,
      error: { code: "id_invalid", msg: t("llm.err.sidInvalid"), detail: v, httpStatus: 0 },
    };
  }
  const qs = new URLSearchParams({ id });
  const r = await request(SESSIONS_URL + "?" + qs.toString(), { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  const session = (data.session && typeof data.session === "object") ? data.session : null;
  if (!session) {
    return {
      ok: false,
      error: { code: "session_missing", msg: t("llm.err.sessionMissing"), detail: null, httpStatus: 200 },
      raw: data,
    };
  }
  return { ok: true, session, raw: data };
}

// ============================================================================
// 6. deleteSessionMessage — DELETE #47/E1（引擎仓 7dbaa5a：会话级锁内重写消息数组·原子写；
//    只动 messages·snapshot/manual_edits 不动）。引擎 8190 运行进程未加载新端点前不可真机调。
// ============================================================================

export const MESSAGES_URL = "/h3_batch/llm/sessions/messages";

export async function deleteSessionMessage(id, index) {
  const v = validateSessionId(id);
  if (!v.ok) {
    return {
      ok: false,
      error: { code: "id_invalid", msg: t("llm.err.sidInvalid"), detail: v, httpStatus: 0 },
    };
  }
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) {
    // index 形态非法引擎侧为 400·GUI 正常传参不触达（气泡 msgKey 解析已兜底）→ 本地拦截同形
    return {
      ok: false,
      error: { code: "index_invalid", msg: t("llm.err.indexInvalid"), detail: null, httpStatus: 0 },
    };
  }
  const qs = new URLSearchParams({ id, index: String(n) });
  const r = await request(MESSAGES_URL + "?" + qs.toString(), { method: "DELETE", cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  const messages = Array.isArray(data.messages) ? data.messages : null;
  if (!messages) {
    return {
      ok: false,
      error: { code: "messages_missing", msg: t("llm.err.messagesMissing"), detail: null, httpStatus: 200 },
      raw: data,
    };
  }
  return { ok: true, messages, raw: data };
}
