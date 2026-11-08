// queue.js — 任务队列（提交历史 · GUI1.3 S3-4 B8 · 空-009 · 拍板 D 组）
//
// 形态：拍板 D 组（引擎队列语义 6 条）里 GUI 可达部分 = **提交历史落账 + 队列视图**：
//   - 落账：core/submit.js pollStatus 起点挂一次（只记录·不改提交链路本身），终态/取消补状态
//   - 条目 {id, time, name, segs, taskId, status, concatStatus?}，持久化 localStorage["gui13.submitHistory"]，封顶 50 裁旧
//     （concatStatus=G3·#50 拼接状态随终态落账·历史行显徽标/人话原因，重跑行带「手动拼接」入口）
//   - 视图：居中弹层（时间倒序 · 状态列）——工具条常用编辑组「队列」入口
// 引擎侧语义（D1 submit 端点 queue_position 字段 / D2 上限 8 / D3 失败跳过+提示 / D4 拖动排序 /
//   D5 引擎重启清空 + GUI 提示 / D6 资源复用）属引擎契约增量，本仓无队列端点 → 登记形态（弹层内注记）。
//
// 用法（core）：submit.js 动态 import 本模块（core 不静态依赖 ui），
//   起点 recordSubmitStart({taskId}) → 返回 id；终态 recordSubmitFinal(id, payload)；取消 recordSubmitCancelled(id)。

import { open as openModal } from "./modal.js";
import { t } from "../core/i18n.js";   // #89 T5a：队列弹层/状态词/拼接归档文案入典 queue.*
import { load as storeLoad, listProjects } from "../store/store.js";
// 批 10-M T5：提交历史迁 server 聚合文件 data/history.json（读 server 优先 → 本地回退；写内存 + PUT）
import { readAgg, writeAgg, HISTORY_JSON } from "../core/server_storage.js";
// G3·#50：行内「手动拼接」入口复用 core 同一通道（与 shell「按此版本合并」同参）+ toast 反馈
import { concat as concatApi } from "../core/concat.js";
// G6·#51：行内「归档」入口复用 core 同一通道（409 忙类退避重试内置·与自动归档同口径）
import { archiveTask as archiveApi } from "../core/archive.js";
import { showToast } from "./toast.js";

export const SUBMIT_HISTORY_KEY = "gui13.submitHistory";
export const SUBMIT_HISTORY_MAX = 50;

// #89 T5a：状态显示词入典（值=queue.status.* 典键·statusLabel 渲染处 t() 取词）
export const SUBMIT_STATUS_LABEL = Object.freeze({
  running: "queue.status.running",
  done: "queue.status.done",
  // partial 标签保留：存量 data/history.json 已有 status:"partial" 行，删标签会显裸码。
  // R-44 口径同改后新行不再产出 partial → 历史行显「部分失败」/新行显「任务失败」=已知历史差异。
  partial: "queue.status.partial",
  failed: "queue.status.failed",
  cancelled: "queue.status.cancelled",
});

// ============================================================================
// G3·#50：拼接状态透出（纯透出·引擎 R-62 门/裁决C 行为零变更）
//   引擎 manifest._concat → status 终态顶层 concat（"concat": data.get("_concat")），
//   三形态：{status:"skipped",reason[,missing|sizes]} / {status:"failed",error} / {status:"success",file}。
//   落账形态（条目 concatStatus 字段）只留 status + 人话化所需键（reason/error/file）。
// ============================================================================

/** 引擎 concat 形态 → 落账形态（非对象/未知 status → null 不落账） */
function _normConcat(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  if (c.status !== "skipped" && c.status !== "failed" && c.status !== "success") return null;
  return {
    status: c.status,
    ...(c.status === "skipped" && typeof c.reason === "string" && c.reason ? { reason: c.reason } : {}),
    ...(c.status === "failed" && typeof c.error === "string" && c.error ? { error: c.error } : {}),
    ...(c.status === "success" && typeof c.file === "string" && c.file ? { file: c.file } : {}),
  };
}

/** 轮询终态载荷 → concatStatus（payload.concat 缺失/非法 → null，调用方不落账） */
export function deriveConcatStatus(payload) {
  return _normConcat(payload && payload.concat);
}

