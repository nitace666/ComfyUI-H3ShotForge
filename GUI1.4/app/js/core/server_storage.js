// core/server_storage.js — 数据服务侧化存储适配层（批 10-M M-T1·方案 docs/方案-数据服务侧化-2026-10-03.md）
//
// === 定位 ===
//   浏览器零持久（老板口径「浏览器只是窗口 不存东西」）：GUI 持久数据落服务侧 data/，
//   经 devserver 的同源端点 /gui13-data 读写（scripts/devserver.py·M-T1）。
//   本模块是唯一数据出入口——业务模块的读写在 M-T2~T5 逐个收敛到此（不碰业务逻辑）。
//
// === 为什么不复用 core/api.js 的 request ===
//   request() 会给路径拼 BASE_URL（api.js 的 getBase()）——而 dev 态 BASE 可指向引擎 8190
//   （gui13.dev.base）。数据端点在**同源反代 8940** 上，拼 BASE 会打到引擎去（必然 404）。
//   故本模块用同源相对路径直接 fetch，仅沿用 api.js 的信封惯例 {ok, data, error:{code,msg}}。
//
// === API ===
//   DATA_KEYS                 → string[]           已知数据键清单（方案 §二 六文件）
//   projectKey(id)            → string             data/projects/<id>.json
//   loadAll()                 → Promise<{ok,data}> 并发读全部已知键（单键 404 = 缺省·不算失败）
//   getKey(file)              → Promise<{ok,data}> 单键读（404 → ok:true + data:null）
//   putKey(file, value)       → Promise<{ok,error}> 整文件写（写=内存更新 + 异步 PUT）
//   cached()                  → object             内存缓存快照（loadAll 后可同步读·M-T2 boot 用）
//   cacheAll(obj)             → void               整体替换/清空缓存
//
// === 降级口径（方案 §四 验收 4）===
//   网络失败/非 2xx/非法体一律归一 {ok:false, error:{code,msg}}——**不抛**，调用方据 ok
//   决定「只读模式 + 横幅」（横幅与重试提示归 M-T2）。

// #41 文档源可配置（T3）：boot 预取优化文档覆盖层（core→core·prompt_specs 无依赖不成环）
import { prefetchOptimizeDoc } from "./prompt_specs.js";
import { broadcastIndexChanged } from "./sync_bus.js";   // #44 后半 B3：总表行写成功后跨窗口广播（只发不收·无环）
import { t } from "./i18n.js";   // #89 T5a：仅离线横幅文案取词（LT-6·函数体内运行期调用·顶层零调用故与 i18n 的相互 import 无初始化环险）

// 方案 §二 六文件（index 总表由 M-T2 对账时补入本清单）
// M-T1 起即含方案 §二 六文件（index 总表由 M-T2 补入）——M-T5 的 history/user/canvas-draft
// 本就在清单内（此前只有名字未接线），无需再加。
export const DATA_KEYS = [
  "data/index.json",
  "data/assets-meta.json",
  "data/canvas-draft.json",
  "data/settings.json",
  "data/history.json",
  "data/user.json",
];

export const INDEX_KEY = "data/index.json";   // 总表（M-T2）：{rev, projects:[{id,name,updatedAt,deletedAt?,missing?}]}
export const PROJECTS_DIR = "data/projects/";  // 项目族目录（M-T3：目录语义 = 尾斜杠·端点列举用）

// ---- 就绪标志（M-T3）：boot 拉取结果缓存于此·store 写路径据此做只读拦截 ----
//   默认可用（true）：数据服务默认可达，只有 boot 实测拉取失败才置 false（只读降级）。
//   这样任何未跑 boot 的嵌入用法（测试/工具脚本）仍可正常读写，不被误判成只读。
let _ready = true;
export function isReady() { return _ready; }
export function setReady(v) { _ready = !!v; }
const ENDPOINT = "/gui13-data";   // 同源相对（devserver 8940）

export function projectKey(projectId) {
  return `data/projects/${encodeURIComponent(String(projectId || ""))}.json`;
}

// ---- 内存缓存（boot 顶层 await 拉全量后·业务侧可同步读）----
let _cache = {};
export function cached() { return _cache; }
export function cacheAll(obj) { _cache = (obj && typeof obj === "object") ? obj : {}; }

// 缓存世界代数（批6 G1）：只有**存储世界切换**（store.setStorage 复位·resetServerCache）才递增。
//   合并重试链带退避可存活秒级——世界切换后残链的快照/重 PUT/实体补拉会把旧世界数据写进新世界
//   （跨世界污染）。写链入口记代数、每个 await 落点复查，换代即弃写（loadAll/resyncAll 是同世界
//   换血·不换代，不误杀在途重试）。
let _cacheEpoch = 0;
export function resetServerCache() { _cache = {}; _cacheEpoch++; }

function fail(code, msg) { return { ok: false, data: null, error: { code, msg: String(msg || code), detail: null, httpStatus: 0 } }; }

// 单次请求归一：网络异常 / 非 2xx / 非法 JSON 全部折成 {ok,error}（不抛）
async function call(url, init) {
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    return fail("network_error", (e && e.message) || "网络不可达");
  }
  // 兼容两种 fetch 替身形态：真 Response（有 .text）与简化桩（只有 .json·无 .text）
  let text = "";
  try {
    if (typeof resp.text === "function") text = await resp.text();
    else if (typeof resp.json === "function") text = JSON.stringify(await resp.json());
  } catch (_e) { text = ""; }
  // JSON.parse("null")/("123")/("\"str\"") 都是合法 JSON——用 parsed 标志判「是否解析成功」，
  //   不能用 json===null（M-T8 致命单：devserver 曾落出 4 字节 "null" 文件·字面 null 被误判
  //   非法 → loadAll 整体 fail → boot 降级只读。语义与 fetch 的 resp.json() 一致）。
  let json = null;
  let parsed = false;
  try { json = text ? JSON.parse(text) : null; parsed = true; } catch (_e) { parsed = false; }
  if (!resp.ok) {
    return { ok: false, data: null, error: { code: `http_${resp.status}`, msg: (json && json.error) || text || `HTTP ${resp.status}`, detail: null, httpStatus: resp.status } };
  }
  if (!parsed) return fail("bad_response", "响应非 JSON");
  return { ok: true, data: json, error: null };
}

// 取数原语（不写内存缓存）——loadAll 用它：拉取期间不逐键覆写镜像，末尾经守卫+cacheAll 一次换血
//   （批6 G1：若 getKey 内联写缓存，S7b「拉取途中本端写入→晚到旧值回包」会在守卫前毁掉现势镜像）。
//   notFound 标记区分「404 缺键」与「200 字面 null」——getKey 前者不写缓存（既有语义）·后者写。
async function _fetchKey(file) {
  const r = await call(`${ENDPOINT}?path=${encodeURIComponent(file)}`, { method: "GET", cache: "no-store" });
  if (!r.ok) {
    if (r.error.httpStatus === 404) return { ok: true, data: null, error: null, notFound: true };
    return r;
  }
  return { ok: true, data: r.data, error: null };
}

export async function getKey(file) {
  const r = await _fetchKey(file);
  if (!r.ok) return r;
  if (!r.notFound) _cache[file] = r.data;
  return { ok: true, data: _deepCopy(r.data), error: null };   // 交深拷贝：调用方不得就地改缓存
}

// 只更新内存缓存·不触网（只读态/写前置用：服务端不可达时内存也不留幽灵镜像）
//   value 传 undefined = 删该键（purge/真删用·避免留 undefined 键被读路径回落到本地）
// 批6 G1（#33）：覆写 INDEX_KEY 前留存放前镜像行（对象配对防陈旧）——合并重试的意图集取
//   「写前镜像↔新表 diff」用（store.js persistIndexRow/Remove 是先写镜像再 putKey 的形态，
//   putKey 入口时缓存已是新表，写前态只此一处可取；对象配对防跨写串味）。
let _indexPreWrite = null;   // { rows, wrote }
export function cachePut(key, value) {
  if (key === INDEX_KEY) {
    const cur = _cache[key];
    if (cur !== value && cur && typeof cur === "object" && Array.isArray(cur.projects)) {
      _indexPreWrite = { rows: cur.projects, wrote: value };
    }
  }
  if (value === undefined) delete _cache[key];
  else _cache[key] = value;
}

