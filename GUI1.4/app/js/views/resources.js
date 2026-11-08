// resources.js — 资源编排四子区模块（GUI1.3 S1-2 T4）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - A1 LoRA 链编排 :1276-1314（lorarow.template + 冲突黄红条 + lora-picker 弹窗）
//   - A2 模型 / CLIP / VAE 切换 :1316-1338（4 model-slot + cbox + ms-ov 已覆写徽标）
//   - A3 预设 :1339-1350（preset-row + PRESET_DEMO 演示态 → 本批升级为 localStorage 跨项目持久化
//     → 批 2-T6 迁引擎侧：引擎包根 presets/<name>.json 为事实源，本地仅缓存快照+降级只读）
//   - A4 锚定镜像 :1351-1363（readonly textarea + MIRROR_AUTO + mirrorRestore）
//   - 处理器 :5497-5570 候选池 + 冲突检测 ; :5572-5582 modelOvToggle ; :5583-5644 预设 ; :5645-5653 镜像
//
// === 任务边界 ===
// 本任务（T4）实装：四子区全量（LoRA 链模板行+手动行+冲突+四槽+预设 localStorage+镜像）
// 不实装：段卡（T3）/ 全局提示词（T5）/ 提交主链（T6）/ 资产卡拖入 LoRA 行（T5+）
// 模板行（🔒 锁序）：渲染层数据 + locked=true；store.loraChain 只存手动行
//
// === 批 2-T4（G7）接引擎真数据 · 2026-09-28 真机 8190 实测留证 .tmp/batch2/t4-probe-*.json ===
//   #29 GET /h3_batch/template_loras?workflow_path=（主源·模板行 + has_pdd 真态）
//     实测：{"loras": [{"name","strength","class_type","order","category"}],
//            "loaders": {"unet","clip","vae_video","vae_audio"}, "has_pdd": false}
//     400 缺 workflow_path / 模板不存在（{"error": "模板不存在: <路径>"} 经 request 归一 msg 原话）
//   #28 GET /h3_batch/resources?kind=lora|model|clip|vae（池 + 四槽真清单）
//     实测：{"items": [{"file","category","known_h3","why_included"}], "filter_terms": [...]}
//     —— api.md 旧契约写 items[].{name,path}/filter_words，引擎实际返回 file/filter_terms（以实测为准·两形态兼容）
//   降级链：模板行 #29（未设模板不盲发）→ 池 #28 主源（#28 失败 → #29 名单兜底）→ 双失败空列表+占位
//   加载时机：资源视图 mount 读 gui13.paths.workflow_path（renderRoute 重建视图·路径改后重进即新档）
//   假常量清零：硬编码模板行/候选池/演示 PDD 常量全部退场（验收项·grep 零残留）
//
// === API ===
//   FOLLOW_TEMPLATE               四槽默认项（跟随模板 = 不覆写）
//   detectLoraConflicts(opts)     冲突检测 → { turbo, pddTurbo }（v43 :5561-5570 · hasPdd 真输入）
//   isOverrideSlot(value)         四槽覆写判定（默认首项 = 跟随模板 = 非覆写）
//   MODEL_SLOTS                   四槽描述（unet/clip/vaeVideo/vaeAudio · 各带 #28 kind）
//   fetchTemplateLoras(wp)        #29 → { ok, loras, loaders, hasPdd, error }
//   fetchResourceItems(kind)      #28 → { ok, items:[文件名], error }
//   loadResourceData(wp)          { template, pool, slots } 组合链
//   loraSourceText(o) / poolStateText(pool)  占位文案（不伪清单）
//   buildPresetSnapshot(gp)       17 键快照构建（深拷贝）
//   MIRROR_AUTO                   自动版镜像常量（v43 :5645）
//   deriveMirrorState(text)       已编辑/自定义模式徽标规则
//   readEffectiveTemplatePath(pid) 生效模板（项目级优先·空回落应用级·M6b-T1）
//   templateFamilyText(wp)        模板族状态行四态文案（M6b-T1）
//   refreshTemplateAlignment()    换模板联动刷新现役挂载（带调用序号防竞态·M6b-T1）
//   mount(container, projectId)   渲染资源编排入容器

import {
  load as storeLoad,
  save as storeSave,
  updateProjectMeta,
  loadPresets,
  savePreset,
  deletePreset,
  applyPreset,
  refreshPresetsFromEngine,
  migrateLocalPresets,
} from "../store/store.js";
import { request, isEngineUnreachable } from "../core/api.js";
import { getKey, putKey, readFile } from "../core/server_storage.js";   // 批A #13：读穿缓存经 server_storage 适配层
import { classifyTemplateFamily, DEPRECATED_TEMPLATE_FAMILIES } from "../core/templates.js";
import { showToast } from "../ui/toast.js";
import { applyOption, setCurrentValue, initDocumentDelegate } from "../ui/cbox.js";
import { followAnchor } from "../ui/anchor.js"; // F37：lora-picker 滚动/resize 跟随按钮
import { hydrateIcons } from "../ui/icons.js";
import { t } from "../core/i18n.js";   // #89 T2b：显示文案入典（zh 原文=键值·en 见 core/i18n.js）

// ===== 四槽默认项（不覆写 = 跟随模板）=====
export const FOLLOW_TEMPLATE = "跟随模板（不覆写）";

// ===== 引擎数据（批 2-T4）=====

// gui13.paths.workflow_path（批 2-T1/T2 契约键 · 与 settings.PATHS_KEY 同源·只读消费）
function readWorkflowPath() {
  try {
    const ls = globalThis.localStorage;
    const raw = ls && ls.getItem ? ls.getItem("gui13.paths") : null;
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj.workflow_path === "string" ? obj.workflow_path.trim() : "";
  } catch (_e) {
    return "";
  }
}

// 批 M6b-T1（R-49）生效模板口径：项目级 globalParams["模板"] trim 非空优先 → 空则回落应用级
//   优先链与 submit.js:486-492 同款（项目级 trim 判空 · 空则回落 gui13.paths.workflow_path）；
//   对等性由 resources.test.mjs「优先链对等性锁」断言防两张皮。
export function readEffectiveTemplatePath(projectId) {
  if (projectId) {
    const proj = storeLoad(projectId);
    const gp = proj && proj.globalParams;
    const raw = gp && typeof gp["模板"] === "string" ? gp["模板"].trim() : "";
    if (raw) return raw;
  }
  return readWorkflowPath();
}

// 批 M6b-T1（R-49）模板族状态行文案（四态·判据 core/templates.js classifyTemplateFamily 纯函数）
export function templateFamilyText(workflowPath) {
  const fam = classifyTemplateFamily(workflowPath);
  if (fam === "ref2v") return t("resources.tplfam.ref2v");
  if (fam === "t2v") return t("resources.tplfam.t2v");
  if (fam && DEPRECATED_TEMPLATE_FAMILIES.has(fam)) return t("resources.tplfam.deprecated", { fam });
  return t("resources.tplfam.unknown");
}

