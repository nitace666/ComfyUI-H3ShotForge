// GUI 1.3 项目数据模型 v1 — store (S1-0 任务 T5 + S1-2 T1 数据层扩展).
//
// === 三视图同源铁律 ===
// store 是唯一数据源. views/ui 只能通过 export API 操作数据, 不允许旁路改 store 内对象.
// 本批仅以注释约定: 导出的项目对象视为不可变; 冻结/代理封装在后续批需要时再加.
//
// === 出处注记 (S1-0 任务 T5 + S1-2 T1 纪律) ===
// 纯新增, 不改 legacy. schema 形态源自本批详案 S1-0 §3 "项目数据模型 v1" + S1-2 T1 扩展.
//
// S1-0 节点门修正（双审裁决）：摘除 loadSampleAssets 与 node: 依赖（浏览器 ESM 兼容+超前代码），样例资产接线归 S1-2.
// S1-2 T1 数据层扩展（14 键 + 段卡字段 + 项目顶层三字段 + 旧数据兼容）：schemaVersion 保持 1；新字段全可选语义，旧项目 load 后 undefined 由视图层按默认渲染，不写迁移.

// ===== 存储适配 (可注入, 默认 globalThis.localStorage) =====
let storage = globalThis.localStorage;
export function setStorage(s) {
  storage = s;
  // 批 10-M M-T3：注入新存储 = 换了一个数据世界——连带重置 server 侧内存缓存
  //   （模块级单例；不重置会让上一轮用例的项目泄进下一轮）。生产无 setStorage 调用方。
  serverCacheReset();
}

// ---------------------------------------------------------------------------
// 批 10-M M-T2：读收敛（双源过渡）→ M-T7 收口：纯 server 读
//   M-T2~T6 过渡期为「server 优先 → localStorage 回退」（保老板主环境项目不消失）；
//   M-T6 迁移已在 boot 把存量上载 data/，M-T7 起读侧只认 server_storage 内存缓存——
//   server 无 = 无数据（方案 §三.2「M-T6 收口后改纯 server」）。
// ---------------------------------------------------------------------------
import {
  cached as serverCached, projectKey as serverProjectKey, INDEX_KEY as SERVER_INDEX_KEY,
  isReady as serverIsReady, cachePut as serverCachePut, putKey as serverPutKey,
  resetServerCache as serverCacheReset,
} from "../core/server_storage.js";
// 地基批1 T5（账本 #59-①②件）：跨页失效广播——同源多开页面各持全量内存镜像，
//   某页改了实体键须通知别页丢镜像（否则另一活页面周期写回旧态·T9 族根）。
import { broadcastInvalidate, onInvalidate } from "../core/sync_bus.js";
import { showToast } from "../ui/toast.js";   // M-T3：保存失败/只读拦截必须让老板看见（不静默丢）

// ---------------------------------------------------------------------------
// 批 10-M M-T3：写路径迁 server（项目域零持久化铁律）
//   项目实体与总表行一律「内存更新 + 异步 PUT」，**这些键的 localStorage 写全部停写**。
//   只读态（boot 降级·serverIsReady=false）→ 前置拦截：不 PUT、不留内存镜像（防幽灵数据）。
//   PUT 失败 → toast + console.warn，**不静默丢、不回写 localStorage**（改动留在内存供本会话用）。
// ---------------------------------------------------------------------------
const SAVE_ERR_TOAST = "保存失败：数据服务不可达——当前改动仅在内存，网络恢复后请重试";
const READONLY_TOAST = "只读模式：数据服务不可达";
// 批6 G1（#33）文案分档（方案 v2.1 §三.1）：总表写失败按 code 分档——冲突族重试耗尽 / 其他。
//   冲突不再误报「不可达」：重试中不弹（合并重试成功则 info 档告知）、耗尽才弹失败并指路刷新。
const INDEX_RETRY_FAIL_TOAST = "同步冲突重试失败·请刷新页面";
const INDEX_MERGED_INFO_TOAST = "项目列表同步冲突·已自动重试";
// 批6 G1 必修②：总表写落定事件（方案 v2.1 §三.2·载荷 {ok, code, id}）——视图的「已创建」toast
//   挂本事件 ok=true 后弹（写结果后·失败不弹成功·成功/失败互斥）。
export const INDEX_WRITE_SETTLED_EVENT = "store:index-write-settled";

function _warn(msg, e) {
  if (typeof console !== "undefined") console.warn(msg, e);
}
function _toast(msg, kind = "error") {
  try { showToast(kind, msg); } catch (_e) { /* 无 DOM 环境（Node 测试）忽略 */ }
}
function _dispatchIndexWriteSettled(id, r) {
  if (typeof document === "undefined" || !document || typeof document.dispatchEvent !== "function") return;
  try {
    document.dispatchEvent(new CustomEvent(INDEX_WRITE_SETTLED_EVENT, {
      detail: {
        ok: !!(r && r.ok),
        code: (r && r.error && String(r.error.code || "")) || "",
        id: String(id == null ? "" : id),
      },
    }));
  } catch (_e) { /* 无 CustomEvent 环境（老 Node）静默——不影响写结果 */ }
}
// 总表写失败文案分档（§三.1）：index_conflict（server_storage 合并重试耗尽的冲突族）→ 耗尽文案；
//   其他（网络/5xx）才「不可达」档。
function _indexFailToast(r) {
  _toast((r && r.error && r.error.code === "index_conflict") ? INDEX_RETRY_FAIL_TOAST : SAVE_ERR_TOAST);
}
function _readonlyGuard() {
  if (serverIsReady()) return false;
  _warn("[store] 只读模式：数据服务不可达·写操作被拒");
  _toast(READONLY_TOAST);
  return true;
}
// 批 E T10：项目实体 PUT 尾随 debounce 300ms（按 key）
//   节流只包 serverPutKey 调用——serverCachePut 内存先行不变、notify 每次照发
//   （节 notify = UI 断更·禁）。每次写重置计时器；pending 未发前再有写 → 合并为最后一次的 value。
//   flush 三钩子（beforeunload / visibilitychange hidden / pagehide）各冲刷 pending，
//   且 flush 路径 PUT 带 keepalive:true（关页期异步 fetch 会被页面卸载砍掉）。
//   波及面：persistEntity 是全部项目实体写点共用（save / updateEditingState / markClipReview 等），
//   总表行 persistIndexRow/Remove 不在本节流域内（即时）。
const PUT_DEBOUNCE_MS = 300;
const _putPending = new Map();   // key → {timer, value}
// 地基批1 T5（账本 #59-①②件）：墓碑集 = 本页已作废的实体键（会话内存级·不落盘）
//   他页广播失效（删/软删/恢复）→ 该键在本页作废：内存镜像摘除 + 尾窗摘除 + 入墓碑。
//   两通道（防抖定时器 / 关页 flush）发送前查墓碑 → 跳过该次 PUT：
//   防「广播前排程的在途写后到照发」与「关页 flush 复活已删实体」。
//   墓碑只装项目实体键（data/projects/...）——index 总表与其他聚合键永不入墓碑。
const _tombstones = new Set();

function _firePut(key, value, opts) {
  if (_tombstones.has(key)) return;   // 墓碑键：本次写不发（迟到写不复活）
  void serverPutKey(key, value, opts).then((r) => {
    if (r && !r.ok) { _warn("[store] 项目实体 PUT 失败", r.error); _toast(SAVE_ERR_TOAST); }
  });
}
function _flushPending() {
  for (const [key, entry] of _putPending) {
    clearTimeout(entry.timer);
    if (_tombstones.has(key)) continue;   // 墓碑键不 flush（关页期也不发）
    _firePut(key, entry.value, { keepalive: true });
  }
  _putPending.clear();
}
// 测试口：立即 flush pending——测试驱动用·不真睡 300ms（生产无调用方）
export function _test_flushDebounce() { _flushPending(); }
// 真删路径摘除该键 pending：不摘则尾窗 PUT 会把已删实体写回服务端（boot 对账按目录列举
//   会把它当孤儿重新收编 → 回收站复活已彻底删除的项目）
function _dropPending(key) {
  const e = _putPending.get(key);
  if (!e) return;
  clearTimeout(e.timer);
  _putPending.delete(key);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("beforeunload", _flushPending);
  globalThis.addEventListener("pagehide", _flushPending);
  globalThis.addEventListener("visibilitychange", () => {
    if (globalThis.document && globalThis.document.visibilityState === "hidden") _flushPending();
  });
}

