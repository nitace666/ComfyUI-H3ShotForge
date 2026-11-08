// core/llm_shotgen.js — LLM 智能拆镜纯函数四件（B6-T4 A2）。
//
// === 出处注记 ===
// 取码自 legacy/app/js/domain/llm_shotgen.js:1-262（批 L 任务 L3）纯函数整取，零逻辑改动；
// 采纳侧由视图层改为 store.addSegment+updateSegment 直写（1.3 单向流），
// toShotRow 键形 {prompt, 运镜方式, 段落时长} 即 patch 契约（v2-8：仅「段落时长」→durationSec
// 一处转换，由视图层执行；「运镜方式」为 store 真实键名直写）。
//
// 契约：
//   buildShotgenPrompt(userText)         → 四列 markdown 模板（画面描述/运镜/时长/参考提示）
//   parseShotgenReply(reply)             → {ok:true, rows:[{desc,motion,duration,ref}]} | {ok:false, reason}
//   normalizeMotion(raw, vocab)          → vocab["运镜方式"] 归一命中值 | null
//   toShotRow(suggestion, seq[, vocab])  → {prompt, 运镜方式, 段落时长}

const MOTION_VOCAB_KEY = "运镜方式";

// 列名归一映射 — 表头名称 → 标准键 (含方案 v2 §一② 列名变体容错)
//   顺序敏感: 先匹配 desc 类 (画面/描述/画面描述/分镜描述),
//   再 motion 类 (运镜/镜头/运镜方式), 再 duration/ref/台词
const HEADER_ALIAS = {
  desc:      ["画面描述", "画面", "描述", "分镜描述", "分镜内容", "shot", "画面描述内容"],
  motion:    ["运镜", "运镜方式", "镜头", "镜头运动", "camera"],
  duration:  ["时长", "段落时长", "秒数", "时长秒", "duration"],
  ref:       ["参考提示", "参考", "参考词", "参考要素", "ref"],
  // 台词/对话/旁白 — 方案 v2 丢弃, 不映射到行字段; 仅记录以便解析时静默丢弃
  discard:   ["台词", "对话", "旁白", "字幕", "dialogue"],
};

// ============================================================================
// 1. buildShotgenPrompt — 系统指令模板
//   不要求 LLM 输出台词列 (方案 v2 定案台词丢弃, §一②)
// ============================================================================

export function buildShotgenPrompt(userText) {
  const u = (typeof userText === "string") ? userText.trim() : "";
  return [
    "你是 AI 分镜师. 请将用户的一句话按固定 markdown 表格式拆成多行分镜.",
    "",
    "严格按以下四列输出 (不输出其他列):",
    "| 画面描述 | 运镜 | 时长 | 参考提示 |",
    "| --- | --- | --- | --- |",
    "| ... | ... | ... | ... |",
    "",
    "要求:",
    "1. 用 ```markdown ... ``` 围栏包住整张表;",
    "2. 画面描述写主体动作+环境; 运镜给标准运镜方式 (固定机位/推近/拉远/摇镜/移镜/跟拍/升降/环绕 等);",
    "3. 时长用阿拉伯数字 (秒); 参考提示写视觉风格/构图要素.",
    "4. 不要写其他列 (如对话/旁白/字幕/镜头号) — 不需要.",
    "",
    "用户原话:",
    u,
  ].join("\n");
}

// ============================================================================
// 2. parseShotgenReply — 解析 markdown 表
//   入参 reply: LLM 返回的整段文本
//   出参: {ok:true, rows:[{desc,motion,duration,ref}]}
//        | {ok:false, reason}
//   不抛异常.
// ============================================================================

export function parseShotgenReply(reply) {
  if (typeof reply !== "string" || !reply.trim()) {
    return { ok: false, reason: "empty_reply" };
  }
  // 全文全角竖线 → 半角 (在切行前归一, 否则 fenceRe + 退路都失效)
  const text = reply.replace(/｜/g, "|");

  // 1) 抽 ``` 围栏代码块 (优先 markdown 围栏, 退路任意 ```)
  let body = text;
  const fenceRe = /```(?:markdown|md)?\s*([\s\S]*?)```/i;
  const fm = text.match(fenceRe);
  if (fm) {
    body = fm[1];
  } else {
    // 围栏不存在 → 退路: 取含表格行的子串 (从首行带 | 开始)
    const firstPipe = text.indexOf("|");
    if (firstPipe < 0) return { ok: false, reason: "no_table" };
    body = text.substring(firstPipe);
  }

  // 2) 行切分 + 去 BOM + 跳空行
  const lines = body
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 3) 找表头行 + 分隔行 (---|---)
  let headIdx = -1;
  let sepIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    if (lines[i + 1].match(/^\|?\s*:?-{2,}/) || /^\s*\|?(\s*:?-{2,}\s*\|)+\s*:?-{2,}\s*\|?\s*$/.test(lines[i + 1])) {
      headIdx = i;
      sepIdx = i + 1;
      break;
    }
  }
  if (headIdx < 0) return { ok: false, reason: "no_table_header" };

  // 4) 表头 → 列标准键 (alias 归一)
  const headers = _splitRow(lines[headIdx]);
  const headerKeys = headers.map(_normalizeHeader);
  if (!headerKeys.includes("desc")) {
    // 缺画面描述列 → 不视为分镜表
    return { ok: false, reason: "missing_desc_column" };
  }

  // 5) 数据行
  const rows = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.includes("|")) continue; // 跳过表外空内容/无竖线行
    const cells = _splitRow(ln);
    if (cells.length < 2) continue;
    const rec = { desc: "", motion: "", duration: "", ref: "" };
    for (let c = 0; c < headerKeys.length && c < cells.length; c++) {
      const k = headerKeys[c];
      if (!k) continue; // discard 类 (台词)
      const v = (cells[c] || "").trim();
      if (k in rec) rec[k] = v;
    }
    // 空行 (四列都空) → 跳过
    if (!rec.desc && !rec.motion && !rec.duration && !rec.ref) continue;
    // 时长归一为数字 (与 toShotRow 契约对齐)
    let durNum = "";
    if (rec.duration) {
      const n = parseFloat(String(rec.duration));
      durNum = Number.isFinite(n) ? n : "";
    }
    rows.push({
      desc: rec.desc,
      motion: rec.motion,
      duration: durNum,
      ref: rec.ref,
    });
  }

  if (rows.length === 0) return { ok: false, reason: "no_data_rows" };
  return { ok: true, rows };
}