// 批 M6b-T1（R-49）联动刷新：重跑 refreshEngineData + 模块级自增调用序号防竞态
//   序号：每次调用领一个 seq·回写前比对·非最新 seq 的在途回写作废（防换模板两次乱序回写旧盖新）。
//   现役挂载「最新挂载为准」（submit-bar.js:703 _liveMount 同款惯例·重挂即换）。
let _alignSeq = 0;
let _liveAlign = null; // { projectId, refresh }
export function refreshTemplateAlignment() {
  if (!_liveAlign) return Promise.resolve(false);
  return _liveAlign.refresh();
}

// #29 模板 LoRA 发现（主源·未设模板返回 ok:false 且不发请求）
export async function fetchTemplateLoras(workflowPath) {
  const wp = typeof workflowPath === "string" ? workflowPath.trim() : "";
  if (!wp) return { ok: false, loras: [], loaders: null, hasPdd: false, error: "workflow_path 未设" };
  const r = await request("/h3_batch/template_loras?workflow_path=" + encodeURIComponent(wp), { cache: "no-store" });
  if (!r.ok) {
    return { ok: false, loras: [], loaders: null, hasPdd: false, error: (r.error && r.error.msg) || "template_loras 读取失败" };
  }
  const d = r.data || {};
  if (!Array.isArray(d.loras)) {
    return { ok: false, loras: [], loaders: null, hasPdd: false, error: "template_loras 响应缺少 loras 数组" };
  }
  const loras = [];
  for (const it of d.loras) {
    if (!it || typeof it !== "object" || typeof it.name !== "string" || !it.name) continue;
    loras.push({
      name: it.name,
      strength: typeof it.strength === "number" ? it.strength : null,
      order: typeof it.order === "number" ? it.order : 0,
      category: typeof it.category === "string" ? it.category : "",
    });
  }
  return {
    ok: true,
    loras,
    loaders: d.loaders && typeof d.loaders === "object" ? d.loaders : null,
    hasPdd: d.has_pdd === true, // #29 真态（原演示常量退场）
    error: null,
  };
}

// #28 资源扫描清单（池/四槽共用·items[].file 真机形状 · api.md 旧 {name} 兼容）
// 批A #13（方案-#13解耦B档-2026-10-16）：读穿缓存 data/resources-cache.json（{[kind]:{items,savedAt}}）——
//   在线成功 → 落盘（宏任务延迟·种子读盘防盲覆写他 kind 键）；引擎不可达（网络错/超时）→
//   读缓存 ok:true+offline:true（资源页离线可看）；可达但报错/缓存未录该 kind → ok:false（既有语义）。
const RESOURCES_CACHE = "data/resources-cache.json";

let _resSeed = null;
function _resSeedOnce() {
  if (!_resSeed) {
    _resSeed = getKey(RESOURCES_CACHE)
      .then((r) => (r && r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data)) ? r.data : {})
      .catch(() => ({}));
  }
  return _resSeed;
}

function _writeResourceCache(kind, items) {
  setTimeout(() => {
    _resSeedOnce()
      .then(() => {
        const cur = readFile(RESOURCES_CACHE);   // putKey 每写同步更内存镜像 → 并发写串行合并不互覆
        const base = (cur && typeof cur === "object" && !Array.isArray(cur)) ? cur : {};
        const next = { ...base, [kind]: { items, savedAt: new Date().toISOString() } };
        return putKey(RESOURCES_CACHE, next);
      })
      .catch(() => { /* 落盘失败静默——缓存是兜底非真值 */ });
  }, 0);
}

export async function fetchResourceItems(kind) {
  const k = typeof kind === "string" ? kind.trim() : "";
  if (!k) return { ok: false, items: [], error: "kind 未设" };
  const r = await request("/h3_batch/resources?kind=" + encodeURIComponent(k), { cache: "no-store" });
  if (!r.ok) {
    if (isEngineUnreachable(r.error)) {
      const c = await getKey(RESOURCES_CACHE).catch(() => null);
      const d = (c && c.ok && c.data && typeof c.data === "object" && !Array.isArray(c.data)) ? c.data : null;
      const hit = d && d[k] && Array.isArray(d[k].items) ? d[k].items : null;
      if (hit) return { ok: true, items: hit, offline: true };
    }
    return { ok: false, items: [], error: (r.error && r.error.msg) || "resources 读取失败" };
  }
  const arr = r.data && Array.isArray(r.data.items) ? r.data.items : null;
  if (!arr) return { ok: false, items: [], error: "resources 响应缺少 items 数组" };
  const items = [];
  for (const it of arr) {
    const f = typeof it === "string" ? it
      : (it && typeof it.file === "string" ? it.file
        : (it && typeof it.name === "string" ? it.name : ""));
    if (f) items.push(f);
  }
  _writeResourceCache(k, items);   // 批A #13：在线顺手落盘
  return { ok: true, items, error: null };
}

// 组合链：模板行 #29 → 池 #28（失败取 #29 名单兜底）→ 四槽 #28 三类
export async function loadResourceData(workflowPath) {
  const template = await fetchTemplateLoras(workflowPath);
  const [lora, model, clip, vae] = await Promise.all([
    fetchResourceItems("lora"),
    fetchResourceItems("model"),
    fetchResourceItems("clip"),
    fetchResourceItems("vae"),
  ]);
  let pool;
  if (lora.ok && lora.items.length) pool = { ok: true, source: "resources", names: lora.items };
  else if (template.ok && template.loras.length) pool = { ok: true, source: "template", names: template.loras.map((l) => l.name) };
  else pool = { ok: !!lora.ok, source: "none", names: [] };
  return { template, pool, slots: { model, clip, vae } };
}

// 模板行区占位文案（不伪清单）
export function loraSourceText({ workflowPath, template, pool } = {}) {
  const wp = typeof workflowPath === "string" ? workflowPath.trim() : "";
  if (!wp) return t("resources.lora.noTpl");
  const tpl = template && typeof template === "object" ? template : { ok: false, loras: [] };
  if (tpl.ok && Array.isArray(tpl.loras) && tpl.loras.length > 0) return "";
  if (tpl.ok) return t("resources.lora.noBuiltIn");
  return pool && pool.source === "resources" ? t("resources.lora.tplFail") : t("resources.lora.engineDown");
}

// picker 候选池占位文案
export function poolStateText(pool) {
  const p = pool && typeof pool === "object" ? pool : { ok: false, source: "none", names: [] };
  if (Array.isArray(p.names) && p.names.length) return "";
  return p.source === "resources" ? t("resources.pool.empty") : t("resources.lora.engineDown");
}

