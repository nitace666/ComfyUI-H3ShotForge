// core/templates.js — 模板清单获取 + 族判型（批 2-T2 · 节点 B3）
//
// === 引擎契约（2026-09-28 真机 8190 实测 · curl 留证 .tmp/batch2/t2-probe-*.json） ===
//   GET /h3_batch/templates?dir=<目录>（api.md #14）
//     实测：{"templates": ["<相对路径>", ...]} —— 字符串数组；
//     api.md 旧契约写 [{name, path, ...}] 对象数组，引擎实际不返回（1.0 core 侧同观察·本函数兼容两形态）。
//     缺 dir / 非法 dir → 200 {"templates": []}（非错误响应）。
//   GET /h3_batch/workflow_dir（api.md #43）→ {"dir": "N:\\...\\H3_templates"}（h3_config.json workflow_dir）
//     dir 空时先用它取引擎默认模板目录，再拉 templates。
//
// === API ===
//   classifyTemplateFamily / ALL_TEMPLATE_FAMILIES / DEPRECATED_TEMPLATE_FAMILIES
//     — 自 legacy/app/js/core/template_family.js 迁移（词表与引擎 _declared_mode 同源）
//   fetchTemplateList(dir) → { ok, dir, items: [{name, path}], error }
//     dir 空 → 引擎默认链；items.name = 引擎模板名（相对路径·cbox 显示值），
//     items.path = 绝对路径（选中即写 gui13.paths.workflow_path·与 T1 注入链同键·后写胜出）
//
// ESM 依赖: core/api.js（单向·core 底座不反向 import 上层）

import { request, isEngineUnreachable } from "./api.js";
import { getKey, putKey, readFile } from "./server_storage.js";

// 批A #13（方案-#13解耦B档-2026-10-16）：模板清单读穿缓存 — data/templates-cache.json
//   形态 {byDir:{[baseDir]:{items,savedAt}}, lastDir}（lastDir = 空 dir 走引擎默认链的离线回落位）。
//   在线成功 → 落盘（宏任务延迟·种子读盘防盲覆写他目录键）；引擎不可达 → 按 dir/lastDir 读缓存
//   ok:true+offline:true（离线可看）；引擎可达但报错/缓存未录该 dir → ok:false（不伪造清单）。
export const TEMPLATES_CACHE = "data/templates-cache.json";

// 会话首读盘种子（懒加载一次·失败按空处理——缓存是兜底非真值）
let _seed = null;
function _seedOnce() {
  if (!_seed) {
    _seed = getKey(TEMPLATES_CACHE)
      .then((r) => (r && r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data)) ? r.data : {})
      .catch(() => ({}));
  }
  return _seed;
}

function _writeTemplateCache(dir, items) {
  setTimeout(() => {
    _seedOnce()
      .then(() => {
        const cur = readFile(TEMPLATES_CACHE);   // putKey 每写同步更内存镜像 → 此处恒最新（并发写串行合并）
        const base = (cur && typeof cur === "object" && !Array.isArray(cur)) ? cur : {};
        const byDir = (base.byDir && typeof base.byDir === "object" && !Array.isArray(base.byDir)) ? base.byDir : {};
        const next = { ...base, byDir: { ...byDir, [dir]: { items, savedAt: new Date().toISOString() } }, lastDir: dir };
        return putKey(TEMPLATES_CACHE, next);
      })
      .catch(() => { /* 落盘失败静默——缓存是兜底非真值 */ });
  }, 0);
}

// 离线回落：dir 非空 = 精确按 byDir[dir]（目录错位清单不冒充）；空 dir = lastDir（引擎默认链语义）
async function _offlineFallback(dir) {
  const c = await getKey(TEMPLATES_CACHE).catch(() => null);
  const d = (c && c.ok && c.data && typeof c.data === "object" && !Array.isArray(c.data)) ? c.data : null;
  const byDir = (d && d.byDir && typeof d.byDir === "object" && !Array.isArray(d.byDir)) ? d.byDir : {};
  const key = dir || ((d && typeof d.lastDir === "string") ? d.lastDir : "");
  const hit = key ? byDir[key] : null;
  if (hit && Array.isArray(hit.items)) {
    return { ok: true, dir: key, items: hit.items, offline: true };
  }
  return null;
}

