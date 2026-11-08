// core/postfx.js — 历史行手动后处理 (postfx 封装 + 进度轮询).
//
// === 出处注记 (S2-2 T5 任务单) ===
// 改造基线: 引擎端点契约 api.md #61 (POST /h3_batch/postfx)
//                   + __init__.py :4254 (GET /h3_batch/postfx_status);
// 本任务新写 core 封装; 复用 api.js 归一层（已有 postfx_busy 第四态识别,
// 错误信封归一与 toast 桥自动生效）.
//
// 任务边界:
//   1. postfxRun     — 手动触发后处理 (POST /h3_batch/postfx).
//                      body 形状 = {task_id, kinds, engine_choice, sids?, output_dir?, seg_threshold?}.
//                      seg_threshold (S2-4 b8): segThreshold?: {duration_s?, frame_count?},
//                      仅当含至少一个合法键 (数字, typeof==='number' 且 finite) 时携带;
//                      未知键忽略; 非数字值跳过 (浏览器数字输入约束丢弃非数字→按留空=自动; 引擎 400 为拒绝通道).
//                      错误码: 400 stamped_already / 无可处理段 / kinds 非法 / task_id 缺 /
//                             task 在 trash / 模板缺失 / seg_threshold 非法;
//                             404 manifest 不存在; 409 active_busy / finalizing_busy /
//                             concat_busy / postfx_busy; 500 内部异常.
//                      错误透传口径: r.error.msg / r.error.code 原样回灌, 不重写不吞.
//   2. postfxStatus  — 进度轮询 (GET /h3_batch/postfx_status).
//                      契约: 空闲 → {ok:true, running:false, current:null};
//                            运行中 → {ok:true, running:true, current:{task_id, kinds, total, time_start}}.
//                      注意: 当前实现仅两态, 无 done/failed 进度字段 (引擎源码注释明写
//                            "本期不实装"). GUI 轮询判定 = running=true → "后处理中…";
//                            running=false → "完成" (不允许发明失败态轮询文案).
//
// ESM 依赖链 (单向):
//   - ./api.js : request (归一层, 含 postfx_busy 第四态分类).
//   - ./timeouts.js : TIMEOUTS (全仓 HTTP 超时集中表·批2 #57 档2).
//   - ./browse.js : listDirectory / joinPath (§5 verifyPostfxFinal 存在性验证复用·零改动).
//   - ./filekey.js : normFileKey (§5 清单判等归一).
//   - 不反向 import views/components.

import { request } from "./api.js";
import { TIMEOUTS } from "./timeouts.js";
import { listDirectory, joinPath } from "./browse.js";
import { normFileKey } from "./filekey.js";

// ============================================================================
// 1. postfxRun — 手动触发后处理
// ============================================================================
//
// 入参:
//   taskId        — str, 必填
//   kinds         — list[str], 必填 (["upscale","interp"] 子集, 后端 400 兜底校验)
//   engineChoice  — str, "seedvr2" (默认) | "rtxvsr"
//   sids          — list[str], 可选 (过滤段; 缺省 = 全 success 段)
//   outputDir     — str, 可选 (不传则使用引擎默认)
//   segThreshold  — {duration_s?: number, frame_count?: number}, 可选
//                   仅含至少一个合法键时携带; 未知键忽略; 非数字值跳过
//                   (浏览器层自动丢弃非数字·等同留空=自动, 此处仅形态兜底)
//   upscaleParams — {mode:"scale",scale:number} | {mode:"target",width:int,height:int}, 可选
//                   形态不合法则该键不发; 缺省 = 引擎默认输出参数 (零变化)
//   interpParams  — {target_fps:number}, 可选; 非数字则该键不发; 缺省 = 引擎默认 48fps
//   judgment      — "manifest", 可选 (G4 #50-3: 编排层防重能力字段·引擎 E7 gating;
//                    仅该值写入 body, 不传/他值不发键 = 旧判据)
//
// 出参 (归一):
//   ok=true   → {ok, started, taskId, kinds, engineChoice, sids, raw}
//   ok=false  → {ok:false, error, raw}
//
// 注: 不在本函数层前置拦截 kinds/engine_choice 形态; 业务层 (edit.js 三选/二选)
// 已固化存储值, 形态必合法. 后端 400 透传即可.

