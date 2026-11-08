// setup.js — 设定 TAB 视图（GUI1.3 S1-2 T2 + S2-2 T1 后处理三键涟漪）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 设定 TAB 框架区 :1216-1271（4 列 .fgrid + 输出 fg-grp）
//   - 14 键表 :1219-1271（键名/选项/默认值与 store T1 对齐）
// S2-2 T1 涟漪：14 键 → 17 键（追加 放大/插帧/放大引擎）；旧「插帧/超分」两勾选整体下线
//
// === 任务边界 ===
// 本模块（T2）实装：17 键表单 + 输出开关 4 chk + mount 接入
// 不实装：段卡（T3）/ 资源编排四子区（T4）/ 全局提示词（T5）/ 提交主链（T6）
//   音乐文件行的「选择」按钮：T2 暂作占位（file picker 实装归后续批）
// S2-2 T1 边界：旧「插帧/超分」全局联动两勾选整体下线（PROC_GP_FIELDS/applyGpProcToggle 循环+两勾 DOM 全删）；
//   段卡级 segcards 的 插帧/超分/超分模式 编辑态保留（执行通道改 postfx sids，归后续批）
// S2-2 T3 边界：后处理三件套（放大/插帧/放大引擎）从「输出开关 / 后处理」混合 fg-grp 拆为独立「后处理」fg-grp + 前置标注；
//   放大引擎显示映射（cb-v 显示 label「SeedVR2 · 正片」/「RTX VSR · 快速」，存储值仍为 seedvr2/rtxvsr）
//   渲染次序：GLOBAL_KEYS 数组序单遍渲染（10 叶子键 → 后处理组 → 输出开关组；refreshGlobals 走全量重 mount 覆盖）
// 批10C-T2 F62：设定 TAB 拆双子页签（老板裁⑥A/⑫A）——提示词页=全局提示词+段卡；参数页=17键+后处理+输出开关+资源编排+四块+分配器；
//   两子页同挂 DOM display:none 切换（不销毁不重挂）·无记忆默认提示词页（I 块 2026-10-25·新用户第一屏直见分镜表）·localStorage 记忆优先（gui13.setupSubTab）·gotoSeg 锚落切提示词页
//
// === API ===
//   GLOBAL_KEYS                 17 键描述（key/label/control/opts?/default/title?·数组序=屏幕序）
//   OUTPUT_SWITCH_KEYS          4 项输出开关布尔键（关音乐/关对白/关水印字幕/全部段生成完自动接成一条片；放大/插帧属后处理·归 buildPostProcGroup）
//   getDefault17()              17 键默认（与 store.createProject 同源）
//   cboxKeys / editCboxKeys / inputKeys / fileKeys / checkboxKeys → 按控件类型筛（分类查询；mount 不再分批循环）
//   resolveControl(key)         → "cbox" | "cbox.edit" | "input" | "file" | "checkbox" | null
//   buildOutputSwitchGroup(pid,gp) → 输出开关 fg-grp DOM（S2-2 T3）
//   buildPostProcGroup(pid,gp)     → 后处理 fg-grp DOM + 前置标注（S2-2 T3）
//   mount(container, projectId) → 渲染设定 TAB 入容器

import { load as storeLoad, save as storeSave, updateGlobalParams, createProject, subscribe as storeSubscribe, unsubscribe as storeUnsubscribe } from "../store/store.js";
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
import { applyOption, isEditCbox, getCurrentValue, setCurrentValue, initDocumentDelegate } from "../ui/cbox.js";
import { pickLocalFile, uploadAudioToEngine } from "../core/audio_upload.js"; // W-06 音乐文件选择（批 3）
import { fetchTemplateList, classifyTemplateFamily, DEPRECATED_TEMPLATE_FAMILIES } from "../core/templates.js"; // M6-T2 R-30 模板写口
import { t, pickDisplay } from "../core/i18n.js";   // #89 T2：参数页用户可见文案取词（setup.*·切换=整页 reload 故模块级常量同语言一致）；#89 T7：cbox.edit 回显侧接 pickDisplay（zh 直通·value 零改）
import { mount as segcardsMount } from "./segcards.js";
import { mount as pvboxMount } from "./pvbox.js";
import { mount as assignerMount } from "./assigner-panel.js"; // 批 8 T3：分配器面板（legacy ②③块）
import { mount as resourcesMount, refreshTemplateAlignment } from "./resources.js";
import * as prompt from "./prompt.js";
// 账本 #32（三件补做批 T6·取代 R-56 裁决③「二选一无联动」）：参数页单驱动源联动——
//   与剪辑页 buildPostfxAdvanced 同一状态机（app/js/ui/postfx_linkage.js 纯函数·两页同规则）。
//   #32 修复（2026-10-20）：基准改 比例×质量 纯算（postfxBaseFromRatioMP·半偶舍入复刻引擎），
//   探针链退役；基准更新经既有 globalParams:update 事件重驱动（驱动在位才追·无驱动不追补）。
import { postfxLinkInitialState, postfxLinkInitGates, postfxLinkGates, postfxLinkStep, postfxBaseFromRatioMP } from "../ui/postfx_linkage.js";

// S1-3 结转清偿 C2：当前轮 pv 刷新订阅的函数引用（重挂时先退订，防监听累积）
let segPvSubFn = null;

// ===== 17 键描述（数组序 = 屏幕序 · v43 :1219-1247 原型序 + 老板走查批A 1.1 键序重排） =====
// 键名与 store.createProject().globalParams 逐键一致（中文键名 + 默认值）
// 控件类型：cbox / cbox.edit / input / file / checkbox
//   - cbox: 普通下拉（cb-v 显示当前值）
//   - cbox.edit: 可手输下拉（cb-in 可输入任意值）
//   - input: 文本输入
//   - file: 文件行（vfile + 选择按钮；T2 暂不实装选择弹窗）
//   - checkbox: 布尔开关
//
// 序：10 叶子键（比例/质量/生成步数/语言/配乐/氛围声/音乐混入/审片门/默认负面/音乐文件）
//   → 后处理三键（放大/插帧/放大引擎）→ 输出开关四键（原型屏幕序 后处理→输出开关）
//
// S2-2 T1 后处理三键：
//   - 放大/插帧：checkbox default false；title 注明"仅合并模式且自动拼接=开时生效"（语义约束）
//   - 放大引擎：cbox opts="seedvr2|rtxvsr" default "seedvr2"；SeedVR2（正片）｜RTX VSR（快速）
//
// 老板走查批A 1.2：比例 cbox → cbox.edit（下拉+可手输，与生成步数同款）+ opts 追加 3:4
//   （引擎 ASPECT_MAP 支持 3:4 · batch_core.py:2755-2766；提交层 mapRatioToEngine 提裸比）

