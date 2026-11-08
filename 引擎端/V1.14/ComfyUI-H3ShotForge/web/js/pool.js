// V1.9 D1 拆分: 素材池域 — 池卡片/槽位/用途胶囊/音频栏/覆盖按钮
// 依赖: main.js (state + utils)
import {
    POOL_KEYS, POOL_SLOTS, POOL_EXTS,
    USAGE_OPTIONS, USAGE_BY_KIND, USAGE_SHORT_LABEL, _USAGE_KIND,
    poolInputs, poolUsageSets, poolPillEls, pic9Input,
    schedulePreviewAll, onBindingSlotCleared, syncPillsVisual,
    sectionBox, setPic9Input,
} from "./main.js";
import { openPicker } from "./path_picker.js";

// ============================================================================
// 1. 池区域构建
// ============================================================================

// V1.4 T6b: 素材池单 kind 区(Picture/Video/Audio), 内部为 3 列网格卡片
function buildPoolSection(key) {
    let title;
    if (key === "Picture") title = "Picture · 9 槽 (缩略图点击选图, 用途可多选)";
    else if (key === "Video") title = "Video · 3 槽 (视频·动作参考)";
    else title = "Audio · 3 槽 (音频参考)";
    const box = sectionBox(title);
    const grid = document.createElement("div");
    // Picture 9 槽 / Video 3 槽 / Audio 3 槽 一律 3 列网格, 卡内布局统一
    grid.style.cssText = "display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;max-width:100%;box-sizing:border-box;";
    box.appendChild(grid);

    const inputs = [];
    const usageSets = [];
    const pillLists = [];
    for (let i = 1; i <= POOL_SLOTS[key]; i++) {
        const built = buildPoolCard(key, i);
        grid.appendChild(built.card);
        inputs.push(built.inp);
        usageSets.push(built.usageSet);
        pillLists.push(built.pills);
        if (key === "Picture" && i === 9) setPic9Input(built.inp);
    }
    poolInputs[key] = inputs;
    poolUsageSets[key] = usageSets;
    poolPillEls[key] = pillLists;
    return box;
}

