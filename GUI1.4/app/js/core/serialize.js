// core/serialize.js — 三个序列化函数（最小提取自 legacy/app/js/domain/resources.js）
//   - serializeResources       legacy resources.js :125-140
//   - serializeLoraOverrides   legacy resources.js :167-179
//   - serializeOverrides       legacy resources.js :258-262（_OVK 常量 :256 同源）
//
// 出处注记（S1-2 T6 纪律）：
//   - 改造自 legacy/app/js/domain/resources.js（1423 行）
//   - 三函数皆为纯函数，无 DOM/网络/外部依赖；
//     legacy 中各自的 import 仅用于其它导出函数，本三函数零依赖
//   - 提取理由：submit.js submit body 需三个序列化产物（resources_list / resource_overrides / lora_overrides 三个 widget）
//   - 行为零变：旧测试 35 例 submit 行为契约不变；本文件独立测试 8 例守原生三函数边界

// ---- serializeResources ----
// 编辑资源列表 → JSON 字符串；过滤 template 源；五字段白名单；
//   category 仅 turbo/style 落位（其余非法值不写入）
export function serializeResources(list) {
  const out = [];
  for (const e of (list || [])) {
    if (!e || e.source === "template") continue;
    const o = {
      name: e.name,
      strength_model: e.strength_model,
      strength_clip: (e.strength_clip === undefined) ? null : e.strength_clip,
      order: e.order,
      source: e.source,
    };
    if (e.category === "turbo" || e.category === "style") o.category = e.category;
    out.push(o);
  }
  return JSON.stringify(out);
}

// ---- serializeLoraOverrides ----
// LoRA 模板覆写 map → JSON 字符串；过滤空键/非对象/NaN strength/纯空白 name；
//   strength/disabled/name 字段按值类型筛选落位
export function serializeLoraOverrides(map) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    const v = map[k];
    if (!k || !v || typeof v !== "object") continue;
    const e = {};
    if (typeof v.strength === "number" && isFinite(v.strength)) e.strength = v.strength;
    if (v.disabled === true) e.disabled = true;
    if (typeof v.name === "string" && v.name.trim()) e.name = v.name;
    if (Object.keys(e).length) out[k] = e;
  }
  return JSON.stringify(out);
}

// ---- serializeOverrides ----
// 模型/CLIP/VAE 覆写 map → JSON 字符串；_OVK 四槽白名单；非字符串/空串跳过
const _OVK = ["unet", "clip", "vae_video", "vae_audio"];

export function serializeOverrides(map) {
  const out = {};
  for (const k of _OVK) { const v = map && map[k]; if (typeof v === "string" && v) out[k] = v; }
  return JSON.stringify(out);
}