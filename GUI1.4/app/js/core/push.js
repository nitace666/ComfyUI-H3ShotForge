// core/push.js — ComfyUI 原生 /ws 实时推流客户端（B7-T1 · C1）
//
// === 出处注记 ===
// 迁移自 legacy/app/js/core/push.js（F-LIVE 5.5·逐字节拷贝仓）；
// 改造点 = URL 构造规则表（legacy 单一硬编码 ws://127.0.0.1:${port}；B7-T1b 修订②③合并）：
//   ① getBase()（core/api.js BASE_URL 单一配置点）非空 → http(s)://H:P 换 ws(s)://H:P + /ws?clientId=
//   ② BASE=""（同源）→ ws(s)://location.host/ws——8940 devserver 由 /ws 代理转引擎（剥 Origin·
//     引擎 origin_only 即过），引擎挂载同源形态直达（https 页面不降级明文 ws）
// 其余逻辑原样保留：feature_flags 首帧握手 / 二进制 typeNum 1/2/4 帧解析 /
//   重连退避 ≤5（1s→2s→4s→8s 封顶）+ 耗尽追加第五态 exhausted（批2 T4·账本 #58）/
//   sessionStorage cid 键名沿用（h3_gui_ws_cid）。
//
// === 消费方 ===
//   - core/submit.js runOnly: submitBody.live_client_id = getClientId()（api.md #9 契约键·
//     引擎 extra_data 逐提交开 preview_method="auto" → 帧按本 clientId 路由回本客户端）
//   - views/submit-bar.js: 提交成功且 stem 非空时 connectLive（onFrame/onEvent/onStatus 分发）
//
// ESM 规约（同 core/api.js 头部纪律）：core 不反向 import views/components；无 npm 依赖。

import { getBase } from "./api.js";

const CID_KEY = "h3_gui_ws_cid";

export function getClientId() {
  const storage = globalThis.sessionStorage;
  let id = storage?.getItem(CID_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storage?.setItem(CID_KEY, id);
  }
  return id;
}

// ---- URL 规则表（B7-T1b 修订：②③合并同源）----
function buildWsUrl() {
  const cid = encodeURIComponent(getClientId());
  const base = getBase();
  if (base) {
    // ① 显式 BASE（gui13.dev.base / Node 桩）：同源协议换 ws(s)·同主机端口
    return base.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/ws?clientId=" + cid;
  }
  // ② 同源（8940 devserver /ws 代理 或 引擎挂载）：同 host 挂 /ws；https 页面用 wss（不降级明文）
  const loc = (typeof globalThis.location === "object" && globalThis.location) ? globalThis.location : null;
  const proto = loc && loc.protocol === "https:" ? "wss:" : "ws:";
  const host = (loc && loc.host) || "127.0.0.1:8190";
  return `${proto}//${host}/ws?clientId=${cid}`;
}

function notify(fn, ...args) { if (typeof fn === "function") fn(...args); }

function parseBinary(data, onFrame) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
  if (!bytes || bytes.byteLength < 4) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeNum = view.getUint32(0);
  let imageStart = 4;
  let meta = { typeNum };
  if (typeNum === 4) {
    if (bytes.byteLength < 8) return;
    const length = view.getUint32(4);
    if (bytes.byteLength < 8 + length) return;
    try { meta = { ...JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))), typeNum }; } catch { return; }
    imageStart = 8 + length;
  } else if (typeNum !== 1 && typeNum !== 2) return;
  if (imageStart >= bytes.byteLength) return;
  const blob = new Blob([bytes.subarray(imageStart)], { type: "image/jpeg" });
  const blobUrl = URL.createObjectURL(blob);
  notify(onFrame, blobUrl, meta);
}

const eventMap = { executing: "executing", progress_state: "progress", progress: "progress", executed: "executed", execution_error: "error", execution_interrupted: "interrupted" };

// 在册 live 实例（引擎地址变更 → 统一重建；close 注销）
//   地基批1档2 T3（账本 #45 状态面）：connectLive 每建一连登记句柄，close 时注销。
const liveInstances = new Set();

export function connectLive(opts = {}, wsFactory = globalThis.WebSocket) {
  const { onFrame, onEvent, onStatus } = opts;
  let ws;
  let closed = false;
  let retries = 0;
  let timer;
  let gen = 0;   // 连接世代号：重建后旧 socket 的回调作废（不报 closed·不排重连）
  const open = () => {
    if (closed) return;
    const myGen = ++gen;
    const url = buildWsUrl();   // 每连现算（引擎地址变更后重连走新址·不再顶部一次性捕获）
    const sock = new wsFactory(url);
    ws = sock;
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      if (myGen !== gen) return;
      retries = 0; notify(onStatus, "open");
      sock.send(JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }));
    };
    sock.onmessage = ({ data }) => {
      if (myGen !== gen) return;
      if (typeof data === "string") {
        try { const message = JSON.parse(data); const mapped = eventMap[message.type]; if (mapped) notify(onEvent, mapped, message.data); } catch { /* malformed event */ }
      } else parseBinary(data, onFrame);
    };
    sock.onerror = detail => { if (myGen !== gen) return; notify(onStatus, "error", detail); };
    sock.onclose = detail => {
      if (myGen !== gen) return;   // 已被重建取代 → 静默（不误报断开·不排重连）
      notify(onStatus, "closed", detail);
      // 批2 T4（账本 #58 状态面）：退避耗尽显式化——closed 位先判（正常收尾照旧·非耗尽），
      // 再判 retries>=5 → 在既有通知流之后**追加**第五态 exhausted（不替代任何既有通知）；
      // 不置 closed 位 → handle.rebuild() 兼容（重连后再耗尽可再次 exhausted）。
      if (closed) return;
      if (retries >= 5) { notify(onStatus, "exhausted"); return; }
      const delay = Math.min(1000 * 2 ** retries, 8000); retries++;
      notify(onStatus, "retrying", { attempt: retries, delay });
      timer = setTimeout(open, delay);
    };
  };
  // 退避定时器清理（重建/关闭共用）
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  open();
  const handle = {
    close() {
      closed = true;
      stopTimer();
      try { ws?.close(); } catch (_e) { /* 已断忽略 */ }
      liveInstances.delete(handle);
    },
    // 主动重建：关当前 ws（**不清 closed 态**·teardown 后仍可继续连）→ retries 归零 → 立即 open（新 URL 现算）
    rebuild() {
      if (closed) return false;     // 已关闭 → 不复活
      gen++;                        // 旧 socket 事件作废（其 close 不报 disconnected·不排重连）
      stopTimer();
      try { ws?.close(); } catch (_e) { /* 已断忽略 */ }
      retries = 0;
      open();
      return true;
    },
  };
  liveInstances.add(handle);
  return handle;
}

// 全部在册实例各重建一次（引擎地址保存/清除后调用·无实例 = no-op）
export function rebuildAllLive() {
  let n = 0;
  for (const h of Array.from(liveInstances)) {
    if (h && typeof h.rebuild === "function" && h.rebuild()) n++;
  }
  return n;
}

// 测试钩子：清在册实例（单测隔离用·产线不调）
export function _test_clearLive() {
  const n = liveInstances.size;
  liveInstances.clear();
  return n;
}
