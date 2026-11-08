// ai-archive.js — AI 协作视图 + 对话归档数据层（GUI1.3 批 R5 · S3-4d 视图壳口径）
//
// === 出处注记（v43 原型 md5=43c85f743cfb8445f63fb8292c3355aa · 只读参照, 本体永不修改） ===
//   - #view-ai 整页 :1693-1728（proj-top / .ai-l 会话+折叠归档+互导 / .ai-r 消息流+输入区）
//   - 归档 JS :6523-6584（aiPick / aiArchToggle / aiArchive / aiArchRestore / aiArchDel）
//   - CSS .ai-* 族 :561-569 / :995-996 / :1022-1031 / :322-326 → 本批并入 settings.css
//
// === B6-T2 A1 真对话（叠改本文件） ===
// 取码 legacy/app/js/views/ai_collab_llm.js —— 模型下拉恢复 :779-827/:884-895、
// `<think>` 折叠 :442-472、checks 三色条 :832-859、刷新回灌 :1121-1134、404 重建 :907-934。
// 适配点: ① 键族 gui13.llm.model / gui13.llm.session（1.3 口径）; ② 发送走 core/llm_chat.sendChat
// （timeoutMs 90000）; ③ 消息流空态「开始对话」+「应用到分镜表」迁互导区常驻（v2-4 fixture 退役）;
// ④ 回灌期间禁用输入区（v2-9）。
//
// === B6-T3 A4 会话列表（叠改本文件） ===
// ① 左栏三条 fixture 退役 → listSessions 真数据（normalizeSessionRow 取码 legacy
//    domain/llm_read.js:69-84: id 截 12 + updated_at 秒→本地时间 + messages_count）
//    + 空态/失败态 + 当前会话行 .on 高亮; 加载时机 = 视图装配 + 发送成功后刷新;
// ② 点击行 → getSessionDetail → 只读回看弹层（ui/modal; 消息流复用 T2 气泡口径 +
//    metadata.model + 「v1 只看不续聊」注记）;
// ③ 「＋新会话」迁左栏顶（#24 需求2 起为唯一入口 · 同语义 reset+清键+清流+左栏刷新）;
// ④ v2-6 归档钮语义重定: 选中引擎会话 → 本地归档区新条目 {标题=id 截 12+时间}
//    （不再 querySelectorAll 找 .preset; 归档区渲染不动）。
//
// === B6-T4 A2 一句话拆镜（叠改本文件） ===
// 取码 legacy/app/js/views/ai_collab_llm.js:957-1098 _doShotgen/_doAdopt（建议表 UI
// :482-547 取码）。适配点: ① 拆镜钮与发送 disabled 互斥（v2-10）; ② 采纳不走 legacy
// DOM 赋值（addShotRowAt+querySelector 逐字段 dispatch）→ store.addSegment+updateSegment
// 直写（v2-8 键形: 仅「段落时长」→durationSec 一处转换, 「运镜方式」为 store 真实键名）,
// 当前项目 = opts.projectId（#/ai?p= 路由参数·裁决扩界 2026-09-29）优先, projectIdFromHash
// （ui/queue.js 既有）兜底; ③ 建议表挂 msgs 与输入区之间
// （legacy 在输入区之后）; ④ 行 = 勾选框+描述+运镜+时长 四列（参考提示并入 prompt 不展示）。
//
// === B6-T5 A5 快照互导（叠改本文件） ===
// 取码 legacy/app/js/views/ai_collab.js（导出面板 :169-214/复制 :455-469/下载 :472-488/
// 导入 errors :324-340/_postExport/_postImport :62-74）。适配点:
// ① 三按钮接真（示意 toast 退役）: 「导出给 AI」=projectToSnapshot（fetchSubmitPoolContext
//   注入·core 层级规约禁止 core 反向 import views 故由本视图 import 后经 opts 注入）→#41→
import { readAgg, writeAgg, USER_JSON, reloadServerIndex } from "../core/server_storage.js";  // 批 10-M T5：AI 存档 + 模型选择迁 data/user.json（reloadServerIndex=#44 后半 B3 同读口）
import { onIndexChanged } from "../core/sync_bus.js";   // #44 后半 B3：跨窗口 index-changed 接收
//   guide+data 文本框（信封铁律 B-3: 只序列化内层 data）+复制+下载 .txt;
// ② 「从 AI 导入」=选文件（input[type=file] 隐藏·按钮触发; 取消=无操作）→读文本→#42 {text}
//   →ok:false errors 红字透传
//   （importSnapshot 走 fetchApi 直读——request 新信封分支会吞 errors 明细）→ok→确认框
//   （「将替换分镜表与同名全局参数」CSV 先例）→snapshotToStore 整体替换+storeSave;
// ③ 「应用到分镜表」=会话 snapshot（currentSessionId→getSessionDetail.session.snapshot,
//   无→白话 toast）→同一确认框→同一写入器。
//
// === 批10A-T3 老板走查四小项（叠改本文件） ===
// F43: 批10A-T3 默认隐藏 → 战役批1-T5 形态甲 整体退役 textarea 改文件选择（JSON 形态不暴露）;
// F44: 「归档」钮移至会话列表之后、折叠归档区之前;
// 两小项: 会话卡标题去裸哈希 →「会话 · <时间> · <N> 条消息」; 顶栏副标题截为完整短文案（去悬挂「·」/✦ 残符）。
//
// === 老板需求（2026-10-25）归档下沉 + 新会话占位（叠改本文件） ===
// ① 归档动作下沉到每个会话行：行内 ghostbtn-mini「归档」钮 → 把该会话存入本地归档
//   （条目 id=会话 id · title=展示名+时间）；点钮 stopPropagation → 不触发行点击（不弹回看弹层）。
//   底部整组「归档」钮退役（其 toast/代码一并清理；归档区渲染 + 恢复/删除逻辑不动）。
// ② 点「新会话」→ 左栏会话列表顶部立即出现高亮占位项「新会话（未发送）」（金色描边 +「新」标签，
//   与历史行视觉区分）；发送成功 → 占位项退役，真实会话行按真实会话 id 高亮。占位项仅前端临时态
//   （不伪造引擎会话 id 落库 · 刷新后自然消失）。
//
// === 老板需求 #24（2026-10-26）AI 协作页 UI 改造（叠改本文件） ===
// ① 需求1 左栏拖宽手柄：.ai-l 与 .ai-r 之间加垂直手柄（细线 + hover 变色 + col-resize），
//   拖拽改宽 180-520（clampLeftWidth），宽度记忆键 gui13.ai.leftW（刷新后恢复）；
//   实现口径参照 shell.js 侧栏拖拽（mountSidenavResize：拖拽 + localStorage 记忆）。
// ② 需求2 移除输入区上方的模型选择行整行：模型下拉迁入输入区、「新会话」钮退役
//   （左栏顶「＋新会话」为唯一入口）、「开始对话」空态提示一并移除（右栏留白）。
// ③ 需求3 输入框改 ZCode 同款：输入框容器（#aiInputBox：圆角+边框）内嵌底部工具条
//   （#aiInputBar：左=模型下拉 · 右=发送 + 智能拆镜），textarea 在容器内上部、
//   #aiDrag 上下拖高保留于容器内顶部（placeholder / Ctrl+Enter 发送行为不变）。
// ④ 追加 模型下拉改自绘向上弹出：原生 select 的下拉方向由浏览器决定（页面底部被视口裁切）
//   → 自绘浮层（仓内 cbox 家族：.cbox 触发器 + .cbox-menu 浮层 + .co 选项），
//   浮层挂 document.body（fixed）· 优先向上展开 + max-height 限高（选项多时内部滚动）；
//   点选写回 gui13.llm.model 与展示文本并关闭；点外部 / ESC 关闭；触发器 stopPropagation
//   隔开仓内 cbox document 委托（避免被其向下弹层重复打开）。
//
// === 老板需求 #25（2026-10-26）归档逻辑修复（叠改本文件） ===
// ① 行内归档钮两步确认：首点 → 红态「确认归档」（3s 内有效）· 再点执行 · 超时复原
//    （armed 视觉参照仓内 projects.js armTwoStepConfirm 口径：armed 类 + #ff9a9a/#1a1212）；
// ② 归档执行后不弹 toast（成功/重复都静默·按钮状态即反馈）；
// ③ renderSessions 过滤已在本地归档的会话 id（归档 → 主列表行消失·归档区仍可见）；
// ④ 归档区「恢复」= 真恢复（移出本地归档 → 主列表刷新 → 会话回列表·全程无 toast）；
//    归档区「删除」逻辑不变（仍 3s 两次确认 + 删除 toast）。
//
// === 老板需求 #23（2026-10-26）AI 回复格式采纳按钮（叠改本文件） ===
//   assistant 回复像分镜表（≥2 镜头段·行首序号形态或「画面：… 时长：…」结构）→ 气泡下挂
//   「采纳到分镜表」钮；点选 → 复用智能拆镜建议表 UI（suggWrap/suggBody/adoptBtn）→ 勾选采纳
//   走既有 addSegment+updateSegment 链（缺字段给默认：时长 3s · 运镜空 · 可不勾）。
//   解析全在前端（parseShotTableReply）· 不动引擎侧与 llm_shotgen。
//
// === 老板需求 #26（2026-10-26）输出规范（发送侧隐藏块）· 叠改本文件 ===
//   send() 发给引擎的 message 尾部附加隐藏「输出规范」块（要求用【提示词】…【/提示词】包裹提示词
//   正文·分镜表仍可用表格/列表）；界面用户气泡只显示用户原文；
//   渲染侧（消息气泡 + 会话回看弹层）统一 stripOutputSpec 剥除规范块（历史无规范消息原样）。
//
// === 老板需求 #22（2026-10-26）会话管理（第一批·叠改本文件） ===
// ① 本地元数据层：localStorage 键 gui13.ai.sessionMeta = { [sessionId]: { name?, projectId? } }
//    （edited 字段留给下批消息编辑）· 读写纯函数 + 宽容解析（坏数据回落空）
// ② 会话改名：行 hover 显「✎」→ 行内变输入框 → Enter 保存 / ESC 取消 → 写元数据 → 重渲染；空名 = 恢复默认
// ③ 关联项目（自然语言指令·零弹窗）：^关联(到)?项目[:：]?s*(.+)$ → 拦截不发引擎 · 按名精确匹配
//    （不中则模糊包含·唯一命中才算）→ 写元数据 projectId → toast；未命中列出现有项目；行显项目标签
// ④ 续写：点会话行 → getSessionDetail 载入全部消息到消息区 → 设为当前会话 → 行高亮（后续 send 进同一会话）
//    （原只读回看弹层退役：点行主行为 = 切回该会话继续聊）
// ⑤ 追加 新会话项目选择面板（ZCode 式·输入区上方轻量展开）：默认预选当前项目(?p=) · 项目列表（搜索）
//    · ＋新建项目（行内输入·store 同链）· 不关联项目；选完才建会话（引擎建会话后写元数据 projectId）
//
// === 老板需求 #47（2026-10-28）会话气泡删除消息（叠改本文件） ===
//   气泡 hover ✕ → 确认弹窗（文案逐字=方案 v5 §六·danger 红钮=确认件·两步防误触）→
//   DELETE /h3_batch/llm/sessions/messages?id=&index= → 成功按回传清单重建消息区 +
//   重键本地编辑覆盖层（rekeyEditedOverlay·被删消息编辑版随删弃置·其余不错位）；失败 toast+本地不动。
//
// === 老板真机复验 #47 改错（2026-10-29）悬停操作钮位置（叠改本文件） ===
//   老板原话：「删除修改的位置 不对 应该在 右下方」
//   ✎ 编辑 + ✕ 删除 两钮成组（.ai-msg-ops）·统一挂到每条气泡的右下方（气泡下方靠右）——
//   撤掉原「user 气泡右侧外挂 / AI 气泡左侧外挂」的分支定位；显隐/点击/编辑/删除两步确认/
//   失败 toast 行为一律不动（只动位置呈现）。
//
// === API ===
//   AI_ARCHIVE_KEY                          · 全局键（跨项目共享）
//   loadArchive(s) / saveArchive(s, list)
//   addToArchive(list, item)                · 入归档（自动补 id/createdAt）
//   removeFromArchive(list, id)             · 按 id 移除（不修改原数组）
//   restoreFromArchive(list, id)            · 按 id 取出（不删，调用方负责）
//   findById(list, id)                      · 索引定位
//   normalizeSessionRow(row)                · #51 会话行展示串（批10A-T3: 可读短名, 不含裸哈希）
//   clampLeftWidth(v) / readLeftWidth(s) / writeLeftWidth(v, s) · #24 左栏宽度钳制与记忆
//   parseShotTableReply(text)                  · #23 AI 回复 → 分镜段（纯函数·前端启发式）
//   buildOutputSpecBlock() / stripOutputSpec(text) · #26 输出规范块生成 / 剥除（纯函数）
//   loadSessionMeta(s) / saveSessionMeta(s, meta) / setSessionMeta(s, id, patch) · #22 会话本地元数据
//   rekeyEditedOverlay(edited, delIndex, newList) / replaceSessionEdits(s, id, edited) · #47 删除重键
//   extractPromptBlocks(text)                   · #26 提取【提示词】…【/提示词】正文（纯函数）
//   mount(container, opts)                  · 渲染 AI 协作页入 container（含归档折叠区）

import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import { open as openModal, openConfirm as openConfirmModal } from "../ui/modal.js";
import { fetchApi } from "../core/api.js";
import { projectIdFromHash } from "../ui/queue.js";
import { addSegment, updateSegment, save as storeSave, load as storeLoad, listProjects, createProject } from "../store/store.js";
import { listAssets } from "../core/assets_api.js";
import { listPresets } from "../core/llm_presets.js";
import { fetchVocab } from "../core/vocab.js";
import { CHAT_OUTPUT_SPEC_TEXT } from "../core/prompt_specs.js";
import {
  buildShotgenPrompt,
  parseShotgenReply,
  normalizeMotion,
  toShotRow,
} from "../core/llm_shotgen.js";
import { projectToSnapshot, snapshotToStore, exportSnapshot, importSnapshot } from "../core/ai_snapshot.js";
import { fetchSubmitPoolContext } from "./submit-bar.js";
import {
  sendChat,
  getSessionDetail,
  getCurrentSessionId,
  listSessions,
  restoreSessionId,
  persistSessionId,
  resetCurrentSession,
  validateMessage,
  deleteSessionMessage,
} from "../core/llm_chat.js";
import { t } from "../core/i18n.js";   // #92 B4：四页补译·ai.* 入典（常量区 mount 期取值 §4.9）

// ===== 原型逐字 fixture（v43 #view-ai 实测） =====
let INH_HEAD = "";   // 批10A-T3: 原型 :1695 全串渲染末端悬挂「·」+ ✦ 残符 → 完整短文案（#92 B4 典键 ai.inh.head·mount 期取词 §4.9）
let ARCH_ROW_BTN_TITLE = ""; // 行内归档钮 title（#92 B4 典键 ai.arch.rowBtnTitle）
let ARCH_BTN_TEXT = "";              // 行内归档钮常态文案（#92 B4 典键 ai.arch.rowBtn）
let ARCH_ARM_TEXT = "";          // #25 两步确认武装文案（#92 B4 典键 ai.arch.rowArm）
const ARCH_ARM_MS = 3000;                 // 武装窗（与归档区删除钮同口径）
// #47 删除消息确认弹窗文案（方案 v5 §六 逐字·快照口径）
let DEL_MSG_CONFIRM_TEXT = "";   // #47 删除消息确认弹窗文案（#92 B4 典键 ai.delMsg.confirm·mount 期取词）
// #47 改错（2026-10-29）：悬停操作钮组（✎+✕）定位 —— 挂在气泡右下方（气泡下方靠右·用户/AI 统一）
//   组高 ≈17px（钮 11px 字 × 1.3 行高 + 1px 描边）→ bottom:-18px = 整组悬在气泡下沿之外（不遮正文）
//   气泡 margin-bottom:16px 预留（配合 .ai-msgs gap:10px → 钮组落在气泡与下一条之间·不压下一条正文）
const MSG_OPS_STYLE = "position:absolute;right:0;bottom:-18px;display:flex;gap:4px;align-items:center;";
const MSG_OPS_RESERVE = "margin-bottom:16px;";
let ARCH_HD_TITLE = "";                               // :1705（#92 B4 典键 ai.arch.hdTitle）
let INTERFLOW_TITLE = "";                                // :1708（#92 B4 典键 ai.interflow.title）
// #31 释放显存（引擎模型缓存卸载 · 共享引擎·有任务时会中断它们）
let FREE_VRAM_BTN_TEXT = "";   // #92 B4 典键 ai.vram.btn
let FREE_VRAM_RUN_TEXT = "";   // #92 B4 典键 ai.vram.running
let FREE_VRAM_TITLE = "";   // #92 B4 典键 ai.vram.title
let TA_PLACEHOLDER = ""; // :1722（#92 B4 典键 ai.ta.ph）
// #24 需求3（ZCode 同款）：边框/圆角交给输入框容器（#aiInputBox）· textarea 自身无边框
const TA_STYLE = "width:100%;box-sizing:border-box;height:66px;min-height:60px;max-height:400px;flex-shrink:0;resize:none;background:transparent;border:0;padding:8px 10px;color:var(--txt);font-size:13px;outline:none;font-family:inherit;line-height:1.5";

// 体验修复 A4：拖动条调输入框高度——下限 60 / 上限 400（与 TA_STYLE 的 min/max-height 同口径），
//   且不超过右栏容器余量（room = 右栏高 - 220：留给底部工具条 + 边距）。
export const AI_INPUT_MIN_H = 60;
export const AI_INPUT_MAX_H = 400;
export function clampInputHeight(h, maxH) {
  const n = Number(h);
  const base = Number.isFinite(n) ? n : AI_INPUT_MIN_H;
  const capN = Number(maxH);
  const cap = Number.isFinite(capN)
    ? Math.max(AI_INPUT_MIN_H, Math.min(AI_INPUT_MAX_H, capN))
    : AI_INPUT_MAX_H;
  return Math.max(AI_INPUT_MIN_H, Math.min(cap, base));
}

