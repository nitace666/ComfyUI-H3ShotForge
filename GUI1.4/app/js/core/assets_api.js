// core/assets_api.js — 引擎资产端点域封装 (S1-4 T1).
//
// === 出处注记 ===
// 改造自 legacy/app/js/domain/assets.js (534 行); 契约权威 = api.md (V1.14) #34/#35/#36.
// 改造点 (与 legacy 的差异, 均为对齐 api.md 实测契约):
//   ① 名称规则: legacy 40 字符 + [A-Za-z0-9_\-\u4e00-\u9fa5] 白名单 → api.md #35 口径
//      1-64 字符 + 禁字符集 [:*?"<>|] (引擎 400 拒绝集); 路径分隔符 / \ .. 放行
//      (引擎 _h3_safe_filename C3 漏斗清洗, 见 api.md #35.1, 不在 400 拒绝集).
//   ② 删掉 legacy 的 assetCopy/imageMeta/assetCrop/ASSET_DT_MIME —
//      本任务 E001-E007 不消费这些端点, 需要时随对应任务按需迁入 (不加不必要的代码).
//      批 3-T1 (F5): archivePurge 迁回 (legacy domain/assets.js:370 原实现 · 引擎 #39 对拍一致);
//      清理时机 = 回收站彻底删除 (1.3 删卡进回收站, 图留待恢复; 1.0「删卡即 purge」不适用).
//   ③ 新增: USAGE_CATALOG / SLOT_RANGES / expandUsageRows / nextKindLock / isKindLockedOut /
//      filterAssets / trash (E005/E006/E002/E007 的引擎契约与 GUI 侧纯逻辑).
//   ④ 批 1-F1: recoveryAssets 迁回 (legacy domain/assets.js:93 原实现 · 引擎 #36 对拍一致);
//      批 1-T1/T2: normalizeSlot (槽号脏值守卫+值域) / inferKindFromUsage (用途推断 kind);
//      expandUsageRows 加 rowMeta 第 3 参 (手编行号/槽号) + 行级未知键 extras 透传 (批 1-F4).
//
// 端点契约 (api.md):
//   #34 GET  /h3_batch/assets          → {assets: {name: card}} (损坏时 200 + error 字段仍返回)
//   #35 POST /h3_batch/assets {name, card}  card=null = 删卡; card 按 _v 校验 (本任务写 v3)
//       v3 卡: {_v:3, kind:"character"|"scene", rows:[{usage,slot,media,desc,ignore_words?}]}
//       usage ∈ 引擎 USAGE_REGISTRY 白名单 (batch_core.py:84-128); slot ∈ _V3_SLOT_RANGES
//       (Picture 1-9 / Video·Audio 1-3, __init__.py:775); media 必须为字符串
//   #36 POST /h3_batch/assets/recovery — 损坏库自助恢复 (backup/reset 两动作 · 批 1-F1 接入)
//   #39 POST /h3_batch/archive_purge {name} — 归档物理清理 (删 archive_docs/<名>.json +
//       rmtree archive_images/<名> · 不存在也 ok · 不碰 .h3_assets.json · 批 3-T1 接入)
//
// 错误信封: 连接层 core/api.js request 已归一; assets 200+error 走 soft_error 通道.
// ESM 依赖链单向: ./api.js ← 本文件; 不反向 import views.

import { request, isEngineUnreachable } from "./api.js";

// 批 10-M M-T4：registry / dormant / trash 三族迁 server 聚合文件 data/assets-meta.json
//   （读 = server 优先 → localStorage 回退；写 = 内存 + 异步 PUT·localStorage 停写）。
//   本模块是三族读点单源：assets_api 内部 4 处 + assets.js + segcards.js + prompt.js +
//   submit-bar.js 的 readRegistry 调用方全部自动生效（方案 §三.2 R1 收敛策略）。
import { readAgg, writeAgg, ASSETS_META, getKey, putKey } from "./server_storage.js";
import { t } from "./i18n.js";   // #92 B3b：import 解析失败 3 条 + submitThreepov 校验 6 条入典 aapi.*（显示面·运行期取词）

// 批A #13（方案-#13解耦B档-2026-10-16）：资产卡读穿缓存 — data/asset-cards-cache.json
//   在线成功 → 落盘 {assets, savedAt}（经 server_storage 适配层·缓存层全钉 data/·R-01 跨浏览器口径）；
//   引擎不可达（网络错/超时·httpStatus=0）→ 读缓存 ok:true+offline:true（离线只读卡墙数据源）。
//   真损坏（200+error）不读缓存 — 恢复态专属，与离线只读严格区分。
export const ASSET_CARDS_CACHE = "data/asset-cards-cache.json";

function _writeCardsCache(assets) {
  // 宏任务延迟落盘：不占列表返回路径（读点既有 URL 序列断言/在途 mock 均不受扰）
  setTimeout(() => {
    void putKey(ASSET_CARDS_CACHE, { assets, savedAt: new Date().toISOString() })
      .catch(() => { /* 落盘失败静默——缓存是兜底非真值 */ });
  }, 0);
}

// ============================================================================
// 名称校验 (api.md #35: 1-64 字符, Windows 禁用 :*?"<>| → 引擎 400)
// ============================================================================

// 引擎 400 拒绝集 (api.md #35 错误码逐字): ':', '*', '?', '"', '<', '>', '|'
const NAME_FORBIDDEN_RE = /[:*?"<>|]/;
const NAME_MAX_LEN = 64;

/**
 * 校验资产卡名 (本地前置, 与引擎 400 语义同构).
 * @param {string} name
 * @returns {{ok: true} | {ok: false, reason: "empty"|"too_long"|"invalid_char"}}
 */
export function validateAssetName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (name.length > NAME_MAX_LEN) {
    return { ok: false, reason: "too_long" };
  }
  if (NAME_FORBIDDEN_RE.test(name)) {
    return { ok: false, reason: "invalid_char" };
  }
  return { ok: true };
}

function _nameError(msg) {
  return {
    ok: false,
    error: { code: "asset_name_invalid", msg, detail: null, httpStatus: 0 },
  };
}

function _validationError(msg) {
  return {
    ok: false,
    error: { code: "validation", msg, detail: null, httpStatus: 0 },
  };
}

const NAME_ERR_MSG = {
  empty: "卡名 (name) 不能为空",
  too_long: `卡名 (name) 超过 ${NAME_MAX_LEN} 字符限制`,
  invalid_char: '卡名含非法字符 (Windows 禁用 : * ? " < > |)',
};

// ============================================================================
// 端点封装
// ============================================================================

/**
 * 资产库列表 (GET /h3_batch/assets, api.md #34).
 * @returns {Promise<Object>}
 *   正常: { ok:true, assets:{name:card} }
 *   不可达+缓存在: { ok:true, offline:true, assets:缓存, savedAt }
 *   不可达+缓存miss: { ok:true, offline:true, assets:{}, cacheEmpty:true }（离线空快照=正常态）
 *   损坏: { ok:false, assets:{}, error:{code,msg,detail,httpStatus} } (视图据此切恢复态)
 */
export async function listAssets() {
  const r = await request("/h3_batch/assets");
  if (!r.ok) {
    // 批A #13：引擎不可达（网络错/超时）→ 读穿缓存渲染离线只读卡墙；真损坏不回落
    if (isEngineUnreachable(r.error)) {
      const c = await getKey(ASSET_CARDS_CACHE).catch(() => null);
      const d = (c && c.ok && c.data && typeof c.data === "object") ? c.data : null;
      if (d && d.assets && typeof d.assets === "object" && !Array.isArray(d.assets)) {
        return { ok: true, assets: d.assets, offline: true, savedAt: typeof d.savedAt === "string" ? d.savedAt : "" };
      }
      // #13批A/B盲区（主代理真机实测闭合）：缓存 miss（无文件/读失败）→ 离线空快照=正常态。
      //   落 ok:false 会让视图误走「资产库读取失败+备份/重置」恢复态（重置钮危险误导）；
      //   cacheEmpty 供视图切换空卡墙指引文案。
      return { ok: true, offline: true, assets: {}, cacheEmpty: true };
    }
    return {
      ok: false,
      assets: (r.data && typeof r.data.assets === "object" && r.data.assets) ? r.data.assets : {},
      error: r.error,
    };
  }
  const data = r.data || {};
  const assets = (data.assets && typeof data.assets === "object") ? data.assets : {};
  _writeCardsCache(assets);   // 批A #13：在线顺手落盘（fire-and-forget·缓存是兜底非真值）
  return { ok: true, assets };
}