export async function postfxRun(opts) {
  const taskId = opts.taskId || "";
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : [];
  const engineChoice = opts.engineChoice || "seedvr2";
  const sids = Array.isArray(opts.sids) ? opts.sids : null;
  const outputDir = opts.outputDir || "";

  const body = { task_id: taskId, kinds, engine_choice: engineChoice };
  if (sids && sids.length) body.sids = sids;
  if (outputDir) body.output_dir = outputDir;
  // G4 #50-3: 幂等判据能力字段（引擎 E7 X5 gating）——值只认 "manifest"（带=引擎按
  // manifest._postfx 现值判防重；不带/他值=旧文件名判据·GUI1.3 手动通道零回归）。
  if (opts.judgment === "manifest") body.judgment = "manifest";
  // 长片分段阈值 (S2-4 b8): 仅当 segThreshold 含至少一个合法键时携带
  // 引擎契约 postfx_engine.py:407-424: 键 ∈ {"duration_s","frame_count"}, 值数字 (bool 不算)
  // 非白名单键忽略; 非数字值跳过 (浏览器层自动丢弃非数字·等同留空=自动, 此处仅形态兜底)
  if (opts.segThreshold && typeof opts.segThreshold === "object") {
    const seg = {};
    for (const k of ["duration_s", "frame_count"]) {
      const v = opts.segThreshold[k];
      if (typeof v === "number" && Number.isFinite(v)) seg[k] = v;
    }
    if (Object.keys(seg).length) body.seg_threshold = seg;
  }
  // M6b-T3 R-50: 超分输出参数 (可选·缺省不发=零变化)
  // 引擎契约: {mode:"scale",scale} | {mode:"target",width,height} (成对·整数)
  // 分档校验 (RTX [1,4] / SeedVR2 (0,8]) 与 W/H 范围 [64,8192] 归引擎 400 兜底,
  // 此处仅做形态白名单——同 segThreshold 先例, 防前端造出引擎不认的形态。
  if (opts.upscaleParams && typeof opts.upscaleParams === "object") {
    const u = opts.upscaleParams;
    if (u.mode === "scale" && typeof u.scale === "number" && Number.isFinite(u.scale)) {
      body.upscale_params = { mode: "scale", scale: u.scale };
    } else if (u.mode === "target"
               && Number.isInteger(u.width) && Number.isInteger(u.height)) {
      body.upscale_params = { mode: "target", width: u.width, height: u.height };
    }
  }
  // M6b-T3 R-50: 插帧输出参数 (可选·缺省不发=零变化)
  // 引擎契约: {target_fps:F}·F∈[12,120]; 实际倍率 M=round(F/源fps) 由引擎换算·GUI 不预知
  if (opts.interpParams && typeof opts.interpParams === "object") {
    const f = opts.interpParams.target_fps;
    if (typeof f === "number" && Number.isFinite(f)) body.interp_params = { target_fps: f };
  }

  // 批2 #57 档2: 受理拍显式引集中超时表 (原无 timeoutMs·吃 30s 默认·改引不改值)
  const r = await request("/h3_batch/postfx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUTS.default,
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    started: !!data.started,
    taskId: data.task_id || taskId,
    kinds: Array.isArray(data.kinds) ? data.kinds : kinds,
    engineChoice,
    sids: sids || null,
    raw: data,
  };
}

// ============================================================================
// 2. postfxStatus — 进度轮询
// ============================================================================
//
// 入参: 无 (GET 端点无 query; 当前 task 由服务端 _postfx_running 单例状态承载).
//
// 出参 (归一):
//   ok=true   → {ok, running, current: {task_id, kinds, total, time_start} | null, raw}
//   ok=false  → {ok:false, error, raw}
//
// 视图层据此渲染两态:
//   running=true  → "后处理中…"
//   running=false → "完成" (不允许发明 "失败" 文案; 详情由 manifest._postfx 呈现, 归 T6)

