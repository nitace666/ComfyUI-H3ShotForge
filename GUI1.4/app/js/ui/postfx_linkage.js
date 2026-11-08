// postfx_linkage.js — 参数单驱动源联动状态机（DOM 无关纯函数·两页共享）
//
// 出处：账本 #32（三件补做批 T6·挂 R-56·取代 2026-10-15 R-56 裁决③「参数页二选一无联动·
//   联动只在剪辑页」——口径替换链见方案-三件补做批-2026-10-18.md §1.2.2）。
// 两页同规则③：setup.js buildPostProcGroup 与 edit.js buildPostfxAdvanced 各持一份 state，
//   input 事件 → postfxLinkStep() → 写值(writes) + 置 disabled/title/placeholder(gates)；
//   本模块不碰 DOM（segcards.js moveDirGate「只改 disabled/title·不清值」先例的推广形态）。
//
// 联动矩阵（有基准 base={w,h}；定稿见方案 §二 T6）：
//   全空       → 三框可编辑
//   填倍数     → 宽/高 = evenAlign(基准×倍数) 自动填 + 只读；倍数可编辑
//   清倍数     → 宽/高释放（保留值·不重新驱动）
//   填宽/高    → 另一维按源比例自动填 + 只读；倍数回写 toFixed(1) + 只读；驱动者可编辑
//   清驱动源   → 三框释放（倍数保留回写值·不重新驱动）
// 无基准退化（方案审 A4）：倍数驱动 = 只锁不填（宽高留空 + 占位「按倍数自动」）；
//   宽/高驱动 = 不锁可手填（防成对校验死锁·edit.js parse 宽高成对为第二道）。
// 释放语义：只解 disabled/title，不清任何值；残留自动值不重新驱动——重触输入才再立规。
// 帧率（插帧组）不在联动域（gates 恰 scale/w/h 三键·超分与插帧互不影响④）。

// 四舍五入偶数对齐（视频编码惯例·亚像素偏差 <0.5% 不构成拉伸；自 edit.js :6483 收编单源）
export function evenAlign(n) { return n > 0 ? Math.round(n / 2) * 2 : 0; }

// #32 修复（2026-10-20）：基准纯算——比例×质量（百万像素）→ 基准 {w,h}，引擎 batch_core.py:3061-3074 复刻。
//   舍入=半偶（B2·Python round 同款：62.5→62 非 63）；16 对齐；下限 256；比例/质量容忍标签后缀
//   （「16:9 横屏」「1.0 · 高清」取首对数字·#42 知悉）。探不到（不可解析/非正）→ null=无基准。
function _roundHalfEven(n) {
  const f = Math.floor(n);
  const d = n - f;
  if (d > 0.5 || (d === 0.5 && f % 2 === 1)) return f + 1;
  return f;
}
export function postfxBaseFromRatioMP(ratioRaw, mpRaw) {
  const rm = String(ratioRaw == null ? "" : ratioRaw).trim().match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/);
  const mm = String(mpRaw == null ? "" : mpRaw).trim().match(/\d+(?:\.\d+)?/);
  if (!rm || !mm) return null;
  const ratio = Number(rm[1]) / Number(rm[2]);
  const mp = Number(mm[0]);
  if (!(ratio > 0) || !(mp > 0)) return null;
  const area = mp * 1_000_000;
  return {
    w: Math.max(256, _roundHalfEven(Math.sqrt(area * ratio) / 16) * 16),
    h: Math.max(256, _roundHalfEven(Math.sqrt(area / ratio) / 16) * 16),
  };
}