// 项目族列举（防漏对账用）：GET 目录（尾斜杠语义）→ ids 数组；404/网络异常/非法体一律 []
//   best-effort：对账拿不到就按「已知 id 集合」处理，不阻塞 boot。
export async function listProjectIds() {
  const r = await call(`${ENDPOINT}?path=${encodeURIComponent(PROJECTS_DIR)}`, { method: "GET", cache: "no-store" });
  if (!r.ok || !r.data || !Array.isArray(r.data.ids)) return [];
  return r.data.ids.filter((x) => typeof x === "string" && x);
}

// 数据子目录列举（T3 运行快照用）：GET 目录键（尾斜杠）→ {ok, ids}；
//   404 = 目录尚不存在（空态·不算失败）；网络/非法体 → ok:false（调用方自行降级）。
export async function listKeyDir(dir) {
  if (typeof dir !== "string" || !dir.endsWith("/")) {
    return { ok: false, ids: [], error: { code: "bad_dir", msg: "目录键须以 / 结尾", detail: null, httpStatus: 0 } };
  }
  const r = await call(`${ENDPOINT}?path=${encodeURIComponent(dir)}`, { method: "GET", cache: "no-store" });
  if (!r.ok) {
    if (r.error && r.error.httpStatus === 404) return { ok: true, ids: [], error: null };
    return { ok: false, ids: [], error: r.error };
  }
  if (!r.data || !Array.isArray(r.data.ids)) {
    return { ok: false, ids: [], error: { code: "bad_response", msg: "目录响应缺 ids", detail: null, httpStatus: 0 } };
  }
  return { ok: true, ids: r.data.ids.filter((x) => typeof x === "string" && x), error: null };
}

export async function loadAll() {
  const list = await Promise.all(DATA_KEYS.map((k) => _fetchKey(k)));
  const bad = list.find((r) => !r.ok);
  if (bad) return { ok: false, data: {}, error: bad.error };
  const out = {};
  for (let i = 0; i < DATA_KEYS.length; i++) {
    if (list[i].data != null) out[DATA_KEYS[i]] = list[i].data;   // 已交深拷贝（_fetchKey 透传·cacheAll 前不共享引用）
  }
  _indexRevMonotonicGuard(out, _cache[INDEX_KEY]);   // 批6 G1 必修④：晚到旧快照不覆盖本地新镜（S7b·含拉取途中落地写）
  cacheAll(out);
  return { ok: true, data: out, error: null };
}

// S7b 守卫（批6 G1 必修④·方案 v2.1 §三.4）：仅对 INDEX_KEY 单键在 cacheAll 前做 rev 单调校验——
//   服务端快照 rev < 本地镜像 rev（读侧晚到：focus/重拉在途时本端刚写成功）→ 保留本地新镜 + warn，
//   不整表回退（治 S7b「重拉响应晚到抹掉刚写成的行」）。判据 = rev 数值比较（不用时间戳）；
//   不动 cacheAll 通用语义（boot 首装无镜像 / 测试直接注入 cacheAll 均零牵连）。
//   落点在 loadAll：resyncAll / reloadServerIndex 同走此链（N4：后者内部即调 resyncAll·无递归）。
function _indexRevMonotonicGuard(out, prevIndex) {
  const srv = out[INDEX_KEY];
  const loc = prevIndex;
  const srvRev = (srv && typeof srv === "object" && Number.isFinite(+srv.rev)) ? +srv.rev : null;
  const locRev = (loc && typeof loc === "object" && Number.isFinite(+loc.rev)) ? +loc.rev : null;
  if (srvRev != null && locRev != null && srvRev < locRev) {
    out[INDEX_KEY] = loc;   // 保留本地新镜（不整表回退）
    _warn("[server_storage] 总表重拉守卫：服务端快照 rev " + srvRev + " < 本地镜像 rev " + locRev + "（读侧晚到·保留本地新镜防回退）");
  }
}

export async function putKey(file, value, opts = {}) {
  // 写=内存更新 + 异步 PUT（方案 P2-6·无 localStorage 双写）
  //   value=undefined = 删该键（真删通道·与 cachePut 同口径·不留 undefined 残影）
  //   总表键走写前对账链（见下方 T6 段）；其他键行为零变化。
  if (file === INDEX_KEY) return await _putIndexReconciled(file, value, opts);
  cachePut(file, value);
  return await _putRaw(file, value, opts);
}

