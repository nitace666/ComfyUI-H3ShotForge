// core/bindings.js — 角色绑定域纯函数（批 8 T1 自 legacy GUI1.0 domain/bindings.js 迁移）.
//
// 职责:
//   1. castBindings 数组的不可变 CRUD (nextBindingNo / upsertBinding / removeBinding /
//      removeBindingSlot).
//   2. 从分配器结果 (filled[]) 反推 binding entry (bindingEntryFromFill) — 关键:
//      按 filled[i].rowIndex 精确取 cardRows[rowIndex], 跳过 skipped 行后不会错配.
//   3. 解析回填值 (parseBindingsJson) — 接受 JSON 字符串或数组, 非法静默返回 ok:false.
//
// 引擎契约 (只读): bindings = [{name:str, no:int, slots:[{idx:int, kind, usage,
//   media, desc, ignore_words?}]}]; 非法 entry 引擎静默跳过 (engine/__init__.py:255-302),
//   故本文件对 no/idx 必须锁 int 类型.
//
// 零 DOM / 零存储副作用; 调用方（批 8 T3/T4 接线）拿返回的新数组走 store.setCastBindings 落盘.

/**
 * 计算下一个可用 no: 现有 max(no) + 1; 空表 → 1.
 * 防御: 非数组 / 非法 no (非 int) 跳过; max 起步 0.
 *
 * @param {Array<{no:number}>} list castBindings 数组
 * @returns {number}
 */
export function nextBindingNo(list) {
  if (!Array.isArray(list)) return 1;
  let max = 0;
  for (const b of list) {
    if (b && Number.isInteger(b.no) && b.no > max) max = b.no;
  }
  return max + 1;
}

/**
 * 从 filled + cardRows 反推一条 binding entry (用于 "分配即绑定").
 *
 * 关键: 按 filled[i].rowIndex 精确取 cardRows[rowIndex] — 不得按顺序消费,
 * 否则有 skipped 行时会错配 (与引擎自带前端 snapshotBindingSlotsFromResult
 * 顺序配对的已知缺陷对齐).
 *
 * 只把 Picture 槽写进 binding slots. 引擎把绑定槽 media 硬编码写进
 *   pool_copy["Picture"][slot] (batch_core.py), 若放行 Audio/Video 行会把
 *   mp3 / mp4 路径写到画面槽, 同 idx 跨 kind 还会相互覆盖. 卡编辑器 usage 是
 *   自由文本, audio_ref/video_ref 都在 USAGE_BY_KIND 里, 落到卡上就会被
 *   computeAssignResult 算成非 Picture filled, 故必须在此显式过滤.
 *
 * media/desc 走 cardRows 原文 (trim 后); ignore_words 仅当卡行有非空字符串时写入键.
 *
 * @param {object} args
 * @param {string} args.cardName 卡名 → entry.name
 * @param {number} args.no Subject 编号 (int; 由 nextBindingNo 产出)
 * @param {Array<{rowIndex:number, idx:number, kind:string, value:string, usages:string[]}>} args.filled
 * @param {Array<{usage:string, slot:number, media:string, desc:string, ignore_words?:string}>} args.cardRows
 * @returns {{name:string, no:number, slots:Array<{idx:int, kind:string, usage:string, media:string, desc:string, ignore_words?:string}>}}
 */
export function bindingEntryFromFill({ cardName, no, filled, cardRows }) {
  if (!Number.isInteger(no)) {
    throw new TypeError("bindingEntryFromFill: no must be integer (got " + String(no) + ")");
  }
  const rows = Array.isArray(cardRows) ? cardRows : [];
  const list = Array.isArray(filled) ? filled : [];
  const slots = [];
  for (const f of list) {
    if (!f || !Number.isInteger(f.idx)) continue;
    // 只放 Picture — 引擎绑定槽只写 Picture 池, 非 Picture 槽会把音频/视频路径
    // 写到画面槽 (见上方注释). f.kind 是 computeAssignResult 算出的真实 kind,
    // 与 _USAGE_KIND[usage] 一致; 空值也视为非 Picture 跳过 (防御空 kind 走到
    // 下游引擎被静默跳过).
    if ((f.kind || "") !== "Picture") continue;
    const row = rows[f.rowIndex];
    if (!row) continue;
    const slot = {
      idx: f.idx,
      kind: f.kind || "",
      usage: row.usage || ((f.usages && f.usages[0]) || ""),
      media: (row.media || "").toString().trim(),
      desc: (row.desc || "").toString(),
    };
    const ig = (row.ignore_words || "").toString().trim();
    if (ig) slot.ignore_words = ig;
    slots.push(slot);
  }
  return { name: String(cardName || ""), no, slots };
}

