// GUI 1.3 连接层 — 引擎 HTTP 客户端 (S1-0 任务 T4).
//
// === 出处注记 (S1-0 任务 T4 纪律) ===
// 改造自 legacy/app/js/core/api.js (272 行);
// 改造点 = ①postfx busy (classifyBusy 第四态, M1 口径)
//        ②403 专属分支 (引擎同源校验拒绝透传, 不落通用 ≥400)
//        ③BASE URL 单一配置点 (模块级 setBase/getBase, 默认 8190 验证实例);
// 其余逻辑原样.
//
// === S1-1 T0 结转修正笔 ===
// 删 joinBase LEGACY_PATH_PREFIX 特判分支 (旧式传参 "/h3_batch/xxx" 不再原样透传;
// 改走 BASE_URL 拼接得引擎真实端点 — 消除节点门 B 审指出的「独立端口部署 404」拓扑问题).
// ===========================================
//
// ESM 路径规约 (项目硬纪律, 在本文件头部钉死, 不允许例外):
//   - 相对 import 路径相对**模块自身**的 URL (浏览器解析 <script type="module"> 即规则).
//   - views 一级目录: 相对 `./views/*.js` 或绝对 `/h3_gui/js/views/*.js`, 禁止深于两级.
//   - core/ 文件不反向 import views/components — core 是依赖底层, 不依赖上层.
//   - 不引入 npm 包 / 框架; 浏览器侧原生 fetch, Node 单测通过 globalThis.fetch 注入替身.
//
// 双接口并存 (语义不同不混用, 详情见 docs/迁移切换单-连接层.md):
//   1. fetchApi(path, opts) → Promise<Response>:
//      与 ComfyUI scripts/api.js 签名与返回语义**全兼容**, 内部只做 BASE 拼接与请求透传.
//      旧前端 58 处 fetchApi 调用点全部按 Response 语义用 .json() / .ok; 此出口不解析信封.
//   2. request(path, opts) → Promise<{ok, data, error}>:
//      双代信封归一 (新 {ok:false, error, detail?} / 旧裸 {error} / {cancelled, msg} / 200+error
//      / 500 纯文本 / 409 四 busy) → 统一 {ok, data, error:{code, msg, detail, httpStatus, busyKind?}, _phaseStructured?}.

// T4 改造③: BASE URL 单一配置点 (模块级, 全文件唯一读写口)
//   默认 = http://127.0.0.1:8190 (验证实例); 生产端口 = 8189 (严禁默认指生产).
//   S1-1 接 UI 时由启动层 toast 提示当前指向; 本任务不接 UI.
// 2026-09-27 走查修复②（老板 Ctrl+F5 后仍 CORS·Console 实锤打 8190）：
//   默认值不再写死 8190 直连——浏览器以 http(s) 打开（8940 反代/引擎挂载 = 同源形态）
//   默认同源相对请求（无 gui13.dev.base 键的用户此前恒跨域被 CORS 拦）；
//   file:// 直开与 Node 测试桩保持 8190 兜底（相对路径无意义）。显式 setBase 恒优先。
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件两处超时值均引表·不得就地内联。
import { TIMEOUTS } from "./timeouts.js";
import { t } from "./i18n.js";   // #92 B2：超时/离线白话入典 api.timeout/api.offline（运行期调用·非顶层）

let BASE_URL = (typeof location === "object" && location && /^https?:$/.test(location.protocol))
  ? ""
  : "http://127.0.0.1:8190";
export function setBase(url) { BASE_URL = url; }
export function getBase() { return BASE_URL; }

// 旧前端调用约定: fetchApi(path) 经常 path 已带 "/h3_batch" 前缀 — 识别后不重复拼接.
//   仅做前缀检测, 不参与实际 URL 拼接 (拼接走 BASE_URL).
// S1-1 T0: 已删除 LEGACY_PATH_PREFIX 常量与特判分支 — BASE_URL 是唯一请求源.

const FETCH_TIMEOUT_MS = TIMEOUTS.default;

// 批 17 T3: 请求超时阈值 (可测试覆写; resources.js _test_resetClipHealth 同款注入位).
let fetchTimeoutMs = FETCH_TIMEOUT_MS;
export function _test_setTimeoutMs(ms) { fetchTimeoutMs = ms; }
export function _test_resetTimeoutMs() { fetchTimeoutMs = FETCH_TIMEOUT_MS; }