// 整文件 PUT（一次请求·不做对账·不做重试）
async function _putRaw(file, value, opts = {}) {
  const body = { path: file, value };
  // 批6 G1 #33 CAS（方案 v2.1 §四.3）：index 写带 _base_rev = 写前快照 rev（服务端 ≠ 当前 → 409
  //   {"error":"index_conflict","rev":<当前>}）·快照取不到则不带 = 盲写兼容（E1 契约·仅 index 生效）。
  if (file === INDEX_KEY && opts && Number.isFinite(+opts.baseRev)) body._base_rev = +opts.baseRev;
  const init = {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  // 批 E T10：flush 路径（关页 beforeunload/pagehide/visibilitychange-hidden）传 keepalive:true
  //   ——页面卸载期普通异步 fetch 会被砍掉，实体 2-7KB 远低于 keepalive 64KB 上限·零代价。
  //   opts 缺省 → 键不出现，旧二参调用点零改动兼容。
  if (opts && opts.keepalive) init.keepalive = true;
  const r = await call(ENDPOINT, init);
  return r.ok ? { ok: true, error: null } : r;
}

// ============================================================================
// 批 10-M M-T2：index 总表对账（方案 §三.3「本地两方」）+ boot 数据时序（P3-2）
// ============================================================================

// 表归一：坏/缺 → {rev:1, projects:[]}
function normIndex(obj) {
  const o = (obj && typeof obj === "object") ? obj : {};
  return {
    rev: Number.isFinite(+o.rev) ? +o.rev : 1,
    projects: Array.isArray(o.projects) ? o.projects.filter((p) => p && typeof p.id === "string" && p.id) : [],
  };
}

// 纯函数对账：表行 ↔ 已确认实体存在的 id 集合
//   孤儿（有实体无表行）→ 收编入表（metaOf 可补 name/updatedAt）；缺实体（有表行无实体）→ 行标 missing（**不删**）
//   幂等：重复跑不重复收编、不重复标；表内行序稳定，收编追加尾。
//   T4 地基件（账本 #44/#59）：孤儿候选带 deletedAt（已删实体残留）→ **跳过收编**
//   （不删文件·不写入索引·维持现状静默）——收编会让彻底删除的项目回总表 → 回收站复活。
export function reconcileIndex(indexObj, entityIds, metaOf) {
  const index = normIndex(indexObj);
  const ids = Array.isArray(entityIds) ? entityIds.filter((x) => typeof x === "string" && x) : [];
  const rows = index.projects;
  const inTable = new Set(rows.map((r) => r.id));
  const added = [];
  for (const id of ids) {
    if (inTable.has(id)) continue;
    const meta = (typeof metaOf === "function" ? metaOf(id) : null) || {};
    if (meta.deletedAt) continue;   // 已删实体残留 → 跳过收编（读不到/无标记 → 维持现收编行为）
    rows.push({ id, ...(meta.name ? { name: String(meta.name) } : {}), ...(meta.updatedAt ? { updatedAt: String(meta.updatedAt) } : {}) });
    inTable.add(id);
    added.push(id);
  }
  const present = new Set(ids);
  const missing = [];
  for (const row of rows) {
    const gone = !present.has(row.id);
    if (gone) missing.push(row.id);
    if (gone) row.missing = true;
    else if (row.missing) delete row.missing;   // 实体回来了 → 去标记
  }
  return { index: { rev: index.rev, projects: rows }, added, missing };
}

// 对账 + 落表：entityIds 探测集 = 本客户端已知项目 id（逐个 GET 探实体存在性）
//   ∪ 服务端目录列举（M-T8 缺陷2——B 浏览器 localStorage 为空时，A 端已上载的孤儿实体
//   靠 listProjectIds() 收编，否则 data/index.json 永不生成=跨浏览器收编断链）。
//   列举失败降级为仅 localIds（listProjectIds 自身 best-effort 返回 []·不阻塞 boot）。
//   **已知局限**：端点目录列举已接通；列举失败的极端态下退回本客户端清单（对账降级口径）。
//   T4：探活时已读到实体内容 → 顺带取 deletedAt 交给 reconcileIndex（已删残留跳过收编）。
export async function reconcileAndPersist(data, localIds, metaOf) {
  const first = await _reconcileOnce(data, localIds, metaOf);
  // 对账写吃 409/冲突 → 有界重对账（批6 G1 N1·方案 v2.1 §四.4）：重跑恰一次·不做行合并
  //   （对账本身就是行合并的超集）；再失败维持该轮回报（下次 boot/focus 对账自愈）。
  if (first && first.writeConflict) return await _reconcileOnce(data, localIds, metaOf);
  return first;
}

async function _reconcileOnce(data, localIds, metaOf) {
  const ids = new Set(Array.isArray(localIds) ? localIds : []);
  for (const id of await listProjectIds()) ids.add(id);
  const entityIds = [];
  const ents = new Map();   // id → 实体内容（探活时读到的·取 deletedAt 用）
  for (const id of ids) {
    const r = await getKey(projectKey(id));
    if (r.ok && r.data) { entityIds.push(id); ents.set(id, r.data); }
  }
  const rec = reconcileIndex((data && data[INDEX_KEY]) || cached()[INDEX_KEY], entityIds, (id) => {
    const base = (typeof metaOf === "function" ? metaOf(id) : null) || {};
    const ent = ents.get(id);
    const deletedAt = (ent && typeof ent === "object" && ent.deletedAt) ? String(ent.deletedAt) : "";
    return deletedAt ? { ...base, deletedAt } : base;
  });
  if (rec.added.length || rec.missing.length) {
    // 批6 G1 N1（§四.4）：对账写表 rev = 写前快照 rev+1 且带 _base_rev（治 S1b「内容变 rev 没变」
    //   绕过 CAS）。对账写走 reconcile 模式：冲突不进行合并，由上层有界重对账（重跑恰一次）。
    const baseRev = Number.isFinite(+rec.index.rev) ? +rec.index.rev : 0;
    const r = await putKey(INDEX_KEY, { rev: baseRev + 1, projects: rec.index.projects }, { baseRev, reconcile: true });
    if (r && !r.ok) rec.writeConflict = true;
  }
  return rec;
}

// boot 数据步（index.html 顶层 await 调用）：拉全量 → 对账 → 给出 ready/banner 判定
//   失败一律降级（ready=false + banner=true）——**仍挂载应用**（方案 P3-2：缓存未就绪不挂载）
export async function bootDataStep(opts = {}) {
  const warn = typeof opts.warn === "function" ? opts.warn : (m, e) => { if (typeof console !== "undefined") console.warn(m, e); };
  let r;
  try {
    r = await loadAll();
  } catch (e) {
    setReady(false);
    warn("[gui13] 数据服务拉取异常", e);
    return { ready: false, banner: true, rec: null, error: e };
  }
  if (!r || !r.ok) {
    setReady(false);
    warn("[gui13] 数据服务不可达（只读模式）", r && r.error);
    return { ready: false, banner: true, rec: null, error: (r && r.error) || null };
  }
  setReady(true);
  // M-T6：localStorage 存量一次性迁移（loadAll 成功后·对账前——先上载 legacy 实体，
  //   本轮对账即可把迁入项目收编进总表，总表种子=实体+本地清单并集·含软删）。
  //   任何失败吞掉：banner=true 提示下次重试·**不阻断挂载**（方案 §三.4）。
  //   migrateStorage 仅测试注入用；浏览器走 globalThis.localStorage。
  let migrate = null;
  try {
    migrate = await migrateLegacy({ storage: opts.migrateStorage });
  } catch (e) {
    warn("[gui13] 存量迁移异常（不阻断挂载·下次启动重试）", e);
    migrate = { ok: false, report: null, error: "migration_failed" };
  }
  let rec = null;
  try {
    rec = await reconcileAndPersist(r.data, opts.localIds, opts.metaOf);
  } catch (e) {
    warn("[gui13] 总表对账异常（不阻塞挂载）", e);
  }
  // #41 文档源可配置（T3·boot 预取挂载）：loadAll 完成后按 aiDocs.optimizeDocPath 预取优化文档覆盖层
  //   best-effort fire-and-forget：未配/失败静默回内置（resolveOptimizeSpecLines 兜底）·不阻断挂载。
  try {
    const aiDocs = readAgg(SETTINGS_JSON, "aiDocs");
    void prefetchOptimizeDoc(aiDocs && typeof aiDocs === "object" ? aiDocs.optimizeDocPath : "");
  } catch (_e) { /* 预取失败不阻断 boot */ }
  return { ready: true, banner: !(migrate && migrate.ok), rec, error: null, migrate };
}

// 只读降级横幅（行内样式·不依赖 CSS 文件·真机验证缝 #gui13OfflineBar）
//   msg 可选：M-T6 迁移失败复用同一条横幅位但换文案（服务可达·仅部分存量未上——与只读降级区分）
export function showOfflineBanner(doc, msg) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.createElement !== "function") return null;
  const exist = typeof d.getElementById === "function" ? d.getElementById("gui13OfflineBar") : null;
  if (exist) return exist;
  const bar = d.createElement("div");
  bar.id = "gui13OfflineBar";
  bar.textContent = msg || t("ss.offline.readonly");   // #89 T5a：默认文案入典（LT-6）
  bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:9999;padding:8px 12px;"
    + "background:#7a2f2f;color:#fff;font-size:13px;text-align:center;box-shadow:0 2px 8px #0006";
  if (d.body && typeof d.body.appendChild === "function") d.body.appendChild(bar);
  return bar;
}

// ============================================================================
// 批 10-M M-T4：聚合文件适配（方案 §二「同族多键合一文件」·写侧 9 文件读点统一经此）
//   读 = 纯 server（M-T7 拆除 localStorage 回退——M-T6 迁移已在 boot 保证存量先上载·
//   方案 §三.2「M-T6 收口后改纯 server」）；写 = 内存更新 + 异步 PUT 整文件，**localStorage 停写**。
//   消费方：core/assets_api.js（registry/dormant/trash）、views/assets.js（order/povPending）、
//   views/settings.js（tpl/remind/cfArgs/pref）、ui/sound.js（remind·R1 点名读点）。
// ============================================================================
export const ASSETS_META = "data/assets-meta.json";
export const SETTINGS_JSON = "data/settings.json";
export const HISTORY_JSON = "data/history.json";    // M-T5：submitHistory + optimizeHistory
export const USER_JSON = "data/user.json";          // M-T5：favorites + aiArchive + llm.model（llm.session 留浏览器）
export const CANVAS_DRAFT = "data/canvas-draft.json";  // M-T5：整文件即草稿（无子键·走 readFile/writeFile）

// 聚合文件的子键 ↔ 迁移前 localStorage 键（migrateLegacy 迁移域用·键名逐字对齐方案 §二）
export const AGGREGATES = {
  [ASSETS_META]: {
    registry: "gui13.assets.registry",
    order: "gui13.assets.order",
    dormant: "gui13.assets.dormant",
    trash: "gui13.assets.trash",
    povPending: "gui13.povPending",
  },
  [SETTINGS_JSON]: {
    tpl: "gui13.settings.tpl",
    remind: "gui13.settings.remind",
    cfArgs: "gui13.settings.cfArgs",
    pref: "gui13.settings.pref",
    aiDocs: "gui13.settings.aiDocs",   // #41 文档源可配置（聊天/优化 AI 文档路径·无 localStorage 存量）
  },
  [HISTORY_JSON]: {
    submitHistory: "gui13.submitHistory",
    optimizeHistory: "gui13.optimizeHistory",
  },
  [USER_JSON]: {
    favorites: "gui13.favorites",
    aiArchive: "gui13.aiArchive",
    llmModel: "gui13.llm.model",
  },
};