export const GLOBAL_KEYS = [
  // #89 T2：label/opts 显示侧/placeholder/title 走 t()；key/default=globalParams 数据契约（中文键值零改动）。
  //   opts "value=label" 形态（cbox.js 按 "=" 拆：菜单显示 label、change 派发 value）——
  //   zh 下 label===value，渲染逐字同改前；en 下菜单/回显显示英文、入库仍为中文原值（ENGINE_DISPLAY 回显映射同款）。
  { key: "比例", label: t("setup.key.ratio"), control: "cbox.edit", opts: `9:16 竖屏=${t("setup.opt.ratio.portrait")}|16:9 横屏=${t("setup.opt.ratio.landscape")}|1:1|4:3|3:4`, default: "9:16 竖屏" },
  { key: "质量", label: t("setup.key.quality"), control: "cbox.edit", opts: `0.4 · 流畅=${t("setup.opt.quality.smooth")}|1.0 · 高清=${t("setup.opt.quality.hd")}|2.0 · 超清=${t("setup.opt.quality.uhd")}`, default: "0.4", title: t("setup.key.quality.title") },
  { key: "生成步数", label: t("setup.key.steps"), control: "cbox.edit", opts: "8A8V|6A6V|4V4A", default: "8A8V", title: t("setup.key.steps.title") },
  { key: "语言", label: t("setup.key.lang"), control: "cbox", opts: `中文=${t("setup.opt.lang.zh")}|英文=${t("setup.opt.lang.en")}`, default: "中文" },
  { key: "配乐", label: t("setup.key.soundtrack"), control: "cbox", opts: `自动=${t("setup.opt.auto")}|无=${t("setup.opt.none")}`, default: "自动" },
  { key: "氛围声", label: t("setup.key.ambience"), control: "cbox", opts: `自动=${t("setup.opt.auto")}|无=${t("setup.opt.none")}`, default: "自动" },
  { key: "音乐混入", label: t("setup.key.musicMix"), control: "cbox", opts: `覆盖=${t("setup.opt.mixCover")}|混音=${t("setup.opt.mixBlend")}`, default: "覆盖", title: t("setup.key.musicMix.title") },
  { key: "审片门", label: t("setup.key.reviewGate"), control: "cbox", opts: `关=${t("setup.opt.gate.off")}|开 · 宽松=${t("setup.opt.gate.relaxed")}|开 · 严格=${t("setup.opt.gate.strict")}`, default: "关", title: t("setup.key.reviewGate.title") },
  { key: "默认负面", label: t("setup.key.negDefault"), control: "input", default: "", placeholder: t("setup.ph.negDefault"), title: t("setup.key.negDefault.title") },
  { key: "音乐文件", label: t("setup.key.musicFile"), control: "file", default: "" },
  // S2-2 T1 新三键（后处理产线 · 全局勾选经 store.globalParams 传递 · 段卡级编辑态在 segcards.js 保留）
  // R56R57 T1：旧三键参数页**停写**（新通道见下方 postfx_* 六键；submit.js postfxGatePass 继续读旧键·
  //   读不到=引擎 CSV 通道休眠·设计如此·一字不动）。描述保留在册=17 键契约不破（store 默认/预设快照仍引用）。
  { key: "放大", label: t("setup.key.upscale"), control: "checkbox", default: false, title: t("setup.key.upscale.title") },
  { key: "插帧", label: t("setup.key.interp"), control: "checkbox", default: false, title: t("setup.key.interp.title") },
  // S2-2 T3 放大引擎：opts 用 "value=label" 形态（cbox.js 按 "=" 拆，cb-v 显示 label、change 事件 dispatch value）
  { key: "放大引擎", label: t("setup.key.upEngine"), control: "cbox", opts: `seedvr2=${t("setup.engine.seedvr2")}|rtxvsr=${t("setup.engine.rtxvsr")}`, default: "seedvr2", title: t("setup.key.upEngine.title") },
  // R56R57 T1 后处理新六键（GUI 侧平铺键·globalParams 直存·不入 store 17 键契约）：
  //   勾「放大」→展开 引擎(postfx_engine)+倍数(postfx_scale)+宽×高(postfx_w/postfx_h)——
  //   #32 单驱动源联动：填倍数→宽高自动算（有基准）并只读；填宽/高→另一维自动+倍数回写只读；
  //   清驱动源→释放（值保留）。勾「插帧」→展开 目标帧数(postfx_fps)，
  //   fps 非空=插帧开（勾选态由它派生·取消勾选即清空）。数组序=后处理组内屏幕序。
  { key: "postfx_upscale", label: t("setup.key.upscale"), control: "checkbox", default: false, title: t("setup.key.postfxUpscale.title") },
  { key: "postfx_engine", label: t("setup.key.upEngine"), control: "cbox", opts: `seedvr2=${t("setup.engine.seedvr2")}|rtxvsr=${t("setup.engine.rtxvsr")}`, default: "seedvr2", title: t("setup.key.postfxEngine.title") },
  { key: "postfx_scale", label: t("setup.key.upScale"), control: "input", default: "", placeholder: t("setup.ph.postfxScale"), title: t("setup.key.postfxScale.title") },
  { key: "postfx_w", label: t("setup.key.targetW"), control: "input", default: "", placeholder: t("setup.ph.pair"), title: t("setup.key.postfxW.title") },
  { key: "postfx_h", label: t("setup.key.targetH"), control: "input", default: "", placeholder: t("setup.ph.pair"), title: t("setup.key.postfxH.title") },
  { key: "postfx_fps", label: t("setup.key.targetFps"), control: "input", default: "", placeholder: t("setup.ph.postfxFps"), title: t("setup.key.postfxFps.title") },
  // 输出开关 4 键（属输出关断·非后处理；渲染归 buildOutputSwitchGroup）
  { key: "关音乐", label: t("setup.key.muteMusic"), control: "checkbox", default: false, title: t("setup.key.muteMusic.title") },
  { key: "关对白", label: t("setup.key.muteDialog"), control: "checkbox", default: false, title: t("setup.key.muteDialog.title") },
  { key: "关水印字幕", label: t("setup.key.muteWatermark"), control: "checkbox", default: false, title: t("setup.key.muteWatermark.title") },
  { key: "全部段生成完自动接成一条片", label: t("setup.key.autoMerge"), control: "checkbox", default: true, title: t("setup.key.autoMerge.title") },
];

