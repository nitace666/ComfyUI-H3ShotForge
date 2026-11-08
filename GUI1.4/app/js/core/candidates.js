// core/candidates.js — E2 段级多候选域层（B7-T3 · api.md #58/#59/#60）
//
// === 出处注记（B7-T3 迁移纪律）===
// 改造自 legacy/app/js/domain/candidates.js（140 行）；
// 改造点 = ①import ../core/api.js → ./api.js（新信封 request）
//        ②#60 轮询循环随域层内聚（legacy 在弹层实现·本版 pollCandidateRuns 收口）
//        ③legacy history 视图耦合的弹层逻辑不迁（新栈归 views/edit.js 接线）。
//
// === 引擎契约（api.md 实读 :1375-1460）===
//   #58 POST /h3_batch/seg_candidates body {task_id, sid, count(2-5·bool 拒)}（可选 base/output_dir）
//      异步：响应即返 {ok, started, group:"cand_<ts>", estimate_seconds}（= count×elapsed·无则 null）；
//      后台逐条渲染，第 i 条失败不中断。
//   #59 POST /h3_batch/candidate_decide body {task_id, sid, seq(int), action:"accept"|"discard"}
//      accept = 磁盘交换 + 整片重拼（幂等·目标已现行 no-op 成功），响应含 current_file；
//      discard = 账本条目 discarded=true（文件不动）；discard 现行/已采纳 → 400；
//      decide 互斥 → 409 decide_busy。
//   #60 GET /h3_batch/candidate_runs?task_id=&group= → {ok, found, done, seqs, failed, ...}
//      主判据：无组记录（found:false）或 done!=true = 进行中；done 恒 true（终态才落记录）。
//
// ESM 依赖链（单向）: ./api.js request（归一层）+ ./rename_heal.js（第 5 节动过条目自愈）
//   + ../store/store.js（仅第 5 节 rebuildAltClipsInProject 读写 altClips）。不反向 import views。

import { request } from "./api.js";
import { healRenamedFiles } from "./rename_heal.js";
import { normFileKey } from "./filekey.js";
import { load as storeLoad, updateEditingState } from "../store/store.js";

// ============================================================================
// 1. 轮询常量（3s 间隔 / 墙钟 20min 绝对截止）
// ============================================================================
export const CANDIDATE_POLL_MS = 3000;
export const CANDIDATE_POLL_TIMEOUT_MS = 20 * 60 * 1000;

// ============================================================================
// 2. count 校验 + 文案
// ============================================================================

// count 校验: 整数且 2-5 → 返回数值; 否则 null. bool 一律拒（引擎口径: true/false 是
// int 子类不做特例放行 —— Number(true)=1 / Number(false)=0 均越界, 天然拒绝）.
export function validateCount(n) {
  const v = Number(n);
  return (Number.isInteger(v) && v >= 2 && v <= 5) ? v : null;
}

// estimate_seconds → 「预计约 X 分 Y 秒（未计入一次整片重拼）」; null/缺键 → 暂无估计.
export function estimateText(estimateSeconds) {
  if (estimateSeconds == null) return "暂无历史耗时估计";
  const s = Math.round(Number(estimateSeconds));
  const mm = Math.floor(s / 60), ss = s % 60;
  return "预计约 " + (mm > 0 ? mm + " 分 " + ss + " 秒" : ss + " 秒") + "（未计入一次整片重拼）";
}

// 提交前明示倍率 — 常显于弹层, 随 count 选择更新.
export function buildLaunchText(count) {
  return "生成 " + count + " 个候选，约 " + count + " 倍单段渲染量；候选逐个渲染。";
}

// ============================================================================
// 3. #58 发起 / #60 轮询读 / #59 采纳·废弃
// ============================================================================

// 发起多候选（异步）: outputDir 非空才带 output_dir（rerun.js:43 同款先例）.
export async function submitCandidates(taskId, sid, count, outputDir = "") {
  const body = { task_id: taskId, sid, count };
  if (outputDir) body.output_dir = outputDir;
  const r = await request("/h3_batch/seg_candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    started: !!data.started,
    group: data.group || "",
    estimateSeconds: (data.estimate_seconds !== undefined) ? data.estimate_seconds : null,
    raw: data,
  };
}

// 组进度轮询读: 禁缓存（no-store）—— 读到缓存旧终态会假完成.
export async function fetchCandidateRuns(taskId, group, outputDir = "") {
  const qs = new URLSearchParams({ task_id: taskId, group });
  if (outputDir) qs.set("output_dir", outputDir);
  const r = await request("/h3_batch/candidate_runs?" + qs.toString(), { cache: "no-store" });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    found: !!data.found,
    done: data.done === true,
    seqs: Array.isArray(data.seqs) ? data.seqs : [],
    failed: Number(data.failed) || 0,
    raw: data,
  };
}

