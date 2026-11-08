// V1.9 批 2 R1 资源编排 UI 域 — 模板 LoRA 列表展示 + 编排增删/调序 + widget 持久化
//
// 数据契约 (与 T2.1 batch_core._parse_resources_list / T2.4 后端同步):
//   每条 = { name, strength_model, strength_clip, order, source }
//   source ∈ {"template", "edited"} — template 源条目不入 resources_list widget
//     (edited 才注入语义不变); V1.9 T4.4b 起模板行强度/禁用放开编辑:
//     改动走独立 lora_overrides widget (值覆写通道, 模板文件/节点结构零改动);
//     调序对 template 行仍禁用 (模板链序不可调, template 不参与注入链排布)
//
// 模块分层:
//   - 纯函数 (无 DOM/网络): addResource / removeResource / moveResource /
//     updateResourceStrength / hasTurboConflict / serializeResources /
//     deserializeResources / serializeLoraOverrides / deserializeLoraOverrides /
//     templateRowState
//     单源测试 (test_t2_resources_ui.py) 直接 vm.runInContext 调
//   - DOM 装配: buildResourcesSection() — 主入口; main.js 的 ensureOverlay 调用
//
// 持久化路径:
//   用户改列表 → 纯函数原地改模块级 _resourcesList → serializeResources →
//   current.node._h3Path.set("resources_list", json) → 保存工作流即落盘
//   模板行改动 (T4.4b) → _loraOverridesMap → serializeLoraOverrides →
//   current.node._h3Path.set("lora_overrides", json) → 同款落盘
import { api } from "../../../scripts/api.js";
import { app } from "../../../scripts/app.js";

// ============================================================================
// 1. 模块级状态
// ============================================================================

// 当前编排条目 (UI 视图 = 此数组; 数据契约见 T2.1); 主入口确保每次 openForm 重建
//   T2.7: 此数组只含 edited 条目; 模板自带 LoRA 单独存于 _templateLoras, 不入持久化
let _resourcesList = [];
// 模板自带 LoRA (T2.7 新增): 仅用于 _refreshList 只读渲染; 不入 _resourcesList / 不入 widget
let _templateLoras = [];
// 模板自带 LoRA 覆写 (T4.4b 新增): {文件名: {strength?: number, disabled?: true, name?: string}};
//   仅含被用户改过的模板条目 (R4 起 name = 换文件); 持久化到 widget lora_overrides
//   (引擎 _parse_lora_overrides 同契约)
let _loraOverridesMap = {};
// 当前节点引用 — 供 buildResourcesSection 内回调写 widget + setDirtyCanvas
let _currentNode = null;
// 当前模板 workflowPath — 供 unet 双源家族判定 (ovUnet 优先, 否则用 workflowPath basename)
let _currentWorkflowPath = null;
// 冲突黄条句柄 — 列表变化时重算
let _conflictBanner = null;
// V1.11 批4 T4 D6: PDD 模板标志 — /h3_batch/template_loras 响应顶层 has_pdd 解析后置位
let _hasPddTemplate = false;
// V1.11 批4 T4 D6: PDD × turbo 互斥预警条句柄 (与 _conflictBanner 独立黄条)
let _pddConflictBanner = null;

// ============================================================================
// 2. 纯函数 (无 DOM/网络) — UI 与测试共用
// ============================================================================

// 添加: 末尾追加 edited 条目; 默认 strength_model=1.0; 同名允许 (UI 去重归后续任务)
//   opts: { strength_model?, strength_clip?, category? }
// 返回: 传入的 list 引用 (原地修改, 便于链式)
export function addResource(list, name, opts = {}) {
    const entry = {
        name: String(name || ""),
        strength_model: (typeof opts.strength_model === "number") ? opts.strength_model : 1.0,
        strength_clip: (typeof opts.strength_clip === "number") ? opts.strength_clip : null,
        order: list.length,
        source: "edited",
    };
    // category 是 UI 临时缓存 (供黄条计算); 不入 widget 序列化, 由 template_loras 重算
    if (opts.category) entry.category = opts.category;
    list.push(entry);
    return list;
}

// 删除: 仅 edited 可删; template 源条目 → 静默忽略 (UI 按钮 disabled 双护栏)
// 返回: 传入的 list 引用
export function removeResource(list, idx) {
    if (idx < 0 || idx >= list.length) return list;
    const entry = list[idx];
    if (!entry || entry.source === "template") return list;
    list.splice(idx, 1);
    // 序号补齐: order 字段保持与数组索引一致 (UI/序列化 都用 order 冗余保留)
    for (let i = 0; i < list.length; i++) list[i].order = i;
    return list;
}

// 调序: 仅 edited 间换位; 跨 template 边界调序 → 静默忽略 (template 行禁调)
// 返回: 传入的 list 引用
export function moveResource(list, from, to) {
    if (from === to) return list;
    if (from < 0 || from >= list.length) return list;
    if (to < 0 || to >= list.length) return list;
    if (list[from].source === "template") return list;
    if (list[to].source === "template") return list;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    for (let i = 0; i < list.length; i++) list[i].order = i;
    return list;
}

// 改强度: 仅 edited 可改; template → 静默忽略
// 返回: 传入的 list 引用
export function updateResourceStrength(list, idx, value) {
    if (idx < 0 || idx >= list.length) return list;
    const entry = list[idx];
    if (!entry || entry.source === "template") return list;
    const v = parseFloat(value);
    entry.strength_model = (isFinite(v)) ? v : 1.0;
    return list;
}

// 冲突检测: 列表中 ≥2 个 category=turbo 条目 → True (UI 出黄条)
// 空 / 仅 1 个 / 0 个 → False
export function hasTurboConflict(list) {
    if (!Array.isArray(list) || list.length < 2) return false;
    let turboCount = 0;
    for (const e of list) {
        if (e && e.category === "turbo") {
            turboCount += 1;
            if (turboCount >= 2) return true;
        }
    }
    return false;
}

// V1.11 批4 T4 D6: PDD 模板 + 任一 turbo 条目 → True (互斥预警条).
//   判定口径双源: category==="turbo" (widget 持久化路径, 新版写入) OR 文件名含 "turbo"
//   (旧 widget 无 category 兜底, 与后端 _classify_injectable 文件名启发式同源).
//   模板列表 _templateLoras 也参与合并判定 (模板自带 turbo lora 也互斥).
export function isPddTurboConflict(hasPdd, list) {
    if (!hasPdd) return false;
    if (!Array.isArray(list)) return false;
    for (const e of list) {
        if (!e) continue;
        if (e.category === "turbo") return true;
        const n = String(e.name || "").toLowerCase();
        if (n.includes("turbo")) return true;
    }
    return false;
}

// 序列化: 紧凑 JSON (用于 widget multiline 紧凑存); 只持久化数据契约字段
//   字段: name, strength_model, strength_clip, order, source (5 字段);
//         category (V1.11 批4 T4 D1) — 仅 turbo/style 写键, 缺省/null/其他省略
//   T2.7: 过滤 source=="template" — 模板自带条目由模板自带节点承担, 不入 widget
//         (防止 widget 被模板数据污染, 引擎侧 _inject_loras 也有同款防御)
export function serializeResources(list) {
    const out = [];
    for (const e of (list || [])) {
        if (!e || e.source === "template") continue;  // T2.7: 防御层, 模板不入持久化
        const o = {
            name: e.name,
            strength_model: e.strength_model,
            strength_clip: (e.strength_clip === undefined) ? null : e.strength_clip,
            order: e.order,
            source: e.source,
        };
        // D1: category 非 turbo/style 时省略键 (与后端 _parse_resources_list 缺省 = None 同构)
        if (e.category === "turbo" || e.category === "style") o.category = e.category;
        out.push(o);
    }
    return JSON.stringify(out);
}

// 反序列化: widget 文本 → 列表; 容错兜底 (空 / 非法 JSON / 非数组 → [])
//   不做字段校验 (校验归引擎侧 _parse_resources_list); 这里只负责"能解析就拿来用"
//   T2.7: 过滤 source=="template" 脏数据 — 历史 widget 可能含 template 条目 (旧版本残留);
//         过滤后纯净的 edited 列表, 不展示为"可删"也不保留
//   V1.11 批4 T4 D1: category 仅保留 turbo/style; 非法值/缺省键 → 移除 (与 serialize 对称,
//         5 字段旧形态零破坏 — roundtrip 无 category 输入 → 输出无 category 键)
export function deserializeResources(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return [];
    try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) {
            return v
                .filter((e) => e && e.source !== "template")  // T2.7: 兜底脏数据
                .map((e) => {
                    if (e.category === "turbo" || e.category === "style") return e;
                    const o = Object.assign({}, e);
                    delete o.category;
                    return o;
                });
        }
        return [];
    } catch (_) {
        return [];
    }
}


