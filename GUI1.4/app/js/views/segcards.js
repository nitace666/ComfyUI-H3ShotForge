// segcards.js — 段卡区模块（GUI1.3 S1-2 T3）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 段卡区 :1380-1551（分镜表 colfold + segList + 加一段）
//   - 段卡 HTML :1384-1547（4 张静态卡 · 全部字段）
//   - 段卡 CSS 散见 :281-289（badge 族）/ :448-502（sc-*）
//   - 段卡 CSS :872-878（.sc-procs · sc-sr-mode）——控件随 T4 #31 撤除退役（CSS 留休眠）
//   - 处理器函数 :3375（segFold）/:3383（selCard）/:3392（cardEdit）/:3561（advToggle）/:3567（delSeg）/:3595（addSeg）
//   - 项目模式 :1145（分镜/拼接/自定义 · v25 W6）
//
// === 任务边界 ===
// 本任务（T3）实装：段卡区全量（就地编辑 / 高级区六列 / 种子双向 / 拖拽排序 / 徽标）
// 不实装：pv-bar/pv-pre 预览正文（归 T5）/ 状态徽章 st-run/st-ok 真实值（归 T6/S1-3 引擎轮询）/
//   全局提示词追加（归 T5）/ 资产卡拖入段卡（归 T4）/ 段级弹窗（精修/优化 · 归后续）
//
// S1-2 T5 增量：
//   - rerenderSegcardsByProject(projectId) 顶栏 projMode 变更 → 段徽标重派生 / 拼接 chk 联动
//   - 模块级 _mountedInstances 跟踪各 projectId 的 rerender 闭包
//
// === API ===
//   SC_FIELDS            12 字段描述（label/key/control）
//   SC_LENS_KEYS / SC_ADV_KEYS  镜头九项（紧凑条展开容器内）/ 高级区三项（#79 回炉）
//   buildCameraSummary(obj)     镜头六件已选值 → 卡面摘要串（#69 C2·全空空串·超长截断）
//   stagingRefsList(seg)        段级排戏槽列表（原始槽·展示层口径·#79 参考管理）
//   clearStagingSlot(project,segId,slot)  段级排戏槽清空（× 写回·与 pvbox 共享同实现）
//   FIELD_OPTS           字段→选项列表（select 选项 / cbox data-opts）· 九镜头项 = 引擎 shot_vocab 全集（#77 A1）
//   （SR_MODE_OPTS/SC_PROC_FIELDS 段级后处理常量随 T4 #31 三勾选撤除一并退役）
//   deriveBadge({projMode, segIndex, total})   段位徽标 {label, cls, title}
//   deriveStatusBadge(state)                   状态徽章 {cls, text}（本批默认 wait）
//   buildSeedPatch(value)                      双向联动统一入口 → {seed}
//   buildMoveCall({fromDomIdx, toDomIdx, projectId})  拖拽→store.moveSegment 参数
//   moveDirGate(moveValue)                     运镜方式→方向可用性（#77 A3：{disabled, allowed?, title}）
//   migrateLegacyCameraFields(project)         存量镜头词表迁移（#77 A2·落盘·幂等）
//   _recognizeStroke(points) / strokeToSegPatch(result)   手写笔迹识别 + 段字段映射（#77 A4·识别输出直写）
//   openStrokeModal({onPatch})                 手写选运镜浮层（G5 入口）
//   buildInlinePreviewBody(formData, segIndex) 引擎预览请求体（T5·api.md #10）
//   fetchInlinePreview(body, {signal})         POST /h3_batch/preview_prompt（T5·带在途取消）
//   createInlinePreviewChain({...})            400ms 防抖 + 在途取消链（T5）
//   consumeJumpAnchor(root, opts)              消费 gui13.gotoSeg 锚 → 行 scrollIntoView + 1.5s 闪烁（T4②）
//   mount(container, projectId)                渲染段卡区入容器
//   rerenderSegcardsByProject(projectId)       按 projectId 重渲染（顶栏 projMode 变更入口）
//   readSegView/writeSegView(storage)         表/卡墙视图态（持久化 gui13.segview·B5-T6 G6）
//   wallStatusKey(clip)/thumbUrlOf(file)      卡墙状态角标 / 缩略图 URL（B5-T6 G6）
//   openOptimizeModal(seg, opts)              ✦ 一键优化弹层（真生成：sendChat·见下方注释）
//   readOptModel(storage)                     优化弹层模型预设名（读 gui13.llm.model）
//   buildOptimizePrompt(original, opts)       H3 优化提示词·时间线为主（六段式由全局提示词+分镜拼装·画面锚定程序自动注入）
//   humanizeOptError(err)                     引擎报错 → 人话（llm_call_failed/timeout 等）

import { readAgg, writeAgg, HISTORY_JSON } from "../core/server_storage.js";  // 批 10-M T5：优化历史迁 data/history.json
import { mediaUrl, wireBgMediaFallback, wireLocalFallback } from "../core/api.js";   // 批 B #13：媒体 URL 双通道单源（引擎口优先+离线回落）
// ✦ 一键优化真生成（甲方案 2026-10-26）：走现有 LLM 对话通道（core/llm_chat）+ 预设清单（core/llm_presets）
import {
  sendChat, resetCurrentSession, restoreSessionId, persistSessionId, SESSION_STORAGE_KEY,
} from "../core/llm_chat.js";
import { listPresets } from "../core/llm_presets.js";
// #41 文档源可配置：优化规范行走覆盖层（外部文档预取缓存·未配/失败回内置 OPTIMIZE_SPEC_LINES）
import { resolveOptimizeSpecLines, consumeOptimizeDocFailedToast } from "../core/prompt_specs.js";
import {
  load as storeLoad,
  save as storeSave,
  addSegment,
  updateSegment,
  removeSegment,
  moveSegment,
  subscribe as storeSubscribe,
} from "../store/store.js";
import {
  applyOption,
  setCurrentValue,
  initDocumentDelegate,
} from "../ui/cbox.js";
import { showToast } from "../ui/toast.js";
import { toggleVocabPanel, appendVocabWord } from "../ui/vocab.js"; // 批 3-T3 F8：词库面板（F49 点钮 toggle 化）
import { open as openModal } from "../ui/modal.js";
import { listAssets, readRegistry, pickFirstFrameRefForPrompt, USAGE_CATALOG, assetThumbPath } from "../core/assets_api.js";
import { hydrateIcons } from "../ui/icons.js";
import {
  buildFormDataFromProject,
  camSourceOf,
  CAM_SOURCE_REF,
  CAM_SOURCE_TEXT,
  SEG_AV_SLOT_MAX,
} from "../core/submit.js";
import { request } from "../core/api.js";
import { loadDetail } from "../core/history_ops.js"; // B5-T6 G6：卡墙缩略图兜底②（runs[0].stem→shots）
// 批 J-P12 A：两区切分纯函数（pvbox 域）。⚠ pvbox.js 反向 import 本模块（资产上下文/选中态）
//   → 构成环；splitEnginePreview 为函数声明（提升）且只在运行时 fill() 内调用，环安全。
// #79：拖放载荷解析（dtHasType / dropPayloadToSlotFill）复用 pvbox 既有实现——同口径零漂移，
//   环安全（同为函数声明·只在运行时拖放回调内调用）。
import { splitEnginePreview, dtHasType, dropPayloadToSlotFill } from "./pvbox.js";
// #79：手动添加参考视频（文件选择）——引擎库文件浏览器（不反向 import views·无环）
import { openPicker } from "../ui/path_picker.js";
import { ASSET_DT_MIME } from "../core/assigner.js";   // 拖视频资产载荷 MIME（与 pvbox 同口径）
// 排戏台挂槽档2 T3：存量迁移（批级 poolManual.Video 排戏卡 → 段级 seg.stagingVideoRefs）
import { migrateStagingVideoRefs } from "../core/staging_attach.js";
import { t, pickDisplay } from "../core/i18n.js";   // #89 T4a：显示文案入典（seg.*·zh 原文=键值·en 见 core/i18n.js）；#89 T7：选项/摘要显示侧接 pickDisplay（zh 直通·数据零改）

// ===== 12 字段描述（按 v43 :1394-1407 顺序）=====
// key 列既用于 store 段卡字段名（seed/exportName/分段模式 + 九镜头中文键名）
export const SC_FIELDS = [
  { key: "seed", label: "种子", control: "cbox.edit", tkey: "seg.f.seed" },
  { key: "exportName", label: "导出名", control: "input", tkey: "seg.f.exportName" },
  { key: "分段模式", label: "分段模式", control: "select", tkey: "seg.f.mode" },
  { key: "角度", label: "角度", control: "select", tkey: "seg.f.angle" },
  { key: "景别", label: "景别", control: "select", tkey: "seg.f.shotSize" },
  { key: "运镜方式", label: "运镜", control: "select", tkey: "seg.f.move" },
  { key: "运镜方向", label: "方向", control: "select", tkey: "seg.f.moveDir" },
  { key: "运镜幅度", label: "幅度", control: "select", tkey: "seg.f.moveAmt" },
  { key: "运镜速度", label: "速度", control: "select", tkey: "seg.f.moveSpd" },
  { key: "焦段", label: "焦段", control: "select", tkey: "seg.f.focal" },
  { key: "氛围", label: "氛围", control: "select", tkey: "seg.f.mood" },
  { key: "情绪", label: "情绪", control: "select", tkey: "seg.f.emotion" },
];

// ===== #69 C1 → #79 回炉：段卡布局分组（镜头九项 / 高级区三项）=====
//   T-C 0642eb0（C1）把六件（方式/方向/幅度/速度/景别/角度）提出为卡面常驻「镜头」区；
//   #79 紧凑条把**镜头九项编辑整体收进展开容器**（.sc-cam·排戏按钮旁点击展开）→ 卡面不再有常驻镜头区。
//   镜头九项（引擎 shot_vocab 全集）：方式/方向/幅度/速度/景别/角度/焦段/氛围/情绪
//   高级区（折叠）：种子/导出名/分段模式（+ 首帧概念图行·C1 必碰点③保留不动）
export const SC_LENS_KEYS = ["运镜方式", "运镜方向", "运镜幅度", "运镜速度", "景别", "角度", "焦段", "氛围", "情绪"];
export const SC_ADV_KEYS = ["seed", "exportName", "分段模式"];

// ===== #69 C2：卡面已选值摘要（镜头六件紧凑摘要）=====
//   格式：「运镜=环绕 顺时针·景别=全景」式——运镜组（方式/方向/幅度/速度）空格并列成一项，
//   景别/角度各自成项，项间「·」分隔；优先序 = 方式→方向→幅度→速度→景别→角度。
//   全空 → 空串（不显示行）；超长 → 截断（尾字「…」·总长 ≤ CAMERA_SUMMARY_MAX）。
export const CAMERA_SUMMARY_MAX = 32;

/**
 * 镜头六件已选值 → 卡面摘要串（纯函数）。
 * @param {object} obj - 含六个镜头键的值对象（段对象或局部值表）
 * @returns {string} 摘要文本；全空 → 空串
 */
export function buildCameraSummary(obj) {
  // #89 T7：显示侧取词（pickDisplay zh 直通=改前逐字·en=MAPS.segField 英文；段数据本身零改）
  const val = (k) => {
    const v = obj && typeof obj[k] === "string" ? obj[k].trim() : "";
    return v ? pickDisplay("segField", v) : v;
  };
  const items = [];
  const move = [val("运镜方式"), val("运镜方向"), val("运镜幅度"), val("运镜速度")].filter(Boolean);
  if (move.length) items.push(t("seg.sum.cam") + move.join(" "));
  if (val("景别")) items.push(t("seg.sum.shot") + val("景别"));
  if (val("角度")) items.push(t("seg.sum.angle") + val("角度"));
  if (!items.length) return "";
  const s = items.join("·");
  return s.length > CAMERA_SUMMARY_MAX ? s.slice(0, CAMERA_SUMMARY_MAX - 1) + "…" : s;
}

// ===== 字段选项（按 v43 :1395-1406 select / cbox data-opts）=====
// 空首项 = 未选（v43 九镜头 select 首项）
// #77 A1：九镜头项全量替换为引擎 shot_vocab 全集（逐字抄·引擎 py+json 双源一致）
//   角度 6 / 景别 8 / 运镜方式 13 / 运镜方向 12 / 运镜幅度 2 / 运镜速度 2 / 焦段 3 / 氛围 8 / 情绪 8
//   一致性由单测锁（引擎 shot_vocab.json 夹具·双向相等）——GUI 改词须同步引擎词表。
export const FIELD_OPTS = {
  "种子": "跟随全局|随机|42|1024",
  "分段模式": ["自动（引擎派生）", "ref2v · 人物优先", "FL2V · 钉住首尾", "首帧图生视频 · 首段"],
  "角度": ["", "平视", "俯拍", "仰拍", "过肩视角", "主观视角", "荷兰角"],
  "景别": ["", "大远景", "远景", "全景", "中景", "中近景", "近景", "特写", "大特写"],
  "运镜方式": ["", "固定机位", "推近", "拉远", "摇镜", "移镜", "跟拍", "升降", "环绕", "手持摄影", "变焦推近", "变焦拉远", "横滚", "强烈晃动"],
  "运镜方向": ["", "向前", "向后", "向左", "向右", "向上", "向下", "向左前方", "向右前方", "向左后方", "向右后方", "顺时针", "逆时针"],
  "运镜幅度": ["", "小幅", "大幅"],
  "运镜速度": ["", "缓慢", "快速"],
  "焦段": ["", "广角镜头", "长焦镜头", "微距镜头"],
  "氛围": ["", "紧张", "温馨", "悲伤", "欢快", "悬疑", "史诗", "宁静", "梦幻"],
  "情绪": ["", "平静", "愤怒", "喜悦", "悲伤", "恐惧", "惊讶", "期待", "失落"],
};

// ===== #77 A2：存量镜头词表迁移（落盘·幂等）=====
// 落点写死 = 落盘迁移（偏离 N7 migrateSegMode 显示层先例·理由=提交直读 seg·存量项目须提交引擎全形）。
//   挂载点 = segcards 装载（migrateStagingVideoRefs 先例旁）·updateSegment 写回 + 保存链。
// 旧值域是封闭枚举 → 九字段×旧值全集映射（方案 A2 表逐字）：
//   运镜方式 固定→固定机位 / 缓推→推近
//   运镜方向 左→向左 / 右→向右 / 前→向前 / 后→向后
//   运镜幅度 小→小幅 / 大→大幅 / 中→空（引擎无「中」·表外清理）
//   运镜速度 慢→缓慢 / 快→快速 / 中→空（引擎无「中」·表外清理）
//   焦段 广角→广角镜头 / 长焦→长焦镜头
//   氛围 温暖→温馨
//   情绪 忧伤→悲伤
// 不迁（原值保留·不丢用户数据）：角度（平视/仰拍/俯拍·引擎同形）、景别（远景/全景/中景/特写·引擎同形）、
//   跟拍/环绕/紧张/平静（引擎同形）、焦段「标准」与氛围「清冷」（引擎无此词·保留）、
//   情绪「欢快」（引擎「欢快」属氛围·跨字段不迁·保留原值）；不认识的值一律保留（自由文本兼容）。
export const LEGACY_CAMERA_FIELD_MAP = {
  "运镜方式": { "固定": "固定机位", "缓推": "推近" },
  "运镜方向": { "左": "向左", "右": "向右", "前": "向前", "后": "向后" },
  "运镜幅度": { "小": "小幅", "大": "大幅", "中": "" },
  "运镜速度": { "慢": "缓慢", "快": "快速", "中": "" },
  "焦段": { "广角": "广角镜头", "长焦": "长焦镜头" },
  "氛围": { "温暖": "温馨" },
  "情绪": { "忧伤": "悲伤" },
};

/**
 * 存量镜头词表迁移（就地改段字段 + 落盘·幂等）。
 * @param {object} project - store 项目对象
 * @returns {{migrated:number, fields:number, saved:boolean}} 迁移段数 / 迁移字段数 / 是否落盘
 */
export function migrateLegacyCameraFields(project) {
  const out = { migrated: 0, fields: 0, saved: false };
  if (!project || typeof project !== "object") return out;
  const segs = Array.isArray(project.segments) ? project.segments : [];
  for (const seg of segs) {
    if (!seg || typeof seg !== "object") continue;
    const patch = {};
    for (const [field, map] of Object.entries(LEGACY_CAMERA_FIELD_MAP)) {
      const cur = seg[field];
      if (typeof cur !== "string" || !Object.prototype.hasOwnProperty.call(map, cur)) continue;
      const next = map[cur];
      if (next === cur) continue;
      patch[field] = next;
    }
    if (!Object.keys(patch).length) continue;
    // updateSegment 写回（无 id / 未命中 → 直改内存段·不丢）
    if (!seg.id || !updateSegment(project, seg.id, patch)) Object.assign(seg, patch);
    out.migrated++;
    out.fields += Object.keys(patch).length;
  }
  if (out.migrated > 0) { storeSave(project); out.saved = true; }
  return out;
}

// ===== S2-3 T4·存量值回填映射（N7·一次性·不写迁移脚本、不批量改写 localStorage）=====
// 引擎 1.14 已废除 i2v/fl2v 模板族，旧选项字面值落引擎会被拒（RETIRED_TEMPLATE_MSG）。
// 实现落 renderSelect 消费 currentValue 处一次性套此函数（视图层永远显示新值，不污染 store）。
// D9 口径收窄裁决：旧字面值仅允许作为常量定义行（带豁免注释）+ 测试断言两类存在。
const LEGACY_SEG_I2V_FIRST = "i2v · 首段"; // 存量回填匹配值·N7·非用户可见文案
export function migrateSegMode(value) {
  if (value === LEGACY_SEG_I2V_FIRST) return "首帧图生视频 · 首段";
  return value;
}

// ============================================================================
// 批 1-T4 G5：运镜方式 → 方向联动 + 手写笔迹识别
//   联动（#77 A3 升级）：签名 {disabled, allowed?, title}
//     固定机位/手持摄影/强烈晃动 → 方向置灰（无方向语义·不改写已存方向值）
//     环绕 → 方向集解锁为 顺时针/逆时针（allowed·选项过滤）·其余方式 → 方向全集
//     置灰 = 只设 disabled，不改写已存方向值（1.0 _refillMoveDirCtrls 的「清空」口径不采用：
//     静默清值 = 丢用户数据）。
//   手写识别：1.0 domain/shots.js:195-241 常量 + _recognizeStroke 逐字迁移（自足纯函数）。
//     #77 A4：STROKE_MOVE_MAP 退役（「缓推」是引擎外死值）——词表扩全后「表外忽略」约束解除，
//     识别输出（运镜方式 + 方向词·均为引擎词形）直写段字段。
//   入口形态：1.0 是高级区常驻 140×70 画布（shots.js:601-746·带清除钮）；1.3 高级区为紧凑网格，
//     常驻画布会撑破版式 → 收窄为「方向字段旁小钮 → 浮层画布」（最小适配·已在汇报登记）。
// ============================================================================

export const STROKE_CANVAS_W = 140;
export const STROKE_CANVAS_H = 70;
export const STROKE_MIN_LEN = 10;
export const STROKE_STRAIGHT_RATIO = 0.15;

/**
 * 笔画识别（纯函数·1.0 domain/shots.js:204-241 逐字迁移）。
 * @param {Array<{x:number,y:number}>} points - 屏幕坐标采样点（y 向下）
 * @returns {{move:string, dir:string}|null} 太短/点不足 → null
 */
export function _recognizeStroke(points) {
  if (!points || points.length < 2) return null;
  const x0 = points[0].x, y0 = points[0].y;
  const xn = points[points.length - 1].x, yn = points[points.length - 1].y;
  const dx = xn - x0, dy = yn - y0;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < STROKE_MIN_LEN) return null;
  const chordAngle = Math.atan2(dy, dx);
  const cosA = Math.cos(chordAngle), sinA = Math.sin(chordAngle);
  let maxDist = 0;
  for (const p of points) {
    const px = p.x - x0, py = p.y - y0;
    const perpDist = Math.abs(-sinA * px + cosA * py);
    if (perpDist > maxDist) maxDist = perpDist;
  }
  const ratio = maxDist / chordLen;
  if (ratio <= STROKE_STRAIGHT_RATIO) {
    const angle = Math.atan2(dy, dx);
    const sector = Math.round(angle / (Math.PI / 4));
    const idx = ((sector % 8) + 8) % 8;
    const mapping = [
      ["移镜", "向右"],
      ["拉远", "向右后方"],
      ["升降", "向下"],
      ["拉远", "向左后方"],
      ["移镜", "向左"],
      ["推近", "向左前方"],
      ["升降", "向上"],
      ["推近", "向右前方"],
    ];
    const [move, dir] = mapping[idx];
    return { move, dir };
  }
  let sumCross = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y;
    const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y;
    sumCross += ax * by - ay * bx;
  }
  if (sumCross > 0) return { move: "环绕", dir: "顺时针" };
  return { move: "环绕", dir: "逆时针" };
}

