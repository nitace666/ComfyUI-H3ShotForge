import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as csv_form from "./csv_form.js";
import { openPathSettings } from "./path_picker.js";

const NODE_CLASS = "H3ShotBatchRenderer";
const POLL_SECONDS = 10;
const POLL_MAX_SECONDS = 1800;
const POLL_MAX_FAILURES = 3;

// T4.5c: 视觉隐藏的 JSON 数据 widget (表单/覆盖按钮统一编辑, 面板不再裸露 JSON)
const HIDDEN_JSON_WIDGETS = ["resources_list", "resource_overrides", "lora_overrides"];

// 路径字段集中定义, 由「选择路径」按钮的设置面板统一管理
const PATH_FIELDS = [
    { name: "template_dir", label: "模板目录", kind: "dir" },
    { name: "workflow_path", label: "模板文件", kind: "file", ext: ".json" },
    { name: "csv_path", label: "分镜表", kind: "file", ext: ".csv" },
    { name: "input_dir", label: "素材目录", kind: "dir" },
    { name: "archive_dir", label: "归档目录", kind: "dir" },
    { name: "rerun_folder", label: "重跑文件夹", kind: "dir" },
    { name: "queue_path", label: "队列清单(填写后=队列模式)", kind: "file", ext: ".csv" },
    { name: "server_input_dir", label: "服务器输入(空=自动)", kind: "dir" },
    { name: "server_output_dir", label: "服务器输出(空=自动)", kind: "dir" },
];

let hiddenFile = null;
function getHiddenInput(directory, accept) {
    if (!hiddenFile) {
        hiddenFile = document.createElement("input");
        hiddenFile.type = "file";
        hiddenFile.style.display = "none";
        document.body.appendChild(hiddenFile);
    }
    hiddenFile.removeAttribute("webkitdirectory");
    hiddenFile.removeAttribute("accept");
    if (directory) hiddenFile.setAttribute("webkitdirectory", "");
    else if (accept) hiddenFile.setAttribute("accept", accept);
    return hiddenFile;
}

// Electron >= 32 弃用 file.path, 优先 webUtils.getPathForFile
function getFilePath(file) {
    if (window.webUtils?.getPathForFile) {
        try {
            const p = window.webUtils.getPathForFile(file);
            if (p) return p;
        } catch (e) { /* 回退到 file.path */ }
    }
    return file.path || null;
}

function pickFile(accept, currentValue) {
    return new Promise((resolve) => {
        const input = getHiddenInput(false, accept);
        input.onchange = () => {
            const file = input.files && input.files[0];
            input.value = "";
            if (!file) { resolve(currentValue); return; }
            const p = getFilePath(file);
            if (!p) {
                // 裸文件名没有目录信息, 回填会污染路径字段; 保留原值, 引导用应用内浏览
                toast("error", "H3 批量", "当前环境无法从文件框获取完整路径, 已保留原值, 请用「浏览」在面板内选择");
                resolve(currentValue || "");
                return;
            }
            resolve(p);
        };
        input.click();
    });
}