// 项目实体落库口（全部项目写点共用·保证零持久化不被绕过）
function persistEntity(p) {
  if (!p || !p.id) return false;
  if (_readonlyGuard()) return false;
  const key = serverProjectKey(p.id);
  serverCachePut(key, p);
  const prev = _putPending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    _putPending.delete(key);
    _firePut(key, p, undefined);
  }, PUT_DEBOUNCE_MS);
  _putPending.set(key, { timer, value: p });
  return true;
}
// 总表行同步（增删改 · rev 递增）——写项目后必调，保证另浏览器可见
function persistIndexRow(p) {
  if (_readonlyGuard()) return false;
  const cur = serverCached()[SERVER_INDEX_KEY] || { rev: 0, projects: [] };
  const idx = { rev: (Number(cur.rev) || 0) + 1, projects: (Array.isArray(cur.projects) ? cur.projects : []).filter((r) => r && r.id !== p.id) };
  idx.projects.push({
    id: p.id,
    ...(p.name ? { name: String(p.name) } : {}),
    ...(p.updatedAt ? { updatedAt: String(p.updatedAt) } : {}),
    ...(p.deletedAt ? { deletedAt: String(p.deletedAt) } : {}),
  });
  serverCachePut(SERVER_INDEX_KEY, idx);
  void serverPutKey(SERVER_INDEX_KEY, idx).then((r) => {
    _dispatchIndexWriteSettled(p.id, r);   // 必修②：先派落定事件（视图「已创建」toast 时序锚）
    if (r && !r.ok) {
      _warn("[store] 总表 PUT 失败", r.error);
      _indexFailToast(r);                  // 文案分档（§三.1）
    } else if (r && r.merged) {
      _toast(INDEX_MERGED_INFO_TOAST, "info");   // 冲突已自动重试·info 档（§三.1 冲突档）
    }
  });
  return true;
}
// 总表行移除（purge / 真删）
function persistIndexRemove(id) {
  if (_readonlyGuard()) return false;
  const cur = serverCached()[SERVER_INDEX_KEY] || { rev: 0, projects: [] };
  const idx = { rev: (Number(cur.rev) || 0) + 1, projects: (Array.isArray(cur.projects) ? cur.projects : []).filter((r) => r && r.id !== id) };
  serverCachePut(SERVER_INDEX_KEY, idx);
  void serverPutKey(SERVER_INDEX_KEY, idx).then((r) => {
    _dispatchIndexWriteSettled(id, r);     // 必修②：同漏斗派落定事件
    if (r && !r.ok) {
      _warn("[store] 总表 PUT 失败", r.error);
      _indexFailToast(r);
    } else if (r && r.merged) {
      _toast(INDEX_MERGED_INFO_TOAST, "info");
    }
  });
  return true;
}

function _serverCache() {
  try { return serverCached() || {}; } catch (_e) { return {}; }
}
// server 总表 id 清单（无表/空表 → null = 回退本地 index）
function _serverIndexIds() {
  const idx = _serverCache()[SERVER_INDEX_KEY];
  if (!idx || !Array.isArray(idx.projects)) return null;
  return idx.projects.filter((p) => p && typeof p.id === "string" && p.id && !p.missing).map((p) => p.id);
}

// ===== 常量 =====
export const SCHEMA_VERSION = 1;
const INDEX_KEY = "gui13.project.index";
const PRESET_KEY = "gui13.presets"; // 旧全局键（S1-2 T4）——批 2-T6 起只作迁移源，迁移后删
const PRESET_CACHE_KEY = "gui13.presets.cache"; // 批 2-T6：预设本地缓存快照（事实源在引擎侧）
const TOP_LEVEL_KEY_ORDER = [
  "schemaVersion",
  "id",
  "name",
  // S1-2 T1：项目顶层新增三字段（拼接口径三档/次数/全局提示词），键序放在元数据后
  "projMode",
  "runCount",
  "globalPrompt",
  // S1-2 T4：资源编排三字段（loraChain / modelOverrides / anchorMirror）
  "loraChain",
  "modelOverrides",
  "anchorMirror",
  // 批 8 T1：分配链两字段（castBindings 角色绑定表 / poolManual 手动槽）
  "castBindings",
  "poolManual",
  // 批 W1 S1-T4（R-52）：runDir 运行文件夹基线态 {baseline, current, rebaseline}
  "runDir",
  // 三件补做批 T1（账本 #28·R-03）：三视图画布三键 {aspect?, megapixels?, duration_seconds?}
  //   只存真值、空=删键（清空 = 提交不带键 = 引擎默认 16:9/0.4/2）
  "threepovParams",
  "createdAt",
  "updatedAt",
  "globalParams",
  "segments",
  "assets",
  "editingState",
];

// ===== 工具 =====
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: 经典 v4 模板
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function stableReplacer(_key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ordered = {};
    for (const k of TOP_LEVEL_KEY_ORDER) {
      if (k in value) ordered[k] = value[k];
    }
    for (const k of Object.keys(value)) {
      if (!(k in ordered)) ordered[k] = value[k];
    }
    return ordered;
  }
  return value;
}

// ===== 订阅通道 =====
const subscribers = new Set();
export function subscribe(fn) {
  subscribers.add(fn);
}
export function unsubscribe(fn) {
  subscribers.delete(fn);
}
function notify(event) {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (_e) {
      // 单个订阅者抛错不污染主链
    }
  }
}

// ===== 跨页失效接收（地基批1 T5 · 账本 #59-①②件）=====
//   他页改了实体键 → 广播 invalidate(keys, kind) → 本页：内存镜像摘除 + 尾窗摘除 + 通知。
//   仅 kind=purge（实体真删·服务端已无此实体）才入墓碑：soft/restore 的实体仍在服务端，
//   他页合法后续写不得被会话级封死（T9 迟到写治理归 T6 写前对账）。
//   自己页发出的广播不会回声给自己（BroadcastChannel 标准行为）——本页本地状态变更走各自 notify。
onInvalidate((keys, kind) => {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    serverCachePut(key, undefined);   // 内存镜像摘除（别页的旧态不留在本页）
    _dropPending(key);                // 尾窗摘除（别页的旧态不写回）
    if (kind === "purge") _tombstones.add(key);   // 墓碑：仅真删入（两通道后续写同拦）
  }
  notify({ type: "project:invalidate", keys: list });   // UI 走既有订阅刷新（无订阅者也照发）
});

