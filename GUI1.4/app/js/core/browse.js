// core/browse.js — 引擎 browse 端点封装 (S2-3 T3 c4/D8 简版目录浏览).
//
// === 出处注记 (S2-3 T3) ===
// 端点契约: api.md #13 `GET /h3_batch/browse?path=<dir>&exts=<逗号分隔>`
//   → browse_dir(path, exts) 列表 (batch_core.py:2161). 响应形:
//     {path, parent, dirs:[name], files:[name], drives?}
//   或 {error: "..."} (路径非法/不可读).
//   本任务 = 全类型目录列 (exts 不传 → list all), 仅文件列表 + 弹窗渲染,
//   Tauri 系统壳登记 S3-4 (本批不实现)。
//
// 任务边界:
//   1. browseDirectory(path)  → 走 api.js request, 归一 {ok, data, error}.
//   2. formatBrowseEntries    → 纯函数, 整理后端响应成弹窗渲染用形; 不接 DOM.
//                                视图层把它渲染进 mbox body (复用既有 openMbox 惯例).
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层).
//   - 不反向 import views/components.

import { request } from "./api.js";

// 浏览服务端目录. exts 缺省 = 不传 (引擎 browse_dir 走 exts or None → 全列).
// 归一 {ok, data, error} — 与 core/* 同形, 视图层统一消费.
export async function browseDirectory(path) {
  const qs = "?path=" + encodeURIComponent(path || "");
  const r = await request("/h3_batch/browse" + qs);
  if (!r.ok) return { ok: false, data: null, error: (r.error && r.error.msg) || "engine_no_response" };
  return { ok: true, data: r.data, error: null };
}

// 纯函数: 后端 browse_dir 响应 → 弹窗渲染用形.
//   形: {path, parent, dirs, files, empty?, error?}
//   - error 字段在: 弹窗显示错误文案 (无 dirs/files).
//   - dirs/files 全空 + 非 error → 形带 empty=true (空目录文案).
//   - 响应非对象 / 缺字段 → 防御性兜底.
export function formatBrowseEntries(data) {
  if (!data || typeof data !== "object") return { error: "服务端响应格式异常" };
  if (data.error) return { error: String(data.error) };
  const path = typeof data.path === "string" ? data.path : "";
  const parent = typeof data.parent === "string" ? data.parent : "";
  const dirs = Array.isArray(data.dirs) ? data.dirs.filter((d) => typeof d === "string") : [];
  const files = Array.isArray(data.files) ? data.files.filter((f) => typeof f === "string") : [];
  if (!dirs.length && !files.length) return { path, parent, dirs: [], files: [], empty: true };
  return { path, parent, dirs, files };
}

// ============================================================================
// === 批 2-T3 扩展（只增不改既有导出）：服务器文件浏览器用目录列表 + 两层扫描 ===
// ============================================================================

// joinPath(dir, name) — 引擎路径拼接（Windows 反斜杠规约：正斜杠归一 + 尾分隔去重）
export function joinPath(dir, name) {
  if (!dir) return name + "\\";
  const norm = dir.replace(/\//g, "\\").replace(/\\+$/, "");
  return norm + "\\" + name;
}

// _errorText(err) — request 信封 → 一句人话（引擎 200+{error:"A: B"} 经归一拆成 code/msg，此处拼回原话）
function _errorText(err) {
  if (!err) return "browse 请求失败";
  if (err.msg) return err.code ? err.code + ": " + err.msg : String(err.msg);
  return err.code ? String(err.code) : "browse 请求失败";
}

// listDirectory(path, exts) — 带扩展名过滤的目录列表（api.md #13 browse_dir）。
//   返回 {ok, path, parent, dirs, files, drives, error}：
//   - exts 非空 → 引擎端按扩展名过滤（大小写不敏感·引擎侧口径）；
//   - path 空 → 引擎返回盘符列表（drives:true, dirs=[盘符]）；
//   - 引擎 200+{error:"目录不存在: X"} 经 request 归一为 ok:false + error 原话。
export async function listDirectory(path, exts) {
  const arr = Array.isArray(exts) ? exts.filter((e) => typeof e === "string" && e) : [];
  let qs = "?path=" + encodeURIComponent(path || "");
  if (arr.length) qs += "&exts=" + encodeURIComponent(arr.join(","));
  const r = await request("/h3_batch/browse" + qs);
  const empty = { ok: false, path: "", parent: "", dirs: [], files: [], drives: false };
  if (!r.ok) return { ...empty, error: _errorText(r.error) };
  const d = r.data && typeof r.data === "object" ? r.data : null;
  if (!d) return { ...empty, error: "服务端响应格式异常" };
  if (d.error) return { ...empty, error: String(d.error) };
  return {
    ok: true,
    path: typeof d.path === "string" ? d.path : "",
    parent: typeof d.parent === "string" ? d.parent : "",
    dirs: Array.isArray(d.dirs) ? d.dirs.filter((x) => typeof x === "string") : [],
    files: Array.isArray(d.files) ? d.files.filter((x) => typeof x === "string") : [],
    drives: !!d.drives,
    error: null,
  };
}

// scanTwoLevels(rootDir, exts) — 两层扫描（引擎 browse 不递归：根层 + 直接子目录各列一次）。
//   返回 {rootDir, files:[{name, absPath, dir}], error}：去重按 absPath；单子目录失败跳过；
//   根层失败 → 空结果 + error 透传（不抛）。
export async function scanTwoLevels(rootDir, exts) {
  const arr = Array.isArray(exts) ? exts : (exts ? [exts] : []);
  const files = [];
  const seen = new Set();
  const push = (name, dir) => {
    const absPath = joinPath(dir, name);
    if (seen.has(absPath)) return;
    seen.add(absPath);
    files.push({ name, absPath, dir });
  };
  const root = await listDirectory(rootDir, arr);
  if (!root.ok) return { rootDir, files: [], error: root.error };
  for (const n of root.files) push(n, rootDir);
  for (const sub of root.dirs) {
    const subDir = joinPath(rootDir, sub);
    const r = await listDirectory(subDir, arr);
    if (!r.ok) continue; // 单子目录失败 → 跳过，不影响其它
    for (const n of r.files) push(n, subDir);
  }
  return { rootDir, files, error: null };
}