// ===== 冲突检测（v43 :5561-5570）=====
//   - turbo: 启用 LoRA 中含 /turbo/ 的 ≥2 条 → 黄条
//   - pddTurbo: PDD 模板（#29 has_pdd 真态）且任一启用 LoRA 含 /turbo/ → 红条（PDD 模板+turbo 互斥）
export function detectLoraConflicts({ loraRows = [], unetValue = "", hasPdd = false } = {}) {
  const rows = Array.isArray(loraRows) ? loraRows : [];
  const turboOn = rows.filter((r) => r && r.enabled && /turbo/.test(String(r.name || "")));
  const turbo = turboOn.length >= 2;
  const pddTurbo = !!hasPdd && turboOn.length >= 1;
  return { turbo, pddTurbo };
}

// ===== A2：四槽描述 + 覆写判定（v43 :5572-5582）=====
// 默认首项 = 跟随模板（不覆写）→ 徽标 ms-ov 不显示；选其他选项 → 徽标 ms-ov 显示
// 候选清单 = #28 kind（unet→model · CLIP→clip · 两 VAE 共用 vae·批 2-T4）
// key/kind=引擎与 store 数据键禁译；label 原文留作数据面快照·显示侧走 tkey（#89 T2b）
export const MODEL_SLOTS = [
  { key: "unet", label: "unet（底模）", tkey: "resources.slot.unet", kind: "model" },
  { key: "clip", label: "CLIP（图像理解器）", tkey: "resources.slot.clip", kind: "clip" },
  { key: "vaeVideo", label: "视频 VAE", tkey: "resources.slot.vaeVideo", kind: "vae" },
  { key: "vaeAudio", label: "音频 VAE", tkey: "resources.slot.vaeAudio", kind: "vae" },
];

export function isOverrideSlot(value) {
  if (typeof value !== "string") return false;
  if (value.trim() === "") return false;
  return !/^跟随模板/.test(value);
}

// ===== A3：预设快照构建（17 键深拷贝 · 防止污染源对象）=====
// S2-2 T1 涟漪：14 键 → 17 键（追加 放大/插帧/放大引擎）
// 防污染语义升级（B3②）：白名单 = globalParams 全集 = 17 键；非白名单键一律不入快照（含段级 seg.插帧/seg.超分 等）
const PRESET_KEYS = [
  "比例", "质量", "生成步数", "语言", "配乐", "氛围声", "音乐混入", "审片门",
  "默认负面", "音乐文件", "关音乐", "关对白", "关水印字幕", "全部段生成完自动接成一条片",
  // S2-2 T1 后处理三键
  "放大", "插帧", "放大引擎",
];
export function buildPresetSnapshot(globalParams) {
  const def = globalParams && typeof globalParams === "object" && !Array.isArray(globalParams)
    ? globalParams
    : null;
  const snap = {};
  for (const k of PRESET_KEYS) {
    snap[k] = def && k in def ? def[k] : "";
  }
  // 布尔键兜底（defaults 同步 createProject）
  if (typeof snap["关音乐"] !== "boolean") snap["关音乐"] = false;
  if (typeof snap["关对白"] !== "boolean") snap["关对白"] = false;
  if (typeof snap["关水印字幕"] !== "boolean") snap["关水印字幕"] = false;
  if (typeof snap["全部段生成完自动接成一条片"] !== "boolean") snap["全部段生成完自动接成一条片"] = true;
  // S2-2 T1 新布尔键兜底
  if (typeof snap["放大"] !== "boolean") snap["放大"] = false;
  if (typeof snap["插帧"] !== "boolean") snap["插帧"] = false;
  // 字符串键兜底
  if (!snap["比例"]) snap["比例"] = "9:16 竖屏";
  if (!snap["质量"]) snap["质量"] = "0.4";
  if (!snap["生成步数"]) snap["生成步数"] = "8A8V";
  if (!snap["语言"]) snap["语言"] = "中文";
  if (!snap["配乐"]) snap["配乐"] = "自动";
  if (!snap["氛围声"]) snap["氛围声"] = "自动";
  if (!snap["音乐混入"]) snap["音乐混入"] = "覆盖";
  if (!snap["审片门"]) snap["审片门"] = "关";
  // S2-2 T1 新 cbox 字符串键兜底（引擎白名单 seedvr2|rtxvsr）
  if (!snap["放大引擎"]) snap["放大引擎"] = "seedvr2";
  return snap;
}

// ===== A4：锚定镜像常量 + 状态派生 =====
export const MIRROR_AUTO =
  "<Subject 1>: 【外貌】少女 · 银发 · 白裙（档案卡描述）\n场景以 <Picture 2> 为准";

// 镜像态：空字符串 / 与自动版 trim 相等 → 自动态；否则已编辑 + 自定义模式
export function deriveMirrorState(text) {
  if (typeof text !== "string") return { edited: false, customMode: false };
  const trimmed = text.trim();
  if (trimmed === "") return { edited: false, customMode: false };
  if (trimmed === MIRROR_AUTO.trim()) return { edited: false, customMode: false };
  return { edited: true, customMode: true };
}

// ===== DOM 辅助 =====

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

// ===== mount(container, projectId) =====

