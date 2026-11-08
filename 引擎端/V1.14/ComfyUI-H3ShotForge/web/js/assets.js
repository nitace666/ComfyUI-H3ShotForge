// V1.9 D1 拆分: 资产库域 — 列表/建档/导入/删除/分配器/恢复损坏
// 依赖: main.js (state + utils) + bindings.js (binding 函数) + pool.js (覆盖按钮)
import {
    POOL_KEYS, POOL_SLOTS, POOL_EXTS,
    USAGE_OPTIONS, USAGE_BY_KIND, _USAGE_KIND,
    poolInputs, poolUsageSets, poolPillEls,
    assetsListEl, assetsListErrEl, assetsKindRadios,
    assignRoleSelect, assignSceneSelect,
    assetsByName, editingCard, editArchiveHandler,
    globalPromptTa, modeRadios,
    schedulePreviewAll, toast, syncPillsVisual,
    setAssetsListEl, setAssetsListErrEl, setAssignRoleSelect, setAssignSceneSelect,
    setAssetsByName, setEditingCard, setEditArchiveHandler,
    collectData, fillForm, buildShotRow, switchTab,
    ensureMediaInLibrary, sectionBox, h3ComputeRectFromDrag, current,
    snapshotFormState, applyStateToFormDOM,
    buildV3CardPayload,
    USAGE_SHORT_LABEL,
} from "./main.js";
import {
    upsertBindingFromCard, snapshotBindingSlotsFromResult,
    invalidateCastBlockCache, renderBindingsPanel, bindCastBindingsPanelEl,
} from "./bindings.js";
import { castBindings, castBindingsBlockCache, castBindingsPanelEl } from "./main.js";
import { attachOverrideButton, buildPoseStyleToggle } from "./pool.js";
import { openPicker } from "./path_picker.js";
import { api } from "../../../scripts/api.js";

// ============================================================================
// 1. 纯函数 — 决策/计算 (无 DOM 依赖)
// ============================================================================

// 纯: 从 collectData() 快照构造 POST body
function buildSaveCardPayload(name, kind, data) {
    const card = { label: name, kind: kind, prompt: (data.globals && data.globals["提示词"]) || "" };
    const slots = {};
    const pool_usage = {};
    for (const k of POOL_KEYS) {
        const src = (data.pool && data.pool[k]) || {};
        const usageSrc = (data.pool_usage && data.pool_usage[k]) || {};
        const ks = {};
        const ku = {};
        for (const [idx, v] of Object.entries(src)) {
            if (v && String(v).trim()) ks[String(idx)] = String(v);
        }
        // 悬空 usage 丢弃 (无图槽的用途不落键)
        for (const idx of Object.keys(ks)) {
            const u = usageSrc[idx];
            if (u && u.length) ku[idx] = u;
        }
        slots[k] = ks;
        pool_usage[k] = ku;
    }
    card.slots = slots;
    card.pool_usage = pool_usage;
    return { name: name, card: card };
}

// 纯: 决定每个槽位 filled / skipped; 拼接模式 + Picture 9 → pic9Warn
function computeImportResult(card, currentPool, mode) {
    const filled = [];
    const skipped = [];
    let pic9Warn = false;
    for (const kind of POOL_KEYS) {
        const slots = (card && card.slots && card.slots[kind]) || {};
        const usages = (card && card.pool_usage && card.pool_usage[kind]) || {};
        for (const [idxStr, value] of Object.entries(slots)) {
            const idx = parseInt(idxStr, 10);
            if (!value || !String(value).trim()) continue;
            const slotUsages = Array.isArray(usages[idxStr]) ? usages[idxStr] : [];
            const occupied = currentPool[kind] && currentPool[kind][idxStr] && String(currentPool[kind][idxStr]).trim();
            if (occupied) {
                // 跳过 — 用法预设也不勾 (防悬空)
                skipped.push({ kind: kind, idx: idx, value: value, usages: slotUsages });
            } else {
                filled.push({ kind: kind, idx: idx, value: value, usages: slotUsages });
            }
        }
    }
    if (mode === "拼接" && card && card.slots && card.slots.Picture && card.slots.Picture["9"] && String(card.slots.Picture["9"]).trim()) {
        pic9Warn = true;
    }
    return { filled: filled, skipped: skipped, pic9Warn: pic9Warn };
}

// 纯: 提示词拼接
function appendPromptText(current, addition) {
    const c = String(current || "").trim();
    const a = String(addition || "").trim();
    if (!a) return current || "";
    if (!c) return a;
    if (c.endsWith(", ")) return c + a;
    if (c.endsWith(",")) return c + " " + a;
    return c + ", " + a;
}

// T8 批3 (任务⑥): v3 分配 — 行级槽位冲突检测
function detectRowConflicts(rows) {
    const conflicts = [];
    if (!Array.isArray(rows)) return conflicts;
    for (let i = 0; i < rows.length; i++) {
        const a = rows[i] || {};
        const aMedia = (a.media || "").toString().trim();
        if (!aMedia) continue;
        const aKind = _USAGE_KIND[a.usage];
        if (!aKind) continue;
        const aSlot = (a.slot || "").toString();
        if (!aSlot) continue;
        for (let j = i + 1; j < rows.length; j++) {
            const b = rows[j] || {};
            const bMedia = (b.media || "").toString().trim();
            if (!bMedia) continue;
            const bKind = _USAGE_KIND[b.usage];
            if (!bKind) continue;
            const bSlot = (b.slot || "").toString();
            if (!bSlot) continue;
            if (aKind === bKind && aSlot === bSlot) {
                conflicts.push(i);
                conflicts.push(j);
            }
        }
    }
    const seen = new Set();
    const out = [];
    for (const x of conflicts) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
    return out;
}

// T8 批3 (任务⑥): v3 档案 — rows 驱动的 filled/skipped 决策
function computeAssignResult(card, currentPool) {
    const filled = [];
    const skipped = [];
    if (!card || !Array.isArray(card.rows)) return { filled: filled, skipped: skipped };
    const maxSlots = (typeof POOL_SLOTS !== "undefined" && POOL_SLOTS) ? POOL_SLOTS : { Picture: 9, Video: 3, Audio: 3 };
    // 已填集合: 本函数内已落池的槽 (行序先到先得)
    const filledSet = {};  // {kind: Set<int>}
    const ensureKind = (k) => { if (!filledSet[k]) filledSet[k] = new Set(); return filledSet[k]; };
    const isSlotTaken = (kind, slot) => {
        const inPool = currentPool[kind] && currentPool[kind][String(slot)] && String(currentPool[kind][String(slot)]).trim();
        return !!inPool || (filledSet[kind] && filledSet[kind].has(slot));
    };
    // B4 修订: 已填集合中查找 同 kind + 同 media 的行, 返回该行的实际 idx (不限槽号); 找不到返回 0
    // 与"不同图不同卡顺延互避"不冲突: media 不同 → 该函数返 0 → 走原三分支
    const findSameMediaFilledIdx = (kind, media) => {
        for (const f of filled) {
            if (f.kind === kind && f.value === media) return f.idx;
        }
        return 0;
    };
    for (const row of card.rows) {
        const media = (row && row.media || "").toString().trim();
        if (!media) continue;  // B4: media 空行不触碰池槽
        const slot = (row.slot || "").toString();
        const usage = row.usage;
        const kind = _USAGE_KIND[usage];
        if (!kind) continue;
        const slotUsages = [usage];
        const target = parseInt(slot, 10);
        // 卡内槽号非法 (NaN/≤0) → 按 B4 兜底跳过, 不强行落 1
        if (!target || target < 1) {
            skipped.push({ kind: kind, idx: target || 0, target: target || 0, value: media, usages: slotUsages });
            continue;
        }
        const max = maxSlots[kind] || 9;
        // 目标槽为空 且 不在本次已填集合 → 直接填 target
        if (!isSlotTaken(kind, target)) {
            filled.push({ kind: kind, idx: target, target: target, value: media, usages: slotUsages });
            ensureKind(kind).add(target);
            continue;
        }
        // B4 修订: 已填集合中是否已存在 同 kind + 同 media 行? → 共占该行的 idx
        // (泛化: 覆盖原"target 槽被本次已填行占用且同图"的窄义; 跨槽同图也能命中)
        const coOccupyIdx = findSameMediaFilledIdx(kind, media);
        if (coOccupyIdx > 0) {
            filled.push({ kind: kind, idx: coOccupyIdx, target: target, value: media, usages: slotUsages });
            // 不重复 add idx (coOccupyIdx 必在 filledSet 中, 由前期行 add 进去)
            continue;
        }
        // 否则向后顺延: target+1 .. max 找首个"空且不在已填集合"
        let chosen = 0;
        for (let s = target + 1; s <= max; s++) {
            if (!isSlotTaken(kind, s)) { chosen = s; break; }
        }
        if (chosen > 0) {
            filled.push({ kind: kind, idx: chosen, target: target, value: media, usages: slotUsages });
            ensureKind(kind).add(chosen);
            continue;
        }
        // 找不到空槽 → skipped (保留覆盖按钮路径)
        skipped.push({ kind: kind, idx: target, target: target, value: media, usages: slotUsages });
    }
    return { filled: filled, skipped: skipped };
}

// T8 批3 (任务⑥): v3 档案 — 纯函数 assignArchiveToForm(card, state) → 新 state
function assignArchiveToForm(card, state) {
    const basePool = (state && state.pool) || { Picture: {}, Video: {}, Audio: {} };
    const baseUsage = (state && state.pool_usage) || { Picture: {}, Video: {}, Audio: {} };
    const basePrompt = (state && state.globalPrompt) || "";
    const curPool = { Picture: Object.assign({}, basePool.Picture || {}), Video: Object.assign({}, basePool.Video || {}), Audio: Object.assign({}, basePool.Audio || {}) };
    const curUsage = { Picture: Object.assign({}, baseUsage.Picture || {}), Video: Object.assign({}, baseUsage.Video || {}), Audio: Object.assign({}, baseUsage.Audio || {}) };
    const r = computeAssignResult(card, curPool);
    for (const f of r.filled) {
        curPool[f.kind][String(f.idx)] = f.value;
        if (f.usages && f.usages.length) curUsage[f.kind][String(f.idx)] = f.usages.slice();
    }
    let newPrompt = basePrompt;
    if (card && Array.isArray(card.rows)) {
        for (const row of card.rows) {
            const desc = (row && row.desc || "").toString().trim();
            if (!desc) continue;
            // 去重: desc 已被当前提示词包含 → 跳过该行
            if (newPrompt.indexOf(desc) !== -1) continue;
            newPrompt = appendPromptText(newPrompt, desc);
        }
    }
    return { pool: curPool, pool_usage: curUsage, globalPrompt: newPrompt, filled: r.filled, skipped: r.skipped };
}

// 批 H3 卫生: 绑定卡分配 (C2 跳过 desc 追加) resultNoDesc 封装抽 helper
function assignArchiveToFormNoDesc(card, state) {
    const basePool = (state && state.pool) || { Picture: {}, Video: {}, Audio: {} };
    const baseUsage = (state && state.pool_usage) || { Picture: {}, Video: {}, Audio: {} };
    const curPool = { Picture: Object.assign({}, basePool.Picture || {}),
                      Video: Object.assign({}, basePool.Video || {}),
                      Audio: Object.assign({}, basePool.Audio || {}) };
    const curUsage = { Picture: Object.assign({}, baseUsage.Picture || {}),
                        Video: Object.assign({}, baseUsage.Video || {}),
                        Audio: Object.assign({}, baseUsage.Audio || {}) };
    const r = (typeof computeAssignResult === "function")
        ? computeAssignResult(card, curPool) : { filled: [], skipped: [] };
    for (const f of r.filled) {
        curPool[f.kind][String(f.idx)] = f.value;
        if (f.usages && f.usages.length) curUsage[f.kind][String(f.idx)] = f.usages.slice();
    }
    return {
        pool: curPool,
        pool_usage: curUsage,
        globalPrompt: (state && state.globalPrompt) || "",  // C2: 跳过 desc 追加
        filled: r.filled,
        skipped: r.skipped,
    };
}

// ============================================================================
// 2. 资产库面板 — 构建/列表/错误位
// ============================================================================