// V1.4 T6c: 单张池卡 — Picture/Video 走缩略图卡 (4:3 + contain), Audio 走紧凑横条 (无缩略图)
function buildPoolCard(key, slotIdx) {
    // V1.4 T6c: Audio 重构为横条 — 音频无可视素材, 不用缩略图, 改为 [input + 📁 + ✕ + 胶囊] 一行
    if (key === "Audio") return buildAudioBar(key, slotIdx);

    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #555;border-radius:6px;padding:6px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:5px;";

    // 缩略图区 — V1.4 T6c: 固定 4:3 比例 + contain, 完整可视不裁剪 (比例不合留深色边)
    const imgWrap = document.createElement("div");
    imgWrap.style.cssText = "position:relative;width:100%;aspect-ratio:4/3;cursor:pointer;border:1px dashed #666;border-radius:4px;overflow:hidden;background:#1a1a1e;display:flex;align-items:center;justify-content:center;";
    const placeholder = document.createElement("div");
    placeholder.textContent = "槽 " + slotIdx + " · 点此选图";
    placeholder.style.cssText = "color:#666;font-size:11px;text-align:center;";
    imgWrap.appendChild(placeholder);
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = key + " 槽 " + slotIdx;
    img.title = "点击重新选择" + key + "素材";
    img.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;background:#1a1a1e;";  // V1.4 T6c: cover → contain
    imgWrap.appendChild(img);
    // ✕ 角标 — 悬浮清空, 仅该槽有内容时显示
    const xBtn = document.createElement("span");
    xBtn.textContent = "✕";
    xBtn.title = "清空此槽";
    xBtn.style.cssText = "position:absolute;top:2px;right:2px;width:18px;height:18px;line-height:18px;text-align:center;background:rgba(170,34,51,.9);border-radius:50%;font-size:11px;color:#fff;cursor:pointer;display:none;";
    imgWrap.appendChild(xBtn);

    // 文件名输入行 — 保留手输能力(用户拍板"三路都刷新缩略图")
    const inp = document.createElement("input");
    inp.placeholder = "文件名 (含扩展名)";
    inp.style.cssText = "width:100%;padding:3px 6px;box-sizing:border-box;font-size:11px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;";

    // 用途胶囊组 — 按 kind 过滤, checkbox 风格(选中=描边高亮)
    const pillBox = document.createElement("div");
    pillBox.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;";
    const usageSet = new Set();
    const pills = [];
    const allowedIds = USAGE_BY_KIND[key] || [];
    const baseStyle = "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;";
    const onStyle  = baseStyle + "background:rgba(240,160,64,.18);color:#f0a040;border:1px solid #f0a040;";
    const offStyle = baseStyle + "background:#1a1a1e;color:#aaa;border:1px solid #555;";
    for (const opt of USAGE_OPTIONS) {
        if (!allowedIds.includes(opt.id)) continue;
        // 1.14a T4: 9 号槽不出 pose 胶囊 (R7: 9 号=动态衔接槽, 引擎侧黄条兜底; UI 双保险)
        if (slotIdx === 9 && opt.id === "pose") continue;
        const pill = document.createElement("span");
        pill.textContent = opt.label;
        pill.dataset.usageId = opt.id;
        pill.title = "点击切换: 此素材的用途(" + opt.label + ")";
        pill.style.cssText = offStyle;
        pill.onclick = () => {
            if (usageSet.has(opt.id)) {
                usageSet.delete(opt.id);
                pill.style.cssText = offStyle;
            } else {
                // 1.14a T4: 姿势互斥 (决策 2) — 勾 pose 清空同槽其他用途; 勾其他自动摘 pose
                if (opt.id === "pose") usageSet.clear();
                else usageSet.delete("pose");
                usageSet.add(opt.id);
                pill.style.cssText = onStyle;
            }
            // 互斥置灰: 互斥切换后其他胶囊要刷新视觉 (原 onclick 只改自己 style)
            // 1.14a T4: 复用 syncPillsVisual (main.js 现有批量刷新, 硬编码 on/off style)
            syncPillsVisual(pillBox.querySelectorAll("[data-usage-id]"), usageSet);
            refreshPoseLock(pillBox, usageSet);
            // 1.14a T4: 勾 pose → 自动落默认样式 skeleton (T1 解析层缺省兜底口径)
            if (usageSet.has("pose") && !getPoseStyle(slotIdx)) setPoseStyle(slotIdx, "skeleton");
            const styleToggle = pillBox._poseStyleToggle;
            if (styleToggle) styleToggle.sync(usageSet.has("pose"));
            // 批 B-0 节点 0 修: Picture 池用途胶囊 → 即时联动预览刷新
            schedulePreviewAll();
        };
        pillBox.appendChild(pill);
        pills.push(pill);
    }

    // 1.14a T4: 槽内 样式开关 (骨架/深度), 仅 9 号槽不渲染 (与胶囊跳过对齐)
    let styleToggle = null;
    if (key === "Picture" && slotIdx !== 9) {
        styleToggle = buildPoseStyleToggle(
            () => getPoseStyle(slotIdx),
            (v) => { setPoseStyle(slotIdx, v); schedulePreviewAll();
                     if (styleToggle) styleToggle.sync(usageSet.has("pose")); });
        pillBox._poseStyleToggle = styleToggle;
        styleToggle.sync(usageSet.has("pose"));
        pillBox.appendChild(styleToggle);
    }

    card.appendChild(imgWrap);
    card.appendChild(inp);
    card.appendChild(pillBox);

    // 缩略图同步刷新闭包 — 三路(选择/手输/清空)统一入口
    const refreshThumb = () => {
        const v = inp.value.trim();
        if (v) {
            imgWrap.style.display = "";  // V1.4 T8 (登记 T6): 有值时占位框可见 (onerror 不再隐藏框, 此行保留以防外层 cssText 改动)
            img.src = "/h3_batch/thumb?path=" + encodeURIComponent(v);
            img.style.display = "";
            placeholder.style.display = "none";
            imgWrap.style.borderStyle = "solid";
            // onload 才显示角标(避免初始 src 加载失败时误显); onerror 占位回退
        } else {
            img.removeAttribute("src");
            img.style.display = "none";
            imgWrap.style.display = "";  // V1.4 T8 (登记 T6): 空槽时占位框可见 (保留"点此选图"提示)
            placeholder.textContent = "槽 " + slotIdx + " · 点此选图";
            placeholder.style.display = "";
            imgWrap.style.borderStyle = "dashed";
            xBtn.style.display = "none";
        }
    };
    img.onload = () => { xBtn.style.display = ""; placeholder.style.display = "none"; };
    img.onerror = () => {
        xBtn.style.display = "none";
        img.style.display = "none";
        // 缩略图 404 → 保留占位框 + 明确"无预览·点此重选"提示 (不再连框一起隐藏)
        // (空槽"点此选图"提示由 refreshThumb 的 else 分支保证, 不受 onerror 影响)
        // 文案风格与 :2479 mediaBox "无预览·点此选" 保持一致 (都是 onerror 兜底, 不是空槽)
        imgWrap.style.display = "";
        placeholder.textContent = "槽 " + slotIdx + " · 无预览(文件不存在?)点此重选";
        placeholder.style.display = "";
        imgWrap.style.borderStyle = "dashed";
    };
    // 整张缩略图区点击 = openPicker (复用既有配置)
    imgWrap.onclick = (e) => {
        if (e.target === xBtn) return;
        openPicker({
            kind: "file",
            exts: POOL_EXTS[key],
            onPick: (p) => { inp.value = p; refreshThumb(); },
            nativePick: null,
            title: "选择" + key + " 素材",
            current: inp.value,
        });
    };
    xBtn.onclick = (e) => {
        e.stopPropagation();
        inp.value = "";
        refreshThumb();
        // 批 H2-2 fix (批 H 真机对拍): 清池联动 — 素材池 xBtn 清空时调 onBindingSlotCleared
        // 由 upsertBindingFromCard 写入 inp._bindingOwner (绑定的卡名 + 槽号), 此处直读
        if (inp._bindingOwner) {
            onBindingSlotCleared(inp._bindingOwner.name, inp._bindingOwner.idx);
        }
    };
    inp.addEventListener("input", () => {
        refreshThumb();
        // 批 H2-2 fix (批 H 真机对拍): 输入框手输清空也走清池联动 (覆盖用户手输覆盖素材后清空场景)
        if (!inp.value.trim() && inp._bindingOwner) {
            onBindingSlotCleared(inp._bindingOwner.name, inp._bindingOwner.idx);
        }
    });
    inp._refreshThumb = refreshThumb;

    return { card, inp, usageSet, pills };
}