/**
 * 笔画识别结果 → 段字段补丁（纯函数·#77 A4）。
 * 识别输出即引擎词形（运镜方式 + 方向词）→ 直写；值域外词只进 ignored（供调用方白话披露）。
 * @param {{move:string,dir:string}|null} result
 * @returns {{patch:object|null, ignored:string[]}}
 */
export function strokeToSegPatch(result) {
  if (!result || typeof result !== "object") return { patch: null, ignored: [] };
  const patch = {};
  const ignored = [];
  if (typeof result.move === "string" && result.move) {
    if (FIELD_OPTS["运镜方式"].includes(result.move)) patch["运镜方式"] = result.move;
    else ignored.push(result.move);
  }
  if (typeof result.dir === "string" && result.dir) {
    if (FIELD_OPTS["运镜方向"].includes(result.dir)) patch["运镜方向"] = result.dir;
    else ignored.push(result.dir);
  }
  if (!Object.keys(patch).length) return { patch: null, ignored };
  return { patch, ignored };
}

// #77 A3：运镜方式 → 方向可用性（数据表驱动）
//   固定机位/手持摄影/强烈晃动 → 置灰（无方向语义）
//   环绕 → allowed=[顺时针,逆时针]（方向集解锁后·选项过滤）·其余方式 → 方向全集
const MOVE_DIR_ALL = FIELD_OPTS["运镜方向"].slice(1);   // 12 项·引擎方向全集
const MOVE_DIR_NO_SEMANTIC = ["固定机位", "手持摄影", "强烈晃动"];
const MOVE_DIR_ORBIT = ["顺时针", "逆时针"];

/**
 * 运镜方式 → 方向可用性（纯函数）。
 * @param {string} moveValue - 「运镜方式」字面值
 * @returns {{disabled:boolean, allowed?:string[], title:string}} 置灰态无 allowed；可编辑态给方向集
 */
export function moveDirGate(moveValue) {
  const v = typeof moveValue === "string" ? moveValue : "";
  if (MOVE_DIR_NO_SEMANTIC.includes(v)) {
    return { disabled: true, title: t("seg.gate.noDir", { v }) };
  }
  if (v === "环绕") {
    return {
      disabled: false,
      allowed: MOVE_DIR_ORBIT.slice(),
      title: t("seg.gate.orbit"),
    };
  }
  return { disabled: false, allowed: MOVE_DIR_ALL.slice(), title: "" };
}

// 联动落 DOM（只改 disabled/title/方向选项集·不清值）
function applyMoveDirGate(dirSel, moveValue, keepValue) {
  if (!dirSel) return;
  const gate = moveDirGate(moveValue);
  dirSel.disabled = gate.disabled;
  dirSel.setAttribute("title", gate.title);
  applyDirAllowedOptions(dirSel, gate.allowed, keepValue);
}

// 方向选项按 allowed 过滤（环绕 → 只剩顺/逆时针）；已存方向值一律保留（不静默丢）
function applyDirAllowedOptions(dirSel, allowed, keepValue) {
  if (!dirSel || typeof document === "undefined") return;
  const full = FIELD_OPTS["运镜方向"] || [];
  const allow = Array.isArray(allowed) ? new Set(allowed) : null;
  const cur = (typeof keepValue === "string" && keepValue)
    ? keepValue
    : (typeof dirSel.value === "string" ? dirSel.value : selectedOptionValue(dirSel));
  const keep = full.filter((v) => v === "" || !allow || allow.has(v));
  if (cur && !keep.includes(cur)) keep.push(cur);   // 已存值不在允许集 → 仍保留（不丢）
  for (const o of Array.from(dirSel.childNodes || [])) {
    if (o && o.tagName === "OPTION") dirSel.removeChild(o);
  }
  for (const v of keep) {
    // 空值首项显示「（未选）」占位（与 renderSelect 同口径）；#89 T7：显示侧接 pickDisplay（value=数据值零改）
    const o = el("option", { value: v, text: v === "" ? t("seg.common.unselected") : pickDisplay("segField", v) });
    if (v === cur) o.selected = true;
    dirSel.appendChild(o);
  }
  if (cur) dirSel.value = cur;
}

// select 当前选中项的值（无 .value 语义的 DOM stub 兜底）
function selectedOptionValue(sel) {
  const opts = Array.from(sel.childNodes || []).filter((o) => o && o.tagName === "OPTION");
  const on = opts.find((o) => o.selected);
  return on && on.getAttribute ? (on.getAttribute("value") || "") : "";
}

// 给 select 赋一个可能不在选项集里的值（补临时 option·防字段被静默丢值）
function setSelectValueSafe(sel, value) {
  if (!sel || typeof value !== "string" || !value) return;
  const has = Array.from(sel.childNodes || []).some(
    (o) => o && o.tagName === "OPTION" && o.getAttribute && o.getAttribute("value") === value);
  if (!has) {
    const o = el("option", { value, text: pickDisplay("segField", value) });   // #89 T7：显示侧接 pickDisplay（value=数据值零改）
    o.selected = true;
    sel.appendChild(o);
  }
  sel.value = value;
}

/**
 * 手写选运镜浮层（1.0 shots.js:601-746 常驻画布收窄为浮层入口）。
 * @param {object} opts - { onPatch(patch) } 识别命中 → 段字段补丁
 * @returns {object|null} modal 实例（无 DOM → null）
 */
export function openStrokeModal(opts = {}) {
  if (typeof document === "undefined") return null;
  const onPatch = typeof opts.onPatch === "function" ? opts.onPatch : null;

  const wrap = el("div", { class: "stroke-wrap" });
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;align-items:flex-start";
  const head = el("div", { class: "stroke-head" });
  head.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;color:var(--txt3)";
  head.appendChild(el("span", { text: t("seg.stroke.head") }));
  const clearBtn = el("button", { type: "button", class: "ghostbtn stroke-clear", text: t("seg.stroke.clear") });
  clearBtn.style.cssText = "padding:1px 8px;font-size:11px;cursor:pointer";
  head.appendChild(clearBtn);
  wrap.appendChild(head);

  const canvas = document.createElement("canvas");
  canvas.className = "stroke-canvas";
  canvas.width = STROKE_CANVAS_W;
  canvas.height = STROKE_CANVAS_H;
  // 显示尺寸锁定 140×70 + touch-action:none（1.0 :606 同款·防容器拉伸导致坐标漂移）
  canvas.style.cssText = "display:block;width:140px;height:70px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;cursor:crosshair;touch-action:none";
  wrap.appendChild(canvas);

  const result = el("div", { class: "stroke-result" });
  result.style.cssText = "font-size:12px;color:var(--txt2);min-height:16px";
  wrap.appendChild(result);

  // getContext 可能返 null（jsdom / 无 2d 环境）→ 守卫后加载无错（1.0 :609-611 同款）
  const ctx2d = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  const placeholder = () => {
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, STROKE_CANVAS_W, STROKE_CANVAS_H);
    ctx2d.fillStyle = "#67707a";   // --txt3
    ctx2d.font = "11px sans-serif";
    ctx2d.textAlign = "center";
    ctx2d.fillText(t("seg.stroke.canvasHint"), STROKE_CANVAS_W / 2, STROKE_CANVAS_H / 2 + 4);
  };

  let strokePoints = [];
  let stroking = false;
  // 坐标 → 内部位图等比换算（1.0 :660-666）
  const canvasPoint = (ev) => {
    const rect = (typeof canvas.getBoundingClientRect === "function")
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0, width: canvas.width || STROKE_CANVAS_W, height: canvas.height || STROKE_CANVAS_H };
    const sx = rect.width ? (canvas.width / rect.width) : 1;
    const sy = rect.height ? (canvas.height / rect.height) : 1;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  };
  canvas.addEventListener("pointerdown", (ev) => {
    stroking = true;
    strokePoints = [canvasPoint(ev)];
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, STROKE_CANVAS_W, STROKE_CANVAS_H);
    ctx2d.strokeStyle = "#38b6c4";   // --accent-bright（1.0 :614 为 #f0a040·1.3 套主题亮色）
    ctx2d.lineWidth = 2;
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    ctx2d.beginPath();
    ctx2d.moveTo(strokePoints[0].x, strokePoints[0].y);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!stroking) return;
    const p = canvasPoint(ev);
    const last = strokePoints[strokePoints.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;   // 采样节流 ≥1px（1.0 :685）
    strokePoints.push(p);
    if (ctx2d) { ctx2d.lineTo(p.x, p.y); ctx2d.stroke(); }
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!stroking) return;
    stroking = false;
    const found = _recognizeStroke(strokePoints);
    strokePoints = [];
    if (!found) {
      result.textContent = t("seg.stroke.tooShort");
      placeholder();
      return;
    }
    const mapped = strokeToSegPatch(found);
    const seen = [found.move, found.dir].filter(Boolean).join(" · ");
    if (!mapped.patch) {
      // 不静默丢：白话披露已忽略（识别词不在引擎值域内）
      showToast("warn", t("seg.stroke.ignoredToast", { seen }));
      result.textContent = t("seg.stroke.ignored", { seen });
      placeholder();
      return;
    }
    const filled = [];
    if (mapped.patch["运镜方式"]) filled.push(t("seg.stroke.filledMove", { v: mapped.patch["运镜方式"] }));
    if (mapped.patch["运镜方向"]) filled.push(t("seg.stroke.filledDir", { v: mapped.patch["运镜方向"] }));
    const missNote = mapped.ignored.length ? t("seg.stroke.missNote", { words: mapped.ignored.join("·") }) : "";
    result.textContent = t("seg.stroke.result", { seen, filled: filled.join(" "), miss: missNote });
    if (onPatch) onPatch(mapped.patch);
  });
  canvas.addEventListener("pointercancel", () => {
    stroking = false;
    strokePoints = [];
    placeholder();
  });
  // 只清画布不动字段（避免「清画布」意外抹掉已选运镜；值仍可在下拉里改）
  clearBtn.addEventListener("click", () => { placeholder(); result.textContent = ""; });
  placeholder();

  return openModal({
    title: t("seg.stroke.cap"),
    sub: t("seg.stroke.sub"),
    contentNode: wrap,
    persistKey: "手写选运镜",
  });
}

// 手写入口小钮（方向字段旁·与下拉同行——体验修复 E1：旧上下堆叠把方向列下拉挤到 29px 高）
function makeStrokeEntry(onOpen) {
  const btn = el("button", { type: "button", class: "ghostbtn sc-stroke-btn", text: "✎" });
  btn.style.cssText = "padding:2px 6px;font-size:12px;cursor:pointer;flex-shrink:0";
  btn.title = t("seg.stroke.entryTitle");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onOpen();
  });
  return btn;
}

// ===== S3-1 T3 feat 2: FL 降级挂用视图 ——
  // 视图层不改 store schema，挂首帧靠 prompt @N 自动衔接（与 ref 主方案共用通道）：
  //   appendFirstFrameRefToPrompt(seg.prompt, refN) → 末尾追加 " @N" 字符串
  //   isFlAidedSegMode(modeValue) → 该分段模式是否需要首帧
  // 真实情况下行（mount 渲染 dropdown / 选中触发 onPatch）由 renderAdv 内嵌实现，
  // 本节只暴露两个纯函数供随测 / 视图复用。

/**
 * 给段 prompt 末尾追加首帧引用 @N（行挂用最小实现·不发明新 schema）。
 * @param {string} promptText - 段原始提示词
 * @param {number} refN - 首帧 @N（来自 dropdown 选中项）
 * @returns {string} 拼装后的 prompt；refN 非法或已含相同 @N → 原样
 */
export function appendFirstFrameRefToPrompt(promptText, refN) {
  const s = (typeof promptText === "string") ? promptText : (promptText == null ? "" : String(promptText));
  const n = Number(refN);
  // 合法 refN = ≥1 整数（registry 从 1 起，槽 9 跳过但 @N 仍 ≥1）
  if (!Number.isFinite(n) || n < 1) return s;
  // 幂等: 扫描 prompt 中既有 @N，含相同 N → 不重补（按词匹配·@N 标点变体算同 N）
  const existing = s.match(/@(\d+)/g) || [];
  for (const t of existing) {
    if (+t.slice(1) === n) return s;
  }
  // 末尾追加：前置空格保证词分隔（已有尾空白则不再加）
  const tail = s.endsWith(" ") || s.endsWith("\n") || s === "" ? "" : " ";
  return s + tail + "@" + n;
}

/**
 * 资产 pill 拖拽入框：追加 @名字 短引用（批5-R55·与 at-mention mentionInsert 同口径，
 * 尾随空格接词）。幂等判重按 @名字 token（词边界同 extractRefs：token 后不许紧跟
 * 数字/字母/下划线——防「注册名数字开头/更长名」误判同 token）。
 * 与 appendFirstFrameRefToPrompt（@N 装池/首帧数据通道）互不相干，数据面不动。
 * @param {string} promptText - 段原始提示词
 * @param {string} name - 资产卡名（registry 来源）
 * @returns {string} 拼装后的 prompt；name 非法 → 原样
 */
export function appendAssetNameRefToPrompt(promptText, name) {
  const s = (typeof promptText === "string") ? promptText : (promptText == null ? "" : String(promptText));
  if (typeof name !== "string" || !name) return s;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("@" + esc + "(?![0-9A-Za-z_])");
  if (re.test(s)) return s;
  const tail = s.endsWith(" ") || s.endsWith("\n") || s === "" ? "" : " ";
  return s + tail + "@" + name + " ";
}

/**
 * 判断该分段模式是否需要首帧参考（FL 降级通道启用）。
 * @param {string} modeValue - 段卡"分段模式"字面值
 * @returns {boolean}
 */
export function isFlAidedSegMode(modeValue) {
  if (typeof modeValue !== "string" || !modeValue) return false;
  return modeValue === "首帧图生视频 · 首段" || modeValue === "FL2V · 钉住首尾";
}

// ===== S3-2 T8: 首帧概念图下拉接线（视图层·纯函数 + 资产上下文）=====
//   取数口径：资产卡 rows 含 usage="first_frame" 且 media 非空（USAGE_CATALOG 首帧锚定·Picture 类）
//             ∩ @N 注册表已分配（未注册卡无 @N·挂不进 pool）→ 按 n 升序
//   写入通道：复用既有 appendFirstFrameRefToPrompt（末尾追加 " @N"·幂等），不重写拼装逻辑；
//             @N 即 submit 装配的入池键（buildPool 反查 first_frame 行）+ 帧锚点句来源
//   清除通道：removeFirstFrameRefFromPrompt（只剥末尾 @N·句中手写 @N 不动）

/**
 * 可作首帧参考的概念帧卡列表（纯函数·下拉选项数据源）。
 * @param {Object} assets - { [cardName]: card }（listAssets 归一形态）
 * @param {Object} registry - { [n]: cardName }（@N 注册表）
 * @returns {Array<{n:number, name:string}>} 按 @N 升序
 */