// ===== 项目对象构造 =====
export function createProject(name) {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uuid(),
    name: name || "",
    // S1-2 T1：项目顶层新增三字段（拼接口径三档/次数/全局提示词）
    projMode: "分镜",
    runCount: 1,
    globalPrompt: "",
    createdAt: ts,
    updatedAt: ts,
    // 批 R4.5 · J3 裁决：项目卡 Tags 行数据源（v43 :1658 卡面 .tags；默认空 → 视图不渲染该行）
    tags: [],
    // S1-2 T1：globalParams 由 2 键占位 → 14 键（按 v43 :1219-1271）
    // S2-2 T1 涟漪：14 键 → 17 键（追加 放大/插帧/放大引擎；旧「插帧/超分」两勾选整体下线，改三件套替代）
    // 键名与 v43 表单/引擎 CSV 白名单同名；提交层零映射成本
    globalParams: {
      "比例": "9:16 竖屏",
      "质量": "0.4",
      "生成步数": "8A8V",
      "语言": "中文",
      "配乐": "自动",
      "氛围声": "自动",
      "音乐混入": "覆盖",
      "审片门": "关",
      "默认负面": "",
      "音乐文件": "",
      "关音乐": false,
      "关对白": false,
      "关水印字幕": false,
      "全部段生成完自动接成一条片": true,
      // S2-2 T1 后处理三键：仅拼接模式且自动拼接=开时生效；CSV 全局行见引擎 csv_gen.py :89-93 白名单
      "放大": false,
      "插帧": false,
      "放大引擎": "seedvr2",
    },
    segments: [
      {
        id: uuid(),
        prompt: "",
        durationSec: 5,
        seed: "",
        checked: true,
        concat: false,
        // S1-2 T1：段卡字段扩展（导出名/分段模式/镜头九项/插帧超分/SR 模式）
        exportName: "",
        "分段模式": "自动（引擎派生）",
        "角度": "",
        "景别": "",
        "运镜方式": "",
        "运镜方向": "",
        "运镜幅度": "",
        "运镜速度": "",
        "焦段": "",
        "氛围": "",
        "情绪": "",
        "插帧": false,
        "超分": false,
        "超分模式": "quick",
        // 排戏台挂槽档2 T1：段级排戏视频参考槽（键=槽号字符串·值={media,usages,cardName}）
        stagingVideoRefs: {},
        // #74 G-W2a T4：段级参考音频槽（同槽值契约·usages=audio_ref）
        stagingAudioRefs: {},
      },
    ],
    assets: [],
    // 剪辑态容器 — S1-3 T1 定稿 schema（v43 时间线口径）
    //   zoom: px/s（v43 PXS 基准 36，缩放极值 12~96 = 33%~267%）
    //   mainClips: 正片轨片段（segId 关联 segments——三视图同源；剪辑态 triml/full/ver 独立演化）
    //   altClips: 备选轨（重跑候选 cand / 被替换旧版 retired）
    //   audioClips: 音频轨
    //   mutedMain/mutedAudio: 轨道静音（v42 件1）
    //   loadedTaskId: 历史载入的引擎任务 id（null=未载入，片段随 segments 初始化）
    editingState: {
      zoom: 36,
      mainClips: [],
      altClips: [],
      audioClips: [],
      mutedMain: false,
      mutedAudio: false,
      loadedTaskId: null,
      // S3-2 T1：轨道双态（locked 锁定防误拖 / hidden 隐藏视觉）——三轨各两态
      tracks: defaultTracks(),
      // S3-2 T5：时间线标记点（纯 GUI 元数据·不进渲染/导出链路）— [{id, sec, name}]
      markers: [],
      // S1-4 T3：创作画布态默认空——视图 mount 时按需 initFromProject 落地
      canvas: null,
      // S3-3 T8：全局调色（作用域「全局调色」）—— null = 未调色，形态见 edit.js COL_ROWS/COL_FILTERS
      color: null,
      // 批 D D-T1：已删片段标记（tombstone·segId 数组）——删有产物片段防重挂载复活（R-21 甲）
      deletedSegIds: [],
      // 批5-R53-TB（B4）：备选链轨道模型默认空（权威分组随 rebuild 重建）
      altChains: {},
    },
    // S1-2 T4：资源编排四子区数据层（loraChain/modelOverrides/anchorMirror）
    // 模板行（🔒 锁序）不入 store，由视图层渲染时拼装常量；store 仅存手动行
    loraChain: [],
    modelOverrides: {},
    anchorMirror: "",
    // 批 8 T1：分配链两字段——castBindings 角色绑定表（legacy bindings 形态
    //   [{name,no,slots:[{idx,kind,usage,media,desc}]}]，纯函数链见 core/bindings.js）；
    //   poolManual 手动槽三 kind 容器（键=槽号字符串，值={media,usages,cardName?}——
    //   T2b computeOccupancy 直读 / T5 G3 胶囊直写依赖此形态）
    castBindings: [],
    poolManual: defaultPoolManual(),
  };
}

// ===== 分镜 CRUD =====
export function addSegment(project) {
  // S1-2 T1：与 createProject 初始段字段同步（导出名/分段模式/镜头九项/插帧超分/SR 模式）
  const seg = {
    id: uuid(),
    prompt: "",
    durationSec: 5,
    seed: "",
    checked: true,
    concat: false,
    exportName: "",
    "分段模式": "自动（引擎派生）",
    "角度": "",
    "景别": "",
    "运镜方式": "",
    "运镜方向": "",
    "运镜幅度": "",
    "运镜速度": "",
    "焦段": "",
    "氛围": "",
    "情绪": "",
    "插帧": false,
    "超分": false,
    "超分模式": "quick",
    // 排戏台挂槽档2 T1：段级排戏视频参考槽（与 createProject 初始段同规格）
    stagingVideoRefs: {},
    // #74 G-W2a T4：段级参考音频槽（与 createProject 初始段同规格）
    stagingAudioRefs: {},
  };
  project.segments.push(seg);
  project.updatedAt = nowIso();
  notify({ type: "segment:add", projectId: project.id, segmentId: seg.id });
  return seg;
}

// 段级槽容器字段（#74：视频/音频同族·同写侧口径）
const STAGING_REF_FIELDS = ["stagingVideoRefs", "stagingAudioRefs"];

export function updateSegment(project, segId, patch) {
  const seg = project.segments.find((s) => s.id === segId);
  if (!seg) return false;
  // 段级槽容器（视/音同族）：写侧深拷贝兜底（对齐 poolManual 写侧口径——非法容器拒写·既有槽保留）
  const hasRefs = patch && typeof patch === "object"
    && STAGING_REF_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
  if (hasRefs) {
    const rest = { ...patch };
    for (const k of STAGING_REF_FIELDS) delete rest[k];
    Object.assign(seg, rest);
    for (const k of STAGING_REF_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const refs = copyStagingRefs(patch[k]);
      if (refs) seg[k] = refs;
    }
  } else {
    Object.assign(seg, patch);
  }
  project.updatedAt = nowIso();
  notify({ type: "segment:update", projectId: project.id, segmentId: segId });
  return true;
}

// 段级槽容器深拷贝（槽键原样·槽值归一为 {media,usages,cardName,desc}·非法槽值跳过）
//   非法容器（非对象/数组）→ null（调用方拒写）
//   desc = 排戏场景文字摘要（#83·视频槽专用）·缺则补空串
function copyStagingRefs(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const k of Object.keys(v)) {
    const e = v[k];
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    out[k] = {
      media: typeof e.media === "string" ? e.media : "",
      usages: Array.isArray(e.usages) ? e.usages.slice() : [],
      cardName: typeof e.cardName === "string" ? e.cardName : "",
      desc: typeof e.desc === "string" ? e.desc : "",
    };
  }
  return out;
}