// ===== #24 需求1：左栏拖宽手柄（参照 shell.js 侧栏拖拽口径：拖拽改宽 + 宽度记忆） =====
export const AI_LEFT_W_KEY = "gui13.ai.leftW";
export const AI_LEFT_MIN_W = 180;
export const AI_LEFT_MAX_W = 520;
export const AI_LEFT_DEFAULT_W = 220;   // 与 CSS .ai-l{width:220px} 同口径

export function clampLeftWidth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return AI_LEFT_DEFAULT_W;
  return Math.max(AI_LEFT_MIN_W, Math.min(AI_LEFT_MAX_W, n));
}

// 宽度记忆：存储值（越界钳制后）· 无值/脏值 → null（调用方落默认值）
export function readLeftWidth(storage) {
  const s = _storage(storage);
  if (!s) return null;
  let raw = null;
  try { raw = s.getItem(AI_LEFT_W_KEY); } catch (_e) { return null; }
  if (raw == null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? clampLeftWidth(n) : null;
}

export function writeLeftWidth(v, storage) {
  const s = _storage(storage);
  if (!s) return;
  try { s.setItem(AI_LEFT_W_KEY, String(clampLeftWidth(v))); } catch (_e) { /* 不可用（隐私模式/配额满）→ 静默吞 */ }
}

// ===== B6-T3 左栏会话列表常量 =====
let SESS_EMPTY_TEXT = "";   // #92 B4 典键 ai.sess.empty
let SESS_FAIL_TEXT = "";   // #92 B4 典键 ai.sess.fail
let NEW_SESSION_LABEL = ""; // 新会话占位项文案（前端临时态·不落库·#92 B4 典键 ai.sess.newPending）

// ===== B6-T2 常量 =====
let MODEL_PLACEHOLDER = "";  // 自绘下拉的未选占位项（原 select 首项·#92 B4 mount 期取复用键 seg.opt.phModel）
const MODEL_KEY = "gui13.llm.model";          // 引擎预设 name（主代理定夺 3）
const MODEL_MAX_LEN = 255;                    // legacy :66-79 同口径
const MODEL_RESTORE_ATTEMPTS = 12;            // legacy _scheduleModelRestore :794
const MODEL_RESTORE_INTERVAL_MS = 150;

// ===== B6-T4 智能拆镜常量（legacy :433/:489/:534 取码 + 任务单措辞） =====
let SHOTGEN_BTN = "";   // #92 B4 典键 ai.shotgen.btn
let SHOTGEN_BUSY = "";   // #92 B4 典键 ai.shotgen.busy
let SHOTGEN_TITLE = "";   // #92 B4 典键 ai.shotgen.title
let SHOTGEN_MOTION_UNKNOWN = "";   // #92 B4 典键 ai.shotgen.motionUnknown
let SHOTGEN_FAIL_TOAST = "";   // #92 B4 典键 ai.shotgen.failToast
let SHOTGEN_NO_PROJECT = ""; // CSV 先例措辞（shell.js :575 同款句式·#92 B4 典键 ai.shotgen.noProject）

// ===== B6-T5 快照互导常量（任务③④ verbatim + legacy ai_collab 取码措辞） =====
let EXPORT_NO_PROJECT = "";   // #92 B4 典键 ai.export.noProject
let APPLY_NO_SNAPSHOT = "";   // #92 B4 典键 ai.apply.noSnapshot
let IMPORT_CONFIRM_SUB = "";   // #92 B4 典键 ai.imp.sub

// ===== #23 AI 回复格式采纳（前端启发式·不动引擎侧） =====
//   命中判定：正文解析出 ≥2 个镜头段（行首序号形态 镜头1/第1镜/1. 等 · 或「画面：… 时长：…」结构行）
//   解析产物 = {desc, motion, duration, ref}（与智能拆镜建议表同构·缺字段给默认）
const SHOT_DEFAULT_DURATION = 3;                                     // 缺时长兜底（老板口径 3s）
const SHOT_ORD_RE = /^第\s*\d{1,3}\s*镜\s*[.、．:：)）]?\s*(.+)$|^(?:镜头|镜)\s*\d{1,3}\s*[.、．:：)）]?\s*(.+)$|^\s*\d{1,3}\s*[.、．)）]\s*(.+)$/;
const SHOT_DESC_RE = /(?:画面|提示词|描述)\s*[:：]\s*([^\n]*?)(?=\s*(?:时长|运镜|参考|景别|镜头角度)\s*[:：]|$)/;
const SHOT_MARK_RE = /(?:时长\s*[:：]?\s*\d|运镜\s*[:：]|参考\s*[:：]|景别\s*[:：]|镜头角度\s*[:：])/;
const SHOT_DUR_RE = /时长\s*[:：]?\s*(\d+(?:\.\d+)?)/;
const SHOT_MOTION_RE = /运镜(?:方式|类型)?\s*[:：]\s*([^\n]*)/;
const SHOT_REF_RE = /参考(?:提示)?\s*[:：]\s*([^\n]*)/;

// 行内字段抽取：描述（画面值或首个标记前文本）· 时长（默认 3s）· 运镜（缺则空）· 参考
function _parseShotFields(text) {
  const tx = String(text == null ? "" : text);
  const dm = SHOT_DESC_RE.exec(tx);
  let desc = dm ? dm[1] : tx.split(SHOT_MARK_RE)[0];
  desc = String(desc || "").trim();
  const tm = SHOT_DUR_RE.exec(tx);
  const dur = tm ? Number(tm[1]) : NaN;
  const mm = SHOT_MOTION_RE.exec(tx);
  const rm = SHOT_REF_RE.exec(tx);
  return {
    desc: desc,
    motion: mm ? String(mm[1] || "").trim() : "",
    duration: Number.isFinite(dur) && dur > 0 ? dur : SHOT_DEFAULT_DURATION,
    ref: rm ? String(rm[1] || "").trim() : "",
  };
}

// AI 回复 → 分镜段（空数组=不像分镜表）· 纯函数（前端解析·不动引擎侧）
export function parseShotTableReply(text) {
  const s = String(text == null ? "" : text).replace(/<think>[\s\S]*?<\/think>/g, "");
  const rows = [];
  for (const raw of s.split(/\r?\n/)) {
    // 行内【提示词】标记不属分镜字段（#26 两钮并存时描述列要干净）
    const line = raw.replace(/【\/提示词】/g, "").replace(/【提示词】/g, "").trim();
    if (!line) continue;
    const m = SHOT_ORD_RE.exec(line);
    if (m) {
      rows.push(_parseShotFields(m[1] || m[2] || m[3] || ""));
      continue;
    }
    if (SHOT_DESC_RE.test(line)) rows.push(_parseShotFields(line));
  }
  return rows;
}

// ===== #36 误挂采纳收紧（强特征门槛） =====
//   普通编号列表（"1. 分镜表：… 2. 素材槽位…"）不再被当分镜表挂「采纳到分镜表」钮
//   门槛：≥2 段 且 其中 ≥2 段同时含时长特征（X 秒/Xs/时长[:：]）或运镜特征（运镜[:：]）
const SHOT_STRONG_DUR_RE = /(?:\d+(?:\.\d+)?\s*(?:秒|s|S)\b)|时长\s*[:：]/;
const SHOT_STRONG_MOTION_RE = /运镜(?:方式|类型)?\s*[:：]/;

// 是否「强特征分镜表」· 纯函数（true=可挂采纳钮）
export function isStrongShotTable(text) {
  if (parseShotTableReply(text).length < 2) return false;
  const s = String(text == null ? "" : text).replace(/<think>[\s\S]*?<\/think>/g, "");
  let strong = 0;
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.replace(/【\/提示词】/g, "").replace(/【提示词】/g, "").trim();
    if (!line) continue;
    const m = SHOT_ORD_RE.exec(line);
    const isSeg = m ? true : SHOT_DESC_RE.test(line);
    if (!isSeg) continue;
    if (SHOT_STRONG_DUR_RE.test(line) || SHOT_STRONG_MOTION_RE.test(line)) strong++;
  }
  return strong >= 2;
}

// ===== #26 输出规范（发送侧隐藏块）+ 约定标记【提示词】 =====
//   ① send() 发给引擎的 message 附加隐藏规范块（界面气泡仍只显示用户原文）
//      规范块用固定分隔符包裹 → 回看/刷新渲染时 stripOutputSpec 剥除（历史消息无规范原样）
//   ② assistant 回复含【提示词】…【/提示词】 → 提取正文（可多个）→ 气泡下挂「采纳提示词」钮
//      （与启发式「采纳到分镜表」并存·两个按钮可同屏）
export const OUTPUT_SPEC_MARK = "---\n[输出规范]";
const OUTPUT_SPEC_BLOCK = "\n\n" + OUTPUT_SPEC_MARK + "\n" + CHAT_OUTPUT_SPEC_TEXT + "\n";
let NO_PROJECT_PROMPT_TOAST = "";   // 无项目上下文时的提示（#92 B4 典键 ai.adoptPrompt.noProject）

export function buildOutputSpecBlock() { return OUTPUT_SPEC_BLOCK; }

// 剥除输出规范块（无规范的历史消息原样返回）
export function stripOutputSpec(text) {
  const s = String(text == null ? "" : text);
  const i = s.indexOf(OUTPUT_SPEC_MARK);
  if (i < 0) return s;
  return s.slice(0, i).replace(/\s+$/, "");
}

// 提取【提示词】…【/提示词】 正文（可多个·空块丢弃）
export function extractPromptBlocks(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  const re = /【提示词】([\s\S]*?)【\/提示词】/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const body = String(m[1] || "").trim();
    if (body) out.push(body);
  }
  return out;
}

// 段提示词摘要（首尾各取一段·供段选择器列表展示）
function _segmentPromptSummary(p) {
  const s = String(p == null ? "" : p).trim();
  if (!s) return t("ai.segSum.empty");
  const head = s.slice(0, 12);
  const tail = s.length > 20 ? "…" + s.slice(-8) : "";
  return head + tail + t("ai.segSum.chars", { n: s.length });
}

// ===== #34 项目上下文注入（发送侧隐藏块·与输出规范块同机制·独立标记） =====
//   send() 时若当前会话元数据有 projectId（或 URL ?p=）→ 读项目 → 构造上下文块附报文尾部
//   内容 = 项目名 / 模板类型 / 全局提示词（不截断·#45）/ 分镜表（段号·时长·提示词整段·#58/镜头九项非空值）
//   渲染侧 stripHiddenBlocks 统一剥除（用户气泡与回看都不显）
export const PROJECT_CONTEXT_MARK = "===\n[项目上下文]";
export const PROJECT_CONTEXT_SEC_FIXED = "[不变设定]";   // 分区标题·块内（项目名/模板/全局提示词区）
export const PROJECT_CONTEXT_SEC_SHOT = "[本次分镜内容]"; // 分区标题·块内（分镜表摘要区）
export const PROJECT_CONTEXT_MAX_SEGMENTS = 20;   // 段数上限（超出只列前 N 段）
// #45/#58 发送侧两态判别·文案B（wire 超 16384 = 原文+输出规范块+项目上下文块合计超限）
//   人话口径覆盖整个附加块（项目上下文 = 全局提示词 + 分镜表）+ 可执行动作（精简/减少内容后重试）
//（#92 B4：文案 B 入典 ai.wire.tooLong·取词点 _describeChatError / send 两处直连 t()）
// 镜头九项（引擎 shot_vocab 全集·同 core/llm_staging.js CAMERA_SEG_KEYS 口径·角度读 seg["角度"]）
const CAMERA_SEG_KEYS_9 = [
  ["景别", "景别"],
  ["镜头角度", "角度"],
  ["运镜方式", "运镜方式"],
  ["运镜方向", "运镜方向"],
  ["运镜幅度", "运镜幅度"],
  ["运镜速度", "运镜速度"],
  ["焦段", "焦段"],
  ["氛围", "氛围"],
  ["情绪", "情绪"],
];

// 段 → 上下文行（段号/时长/提示词/镜头九项非空值）
function _projectContextSegLine(seg, idx) {
  const s = seg && typeof seg === "object" ? seg : {};
  const no = (s.n != null && s.n !== "") ? s.n : (idx + 1);
  const dur = (s.durationSec != null && s.durationSec !== "") ? s.durationSec + "秒" : "";
  const prompt = String(s.prompt || "").trim();
  const cam = [];
  for (const [label, key] of CAMERA_SEG_KEYS_9) {
    const v = s[key];
    if (v == null) continue;
    const cv = String(v).trim();
    if (cv) cam.push(label + "：" + cv);
  }
  let line = "第" + no + "段" + (dur ? "（" + dur + "）" : "") + "：";
  // #58 段提示词整段注入（撤 200 字截断·与 #45 全局提示词同款口径）——AI 必须看到每段完整动作描述
  line += prompt ? prompt : "（提示词为空）";
  if (cam.length) line += "｜" + cam.join("｜");
  return line;
}

// 项目 → 隐藏上下文块（无项目 → 空串）
export function buildProjectContextBlock(project) {
  if (!project || typeof project !== "object") return "";
  const lines = [];
  lines.push(PROJECT_CONTEXT_SEC_FIXED);
  lines.push("项目名：" + (project.name || "（未命名）"));
  const mode = project.projMode || "分镜";
  const tpl = project.templateName || project.template || "";
  lines.push("模板类型：" + mode + (tpl ? "（模板：" + tpl + "）" : ""));
  const gp = String(project.globalPrompt || "").trim();
  // #45 全局提示词不截断（整段注入·受 wire 总长 16384 引擎闸+发送侧两态判别保护）——知情标注：会放大"历史每轮全量隐藏块入库"膨胀，#46 方案轮一并处置
  if (gp) lines.push("全局提示词：" + gp);
  lines.push(PROJECT_CONTEXT_SEC_SHOT);
  const segs = Array.isArray(project.segments) ? project.segments : [];
  if (segs.length === 0) {
    lines.push("分镜表：（空）");
  } else {
    lines.push("分镜表（共 " + segs.length + " 段）：");
    const shown = segs.slice(0, PROJECT_CONTEXT_MAX_SEGMENTS);
    for (let i = 0; i < shown.length; i++) lines.push(_projectContextSegLine(shown[i], i));
    if (segs.length > PROJECT_CONTEXT_MAX_SEGMENTS) {
      lines.push("（共 " + segs.length + " 段·仅列前 " + PROJECT_CONTEXT_MAX_SEGMENTS + " 段）");
    }
  }
  return "\n\n" + PROJECT_CONTEXT_MARK + "\n" + lines.join("\n") + "\n";
}

// 剥除项目上下文块（无上下文的历史消息原样返回）
export function stripProjectContext(text) {
  const s = String(text == null ? "" : text);
  const i = s.indexOf(PROJECT_CONTEXT_MARK);
  if (i < 0) return s;
  return s.slice(0, i).replace(/\s+$/, "");
}

// 统一剥除隐藏块（输出规范 + 项目上下文）——气泡/回看渲染入口
export function stripHiddenBlocks(text) {
  const s = String(text == null ? "" : text);
  let out = s;
  const iSpec = out.indexOf(OUTPUT_SPEC_MARK);
  if (iSpec >= 0) out = out.slice(0, iSpec);
  const iProj = out.indexOf(PROJECT_CONTEXT_MARK);
  if (iProj >= 0) out = out.slice(0, iProj);
  if (out !== s) out = out.replace(/\s+$/, "");
  return out;
}

// ===== #22-10 输入框草稿（切页不丢内容） =====
//   gui13.ai.draft = { sessionKey, text }（sessionKey = 会话 id · 无会话时 "new"）
//   属当前上下文（同一会话或都是新会话）才回填；发送成功 / 点「新会话」清空
export const AI_DRAFT_KEY = "gui13.ai.draft";
export const AI_DRAFT_DEBOUNCE_MS = 300;

// 读草稿（坏数据 → null·不抛）
export function loadDraft(storage) {
  const s = _storage(storage);
  if (!s) return null;
  let raw = null;
  try { raw = s.getItem(AI_DRAFT_KEY); } catch (_e) { return null; }
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_e) { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const text = typeof obj.text === "string" ? obj.text : "";
  if (!text) return null;
  const key = typeof obj.sessionKey === "string" && obj.sessionKey ? obj.sessionKey : "new";
  return { sessionKey: key, text: text };
}

// 写草稿（空文本 → 删键 = 清草稿）
export function saveDraft(storage, sessionKey, text) {
  const s = _storage(storage);
  if (!s) return false;
  const txt = typeof text === "string" ? text : "";
  if (!txt) {
    try { s.removeItem(AI_DRAFT_KEY); } catch (_e) { /* 存储不可用不阻断 */ }
    return true;
  }
  try {
    s.setItem(AI_DRAFT_KEY, JSON.stringify({ sessionKey: sessionKey || "new", text: txt }));
    return true;
  } catch (_e) { return false; }
}

// ===== #22 会话本地元数据层（gui13.ai.sessionMeta） =====
//   { [sessionId]: { name?: string, projectId?: string, edited?: { [msgKey]: string } } }
//   批2：edited = 消息编辑覆盖层（msgKey = "<原始消息序>:<角色>"·仅本地·不写引擎）
//   #46 批7：visibility = AI 可见性指示快照（本地态·刷新/切会话回看仍在·不写引擎）
//   宽容解析：坏 JSON / 非对象 / 脏条目 → 回落空（不抛）
export const AI_SESSION_META_KEY = "gui13.ai.sessionMeta";

export function loadSessionMeta(storage) {
  const s = _storage(storage);
  if (!s) return {};
  let raw = null;
  try { raw = s.getItem(AI_SESSION_META_KEY); } catch (_e) { return {}; }
  if (!raw) return {};
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_e) { return {}; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [sid, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const meta = {};
    if (typeof v.name === "string" && v.name.trim()) meta.name = v.name.trim();
    if (typeof v.projectId === "string" && v.projectId.trim()) meta.projectId = v.projectId.trim();
    // 批2：消息编辑覆盖层（脏条目丢弃）
    if (v.edited && typeof v.edited === "object" && !Array.isArray(v.edited)) {
      const ed = {};
      for (const [k, val] of Object.entries(v.edited)) {
        if (typeof k === "string" && k && typeof val === "string") ed[k] = val;
      }
      if (Object.keys(ed).length) meta.edited = ed;
    }
    // #46 批7：可见性指示快照（脏条目丢弃）
    const vis = normalizeVisibility(v.visibility);
    if (vis) meta.visibility = vis;
    out[sid] = meta;
  }
  return out;
}

