// core/run_snapshots.js — 运行快照落盘/读取/枚举（档2 G2·T3）
//
// 快照 = 提交时刻项目参数全貌（用户原文态·不做展开/转换），落独立文件
//   data/projects/<pid>/runs/<recordId>.json（devserver 数据键白名单支持子目录·列举不误收）。
// recordId = <stem>--<kind><序号>（全小写）；序号 = 落盘前枚举同前缀现有文件 max+1
//   （不按 runs 行内计数——runs 30 条截断会重置计数导致静默覆盖）。
// 写失败不抛：返回 {recordId, ok:false, error} + 固定 toast；调用方标 runs 行 snapshot:false，
//   渲染/提交/后期编排照常不阻塞（不重试）。

import { getKey, putKey, listKeyDir } from "./server_storage.js";
import { serializeLoraOverrides, serializeOverrides } from "./serialize.js";

const SNAPSHOT_FAIL_TOAST = "运行快照保存失败，该记录将无法完整载入";
const BASE_RE = /^[a-z0-9._-]+$/;
const KIND_RE = /^[a-z0-9_-]+$/;

function _deepCopy(v) {
  if (v == null || typeof v !== "object") return v;
  try { return structuredClone(v); } catch (_e) { /* 老环境兜底 */ }
  try { return JSON.parse(JSON.stringify(v)); } catch (_e) { return v; }
}

function _dirOf(projectId) {
  return `data/projects/${String(projectId || "")}/runs/`;
}

function _keyOf(projectId, recordId) {
  return `${_dirOf(projectId)}${recordId}.json`;
}