/**
 * 读资产卡缓存 (data/asset-cards-cache.json) — #83 排戏场景文字化取人物外形描述。
 *   返回 {ok, assets:{name:card}}；读不到（无缓存/网络错/脏体）→ ok:false + 空表
 *   （调用方按"无外形描述"回落纯走位文字，整卡不失败）。
 */
export async function readCachedAssetCards() {
  const c = await getKey(ASSET_CARDS_CACHE).catch(() => null);
  const d = (c && c.ok && c.data && typeof c.data === "object" && !Array.isArray(c.data)) ? c.data : null;
  if (!d) return { ok: false, assets: {} };
  const assets = (d.assets && typeof d.assets === "object" && !Array.isArray(d.assets)) ? d.assets : {};
  return { ok: true, assets };
}

/**
 * 保存资产卡 (新建或覆盖) — POST /h3_batch/assets {name, card} (api.md #35).
 * card 由视图层按 v3 schema 装配 (buildV3Card 形态); 此处做名称/形状前置校验后透传.
 * @returns {Promise<Object>}
 *   成功: { ok:true, count, name }   失败: { ok:false, error }
 */
export async function saveCard(name, card) {
  const v = validateAssetName(name);
  if (!v.ok) return _nameError(NAME_ERR_MSG[v.reason]);
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return _validationError("card 必须为对象");
  }
  const r = await request("/h3_batch/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, card }),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return { ok: true, count: typeof data.count === "number" ? data.count : 0, name, raw: data };
}

/**
 * 删除资产卡 — POST /h3_batch/assets {name, card:null} (api.md #35: card=null = 删).
 * 引擎侧为物理删除 (一并尝试 archive_docs/<safe>.json), 非软删 —
 * GUI 回收站语义由视图层在删除前缓存卡副本到 localStorage 实现 (见 trash 段).
 * @returns {Promise<Object>} 成功 {ok:true, count, name} / 失败 {ok:false, error}
 */