// 构建资产库 tab pane 内部结构 (保存栏 + 列表 + 错误位 + 刷新按钮)
function buildAssetsSection() {
    const box = sectionBox("资产库 (角色/场景卡 — 跨 CSV 复用素材 + 提示词预设)");

    // 批 H2-2: 绑定面板 (建卡区上方) — 条目「[名 = Subject N] ✕」+ 块只读展开
    const bindingsPanel = document.createElement("div");
    bindingsPanel.id = "h3-cast-bindings-panel";
    bindingsPanel.style.cssText = "margin-bottom:12px;";
    box.appendChild(bindingsPanel);
    bindCastBindingsPanelEl(bindingsPanel);

    // T3: 层3 分配器 (顶部, 在 v1 保存栏之上) — 「本批角色」「本批场景」下拉 + 「分配到表单」按钮
    const assignerRow = document.createElement("div");
    assignerRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:8px;background:rgba(80,160,255,.08);border:1px dashed #80c0ff;border-radius:4px;";
    const roleSel = document.createElement("select");
    roleSel.style.cssText = "padding:4px 8px;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;";
    roleSel.appendChild(new Option("本批角色 ▼", "", true, true));
    roleSel.disabled = true;
    const sceneSel = document.createElement("select");
    sceneSel.style.cssText = roleSel.style.cssText;
    sceneSel.appendChild(new Option("本批场景 ▼", "", true, true));
    sceneSel.disabled = true;
    setAssignRoleSelect(roleSel);
    setAssignSceneSelect(sceneSel);
    const assignBtn = document.createElement("button");
    assignBtn.textContent = "分配到表单";
    assignBtn.style.cssText = "padding:6px 14px;cursor:pointer;background:#3a3a3e;color:#80c0ff;border:1px solid #80c0ff;border-radius:3px;";
    assignBtn.onclick = () => applyTopAssignmentToForm();
    assignerRow.appendChild(document.createTextNode("层3 分配:"));
    const roleLab = document.createElement("label");
    roleLab.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;";
    roleLab.appendChild(roleSel);
    assignerRow.appendChild(roleLab);
    const sceneLab = document.createElement("label");
    sceneLab.style.cssText = roleLab.style.cssText;
    sceneLab.appendChild(sceneSel);
    assignerRow.appendChild(sceneLab);
    assignerRow.appendChild(assignBtn);
    box.appendChild(assignerRow);

    // 保存栏: 卡名 + kind 二选一 + 保存按钮 (空名禁用)
    const saveRow = document.createElement("div");
    saveRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:8px;background:rgba(255,255,255,.03);border:1px dashed #666;border-radius:4px;";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "卡名 (1-64 字符)";
    nameInput.maxLength = 64;
    nameInput.style.cssText = "flex:1;min-width:160px;padding:4px 8px;box-sizing:border-box;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;";

    const kindChar = document.createElement("input");
    kindChar.type = "radio";
    kindChar.name = "h3_asset_kind";
    kindChar.value = "character";
    kindChar.checked = true;
    assetsKindRadios.push(kindChar);
    const kindCharLab = document.createElement("label");
    kindCharLab.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;";
    kindCharLab.appendChild(kindChar);
    kindCharLab.appendChild(document.createTextNode("角色"));

    const kindScene = document.createElement("input");
    kindScene.type = "radio";
    kindScene.name = "h3_asset_kind";
    kindScene.value = "scene";
    assetsKindRadios.push(kindScene);
    const kindSceneLab = document.createElement("label");
    kindSceneLab.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;";
    kindSceneLab.appendChild(kindScene);
    kindSceneLab.appendChild(document.createTextNode("场景"));

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "保存当前为资产";
    saveBtn.style.cssText = "padding:6px 14px;cursor:pointer;background:#3a3a3e;color:#f0a040;border:1px solid #f0a040;border-radius:3px;";
    const updateSaveBtn = () => { saveBtn.disabled = !nameInput.value.trim(); };
    nameInput.addEventListener("input", updateSaveBtn);
    updateSaveBtn();
    saveBtn.onclick = () => {
        const kind = kindChar.checked ? "character" : "scene";
        saveCardAsAsset(nameInput.value.trim(), kind);
    };

    saveRow.appendChild(nameInput);
    saveRow.appendChild(kindCharLab);
    saveRow.appendChild(kindSceneLab);
    saveRow.appendChild(saveBtn);
    box.appendChild(saveRow);

    // T8 批3 (任务⑤): v3 档案表单 (在 v1 保存栏之后; 独立区块, 不复用 v1 kind radios / 不动 v1 路径)
    box.appendChild(buildV3ArchiveForm());

    // 列表容器
    const listWrap = document.createElement("div");
    listWrap.id = "h3_assets_list";
    box.appendChild(listWrap);
    setAssetsListEl(listWrap);

    // 错误位
    const errEl = document.createElement("div");
    errEl.id = "h3_assets_err";
    errEl.style.cssText = "color:#d32f2f;font-size:12px;margin-top:6px;display:none;";
    box.appendChild(errEl);
    setAssetsListErrEl(errEl);

    // 刷新按钮
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "🔄 刷新资产列表";
    reloadBtn.style.cssText = "margin-top:8px;padding:4px 10px;cursor:pointer;font-size:11px;";
    reloadBtn.onclick = loadAssets;
    box.appendChild(reloadBtn);

    return box;
}

// 拉取资产库 (GET /h3_batch/assets)
async function loadAssets() {
    if (!assetsListEl) return;  // 资产 tab 尚未构建
    try {
        const r = await api.fetchApi("/h3_batch/assets");
        const j = await r.json();
        renderAssetList(j.assets || {}, j.error || "");
    } catch (e) {
        renderAssetList({}, "网络错误: " + (e && e.message ? e.message : e));
    }
}

// 渲染列表: 损坏时显示错误行 + 空库; 正常时每卡一行
function renderAssetList(assets, errorMsg) {
    if (!assetsListEl) return;
    assetsListEl.innerHTML = "";
    // 库变了, 所有绑定条目块缓存失效 (fingerprint 重算)
    castBindingsBlockCache.clear();
    // 批 A 节点 5 (5a): 原 D1 刷新出场角色 datalist 步骤下线
    setAssetsByName(assets || {});
    refreshAssignDropdowns(assetsByName);
    // 移除残留的恢复按钮行 (批3 审核修复: 反复刷新累积多行按钮 + reset 成功后
    // 健康分支走此函数时不删旧行导致残留可见可点). 按固定标记 querySelector
    // 后 removeChild, 与损坏态新建按钮行使用同一标记 data-h3-recovery-actions.
    const existingActions = assetsListErrEl.parentNode.querySelector('[data-h3-recovery-actions]');
    if (existingActions) existingActions.parentNode.removeChild(existingActions);
    if (errorMsg) {
        assetsListErrEl.textContent = "⚠ 资产文件损坏: " + errorMsg;
        assetsListErrEl.style.display = "";
        // 资产库损坏自助恢复: 两按钮 — 备份损坏文件 (原样保留) / 重置为空库 (自动备份, 数据不丢).
        // 仅在已确认损坏时显示, 健康库不出现. 二次点击确认式沿用停止按钮 (:268-293) 3 秒未点第二次恢复.
        const actions = document.createElement("div");
        actions.setAttribute("data-h3-recovery-actions", "1");
        actions.style.cssText = "display:flex;gap:8px;margin-top:6px;";
        const backupBtn = document.createElement("button");
        backupBtn.textContent = "备份损坏文件";
        backupBtn.style.cssText = "padding:6px 14px;cursor:pointer;";
        backupBtn.onclick = () => recoverCorruptAssets("backup", backupBtn);
        actions.appendChild(backupBtn);
        const resetBtn = document.createElement("button");
        resetBtn.textContent = "重置为空库";
        resetBtn.style.cssText = "padding:6px 14px;cursor:pointer;";
        resetBtn.onclick = () => recoverCorruptAssets("reset", resetBtn);
        actions.appendChild(resetBtn);
        assetsListErrEl.parentNode.insertBefore(actions, assetsListErrEl.nextSibling);
    } else {
        assetsListErrEl.textContent = "";
        assetsListErrEl.style.display = "none";
    }
    const names = Object.keys(assets || {}).sort();
    if (!names.length) {
        const empty = document.createElement("div");
        empty.textContent = errorMsg ? "(空库 — 资产文件已损坏, 请先修复)" : "暂无资产卡; 在素材池/全局参数 tab 摆好素材后, 在上方填卡名保存";
        empty.style.cssText = "color:#888;font-size:12px;padding:12px;text-align:center;";
        assetsListEl.appendChild(empty);
        return;
    }
    // I-⑥: 档案库 (v3 档案卡) / 资产库 (v1 旧资产卡) 分区渲染 — 各节空时显示各自空态
    const v3Names = names.filter((n) => assets[n] && assets[n]._v === 3);
    const v1Names = names.filter((n) => !assets[n] || assets[n]._v !== 3);
    const renderSectionHeader = (title) => {
        const hdr = document.createElement("div");
        hdr.style.cssText = "font-size:11px;font-weight:700;color:#888;margin-top:8px;margin-bottom:4px;padding:2px 4px;border-bottom:1px dashed #555;";
        hdr.textContent = title;
        return hdr;
    };
    const renderSectionEmpty = (msg) => {
        const empty = document.createElement("div");
        empty.textContent = msg;
        empty.style.cssText = "color:#888;font-size:12px;padding:8px;text-align:center;font-style:italic;";
        return empty;
    };
    // 档案库节
    assetsListEl.appendChild(renderSectionHeader("档案库（v3 档案卡）"));
    if (!v3Names.length) {
        assetsListEl.appendChild(renderSectionEmpty("(无档案) 在上方建卡表单新建"));
    } else {
        for (const name of v3Names) assetsListEl.appendChild(buildAssetRow(name, assets[name]));
    }
    // 资产库节
    assetsListEl.appendChild(renderSectionHeader("资产库（v1 旧资产卡）"));
    if (!v1Names.length) {
        assetsListEl.appendChild(renderSectionEmpty("(无旧资产) 旧 v1/v2 集中显示"));
    } else {
        for (const name of v1Names) assetsListEl.appendChild(buildAssetRow(name, assets[name]));
    }
}

// 资产库损坏自助恢复
let _recoverResetArmed = null;
async function recoverCorruptAssets(action, btn) {
    if (action === "reset" && !_recoverResetArmed) {
        btn.textContent = "确认重置?";
        btn.style.color = "#e5534b";
        _recoverResetArmed = setTimeout(() => {
            _recoverResetArmed = null;
            btn.textContent = "重置为空库";
            btn.style.color = "";
        }, 3000);
        return;
    }
    if (action === "reset") {
        clearTimeout(_recoverResetArmed);
        _recoverResetArmed = null;
        btn.textContent = "重置为空库";
        btn.style.color = "";
    }
    try {
        const r = await api.fetchApi("/h3_batch/assets/recovery", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: action }),
        });
        const j = await r.json();
        if (!r.ok || j.error) {
            toast("error", "H3 资产恢复", (j.error || ("HTTP " + r.status)));
            return;
        }
        if (action === "backup") {
            toast("success", "H3 资产恢复", "已备份到: " + j.backup);
        } else {
            toast("success", "H3 资产恢复", "已重置为空库 (备份: " + j.backup + ")");
            loadAssets();  // 刷新列表 (损坏态 → 健康态)
        }
    } catch (e) {
        toast("error", "H3 资产恢复", (e && e.message ? e.message : e));
    }
}

// T8 批3 (任务⑥): 层3 分配器下拉
function refreshAssignDropdowns(assets) {
    function fill(sel, kind, label) {
        if (!sel) return;
        sel.innerHTML = "";
        sel.appendChild(new Option(label, "", true, true));
        let n = 0;
        for (const name of Object.keys(assets || {}).sort()) {
            const c = assets[name];
            if (!c || c._v !== 3 || c.kind !== kind) continue;
            sel.appendChild(new Option(name + " (" + (c.label || "") + ")", name));
            n++;
        }
        sel.disabled = n === 0;  // 无档案时下拉禁用, 按钮无意义
    }
    fill(assignRoleSelect, "character", "本批角色 ▼");
    fill(assignSceneSelect, "scene", "本批场景 ▼");
}

