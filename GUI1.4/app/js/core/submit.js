// core/submit.js — 提交主链 (S1-2 T6 改造自 legacy/app/js/domain/submit.js).
//
// === 出处注记 ===
// 改造自 legacy/app/js/domain/submit.js (409 行):
//   1. import 路径适配: ./resources.js → ./serialize.js (三序列化函数已最小提取至 core/serialize.js)
//   2. core/state.js 依赖去除: 旧 getResourcesList/getLoraOverridesMap/getResourcesOvMap 走 state.js live binding;
//      本仓架构走 project 显式入参 (formData.resourcesList / formData.loraOverrides / formData.modelOverrides)
//   3. core/push.js 依赖接回（B7-T1 · C1）：runOnly 恒发 live_client_id = getClientId()
//      （api.md #9 契约键·可选 string——引擎 extra_data 逐提交开 preview_method="auto"，
//      /ws 实时预览帧激活；cid 与 connectLive 连接同源单点）
//   4. core/poll.js 依赖: 本仓尚无 core/poll.js → 测试桩走 ./poll-stub.js;
//      真实 poll.js 替换后无影响 (接口契约一致)
//   5. 新增 buildFormDataFromProject(project): store 项目对象 → legacy formData 结构
//      (14 键直传 + 两异名映射 + shots 字段映射 + mode 三档 + 自定义模式注入 concat + 提示词注入)
//
// 导出 (与 legacy 同):
//   generateOnly / runOnly / submitBatch / cancelBatch / pollStatus /
//   previewPrompt / pddTurboWarning / shotColor / progressSummary / getHasPddTemplate
// 新增:
//   buildFormDataFromProject
//   validateSteps（老板走查批A 1.3：生成步数提交前预校验；generateOnly/runOnly 入口闸门）

import { request } from "./api.js";
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件超时值引表·不得就地内联。
import { TIMEOUTS } from "./timeouts.js";
import { getClientId } from "./push.js";
import {
  serializeResources,
  serializeLoraOverrides,
  serializeOverrides,
} from "./serialize.js";
import {
  appendFirstFrameAnchor,
  pickFirstFrameRefForPrompt,
  USAGE_CATALOG,
} from "./assets_api.js";
import { computeAssignResult, ASSIGN_SLOT_MAX } from "./assigner.js";  // 批 J-P10：@名字 自动绑定复用分配器同函数
import { nextBindingNo, bindingEntryFromFill, upsertBinding } from "./bindings.js";
// 批 L1 T1（R-29）：项目级「模板」废除族闸门——族判型单一真值源在 templates.js（词表与引擎 _declared_mode 同源）
import { classifyTemplateFamily, DEPRECATED_TEMPLATE_FAMILIES } from "./templates.js";
import { t } from "./i18n.js";   // #89 T4b：校验/守卫/通知文案入典（submit.*·core→core 依赖；引擎数据串不入典）

// ---- 内置最小 createPoller（保持 pollStatus 与 legacy 同形：同步返回 handle） ----
//   真实 core/poll.js（T7+）实装后可替换本内置实现 — 接口契约一致
//   设计：setTimeout 链 + start/stop + onTick/onError/onFinal（与 legacy poll.js 行为对齐）
//   导出供随迁测试直接调用（35 测第一项"收尾期不停轮询"用 createPoller 自构造）
export function createPoller(opts) {
  const fn = opts.fn;
  const intervalMs = opts.intervalMs;
  const onTickCb = opts.onTick || (() => {});
  const onErrorCb = opts.onError || (() => {});
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const r = await fn();
      // r 可能是 {ok, data} 信封 或 直接 data 对象（fn 形态决定）
      let data;
      let full;
      if (r && typeof r === "object" && "ok" in r && "data" in r) {
        if (r.ok === false) { onErrorCb(r.error); return; }
        data = r.data;
        full = r;
      } else {
        data = r;
        full = { ok: !!r, data };
      }
      onTickCb(data, full);
    } catch (e) {
      onErrorCb(e);
    }
  }

  return {
    start() {
      stopped = false;
      const loop = () => {
        if (stopped) return;
        tick().then(() => {
          if (!stopped) timer = setTimeout(loop, intervalMs);
        });
      };
      loop();
    },
    stop() {
      stopped = true;
      if (timer != null) { clearTimeout(timer); timer = null; }
    },
  };
}

// ============================================================================
// 0. S1-2 T6/T10: buildFormDataFromProject — store 项目对象 → legacy formData 结构
// ============================================================================
//
// 数据契约 (主代理已裁两处异名, 见节点记录 S1-2 §三项映射裁决 + §数据组装映射):
//   globals:
//     - 8 键值域映射 (T10 双审修正笔): store 中文/语义值 → 引擎可消费值域
//         自动拼接   boolean → "自动"/"不拼" (false 显式发"不拼", csv_gen.py:96 兜底)
//         关音乐/对白/水印字幕  boolean → "开"/不发键 (engine _truthy :5954 "开" 才生效)
//         审片门   "关"/"开·宽松"/"开·严格" → 不发键(=0)/"5"/"1" (engine _parse_global :5546-5550 只认 ≤50 非负整数)
//         音乐混入   "覆盖"/"混音" → "替换"/"混合" (engine batch_core.py:5545 白名单)
//         质量     "0.4 · 流畅" → "0.4" (engine batch_core.py:6059 float() 直接消费首段数字)
//         比例     "9:16 竖屏" → "9:16" (engine batch_core.py:6014 _parse_aspect_ratio_to_decimal 只认裸比)
//         配乐/氛围声  "自动"/"无"/非空文本 → 不发键(=引擎不消费)/发文本(engine _parse_global :5539-5540 + _apply_global :5975 拼装)
//     - S2-2 T4 后处理三键值域映射 + D1 组门前置: 已退役（批②F-114 笔2·2026-10-17）
//         原「拼接 且 自动拼接=开 → globals 落 放大/插帧/放大引擎」读取整体移除——
//         后期触发源迁 GUI 侧编排（postfx_* 六键 → core/postfx_pipeline.js），
//         存量旧键项目提交后引擎 CSV 后期静默休眠=设计如此（详见 buildFormDataFromProject 内留档注释）
//     - 异名 1: "音乐混入" → "音乐混入方式"
//     - 异名 2: "全部段生成完自动接成一条片" → "自动拼接" (再做值域转换如上)
//     - 异名 3 (D-1 修复): "生成步数" → "步数" (引擎白名单键)
//     - 注入 1: "提示词" = project.globalPrompt (PRD v1.4 §7.3)
//     - 注入 2 (T10 D-2 裁决): "批次次数" = String(proj.runCount) (引擎 main.js:4411 String(Math.min(50, rep)))
//     - 注入 3 (批 2-T1): "模板" = 项目级手选优先；无项目级时取 gui13.paths.workflow_path 文件名去扩展
//     - 缺字段 → 走 store.createProject 默认 14 键兜底
//   paths (批 2-T1):
//     - gui13.paths（localStorage·views/settings.js 写入）→ { workflow_path }（R-59-T2b：server_output_dir 退役不发键）
//       仅非空才发键；template_path（T2 取清单用）/ comfyui_dir（本地诊断）不进提交
//   shots:
//     - segment.prompt → "prompt"
//     - segment.durationSec → "段落时长"
//     - segment.seed → "种子"
//     - segment.exportName → "导出文件名"
//     - 9 项镜头字段同名直传 (角度/景别/运镜方式/运镜方向/运镜幅度/运镜速度/焦段/氛围/情绪)
//       B6-T6: 「角度」补发引擎全形「镜头角度」同值双键 (引擎 SHOT_HEADER csv_gen.py:16)
//     - segment.concat → "与上一片段拼接" (仅 projMode=自定义·勾选=true 发字符串「是」,
//       未勾不发键 — 引擎 derive_seg_flags batch_core.py:2613 只认「是」)
//   mode:
//     - projMode 三档: 分镜/拼接/自定义 → 同名直传 (legacy 形态; 引擎按 mode 字段名自行分发)
//   pool / pool_usage: 演示态空结构 (T8 真实资源编排映射归后续批)
//   segments 拼接规则 (与 legacy _buildGenerateBody 形态一致):
//     - 分镜模式 — 全部不拼接 (不注入 concat 字段)
//     - 拼接模式 — 全部拼接 (不注入 concat 字段, 引擎按 mode=拼接 自动)
//     - 自定义模式 — 勾选段落落 "与上一片段拼接":"是" (未勾不发键, B6-T6 值形)

import { createProject } from "../store/store.js";
// 排戏台挂槽档2 T3: 排戏来源卡判定（批级池过滤与存量迁移同口径·单一真值源在 staging_attach.js）
import { isStagingCardName } from "./staging_attach.js";

// ---- T10 值域映射纯函数 (随测) ----
// 比例: "9:16 竖屏" / "16:9 横屏" → "9:16" / "16:9" (engine batch_core.py:6014 _parse_aspect_ratio_to_decimal 只认裸比)
export function mapRatioToEngine(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  // 提取首段连续 "N:N" / "N:N:N" 形式 (含中英文冒号统一归一为 ASCII ":")
  const m = s.match(/(\d+)\s*[:：]\s*(\d+)(?:\s*[:：]\s*(\d+))?/);
  if (!m) return "";
  return m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
}

// 质量: "0.4 · 流畅" / "1.0 · 高清" → "0.4" / "1.0" (engine batch_core.py:6059 float() 直接消费首段数字)
export function mapQualityToEngine(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

// 音乐混入: "覆盖"→"替换", "混音"→"混合" (engine batch_core.py:5545 白名单)
const MUSIC_MIX_MAP = { "覆盖": "替换", "混音": "混合" };
export function mapMusicMixToEngine(value) {
  const s = String(value == null ? "" : value).trim();
  return MUSIC_MIX_MAP[s] || s;
}

// 审片门: GUI 三档 → engine ≤50 非负整数串
//   "关" → 不发键 (engine fallback 0=关)
//   "开 · 宽松" → "5" (每 5 段审片点 — 引擎 _review_every_n 唯一可调档, 数字越大越宽松)
//   "开 · 严格" → "1" (每 1 段审片点 — 数字越小越严格)
// 注: 引擎源码无"宽松/严格"语义(_review_every_n 单整数), 同引擎档位语义口径已在汇报登记.
const REVIEW_GATE_MAP = { "关": "", "开 · 宽松": "5", "开 · 严格": "1" };
export function mapReviewGateToEngine(value) {
  const s = String(value == null ? "" : value).trim();
  if (s in REVIEW_GATE_MAP) return REVIEW_GATE_MAP[s];
  // 兜底: 数字串直通 (防御性, 旧项目可能直接存整数串)
  if (/^\d+$/.test(s) && parseInt(s, 10) <= 50) return s;
  return "";  // 非法值回落 — engine _parse_global :5546-5550 不落键
}

// 关音乐/关对白/关水印字幕: boolean → "开" 或 不发键 (engine _truthy :5954 仅认 "开")
export function mapNegativeToggleToEngine(value) {
  return value === true ? "开" : "";
}

// 自动拼接: boolean → "自动"/"不拼" (false 必须显式发"不拼", csv_gen.py:96 兜底默认"自动")
export function mapAutoConcatToEngine(value) {
  return value === false ? "不拼" : "自动";
}

// 配乐/氛围声: "自动"/"无"/空 → 不发键 (engine 默认无音频块); 非空文本 → 透传
// engine main.js:957 自带表单 = text input + datalist (无"无"选项, 用户填文本或选预设),
// 故 GUI "自动/无" 映射为"不发键 = 引擎不消费 _audio_blocks 该段"
export function mapAudioTextToEngine(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s || s === "自动" || s === "无") return "";
  return s;
}

// ---- 生成步数预校验（老板走查批A 1.3 · 提交前拦截，防无效值静默提交）----
// 引擎文法: re.match(r"(\d+)\s*([VA])\s*(\d+)\s*([VA])") — V/A 任序·大小写不敏感 (batch_core.py:6005)
//   硬规则: 音频步 ≥ 视频步 (batch_core.py:8541-8548 预检 errs → 400 拒绝)
//   单边值 (如 8V / 6A) 引擎解析不了 → 应用期静默不生效 (:6068 用模板默认)
// 空值 = 不发键 (引擎用模板默认) → 放行
export function validateSteps(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return { ok: true };
  const m = s.match(/^(\d+)\s*([VA])\s*(\d+)\s*([VA])$/i);
  if (!m) {
    return { ok: false, msg: t("submit.steps.badFormat", { s }) };
  }
  const vFirst = m[2].toUpperCase() === "V";
  const v = parseInt(vFirst ? m[1] : m[3], 10);
  const a = parseInt(vFirst ? m[3] : m[1], 10);
  if (a < v) {
    return { ok: false, msg: t("submit.steps.audioLess", { s, a, v }) };
  }
  return { ok: true };
}

