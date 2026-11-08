// V1.9 D1 拆分: 绑定域 — 绑定面板/Subject 行注入/块拉取
// 依赖: main.js (state + utils)
import {
    _USAGE_KIND,
    castBindings, castBindingsPanelEl, castBindingsBlockCache,
    poolInputs, poolUsageSets, poolPillEls,
    globalPromptTa, assetsByName, current,
    schedulePreviewAll, toast, syncPillsVisual,
    sectionBox, setCastBindings, setCastBindingsPanelEl,
} from "./main.js";
import { api } from "../../../scripts/api.js";

// 批 A 节点 5 (5e): H3 交替式模板常量 — 与 batch_core._H3_SEG_ORDER/_H3_SEG_TAG/_H3_SEG_ATTR 逐字一致
// 段顺序: 外貌 → 三视图 → 服装 → 道具 → 姿势; 同 usage 多槽按 slot 升序合并; desc 空省 desc 文字段保留锚定句
// 与 batch_core._build_h3_subject_line 严格对拍 (test_parity_js.py 提取源即本文件)
// 1.11c 波2-T4: 三视图插于 subject_look 后 — 段序语义与 batch_core.py 同形
const _H3_SEG_ORDER_ZH = ["subject_look", "三视图", "subject_outfit", "subject_prop", "pose"];
const _H3_SEG_TAG_ZH = {
    subject_look: "外貌",
    "三视图": "三视图",
    subject_outfit: "服装",
    subject_prop: "道具",
    pose: "姿势",
};
const _H3_SEG_ATTR_ZH = {
    subject_look: "人物外貌",
    "三视图": "人物三视图",
    subject_outfit: "人物服装",
    subject_prop: "人物道具",
    pose: "人物姿势",
};

// ============================================================================
// 1. 数据读写
// ============================================================================

function readBindingsState() {
    return Array.isArray(castBindings) ? castBindings : [];
}

function nextBindingNo() {
    let max = 0;
    for (const b of castBindings) {
        if (typeof b === "object" && typeof b.no === "number" && b.no > max) max = b.no;
    }
    return max + 1;
}

// 批 H2-2 fix: 提取池快照 → [{idx, usage, media, desc}]
// 关键: idx 必须 = 真实物理池槽号
// desc 配对: card.rows 按 computeAssignResult 完全相同的跳过逻辑
function snapshotBindingSlotsFromResult(name, filled) {
    const card = assetsByName && assetsByName[name];
    if (!card || card._v !== 3 || card.kind !== "character") return [];
    if (!Array.isArray(filled)) return [];
    const rows = card.rows || [];
    const out = [];
    let filledPos = 0;
    // _USAGE_KIND 是 csv_form.js 模块级反向索引; computeAssignResult 也用它
    const kindOf = (typeof _USAGE_KIND !== "undefined") ? _USAGE_KIND : {};
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const media = (row.media || "").toString().trim();
        const usage = row.usage;
        const kind = kindOf[usage];
        // 跳过条件对齐 computeAssignResult:
        //   三条 "continue" 路径 (media 空 / kind 缺 / target 非法) — 不产 filled, 不消耗
        //   一条 "skipped.push + continue" 路径 (槽满跳过, assets.js:190) — 不产 filled, 不消耗
        // V1.13 波2 D5 fix: 第 4 条用 filled[filledPos].target/idx 对齐判定,
        //   不匹配 → 跳过当前 row (filledPos 不前进, 让下一行匹配后续 filled)
        if (!media) continue;
        if (!kind) continue;
        const target = parseInt((row.slot || "").toString(), 10);
        if (!target || target < 1) continue;
        // 配对下一个 consumed filled
        const f = filled[filledPos];
        if (!f) break;
        // 第 4 条跳过 (槽满): filled 此处的 target/idx 不属于本 row → 本 row 被跳过
        // coOccupy 兼容: f.target === row.target (顺延/共占都带原始 target)
        //                 或 f.idx === row.target (落到原 target 槽)
        if (f.target !== target && f.idx !== target) {
            continue;  // V1.13 波2 D5: 不消耗 filled, 让下一行匹配后续 filled
        }
        // 防御: 顺序对齐应保证 kind+value 匹配 — 若不匹配说明两侧 drift, 不阻塞
        // 批 H2-2 fix (批 H 真机对拍): media/desc/usage 一律走 row 侧 (当前 row 的真值),
        // idx/kind 走 f 侧 (真实物理池槽). 行/池两侧任一侧被污染 (例如 row.media 与 f.value 错位、
        // 或 row 在多处绑定间被共享引用) 都按 row 侧定稿, 避免测试1 的 image/features 串到测试2 条目
        out.push({
            idx: f.idx,                                // ← 真实物理池槽（含顺延/共占）
            kind: f.kind,                              // ← kind 来自计算结果, 供 onBindingSlotCleared 接线用
            usage: usage || ((f.usages && f.usages[0]) || ""),
            media: media || f.value || "",             // row 侧优先 (行内自描述最可信)
            desc: (row.desc || "").toString(),         // row 侧优先
            // 1.14a T5: 绑定快照 pose_style — 从卡行 row 取 (L2 修正: 不绕池, 路径乙独立闭环)
            pose_style: row.usage === "pose"
                ? (row.pose_style || "skeleton") : undefined,
        });
        filledPos++;
    }
    return out;
}