export async function deleteCard(name) {
  const v = validateAssetName(name);
  if (!v.ok) return _nameError(NAME_ERR_MSG[v.reason]);
  const r = await request("/h3_batch/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, card: null }),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return { ok: true, count: typeof data.count === "number" ? data.count : 0, name, raw: data };
}

// ============================================================================
// 归档物理清理 — POST /h3_batch/archive_purge {name} (api.md #39 · 批 3-T1 F5)
//   删 archive_docs/<名>.json + rmtree(archive_images/<名>); 不存在也 ok; 不碰 .h3_assets.json
//   (卡条目删除走 #35 删卡; 本端点只清归档图/档, 二者先删卡后 purge 分两步)。
//   旧信封端点 (api.md:79 旧清单) — 400 裸 {error} / {ok:false,msg} 由 core/api.js 归一。
//   高危: 引擎无 busy 检查/无二次确认 — 本地仅名称校验, 视图层须弹窗双确认 (legacy:370 先例)。
// ============================================================================

/**
 * 归档物理清理 (删档 + 删图目录).
 * @param {string} name — 档案卡名 (1.3 现行 64 字符规则)
 * @returns {Promise<Object>} 成功 {ok:true, name} / 失败 {ok:false, error}
 */
export async function archivePurge(name) {
  const v = validateAssetName(name);
  if (!v.ok) return _nameError(NAME_ERR_MSG[v.reason]);
  const r = await request("/h3_batch/archive_purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  return { ok: true, name, raw: r.data || {} };
}

// ============================================================================
// 损坏库自助恢复 — POST /h3_batch/assets/recovery (api.md #36 · 批 1-F1)
//   仅对已确认损坏的库放行 (健康库/文件不存在 → 引擎 400 拒绝, 防误删).
//   backup = 字节级拷贝损坏文件 → .corrupt-<ts>; reset = 备份后删损坏文件 + 原子写空库 {}.
//   两动作响应同形 {ok:true, backup:"<文件名>"} — 视图层用 backup 字段向用户披露备份落点.
// ============================================================================

const RECOVERY_ACTIONS = ["backup", "reset"];

/**
 * 资产库恢复 (backup / reset).
 * @param {{action:"backup"|"reset"}} opts
 * @returns {Promise<Object>}
 *   成功: { ok:true, action, backup:"<备份文件名>" }
 *   失败: { ok:false, error:{code,msg,detail,httpStatus} } (本地 action 非法 → validation 零请求)
 */
export async function recoveryAssets(opts) {
  const action = (opts && opts.action) || "";
  if (!RECOVERY_ACTIONS.includes(action)) {
    return _validationError("action 必须为 backup 或 reset");
  }
  const r = await request("/h3_batch/assets/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    action,
    backup: typeof data.backup === "string" ? data.backup : "",
    raw: data,
  };
}

// ============================================================================
// 用途目录 (E005/E006 数据源)
// ============================================================================
// id/label/kind 逐字镜像引擎 batch_core.py USAGE_REGISTRY:84-128 (batch_core 是单一真值源,
// 此处为前端镜像; 引擎扩用途时需同步本表).
// 序 = v43 原型 USE_LIST (:2790-2802) 原序 — label 与引擎逐字一致, 序即 v43 序.
// kind = 引擎媒体类型 Picture/Video/Audio (E006 锁定口径: kind 锁定锁的是媒体类型,
// 图片类用途之间不互锁 — v43 USE_LIST 头注释原口径).

export const USAGE_CATALOG = Object.freeze([
  { id: "subject_look", label: "人物·外貌", kind: "Picture" },
  { id: "subject_outfit", label: "人物·服装", kind: "Picture" },
  { id: "subject_prop", label: "人物·道具", kind: "Picture" },
  { id: "三视图", label: "人物·三视图", kind: "Picture" },
  { id: "scene", label: "场景·环境", kind: "Picture" },
  { id: "pose", label: "人物·姿势", kind: "Picture" },
  { id: "first_frame", label: "首帧锚定", kind: "Picture" },
  { id: "video_ref", label: "视频·动作参考", kind: "Video" },
  { id: "audio_ref", label: "音频参考", kind: "Audio" },
  { id: "道具多角度", label: "道具·多角度", kind: "Picture" },
]);

// 引擎 _V3_SLOT_RANGES (__init__.py:775-777): Picture 1-9 / Video 1-3 / Audio 1-3 (值上限)
export const SLOT_RANGES = Object.freeze({ Picture: 9, Video: 3, Audio: 3 });

/**
 * 槽号脏值守卫 + 值域校验 (批 1-T1 · 1.0 assets_card_dialog.js:1160 口径 + api.md #35 值域).
 *   空 → "1" (1.0 原口径); 非纯数字或 0 → invalid (本地拦截不发请求);
 *   超出所勾用途 kind 的值域 (Picture 1-9 / Video·Audio 1-3) → out_of_range.
 * @param {string} raw — 槽号输入框原值
 * @param {string[]} kinds — 该媒体行所勾用途的 kind 集 (USAGE_CATALOG[].kind)
 * @returns {{ok:true, slot:string}
 *          | {ok:false, reason:"invalid"|"out_of_range", kind?:string, max?:number}}
 */
export function normalizeSlot(raw, kinds) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { ok: true, slot: "1" };
  const n = parseInt(s, 10);
  if (!/^[0-9]+$/.test(s) || n === 0) return { ok: false, reason: "invalid" };
  for (const k of Array.isArray(kinds) ? kinds : []) {
    const max = SLOT_RANGES[k];
    if (max && n > max) return { ok: false, reason: "out_of_range", kind: k, max };
  }
  return { ok: true, slot: String(n) };
}

// 用途推断分组 (批 1-T2 · 1.0 assets_card_dialog.js:87-89 逐字迁移).
//   1.0 的 _USAGES_FOR_PROP_ONLY (道具多角度 → "other") 不迁: 1.3 kind 值域 = 引擎白名单
//   character|scene (api.md #35 · FILTER_KINDS), 无 other — 仅道具类 → 不推断 (返回 null).
const USAGES_FOR_CHARACTER = ["subject_look", "subject_outfit", "subject_prop", "三视图", "pose"];
const USAGES_FOR_SCENE = ["scene"];

/**
 * 按勾选用途 id 推断卡 kind (1.0 :98 逻辑 · 值域收窄到 1.3 的 character|scene).
 *   任一人物类 → "character" (人物优先); 否则场景类 → "scene"; 空/仅非分类/仅道具类 → null
 *   (null = 调用方保持现有 kind, 不强行覆盖).
 * @param {string[]} checkedIds — 已勾选用途 id (跨媒体行全集)
 * @returns {"character"|"scene"|null}
 */
export function inferKindFromUsage(checkedIds) {
  if (!Array.isArray(checkedIds) || checkedIds.length === 0) return null;
  const charSet = new Set(USAGES_FOR_CHARACTER);
  const sceneSet = new Set(USAGES_FOR_SCENE);
  let scenePicked = false;
  for (const id of checkedIds) {
    if (typeof id !== "string" || !id) continue;
    if (charSet.has(id)) return "character"; // 人物优先 — 命中即返
    if (sceneSet.has(id)) scenePicked = true;
    // 非分类 (first_frame/video_ref/audio_ref) 与道具类不参与推断
  }
  return scenePicked ? "scene" : null;
}

/**
 * 展示层 kind 判别式 (#39 方案 D3 · 引擎真值仍 character|scene 白名单——本函数仅 GUI
 * 展示/分类用, 返回值不回写引擎 kind)。道具 = character 卡上含「道具多角度」行 (#53 建档路由判据)。
 *   规则: kind==="scene" → "scene"; rows 含 usage"三视图" → "character" (三视图优先·
 *   人物卡兼有道具行时显「人物」·歧义知悉·与 at-mention.js kindToClass th-prop 先例口径对齐);
 *   含"道具多角度" → "item"; 缺省 "character"。
 * @param {Object} card — 资产卡 (引擎 v3 档案卡 {kind, rows})
 * @returns {"character"|"scene"|"item"} — 原始 id 非中文 (预览页过滤按值比)
 */
export function displayKindOf(card) {
  if (!card || typeof card !== "object") return "character";
  if (card.kind === "scene") return "scene";
  const rows = Array.isArray(card.rows) ? card.rows : [];
  let item = false;
  for (const r of rows) {
    if (!r) continue;
    if (r.usage === "三视图") return "character";
    if (r.usage === "道具多角度") item = true;
  }
  return item ? "item" : "character";
}

/**
 * 媒体行 → 引擎 v3 rows 展开 (E005 保存口径: 按勾选展开为 N 条引用行, 同 media 共享).
 * 槽号 per-kind 独立计数, 从 1 起 (Picture 1-9 / Video·Audio 1-3).
 *
 * 批 1 增补:
 *   - 行级 round-trip (F4): c.extras (源行未知键) 先铺底, 表单字段随后覆写 —
 *     引擎必收键 usage/slot/media/desc 恒为表单真值, 永不被未知键顶掉 (反例守卫).
 *   - 手编行号/槽号 (T1): rowMeta.slot 非空 → 覆盖该媒体行全部展开行 (1.0 手编值逐行复制口径);
 *     未手编时用 c.srcSlot (源行槽号·保真回写), 再退 per-kind 自动计数.
 *     rowMeta.idx 非空 → 写 idx; 否则沿用 c.srcIdx (源行行号, 引擎 v3 无 idx 字段, 仅回写保留).
 * @param {string} mediaPath — 该媒体行路径 (可为空串, 引擎仅要求字符串)
 * @param {Array<{idx:number, desc?:string, ignore?:string, poseStyle?:string,
 *                srcSlot?:string, srcIdx?:number, extras?:Object}>} checked — 勾选用途
 * @param {{idx?:number, slot?:string}} [rowMeta] — 该媒体行手编值 (未手编则不传/缺省)
 * @returns {Array<{usage,slot,media,desc,ignore_words}>}
 */
export function expandUsageRows(mediaPath, checked, rowMeta) {
  const counters = { Picture: 0, Video: 0, Audio: 0 };
  const rows = [];
  const meta = (rowMeta && typeof rowMeta === "object") ? rowMeta : {};
  const slotOverride = (typeof meta.slot === "string" && meta.slot) ? meta.slot : "";
  const idxOverride = Number.isInteger(meta.idx) && meta.idx >= 1 ? meta.idx : null;
  for (const c of Array.isArray(checked) ? checked : []) {
    const u = USAGE_CATALOG[c.idx];
    if (!u) continue;
    counters[u.kind] += 1;
    const srcSlot = (typeof c.srcSlot === "string" && c.srcSlot) ? c.srcSlot : "";
    const srcIdx = Number.isInteger(c.srcIdx) && c.srcIdx >= 1 ? c.srcIdx : null;
    const row = Object.assign({}, c.extras, {
      usage: u.id,
      slot: slotOverride || srcSlot || String(counters[u.kind]),
      media: typeof mediaPath === "string" ? mediaPath : "",
      desc: typeof c.desc === "string" ? c.desc : "",
      ignore_words: typeof c.ignore === "string" ? c.ignore : "",
    });
    const idx = idxOverride != null ? idxOverride : srcIdx;
    if (idx != null) row.idx = idx;
    // S2-1 a2: 姿势行带样式（skeleton|depth·缺省不落字段=引擎骨架兜底）
    if (u.id === "pose" && (c.poseStyle === "depth" || c.poseStyle === "skeleton")) {
      row.pose_style = c.poseStyle;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 下一个 kind 锁定值 (E006 纯逻辑, v43 :2803-2857 机制):
 * 无勾选 → ""; 现锁仍在勾选集中 → 保持; 否则 → 余项首个 kind (首勾定 kind 亦由此覆盖).
 * @param {string} locked — 当前锁定 kind ("Picture"|"Video"|"Audio"|"")
 * @param {string[]} checkedKinds — 当前勾选项的 kind 列表 (按勾选序)
 * @returns {string}
 */
export function nextKindLock(locked, checkedKinds) {
  const kinds = Array.isArray(checkedKinds) ? checkedKinds : [];
  if (!kinds.length) return "";
  if (locked && kinds.includes(locked)) return locked;
  return kinds[0];
}

/**
 * kind 是否被锁出 (E006): 有锁且异 kind → true (复选置灰 + title "已选其他 kind，不可再勾").
 * 图片类用途互不锁定的语义 = 同 Picture kind 之间 isKindLockedOut 恒 false.
 * @param {string} kind
 * @param {string} locked
 * @returns {boolean}
 */
export function isKindLockedOut(kind, locked) {
  return !!locked && kind !== locked;
}

// ============================================================================
// 搜索 (E002 · v26 W8/W11 + v27 P4 口径: 模糊匹配 名称+标签+备注)
// ============================================================================

/**
 * 资产搜索过滤.
 * @param {Object} assets — {name: card} 引擎字典 (保持插入序)
 * @param {string} q — 查询词 (trim + 大小写不敏感; 空 → 全部)
 * @returns {string[]} 命中的卡名列表 (引擎字典插入序)
 */
export function filterAssets(assets, q) {
  const src = assets && typeof assets === "object" ? assets : {};
  const names = Object.keys(src);
  const query = typeof q === "string" ? q.trim().toLowerCase() : "";
  if (!query) return names;
  return names.filter((name) => {
    const card = src[name] || {};
    const tags = normalizeTags(card.tags).join(" ");
    const memo = typeof card.memo === "string" ? card.memo : "";
    const hay = (name + " " + tags + " " + memo).toLowerCase();
    return hay.includes(query);
  });
}

// ============================================================================
// 标签分词 (改造自 legacy domain/assets.js 62.3 normalizeTags · 分隔符同源: 顿号/逗号/空白)
// ============================================================================

const TAG_SPLIT_RE = /[、,\s]+/;

/**
 * 任意输入 → string[] (trim / 去空 / 去重保序).
 * @param {*} input — string (按分隔符分词) | array (逐项 String 化) | null → []
 */
export function normalizeTags(input) {
  if (input == null) return [];
  if (typeof input === "string") {
    if (!input) return [];
    return _dedupe(input.split(TAG_SPLIT_RE).map((s) => s.trim()).filter(Boolean));
  }
  if (Array.isArray(input)) {
    const out = [];
    for (const v of input) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) out.push(s);
    }
    return _dedupe(out);
  }
  return [];
}

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ============================================================================
// 资产库导入解析 (快批⑥ · 导入通道)
// ============================================================================
// 导出格式 (GUI 侧登记: 引擎无资产库转入/转出端点)
//   = {assets: {name: card}} 容器 — 与引擎 #34 GET /h3_batch/assets 响应同构 (档案卡 JSON 集).
// 导入另收两形态: 单条 {name, card} (与 #35 POST body 同构) / 条目数组 [{name, card}].
// 单条不合格只跳过不整包失败 (skipped 计数), 卡名按 #35 前置校验 (validateAssetName).
// zip (PK 头): 引擎侧解包通道未提供 → zip_pending 登记口径 (调用方提示, 不当 JSON 硬解).

/**
 * 解析资产库导入文本 (JSON) — 读文件后的第一道漏斗.
 * @param {string} text — 文件文本
 * @returns {{ok:true, cards:Array<{name:string, card:Object}>, skipped:number}
 *          | {ok:false, error:{code:"empty"|"zip_pending"|"json_invalid"|"shape_invalid", msg:string}}}
 */
export function parseAssetImport(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: { code: "empty", msg: t("aapi.import.empty") } };
  }
  if (text.startsWith("PK")) { // zip 本地文件头（PK\x03\x04）
    return {
      ok: false,
      error: {
        code: "zip_pending",
        msg: t("aapi.import.zipPending"),   // #92 B5：入典（B3b 遗留登记闭环）
      },
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    return { ok: false, error: { code: "json_invalid", msg: t("aapi.import.jsonInvalid") } };
  }
  let rawEntries;
  if (Array.isArray(data)) {
    rawEntries = data;
  } else if (data && typeof data === "object" && data.assets && typeof data.assets === "object" && !Array.isArray(data.assets)) {
    rawEntries = Object.entries(data.assets).map(([name, card]) => ({ name, card }));
  } else if (data && typeof data === "object" && typeof data.name === "string") {
    rawEntries = [{ name: data.name, card: data.card }];
  } else {
    return {
      ok: false,
      error: {
        code: "shape_invalid",
        msg: t("aapi.import.shapeInvalid"),
      },
    };
  }
  const cards = [];
  let skipped = 0;
  for (const entry of rawEntries) {
    const name = entry && typeof entry === "object" ? entry.name : null;
    const card = entry && typeof entry === "object" ? entry.card : null;
    const cardOk = !!card && typeof card === "object" && !Array.isArray(card);
    if (!validateAssetName(name).ok || !cardOk) {
      skipped += 1;
      continue;
    }
    cards.push({ name, card });
  }
  return { ok: true, cards, skipped };
}

// ============================================================================
// 回收站 (E007 · GUI 侧软删缓存)
// ============================================================================
// 引擎 #35 删卡 = 物理删除 (card=null; 一并尝试 archive_docs/<safe>.json), 无软删端点 —
// 任务单 E007 钦点: "若引擎端点不支持资产软删, 则 GUI 侧 localStorage 软删缓存登记限实".
// 实现: 删除前由视图层把卡副本写入本缓存; 恢复 = 从缓存取卡 + saveCard 写回引擎.
// 注: 引擎侧归档目录 (archive_images) 不随恢复再生, 恢复限档案卡 JSON 本体 (限实口径).

export const TRASH_KEY = "gui13.assets.trash";

/**
 * 读回收站列表.
 * @param {Storage|null} storage — 注入 (默认调用方传 globalThis.localStorage); null/异常 → []
 * @returns {Array<{name, card, deletedAt}>}
 */
export function readTrash(storage) {
  const v = readAgg(ASSETS_META, "trash", storage);        // M-T4：server 优先
  if (v == null && (!storage || typeof storage.getItem !== "function")) return [];
  try {
    const parsed = v != null ? v : JSON.parse(storage.getItem(TRASH_KEY) || "null");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

/**
 * 追加一条软删记录 (同名重删去重保最新; deletedAt = 删除时刻 ISO 串).
 * @param {Storage|null} storage
 * @param {string} name
 * @param {object} card — 删除前的卡副本 (恢复时写回引擎)
 */
export function trashAdd(storage, name, card) {
  if (!storage || typeof storage.setItem !== "function") return;
  try {
    const list = readTrash(storage).filter((it) => it && it.name !== name);
    list.push({ name, card, deletedAt: new Date().toISOString() });
    writeAgg(ASSETS_META, "trash", list);   // M-T4
  } catch (_e) { /* 配额/隐私模式写失败静默 — 回收站退化为不可用, 不阻塞主流程 */ }
}

/**
 * 移除一条软删记录 (恢复/彻底清除时), 返回被移除条目; 不存在返回 null.
 * @param {Storage|null} storage
 * @param {string} name
 * @returns {{name, card, deletedAt}|null}
 */
export function trashRemove(storage, name) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const list = readTrash(storage);
    const idx = list.findIndex((it) => it && it.name === name);
    if (idx < 0) return null;
    const [removed] = list.splice(idx, 1);
    writeAgg(ASSETS_META, "trash", list);   // M-T4
    return removed;
  } catch (_e) {
    return null;
  }
}

// ============================================================================
// 断槽登记 dormant (F66 裁剪改原卡断槽) —— 裁剪产物接管原图槽位后, 原图从引擎卡 rows 摘除,
// 原图 media 落 GUI 本地分离键。引擎 v3 契约无断槽表达（POST assets 带 usage/slot 空串行 →
// 400 拒收 · 2026-10-02 探针实证, 与 F48/D-T1 登记一致）, 故原图不进引擎 rows。
// 形状: { 卡名: [media, …] } · 消费面: 卡面叠显并集 / 编辑弹窗断槽行只读展示。
// ============================================================================

export const DORMANT_KEY = "gui13.assets.dormant";

/**
 * 读断槽登记.
 * @param {Storage|null} storage — 注入 (默认调用方传 globalThis.localStorage); null/异常 → {}
 * @returns {Object<string, string[]>}
 */
export function readDormant(storage) {
  const v = readAgg(ASSETS_META, "dormant", storage);       // M-T4：server 优先
  if (v == null && (!storage || typeof storage.getItem !== "function")) return {};
  try {
    const parsed = v != null ? v : JSON.parse(storage.getItem(DORMANT_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_e) {
    return {};
  }
}

/**
 * 追加一条断槽原图 (同卡去重; 写失败静默不阻塞主流程).
 * @param {Storage|null} storage
 * @param {string} cardName
 * @param {string} media — 断槽原图媒体路径
 */
export function dormantAdd(storage, cardName, media) {
  if (!storage || typeof storage.setItem !== "function") return;
  if (typeof cardName !== "string" || !cardName || typeof media !== "string" || !media) return;
  try {
    const map = readDormant(storage);
    const list = Array.isArray(map[cardName]) ? map[cardName] : [];
    if (!list.includes(media)) list.push(media);
    map[cardName] = list;
    writeAgg(ASSETS_META, "dormant", map);   // M-T4
  } catch (_e) { /* 配额/隐私模式写失败静默 — 断槽登记退化为不记 */ }
}

/**
 * 移除一条断槽原图 (批 10-H-T1 规则⑤: 断槽行也要能删; 未命中/非法入参零写入).
 * @param {Storage|null} storage
 * @param {string} cardName
 * @param {string} media
 */
export function dormantRemove(storage, cardName, media) {
  if (!storage || typeof storage.setItem !== "function") return;
  if (typeof cardName !== "string" || !cardName || typeof media !== "string" || !media) return;
  try {
    const map = readDormant(storage);
    const list = Array.isArray(map[cardName]) ? map[cardName] : [];
    if (!list.includes(media)) return;
    map[cardName] = list.filter((m) => m !== media);
    writeAgg(ASSETS_META, "dormant", map);   // M-T4
  } catch (_e) { /* 写失败静默 — 断槽删除退化为不删 */ }
}

/**
 * 清空整卡断槽登记 (批 10-H-T1: 零图保存=删卡时同清·防同名新卡捡到旧卡断槽).
 * @param {Storage|null} storage
 * @param {string} cardName
 */
export function dormantClear(storage, cardName) {
  if (!storage || typeof storage.setItem !== "function") return;
  if (typeof cardName !== "string" || !cardName) return;
  try {
    const map = readDormant(storage);
    if (!Object.prototype.hasOwnProperty.call(map, cardName)) return;
    delete map[cardName];
    writeAgg(ASSETS_META, "dormant", map);   // M-T4
  } catch (_e) { /* 写失败静默 — 断槽清退化为不清 */ }
}

// ============================================================================
// 三视图 / 多角度生成提交 (S1-4 修正笔·E004 — api.md #45 POST /h3_batch/threepov)
// ============================================================================
// 契约 (批 9 T1 实况 + 批 10 T2): text / image_path / image_paths / card_name 四法可用
//   (四选一互斥; card_name 整卡模式批 10 T2 接入); image_paths 1-8 项 (空列表/9+ 项引擎 400)。
//   引擎侧异步执行 (任务号 threepov_<ts>, 占用与跑批互斥 → 409 active_busy); 状态轮询 #46 归 S2-2。
// B3-T2 F7 扩参 (J2b 画布可配置化·api.md :1484-1508): 可选 workflowPath/lora_overrides/resource_overrides
//   覆盖参数 (照 legacy domain/threepov.js:57-65 口径) — 真值 (length>0) 才写 body; 空串/undefined
//   不传 = 引擎走 h3_config.canvas/默认; "{}" 为显式清空 (合法真值)。域层不 trim/不校验 (UI 层 trim 后传)。

// 卡名模式 (批 10 T2·方案 §六.2): 三提交函数共用, 防漂移。
// cardName 未传 (undefined/null) → null = 走既有三法逻辑 (AC-8 逐键不变)。
// 传了则本地只校验空串/长度 1-64 (非法字符交引擎 400 透传), 且与 text/imagePath/imagePaths 互斥;
// body 只含 card_name (+ prompt_extra 非空时 / writeback:false 显式时·显式 true 走引擎默认)。
function _applyCardMode(opts) {
  if (opts.cardName === undefined || opts.cardName === null) return null;
  const cardName = typeof opts.cardName === "string" ? opts.cardName.trim() : "";
  if (!cardName) {
    return { error: { code: "validation", msg: t("aapi.submit.cardNameEmpty"), detail: null, httpStatus: 0 } };
  }
  if (cardName.length > 64) {
    return { error: { code: "validation", msg: t("aapi.submit.cardNameTooLong"), detail: null, httpStatus: 0 } };
  }
  const text = typeof opts.text === "string" ? opts.text.trim() : "";
  const imagePath = typeof opts.imagePath === "string" ? opts.imagePath.trim() : "";
  if (text || imagePath || Array.isArray(opts.imagePaths)) {
    return { error: { code: "validation", msg: t("aapi.submit.cardModeMutex"), detail: null, httpStatus: 0 } };
  }
  const body = { card_name: cardName };
  if (typeof opts.promptExtra === "string" && opts.promptExtra.trim()) {
    body.prompt_extra = opts.promptExtra.trim();
  }
  if (opts.writeback === false) body.writeback = false;
  return { body };
}

// 整卡模式提交样板 (三函数共用; 旧三法路径保持原样不动)。
function _postCardMode(endpoint, body) {
  return request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) return { ok: false, error: r.error, raw: r.data };
    const data = r.data || {};
    return { ok: true, taskId: data.task_id || data.taskId || "", raw: data };
  });
}

