// core/history_ops.js — 历史域运维 (回收站 + 备注 + 两级删除 + 配置回填 + 历史载入).
//
// === 出处注记 (S1-3 T6) ===
// 改造自 legacy/app/js/domain/history_ops.js（L1-185）+ 引擎端点契约 api.md #18/#19/#20/#21/#22;
// 改造点 = ①import 路径 ../core/api.js → ./api.js
//        ②新增 listHistory (GET /h3_batch/history) — S1-3 T6 任务单契约 (响应 {tasks,total,limit,offset})
//        ③新增 loadDetail (GET /h3_batch/history/detail) — S1-3 T6 任务单契约
//          (响应含 shots 数组 + manifest 元数据; query full_prompt=1 可选透传; 缺 task_id 前置拦截);
// 六 API (deleteSoft/deletePurge/listTrash/restore/saveNote/importConfig) 原签名与归一语义原样.
//
// 任务边界:
//   1. deleteSoft    — 软删 (DELETE /h3_batch/history, 默认)
//   2. deletePurge   — 彻底删 (DELETE /h3_batch/history?purge=true), 须先入回收站
//   3. listTrash     — 回收站视图 (GET /h3_batch/history/trash)
//   4. restore       — 恢复任务 (POST /h3_batch/history/restore)
//   5. saveNote      — 备注写入 (POST /h3_batch/history/note), ≤200 字
//   6. importConfig  — 配置回填 (GET /h3_batch/history/config):
//                      200 透传 config; 400 (无 .h3cfg.json 旁车) 暴露给视图层
//                      弹用户提示 "该任务未留配置快照(旧任务), 无法回填"
//   7. listHistory   — 历史列表 (GET /h3_batch/history, T6 新增)
//   8. loadDetail    — 历史详情 (GET /h3_batch/history/detail, T6 新增)
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层).
//   - 不反向 import views/components.

import { request } from "./api.js";
import { t } from "./i18n.js";   // #92 B4：loadDetail 前置拦截 msg 入典（可见 toast 面·侦察 §2）
import { getKey, putKey } from "./server_storage.js";   // 批A #13：本地索引经 server_storage 适配层（缓存层全钉 data/）

// 备注截断阈值 — api.md #22 服务端截 200 字, 前端层兜底 (避免服务端再次截断的边界感)
const NOTE_MAX_LEN = 200;

// ============================================================================
// 1. 软删 (api.md #19)
// ============================================================================
//
// 走 DELETE /h3_batch/history?task_id=&output_dir= (无 purge=true).
// 响应: {ok:true, moved_to_trash:true, task_id, path}

