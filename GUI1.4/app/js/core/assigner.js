// core/assigner.js — 分配器纯函数（批 8 T1 自 legacy GUI1.0 domain/assigner.js 迁移
//   + 批 8 T3 增 applyCardToStore 与分配槽域收紧）.
//
// 纯函数清单:
//   1. computeAssignResult(card, currentPool, slotMax?) — 输入 v3 档案卡 + 当前素材池快照,
//      逐行计算 "该行该不该填, 填到哪个 idx, 还是被跳过"（填目标槽 / 同 kind 同 media
//      共占 / 向后顺延 / 跳过→覆盖按钮路径）.
//   2. parseAssetPayload(dataTransfer) — 拖拽 MIME 死约定 ASSET_DT_MIME 载荷
//      ({name, kind, rows, media} JSON) 解析.
//   3. applyCardToStore(card, name, state) — 批 8 T3: legacy applyCardToForm
//      （:184-253·约 70 行 DOM 耦合）零迁移, 以本函数适配 1.3 store; 调用方
//      （分配器面板）拿返回的新容器走 store.setPoolManual/setCastBindings 落盘.
//
// 槽位/用途常量随迁（legacy core/state.js / domain/assets.js 同值·语义保留）:
//   POOL_SLOTS / _USAGE_KIND（由 USAGE_BY_KIND 反向构造·单一真值源）/ ASSET_DT_MIME.

import { nextBindingNo, bindingEntryFromFill, upsertBinding } from "./bindings.js";

// 引擎侧仍按 1-9 槽解析, 表单只给 Video/Audio 3 槽（legacy core/state.js 同值）
export const POOL_SLOTS = { Picture: 9, Video: 3, Audio: 3 };

// 批 8 T3：分配器调用层槽域收紧（v3-2 甲 P10）——Picture 1-8（9 保留给绑定域/
//   引擎 pose 动态衔接，与 submit.js POSE_SLOT_MAX=8/POSE_SLOT_SKIP=9 同口径）；
//   Video/Audio 不变 1-3。仅 applyCardToStore 消费；computeAssignResult 缺省
//   第三参时保持 legacy 9 槽口径（T1 迁移零行为变更）。
export const ASSIGN_SLOT_MAX = Object.freeze({ Picture: 8, Video: 3, Audio: 3 });

// 用途→kind 源表（逐字对齐引擎 batch_core.py USAGE_REGISTRY 十项·legacy 同值）
const USAGE_BY_KIND = {
  Picture: ["subject_look", "subject_outfit", "subject_prop", "三视图", "scene", "pose", "first_frame", "道具多角度"],
  Video:   ["video_ref"],
  Audio:   ["audio_ref"],
};

// usage → kind 反向索引（从 USAGE_BY_KIND 反向构造, 零漂移）
export const _USAGE_KIND = {};
for (const [k, ids] of Object.entries(USAGE_BY_KIND)) {
  for (const id of ids) _USAGE_KIND[id] = k;
}

// DnD 跨任务契约 MIME 死约定（legacy domain/assets.js 同值）
export const ASSET_DT_MIME = "application/x-h3-asset";

/**
 * 分配器核心决策函数 — legacy 旧 V1.11 web/js/assets.js L130-193 迁移版.
 *
 * 输入 v3 档案卡的 rows + 当前素材池快照 (Picture/Video/Audio 三层 dict, 槽位为字符串键),
 * 逐行计算"该行该不该填, 填到哪个 idx, 还是被跳过":
 *
 *   跳过规则 (rows 静默丢弃 / pushed 到 skipped):
 *     - media 空 → 静默 (不入 skipped)
 *     - usage 不在 _USAGE_KIND (kind 缺失) → 静默
 *     - 卡内 slot 非法 (NaN / ≤0) → skipped (不强行落 1)
 *     - 目标槽被 currentPool 占用, 且 filledSet 中无同 kind+同 media 行可共占,
 *       且 target+1..max 也无空槽 → skipped
 *
 *   填充规则:
 *     - 目标槽 (currentPool + filledSet 都没占) → 直接填 target
 *     - 已填集合中找 同 kind + 同 media → 共占那行的 idx (跨槽同图也能命中)
 *     - 否则向后顺延: target+1..max 找首个"空且不在 filledSet"
 *
 * @param {object} card v3 档案卡, 必含 rows 数组
 * @param {object} currentPool {Picture:{idx:value}, Video:{}, Audio:{}}; 槽位为字符串键; 入参不改写
 * @param {object} [slotMax] 显式分配域（如 ASSIGN_SLOT_MAX）——传入时 target 超域 → skipped
 *   （批 8 T3 Picture 收紧 1-8：9 号不分配）；缺省 = POOL_SLOTS legacy 口径零行为变更
 * @returns {{filled: Array<{rowIndex:int, kind, idx, target, value, usages}>,
 *           skipped: Array<{rowIndex:int, kind, idx, target, value, usages}>}}
 */
