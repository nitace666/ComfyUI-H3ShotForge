import { api } from "../../../scripts/api.js";

let overlay = null;
let titleEl = null, pathEl = null, listEl = null, statusEl = null, searchEl = null;
let upBtn = null, selBtn = null, allChk = null, allChkLabel = null, nativeBtn = null, manualEl = null;
let st = null;   // { kind, exts, onPick, nativePick, path, selected, loading }
let lastDir = ""; // 记住上次浏览位置, 下次打开从这继续

// 原生文件框只在确认能取完整路径时提供: Electron>=32 移除 file.path 且未暴露 webUtils 时,
// 选完只能拿到裸文件名, 回填会污染路径字段, 不如只用应用内浏览(服务端列目录, 路径完整)
const NATIVE_CAPABLE = !!window.webUtils?.getPathForFile;

function joinPath(dir, name) {
    if (!dir) return name + "\\";
    return dir.replace(/[\\/]+$/, "") + "\\" + name;
}

// 从字段当前值推断初始目录: 绝对路径取其目录, 其次调用方给的兜底目录, 最后用上次浏览位置
function startDirOf(current, fallbackDir) {
    const norm = (current || "").replace(/\//g, "\\");
    if (/^[A-Za-z]:\\/.test(norm)) {
        const i = norm.lastIndexOf("\\");
        return i > 2 ? norm.slice(0, i) : norm.slice(0, 3);
    }
    return fallbackDir || lastDir;
}

function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;";

    const panel = document.createElement("div");
    panel.style.cssText = "background:#2a2a2e;color:#e6e6e6;border:1px solid #666;border-radius:8px;padding:14px;width:640px;max-width:94vw;font:13px/1.6 sans-serif;";

    titleEl = document.createElement("div");
    titleEl.style.cssText = "font-size:15px;font-weight:700;margin-bottom:8px;";

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;";
    pathEl = document.createElement("div");
    pathEl.style.cssText = "flex:1;border:1px solid #555;border-radius:4px;padding:3px 8px;min-height:20px;color:#cfcfcf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    upBtn = document.createElement("button");
    upBtn.textContent = "⬆ 上级";
    upBtn.style.cssText = "flex:none;padding:3px 10px;cursor:pointer;";
    upBtn.onclick = () => load(st && st.parent !== undefined ? st.parent : "");
    bar.appendChild(pathEl);
    bar.appendChild(upBtn);

    listEl = document.createElement("div");
    listEl.style.cssText = "border:1px solid #555;border-radius:4px;height:340px;overflow:auto;padding:4px;";

    searchEl = document.createElement("input");
    searchEl.placeholder = "🔍 搜索当前文件夹";
    searchEl.style.cssText = "width:100%;box-sizing:border-box;padding:3px 8px;margin-bottom:4px;";
    // 纯前端过滤已加载的当前目录数据; 有搜索词时忽略扩展名过滤(用户常搜的就是被隐藏的文件)
    searchEl.oninput = () => {
        const q = searchEl.value.trim().toLowerCase();
        if (q && st.exts && !allChk.checked && st.filteredFetch) load(st.path);
        else renderList();
    };

    const optRow = document.createElement("div");
    optRow.style.cssText = "display:flex;gap:14px;align-items:center;margin:8px 0;";
    allChk = document.createElement("input");
    allChk.type = "checkbox";
    allChk.style.display = "none";
    allChkLabel = document.createElement("label");
    allChkLabel.style.cssText = "display:none;cursor:pointer;color:#cfcfcf;";
    allChkLabel.appendChild(document.createTextNode("显示全部文件 "));
    allChkLabel.appendChild(allChk);
    allChk.onchange = () => load(st.path);
    nativeBtn = document.createElement("button");
    nativeBtn.textContent = "系统选择器…";
    nativeBtn.style.cssText = "display:none;padding:3px 10px;cursor:pointer;";
    optRow.appendChild(allChkLabel);
    optRow.appendChild(nativeBtn);

    statusEl = document.createElement("div");
    statusEl.style.cssText = "min-height:18px;color:#ff9a62;margin-bottom:6px;";

    const bottom = document.createElement("div");
    bottom.style.cssText = "display:flex;gap:8px;align-items:center;";
    manualEl = document.createElement("input");
    manualEl.placeholder = "或粘贴路径到此, 回车确认";
    manualEl.style.cssText = "flex:1;padding:4px 8px;box-sizing:border-box;";
    manualEl.onkeydown = (e) => {
        if (e.key === "Enter" && manualEl.value.trim()) { submitManual(manualEl.value.trim()); }
    };
    selBtn = document.createElement("button");
    selBtn.textContent = "选择";
    selBtn.style.cssText = "padding:5px 16px;cursor:pointer;";
    selBtn.onclick = () => {
        if (st.kind === "dir") { if (st.path) pick(st.path); }
        else if (st.selected) { pick(joinPath(st.path, st.selected)); }
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:5px 16px;cursor:pointer;";
    cancelBtn.onclick = closePicker;
    bottom.appendChild(manualEl);
    bottom.appendChild(selBtn);
    bottom.appendChild(cancelBtn);

    panel.appendChild(titleEl);
    panel.appendChild(bar);
    panel.appendChild(searchEl);
    panel.appendChild(listEl);
    panel.appendChild(optRow);
    panel.appendChild(statusEl);
    panel.appendChild(bottom);
    overlay.appendChild(panel);
    overlay.onclick = (e) => { if (e.target === overlay) closePicker(); };
    document.body.appendChild(overlay);
    return overlay;
}

function pick(p) {
    const cb = st.onPick;
    closePicker();
    if (cb) cb(p);
}

// ui-thumb-cache2: THUMB_EXTS 与 Picture 集对齐 (服务端 thumb 端点同步支持)
// T9 任务③: 加视频七扩展名 — 网格平铺视频 + 缩略图由服务端首帧 PNG 提供
const THUMB_EXTS = new Set([".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv"]);

// 缩略图直连: img.src 直接给 /h3_batch/thumb URL, 配合 loading="lazy" 视口外不发请求;
// 之前用 fetchApi(无缓存) 会一次性全部发起, 419 张图把 ComfyUI 服务打挂。
// 重复访问由服务端 ETag / 304 + Cache-Control 持久化处理, 浏览器内存缓存按 URL 复用 blob。
// ui-thumb-cache2: 第 5 个参数 icon, 目录/盘符行传 "📁"; 默认 "📄" 保持普通文件外观
function row(text, onOpen, onSelect, thumbPath, icon) {
    const r = document.createElement("div");
    r.dataset.name = text.replace(/^\S+\s/, "");
    r.style.cssText = "display:flex;align-items:center;gap:6px;min-height:40px;padding:1px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;";
    // 图片行显示缩略图, 其他行用等宽占位对齐
    if (thumbPath) {
        const im = document.createElement("img");
        im.loading = "lazy";
        im.src = "/h3_batch/thumb?path=" + encodeURIComponent(thumbPath);
        im.style.cssText = "width:40px;height:40px;object-fit:cover;border-radius:4px;flex:none;";
        r.appendChild(im);
    } else {
        const ph = document.createElement("span");
        ph.textContent = icon || "📄";
        ph.style.cssText = "width:40px;flex:none;text-align:center;";
        r.appendChild(ph);
    }
    const name = document.createElement("span");
    name.textContent = text.replace(/^\S+\s/, "");
    name.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
    r.appendChild(name);
    r.onmouseenter = () => { r.style.background = "#3d3d44"; };
    r.onmouseleave = () => { if (!r._sel) r.style.background = ""; };
    if (onSelect) {
        r.onclick = () => {
            for (const c of listEl.children) { c._sel = false; c.style.background = ""; }
            r._sel = true;
            r.style.background = "#4a6fa5";
            onSelect();
        };
    }
    if (onOpen) r.ondblclick = onOpen;
    return r;
}

// 网格平铺的图片块: 不显示文件名, title=文件名悬停提示, dataset.name=文件名供定位
function thumbCell(name) {
    const c = document.createElement("div");
    c.dataset.name = name;
    c.title = name;
    c.style.cssText = "aspect-ratio:1/1;border-radius:4px;cursor:pointer;overflow:hidden;background:#1a1a1e;display:flex;align-items:center;justify-content:center;";
    const im = document.createElement("img");
    im.loading = "lazy";
    im.alt = name;
    im.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    c.appendChild(im);
    c._setSel = (sel) => {
        c._sel = sel;
        if (sel) {
            c.style.outline = "2px solid #4a6fa5";
            c.style.outlineOffset = "-2px";
        } else {
            c.style.outline = "";
            c.style.outlineOffset = "";
        }
    };
    c._clearSel = () => c._setSel(false);
    c._sel = false;
    c.onmouseenter = () => { if (!c._sel) c.style.background = "#3d3d44"; };
    c.onmouseleave = () => { if (!c._sel) c.style.background = "#1a1a1e"; };
    return c;
}

async function load(dir) {
    st.path = dir || "";
    st.selected = null;
    st.parent = "";
    st.dirs = [];
    st.files = [];
    st.drives = false;
    pathEl.textContent = st.path || "🖥 此电脑(选择盘符)";
    statusEl.textContent = "";
    listEl.innerHTML = "";
    const wantFilter = !!(st.exts && !allChk.checked && !searchEl.value.trim());
    st.filteredFetch = wantFilter;
    const exts = wantFilter ? st.exts.join(",") : "";
    try {
        const resp = await api.fetchApi(`/h3_batch/browse?path=${encodeURIComponent(st.path)}&exts=${encodeURIComponent(exts)}`, { cache: "no-store" });
        const data = await resp.json();
        if (data.error) { statusEl.textContent = data.error; return; }
        st.parent = data.parent || "";
        lastDir = st.path;
        st.drives = !!data.drives;
        st.dirs = data.dirs || [];
        st.files = data.files || [];
        renderList();
    } catch (e) {
        statusEl.textContent = "请求失败: " + (e && e.message ? e.message : e);
    }
}

function renderList() {
    st.selected = null;
    listEl.innerHTML = "";
    const q = searchEl.value.trim().toLowerCase();
    const dirs = q ? st.dirs.filter((d) => d.toLowerCase().includes(q)) : st.dirs;
    const files = q ? st.files.filter((f) => f.toLowerCase().includes(q)) : st.files;
    if (st.drives) {
        for (const d of dirs) listEl.appendChild(row("🖴 " + d + "\\", () => load(d + "\\"), null, null, "📁"));
    } else {
        // 1) 目录行
        for (const d of dirs) {
            const full = joinPath(st.path, d);
            listEl.appendChild(row("📁 " + d, () => load(full), null, null, "📁"));
        }
        // 2) 图片文件 -> 网格平铺块(追加在目录行之后); 非图片维持行式
        const imgFiles = [];
        const nonImgFiles = [];
        for (const f of files) {
            const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
            (THUMB_EXTS.has(ext) ? imgFiles : nonImgFiles).push(f);
        }
        const cells = [];
        const clearAll = () => { for (const x of cells) x._clearSel(); };
        if (imgFiles.length) {
            const grid = document.createElement("div");
            grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;margin-top:6px;";
            for (const f of imgFiles) {
                const full = joinPath(st.path, f);
                const cell = thumbCell(f);
                // 直连 /h3_batch/thumb: 配合 img.loading="lazy" 视口外不发请求, 避免洪峰
                cell.firstChild.src = "/h3_batch/thumb?path=" + encodeURIComponent(full);
                cell.onclick = () => {
                    clearAll();
                    cell._setSel(true);
                    st.selected = f;
                    selBtn.focus();
                };
                cell.ondblclick = () => {
                    cell._setSel(true);
                    st.selected = f;
                    pick(joinPath(st.path, f));
                };
                cells.push(cell);
                grid.appendChild(cell);
            }
            listEl.appendChild(grid);
        }
        // 3) 非图片文件(勾了"显示全部文件"或当前是 dir 类型时的杂项)
        for (const f of nonImgFiles) {
            listEl.appendChild(row("📄 " + f, null, () => { st.selected = f; selBtn.focus(); }));
        }
    }
    if (q && !dirs.length && !files.length) statusEl.textContent = "无匹配项";
}

// 手输路径: 剥成对引号; 看起来是文件时先列其目录并自动选中该文件, 否则当目录列
async function submitManual(raw) {
    const v = raw.replace(/^["'](.*)["']$/, "$1").trim().replace(/\//g, "\\");
    if (/[.][^\\.\/]+$/.test(v)) {
        if (!st.exts) { statusEl.textContent = "请输入文件夹"; return; }
        const i = v.lastIndexOf("\\");
        const dir = i >= 2 ? v.slice(0, i) : v.slice(0, 3);
        const name = v.slice(i + 1);
        try {
            const resp = await api.fetchApi(`/h3_batch/browse?path=${encodeURIComponent(dir)}`, { cache: "no-store" });
            const data = await resp.json();
            if (!data.error && (data.files.includes(name) || data.dirs.includes(name))) {
                const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
                if (!st.exts.includes(ext)) { statusEl.textContent = "文件类型不匹配: " + st.exts.join(","); return; }
                await load(dir);
                // D12: 深度查询 — 图片块挂在 grid 子容器内 (非 listEl 直系), 浅遍历恒漏;
                //   命中即触发其 onclick 并 break; 未命中如实报"未找到", 不再虚报成功
                let hit = false;
                for (const el of listEl.querySelectorAll("[data-name]")) {
                    if (el.dataset.name === name && el.onclick) { el.onclick(); hit = true; break; }
                }
                statusEl.textContent = hit ? "已定位并选中: " + name : "未找到: " + name;
                return;
            }
        } catch (e) { /* 落回按目录处理 */ }
    }
    await load(v);
}

export function openPicker(opts) {
    ensureOverlay();
    st = {
        kind: opts.kind || "dir",
        exts: opts.exts || null,
        onPick: opts.onPick,
        nativePick: opts.nativePick || null,
        path: "", parent: "", selected: null,
    };
    titleEl.textContent = opts.title || "选择路径";
    selBtn.textContent = st.kind === "dir" ? "选择当前文件夹" : "选择";
    const useFilter = !!st.exts;
    allChkLabel.style.display = useFilter ? "flex" : "none";
    allChk.style.display = useFilter ? "" : "none";
    allChk.checked = false;
    const showNative = !!st.nativePick && NATIVE_CAPABLE;
    nativeBtn.style.display = showNative ? "" : "none";
    if (showNative) {
        nativeBtn.onclick = async () => {
            const p = await st.nativePick(st.exts ? st.exts.join(",") : "", manualEl.value);
            if (p) pick(p);
        };
    }
    manualEl.value = opts.current || "";
    overlay.style.display = "flex";
    load(startDirOf(opts.current, opts.fallbackDir));
}

export function closePicker() {
    if (overlay) overlay.style.display = "none";
}

// ------- 路径设置面板: 一个按钮入口, 集中管理全部路径字段 -------
let settingsOv = null;

export function openPathSettings(opts) {
    if (!settingsOv) {
        settingsOv = document.createElement("div");
        settingsOv.style.cssText = "position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;";
        const panel = document.createElement("div");
        panel.style.cssText = "background:#2a2a2e;color:#e6e6e6;border:1px solid #666;border-radius:8px;padding:14px 16px;width:720px;max-width:94vw;font:13px/1.6 sans-serif;";
        const title = document.createElement("div");
        title.textContent = "路径设置";
        title.style.cssText = "font-size:15px;font-weight:700;margin-bottom:10px;";
        const rows = document.createElement("div");
        rows.style.cssText = "margin-bottom:4px;";
        const bottom = document.createElement("div");
        bottom.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:6px;";
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "关闭";
        closeBtn.style.cssText = "padding:5px 18px;cursor:pointer;";
        closeBtn.onclick = closePathSettings;
        bottom.appendChild(closeBtn);
        panel.appendChild(title);
        panel.appendChild(rows);
        panel.appendChild(bottom);
        settingsOv.appendChild(panel);
        settingsOv.onclick = (e) => { if (e.target === settingsOv) closePathSettings(); };
        document.body.appendChild(settingsOv);
        settingsOv._rows = rows;
    }
    const rowsEl = settingsOv._rows;
    rowsEl.innerHTML = "";
    const inputsByName = {};
    for (const f of opts.fields) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px;";
        const lab = document.createElement("span");
        lab.textContent = f.label;
        lab.style.cssText = "flex:none;width:92px;";
        const input = document.createElement("input");
        input.placeholder = "可手填";
        input.style.cssText = "flex:1;padding:4px 8px;box-sizing:border-box;";
        input.value = opts.getVal(f.name) || "";
        input.onchange = () => opts.setVal(f.name, input.value.trim());
        inputsByName[f.name] = input;
        const browse = document.createElement("button");
        browse.textContent = "浏览";
        browse.style.cssText = "flex:none;padding:4px 14px;cursor:pointer;";
        browse.onclick = async () => {
            // CSV 类字段为空时从服务器 input 目录起跳(表单生成的 CSV 都在那)
            let fallbackDir = "";
            if (!input.value.trim() && (f.name === "csv_path" || f.name === "queue_path")) {
                try {
                    const r = await api.fetchApi("/h3_batch/input_dir", { cache: "no-store" });
                    fallbackDir = ((await r.json()).dir) || "";
                } catch (e) { /* 起点回落 lastDir/盘符列表 */ }
            }
            openPicker({
                title: "选择" + f.label,
                kind: f.kind,
                exts: f.ext ? [f.ext] : null,
                current: input.value,
                fallbackDir,
                onPick: (p) => { input.value = p; opts.setVal(f.name, p); input.dispatchEvent(new Event("change")); },
                nativePick: f.kind === "file"
                    ? () => opts.nativePickFile(f.ext, input.value)
                    : () => opts.nativePickDir(input.value),
            });
        };
        wrap.appendChild(lab);
        wrap.appendChild(input);
        if (f.name === "workflow_path") {
            // 模板文件: 扫描 template_dir 的 json 供下拉选择, 选中回填相对路径(与节点 combo 值格式一致);
            // 手填框保留, 用于绝对路径场景
            const tmplSel = document.createElement("select");
            tmplSel.style.cssText = "flex:none;max-width:240px;padding:4px 4px;";
            const reload = async () => {
                const dir = (inputsByName.template_dir?.value || "").trim();
                tmplSel.innerHTML = "";
                const ph = document.createElement("option");
                if (!dir) {
                    ph.textContent = "先填模板目录…";
                    tmplSel.appendChild(ph);
                    return;
                }
                ph.textContent = "扫描中…";
                tmplSel.appendChild(ph);
                try {
                    const resp = await api.fetchApi(`/h3_batch/templates?dir=${encodeURIComponent(dir)}`, { cache: "no-store" });
                    const data = await resp.json();
                    tmplSel.innerHTML = "";
                    const ph2 = document.createElement("option");
                    ph2.textContent = (data.templates || []).length ? "选择模板…" : "该目录无 json 模板";
                    tmplSel.appendChild(ph2);
                    for (const t of data.templates || []) {
                        const o = document.createElement("option");
                        o.value = t;
                        o.textContent = t;
                        tmplSel.appendChild(o);
                    }
                } catch (e) {
                    tmplSel.innerHTML = "";
                    const err = document.createElement("option");
                    err.textContent = "扫描失败: " + (e && e.message ? e.message : e);
                    tmplSel.appendChild(err);
                }
            };
            tmplSel.onchange = () => {
                if (!tmplSel.value) return;
                input.value = tmplSel.value;
                opts.setVal("workflow_path", tmplSel.value);
            };
            inputsByName.template_dir?.addEventListener("change", reload);
            wrap.appendChild(tmplSel);
            reload();
        }
        wrap.appendChild(browse);
        rowsEl.appendChild(wrap);
    }
    settingsOv.style.display = "flex";
}

export function closePathSettings() {
    if (settingsOv) settingsOv.style.display = "none";
}