export async function deleteSoft(opts) {
  const taskId = opts.taskId || "";
  const outputDir = opts.outputDir || "";
  const qs = new URLSearchParams({ task_id: taskId });
  if (outputDir) qs.set("output_dir", outputDir);
  const r = await request("/h3_batch/history?" + qs.toString(), { method: "DELETE" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    movedToTrash: !!data.moved_to_trash,
    taskId: data.task_id || taskId,
    path: data.path || "",
    raw: data,
  };
}

// ============================================================================
// 2. 彻底删 (api.md #19 purge=true)
// ============================================================================
//
// 走 DELETE /h3_batch/history?task_id=&output_dir=&purge=true.
// 仅对 .h3_trash 内 manifest 生效 (不在 trash → 后端 400 task_not_in_trash).
// 视图层强制要求先软删, 业务层不另加守卫.

export async function deletePurge(opts) {
  const taskId = opts.taskId || "";
  const outputDir = opts.outputDir || "";
  const qs = new URLSearchParams({ task_id: taskId, purge: "true" });
  if (outputDir) qs.set("output_dir", outputDir);
  const r = await request("/h3_batch/history?" + qs.toString(), { method: "DELETE" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    purged: !!data.purged,
    taskId: data.task_id || taskId,
    path: data.path || "",
    raw: data,
  };
}

// ============================================================================
// 3. 回收站视图 (api.md #20)
// ============================================================================
//
// GET /h3_batch/history/trash?output_dir=
// 响应: {tasks:[{task_id, mtime, original_dir, ...}]}

export async function listTrash(opts) {
  const outputDir = opts.outputDir || "";
  const qs = new URLSearchParams();
  if (outputDir) qs.set("output_dir", outputDir);
  const url = qs.toString() ? ("/h3_batch/history/trash?" + qs.toString()) : "/h3_batch/history/trash";
  const r = await request(url, { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, tasks: [] };
  const tasks = (r.data && Array.isArray(r.data.tasks)) ? r.data.tasks : [];
  return { ok: true, tasks, raw: r.data };
}

// ============================================================================
// 4. 恢复任务 (api.md #21)
// ============================================================================
//
// query 优先 / body 兜底 (api.md #21): 业务层走 query (与旧 L2172 main.js 形态一致).
// 响应: {ok:true, task_id, restored_to}

export async function restore(opts) {
  const taskId = opts.taskId || "";
  const outputDir = opts.outputDir || "";
  const qs = new URLSearchParams({ task_id: taskId });
  if (outputDir) qs.set("output_dir", outputDir);
  const r = await request("/h3_batch/history/restore?" + qs.toString(), { method: "POST" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    taskId: data.task_id || taskId,
    restoredTo: data.restored_to || "",
    raw: data,
  };
}

// ============================================================================
// 5. 备注写入 (api.md #22)
// ============================================================================
//
// query 优先 / body 兜底 — 业务层走 body (与旧 L2697 main.js 形态一致, 便于扩展).
// 备注截 200 字 (服务端兜底; 前端层截到 200 边界, 避免服务端再次截断造成的边界感).
// 响应: {ok:true, task_id, note}

export async function saveNote(opts) {
  const taskId = opts.taskId || "";
  const noteRaw = (typeof opts.note === "string") ? opts.note : "";
  const note = noteRaw.slice(0, NOTE_MAX_LEN);  // 前端层兜底截断
  const outputDir = opts.outputDir || "";

  const body = { task_id: taskId, note };
  if (outputDir) body.output_dir = outputDir;

  const r = await request("/h3_batch/history/note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    taskId: data.task_id || taskId,
    note: data.note || "",
    raw: data,
  };
}

// ============================================================================
// 6. importConfig — 配置回填 (api.md #18)
// ============================================================================
//
// 走 GET /h3_batch/history/config?task_id=&output_dir= — 业务层职责:
//   - 200 响应 + config 字段就位 → ok=true, config 字段透传, 视图层调
//     fillForm(config) 回填到工作台三区
//   - 200 响应缺 config 字段 → ok=false, code=invalid_response (防御性兜底)
//   - 400 响应 (api.md #18 强约束: "该任务未留配置快照, 无法回填" 仅经
//     generate_csv 端点产生的任务才可回填, 旧任务/手填 CSV 任务 → 400)
//     → ok=false, error.code 透传; 视图层据此弹用户明确提示
//
// 注: 本函数不做"成功/失败"的语义重写, 仅做信封归一 + 字段存在校验; 错误
// 文案 (中文) 由视图层组装, 因为不同入口 (详情按钮 vs 列表按钮) 文案有差异.

export async function importConfig(opts) {
  const taskId = opts.taskId || "";
  const outputDir = opts.outputDir || "";
  const qs = new URLSearchParams({ task_id: taskId });
  if (outputDir) qs.set("output_dir", outputDir);
  const r = await request("/h3_batch/history/config?" + qs.toString(), { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  if (!data.config || typeof data.config !== "object") {
    return {
      ok: false,
      error: {
        code: "invalid_response",
        msg: "服务端响应缺 config 字段",
        detail: null,
        httpStatus: 200,
      },
      raw: data,
    };
  }
  return {
    ok: true,
    taskId: data.task_id || taskId,
    config: data.config,
    raw: data,
  };
}

// ============================================================================
// 7. listHistory — 历史列表 (S1-3 T6 新增, GET /h3_batch/history)
// ============================================================================
//
// query: limit / offset / output_dir (均可选, 缺省不写入).
// 响应: {tasks:[...], total, limit, offset}
// 归一: tasks 兜底空数组 (防御); total/limit/offset 原样透出.

export async function listHistory(opts) {
  const limit = opts.limit;
  const offset = opts.offset;
  const outputDir = opts.outputDir || "";

  const qs = new URLSearchParams();
  if (limit != null && limit !== "") qs.set("limit", String(limit));
  if (offset != null && offset !== "") qs.set("offset", String(offset));
  if (outputDir) qs.set("output_dir", outputDir);
  const url = qs.toString() ? ("/h3_batch/history?" + qs.toString()) : "/h3_batch/history";

  const r = await request(url, { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, tasks: [], raw: r.data };
  const data = r.data || {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return {
    ok: true,
    tasks,
    total: typeof data.total === "number" ? data.total : tasks.length,
    limit: data.limit != null ? data.limit : null,
    offset: data.offset != null ? data.offset : null,
    raw: data,
  };
}

// ============================================================================
// 8. loadDetail — 历史详情 (S1-3 T6 新增, GET /h3_batch/history/detail)
// ============================================================================
//
// query: task_id (必填 — 缺 → 业务层前置拦截, 不发请求) / output_dir (可选)
//        / full_prompt=1 (fullPrompt=true 时透传, 引端返回段级完整提示词).
// 响应: shots 数组 (sid/status/review/seed/files/run_dir/final_prompt/seg_duration_sec)
//       + manifest 元数据 — 归一 {ok, taskId, shots, raw}; manifest 元数据走 raw 透传.

export async function loadDetail(opts) {
  const taskId = opts.taskId || "";
  const outputDir = opts.outputDir || "";
  const fullPrompt = !!opts.fullPrompt;

  // 业务层前端义务: 缺 task_id → 直接拦截 (后端也会 400, 前端先兜底省一次往返)
  if (!taskId) {
    return {
      ok: false,
      error: {
        code: "validation",
        msg: t("hist.ops.taskIdRequired"),
        detail: null,
        httpStatus: 0,
      },
    };
  }

  const qs = new URLSearchParams({ task_id: taskId });
  if (outputDir) qs.set("output_dir", outputDir);
  if (fullPrompt) qs.set("full_prompt", "1");

  const r = await request("/h3_batch/history/detail?" + qs.toString(), { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    taskId: data.task_id || taskId,
    shots: Array.isArray(data.shots) ? data.shots : [],
    raw: data,
  };
}

// ============================================================================
// 9. 运行历史本地索引（批A #13 · 方案-#13解耦B档-2026-10-16 批A-2）
// ============================================================================
//   data/runs-index.json = {projects:{[projectId]:{savedAt,tasks}}}——按项目承载载入历史弹窗
//   （edit.js openHistoryModal）的离线数据源：在线 listHistory 成功后回写（合并他项目键不互覆），
//   引擎不可达时弹窗先行渲染本地索引（标注数据时点）。与 project.runs 30 条 feed 封顶
//   schema 不同用途不同——互不放宽。

export const RUNS_INDEX_KEY = "data/runs-index.json";

// 纯函数：按项目 upsert（坏形态防御归一；projectId/tasks 非法零写原样返回）
export function upsertRunsIndexProject(indexObj, projectId, tasks) {
  const base = (indexObj && typeof indexObj === "object" && !Array.isArray(indexObj)) ? indexObj : {};
  const projects = (base.projects && typeof base.projects === "object" && !Array.isArray(base.projects)) ? base.projects : {};
  if (!projectId || typeof projectId !== "string" || !Array.isArray(tasks)) return { ...base, projects };
  return { ...base, projects: { ...projects, [projectId]: { savedAt: new Date().toISOString(), tasks } } };
}

// 纯函数：读项目 tasks（未录/坏形态 → null = 无本地索引）
export function runsIndexTasksFor(indexObj, projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  const base = (indexObj && typeof indexObj === "object" && !Array.isArray(indexObj)) ? indexObj : {};
  const projects = (base.projects && typeof base.projects === "object" && !Array.isArray(base.projects)) ? base.projects : {};
  const entry = projects[projectId];
  return (entry && Array.isArray(entry.tasks)) ? entry.tasks : null;
}

// 读项目本地索引（含数据时点；网络失败/未录 → null）
export async function loadRunsIndexTasks(projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  const r = await getKey(RUNS_INDEX_KEY).catch(() => null);
  const d = (r && r.ok) ? r.data : null;
  const base = (d && typeof d === "object" && !Array.isArray(d)) ? d : {};
  const projects = (base.projects && typeof base.projects === "object" && !Array.isArray(base.projects)) ? base.projects : {};
  const entry = projects[projectId];
  if (!entry || !Array.isArray(entry.tasks) || !entry.tasks.length) return null;
  return { tasks: entry.tasks, savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "" };
}

// 回写：getKey → 合并 → putKey（fire-and-forget 由调用方定；非法入参零写）
export async function refreshRunsIndex(projectId, tasks) {
  if (!projectId || typeof projectId !== "string" || !Array.isArray(tasks) || !tasks.length) {
    return { ok: false, error: { code: "validation", msg: "缺 projectId/tasks", detail: null, httpStatus: 0 } };
  }
  const r = await getKey(RUNS_INDEX_KEY).catch(() => null);
  const cur = (r && r.ok) ? r.data : null;
  const next = upsertRunsIndexProject(cur, projectId, tasks);
  const w = await putKey(RUNS_INDEX_KEY, next);
  return w.ok ? { ok: true, error: null } : { ok: false, error: w.error };
}