// ============================================================================
// 2.2 V1.9 收尾 T4.4b: 模板自带 LoRA 覆写 — 序列化/反序列化/模板行态计算
//   数据契约: widget `lora_overrides` = JSON 对象 (与 batch_core._parse_lora_overrides 同口径)
//   {"<lora 文件名>": {"strength": 0.7} | {"disabled": true} | {"name": "新文件名"}} — 仅含被改过的模板条目
//   (R4 起 name = 换文件, 值覆写通道; 模板文件/节点结构零改动)
// ============================================================================

// 序列化: map → 紧凑 JSON; 无有效字段 (空对象/只有未知键) 的条目剔除;
//   null/undefined map → "{}" (容错); R4 起支持 name (换文件, 非空字符串才保留)
export function serializeLoraOverrides(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
        const v = map[k];
        if (!k || !v || typeof v !== "object") continue;
        const e = {};
        if (typeof v.strength === "number" && isFinite(v.strength)) e.strength = v.strength;
        if (v.disabled === true) e.disabled = true;
        if (typeof v.name === "string" && v.name.trim()) e.name = v.name;
        if (Object.keys(e).length) out[k] = e;
    }
    return JSON.stringify(out);
}

// 反序列化: widget 文本 → map; 容错兜底 (空 / 非法 JSON / 非对象 → {});
//   非法条目 (值非对象 / 字段类型错) 剔除 — 响亮报错归引擎侧 _parse_lora_overrides
export function deserializeLoraOverrides(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return {};
    try {
        const v = JSON.parse(s);
        if (!v || typeof v !== "object" || Array.isArray(v)) return {};
        const out = {};
        for (const k of Object.keys(v)) {
            const val = v[k];
            if (!k || !val || typeof val !== "object" || Array.isArray(val)) continue;
            const e = {};
            if (typeof val.strength === "number" && isFinite(val.strength)) e.strength = val.strength;
            if (val.disabled === true) e.disabled = true;
            if (typeof val.name === "string" && val.name.trim()) e.name = val.name;
            if (Object.keys(e).length) out[k] = e;
        }
        return out;
    } catch (_) {
        return {};
    }
}

// 模板行态计算: (模板条目, 覆写 map) → {strength, disabled, overridden, rename}
//   - strength: 显示强度 — disabled ? 0 (引擎写 0.0) : (覆写值 ?? 模板原值 ?? 1.0)
//   - disabled: 覆写标记了禁用
//   - overridden: 与模板原值有差异 (覆写值 != 原值 / 已禁用 / 已换文件)
//   - rename: R4 换文件 — ov.name 非空字符串时为新文件名, 否则 null (与禁用独立)
//   与引擎 _apply_lora_overrides 语义一致: disabled 优先于 strength; name 独立生效
export function templateRowState(entry, overrides) {
    const name = entry && entry.name;
    const ov = (overrides && overrides[name]) || null;
    const disabled = !!(ov && ov.disabled === true);
    const orig = (entry && typeof entry.strength_model === "number") ? entry.strength_model : 1.0;
    const ovStr = (ov && typeof ov.strength === "number" && isFinite(ov.strength)) ? ov.strength : null;
    const rename = (ov && typeof ov.name === "string" && ov.name.trim()) ? ov.name : null;
    const strength = disabled ? 0 : (ovStr !== null ? ovStr : orig);
    const overridden = disabled || rename !== null || (ovStr !== null && ovStr !== orig);
    return { strength, disabled, overridden, rename };
}


// ============================================================================
// 2.6 V1.9 T2.6b: LoRA picker 纯函数 — 选项构建/同名去重/空态判定
//   把"添加 LoRA"从手输 prompt 升级为库列表选择器:
//   - buildLoraPickerOptions: 把 /h3_batch/resources?kind=lora 返回的 items
//     投影成 picker 选项 (name/category/known_h3/why_included/isDuplicate)
//   - isResourceDuplicate: 按 name 精确比对, 选中后做去重判定 (DOM 兜底)
//   - pickerEmptyState: 区分 "has-items" / "no-match"(筛选模式空, 建议切全量) / "empty"
// ============================================================================

// 把 items 投影成 picker 选项; existingNames 接受 Set/Map (有 .has); null/undefined → 全不标 duplicate
//   非法条目 (非对象 / 无 file) → 跳过, 不抛
// 返回: [{ name, category, known_h3, why_included, isDuplicate }, ...] (保持 items 顺序)
export function buildLoraPickerOptions(items, existingNames) {
    const out = [];
    if (!Array.isArray(items)) return out;
    for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const f = it.file;
        if (typeof f !== "string" || !f) continue;
        const has = existingNames && typeof existingNames.has === "function";
        out.push({
            name: f,
            category: (typeof it.category === "string") ? it.category : null,
            known_h3: !!it.known_h3,
            why_included: (typeof it.why_included === "string") ? it.why_included : null,
            isDuplicate: has ? !!existingNames.has(f) : false,
        });
    }
    return out;
}

// 按 name 精确比对 — DOM 选中时做去重兜底 (理论上 isDuplicate 已标, 这里做二次防线)
export function isResourceDuplicate(list, name) {
    if (!Array.isArray(list) || !name) return false;
    const target = String(name);
    for (const e of list) {
        if (e && e.name === target) return true;
    }
    return false;
}

// picker 空态: 0 项 → "no-match"(筛选模式, 提示切全量) / "empty"(全量仍空);
//   >0 项 → "has-items"
export function pickerEmptyState(itemCount, showAll) {
    if (itemCount > 0) return "has-items";
    return showAll ? "empty" : "no-match";
}


// ============================================================================
// 2.5 V1.9 T2.5 R2: 资源覆写 (模型/CLIP/VAE) — 解析/序列化/反序列化/类型预检
// ============================================================================
// JSON 对象 {unet?, clip?, vae_video?, vae_audio?}; 缺省 = 不覆写; 未知键忽略; 空串值跳过
const _OVK = ["unet", "clip", "vae_video", "vae_audio"];

export function serializeOverrides(map) {
    const out = {};
    for (const k of _OVK) { const v = map && map[k]; if (typeof v === "string" && v) out[k] = v; }
    return JSON.stringify(out);
}

export function deserializeOverrides(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return {};
    try {
        const v = JSON.parse(s);
        if (v && typeof v === "object" && !Array.isArray(v)) {
            const out = {};
            for (const k of _OVK) { if (typeof v[k] === "string" && v[k]) out[k] = v[k]; }
            return out;
        }
    } catch (_) { /* 容错 */ }
    return {};
}

// UI 侧预检: 与 batch_core._apply_overrides 同款互斥词规则
export function previewOverrideWarnings(overrides, currentLoaders) {
    const warns = [];
    if (!overrides || !currentLoaders) return warns;
    const ou = (currentLoaders.unet || "").toLowerCase(), nu = (overrides.unet || "").toLowerCase();
    if (nu) {
        const or = ou.includes("ref2v"), of = ou.includes("fl2v"), nr = nu.includes("ref2v"), nf = nu.includes("fl2v");
        if ((or && nf) || (of && nr)) warns.push("UNet 类型不匹配 (ref2v↔fl2v 互斥): 模板 " + currentLoaders.unet + " → 覆写 " + overrides.unet);
    }
    if (overrides.vae_video && overrides.vae_video.toLowerCase().includes("audio"))
        warns.push("vae_video 槽位文件名含 'audio' 词: " + overrides.vae_video);
    if (overrides.vae_audio && overrides.vae_audio.toLowerCase().includes("video"))
        warns.push("vae_audio 槽位文件名含 'video' 词: " + overrides.vae_audio);
    if (overrides.vae_audio && currentLoaders.vae_video && !currentLoaders.vae_audio)
        warns.push("模板仅 1 个 VAELoader, vae_audio 覆写无效");
    return warns;
}

// ============================================================================
// 3. DOM 装配 — buildResourcesSection
// ============================================================================

function _makeChip(text, bg, fg, border) {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.cssText = `padding:1px 6px;border-radius:8px;font-size:11px;background:${bg};color:${fg};border:1px solid ${border};margin-left:4px;`;
    return span;
}

function _categoryBadge(category) {
    if (category === "turbo") return _makeChip("turbo", "rgba(240,160,64,.18)", "#f0a040", "#f0a040");
    if (category === "style") return _makeChip("style", "rgba(64,160,240,.18)", "#4aa3ff", "#4aa3ff");
    return _makeChip("其他", "rgba(160,160,160,.18)", "#aaa", "#888");
}