export function submitThreepov(opts = {}) {
  const cardMode = _applyCardMode(opts);
  if (cardMode) {
    return cardMode.error
      ? Promise.resolve({ ok: false, error: cardMode.error })
      : _postCardMode("/h3_batch/threepov", cardMode.body);
  }
  const text = typeof opts.text === "string" ? opts.text.trim() : "";
  const imagePath = typeof opts.imagePath === "string" ? opts.imagePath.trim() : "";
  // 批 9 T1 F36: imagePaths 数组形态 (引擎 image_paths 1-8 项·每项绝对路径);
  //   空数组/超 8 项/非字符串或空串项 → 前端拦 (不让必 400 的请求发出)
  let imagePaths = null;
  if (Array.isArray(opts.imagePaths)) {
    const list = opts.imagePaths.map((p) => (typeof p === "string" ? p.trim() : p));
    if (list.length < 1 || list.length > 8 || list.some((p) => typeof p !== "string" || !p)) {
      return Promise.resolve({
        ok: false,
        error: { code: "validation", msg: t("aapi.submit.imagePathsRange"), detail: null, httpStatus: 0 },
      });
    }
    imagePaths = list;
  }
  if (!text && !imagePath && !imagePaths) {
    return Promise.resolve({
      ok: false,
      error: { code: "validation", msg: t("aapi.submit.needOne"), detail: null, httpStatus: 0 },
    });
  }
  if ([text, imagePath, imagePaths].filter(Boolean).length > 1) {
    return Promise.resolve({
      ok: false,
      error: { code: "validation", msg: t("aapi.submit.mutex"), detail: null, httpStatus: 0 },
    });
  }
  const body = text ? { text } : (imagePaths ? { image_paths: imagePaths } : { image_path: imagePath });
  // 画布覆盖参数 (J2b): 真值才写键 — 三键缺省 = body 与扩参前逐键一致
  if (typeof opts.workflowPath === "string" && opts.workflowPath.length > 0) {
    body.workflow_path = opts.workflowPath;
  }
  if (typeof opts.loraOverrides === "string" && opts.loraOverrides.length > 0) {
    body.lora_overrides = opts.loraOverrides;
  }
  if (typeof opts.resourceOverrides === "string" && opts.resourceOverrides.length > 0) {
    body.resource_overrides = opts.resourceOverrides;
  }
  // R-03 三键 (批②): 真值才写 body — aspect 非空串 / megapixels·durationSeconds 正有限数;
  //   缺省不传 = 引擎走 h3_config.canvas/默认 (与 J2b 三键同款口径·域外值交引擎兜底)。
  if (typeof opts.aspect === "string" && opts.aspect.trim()) {
    body.aspect = opts.aspect.trim();
  }
  if (Number.isFinite(opts.megapixels) && opts.megapixels > 0) {
    body.megapixels = opts.megapixels;
  }
  if (Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0) {
    body.duration_seconds = opts.durationSeconds;
  }
  return request("/h3_batch/threepov", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) return { ok: false, error: r.error, raw: r.data };
    const data = r.data || {};
    return { ok: true, taskId: data.task_id || data.taskId || "", raw: data };
  });
}

