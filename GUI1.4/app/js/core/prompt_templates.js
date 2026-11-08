// prompt_templates.js — 三类提示词模板读链（T5 #1·复验整改）
//   唯一职责：生成链按 kind 取模板正文。读 data/settings.json 聚合子键 tpl（设置页写入·
//   存储键与字段名 tplThreepov/tplScene/tplProp 零改动），四态判定后返回生效正文。
//   读链复用 core/server_storage.js readAgg（照 workspace.js 范式）——core 不 import views。
//   存量占位治理走读取层：data/settings.json 为清写禁区，旧占位值读到即换新默认。
import { readAgg, SETTINGS_JSON } from "./server_storage.js";

// 旧占位原文（v43 字段清单·存量 data/settings.json tpl 三键现值——逐字对照常量，勿改写）
export const LEGACY_PLACEHOLDER = {
  tplThreepov: "角色: 主角|主角2|主角3\n视角: 正|侧|背\n情绪: 平静|激动",
  tplScene: "场景: 主场景|次场景\n时间: 白天|夜晚\n氛围: 紧张|温馨",
  tplProp: "道具: 主道具|次道具\n位置: 前景|中景|背景\n状态: 新|旧",
};

// 新默认正文（方案 v3 §5 定稿·全文照抄）——设置页 TP_DEFAULTS 与生成链取用的单一真值源
export const TPL_DEFAULTS = {
  tplThreepov: "正面、侧面、背面三视角全身站姿，同一角色保持完全一致（脸型、发型、体型、服装、配色不变）。纯色浅背景，光线均匀柔和，无阴影遮挡细节。四肢完整清晰，手指可辨。全身入画不裁切，三视角横向并列等高排布。风格写实统一，与分镜项目画风一致。",
  tplScene: "单场景环境全景构图，空间纵深明确（前景、中景、背景层次分明）。光照方向统一，氛围与时段一致，色彩协调不过饱和。画面干净无多余元素，无人物主体，建筑与道具结构清晰、透视准确。视角平视略仰，视野开阔完整呈现场景全貌。",
  tplProp: "单件道具多角度展示，正面为主视角，细节完整。结构清晰、比例准确，材质质感明确（金属/木质/布料等可辨识）。纯色浅背景，光线均匀，突出道具本体。无手部持握、无场景干扰，道具独立完整入画，边缘不裁切。",
};

const KIND_KEY = { threepov: "tplThreepov", scene: "tplScene", prop: "tplProp" };

// 生成链模板读取：kind='threepov'|'scene'|'prop' → 生效正文。
//   四态判定（键缺失/空串/纯空白/逐字等于旧占位 → 新默认正文；否则原值）。
export function resolveTemplate(kind) {
  const key = KIND_KEY[kind];
  const stored = readAgg(SETTINGS_JSON, "tpl");
  const v = stored ? stored[key] : undefined;
  if (typeof v !== "string" || !v.trim() || v === LEGACY_PLACEHOLDER[key]) return TPL_DEFAULTS[key];
  return v;
}

// 文本法提交体组装：模板在前、描述在后（描述空 = 只发模板正文）；引擎 text 槽上限 4096——
//   拼接超 4000 时截模板保描述（截前 1500 字再拼）。
export function buildPromptText(tpl, desc) {
  if (!desc) return tpl;
  const t = tpl.length + 2 + desc.length > 4000 ? tpl.slice(0, 1500) : tpl;
  return t + "\n\n" + desc;
}