function _aggFile(file) {
  const v = _cache[file];
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
}

// 读子键：server 缓存有该子键（哪怕是空值）→ 用之；否则 undefined = 无数据
//   M-T7 起纯 server 读：本地不再回落（M-T6 迁移已在 boot 保证存量先上载）。
//   **返回深拷贝**：缓存值是模块级单例，直接把引用交出去会被消费方的「读-改-写」就地改掉
//   （实测：trashRemove 的 splice 会把调用方正在 for-of 遍历的数组元素抽走 → 循环跳元素）。
export function readAgg(file, sub) {
  const f = _aggFile(file);
  if (f && Object.prototype.hasOwnProperty.call(f, sub)) return _deepCopy(f[sub]);
  return undefined;
}

function _deepCopy(v) {
  if (v == null || typeof v !== "object") return v;
  try { return structuredClone(v); } catch (_e) { /* 老环境兜底 */ }
  try { return JSON.parse(JSON.stringify(v)); } catch (_e) { return v; }
}

// 写子键：内存更新 + 异步 PUT 整文件（localStorage 不写）
//   settings.json 走「读-合-写」（T2c·B案收窄档）：本仓唯一绕过 GUI 直写聚合文件的外部写方 =
//   devserver 的 _settings_put_key（workspace_root）——GUI boot 后镜像即陈旧，保存任一 settings
//   子键 → 整文件 PUT 把陈旧镜像写回 → 那把键被抹掉。故 PUT 前先 GET 服务端现值为底：
//     ① 以服务端现值为底合并本次子键（{...serverCur, [sub]: value}）→ 回写镜像 + PUT；
//     ② GET 失败（网络/非 200/非法体）→ 回退镜像为底合并（现行为），**不因 GET 失败阻塞写**。
//   其余聚合文件（assets-meta/user/history）**维持现状**（镜像合并直 PUT·零 GET）：仓内无服务端
//   写方，多开标签页竞态留待 devserver 按子键原子合并协议另立账目——不为无外部写方的文件加往返。
//   返回值与只读拦截仍是同步语义（true/false·调用点 fire-and-forget 零改动）；
//   要「等写落定」的调用方走 saveAggAwait（可等待通道·同语义·Promise<boolean>）；
//   **残留窗**：GET 与 PUT 之间他页写仍可能被覆盖（同 T6 index 对账族·本版不做 settings 级 rev 对账）。
export function writeAgg(file, sub, value) {
  const r = _aggWrite(file, sub, value);
  void r.done;                                   // 落定结果不取（既有调用点 fire-and-forget 语义不变）
  return r.ok;
}

// 批3 T5（账本 #51·档2 GUI 侧）：可等待写通道 saveAggAwait —— writeAgg 的 Promise 化孪生
//   语义同 writeAgg（读-合-写 + 同文件串行 + 只读拒写 + PUT 失败 toast 照旧），
//   差别只在外形：返回 Promise<boolean>（落定=写完成·true=成功 / false=失败或只读拒写）。
//   实现体与 writeAgg 共用（_aggWrite）——不复制逻辑；writeAgg 的同步 boolean 语义零变化。
//   用途：导出登记链（导出弹窗 change 写 export_out_dir → 导出发起前须等它落定·方案 v3 §二）。
export function saveAggAwait(file, sub, value) {
  return _aggWrite(file, sub, value).done;
}

// 聚合子键写（writeAgg / saveAggAwait 共用实现体）
//   返回 { ok, done }：ok = 同步受理结果（writeAgg 的既有 boolean 语义），
//   done = 落定 Promise<boolean>（写完成=true·PUT 失败/只读拒写=false·**永不 reject**）。
function _aggWrite(file, sub, value) {
  const cur = _aggFile(file) || {};
  const next = { ...cur, [sub]: value };
  cachePut(file, next);                          // 同步落镜像：写后 readAgg 立即见新值（现行为）
  if (!isReady()) {
    _warn("[store] 只读模式：数据服务不可达·写操作被拒");
    return { ok: false, done: Promise.resolve(false) };
  }
  if (file === SETTINGS_JSON) {
    let settle = null;
    const done = new Promise((resolve) => { settle = resolve; });
    const run = _aggSerial(file, async () => {
      const server = await _serverAgg(file);      // null = 取不到 → 以调用时的镜像为底
      const merged = { ...(server || cur), [sub]: value };
      cachePut(file, merged);
      const r = await putKey(file, merged);
      if (r && !r.ok) {
        _warn("[store] 聚合文件 PUT 失败", r.error);
        void _putFailToast(t(AGG_PUT_FAIL_TOAST_KEY));   // 不静默丢（改动已留内存供本会话）
        settle(false);
        return;
      }
      settle(true);
    });
    run.catch(() => settle(false));               // 作业异常 → 落定 false（promise 不悬空）
    return { ok: true, done };
  }
  const done = putKey(file, next).then((r) => {
    if (r && !r.ok) {
      _warn("[store] 聚合文件 PUT 失败", r.error);
      void _putFailToast(t(AGG_PUT_FAIL_TOAST_KEY));   // 不静默丢（改动已留内存供本会话）
      return false;
    }
    return true;
  }).catch(() => false);                          // 异常亦落定 false（promise 不悬空）
  return { ok: true, done };
}

// 服务端聚合文件现值（只读探测·**不写内存镜像**——镜像只在合并定稿后回写·失败回退还要用它）
//   null = 取不到（网络/非 200/非法体）→ 调用方以镜像为底；对象 = 服务端现值
async function _serverAgg(file) {
  const r = await call(`${ENDPOINT}?path=${encodeURIComponent(file)}`, { method: "GET", cache: "no-store" });
  if (!r.ok) return null;
  return (r.data && typeof r.data === "object" && !Array.isArray(r.data)) ? r.data : {};
}

// 同文件「读-合-写」串行：连发两次 writeAgg 时后一次读到的服务端现值已含前一次
//   （不串行则两次 GET 同时在途，后一次 PUT 会把前一次的子键抹掉——比改前更糟）
//   返回本环 promise（saveAggAwait 据此判落定·作业异常不外泄）
const _aggChains = new Map();
function _aggSerial(file, job) {
  const run = (_aggChains.get(file) || Promise.resolve()).then(job, job);   // 前环异常不阻断本环
  _aggChains.set(file, run);
  run.catch(() => {}).then(() => { if (_aggChains.get(file) === run) _aggChains.delete(file); });
  return run;
}
function _warn(msg, e) { if (typeof console !== "undefined") console.warn(msg, e); }
function _info(msg, detail) { if (typeof console !== "undefined" && console.info) console.info(msg, detail); }

// 聚合域 PUT 失败 toast（节点门修正笔②·方案 §三.2「不静默丢」在聚合域兑现）
//   文案与 store.js SAVE_ERR_TOAST 同口径（字面锚定——共享常量需 core↔store 跨层 import·方向不洁）；
//   core 不静态依赖 ui（ui/queue.js 头注/submit.js 动态 import 同款惯例）——生产动态 import，
//   toast.js 设计要点「DOM 未就绪 showToast no-op 不抛错」·Node 测试环境安全；
//   测试经 _setPutFailToast 注入断言钩子（store.js _setPresetTransport 同款先例）。
const AGG_PUT_FAIL_TOAST_KEY = "ss.aggPutFail";   // #89 T5b：文案入典（用户可见 toast·T5a LT 桶⑤收口·典键存常量·调用点运行期 t() 取词防互引环）
let _putFailToastOverride = null;
export function _setPutFailToast(fn) { _putFailToastOverride = fn; }
async function _putFailToast(msg) {
  if (_putFailToastOverride) { _putFailToastOverride(msg); return; }
  try {
    const { showToast } = await import("../ui/toast.js");
    showToast("error", msg);
  } catch (_e) { /* 加载异常静默——_warn 已留痕 */ }
}