// #59 采纳/废弃: accept 响应 current_file 解包（discard 无该键 → null）.
export async function decideCandidate(taskId, sid, seq, action, outputDir = "") {
  const body = { task_id: taskId, sid, seq, action };
  if (outputDir) body.output_dir = outputDir;
  const r = await request("/h3_batch/candidate_decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: r.error, raw: r.data };
  const data = r.data || {};
  return {
    ok: true,
    action: data.action || action,
    seq: data.seq != null ? data.seq : seq,
    currentFile: (typeof data.current_file === "string") ? data.current_file : null,
    raw: data,
  };
}

// ============================================================================
// 4. #60 响应 → 阶段态映射（无记录 = 进行中·主判据）
// ============================================================================

// {found, done, seqs, failed} → {mode:"phase", phaseText, stop}
//   !found || done!==true → 生成中（不停）; done=true 且 okN=0&&failN>0 → 全部失败（停）;
//   done=true 其余 → 完成 N 个（失败 M）（停）.
export function mapRunsData(data) {
  const d = data || {};
  if (!d.found || d.done !== true) return { mode: "phase", phaseText: "生成中", stop: false };
  const okN = Array.isArray(d.seqs) ? d.seqs.length : 0, failN = Number(d.failed) || 0;
  if (okN === 0 && failN > 0) return { mode: "phase", phaseText: "全部失败（" + failN + " 个）", stop: true };
  return { mode: "phase", phaseText: "完成 " + okN + " 个（失败 " + failN + "）", stop: true };
}

// ============================================================================
// 5. 轮询循环（3s / 墙钟 20min 绝对截止·毫秒级真定时器可注入）
// ============================================================================
//
// 墙钟口径: Date.now()-startedAtMs >= timeoutMs 即超时（主判据·每拍请求前查）;
//   超时 ≠ 终态 —— onTimeout 收口停轮询, 引擎后台继续跑。
// 同步返回 {stop()}; 终态/超时自动停。网络/HTTP 错 → onError（不停·下拍续轮）。

export function pollCandidateRuns(opts) {
  const taskId = opts.taskId;
  const group = opts.group;
  const outputDir = opts.outputDir || "";
  const intervalMs = (typeof opts.intervalMs === "number" && opts.intervalMs > 0) ? opts.intervalMs : CANDIDATE_POLL_MS;
  const timeoutMs = (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) ? opts.timeoutMs : CANDIDATE_POLL_TIMEOUT_MS;
  const onTick = opts.onTick || (() => {});
  const onFinal = opts.onFinal || (() => {});
  const onError = opts.onError || (() => {});
  const onTimeout = opts.onTimeout || (() => {});
  const startedAtMs = (typeof opts.startedAtMs === "number" && opts.startedAtMs > 0) ? opts.startedAtMs : Date.now();

  let timer = null;
  let stopped = false;
  let finished = false;

  function stop() {
    stopped = true;
    if (timer != null) { clearTimeout(timer); timer = null; }
  }

  async function tick() {
    if (stopped || finished) return;
    if (Date.now() - startedAtMs >= timeoutMs) {
      finished = true;
      onTimeout();
      return;
    }
    const r = await fetchCandidateRuns(taskId, group, outputDir);
    if (stopped || finished) return;
    if (!r.ok) {
      onError(r.error);
    } else {
      onTick(r);
      if (mapRunsData(r).stop) {
        finished = true;
        onFinal(r);
        return;
      }
    }
    timer = setTimeout(tick, intervalMs);
    // Node 单测: 轮询定时器不吊测试进程（浏览器 setTimeout 无 unref, guard 后不影响真机）
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  tick();
  return { stop };
}

// ============================================================================
// 6. decide 结果分类 + discard 400 分因文案
// ============================================================================

// accept 结果核对链分类（五态·判据顺序固定）:
//   ① !httpOk → unknown; ② wasCurrent → noop（幂等·已是现行）;
//   ③ 现行文件已切换（curShotAfter.files[0]===targetFile）+ accepted_seq 对 + 账本
//     变化含 success → updated; ④ after===before 或未切换 → pending;
//   ⑤ after 含 failed/skipped → failed; 其余（缺证）→ pending（不判 failed）.
//   before/after 均为对象或 null（内部各 stringify 一次）。
export function classifyDecideResult(opts) {
  const o = opts || {};
  if (!o.httpOk) return { state: "unknown", text: "结果待确认，可刷新查看" };
  if (o.wasCurrent) return { state: "noop", text: "该版本已是现行版本" };
  const cur = o.curShotAfter || {};
  const fileSwitched = Array.isArray(cur.files) && cur.files[0] === o.targetFile;
  const seqOk = cur.accepted_seq === o.seq;
  const b = JSON.stringify(o.before != null ? o.before : null);
  const a = JSON.stringify(o.after != null ? o.after : null);
  if (a !== b && /"status"\s*:\s*"success"/.test(a) && fileSwitched && seqOk) {
    return { state: "updated", text: "成片已更新" };
  }
  if (a === b || !fileSwitched) return { state: "pending", text: "成片待确认（可手动合并）" };
  if (/"status"\s*:\s*"failed"/.test(a) || /"status"\s*:\s*"skipped"/.test(a)) {
    return { state: "failed", text: "重拼失败/跳过（可手动合并）" };
  }
  return { state: "pending", text: "成片待确认（可手动合并）" };
}

// discard 400 分因: 错误文案含「现行/已采纳」→ 友好文案; 其他 → 原文.
//   关键词扫描覆盖 msg/detail/code（引擎信封经 api.js 冒号归一后关键词可能落任一桶）.
export function discardErrorText(err) {
  const e = err || {};
  const msg = e.msg != null ? String(e.msg) : "";
  const detail = e.detail != null ? String(e.detail) : "";
  const code = e.code != null ? String(e.code) : "";
  const raw = msg + "\n" + detail + "\n" + code;
  if (raw.indexOf("现行") !== -1 || raw.indexOf("已采纳") !== -1) {
    return "该版本为现行版本，不能废弃";
  }
  return "废弃失败: " + (msg || code || "未知");
}

// ============================================================================
// 5. rebuildAltClips（批 B T5 → R53-P3·v3 定案）: 备选轨 _reruns 系「cid 身份+影子比对合并制」
// ============================================================================
//
// 口径（方案 v3 §P3·治 bug3: 整组替换抹掉本地对调态与本地裁决标记）:
//   收集: detail._reruns 按 sid 过滤（rr.sids 含该 sid 即命中·**全量映射**不再只取 [0]）
//         → 每 sid 按引擎 seq 降序·幂等键 sid+seq 去重 → 条目 {kind:"rerun", cid, segId, sid,
//         n, seq, taskId, dur/full 取**本段** clip 或 shot 时长, triml:0, file, ver}
//   身份（AC1）: 同 (sid,seq) 前身匹配沿 cid（前身匹配限 rerun 系·老数据无 kind 视为 rerun）；
//         新条目才生成新 cid；账本无对应行的本地条目为孤儿——原样保全
//   影子比对（AC2·节点门 A 审 DEFECT-1 修正）: 「动过」判据 pinned 标记优先（edit.js 对调落
//         {file:现持 file}——引擎 _keep_old 正名复用下对调持有的原版与账本推导值恒同茎·纯茎
//         比对判不出对调），pinned 在 = 动过 → file/ver 保本地；无 pinned 存量数据走茎比对
//         兜底: 本地 file 与账本推导值同「茎」（basename 去 .mp4 去 _old_NN 改名后缀）= 未动
//         → file 随账本刷新（引擎内存账本跟改名改写 files 指针·改名跟随保活）；茎异 = 动过
//         （对调持有原版/他条文件）→ file/ver 保本地；其持有文件可能被引擎改名
//         → 经 opts.healTargets 收集 {entry, runDir}，由 rebuildAltClipsInProject 统一
//         healRenamedFiles 自愈（applyHistory 直调本函数的同步路径不收集——发起时自愈覆盖）
//   label 冻结（AC3·I2-2）: 合并不追加/不改写既有条目 label；本地 discarded/accepted 优先
//         （引擎账本标记不回写既有条目），引擎 discarded 仅用于新条目初始态（state warn+注记）
//   上限（呈报3）: REBUILD_PER_SID=4——超出从最旧端挤「未动」条目，动过条目排除在挤出对象外
//         （全动过 → 软上限不硬挤·条数不减）；孤儿条目视同动过受保护
//   共存: 候选组系（kind:"cand"·多候选弹层落轨）**保留不动**（#23 R4 不参与去重）；
//         retired 系（✓ 采纳后的旧版）file 被保留槽代表则清源删除、无代表保留（#23 R3——
//         它们的文件不在 _reruns 账本里，抹掉即真丢）
//   #23 一层去重（老板 2026-10-15 口径·每段每代恰一块）: 合并循环尾部（挤出前）按归一绝对
//         路径（normFileKey·禁按茎）分桶留一——去留优先级 账本正主>pinned>数组序最旧（R2），
//         裁决① ver 错标窄门校正 + 裁决⑥ 被并槽 pinned 继承；kept 侧 retired 清源（R3）
//         + 裁决② gen 反查重派 + 裁决⑥ 继承。edit.js/渲染/引擎仓零改动
//   挂点: applyHistory（载入历史·直调）/ rerun_flow 终态 / syncRunProducts 回填后（后两者经
//         rebuildAltClipsInProject），双触发由幂等键去重
const REBUILD_PER_SID = 4;
// cid 形态沿用批 B T1（alt-<segId>-<ts>-<n>·同 ts 序号兜底）——本文件不依赖 views，
//   故自带一把最小实现（与 edit.js newAltCid 同形态；同函数体·不共享避免 core→views 反向依赖）。
//   ts 由调用点注入（批5-R53-TB #11·批3-T3 同款）: 批量 rebuild 须 hoist 一次读钟传同一 ts
//   （循环内逐条读钟跨毫秒 → 同批同 sid 条目 ts 互异，n 序号兜底失效 = 同批撞键风险）；单条
//   调用走默认参零影响。
function rebuildCid(segId, taken, ts = Date.now()) {
  const base = `alt-${segId || "x"}-${ts}`;
  let n = 0;
  let cid = `${base}-${n}`;
  while (taken && taken.has(cid)) { n += 1; cid = `${base}-${n}`; }
  if (taken) taken.add(cid);
  return cid;
}
const prevCids = (list) => new Set((list || []).map((c) => c && c.cid).filter(Boolean));

// 影子比对「茎」: 全路径 → basename 去 .mp4 去引擎改名后缀 _old_NN——
//   同茎 = 本地条目处于账本推导值的改名链上（未动·跟随账本）；异茎 = 对调持有的他源文件（动过）
function fileStem(p) {
  if (typeof p !== "string" || !p) return null;
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  const base = (i < 0 ? p : p.slice(i + 1)).replace(/\.mp4$/i, "").replace(/_old_\d+$/, "");
  return base || null;
}

// 账本行 → 该 sid 产物派生路径（run_dir 去尾杠 + \ + files[sid]·缺本 sid 键回落首值）
function ledgerRowFile(rr, sid) {
  if (!rr || !rr.run_dir) return null;
  const files = rr.files || {};
  const fname = files[sid] || Object.values(files)[0];
  return fname ? (String(rr.run_dir).replace(/[\/]+$/, "") + "\\" + fname) : null;
}

// 主轨各段当前 file 归一键（二期案②·主轨计代表）: sid → normFileKey(clip.file)——
//   R2/R3 的「已有代表」集合加入主轨各段当前 file: 与主轨同文件的备选槽并入删除
//   （老板「交换完就是交换完了」·推翻 R53变更20-T3 旧共存口径）。
function mainKeyBySid(clips) {
  const m = new Map();
  for (const c of Array.isArray(clips) ? clips : []) {
    if (c && c.sid && c.file) m.set(String(c.sid), normFileKey(c.file));
  }
  return m;
}

export function rebuildAltClips(prevAlts, detail, sids, opts = {}) {
  const prev = Array.isArray(prevAlts) ? prevAlts : [];
  const d = detail || {};
  const reruns = Array.isArray(d._reruns) ? d._reruns : [];
  const shots = (d.shots && typeof d.shots === "object" && !Array.isArray(d.shots)) ? d.shots : {};
  const taskId = d.task_id || d.taskId || "";
  const clips = Array.isArray(opts.clips) ? opts.clips : [];
  // 动过条目自愈收集（可选·rebuildAltClipsInProject 传入）：push {entry, runDir}
  const healTargets = Array.isArray(opts.healTargets) ? opts.healTargets : null;
  // 受影响 sid：显式传入优先·空/缺省 = 账本全量
  const affected = new Set(
    (Array.isArray(sids) && sids.length ? sids : Object.keys(shots)).map(String),
  );
  const taken = prevCids(prev);
  const now = Date.now();   // 批5-R53-TB #11: 本批同属一次批量 → hoist 一次读钟（同批共用 ts·n 顺延）
  const mainKeys = mainKeyBySid(clips);   // 二期案②: 主轨计代表（各段当前 file 归一键）
  // 本段形态: sid → 本段 clip 的 segId/dur/full·无 clip 时回落 shot 的 seg_duration_sec
  const segOf = (sid) => {
    const c = clips.find((x) => x && String(x.sid) === sid) || null;
    const shot = shots[sid] || {};
    const sd = (typeof shot.seg_duration_sec === "number" && shot.seg_duration_sec > 0) ? shot.seg_duration_sec : 0;
    return {
      segId: (c && c.segId) || `hist-${sid}`,
      dur: (c && +c.dur) || sd || 5,
      full: (c && +c.full) || (c && +c.dur) || sd || 5,
    };
  };
  // 按 sid 收集事件（rr.sids 每个 sid 都算命中）
  const bySid = new Map();
  for (const rr of reruns) {
    if (!rr || !Array.isArray(rr.sids)) continue;
    for (const raw of rr.sids) {
      const sid = String(raw);
      if (!affected.has(sid)) continue;
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid).push(rr);
    }
  }
  // 无账本行可并（bySid 空）→ 原样返回同引用（零改写·调用方免落盘——挂载收敛幂等的地基）
  if (bySid.size === 0) return prev;
  const fresh = [];
  const ledgerDepthBySid = new Map();   // sid → Map(seq→账本链深度)（校正三件套同源取深度）
  for (const [sid, list] of bySid) {
    const s = segOf(sid);
    // 本 sid 本地 rerun 系前身（同前身匹配口径·老数据无 kind 视为 rerun）按 seq 索引
    const localBySeq = new Map();
    for (const a of prev) {
      if (!a || (a.kind && a.kind !== "rerun") || String(a.sid) !== sid) continue;
      if (!localBySeq.has(a.seq)) localBySeq.set(a.seq, a);
    }
    const seen = new Set();
    const rows = list
      .slice()
      .sort((a, b) => ((b && b.seq) || 0) - ((a && a.seq) || 0))   // 新→旧
      .filter((rr) => {                                            // 幂等键 sid+seq
        const seq = (rr && rr.seq) || 0;
        if (seen.has(seq)) return false;
        seen.add(seq);
        return true;
      });
    // #24 每段各自链深度（Q8 口径「原片段第二次或重跑片段再重跑都算第二次」）:
    //   该 sid 链节点计数 = 账本行 ∪ 本地条目按 seq 升序的秩——派生/重排以深度为准，
    //   不再取账本全局 seq（B 的首次重跑=该段第1次·引擎账本 _reruns 全局 seq 零动）。
    const depthOf = new Map();
    {
      const seqs = [...new Set(rows.map((r) => (r && r.seq) || 0).concat([...localBySeq.keys()]))]
        .filter((s) => s > 0).sort((a, b) => a - b);
      seqs.forEach((s, i) => depthOf.set(s, i + 1));
    }
    // 校正用账本链深度: 该 sid 账本行 seq 升序秩（同 union 派生公式·域限账本行）——
    //   反查校正只认账本行 → 深度顺账本链数；账本行跨重建固定 ⇒ 校正值稳定（不受本地
    //   重复槽并删塌链影响·挂载幂等硬闸地基）。出厂/存量重排仍用上方 union 链深度（#24 不动）。
    const ledgerDepthOf = new Map(
      [...new Set(rows.map((r) => (r && r.seq) || 0))].filter((s) => s > 0).sort((a, b) => a - b).map((s, i) => [s, i + 1]),
    );
    ledgerDepthBySid.set(sid, ledgerDepthOf);
    const ledgerDepthOfSeq = (q) => ledgerDepthOf.get(q) || q || 1;
    const depthOfSeq = (q) => depthOf.get(q) || q || 1;
    const mainKey = mainKeys.get(sid) || null;
    // 逐行合并（影子比对）——cands/meta 平行（meta: touched/runDir 供挤出与自愈收集）
    const cands = [];
    const meta = [];
    const mergedSeqs = new Set();
    for (const rr of rows) {
      const seq = (rr && rr.seq) || 0;
      const fileLedger = ledgerRowFile(rr, sid);
      const pm = localBySeq.get(seq) || null;
      if (pm) mergedSeqs.add(seq);
      const pmStem = pm ? fileStem(pm.file) : null;
      const ledgerStem = fileLedger ? fileStem(fileLedger) : null;
      // 动过判据: pinned（对调钉住·edit.js 落标）优先，茎比对降级为无 pinned 存量数据兜底——
      //   存量正名复用场景的对调条目（同茎无标记）静默回退随账本属已知妥协（无标记不可辨别）
      const touched = !!(pm && pm.pinned) || !!(pmStem && ledgerStem && pmStem !== ledgerStem);
      const depth = depthOfSeq(seq);   // 该行在该段链上的深度（新条目 label/ver 出厂形态）
      const cand = {
        kind: "rerun",
        cid: pm && pm.cid ? pm.cid : rebuildCid(s.segId, taken, now),  // 沿用原 cid（列表身份稳定）
        segId: s.segId,
        sid,
        n: 1,
        seq,
        taskId: taskId || (pm && pm.taskId) || "",               // 补齐任务键（B-T4 徽章裁决依赖）
        label: (pm && pm.label != null) ? pm.label : `重制·第${depth}次`,  // label 冻结（仅新条目初始生成·#24 按每段深度）
        dur: s.dur,
        triml: 0,
        full: s.full,
        ver: `第${depth}次重制`,                                  // #24: 出厂按每段链深度（不再取全局 seq）
        state: "done",
        file: fileLedger,
      };
      if (pm) {
        if (touched) {                                           // 动过：file/ver 保本地
          cand.file = pm.file;
          if (pm.ver) cand.ver = pm.ver;
        }
        if (pm.pinned) cand.pinned = pm.pinned;                  // 钉住标记跨重建存续（撤销栈整态快照回滚连带清标）
        if (typeof pm.gen === "number" && pm.gen > 0) cand.gen = pm.gen;   // 用户拖轨自设代际=链记录在案（用户语义字段·跨重建存续·重排豁免凭据）
        if (pm.discarded) {                                      // 本地标记优先（引擎标记不回写既有条目）
          cand.discarded = true;
          cand.state = "warn";
        } else {
          if (pm.accepted) cand.accepted = true;
          cand.state = pm.state || "done";
        }
      } else if (rr.discarded) {                                 // 引擎标记仅用于新条目初始态
        cand.discarded = true;
        cand.state = "warn";
        cand.label += "（已废弃）";
      }
      if (!pm) {
        cand.gen = depth;   // 新条目链记录出厂（渲染直读·不再依赖 seq 回落）
      } else if (!touched && !(typeof pm.gen === "number" && pm.gen > 0)) {
        // 未动未自设的既有条目: 链记录出厂/刷新（#24·深度==seq 时与回落同值·写平凡化）
        cand.gen = depth;
      }
      cands.push(cand);
      meta.push({ touched, runDir: (rr && rr.run_dir) || "", ledgerFile: fileLedger });
    }
    // 孤儿条目（本地有·账本无行）：纯本地态原样保全（无账本参照无从影子比对·视同动过保护）
    for (const a of localBySeq.values()) {
      if (mergedSeqs.has(a.seq)) continue;
      cands.push({ ...a });
      meta.push({ touched: true, runDir: "", ledgerFile: null });
    }
    // —— #23 一层去重 pass（排在挤出之前）: R2 文件恒一 + 裁决① ver 校正 + 裁决⑥ pin 继承。
    //   分桶键 = normFileKey(绝对路径)（禁按茎——同茎不同 _old_NN 是不同产物）；file 空不入桶。
    const best = new Map();     // 归一 file → 保留槽下标
    const dropped = new Set();
    const isOwner = (k, key) => { const lf = meta[k].ledgerFile; return !!lf && normFileKey(lf) === key; };
    for (let i = 0; i < cands.length; i++) {
      const key = cands[i].file ? normFileKey(cands[i].file) : null;
      if (!key) continue;
      // 二期案②主轨计代表: 槽 file = 主轨该段当前 file → 并入删除（主轨已代表该产物·
      //   账本正主/pinned 均不豁免——「交换完就是交换完了」，pin 随槽灭）
      if (mainKey != null && key === mainKey) { dropped.add(i); continue; }
      const j = best.get(key);
      if (j === undefined) { best.set(key, i); continue; }
      // 去留优先级: ①账本正主（file=本行账本派生路径）②pinned ③数组序最旧（先到者保）
      const chWins = isOwner(i, key) !== isOwner(j, key)
        ? isOwner(i, key)
        : (!cands[j].pinned && !!cands[i].pinned);
      if (chWins) {
        dropped.add(j);
        if (!cands[i].pinned && cands[j].pinned) cands[i].pinned = cands[j].pinned;   // 裁决⑥
        best.set(key, i);
      } else {
        dropped.add(i);
        if (!cands[j].pinned && cands[i].pinned) cands[j].pinned = cands[i].pinned;   // 裁决⑥
      }
    }
    for (const k of best.values()) {   // 裁决① ver 校正窄门（只动保留槽）: file 与本行账本
      const lf = meta[k].ledgerFile;   //   派生路径精确相等而 ver 语义不符 → 重标——
      if (!lf || normFileKey(lf) !== normFileKey(cands[k].file)) continue;
      // 目标形态统一按账本链深度（Q8 口径·老板一层化最终口径「ver 标签按段计数」——
      //   pinned 槽不再保一轮 seq 形·修正与 #24 的口径分裂；账本链深度跨重建稳定防振荡）
      const c = cands[k];
      const target = `第${ledgerDepthOfSeq(c.seq)}次重制`;
      if (c.ver !== target) c.ver = target;
    }
    // —— 裁决②扩面（「内容定行」·保留槽 gen/ver 重派）: 保留槽 file 反查账本命中 →
    //   gen 一律=该内容的账本链深度（Q8 每段各自数·同源派生）——存量 gen 不豁免（全仓无
    //   手设 gen 写点·存量值皆系统派生旧深度，豁免会把错行号保护住=行/标错位根因）；
    //   ver 同源一并对齐第{深度}次重制（对调槽 file=反查命中的他行·自身行窄门不命中 →
    //   ver 会冻在旧标=gen3/ver第4次 行标错位残留）；未命中维持现值（对调/孤儿纯本地态）。
    for (const k of best.values()) {
      const c = cands[k];
      const fk = c.file ? normFileKey(c.file) : null;
      if (fk == null) continue;
      for (const rr of bySid.get(sid)) {
        const q = rr && rr.seq;
        const rf = ledgerRowFile(rr, sid);
        if (q > 0 && rf && normFileKey(rf) === fk) {
          const dep = ledgerDepthOfSeq(q);
          c.gen = dep;
          const t = `第${dep}次重制`;
          if (c.ver !== t) c.ver = t;
          break;
        }
      }
    }
    // —— #24 存量重排（挂载收敛时）: 无用户语义字段条目（未钉/未换持/未自设 gen）且该行
    //   深度≠全局 seq 的，label 自动形态按每段链深度重标（gen 链记录已在合并出厂时刷新·
    //   见上）。pinned/换持照一轮规则冻结; depth==seq 恒零改写（重排静止点）。
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const depth = depthOfSeq(c.seq);
      if (depth === c.seq) continue;
      if (meta[i].touched) continue;
      if (typeof c.gen === "number" && c.gen > 0 && c.gen !== depth) continue;
      if (c.label === `重制·第${c.seq}次`) c.label = `重制·第${depth}次`;
    }
    for (const i of [...dropped].sort((x, y) => y - x)) {   // cands/meta 同步剔除
      cands.splice(i, 1);
      meta.splice(i, 1);
    }
    // REBUILD_PER_SID 上限（新→旧）：从最旧端挤「未动」条目——动过条目排除在挤出对象外；
    //   全动过 → 软上限不硬挤（不丢本地态·条数不减）
    const order = cands.map((_, i) => i).sort((x, y) => (cands[y].seq || 0) - (cands[x].seq || 0));
    while (order.length > REBUILD_PER_SID) {
      let evict = -1;
      for (let k = order.length - 1; k >= 0; k--) {
        if (!meta[order[k]].touched) { evict = k; break; }
      }
      if (evict < 0) break;
      order.splice(evict, 1);
    }
    for (const i of order) {
      fresh.push(cands[i]);
      if (healTargets && meta[i].touched && meta[i].runDir) {
        healTargets.push({ entry: cands[i], runDir: meta[i].runDir });
      }
    }
  }
  // 保留：非 _reruns 系（候选组系 / retired 系）+ 未受影响的既有 _reruns 系
  //   + 账本零行 sid 的既有 _reruns 系（孤儿保全独立于 bySid: bySid 只收有行 sid，
  //   零行 sid 的本地条目无账本参照——原样保全，不入合并路径·B审必改）
  // —— #23 R3/R4 复核（仅本批合并过 sid 的 retired）: file 被 fresh 保留槽代表 → 清源删除；
//   无代表保留（唯一代表防指针丢失）；cand 组系不参与（R4）。裁决②: 保留条目 file
//   反查账本命中 → gen/ver 重派该内容的按段深度（「内容定行」·扩到全部保留槽·已持 gen
//   不覆写；无命中维持）；裁决⑥: 被删槽 pin 继承保留槽（或逻辑）。
  const freshFiles = new Map();   // sid → Set(归一 file)（fresh 保留槽代表集）
  for (const f of fresh) {
    if (!f || !f.file) continue;
    const s = String(f.sid);
    if (!freshFiles.has(s)) freshFiles.set(s, new Set());
    freshFiles.get(s).add(normFileKey(f.file));
  }
  const retiredKept = new Map();  // sid|归一file → 已保留 retired（同文件多槽留数组靠前者）
  const kept = [];
  for (const a of prev) {
    const sid = a ? String(a.sid) : "";
    if (a && a.kind === "rerun" && affected.has(sid) && bySid.has(sid)) continue;  // 已并入合并制
    if (a && a.kind === "retired" && bySid.has(sid)) {
      const key = a.file ? normFileKey(a.file) : null;
      const reps = key != null ? freshFiles.get(sid) : null;
      if (reps && reps.has(key)) {                       // R3 有代表 → 并入删除
        const rep = fresh.find((f) => f && String(f.sid) === sid && f.file && normFileKey(f.file) === key);
        if (rep && !rep.pinned && a.pinned) rep.pinned = a.pinned;              // 裁决⑥
        continue;
      }
      // 二期案②主轨计代表: retired file = 主轨该段当前 file → 并入删除（主轨已代表该产物·pin 随槽灭）
      const mk3 = mainKeys.get(sid) || null;
      if (key != null && mk3 != null && key === mk3) continue;
      if (key != null) {
        const rk = sid + "|" + key;
        const twin = retiredKept.get(rk);
        if (twin) {                                      // 同文件多 retired → 留数组靠前者
          if (!twin.pinned && a.pinned) twin.pinned = a.pinned;                 // 裁决⑥
          continue;
        }
        let hit = 0;                                     // 裁决② gen 重派（反查账本）
        for (const rr of bySid.get(sid)) {
          const q = rr && rr.seq;
          const rf = ledgerRowFile(rr, sid);
          if (q > 0 && rf && normFileKey(rf) === key) { hit = q; break; }
        }
        // 重派目标 = 该内容的账本链深度（「内容定行」·Q8 每段各自数·同源派生——
        //   不再取账本全局 seq·gen/ver 同源改标）
        const dep = hit ? ((ledgerDepthBySid.get(sid) || new Map()).get(hit) || hit) : 0;
        const out = dep ? { ...a, gen: dep, ver: `第${dep}次重制` } : a;
        retiredKept.set(rk, out);
        kept.push(out);
        continue;
      }
    }
    kept.push(a);
  }
  return kept.concat(fresh);
}