// _splitRow — 切一行 markdown 表格 (容忍前后空 |, 全角竖线, 单元格内 <br> 归一空格)
function _splitRow(line) {
  // 全角竖线 → 半角
  let s = line.replace(/｜/g, "|");
  // <br> / <br/> / <br /> 标签 → 空格 (LLM 偶尔在 cell 内输出)
  s = s.replace(/<br\s*\/?>/gi, " ");
  // 去首尾 |
  if (s.startsWith("|")) s = s.substring(1);
  if (s.endsWith("|")) s = s.substring(0, s.length - 1);
  // 单元格内裸 \n 归一空格 (避免单行 split 残留空)
  s = s.replace(/[\r\n]+/g, " ");
  // 按 | 切
  return s.split("|").map((c) => c.trim());
}

// _normalizeHeader — 表头列名归一 (返回 "desc"/"motion"/"duration"/"ref"/"discard"/null)
function _normalizeHeader(raw) {
  const h = (raw || "").trim();
  if (!h) return null;
  for (const [std, list] of Object.entries(HEADER_ALIAS)) {
    for (const alias of list) {
      if (h === alias) return std;
    }
  }
  // 模糊包含: "画面描述 (秒)" 这类附注也能匹配
  for (const [std, list] of Object.entries(HEADER_ALIAS)) {
    for (const alias of list) {
      if (h.includes(alias)) return std;
    }
  }
  return null;
}

// ============================================================================
// 3. normalizeMotion — 运镜归一 (与运行时 vocab["运镜方式"] 做匹配)
//   匹配优先级: 精确 > 去空格精确 > 包含 (raw 含 vocab 项 或 vocab 项含 raw)
//   不中 → null
// ============================================================================

export function normalizeMotion(raw, vocab) {
  if (typeof raw !== "string") return null;
  if (!vocab || typeof vocab !== "object") return null;
  const list = vocab[MOTION_VOCAB_KEY];
  if (!Array.isArray(list) || list.length === 0) return null;
  const r = raw.trim();
  if (!r) return null;

  // 1) 精确
  for (const v of list) {
    if (r === v) return v;
  }
  // 2) 去空格精确
  const rNoSpace = r.replace(/\s+/g, "");
  for (const v of list) {
    const vNoSpace = String(v).replace(/\s+/g, "");
    if (rNoSpace === vNoSpace) return v;
  }
  // 3) 包含: raw 包含 vocab 项 (e.g. "缓慢推近" → "推近")
  for (const v of list) {
    if (r.includes(v)) return v;
  }
  // 4) 包含反向: vocab 项包含 raw (e.g. raw="推" 命中 "推近" — 不太可能, 保留兜底)
  for (const v of list) {
    if (String(v).includes(r)) return v;
  }
  return null;
}

// ============================================================================
// 4. toShotRow — 按方案映射表组装分镜行数据
//   入参 suggestion: {desc, motion, duration, ref}
//       seq:        行序 (>=1; 当前 0 不入数据)
//       vocab:      可选 — 运行时 vocab; 传入则 motion 走 normalizeMotion 归一
//                   不传则 motion 直接透传 (假设 suggestion.motion 已归一)
//   出参: {prompt, 运镜方式, 段落时长}
//         (ID/导出文件名 留空 — 由 store.addSegment 自动续)
// ============================================================================

export function toShotRow(suggestion, seq, vocab) {
  const s = (suggestion && typeof suggestion === "object") ? suggestion : {};
  const desc = (s.desc || "").trim();
  const ref = (s.ref || "").trim();
  const rawMotion = (s.motion || "").trim();
  const rawDur = s.duration;

  // prompt: desc + ref 拼接为一段
  let prompt = desc;
  if (ref) prompt = (prompt ? (prompt + " " + ref) : ref);

  // 运镜归一
  let motion = "";
  if (vocab != null) {
    const norm = normalizeMotion(rawMotion, vocab);
    motion = norm || "";
  } else {
    motion = rawMotion;
  }

  // 时长数字提取 (秒; 非法 → 空)
  let duration = "";
  if (typeof rawDur === "number" && Number.isFinite(rawDur)) {
    duration = rawDur;
  } else if (typeof rawDur === "string" && rawDur.trim()) {
    const m = rawDur.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0]);
      duration = Number.isFinite(n) ? n : "";
    }
  }

  return {
    "prompt": prompt,
    "运镜方式": motion || "",
    "段落时长": duration,
  };
}