// ===== S1-3 T1：剪辑态（editingState）更新 =====
// 合并 patch 进项目 editingState（浅合并：标量覆盖，数组整体替换），写回存储并通知。
//   - projectId 不存在 → false（与 updateGlobalParams 同形）
//   - patch 非对象 / 空对象 → false（无意义写入不落盘）
//   - 白名单键：zoom / mainClips / altClips / audioClips / mutedMain / mutedAudio / loadedTaskId
//     （防误改 segments / globalParams——各自有独立 API）
//   - 旧存档无 editingState → 先初始化为默认容器再 patch
const EDITING_STATE_KEYS = [
  "zoom", "mainClips", "altClips", "audioClips",
  "mutedMain", "mutedAudio", "loadedTaskId",
  // S3-2 T1：轨道双态（锁定/隐藏）按轨入 editingState —— 纯 JSON，随项目持久化
  "tracks",
  // S3-2 T5：时间线标记点 —— 纯 GUI 元数据，随项目持久化；不参与提交/CSV 链路（L1 口径）
  "markers",
  // S1-4 T3：创作画布容器（节点/边/视口/历史）——三视图同源铁律下画布态走同一 updateEditingState 通道
  "canvas",
  // S3-3 T8：全局调色（作用域「全局调色」）—— 时间线后处理视觉态，纯 JSON 随项目持久化
  "color",
  // 批 D D-T1：已删片段标记（tombstone·segId 数组）——reconcile 补段闸门防删后复活（R-21 甲）
  "deletedSegIds",
  // 批5-R53-TB（实施计划 B4）：备选链轨道模型（权威分组视图 { [segId]: {gen, items:[{cid,gen,idx}]} }
  //   ——rebuild 时随 altClips 重建（core/candidates.js buildAltChains）；全量重跑清空连带清链
  "altChains",
];
export function defaultEditingState() {
  return {
    zoom: 36,
    mainClips: [],
    altClips: [],
    audioClips: [],
    mutedMain: false,
    mutedAudio: false,
    loadedTaskId: null,
    // S3-2 T1：轨道双态（locked 锁定防误拖 / hidden 隐藏视觉）——三轨各两态
    tracks: defaultTracks(),
    // S3-2 T5：时间线标记点（纯 GUI 元数据·不进渲染/导出链路）— [{id, sec, name}]
    markers: [],
    // S1-4 T3：创作画布态默认空——视图 mount 时按需 initFromProject 落地
    canvas: null,
    // S3-3 T8：全局调色参数默认 null（未调色）——形态见 edit.js COL_ROWS/COL_FILTERS；
    //   纯编辑态元数据（不进 CSV/提交链路），旧档无键 → 读侧按 null 兜底
    color: null,
    // 批 D D-T1：已删片段标记（tombstone·segId 数组）默认空——旧档无键 → 读侧按 [] 兜底
    deletedSegIds: [],
    // 批5-R53-TB（B4）：备选链轨道模型默认空（权威分组随 rebuild 重建·旧档无键读侧兜底）
    altChains: {},
  };
}
// ===== S3-2 T1：轨道双态 (locked / hidden) =====
// 静态轨各两态, 纯 JSON 形态随 editingState 持久化 (刷新后保持).
// 旧档无 tracks 键 → 读侧 normalizeTracks 兜底为全 false (不写迁移, 与其余新字段同惯例).
// 批5-R53-TC（R-S1 落地·T-B 记档的消除项）：静态 `alt` 键退役——备选轨改动态多轨
//   （alt-<N>·B4 动态键）。**记档**：旧档 tracks.alt 的 locked/hidden 态自本批起静默丢弃
//   （旧单条备选轨已不存在·动态轨只认 hidden——旧态无对应轨可迁，合理丢弃）。
export const TRACK_KINDS = ["main", "audio"];
const TRACK_FLAGS = ["locked", "hidden"];
// 批5-R53-TB（B4）：备选动态轨键 alt-<N>（第 N 代际一条轨）——值形态 {hidden:boolean}
//   （locked 静态轨语义·不入动态轨形态）。
const ALT_DYNAMIC_TRACK_RE = /^alt-\d+$/;
export function defaultTracks() {
  const t = {};
  for (const k of TRACK_KINDS) t[k] = { locked: false, hidden: false };
  return t;
}
export function normalizeTracks(tracks) {
  const out = defaultTracks();
  if (tracks && typeof tracks === "object" && !Array.isArray(tracks)) {
    for (const k of TRACK_KINDS) {
      const v = tracks[k];
      if (!v || typeof v !== "object") continue;
      for (const f of TRACK_FLAGS) out[k][f] = !!v[f];
    }
    // 批5-R53-TC（R-S1 记档）：alt- 前缀动态放行——只认 hidden；未知静态键仍丢（正则不中即弃·
    //   含旧档静态 `alt` 键——静默丢弃，见 TRACK_KINDS 处记档）
    for (const k of Object.keys(tracks)) {
      if (!ALT_DYNAMIC_TRACK_RE.test(k)) continue;
      const v = tracks[k];
      out[k] = { hidden: !!(v && typeof v === "object" && !Array.isArray(v) && v.hidden) };
    }
  }
  return out;
}
export function trackFlag(tracks, kind, flag) {
  const t = normalizeTracks(tracks)[kind];
  return !!(t && t[flag]);
}
export function withTrackFlag(tracks, kind, flag, on) {
  const out = normalizeTracks(tracks);
  // 批5-R53-TB：动态轨首写补建（normalize 输出无该键时·静态键行为不变）
  if (!out[kind] && ALT_DYNAMIC_TRACK_RE.test(String(kind))) out[kind] = { hidden: false };
  if (out[kind]) out[kind] = { ...out[kind], [flag]: !!on };
  return out;
}

export function updateEditingState(projectId, patch) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const touched = EDITING_STATE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k));
  if (touched.length === 0) return false;
  if (!p.editingState || typeof p.editingState !== "object") p.editingState = defaultEditingState();
  for (const k of touched) {
    p.editingState[k] = patch[k];
  }
  p.updatedAt = nowIso();
  persistEntity(p);   // M-T3：内存 + 异步 PUT（localStorage 停写）
  notify({ type: "editingState:update", projectId, keys: touched });
  return true;
}

// 批 10-O F100：审核回写（clip.review 唯一写入口）——
//   approve/voidSeg 走通引擎后此前全仓零回写点（grep 实证）→ preview.js deriveThumb 的
//   audited-ok/audited-bad 两支是死码：右键审核后缩略点仍灰、title 仍「未审」。
//   按 segId 反查 mainClips 写 review（合法值恰 approved/void·引擎 review 语义）→
//   persistEntity 落盘 + notify（事件型对齐 updateEditingState——剪辑页/概况页都订阅同一
//   通道自动重渲，无需调用点各写一套重渲）。段/项目不存在返回 false 不抛。
export function markClipReview(projectId, segId, review) {
  if (!projectId || typeof projectId !== "string") return false;
  const v = String(review);
  if (v !== "approved" && v !== "void") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!p.editingState || typeof p.editingState !== "object") p.editingState = defaultEditingState();
  const clips = Array.isArray(p.editingState.mainClips) ? p.editingState.mainClips : [];
  const clip = clips.find((c) => c && c.segId === segId);
  if (!clip) return false;
  clip.review = v;
  p.updatedAt = nowIso();
  persistEntity(p);
  notify({ type: "editingState:update", projectId, keys: ["mainClips"] });
  return true;
}

// ===== S3-3 T1：clip L2 编辑态字段 =====
// 变速/倒放/定格/分离音视频/音量/关键帧/转场（T1-T7）+ 调色（T8）+ 淡化（T9）—— 纯编辑态元数据：
// 随项目 JSON 持久化，不进 CSV/提交链路（零泄漏断言见 store.test.mjs）。
//   freeze / transition 取值形态由 T3 / T7 定；color 由 T8 定（{bright,contrast,sat,temp,filter}
//   或 null = 未调色）；fadeIn / fadeOut 由 T9 定（秒数·0-5 域钳制属编辑控件读侧）——本函数只钉
//   默认值占位，逐字段形态/脏值校验在编辑控件读侧（edit.js）。
// 旧档 clip 无此字段 → 读侧 normalizeClipL2 兜底默认（不写迁移，与 normalizeTracks 同惯例）。
export function defaultClipL2() {
  return {
    speed: 1.0,
    reverse: false,
    freeze: null,
    splitAV: false,
    volume: 1.0,
    keyframes: [],
    transition: null,
    color: null,
    fadeIn: 0,
    fadeOut: 0,
  };
}
// 读侧归一：缺字段/脏值 → 默认；已设值原样读出（不覆盖、不改入参）。
// 范围钳制（speed 0.5-2x / volume 0-1 / fade 0-5s）属编辑控件口径（T2/T5/T9），此处不越界。
export function normalizeClipL2(clip) {
  const out = defaultClipL2();
  if (!clip || typeof clip !== "object") return out;
  if (typeof clip.speed === "number" && Number.isFinite(clip.speed)) out.speed = clip.speed;
  if (typeof clip.reverse === "boolean") out.reverse = clip.reverse;
  if (clip.freeze && typeof clip.freeze === "object" && !Array.isArray(clip.freeze)) out.freeze = clip.freeze;
  if (typeof clip.splitAV === "boolean") out.splitAV = clip.splitAV;
  if (typeof clip.volume === "number" && Number.isFinite(clip.volume)) out.volume = clip.volume;
  if (Array.isArray(clip.keyframes)) out.keyframes = clip.keyframes.slice();
  if (clip.transition && typeof clip.transition === "object" && !Array.isArray(clip.transition)) out.transition = clip.transition;
  if (clip.color && typeof clip.color === "object" && !Array.isArray(clip.color)) out.color = clip.color;
  if (typeof clip.fadeIn === "number" && Number.isFinite(clip.fadeIn)) out.fadeIn = clip.fadeIn;
  if (typeof clip.fadeOut === "number" && Number.isFinite(clip.fadeOut)) out.fadeOut = clip.fadeOut;
  return out;
}