// ============================================================================
// 5.5 convergeAltClips（二期案①无账本去重专用 pass·挂载收敛退化路）: R2/R3/R4 规则
// ============================================================================
//
// 口径（任务包 §一）: 无 loadedTaskId 项目挂载时的收敛核——只做文件去重，不做任何
//   账本推导: 优先级退化为 pinned>数组靠前（无账本正主可判）·裁决①/②与存量重排全部
//   跳过（ver/gen 校正无账本无从谈起）。主轨计代表（二期案②）同样生效。
//   R2: rerun 系按归一 file 分桶恰留一槽（主轨文件桶全删·pin 随槽灭）;
//   R3: retired 系 file 有 rerun 保留槽代表或=主轨文件 → 并入删除（裁决⑥ pin 继承给
//       代表槽）·同文件多 retired 留数组靠前者·无代表保留;
//   R4: cand 组系与其他 kind 不参与去重; 无 file 字段条目不判重复。
//   幂等: 零剔除 → 返回 prev 同引用（调用方据引用相等免落盘·挂载零改写）。
export function convergeAltClips(prevAlts, opts = {}) {
  const prev = Array.isArray(prevAlts) ? prevAlts : [];
  const clips = Array.isArray(opts.clips) ? opts.clips : [];
  const mainKeys = mainKeyBySid(clips);
  const bySid = new Map();   // sid → { rerun: [], retired: [] }（cand/其他 kind 不参与）
  for (const a of prev) {
    const sid = a ? String(a.sid || "") : "";
    if (!sid || (a.kind !== "rerun" && a.kind !== "retired")) continue;
    if (!bySid.has(sid)) bySid.set(sid, { rerun: [], retired: [] });
    bySid.get(sid)[a.kind].push(a);
  }
  const dropped = new Set();
  for (const [sid, b] of bySid) {
    const mk = mainKeys.get(sid) || null;
    // R2: rerun 系同归一 file 恰留一槽（pinned>数组序·主轨文件桶全删）
    const best = new Map();
    for (const a of b.rerun) {
      const key = a.file ? normFileKey(a.file) : null;
      if (key == null) continue;
      if (mk != null && key === mk) { dropped.add(a); continue; }   // 主轨计代表
      const j = best.get(key);
      if (j === undefined) { best.set(key, a); continue; }
      const chWins = !j.pinned && !!a.pinned;
      if (chWins) { dropped.add(j); best.set(key, a); } else { dropped.add(a); continue; }
    }
    const reps = new Set([...best.values()].map((a) => normFileKey(a.file)));
    // R3: retired 系清源（有 rerun 保留槽代表/主轨文件 → 删·同文件留数组靠前·无代表保留）
    const retiredKept = new Map();
    for (const a of b.retired) {
      const key = a.file ? normFileKey(a.file) : null;
      if (key == null) continue;
      if (reps.has(key)) {
        const rep = best.get(key);
        if (rep && !rep.pinned && a.pinned) rep.pinned = a.pinned;  // 裁决⑥
        dropped.add(a);
        continue;
      }
      if (mk != null && key === mk) { dropped.add(a); continue; }   // 主轨计代表
      const twin = retiredKept.get(key);
      if (twin) {
        if (!twin.pinned && a.pinned) twin.pinned = a.pinned;       // 裁决⑥
        dropped.add(a);
        continue;
      }
      retiredKept.set(key, a);
    }
  }
  if (!dropped.size) return prev;
  return prev.filter((a) => !dropped.has(a));
}