// ===== 整文件读写（无子键的文件·当前仅画布草稿）=====
// 整份即值的文件 → 迁移前 localStorage 键的对应（migrateLegacy 草稿域用）
const DOC_LOCAL_KEY = { [CANVAS_DRAFT]: "gui13.canvas.draft" };
// 读：server 缓存有该文件 → 用之（深拷贝）；否则 null = 无数据（M-T7 起纯 server 读·本地不回落）
export function readFile(file) {
  const v = _cache[file];
  if (v !== undefined) return v == null ? null : _deepCopy(v);
  return null;
}
// 写：value=null 表示清该文件（删缓存键 + PUT value:null → devserver **删文件**并回 {ok,deleted:true}
//   ·M-T8 致命单：不得把字面 null 写成 4 字节文件——那会反噬读侧与 loadAll）；只读态拒写
export function writeFile(file, value, storage) {
  if (value === null || value === undefined) delete _cache[file];
  else cachePut(file, value);
  if (!isReady()) {
    _warn("[store] 只读模式：数据服务不可达·写操作被拒");
    return false;
  }
  void putKey(file, value === undefined ? null : value).then((r) => {
    if (r && !r.ok) _warn("[store] 整文件 PUT 失败", r.error);
  });
  return true;
}

// ============================================================================
// 批 10-M M-T6：一次性迁移（localStorage 存量 → data/ 六文件·方案 §三.4 + R2 冲突策略）
//   幂等 = 键级 `<localKey>.migrated` 标记（命中即跳·半迁移可续跑）；原键保留只读（回滚保险）。
//   冲突（R2 逐类）：项目同 id 比 updatedAt 取新；对象类按键合并且同键保 server（迁移后事实源）；
//   数组类按 id 去重合并（无 id 条目按 JSON 全等）；标量（cfArgs/llm.model）server 已有即保 server；
//   画布草稿 data/ 已存在即跳过（单份语义）。
//   任何失败都被吞进返回值（ok:false + error）——**不抛**，boot 据此挂横幅·不阻断挂载。
// ============================================================================
const MIGRATED_SUFFIX = ".migrated";

// 迁移类别：object=对象类键级合并 · array=数组类按 id 合并 · arrayPlain=无 id 数组（JSON 全等）· scalar=标量
const LEGACY_SUB_KEYS = {
  [ASSETS_META]: { registry: "object", order: "arrayPlain", dormant: "object", trash: "array", povPending: "object" },
  [SETTINGS_JSON]: { tpl: "object", remind: "object", cfArgs: "scalar", pref: "object" },
  [HISTORY_JSON]: { submitHistory: "array", optimizeHistory: "array" },
  [USER_JSON]: { favorites: "array", aiArchive: "array", llmModel: "scalar" },
};
const LEGACY_PROJECT_PREFIX = "gui13.project.";
const LEGACY_PROJECT_INDEX = "gui13.project.index";

const LEGACY_SUB_NAMES = new Set(Object.values(AGGREGATES).flatMap((m) => Object.values(m)));
// 判别「该键属迁移域」（非「已迁」）：聚合子键 ∪ gui13.project.<id>（index 总表键除外·不作实体迁）
export function isMigratedKey(localKey) {
  if (typeof localKey !== "string" || localKey === LEGACY_PROJECT_INDEX) return false;
  if (LEGACY_SUB_NAMES.has(localKey)) return true;                                  // 聚合子键
  return localKey.startsWith(LEGACY_PROJECT_PREFIX) && localKey.length > LEGACY_PROJECT_PREFIX.length;
}

// 合并纯函数（单测直接覆盖）
export function mergeObjectShallow(serverObj, localObj) {
  const out = { ...(serverObj && typeof serverObj === "object" && !Array.isArray(serverObj) ? serverObj : {}) };
  const loc = (localObj && typeof localObj === "object" && !Array.isArray(localObj)) ? localObj : {};
  for (const k of Object.keys(loc)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = loc[k];
  return out;
}
export function mergeArrayById(serverArr, localArr) {
  const out = Array.isArray(serverArr) ? serverArr.slice() : [];
  const seen = new Set(out.map((e) => (e && typeof e === "object" && e.id != null) ? "id:" + e.id : "json:" + JSON.stringify(e)));
  for (const e of (Array.isArray(localArr) ? localArr : [])) {
    const key = (e && typeof e === "object" && e.id != null) ? "id:" + e.id : "json:" + JSON.stringify(e);
    if (seen.has(key)) continue;   // 同 id / 同 JSON → 保 server 那条
    seen.add(key);
    out.push(e);
  }
  return out;
}

function _safeParse(raw) {
  if (raw == null) return undefined;
  try { return JSON.parse(raw); } catch (_e) { return undefined; }
}
// 标量键读：历史格式是**原始字符串**（settings.js「cfArgs 存原始字符串·非 JSON 对象」、
//   ai-archive _restoreModel 裸串兜底）——JSON.parse 失败≠无存量，裸串原样取
function _readScalar(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null) return undefined;
  try { return JSON.parse(raw); } catch (_e) { return raw; }
}
function _mergeBy(kind, serverVal, localVal) {
  if (localVal === undefined) return { value: serverVal, changed: false };
  if (serverVal === undefined || serverVal === null) return { value: localVal, changed: true };
  if (kind === "object") return { value: mergeObjectShallow(serverVal, localVal), changed: true };
  if (kind === "array") return { value: mergeArrayById(serverVal, localVal), changed: true };
  if (kind === "arrayPlain") {
    const seen = new Set((Array.isArray(serverVal) ? serverVal : []).map((x) => JSON.stringify(x)));
    const add = (Array.isArray(localVal) ? localVal : []).filter((x) => !seen.has(JSON.stringify(x)));
    return { value: (Array.isArray(serverVal) ? serverVal : []).concat(add), changed: add.length > 0 };
  }
  return { value: serverVal, changed: false };   // scalar：server 已有即保 server
}

function _markMigrated(storage, localKey) { try { storage.setItem(localKey + MIGRATED_SUFFIX, "1"); } catch (_e) { /* 隐私模式 */ } }
function _isMigrated(storage, localKey) {
  try { return storage.getItem(localKey + MIGRATED_SUFFIX) != null; } catch (_e) { return false; }
}

