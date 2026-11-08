import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { openPicker } from "./path_picker.js";

const NODE_CLASS = "H3QuickShot";
const WIDGET_NAME = "shot_1";

// 与后端 quick_shot.py SHOT_KEYS 保持一致(shot_vocab.STRUCT_FIELDS)
const STRUCT_FIELDS = ["镜头角度", "景别", "运镜方式", "运镜方向", "运镜幅度", "运镜速度", "焦段", "氛围", "情绪"];
const KINDS = ["Picture", "Video", "Audio"];
const KIND_LABELS = { Picture: "🖼 图", Video: "🎬 视频", Audio: "🔊 音频" };
// ui-thumb-cache2: 与 csv_form.js POOL_EXTS 保持完全一致 (格式集对齐 ComfyUI 官方支持)
const KIND_EXTS = {
    Picture: [".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff"],
    Video: [".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv"],
    Audio: [".wav", ".mp3", ".flac", ".aac", ".aiff", ".m4a", ".ogg", ".opus", ".mp4", ".webm", ".mov"],
};

const extKind = (name) => {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    if (!m) return null;
    const ext = "." + m[1].toLowerCase();
    for (const k of KINDS) if (KIND_EXTS[k].includes(ext)) return k;
    return null;
};

function toast(severity, summary, detail) {
    const t = app.extensionManager?.toast?.add;
    if (t) t({ severity, summary, detail });
    else console.log(`[H3QuickShot] ${summary} ${detail ?? ""}`);
}

// Electron >= 32 弃用 file.path, 优先 webUtils.getPathForFile(复制自 batch_renderer.js, 保持互不依赖)
function getFilePath(file) {
    if (window.webUtils?.getPathForFile) {
        try {
            const p = window.webUtils.getPathForFile(file);
            if (p) return p;
        } catch (e) { /* 回退到 file.path */ }
    }
    return file.path || null;
}

// 拖放命中判断: 只在自己节点上拦截, 不吞掉画布/其它节点的拖放(复制自 batch_renderer.js)
function isDropOnNode(node, e) {
    if (app.dragOverNode === node) return true;
    if (node.isPointInside && node.isPointInside(e.clientX, e.clientY)) return true;
    const pos = node.pos, size = node.size;
    if (!pos || !size) return false;
    return e.clientX >= pos[0] && e.clientX <= pos[0] + size[0]
        && e.clientY >= pos[1] && e.clientY <= pos[1] + size[1];
}

// ---- shot_1 widget 文本 <-> {globals, shots}(新格式单块 JSON; 旧 \n\n 分块回落, 与 quick_shot.quick_payload 一致) ----

const DEFAULT_GLOBALS = { "比例": "16:9", "质量": "0.4", "步数": "8V8A", "提示词": "", "语言": "中文" };  // 2.9: 加批级语言默认

function parseShots(text) {
    const out = [];
    for (const block of (text || "").split("\n\n")) {
        const s = block.trim();
        if (!s) continue;
        try {
            const obj = JSON.parse(s);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
        } catch (e) {
            out.push({ prompt: s });
        }
    }
    return out;
}

function parsePayload(text) {
    try {
        const obj = JSON.parse(text || "");
        if (obj && typeof obj === "object" && !Array.isArray(obj) && Array.isArray(obj.shots)) {
            const g = Object.fromEntries(Object.entries((obj.globals && typeof obj.globals === "object") ? obj.globals : {}).filter(([, v]) => v));
            return { globals: { ...DEFAULT_GLOBALS, ...g }, shots: obj.shots.filter((s) => s && typeof s === "object") };
        }
        if (Array.isArray(obj)) return { globals: { ...DEFAULT_GLOBALS }, shots: obj.filter((s) => s && typeof s === "object") };
    } catch (e) { /* 旧分块格式 */ }
    return { globals: { ...DEFAULT_GLOBALS }, shots: parseShots(text) };
}

function setPayload(node, globals, shots) {
    const w = (node.widgets || []).find((x) => x.name === WIDGET_NAME);
    if (!w) { toast("error", "H3 Quick", `未找到 ${WIDGET_NAME} widget`); return false; }
    w.value = JSON.stringify({ globals, shots });
    node.setDirtyCanvas?.(true, true);
    return true;
}

