// app/js/core/staging_attach.js — 排戏产物卡识别 + 段级视频参考槽存量迁移（#81 D8/D9 清理后：
//   attach/buildCard/cardName/chooseFreeVideoSlot 四导出随排戏台退场·仅存判定与迁移两导出）
//
// 契约:
//   isStagingCardName(name)                     → 卡名是否排戏来源卡（submit.js 装配过滤消费）
//   migrateStagingVideoRefs(project)            → {migrated, residual}（存量迁移·纯函数）
//
// 挂槽目标（档2·零引擎改动）：段级字段 seg.stagingVideoRefs
//   形态: {"1":{media,usages:["video_ref"],cardName},...}（键=槽号字符串·值同 seg_pools 槽值）

const VIDEO_SLOTS = ["1", "2", "3"];   // 视频参考槽三槽（池键=槽号字符串）
const USAGE = "video_ref";

// ===== 段级排戏槽（排戏台挂槽档2 T1）：卡名判定 + 存量迁移 =====
// 段级持久化字段：seg.stagingVideoRefs = { [槽号字符串]: {media, usages, cardName} }
// 排戏卡名形态：排戏_段N_YYYYMMDD-HHMM（N 段号 1 起）
const STAGING_CARD_RE = /^排戏_段(\d+)_/;      // 卡名判定（严格形态·排戏_段N_时间戳）
const STAGING_SEG_NO_RE = /^排戏_段(\d+)/;     // 段号解析（宽松·段号不可解析者计残留）
const STAGING_CARD_PREFIX = "排戏_段";         // 排戏卡名前缀（残留识别·含段号解析失败者）

// 卡名是否排戏来源卡（T3 提交装配过滤批级池同口径）
export function isStagingCardName(name) {
  return typeof name === "string" && STAGING_CARD_RE.test(name);
}

// 卡名 → 段号（1 起）；非排戏卡名/段号不可解析 → null
function stagingCardSegNo(name) {
  if (typeof name !== "string") return null;
  const m = STAGING_SEG_NO_RE.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// 段级排戏槽容器（缺省/脏值 → 补 {}）
function ensureSegRefs(seg) {
  if (!seg.stagingVideoRefs || typeof seg.stagingVideoRefs !== "object" || Array.isArray(seg.stagingVideoRefs)) {
    seg.stagingVideoRefs = {};
  }
  return seg.stagingVideoRefs;
}

// 段级首空视频槽（"1"-"3"）→ 槽号字符串；全占 → null
function firstFreeStagingSlot(seg) {
  const refs = ensureSegRefs(seg);
  for (const s of VIDEO_SLOTS) {
    const occ = refs[s];
    if (!occ || typeof occ !== "object") return s;
  }
  return null;
}

// 段级是否已有同 media 槽（幂等判定·不双占）
function hasSameMedia(seg, media) {
  const refs = seg.stagingVideoRefs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return false;
  for (const k of Object.keys(refs)) {
    const e = refs[k];
    if (e && typeof e === "object" && !Array.isArray(e) && e.media === media) return true;
  }
  return false;
}

// migrateStagingVideoRefs(project)：存量迁移（纯函数·只改传入对象内存态·不落盘）
//   扫 project.poolManual.Video 槽：排戏来源卡（卡名 排戏_段 前缀）→ 解析段号 N
//     - 第 N 段存在且段级有空槽 → 迁入 seg.stagingVideoRefs 首空槽 + 删该批级槽（先写后删）
//     - 段级已有同 media → 删该批级槽（幂等·不双占）
//     - N 越界 / 段级满 / 段号解析失败 → 留原地，计入 residual（可见可 × 清理·不丢数据）
//   返回 {migrated, residual}
export function migrateStagingVideoRefs(project) {
  const out = { migrated: 0, residual: 0 };
  if (!project || typeof project !== "object" || Array.isArray(project)) return out;
  const pm = project.poolManual;
  const video = pm && typeof pm === "object" && !Array.isArray(pm) ? pm.Video : null;
  if (!video || typeof video !== "object" || Array.isArray(video)) return out;
  const segs = Array.isArray(project.segments) ? project.segments : [];
  for (const slot of Object.keys(video)) {
    const entry = video[slot];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const cardName = typeof entry.cardName === "string" ? entry.cardName : "";
    if (!cardName.startsWith(STAGING_CARD_PREFIX)) continue;   // 非排戏来源槽·原样不动
    try {
      const segNo = stagingCardSegNo(cardName);
      const media = typeof entry.media === "string" ? entry.media : "";
      if (segNo === null || !media) { out.residual++; continue; }            // 段号解析失败 → 留原地
      const seg = segs[segNo - 1];
      if (!seg || typeof seg !== "object") { out.residual++; continue; }      // 段越界 → 留原地
      if (hasSameMedia(seg, media)) { delete video[slot]; out.migrated++; continue; }  // 幂等·不双占
      const free = firstFreeStagingSlot(seg);
      if (!free) { out.residual++; continue; }                                // 段级满 → 留原地
      // 先写段级（落盘口径：先写后删·中途异常=段级已写批级未删·提交侧同卡去重兜底·不丢数据）
      ensureSegRefs(seg)[free] = {
        media,
        usages: Array.isArray(entry.usages) ? entry.usages.slice() : [USAGE],
        cardName,
      };
      delete video[slot];
      out.migrated++;
    } catch (_e) {
      out.residual++;   // 异常 → 留原地·可见可清（不丢数据）
    }
  }
  return out;
}