// ============================================================================
// 2. upsertBinding + Subject 行注入 (composeSubjectLineZh + injectSubjectLine)
// ============================================================================

// C3: 建立或更新绑定条目 (按 name)
// 同名卡再分配 = 更新 slots, 保号
// I-⑤: 建/更新绑定时, 全局提示词 textarea 追加/替换行 "<Subject {no}>: {合成句}"
function upsertBindingFromCard(name, slotSnapshots) {
    if (!name || !Array.isArray(slotSnapshots)) return;
    let existing = castBindings.find((b) => b && b.name === name);
    let entryNo = 0;
    if (existing) {
        existing.slots = slotSnapshots;
        entryNo = existing.no;
    } else {
        const newEntry = {
            name: name,
            no: nextBindingNo(),
            slots: slotSnapshots,
        };
        castBindings.push(newEntry);
        entryNo = newEntry.no;
    }
    // 批 H2-2 fix (批 H 真机对拍): 在 inp 上挂 _bindingOwner 元数据, 给 buildPoolCard 的
    // xBtn.onclick / input 清空监听提供"哪条 binding 哪个槽被清"信息 — 清池联动接线
    for (const s of slotSnapshots) {
        const inp = s && s.kind && poolInputs[s.kind] && poolInputs[s.kind][s.idx - 1];
        if (inp) {
            // 同槽跨卡: 后到的绑 (可能覆盖前绑; 上层 by-name 路径只跟一个 name, 不重叠)
            // 这里不强制检查, 由 onBindingSlotCleared 的 find 兼容
            inp._bindingOwner = { name: name, idx: s.idx };
        }
    }
    // I-⑤: 全局提示词注入/替换 Subject 行
    if (globalPromptTa && entryNo > 0) {
        injectSubjectLine(globalPromptTa, entryNo, name, slotSnapshots);
    }
    renderBindingsPanel();
    // 不进 schedulePreviewAll: C6 纪律 — 避免每键击风暴
}

// 批 A 节点 5 (5e): 合成 Subject 行 — H3 交替式 (zh), 与 batch_core._build_h3_subject_line 逐字对齐
// 段标签: 外貌/服装/道具/姿势; 锚定句: "人物<attr>, 以 <Picture M> 的人物<attr>为准"
// 段顺序固定 (按 _H3_SEG_ORDER_ZH); 同 usage 多槽按 idx 升序合并; 段间中文分号";"
// desc 空 → 【<tag>】<attr>, 以 <Picture M> 的<attr>为准 (省 desc 文字段, 锚定句保留)
// desc 非空 → 【<tag>】<desc>, <attr>, 以 <Picture M> 的<attr>为准
// 无 look 行 → 返回 null (与引擎 None 对齐, 由调用方决定整块跳过)
function composeSubjectLineZh(no, slots) {
    // 按 usage 分桶 (保卡内行序); 仅保留 H3 段落映射的四种 usage
    const buckets = {};
    for (const u of _H3_SEG_ORDER_ZH) buckets[u] = [];
    for (const s of (slots || [])) {
        if (!s) continue;
        const usage = s.usage;
        if (!(usage in buckets)) continue;
        const idx = (typeof s.idx === "number") ? s.idx : null;
        if (idx === null) continue;
        const desc = (typeof s.desc === "string") ? s.desc.trim() : "";
        buckets[usage].push({ idx: idx, desc: desc });
    }
    if (!buckets.subject_look.length) return null;  // 无 look 行 → 整块跳过 (与引擎 None 语义对齐)
    const seg_parts = [];
    for (const u of _H3_SEG_ORDER_ZH) {
        const arr = buckets[u].slice().sort((a, b) => a.idx - b.idx);  // 同 usage 按 idx 升序
        for (const item of arr) {
            const tag = _H3_SEG_TAG_ZH[u];
            const attr = _H3_SEG_ATTR_ZH[u];
            const picM = "<Picture " + item.idx + ">";
            if (item.desc) {
                seg_parts.push("【" + tag + "】" + item.desc + "，" + attr + "以 " + picM + " 的" + attr + "为准");  // 批 B-0 节点 0 修: 删 attr 后逗号
            } else {
                seg_parts.push("【" + tag + "】" + attr + "以 " + picM + " 的" + attr + "为准");  // 批 B-0 节点 0 修: 删 attr 后逗号
            }
        }
    }
    if (!seg_parts.length) return null;
    return "<Subject " + no + ">: " + seg_parts.join("；");
}