export function saveSessionMeta(storage, meta) {
  const s = _storage(storage);
  if (!s) return false;
  const obj = (meta && typeof meta === "object" && !Array.isArray(meta)) ? meta : {};
  try { s.setItem(AI_SESSION_META_KEY, JSON.stringify(obj)); return true; } catch (_e) { return false; }
}

// 改某会话的元数据字段（空串/空值 → 删该字段）→ 写回
export function setSessionMeta(storage, sessionId, patch) {
  if (!sessionId) return {};
  const all = loadSessionMeta(storage);
  const cur = Object.assign({}, all[sessionId] || {});
  if (patch && typeof patch === "object") {
    for (const [k, v] of Object.entries(patch)) {
      const val = typeof v === "string" ? v.trim() : "";
      if (val) cur[k] = val; else delete cur[k];
    }
  }
  if (Object.keys(cur).length === 0) delete all[sessionId]; else all[sessionId] = cur;
  saveSessionMeta(storage, all);
  return all;
}

// 批2：读某条消息的本地编辑覆盖（无覆盖 → 空串）
export function getEditedText(storage, sessionId, msgKey) {
  if (!sessionId || !msgKey) return "";
  const meta = loadSessionMeta(storage)[sessionId] || {};
  const ed = meta.edited && typeof meta.edited === "object" ? meta.edited : {};
  const v = ed[msgKey];
  return typeof v === "string" ? v : "";
}

// 批2：写/删某条消息的本地编辑覆盖（空文本 = 删条目 = 恢复原文）→ 写回元数据
export function setSessionEdit(storage, sessionId, msgKey, text) {
  if (!sessionId || !msgKey) return {};
  const all = loadSessionMeta(storage);
  const cur = Object.assign({}, all[sessionId] || {});
  const edited = Object.assign({}, cur.edited && typeof cur.edited === "object" ? cur.edited : {});
  const txt = typeof text === "string" ? text : "";
  if (txt.trim()) edited[msgKey] = txt; else delete edited[msgKey];
  if (Object.keys(edited).length) cur.edited = edited; else delete cur.edited;
  if (Object.keys(cur).length === 0) delete all[sessionId]; else all[sessionId] = cur;
  saveSessionMeta(storage, all);
  return all;
}

// #47：删除后按回传新清单序号重建 edited 映射（纯函数·不落盘）
//   新位 j ← 旧位（j < 删位 ? j : j+1·顺序保持的删一位对齐）；键角色沿用清单值（消息本体未变）；
//   被删消息的编辑版无新位可挂 → 随删弃置；脏入参回落空映射（不抛）
export function rekeyEditedOverlay(edited, delIndex, newList) {
  const ed = (edited && typeof edited === "object" && !Array.isArray(edited)) ? edited : {};
  const out = {};
  if (!Array.isArray(newList)) return out;
  const di = Number(delIndex);
  if (!Number.isInteger(di) || di < 0) return out;
  for (let j = 0; j < newList.length; j++) {
    const oi = j < di ? j : j + 1;
    const role = (newList[j] && newList[j].role) || "user";
    const v = ed[oi + ":" + role];
    if (typeof v === "string") out[j + ":" + role] = v;
  }
  return out;
}

// #47：整体替换某会话的 edited 映射（删除重键落盘·空/脏映射=删字段）→ 写回元数据
export function replaceSessionEdits(storage, sessionId, edited) {
  if (!sessionId) return {};
  const all = loadSessionMeta(storage);
  const cur = Object.assign({}, all[sessionId] || {});
  const clean = {};
  if (edited && typeof edited === "object" && !Array.isArray(edited)) {
    for (const [k, val] of Object.entries(edited)) {
      if (typeof k === "string" && k && typeof val === "string" && val) clean[k] = val;
    }
  }
  if (Object.keys(clean).length) cur.edited = clean; else delete cur.edited;
  if (Object.keys(cur).length === 0) delete all[sessionId]; else all[sessionId] = cur;
  saveSessionMeta(storage, all);
  return all;
}

// ===== #46 批7 G1 + #59 批9 G1：AI 可见性指示（引擎契约 docs/api.md §65） =====
//   引擎两段式裁剪（保头保尾·中间省略）·响应回传：
//     sent_messages_count  = 实际发给模型的 messages 条数（含 system 与本轮 user）→ 历史实发 = 值 − 2
//     sent_chars           = 上述 messages 字符总数
//     carries_context_floor= 预算降级标记（有历史但最近一条历史未能送出 → 尾部为空·只挂降级提示行）
//     trimmed_old_count    = 仅未发送条数（= 中间省略条数·口径见 api.md §65 ④）
//     head_messages_count  = 头部实发条数（批9 E2 新增·int≥0）
//   头尾方向不再推算（批7 审核第 15 条登记盲区：推断「头=前 1-2 条」在 head=0 场景错标）：
//     head_messages_count 在 → head/tail 按字段精确标注；缺/脏 → 文案降级只报计数不标方向
//   无 sent 字段（批7 前旧引擎）→ 返回 null：会话面板不显示指示（零报错·不虚报·宁缺勿错）
export const VISIBILITY_FLOOR_HINT = "上下文极小·历史未能附带";      // 预算降级提示（renderVisibility 挂行用）

export function deriveVisibility(input) {
  const o = (input && typeof input === "object") ? input : {};
  // 缺字段哨兵 = null/undefined/空串（旧引擎·域层归一为 null）→ 不显示（注意 Number(null)=0·不可直接 Number()）
  const sent = (typeof o.sent === "number") ? o.sent
    : (typeof o.sent === "string" && o.sent.trim() ? Number(o.sent) : NaN);
  if (!Number.isFinite(sent)) return null;                        // 旧引擎缺 sent_messages_count → 不显示
  const trimmed = Number(o.trimmed);
  const omitted = (Number.isFinite(trimmed) && trimmed > 0) ? Math.floor(trimmed) : 0;
  const floor = o.floor === true;
  const hist = Math.max(0, Math.floor(sent) - 2);                 // 历史实发条数（sent 含 system 与本轮 user）
  const hasHead = Number.isInteger(o.headCount) && o.headCount >= 0;   // 引擎 int 契约·脏值视同缺字段
  const head = hasHead ? Math.min(o.headCount, hist) : 0;         // 超 hist（契约外）钳到 hist·tail 不为负
  const tail = hasHead ? hist - head : 0;                         // 方向未知（缺字段）→ 0 占位不虚报（渲染只消费 text/floor）
  const text = omitted > 0
    ? (hasHead
      ? t("ai.vis.head", { head, tail, omitted })
      : t("ai.vis.histOmitted", { hist, omitted }))
    : t("ai.vis.histAll", { hist });
  return { head, tail, omitted, floor, text };
}

// 可见性快照归一（脏条目 → null·不抛）
export function normalizeVisibility(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const head = Number(v.head), tail = Number(v.tail), omitted = Number(v.omitted);
  if (!Number.isInteger(head) || !Number.isInteger(tail) || !Number.isInteger(omitted)) return null;
  if (head < 0 || tail < 0 || omitted < 0) return null;
  const text = typeof v.text === "string" ? v.text : "";
  if (!text) return null;
  return { head, tail, omitted, floor: v.floor === true, text };
}

// 读某会话的可见性快照（无 → null）
export function getSessionVisibility(storage, sessionId) {
  if (!sessionId) return null;
  const meta = loadSessionMeta(storage)[sessionId] || {};
  return normalizeVisibility(meta.visibility);
}

// 写/删某会话的可见性快照（脏快照 = 删字段）→ 写回元数据
export function setSessionVisibility(storage, sessionId, vis) {
  if (!sessionId) return {};
  const all = loadSessionMeta(storage);
  const cur = Object.assign({}, all[sessionId] || {});
  const clean = normalizeVisibility(vis);
  if (clean) cur.visibility = clean; else delete cur.visibility;
  if (Object.keys(cur).length === 0) delete all[sessionId]; else all[sessionId] = cur;
  saveSessionMeta(storage, all);
  return all;
}

// 插入到父节点首位（真 DOM insertBefore·测试桩兜底：重挂子节点保序）
function _insertFirst(parent, node) {
  if (!parent || !node) return;
  if (typeof parent.insertBefore === "function") { parent.insertBefore(node, parent.firstChild); return; }
  const kids = Array.from(parent.children || []);
  for (const k of kids) parent.removeChild(k);
  parent.appendChild(node);
  for (const k of kids) parent.appendChild(k);
}

// 插入到参考节点之前（真 DOM insertBefore·测试桩兜底：按序重挂子节点）
function _insertBefore(refNode, node) {
  if (!refNode || !node) return;
  const parent = refNode.parentNode;
  if (!parent) return;
  if (typeof parent.insertBefore === "function") { parent.insertBefore(node, refNode); return; }
  const kids = Array.from(parent.children || []);
  const rebuilt = [];
  for (const k of kids) {
    if (k === refNode) rebuilt.push(node);
    rebuilt.push(k);
  }
  for (const k of kids) parent.removeChild(k);
  for (const k of rebuilt) parent.appendChild(k);
}

// 节点是否在 root 之内（DOM 祖先链判定·不依赖 contains·真/桩通用）
function _isInside(node, root) {
  let cur = node;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parentNode;
  }
  return false;
}

// 项目 id → 名称（关联项目标签展示·读侧兜底）
function _projectName(projectId) {
  const p = projectId ? storeLoad(projectId) : null;
  return (p && typeof p.name === "string") ? p.name : "";
}

// #22 关联项目指令（自然语言·零弹窗）：^关联(到)?项目 + 分隔符（冒号或空白）+ 项目名
//   批2 修正：原 `s*` 是笔误（应为 \s*）；且分隔符必须显式出现（冒号或空白），
//   否则「关联项目sssX」这类粘连写法会被误判成指令（老板口径：非指令 → 照常发引擎）
const ASSOC_CMD_RE = /^关联(到)?项目(?:[:：]\s*|\s+)(.+)$/;

// ===== 全局键 =====
export const AI_ARCHIVE_KEY = "gui13.aiArchive";

// ===== 检查条 errs 人话化（老板复验 2026-10-26 #18）=====
//   引擎原始报错（如「JSON 解析失败: Expecting value(行 1)」）用户看不懂 → 命中已知模式改人话，
//   原文放 title（鼠标悬停可见）；未命中模式原样透传（不猜不编）。
const AI_ERR_HUMAN = [
  { re: /JSON 解析失败|Expecting value|Unexpected token/i, key: "ai.err.humanJson" },
];
function humanizeAiErr(raw) {
  const s = String(raw == null ? "" : raw);
  for (const m of AI_ERR_HUMAN) {
    if (m.re.test(s)) return { text: t(m.key), raw: s, mapped: true };
  }
  return { text: s, raw: "", mapped: false };
}