// 提交入口共用闸门：不合法 → 不发请求，返错误信封（submit-bar 走既有失败分支 showToast）
function _stepsGate(formData) {
  const g = (formData && formData.globals) || {};
  const r = validateSteps(g["步数"]);
  return r.ok ? null : { ok: false, error: { code: "invalid_steps", msg: r.msg } };
}

// 批 L1 T1（R-29 前置拦截）：项目级「模板」命中已废除族（i2v/fl2v·引擎 V1.14 已废除）→ 零请求拦截。
//   判据 = formData.projectWorkflow 真值（**不判 globals["模板"]**：其兜底值是去扩展裸名·判族不可靠）。
//   双入口 generateOnly/runOnly 共用（照 _stepsGate 先例）；连带注记：csv_transfer 导出链直调
//   generateOnly 同被拦 = 期望口径（防"导出了 CSV 旁车却跑不了批"的割裂体验·与引擎拒绝面对齐）。
function _projectTemplateGate(formData) {
  const tpl = (formData && formData.projectWorkflow) || "";
  const fam = classifyTemplateFamily(tpl);
  if (fam && DEPRECATED_TEMPLATE_FAMILIES.has(fam)) {
    return {
      ok: false,
      error: { code: "deprecated_template_family", msg: t("submit.tpl.deprecated") },
    };
  }
  return null;
}

// ---- 批 2-T1: gui13.paths 桥（paths 生产 + 模板名注入） ----
//   settings.js 写同名键（gui13.paths·views 与 core 不互引，键字面量=两侧契约）；
//   storage 缺省 = globalThis.localStorage（浏览器）；测试经 opts.storage 注入。
const GUI_PATHS_KEY = "gui13.paths";

export function readGuiPaths(storage) {
  const s = (storage && typeof storage.getItem === "function")
    ? storage
    : (typeof globalThis !== "undefined" && globalThis.localStorage ? globalThis.localStorage : null);
  if (!s) return {};
  let obj = null;
  try { obj = JSON.parse(s.getItem(GUI_PATHS_KEY)); } catch (_e) { obj = null; }
  return (obj && typeof obj === "object") ? obj : {};
}

