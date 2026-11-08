// settings.js — 设置页视图（GUI1.3 S1-2 T7）
//
// === 出处注记（任务单描述对齐 v43） ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 设置页 #view-config :1731-1810
//   - 提示词模板三 textarea :1761-1772（tplThreepov/tplScene/tplProp）+ 恢复默认
//   - 提醒与恢复 :1774-1789（remindSound/remindNotify/crashRecover + 数据根目录 + 迁移 3s 两次确认 + dangerLevel 三档）
//   - ComfyUI 启动参数 :1753-1759（目录 + 启动参数 input + 引擎状态灯 + 启动引擎按钮）
//   - 三态芯片 #engChip :1060（v41：未连接灰/启动中黄/已连接绿 + 与设置页同源双向同步 ·
//     快批⑦起挂壳层固定右上角槽位，不再随各视图顶栏行内）
//
// === 本批（T7）实装边界 ===
//  实装（4 件）：
//    ① 提示词模板三 textarea + 恢复默认 → localStorage 持久化（gui13.settings.tpl）
//    ② 提醒与恢复 三开关（sound/notify/crashRecover）→ localStorage 持久化；
//       notify 接 notification-adapter.ensurePermission + show 真实通知；sound 为占位 stub；
//       crashRecover 开关持久化（恢复逻辑归后续批）
//    ③ ComfyUI 启动参数 input → localStorage 持久化（预填 8190）；
//       引擎状态灯 + 启动引擎按钮 = 真实探测 /system_stats（S3-4c 统一出口）
//    ④ 顶栏三态芯片 = 真实探测（页面载入 + 手动刷新时探测，不做常驻轮询）；
//       与设置页灯同源（共享 _chipState 单例）；S3-4c：点击 → 启停 confirm → 引擎控制通道
//
// === 批 R4（总清单 ⑧ §5.A/§5.B + S6 · 原型 :1731-1795）===
//  页面骨架 .proj-top(+inh) + .fillpanel；分组一律 .cfgsec+.cap 纯文字形态（J5 裁决还原原型），
//  七组按原型顺序：工作区与目录 / 模板与工作流 / 引擎与模型 / ComfyUI 引擎指向 /
//  提示词模板自定义（三视图 / 场景画布 / 道具画布） / 提醒与恢复 / 界面。
//  批 R5（B-1 ①）：「AI 对话归档」组自设置页迁出 → 归档折叠区落 AI 页左栏（ai-archive.js），
//  分组还原为原型七组；onArchiveMount 挂载钩子随组一并移除。
//  偏好 cbox（uiFont）= PREF_KEY
//  持久化 + body.bigui 即时生效（dangerLevel/exitBehavior 假开关已随体验修复 A 块摘除）；
//  视频模型下拉（登记项 8）= 同 PREF_KEY 持久化 + 初值回填（裁甲：LLM 通道下拉退役·UI 偏好不控制实际调用）；
//  批 2-T2：工作流模板 = cbox 引擎真数据（GET /h3_batch/templates?dir=…·选中写 gui13.paths.workflow_path
//  + 行内族 hint）；
//  批 2-T3：浏览钮换真（openPicker 服务器文件浏览器·摘 registerPending）——视频输出到 / 模板路径 /
//  工作流模板（file+.json+两层扫描）/ ComfyUI 目录四处；工作区行无写入目标、表格目录 YAGNI → 维持占位；
//  模板路径变更（手输/浏览）→ 重取模板清单（T2 遗留清偿）。
//  批 6-T1：「预设…」换真（core/llm_presets.js · 引擎 #49 CRUD 弹窗·摘 registerPending）；
//  裁甲（2026-10-25）：LLM 通道下拉退役（UI 偏好不控制实际调用）→ 预设入口独立成行。
//  无通道（file picker /
//  节点检测安装 / 崩溃恢复 / 数据迁移——后两件批 0-T3 换装）= registerPending 登记。
//  体验修复 A 块（2026-10-25）：上述暂未实装占位（工作区浏览/表格目录高级/节点检测/崩溃恢复）
//  连同 registerPending 通道整组摘除——设置页不再挂待实装占位。
//  本仓实况差异（有据）：端口 8190（J4）· cfArgs 8190 · 数据根目录 v=（空 · 待壳形态接入）·
//  k「数据根目录（演示态）」（B22 保留）。
//  不实装（登记 docs/空挂清单.md）：目录/模板路径选择器、节点检测安装、
//  声音播放/崩溃恢复执行、迁移执行（X-05~X-11 · S3-4）。
//  S3-4c 边界：引擎启停 = 控制层（confirm + 三态 + 单一探测通道）；真进程管理需壳形态/引擎端点。
//
// === API（纯逻辑层单测覆盖） ===
//   TP_KEY / REMIND_KEY / CF_ARGS_KEY          · 全局存储键（跨项目共享）
//   PATHS_KEY / PATHS_DEFAULTS                 · 批 2-T1 路径四键（gui13.paths·全局共享）
//   TP_DEFAULTS / REMIND_DEFAULTS / CF_ARGS_DEFAULT / PREF_DEFAULTS
//   CHAT_TIMEOUT_SEC_MIN / CHAT_TIMEOUT_SEC_MAX / CHAT_TIMEOUT_SEC_DEFAULT / clampChatTimeoutSec
//   loadTemplates(s) / saveTemplates(s, tpl)
//   loadPaths(s) / savePaths(s, paths)          · 路径持久化（template_path/workflow_path/server_output_dir/comfyui_dir）
//   loadRemind(s) / saveRemind(s, remind)
//   loadCfArgs(s) / saveCfArgs(s, args)
//   loadEngineAddr(s) / saveEngineAddr(s, addr) · 地基批1档2 T2（账本 #45 GUI 侧）：引擎地址正规配置
//     （聚合子键 engine_addr·与服务侧 devserver 同一文件同一子键·仅本机 host·空串=清除）
//     保存联动 setBase(掰正后基址) + 启动参数 --port 同步（清除则 --port 与基址一并回默认）；
//     checkEngineAddr(addr) = 校验+白话（format/remote）
//   loadEngineDir(s) / saveEngineDir(s, dir) · 地基批1档2 T2b（账本 #46 GUI 侧）：ComfyUI 目录正规配置
//     （聚合子键 engine_dir·与服务侧 devserver 同一文件同一子键·空串=清除回默认）
//     一次性迁移：engine_dir 未设 + 旧 gui13.paths.comfyui_dir 非空 → 首读采纳旧值写聚合子键（旧键停写·读保留兼容）
//   loadFfmpegPath(s) / saveFfmpegPath(s, p) · 地基批1档2 T2b（账本 #46 GUI 侧）：ffmpeg 路径正规配置
//     （聚合子键 ffmpeg_path·与服务侧 devserver 同一文件同一子键·空串=清除回默认）
//   checkEngineDir(dir) / checkFfmpegPath(p) · 绝对路径校验+白话（非空须盘符或 UNC·相对/.. 拒·空串放行；
//     ffmpeg 另附 .exe 后缀建议——提示性·不拒绝）
//   engineBaseForPage(addr, ctx) · 跨源掰正策略（ctx={protocol, origin}·生产取 location）
//     未设/非法→null（不调 setBase）·http(s) 跨源→''·同源→addr·非 http(s)→addr
//   resolveEngineBase({devBase, engineAddr, ctx}) · 基址解析纯函数（index.html boot 第二拍调用）
//     devBase 非空最优先·engineAddr 经掰正接管·皆空回退 null；migrated = 一次性迁移信号
//   loadPref(s) / savePref(s, pref)             · 偏好 cbox（uiFont）+ 视频模型下拉（videoModel）
//     + AI 回复超时（chatTimeoutSec 秒·默认 300·30-900 钳制·老板 2026-10-26 本地模型慢）
//   deriveChipState(s) / engineInfoState(info)  · 三态判定（engineInfoState = 与版本行同一判定）
//   startEngine() / stopEngine()               · 引擎启停通道（S3-4c：芯片与设置页启动钮同链）
//   _test_setBootParams/_test_resetBootParams   · 批 M5 T1 启动轮询注入位（intervalMs/timeoutMs）
//     批 M5 T1（R-47 接真）：startEngine = 一拍探测快路径 → POST /gui13-fs/engine_start（裸 fetch·伴生服务）
//     地基批1档2 T2：_enginePost 收编走 api.js fetchApi 出口 + self 档（恒同源相对·不拼 BASE_URL）
//     → 串行轮询 /system_stats（3s 一拍·150s 上限·URL 参数 gui13.boot_interval_ms/boot_timeout_ms 可覆写）
//     → connected 成功 toast；失败/超时回落 idle + 白话。stopEngine = POST /gui13-fs/engine_stop。
//   MIGRATE_TWICE_CONFIRM_MS / makeMigrateConfirmState() / twoStepConfirmTick(st, now?)
//   getChipState() / setChipState(s) / refreshChip() · 同源双向同步（DOM 渲染层）
//   startEngineProbing()                       · 常驻探活启动入口（幂等·设置页 + 壳层两挂点共用）
//   buildEngChip()                             · 顶栏三态芯片（含点击启停控制）
//   openLlmPresetsModal()                      · 批 6-T1 大语言模型预设管理弹窗（引擎 #49 CRUD）
//   mount(container, opts)                     · 渲染设置页入容器
//
// === 5.4 同源修复 + S3-4c 两遗留清偿（§0.8 / 对抗审 R5） ===
//  历史（对账单 docs/UI对齐对账单-2026-09-25.md §5.4）：状态灯走旧 status 探测
//  (/h3_batch/status)、版本行走 fetchEngineInfo(/system_stats) 两条独立异步链，
//  一成一败即同屏矛盾（真机：灯「未连接」+ 0.35.0）。
//  S3-4c 统一：探测只留 refreshChip → fetchEngineInfo（api.js :342 唯一出口）——
//  挂载/手动刷新/顶栏芯片点击/启动通道全部经此；旧 /h3_batch/status 探测函数连同其单测
//  一并退场（403 被拒端点不再参与芯片判定）。starting 相位回补：startEngine() 置「启动中」，
//  顶栏芯片 + 设置页双灯/标签同源显示「启动中」→ 探测完成同帧转「已连接/未连接」。
//  批 M5 T1（R-47 接真）：「启动中」不再一拍即退（引擎真拉起 1-2 分钟）——置位后由启动链持守到落定。

import { createDesktopAdapter } from "../ui/notification-adapter.js";
import { readAgg, writeAgg, SETTINGS_JSON } from "../core/server_storage.js";  // 批 10-M M-T4
import { showToast } from "../ui/toast.js";
import { fetchEngineInfo, request, setChipOfflineProbe, getBase, setBase, fetchApi } from "../core/api.js";
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件超时值引表·不得就地内联。
import { TIMEOUTS, LLM_CHAT_TIMEOUT_DEFAULT_MS, LLM_CHAT_TIMEOUT_MIN_SEC, LLM_CHAT_TIMEOUT_MAX_SEC } from "../core/timeouts.js";
import { engineInputDir } from "../core/audio_upload.js";
// 地基批1档2 T3（账本 #45 状态面）：引擎地址保存/清除 → 在册 WS 按新址重建
import { rebuildAllLive } from "../core/push.js";
// 地基批1档2 T3：外部探活桥（core 不反查 views —— core/submit.js 持 sink·本模块注册·循 api.js setChipOfflineProbe 先例）
import { setEngineProbeSink } from "../core/submit.js";
import { initDocumentDelegate, setCurrentValue } from "../ui/cbox.js";
import { fetchTemplateList, classifyTemplateFamily, DEPRECATED_TEMPLATE_FAMILIES } from "../core/templates.js";
import { openPicker } from "../ui/path_picker.js";
import { open as openModal } from "../ui/modal.js";
import { listPresets, savePreset, deletePreset } from "../core/llm_presets.js";
import { loadWorkspaceRoot } from "../core/workspace.js";   // R-59 T2：输出根目录读链（server 聚合子键·不走 localStorage）
import { TPL_DEFAULTS } from "../core/prompt_templates.js";   // T5 #1：模板默认正文单一真值源（core 层·生成链同源）
// #41 文档源可配置（T3·GUI 侧）：优化 AI 文档保存即预取（覆盖层 core/prompt_specs.js·boot 亦有挂载）
import { prefetchOptimizeDoc } from "../core/prompt_specs.js";
// #89 T1a 语言包：t() 取词（zh/en 字典·en 缺键回落 zh）+ getLang 当前语言 + setLang 切换 + isValidLang（白名单校验）
import { t, getLang, setLang, isValidLang } from "../core/i18n.js";

// #89 T1a：开/关 显示词（当前语言·页面加载期固定；切换语言走整页 reload 故闭包值恒一致）
const _ON = () => t("settings.common.on");
const _OFF = () => t("settings.common.off");

// ===== 全局键（跨项目共享 · 任务单 #2 验收口径） =====
export const TP_KEY = "gui13.settings.tpl";
export const REMIND_KEY = "gui13.settings.remind";
export const CF_ARGS_KEY = "gui13.settings.cfArgs";
// 批 R4：偏好键（界面字号 · 值接设置持久化；dangerLevel/exitBehavior 假开关已随体验修复 A 块摘除）
export const PREF_KEY = "gui13.settings.pref";
// 批 2-T1：路径四键（全局而非每项目 · 与「项目数据迁引擎侧」长期方案的协调点：
//   输出目录语义 = 引擎默认为空·用户可全局覆盖；提交链读同键生产 formData.paths）
export const PATHS_KEY = "gui13.paths";
// 批Gb T7（R-11）：文件库起跳目录偏好（settings 聚合子键 picker_start_dir 的 localStorage 侧键名；
//   无 legacy 存量 → 只作键名登记，不进 server_storage.AGGREGATES 迁移域）
export const PICKER_DIR_KEY = "gui13.settings.picker_start_dir";

// #76 G1：合并模式音频参照三键（引擎 h3_config 顶层键）。
//   读回填通道 = 本会话写后回显缓存（引擎无 GET 三键端点；不落 GUI 本地/localStorage 键，
//   避免与引擎两套配置）。总关时子键由引擎忽略，GUI 只负责写值。
const _audioRefState = {
  h3_audio_ref_split: false,
  h3_audio_ref_vocals: false,
  h3_audio_ref_background: false,
};
// 测试注入位（照 _test_setBootParams 先例）：种子回填态 / 用例间复位。
export function _test_setAudioRefState(state) {
  for (const k of Object.keys(_audioRefState)) {
    if (state && typeof state[k] === "boolean") _audioRefState[k] = state[k];
  }
}