function _sourceBadge(source) {
    if (source === "template") return _makeChip("模板自带", "rgba(255,200,80,.12)", "#ffc850", "#ffc850");
    return _makeChip("编排添加", "rgba(80,200,120,.12)", "#50c878", "#50c878");
}

function _makeBtn(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title || "";
    // R5: 统一按钮高度 24px — 行内 SELECT/INPUT/BUTTON 上下缘对齐 (全局生效, 添加按钮同为受益);
    //   R10: line-height:1 — 钉死行高, 文字在大行高继承下不再偏离按钮盒中心
    b.style.cssText = "padding:2px 8px;cursor:pointer;font-size:12px;flex:none;height:24px;box-sizing:border-box;line-height:1;";
    b.onclick = onClick;
    return b;
}

function _shortName(name) {
    // R7: 截短显示 — >48 字符截前 45 加省略号; 完整文件名由调用方放 title 悬停展示
    const s = String(name || "");
    return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

// R8: LoRA 换文件下拉共用构建 — 模板行/编排行同款 (老板需求: 所有 LoRA 行都是下拉框);
//   options = 已安装库 (_resCache 同源), 显示名截短 (R7), 悬停 title = 完整文件名;
//   first = 恢复默认锚 (模板原文件, 仅模板行传; 编排行传 null);
//   onPick(value) 由调用方定语义 (模板行 = lora_overrides 值覆写, 编排行 = 改 resources_list.name)
//   V1.10 T2: applyCompatibilityRules("lora", …) → 扩展名过滤 (非 .safetensors 不入 options)
function _buildLoraFileSelect(current, first, onPick) {
    const sel = document.createElement("select");
    sel.dataset.kind = "lora";
    sel.style.cssText = "min-width:0;width:100%;padding:2px 4px;box-sizing:border-box;height:24px;";  // R5 等高 / R9 grid 列内撑满
    sel.title = current + "\n(下拉直选换文件)";
    // 先放当前值保证即时显示, 库列表异步到货后重建完整选项
    sel.appendChild(new Option(_shortName(current), current));
    _loadRes("lora").then((items) => {
        if (sel.value !== current) return;  // 异步窗口内已被用户改选, 不覆盖
        sel.innerHTML = "";
        if (first) sel.appendChild(new Option(_shortName(first), first));
        const out = applyCompatibilityRules(items, "lora", null);
        for (const o of out.options) {
            // first 锚 option 已置顶 — 库列表内同名文件跳过, 避免 value 重复
            if (first && o.file === first) continue;
            const opt = new Option(_shortName(o.file), o.file);
            if (o.disabled) {
                opt.disabled = true;
                if (o.reason) opt.title = o.reason;
            }
            sel.appendChild(opt);
        }
        // 当前值可能不在库列表 (模板引用缺失文件 / 手写历史条目) — 插临时项保显示
        if (![...sel.options].some(o => o.value === current)) {
            sel.insertBefore(new Option(_shortName(current), current), sel.firstChild);
        }
        sel.value = current;
    });
    sel.onchange = () => {
        sel.title = sel.value + "\n(下拉直选换文件)";
        onPick(sel.value);
    };
    return sel;
}

function _renderRow(parent, entry, idx) {
    const row = document.createElement("div");
    const isTemplate = entry.source === "template";
    // D16: 行定位锚 — 模板行与用户行可同名且模板行渲染在前, 高亮/滚动只能靠 source 判别
    row.dataset.name = entry.name;
    row.dataset.source = isTemplate ? "template" : "edited";
    // T4.4b: 模板行态 = 模板原值 vs 覆写值 vs disabled (lora_overrides 值覆写通道)
    const tState = isTemplate ? templateRowState(entry, _loraOverridesMap) : null;
    const isDisabledRow = !!(tState && tState.disabled);
    // R9: 固定列网格 — 多行之间列列对齐 (下拉 | 🔄 | 徽标组 | 强度 | ↑↓✕);
    //   徽标数量行行不同, 打包进同一列容器消化差异, 列边界不再漂移。
    // V1.11 fix2: 后三列 (↑↓✕) 固定宽 — 之前 auto auto auto 跟着徽标列伸缩波动, 右侧边界漂移。
    row.style.cssText = `display:grid;grid-template-columns:minmax(0,1fr) 32px 176px 64px 40px 40px 52px;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${isTemplate ? "#ffc850" : "#555"};border-radius:4px;margin-bottom:4px;background:${isTemplate ? "rgba(255,200,80,.04)" : "transparent"};${isDisabledRow ? "opacity:0.5;" : ""}`;

    // 名称
    //   R6/R8: 模板行与编排行统一 = 常驻换文件下拉 (直选即换, 显示名截短, 悬停完整名);
    //   模板行首项 = 模板原文件 (选回 = 恢复默认), 换文件经 lora_overrides 值覆写 (模板文件不动);
    //   编排行换文件直接改 resources_list.name (引擎注入链用新文件), 类别徽标随新文件重算
    const isRenamedRow = !!(tState && tState.rename);
    if (isTemplate) {
        const curName = isRenamedRow ? tState.rename : entry.name;
        row.appendChild(_buildLoraFileSelect(curName, entry.name, (v) => {
            const cur = Object.assign({}, _loraOverridesMap[entry.name] || {});
            if (v === entry.name) delete cur.name;  // 选回模板原文件 = 撤销换文件
            else cur.name = v;
            if (Object.keys(cur).length) _loraOverridesMap[entry.name] = cur;
            else delete _loraOverridesMap[entry.name];
            _persistLoraOv();
            _refreshList();  // 名称/徽标行态刷新
        }));
    } else {
        row.appendChild(_buildLoraFileSelect(entry.name, null, (v) => {
            entry.name = v;
            // 类别徽标按新文件重算 (turbo/style), 写回 widget 后重渲染
            _loadRes("lora").then((items) => {
                const hit = (items || []).find(it => it && it.file === v);
                entry.category = hit ? hit.category : null;
                _persistAndDirty();
                _refreshList();
            });
        }));
    }
    // R6: 🔄 = 一键恢复工作流自带 LoRA (撤销换文件覆写); 未换文件时禁用;
    //   R9: 编排行占位等宽 span, 保 🔄 列列对齐
    if (isTemplate) {
        const resetBtn = _makeBtn("🔄", "恢复工作流自带的 LoRA (撤销换文件)", () => {
            const cur = Object.assign({}, _loraOverridesMap[entry.name] || {});
            delete cur.name;
            if (Object.keys(cur).length) _loraOverridesMap[entry.name] = cur;
            else delete _loraOverridesMap[entry.name];
            _persistLoraOv();
            _refreshList();
        });
        if (!isRenamedRow) {
            resetBtn.disabled = true;
            resetBtn.style.opacity = "0.4";
            resetBtn.style.cursor = "not-allowed";
        }
        row.appendChild(resetBtn);
    } else {
        const ph = document.createElement("span");
        ph.style.cssText = "width:32px;height:24px;";
        row.appendChild(ph);
    }
    // 徽标组 (R9: 类别+来源+状态打包同列, 数量差异不再推动后续列)
    const badgeBox = document.createElement("span");
    badgeBox.style.cssText = "display:inline-flex;gap:4px;align-items:center;flex:none;";
    badgeBox.appendChild(_categoryBadge(entry.category));
    badgeBox.appendChild(_sourceBadge(entry.source));
    // T4.4b: 已禁用徽标 (✕ 禁用的模板行灰显 + 可恢复)
    if (isDisabledRow) badgeBox.appendChild(_makeChip("已禁用", "rgba(249,168,37,.15)", "#f9a825", "#f9a825"));
    // R4: 已换文件徽标 (与已禁用独立 — 禁用行同样可换文件)
    if (isRenamedRow) badgeBox.appendChild(_makeChip("已换文件", "rgba(122,150,190,.16)", "#8fa8c8", "#8fa8c8"));
    row.appendChild(badgeBox);

    // 强度框
    //   T4.4b: 模板行放开编辑 — 默认显示模板原强度, 改后写 _loraOverridesMap 持久化;
    //   已禁用时锁输入并显示 0 (引擎摘除该节点, 本次渲染跳过); edited 行为不变
    const strInput = document.createElement("input");
    strInput.type = "number";
    strInput.step = "0.05";
    strInput.value = String(isTemplate ? tState.strength
                                       : (entry.strength_model == null ? 1.0 : entry.strength_model));
    // R5: height:24px — 与行内 select/按钮等高, 上下缘对齐
    strInput.style.cssText = "width:64px;padding:2px 4px;box-sizing:border-box;height:24px;";
    if (isTemplate) {
        strInput.disabled = isDisabledRow;
        strInput.title = isDisabledRow ? "已禁用 (本次渲染跳过, 不加载文件), 点右侧按钮恢复"
                                       : "模板自带, 修改经 lora_overrides 值覆写 (模板文件零改动)";
    }
    strInput.oninput = () => {
        if (isTemplate) {
            // T4.4b: 模板行强度改动 → 覆写 map → widget lora_overrides (不动 _resourcesList)
            const v = parseFloat(strInput.value);
            if (!isFinite(v)) return;
            _loraOverridesMap[entry.name] = Object.assign({}, _loraOverridesMap[entry.name] || {}, { strength: v });
            _persistLoraOv();
            return;  // 列表顺序未变, 无需重渲染
        }
        updateResourceStrength(_resourcesList, idx, strInput.value);
        _persistAndDirty();
        // 列表本身顺序未变, 无需重渲染
    };
    row.appendChild(strInput);

    // 调序 + 删除按钮
    //   T4.4b: 调序对 template 行仍禁用 (顺序 = 模板链序, template 不参与注入链排布);
    //   ✕ 对 template 行放开 — 点击 = 标 disabled (引擎从渲染图摘除该节点不加载文件), 可恢复
    const upBtn = _makeBtn("↑", "上移", () => {
        moveResource(_resourcesList, idx, idx - 1);
        _persistAndDirty();  // T4.5a: 调序必须写回 widget, 否则重开表单顺序复活
        _refreshList();
    });
    const downBtn = _makeBtn("↓", "下移", () => {
        moveResource(_resourcesList, idx, idx + 1);
        _persistAndDirty();  // T4.5a: 同上
        _refreshList();
    });
    const delBtn = _makeBtn(isDisabledRow ? "恢复" : "✕", "", () => {});
    if (isTemplate) {
        upBtn.disabled = true; upBtn.title = "模板自带, 链序由模板文件决定 (不可调)";
        downBtn.disabled = true; downBtn.title = "模板自带, 链序由模板文件决定 (不可调)";
        upBtn.style.opacity = "0.4";
        downBtn.style.opacity = "0.4";
        upBtn.style.cursor = "not-allowed";
        downBtn.style.cursor = "not-allowed";
        delBtn.title = isDisabledRow ? "恢复模板自带 LoRA (撤销禁用)" : "禁用模板自带 LoRA (本次渲染跳过, 不加载文件; 模板文件不动)";
        delBtn.onclick = () => {
            const cur = Object.assign({}, _loraOverridesMap[entry.name] || {});
            if (isDisabledRow) {
                delete cur.disabled;  // 撤销禁用; 无剩余字段则整条移除
                if (Object.keys(cur).length) _loraOverridesMap[entry.name] = cur;
                else delete _loraOverridesMap[entry.name];
            } else {
                cur.disabled = true;
                _loraOverridesMap[entry.name] = cur;
            }
            _persistLoraOv();
            _refreshList();  // 行态切换 (灰显/徽标/按钮文案)
        };
    } else {
        delBtn.title = "删除";
        delBtn.onclick = () => {
            removeResource(_resourcesList, idx);
            _persistAndDirty();  // T4.5a: 删除必须写回 widget, 否则重开表单条目复活
            _refreshList();
        };
    }
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(delBtn);

    parent.appendChild(row);
}

function _refreshList() {
    if (!_listEl) return;
    _listEl.innerHTML = "";
    const total = _templateLoras.length + _resourcesList.length;
    if (!total) {
        const empty = document.createElement("div");
        empty.textContent = "当前工作流未编排 LoRA；从下方添加";
        empty.style.cssText = "color:#9a9a9a;font-size:12px;padding:8px 4px;";
        _listEl.appendChild(empty);
    } else {
        // 模板自带 (T4.4b: 强度/禁用经 lora_overrides 值覆写放开编辑; 调序仍禁 — 由 _renderRow 模板分支处理)
        _templateLoras.forEach((e, i) => _renderRow(_listEl, e, i));
        // 编排添加 (可交互)
        _resourcesList.forEach((e, i) => _renderRow(_listEl, e, i));
    }
    // 冲突黄条重算 — 模板 + 编排 联合判定 (template 也可能挂 turbo)
    if (_conflictBanner) {
        const conflict = hasTurboConflict(_templateLoras.concat(_resourcesList));
        _conflictBanner.style.display = conflict ? "" : "none";
    }
    // V1.11 批4 T4 D6: PDD × turbo 互斥预警条 — has_pdd + 任一 turbo (category 或文件名)
    if (_pddConflictBanner) {
        const pddHit = isPddTurboConflict(_hasPddTemplate,
                                          _templateLoras.concat(_resourcesList));
        _pddConflictBanner.style.display = pddHit ? "" : "none";
    }
}

function _persistAndDirty() {
    if (_currentNode && _currentNode._h3Path) {
        _currentNode._h3Path.set("resources_list", serializeResources(_resourcesList));
        if (typeof _currentNode.setDirtyCanvas === "function") _currentNode.setDirtyCanvas(true, true);
    }
}

// T4.4b: 模板 LoRA 覆写持久化 — map → widget lora_overrides (引擎 _parse_lora_overrides 同契约)
function _persistLoraOv() {
    if (_currentNode && _currentNode._h3Path) {
        _currentNode._h3Path.set("lora_overrides", serializeLoraOverrides(_loraOverridesMap));
        if (typeof _currentNode.setDirtyCanvas === "function") _currentNode.setDirtyCanvas(true, true);
    }
}

// ============================================================================
// 3.5 V1.9 T2.5 R2: 模型/CLIP/VAE 下拉 UI
// ============================================================================
let _ovMap = {}, _ldMap = { unet: null, clip: null, vae_video: null, vae_audio: null };
let _resCache = {}, _showAllKind = { model: false, clip: false, vae: false };
let _ovBannerEl = null, _ovFieldsEl = null;
// V1.10 T2: 独立红条 (与黄条 _ovBannerEl 分离) — 不兼容文件数, fail-open 仅 UI 灰选
let _ovRedBannerEl = null;

const _OV_SLOTS = [
    { key: "unet",      label: "模型 (UNET)", kind: "model" },
    { key: "clip",      label: "CLIP",        kind: "clip" },
    { key: "vae_video", label: "视频 VAE",    kind: "vae" },
    { key: "vae_audio", label: "音频 VAE",    kind: "vae" },
];

async function _loadRes(kind) {
    if (_resCache[kind]) return _resCache[kind];
    try {
        const r = await api.fetchApi("/h3_batch/resources?kind=" + kind + "&all=" + (_showAllKind[kind] ? "1" : "0"));
        const j = r.ok ? await r.json() : { items: [] };
        _resCache[kind] = Array.isArray(j.items) ? j.items : [];
    } catch (_) { _resCache[kind] = []; }
    return _resCache[kind];
}

function _slotVisible(k) {
    if (k === "unet") return !!_ldMap.unet;
    if (k === "clip") return !!_ldMap.clip;
    if (k === "vae_video") return !!_ldMap.vae_video;
    if (k === "vae_audio") return !!_ldMap.vae_audio;
    return false;
}

function _buildSlot(slot) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:4px;";
    const lab = document.createElement("span");
    lab.textContent = slot.label + ":"; lab.style.cssText = "flex:none;width:84px;font-size:12px;color:#bbb;";
    row.appendChild(lab);
    const sel = document.createElement("select");
    sel.dataset.slotKey = slot.key; sel.dataset.kind = slot.kind;
    sel.style.cssText = "flex:1;min-width:0;padding:2px 4px;box-sizing:border-box;";
    const cv = _ovMap[slot.key] || _ldMap[slot.key] || "";
    // R4: 文案简化 — placeholder 不带当前值后缀 (当前项由浏览器原生高亮标识)
    const ph = document.createElement("option"); ph.value = ""; ph.textContent = "不覆写";
    sel.appendChild(ph);
    if (cv) { const c = document.createElement("option"); c.value = cv; c.textContent = cv; c.selected = true; sel.appendChild(c); }

    const saLab = document.createElement("label");
    saLab.style.cssText = "font-size:11px;color:#888;display:flex;align-items:center;gap:2px;flex:none;";
    const saCb = document.createElement("input"); saCb.type = "checkbox"; saCb.checked = _showAllKind[slot.kind]; saCb.style.cssText = "margin:0;";
    saCb.onchange = async () => { _showAllKind[slot.kind] = saCb.checked; _resCache[slot.kind] = null; _fillSel(sel, await _loadRes(slot.kind), cv); };
    saLab.appendChild(saCb); saLab.appendChild(document.createTextNode("显示全部"));
    row.appendChild(sel); row.appendChild(saLab);

    const badge = document.createElement("span");
    badge.style.cssText = "padding:1px 6px;border-radius:8px;font-size:11px;background:rgba(80,200,120,.12);color:#50c878;border:1px solid #50c878;display:none;flex:none;";
    badge.textContent = "已覆写"; badge.dataset.slotBadge = slot.key;
    if (_ovMap[slot.key] && _ovMap[slot.key] !== _ldMap[slot.key]) badge.style.display = "";
    row.appendChild(badge);

    sel.onchange = () => {
        const v = sel.value;
        if (!v || v === _ldMap[slot.key]) delete _ovMap[slot.key]; else _ovMap[slot.key] = v;
        _persistOv(); _refreshOvUI();
    };
    _loadRes(slot.kind).then((items) => _fillSel(sel, items, cv));
    return row;
}