// 三视图任务状态查询 (api.md #46 GET /h3_batch/threepov/status — 走查反馈 F15 接线:
// done → result_png_path 非空；interrupted = 8190 重启读盘返回不挂死)
export function threepovStatus(taskId) {
  return request(`/h3_batch/threepov/status?task_id=${encodeURIComponent(taskId)}`).then((r) => {
    if (!r.ok) return { ok: false, error: r.error };
    const data = r.data || {};
    return {
      ok: true,
      status: data.status || "",
      resultPngPath: data.result_png_path || "",
      error: data.error || null,
    };
  });
}

// ============================================================================
// 场景/道具画布提交+轮询 (批 7-T4 — api.md #47/#48 scene_canvas · #53/#54 item_canvas)
// ============================================================================
// 三端点同构家族 (#45/#47/#53): 异步两步式提交 + status 轮询 + 注册表 + 重启 interrupted。
// 三件补做批 T2（账本 #29）: text / image_path / image_paths 三法放开（引擎 #53/#47 已支持四法,
//   批 10 T2 接 card_name 整卡模式）; 四法互斥与 image_paths 1-8 上限与 submitThreepov 同款
//   口径（复用其校验语义, 不让必 400 的请求发出）。
// J2b 覆盖参数三键与 submitThreepov 同款口径 (真值才写 body 键; 空串/undefined = 引擎走 h3_config.canvas/默认)。
function _submitCanvas(endpoint, opts) {
  const cardMode = _applyCardMode(opts);
  if (cardMode) {
    return cardMode.error
      ? Promise.resolve({ ok: false, error: cardMode.error })
      : _postCardMode(endpoint, cardMode.body);
  }
  const text = typeof opts.text === "string" ? opts.text.trim() : "";
  const imagePath = typeof opts.imagePath === "string" ? opts.imagePath.trim() : "";
  let imagePaths = null;
  if (Array.isArray(opts.imagePaths)) {
    const list = opts.imagePaths.map((p) => (typeof p === "string" ? p.trim() : p));
    if (list.length < 1 || list.length > 8 || list.some((p) => typeof p !== "string" || !p)) {
      return Promise.resolve({
        ok: false,
        error: { code: "validation", msg: t("aapi.submit.imagePathsRange"), detail: null, httpStatus: 0 },   // #92 B5：入典（复用 B3b 同文案键）
      });
    }
    imagePaths = list;
  }
  if (!text && !imagePath && !imagePaths) {
    return Promise.resolve({
      ok: false,
      error: { code: "validation", msg: t("aapi.submit.needOne"), detail: null, httpStatus: 0 },   // #92 B5：入典（复用 B3b 同文案键）
    });
  }
  if ([text, imagePath, imagePaths].filter(Boolean).length > 1) {
    return Promise.resolve({
      ok: false,
      error: { code: "validation", msg: t("aapi.submit.mutex"), detail: null, httpStatus: 0 },   // #92 B5：入典（复用 B3b 同文案键）
    });
  }
  const body = text ? { text } : (imagePaths ? { image_paths: imagePaths } : { image_path: imagePath });
  if (typeof opts.workflowPath === "string" && opts.workflowPath.length > 0) body.workflow_path = opts.workflowPath;
  if (typeof opts.loraOverrides === "string" && opts.loraOverrides.length > 0) body.lora_overrides = opts.loraOverrides;
  if (typeof opts.resourceOverrides === "string" && opts.resourceOverrides.length > 0) body.resource_overrides = opts.resourceOverrides;
  return request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) return { ok: false, error: r.error, raw: r.data };
    const data = r.data || {};
    return { ok: true, taskId: data.task_id || data.taskId || "", raw: data };
  });
}