// 批 10-M M-T4：设置四子键（tpl/remind/cfArgs/pref）迁 server 聚合文件 data/settings.json
//   读 = server 优先 → localStorage 回退（双源过渡）；写 = 内存 + 异步 PUT（localStorage 停写）。
function _aggRead(sub, storage) {
  const v = readAgg(SETTINGS_JSON, sub, storage);
  if (v !== undefined) return v;
  const key = ({ tpl: TP_KEY, remind: REMIND_KEY, cfArgs: CF_ARGS_KEY, pref: PREF_KEY })[sub];
  const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  return st && key ? st.getItem(key) : null;
}
function _aggWrite(sub, value) {
  writeAgg(SETTINGS_JSON, sub, value);
}

export const PATHS_DEFAULTS = {
  template_path: "",      // 模板目录（T2 取模板清单用·不进提交）
  workflow_path: "",      // 工作流模板绝对路径（提交生产 paths.workflow_path + 模板名注入源）
  server_output_dir: "",  // 视频输出目录（提交生产 paths.server_output_dir）
  comfyui_dir: "",        // ComfyUI 目录（地基批1档2 T2b 起为旧键·只读兼容：首读一次性迁 engine_dir·此后停写）
};

// ===== 默认值 =====

// v43 三段式模板 → T5 #1：默认正文迁 core/prompt_templates.js（单一真值源·生成链 resolveTemplate 同源取用）
export const TP_DEFAULTS = TPL_DEFAULTS;

// 三开关持久化（体验修复 A 块：新用户声音/桌面通知默认开·crashRecover 无消费维持关）
export const REMIND_DEFAULTS = { sound: true, notify: true, crashRecover: false };

// 启动参数预填（v43 8189 → 本仓 8190 · 任务单 #1 实装口径）
export const CF_ARGS_DEFAULT = "--port 8190 --listen 127.0.0.1 --disable-auto-launch";

// 偏好默认值（体验修复 A 块：dangerLevel/exitBehavior 保存值全仓无消费 → 假开关随控件一并退役）
// 登记项 8：视频模型下拉入 pref（原型 :1748 首项为默认）；原 :1743 工作流模板硬编码 select
//   批 2-T2 已换 cbox 引擎真数据 → 持久化为 gui13.paths.workflow_path（假文案键 workflowTpl 退场）
//   裁甲（2026-10-25）：LLM 通道偏好键退役（通道下拉不控制任何实际调用·真调用走引擎命名预设）
// 老板 2026-10-26：chatTimeoutSec = AI 回复超时（秒·本地模型慢可调大·30-900 钳制）
export const CHAT_TIMEOUT_SEC_MIN = LLM_CHAT_TIMEOUT_MIN_SEC;
export const CHAT_TIMEOUT_SEC_MAX = LLM_CHAT_TIMEOUT_MAX_SEC;
export const CHAT_TIMEOUT_SEC_DEFAULT = LLM_CHAT_TIMEOUT_DEFAULT_MS / 1000;

export const PREF_DEFAULTS = {
  uiFont: "标准",
  videoModel: "MiniMax H3 · 长视频",
  chatTimeoutSec: CHAT_TIMEOUT_SEC_DEFAULT,
  uiLang: "zh",   // #89 T1a：界面语言（值域 zh|en·读侧 N2 双源规则见 loadPref/getLang）
};

// ===== 通用 storage 适配（可注入；测试与浏览器一致） =====
function _storage(s) {
  if (s && typeof s.getItem === "function") return s;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

function _safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

// ===== 模板读写 =====
export function loadTemplates(storage) {
  const s = _storage(storage);
  if (!s) return { ...TP_DEFAULTS };
  const obj = _aggRead("tpl", s);   // M-T4：server 聚合优先 → 本地回退（已是解析值·不再二次 parse）
  if (!obj) return { ...TP_DEFAULTS };
  // 缺键向前兼容：缺哪键补默认值
  return {
    tplThreepov: typeof obj.tplThreepov === "string" ? obj.tplThreepov : TP_DEFAULTS.tplThreepov,
    tplScene: typeof obj.tplScene === "string" ? obj.tplScene : TP_DEFAULTS.tplScene,
    tplProp: typeof obj.tplProp === "string" ? obj.tplProp : TP_DEFAULTS.tplProp,
  };
}

export function saveTemplates(storage, tpl) {
  const s = _storage(storage);
  if (!s) return false;
  const obj = {
    tplThreepov: typeof tpl?.tplThreepov === "string" ? tpl.tplThreepov : TP_DEFAULTS.tplThreepov,
    tplScene: typeof tpl?.tplScene === "string" ? tpl.tplScene : TP_DEFAULTS.tplScene,
    tplProp: typeof tpl?.tplProp === "string" ? tpl.tplProp : TP_DEFAULTS.tplProp,
  };
  _aggWrite("tpl", obj);   // M-T4：内存 + 异步 PUT（localStorage 停写）
  return true;
}

// ===== 提醒与恢复 =====
export function loadRemind(storage) {
  const s = _storage(storage);
  if (!s) return { ...REMIND_DEFAULTS };
  const obj = _aggRead("remind", s);   // M-T4（已是解析值）
  if (!obj) return { ...REMIND_DEFAULTS };
  return {
    sound: !!obj.sound,
    notify: !!obj.notify,
    crashRecover: !!obj.crashRecover,
  };
}

export function saveRemind(storage, remind) {
  const s = _storage(storage);
  if (!s) return false;
  const obj = {
    sound: !!(remind && remind.sound),
    notify: !!(remind && remind.notify),
    crashRecover: !!(remind && remind.crashRecover),
  };
  _aggWrite("remind", obj);   // M-T4
  return true;
}

// ===== ComfyUI 启动参数 =====
export function loadCfArgs(storage) {
  const s = _storage(storage);
  if (!s) return CF_ARGS_DEFAULT;
  const v = _aggRead("cfArgs", s);   // M-T4（cfArgs 存原始字符串·非 JSON 对象）
  if (typeof v === "string" && v.length > 0) return v;
  return CF_ARGS_DEFAULT;
}

export function saveCfArgs(storage, args) {
  const s = _storage(storage);
  if (!s) return false;
  _aggWrite("cfArgs", String(args == null ? "" : args));   // M-T4
  return true;
}

// ===== 文件库起跳目录偏好（批Gb T7 · R-11 · gui13.settings.picker_start_dir）=====
//   settings 五聚合子键之一（server 优先体系）；无 legacy 存量 → 不进 AGGREGATES 迁移域。
//   消费方 = ui/path_picker.js 起跳链（explicit → 偏好 → lastDir → 引擎默认·两侧契约不互引键面量）。
export function loadPickerStartDir(storage) {
  const s = _storage(storage);
  if (!s) return "";
  const v = _aggRead("picker_start_dir", s);
  return typeof v === "string" ? v.trim() : "";
}

export function savePickerStartDir(storage, dir) {
  const s = _storage(storage);
  if (!s) return false;
  _aggWrite("picker_start_dir", String(dir == null ? "" : dir).trim());
  return true;
}

// ===== 引擎地址（地基批1档2 T2 · 账本 #45 GUI 侧 · 聚合子键 engine_addr）=====
//   正规配置键——与服务侧 devserver 读同一文件同一子键（data/settings.json·T1 已落），
//   改一处 GUI 请求链/看护脚本/白名单全链跟随。合法形 = 完整 origin "http://127.0.0.1:8190"
//   （^https?://[\w.\-]+:\d+$）；仅本机 host（127.0.0.1 / localhost）——远程形态归 #48 范围。
//   空串 = 清除（回默认）。无 legacy 存量 → 不进 AGGREGATES 迁移域（同 picker_start_dir）。
const ENGINE_ADDR_RE = /^https?:\/\/[\w.\-]+:\d+$/;
const ENGINE_ADDR_HOSTS = ["127.0.0.1", "localhost"];
// 引擎默认端口（CF_ARGS_DEFAULT 派生·本仓 8190·J4）——清除地址时启动参数回写用
const ENGINE_PORT_DEFAULT = (/(?:^|\s)--port\s+(\d+)/.exec(CF_ARGS_DEFAULT) || [])[1] || "8190";
// 引擎默认基址（非 http(s) 形态兜底·同 api.js 模块默认 http://127.0.0.1:8190）
const ENGINE_BASE_DEFAULT = "http://127.0.0.1:8190";

// 校验（纯函数）：{ok:true, addr} | {ok:false, reason, msg}
export function checkEngineAddr(addr) {
  const s = String(addr == null ? "" : addr).trim();
  if (s === "") return { ok: true, addr: "" };
  if (!ENGINE_ADDR_RE.test(s)) return { ok: false, reason: "format", msg: t("settings.engineAddr.errFormat") };
  let host = "";
  try { host = new URL(s).hostname; } catch (_e) { host = ""; }
  if (!ENGINE_ADDR_HOSTS.includes(host)) return { ok: false, reason: "remote", msg: t("settings.engineAddr.remoteUnsupported") };
  return { ok: true, addr: s };
}

// 页面上下文（生产取 location·单测可注入 ctx={protocol, origin}）
function _pageCtx() {
  const loc = (typeof globalThis !== "undefined" && globalThis.location) || null;
  return {
    protocol: String((loc && loc.protocol) || ""),
    origin: String((loc && loc.origin) || ""),
  };
}

// 跨源掰正策略（仓内既有策略·同 index.html:45-57 块：引擎 Origin 校验+CORS·直连跨源会 403）
//   addr 空/非法 → null（调用方不调 setBase·维持现状：http(s) 模块默认 ""·file:// 8190 兜底）
//   http(s) 且跨源 → ""（同源相对·devserver FWD 按 engine_addr 转发·T1 每请求现读）
//   http(s) 同源 → addr；非 http(s)（file: 等）→ addr（直连）
export function engineBaseForPage(addr, ctx) {
  const chk = checkEngineAddr(addr);
  if (!chk.ok || chk.addr === "") return null;
  const c = ctx || {};
  const protocol = String(c.protocol || "");
  if (!/^https?:$/.test(protocol)) return chk.addr;
  let addrOrigin = "";
  try { addrOrigin = new URL(chk.addr).origin; } catch (_e) { addrOrigin = ""; }
  return addrOrigin === String(c.origin || "") ? chk.addr : "";
}

// 读聚合子键（非法/缺失 → 空串 = 未设·回默认）
export function loadEngineAddr(storage) {
  const s = _storage(storage);
  if (!s) return "";
  const v = _aggRead("engine_addr", s);
  if (typeof v !== "string") return "";
  const chk = checkEngineAddr(v);
  return chk.ok ? chk.addr : "";
}

// 保存：校验 → 落聚合子键 → 联动 setBase(掰正后基址) + 启动参数 --port 同步
//   清除（空串）：--port 回默认 8190 + 基址回默认（http(s)→''·否则 8190 兜底）
//   地基批1档2 T3：联动第三步 = push.rebuildAllLive()（在册 WS 按新基址重建·清除档同走）
export function saveEngineAddr(storage, addr) {
  const s = _storage(storage);
  if (!s) return false;
  const chk = checkEngineAddr(addr);
  if (!chk.ok) return false;
  _aggWrite("engine_addr", chk.addr);
  const ctx = _pageCtx();
  if (chk.addr === "") {
    _syncCfArgsPort(s, ENGINE_PORT_DEFAULT);
    setBase(/^https?:$/.test(ctx.protocol) ? "" : ENGINE_BASE_DEFAULT);
  } else {
    setBase(engineBaseForPage(chk.addr, ctx));
    _syncCfArgsPort(s, _portOfAddr(chk.addr));
  }
  rebuildAllLive();   // 联动③：WS 按新基址重建（URL 每连现算·core/push.js）
  return true;
}

// 地址端口派生（取尾端口·不用 URL.port——默认端口会被 URL 归一掉）
function _portOfAddr(addr) {
  const m = /:(\d+)$/.exec(String(addr || ""));
  return m ? m[1] : "";
}

// 启动参数 --port 同步：有 --port 项改其值·无则追加
function _syncCfArgsPort(storage, port) {
  if (!port) return;
  const args = loadCfArgs(storage);
  const re = /--port\s+\d+/;
  const next = re.test(args)
    ? args.replace(re, `--port ${port}`)
    : (args.trim() ? `${args.trim()} --port ${port}` : `--port ${port}`);
  saveCfArgs(storage, next);
}

// ===== 引擎基址解析（纯函数 · index.html boot 第二拍调用）=====
//   devBase（旧口 gui13.dev.base·调用方已过跨源掰正）非空 → 最优先（旧口路径不动·现状不变）；
//   否则正规配置 engine_addr 合法 → engineBaseForPage 掰正后接管（跨源→''·同源/file→addr）；
//   两处皆空/非法 → base=null（调用方不调 setBase·维持现状：模块默认 ''/8190 兜底）。
//   一次性迁移：devBase 非空且 engine_addr 未设 → migrated=true（调用方 writeAgg 落 engine_addr + 清旧口键）。
export function resolveEngineBase({ devBase, engineAddr, ctx } = {}) {
  const dev = String(devBase == null ? "" : devBase).trim();
  const addr = String(engineAddr == null ? "" : engineAddr).trim();
  if (dev !== "") return { base: dev, migrated: addr === "" };
  if (addr !== "" && checkEngineAddr(addr).ok) return { base: engineBaseForPage(addr, ctx), migrated: false };
  return { base: null, migrated: false };
}

// ===== 引擎目录与 ffmpeg 路径（地基批1档2 T2b · 账本 #46 务实档 GUI 面 · 聚合子键 engine_dir/ffmpeg_path）=====
//   正规配置键——与服务侧 devserver 读同一文件同一子键（data/settings.json·T1 已落·每请求现读·空=默认）。
//   校验：非空须绝对路径（Windows 盘符或 UNC）·相对/含 .. 拒 + 白话；空串 = 清除（回默认）。
//   ffmpeg 另附 .exe 后缀建议（提示性·不拒绝）。
//   一次性迁移：engine_dir 未设 + 旧 gui13.paths.comfyui_dir 非空 → 首读采纳旧值并写聚合子键
//   （旧键停写·读保留兼容；已设 engine_dir 不覆盖——含显式清空档·清空后旧值不复活）。

// 绝对路径校验内核（盘符或 UNC·拒相对/..·空串=清除放行）
function _checkAbsPath(raw, label, example) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "") return { ok: true, value: "" };
  if (s.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "traversal", msg: t("settings.path.errTraversal", { label }) };
  }
  const absolute = /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s);
  if (!absolute) {
    return { ok: false, reason: "relative", msg: t("settings.path.errRelative", { label, example }) };
  }
  return { ok: true, value: s };
}