function _fillSel(sel, items, cv) {
    sel.innerHTML = "";
    // R4: 文案简化 — 与 _buildSlot 同口径 (placeholder 不带后缀, 当前项纯文件名)
    const ph = document.createElement("option"); ph.value = ""; ph.textContent = "不覆写";
    sel.appendChild(ph);
    if (cv) { const c = document.createElement("option"); c.value = cv; c.textContent = cv; c.selected = true; sel.appendChild(c); }
    // V1.10 T2: 兼容灰选 — 应用部件规则后, 不兼容项 disabled (UI 不可点, 引擎不动)
    //   unet 槽需要 templateFamily (双源: ovUnet 优先, 否则 workflowPath basename)
    //   fail-open: 灰选仅影响 UI; API/MCP 直调无拦截, 见 _ovRedBannerEl 与 incompatibleBannerText
    const slotKey = sel.dataset.slotKey;
    let ctx = null;
    if (slotKey === "unet") {
        // V1.13 必修 3 (案甲): 同时传 familySource, 让 reason 文案如实标注判定依据来源
        const _ov = _ovMap.unet || "";
        const _wp = _currentWorkflowPath || "";
        ctx = {
            templateFamily: resolveTemplateFamily(_ov, _wp),
            familySource: getFamilySource(_ov, _wp),
        };
    }
    // LoRA 不在 _fillSel 路径里 (LoRA 过滤在 _buildLoraFileSelect / _refreshLoraPicker);
    //   故此处 kind 必非 "lora", filtered 直接 = items.
    const out = applyCompatibilityRules(items, slotKey, ctx);
    for (const o of out.options) {
        const el = document.createElement("option");
        el.value = o.file;
        el.textContent = o.file;
        if (o.disabled) {
            el.disabled = true;
            if (o.reason) el.title = o.reason;  // 灰选原因悬停展示
        }
        sel.appendChild(el);
    }
    const d = _ovMap[sel.dataset.slotKey] || ""; if (d) sel.value = d;
    // 红条更新 (汇总本面板灰选数)
    _refreshRedBanner();
}

