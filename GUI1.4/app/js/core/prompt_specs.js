// prompt_specs.js — 提示词规范文本单一事实来源
//
// 用途：① AI 协作发送侧输出规范块（ai-archive.js · #26/#36）
//      ② 段卡「一键优化」系统提示词（segcards.js · H3 时间线提示词 + GUI 适配约束）
// 定位：两份规范正文只在此维护，视图层只引用、不内联。纯字符串/纯数组，无 DOM、无副作用。
// 改动纪律：正文逐字变更即行为变更——须先经老板裁决并同步更新 prompt_specs.test.mjs 快照。

// AI 协作输出规范（六条约定：分镜=时间线为主·六段由全局+分镜拼装 / 保留 @引用 / 禁引擎标签 / 【提示词】包裹 / 分镜表可用表格 / 拆镜固定格式）
export const CHAT_OUTPUT_SPEC_TEXT = "当你要给出可直接用于视频生成的提示词时：①分镜提示词以时间线为主（六段式改由 全局提示词+分镜 拼装而成：风格契约/主体定义/负面清单写在全局提示词，画面锚定由程序自动注入——【提示词】块内不要重复输出这些段；需要讲解或给独立完整版时可在块外按六段式说明）；②@资产引用原样保留、不增不减；③不输出任何引擎标签（<Picture N>/<Subject N>/<Video N>/<d></d> 等）；④用 【提示词】…【/提示词】 包裹提示词正文；⑤分镜表仍可用表格/列表输出。⑥需要拆镜时按固定格式输出（每段一行：镜头N｜画面：…｜时长：X秒｜运镜：…），普通对话不要使用分镜格式。";

// 段卡优化系统提示词规范行（角色 + H3 时间线骨架 + GUI 六条适配约束）
// 已知条件（时长/镜头九项）与原提示词由 buildOptimizePrompt 拼接在规范行之后。
export const OPTIMIZE_SPEC_LINES = [
  "你是资深分镜提示词编辑。把用户给出的分镜提示词改写为 H3 时间线提示词（全局提示词已承担风格契约/主体定义/负面清单，画面锚定由引擎自动注入），直接输出正文。",
  "",
  "结构（只写以下两段）：",
  "[时间线] 从 0s 起按本段时长连续分段，每段一个主动作，首尾衔接不留空隙。",
  "[镜头] 每个时间段显式写出机位、景别、运镜。",
  "",
  "GUI 适配规则（必须遵守）：",
  "1. 不输出引擎标签语法，禁止 <Picture N>、<Subject N>、<Video N>、<d></d> 等标签。",
  "2. 资产一律用 @名字 或 @N 引用，所有 @资产引用原样保留，不增不减、不改写。",
  "3. 镜头描述须与下方已知镜头设定一致，不得矛盾；未给出的维度不限。",
  "4. 时间线按本段实际时长分段，连续覆盖不留空隙。",
  "5. 篇幅约 130 个中文字，参考素材多时更短。",
  "6. 只返回优化后的提示词正文，不要解释、引号、前缀或后缀。",
];

// ============================================================================
// #41 文档源可配置（T3·GUI 侧）：优化规范行覆盖层——外部文档预取缓存
//   链路：boot（server_storage.bootDataStep 末尾 best-effort）与设置页保存链调
//   prefetchOptimizeDoc(aiDocs.optimizeDocPath) → GET /gui13-fs/read_doc（同源伴生·devserver T2）
//   → 200 且内容非空按行拆入缓存；未配/失败（含 200 空文档·主代理裁决补笔）→ resolveOptimizeSpecLines 回内置。
//   纯 core：无 DOM、无 views 依赖；失败提示的去重位随缓存重置（换路径保存即重置）。
// ============================================================================

// 模块级预取缓存：lines=null = 未配/失败（回内置）；failed = 最近一次预取失败标记；
// failToasted = 失败提示会话级去重位（弹层打开处消费一次）。
let _optimizeDoc = { lines: null, failed: false, failToasted: false };

// 预取外部优化文档（async·best-effort 不抛）：
//   path 空 = 清除 → 清缓存回内置态；非空 → fetch read_doc，
//   200 且内容非空 → 按行存 lines；200 空文档（trim 后空）/非 200/网络失败 → failed=true（回内置·走既有 toast/hint 链）。
//   每次调用重置缓存与 toast 去重位（换路径重置）。
export async function prefetchOptimizeDoc(path) {
  const p = typeof path === "string" ? path.trim() : "";
  _optimizeDoc = { lines: null, failed: false, failToasted: false };
  if (!p) return;
  try {
    const resp = await fetch("/gui13-fs/read_doc?path=" + encodeURIComponent(p), { cache: "no-store" });
    const text = resp.ok ? String(await resp.text()) : "";
    if (text.trim() === "") _optimizeDoc.failed = true;   // 空文档 = 无效档 → 按失败处理（不得以 [""] 替换内置）
    else _optimizeDoc.lines = text.split(/\r\n|\r|\n/);
  } catch (_e) {
    _optimizeDoc.failed = true;
  }
}

// 同步取当前生效的优化规范行（buildOptimizePrompt 消费点·未配/失败回内置数组本体）
export function resolveOptimizeSpecLines() {
  return _optimizeDoc.lines ?? OPTIMIZE_SPEC_LINES;
}

// 最近一次预取是否失败（设置页/弹层判定展示用）
export function optimizeDocFailed() {
  return _optimizeDoc.failed;
}

// 失败提示去重消费位：failed 且本会话未提示过 → 置已提示并返回 true（segcards 弹层打开处调）
export function consumeOptimizeDocFailedToast() {
  if (!_optimizeDoc.failed || _optimizeDoc.failToasted) return false;
  _optimizeDoc.failToasted = true;
  return true;
}
