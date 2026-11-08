// ui/canvas_params.js — 画布参数共享区（B3-T2 F7 三视图高级参数 · 引擎 #45 J2b 画布可配置化）.
//
// 取码 legacy/app/js/components/canvas_params.js:1-676（批次十三 T1 画布覆写可视化·只读参照）;
// 1.3 适配点:
//   - 模板清单 = core/templates.js fetchTemplateList（引擎真清单·dir 空走 workflow_dir 兜底）
//   - 族过滤   = 三视图静态双族 ref2v+t2v（F7 定稿口径: 输入面与族不符交引擎 400
//                canvas_template_mismatch 中文 msg toast 兜底, 不做前端校验; i2v/fl2v 永不列）
//   - 数据直调 = core/api request（#29 template_loras / #28 resources）——依赖单向, 不 import views
//   - 序列化   = core/serialize.js（serializeLoraOverrides / serializeOverrides·紧凑 JSON 文本）
//   - 样式     = assets.css .cvp-*（取值 theme.css 变量·去 legacy 内联样式）
//
// === API ===
//   buildCanvasParamsSection({panelKind, initial?, onParamChange?}) → <details data-h3-role="canvas-params-section">（默认收起）
//     panelKind "threepov" → 静态双族 ref2v+t2v + R-03 三键（initial=初值预填 / onParamChange=change 落值口·T1 #28）;
//     其余（scene/item 弹层）→ t2v —— legacy 分支原样保留（#47/#53 同款 J2b 契约为真实预期）
//   collectCanvasParams(sectionRoot) → {workflow_path?, lora_overrides?, resource_overrides?}
//     空/未选/trim 空 → 键不出（契约: 空串/缺省 = 未给出, 引擎侧走默认）
//   _test_resetCanvasParamsState() — 测试隔离（清 #29/#28 memo + in-flight）
//
// 提交链: UI 层 collect 后由调用方真值透传 submitThreepov(workflowPath/loraOverrides/resourceOverrides).

import { request } from "../core/api.js";
import { fetchTemplateList, classifyTemplateFamily } from "../core/templates.js";
import { serializeLoraOverrides, serializeOverrides } from "../core/serialize.js";
import { t } from "../core/i18n.js";   // #92 B3b：面板标签/占位/标题/帮助/错误入典 cvp.*（运行期调用·非顶层）

const TEMPLATE_LORAS_PATH = "/h3_batch/template_loras";
const RESOURCES_PATH = "/h3_batch/resources";

// R-03 三键（批②）: 比例八档 = 引擎 batch_core.ASPECT_MAP 键集（对齐主参数页 setup.js
// GLOBAL_KEYS 比例 cbox.edit 先例——input+datalist 下拉可选+可手输）; 质量/时长 number
// 闸门为 GUI 侧防误输（引擎无上限/域外值透传交引擎兜底）。
const ASPECT_OPTIONS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const ASPECT_LIST_ID = "cvp-aspect-list";

// 折叠区首次展开时拉一次, 换面板不重拉（legacy T1 口径·_test_resetCanvasParamsState 可清）.
//   缓存键: workflow_path（相对路径）→ {loras, loaders, has_pdd}; kind → string[].
const _templateLorasInflight = new Map();
const _templateLorasMemo = new Map();
const _resourcesInflight = new Map();
const _resourcesMemo = new Map();

// RES_SLOTS — 底模四槽固定顺序（渲染/收集/汇总）; #28 kind 映射: unet→model · 两 VAE 共 vae.
const RES_SLOTS = ["unet", "clip", "vae_video", "vae_audio"];
const RES_KIND = { unet: "model", clip: "clip", vae_video: "vae", vae_audio: "vae" };
const SLOT_LABEL = { unet: "cvp.slot.unet", clip: "cvp.slot.clip", vae_video: "cvp.slot.vae_video", vae_audio: "cvp.slot.vae_audio" };   // 值=i18n 键（#92 B3b·渲染期 t(SLOT_LABEL[slotKey]) 取词）

// _clearNode — 清子节点（removeChild 循环: 测试桩 innerHTML 置空不生效）.
function _clearNode(node) {
  while (node && node.children && node.children.length > 0) {
    node.removeChild(node.children[0]);
  }
}