export function listConceptFrameOptions(assets, registry) {
  const ast = (assets && typeof assets === "object" && !Array.isArray(assets)) ? assets : {};
  const reg = (registry && typeof registry === "object" && !Array.isArray(registry)) ? registry : {};
  const out = [];
  for (const key of Object.keys(reg)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1) continue;
    const name = reg[key];
    if (typeof name !== "string" || !name) continue;
    const card = ast[name];
    if (!card || !Array.isArray(card.rows)) continue;
    const hit = card.rows.some((row) => row && row.usage === "first_frame" && row.media);
    if (!hit) continue;
    out.push({ n, name });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/**
 * 移除段 prompt 末尾的首帧 @N（纯函数·下拉"清除选择"通道）。
 * 只剥末尾一个 @N（本下拉追加位）；句中手写 @N 与其余内容原样保留。
 * @param {string} promptText
 * @param {number|null|undefined} refN - 待移除的 @N
 * @returns {string} 无末尾匹配 / refN 非法 → 原样（幂等）
 */
export function removeFirstFrameRefFromPrompt(promptText, refN) {
  const s = (typeof promptText === "string") ? promptText : (promptText == null ? "" : String(promptText));
  const n = Number(refN);
  if (!Number.isInteger(n) || n < 1) return s;
  const re = new RegExp("\\s*@" + n + "\\s*$");
  return re.test(s) ? s.replace(re, "") : s;
}

// ===== 资产上下文（@N 注册表 + 引擎资产卡）=====
//   段卡首帧下拉需要二者：registry 给 @N、assets 给 first_frame 用途行（与 submit 装配同源）。
//   装载走 core/assets_api.js（listAssets + readRegistry），失败降级空——段卡照常渲染，只是无选项。
//   装载完成后重渲染已挂载段卡（_mountedInstances）使下拉回填。
let _assetCtx = { registry: {}, assets: {} };
let _assetLoaded = false;
let _assetLoading = null;

function _safeStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

export function getAssetContext() { return _assetCtx; }

export function setAssetContext(ctx) {
  _assetCtx = {
    registry: (ctx && typeof ctx.registry === "object" && !Array.isArray(ctx.registry)) ? ctx.registry : {},
    assets: (ctx && typeof ctx.assets === "object" && !Array.isArray(ctx.assets)) ? ctx.assets : {},
  };
  _assetLoaded = true;
  return _assetCtx;
}

/** 装载资产上下文（可注入 storage / listAssets 替身供单测）→ 重渲染已挂载段卡 */
export async function loadAssetContext(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : _safeStorage();
  const lister = typeof opts.listAssets === "function" ? opts.listAssets : listAssets;
  let registry = {};
  let assets = {};
  try {
    if (storage && typeof storage.getItem === "function") registry = readRegistry(storage);
  } catch (_e) { /* 隐私模式 / 损坏 JSON → 降级 */ }
  try {
    const r = await lister();
    if (r && r.ok && r.assets && typeof r.assets === "object" && !Array.isArray(r.assets)) assets = r.assets;
  } catch (_e) { /* 网络 / 解析异常 → 降级（不阻塞段卡） */ }
  _assetLoading = null;
  const ctx = setAssetContext({ registry, assets });
  for (const entry of _mountedInstances.values()) {
    try { if (entry && typeof entry.rerender === "function") entry.rerender(); } catch (_e) { /* 单实例失败不牵连 */ }
  }
  return ctx;
}

/** mount 用：未装载过才拉（幂等·并发合并）；R6 起导出供 pvbox 复用同一 @N 注册表通道 */
export function ensureAssetContext() {
  if (_assetLoaded) return Promise.resolve(_assetCtx);
  if (_assetLoading) return _assetLoading;
  _assetLoading = loadAssetContext();
  return _assetLoading;
}

export function _resetAssetContextForTests() {
  _assetCtx = { registry: {}, assets: {} };
  _assetLoaded = false;
  _assetLoading = null;
}

// ============================================================================
// 资产选择弹窗（甲方案：设定页拆双子页签后素材池（参数页）与段卡（提示词页）分居两页
//   → 拖拽跨页不可达 → 段卡侧给点按入口：参考视频槽「＋ 资产库」/ 提示词区「引用资产」）
//   数据源：core/assets_api listAssets（引擎资产卡 {卡名: {rows:[{usage,media,…}]}}）
//   类型过滤：卡行 usage → USAGE_CATALOG kind（Picture/Video/Audio）·与 core/submit.js
//     usageKindOf 同款口径（@N 装池只收 Picture 用途·见 submit.js 用途闸门）
//   取值行：首个 media 非空且 kind 命中行（与 pvbox.dropPayloadToSlotFill 同款·拖放/点按零漂移）
//   弹窗壳：复用 ui/modal.js（.mbox）+ @联想行样式（.at-row/.at-th·at-panel.css 全局在册）
// ============================================================================

/** usage → kind（USAGE_CATALOG 源表·与 core/submit.js usageKindOf 同款·未登记用途返 null） */
export function usageKindOf(usage) {
  for (const u of USAGE_CATALOG) if (u.id === usage) return u.kind;
  return null;
}

/** 用途 id → 中文标签（USAGE_CATALOG label·展示用·未登记返空串） */
export function usageLabelOf(usage) {
  for (const u of USAGE_CATALOG) if (u.id === usage) return u.label;
  return "";
}

/**
 * 资产卡列表（按用途媒体类型过滤·纯函数）。
 * @param {Object} assets — { [卡名]: card }（listAssets 形态）
 * @param {string} kind — "Picture" | "Video" | "Audio"
 * @returns {Array<{name:string, media:string, usage:string}>} 按卡名升序
 */
export function listAssetCardsByKind(assets, kind) {
  const src = (assets && typeof assets === "object" && !Array.isArray(assets)) ? assets : {};
  const out = [];
  for (const name of Object.keys(src)) {
    const card = src[name];
    const rows = (card && Array.isArray(card.rows)) ? card.rows : [];
    const row = rows.find((r) => r && typeof r.media === "string" && r.media && usageKindOf(r.usage) === kind);
    if (!row) continue;
    out.push({ name, media: row.media, usage: row.usage });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  return out;
}

/** 弹窗空态文案（资产库无该类资产） */
export function assetPickerEmptyText(kind) {
  if (kind === "Video") return t("seg.picker.emptyVideo");
  if (kind === "Audio") return t("seg.picker.emptyAudio");
  return t("seg.picker.emptyPicture");
}

/**
 * 资产选择弹窗（复用 ui/modal.js 容器 + @联想行样式·不新造设计系统）。
 * @param {object} opts — { kind:"Picture"|"Video"|"Audio", title?, sub?, assets?, emptyText?, onPick(item) }
 * @returns {object|null} modal 实例（无 DOM 环境返 null）
 */
export function openAssetPicker(opts = {}) {
  if (typeof document === "undefined") return null;
  const kind = (opts.kind === "Video" || opts.kind === "Audio") ? opts.kind : "Picture";
  const assets = (opts.assets && typeof opts.assets === "object" && !Array.isArray(opts.assets))
    ? opts.assets : getAssetContext().assets;
  const items = listAssetCardsByKind(assets, kind);
  const list = el("div", { class: "asset-picker-list" });
  list.style.cssText = "max-height:320px;overflow:auto";
  if (!items.length) {
    const empty = el("div", { class: "asset-picker-empty", text: opts.emptyText || assetPickerEmptyText(kind) });
    empty.style.cssText = "color:var(--txt3);font-size:12px;padding:12px 4px";
    list.appendChild(empty);
  }
  let inst = null;
  for (const it of items) {
    const row = el("div", { class: "at-row" });
    row.title = it.media;
    // 音频无缩略图（不发必失败的 thumb 请求）
    if (kind !== "Audio") {
      const th = el("span", { class: "at-th" });
      const tp = assetThumbPath(it.media);
      if (tp) {
        th.style.backgroundImage = 'url("' + mediaUrl("thumb", tp, { maxSize: 512 }) + '")';
        wireBgMediaFallback(th, "thumb", tp, { maxSize: 512 });
      }
      row.appendChild(th);
    }
    row.appendChild(el("span", { class: "nm", text: it.name }));
    row.appendChild(el("span", { class: "kd", text: usageLabelOf(it.usage) }));
    row.addEventListener("click", () => {
      if (inst) inst.close();
      if (typeof opts.onPick === "function") opts.onPick(it);
    });
    list.appendChild(row);
  }
  const defaultTitle = kind === "Video" ? t("seg.picker.pickVideo")
    : (kind === "Audio" ? t("seg.picker.pickAudio") : t("seg.picker.pickPicture"));
  inst = openModal({
    title: opts.title || defaultTitle,
    sub: opts.sub || "",
    contentNode: list,
    persistKey: "gui13.assetpicker." + kind,
  });
  return inst;
}

// 弹窗取数源：资产上下文已装载 → 直接用；未装载 → 单发 listAssets
//   （不经 loadAssetContext：那条路会重渲段卡换节点·点按入口的 DOM 引用会失效）
function pickerAssets() {
  if (_assetLoaded) return Promise.resolve(getAssetContext().assets);
  return listAssets()
    .then((r) => (r && r.ok && r.assets && typeof r.assets === "object" && !Array.isArray(r.assets) ? r.assets : {}))
    .catch(() => ({}));
}

// 当前段卡提示词 textarea（段卡可能被重渲换节点 → 用时重查·不捕获点击时的旧节点）
function currentSegPromptTextarea(projectId, segId) {
  const entry = _mountedInstances.get(projectId);
  const list = entry && entry.segList;
  if (!list || typeof list.querySelector !== "function") return null;
  let row = null;
  try { row = list.querySelector('[data-sid="' + _cssEsc(segId) + '"]'); } catch (_e) { row = null; }
  if (!row || typeof row.querySelector !== "function") return null;
  try { return row.querySelector(".sc-prompt"); } catch (_e) { return null; }
}

// ============================================================================
// S3-4 B8（空-011·拍板 F 组）：@N 深联 —— 多级引用展开（纯函数）+ 段卡引用链行
//   深联语义：段词 @N 引到卡 A，卡 A 的资产描述（rows[].desc / memo）里再含 @M → 递归展开（跨资产联动）。
//   边界：深度上限（默认 3）· 环安全（路径回指记 cycles·不重复入链）· 未注册/缺卡记 missing。
//   只读展示，不改写用户提示词（引擎侧池装配仍按直接 @N · submit 通道不动）。
// ============================================================================

const AT_REF_RE = /@(\d+)/g;
const REF_DESC_CLIP = 40;

function _asMap(v) {
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
}
// 深联扫描文本 = memo + 各 rows.desc（资产描述里的 @M 即跨资产引用线索）
function _cardRefText(card) {
  const parts = [];
  if (card && typeof card.memo === "string" && card.memo) parts.push(card.memo);
  const rows = Array.isArray(card && card.rows) ? card.rows : [];
  for (const r of rows) {
    if (r && typeof r.desc === "string" && r.desc) parts.push(r.desc);
  }
  return parts.join("\n");
}
function _cardDesc(card) {
  const rows = Array.isArray(card && card.rows) ? card.rows : [];
  for (const r of rows) {
    if (r && typeof r.desc === "string" && r.desc.trim()) return r.desc.trim();
  }
  return (card && typeof card.memo === "string") ? card.memo.trim() : "";
}
function _clipText(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * @N 深联展开（纯函数）。
 * @param {string} promptText - 段提示词
 * @param {Object} registry - { [n]: 卡名 }（@N 注册表）
 * @param {Object} assets - { [卡名]: card }（引擎档案卡）
 * @param {{maxDepth?:number}} [opts] - 深度上限（默认 3）
 * @returns {{refs:Array, chain:Array, missing:Array, cycles:Array, text:string}}
 *   refs   直接引用（出现序去重）{n, name}
 *   chain  可解析引用链（发现序去重）{n, name, depth, via}
 *   missing 未注册/缺卡 {n, depth, via}
 *   cycles 路径回指 {n, depth, via}
 *   text   展开文本（多级缩进 + 描述摘要·供 tooltip）
 */
export function expandAtRefs(promptText, registry, assets, opts = {}) {
  const reg = _asMap(registry);
  const ast = _asMap(assets);
  const maxDepth = (Number.isInteger(opts.maxDepth) && opts.maxDepth >= 1) ? opts.maxDepth : 3;
  const out = { refs: [], chain: [], missing: [], cycles: [], text: "" };
  const src = String(promptText == null ? "" : promptText);
  if (!src) return out;

  const directSeen = new Set();
  const chainSeen = new Set();
  const lines = [];
  const walk = (text, depth, via, path) => {
    const re = new RegExp(AT_REF_RE.source, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = +m[1];
      if (!Number.isFinite(n) || n < 1) continue;
      if (path.has(n)) { out.cycles.push({ n, depth, via }); continue; }
      if (depth === 1) {
        if (directSeen.has(n)) continue;
        directSeen.add(n);
      }
      const name = typeof reg[String(n)] === "string" ? reg[String(n)] : "";
      if (depth === 1) out.refs.push({ n, name });
      const card = name ? ast[name] : null;
      if (!card || !Array.isArray(card.rows)) { out.missing.push({ n, depth, via }); continue; }
      if (!chainSeen.has(n)) {
        chainSeen.add(n);
        out.chain.push({ n, name, depth, via });
        const desc = _cardDesc(card);
        // 批5-R55-T2: 显示层去序列号（老板"不带任何序列号"）——行首改卡名形态·去 @N 前缀；
        //   "引自"取父层卡名（reg 反查·取不到 → 中性"经卡引用"）。chain/refs 数据结构不动。
        lines.push("  ".repeat(depth - 1) + name
          + (depth > 1 ? t("seg.ref.via", { name: reg[String(via)] || t("seg.ref.viaCard") }) : "")
          + (desc ? t("seg.ref.desc", { desc: _clipText(desc, REF_DESC_CLIP) }) : ""));
      }
      if (depth >= maxDepth) continue;
      const nested = _cardRefText(card);
      if (!nested) continue;
      const nextPath = new Set(path);
      nextPath.add(n);
      walk(nested, depth + 1, n, nextPath);
    }
  };
  walk(src, 1, null, new Set());
  if (lines.length) out.text = t("seg.ref.expandHead") + lines.join("\n");
  return out;
}

/**
 * 引用链单行文案（段卡展示用）。
 * 仅直接引用（无深联/断链/环）→ null（不出行·不占段卡版面）。
 * @param {object} res - expandAtRefs 结果
 * @returns {string|null}
 */
export function refChainSummary(res) {
  if (!res || !Array.isArray(res.chain)) return null;
  const deep = res.chain.filter((e) => e && e.depth > 1);
  const missing = Array.isArray(res.missing) ? res.missing : [];
  const cycles = Array.isArray(res.cycles) ? res.cycles : [];
  if (!deep.length && !missing.length && !cycles.length) return null;
  // 批5-R55-T2: 链本体改卡名形态（chain 元素必有卡·name 恒非空）；
  //   "未注册/环引用"分支的裸 @N 不在清理面（无卡名可显·非复合形态）
  const main = res.chain.map((e) => e.name).join(" → ");
  const parts = [t("seg.ref.chain", { chain: main || t("seg.ref.none") })];
  if (missing.length) parts.push(t("seg.ref.missing", { list: missing.map((m) => "@" + m.n).join("/") }));
  if (cycles.length) parts.push(t("seg.ref.cycle", { list: cycles.map((c) => "@" + c.n).join("/") }));
  return parts.join(" · ");
}

// 段卡引用链行（深联/断链/环才有 → 其余段不占版面；title = 多级展开文本）
function renderRefChainRow(seg, ctx) {
  const res = expandAtRefs(seg && seg.prompt, ctx.registry, ctx.assets);
  const summary = refChainSummary(res);
  if (!summary) return null;
  const row = el("div", { class: "sc-refchain", text: summary, title: res.text });
  row.style.cssText = "font-size:12px;color:var(--txt3);margin-top:4px;line-height:1.5;word-break:break-all";
  return row;
}

// ============================================================================
// S3-4 B8（空-010·拍板 E 组）：✦ 一键优化完整栈
//   原文逐条：E2 默认无参数 + @N 引用原样保留 · E3 采纳历史留档（原值基础·可回滚）
//             · E4 三选一（采纳覆盖/不采纳/再来一版）· E5 居中浮层 · E6 段级（批量为后续增量）
//             · E7 失败直报 + 重试提示（不做本地兜底）· E1 端点形态（#50 llm/chat 增 intent）属引擎契约
//   LLM 通道：本仓无 → 优化执行按登记形态（「再来一版」toast 直报未执行 + 重试指引）；
//             改进版框可手写候选（否则采纳/回滚不可达）——规格适配，已在汇报单列。
// ============================================================================

export const OPTIMIZE_HISTORY_KEY = "gui13.optimizeHistory";
export const OPTIMIZE_HISTORY_MAX = 50;

/** 改进版丢失的 @N（E2 引用保留校验·出现序去重） */
export function missingAtRefs(original, improved) {
  const before = String(original == null ? "" : original).match(AT_REF_RE) || [];
  const after = new Set((String(improved == null ? "" : improved).match(AT_REF_RE) || []).map((t) => +t.slice(1)));
  const out = [];
  const seen = new Set();
  for (const t of before) {
    const n = +t.slice(1);
    if (seen.has(n) || after.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 采纳历史头插 + 封顶（不修改入参；列表不变量 = 新→旧） */
export function appendOptimizeRecord(list, entry) {
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, OPTIMIZE_HISTORY_MAX);
}

/** 按 id 取采纳历史条目（显示原值 / 回滚通道） */
export function findOptimizeRecord(list, id) {
  if (!id) return null;
  return (Array.isArray(list) ? list : []).find((e) => e && e.id === id) || null;
}

function _normOpt(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const before = typeof e.before === "string" ? e.before : null;
  const after = typeof e.after === "string" ? e.after : null;
  if (before == null || after == null) return null;
  return {
    id: String(e.id == null ? "" : e.id),
    segId: String(e.segId == null ? "" : e.segId),
    projectId: String(e.projectId == null ? "" : e.projectId),
    before,
    after,
    ts: Number.isFinite(e.ts) ? e.ts : 0,
  };
}

export function readOptimizeHistory(storage) {
  if (!storage) return [];   // M-T5：无 storage → 空（保留旧契约）
  try {
    const v = readAgg(HISTORY_JSON, "optimizeHistory", storage);   // M-T5
    const arr = Array.isArray(v) ? v
      : (storage && storage.getItem(OPTIMIZE_HISTORY_KEY) ? JSON.parse(storage.getItem(OPTIMIZE_HISTORY_KEY)) : null);
    if (!Array.isArray(arr)) return [];
    return arr.map(_normOpt).filter(Boolean);
  } catch (_e) { return []; }
}

export function writeOptimizeHistory(storage, list) {
  writeAgg(HISTORY_JSON, "optimizeHistory", Array.isArray(list) ? list : []);   // M-T5
}

function _optTimeText(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function _optColumn(label, value, readonly, cls) {
  const wrap = el("div", { class: "opt-col" });
  wrap.style.cssText = "flex:1;min-width:220px";
  wrap.appendChild(el("div", { class: "inh", text: label }));
  const ta = el("textarea", { class: "gp " + cls });
  ta.rows = 7;
  ta.value = value;
  if (readonly) ta.setAttribute("readonly", "");
  ta.style.cssText = "width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--txt);font-size:13px;outline:none;font-family:inherit;line-height:1.5";
  wrap.appendChild(ta);
  return { wrap, ta };
}

// ============================================================================
// ✦ 一键优化真生成（甲方案 · 老板裁决 2026-10-26：不等引擎·直接走现有 LLM 对话通道）
//   预设来源：gui13.llm.model（localStorage 键·AI 协作页持久化的预设 name）
//   真调 core/llm_chat.sendChat（不带会话 → 引擎自建独立会话·不污染 AI 协作会话）
// ============================================================================
const OPT_MODEL_KEY = "gui13.llm.model";   // 与 ai-archive.js / staging_dialog.js 同键
const OPT_MODEL_MAX_LEN = 255;

// 模型预设名合法性（口径同 ai-archive.js _isValidModelName·上限 255）
function _isValidModelName(s) {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > OPT_MODEL_MAX_LEN) return false;
  if (/[\x00-\x1f]/.test(s)) return false;
  return true;
}

// 读模型预设名（口径：localStorage 键 gui13.llm.model —— 任务单指定的预设来源）
//   空/查不到 → 弹层内下拉让用户选·选中写回该键（下次直接用）
export function readOptModel(storage) {
  try {
    const s = storage || _safeStorage();
    if (s && typeof s.getItem === "function") {
      const v = s.getItem(OPT_MODEL_KEY);
      if (_isValidModelName(v)) return v;
    }
  } catch (_e) { /* 本地键不可用 → 无模型 */ }
  return "";
}

// 写回模型预设名（只写本地键·不旁落 AI 协作页的模型选择）
function writeOptModel(storage, name) {
  if (!_isValidModelName(name)) return;
  try {
    const s = storage || _safeStorage();
    if (s && typeof s.setItem === "function") s.setItem(OPT_MODEL_KEY, name);
  } catch (_e) { /* 本地键不可用 → 忽略（本次仍可用内存中的 picked） */ }
}

// 清模型预设名（下拉选回空首项 → 清键·与下拉显示一致）
function clearOptModel(storage) {
  try {
    const s = storage || _safeStorage();
    if (s && typeof s.removeItem === "function") s.removeItem(OPT_MODEL_KEY);
  } catch (_e) { /* 本地键不可用 → 忽略 */ }
}

// 优化提示词（时间线为主：系统要求内联在同一条消息 + 原段提示词为用户内容；六段式由全局提示词+分镜拼装·画面锚定程序自动注入）
//   opts: { durationSec?: number, lens?: object } —— 段时长与镜头九项非空值作已知条件注入
//   九项中文短标签（与段卡字段同源·见 SC_LENS_KEYS）
const OPT_LENS_KNOWN = [
  ["运镜方式", "运镜"], ["运镜方向", "方向"], ["运镜幅度", "幅度"], ["运镜速度", "速度"],
  ["景别", "景别"], ["角度", "角度"], ["焦段", "焦段"], ["氛围", "氛围"], ["情绪", "情绪"],
];

export function buildOptimizePrompt(original, opts = {}) {
  const src = typeof original === "string" ? original.trim() : "";
  const o = opts && typeof opts === "object" ? opts : {};
  const dur = Number.isFinite(o.durationSec) && o.durationSec > 0 ? o.durationSec : 5;
  const lens = o.lens && typeof o.lens === "object" ? o.lens : {};
  const known = OPT_LENS_KNOWN
    .map(([key, label]) => {
      const v = typeof lens[key] === "string" ? lens[key].trim() : "";
      return v ? `${label}=${v}` : "";
    })
    .filter(Boolean)
    .join(" ");
  const lensLine = known
    ? `- 镜头设定：${known}（提示词中的机位/景别/运镜不得与之矛盾；未给出的维度不限）`
    : "- 镜头设定：本段未指定，机位/景别/运镜不限。";
  return [
    ...resolveOptimizeSpecLines(),   // #41：外部文档覆盖层（未配/预取失败 → 内置规范行）
    "",
    "已知条件：",
    `- 本段时长：${dur} 秒`,
    lensLine,
    "",
    "原提示词：",
    src,
  ].join("\n");
}

// 引擎报错人话（error.code/msg/detail → 用户看得懂的一句）
export function humanizeOptError(err) {
  const e = err && typeof err === "object" ? err : {};
  const code = typeof e.code === "string" ? e.code : "";
  const msg = typeof e.msg === "string" ? e.msg : "";
  const detail = e.detail == null ? "" : (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail));
  if (code === "timeout") return t("seg.opt.errTimeout");
  if (code === "llm_call_failed") return t("seg.opt.errLlmCall", { msg: detail || msg || t("seg.opt.noCause") });
  if (code === "unknown_model") return t("seg.opt.errUnknownModel");
  if (code === "llm_context_overflow") return t("seg.opt.errOverflow");
  if (code === "session_not_found") return t("seg.opt.errSession");
  if (code === "network_error") return t("seg.opt.errNetwork");
  if (code === "message_invalid") return t("seg.opt.errMsgInvalid");
  if (code === "empty_reply") return t("seg.opt.emptyReply");
  return t("seg.opt.genFail", { msg: msg || code || t("seg.opt.unknownCause") });
}

// AI 协作会话键原值（生成前记下·生成后原样写回·优化请求不污染协作会话）
function _llmSessionKey() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === "function") return s.getItem(SESSION_STORAGE_KEY) || "";
  } catch (_e) { /* 无本地存储 → 无会话 */ }
  return "";
}

/**
 * ✦ 一键优化弹层（居中浮层 · 原版/改进版并排 · 三选一 · 采纳历史）。
 *   「✦ 优化 / ↻ 再来一版」= 真调 LLM 对话通道生成改进版（甲方案 2026-10-26·见上方「真生成」段注释）。
 *   首次按钮文案按本段有无改进版判定（采纳历史在档→↻ 再来一版·否则 ✦ 优化·重开重新判定）。
 * @param {object} seg - 段对象（读 prompt）
 * @param {object} opts - { segIndex, projectId, storage, onPatch }
 * @returns {object|null} modal 实例
 */
export function openOptimizeModal(seg, opts = {}) {
  if (typeof document === "undefined" || !seg) return null;
  // #41 文档源可配置：优化文档预取失败 → 已回内置规范；首次弹层提示一次（会话级去重·换路径保存时随预取重置）
  if (consumeOptimizeDocFailedToast()) showToast("warn", t("seg.opt.docFail"));
  const segIndex = typeof opts.segIndex === "number" ? opts.segIndex : 0;
  const storage = opts.storage !== undefined ? opts.storage : _safeStorage();
  const original = typeof seg.prompt === "string" ? seg.prompt : "";
  const apply = (text) => { if (typeof opts.onPatch === "function") opts.onPatch({ prompt: text }); };

  let inst = null;
  const body = el("div", { class: "opt-body" });
  body.style.cssText = "display:flex;gap:12px;flex-wrap:wrap";

  // 模型预设行（老板复验 2026-10-26：下拉**常驻**可切换·选项=listPresets 真预设·切换即写回 gui13.llm.model）
  let presets = [];
  let presetsState = "loading";     // loading | ok | fail
  let picked = "";
  const modelRow = el("div", { class: "opt-model-row" });
  modelRow.style.cssText = "width:100%;display:flex;gap:8px;align-items:center;margin-bottom:4px";
  const modelSel = el("select", {
    class: "opt-model-sel",
    title: t("seg.opt.modelTitle"),
  });
  const modelInfo = el("span", { class: "opt-model-info" });
  modelInfo.style.cssText = "font-size:12px;color:var(--txt2)";
  modelRow.appendChild(el("span", { class: "inh", text: t("seg.opt.model") }));
  modelRow.appendChild(modelSel);
  modelRow.appendChild(modelInfo);
  body.appendChild(modelRow);

  // 本段是否已有改进版（采纳历史在档）→ 首次按钮文案（重开弹层重新判定）
  const hadImproved = readOptimizeHistory(storage).some((e) => e.segId === seg.id);
  const initialAgainLabel = hadImproved ? t("seg.opt.again") : t("seg.opt.short");

  const oldCol = _optColumn(t("seg.opt.old"), original, true, "opt-old");
  const newCol = _optColumn(t("seg.opt.new"), "", false, "opt-new");
  newCol.ta.placeholder = t("seg.opt.phNew", { btn: initialAgainLabel });
  body.appendChild(oldCol.wrap);
  body.appendChild(newCol.wrap);

  // 生成结果告警行（丢 @N 引用 → 弹层内提示·不自动采纳·不阻断手写通道）
  const warnBox = el("div", { class: "opt-warn" });
  warnBox.style.cssText = "width:100%;font-size:12px;padding:4px 0;color:#ff8a8a";
  warnBox.style.display = "none";
  body.appendChild(warnBox);

  const setWarn = (t) => {
    warnBox.textContent = t || "";
    warnBox.style.display = t ? "block" : "none";
  };

  function renderModelRow() {
    while (modelSel.firstChild) modelSel.removeChild(modelSel.firstChild);
    modelSel.appendChild(el("option", { value: "", text: t("seg.opt.phModel") }));
    for (const p of presets) {
      const name = p && typeof p.name === "string" ? p.name : "";
      if (!name) continue;
      const hasModel = typeof p.model === "string" && p.model.length > 0;
      modelSel.appendChild(el("option", { value: name, text: hasModel ? name : name + t("seg.opt.needsModel") }));
    }
    // 默认选中：键 gui13.llm.model 的匹配项；无匹配 → 留空首项
    const cur = picked || readOptModel(storage);
    const hit = !!(cur && presets.some((p) => p && p.name === cur));
    modelSel.value = hit ? cur : "";
    modelInfo.textContent = presetsState === "loading"
      ? t("seg.opt.loading")
      : presetsState === "fail"
        ? t("seg.opt.loadFail")
        : presets.length === 0
          ? t("seg.opt.noPresets")
          : t("seg.opt.shared");
  }
  modelSel.addEventListener("change", () => {
    const v = String(modelSel.value || "");
    picked = v;
    if (v) writeOptModel(storage, v);
    else clearOptModel(storage);   // 选回空首项 → 清键（与下拉显示一致）
    renderModelRow();
  });
  renderModelRow();
  void listPresets().then((r) => {
    if (typeof document === "undefined") return;   // 弹层已随页面卸载 → 不再渲染
    presetsState = r && r.ok ? "ok" : "fail";
    presets = presetsState === "ok" && Array.isArray(r.presets) ? r.presets : [];
    renderModelRow();
  }).catch(() => {
    if (typeof document === "undefined") return;
    presetsState = "fail";
    presets = [];
    renderModelRow();
  });

  // 采纳历史（E3 · 本段条目·显示原值 + 回滚）
  const histWrap = el("div", { class: "opt-hist-head" });
  histWrap.style.cssText = "width:100%;margin-top:12px";
  histWrap.appendChild(el("div", { class: "inh", text: t("seg.opt.histHead") }));
  const histBox = el("div", { class: "opt-hist-box" });
  histWrap.appendChild(histBox);
  body.appendChild(histWrap);

  const renderHist = () => {
    while (histBox.firstChild) histBox.removeChild(histBox.firstChild);
    const list = readOptimizeHistory(storage).filter((e) => e.segId === seg.id);
    if (!list.length) {
      const hint = el("div", { class: "opt-hist-empty", text: t("seg.opt.histEmpty") });
      hint.style.cssText = "color:var(--txt3);font-size:12px;padding:4px 0";
      histBox.appendChild(hint);
      return;
    }
    for (const e of list) {
      const row = el("div", { class: "opt-hist" });
      row.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:nowrap;font-size:12px;padding:4px 0;border-bottom:1px solid var(--line)";
      // 窄分辨率（老板复验 2026-10-26）：文字收缩省略·不撑宽把「回滚」钮挤到下一行
      const txt = el("span", { class: "opt-hist-text", text: t("seg.opt.histRow", { time: _optTimeText(e.ts), v: _clipText(e.before, 26) }) });
      txt.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      row.appendChild(txt);
      const rb = document.createElement("button");
      rb.type = "button";
      rb.className = "ghostbtn opt-rollback";
      rb.textContent = t("seg.common.rollback");
      rb.style.cssText = "flex-shrink:0;margin-left:auto";
      rb.addEventListener("click", () => {
        apply(e.before);
        showToast("success", t("seg.opt.rolledBack"));
        if (inst) inst.close();
      });
      row.appendChild(rb);
      histBox.appendChild(row);
    }
  };
  renderHist();

  // 三选一（E4）：生成（✦ 优化 / ↻ 再来一版）/ 不采纳 / 采纳覆盖
  //   首次文案按「本段是否已有改进版」判定（老板复验 2026-10-26）：无→✦ 优化·有→↻ 再来一版
  const againBtn = document.createElement("button");
  againBtn.type = "button";
  againBtn.className = "ghostbtn opt-again";
  againBtn.textContent = initialAgainLabel;

  // 真调 LLM（甲方案）：sendChat 不带会话 → 引擎自建独立会话·不污染 AI 协作会话
  //   口径同 staging_dialog.js:397「不发 session_id」——sendChat 会带上模块态会话·故先摘后还原
  async function callLlm(model, message) {
    const prevRaw = _llmSessionKey();
    resetCurrentSession();               // 摘掉协作会话（模块态 + 键）→ sendChat 不带 session_id
    try {
      return await sendChat({ model, message });
    } finally {
      resetCurrentSession();             // 归零本次生成产生的会话
      if (prevRaw) persistSessionId(prevRaw);
      restoreSessionId();                // 模块态回到原会话（无键 → null）
    }
  }

  function resolveModel() {
    const cur = picked || readOptModel(storage);
    if (!cur) return "";
    if (presetsState === "ok" && !presets.some((p) => p && p.name === cur)) return "";   // 查不到 → 需重选
    return cur;
  }

  let busy = false;
  async function generate() {
    if (busy) return;
    const model = resolveModel();
    if (!model) {
      showToast("warn", t("seg.opt.needModel"));
      return;
    }
    busy = true;
    againBtn.disabled = true;
    againBtn.textContent = t("seg.opt.generating");
    setWarn("");
    let generated = false;
    try {
      // 段对象安全取值：时长缺省由 buildOptimizePrompt 兜底 5s；九项只取非空串
      const lens = {};
      for (const key of SC_LENS_KEYS) {
        const v = typeof seg[key] === "string" ? seg[key].trim() : "";
        if (v) lens[key] = v;
      }
      const r = await callLlm(model, buildOptimizePrompt(original, { durationSec: seg.durationSec, lens }));
      if (!r || !r.ok) {
        showToast("error", humanizeOptError(r && r.error));
        return;
      }
      const text = String(r.reply || "").trim();
      if (!text) {
        showToast("error", t("seg.opt.emptyReply"));
        return;
      }
      newCol.ta.value = text;
      generated = true;
      // 生成后跑既有 missingAtRefs 校验：丢引用 → 弹层内告警（不自动采纳·手写通道不受阻）
      const missing = missingAtRefs(original, text);
      if (missing.length) {
        setWarn(t("seg.opt.lostRefs", { refs: missing.map((n) => "@" + n).join("、") }));
      }
    } catch (e) {
      showToast("error", t("seg.opt.genFail", { msg: (e && e.message) || t("seg.opt.unknownCause") }));
    } finally {
      busy = false;
      againBtn.disabled = false;
      // 生成成功 → 「↻ 再来一版」（已有一版）；失败 → 回到首次文案
      againBtn.textContent = generated ? t("seg.opt.again") : initialAgainLabel;
    }
  }
  againBtn.addEventListener("click", () => { void generate(); });
  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "ghostbtn opt-reject";
  rejectBtn.textContent = t("seg.opt.reject");
  rejectBtn.addEventListener("click", () => {
    showToast("info", t("seg.opt.rejected"));
    if (inst) inst.close();
  });
  const adoptBtn = document.createElement("button");
  adoptBtn.type = "button";
  adoptBtn.className = "prim opt-adopt";
  adoptBtn.textContent = t("seg.opt.adopt");
  adoptBtn.addEventListener("click", () => {
    const improved = String(newCol.ta.value || "").trim();
    if (!improved) {
      showToast("info", t("seg.opt.emptyImprove"));
      return;
    }
    const missing = missingAtRefs(original, improved);
    if (missing.length) {
      // #19②：缺失 @N 列名改卡名（registry 反查；未注册卡无名可显回落 @N——同 refChainSummary ③ 口径）
      const reg = getAssetContext().registry;
      showToast("error", t("seg.opt.adoptBlocked", { refs: missing.map((n) => reg[n] || "@" + n).join("、") }));
      return;
    }
    writeOptimizeHistory(storage, appendOptimizeRecord(readOptimizeHistory(storage), {
      id: "opt-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      segId: String(seg.id || ""),
      projectId: String(opts.projectId || ""),
      before: original,
      after: improved,
      ts: Date.now(),
    }));
    apply(improved);
    showToast("success", t("seg.opt.adopted"));
    if (inst) inst.close();
  });

  inst = openModal({
    title: t("seg.opt.cap", { n: segIndex + 1 }),
    sub: t("seg.opt.sub"),
    contentNode: body,
    footerButtons: [againBtn, rejectBtn, adoptBtn],
    closeOnBackdrop: true,
  });
  return inst;
}


// 段级后处理三控件（插帧/超分勾选+SR 模式切换·旧 SR_MODE_OPTS/SC_PROC_FIELDS/renderProcs）
// 已随 T4 #31 撤除退役（2026-10-18 口径反转「勾选=该段定制」·store 段级三键留休眠不读写）。

// ===== 徽标派生（v43 :1385/1426/1467/1508 + :1145 项目模式）=====
// 模式规则：
//   - 分镜（默认）: 首段=b-first/i2v 标题；中段=b-mid/ref2v；末段=b-last/ref2v
//   - 拼接: 全段 b-mid（拼接=链式续接，无首尾概念；v43 addSeg 默认 b-mid 印证）
//   - 自定义: 兜底按分镜规则（首/中/末）
// 边界：0 段/越界→首段（渲染兜底，不抛错）
// 段「分段模式」显式值优先出 title；自动/空 = 位置派生（零回归）
// 徽标 title 显示映射（#89 T4a）：segMode 数据值（禁译·与引擎/store 契约）→ title 键；局部名 t 让位（i18n 取词函数·shell.js:1846 先例）
export function deriveBadge({ projMode, segIndex, total, segMode }) {
  const b = deriveBadgePos({ projMode, segIndex, total });
  const tk = segMode === "ref2v · 人物优先" ? t("seg.badge.titleRef2v")
    : segMode === "FL2V · 钉住首尾" ? t("seg.badge.titleFl2v")
    : segMode === "首帧图生视频 · 首段" ? t("seg.badge.titleFirstFrame") : null;
  return tk ? { ...b, title: tk } : b;
}
function deriveBadgePos({ projMode, segIndex, total }) {
  const totalN = typeof total === "number" ? total : 0;
  const idx = typeof segIndex === "number" ? segIndex : 0;
  if (projMode === "拼接") {
    return { label: t("seg.badge.mid"), cls: "b-mid", title: t("seg.badge.titleRef2v") };
  }
  // 分镜 / 自定义 / 兜底
  if (totalN <= 1) {
    return { label: t("seg.badge.first"), cls: "b-first", title: t("seg.badge.titleFirstFrame") };
  }
  if (idx === 0) {
    return { label: t("seg.badge.first"), cls: "b-first", title: t("seg.badge.titleFirstFrame") };
  }
  if (idx >= totalN - 1) {
    return { label: t("seg.badge.last"), cls: "b-last", title: t("seg.badge.titleRef2v") };
  }
  return { label: t("seg.badge.mid"), cls: "b-mid", title: t("seg.badge.titleRef2v") };
}

// ===== 状态徽章（本批默认 st-wait；真实状态归 T6/S1-3 引擎轮询）=====
// 状态徽标四态（#89 T4a：text=显示·就近取词；cls 类名不动）
export function deriveStatusBadge(state) {
  if (state === "ok") return { cls: "st-ok", text: t("seg.status.ok") };
  if (state === "bad") return { cls: "st-bad", text: t("seg.status.bad") };
  if (state === "run") return { cls: "st-run", text: t("seg.status.run") };
  return { cls: "st-wait", text: t("seg.status.wait") };
}

// ===== S1-2 T4 附带修正 1：段删除两次确认武装态 =====
// 数据流契约：与 projects.js triggerDeleteTwoStep 形态同形（v43 :3030-3042 武装态）
//   - 首次点 .sc-del → 按钮 armed 红态 + toast「再点一次确认删除段 N（3 秒内有效）」
//   - 3 秒内再点 → 真删（removeSegment → storeSave → rerender）
//   - 超时 / 改点别处 → 自动复位
// 防御：模块级 _armedDelSeg 标志（防 mount 监听器重入，参考 projects.js _deleteArmedOp）
const ARM_WINDOW_MS = 3000;
export function armWindowMs() { return ARM_WINDOW_MS; }
export function isArmedWithinWindow(armedAt, now = Date.now()) {
  if (!armedAt) return false;
  return now - armedAt < ARM_WINDOW_MS;
}
let _armedDelSeg = null;
export function getArmedDelSeg() { return _armedDelSeg; }
export function _setArmedDelSegForTests(op) { _armedDelSeg = op; }
export function _resetDelArmedForTests() { _armedDelSeg = null; }

function triggerDelTwoStep(delBtn, seg, segIndex, opts) {
  if (_armedDelSeg === delBtn) return;
  _armedDelSeg = delBtn;
  delBtn.classList.add("armed");
  if (typeof showToast === "function") {
    showToast("info", t("seg.del.arm", { n: segIndex + 1, sec: Math.round(ARM_WINDOW_MS / 1000) }));
  }
  const onSecondClick = (e) => {
    if (!delBtn.classList.contains("armed")) return;
    e.preventDefault();
    e.stopPropagation();
    delBtn.classList.remove("armed");
    delBtn.removeEventListener("click", onSecondClick, true);
    clearTimeout(armTimer);
    _armedDelSeg = null;
    // 真删（E块：删前快照——撤销浮条恢复用·浅拷贝防后续引用变更）
    const snapshot = { ...seg };
    removeSegment(opts.project, seg.id);
    storeSave(opts.project);
    opts.rerender && opts.rerender();
    showDelUndoBar({ seg: snapshot, segIndex }, opts);
  };
  const armTimer = setTimeout(() => {
    delBtn.classList.remove("armed");
    delBtn.removeEventListener("click", onSecondClick, true);
    _armedDelSeg = null;
  }, ARM_WINDOW_MS + 100);
  delBtn.addEventListener("click", onSecondClick, true);
}

// ===== E块体验修复：段删除 5 秒撤销浮条 =====
//   真删成功后弹可撤销浮条（.sc-undo-bar·document.body 级·文案「已删除段N · 5 秒内可撤销」）：
//   5 秒内点「撤销」→ 恢复被删段到原位（addSegment 建段 + 快照字段盖回保原 id + moveSegment
//   回原 index——全走 store 已导出段操作函数·不改 store）；超时自动消失；
//   期间再删一段 → 旧浮条作废（单例互斥·新浮条接管）。
export const DEL_UNDO_MS = 5000;

let _undoBar = null;   // 在途撤销浮条（单例）
let _delUndoTimers = null;   // 测试注入定时器（_test_setDelUndoTimers·与 _previewDebounceMs 同款注入位）

export function _resetDelUndoForTests() { _undoBar = null; }
export function _test_setDelUndoTimers(t) { _delUndoTimers = (t && typeof t.setTimeout === "function" && typeof t.clearTimeout === "function") ? t : null; }

// 撤销动作：恢复被删段到原位（store 导出函数组合；原位超界（期间又删段）→ moveSegment 自钳界）
export function restoreDeletedSeg(project, projectId, seg, segIndex) {
  if (!project || !seg || !Array.isArray(project.segments)) return false;
  const restored = addSegment(project);      // 末尾追加（建全默认字段·保字段集合完整）
  Object.assign(restored, seg);              // 快照字段盖回（保原 id/提示词/镜头九项等）
  const from = project.segments.length - 1;
  const to = (Number.isInteger(segIndex) && segIndex >= 0)
    ? Math.min(project.segments.length - 1, segIndex)
    : from;
  if (from !== to) moveSegment(project, projectId, from, to);
  storeSave(project);
  return true;
}

// 旧浮条立即摘除（新删除接管·旧超时定时器到点后 close 自检无副作用）
function dismissDelUndoBar() {
  if (!_undoBar) return;
  const old = _undoBar;
  _undoBar = null;
  if (old.parentNode) old.parentNode.removeChild(old);
}

// 删除成功后弹撤销浮条（timers 可注入·测试无须真等 5 秒）
function showDelUndoBar({ seg, segIndex }, opts = {}) {
  if (typeof document === "undefined") return null;
  dismissDelUndoBar();
  const timers = _delUndoTimers || opts.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  const bar = el("div", { class: "sc-undo-bar" });
  bar.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:12px;background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:8px 14px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  bar.appendChild(el("span", { class: "sc-undo-txt", text: t("seg.del.done", { n: segIndex + 1, sec: Math.round(DEL_UNDO_MS / 1000) }) }));
  const undoBtn = el("button", { type: "button", class: "prim sc-undo-btn", text: t("seg.common.undo") });
  undoBtn.style.cssText = "cursor:pointer;border:1px solid var(--accent-deep);background:#18262b;color:var(--txt);border-radius:8px;padding:3px 12px;font-size:12px";
  let done = false;
  let timerId = null;
  const close = () => {
    if (done) return;
    done = true;
    if (timerId != null) timers.clearTimeout(timerId);
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    if (_undoBar === bar) _undoBar = null;
  };
  undoBtn.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    restoreDeletedSeg(opts.project, opts.projectId, seg, segIndex);
    close();
    opts.rerender && opts.rerender();
  });
  bar.appendChild(undoBtn);
  document.body.appendChild(bar);
  _undoBar = bar;
  timerId = timers.setTimeout(close, DEL_UNDO_MS);
  return bar;
}