// 迁移主流程（返回 {ok, report, error?}·不抛）
export async function migrateLegacy(opts = {}) {
  const storage = opts.storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);
  const report = { projects: 0, items: 0, conflicts: 0, skippedDraft: false, failed: [] };
  if (!storage || typeof storage.getItem !== "function") return { ok: true, report, skipped: true };
  try {
    // ① 项目实体族（index 键只作 id 清单·不作实体迁；软删 deletedAt 随实体上载）
    //   M-T7 防漏收口：id 清单 = index ∪ localStorage 键扫描（gui13.project.<id> 前缀键·
    //   剔除 index 自身与 .migrated 标记键）——index 缺失的散落实体（历史半写入）不漏迁。
    let ids = [];
    try { ids = _safeParse(storage.getItem(LEGACY_PROJECT_INDEX)) || []; } catch (_e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    ids = ids.filter((x) => typeof x === "string" && x);
    const seenIds = new Set(ids);
    try {
      const n = typeof storage.length === "number" ? storage.length : 0;
      for (let i = 0; i < n; i++) {
        const k = storage.key(i);
        if (typeof k !== "string" || !k.startsWith(LEGACY_PROJECT_PREFIX)) continue;
        if (k === LEGACY_PROJECT_INDEX || k.endsWith(MIGRATED_SUFFIX)) continue;
        const id = k.slice(LEGACY_PROJECT_PREFIX.length);
        if (id && !seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
    } catch (_e) { /* 桩无 length/key → 按 index 清单处理（不阻断迁移） */ }
    for (const id of ids) {
      const localKey = LEGACY_PROJECT_PREFIX + id;
      if (!isMigratedKey(localKey) || _isMigrated(storage, localKey)) continue;
      const local = _safeParse(storage.getItem(localKey));
      if (!local || typeof local !== "object") continue;
      const key = projectKey(id);
      const cur = _cache[key];          // boot 的 loadAll 已拉全量·冲突比对直接看缓存（免重复请求）
      if (cur && typeof cur === "object") {
        // 冲突：同 id 比 updatedAt 取新；取新上载计 projects，「冲突跳过」只数保 server 的跳过
        if (String(local.updatedAt || "") > String(cur.updatedAt || "")) {
          const up = await putKey(key, local);
          if (up.ok) { report.projects++; _markMigrated(storage, localKey); }
          else report.failed.push(key);
        } else {
          report.conflicts++;           // server 较新（或无时间戳）→ 保 server·跳过
          _markMigrated(storage, localKey);
        }
        continue;
      }
      const up = await putKey(key, local);
      if (up.ok) { report.projects++; _markMigrated(storage, localKey); }
      else report.failed.push(key);
    }
    // ② 聚合子键族（逐子键 merge·整文件一次 PUT；标记押后到 PUT 成功——失败键下次启动真重试）
    for (const [file, subs] of Object.entries(LEGACY_SUB_KEYS)) {
      const localKeyMap = AGGREGATES[file] || {};
      const cur = _cache[file];
      const next = (cur && typeof cur === "object" && !Array.isArray(cur)) ? { ...cur } : {};
      let changed = false;
      const pendingMarks = [];   // 已 merge 进 next 的子键·待 PUT 成功后统一落标记
      for (const [sub, kind] of Object.entries(subs)) {
        const localKey = localKeyMap[sub];
        if (!localKey || _isMigrated(storage, localKey)) continue;
        const localVal = (kind === "scalar") ? _readScalar(storage, localKey) : _safeParse(storage.getItem(localKey));
        // 无存量：不打终态标记（M-T8 缺陷1——「先空后有」时序：空 boot 打了标记会让之后
        //   恢复/回填的存量永不上载；每轮重扫 16 键只花毫秒级·换来时序鲁棒）
        if (localVal === undefined) continue;
        const merged = _mergeBy(kind, next[sub], localVal);
        if (merged.changed) {
          next[sub] = merged.value; changed = true;
          pendingMarks.push(localKey);
        } else {
          if (sub in next) report.conflicts++;   // server 已有且不合并（scalar/全等）→ 计冲突跳过
          _markMigrated(storage, localKey);      // 值已在 server·不押注网络
        }
        report.items++;
      }
      if (changed) {
        cachePut(file, next);
        const up = await putKey(file, next);
        if (up.ok) for (const k of pendingMarks) _markMigrated(storage, k);
        else report.failed.push(file);
      }
    }
    // ③ 画布草稿（单份语义：data/ 已有即跳过+报告；PUT 失败不打标记→下次重试）
    const draftKey = DOC_LOCAL_KEY[CANVAS_DRAFT];
    if (draftKey && !_isMigrated(storage, draftKey)) {
      const localDraft = _safeParse(storage.getItem(draftKey));
      const serverDraft = _cache[CANVAS_DRAFT];
      if (serverDraft) {
        report.skippedDraft = true;
        _markMigrated(storage, draftKey);
      } else if (localDraft && typeof localDraft === "object") {
        const up = await putKey(CANVAS_DRAFT, localDraft);
        if (up.ok) { report.items++; _markMigrated(storage, draftKey); }
        else report.failed.push(CANVAS_DRAFT);
      }
      // 无存量/坏值：不打终态标记（M-T8 缺陷1 同口径——「先空后有」时序鲁棒·下轮重扫）
    }
  } catch (e) {
    _warn("[store] 迁移异常（不阻断挂载·下次启动重试）", e);
    return { ok: false, report, error: (e && e.code) || "migration_failed" };
  }
  // 明细动账（toast 之外的 console 侧查账口）：有实际动作（上载/冲突/跳草稿）才打
  if (report.projects + report.items + report.conflicts > 0 || report.skippedDraft) {
    _info("[store] 迁移完成：", { projects: report.projects, items: report.items, conflicts: report.conflicts, skippedDraft: report.skippedDraft, failed: report.failed });
  }
  if (report.failed.length) {
    _warn("[store] 迁移部分失败（已迁键不重复·下次启动续跑）", report.failed);
    return { ok: false, report, error: "migration_partial" };
  }
  return { ok: true, report };
}

// 迁移完成 toast 文案（任务单逐字口径）：零上载返回 null（幂等轮空/纯跳过不弹·免每次启动打扰）
export function migrateToastText(report) {
  const r = (report && typeof report === "object") ? report : {};
  const p = Number(r.projects) || 0;
  const m = Number(r.items) || 0;
  const k = Number(r.conflicts) || 0;
  if (p + m <= 0) return null;
  return `数据已迁移到服务端（${p} 项目/${m} 项·冲突跳过 ${k}）`;
}

// ============================================================================
// 地基批1档2 T6（账本 #59-③件 + 验收7 UI 面）：index 写前对账——批6 G1 #33 改版
//   根链：多开页面各持全量内存镜像 → 他页先写总表时，本页按旧基线写回会覆盖他页行（T9 族根）。
//   对账口径（仅 data/index.json 走此链·其他键零变化·方案 docs/方案-索引并发修复-2026-10-29 v2.1）：
//     ① 写前 GET 服务端 index 现值 → 服务端 rev > 本地基线 rev（他页已写）→ 不再弃写：
//        进**合并重试**（§四.1——own 行本端赢/非 own 行服务端赢/rev=srv.rev+1 重 PUT·
//        上限 3 次+退避 300/900ms→终败弃写+人话回报·文案分档归 store.js §三.1）；
//     ② 服务端 rev ≤ 基线 → 照发 PUT（体形态按现状·另带 CAS _base_rev=快照 rev·§四.3·
//        服务端 ≠当前 → 真 409 → 折码识别后与合成冲突同路入合并重试）；
//     ③ PUT 失败 → 同入合并重试；成功（含合并重试成功）走 B3 既有广播恰一次 + 实体补拉（必修③）。
//   仅 data/index.json 走此链；其他键零变化（单次 PUT·行为不变）。
// ============================================================================

// 跨模块事件名（server_storage 派发 · projects.js 监听）
export const INDEX_CONFLICT_EVENT = "gui13:index-conflict";

// 本地基线 rev = 内存镜像中当前 index.rev。
//   store.js persistIndexRow/Remove 是「先 serverCachePut(新值) → 再 putKey(同一对象)」，
//   故进入 putKey 时镜像里已是**新值**（rev = 基线+1）——按对象同一性认出该形态并回退一格，
//   取到本次写真正依据的基线；否则他页刚写过（服务端 rev = 基线+1）这条最常见冲突会被漏判
//   （服务端 rev 不 > 基线+1）→ 本页写回覆盖他页行。
function _indexBaselineRev(value) {
  const cur = _cache[INDEX_KEY];
  if (cur && typeof cur === "object" && Number.isFinite(+cur.rev)) {
    if (cur === value) {
      // 契约（批6 G1 必修⑤·钉死）：rev-1 分支**仅**认「store 先写自镜像」形态——调用方先把新表
      //   写进镜像（cachePut(新表)）再把**同一对象**传进 putKey（persistIndexRow/Remove 唯一此形态）。
      //   对象同一性是唯一判据：传新对象（reconcileAndPersist 直写/测试直调）不得走此分支。
      const vRev = Number.isFinite(+value.rev) ? +value.rev : 0;
      return Math.max(0, vRev - 1);
    }
    // 防御断言（批6 G1 必修⑤）：此分支的正确前提 = 缓存仍持有**写前镜像**（reconcile 直写新对象
    //   的正常形态）。若调用方已把另一对象抢先写进镜像（误用·镜像 rev 不再是本次写依据的基线），
    //   此处留 warn 供现场排查——不抛（写路径不因诊断中断），基线仍取缓存 rev。
    if (typeof console !== "undefined" && console.warn && Number.isFinite(+value.rev) && +cur.rev >= +value.rev) {
      _warn("[server_storage] _indexBaselineRev 新对象分支防御：缓存 rev " + (+cur.rev) + " ≥ 写入 rev " + (+value.rev) + "（镜像可能已被抢先推进·基线取缓存 rev）");
    }
    return +cur.rev;
  }
  return 0;   // 镜像无总表（首写/未 boot）→ 基线 0（服务端有总表即判冲突·保守不覆盖）
}

// 写前镜像行（合并重试意图集的「本端写前态」·批6 G1 §四.1）：
//   store 先写自镜像形态（缓存已是新表）→ 取 cachePut 覆写时配对留存的写前行；
//   直写形态（缓存仍是旧镜像）→ 取缓存现行行。
function _preWriteMirrorRows(value) {
  const cur = _cache[INDEX_KEY];
  if (cur === value) {
    return (_indexPreWrite && _indexPreWrite.wrote === value && Array.isArray(_indexPreWrite.rows)) ? _indexPreWrite.rows : [];
  }
  return (cur && typeof cur === "object" && Array.isArray(cur.projects)) ? cur.projects : [];
}

const _indexRowsOf = (v) => (v && Array.isArray(v.projects)) ? v.projects : [];

// 服务端总表快照（只读探测·不写内存镜像——镜像只放「本地确认态」）
//   null = 取不到（网络/异常）→ 未知 → 不判冲突（照发 PUT·失败走重试与横幅）；404 → rev 0 空表。
//   rows 随 rev 一并回传：#44 后半 B3 写成功后按「服务端写前快照 ↔ 写入新表」diff 出变更行广播。
async function _serverIndexSnapshot() {
  const r = await call(`${ENDPOINT}?path=${encodeURIComponent(INDEX_KEY)}`, { method: "GET", cache: "no-store" });
  if (!r.ok) {
    if (r.error && r.error.httpStatus === 404) return { rev: 0, rows: [] };   // 服务端无总表 → rev 0 空表
    return null;                                                              // 取不到 → 未知
  }
  const d = r.data;
  return {
    rev: (d && typeof d === "object" && Number.isFinite(+d.rev)) ? +d.rev : 0,
    rows: (d && Array.isArray(d.projects)) ? d.projects : [],
  };
}

// 总表行 diff（服务端写前快照 ↔ 本次写入新表）→ [{id, action}]·action: create|save|remove
//   行内容比对 = 总表行全部业务字段（name/updatedAt/deletedAt/missing）。
function _diffIndexRows(prevRows, nextRows) {
  const sig = (r) => JSON.stringify([r.name, r.updatedAt, r.deletedAt, r.missing]);
  const prev = new Map();
  for (const r of (Array.isArray(prevRows) ? prevRows : [])) {
    if (r && typeof r.id === "string" && r.id) prev.set(r.id, r);
  }
  const out = [];
  for (const row of (Array.isArray(nextRows) ? nextRows : [])) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const p = prev.get(row.id);
    if (!p) { out.push({ id: row.id, action: "create" }); continue; }
    prev.delete(row.id);
    if (sig(p) !== sig(row)) out.push({ id: row.id, action: "save" });
  }
  for (const id of prev.keys()) out.push({ id, action: "remove" });
  return out;
}

// 写成功后按 diff 广播 index-changed（每变更行一条·载荷=项目 id+动作）
//   prevRows=null（写前快照取不到）→ 不猜不广播（focus 对账兜底）。
function _notifyIndexChanged(prevRows, value) {
  if (!Array.isArray(prevRows)) return;
  for (const ch of _diffIndexRows(prevRows, (value && Array.isArray(value.projects)) ? value.projects : [])) {
    broadcastIndexChanged(ch.id, ch.action);
  }
}

// 总表写（写前对账 + 合并重试 + CAS·批6 G1 #33 方案 v2.1 §四.1/§四.3）
async function _putIndexReconciled(file, value, opts = {}) {
  const epoch0 = _cacheEpoch;              // 世界代数（残链防跨世界·见 resetServerCache 注）
  const base = _indexBaselineRev(value);   // 取基线须在 cachePut 之前
  // 本端意图集（§四.1）：写前镜像↔新表 diff 三腿（add/change/remove·复用 _diffIndexRows）
  //   ——冲突/失败重组时 own 行（意图涉及的项目 id）本端赢·非 own 行服务端赢。
  const ownIds = _diffIndexRows(_preWriteMirrorRows(value), _indexRowsOf(value)).map((l) => l.id);
  cachePut(file, value);
  // ① 写前对账（快照 rows 留作写成功后的 diff 广播基线）
  const srv = await _serverIndexSnapshot();
  // 快照 await 落点复查（批9 G4c）：期间存储世界切换 → 本链随旧世界作废。
  //   返回 null（非失败信封）：调用方链 `r && !r.ok` 守卫天然静默——不误弹失败 toast、不误报成功。
  if (_cacheEpoch !== epoch0) return null;
  if (srv != null && srv.rev > base) {
    // 对账写（§四.4）：冲突不合并——即时返回，由调用方有界重对账（重跑恰一次）
    if (opts.reconcile) {
      _dispatchIndexConflict();
      return { ok: false, conflict: true, error: { code: "index_conflict", msg: "对账写冲突（服务端 rev " + srv.rev + "）·交有界重对账", detail: null, httpStatus: 0 } };
    }
    return await _indexMergeRetry(file, value, ownIds, srv, opts, null, epoch0);
  }
  // ② 照发 PUT（带 CAS _base_rev=写前快照 rev·§四.3；快照取不到 → 盲写兼容）
  let r = await _putRaw(file, value, _casOpts(srv, opts));
  if (r.ok) { _notifyIndexChanged(srv && srv.rows, value); return { ok: true, error: null }; }
  // ③ 失败/409 → 统一入合并重试（§四.1/§四.3 同路）；对账写例外（§四.4 有界重对账）
  if (opts.reconcile) {
    return { ok: false, conflict: _isIndexConflict409(r), error: r.error };
  }
  return await _indexMergeRetry(file, value, ownIds, null, opts, r, epoch0);
}

// CAS 选项：快照已知 → _base_rev=快照 rev；未知 → 不带（盲写兼容·不错误 CAS）
function _casOpts(srv, opts) {
  return (srv != null) ? { ...opts, baseRev: srv.rev } : opts;
}

// 409 识别（§四.3·复核执行期注意项）：call() 把非 2xx 折成 code:"http_409" + msg=响应体 error 字段
//   ——服务端 409 体 {"error":"index_conflict","rev":N} 折后 msg 恰含 "index_conflict"。判据=msg 字符串匹配。
function _isIndexConflict409(r) {
  return !!(r && r.error && r.error.code === "http_409" && String(r.error.msg).includes("index_conflict"));
}

// 合并重试（§四.1）：冲突/失败 → 服务端现值 + 本端意图重组 → rev=srv.rev+1 重 PUT·上限 3 次+
//   退避（默认 300/900/900ms·测试钩子可压 0）→ 终败弃写如实回报（conflict/code·文案分档归 store.js）。
//   重试成功走 B3 既有广播恰一次（_notifyIndexChanged·prevRows=成功 PUT 前的服务端快照行）；
//   并接实体补拉（必修③·reloadServerIndex 含 450ms 在途宽容——合并进来的他窗行实体补齐可见）。
//   opts.reconcile=true（对账写·§四.4）→ 不做行合并：失败即返回，由调用方有界重对账（重跑恰一次）。
const INDEX_PUT_RETRIES = 3;                        // 重 PUT 上限 3 次（§四.1 有界）
const INDEX_RETRY_BACKOFF_MS = [300, 900, 900];     // 重 PUT 前退避（§四.1 300/900 档·末次沿用 900）
let _retryBackoffOverride = null;                   // 测试注入口（生产零调用）
export function _setIndexRetryBackoffForTest(arr) { _retryBackoffOverride = Array.isArray(arr) ? arr : null; }
function _backoffMs(attempt) {
  const t = _retryBackoffOverride || INDEX_RETRY_BACKOFF_MS;
  return t[Math.min(attempt, t.length - 1)] || 0;
}

async function _indexMergeRetry(file, value, ownIds, srvKnown, opts, firstErr, epoch0) {
  let srv = srvKnown;                       // null = 服务端现值未知
  let sawConflict = srvKnown != null;       // 带快照进入 = 写前对账判冲突
  let lastErr = firstErr;
  if (sawConflict) _dispatchIndexConflict();
  const stale = () => _cacheEpoch !== epoch0;   // 存储世界已切换 → 本链作废（残链不得跨世界落笔）
  for (let attempt = 0; attempt < INDEX_PUT_RETRIES; attempt++) {
    if (stale()) return { ok: false, conflict: sawConflict, error: (lastErr && lastErr.error) || { code: "network_error", msg: "网络不可达", detail: null, httpStatus: 0 } };
    const backoff = _backoffMs(attempt);
    if (backoff > 0) await new Promise((resolve) => setTimeout(resolve, backoff));
    if (srv == null) {
      srv = await _serverIndexSnapshot();
      if (stale()) return { ok: false, conflict: sawConflict, error: (lastErr && lastErr.error) || { code: "network_error", msg: "网络不可达", detail: null, httpStatus: 0 } };
      if (srv == null) {
        if (sawConflict) continue;          // 冲突已知但拿不到服务端行 → 不盲写（防整表覆盖 M2）·耗退避再试
        const blind = await _putRaw(file, value, opts);   // 非冲突失败+快照不可得 → 循旧例盲重发
        if (blind.ok) { _notifyIndexChanged(null, value); return { ok: true, error: null }; }
        lastErr = blind;
        continue;
      }
    }
    // 重组（§四.1）：own 行本端赢（含 deletedAt 置与清）·非 own 行服务端赢·remove 腿=行不放（不复活）
    const merged = { rev: srv.rev + 1, projects: _mergeIndexRows(srv.rows, ownIds, _indexRowsOf(value)) };
    cachePut(file, merged);                 // 镜像跟进重组结果（后续写取到新基线）
    const r = await _putRaw(file, merged, { ...opts, baseRev: srv.rev });
    if (r.ok) {
      _notifyIndexChanged(srv.rows, merged);   // B3 广播恰一次（prevRows=成功 PUT 前快照）
      if (!stale()) await _reloadAfterMerge(); // 实体补拉（他窗行可见·必修③）——换代后不跨世界补拉
      return { ok: true, error: null, merged: true };
    }
    lastErr = r;
    sawConflict = sawConflict || _isIndexConflict409(r);
    if (_isIndexConflict409(r)) _dispatchIndexConflict();
    srv = null;                             // 下一轮重取快照
  }
  // 终败：弃写（不发更多请求）+ 如实回报。镜像保留本端改动（循旧口径不回滚：新建项目不当场
  //   从列表消失；刷新后 boot 对账收编实体自愈）。冲突族/其他族的文案分档归 store.js（§三.1）。
  const err = (sawConflict)
    ? { code: "index_conflict", msg: t("ss.indexConflict", { n: INDEX_PUT_RETRIES }), detail: null, httpStatus: (lastErr && lastErr.error && lastErr.error.httpStatus) || 0 }   // #89 T5b：同步冲突文案入典（用户可见 toast·T5a LT 桶⑤收口）
    : ((lastErr && lastErr.error) || { code: "network_error", msg: "网络不可达", detail: null, httpStatus: 0 });
  return { ok: false, conflict: sawConflict, error: err };
}

// 合并重试成功后的实体补拉（必修③）：合并进来的他窗行在本窗无实体 → 不补拉则列表看不到。
//   fire-and-forget（不阻写返回）·reloadServerIndex 内部即 resyncAll+450ms 在途宽容（N4 无递归）。
async function _reloadAfterMerge() {
  try { await reloadServerIndex(); } catch (_e) { /* 补拉失败不追伤写结果·focus/下次对账自愈 */ }
}

// 重组（§四.1 钉死）：服务端行为底·非 own 才保留；own 行按本端新表放（remove 腿=该 id 不出现）；
//   新表里的非 own 行是陈旧镜像产物 → 丢弃（服务端赢）。
function _mergeIndexRows(srvRows, ownIds, newRows) {
  const own = new Set(ownIds);
  const newRowById = new Map();
  for (const row of (Array.isArray(newRows) ? newRows : [])) {
    if (row && typeof row.id === "string" && row.id && !newRowById.has(row.id)) newRowById.set(row.id, row);
  }
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(srvRows) ? srvRows : [])) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (own.has(row.id)) continue;                       // own 行由本端新表表态（remove 腿=不放）
    out.push(row); seen.add(row.id);
  }
  for (const row of newRowById.values()) {
    if (!own.has(row.id) || seen.has(row.id)) continue;  // 非 own 行服务端赢（陈旧镜像行丢弃）
    out.push(row); seen.add(row.id);
  }
  return out;
}

