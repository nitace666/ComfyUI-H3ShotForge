// core/sync_bus.js — 跨页失效广播（地基批1 档2 T5 · 账本 #59-①②件）
//
// === 定位 ===
//   多开页面各持全量内存镜像 + 无失效通知 → 另一活页面周期写回旧态（T9 族根）。
//   本模块 = 同源页面间的失效通知通道：某页改了实体键 → 广播 → 别页丢镜像重取。
//   只管「通知」，不管「对账」——写前对账与重连全量刷新是 T6 的活（账本 #59-③件）。
//
// === 同源约束（BroadcastChannel 标准行为）===
//   通道只在**同一 origin**（同协议 + 同 host + 同端口）内互通：
//   127.0.0.1:8940 与 localhost:8940 是两个 origin → 本机双开须同 host 字面。
//   跨机多客户端不覆盖（本机双开为主·够用）。
//
// === 降级 ===
//   无 BroadcastChannel 环境（老浏览器 / Node 无全局）或构造失败 → 模块级 no-op：
//   广播不抛、注册不抛——功能退化但不炸页面。

const CHANNEL_NAME = "gui13.sync";
const _listeners = new Set();
// #44 后半（B3）：index-changed 订阅者（总表行写入的跨窗口通知·与 invalidate 消息族同通道不同型）
const _indexListeners = new Set();

// 失效种类：purge=实体真删（服务端已无此实体）· soft=软删（实体仍在）· restore=恢复（实体已活）
//   缺省/未知值一律归一为 soft —— 安全侧：soft 不入墓碑（不误封他页合法写）
const KINDS = new Set(["purge", "soft", "restore"]);
function _normKind(kind) {
  return (typeof kind === "string" && KINDS.has(kind)) ? kind : "soft";
}

let _channel = null;
try {
  if (typeof BroadcastChannel === "function") {
    _channel = new BroadcastChannel(CHANNEL_NAME);
    // Node（测试）没有浏览器页面事件循环兜底：unref 让通道不吊住进程（浏览器无此方法·跳过）
    if (typeof _channel.unref === "function") _channel.unref();
    _channel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "invalidate") {
        const keys = Array.isArray(msg.keys) ? msg.keys : [];
        const kind = _normKind(msg.kind);
        for (const cb of [..._listeners]) {
          try { cb(keys, kind); } catch (_e) { /* 单个订阅者抛错不污染其他订阅者 */ }
        }
        return;
      }
      if (msg.type === "index-changed") {
        const id = String(msg.id || "");
        const action = String(msg.action || "");
        for (const cb of [..._indexListeners]) {
          try { cb(id, action); } catch (_e) { /* 单个订阅者抛错不污染其他订阅者 */ }
        }
      }
    };
  }
} catch (_e) {
  _channel = null;   // 构造失败 → 降级 no-op
}

// 广播实体键失效（keys = 实体键数组·如 data/projects/<id>.json；kind = purge|soft|restore）
export function broadcastInvalidate(keys, kind) {
  if (!_channel) return;
  try {
    _channel.postMessage({ type: "invalidate", keys: Array.isArray(keys) ? keys.slice() : [], kind: _normKind(kind) });
  } catch (_e) {
    // 通道已关 / 不可用 → 静默降级（不炸页面·不静默丢数据·服务端仍是事实源）
  }
}

// 注册失效回调（收到 invalidate → cb(keys, kind)·可多注册）
export function onInvalidate(cb) {
  if (typeof cb !== "function") return;
  _listeners.add(cb);
}

// ============================================================================
// #44 后半（B3·方案 v5 §四）：index-changed——总表行写入（新建/保存/删除项目）后的跨窗口通知
//   发送端 = server_storage 总表写成功（按「服务端写前快照 ↔ 写入新表」diff 出变更行）；
//   接收端 = views/ai-archive.js：reloadServerIndex()（拉服务端覆盖缓存·只读）→ 重渲项目面板
//   ——只读不写不重播防回环（接收处理不发广播不写服务端；本页自己写不回声到自己）。
//   载荷 = {type:"index-changed", id:项目id, action:create|save|remove}
// ============================================================================

// 广播总表行变更（id=项目 id·action=create|save|remove）
export function broadcastIndexChanged(id, action) {
  if (!_channel) return;
  try {
    _channel.postMessage({ type: "index-changed", id: String(id || ""), action: String(action || "") });
  } catch (_e) {
    // 通道已关 / 不可用 → 静默降级（同 broadcastInvalidate 口径）
  }
}

// 注册 index-changed 回调（收到 → cb(id, action)·可多注册）
export function onIndexChanged(cb) {
  if (typeof cb !== "function") return;
  _indexListeners.add(cb);
}
