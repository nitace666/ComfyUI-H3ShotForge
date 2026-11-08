// healthcheck.js — 首启体检·数据层（地基批1档2 T8 · 账本 #52 GUI 侧）
//
// 只做「取数 + 判定」，不碰 DOM（UI 渲染在 views/shell.js·壳层生命周期内）：
//   runHealthcheck() → GET /gui13-fs/healthcheck（self:true = 恒同源相对·伴生服务与页面同源）
//                      → {ok, items, red}；请求失败/非 JSON/非 2xx → {ok:false, items:[], red:[], error:true}
//   HEALTH_GUIDE    → 七项 id → 白话指引（红项横幅逐字引用·枚举锁）
//
// 服务端口径（devserver T7 落地）：七项 id 固定顺序
//   engine / data_service / ffmpeg / engine_dir / engine_port / disk / custom_nodes
//   detail：engine={version, vram_total_mb}(取不到给 null) · data_service="self"
//           ffmpeg={ffmpeg,ffprobe,missing} · engine_dir={engine_dir_exists,venv_python}
//           engine_port={listening} · disk={workspace_free_gb,engine_free_gb}
//           custom_nodes={installed,missing}
import { fetchApi } from "../core/api.js";
import { t } from "../core/i18n.js";   // #89 T5a：指引文案入典（getter 取词=渲染时求值·结构键面不变）

// 体检端点（同源伴生服务·路径常量单点）
const HEALTHCHECK_PATH = "/gui13-fs/healthcheck";

// 白话指引（红项横幅逐字文案·按服务端七项 id 一一对应·#89 T5a 逐条入典 hc.guide.*）
export const HEALTH_GUIDE = {
  get engine() { return t("hc.guide.engine"); },
  get data_service() { return t("hc.guide.data_service"); },
  get ffmpeg() { return t("hc.guide.ffmpeg"); },
  get engine_dir() { return t("hc.guide.engine_dir"); },
  get engine_port() { return t("hc.guide.engine_port"); },
  get disk() { return t("hc.guide.disk"); },
  get custom_nodes() { return t("hc.guide.custom_nodes"); },
};

// 体检失败档（服务不可达 / 非 JSON / 非 2xx / 畸形响应）——不谎报「全绿」
function healthError() {
  return { ok: false, items: [], red: [], error: true };
}

// 取数 + 判定：红项 = items 里 ok 非真者（逐字 items.filter(i=>!i.ok)）
export async function runHealthcheck() {
  let payload = null;
  try {
    const resp = await fetchApi(HEALTHCHECK_PATH, { self: true });
    if (!resp || !resp.ok) return healthError();
    payload = await resp.json();
  } catch (_e) {
    return healthError();
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) return healthError();
  const items = payload.items;
  const red = items.filter((i) => !i || !i.ok);
  return { ok: payload.ok === true && red.length === 0, items, red };
}