// ===== S1-3 T1：segments → mainClips 对账（三视图同源核心） =====
// 剪辑 TAB 打开时调：对账 mainClips（原位演化，不整体重建——保留剪辑态）。
//   顺序唯一真源 = mainClips 现数组序（用户拖序）——本函数绝不重排（批 D D-T1·段号永不自动重排铁律）：
//   - linked 片段（segId ∈ segments）原位保留，n/label 冻结；无剪辑态跟随 durationSec（dur/full 同步）
//   - floating 片段（segId 以 paste-/new-/split- 开头 = 剪辑态副本/占位段/分割右半）原位保留
//   - 真孤儿（segId 非空、非 floating 前缀、且不在 segments）→ 移除
//   - segments 新增段（segId 不在 deletedSegIds 删除标记中）→ 追加数组末尾：n=max(存量 n)+1、label=「段{n}」
//   - deletedSegIds 自愈：分镜行已不存在的标记从 es.deletedSegIds 原位移除
// 返回 { changed, clips }。注意（复核修正笔·A 审 finding 落定）：本函数对入参
// project.editingState 内对象做原位演化（linked 改写 dur/full；deletedSegIds 原位清理），
// 非纯无副作用——调用方以 storeLoad 副本调用（edit.js mount 路径），持久化统一走 updateEditingState。
// 前缀串勿单边改：edit.js deleteClips 墓碑排除处有同正则双胞胎（store 未导出·本地各持一份）。
const FLOATING_SEG_PREFIX = /^(paste-|new-|split-)/;
export function reconcileMainClips(project) {
  if (!project || !Array.isArray(project.segments)) return { changed: false, clips: [] };
  const es = project.editingState && typeof project.editingState === "object"
    ? project.editingState
    : defaultEditingState();
  const prev = Array.isArray(es.mainClips) ? es.mainClips : [];
  // 旧档无 deletedSegIds 键 → 读侧按 [] 兜底（不写迁移，与其余新字段同惯例）
  const deletedSegIds = Array.isArray(es.deletedSegIds) ? es.deletedSegIds : [];
  const segIds = new Set(project.segments.map((s) => s && s.id).filter(Boolean));
  // 批 C C-T1：prev 侧 segId 出现次数（noEdit 回写守卫用——见下方 noEditUnique）。
  //   批 C 前分割产物是「同 segId 双半」，两条都命中 noEdit 判据（triml=0 且 full===dur），
  //   无守卫则 remount 双半一起涨回段全长（用户分割白干）。批 C 后新分割右半走 split- floating。
  const prevSegCount = new Map();
  for (const c of prev) {
    const s = String((c && c.segId) || "");
    if (s) prevSegCount.set(s, (prevSegCount.get(s) || 0) + 1);
  }
  const out = [];
  const seenSeg = new Set();
  let changed = false;

  // 遍历现有 clips：linked/floating 原位保留（n/label 冻结）/ 真孤儿删
  for (const c of prev) {
    if (!c) { changed = true; continue; }
    const sid = String(c.segId || "");
    if (sid && segIds.has(sid)) {
      const seg = project.segments.find((s) => s.id === sid);
      const dur = typeof seg.durationSec === "number" ? seg.durationSec : 5;
      const noEdit = (!c.triml || c.triml === 0) && (c.full == null || c.full === c.dur);
      // 批 C C-T1：segId 在 prev 数组唯一才回写（存量同 segId 双半保护）；
      //   单条 linked 片段语义不变（唯一 → 照常跟随设定页 durationSec）。
      if (noEdit && prevSegCount.get(sid) === 1 && c.dur !== dur) { c.dur = dur; c.full = dur; changed = true; }
      seenSeg.add(sid);
      out.push(c);
    } else if (sid && FLOATING_SEG_PREFIX.test(sid)) {
      out.push(c); // 剪辑态副本/占位段/分割右半——不回写设定页，原位保留
    } else {
      changed = true; // 真孤儿（段已删）
    }
  }
  // deletedSegIds 自愈：分镜行已不存在的标记顺手移除（原位更新；旧档无键不回填）
  if (Array.isArray(es.deletedSegIds)) {
    const kept = deletedSegIds.filter((sid) => segIds.has(sid));
    if (kept.length !== deletedSegIds.length) {
      es.deletedSegIds = kept;
      changed = true;
    }
  }
  // segments 新增段（且未被删除标记命中）→ append 数组末尾，n=max(存量 n)+1
  let maxN = 0;
  for (const c of out) {
    if (typeof c.n === "number" && Number.isFinite(c.n) && c.n > maxN) maxN = c.n;
  }
  for (const seg of project.segments) {
    if (!seg || !seg.id || seenSeg.has(seg.id) || deletedSegIds.includes(seg.id)) continue;
    const dur = typeof seg.durationSec === "number" ? seg.durationSec : 5;
    maxN += 1;
    out.push({
      segId: seg.id,
      n: maxN,
      label: `段${maxN}`,
      dur,
      triml: 0,
      full: dur,
      ver: "原版",
      state: "empty",
      // S3-3 T1：新建 clip 直带十字段默认值（旧档 clip 由 normalizeClipL2 读侧兜底）
      ...defaultClipL2(),
    });
    changed = true;
  }
  return { changed, clips: out };
}

// ===== R-20③（批 10-P P-T1）：项目完成度实时推导（纯函数·只读不写） =====
// ran=false 当且仅当无 runs 且零产物；有产物判据 = 该 segId 的 clip file 非空且
// state ∈ {done,warn}（file 门为主——防 applyHistory 重建失败段 state=warn 且 file=null
// 〔edit.js applyHistory〕被计为有产物虚高）；全按 segId 集合对号·禁位置对号
// （floating 副本/孤儿 clip 不计·clip 序无关）。segCount=0 不判完成（0/0 无「已完成」语义）。
export function deriveProjectCompletion(segments, mainClips, runs) {
  const segs = Array.isArray(segments) ? segments : [];
  const clips = Array.isArray(mainClips) ? mainClips : [];
  const bySegId = new Map();
  for (const c of clips) {
    if (c && c.segId != null) bySegId.set(c.segId, c);
  }
  let doneCount = 0;
  for (const s of segs) {
    const c = s && s.id != null ? bySegId.get(s.id) : null;
    if (c && c.file && (c.state === "done" || c.state === "warn")) doneCount++;
  }
  const segCount = segs.length;
  return {
    ran: doneCount > 0 || (Array.isArray(runs) && runs.length > 0),
    complete: segCount > 0 && doneCount === segCount,
    doneCount,
    segCount,
  };
}

// ===== #63 T4：运行记录指针（currentRunId → runs 行）=====
// 指针缺失/悬空（旧项目·记录被裁掉）→ 回落 runs[0]（倒序现行置顶·旧项目兼容）。
export function currentRunRow(project) {
  const runs = Array.isArray(project && project.runs) ? project.runs : [];
  const rid = project && typeof project.currentRunId === "string" ? project.currentRunId : "";
  if (rid) {
    const hit = runs.find((r) => r && r.recordId === rid);
    if (hit) return hit;
  }
  return runs[0] || null;
}

// 指针是否钉在非最新记录（显式载入旧记录）：三处「最新自愈」豁免判据。
// 指针=最新行/缺失/悬空 → false（照旧自愈）。
export function isRunPointerPinned(project) {
  const runs = Array.isArray(project && project.runs) ? project.runs : [];
  const rid = project && typeof project.currentRunId === "string" ? project.currentRunId : "";
  if (!rid || !runs.length) return false;
  return runs.findIndex((r) => r && r.recordId === rid) > 0;
}

// ===== F106 T1：「现行任务」判定（纯函数·只读） =====
// runs 最新置顶（unshift 序）倒序首个「无 kind 且有非空 stem」的记录的 stem = 最近一次主链全量运行；
// resume/rerun/seg_edit 记录带 kind 被跳过（resume 子集任务只含缺段 shots·不能当操作目标）。
// 无匹配/非数组/空 → null（调用方 null 守卫跳过写·不抹掉既有指向）。
export function latestMainRunStem(runs) {
  if (!Array.isArray(runs)) return null;
  for (const r of runs) {
    if (r && !r.kind && r.stem) return r.stem;
  }
  return null;
}

// ===== S1-2 T2：globalParams 单键/批量更新 =====
// 按 projectId 从存储读出，patch 合并入 globalParams，再写回存储并通知订阅者。
// 不存在的 projectId → 返回 false；旧数据无 globalParams → 初始化为空对象后再 patch。
export function updateGlobalParams(projectId, patch) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!p.globalParams || typeof p.globalParams !== "object") p.globalParams = {};
  if (patch && typeof patch === "object") {
    for (const k of Object.keys(patch)) {
      p.globalParams[k] = patch[k];
    }
  }
  p.updatedAt = nowIso();
  persistEntity(p);   // M-T3：内存 + 异步 PUT（localStorage 停写）
  notify({ type: "globalParams:update", projectId });
  return true;
}

export function removeSegment(project, segId) {
  const idx = project.segments.findIndex((s) => s.id === segId);
  if (idx === -1) return false;
  project.segments.splice(idx, 1);
  project.updatedAt = nowIso();
  notify({ type: "segment:remove", projectId: project.id, segmentId: segId });
  return true;
}