function _persistOv() {
    if (_currentNode && _currentNode._h3Path) {
        _currentNode._h3Path.set("resource_overrides", serializeOverrides(_ovMap));
        if (typeof _currentNode.setDirtyCanvas === "function") _currentNode.setDirtyCanvas(true, true);
    }
}

function _refreshOvUI() {
    if (!_ovFieldsEl) return;
    _ovFieldsEl.querySelectorAll("[data-slot-badge]").forEach((b) => {
        b.style.display = (_ovMap[b.dataset.slotBadge] && _ovMap[b.dataset.slotBadge] !== _ldMap[b.dataset.slotBadge]) ? "" : "none";
    });
    if (_ovBannerEl) {
        const ws = previewOverrideWarnings(_ovMap, _ldMap);
        if (ws.length) { _ovBannerEl.textContent = ws.join(" / "); _ovBannerEl.style.display = ""; }
        else _ovBannerEl.style.display = "none";
    }
    _refreshRedBanner();  // V1.10 T2: 红条独立刷新 (黄条/红条分源, 不互相覆盖)
}

// V1.10 T2: 汇总 _ovFieldsEl 内所有 select 的灰选项数, 更新红条.
//   每个 select 的灰选已在 _fillSel 应用 applyCompatibilityRules 时按 option.disabled 标记;
//   这里重扫一遍 DOM 数 disabled option (与 _fillSel 同源, 无独立纯函数调用, 零开销).
function _refreshRedBanner() {
    if (!_ovRedBannerEl || !_ovFieldsEl) return;
    let n = 0;
    _ovFieldsEl.querySelectorAll("select[data-slot-key]").forEach((sel) => {
        for (const opt of sel.options) {
            if (opt && opt.disabled) n++;
        }
    });
    const txt = incompatibleBannerText(n);
    if (txt) {
        _ovRedBannerEl.textContent = txt;
        _ovRedBannerEl.style.display = "";
    } else {
        _ovRedBannerEl.style.display = "none";
    }
}

function _buildOvSection() {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #555;border-radius:6px;padding:10px;margin-bottom:12px;";
    const lab = document.createElement("div");
    lab.style.cssText = "font-weight:700;margin-bottom:8px;";
    lab.textContent = "模型 / CLIP / VAE 切换 (R2 — 下拉覆盖模板当前加载项, 提交时引擎执行)";
    box.appendChild(lab);
    // V1.10 T2: 独立红条 (顶部独立显示) — 灰选文件计数; 老板误读反馈改为中性蓝提示系
    //   (与文件内既有 LoRA picker 提示蓝 #4aa3ff / rgba(74,163,255,.04) 同款, 视觉不抢眼).
    //   默认隐藏; 文本由 incompatibleBannerText(greyCount) 提供
    const redBanner = document.createElement("div");
    redBanner.style.cssText = "display:none;background:rgba(74,163,255,.12);color:#4aa3ff;border:1px solid #4aa3ff;padding:6px 10px;border-radius:4px;margin-bottom:8px;font-size:12px;";
    redBanner.dataset.slotRedBanner = "1";
    box.appendChild(redBanner);
    _ovRedBannerEl = redBanner;
    const banner = document.createElement("div");
    banner.style.cssText = "display:none;background:rgba(249,168,37,.18);color:#f9a825;border:1px solid #f9a825;padding:6px 10px;border-radius:4px;margin-bottom:8px;font-size:12px;";
    box.appendChild(banner);
    _ovBannerEl = banner;
    const fields = document.createElement("div"); box.appendChild(fields); _ovFieldsEl = fields;
    for (const s of _OV_SLOTS) if (_slotVisible(s.key)) fields.appendChild(_buildSlot(s));
    return box;
}

function _refreshOvSection() {
    if (!_ovFieldsEl) return;
    _ovFieldsEl.innerHTML = "";
    for (const s of _OV_SLOTS) if (_slotVisible(s.key)) _ovFieldsEl.appendChild(_buildSlot(s));
    _refreshOvUI();
}

let _listEl = null;

async function _loadAndMergeTemplate(current, workflowPath) {
    // 异步从后端发现模板自带 LoRA; 失败/未配置 → 静默返回 (UI 仍可手动加)
    // T2.7: 模板条目单独存于 _templateLoras (只读展示), 不入 _resourcesList / 不入 widget
    //   widget 语义是"编排列表" (edited 条目); 模板自带由模板节点自带, 不应被持久化
    // V1.11 批4 T4 D6: 解析响应顶层 has_pdd → _hasPddTemplate (互斥预警条用)
    if (!workflowPath) { _templateLoras = []; _hasPddTemplate = false; return; }
    try {
        const r = await api.fetchApi("/h3_batch/template_loras?workflow_path=" + encodeURIComponent(workflowPath));
        if (!r.ok) { _templateLoras = []; _hasPddTemplate = false; return; }
        const j = await r.json();
        const tplList = (j && Array.isArray(j.loras)) ? j.loras : [];
        _hasPddTemplate = !!(j && j.has_pdd === true);
        const editedNames = new Set(_resourcesList.map((e) => e.name));
        const out = [];
        for (const e of tplList) {
            // 用户已编辑同名 → 不重复展示 (用户的 edited 条目优先)
            if (editedNames.has(e.name)) continue;
            out.push({
                name: e.name,
                strength_model: (typeof e.strength === "number") ? e.strength : 1.0,
                strength_clip: null,
                source: "template",
                category: e.category || null,
            });
        }
        _templateLoras = out;
    } catch (_) {
        // 网络/解析失败 — 静默 (用户也可手动加)
        _templateLoras = [];
        _hasPddTemplate = false;
    }
}

function _addFromPicker() {
    // V1.9 T2.6b 已废弃: 改为库列表选择器 (见 _toggleLoraPicker);
    // 保留为空函数以防外部误调 — 实际触发由 buildResourcesSection 接 _toggleLoraPicker
    return;
}