// #47 POST /h3_batch/scene_canvas (任务号 scenecv_<ts> · 1 段 2s 便宜档 · 产物前缀 scenecv_)
export function submitSceneCanvas(opts = {}) {
  return _submitCanvas("/h3_batch/scene_canvas", opts);
}

// #53 POST /h3_batch/item_canvas (任务号 itemcv_<ts> · 产物前缀 itemcv_)
export function submitItemCanvas(opts = {}) {
  return _submitCanvas("/h3_batch/item_canvas", opts);
}

// 状态轮询 (#48/#54 — 与 #46 同构五态): started/rendering 中间态; done → resultPngPath; failed/interrupted → error
function _canvasStatus(path, taskId) {
  return request(`${path}?task_id=${encodeURIComponent(taskId)}`).then((r) => {
    if (!r.ok) return { ok: false, error: r.error };
    const data = r.data || {};
    return {
      ok: true,
      status: data.status || "",
      resultPngPath: data.result_png_path || "",
      error: data.error || null,
    };
  });
}

// #48 GET /h3_batch/scene_canvas/status
export function sceneCanvasStatus(taskId) {
  return _canvasStatus("/h3_batch/scene_canvas/status", taskId);
}

// #54 GET /h3_batch/item_canvas/status
export function itemCanvasStatus(taskId) {
  return _canvasStatus("/h3_batch/item_canvas/status", taskId);
}

// ============================================================================
// S2-1: 资产编号注册表 (@N→引擎卡名连接键·详案任务 0) + 行级互斥 (a3) + 姿势样式 (a2)
// ============================================================================

// 注册表键（与 gui13.assets.trash 同族；storage 注入同款）
export const REGISTRY_KEY = "gui13.assets.registry";

function _readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch (_e) {
    return fallback;
  }
}

/** 注册表读取：{ [n(string)]: cardName }（数组形态拒绝——防污染口径同旧内联实现） */
export function readRegistry(storage) {
  // M-T4：server 聚合文件优先 · 未命中回退本地（迁移前存量）
  const v = readAgg(ASSETS_META, "registry", storage);
  const val = v == null ? _readJson(storage, REGISTRY_KEY, {}) : v;
  return (val && typeof val === "object" && !Array.isArray(val)) ? val : {};
}

function _writeRegistry(storage, reg) {
  writeAgg(ASSETS_META, "registry", reg);   // M-T4：内存 + 异步 PUT（localStorage 停写）
}

/** 最小空闲 n（跳过已被占用与被跳过的 9 号——Picture 池 9 号为动态衔接保留槽·a4） */
export function nextRegistryN(reg) {
  const used = new Set(Object.keys(reg || {}).map((k) => +k));
  let n = 1;
  while (used.has(n) || n === 9) n += 1;
  return n;
}

/** 分配：给卡名绑一个 @N（已绑则原样返回） */
export function assignRegistryN(storage, cardName) {
  const reg = readRegistry(storage);
  for (const k of Object.keys(reg)) {
    if (reg[k] === cardName) return +k;
  }
  const n = nextRegistryN(reg);
  reg[String(n)] = cardName;
  _writeRegistry(storage, reg);
  return n;
}

/** 改名迁移（2026-09-27 走查修复）：旧卡名占用的 @N 转给新卡名——分镜提示词里的 @N 引用不断链 */
export function rebindRegistryName(storage, fromName, toName) {
  if (!fromName || !toName || fromName === toName) return false;
  const reg = readRegistry(storage);
  let hit = false;
  for (const k of Object.keys(reg)) {
    if (reg[k] === fromName) { reg[k] = toName; hit = true; }
  }
  if (hit) _writeRegistry(storage, reg);
  return hit;
}

/** 首次加载扫描：为尚无 @N 的存量卡补分配（S1-4 旧卡兼容·详案任务 0） */
export function scanAssignRegistry(storage, cardNames) {
  const reg = readRegistry(storage);
  let changed = false;
  for (const name of Array.isArray(cardNames) ? cardNames : []) {
    if (!name) continue;
    if (Object.values(reg).includes(name)) continue;
    const n = nextRegistryN(reg);
    reg[String(n)] = name;
    changed = true;
  }
  if (changed) _writeRegistry(storage, reg);
  return { registry: reg, changed };
}

/** 按卡名反查 @N（未注册 → null） */
export function registryNFor(storage, cardName) {
  const reg = readRegistry(storage);
  for (const k of Object.keys(reg)) {
    if (reg[k] === cardName) return +k;
  }
  return null;
}

/**
 * a3 行级互斥（纯函数·§0.1 裁决）：同媒体行勾"人物·姿势"→ 同行其他 Picture 类用途清出。
 * 走查反馈 F51：单勾姿势（无项被清）也须让视图层立即置灰——补 hasPose 信号（姿势已勾即 true），
 *   mutexApplied 口径不变（真有项被清才 true）→ 既有调用方兼容。
 * @param {Array<{idx:number}>} checked — 本行勾选用途（USAGE_CATALOG 下标）
 * @returns {{ checked: Array, mutexApplied: boolean, hasPose: boolean }}
 */
export function applyRowMutex(checked) {
  const arr = Array.isArray(checked) ? checked : [];
  const POSE_IDX = USAGE_CATALOG.findIndex((u) => u.id === "pose");
  const hasPose = arr.some((c) => c && c.idx === POSE_IDX);
  if (!hasPose) return { checked: arr, mutexApplied: false, hasPose: false };
  const filtered = arr.filter((c) => {
    if (!c) return false;
    if (c.idx === POSE_IDX) return true;
    const u = USAGE_CATALOG[c.idx];
    return !(u && u.kind === "Picture");
  });
  return { checked: filtered, mutexApplied: filtered.length !== arr.length, hasPose: true };
}

/** 姿势样式合法值（引擎 POSE_STYLE_IDS·batch_core.py:132） */
export const POSE_STYLE_IDS = Object.freeze(["skeleton", "depth"]);

// ============================================================================
// S3-1 T2: 概念环——视频抽帧 (extractFrame) + 概念卡字段装配 (buildConceptCard)
//   抽帧：以 video/canvas+seek/drawImage/toBlob 链抽 t 秒帧为 PNG Blob
//   建卡：按用户一句话 + 时间戳构造概念帧卡字段 (v3 shape, 用途 first_frame, media 拼概念根路径)
// ============================================================================

// 概念帧媒体根路径（与详案 §0.3 /upload/image 落盘端点路径同源；库内 threepov 同惯例 —
//   asset_library/asset_images/<子目录>/<filename>.png）
export const CONCEPT_SUBFOLDER = "concept";
export const CONCEPT_MEDIA_ROOT = `asset_library/asset_images/${CONCEPT_SUBFOLDER}/`;

const EXTRACT_DEFAULT_T = 1.0;
const EXTRACT_MIN_READY_STATE = 2; // HAVE_CURRENT_DATA 起
const EXTRACT_TOBLOB_TIMEOUT_MS = 5000;