// _filterTemplatesForCanvas — 画布下拉族过滤（构建时静态）.
//   allowed: Set<"ref2v"|"t2v">. 复用 classifyTemplateFamily 判族; i2v/fl2v/判不出族 → 排除.
function _filterTemplatesForCanvas(items, allowed) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    let path;
    if (typeof it === "string") path = it;
    else if (it && typeof it === "object") path = it.path || it.name || "";
    else continue;
    if (!path) continue;
    const fam = classifyTemplateFamily(path);
    if (!fam) continue;                             // 判不出族 → 不列
    if (fam === "i2v" || fam === "fl2v") continue;  // 已废除族 → 不列
    if (!allowed.has(fam)) continue;
    out.push(path);
  }
  return out;
}

// _resolveAllowedFamilies — 允许族推导（构建时静态·弹层生命周期内不变）.
//   threepov → 静态双族（F7 定稿口径·同 legacy 卡入口）;
//   scene / item 弹层 → 纯文字, 仅 t2v（取码 legacy 分支原样保留）.
function _resolveAllowedFamilies(config) {
  const panelKind = config && config.panelKind;
  if (panelKind === "threepov") return new Set(["ref2v", "t2v"]);
  return new Set(["t2v"]);
}

// _fetchTemplateLoras — #29 单模板 {loras, loaders, has_pdd}（带 memo + in-flight 复用）.
//   失败 → 抛 Error, 上层 catch 转 hint 文案.
async function _fetchTemplateLoras(workflowPath) {
  const key = workflowPath || "";
  if (_templateLorasInflight.has(key)) return _templateLorasInflight.get(key);
  if (_templateLorasMemo.has(key)) return _templateLorasMemo.get(key);
  const promise = (async () => {
    const url = `${TEMPLATE_LORAS_PATH}?workflow_path=${encodeURIComponent(workflowPath)}`;
    const r = await request(url, { cache: "no-store" });
    if (!r || !r.ok) throw new Error("HTTP " + (r && r.error && r.error.httpStatus));
    const j = r.data || {};
    return {
      loras: Array.isArray(j.loras) ? j.loras : [],
      loaders: (typeof j.loaders === "object" && j.loaders) ? j.loaders : {},
      has_pdd: !!j.has_pdd,
    };
  })();
  _templateLorasInflight.set(key, promise);
  try {
    const out = await promise;
    _templateLorasMemo.set(key, out);
    return out;
  } catch (e) {
    throw e; // 失败不入 memo（下次换模板重试）
  } finally {
    _templateLorasInflight.delete(key);
  }
}

// _fetchResourcesList — #28 某 kind 候选文件名清单（带 memo + in-flight 复用）.
//   items 引擎真形状 [{file,...}]（旧 {name}/纯字符串兼容——resources.js 同款口径）.
async function _fetchResourcesList(kind) {
  if (_resourcesInflight.has(kind)) return _resourcesInflight.get(kind);
  if (_resourcesMemo.has(kind)) return _resourcesMemo.get(kind);
  const promise = (async () => {
    const url = `${RESOURCES_PATH}?kind=${encodeURIComponent(kind)}`;
    const r = await request(url, { cache: "no-store" });
    if (!r || !r.ok) throw new Error("HTTP " + (r && r.error && r.error.httpStatus));
    const items = Array.isArray(r.data && r.data.items) ? r.data.items : [];
    return items.map((it) => {
      if (typeof it === "string") return it;
      if (it && typeof it === "object") return it.file || it.name || "";
      return "";
    }).filter(Boolean);
  })();
  _resourcesInflight.set(kind, promise);
  try {
    const out = await promise;
    _resourcesMemo.set(kind, out);
    return out;
  } catch (e) {
    throw e; // 失败不入 memo
  } finally {
    _resourcesInflight.delete(kind);
  }
}

// _buildHelp — 配置面说明区（5 键默认值行取码 legacy 原文·批 4-T1 ① 对齐 J2b 9 键口径）.
//   R-03: threepov 面板追加三控件说明行（留空=按配置/默认·临时覆盖不写配置文件·已记住上次设置）;
//   scene/item 面板无三控件, 说明行不出（帮助文本逐字节不变）.
function _buildHelp(withMediaKeys) {
  const box = document.createElement("div");
  box.className = "cvp-help";
  box.dataset.h3Role = "canvas-params-help";
  box.textContent =
    t("cvp.help.head") +
    "  aspect = 16:9\n" +
    "  megapixels = 0.4\n" +
    "  duration_seconds = 2\n" +
    "  steps = 8V8A\n" +
    t("cvp.help.seedLine") +
    t("cvp.help.tail4") +
    (withMediaKeys
      ? t("cvp.help.mediaKeys")
      : "") +
    t("cvp.help.noWrite");
  return box;
}