// ===== S1-2 T3：段卡拖拽排序（moveSegment）=====
// 段卡拖拽重排：将 segments[fromIdx] 移到 toIdx（按惯例：toIdx 是"放下后位置"，向前移 toIdx 之后所有段右移一位）。
//   - 同一索引 → no-op + true（不污染 updatedAt，避免无意义写入/通知）
//   - fromIdx 越界 [0, length) → 返回 false（保护：不接受任意段被误移）
//   - toIdx 越界 → 钳到 [0, length)（拖到卡片最上/最下边缘兜底）
//   - 空 segments → 返回 false
//   - projectId 不匹配 → 返回 false（不影响 in-memory 形态，仅通知侧防呆）
// 数据流：保持对象身份（不重建对象）、保持 schemaVersion、其他字段不动；updatedAt 刷新。
export function moveSegment(project, projectId, fromIdx, toIdx) {
  if (!project || !Array.isArray(project.segments)) return false;
  if (project.id !== projectId) return false;
  const len = project.segments.length;
  if (len === 0) return false;
  if (typeof fromIdx !== "number" || typeof toIdx !== "number") return false;
  if (fromIdx < 0 || fromIdx >= len) return false;
  // toIdx 钳到 [0, len]（拖到卡片最上/最下边缘兜底）；toIdx === len 表示拖到末尾 → splice 末尾插入合法
  let to = Math.max(0, Math.min(len, toIdx | 0));
  // 同一索引 → no-op（不刷 updatedAt，避免无意义写入/通知）
  if (fromIdx === to) return true;
  const [seg] = project.segments.splice(fromIdx, 1);
  // to 是"放下后位置"：直接 splice 插入（数组已变短，不会越界）
  project.segments.splice(to, 0, seg);
  project.updatedAt = nowIso();
  notify({ type: "segment:move", projectId: project.id, fromIdx, toIdx: to });
  return true;
}

// ===== S1-2 T4：资源编排 updateProjectMeta =====
// 合并 patch 到项目顶层元数据字段（loraChain / modelOverrides / anchorMirror）。
// 路径：按 projectId load → Object.assign(meta 字段) → save → notify。
//   - projectId 不存在 / 非法 → false（与 updateGlobalParams 同形）
//   - 只 patch 白名单字段（loraChain / modelOverrides / anchorMirror / loraTplState / runs
//     / castBindings / poolManual / runDir / currentRunId），其他字段忽略
//     防御：防止误改 segments / globalParams（各自有独立 API）
//   - 缺字段的项目（旧存档）→ 初始化默认值再 patch（与 updateGlobalParams 同形）
const META_KEYS = ["loraChain", "modelOverrides", "anchorMirror", "loraTplState", "runs", "castBindings", "poolManual", "runDir", "currentRunId"];
export function updateProjectMeta(projectId, patch) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!patch || typeof patch !== "object") return false;
  let touched = 0;
  for (const k of META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      if (k === "loraChain") {
        if (!Array.isArray(patch[k])) continue;
        p.loraChain = patch[k].slice();
      } else if (k === "runs") {
        // 登记项 7（老板裁决 2026-09-27）：真运行历史——倒序数组 {at,total,done,failed,running?,memo?,verNote?}
        if (!Array.isArray(patch[k])) continue;
        p.runs = patch[k].slice();
      } else if (k === "modelOverrides") {
        if (!patch[k] || typeof patch[k] !== "object") continue;
        p.modelOverrides = Object.assign({}, patch[k]);
      } else if (k === "loraTplState") {
        // 登记项 3：模板行强度/启用态（旧存档无此字段 → 首写补齐）
        if (!patch[k] || typeof patch[k] !== "object") continue;
        p.loraTplState = Object.assign({}, patch[k]);
      } else if (k === "castBindings") {
        // 批 8 T1：角色绑定表（数组·legacy bindings 形态）
        if (!Array.isArray(patch[k])) continue;
        p.castBindings = patch[k].slice();
      } else if (k === "poolManual") {
        // 批 8 T1：手动槽（三 kind 容器对象）
        if (!isValidPoolManualShape(patch[k])) continue;
        p.poolManual = copyPoolManual(patch[k]);
      } else if (k === "runDir") {
        // 批 W1 S1-T4（R-52）：运行文件夹基线态，整体替换（非并字段）
        if (!patch[k] || typeof patch[k] !== "object" || Array.isArray(patch[k])) continue;
        p.runDir = Object.assign({}, patch[k]);
      } else if (k === "currentRunId") {
        // #63 T4：当前运行记录指针（空串 = 清指针 → 显示回落 runs[0]）
        p.currentRunId = String(patch[k] == null ? "" : patch[k]);
      } else {
        // anchorMirror：字符串
        p.anchorMirror = String(patch[k] == null ? "" : patch[k]);
      }
      touched++;
    }
  }
  if (touched === 0) return false;
  p.updatedAt = nowIso();
  persistEntity(p);   // M-T3：内存 + 异步 PUT（localStorage 停写）
  notify({ type: "project:meta-update", projectId });
  return true;
}

// ===== 批 8 T1：分配链两字段兜底 + 专用更新 API =====
// 域数据走项目顶层键 + 独立通道，不走 editingState（该白名单=纯编辑态不进提交链——仓库不变量）.
//   - castBindings：数组，消费方（T2a 生产/T2b 占用表/T4 面板）经 normalizeCastBindings 读侧兜底
//   - poolManual：三 kind 容器（键=槽号字符串，值={media,usages,cardName?}），经 normalizePoolManual 兜底
// 旧档无键不写迁移（tracks/color 同惯例——load 后 undefined，读侧归一）.

// ===== 批A #13（方案-#13解耦B档-2026-10-16）：detail 快照缓存 =====
//   快照 = 引擎 manifest 关键面（shots/_reruns/concat + savedAt）落项目实体顶层 detailSnapshots[taskId]
//   （写点：edit.js applyHistory / submit-bar.js syncRunProducts）。派生缓存数据——persistEntity 落盘
//   但不 notify（无视图需因快照写重渲）。三失效语义：①仅离线显示兜底（消费侧标注数据时点）
//   ②引擎可达仍走既有对账链不因快照跳过 ③芯片转「已连接」即 invalidateDetailSnapshots 主动失效。
//   封顶 5 条（超限按 savedAt 最旧淘汰）防项目实体膨胀。
const DETAIL_SNAPSHOT_CAP = 5;

export function putDetailSnapshot(projectId, taskId, snapshot) {
  if (!projectId || typeof projectId !== "string") return false;
  if (!taskId || typeof taskId !== "string") return false;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  if (!snapshot.shots || typeof snapshot.shots !== "object" || Array.isArray(snapshot.shots)) return false;
  const p = load(projectId);
  if (!p) return false;
  const cur = (p.detailSnapshots && typeof p.detailSnapshots === "object" && !Array.isArray(p.detailSnapshots)) ? p.detailSnapshots : {};
  const next = { ...cur, [taskId]: {
    taskId,
    savedAt: typeof snapshot.savedAt === "string" && snapshot.savedAt ? snapshot.savedAt : nowIso(),
    shots: snapshot.shots,
    reruns: Array.isArray(snapshot.reruns) ? snapshot.reruns : [],
    concat: snapshot.concat === undefined ? null : snapshot.concat,
  } };
  const keys = Object.keys(next).sort((a, b) => String(next[a].savedAt || "").localeCompare(String(next[b].savedAt || "")));
  while (keys.length > DETAIL_SNAPSHOT_CAP) delete next[keys.shift()];
  p.detailSnapshots = next;
  p.updatedAt = nowIso();
  persistEntity(p);
  return true;
}

export function getDetailSnapshot(projectId, taskId) {
  if (!projectId || typeof projectId !== "string" || !taskId) return null;
  const p = load(projectId);
  const m = (p && p.detailSnapshots && typeof p.detailSnapshots === "object") ? p.detailSnapshots : null;
  const hit = m ? m[taskId] : null;
  return (hit && typeof hit === "object" && !Array.isArray(hit)) ? hit : null;
}

export function invalidateDetailSnapshots(projectId) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p || !p.detailSnapshots) return false;
  delete p.detailSnapshots;
  p.updatedAt = nowIso();
  persistEntity(p);
  return true;
}

// ===== 三件补做批 T1（账本 #28·R-03）：三视图画布三键项目级持久化 =====
//   形态 {aspect?: string, megapixels?: number, duration_seconds?: number}——只存真值、空=删键
//   （清空 = 生成 body 不带键 = 引擎按 h3_config.canvas/内置默认 16:9/0.4/2 兜底）。
//   走 persistEntity 单源落盘；不 notify（无视图需因三键写重渲·putDetailSnapshot 同款先例）。
export function getThreepovParams(projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  const p = load(projectId);
  const v = p ? p.threepovParams : null;
  return (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0)
    ? Object.assign({}, v)
    : null;
}