// S2-2 T3 后处理：放大引擎 value → label 查找（cb-v 初始渲染用 label；
// applyOption 收到 "value=label" 时按 "=" 拆 display label / store value）。
// 存储值恒为 seedvr2/rtxvsr（引擎 CSV 白名单字面量）。
// #89 T2：扩为全部 cbox 中文值 → 显示 label 的回显映射（键=store 数据值零改动·值=t() 显示侧）；
//   zh 下值与改前逐字一致，en 下 cb-v 显示英文、入库仍为中文原值。
const ENGINE_DISPLAY = {
  seedvr2: t("setup.engine.seedvr2"),
  rtxvsr: t("setup.engine.rtxvsr"),
  "中文": t("setup.opt.lang.zh"),
  "英文": t("setup.opt.lang.en"),
  "自动": t("setup.opt.auto"),
  "无": t("setup.opt.none"),
  "覆盖": t("setup.opt.mixCover"),
  "混音": t("setup.opt.mixBlend"),
  "关": t("setup.opt.gate.off"),
  "开 · 宽松": t("setup.opt.gate.relaxed"),
  "开 · 严格": t("setup.opt.gate.strict"),
};

// R56R57 T1：后处理新六键（GUI 侧平铺键）——分类过滤（cboxKeys 等）全数排除，
//   归 buildPostProcGroup 专属渲染（防通用网格双实例·同 放大引擎 先例）
const POSTFX_FLAT_KEYS = new Set(["postfx_upscale", "postfx_engine", "postfx_scale", "postfx_w", "postfx_h", "postfx_fps"]);
// 后处理组渲染专属键全集（mount 通用网格跳过·buildPostProcGroup 独家渲染）
const POSTPROC_OWNED_KEYS = new Set(["放大", "插帧", "放大引擎", ...POSTFX_FLAT_KEYS]);

// 输出开关 4 项（17 键中的 4 个布尔键 · 放大/插帧属后处理非输出·T1 不扩；T3 渲染归口）
export const OUTPUT_SWITCH_KEYS = ["关音乐", "关对白", "关水印字幕", "全部段生成完自动接成一条片"];

// ===== 纯函数 =====

export function getDefault17() {
  // 来自 store.createProject 的 17 键默认（保持单一数据源）
  const fresh = createProject("");
  return { ...fresh.globalParams };
}

// 放大引擎：cbox 描述保留在 GLOBAL_KEYS（供 buildPostProcGroup 渲染后处理组·单实例）。
// 但从通用 cboxKeys() 过滤：避免通用网格再渲一份 → [data-gp="放大引擎"] 双实例
// （双审 B 探针实测·effe8e1 引入）。后处理组专属键归该组独有（R56R57 T1：postfx_* 六键同口径排除）。
export function cboxKeys() {
  return GLOBAL_KEYS.filter((k) => k.control === "cbox" && k.key !== "放大引擎" && !POSTFX_FLAT_KEYS.has(k.key));
}
export function editCboxKeys() { return GLOBAL_KEYS.filter((k) => k.control === "cbox.edit"); }
export function inputKeys() { return GLOBAL_KEYS.filter((k) => k.control === "input" && !POSTFX_FLAT_KEYS.has(k.key)); }
export function fileKeys() { return GLOBAL_KEYS.filter((k) => k.control === "file"); }
export function checkboxKeys() { return GLOBAL_KEYS.filter((k) => k.control === "checkbox" && !POSTFX_FLAT_KEYS.has(k.key)); }

export function resolveControl(key) {
  const d = GLOBAL_KEYS.find((k) => k.key === key);
  return d ? d.control : null;
}

// ===== S1-2 T4：refreshGlobals 导出 =====
// 预设加载 → 全局参数 17 键被覆写 → 需要刷新设定 TAB 表单回填。
// 资源编排 mount 写一个 window.__gui13RefreshGlobals 钩子；本函数由 setup 模块自身注册一次。
// 实际表单刷新：重 render 整个 mount（最简单稳；增量刷新可在后续批做）。
// 行为契约：仅当 form ref 存在且与 projectId 匹配才生效（防止跨项目误刷）
let _formProjectId = null;
let _formRef = null;
export function refreshGlobals(projectId) {
  if (!projectId) return false;
  if (!_formRef || _formProjectId !== projectId) return false;
  if (typeof document === "undefined" || !_formRef.parentNode) return false;
  // 拆掉当前形态 → 重 mount
  // （批10C-T2 修复：先取父容器再摘除——原式 removeChild 后读 _formRef.parentNode 恒为 null
  //   （真 DOM 语义·摘除节点 parentNode 置空），mount(null) 返回 null → 预设加载后设定页空白且本函数恒 false）
  const parent = _formRef.parentNode;
  parent.removeChild(_formRef);
  _formRef = mount(parent, projectId);
  return !!_formRef;
}

// ===== DOM 构造辅助（仅 DOM 环境使用） =====

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

// 渲染单个 17 键的表单控件
function renderControl(desc, currentValue, projectId) {
  const c = desc.control;
  if (c === "cbox") {
    const box = el("div", { class: "cbox", "data-gp": desc.key, "data-opts": desc.opts || "" });
    // S2-2 T3 放大引擎：cb-v 初始值写 label（store 存 seedvr2/rtxvsr，UI 显示「SeedVR2 · 正片」/「RTX VSR · 快速」）
    const raw = currentValue == null ? desc.default : currentValue;
    const display = ENGINE_DISPLAY[raw] || raw;
    const v = el("span", { class: "cb-v", text: display });
    box.appendChild(v);
    box.appendChild(el("span", { class: "cb-a", text: "▾" }));
    return box;
  }
  if (c === "cbox.edit") {
    const box = el("div", { class: "cbox edit", "data-gp": desc.key, "data-opts": desc.opts || "" });
    // #89 T7：回显侧接 pickDisplay（比例/质量/生成步数·zh 直通=改前逐字·en=MAPS.globalParams 英文；
    //   ENGINE_DISPLAY 既有链（cbox 分支）不破坏·store 值零改——input 编辑仍写 input.value 原样入库）
    const rawEcho = currentValue == null ? desc.default : currentValue;
    const input = el("input", { class: "cb-in", value: pickDisplay("globalParams", rawEcho) });
    input.setAttribute("type", "text");
    if (desc.key === "生成步数") input.classList.add("num");
    box.appendChild(input);
    box.appendChild(el("span", { class: "cb-a", text: "▾" }));
    return box;
  }
  if (c === "input") {
    const input = el("input", { type: "text", placeholder: desc.placeholder || "" });
    input.value = currentValue == null ? desc.default : currentValue;
    input.setAttribute("data-gp", desc.key);
    return input;
  }
  if (c === "file") {
    const wrap = el("div", { class: "file-row" });
    wrap.setAttribute("data-gp", desc.key);
    wrap.style.cssText = "display:flex;gap:6px;align-items:center";
    const vfile = el("span", { class: "vfile num" });
    vfile.textContent = currentValue || t("settings.ph.notSelected");
    vfile.style.flex = "1";
    vfile.style.minWidth = "0";
    const btn = el("span", { class: "ghostbtn-mini", text: t("setup.file.pick") });
    // W-06 转正（自主排期批 3）：本机音频 → /upload/image 通道进引擎 input →
    //   绝对路径写 globalParams["音乐文件"]（引擎 BGM 预检 os.path.isfile 要绝对路径）
    btn.addEventListener("click", async () => {
      if (typeof document === "undefined" || !projectId) return;
      const f = await pickLocalFile("audio/*", "gui13-music-pick");
      if (!f) return;
      if (typeof showToast === "function") showToast("info", t("setup.file.uploading", { name: f.name }));
      const up = await uploadAudioToEngine(f);
      if (!up.ok) {
        if (typeof showToast === "function") showToast("error", t("setup.file.upFail", { msg: up.error }));
        return;
      }
      updateGlobalParams(projectId, { [desc.key]: up.absPath });
      vfile.textContent = up.absPath;
      vfile.title = up.absPath;
      if (typeof showToast === "function") showToast("success", t("setup.file.picked", { name: f.name }));
    });
    wrap.appendChild(vfile);
    wrap.appendChild(btn);
    return wrap;
  }
  if (c === "checkbox") {
    const label = el("label");
    if (desc.title) label.setAttribute("title", desc.title);
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!(currentValue != null ? currentValue : desc.default);
    cb.setAttribute("data-gp", desc.key);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(desc.label));
    return label;
  }
  return null;
}

