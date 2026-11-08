// prompt.js — 全局提示词区 + 预览拼装三段式 + 段卡 @ 联想绑定（GUI1.3 S1-2 T5）
//
// === 出处注记 ===
// 源：v43 原型（md5=43c85f743cfb8445f63fb8292c3355aa）
//   - 全局提示词区 :1368-1379（#gpText + pv-bar + pv-pre）
//   - v25 拼装三段式 :3421-3444
//     · v25RefsFromText(text)  :3405-3410（@N 顺序去重）
//     · v25BuildSegBody(segTxt, gp) :3420-3439（段卡三段）
//     · v25BuildGpBody(gp) :3440-3444（全局提示词）
//   - pv 折叠两态 pvToggle :3493-3502
//   - @ 联想通用件 :3262-3316 → ui/at-mention.js（本任务同批提取为独立模块）
//
// === 任务边界 ===
// 本任务（T5）实装：
//   - 全局提示词区（mountGlobalPrompt：textarea + pv-bar + pv-pre）
//   - 段卡 sc-prompt @ 联想绑定（事件委托 → 动态增段也覆盖）
//   - 预览拼装三段式（v25BuildSegBody / v25BuildGpBody 转正纯函数）
//   - pv 折叠两态切换
//   - 样例资产 fetch 加载（assets.sample.json · 模块级缓存）
// 不实装：拼装真实产物（演示版，与 v43 同 —— 真实拼装在引擎）
// 不实装：自定义段卡拼接 chk 联动（段卡内已有 · 本任务不重写）
//
// === API ===
//   extractRefs(text, assetMap)      → number[]                 纯函数 · 顺序去重
//   buildSegBody(segTxt, gp, m)     → {refs, body}             纯函数 · v25 v25BuildSegBody 转正
//   buildAssetMap(assets)           → {n:{name,kind,className}}  纯函数 · 资产索引
//   loadAssets(url)                 → Promise<assets[]>         fetch 加载 · 模块级缓存
//   getCachedAssets()               → assets[]                  同步读取缓存
//   invalidateAssetsCache()         → Promise<assets[]>         缓存失效 + 主动重拉（#72 落卡链用）
//   renderChips(host, refs, m)      → void                      渲染引用 chip 行（卡名主视觉·批5-R55 去序列号）
//   mountGlobalPrompt(container, projectId, opts?) → sec         挂全局提示词区（v43 :1368-1379 形态）
//   bindSegcardsAtMention(rootEl, opts?) → void                  段卡 sc-prompt 委托绑定（动态增段覆盖）
//   refreshSegPv(card, gp, assetMap) → void                     单段 pv-pre 数据接入（T3 容器 → T5 正文）

import { load as storeLoad, save as storeSave } from "../store/store.js";
import { normalizeAssets, kindToClass, buildAssetMap as atBuildAssetMap, bind as atBind, thumbUrl, setAssetsRev, getAssetsRev } from "../ui/at-mention.js";
import { hydrateIcons } from "../ui/icons.js";
import { t } from "../core/i18n.js";   // #89 T2b：显示文案入典（zh 原文=键值·en 见 core/i18n.js）

// ===== 纯函数（v25 v25RefsFromText/v25BuildSegBody/v25BuildGpBody 转正）=====