// ===== storage 适配 =====
function _storage(s) {
  if (s && typeof s.getItem === "function") return s;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

// ===== #31 释放显存（同源伴生服务端点 /gui13-fs/*） =====
//   GET  /gui13-fs/engine_busy → {ok,running,pending,busy}（引擎不可达 → {ok:false,error:"engine_unreachable"}）
//   POST /gui13-fs/free_vram   → 空闲 {ok:true,before_free_gb,after_free_gb,total_gb}；忙且未 force → 409 engine_busy
async function _fsCall(path, opts) {
  let resp;
  try {
    resp = await fetchApi(path, Object.assign({ self: true }, opts || {}));
  } catch (_e) {
    return { ok: false, status: 0, error: "network", json: null };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { json = null; }
  if (resp.ok && json && json.ok === true) return { ok: true, status: resp.status, json };
  const code = (json && json.error) || ("http_" + resp.status);
  return { ok: false, status: resp.status, error: String(code), json };
}

// 释放成功 toast 文案（用返回值·数值取不到则不带）
export function freeVramOkText(json) {
  const j = json && typeof json === "object" ? json : {};
  const free = Number(j.after_free_gb);
  const total = Number(j.total_gb);
  if (Number.isFinite(free) && Number.isFinite(total)) {
    return t("ai.vram.okBoth", { free: free.toFixed(1), total: total.toFixed(1) });
  }
  if (Number.isFinite(free)) return t("ai.vram.okFree", { free: free.toFixed(1) });
  return t("ai.vram.ok");
}

// 失败/不可达 → 人话
export function freeVramErrText(code) {
  const c = String(code == null ? "" : code);
  if (c === "engine_unreachable") return t("ai.vram.err.unreachable");
  if (c === "engine_busy") return t("ai.vram.err.busy");
  if (c === "free_failed") return t("ai.vram.err.freeFailed");
  if (c === "network") return t("ai.vram.err.network");
  if (c === "timeout") return t("ai.vram.err.timeout");
  // 加固 B（#31）：404 / 未注册端点＝服务端路由未生效（网页服务未重启）·须在通用 http_ 分支之前
  if (c === "http_404" || c === "unknown_gui13_endpoint") return t("ai.vram.err.needRestart");
  if (c.indexOf("http_") === 0) return t("ai.vram.err.http", { code: c.slice(5) });
  return t("ai.vram.err.generic");
}

function _safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

// ===== 持久化 =====
export function loadArchive(storage) {
  const s = _storage(storage);
  if (!s) return [];
  const v = readAgg(USER_JSON, "aiArchive", s);   // M-T5：AI 存档迁 data/user.json
  if (Array.isArray(v)) return v;
  return _safeParse(s.getItem(AI_ARCHIVE_KEY), []);
}

export function saveArchive(storage, list) {
  const s = _storage(storage);
  if (!s) return false;
  writeAgg(USER_JSON, "aiArchive", Array.isArray(list) ? list : []);   // M-T5
  return true;
}

// ===== 模型选择持久化（legacy ai_collab_llm.js:80-98 取码 · 键族改 gui13.llm.model） =====
function _isValidModelName(s) {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > MODEL_MAX_LEN) return false;
  if (/[\x00-\x1f]/.test(s)) return false;
  return true;
}

function _persistModel(storage, name) {
  const s = _storage(storage);
  if (!s || !_isValidModelName(name)) return;
  writeAgg(USER_JSON, "llmModel", String(name));   // M-T5：模型选择迁 data/user.json（llm.session 留浏览器）
}

function _restoreModel(storage) {
  const s = _storage(storage);
  if (!s) return null;
  const v = readAgg(USER_JSON, "llmModel", s);
  const raw = typeof v === "string" ? v : s.getItem(MODEL_KEY);
  if (_isValidModelName(raw)) return raw;
  writeAgg(USER_JSON, "llmModel", null);   // 非法值静默清键
  return null;
}

function _clearModel(storage) {
  if (_storage(storage)) writeAgg(USER_JSON, "llmModel", null);
}

// ===== 数组操作（不可变） =====
function _genId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "arch-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function _nowIso() { return new Date().toISOString(); }

export function findById(list, id) {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((it) => it && it.id === id);
}

export function addToArchive(list, item) {
  const arr = Array.isArray(list) ? list : [];
  const seed = (item && typeof item === "object") ? item : {};
  const next = {
    id: typeof seed.id === "string" && seed.id.length > 0 ? seed.id : _genId(),
    title: typeof seed.title === "string" ? seed.title : "（未命名对话）",
    createdAt: typeof seed.createdAt === "string" && seed.createdAt.length > 0 ? seed.createdAt : _nowIso(),
    turns: Number.isFinite(seed.turns) ? seed.turns : 0,
  };
  return [next, ...arr];
}

export function removeFromArchive(list, id) {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter((it) => it && it.id !== id);
}

export function restoreFromArchive(list, id) {
  const arr = Array.isArray(list) ? list : [];
  const idx = findById(arr, id);
  if (idx < 0) return null;
  return arr[idx];
}

// ===== #24 追加：自绘模型下拉弹层（向上弹出·防视口裁切） =====
//   仓内 cbox 家族：触发器 .cbox（.cb-v 值 + .cb-a 箭头）· 浮层 .cbox-menu（fixed·max-height+内部滚动）· 选项 .co
//   浮层挂 document.body（fixed 坐标系）· 位置：优先向上（输入框在页面底部）· 点外部/ESC 关闭。
let _modelMenu = null;                 // 当前打开的模型菜单（最多一个）
const _menuDelegatedBodies = new WeakSet();   // body 级委托（点外部关 / ESC 关）每 body 只绑一次

function closeModelMenu() {
  if (_modelMenu && _modelMenu.parentNode) _modelMenu.parentNode.removeChild(_modelMenu);
  _modelMenu = null;
}

// 浮层定位：优先向上（上方空间够）；上方不够才向下；max-height 按可用空间收紧（不被视口裁切）
function positionModelMenu(menu, anchor) {
  const r = (anchor && typeof anchor.getBoundingClientRect === "function") ? anchor.getBoundingClientRect() : null;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
  const vw = (typeof window !== "undefined" && window.innerWidth) || 1200;
  const gap = 4;
  const top = r ? Number(r.top) || 0 : 0;
  const bottom = r ? Number(r.bottom) || 0 : 0;
  const left = r ? Number(r.left) || 0 : 0;
  const up = top - (Number(menu.offsetHeight) || 0) - gap >= 0;   // 上方够 → 向上
  const room = up ? top - gap - 8 : vh - bottom - gap - 8;
  menu.style.maxHeight = Math.round(Math.max(120, Math.min(vh * 0.6, room))) + "px";
  const h = Number(menu.offsetHeight) || 0;
  menu.style.top = Math.round(up ? top - h - gap : bottom + gap) + "px";
  menu.style.left = Math.round(Math.min(Math.max(8, left), Math.max(8, vw - (Number(menu.offsetWidth) || 0) - 8))) + "px";
  menu.setAttribute("data-open", up ? "up" : "down");   // 供测试断言展开方向
}

// ===== DOM 辅助 =====
function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = String(v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function _formatDate(iso) {
  if (typeof iso !== "string") return "";
  // 取 YYYY-MM-DD HH:MM（#40：归档副行完整时间·直接切 ISO 串，时区无关）
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

// ===== #51 会话行展示（legacy llm_read.js 取码 · 批10A-T3 改可读短名, 不再露出裸哈希前缀） =====
const _pad2 = (n) => String(n).padStart(2, "0");

// updated_at 是 unix 秒 → 本地时间 YYYY-MM-DD HH:MM（0/缺/非数 → 空串）
function _sessionTimeStr(row) {
  if (!row || typeof row.updated_at !== "number" || !(row.updated_at > 0)) return "";
  const d = new Date(row.updated_at * 1000);
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} ${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
}

export function normalizeSessionRow(row) {
  if (!row || typeof row !== "object") return t("ai.sess.unknown");
  const timeStr = _sessionTimeStr(row) || t("ai.sess.noTime");
  const cnt = (typeof row.messages_count === "number") ? row.messages_count : 0;
  return t("ai.sess.row", { time: timeStr, n: cnt });
}

// 归档条目展示名 = 「会话 + 时间」（行数据缺时间时回退 id 截 12）
function _sessionArchiveTitle(row, id) {
  const ts = _sessionTimeStr(row);
  const short = String(id || "").slice(0, 12) + "…";
  return ts ? `会话 ${ts}` : `会话 ${short}`;
}

// 删除二次确认（与 settings.js 同样 3s 状态机）
function _makeDelState() { return { phase: "idle", firstAt: 0 }; }
function _tickDelState(st, now) {
  const nowMs = typeof now === "number" ? now : Date.now();
  if (st.phase === "idle") return { phase: "armed", firstAt: nowMs };
  if (st.phase === "armed") {
    if (nowMs - st.firstAt >= 3000) return { phase: "idle", firstAt: 0 };
    return { phase: "confirmed", firstAt: st.firstAt };
  }
  return st;
}

// 对话错误 → 白话（引擎 #50 错误码前缀 + detail 兜底）
function _describeChatError(err) {
  const code = (err && err.code) || "unknown";
  // #45: 对象 detail 携 reason（validateMessage {reason:"too_long"}·sendChat 本地预校验/引擎 400 同形）
  const reason = (err && err.detail && typeof err.detail === "object" && err.detail.reason) || "";
  const detail = (err && (err.msg || (typeof err.detail === "string" ? err.detail : ""))) || "";
  const prefixKey = {
    llm_call_failed: "ai.err.llmCallFailed",
    llm_context_overflow: "ai.err.ctxOverflow",
    unknown_model: "ai.err.unknownModel",
    session_not_found: "ai.err.sessionNotFound",
    index_out_of_range: "ai.err.indexOutOfRange",   // #47 删除越界（清单可能已变化）
  }[code];
  const prefix = prefixKey ? t(prefixKey) : undefined;
  if (prefix) return detail ? t("ai.err.withDetail", { prefix, detail }) : prefix;
  // #45: message_invalid+too_long 兜底文案——发送侧两态判别前置（原文超长态 A 不会发出），能到引擎兜底的只剩 wire 超限态 B
  if (code === "message_invalid" && reason === "too_long") {
    return t("ai.wire.tooLong");
  }
  return detail || t("ai.err.callFail", { code });
}

// ===== mount(container, opts) — AI 协作页整页（v43 :1693-1728） =====
export function mount(container, opts = {}) {
  if (!container || typeof document === "undefined") return null;
  closeModelMenu();   // 上次挂载遗留的模型菜单（自绘浮层挂 body·换视图时清掉）
  while (container.firstChild) container.removeChild(container.firstChild);

  // ===== #92 B4：常量区 mount 期取值（§4.9·禁模块顶层 t()——跨机首访无快键时 import 期取 zh 的缺陷规避）=====
  INH_HEAD = t("ai.inh.head");
  ARCH_ROW_BTN_TITLE = t("ai.arch.rowBtnTitle");
  ARCH_BTN_TEXT = t("ai.arch.rowBtn");
  ARCH_ARM_TEXT = t("ai.arch.rowArm");
  DEL_MSG_CONFIRM_TEXT = t("ai.delMsg.confirm");
  ARCH_HD_TITLE = t("ai.arch.hdTitle");
  INTERFLOW_TITLE = t("ai.interflow.title");
  FREE_VRAM_BTN_TEXT = t("ai.vram.btn");
  FREE_VRAM_RUN_TEXT = t("ai.vram.running");
  FREE_VRAM_TITLE = t("ai.vram.title");
  TA_PLACEHOLDER = t("ai.ta.ph");
  SESS_EMPTY_TEXT = t("ai.sess.empty");
  SESS_FAIL_TEXT = t("ai.sess.fail");
  NEW_SESSION_LABEL = t("ai.sess.newPending");
  MODEL_PLACEHOLDER = t("seg.opt.phModel");
  SHOTGEN_BTN = t("ai.shotgen.btn");
  SHOTGEN_BUSY = t("ai.shotgen.busy");
  SHOTGEN_TITLE = t("ai.shotgen.title");
  SHOTGEN_MOTION_UNKNOWN = t("ai.shotgen.motionUnknown");
  SHOTGEN_FAIL_TOAST = t("ai.shotgen.failToast");
  SHOTGEN_NO_PROJECT = t("ai.shotgen.noProject");
  EXPORT_NO_PROJECT = t("ai.export.noProject");
  APPLY_NO_SNAPSHOT = t("ai.apply.noSnapshot");
  IMPORT_CONFIRM_SUB = t("ai.imp.sub");
  NO_PROJECT_PROMPT_TOAST = t("ai.adoptPrompt.noProject");

  const storage = opts.storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);

  // 体验修复 A4：整页高度约束在视口内（section 可随 #views 收缩；否则消息流把整页撑到内容高度）
  const sec = el("section", { id: "view-ai", class: "shell-view", style: "flex:1 1 auto;min-height:0" });

  // ---------- 顶栏（:1695） ----------
  sec.appendChild(el("div", { class: "proj-top" }, [
    el("h2", { text: t("shell.nav.ai") }),
    el("span", { class: "inh", text: INH_HEAD }),
  ]));

  // 体验修复 A4：wrap/双栏补齐 min-height:0（覆盖 CSS 的 420px 下限与 flex 默认 min-height:auto）
  const wrap = el("div", { class: "ai-wrap", style: "min-height:0;overflow:hidden" });
  const left = el("div", { class: "ai-l", style: "min-height:0" });
  const right = el("div", { class: "ai-r", style: "min-height:0;overflow:hidden" });
  wrap.appendChild(left);

  // ---------- #24 需求1：左栏拖宽手柄（细线 + hover 变色 + col-resize 光标） ----------
  //   命中区 6px 居中于 .ai-wrap 的 12px 间距（margin 0 -9px → 布局宽度不变）；
  //   拖拽改宽 180-520（clampLeftWidth）+ 记忆键 gui13.ai.leftW（刷新后恢复）。
  const resize = el("div", {
    id: "aiLeftResize",
    class: "ai-col-resize",
    title: t("ai.left.resizeTitle"),
    style: "position:relative;flex:0 0 auto;width:6px;margin:0 -9px;cursor:col-resize;background:transparent;align-self:stretch",
  });
  const resizeLine = el("span", {
    style: "position:absolute;top:0;bottom:0;left:50%;width:1px;margin-left:-0.5px;background:var(--line)",
  });
  resize.appendChild(resizeLine);
  wrap.appendChild(resize);
  wrap.appendChild(right);
  sec.appendChild(wrap);

  // 宽度：记忆值优先（越界钳制）· 缺省 220（与 CSS .ai-l 同口径）
  const restoredW = readLeftWidth(storage);
  let leftW = restoredW == null ? AI_LEFT_DEFAULT_W : restoredW;
  left.style.width = leftW + "px";

  let resizing = false;
  let hovering = false;
  let resizeStartX = 0;
  let resizeStartW = 0;
  const paintResize = () => {
    const on = resizing || hovering;
    resize.style.background = on ? "rgba(84,196,255,.18)" : "transparent";
    resizeLine.style.background = on ? "var(--accent-bright)" : "var(--line)";
  };
  const onResizeMove = (ev) => {
    if (!resizing) return;
    const x = (ev && Number.isFinite(ev.clientX)) ? ev.clientX : resizeStartX;
    leftW = clampLeftWidth(resizeStartW + (x - resizeStartX));
    left.style.width = leftW + "px";
  };
  const onResizeEnd = () => {
    if (!resizing) return;
    resizing = false;
    document.removeEventListener("pointermove", onResizeMove);
    document.removeEventListener("pointerup", onResizeEnd);
    document.removeEventListener("pointercancel", onResizeEnd);
    paintResize();
    writeLeftWidth(leftW, storage);
  };
  const onResizeDown = (ev) => {
    if (ev && ev.button) return;    // 仅左键
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    resizing = true;
    resizeStartX = (ev && Number.isFinite(ev.clientX)) ? ev.clientX : 0;
    resizeStartW = leftW;
    // 拖动期间挂 document 级监听（指针拖出手柄仍跟随；松手即摘）
    document.addEventListener("pointermove", onResizeMove);
    document.addEventListener("pointerup", onResizeEnd);
    document.addEventListener("pointercancel", onResizeEnd);
    paintResize();
  };
  resize.addEventListener("mouseenter", () => { hovering = true; paintResize(); });
  resize.addEventListener("mouseleave", () => { hovering = false; paintResize(); });
  resize.addEventListener("pointerdown", onResizeDown);
  resize.addEventListener("pointermove", onResizeMove);
  resize.addEventListener("pointerup", onResizeEnd);

  // ---------- 左栏：会话标题 +「＋新会话」（左栏顶; F44「归档」钮移至会话列表之后） ----------
  const newBtnL = el("span", {
    id: "aiNewSessionTop",
    class: "fbtn",
    title: t("ai.newBtn.title"),
    text: t("ai.newBtn.label"),
  });
  left.appendChild(el("div", { class: "edit-title", style: "margin-bottom:8px" }, [t("ai.lcol.title"), newBtnL]));

  // ---------- 会话列表: listSessions 真数据（T3 A4 · 三条 fixture 已退役） ----------
  const sessList = el("div", { id: "aiSessList" });
  left.appendChild(sessList);
  let sessSeq = 0;        // 过期响应丢弃（装配刷新与发送后刷新可能重叠）
  let pendingNew = false; // 新会话占位态（前端临时态·引擎建会话后由发送成功退役）
  let msgSeq = 0;         // 批2：当前会话已知消息数（msgKey 的消息序来源）

  let pendingProjectId = "";   // #22 新会话待关联项目（引擎建会话后写入元数据）

  let _newPanel = null;         // #22 新会话项目选择面板

  // 新会话占位项（新会话已开·引擎尚未建会话 → 行内占位；金色描边 +「新」标签与历史行区分）
  //   挂靠批：占位项可点选 → 切回未发送新会话态（清空消息区·占位行高亮·后续发送进新会话）
  function appendPendingRow() {
    const isCur = !getCurrentSessionId();   // 无当前会话（未发送态）→ 高亮占位行
    const ph = el("div", {
      id: "aiSessPending",
      class: isCur ? "preset on preset-new" : "preset preset-new",
      style: "border-color:#e8b339;background:rgba(232,179,57,.10)",
      title: t("ai.pending.title"),
    });
    ph.appendChild(el("span", { class: "nm", text: NEW_SESSION_LABEL }));
    ph.appendChild(el("span", {
      style: "flex-shrink:0;font-size:11px;line-height:16px;color:#e8b339;border:1px solid #e8b339;border-radius:6px;padding:0 5px",
      text: t("ai.pending.badge"),
    }));
    ph.addEventListener("click", () => { switchToPendingSession(); });
    sessList.appendChild(ph);
  }

  // 点占位项 → 切回未发送新会话态（注销当前会话·清消息区·占位行高亮·后续发送进新会话）
  function switchToPendingSession() {
    resetCurrentSession();
    clearMsgs();
    clearChecks();
    pendingNew = true;
    saveDraft(storage, "", "");   // #22-10：切回未发送新会话 → 清草稿
    ta.value = "";                // 同上：输入框一并清空
    renderSessions();          // 占位行高亮（当前会话已注销）
    showToast("info", t("ai.toast.backToNew"));
  }

  // 行内归档钮：把该会话存入本地归档（条目 id=会话 id · title=主列表展示名 · turns=引擎行 messages_count #40）
  // #25：执行后不弹 toast（成功/重复都别弹·按钮状态即反馈）· 归档后主列表过滤（renderSessions）
  function archiveSession(row, dispName) {
    const sid = row && typeof row.id === "string" ? row.id : "";
    if (!sid) return;
    const list = loadArchive(storage);
    if (findById(list, sid) >= 0) return;   // 已在归档（重复点击静默·不弹 toast）
    saveArchive(storage, addToArchive(list, {
      id: sid,
      title: dispName || _sessionArchiveTitle(row, sid),   // #40：展示名由调用点传入（单一真源），无则退时间兜底
      turns: Number.isFinite(row.messages_count) ? row.messages_count : 0,   // #40：真实消息量
    }));
    renderArchive();
    renderSessions();   // 主列表刷新 → 已归档会话从列表消失
  }

  async function renderSessions() {
    const seq = ++sessSeq;
    while (sessList.firstChild) sessList.removeChild(sessList.firstChild);
    if (pendingNew) appendPendingRow();   // 占位项立即在位（不等引擎）
    const r = await listSessions();
    if (seq !== sessSeq) return;
    if (typeof document === "undefined") return; // 视图已卸载（挂起响应丢弃, 同 T2 modelSel.isConnected 口径）
    if (!r.ok) {
      sessList.appendChild(el("div", { class: "inh", style: "font-size:12px", text: SESS_FAIL_TEXT }));
      const retry = el("span", { class: "fbtn", style: "margin-top:6px;display:inline-block", text: t("edit.export.retry") });
      retry.addEventListener("click", () => { renderSessions(); });
      sessList.appendChild(retry);
      return;
    }
    // #25：主列表过滤已在本地归档的会话（归档 → 行消失·归档区仍可见）
    const archivedIds = new Set(loadArchive(storage).map((it) => it && it.id).filter(Boolean));
    const rows = r.sessions.filter((s) => s && typeof s.id === "string" && !archivedIds.has(s.id));
    if (rows.length === 0) {
      sessList.appendChild(el("div", { class: "inh", style: "font-size:12px", text: SESS_EMPTY_TEXT }));
      return;
    }
    const cur = getCurrentSessionId();
    const metaAll = loadSessionMeta(storage);   // #22 本地元数据（改名/关联项目）
    for (const s of rows) {
      const item = el("div", { class: s.id === cur ? "preset on" : "preset", "data-id": s.id });
      const meta = metaAll[s.id] || {};
      // 展示名优先级（挂靠批）：自定义名 > 关联项目名 > 默认「会话 · 日期 · N 条」
      const projName = meta.projectId ? (_projectName(meta.projectId) || "") : "";
      const dispName = meta.name || projName || normalizeSessionRow(s);
      const nameNode = el("span", { class: "nm", text: dispName });
      item.appendChild(nameNode);
      // 关联项目标签（#22 本地元数据）——展示名已是项目名时不重复挂标签
      if (meta.projectId && projName && projName !== dispName) {
        item.appendChild(el("span", {
          class: "ai-tag",
          style: "font-size:11px;color:var(--txt3);flex-shrink:0",
          text: t("ai.sess.projTag", { name: projName }),
        }));
      }
      // 改名钮（✎·hover 显）→ 行内变输入框
      const renameBtn = el("button", {
        type: "button",
        class: "ghostbtn-mini ai-rename",
        title: t("ai.rename.title"),
        text: "✎",
        style: "opacity:0;flex-shrink:0",
      });
      renameBtn.addEventListener("click", (e) => {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        startRename(item, s, meta);
      });
      item.appendChild(renameBtn);
      // 行内归档钮（老板需求）: stopPropagation → 不触发行点击（不弹回看弹层）
      // #25 两步确认：首点 → 红态「确认归档」（3s 内有效）· 再点执行 · 超时复原
      //   （armed 视觉参照仓内 projects.js armTwoStepConfirm 口径）
      const archRowBtn = el("button", { type: "button", class: "ghostbtn-mini", title: ARCH_ROW_BTN_TITLE, text: ARCH_BTN_TEXT });
      let archArmed = false;
      let archArmTimer = null;
      const disarmArch = () => {
        archArmed = false;
        if (archArmTimer) { clearTimeout(archArmTimer); archArmTimer = null; }
        archRowBtn.textContent = ARCH_BTN_TEXT;
        archRowBtn.classList.remove("armed");
        archRowBtn.style.color = "";
        archRowBtn.style.background = "";
      };
      archRowBtn.addEventListener("click", (e) => {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        if (archArmed) {          // 二点 → 执行归档
          disarmArch();
          archiveSession(s, dispName);   // #40：主列表展示名同步进归档条目
          return;
        }
        archArmed = true;
        archRowBtn.textContent = ARCH_ARM_TEXT;
        archRowBtn.classList.add("armed");
        archRowBtn.style.color = "#ff9a9a";
        archRowBtn.style.background = "#1a1212";
        archArmTimer = setTimeout(disarmArch, ARCH_ARM_MS + 100);
      });
      item.appendChild(archRowBtn);
      item.addEventListener("mouseenter", () => { renameBtn.style.opacity = "1"; });
      item.addEventListener("mouseleave", () => { renameBtn.style.opacity = "0"; });
      item.addEventListener("click", () => { switchToSession(s.id); });
      sessList.appendChild(item);
    }
  }

  // ---------- #22 续写：点会话行 → 载入该会话全部消息 + 设为当前会话 ----------
  //   （原只读回看弹层退役：点行主行为 = 切回该会话继续聊；引擎侧同 session_id 续写）
  async function switchToSession(id) {
    if (!id) return;
    setInputDisabled(true);                       // loading 态：输入区禁用
    const loading = el("div", { class: "ai-loading inh", style: "padding:14px;text-align:center", text: t("ai.sess.loading") });
    msgs.appendChild(loading);
    try {
      const detail = await getSessionDetail(id);
      if (typeof document === "undefined") return;   // 视图已卸载（挂起响应丢弃·同 renderSessions 口径）
      if (!detail.ok) {
        showToast("error", t("ai.sess.loadFail", { reason: _describeChatError(detail.error) }));
        return;
      }
      const list = (detail.session && Array.isArray(detail.session.messages)) ? detail.session.messages : [];
      // 批2：消息序 = 会话内原始序 → msgKey "<序>:<角色>"（编辑覆盖层按此对应）
      renderSessionMessages(id, list);
      renderVisibility(getSessionVisibility(storage, id));   // #46 批7 G1：可见性指示随会话回看
      persistSessionId(id);        // 写会话键（刷新后仍在该会话）
      restoreSessionId();          // 同步模块内存态 → 后续 send 进同一会话
      renderSessions();            // 行高亮跟随当前会话
    } finally {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      setInputDisabled(false);
    }
  }

  // ---------- #22 会话改名：行内 ✎ → 输入框（值=当前名）→ Enter 保存 / ESC 取消 ----------
  function startRename(item, s, meta) {
    while (item.firstChild) item.removeChild(item.firstChild);
    const input = el("input", {
      type: "text",
      value: (meta && meta.name) || "",
      placeholder: t("ai.rename.ph"),
      style: "flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:3px 6px;color:var(--txt);font-size:12px;outline:none",
    });
    item.appendChild(input);
    const finish = (save) => {
      if (save) setSessionMeta(storage, s.id, { name: String(input.value || "").trim() });  // 空名 = 删字段 = 恢复默认
      renderSessions();
    };
    input.addEventListener("click", (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { if (typeof e.preventDefault === "function") e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { if (typeof e.preventDefault === "function") e.preventDefault(); finish(false); }
    });
  }

  // ---------- #22 关联项目指令：^关联(到)?项目[:：]?s*(.+)$ → 不发引擎·不产气泡 ----------
  function handleAssociateCommand(query) {
    const q = String(query || "").trim();
    if (!q) return false;
    const sid = getCurrentSessionId();
    if (!sid) {
      showToast("warn", t("ai.assoc.noSession"));
      return false;
    }
    const projects = listProjects();
    let hit = projects.find((p) => p && p.name === q) || null;          // 精确命中
    if (!hit) {
      const fuzzy = projects.filter((p) => p && typeof p.name === "string" && p.name.includes(q));
      if (fuzzy.length === 1) hit = fuzzy[0];                          // 模糊唯一命中才算
    }
    if (!hit) {
      const names = projects.map((p) => p && p.name).filter(Boolean).slice(0, 3);
      showToast("warn", t("ai.assoc.notFound", { name: q }) + (names.length ? t("ai.assoc.existing", { names: names.join("/") }) : ""));
      return false;
    }
    setSessionMeta(storage, sid, { projectId: hit.id });
    renderSessions();                                                // 行标签刷新
    showToast("success", t("ai.assoc.done", { name: hit.name }));
    return true;
  }


  // ---------- #22 新会话项目选择条（ZCode 同款：右栏输入区上方行内展开·不遮消息流） ----------
  //   首行 = 关联项目（#39 摘自动绑定：默认不预选·仅面板内显式选择）+「开始」· 下方 = 项目列表（搜索）+「＋新建项目」+「不关联项目」+「取消」
  //   选完才创建新会话（现有占位项逻辑）；引擎建会话后把 pendingProjectId 写进元数据
  //   挂靠批：新建项目输入框不得被重渲打断（焦点保持）· 创建成功后自动选中新项目并保持展开
  function openNewSessionPanel() {
    closeNewSessionPanel();
    const panel = el("div", {
      id: "aiNewSessionPanel",
      class: "ai-newpanel",
      style: "flex:0 0 auto;width:100%;box-sizing:border-box;margin:0 10px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);padding:6px 8px;display:flex;flex-direction:column;gap:6px;max-height:38vh;overflow:auto",
    });
    // 选中态（#39 摘自动绑定：默认空选·不读 currentPid()——会话项目唯一来源 = 面板显式选择；
    //   新建项目成功后自动选中新项目）
    let selectedId = "";
    let selectedName = "";
    // ① 首行：面板所选关联项目 + 「开始」
    const startRow = el("div", { style: "display:flex;align-items:center;gap:8px" });
    const startLabel = el("span", {
      style: "flex:1;min-width:0;font-size:12px;color:var(--txt2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      text: selectedName ? t("ai.panel.assocTo", { name: selectedName }) : t("ai.panel.noAssoc"),
    });
    const btnStart = el("button", { type: "button", class: "prim", text: t("ai.panel.start") });
    btnStart.addEventListener("click", () => { createNewSession(selectedId); });
    startRow.appendChild(startLabel);
    startRow.appendChild(btnStart);
    panel.appendChild(startRow);
    // ② 项目列表（可滚动 + 搜索过滤）
    const search = el("input", {
      type: "text",
      placeholder: t("ai.panel.searchPh"),
      style: "width:100%;box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 6px;color:var(--txt);font-size:12px;outline:none",
    });
    const listBox = el("div", {
      id: "aiNewSessionProjList",
      style: "max-height:140px;overflow:auto;display:flex;flex-direction:column;gap:4px",
    });
    const renderProjList = () => {
      while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
      const kw = String(search.value || "").trim();
      const all = listProjects().filter((p) => p && !p.deletedAt);
      // #44：updatedAt 倒序（最新置顶·比较口径同 store.latestProjectId）+ 上限 200（容器可滚动·不再静默截断）
      const hits = all.filter((p) => !kw || (typeof p.name === "string" && p.name.includes(kw)))
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      for (const p of hits.slice(0, 200)) {
        const b = el("button", { type: "button", class: "ghostbtn", style: "text-align:left", text: p.name });
        b.addEventListener("click", () => { createNewSession(p.id); });
        listBox.appendChild(b);
      }
      if (hits.length === 0) {
        listBox.appendChild(el("div", { class: "inh", style: "font-size:12px", text: kw ? t("ai.panel.noMatch") : t("ai.panel.noProjects") }));
      }
    };
    search.addEventListener("input", renderProjList);
    panel.appendChild(search);
    panel.appendChild(listBox);
    renderProjList();
    _projListRerender = renderProjList;   // #44 后半 B3：跨窗口同步重渲钩子（closeNewSessionPanel 摘除）
    // ③ 列表底：＋ 新建项目（行内输入 → store 同链创建 → 自动选中·面板保持展开可「开始」）
    const newRow = el("div", { style: "display:flex;align-items:center;gap:6px" });
    const newInput = el("input", {
      type: "text",
      placeholder: t("ai.panel.newNamePh"),
      style: "flex:1;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 6px;color:var(--txt);font-size:12px;outline:none",
    });
    const newBtn = el("button", { type: "button", class: "fbtn", text: t("ai.panel.newBtn") });
    newBtn.addEventListener("click", () => {
      const nm = String(newInput.value || "").trim();
      if (!nm) { showToast("warn", t("ai.panel.nameRequired")); return; }
      const proj = createProject(nm);      // 与首页新建同链（store 侧建 + 落库）
      storeSave(proj);
      // 自动选中新项目 · 面板保持展开（可再点「开始」建会话）· 输入框不重建（焦点不丢）
      selectedId = proj.id;
      selectedName = proj.name;
      startLabel.textContent = t("ai.panel.assocTo", { name: proj.name });
      newInput.value = "";
      renderProjList();
    });
    newRow.appendChild(newInput);
    newRow.appendChild(newBtn);
    panel.appendChild(newRow);
    // ④ 不关联项目 · 取消
    const noneBtn = el("button", { type: "button", class: "fbtn", text: t("ai.panel.noneBtn") });
    noneBtn.addEventListener("click", () => { createNewSession(""); });
    const footRow = el("div", { style: "display:flex;align-items:center;gap:8px" });
    footRow.appendChild(noneBtn);
    const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
    cancelBtn.addEventListener("click", () => { closeNewSessionPanel(); });
    footRow.appendChild(cancelBtn);
    panel.appendChild(footRow);
    // 挂右栏输入区上方（.ai-r 内 · .ai-input 之前 —— 不与输入框同一行·不遮消息流）
    _newPanel = panel;
    _insertBefore(input, panel);
  }

  function closeNewSessionPanel() {
    if (_newPanel && _newPanel.parentNode) _newPanel.parentNode.removeChild(_newPanel);
    _newPanel = null;
    _projListRerender = null;
  }

  // 创建新会话（现有占位项逻辑）· projectId 记在 pending（引擎建会话后写入元数据）
  function createNewSession(projectId) {
    closeNewSessionPanel();
    pendingProjectId = projectId || "";
    startNewSession();
  }

  // ---------- 折叠归档区（:1704-1706 · 批 R5 B-1 ① 自设置页迁回） ----------
  const arch = el("div", { class: "ai-arch", id: "aiArch" });
  const cap = el("span", { id: "aiArchCap" });
  const chev = el("span", { id: "aiArchChev", style: "margin-left:auto", text: "▸" });
  const hd = el("div", { class: "ai-arch-hd", title: ARCH_HD_TITLE }, [cap, chev]);
  const bd = el("div", { class: "ai-arch-bd", id: "aiArchBd" });
  arch.appendChild(hd);
  arch.appendChild(bd);
  left.appendChild(arch);
  hd.addEventListener("click", () => {
    const open = arch.classList.toggle("open");
    chev.textContent = open ? "▾" : "▸"; // 原型 aiArchToggle（:6550-6556）
  });

  function buildArchRow(it, items) {
    const row = el("div", { class: "ai-arch-row", "data-id": it.id });
    row.appendChild(el("div", { class: "ai-arch-meta" }, [
      el("span", { class: "ai-arch-title", text: it.title || t("ai.arch.unnamed") }),   // #92 B5：入典（B4 遗留登记闭环·纯显示兜底不写盘）
      el("span", { class: "ai-arch-sub", text: it.turns > 0 ? t("ai.arch.subTurns", { date: _formatDate(it.createdAt), turns: it.turns }) : t("ai.arch.subDash", { date: _formatDate(it.createdAt) }) }),   // #40：真实消息量·旧条目 0/缺失显示 —
    ]));
    const ops = el("div", { class: "ai-arch-ops" });
    // 恢复 = 真恢复（#25）：移出本地归档 → 主列表刷新 → 会话回列表（全程无 toast）
    const btnRestore = el("button", { type: "button", class: "ghostbtn-mini", text: t("projects.recycle.restore") });
    btnRestore.addEventListener("click", () => {
      const got = restoreFromArchive(items, it.id);
      if (!got) return;                       // 未找到该归档项（静默）
      saveArchive(storage, removeFromArchive(items, it.id));
      renderArchive();
      renderSessions();                       // 会话回主列表
    });
    ops.appendChild(btnRestore);
    // 删除 = 3s 两次确认 + 写回 localStorage（C-3 通道）
    const btnDel = el("button", { type: "button", class: "dangerbtn-mini", text: t("settings.btn.delete") });
    let delSt = _makeDelState();
    btnDel.addEventListener("click", () => {
      delSt = _tickDelState(delSt);
      if (delSt.phase === "armed") {
        btnDel.textContent = t("ai.arch.delArm");
        btnDel.classList.add("armed");
      } else if (delSt.phase === "confirmed") {
        const next = removeFromArchive(items, it.id);
        saveArchive(storage, next);
        showToast("info", t("ai.arch.delDone", { title: it.title }));
        renderArchive();
      } else {
        btnDel.textContent = t("settings.btn.delete");
        btnDel.classList.remove("armed");
        showToast("info", t("ai.arch.delTimeout"));
      }
    });
    ops.appendChild(btnDel);
    row.appendChild(ops);
    return row;
  }

  function renderArchive() {
    const items = loadArchive(storage);
    cap.textContent = t("ai.arch.cap", { n: items.length }); // 原型 :1705 逐字格式
    while (bd.firstChild) bd.removeChild(bd.firstChild);
    if (items.length === 0) {
      bd.appendChild(el("div", { class: "inh", style: "font-size:12px", text: t("ai.arch.empty") })); // 原型 :6544
      return;
    }
    for (const it of items) bd.appendChild(buildArchRow(it, items));
  }

  // ---------- 项目 ↔ AI 互导区（:1708-1711 · B6-T5 A5 三按钮接真） ----------
  const interflow = el("div", { class: "inh", style: "font-size:12px;margin-top:12px;line-height:1.8" });
  interflow.appendChild(document.createTextNode(INTERFLOW_TITLE));
  interflow.appendChild(document.createElement("br"));
  const btnExport = el("span", { class: "fbtn", id: "aiExportBtn", style: "margin-top:6px;display:inline-block", text: t("ai.export.btn") });
  const btnImport = el("span", { class: "fbtn", id: "aiImportBtn", text: t("ai.import.btn") });
  // v2-4: 「应用到分镜表」互导区常驻（不嵌消息气泡; T5 接真写入器）
  const btnApply = el("span", { class: "fbtn", id: "aiApplyBtn", text: t("ai.apply.btn") });
  interflow.appendChild(btnExport);
  interflow.appendChild(btnImport);
  interflow.appendChild(btnApply);

  // 当前项目 id（采纳链同源·#62：① opts.projectId（#/ai?p= 显式互导落点·最高）→
  //   ② 当前会话绑定项目（#39 会话绑定为主源·读 sessionMeta）→
  //   ③ hash 兜底（项目页进入保留）。会话无绑定/无会话时 ② 跳过）
  function currentPid() {
    if (opts.projectId) return opts.projectId;
    const bound = sessionBoundProjectId();
    if (bound) return bound;
    const hash = (typeof opts.hash === "string")
      ? opts.hash
      : ((typeof globalThis !== "undefined" && globalThis.location && typeof globalThis.location.hash === "string")
        ? globalThis.location.hash
        : "");
    return projectIdFromHash(hash);
  }

  // ---- 导出面板（legacy :169-214 取码适配）: guide + 只读文本框 + 复制/下载（首导出后显示;
  //      初始隐藏走 style 赋值——setAttribute("style") 串在测试桩/部分环境不反映到 .style） ----
  const exportGuide = el("div", {
    id: "aiExportGuide",
    style: "font-size:11px;color:var(--txt3);background:var(--panel2);padding:6px 8px;border:1px solid var(--line);border-radius:6px;margin-top:6px;white-space:pre-wrap;word-break:break-all",
  });
  const exportTa = el("textarea", {
    id: "aiExportTa",
    rows: "6",
    readonly: "",
    placeholder: t("ai.export.ph"),
    style: "width:100%;box-sizing:border-box;font:11px/1.5 ui-monospace,Consolas,monospace;background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:6px;margin-top:6px;padding:6px 8px;resize:vertical;min-height:80px;max-height:280px",
  });
  const btnCopy = el("span", { class: "fbtn", id: "aiExportCopy", style: "margin-top:6px;display:inline-block", text: t("ai.export.copy") });
  const btnDl = el("span", { class: "fbtn", id: "aiExportDl", text: t("ai.export.dl") });
  exportGuide.style.display = "none";
  exportTa.style.display = "none";
  interflow.appendChild(exportGuide);
  interflow.appendChild(exportTa);
  interflow.appendChild(btnCopy);
  interflow.appendChild(btnDl);

  // ---- 导入面板: 原生文件选择 input（F43 形态甲·粘贴框退役·不暴露 JSON 形态）+ errors 红字框（legacy :324-340 取码适配） ----
  // F43 形态甲: 粘贴 textarea 整体退役 → 只留 input[type=file]（隐藏·可见入口唯一＝「从 AI 导入」按钮）;
  //   隐藏走 style 赋值——setAttribute("style") 串在测试桩/部分环境不反映到 .style（同 exportTa 先例）
  const importFile = el("input", {
    id: "aiImportFile",
    type: "file",
    accept: ".txt,.json",
  });
  importFile.style.display = "none";
  const importErr = el("div", {
    id: "aiImportErr",
    style: "color:#ff6464;font-size:11px;background:rgba(255,80,80,.08);padding:6px 8px;border:1px solid #803030;border-radius:6px;margin-top:6px;white-space:pre-wrap;word-break:break-all",
  });
  importErr.style.display = "none";
  interflow.appendChild(importFile);
  interflow.appendChild(importErr);
  left.appendChild(interflow);

  // ============================================================================
  // B6-T5 导出链: pid 守卫 → projectToSnapshot（fetchSubmitPoolContext 注入）→ #41 →
  //   guide + data 文本框（信封铁律 B-3: 只序列化内层 data）
  // ============================================================================
  let exporting = false;
  btnExport.addEventListener("click", async () => {
    if (exporting) return;
    const project = currentPid() ? storeLoad(currentPid()) : null;
    if (!project) {
      showToast("error", EXPORT_NO_PROJECT);
      return;
    }
    exporting = true;
    btnExport.textContent = t("ai.export.busy");
    try {
      const snap = await projectToSnapshot(project, {
        fetchPoolContext: fetchSubmitPoolContext,
        storage,
        listAssets,
      });
      const r = await exportSnapshot(snap);
      if (!r.ok) {
        showToast("error", t("ai.export.fail", { reason: (r.error && (r.error.msg || r.error.code)) || t("settings.err.unknown") }));
        return;
      }
      exportGuide.textContent = r.guide || "";
      exportTa.value = r.data ? JSON.stringify(r.data) : "";
      exportGuide.style.display = "";
      exportTa.style.display = "";
      showToast("success", t("ai.export.done"));
    } finally {
      exporting = false;
      btnExport.textContent = t("ai.export.btn");
    }
  });

  // 复制（clipboard 优先; 权限被拒/不可用 → execCommand 兜底·legacy :455-469 取码）
  btnCopy.addEventListener("click", async () => {
    const text = exportTa.value || "";
    if (!text) {
      showToast("warn", t("ai.copy.none"));
      return;
    }
    let viaClipboard = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        viaClipboard = true;
      }
    } catch (_e) { /* 权限拒绝/非手势调用 → execCommand 兜底 */ }
    if (viaClipboard) {
      showToast("success", t("ai.copy.done"));
      return;
    }
    try {
      if (typeof exportTa.select === "function") exportTa.select();
      const ok = typeof document !== "undefined" && typeof document.execCommand === "function" && document.execCommand("copy");
      if (ok) showToast("success", t("ai.copy.done"));
      else showToast("warn", t("ai.copy.unavailable"));
    } catch (e) {
      showToast("error", t("ai.copy.fail", { reason: (e && e.message) ? e.message : String(e) }));
    }
  });

  // 下载 .txt（Blob 落盘·legacy :472-488 取码）
  btnDl.addEventListener("click", () => {
    const text = exportTa.value || "";
    if (!text) {
      showToast("warn", t("ai.dl.none"));
      return;
    }
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai_snapshot_" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast("error", t("ai.dl.fail", { reason: (e && e.message) ? e.message : String(e) }));
    }
  });

  // ============================================================================
  // B6-T5 导入链: 选文件（读文本）→ #42 {text} → ok:false errors 红字透传 → ok → 确认框（CSV 先例）
  //   → snapshotToStore 整体替换 + storeSave（applyCsvImport 同款形态）
  // ============================================================================
  let importing = false;
  // F43 形态甲: 选中文件 = 读文本 → 复用 importSnapshot(text) 原链; 取消选择（无文件）= 无操作
  importFile.addEventListener("change", async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    let text;
    try {
      text = String(await file.text() || "").trim();
    } catch (_e) {
      showToast("error", t("ai.import.readFail")); // 读盘失败（文件被移走/无权限）·不入链
      return;
    }
    importing = true;
    btnImport.textContent = t("ai.import.busy");
    try {
      const r = await importSnapshot(text);
      if (!r.ok) {
        importErr.textContent = (r.errors || [t("ai.import.fail")]).join("\n");
        importErr.style.display = "";
        return;
      }
      if (!r.data || typeof r.data !== "object") {
        importErr.textContent = t("ai.import.badShape");
        importErr.style.display = "";
        return;
      }
      const rows = Array.isArray(r.data.shots) ? r.data.shots.filter((s) => s && typeof s === "object").length : 0;
      if (rows === 0) {
        importErr.textContent = t("ai.import.noRows");
        importErr.style.display = "";
        return;
      }
      const pid = currentPid();
      if (!pid || !storeLoad(pid)) {
        showToast("error", SHOTGEN_NO_PROJECT);
        return;
      }
      const warnNote = r.warnings.length ? t("ai.import.warnNote", { list: r.warnings.join("；") }) : "";
      openConfirmModal({
        title: t("ai.import.btn"),
        sub: t("ai.imp.confirmWrap", { base: IMPORT_CONFIRM_SUB, rows: String(rows), note: warnNote }),
        confirmText: t("shell.csv.confirm"),
        onConfirm: () => {
          const project = storeLoad(pid);
          if (!project) return;
          const wr = snapshotToStore(r.data, project);
          if (!wr.ok) {
            showToast("error", t("ai.import.applyFail", { reason: wr.reason }));
            return;
          }
          storeSave(project);
          importErr.textContent = "";
          importErr.style.display = "none";
          showToast("success", t("ai.import.done", { n: wr.rows }));
        },
      });
    } finally {
      importing = false;
      btnImport.textContent = t("ai.import.btn");
    }
  });

  // 「从 AI 导入」唯一行为＝弹文件选择器（选中→上方 change 链; 取消 = 无操作）
  btnImport.addEventListener("click", () => {
    if (importing) return;
    importFile.value = ""; // 清上次选择：value 未变则 change 不触发（同一文件可重复导入）
    importFile.click();
  });

  // ============================================================================
  // B6-T5 应用链: 会话 snapshot（currentSessionId → getSessionDetail.session.snapshot, 无 →
  //   白话 toast）→ 同确认框 → 同一 snapshotToStore 写入器（数据源不同·写入器复用）
  // ============================================================================
  let applying = false;
  btnApply.addEventListener("click", async () => {
    if (applying) return;
    applying = true;
    btnApply.textContent = t("ai.apply.reading");
    try {
      const sid = getCurrentSessionId();
      if (!sid) {
        showToast("info", APPLY_NO_SNAPSHOT);
        return;
      }
      const detail = await getSessionDetail(sid);
      if (!detail.ok) {
        showToast("error", t("ai.sess.loadFail", { reason: _describeChatError(detail.error) }));
        return;
      }
      const snap = detail.session && detail.session.snapshot;
      if (!snap || typeof snap !== "object" || !Array.isArray(snap.shots) || snap.shots.length === 0) {
        showToast("info", APPLY_NO_SNAPSHOT);
        return;
      }
      const pid = currentPid();
      if (!pid || !storeLoad(pid)) {
        showToast("error", SHOTGEN_NO_PROJECT);
        return;
      }
      const rows = snap.shots.filter((s) => s && typeof s === "object").length;
      openConfirmModal({
        title: t("ai.apply.btn"),
        sub: t("ai.apply.confirmWrap", { base: IMPORT_CONFIRM_SUB, rows: String(rows) }),
        confirmText: t("shell.csv.confirm"),
        onConfirm: () => {
          const project = storeLoad(pid);
          if (!project) return;
          const wr = snapshotToStore(snap, project);
          if (!wr.ok) {
            showToast("error", t("ai.apply.fail", { reason: wr.reason }));
            return;
          }
          storeSave(project);
          showToast("success", t("ai.apply.done", { n: wr.rows }));
        },
      });
    } finally {
      applying = false;
      btnApply.textContent = t("ai.apply.btn");
    }
  });

  // ---------- 右栏：消息流 + checks 条（:832-859 取码容器）+ 建议表（T4）+ 模型行 + 输入区 ----------
  // 体验修复 A4：msgs min-height:0 → flex:1 的滚动区才真正可滚（否则被内容高度顶开）
  const msgs = el("div", { class: "ai-msgs", style: "min-height:0" });
  const checks = el("div", { class: "ai-checks", id: "aiChecks" });
  // #46 批7 G1：AI 可见性指示（持久态·挂 checks 容器内·与即时蓝条同区·不随消息滚动）
  //   旧引擎无新字段 → 隐藏（不显示·不虚报）
  const visBox = el("div", {
    id: "aiVisibility", class: "ai-visibility",
    style: "display:none;margin:0 0 4px;padding:4px 8px;font-size:11px;line-height:1.6;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--txt2)",
  });
  visBox.style.display = "none";
  checks.appendChild(visBox);
  right.appendChild(msgs);
  right.appendChild(checks);

  // 渲染可见性指示（无快照 → 隐藏；降级档追加提示行）
  function renderVisibility(vis) {
    while (visBox.firstChild) visBox.removeChild(visBox.firstChild);
    if (!vis || !vis.text) { visBox.style.display = "none"; return; }
    visBox.style.display = "block";
    visBox.appendChild(el("div", { class: "ai-visibility-text", text: vis.text }));
    if (vis.floor) {
      visBox.appendChild(el("div", {
        class: "ai-visibility-floor", text: t("ai.vis.floor"), style: "margin-top:2px;color:#e8b339",
      }));
    }
  }

  // ---------- 智能拆镜建议表（T4 · 默认隐藏 · 位于 msgs 与输入区之间） ----------
  const suggWrap = el("div", {
    id: "aiShotgen",
    class: "ai-shotgen",
    style: "margin:0 10px 8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);font-size:12px",
  });
  suggWrap.appendChild(el("div", { style: "font-weight:700;margin-bottom:6px;color:var(--txt)", text: SHOTGEN_TITLE }));
  const suggHead = el("div", {
    style: "display:grid;grid-template-columns:22px 2fr 90px 56px;gap:4px;padding:3px 4px;font-weight:600;color:var(--txt2);border-bottom:1px solid var(--line)",
  });
  ["", t("ai.sugg.colDesc"), t("seg.f.move"), t("ai.sugg.colDur")].forEach((h) => suggHead.appendChild(el("span", { text: h })));
  suggWrap.appendChild(suggHead);
  const suggBody = el("div", { id: "aiShotgenBody", style: "max-height:240px;overflow:auto" });
  suggWrap.appendChild(suggBody);
  const suggFoot = el("div", { style: "display:flex;justify-content:flex-end;margin-top:6px" });
  const adoptBtn = el("button", { type: "button", class: "ghostbtn", id: "aiShotgenAdopt", text: t("ai.adopt.count", { n: 0 }) });
  suggFoot.appendChild(adoptBtn);
  suggWrap.appendChild(suggFoot);
  right.appendChild(suggWrap);

  // 消息流：无示例对话 fixture（v2-4 退役）· 无空态引导节点（#24 需求2 整行移除·右栏留白）
  function clearMsgs() { while (msgs.firstChild) msgs.removeChild(msgs.firstChild); msgSeq = 0; }

  // #22-10：切回时上一条回复还没落库（生成中）→ 消息区轻提示（不是错误·不阻断发送）
  function showPendingReplyHint() {
    if (msgs.querySelector(".ai-pending-hint")) return;
    msgs.appendChild(el("div", {
      class: "ai-pending-hint inh",
      style: "font-size:12px;padding:6px 8px",
      text: t("ai.pendingReply.hint"),
    }));
  }

  // ---------- #22 批2：消息编辑（本地覆盖层 · 用户/AI 两边都能改 · 不写引擎） ----------
  //   msgKey = "<会话内原始消息序>:<角色>"（如 "0:user"）→ 覆盖层存 gui13.ai.sessionMeta[sessionId].edited
  //   管道：stripHiddenBlocks（剥隐藏规范块+项目上下文块）→ edited 覆盖（本地优先）→ 渲染
  function effectiveText(content, msgKey, sessionId) {
    let s = stripHiddenBlocks(typeof content === "string" ? content : String(content == null ? "" : content));
    if (msgKey) {
      const ed = getEditedText(storage, sessionId || getCurrentSessionId(), msgKey);
      if (ed) s = ed;                       // 本地编辑版优先
    }
    return s;
  }

  // 气泡构造（legacy _appendBubble :442-472 取码: assistant 的 <think> 折叠成 details）
  //   批2：正文拆 .ai-msg-body + 悬停显 ✎ 编辑钮（DOM 子节点）
  //   #47 改错：✎/✕ 两钮成组（.ai-msg-ops）挂气泡右下方·气泡底部预留空间（MSG_OPS_RESERVE）
  function buildBubble(role, content, msgKey, sessionId) {
    const bubble = el("div", {
      class: role === "user" ? "msg u" : "msg a",
      style: "position:relative;" + (msgKey ? MSG_OPS_RESERVE : ""),
    });
    fillBubble(bubble, role, content, msgKey, sessionId);
    if (msgKey) {   // 悬停显编辑/删除钮（重渲染时复用同一对监听·不重复挂）
      bubble.addEventListener("mouseenter", () => {
        if (bubble.__editBtn) bubble.__editBtn.style.opacity = "1";
        if (bubble.__delBtn) bubble.__delBtn.style.opacity = "1";
      });
      bubble.addEventListener("mouseleave", () => {
        if (bubble.__editBtn) bubble.__editBtn.style.opacity = "0";
        if (bubble.__delBtn) bubble.__delBtn.style.opacity = "0";
      });
    }
    return bubble;
  }

  // 填气泡内容（正文 + 操作钮组）——重建/编辑保存后共用同一口径
  function fillBubble(bubble, role, content, msgKey, sessionId) {
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    let shown = effectiveText(content, msgKey, sessionId);
    if (role !== "user") {
      const m = shown.match(/<think>([\s\S]*?)<\/think>/);
      if (m) {
        const summary = (m[1] || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const details = el("details", { style: "font-size:11px;color:#999;margin-bottom:4px" });
        details.appendChild(el("summary", { style: "cursor:pointer;user-select:none", text: t("ai.think.label", { summary }) }));
        details.appendChild(el("div", { style: "white-space:pre-wrap;word-break:break-word;margin-top:2px", text: m[1] || "" }));
        bubble.appendChild(details);
        shown = shown.replace(/<think>[\s\S]*?<\/think>/, "").trim();
      }
    }
    bubble.appendChild(el("div", { class: "ai-msg-body", style: "white-space:pre-wrap;word-break:break-word", text: shown }));
    if (msgKey) {
      const ops = el("div", { class: "ai-msg-ops", style: MSG_OPS_STYLE });   // #47 改错：两钮成组·挂气泡右下方
      const btn = makeEditBtn(bubble, role, content, msgKey, sessionId);
      bubble.__editBtn = btn;
      const del = makeDelBtn(msgKey, sessionId);   // #47：悬停显删除钮
      bubble.__delBtn = del;
      ops.appendChild(btn);
      ops.appendChild(del);
      bubble.appendChild(ops);
    } else {
      bubble.__editBtn = null;
      bubble.__delBtn = null;
    }
  }

  // 编辑钮（✎·悬停显）——点开行内 textarea（独立类名·不与采纳钮 ghostbtn-mini 混）
  //   #47 改错：定位交给外层钮组 .ai-msg-ops（钮自身不再绝对定位到气泡顶部左右）
  function makeEditBtn(bubble, role, content, msgKey, sessionId) {
    const btn = el("button", {
      type: "button",
      class: "ai-msg-edit",
      title: t("ai.msg.editTitle"),
      text: "✎",
      style: "opacity:0;padding:0 5px;font-size:11px;line-height:1.3;"
        + "border:1px solid var(--line);border-radius:6px;color:var(--txt2);cursor:pointer;background:var(--panel2);",
    });
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "0"; });
    btn.addEventListener("click", (e) => {
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      startEditBubble(bubble, role, content, msgKey, sessionId);
    });
    return btn;
  }

  // #47 删除钮（✕·悬停显）→ 确认弹窗（两步确认防误触·danger 红钮=确认件·对齐仓内 openConfirm 形态）
  //   #47 改错：定位交给外层钮组 .ai-msg-ops（钮自身不再绝对定位到气泡顶部左右）
  function makeDelBtn(msgKey, sessionId) {
    const btn = el("button", {
      type: "button",
      class: "ai-msg-del",
      title: t("ai.msg.delTitle"),
      text: "✕",
      style: "opacity:0;padding:0 5px;font-size:11px;line-height:1.3;"
        + "border:1px solid var(--line);border-radius:6px;color:var(--txt2);cursor:pointer;background:var(--panel2);",
    });
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "0"; });
    btn.addEventListener("click", (e) => {
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      confirmDeleteMessage(msgKey, sessionId);
    });
    return btn;
  }

  // #47 两步确认第一步：点 ✕ → 确认弹窗（文案逐字=DEL_MSG_CONFIRM_TEXT）；确认才发 DELETE，取消=无操作
  function confirmDeleteMessage(msgKey, sessionId) {
    const m = /^(\d+):/.exec(String(msgKey || ""));
    const idx = m ? Number(m[1]) : -1;
    if (idx < 0) return;
    openConfirmModal({
      title: t("ai.msg.delConfirmTitle"),
      sub: DEL_MSG_CONFIRM_TEXT,
      danger: true,
      confirmText: t("ui.modal.confirmDelete"),
      onConfirm: () => { deleteMessage(idx, sessionId || getCurrentSessionId()); },
    });
  }

  // #47 确认后执行：DELETE → 成功按回传清单重键编辑覆盖层 + 重建消息区（下一条发送走既有链·
  //   引擎侧已是删后清单）；失败（404/网络）→ toast 人话 + 本地不动
  async function deleteMessage(idx, sid) {
    const r = await deleteSessionMessage(sid, idx);
    if (typeof document === "undefined") return;   // 视图已卸载（挂起响应丢弃·同 renderSessions 口径）
    if (!r.ok) {
      showToast("error", t("ai.msg.delFail", { reason: _describeChatError(r.error) }));
      return;
    }
    const meta = loadSessionMeta(storage);
    const oldEdited = (meta[sid] && meta[sid].edited) || {};
    replaceSessionEdits(storage, sid, rekeyEditedOverlay(oldEdited, idx, r.messages));
    renderSessionMessages(sid, r.messages);
  }

  // 点 ✎ → 行内 textarea（值=当前显示文本）→ Ctrl+Enter 保存 / ESC 取消（空文本=恢复原文）
  function startEditBubble(bubble, role, content, msgKey, sessionId) {
    if (!bubble || bubble.querySelector(".ai-msg-edit-ta")) return;   // 已在编辑态
    const cur = effectiveText(content, msgKey, sessionId);
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    const ta = el("textarea", {
      class: "ai-msg-edit-ta",
      style: "width:100%;box-sizing:border-box;min-height:64px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:13px;padding:6px;resize:vertical;outline:none",
    });
    ta.value = cur;
    bubble.appendChild(ta);
    bubble.appendChild(el("div", { class: "inh", style: "font-size:11px;margin-top:4px", text: t("ai.msg.editHint") }));
    const finish = (save) => {
      const val = ta.value;
      if (save) setSessionEdit(storage, sessionId || getCurrentSessionId(), msgKey, val);
      rerenderBubble(bubble, role, content, msgKey, sessionId);
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        finish(true);
        return;
      }
      if (e.key === "Escape") {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        finish(false);
      }
    });
  }

  // 编辑保存/取消后：气泡就地重渲染（编辑版优先）+ 采纳钮按当前文本重挂
  function rerenderBubble(bubble, role, content, msgKey, sessionId) {
    fillBubble(bubble, role, content, msgKey, sessionId);
    maybeAddReplyAdopt(bubble, role, effectiveText(content, msgKey, sessionId));
  }

  function appendBubble(role, content, msgKey, sessionId) {
    if (typeof document === "undefined") return null;   // 视图已卸载（挂起响应丢弃·同 renderSessions 口径）
    const key = msgKey || ((msgSeq++) + ":" + role);
    const bubble = buildBubble(role, content, key, sessionId);
    msgs.appendChild(bubble);
    maybeAddReplyAdopt(bubble, role, effectiveText(content, key, sessionId));
    msgs.scrollTop = msgs.scrollHeight;
    return bubble;
  }

  // #47：按清单重建消息区（切换会话/删除后共用同一口径）——msgKey "<序>:<角色>"·msgSeq 对齐
  //   （删除后按回传清单重渲·续发消息键接删后清单序号）
  function renderSessionMessages(id, list) {
    clearMsgs();
    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i] || {};
      const role = m.role || "user";
      appendBubble(role, m.content || "", i + ":" + role, id);
    }
    msgSeq = arr.length;
  }

  // ---------- #23：assistant 回复像分镜表（≥2 镜头段）→ 气泡下挂「采纳到分镜表」钮 ----------
  //   点选 → 复用智能拆镜建议表 UI（suggWrap/suggBody/adoptBtn）→ 采纳走既有 addSegment+updateSegment 链
  // ---------- #26：回复含【提示词】…【/提示词】 → 气泡下挂「采纳提示词」钮（与上者并存）
  function maybeAddReplyAdopt(bubble, role, content) {
    if (role === "user") return;
    // 约定标记命中 → 「采纳提示词」钮（先于启发式判定·两者可同屏）
    const promptBlocks = extractPromptBlocks(content);
    if (promptBlocks.length > 0) {
      const pBtn = el("button", {
        type: "button",
        class: "ghostbtn-mini",
        "data-adopt-prompt": "1",
        title: t("ai.adoptPrompt.title"),
        text: t("ai.adoptPrompt.btn"),
        style: "display:block;margin-top:6px",
      });
      pBtn.addEventListener("click", () => { openPromptSegmentPicker(promptBlocks.join("\n\n")); });
      bubble.appendChild(pBtn);
    }
    if (!isStrongShotTable(content)) return;   // #36 强特征门槛（普通编号列表不误挂采纳钮）
    const btn = el("button", {
      type: "button",
      class: "ghostbtn-mini",
      "data-adopt-reply": "1",
      title: t("ai.adopt.btnTitle"),
      text: t("ai.adopt.btn"),
      style: "display:block;margin-top:6px",
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const parsed = parseShotTableReply(content);
        if (parsed.length === 0) {
          showToast("warn", SHOTGEN_FAIL_TOAST);
          return;
        }
        showSuggestions(parsed, await fetchVocab());   // 复用智能拆镜建议表 UI
      } finally {
        btn.disabled = false;
      }
    });
    bubble.appendChild(btn);
  }

  // ---------- #26 段选择器：列出当前项目全部段 → 每段选「替换」/「追加」写入该段提示词 ----------
  //   写入走 store updateSegment + save 同款链（段卡/预览随之刷新）
  function openPromptSegmentPicker(promptText) {
    const pid = currentPid();
    const project = pid ? storeLoad(pid) : null;
    if (!project) {
      showToast("warn", NO_PROJECT_PROMPT_TOAST);
      return;
    }
    const segs = Array.isArray(project.segments) ? project.segments : [];
    const box = el("div", { style: "display:flex;flex-direction:column;gap:8px;max-height:56vh;overflow:auto" });
    if (segs.length === 0) {
      box.appendChild(el("div", { class: "inh", style: "font-size:12px", text: t("ai.picker.empty") }));
    }
    segs.forEach((seg, i) => {
      const row = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px",
      });
      const info = el("div", { style: "flex:1;min-width:0;font-size:12px;color:var(--txt2);line-height:1.6" });
      info.appendChild(el("div", { style: "color:var(--txt);font-weight:700", text: t("ai.picker.segN", { n: i + 1 }) }));
      info.appendChild(el("div", { text: _segmentPromptSummary(seg.prompt) }));
      info.appendChild(el("div", { text: t("ai.picker.curDur", { n: seg.durationSec != null ? seg.durationSec : 5 }) }));
      row.appendChild(info);
      const write = (mode) => {
        const cur = String(seg.prompt || "");
        const next = mode === "append" ? (cur ? cur + "\n" + promptText : promptText) : promptText;
        updateSegment(project, seg.id, { prompt: next });
        storeSave(project);
        showToast("success", t("ai.picker.doneFmt", { verb: mode === "append" ? t("ai.picker.appendedVerb") : t("ai.picker.replacedVerb"), n: i + 1 }));
        inst.close();
      };
      const btnRepl = el("button", { type: "button", class: "ghostbtn", text: t("ai.picker.replace") });
      btnRepl.addEventListener("click", () => { write("replace"); });
      const btnApp = el("button", { type: "button", class: "ghostbtn", text: t("ai.picker.append") });
      btnApp.addEventListener("click", () => { write("append"); });
      row.appendChild(btnRepl);
      row.appendChild(btnApp);
      box.appendChild(row);
    });
    const cancelBtn = el("button", { type: "button", class: "ghostbtn", text: t("ui.modal.cancel") });
    const inst = openModal({
      title: t("ai.picker.title"),
      sub: t("ai.picker.sub"),
      contentNode: box,
      footerButtons: [cancelBtn],
    });
    cancelBtn.addEventListener("click", () => { inst.close(); });
  }

  // checks 三色条（legacy _renderChecks :832-859 取码: warn 黄 / err 红 / trimmed 蓝）
  // #46 批7 G1：可见性指示为持久态 → clearChecks 只清三色条·保留指示节点（不清指示）
  function clearChecks() {
    const keep = (visBox.parentNode === checks) ? visBox : null;
    while (checks.firstChild) checks.removeChild(checks.firstChild);
    if (keep) checks.appendChild(keep);
  }
  function renderChecks(warns, errs, trimmed) {
    clearChecks();
    (warns || []).forEach((w) => checks.appendChild(el("div", {
      class: "ai-check warn",
      style: "background:rgba(232,179,57,.15);border:1px solid #e8b339;color:#e8b339;padding:4px 8px;border-radius:3px;margin-bottom:4px;font-size:11px",
      text: "⚠ " + String(w),
    })));
    (errs || []).forEach((e) => {
      const h = humanizeAiErr(e);
      const node = el("div", {
        class: "ai-check err",
        style: "background:rgba(255,80,80,.12);border:1px solid #803030;color:#ff6464;padding:4px 8px;border-radius:3px;margin-bottom:4px;font-size:11px",
        text: "✗ " + h.text,
      });
      if (h.mapped) node.setAttribute("title", h.raw);   // 原文（悬停可见）
      checks.appendChild(node);
    });
    if (typeof trimmed === "number" && trimmed > 0) {
      checks.appendChild(el("div", {
        class: "ai-check trimmed",
        style: "background:rgba(90,155,240,.10);border:1px solid #3a7dd8;color:#5a9bf0;padding:4px 8px;border-radius:3px;font-size:11px",
        text: t("ai.checks.trimmed", { n: trimmed }),
      }));
    }
  }

  // ---------- 模型下拉（#24 需求2/3 + 追加自绘：迁入输入框容器底部工具条·左·向上弹出） ----------
  //   自绘弹层：仓内 cbox 家族（.cbox 触发器 + .cbox-menu 浮层 + .co 选项）·
  //   原生 select 下拉方向由浏览器决定（页面底部会被视口裁切）→ 改为自绘·优先向上展开。
  const modelSel = el("div", {
    id: "aiModelSel",
    class: "cbox ai-msel",
    title: t("ai.model.title"),
    style: "flex:0 1 auto;max-width:240px;min-width:0",
  });
  const modelSelText = el("span", { class: "cb-v", text: MODEL_PLACEHOLDER });
  modelSel.appendChild(modelSelText);
  modelSel.appendChild(el("span", { class: "cb-a", text: "▾" }));
  let modelValue = "";        // 当前选中预设 name（空=未选）
  let modelDisabled = false;  // 发送/回灌期间禁用下拉
  let modelOptions = [];      // [{value,label}] 选项表（首项占位）

  // ---------- 输入区（#24 需求3：ZCode 同款——输入框容器内嵌底部工具条） ----------
  // 体验修复 A4：输入区固定不收缩，始终留在视口内
  const input = el("div", { class: "ai-input", style: "flex-shrink:0" });
  const box = el("div", {
    id: "aiInputBox",
    class: "ai-input-box",
    style: "width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;background:var(--panel2);overflow:hidden;display:flex;flex-direction:column",
  });
  const drag = el("span", {
    class: "ai-drag",
    id: "aiDrag",
    title: t("ai.input.dragTitle"),
    style: "border:0;border-bottom:1px solid var(--line);border-radius:0",
  });
  box.appendChild(drag);
  const ta = el("textarea", {
    id: "aiTa",
    rows: "3",
    placeholder: TA_PLACEHOLDER,
    style: TA_STYLE,
  });
  box.appendChild(ta);
  // 体验修复 A4：拖动条调高度——钳制 min/max + 容器余量；document 级 move/up 拖出边界也不丢
  drag.addEventListener("mousedown", (e) => {
    if (e && e.button) return;   // 仅左键
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    drag.classList.add("on");
    const startY = e && Number.isFinite(e.clientY) ? e.clientY : 0;
    const startH = (ta.offsetHeight > 0 ? ta.offsetHeight : 66);
    const room = right.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 0) || 800;
    const maxH = Math.max(AI_INPUT_MIN_H, room - 220);   // 预留工具条 + 边距（#24 需求3：模型行已移除）
    const mv = (ev) => {
      const y = ev && Number.isFinite(ev.clientY) ? ev.clientY : startY;
      ta.style.height = clampInputHeight(startH + (startY - y), maxH) + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      drag.classList.remove("on");
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });
  // ---------- 底部工具条（容器内底部一行）：左=模型下拉 · 右=发送 + 智能拆镜 ----------
  const bar = el("div", {
    id: "aiInputBar",
    class: "ai-input-bar",
    style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid var(--line)",
  });
  bar.appendChild(modelSel);
  bar.appendChild(el("span", { style: "flex:1" }));   // 撑开：下拉靠左 · 按钮靠右
  const btnSend = el("span", { class: "prim", text: t("ai.send.btn") });
  const btnShot = el("span", {
    class: "fbtn",
    id: "aiShotgenBtn",
    title: t("ai.shotgen.btnTitle"),
    text: SHOTGEN_BTN,
  });
  bar.appendChild(btnSend);
  bar.appendChild(btnShot);
  box.appendChild(bar);
  input.appendChild(box);
  right.appendChild(input);

  // ---------- #31 释放显存（按钮在输入区下方·右栏底部·不抢发送钮视线） ----------
  //   链路：GET /gui13-fs/engine_busy → 空闲直发 POST /gui13-fs/free_vram（空体）
  //        忙 → 二次确认（复用 ui/modal openConfirm）→ 确认才发 {force:true}
  //   失败/不可达 → 人话 toast（不双弹：走 fetchApi self 档·不触 toastBridge）
  const btnFreeVram = el("button", {
    type: "button",
    class: "ghostbtn-mini",
    id: "aiFreeVramBtn",
    title: FREE_VRAM_TITLE,
    text: FREE_VRAM_BTN_TEXT,
    style: "align-self:flex-end;flex-shrink:0;margin:0 10px 8px",
  });
  right.appendChild(btnFreeVram);

  let freeVramLock = false;            // 按钮锁（含确认弹窗期间·防连点）
  let freeVramForceInFlight = false;   // force 请求在途（决定由谁解锁）

  function unlockFreeVram() {
    freeVramLock = false;
    btnFreeVram.disabled = false;
    btnFreeVram.textContent = FREE_VRAM_BTN_TEXT;
  }

  async function postFreeVram(force) {
    const r = await _fsCall("/gui13-fs/free_vram", { method: "POST", body: force ? { force: true } : {} });
    if (!r.ok) { showToast("error", freeVramErrText(r.error)); return false; }
    showToast("success", freeVramOkText(r.json));
    return true;
  }

  async function forceFreeVram() {
    freeVramForceInFlight = true;
    try {
      await postFreeVram(true);
    } finally {
      freeVramForceInFlight = false;
      unlockFreeVram();
    }
  }

  btnFreeVram.addEventListener("click", async () => {
    if (freeVramLock) return;
    freeVramLock = true;
    btnFreeVram.disabled = true;
    btnFreeVram.textContent = FREE_VRAM_RUN_TEXT;
    let keepLock = false;   // 忙分支：弹窗期间保持锁（取消/确认后各自解锁）
    try {
      const st = await _fsCall("/gui13-fs/engine_busy", { method: "GET" });
      if (!st.ok) { showToast("error", freeVramErrText(st.error)); return; }
      const j = st.json || {};
      const running = Number(j.running) || 0;
      const pending = Number(j.pending) || 0;
      if (!j.busy) { await postFreeVram(false); return; }
      keepLock = true;
      openConfirmModal({
        title: t("ai.vram.confirmTitle"),
        sub: t("ai.vram.confirmSub", { n: running + pending }),
        confirmText: t("ai.vram.btn"),
        danger: true,
        onConfirm: () => { forceFreeVram(); },
        onCancel: () => { if (!freeVramForceInFlight) unlockFreeVram(); },
      });
    } finally {
      if (!keepLock) unlockFreeVram();
    }
  });


  // ============================================================================
  // 模型下拉: listPresets 填充 + 恢复机制（legacy :765-827 取码）
  // ============================================================================
  const savedModel = _restoreModel(storage);
  let presets = [];
  let optionsLoaded = false;

  function tryRestoreModel(saved) {
    if (!saved) return false;
    for (const opt of modelOptions) {
      if (opt.value === saved) {
        setModelValue(opt.value, opt.label);
        return true;
      }
    }
    return false;
  }

  // 选项异步到位后重试回填（legacy _scheduleModelRestore:12×150ms）
  function scheduleModelRestore(saved, attempts = MODEL_RESTORE_ATTEMPTS, intervalMs = MODEL_RESTORE_INTERVAL_MS) {
    if (!saved) return;
    let n = 0;
    const tick = () => {
      if (modelSel.isConnected === false) return; // 视图卸载即停
      if (tryRestoreModel(saved)) return;
      if (optionsLoaded) { _clearModel(storage); return; } // 预设列表已到位且无命中 → 丢选项清键
      if (++n < attempts) setTimeout(tick, intervalMs);
    };
    tick();
  }

  // 预设展示名：model 名为空者标注「需编辑填模型名」（v2-2 口径）
  function presetLabel(p) {
    const name = p && typeof p.name === "string" ? p.name : "";
    if (!name) return "";
    const hasModel = typeof p.model === "string" && p.model.length > 0;
    return hasModel ? name : name + t("seg.opt.needsModel");
  }

  function renderModelOptions() {
    modelOptions = [{ value: "", label: MODEL_PLACEHOLDER }];
    for (const p of presets) {
      const name = p && typeof p.name === "string" ? p.name : "";
      if (!name) continue;
      modelOptions.push({ value: name, label: presetLabel(p) });
    }
    // data-opts：仓内 cbox 约定（value=label·管道分隔）——选项表对外可读（调试/测试）
    modelSel.setAttribute("data-opts", modelOptions
      .map((o) => (o.value === o.label ? o.value : o.value + "=" + o.label))
      .join("|"));
    if (modelValue) tryRestoreModel(modelValue);  // 重建后保持当前选中
    else setModelValue("", MODEL_PLACEHOLDER);
  }

  // 选中写回（展示文本 + 当前值 + 持久化）
  function setModelValue(v, label) {
    modelValue = v == null ? "" : String(v);
    modelSel.value = modelValue;        // 同名语义：发送链读 modelSel.value
    modelSelText.textContent = label == null ? "" : String(label);
  }

  // 打开菜单（向上弹出）· 选项点击写回并关闭
  function openModelMenu() {
    closeModelMenu();
    const menu = el("div", { class: "cbox-menu", id: "aiModelMenu" });
    for (const o of modelOptions) {
      const item = el("div", { class: "co", "data-co": o.value, title: o.label, text: o.label });
      item.addEventListener("click", (e) => {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        setModelValue(o.value, o.label);
        if (o.value) _persistModel(storage, o.value);   // 选中持久化（legacy :808-812）
        else _clearModel(storage);
        closeModelMenu();
      });
      menu.appendChild(item);
    }
    menu.style.display = "block";
    document.body.appendChild(menu);
    _modelMenu = menu;
    positionModelMenu(menu, modelSel);
  }

  // 触发器：点击开/关（stopPropagation 挡住 body 委托的「点外部关」，避免刚开就关）
  modelSel.addEventListener("click", (e) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (modelDisabled) return;
    if (_modelMenu) { closeModelMenu(); return; }
    openModelMenu();
  });

  // body 级委托（每 body 一次）：点外部关菜单 · ESC 关菜单
  //   挂靠批：面板内点击不关面板（否则行内输入框一点就失焦/面板被关）
  if (!_menuDelegatedBodies.has(document.body)) {
    _menuDelegatedBodies.add(document.body);
    document.body.addEventListener("click", (e) => {
      const tgt = e && e.target;
      if (tgt && _newPanel && _isInside(tgt, _newPanel)) return;      // 面板内点击 → 保留面板
      if (tgt && _modelMenu && _isInside(tgt, _modelMenu)) return;    // 模型菜单内点击 → 保留菜单
      closeModelMenu();
      closeNewSessionPanel();
    });
    document.body.addEventListener("keydown", (e) => {
      if (e && (e.key === "Escape" || e.key === "Esc")) { closeModelMenu(); closeNewSessionPanel(); }
    });
  }

  async function loadPresets() {
    const r = await listPresets();
    presets = r.ok ? r.presets : [];
    optionsLoaded = r.ok;
    renderModelOptions();
    // 列表真到位但无命中（预设被删）→ 丢选项清键; 加载失败保留（兜底值仍可发）
    if (r.ok && savedModel && !tryRestoreModel(savedModel)) _clearModel(storage);
  }

  if (savedModel) scheduleModelRestore(savedModel);
  loadPresets();

  // ============================================================================
  // 发送链（legacy :866-942 取码）: user 气泡 → 思考中… → sendChat → 404 重建一次 → 回复
  // ============================================================================
  const setInputDisabled = (on) => {
    ta.disabled = on;
    btnSend.disabled = on;   // span 无原生 disabled — 点击守卫用该属性
    btnShot.disabled = on;   // T4 拆镜钮随输入区一同禁用（回灌期）
    setModelDisabled(on);
    newBtnL.disabled = on;   // 左栏顶「新会话」（#24 需求2 后唯一入口）
  };

  // 自绘下拉禁用态（发送/回灌期间不可展开）
  function setModelDisabled(on) {
    modelDisabled = !!on;
    modelSel.disabled = modelDisabled;                    // 同名语义（供既有断言读）
    modelSel.setAttribute("aria-disabled", modelDisabled ? "true" : "false");
    modelSel.style.opacity = modelDisabled ? "0.55" : "";
    modelSel.style.pointerEvents = modelDisabled ? "none" : "";
    if (modelDisabled) closeModelMenu();
  }

  // legacy :882-896: 下拉未选但有 storage 值 → storage 兜底（预设被删由引擎 400 兜底）；
  // 发送与拆镜（T4）共用同一守卫。无可用模型 → 白话 toast + ""
  function resolveModelForSend() {
    const model = modelSel.value || _restoreModel(storage) || "";
    if (!model) {
      showToast("warn", presets.length === 0 ? t("ai.model.needPreset") : t("ai.model.needPick"));
      return "";
    }
    if (!modelSel.value) tryRestoreModel(model); // 下拉有该选项则回填选中
    return model;
  }

  // ---------- #39/#34 会话项目单一真值解析 ----------
  //   取值顺序：pendingProjectId（新建会话已选项目·首条消息未发出态）→ 当前会话 meta.projectId → 均无 ""
  //   #62：currentPid()（采纳链）的 ② 源 = sessionBoundProjectId（只认会话绑定·不含 pending）
  //   新建面板标签只认面板内 selectedId，不用此函数
  function sessionBoundProjectId() {
    const sid = getCurrentSessionId();
    const meta = sid ? (loadSessionMeta(storage)[sid] || {}) : {};
    return meta.projectId || "";
  }
  function resolveSessionProjectId() {
    if (pendingProjectId) return pendingProjectId;
    return sessionBoundProjectId();
  }

  // ---------- #34 项目上下文（发送侧隐藏块的数据源） ----------
  //   #34 整改（老板裁决）：注入源只认会话绑定项目——resolveSessionProjectId（pending → meta）；
  //   页面项目（URL ?p=）不再参与注入；无绑定 → 不附加块
  function _contextProject() {
    const pid = resolveSessionProjectId();
    if (!pid) return null;
    const proj = storeLoad(pid);
    return (proj && !proj.deletedAt) ? proj : null;
  }
  function _projectContextBlockForSend() {
    const proj = _contextProject();
    if (!proj) return "";
    return buildProjectContextBlock(proj);
  }

  async function send() {
    if (btnSend.disabled) return;
    const message = String(ta.value || "").trim();
    if (!message) {
      showToast("warn", t("ai.send.empty"));
      return;
    }
    // #22 关联项目指令 → 拦截（不发引擎·不产生消息气泡）
    const assoc = ASSOC_CMD_RE.exec(message);
    if (assoc) {
      if (handleAssociateCommand(assoc[2].trim())) ta.value = "";
      return;
    }
    const model = resolveModelForSend();
    if (!model) return;

    // #26：发给引擎的报文附隐藏输出规范块（界面气泡仍只显示用户原文）
    // #34：再附隐藏项目上下文块（项目名/模板/全局提示词/分镜表）→ AI 能答本项目分镜
    const wire = message + OUTPUT_SPEC_BLOCK + _projectContextBlockForSend();
    // #45 两态判别（sendChat 前本地·validateMessage 同口径 16384）：
    //   原文超长 → 文案A；原文合规但 wire（原文+输出规范块+项目上下文块）超长 → 文案B
    if (!validateMessage(message).ok) {
      showToast("error", t("ai.send.tooLong"));
      return;
    }
    if (!validateMessage(wire).ok) {
      showToast("error", t("ai.wire.tooLong"));
      return;
    }

    appendBubble("user", message);
    ta.value = "";
    clearChecks();
    btnSend.disabled = true;
    btnSend.textContent = t("ai.send.thinking");
    btnShot.disabled = true;  // 发送中拆镜互斥（v2-10）
    ta.disabled = true;
    setModelDisabled(true);
    let r = null;
    let attempts = 0;
    try {
      while (attempts < 2) {
        attempts++;
        r = await sendChat({ model, message: wire });
        if (r.ok) break;
        if (r.error && r.error.code === "session_not_found" && attempts === 1) {
          // 自动重建一次: 清 session_id 重发（不重复插 user 气泡）
          resetCurrentSession();
          showToast("info", t("ai.send.sessionReset"));
          continue;
        }
        break;
      }
      if (r && r.ok) {
        appendBubble("assistant", r.reply || "");
        renderChecks(r.checks.warns, r.checks.errs, r.trimmed_old_count);
        // #46 批7 G1：可见性指示（持久态·落 sessionMeta·刷新/切会话回看仍在）
        //   批7 前旧引擎无 sent 字段 → deriveVisibility 返 null → 不显示·不落库（零报错）
        //   缺 head_messages_count（批9 E2 未落地）→ 降级文案只报计数不标方向
        const vis = deriveVisibility({
          trimmed: r.trimmed_old_count, sent: r.sent_messages_count,
          floor: r.carries_context_floor, headCount: r.head_messages_count,
        });
        if (vis && r.session_id) setSessionVisibility(storage, r.session_id, vis);
        renderVisibility(vis);
        pendingNew = false;  // 引擎已建真实会话 → 占位项退役（真实行按真实 id 高亮）
        if (pendingProjectId && r.session_id) {   // #22：新会话选定项目 → 写会话元数据
          setSessionMeta(storage, r.session_id, { projectId: pendingProjectId });
          pendingProjectId = "";
        }
        saveDraft(storage, "", "");   // 发送成功 → 清草稿（内容已进引擎）
        renderSessions(); // 发送成功即刷新左栏（新会话落列表 + 当前行高亮）
      } else if (r) {
        showToast("error", _describeChatError(r.error));
      }
    } finally {
      btnSend.disabled = false;
      btnSend.textContent = t("ai.send.btn");
      btnShot.disabled = false;
      ta.disabled = false;
      setModelDisabled(false);
    }
  }

  btnSend.addEventListener("click", () => { send(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); // 原型 :1722 onkeydown 行为
      send();
    }
  });

  // ---------- #22-10 输入框草稿（切页不丢内容） ----------
  //   内容变化 → 防抖 300ms 存 gui13.ai.draft{sessionKey,text}；发送成功/新会话清空
  let draftTimer = null;
  const draftKey = () => (getCurrentSessionId() || "new");
  ta.addEventListener("input", () => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      saveDraft(storage, draftKey(), ta.value);
    }, AI_DRAFT_DEBOUNCE_MS);
  });

  // ============================================================================
  // 智能拆镜链（B6-T4 · legacy ai_collab_llm.js:957-1098 取码适配）:
  //   拆镜中与发送 disabled 互斥（v2-10）; 解析失败 toast 不渲染建议表;
  //   采纳 = store.addSegment+updateSegment 直写追加（不覆盖既有行, 1.0 口径）。
  // ============================================================================
  let suggRows = [];     // [{ suggestion:{desc,motion,motionNorm,duration,ref}, checked }]
  let shotgenVocab = {}; // 最近一次拆镜加载的 vocab（建议表归一 + 采纳归一同源）

  function refreshAdoptLabel() {
    const n = suggRows.filter((r) => r.checked).length;
    adoptBtn.textContent = t("ai.adopt.count", { n });
  }

  function hideSuggestions() {
    suggRows = [];
    while (suggBody.firstChild) suggBody.removeChild(suggBody.firstChild);
    suggWrap.style.display = "none";
  }

  // 建议行: 勾选框（默认全上）+ 描述 + 运镜（归一, 不中→「未识别, 请手选」）+ 时长
  function showSuggestions(parsedRows, vocab) {
    shotgenVocab = vocab || {};
    while (suggBody.firstChild) suggBody.removeChild(suggBody.firstChild);
    suggRows = parsedRows.map((row) => {
      const suggestion = {
        desc: row.desc || "",
        motion: row.motion || "",
        motionNorm: normalizeMotion(row.motion || "", shotgenVocab) || "",
        duration: row.duration,
        ref: row.ref || "",
      };
      const st = { suggestion, checked: true };
      const rowEl = el("div", {
        class: "ai-shotgen-row",
        style: "display:grid;grid-template-columns:22px 2fr 90px 56px;gap:4px;padding:3px 4px;border-bottom:1px solid var(--line);align-items:center;color:var(--txt)",
      });
      const cb = el("input", { type: "checkbox" });
      cb.checked = true;
      cb.addEventListener("click", () => {
        st.checked = !st.checked;
        cb.checked = st.checked; // 显式赋值: 真实 DOM click 已先自切, 赋同值不抖
        refreshAdoptLabel();
      });
      rowEl.appendChild(cb);
      rowEl.appendChild(el("span", { style: "word-break:break-word", text: suggestion.desc }));
      const motionSpan = el("span", { text: suggestion.motionNorm || SHOTGEN_MOTION_UNKNOWN });
      if (!suggestion.motionNorm) motionSpan.style.color = "#e8b339";
      rowEl.appendChild(motionSpan);
      rowEl.appendChild(el("span", {
        style: "text-align:right",
        text: (typeof suggestion.duration === "number") ? String(suggestion.duration) : "",
      }));
      suggBody.appendChild(rowEl);
      return st;
    });
    refreshAdoptLabel();
    suggWrap.style.display = "";
  }

  async function runShotgen() {
    if (btnShot.disabled) return;
    const userText = String(ta.value || "").trim();
    if (!userText) {
      showToast("warn", t("ai.send.empty"));
      return;
    }
    const v = validateMessage(userText);
    if (!v.ok) {
      showToast("error", t("ai.shotgen.tooLong"));
      return;
    }
    const model = resolveModelForSend();
    if (!model) return;
    appendBubble("user", userText);
    btnShot.disabled = true;
    btnShot.textContent = SHOTGEN_BUSY;
    btnSend.disabled = true;  // 拆镜中发送互斥（v2-10）
    ta.disabled = true;
    setModelDisabled(true);
    hideSuggestions();
    let parsedOk = false;
    try {
      const r = await sendChat({ model, message: buildShotgenPrompt(userText) });
      if (!r.ok) {
        showToast("error", t("ai.shotgen.fail", { reason: _describeChatError(r.error) }));
        return;
      }
      appendBubble("assistant", r.reply || ""); // 回复气泡照常渲染（便于回看）
      // #46 批7 G1：拆镜同走 #50（真实引擎对话）→ 可见性指示同口径刷新
      const vis = deriveVisibility({
        trimmed: r.trimmed_old_count, sent: r.sent_messages_count,
        floor: r.carries_context_floor, headCount: r.head_messages_count,
      });
      if (vis && r.session_id) setSessionVisibility(storage, r.session_id, vis);
      renderVisibility(vis);
      pendingNew = false;  // 拆镜同样建会话 → 占位项退役
      renderSessions(); // 新会话/条数落左栏（与发送链同口径）
      const parsed = parseShotgenReply(r.reply || "");
      if (!parsed.ok) {
        showToast("warn", SHOTGEN_FAIL_TOAST);
        return;
      }
      parsedOk = true;
      showSuggestions(parsed.rows, await fetchVocab());
    } finally {
      btnShot.disabled = false;
      btnShot.textContent = SHOTGEN_BTN;
      btnSend.disabled = false;
      ta.disabled = false;
      setModelDisabled(false);
      if (!parsedOk) hideSuggestions();
    }
  }

  // 采纳 = 逐行追加（不覆盖既有）: addSegment + updateSegment 字段直写。
  // v2-8 键形: prompt / 「运镜方式」（store 真实键名直写）/ 「段落时长」→durationSec（唯一转换）;
  // 空值不写（运镜未识别留空、时长缺省保持 store 默认 5）。
  function adoptSuggestions() {
    const picks = suggRows.filter((r) => r.checked);
    if (picks.length === 0) {
      showToast("warn", t("ai.adopt.none"));
      return;
    }
    // #62：取数统一走 currentPid（?p= → 会话绑定项目 → hash 兜底）；三者皆空 → 无项目守卫。
    const pid = currentPid();
    const project = pid ? storeLoad(pid) : null;
    if (!project) {
      showToast("error", SHOTGEN_NO_PROJECT);
      return;
    }
    let adopted = 0;
    for (const row of picks) {
      const seg = addSegment(project);
      const r = toShotRow(row.suggestion, adopted + 1, shotgenVocab);
      const patch = {};
      if (r.prompt) patch.prompt = r.prompt;
      if (r["运镜方式"]) patch["运镜方式"] = r["运镜方式"];
      if (r["段落时长"] !== "") patch.durationSec = r["段落时长"];
      updateSegment(project, seg.id, patch);
      adopted++;
    }
    storeSave(project);
    hideSuggestions();
    ta.value = "";
    showToast("success", t("ai.adopt.done", { n: adopted }));
  }

  btnShot.addEventListener("click", () => { runShotgen(); });
  adoptBtn.addEventListener("click", () => { adoptSuggestions(); });


  // 新会话（#24 需求2 后唯一入口：左栏顶「＋新会话」）:
  // 清内存态 + 清键 + 清流 + 清 checks + 左栏刷新
  function startNewSession() {
    resetCurrentSession();
    clearMsgs();
    clearChecks();
    renderVisibility(null);   // #46 批7 G1：新会话无可见性记录 → 指示隐藏
    pendingNew = true;      // 左栏顶部占位项（前端临时态·发送成功后退役）
    saveDraft(storage, "", "");   // #22-10：开新会话 → 清草稿（属旧上下文的草稿不再回填）
    ta.value = "";                // 同上：输入框一并清空（新会话不带旧草稿）
    renderSessions(); // 左栏刷新（高亮随 currentSessionId 注销）
    showToast("info", t("ai.toast.newSession"));
  }
  newBtnL.addEventListener("click", (e) => {
    if (newBtnL.disabled) return;
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();   // 隔开 body 委托的「点外部关」
    openNewSessionPanel();   // #22：先选项目（可「不关联」）· 选完才建会话
  });

  // 刷新恢复: restoreSessionId（同步确模块态，左栏高亮同源）→ getSessionDetail →
  //   失败静默 reset → 成功逐条回灌（legacy :1121-1134 取码; v2-9: 回灌期间禁用输入区防乱序）
  // #22-10：切页回来自动恢复当前会话（消息已落库即渲染）；会话还没落库（生成中）→ 轻提示
  const restoredSid = restoreSessionId();
  (async () => {
    if (!restoredSid) return;
    setInputDisabled(true);
    try {
      const detail = await getSessionDetail(restoredSid);
      if (!detail.ok) {
        const code = detail.error && typeof detail.error.code === "string" ? detail.error.code : "";
        const status = detail.error && Number(detail.error.httpStatus) || 0;
        if (code === "session_not_found" || status === 404) {
          resetCurrentSession(); // 会话已被引擎清理（真失效）→ 清键保持空态, 静默
          return;
        }
        // 引擎不可达/超时等暂态 → 保留会话键（内容可能还在生成）+ 轻提示（可继续发消息）
        showPendingReplyHint();
        return;
      }
      const list = (detail.session && Array.isArray(detail.session.messages)) ? detail.session.messages : [];
      for (const m of list) appendBubble(m.role || "user", m.content || "");
      renderVisibility(getSessionVisibility(storage, restoredSid));   // #46 批7 G1：刷新后回灌可见性指示
      // 末条是用户消息（AI 还没落库）→ 回复可能仍在生成 → 轻提示（可继续发消息）
      const lastRole = list.length ? String((list[list.length - 1] || {}).role || "") : "";
      if (list.length === 0 || lastRole === "user") showPendingReplyHint();
      renderSessions();   // 行高亮跟随当前会话（回灌完成后刷新左栏）
    } finally {
      setInputDisabled(false);
    }
  })();

  // #22-10：草稿回填（属当前上下文才回填：同一会话或都是新会话）· 光标置末尾
  (() => {
    const draft = loadDraft(storage);
    if (!draft || !draft.text) return;
    const curKey = getCurrentSessionId() || "new";
    if (draft.sessionKey !== curKey) return;   // 属别的会话 → 不回填
    ta.value = draft.text;
    try {
      if (typeof ta.setSelectionRange === "function") ta.setSelectionRange(draft.text.length, draft.text.length);
      if (typeof ta.focus === "function") ta.focus();
    } catch (_e) { /* 测试桩无选区 API·忽略 */ }
  })();

  hideSuggestions(); // T4 建议表默认隐藏（显示态由拆镜成功驱动）
  renderArchive();
  renderSessions();
  container.appendChild(sec);
  hydrateIcons(sec); // R0 范式（幂等 · 本页原型无 data-ic 时 no-op）
  return sec;
}