export function mount(container, projectId) {
  if (typeof document === "undefined" || !container) return null;
  if (!projectId) return null;
  if (typeof document !== "undefined") initDocumentDelegate(document);

  const proj = storeLoad(projectId);
  if (!proj) {
    const ph = el("div", { class: "shell-tab-placeholder" });
    ph.appendChild(el("div", { class: "ph-cap", text: t("resources.ph.noProject") }));
    container.appendChild(ph);
    return null;
  }
  // 模板自带手动行存盘（store.loraChain）+ 资源编排三字段
  const manualChain = Array.isArray(proj.loraChain) ? proj.loraChain : [];
  const modelOverrides = proj.modelOverrides || {};
  const anchorMirror = typeof proj.anchorMirror === "string" ? proj.anchorMirror : "";
  // 登记项 3：模板行强度/启用态跨会话（store.loraTplState · 旧存档无字段走 #29 默认）
  const loraTplState = (proj.loraTplState && typeof proj.loraTplState === "object") ? proj.loraTplState : {};

  // T9 真机走查修正：删除原"清空容器"段——本模块是追加进 setup 共享列（col）的子视图，
  // 清空会把已挂的全局参数折叠组（14 键）与全局提示词区整体抹掉
  // 老板 2026-09-26 UI 结构核对修正：资源编排按原型 v43 :1273 直接以 .fgroup#resGroup 形态
  // 挂入 setup 的全局参数折叠组 cf-body（此前多套 section.resources-view/.col 两层壳且挂在组外——审计差异 #2）

  // 资源编排组壳（.fgroup open 形态 · v43 :1273）
  const fgroup = el("div", { class: "fgroup open", id: "resGroup" });
  const cap = el("div", { class: "fg-cap" });
  cap.appendChild(el("span", { "data-ic": "sliders", "data-sz": "14" }));
  cap.appendChild(document.createTextNode(t("resources.cap")));
  cap.appendChild(el("span", { class: "inh", text: t("resources.cap.inh") }));
  const icw = el("span", { class: "icw" });
  icw.appendChild(el("span", { "data-ic": "chev", "data-sz": "14" }));
  cap.appendChild(icw);
  cap.addEventListener("click", () => fgroup.classList.toggle("open"));
  fgroup.appendChild(cap);

  const body = el("div", { class: "fg-body", id: "resBody" });

  // === A1 LoRA 链编排 ===
  const a1 = el("div", { class: "res-block" });
  a1.appendChild(el("div", {
    class: "res-subcap",
    text: t("resources.a1.cap"),
  }));
  a1.lastChild.appendChild(el("span", { class: "inh", text: t("resources.a1.inh") }));

  // 引擎数据状态行（批 2-T4：未选模板/引擎未连接/该模板无自带 LoRA 的占位）
  const loraSrcState = el("div", { class: "inh", id: "loraSrcState", text: "" });
  a1.appendChild(loraSrcState);

  // 模板族状态行（批 M6b-T1 R-49：标题下小字四态·判据 classifyTemplateFamily）
  const tplFamState = el("div", { class: "inh tpl-fam-state", id: "tplFamState", text: "" });
  a1.appendChild(tplFamState);

  // 冲突黄条（turbo ≥2）
  const warnTurbo = el("div", {
    class: "lora-warn",
    id: "loraWarnTurbo",
    title: t("resources.warn.turboTitle"),
  });
  warnTurbo.appendChild(el("span", { "data-ic": "bell", "data-sz": "13" }));
  warnTurbo.appendChild(document.createTextNode(t("resources.warn.turbo")));
  warnTurbo.style.display = "none";
  a1.appendChild(warnTurbo);

  // 冲突红条（PDD 模板 + turbo · has_pdd 真态驱动）
  const warnPdd = el("div", {
    class: "lora-warn danger",
    id: "loraWarnPdd",
    title: t("resources.warn.pddTitle"),
  });
  warnPdd.appendChild(el("span", { "data-ic": "bell", "data-sz": "13" }));
  warnPdd.appendChild(document.createTextNode(t("resources.warn.pdd")));
  warnPdd.style.display = "none";
  a1.appendChild(warnPdd);

  // LoRA 列表（模板行异步到·手动行同步到）
  const loraList = el("div", { class: "lora-list", id: "loraList" });

  const rowsAll = []; // 冲突检测行模型：模板行（locked）+ 手动行
  const engineState = { template: null, pool: null }; // 引擎真数据（批 2-T4）

  // 模板行（#29 真数据 · locked）——引擎数据到达后由 renderTemplateRows 重建
  function makeTplRow(tpl) {
    const saved = loraTplState[tpl.name] || {};
    const initStrength = typeof saved.strength === "number"
      ? saved.strength
      : (typeof tpl.strength === "number" ? tpl.strength : 1);
    const initEnabled = typeof saved.enabled === "boolean" ? saved.enabled : true;
    const row = el("div", { class: "lorarow template" });
    row.setAttribute("data-lora", tpl.name);
    row.setAttribute("data-template", "1");
    row.setAttribute("data-locked", "1");
    if (!initEnabled) row.classList.add("disabled");
    row.appendChild(el("span", { class: "lock", title: t("resources.tpl.lockTitle"), text: "🔒" }));
    row.appendChild(el("span", { class: "nm", title: t("resources.tpl.nameTitle", { name: tpl.name }), text: tpl.name }));
    const range = el("input", { type: "range", min: "0", max: "100", value: String(Math.round(initStrength * 100)) });
    const numSpan = el("b", { class: "num", text: initStrength.toFixed(2) });
    range.addEventListener("input", () => {
      const v = parseInt(range.value, 10) / 100;
      numSpan.textContent = v.toFixed(2);
      // 批B 修正③：行模型强度同步（原缺陷：只改显示文本 → 行模型留旧值）
      const idx = rowsAll.findIndex((r) => r._dom === row);
      if (idx >= 0) rowsAll[idx].strength = v;
      // 登记项 3：模板行强度跨会话落盘（原缺陷：仅内存 → 刷新回默认）
      persistTplState(projectId, rowsAll);
    });
    row.appendChild(range);
    row.appendChild(numSpan);
    const disLbl = el("label", { class: "dis-lbl", title: t("resources.tpl.disTitle") });
    const disCb = el("input", { type: "checkbox" });
    disCb.checked = initEnabled;
    disCb.addEventListener("change", () => {
      row.classList.toggle("disabled", !disCb.checked);
      const idx = rowsAll.findIndex((r) => r._dom === row);
      if (idx >= 0) rowsAll[idx].enabled = disCb.checked;
      // 登记项 3：模板行启用态跨会话落盘
      persistTplState(projectId, rowsAll);
      refreshConflict();
    });
    disLbl.appendChild(disCb);
    disLbl.appendChild(document.createTextNode(t("resources.enable")));
    row.appendChild(disLbl);
    row.appendChild(el("span", { class: "ops-ph" }));
    rowsAll.push({ name: tpl.name, enabled: initEnabled, strength: initStrength, locked: true, _dom: row });
    return row;
  }

  // 重建模板行（先清旧锁行 · 引擎链序升序 · 插在手动行之前）
  function renderTemplateRows(loras) {
    for (let i = rowsAll.length - 1; i >= 0; i--) {
      if (rowsAll[i].locked) rowsAll.splice(i, 1);
    }
    for (const old of Array.from(loraList.querySelectorAll(".lorarow.template"))) old.remove();
    const sorted = loras.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const tpl of sorted) {
      const row = makeTplRow(tpl);
      const firstManual = loraList.querySelector(".lorarow.manual");
      if (firstManual) loraList.insertBefore(row, firstManual);
      else loraList.appendChild(row);
    }
    refreshConflict();
  }

  // 渲染手动行（store.loraChain）
  for (const item of manualChain) {
    const row = renderLoraRow(item, loraList, rowsAll, refreshConflict, projectId, engineState);
    loraList.appendChild(row);
  }

  function refreshConflict() {
    // hasPdd = #29 真态（批 2-T4 接线；数据未到 = false 不误报）
    const hasPdd = !!(engineState.template && engineState.template.hasPdd);
    const r = detectLoraConflicts({ loraRows: rowsAll, hasPdd });
    warnTurbo.style.display = r.turbo ? "" : "none";
    warnPdd.style.display = r.pddTurbo ? "" : "none";
  }

  a1.appendChild(loraList);

  // 「＋ 添加 LoRA」按钮
  const addRow = el("div", { class: "fld", style: "margin:8px 0 0" });
  const addBtn = el("span", {
    class: "fbtn",
    title: t("resources.add.title"),
    text: t("resources.add"),
  });
  addBtn.style.cursor = "pointer";
  addBtn.addEventListener("click", () => openLoraPicker(addBtn, loraList, rowsAll, refreshConflict, projectId, null, engineState));
  addRow.appendChild(addBtn);
  a1.appendChild(addRow);

  body.appendChild(a1);

  // === A2 模型 / CLIP / VAE 切换 ===
  const a2 = el("div", { class: "res-block" });
  a2.appendChild(el("div", { class: "res-subcap", text: t("resources.a2.cap") }));
  a2.lastChild.appendChild(el("span", { class: "inh", text: t("resources.a2.inh") }));

  const modelGrid = el("div", { class: "model-grid" });
  const slotBoxes = {}; // slot.key → cbox（#28 清单异步到）
  for (const slot of MODEL_SLOTS) {
    const slotEl = el("div", { class: "model-slot" });
    slotEl.setAttribute("data-slot", slot.key);
    slotEl.appendChild(el("span", { class: "ms-label", text: t(slot.tkey) }));
    const cur = modelOverrides[slot.key] || FOLLOW_TEMPLATE;
    // 跟随模板项走 cbox "value=label" 形态：显示侧 t() 翻译·change 派发 value 侧原值（FOLLOW_TEMPLATE
    // 常量=store.modelOverrides 数据契约禁译，isOverrideSlot 正则判据不动）——#89 T2b
    const box = el("div", { class: "cbox", "data-opts": FOLLOW_TEMPLATE + "=" + t("resources.followTemplate"), "data-slot": slot.key });
    box.appendChild(el("span", { class: "cb-v", text: cur === FOLLOW_TEMPLATE ? t("resources.followTemplate") : cur }));
    box.appendChild(el("span", { class: "cb-a", text: "▾" }));
    const ovBadge = el("span", { class: "ms-ov", text: t("resources.ovBadge") });
    ovBadge.style.display = isOverrideSlot(cur) ? "" : "none";
    box.addEventListener("change", (ev) => {
      const v = ev && ev.detail && ev.detail.value != null ? ev.detail.value : "";
      ovBadge.style.display = isOverrideSlot(v) ? "" : "none";
      // 写 store.modelOverrides（单字段 patch）
      const curOv = proj.modelOverrides || {};
      const next = Object.assign({}, curOv, { [slot.key]: v });
      updateProjectMeta(projectId, { modelOverrides: next });
      refreshConflict();
    });
    slotEl.appendChild(box);
    slotEl.appendChild(ovBadge);
    modelGrid.appendChild(slotEl);
    slotBoxes[slot.key] = box;
  }
  a2.appendChild(modelGrid);
  body.appendChild(a2);

  // 四槽候选 = #28 真清单（默认项恒首位；已存覆写值不在新清单时补一行防菜单失联）
  function applySlots(slots) {
    for (const slot of MODEL_SLOTS) {
      const box = slotBoxes[slot.key];
      if (!box) continue;
      const res = slots ? slots[slot.kind] : null;
      const names = res && res.ok ? res.items : [];
      const cur = modelOverrides[slot.key] || FOLLOW_TEMPLATE;
      const opts = [FOLLOW_TEMPLATE + "=" + t("resources.followTemplate"), ...names];
      if (cur !== FOLLOW_TEMPLATE && opts.indexOf(cur) < 0) opts.push(cur);
      box.setAttribute("data-opts", opts.join("|"));
    }
  }

  // === A3 预设 ===
  const a3 = el("div", { class: "res-block" });
  a3.appendChild(el("div", { class: "res-subcap", title: t("resources.a3.title"), text: t("resources.a3.cap") }));
  a3.lastChild.appendChild(el("span", { class: "inh", text: t("resources.a3.inh") }));

  // 预设列表（来自 localStorage · loadPresets）
  const presetRow1 = el("div", { class: "preset-row" });
  const presetBox = el("div", { class: "cbox", "data-opts": "", id: "presetSel" });
  presetBox.appendChild(el("span", { class: "cb-v", text: t("resources.preset.none") }));
  presetBox.appendChild(el("span", { class: "cb-a", text: "▾" }));
  presetBox.setAttribute("data-opts-live", "1"); // 自定义 data-opts：避免与 cbox.js 解析冲突
  // 直接挂选项（不走 parseOpts · 因为动态更新）
  presetRow1.appendChild(presetBox);

  function refreshPresetOpts() {
    const list = loadPresets();
    const names = list.map((p) => p.name);
    if (names.length === 0) {
      presetBox.setAttribute("data-opts", "");
      setCurrentValue(presetBox, t("resources.preset.none"));
      presetBox.querySelector(".cb-v").textContent = t("resources.preset.none");
    } else {
      presetBox.setAttribute("data-opts", names.join("|"));
      // 保留当前选中；若不存在则重置到第一条
      const cur = presetBox.querySelector(".cb-v").textContent;
      if (!names.includes(cur)) {
        setCurrentValue(presetBox, names[0]);
      }
    }
    // 状态行
    const stateEl = a3.querySelector(".preset-state");
    if (stateEl) stateEl.textContent = t("resources.preset.loadedCount", { n: list.length });
  }
  refreshPresetOpts();

  // 批 2-T6：预设迁引擎侧 —— ①旧键存量一次性迁移（成功才清退·脏名跳过 toast 报告不卡死）
  //   ②引擎侧刷新落缓存后重渲（引擎不可达 → refresh false，维持缓存只读渲染）
  fgroup._presetReady = (async () => {
    const res = await migrateLocalPresets();
    if (res.migrated > 0 && typeof showToast === "function") {
      showToast("success", t("resources.preset.migrated", { n: res.migrated }));
    }
    if (res.skipped.length > 0 && typeof showToast === "function") {
      showToast("info", t("resources.preset.skipped", { names: res.skipped.join("、") }));
    }
    if (await refreshPresetsFromEngine()) refreshPresetOpts();
  })();

  const loadBtn = el("span", { class: "ghostbtn-mini", text: t("resources.preset.load"), title: t("resources.preset.loadTitle") });
  loadBtn.style.cursor = "pointer";
  loadBtn.addEventListener("click", () => {
    const sel = presetBox.querySelector(".cb-v").textContent;
    if (sel === t("resources.preset.none")) {
      if (typeof showToast === "function") showToast("info", t("resources.preset.noneToast"));
      return;
    }
    const ok = applyPreset(sel, projectId);
    if (ok) {
      storeSave(storeLoad(projectId));
      if (typeof showToast === "function") showToast("success", t("resources.preset.loaded", { name: sel }));
      if (typeof window !== "undefined" && typeof window.__gui13RefreshGlobals === "function") {
        window.__gui13RefreshGlobals(projectId);
      }
    } else if (ok === false) {
      if (typeof showToast === "function") showToast("error", t("resources.preset.loadFail"));
    }
  });
  presetRow1.appendChild(loadBtn);

  const delBtn = el("span", { class: "ghostbtn-mini", text: t("resources.preset.del"), title: t("resources.preset.delTitle") });
  delBtn.style.cursor = "pointer";
  delBtn.addEventListener("click", async () => {
    const sel = presetBox.querySelector(".cb-v").textContent;
    if (sel === t("resources.preset.none")) return;
    if (typeof confirm === "function" && !confirm(t("resources.preset.delConfirm", { name: sel }))) return;
    const ok = await deletePreset(sel);
    if (ok) {
      refreshPresetOpts();
      if (typeof showToast === "function") showToast("info", t("resources.preset.deleted", { name: sel }));
    } else if (typeof showToast === "function") {
      showToast("error", t("resources.preset.delFail"));
    }
  });
  presetRow1.appendChild(delBtn);

  a3.appendChild(presetRow1);

  // 保存行（名字 + 按钮）
  const presetRow2 = el("div", { class: "preset-row" });
  const nameInput = el("input", { type: "text", placeholder: t("resources.preset.namePh"), maxlength: "40" });
  const saveBtn = el("span", { class: "ghostbtn-mini", text: t("resources.preset.save"), title: t("resources.preset.saveTitle") });
  saveBtn.style.cursor = "pointer";
  saveBtn.addEventListener("click", async () => {
    const name = (nameInput.value || "").trim();
    if (!name) {
      if (typeof showToast === "function") showToast("info", t("resources.preset.nameRequired"));
      return;
    }
    const list = loadPresets();
    if (list.some((p) => p.name === name)) {
      if (typeof confirm === "function" && !confirm(t("resources.preset.overwriteConfirm", { name }))) return;
    }
    // 从 store 读当前 17 键
    const cur = storeLoad(projectId);
    if (!cur) return;
    const snap = buildPresetSnapshot(cur.globalParams || {});
    const ok = await savePreset(name, snap);
    if (ok) {
      refreshPresetOpts();
      nameInput.value = "";
      if (typeof showToast === "function") showToast("success", t("resources.preset.saved"));
    } else if (typeof showToast === "function") {
      // 两类拒因白话：预设名不合规（正则）/ 引擎不可达或保存失败
      showToast("error", t("resources.preset.saveFail"));
    }
  });
  presetRow2.appendChild(nameInput);
  presetRow2.appendChild(saveBtn);
  a3.appendChild(presetRow2);

  // 状态行
  const presetState = el("div", { class: "preset-state", text: t("resources.preset.loadedZero") });
  a3.appendChild(presetState);
  body.appendChild(a3);

  // === A4 锚定镜像 ===
  const a4 = el("div", { class: "res-block" });
  a4.appendChild(el("div", { class: "res-subcap", text: t("resources.a4.cap") }));
  a4.lastChild.appendChild(el("span", { class: "inh", text: t("resources.a4.inh") }));

  const mirrorArea = el("div", { class: "mirror-area" });
  const ta = el("textarea", {
    id: "mirrorAuto",
    rows: "3",
    title: t("resources.mirror.title"),
  });
  ta.value = anchorMirror || MIRROR_AUTO;
  ta.readOnly = true;
  ta.setAttribute("data-mirror-textarea", "1");
  mirrorArea.appendChild(ta);

  const mirrorState = el("div", { class: "mirror-state", id: "mirrorState" });
  const mEdited = el("span", { class: "badge-edited", title: t("resources.mirror.editedTitle"), text: t("resources.mirror.edited") });
  const mCustom = el("span", { class: "custom-mode", title: t("resources.mirror.customTitle"), text: t("resources.mirror.custom") });
  mEdited.style.display = "none";
  mCustom.style.display = "none";
  mirrorState.appendChild(mEdited);
  mirrorState.appendChild(mCustom);
  mirrorArea.appendChild(mirrorState);

  function refreshMirrorState() {
    const st = deriveMirrorState(ta.value);
    mEdited.style.display = st.edited ? "" : "none";
    mCustom.style.display = st.customMode ? "" : "none";
  }
  refreshMirrorState();

  // 编辑入口：双击 textarea 切可编辑（与 v43 readonly → edit 的隐含行为）
  ta.addEventListener("dblclick", () => {
    ta.readOnly = false;
    ta.style.background = "var(--panel2)";
  });
  ta.addEventListener("input", () => {
    refreshMirrorState();
    // 实时写 store.anchorMirror（仅 trimmed 后非空才视为编辑）
    const v = ta.value;
    updateProjectMeta(projectId, { anchorMirror: v });
  });

  // 还原按钮
  const restoreRow = el("div", { class: "fld", style: "margin:6px 0 0" });
  const restoreBtn = el("span", { class: "ghostbtn-mini", text: t("resources.mirror.restore"), title: t("resources.mirror.restoreTitle") });
  restoreBtn.style.cursor = "pointer";
  restoreBtn.addEventListener("click", () => {
    ta.value = MIRROR_AUTO;
    ta.readOnly = true;
    ta.style.background = "#16181b";
    refreshMirrorState();
    updateProjectMeta(projectId, { anchorMirror: "" });
    if (typeof showToast === "function") showToast("info", t("resources.mirror.restored"));
  });
  restoreRow.appendChild(restoreBtn);
  mirrorArea.appendChild(restoreRow);

  a4.appendChild(mirrorArea);
  body.appendChild(a4);

  fgroup.appendChild(body);
  container.appendChild(fgroup);

  // 首次挂载刷新一次冲突（可能 store.loraChain 已有数据）
  refreshConflict();

  // 批 R8 · R7-1：本组 data-ic 补 hydrate（cap sliders14 + icw chev14 + 两条 lora-warn bell13；幂等）
  hydrateIcons(fgroup);

  // 行模型（模板 + 手动）暴露给测试：断言强度/启用/名称同步（批B）
  fgroup._loraRows = rowsAll;

  // 引擎真数据装载（批 2-T4；批 M6b-T1 R-49 改读「生效模板」：项目级优先·空回落应用级）
  //   seq：模块级自增调用序号——回写前比对·非最新的一批在途回写作废（防两次换模板乱序旧盖新）
  async function refreshEngineData() {
    const seq = ++_alignSeq;
    const wp = readEffectiveTemplatePath(projectId);
    const data = await loadResourceData(wp);
    // 视图宿主已卸载（测试宿/路由切走）→ 不落 DOM
    if (typeof document === "undefined") return;
    // 已被更新的调用接管 → 本次回写作废（不碰 DOM·不清任何既有编排数据）
    if (seq !== _alignSeq) return;
    engineState.template = data.template;
    engineState.pool = data.pool;
    renderTemplateRows(data.template.ok ? data.template.loras : []);
    applySlots(data.slots);
    loraSrcState.textContent = loraSourceText({ workflowPath: wp, template: data.template, pool: data.pool });
    tplFamState.textContent = templateFamilyText(wp);
  }
  fgroup._engineReady = refreshEngineData();
  // 现役挂载登记（重挂即换——submit-bar.js _liveMount 同款惯例·供 refreshTemplateAlignment 直调）
  _liveAlign = { projectId, refresh: refreshEngineData };

  return fgroup;
}