// FNV-1a 32bit → 8 位十六进制（非 ASCII stem 且无 ASCII taskId 时的稳定兜底）
function _hash8(s) {
  let h = 0x811c9dc5;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// stem 全小写 ASCII → 直接作 base；非 ASCII → ASCII taskId / 哈希 + 时间戳尾缀（过白名单）。
function _baseFor(payload) {
  const stem = typeof payload.stem === "string" ? payload.stem.trim() : "";
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  const ts = Date.now().toString(36);
  if (stem && BASE_RE.test(stem.toLowerCase())) return { base: stem.toLowerCase(), fallback: false };
  if (taskId && BASE_RE.test(taskId.toLowerCase())) return { base: `${taskId.toLowerCase()}-${ts}`, fallback: true };
  return { base: `h${_hash8(stem || taskId || "run")}-${ts}`, fallback: true };
}

function _kindOf(payload) {
  const k = String(payload.kind || "main").trim().toLowerCase();
  return KIND_RE.test(k) ? k : "main";
}

function _nextSeq(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const m = /^(\d+)/.exec(id.slice(prefix.length));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// 提交时刻项目参数全貌（用户原文态·深拷贝）；extra 覆盖 at/stem/taskId/kind/sourceRecordId/postfx
export function buildRunSnapshotPayload(project, extra) {
  const p = (project && typeof project === "object") ? project : {};
  const out = {
    segments: _deepCopy(Array.isArray(p.segments) ? p.segments : []),
    globalParams: _deepCopy(p.globalParams && typeof p.globalParams === "object" ? p.globalParams : {}),
    globalPrompt: typeof p.globalPrompt === "string" ? p.globalPrompt : "",
    projMode: typeof p.projMode === "string" ? p.projMode : "",
    runCount: Number.isFinite(+p.runCount) ? +p.runCount : 0,
    loraChain: _deepCopy(Array.isArray(p.loraChain) ? p.loraChain : []),
    modelOverrides: _deepCopy(p.modelOverrides && typeof p.modelOverrides === "object" ? p.modelOverrides : {}),
    castBindings: _deepCopy(Array.isArray(p.castBindings) ? p.castBindings : []),
    poolManual: _deepCopy(p.poolManual && typeof p.poolManual === "object" ? p.poolManual : {}),
    loraTplState: _deepCopy(p.loraTplState && typeof p.loraTplState === "object" ? p.loraTplState : {}),
    // #63 T5：T3 缺口补齐——LoRA 逐项覆盖原值 + 锚点镜像（旧快照无此二键·载入侧跳过）
    loraOverrides: _deepCopy(p.loraOverrides && typeof p.loraOverrides === "object" ? p.loraOverrides : {}),
    anchorMirror: typeof p.anchorMirror === "string" ? p.anchorMirror : "",
    resource_overrides: serializeOverrides(p.modelOverrides),
    lora_overrides: serializeLoraOverrides(p.loraOverrides),
  };
  return Object.assign(out, _deepCopy(extra && typeof extra === "object" ? extra : {}));
}

// 枚举 data/projects/<pid>/runs/ 下 json（devserver 目录列举只取一层·不递归）
export async function listRunSnapshotIds(projectId) {
  if (!projectId) return [];
  const r = await listKeyDir(_dirOf(projectId));
  return r.ok ? r.ids : [];
}

export async function loadRunSnapshot(projectId, recordId) {
  if (!projectId || !recordId) return null;
  const r = await getKey(_keyOf(projectId, recordId));
  return (r && r.ok && r.data && typeof r.data === "object") ? r.data : null;
}

// 主任务快照查找（rerun/postfx 复用/回溯）：优先 main（主链），无 main 再取 resume；
//   同 kind 取序号最大一条。
export async function findMainSnapshotId(projectId, taskId) {
  const t = typeof taskId === "string" ? taskId.trim().toLowerCase() : "";
  if (!projectId || !t || !BASE_RE.test(t)) return "";
  const ids = await listRunSnapshotIds(projectId);
  const prefix = `${t}--`;
  const best = { main: { id: "", seq: -1 }, resume: { id: "", seq: -1 } };
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const m = /^(main|resume)(\d+)$/.exec(id.slice(prefix.length));
    if (!m) continue;
    const kind = m[1];
    const n = parseInt(m[2], 10);
    if (n > best[kind].seq) { best[kind].seq = n; best[kind].id = id; }
  }
  return best.main.id || best.resume.id;
}

export async function saveRunSnapshot(projectId, payload) {
  let recordId = "";
  try {
    if (!projectId || !payload || typeof payload !== "object") {
      return { recordId, ok: false, error: { code: "bad_args", msg: "缺 projectId 或 payload" } };
    }
    const snapshot = _deepCopy(payload);
    if (!snapshot.at) snapshot.at = new Date().toISOString();
    const kind = _kindOf(snapshot);
    const { base, fallback } = _baseFor(snapshot);
    const listed = await listKeyDir(_dirOf(projectId));
    const seq = listed.ok ? _nextSeq(listed.ids, `${base}--${kind}`) : 1;
    // 枚举失败且 base 无时间戳（ASCII stem）→ 补时间戳尾缀，防并发/异常下静默覆盖
    const tail = (!listed.ok && !fallback) ? `-${Date.now().toString(36)}` : "";
    recordId = `${base}--${kind}${seq}${tail}`;
    snapshot.recordId = recordId;
    snapshot.kind = kind;
    const r = await putKey(_keyOf(projectId, recordId), snapshot);
    if (!r || !r.ok) {
      await _toastFailure();
      return { recordId, ok: false, error: (r && r.error) || { code: "put_failed", msg: "写入失败" } };
    }
    return { recordId, ok: true, error: null };
  } catch (e) {
    await _toastFailure();
    return { recordId, ok: false, error: { code: "exception", msg: String((e && e.message) || e) } };
  }
}

// 测试注入位（_setPutFailToast 同款惯例）；生产走 ui/toast 动态 import（core 不静态依赖 ui）
let _toastOverride = null;
export function _setSnapshotToastForTest(fn) { _toastOverride = typeof fn === "function" ? fn : null; }

async function _toastFailure() {
  if (_toastOverride) {
    try { _toastOverride(SNAPSHOT_FAIL_TOAST); } catch (_e) { /* 注入桩异常不影响写结果 */ }
    return;
  }
  try {
    const { showToast } = await import("../ui/toast.js");
    showToast("error", SNAPSHOT_FAIL_TOAST);
  } catch (_e) { /* toast 加载失败静默——写失败结果仍如实返回 */ }
}