function pickDir(currentValue) {
    return new Promise((resolve) => {
        if ("webkitdirectory" in document.createElement("input")) {
            const input = getHiddenInput(true);
            input.onchange = () => {
                const file = input.files && input.files[0];
                input.value = "";
                if (!file) { resolve(currentValue); return; }
                const p = getFilePath(file);
                if (!p) {
                    toast("error", "H3 批量", "无法获取完整路径(非 Electron), 目录未回填, 请手动填写: " + (file.webkitRelativePath || file.name));
                    resolve(currentValue);
                    return;
                }
                let dir = p.replace(/\\/g, "/");
                dir = dir.substring(0, dir.lastIndexOf("/"));
                dir = dir.replace(/\//g, "\\");
                resolve(dir);
            };
            input.click();
            return;
        }
        toast("error", "H3 批量", "当前浏览器不支持目录选择, 请手动填写路径");
        resolve(currentValue);
    });
}

function toast(severity, summary, detail) {
    const t = app.extensionManager?.toast?.add;
    if (t) t({ severity, summary, detail });
    else console.log(`[H3Batch] ${summary} ${detail ?? ""}`);
}

function csvStem(csvPath) {
    if (!csvPath) return "";
    const base = csvPath.split(/[\\/]/).pop() || "";
    return base.replace(/\.csv$/i, "");
}

function clearPoll(node) {
    if (node && node._h3PollTimer) {
        clearInterval(node._h3PollTimer);
        node._h3PollTimer = null;
    }
    // V1.7 R13 附条件: 清掉 phase toast 去重哨兵 —— 新一轮跑批阶段变化时重新提示。
    if (node) node._h3LastPhase = "";
}

function pollStatus(node, outputDir, stem) {
    clearPoll(node);
    const start = Date.now();
    let failures = 0;
    node._h3PollTimer = setInterval(async () => {
        const url = `/h3_batch/status?output_dir=${encodeURIComponent(outputDir)}&stem=${encodeURIComponent(stem)}`;
        try {
            const resp = await api.fetchApi(url, { cache: "no-store" });
            const data = await resp.json();
            failures = 0;
            if (data.error) { clearPoll(node); toast("error", "H3 批量状态", data.error); return; }
            const total = data.total ?? 0;
            const finished = (data.done ?? 0) + (data.failed ?? 0);
            if (!data.running && !data.phase && total > 0 && finished >= total) {
                clearPoll(node);
                // V1.7 R13: 完成结果显示 — 拼接成功加 "已拼接"; 拼接失败显式警告
                // (用户之前只能去控制台看 [H3Batch] 日志; 实测拼接失败却显示段全部成功, 误以为正常)
                const concatFailed = data.concat && data.concat.status === "failed";
                const concatSuccess = data.concat && data.concat.status === "success";
                let msg;
                if (total === data.done) {
                    msg = `批量完成: ${data.done}/${total} 成功${concatSuccess ? ", 已拼接" : ""}`;
                } else {
                    msg = `批量结束: ${data.done}/${total} 成功, ${data.failed} 失败`;
                }
                const sev = data.failed > 0 || concatFailed ? "error" : "success";
                if (concatFailed) {
                    // V1.7 R13+: 拼接失败时把 error 摘要一起带回前端 — 用户不再
                    // 必须翻控制台日志才知道具体原因 (控制台日志现也按引擎侧 A 层
                    // 改为醒目失败文案). 截断 120 字避免 toast 溢出, 附"段产物已保留"
                    // 引导用户去归档目录排查.
                    const concatErr = (data.concat && data.concat.error) ? data.concat.error : "";
                    const errSummary = concatErr.length > 120 ? concatErr.slice(0, 120) + "…" : concatErr;
                    msg += ` ⚠ 拼接失败: ${errSummary || "(无错误详情)"}（段产物已保留）`;
                }
                toast(sev, "H3 批量", msg);
            } else if (data.phase && data.phase !== node._h3LastPhase) {
                // V1.7 R13: 跑批收尾白箱 — 拼接 / 归档 / 清点期间, 阶段变化才 toast 一次
                // (拼接最多 180s, 用户黑箱期最长 3 分钟; 提示让用户知道在等什么而非死锁)
                // 修复: 原每 10s tick 都 toast → 180s 堆 ~18 条 info toast 刷屏;
                //       服役前端 (PrimeVue) 无自动消失 —— 必须按阶段去重。
                node._h3LastPhase = data.phase;
                toast("info", "H3 批量", `收尾中（当前: ${data.phase}）`);
            } else if (Date.now() - start > POLL_MAX_SECONDS * 1000) {
                clearPoll(node);
                toast("error", "H3 批量", "轮询超时, 请查看控制台");
            }
        } catch (e) {
            failures += 1;
            if (failures >= POLL_MAX_FAILURES) {
                clearPoll(node);
                toast("error", "H3 批量", `连续 ${POLL_MAX_FAILURES} 次请求失败, 停止轮询`);
            }
        }
    }, POLL_SECONDS * 1000);
}

// 拖放命中判断: 只在自己节点上拦截, 不吞掉画布/其它节点的拖放
function isDropOnNode(node, e) {
    if (app.dragOverNode === node) return true;
    if (node.isPointInside && node.isPointInside(e.clientX, e.clientY)) return true;
    const pos = node.pos, size = node.size;
    if (!pos || !size) return false;
    return e.clientX >= pos[0] && e.clientX <= pos[0] + size[0]
        && e.clientY >= pos[1] && e.clientY <= pos[1] + size[1];
}

app.registerExtension({
    name: "H3.BatchRenderer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try {
                // 模式已无开关参数: queue_path 填写即队列模式, 纯 label 文案提示(1.48.7 无可靠置灰方案)
                const qW = (this.widgets || []).find((w) => w.name === "queue_path");
                if (qW) qW.label = "queue_path(填写后=队列模式)";
                const repW = (this.widgets || []).find((w) => w.name === "repeat");
                if (repW) repW.label = "repeat(队列模式无效)";
                // T4.5c: 视觉隐藏 3 个 JSON 数据 widget (用户视为"漏代码/格式乱").
                // 机制 (frontend 1.48.7 实测源码): litegraph 原生 w.hidden —
                //   isWidgetVisible/getLayoutWidgets 过滤 hidden (canvas 不绘制、
                //   不占布局高度、不响应命中); Vue 参数面板按 w.options.hidden 过滤.
                // 序列化安全: serialize()/configure() 遍历全量 widgets (仅跳
                //   serialize===false), widgets_values 按数组序对齐 — 不动数组
                //   构成与顺序, 保存/加载值不丢.
                const hideJsonWidgets = () => {
                    for (const w of this.widgets || []) {
                        if (HIDDEN_JSON_WIDGETS.includes(w.name)) {
                            w.hidden = true;
                            w.options = w.options || {};
                            w.options.hidden = true;
                        }
                    }
                };
                hideJsonWidgets();
                // 旧工作流迁移: 模式开关参数删除后 widgets_values 多一格,
                // 检测旧槽位的枚举值并裁掉, 防止后续 widget 错位赋值
                    // 仅支持 input_source 时代工作流迁移; 更早 quick_data widget 时代的
                    // 工作流(vals 更长一位)不做兼容, 请删除节点后重新添加
                    const origConfigure = this.configure.bind(this);
                    this.configure = function (data) {
                        const vals = data && data.widgets_values;
                        const ser = (this.widgets || []).filter(w => w.serialize !== false).length;
                        if (Array.isArray(vals) && vals.length === ser + 1
                            && ["CSV 模板", "Quick 输入", "队列清单"].includes(vals[13])) {
                            vals.splice(13, 1);
                        }
                        return origConfigure(data);
                    };
                // 路径字段统一取值/设值接口(供表单/拖拽/轮询使用)
                this._h3Path = {
                    get: (name) => (this.widgets || []).find((w) => w.name === name)?.value ?? "",
                    set: (name, val) => {
                        const w = (this.widgets || []).find((x) => x.name === name);
                        if (w) { w.value = val; this.setDirtyCanvas?.(true, true); }
                    },
                };
                // 底部按钮区: 竖排 addWidget 按钮(此前端版本唯一可靠方案, 实测可用)
                this.addWidget("button", "📂 选择路径", null, () => {
                    openPathSettings({
                        fields: PATH_FIELDS,
                        getVal: (n) => this._h3Path.get(n),
                        setVal: (n, v) => this._h3Path.set(n, v),
                        nativePickFile: pickFile,
                        nativePickDir: pickDir,
                    });
                }, { serialize: false });
                this.addWidget("button", "📝 表单", null, () => {
                    csv_form.openForm(this, this._h3Path);
                }, { serialize: false });
                this.addWidget("button", "📡 查状态", null, () => {
                    const outputDir = (this._h3Path.get("server_output_dir") ?? "").trim();
                    const stem = csvStem(this._h3Path.get("csv_path") ?? "");
                    if (!stem) {
                        toast("error", "H3 批量", "请先填写 csv_path");
                        return;
                    }
                    toast("info", "H3 批量", `开始轮询状态 (每 ${POLL_SECONDS}s, 最长 ${POLL_MAX_SECONDS}s)`);
                    pollStatus(this, outputDir, stem);
                }, { serialize: false });
                // CSV/JSON 拖到本节点 → 拦截并回填对应字段
                this._h3DropHandler = (e) => {
                    if (!isDropOnNode(this, e)) return;
                    const dt = e.dataTransfer;
                    const f = dt?.files?.[0];
                    if (!f) return;
                    const lower = (f.name || "").toLowerCase();
                    const field = lower.endsWith(".csv") ? "csv_path"
                        : lower.endsWith(".json") ? "workflow_path" : null;
                    if (!field) return;
                    e.stopPropagation();
                    e.preventDefault();
                    const p = getFilePath(f);
                    if (!p) {
                        toast("error", "H3 批量", `无法获取完整路径(非 Electron), 请用 📂 按钮选择: ${f.name}`);
                        return;
                    }
                    this._h3Path.set(field, p);
                };
                this.onDragOver = (e) => {
                    const dt = e.dataTransfer;
                    const f = dt?.files?.[0];
                    if (f && /\.(csv|json)$/i.test(f.name)) {
                        e.preventDefault();
                        e.stopPropagation();
                        dt.dropEffect = "copy";
                    }
                };
                // quick_data: 转 input 插槽, 避免多行文本框占满节点。
                // 1.48.7 起 convertWidgetToInput 是弃用空操作(widget 与插槽共存),
                // 调用后 widget 不会消失, 因此必须手动移除 widget + addInput 兜底。
                this._h3SocketifyQuickData = () => {
                    const w = (this.widgets || []).find((x) => x.name === "quick_data");
                    if (!w) return;
                    if (!(this.inputs || []).some((i) => i.name === "quick_data")) {
                        this.addInput("quick_data", "STRING");
                    }
                    if (typeof this.removeWidget === "function") this.removeWidget(w);
                    else {
                        const idx = this.widgets.indexOf(w);
                        if (idx >= 0) this.widgets.splice(idx, 1);
                    }
                    this.setDirtyCanvas?.(true, true);
                };
                this._h3SocketifyQuickData();
                this._h3HideJsonWidgets = hideJsonWidgets;
                const onConfigure = this.onConfigure;
                this.onConfigure = function () {
                    const r = onConfigure?.apply(this, arguments);
                    // 加载旧工作流时 widgets_values 会在 onConfigure 后重建 widget, 延迟一拍再转
                    setTimeout(() => {
                        this._h3SocketifyQuickData?.();
                        // T4.5c: configure 后 widget 若被重建, 重放视觉隐藏 (序列化不受影响)
                        this._h3HideJsonWidgets?.();
                    }, 0);
                    return r;
                };
                const canvas = app.canvas;
                if (canvas && canvas.canvas) {
                    canvas.canvas.addEventListener("drop", this._h3DropHandler, true);
                }
            } catch (err) {
                console.error("[H3Batch] 节点定制失败(不影响核心功能):", err);
            }
            return r;
        };
        // preflight 拦截时节点 return 提示字符串到 info 口, 用户看不到 — 弹 toast 可见化
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            const r = onExecuted?.apply(this, arguments);
            try {
                const text = output?.result?.[0];
                if (typeof text === "string" && text.trim()) {
                    toast("info", "H3 批量", text.length > 200 ? text.slice(0, 200) + "…" : text);
                }
            } catch (e) { /* 不影响节点自身流程 */ }
            return r;
        };
        const onNodeRemoved = nodeType.prototype.onNodeRemoved;
        nodeType.prototype.onNodeRemoved = function () {
            clearPoll(this);
            const c = app.canvas;
            if (c && c.canvas && this._h3DropHandler) {
                c.canvas.removeEventListener("drop", this._h3DropHandler, true);
            }
            return onNodeRemoved?.apply(this, arguments);
        };
    },
});