// 四族词表（与引擎 _declared_mode 同源）；fl2v/i2v 引擎 V1.14 已废除（1.3 仅展示标注·不置灰控件）
export const ALL_TEMPLATE_FAMILIES = ["ref2v", "fl2v", "i2v", "t2v"];
export const DEPRECATED_TEMPLATE_FAMILIES = new Set(["fl2v", "i2v"]);

// 判族：h3_<fam>_ 前缀 或 基名 === h3_<fam>.json；兜底末段裸含族名；判不出返 null
export function classifyTemplateFamily(templateRel) {
  if (typeof templateRel !== "string" || !templateRel) return null;
  const base = templateRel.replace(/^.*[\\/]/, "").toLowerCase();
  for (const fam of ALL_TEMPLATE_FAMILIES) {
    if (base.startsWith("h3_" + fam + "_") || base === "h3_" + fam + ".json") return fam;
    if (base.includes(fam)) return fam;
  }
  return null;
}

// 绝对路径判定（盘符 / UNC / 根斜杠起头）
function _isAbsPath(p) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

// 相对路径 + 目录 → 绝对路径（legacy _joinWorkflowPath 同口径：目录分隔符风格决定拼接分隔符·尾分隔去重）
function _joinWorkflowPath(templateRel, dirValue) {
  if (!templateRel || typeof templateRel !== "string") return "";
  if (!dirValue || typeof dirValue !== "string") return "";
  const tpl = templateRel.trim();
  const dir = dirValue.trim();
  if (!tpl || !dir) return "";
  const sep = dir.includes("\\") ? "\\" : "/";
  const dirClean = dir.replace(/[\\/]+$/, "");
  const tplNorm = sep === "\\" ? tpl.replace(/\//g, "\\") : tpl.replace(/\\/g, "/");
  return dirClean + sep + tplNorm;
}

// 引擎条目 → {name, path}（字符串形态为主；api.md 旧契约 {name, path} 对象兼容）
function _normItem(t, dir) {
  let raw = "";
  if (typeof t === "string") raw = t;
  else if (t && typeof t === "object") {
    raw = typeof t.path === "string" && t.path ? t.path : (typeof t.name === "string" ? t.name : "");
  }
  if (!raw) return null;
  const name = (t && typeof t === "object" && typeof t.name === "string" && t.name) ? t.name : raw;
  const path = _isAbsPath(raw) ? raw : _joinWorkflowPath(raw, dir);
  return { name, path };
}

// 模板清单：dir 空 → 先用 workflow_dir 取引擎默认；返回归一 items（ok:false 时不伪造清单）
export async function fetchTemplateList(dir) {
  let base = typeof dir === "string" ? dir.trim() : "";
  if (!base) {
    const rw = await request("/h3_batch/workflow_dir", { cache: "no-store" });
    const d = rw.ok && rw.data && typeof rw.data.dir === "string" ? rw.data.dir.trim() : "";
    if (!d) {
      // 批A #13：引擎不可达（网络错/超时）→ 空 dir 走 lastDir 缓存；可达但报错不回落
      if (isEngineUnreachable(rw.error)) {
        const fb = await _offlineFallback("");
        if (fb) return fb;
      }
      return { ok: false, dir: "", items: [], error: (rw.error && rw.error.msg) || "workflow_dir 未返回 dir" };
    }
    base = d;
  }
  const r = await request("/h3_batch/templates?dir=" + encodeURIComponent(base), { cache: "no-store" });
  if (!r.ok) {
    // 批A #13：引擎不可达 → 按已解析 base 精确回落缓存
    if (isEngineUnreachable(r.error)) {
      const fb = await _offlineFallback(base);
      if (fb) return fb;
    }
    return { ok: false, dir: base, items: [], error: (r.error && r.error.msg) || "templates 读取失败" };
  }
  const arr = r.data && Array.isArray(r.data.templates) ? r.data.templates : null;
  if (!arr) {
    return { ok: false, dir: base, items: [], error: "templates 响应缺少 templates 数组" };
  }
  const items = [];
  for (const t of arr) {
    const it = _normItem(t, base);
    if (it) items.push(it);
  }
  _writeTemplateCache(base, items);   // 批A #13：在线顺手落盘
  return { ok: true, dir: base, items };
}