// 模板名 = 路径文件名去扩展（兼容 \ / 分隔·无扩展原样·空值返空）
export function templateNameFromPath(p) {
  const s = String(p == null ? "" : p).trim();
  if (!s) return "";
  const base = s.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---- 批 W1 S1-T4（R-52 GUI 侧）：运行子目录推导（纯函数·随测） ----
//   R-52 v2（老板真机二轮定版 2026-10-11 晨·推翻 _RN 代数编号）：根夹=<项目名>·子夹=<项目名_时间戳>·
//   runSubdir=嵌套两段「名/名_ts」；first 与 full（全量重跑）都建新时间戳子夹（只有全量重跑再创建子夹·
//   单段重跑不建夹）；resume 沿用 runDir.current（缺→退化 first）。
//   返回 {ok:true, runSubdir, nextRunDir:{current}} 或 {ok:false, reason:"subdir_exists"}（提交前撞名拦截）。
//   existingDirs 语义 v2 = 项目根夹下的子夹名列表；null/undefined = 列目录失败降级 → 跳过撞名检查
//   （引擎 exist_ok 复用兜底）。存量 runDir 旧键 baseline/rebaseline 读侧忽略无害。

// 项目名清洗（正则与 views/projects.js:71 exportProjectFilename 同款·core 层不 import views）；空名兜底 "project"
export function _sanitizeFolderBase(name) {
  const s = String(name == null ? "" : name).replace(/[\/\:*?"<>|\x00-\x1f]/g, "_").trim();
  return s || "project";
}
// 时间戳段 YYYYMMDD_HHMM（本地时·now 注入可测）
function _runStamp(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
// 子夹段总长上限 100 字符（Windows MAX_PATH 防护）
function _clipFolderName(n) { return n.length > 100 ? n.slice(0, 100) : n; }

export function deriveRunSubdir({ mode, projectName, runDir, existingDirs, now }) {
  const cur = (runDir && typeof runDir === "object") ? runDir : null;
  const hit = (name) => Array.isArray(existingDirs) && existingDirs.includes(name);
  // first/full 同形：根夹=清洗项目名·子夹=名_新时间戳（撞名按子夹名在项目根夹层比对）
  const nested = () => {
    const base = _sanitizeFolderBase(projectName);
    const sub = _clipFolderName(`${base}_${_runStamp(now)}`);
    if (hit(sub)) return { ok: false, reason: "subdir_exists" };
    const runSubdir = `${base}/${sub}`;
    return { ok: true, runSubdir, nextRunDir: { current: runSubdir } };
  };
  if (mode === "resume" && cur && cur.current) {
    // 接力沿用 current：同夹累积；不查撞名（引擎 exist_ok 复用是定案语义）
    return { ok: true, runSubdir: cur.current, nextRunDir: cur };
  }
  return nested();   // first / resume 无 current / full（全量重跑=新时间戳子夹）
}

// ---- 批 8 T2a：castBindings → 引擎载荷转换（纯函数·随测） ----
//   引擎契约: 绑定槽域只认 1-8（batch_core.py:6708），slot 非法引擎静默跳过零报错 →
//   GUI 侧拦——idx 超域丢弃不钳位（绑定槽语义=用户指定 idx 原样保留，钳位伪造意图比丢弃危险；
//   与 T1 parseBindingsJson「idx 非 int 丢 slot」同域一致）
//   - slot idx: "3"/3 → parseInt 归一 int；NaN / <1 / >8 → 丢该 slot
//   - entry no: "2"/2 → 归一 int；NaN → 丢整个 entry（引擎按 name+no 建 Subject）
//   - entry name: 非字符串/空 → 丢 entry（引擎契约 name:str）
//   其余字段（kind/usage/media/desc/ignore_words 等）原样透传；不改入参
export function castBindingsToPayload(castBindings) {
  const list = Array.isArray(castBindings) ? castBindings : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.name !== "string" || entry.name === "") continue;
    const no = parseInt(entry.no, 10);
    if (!Number.isInteger(no)) continue;
    const slots = Array.isArray(entry.slots) ? entry.slots : [];
    const normSlots = [];
    for (const slot of slots) {
      if (!slot || typeof slot !== "object") continue;
      const idx = parseInt(slot.idx, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > 8) continue;
      normSlots.push({ ...slot, idx });
    }
    out.push({ ...entry, no, slots: normSlots });
  }
  return out;
}

// ============================================================================
// 批 J-P10: @资产名 → 角色绑定（引擎侧 castBindings 通道）
//   背景（老板 2026-10-06 两轮澄清终裁）: at-mention 弹窗选中资产后插入纯名字「@安安2」
//   （旧形态「@15 安安2」带编号·老板不要编号），且该名字要在引擎侧真正生效——
//   老板验证有效的通道 = 引擎侧资产分配器分配的 castBindings（"资产库分配器分配资产后
//   提示词加安安2 可以生效"）。故 GUI 侧把 @名字 直通同一条绑定通道，与分配器同函数同形态。
//   扫描源 = 全局提示词 + 各段提示词（与 J-P9 @N 扫描源同款·全局先占）
//   匹配规则: 注册表 {n: 卡名} 反查名字 → **最长前缀匹配**（registry 含带空格名字·
//     「概念帧 20260926-0823·裁剪」）· 名字后紧跟标识符字符不命中（词边界口径同引擎
//     replace_cast_names batch_core.py:1919——GUI 认得出名字而引擎替换不了=绑定白建）
//   未注册/无卡/空卡 → 原样保留·不猜（文本照原样下发）
//   显式绑定优先: 同名已在 castBindings（分配器/绑定面板写入）→ 不覆写其 no/slots
//   零回归守门: 无命中 → 原数组引用原样返回（下游 buildPool/bindings 逐字节不变）
//   @数字 通道全保留不拆（J-P9 的 Picture 装池通道·存量「@15 安安2」文本仍按数字解析）
// ============================================================================

// 名字索引：注册表 {n: 卡名} → 名字列表（去重·长度倒序=最长前缀匹配）
function mentionNameIndex(registry) {
  const reg = (registry && typeof registry === "object" && !Array.isArray(registry)) ? registry : {};
  const out = [];
  const seen = new Set();
  for (const key of Object.keys(reg)) {
    const name = reg[key];
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => b.length - a.length);
}

// 扫一段文本里命中的 @名字（按出现序·同段去重）
function scanMentionNames(text, names) {
  const s = String(text == null ? "" : text);
  const hit = [];
  const seen = new Set();
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf("@", i);
    if (at < 0) break;
    let matched = "";
    for (const nm of names) {
      if (!s.startsWith(nm, at + 1)) continue;
      const after = s[at + 1 + nm.length] || "";
      if (after && /[0-9A-Za-z_]/.test(after)) continue;   // 词边界（引擎同款）
      matched = nm;
      break;
    }
    if (!matched) { i = at + 1; continue; }
    if (!seen.has(matched)) { seen.add(matched); hit.push(matched); }
    i = at + 1 + matched.length;
  }
  return hit;
}

// 分配槽快照 {kind:{槽号串: media}} = poolManual 媒体槽 + 已有绑定占号
//   （分配器顺序落库时绑定槽经 poolManual 传递·此处直读 bindings 等效——异名卡不撞槽）
function bindingSlotSnapshot(poolManual, castBindings) {
  const snap = { Picture: {}, Video: {}, Audio: {} };
  const pm = (poolManual && typeof poolManual === "object" && !Array.isArray(poolManual)) ? poolManual : {};
  for (const kind of ["Picture", "Video", "Audio"]) {
    const kindObj = (pm[kind] && typeof pm[kind] === "object" && !Array.isArray(pm[kind])) ? pm[kind] : {};
    for (const key of Object.keys(kindObj)) {
      const entry = kindObj[key];
      const media = (entry && typeof entry.media === "string") ? entry.media.trim() : "";
      if (media) snap[kind][key] = media;
    }
  }
  for (const b of castBindingsToPayload(castBindings)) {
    for (const slot of b.slots) {
      const k = slot.kind === "Video" || slot.kind === "Audio" ? slot.kind : "Picture";
      if (snap[k][String(slot.idx)] === undefined) snap[k][String(slot.idx)] = slot.media || b.name;
    }
  }
  return snap;
}

/**
 * @资产名 → castBindings 自动绑定（批 J-P10 纯函数·随测）。
 * @param {object} opts
 *   castBindings / poolManual / segments / globalPrompt / registry / assets
 *   —— 与 buildPool 同数据源
 * @returns {Array} 新 castBindings 数组（入参不改写·无命中时返回入参引用）
 */
export function applyMentionBindings(opts = {}) {
  const list = Array.isArray(opts.castBindings) ? opts.castBindings : [];
  const assets = (opts.assets && typeof opts.assets === "object" && !Array.isArray(opts.assets)) ? opts.assets : {};
  const names = mentionNameIndex(opts.registry);
  if (!names.length) return list;
  const segs = Array.isArray(opts.segments) ? opts.segments : [];
  const texts = [opts.globalPrompt, ...segs.map((seg) => (seg && seg.prompt))];
  const hits = [];
  for (const t of texts) {
    for (const nm of scanMentionNames(t, names)) if (!hits.includes(nm)) hits.push(nm);
  }
  if (!hits.length) return list;
  let out = list;
  const snap = bindingSlotSnapshot(opts.poolManual, list);
  for (const name of hits) {
    if (out.some((b) => b && b.name === name)) continue;   // 显式绑定优先·不覆写
    const card = assets[name];
    if (!card || !Array.isArray(card.rows) || card.rows.length === 0) continue;
const r = computeAssignResult(card, snap, ASSIGN_SLOT_MAX);   // 与分配器同一决策函数
    // 批 K-T3 裁决 6 分叉: 引擎绑定槽只写 Picture——纯 Video/Audio 卡 @名字 不进绑定通道
    //   （进绑定=白建：bindingEntryFromFill 会把非 Picture 槽滤空·留一条空壳 entry），
    //   该卡的视/音行改由 buildPool 的 allocateMentionAv 落命中段 segPools{Video/Audio}。
    const picFilled = r.filled.filter((f) => f.kind === "Picture");
    if (picFilled.length === 0) continue;
    const entry = bindingEntryFromFill({ cardName: name, no: nextBindingNo(out), filled: picFilled, cardRows: card.rows });
    out = upsertBinding(out, entry);
    for (const f of picFilled) {                      // 后续自动绑定避让本次占的槽
      const kindObj = snap[f.kind];
      if (kindObj && kindObj[String(f.idx)] === undefined) kindObj[String(f.idx)] = f.value;
    }
  }
  return out;
}

export function buildFormDataFromProject(project) {
  const proj = project || {};
  const defaults = createProject("").globalParams;
  const srcGlobal = proj.globalParams || {};

  // 14 键直传 (基础值, 后续逐键做值域映射覆写)
  const globals = {};
  for (const k of [
    "比例", "质量", "语言", "配乐", "氛围声",
    "审片门", "默认负面", "音乐文件",
    "关音乐", "关对白", "关水印字幕",
  ]) {
    globals[k] = k in srcGlobal ? srcGlobal[k] : defaults[k];
  }
  // 异名 + 值域映射:
  globals["音乐混入方式"] = mapMusicMixToEngine(
    "音乐混入" in srcGlobal ? srcGlobal["音乐混入"] : defaults["音乐混入"]
  );
  const autoConcatRaw = "全部段生成完自动接成一条片" in srcGlobal
    ? srcGlobal["全部段生成完自动接成一条片"]
    : defaults["全部段生成完自动接成一条片"];
  globals["自动拼接"] = mapAutoConcatToEngine(autoConcatRaw);
  // 异名 3 (D-1 修复, T8 核对表发现: 引擎白名单键为"步数", csv_gen.py:89)
  globals["步数"] = "生成步数" in srcGlobal ? srcGlobal["生成步数"] : defaults["生成步数"];
  // 值域映射 3 键 (比例/质量 数字/审片门整数)
  globals["比例"] = mapRatioToEngine(globals["比例"]);
  globals["质量"] = mapQualityToEngine(globals["质量"]);
  const reviewEngine = mapReviewGateToEngine(globals["审片门"]);
  if (reviewEngine) {
    globals["审片门"] = reviewEngine;
  } else {
    delete globals["审片门"];  // "关" → 不发键, engine fallback 0
  }
  // 值域映射 3 键 (关音乐/对白/水印字幕 boolean → "开"/不发键)
  globals["关音乐"] = mapNegativeToggleToEngine(globals["关音乐"]);
  globals["关对白"] = mapNegativeToggleToEngine(globals["关对白"]);
  globals["关水印字幕"] = mapNegativeToggleToEngine(globals["关水印字幕"]);
  // 若三键映射后皆空, 整体删除键 (csv_gen.py:96 非空才写出, 也符合"全不勾 = 干净")
  for (const k of ["关音乐", "关对白", "关水印字幕"]) {
    if (globals[k] === "") delete globals[k];
  }
  // 值域映射 配乐/氛围声
  const mappedMusic = mapAudioTextToEngine(globals["配乐"]);
  if (mappedMusic) globals["配乐"] = mappedMusic; else delete globals["配乐"];
  const mappedAmbient = mapAudioTextToEngine(globals["氛围声"]);
  if (mappedAmbient) globals["氛围声"] = mappedAmbient; else delete globals["氛围声"];

  // 后处理旧三键（放大/插帧/放大引擎）CSV 通道退役 2026-10-17（批②F-114 笔2·留档）：
  //   原此处有 postfxGatePass 读取（S2-2 T4：mode=="拼接" 且 自动拼接=开 才发
  //   globals["放大"/"插帧"/"放大引擎"]·值域 bool→"开"·对齐引擎 b1 concat_parts 口径）。
  //   后期触发源已整体迁 GUI 侧编排（postfx_* 六键 → core/postfx_pipeline.js·段卡勾选
  //   分组+重跑自动补），提交请求体与后期解耦——存量旧键项目（store 放大=true·新六键未设）
  //   提交后引擎 CSV 后期静默休眠=设计如此·知悉项（R-56 后参数页已停写旧三键·触发源不丢）。
  //   三键描述保留在册=17 键契约不破（store 默认/预设快照仍引用·setup.js R56R57 注）。
  //   退役锁：submit.test.mjs 第四部分（旧三键一律不发·postfx_* 不入请求体）。

  // 注入 1: 提示词
  globals["提示词"] = typeof proj.globalPrompt === "string" ? proj.globalPrompt : "";
  // 注入 2 (T10 D-2 裁决): 批次次数 = String(runCount), 引擎 main.js:4411 String(Math.min(50, rep))
  const runCountNum = parseInt(proj.runCount, 10);
  if (Number.isFinite(runCountNum) && runCountNum >= 1) {
    globals["批次次数"] = String(Math.min(50, runCountNum));
  }
  // 注入 3 (批 2-T1 · v2.1 终订): 模板名 = 项目级手选优先；无项目级时取 gui13.paths.workflow_path 文件名去扩展
  //   消费方 = _buildGenerateBody (data.globals["模板"] → body.workflow)
  const guiPaths = readGuiPaths((arguments[1] || {}).storage);
  const projTpl = srcGlobal["模板"];
  if (typeof projTpl === "string" && projTpl.trim()) {
    globals["模板"] = projTpl;
  } else {
    const tplName = templateNameFromPath(guiPaths.workflow_path);
    if (tplName) globals["模板"] = tplName;
  }

  // mode: projMode 三档同名直传 (legacy 行为)
  const mode = proj.projMode || "分镜";

  // shots
  const segments = Array.isArray(proj.segments) ? proj.segments : [];
  // S3-1 T3: 帧锚点注入前置——shots.map 内需做 @N→first_frame→锚点追加；
  //           pool 装配同样消费 registry/assets，提取 opts 到局部变量复用
  const _opts = arguments[1] || {};
  const _registry = (_opts.registry && typeof _opts.registry === "object") ? _opts.registry : {};
  const _assets = (_opts.assets && typeof _opts.assets === "object") ? _opts.assets : {};

  const shots = segments.map((seg, i) => {
    // B4-T2b: ID 列按段序号 s01 式生成（引擎 csv_gen.py:16 SHOT_HEADER 首列 "ID"·csv_gen.py:25
    //   规范行 {"ID": "s01"}；rerun 前置校验只收非空 ID 进 csv_ids — V1.14 __init__.py:2058-2075）。
    //   GUI 段内部 id 是任意串（导入/复制产生），不透传。
    //   批 K-T3: segSid(i) 单一真值源——seg_pools 的 sid 键域与 shots ID 同源同序（引擎按 ID 取段池）。
    // S3-1 T3: ref 主方案挂用——段 prompt 含 first_frame @N → 自动追加"镜头从图片N开始"
    //   幂等: 已含"镜头从图片"字样则不补（字面前缀匹配·不做同义识别）
    const ffRefN = pickFirstFrameRefForPrompt(seg && seg.prompt, _registry, _assets);
    const finalPrompt = ffRefN != null
      ? appendFirstFrameAnchor(seg && seg.prompt, ffRefN)
      : (seg && typeof seg.prompt === "string" ? seg.prompt : (seg && seg.prompt != null ? String(seg.prompt) : ""));
    const out = {
      ID: segSid(i),
      prompt: finalPrompt,
      "段落时长": seg.durationSec,
      "种子": seg.seed,
      "导出文件名": seg.exportName,
      "角度": seg["角度"],
      // B6-T6: 引擎 SHOT_HEADER 只认全形「镜头角度」（csv_gen.py:16），短键「角度」取空 →
      //   补发全形同值双键；短键保留供 GUI 内部消费方（segcards/assets 预览链）按名读
      "镜头角度": seg["角度"],
      "景别": seg["景别"],
      "运镜方式": seg["运镜方式"],
      "运镜方向": seg["运镜方向"],
      "运镜幅度": seg["运镜幅度"],
      "运镜速度": seg["运镜速度"],
      "焦段": seg["焦段"],
      "氛围": seg["氛围"],
      "情绪": seg["情绪"],
    };
    if (mode === "自定义" && seg.concat === true) {
      // B6-T6: 引擎 derive_seg_flags 只认「是」（batch_core.py:2613），布尔列读侧当否 →
      //   勾选发字符串「是」；未勾不发键（=引擎缺省空列，免第 1 段场景 warning）
      out["与上一片段拼接"] = "是";
    }
    return out;
  });

  // S2-1 B1: pool 装配（T8 遗留补齐）——registry/assets 由视图层注入（第二参 opts）
  //   批 8 T2b: castBindings/poolManual 一并注入（绑定槽占号避让 + 手动槽 media/usages 进池）
  //   批 J-P10: 传入的 castBindings = 存量绑定 + @名字 自动绑定（同名显式绑定优先）——
  //     自动绑定的占号槽同样进占用表，@N 装池照批 8 T2b 规则避让（两通道分权同款）
  const castBindings = applyMentionBindings({
    castBindings: proj.castBindings,
    poolManual: proj.poolManual,
    segments: proj.segments || [],
    globalPrompt: proj.globalPrompt,
    registry: _registry,
    assets: _assets,
  });
  const assembled = buildPool({
    segments: proj.segments || [],
    globalPrompt: proj.globalPrompt,
    registry: _registry,
    assets: _assets,
    castBindings,
    poolManual: proj.poolManual,
  });

  // 批 2-T1: paths 生产（v2 四列表·消费形状不变——runOnly :433-434 / _buildGenerateBody :359 原样读）
  //   仅 workflow_path 非空才发；template_path（T2 取清单用）与 comfyui_dir（本地诊断）及空值一律不发键。
  //   R-59-T2b：server_output_dir 退役不发（残留旧值防 F-N1 拦截）——输出根=workspace_root；空串=引擎自回退。
  const paths = {};
  if (typeof guiPaths.workflow_path === "string" && guiPaths.workflow_path) {
    paths.workflow_path = guiPaths.workflow_path;
  }

  const formData = {
    mode,
    pool: assembled.pool,
    pool_usage: assembled.poolUsage,
    pool_pose_style: assembled.poolPoseStyle,
    poolOverflow: assembled.overflow,
    poolBindingSlots: assembled.bindingSlotCount,  // 批 8 T2b: 溢出文案「绑定卡已占 N 槽」输入
    globals,
    shots,
    // 资源编排元数据 (T4 字段; runOnly 直接消费做序列化)
    resourcesList: Array.isArray(proj.loraChain) ? proj.loraChain : [],
    loraOverrides: proj.loraOverrides || {},
    modelOverrides: (proj.modelOverrides && typeof proj.modelOverrides === "object") ? proj.modelOverrides : {},
    // anchorMirror 暂未参与 submit body; 预留供后续批
  };
  if (Object.keys(paths).length) formData.paths = paths;  // 空值不发键

  // 批 L1 T1（R-29 模板传导）：项目级「模板」真值单独携带 = 原始值 trim（**不经 templateNameFromPath 兜底**
  //   ——兜底值是去扩展裸名，发引擎会 preflight"工作流不存在"400）。
  //   消费方 = runOnly 的顶层 submitBody.workflow_path（引擎只读顶层键；globals["模板"] 仅进 generate_csv
  //   的 body.workflow = 提示词副本编译，对渲染无效）。空值不写键 → 回落应用级 paths.workflow_path（零回归）。
  if (typeof projTpl === "string" && projTpl.trim()) formData.projectWorkflow = projTpl.trim();

  // 批 K-T3: 段级素材池（引擎 #12 seg_pools 一等契约·sid = 段行 ID s01 式）
  //   无段命中 → 空对象 → **不发键**（引擎无键兼容铁律：body 不带 seg_pools = 逐字节现行为）
  if (Object.keys(assembled.segPools).length) formData.seg_pools = assembled.segPools;

  // 批 8 T2a：角色绑定生产——同一转换结果两处同源落键（禁止转换两次产生形态漂移）:
  //   formData.bindings 供行内预览链（preview_prompt body.bindings 数组）；
  //   globals["角色绑定"] JSON 串供 generate_csv（api.md :367·legacy globals.js:966-968 非空才写先例）
  //   转换后为空不写键（零回归守门——无绑定时 formData 形态=现状）
  const bindingsPayload = castBindingsToPayload(castBindings);
  if (bindingsPayload.length) {
    formData.bindings = bindingsPayload;
    globals["角色绑定"] = JSON.stringify(bindingsPayload);
  }
  return formData;
}

// ============================================================================
// 1. 提交链: generate_csv (config 旁车) → submit (csv_path 透传)
// ============================================================================

function _buildGenerateBody(formData) {
  const data = {
    mode: formData.mode || "分镜",
    pool: formData.pool || {},
    pool_usage: formData.pool_usage || {},
    pool_pose_style: formData.pool_pose_style || { Picture: {} }, // S2-1 a2: 姿势样式第三段
    globals: formData.globals || {},
    shots: formData.shots || [],
  };
  if (formData.paths) data.paths = formData.paths;
  // 批 K-T3: 段池带键（引擎 #12 data 顶层键 seg_pools·空对象不发键 = 无段命中逐字节现行为）
  if (formData.seg_pools && Object.keys(formData.seg_pools).length) data.seg_pools = formData.seg_pools;
  const workflowPath = (data.globals && data.globals["模板"]) || "";
  const body = { mode: data.mode, data, config: data };
  if (workflowPath) body.workflow = workflowPath;
  return body;
}

// 战役批2 T5（F-89 a 断点）：@引用 → 引擎权威展开文本回填 shots[].prompt
//   背景: @名字/@N 的描述替换只在预览层合成显示（pvbox buildPvPreview），提交层原文透传
//   → 引擎 CSV prompt 列原样保留「@安安2 跳舞」= 零参考生成（F-89 老板真任务铁证）。
//   口径: 落点在两 gate 之后、_buildGenerateBody 之前（保 gate 零请求拦截·防 @ 段先打
//   预览再被 gate 拒的多余往返）；**并批**（Promise.all）调本模块 previewPrompt 拿引擎权威
//   展开文本回填——逐段串行会把提交前的等待放大 N 倍。
//   请求体字段 row/global/pool/pool_usage/seg_pools 照 previewPrompt 现有入参口径；
//   ⚠ bindings + workflow **必须成对下发**：引擎把名字替换整体锁在 `if "workflow" in body:`
//   分支（__init__.py:4671），缺 workflow 时 bindings_for_assembler 恒 [] 且不跑
//   prepare_row（prompt_assembler.py:848 仅在 bindings 非空时替换）→ 只发五字段 = 展开恒
//   不发生（本修退化为空转）。成对下发口径照 views/segcards.js:1436-1442 先例（该处注释
//   已坐实「只发 bindings 不发 workflow 会被丢弃」）。
//   失败降级: 原文透传 + 结果信封 warnings 携带警示（core 不 toast——:218 惯例「core 出
//   信封、视图层 toast」；此处无 toast import 不得新增），console.warn 同步留痕。
const HAS_MENTION_RE = /@\S/;

async function _expandShotMentions(formData) {
  const shots = Array.isArray(formData.shots) ? formData.shots : [];
  const globals = (formData.globals && typeof formData.globals === "object") ? formData.globals : {};
  // 引擎批 T2（#34）退预展开分流: 判据 = formData.bindings[].name 集（与引擎档 2 检测的
  //   binding_set 同口径；禁用 mentionNameIndex 联想源——纯 Video/Audio 卡名不在绑定集
  //   须照旧预展开）。命中任一绑定名的段整段跳过预展开，@原文透传交引擎 run 期
  //   replace_cast_names 替换（混合段同款整段保留=F-89 前行为）；
  //   bindings 空/缺省 → 零分流（条件短路·行为与现状逐字节一致）。
  const bindingNames = Array.isArray(formData.bindings)
    ? formData.bindings.map((b) => (b && typeof b.name === "string" ? b.name : "")).filter(Boolean)
    : [];
  const idxs = [];
  for (let i = 0; i < shots.length; i++) {
    const p = shots[i] && shots[i].prompt;
    if (typeof p === "string" && HAS_MENTION_RE.test(p)) {
      if (bindingNames.length && scanMentionNames(p, bindingNames).length) continue;  // T2: 命中绑定名 → 保留原文
      idxs.push(i);
    }
  }
  if (!idxs.length) return { shots, warnings: [] };

  const base = {
    globalText: typeof globals["提示词"] === "string" ? globals["提示词"] : "",
    pool: formData.pool || {},
    poolUsage: formData.pool_usage || {},
    segPools: formData.seg_pools,
    mode: formData.mode || "分镜",
  };
  if (Array.isArray(formData.bindings) && formData.bindings.length) base.bindings = formData.bindings;
  const workflowName = typeof globals["模板"] === "string" ? globals["模板"] : "";
  if (workflowName) base.workflow = workflowName;

  const out = shots.slice();
  const warnings = [];
  await Promise.all(idxs.map(async (i) => {
    const id = String((shots[i] && shots[i].ID) || `第${i + 1}段`);
    try {
      const r = await previewPrompt({ ...base, row: shots[i] });
      if (!r.ok || !r.text) {
        warnings.push(`${id}: @引用展开失败（原文透传）`);
        console.warn(`[submit] ${id} @引用展开失败`, r && r.error);
        return;
      }
      out[i] = { ...shots[i], prompt: r.text };
    } catch (e) {
      warnings.push(`${id}: @引用展开异常（原文透传）`);
      console.warn(`[submit] ${id} @引用展开异常`, e);
    }
  }));
  return { shots: out, warnings };
}

export async function generateOnly(formData) {
  // 老板走查批A 1.3：生成步数预校验（不合法 → 零请求拦截）
  const gate = _stepsGate(formData);
  if (gate) return gate;
  // 批 L1 T1（R-29）：项目级模板废除族预校验（零请求拦截）
  const tplGate = _projectTemplateGate(formData);
  if (tplGate) return tplGate;
  // 战役批2 T5（F-89）：两 gate 通过后才做 @引用展开（gate 零请求拦截语义优先）
  const expanded = await _expandShotMentions(formData);
  const body = _buildGenerateBody(expanded.shots === formData.shots
    ? formData
    : { ...formData, shots: expanded.shots });
  const genResp = await request("/h3_batch/generate_csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!genResp.ok) {
    return { ok: false, error: genResp.error };
  }
  const csvPath = genResp.data && genResp.data.path;
  if (!csvPath) {
    return {
      ok: false,
      error: { code: "generate_csv_no_path", msg: t("submit.gen.noPath"), detail: genResp.data, httpStatus: 200 },
    };
  }
  const out = { ok: true, csv_path: csvPath, raw: genResp.data };
  if (expanded.warnings.length) out.warnings = expanded.warnings;
  return out;
}

export async function runOnly(formData, csvPath, opts = {}) {
  // 老板走查批A 1.3：生成步数预校验（不合法 → 零请求拦截）
  const gate = _stepsGate(formData);
  if (gate) return gate;
  // 批 L1 T1（R-29）：项目级模板废除族预校验（零请求拦截）
  const tplGate = _projectTemplateGate(formData);
  if (tplGate) return tplGate;
  if (!csvPath || typeof csvPath !== "string") {
    return { ok: false, error: { code: "run_no_csv_path", msg: t("submit.run.needCsv") } };
  }
  const data = {
    mode: formData.mode || "分镜",
    pool: formData.pool || {},
    pool_usage: formData.pool_usage || {},
    pool_pose_style: formData.pool_pose_style || { Picture: {} }, // S2-1 a2: 姿势样式第三段
    globals: formData.globals || {},
    shots: formData.shots || [],
  };

  const reviewGateRaw = data.globals && data.globals["审片门"];
  const reviewGateN = parseInt(reviewGateRaw, 10);
  const reviewGateOn = Number.isFinite(reviewGateN) && reviewGateN >= 1;
  let skipDoneResolved;
  if (reviewGateOn) {
    skipDoneResolved = true;
  } else if (typeof opts.skipDone === "boolean") {
    skipDoneResolved = opts.skipDone;
  } else {
    skipDoneResolved = true;
  }

  const submitBody = {
    mode: data.mode,
    csv_path: csvPath,
    skip_done: skipDoneResolved,
    port: 0,
    retries: 2,
    // R-20②（批 10-P P-T3）：start_from 透传（缺省 0=全量链零变化·正整数=从第 startFrom+1 段起跑）。
    //   边界声明：start_from>0 的 resume 任务，引擎侧自动拼接产物/后处理三键仅作用于该次子集范围
    //   （K..N 部分片·引擎原生行为·GUI 无需改）；卡墙兜底②（segcards mainClips 空才触发）resume
    //   场景不触（方案审 P3-3.15·本批不动 segcards）。
    start_from: Number.isInteger(opts.startFrom) && opts.startFrom > 0 ? opts.startFrom : 0,
    on_fail: "阻断",
    archive_dir: "",
    input_dir: "",
    server_input_dir: "",
    server_output_dir: "",   // R-59-T2b：恒空串——引擎自回退实际输出根（=workspace_root 所指）
    resources_list: serializeResources(formData.resourcesList),
    resource_overrides: serializeOverrides(formData.modelOverrides),
    lora_overrides: serializeLoraOverrides(formData.loraOverrides),
  };
  // 批 L1 T1（R-29）：项目级模板优先于应用级（顶层键=引擎唯一读口）——无项目级真值时零回归发应用级。
  //   优先级冲突（B4 呈老板知悉）：带项目级存量值的项目，设定页换模板对这类项目不生效。
  if (formData.projectWorkflow) submitBody.workflow_path = formData.projectWorkflow;
  else if (formData.paths && formData.paths.workflow_path) submitBody.workflow_path = formData.paths.workflow_path;
  // 批 K-F1（B 档审核修正笔）: 段池带键（引擎 #9 submit 顶层直通 kwargs）·非空才发键与 _buildGenerateBody 同款守卫
  if (formData.seg_pools && Object.keys(formData.seg_pools).length) submitBody.seg_pools = formData.seg_pools;
  // 批 W1 S1-T4（R-52）：运行子目录键——非空才发（引擎侧空/缺省=现行为时间戳夹）
  if (opts.runSubdir) submitBody.run_subdir = opts.runSubdir;
  const subjectAnchorsText = normalizeSubjectAnchors(opts.subjectAnchors);
  if (subjectAnchorsText) submitBody.subject_anchors = subjectAnchorsText;
  // B7-T1 · C1: live_client_id 恒发非空（api.md #9 契约键·可选 string）——引擎 extra_data
  //   逐提交开 preview_method="auto"（execution.py:731）→ /ws 实时预览帧按本 clientId 路由；
  //   与 core/push.js connectLive 的 URL clientId 同源（getClientId 单源·sessionStorage 持久）
  submitBody.live_client_id = getClientId();

  const subResp = await request("/h3_batch/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submitBody),
    timeoutMs: TIMEOUTS.submit,
  });
  if (!subResp.ok) {
    return { ok: false, error: subResp.error, csv_path: csvPath };
  }
  // 批5 T2 #53 防御补丁（S 级）：200 非 JSON/空体时 normalizeEnvelope 落「旧端点无 ok」分支
  //   回 {ok:true,data:null/undefined}（api.js:341）——此前放行 → stem:undefined → 视图写
  //   stem:"" 永远「运行中」行且不启动轮询。fail-closed：无任务号一律判失败（人话提示），
  //   走视图既有错误路径收口（toast+failed 态·零落行不进轮询）。引擎正常路径恒带 stem。
  if (!subResp.data || typeof subResp.data !== "object" || !subResp.data.stem) {
    return {
      ok: false,
      error: { code: "run_no_stem", msg: t("submit.run.noStem"), detail: subResp.data ?? null, httpStatus: 200 },
      csv_path: csvPath,
    };
  }
  return {
    ok: true,
    stem: subResp.data && subResp.data.stem,
    csv_path: csvPath,
    mode: data.mode,
    raw: subResp.data,
  };
}