// ===== 内部工具 =====

// 渲染一行手动 LoRA
function renderLoraRow(item, loraList, rowsAll, refreshConflict, projectId, engineState) {
  const row = el("div", { class: "lorarow manual" });
  row.setAttribute("data-lora", item.name || "");
  row.appendChild(el("span", { class: "lock", text: "" }));
  row.appendChild(el("span", { class: "nm", title: t("resources.manual.nameTitle", { name: item.name || "" }), text: item.name || "" }));
  const strength = typeof item.strength === "number" ? item.strength : 0.5;
  const range = el("input", { type: "range", min: "0", max: "100", value: String(Math.round(strength * 100)) });
  const numSpan = el("b", { class: "num", text: strength.toFixed(2) });
  range.addEventListener("input", () => {
    const v = parseInt(range.value, 10) / 100;
    numSpan.textContent = v.toFixed(2);
    item.strength = v;
    // 批B 修正②：行模型同步 + 落盘（原缺陷：只改局部对象 → 刷新丢）
    const idx = rowsAll.findIndex((r) => r._dom === row);
    if (idx >= 0) rowsAll[idx].strength = v;
    persistManualChain(projectId, loraList, rowsAll);
  });
  row.appendChild(range);
  row.appendChild(numSpan);
  row.appendChild(el("span", { class: "dis-ph" }));

  // ▲▼（登记项 3：位移成功即落盘 loraChain——原缺陷只动 DOM → 刷新回原序）
  const upBtn = el("span", { class: "ar up", title: t("resources.move.up"), text: "▲" });
  upBtn.style.cursor = "pointer";
  upBtn.addEventListener("click", () => {
    if (moveLora(row, loraList, -1)) persistManualChain(projectId, loraList, rowsAll);
  });
  row.appendChild(upBtn);
  const downBtn = el("span", { class: "ar down", title: t("resources.move.down"), text: "▼" });
  downBtn.style.cursor = "pointer";
  downBtn.addEventListener("click", () => {
    if (moveLora(row, loraList, 1)) persistManualChain(projectId, loraList, rowsAll);
  });
  row.appendChild(downBtn);

  // 批B 新增：换 LoRA（复用 picker 通道 · 原地替换本行 · 强度保留；模板行不提供 = 链序锁定）
  const swapBtn = el("span", {
    class: "swap ghostbtn-mini",
    title: t("resources.swap.title"),
    text: t("resources.swap"),
  });
  swapBtn.addEventListener("click", () => openLoraPicker(swapBtn, loraList, rowsAll, refreshConflict, projectId, row, engineState));
  row.appendChild(swapBtn);

  // ✕
  const delBtn = el("span", { class: "del", title: t("resources.del"), text: "✕" });
  delBtn.style.cursor = "pointer";
  delBtn.addEventListener("click", () => {
    row.remove();
    const idx = rowsAll.findIndex((r) => r._dom === row);
    if (idx >= 0) rowsAll.splice(idx, 1);
    // 批B 修正①：删除落盘（原缺陷：只 row.remove → 刷新复活）
    persistManualChain(projectId, loraList, rowsAll);
    refreshConflict();
  });
  row.appendChild(delBtn);

  rowsAll.push({ name: item.name || "", enabled: true, strength, locked: false, _dom: row, _item: item });
  return row;
}