// ===== 种子双向联动统一入口 =====
// 数据流契约：高级 cbox 输入框（cb-in）+ sc-meta 文本框 → 同一 patch key = "seed" → updateSegment
// 返回 { seed } 由视图层 updateSegment(p, segId, patch) 写入；store 通知 → 同步两处显示
export function buildSeedPatch(value) {
  return { seed: value == null ? "" : String(value) };
}

// ===== 拖拽→moveSegment 参数构造 =====
// DOM 段序号是 1-based（段1/段2/...）；store 数组是 0-based
// 项目沿：拖到目标卡"上方/下方"——交给 drop handler 由 dropY < midpoint 判定 toDomIdx
export function buildMoveCall({ fromDomIdx, toDomIdx, projectId }) {
  return {
    projectId,
    fromIdx: fromDomIdx - 1,
    toIdx: toDomIdx - 1,
  };
}

// ===== DOM 辅助 =====

// ===== S1-2 T5：模块级实例跟踪（顶栏 projMode 变更 → 段徽标重派生 / 拼接 chk 联动）=====
// 段卡 mount 时把 {projectId, rerender, proj} 推入 _mountedInstances；
// rerenderSegcardsByProject(projectId) 按 projectId 取出闭包并执行 rerender。
// 数据流契约：proj 是 mount 内 storeLoad 拿到的 in-memory 对象，
// 顶栏 applyTopbarChange 已 Object.assign(proj, {projMode}) 直接改了同一引用 → rerender 读最新值。
// 段卡未挂载时（同一项目多次进入 setup TAB 路由）→ 静默 no-op。
const _mountedInstances = new Map();
export function rerenderSegcardsByProject(projectId) {
  if (!projectId) return false;
  const entry = _mountedInstances.get(projectId);
  if (!entry || typeof entry.rerender !== "function") return false;
  try { entry.rerender(); return true; }
  catch (_e) { return false; }
}
export function _resetMountedInstancesForTests() { _mountedInstances.clear(); _jumpFlashSid = null; _jumpFlashUntil = 0; }