export function setThreepovParams(projectId, params) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  const next = {};
  if (params && typeof params === "object" && !Array.isArray(params)) {
    if (typeof params.aspect === "string" && params.aspect.trim()) next.aspect = params.aspect.trim();
    if (typeof params.megapixels === "number" && Number.isFinite(params.megapixels)) next.megapixels = params.megapixels;
    if (typeof params.duration_seconds === "number" && Number.isFinite(params.duration_seconds)) next.duration_seconds = params.duration_seconds;
  }
  if (Object.keys(next).length === 0) {
    if (!p.threepovParams) return true;   // 幂等：本就无键 → 零写入
    delete p.threepovParams;
  } else {
    p.threepovParams = next;
  }
  p.updatedAt = nowIso();
  persistEntity(p);
  return true;
}

// 最近项目 id（updatedAt 倒序首位·shell 画布 fallback / portal recentProjectId 同口径）。
//   资产库页可无项目直入（shell /assets 独立路由不带项目）——调用方以 null = 无项目上下文
//   自行退化（#28：三键转会话态），本函数只做解析不兜底。
export function latestProjectId() {
  let best = null;
  for (const p of listProjects()) {
    if (!p || !p.id) continue;
    if (!best || String(p.updatedAt || "").localeCompare(String(best.updatedAt || "")) > 0) best = p;
  }
  return best ? best.id : null;
}

const POOL_MANUAL_KINDS = ["Picture", "Video", "Audio"];

// 新容器（每次新对象，勿提为模块级共享常量——防跨项目串引用）
export function defaultPoolManual() {
  const out = {};
  for (const k of POOL_MANUAL_KINDS) out[k] = {};
  return out;
}

// 读侧归一：缺键/脏值 → 默认；合法 kind 浅拷贝读出（不覆盖、不改入参）
export function normalizeCastBindings(v) {
  return Array.isArray(v) ? v : [];
}
export function normalizePoolManual(v) {
  const out = defaultPoolManual();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of POOL_MANUAL_KINDS) {
      const kind = v[k];
      if (kind && typeof kind === "object" && !Array.isArray(kind)) {
        out[k] = Object.assign({}, kind);
      }
    }
  }
  return out;
}

// 写侧容器校验：非数组对象 + 三 kind 各为对象（槽值形态由写侧 UI 保证，本层只校验容器）
function isValidPoolManualShape(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const k of POOL_MANUAL_KINDS) {
    const kind = v[k];
    if (!kind || typeof kind !== "object" || Array.isArray(kind)) return false;
  }
  return true;
}
function copyPoolManual(v) {
  const out = {};
  for (const k of POOL_MANUAL_KINDS) out[k] = Object.assign({}, v[k]);
  return out;
}

// setCastBindings(projectId, bindings)：整组替换（legacy setCastBindings 先例——调用方经
//   core/bindings.js 纯函数算出新数组后落 store）.
//   projectId 不存在/非法 → false；bindings 非数组 → false；updatedAt 刷新；写回存储。
export function setCastBindings(projectId, bindings) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!Array.isArray(bindings)) return false;
  p.castBindings = bindings.slice();
  p.updatedAt = nowIso();
  persistEntity(p);   // M-T3：内存 + 异步 PUT（localStorage 停写）
  notify({ type: "castBindings:update", projectId });
  return true;
}

// setPoolManual(projectId, poolManual)：整组替换。poolManual 非对象/非三 kind 对象 → false。
export function setPoolManual(projectId, poolManual) {
  if (!projectId || typeof projectId !== "string") return false;
  const p = load(projectId);
  if (!p) return false;
  if (!isValidPoolManualShape(poolManual)) return false;
  p.poolManual = copyPoolManual(poolManual);
  p.updatedAt = nowIso();
  persistEntity(p);   // M-T3：内存 + 异步 PUT（localStorage 停写）
  notify({ type: "poolManual:update", projectId });
  return true;
}

// ===== 批 2-T6：预设区迁引擎侧（事实源 = 引擎包根 presets/<name>.json · api.md #23-25）=====
// 契约（2026-09-28 真机 8190 逐端点实测对拍·与 api.md 一致）：
//   GET /h3_batch/presets → {"ok":true,"presets":[{"name","time"}]}（按 time desc）
//   GET ?name=X → {"ok":true,"name","config"}；404 preset_not_found
//   POST {"name","config"} → {"ok":true,"name"}（400 preset_name_invalid / config_required）
//   DELETE ?name=X → {"ok":true,"name"}；404 preset_not_found
// 本地 = 读穿缓存：refresh 成功落快照；保存/删除引擎侧成功才更新缓存；引擎不可达 → 只读缓存快照。
// 字段映射：本地快照 globalParams ⇄ 引擎 config（17 键 dict 全量直存·引擎侧不裁剪）。
// 快照结构：{ name: string, globalParams: object }（与 S1-2 T4 同形·消费方零改形）。
// 旧键 gui13.presets 只作迁移源（migrateLocalPresets 一次性 POST 后清退）。
const PRESET_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$/; // 与引擎 _PRESET_NAME_RE 同形

// 网络注入：测试注 fake transport（零网络）；生产路径调用时动态 import core/api
let presetTransport = null;
export function _setPresetTransport(fn) {
  presetTransport = fn;
}
async function presetRequest(path, opts) {
  if (presetTransport) return presetTransport(path, opts);
  const mod = await import("../core/api.js"); // store 不静态引网络模块（Node 测试环境零副作用）
  return mod.request(path, opts);
}

function readPresets() {
  try {
    const raw = storage.getItem(PRESET_CACHE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

function writePresets(arr) {
  storage.setItem(PRESET_CACHE_KEY, JSON.stringify(arr));
}

export function loadPresets() {
  return readPresets().map((p) => ({
    name: p.name,
    globalParams: Object.assign({}, p.globalParams || {}),
  }));
}

// 保存：trim → 脏名正则先拒（false·零请求）→ POST 成功才写缓存 + notify → true；网络失败/非 ok → false
export async function savePreset(name, snapshot) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!PRESET_NAME_RE.test(trimmed)) return false;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const r = await presetRequest("/h3_batch/presets", {
    method: "POST",
    body: { name: trimmed, config: Object.assign({}, snapshot) },
  });
  if (!r || !r.ok) return false;
  const list = readPresets();
  const idx = list.findIndex((p) => p.name === trimmed);
  const entry = { name: trimmed, globalParams: Object.assign({}, snapshot) };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  writePresets(list);
  notify({ type: "preset:save", name: trimmed });
  return true;
}

// 删除：DELETE → 成功删缓存 + notify → true；引擎 404 = 对账语义（引擎已无此条）→ 删缓存 → true；其他失败 → false
export async function deletePreset(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed === "") return false;
  const r = await presetRequest(
    "/h3_batch/presets?name=" + encodeURIComponent(trimmed),
    { method: "DELETE" },
  );
  const notFound = !!(r && !r.ok && r.error && r.error.code === "preset_not_found");
  if (!r || (!r.ok && !notFound)) return false;
  const list = readPresets();
  const idx = list.findIndex((p) => p.name === trimmed);
  if (idx >= 0) {
    list.splice(idx, 1);
    writePresets(list);
  }
  notify({ type: "preset:delete", name: trimmed });
  return true;
}

// 刷新：GET 列表 → 逐名 GET ?name= 拿 config → 全量替换写缓存 → true；任一步失败 → false（缓存不动）
export async function refreshPresetsFromEngine() {
  const r = await presetRequest("/h3_batch/presets");
  if (!r || !r.ok) return false;
  const presets = r.data && Array.isArray(r.data.presets) ? r.data.presets : null;
  if (!presets) return false;
  const out = [];
  for (const item of presets) {
    const name = item && typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    const d = await presetRequest("/h3_batch/presets?name=" + encodeURIComponent(name));
    if (!d || !d.ok) return false;
    const cfg = d.data && d.data.config && typeof d.data.config === "object" && !Array.isArray(d.data.config)
      ? d.data.config
      : {};
    out.push({ name, globalParams: Object.assign({}, cfg) });
  }
  writePresets(out);
  return true;
}