// ============================================================================
// 4. 段级右键通道的纯函数 (S2-2 T2+T11 — §0.2 兑现)
// ============================================================================
//
// 出处钉死:
//   - 引擎 sid 语义: V1.14 __init__.py:3924 "sids_param = body.get('sids')"
//                    → list[str], 段 ID 集合 (e.g. "shot_001")
//                    → __init__.py:3929-3932 若 sids_param 为 list[str] 全合格
//                       则 sids_filter = set(sids_param), 否则 None (全 success)
//   - 引擎白名单 engine_choice: api.md:1353 "seedvr2"(默认)|rtxvsr"
//   - GUI 侧段级 sid 字段: edit.js:1283 applyHistory 从 shotsObj 写入 clip.sid
//                          (历史载入片段带 sid; 新建/粘贴片段无 sid, 见 edit.js:830/794)
//
// 设计: 三纯函数输入输出显式, 不读 DOM 不引全局 — 便于单测直拍.
//   resolveKindPreset     "upscale"|"interp" → kinds 数组 (弹窗预选用)
//   translateSrMode       "quick"|"seedvr" → engine_choice (弹窗预选用)
//                          S1-4 已锁直译: quick→rtxvsr / seedvr→seedvr2
//                          兜底→"seedvr2" (引擎缺省值对齐)
//   resolveEngineSid      clip 对象 → 引擎 sid 或 null
//                          仅当 clip.sid 非空字符串时返回; 用于 sids 单段参数.

// "upscale" | "interp" → ["upscale"] | ["interp"]
// 其它值兜底返回 ["upscale"] (引擎允许, 业务层不预选插帧以避免越权).
export function resolveKindPreset(action) {
  return action === "interp" ? ["interp"] : ["upscale"];
}

// "quick" | "seedvr" → "rtxvsr" | "seedvr2"
// 兜底 (含 undefined / 缺省 / 脏值) → "seedvr2" (与引擎缺省一致)
export function translateSrMode(srMode) {
  return srMode === "quick" ? "rtxvsr" : "seedvr2";
}