// 顺序去重 + 仅保留 assetMap 已收录的 n
// v43 :3405-3410 v25RefsFromText 同源（参数签名略改：原硬编码 V25_ASSET → 注入 assetMap）
// 战役批4-T3 · F-87(A)：@名字 与 @N 同通道——逐位扫描（refsParse 同款·core/canvas.js refsParse
//   一位一消费：@位先按名字最长前缀命中并消费该位·未命中再按数字——防「注册名数字开头」双命中）。
//   收录过滤保留：未收录 n 不产出（下游 buildSegBody 取 assetMap[n].name 无守卫）。
export function extractRefs(text, assetMap) {
  const out = [];
  const seen = new Set();
  if (typeof text !== "string") return out;
  const map = (assetMap && typeof assetMap === "object") ? assetMap : {};
  const names = [];
  for (const k of Object.keys(map)) {
    const a = map[k];
    const n = Number(k);
    if (!a || typeof a.name !== "string" || !a.name || !Number.isFinite(n)) continue;
    names.push({ n, name: a.name });
  }
  names.sort((a, b) => b.name.length - a.name.length); // 最长前缀优先（本地副本排序·不改入参）
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    let len = 0; // 命中后需跳过的字符数（@ + 名字/数字）
    for (const it of names) {
      if (!text.startsWith(it.name, at + 1)) continue;
      const after = text[at + 1 + it.name.length] || "";
      if (after && /[0-9A-Za-z_]/.test(after)) continue; // 词边界（与 refsParse 同款）
      if (!seen.has(it.n)) { seen.add(it.n); out.push(it.n); }
      len = 1 + it.name.length;
      break;
    }
    if (!len) {
      const m = /^\d+/.exec(text.slice(at + 1));
      if (m) {
        const n = +m[0];
        if (map[n] && !seen.has(n)) { seen.add(n); out.push(n); }
        len = 1 + m[0].length;
      }
    }
    i = len ? at + len : at + 1; // 未命中 → 位进 1 防死循环
  }
  return out;
}

// v43 :3420-3439 v25BuildSegBody 转正
// 入参：segTxt 段词原文 / gp 全局提示词 / assetMap {n:{name,kind,className}}
// 返回 {refs, body} —— refs 为去重的 @N；body 为最终拼装预览文本
// 批5-R55-T3：@N 引用段为本地示意（不回填 desc、不冒充引擎展开）——引擎实收
//   展开全文见段卡「引擎预览」行（splitEnginePreview 两区·golden 锁 pvbox.test.mjs）。
export function buildSegBody(segTxt, gp, assetMap) {
  const refs = extractRefs(segTxt, assetMap);
  const lines = [];
  lines.push(t("prompt.seg.srcHead"));
  lines.push(segTxt || t("prompt.seg.empty"));
  if (refs.length) {
    lines.push("");
    lines.push(t("prompt.seg.refHead"));
    for (const n of refs) {
      const a = assetMap[n];
      lines.push(a.name);
    }
  }
  if (gp) {
    lines.push("");
    lines.push(t("prompt.seg.gpHead"));
    lines.push(gp);
  }
  return { refs, body: lines.join("\n") };
}

// 与 at-mention.buildAssetMap 同源；导出供本视图内部使用
export function buildAssetMap(assets) {
  return atBuildAssetMap(assets);
}

// ===== 渲染辅助 =====

// v43 :3411-3419 v25RenderChips 转正（引用 chip 行·卡名主视觉·批5-R55-T1a 去序列号）
export function renderChips(host, refs, assetMap) {
  if (!host) return;
  // 清空（textContent="" 即可，原生 DOM 安全；不引入 jQuery 类工具）
  host.textContent = "";
  for (const n of refs) {
    const a = assetMap[n];
    if (!a) continue;
    const chip = document.createElement("span");
    chip.className = "rchip";
    const thumb = document.createElement("span");
    thumb.className = "thumb th-" + (a.className || kindToClass(a.kind));
    // 批 10-L L1-6：卡有 media → 色块上叠真图 <img>（引擎 #30 thumb 通道·与 @联想行同款）；
    //   色块类保留作回退底；无 media → 纯色块（既有形态不变）。尺寸走行内样式（不引新 CSS 文件）。
    const src = thumbUrl(a.media, 120);
    if (src) {
      const img = document.createElement("img");
      img.setAttribute("alt", "");
      img.setAttribute("src", src);
      img.setAttribute("style", "display:block;width:100%;height:100%;object-fit:cover;border-radius:inherit");
      thumb.appendChild(img);
    }
    chip.appendChild(thumb);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.name;            // 战役批2-T1 · F-87：主视觉只留卡名（批5-R55-T1a：ref#N 灰字撤除）
    chip.appendChild(nm);
    host.appendChild(chip);
  }
}

