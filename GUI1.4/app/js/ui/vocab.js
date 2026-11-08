// ui/vocab.js — 词库面板（B3-T3 F8 · 引擎 #26 九分项词表）。
//
// === 出处注记 ===
// 形态复刻 legacy/app/js/components/vocab_assistant.js（九组 div + 词条胶囊 span + 标题
// 「词库 (点击词条插入)」+ 空组「—」占位 + 点词条 onInsert(word) → 面板隐藏〔消费即用〕）；
// 1.3 新定：单实例 + 多宿主互斥迁移（A 处开面板再开 B → 面板迁 B·legacy 无此语义）。
//
// 数据：openVocabPanel 内直接走 core/vocab.js fetchVocab（一次缓存 + in-flight 复用）；
//   失败返 {} → 面板显示「词库不可用（引擎未连接）」提示（九组形不塌）。
//
// 生命周期：面板节点挂在调用方宿主内 → 宿主销毁面板随销（本件不持全局监听/定时器）。
import { fetchVocab } from "../core/vocab.js";
import { t, pickDisplay, getLang } from "../core/i18n.js";   // #89 T5a：词库面板三常量文案入典 ui.vocab.*（SHOT_VOCAB_KEYS=引擎词表契约键禁译）；#92 B6 组标题 pickDisplay 映射；#92 B7 词条显示映射+EN 插入提示行

export const SHOT_VOCAB_KEYS = [
  "镜头角度", "景别", "运镜方式", "运镜方向",
  "运镜幅度", "运镜速度", "焦段", "氛围", "情绪",
];

let _panel = null; // 单实例（全应用至多一个词库面板）

// openVocabPanel({host, onInsert}) — 打开/迁移面板到 host 并拉取词表；返面板句柄。
export function openVocabPanel(opts) {
  const o = opts || {};
  const host = o.host;
  if (!host || typeof host.appendChild !== "function") return null;
  if (!_panel) _panel = buildPanel();
  _panel.attach(host, o.onInsert);
  void _panel.refresh();
  return _panel;
}

// toggleVocabPanel({host, onInsert}) — F49 点钮 toggle 化：同宿主面板开着 → 收（返 false）；
//   否则走 openVocabPanel 开/迁移展开（返 true）；坏 host 透传 openVocabPanel 的 null。
export function toggleVocabPanel(opts) {
  const host = (opts || {}).host;
  if (_panel && !_panel.root.hidden && _panel.root.parentNode === host) {
    _panel.root.hidden = true;
    return false;
  }
  if (!openVocabPanel(opts)) return null;
  return true;
}

// appendVocabWord(el, word) — 插入口径（1.0 定案）：追加到值末尾·不动光标·非空值空格分隔；
//   派发 input 事件（段卡防抖预览链/全局提示词同步不断）。
export function appendVocabWord(el, word) {
  if (!el || typeof el.value !== "string" || typeof word !== "string" || !word) return false;
  el.value = el.value ? `${el.value} ${word}` : word;
  if (typeof el.dispatchEvent === "function" && typeof Event === "function") {
    try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_e) { /* 防御 */ }
  }
  return true;
}

// 测试辅助：丢弃单例（测试间隔离用）
export function _test_resetVocabPanel() { _panel = null; }

function makeEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildPanel() {
  const state = { onInsert: null };
  const root = makeEl("div", "vocab-panel");
  root.hidden = true;
  root.appendChild(makeEl("div", "vocab-panel__title", t("ui.vocab.title")));
  // #92 B7：EN 模式插入提示行（标题下）——zh 空串不渲染（面板结构零变）；切换=整页 reload 故建板期取词同语言一致
  const hint = t("ui.vocab.insertHint");
  if (hint) root.appendChild(makeEl("div", "vocab-panel__hint", hint));
  const notice = makeEl("div", "vocab-panel__notice", t("ui.vocab.unavailable"));
  notice.hidden = true;
  root.appendChild(notice);

  const listEls = {}; // key → .vocab-group__list 节点
  for (const key of SHOT_VOCAB_KEYS) {
    const group = makeEl("div", "vocab-group");
    // #92 B6：组标题显示映射（en=MAPS.vocabGroup·zh 直通）；key 本身=数据键（词表取数）零改
    group.appendChild(makeEl("span", "vocab-group__label", pickDisplay("vocabGroup", key)));
    const list = makeEl("div", "vocab-group__list");
    group.appendChild(list);
    root.appendChild(group);
    listEls[key] = list;
  }

  function renderGroup(key, words) {
    const list = listEls[key];
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!words.length) {
      list.appendChild(makeEl("span", "vocab-group__empty", t("ui.vocab.empty")));
      return;
    }
    for (const w of words) {
      // E块中英对照：词条兼容 {phrase, phrase_en} 对象形态（shot_vocab 结构）——带英文字段时
      //   hover 显英文；在线引擎契约为字符串数组（无英文）→ 不显示（形态兼容·两种都不破）
      const isObj = w != null && typeof w === "object";
      const phrase = isObj ? String(w.phrase != null ? w.phrase : "") : String(w);
      const en = isObj && typeof w.phrase_en === "string" ? w.phrase_en.trim() : "";
      // #92 B7：en 模式词条显示英文（对象形态 phrase_en 优先→MAPS.vocabWord 映射→未覆盖直通）；
      //   zh 模式显示原词（逐字零变）；title=「中文 · 英文」对照；点击仍插中文 phrase（提示词内容不变）
      const disp = getLang() === "en" ? (en || pickDisplay("vocabWord", phrase)) : phrase;
      const item = makeEl("span", "vocab-word", disp);
      if (en || disp !== phrase) item.title = phrase + " · " + (en || disp);
      item.addEventListener("click", () => {
        // 迁移后回调已切换（state.onInsert 读当下宿主回调，闭包不固化旧宿主）
        const fn = state.onInsert;
        try { if (typeof fn === "function") fn(phrase); } catch (_e) { /* 业务回调异常不挡 UI */ }
        root.hidden = true; // 消费即用
      });
      list.appendChild(item);
    }
  }

  function setVocab(next) {
    const v = (next && typeof next === "object") ? next : {};
    let available = false;
    for (const key of SHOT_VOCAB_KEYS) {
      const words = Array.isArray(v[key]) ? v[key] : [];
      renderGroup(key, words);
      if (words.length) available = true;
    }
    notice.hidden = available;
  }

  function attach(host, onInsert) {
    state.onInsert = (typeof onInsert === "function") ? onInsert : null;
    if (root.parentNode !== host) {
      if (root.parentNode) root.parentNode.removeChild(root);
      host.appendChild(root);
    }
    root.hidden = false;
  }

  function refresh() {
    return fetchVocab().then((v) => setVocab(v));
  }

  // 初始态：九组空占位（提示在数据回来前不闪）
  for (const key of SHOT_VOCAB_KEYS) renderGroup(key, []);

  return { root, attach, setVocab, refresh };
}