export async function submitBatch(formData, opts = {}) {
  const genResult = await generateOnly(formData);
  if (!genResult.ok) {
    return { ok: false, error: genResult.error };
  }
  const csvPath = genResult.csv_path;
  const runResult = await runOnly(formData, csvPath, opts);
  if (!runResult.ok) {
    return { ok: false, error: runResult.error, csv_path: csvPath };
  }
  return runResult;
}

// ============================================================================
// 2. 取消
// ============================================================================

export async function cancelBatch() {
  const r = await request("/h3_batch/cancel", { method: "POST" });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    cancelled: !!(r.data && r.data.cancelled),
    msg: (r.data && r.data.msg) || "",
  };
}

// ============================================================================
// 3. 状态轮询
// ============================================================================

const DEFAULT_EMPTY_GRACE_MS = 60000;

// ---- 引擎探活桥（地基批1档2 T3 建·批3 #48① 摘喂）----
//   core 不反查 views（ESM 纪律）——本模块持 sink·views/settings.js 注册 noteEngineProbe
//   （循 api.js setChipOfflineProbe 先例：core 持 setter·views 注册）。
//   批3 #48①：渲染轮询失败/成功喂全部摘除——渲染轮询喂 _probeMiss 把「引擎忙」误判为
//   「引擎不可达」，成功清零又干扰常驻探活节奏；_probeMiss 只由常驻探活 /system_stats 驱动。
//   sink 注册缝保留（settings.js 注册面零触）·当前产线无喂入方。
let _engineProbeSink = null;
export function setEngineProbeSink(fn) { _engineProbeSink = typeof fn === "function" ? fn : null; }

// ============================================================================
// H6 ④（T2·B5）：审片门暂停边沿 + 停止类通知判定
// ============================================================================

// 审片门暂停边沿（纯函数，1.0 domain/notify.js judgeReviewPause 同义）：
//   仅在「→审片门暂停」那一帧返 true；暂停期多 tick 不重复；放行后再暂停重新触发。
//   入参 cur 必须为裸 phase 字面量——PHASE_MAP（core/api.js）无「审片门暂停」键，
//   经 mapPhase 会归 "idle"，故此处不接映射、只比对原串。
export function judgeReviewPause(prev, cur) {
  return prev !== "审片门暂停" && cur === "审片门暂停";
}

// 段级 stopped 计数（真机原件：停止后顶层 done/failed 恒 0，停止段散落在 shots.*.status）
function _stoppedCount(sd) {
  const shots = (sd && typeof sd.shots === "object" && sd.shots) ? sd.shots : null;
  if (!shots) return 0;
  let n = 0;
  for (const k in shots) {
    const s = shots[k];
    if (s && typeof s === "object" && s.status === "stopped") n++;
  }
  return n;
}