// _buildMediaParams — R-03 三控件（aspect/megapixels/duration_seconds·仅 threepov 面板调用）.
//   初值=未触碰不收集: 三控件空占位符「(引擎默认 16:9 / 0.4 / 2)」, collect 空值不写键
//   （h3_config 有覆写时引擎自行生效, GUI 不虚标）。
//   三件补做批 T1（#28）: 可选 initial（持久值回填三控件初值）与 onParamChange(key, value)
//   （change 触发·值语义与 collect 同型——aspect=trim 串|null / 数值键=number|null）；
//   不传 = 零变化（无预填、无监听）。
//   #38 D1: 布局改三行 .cvp-row + .cvp-res-lbl 逐框标签（同区底模行 _buildResRow 先例·
//   CSS 现成零新增）；「留空 = 引擎默认」由占位符与帮助区承载。
function _buildMediaParams(sec, initial, onParamChange) {
  const init = (initial && typeof initial === "object" && !Array.isArray(initial)) ? initial : null;
  const emit = typeof onParamChange === "function" ? onParamChange : null;

  const mkRow = (label) => {
    const row = document.createElement("div");
    row.className = "cvp-row";
    const lab = document.createElement("span");
    lab.className = "cvp-res-lbl";
    lab.textContent = label;
    row.appendChild(lab);
    sec.appendChild(row);
    return row;
  };

  const rowAspect = mkRow(t("cvp.row.aspect"));
  const aspect = document.createElement("input");
  aspect.type = "text";
  aspect.className = "cvp-txt";
  aspect.placeholder = t("cvp.ph.aspect");
  aspect.setAttribute("list", ASPECT_LIST_ID);
  aspect.title = t("cvp.ti.aspect");
  aspect.dataset.h3Role = "canvas-params-aspect";
  if (init && typeof init.aspect === "string") aspect.value = init.aspect;
  rowAspect.appendChild(aspect);
  if (emit) {
    aspect.addEventListener("change", () => {
      emit("aspect", (typeof aspect.value === "string" && aspect.value.trim()) || null);
    });
  }

  const dl = document.createElement("datalist");
  dl.id = ASPECT_LIST_ID;
  dl.dataset.h3Role = "canvas-params-aspect-list";
  for (const r of ASPECT_OPTIONS) {
    const o = document.createElement("option");
    o.value = r;
    dl.appendChild(o);
  }
  sec.appendChild(dl);

  const rowMp = mkRow(t("cvp.row.mp"));
  const mp = document.createElement("input");
  mp.type = "number";
  mp.className = "cvp-num";
  mp.min = "0.1";
  mp.max = "4";
  mp.step = "0.1";
  mp.placeholder = t("cvp.ph.mp");
  mp.title = t("cvp.ti.mp");
  mp.dataset.h3Role = "canvas-params-megapixels";
  if (init && typeof init.megapixels === "number") mp.value = String(init.megapixels);
  rowMp.appendChild(mp);
  if (emit) mp.addEventListener("change", () => emit("megapixels", _numOrNull(mp.value)));

  const rowDur = mkRow(t("cvp.row.dur"));
  const dur = document.createElement("input");
  dur.type = "number";
  dur.className = "cvp-num";
  dur.min = "0.04";
  dur.max = "900";
  dur.step = "0.01";
  dur.placeholder = t("cvp.ph.dur");
  dur.title = t("cvp.ti.dur");
  dur.dataset.h3Role = "canvas-params-duration";
  if (init && typeof init.duration_seconds === "number") dur.value = String(init.duration_seconds);
  rowDur.appendChild(dur);
  if (emit) dur.addEventListener("change", () => emit("duration_seconds", _numOrNull(dur.value)));
}