// reason 人话化映射——统一前缀匹配口径（引擎 rerun_no_auto_concat / res_changed 为复合串·
//   其余为精确值）；未命中任何已知前缀 → 回退引擎原文（防枚举漂移失联）。
// #89 T5a：值=queue.concat.r.* 典键（前缀=引擎协议值禁译）·渲染处 t() 取词
const CONCAT_REASON_TEXT = [
  ["failed_segments", "queue.concat.r.failedSegments"],
  ["stopped", "queue.concat.r.stopped"],
  ["rerun_no_auto_concat", "queue.concat.r.rerunNoAutoConcat"],
  ["relay_missing", "queue.concat.r.relayMissing"],
  ["size_mismatch", "queue.concat.r.sizeMismatch"],
  ["auto_concat_off", "queue.concat.r.autoConcatOff"],
  ["concat_gate_blocked", "queue.concat.r.concatGateBlocked"],
  ["res_changed", "queue.concat.r.resChanged"],
];

/** concatStatus → 历史行徽标文案（空文=不显徽标） */
export function concatStatusText(cs) {
  if (!cs || typeof cs !== "object") return "";
  if (cs.status === "success") return t("queue.concat.done");
  if (cs.status === "failed") {
    const err = String(cs.error || "").trim();
    return err ? t("queue.concat.failed", { msg: err }) : t("queue.concat.failedPlain");
  }
  if (cs.status === "skipped") {
    const reason = String(cs.reason || "");
    for (const [prefix, key] of CONCAT_REASON_TEXT) {
      if (reason.startsWith(prefix)) return t(key);
    }
    return reason;   // 未知 reason → 引擎原文回退
  }
  return "";
}

// ===== 存储（可注入·默认 globalThis.localStorage；notif.js 同款） =====
let storage = globalThis.localStorage;
export function setStorage(s) { storage = s; }

function _norm(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const status = typeof e.status === "string" && e.status ? e.status : "running";
  const cs = _normConcat(e.concatStatus);   // G3·#50：读写往返保全 concatStatus（非法形态剥除）
  return {
    id: String(e.id == null ? "" : e.id),
    time: Number.isFinite(e.time) ? e.time : 0,
    name: String(e.name == null ? "" : e.name),
    segs: Number.isFinite(e.segs) ? e.segs : 0,
    taskId: String(e.taskId == null ? "" : e.taskId),
    status,
    ...(typeof e.kind === "string" && e.kind ? { kind: e.kind } : {}),   // G2·#57：kind 来源字段读写往返保全（无 kind 行缺省不加键不抛）
    ...(cs ? { concatStatus: cs } : {}),
    ...(e.archived === true ? { archived: true } : {}),   // G6·#51：读写往返保全已归档行状态
  };
}

export function loadHistory() {
  if (!storage) return [];   // M-T5：无 storage → 空（保留旧契约·不因聚合缓存命中而返回数据）
  try {
    const v = readAgg(HISTORY_JSON, "submitHistory", storage);   // M-T5
    const arr = Array.isArray(v) ? v
      : (storage && storage.getItem(SUBMIT_HISTORY_KEY) ? JSON.parse(storage.getItem(SUBMIT_HISTORY_KEY)) : null);
    if (!Array.isArray(arr)) return [];
    return arr.map(_norm).filter(Boolean);
  } catch (_e) { return []; }
}

function _save(list) {
  writeAgg(HISTORY_JSON, "submitHistory", list);   // M-T5：内存 + 异步 PUT（localStorage 停写）
}

// ===== 纯逻辑 =====

/** 头插 + 封顶裁旧（不修改入参；列表不变量 = 新→旧，故裁尾即裁最旧） */
export function appendRecord(list, entry) {
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, SUBMIT_HISTORY_MAX);
}

/** 按 id 打补丁（返回新数组；无命中条数不变） */
export function patchRecord(list, id, patch) {
  const arr = Array.isArray(list) ? list : [];
  if (!id) return arr.slice();
  return arr.map((e) => (e && e.id === id ? { ...e, ...patch } : e));
}

/** 轮询载荷 → 状态码（与 ui/notif.js buildNotifEntry 同口径判定序：引擎无响应 > 段失败 > 完成）
 *  R-44 口径同改：failed>0 归 failed（部分失败=failed 态·与按钮态同口径·消「队列说部分失败/按钮说任务失败」分裂）。 */
