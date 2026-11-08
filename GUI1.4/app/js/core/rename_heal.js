// core/rename_heal.js — 引擎改名自愈（R53 域重对齐 P1-c）
//
// 引擎事实（双审实证·方案头部基线）：段重跑恒同目录锚定；改名发生在 POST rerun 成功瞬间、
// 生成之前，作用于该 sid 全部现行 takes，形如 {stem}_old_{NN}.mp4（stem=原名去 .mp4·引擎
// batch_core.py _keep_old 对 stem 先剥离既有 _old_NN 再取首个空位 → NN 单调递增=时间序，
// 最大 NN=最近的原版）。引擎内存账本跟随改名，但 GUI 主轨 file 是自己的——只能 browse 反查。
//
// 契约：
//   - entries=若干 {file} 对象（主轨 clip + 备选条目统一），命中者就地改写 entry.file；
//   - 对每 entry：file 目录===runDir（normFileKey 归一判等）且 basename 在目录里消失、
//     且存在 {stem}_old_NN.mp4 → file 改为 browse 回包 path + "\\" + 该名；
//     原名仍存在 → 不动；不在 runDir → 跳过；
//   - runDir 传空 → 按 entry 自身目录分组（每目录恰一次 browse·调用内去重 B-S2-2）；
//   - browse 失败/抛错 → 该目录条目保留原 file，不抛错（B-S2-3）；
//   - 只写 file——调用方负责落盘，且不得连带动 localPick/ver/review/state。

import { listDirectory } from "./browse.js";
import { normFileKey } from "./filekey.js";

// "D:\a\b\c.mp4" / "D:/a/b/c.mp4" → ["D:\a\b", "c.mp4"]（无分隔符 → ["", 原串]）
function _splitDirBase(p) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// listDir 缺省 = 引擎 browse 端点（{ok, path, files}·path 反斜杠归一形）；测试可注入替身。
export async function healRenamedFiles(entries, runDir, listDir) {
  const list = listDir || listDirectory;
  const arr = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.file === "string" && e.file);
  if (!arr.length) return 0;
  // 分组：runDir 给定 → 只此目录（不在该目录→跳过）；为空 → 按 entry 自身目录（每目录一次 browse）
  const groups = new Map(); // 归一目录键 -> { dir, items: [{entry, base}] }
  if (runDir) {
    const key = normFileKey(runDir);
    const items = [];
    for (const e of arr) {
      const [dir, base] = _splitDirBase(e.file);
      if (normFileKey(dir) === key) items.push({ entry: e, base });
    }
    if (items.length) groups.set(key, { dir: runDir, items });
  } else {
    for (const e of arr) {
      const [dir, base] = _splitDirBase(e.file);
      const key = normFileKey(dir);
      if (!groups.has(key)) groups.set(key, { dir, items: [] });
      groups.get(key).items.push({ entry: e, base });
    }
  }
  let healed = 0;
  for (const g of groups.values()) {
    let r = null;
    try { r = await list(g.dir); } catch (_e) { r = null; }
    const outDir = (r && r.ok && typeof r.path === "string" && r.path) ? r.path : null;
    const files = (r && Array.isArray(r.files)) ? r.files : null;
    if (!outDir || !files) continue; // browse 失败（引擎不可达/返回不 ok）→ 保留原 file（B-S2-3）
    const present = new Set(files);
    for (const it of g.items) {
      if (present.has(it.base)) continue; // 原名仍存在 → 不动
      const m = /^(.*)\.mp4$/i.exec(it.base);
      if (!m) continue;
      const re = new RegExp("^" + _escapeRe(m[1]) + "_old_(\\d+)\\.mp4$");
      let best = null;
      let bestN = -1;
      for (const name of files) {
        const mm = re.exec(name);
        if (mm) {
          const n = parseInt(mm[1], 10);
          if (n > bestN) { bestN = n; best = name; }
        }
      }
      if (best) { // {stem}_old_最大NN（时间序=最近原版）· browse 回包 path 归一 + 反斜杠拼接
        it.entry.file = outDir + "\\" + best;
        healed++;
      }
    }
  }
  return healed;
}