// ===== 批 R8 · ③b #001：分镜表 cf-cap savestamp（v43 :357 CSS / :1381 DOM / :2715-2727 bumpSave）=====
//   写入口 = store 保存钩子（project:save 事件）· 节流 30s（同原型 bumpSave 的 30s 缓存窗）
//   挂载即占窗：30s 内首次保存不重写（时间戳已是挂载时刻，同分钟内无视觉差）
export const SAVE_STAMP_THROTTLE_MS = 30000;
export function formatSaveStamp(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return t("seg.saveStamp", { hm: hh + ":" + mm });
}
export function shouldWriteSaveStamp(lastWriteTs, nowTs) {
  return !(lastWriteTs && nowTs - lastWriteTs < SAVE_STAMP_THROTTLE_MS);
}
let _stampSub = null;      // store 订阅句柄（首挂惰性建立·模块生命周期常驻）
let _stampLastWrite = 0;   // 节流窗起点（毫秒）
function writeSaveStamp(entry, nowTs) {
  if (!entry || !entry.stamp) return;
  if (!shouldWriteSaveStamp(_stampLastWrite, nowTs)) return;
  _stampLastWrite = nowTs;
  entry.stamp.textContent = formatSaveStamp(new Date(nowTs));
}
function ensureSaveStampSub() {
  if (_stampSub) return;
  _stampSub = storeSubscribe((ev) => {
    if (!ev || ev.type !== "project:save") return;
    for (const [pid, entry] of _mountedInstances) {
      if (pid !== ev.projectId) continue;
      writeSaveStamp(entry, Date.now());
    }
  });
}

// ===== 批 R6：段卡选中态（pv-box #013 数据接线前置 · v43 :3383 selCard）=====
//   原型 :1384 段卡 onclick=selCard(this) → .selcard 高亮 + pvSeg/pvBody 跟随；
//   本仓此前无选中态（分报告 #004 未实装）——R6 为四块预览所需补齐最小选中通道：
//   模块级选中 id + 订阅（pvbox 订阅刷新）+ 重渲染时类同步与回落首段（:6617 初始选段1）
export const ASSET_DND_TYPE = "text/x-asset-n"; // 资产 pill → 段卡 拖放载荷类型（#014 交互）
let _selectedSegId = null;
const _selSubs = new Set();

export function getSelectedSegId() { return _selectedSegId; }

/** 订阅选中变化 → 返回退订函数（pvbox 刷新用） */
export function subscribeSelected(fn) {
  _selSubs.add(fn);
  return () => _selSubs.delete(fn);
}

export function setSelectedSegId(segId) {
  const next = segId || null;
  if (_selectedSegId === next) return false;
  _selectedSegId = next;
  _applySelectionClasses();
  _notifySelection();
  return true;
}

function _notifySelection() {
  for (const fn of _selSubs) {
    try { fn({ segId: _selectedSegId }); } catch (_e) { /* 单订阅者抛错不牵连 */ }
  }
}

// 已挂载实例内按 data-seg-id 同步 .selcard（切选中/回落时逐实例套）
function _applySelectionClasses() {
  for (const entry of _mountedInstances.values()) {
    const list = entry && entry.segList;
    if (!list || typeof list.querySelectorAll !== "function") continue;
    for (const card of list.querySelectorAll(".segcard")) {
      const id = card.getAttribute ? card.getAttribute("data-seg-id") : null;
      card.classList.toggle("selcard", id === _selectedSegId);
    }
  }
}

export function _resetSelectionForTests() {
  _selectedSegId = null;
  _selSubs.clear();
}

function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = String(v);
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// 渲染单个 select 字段（v43 :1397-1406 原生 select）
function renderSelect(desc, currentValue, onChange) {
  const opts = FIELD_OPTS[desc.key] || [];
  // S2-3 T4：N7·存量值回填映射（视图层一次性套；store 字面值保留不动）
  const effective = desc.key === "分段模式" ? migrateSegMode(currentValue) : currentValue;
  const sel = el("select");
  sel.setAttribute("data-seg-key", desc.key);
  for (const opt of opts) {
    // E块体验修复：空值首项显示「（未选）」占位（value 恒空串·store 值域不变）——空列不再纯空白框
    // #89 T7：显示侧接 pickDisplay（zh 直通=改前逐字·en=MAPS.segField 英文；value=数据值零改）
    const o = el("option", { value: opt, text: opt === "" ? t("seg.common.unselected") : pickDisplay("segField", String(opt)) });
    if (effective === opt) o.selected = true;
    sel.appendChild(o);
  }
  // 兜底：effective 未匹配 → 加一个临时 option 选中（防止字段被静默丢值）
  if (effective != null && effective !== "" && !opts.includes(effective)) {
    const o = el("option", { value: effective, text: pickDisplay("segField", String(effective)) });   // #89 T7：显示侧接 pickDisplay（表外值直通）
    o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

// 渲染种子 cbox（复用 cbox.js）
function renderSeedCbox(currentValue, onChange) {
  const opts = FIELD_OPTS["种子"];
  // #89 T7：cbox 选项显示侧经 MAPS.segField——zh 直通=原串逐字；en=「值=英文label」形态
  //   （cbox.js openMenu 显示 = 后 label·applyOption 拆回原值派发 change；42/1024 ASCII label===值原样）
  const optsDisp = opts.split("|").map((v) => {
    const lab = pickDisplay("segField", v);
    return lab === v ? v : v + "=" + lab;
  }).join("|");
  const box = el("div", { class: "cbox edit", "data-opts": optsDisp, "data-seedbox": "1", title: t("seg.seedBoxTitle") });
  const input = el("input", { class: "cb-in" });
  input.setAttribute("type", "text");
  input.value = currentValue == null ? "" : String(currentValue);
  const a = el("span", { class: "cb-a", text: "▾" });
  box.appendChild(input);
  box.appendChild(a);
  box.addEventListener("change", (ev) => {
    const v = ev && ev.detail && ev.detail.value != null ? ev.detail.value : input.value;
    onChange(v);
  });
  return box;
}

// 渲染导出名 input
function renderExportName(currentValue, onChange) {
  const input = el("input", { type: "text" });
  input.setAttribute("data-seg-key", "exportName");
  input.value = currentValue == null ? "" : String(currentValue);
  input.style.cssText = "flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 6px;color:var(--txt);font-size:12px;outline:none";
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

// 渲染 sc-grid 的单个 fld（label + 控件）
//   extras.stack：竖排紧凑版式（标签置顶·镜像 .sc-adv.show .sc-grid .fld）——镜头区用
function renderFld(desc, currentValue, onChange, extras) {
  const wrap = el("div", { class: "fld" });
  const lab = el("label", { text: t(desc.tkey) });   // 显示侧取词（keycheck tkey 形态·数据键 desc.key 不动）
  wrap.appendChild(lab);
  let ctrl;
  if (desc.control === "cbox.edit" && desc.key === "seed") {
    ctrl = renderSeedCbox(currentValue, onChange);
  } else if (desc.control === "input") {
    ctrl = renderExportName(currentValue, onChange);
  } else if (desc.control === "select") {
    ctrl = renderSelect(desc, currentValue, onChange);
  } else {
    ctrl = el("span", { text: String(currentValue || "") });
  }
  // G5：手写入口随「方向」字段——体验修复 E1：与下拉同行排列（select 占主宽+紧凑图标钮），
  //   不再上下堆叠（旧版把方向列下拉挤到 29px·九列高度不齐）
  if (desc.key === "运镜方向" && extras && typeof extras.onStroke === "function") {
    const row = el("div", { class: "sc-dir-row" });
    row.style.cssText = "display:flex;align-items:center;gap:4px";
    row.appendChild(ctrl);
    row.appendChild(makeStrokeEntry(extras.onStroke));
    ctrl = row;
  }
  wrap.appendChild(ctrl);
  // #69 C1：镜头区紧凑竖排（标签置顶·与高级区六列同版式）
  if (extras && extras.stack) {
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "stretch";
    wrap.style.gap = "3px";
    lab.style.width = "auto";
  }
  return wrap;
}

// 渲染 sc-head（v43 :1385）
function renderHead(seg, segIndex, total, projMode, onFold, onDelete, onDragStart) {
  const head = el("div", { class: "sc-head" });
  // 段号
  head.appendChild(el("span", { class: "no num", text: t("seg.segNo", { n: segIndex + 1 }) }));
  // 分段模式徽标
  const badge = deriveBadge({ projMode, segIndex, total, segMode: seg["分段模式"] });
  head.appendChild(el("span", { class: `badge ${badge.cls}`, title: badge.title, text: badge.label }));
  // 状态徽章（本批默认 wait）
  const status = deriveStatusBadge();
  head.appendChild(el("span", { class: status.cls, text: status.text }));
  // 拖拽手柄（v43 :1385 sc-drag）
  const drag = el("span", { class: "sc-drag", title: t("seg.dragTitle"), text: "⠿" });
  drag.setAttribute("draggable", "true");
  drag.addEventListener("dragstart", (ev) => {
    if (typeof ev.dataTransfer !== "undefined") {
      ev.dataTransfer.setData("text/x-seg-id", seg.id);
      ev.dataTransfer.effectAllowed = "move";
    }
    onDragStart && onDragStart(seg);
  });
  head.appendChild(drag);
  // 折叠箭头
  const fold = el("span", { class: "sc-fold", text: "▾" });
  head.appendChild(fold);
  // 删除按钮（J8 裁决 2026-09-27：段删除为直接删无回收站通道，title 去「进回收站」对齐实况·原型 :1385 字样作废）
  const del = el("span", { class: "sc-del", title: t("seg.delTitle"), text: "✕" });
  del.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // S1-2 T4 附带修正 1：武装态下防重入（与 projects.js 同形）
    if (_armedDelSeg === del) return;
    onDelete(seg);
  });
  head.appendChild(del);
  // 卡片头点击折叠（v43 :3375 segFold · 排除 .sc-del/.sc-drag/.sc-fold）
  head.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".sc-del, .sc-drag, .sc-fold")) return;
    onFold(head);
  });
  return head;
}

// 渲染 sc-adv-t（高级折叠条 · v43 :1386）
function renderAdvToggle() {
  const bar = el("div", { class: "sc-adv-t" });   // 局部名原为 t·与 i18n 取词函数 t() 同名遮蔽·T4a 改名 bar 让位（shell.js:1846 先例）
  // 批 R7 · #005：adv-ico = data-ic=sliders 13（原型 v43 :1386 · 替换「▦」字符）
  const ico = el("span", { class: "adv-ico", "data-ic": "sliders", "data-sz": "13" });
  bar.appendChild(ico);
  bar.appendChild(el("b", { text: t("seg.common.adv") }));
  bar.appendChild(el("span", { class: "inh", text: t("seg.advSub") }));
  // 批 R7 · #006：arr = data-ic=chev 14（原型 v43 :1386 · 替换「▾」字符）
  const arr = el("span", { class: "arr", "data-ic": "chev", "data-sz": "14" });
  bar.appendChild(arr);
  bar.addEventListener("click", () => {
    const adv = bar.nextElementSibling;
    if (!adv || !adv.classList || !adv.classList.contains("sc-adv")) return;
    adv.classList.toggle("show");
    bar.classList.toggle("open", adv.classList.contains("show"));
  });
  return bar;
}

// 渲染 sc-fl 首帧概念图行（S3-2 T8·仅 FL 辅助段返回非 null）
//   仓内自制控件：v43 原型段卡区无对应形态（grep「概念图/首帧概念」无命中），按段卡 sc-procs/fld 惯例自定
//   选中 → 段 prompt 末尾追加 " @N"（appendFirstFrameRefToPrompt·幂等）
//   清除 → 只剥末尾 " @N"（removeFirstFrameRefFromPrompt·不动手写内容）
//   回显 → 按 prompt 内 first_frame @N 反查（pickFirstFrameRefForPrompt·不发明新 schema）
// 首帧概念图下拉 title 原模块常量 FL_PICKER_TITLE 已入典 seg.flTitle（#89 T4a·取词就近）
function renderFlPicker(seg, onPatch) {
  if (!isFlAidedSegMode(migrateSegMode(seg["分段模式"]))) return null;
  const ctx = getAssetContext();
  const cur = pickFirstFrameRefForPrompt(seg.prompt, ctx.registry, ctx.assets);
  const row = el("div", { class: "sc-fl" });
  row.appendChild(el("label", { text: t("seg.flLabel") }));
  const sel = el("select", { title: t("seg.flTitle") });
  sel.setAttribute("data-seg-ff", "1");
  const clearOpt = el("option", { value: "", text: t("seg.flNone") });
  if (cur == null) clearOpt.selected = true;
  sel.appendChild(clearOpt);
  for (const o of listConceptFrameOptions(ctx.assets, ctx.registry)) {
    const opt = el("option", { value: String(o.n), text: o.name });   // #19⑥：只显卡名；value=@N 数据通道不动
    if (cur === o.n) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const raw = sel.value;
    const n = (raw === "" || raw == null) ? null : Number(raw);
    const next = (n == null)
      ? removeFirstFrameRefFromPrompt(seg.prompt, pickFirstFrameRefForPrompt(seg.prompt, ctx.registry, ctx.assets))
      : appendFirstFrameRefToPrompt(seg.prompt, n);
    if (next !== seg.prompt) onPatch({ prompt: next });
  });
  row.appendChild(sel);
  return row;
}

// 渲染「镜头」紧凑常驻区（#69 C1·运镜单列）
//   六件 = 运镜方式/运镜方向/运镜幅度/运镜速度 + 景别/角度（从高级折叠区提出·常驻卡面）
//   必碰点①：onStroke 笔画入口随「运镜方向」字段迁入本区（入口不丢·手写仍可用）
//   必碰点②：applyMoveDirGate / applyStroke 的 select 查询作用域 = 本容器（环绕 → 仅顺/逆仍生效）
//   C2：已选值摘要行（.sc-lens-sum·非空才出行·改选就地刷新）
function renderLens(seg, onPatch) {
  const lens = el("div", { class: "sc-lens sc-grid" });
  // 版式沿用 .sc-adv.show 六列紧凑栅格思路（不新增 css 文件）。
  // E块体验修复：auto-fit+minmax(110px) 在 1440 内容区（段卡约 1149px）把 9 列全压最小宽；
  //   纯提 130px 会退化 8+1 换行错乱（9×130+80gap=1250 > 1149）→ 改固定 9 轨道均分：
  //   九列恒同行（不换行），1440 均分约 119px、1920 约 172px；minmax(0,1fr) 防长词撑破列。
  lens.style.cssText = "grid-template-columns:repeat(9,minmax(0,1fr));gap:8px 10px;margin:0 0 8px";
  const title = el("span", { class: "sc-lens-t", text: t("seg.lensTitle") });
  title.style.cssText = "grid-column:1/-1;font-size:11px;color:var(--txt3)";
  lens.appendChild(title);

  const vals = {};      // 六件当前值（摘要行刷新用）
  let dirSel = null;    // 方向 select（gate 联动目标）
  let sumRow = null;    // 摘要行（全空 → 不存在）

  const refreshSummary = () => {
    const text = buildCameraSummary(vals);
    if (!text) {
      if (sumRow) { lens.removeChild(sumRow); sumRow = null; }
      return;
    }
    if (!sumRow) {
      sumRow = el("div", { class: "sc-lens-sum" });
      sumRow.style.cssText = "grid-column:1/-1;font-size:12px;color:var(--txt2)";
      lens.appendChild(sumRow);
    }
    sumRow.textContent = text;
  };

  // G5 手写回填：只写 store 不够 —— 全仓无 segment:update→段卡重渲订阅，
  //   故必须同步「运镜方式」「运镜方向」select 显示值 + 即时跑一次方向 gate（否则卡面停在旧值/旧置灰态）。
  const applyStroke = (patch) => {
    onPatch(patch);
    if (!patch) return;
    const v = patch["运镜方式"];
    const d = patch["运镜方向"];
    if (typeof v === "string" && v) {
      const moveSel = lens.querySelector('[data-seg-key="运镜方式"]');
      if (moveSel) moveSel.value = v;
      vals["运镜方式"] = v;
      // 方向选项集随新方式重算（环绕 → 顺/逆）·keepValue = 本次识别出的方向（保留·不丢）
      applyMoveDirGate(dirSel, v, d);
    }
    if (typeof d === "string" && d) {
      setSelectValueSafe(dirSel, d);
      vals["运镜方向"] = d;
    }
    refreshSummary();
  };

  for (const key of SC_LENS_KEYS) {
    const desc = SC_FIELDS.find((d) => d.key === key);
    if (!desc) continue;
    vals[key] = typeof seg[key] === "string" ? seg[key] : "";
    lens.appendChild(renderFld(desc, seg[key], (val) => {
      onPatch({ [desc.key]: val });
      vals[desc.key] = val;
      // 运镜方式变更 → 方向置灰/选项过滤联动即时生效（不等重渲染）
      if (desc.key === "运镜方式") applyMoveDirGate(dirSel, val);
      refreshSummary();
    }, desc.key === "运镜方向"
      ? { onStroke: () => openStrokeModal({ onPatch: applyStroke }), stack: true }
      : { stack: true }));
  }
  dirSel = lens.querySelector('[data-seg-key="运镜方向"]');
  applyMoveDirGate(dirSel, seg["运镜方式"]);
  refreshSummary();
  return lens;
}

// 渲染 sc-adv 高级区体（sc-grid + 首帧概念图行·旧 sc-procs 行随 T4 #31 撤除退役）
//   #79：镜头九项已收进紧凑条展开容器（renderLens）——本区只剩 种子/导出名/分段模式
function renderAdv(seg, onPatch, onModeChange) {
  const adv = el("div", { class: "sc-adv" });
  const grid = el("div", { class: "sc-grid" });
  for (const desc of SC_FIELDS) {
    if (!SC_ADV_KEYS.includes(desc.key)) continue;
    const cur = seg[desc.key];
    grid.appendChild(renderFld(desc, cur, (val) => {
      const patch = desc.key === "seed" ? buildSeedPatch(val) : { [desc.key]: val };
      onPatch(patch);
      // 分段模式决定首帧概念图下拉显隐 → 变更后重渲染段卡（其余字段无此依赖）
      if (desc.key === "分段模式" && typeof onModeChange === "function") onModeChange();
    }));
  }
  adv.appendChild(grid);
  const flRow = renderFlPicker(seg, onPatch);
  if (flRow) adv.appendChild(flRow);
  return adv;
}