// 把单个 change 事件桥到 store.updateGlobalParams
function bindChangeToStore(node, projectId, key) {
  if (!node) return;
  // 里程碑①真机补验修复：checkbox 渲染返回 label 容器（内含 input），原实现三分支均不匹配
  // 导致监听从未挂上（UI 勾选变化 store 不写）——此处下钻解包到真实控件节点
  if (node.tagName === "LABEL" && node.querySelector) {
    const inner = node.querySelector("input[type=checkbox]");
    if (inner) node = inner;
  }
  const handler = (e) => {
    let value;
    if (node.classList && node.classList.contains("cbox")) {
      // cbox 取值：applyOption 派发的 change 带 detail.value（里程碑①真机补验修复：原实现缺此分支，
      // cbox(DIV) 落在 INPUT/file-row 两分支之外 → value=undefined → 静默不写 store）
      value = e && e.detail && e.detail.value !== undefined ? e.detail.value : undefined;
    } else if (node.tagName === "INPUT") {
      const t = node.getAttribute("type");
      if (t === "checkbox") value = node.checked;
      else if (node.classList.contains("cb-in")) value = node.value;
      else value = node.value;
    } else if (node.classList.contains("file-row")) {
      // T2 占位：file row 当前不写 store
      return;
    }
    if (value === undefined) return;
    updateGlobalParams(projectId, { [key]: value });
  };
  if (node.classList && node.classList.contains("cbox")) {
    // cbox 自身：派发 change 事件（applyOption 时已派发）
    node.addEventListener("change", handler);
    // 登记项 2（走查修复批 §四.2）：cbox.edit 手输值此前不入库——"cbox" 类先命中本分支，
    // cb-in 的 input 事件从未绑定（下拉选走 change 正常、手输刷新即丢）→ 下钻挂 input 直写 store
    if (node.classList.contains("edit") && node.querySelector) {
      const input = node.querySelector("input.cb-in");
      if (input) input.addEventListener("input", () => updateGlobalParams(projectId, { [key]: input.value }));
    }
  } else if (node.tagName === "INPUT") {
    const t = node.getAttribute("type");
    if (t === "checkbox") {
      node.addEventListener("change", handler);
    } else {
      node.addEventListener("input", handler);
    }
  } else if (node.classList && node.classList.contains("file-row")) {
    // no-op
  }
}

// ===== mount(container, projectId) =====

// S2-2 T3：输出开关 fg-grp（4 项：关音乐/关对白/关水印字幕/全部段生成完自动接成一条片）。
// 与后处理三件套（放大/插帧/放大引擎）拆为两个独立 fg-grp（buildPostProcGroup）——前者属输出关断、后者属后处理产线
export function buildOutputSwitchGroup(projectId, gp) {
  const grp = el("div", { class: "fg-grp", style: "grid-column:1/-1" });
  const cap = el("div", { class: "fg-grp-cap", text: t("setup.grp.output") });
  grp.appendChild(cap);
  const body = el("div", { class: "fg-grp-body" });
  for (const key of OUTPUT_SWITCH_KEYS) {
    const desc = GLOBAL_KEYS.find((d) => d.key === key);
    if (!desc) continue;
    const node = renderControl(desc, gp[desc.key], projectId);
    bindChangeToStore(node, projectId, desc.key);
    body.appendChild(node);
  }
  grp.appendChild(body);
  return grp;
}

// R56R57 T1：后处理 fg-grp 新形态（B 形态·全模式接管）——
//   勾「放大」(postfx_upscale) → 展开：放大引擎(postfx_engine cbox) + 倍数(postfx_scale) + 宽×高(postfx_w/postfx_h)。
//     账本 #32（取代 R-56 裁决③「二选一无联动」）：倍数/宽高两组单驱动源联动——
//     填倍数→宽高自动算（有基准）并只读；填宽/高→另一维自动+倍数回写只读；清驱动源→释放（值保留）。
//     互斥提示（原 POSTFX_MUTEX_HINT「同填按倍数执行」）随只读联动退役：同填在只读联动下 UI 不可达；
//     编排层「倍数优先」保留（postfx_pipeline 锁·scale 与 w/h 并存仍按倍数执行）。
//   勾「插帧」（UI 标识 data-gp=插帧·手动绑定不经 bindChangeToStore）→ 展开：目标帧数(postfx_fps)——
//     fps 非空=插帧开（勾选态由它派生·取消勾选即清空）。帧率不在联动域（超分与插帧互不影响）。
//   旧三键（放大/插帧/放大引擎）停写：submit.js postfxGatePass 继续读旧键·读不到=CSV 通道休眠（设计·零改）。
const POST_PROC_NOTE = t("setup.grp.postprocNote");   // #89 T2：切换=整页 reload 故模块级常量同语言一致