// 校验（纯函数）：{ok:true, dir} | {ok:false, reason, msg}
export function checkEngineDir(dir) {
  const chk = _checkAbsPath(dir, t("settings.row.comfyDir"), "D:\\ComfyUI");
  return chk.ok ? { ok: true, dir: chk.value } : { ok: false, reason: chk.reason, msg: chk.msg };
}

// 校验（纯函数）：{ok:true, path, hint} | {ok:false, reason, msg}（.exe 建议·提示性·不拒绝）
export function checkFfmpegPath(p) {
  const chk = _checkAbsPath(p, t("settings.row.ffmpegPath"), "C:\\ffmpeg\\bin\\ffmpeg.exe");
  if (!chk.ok) return { ok: false, reason: chk.reason, msg: chk.msg };
  const hint = chk.value !== "" && !/\.exe$/i.test(chk.value) ? t("settings.ffmpeg.hintExe") : "";
  return { ok: true, path: chk.value, hint };
}

// 读聚合子键 engine_dir（未设/非法 → 空串 = 回默认）
//   一次性迁移：子键未设 + 旧 gui13.paths.comfyui_dir 非空 → 采纳旧值并写聚合子键（旧键保留只读）
export function loadEngineDir(storage) {
  const s = _storage(storage);
  if (!s) return "";
  const v = _aggRead("engine_dir", s);
  if (typeof v === "string") {
    const chk = checkEngineDir(v);
    return chk.ok ? chk.dir : "";   // 已设（含显式清空档）→ 原样·不迁移
  }
  const legacy = (loadPaths(s).comfyui_dir || "").trim();
  if (legacy) {
    const chk = checkEngineDir(legacy);
    if (chk.ok) {
      _aggWrite("engine_dir", chk.dir);
      return chk.dir;
    }
  }
  return "";
}

// 保存引擎目录：校验 → 落聚合子键（空串 = 清除回默认·旧键 comfyui_dir 不写）
export function saveEngineDir(storage, dir) {
  const s = _storage(storage);
  if (!s) return false;
  const chk = checkEngineDir(dir);
  if (!chk.ok) return false;
  _aggWrite("engine_dir", chk.dir);
  return true;
}

// 读聚合子键 ffmpeg_path（未设/非法 → 空串 = 回默认）
export function loadFfmpegPath(storage) {
  const s = _storage(storage);
  if (!s) return "";
  const v = _aggRead("ffmpeg_path", s);
  if (typeof v !== "string") return "";
  const chk = checkFfmpegPath(v);
  return chk.ok ? chk.path : "";
}

// 保存 ffmpeg 路径：校验 → 落聚合子键（空串 = 清除回默认）
export function saveFfmpegPath(storage, p) {
  const s = _storage(storage);
  if (!s) return false;
  const chk = checkFfmpegPath(p);
  if (!chk.ok) return false;
  _aggWrite("ffmpeg_path", chk.path);
  return true;
}

// ===== 路径持久化（批 2-T1 · gui13.paths） =====
export function loadPaths(storage) {
  const s = _storage(storage);
  if (!s) return { ...PATHS_DEFAULTS };
  const obj = _safeParse(s.getItem(PATHS_KEY), null);
  if (!obj) return { ...PATHS_DEFAULTS };
  const out = {};
  for (const k of Object.keys(PATHS_DEFAULTS)) {
    out[k] = typeof obj[k] === "string" ? obj[k] : "";
  }
  return out;
}

export function savePaths(storage, paths) {
  const s = _storage(storage);
  if (!s) return false;
  const out = {};
  for (const k of Object.keys(PATHS_DEFAULTS)) {
    out[k] = typeof paths?.[k] === "string" ? paths[k] : "";
  }
  s.setItem(PATHS_KEY, JSON.stringify(out));
  return true;
}

// ===== 偏好持久化（批 R4 · 值接设置持久化；dangerLevel/exitBehavior 假开关已随体验修复 A 块退役） =====
// AI 回复超时（秒）：空/非数字 → 默认（invalid=true）；越界 → 就近边界（clamped=true）
export function clampChatTimeoutSec(v) {
  const raw = typeof v === "string" ? v.trim() : v;
  const n = (raw === "" || raw == null) ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    return { sec: CHAT_TIMEOUT_SEC_DEFAULT, clamped: false, invalid: true };
  }
  const rounded = Math.round(n);
  const sec = Math.min(CHAT_TIMEOUT_SEC_MAX, Math.max(CHAT_TIMEOUT_SEC_MIN, rounded));
  return { sec, clamped: sec !== rounded, invalid: false };
}

export function loadPref(storage) {
  const s = _storage(storage);
  if (!s) return { ...PREF_DEFAULTS };
  const obj = _aggRead("pref", s);   // M-T4（已是解析值）
  if (!obj) return { ...PREF_DEFAULTS, uiLang: getLang() };
  return {
    uiFont: typeof obj.uiFont === "string" ? obj.uiFont : PREF_DEFAULTS.uiFont,
    videoModel: typeof obj.videoModel === "string" ? obj.videoModel : PREF_DEFAULTS.videoModel,
    chatTimeoutSec: clampChatTimeoutSec(obj.chatTimeoutSec).sec,
    uiLang: getLang(),   // #89 N2：服务端 uiLang 有则用·无则回落快键·都无 zh（getLang 内置同款双源规则）
  };
}

export function savePref(storage, pref) {
  const s = _storage(storage);
  if (!s) return false;
  _aggWrite("pref", {
    uiFont: typeof pref?.uiFont === "string" ? pref.uiFont : PREF_DEFAULTS.uiFont,
    videoModel: typeof pref?.videoModel === "string" ? pref.videoModel : PREF_DEFAULTS.videoModel,
    chatTimeoutSec: clampChatTimeoutSec(pref?.chatTimeoutSec).sec,
    uiLang: isValidLang(pref?.uiLang) ? pref.uiLang : PREF_DEFAULTS.uiLang,   // #89 T1a 白名单
  });   // M-T4
  return true;
}

// ===== 三态芯片 — 单出口探测与判定 =====
// 探测出口 = refreshChip → fetchEngineInfo（/system_stats，见下）；三态判定见 engineInfoState。
// 旧 status 探测函数（及其三态映射）已于 S3-4c §0.8 统一时退场。

// engineInfoState: fetchEngineInfo 结果 → 芯片态
//   5.4 同源修复的同一判定: ok 且 version 非空才算已连接 — 与版本行展示条件完全一致,
//   不允许"灯绿版本行灰"或反向的半更新。
export function engineInfoState(info) {
  if (info && info.ok === true && typeof info.version === "string" && info.version.length > 0) {
    return "connected";
  }
  return "idle";
}

// deriveChipState: 字符串映射（DOM 渲染层 reset 用）
export function deriveChipState(s) {
  if (s === "idle" || s === "starting" || s === "connected") return s;
  return "idle";
}

// ===== 迁移两次确认 3s 状态机 =====
// 状态机相位：idle → armed（首次确认）→ confirmed（间隔内再确认）/ idle（超时回退）
export const MIGRATE_TWICE_CONFIRM_MS = 3000;

export function makeMigrateConfirmState() {
  return { phase: "idle", firstAt: 0, confirmedAt: 0 };
}

export function twoStepConfirmTick(state, now) {
  const st = state && typeof state === "object" ? state : makeMigrateConfirmState();
  const t = typeof now === "number" ? now : Date.now();
  if (st.phase === "idle") {
    return { phase: "armed", firstAt: t, confirmedAt: 0 };
  }
  if (st.phase === "armed") {
    const gap = t - (st.firstAt || 0);
    if (gap >= MIGRATE_TWICE_CONFIRM_MS) {
      // 超时 → 回 idle
      return { phase: "idle", firstAt: 0, confirmedAt: 0 };
    }
    return { phase: "confirmed", firstAt: st.firstAt, confirmedAt: t };
  }
  if (st.phase === "confirmed") {
    return st; // 幂等
  }
  return { phase: "idle", firstAt: 0, confirmedAt: 0 };
}

// ===== 同源双向同步：芯片状态单例 =====
// 设置页灯 + 顶栏芯片共享 _chipState；任一变更 broadcast 全部已挂载元素
let _chipState = "idle";
const _chipSubs = new Set();

// 「探测完成且=idle」口径（2026-10-17 真机盲区修复③）：_chipState 模块初值=idle 与「探测过确认
// 离线」不可区分——mediaUrl 家族确定离线预切须二态分明（探测完成前不预切·批 B 冷启动裁决）。
// 标记只在 refreshChip（唯一探测出口）探得 idle 时置位；任何 setChipState 写态（含手动 idle/
// starting/connected）即清——探测结论不被非探测来源冒充。引擎回线后再离线由下一次探测重新置位。
let _chipIdleFromProbe = false;
export function isChipOfflineConfirmed() { return _chipIdleFromProbe && _chipState === "idle"; }

export function getChipState() { return _chipState; }
export function setChipState(s) {
  const v = deriveChipState(s);
  _chipIdleFromProbe = false;   // 非探测来源写态 → 探测口径同帧失效（防测试/外部写态冒充探测结论）
  if (v === _chipState) return false;
  _chipState = v;
  for (const fn of _chipSubs) {
    try { fn(v); } catch (_e) { /* 单订阅者错不污染 */ }
  }
  return true;
}
export function subscribeChipState(fn) {
  if (typeof fn !== "function") return () => {};
  _chipSubs.add(fn);
  return function unsubscribe() { _chipSubs.delete(fn); };
}

// 桥接线（模块级一次·core 不反查 views）：api.js mediaUrl 家族经 setChipOfflineProbe 消费本判定
// （先例 = toast.js registerApiBridge → api.setToastBridge）。settings 未被 import 时桥空=不预切。
setChipOfflineProbe(isChipOfflineConfirmed);

// ===== 单一探测出口（S3-4c §0.8 统一） =====
// 版本行绘制由设置页 mount 注册进 _engineInfoPaint（页面未挂载时为空 = 只翻芯片态）。
let _engineInfoPaint = null;

// ===== 批 M5 · T1 · R-47 引擎拉起链（方案 §一.T1）=====
// 轮询参数三源同形（后写胜出）：URL 参数（模块加载时读一次·真机门可注入·B-N7(a)）
//   → 模块默认 → 测试注入位 _test_setBootParams（形态对齐 api.js:50 _test_setTimeoutMs·B-N5）。
//   默认 3s 一拍 / 150s 上限（冷启动 1-2 分钟在案·排期窗口 A-R3）。
const BOOT_INTERVAL_MS = 3000;
const BOOT_TIMEOUT_MS = 150000;
let _bootIntervalMs = BOOT_INTERVAL_MS;
let _bootTimeoutMs = BOOT_TIMEOUT_MS;

function _numFromUrl(name) {
  try {
    const loc = globalThis.location;
    if (!loc || typeof loc.search !== "string" || !loc.search) return null;
    const n = Number(new URLSearchParams(loc.search).get(name));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_e) {
    return null;
  }
}
const _urlBootInterval = _numFromUrl("gui13.boot_interval_ms");
if (_urlBootInterval) _bootIntervalMs = _urlBootInterval;
const _urlBootTimeout = _numFromUrl("gui13.boot_timeout_ms");
if (_urlBootTimeout) _bootTimeoutMs = _urlBootTimeout;

export function _test_setBootParams(p) {
  if (p && typeof p.intervalMs === "number" && p.intervalMs > 0) _bootIntervalMs = p.intervalMs;
  if (p && typeof p.timeoutMs === "number" && p.timeoutMs > 0) _bootTimeoutMs = p.timeoutMs;
}
export function _test_resetBootParams() {
  _bootIntervalMs = BOOT_INTERVAL_MS;
  _bootTimeoutMs = BOOT_TIMEOUT_MS;
}

// 在途守卫：启动链双入口（芯片点击 / 设置页启动钮）防并发点火
let _startInFlight = null;
// 启动轮询在途标记：启动链在途时，外部/自身探测的非 connected 结果不得把芯片从「启动中」掰回 idle
//   （B-3-15）——覆盖整条链（一拍探测 → engine_start → 轮询），否则探测失败那一瞬芯片就掉了「启动中」。
let _bootPolling = false;

// refreshChip: 唯一探测出口——一次 fetchEngineInfo → 芯片三态 + 设置页版本行同帧更新。
//   （chip 点击 / 挂载探测 / 手动刷新 / 启动通道全部经此；旧 /h3_batch/status 探测已退场）
//   批 M5 T1（B-3-15）：启动轮询在途时，外部探测的非 connected 结果只绘制版本行、不掰回芯片态
//   （否则轮询每拍之前的挂载/手动刷新会把「启动中」拍成「未连接」）——守卫落本函数内部，
//   setChipState 全局入口不动，「网络失败→idle」既有锁（settings.test.mjs）零回归。
//   地基批1档2 T3：opts.quiet = 只探测不写态（降态判定权归调用方·常驻探活拍用）；
//   opts.timeoutMs = 单请求超时闸（F109 恢复链口径 10s·批3 #48 自 2s 迁移·timeouts.js 单值；api.js fetchEngineInfo 不收 timeout·本层截断）。
export async function refreshChip(opts = {}) {
  const o = opts || {};
  const info = await _probeFetch(o.timeoutMs);
  const st = engineInfoState(info);
  if (!o.quiet) {
    if (!(_bootPolling && st !== "connected")) setChipState(st);
    if (st === "idle") _chipIdleFromProbe = true;   // 盲区修复③：本轮真实探测探得 idle（在 setChipState 清除之后补记）
    _paintEngineInfo(info);
  }
  return info;
}

// 版本行绘制（设置页挂载时注册进 _engineInfoPaint·页面未挂载时为空 = 只翻芯片态）
function _paintEngineInfo(info) {
  if (!_engineInfoPaint) return;
  try { _engineInfoPaint(info); } catch (_e) { /* 单消费者错不污染主链 */ }
}