function _dispatchIndexConflict() {
  if (typeof document === "undefined" || !document || typeof document.dispatchEvent !== "function") return;
  try { document.dispatchEvent(new CustomEvent(INDEX_CONFLICT_EVENT)); }
  catch (_e) { /* 无 CustomEvent 环境·静默跳过（不影响写路径结果） */ }
}

// 全量重拉（重连 / 冲突后把服务端现值取回内存·UI 随之刷新）
//   六固定文件走 loadAll 同源通道；再按总表行补拉项目实体——项目列表读的是实体镜像，
//   不补拉则他页新建项目「有表行无实体」→ 列表读不到 = 刷新落空。
//   **不触碰墓碑**（墓碑集在 store.js·本模块天然不清）、**不动 store 内部**。
export async function resyncAll() {
  let r;
  try {
    r = await loadAll();
  } catch (e) {
    return { ok: false, error: { code: "network_error", msg: String((e && e.message) || e), detail: null, httpStatus: 0 } };
  }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || null };
  const idx = _cache[INDEX_KEY];
  const rows = (idx && Array.isArray(idx.projects)) ? idx.projects : [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    await getKey(projectKey(row.id));   // 实体回镜像（服务端无此实体 → 镜像置 null·列表自然滤掉）
  }
  return { ok: true, error: null };
}

