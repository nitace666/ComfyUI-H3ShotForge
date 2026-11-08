// workspace.js — 输出根目录读链（R-59 T2·老板裁档位甲）
//   唯一职责：读 data/settings.json 聚合子键 workspace_root（伴生服务 POST /gui13-fs/set_workspace 写入）。
//   读链复用 core/server_storage.js readAgg（= settings.js _aggRead 的 server 侧·M-T4 体系）——core 不 import views。
//   **刻意不走 localStorage**：devserver 只认 data/settings.json，localStorage 侧伴生服务读不到
//   （cfArgs 反面先例：存而不用）。返回 ""（缺失/非字符串）或绝对路径串。
import { readAgg, SETTINGS_JSON } from "./server_storage.js";

export function loadWorkspaceRoot() {
  const v = readAgg(SETTINGS_JSON, "workspace_root");
  return typeof v === "string" ? v.trim() : "";
}