export function computeAssignResult(card, currentPool, slotMax) {
  const filled = [];
  const skipped = [];
  if (!card || !Array.isArray(card.rows)) return { filled, skipped };

  // 已填集合 (本函数内已落池的槽, 行序先到先得)
  const filledSet = {};  // {kind: Set<int>}
  const ensureKind = (k) => { if (!filledSet[k]) filledSet[k] = new Set(); return filledSet[k]; };

  const isSlotTaken = (kind, slot) => {
    const inPool = currentPool[kind] && currentPool[kind][String(slot)] && String(currentPool[kind][String(slot)]).trim();
    return !!inPool || (filledSet[kind] && filledSet[kind].has(slot));
  };

  // 已填集合中查找 同 kind + 同 media 的行, 返回该行的实际 idx (不限槽号); 找不到返回 0
  const findSameMediaFilledIdx = (kind, media) => {
    for (const f of filled) {
      if (f.kind === kind && f.value === media) return f.idx;
    }
    return 0;
  };

  for (let rowIndex = 0; rowIndex < card.rows.length; rowIndex++) {
    const row = card.rows[rowIndex];
    const media = (row && row.media || "").toString().trim();
    if (!media) continue;
    const slot = (row.slot || "").toString();
    const usage = row.usage;
    const kind = _USAGE_KIND[usage];
    if (!kind) continue;
    const slotUsages = [usage];
    const target = parseInt(slot, 10);
    // 卡内槽号非法 (NaN/≤0) → 跳过
    if (!target || target < 1) {
      skipped.push({ rowIndex, kind, idx: target || 0, target: target || 0, value: media, usages: slotUsages });
      continue;
    }
    const max = (slotMax && slotMax[kind]) || POOL_SLOTS[kind] || 9;
    // 批 8 T3：显式收紧域下 target 超域（如 Picture 9）→ skipped（9 号不分配）;
    //   缺省路径不设此闸（legacy 超域 target 直填口径保留——T1 迁移零行为变更）
    if (slotMax && target > max) {
      skipped.push({ rowIndex, kind, idx: target, target, value: media, usages: slotUsages });
      continue;
    }
    // 目标槽为空 + 不在已填集合 → 直接填 target
    if (!isSlotTaken(kind, target)) {
      filled.push({ rowIndex, kind, idx: target, target, value: media, usages: slotUsages });
      ensureKind(kind).add(target);
      continue;
    }
    // 已填集合中找 同 kind + 同 media → 共占该行 idx
    const coOccupyIdx = findSameMediaFilledIdx(kind, media);
    if (coOccupyIdx > 0) {
      filled.push({ rowIndex, kind, idx: coOccupyIdx, target, value: media, usages: slotUsages });
      continue;
    }
    // 否则向后顺延: target+1 .. max 找首个空槽
    let chosen = 0;
    for (let s = target + 1; s <= max; s++) {
      if (!isSlotTaken(kind, s)) { chosen = s; break; }
    }
    if (chosen > 0) {
      filled.push({ rowIndex, kind, idx: chosen, target, value: media, usages: slotUsages });
      ensureKind(kind).add(chosen);
      continue;
    }
    // 找不到空槽 → skipped (保留覆盖按钮路径)
    skipped.push({ rowIndex, kind, idx: target, target, value: media, usages: slotUsages });
  }
  return { filled, skipped };
}

/**
 * 从 drop 事件 dataTransfer 解 MIME 死约定 payload.
 *
 * @param {DataTransfer|null|undefined} dataTransfer
 * @returns {object|null} {name, kind, rows, media} | null
 */
export function parseAssetPayload(dataTransfer) {
  if (!dataTransfer) return null;
  let raw = "";
  try { raw = dataTransfer.getData(ASSET_DT_MIME) || ""; } catch (_) { return null; }
  if (!raw) return null;
  let p = null;
  try { p = JSON.parse(raw); } catch (_) { return null; }
  if (!p || typeof p !== "object") return null;
  return p;
}