// ============================================================================
// #44 后半（B3·S2 整改件）：跨窗口同步读口——「拉服务端覆盖缓存后返回」
//   index-changed 接收端与窗口 focus 轻量对账共用（同读口）；实现体 = resyncAll 同一条
//   拉取链（loadAll 六文件 getKey+cacheAll 覆盖缓存 + 按总表行补拉实体）·不复制逻辑。
//   只读不写：纯 GET，不发广播、不落服务端（防回环的读侧保证）。
//   在途实体宽容：store 实体 PUT 走 300ms 防抖而总表行即时 PUT——他窗刚新建的项目
//   「有表行无实体」首拉 404 → 等一个防抖窗后补拉一次（有界·不上卷）；表行已标 missing
//   的不补（服务端确认缺失）。仍缺按现状留空（列表自然滤掉·下次同步/focus 对账自愈）。
// ============================================================================
const ENTITY_HEAL_DELAY_MS = 450;   // > 实体 PUT 防抖窗（store PUT_DEBOUNCE_MS=300）+ 余量
export async function reloadServerIndex() {
  const r = await resyncAll();
  if (!r || !r.ok) return r;
  const idx = _cache[INDEX_KEY];
  const rows = (idx && Array.isArray(idx.projects)) ? idx.projects : [];
  const gaps = rows.filter((row) => row && typeof row.id === "string" && row.id && !row.missing && _cache[projectKey(row.id)] == null);
  if (!gaps.length) return r;
  await new Promise((resolve) => setTimeout(resolve, ENTITY_HEAL_DELAY_MS));
  for (const row of gaps) await getKey(projectKey(row.id));
  return r;
}