// 批 A 节点 5 (5e): 注入/替换 Subject 行 — 同名再分配先删旧行 (前缀匹配) 再追加
// composeSubjectLineZh 返回 null 时 (无 look 行, 与引擎 None 语义对齐) — 整块跳过
function injectSubjectLine(textarea, no, name, slots) {
    if (!textarea) return;
    const line = composeSubjectLineZh(no, slots);
    if (line === null) return;  // 无 look → 整块跳过 (与引擎 cast_blocks 对齐)
    const cur = textarea.value || "";
    const lines = cur.split("\n");
    const re = new RegExp("^\\s*<Subject\\s+" + no + ">:");
    // 过滤掉匹配行 (含其尾随空行, 与引擎逐镜过滤逻辑对齐 — 提示词清理后不留悬空白行)
    const kept = [];
    let skipNextBlank = false;
    for (const ln of lines) {
        if (skipNextBlank && ln.trim() === "") { skipNextBlank = false; continue; }
        skipNextBlank = false;
        if (re.test(ln)) { skipNextBlank = true; continue; }
        kept.push(ln);
    }
    // 追加新行 (末尾附一个空行分隔)
    if (kept.length && kept[kept.length - 1].trim() !== "") kept.push("");
    kept.push(line);
    kept.push("");  // 行尾追加空行
    textarea.value = kept.join("\n");
}

// ============================================================================
// 3. removeBinding + onBindingSlotCleared
// ============================================================================

// C3: 删除绑定条目 (✕ 按钮) + I-④: 联动清空素材池/全局提示词
function removeBinding(name) {
    const entry = castBindings.find((b) => b && b.name === name);
    if (!entry) return;  // 不存在 → no-op
    const slots = entry.slots || [];
    // ① 清素材池该绑定 slots (复用 xBtn 清空链路: inp.value=""+refreshThumb+用途 pill 清空+poolUsageSets 清)
    for (const s of slots) {
        if (!s || !s.kind || typeof s.idx !== "number") continue;
        const inp = poolInputs[s.kind] && poolInputs[s.kind][s.idx - 1];
        if (!inp) continue;
        inp.value = "";
        if (inp._refreshThumb) inp._refreshThumb();
        const set = poolUsageSets[s.kind] && poolUsageSets[s.kind][s.idx - 1];
        const pills = poolPillEls[s.kind] && poolPillEls[s.kind][s.idx - 1];
        if (set) {
            set.clear();
            if (pills) syncPillsVisual(pills, set);
        }
        if (inp._bindingOwner) delete inp._bindingOwner;
    }
    // ② 全局提示词删 Subject 行 (行前缀匹配: ^\s*<Subject {no}>: ...)
    if (globalPromptTa && typeof entry.no === "number") {
        const lines = (globalPromptTa.value || "").split("\n");
        const re = new RegExp("^\\s*<Subject\\s+" + entry.no + ">:");
        const filtered = lines.filter((ln) => !re.test(ln));
        // 保留空行 (避免破坏其他段落格式) — 仅剔除匹配行
        globalPromptTa.value = filtered.join("\n");
    }
    // 删条目
    setCastBindings(castBindings.filter((b) => b && b.name !== name));
    // ③ invalidateCastBlockCache(name)
    invalidateCastBlockCache(name);
    // ④ schedulePreviewAll (400ms 防抖)
    if (typeof schedulePreviewAll === "function") schedulePreviewAll();
    renderBindingsPanel();
    // ⑤ toast
    toast("success", "H3 绑定", "已解除绑定并清理素材池/提示词: " + name);
}

// 注: onBindingSlotCleared 在 main.js (cycle-break 集中点, 给 pool.js 跨域调用)

// ============================================================================
// 4. fetchCastBlock + invalidateCastBlockCache + _slotsFingerprint
// ============================================================================

function _slotsFingerprint(slots) {
    if (!Array.isArray(slots)) return "";
    const norm = slots.slice().sort((a, b) => (a.idx || 0) - (b.idx || 0))
        .map((s) => [s.idx, s.usage, s.media, s.desc || ""].join("|"));
    return norm.join(";");
}