// 提取段级引擎 sid — 仅当 clip.sid 非空字符串时返回; 缺/非串 → null
//   新建/粘贴片段无 sid (edit.js:794/830) — 右键入口调用前应先用 es()/project
//   校验, 此函数只做形态兜底, 不做业务语义拦截 (免耦合 store).
export function resolveEngineSid(clip) {
  if (!clip || typeof clip !== "object") return null;
  const sid = clip.sid;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

export async function postfxStatus() {
  const r = await request("/h3_batch/postfx_status", { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  const running = !!data.running;
  const current = (running && data.current && typeof data.current === "object") ? {
    taskId: data.current.task_id || "",
    kinds: Array.isArray(data.current.kinds) ? data.current.kinds : [],
    total: typeof data.current.total === "number" ? data.current.total : 0,
    timeStart: data.current.time_start != null ? data.current.time_start : null,
  } : null;
  return { ok: true, running, current, raw: data };
}

// ============================================================================
// 3. composeBadge — 徽标合成纯函数 (S2-2 T6)
// ============================================================================
//
// 通道定案 (D6): history 项 postfx_badge 字段 + postfx_status 轮询 = 实时态优先.
//
// 四态 (字面量来源 — 引擎 __init__.py :5151/5151/5153/5155):
//   "后处理成功"     → state=success   (severity=ok)
//   "后处理成功⚠"   → state=fallback  (severity=warn — 有 fallback 标记的成功)
//   "后处理失败"     → state=failed    (severity=bad)
//   "后处理中"       → state=running   (severity=run)
//   null / 缺        → state=none      (前端折叠行隐藏徽标)
//
// 优先级:
//   1. statusResult.running && current.taskId === taskId → running (实时态优先)
//   2. historyBadge 字面量映射 (引擎派生字段, 端点 /h3_batch/history 直出)
//
// 出参: {state, label, severity}
//   severity 供视图层选样式类 (复用 segcell ok/run/bad/warn 调色板).
//
// 注: 本函数为同步纯函数, 不发起请求 — 调用方负责取 statusResult.

export function composeBadge(opts) {
  const o = opts || {};
  const historyBadge = o.historyBadge;
  const statusResult = o.statusResult;
  const taskId = o.taskId || "";

  // 实时态优先: postfx_status running + taskId 匹配 → running
  if (statusResult && statusResult.ok && statusResult.running
      && statusResult.current && statusResult.current.taskId
      && statusResult.current.taskId === taskId) {
    return { state: "running", label: "后处理中", severity: "run" };
  }
  // 历史 badge 字面量映射
  if (historyBadge === "后处理成功") return { state: "success", label: "后处理成功", severity: "ok" };
  if (historyBadge === "后处理成功⚠") return { state: "fallback", label: "后处理成功⚠", severity: "warn" };
  if (historyBadge === "后处理失败") return { state: "failed", label: "后处理失败", severity: "bad" };
  if (historyBadge === "后处理中") return { state: "running", label: "后处理中", severity: "run" };
  return { state: "none", label: "", severity: null };
}

// ============================================================================
// 5. 最终版解析器 — 纯函数层 (R56R57-S3 适配 T2)
// ============================================================================
//
// 引擎契约 (只读移植·V1.14 postfx_engine.py 引擎仓零改):
//   - 戳命名 :29-71   _KIND_STAMPS 缺省 _x2 / _48fps; _num_str 去尾零 (2.0→"2"·2.5→"2.5");
//                     target 模式 → _{min(W,H)}p; X5 has_stamp_token "_" 切词整词相等
//                     (_x2.5 不误命中 _x2)。
//   - 产物布局 :722-795  原件在 run_dir 根; 超分产物 = run_dir\upscaled\<茎><超分戳><原扩展名>;
//                     插帧产物 = run_dir\interp\<茎>[<超分戳>]<插帧戳><原扩展名>
//                     (链式 <超分戳> 仅在实际请求 upscale 时出现; interp 单开无超分戳 —
//                     真机实证 2026-10-15, 见 postfxExpectedPaths 注)。
//   - 产物名计数尾 :237-260  SaveVideo filename_prefix 为前缀语义, 实际产物 =
//                     <期望基础名>_00001_.mp4 (首件计数·撞名递增 _00002_) —
//                     匹配按「期望基础名为前缀·余部空或 _N+ 计数尾」双形态兼容。
//
// 参数形态与 postfxRun 既有 opts 同形: {upscaleParams?, interpParams?} — 键存在即视为该 kind
// 被请求 (T3 编排一处构造、postfxRun 与本解析器两处复用); 非法形态抛错 = 引擎 ValueError
// 同源 (postfxRun 边界已做形态过滤, 此处不静默兜底)。
// 本节除 verifyPostfxFinal 外全部为同步纯函数: 零请求零 DOM; 存在性验证走既有 browse 通道
// (listDirectory = core/rename_heal.js 同源函数, 只复用不改动)。

const _UP_TOKEN_RE = /^x\d+(?:\.\d+)?$/;    // 超分戳 token (去前导 "_" 后)
const _IP_TOKEN_RE = /^\d+(?:\.\d+)?fps$/;  // 插帧戳 token (去前导 "_" 后)

// _num_str 移植: 数字 → 戳串 (JS String 本就无尾零: 2→"2"·2.5→"2.5")。
// 引擎对 ±Inf/NaN 会产出 "inf"/"nan" 戳; GUI 层调用点先做有限数校验 (postfxRun 同款口径)。
function _numStr(v) {
  return String(Number(v));
}

// 超分戳: {mode:"scale",scale} → "_x{scale}" / {mode:"target",width,height} → "_{min(W,H)}p"
//         (Python "%d" 截断语义 → Math.trunc) / 无参 → 缺省 "_x2" (旧值逐字节不变)
export function upscaleStamp(params) {
  if (!params || !Object.keys(params).length) return "_x2";
  if (params.mode === "scale"
      && typeof params.scale === "number" && Number.isFinite(params.scale)) {
    return "_x" + _numStr(params.scale);
  }
  if (params.mode === "target"
      && typeof params.width === "number" && Number.isFinite(params.width)
      && typeof params.height === "number" && Number.isFinite(params.height)) {
    return "_" + Math.trunc(Math.min(params.width, params.height)) + "p";
  }
  throw new Error("postfx upscale 参数形态非法: " + JSON.stringify(params));
}

// 插帧戳: {target_fps} → "_{fps}fps" (去尾零) / 无参 → 缺省 "_48fps"
export function interpStamp(params) {
  if (!params || !Object.keys(params).length) return "_48fps";
  if (typeof params.target_fps === "number" && Number.isFinite(params.target_fps)) {
    return "_" + _numStr(params.target_fps) + "fps";
  }
  throw new Error("postfx interp 参数形态非法: " + JSON.stringify(params));
}

// X5 戳命中判定移植 (postfx_engine.py:67-71): stamp 去前导 "_" 后按 "_" 切词整词相等。
export function hasStampToken(stem, stamp) {
  if (typeof stamp !== "string" || !stamp) return false;
  const token = stamp.startsWith("_") ? stamp.slice(1) : stamp;
  return String(stem == null ? "" : stem).split("_").includes(token);
}

// run_dir 推导: 原产物在 run_dir 根 → 其目录即 run_dir;
// 已在 upscaled/interp 子目录 (重定向入参=既存产物) → 取其目录的父。
// 正斜杠归一反斜杠 (引擎 Windows 规约·同 browse.joinPath)。
export function postfxRunDir(p) {
  const s = String(p == null ? "" : p).replace(/\//g, "\\");
  const i = s.lastIndexOf("\\");
  if (i < 0) return "";
  const dir = s.slice(0, i);
  const j = dir.lastIndexOf("\\");
  const leaf = dir.slice(j + 1).toLowerCase();
  if (leaf !== "upscaled" && leaf !== "interp") return dir;
  return j < 0 ? dir : dir.slice(0, j);
}

// "D:\a\b\c.mp4" → { base:"c.mp4", stem:"c", ext:".mp4" } (末个 "." 切分·同 os.path.splitext)
function _splitName(p) {
  const s = String(p == null ? "" : p);
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  const base = i < 0 ? s : s.slice(i + 1);
  const dot = base.lastIndexOf(".");
  return { base, stem: dot < 0 ? base : base.slice(0, dot), ext: dot < 0 ? "" : base.slice(dot) };
}

// 期望产物路径组装: 原扩展名保留 (引擎 postfx_output_name 的 stem+stamp+ext 语义)。
//   返回 {upscale, interp} — 未请求的 kind 为 null。
//   返回值为基础名形态 = 前缀语义 (引擎 SaveVideo filename_prefix, postfx_engine.py:237-260):
//   真实产物 = <本函数返回名去扩展名>_00001_.mp4 (首件计数·撞名递增 _00002_), 匹配层见 _matchExpectedEntry。
//   插帧链名仅在实际请求 upscale 时含超分戳 (链式 <茎><超分戳><插帧戳>); interp 单开 = <茎><插帧戳>
//   (真机实证 2026-10-15: interp 单开产物 s001_1804160960_00001__48fps_00001_.mp4 — 无缺省 _x2,
//   T2 旧平公式 "缺 upscaleParams 补 _x2" 与真机不符, 本笔修正)。
export function postfxExpectedPaths(origFile, params) {
  const p = params && typeof params === "object" ? params : {};
  const hasUp = p.upscaleParams != null;
  const hasIp = p.interpParams != null;
  const { stem, ext } = _splitName(origFile);
  const runDir = postfxRunDir(origFile);
  const up = hasUp ? upscaleStamp(p.upscaleParams) : null;
  const ip = hasIp ? interpStamp(p.interpParams) : null;
  return {
    upscale: up ? runDir + "\\upscaled\\" + stem + up + ext : null,
    interp: ip ? runDir + "\\interp\\" + stem + (up || "") + ip + ext : null,
  };
}

// 清单归一: 字符串数组 | Map (键=路径) → 字符串数组; 其它形态 → 空 (解析器回退 none)。
function _listingPaths(listing) {
  if (Array.isArray(listing)) return listing.filter((x) => typeof x === "string" && x);
  if (listing && typeof listing.keys === "function") {
    const out = [];
    for (const k of listing.keys()) if (typeof k === "string" && k) out.push(k);
    return out;
  }
  return [];
}

// 计数尾/计数 token (引擎 SaveVideo 首件计数·撞名递增: <前缀>_00001_.mp4 / _00002_,
// postfx_engine.py:237-260): 尾部 `_N`/`_N_` (N 一位或多数字); 无参模式词位纯数字。
const _COUNT_TAIL_RE = /^_\d+_?$/;
const _COUNT_TOK_RE = /^\d+$/;

// 有参匹配 (normFileKey 归一前缀匹配): 前缀=期望路径去扩展名, 条目同扩展名且
// 余部为空 (无计数旧形态·整名命中·返回期望路径·既有口径) 或计数尾 _N+ (真实形态·
// 返回清单真名 — 理想路径磁盘上不存在, 调用方播放/导出须真实路径)。
function _matchExpectedEntry(expectedPath, entries) {
  const key = normFileKey(expectedPath);
  const dot = key.lastIndexOf(".");
  const stem = dot < 0 ? key : key.slice(0, dot);
  const ext = dot < 0 ? "" : key.slice(dot);
  for (const path of entries) {
    const t = normFileKey(path);
    if (!t.startsWith(stem) || !t.endsWith(ext)) continue;
    const mid = ext ? t.slice(stem.length, t.length - ext.length) : t.slice(stem.length);
    if (mid === "") return expectedPath;
    if (_COUNT_TAIL_RE.test(mid)) return path;
  }
  return null;
}

// 无参模式: 茎前缀 + 戳 token 整词匹配 (X5 "_" 切词语义·前缀陷阱茎被 token 正则天然排除);
// token 序列 = 戳 token (x2 / 2.5 / 48fps) 加可选计数 token (纯数字·引擎首件/递增计数),
// 纯计数 token 不单独成级 (全计数的 <茎>_00001_.mp4 不是任何 postfx 产物);
// 层级 interp > upscale, 同级多命中取戳链最长 (interp 恒含超分戳故更长·只比戳不比计数)。
function _matchStemProducts(origFile, entries) {
  const { base, stem, ext } = _splitName(origFile);
  if (!stem) return null;
  let best = null;
  for (const path of entries) {
    const b = _splitName(path).base;
    if (!b.startsWith(stem) || !b.endsWith(ext)) continue;
    const mid = ext ? b.slice(stem.length, b.length - ext.length) : b.slice(stem.length);
    if (!mid.startsWith("_")) continue;
    // 计数尾收尾 "_" 剥除后再切词 (<茎>_x2_00001_ → 词序 [x2·00001]·无收尾空 token)
    const words = (mid.endsWith("_") ? mid.slice(1, -1) : mid.slice(1)).split("_");
    const stamps = [];
    let ok = true;
    for (const w of words) {
      if (_UP_TOKEN_RE.test(w) || _IP_TOKEN_RE.test(w)) stamps.push(w);
      else if (!_COUNT_TOK_RE.test(w)) { ok = false; break; }
    }
    if (!ok || !stamps.length) continue;
    const level = stamps.some((w) => _IP_TOKEN_RE.test(w)) ? "interp" : "upscale";
    const chain = stamps.join("_");
    if (!best
        || (level === "interp" && best.level !== "interp")
        || (level === best.level && chain.length > best.chain.length)) {
      best = { level, file: path, chain };
    }
  }
  return best;
}

// 最终版解析: (原产物路径, 参数?, 清单?) → {level:"interp"|"upscale"|"none", file}
//   - 有参 + 有清单: 期望路径归一化前缀匹配 (空余部=旧整名形态返期望路径; 计数尾 _N+=
//     引擎真实形态返清单真名); 层级 interp > upscale > none (none = 原产物)。
//   - 有参 + 无清单: 返回期望终版路径与层级 (供调用方后续验存在; 本函数不发请求)。
//   - 无参: 须有清单走茎前缀匹配; 无清单无从推导 → none/原产物。
export function resolvePostfxFinal(origFile, params, listing) {
  const o = String(origFile == null ? "" : origFile);
  const paths = postfxExpectedPaths(o, params);
  if (!listing) {
    if (paths.interp) return { level: "interp", file: paths.interp };
    if (paths.upscale) return { level: "upscale", file: paths.upscale };
    return { level: "none", file: o };
  }
  const entries = _listingPaths(listing);
  if (paths.interp || paths.upscale) {
    if (paths.interp) {
      const hit = _matchExpectedEntry(paths.interp, entries);
      if (hit) return { level: "interp", file: hit };
    }
    if (paths.upscale) {
      const hit = _matchExpectedEntry(paths.upscale, entries);
      if (hit) return { level: "upscale", file: hit };
    }
    return { level: "none", file: o };
  }
  const m = _matchStemProducts(o, entries);
  return m ? { level: m.level, file: m.file } : { level: "none", file: o };
}

// 存在性验证辅助 (异步): 经既有 browse 通道列 run_dir\upscaled 与 run_dir\interp
// (listDirectory = rename_heal 同源函数, 只复用不改动), 组装绝对路径清单后走同一解析器。
// 单目录 browse 失败/缺目录 → 该目录零贡献 (由解析器层回退 upscale/none), 不抛错。
export async function verifyPostfxFinal(origFile, params) {
  const runDir = postfxRunDir(origFile);
  const subs = await Promise.all([
    listDirectory(joinPath(runDir, "upscaled")),
    listDirectory(joinPath(runDir, "interp")),
  ]);
  const listing = [];
  for (const r of subs) {
    if (!r.ok || !r.path) continue;
    for (const n of r.files) listing.push(joinPath(r.path, n));
  }
  return resolvePostfxFinal(origFile, params, listing);
}