// ---- 弹窗编辑器(自建 overlay, 不依赖 csv_form.js 内部函数) ----

let editorOv = null;
let cardsEl = null;
let globalsEl = null;
let vocab = null;
let editorState = null; // { node }

async function loadVocab() {
    if (vocab) return vocab;
    try {
        vocab = await (await api.fetchApi("/h3_batch/vocab", { cache: "no-store" })).json();
    } catch (e) {
        vocab = {};
    }
    return vocab;
}

function fieldRow(label, control, field) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:flex-start;margin-bottom:5px;";
    const lab = document.createElement("span");
    lab.textContent = label;
    lab.style.cssText = "flex:none;width:72px;padding-top:4px;color:#cfcfcf;";
    control.style.flex = "1";
    if (field) control.dataset.field = field;
    control.style.boxSizing = "border-box";
    row.appendChild(lab);
    row.appendChild(control);
    return row;
}

function textInput(value, placeholder) {
    const i = document.createElement("input");
    i.type = "text";
    i.placeholder = placeholder || "";
    i.style.cssText = "padding:4px 8px;";
    i.value = value ?? "";
    return i;
}

function vocabSelect(field, value) {
    const s = document.createElement("select");
    s.style.cssText = "padding:4px 6px;";
    const opts = (vocab && vocab[field]) || [];
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "(不填)";
    s.appendChild(empty);
    for (const o of opts) {
        const op = document.createElement("option");
        op.value = o;
        op.textContent = o;
        s.appendChild(op);
    }
    s.value = value || "";
    if (s.value !== (value || "")) s.value = "";
    return s;
}

function renumberCards() {
    for (let i = 0; i < cardsEl.children.length; i++)
        cardsEl.children[i].querySelector("span").textContent = `镜头 ${i + 1}`;
}

function selectInput(options, value) {
    const s = document.createElement("select");
    s.style.cssText = "padding:4px 6px;";
    for (const o of options) {
        const op = document.createElement("option");
        op.value = o;
        op.textContent = o;
        s.appendChild(op);
    }
    s.value = options.includes(value) ? value : options[0];
    return s;
}

