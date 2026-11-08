// core/csv_transfer.js — CSV 导入/导出（W-02/W-03 转正·老板授权自主排期批 1）
//
// 链路（引擎权威解析·前端零自造 CSV 格式）：
//   导出：buildFormDataFromProject → generateOnly（引擎 generate_csv 落盘+返回 path）
//         → readCsvText（queue_read 读回全文）→ 前端 Blob 下载
//   导入：前端读本地 .csv 文本 → saveQueueCsv（save_queue 落引擎 input 目录→path）
//         → parseCsvForImport（parse_csv 权威解析 globals/rows）→ rowsToSegments 回填 store
//
// CSV 列（引擎 csv_gen.SHOT_HEADER）："ID" + 九镜头（镜头角度/景别/运镜方式/运镜方向/
//   运镜幅度/运镜速度/焦段/氛围/情绪） + prompt/段落时长/种子/导出文件名（+自定义模式
//   "与上一片段拼接"）。shots 行键与 GUI segment 字段的对应照抄 buildFormDataFromProject
//   （submit.js:298-316：GUI 段内九镜头键为"角度"简写等，此处做逆向）。
//
// globals 回填口径（克制·防两歧）：仅回填「同名直映白名单」文本键（引擎值域宽松）；
//   值域映射键（比例/质量/审片门/音乐混入/自动拼接）与异名键（步数）不自动回填
//   （引擎值（数字/整数）与 GUI 控件值域（label/文案）两歧，宁缺毋滥——导入主体是分镜表）。
//
// B2-T5（G8）补全：
//   ① 素材池透传——CSV 池三行（Picture/Video/Audio × 槽 1-9）由引擎解析为 pool/pool_usage/
//      pool_pose_style（真机实测·.tmp/batch2/t5-probe.csv），导入链原样带出 → store 保存
//      （键名与提交链 buildFormData 同形——buildPool 产物经 CSV 往返逐键不丢；池展示 UI 归批 8）。
//   ② 未知列清单——引擎 parse_csv 只回 14 列契约键、未知列被引擎静默丢弃（真机实测），
//      故清单取自导入文本的 ID 表头行（只扫列名，不解析数据；引擎仍是数据解析权威）。

import { request } from "./api.js";
import { generateOnly, buildFormDataFromProject } from "./submit.js";

// ---- 网络编排（薄封装·信封走 api.request） ----

// POST /h3_batch/save_queue {text} → {name, path}（旧端点·成功裸对象）
export async function saveQueueCsv(text) {
  const r = await request("/h3_batch/save_queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text == null ? "" : text) }),
  });
  if (!r.ok || !r.data || typeof r.data.path !== "string") {
    return { ok: false, error: (r.error && r.error.msg) || "save_queue 未返回 path" };
  }
  return { ok: true, path: r.data.path, name: r.data.name };
}

