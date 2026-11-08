// core/ai_snapshot.js — 项目 ↔ AI 快照互导（B6-T5 A5）。
//
// 契约（引擎 docs/api.md #41/#42 + 8190 真机 curl 实测 2026-09-29）:
//   #41 POST /h3_batch/ai_export body {mode,pool,pool_usage,globals,shots}
//       → {format, schema_version, guide, data}——引擎对 data 键形原样回显（不归一）
//   #42 POST /h3_batch/ai_import {text} → {ok:true, data, warnings[]}
//       | {ok:false, errors[], data:null}——导入侧把行键归一为引擎 CSV 全形（「镜头角度」、
//       「段落时长」字符串「5.0」、补空键），shots→segments 反向映射须双键形兼容
//
// 信封铁律 B-3: exportSnapshot 只透出内层 data（guide 单独带出）；完整信封粘贴给
// #42 会触发 ok:true + 空数据静默回填（legacy ai_collab.js 头注同款）。
//
// 层级注记: fetchSubmitPoolContext 在 views/submit-bar.js（本仓 ESM 路径规约禁止 core
// 反向 import views），由视图层 import 后经 opts.fetchPoolContext 注入（v2-7「复用注入」）。
//
// globals 反解表（v2-11 键清单·自建于此，不改 submit.js）:
//   可逆键集（逐键回填）——比例（裸值↔带后缀形态映射）/质量（裸值直存）/步数（→生成步数）/
//     语言/默认负面/音乐文件（同名直回）/音乐混入方式（替换↔覆盖·混合↔混音）/
//     自动拼接（自动↔true·不拼↔false）/关音乐·关对白·关水印字幕（开↔true·缺键↔false）/
//     提示词（→globalPrompt）/批次次数（→runCount）
//   不可逆键（丢弃+接受注记 IRREVERSIBLE_GLOBAL_KEYS）——审片门（整数无档可回）/
//     配乐·氛围声（「自动」「无」歧义）/放大·插帧·放大引擎（分镜模式不发键·round-trip 丢真值）/
//     模板（无 GUI 宿主键）。丢弃 = 项目现值不动，故快照层 round-trip 仍逐键等价（v2-3 判定层）。

import { request, fetchApi } from "./api.js";
import { buildFormDataFromProject } from "./submit.js";
import { createProject } from "../store/store.js";

// ============================================================================
// 1. projectToSnapshot — 项目 → 五键快照（#41 body 同形）
// ============================================================================

// projectToSnapshot(project, opts?)
//   opts.fetchPoolContext: async ({storage, listAssets}) → {registry, assets}
//     （视图层注入 views/submit-bar.js fetchSubmitPoolContext；缺省空池上下文·离线可导出）
//   opts.storage / opts.listAssets: 透传给 fetchPoolContext（测试注入口）
export async function projectToSnapshot(project, opts = {}) {
  let poolCtx = { registry: {}, assets: {} };
  if (typeof opts.fetchPoolContext === "function") {
    poolCtx = (await opts.fetchPoolContext({ storage: opts.storage, listAssets: opts.listAssets })) || poolCtx;
  }
  const formData = buildFormDataFromProject(project, poolCtx);
  // B6-T6 导出纯净化: buildFormDataFromProject 按引擎契约发「角度」+「镜头角度」双键
  //   （主提交/CSV 链用），快照导出滤掉 GUI 短键「角度」——防 AI 只改其一引入双键不一致。
  //   「与上一片段拼接」此处已是「是」/缺键（引擎值域），原样透传。
  const shots = formData.shots.map((row) => {
    const out = { ...row };
    delete out["角度"];
    return out;
  });
  return {
    mode: formData.mode,
    pool: formData.pool,
    pool_usage: formData.pool_usage,
    globals: formData.globals,
    shots,
  };
}

// ============================================================================
// 2. exportSnapshot / importSnapshot — #41 / #42 网络编排（薄封装·信封走 api 层）
// ============================================================================