// 停止类通知条目（取消链三处共用同一语义：pollStatus.stop() / submit-bar 取消链 / edit 止损）：
//   有段级数据 → 「已停止 · N 段中止」；无数据（编辑视图止损等）→ 不谎报段数。
export function stoppedNotifEntry(sd) {
  return _stopEntry(_stoppedCount(sd));
}

// 停止口径文案（N=中止段数·0 不谎报具体段数）——#89 T4b 入典 submit.stop.*
function _stopEntry(n) {
  return {
    type: "warn",
    text: n > 0 ? t("submit.stop.segs", { n }) : t("submit.stop.plain"),
  };
}

// 批 9 T3 · 17-1：终态未启动段计数——暂停期 cancel 走引擎 _gate_checkpoint break，
//   未启动段不落 stopped（status 停在 pending 等）；有段级数据按 status 词表数
//   （非 success/failed/stopped 即未启动），无数据按 total-done-failed 差额计。
function _unstartedCount(p, done, failed, total) {
  const shots = (p && p.shots && typeof p.shots === "object") ? p.shots : null;
  if (shots && Object.keys(shots).length) {
    let n = 0;
    for (const k in shots) {
      const st = shots[k] && shots[k].status;
      if (st !== "success" && st !== "failed" && st !== "stopped") n++;
    }
    return n;
  }
  return Math.max(0, total - done - failed);
}

// R-44：失败段号派生（段序 1-based）——单源实现，勿在别处重写正则。
//   键形态 shot_NNN（零填充全量任务）/ sNN（CSV ID 子集任务）→ 数值段序；
//   两形态皆不命中 → 按 shots 出现序兜底（与 syncRunProducts enumIdx 同口径）。
//   消费者：buildNotifEntry（通知段号）+ views 落账 failedSegs + 失败 toast 文案。
export function deriveFailedSegs(payload) {
  const p = (payload && typeof payload === "object") ? payload : null;
  const shots = (p && p.shots && typeof p.shots === "object" && !Array.isArray(p.shots)) ? p.shots : null;
  if (!shots) return [];
  const out = [];
  let enumIdx = 0;
  for (const [k, s] of Object.entries(shots)) {
    const key = String(k);
    const m = key.match(/shot_(\d+)/) || key.match(/^s(\d+)/);
    const segNo = m ? parseInt(m[1], 10) : enumIdx + 1;
    enumIdx++;
    if (s && typeof s === "object" && s.status === "failed") out.push(segNo);
  }
  return out.sort((a, b) => a - b);
}

// S3-4 B2（A006）：轮询终态 → 通知中心条目 {type, text}。
//   文案与 submit-bar 的 pollDoneToast/pollFailedToast 同口径（core 不反向依赖 views，故独立成文）。
// R-44 I5：第二参 projectName（pollStatus opts 管道·rerun/assets 链不传 → 缺省退化旧文案）。
export function buildNotifEntry(payload, projectName) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const done = typeof p.done === "number" ? p.done : 0;
  const failed = typeof p.failed === "number" ? p.failed : 0;
  const total = typeof p.total === "number" ? p.total : 0;
  const name = String(projectName || "").trim();
  // #40 T2 · M1：启动期失败（run_init_error=manifest 前死 / _batch_error=manifest 后死）——
  //   排在 done<total 判定之前：这类终态 done/failed 皆 0·放其后会落 success「生成完成 · 0/0」=谎报。
  const initErr = (p.run_init_error || p._batch_error) || null;
  if (initErr) {
    const reason = String(initErr.exception_message || initErr.exception_type || t("submit.notif.initErrUnknown"));
    return { type: "error", text: t("submit.notif.initErr", { reason }) };
  }
  // 批 M5 T2a（F109）：引擎中断（合成终态）——排在 done<total 判定之前：
  //   合成终态载荷 {running:false, shots:{}} 无 done/total，若放其后会落 success「生成完成 · 0/0」=谎报。
  if (p._engineDeadByNull === true) {
    // 批3 #48④：终态复核确认不可达 → 文案附「引擎忙时可能误报·可稍后重试」（维持现路径+提示）
    const hint = (p._engineUnreachableConfirmed === true) ? t("submit.notif.deadNullHint") : "";
    return { type: "error", text: t("submit.notif.deadNull", { sfx: hint }) };
  }
  if (p._engineDeadAfterEmpty === true) {
    const ms = typeof p._emptyStreakMs === "number" ? p._emptyStreakMs : 0;
    return { type: "error", text: t("submit.notif.deadEmpty", { s: Math.round(ms / 1000) }) };
  }
  // H6 ④：段级 stopped 优先于失败/成功判定（停止后 done=0 failed=0，旧判定会误报「生成完成 0/N」）
  if (_stoppedCount(p) > 0) return stoppedNotifEntry(p);
  if (failed > 0) {
    // R-44：项目名 + 失败段号（段号单源派生·deriveFailedSegs 唯一实现）
    const segs = deriveFailedSegs(p);
    const segText = segs.length
      ? t("submit.notif.failSegs", { list: segs.slice(0, 3).join("、"), more: segs.length > 3 ? t("submit.notif.more") : "" })
      : t("submit.notif.failCount", { failed });
    return { type: "warn", text: name ? `${name}${segText}` : t("submit.notif.partialDone", { done, total, failed }) };
  }
  // 批 9 T3 · 17-1：零失败但 done 不足额 = 有段既没成也没败（未启动即被 break）→ 停止口径，
  //   不误报「生成完成 · N/M」（部分失败形态已由上一分支拦截，此处必为纯未启动缺口）。
  if (done < total) return _stopEntry(_unstartedCount(p, done, failed, total));
  return { type: "success", text: name ? t("submit.notif.doneNamed", { name, done, total }) : t("submit.notif.done", { done, total }) };
}

// 动态 import 保持 core 不依赖 ui（Node/无 DOM 环境静默 no-op）
function _pushNotif(entry) {
  try {
    import("../ui/notif.js").then((m) => {
      if (m && typeof m.push === "function") m.push(entry);
    }).catch(() => { /* 通知中心不可用不影响主链 */ });
  } catch (_) { /* 静默 */ }
}

function _pushTerminalNotif(payload, projectName) {
  _pushNotif(buildNotifEntry(payload, projectName));
  try {
    // X-10 转正（自主排期批 2）：渲染终态提醒音（remind.sound=true 门控·无 AudioContext 静默）
    import("../ui/sound.js").then((m) => {
      if (m && typeof m.playRemindChimeIfEnabled === "function") m.playRemindChimeIfEnabled(payload);
    }).catch(() => { /* 提示音不可用不影响轮询结果 */ });
  } catch (_) { /* 静默 */ }
}

// ============================================================================
// S3-4 B8（空-009·拍板 D 组）：提交落账 —— pollStatus 起点挂一次（只记录·不改提交链路本身）
//   记录 localStorage gui13.submitHistory（ui/queue.js 承载·动态 import 同 notif 惯例）；
//   终态补状态（完成/部分失败/失败），stop() → 已取消。落账失败任何形态都不影响轮询主链。
// ============================================================================
let _queueModP = null;
function _queueMod() {
  if (!_queueModP) {
    try { _queueModP = import("../ui/queue.js").catch(() => null); }
    catch (_) { _queueModP = Promise.resolve(null); }
  }
  return _queueModP;
}

function _historyStart(stem, histOpts) {
  try {
    const h = (histOpts && typeof histOpts === "object") ? histOpts : {};
    return _queueMod()
      .then((m) => (m && typeof m.recordSubmitStart === "function")
        ? m.recordSubmitStart({
            taskId: stem,
            ...(h.attach === true ? { attach: true } : {}),   // G2·#57：恢复链挂载幂等（缺省仍无条件头插）
            ...(typeof h.kind === "string" && h.kind ? { kind: h.kind } : {}),   // G2·#57：行来源字段
          })
        : null)
      .catch(() => null);
  } catch (_) { return Promise.resolve(null); }
}

function _historyEnd(idP, fnName, arg) {
  if (!idP) return;
  try {
    idP.then((id) => {
      if (!id) return;
      _queueMod().then((m) => {
        if (m && typeof m[fnName] === "function") m[fnName](id, arg);
      }).catch(() => { /* 队列视图不可用不影响轮询结果 */ });
    }).catch(() => { /* 静默 */ });
  } catch (_) { /* 静默 */ }
}