// 手动行 → store.loraChain 落盘（按 DOM 顺序取行模型 · 模板行不入链）
function persistManualChain(projectId, loraList, rowsAll) {
  const items = [];
  for (const row of loraList.querySelectorAll(".lorarow.manual")) {
    const entry = rowsAll.find((r) => r._dom === row);
    if (entry && entry._item) items.push(entry._item);
  }
  updateProjectMeta(projectId, { loraChain: items });
}

// 模板行强度/启用态 → store.loraTplState（登记项 3：跨会话保持 · 模板行不入 loraChain）
function persistTplState(projectId, rowsAll) {
  const state = {};
  for (const r of rowsAll) {
    if (!r.locked) continue;
    state[r.name] = { strength: r.strength, enabled: !!r.enabled };
  }
  updateProjectMeta(projectId, { loraTplState: state });
}

// 上下移手动行（v43 :5505-5513 形态）——返回是否发生位移（边界 toast 不位移返回 false）
function moveLora(row, loraList, dir) {
  const swap = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!swap || (swap.classList && swap.classList.contains("template"))) {
    if (typeof showToast === "function") showToast("info", dir < 0 ? t("resources.move.top") : t("resources.move.bottom"));
    return false;
  }
  if (dir < 0) loraList.insertBefore(row, swap);
  else loraList.insertBefore(swap, row);
  return true;
}