export async function exportSnapshot(snapshot) {
  const s = (snapshot && typeof snapshot === "object") ? snapshot : {};
  const body = {
    mode: s.mode != null ? s.mode : "分镜",
    pool: (s.pool && typeof s.pool === "object") ? s.pool : {},
    pool_usage: (s.pool_usage && typeof s.pool_usage === "object") ? s.pool_usage : {},
    globals: (s.globals && typeof s.globals === "object") ? s.globals : {},
    shots: Array.isArray(s.shots) ? s.shots : [],
  };
  const r = await request("/h3_batch/ai_export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const env = r.data || {};
  return {
    ok: true,
    guide: typeof env.guide === "string" ? env.guide : "",
    data: (env.data && typeof env.data === "object") ? env.data : null, // B-3: 只透出内层 data
  };
}

// #42 响应 {ok:false, errors[]} 经 request 新信封分支会归一成 error{code:"unknown"} 且
// errors 明细丢失（normalizeEnvelope 只认 error 字符串）→ 本端点走 fetchApi 直读 JSON。
export async function importSnapshot(text) {
  let resp;
  try {
    resp = await fetchApi("/h3_batch/ai_import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text == null ? "" : text) }),
    });
  } catch (e) {
    return { ok: false, errors: ["网络错误：" + ((e && e.message) ? e.message : String(e))], data: null };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { json = null; }
  if (json && typeof json === "object" && json.ok === true) {
    return {
      ok: true,
      data: (json.data && typeof json.data === "object") ? json.data : null,
      warnings: Array.isArray(json.warnings) ? json.warnings.map((w) => String(w == null ? "" : w)) : [],
    };
  }
  if (json && typeof json === "object" && json.ok === false) {
    return {
      ok: false,
      errors: Array.isArray(json.errors) && json.errors.length
        ? json.errors.map((e) => String(e == null ? "" : e))
        : ["AI 导入失败（引擎未返回错误明细）"],
      data: null,
    };
  }
  return { ok: false, errors: [`AI 导入失败（HTTP ${resp.status}）`], data: null };
}

// ============================================================================
// 3. snapshotToStore — 快照 → store 项目（segments 整体替换 + globals 反解）
// ============================================================================

// 不可逆键接受注记（v2-11）：丢弃=项目现值不动（round-trip 快照层仍等价）
export const IRREVERSIBLE_GLOBAL_KEYS = ["审片门", "配乐", "氛围声", "放大", "插帧", "放大引擎", "模板"];

// 比例裸值 ↔ store 带后缀形态（GUI 档位全集 canvas.js GP_FULL :799）
const RATIO_TO_LABEL = { "9:16": "9:16 竖屏", "16:9": "16:9 横屏", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4" };
// 音乐混入方式反向表（正向=submit.js MUSIC_MIX_MAP 覆盖→替换/混音→混合）
const MUSIC_MIX_REVERSE = { "替换": "覆盖", "混合": "混音" };

// shots 行键 → segment 字段（csv_transfer ROW_TO_SEG_KEYS 反向参照 + 短键直映；
// 「镜头角度」引擎全形与「角度」GUI 短形双兼容——#42 归一/导出回灌两形态）
const SHOT_TO_SEG_KEYS = [
  ["prompt", "prompt"],
  ["段落时长", "durationSec"],
  ["种子", "seed"],
  ["导出文件名", "exportName"],
  ["镜头角度", "角度"],
  ["角度", "角度"],
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

function _genId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

let _segProto = null;
function _newSegment() {
  if (!_segProto) _segProto = createProject("").segments[0];
  return Object.assign({}, _segProto, { id: _genId() });
}

function _shotsToSegments(shots) {
  const out = [];
  for (const row of (Array.isArray(shots) ? shots : [])) {
    if (!row || typeof row !== "object") continue;
    const seg = _newSegment();
    for (const [rowKey, segKey] of SHOT_TO_SEG_KEYS) {
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
    if (CONCAT_FLAG_COL in row) {
      const cv = row[CONCAT_FLAG_COL];
      seg.concat = cv === true || String(cv == null ? "" : cv).trim() === "是";
    }
    out.push(seg);
  }
  return out;
}

// globals 反解（可逆键集逐键回填；文本键空值不回填=宁缺毋滥，csv_transfer 同款）
function _applyGlobalsReverse(g, project) {
  const gp = project.globalParams || (project.globalParams = {});
  const dropped = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
  const str = (k) => String(g[k] == null ? "" : g[k]).trim();
  if (has("比例")) { const v = str("比例"); if (v) gp["比例"] = RATIO_TO_LABEL[v] || v; }
  if (has("质量")) { const v = str("质量"); if (v) gp["质量"] = v; }
  if (has("步数")) { const v = str("步数"); if (v) gp["生成步数"] = v; }
  if (has("语言")) { const v = str("语言"); if (v) gp["语言"] = v; }
  if (has("默认负面")) { const v = str("默认负面"); if (v) gp["默认负面"] = v; }
  if (has("音乐文件")) { const v = str("音乐文件"); if (v) gp["音乐文件"] = v; }
  if (has("音乐混入方式")) { const v = str("音乐混入方式"); if (v) gp["音乐混入"] = MUSIC_MIX_REVERSE[v] || v; }
  if (has("自动拼接")) gp["全部段生成完自动接成一条片"] = str("自动拼接") !== "不拼";
  gp["关音乐"] = has("关音乐") && str("关音乐") === "开";
  gp["关对白"] = has("关对白") && str("关对白") === "开";
  gp["关水印字幕"] = has("关水印字幕") && str("关水印字幕") === "开";
  if (has("提示词")) project.globalPrompt = String(g["提示词"] == null ? "" : g["提示词"]);
  if (has("批次次数")) {
    const n = parseInt(str("批次次数"), 10);
    if (Number.isFinite(n) && n >= 1) project.runCount = Math.min(50, n); // 引擎 main.js String(Math.min(50, rep)) 同上限
  }
  for (const k of IRREVERSIBLE_GLOBAL_KEYS) if (has(k)) dropped.push(k);
  return dropped;
}

// snapshotToStore(snapshot, project) → {ok:true, rows, droppedKeys} | {ok:false, reason}
// 原子性：校验不过（缺 shots / 空 shots / 入参缺失）→ 项目零改动。
export function snapshotToStore(snapshot, project) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "快照缺失" };
  if (!project || typeof project !== "object") return { ok: false, reason: "项目缺失" };
  if (!Array.isArray(snapshot.shots)) return { ok: false, reason: "快照缺 shots" };
  const segments = _shotsToSegments(snapshot.shots);
  if (segments.length === 0) return { ok: false, reason: "快照中没有分镜行" };
  const droppedKeys = (snapshot.globals && typeof snapshot.globals === "object")
    ? _applyGlobalsReverse(snapshot.globals, project)
    : [];
  project.segments = segments;
  project.updatedAt = new Date().toISOString();
  return { ok: true, rows: segments.length, droppedKeys };
}