function globalsBox(g) {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #555;border-radius:6px;padding:10px;margin-bottom:10px;background:#232326;";
    const t = document.createElement("div");
    t.textContent = "全局参数 (Quick 输入模式)";
    t.style.cssText = "font-weight:700;margin-bottom:6px;";
    box.appendChild(t);

    const top = document.createElement("div");
    top.style.cssText = "display:flex;gap:12px;margin-bottom:5px;";
    const ratio = selectInput(["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "21:9"], g["比例"]);
    ratio.dataset.gkey = "比例";
    const qual = document.createElement("input");
    qual.type = "number";
    qual.min = "0.1"; qual.max = "1.0"; qual.step = "0.05";
    qual.style.cssText = "padding:4px 8px;";
    qual.value = g["质量"] ?? "0.4";
    qual.dataset.gkey = "质量";
    const steps = selectInput(["8V8A", "4V8A", "4V20A"], g["步数"]);
    steps.dataset.gkey = "步数";
    // 2.9: 语言 select 特例 — 选项 中文/英文, 默认中文
    const langSel = selectInput(["中文", "英文"], g["语言"] ?? "中文");
    langSel.dataset.gkey = "语言";
    for (const [lab, ctl] of [["比例", ratio], ["质量", qual], ["步数", steps], ["语言", langSel]]) {
        const cell = document.createElement("div");
        cell.style.cssText = "flex:1;display:flex;gap:6px;align-items:center;";
        const l = document.createElement("span");
        l.textContent = lab;
        l.style.cssText = "flex:none;color:#cfcfcf;";
        ctl.style.flex = "1";
        cell.appendChild(l);
        cell.appendChild(ctl);
        top.appendChild(cell);
    }
    box.appendChild(top);

    const gp = document.createElement("textarea");
    gp.rows = 2;
    gp.style.cssText = "padding:4px 8px;resize:vertical;width:100%;box-sizing:border-box;";
    gp.placeholder = "全局提示词(拼在每段提示词前)";
    gp.value = g["提示词"] || "";
    gp.dataset.gkey = "提示词";
    box.appendChild(gp);
    return box;
}

function readGlobals() {
    const g = {};
    for (const el of globalsEl.querySelectorAll("[data-gkey]")) g[el.dataset.gkey] = String(el.value).trim();
    return g;
}

function shotCard(index, shot) {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #555;border-radius:6px;padding:10px;margin-bottom:10px;background:#232326;";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;margin-bottom:6px;";
    const title = document.createElement("span");
    title.textContent = `镜头 ${index + 1}`;
    title.style.cssText = "font-weight:700;flex:1;";
    const del = document.createElement("button");
    del.textContent = "🗑 删除";
    del.style.cssText = "padding:3px 12px;cursor:pointer;";
    del.onclick = () => { card.remove(); renumberCards(); };
    head.appendChild(title);
    head.appendChild(del);
    card.appendChild(head);

    card.appendChild(fieldRow("ID", textInput(shot.ID, "shot_001(留空自动)"), "ID"));
    for (const f of STRUCT_FIELDS) {
        card.appendChild(fieldRow(f, vocabSelect(f, shot[f]), f));
    }
    const prompt = document.createElement("textarea");
    prompt.rows = 3;
    prompt.style.cssText = "padding:4px 8px;resize:vertical;";
    prompt.placeholder = "本镜提示词(结构化分项会拼在前段)";
    prompt.value = shot.prompt || "";
    card.appendChild(fieldRow("提示词", prompt, "prompt"));

    card.appendChild(fieldRow("段落时长", textInput(shot["段落时长"], "秒, 留空用默认"), "段落时长"));
    card.appendChild(fieldRow("种子", textInput(shot["种子"], "留空随机"), "种子"));
    card.appendChild(fieldRow("导出名", textInput(shot["导出文件名"], "留空自动"), "导出文件名"));

    for (const kind of KINDS) {
        const p = textInput(shot[kind], "素材路径, 可拖文件到节点");
        p.dataset.kind = kind;
        const row = fieldRow(KIND_LABELS[kind], p);
        const btn = document.createElement("button");
        btn.textContent = "📁";
        btn.style.cssText = "flex:none;padding:3px 10px;cursor:pointer;";
        btn.onclick = () => {
            openPicker({
                title: "选择" + KIND_LABELS[kind] + "素材",
                kind: "file",
                exts: KIND_EXTS[kind],
                current: p.value,
                onPick: (path) => { p.value = path; },
            });
        };
        row.appendChild(btn);
        const clr = document.createElement("button");
        clr.textContent = "✕";
        clr.title = "清空素材路径";
        clr.style.cssText = "flex:none;padding:3px 10px;cursor:pointer;";
        clr.onclick = () => { p.value = ""; };
        row.appendChild(clr);
        card.appendChild(row);
    }
    return card;
}

function readCards() {
    const shots = [];
    for (const card of cardsEl.children) {
        const inputs = card.querySelectorAll("input,textarea,select");
        const shot = {};
        for (const el of inputs) {
            const k = el.dataset.kind || el.dataset.field;
            if (k) shot[k] = el.value.trim();
        }
        shots.push(shot);
    }
    return shots;
}

function ensureEditor() {
    if (editorOv) return editorOv;
    editorOv = document.createElement("div");
    editorOv.style.cssText = "position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;";

    const panel = document.createElement("div");
    panel.style.cssText = "background:#2a2a2e;color:#e6e6e6;border:1px solid #666;border-radius:8px;padding:14px;width:720px;max-width:94vw;font:13px/1.6 sans-serif;display:flex;flex-direction:column;max-height:90vh;";

    const title = document.createElement("div");
    title.textContent = "🖊 编辑镜头 (H3QuickShot)";
    title.style.cssText = "font-size:15px;font-weight:700;margin-bottom:8px;";

    globalsEl = document.createElement("div");
    cardsEl = document.createElement("div");
    cardsEl.style.cssText = "flex:1;overflow:auto;padding-right:4px;min-height:120px;";

    const bottom = document.createElement("div");
    bottom.style.cssText = "display:flex;gap:8px;margin-top:8px;";
    const add = document.createElement("button");
    add.textContent = "➕ 加镜头";
    add.style.cssText = "padding:5px 14px;cursor:pointer;";
    add.onclick = () => cardsEl.appendChild(shotCard(cardsEl.children.length, {}));
    const ok = document.createElement("button");
    ok.textContent = "✔ 确定";
    ok.style.cssText = "padding:5px 18px;cursor:pointer;";
    ok.onclick = () => {
        if (editorState?.node) {
            const shots = readCards();
            if (setPayload(editorState.node, readGlobals(), shots)) {
                toast("success", "H3 Quick", `已写入 ${shots.length} 个镜头`);
            }
        }
        closeEditor();
    };
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.style.cssText = "padding:5px 18px;cursor:pointer;";
    cancel.onclick = closeEditor;
    bottom.appendChild(add);
    bottom.appendChild(document.createElement("span")).style.flex = "1";
    bottom.appendChild(ok);
    bottom.appendChild(cancel);

    panel.appendChild(title);
    panel.appendChild(globalsEl);
    panel.appendChild(cardsEl);
    panel.appendChild(bottom);
    editorOv.appendChild(panel);
    editorOv.onclick = (e) => { if (e.target === editorOv) closeEditor(); };
    document.body.appendChild(editorOv);
    return editorOv;
}

function closeEditor() {
    editorState = null;
    if (editorOv) editorOv.style.display = "none";
}

async function openEditor(node) {
    const w = (node.widgets || []).find((x) => x.name === WIDGET_NAME);
    if (!w) { toast("error", "H3 Quick", `未找到 ${WIDGET_NAME} widget`); return; }
    await loadVocab();
    ensureEditor();
    editorState = { node };
    globalsEl.innerHTML = "";
    cardsEl.innerHTML = "";
    const { globals, shots } = parsePayload(w.value);
    globalsEl.appendChild(globalsBox(globals));
    const list = shots.length ? shots : [{}];
    for (let i = 0; i < list.length; i++) cardsEl.appendChild(shotCard(i, list[i]));
    editorOv.style.display = "flex";
}

app.registerExtension({
    name: "H3.QuickShot",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try {
                this.addWidget("button", "🖊 编辑镜头", null, () => openEditor(this), { serialize: false });

                // 素材文件拖到本节点 → 按扩展名写入最后一镜(当前镜头)对应路径键
                this._h3qsDropHandler = (e) => {
                    if (!isDropOnNode(this, e)) return;
                    const dt = e.dataTransfer;
                    const f = dt?.files?.[0];
                    if (!f) return;
                    const kind = extKind(f.name);
                    if (!kind) return;
                    e.stopPropagation();
                    e.preventDefault();
                    const p = getFilePath(f);
                    if (!p) {
                        toast("error", "H3 Quick", `无法获取完整路径(非 Electron), 请在 🖊 编辑镜头中手动选择: ${f.name}`);
                        return;
                    }
                    const w = (this.widgets || []).find((x) => x.name === WIDGET_NAME);
                    if (!w) return;
                    const { globals, shots } = parsePayload(w.value);
                    const cur = shots.length ? shots[shots.length - 1] : (shots.push({}), shots[0]);
                    cur[kind] = p;
                    if (setPayload(this, globals, shots)) {
                        const id = cur.ID || `镜头 ${shots.length}`;
                        toast("success", "H3 Quick", `${id} ${KIND_LABELS[kind]} ← ${f.name}`);
                    }
                };
                this.onDragOver = (e) => {
                    const dt = e.dataTransfer;
                    const f = dt?.files?.[0];
                    if (f && extKind(f.name)) {
                        e.preventDefault();
                        e.stopPropagation();
                        dt.dropEffect = "copy";
                    }
                };
                const canvas = app.canvas;
                if (canvas && canvas.canvas) {
                    canvas.canvas.addEventListener("drop", this._h3qsDropHandler, true);
                }
            } catch (err) {
                console.error("[H3QuickShot] 节点定制失败(不影响核心功能):", err);
            }
            return r;
        };
        const onNodeRemoved = nodeType.prototype.onNodeRemoved;
        nodeType.prototype.onNodeRemoved = function () {
            const c = app.canvas;
            if (c && c.canvas && this._h3qsDropHandler) {
                c.canvas.removeEventListener("drop", this._h3qsDropHandler, true);
            }
            return onNodeRemoved?.apply(this, arguments);
        };
    },
});