// ============================================================================
// 6. altChains 权威分组（批5-R53-TB·实施计划 B4 形态 + R1 代际两句）
// ============================================================================
//
// 形态: { [segId]: { gen: <最高代际>, items: [{cid, gen, idx}] } }
//   items 按代际升序（稳定排序·同代保平铺数组序）；idx = 同 segId 同代组内序（0 基）——
//   B1 组内横向步进偏移（第 i 条 left += i×24px）的序源。平铺 altClips 数组保留兼容
//   （渲染层仍消费），altChains 为权威分组——rebuild 时整体重建（rebuildAltClipsInProject）。
// 代际来源（R1 两句）:
//   ① cand 组统一代际 = 按组首 seq 给全组同一 gen（不按条目各自 seq·防组内 seq 不一致撒到
//      不同轨）；组键 = cand 条目 group 字段（candidates_group）。条目已持久化 gen 时直读
//      （落轨写·此后 F-107 组内排序不改 gen）。
//   ② retired 的采纳代际 = 退位落账时持久化的条目 gen 字段（accept 链写）——重建直读可复现；
//      旧档无 gen 兜底代际 1（不占新代际计数）。
//   rerun 系代际 = 条目 seq（第 N 次重制 = 代际 N·归轨规则代际句）。
export function buildAltChains(alts) {
  const list = Array.isArray(alts) ? alts : [];
  // 组首 seq 表: cand 组（segId|group）→ 平铺数组序首个带 seq 成员的 seq
  const headSeq = new Map();
  for (const a of list) {
    if (!a || a.kind !== "cand" || !a.group) continue;
    const key = `${a.segId}|${a.group}`;
    if (!headSeq.has(key) && typeof a.seq === "number") headSeq.set(key, a.seq);
  }
  const chains = new Map();
  for (const a of list) {
    if (!a || !a.cid || !a.segId) continue;
    let gen;
    if (a.kind === "cand" && a.group) {
      const hs = headSeq.get(`${a.segId}|${a.group}`);
      gen = (typeof a.gen === "number" && a.gen > 0) ? a.gen
        : (typeof hs === "number" ? hs : (typeof a.seq === "number" && a.seq > 0 ? a.seq : 1));
    } else if (a.kind === "retired") {
      gen = (typeof a.gen === "number" && a.gen > 0) ? a.gen : 1;
    } else {
      gen = (typeof a.gen === "number" && a.gen > 0) ? a.gen : (typeof a.seq === "number" && a.seq > 0 ? a.seq : 1);
    }
    let ch = chains.get(a.segId);
    if (!ch) { ch = { gen: 0, items: [] }; chains.set(a.segId, ch); }
    ch.items.push({ cid: a.cid, gen, idx: 0 });
    if (gen > ch.gen) ch.gen = gen;
  }
  const out = {};
  for (const [segId, ch] of chains) {
    ch.items.sort((x, y) => x.gen - y.gen);   // 代际升序（稳定·同代保平铺序）
    const seen = new Map();
    for (const it of ch.items) { const i = seen.get(it.gen) || 0; it.idx = i; seen.set(it.gen, i + 1); }
    out[segId] = { gen: ch.gen, items: ch.items };
  }
  return out;
}