// ============================================================================
// 3.6 V1.9 T2.6b: LoRA 库列表 picker — 替换原手输 prompt 模式
// ============================================================================
// 与 T2.5 覆写下拉同源模式: 顶部"显示全部"切换 + 选项列表 + 空态
//   - 数据源: GET /h3_batch/resources?kind=lora (show_all=0 默认筛选, =1 全量)
//   - 选项: 文件名 + 类别徽标 (复用 _categoryBadge)
//   - 同名: 已存在条目标"已在列表中"且禁用点击; 点击其他条目 → addResource → 关闭 picker
//   - 重复点击同名 → "已在列表中"提示 + 滚动到该行 + 高亮 1.5s
//   - 空态: 筛选模式 → "无匹配资源（显示全部查看）"; 全量模式 → "暂无可用 LoRA"
let _pickerEl = null;
let _pickerItemsEl = null;
let _pickerStatusEl = null;
let _loraCache = null;
let _showAllLora = false;

async function _loadLoraRes() {
    if (_loraCache) return _loraCache;
    try {
        const r = await api.fetchApi("/h3_batch/resources?kind=lora&all=" + (_showAllLora ? "1" : "0"));
        const j = r.ok ? await r.json() : { items: [] };
        _loraCache = Array.isArray(j.items) ? j.items : [];
    } catch (_) { _loraCache = []; }
    return _loraCache;
}

function _setPickerStatus(msg, color) {
    if (!_pickerStatusEl) return;
    _pickerStatusEl.textContent = msg || "";
    _pickerStatusEl.style.color = color || "#aaa";
    _pickerStatusEl.style.display = msg ? "" : "none";
}

function _refreshLoraPicker() {
    if (!_pickerItemsEl) return;
    _pickerItemsEl.innerHTML = "";
    const items = _loraCache || [];
    // V1.10 T2: 先按 LoRA 扩展名过滤 (.safetensors); 过滤后项再走 buildLoraPickerOptions
    //   picker 列表语义是"可选添加", 扩展名过滤不展示非 LoRA 文件 (避免误点 .bin/.pt)
    const loraFiltered = applyCompatibilityRules(items, "lora", null);
    const pickerItems = loraFiltered.options.map((o) => ({ file: o.file, category: null }));
    const existing = new Set(_resourcesList.map((e) => e && e.name).filter(Boolean));
    const opts = buildLoraPickerOptions(pickerItems, existing);
    const st = pickerEmptyState(opts.length, _showAllLora);
    if (st !== "has-items") {
        const msg = (st === "no-match") ? "无匹配资源（显示全部查看）" : "暂无可用 LoRA";
        const empty = document.createElement("div");
        empty.textContent = msg;
        empty.style.cssText = "color:#9a9a9a;font-size:12px;padding:8px 4px;";
        _pickerItemsEl.appendChild(empty);
        return;
    }
    for (const opt of opts) {
        const row = document.createElement("div");
        const dup = opt.isDuplicate;
        row.style.cssText = `display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${dup ? "#666" : "#4aa3ff"};border-radius:4px;margin-bottom:4px;${dup ? "" : "cursor:pointer;"}background:${dup ? "rgba(80,80,80,.08)" : "rgba(74,163,255,.06)"};opacity:${dup ? "0.6" : "1"};`;
        const nameSpan = document.createElement("span");
        nameSpan.textContent = opt.name;
        nameSpan.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        row.appendChild(nameSpan);
        row.appendChild(_categoryBadge(opt.category));
        if (dup) {
            const inList = document.createElement("span");
            inList.textContent = "已在列表中";
            inList.style.cssText = "padding:1px 6px;border-radius:8px;font-size:11px;background:rgba(160,160,160,.18);color:#bbb;border:1px solid #888;flex:none;";
            row.appendChild(inList);
        }
        row.title = dup ? "同名 LoRA 已在编排列表中, 不可重复添加" : "点击添加到编排列表 (强度 1.0)";
        if (!dup) row.onclick = () => _onPickLora(opt);
        _pickerItemsEl.appendChild(row);
    }
}

function _onPickLora(opt) {
    if (isResourceDuplicate(_resourcesList, opt.name)) {
        _setPickerStatus("已在列表中: " + opt.name, "#f9a825");
        // 滚动到该行并高亮: 按 data-name + data-source 定位 (DOM 顺序 = 模板行 + 用户行,
        // 同名模板行渲染在前 — 索引算法会错位到模板行; 只取 edited 行)
        if (_listEl) {
            const row = [..._listEl.querySelectorAll('[data-name][data-source="edited"]')]
                .find((el) => el.dataset.name === opt.name);
            if (row && typeof row.scrollIntoView === "function") {
                row.scrollIntoView({ behavior: "smooth", block: "center" });
                row.style.outline = "2px solid #f9a825";
                setTimeout(() => { try { row.style.outline = ""; } catch (_) {} }, 1500);
            }
        }
        return;
    }
    addResource(_resourcesList, opt.name, { strength_model: 1.0, category: opt.category });
    _persistAndDirty();
    _refreshList();
    _setPickerStatus("已添加: " + opt.name, "#50c878");
    // 关闭 picker, 选下一项需重开
    if (_pickerEl) _pickerEl.style.display = "none";
}

function _buildLoraPicker() {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #4aa3ff;border-radius:6px;padding:8px;margin-top:6px;background:rgba(74,163,255,.04);";
    // 标题行: 显示全部 切换 (与 T2.5 覆写下拉同款实现)
    const head = document.createElement("div");
    head.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;";
    const lab = document.createElement("span");
    lab.textContent = "选择 LoRA (从已安装库)";
    lab.style.cssText = "flex:1;font-weight:700;font-size:12px;color:#ccc;";
    head.appendChild(lab);
    const saLabel = document.createElement("label");
    saLabel.style.cssText = "font-size:11px;color:#888;display:flex;align-items:center;gap:2px;flex:none;cursor:pointer;";
    const saCb = document.createElement("input");
    saCb.type = "checkbox"; saCb.checked = _showAllLora; saCb.style.cssText = "margin:0;cursor:pointer;";
    saCb.onchange = async () => {
        _showAllLora = saCb.checked;
        _loraCache = null;
        await _loadLoraRes();
        _refreshLoraPicker();
    };
    saLabel.appendChild(saCb);
    saLabel.appendChild(document.createTextNode("显示全部"));
    head.appendChild(saLabel);
    box.appendChild(head);
    // 状态行 (重复/成功提示)
    const status = document.createElement("div");
    status.style.cssText = "font-size:11px;margin-bottom:4px;display:none;color:#aaa;";
    box.appendChild(status);
    _pickerStatusEl = status;
    // 选项区 (限高滚动)
    const items = document.createElement("div");
    items.style.cssText = "max-height:240px;overflow-y:auto;";
    box.appendChild(items);
    _pickerItemsEl = items;
    return box;
}

async function _toggleLoraPicker() {
    if (!_pickerEl) return;
    const isHidden = (_pickerEl.style.display === "none");
    if (isHidden) {
        _pickerEl.style.display = "";
        _loraCache = null;
        await _loadLoraRes();
        _refreshLoraPicker();
        _setPickerStatus("");
    } else {
        _pickerEl.style.display = "none";
    }
}