// 探活请求（带超时闸）：fetchEngineInfo 走 api.js request（默认 30s 超时·该出口不收 timeout 参数）
//   → 本层以超时闸截断（超时按「不可达」判·归一 timeout 信封·不抛）
async function _probeFetch(timeoutMs) {
  const p = fetchEngineInfo();
  if (!(typeof timeoutMs === "number" && timeoutMs > 0)) return p;
  p.catch(() => { /* 超时闸先落地时·后到的拒绝不炸进程 */ });
  let timer = null;
  const guard = new Promise((res) => {
    timer = setTimeout(() => res({
      ok: false,
      error: { code: "timeout", msg: t("settings.probe.timeout"), detail: null, httpStatus: 0 },
      version: undefined,
      vramTotalMb: undefined,
    }), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  const info = await Promise.race([p, guard]);
  if (timer) clearTimeout(timer);
  return info;
}

// ===== 常驻探活（地基批1档2 T3 · 账本 #45 状态面）=====
//   拍间隔 30s（挂载启动·页面生命周期常驻）；探测体走 refreshChip 同一出口（quiet=不自行写态）。
//   降态防抖 = 连续 2 拍失败才置 idle（单拍失败不动芯片态·防抖）；成功拍清零计数 + 态非 connected 时恢复。
//   批3 #48①：渲染轮询成功/失败喂已摘除——_probeMiss 只由本层常驻探活 /system_stats 驱动
//   （core/submit.js 注入桥注册缝保留系 settings 链约束·观测缝非死代码·见批3 记录 T1 遗留④）。
const PROBE_INTERVAL_MS = 30000;
const PROBE_MISS_LIMIT = 2;      // 连续 2 拍失败才降态
let _probeTimer = null;
let _probeMiss = 0;
let _probeBusy = false;

// 降态（引擎不可达）：置 idle + 版本行同步回落（灯/版本行同帧一致·5.4 口径）
function _degradeChip() {
  if (_bootPolling) return;      // 启动链在途 → 不掰「启动中」（同 refreshChip 守卫）
  setChipState("idle");
  _chipIdleFromProbe = true;     // 探测结论（非探测来源写态）→ 允许离线预切
  _paintEngineInfo({ ok: false });
}

// 外部探活结果喂入同一计数器（ok=false 计 miss·ok=true 清零）
export function noteEngineProbe(ok) {
  if (ok === true) {
    _probeMiss = 0;
    return 0;
  }
  _probeMiss += 1;
  if (_probeMiss >= PROBE_MISS_LIMIT) _degradeChip();
  return _probeMiss;
}

// 常驻探活一拍（探测体同 refreshChip 出口·降态判定权在本层）
async function _probeTick() {
  if (_probeBusy) return null;
  _probeBusy = true;
  try {
    const info = await refreshChip({ quiet: true });
    if (engineInfoState(info) === "connected") {
      _probeMiss = 0;
      if (getChipState() !== "connected") setChipState("connected");
      _paintEngineInfo(info);
    } else {
      _probeMiss += 1;
      if (_probeMiss >= PROBE_MISS_LIMIT) _degradeChip();
    }
    return info;
  } finally {
    _probeBusy = false;
  }
}

// 常驻探活定时器（幂等·重挂不叠加）
//   D1 修正笔（地基批1节点门·审核A §一 条 1）：提为公开入口 startEngineProbing()——
//   挂点由「设置页 mount」扩到「壳 mount」（首页形态即启动·引擎死后芯片降态 + 离线横幅出现）；
//   两个挂点共用本入口·幂等（先启动方持有定时器·后调方 no-op·不双拍）。
export function startEngineProbing() {
  if (_probeTimer) return;
  _probeTimer = setInterval(() => { void _probeTick(); }, PROBE_INTERVAL_MS);
  // Node 单测：定时器不吊住测试进程（浏览器无 unref·不受影响）
  if (_probeTimer && typeof _probeTimer.unref === "function") _probeTimer.unref();
}

// 测试钩子：手动跑一拍常驻探活（单测用·与定时器同一函数）
export function _test_tickProbe() { return _probeTick(); }

// 测试钩子：探活计数/定时器状态
export function _test_probeState() {
  return { miss: _probeMiss, running: !!_probeTimer, intervalMs: PROBE_INTERVAL_MS };
}

// 测试钩子：停常驻探活定时器（单测隔离·产线不调）
export function _test_stopProbe() {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null; }
}

// 外部探活桥注册（core/submit.js 持 sink·本模块喂入同一计数器——core 不反查 views）
setEngineProbeSink(noteEngineProbe);

// ===== 引擎启停通道（S3-4c · 空-012 → 批 M5 T1 接真·方案 §一.T1）=====
// 引擎进程系统能力归同源伴生服务（devserver /gui13-fs/engine_start|engine_stop，方案 §一.T0）——
// 地基批1档2 T2（账本 #45 GUI 侧）收编：走 api.js fetchApi 出口 + self 档（恒同源相对·不拼 BASE_URL）。
//   原绕行缘由（该出口按 file:// 形态把 BASE_URL 兜底成 http://127.0.0.1:8190·探引擎端口而非伴生
//   服务端口）由 self 档消解；且 fetchApi 出口不触 toastBridge——失败白话仍由本层出（无双弹）。
//   file:// 形态 R-47 仍不可用（伴生服务同源前提·已登记边界）。
async function _enginePost(path, body) {
  let resp;
  try {
    resp = await fetchApi(path, {
      self: true,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "network", json: null };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { json = null; }
  if (resp.ok && json && json.ok === true) return { ok: true, status: resp.status, json };
  const code = (json && json.error) || ("http_" + resp.status);
  return { ok: false, status: resp.status, error: String(code), json };
}

// 引擎端口 = 设置页 ComfyUI 启动参数里的 --port（读不到回落 8190 = 端点白名单唯一值）
function _enginePort() {
  try {
    const m = /--port\s+(\d+)/.exec(String(loadCfArgs(null) || ""));
    if (m) return Number(m[1]);
  } catch (_e) { /* 无 localStorage / 未就绪 → 缺省 */ }
  return 8190;
}

// 错误信封 code → 白话（方案 §一.T1.3 六条；表外 code 一律「原因未知」·不向用户裸抛）
function _engineFailText(code, json) {
  const pid = json && json.pid != null ? json.pid : null;
  const pidTxt = pid ? `（PID ${pid}）` : "";
  if (code === "port_taken_by_other") return t("settings.engine.portTaken", { pid: pidTxt });
  if (code === "pid_mismatch") return t("settings.engine.pidMismatch", { pid: pidTxt });
  if (code === "engine_launch_failed") {
    const why = (json && (json.err || json.rc)) || "";
    return t("settings.engine.launchFailed", { why: why ? `（${why}）` : "" });
  }
  if (code === "bad_port") return t("settings.engine.badPort");
  if (code === "engine_start_busy") return t("settings.engine.startBusy");
  if (code === "network") return t("settings.err.companionDown");
  return t("settings.engine.launchFailedUnknown");
}

// set_workspace 错误码 → 白话（R-59 T2·同 _engineFailText 口径：裸 code 不向用户裸抛）
function _workspaceFailText(code) {
  if (code === "bad_root_traversal") return t("settings.ws.errTraversal");
  if (code === "bad_root_relative") return t("settings.ws.errRelative");
  if (code === "bad_root_nodrive") return t("settings.ws.errNoDrive");
  if (code === "bad_body") return t("settings.ws.errBadBody");
  if (code === "settings_write_failed") return t("settings.ws.errWrite");
  if (code === "network") return t("settings.err.companionDown");
  return t("settings.err.saveFailedUnknown");
}

// 应用输出根目录（R-59 T2）：POST set_workspace（写配置+项目数据搬家·伴生服务）→ 状态分叉双文案 toast；
//   引擎运行中**不自动重启**——提示「先停止再启动」两步（伴生服务对活引擎不重拉·R-59-T1 既定行为）。
async function _applyWorkspaceRoot(inp) {
  const res = await _enginePost("/gui13-fs/set_workspace", { root: String(inp.value == null ? "" : inp.value).trim() });
  if (!res.ok) {
    showToast("error", t("settings.ws.saveFailed", { msg: _workspaceFailText(res.error) }));
    return;
  }
  if (res.json && typeof res.json.root === "string") inp.value = res.json.root;   // 回填服务端归一值
  showToast("success", getChipState() === "connected"
    ? t("settings.ws.savedRunning")
    : t("settings.ws.savedNextBoot"));
  const failed = res.json && Array.isArray(res.json.failed) ? res.json.failed : [];
  if (failed.length) {
    console.warn("[set_workspace] 未搬成的项目文件：", failed);
    showToast("warn", t("settings.ws.moveFailed", { n: failed.length }));
  }
}

function _bootFail(code, text, json) {
  setChipState("idle");               // 回落 idle：不卡死「启动中」·可再次点击重试
  showToast("warn", text || t("settings.engine.bootFail", { msg: _engineFailText(code, json) }));
  return { ok: false, error: { code }, version: undefined };
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 启动轮询：串行 setTimeout 链（禁 setInterval·B-3-16），每 _bootIntervalMs 一拍打 /system_stats
//   （单请求 3000ms 覆写·api.js:74），到 _bootTimeoutMs 上限仍未连 → 回落 idle。
//   受理（含 already）与 409 未判死都并入本轮询（A-S1 消竞态·GUI 单一真值出口）。
async function _bootPoll() {
  const deadline = Date.now() + _bootTimeoutMs;
  let reached = false;
  while (Date.now() < deadline) {
    await _sleep(_bootIntervalMs);
    const r = await request("/system_stats", { timeoutMs: TIMEOUTS.bootPoll });
    if (r.ok) { reached = true; break; }
  }
  if (!reached) {
    const span = _bootTimeoutMs >= 1000 ? `${Math.round(_bootTimeoutMs / 1000)}s` : `${_bootTimeoutMs}ms`;
    return _bootFail("boot_timeout", t("settings.engine.bootTimeout", { span }));
  }
  const info = await refreshChip();   // 单出口收尾：芯片 + 版本行同帧（已在位·回刷确认）
  if (engineInfoState(info) !== "connected") return _bootFail("network");
  showToast("success", t("settings.engine.bootConnected"));
  return info;
}

async function _runStart() {
  // 启动链全程持守卫：探测失败那一瞬不得把芯片从「启动中」掰回 idle（B-3-15）
  _bootPolling = true;
  try {
    // 一拍探测快路径：活引擎点芯片 → 探测即连 · 零端点调用（不重拉）
    const info = await refreshChip();
    if (engineInfoState(info) === "connected") {
      showToast("success", t("settings.engine.bootConnected"));
      return info;
    }
    const res = await _enginePost("/gui13-fs/engine_start", { port: _enginePort() });
    if (!res.ok) {
      const fresh = res.error === "engine_start_busy"
        && typeof res.json?.since === "number"
        && Date.now() - res.json.since <= 30000;
      if (!fresh) return _bootFail(res.error, null, res.json);   // 409 且 since 已判死 → 直接回落
    }
    // 受理（含 already）与 409 未判死都并入启动轮询（A-S1 消竞态）
    return await _bootPoll();
  } finally {
    _bootPolling = false;
  }
}

// 启动 = 置「启动中」→ 一拍探测快路径 → POST engine_start → 串行启动轮询 → connected 成功 toast；
//   失败/超时（2b）→ 回落 idle + 白话 + 清在途守卫可重试。
//   在途直接复用同一 Promise（_startInFlight·双入口防并发点火）。
export function startEngine() {
  if (_startInFlight) return _startInFlight;
  setChipState("starting");
  _startInFlight = _runStart().finally(() => { _startInFlight = null; });
  return _startInFlight;
}

// 停止 = POST engine_stop（伴生服务端树杀引擎进程）：受理/noop → idle +「引擎已停止」；失败 → 白话不谎报已停。
export async function stopEngine() {
  const res = await _enginePost("/gui13-fs/engine_stop", { port: _enginePort() });
  if (res.ok) {
    setChipState("idle");
    showToast("success", t("settings.engine.stopped"));
    return { ok: true, noop: !!(res.json && res.json.noop) };
  }
  showToast("error", t("settings.engine.stopFailed", { msg: _engineFailText(res.error, res.json) }));
  return { ok: false, error: { code: res.error } };
}

// confirm 包装：无 confirm 环境（单测/壳）不拦截
function _confirm(msg) {
  const c = typeof globalThis !== "undefined" && typeof globalThis.confirm === "function" ? globalThis.confirm : null;
  if (!c) return true;
  return c(msg) !== false;
}

function _defaultBaseUrl() {
  // 设置页显示用缺省 base（探测口径以 api.js BASE_URL 为唯一源）
  // 地基批1档2 T2：随 getBase() 动态化（getBase 空 = file:///测试桩 → 回退现默认字面量·保测试稳定）
  const b = getBase();
  return (typeof b === "string" && b !== "") ? b : "http://127.0.0.1:8190";
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

// ===== R4 分组/行构件（原型 :634-639 cfgsec/pathrow · :440 cbox · :312 fbtn） =====
function _cfgsec(title, items) {
  const box = el("div", { class: "cfgsec" });
  box.appendChild(el("div", { class: "cap", text: title }));
  for (const it of items) box.appendChild(it);
  return box;
}

function _pathrow(k, children) {
  const row = el("div", { class: "pathrow" });
  row.appendChild(el("span", { class: "k", text: k }));
  for (const c of children) row.appendChild(c);
  return row;
}

// .v 显示（原型 :638 · num = 等宽数字；无 num 的行直接 el 构建）
function _v(text) {
  return el("span", { class: "v num", text });
}

// fbtn 小按钮（原型 :312）
function _fbtn(text, opts = {}) {
  const b = el("span", { class: "fbtn", text });
  if (typeof opts.title === "string") b.title = opts.title;
  return b;
}

// 自制下拉 cbox（原型 :440 形态 · resources.js presetSel 同款接线：change → 视图钩子落库）
function _cbox(id, optsStr, value, title, minWidth, onChange) {
  const box = el("div", { class: "cbox", id, "data-opts": optsStr });
  box.title = title;
  if (minWidth) box.style.minWidth = minWidth;
  box.appendChild(el("span", { class: "cb-v", text: value }));
  box.appendChild(el("span", { class: "cb-a", text: "▾" }));
  box.addEventListener("change", (ev) => {
    const v = ev && ev.detail && ev.detail.value != null ? ev.detail.value : "";
    onChange(v);
  });
  return box;
}

function _select(options, onChange, selected) {
  const sel = el("select");
  for (const o of options) {
    const opt = el("option", { text: o });
    if (o === selected) opt.setAttribute("selected", "selected");
    sel.appendChild(opt);
  }
  // 登记项 8：onChange 统一收字符串值（真机 change 读 e.target.value；测试桩走 e.detail.value）
  sel.addEventListener("change", (e) => {
    const v = e && e.target && e.target.value !== undefined
      ? e.target.value
      : (e && e.detail && e.detail.value);
    if (v !== undefined) onChange(v);
  });
  return sel;
}

function _lampEl(id) {
  const attrs = { class: "eng-lamp " + _lampClass(getChipState()) };
  if (id) attrs.id = id;
  const n = el("span", attrs);
  n.setAttribute("data-eng-lamp", getChipState());
  return n;
}

// 端口行健康词（A9 · connected=健康 / starting=启动中 / idle=未连接）
function _healthText(stateVal) {
  if (stateVal === "connected") return t("settings.health.ok");
  if (stateVal === "starting") return t("settings.state.starting");
  return t("settings.state.disconnected");
}

// ===== 批 6-T1：大语言模型预设管理弹窗（引擎 #49 CRUD · 取码 legacy ai_collab_llm.js:145-271 简化） =====
//   列表态：GET 真数据；失败「引擎未连接」；空「暂无预设——引擎内置 ollama-local / lmstudio-local 可编辑使用」；
//     model 空条目标注「需编辑填模型名」（v2-2：引擎 seed 两条 model 留空）。
//   表单六字段 + 行内错误；api_key type=password + autocomplete=off + placeholder「已保存则留空沿用」；
//     编辑回填五字段（key 恒空）+ name 主键 disabled；空 key 不传 = 域层沿用语义；
//     max_tokens（老板 2026-10-25 · AI 回复截断）位于上下文窗口下方，留空=引擎按窗口/4 默认。
//   删除两次式：首点武装 3s（assets.js DEL_ARM_MS 同款）→ 再点真删。
//   另存为新预设（裁甲② 2026-10-25）：编辑态首点 → name 解锁+聚焦+全选、标题切「另存为新预设（输入新名称）」；
//     再点「另存」/「保存」按新名创建（空名/重名行内拦·成功提示可删旧预设）。
const LLMP_DEL_ARM_MS = 3000;

function _llmpField(inputId, errId, label, opts = {}) {
  const row = el("div", { class: "llmp-field", style: "display:flex;align-items:flex-start;gap:8px;margin-bottom:6px" });
  row.appendChild(el("span", { class: "llmp-lbl", text: label, style: "width:132px;color:var(--txt2);font-size:12px;flex-shrink:0;padding-top:6px" }));
  const col = el("div", { style: "flex:1;min-width:220px" });
  const input = el("input", {
    id: inputId,
    type: opts.type || "text",
    placeholder: opts.placeholder || "",
    autocomplete: "off",
    style: "width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);outline:none",
  });
  if (typeof opts.title === "string") input.title = opts.title;
  col.appendChild(input);
  const err = el("div", { id: errId, class: "llmp-err", style: "display:none;color:#ff6464;font-size:11px;margin-top:2px" });
  col.appendChild(err);
  row.appendChild(col);
  return { row, input, err };
}

export function openLlmPresetsModal() {
  if (typeof document === "undefined") return null;

  const listBox = el("div", { id: "llmpList", class: "llmp-list", style: "border:1px solid var(--line);border-radius:8px;min-height:56px;max-height:240px;overflow:auto;margin-bottom:8px" });
  const formTitle = el("div", { class: "llmp-form-title", text: t("settings.llmp.newPreset"), style: "font-size:12px;color:var(--txt3);margin:2px 0 6px" });
  const fName = _llmpField("llmpName", "llmpErrName", t("settings.llmp.fName"), { placeholder: t("settings.llmp.phName") });
  const fUrl = _llmpField("llmpBaseUrl", "llmpErrBaseUrl", t("settings.llmp.fUrl"), { placeholder: t("settings.llmp.phUrl") });
  const fKey = _llmpField("llmpKey", "llmpErrKey", t("settings.llmp.fKey"), { type: "password", placeholder: t("settings.llmp.phKey") });
  // 裁甲③：model 必须填服务商 API 的模型 ID（显示名会 unknown model·minimax 3.1 事故教训）
  const fModel = _llmpField("llmpModel", "llmpErrModel", t("settings.llmp.fModel"), {
    placeholder: t("settings.llmp.phModel"),
    title: t("settings.llmp.ttModel"),
  });
  const fCw = _llmpField("llmpCw", "llmpErrCw", t("settings.llmp.fCw"), { type: "number", placeholder: t("settings.llmp.phCw") });
  const fMt = _llmpField("llmpMaxTokens", "llmpErrMaxTokens", t("settings.llmp.fMt"), {
    type: "number",
    placeholder: t("settings.llmp.phMt"),
    title: t("settings.llmp.ttMt"),
  });
  const errCommon = el("div", { id: "llmpErrCommon", class: "llmp-err", style: "display:none;color:#ff6464;font-size:11px;margin-top:2px" });
  const saveBtn = el("button", { type: "button", id: "llmpSave", class: "prim", text: t("settings.btn.save") });
  const addBtn = el("button", { type: "button", id: "llmpAdd", class: "ghostbtn", text: t("settings.llmp.newPreset") });
  const saveAsBtn = el("button", { type: "button", id: "llmpSaveAs", class: "ghostbtn", text: t("settings.llmp.saveAs") });

  const content = el("div", { class: "llmp-form" });
  content.appendChild(listBox);
  content.appendChild(formTitle);
  for (const f of [fName, fUrl, fKey, fModel, fCw, fMt]) content.appendChild(f.row);
  content.appendChild(errCommon);
  const actRow = el("div", { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:8px" });
  actRow.appendChild(addBtn);
  actRow.appendChild(saveAsBtn);
  actRow.appendChild(saveBtn);
  content.appendChild(actRow);

  let editingName = null; // 非空 = 编辑态（name 主键 disabled）
  let saveAsFrom = null;  // 非空 = 另存模式（值 = 旧预设名·成功 toast 提示可删）
  let knownNames = [];    // 最近一次列表成功返回的预设名（另存重名拦截）
  let delArm = { name: null, at: 0 };

  function clearErrors() {
    for (const f of [fName, fUrl, fKey, fModel, fCw, fMt]) { f.err.textContent = ""; f.err.style.display = "none"; }
    errCommon.textContent = ""; errCommon.style.display = "none";
  }

  function resetToAdd() {
    editingName = null;
    saveAsFrom = null;
    fName.input.value = "";
    fName.input.disabled = false;
    fUrl.input.value = "";
    fKey.input.value = "";
    fModel.input.value = "";
    fCw.input.value = "32000";
    fMt.input.value = "";
    formTitle.textContent = t("settings.llmp.newPreset");
    clearErrors();
  }

  function fillEdit(p) {
    editingName = p.name;
    saveAsFrom = null;
    fName.input.value = p.name || "";
    fName.input.disabled = true; // 主键：编辑不可改名
    fUrl.input.value = p.base_url || "";
    fKey.input.value = ""; // 关键：api_key 永不回填（回显靠 placeholder）
    fModel.input.value = p.model || "";
    fCw.input.value = (typeof p.context_window === "number") ? String(p.context_window) : "32000";
    fMt.input.value = (typeof p.max_tokens === "number") ? String(p.max_tokens) : "";
    formTitle.textContent = t("settings.llmp.editingTitle", { name: p.name });
    clearErrors();
  }

  function makeRow(p) {
    const row = el("div", { class: "llmp-row", style: "display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12px" });
    row.appendChild(el("span", { class: "llmp-name", text: p.name || "", style: "width:118px;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
    row.appendChild(el("span", { class: "llmp-url", text: p.base_url || "", style: "flex:1;color:var(--txt3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
    const empty = !p.model;
    row.appendChild(el("span", {
      class: "llmp-model",
      text: empty ? t("settings.llmp.needModel") : p.model,
      style: "width:150px;color:" + (empty ? "#e8b339" : "var(--txt)"),
    }));
    // 列表行摘要：上下文窗口 + 最大输出（未配置=默认·老板 2026-10-25）
    const cwText = typeof p.context_window === "number" ? String(p.context_window) : "-";
    const mtText = typeof p.max_tokens === "number" ? t("settings.llmp.mtValue", { n: p.max_tokens }) : t("settings.llmp.mtDefault");
    row.appendChild(el("span", {
      class: "llmp-cw",
      text: t("settings.llmp.cwSummary", { cw: cwText, mt: mtText }),
      style: "width:170px;color:var(--txt3);white-space:nowrap",
    }));
    const ops = el("div", { class: "llmp-ops", style: "display:flex;gap:6px" });
    const editBtn = el("button", { type: "button", class: "ghostbtn", text: t("settings.btn.edit") });
    editBtn.addEventListener("click", () => fillEdit(p));
    const delBtn = el("button", { type: "button", class: "ghostbtn", text: t("settings.btn.delete") });
    delBtn.addEventListener("click", () => { void onDelete(p.name); });
    ops.appendChild(editBtn);
    ops.appendChild(delBtn);
    row.appendChild(ops);
    return row;
  }

  function renderList(r) {
    while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
    knownNames = [];
    if (!r || !r.ok) {
      listBox.appendChild(el("div", { class: "llmp-empty", text: t("settings.llmp.engineNotConnected"), style: "padding:10px;color:var(--txt3);font-size:12px" }));
      return;
    }
    const presets = r.presets || [];
    knownNames = presets.map((p) => (p && typeof p.name === "string" ? p.name : "")).filter(Boolean);
    if (!presets.length) {
      listBox.appendChild(el("div", {
        class: "llmp-empty",
        text: t("settings.llmp.empty"),
        style: "padding:10px;color:var(--txt3);font-size:12px",
      }));
      return;
    }
    for (const p of presets) listBox.appendChild(makeRow(p));
  }

  async function reload() {
    renderList(await listPresets());
  }

  function buildPayload() {
    const payload = {
      name: String(fName.input.value == null ? "" : fName.input.value).trim(),
      base_url: String(fUrl.input.value == null ? "" : fUrl.input.value).trim(),
      api_key: String(fKey.input.value == null ? "" : fKey.input.value),
      model: String(fModel.input.value == null ? "" : fModel.input.value).trim(),
    };
    const cwRaw = String(fCw.input.value == null ? "" : fCw.input.value).trim();
    if (cwRaw !== "") {
      const n = Number(cwRaw);
      payload.context_window = Number.isInteger(n) ? n : cwRaw; // 非整数原样传 → 域层 cw_invalid 拦
    }
    const mtRaw = String(fMt.input.value == null ? "" : fMt.input.value).trim();
    if (mtRaw !== "") {
      const n = Number(mtRaw);
      payload.max_tokens = Number.isInteger(n) ? n : mtRaw; // 非整数原样传 → 域层 max_tokens_invalid 拦
    }
    return payload;
  }

  function paintSaveError(r) {
    const code = r.error && r.error.code;
    const fieldErrs = {
      name_invalid: [fName.err, t("settings.llmp.errName")],
      base_url_invalid: [fUrl.err, t("settings.llmp.errUrl")],
      model_invalid: [fModel.err, t("settings.llmp.errModel")],
      context_window_invalid: [fCw.err, t("settings.llmp.errCw")],
      max_tokens_invalid: [fMt.err, t("settings.llmp.errMt")],
    };
    const hit = fieldErrs[code];
    if (hit) {
      hit[0].textContent = hit[1];
      hit[0].style.display = "";
    } else {
      errCommon.textContent = t("settings.llmp.saveFailed", { msg: (r.error && r.error.msg) || t("settings.err.unknown") });
      errCommon.style.display = "";
    }
  }

  // 另存：当前表单字段 + 新名称创建（不覆盖旧预设）；成功后提示可删旧预设（改名闭环）
  async function createAsCopy() {
    clearErrors();
    const payload = buildPayload();
    if (!payload.name) {
      fName.err.textContent = t("settings.llmp.errNewName");
      fName.err.style.display = "";
      return;
    }
    if (payload.name === saveAsFrom || knownNames.includes(payload.name)) {
      fName.err.textContent = t("settings.llmp.errDuplicate", { name: payload.name });
      fName.err.style.display = "";
      return;
    }
    const r = await savePreset(payload);
    if (!r.ok) {
      paintSaveError(r);
      return;
    }
    const created = r.name || payload.name;
    const urlNote = r.base_url_normalized ? t("settings.llmp.urlNote", { url: r.base_url }) : "";
    showToast("success", (saveAsFrom
      ? t("settings.llmp.createdCanDelete", { name: created, old: saveAsFrom })
      : t("settings.llmp.created", { name: created })) + urlNote);
    resetToAdd();
    await reload();
  }

  async function onSave() {
    if (saveAsFrom) {
      await createAsCopy();
      return;
    }
    clearErrors();
    const payload = buildPayload();
    const r = await savePreset(payload);
    if (r.ok) {
      const urlNote = r.base_url_normalized ? t("settings.llmp.urlNote", { url: r.base_url }) : "";
      showToast("success", t("settings.llmp.saved", { name: r.name || payload.name }) + urlNote);
      resetToAdd();
      await reload();
      return;
    }
    paintSaveError(r);
  }

  async function onDelete(name) {
    const now = Date.now();
    if (delArm.name === name && now - delArm.at < LLMP_DEL_ARM_MS) {
      delArm = { name: null, at: 0 };
      const r = await deletePreset(name);
      if (r.ok) showToast("success", t("settings.llmp.deleted", { name }));
      else showToast("error", t("settings.llmp.deleteFailed", { msg: (r.error && r.error.msg) || t("settings.err.unknown") }));
      await reload();
      return;
    }
    delArm = { name, at: now };
    showToast("info", t("settings.llmp.deleteArm", { name }));
  }

  saveBtn.addEventListener("click", () => { void onSave(); });
  addBtn.addEventListener("click", () => resetToAdd());
  // 编辑态首点 = 进入改名模式；新增态/已进入另存态 = 直接按当前名称创建
  saveAsBtn.addEventListener("click", () => {
    if (editingName && !saveAsFrom) {
      saveAsFrom = editingName;
      fName.input.disabled = false;
      fName.input.focus();
      fName.input.select();
      formTitle.textContent = t("settings.llmp.saveAsTitle");
      return;
    }
    void createAsCopy();
  });

  const inst = openModal({
    title: t("settings.llmp.title"),
    sub: t("settings.llmp.sub"),
    contentNode: content,
  });
  resetToAdd();
  void reload();
  return inst;
}

// 端口实况：从探测 baseUrl 提取（本仓 8190 · J4；缺省回退 8190）
// 地基批1档2 T2：入参空 → 改取 getBase() 动态化（getBase 空 → 回退 8190 字面量）
function _portFromBase(u) {
  const s = String(u == null || u === "" ? (getBase() || "") : u);
  const m = /:(\d+)/.exec(s);
  return m ? m[1] : "8190";
}

// 批 2-T2：路径同一性（分隔符归一 + 大小写不敏感·Windows 语义）——已存 workflow_path 与清单项配对
function _samePath(a, b) {
  const norm = (s) => String(s == null ? "" : s).trim().replace(/[\\/]+/g, "/").toLowerCase();
  const na = norm(a);
  return !!na && na === norm(b);
}

// AI 协作「打开…」→ 跳 #/ai（hash 路由 = 既有通道：createRouter 订阅 hashchange）
function _goAiView() {
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  if (g.location && typeof g.location.hash === "string") {
    g.location.hash = "#/ai";
    return;
  }
  showToast("info", t("settings.aiCollab.fallback"));
}

// 界面字号即时生效（原型 :1791 title「切换即时生效」· theme.css body.bigui 规则）
function _applyUiFont(v) {
  const b = typeof document !== "undefined" ? document.body : null;
  if (!b || !b.classList) return;
  if (v === "大") b.classList.add("bigui");
  else b.classList.remove("bigui");
}

// ===== mount(container, opts) =====
export function mount(container, opts = {}) {
  if (!container || typeof document === "undefined") return null;
  // 二次 mount 替换
  while (container.firstChild) container.removeChild(container.firstChild);

  const sec = el("section", { id: "view-config", class: "shell-view" });

  // ---------- 页面骨架（A1/A2/B3/B4 · 原型 :1732-1733） ----------
  const top = el("div", { class: "proj-top" });
  top.appendChild(el("h2", { text: t("settings.title") }));
  top.appendChild(el("span", { class: "inh", text: t("settings.subtitle") }));
  sec.appendChild(top);
  const panel = el("div", { class: "fillpanel" });
  sec.appendChild(panel);

  const storage = opts.storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);
  // 基址显示源（随 api.getBase() 动态化·保存/清除后由 refreshBaseDisplay 重渲染）
  let baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : _defaultBaseUrl();

  // ---------- 组1 工作区与目录（A4-A6 · 原型 :1735-1738） ----------
  // 批 2-T1：①工作区 = 只读回显引擎真值（GET /h3_batch/input_dir·api.md #27）②视频输出到 = 可编辑
  //   输入 + 持久化（gui13.paths.server_output_dir·空 = 引擎默认）③表格目录不动（YAGNI 裁决：
  //   csv_dir 全链无消费——生成 CSV 由引擎自落 input 目录）
  // 批 2-T3：浏览钮换真（openPicker 服务器文件浏览器）；工作区行只读回显无浏览钮（体验修复 A 块：待实装占位摘除）
  const paths = loadPaths(storage);

  // 路径输入构件（批 2-T1 · change 落 gui13.paths.{key}·合并式写入不覆盖旁键）
  function _pathInput(id, key, label) {
    const inp = el("input", { type: "text", class: "cfg-cf-input", id });
    inp.value = paths[key];
    inp.title = label;
    inp.addEventListener("change", () => {
      savePaths(storage, { ...loadPaths(storage), [key]: inp.value });
      showToast("success", t("settings.path.saved", { label }));
    });
    return inp;
  }

  // 批 2-T3：浏览钮 → openPicker 服务器文件浏览器；选中回填输入框 + 派发 change
  //   （程序赋值不触发 change，显式派发让既有持久化/联动链照跑——后写胜出）
  function _browseBtn(inp, opts) {
    const b = _fbtn(t("settings.btn.browse"));
    b.title = opts.title;
    b.addEventListener("click", () => {
      openPicker({
        title: opts.title,
        mode: opts.mode || "dir",
        exts: opts.exts,
        scan: opts.scan,
        current: inp.value,
        onPick: (p) => {
          inp.value = p;
          inp.dispatchEvent(new Event("change"));
        },
      });
    });
    return b;
  }

  const inputDirV = el("span", { class: "v num", id: "cvInputDir", text: t("settings.ph.loading") });
  const pathServerOutputDir = _pathInput("pathServerOutputDir", "server_output_dir", t("settings.path.videoOutputDir"));
  // 批 4-T1 ④（批 2 遗留 1）: 该键引擎强校验（错值拒跑）——仅此实例追加 title，不动 _pathInput 通用口径（波及另三键）
  pathServerOutputDir.title += t("settings.path.videoOutputDirTitle");
  const pathTemplatePath = _pathInput("pathTemplatePath", "template_path", t("settings.row.tplPath"));

  // 批Gb T7（R-11）：文件库起跳目录偏好——设值后引擎库打开落此目录；
  //   「使用引擎默认」清空 = 回退现链（上次浏览记忆 → 引擎默认）
  const pathPickerStartDir = el("input", { type: "text", class: "cfg-cf-input", id: "pathPickerStartDir" });
  pathPickerStartDir.value = loadPickerStartDir(storage);
  pathPickerStartDir.title = t("settings.pickerStart.title");
  pathPickerStartDir.addEventListener("change", () => {
    savePickerStartDir(storage, pathPickerStartDir.value);
    showToast("success", t("settings.pickerStart.saved"));
  });
  const clearStartDirBtn = _fbtn(t("settings.pickerStart.useDefault"));
  clearStartDirBtn.title = t("settings.pickerStart.useDefaultTitle");
  clearStartDirBtn.addEventListener("click", () => {
    savePickerStartDir(storage, "");
    pathPickerStartDir.value = "";
    showToast("success", t("settings.pickerStart.cleared"));
  });

  // 视频输出目录已由「输出根目录」取代（R-59·2026-10-11）——行隐藏·DOM 保留（B4-T1④ title 锁须继续通过）；
  //   R-52 v2（老板定版 2026-10-11）：输出根目录行挑回本组原「视频输出到」隐藏行后（老板没找到入口）。
  //   style.display 兜底：.pathrow{display:flex} 作者规则会压过 UA [hidden]{display:none}
  const rowServerOutput = _pathrow(t("settings.row.videoOutputTo"), [
    pathServerOutputDir,
    _browseBtn(pathServerOutputDir, { title: t("settings.pick.videoOutput") }),
  ]);
  rowServerOutput.hidden = true;
  rowServerOutput.style.display = "none";

  // 输出根目录（R-59 T2 老板裁·实装接替「数据根目录（演示态）」空挂行·迁移…退场；R-52 v2 整行从组6 挑回组1 原位）：
  //   选/填 →「应用」POST /gui13-fs/set_workspace → 视频项目文件夹与项目数据都建在该目录下；
  //   读链 loadWorkspaceRoot（server 聚合子键·不走 localStorage）；浏览钮复用 _browseBtn（引擎未连选不了·手输兜底）；
  //   「使用默认」清空并直接应用空串（回退引擎默认）。纯函数状态机三导出保留（settings.test.mjs 在测）。
  const pathWorkspaceRoot = el("input", { type: "text", class: "cfg-cf-input", id: "pathWorkspaceRoot" });
  pathWorkspaceRoot.value = loadWorkspaceRoot();
  pathWorkspaceRoot.title = t("settings.wsRoot.title");
  const btnWsBrowse = _browseBtn(pathWorkspaceRoot, { title: t("settings.wsRoot.pick") });
  const btnWsDefault = _fbtn(t("settings.btn.useDefault"));
  btnWsDefault.title = t("settings.wsRoot.useDefaultTitle");
  btnWsDefault.addEventListener("click", () => {
    pathWorkspaceRoot.value = "";
    void _applyWorkspaceRoot(pathWorkspaceRoot);
  });
  const btnWsApply = _fbtn(t("settings.btn.apply"));
  btnWsApply.title = t("settings.wsRoot.applyTitle");
  btnWsApply.addEventListener("click", () => { void _applyWorkspaceRoot(pathWorkspaceRoot); });

  panel.appendChild(_cfgsec(t("settings.sec.workspace"), [
    _pathrow(t("settings.row.workspace"), [inputDirV]),
    rowServerOutput,
    _pathrow(t("settings.row.wsRoot"), [pathWorkspaceRoot, btnWsBrowse, btnWsDefault, btnWsApply]),
    _pathrow(t("settings.row.csvDir"), [_v(t("settings.val.csvAuto"))]),
    _pathrow(t("settings.row.pickerStart"), [pathPickerStartDir, clearStartDirBtn]),
  ]));

  // 工作区回显：加载时取引擎真值（引擎不可达 → 「（未连接）」·不伪造路径）
  void (async () => {
    const r = await engineInputDir();
    inputDirV.textContent = r.ok ? r.dir : t("settings.ph.notConnected");
  })();

  // ---------- 组2 模板与工作流（A7/A8 · 原型 :1740-1743 · 批 2-T1 加两输入 · T2 模板下拉接真数据） ----------
  // 登记项 8：pref 提前读取（视频模型下拉初值回填 + change 落库；组4/组6/组7 沿用同一份）
  const pref = loadPref(storage);

  // 批 2-T2：硬编码 select 退场 → cbox 真数据（GET /h3_batch/templates?dir=…·引擎实测字符串数组）
  //   目录 = gui13.paths.template_path，空则 GET /h3_batch/workflow_dir 取引擎默认（api.md #43）
  //   选中 → 写 gui13.paths.workflow_path（绝对路径）· cbox 值 = 引擎模板名（相对路径）
  //   族 hint 仅展示标注：i2v/fl2v 引擎 V1.14 已废除 → 「（已废除）」后缀·不置灰任何 1.3 控件
  let tplList = [];
  const tplFamHint = el("span", { class: "inh", id: "tplFamilyHint", text: "" });
  function paintTplFamily(p) {
    const s = String(p == null ? "" : p).trim();
    if (!s) { tplFamHint.textContent = ""; return; }
    const fam = classifyTemplateFamily(s);
    tplFamHint.textContent = fam
      ? t("settings.tpl.family", { fam }) + (DEPRECATED_TEMPLATE_FAMILIES.has(fam) ? t("settings.tpl.familyDeprecated") : "")
      : t("settings.tpl.familyUnknown");
  }
  paintTplFamily(paths.workflow_path); // 挂载即按已存键标注（不依赖引擎可达）

  // 模板清单装载/重载（批 2-T3：改为可重载——模板路径变更时重取；目录每次从 storage 读最新）
  async function reloadTplList() {
    const res = await fetchTemplateList(loadPaths(storage).template_path);
    if (!res.ok) {
      tplList = [];
      setCurrentValue(tplSel, t("settings.ph.engineDown"));
      tplSel.title = t("settings.tpl.listFailed", { err: res.error });
      return;
    }
    tplList = res.items;
    tplSel.title = "";
    if (!res.items.length) {
      setCurrentValue(tplSel, t("settings.ph.noTemplates"));
      return;
    }
    tplSel.setAttribute("data-opts", res.items.map((i) => i.name).join("|"));
    const curWf = loadPaths(storage).workflow_path; // 装载期间可能已手输 → 读最新（后写胜出）
    const hit = curWf ? res.items.find((i) => _samePath(i.path, curWf)) : null;
    setCurrentValue(tplSel, hit ? hit.name : t("settings.ph.notSelected"));
  }
  const tplSel = _cbox("tplSel", "", t("settings.ph.loading"), t("settings.tpl.selTitle"), "260px", (v) => {
    const hit = tplList.find((i) => i.name === v);
    if (!hit) return;
    savePaths(storage, { ...loadPaths(storage), workflow_path: hit.path });
    pathWorkflowPath.value = hit.path; // 双入口同键：桥输入同步回显（后写胜出）
    paintTplFamily(hit.path);
    showToast("success", t("settings.tpl.saved", { name: hit.name }));
  });
  // 批 2-T1：workflow_path 桥输入（T2 选中模板 / T1 手输写同一键·后写胜出·提交链读同键）
  const pathWorkflowPath = _pathInput("pathWorkflowPath", "workflow_path", t("settings.path.workflowPath"));
  pathWorkflowPath.addEventListener("change", () => {
    paintTplFamily(pathWorkflowPath.value); // hint 跟随当前键
    if (!tplList.length) return; // 清单未装载/不可达 → 保留占位（不吞「引擎未连接/无可用模板」）
    const hit = tplList.find((i) => _samePath(i.path, pathWorkflowPath.value));
    setCurrentValue(tplSel, hit ? hit.name : t("settings.ph.notSelected")); // 命中清单 → 下拉回显同步
  });
  // 批 2-T3：模板路径变更（手输 / 浏览钮回填）→ 重取模板清单（T2 遗留：装载原为挂载一次性）
  pathTemplatePath.addEventListener("change", () => { void reloadTplList(); });
  panel.appendChild(_cfgsec(t("settings.sec.templates"), [
    _pathrow(t("settings.row.tplPath"), [
      pathTemplatePath,
      _browseBtn(pathTemplatePath, { title: t("settings.pick.tplDir") }),
    ]),
    _pathrow(t("settings.row.workflowTpl"), [
      tplSel,
      pathWorkflowPath,
      // 工作流模板 = 引擎侧 .json 文件 → file 模式 + exts .json + 两层扫描（模板目录常分层）
      _browseBtn(pathWorkflowPath, { title: t("settings.pick.workflowFile"), mode: "file", exts: [".json"], scan: true }),
      tplFamHint,
    ]),
  ]));

  // 模板清单装载/重载：引擎不可达 → 空列表 + 「（引擎未连接）」占位（不伪造清单）
  void reloadTplList();

  // ---------- 组3 引擎与模型（A9-A12 · S6 · 原型 :1745-1750） ----------
  const portLamp = _lampEl();
  const portHealth = el("span", { text: _healthText(getChipState()) });
  // 端口文本节点单列（保存/清除后即时刷新用·不新增 css）
  const portNumText = document.createTextNode(_portFromBase(baseUrl) + " · ");
  const portV = el("span", { class: "v num" }, [portNumText, portLamp, portHealth]);
  const btnPortTest = _fbtn(t("settings.btn.test"));
  btnPortTest.addEventListener("click", () => { void probeWithToast(); });
  // U-批 U4：引擎端口「自动扫描」钮（处理器在下方引擎地址输入框定义后挂线——回填目标是地址框）
  const btnScanPort = _fbtn(t("settings.scan.btn"));
  const aiOpen = _fbtn(t("settings.btn.open"));
  aiOpen.addEventListener("click", _goAiView);
  // 裁甲（2026-10-25）：「大语言模型通道」下拉退役——UI 偏好不控制任何实际调用（真调用走引擎命名预设），
  //   本组只保留预设入口（独立成行，避免与视频模型混淆）。
  // 老板复验（2026-10-26）：钮文案「预设…」改「编辑」（行首已标「大语言模型预设」·不歧义）。
  const btnLlmPresets = _fbtn(t("settings.btn.edit"), { title: t("settings.llmp.entryTitle") });
  btnLlmPresets.addEventListener("click", () => { openLlmPresetsModal(); });
  // 老板 2026-10-26：AI 回复超时（秒）——本地模型反应慢可调大；默认 300·范围 30-900（越界钳制+提示）
  const chatTimeoutInput = el("input", {
    type: "number",
    min: String(CHAT_TIMEOUT_SEC_MIN),
    max: String(CHAT_TIMEOUT_SEC_MAX),
    step: "1",
    class: "cfg-cf-input",
    id: "prefChatTimeoutSec",
  });
  chatTimeoutInput.value = String(pref.chatTimeoutSec);
  chatTimeoutInput.title = t("settings.chatTimeout.title");
  chatTimeoutInput.addEventListener("change", () => {
    const r = clampChatTimeoutSec(chatTimeoutInput.value);
    chatTimeoutInput.value = String(r.sec);
    savePref(storage, { ...loadPref(storage), chatTimeoutSec: r.sec });
    if (r.invalid) showToast("error", t("settings.chatTimeout.invalid", { n: r.sec }));
    else if (r.clamped) showToast("warn", t("settings.chatTimeout.clamped", { n: r.sec }));
    else showToast("success", t("settings.chatTimeout.saved", { n: r.sec }));
  });
  // #76 G1/G2：合并模式音频参照三开关（引擎 h3_config 三键·GET/POST /h3_batch/config/audio_ref）。
  //   总开 + 两子全关 = 轻量版（挑上段最亮 3 秒做参照）；总关时子键一律忽略（引擎侧裁决）。
  //   读回填 = 启动/开设置页 GET 三键现值（404/失败静默保持现缓存/默认关）；
  //   写后仍更新回显缓存即时显示；不落 GUI 本地/localStorage 键。
  const _arLabels = {
    h3_audio_ref_split: t("settings.row.audioRef"),
    h3_audio_ref_vocals: t("settings.ar.vocals"),
    h3_audio_ref_background: t("settings.ar.background"),
  };
  async function _saveAudioRef(key, box, on) {
    const r = await request("/h3_batch/config/audio_ref", {
      method: "POST", body: { key, value: on }, _noOfflineToast: true,
    });
    if (r.ok && r.data && r.data.ok !== false) {
      _audioRefState[key] = on;
      showToast("success", t("settings.ar.saved", { label: _arLabels[key], state: on ? _ON() : _OFF() }));
      return;
    }
    setCurrentValue(box, _audioRefState[key] ? _ON() : _OFF());
    if (r.error && r.error.httpStatus === 404) {
      showToast("error", t("settings.ar.needsRestart"));
    } else {
      showToast("error", t("settings.err.saveEngineDown"));
    }
  }
  const arSplit = _cbox("cfgAudioRefSplit", _ON() + "|" + _OFF(), _audioRefState.h3_audio_ref_split ? _ON() : _OFF(),
    t("settings.ar.splitTitle"),
    "104px", (v) => { void _saveAudioRef("h3_audio_ref_split", arSplit, v === _ON()); });
  const arVocals = _cbox("cfgAudioRefVocals", _ON() + "|" + _OFF(), _audioRefState.h3_audio_ref_vocals ? _ON() : _OFF(),
    t("settings.ar.vocalsTitle"),
    "104px", (v) => { void _saveAudioRef("h3_audio_ref_vocals", arVocals, v === _ON()); });
  const arBackground = _cbox("cfgAudioRefBackground", _ON() + "|" + _OFF(), _audioRefState.h3_audio_ref_background ? _ON() : _OFF(),
    t("settings.ar.backgroundTitle"),
    "104px", (v) => { void _saveAudioRef("h3_audio_ref_background", arBackground, v === _ON()); });
  // #76 G2：读回填真实现 — 启动/开设置页 GET 三键现值（引擎 200 裸对象；走 fetchApi 原始响应，
  //   不走 request 归一链，避免 404（路由未注册=未重启）触发全局错误 toast）。
  async function _loadAudioRefState() {
    let resp;
    try {
      resp = await fetchApi("/h3_batch/config/audio_ref", { cache: "no-store" });
    } catch (_e) {
      return;  // 引擎未重启/不可达 → 静默保持现缓存/默认关
    }
    if (!resp || !resp.ok) return;  // 404 = 路由未注册（预期态）→ 静默
    let data;
    try {
      data = await resp.json();
    } catch (_e) {
      return;
    }
    if (!data || typeof data !== "object") return;
    for (const k of Object.keys(_audioRefState)) {
      if (typeof data[k] === "boolean") _audioRefState[k] = data[k];
    }
    setCurrentValue(arSplit, _audioRefState.h3_audio_ref_split ? _ON() : _OFF());
    setCurrentValue(arVocals, _audioRefState.h3_audio_ref_vocals ? _ON() : _OFF());
    setCurrentValue(arBackground, _audioRefState.h3_audio_ref_background ? _ON() : _OFF());
  }
  void _loadAudioRefState();
  panel.appendChild(_cfgsec(t("settings.sec.engine"), [
    _pathrow(t("settings.row.enginePort"), [portV, btnPortTest, btnScanPort]),
    _pathrow(t("settings.row.videoModel"), [
      _select([t("settings.videoModel.long"), t("settings.videoModel.short")], (v) => {
        savePref(storage, { ...loadPref(storage), videoModel: v });
        showToast("success", t("settings.videoModel.saved", { v }));
      }, pref.videoModel),
    ]),
    _pathrow(t("settings.row.llmPresets"), [btnLlmPresets]),
    _pathrow(t("settings.row.chatTimeout"), [chatTimeoutInput]),
    _pathrow(t("settings.row.aiCollab"), [el("span", { class: "v", text: t("settings.val.aiCollab") }), aiOpen]),
    _pathrow(t("settings.row.audioRef"), [
      arSplit,
      el("span", { class: "inh", text: t("settings.ar.hint") }),
    ]),
    _pathrow(t("settings.row.vocalsLock"), [
      arVocals,
      el("span", { class: "inh", text: t("settings.ar.vocalsHint") }),
    ]),
    _pathrow(t("settings.row.backgroundCont"), [
      arBackground,
      el("span", { class: "inh", text: t("settings.ar.backgroundHint") }),
    ]),
  ]));

  // ---------- 组4 ComfyUI 引擎指向（B7 · A13-A16/B10/B13/B14/B16/B37 · 原型 :1752-1758） ----------
  const cfArgs = loadCfArgs(storage);

  // ComfyUI 目录（地基批1档2 T2b · 账本 #46）：正规配置键 engine_dir（落 data/settings.json·与服务侧同子键）
  //   ——旧 gui13.paths.comfyui_dir 为孤儿键（引擎启动链零消费）→ 本行改读写 engine_dir；旧键停写（读保留兼容·首读一次性迁移）
  //   浏览钮（批 2-T3 openPicker dir 模式）保留：选完回填输入框并派发 change → 同链落 engine_dir
  const dirInput = el("input", { type: "text", class: "cfg-cf-input", id: "cvCfDir" });
  dirInput.value = loadEngineDir(storage);
  dirInput.title = t("settings.comfyDir.title");
  dirInput.addEventListener("change", () => {
    const chk = checkEngineDir(dirInput.value);
    if (!chk.ok) {
      dirInput.value = loadEngineDir(storage);   // 非法 → 回显已存值（不落盘）
      showToast("error", chk.msg);
      return;
    }
    saveEngineDir(storage, dirInput.value);
    dirInput.value = loadEngineDir(storage);
    showToast("success", t("settings.comfyDir.saved"));
  });
  const dirBtn = _browseBtn(dirInput, { title: t("settings.pick.comfyDir") });

  const argInput = el("input", { type: "text", class: "ip-name cfg-cf-input", id: "cfArgs" });
  argInput.value = cfArgs;
  argInput.title = t("settings.cfArgsTitle");
  argInput.addEventListener("change", () => {
    saveCfArgs(storage, argInput.value);
    showToast("success", t("settings.cfArgs.saved"));
  });

  // 引擎地址（地基批1档2 T2 · 账本 #45 GUI 侧）：正规配置键 engine_addr（落 data/settings.json·
  //   与服务侧 devserver 同一文件同一子键）——保存联动 setBase(掰正后基址) + 启动参数 --port 同步；
  //   留空 = 清除（--port 与基址一并回默认）；远程地址拒绝并白话提示。
  const addrInput = el("input", { type: "text", class: "cfg-cf-input", id: "engineAddr" });
  addrInput.value = loadEngineAddr(storage);
  addrInput.title = t("settings.engineAddr.title");
  const addrSaveBtn = _fbtn(t("settings.btn.save"));
  addrSaveBtn.title = t("settings.engineAddr.saveTitle");
  addrSaveBtn.addEventListener("click", () => {
    const chk = checkEngineAddr(addrInput.value);
    if (!chk.ok) { showToast("error", chk.msg); return; }
    if (!saveEngineAddr(storage, addrInput.value)) {
      showToast("error", t("settings.engineAddr.saveFailed"));
      return;
    }
    addrInput.value = loadEngineAddr(storage);
    refreshBaseDisplay();
    showToast("success", t("settings.engineAddr.saved"));
  });

  // U-批 U4：端口自动扫描（GET /gui13-fs/scan_engine·self 档恒同源相对——伴生服务并发探 8188-8200）：
  //   找到 → 端口回填引擎地址框（仅 UI·不落盘不改设置·保存仍走上方既有引擎地址保存链）；未找到 → 白话 toast。
  btnScanPort.addEventListener("click", async () => {
    btnScanPort.disabled = true;
    let data = null;
    try {
      const resp = await fetchApi("/gui13-fs/scan_engine", { self: true });
      data = resp && resp.ok ? await resp.json() : null;
    } catch (_e) { data = null; }
    btnScanPort.disabled = false;
    const p = data && data.ok ? Number(data.port) : 0;
    if (!p) { showToast("error", t("settings.scan.notFound")); return; }
    const cur = loadEngineAddr(storage);
    addrInput.value = cur ? cur.replace(/:(\d+)$/, ":" + p) : "http://127.0.0.1:" + p;
    showToast("success", t("settings.scan.found", { port: String(p) }));
  });

  // ffmpeg 路径（地基批1档2 T2b · 账本 #46）：正规配置键 ffmpeg_path（落 data/settings.json·与服务侧同子键）
  //   留空 = 清除（回引擎默认 ffmpeg）；非绝对路径拒绝并白话提示；无 .exe 后缀给建议（提示性·不拒绝）。
  const ffInput = el("input", { type: "text", class: "cfg-cf-input", id: "ffmpegPath" });
  ffInput.value = loadFfmpegPath(storage);
  ffInput.title = t("settings.ffmpeg.title");
  const ffSaveBtn = _fbtn(t("settings.btn.save"));
  ffSaveBtn.title = t("settings.ffmpeg.saveTitle");
  ffSaveBtn.addEventListener("click", () => {
    const chk = checkFfmpegPath(ffInput.value);
    if (!chk.ok) { showToast("error", chk.msg); return; }
    saveFfmpegPath(storage, ffInput.value);
    ffInput.value = loadFfmpegPath(storage);
    showToast("success", t("settings.ffmpeg.saved"));
    if (chk.hint) showToast("warn", chk.hint);
  });

  const cfLamp = _lampEl("cfLamp");
  const cfState = el("span", { class: "cfg-lamp-label", id: "cfState", text: _lampText(getChipState()) + " · " + baseUrl });
  const stateV = el("span", { class: "v" }, [cfLamp, cfState]);
  const bootBtn = el("button", { type: "button", class: "prim", id: "cfBootBtn", text: t("settings.btn.startEngine") });
  bootBtn.title = t("settings.engine.startTitle");
  bootBtn.addEventListener("click", () => {
    // S3-4c：与顶栏芯片「启动」同链（startEngine = 置启动中 + 单一探测出口）
    void startEngine();
  });
  const refreshBtn = el("button", { type: "button", class: "ghostbtn", text: t("settings.btn.manualRefresh") });
  refreshBtn.addEventListener("click", () => { void probeWithToast(); });

  // 引擎版本行（C1 · S2-3 T6 D10 合法追加 · 不动）
  const infoRow = el("div", { class: "cfg-cf-args" });
  infoRow.appendChild(el("label", { class: "cfg-cf-lbl", text: t("settings.row.engineVersion") }));
  const infoVal = el("span", { style: "font-size:13px;color:var(--txt);font-variant-numeric:tabular-nums", text: t("settings.ph.loadingText") });
  infoRow.appendChild(infoVal);
  function paintEngineInfo(r) {
    if (engineInfoState(r) === "connected") {
      const vramTxt = (typeof r.vramTotalMb === "number" && r.vramTotalMb > 0)
        ? ` · VRAM ${(r.vramTotalMb / 1024).toFixed(1)} GB`
        : "";
      infoVal.textContent = `${r.version}${vramTxt}`;
    } else {
      infoVal.textContent = t("settings.val.versionUnknown");
    }
  }

  // S3-4c 单出口接线：版本行绘制注册进 refreshChip —— 挂载探测 / 手动刷新 / 顶栏芯片启动
  //   全部同帧更新灯/标签/版本行；页面切换后为旧节点，写入无副作用。
  _engineInfoPaint = paintEngineInfo;

  // 探测 + 结果 toast（端口「测试」/ 引擎状态「手动刷新」共用出口）
  async function probeWithToast() {
    const r = await refreshChip();
    const ok = getChipState() === "connected";
    showToast(ok ? "success" : "warn", ok ? t("settings.probe.ok") : t("settings.probe.fail"));
    return r;
  }

  // 单一状态灯绘制：引擎状态行（cfLamp/cfState·B12 状态 · baseUrl）+ 端口行灯/健康词（A9）
  function paintState(stateVal) {
    cfLamp.className = "eng-lamp " + _lampClass(stateVal);
    cfLamp.setAttribute("data-eng-lamp", stateVal);
    cfState.textContent = _lampText(stateVal) + " · " + baseUrl;
    portLamp.className = "eng-lamp " + _lampClass(stateVal);
    portLamp.setAttribute("data-eng-lamp", stateVal);
    portHealth.textContent = _healthText(stateVal);
  }
  paintState(getChipState());
  // 订阅芯片状态变化（外部探测 → 设置页双灯同步）
  subscribeChipState(paintState);

  // 基址/端口显示即时刷新（裁决④·引擎地址保存/清除后调·调既有渲染路径·不新增 css）
  function refreshBaseDisplay() {
    baseUrl = _defaultBaseUrl();
    portNumText.textContent = _portFromBase(baseUrl) + " · ";
    paintState(getChipState());
  }

  panel.appendChild(_cfgsec(t("settings.sec.comfy"), [
    _pathrow(t("settings.row.comfyDir"), [dirInput, dirBtn]),
    _pathrow(t("settings.row.cfArgs"), [argInput]),
    _pathrow(t("settings.row.engineAddr"), [addrInput, addrSaveBtn]),
    _pathrow(t("settings.row.engineState"), [stateV, bootBtn, refreshBtn]),
    _pathrow(t("settings.row.ffmpegPath"), [ffInput, ffSaveBtn]),
    infoRow,
  ]));

  // ---------- 组5 提示词模板（A17/B8/B27-B33 · 原型 :1760-1771） ----------
  const tpl = loadTemplates(storage);
  const tplLabels = { tplThreepov: t("settings.tpl.threepov"), tplScene: t("settings.tpl.scene"), tplProp: t("settings.tpl.prop") };
  const tplItems = [
    // T5 #1 解封：生成链已接（resolveTemplate 拼接描述前）——inh 换生效口径（F61「暂未生效」句退场）
    el("div", { class: "inh", text: t("settings.tpl.inh") }),
  ];
  for (const k of ["tplThreepov", "tplScene", "tplProp"]) {
    const row = el("div", { class: "pathrow tpl-row" });
    row.appendChild(el("span", { class: "k", text: tplLabels[k] }));
    const ta = el("textarea", { id: k, rows: "3", class: "cfg-tpl-ta" });
    ta.value = tpl[k];
    // B33 oninput 自动保存（实时；无 toast 防刷屏）
    ta.addEventListener("input", () => {
      saveTemplates(storage, { ...loadTemplates(storage), [k]: ta.value });
    });
    row.appendChild(ta);
    // B32 每行行内恢复钮（只回退本行）——T5 #1：恢复默认 = 清空该框（写空串·生成时读取层判默认）
    const restore = _fbtn(t("settings.btn.restoreDefault"));
    restore.addEventListener("click", () => {
      ta.value = "";
      saveTemplates(storage, { ...loadTemplates(storage), [k]: "" });
      showToast("info", t("settings.tpl.cleared"));
    });
    row.appendChild(restore);
    tplItems.push(row);
  }

  // ---------- #41 文档源可配置：组5 追加「聊天 AI 文档 / 优化 AI 文档」两行 ----------
  //   聊天 = 引擎侧配置（POST /h3_batch/llm/chat_doc·T1 端点·ok 才落盘 aiDocs）；优化 = 聚合 aiDocs + 同源 read_doc 预取。
  //   恢复默认 = 清空（聊天 POST 空串 / 优化写空串）；GET 不可达 → 占位不伪造；配置只走聚合存储（零 localStorage）。
  const _aiDocs = () => readAgg(SETTINGS_JSON, "aiDocs") || {};
  const chatDocInput = el("input", { type: "text", class: "cfg-cf-input", id: "cfgChatDocPath" });
  chatDocInput.value = _aiDocs().chatDocPath || "";
  chatDocInput.title = t("settings.chatDoc.title");
  const chatDocHint = el("span", { class: "inh", id: "chatDocHint", text: "" });
  // 聊天路径保存纪律：POST ok 才落盘；失败 → 不落盘 + 回退已存值 + 白话报错
  async function saveChatDocPath() {
    const chk = _checkAbsPath(chatDocInput.value, t("settings.row.chatDoc"), "D:\\docs\\style.md");
    if (!chk.ok) {
      chatDocInput.value = _aiDocs().chatDocPath || "";
      showToast("error", chk.msg);
      return;
    }
    const r = await request("/h3_batch/llm/chat_doc", { method: "POST", body: { path: chk.value }, _noOfflineToast: true });
    if (r.ok && !(r.data && r.data.ok === false)) {
      _aggWrite("aiDocs", { ..._aiDocs(), chatDocPath: chk.value });
      showToast("success", chk.value ? t("settings.chatDoc.saved") : t("settings.chatDoc.cleared"));
    } else {
      chatDocInput.value = _aiDocs().chatDocPath || "";
      showToast("error", t("settings.err.saveEngineDown"));
    }
  }
  chatDocInput.addEventListener("change", () => { void saveChatDocPath(); });
  const chatDocRestore = _fbtn(t("settings.btn.restoreDefault"));
  chatDocRestore.title = t("settings.chatDoc.restoreTitle");
  chatDocRestore.addEventListener("click", () => {
    chatDocInput.value = "";
    void saveChatDocPath();
  });
  // 打开设置页：GET chat_doc → 可达回显引擎现值 + hint 固定「已加载」；引擎业务 ok=false
  //   （HTTP 200 信封被 request 归一链折成 r.ok=false·httpStatus=200）→ hint 显白话原因；
  //   网络不可达 → 占位不伪造
  void (async () => {
    const r = await request("/h3_batch/llm/chat_doc", { _noOfflineToast: true });
    if (!r.ok) {
      if (r.error && r.error.httpStatus === 200) {
        chatDocHint.textContent = t("settings.chatDoc.readFailed");
      } else {
        chatDocInput.setAttribute("placeholder", t("settings.ph.engineDown"));
      }
      return;
    }
    const d = r.data && typeof r.data === "object" ? r.data : {};
    if (typeof d.path === "string") chatDocInput.value = d.path;
    chatDocHint.textContent = t("settings.chatDoc.loaded");
  })();

  const optDocInput = el("input", { type: "text", class: "cfg-cf-input", id: "cfgOptDocPath" });
  optDocInput.value = _aiDocs().optimizeDocPath || "";
  optDocInput.title = t("settings.optDoc.title");
  // 优化路径保存：直接落盘 + 触发预取（读取失败回内置·弹层首开 toast 提示）
  function saveOptDocPath() {
    const chk = _checkAbsPath(optDocInput.value, t("settings.row.optDoc"), "D:\\docs\\optimize.md");
    if (!chk.ok) {
      optDocInput.value = _aiDocs().optimizeDocPath || "";
      showToast("error", chk.msg);
      return;
    }
    _aggWrite("aiDocs", { ..._aiDocs(), optimizeDocPath: chk.value });
    void prefetchOptimizeDoc(chk.value);
    showToast(chk.value ? "success" : "info", chk.value ? t("settings.optDoc.saved") : t("settings.optDoc.cleared"));
  }
  optDocInput.addEventListener("change", saveOptDocPath);
  const optDocBrowse = _browseBtn(optDocInput, { title: t("settings.pick.optDoc"), mode: "file", exts: [".md", ".txt"], scan: true });
  const optDocRestore = _fbtn(t("settings.btn.restoreDefault"));
  optDocRestore.title = t("settings.optDoc.restoreTitle");
  optDocRestore.addEventListener("click", () => {
    optDocInput.value = "";
    saveOptDocPath();
  });

  tplItems.push(
    _pathrow(t("settings.row.chatDoc"), [
      chatDocInput,
      _browseBtn(chatDocInput, { title: t("settings.pick.chatDoc"), mode: "file", exts: [".md", ".txt"], scan: true }),
      chatDocRestore,
      chatDocHint,
    ]),
    _pathrow(t("settings.row.optDoc"), [optDocInput, optDocBrowse, optDocRestore]),
    el("div", { class: "inh", text: t("settings.docs.inh1") }),
    el("div", { class: "inh", text: t("settings.docs.inh2") }),
  );

  panel.appendChild(_cfgsec(t("settings.sec.tplCustom"), tplItems));

  // ---------- 组6 提醒与恢复（A21/A22/A23/A18 · B17-B25 · 原型 :1773-1787） ----------
  let remind = loadRemind(storage);
  const notifyAdapter = createDesktopAdapter();
  const soundBox = _cbox("remindSound", _ON() + "|" + _OFF(), remind.sound ? _ON() : _OFF(), t("settings.remind.soundTitle"), "104px", (v) => {
    remind = { ...remind, sound: v === _ON() };
    saveRemind(storage, remind);
    showToast("info", v === _ON() ? t("settings.remind.soundOn") : t("settings.remind.soundOff"));
  });
  const notifyBox = _cbox("remindNotify", _ON() + "|" + _OFF(), remind.notify ? _ON() : _OFF(), t("settings.remind.notifyTitle"), "104px", (v) => {
    remind = { ...remind, notify: v === _ON() };
    saveRemind(storage, remind);
    if (v !== _ON()) {
      showToast("info", t("settings.remind.notifyOff"));
      return;
    }
    // 真实接 notification-adapter（用户手势栈内）
    Promise.resolve(notifyAdapter.ensurePermission()).then((perm) => {
      if (perm === "granted") {
        const ok = notifyAdapter.show({ title: t("settings.remind.notifyTestTitle"), body: t("settings.remind.notifyTestBody"), tag: "gui13-remind" });
        showToast(ok ? "success" : "info", ok ? t("settings.remind.notifySent") : t("settings.remind.notifyDeferred"));
      } else {
        showToast("warn", t("settings.remind.notifyDenied", { perm }));
      }
    });
  });
  // 「输出根目录」行已随 R-52 v2（老板定版 2026-10-11）整行搬到组1 原「视频输出到」隐藏行后（老板没找到入口）——组6 原位清空复原

  panel.appendChild(_cfgsec(t("settings.sec.remind"), [
    _pathrow(t("settings.row.renderRemind"), [
      soundBox,
      el("span", { class: "inh", text: t("settings.remind.sound") }),
      notifyBox,
      el("span", { class: "inh", text: t("settings.remind.desktopNotify") }),
    ]),
  ]));

  // ---------- 组7 界面（A19 · 原型 :1789-1792） ----------
  // 界面字号：pref.uiFont 存规范值「标准/大」（入数据中文串·显示层映射——#89 红线：显示译·数据不译）
  const fontZh = t("settings.uiFont.standard");
  const fontBig = t("settings.uiFont.large");
  const fontBox = _cbox("uiFontSel", fontZh + "|" + fontBig,
    pref.uiFont === "大" ? fontBig : fontZh,
    t("settings.uiFont.title"), "150px", (v) => {
      const canon = v === fontBig ? "大" : "标准";   // 回规范值落库（显示↔数据换算仅此一处）
      savePref(storage, { ...loadPref(storage), uiFont: canon });
      _applyUiFont(canon);
    });
  // #89 T1a：界面语言下拉（中文｜English·当前值回显走 pref 链·onchange→setLang 双写后整页刷新）
  const langCur = pref.uiLang === "en" ? t("settings.uiLang.optEn") : t("settings.uiLang.optZh");
  const langSel = _cbox("uiLangSel", t("settings.uiLang.optZh") + "|" + t("settings.uiLang.optEn"), langCur,
    t("settings.uiLang.hint"), "150px", (v) => {
      const lang = v === t("settings.uiLang.optEn") ? "en" : "zh";
      if (lang !== getLang()) void setLang(lang);
    });
  panel.appendChild(_cfgsec(t("settings.sec.ui"), [
    _pathrow(t("settings.row.uiFont"), [fontBox, el("span", { class: "inh", text: t("settings.uiFont.hint") })]),
    _pathrow(t("settings.row.uiLang"), [langSel, el("span", { class: "inh", text: t("settings.uiLang.hint") })]),
  ]));
  _applyUiFont(pref.uiFont);

  container.appendChild(sec);
  // cbox 下拉 document 委托（仓内惯例：resources/setup/segcards 均在 mount 幂等绑定）
  initDocumentDelegate(document);
  // 页面挂载时立即探测一次（单一出口 refreshChip 同帧更新灯/版本行/芯片）
  void refreshChip();
  // 地基批1档2 T3：常驻探活启动（30s 一拍·页面生命周期常驻·幂等·重挂不叠加）
  startEngineProbing();

  return sec;
}

function _lampClass(stateVal) {
  if (stateVal === "connected") return "eng-lamp-ok";
  if (stateVal === "starting") return "eng-lamp-warn";
  return "eng-lamp-idle";
}

function _lampText(stateVal) {
  if (stateVal === "connected") return t("settings.state.connected");
  if (stateVal === "starting") return t("settings.state.starting");
  return t("settings.state.disconnected");
}

// ===== buildEngChip: 顶栏三态芯片（v41 · 与设置页灯同源） =====
//   shell.js 调 buildEngChip() 挂壳层固定右上角槽位（快批⑦起·全视图恒定位）；本批尽量减少 shell 侵入
//   状态来源 = getChipState() / subscribeChipState()
export function buildEngChip() {
  if (typeof document === "undefined") return null;
  const chip = el("div", { id: "engChip", class: "eng-chip", "data-eng-chip": getChipState() });
  const lamp = el("span", { class: "eng-lamp " + _lampClass(getChipState()) });
  chip.appendChild(lamp);
  const txt = el("span", { class: "eng-chip-text", text: _chipText(getChipState()) });
  chip.appendChild(txt);
  function paint(stateVal) {
    chip.setAttribute("data-eng-chip", stateVal);
    chip.className = "eng-chip eng-chip-" + stateVal;
    lamp.className = "eng-lamp " + _lampClass(stateVal);
    txt.textContent = _chipText(stateVal);
  }
  subscribeChipState(paint);
  // S3-4c 启停控制（空-012）：已连接 → confirm 停止（最小实现）；未连接 → confirm 启动
  //   （startEngine 与设置页启动钮同链）；启动中 → 只提示（进行中不重复点火）。
  chip.addEventListener("click", async () => {
    const st = getChipState();
    if (st === "connected") {
      if (!_confirm(t("settings.chip.confirmStop"))) return;
      await stopEngine();
      return;
    }
    if (st === "starting") {
      showToast("info", t("settings.chip.startingToast"));
      return;
    }
    if (!_confirm(t("settings.chip.confirmStart"))) return;
    await startEngine();
  });
  return chip;
}

function _chipText(stateVal) {
  if (stateVal === "connected") return t("settings.chip.connected");
  if (stateVal === "starting") return t("settings.chip.starting");
  return t("settings.chip.disconnected");
}