// ============================================================================
// #79 段卡拍摄控制紧凑条（排戏按钮旁 mini 入口 + meta 行后可折叠容器 .sc-cam）
//   收起态（.sc-cam-t·meta 行内）：入口名「拍摄控制」+ 镜头摘要（复用 T-C C2 buildCameraSummary）
//                                + 参考视频缩略小标（有挂载才显）
//   展开态（.sc-cam·meta 行后）：①镜头九项编辑（renderLens·T-C 常驻镜头区回炉收进本容器）
//                              ②参考视频管理（缩略图列表 / 点击播放 / × 删除 / 手动添加）
//                              ③运镜来源选择（#80·挂参考即显·默认参考）
//   展开/折叠：仿 sc-adv-t 先例（classList toggle·无持久化）
// ============================================================================

// 视频扩展名（引擎抽帧族 __init__.py _THUMB_VIDEO_EXTS 同款·文件选择过滤用）
const CAM_VIDEO_EXTS = [".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv"];
// #74 G-W2a：参考音频扩展名（引擎 _resolve_file 只认 input 目录 basename·此表仅前端文件过滤）
const CAM_AUDIO_EXTS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"];
// #74 G-W2a W9 口径文案（正反向·逐字锁：干净人声 / 人声分离 / 不保证音色完全一致）
// W9 口径文案（正反向逐字）已入典 seg.audioNote（zh 值=面板同源常量逐字·#89 T4a·等价测试 A 节锁）

// E块体验修复：缩略徽章碎图兜底（引擎缩略 404/路径失效 → 灰底小图标 data-URI 占位·不显浏览器碎图）
const CAM_BADGE_FALLBACK = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" rx="4" fill="#23262c"/><path d="M5.5 13.5l3-3.5 2 2.5 2-2.5 2.5 3.5" stroke="#67707a" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
);
function wireBadgeFallback(im) {
  im.addEventListener("error", () => {
    // 占位图自身不再换（防 error 循环）
    if (im.getAttribute("src") !== CAM_BADGE_FALLBACK) im.setAttribute("src", CAM_BADGE_FALLBACK);
  });
}

// 段级槽列表（原始槽·展示层口径：#80 闸门只挡引擎注入·槽本身仍可见可管）
//   field = 段级槽容器字段（#74：视频/音频同族）
function stagingRefsListOf(seg, field) {
  const r = seg && seg[field];
  if (!r || typeof r !== "object" || Array.isArray(r)) return [];
  const out = [];
  for (const key of Object.keys(r)) {
    const e = r[key];
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const media = typeof e.media === "string" ? e.media : "";
    if (!media) continue;
    const idx = Number(key);
    out.push({
      slot: Number.isInteger(idx) ? idx : 0,
      media,
      usages: Array.isArray(e.usages) ? e.usages.slice() : [],
      cardName: typeof e.cardName === "string" ? e.cardName : "",
    });
  }
  out.sort((a, b) => a.slot - b.slot);
  return out;
}

export function stagingRefsList(seg) {
  return stagingRefsListOf(seg, "stagingVideoRefs");
}

// 段级参考音频槽列表（#74·镜像 stagingRefsList）
function stagingAudioRefsList(seg) {
  return stagingRefsListOf(seg, "stagingAudioRefs");
}

// 段级槽清空（× 入口·不可变克隆 → 删该槽 → updateSegment + storeSave·与挂槽同口径）
//   共享件：段卡紧凑条（#79 参考管理 ×）与 pvbox 段级槽胶囊（档2 T4 ×）同一实现
//   field = 段级槽容器字段（#74：视频/音频同族·缺省=视频槽）
export function clearStagingSlot(project, segId, slot, field = "stagingVideoRefs") {
  if (!project || !Array.isArray(project.segments)) return false;
  const seg = project.segments.find((s) => s && s.id === segId);
  if (!seg) return false;
  const refs = seg[field];
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return false;
  const key = String(slot);
  if (!refs[key]) return false;
  const next = { ...refs };
  delete next[key];
  if (!updateSegment(project, segId, { [field]: next })) return false;
  storeSave(project);
  return true;
}

function camMediaBasename(media) {
  return String(media || "").split(/[\\/]/).pop() || "";
}

// 运镜来源选择（#80·挂参考即显·默认参考·选择持久化到段字段 stagingCamSource）
function renderCamSource(seg, onPatch) {
  const wrap = el("div", { class: "sc-cam-src" });
  wrap.appendChild(el("span", { class: "sc-cam-cap", text: t("seg.camSource") }));
  const sel = el("select", {
    class: "sc-cam-src-sel",
    title: t("seg.camSourceTitle"),
  });
  sel.setAttribute("data-cam-source", "1");
  for (const [v, label] of [
    [CAM_SOURCE_REF, t("seg.camSrcRef")],
    [CAM_SOURCE_TEXT, t("seg.camSrcText")],
  ]) {
    const o = el("option", { value: v, text: label });
    if (camSourceOf(seg) === v) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    const v = sel.value === CAM_SOURCE_TEXT ? CAM_SOURCE_TEXT : CAM_SOURCE_REF;
    onPatch({ stagingCamSource: v });
    showToast("info", v === CAM_SOURCE_TEXT
      ? t("seg.camSrcTextToast")
      : t("seg.camSrcRefToast"));
  });
  wrap.appendChild(sel);
  return wrap;
}

// 参考视频播放（行内 <video>·引擎口优先 + 本地流兜底·inpaint_dialog 同款口径）
function toggleCamVideo(row, media) {
  const cur = row.querySelector(".sc-cam-video");
  if (cur) { row.removeChild(cur); return; }
  const v = el("video", { class: "sc-cam-video", controls: "controls", preload: "metadata" });
  v.setAttribute("src", mediaUrl("video", media));
  wireLocalFallback(v, "video", media);
  row.appendChild(v);
}

// 参考音频试听（#74·行内 <audio>·与视频槽同款双通道：引擎口优先 + 本地流兜底）
function toggleCamAudio(row, media) {
  const cur = row.querySelector(".sc-cam-audio");
  if (cur) { row.removeChild(cur); return; }
  const a = el("audio", { class: "sc-cam-audio", controls: "controls", preload: "metadata" });
  a.setAttribute("src", mediaUrl("audio", media));
  a.style.cssText = "width:220px;max-width:100%";
  wireLocalFallback(a, "audio", media);
  row.appendChild(a);
}

// 紧凑条构建（返回 {entry, box}）：entry = meta 行内 mini 入口·box = meta 行后可折叠容器
function buildCamBar(seg, onPatch, opts) {
  const entry = el("span", { class: "mini sc-cam-t", title: t("seg.camEntryTitle") });
  const box = el("div", { class: "sc-cam" });
  const refsBox = el("div", { class: "sc-cam-refs" });
  const srcBox = el("div", { class: "sc-cam-srcbox" });
  const audioBox = el("div", { class: "sc-cam-audio-refs" });

  // ① 镜头九项（改选 → 收起态摘要就地刷新·不等重渲染）
  box.appendChild(renderLens(seg, (patch) => { onPatch(patch); refreshEntry(); }));
  box.appendChild(refsBox);
  box.appendChild(srcBox);
  box.appendChild(audioBox);

  // 展开/折叠（仿 sc-adv-t：classList toggle·无持久化）
  entry.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    entry.classList.toggle("open", box.classList.toggle("show"));
  });

  // ② 手动添加（拖视频资产）：落段级槽首空槽（pvbox 槽胶囊拖放先例·落点差异=段级槽）
  box.addEventListener("dragover", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (dt) dt.dropEffect = "copy";
  });
  box.addEventListener("drop", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    // 止冒泡：段卡自身 drop 通道会把 @N 落段词（此处是挂参考槽·两动作互斥）
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    const fill = dropPayloadToSlotFill(dt, "Video", getAssetContext());
    if (!fill || !fill.media) { showToast("info", t("seg.dropNotVideo")); return; }
    addRef(fill.media, fill.cardName || "");
  });

  // 参考音频区拖放（#74·独立落点=音频区·止冒泡防误落视频槽/段词）
  audioBox.addEventListener("dragover", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (dt) dt.dropEffect = "copy";
  });
  audioBox.addEventListener("drop", (ev) => {
    const dt = ev && ev.dataTransfer;
    if (!dtHasType(dt, ASSET_DT_MIME) && !dtHasType(dt, ASSET_DND_TYPE)) return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    const fill = dropPayloadToSlotFill(dt, "Audio", getAssetContext());
    if (!fill || !fill.media) { showToast("info", t("seg.dropNotAudio")); return; }
    addAudioRef(fill.media, fill.cardName || "");
  });

  // 收起态内容（入口名 + 镜头摘要 + 参考缩略小标）
  function refreshEntry() {
    while (entry.firstChild) entry.removeChild(entry.firstChild);
    const summary = buildCameraSummary(seg);
    const refs = stagingRefsList(seg);
    // 老板复验（2026-10-26）：入口只显摘要缺入口名 → 前缀「拍摄控制」（有摘要带「·」分隔）
    if (summary) entry.appendChild(el("span", { class: "sc-cam-sum", text: t("seg.cam") + " · " + summary }));
    else entry.appendChild(el("span", { class: "sc-cam-none", text: t("seg.cam") }));
    if (refs.length) {
      const badges = el("span", { class: "sc-cam-badges" });
      for (const r of refs) {
        const im = el("img", { class: "sc-cam-badge", title: r.media });
        im.setAttribute("src", thumbUrlOf(r.media));
        wireBadgeFallback(im);
        wireLocalFallback(im, "thumb", r.media, { maxSize: 512 });
        badges.appendChild(im);
      }
      entry.appendChild(badges);
    }
  }

  // ② 参考视频管理区（缩略图列表 / 播放 / × 删除 / 手动添加）+ ③ 运镜来源选择
  function refreshRefs() {
    while (refsBox.firstChild) refsBox.removeChild(refsBox.firstChild);
    const refs = stagingRefsList(seg);
    refsBox.appendChild(el("span", { class: "sc-cam-cap", text: t("seg.refsVideo") }));
    if (!refs.length) {
      refsBox.appendChild(el("span", { class: "sc-cam-hint", text: t("seg.refsVideoHint") }));
    }
    for (const r of refs) {
      const row = el("div", { class: "sc-cam-ref" });
      const im = el("img", { class: "sc-cam-thumb", title: r.media });
      im.setAttribute("src", thumbUrlOf(r.media));
      wireBadgeFallback(im);   // G4b③：两路（引擎口→本地口）皆失败 → data-URI 占位终态（不显碎图）
      wireLocalFallback(im, "thumb", r.media, { maxSize: 512 });
      im.addEventListener("click", () => toggleCamVideo(row, r.media));
      row.appendChild(im);
      row.appendChild(el("span", {
        class: "sc-cam-refname",
        text: camMediaBasename(r.media) + (r.cardName ? " · " + r.cardName : ""),
      }));
      const del = el("span", { class: "sc-cam-del", text: "✕", title: t("seg.delRefVTitle") });
      del.addEventListener("click", (ev) => {
        if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
        if (!clearStagingSlot(opts.project, seg.id, r.slot)) return;
        refreshRefs();
        refreshEntry();
      });
      row.appendChild(del);
      refsBox.appendChild(row);
    }
    const add = el("span", { class: "sc-cam-add", text: t("seg.addFile"), title: t("seg.addFileVTitle") });
    add.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      openPicker({
        title: t("seg.pickVideoTitle"),
        mode: "file",
        exts: CAM_VIDEO_EXTS,
        onPick: (picked) => { if (typeof picked === "string" && picked) addRef(picked, camMediaBasename(picked)); },
      });
    });
    refsBox.appendChild(add);
    // 甲方案：素材池（参数页）与段卡（提示词页）分居两页·拖拽跨页不可达 → 补点按入口
    //   （与拖放同款调用 addRef·同款槽满提示·取值行同口径：首个 Video 用途行）
    const addAsset = el("span", { class: "sc-cam-add", text: t("seg.addAsset"), title: t("seg.addAssetVTitle") });
    addAsset.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      void pickerAssets().then((assets) => {
        openAssetPicker({
          kind: "Video",
          title: t("seg.assetPickVideoTitle"),
          assets,
          onPick: (it) => { if (it && it.media) addRef(it.media, it.name); },
        });
      });
    });
    refsBox.appendChild(addAsset);
    // ③ 运镜来源：挂参考即显（无参考不显）——选择常可见·无暗闸门态
    while (srcBox.firstChild) srcBox.removeChild(srcBox.firstChild);
    if (refs.length) srcBox.appendChild(renderCamSource(seg, onPatch));
  }

  // 段级槽新增（首空槽·段级槽域 = SEG_AV_SLOT_MAX·与 staging_attach 档2 同域）
  function addRef(media, cardName) {
    const refs = (seg.stagingVideoRefs && typeof seg.stagingVideoRefs === "object" && !Array.isArray(seg.stagingVideoRefs))
      ? seg.stagingVideoRefs : {};
    let slot = "";
    for (let i = 1; i <= SEG_AV_SLOT_MAX; i++) {
      if (!refs[String(i)]) { slot = String(i); break; }
    }
    if (!slot) {
      showToast("info", t("seg.slotsFull", { max: SEG_AV_SLOT_MAX }));
      return false;
    }
    const next = { ...refs, [slot]: { media, usages: ["video_ref"], cardName: cardName || "" } };
    onPatch({ stagingVideoRefs: next });
    refreshRefs();
    refreshEntry();
    return true;
  }

  // 参考音频管理区（#74·镜像参考视频区：列表/试听/× 删除/手动添加 + W9 口径文案）
  //   与视频槽独立：不受 #80 运镜来源闸门影响（闸门只挡视频注入）
  function refreshAudioRefs() {
    while (audioBox.firstChild) audioBox.removeChild(audioBox.firstChild);
    const refs = stagingAudioRefsList(seg);
    audioBox.appendChild(el("span", { class: "sc-cam-cap", text: t("seg.refsAudio") }));
    if (!refs.length) {
      audioBox.appendChild(el("span", { class: "sc-cam-hint", text: t("seg.refsAudioHint") }));
    }
    for (const r of refs) {
      const row = el("div", { class: "sc-cam-ref sc-cam-aref" });
      const play = el("span", { class: "sc-cam-play", text: "▶", title: t("seg.auditionTitle") });
      play.style.cssText = "cursor:pointer;color:var(--txt2);padding:0 4px";
      play.addEventListener("click", () => toggleCamAudio(row, r.media));
      row.appendChild(play);
      row.appendChild(el("span", {
        class: "sc-cam-refname",
        text: camMediaBasename(r.media) + (r.cardName ? " · " + r.cardName : ""),
      }));
      const del = el("span", { class: "sc-cam-del", text: "✕", title: t("seg.delRefATitle") });
      del.addEventListener("click", (ev) => {
        if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
        if (!clearStagingSlot(opts.project, seg.id, r.slot, "stagingAudioRefs")) return;
        refreshAudioRefs();
      });
      row.appendChild(del);
      audioBox.appendChild(row);
    }
    const add = el("span", { class: "sc-cam-add", text: t("seg.addFile"), title: t("seg.addFileATitle") });
    add.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      openPicker({
        title: t("seg.pickAudioTitle"),
        mode: "file",
        exts: CAM_AUDIO_EXTS,
        onPick: (picked) => { if (typeof picked === "string" && picked) addAudioRef(picked, camMediaBasename(picked)); },
      });
    });
    audioBox.appendChild(add);
    const addAsset = el("span", { class: "sc-cam-add", text: t("seg.addAsset"), title: t("seg.addAssetATitle") });
    addAsset.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      void pickerAssets().then((assets) => {
        openAssetPicker({
          kind: "Audio",
          title: t("seg.assetPickAudioTitle"),
          assets,
          onPick: (it) => { if (it && it.media) addAudioRef(it.media, it.name); },
        });
      });
    });
    audioBox.appendChild(addAsset);
    // W9 口径文案（正反向逐字·与面板同源常量）
    const note = el("span", { class: "sc-cam-note", text: t("seg.audioNote") });
    note.style.cssText = "display:block;font-size:11px;line-height:1.5;color:var(--txt3);margin-top:6px";
    audioBox.appendChild(note);
  }

  // 段级音频槽新增（首空槽·域 = SEG_AV_SLOT_MAX·第 4 条人话拒绝）
  function addAudioRef(media, cardName) {
    const refs = (seg.stagingAudioRefs && typeof seg.stagingAudioRefs === "object" && !Array.isArray(seg.stagingAudioRefs))
      ? seg.stagingAudioRefs : {};
    let slot = "";
    for (let i = 1; i <= SEG_AV_SLOT_MAX; i++) {
      if (!refs[String(i)]) { slot = String(i); break; }
    }
    if (!slot) {
      showToast("info", t("seg.aSlotsFull", { max: SEG_AV_SLOT_MAX }));
      return false;
    }
    const next = { ...refs, [slot]: { media, usages: ["audio_ref"], cardName: cardName || "" } };
    onPatch({ stagingAudioRefs: next });
    refreshAudioRefs();
    return true;
  }

  refreshEntry();
  refreshRefs();
  refreshAudioRefs();
  return { entry, box };
}

// 渲染 sc-prompt textarea（v43 :1409）
function renderPrompt(seg, onPatch, onInput) {
  const ta = el("textarea", { class: "gp sc-prompt", rows: "2" });
  // E块体验修复：空段卡给出引导占位（@ 引用资产 / 词库插入镜头词）
  ta.setAttribute("placeholder", t("seg.promptPh"));
  ta.value = seg.prompt || "";
  ta.addEventListener("input", () => {
    onPatch({ prompt: ta.value });
    if (typeof onInput === "function") onInput();   // T5：段词停 400ms → 引擎实时预览
  });
  return ta;
}