// V1.4 T6c: Audio 横条 — [文件名 input + 📁 + ✕ + 用途胶囊] 紧凑一行, 音频无缩略图
// 返回结构与 buildPoolCard 一致 ({card,inp,usageSet,pills}), 外部调用零改动
function buildAudioBar(key, slotIdx) {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #555;border-radius:6px;padding:8px;background:rgba(255,255,255,.03);display:flex;align-items:center;gap:6px;";

    // 文件名输入 — 与图片卡同款 (手输能力保留, collectData/fillForm/resetForm 三链路共享)
    const inp = document.createElement("input");
    inp.placeholder = "文件名 (含扩展名)";
    inp.style.cssText = "flex:1;min-width:0;padding:3px 6px;box-sizing:border-box;font-size:12px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;";

    // 📁 选择按钮 — 触发 openPicker, 复用既有图片选择器配置
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.textContent = "📁";
    pickBtn.title = "选择" + key + " 素材";
    pickBtn.style.cssText = "flex:none;width:28px;height:28px;padding:0;font-size:14px;cursor:pointer;background:#2a2a2e;color:#e6e6e6;border:1px solid #555;border-radius:3px;line-height:24px;text-align:center;";
    pickBtn.onclick = (e) => {
        e.stopPropagation();
        openPicker({
            kind: "file",
            exts: POOL_EXTS[key],
            onPick: (p) => { inp.value = p; },
            nativePick: null,
            title: "选择" + key + " 素材",
            current: inp.value,
        });
    };

    // ✕ 清空按钮 — Audio 横条角标替代, 显式可点
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "✕";
    clearBtn.title = "清空此槽";
    clearBtn.style.cssText = "flex:none;width:28px;height:28px;padding:0;font-size:12px;cursor:pointer;background:#2a2a2e;color:#aaa;border:1px solid #555;border-radius:3px;line-height:24px;text-align:center;";
    clearBtn.onclick = (e) => {
        e.stopPropagation();
        inp.value = "";
        // 交付前审查 FE-P1-3: Audio ✕ 联动 onBindingSlotCleared (与 Picture 卡 buildPoolCard 同款,
        //   批 H2-2 fix 之后 Picture 路径已有, Audio 横条未挂 — 现补齐).
        if (inp._bindingOwner) {
            onBindingSlotCleared(inp._bindingOwner.name, inp._bindingOwner.idx);
        }
    };

    // 用途胶囊 — Audio 仅 audio_ref (单元素, 与 Picture/Video 同 USAGE_BY_KIND 机制)
    const pillBox = document.createElement("div");
    pillBox.style.cssText = "display:flex;flex-wrap:nowrap;gap:3px;flex:none;";
    const usageSet = new Set();
    const pills = [];
    const allowedIds = USAGE_BY_KIND[key] || [];
    const baseStyle = "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;";
    const onStyle  = baseStyle + "background:rgba(240,160,64,.18);color:#f0a040;border:1px solid #f0a040;";
    const offStyle = baseStyle + "background:#1a1a1e;color:#aaa;border:1px solid #555;";
    for (const opt of USAGE_OPTIONS) {
        if (!allowedIds.includes(opt.id)) continue;
        const pill = document.createElement("span");
        pill.textContent = opt.label;
        pill.dataset.usageId = opt.id;
        pill.title = "点击切换: 此素材的用途(" + opt.label + ")";
        pill.style.cssText = offStyle;
        pill.onclick = () => {
            if (usageSet.has(opt.id)) {
                usageSet.delete(opt.id);
                pill.style.cssText = offStyle;
            } else {
                usageSet.add(opt.id);
                pill.style.cssText = onStyle;
            }
            // 批 B-0 节点 0 修: Audio 横条用途胶囊 → 即时联动预览刷新
            // (与 Picture 池卡同款问题顺手修; 对齐其他控件 schedulePreviewAll)
            schedulePreviewAll();
        };
        pillBox.appendChild(pill);
        pills.push(pill);
    }

    card.appendChild(inp);
    card.appendChild(pickBtn);
    card.appendChild(clearBtn);
    card.appendChild(pillBox);

    // 交付前审查 FE-P1-3: Audio 手输清空联动 onBindingSlotCleared (与 Picture 卡 buildPoolCard 同款,
    //   覆盖用户手输覆盖素材后清空场景 — 此前 buildAudioBar 无 input 监听).
    inp.addEventListener("input", () => {
        if (!inp.value.trim() && inp._bindingOwner) {
            onBindingSlotCleared(inp._bindingOwner.name, inp._bindingOwner.idx);
        }
    });

    // Audio 无缩略图: inp._refreshThumb 不挂载, resetForm 中 `if (inp._refreshThumb)` 自然跳过
    return { card, inp, usageSet, pills };
}