// store 读写薄壳（挂点用·core→store 单向·不反向 import views）:
//   读项目 altClips+mainClips → rebuild → updateEditingState 直写（静默·不入编辑撤销栈——
//   它是后台数据同步不是用户编辑），edit 页经 store 订阅自动重渲。
//   批5-R53-TB：altChains 权威分组随 rebuild 整体重建落盘（B4「rebuild 时重建」）——
//   平铺 altClips 数组保留兼容（渲染层仍消费）。
//   R53-P3：影子比对后半——动过条目保本地的 file 可能被引擎改名（_keep_old 作用于该 sid
//   全部现行 takes）→ rename_heal 按 run_dir 分组自愈（每目录恰一次 browse=B-S2-2·browse
//   失败工具内保留原 file 不抛=B-S2-3·只写 file）。未动条目走账本跟随通道（引擎内存账本
//   已跟改名），无需 browse。无自愈目标时本函数全程同步（调用点零竞态）。
export async function rebuildAltClipsInProject(projectId, detail, sids) {
  if (!projectId) return null;
  const p = storeLoad(projectId);
  const es = (p && p.editingState) || {};
  const prev = Array.isArray(es.altClips) ? es.altClips : [];
  const clips = Array.isArray(es.mainClips) ? es.mainClips : [];
  const healTargets = [];
  const next = rebuildAltClips(prev, detail, sids, { clips, healTargets });
  if (!next || next === prev) return null;
  let healCount = 0;
  if (healTargets.length) {
    const byDir = new Map();
    for (const t of healTargets) {
      if (!t.runDir) continue;
      if (!byDir.has(t.runDir)) byDir.set(t.runDir, []);
      byDir.get(t.runDir).push(t.entry);
    }
    for (const [dir, entries] of byDir) healCount += await healRenamedFiles(entries, dir);
  }
  const nextChains = buildAltChains(next);
  // 二期挂载幂等硬闸: 内容等价（收敛后再挂载零改写）→ 不落盘不触发订阅重渲。
  //   自愈实际改过 file（healCount>0）例外——改动直接落在共享条目对象上，必须走一次
  //   updateEditingState 持久化（in-memory 已变·缺写则刷新后丢失）。
  if (!healCount
    && JSON.stringify(next) === JSON.stringify(prev)
    && JSON.stringify(nextChains) === JSON.stringify(es.altChains || {})) return null;
  updateEditingState(projectId, { altClips: next, altChains: nextChains });
  return next;
}