export function buildResourcesSection() {
    // 每次重建: 清空当前状态, 重新挂 DOM 钩子
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #555;border-radius:6px;padding:10px;margin-bottom:12px;";
    const lab = document.createElement("div");
    lab.style.cssText = "font-weight:700;margin-bottom:8px;";
    lab.textContent = "资源编排 (工作流 LoRA 链 — 模板自带可改强度/禁用, 链序锁模板; 下方可添加)";
    box.appendChild(lab);

    // 冲突黄条 (默认隐藏)
    const banner = document.createElement("div");
    banner.textContent = "同挂多个 turbo 变体, 采样行为可能互斥抵消";
    banner.style.cssText = "display:none;background:rgba(249,168,37,.18);color:#f9a825;border:1px solid #f9a825;padding:6px 10px;border-radius:4px;margin-bottom:8px;font-size:12px;";
    box.appendChild(banner);
    _conflictBanner = banner;

    // V1.11 批4 T4 D6: PDD × turbo 互斥预警条 — 与冲突黄条独立 (语义不同: 拦截 vs 警告)
    const pddBanner = document.createElement("div");
    pddBanner.textContent = "PDD 模板与 turbo 加速 lora 互斥, 提交将被拦截";
    pddBanner.style.cssText = "display:none;background:rgba(249,168,37,.18);color:#f9a825;border:1px solid #f9a825;padding:6px 10px;border-radius:4px;margin-bottom:8px;font-size:12px;";
    box.appendChild(pddBanner);
    _pddConflictBanner = pddBanner;

    // 列表区
    const list = document.createElement("div");
    list.style.cssText = "margin-bottom:8px;";
    box.appendChild(list);
    _listEl = list;

    // 底部操作行
    const opRow = document.createElement("div");
    opRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const addBtn = _makeBtn("➕ 添加 LoRA", "从已安装库选择 LoRA", () => _toggleLoraPicker());
    addBtn.style.padding = "4px 12px";
    opRow.appendChild(addBtn);
    const hint = document.createElement("span");
    hint.textContent = "(从已安装 LoRA 库选择; 同名不会重复添加)";
    hint.style.cssText = "color:#9a9a9a;font-size:11px;";
    opRow.appendChild(hint);
    // V1.11 批4 T4 D2 文案: 挂载顺序系统自动规则提示
    const orderHint = document.createElement("span");
    orderHint.textContent = "挂载顺序: 加速类在前、风格类在后 (自动)";
    orderHint.style.cssText = "color:#9a9a9a;font-size:11px;";
    opRow.appendChild(orderHint);
    box.appendChild(opRow);

    // V1.9 T2.6b R1: LoRA 库列表 picker (默认收起, 点 ➕ 展开)
    const picker = _buildLoraPicker();
    picker.style.display = "none";
    box.appendChild(picker);
    _pickerEl = picker;

    // V1.9 T2.5 R2: 模型/CLIP/VAE 切换面板 (在 LoRA 编排下方)
    box.appendChild(_buildOvSection());

    // 初始占位渲染
    _refreshList();
    return box;
}

// 主入口: 供 main.js openForm 调; 接 current 节点 + 已有 widget 文本
export async function initResourcesPanel(current, workflowPath, widgetText) {
    _currentNode = current ? current.node : null;
    _currentWorkflowPath = workflowPath || null;
    _resourcesList = deserializeResources(widgetText || "");
    // V1.9 T2.5 R2: 读 resource_overrides widget + 模板 loaders (供下拉当前值显示)
    let ovText = "{}";
    try { if (current && current.widgets && current.widgets.get) ovText = current.widgets.get("resource_overrides") || "{}"; }
    catch (_) { /* 容错 */ }
    _ovMap = deserializeOverrides(ovText);
    // V1.9 T4.4b: 读 lora_overrides widget → 回填模板行态 (覆写强度 / 已禁用灰显)
    let loText = "{}";
    try { if (current && current.widgets && current.widgets.get) loText = current.widgets.get("lora_overrides") || "{}"; }
    catch (_) { /* 容错 */ }
    _loraOverridesMap = deserializeLoraOverrides(loText);
    await _loadAndMergeTemplate(current, workflowPath);
    // V1.9 T2.5 R2: 异步拉取模板 loaders, 用于下拉默认显示 + 类型预检
    await _loadTemplateLoaders(workflowPath);
    if (_ovFieldsEl) _refreshOvSection();
    _refreshList();
    _persistAndDirty();
}

async function _loadTemplateLoaders(workflowPath) {
    if (!workflowPath) { _ldMap = { unet: null, clip: null, vae_video: null, vae_audio: null }; return; }
    try {
        const r = await api.fetchApi("/h3_batch/template_loras?workflow_path=" + encodeURIComponent(workflowPath));
        if (!r.ok) { _ldMap = { unet: null, clip: null, vae_video: null, vae_audio: null }; return; }
        const j = await r.json();
        const ld = (j && j.loaders) || {};
        _ldMap = { unet: ld.unet || null, clip: ld.clip || null, vae_video: ld.vae_video || null, vae_audio: ld.vae_audio || null };
    } catch (_) { _ldMap = { unet: null, clip: null, vae_video: null, vae_audio: null }; }
}


// ============================================================================
// 4. V1.10 批 3 T2: 资源编排换文件防呆 — 兼容规则纯函数 (与 batch_core.py 词表同源)
//
// 设计原则:
//   - 前端灰选是 fail-open: 只影响 UI 下拉构建, 不影响 API/MCP/引擎侧调用.
//     引擎 _apply_overrides 已按家族/词规则自校验 (PRD A3.1 钉死), 前端只是用户
//     防呆; 任何"API 直调不拦"的契约不许在 resources.js 加拦截代码.
//   - 词表常量与 batch_core.py 同源: ref2v/fl2v (unet 家族), video (vae_video),
//     audio (vae_audio), int8_convrot/uncensored (clip 坏件), minimax/h3 (clip 类型).
//   - UNet 双源家族: _ovMap.unet (已被用户覆写) 优先, 否则用 workflowPath basename.
//     由 resolveTemplateFamily 实现.
//   - 应用入口: applyCompatibilityRules(items, slotKey, ctx) → {options, greyCount, filterCount};
//     LoRA 槽的"非 .safetensors"按"排除"语义 (不入 options, 计入 filterCount);
//     其余槽按"灰选"语义 (保留选项, 设 disabled, 计入 greyCount).
// ============================================================================

// 词表 (与 batch_core.py 同源, 仅读对齐, 不改引擎)
const _UNET_MUTEX_WORDS = ["ref2v", "fl2v"];
const _VAE_VIDEO_WORD = "video";
const _VAE_AUDIO_WORD = "audio";
// V1.13 必修 4: 删除 _CLIP_BAD_TOKENS 文件名子串黑名单 — 误伤 UltraHeretic 那支
//   (其词嵌入无 convrot 声明, 不该灰). 判灰改读 /h3_batch/clip_health 端点实际声明.
const _CLIP_KIND_TOKENS = ["minimax", "h3"];
const _LORA_EXTS = [".safetensors"];

// V1.13 必修 4: CLIP 词嵌入层量化声明缓存 (Map<basename, true|false|null>)
//   - true  → 端点声明词嵌入层 convrot 量化 (实测坏件, 灰选)
//   - false → 端点声明无 convrot (合法, 不灰选)
//   - null  → 端点读失败/文件缺失/张目缺失 (降级不灰, 宁放过不误伤)
//   缓存未初始化 → 走旧 H3/minimax 类型检查 (保留兜底)
let _clipHealthCache = null;

export async function _loadClipHealth() {
    if (_clipHealthCache !== null) return _clipHealthCache;
    const m = new Map();
    try {
        const r = await fetch("/h3_batch/clip_health");
        if (!r || !r.ok) throw new Error("clip_health status " + (r && r.status));
        const j = await r.json();
        if (j && Array.isArray(j.files)) {
            for (const f of j.files) {
                if (f && typeof f.name === "string") {
                    m.set(f.name, f.embed_convrot);
                }
            }
        }
    } catch (e) {
        // 降级: 缓存空 Map — 后续判定全走 "无声明 → 不灰" 路径 (宁放过不误伤)
    }
    _clipHealthCache = m;
    return m;
}

// 红条文案 (含数量; 0/负数 → 空字符串 = 隐藏)
//   V1.10 批 3 T2 老板误读反馈: 红色警告样式让用户以为是出了错, 改为中性说明
//   — 明确传达"这是正常防呆不是错误"; 鼠标悬停灰选 option 可看具体原因.
const _RED_BANNER_PREFIX = " 个文件不适用于当前模板，已置灰（防误选提示，非报错；悬停灰项可看原因）";

// 内部: 小写家族判定 (与 batch_core._family_match 同口径 — 用 String.includes 而非 'in' 运算符,
//   'in' 要求右侧为对象; 字符串子串判定必须用 includes; .toLowerCase() 后小写比对)
function _familyMatch(nameLower) {
    const s = String(nameLower || "").toLowerCase();
    return {
        ref2v: s.includes(_UNET_MUTEX_WORDS[0]),
        fl2v: s.includes(_UNET_MUTEX_WORDS[1]),
    };
}

// 双源家族判定: ovUnet 优先 (已被用户覆写过的 unet 槽当前值),
//   否则从 workflowPath basename 抽家族词; 两源都空 → {ref2v:false, fl2v:false}
// 返回: {ref2v: bool, fl2v: bool}
//   两源都空时返回全 false — 调用方据此判定"无规则可套, 不灰选"
export function resolveTemplateFamily(ovUnet, workflowPath) {
    if (ovUnet && typeof ovUnet === "string" && ovUnet.trim()) {
        return _familyMatch(ovUnet);
    }
    if (workflowPath && typeof workflowPath === "string") {
        const base = workflowPath.split(/[\\/]/).pop() || "";
        // 去掉扩展名 (workflow 文件名常见 .json), 小写比对
        const noExt = base.replace(/\.[^.]+$/, "").toLowerCase();
        return _familyMatch(noExt);
    }
    return { ref2v: false, fl2v: false };
}