// 单卡行: 缩略图 + 名称/label + 类型徽标 + 导入 + 删除
function buildAssetRow(name, card) {
    const row = document.createElement("div");
    row.dataset.cardName = name;
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #555;border-radius:4px;margin-bottom:4px;background:rgba(255,255,255,.03);";

    // 缩略图: v3 卡 → rows 首个有 media 的行 (Picture 或 Video 都取); v2/v1 → 原 slots.Picture 1→9
    // T9 v2 建议11: 放宽为"首个有 media 的行" — 纯视频档案也能显示首帧
    const thumbWrap = document.createElement("div");
    thumbWrap.style.cssText = "position:relative;width:48px;height:36px;flex:none;background:#1a1a1e;border:1px solid #555;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center;";
    const placeholder = document.createElement("span");
    placeholder.textContent = "无图";
    placeholder.style.cssText = "color:#666;font-size:10px;";
    thumbWrap.appendChild(placeholder);
    let firstPic = "";
    if (card && card._v === 3 && Array.isArray(card.rows)) {
        for (const row of card.rows) {
            const media = (row && row.media || "").toString().trim();
            if (media && _USAGE_KIND[row.usage] !== "Audio") { firstPic = media; break; }
        }
    } else {
        const picSlots = (card && card.slots && card.slots.Picture) || {};
        for (let i = 1; i <= 9; i++) {
            if (picSlots[String(i)] && picSlots[String(i)].trim()) { firstPic = picSlots[String(i)]; break; }
        }
    }
    if (firstPic) {
        const img = document.createElement("img");
        img.alt = name;
        img.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
        img.src = "/h3_batch/thumb?path=" + encodeURIComponent(firstPic);
        img.onload = () => { img.style.display = ""; placeholder.style.display = "none"; };
        img.onerror = () => { img.remove(); placeholder.textContent = "无图"; };  // 404 → 占位符 (不炸)
        thumbWrap.appendChild(img);
    }

    // 名称 + label
    const text = document.createElement("div");
    // I-③: 长文件名布局修复 — min-width:0 + overflow:hidden + text-overflow:ellipsis + white-space:nowrap (经典 flex 收缩修复)
    text.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px;min-width:0;overflow:hidden;";
    const nameSpan = document.createElement("div");
    nameSpan.textContent = name;
    nameSpan.title = name;  // I-③: 全名 tooltip (避免 ellipsis 后看不到完整名)
    nameSpan.style.cssText = "font-weight:700;color:#e6e6e6;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const labelSpan = document.createElement("div");
    labelSpan.textContent = (card && card.label) || "";
    labelSpan.title = (card && card.label) || "";
    labelSpan.style.cssText = "font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;";
    text.appendChild(nameSpan);
    text.appendChild(labelSpan);
    // I-②: 备注灰字显示 — 在 label 行下附 (有则显示)
    if (card && card.note && String(card.note).trim()) {
        const noteSpan = document.createElement("div");
        noteSpan.textContent = String(card.note).trim();
        noteSpan.title = String(card.note).trim();
        noteSpan.style.cssText = "font-size:11px;color:#666;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;";
        text.appendChild(noteSpan);
    }

    // 类型徽标
    const kind = (card && card.kind) || "character";
    const badge = document.createElement("span");
    badge.textContent = kind === "character" ? "角色" : "场景";
    badge.style.cssText = "padding:2px 8px;border-radius:10px;font-size:11px;flex:none;" +
        (kind === "character"
            ? "background:rgba(80,160,255,.18);color:#80c0ff;border:1px solid #80c0ff;"
            : "background:rgba(160,255,128,.18);color:#a0e080;border:1px solid #a0e080;");

    // 导入按钮 (v1 走 importAsset; v3 走 assignArchiveToFormDOM 按 rows→素材池 + 描述拼接)
    // v2 老卡: 走 importAsset (B2 降级 — slots/pool_usage 可被消费, desc 三段无人消费已登记不再修)
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    const isV3 = card && card._v === 3;
    importBtn.textContent = isV3 ? "分配" : "导入";
    importBtn.style.cssText = isV3
      ? "padding:4px 12px;cursor:pointer;flex:none;font-size:12px;background:#3a3a3e;color:#80c0ff;border:1px solid #80c0ff;border-radius:3px;"
      : "padding:4px 12px;cursor:pointer;flex:none;font-size:12px;background:#3a3a3e;color:#7ee787;border:1px solid #7ee787;border-radius:3px;";
    importBtn.onclick = isV3 ? () => assignArchiveToFormDOM(name, card) : () => importAsset(name, card);

    // G1: 编辑按钮 (v3 卡限定; 中性灰样式, 位于「删除」左侧). 委托 editArchiveHandler (模块级句柄,
    // 在 buildV3ArchiveForm 构建时挂载, 见 :2749). editArchiveHandler=null → 兜底不响应.
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "编辑";
    editBtn.style.cssText = "padding:4px 12px;cursor:pointer;flex:none;font-size:12px;background:#3a3a3e;color:#cfd2da;border:1px solid #888;border-radius:3px;";
    editBtn.onclick = () => {
        if (!isV3) { toast("warn", "H3 档案", "仅 v3 卡可编辑"); return; }
        if (editArchiveHandler) editArchiveHandler(name, card);
    };
    if (!isV3) editBtn.style.display = "none";  // v1/v2 不显示

    // 删除按钮 (二次点击确认: 第一次点变 "确认删除?", 3 秒未点第二次恢复原文案)
    // 批 K2: v3 卡二次确认执行 = ①删卡条目 ②调 /h3_batch/archive_purge 清磁盘文档+图片夹 ③toast。
    //   purge 失败不回滚删卡, 仅 toast warn 提示"磁盘清理失败"。
    // 批 3 T3: v1/v2 卡也走 deleteAssetAndPurge — 复用既有 v3 purge 链, 不新造机制.
    //   旧版本 v1/v2 仅删卡条目不清 archive_images/<名>/ 图夹, 用户反复建同名卡会留下脏文件.
    //   安全边界沿用既有 (二次点击确认 + 3s timeout), 不放宽.
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "删除";
    delBtn.style.cssText = "padding:4px 12px;cursor:pointer;flex:none;font-size:12px;";
    let armed = null;
    delBtn.onclick = async () => {
        if (armed) {
            clearTimeout(armed); armed = null;
            delBtn.textContent = "删除"; delBtn.style.color = "";
            // 统一走 purge 链 — v1/v2 与 v3 共用, archive_purge 端点对 archive_docs/<名>.json 缺文件幂等,
            // 但能清掉 archive_images/<名>/ 下残留图 (v1/v2 历史 saveCardAsAsset 走 ensureMediaInLibrary
            // 入库的图都落到这里).
            await deleteAssetAndPurge(name);
            return;
        }
        delBtn.textContent = "确认删除?";
        delBtn.style.color = "#e5534b";
        armed = setTimeout(() => { armed = null; delBtn.textContent = "删除"; delBtn.style.color = ""; }, 3000);
    };

    row.appendChild(thumbWrap);
    row.appendChild(text);
    row.appendChild(badge);
    row.appendChild(importBtn);
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    return row;
}

// ============================================================================
// 3. 保存/导入/删除
// ============================================================================

// 保存当前表单为资产卡
async function saveCardAsAsset(name, kind) {
    if (!name) return;  // 空名由 UI 禁用, 此处兜底
    // I-⑥: 跨类重名拦截 — v1 保存栏若与现有 v3 档案同名 → 报错不保存
    if (assetsByName && assetsByName[name] && assetsByName[name]._v === 3) {
        toast("error", "H3 资产", "与档案库(v3)中的「" + name + "」重名, 请改名");
        return;
    }
    const data = collectData();
    // 批 L2: 保存前自动入库 — 对 data.pool[Picture] 中每个槽位的绝对路径, 若不在库内
    //   则调 ensureMediaInLibrary 复制进库内; 同名同内容幂等, 同名不同内容 _1 后缀.
    //   库内路径回填 data.pool.Picture[idx], 再走 buildSaveCardPayload 拼 payload.
    //   失败行保留原路径, 不阻断保存; 汇总 toast warn (前 5 条 + 余条计数).
    const importErrs = [];
    const picSlots = (data && data.pool && data.pool.Picture) || {};
    for (const [idx, src] of Object.entries(picSlots)) {
        const s = String(src || "").trim();
        if (!s) continue;
        if (s.indexOf("asset_library") >= 0 && s.indexOf("archive_images") >= 0) continue;
        const baseName = s.replace(/\\/g, "/").split("/").pop() || s;
        try {
            const newPath = await ensureMediaInLibrary(s, name);
            data.pool.Picture[idx] = newPath;
        } catch (ex) {
            importErrs.push({ idx: idx, file: baseName, reason: (ex && ex.message) ? ex.message : String(ex) });
        }
    }
    if (importErrs.length) {
        const lines = importErrs.slice(0, 5).map((x) => "槽" + x.idx + " " + x.file + ": " + x.reason);
        const more = importErrs.length > 5 ? " (还有 " + (importErrs.length - 5) + " 条)" : "";
        toast("warn", "H3 资产", importErrs.length + " 张图片未入库(保留原路径): " + lines.join(" | ") + more);
    }
    const payload = buildSaveCardPayload(name, kind, data);
    try {
        const r = await api.fetchApi("/h3_batch/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (!r.ok || j.error) {
            toast("error", "H3 资产", "保存失败: " + (j.error || ("HTTP " + r.status)));
            return;
        }
        toast("success", "H3 资产", "已保存: " + name + " (共 " + j.count + " 张)");
        loadAssets();  // 刷新列表
    } catch (e) {
        toast("error", "H3 资产", "保存失败: " + (e && e.message ? e.message : e));
    }
}

// 导入卡到当前素材池
function importAsset(name, card) {
    // 快照当前池
    const currentPool = {};
    for (const k of POOL_KEYS) {
        const slots = {};
        if (poolInputs[k]) {
            for (let i = 0; i < poolInputs[k].length; i++) {
                const v = (poolInputs[k][i].value || "").trim();
                if (v) slots[String(i + 1)] = v;
            }
        }
        currentPool[k] = slots;
    }
    const mode = (modeRadios.find((r) => r.checked) || {}).value || "分镜";
    const result = computeImportResult(card, currentPool, mode);

    // 应用 filled: 写值 + 缩略图刷新 + 勾选预设用途 (合并现有)
    for (const f of result.filled) {
        const inp = poolInputs[f.kind] && poolInputs[f.kind][f.idx - 1];
        if (!inp) continue;
        inp.value = f.value;
        if (inp._refreshThumb) inp._refreshThumb();
        const set = poolUsageSets[f.kind] && poolUsageSets[f.kind][f.idx - 1];
        const pills = poolPillEls[f.kind] && poolPillEls[f.kind][f.idx - 1];
        if (set) {
            for (const u of f.usages) set.add(u);
            if (pills) syncPillsVisual(pills, set);
        }
    }

    // skipped: toast 提示 + 内联「覆盖」按钮 (按 kind+idx 在对应 poolInputs DOM 旁挂)
    if (result.skipped.length) {
        const slotsDesc = result.skipped.map((s) => s.kind + " 槽 " + s.idx).join("、");
        toast("warn", "H3 资产", "导入 " + name + ": 跳过 " + slotsDesc + " (已被占用, 点旁「覆盖」按钮替换)");
        for (const s of result.skipped) attachOverrideButton(s.kind, s.idx, s.value, s.usages, name);
    }

    // 提示词拼接 (空 → 直接填; 非空 → ", " 并接)
    const promptChanged = !!(card.prompt && globalPromptTa && appendPromptText(globalPromptTa.value, card.prompt) !== globalPromptTa.value);
    if (card.prompt && globalPromptTa) {
        globalPromptTa.value = appendPromptText(globalPromptTa.value, card.prompt);
        schedulePreviewAll();
    }

    // 拼接模式 + Picture 9 → 提醒
    if (result.pic9Warn) toast("info", "H3 资产", "9 号槽在拼接模式为动态衔接槽, 语义可能与资产预设不同");

    // T8 批3 (顺手修①): 无图卡 (filled 为空) 但发生了提示词拼接 → 切到全局参数 tab, 让用户立即看到提示词变化;
    // 有 filled 照旧切到素材池 tab. 修复了"无图卡导入切错 tab"的历史缺陷.
    if (result.filled.length === 0 && promptChanged) {
        switchTab("global");
    } else {
        switchTab("pool");
    }
    toast("info", "H3 资产", "已导入: " + name);
}

// 删除卡
async function deleteAsset(name) {
    try {
        const r = await api.fetchApi("/h3_batch/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, card: null }),
        });
        const j = await r.json();
        if (!r.ok || j.error) {
            toast("error", "H3 资产", "删除失败: " + (j.error || ("HTTP " + r.status)));
            return;
        }
        toast("success", "H3 资产", "已删除: " + name);
        loadAssets();
    } catch (e) {
        toast("error", "H3 资产", "删除失败: " + (e && e.message ? e.message : e));
    }
}