/**
 * 批 8 T3：单卡分配 store 版 — legacy applyCardToForm（:184-253）的纯函数适配.
 *
 * 与 DOM 版的对应关系:
 *   - 快照池: poolInputs DOM 读值 → 入参 state.poolManual（store 手动槽容器）
 *   - 写回:   input.value + 用途胶囊 → 返回新 poolManual 容器（media 覆写 +
 *     usages 并集 + cardName 来源标记；不可变——入参不改写）
 *   - 绑定链: opts.asBinding 且 character 卡 → nextBindingNo + bindingEntryFromFill
 *     + upsertBinding 产出新 castBindings 数组（同名卡保号·异名 nextBindingNo）
 *   - skipped: 不再挂 DOM 覆盖按钮——原样返回（供面板挂「覆盖 (卡名)」入口，
 *     完整交互归 T5 手动槽任务）
 *
 * store 写入（setPoolManual/setCastBindings）由调用方执行——core 保持纯函数、
 * 与视图分离。分配域走 ASSIGN_SLOT_MAX（Picture 收紧 1-8）.
 *
 * @param {object} card v3 档案卡 {_v:3, kind, rows}
 * @param {string} name 卡名
 * @param {object} [state] { poolManual?, castBindings?, asBinding?:boolean }
 * @returns {{filled: Array, skipped: Array, line: string, binding: object|null,
 *            poolManual: object|null, castBindings: Array|null}}
 *   poolManual/castBindings = null 表示该域无变更（调用方跳过写入）
 */
export function applyCardToStore(card, name, state) {
  const s = (state && typeof state === "object") ? state : {};
  const poolIn = (s.poolManual && typeof s.poolManual === "object") ? s.poolManual : { Picture: {}, Video: {}, Audio: {} };
  const listIn = Array.isArray(s.castBindings) ? s.castBindings : [];
  const asBinding = s.asBinding === true;

  // 1. poolManual → computeAssignResult 快照形态 {kind:{槽号串: media}}
  const KINDS = ["Picture", "Video", "Audio"];
  const currentPool = {};
  for (const k of KINDS) {
    const slots = {};
    const kindObj = (poolIn[k] && typeof poolIn[k] === "object" && !Array.isArray(poolIn[k])) ? poolIn[k] : {};
    for (const key of Object.keys(kindObj)) {
      const entry = kindObj[key];
      const media = (entry && typeof entry.media === "string") ? entry.media.trim() : "";
      if (media) slots[key] = media;
    }
    currentPool[k] = slots;
  }
  // 2. 计算分配（收紧域：Picture 1-8 · 9 号不分配）
  const r = computeAssignResult(card, currentPool, ASSIGN_SLOT_MAX);
  // 3. filled → 新 poolManual 容器（拷贝旧槽 + 覆写命中槽）
  let nextPoolManual = null;
  if (r.filled.length > 0) {
    nextPoolManual = {};
    for (const k of KINDS) {
      const kindObj = (poolIn[k] && typeof poolIn[k] === "object" && !Array.isArray(poolIn[k])) ? poolIn[k] : {};
      nextPoolManual[k] = Object.assign({}, kindObj);
    }
    for (const f of r.filled) {
      const prev = nextPoolManual[f.kind][String(f.idx)];
      const usages = new Set(prev && Array.isArray(prev.usages) ? prev.usages : []);
      for (const u of f.usages) usages.add(u);
      nextPoolManual[f.kind][String(f.idx)] = {
        media: f.value,
        usages: [...usages],
        cardName: name,
      };
    }
  }
  // 4. 分配即绑定 — 仅 character 卡 + asBinding + 有 filled（legacy :243 同口径）
  let nextCastBindings = null;
  let binding = null;
  if (asBinding && card && card.kind === "character" && r.filled.length > 0) {
    const existing = listIn.find((b) => b && b.name === name);
    const no = existing ? existing.no : nextBindingNo(listIn);
    binding = bindingEntryFromFill({ cardName: name, no, filled: r.filled, cardRows: card.rows });
    nextCastBindings = upsertBinding(listIn, binding);
  }
  // 5. 反馈文案（kindLabel 内派；skipped 列明供覆盖入口）
  const kindLabel = (card && card.kind === "character") ? "角色"
    : (card && card.kind === "scene") ? "场景" : "资产";
  const filledDesc = r.filled.map((f) => f.kind + " 槽 " + f.idx).join("、") || "(无)";
  const skippedDesc = r.skipped.length
    ? " 跳过 " + r.skipped.map((x) => x.kind + " 槽 " + x.idx).join("、") + "（已占用 · 覆盖入口见面板）"
    : "";
  const line = kindLabel + " 「" + name + "」 → 分配 " + filledDesc + skippedDesc;
  return { filled: r.filled, skipped: r.skipped, line, binding, poolManual: nextPoolManual, castBindings: nextCastBindings };
}