export function pollStatus(opts) {
  const stem = opts.stem;
  const outputDir = opts.outputDir;
  const intervalMs = opts.intervalMs ?? 3000;
  const emptyGraceMs = opts.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
  const onTickCb = opts.onTick || (() => {});
  const onErrorCb = opts.onError || (() => {});
  const onFinalCb = opts.onFinal || (() => {});
  // R-44 I5：项目名管道（JS 层传参·引擎协议零改）——缺省/未传 → 终态通知保持旧文案
  const projectName = opts.projectName || "";
  // 批 M5 T2a（F109·档位 B）：引擎无响应失败拍阈值——opt-in，缺省 0 = 完全不计数（rerun/assets 链零变更）
  const deadAfterNulls = (typeof opts.deadAfterNulls === "number" && opts.deadAfterNulls > 0) ? opts.deadAfterNulls : 0;
  // G2·#57：队列落账透传——historyAttach（恢复链挂载幂等·防刷新重建重复行）+ historyKind（行来源字段）
  const historyAttach = opts.historyAttach === true;
  const historyKind = (typeof opts.historyKind === "string" && opts.historyKind) ? opts.historyKind : "";

  let finished = false;
  let resolveOuter;
  const donePromise = new Promise((r) => { resolveOuter = r; });
  const url = `/h3_batch/status?stem=${encodeURIComponent(stem)}&output_dir=${encodeURIComponent(outputDir)}`;

  let seenNonEmptyShots = false;
  let firstEmptyTickMs = null;
  let lastData = null;   // H6 ④：最近一次成功 tick 载荷（停止通知取数兜底）
  let prevPhase = "";    // H6 ④（v2-1）：审片门边沿 prevPhase —— pollStatus 实例级（跨任务/跨实例不残留）
  let nullStreak = 0;    // 批 M5 T2a：连续 null 拍计数（真数据拍清零·仅 deadAfterNulls>0 时被读）

  const histIdP = _historyStart(stem, { attach: historyAttach, kind: historyKind });  // S3-4 B8 落账（起）——只记录，不参与轮询判定

  // H6 ④：停止通知——cancel 端点 join 上限 12s，而"当前段收尾"真机可达 ~23s（中断渲染需退场），
  //   端点回包时 stopped 标记可能尚未落盘。故按 intervalMs 续读 status，直到 running=false
  //   或见 stopped 段（引擎退场·manifest 定型），上限 12 次；超限/读失败用最近 tick 数据兜底（不阻断）。
  function _pushStopNotif() {
    let tries = 0;
    const attempt = () => {
      request(url, { cache: "no-store" })
        .then((r) => {
          const sd = (r && r.ok && r.data) ? r.data : null;
          const settled = !!(sd && (sd.running === false || _stoppedCount(sd) > 0));
          if (settled || tries >= 12) { _pushNotif(stoppedNotifEntry(sd || lastData)); return; }
          tries += 1;
          const t = setTimeout(attempt, intervalMs);
          // Node 单测：续读定时器不吊住测试进程（浏览器 setTimeout 无 unref，guard 后不影响真机）
          if (t && typeof t.unref === "function") t.unref();
        })
        .catch(() => { _pushNotif(stoppedNotifEntry(lastData)); });
    };
    attempt();
  }

  const createPollerFn = createPoller;
  // 批 M5 T2a（B-N1）：终态收尾单一出口——isFinal 分支与「引擎无响应合成终态」共用。
  //   合成路径无条件落终态：不经过 firstEmptyTickMs/emptyGraceMs 宽限门判据（B-N1·全程无数据拍场景
  //   下宽限门永不满足 = 旧 isFinal 恒 false = F109 最需治的死法），也不注入 _engineDeadAfterEmpty（双标记互斥）。
  function _settleFinal(finalData, full) {
    if (finished) return;
    finished = true;
    poller.stop();
    try { onFinalCb(finalData, full); } catch (_) { /* 业务回调异常不阻断 */ }
    _pushTerminalNotif(finalData, projectName);  // S3-4 B2：终态事件 → 通知中心留档（不阻断轮询收尾）
    _historyEnd(histIdP, "recordSubmitFinal", finalData);  // S3-4 B8：终态补状态（同一条·不新增）
    resolveOuter(finalData);
  }
  // 批3 #48④：误报终态复核——落「引擎不可达」合成终态前先复核一次 /h3_batch/status。
  //   引擎可达+批已完跑 → 真数据正常终态收口（不误标 engine_unreachable·重跑渲染误标根治）；
  //   引擎可达但批在跑 → 清零续轮询（活任务不误杀）；
  //   复核仍不可达 → 维持现路径合成终态·载荷带 _engineUnreachableConfirmed
  //   （文案附「引擎忙时可能误报·可稍后重试」·见 buildNotifEntry）。
  //   终态幂等由 _settleFinal 的 finished 守卫（复核在飞期间不再落第二终态）。
  async function _recheckThenSettle(full) {
    let rc = null;
    try { rc = await request(url, { cache: "no-store", timeoutMs: TIMEOUTS.statusPoll }); }
    catch (_e) { rc = null; }   // request 已归一网络错·此处仅防御注塑态抛出
    const rd = (rc && rc.ok && rc.data) ? rc.data : null;
    if (rd && rd.running === false) { _settleFinal(rd, full); return; }
    if (rd) { nullStreak = 0; return; }   // 引擎可达但批在跑 → 不落死态·继续轮询
    _settleFinal({ running: false, shots: {}, _engineDeadByNull: true, _engineUnreachableConfirmed: true }, full);
  }
  const poller = createPollerFn({
    fn: async () => {
      // 批 M5 T2a：显式 timeoutMs=5000（集中表 TIMEOUTS.statusPoll）——缺省走全局 30s，半死引擎下 20 拍 ≈ 600s 与验收脱节
      const r = await request(url, { cache: "no-store", timeoutMs: TIMEOUTS.statusPoll });
      if (!r.ok) return null;
      return r.data;
    },
    intervalMs,
    onTick: (data, full) => {
      if (finished) return;
      try { onTickCb(data, full); } catch (_) { /* 业务回调异常不阻断 */ }
      if (!data) {
        // 批 M5 T2a：失败拍计数（onError 死路·request 内吞网络失败恒走 null-data 拍），真数据拍清零
        if (deadAfterNulls > 0) {
          nullStreak += 1;
          if (nullStreak >= deadAfterNulls) _recheckThenSettle(full);
        }
        return;
      }
      nullStreak = 0;
      lastData = data;
      const running = data && data.running === true;
      const phase = (data && typeof data.phase === "string") ? data.phase : "";
      // H6 ④：审片门暂停边沿（读裸 phase 字面量；实例级 prevPhase 防跨任务残留漏报）。
      //   v2-7 覆盖面注记：只覆盖本 pollStatus 轮询窗口（提交/重跑链）——startMonPoll 监控链不通知（验收勿误判）。
      if (judgeReviewPause(prevPhase, phase)) {
        _pushNotif({ type: "warn", text: t("submit.review.paused") });
      }
      prevPhase = phase;
      const shots = (data && data.shots && typeof data.shots === "object") ? data.shots : {};
      const isEmptyManifest = Object.keys(shots).length === 0;
      // #40 T2 · D2①/M1：启动期失败双通道（run_init_error=manifest 落盘前死 / _batch_error=manifest 后死）
      //   带键 → 立即终态（不等空清单宽限门：旧口径空等 60s 后误报「引擎失联」/ 谎报「任务完成」）
      //   且不落 _engineDeadAfterEmpty（那是引擎失联标记·与启动失败互斥·双标记不并列）。
      const initErr = (data && (data.run_init_error || data._batch_error)) || null;
      if (!isEmptyManifest) {
        seenNonEmptyShots = true;
        firstEmptyTickMs = null;
      }
      // 批 W1 R-62（老板定版 2026-10-11「渲染完成 GUI 立即恢复·拼接视频晚几秒出现在产物区」）：
      //   isFinal 只看 running——引擎 run() 返回即终态，收尾期 phase（拼接中/归档中/清点中）
      //   降级纯展示不再阻断终态（字段保留·引擎协议零改）。空清单宽限门保留（F109 引擎死接缝不放宽）。
      let isFinal = !running && (
        initErr
          ? true
          : (seenNonEmptyShots
            ? true
            : (firstEmptyTickMs != null && (Date.now() - firstEmptyTickMs) >= emptyGraceMs))
      );
      if (!seenNonEmptyShots && isEmptyManifest && firstEmptyTickMs == null) {
        firstEmptyTickMs = Date.now();
      }
      let finalData = data;
      if (isFinal && !seenNonEmptyShots && !initErr) {
        const elapsed = firstEmptyTickMs != null ? (Date.now() - firstEmptyTickMs) : 0;
        finalData = { ...data, _engineDeadAfterEmpty: true, _emptyStreakMs: elapsed };
      }
      if (isFinal) _settleFinal(finalData, full);
    },
    onError: (err) => {
      if (finished) return;
      onErrorCb(err);
    },
  });
  poller.start();
  return {
    promise: donePromise,
    // stop({silent:true})：跳过停止通知 push（概念帧 360s 超时等「前端放弃等待≠用户停止」场景，
    //   防谎报）；recordSubmitCancelled 落账口径不变（批3-T7：仅未终态才落）。
    // stop({quiet:true})：深度静默（批3-T5）——页面卸载停环等「旁观清理」场景：连「已取消」队列
    //   历史也不落（引擎侧任务实际仍在跑·落已取消=假态，切回由 submit-bar 对账步删旧 running 行
    //   重挂收口·removeRunningByTaskId）；含 silent 语义。
    //   用户主动取消（无参 stop()）仍落已取消+停止通知，口径不变（批3-T7：仅未终态）。
    stop: (stopOpts = {}) => {
      const wasFinished = finished;   // H6 ④（v2-5）：已终态跳过 push（恢复链/同 stem 切换复用不误发）
      finished = true;
      poller.stop();
      const quiet = !!(stopOpts && stopOpts.quiet);
      // 批3-T7：落账补 wasFinished 守卫——自然终态已落 recordSubmitFinal（done/failed），后续无参
      //   stop()（同 stem 复用/旧句柄清理）不得把已完成条目翻成「已取消」。
      if (!quiet && !wasFinished) _historyEnd(histIdP, "recordSubmitCancelled");  // S3-4 B8：取消路径不入终态
      if (!wasFinished && !(stopOpts && stopOpts.silent) && !quiet) _pushStopNotif();  // H6 ④：未终态才补停止通知
      resolveOuter(null);
    },
  };
}

// ============================================================================
// 4. 预览
// ============================================================================

export async function previewPrompt(opts) {
  const row = opts.row || {};
  const globalText = opts.globalText || "";
  const pool = opts.pool || {};
  const poolUsage = opts.poolUsage || {};
  const negativeMusic = !!opts.negativeMusic;
  const negativeDialogue = !!opts.negativeDialogue;
  const negativeText = !!opts.negativeText;

  const body = {
    row,
    global: globalText,
    pool,
    pool_usage: poolUsage,
    negative_music: negativeMusic,
    negative_dialogue: negativeDialogue,
    negative_text: negativeText,
    negative: negativeMusic || negativeDialogue || negativeText,
    mode: opts.mode || "分镜",
  };
  // 批 8 T2a：bindings 双路径——显式传参透传（现状保留·含空数组）；缺省时经
  //   opts.project.castBindings 用 castBindingsToPayload 生产（与提交链同一转换源），
  //   转换后为空不发键。死端点顺带补齐，最小形态（workflow 仍走 opts.workflow 显式传参）
  if (opts.bindings) {
    body.bindings = opts.bindings;
  } else {
    const produced = castBindingsToPayload(opts.project && opts.project.castBindings);
    if (produced.length) body.bindings = produced;
  }
  if (opts.workflow) body.workflow = opts.workflow;
  if (opts.lang) body.lang = opts.lang;
  // 批 K-T3: 段池带键（引擎 preview_prompt 端点 body 顶层键 seg_pools·按 row.ID 取段池
  //   算段级 12 槽黄条·__init__.py:4711）。空对象/缺省 → 不发键（无段命中零回归）。
  if (opts.segPools && typeof opts.segPools === "object" && Object.keys(opts.segPools).length) {
    body.seg_pools = opts.segPools;
  }
  const subjectAnchorsText = normalizeSubjectAnchors(opts.subjectAnchors);
  if (subjectAnchorsText) body.subject_anchors = subjectAnchorsText;

  const r = await request("/h3_batch/preview_prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    return { ok: false, error: r.error, text: "", warnings: [], errors: [] };
  }
  const checks = (r.data && r.data.checks) || {};
  return {
    ok: true,
    text: (r.data && r.data.text) || "",
    warnings: Array.isArray(checks.warns) ? checks.warns : [],
    errors: Array.isArray(checks.errs) ? checks.errs : [],
  };
}

// ============================================================================
// 5. PDD × turbo 互斥判定
// ============================================================================

export function pddTurboWarning(hasPdd, formData) {
  if (!hasPdd) return false;
  const globals = (formData && formData.globals) || {};
  const steps = String(globals["步数"] || "");
  if (!steps) return false;
  return /A/.test(steps);
}

// ============================================================================
// 6. 段着色
// ============================================================================

export function shotColor(status) {
  switch (status) {
    case "success":   return "green";
    case "rendering": return "yellow";
    case "failed":
    case "void":      return "red";
    default:          return "gray";
  }
}

// ============================================================================
// 7. 进度计数
// ============================================================================

export function progressSummary(sd) {
  const done = (sd && typeof sd.done === "number") ? sd.done : 0;
  const failed = (sd && typeof sd.failed === "number") ? sd.failed : 0;
  const total = (sd && typeof sd.total === "number") ? sd.total : 0;
  if (total === 0) return "0/0";
  const base = t("submit.progress.base", { done, total });
  return failed > 0 ? base + t("submit.progress.failSuffix", { failed }) : base;
}

// ============================================================================
// 8. hasPddTemplate 包装
// ============================================================================

export function getHasPddTemplate() {
  // S1-2 T6 注记: 本仓架构无 core/state.js live binding; 演示态恒 false
  //   真实模板状态归 S2-2 (资源编排 live) / 后续批
  return false;
}

// ============================================================================
// helpers
// ============================================================================

function normalizeSubjectAnchors(v) {
  return (typeof v === "string") ? v.trim() : "";
}
// ============================================================================
// S2-1: pool 装配（详案 B1·T8 遗留 pool 映射补齐）—— 批 8 T2b 占用感知改造
//   引擎契约（__init__.py:7571-7610 + csv_gen.py:38-55 实测）:
//     pool:        {Picture: {槽号: 绝对路径}, Video: {...}, Audio: {...}}
//     pool_usage:  {Picture: {槽号: [usageId,...]}, ...}
//     pool_pose_style: {Picture: {槽号: "skeleton"|"depth"}}  ← 仅 Picture 单 pose 槽有效
//   a4: 槽 9=动态衔接保留槽——@N 分配跳过（引擎 9 号姿势标注黄条忽略，GUI 不送）；
//       手动槽不受此限（G3 胶囊 Picture 9 槽含 9，media 直写）
//   N2: @N 装配范围=仅 pose/first_frame 行（card_cast_rows 白名单排除 pose——不与 cast 分配争抢）
//   批 J-P9（断链①②修）: ①扫描源加 globalPrompt（全局 @N 与段 @N 同池·全局先占）②用途闸门放开到
//     全部 Picture 用途（subject_look/subject_outfit/scene/三视图/道具多角度等·kind 源表=assets_api
//     USAGE_CATALOG 零副本）·pose/first_frame 仍优先占槽、其余取剩余槽、溢出上报同款
//   批 8 T2b 三套数字空间分权（plan v2-2/v2-3）:
//     ①绑定槽先占号不写 media——绑定槽在 pool 产物中仅体现为"不可用"（media 仅 bindings
//        JSON 携带，引擎绑定快照路径自写 pool_copy 已实证 batch_core.py:6765-6767）
//     ②手动槽（poolManual）media+usages 写进 pool/poolUsage（三 kind·GUI 槽位主权）
//     ③@N 扫段装池避让已占槽（绑定+手动都避）
//   溢出: @N pose/first_frame 需求 > 可用槽（8 - 绑定占用 - 手动占用）→ overflow 上报
//   零回归守门: 无绑定+无手动槽时输出=改造前逐字节等价
// ============================================================================

export const POSE_SLOT_SKIP = 9;      // a4: 动态衔接保留槽
export const POSE_SLOT_MAX = 8;       // 1-8 可用
// 批 K 段池视/音域 1-3（引擎 _V3_SLOT_RANGES 同值·SLOT_RANGES assets_api 单一真值源镜像）
export const SEG_AV_SLOT_MAX = 3;
// #89 T4b：槽 kind 显示词入典（submit.kind.*）——数据键 Picture/Video/Audio 不动（引擎契约·tkey=取词键）
const SEG_KIND_LABEL_KEY = { Picture: { tkey: "submit.kind.pic" }, Video: { tkey: "submit.kind.video" }, Audio: { tkey: "submit.kind.audio" } };

// 段行 ID = s01 式零填充两位（裁决 2 sid 键域·引擎按 ID 取段池·与 shots ID 同源同序·禁止两份）
function segSid(i) { return `s${String(i + 1).padStart(2, "0")}`; }