// 批 K2: 删除 v3 档案卡
async function deleteAssetAndPurge(name) {
    let cardDeleted = false;
    try {
        const r = await api.fetchApi("/h3_batch/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, card: null }),
        });
        const j = await r.json();
        if (!r.ok || j.error) {
            toast("error", "H3 资产库", "删除档案失败: " + (j.error || ("HTTP " + r.status)));
            return;
        }
        cardDeleted = true;
        try {
            const pr = await api.fetchApi("/h3_batch/archive_purge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: name }),
            });
            const pj = await pr.json();
            if (!pr.ok || pj.error) {
                toast("warn", "H3 资产库", "磁盘清理失败: " + (pj.error || ("HTTP " + pr.status)) + ", 可手动删除 input\\asset_library 下对应文件夹");
                return;
            }
        } catch (e) {
            toast("warn", "H3 资产库", "磁盘清理失败: " + ((e && e.message) ? e.message : e) + ", 可手动删除 input\\asset_library 下对应文件夹");
            return;
        }
        toast("success", "H3 资产库", "档案已删除(文档+图片已清理): " + name);
        loadAssets();
    } catch (e) {
        if (!cardDeleted) toast("error", "H3 资产库", "删除失败: " + ((e && e.message) ? e.message : e));
    }
}

// ============================================================================
// 4. v3 档案表单 (G1-G6 + 5a-5e 全套)
// ============================================================================

