// core/vocab.js — 词库词表取数（B3-T3 F8 · 引擎 #26 GET /h3_batch/vocab）。
//
// === 出处注记 ===
// 骨架照 legacy/app/js/domain/shots.js:364-396 loadVocab 取数段（缓存一次 + in-flight 复用）；
// 改点 = 失败不置缓存标志（legacy :386-387 失败也置 loaded → {} 粘死，本件不采纳：
// 引擎后起/重启后同一会话点词库仍能重试拿到真词表）。
//
// 契约（api.md:470-473 · 旧信封）：200 裸对象 {"镜头角度":[str...], ...} 九分项，无 ok 字段。
//   core/api normalizeEnvelope 双代归一已备（裸对象=成功态末支），本件按 legacy 骨架直接
//   fetchApi + .json() 解析，不走 request（避免失败态触发全局 toast——断连提示归面板内 UI）。
//
// 失败语义：网络错 / 非 ok / 非对象体 → 返 {} 不抛、不置缓存 → 下次调用真重试。
//
// 批A #13（方案-#13解耦B档-2026-10-16）：读穿缓存 data/vocab-cache.json——
//   在线成功 → 落盘九分项（经 server_storage 适配层·缓存层全钉 data/·宏任务延迟不占返回路径）；
//   引擎失败 → 读缓存九分项返回（词表离线可看）·**不置内存缓存**（恢复在线后同会话真重试引擎）；
//   引擎失败 + 无缓存 → {}（既有语义）。

import { fetchApi } from "./api.js";
import { getKey, putKey } from "./server_storage.js";

export const VOCAB_PATH = "/h3_batch/vocab";
export const VOCAB_CACHE = "data/vocab-cache.json";

let _cache = null;      // 成功才置（九分项对象引用）
let _inflight = null;   // 在途请求 promise（并发复用）

// 缓存体形状守卫：九分项扁平对象（数组/标量/空壳不算）
function _vocabShaped(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function fetchVocab() {
  if (_cache !== null) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await fetchApi(VOCAB_PATH, { cache: "no-store" });
      if (r && r.ok) {
        const j = await r.json();
        // 契约守卫：九分项扁平对象；数组/null/标量 → 视为失败（不缓存·可重试）
        if (_vocabShaped(j)) {
          _cache = j;
          // 批A #13：宏任务延迟落盘（不占返回路径）
          setTimeout(() => { void putKey(VOCAB_CACHE, j).catch(() => { /* 落盘失败静默 */ }); }, 0);
          return j;
        }
        return {};
      }
      return {};   // 引擎可达但报错 → {}（既有语义·不拿陈旧快照冒充引擎真态）
    } catch (_e) {
      // 批A #13：引擎不可达 → 读穿缓存（不置 _cache——恢复在线后同会话真重试）
      const c = await getKey(VOCAB_CACHE).catch(() => null);
      const d = (c && c.ok) ? c.data : null;
      return _vocabShaped(d) ? d : {};
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// 测试辅助：清缓存/在途（测试间隔离用，与 core/api.js _test_setTimeoutMs 同款注入位）
export function _test_resetVocab() {
  _cache = null;
  _inflight = null;
}