// usage → kind（USAGE_CATALOG 源表·零副本）；未登记用途 → null（不猜 kind）
function usageKindOf(usage) {
  for (const u of USAGE_CATALOG) if (u.id === usage) return u.kind;
  return null;
}
// ---- 批 J-P9 内部: 用途闸门（@N 装池只收 Picture 用途行: video_ref/audio_ref 与未登记 usage 一律不入池） ----
function isPictureUsage(usage) {
  return usageKindOf(usage) === "Picture";
}
// ---- 批 J-P9 内部: 优先档用途（先占槽·其余 Picture 用途按剩余槽序） ----
function isRefPriorityUsage(usage) {
  return usage === "pose" || usage === "first_frame";
}

// 域内可用槽数（段级溢出文案的「已满 N/M」输入·blocked 外的槽位才算可用）
function availableSlots(blocked, max) {
  const s = blocked instanceof Set ? blocked : new Set(blocked || []);
  let n = 0;
  for (let i = 1; i <= max; i++) if (!s.has(i)) n += 1;
  return n;
}

// ---- 批 8 T2b 内部: @N 槽分配游标（buildPool 装池与 computeOccupancy 占用表共享——禁止两份漂移） ----
//   顺序取下一可用槽: 升序 · 跳 skip（a4 Picture 跳 9）· 避 blocked（绑定+手动占用）; 用尽 → null（溢出）
//   批 K-T3: 每个段池一条独立游标（createRefSlotAllocator 每段新建一实例）; max/skip 参数化视/音域
function createRefSlotAllocator(blocked, max, skip) {
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked || []);
  const maxSlot = (Number.isInteger(max) && max > 0) ? max : POSE_SLOT_MAX;
  const skipSlot = (Number.isInteger(skip) && skip > 0) ? skip : POSE_SLOT_SKIP;
  let cur = 0;
  return {
    next() {
      for (;;) {
        cur += 1;
        if (cur === skipSlot) cur += 1;    // a4: 跳 9
        if (cur > maxSlot) return null;    // 域内用尽 → 溢出
        if (blockedSet.has(cur)) continue;  // T2b: 避让绑定/手动占用槽
        return cur;
      }
    },
  };
}

// ---- 批 8 T2b 内部: @N 扫段 → 槽分配（共享实现·两消费方零漂移） ----
//   批 K-T3: 扫描源由「全局词+全部段词」收敛为**单段文本**——批级池与各段 segPools 各调一次，
//     各自持独立游标（裁决 5 每段独立分槽）。
//   onRow(n, cardName, row, slot): 每个占得卡行回调一次; slot=null = 溢出（域内无可用槽）
//   assigned: 同卡同图去重集合（调用方持有·可预置批级已装池的同图·段内不重复占槽）
function scanRefSlotAllocation({ text, registry, assets, alloc, assigned, onRow }) {
  const registryObj = (registry && typeof registry === "object") ? registry : {};
  const assetsObj = (assets && typeof assets === "object") ? assets : {};
  const used = assigned instanceof Set ? assigned : new Set();
  const pending = [];
  const refs = String(text == null ? "" : text).match(/@(\d+)/g) || [];
  const seenN = new Set();
  for (const t of refs) {
    const n = +t.slice(1);
    if (seenN.has(n)) continue;
    seenN.add(n);
    const cardName = registryObj[String(n)];
    const card = cardName ? assetsObj[cardName] : null;
    if (!card || !Array.isArray(card.rows)) continue;
    for (const row of card.rows) {
      if (!row || !row.media) continue;             // 无路径不入池
      if (!isPictureUsage(row.usage)) continue;     // 非 Picture 用途（video_ref/audio_ref/未登记）不入池
      pending.push({ n, cardName, row });
    }
  }
  // 两趟分配: ①pose/first_frame 先行 ②其余 Picture 用途取剩余槽（避让规则同款·溢出同款）
  for (const prio of [true, false]) {
    for (const c of pending) {
      if (isRefPriorityUsage(c.row.usage) !== prio) continue;
      const key = c.cardName + "::" + c.row.media;
      if (used.has(key)) continue;                  // 同卡同图共享同槽（段内/跨批去重）
      used.add(key);
      onRow(c.n, c.cardName, c.row, alloc.next());
    }
  }
  return used;
}

// ---- 批 K-T3 内部: @名字 视/音通道（裁决 6 分叉腿 · buildPool 与 computeOccupancy 共享·零漂移） ----
//   Picture 卡走 applyMentionBindings 绑定通道；Video/Audio 卡走本段 segPools 通道
//   （引擎绑定槽硬编码只写 Picture·视/音进绑定=白建）。
//   texts = [全局词, 某段词]（全局命中对每段生效 → 由调用方逐段传同一 texts）
//   onSlot(kind, idx, media, usage, cardName) 落槽；onOverflow(kind, cardName, avail) 上报段级闸门
//   taken(kind, media): 档2 T3 同卡去重预查（命中卡同 media 已在该段槽 → 跳过该行）
//     预查必须早于 alloc.next()（回调内跳过会虚耗槽号致误溢出·方案 §2.2-4④）
function allocateMentionAv(texts, names, assetsObj, blockedAv, onSlot, onOverflow, taken) {
  if (!names.length) return;
  const allocs = {
    Video: createRefSlotAllocator(blockedAv.Video, SEG_AV_SLOT_MAX, 0),
    Audio: createRefSlotAllocator(blockedAv.Audio, SEG_AV_SLOT_MAX, 0),
  };
  const seen = new Set();
  for (const t of texts) {
    for (const nm of scanMentionNames(t, names)) {
      const card = assetsObj[nm];
      if (!card || !Array.isArray(card.rows)) continue;
      for (const row of card.rows) {
        if (!row || !row.media) continue;
        const kind = usageKindOf(row.usage);
        if (kind !== "Video" && kind !== "Audio") continue;   // Picture 行走绑定通道
        if (taken && taken(kind, row.media)) continue;         // 发号前预查：同 media 已占该段槽 → 跳过
        const key = kind + "::" + row.media;
        if (seen.has(key)) continue;                          // 同段同图只占一槽
        seen.add(key);
        const idx = allocs[kind].next();
        if (idx == null) {
          onOverflow(kind, nm, availableSlots(blockedAv[kind], SEG_AV_SLOT_MAX));
          continue;
        }
        onSlot(kind, idx, row.media, row.usage, nm);
      }
    }
  }
}

// 段池条目容器（三类键恒在·契约要求空类写 {}）
function ensureSegPool(segPools, sid) {
  if (!segPools[sid]) segPools[sid] = { Picture: {}, Video: {}, Audio: {} };
  return segPools[sid];
}

// ---- 排戏台挂槽档2 T3: 段级排戏槽（seg.stagingVideoRefs）装配与占用 ----
//   段级槽形态 = { [槽号字符串]: {media, usages, cardName} }（T1/T2 契约·槽号 "1"-"3"）
//   注入目标 = 段池 segPools[sid].Video[槽]（引擎 #12 seg_pools 契约·槽值 {media,usages,cardName}）
//   #74 G-W2a T4: 段级参考音频槽（seg.stagingAudioRefs）同形态同契约·usages=audio_ref

// ---- #80 运镜来源闸门（段级字段 stagingCamSource = "text" | "ref"）----
//   段级新字段（updateSegment 自由 patch·store.js:400-416 零阻力）；未设/脏值 = "ref" = 现状注入。
//   "text" = 该段只用镜头文字运镜 → 参考视频不注入引擎（无 video_ref 槽 = 无复刻句 = CSV 九字段独走）。
//   闸门单点 = stagingRefsOf（注入点 injectStagingVideoRefs 与段视图 computeOccupancy 共用同一函数）
//   → 提交 / 内联预览 / 重跑三通道同源生效（三通道都走 buildFormDataFromProject 单源）。
//   展示层不闸门（段卡紧凑条仍可见可管槽·用户可随时切回参考）。
export const CAM_SOURCE_REF = "ref";
export const CAM_SOURCE_TEXT = "text";

/** 段级运镜来源（未设/脏值 → "ref" = 现状） */
export function camSourceOf(seg) {
  return (seg && seg.stagingCamSource === CAM_SOURCE_TEXT) ? CAM_SOURCE_TEXT : CAM_SOURCE_REF;
}

function stagingRefsOf(seg) {
  // #80 闸门单点：选「文字运镜」→ 该段参考视频零注入（引擎侧无 video_ref 槽 = 无复刻句）
  if (camSourceOf(seg) === CAM_SOURCE_TEXT) return {};
  const r = seg && seg.stagingVideoRefs;
  return (r && typeof r === "object" && !Array.isArray(r)) ? r : {};
}

// 段级参考音频槽（#74）：与视频槽同容器形态·**不受 #80 运镜来源闸门约束**（闸门只挡视频）
function stagingAudioRefsOf(seg) {
  const r = seg && seg.stagingAudioRefs;
  return (r && typeof r === "object" && !Array.isArray(r)) ? r : {};
}

// 段级槽注入段池 → 返回该段已占槽号（数字·供 blockedAv 避让）
//   槽值契约 {media,usages,cardName[,desc]}：usages 缺省取 defaultUsage（视=video_ref·音=audio_ref）
//   desc = 排戏场景文字摘要（#83·随槽带给引擎作复刻句替换目标·空值不带键=存量段零变化）
function injectStagingRefs(segPools, sid, refs, kind, defaultUsage) {
  const occupied = [];
  for (const key of Object.keys(refs)) {
    const entry = refs[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 1 || idx > SEG_AV_SLOT_MAX) continue;   // 脏槽键兜底
    if (typeof entry.media !== "string" || !entry.media) continue;               // 无 media 不入池
    const slotValue = {
      media: entry.media,
      usages: Array.isArray(entry.usages) ? entry.usages.slice() : [defaultUsage],
      cardName: typeof entry.cardName === "string" ? entry.cardName : "",
    };
    const desc = typeof entry.desc === "string" ? entry.desc : "";
    if (desc) slotValue.desc = desc;
    ensureSegPool(segPools, sid)[kind][String(idx)] = slotValue;
    occupied.push(idx);
  }
  return occupied;
}

function injectStagingVideoRefs(segPools, sid, seg) {
  return injectStagingRefs(segPools, sid, stagingRefsOf(seg), "Video", "video_ref");
}

function injectStagingAudioRefs(segPools, sid, seg) {
  return injectStagingRefs(segPools, sid, stagingAudioRefsOf(seg), "Audio", "audio_ref");
}

// 段池某 kind 已占 media 集合（④b 发号前同卡去重预查·同卡不双占）
function segPoolMediaSet(segPools, sid, kind) {
  const out = new Set();
  const pool = segPools[sid];
  const table = pool && typeof pool === "object" ? pool[kind] : null;
  if (!table || typeof table !== "object") return out;
  for (const key of Object.keys(table)) {
    const entry = table[key];
    if (entry && typeof entry === "object" && typeof entry.media === "string" && entry.media) out.add(entry.media);
  }
  return out;
}

// ---- 批 8 T2b 内部: 手动槽某 kind 占用表 {idx: "manual"} ----
//   槽号 Number 归一·非整数脏键不计（G3 写侧恒数字串——此为兜底）
function manualKindTable(poolManual, kind) {
  const out = {};
  const k = (poolManual && typeof poolManual === "object" && !Array.isArray(poolManual))
    ? poolManual[kind] : null;
  if (k && typeof k === "object" && !Array.isArray(k)) {
    for (const key of Object.keys(k)) {
      const idx = Number(key);
      if (Number.isInteger(idx)) out[idx] = "manual";
    }
  }
  return out;
}

// ---- 批 8 T2b 内部: 绑定槽+手动槽 Picture 占用（占用表前两层 + @N 避让集） ----
//   绑定槽: castBindingsToPayload 同口径归一（非 int/域外 1-8 不计）→ "binding:卡名"
//   手动槽: poolManual.Picture 槽号 → "manual"
//   precedence: 绑定>手动（同 idx 手动不覆写——引擎绑定快照覆写手动 media·提交终局）;
//     双绑定同 idx=脏数据，先到优先（顺序遍历自然先到·不报错）
//   返回 { labels: {idx: 标签}, bindingCount: 绑定占槽数（溢出文案 N） }
function bindingManualPictureOccupancy(castBindings, poolManual) {
  const labels = {};
  let bindingCount = 0;
  for (const entry of castBindingsToPayload(castBindings)) {
    for (const slot of entry.slots) {
      if (labels[slot.idx] === undefined) {
        labels[slot.idx] = "binding:" + entry.name;
        bindingCount += 1;
      }
    }
  }
  const manual = manualKindTable(poolManual, "Picture");
  for (const idx of Object.keys(manual)) {
    if (labels[idx] === undefined) labels[idx] = "manual";
  }
  return { labels, bindingCount };
}