// T8 批3 (任务⑤): v3 新建档案表单 (动态行)
function buildV3ArchiveForm() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:12px;padding:8px;background:rgba(240,160,64,.06);border:1px dashed #f0a040;border-radius:4px;";

    const title = document.createElement("div");
    title.textContent = "新建档案 (动态行 — 选字段/选素材/选槽位/写描述)";
    title.style.cssText = "font-size:12px;font-weight:700;color:#f0a040;margin-bottom:4px;";
    wrap.appendChild(title);

    // 卡名 + 自建 kind radios (独立 — 不复用 assetsKindRadios)
    // I-②: 名称框 max-width:170px (不再 flex:1), 后接"备注"输入框 (flex:1, 列表显示用)
    const head = document.createElement("div");
    head.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "档案名 (1-64 字符)";
    nameInput.maxLength = 64;
    nameInput.style.cssText = "flex:none;max-width:170px;min-width:120px;padding:4px 8px;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;";

    // I-② note 输入框 — 闭包级句柄, saveBtn.onclick 时 payload.card.note = value
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.placeholder = "备注(可选,显示在列表)";
    noteInput.maxLength = 120;
    noteInput.style.cssText = "flex:1;min-width:120px;padding:4px 8px;font-size:12px;background:#1a1a1e;color:#cfd2da;border:1px solid #555;border-radius:3px;";

    const kindChar = document.createElement("input");
    kindChar.type = "radio";
    kindChar.name = "h3_v3_asset_kind";
    kindChar.value = "character";
    kindChar.checked = true;
    const kindCharLab = document.createElement("label");
    kindCharLab.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;";
    kindCharLab.appendChild(kindChar);
    kindCharLab.appendChild(document.createTextNode("角色"));

    const kindScene = document.createElement("input");
    kindScene.type = "radio";
    kindScene.name = "h3_v3_asset_kind";
    kindScene.value = "scene";
    const kindSceneLab = document.createElement("label");
    kindSceneLab.style.cssText = kindCharLab.style.cssText;
    kindSceneLab.appendChild(kindScene);
    kindSceneLab.appendChild(document.createTextNode("场景"));

    head.appendChild(nameInput);
    head.appendChild(noteInput);
    head.appendChild(kindCharLab);
    head.appendChild(kindSceneLab);
    wrap.appendChild(head);

    // 行区: 每行=字段下拉/素材下拉/槽位下拉/描述/×/冲突条
    const rowsWrap = document.createElement("div");
    rowsWrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    wrap.appendChild(rowsWrap);

    const formRows = [];  // 每行 ctrls 句柄 (供 collectFormRows 用)

    // 工厂: 构造一行
    // G4: 单选 select → 复选组 (USAGE_OPTIONS 每项一个 checkbox); 同 kind 约束; 状态机 (Z5 定死);
    //   mediaBox.onclick/refreshMediaBox 改读"首勾 kind"
    // G6: 布局重排为"左图右字段"两列式 — 左列素材图, 右列纵向堆叠 槽位下拉+复选组(折行)+描述 textarea;
    //   行为逻辑零变化 (onCheckChange / expandFormRows / mergeCardRowsForEdit / 编辑回填完全不动),
    //   复选框渲染文案改短 (USAGE_SHORT_LABEL), 不动 USAGE_OPTIONS 池 UI 等其他消费方
    function makeRow() {
        const row = document.createElement("div");
        // 外层卡片: 现边框/底色风格 + 相对定位 (供右上角 × 按钮绝对定位)
        row.style.cssText = "position:relative;border:1px solid #444;padding:8px 8px 6px 8px;border-radius:4px;background:rgba(255,255,255,.02);";

        // === G4: 字段复选组 (替代单选 select) ===
        // G6: 短文案 USAGE_SHORT_LABEL[opt.id] (仅本表单渲染用)
        const checksBox = document.createElement("div");
        checksBox.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;align-items:center;flex:1;min-width:0;";
        const usageChecks = {};      // {id: checkbox}
        const checkItems = {};       // {id: {cb, lab, kind, label}}
        for (const opt of USAGE_OPTIONS) {
            const lab = document.createElement("label");
            lab.dataset.usageId = opt.id;
            lab.style.cssText = "display:flex;align-items:center;gap:2px;padding:2px 6px;font-size:11px;border:1px solid #555;border-radius:3px;cursor:pointer;background:#1a1a1e;color:#aaa;line-height:1.4;user-select:none;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.usageId = opt.id;
            cb.style.cssText = "margin:0;cursor:pointer;";
            const txt = document.createElement("span");
            txt.textContent = USAGE_SHORT_LABEL[opt.id] || opt.label;
            lab.appendChild(cb);
            lab.appendChild(txt);
            checksBox.appendChild(lab);
            usageChecks[opt.id] = cb;
            checkItems[opt.id] = { cb: cb, lab: lab, kind: _USAGE_KIND[opt.id] || "", label: opt.label };
        }
        // 1.14a T5: 样式开关 (复用 pool.js 导出的 buildPoseStyleToggle, T4 锚点一致)
        // 默认 skeleton, 取消勾 pose 保留偏好 (rowState.pose_style 不会被 clear)
        const poseStyleToggle = buildPoseStyleToggle(
            () => rowState.pose_style || "",
            (v) => { rowState.pose_style = v; });
        poseStyleToggle.style.display = "none";
        checksBox.appendChild(poseStyleToggle);
        // 状态查询 (按 USAGE_OPTIONS 顺序: 首勾 / 首勾 kind / 全勾 kind 集合 / 全勾 id 列表)
        function firstCheckedId() {
            for (const opt of USAGE_OPTIONS) {
                const cb = usageChecks[opt.id];
                if (cb && cb.checked) return opt.id;
            }
            return "";
        }
        function firstCheckedKind() {
            const id = firstCheckedId();
            return id ? (_USAGE_KIND[id] || "") : "";
        }
        function allCheckedKinds() {
            const set = new Set();
            for (const opt of USAGE_OPTIONS) {
                const cb = usageChecks[opt.id];
                if (cb && cb.checked) {
                    const k = _USAGE_KIND[opt.id];
                    if (k) set.add(k);
                }
            }
            return set;
        }
        function allCheckedIds() {
            const out = [];
            for (const opt of USAGE_OPTIONS) {
                const cb = usageChecks[opt.id];
                if (cb && cb.checked) out.push(opt.id);
            }
            return out;
        }
        // Z5: 状态机 — 同 kind 约束 (勾任一后, 异 kind 禁用置灰)
        // 1.14a T5: 姿势互斥扩展 (L7 修正: allCheckedIds 已是数组; 现场包 Set)
        //   pose 与其他 Picture 用途两两禁用 (叠加在原异 kind 规则之上)
        function updateDisabledState() {
            const kinds = allCheckedKinds();
            const checked = new Set(allCheckedIds());
            const hasPose = checked.has("pose");
            const hasOtherPicture = [...checked].some(
                (id) => id !== "pose" && _USAGE_KIND[id] === "Picture");
            for (const opt of USAGE_OPTIONS) {
                const item = checkItems[opt.id];
                if (!item) continue;
                if (kinds.size === 0) {
                    item.cb.disabled = false;
                    item.lab.style.opacity = "";
                    item.lab.style.cursor = "pointer";
                    item.lab.title = "";
                } else {
                    if (kinds.has(item.kind)) {
                        item.cb.disabled = false;
                        item.lab.style.opacity = "";
                        item.lab.style.cursor = "pointer";
                        item.lab.title = "";
                    } else {
                        item.cb.disabled = true;
                        item.lab.style.opacity = "0.4";
                        item.lab.style.cursor = "not-allowed";
                        item.lab.title = "已选其他 kind, 不可再勾";
                    }
                }
                // 1.14a T5: pose 互斥 — 勾 pose 后其他 Picture 用途禁用; 其他 Picture 用途勾后 pose 禁用
                if (opt.id === "pose" && hasOtherPicture) {
                    item.cb.disabled = true;
                    item.lab.style.opacity = "0.4";
                    item.lab.style.cursor = "not-allowed";
                    item.lab.title = "已选其他 Picture 用途, 不可勾姿势";
                } else if (_USAGE_KIND[opt.id] === "Picture" && hasPose && opt.id !== "pose") {
                    item.cb.disabled = true;
                    item.lab.style.opacity = "0.4";
                    item.lab.style.cursor = "not-allowed";
                    item.lab.title = "已勾姿势, 不可再勾其他 Picture 用途";
                }
            }
        }

        // === 素材缩略图框 (沿用原版) ===
        const mediaBox = document.createElement("div");
        mediaBox.style.cssText = "position:relative;width:56px;height:56px;flex:none;border:1px dashed #888;border-radius:4px;background:#1a1a1e;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;";
        const mediaImg = document.createElement("img");
        mediaImg.loading = "lazy";
        mediaImg.style.cssText = "width:100%;height:100%;object-fit:cover;display:none;";
        mediaBox.appendChild(mediaImg);
        const mediaPlaceholder = document.createElement("span");
        mediaPlaceholder.style.cssText = "color:#888;font-size:10px;text-align:center;padding:2px;line-height:1.2;";
        mediaPlaceholder.textContent = "先选字段";
        mediaBox.appendChild(mediaPlaceholder);
        const mediaClear = document.createElement("button");
        mediaClear.type = "button";
        mediaClear.textContent = "×";
        mediaClear.title = "清除素材";
        mediaClear.style.cssText = "position:absolute;top:1px;right:1px;width:16px;height:16px;padding:0;font-size:12px;line-height:14px;background:rgba(0,0,0,.7);color:#fff;border:1px solid #666;border-radius:3px;cursor:pointer;display:none;";
        mediaBox.appendChild(mediaClear);
        const mediaName = document.createElement("span");
        mediaName.style.cssText = "max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#ccc;display:none;margin-top:2px;";
        // 行状态: media 存绝对路径 (选材 openPicker 返回); 初始空
        // 1.14a T5: pose_style 仅 pose 行有值 (默认 "skeleton"; 取消勾 pose 保留偏好—L1c 行为声明)
        const rowState = { media: "", pose_style: "" };
        // 刷新缩略图框 — G4: 改读"首勾 kind" (取代 usageSel.value)
        // I-⑦: 先图后字段 — kind 为空但 media 有值时仍渲染 (按文件扩展名推断 kind)
        const refreshMediaBox = () => {
            const kind = firstCheckedKind();
            const v = rowState.media;
            mediaClear.style.display = "none";
            mediaName.style.display = "none";
            mediaImg.style.display = "none";
            mediaPlaceholder.style.display = "";
            mediaPlaceholder.textContent = "点此选素材";
            mediaBox.style.borderStyle = "dashed";
            mediaBox.style.cursor = "pointer";
            // I-⑦: 先图后字段 — 无 kind 但有 v → 按扩展名推断 kind 渲染
            let effectiveKind = kind;
            if (!effectiveKind && v) {
                const lower = v.toLowerCase();
                if (/\.(mp4|webm|mov|avi|mpeg|mpg|mkv)$/.test(lower)) effectiveKind = "Video";
                else if (/\.(wav|mp3|flac|aac|aiff|m4a|ogg|opus)$/.test(lower)) effectiveKind = "Audio";
                else effectiveKind = "Picture";
            }
            if (!effectiveKind) {
                // 字段未选且无素材: 占位文案 "先选字段" (旧行为)
                mediaPlaceholder.textContent = "先选字段";
                mediaBox.style.cursor = "default";
                return;
            }
            if (!v) return;  // 字段已选但无素材: 保持 "点此选素材"
            // 选中态
            mediaBox.style.borderStyle = "solid";
            mediaClear.style.display = "";
            const fname = v.split(/[\\/]/).pop();
            // I-③ 长文件名布局: max-width + ellipsis + title (避免撑爆 flex 容器)
            mediaName.textContent = fname;
            mediaName.title = v;  // title=绝对路径
            mediaName.style.display = "";
            mediaName.style.maxWidth = "72px";  // 对齐修复: 与 leftCol 固定宽一致, 长名省略(title 看全路径)
            mediaName.style.overflow = "hidden";
            mediaName.style.textOverflow = "ellipsis";
            mediaName.style.whiteSpace = "nowrap";
            if (effectiveKind === "Audio") {
                // Audio 恒 🔊 — 不渲染 img, 占位改图标
                mediaPlaceholder.style.display = "";
                mediaPlaceholder.textContent = "🔊";
                mediaPlaceholder.style.fontSize = "20px";
            } else {
                mediaPlaceholder.style.display = "none";
                mediaImg.style.display = "";
                mediaImg.alt = fname;
                mediaImg.src = "/h3_batch/thumb?path=" + encodeURIComponent(v);
            }
            // 批 B 节点 B-III: 同步裁脸按钮可见性 (仅 Picture 显示)
            refreshCropBtns();
        };
        mediaImg.onerror = () => {
            mediaImg.style.display = "none";
            mediaPlaceholder.style.display = "";
            mediaPlaceholder.textContent = "无预览·点此选";
            mediaPlaceholder.style.fontSize = "10px";
        };
        mediaClear.onclick = (e) => {
            e.stopPropagation();
            rowState.media = "";
            refreshMediaBox();
            refreshState();
        };
        // 批 B 节点 B-III：B0 服装图裁脸 — 「自动裁脸」/「手动框选」两按钮 + 手动框选 overlay
        // 仅当 rowState.media 是图片且已选素材时显示 (refreshCropBtns 由 refreshMediaBox 末尾调)
        const cropBtnBox = document.createElement("div");
        cropBtnBox.style.cssText = "display:none;flex-direction:column;gap:2px;margin-top:2px;align-items:stretch;width:100%;";

        function makeCropBtn(text, title) {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.title = title;
            b.style.cssText = "padding:1px 3px;font-size:10px;line-height:1.4;background:rgba(240,160,64,.15);color:#f0a040;border:1px solid #f0a040;border-radius:3px;cursor:pointer;";
            return b;
        }
        // 批 B 节点 B-III 终版: 自动裁脸按钮已下线 (老板裁决), 仅保留「手动框选」为唯一裁剪方式.
        // 后端 mode="auto" 返 400 + 文案「自动裁脸已下线, 请使用手动框选」.
        const rectCropBtn = makeCropBtn("手动框选", "弹页面居中浮层大图 (max_size=1024 thumb) 拖选矩形, 可拖四角手柄调大小/拖框体移动, 底部「确认裁剪」生效, ESC/取消关浮层");

        async function callCropApi(body) {
            const r = await fetch("/h3_batch/asset_crop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return await r.json();
        }
        function refreshAfterCrop(newPath) {
            rowState.media = newPath;
            refreshMediaBox();
        }
        async function doRectCrop(pxRect) {
            rectCropBtn.disabled = true;
            rectCropBtn.textContent = "裁剪中…";
            try {
                const r = await callCropApi({ src: rowState.media, mode: "rect", rect: pxRect });
                if (r.ok && r.path) {
                    refreshAfterCrop(r.path);
                    toast("info", "手动框选", "已保存: " + r.path.split(/[\\/]/).pop());
                } else {
                    toast("warn", "手动框选", r.error || "未生成");
                }
            } catch (e) {
                toast("error", "手动框选", String(e));
            } finally {
                rectCropBtn.disabled = false;
                rectCropBtn.textContent = "手动框选";
            }
        }

        // 手动框选: 弹页面居中浮层 (60vw×60vh 大图) 拖选矩形 → 换算到原图像素 → 调端点
        // 批 B 节点 B-III 门审必修 2: rectDragging 标志位 — 拖选完成后浏览器仍会派发 click
        // → mediaBox.onclick 误弹 openPicker; 标志位在 mousemove 时设, onclick 内检后跳过并复位
        // 批 B 节点 B-III 返工 必修 3: 手动框选改浮层 (页面居中, 60vw×60vh 大图拖选)
        // 浮层遮罩期间 rectDragging = true, 关闭时复位 — 防止 mediaBox.onclick 误弹 openPicker
        let rectDragging = false;
        async function startRectDrag() {
            if (!rowState.media) { toast("warn", "手动框选", "请先选一张图"); return; }
            // 先 GET 原图真实尺寸 (必修 1: 后端 image_meta 端点), 拖选换算以此为准
            let origW = 0, origH = 0;
            try {
                const metaResp = await fetch(
                    "/h3_batch/image_meta?path=" + encodeURIComponent(rowState.media));
                if (!metaResp.ok) {
                    toast("error", "手动框选", "无法读取原图尺寸 (image_meta 失败)");
                    return;
                }
                const meta = await metaResp.json();
                if (!meta.ok) {
                    toast("error", "手动框选", "无法读取原图尺寸: " + (meta.error || ""));
                    return;
                }
                origW = meta.w; origH = meta.h;
            } catch (e) {
                toast("error", "手动框选", "image_meta 请求失败: " + e);
                return;
            }
            rectDragging = true;
            toast("info", "手动框选", "已开浮层, 在大图上拖选矩形 (可拖手柄调大小/拖框体移动, 底部「确认裁剪」生效, ESC 取消)");
            // === 浮层 DOM ===
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;";
            const wrap = document.createElement("div");
            wrap.style.cssText = "position:relative;display:inline-block;max-width:60vw;max-height:60vh;";
            const img = document.createElement("img");
            img.style.cssText = "max-width:60vw;max-height:60vh;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;background:#222;";
            img.draggable = false;
            // 批 B 节点 B-III 三修问题 3a: 浮层图用 thumb max_size=1024 大图 (PIL thumbnail 等比缩)
            // 默认 128 保持既有消费者不变; 浮层独享大尺寸预览
            img.src = "/h3_batch/thumb?path=" + encodeURIComponent(rowState.media) + "&max_size=1024";
            wrap.appendChild(img);

            // === 框 sel DOM (初始隐藏, mousedown on img 时创建) ===
            let sel = null;          // 选择框 DOM
            let selRect = null;      // {x, y, w, h} wrap 内 css px
            const HANDLES = ["nw", "ne", "sw", "se"];

            const createSel = () => {
                sel = document.createElement("div");
                sel.style.cssText = "position:absolute;box-sizing:border-box;border:2px solid #f0a040;background:rgba(240,160,64,.15);pointer-events:none;z-index:2;";
                for (const h of HANDLES) {
                    const hh = document.createElement("div");
                    hh.dataset.handle = h;
                    let cursor = "nwse-resize";
                    if (h === "ne" || h === "sw") cursor = "nesw-resize";
                    hh.style.cssText = "position:absolute;width:12px;height:12px;background:#f0a040;border:1px solid #fff;cursor:" + cursor + ";pointer-events:auto;";
                    sel.appendChild(hh);
                }
                wrap.appendChild(sel);
                // 手柄事件: sel 上 mousemove 找最近手柄 (取 dataset.handle)
                sel.addEventListener("mousedown", (e) => {
                    const handle = e.target.dataset.handle;
                    if (handle) onSelMouseDown(e, "resize-" + handle);
                    else if (e.target === sel) onSelMouseDown(e, "move");
                });
            };
            const removeSel = () => {
                if (sel && sel.parentNode) sel.parentNode.removeChild(sel);
                sel = null;
                selRect = null;
            };
            const updateSel = () => {
                if (!sel || !selRect) return;
                sel.style.left = selRect.x + "px";
                sel.style.top = selRect.y + "px";
                sel.style.width = selRect.w + "px";
                sel.style.height = selRect.h + "px";
                // 4 手柄绝对定位
                const kids = sel.children;
                kids[0].style.left = "-6px"; kids[0].style.top = "-6px";   // nw
                kids[1].style.right = "-6px"; kids[1].style.top = "-6px";  // ne
                kids[2].style.left = "-6px"; kids[2].style.bottom = "-6px";// sw
                kids[3].style.right = "-6px"; kids[3].style.bottom = "-6px";// se
            };

            // === 底部按钮行 ===
            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:10px;margin-top:12px;";
            const confirmBtn = document.createElement("button");
            confirmBtn.textContent = "确认裁剪";
            confirmBtn.style.cssText = "padding:8px 24px;font-size:14px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;";
            const cancelBtn = document.createElement("button");
            cancelBtn.textContent = "取消";
            cancelBtn.style.cssText = "padding:8px 24px;font-size:14px;background:rgba(170,34,51,.9);color:#fff;border:none;border-radius:4px;cursor:pointer;";
            btnRow.appendChild(confirmBtn);
            btnRow.appendChild(cancelBtn);
            overlay.appendChild(wrap);
            overlay.appendChild(btnRow);
            document.body.appendChild(overlay);

            // === 关闭逻辑 ===
            const closeOverlay = (keepDragFlag) => {
                document.removeEventListener("keydown", onKey);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (!keepDragFlag) rectDragging = false;
            };
            const onKey = (e) => {
                if (e.key === "Escape") { closeOverlay(false); toast("info", "手动框选", "已取消"); }
            };
            document.addEventListener("keydown", onKey);

            // === mousedown on img (无 sel 时新建, 有 sel 时不动 — sel 自己处理) ===
            img.addEventListener("mousedown", (e) => {
                if (sel) return;  // 已有框, 不抢 sel 事件
                e.preventDefault();
                e.stopPropagation();
                createSel();
                const wrapRect = wrap.getBoundingClientRect();
                const startX = e.clientX - wrapRect.left;
                const startY = e.clientY - wrapRect.top;
                selRect = { x: startX, y: startY, w: 0, h: 0 };
                updateSel();
                const startPt = { x: startX, y: startY };
                const onMove = (mv) => {
                    const cx = Math.max(0, Math.min(wrapRect.width, mv.clientX - wrapRect.left));
                    const cy = Math.max(0, Math.min(wrapRect.height, mv.clientY - wrapRect.top));
                    selRect.x = Math.min(startPt.x, cx);
                    selRect.y = Math.min(startPt.y, cy);
                    selRect.w = Math.abs(cx - startPt.x);
                    selRect.h = Math.abs(cy - startPt.y);
                    updateSel();
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    if (selRect.w < 5 || selRect.h < 5) removeSel();
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });

            // === 框拖移 / 手柄 resize ===
            function onSelMouseDown(e, mode) {
                e.preventDefault();
                e.stopPropagation();
                const wrapRect = wrap.getBoundingClientRect();
                const startMouse = { x: e.clientX, y: e.clientY };
                const startRect = { x: selRect.x, y: selRect.y, w: selRect.w, h: selRect.h };
                const onMove = (mv) => {
                    const dx = mv.clientX - startMouse.x;
                    const dy = mv.clientY - startMouse.y;
                    if (mode === "move") {
                        selRect.x = Math.max(0, Math.min(wrapRect.width - startRect.w, startRect.x + dx));
                        selRect.y = Math.max(0, Math.min(wrapRect.height - startRect.h, startRect.y + dy));
                    } else if (mode === "resize-nw") {
                        const nx = Math.max(0, Math.min(startRect.x + startRect.w - 5, startRect.x + dx));
                        const ny = Math.max(0, Math.min(startRect.y + startRect.h - 5, startRect.y + dy));
                        selRect.w = startRect.w - (nx - startRect.x);
                        selRect.h = startRect.h - (ny - startRect.y);
                        selRect.x = nx; selRect.y = ny;
                    } else if (mode === "resize-ne") {
                        const ny = Math.max(0, Math.min(startRect.y + startRect.h - 5, startRect.y + dy));
                        selRect.h = startRect.h - (ny - startRect.y);
                        selRect.y = ny;
                        selRect.w = Math.max(5, Math.min(wrapRect.width - startRect.x, startRect.w + dx));
                    } else if (mode === "resize-sw") {
                        const nx = Math.max(0, Math.min(startRect.x + startRect.w - 5, startRect.x + dx));
                        selRect.w = startRect.w - (nx - startRect.x);
                        selRect.x = nx;
                        selRect.h = Math.max(5, Math.min(wrapRect.height - startRect.y, startRect.h + dy));
                    } else if (mode === "resize-se") {
                        selRect.w = Math.max(5, Math.min(wrapRect.width - startRect.x, startRect.w + dx));
                        selRect.h = Math.max(5, Math.min(wrapRect.height - startRect.y, startRect.h + dy));
                    }
                    updateSel();
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            }

            // === 确认裁剪 (用最终 selRect 调端点) ===
            confirmBtn.onclick = () => {
                if (!selRect || selRect.w < 5 || selRect.h < 5) {
                    toast("warn", "手动框选", "请先在图上拖选矩形");
                    return;
                }
                const imgRect = img.getBoundingClientRect();
                const wrapRect = wrap.getBoundingClientRect();
                const imgOffX = imgRect.left - wrapRect.left;
                const imgOffY = imgRect.top - wrapRect.top;
                const pxRect = h3ComputeRectFromDrag(
                    selRect, imgOffX, imgOffY, imgRect.width, imgRect.height, origW, origH);
                if (!pxRect) {
                    toast("warn", "手动框选", "框选区无效");
                    return;
                }
                // 调端点; 浮层保持 rectDragging=true 关, 抑制后续 click 一次 (mediaBox.onclick 检测)
                doRectCrop(pxRect);
                closeOverlay(true);
            };
            cancelBtn.onclick = () => {
                closeOverlay(false);
                toast("info", "手动框选", "已取消");
            };
            // 浮层背景点击 = 取消
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) { closeOverlay(false); toast("info", "手动框选", "已取消"); }
            });
        }
        rectCropBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!rowState.media) { toast("warn", "手动框选", "请先选一张图"); return; }
            // 批 L2: 库外图 (绝对盘符如 I:\...) 点「手动框选」→ 先调 asset_copy 入库
            // 否则后续 asset_crop 的路径域校验 (realpath + commonpath input 树内) 会 400.
            if (rowState.media.indexOf("asset_library") < 0 || rowState.media.indexOf("archive_images") < 0) {
                const nm = nameInput.value.trim();
                if (!nm) {
                    toast("error", "手动框选", "库外图需先填写卡名才能入库");
                    return;
                }
                try {
                    const newPath = await ensureMediaInLibrary(rowState.media, nm);
                    rowState.media = newPath;
                    refreshMediaBox();
                    toast("info", "手动框选", "已自动入库: " + newPath.split(/[\\/]/).pop());
                } catch (ex) {
                    toast("error", "手动框选", "入库失败: " + (ex && ex.message ? ex.message : ex));
                    return;
                }
            }
            startRectDrag();
        };

        cropBtnBox.appendChild(rectCropBtn);

        function refreshCropBtns() {
            const kind = firstCheckedKind();
            const v = rowState.media;
            let effectiveKind = kind;
            if (!effectiveKind && v) {
                const lower = v.toLowerCase();
                if (/\.(mp4|webm|mov|avi|mpeg|mpg|mkv)$/.test(lower)) effectiveKind = "Video";
                else if (/\.(wav|mp3|flac|aac|aiff|m4a|ogg|opus)$/.test(lower)) effectiveKind = "Audio";
                else effectiveKind = "Picture";
            }
            cropBtnBox.style.display = (effectiveKind === "Picture" && v) ? "flex" : "none";
        }
        mediaBox.onclick = () => {
            // 批 B 节点 B-III 门审必修 2: 拖选刚完成 → 抑制 click 误弹 openPicker
            // (拖过才设; 仅 mousedown 不动不算拖, 仍走 openPicker — 用户点一下选图走原路径)
            if (rectDragging) { rectDragging = false; return; }
            const id = firstCheckedId();
            const kind = firstCheckedKind();
            // I-⑦: 先图后字段 — 无勾选时也打开选择器 (默认 Picture 扩展集)
            const useKind = kind || "Picture";
            const opt = USAGE_OPTIONS.find((o) => o.id === id);
            const label = opt ? opt.label : "字段";
            openPicker({
                kind: "file",
                exts: POOL_EXTS[useKind],
                onPick: (p) => { rowState.media = p; refreshMediaBox(); refreshState(); },
                nativePick: null,
                title: "选择" + (kind ? (label + "素材") : "Picture 素材"),
                current: rowState.media,
            });
        };

        const slotSel = document.createElement("select");
        slotSel.style.cssText = "min-width:80px;padding:3px;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;flex:none;";
        slotSel.appendChild(new Option("槽 1", "1", true, true));
        slotSel.disabled = true;

        // 批 A 节点 5 (5b): 单 desc textarea → descsBox 动态生成多 desc 输入
        // 勾一个用途 → 出一个 (label + textarea) 行; 取消勾 → 移除输入框 (值丢弃, 与规格一致)
        // 标签固定不可删 (外貌/服装/道具/姿势, pose = 人物·姿势 5c); 内容可空 (灰字 placeholder)
        // schema 不变: 行内每张 desc 仍是 string — collect 时按 usage 拆分落到 rows[].desc
        const descsBox = document.createElement("div");
        descsBox.style.cssText = "display:flex;flex-direction:column;gap:2px;width:100%;";
        // descsById: {[usageId]: {row, lab, ta}} — DOM 句柄表, 当前已勾选用途的 desc 输入框
        const descsById = {};
        // 用途 → desc 输入框创建 (按 USAGE_SHORT_LABEL 标签; 不可删)
        function createDescInput(usageId) {
            const label = USAGE_SHORT_LABEL[usageId] || (USAGE_OPTIONS.find((o) => o.id === usageId) || {}).label || usageId;
            const wrapRow = document.createElement("div");
            wrapRow.style.cssText = "display:flex;gap:4px;align-items:flex-start;width:100%;";
            const lab = document.createElement("span");
            lab.textContent = label;
            lab.style.cssText = "min-width:80px;padding:3px 0;font-size:11px;color:#9a9a9a;flex:none;";
            const ta = document.createElement("textarea");
            ta.rows = 2;
            ta.dataset.usageId = usageId;
            ta.placeholder = label + " 描述（可空）";
            ta.style.cssText = "flex:1;min-height:34px;padding:3px 6px;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;box-sizing:border-box;resize:vertical;font-family:inherit;line-height:1.4;";
            ta.addEventListener("input", refreshState);
            wrapRow.appendChild(lab);
            wrapRow.appendChild(ta);
            return { row: wrapRow, lab: lab, ta: ta, label: label };
        }
        // 同步 descsBox: 已勾选用途各出一个 desc 输入框; 未勾选用途移除
        // 调用方: onCheckChange 末尾 / editArchiveToForm 重建后
        function syncDescsBox() {
            const checkedIds = allCheckedIds();
            const checkedSet = new Set(checkedIds);
            // 移除未勾选用途的 desc 输入框
            for (const id of Object.keys(descsById)) {
                if (!checkedSet.has(id)) {
                    const item = descsById[id];
                    if (item && item.row && item.row.parentNode) item.row.parentNode.removeChild(item.row);
                    delete descsById[id];
                }
            }
            // 按 USAGE_OPTIONS 顺序添加新勾选用途的 desc 输入框
            for (const id of checkedIds) {
                if (descsById[id]) continue;
                const item = createDescInput(id);
                descsBox.appendChild(item.row);
                descsById[id] = item;
            }
        }

        // G6: 删除按钮移到卡片右上角 — 绝对定位 (避免挤占字段空间)
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "×";
        delBtn.title = "删除此行";
        delBtn.style.cssText = "position:absolute;top:2px;right:2px;width:22px;height:22px;padding:0;cursor:pointer;font-size:14px;line-height:1;background:rgba(0,0,0,.5);color:#e6e6e6;border:1px solid #666;border-radius:3px;";

        // 冲突条: 右列底部独占一行 (flex-direction:column 内 width:100% 自动撑满)
        const conflictEl = document.createElement("div");
        conflictEl.style.cssText = "display:none;width:100%;color:#e5534b;font-size:11px;padding:2px 0 0 0;";

        // === G6 布局装配: 左图右字段两列式 ===
        // 左列 = mediaBox (flex:none; 56x56)
        // 对齐修复: 固定宽 72px — 原先 flex:none 按内容收缩, 文件名长短(56~120px)直接改变列宽,
        // 缩略图被 align-items:center 居中在不同宽度的列里 → 行与行缩略图水平错位
        const leftCol = document.createElement("div");
        leftCol.style.cssText = "display:flex;flex-direction:column;align-items:center;flex:none;width:72px;";
        leftCol.appendChild(mediaBox);
        leftCol.appendChild(mediaName);
        leftCol.appendChild(cropBtnBox);

        // 右列 = 纵向堆叠: 槽下拉+复选组 (顶行) / 描述输入框集合 (中行, 5b 动态生成) / 冲突条 (底行)
        const topRow = document.createElement("div");
        topRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
        topRow.appendChild(slotSel);
        topRow.appendChild(checksBox);

        const rightCol = document.createElement("div");
        rightCol.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;";
        rightCol.appendChild(topRow);
        rightCol.appendChild(descsBox);
        rightCol.appendChild(conflictEl);

        const bodyWrap = document.createElement("div");
        bodyWrap.style.cssText = "display:flex;gap:8px;align-items:flex-start;";
        bodyWrap.appendChild(leftCol);
        bodyWrap.appendChild(rightCol);

        // G4 ctrls: usageSel → usageChecks + checkItems + 状态查询 + 刷新缩略图框函数
        // N2: 暴露 refreshMediaBox 供 G1 编辑回填联动
        // 批 A 节点 5 (5b): descInp → descsById / descsBox / syncDescsBox (动态 desc 输入集)
        //   descInp 句柄下线 (单 textarea 已删); collectFormRows / collectFormRowsMulti 改读 descsById
        const ctrls = {
            usageChecks: usageChecks,
            checkItems: checkItems,
            checksBox: checksBox,
            mediaBox: mediaBox,
            media: rowState,
            slotSel: slotSel,
            descsById: descsById,
            descsBox: descsBox,
            syncDescsBox: syncDescsBox,
            conflictEl: conflictEl,
            firstCheckedId: firstCheckedId,
            firstCheckedKind: firstCheckedKind,
            allCheckedKinds: allCheckedKinds,
            allCheckedIds: allCheckedIds,
            updateDisabledState: updateDisabledState,
            refreshMediaBox: refreshMediaBox,
            // 1.14a T5: 卡行 pose 样式读取 (collectFormRows 消费, lookupCardPoseStyle 跨行查)
            getPoseStyle: () => rowState.pose_style || "",
        };

        // G4: 复选组状态机 (Z5 定死 + 终审修订)
        //   零勾 → 有勾 (首个): 走 else 分支 — 重建 slotSel 域按首勾 kind / 同步 descsBox / 刷新 mediaBox
        //                          (I-⑦: 不再清 media, 保留用户先图后字段路径)
        //   已有勾 → 再勾同 kind: 走 else 分支 — 不重复触发副作用, 不清 media (保留用户中途选图, 多用途流)
        //   取消勾 → 零勾: 走 if (!kind) 分支 — 清 rowState.media (跨 kind 脏数据拦截点)
        // I-⑦ 修订: 零勾→首勾 不再清 media; 跨 kind 媒体不匹配由保存校验拦截
        // 批 A 节点 5 (5b): descInp 占位设置 → syncDescsBox (动态生成 desc 输入框, 勾几出几)
        function onCheckChange() {
            const id = firstCheckedId();
            const kind = firstCheckedKind();
            if (!kind) {
                // 全空 → 复位空态 (slotSel 仅槽 1, 禁用; descsBox 全清 — 5b; media 清空 — 跨 kind 拦截)
                rowState.media = "";
                slotSel.innerHTML = "";
                slotSel.appendChild(new Option("槽 1", "1", true, true));
                slotSel.value = "1";
                slotSel.disabled = true;
            } else {
                // 任意 kind 已勾: 按首勾 kind 重建 slotSel 域 (限域); media 保留 (I-⑦ 先图后字段)
                const max = POOL_SLOTS[kind] || 9;
                const current = slotSel.value;
                slotSel.innerHTML = "";
                for (let i = 1; i <= max; i++) slotSel.appendChild(new Option("槽 " + i, String(i)));
                slotSel.value = (current && parseInt(current, 10) >= 1 && parseInt(current, 10) <= max) ? current : "1";
                slotSel.disabled = false;
            }
            // 5b: 动态生成/移除 desc 输入框 — 勾几出几, 内容可空
            syncDescsBox();
            refreshMediaBox();
            updateDisabledState();
            // 1.14a T5: 样式开关同步 — 勾 pose 时显示, 默认 skeleton
            poseStyleToggle.sync(usageChecks["pose"] && usageChecks["pose"].checked);
            if (usageChecks["pose"] && usageChecks["pose"].checked && !rowState.pose_style) {
                rowState.pose_style = "skeleton";
            }
            refreshState();
        }
        for (const opt of USAGE_OPTIONS) {
            const cb = usageChecks[opt.id];
            if (!cb) continue;
            cb.addEventListener("change", onCheckChange);
        }
        // 初始: 全空态, 全部可选
        updateDisabledState();

        slotSel.onchange = refreshState;
        delBtn.onclick = () => {
            const i = formRows.indexOf(ctrls);
            if (i >= 0) formRows.splice(i, 1);
            row.remove();
            refreshState();
        };

        row.appendChild(bodyWrap);
        row.appendChild(delBtn);
        return { row, ctrls };
    }

    // G4: 收集当前 form 行 — usage 字段为单值 (首勾 id, 无勾空串; N3 定死)
    // 供 detectRowConflicts + buildV3CardPayload + computeSaveDisabled 消费现状形状
    // 批 A 节点 5 (5b): desc 改读 descsById[firstId]?.ta.value — desc 输入每勾选用途独立
    function collectFormRows() {
        return formRows.map((c) => {
            const firstId = c.firstCheckedId();
            const descItem = firstId ? c.descsById[firstId] : null;
            return {
                usage: firstId,
                media: c.media.media,
                slot: c.slotSel.value,
                desc: descItem ? (descItem.ta.value || "") : "",
                // 1.14a T5: pose 行写样式 (其他行为空; bindings.js 快照读 row.usage==="pose" 过滤)
                pose_style: firstId === "pose" ? (c.getPoseStyle() || "skeleton") : "",
            };
        });
    }
    // G4: 收集多勾版本 (给 saveBtn.onclick 展开路径消费) — 每行返回 usages:[id,...] + descs:{id:text}
    // 批 A 节点 5 (5b): desc (单值) → descs ({[usageId]: text}, 按用途独立)
    function collectFormRowsMulti() {
        return formRows.map((c) => {
            const usages = c.allCheckedIds();
            const descs = {};
            for (const u of usages) {
                const item = c.descsById[u];
                if (item && item.ta) descs[u] = item.ta.value || "";
            }
            return {
                usages: usages,
                media: c.media.media,
                slot: c.slotSel.value,
                descs: descs,
            };
        });
    }
    // G4: 展开函数 — 一行勾 K 个用途 → K 条 (usage 各异, media/slot/复制, desc 按用途独立)
    // 未勾用途的行保持现状语义 (usage 空串行照旧); 丢给 buildV3CardPayload 全空过滤
    // 批 A 节点 5 (5b): descs 字典 → 每条 (usage, desc) 独立落 rows[]
    function expandFormRows(rows) {
        const out = [];
        for (const r of (rows || [])) {
            const us = Array.isArray(r.usages) ? r.usages : [];
            const m = r.media || "";
            const s = r.slot || "1";
            const descs = (r.descs && typeof r.descs === "object" && !Array.isArray(r.descs)) ? r.descs : {};
            if (us.length <= 1) {
                out.push({ usage: us[0] || "", media: m, slot: s, desc: descs[us[0]] || "" });
            } else {
                for (const u of us) {
                    out.push({ usage: u, media: m, slot: s, desc: descs[u] || "" });
                }
            }
        }
        return out;
    }
    // G4 Z4: 编辑回填合并键 — (kind, media, slot) 三同 → 合并回填为一行多勾 (各用途 desc 独立)
    // 返回 [{usages:[id,...], media, slot, descs:{[id]:text}}]; 任一不等不合并
    // 缺陷2 修复: 合并键补 kind 维度 (由 usage 经 _USAGE_KIND 映射), 防止跨 kind 同 media/slot 误合并
    // 批 A 节点 5 (5b): 合并键去 desc (旧 v3 多用途共用同一 desc — 5b 后每用途独立 desc);
    //   合并产物 descs = {[usageId]: descText} — 一行多勾场景下旧数据共享 desc 平摊到每个用途
    function mergeCardRowsForEdit(cardRows) {
        const merged = [];
        const idxByKey = new Map();
        for (const r of (cardRows || [])) {
            const u = (r && r.usage || "").toString();
            const m = (r && r.media || "").toString();
            const s = (r && r.slot || "1").toString();
            const d = (r && r.desc || "").toString();
            const kind = _USAGE_KIND[u] || "";  // 缺陷2: kind 维度参与合并键
            const key = kind + "\x00" + m + "\x00" + s;  // 5b: 去 desc — desc 改为每用途独立
            if (idxByKey.has(key)) {
                const idx = idxByKey.get(key);
                if (u && !merged[idx].usages.includes(u)) {
                    merged[idx].usages.push(u);
                    merged[idx].descs[u] = d;  // 同 desc 重复写, 值不变; 不同 desc 后写覆盖前(实属同 media+slot 不同 desc, 应避免; 但保险)
                }
            } else {
                const descs = {};
                if (u) descs[u] = d;
                idxByKey.set(key, merged.length);
                merged.push({ usages: u ? [u] : [], media: m, slot: s, descs: descs });
            }
        }
        return merged;
    }
    // G1/G2: 复位表单到初始 1 空行 — nameInput 清空 + kind 回 character + 行区清空重建 1 空行
    function resetArchiveForm() {
        nameInput.value = "";
        noteInput.value = "";
        kindChar.checked = true;
        kindScene.checked = false;
        // 清空行区 (DOM + formRows)
        rowsWrap.innerHTML = "";
        formRows.length = 0;
        const r = makeRow();
        rowsWrap.appendChild(r.row);
        formRows.push(r.ctrls);
    }
    // G1: 「正在编辑: {name}」小字 — 紧贴标题; 置空时移除
    function showEditingIndicator(name) {
        if (!title) return;
        let ind = title.querySelector('[data-h3-editing-indicator]');
        if (!name) {
            if (ind && ind.parentNode) ind.parentNode.removeChild(ind);
            return;
        }
        if (!ind) {
            ind = document.createElement("span");
            ind.setAttribute("data-h3-editing-indicator", "1");
            ind.style.cssText = "margin-left:10px;font-size:11px;font-weight:400;color:#f0a040;";
            title.appendChild(ind);
        }
        ind.textContent = "正在编辑: " + name;
    }

    // 刷新: 冲突红字 + 保存按钮禁用条件
    function refreshState() {
        const data = collectFormRows();
        const conflicts = detectRowConflicts(data);
        const conflictSet = new Set(conflicts);
        for (let i = 0; i < formRows.length; i++) {
            const c = formRows[i];
            if (conflictSet.has(i)) {
                c.conflictEl.textContent = "槽位冲突: 同类型同槽位";
                c.conflictEl.style.display = "";
                c.slotSel.style.border = "1px solid #e5534b";
            } else {
                c.conflictEl.textContent = "";
                c.conflictEl.style.display = "none";
                c.slotSel.style.border = "";
            }
        }
        saveBtn.disabled = computeSaveDisabled();
    }

    function computeSaveDisabled() {
        if (!nameInput.value.trim()) return true;
        const data = collectFormRows();
        if (data.length === 0) return true;
        // 全空行丢弃后是否仍空 (B3: 全部空行也算空, 兜底不发请求)
        const kept = data.filter((r) => r.usage || (r.media || "").trim() || (r.desc || "").trim());
        if (kept.length === 0) return true;
        // 任一行: 选了字段但 media/desc 都空 → 禁用
        for (const r of data) {
            if (r.usage && !((r.media || "").trim()) && !((r.desc || "").trim())) return true;
            // 任一行: 有 media 或 desc 但字段未选 → 禁用
            if (!r.usage && (((r.media || "").trim()) || ((r.desc || "").trim()))) return true;
        }
        // I-⑦: 行有 media 无任何 usage 勾选 → 禁用 (按钮态)
        for (const r of data) {
            if (!r.usage && ((r.media || "").trim())) return true;
        }
        // 槽位冲突 → 禁用
        if (detectRowConflicts(data).length > 0) return true;
        // I-⑦: 行 media 扩展名与已勾用途 kind 不符 → 禁用
        for (let i = 0; i < data.length; i++) {
            const r = data[i];
            if (!r.usage || !((r.media || "").trim())) continue;
            if (_rowMediaKindMismatch(r)) return true;
        }
        return false;
    }

    // I-⑦: 行级校验 — media 扩展名与已勾 usage 的 kind 是否匹配
    // 返回 (lineNo, msg) 或 null. 独立可测 (暴露给 .tmp 探针).
    function _rowMediaKindMismatch(row) {
        const usage = row.usage || "";
        const media = (row.media || "").trim();
        if (!usage || !media) return null;
        const expectedKind = _USAGE_KIND[usage];
        if (!expectedKind) return null;
        const lower = media.toLowerCase();
        const exts = POOL_EXTS[expectedKind] || [];
        // 后端 _h3_validate_card 仅校验 slot+usage, 扩展名校验前端独做
        if (!exts.some((e) => lower.endsWith(e.toLowerCase()))) {
            return { usage: usage, expectedKind: expectedKind, exts: exts };
        }
        return null;
    }

    nameInput.addEventListener("input", refreshState);

    // 初始恰 1 行
    const first = makeRow();
    rowsWrap.appendChild(first.row);
    formRows.push(first.ctrls);

    // + 添加一行
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "＋ 添加一行";
    addBtn.style.cssText = "padding:4px 12px;cursor:pointer;align-self:flex-start;font-size:12px;";
    addBtn.onclick = () => {
        const r = makeRow();
        rowsWrap.appendChild(r.row);
        formRows.push(r.ctrls);
        refreshState();
    };
    wrap.appendChild(addBtn);

    // 保存按钮 — G4: collectFormRowsMulti + expandFormRows (展开放 saveBtn.onclick 内)
    //           G2: 成功清空表单 + refreshState; G1: 编辑态改名称 toast warn + 清编辑态
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "保存档案";
    saveBtn.style.cssText = "padding:6px 14px;cursor:pointer;background:#3a3a3e;color:#f0a040;border:1px solid #f0a040;border-radius:3px;align-self:flex-start;";
    saveBtn.onclick = async () => {
        const nm = nameInput.value.trim();
        if (!nm) return;
        const kind = kindChar.checked ? "character" : "scene";
        // G4: collectFormRowsMulti → 全空行过滤 → expand → buildV3CardPayload
        // 批 A6 T7: rowsMulti 已改 descs 字典, r.desc 恒 undefined → 该过滤条件删除
        const rowsMulti = collectFormRowsMulti();
        const nonEmpty = rowsMulti.filter((r) =>
            (r.usages && r.usages.length) || (r.media || "").trim());
        const expanded = expandFormRows(nonEmpty);
        // I-⑦: 保存校验 — 行有 media 无任何 usage 勾选 → 报错
        for (let i = 0; i < nonEmpty.length; i++) {
            const r = nonEmpty[i];
            const hasUsage = r.usages && r.usages.length;
            if (!hasUsage && (r.media || "").trim()) {
                toast("error", "H3 v3 档案", "第" + (i + 1) + "行: 已选素材但未勾选字段");
                return;
            }
        }
        // I-⑦: 保存校验 — media 扩展名与已勾用途 kind 不符 → 报错
        for (let i = 0; i < nonEmpty.length; i++) {
            const r = nonEmpty[i];
            for (const u of (r.usages || [])) {
                const lower = (r.media || "").toLowerCase().trim();
                if (!lower) continue;
                const expectedKind = _USAGE_KIND[u];
                if (!expectedKind) continue;
                const exts = POOL_EXTS[expectedKind] || [];
                if (!exts.some((e) => lower.endsWith(e.toLowerCase()))) {
                    toast("error", "H3 v3 档案",
                          "第" + (i + 1) + "行: 素材类型与字段不符 (期望 " + expectedKind + ")");
                    return;
                }
            }
        }
        const payload = buildV3CardPayload(expanded, nm, kind);
        // I-②: note 注入走调用侧 (buildV3CardPayload 禁改 — v1 哨兵)
        // 后端 _h3_validate_card 对未知 top-level 字段不做拦截; note 落到 .h3_assets.json
        // 列表 buildAssetRow 渲染时读 card.note 显示灰字
        const noteVal = (noteInput && noteInput.value || "").trim();
        if (noteVal) payload.card.note = noteVal;
        else delete payload.card.note;
        // I-⑥: 跨类重名拦截 — v3 档案保存时若与现有非 v3 卡同名 → 报错不保存
        if (assetsByName && assetsByName[nm] && assetsByName[nm]._v !== 3) {
            toast("error", "H3 v3 档案", "与资产库(v1)中的「" + nm + "」重名, 请改名");
            return;
        }
        // 批 K2: 保存前自动入库 — 对 card.rows 中每行 row.media, 若不在 asset_library/archive_images 内
        //   则调 POST /h3_batch/asset_copy 复制进库内; 库内路径含 "asset_library" 且含 "archive_images"
        //   即视为已在库(简单字符串判断)。同名同内容幂等返同路径; 同名不同内容自动 _1 后缀。
        //   失败行保留原路径, 不阻断保存; 全部处理完再 POST /h3_batch/assets, 用改写后的 rows。
        // 批 L2: 失败汇总从「只显示首个」改为「列出全部失败文件 + 原因」(前 5 条 + 余条计数),
        //   解决 v3 保存含库外图时仅 copyErrors.push 静默 → 卡片存库外原路径的隐性 bug.
        const copyErrors = [];
        const cardRows = (payload && payload.card && Array.isArray(payload.card.rows)) ? payload.card.rows : [];
        for (let i = 0; i < cardRows.length; i++) {
            const row = cardRows[i];
            const src = (row && row.media || "").toString().trim();
            if (!src) continue;
            if (src.indexOf("asset_library") >= 0 && src.indexOf("archive_images") >= 0) continue;
            const baseName = src.replace(/\\/g, "/").split("/").pop() || src;
            try {
                const cr = await api.fetchApi("/h3_batch/asset_copy", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ src: src, archive_name: nm, suggest_name: baseName }),
                });
                const cj = await cr.json();
                if (!cr.ok || cj.error || !cj.path) {
                    copyErrors.push({ file: baseName, reason: (cj && cj.error) || ("HTTP " + cr.status) });
                } else {
                    row.media = cj.path;
                }
            } catch (e) {
                copyErrors.push({ file: baseName, reason: (e && e.message) ? e.message : String(e) });
            }
        }
        try {
            const r = await api.fetchApi("/h3_batch/assets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const j = await r.json();
            if (!r.ok || j.error) { toast("error", "H3 v3 档案", "保存失败: " + (j.error || ("HTTP " + r.status))); return; }
            // 批 L2: 自动入库失败提示 — 列出全部失败文件 + 原因 (前 5 条 + 余条计数), 不再静默
            if (copyErrors.length) {
                const lines = copyErrors.slice(0, 5).map((x) => x.file + ": " + x.reason);
                const more = copyErrors.length > 5 ? " (还有 " + (copyErrors.length - 5) + " 条)" : "";
                toast("warn", "H3 资产库",
                      copyErrors.length + " 张图片未入库(保留原路径): " + lines.join(" | ") + more);
            }
            // G1: 编辑中改名称 → 成功 toast 报"另存为新卡; 原卡保留" (放成功后, 失败分支不误导)
            const wasEditing = editingCard;
            const nameChangedDuringEdit = !!(wasEditing && wasEditing !== nm);
            toast("success", "H3 v3 档案", "已保存: " + nm + " (共 " + j.count + " 张)");
            if (nameChangedDuringEdit) {
                toast("warn", "H3 v3 档案", "名称已改，已另存为新卡；原卡「" + wasEditing + "」保留");
            }
            loadAssets();
            // G2: 成功分支清空表单 (name + kind 回默认 + 行区复位 1 空行)
            // G1: 清编辑态; 失败/异常分支保持原状
            setEditingCard(null);
            showEditingIndicator(null);
            resetArchiveForm();
            refreshState();
        } catch (e) {
            toast("error", "H3 v3 档案", "保存失败: " + (e && e.message ? e.message : e));
        }
    };

    // G1: editArchiveToForm — 在 buildV3ArchiveForm 闭包内 (B3), 构建时挂模块级句柄供 buildAssetRow 编辑按钮消费
    //   行为: nameInput 设值 + kind radio 勾选 + 行区清空按 Z4 合并键回填 (每行多勾/媒体/槽位/描述) + switchTab + toast
    function editArchiveToForm(name, card) {
        if (!card || card._v !== 3) return;  // 仅 v3 卡可编辑
        nameInput.value = name;
        noteInput.value = (card && card.note) ? String(card.note) : "";  // I-② note 回填
        kindChar.checked = (card.kind === "character");
        kindScene.checked = (card.kind === "scene");
        // 清空行区
        rowsWrap.innerHTML = "";
        formRows.length = 0;
        // Z4 合并: (kind=由 _USAGE_KIND[usage] 决定, media, slot) 三同 → 合并为一行多勾 (5b: desc 去重键, 每用途独立 desc)
        // 卡内 row 直接给出 (usage, media, slot, desc); kind 由 _USAGE_KIND[usage] 推
        const cardRows = (card.rows || []).filter((r) => r && (r.usage || (r.media || "").trim() || (r.desc || "").trim()));
        const merged = mergeCardRowsForEdit(cardRows);
        for (const m of merged) {
            const r = makeRow();
            rowsWrap.appendChild(r.row);
            formRows.push(r.ctrls);
            // 勾选多个用途
            for (const u of (m.usages || [])) {
                if (r.ctrls.usageChecks[u]) r.ctrls.usageChecks[u].checked = true;
            }
            // 模拟首勾副作用: slotSel 域按首勾 kind; desc 输入框走 syncDescsBox (5b 动态生成)
            // onCheckChange 在 makeRow 闭包内不可外取, 故手动同步 slotSel + 调 ctrls.syncDescsBox
            const fk = r.ctrls.firstCheckedKind();
            if (fk) {
                const max = POOL_SLOTS[fk] || 9;
                r.ctrls.slotSel.innerHTML = "";
                for (let i = 1; i <= max; i++) r.ctrls.slotSel.appendChild(new Option("槽 " + i, String(i)));
                r.ctrls.slotSel.value = (m.slot && parseInt(m.slot, 10) >= 1 && parseInt(m.slot, 10) <= max) ? m.slot : "1";
                r.ctrls.slotSel.disabled = false;
            }
            // 5b: 按已勾选用途动态生成 desc 输入框 (标签固定不可删, 内容可空)
            r.ctrls.syncDescsBox();
            // 设 media (必须在 refreshMediaBox 之前)
            r.ctrls.media.media = (m.media || "").toString();
            r.ctrls.refreshMediaBox();
            // 5b: 设 descs — 每勾选用途独立 desc (m.descs = {usageId: text}, 由 mergeCardRowsForEdit 产出)
            for (const u of (m.usages || [])) {
                const item = r.ctrls.descsById[u];
                if (item && item.ta) item.ta.value = ((m.descs && m.descs[u]) || "").toString();
            }
            // 更新禁用态 (同 kind 约束)
            r.ctrls.updateDisabledState();
        }
        if (merged.length === 0) {
            // rows 全空 (罕见 — 一行 usage/media/desc 全空) → 1 空行
            const r = makeRow();
            rowsWrap.appendChild(r.row);
            formRows.push(r.ctrls);
        }
        // 编辑态: 模块级 editingCard + 标识 DOM
        setEditingCard(name);
        showEditingIndicator(name);
        switchTab("assets");
        toast("info", "H3 档案", "正在编辑: " + name + "，保存后覆盖原卡");
        refreshState();
    }
    // B3: 构建时挂模块级句柄 (editArchiveHandler 由 buildAssetRow 编辑按钮消费)
    setEditArchiveHandler((name, card) => editArchiveToForm(name, card));
    wrap.appendChild(saveBtn);

    refreshState();
    return wrap;
}