// 渲染 sc-meta 行（v43 :1416-1423 · 时长/种子 text/与上一段拼接/mode-note/4 mini）
function renderMeta(seg, segIndex, total, projMode, onPatch, opts, card, camBar) {
  const meta = el("div", { class: "sc-meta" });
  meta.appendChild(document.createTextNode(t("seg.metaDur")));
  const dur = el("input", { type: "number" });
  dur.setAttribute("data-seg-meta", "durationSec");
  dur.value = seg.durationSec;
  dur.min = "1";
  dur.max = "60";
  dur.addEventListener("input", () => {
    const v = parseInt(dur.value, 10);
    if (!Number.isNaN(v) && v > 0) onPatch({ durationSec: v });
  });
  meta.appendChild(dur);
  meta.appendChild(document.createTextNode(t("seg.metaSeed")));
  // sc-meta 种子 text：与高级区种子 cbox 双向联动（同一 patch key = 'seed'）
  const seedIn = el("input", { type: "text" });
  seedIn.setAttribute("data-seg-meta", "seed");
  seedIn.value = seg.seed || "";
  seedIn.style.width = "66px";
  seedIn.title = t("seg.seedMetaTitle");
  seedIn.addEventListener("input", () => onPatch(buildSeedPatch(seedIn.value)));
  meta.appendChild(seedIn);
  meta.appendChild(document.createTextNode(" · "));
  // 拼接行（chain-row + sc-chain）
  const chainLabel = el("label", { class: "chain-row" });
  chainLabel.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer";
  const chainCb = el("input", { type: "checkbox", class: "sc-chain" });
  chainCb.checked = !!seg.concat;
  chainCb.addEventListener("change", () => onPatch({ concat: chainCb.checked }));
  chainLabel.appendChild(chainCb);
  chainLabel.appendChild(document.createTextNode(t("seg.metaConcat")));
  meta.appendChild(chainLabel);
  // mode-note（分镜=全部不合并；合并=全部合并锁死；自定义=自由）——E块词表：「拼接」→「合并」仅用户可见文案
  const note = el("span", { class: "mode-note" });
  if (projMode === "分镜") {
    note.textContent = t("seg.modeNote");
    chainLabel.style.display = "none";
  } else if (projMode === "拼接") {
    note.textContent = "";
    chainCb.checked = true;
    chainCb.disabled = true;
    chainLabel.title = t("seg.modeConcatTitle");
  } else {
    note.textContent = "";
    chainLabel.title = t("seg.modeCustomTitle");
  }
  meta.appendChild(note);
  // ✦ 一键优化（S3-4 B8 · 空-010 · 拍板 E 组）：开优化弹层（原版/改进版并排 · 三选一 · 采纳历史）
  const fx = el("span", { class: "mini", title: t("seg.opt.miniTitle"), text: t("seg.opt.short") });
  fx.style.cursor = "pointer";
  fx.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openOptimizeModal(seg, {
      segIndex,
      projectId: (opts && opts.projectId) || "",
      onPatch,
    });
  });
  meta.appendChild(fx);
  // 批 3-T3 F8 词库助手（原批 0-T5 占位转正）：点「词库」→ 面板挂本卡内（meta 行后）→
  //   fetchVocab 九组词条（ui/vocab.js 内建）→ 点词条 → 追加到本卡 .sc-prompt 值末尾
  //   （口径定稿：追加非光标插入·照 1.0 定案「不动光标」）+ 派发 input（防抖预览链不断）；
  //   引擎断连 → 面板显示「词库不可用（引擎未连接）」提示（同件内建）。
  //   F49：同一「词库」再点 → 收起（toggle）；别卡点 → 面板迁移过去并展开。
  const lex = el("span", { class: "mini", title: t("seg.vocabTitle"), text: t("seg.vocab") });
  lex.style.cursor = "pointer";
  lex.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleVocabPanel({
      host: card,
      onInsert: (word) => {
        const ta = card.querySelector(".sc-prompt");
        if (ta) appendVocabWord(ta, word);
      },
    });
  });
  meta.appendChild(lex);
  // 甲方案：素材池（参数页）与段卡（提示词页）分居两页·拖拽跨页不可达 → 提示词区给点按入口
  //   （插入 @卡名 · 与资产 pill 拖放同口径：appendAssetNameRefToPrompt·幂等判重按 @名字 token）
  const insAsset = el("span", { class: "mini", title: t("seg.insAssetTitle"), text: t("seg.insAsset") });
  insAsset.style.cursor = "pointer";
  insAsset.addEventListener("click", (ev) => {
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    void pickerAssets().then((assets) => {
      openAssetPicker({
        kind: "Picture",
        title: t("seg.insAssetPickerTitle"),
        assets,
        onPick: (it) => {
          if (!it || !it.name) return;
          const ta = currentSegPromptTextarea((opts && opts.projectId) || "", seg.id);
          const cur = (ta && typeof ta.value === "string") ? ta.value : String(seg.prompt || "");
          const next = appendAssetNameRefToPrompt(cur, it.name);
          if (next === cur) {
            showToast("info", t("seg.refDup", { name: it.name }));
            return;
          }
          if (ta) {
            ta.value = next;
            if (typeof ta.setSelectionRange === "function") {
              try { ta.setSelectionRange(next.length, next.length); } catch (_e) { /* 桩环境无选区语义 */ }
            }
          }
          onPatch({ prompt: next });
          // 派发 input（与 ui/vocab.js appendVocabWord 同款·段卡防抖预览链不断）
          if (ta && typeof ta.dispatchEvent === "function" && typeof Event === "function") {
            try { ta.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) { /* 桩环境忽略 */ }
          }
        },
      });
    });
  });
  meta.appendChild(insAsset);
  // 2 mini 按钮（v43 :1420-1422 · 批 0-T3 换装：console.info 占位监听摘除（改创建处）→
  //   registerPending 统一空挂，title 带批次归属；「排戏」角标本步不动）
  // B5-T6 G6：单段重跑占位（原「批 4」）解除 —— 接 edit.js openSegRerunBySegId 跨域入口
  //   （与卡墙双击同入口；未载入历史/该段无 sid 由入口内白话守卫降级）
  const rerunMini = el("span", { class: "mini", title: t("seg.rerunTitle"), text: "↻" });
  rerunMini.style.cursor = "pointer";
  rerunMini.addEventListener("click", () => { openSegRerunEntry(opts.projectId, seg.id); });
  meta.appendChild(rerunMini);
  // #79：拍摄控制紧凑条 mini 入口（排戏按钮旁·收起态=镜头摘要+参考缩略小标）
  if (camBar && camBar.entry) meta.appendChild(camBar.entry);
  return meta;
}

// ============================================================================
// 批 1-T4 T5：分镜卡内引擎实时预览（api.md #10 /h3_batch/preview_prompt）
//   链路：段词输入 → 400ms 防抖 → 引擎拼装 → 卡内预览行回填 + checks（errs 红 / warns 黄）
//   取数：row / global / pool / pool_usage 由 core/submit.buildFormDataFromProject 装配（与提交链
//     逐字同源，其中 pool/pool_usage 即 core buildPool 的装配结果）——「只消费不修改 core」。
//   在途取消：core/submit.previewPrompt（:637）不转发 signal，而本件禁改 core → HTTP 走
//     core/api.request（既支持外部 signal·api.js:78-82 契约）直连同一端点，请求体与响应解析
//     与 previewPrompt 逐键对齐；以此换取真 AbortController 取消（验收 #8「在途取消生效」）。
//     ⚠ 规格适配待主代理追认（.tmp/batch1/t4-report.md §三.1）：若裁定必须消费 previewPrompt，
//     替换 fetchInlinePreview 函数体即可，代价是退回「竞态丢弃」而无真取消。
// ============================================================================

export const PREVIEW_DEBOUNCE_MS = 400;

// 测试钩子（与 core/api.js _test_setTimeoutMs 同款注入位）：DOM 用例无须真等 400ms
let _previewDebounceMs = PREVIEW_DEBOUNCE_MS;
export function _test_setPreviewDebounceMs(ms) {
  _previewDebounceMs = (Number.isFinite(ms) && ms >= 0) ? ms : PREVIEW_DEBOUNCE_MS;
}

/**
 * 引擎预览请求体（纯函数·api.md #10 键集）。
 * @param {object} formData - buildFormDataFromProject 结果
 * @param {number} segIndex - 段序号
 * @returns {{row:object, global:string, pool:object, pool_usage:object, mode:string,
 *   seg_pools?:object, bindings?:Array, workflow?:string}}
 */
export function buildInlinePreviewBody(formData, segIndex) {
  const fd = (formData && typeof formData === "object") ? formData : {};
  const globals = (fd.globals && typeof fd.globals === "object") ? fd.globals : {};
  const shots = Array.isArray(fd.shots) ? fd.shots : [];
  const idx = (Number.isInteger(segIndex) && segIndex >= 0) ? segIndex : 0;
  const body = {
    row: shots[idx] || {},
    global: typeof globals["提示词"] === "string" ? globals["提示词"] : "",
    pool: fd.pool || {},
    pool_usage: fd.pool_usage || {},
    mode: fd.mode || "分镜",
  };
  // 档2 T4：段池带键——与主预览 previewPrompt（core/submit.js:1254）同源同口径：
  //   取 buildFormData 组装产物 formData.seg_pools（段级排戏槽/段池槽都在其中），
  //   非空才发（引擎无键兼容铁律：body 不带 seg_pools = 逐字节现行为）。
  if (fd.seg_pools && typeof fd.seg_pools === "object" && Object.keys(fd.seg_pools).length) {
    body.seg_pools = fd.seg_pools;
  }
  // 批 8 T2a：双透传——引擎 preview_prompt 的 bindings 消费整体锁在 `if "workflow" in body:`
  //   分支（__init__.py:4612/:4634，:4719 else 强制空数组），只发 bindings 不发 workflow 会被丢弃。
  //   body.bindings = formData.bindings（非空才发·submit.js 生产）；
  //   body.workflow = globals["模板"]（照抄 _buildGenerateBody :425-427 映射口径·非空才发）。
  //   空表两键都不发（无绑定行为=现状）
  if (Array.isArray(fd.bindings) && fd.bindings.length) body.bindings = fd.bindings;
  const workflowName = typeof globals["模板"] === "string" ? globals["模板"] : "";
  if (workflowName) body.workflow = workflowName;
  return body;
}

/**
 * POST /h3_batch/preview_prompt（api.md #10）。
 * @param {object} body - buildInlinePreviewBody 结果
 * @param {object} [opts] - { signal } 外部取消信号（在途取消）
 * @returns {Promise<{ok:boolean, text:string, warns:Array, errs:Array, error?:object}>}
 */
export async function fetchInlinePreview(body, opts = {}) {
  const r = await request("/h3_batch/preview_prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: opts.signal,
  });
  if (!r.ok) return { ok: false, error: r.error, text: "", warns: [], errs: [] };
  const checks = (r.data && r.data.checks) || {};
  return {
    ok: true,
    text: (r.data && r.data.text) || "",
    warns: Array.isArray(checks.warns) ? checks.warns : [],
    errs: Array.isArray(checks.errs) ? checks.errs : [],
  };
}

/**
 * 行内预览链（防抖 + 在途取消 + 过期丢弃）。
 * @param {object} opts - { fire(signal)→Promise, onResult(res), debounceMs, timers }
 * @returns {{schedule:Function, cancel:Function}}
 */
export function createInlinePreviewChain(opts = {}) {
  const fire = typeof opts.fire === "function" ? opts.fire : null;
  const onResult = typeof opts.onResult === "function" ? opts.onResult : () => {};
  const debounceMs = (Number.isFinite(opts.debounceMs) && opts.debounceMs >= 0)
    ? opts.debounceMs : PREVIEW_DEBOUNCE_MS;
  const timers = opts.timers || {
    // 包一层：setTimeout 作为普通对象方法调用会 Illegal invocation（浏览器 this 校验），故显式绑回全局
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  const makeAbort = typeof opts.makeAbort === "function" ? opts.makeAbort : () => new AbortController();
  let timerId = null;
  let controller = null;
  let gen = 0;

  function cancel() {
    gen += 1;   // 在途响应即过期
    if (timerId != null) { timers.clearTimeout(timerId); timerId = null; }
    if (controller) {
      try { controller.abort(); } catch (_e) { /* 已结束/不支持 → 忽略 */ }
      controller = null;
    }
  }

  function schedule() {
    cancel();
    if (!fire) return;
    const my = gen;
    timerId = timers.setTimeout(() => {
      timerId = null;
      controller = makeAbort();
      const signal = controller ? controller.signal : undefined;
      let p;
      try {
        p = fire(signal);
      } catch (e) {
        controller = null;
        onResult({ ok: false, error: e, text: "", warns: [], errs: [] });
        return;
      }
      Promise.resolve(p).then(
        (res) => {
          if (my !== gen) return;   // 已被新输入取代 → 丢弃
          controller = null;
          onResult(res);
        },
        (err) => {
          if (my !== gen) return;
          controller = null;
          onResult({ ok: false, error: err, text: "", warns: [], errs: [] });
        }
      );
    }, debounceMs);
  }

  return { schedule, cancel };
}

// 引擎预览行（T5）：就近挂提示词框下；checks 分色一行一条
// 批 J-P12 A（老板最终口径·验收=老板样例）：预览 = 引擎实收完整格式，两区标注——
//   ①「全局提示词 · 引擎收到的」= 六字段块（@名字 已被引擎展开为 Subject 定义 + Picture 引用）
//   ②「分镜提示词 · 引擎收到的」= 段词（@名字 已被引擎替换成 @Subject N 形态）
//   两区由 splitEnginePreview 从**同一份引擎返回文本**切分（不重拼·单一数据源）。
// 区标注原模块常量 EP_ZONE_CAPS 已入典 seg.epZone*（#89 T4a·取词就近）
function _epZone(kind) {
  const zone = el("div", { class: "ep-zone", "data-ep-zone": kind });
  zone.style.cssText = "margin-top:4px;display:flex;gap:6px;align-items:flex-start";
  zone.appendChild(el("span", { class: "ep-zone-cap", text: kind === "global" ? t("seg.epZoneGlobal") : t("seg.epZoneSeg") }));
  const body = el("span", { class: "ep-body" });
  body.style.cssText = "white-space:pre-wrap;word-break:break-all;flex:1;min-width:0";
  zone.appendChild(body);
  return { zone, body };
}

function renderEnginePreviewRow(segIndex, opts) {
  const row = el("div", { class: "sc-engprev", "data-seg-preview": "1" });
  row.style.cssText = "margin-top:4px;font-size:12px;line-height:1.5;color:var(--txt2)";
  row.appendChild(el("span", { class: "ep-cap", text: t("seg.engPreview") }));
  const gz = _epZone("global");
  const sz = _epZone("seg");
  gz.body.textContent = t("seg.epGlobalWaiting");
  sz.body.textContent = t("seg.epSegWaiting");
  row.appendChild(gz.zone);
  row.appendChild(sz.zone);
  const checks = el("div", { class: "ep-checks" });
  row.appendChild(checks);

  const checkLine = (cls, color, text) => {
    const d = el("div", { class: "ep-check " + cls, text });
    d.style.cssText = `color:var(${color})`;
    return d;
  };
  const fill = (res) => {
    while (checks.firstChild) checks.removeChild(checks.firstChild);
    if (!res || res.ok === false) {
      const msg = (res && res.error && (res.error.msg || res.error.code)) || t("seg.engineNoAnswer");
      gz.body.textContent = t("seg.epFail", { msg });
      gz.body.style.color = "var(--bad)";
      sz.body.textContent = t("seg.epFailZone");
      return;
    }
    const text = res.text || "";
    const split = splitEnginePreview(text);
    gz.body.style.color = "var(--txt2)";
    // 平铺格式（引擎未走六字段）不猜拆分：整篇归全局区，分镜区明示降级
    gz.body.textContent = split.sixField ? split.globalZone : (text || t("seg.epEmpty"));
    gz.body.title = gz.body.textContent;
    sz.body.style.color = "var(--txt2)";
    sz.body.textContent = split.sixField
      ? (split.segZone || t("seg.epNoSegLine"))
      : t("seg.epFlat");
    sz.body.title = sz.body.textContent;
    for (const e of res.errs || []) checks.appendChild(checkLine("ep-err", "--bad", t("seg.chkErr", { msg: e })));
    for (const w of res.warns || []) checks.appendChild(checkLine("ep-warn", "--warn", t("seg.chkWarn", { msg: w })));
  };

  const chain = createInlinePreviewChain({
    debounceMs: _previewDebounceMs,
    onResult: fill,
    fire: (signal) => {
      const ctx = getAssetContext();
      const formData = buildFormDataFromProject(opts.project, { registry: ctx.registry, assets: ctx.assets });
      return fetchInlinePreview(buildInlinePreviewBody(formData, segIndex), { signal });
    },
  });
  return { node: row, schedule: () => chain.schedule(), cancel: () => chain.cancel() };
}

// 渲染一张段卡（v43 :1384 一卡）
function renderCard(seg, segIndex, total, projMode, opts) {
  const card = el("div", { class: "segcard" });
  card.setAttribute("data-seg", String(segIndex + 1));
  card.setAttribute("data-seg-id", seg.id);
  // 批1-T5 · T4②：跨 TAB 跳转锚（剪辑 TAB 时间线段块双击 → 本行·跳达消费在 consumeJumpAnchor）
  card.setAttribute("data-sid", seg.id);
  // R6 选中态：点段卡即选中（v43 :1384 onclick=selCard(this) · pv-box 预览跟随切换）
  //   冒泡路径：head 折叠 / textarea 编辑 / 高级区点击均会走到这里 → 与「编辑实时刷新」同语义
  card.addEventListener("click", () => { setSelectedSegId(seg.id); });
  // 单段补丁函数（patch → updateSegment + 同步 seed 双向）
  const onPatch = (patch) => {
    if (!opts.project) return;
    updateSegment(opts.project, seg.id, patch);
    storeSave(opts.project);
    // 种子双向：高级 cbox / sc-meta 任一处改 → 同步另一处显示
    if (patch && Object.prototype.hasOwnProperty.call(patch, "seed")) {
      const newSeed = patch.seed;
      const advSeed = card.querySelector('[data-seedbox="1"] .cb-in');
      const metaSeed = card.querySelector('[data-seg-meta="seed"]');
      if (advSeed && advSeed.value !== newSeed) advSeed.value = newSeed;
      if (metaSeed && metaSeed.value !== newSeed) metaSeed.value = newSeed;
    }
    // 提示词双向：首帧概念图下拉挂 @N / 摘 @N → sc-prompt textarea 同步显示
    if (patch && Object.prototype.hasOwnProperty.call(patch, "prompt")) {
      const ta = card.querySelector(".sc-prompt");
      if (ta && ta.value !== patch.prompt) ta.value = patch.prompt;
    }
  };
  // 头（折叠/删除/拖拽）
  const head = renderHead(
    seg,
    segIndex,
    total,
    projMode,
    () => {
      card.classList.toggle("fold");
      const f = card.querySelector(".sc-fold");
      if (f) f.textContent = card.classList.contains("fold") ? "▸" : "▾";
      // #79：镜头区已收进紧凑条展开容器（.sc-cam）→ 整卡折叠时容器一并收起
      const cam = card.querySelector(".sc-cam");
      if (cam) cam.style.display = card.classList.contains("fold") ? "none" : "";
    },
    (s) => {
      // S1-2 T4 附带修正 1：confirm() → 两次确认武装态（与 projects.js triggerDeleteTwoStep 同形）
      // 防重入：模块级 _armedDelSeg === delBtn 时直接 return
      const delBtn = card.querySelector(".sc-del");
      if (!delBtn) return;
      triggerDelTwoStep(delBtn, s, segIndex, opts);
    },
    () => { opts.draggingId = seg.id; }
  );
  card.appendChild(head);
  // #79：镜头九项编辑收进紧凑条展开容器（T-C 常驻镜头区回炉·T-C 布局断言已同步改写）
  const camBar = buildCamBar(seg, onPatch, opts);
  card.appendChild(renderAdvToggle());
  card.appendChild(renderAdv(seg, onPatch, () => { opts.rerender && opts.rerender(); }));
  // T5：段词输入 → 400ms 防抖 → 引擎实时预览行（就近挂提示词框下）
  const ep = renderEnginePreviewRow(segIndex, opts);
  card.appendChild(renderPrompt(seg, onPatch, () => ep.schedule()));
  card.appendChild(ep.node);
  // S3-4 B8（空-011）：@N 深联引用链行（深联/断链/环才有·其余段不占版面）
  const chainRow = renderRefChainRow(seg, getAssetContext());
  if (chainRow) card.appendChild(chainRow);
  card.appendChild(renderMeta(seg, segIndex, total, projMode, onPatch, opts, card, camBar));
  // #79：紧凑条展开容器（.sc-cam）挂在 meta 行后（仿 sc-adv-t 先例·折叠容器紧随入口）
  card.appendChild(camBar.box);
  // 资产 pill 拖放 → 段词追加 "@名字 "（批5-R55 去序列号·mentionInsert 同口径）
  //   数据源：@N 注册表（getAssetContext）；判重/追加走 @名字 token 独立通道
  //   （appendAssetNameRefToPrompt），已引用同一卡 → 不重复追加，仅提示。
  //   dragstart 载荷仍写 @N（数据面保活）；appendFirstFrameRefToPrompt 仅服务 FL 首帧。
  const assignAssetRef = (rawN) => {
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1) return;
    const name = getAssetContext().registry[n] || "";
    if (!name) return;
    const withRef = appendAssetNameRefToPrompt(seg.prompt, name);
    if (withRef === seg.prompt) {
      if (typeof showToast === "function") showToast("info", t("seg.refSharedDup", { n: segIndex + 1, name }));
      return;
    }
    onPatch({ prompt: withRef });
    setSelectedSegId(seg.id);
    if (typeof showToast === "function") showToast("info", t("seg.refSharedDone", { name, n: segIndex + 1 }));
  };
  // 拖拽接收（drop target）：① 资产 pill（R6 #014 拖进分镜 = 自动 @N 引用）② 段卡排序（既有）
  card.addEventListener("dragover", (ev) => {
    const dt = ev.dataTransfer;
    const hasAsset = !!(dt && dt.types && Array.from(dt.types).indexOf(ASSET_DND_TYPE) >= 0);
    if (!opts.draggingId && !hasAsset) return;
    ev.preventDefault();
    if (dt) dt.dropEffect = hasAsset ? "copy" : "move";
  });
  card.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const dt = ev.dataTransfer;
    const assetN = dt && typeof dt.getData === "function" ? dt.getData(ASSET_DND_TYPE) : "";
    if (assetN) { assignAssetRef(assetN); return; }
    if (!opts.draggingId || !opts.project) return;
    const draggedId = opts.draggingId;
    opts.draggingId = null;
    if (draggedId === seg.id) return;
    const segs = opts.project.segments;
    const fromIdx = segs.findIndex((s) => s.id === draggedId);
    if (fromIdx < 0) return;
    const toIdx = segIndex;
    moveSegment(opts.project, opts.projectId, fromIdx, toIdx);
    storeSave(opts.project);
    opts.rerender && opts.rerender();
  });
  return card;
}