export function deriveSubmitStatus(payload) {
  const p = (payload && typeof payload === "object") ? payload : {};
  // 批 M5 T2a（F109）：引擎中断合成终态 → failed（漏判则提交历史行显「完成」=谎报）
  if (p._engineDeadByNull === true) return "failed";
  if (p._engineDeadAfterEmpty === true) return "failed";
  const failed = typeof p.failed === "number" ? p.failed : 0;
  return failed > 0 ? "failed" : "done";
}

export function statusLabel(code) {
  return SUBMIT_STATUS_LABEL[code] ? t(SUBMIT_STATUS_LABEL[code]) : String(code == null ? "" : code);
}

export function formatTime(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "—";
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 路由 hash → 项目 id（'#/project/<id>?tab=edit'；非项目路由 → ""） */
export function projectIdFromHash(hash) {
  const m = String(hash == null ? "" : hash).match(/^#?\/project\/([^/?#]+)/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch (_e) { return m[1]; }
}

/** 视图行派生：时间倒序 + 状态列（脏条目跳过）
 *  G3·#50：派生 concatText（徽标文案）+ canManualConcat（重跑完成行「手动拼接」入口判据）
 *  G6·#51：派生 archived（「已归档」徽标） */
export function queueRows(list) {
  const arr = (Array.isArray(list) ? list : []).map(_norm).filter(Boolean);
  return arr
    .slice()
    .sort((a, b) => b.time - a.time)
    .map((e) => ({
      ...e,
      timeText: formatTime(e.time),
      statusText: statusLabel(e.status),
      concatText: concatStatusText(e.concatStatus),
      canManualConcat: !!(e.concatStatus && e.concatStatus.status === "skipped"
        && String(e.concatStatus.reason || "").startsWith("rerun_no_auto_concat")),
      archived: e.archived === true,
    }));
}

// ===== 落账 IO（core 调用口） =====

function _resolveProject(opts) {
  if (Object.prototype.hasOwnProperty.call(opts, "project")) return opts.project || null;
  const hash = Object.prototype.hasOwnProperty.call(opts, "hash")
    ? opts.hash
    : ((typeof globalThis !== "undefined" && globalThis.location && globalThis.location.hash) || "");
  const pid = projectIdFromHash(hash);
  if (!pid) return null;
  try { return storeLoad(pid); } catch (_e) { return null; }
}

/** 提交起点落账一条（返回条目 id；存储不可用 → null）
 *  G2·#57：opts.attach=true → 同 taskId 已有 running 行则保留最新一条（list 新→旧取首个命中）、
 *  删其余 running 行（死链遗留）、返原行 id 不 append；无 running 行才照常头插（50 封顶挤出兜底不变）。
 *  attach 仅恢复链启用（缺省仍无条件头插）；rerun/seg_edit 真重跑行永不并入永不删除；
 *  opts.kind 落行来源字段（main/resume/rerun/seg_edit/concept）。 */
export function recordSubmitStart(opts = {}) {
  const proj = _resolveProject(opts);
  const rec = _norm({
    id: "sub-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    time: Date.now(),
    name: proj ? proj.name : "",
    segs: proj && Array.isArray(proj.segments) ? proj.segments.length : 0,
    taskId: opts.taskId,
    status: "running",
    ...(typeof opts.kind === "string" && opts.kind ? { kind: opts.kind } : {}),
  });
  if (!rec) return null;
  const list = loadHistory();
  if (opts.attach === true && rec.taskId) {
    const same = list.filter((e) => e && e.taskId === rec.taskId && e.status === "running"
      && e.kind !== "rerun" && e.kind !== "seg_edit");
    if (same.length > 0) {
      const keepId = same[0].id;   // 列表不变量=新→旧 → 首个命中即最新
      _save(list.filter((e) => !(e && e.taskId === rec.taskId && e.status === "running"
        && e.kind !== "rerun" && e.kind !== "seg_edit" && e.id !== keepId)));
      return keepId;
    }
  }
  _save(appendRecord(list, rec));
  return rec.id;
}

/** 终态补状态（完成/部分失败/失败）；返回是否命中条目
 *  G3·#50：载荷带 concat → 同拍落 concatStatus（无 concat 不写·既有值不清；带新值覆盖） */
export function recordSubmitFinal(id, payload) {
  const list = loadHistory();
  const patch = { status: deriveSubmitStatus(payload) };
  const cs = deriveConcatStatus(payload);
  if (cs) patch.concatStatus = cs;
  const next = patchRecord(list, id, patch);
  _save(next);
  return next.some((e) => e && e.id === id && e.status !== "running");
}

/** 取消（pollStatus.stop() 路径）→ 已取消 */
export function recordSubmitCancelled(id) {
  const next = patchRecord(loadHistory(), id, { status: "cancelled" });
  _save(next);
  return next.some((e) => e && e.id === id && e.status === "cancelled");
}

/** G3·#50：历史行「手动拼接」——与 shell「按此版本合并」同一 concat 通道同参（mode=global）。
 *  api 注入位（单测 spy 用·生产传 concatApi）；空任务号拦截不外发，返回 concat 归一结果。 */
export async function manualConcat(api, taskId) {
  const id = String(taskId == null ? "" : taskId).trim();
  if (!id) {
    showToast("info", t("queue.mc.noTaskId"));
    return { ok: false };
  }
  showToast("info", t("queue.mc.submitted"));
  const r = await (typeof api === "function" ? api : concatApi)({ taskId: id, mode: "global" });
  if (r && r.ok) showToast("success", t("queue.mc.started"));
  else showToast("error", t("queue.concat.failed", { msg: (r && r.error && r.error.msg) || t("sb.run.errFallback") }));
  return r;
}

/** G6·#51：历史行「归档」——与自动归档同一 archive 通道（409 忙类退避重试内置在
 *  core/archive.js·与 route①② 同口径）。api 注入位（单测 spy 用·生产传 archiveApi）；
 *  空任务号拦截不外发；幂等（引擎对已归档任务返回 ok+dest 同形 → 同一成功提示）；
 *  成功落行 archived 徽标态（entryId 命中行优先·缺省按 taskId 落同任务全部行）。 */
export async function manualArchive(api, taskId, entryId) {
  const id = String(taskId == null ? "" : taskId).trim();
  if (!id) {
    showToast("info", t("queue.arch.noTaskId"));
    return { ok: false };
  }
  showToast("info", t("queue.arch.submitted"));
  const r = await (typeof api === "function" ? api : archiveApi)({ taskId: id });
  if (r && r.ok) {
    showToast("success", t("queue.arch.done"));   // 幂等：已归档再点引擎仍返 ok+dest → 同一成功提示
    _save(loadHistory().map((e) => (e && (entryId ? e.id === entryId : e.taskId === id) ? { ...e, archived: true } : e)));
  } else if (r && r.busyTimeout) {
    showToast("warn", t("queue.arch.busy"));
  } else {
    const err = (r && r.error) || null;   // E4 配套兜底（批9 G4b⑤）：msg 空 → 落 code 裸码（不吞成「未知错误」）
    showToast("error", t("queue.arch.failed", { msg: (err && err.msg) || (err && err.code) || t("sb.run.errFallback") }));
  }
  return r;
}

/** 删某 taskId 下全部 running 行（批 M5b T2·重挂对账用）
 *  为何删不翻：recordSubmitFinal 只有二值终态、没有「并入」语义——重挂时任务还在跑，
 *  翻 done/failed 皆谎报（_save 私有·自扫删除须由此导出）。返回删除条数。 */
export function removeRunningByTaskId(stem) {
  const key = String(stem == null ? "" : stem);
  if (!key) return 0;
  const list = loadHistory();
  const next = list.filter((e) => !(e && e.taskId === key && e.status === "running"));
  if (next.length === list.length) return 0;
  _save(next);
  return list.length - next.length;
}

/** G2·#57 存量清理：running 残留行 heal（打开提交历史弹层时跑一次·不做定时器）。
 *  只动 status==="running" 行（rerun/seg_edit 真重跑行与终态行零触碰）；删除双门 =
 *  行龄>24h（照 submit-bar 重跑对账步行龄门口径·陈旧跨日行才值得清）且 listProjects
 *  同 stem 无任何 runs[].running===true（另一标签活链/项目在跑记录零触碰——多标签误杀防护）。
 *  同 taskId 重复对自然留最新一条（最新行通常 <24h）。多标签并发同开重复删同批行天然幂等
 *  （删除对已删行 no-op）。返回删除条数；读侧任何异常 → 0（清理失败不碍弹层打开）。 */
export function healStaleRunningRows() {
  try {
    const list = loadHistory();
    if (list.length === 0) return 0;
    const runningStems = new Set();
    for (const p of listProjects()) {
      const rows = p && Array.isArray(p.runs) ? p.runs : [];
      for (const r of rows) {
        if (r && r.running === true && r.stem) runningStems.add(String(r.stem));
      }
    }
    const next = list.filter((e) => !(e && e.status === "running"
      && e.kind !== "rerun" && e.kind !== "seg_edit"
      && Date.now() - e.time > 24 * 3600 * 1000
      && !runningStems.has(e.taskId)));
    if (next.length === list.length) return 0;
    _save(next);
    return list.length - next.length;
  } catch (_e) { return 0; }
}

// ===== 视图（居中弹层·时间倒序列表） =====

function _el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

export function openQueueModal() {
  if (typeof document === "undefined") return null;
  healStaleRunningRows();   // G2·#57：开弹层跑一次存量 running 行清理（双门防误杀·终态零触碰·异常静默）
  const body = document.createElement("div");
  const rows = queueRows(loadHistory());
  if (rows.length === 0) {
    const empty = _el("div", "q-empty", t("queue.empty"));
    empty.style.cssText = "color:var(--txt3);font-size:13px;padding:6px 0";
    body.appendChild(empty);
  } else {
    for (const r of rows) {
      const row = _el("div", "q-row");
      row.style.cssText = "display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px";
      row.appendChild(_el("span", "q-time", r.timeText));
      const name = _el("span", "q-name", r.name || t("queue.unnamed"));
      name.style.cssText = "flex:1;min-width:0;word-break:break-all";
      row.appendChild(name);
      row.appendChild(_el("span", "q-segs", t("queue.segs", { n: r.segs })));
      row.appendChild(_el("span", "q-status", r.statusText));
      // G6·#51：已归档徽标（archived 行）——重开弹层由存储态渲染
      if (r.archived) {
        const archivedBadge = _el("span", "q-archived", t("queue.archivedBadge"));
        archivedBadge.style.cssText = "color:var(--txt2);font-size:12px;white-space:nowrap";
        row.appendChild(archivedBadge);
      }
      // G3·#50：拼接状态徽标（有 concatStatus 且文案非空才显）+ 重跑完成行「手动拼接」入口
      if (r.concatText) {
        const badge = _el("span", "q-concat", r.concatText);
        badge.style.cssText = "color:var(--txt3);font-size:12px;white-space:nowrap";
        row.appendChild(badge);
      }
      if (r.canManualConcat && r.taskId) {
        const concatBtn = _el("button", "ghostbtn q-concat-btn", t("queue.btn.concat"));
        concatBtn.type = "button";
        concatBtn.style.cssText = "font-size:12px;padding:1px 8px";
        concatBtn.addEventListener("click", () => { void manualConcat(concatApi, r.taskId); });
        row.appendChild(concatBtn);
      }
      // G6·#51：全部历史行「归档」入口（不限状态·含中断批——残夹手动清理主通道；幂等可重按）
      if (r.taskId) {
        const archiveBtn = _el("button", "ghostbtn q-archive-btn", t("queue.btn.archive"));
        archiveBtn.type = "button";
        archiveBtn.style.cssText = "font-size:12px;padding:1px 8px";
        archiveBtn.addEventListener("click", () => { void manualArchive(archiveApi, r.taskId, r.id); });
        row.appendChild(archiveBtn);
      }
      row.appendChild(_el("span", "q-task", r.taskId));
      body.appendChild(row);
    }
  }
  // 弹层注记（体验修复 C-4：去「登记待引擎批」内部措辞，用人话说明本地提交记录；
  //   #89 T5a 按任务单口径改中性说明——「暂不支持（当前版本）」·不承诺未来版本）
  const note = _el("div", "q-note", t("queue.note"));
  note.style.cssText = "color:var(--txt3);font-size:12px;margin-top:10px;line-height:1.5";
  body.appendChild(note);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghostbtn";
  closeBtn.textContent = t("queue.btn.close");
  const inst = openModal({
    title: t("queue.title"),
    sub: t("queue.sub"),
    contentNode: body,
    footerButtons: [closeBtn],
    closeOnBackdrop: true,
  });
  closeBtn.addEventListener("click", () => inst.close());
  return inst;
}