// ============================================================================
// 5. 分配器 DOM 薄封装 — assignArchiveToFormDOM + applyTopAssignmentToForm
// ============================================================================

// T3: 单档案分配 DOM 薄封装
function assignArchiveToFormDOM(name, card) {
        const state = snapshotFormState();
        if (card && card._v === 3 && card.kind === "character") {
            // v3 角色档案 — 调 批 H3 抽出的 helper (跳过 desc 追加; desc 只进 Subject 行)
            const resultNoDesc = assignArchiveToFormNoDesc(card, state);
            applyStateToFormDOM(name, resultNoDesc);
            if (resultNoDesc.filled.length) {
                switchTab("pool");
                toast("info", "H3 资产", "已分配(角色档案, 描述进 Subject 行): " + name);
            }
            return;
        }
    const result = assignArchiveToForm(card, state);
    applyStateToFormDOM(name, result);
    if (result.filled.length || (result.globalPrompt && result.globalPrompt !== state.globalPrompt)) {
        switchTab("pool");
        toast("info", "H3 资产", "已分配: " + name);
    }
}

// T8 批3 (任务⑥): 顶层「分配到表单」按钮
function applyTopAssignmentToForm() {
    const roleName = assignRoleSelect && assignRoleSelect.value;
    const sceneName = assignSceneSelect && assignSceneSelect.value;
    if (!roleName && !sceneName) {
        toast("warn", "H3 资产", "请先在本批角色/本批场景下拉各选一个 v3 档案");
        return;
    }
    let state = snapshotFormState();
    for (const nm of [roleName, sceneName]) {
        if (!nm) continue;
        const card = assetsByName[nm];
        if (!card || card._v !== 3) continue;
        // C2: 绑定卡跳过 desc 追加 (同 assignArchiveToFormDOM 路径)
        if (card.kind === "character" && castBindings.some((b) => b && b.name === nm)) {
            const resultNoDesc = assignArchiveToFormNoDesc(card, state);
            applyStateToFormDOM(nm, resultNoDesc);
            state = { pool: resultNoDesc.pool,
                      pool_usage: resultNoDesc.pool_usage,
                      globalPrompt: state.globalPrompt };
            continue;
        }
        const result = assignArchiveToForm(card, state);
        applyStateToFormDOM(nm, result);
        state = { pool: result.pool, pool_usage: result.pool_usage, globalPrompt: result.globalPrompt };
    }
    switchTab("pool");
    toast("info", "H3 资产", "层3 分配完成");
}