// 迁移：旧键存量逐条 POST·成功才清退该条；脏名跳过记名并清退（引擎侧永不可用·不卡死重报）；
//   POST 失败条目保留旧键待下次；数组清空 → removeItem 旧键。返回 { migrated, skipped }
export async function migrateLocalPresets() {
  let arr;
  try {
    const raw = storage.getItem(PRESET_KEY);
    if (raw == null) return { migrated: 0, skipped: [] };
    const parsed = JSON.parse(raw);
    arr = Array.isArray(parsed) ? parsed : null;
  } catch (_e) {
    arr = null;
  }
  if (arr === null) return { migrated: 0, skipped: [] };
  let migrated = 0;
  const skipped = [];
  const remaining = [];
  for (const entry of arr) {
    const rawName = entry && typeof entry.name === "string" ? entry.name.trim() : "";
    if (!PRESET_NAME_RE.test(rawName)) {
      skipped.push(rawName || String(entry && entry.name != null ? entry.name : ""));
      continue;
    }
    const config = entry && entry.globalParams && typeof entry.globalParams === "object"
      ? Object.assign({}, entry.globalParams)
      : {};
    const r = await presetRequest("/h3_batch/presets", { method: "POST", body: { name: rawName, config } });
    if (r && r.ok) migrated++;
    else remaining.push(entry);
  }
  if (remaining.length === 0) storage.removeItem(PRESET_KEY);
  else storage.setItem(PRESET_KEY, JSON.stringify(remaining));
  return { migrated, skipped };
}

export function applyPreset(name, projectId) {
  if (!name || typeof name !== "string") return null;
  const list = readPresets();
  const entry = list.find((p) => p.name === name);
  if (!entry) return null;
  // 14 键补齐：未覆盖字段按 createProject 默认值
  const baseDefaults = createProject("").globalParams;
  const full = Object.assign({}, baseDefaults, entry.globalParams || {});
  // projectId 入参 → 同时写 store（联动；与 updateGlobalParams 同形）
  if (projectId != null) {
    if (typeof projectId !== "string" || projectId === "") return false;
    return updateGlobalParams(projectId, full);
  }
  return full;
}

// ===== 持久化 =====
function readIndex() {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

// M-T2 读路径 id 清单：server 总表优先（剔除 missing 幽灵行）→ 空表回退本地 index；
//   再与本地 index 取并集（过渡期：本地有实体而总表未收编的旧项目不丢）。
//   写路径仍走 readIndex（localStorage 单源·M-T3 再迁）。
function readIndexMerged() {
  const local = readIndex();
  const sids = _serverIndexIds();
  if (!sids || !sids.length) return local;
  const out = sids.slice();
  for (const id of local) if (!out.includes(id)) out.push(id);
  return out;
}

export function save(project) {
  project.updatedAt = nowIso();
  persistEntity(project);   // M-T3：实体内存 + 异步 PUT（localStorage 停写）
  persistIndexRow(project); // M-T3：总表行同步（另浏览器可见）
  notify({ type: "project:save", projectId: project.id });
}

export function load(id) {
  // M-T7：纯 server 读（M-T2~T6 双源过渡已收口——M-T6 迁移保证存量先上载·本地不回落，
  //   方案 §三.2「M-T6 收口后改纯 server」；验收 ② server 无 = 无数据）
  const ent = _serverCache()[serverProjectKey(id)];
  return (ent && typeof ent === "object") ? _healStaleRunning(ent) : null;
}

// M-T8 F95b 尾：boot 自愈——老板降级期间完成的任务，其 clip.status 冻结在
//   running/rendering（submit-bar onTick 写入·轮询链随降级断掉）→ 时间线
//   shotColor("rendering")=黄 永不刷新。boot 后首读把进行中态归一 "unknown"
//   （shotColor 兜底 gray=待核实；运行期 submit-bar onTick 幂等重刷会把真终态写回）。
//   就地归一=同时修正内存缓存（后续实体 PUT 带回 server）；终态/unknown 幂等不动。
function _healStaleRunning(p) {
  const mcs = (p && p.editingState && Array.isArray(p.editingState.mainClips)) ? p.editingState.mainClips : null;
  if (!mcs) return p;
  for (const c of mcs) {
    if (c && (c.status === "running" || c.status === "rendering")) c.status = "unknown";
  }
  return p;
}

export function remove(id) {
  // S1-1 T3 授权扩展：软删（写 deletedAt）。回收站可恢复；listProjects 默认过滤已删。
  const p = load(id);
  if (p && !p.deletedAt) {
    p.deletedAt = nowIso();
    persistEntity(p);         // M-T3：软删态随实体上载（回收站可恢复）
    persistIndexRow(p);       // M-T3：总表行带 deletedAt
    broadcastInvalidate([serverProjectKey(id)], "soft");   // T5：跨页失效广播（他页丢镜像·实体仍在·不墓碑）
    notify({ type: "project:soft-delete", projectId: id });
    return;
  }
  // 已是软删态或项目不存在 → 真删兜底（兼容旧数据 / 极端回退）
  _dropPending(serverProjectKey(id));                  // T10：真删摘尾窗·防实体被写回复活
  serverCachePut(serverProjectKey(id), undefined);   // M-T3：内存镜像摘除
  persistIndexRemove(id);                             // M-T3：总表行删
  broadcastInvalidate([serverProjectKey(id)], "purge");   // T5：真删兜底同真删语义（他页须入墓碑）
  notify({ type: "project:remove", projectId: id });
}

export function restore(id) {
  // 回收站恢复：清 deletedAt；项目回到 listProjects 默认视图
  const p = load(id);
  if (!p) return false;
  if (!p.deletedAt) return false;
  delete p.deletedAt;
  p.updatedAt = nowIso();
  persistEntity(p);          // M-T3
  persistIndexRow(p);        // M-T3：总表行去 deletedAt
  broadcastInvalidate([serverProjectKey(id)], "restore");   // T5：跨页失效广播（他页丢镜像·实体已活·不墓碑）
  notify({ type: "project:restore", projectId: id });
  return true;
}

export function purgeProject(id) {
  // B4-T4 ②：回收站彻底删除——remove 为软删，本函数=真删服务端实体文件 + 索引摘除。
  //   T4 地基件（账本 #44/#59）：五步顺序钉死——
  //   ① 摘防抖尾窗（否则尾随 PUT 把实体写回·复活）→ ② 摘内存镜像
  //   → ③ 真删服务端实体（serverPutKey(key, undefined)·value 缺失=devserver 删文件通道·
  //     os.remove·幂等；fire 形态·失败 warn 不静默）→ ④ 摘总表行 → ⑤ 通知（视图层照旧）。
  //   ③ 缺则服务端实体文件残留 → 下次 boot 对账按目录列举当孤儿收编 → 回收站复活（根链已钉死在案）。
  //   返回 true=确有该项目被清；不存在 id → false（幂等，不误写索引）。
  if (!id || typeof id !== "string") return false;
  const existed = !!load(id);
  const key = serverProjectKey(id);
  _dropPending(key);                    // ① 摘防抖尾窗·防实体被写回复活
  serverCachePut(key, undefined);       // ② 实体从内存镜像摘除
  _firePut(key, undefined, undefined);  // ③ 真删服务端实体（= serverPutKey(key, undefined)）
  _tombstones.add(key);                 // ③b 本页墓碑（此后本页对同键的迟到写同拦）
  persistIndexRemove(id);               // ④ 总表行删
  broadcastInvalidate([key], "purge");   // ④b 跨页失效广播（他页丢镜像 + 入他页墓碑·真删语义）
  notify({ type: "project:purge", projectId: id });   // ⑤ 通知
  return existed;
}

export function listProjects() {
  // 默认过滤已软删项目；想看回收站请调 listDeleted()（M-T2：id 清单双源合并）
  return readIndexMerged()
    .map((id) => load(id))
    .filter(Boolean)
    .filter((p) => !p.deletedAt);
}

export function listDeleted() {
  return readIndexMerged()
    .map((id) => load(id))
    .filter(Boolean)
    .filter((p) => !!p.deletedAt);
}

// ===== 序列往返 =====
export function exportJSON(project) {
  return JSON.stringify(project, stableReplacer, 2);
}

export function importJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_e) {
    return { ok: false, error: "schema_invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "schema_invalid" };
  }
  if (parsed.schemaVersion === undefined || parsed.schemaVersion === null) {
    return { ok: false, error: "schema_invalid" };
  }
  if (parsed.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: "schema_newer" };
  }
  if (parsed.schemaVersion < SCHEMA_VERSION) {
    return { ok: false, error: "schema_older_unsupported" };
  }
  if (!Array.isArray(parsed.segments)) {
    return { ok: false, error: "schema_invalid" };
  }
  return { ok: true, project: parsed };
}