const PH_AUTO = "按倍数自动";
// 锁定原因 title（白话·点出恢复方式——segcards.js moveDirGate 同口径）
const T_WH_BY_SCALE = "已填放大倍数——宽/高按倍数自动·已锁定（清除倍数后恢复编辑）";
const T_H_BY_W = "已填目标宽——高按源比例自动·已锁定（清除宽后恢复编辑）";
const T_W_BY_H = "已填目标高——宽按源比例自动·已锁定（清除高后恢复编辑）";
const T_SCALE_BY_W = "已填目标宽——放大倍数按宽自动回写·已锁定（清除宽后恢复编辑）";
const T_SCALE_BY_H = "已填目标高——放大倍数按高自动回写·已锁定（清除高后恢复编辑）";

function free() { return { disabled: false, title: "", placeholder: null }; }
function lock(title) { return { disabled: true, title, placeholder: PH_AUTO }; }

function posBase(base) {
  return base && base.w > 0 && base.h > 0 ? base : null;
}

// 门控投影：state + 基准 → 三框 {disabled,title,placeholder}（placeholder 仅锁定的宽/高带「按倍数自动」；
//   null = 接线层恢复各自静态占位）
export function postfxLinkGates(state, base) {
  const hasBase = !!posBase(base);
  switch (state && state.driver) {
    case "scale":
      return { scale: free(), w: lock(T_WH_BY_SCALE), h: lock(T_WH_BY_SCALE) };
    case "w":
      return hasBase
        ? { scale: lock(T_SCALE_BY_W), w: free(), h: lock(T_H_BY_W) }
        : { scale: free(), w: free(), h: free() };
    case "h":
      return hasBase
        ? { scale: lock(T_SCALE_BY_H), w: lock(T_W_BY_H), h: free() }
        : { scale: free(), w: free(), h: free() };
    default:
      return { scale: free(), w: free(), h: free() };
  }
}

export function postfxLinkInitialState() {
  return { driver: null };
}

// 初值治理（重开回填）：store 有倍数 = 倍数驱动生效（编排层倍数优先同源）；
//   倍数空（宽高值在）→ 释放态全可编辑（驱动源不可考·待重触输入立规）。
export function postfxLinkInitGates(values) {
  const v = values && typeof values === "object" ? values : {};
  const scale = typeof v.scale === "string" ? v.scale.trim() : "";
  const state = { driver: scale !== "" ? "scale" : null };
  return { state, gates: postfxLinkGates(state, null) };
}

// 单步演化：ev = { field: "scale"|"w"|"h", raw: 输入框原串 }；base = {w,h} | null。
// 返回 { state, writes, gates }——writes 仅含应写入值（接线层直写 .value，不派发 input 防重入）。
// 规则：非空输入 = 该字段立为驱动源（重触立规）；删空驱动源 = 释放；删空非驱动字段 = 单独清值无联动。
export function postfxLinkStep(state, ev, base) {
  const field = ev && ev.field;
  const raw = typeof ev.raw === "string" ? ev.raw.trim() : "";
  const b = posBase(base);
  const writes = {};
  let driver = state && state.driver ? state.driver : null;

  if (raw !== "" && (field === "scale" || field === "w" || field === "h")) {
    driver = field;
    const n = Number(raw);
    if (field === "scale") {
      if (b && n > 0) {
        writes.w = String(evenAlign(b.w * n));
        writes.h = String(evenAlign(b.h * n));
      } // 无基准/非正数 → 只锁不填（不编造；parse 白话拒为第二道）
    } else if (b && n > 0) {
      if (field === "w") {
        writes.h = String(evenAlign(n * b.h / b.w));
        writes.scale = (n / b.w).toFixed(1);
      } else {
        writes.w = String(evenAlign(n * b.w / b.h));
        writes.scale = (n / b.h).toFixed(1);
      }
    } // 无基准宽/高驱动 → 不锁可手填（防成对校验死锁）·无回写
  } else if (raw === "" && driver === field) {
    driver = null; // 清驱动源 → 释放（值保留·不重新驱动）
  } // 其余（删空非驱动字段/未知字段）→ 无联动

  const next = { driver };
  return { state: next, writes, gates: postfxLinkGates(next, base) };
}