// ============================================================================
// 6. 跨域导出
// ============================================================================

// 1.14a T5: 按媒体标识查 pose 卡的 pose_style — 分配器反查用
// T4 Step6 消费场景: applyStateToFormDOM 写入 f.value 的同 media, 找对应 pose 行的样式
// 找不到 (非 pose 媒体 / 不在档案库) → 返 undefined; 引擎侧兜底为 skeleton
function lookupCardPoseStyle(media) {
    if (!media || typeof media !== "string") return undefined;
    const key = media.trim();
    if (!key) return undefined;
    const cards = (typeof assetsByName !== "undefined" && assetsByName) || {};
    for (const name of Object.keys(cards)) {
        const card = cards[name];
        if (!card || card._v !== 3) continue;
        const rows = (card.rows || []).filter((r) => r && r.usage === "pose");
        for (const r of rows) {
            if ((r.media || "").toString().trim() === key) {
                return r.pose_style || "skeleton";
            }
        }
    }
    return undefined;
}

export {
    buildAssetsSection, loadAssets, renderAssetList, recoverCorruptAssets,
    refreshAssignDropdowns, buildAssetRow,
    saveCardAsAsset, importAsset,
    buildV3ArchiveForm, deleteAsset, deleteAssetAndPurge,
    buildSaveCardPayload, computeImportResult, appendPromptText,
    detectRowConflicts, computeAssignResult,
    assignArchiveToForm, assignArchiveToFormNoDesc,
    assignArchiveToFormDOM, applyTopAssignmentToForm,
    lookupCardPoseStyle,
};