const _ROW_FLEX = "display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin:4px 0;grid-column:1/-1"; // fps 行单对横排；跨整行（fg-grp-body=4/3 列 grid·跨行免窄轨挤压）
const _POSTFX_COL = "display:flex;flex-direction:column;gap:4px;margin:4px 0;grid-column:1/-1"; // T3c（老板 2026-10-20「单独做布局」）：放大参数纵排独立小表单容器；T3c-2 R1：跨整行（行内容≈292px 恒定·窄格位 92px 会 box 溢出）
const _POSTFX_LINE = "display:flex;align-items:center;gap:8px;flex-wrap:nowrap"; // 列内行容器（行内容 ≤300px·任何分辨率不溢出不重叠）
const _ROW_NONE = "display:none;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0;grid-column:1/-1"; // 收起态同款跨行声明（display:none 无布局影响·开关往返 cssText 恒定）
const _ROW_LB = "font-size:12px;color:var(--txt2);flex-shrink:0;width:56px;text-align:right"; // 定宽右对齐（区内自一致·不再要求与上方网格列对齐）
// 标签-框成对子容器（对内 nowrap·跨行排布由行容器负责）
function _pair(labelText, inputNode) {
  const p = el("div", { style: "display:flex;align-items:center;gap:6px;flex-shrink:0" });
  p.appendChild(el("span", { text: labelText, style: _ROW_LB }));
  p.appendChild(inputNode);
  return p;
}
export function buildPostProcGroup(projectId, gp) {
  const grp = el("div", { class: "fg-grp", style: "grid-column:1/-1" });
  const cap = el("div", { class: "fg-grp-cap" });
  cap.appendChild(document.createTextNode(t("setup.grp.postproc")));
  cap.appendChild(el("span", { class: "inh", text: POST_PROC_NOTE }));
  grp.appendChild(cap);
  const body = el("div", { class: "fg-grp-body" });
  const desc = (k) => GLOBAL_KEYS.find((d) => d.key === k);

  // 勾「放大」→ postfx_upscale（bindChangeToStore 桥写新通道·data-gp=描述键即新键）
  const upNode = renderControl(desc("postfx_upscale"), gp.postfx_upscale, projectId);
  bindChangeToStore(upNode, projectId, "postfx_upscale");
  const upCb = upNode.querySelector("input[type=checkbox]");
  body.appendChild(upNode);

  // 放大参数区（T3c 纵排独立小表单·默认收起·勾选展开·值回填自 gp）：
  //   行1=放大引擎 行2=倍数 行3=宽×高（两对+「×」分隔·高标签在框前）——upRow 单容器纵排·每行独立行容器
  const upRow = el("div", { class: "postfx-row", style: gp.postfx_upscale ? _POSTFX_COL : _ROW_NONE });
  const engineNode = renderControl(desc("postfx_engine"), gp.postfx_engine, projectId);
  bindChangeToStore(engineNode, projectId, "postfx_engine");
  const scaleInput = renderControl(desc("postfx_scale"), gp.postfx_scale, projectId);
  const wInput = renderControl(desc("postfx_w"), gp.postfx_w, projectId);
  const hInput = renderControl(desc("postfx_h"), gp.postfx_h, projectId);
  for (const inp of [scaleInput, wInput, hInput]) inp.style.cssText = "width:72px"; // renderControl input 零样式致参差·三数值框统一宽
  const lineEngine = el("div", { style: _POSTFX_LINE });
  lineEngine.appendChild(_pair(t("setup.key.upEngine"), engineNode));
  const lineScale = el("div", { style: _POSTFX_LINE });
  lineScale.appendChild(_pair(t("setup.key.factor"), scaleInput));
  const lineWH = el("div", { style: _POSTFX_LINE });
  lineWH.appendChild(_pair(t("setup.key.w"), wInput));
  lineWH.appendChild(el("span", { text: "×", style: "font-size:12px;color:var(--txt3);flex-shrink:0" }));
  lineWH.appendChild(_pair(t("setup.key.h"), hInput));
  upRow.appendChild(lineEngine);
  upRow.appendChild(lineScale);
  upRow.appendChild(lineWH);
  body.appendChild(upRow);

  // ===== #32 单驱动源联动（与剪辑页 buildPostfxAdvanced 同一状态机·两页同规则③）=====
  //   input 事件 → postfxLinkStep（写值+置 disabled/title/placeholder·只改态不清值——segcards 先例推广）；
  //   自动值同步落库（重开回填基准）；互斥提示随只读联动退役（同填 UI 不可达）。
  let _link = postfxLinkInitialState();
  let base = postfxBaseFromRatioMP(gp["比例"], gp["质量"]);   // #32 修复（2026-10-20）：基准纯算（比例×质量·半偶复刻引擎）·探针链退役
  function baseDims() { return base && base.w > 0 && base.h > 0 ? base : null; }
  const _POSTFX_FIELDS = [
    ["scale", scaleInput, "postfx_scale", desc("postfx_scale").placeholder || ""],
    ["w", wInput, "postfx_w", desc("postfx_w").placeholder || ""],
    ["h", hInput, "postfx_h", desc("postfx_h").placeholder || ""],
  ];
  function applyGate(inp, gate, staticPh) {
    inp.disabled = gate.disabled;
    inp.setAttribute("title", gate.title);
    inp.setAttribute("placeholder", gate.placeholder || staticPh);
  }
  function applyGates(gates) {
    for (const [f, inp, , ph] of _POSTFX_FIELDS) applyGate(inp, gates[f], ph);
  }
  function govern(field) {
    const ent = _POSTFX_FIELDS.find((x) => x[0] === field);
    const r = postfxLinkStep(_link, { field, raw: String(ent[1].value || "") }, baseDims());
    _link = r.state;
    for (const [f, inp, key, ph] of _POSTFX_FIELDS) {
      if (r.writes[f] != null) {
        inp.value = r.writes[f];   // 直写不派发 input——防重入（剪辑页同口径）
        updateGlobalParams(projectId, { [key]: r.writes[f] });   // 自动值落库（重开回填基准）
      }
      applyGate(inp, r.gates[f], ph);
    }
  }
  // #32 修复（2026-10-20）：基准更新即重驱动——订阅既有 globalParams:update（改质量/比例实时重算）。
  //   基准变了且驱动在位 → govern 重驱动宽高；无驱动源不追补（「不回溯」收窄口径）。
  function refreshBase() {
    const proj = storeLoad(projectId);
    const src = proj && proj.globalParams ? proj.globalParams : gp;
    const next = postfxBaseFromRatioMP(src["比例"], src["质量"]);
    if (next && base && next.w === base.w && next.h === base.h) return;   // B1：基准未变早退（防同步 notify→govern 写库→回调 同步再入栈溢出）
    if (!next && !base) return;
    base = next;
    if (_link.driver) govern(_link.driver);   // 驱动在位=基准更新即重驱动；无驱动不追补
  }
  let _gpSubLive = false;   // N1（复核2轮）：曾连接 latch——构建期脱离文档不误杀（init govern 在 appendChild 前发 notify）
  const _gpSub = (ev) => {
    if (!ev || ev.type !== "globalParams:update") return;
    if (ev.projectId && ev.projectId !== projectId) return;
    if (grp.isConnected) { _gpSubLive = true; }
    else if (_gpSubLive) { storeUnsubscribe(_gpSub); return; }   // 挂载过又卸载=页面重建·自清（假 doc 永不连接则永不退订·projectId 过滤隔离跨测）
    refreshBase();
  };
  storeSubscribe(_gpSub);
  // 初值治理：store 有倍数 = 倍数驱动生效（与编排层倍数优先同源）·重开恢复锁定态并按当期基准重算宽高（治陈旧宽高）
  {
    const init = postfxLinkInitGates({ scale: gp.postfx_scale, w: gp.postfx_w, h: gp.postfx_h });
    _link = init.state;
    applyGates(postfxLinkGates(_link, baseDims()));
    if (_link.driver) govern(_link.driver);
  }
  // 倍数/宽/高 → 直写平铺键原串 + 联动步进（存原串·空串=未填；值域校验交编排层）
  for (const [f, inp, key] of _POSTFX_FIELDS) {
    inp.addEventListener("input", () => {
      updateGlobalParams(projectId, { [key]: inp.value });
      govern(f);
    });
  }
  // 勾选态切换行显隐（写库由 bindChangeToStore 承担·此处只管展开/收起）
  upCb.addEventListener("change", () => {
    upRow.style.cssText = upCb.checked ? _POSTFX_COL : _ROW_NONE;
  });

  // 勾「插帧」：勾选态由 postfx_fps 非空派生；取消勾选 → postfx_fps 清空（非空=开 语义同步收回）
  const interpOn = String(gp.postfx_fps == null ? "" : gp.postfx_fps).trim() !== "";
  const ipNode = renderControl(desc("插帧"), interpOn, projectId);
  ipNode.setAttribute("title", t("setup.key.interpFps.title"));
  const ipCb = ipNode.querySelector("input[type=checkbox]");
  body.appendChild(ipNode);

  const fpsRow = el("div", { class: "postfx-row", style: interpOn ? _ROW_FLEX : _ROW_NONE });
  const fpsInput = renderControl(desc("postfx_fps"), gp.postfx_fps, projectId);
  fpsRow.appendChild(_pair(t("setup.key.targetFps"), fpsInput));
  body.appendChild(fpsRow);
  fpsInput.addEventListener("input", () => {
    updateGlobalParams(projectId, { postfx_fps: fpsInput.value });
  });
  ipCb.addEventListener("change", () => {
    if (ipCb.checked) {
      fpsRow.style.cssText = _ROW_FLEX;
    } else {
      fpsRow.style.cssText = _ROW_NONE;
      fpsInput.value = "";
      updateGlobalParams(projectId, { postfx_fps: "" });
    }
  });

  grp.appendChild(body);
  return grp;
}