async function fetchCastBlock(name, lang) {
    const entry = castBindings.find((b) => b && b.name === name);
    if (!entry) {
        // 批 H2-2 fix (批 H 真机对拍): 静默 null 改为可见 toast —
        // 端点 404/500 静默失败让面板"展开"按钮无反应的伪象, 用户不知哪里出错
        toast("error", "H3 绑定", "找不到绑定条目: " + name + " (可能已被移除, 先重新分配)");
        return null;
    }
    const fp = _slotsFingerprint(entry.slots);
    const cacheKey = name + "|" + (lang || "zh") + "|" + fp;
    const cached = castBindingsBlockCache.get(cacheKey);
    if (cached) return cached;
    try {
        const r = await api.fetchApi("/h3_batch/cast_block", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: entry.name, no: entry.no, slots: entry.slots, lang: lang || "zh" }),
        });
        if (!r.ok) {
            toast("error", "H3 绑定", "块拉取失败 HTTP " + r.status + " (" + name + "); 端点是否未部署? 重启 ComfyUI 后生效");
            return null;
        }
        const j = await r.json();
        if (j && j.error) {
            toast("error", "H3 绑定", "块拉取失败: " + j.error + " (" + name + ")");
            return null;
        }
        const out = { blocks: j.blocks || [], fingerprint: !!j.fingerprint };
        castBindingsBlockCache.set(cacheKey, out);
        return out;
    } catch (e) {
        toast("error", "H3 绑定", "块拉取异常 (" + name + "): " + (e && e.message ? e.message : e));
        return null;
    }
}

function invalidateCastBlockCache(name) {
    for (const k of Array.from(castBindingsBlockCache.keys())) {
        if (k.startsWith(name + "|")) castBindingsBlockCache.delete(k);
    }
}

// ============================================================================
// 5. renderBindingsPanel + bindCastBindingsPanelEl
// ============================================================================

function renderBindingsPanel() {
    const el = castBindingsPanelEl;
    if (!el) return;
    el.innerHTML = "";
    if (!castBindings.length) {
        const tip = document.createElement("div");
        tip.style.cssText = "padding:6px 10px;background:rgba(255,255,255,.03);border:1px dashed #666;border-radius:3px;font-size:12px;color:#999;margin-bottom:10px;";
        tip.textContent = "暂无绑定 — 在下方为本批角色卡点分配即自动绑定 (prompt 中直接写档案名驱动)";
        el.appendChild(tip);
        return;
    }
    for (const b of castBindings) {
        const card = document.createElement("div");
        card.style.cssText = "padding:6px 10px;background:rgba(255,255,255,.05);border:1px solid #555;border-radius:3px;margin-bottom:6px;";
        const head = document.createElement("div");
        head.style.cssText = "display:flex;align-items:center;gap:8px;";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = "[" + (b.name || "") + " = Subject " + b.no + "]";
        head.appendChild(nameSpan);
        const rm = document.createElement("button");
        rm.textContent = "✕";
        rm.style.cssText = "padding:1px 6px;cursor:pointer;background:#3a3a3e;color:#f88;border:1px solid #f88;border-radius:3px;";
        rm.title = "移除绑定 (不清素材池)";
        rm.onclick = () => {
            // I-④: removeBinding 自身已清池 + 删 Subject 行 + invalidate cache + schedule preview + toast
            removeBinding(b.name);
        };
        head.appendChild(rm);
        // 展开/收起
        const toggle = document.createElement("button");
        toggle.textContent = "展开";
        toggle.style.cssText = "padding:1px 6px;cursor:pointer;background:#3a3a3e;color:#80c0ff;border:1px solid #80c0ff;border-radius:3px;";
        const body = document.createElement("div");
        body.style.cssText = "margin-top:6px;font-size:12px;color:#ccc;display:none;white-space:pre-wrap;";
        head.appendChild(toggle);
        card.appendChild(head);
        card.appendChild(body);
        toggle.onclick = async () => {
            if (body.style.display === "none") {
                body.style.display = "block";
                toggle.textContent = "收起";
                body.textContent = "[加载中…]";
                const r = await fetchCastBlock(b.name, "zh");
                if (!r) { body.textContent = "（块拉取失败）"; return; }
                if (r.fingerprint) body.textContent = "[! 档案已变化, 建议重新分配]\n" + (r.blocks || []).join("\n");
                else body.textContent = (r.blocks || []).join("\n");
            } else {
                body.style.display = "none";
                toggle.textContent = "展开";
            }
        };
        el.appendChild(card);
    }
}

function bindCastBindingsPanelEl(el) {
    setCastBindingsPanelEl(el);
    renderBindingsPanel();
}

// ============================================================================
// 6. 跨域导出
// ============================================================================

export {
    readBindingsState, nextBindingNo, snapshotBindingSlotsFromResult,
    upsertBindingFromCard, composeSubjectLineZh, injectSubjectLine,
    removeBinding,
    _slotsFingerprint, fetchCastBlock, invalidateCastBlockCache,
    renderBindingsPanel, bindCastBindingsPanelEl,
};