// ============================================================================
// B5-T6 G6：分镜卡片墙（表 / 卡墙切换 · 只读浏览态 · 单段重跑入口）
//   - 切换持久化 localStorage gui13.segview（"table" 默认 / "wall"）
//   - 卡墙 = 网格大卡（缩略图 + 段号 + 状态角标 + prompt 摘要两行 · 无编辑控件）
//   - 缩略图 = mainClips 按 segId → clip.file → /h3_batch/thumb?path=…&max_size=512（R-22 提档）
//     （preview.js:236-253 先例口径）；兜底① clip 无 file → film 兜底占位；
//     兜底② mainClips 空且 runs[0].stem → loadDetail → shots files（懒加载·卡墙激活才拉）
//   - 卡墙卡 dblclick / 段卡 ↻ 钮 → edit.js openSegRerunBySegId(projectId, segId)：
//     动态 import（edit.js ↔ assets.js ↔ segcards.js 存在引用环，且 edit.js 需 DOM 就绪后装载
//     ——静态引会破本文件的「无 DOM 先行装载」单测惯例；本域既有「动态 import 防环」同款）
// ============================================================================

export const SEGVIEW_KEY = "gui13.segview";

export function readSegView(storage) {
  const st = storage !== undefined ? storage : _safeStorage();
  try {
    return (st && typeof st.getItem === "function" && st.getItem(SEGVIEW_KEY) === "wall") ? "wall" : "table";
  } catch (_e) { return "table"; }
}

export function writeSegView(mode, storage) {
  const v = mode === "wall" ? "wall" : "table";
  const st = storage !== undefined ? storage : _safeStorage();
  try { if (st && typeof st.setItem === "function") st.setItem(SEGVIEW_KEY, v); } catch (_e) { /* 隐私模式：视图态不落盘 */ }
  return v;
}

// 卡墙状态角标（复用段卡状态徽章四档；数据源=clip.status 原值 + clip.state 三态）
export function wallStatusKey(clip) {
  if (!clip) return "wait";
  const s = clip.status;
  if (s === "success") return "ok";
  if (s === "failed" || s === "stopped") return "bad";
  if (s === "rendering" || s === "running") return "run";
  if (clip.state === "done") return "ok";
  if (clip.state === "warn") return "bad";
  return "wait";
}

// 缩略图 URL（R-22 提档：卡墙 wallthumb 高 112×卡宽 200×DPR2 → 512；preview.js 先例口径）
//   批 B #13：收敛 mediaUrl 单源（引擎口优先·joinBase 基址归一·同源部署输出与旧裸相对逐字节同形）；
//   离线回落由 renderWallCard 的 wireBgMediaFallback 接线（引擎口失败才切本地缩略）。
export function thumbUrlOf(file) {
  return mediaUrl("thumb", file, { maxSize: 512 });
}

// 单段重跑入口（跨域 → edit.js openSegRerunBySegId）；单测经 _test_setSegRerunEntry 注入替身
let _segRerunEntry = null;
export function _test_setSegRerunEntry(fn) { _segRerunEntry = typeof fn === "function" ? fn : null; }

async function openSegRerunEntry(projectId, segId) {
  if (_segRerunEntry) return _segRerunEntry(projectId, segId);
  try {
    const mod = await import("./edit.js");
    if (mod && typeof mod.openSegRerunBySegId === "function") return mod.openSegRerunBySegId(projectId, segId);
  } catch (_e) { /* 编辑域不可用不影响段卡浏览 */ }
  return undefined;
}

// ===== mount(container, projectId) =====

// 排戏台挂槽档2 T3：存量迁移启用（进工作区即跑·幂等）
//   批级 poolManual.Video 里的排戏来源卡 → 段级 seg.stagingVideoRefs（引擎段池真通道）
//   迁不动的（段越界/段级满/段号不可解析）留原地 + console.warn 计数（可见可 × 清理·不丢数据）
//   迁移异常 → 捕获不写盘（保留原状）
export function enableStagingVideoRefsMigration(project) {
  const out = { migrated: 0, residual: 0, saved: false };
  if (!project || typeof project !== "object") return out;
  let r;
  try {
    r = migrateStagingVideoRefs(project);
  } catch (e) {
    console.warn("[排戏槽迁移] 迁移异常·本次不写盘（原状保留）", e);
    return out;
  }
  out.migrated = r.migrated;
  out.residual = r.residual;
  if (out.residual > 0) {
    console.warn(`[排戏槽迁移] 残留 ${out.residual} 项未迁（段越界/段级满）·留批级池·可见可 × 清理`);
  }
  if (out.migrated > 0 || out.residual > 0) {
    storeSave(project);
    out.saved = true;
  }
  return out;
}

export function mount(container, projectId) {
  if (typeof document === "undefined" || !container) return null;
  if (!projectId) return null;
  // 一次性挂 document 级点击委托（cbox 打开/关闭/选项回填）
  if (typeof document !== "undefined") initDocumentDelegate(document);

  let proj = storeLoad(projectId);
  if (!proj) {
    const ph = el("div", { class: "shell-tab-placeholder" });
    ph.appendChild(el("div", { class: "ph-cap", text: t("seg.noProject") }));
    container.appendChild(ph);
    return null;
  }
  // 排戏台挂槽档2 T3：存量排戏卡迁段级（幂等·有变化才落盘）
  enableStagingVideoRefsMigration(proj);
  // #77 A2：存量镜头词表迁引擎全形（落盘·幂等·有变化才落盘）
  migrateLegacyCameraFields(proj);
  let projMode = proj.projMode || "分镜";

  // S3-2 T8：有 FL 辅助段 → 拉一次资产上下文（@N 注册表 + 引擎卡），装载完成后自动重渲染段卡
  //   （首次进入 TAB 资产可能还没进缓存；无 FL 段则不拉，避免无谓请求）
  // S3-4 B8：含 @N 引用的段同样需要（@N 深联引用链行取数源）
  const needAssetCtx = proj.segments.some((s) => s && (
    isFlAidedSegMode(migrateSegMode(s["分段模式"])) || /@\d+/.test(String(s.prompt || ""))
  ));
  if (needAssetCtx) {
    ensureAssetContext();
  }

  // 列外壳
  const sec = el("section", { class: "segcards-view" });
  sec.setAttribute("data-segcards-project", projectId);

  const colfold = el("div", { class: "colfold open", id: "segcol" });
  colfold.style.marginTop = "6px";

  const cap = el("div", { class: "cf-cap" });
  cap.appendChild(document.createTextNode(t("seg.cap")));
  cap.appendChild(el("span", { class: "inh", text: t("seg.capSub") }));
  // B5-T6 G6：「表 / 卡墙」视图切换（chips 形态 · 持久化 gui13.segview · 默认 table）
  const chipByMode = {};
  const viewChips = el("span", { class: "fchips" });
  for (const [mode, label, title] of [
    ["table", t("seg.viewTable"), t("seg.viewTableTitle")],
    ["wall", t("seg.viewWall"), t("seg.viewWallTitle")],
  ]) {
    const chip = el("span", { class: "fchip", text: label, title });
    chip.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation(); // 防冒泡触发 cap 折叠
      setView(mode);
    });
    chipByMode[mode] = chip;
    viewChips.appendChild(chip);
  }
  cap.appendChild(viewChips);
  // 批 R8 · ③b #001：savestamp（v43 :1381 · icw 之前）
  const stamp = el("span", { class: "savestamp", id: "saveStamp", text: formatSaveStamp(new Date(Date.now())) });
  cap.appendChild(stamp);
  _stampLastWrite = Date.now();
  ensureSaveStampSub();
  const icw = el("span", { class: "icw" });
  icw.style.marginLeft = "auto";
  icw.appendChild(el("span", { "data-ic": "chev", "data-sz": "14" }));
  cap.appendChild(icw);
  cap.addEventListener("click", () => colfold.classList.toggle("open"));
  colfold.appendChild(cap);

  const cfBody = el("div", { class: "cf-body" });
  cfBody.style.paddingBottom = "0";
  const segList = el("div", { class: "segList", id: "segList" });
  cfBody.appendChild(segList);
  // B5-T6 G6：卡墙格（只读浏览态；表态清空不外泄）
  const segWall = el("div", { class: "segwall", id: "segcardsWall" });
  cfBody.appendChild(segWall);
  colfold.appendChild(cfBody);

  const opts = { projectId, project: proj, draggingId: null, rerender: null };

  // ===== B5-T6 G6：表/卡墙视图态（挂载期持有；持久化在 localStorage) =====
  let view = readSegView();
  let wallDetail = null;          // 兜底②：mainClips 空时 loadDetail 的 segId→产物路径
  let wallDetailLoading = false;

  // 卡墙卡（只读浏览：缩略图+段号+状态角标+prompt 摘要·无编辑控件）
  function renderWallCard(seg, i) {
    const clips = (proj.editingState && Array.isArray(proj.editingState.mainClips)) ? proj.editingState.mainClips : [];
    const clip = clips.find((c) => c && c.segId === seg.id) || null;
    const file = (clip && clip.file) ? String(clip.file) : ((wallDetail && wallDetail[seg.id]) || "");
    const card = el("div", { class: "wallcard" });
    card.setAttribute("data-seg-id", seg.id);
    const thumb = el("div", { class: "wallthumb" });
    if (file) {
      thumb.style.backgroundImage = `url("${thumbUrlOf(file)}")`;
      thumb.style.backgroundSize = "cover";
      thumb.style.backgroundPosition = "center";
      wireBgMediaFallback(thumb, "thumb", file, { maxSize: 512 });   // 批 B #13：引擎口失败 → 本地缩略兜底
    } else {
      thumb.classList.add("empty"); // film 兜底占位色（fsthumb.empty 同款）
    }
    const badge = deriveStatusBadge(wallStatusKey(clip));
    thumb.appendChild(el("span", { class: "wallbadge " + badge.cls, text: badge.text }));
    card.appendChild(thumb);
    card.appendChild(el("div", { class: "wallhead" }, [el("b", { class: "no", text: t("seg.segNo", { n: i + 1 }) })]));
    card.appendChild(el("div", { class: "wallsnip", text: String(seg.prompt || "") }));
    card.addEventListener("dblclick", () => {
      if (view !== "wall") return; // 表格态不触发（表格态既有行为零改动）
      openSegRerunEntry(projectId, seg.id);
    });
    return card;
  }

  function renderWall() {
    while (segWall.firstChild) segWall.removeChild(segWall.firstChild);
    const segs = proj.segments || [];
    for (let i = 0; i < segs.length; i++) segWall.appendChild(renderWallCard(segs[i], i));
  }

  // 兜底②：mainClips 空且 runs[0].stem → loadDetail → shots files（懒加载·卡墙激活才拉·每实例一次）
  async function ensureWallDetail() {
    if (wallDetail !== null || wallDetailLoading) return;
    const p2 = storeLoad(projectId) || {};
    const clips = (p2.editingState && Array.isArray(p2.editingState.mainClips)) ? p2.editingState.mainClips : [];
    if (clips.length) return;
    const runs = Array.isArray(p2.runs) ? p2.runs : [];
    const stem = (runs[0] && runs[0].stem) ? String(runs[0].stem) : "";
    if (!stem) return;
    wallDetailLoading = true;
    try {
      const r = await loadDetail({ taskId: stem });
      const shots = (r && r.ok && r.raw && r.raw.shots && typeof r.raw.shots === "object") ? r.raw.shots : {};
      // 段序映射同 applyHistory 口径（sorted sids 第 i 个 → 第 i 段）；file=run_dir+files[0]
      const map = {};
      Object.keys(shots).sort().forEach((sid, i) => {
        const s = shots[sid] || {};
        const seg = (proj.segments || [])[i];
        const f = (Array.isArray(s.files) && s.files.length)
          ? (String(s.run_dir || "").replace(/[\\/]+$/, "") + "\\" + s.files[0])
          : "";
        if (seg && f) map[seg.id] = f;
      });
      wallDetail = map;
    } catch (_e) {
      wallDetail = {};
    }
    wallDetailLoading = false;
    if (view === "wall") renderWall();
  }

  function applyView() {
    segList.style.display = view === "table" ? "" : "none";
    segWall.style.display = view === "wall" ? "" : "none";
    chipByMode.table.classList.toggle("on", view === "table");
    chipByMode.wall.classList.toggle("on", view === "wall");
    while (segWall.firstChild) segWall.removeChild(segWall.firstChild);
    if (view === "wall") { renderWall(); void ensureWallDetail(); }
  }
  function setView(mode) { view = writeSegView(mode); applyView(); }

  function rerender() {
    // B7-T2 落卡刷新：rerender 前重读 store。editingState 走 updateEditingState（load→patch→save
    //   写全新对象），mount 捕获引用不感知（精修终态落卡后卡墙缩略图停在旧产物·真机实证）；
    //   段卡就地编辑（updateSegment+storeSave）与顶栏（applyTopbarChange fresh+save）写后 store
    //   恒最新，重读无损。opts.project 同步换新引用——onPatch 写路径跟新对象走（防旧引用回写覆盖）。
    const fresh = storeLoad(projectId);
    if (fresh) {
      proj = fresh;
      opts.project = fresh;
      projMode = proj.projMode || "分镜";
    }
    // 清空 segList 重渲染（拖拽/删除后）
    const segs = proj.segments;
    const total = segs.length;
    // R6 选中态回落：选中段已不存在（首挂 / 选中段被删 / 切项目）→ 回落首段并广播（v43 :6617 初始选段1）
    if (!_selectedSegId || !segs.some((s) => s && s.id === _selectedSegId)) {
      setSelectedSegId(segs[0] ? segs[0].id : null);
    }
    while (segList.firstChild) segList.removeChild(segList.firstChild);
    for (let i = 0; i < total; i++) {
      const card = renderCard(segs[i], i, total, projMode, opts);
      if (segs[i].id === _selectedSegId) card.classList.add("selcard");
      segList.appendChild(card);
    }
    segList.appendChild(addShot(opts));
    hydrateIcons(segList); // 批 R7：段卡动态重渲染区 data-ic（adv-ico/arr/addshot）→ svg
    if (view === "wall") renderWall(); // 卡墙态同行刷新（增段/删段/拖序后）
    // 批1-T5 · T4②：跳转闪烁窗口内重渲染 → 续闪（异步资产上下文重渲换卡节点·真机实证必走）
    if (_jumpFlashSid) _applyJumpFlash(segList, setTimeout, JUMP_FLASH_MS);
  }
  opts.rerender = rerender;
  // S1-2 T5：注册到模块级实例表（顶栏 projMode 变更 → 段徽标重派生 / 拼接 chk 联动调度）
  _mountedInstances.set(projectId, { rerender, proj, segList, stamp });

  rerender();
  applyView(); // B5-T6 G6：按持久化视图态亮表/卡墙（含卡墙首渲）

  sec.appendChild(colfold);
  container.appendChild(sec);
  hydrateIcons(sec); // 批 R7：cf-cap 的 icw chev 等静态 data-ic → svg（R0 范式 · 幂等）
  // 批1-T5 · T4②：跨 TAB 跳转落点——段卡挂载即消费 gui13.gotoSeg 锚（edit 段块双击写入）
  consumeJumpAnchor(sec);
  return sec;
}

// ============================================================================
// 批1-T5 · T4②：段块双击跳转落点（剪辑 TAB 时间线段块 → 本表行）
//   通道：sessionStorage 锚 gui13.gotoSeg（edit.js jumpToShotRow 写·与画布双击段节点同通道）
//   1.0 口径：timeline.js:961 _jumpToShotRow = scrollIntoView + 闪烁 class（1.0 500ms；本件 1.5s）
//   锚一次性消费（先摘后跳·setup.js 同口径）；延迟 0 = 等容器挂进文档（setup.mount 同步 append 后）
//   闪烁窗口态（_jumpFlashSid/Until）挂模块级：ensureAssetContext 异步重渲染会换掉卡节点 →
//   rerender() 重建后按窗口续闪（真机实证：重渲在闪烁加类后 ~5ms 发生，不续闪则肉眼不可见）。
// ============================================================================
export const JUMP_FLASH_MS = 1500;

let _jumpFlashSid = null;      // 待闪烁行（段 id）
let _jumpFlashUntil = 0;       // 闪烁窗口截止（ms 时间戳）

function _jumpStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.sessionStorage) || null; }
  catch (_e) { return null; }
}

function _cssEsc(s) {
  try {
    return (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") ? CSS.escape(String(s)) : String(s);
  } catch (_e) { return String(s); }
}

// 落点闪烁应用（幂等·可被 rerender 重入）：命中行 scrollIntoView + 加 goto-flash；
//   窗口到点后摘 class（重查当前节点——重渲染换节点不残留）并清窗口态。
function _applyJumpFlash(container, setT, flashMs) {
  if (!_jumpFlashSid || !container || typeof container.querySelector !== "function") return false;
  let row = null;
  try { row = container.querySelector('[data-sid="' + _cssEsc(_jumpFlashSid) + '"]'); } catch (_e) { row = null; }
  if (!row) return false;
  // F60 折叠展开守卫：命中行若处于收起的 colfold 内（cf-body display:none · scrollIntoView 落空），
  //   先按既有展开口径展开——colfold 无独立展开函数，cap click 的效果即 colfold.classList 切 "open"
  //   （segcards.js mount 内 cap 监听·CSS .colfold.open .cf-body 才显示），此处 add("open") 等价且幂等。
  try {
    for (let p = row.parentNode; p; p = p.parentNode) {
      if (p.classList && p.classList.contains("colfold") && !p.classList.contains("open")) p.classList.add("open");
    }
  } catch (_e) { /* 展开失败不影响闪烁 */ }
  if (typeof row.scrollIntoView === "function") row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("goto-flash");
  const sid = _jumpFlashSid;
  setT(() => {
    if (Date.now() < _jumpFlashUntil) return;   // 窗口内（后续续闪的那次接管摘除）
    try {
      const cur = container.querySelector('[data-sid="' + _cssEsc(sid) + '"]');
      if (cur) cur.classList.remove("goto-flash");
    } catch (_e) { /* 摘除失败无用户可见影响 */ }
    _jumpFlashSid = null;
  }, flashMs);
  return true;
}

export function consumeJumpAnchor(root, opts = {}) {
  if (!root || typeof root.querySelector !== "function") return false;
  const storage = opts.storage !== undefined ? opts.storage : _jumpStorage();
  if (!storage) return false;
  let sid = null;
  try { sid = storage.getItem("gui13.gotoSeg"); } catch (_e) { return false; }
  if (!sid) return false;
  try { storage.removeItem("gui13.gotoSeg"); } catch (_e) { /* 消费失败不影响闪烁 */ }
  const flashMs = typeof opts.flashMs === "number" ? opts.flashMs : JUMP_FLASH_MS;
  const setT = opts.setTimeout || setTimeout;
  _jumpFlashSid = String(sid);
  _jumpFlashUntil = Date.now() + flashMs;
  setT(() => { _applyJumpFlash(root, setT, flashMs); }, 0);
  return true;
}

// 「加一段」按钮（v43 :1548）
function addShot(opts) {
  const btn = el("div", { class: "addshot" });
  // 批 R7 · #003：plus 14 + 文案「加一段」（原型逐字 · 去「+ 」字符前缀）
  btn.appendChild(el("span", { "data-ic": "plus", "data-sz": "14" }));
  btn.appendChild(document.createTextNode(t("seg.addSeg")));
  btn.style.cursor = "pointer";
  btn.addEventListener("click", () => {
    addSegment(opts.project);
    storeSave(opts.project);
    opts.rerender && opts.rerender();
  });
  return btn;
}