// ===== 批 M6-T2（R-30）：项目级「模板」写口（.fgrid 外独立 section · B6 落位）=====
// 值形态 B2（显示与落库分离）：下拉显示引擎清单 name（相对路径白话名）·落库 hit.path（绝对路径）
//   ——存 name 会被 preflight「工作流不存在」400 整条写口空转（settings.js:1025-1031 同款惯例）。
// 引擎不可达 → 「（引擎未连接）」占位不伪造清单（settings.js:1010 铁律）；空清单 → 「（无可用模板）」；
// 已废除族（fl2v/i2v）选项加「（已废除）」后缀·不置灰（settings.js:992 注释+:1000 拼法）；
// 首项「（跟随设定页模板）」=存空串（submit.js:489 trim 判空天然恢复兜底链·零新分支）；
// 回显：项目级值与清单按 _samePath 路径反查（settings.js:1022 惯例）·匹配不到显原始值；
// change → updateGlobalParams 落「模板」键 + 直调提交栏显示行刷新（J3·window 桥同
//   __gui13RefreshGlobals 惯例·不 import submit-bar.js）。
const TPL_FOLLOW_LABEL = t("setup.tpl.follow");   // #89 T2：切换=整页 reload 故模块级常量同语言一致

// 路径同一性（settings.js:863 _samePath 逐字同款·分隔符归一+大小写不敏感 Windows 语义）
function _samePath(a, b) {
  const norm = (s) => String(s == null ? "" : s).trim().replace(/[\\/]+/g, "/").toLowerCase();
  const na = norm(a);
  return !!na && na === norm(b);
}

// gui13.paths 字面量读（submit.js:246 readGuiPaths 同契约·未导出故字面量复刻·键=两侧契约）
function _readGuiPathsLiteral() {
  const s = (typeof globalThis !== "undefined" && globalThis.localStorage) || null;
  if (!s) return {};
  let obj = null;
  try { obj = JSON.parse(s.getItem("gui13.paths")); } catch (_e) { obj = null; }
  return (obj && typeof obj === "object") ? obj : {};
}

function buildTemplateSection(projectId, gp) {
  if (typeof document === "undefined") return null;
  const sec = el("section", { class: "setup-tpl-sec" });
  const grp = el("div", { class: "fg-grp" });
  grp.appendChild(el("div", { class: "fg-grp-cap", text: t("setup.grp.template") }));
  const body = el("div", { class: "fg-grp-body" });
  const box = el("div", { class: "cbox", "data-gp": "模板", "data-opts": "", title: t("setup.tpl.title") });
  box.appendChild(el("span", { class: "cb-v", text: t("settings.ph.loading") }));
  box.appendChild(el("span", { class: "cb-a", text: "▾" }));
  body.appendChild(box);
  grp.appendChild(body);
  sec.appendChild(grp);

  // 清单装载（settings.js reloadTplList 同款三态：清单/不可达占位/空清单）
  const entries = []; // {label, path}
  async function loadTplList() {
    const res = await fetchTemplateList(String(_readGuiPathsLiteral().template_path || "").trim());
    if (!res.ok) {
      setCurrentValue(box, t("settings.ph.engineDown"));
      box.title = t("setup.tpl.loadFail", { msg: res.error });
      return;
    }
    box.title = t("setup.tpl.title");
    entries.length = 0;
    if (!res.items.length) { setCurrentValue(box, t("settings.ph.noTemplates")); return; }
    for (const it of res.items) {
      const fam = classifyTemplateFamily(it.path);
      entries.push({ label: it.name + (fam && DEPRECATED_TEMPLATE_FAMILIES.has(fam) ? t("settings.tpl.familyDeprecated") : ""), path: it.path });
    }
    box.setAttribute("data-opts", [TPL_FOLLOW_LABEL, ...entries.map((en) => en.label)].join("|"));
    const cur = String(gp["模板"] == null ? "" : gp["模板"]).trim();
    if (!cur) { setCurrentValue(box, TPL_FOLLOW_LABEL); return; }
    const hit = entries.find((en) => _samePath(en.path, cur));
    setCurrentValue(box, hit ? hit.label : cur); // 命中显示 name·未命中显原始值
  }
  void loadTplList();

  box.addEventListener("change", (e) => {
    const val = e && e.detail && typeof e.detail.value === "string" ? e.detail.value : null;
    if (val == null) return;
    let path;
    if (val === TPL_FOLLOW_LABEL) {
      path = "";
    } else {
      const hit = entries.find((en) => en.label === val);
      if (!hit) return; // 未知选项不写库（settings.js:1026 惯例）
      path = hit.path;
    }
    updateGlobalParams(projectId, { "模板": path });
    // J3 同页联动：直调提交栏显示行刷新（window 桥·submit-bar mountSubmitBar 登记）
    try {
      if (typeof window !== "undefined" && typeof window.__gui13RefreshTemplateDisplay === "function") {
        window.__gui13RefreshTemplateDisplay();
      }
    } catch (_e) { /* 显示行不可用不阻断写库 */ }
    // 批 M6b-T1（R-49）：直调资源编排器按新模板重取引擎数据（同款直调·不走 store 订阅）
    void refreshTemplateAlignment().catch(() => { /* 编排器不可用不阻断写库 */ });
  });
  return sec;
}

