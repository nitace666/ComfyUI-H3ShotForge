// V1.9 D1 拆分: 聚合入口 — 仅转发 batch_renderer.js 所需的 exports
// 真实实现见: main.js (核心域) + pool.js (素材池域) + bindings.js (绑定域) + assets.js (资产库域)
// 约定: 仅 openForm / closeForm 两个函数被 batch_renderer.js 显式调用; 其他导出备扩展用
export { openForm, closeForm } from "./main.js";