/**
 * 批 8 T2b: 三输入合成占用表（纯函数·pvbox/G3 胶囊等消费）。
 * @param {object} opts
 *   castBindings / poolManual / segments / globalPrompt / registry / assets — 同 buildPool 数据源
 *   segIndex — 批 K-T3: 段序号（0 基·整数）。给出时返回**当前段视图** = 批级占用 ∪ 该段 segPools 段槽
 *     （段槽标签 "seg:@N"·与批级 "ref:@N" 区分）；缺省 = 纯批级视图（段槽不计入）。
 * @returns {{ Picture: {idx: 标签}, Video: {...}, Audio: {...} }}
 *   标签: "binding:卡名"（绑定槽）| "manual"（手动槽）| "ref:@N"（全局 @N 批级槽）| "seg:@N"/"seg:@名字"（段池槽）| "seg:排戏"/"seg:参考音频"（段级视/音槽）
 *   槽号键=数字键（对象键规范化数字串·消费方 Object.keys 直读判别）
 *   Picture = 绑定+手动+全局 @N+（segIndex 时）段池 @N；Video/Audio = 手动 +（segIndex 时）段池视/音
 */
export function computeOccupancy(opts = {}) {
  const { labels } = bindingManualPictureOccupancy(opts.castBindings, opts.poolManual);
  const picture = { ...labels };
  const video = manualKindTable(opts.poolManual, "Video");
  const audio = manualKindTable(opts.poolManual, "Audio");
  const registry = opts.registry;
  const assets = opts.assets;
  const assetsObj = (assets && typeof assets === "object") ? assets : {};

  // 批级：绑定+手动 避让后的全局 @N 槽（与 buildPool 批级扫描同序同源）
  const batchAssigned = new Set();
  scanRefSlotAllocation({
    text: opts.globalPrompt,
    registry, assets,
    alloc: createRefSlotAllocator(Object.keys(labels).map(Number)),
    assigned: batchAssigned,
    onRow: (n, _cardName, _row, slot) => {
      if (slot != null) picture[slot] = "ref:@" + n;
    },
  });

  // 批 K-T3 段视图：该段自己的段池槽（跨段同槽号可放不同素材·互不挤占）
  const segIndex = opts.segIndex;
  if (Number.isInteger(segIndex) && segIndex >= 0) {
    const segs = Array.isArray(opts.segments) ? opts.segments : [];
    const seg = segs[segIndex];
    const segText = seg && seg.prompt;
    // 档2 T3: 段级排戏槽并入段视图 Video 占用（标签 seg:排戏·与提交装配同源）
    //   同源并入 blockedAv（下方 allocateMentionAv 避让）·段级槽不占 Picture
    const stagingRefs = stagingRefsOf(seg);
    const stagingMedia = new Set();
    for (const key of Object.keys(stagingRefs)) {
      const entry = stagingRefs[key];
      if (!entry || typeof entry !== "object" || !entry.media) continue;
      const idx = Number(key);
      if (!Number.isInteger(idx)) continue;
      video[idx] = "seg:" + t("submit.occ.staging");   // 协议前缀 "seg:" 原样（pvbox 按前缀解析）·后缀=显示词
      stagingMedia.add(entry.media);
    }
    // #74 T4: 段级参考音频槽并入段视图 Audio 占用（标签 seg:参考音频·音频不占视域）
    const stagingAudioRefs = stagingAudioRefsOf(seg);
    const stagingAudioMedia = new Set();
    for (const key of Object.keys(stagingAudioRefs)) {
      const entry = stagingAudioRefs[key];
      if (!entry || typeof entry !== "object" || !entry.media) continue;
      const idx = Number(key);
      if (!Number.isInteger(idx)) continue;
      audio[idx] = "seg:" + t("submit.occ.refAudio");   // 同上：前缀协议·后缀显示
      stagingAudioMedia.add(entry.media);
    }
    scanRefSlotAllocation({
      text: segText,
      registry, assets,
      alloc: createRefSlotAllocator(Object.keys(picture).map(Number)),
      assigned: new Set(batchAssigned),          // 批级已装池的同图不重复占段槽
      onRow: (n, _cardName, _row, slot) => {
        if (slot != null) picture[slot] = "seg:@" + n;
      },
    });
    allocateMentionAv(
      [opts.globalPrompt, segText],
      mentionNameIndex(registry),
      assetsObj,
      { Video: Object.keys(video).map(Number), Audio: Object.keys(audio).map(Number) },
      (kind, idx, _media, _usage, cardName) => {
        const table = kind === "Video" ? video : audio;
        table[idx] = "seg:@" + cardName;
      },
      () => {},                                  // 展示层不计溢出（提交前闸门归 buildPool）
      (kind, media) => (kind === "Video" && stagingMedia.has(media))
        || (kind === "Audio" && stagingAudioMedia.has(media)),   // 同卡去重预查（与 buildPool 同源）
    );
  }

  return { Picture: picture, Video: video, Audio: audio };
}

/**
 * pool 装配纯函数（T2b 占用感知 · 批 K-T3 每段独立分槽）。
 * @param {object} opts
 *   segments: [{prompt, stagingVideoRefs, stagingAudioRefs}] — 各段提示词（@N / @名字 段级引用源）+ 段级视/音槽
 *     （档2 T3: stagingVideoRefs 注入段池 Video·#74: stagingAudioRefs 注入段池 Audio·批级池不收·@名字视/音避让之）
 *   globalPrompt: string — 全局提示词（批级引用源·先于段序占槽）
 *   registry: { [n]: cardName } — 资产编号注册表（S2-1 任务 0）
 *   assets:   { [cardName]: card } — 引擎档案卡（listAssets 归一形态）
 *   castBindings: [{name,no,slots:[{idx,...}]}] — 绑定表（占号不写 media·可选）
 *   poolManual: {Picture:{槽号:{media,usages}},Video:{...},Audio:{...}} — 手动槽（可选）
 * @returns {{ pool, poolUsage, poolPoseStyle, segPools, overflow, bindingSlotCount }}
 *   pool/poolUsage/poolPoseStyle = 批级池（**只收全局 @N 命中**·段命中改走段池）
 *   segPools = { [s01]: {Picture:{槽:{media,usages}},Video:{},Audio:{}} }（引擎 #12 seg_pools 契约形态·
 *     sid = 段行 ID s01 式·与 shots ID 同源同序）；**无段命中则空对象 → 调用方不发键**
 *   overflow = 超出域的引用列表（批级 `@N（卡名）` + 段级 `段 N：@X 未入参（单段图槽已满 a/b）`·列名非静默）
 *   bindingSlotCount = 绑定占槽数（溢出文案「绑定卡已占 N 槽」输入）
 */
export function buildPool(opts = {}) {
  const { labels, bindingCount } = bindingManualPictureOccupancy(opts.castBindings, opts.poolManual);
  const blocked = Object.keys(labels).map(Number);
  const registry = opts.registry;
  const assets = opts.assets;
  const assetsObj = (assets && typeof assets === "object") ? assets : {};
  const segmentsArr = Array.isArray(opts.segments) ? opts.segments : [];

  const pool = { Picture: {}, Video: {}, Audio: {} };
  const poolUsage = { Picture: {}, Video: {}, Audio: {} };
  const poolPoseStyle = { Picture: {} };
  const segPools = {};
  const overflow = [];

  // ② 手动槽 media+usages 写进 pool/poolUsage（三 kind·GUI 槽位主权）；
  //   Picture 同 idx 已被绑定占用 → 不写（引擎绑定快照覆写手动 media·提交终局=绑定侧）
  const pm = (opts.poolManual && typeof opts.poolManual === "object" && !Array.isArray(opts.poolManual))
    ? opts.poolManual : {};
  for (const kind of ["Picture", "Video", "Audio"]) {
    const kindObj = (pm[kind] && typeof pm[kind] === "object" && !Array.isArray(pm[kind])) ? pm[kind] : {};
    for (const key of Object.keys(kindObj)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) continue;                // 脏键兜底
      const slot = kindObj[key];
      if (!slot || typeof slot !== "object" || !slot.media) continue; // 无 media 不入池
      // 档2 T3 ①: 排戏来源卡不进批级池（引擎执行侧 F-N2 剔除批级 Video 手动槽·预览假句随之消失）
      //   判定 = 卡名 排戏_段 前缀（槽值无 tags·与存量迁移 isStagingCardName 同口径）
      if (kind === "Video" && isStagingCardName(slot.cardName)) continue;
      if (kind === "Picture" && typeof labels[idx] === "string" && labels[idx].startsWith("binding:")) continue;
      pool[kind][idx] = slot.media;
      poolUsage[kind][idx] = Array.isArray(slot.usages) ? slot.usages : [];
    }
  }

  // ③ 全局 @N 装批级池（避让绑定+手动槽·>8 仍批级溢出上报）
  const batchAssigned = new Set();
  scanRefSlotAllocation({
    text: opts.globalPrompt,
    registry, assets,
    alloc: createRefSlotAllocator(blocked),
    assigned: batchAssigned,
    onRow: (n, cardName, row, slot) => {
      if (slot == null) {                                  // 域内用尽 → 溢出上报
        overflow.push(t("submit.overflow.batchItem", { n, name: cardName }));
        return;
      }
      pool.Picture[slot] = row.media;
      // poolUsage 行 usage 标注（pose / first_frame / subject_look 等），供消费端区分
      poolUsage.Picture[slot] = [row.usage];
      if (row.usage === "pose") {
        const style = row.pose_style === "depth" ? "depth" : "skeleton"; // a2: 缺省骨架（引擎同款兜底）
        poolPoseStyle.Picture[slot] = style;
      }
    },
  });

  // ④ 段 @N 装各段 segPools —— 批 K-T3 每段独立分槽（裁决 5）
  //   段内 blocked = 全局命中 ∪ 显式绑定 ∪ 手动槽（引擎行循环顶部同序·段池条目从其后首个空槽起·
  //   引擎虚拟槽分配不可预知 → GUI 保守预留，不与之抢低位槽）；各段同槽号可放不同素材。
  const segBlocked = blocked.concat(Object.keys(pool.Picture).map(Number));
  const availP = availableSlots(segBlocked, POSE_SLOT_MAX);
  const blockedAv = {
    Video: Object.keys(manualKindTable(pm, "Video")).map(Number),
    Audio: Object.keys(manualKindTable(pm, "Audio")).map(Number),
  };
  const names = mentionNameIndex(registry);
  for (let i = 0; i < segmentsArr.length; i++) {
    const sid = segSid(i);
    const segText = segmentsArr[i] && segmentsArr[i].prompt;
    // ②b 段级排戏槽注入（档2 T3·先于 ④a/④b·段池先占位）
    //   seg.stagingVideoRefs → segPools[sid].Video[槽]（引擎段池真通道·批级池不收）
    const stagingOccupied = injectStagingVideoRefs(segPools, sid, segmentsArr[i]);
    // ②c 段级参考音频槽注入（#74 G-W2a·独立于 #80 运镜闸门）
    const stagingAudioOccupied = injectStagingAudioRefs(segPools, sid, segmentsArr[i]);
    // ③ blockedAv 并入段级已占槽（该段视/音域各自避让·每段独立·跨段同槽号可放不同素材）
    const segBlockedAv = {
      Video: blockedAv.Video.concat(stagingOccupied),
      Audio: blockedAv.Audio.concat(stagingAudioOccupied),
    };
    // ④a @N → 该段 Picture 段池（独立游标·同段内 pose/first_frame 优先·同图不重复占槽）
    scanRefSlotAllocation({
      text: segText,
      registry, assets,
      alloc: createRefSlotAllocator(segBlocked),
      assigned: new Set(batchAssigned),          // 批级已装池的同图不进段池（全局命中每段本就可见）
      onRow: (n, cardName, row, slot) => {
        if (slot == null) {                      // 单段图槽用尽 → 段级列名上报（裁决 8·#19① 纯卡名）
          overflow.push(t("submit.overflow.segPic", { n: i + 1, name: cardName, avail: availP, max: POSE_SLOT_MAX }));
          return;
        }
        ensureSegPool(segPools, sid).Picture[slot] = { media: row.media, usages: [row.usage] };
      },
    });
    // ④b @名字 命中 Video/Audio 卡 → 该段视/音段池（裁决 6 分叉腿·全局词命中对每段生效）
    //   档2 T3: 同卡去重发号前预查（命中卡同 media 已在该段槽 → 跳过该行·不虚耗槽号致误溢出）
    const occupiedMedia = {
      Video: segPoolMediaSet(segPools, sid, "Video"),
      Audio: segPoolMediaSet(segPools, sid, "Audio"),
    };
    allocateMentionAv(
      [opts.globalPrompt, segText],
      names, assetsObj, segBlockedAv,
      (kind, idx, media, usage) => {
        ensureSegPool(segPools, sid)[kind][idx] = { media, usages: [usage] };
      },
      (kind, cardName, avail) => {
        overflow.push(t("submit.overflow.segAv", { n: i + 1, name: cardName, kind: t(SEG_KIND_LABEL_KEY[kind].tkey), avail, max: SEG_AV_SLOT_MAX }));
      },
      (kind, media) => occupiedMedia[kind].has(media),
    );
  }

  return { pool, poolUsage, poolPoseStyle, segPools, overflow, bindingSlotCount: bindingCount };
}