export function mount(container, projectId) {
  if (typeof document === "undefined" || !container) return null;
  if (!projectId) return null;
  // 一次性挂 document 级点击委托（cbox 打开/关闭/选项回填）
  if (typeof document !== "undefined") initDocumentDelegate(document);

  // 从 store 读 17 键
  const proj = storeLoad(projectId);
  if (!proj) {
    const ph = el("div", { class: "shell-tab-placeholder" });
    ph.appendChild(el("div", { class: "ph-cap", text: t("setup.ph.noProject") }));
    container.appendChild(ph);
    return null;
  }
  const gp = proj.globalParams || (proj.globalParams = getDefault17());

  // 清空容器
  while (container.firstChild) container.removeChild(container.firstChild);

  const sec = el("section", { class: "setup-view" });
  sec.setAttribute("data-setup-project", projectId);

  // 列外壳
  const col = el("div", { class: "col setup-col" });
  col.style.cssText = "flex:1;min-width:0;resize:none";

  // ===== 批10C-T2 · F62：设定 TAB 拆双子页签（老板裁⑥A=设定内双子页签 + 裁⑫A 默认参数页）=====
  // 形态照资产/项目页 tag bar（.fchips/.fchip.on · theme.css :118-120 全局件·零新增 CSS）。
  // 两子页内容同挂 DOM、display:none 切换（不销毁不重挂）→ segcards 实例表 / pvbox 自持订阅零涟漪；
  // 子页签态 localStorage 记忆（键 gui13.setupSubTab）→ __gui13RefreshGlobals 重渲（卸载重挂）后保持。
  const subBar = el("div", { class: "fchips", id: "setupSubTabs" });
  const subChips = {};
  for (const [key, label, tip] of [
    ["params", t("setup.sub.params"), t("setup.sub.paramsTip")],
    ["prompt", t("setup.sub.prompt"), t("setup.sub.promptTip")],
  ]) {
    const chip = el("span", { class: "fchip", "data-subtab": key, title: tip, text: label });
    chip.addEventListener("click", () => applySubTab(key));
    subChips[key] = chip;
    subBar.appendChild(chip);
  }
  const paramsPage = el("div", { class: "setup-subpage", id: "setupPageParams" });
  const promptPage = el("div", { class: "setup-subpage", id: "setupPagePrompt" });
  // F62 涟漪③：gotoSeg 锚落（剪辑 TAB 段块双击→分镜表行）→ 切提示词页；
  //   此处只读判定，须在 segcardsMount 内 consumeJumpAnchor 摘锚之前
  let subTab = "prompt"; // I 块（2026-10-25）：无记忆默认提示词页（裁⑫A 默认参数页退役）；有 localStorage 记忆则被下方 saved 覆写
  try {
    const saved = localStorage.getItem("gui13.setupSubTab");
    if (saved === "params" || saved === "prompt") subTab = saved;
  } catch (_e) { /* 无 localStorage（单测桩/隐私态）→ 默认提示词页 */ }
  try {
    if (sessionStorage.getItem("gui13.gotoSeg")) subTab = "prompt";
  } catch (_e) { /* 无 sessionStorage → 不切 */ }
  function applySubTab(next) {
    subTab = next === "prompt" ? "prompt" : "params";
    for (const [k, chip] of Object.entries(subChips)) {
      if (k === subTab) chip.classList.add("on"); else chip.classList.remove("on");
    }
    paramsPage.style.cssText = subTab === "params" ? "" : "display:none";
    promptPage.style.cssText = subTab === "prompt" ? "" : "display:none";
    try { localStorage.setItem("gui13.setupSubTab", subTab); } catch (_e) { /* 无 localStorage → 不记忆 */ }
  }

  // 全局参数折叠组（F62：归参数页）
  const colfold = el("div", { class: "colfold open", id: "gcol" });
  const cap = el("div", { class: "cf-cap" });
  cap.appendChild(el("span", { text: t("setup.grp.globalParams") }));
  const capIcw = el("span", { class: "icw", style: "margin-left:auto" });
  capIcw.appendChild(el("span", { "data-ic": "chev", "data-sz": "14" }));
  cap.appendChild(capIcw);
  cap.addEventListener("click", () => colfold.classList.toggle("open"));
  colfold.appendChild(cap);

  const cfBody = el("div", { class: "cf-body" });
  const fgrid = el("div", { class: "fgrid" });
  // ===== 17 键单遍按 GLOBAL_KEYS 数组序渲染（数组序 = 屏幕序 · 老板走查批A 1.1）=====
  // 修复前按控件类型分批循环（cbox→cbox.edit→input→file）→ 质量/生成步数 掉到第 7-8 位；
  // 现逐键渲染、控件形态由 renderControl 内部分派；组键在其组首键位置整组落位
  // （后处理组=旧三键+R56R57 新六键/输出开关四键由 fg-grp 承接，组内其余键跳过不重复渲）。
  const GROUP_OWNED = new Set([...POSTPROC_OWNED_KEYS, ...OUTPUT_SWITCH_KEYS]);
  for (const desc of GLOBAL_KEYS) {
    if (desc.key === "放大") { fgrid.appendChild(buildPostProcGroup(projectId, gp)); continue; }
    if (desc.key === "关音乐") { fgrid.appendChild(buildOutputSwitchGroup(projectId, gp)); continue; }
    if (GROUP_OWNED.has(desc.key)) continue;
    const fg2 = el("div", {
      class: "fg2",
      style: desc.control === "input" || desc.control === "file" ? "grid-column:span 2" : null,
    });
    if (desc.title) fg2.setAttribute("title", desc.title);
    fg2.appendChild(el("span", { text: desc.label }));
    const node = renderControl(desc, gp[desc.key], projectId);
    bindChangeToStore(node, projectId, desc.key);
    fg2.appendChild(node);
    fgrid.appendChild(fg2);
  }

  cfBody.appendChild(fgrid);
  // 批 M6-T2（R-30）：项目级「模板」写口 —— .fgrid 外独立 section（B6 落位·不破 fgrid data-gp 序/恰 2 fg-grp 锁）
  const tplSec = buildTemplateSection(projectId, gp);
  if (tplSec) cfBody.appendChild(tplSec);
  colfold.appendChild(cfBody);
  paramsPage.appendChild(colfold);

  // ===== 资源编排（T4）挂入全局参数折叠组 cf-body（老板 2026-09-26 UI 结构核对修正）=====
  // v43 :1273 钦点：resGroup 是 gcol/cf-body 的子级（fgrid+后处理+输出开关之后）——此前挂在 col 组外为失实
  resourcesMount(cfBody, projectId);

  // ===== S1-2 T5：全局提示词区（v43 :1368-1379）—— F62：归提示词页 =====
  // 段卡 pv-pre 数据接入 + 段卡 sc-prompt @ 联想绑定在 segcardsMount 之后挂载
  // 资产 fetch 触发（fire-and-forget；assetsGetter 在 input 时读 getCachedAssets 自动跟进）
  //   S2-1 T2 N1 退役 sample.json：改调 prompt.loadAssets()（无参·走 listAssets 真数据 + 注册表 @N）
  prompt.loadAssets();
  const gpSec = prompt.mountGlobalPrompt(promptPage, projectId);
  // v43 :306 提示词组左右缘 11px 对齐随分容器内联保持（原 #gcol + .fgroup 相邻选择器因子页分容器失配）
  gpSec.style.cssText += ";margin-left:11px;margin-right:11px";

  // 段卡（T3）：F62 归提示词页（v43 顺序：全局提示词之后）
  const segcardsSec = segcardsMount(promptPage, projectId);

  // S1-2 T5：段卡 sc-prompt @ 联想绑定（事件委托，动态增段也覆盖）+ pv-pre 数据接入
  // 数据流：段卡 onPatch 已写 store → 订阅 segment:update/segment:add → refreshSegPv
  if (segcardsSec) {
    prompt.bindSegcardsAtMention(segcardsSec);
    // 初始 pv-pre 数据接入（T3 容器已渲染，T5 接正文）
    const assetMap = prompt.buildAssetMap(prompt.getCachedAssets());
    for (const card of segcardsSec.querySelectorAll(".segcard")) {
      prompt.refreshSegPv(card, proj.globalPrompt, assetMap);
    }
    // 段卡内容变更 → pv 刷新
    // S1-3 结转清偿 C2：重挂前先退订上一轮订阅（否则每次进入设定 TAB 累积一个监听，
    // 旧监听持有已脱离文档的旧 segcardsSec 引用）。store.unsubscribe 需拿原函数引用。
    if (segPvSubFn) storeUnsubscribe(segPvSubFn);
    segPvSubFn = (ev) => {
      if (!ev) return;
      if (ev.projectId !== projectId) return;
      if (ev.type === "segment:add" || ev.type === "segment:update" || ev.type === "segment:move" || ev.type === "segment:remove") {
        for (const card of segcardsSec.querySelectorAll(".segcard")) {
          prompt.refreshSegPv(card, proj.globalPrompt, assetMap);
        }
      } else if (ev.type === "project:save") {
        // projMode 变更时 shell 已调 segcards.rerenderSegcardsByProject 重挂；此处只刷 pv
        for (const card of segcardsSec.querySelectorAll(".segcard")) {
          prompt.refreshSegPv(card, proj.globalPrompt, assetMap);
        }
      }
    };
    storeSubscribe(segPvSubFn);
  }

  // ===== 批 R6（#013-#016）：分镜表下方四块（v43 :1552-1579 平级顺序）—— F62：归参数页 =====
  // 顺序：pv-box 提示词预览 → poolbar 素材池 → psummary 运行概要 → fbx 提交链检查
  // 数据接线全部在 pvbox 模块内自持（store 订阅 / segcards 选中订阅 / @N 注册表装载）
  pvboxMount(paramsPage, projectId);
  // 批 8 T3：分配器面板挂分镜表/素材池条（pvbox 四块）之后 —— 资产卡 → 手动槽/绑定链入口
  assignerMount(paramsPage, projectId);
  // 全局提示词输入广播 → 段卡 pv 同步刷新（prompt.mountGlobalPrompt 已 dispatch "prompt:gp-change"）
  if (typeof document !== "undefined") {
    document.addEventListener("prompt:gp-change", () => {
      if (!segcardsSec) return;
      const assetMap = prompt.buildAssetMap(prompt.getCachedAssets());
      for (const card of segcardsSec.querySelectorAll(".segcard")) {
        prompt.refreshSegPv(card, proj.globalPrompt, assetMap);
      }
    });
  }
  // 全局提示词区折叠事件：展开/收起 pv-bar 不需要额外接线（pvToggle 自身绑定 click）
  // S1-2 T5：全局提示词区折叠联动（fgroup.open 切换时 fg-body 显隐）
  // 注：CSS .fgroup.open .fg-body{display:block} 由 R1 批实装（setup.css · v43 :304 逐字；此前 setup.css 并无此规则，旧注释「已实现」为失实）；mountGlobalPrompt 内 fg-cap 已挂 open toggle

  // F62 组装：子页签条 + 两子页（同挂 DOM·显隐由 applySubTab 裁决）
  col.appendChild(subBar);
  col.appendChild(paramsPage);
  col.appendChild(promptPage);

  sec.appendChild(col);
  container.appendChild(sec);

  // 批 R8 · R7-1：setup 壳层 data-ic 补 hydrate（gcol cap icw chev；幂等·覆盖嵌套子视图未注入项）
  hydrateIcons(sec);

  // F62：初始子页签生效（chip on 类 + display 显隐 + localStorage 记忆）
  applySubTab(subTab);

  // S1-2 T4：注册 refresh 钩子（供预设加载后刷新 17 键表单）
  _formProjectId = projectId;
  _formRef = sec;
  if (typeof window !== "undefined") {
    window.__gui13RefreshGlobals = (pid) => refreshGlobals(pid);
  }

  // gui13.gotoSeg 锚消费收敛至单一消费方（批10B-T1 · F60 防御清理）：
  //   segcardsMount（上方）挂载时同步调 segcards.consumeJumpAnchor——先摘 key 再滚动+闪烁；
  //   本处原第二消费方（延迟 setTimeout 再查定位卡）永远读空 = 死代码，整段删除。
  return sec;
}