// 家族判定依据来源: 与 resolveTemplateFamily 同源逻辑, 单独导出便于 UI 文案标注.
//   返回: {source: 'override'|'template'|'none', sourceName: string}
//     - 'override': ovUnet 非空 (用户提供); sourceName = ovUnet
//     - 'template': workflowPath 非空; sourceName = basename 去扩展名
//     - 'none'    : 两源都空
//   V1.13 必修 3 (案甲): 语义与 resolveTemplateFamily 一致, 仅多返回来源标签; 不改
//   判定本身 (覆写优先于模板 — 与 resolveTemplateFamily 同款 if 顺序).
export function getFamilySource(ovUnet, workflowPath) {
    if (ovUnet && typeof ovUnet === "string" && ovUnet.trim()) {
        return { source: "override", sourceName: ovUnet };
    }
    if (workflowPath && typeof workflowPath === "string") {
        const base = workflowPath.split(/[\\/]/).pop() || "";
        const noExt = base.replace(/\.[^.]+$/, "").toLowerCase();
        return { source: "template", sourceName: noExt };
    }
    return { source: "none", sourceName: "" };
}

// 单 item 在指定 slot 下应否灰选 (含 LoRA 扩展名过滤 isFilter=true).
// slotKey ∈ {"unet", "clip", "vae_video", "vae_audio", "lora"}
// ctx = { templateFamily?: {ref2v,fl2v} } — 不传则视为无家族 (unet 不灰选)
// 返回: { disabled: bool, reason: string|null, isFilter: bool }
//   - disabled: true 表示灰选 (disabled option, 保留可见, 不可点)
//   - reason: 灰选/过滤原因 (UI title 悬停展示; 内部逻辑不依赖)
//   - isFilter: true 表示该 item 应从 dropdown 完全排除 (LoRA 扩展名); 此时 disabled=false
//   - 非法 filename (非字符串/空) → 全 false (不抛, 不灰, 不过滤)
export function isIncompatibleForSlot(slotKey, filename, ctx) {
    if (!filename || typeof filename !== "string") {
        return { disabled: false, reason: null, isFilter: false };
    }
    const nameLower = filename.toLowerCase();
    const ctxObj = ctx || {};

    // UNet 家族互斥
    if (slotKey === "unet") {
        const fam = ctxObj.templateFamily || { ref2v: false, fl2v: false };
        // 模板无任何家族词 → 无规则可套, 不灰选 (让用户随便选)
        if (!fam.ref2v && !fam.fl2v) {
            return { disabled: false, reason: null, isFilter: false };
        }
        const cur = fam.ref2v ? "ref2v" : (fam.fl2v ? "fl2v" : null);
        const itemFam = _familyMatch(nameLower);
        const item = itemFam.ref2v ? "ref2v" : (itemFam.fl2v ? "fl2v" : null);
        if (cur && item && cur !== item) {
            // V1.13 必修 3 (案甲): reason 文案如实标注判定依据来源, 两种来源各一版.
            //   - 覆写来源: '判定依据 = UNet 覆写〈文件名〉' + '清除覆写可切换家族' 提示
            //   - 模板来源: '判定依据 = 工作流模板〈模板名〉'
            const familySource = ctxObj.familySource
                || getFamilySource("", "") /* fallback: 双空, 文案降级 */
                || { source: "none", sourceName: "" };
            let reason;
            if (familySource.source === "override") {
                reason = "UNet 家族互斥 (判定依据 = UNet 覆写〈" + familySource.sourceName
                    + "〉; 当前 " + cur + ", 文件 " + item + "): " + filename
                    + ". 清除覆写可切换家族.";
            } else if (familySource.source === "template") {
                reason = "UNet 家族互斥 (判定依据 = 工作流模板〈" + familySource.sourceName
                    + "〉; 当前 " + cur + ", 文件 " + item + "): " + filename;
            } else {
                // source === "none" 或未知: 降级为旧文案 (不漏信息)
                reason = "UNet 家族互斥 (" + cur + " 模板 → " + item + " 文件): " + filename;
            }
            return {
                disabled: true,
                reason: reason,
                isFilter: false,
            };
        }
        return { disabled: false, reason: null, isFilter: false };
    }

    // CLIP: 端点 embed_convrot=true → 灰选 (实测坏件); false/null → 降级不灰
    if (slotKey === "clip") {
        // V1.13 必修 4: 端点缓存已加载 → 优先消费实际声明 (替代旧文件名启发式)
        //   缓存命中 (has=true)  → 用声明值: true 灰选, false/null 不灰
        //   缓存未命中 (端点未列该文件) → 走 H3/minimax 类型检查兜底
        if (_clipHealthCache !== null && _clipHealthCache.has(filename)) {
            const embed = _clipHealthCache.get(filename);
            if (embed === true) {
                return {
                    disabled: true,
                    reason: "CLIP 词嵌入层 convrot 量化（实测坏件）: " + filename,
                    isFilter: false,
                };
            }
            // embed === false 或 null → 降级不灰 (宁放过不误伤)
            return { disabled: false, reason: null, isFilter: false };
        }
        // 端点未加载/缓存为空/缓存未列该文件 → 走 H3/minimax 类型检查兜底
        let known = false;
        for (const tok of _CLIP_KIND_TOKENS) {
            if (nameLower.includes(tok)) { known = true; break; }
        }
        if (!known) {
            return {
                disabled: true,
                reason: "非 H3/minimax 类型: " + filename,
                isFilter: false,
            };
        }
        return { disabled: false, reason: null, isFilter: false };
    }

    // VAE 语义槽位: 按 slotKey 校验对应词 (不按家族词)
    if (slotKey === "vae_video") {
        if (!nameLower.includes(_VAE_VIDEO_WORD)) {
            return {
                disabled: true,
                reason: "vae_video 槽位要求 video 词: " + filename,
                isFilter: false,
            };
        }
        return { disabled: false, reason: null, isFilter: false };
    }
    if (slotKey === "vae_audio") {
        if (!nameLower.includes(_VAE_AUDIO_WORD)) {
            return {
                disabled: true,
                reason: "vae_audio 槽位要求 audio 词: " + filename,
                isFilter: false,
            };
        }
        return { disabled: false, reason: null, isFilter: false };
    }

    // LoRA: 按扩展名过滤 (非 .safetensors → 排除, 不入 options)
    if (slotKey === "lora") {
        const dotIdx = filename.lastIndexOf(".");
        const ext = (dotIdx >= 0) ? filename.slice(dotIdx).toLowerCase() : "";
        if (!_LORA_EXTS.includes(ext)) {
            return {
                disabled: false,
                reason: "LoRA 扩展名过滤 (非 .safetensors): " + filename,
                isFilter: true,
            };
        }
        return { disabled: false, reason: null, isFilter: false };
    }

    // 未知 slotKey → 不过滤 (扩展位)
    return { disabled: false, reason: null, isFilter: false };
}

// 在 items 上批量应用规则. 返回 {options, greyCount, filterCount}.
//   - options: [{file, disabled, reason}, ...] — 保持 items 顺序; LoRA 过滤项不入此
//   - greyCount: 灰选项数 (UI 红条计数用)
//   - filterCount: LoRA 过滤项数 (不入红条; 仅调试/日志)
//   非法 item (非对象/无 file) → 跳过
export function applyCompatibilityRules(items, slotKey, ctx) {
    const opts = [];
    let greyCount = 0;
    let filterCount = 0;
    if (!Array.isArray(items)) {
        return { options: opts, greyCount: 0, filterCount: 0 };
    }
    for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const f = it.file;
        if (typeof f !== "string" || !f) continue;
        const r = isIncompatibleForSlot(slotKey, f, ctx);
        if (r.isFilter) {
            filterCount++;
            continue;
        }
        opts.push({ file: f, disabled: r.disabled, reason: r.reason });
        if (r.disabled) greyCount++;
    }
    return { options: opts, greyCount: greyCount, filterCount: filterCount };
}

// 提示条文案: greyCount <= 0 → 空 (UI 隐藏); 否则 "N 个文件不适用于当前模板…" (中性防呆说明)
// 与 DOM 装配处 _refreshOvUI 中 _ovRedBannerEl.textContent 绑定, 单源 (DOM 与纯函数一致).
export function incompatibleBannerText(greyCount) {
    const n = (typeof greyCount === "number" && isFinite(greyCount)) ? greyCount : 0;
    if (n <= 0) return "";
    return n + _RED_BANNER_PREFIX;
}