// _populateTemplateSelect — 拉一次引擎真清单, 按 allowed 族过滤, 渲染 option.
//   值 = 相对路径（引擎侧经 workflow_dir 解析·与提交面同源）.
async function _populateTemplateSelect(sel, allowed) {
  _clearNode(sel);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("cvp.tpl.ph");
  sel.appendChild(placeholder);
  let items = [];
  try {
    const r = await fetchTemplateList();
    items = (r && r.ok && Array.isArray(r.items))
      ? r.items.map((it) => (it && typeof it === "object" ? (it.name || it.path || "") : it))
      : [];
  } catch (_e) { items = []; }
  // 异步续体可能晚于弹窗销毁（测试桩还原 document）——无文档即止，不建 option
  if (typeof document === "undefined") return;
  const filtered = _filterTemplatesForCanvas(items, allowed);
  for (const path of filtered) {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path;
    sel.appendChild(opt);
  }
  if (filtered.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = t("cvp.tpl.none");
    empty.disabled = true;
    sel.appendChild(empty);
  }
}

// _buildLoraRow — 单 LoRA 行: 名字 + 强度 + 禁用 + 换名（name= 三控件共享 LoRA 文件名）.
function _buildLoraRow(loraName, defaultStrength) {
  const row = document.createElement("div");
  row.className = "cvp-row";
  row.dataset.h3Role = "canvas-params-lora-row";
  row.title = loraName;

  const lab = document.createElement("span");
  lab.className = "cvp-lora-name";
  lab.textContent = loraName;
  row.appendChild(lab);

  const strength = document.createElement("input");
  strength.type = "number";
  strength.step = "0.05";
  strength.min = "-10";
  strength.max = "10";
  strength.value = String(defaultStrength != null ? defaultStrength : 1);
  strength.name = loraName;
  strength.dataset.h3Role = "canvas-params-lora-strength";
  strength.dataset.h3Default = String(defaultStrength != null ? defaultStrength : 1);
  strength.className = "cvp-num";
  row.appendChild(strength);

  const disableWrap = document.createElement("label");
  disableWrap.className = "cvp-cbx";
  const disableCb = document.createElement("input");
  disableCb.type = "checkbox";
  disableCb.name = loraName;
  disableCb.dataset.h3Role = "canvas-params-lora-disable";
  disableWrap.appendChild(disableCb);
  const disableTxt = document.createElement("span");
  disableTxt.textContent = t("cvp.lora.disable");
  disableWrap.appendChild(disableTxt);
  row.appendChild(disableWrap);

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.placeholder = t("cvp.lora.namePh");
  nameInp.name = loraName;
  nameInp.dataset.h3Role = "canvas-params-lora-name";
  nameInp.className = "cvp-txt";
  row.appendChild(nameInp);

  return row;
}

// _buildLoraRows — 模板 change 时整体重建 LoRA 行容器 + 状态行.
function _buildLoraRows(container, hint, loras) {
  _clearNode(container);
  const safeLor = Array.isArray(loras) ? loras : [];
  if (safeLor.length === 0) {
    hint.textContent = t("cvp.lora.none");
    return;
  }
  hint.textContent = "";
  for (const it of safeLor) {
    const name = it && it.name ? it.name : "";
    if (!name) continue;
    const strength = (it && typeof it.strength === "number") ? it.strength : 1;
    container.appendChild(_buildLoraRow(name, strength));
  }
}

// _buildResRow — 单底模槽位行: 槽名 + 当前值 + 下拉（占位「(默认) — 不覆写」永远第一位）.
function _buildResRow(slotKey, curVal) {
  const row = document.createElement("div");
  row.className = "cvp-row";

  const lab = document.createElement("span");
  lab.className = "cvp-res-lbl";
  lab.textContent = SLOT_LABEL[slotKey] ? t(SLOT_LABEL[slotKey]) : slotKey;
  row.appendChild(lab);

  const cur = document.createElement("span");
  cur.className = "cvp-res-cur";
  cur.dataset.h3Role = `canvas-params-res-cur-${slotKey}`;
  cur.textContent = curVal || t("cvp.res.curDefault");
  row.appendChild(cur);

  const sel = document.createElement("select");
  sel.className = "cvp-res-sel";
  sel.dataset.h3Role = `canvas-params-res-${slotKey}`;
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = t("cvp.res.ph");
  defOpt.selected = true;
  sel.appendChild(defOpt);
  row.appendChild(sel);

  return row;
}