/**
 * 不可变 upsert: 同名 → 更新 slots 保留原 no; 异名 → 追加.
 *
 * @param {Array<{name:string, no:number, slots:Array}>} list
 * @param {{name:string, no:number, slots:Array}} entry
 * @returns {Array} 新数组 (原数组不变)
 */
export function upsertBinding(list, entry) {
  const arr = Array.isArray(list) ? list : [];
  if (!entry || !entry.name) return arr.slice();
  const idx = arr.findIndex((b) => b && b.name === entry.name);
  if (idx >= 0) {
    const orig = arr[idx];
    return [
      ...arr.slice(0, idx),
      { ...orig, slots: entry.slots || [] },
      ...arr.slice(idx + 1),
    ];
  }
  return arr.concat([{ name: entry.name, no: entry.no, slots: entry.slots || [] }]);
}

/**
 * 不可变 remove: 同名 → 移除; 异名 → 原样; 不在 → 原样.
 *
 * @param {Array<{name:string}>} list
 * @param {string} name
 * @returns {Array} 新数组 (原数组不变)
 */
export function removeBinding(list, name) {
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex((b) => b && b.name === name);
  if (idx < 0) return arr.slice();
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

/**
 * 不可变 removeSlot: 同名条目下, 删除 idx === slotIdx 的那一项.
 * 删完 slots 为空 → 整条移除; name 不存在 / slotIdx 不匹配 → 等价新 list (内容不变).
 * 池域释放槽位时通过该纯函数算出新 list, 再由调用方走 store.setCastBindings 写入.
 *
 * @param {Array<{name:string, slots:Array}>} list
 * @param {string} name
 * @param {number} slotIdx
 * @returns {Array} 新数组 (原数组与条目均不变)
 */
export function removeBindingSlot(list, name, slotIdx) {
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex((b) => b && b.name === name);
  if (idx < 0) return arr.slice();
  const entry = arr[idx];
  const slots = Array.isArray(entry.slots) ? entry.slots : [];
  const filtered = slots.filter((s) => s && Number.isInteger(s.idx) && s.idx !== slotIdx);
  // slots 长度未变 → 不匹配, 返回等价新数组 (slice 而非原数组, 维持不可变语义)
  if (filtered.length === slots.length) return arr.slice();
  if (filtered.length === 0) {
    // 整条移除
    return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
  }
  return [
    ...arr.slice(0, idx),
    { ...entry, slots: filtered },
    ...arr.slice(idx + 1),
  ];
}

/**
 * 解析回填值 (兼容 JSON 字符串与数组).
 * 非法 → {ok:false, list:[]} 不抛错.
 *
 * 数组形态下做条目级过滤, 丢弃非法条目 (引擎容忍空 entry 但前端主动过滤可避免
 * 脏数据进 castBindings). 不抛错, 计数走 console.warn.
 *   - 非对象 (null / 数组 / 字符串 / 数字) 丢弃.
 *   - name 非字符串或空串 — 丢弃; 引擎容忍空名, 但前端无意义条目占位, 故主动过滤.
 *   - no 非整数 — 丢弃.
 *   - slots 缺省或非数组 — 视为 [] (与引擎 b.get("slots") or [] 同口径).
 *   - slots 项 idx 非整数 — 该 slot 丢弃, 其他 slot 保留.
 *
 * @param {string|Array|null|undefined} v
 * @returns {{ok:boolean, list:Array}}
 */
export function parseBindingsJson(v) {
  let raw;
  if (Array.isArray(v)) { raw = v; }
  else if (typeof v === "string" && v) {
    try { raw = JSON.parse(v); } catch (_) { return { ok: false, list: [] }; }
  } else { return { ok: false, list: [] }; }
  if (!Array.isArray(raw)) return { ok: false, list: [] };

  const out = [];
  let droppedEntries = 0;
  let droppedSlots = 0;
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) { droppedEntries++; continue; }
    if (typeof e.name !== "string" || !e.name) { droppedEntries++; continue; }
    if (!Number.isInteger(e.no)) { droppedEntries++; continue; }
    const slotsIn = Array.isArray(e.slots) ? e.slots : [];
    const slotsOut = [];
    for (const s of slotsIn) {
      if (!s || typeof s !== "object") { droppedSlots++; continue; }
      if (!Number.isInteger(s.idx)) { droppedSlots++; continue; }
      slotsOut.push(s);
    }
    out.push({ name: e.name, no: e.no, slots: slotsOut });
  }
  if (droppedEntries > 0 || droppedSlots > 0) {
    if (typeof console !== "undefined") {
      console.warn(`[bindings.parseBindingsJson] 过滤丢弃: 条目 ${droppedEntries}, slot ${droppedSlots}`);
    }
  }
  return { ok: true, list: out };
}