// 在被跳过槽位的 input 旁挂「覆盖」按钮 (按 kind+idx 唯一锚定, 已存在则不重复挂)
function attachOverrideButton(kind, idx, value, usages, cardName) {
    const inp = poolInputs[kind] && poolInputs[kind][idx - 1];
    if (!inp) return;
    const card = inp.parentElement;
    if (!card) return;
    const sel = '.h3-override-btn[data-kind="' + kind + '"][data-idx="' + idx + '"]';
    if (card.querySelector(sel)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "覆盖 (" + cardName + ")";
    btn.className = "h3-override-btn";
    btn.dataset.kind = kind;
    btn.dataset.idx = String(idx);
    btn.title = "用资产 " + cardName + " 的预设覆盖此槽, 并勾选用途";
    btn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(240,160,64,.15);color:#f0a040;border:1px solid #f0a040;border-radius:3px;margin-top:4px;align-self:flex-start;";
    btn.onclick = () => {
        inp.value = value;
        if (inp._refreshThumb) inp._refreshThumb();
        const set = poolUsageSets[kind] && poolUsageSets[kind][idx - 1];
        const pills = poolPillEls[kind] && poolPillEls[kind][idx - 1];
        if (set) {
            for (const u of usages) set.add(u);
            if (pills) syncPillsVisual(pills, set);
        }
        btn.remove();
    };
    card.appendChild(btn);
}

// ============================================================================
// 2. 跨域导出
// ============================================================================

// syncPillsVisual 在 main.js (cycle-break 集中点); pool.js 这里 re-export 出来, 让
// assets.js/bindings.js 可以从 pool.js 拉, 也可以从 main.js 拉, 路径等价.

// 1.14a T4: 姿势样式模块态 — 单向归属 pool.js (L6: 状态不外露, 仅导读写)
const _poolPoseStyle = { Picture: {} };

function getPoseStyle(slotIdx) {
    return _poolPoseStyle.Picture[String(slotIdx)] || null;
}

function setPoseStyle(slotIdx, val) {
    const k = String(slotIdx);
    if (val == null) {
        delete _poolPoseStyle.Picture[k];
    } else {
        _poolPoseStyle.Picture[k] = val;
    }
}

// 只返回单 pose 槽的样式映射 {槽号: "skeleton"|"depth"}; 非 pose 槽过滤
function readPoolPoseStyles() {
    const out = {};
    for (const [k, v] of Object.entries(_poolPoseStyle.Picture)) {
        if (v) out[k] = v;
    }
    return out;
}

// 1.14a T4: 姿势互斥置灰 (L5: 沿用既有 [data-usage-id] 选择器 + .usage-locked 类)
function refreshPoseLock(pillBox, usageSet) {
    const hasPose = usageSet.has("pose");
    pillBox.querySelectorAll("[data-usage-id]").forEach((el) => {
        const id = el.dataset.usageId;
        el.classList.toggle("usage-locked",
            hasPose ? id !== "pose" : (id === "pose" && usageSet.size > 0));
    });
}

// 1.14a T4: 样式开关 (骨架/深度) — 调用方持有 wrap, sync/刷新由调用方统一触发
function buildPoseStyleToggle(getStyle, setStyle) {
    const wrap = document.createElement("span");
    wrap.className = "pose-style-toggle";
    wrap.style.cssText = "display:none;margin-left:4px;";
    const defs = [["skeleton", "骨架"], ["depth", "深度"]];
    for (const [val, label] of defs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.dataset.poseStyle = val;
        btn.style.cssText = "padding:1px 6px;font-size:10px;border-radius:8px;cursor:pointer;"
            + "background:#1a1a1e;color:#aaa;border:1px solid #555;margin-right:2px;";
        btn.onclick = () => setStyle(val);
        wrap.appendChild(btn);
    }
    wrap.sync = (hasPose) => {
        const cur = getStyle() || "skeleton";
        [...wrap.children].forEach((b, i) => b.classList.toggle(
            "active", defs[i][0] === cur));
        wrap.style.display = hasPose ? "" : "none";
    };
    return wrap;
}

export { buildPoolSection, buildPoolCard, buildAudioBar, attachOverrideButton,
         getPoseStyle, setPoseStyle, readPoolPoseStyles, refreshPoseLock,
         buildPoseStyleToggle };