// ===== #67/#69：LoRA 候选弹窗高度自适应 + 可手拖 + 记忆 =====
export const LORA_PICKER_H_KEY = "gui14.loraPickerHeight";
export const LORA_PICKER_MIN_H = 160;
export const LORA_PICKER_MARGIN = 16;
export const LORA_PICKER_GAP = 4;

// 纯函数：v=目标高度；avail=该侧可用空间（已扣 gap/margin）
export function clampLoraPickerHeight(v, avail) {
  const hi = Math.max(0, avail);
  const lo = Math.min(LORA_PICKER_MIN_H, hi); // MIN_H 让位于可用空间，绝不溢出
  return Math.max(lo, Math.min(v, hi));
}

// 纯函数：按锚点矩形与视口算侧位/可用空间/高度/顶边（above 扣自身高度，top 再夹进视口）
export function loraPickerLayout(rect, vh, h) {
  const r = rect || {};
  const v = vh || 800;
  const spaceBelow = v - (r.bottom || 0) - LORA_PICKER_GAP - LORA_PICKER_MARGIN;
  const spaceAbove = (r.top || 0) - LORA_PICKER_GAP - LORA_PICKER_MARGIN;
  const side = (spaceBelow >= LORA_PICKER_MIN_H || spaceBelow >= spaceAbove) ? "below" : "above";
  const avail = Math.max(0, side === "below" ? spaceBelow : spaceAbove);
  const height = clampLoraPickerHeight(h, avail);
  const top0 = side === "below" ? (r.bottom || 0) + LORA_PICKER_GAP : (r.top || 0) - LORA_PICKER_GAP - height;
  const top = Math.max(LORA_PICKER_MARGIN, Math.min(top0, v - LORA_PICKER_MARGIN - height));
  return { side, avail, height, top, left: r.left || 0 };
}

function readStoredHeight() {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(LORA_PICKER_H_KEY) : null;
  } catch (_e) {
    return null;
  }
}