// GET /h3_batch/queue_read?path= → {text}（读任意引擎侧 .csv 全文）
export async function readCsvText(path) {
  const r = await request(`/h3_batch/queue_read?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!r.ok || !r.data || typeof r.data.text !== "string") {
    return { ok: false, error: (r.error && r.error.msg) || "queue_read 未返回 text" };
  }
  return { ok: true, text: r.data.text };
}

// GET /h3_batch/parse_csv?path= → {globals, shots}（引擎权威解析）
// 键名以真机为准（2026-09-27 真机实测：行数组键 = "shots"；api.md §33 写 "rows" 与实机不符）
export async function parseCsvForImport(path) {
  const r = await request(`/h3_batch/parse_csv?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  const rows = r.ok && r.data ? (Array.isArray(r.data.shots) ? r.data.shots : (Array.isArray(r.data.rows) ? r.data.rows : null)) : null;
  if (!rows) {
    return { ok: false, error: (r.error && r.error.msg) || "parse_csv 未返回 shots" };
  }
  return {
    ok: true,
    globals: (r.data.globals && typeof r.data.globals === "object") ? r.data.globals : {},
    rows,
    // B2-T5：池三形态（真机实测缺字段 → 空对象兜底，下游 hasPoolEntries 安全）
    pool: _poolOf(r.data.pool),
    pool_usage: _poolOf(r.data.pool_usage),
    pool_pose_style: _poolOf(r.data.pool_pose_style),
  };
}

// ---- B2-T5：素材池透传（纯函数·单测覆盖） ----

// 池三 kind（引擎 csv_gen.py:43 固定写 Picture/Video/Audio 三行）
const POOL_KINDS = ["Picture", "Video", "Audio"];

// 池字段归一：缺/非对象 → 三 kind 空对象；kind 内值原样透传（导入是保留不是重建）
function _poolOf(v) {
  const src = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  const out = {};
  for (const k of POOL_KINDS) {
    const slots = src[k];
    out[k] = (slots && typeof slots === "object" && !Array.isArray(slots)) ? slots : {};
  }
  return out;
}

// 池是否含实际素材（任一 kind 至少一槽有值）——legacy workbench_paths._hasPoolEntries 口径
export function hasPoolEntries(pool) {
  if (!pool || typeof pool !== "object") return false;
  for (const k of POOL_KINDS) {
    const slots = pool[k];
    if (!slots || typeof slots !== "object") continue;
    for (const key of Object.keys(slots)) {
      const v = slots[key];
      if (Array.isArray(v) ? v.length > 0 : (v != null && String(v).trim() !== "")) return true;
    }
  }
  return false;
}

// ---- 导出编排：项目 → CSV 文本（引擎真编译·格式与提交主链逐字节一致） ----
export async function exportProjectCsv(project, poolCtx) {
  const formData = buildFormDataFromProject(project, poolCtx);
  const gen = await generateOnly(formData);
  if (!gen.ok) return { ok: false, error: `生成 CSV 失败：${(gen.error && gen.error.msg) || (gen.error && gen.error.code) || "引擎未连接？"}` };
  const rd = await readCsvText(gen.csv_path);
  if (!rd.ok) return { ok: false, error: `读回 CSV 失败：${rd.error}` };
  return { ok: true, text: rd.text, csvPath: gen.csv_path };
}

// ---- 导入回填映射（纯函数·单测覆盖） ----

// CSV 行键 → GUI segment 字段（逆向照抄 buildFormDataFromProject shots 组装）
const ROW_TO_SEG_KEYS = [
  ["prompt", "prompt"],
  ["段落时长", "durationSec"],
  ["种子", "seed"],
  ["导出文件名", "exportName"],
  ["镜头角度", "角度"],
  ["景别", "景别"],
  ["运镜方式", "运镜方式"],
  ["运镜方向", "运镜方向"],
  ["运镜幅度", "运镜幅度"],
  ["运镜速度", "运镜速度"],
  ["焦段", "焦段"],
  ["氛围", "氛围"],
  ["情绪", "情绪"],
];
const CONCAT_FLAG_COL = "与上一片段拼接";

// 分镜表头已知列 = ID + 13 映射列 + 自定义拼接列（legacy SHOT_KEYS ∪ {CONCAT_FLAG_KEY} 同集）
const KNOWN_SHOT_COLUMNS = ["ID", ...ROW_TO_SEG_KEYS.map(([rowKey]) => rowKey), CONCAT_FLAG_COL];

// CSV 单行切分（引号感知——仅用于表头列名，数据解析仍归引擎）
function _splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const _normCol = (s) => String(s == null ? "" : s).trim().toLowerCase();

// 未识别列清单（B2-T5②）：扫描导入文本的 ID 表头行（首格 ID 且含 prompt——防数据行误命中），
//   返回表头原序去重的未知列名；无 ID 表头（非分镜 CSV）→ 空清单。
export function unknownCsvColumns(text) {
  const lines = String(text == null ? "" : text).replace(/^\uFEFF/, "").split(/\r?\n/);
  let header = null;
  for (const line of lines) {
    if (/^ID,/.test(line) && line.includes("prompt")) { header = line; break; }
  }
  if (!header) return [];
  const known = new Set(KNOWN_SHOT_COLUMNS.map(_normCol));
  const out = [];
  for (const raw of _splitCsvLine(header)) {
    const name = raw.trim();
    if (!name || known.has(_normCol(name)) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// 未知列提示文案（空清单 → 空串，调用方不出 toast）
export function unknownColumnsNotice(names) {
  const list = Array.isArray(names)
    ? names.map((n) => String(n == null ? "" : n).trim()).filter(Boolean)
    : [];
  if (list.length === 0) return "";
  return `未识别列：${list.join("·")}（已跳过）`;
}

// rows → segments（GUI 形态；时长/种子做数字宽容；拼接列仅在存在时落 boolean）
export function rowsToSegments(rows, mkSeg) {
  const out = [];
  let i = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || typeof row !== "object") continue;
    const seg = (typeof mkSeg === "function")
      ? mkSeg()
      : { id: "imp-" + Date.now() + "-" + i, prompt: "", durationSec: 5, seed: "", checked: true };
    for (const [rowKey, segKey] of ROW_TO_SEG_KEYS) {
      if (!(rowKey in row)) continue;
      const v = row[rowKey];
      if (segKey === "durationSec") {
        const n = Number(String(v == null ? "" : v).trim());
        if (Number.isFinite(n) && n > 0) seg.durationSec = n;
      } else if (segKey === "prompt") {
        seg.prompt = String(v == null ? "" : v);
      } else {
        seg[segKey] = (v == null) ? "" : String(v);
      }
    }
    if (CONCAT_FLAG_COL in row) seg.concat = String(row[CONCAT_FLAG_COL] || "").trim() === "是";
    out.push(seg);
    i++;
  }
  return out;
}

// 引擎 globals → GUI globalParams patch（同名直映白名单·值域/异名键不自动回填）
const GLOBALS_SAME_NAME_KEYS = ["语言", "配乐", "氛围声", "默认负面", "音乐文件"];
export function engineGlobalsToParams(globals) {
  const patch = {};
  const g = (globals && typeof globals === "object") ? globals : {};
  for (const k of GLOBALS_SAME_NAME_KEYS) {
    if (typeof g[k] === "string" && g[k].trim() !== "") patch[k] = g[k];
  }
  return patch;
}

// ---- 导入编排：CSV 文本 → {segments, globalParamsPatch, 池三形态, 未知列}（引擎权威解析） ----
export async function importCsvText(text, mkSeg) {
  const sv = await saveQueueCsv(text);
  if (!sv.ok) return { ok: false, error: `上传 CSV 失败：${sv.error}` };
  const pr = await parseCsvForImport(sv.path);
  if (!pr.ok) return { ok: false, error: `解析 CSV 失败：${pr.error}` };
  const segments = rowsToSegments(pr.rows, mkSeg);
  if (segments.length === 0) return { ok: false, error: "CSV 中没有可导入的分镜行（rows 为空）" };
  return {
    ok: true,
    segments,
    globalParamsPatch: engineGlobalsToParams(pr.globals),
    // B2-T5：池三形态（键名与提交链 buildFormData 同形·store 透传落点）
    pool: pr.pool,
    pool_usage: pr.pool_usage,
    pool_pose_style: pr.pool_pose_style,
    // B2-T5：未知列清单（表头扫描·引擎只回契约列，未知列由引擎静默丢弃）
    unknownColumns: unknownCsvColumns(text),
    rowCount: segments.length,
  };
}