// _populateResSelect — 把候选文件名灌入指定槽位 select（仅保留占位首项）.
function _populateResSelect(sel, items) {
  while (sel.children.length > 1) sel.removeChild(sel.children[1]);
  const safe = Array.isArray(items) ? items : [];
  for (const name of safe) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

// _loadAllResources — 折叠区首次展开时拉三类各一次, 灌入四槽 select（两 VAE 共用 vae）.
async function _loadAllResources(resRows, hint) {
  let anyLoaded = false;
  let anyFailed = false;
  await Promise.all(RES_SLOTS.map(async (slot) => {
    const kind = RES_KIND[slot];
    try {
      const items = await _fetchResourcesList(kind);
      anyLoaded = anyLoaded || items.length > 0;
      const sel = resRows.querySelector(`[data-h3-role="canvas-params-res-${slot}"]`);
      if (sel) _populateResSelect(sel, items);
    } catch (_e) {
      anyFailed = true;
    }
  }));
  if (anyFailed && !anyLoaded) hint.textContent = t("cvp.res.loadFail");
  else if (!anyLoaded) hint.textContent = t("cvp.res.none");
  else hint.textContent = "";
}

// ============================================================================
// 1. buildCanvasParamsSection — 折叠区构建（UI 主入口）
// ============================================================================

export function buildCanvasParamsSection(config) {
  if (typeof document === "undefined") return null;
  const allowed = _resolveAllowedFamilies(config);

  const sec = document.createElement("details");
  sec.className = "cvp-sec";
  sec.dataset.h3Role = "canvas-params-section";
  sec.open = false; // 默认收起

  const summary = document.createElement("summary");
  summary.className = "cvp-sum";
  summary.textContent = t("cvp.sum");
  sec.appendChild(summary);

  // 模板下拉
  const selLab = document.createElement("div");
  selLab.className = "cvp-lbl";
  selLab.textContent = t("cvp.tpl.lbl");
  sec.appendChild(selLab);
  const sel = document.createElement("select");
  sel.className = "cvp-sel";
  sel.dataset.h3Role = "canvas-params-template";
  sec.appendChild(sel);

  // ---- R-03 三键（画幅/画质/时长·panelKind=threepov 门控——scene/item 面板零变化） ----
  //   三件补做批 T1（#28）：可选 initial（持久值回填）与 onParamChange（change 落值口）透传。
  //   三件补做批 T2（#29）：三键收进单一容器 role=canvas-params-media-keys——三视图弹窗
  //   「生成类型=道具」按此 role 整区隐藏（引擎 #53 无三键契约），人物态显隐不受扰。
  const isThreepov = !!(config && config.panelKind === "threepov");
  if (isThreepov) {
    const mediaBox = document.createElement("div");
    mediaBox.dataset.h3Role = "canvas-params-media-keys";
    _buildMediaParams(mediaBox, config && config.initial, config && config.onParamChange);
    sec.appendChild(mediaBox);
  }

  // ---- LoRA 区（可视化行·随模板联动） ----
  const loraHeader = document.createElement("div");
  loraHeader.className = "cvp-hd";
  const loraLab = document.createElement("div");
  loraLab.className = "cvp-lbl";
  loraLab.textContent = t("cvp.lora.lbl");
  loraHeader.appendChild(loraLab);
  const loraIgnoreWrap = document.createElement("label");
  loraIgnoreWrap.className = "cvp-cbx";
  const loraIgnoreCb = document.createElement("input");
  loraIgnoreCb.type = "checkbox";
  loraIgnoreCb.dataset.h3Role = "canvas-params-ignore-cfg-lora";
  loraIgnoreCb.title = t("cvp.ignoreTi");
  loraIgnoreWrap.appendChild(loraIgnoreCb);
  const loraIgnoreTxt = document.createElement("span");
  loraIgnoreTxt.textContent = t("cvp.ignore");
  loraIgnoreWrap.appendChild(loraIgnoreTxt);
  loraHeader.appendChild(loraIgnoreWrap);
  sec.appendChild(loraHeader);

  const loraRows = document.createElement("div");
  loraRows.className = "cvp-rows";
  loraRows.dataset.h3Role = "canvas-params-lora-rows";
  sec.appendChild(loraRows);

  const loraHint = document.createElement("div");
  loraHint.className = "cvp-hint";
  loraHint.dataset.h3Role = "canvas-params-lora-hint";
  loraHint.textContent = t("cvp.lora.hint");
  sec.appendChild(loraHint);

  // ---- 底模区（四槽下拉·不依赖模板） ----
  const resHeader = document.createElement("div");
  resHeader.className = "cvp-hd";
  const resLab = document.createElement("div");
  resLab.className = "cvp-lbl";
  resLab.textContent = t("cvp.res.lbl");
  resHeader.appendChild(resLab);
  const resIgnoreWrap = document.createElement("label");
  resIgnoreWrap.className = "cvp-cbx";
  const resIgnoreCb = document.createElement("input");
  resIgnoreCb.type = "checkbox";
  resIgnoreCb.dataset.h3Role = "canvas-params-ignore-cfg-res";
  resIgnoreCb.title = t("cvp.ignoreTi");
  resIgnoreWrap.appendChild(resIgnoreCb);
  const resIgnoreTxt = document.createElement("span");
  resIgnoreTxt.textContent = t("cvp.ignore");
  resIgnoreWrap.appendChild(resIgnoreTxt);
  resHeader.appendChild(resIgnoreWrap);
  sec.appendChild(resHeader);

  const resRows = document.createElement("div");
  resRows.className = "cvp-rows";
  resRows.dataset.h3Role = "canvas-params-res-rows";
  for (const slot of RES_SLOTS) resRows.appendChild(_buildResRow(slot, ""));
  sec.appendChild(resRows);

  const resHint = document.createElement("div");
  resHint.className = "cvp-hint";
  resHint.dataset.h3Role = "canvas-params-res-hint";
  resHint.textContent = t("cvp.res.hint");
  sec.appendChild(resHint);

  sec.appendChild(_buildHelp(isThreepov));

  // 异步装载模板下拉 — fire-and-forget（不阻塞弹窗 open）
  void _populateTemplateSelect(sel, allowed);

  // 模板 change → 拉 LoRA + 重建行（整体重置; 底模四槽/忽略勾选不重置）
  sel.addEventListener("change", () => {
    const wp = sel.value;
    if (!wp) {
      _buildLoraRows(loraRows, loraHint, []);
      for (const slot of RES_SLOTS) {
        const cur = resRows.querySelector(`[data-h3-role="canvas-params-res-cur-${slot}"]`);
        if (cur) cur.textContent = t("cvp.res.curDefault");
      }
      return;
    }
    _buildLoraRows(loraRows, loraHint, []); // 占位
    loraHint.textContent = t("cvp.loading");
    _fetchTemplateLoras(wp).then(
      (data) => {
        if (sel.value !== wp) return; // 模板已被换走 → 丢弃过期响应
        _buildLoraRows(loraRows, loraHint, data.loras);
        // 刷新四槽当前值（loaders 只读显示, 不入收集）
        const ld = data.loaders || {};
        for (const slot of RES_SLOTS) {
          const cur = resRows.querySelector(`[data-h3-role="canvas-params-res-cur-${slot}"]`);
          if (cur) cur.textContent = ld[slot] || t("cvp.res.curDefault");
        }
      },
      () => { if (sel.value === wp) loraHint.textContent = t("cvp.lora.loadFail"); },
    );
  });

  // 首次展开 → 拉底模三类 + 灌入四槽 select
  let resLoaded = false;
  sec.addEventListener("toggle", () => {
    if (!sec.open || resLoaded) return;
    resLoaded = true;
    resHint.textContent = t("cvp.loading");
    void _loadAllResources(resRows, resHint);
  });

  return sec;
}

// ============================================================================
// 2. collectCanvasParams — 收集三可选键（trim 后原样, 空 = 键不出）
// ============================================================================

// _collectLoraOverrides — 收集 LoRA 行. 仅收被改动的行（与默认 strength 比对）,
//   disabled 优先（契约最高优先）. ignore-cfg 勾选且无其他改动 → "{}".
function _collectLoraOverrides(sectionRoot) {
  const rows = sectionRoot.querySelector('[data-h3-role="canvas-params-lora-rows"]');
  const ignoreCb = sectionRoot.querySelector('[data-h3-role="canvas-params-ignore-cfg-lora"]');
  const ignoreChecked = !!(ignoreCb && ignoreCb.checked);

  const obj = {}; // 插入序=行序（DOM 顺序遍历）
  let hasAny = false;

  if (rows) {
    for (const row of rows.children || []) {
      if (!row || row.dataset.h3Role !== "canvas-params-lora-row") continue;
      const strengthEl = row.querySelector('[data-h3-role="canvas-params-lora-strength"]');
      const disableEl = row.querySelector('[data-h3-role="canvas-params-lora-disable"]');
      const nameEl = row.querySelector('[data-h3-role="canvas-params-lora-name"]');
      if (!strengthEl) continue;
      const fname = strengthEl.name || "";
      if (!fname) continue;

      // disabled 优先: 勾选即 {disabled:true}, 同行其他改动忽略
      if (disableEl && disableEl.checked) {
        obj[fname] = { disabled: true };
        hasAny = true;
        continue;
      }

      const defaultStr = strengthEl.dataset.h3Default != null ? String(strengthEl.dataset.h3Default) : "1";
      const curStr = strengthEl.value != null ? String(strengthEl.value) : "";
      const trimmedName = nameEl && typeof nameEl.value === "string" ? nameEl.value.trim() : "";

      const entry = {};
      if (curStr !== defaultStr) entry.strength = Number(curStr); // 数值原样
      if (trimmedName) entry.name = trimmedName;
      if (Object.keys(entry).length > 0) {
        obj[fname] = entry;
        hasAny = true;
      }
    }
  }

  if (!hasAny) {
    // 无任何改动: 勾选 → "{}"; 未勾选 → 键不出
    return ignoreChecked ? "{}" : undefined;
  }
  return serializeLoraOverrides(obj);
}

// _collectResourceOverrides — 收集底模四槽. 非「(默认)」→ {slot: file}; 全默认=不传;
//   ignore-cfg 勾选且无其他改动 → "{}"; 有改动则忽略勾选不生效（改动本身就是覆写）.
function _collectResourceOverrides(sectionRoot) {
  const resRows = sectionRoot.querySelector('[data-h3-role="canvas-params-res-rows"]');
  const ignoreCb = sectionRoot.querySelector('[data-h3-role="canvas-params-ignore-cfg-res"]');
  const ignoreChecked = !!(ignoreCb && ignoreCb.checked);

  const obj = {};
  let hasAny = false;

  if (resRows) {
    for (const slot of RES_SLOTS) {
      const sel = resRows.querySelector(`[data-h3-role="canvas-params-res-${slot}"]`);
      if (!sel) continue;
      const v = sel.value || "";
      if (v) {
        obj[slot] = v;
        hasAny = true;
      }
    }
  }

  if (!hasAny) return ignoreChecked ? "{}" : undefined;
  return serializeOverrides(obj);
}

// _numOrNull — R-03 number 输入收集: trim 后 Number, 空白/非有限数值 → null（键不出）.
function _numOrNull(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

export function collectCanvasParams(sectionRoot) {
  if (!sectionRoot || typeof sectionRoot.querySelector !== "function") return {};
  const sel = sectionRoot.querySelector('[data-h3-role="canvas-params-template"]');

  const out = {};
  const wp = sel && typeof sel.value === "string" ? sel.value.trim() : "";
  if (wp) out.workflow_path = wp;

  const lora = _collectLoraOverrides(sectionRoot);
  if (lora) out.lora_overrides = lora;

  const res = _collectResourceOverrides(sectionRoot);
  if (res) out.resource_overrides = res;

  // R-03 三键（批②）: 真值才收（未触碰不收集——引擎走 h3_config.canvas/默认, GUI 不虚标）
  const aspectEl = sectionRoot.querySelector('[data-h3-role="canvas-params-aspect"]');
  const aspect = aspectEl && typeof aspectEl.value === "string" ? aspectEl.value.trim() : "";
  if (aspect) out.aspect = aspect;

  const mp = _numOrNull(
    (sectionRoot.querySelector('[data-h3-role="canvas-params-megapixels"]') || {}).value);
  if (mp !== null) out.megapixels = mp;

  const dur = _numOrNull(
    (sectionRoot.querySelector('[data-h3-role="canvas-params-duration"]') || {}).value);
  if (dur !== null) out.duration_seconds = dur;

  return out;
}

// ============================================================================
// 3. 测试钩子 — 重置 memo + in-flight 状态（节点测试隔离必需）
// ============================================================================

export function _test_resetCanvasParamsState() {
  _templateLorasInflight.clear();
  _templateLorasMemo.clear();
  _resourcesInflight.clear();
  _resourcesMemo.clear();
}