function _extractErr(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * 视频抽帧纯函数（生产环境用真实 DOM video/canvas；测试用同套接口 stub 注入）。
 * @param {Object} opts
 *   - video: HTMLVideoElement-like { readyState, videoWidth, videoHeight, currentTime setter, addEventListener('seeked') }
 *   - canvas: HTMLCanvasElement-like { width, height, getContext(), toBlob(cb, mime) }
 *   - t: number (sec, 缺省 1.0)
 * @returns {Promise<Blob>}
 *
 * 失败时 reject 带 code 的 Error:
 *   no_video | video_not_ready | seek_failed | no_canvas_ctx | drawImage_failed |
 *   canvas_toBlob_failed | canvas_toBlob_timeout
 *
 * 注：浏览器侧调用方负责 video.src 加载 + crossOrigin + mute（画布 tainted 必拒 toBlob），
 *      本函数只负责"已就绪视频 → 帧 PNG"。
 */
export function extractFrame(opts) {
  const video = opts && opts.video;
  const canvas = opts && opts.canvas;
  const ts = (opts && typeof opts.t === "number" && isFinite(opts.t)) ? opts.t : EXTRACT_DEFAULT_T;

  if (!video) return Promise.reject(_extractErr("no_video", "缺少 video 元素"));
  if (!canvas) return Promise.reject(_extractErr("no_canvas", "缺少 canvas 元素"));

  const rs = typeof video.readyState === "number" ? video.readyState : -1;
  if (rs < EXTRACT_MIN_READY_STATE) {
    return Promise.reject(_extractErr("video_not_ready", `视频未就绪 (readyState=${rs})`));
  }

  const w = typeof video.videoWidth === "number" && video.videoWidth > 0 ? video.videoWidth : 320;
  const h = typeof video.videoHeight === "number" && video.videoHeight > 0 ? video.videoHeight : 240;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  return new Promise((resolve, reject) => {
    let settled = false;
    function finishReject(code, msg) {
      if (settled) return;
      settled = true;
      reject(_extractErr(code, msg));
    }
    function finishResolve(blob) {
      if (settled) return;
      settled = true;
      resolve(blob);
    }

    const onSeeked = () => {
      const ctx = canvas.getContext && canvas.getContext("2d");
      if (!ctx) { finishReject("no_canvas_ctx", "canvas.getContext('2d') 失败"); return; }
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch (e) {
        finishReject("drawImage_failed", e && e.message ? e.message : String(e));
        return;
      }
      let cbFired = false;
      const safety = setTimeout(() => {
        if (!cbFired) finishReject("canvas_toBlob_timeout", "canvas.toBlob 未回调");
      }, EXTRACT_TOBLOB_TIMEOUT_MS);
      canvas.toBlob((blob) => {
        cbFired = true;
        clearTimeout(safety);
        if (!blob) {
          finishReject("canvas_toBlob_failed", "canvas.toBlob 返回 null（视频无内容/跨域/canvas tainted）");
          return;
        }
        finishResolve(blob);
      }, "image/png");
    };

    const handleErr = () => finishReject("seek_failed", "video seek 失败");

    if (typeof video.addEventListener === "function") {
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", handleErr, { once: true });
    }
    try {
      video.currentTime = ts;
    } catch (e) {
      finishReject("seek_failed", e && e.message ? e.message : String(e));
    }
  });
}

/**
 * 构造概念帧 v3 卡字段（不含卡名——卡名由调用方按 saveCard 自行命名）。
 *
 * 输入:
 *   - prompt: 用户一句话（trim 后入 memo）
 *   - ts: 时间戳串（概念帧唯一前缀·资产库防重名）
 *   - mediaName: 抽帧落盘文件名（默认 concept_<ts>.png；与 /upload/image 返回 name 拼路径）
 * 输出（saveCard 入参 card）:
 *   {
 *     _v: 3,
 *     kind: "character",  // first_frame 入 Picture 池；人物/场景 kind 选 character 与 §0.3 详案语义一致
 *     rows: [{
 *       usage: "first_frame",   // §0.4 用途挂首帧锚定
 *       slot: "1",
 *       media: "asset_library/asset_images/concept/<mediaName>",
 *       desc: "概念帧自动生成 — " + prompt,
 *       ignore_words: ""
 *     }],
 *     tags: ["概念帧"],
 *     memo: prompt (trim),
 *   }
 */
export function buildConceptCard(opts) {
  const prompt = (opts && typeof opts.prompt === "string") ? opts.prompt.trim() : "";
  const ts = (opts && typeof opts.ts === "string") ? opts.ts : "";
  // mediaName 缺则不补——绝对不允许"按 ts 推断"模糊化（防重复/格式漂移），调用方显式传；
  // 两都缺时 media 退 CONCEPT_MEDIA_ROOT（含尾斜杠·空 basename，引擎作为 media 字符串接收亦安全）。
  const mediaName = (opts && typeof opts.mediaName === "string" && opts.mediaName) ? opts.mediaName : "";
  const media = mediaName ? (CONCEPT_MEDIA_ROOT + mediaName) : CONCEPT_MEDIA_ROOT;
  const desc = prompt ? `概念帧自动生成 — ${prompt}` : "概念帧自动生成";
  return {
    _v: 3,
    kind: "character",
    rows: [{
      usage: "first_frame",
      slot: "1",
      media,
      desc,
      ignore_words: "",
    }],
    tags: ["概念帧"],
    memo: prompt,
  };
}

// ============================================================================
// S3-1 T3: 帧锚点拼装（ref 主方案挂用·feat 1）
//   当段提示词 @N 引用一张含 first_frame 用途行的卡 → 末尾自动补"镜头从图片N开始"，
//   引擎侧按此字串识别 → 该段首帧来自指定图片（N 为引擎 Picture 池 @N 编号）。
//   幂等: 提示词已含"镜头从图片"字样则不补（字面前缀匹配·不做同义词识别）。
// ============================================================================

/**
 * 帧锚点拼装纯函数（幂等）。
 * @param {string} promptText - 段原始提示词
 * @param {number|null|undefined} refN - 帧锚点 @N（pickFirstFrameRefForPrompt 析出）
 * @returns {string} 拼装后提示词；refN 非法或已含锚点 → 原样/稍补返回
 */
export function appendFirstFrameAnchor(promptText, refN) {
  const s = (typeof promptText === "string") ? promptText : (promptText == null ? "" : String(promptText));
  const n = Number(refN);
  // 合法 refN = ≥1 整数（registry 从 1 起，槽 9 跳过但 @N 仍 ≥1）
  if (!Number.isFinite(n) || n < 1) return s;
  // 幂等: 已含"镜头从图片"字样 → 不重补（字面前缀匹配·不做 N 数字差异识别）
  if (s.includes("镜头从图片")) return s;
  return s + "镜头从图片" + n + "开始";
}

/**
 * 探测段提示词首个 first_frame @N（按出现顺序）。
 * @param {string} promptText - 段提示词
 * @param {Object} registry - { [n: string]: cardName }
 * @param {Object} assets - { [cardName]: card }
 * @returns {number|null} 首个 first_frame @N；无 → null
 */
export function pickFirstFrameRefForPrompt(promptText, registry, assets) {
  const refs = String(promptText == null ? "" : promptText).match(/@(\d+)/g) || [];
  const reg = (registry && typeof registry === "object") ? registry : {};
  const ast = (assets && typeof assets === "object") ? assets : {};
  for (const rf of refs) {
    const n = +rf.slice(1);
    if (!Number.isFinite(n) || n < 1) continue;
    const cardName = reg[String(n)];
    const card = cardName ? ast[cardName] : null;
    if (!card || !Array.isArray(card.rows)) continue;
    for (const row of card.rows) {
      if (row && row.usage === "first_frame" && row.media) return n;
    }
  }
  return null;
}

// ============================================================================
// S3-2 T6: 裁剪弹窗 (E031 · v43 v26⑫ 全手势复刻) —— 纯逻辑段
//   原型锚: v43 :136-145 (.crop-modal/.crop-stage/.crop-frame CSS) / :1906 (媒体行「裁剪」入口)
//           / :2377-2391 (#cropmodal 结构) / :3015-3026 (open/close/confirm/ESC)
//   框几何口径 = 舞台百分比（与 v43 .crop-frame left/top/width/height = 10/10/80/80 同源），
//   裁剪换算 = 百分比框 → 原图像素矩形 → canvas drawImage 源区（1:1·不缩放）。
// ============================================================================

/** 裁剪产物媒体根路径（与 CONCEPT_MEDIA_ROOT 同惯例：asset_library/asset_images/<子目录>/） */
export const CROP_MEDIA_ROOT = "asset_library/asset_images/crop/";

/** 媒体行「选择文件」上传产物根路径（快批⑥ A3·同上惯例：本机图片经 /upload/image 落库） */
export const UPLOAD_MEDIA_ROOT = "asset_library/asset_images/upload/";

/** 裁剪框最小边（舞台百分比）——拖角/拉伸下限，防框退化成 0 尺寸 */
export const CROP_MIN_PCT = 5;

/**
 * 媒体路径 → thumb 端点可消费的路径（与 views/assets.js 卡面缩略图既有谓词同源·抽此纯函数）。
 * 引擎 thumb 端点按 ComfyUI 根解析相对路径（真机实测：asset_library/… 404、input/asset_library/… 200）。
 * @param {string} media — 卡面 media 字段
 * @returns {string} 相对路径补 input/ 前缀；绝对路径 / 已带 input/ 前缀者原样透传
 */
export function assetThumbPath(media) {
  const s = typeof media === "string" ? media : "";
  if (!s) return "";
  return /^(?:[a-zA-Z]:[\\/]|\/|input[\\/])/i.test(s) ? s : "input/" + s.replace(/^[\\/]+/, "");
}

/** 裁剪框初值 = 中央 80%（v43 .crop-frame 初值：left/top 10%、宽高各 80%） */
export function initialCropFrame() {
  return { l: 10, t: 10, w: 80, h: 80 };
}

/**
 * 舞台盒 = 原图等比内接于可视盒（J-P15 老板报障「裁剪尺寸好像写死了·怎么拖都是细长条」治法）。
 *   框几何按【舞台百分比】、裁剪换算按【原图像素】：两者同源的前提是舞台盒 ≡ 图显示盒。
 *   原先舞台恒为 .crop-stage 定尺横盒、图 object-fit:contain 居中留黑边——竖图只占舞台宽约五成，
 *   选满整图也只裁得五成宽（细长条）。令舞台随图走，黑边消失、口径自洽。
 * @param {number} natW — 原图 naturalWidth
 * @param {number} natH — 原图 naturalHeight
 * @param {number} boxW — 可视盒宽（.crop-stage 定尺实测 rect.width）
 * @param {number} boxH — 可视盒高
 * @returns {{w:number,h:number}} 舞台 CSS 像素尺寸（等比·不放大；任一输入缺失返 {w:0,h:0}）
 */
export function cropStageSize(natW, natH, boxW, boxH) {
  const W = Math.max(0, _cropNum(natW));
  const H = Math.max(0, _cropNum(natH));
  const bw = Math.max(0, _cropNum(boxW));
  const bh = Math.max(0, _cropNum(boxH));
  if (!W || !H || !bw || !bh) return { w: 0, h: 0 };
  const s = Math.min(1, bw / W, bh / H);   // 上限 1×：小图不放大
  return { w: Math.round(W * s), h: Math.round(H * s) };
}

function _cropNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function _clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
// 入参框归一：数值化 + 最小边 + 舞台内钳制（拖拽增量计算的前置口径）
function _frameIn(frame) {
  const f = frame && typeof frame === "object" ? frame : {};
  const w = Math.max(CROP_MIN_PCT, _cropNum(f.w));
  const h = Math.max(CROP_MIN_PCT, _cropNum(f.h));
  return {
    l: _clamp(_cropNum(f.l), 0, 100 - w),
    t: _clamp(_cropNum(f.t), 0, 100 - h),
    w, h,
  };
}

/**
 * 拖框内平移（v26⑫「整体可拖」·手柄语义：mode=move）。
 * @param {{l,t,w,h}} frame — 拖拽起始框（舞台百分比）
 * @param {number} dLeftPct — 横向位移（舞台宽百分比）
 * @param {number} dTopPct — 纵向位移（舞台高百分比）
 * @returns {{l,t,w,h}} 平移后框（不越出舞台·尺寸不变）
 */
export function moveCropFrame(frame, dLeftPct, dTopPct) {
  const f = _frameIn(frame);
  return {
    l: _clamp(f.l + _cropNum(dLeftPct), 0, 100 - f.w),
    t: _clamp(f.t + _cropNum(dTopPct), 0, 100 - f.h),
    w: f.w, h: f.h,
  };
}

/**
 * 拖角/拉伸改框（v26⑫「四角手柄」+「右下角拉伸」）。
 * 语义按角：tl=动左+上 · tr=动上（右边锚定）· bl=动左 · br/se=动右+下（se 为右下大号拉伸柄，与 br 同语义）。
 * @param {{l,t,w,h}} frame — 拖拽起始框
 * @param {"tl"|"tr"|"bl"|"br"|"se"} corner
 * @param {number} dLeftPct — 横向位移（舞台宽百分比）
 * @param {number} dTopPct — 纵向位移（舞台高百分比）
 * @returns {{l,t,w,h}} 改后框（不越出舞台·不小于 CROP_MIN_PCT）
 */
export function resizeCropFrame(frame, corner, dLeftPct, dTopPct) {
  const f = _frameIn(frame);
  const dx = _cropNum(dLeftPct);
  const dy = _cropNum(dTopPct);
  const right = f.l + f.w;
  const bottom = f.t + f.h;
  let l = f.l;
  let tp = f.t;
  let w = f.w;
  let h = f.h;
  if (corner === "tl" || corner === "bl") {
    l = _clamp(f.l + dx, 0, right - CROP_MIN_PCT);
    w = right - l;
  } else {
    w = _clamp(f.w + dx, CROP_MIN_PCT, 100 - f.l);
  }
  if (corner === "tl" || corner === "tr") {
    tp = _clamp(f.t + dy, 0, bottom - CROP_MIN_PCT);
    h = bottom - tp;
  } else {
    h = _clamp(f.h + dy, CROP_MIN_PCT, 100 - f.t);
  }
  return { l, t: tp, w, h };
}

/**
 * 框几何 → 原图裁剪参数（canvas drawImage 源矩形·1:1 不缩放）。
 * @param {{l,t,w,h}} frame — 舞台百分比框
 * @param {number} natW — 原图 naturalWidth
 * @param {number} natH — 原图 naturalHeight
 * @returns {{sx,sy,sw,sh}} 源像素矩形（sw/sh ≥ 1）
 */
export function cropParamsFromFrame(frame, natW, natH) {
  const f = _frameIn(frame);
  const W = Math.max(0, _cropNum(natW));
  const H = Math.max(0, _cropNum(natH));
  return {
    sx: Math.round((f.l / 100) * W),
    sy: Math.round((f.t / 100) * H),
    sw: Math.max(1, Math.round((f.w / 100) * W)),
    sh: Math.max(1, Math.round((f.h / 100) * H)),
  };
}

/**
 * canvas 裁剪：按源矩形 drawImage → toBlob PNG（canvas 注入·单测可 stub·同 extractFrame 惯例）。
 * @param {Object} opts
 *   - img: HTMLImageElement-like（须已加载·naturalWidth/Height 有效）
 *   - canvas: HTMLCanvasElement-like { width, height, getContext(), toBlob(cb, mime) }
 *   - rect: { sx, sy, sw, sh } 源像素矩形
 * @returns {Promise<Blob>}
 * 失败 reject 带 code 的 Error: no_image | no_canvas | no_canvas_ctx | drawImage_failed |
 *   canvas_toBlob_failed | canvas_toBlob_timeout
 */
export function cropImageToBlob(opts) {
  const img = opts && opts.img;
  const canvas = opts && opts.canvas;
  if (!img) return Promise.reject(_extractErr("no_image", "缺少图片元素"));
  if (!canvas) return Promise.reject(_extractErr("no_canvas", "缺少 canvas 元素"));
  const r = (opts && opts.rect) || {};
  const sx = Math.max(0, Math.round(_cropNum(r.sx)));
  const sy = Math.max(0, Math.round(_cropNum(r.sy)));
  const sw = Math.max(1, Math.round(_cropNum(r.sw)));
  const sh = Math.max(1, Math.round(_cropNum(r.sh)));
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) { reject(_extractErr("no_canvas_ctx", "canvas.getContext('2d') 失败")); return; }
    canvas.width = sw;
    canvas.height = sh;
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    } catch (e) {
      reject(_extractErr("drawImage_failed", e && e.message ? e.message : String(e)));
      return;
    }
    let cbFired = false;
    const safety = setTimeout(() => {
      if (!cbFired) reject(_extractErr("canvas_toBlob_timeout", "canvas.toBlob 未回调"));
    }, EXTRACT_TOBLOB_TIMEOUT_MS);
    canvas.toBlob((blob) => {
      cbFired = true;
      clearTimeout(safety);
      if (!blob) { reject(_extractErr("canvas_toBlob_failed", "canvas.toBlob 返回 null（图片未加载/跨域/canvas tainted）")); return; }
      resolve(blob);
    }, "image/png");
  });
}

/** 裁剪产物卡名/文件名共用时间戳戳 "YYYYMMDD-HHMM"（缺省取当前时刻） */
export function cropStamp(ts) {
  if (typeof ts === "string" && ts) return ts;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
// F66: 裁剪产物建新卡链（产物卡名回落 / 建卡模板两纯函数）已随「裁剪改原卡断槽」摘除——
//   确认链改同名覆写原卡 + 原图断槽（dormantAdd），不再经 core 建卡模板。