// ============================================================================
// #44 后半（B3·方案 v5 §四）：跨窗口项目索引同步——接收端（只读不写不重播防回环）
//   他窗总表行写入 → sync_bus 广播 index-changed → 本窗 reloadServerIndex()（拉服务端
//   覆盖缓存·纯 GET）→ 面板开着就重渲项目列表；关着只刷缓存（下次展开即新）。
//   接收处理不发广播、不写服务端 → 无回环；本页自己写的总表行不回声到自己（标准行为）。
//   focus 轻量对账：切回窗口走同一读口拉一次（他窗静默改动的兜底路径）——Node 无
//   EventTarget，测试直调本函数（真机浏览器=窗口 focus 事件触发同一入口）。
// ============================================================================
let _projListRerender = null;   // 面板展开时由 openNewSessionPanel 注入·关闭置 null
export function syncProjListFromServer() {
  Promise.resolve(reloadServerIndex()).then((r) => {
    if (r && r.ok && typeof _projListRerender === "function") _projListRerender();
  }).catch(() => { /* 拉取异常静默（只读对账失败不炸页面·下次触发再试） */ });
}
onIndexChanged(syncProjListFromServer);
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("focus", syncProjListFromServer);   // Node 无此 API → 跳过（store.js flush 钩子同款 guard）
}
