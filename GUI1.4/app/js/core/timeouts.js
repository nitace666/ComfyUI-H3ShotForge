// 全仓 HTTP 超时集中表（批2 #57 档2）
//   唯一事实来源：各链超时一律引本表·不得就地内联数值（防静默漂移）。
//   零依赖（不 import 任何模块）·core 内无环。
export const TIMEOUTS = Object.freeze({
  default: 30000,        // 通用默认（api.js 请求级默认·concat/postfx 受理拍同口径）
  llmChat: 90000,        // LLM 对话单请求（引擎侧 60s 上限·前端留余量）
  submit: 180000,        // 提交受理（引擎排队 + 组装·长）
  statusPoll: 5000,      // 状态轮询单拍（半死引擎下拍长封顶）
  bootPoll: 3000,        // 启动轮询单拍
  probe: 10000,          // 恢复链探活单拍（批3 #48：2s→10s·引擎忙时单拍不误判不可达）
  exportAccept: 30000,   // 导出受理/轮询（伴生出口统一闸）
  uploadTransfer: 90000, // 上传体传输（multipart·时长随体量伸缩）
});

// LLM 对话默认超时（老板 2026-10-26：本地模型反应慢 → 默认 300 秒；设置页可配 30-900 秒）。
//   独立导出而不并入 TIMEOUTS：表键集有八键锁（timeouts.test.mjs），本文件仍是超时值唯一来源。
//   消费方 = core/llm_chat.js（readChatTimeoutMs 兜底）+ views/settings.js（设置项默认值 / 范围）。
export const LLM_CHAT_TIMEOUT_DEFAULT_MS = 300000;
export const LLM_CHAT_TIMEOUT_MIN_SEC = 30;
export const LLM_CHAT_TIMEOUT_MAX_SEC = 900;