// --- toast 桥注入点 (批 0 留空实现, 批 0.5 任务接上) ---
//   业务组件不直接调用 window.toast, 而是经此桥转发; 桥空 = no-op.
let toastBridge = null;
export function setToastBridge(fn) { toastBridge = fn; }

// ============ fetchApi 兼容出口 ============
// 严格保留 Response 语义 — 调用方可继续 .ok / .status / .json() / .text().
// 批 17 T3: 每请求独立 AbortController, 到期 (默认 30s) abort — 引擎挂起不再无限等待.
//   调用方自带 opts.signal 则链接 (外部取消仍生效); 现有调用点均未传 signal, 直接合入.
//   超时中止抛 name="TimeoutError" + code="timeout" 标记异常 (区别于外部取消 AbortError
//   与真网络错误 TypeError), 供 request catch 两态分类.
export async function fetchApi(path, opts = {}) {
  const init = { ...opts };
  // 地基批1档2 T2（账本 #45 GUI 侧）：opts.self —— 恒同源相对（不拼 BASE_URL）。
  //   伴生服务端点（/gui13-fs/*·devserver 挂在同源）必须走此档：BASE_URL 在 file:// 形态
  //   兜底 http://127.0.0.1:8190（探引擎端口·非伴生服务端口）会打错端口。
  //   默认档（不传 self）行为逐字不变——全仓 24+ 消费面零回归。
  const self = init.self === true;
  delete init.self;
  const url = self ? (typeof path === "string" ? path : String(path)) : joinBase(path);
  if (init.body && typeof init.body === "object" && !(init.body instanceof FormData)) {
    // 老代码大量传 plain object — 帮它 JSON.stringify + 头
    if (!init.headers) init.headers = {};
    if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  // 批22 B1: init.timeoutMs 单请求覆盖 (决策表 10①) — 缺省仍走全局 fetchTimeoutMs.
  const timeoutMs = (typeof init.timeoutMs === "number" && init.timeoutMs > 0) ? init.timeoutMs : fetchTimeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const externalSignal = init.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  init.signal = controller.signal;
  try {
    return await globalThis.fetch(url, init);
  } catch (e) {
    if (timedOut) {
      const te = new Error(t("api.timeout", { ms: timeoutMs }));   // #92 B2：zh 与原字面量逐字一致
      te.name = "TimeoutError";
      te.code = "timeout";
      throw te;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============ request 归一出口 ============
// 全部走 fetchApi (共享 BASE 拼接), 拿 Response 后做信封解析.
// 批 17 T3 timeout toast 去重: toast.js 无内置去重, 轮询 (串行 3s) 下引擎持续挂起会
//   每约 33s 弹一条; 10s 窗口压掉并发多请求同刻超时的爆发. 信封返回不受影响.
const TIMEOUT_TOAST_DEDUPE_MS = 10000;
let lastTimeoutToastAt = 0;

// ============ 统一离线提示（批 C #13：#13-6「要引擎操作」请求层单点接线）============
// 引擎不可达两形态：httpStatus=0 network_error（直连/file:// 形态·此前静默）与 502（同源部署经
// devserver _forward 失败·空体）。两形态 toast 统一为「引擎未连接」白话——信封原样不动，调用方
// 既有错误处理零变化。探测链（fetchEngineInfo → _noOfflineToast）不弹：boot 轮询/芯片探测失败是
// 离线常态态，由全局离线横幅表达，不逐拍刷 toast。10s 去重窗口同超时 toast（压并发爆发）。
let lastOfflineToastAt = 0;
function offlineToastMaybe() {
  if (!toastBridge) return;
  const now = Date.now();
  if (now - lastOfflineToastAt < TIMEOUT_TOAST_DEDUPE_MS) return;
  lastOfflineToastAt = now;
  // #92 B2：离线白话入典 api.offline（原顶层常量改请求期取词·zh 与原字面量逐字一致）
  toastBridge("engine_offline", t("api.offline"), null);
}
export function _test_resetOfflineToast() { lastOfflineToastAt = 0; }

export async function request(path, opts = {}) {
  const noOfflineToast = opts._noOfflineToast === true;
  if (noOfflineToast) { const o = { ...opts }; delete o._noOfflineToast; opts = o; }
  let resp;
  try {
    resp = await fetchApi(path, opts);
  } catch (netErr) {
    const isTimeout = !!(netErr && netErr.code === "timeout");
    const err = {
      code: isTimeout ? "timeout" : "network_error",
      msg: (netErr && netErr.message) ? netErr.message : String(netErr),
      detail: null,
      httpStatus: 0,
    };
    if (isTimeout && toastBridge) {
      const now = Date.now();
      if (now - lastTimeoutToastAt >= TIMEOUT_TOAST_DEDUPE_MS) {
        lastTimeoutToastAt = now;
        toastBridge(err.code, err.msg, err.detail);
      }
    } else if (!isTimeout && !noOfflineToast) {
      offlineToastMaybe();   // 批 C：network_error 不再静默（直连形态引擎不可达）
    }
    return { ok: false, data: null, error: err };
  }
  const normalized = await normalizeHttpResponse(resp);
  // 成功态也附带结构化 phase (status 端点)
  if (normalized.ok && normalized.data && typeof normalized.data === "object"
      && "phase" in normalized.data) {
    normalized.data._phaseStructured = parsePhase(normalized.data);
  }
  // 错误态喂 toast 桥 (仅触发一次)。批 C：502 = devserver 转发链关（引擎不可达）→ 统一离线文案；
  //   探测链（_noOfflineToast）遇 502 完全静默（离线常态由横幅表达·不逐拍刷 toast）。
  if (!normalized.ok) {
    if (toastBridge) {
      if (normalized.error.httpStatus === 502) {
        if (!noOfflineToast) offlineToastMaybe();
      } else {
        toastBridge(normalized.error.code, normalized.error.msg, normalized.error.detail);
      }
    }
  }
  return normalized;
}

// ============ normalizeHttpResponse (拆 raw Response → envelope) ============
async function normalizeHttpResponse(resp) {
  const status = resp.status;
  const ct = resp.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  if (isJson) {
    let body;
    try { body = await resp.json(); }
    catch { body = null; }
    return normalizeEnvelope({ status, json: body });
  }
  // 纯文本 / 其它
  const text = await resp.text();
  return normalizeEnvelope({ status, text });
}

// ============ normalizeEnvelope (纯函数: {status, json|text} → envelope) ============
//   双代信封归一核心.
export function normalizeEnvelope({ status, json, text }) {
  // ---- 500 纯文本例外 (generate_csv ShotError 未捕获) ----
  // B6-T2: 500 + JSON 新信封 (llm_call_failed / llm_context_overflow 等 #50 引擎 500) 放行到下方
  //   新信封解析 — 旧 500 兜底只服务纯文本/非信封体; 否则 #50 的 500 被压成 http_500, detail 丢失.
  //   仅限 500: 其余 5xx (如 503 engine_init) 维持原 http_5xx 兜底 (T1 既有口径).
  if (status >= 500 && !(status === 500 && json && typeof json === "object" && json.ok === false && json.error != null)) {
    return {
      ok: false,
      data: null,
      error: {
        code: status === 500 ? "http_500" : `http_${status}`,
        msg: text != null ? String(text).trim() : `HTTP ${status}`,
        detail: null,
        httpStatus: status,
      },
    };
  }

  // ---- T4 改造②: 403 引擎同源校验拒绝专属分支 ----
  //   引擎 403 = CORS/Origin header 校验失败 (CORS preflight 或 Origin 头不匹配),
  //   是配置/部署问题, 不是请求数据问题 — 必须透传, 不与通用 ≥400 兜底混.
  //   信封给 detail.origin_check=true 标记, 供 UI 区分渲染 (S1-1 toast 拒因提示).
  //   排在所有 JSON 形态分支前: 不论新信封 {ok:false,error} / 旧裸 {error} / 纯文本, 统一出 http_403 信封.
  if (status === 403) {
    let msg403 = "";
    if (json && typeof json === "object") {
      // 优先取 json.error (新信封 + 旧裸都覆盖), 再回退 json.msg (旧信封 ok:false + cancelled)
      if (json.error != null) msg403 = String(json.error);
      else if (json.msg != null) msg403 = String(json.msg);
    }
    if (!msg403 && text != null) msg403 = String(text).trim();
    if (!msg403) msg403 = "HTTP 403 (origin check failed)";
    return {
      ok: false,
      data: null,
      error: {
        code: "http_403",
        msg: msg403,
        detail: { origin_check: true },
        httpStatus: 403,
      },
    };
  }

  // ---- 旧 cancel 端点: {cancelled: bool, msg: str} ----
  if (json && typeof json === "object"
      && "cancelled" in json && "msg" in json
      && typeof json.cancelled === "boolean") {
    return { ok: true, data: { cancelled: json.cancelled, msg: json.msg }, error: null };
  }

  // ---- 旧信封: {ok: false, msg: str} (无 error 字段) — 审片门三端点使用 ----
  //   与新信封同 ok=false 但不带 error 字段, 仅 msg — 视为 unknown code + msg 透传.
  //   必须排在 {ok:false, error} 之前 (该分支用 json.error; 此分支用 json.msg, 互不重叠).
  if (json && typeof json === "object" && json.ok === false
      && typeof json.msg === "string" && json.error == null) {
    return {
      ok: false,
      data: null,
      error: {
        code: "unknown",
        msg: json.msg,
        detail: json.detail != null ? json.detail : null,
        httpStatus: status,
        busyKind: null,
      },
    };
  }

  // ---- 新信封: {ok: false, error, detail?} 或 {ok: true, ...} ----
  if (json && typeof json === "object" && json.ok === false) {
    const errStr = String(json.error || "unknown");
    // S2-3 T2: 半角 ":" 未命中时回退尝试全角 "：" (U+FF1A) — 审片门 409 状态文案用全角冒号分隔 code/msg.
    //   半角既有行为 (B7 四 busy 等) 一个字节都不变 — colonIdx>0 命中即直接走原分支.
    let colonIdx = errStr.indexOf(":");
    if (colonIdx <= 0) {
      const fullIdx = errStr.indexOf("：");
      if (fullIdx > 0) colonIdx = fullIdx;
    }
    let code = colonIdx > 0 ? errStr.slice(0, colonIdx).trim() : errStr;
    let msg = colonIdx > 0 ? errStr.slice(colonIdx + 1).trim() : "";
    const busyKind = classifyBusy(errStr);
    return {
      ok: false,
      data: null,
      error: {
        code,
        msg,
        detail: json.detail != null ? json.detail : null,
        httpStatus: status,
        busyKind, // 409 四 busy 时 = "active"|"finalizing"|"concat"|"postfx"; 其它 = null
        // #40 T2 · B1：引擎把结构化错误放**顶层** execution_error（四键 dict）——
        //   归一层此前只保 code/msg/detail/httpStatus/busyKind·顶层键被丢 → GUI 拿不到详情层。
        //   原样带出（不裁字段）；缺省 null（busy 四族豁免不带键 → 不挂详情入口）。
        executionError: (json.execution_error && typeof json.execution_error === "object")
          ? json.execution_error : null,
      },
    };
  }
  if (json && typeof json === "object" && json.ok === true) {
    return { ok: true, data: json, error: null };
  }

  // ---- 200 + error 字段 (旧端点: status 读取失败 / assets 损坏) ----
  if (status >= 200 && status < 300 && json && typeof json === "object" && json.error) {
    const errStr = String(json.error);
    const colonIdx = errStr.indexOf(":");
    let code = colonIdx > 0 ? errStr.slice(0, colonIdx).trim() : "soft_error";
    let msg = colonIdx > 0 ? errStr.slice(colonIdx + 1).trim() : errStr;
    const data = { ...json };
    delete data.error;
    return {
      ok: false,
      data,
      error: { code, msg, detail: null, httpStatus: status },
    };
  }

  // ---- 旧裸 {error} (无 ok 字段) ----
  if (json && typeof json === "object" && json.error && typeof json.error === "string") {
    return {
      ok: false,
      data: null,
      error: {
        code: "unknown",
        msg: json.error,
        detail: null,
        httpStatus: status,
      },
    };
  }

  // ---- 其它 4xx (空 body / 非预期格式) ----
  if (status >= 400) {
    return {
      ok: false,
      data: null,
      error: {
        code: `http_${status}`,
        msg: text != null ? String(text).trim() : `HTTP ${status}`,
        detail: null,
        httpStatus: status,
      },
    };
  }

  // ---- 成功 (旧端点无 ok 字段, 例如模板列表/资源扫描) ----
  return { ok: true, data: json, error: null };
}

// ============ parsePhase: status payload → 结构化 phase ============
//   空 = idle; 六态映射如测试断言 B6.
const PHASE_MAP = {
  "跑批中": "running",
  "拼接中": "concat",
  "归档中": "archive",
  "清点中": "inventory",
  "收尾中": "finalizing",
};
export function parsePhase(payload) {
  if (!payload || typeof payload !== "object") return "idle";
  const ph = payload.phase;
  if (typeof ph !== "string" || ph === "") return "idle";
  return PHASE_MAP[ph] || "idle";
}

// ============ classifyBusy: 409 四 busy 前缀识别 (T4 改造①) ============
//   原三态 (active/finalizing/concat) 保留; 新增 postfx_busy → "postfx"
//   (后期处理阶段: 转码/抽帧等, M1 口径).
export function classifyBusy(errStr) {
  if (typeof errStr !== "string") return null;
  if (errStr.startsWith("active_busy")) return "active";
  if (errStr.startsWith("finalizing_busy")) return "finalizing";
  if (errStr.startsWith("concat_busy")) return "concat";
  if (errStr.startsWith("postfx_busy")) return "postfx";
  return null;
}

// ============ joinBase: BASE 拼接 (T4 改造③ 改用 BASE_URL 配置) ============
//   BASE_URL 是唯一请求源; 旧式传参 "/h3_batch/xxx" 会被拼成 BASE_URL+/h3_batch/xxx = 引擎真实端点.
//   挂载形态 (BASE_URL 配空串) 退化为相对路径, 同样正确.
//   分支:
//     1) 已带 BASE_URL 前缀 — 原样返回 (新前端约定; 防重复拼接)
//     2) 绝对路径 — 拼 BASE_URL
//     3) 相对路径 — 拼 BASE_URL + /
function joinBase(path) {
  if (typeof path !== "string") path = String(path);
  if (path.startsWith(`${BASE_URL}/`) || path === BASE_URL) return path;
  if (path.startsWith("/")) return `${BASE_URL}${path}`;
  return `${BASE_URL}/${path}`;
}

// ============ fetchEngineInfo (S2-3 T6 · 1.15 增量接口位) ============
//   GET /system_stats (ComfyUI 原生端点, 无 /h3_batch 前缀) → 归一返回
//   {ok:true, version, vramTotalMb?, raw?} (失败 {ok:false, error, ...} 同 request 形态).
//   version = system.comfyui_version (真机 0.35.0).
//   vramTotalMb = Σ devices[].vram_total / 1048576 (字节→MB 取整) — 多 GPU 时取总和.
//   真机实测 (2026-09-25): devices[0].vram_total=12820480000 ≈ 12228 MB (RTX 5070).
export async function fetchEngineInfo() {
  const r = await request("/system_stats", { _noOfflineToast: true });   // 探测链：失败=离线常态·不弹离线 toast（横幅表达）
  if (!r.ok) {
    return { ok: false, error: r.error, version: undefined, vramTotalMb: undefined };
  }
  const data = r.data && typeof r.data === "object" ? r.data : null;
  const sys = data && data.system && typeof data.system === "object" ? data.system : null;
  const version = sys && typeof sys.comfyui_version === "string" ? sys.comfyui_version : null;
  // VRAM 汇总: 多 GPU 视作总显存; devices 缺/非数组 → vramTotalMb 留空 (供 UI 隐藏 VRAM 段)
  let vramTotalMb;
  if (data && Array.isArray(data.devices) && data.devices.length > 0) {
    let bytes = 0;
    let anyValid = false;
    for (const d of data.devices) {
      if (d && typeof d.vram_total === "number" && d.vram_total > 0) {
        bytes += d.vram_total;
        anyValid = true;
      }
    }
    vramTotalMb = anyValid ? Math.round(bytes / (1024 * 1024)) : undefined;
  }
  return {
    ok: true,
    version,
    vramTotalMb,
    raw: data,
  };
}

// ============ fetchH3Version (#47 档2 GUI 侧 · 引擎版本握手闸取数出口) ============
//   GET /h3_batch/version (零参; 引擎 FWD 前缀族同 /system_stats —— 不带 self)
//     → 成功归一 {engineVersion, minGuiVersion} (缺键 = null)
//     → 请求失败/非 200 → null (探活失败语义: 不抛, 闸不误触)
//   engine_version 引擎真机形态 = "V1.14" (带 V 前缀; 引擎仓常量 ENGINE_VERSION 同源).
//   min_gui_version = 引擎侧要求的 GUI 最低版本 —— **本版 GUI 不消费** (档3 联动另议),
//     此处仅透传备查, 不参与任何判定.
//   _noOfflineToast: 探测链语义 (循 fetchEngineInfo 先例) —— 探活失败是离线常态,
//     由全局离线横幅表达, 不逐拍刷 toast.
export async function fetchH3Version() {
  let r;
  try {
    r = await request("/h3_batch/version", { _noOfflineToast: true });
  } catch (_e) {
    return null;   // 探活失败语义: 任何异常都归 null (不抛)
  }
  if (!r || !r.ok) return null;
  const data = r.data && typeof r.data === "object" ? r.data : null;
  return {
    engineVersion: data && typeof data.engine_version === "string" ? data.engine_version : null,
    minGuiVersion: data && typeof data.min_gui_version === "string" ? data.min_gui_version : null,
  };
}

// ============ mediaUrl 双通道家族（批 B #13·方案-#13解耦B档-2026-10-16 §四.批B T3）============
// 通道模型：引擎口优先（joinBase 基址·同源部署退裸相对——与既有各消费点输出逐字节一致）+
// onerror 回落本地 /gui13-fs/*（devserver 本地文件流·引擎停机兜底）。**冷启动不按芯片态预切**
// （探测完成前恒"未连接"窗口期）——切换只由"引擎口实际失败"或"确定离线预切"（2026-10-17 真机
// 盲区修复③·见下方 setChipOfflineProbe 注入点）触发。
// src 双风格归一：产物路径（构造端点）或已构造引擎 URL（裸相对 /h3_batch|/view·绝对引擎地址）均可入。

// 引擎口 URL。kind: "video"|"thumb" 按路径构造（thumb 带_opts.maxSize 缺省 512）；其余值（"audio" 等）
// 将 src 视为已构造引擎路径直通归一。已构造输入（引擎已知前缀裸相对 / 绝对地址）无视 kind 一律归一。
// 注意直通仅认引擎已知前缀（批 C #13 起 = devserver FWD_PREFIXES 收窄后同族：/h3_batch /view
// /upload /system_stats——/queue /prompt /object_info /api 已自两侧移除，两处收扩须同步·C13 锁钉）；
// 资产 media 存在 "/m/a.png" POSIX 形态，泛 "/ 开头=已构造" 启发式会把它误判成引擎 URL 丢掉
// 端点与 max_size（canvas L2 夹具实探·2026-10-16）。
const ENGINE_PATH_RE = /^\/(h3_batch|view|upload|system_stats)([/?]|$)/;

// ============ 确定离线预切注入点（2026-10-17 真机盲区修复③）============
// core 不反查 views（本文件头 ESM 纪律）——settings.js 把「芯片探测完成且=idle」判定经此注入
// （对齐 setToastBridge 桥先例）；桥空=未接线（冷启动/单测）恒不预切。批 B 既有裁决保持：**探测
// 完成前（冷启动窗口）不预切**，切换只由引擎口实际失败触发；两态分明=探测中（false）/确定离线（true）。
// 预切只作用于**产物路径构造分支**（mediaUrl 内 ENGINE_PATH_RE 之后）；已构造引擎 URL（/view
// /h3_batch/绝对）不预切——回落链（onerror/探活）兜底，批 B 双风格归一语义零变化。
let chipOfflineProbe = null;
export function setChipOfflineProbe(fn) { chipOfflineProbe = typeof fn === "function" ? fn : null; }
function _chipOfflineConfirmed() {
  if (!chipOfflineProbe) return false;
  try { return chipOfflineProbe() === true; } catch (_e) { return false; }
}

export function mediaUrl(kind, src, _opts = {}) {
  const p = typeof src === "string" ? src.trim() : "";
  if (!p) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {               // 绝对引擎 URL → 剥基址取路径再归一
    try { const u = new URL(p); return joinBase(u.pathname + u.search); }
    catch (_e) { return p; }
  }
  if (ENGINE_PATH_RE.test(p)) return joinBase(p);         // 已构造引擎路径（裸相对·含 /view 音频）
  if (_chipOfflineConfirmed()) return localMediaUrl(kind, p, _opts);   // 确定离线预切：产物路径直出本地
  if (kind === "video") return joinBase("/h3_batch/video?path=" + encodeURIComponent(p));
  if (kind === "thumb") {
    return joinBase("/h3_batch/thumb?path=" + encodeURIComponent(p)
      + "&max_size=" + ((_opts && _opts.maxSize) || 512));
  }
  return joinBase(p);
}

// 本地口 URL（/gui13-fs/media 文件流 | /gui13-fs/thumb 本地缩略）。绝对路径直入（服务端白名单四重闸兜底）。
export function localMediaUrl(kind, src, _opts = {}) {
  const p = typeof src === "string" ? src.trim() : "";
  if (!p) return "";
  if (kind === "thumb") {
    return "/gui13-fs/thumb?path=" + encodeURIComponent(p)
      + "&max_size=" + ((_opts && _opts.maxSize) || 512);
  }
  return "/gui13-fs/media?path=" + encodeURIComponent(p);
}

// 元素级回落接线：引擎口 onerror 一次性换本地（dataset 守卫防本地口再失败死循环）。
// 仅挂监听不动现值——冷启动/在线期零行为变化（验收：在线不走本地口除非引擎口失败）。
export function wireLocalFallback(el, kind, src, opts = {}) {
  if (!el || typeof el.addEventListener !== "function") return el;
  const local = localMediaUrl(kind, src, opts);
  if (!local) return el;
  el.addEventListener("error", () => {
    if (el.dataset.localFb === "1") return;
    el.dataset.localFb = "1";
    try { el.src = local; } catch (_e) { /* 测试桩元素无 src 语义时忽略 */ }
  }, { once: true });
  return el;
}

// 动态换源元素的引擎口赋值+回落接线（src 会变的共享元素：播放器双缓冲/离屏采样/预听 audio）。
// 与 wireLocalFallback 差别：回落目标随每次赋值刷新（dataset.fbPath），监听元素生命周期内只挂
// 一次（dataset.fbWired），**换源重置回落态**（批 C #13·批 B 风险 1 改进：删 localFb——离线长会话
// 连续切换产物逐次回落，批 B「整体回落一次性」语义升级）；同一源内二次 error 仍由 localFb 守卫
// 防循环。无 dataset 的测试桩只赋值不接线。
export function setMediaSrc(el, kind, file, opts = {}) {
  if (!el) return el;
  if (el.dataset) {
    el.dataset.fbPath = typeof file === "string" ? file : "";
    delete el.dataset.localFb;
    if (el.dataset.fbWired !== "1" && typeof el.addEventListener === "function") {
      el.dataset.fbWired = "1";
      el.addEventListener("error", () => {   // 常驻监听（无 once）——回落态随换源重置，守卫防循环
        if (el.dataset.localFb === "1" || !el.dataset.fbPath) return;
        el.dataset.localFb = "1";
        try { el.src = localMediaUrl(kind, el.dataset.fbPath, opts); } catch (_e) { /* 桩无 src 语义忽略 */ }
      });
    }
  }
  try { el.src = mediaUrl(kind, file, opts); } catch (_e) { /* 桩元素只存不校验 */ }
  return el;
}

// 底图（background-image）回落接线：CSS 背景无 error 事件——消费点**同步设引擎口**（现状渲染时机
// 不变）后经此函数异步探活，不可达才把底图换本地（成功路径零变化）。
// 2026-10-17 真机盲区修复②：探活判定改 **fetch + isEngineUnreachable 同判定**（原 Image.onerror
// 独立判定不认 502——FWD 转发停引擎返 502 被当可达 → bg 停在引擎口 URL 不回落）。resp 非 ok 按
// http_${status} 归形喂谓词（502→切本地；其余 4xx/5xx=引擎可达真报错不切）；fetch 拒绝=网络错/
// 超时（httpStatus=0 同族）→ 切本地。确定离线预切已生效时 engine===local → 直返（bg 本就本地，
// 不发探活请求）。探活闸沿用 typeof Image（Node 单测无 Image → no-op·环境语义与批 B 一致）。
export function wireBgMediaFallback(el, kind, src, opts = {}) {
  if (!el || !el.style) return el;
  const engine = mediaUrl(kind, src, opts);
  const local = localMediaUrl(kind, src, opts);
  if (!engine || !local || engine === local) return el;
  if (typeof Image !== "function" || typeof globalThis.fetch !== "function") return el;
  globalThis.fetch(engine).then((resp) => {
    if (resp.ok) return;
    if (isEngineUnreachable({ code: "http_" + resp.status, msg: "", detail: null, httpStatus: resp.status })) {
      el.style.backgroundImage = `url("${local}")`;
    }
  }).catch(() => {
    el.style.backgroundImage = `url("${local}")`;
  });
  return el;
}

// ============ 不可达谓词单源（批 B #13·批 A 复核遗留收敛）============
// 批 A 曾在 assets_api/resources/templates 各自实现同一判定：仅 httpStatus=0（网络错/超时·引擎
// 不可达）才允许回落读穿缓存；引擎可达但报错不拿陈旧快照冒充。本函数为唯一判定源。
// 2026-10-17 真机盲区修复①：引擎停机+8940 同源形态下 FWD 转发返回 **502**（约 2s·非网络错）——
// 此前不认 502，listAssets 读穿族把它误判「200+error 族以外的真损坏」→ 恢复态不读缓存（真机实拍
// 资产页全空+恢复横幅）。502=转发链关（引擎不可达）并入不可达；其余 5xx 维持「引擎可达真报错」。
export function isEngineUnreachable(err) {
  if (!err) return false;
  if (err.httpStatus === 502) return true;   // 同源部署停引擎：devserver FWD 转发失败返 502（约 2s·非网络错）
  return err.httpStatus === 0 && (err.code === "network_error" || err.code === "timeout");
}

// ============ uploadImage (S3-1 T2 · 概念环落库通道 · ComfyUI 原生 /upload/image) ============
//   端点契约（详案 §0.3 真机探针实测 2026-09-25）：
//     - POST /upload/image （无 /h3_batch 前缀 — ComfyUI 原生端点）
//     - multipart/form-data: image + subfolder + type=input + overwrite=true
//     - 落盘 input/<subfolder>/<image.name>
//     - 成功响应: {name, subfolder, type} —— **非信封**（无 ok 字段，与本仓其它端点不同）
//     - 错误响应: {ok:false, error:'<code>:<msg>'} (envelope) 或 4xx/5xx 纯文本
//   本封装：走 request(Base+timeout)，成功路径按端点实际形态透传（非信封·调用方拿 r.name/subfolder/type），
//           失败路径沿用 request 信封 {ok:false, error}，与项目其它调用点同款（不双重语义）。
export async function uploadImage(formData) {
  if (!formData || typeof formData.append !== "function") {
    return { ok: false, error: { code: "validation", msg: "uploadImage 入参必须为 FormData", detail: null, httpStatus: 0 } };
  }
  // #57 档2 T1：显式 90s 超时——本封装承载 multipart 文件体传输（图片/音频·时长随体量伸缩），
  //   30s 默认可触顶误杀（llm_chat 90s 先例）。集中超时表 TIMEOUTS.uploadTransfer（批2 T2 收编）。
  const r = await fetchApi("/upload/image", { method: "POST", body: formData, timeoutMs: TIMEOUTS.uploadTransfer });
  // 端点真机实测: 5xx 纯文本 / 4xx 纯文本 / {ok:false,error} envelope —— 都走 request 归一
  const normalized = await normalizeHttpResponse(r);
  if (!normalized.ok) return { ok: false, error: normalized.error, raw: normalized.data };
  // 成功路径：透传 {name, subfolder, type} 三件（端点真机形态）
  const data = (normalized.data && typeof normalized.data === "object") ? normalized.data : {};
  return {
    name: typeof data.name === "string" ? data.name : "",
    subfolder: typeof data.subfolder === "string" ? data.subfolder : "",
    type: typeof data.type === "string" ? data.type : "input",
    raw: data,
  };
}