// ===== 模块级资产缓存（listAssets + 注册表 → at-mention 数组）=====
//   N1 退役 sample.json：@ 联想数据源走 listAssets() 真数据 + 注册表分配 @N
//   - listAssets 走 fetch（核心 core/assets_api.js）；失败不写缓存（下次调用重拉·见 _assetsLoadFailed）
//   - 注册表来自 core/assets_api.js readRegistry（REGISTRY_KEY 单源·详案任务 0）
//   - 归一函数 assetsToMentionList(assets, registry) 为纯函数（单测覆盖）

let _assetsCache = null;
let _assetsLoading = null;

function _safeStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

// 卡首图（批 10-L L1-6）：v3 卡 rows 里第一张非空 media —— @联想行/引用 chip 缩略图真图源
function _cardFirstMedia(card) {
  const rows = card && Array.isArray(card.rows) ? card.rows : [];
  for (const r of rows) {
    if (r && typeof r.media === "string" && r.media) return r.media;
  }
  return "";
}

// 纯函数：listAssets 形态 {name: card} + 注册表 {n: cardName} → at-mention 数组
//   未注册的卡不入 @ 联想（@N 缺位 = 用户尚未分配）
export function assetsToMentionList(assets, registry) {
  const src = (assets && typeof assets === "object") ? assets : {};
  const reg = (registry && typeof registry === "object") ? registry : {};
  // 反注册表：{cardName: n}
  const nameToN = {};
  for (const k of Object.keys(reg)) {
    const cardName = reg[k];
    if (typeof cardName === "string" && cardName) nameToN[cardName] = Number(k);
  }
  const out = [];
  for (const name of Object.keys(src)) {
    const n = nameToN[name];
    if (n == null || !Number.isFinite(n)) continue;
    const card = src[name] || {};
    const rawKind = typeof card.kind === "string" ? card.kind : "";
    // 引擎 kind: character|scene → at-mention kindToClass 口径（人物|场景|道具|音频）
    const amKind = rawKind === "scene" ? "场景" : (rawKind === "character" ? "人物" : rawKind);
    out.push({
      id: String(n),
      n,
      name,
      kind: amKind,
      desc: typeof card.memo === "string" ? card.memo : "",
      className: kindToClass(amKind),
      media: _cardFirstMedia(card),
    });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

// 战役批4-T4 · F-87(C)：失败统一出口（三分支共用）——失败 = 没拿到资产，不是「资产为空」
//   · 不写 _assetsCache：空数组一旦落缓存即被永久钉死（真机首载失败后 @联想/连线全失效）
//   · 复位 _assetsLoading：不清则下次 loadAssets 直接返回旧句柄里的空结果，重试承诺落空
//   · 失败不广播：count=0 广播是空缓存触发全量重算的源头 —— 失败静默，成功才广播
//   白话：刷新页面本就清零这两个模块变量重拉，所以「刷新自愈」现状即成立；
//   本任务真实增量 = 跨页二挂载重试（首载失败 → 再进画布时现状直接返回空缓存，修后才真重拉）。
function _assetsLoadFailed(note) {
  _assetsLoading = null;
  if (typeof console !== "undefined") console.warn("[prompt] 资产加载失败·不写缓存（下次调用重拉）", note);
  return []; // 读取面 getCachedAssets 仍回空 —— 对调用方表现不变，只是不把空钉进缓存
}

export async function loadAssets() {
  if (_assetsCache) return Promise.resolve(_assetsCache);
  if (_assetsLoading) return _assetsLoading;

  // 失败分支 b：环境无 fetch（Node）
  if (typeof fetch !== "function") {
    return _assetsLoadFailed("fetch 不可用（Node 环境）");
  }

  _assetsLoading = Promise.all([
    import("../core/assets_api.js").then((m) => m.listAssets()),
    import("../core/assets_api.js").then((m) => m.readRegistry(_safeStorage())),
  ]).then(([listRes, registry]) => {
    // 失败分支 c：listRes.ok=false 静默降级（真机引擎未起 / HTTP 500 最常见形态·不进 catch）
    if (!(listRes && listRes.ok)) {
      return _assetsLoadFailed(listRes && listRes.error ? listRes.error : "listRes.ok=false");
    }
    const assets = (listRes.assets && typeof listRes.assets === "object") ? listRes.assets : {};
    _assetsCache = assetsToMentionList(assets, registry);
    // 任务C #55：会话首拉成功即取 Date.now() 作 assetsRev（非空起步）——杜绝「会话首拉无 v URL
    //   → 改图后回退无 v 形态命中旧缓存」的复活路径；置新先于广播，广播触发的重渲即携 v。
    if (!getAssetsRev()) setAssetsRev(Date.now());
    broadcastAssetsLoaded();
    return _assetsCache;
  }).catch((e) => {
    // 失败分支 a：listAssets 抛异常（响应体读取中断等·request 只兜网络层）
    return _assetsLoadFailed(e && e.message ? e.message : e);
  });
  return _assetsLoading;
}

function broadcastAssetsLoaded() {
  if (typeof document === "undefined") return;
  try {
    document.dispatchEvent(new CustomEvent("prompt:assets-loaded", { detail: { count: (_assetsCache || []).length } }));
  } catch (_e) { /* CustomEvent 在老环境可能不支持 */ }
}

export function getCachedAssets() {
  return _assetsCache || [];
}

// 资产缓存失效入口（#72 · 排戏落卡链调用）
//   loadAssets 头一句 `if (_assetsCache) return` 会话内早退 —— 外部新增资产（排戏落卡）后
//   必须显式清缓存再主动重拉，否则 @ 弹窗（assetsGetter 每次 input 实时读）整会话看不到新卡，
//   只能靠强制刷新页面（模块重载清零）。只清不拉同样错：getCachedAssets 会回空列表。
//   返回 loadAssets() 的 Promise → 重拉成功后由既有 broadcastAssetsLoaded 广播（失败静默·口径同 loadAssets）。
export function invalidateAssetsCache() {
  _assetsCache = null;
  _assetsLoading = null;
  // 任务C #55：assetsRev 取失效时刻 Date.now()——重拉完成后广播，画布重渲的资产 thumb URL
  //   即携新 v（再次改图 v 单调递增·同名重传同路径覆盖也换 URL 击穿缓存）。
  setAssetsRev(Date.now());
  return loadAssets();
}

// ===== DOM 构造辅助 =====

function el(tag, attrs = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ===== 全局提示词区（v43 :1368-1379 形态）=====

export function mountGlobalPrompt(container, projectId, opts = {}) {
  if (typeof document === "undefined" || !container || !projectId) return null;
  const proj = storeLoad(projectId);
  if (!proj) return null;

  const sec = el("div", { class: "fgroup open prompt-global", "data-prompt-global": projectId });
  sec.style.cssText = "margin-top:2px";

  // 折叠头（v43 :1369）
  const cap = el("div", { class: "fg-cap" });
  cap.appendChild(document.createTextNode(t("prompt.gp.cap")));
  cap.appendChild(el("span", { class: "inh", text: t("prompt.gp.inh") }));
  const capIcw = el("span", { class: "icw" });
  capIcw.appendChild(el("span", { "data-ic": "chev", "data-sz": "14" }));
  cap.appendChild(capIcw);
  cap.addEventListener("click", () => sec.classList.toggle("open"));
  sec.appendChild(cap);

  // body：textarea
  const body = el("div", { class: "fg-body" });
  const ta = el("textarea", { class: "gp", id: "gpText", "data-gp-text": "1", rows: "3" });
  ta.value = proj.globalPrompt || "";
  // 输入即落盘 + 通知 setup / segcards 重渲染
  ta.addEventListener("input", () => {
    proj.globalPrompt = ta.value;
    storeSave(proj);
    // 段卡 pv 同步更新（事件广播）
    document.dispatchEvent(new CustomEvent("prompt:gp-change", { detail: { value: ta.value } }));
  });
  body.appendChild(ta);

  sec.appendChild(body);
  container.appendChild(sec);

  // @联想绑定（全局提示词 textarea · v43 :3315 atBind(gpText) 同源）
  // assetsGetter 走 getCachedAssets（资产 fetch 异步完成后下次 input 自动用最新）
  atBind(ta, {
    assets: getCachedAssets(),
    assetsGetter: () => getCachedAssets(),
    onPick: () => {
      // 选中即触发 input 事件 → 走 store.save + refresh 链路
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });

  // 批 R8 · R7-1：折叠头 data-ic 补 hydrate（icw chev 14；幂等）
  hydrateIcons(sec);

  return sec;
}

// ===== 段卡 sc-prompt @联想 + pv-pre 数据接入 =====

// 事件委托绑定（v43 :3314-3316 atBind 三处显式绑定的段卡补绑版 —— 裁决落实）
// 动态增段由委托自动覆盖（事件冒泡到 rootEl）
// 资产晚加载场景：assetsGetter 每次 input 重新读 getCachedAssets()，
//   即使资产 fetch 异步完成，新绑的 textarea 也会读到最新资产
export function bindSegcardsAtMention(rootEl, opts = {}) {
  if (typeof document === "undefined" || !rootEl) return null;
  const initialAssets = opts.assets || getCachedAssets();
  const assetsGetter = opts.assetsGetter || (() => getCachedAssets());

  // 一次性挂委托（focusin：段卡 textarea 第一次聚焦时挂 @联想）
  if (!rootEl._segAtBound) {
    rootEl.addEventListener("focusin", (ev) => {
      const t = ev.target;
      if (t && t.classList && t.classList.contains("sc-prompt") && t.tagName === "TEXTAREA" && !t._atb) {
        atBind(t, {
          assets: initialAssets,
          assetsGetter,
          onPick: () => t.dispatchEvent(new Event("input", { bubbles: true })),
        });
      }
    });
    rootEl._segAtBound = true;
  }
  return { root: rootEl, assetsGetter };
}

// 单段 pv-pre 数据接入（v43 :3446-3468 v25UpdateOneSeg 形态）
export function refreshSegPv(card, globalPrompt, assetMap) {
  if (!card) return;
  const m = assetMap || buildAssetMap(getCachedAssets());
  const ta = card.querySelector(".sc-prompt");
  const gp = (globalPrompt || "").trim();
  const segTxt = ta ? ta.value : "";
  const built = buildSegBody(segTxt, gp, m);
  const bar = card.querySelector(".pv-bar");
  const pre = card.querySelector(".pv-pre");
  if (bar) {
    const chips = bar.querySelector(".refchips");
    const arr = bar.querySelector(".arr");
    if (chips) renderChips(chips, built.refs, m);
    // 老板走查批C：段卡预览条常显（原「无 @N 引用 → display:none」分支删除——
    //   老板要求每个分镜提示词下常显可折叠预览框；pv-pre 正文始终给原提示词合成）
    bar.style.display = "flex";
    if (arr) arr.textContent = pre && pre.classList.contains("show") ? "▴" : "▾";
  }
  if (pre) {
    const note = pre.querySelector(".note");
    const body = pre.querySelector(".body");
    if (note) note.textContent = t("prompt.pv.note");
    if (body) body.textContent = built.body;
  }
}