// 「＋ 添加 LoRA」/「换」弹窗（v43 :5522-5543 形态 · 改成内嵌菜单）
// swapRow 非空 = 「换」通道：选中后原地替换该行（不新增行）
// 候选 = #28 真清单（engineState.pool）；空池 → 占位行（不伪候选）
function openLoraPicker(btn, loraList, rowsAll, refreshConflict, projectId, swapRow, engineState) {
  if (typeof document === "undefined") return;
  // 关掉旧弹窗（走统一关闭口，注销 resize/锚定监听）
  const old = document.getElementById("loraPicker");
  if (old) closeLoraPicker(old);
  const picker = el("div", { class: "lora-picker", id: "loraPicker" });
  const list = el("div", { class: "lora-picker-list" });
  const resizeBar = el("div", { class: "lora-picker-resize" });
  const pool = engineState && engineState.pool ? engineState.pool : { ok: false, source: "none", names: [] };
  const names = Array.isArray(pool.names) ? pool.names : [];
  const used = new Set(Array.from(loraList.querySelectorAll(".lorarow")).map((r) => r.getAttribute("data-lora")));
  if (names.length === 0) {
    const empty = el("div", { class: "lpi disabled", text: poolStateText(pool) });
    list.appendChild(empty);
  }
  for (const name of names) {
    const dup = used.has(name);
    const item = el("div", { class: "lpi" + (dup ? " disabled" : "") });
    item.textContent = dup ? name + t("resources.dupTag") : name;
    if (!dup) {
      item.style.cursor = "pointer";
      item.addEventListener("click", () => pickLora(name, picker, loraList, rowsAll, refreshConflict, projectId, swapRow, engineState));
    }
    list.appendChild(item);
  }
  picker.appendChild(list);
  picker.appendChild(resizeBar); // 拖拽条固定弹窗底部（不随列表滚动）
  // 自动适配 + 记忆：position 每次更新（打开/滚动/resize/拖拽）都按锚点矩形重算侧位/高度/顶边
  const applyH = (h) => {
    picker._h = h;
    picker.style.height = h + "px";
  };
  const vh0 = (typeof window !== "undefined" && window.innerHeight) || 800;
  const stored = parseInt(readStoredHeight(), 10);
  picker._h = Number.isFinite(stored) ? stored : Math.round(vh0 * 0.6); // 目标高度（首帧 position 内夹紧）
  let curAvail = 0;
  // 定位（v43 :5534-5537）—— F37：经 anchor helper 锚定按钮（绑定即定位一次·滚动/resize 跟随）
  document.body.appendChild(picker);
  picker._anchorH = followAnchor(btn, picker, {
    position: (rect) => {
      const v = (typeof window !== "undefined" && window.innerHeight) || 800;
      const L = loraPickerLayout(rect, v, picker._h);
      applyH(L.height);
      curAvail = L.avail;
      return { left: L.left, top: L.top };
    },
  });
  // 拖底部横条改高（元素级 + document 级双挂·照 ai-archive 先例）
  let startY = 0;
  let startH = 0;
  const onMove = (ev) => {
    if (!picker._dragging) return;
    const y = ev && Number.isFinite(ev.clientY) ? ev.clientY : startY;
    applyH(clampLoraPickerHeight(startH + (y - startY), curAvail));
    if (picker._anchorH) picker._anchorH.update();
  };
  const onUp = () => {
    if (!picker._dragging) return;
    picker._dragging = false;
    try {
      if (globalThis.localStorage) globalThis.localStorage.setItem(LORA_PICKER_H_KEY, String(picker._h));
    } catch (_e) { /* 隐私模式/配额满 → 静默 */ }
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    setTimeout(() => { picker._suppressClick = false; }, 0);
  };
  const onDown = (ev) => {
    if (ev && ev.button) return; // 仅左键（undefined/0 均放行）
    if (ev && ev.cancelable && typeof ev.preventDefault === "function") ev.preventDefault();
    picker._dragging = true;
    picker._suppressClick = true;
    startY = ev && Number.isFinite(ev.clientY) ? ev.clientY : 0;
    startH = picker._h;
    if (typeof resizeBar.setPointerCapture === "function") {
      try { resizeBar.setPointerCapture(ev && ev.pointerId); } catch (_e) { /* 合成事件无 pointerId */ }
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  resizeBar.addEventListener("pointerdown", onDown);
  resizeBar.addEventListener("pointermove", onMove);
  resizeBar.addEventListener("pointerup", onUp);
  resizeBar.addEventListener("pointercancel", onUp);
  // 视口变化：position 内重算 avail → 夹高度 + 重定位（close 时注销）
  const onWinResize = () => {
    if (picker._anchorH) picker._anchorH.update();
  };
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", onWinResize);
  picker._onWinResize = onWinResize;
  // 点空白关（拖拽松手/抑制期内不关：落在弹窗外也不误关）
  setTimeout(() => {
    const off = (e) => {
      if (picker._dragging || picker._suppressClick) return;
      if (!picker.contains(e.target) && e.target !== btn) {
        closeLoraPicker(picker);
        document.removeEventListener("click", off);
      }
    };
    document.addEventListener("click", off);
  }, 10);
}

// F37：统一关闭口（注销 resize/锚定监听 + 移除弹层）
function closeLoraPicker(picker) {
  if (picker._onWinResize && typeof window !== "undefined" && window.removeEventListener) {
    window.removeEventListener("resize", picker._onWinResize);
  }
  if (picker._anchorH) picker._anchorH.detach();
  picker.remove();
}

function pickLora(name, picker, loraList, rowsAll, refreshConflict, projectId, swapRow, engineState) {
  const used = new Set(Array.from(loraList.querySelectorAll(".lorarow")).map((r) => r.getAttribute("data-lora")));
  if (used.has(name)) {
    if (typeof showToast === "function") showToast("info", t("resources.dupToast"));
    return;
  }
  // 批B 新增：「换」= 原地替换该行 LoRA（不新增行 · 强度保留 · 落盘）
  if (swapRow) {
    const entry = rowsAll.find((r) => r._dom === swapRow);
    const nm = swapRow.querySelector(".nm");
    swapRow.setAttribute("data-lora", name);
    if (nm) {
      nm.textContent = name;
      nm.title = t("resources.manual.nameTitle", { name });
    }
    if (entry) {
      entry.name = name;
      if (entry._item) entry._item.name = name;
    }
    persistManualChain(projectId, loraList, rowsAll);
    refreshConflict();
    closeLoraPicker(picker);
    if (typeof showToast === "function") showToast("success", t("resources.swapped", { name }));
    return;
  }
  // 追加手动行
  const item = { name, strength: 0.5, enabled: true, locked: false };
  const row = renderLoraRow(item, loraList, rowsAll, refreshConflict, projectId, engineState);
  // 手动行只能追加在模板行之后、其他手动行之尾
  const firstManual = loraList.querySelector(".lorarow.manual");
  if (firstManual) loraList.insertBefore(row, firstManual);
  else loraList.appendChild(row);

  // 落盘（与删除/强度/「换」同一通道：按 DOM 顺序重建 loraChain）
  persistManualChain(projectId, loraList, rowsAll);

  refreshConflict();
  closeLoraPicker(picker);
  if (typeof showToast === "function") showToast("success", t("resources.added", { name }));
}
