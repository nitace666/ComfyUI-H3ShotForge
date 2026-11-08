// views/submit-bar.js — 工作区提交主链视图 (S1-2 T6)
//
// === 任务边界 ===
//   1. 提交按钮（工作区顶栏）→ 流程编排: buildFormData → generateOnly → runOnly
//   2. 引擎 400 detail 数组 → 预检弹窗渲染 (renderPreflightModalContent)
//   3. PDD 预警条 (表单上方常驻条, 演示态隐藏)
//   4. submit 成功 → 最小运行状态件: pollStatus 3s 轮询 → 完成/失败 toast
//   5. 失败/取消路径 (toast 即可)
//
// === 出处注记 ===
// 源：legacy/app/js/domain/submit.js (409 行) + v43 原型提交按钮 (:1148 实测位置).
// 改造点 = ①纯逻辑函数 6 件提取 (测试覆盖) ②DOM mount 注入 shell 顶栏 ③预检弹窗 + PDD 预警条壳
//
// === 演示态约束 (S1-2 T6 范围内) ===
//   - PDD hasPdd 恒 false (模板状态归 S2-2 后)
//   - pool/pool_usage 演示态空 (真实资源编排映射归 T8 裁决+后续批)
//   - 真实引擎调用挂 T9 里程碑 (本批单测桩验证)
//
// === API ===
//   renderPreflightModalContent(detail)  引擎 400 detail 数组 → 弹窗内容 HTML
//   computeButtonLabel(state)            5 态 → 按钮文字
//   phaseLabel(phase)                    5 态 → 中文标签
//   cancelUnavailableToast(msg)          cancel 返回 cancelled:false 两形态 → 白话提示（H3）
//   pollDoneToast(payload)               轮询终态 → 完成 toast 文案
//   pollFailedToast(payload)             轮询失败 → 失败 toast 文案
//   buildSubmitFlowSteps()               流程步骤编排 (build/generate/run/poll)
//   pddWarningVisible(hasPdd, formData)  PDD 预警条可见性 (本批演示恒 false)
//   mountSubmitBar(opts)                 注入顶栏容器 — 返回 handle { refresh, getPhase, submit, cancel, unmount }

import {
  generateOnly,
  runOnly,
  submitBatch,
  pollStatus,
  cancelBatch,
  pddTurboWarning,
  buildFormDataFromProject,
  getHasPddTemplate,
  shotColor,
  deriveFailedSegs,
  stoppedNotifEntry, // #64：停止类终态文案（core 停止词表单一来源）
  templateNameFromPath, // M6-T2 R-30：显示行白话化（存 path·显 name）
  deriveRunSubdir, // S1-T4（R-52 v2）：运行子目录推导（首跑/全量=新时间戳嵌套子夹·接力沿用）
  _sanitizeFolderBase, // R-52 v2：撞名检查列项目根夹用（输出根+清洗项目名）
} from "../core/submit.js";
import { loadWorkspaceRoot } from "../core/workspace.js"; // R-59-T2b：撞名检查根读源（settings.json workspace_root·不走 localStorage）
// T3（档2 G2）：运行快照落盘——提交时刻项目参数全貌独立文件（供按记录载入恢复）
import { buildRunSnapshotPayload, saveRunSnapshot } from "../core/run_snapshots.js";
import { listAssets, readRegistry, pickFirstFrameRefForPrompt } from "../core/assets_api.js";
import { listDirectory } from "../core/browse.js"; // S1-T4（R-52）：撞名检查用列目录通道
import { connectLive } from "../core/push.js";
import { push as pushNotif } from "../ui/notif.js";
import { pushLiveFrame, pushLiveStatus, pushLiveProgress, openExecErrorModal } from "./preview.js";
import { open as openModal, openConfirm as openConfirmModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { hydrateIcons } from "../ui/icons.js";
// R-20①②（P-T2）：deriveProjectCompletion 消费（前置弹窗路由判定）
// F106 T2：latestMainRunStem 消费（A 档落账刷新 loadedTaskId 的「现行任务」判定）
// #63 T4：isRunPointerPinned 消费（显式载入旧记录 → 落账刷新豁免「最新自愈」）
import { load as storeLoad, updateProjectMeta, updateEditingState, deriveProjectCompletion, latestMainRunStem, isRunPointerPinned, defaultClipL2, defaultTracks, putDetailSnapshot } from "../store/store.js";
import { request } from "../core/api.js";
// 批2 #57 档2：全仓 HTTP 超时集中表（core/timeouts.js）——本文件超时值引表·不得就地内联。
import { TIMEOUTS } from "../core/timeouts.js";
// 地基批1档2 T3（账本 #45 状态面）：F109 恢复链探活改走 settings.refreshChip 同源出口
//   （与设置页/顶栏芯片同一探测体·失败拍芯片同帧落 idle·成功拍同帧翻已连接）
import { refreshChip } from "./settings.js";
import { rebuildAltClipsInProject } from "../core/candidates.js";
import { normFileKey } from "../core/filekey.js"; // R53 P1：③ 自愈分组按 run_dir 归一判等（守则已退役·余 normFileKey）
import { healRenamedFiles } from "../core/rename_heal.js"; // R53 P1-c：③ 段改名自愈兜底（发起时侧在 rerun_flow）
import { loadHistory, recordSubmitFinal, removeRunningByTaskId, deriveConcatStatus } from "../ui/queue.js";
import { t } from "../core/i18n.js";   // #89 T4b：显示文案入典（sb.*·zh 原文=键值·en 见 core/i18n.js；数据串/865 红线不入典）

// ============================================================================
// 登记项 7（老板裁决 2026-09-27「历史记录补上真实数据」）：真运行历史落账
//   读侧契约（shell.js buildRunsBlock）：project.runs 倒序数组
//   { at, total, done, failed, running?, memo?, verNote? }——现行置顶。
//   写点两处：submit 成功 push（running 态）；轮询终态更新 runs[0]。
//   core/submit.js 协议层零改动（落账是显示层关注点·低耦合）。
// ============================================================================
export function runStamp(d) {
  const dt = d || new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
}

// submit 成功 → 落一条 running 记录（倒序置顶；上限 30 条防 localStorage 膨胀）
export function appendRunRecord(projectId, run) {
  if (!projectId || !run || typeof run !== "object") return false;
  const p = storeLoad(projectId);
  if (!p) return false;
  const runs = Array.isArray(p.runs) ? p.runs : [];
  runs.unshift({ ...run });
  return updateProjectMeta(projectId, { runs: runs.slice(0, 30) });
}

// #63 T4：主链落账后的 loadedTaskId 刷新（F106 A 档原逻辑 + 自愈豁免）——
//   currentRunId 钉在非最新记录（用户显式载入旧记录）→ 不自动纠正；新提交已在落账点把指针
//   刷新为新记录，故本函数照常跟新（豁免不误伤新提交）。
export function refreshLoadedTaskAfterLanding(projectId) {
  const p = projectId ? storeLoad(projectId) : null;
  if (!p || isRunPointerPinned(p)) return false;
  const latest = latestMainRunStem(p.runs);
  if (!latest) return false;
  return updateEditingState(projectId, { loadedTaskId: latest });
}

// 轮询终态 → 更新 runs 记录（done/failed 终值·退出 running）
// R-44 I1：patch.stem 存在 → 按 stem 定位记录（appendRunRecord unshift 抢位时主链记录
//   沉底·无条件写 runs[0] 会把终态写到重跑记录上）；缺省回落 runs[0]（onTick 增量
//   /cancelCurrent 无 stem 调用点·签名不变不破）。未命中跳过 + warn（不误写他人记录）。
export function settleLatestRun(projectId, patch) {
  if (!projectId || !patch || typeof patch !== "object") return false;
  const p = storeLoad(projectId);
  if (!p || !Array.isArray(p.runs) || p.runs.length === 0) return false;
  const runs = p.runs.slice();
  const stem = patch.stem;
  // G1·#49：写 done/failed 的落账统一换算 percent（runs 行恒满足 percent=(done+failed)/total
  //   ——增量 tick 与终态冻结同一口径）；total 非有限正数 → 不写（防除零·条回退 phase 态）。
  const withCount = "done" in patch || "failed" in patch;
  const _merge = (row) => {
    const merged = { ...row, ...patch };
    if (withCount) {
      const pct = runPercent(merged);
      if (pct != null) merged.percent = pct;
    }
    return merged;
  };
  if (stem) {
    const idx = runs.findIndex((r) => r && r.stem === stem);
    if (idx < 0) {
      console.warn("[submit-bar] settleLatestRun 未命中 stem 记录·跳过写回", stem);
      return false;
    }
    runs[idx] = _merge(runs[idx]);
  } else {
    runs[0] = _merge(runs[0]);
  }
  return updateProjectMeta(projectId, { runs });
}

// G1·#49（方案 v5 §三 #49·S3）：runs 行进度换算——(done+failed)/total（0..1）。
//   failed 计入分子（失败段=已出结果段）；stopped/missing 段两头不入（引擎侧 done/failed
//   即不含）→ percent 到不了 1 是正常态，终态判定挂 running=false 不挂 percent。
//   total 非有限正数 → null（防除零·消费方回退 phase 态）。
export function runPercent(run) {
  if (!run || typeof run !== "object") return null;
  const total = Number(run.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const done = Number(run.done) || 0;
  const failed = Number(run.failed) || 0;
  return Math.min(1, Math.max(0, (done + failed) / total));
}

// R-44 ⑤：终态确认写回——仅对 r.result && !r.resultAck 的记录置位 resultAck
//   （终态后 rerun 抢位 runs[0] 时 ack 不落错记录；同 stem 优先）。
export function ackRunResult(projectId, stem) {
  if (!projectId) return false;
  const p = storeLoad(projectId);
  if (!p || !Array.isArray(p.runs) || p.runs.length === 0) return false;
  const runs = p.runs.slice();
  const hit = runs.findIndex((r) => r && r.result && !r.resultAck && (!stem || r.stem === stem));
  if (hit < 0) return false;
  runs[hit] = { ...runs[hit], resultAck: true };
  return updateProjectMeta(projectId, { runs });
}

// 走查反馈⑦（2026-09-27 老板报"生成了但项目里空"）：生成完成 → 产物自动入轨——
//   history/detail 的 shots（shot_NNN 按段序）→ mainClips 对应段填 file 绝对路径，
//   预览胶片条/播放器/剪辑时间线即刻可见可播（此前产物只躺在引擎目录，须手动「载入历史」）。
export async function syncRunProducts(projectId, stem) {
  if (!projectId || !stem) return { ok: false, error: "缺 projectId/stem" };
  const r = await request(`/h3_batch/history/detail?task_id=${encodeURIComponent(stem)}`, { cache: "no-store" });
  if (!r.ok || !r.data || !r.data.shots) {
    return { ok: false, error: (r.error && r.error.msg) || "任务明细查询失败" };
  }
  const p = storeLoad(projectId);
  if (!p) return { ok: false, error: "项目不存在" };
  // 批A #13：detail 快照落项目实体（shots/_reruns 关键面 + savedAt）——离线显示兜底数据源；
  //   不冒充引擎真相：引擎可达后对账链照跑本函数即真相刷新路径（语义②），芯片转已连接即失效（语义③）。
  putDetailSnapshot(projectId, stem, {
    savedAt: new Date().toISOString(),
    shots: (r.data.shots && typeof r.data.shots === "object" && !Array.isArray(r.data.shots)) ? r.data.shots : {},
    reruns: Array.isArray(r.data._reruns) ? r.data._reruns : [],
    concat: r.data.concat !== undefined ? r.data.concat : null,
  });
  // D-T4③：已删段闸门（R-21 甲）——push 分支按 segments 下标造 clip，段被删（墓碑标记在·
  //   分镜行保留）后重跑完成会凭空复活、绕过 D-T1 补段闸门；命中=跳过 push（不复活·标记保持）
  const deletedSegIds = (p.editingState && Array.isArray(p.editingState.deletedSegIds)) ? p.editingState.deletedSegIds : [];
  const clips = Array.isArray(p.editingState && p.editingState.mainClips) ? p.editingState.mainClips.slice() : [];
  const segs = Array.isArray(p.segments) ? p.segments : [];
  let filled = 0;
  let changed = false; // C2：status 回写等非产物变更也要落盘（filled 仅计产物数）
  let enumIdx = 0; // B4-T2：非 shot_NNN 键（CSV ID 填充任务·如 s01）按出现序对位 segments
  // 批 C C-T3：补段 n 的起步值 = 存量 max(n)（存量段号冻结·新段从其后递增·同 store reconcile）
  let nextN = clips.reduce((mx, c) => (c && typeof c.n === "number" && Number.isFinite(c.n) && c.n > mx ? c.n : mx), 0);
  // F106：回填同时写 clip.sid（引擎 shot 键原样）——与 loadedTaskId 配对，右键守卫需要引擎段号（失败段同样可用右键重跑）
  // R53 域重对齐 P1-c：③ 段改名自愈队列——循环内只收集，循环后按 run_dir 去重 browse（终态/挂载兜底）
  const healGroups = new Map(); // 归一 run_dir -> { runDir, clips }
  for (const [sid, shot] of Object.entries(r.data.shots)) {
    // B4-T2 出现序兜底 + P-T3：s(\d+) 数值原序解析——start_from 子集任务 detail 只返 s0K..s0N，
    //   出现序会映到 0/1=错段回填；零填充全量任务数值解析与出现序等价（B4-T2 口径兼容·单测锁）。
    const sKey = String(sid);
    const m = sKey.match(/shot_(\d+)/) || sKey.match(/^s(\d+)$/);
    const segIdx = m ? (parseInt(m[1], 10) - 1) : enumIdx;
    enumIdx++;
    const seg = segs[segIdx];
    const clip = seg ? clips.find((c) => c && c.segId === seg.id) : null;
    // B5-T4 C2（v2-3）：失败/中止段回写——status 原值 + state 补 warn（此前 continue 静默丢弃，
    //   时间线不知有失败段；state 口径与 applyHistory 一致）
    if (shot && (shot.status === "failed" || shot.status === "stopped")) {
      if (clip) {
        if (clip.status !== shot.status) { clip.status = shot.status; changed = true; }
        if (clip.state !== "warn") { clip.state = "warn"; changed = true; }
        if (clip.sid !== sKey) { clip.sid = sKey; changed = true; }
        // R-33：实际耗时透传（T3 detail 有键才带·无键不写防 undefined 覆盖旧值）
        if (shot.elapsed_sec != null && clip.elapsedSec !== shot.elapsed_sec) { clip.elapsedSec = shot.elapsed_sec; changed = true; }
        // R-34：失败原因透传（T4 detail 有键才带·dict 四键）——值级比较保幂等（同错复同步不重复落盘）
        //   且重跑再失败的新错可落地；旧格式复同步（无键）不写不清值。
        if (shot.execution_error != null && JSON.stringify(clip.executionError) !== JSON.stringify(shot.execution_error)) { clip.executionError = shot.execution_error; changed = true; }
      }
      continue;
    }
    if (!shot || shot.status !== "success" || !Array.isArray(shot.files) || !shot.files.length) continue;
    if (!seg) continue;
    const file = (shot.run_dir || "") + "\\" + shot.files[0];
    if (clip) {
      // R53 域重对齐 P1-a（老板①重跑不碰正片轨）三路径：
      //   ② clip.file 空（首渲未落/失败段）→ 新产物入轨 file+state=done（F101② 清 review）；
      //   ③ clip.file 非空 → 新产物 file/ver/review 一概不写（只补 sid/status + warn 恢复），
      //      改名自愈见循环后（该分支原 localPick 守则在此退役——③ 本就不覆写，守则无对象）。
      if (!clip.file) {
        clip.file = file;
        clip.state = "done";
        clip.review = null; // F101②：新产物落轨 → 清回未审
        filled++;
        changed = true;
      } else if (shot.run_dir) {
        const dk = normFileKey(shot.run_dir);
        if (!healGroups.has(dk)) healGroups.set(dk, { runDir: shot.run_dir, clips: [] });
        healGroups.get(dk).clips.push(clip);
      }
      // ②③ 共同侧：失败段重跑成功恢复 done（A-S）+ status/sid 原值补写（F106 口径·老档幂等复落账仍补）
      if (clip.state === "warn") { clip.state = "done"; changed = true; }
      if (clip.status !== shot.status) { clip.status = shot.status; changed = true; }
      if (clip.sid !== sKey) { clip.sid = sKey; changed = true; }
      // R-33：实际耗时透传（同上·有键才写防覆盖）
      if (shot.elapsed_sec != null && clip.elapsedSec !== shot.elapsed_sec) { clip.elapsedSec = shot.elapsed_sec; changed = true; }
    } else if (!deletedSegIds.includes(seg.id)) {
      // 批 C C-T3：补段形态与 store reconcile 补段对齐 —— n=存量 max(n)+1（段号铁律·
      //   逐条递增·防与存量撞号）+ L2 十字段默认值（旧口径新造 clip 两项皆缺）。
      nextN += 1;
      clips.push({
        segId: seg.id, sid: sKey, n: nextN, label: "段" + (segIdx + 1),
        dur: seg.durationSec || 5, triml: 0, full: seg.durationSec || 5, file, state: "done", status: shot.status,
        elapsedSec: shot.elapsed_sec, // R-33：新造 clip 同口径带实际耗时（无键 undefined→概况页不显示）
        executionError: shot.execution_error, // R-34：新造 clip 同口径带失败原因（无键 undefined→详情层走兜底）
        ...defaultClipL2(),
      });
      filled++;
      changed = true;
    }
  }
  // R53 P1-c：③ 自愈兜底——同一次调用按 run_dir 去重只 browse 一次（B-S2-2）；
  //   browse 失败工具内保留原 file 不抛（B-S2-3）；自愈只写 file（localPick/ver/review/state 不动）。
  for (const g of healGroups.values()) {
    if (await healRenamedFiles(g.clips, g.runDir) > 0) changed = true;
  }
  if (changed) updateEditingState(projectId, { mainClips: clips });
  // 批 B T5：回填完成后同批重建备选轨 _reruns 系（受影响 sid = 本次 detail 的 shots keys）
  //   与 rerun_flow onFinal 的重建构成双触发——由 rebuildAltClips 幂等键（sid+引擎 seq）去重。
  //   排在 mainClips 落盘之后：候选 dur/full 取本段 clip 形态。
  rebuildAltClipsInProject(projectId, r.data, Object.keys(r.data.shots));
  return { ok: true, filled, total: Object.keys(r.data.shots).length };
}

// 批 W1 S1-T5（R-32）：全量重跑受理成功即清空剪辑域——重建走既有增量链（syncRunProducts push 分支）。
//   markers/剪辑域清 + 墓碑清（兑现弹窗「删除段重现」）·runs/队列史保留（运行历史）
//   ·画布/调色保留（不属时间线域）。批5-R53-TB：altChains 已登记 EDITING_STATE_KEYS 白名单
//   （S2-T4=本任务提前兑现）——本清空对备选链权威分组生效（此前为静默 no-op）。
//   #27：loadedTaskId 不在清空集——runFlow 受理已 F106 A 档写回最新主链 stem，指针恒指
//   最近一次提交的任务（过期场景由挂载对账自动改指兜底），清空会误杀写回致剪辑页误弹「载入历史」。
function _clearEditingForFullRerun(projectId) {
  updateEditingState(projectId, {
    mainClips: [], altClips: [], audioClips: [], markers: [],
    deletedSegIds: [],
    tracks: defaultTracks(),
    altChains: {},
  });
}

// ============================================================================
// B5-T4 C2：时间线状态着色 · 运行期 DOM 直刷（onTick 消费）
//   status.shots → #mainTrack 片段 data-shot-color；只写 DOM 属性，不落 store（3s/tick 防高频落盘）。
//   幂等：每 tick 全量重刷；renderAll 重建片段 DOM 会丢属性 → 下个 tick 自愈（3s）。
//   D-T4②：mainClips 调序持久化后数组序≠shots 序，位置对位必错染——传 clip 数据（主提交链）
//   时改 sid 对号：clip.sid（F106）→ segId → DOM data-seg-id（buildClipEl 挂）；找不到
//   （无该 sid 的 clip / DOM 无对应段）= 现找不到位行为平移（跳过不染·不新增分支）。
//   批 C C-T3：同 sid 可对应多条 clip（存量分割双半 = 左半 seg-x + 右半 split- 共享 sid）——
//     旧口径 bySid 单值 + DOM 恒中首条 → 另半段颜色不更新（同一段两半颜色不一致）。改按
//     sid 的 segId 集合全量染（两半同色 = 段状态一致）。
//   未传 clips 的旧调用形（rerun_flow 重跑链）保持位置对位不动。
// ============================================================================
export function refreshTimelineShotColors(shots, root, clips) {
  const doc = root || (typeof document !== "undefined" ? document : null);
  if (!doc || !shots || typeof shots !== "object") return 0;
  const domClips = doc.querySelectorAll("#mainTrack .clip");
  const segIdsBySid = Array.isArray(clips) ? _segIdsBySid(clips) : null;
  let hit = 0;
  let enumIdx = 0;
  for (const [sid, shot] of Object.entries(shots)) {
    const sKey = String(sid);
    const color = shotColor(shot && shot.status);
    if (segIdsBySid) {
      const segIds = segIdsBySid.get(sKey);
      for (const n of domClips) {
        if (n && n.dataset && segIds && segIds.has(n.dataset.segId) && typeof n.setAttribute === "function") {
          n.setAttribute("data-shot-color", color);
          hit++;
        }
      }
    } else {
      // P-T3 与 syncRunProducts 同笔改：s(\d+) 数值原序（子集 s0K..s0N 出现序会错染前段）
      const m = sKey.match(/shot_(\d+)/) || sKey.match(/^s(\d+)$/);
      const el = domClips[m ? (parseInt(m[1], 10) - 1) : enumIdx] || null;
      if (el && typeof el.setAttribute === "function") {
        el.setAttribute("data-shot-color", color);
        hit++;
      }
    }
    enumIdx++;
  }
  return hit;
}

// 批 C C-T3：clip 列表 → Map<sid, Set<segId>>（同 sid 多条 = 分割双半两身份·须同色）
function _segIdsBySid(clips) {
  const m = new Map();
  for (const c of clips) {
    if (!c || c.sid == null) continue;
    const k = String(c.sid);
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(c.segId);
  }
  return m;
}

// ============================================================================
// 批 M6-T2（R-30）：生效模板显示行（container 内主钮上方一行小字「本次生效模板：X」·三态）
//   X：项目级 globalParams["模板"] trim 非空 → templateNameFromPath 白话化 +「（项目级）」；
//     空串/缺省 → 应用级 gui13.paths.workflow_path（键字面量读）白话化 +「（跟随设定页）」；
//     都无 → 「（未设置）」。
//   refreshTemplateDisplay 导出供 setup.js change 直调（J3 同页联动·window 桥
//   __gui13RefreshTemplateDisplay 同 __gui13RefreshGlobals 惯例）；跨页变化靠重挂自然刷新（不挂全局钩子）。
// ============================================================================
export function templateDisplayLine(projTplRaw, appWorkflowPath) {
  const proj = String(projTplRaw == null ? "" : projTplRaw).trim();
  if (proj) return t("sb.tpl.proj", { name: templateNameFromPath(proj) });
  const name = templateNameFromPath(String(appWorkflowPath == null ? "" : appWorkflowPath).trim());
  return name ? t("sb.tpl.follow", { name }) : t("sb.tpl.unset", { name: t("sb.tpl.unsetTag") });
}

// gui13.paths 字面量读（submit.js readGuiPaths 同契约·未导出故字面量复刻·键=两侧契约）
function _readGui13Paths() {
  const s = (typeof globalThis !== "undefined" && globalThis.localStorage) || null;
  if (!s) return {};
  let obj = null;
  try { obj = JSON.parse(s.getItem("gui13.paths")); } catch (_e) { obj = null; }
  return (obj && typeof obj === "object") ? obj : {};
}

// 现役挂载显示行登记（重挂即换——_liveMount 同款「最新挂载为准」·unmount 摘本挂登记）
let _tplLine = null; // { el, pid }
export function refreshTemplateDisplay() {
  if (!_tplLine || !_tplLine.el) return false;
  const p = _tplLine.pid ? storeLoad(_tplLine.pid) : null;
  const gp = (p && p.globalParams && typeof p.globalParams === "object") ? p.globalParams : {};
  _tplLine.el.textContent = templateDisplayLine(gp["模板"], _readGui13Paths().workflow_path);
  return true;
}

// localStorage 注入（S2-1 T2 fetchSubmitPoolContext registry 读源）
function safeStorage() {
  try { return (typeof globalThis !== "undefined" && globalThis.localStorage) || null; }
  catch (_e) { return null; }
}

// ============================================================================
// 纯逻辑函数（单测覆盖）
// ============================================================================

// ---- 1. 预检错误清单渲染 ----
// 输入: 引擎 400 detail 数组 (或字符串/其它)
// 输出: 弹窗内容 HTML（行内 <div>，浏览器侧由 modal.contentNode 包装）
export function renderPreflightModalContent(detail) {
  if (!Array.isArray(detail)) {
    if (typeof detail === "string" && detail) {
      return `<div class="preflight-list">${renderItem(0, { code: "raw", msg: detail })}</div>`;
    }
    return `<div class="preflight-list"><div class="preflight-empty">${t("sb.preflight.empty")}</div></div>`;
  }
  if (detail.length === 0) {
    return `<div class="preflight-list"><div class="preflight-empty">${t("sb.preflight.empty")}</div></div>`;
  }
  const items = [];
  let seq = 0;
  for (let i = 0; i < detail.length; i++) {
    const e = detail[i];
    // 批 10-L L1-1b：引擎真机 detail = 字符串数组 ["CSV 不存在: …"]（curl 探针实测·验收找茬记录:205）
    //   ——此前只认 {code,msg} 对象项，字符串项被 skip → 整表落空 → 弹窗只出「未返回具体错误」占位（F82①）。
    //   字符串项按既有非数组字符串路径同款降级：raw code + 原文 msg（同一 .preflight-item 行结构·占号不跳号）。
    if (typeof e === "string") {
      items.push(renderItem(seq, { code: "raw", msg: e }));
      seq++;
      continue;
    }
    if (!e || typeof e !== "object") continue;
    items.push(renderItem(seq, e));
    seq++;
  }
  if (items.length === 0) {
    return `<div class="preflight-list"><div class="preflight-empty">${t("sb.preflight.empty")}</div></div>`;
  }
  return `<div class="preflight-list">${items.join("")}</div>`;
}

function renderItem(seqIdx, e) {
  const code = escapeHtml(String(e.code || ""));
  const msg = escapeHtml(String(e.msg || ""));
  return `<div class="preflight-item"><span class="preflight-num">${seqIdx + 1}.</span><span class="preflight-code">${code}</span><span class="preflight-msg">${msg}</span></div>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- 2. 按钮标签状态机 ----
// phase ∈ {idle, submitting, polling, done, failed, cancelled}
// 批 R7 · B02：idle 的 ▶ 字符换 data-ic=play 13（v43 :1148 图标在文本前 · 由 refresh 渲染图标 + 文本）
// #89 T4b：按钮文案入典（sb.btn.*）——tkey=取词键·t() 显示侧（数据面 phase 枚举键不动）
const PHASE_BUTTON_LABEL = {
  idle: { tkey: "sb.btn.idle" },
  submitting: { tkey: "sb.btn.submitting" },
  polling: { tkey: "sb.btn.polling" },
  // R-44：终态文案明示四态语义（原「已完成」/「重试运行」——前者看不出可点、
  //   后者与「部分失败也归 failed」的新口径不符）。点击=复位 idle（仅翻按钮）。
  done: { tkey: "sb.btn.done" },
  failed: { tkey: "sb.btn.failed" },
  cancelled: { tkey: "sb.btn.cancelled" },
};

export function computeButtonLabel(state) {
  const p = (state && state.phase) || "idle";
  const e = PHASE_BUTTON_LABEL[p] || PHASE_BUTTON_LABEL.idle;
  return t(e.tkey);
}

// ---- 3. phase 中文标签 ----
// #89 T4b：显示侧入典（sb.phase.*）——tkey=取词键（数据面 phase 枚举键不动）
const PHASE_LABELS = {
  idle: { tkey: "sb.phase.idle" },
  submitting: { tkey: "sb.phase.submitting" },
  polling: { tkey: "sb.phase.polling" },
  done: { tkey: "sb.phase.done" },
  failed: { tkey: "sb.phase.failed" },
  cancelled: { tkey: "sb.phase.cancelled" },
};

export function phaseLabel(phase) {
  const e = PHASE_LABELS[phase] || PHASE_LABELS.idle;
  return t(e.tkey);
}

// ---- 3b. 批1-T5 · H3：cancelled:false 两形态白话提示 ----
// 引擎 cancel 端点（api.md #1）在两种窗口返回 cancelled:false + msg：
//   ① 收尾在途 / 已无在跑任务（t 不活窗口）——等它跑完即可
//   ② 引擎句柄未就绪（启动窗口/批切换间隙·eng=None）——请稍后重试
// 纯函数（单测覆盖）；引擎 msg 非空时带出（不静默吞）。
export function cancelUnavailableToast(msg) {
  const m = String(msg || "").trim();
  if (m.includes("未就绪")) {   // 引擎 msg 词形判别=数据面·禁译
    return t("sb.cancel.notReady");
  }
  const sfx = m ? t("sb.cancel.engineWrap", { m }) : "";
  return t("sb.cancel.finishing", { sfx });
}

// ---- 4. 轮询完成 toast ----
// R-44：三参签名 (payload, projectName, failedSegs)·缺省参数退化为旧文案
//   （rerun/assets 链无参调用点兼容）。项目名去重：名尾已含「项目」不再叠加。
function _projectNameText(name) {
  const s = String(name == null ? "" : name).trim();
  return s || t("sb.name.unnamed");
}
// 批 W1 R-62（老板定版 2026-10-11「缺段提示随完成一次到位」）：引擎拼接门不拼时
//   status 端点透传顶层 concat={status:"skipped",reason,missing}（引擎 "concat": data.get("_concat")
//   域）——完成文案尾缀缺段清单，不等产物区自行发现。missing 空（关拼接等）→ 无尾缀。
function _concatMissingSuffix(payload) {
  const c = payload && payload.concat;
  const miss = (c && c.status === "skipped" && Array.isArray(c.missing)) ? c.missing : [];
  return miss.length ? t("sb.concat.missing", { list: miss.join("、") }) : "";
}
export function pollDoneToast(payload, projectName) {
  const concatSuffix = _concatMissingSuffix(payload);
  if (projectName !== undefined && projectName !== null) {
    return t("sb.done.named", { name: _projectNameText(projectName), sfx: concatSuffix });
  }
  const done = (payload && typeof payload.done === "number") ? payload.done : 0;
  const failed = (payload && typeof payload.failed === "number") ? payload.failed : 0;
  const total = (payload && typeof payload.total === "number") ? payload.total : 0;
  if (total === 0) return "0/0";
  const base = t("sb.done.base", { done, total });
  return failed > 0 ? base + t("sb.done.failSuffix", { failed }) + concatSuffix : base + concatSuffix;
}

// ---- 5. 轮询失败 toast ----
// R-44：三参签名 (payload, projectName, failedSegs)·多段失败列前 3 段 + 「等」
export function pollFailedToast(payload, projectName, failedSegs) {
  // 批 M5 T2b（F109·B 建议1）：_engineDeadByNull 分支排在 _engineDeadAfterEmpty 之前——
  //   合成终态载荷无 done/total，放其后会落泛文案「运行失败 · 已完成 0/0」（=没交代引擎中断）。
  //   文案与 core/submit.js buildNotifEntry 同源（通知中心与按钮一致）。
  if (payload && payload._engineDeadByNull === true) {
    // 批3①（T1 遗留①）接线：复核确认不可达（_engineUnreachableConfirmed）此前只有通知中心消费，
    //   toast 文案点未接 → 同一终态两通道文案不一致。现同源附提示（无标记不附·零回归）。
    const hint = (payload._engineUnreachableConfirmed === true) ? t("sb.fail.deadNullHint") : "";
    return t("sb.fail.deadNull", { sfx: hint });
  }
  if (payload && payload._engineDeadAfterEmpty === true) {
    const ms = (typeof payload._emptyStreakMs === "number") ? payload._emptyStreakMs : 0;
    return t("sb.fail.deadEmpty", { s: Math.round(ms / 1000) });
  }
  const segs = Array.isArray(failedSegs) ? failedSegs.filter((n) => Number.isFinite(n)) : [];
  if (projectName !== undefined && projectName !== null) {
    const segText = segs.length
      ? t("sb.fail.segs", { list: segs.slice(0, 3).join("、"), more: segs.length > 3 ? t("sb.fail.more") : "" })
      : t("sb.fail.plain");
    return `${_projectNameText(projectName)}${segText}`;
  }
  const done = (payload && typeof payload.done === "number") ? payload.done : 0;
  const failed = (payload && typeof payload.failed === "number") ? payload.failed : 0;
  const total = (payload && typeof payload.total === "number") ? payload.total : 0;
  return t("sb.fail.summary", { done, total, failed });
}

// ---- #40 T2 · B1：toast「查看详情」入口 ----
//   引擎把结构化错误放顶层 execution_error（api.js 归一层已透传）→ 提交期失败 toast 挂
//   一个「查看详情」按钮，点开=错误详情层（四字段 + 第 5 行「来源」·与片段层同构）。
//   toast.js 不在本次白名单（4 文件边界）→ 不改其契约，入口以按钮挂进刚落的那条 toast 节点实现。
function _toastDetailAction(onClick) {
  if (typeof document === "undefined" || typeof onClick !== "function") return null;
  const body = document.body;
  if (!body || typeof body.querySelectorAll !== "function") return null;
  const conts = body.querySelectorAll(".gui-toast-container");
  const cont = conts[conts.length - 1];
  if (!cont || typeof cont.querySelectorAll !== "function") return null;
  const toasts = cont.querySelectorAll(".gui-toast");
  const node = toasts[toasts.length - 1];
  if (!node || typeof node.appendChild !== "function") return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gui-toast__detail gui-toast__action";
  btn.textContent = t("sb.toast.detail");
  // 复用 toast 详情行的弱化字色（theme.css .gui-toast__detail 在白名单外·此处内联同款）
  btn.style.cssText = "background:transparent;border:none;padding:0;cursor:pointer;color:var(--txt3);font-size:12px;";
  btn.addEventListener("click", onClick);
  node.appendChild(btn);
  return btn;
}

// ---- #40 T2 · M1：启动失败原因白话 ----
//   run_init_error / _batch_error 四键 dict → 原因文本（exception_message 原文优先·退短码）
function _initErrReason(initErr) {
  const e = (initErr && typeof initErr === "object") ? initErr : {};
  return String(e.exception_message || e.exception_type || t("sb.initErr.unknown"));
}

// ---- 6. 流程步骤编排 ----
//
// 返回四步序列；mountSubmitBar 顺序执行：
//   build     → buildFormDataFromProject(project)
//   generate  → generateOnly(formData)
//   run       → runOnly(formData, csvPath)
//   poll      → pollStatus({ stem, outputDir, intervalMs: 3000, onTick, onFinal })
//
// 每步 run(action) 返回 Promise<{ ok, error?, csv_path?, stem?, ... }>
export function buildSubmitFlowSteps() {
  return [
    { id: "build", label: t("sb.flow.build"), run: () => Promise.resolve({ ok: true }) },  // 实际在 startFlow 入口一次性完成
    { id: "generate", label: t("sb.flow.generate"), run: () => Promise.resolve({ ok: true }) },
    { id: "run", label: t("sb.flow.run"), run: () => Promise.resolve({ ok: true }) },
    { id: "poll", label: t("sb.flow.poll"), run: () => Promise.resolve({ ok: true }) },
  ];
}

// ---- PDD 预警条可见性 ----
//   本批演示态 hasPdd 恒 false（模板状态归 S2-2 后）→ 预警条不显示
//   接口保留：hasPdd 走 getHasPddTemplate() live binding (T6 占位 false)
export function pddWarningVisible(hasPdd, formData) {
  // 演示态：恒 false（真实模板加载后接入）
  if (!hasPdd) return false;
  return pddTurboWarning(hasPdd, formData);
}

// ---- S2-1 T2: 提交池上下文（registry + assets）→ buildFormDataFromProject 第二参 ----
//   详案 B1：pool 装配依赖 registry（@N→卡名）和 assets（引擎卡缓存）
//   本函数纯异步：任一输入失败降级空对象，不阻塞提交（与 listAssets 失败语义同）
//   opts: { storage, listAssets }
//     - storage: localStorage 替身（registry 读源）；null/缺 → registry {}
//     - listAssets: () => Promise<{ok, assets}>；未传/抛错 → assets {}
export async function fetchSubmitPoolContext(opts = {}) {
  const storage = opts.storage;
  const listAssetsFn = opts.listAssets;
  let registry = {};
  let assets = {};
  // registry 读（A 审修正笔 F4：收敛 core readRegistry 单源——原内联副本与键名硬编码清）
  try {
    if (storage && typeof storage.getItem === "function") {
      registry = readRegistry(storage);
    }
  } catch (_e) { /* 隐私模式/损坏 JSON → 降级 {} */ }
  // assets 拉取（listAssets 失败/缺 → 降级 {}，buildPool 不阻塞）
  try {
    if (typeof listAssetsFn === "function") {
      const r = await listAssetsFn();
      if (r && r.ok && r.assets && typeof r.assets === "object" && !Array.isArray(r.assets)) {
        assets = r.assets;
      }
    }
  } catch (_e) { /* 网络/解析异常 → 降级 {} */ }
  return { registry, assets };
}

// ============================================================================
// S3-1 T3 feat 3: 分配策略三档校验（提交预检输入端纯函数）
//   详案 §S3-1 任务 5：分镜/拼接/自定义三档的"首帧参考图"挂用策略
//   分镜模式: 不强制·无校验（各段可各自挂）
//   拼接模式: 仅首段可挂；非首段挂图 → 警告（拼接模式下后段引擎自动锚上一段尾帧）
//   自定义模式: 独立段任意挂；拼接组（连续 concat=true 段）内仅组首段可挂
//   返回: { ok, warnings: [{code, msg, segIndex?}] }
//     ok=false → 视图层 runFlow 拦截提交并 toast 警告
// ============================================================================

const POOL_OVERFLOW_CODE = "pool_overflow";
const CONCAT_NOT_FIRST_CODE = "concat_not_first_frame";
const CHAIN_NOT_FIRST_CODE = "chain_group_not_first_frame";

/**
 * 三档分配策略校验纯函数。
 * @param {object} opts
 *   - projMode: "分镜" | "拼接" | "自定义" | 兜底（自定义规则）
 *   - segments: Array<{ prompt, concat?: boolean }>
 *   - registry: { [n]: cardName }
 *   - assets: { [cardName]: card }
 * @returns {{ ok: boolean, warnings: Array<{code: string, msg: string, segIndex: number}> }}
 */
export function validateAssignmentPolicy(opts = {}) {
  const segments = Array.isArray(opts.segments) ? opts.segments : [];
  const projMode = (typeof opts.projMode === "string") ? opts.projMode : "";
  const registry = (opts.registry && typeof opts.registry === "object") ? opts.registry : {};
  const assets = (opts.assets && typeof opts.assets === "object") ? opts.assets : {};
  const warnings = [];

  // 1) 先定位"哪些段挂图了"——pickFirstFrameRefForPrompt 用同口径反查 first_frame @N
  const firstFrameBySegIdx = new Array(segments.length).fill(false);
  for (let i = 0; i < segments.length; i++) {
    const p = (segments[i] && typeof segments[i].prompt === "string") ? segments[i].prompt : "";
    const refN = pickFirstFrameRefForPrompt(p, registry, assets);
    firstFrameBySegIdx[i] = refN != null;
  }

  // 2) 分镜模式：任务单明文"不强制·无校验"——直接返回 ok
  if (projMode === "分镜") {
    return { ok: true, warnings };
  }

  // 3) 拼接模式：仅首段（idx=0）可挂图
  if (projMode === "拼接") {
    for (let i = 1; i < segments.length; i++) {
      if (firstFrameBySegIdx[i]) {
        warnings.push({
          code: CONCAT_NOT_FIRST_CODE,
          msg: t("sb.assign.concatFirst"),
          segIndex: i,
        });
      }
    }
    return { ok: warnings.length === 0, warnings };
  }

  // 4) 自定义模式 / 兜底未知模式（最严）：拼接组内仅组首段可挂
  //   拼接组语义：连续 concat=true 的段为一组；首段（concat=false 或 第一段）是组首
  for (let i = 0; i < segments.length; i++) {
    if (!firstFrameBySegIdx[i]) continue;
    if (i === 0) continue; // 段 1 必然是任何组的组首（前面无段可拼）
    // 段 i 是否为"它所属拼接组的首段"——仅当它不是"与上一段拼接"（concat=false）
    const isGroupFirst = segments[i].concat !== true;
    if (!isGroupFirst) {
      warnings.push({
        code: CHAIN_NOT_FIRST_CODE,
        msg: t("sb.assign.chainFirst", { n: i + 1 }),
        segIndex: i,
      });
    }
  }
  return { ok: warnings.length === 0, warnings };
}

// ---- 批 8 T2b: 溢出预检文案（占用感知口径·v2-2 甲 P8） ----
//   占用含绑定时提示「绑定卡已占 N 槽」（bindingSlots = buildPool bindingSlotCount 透传）；
//   触发条件不变——本文案仍只在真溢出时随拦截 toast 出现；
//   无绑定（N=0，含仅手动占用）→ 文案=现状（零回归守门）
export function poolOverflowToast(overflow, bindingSlots) {
  const items = Array.isArray(overflow) ? overflow : [];
  const b = (typeof bindingSlots === "number" && bindingSlots > 0)
    ? t("sb.pool.boundSlots", { n: bindingSlots }) : "";
  return t("sb.pool.overflow", { bound: b, count: items.length, items: items.join("、") });
}

// ============================================================================
// 流程编排 (mountSubmitBar 调 startFlow 入口)
// ============================================================================

// 流程状态
//   phase: idle | submitting | polling | done | failed | cancelled
//   stem/csvPath/outputDir: submit 成功后保留
//   lastError: 失败时记录
async function runFlow(opts) {
  const { project, setState, hooks, startFrom, full } = opts;
  // S2-1 T2: 注入 registry + assets 给 buildFormDataFromProject 第二参（详案 B1 pool 装配前置）
  //   storage = safeStorage() localStorage；listAssetsFn = core/assets_api.js listAssets
  //   任一失败降级空对象 → buildPool 不阻塞
  const poolCtx = await fetchSubmitPoolContext({
    storage: safeStorage(),
    listAssets: listAssets,
  });
  const formData = buildFormDataFromProject(project, poolCtx);
  // S2-1 A 审修正笔 F1：姿势行溢出提交预检（详案 N2 明文"toast+提交拦截"——
  //   原实现 poolOverflow 零消费=第 9 张姿势静默丢弃，正是详案禁止的形态）
  //   批 8 T2b：文案经 poolOverflowToast 占用感知（绑定占槽时带「绑定卡已占 N 槽」）
  if (Array.isArray(formData.poolOverflow) && formData.poolOverflow.length) {
    setState({ phase: "idle", lastError: null });
    showToast("error", poolOverflowToast(formData.poolOverflow, formData.poolBindingSlots));
    return { ok: false, step: "preflight_overflow", error: { code: "pool_overflow", msg: "姿势行溢出", detail: formData.poolOverflow, httpStatus: 0 } };
  }
  // S3-1 T3 feat 3: 分配策略三档校验（详案 §S3-1 任务 5）——拼接/自定义模式下
  //   段级"挂首帧参考图"违反策略 → 拦截（弹窗 + 按钮态复位）
  //   复用既有 showPreflightModal（沿用预检弹窗形态，配 detail 数组 → DOM 编号）
  const assignmentCheck = validateAssignmentPolicy({
    projMode: project && project.projMode,
    segments: project && project.segments,
    registry: poolCtx.registry,
    assets: poolCtx.assets,
  });
  if (!assignmentCheck.ok) {
    setState({ phase: "idle", lastError: null });
    showPreflightModal(assignmentCheck.warnings);
    return { ok: false, step: "preflight_assignment", error: { code: "assignment_policy", msg: "分配策略校验未通过", detail: assignmentCheck.warnings, httpStatus: 0 } };
  }
  if (hooks && typeof hooks.onBeforeSubmit === "function") {
    hooks.onBeforeSubmit(formData);
  }

  // S1-T4（R-52 v2 GUI 侧·老板真机二轮定版 2026-10-11）：运行文件夹推导——根夹=<项目名>·子夹=<项目名_新时间戳>·
  //   runSubdir=嵌套两段「名/名_ts」；首跑与全量重跑都建新时间戳子夹（只有全量重跑再创建子夹·单段重跑不建夹）；
  //   接力沿用 runDir.current。S1-T6（老板裁决）拆闸门：输出根空也照常推导下发（引擎自回退实际输出根）；
  //   R-59-T2b：根读源=loadWorkspaceRoot()（settings.json workspace_root·旧 server_output_dir 通道已退役）；
  //   仅撞名检查按设置分流：非空才列目录（列项目根夹=输出根+清洗项目名·v2），空 → existingDirs=null 跳过。
  //   full 是「全量重跑」唯一判据（T5 标记）——禁用 startFrom 数值（firstIncomplete=1 的继续同传 0）。
  let _subdir = "", _nextRd = null;
  {
    const _outRoot = loadWorkspaceRoot();
    const _cur = (project && project.runDir && typeof project.runDir === "object") ? project.runDir : null;
    // 撞名数据：设置空 → 不调 browse（null=跳过检查）；列目录失败 → null = 跳过检查（引擎 exist_ok 静默复用兜底）
    let _dirs = null;
    if (_outRoot) {
      try {
        const _br = await listDirectory(_outRoot + "\\" + _sanitizeFolderBase(project && project.name));
        if (_br && _br.ok && Array.isArray(_br.dirs)) _dirs = _br.dirs;
      } catch (_e) { _dirs = null; }
    }
    const _d = deriveRunSubdir({
      mode: full ? "full" : (_cur && _cur.current ? "resume" : "first"),
      projectName: project && project.name,
      runDir: _cur,
      existingDirs: _dirs,
      now: new Date(),
    });
    if (!_d.ok) {
      setState({ phase: "idle", lastError: null });
      showToast("error", t("sb.subdir.exists"));
      return { ok: false, step: "run_subdir_collision", error: { code: "run_subdir_exists", msg: "运行文件夹已存在", httpStatus: 0 } };
    }
    _subdir = _d.runSubdir;
    _nextRd = _d.nextRunDir;
  }
  setState({ phase: "submitting", lastError: null });
  // T3：提交前用户原文态（深拷贝）——受理成功后落独立快照；此处取值，提交等待期编辑不污染快照
  const _snapBase = (project && project.id) ? buildRunSnapshotPayload(project) : null;

  // 第一步: 落 CSV
  const genRes = await generateOnly(formData);
  if (!genRes.ok) {
    // T9 真机走查修正：generate_csv 阶段失败（网络错/引擎 5xx）此前只改按钮状态无提示
    const _gerr = genRes.error;
    showToast("error", t("sb.gen.fail", { reason: _gerr?.msg || _gerr?.code || t("sb.gen.errFallback") }));
    // #40 T2 · I5：generate_csv 面带 execution_error（引擎 500 信封·短码 csv_generate_failed）→ 同款详情入口
    const _gee = (_gerr && !_gerr.busyKind && _gerr.executionError && typeof _gerr.executionError === "object")
      ? _gerr.executionError : null;
    if (_gee) _toastDetailAction(() => openExecErrorModal(_gee, t("sb.gen.detailTitle")));
    setState({ phase: "failed", lastError: genRes.error });
    return { ok: false, step: "generate", error: genRes.error };
  }

  // 第二步: submit
  // R-20②（P-T3）：opts.startFrom 透传 runOnly（P-T2 前置弹窗「继续完成」占位的消费点·缺省 undefined→0）
  const runRes = await runOnly(formData, genRes.csv_path, { startFrom, runSubdir: _subdir });
  if (!runRes.ok) {
    // 预检失败 → 弹窗；其它错误 → toast
    // 批 10-L L1-1（F82①）：引擎预检 400 = {ok:false, error:"预检未通过", detail:[原因…]}
    //   error 串无冒号 → api.js 信封 code=整串中文「预检未通过」·msg 空·detail 留在 error.detail。
    //   旧条件只认英文 "preflight"（永不可达）→ 恒落 toast「提交失败：预检未通过」，原因数组永不显示。
    //   收窄为「预检 code（中文精确整串 + 英文既有形态并列保留）+ 非空数组 detail」——
    //   不泛化「400+detail 数组」（rerun 等端点存在非预检 400 带数组 detail·防误弹）。
    const err = runRes.error;
    if (err && (err.code === "预检未通过" || err.code === "preflight")
        && Array.isArray(err.detail) && err.detail.length > 0) {
      showPreflightModal(err.detail);
    } else if (err) {
      showToast("error", t("sb.run.fail", { reason: err.msg || err.code || t("sb.run.errFallback") }));
      // #40 T2 · B1：带 execution_error → toast 挂「查看详情」入口（点开=四字段+来源行详情层）。
      //   busy 四族豁免不挂（暂态拒绝非错误·引擎侧本就不带键）；预检族已在上一分支弹原弹窗·不叠加。
      const _ee = (err.busyKind ? null : err.executionError);
      if (_ee && typeof _ee === "object") {
        _toastDetailAction(() => openExecErrorModal(_ee, t("sb.run.detailTitle")));
      }
    }
    setState({ phase: "failed", lastError: err, csv_path: genRes.csv_path });
    return { ok: false, step: "run", error: err, csv_path: genRes.csv_path };
  }

  // submit 成功 → 启动轮询
  setState({
    phase: "polling",
    stem: runRes.stem,
    csv_path: genRes.csv_path,
  });
  // 登记项 7：submit 成功 → 真运行历史落账（running 态·现行置顶；失败不落账）
  // W-07：stem 一并落账（六入口引擎通道钥匙——看成片 detail/回退 config/拼接 concat 都按 task_id 查）
  // R-20②（P-T3）：start_from>0 = 继续完成提交 → resume 落账（kind/label/total=子集段数）——
  //   运行期顶栏「继续中 · 从第 K 段起」文案与 onTick 增量守卫都依赖 kind 通道。
  const _segs = (project && Array.isArray(project.segments)) ? project.segments : [];
  const _resume = Number.isInteger(startFrom) && startFrom > 0;
  // T3：落运行快照（main/resume 各一份）——写失败降级 toast+runs 行 snapshot:false·提交链照常
  const _at = runStamp();
  let _snap = { recordId: "", ok: true };
  if (_snapBase) {
    _snap = await saveRunSnapshot(project.id, {
      ..._snapBase,
      at: _at,
      stem: runRes.stem || "",
      taskId: runRes.stem || "",
      kind: _resume ? "resume" : "main",
    });
  }
  appendRunRecord(project && project.id, {
    at: _at,
    total: _resume ? Math.max(_segs.length - startFrom, 0) : _segs.length,
    done: 0,
    failed: 0,
    running: true,
    stem: runRes.stem || "",
    ...(_resume ? { kind: "resume", label: `继续完成·从第 ${startFrom + 1} 段` } : {}),
    ...(_snap.recordId ? { recordId: _snap.recordId } : {}),
    ...(_snap.ok ? {} : { snapshot: false }),
  });
  // S1-T4（R-52）：runDir 落盘与 runs 落账同拍——受理失败不写（推导幂等可重放·不留脏基线）。
  if (_nextRd && project && project.id) updateProjectMeta(project.id, { runDir: _nextRd });
  // #63 T4：新提交=新当前记录——currentRunId 刷新为新记录（快照不可用 → 清指针回落 runs[0]）
  if (project && project.id) updateProjectMeta(project.id, { currentRunId: _snap.recordId || "" });
  // F106 A 档：主链落账即刷 loadedTaskId（不等终态·提交成功就翻转，概况页右键不再打旧任务）。
  //   全量 runs[0]=本次（无 kind）→ 本次 stem；resume runs[0]=resume(kind) 被跳过 → 所属全量 stem。
  //   null 守卫：无主链记录则跳过写，保原值（绝不把既有正确指向抹成 null）。
  //   #63 T4 豁免：指针钉在旧记录（显式载入）→ 跳过纠正（新提交已刷新指针·自然不命中）。
  refreshLoadedTaskAfterLanding(project && project.id);
  return { ok: true, step: "run", stem: runRes.stem, csv_path: genRes.csv_path };
}

function showPreflightModal(detail) {
  if (typeof document === "undefined") return;
  const content = document.createElement("div");
  content.innerHTML = renderPreflightModalContent(detail);
  const inst = openModal({
    title: t("sb.preflight.title"),
    sub: t("sb.preflight.sub"),
    contentNode: content,
    footerButtons: [
      (() => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "prim";
        btn.textContent = t("sb.preflight.okBtn");
        btn.addEventListener("click", () => inst.close());
        return btn;
      })(),
    ],
    closeOnBackdrop: true,
  });
}

// ============================================================================
// mountSubmitBar: 注入顶栏容器
// ============================================================================

// 批1-T5 · H3：在跑任务轮询单例（跨 TAB 重挂复用——同任务恒一条链·防叠终态通知/叠落账）
let _livePoll = null;   // { stem, handle }

// 批 9 T3 · 18-7：现役挂载登记——复用轮询链的 onFinal 闭包建链时属于首挂（DOM 随路由重建已弃），
//   终态 setState 若仍打闭包 → 现役「运行中…」按钮永不翻转。onFinal 改为 fire 时引用查询本登记
//   （getStem 与链上 stem 一致才接管——跨项目浏览时不误翻别项目按钮）。
let _liveMount = null;  // { getStem, setState, refreshBadge } 最新挂载注册；unmount 置 null

// 批 W1 F113a：重跑链副态（非接管式）——只叠角标·不动 phase 主枚举·主链态永远优先
//   数据源由 rerun_flow.js 建链/终态/停止三处通知（单向依赖·本模块不静态回引）。
const _rerunBusy = new Set();
export function notifyRerunBusy(stem) {
  if (!stem) return;
  _rerunBusy.add(stem);
  if (_liveMount && typeof _liveMount.refreshBadge === "function") _liveMount.refreshBadge();
}
export function notifyRerunIdle(stem) {
  if (!stem) return;
  _rerunBusy.delete(stem);
  if (_liveMount && typeof _liveMount.refreshBadge === "function") _liveMount.refreshBadge();
}
/** 副态计数查表口（单测用） */
export function _test_rerunBusyCount() { return _rerunBusy.size; }

// 批 9 T3 · 18-7：轮询节奏单测注入位（0=产线 3s·edit._test_setCandPollInterval 同款惯例）
let _pollIntervalMs = 0;
export function _test_setPollInterval(ms) { _pollIntervalMs = ms; }

// 批 M5b T2（R-48）：重跑对账步探活结果注入位（_test_setPollInterval 同款惯例）——
//   null=产线走真 /system_stats 双拍；true/false=单测注入首拍结果（免 3s 间隔·对账步专用，
//   不影响主链 _probeThenResumePoll）。
let _rerunProbeOverride = null;
export function _test_setRerunProbe(ok) { _rerunProbeOverride = (ok === true || ok === false) ? ok : null; }

// R-20①②（批 10-P P-T2）单测注入位（_test_setPollInterval 同款惯例）：前置弹窗/runFlow 替身——
//   单测断言弹窗参数、「跑/不跑」与 startFrom 占位入参。null=产线用本模块导入实现。
let _openConfirmFn = null;
let _openModalFn = null;
let _runFlowFn = null;
export function _test_setOpenConfirm(fn) { _openConfirmFn = typeof fn === "function" ? fn : null; }
export function _test_setOpenModal(fn) { _openModalFn = typeof fn === "function" ? fn : null; }
export function _test_setRunFlow(fn) { _runFlowFn = typeof fn === "function" ? fn : null; }

// ============================================================================
// B7-T1 · C1 实时推流挂连（WS 仅增强·轮询链零改动）：
//   提交成功且 stem 非空 → connectLive（core/push.js·ComfyUI 原生 /ws）：
//     onFrame   → preview 帧缓存/宿主（pushLiveFrame·blobUrl 最新帧胜出）
//     progress  → preview live 进度（value/max → 0..1 百分比·percent 态）
//     error     → 通知中枢（ui/notif.js 留档+桌面提醒）
//     onStatus  → preview 三态降级条；非 open（断流）→ 进度回退 phase 态（不冻结假百分比）
//   pollStatus onFinal → 关连接（运行结束≠断线兜底——降级条隐藏·进度停表）
//   连接为模块级单例：跨 TAB 重挂存活（submit-bar 随路由重建·连接不断）；下次提交原位替换。
// ============================================================================
let _liveWs = null;
let _liveDone = false; // 终态收尾：抑制 close 引发的「已断开」降级文案（运行已结束≠断线兜底）

function _liveErrMsg(data) {
  const d = (data && typeof data === "object") ? data : {};
  const msg = d.error || d.message || d.msg;
  return msg ? String(msg) : t("sb.live.err");
}

function stopLive() {
  if (!_liveWs) return;
  const h = _liveWs;
  _liveWs = null;
  try { h.close(); } catch (_e) { /* 已断忽略 */ }
}

function startLive() {
  // 环境守卫（core/api.js BASE_URL 判定同款口径）：无 location 的环境（Node 单测桩）不建真连接
  //   ——防测试进程真连引擎 ws 后被开放句柄吊住；浏览器/file:// 恒有 location 不受影响。
  if (!(typeof globalThis.location === "object" && globalThis.location)) return;
  stopLive();
  _liveDone = false;
  _liveWs = connectLive({
    onFrame: pushLiveFrame,
    onEvent: (type, data) => {
      if (type === "progress") {
        const v = Number(data && data.value);
        const m = Number(data && data.max);
        if (Number.isFinite(v) && Number.isFinite(m) && m > 0) {
          pushLiveProgress(Math.min(1, Math.max(0, v / m)));
        }
        return;
      }
      if (type === "error") {
        try { pushNotif({ type: "error", text: t("sb.live.renderErr", { msg: _liveErrMsg(data) }) }); } catch (_e) { /* 通知中心不可用不影响主链 */ }
      }
    },
    onStatus: (kind) => {
      // 批 9 T3 · 18-3：终态主动关连后 close 常伴 onerror（error 态）——两态都不再示「断线兜底」
      if (_liveDone && (kind === "closed" || kind === "error")) return;
      pushLiveStatus(kind);
      if (kind !== "open") pushLiveProgress(null); // 断流/重试中 → 进度回退 phase 态（已等待计时）
    },
  });
}

// ============================================================================
// R-20①②（批 10-P P-T2）：提交前置路由（R-20① 已完成确认重跑 / R-20② 未完成三选）
//   判定消费 store.deriveProjectCompletion（P-T1）；ran=false（无 runs 且零产物）→ 直跑
//   不弹（新项目直跑/画布 autorun 语义保持——方案 §二 P-T2 路由表）。
// ============================================================================

// 前置路由判定：{action:"run"} | {action:"confirm",segCount} | {action:"resume",segCount,doneCount,firstIncomplete}
function _preRunGate(project) {
  const segs = project && Array.isArray(project.segments) ? project.segments : [];
  const clips = project && project.editingState && Array.isArray(project.editingState.mainClips) ? project.editingState.mainClips : [];
  const runs = project && Array.isArray(project.runs) ? project.runs : [];
  const comp = deriveProjectCompletion(segs, clips, runs);
  if (!comp.ran) return { action: "run" };
  if (comp.complete) return { action: "confirm", segCount: comp.segCount };
  const firstIncomplete = _firstIncompleteSegNo(segs, clips);
  if (firstIncomplete == null) return { action: "confirm", segCount: comp.segCount }; // 0 段边角：无「继续」起点 → 随确认弹窗走全量
  return { action: "resume", segCount: comp.segCount, doneCount: comp.doneCount, firstIncomplete };
}

// 第一个未完成段序号（1-based）——file 门与 store.js deriveProjectCompletion 逐字同口径（同步维护）
function _firstIncompleteSegNo(segments, mainClips) {
  const bySegId = new Map();
  for (const c of (Array.isArray(mainClips) ? mainClips : [])) {
    if (c && c.segId != null) bySegId.set(c.segId, c);
  }
  const segs = Array.isArray(segments) ? segments : [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const c = s && s.id != null ? bySegId.get(s.id) : null;
    const has = !!(c && c.file && (c.state === "done" || c.state === "warn"));
    if (!has) return i + 1;
  }
  return null;
}

// 前置弹窗形态：complete 确认两钮 / incomplete 三选 footer（open() 自组·shell.js 拼接浮层两钮先例）
function _openPreRunDialog(gate, proceed) {
  if (gate.action === "confirm") {
    (_openConfirmFn || openConfirmModal)({
      title: t("sb.rerun.title"),
      sub: t("sb.rerun.sub", { n: gate.segCount }),
      confirmText: t("sb.common.fullRerun"),
      cancelText: t("sb.common.cancel"),
      onConfirm: () => proceed(0, { full: true }),
    });
    return;
  }
  const mkBtn = (cls, text) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; return b; };
  const cancelBtn = mkBtn("ghostbtn", t("sb.common.cancel"));
  const fullBtn = mkBtn("ghostbtn", t("sb.common.fullRerun"));
  const resumeBtn = mkBtn("prim", t("sb.rerun.resumeBtn", { n: gate.firstIncomplete }));
  const inst = (_openModalFn || openModal)({
    title: t("sb.rerun.pickTitle"),
    sub: t("sb.rerun.pickSub", { done: gate.doneCount, total: gate.segCount }),
    footerButtons: [cancelBtn, fullBtn, resumeBtn],
    closeOnBackdrop: true,
  });
  cancelBtn.addEventListener("click", () => inst.close());
  fullBtn.addEventListener("click", () => { inst.close(); proceed(0, { full: true }); });
  resumeBtn.addEventListener("click", () => { inst.close(); proceed(gate.firstIncomplete - 1); });
}

// #64：本会话停止成功过的 stem——终态判据「因停止而终」的会话侧证据（停止与终态 tick
//   存在竞态窗口，单靠载荷 stopped 段不足以覆盖）。新提同一 stem 时清除（真新任务）。
const _stoppedStems = new Set();
export function _test_resetStoppedStems() { _stoppedStems.clear(); }

// 段级 stopped 计数（判据与 core/submit.js:918 _stoppedCount 同源；该函数未导出，只读复刻）。
//   严禁用 failed>0 当停止判据——引擎 stopped 不计 failed，且 failed>0 补后期是 #33 既有设计。
function _stoppedSegCount(payload) {
  const shots = (payload && typeof payload.shots === "object" && payload.shots) ? payload.shots : null;
  if (!shots) return 0;
  let n = 0;
  for (const k in shots) {
    const s = shots[k];
    if (s && typeof s === "object" && s.status === "stopped") n++;
  }
  return n;
}

// opts: { container, project, getProject?, onPhaseChange?, onComplete?, onFailed?, onSubmitted? }
//   - project: 挂载时刻的项目快照（向后兼容保留）
//   - getProject: () => project 函数；点击提交时优先调用此活读取最新项目（穿透挂载后的 store 编辑）
//   - onSubmitted: (stem) => void 提交受理成功（run ok 且有 stem·轮询启动那一拍）恰一次；
//     失败/取消/恢复链不触发（批 9 T3 · 18-8：shell 接线自动切 preview TAB 用）
// 返回 handle: { refresh, getPhase, submit, cancel }
export function mountSubmitBar(opts) {
  if (!opts || typeof document === "undefined" || !opts.container) return null;
  const { container, project, getProject, onPhaseChange, onComplete, onFailed, onSubmitted } = opts;
  const state = { phase: "idle", stem: null, csv_path: null, outputDir: "", lastError: null };
  let pollHandle = null;

  function setState(patch) {
    Object.assign(state, patch);
    if (typeof onPhaseChange === "function") {
      try { onPhaseChange(state); } catch (_) { /* swallow */ }
    }
    refresh();
  }
  // 批 9 T3 · 18-7：本挂载登记为现役（复用链 onFinal 引用查询·见 _liveMount 声明处注记）
  _liveMount = { getStem: () => state.stem, setState, refreshBadge: renderButtonLabel };

  // 批 R7 · B02：idle 态 = data-ic=play 13 图标 + 文本（v43 :1148）；其余态纯文本
  function renderButtonLabel() {
    const label = computeButtonLabel(state);
    button.textContent = ""; // 真 DOM 语义：清空既有子节点/文本
    if (state.phase === "idle") {
      const ic = document.createElement("span");
      ic.setAttribute("data-ic", "play");
      ic.setAttribute("data-sz", "13");
      button.appendChild(ic);
      hydrateIcons(button); // 扫 button 子树注 svg（幂等）
    }
    button.appendChild(document.createTextNode(label));
    // 批 W1 F113a：重跑链副态角标（非接管式·主标签口径零改·视觉精修待真机复验后再定）
    if (_rerunBusy.size > 0) {
      const badge = document.createElement("span");
      badge.className = "tb-rerun-badge";
      badge.textContent = t("sb.rerun.badge");
      button.appendChild(badge);
    }
  }

  function refresh() {
    if (!button) return;
    renderButtonLabel();
    // 批1-T5 · H3 三态文案：空闲「运行项目」/ 运行中「运行中…」（主钮可点=取消）+ 独立「停止」钮
    const running = state.phase === "submitting" || state.phase === "polling";
    button.disabled = state.phase === "submitting";  // 运行中不再禁用——二次点击主钮=取消路径真实可达
    button.title = state.phase === "polling" ? t("sb.btn.busyTitle") : "";
    button.dataset.phase = state.phase;
    if (stopBtn) stopBtn.style.display = running ? "" : "none";
  }

  function startPoll(stem, csvPath, projSnapshot, histOpts) {
    // 批1-T5 · H3 还款②：同一 stem 已在轮询 → 复用（跨 TAB 重挂恢复路径）
    //   走查反馈⑧ 恢复链修好后每次重挂都会按 runs[0].running 重启轮询 → 同任务多链
    //   （终态重复通知/重复落账）。复用即：同任务恒一条链。
    if (_livePoll && _livePoll.stem === stem && _livePoll.handle) {
      if (pollHandle && pollHandle !== _livePoll.handle && typeof pollHandle.stop === "function") pollHandle.stop();
      pollHandle = _livePoll.handle;
      return;
    }
    if (pollHandle && typeof pollHandle.stop === "function") pollHandle.stop();
    // 批 10-L L1-3（F92a）：入轨节流计数（链级·新链回零）——done 变化才调 syncRunProducts
    let lastSyncDone = 0;
    const h = pollStatus({
      stem,
      outputDir: state.outputDir,
      intervalMs: _pollIntervalMs || 3000,
      // 批 M5 T2b（F109）：主链接入引擎无响应阈值——引擎进程被 kill 后 status 恒失败拍，
      //   20 拍（3s 间隔）内由 core 合成中断终态走 onFinal 原路（opt-in·仅本链传）。
      deadAfterNulls: 16,
      // R-44 I5：项目名管道（闭包快照名·非活读 getProject）——终态通知带项目名
      projectName: (projSnapshot && projSnapshot.name) || "",
      // G2·#57：落账透传——attach=true 恢复链挂旧行不新增（防刷新重建重复行）；
      //   kind=行来源字段（main/resume·提交点按 startFrom 分档）
      historyAttach: !!(histOpts && histOpts.attach === true),
      historyKind: (histOpts && typeof histOpts.kind === "string") ? histOpts.kind : "",
      // B5-T4 C2：每 tick 幂等重刷片段状态左边条（DOM-only·不写 store）
      onTick: (data) => {
        // D-T4②：着色改 sid 对号——clip 数据每拍活读（syncRunProducts 增量入轨会改 mainClips 序/sid）；
        //   pid/pc 上提供下方增量落账复用（同一拍内无 await，两次读等价）。
        const pid = ((typeof getProject === "function" && getProject()) || project || {}).id;
        const pc = pid ? storeLoad(pid) : null;
        refreshTimelineShotColors(
          data && data.shots,
          null,
          (pc && pc.editingState && Array.isArray(pc.editingState.mainClips)) ? pc.editingState.mainClips : null,
        );
        // 批 9 T3 · 17-2：done 计数变化即增量落账——顶栏「渲染中 N/M 段完成」随 tick 前进
        //   （此前仅 onFinal 终态写 → 全程恒 0/N·审片门暂停期最刺眼）；只在计数变化时写
        //   store（段完成分钟级·不破 3s/tick 防高频落盘口径）；只打主提交记录（!kind·恢复链同口径）。
        const d = data && typeof data.done === "number" ? data.done : null;
        if (d != null) {
          // 批 10-L L1-3（F92a）：done 变化即增量入轨——生成中片段条/剪辑页即时可见
          //   （此前只在 onFinal 终态入轨 → 全程零更新·跑完才一次性出现·观感卡死）。
          //   红线：禁每拍必调。history/detail 每次触发引擎侧分辨率并发探测 Semaphore(4)，
          //   3s 一拍全调会压引擎 → 仅计数变化拍触发（函数自身幂等·可复调）。
          if (d !== lastSyncDone) {
            lastSyncDone = d;
            void syncRunProducts(pid, stem);
          }
          const p0 = pc;
          const r0 = p0 && Array.isArray(p0.runs) ? p0.runs[0] : null;
          // P-T3：resume 记录（kind:"resume"）同样增量落账——继续完成运行期顶栏有进度
          // G1·#49：落账条件放宽为 percent 变化即写（含 failed 变化路径——failed 计入分子），
          //   顶栏/概况页两条灰条的消费数据源；percent 本体由 settleLatestRun 落账时统一换算
          //   （total=0 防除零不写）。同值拍不写（防高频落盘口径保持）。
          if (r0 && (!r0.kind || r0.kind === "resume") && r0.running === true && r0.stem === stem) {
            const fRaw = (data && typeof data.failed === "number") ? data.failed : null;
            const f = fRaw != null ? fRaw : (Number(r0.failed) || 0);
            const pct = runPercent({ total: r0.total, done: d, failed: f });
            const changed = r0.done !== d
              || (fRaw != null && r0.failed !== fRaw)
              || (pct != null && r0.percent !== pct);
            if (changed) {
              settleLatestRun(pid, { done: d, ...(fRaw != null ? { failed: fRaw } : {}) });
            }
          }
        }
      },
      onError: () => {},
      onFinal: (payload) => {
        if (_livePoll && _livePoll.handle === h) _livePoll = null;
        // 批 9 T3 · 18-7：终态 setState 打现役挂载（引用查询+stem 代际校验）——
        //   复用链闭包的 setState 只打建链时挂载（DOM 已弃）；现役在跟同 stem 才接管，
        //   否则（跨项目浏览/无挂载）回退闭包本尊。
        const _st = (_liveMount && _liveMount.getStem() === stem) ? _liveMount.setState : setState;
        // B7-T1 · C1：轮询终态 → 关实时推流连接（运行结束≠断线兜底——降级条隐藏·进度停表回缓存清）
        _liveDone = true;
        stopLive();
        pushLiveStatus("");
        pushLiveProgress(null);
        // R-44 I2：闭包项目快照——终态落账/toast/通知一律取运行发起时的 project（id/name），
        //   不取 getProject() 活读（活读会跨项目错写：A 项目跑完切到 B 时终态写进 B 的 runs）。
        const _proj = projSnapshot || project || {};
        const _pid = _proj.id;
        const _pname = _proj.name || "";
        const _stem = stem;
        // R-44：终态落盘三字段——result(done|failed·部分失败=failed)/resultAck:false/failedSegs
        const _done = (payload && typeof payload.done === "number") ? payload.done : 0;
        const _failed = (payload && typeof payload.failed === "number") ? payload.failed : 0;
        // 批 M5 T2b（F109·A-R1 + B 建议4）：引擎中断双标记归一 payload 侧判定——
        //   _engineDeadByNull=合成终态（引擎进程已死）/ _engineDeadAfterEmpty=空清单宽限到期（历史残留口径）。
        //   原式读 state._engineDeadAfterEmpty：state 侧从未写入 = 死读；漏认 byNull 则 _result 落 done 走「任务完成」=谎报。
        const _dead = !!(payload && (payload._engineDeadByNull === true || payload._engineDeadAfterEmpty === true));
        // #40 T2 · M1：启动期失败双通道（run_init_error=manifest 前死 / _batch_error=manifest 后死）→
        //   判 failed（不再落 done 走「任务完成」=谎报）+ toast 白话「任务启动失败：原因」。
        const _initErr = (payload && (payload.run_init_error || payload._batch_error)) || null;
        // #64 停止判据：本次会话停过同一 stem（cancelCurrent 成功置标记）或载荷含 stopped 段。
        //   引擎 stopped 不计 failed → 停止终态与自然完成在 failed/done 上不可区分；严禁拿
        //   failed>0 当停止判据（#33 failed>0 补后期是既有设计）。
        const _wasCancelled = state.phase === "cancelled";
        const _stopped = _stoppedStems.has(_stem) || _stoppedSegCount(payload) > 0;
        const _result = (_dead || _failed > 0 || _initErr) ? "failed" : "done";
        const _failedSegs = deriveFailedSegs(payload);
        // G3·#50：引擎 concat 状态随终态冻结落 runs 行（纯透出·R-62 门/裁决C 零变更；
        //   展示与人话化在 ui/queue.js 提交历史行。无 concat 载荷不落键）
        const _concatStatus = deriveConcatStatus(payload);
        settleLatestRun(_pid, {
          done: _done,
          failed: _failed,
          running: false,
          stem: _stem,
          // #64：停止不落 result（不与「任务完成/失败」混淆）——interrupted+reason 供显示与判定
          ...(_stopped
            ? { interrupted: true, reason: "user_stopped" }
            : { result: _result, resultAck: false, failedSegs: _failedSegs }),
          ...(_concatStatus ? { concatStatus: _concatStatus } : {}),
          // 批 M5 T2b：中断终态额外落 interrupted/reason（引擎不可达·非段级失败）——
          //   独立 phase 枚举不新增（复用 failed 口径），字段供刷新后判定与测试断言。
          ...(_dead ? { interrupted: true, reason: "engine_unreachable" } : {}),
        });
        // 走查反馈⑦：产物自动入轨（预览/剪辑即刻可见）
        // #33（甄别报告 2026-10-19）：onComplete 派发延到回轨 settle 之后（复刻重跑链
        //   rerun_flow.js:104 定序形态）——首跑形态 mainClips 全程空（单段 done 恒 0·onTick
        //   增量入轨从未触发），同步派发会让编排抢在 detail 回轨前读空轨 → 空集 noop 静默。
        //   回轨失败不拦派发（照发桥·编排读现态——与重跑补链同口径）。
        const _syncP = syncRunProducts(_pid, _stem);
        _syncP.catch(() => {}).then((sr) => {
          if (sr && sr.ok && sr.filled > 0) showToast("success", t("sb.sync.done", { n: sr.filled }));
        });
        // R-57：onComplete 载荷补带 taskId=本次 stem——轮询终态引擎数据不含任务号，
        //   shell 编排靠此直递（#27 后指针已恒持 stem，直递仍是三路首选·R-57 链路保持有效）。
        const _onCompletePayload = { ...payload, taskId: _stem };
        // 区分完成 vs 失败（R-44 口径裁决：部分失败=failed 态·与 ui/queue.js deriveSubmitStatus 同口径）
        if (_initErr) {
          // #40 T2 · M1：启动失败（受理后立刻死）→ failed + 白话原因（不落「任务完成」）
          _st({ phase: "failed" });
          showToast("error", t("sb.initErr.fail", { reason: _initErrReason(_initErr) }));
          if (typeof onFailed === "function") try { onFailed(payload); } catch (_e) {}
        } else if (_dead) {
          _st({ phase: "failed" });
          showToast("error", pollFailedToast(payload, _pname, _failedSegs));
          if (typeof onFailed === "function") try { onFailed(payload); } catch (_) {}
        } else if (_stopped) {
          // #64：因停止而终 ≠ 完成——不派发 onComplete（不启动后期编排）。
          _st({ phase: "cancelled" });
          if (!_wasCancelled) showToast("warn", stoppedNotifEntry(payload).text);   // 取消链已 toast「已停止」不重复
        } else if (_failed > 0) {
          _st({ phase: "failed" });
          showToast("warn", pollFailedToast(payload, _pname, _failedSegs));
          // #33：派发延到回轨 settle 后（失败段补后期同样须读到回轨后 mainClips）
          if (typeof onComplete === "function") {
            _syncP.catch(() => {}).then(() => { try { onComplete(_onCompletePayload); } catch (_) {} });
          }
        } else {
          _st({ phase: "done" });
          showToast("success", pollDoneToast(payload, _pname, _failedSegs));
          if (typeof onComplete === "function") {
            _syncP.catch(() => {}).then(() => { try { onComplete(_onCompletePayload); } catch (_) {} });
          }
        }
      },
    });
    pollHandle = h;
    _livePoll = { stem, handle: h };
  }

  // 按钮
  // 走查反馈⑥（画布「运行」按钮真跑）：autorun 锚点——画布 runProject 跳来后自动触发一次提交
  //   （预检失败/引擎错误走既有弹窗/toast 链，不静默；锚点一次性消费防循环）
  try {
    if (sessionStorage.getItem("gui13.autorun") === "1") {
      sessionStorage.removeItem("gui13.autorun");
      setTimeout(() => {
        if (state.phase === "idle" && button && !button.disabled) {
          showToast("info", t("sb.autorun.toast"));
          button.click();
        }
      }, 500); // 等挂载渲染稳定
    }
  } catch (_e) { /* sessionStorage 不可用忽略 */ }
  // 批 M6-T2（R-30）：生效模板显示行（主钮上方一行小字·三态 templateDisplayLine）+
  //   window 桥登记（setup.js「模板」change 直调入口·J3）
  const tplLine = document.createElement("div");
  tplLine.className = "submit-tpl-line";
  tplLine.style.cssText = "font-size:11px;opacity:.65";
  container.appendChild(tplLine);
  _tplLine = { el: tplLine, pid: (project && project.id) || null };
  refreshTemplateDisplay();
  if (typeof window !== "undefined") {
    window.__gui13RefreshTemplateDisplay = () => refreshTemplateDisplay();
  }

  const button = document.createElement("button");
  button.type = "button";
  button.id = "submitBtn";
  button.className = "prim submit-btn";
  button.addEventListener("click", async () => {
    if (state.phase === "submitting" || state.phase === "polling") {
      // 二次点击 → 弹「是否中断当前任务？」确认层（R-44 §三.3·老板四态「忙=点击问是否中断」）
      _confirmStopCurrent();
      return;
    }
    // R-44 §三.2：终态点击 = 一次性复位（仅翻按钮·不重跑·不重发 toast）
    //   toast/通知在 onFinal 到达即发（防双发）；此处只置 resultAck 让下次挂载不再翻终态。
    if (state.phase === "done" || state.phase === "failed") {
      const _pp = ((typeof getProject === "function" && getProject()) || project || {});
      if (_pp.id) ackRunResult(_pp.id, state.stem || "");
      setState({ phase: "idle" });
      return;
    }
    // S2-2 FIX-1：点击时活读取最新项目（穿透挂载后的 store 编辑），project 参数保留作向后兼容兜底
    const liveProject = typeof getProject === "function" ? getProject() : project;
    // R-20①②（批 10-P P-T2）：前置路由插点（现有 phase 守卫之后·runFlow 之前）
    // S1-T5：opts.full=弹窗全量入口标记（仅两全量入口携带·「继续」与首跑不带——
    //   firstIncomplete=1 时「继续」同传 startFrom=0，数值判据会把合法继续误清）。
    const _startRun = async (startFrom, opts) => {
      const full = !!(opts && opts.full);
      const result = await (_runFlowFn || runFlow)({
        project: liveProject,
        setState,
        hooks: { onBeforeSubmit: null },
        // R-20② 继续完成通道参数：startFrom>0 → runOnly 透传引擎 start_from（P-T3 已接线·ba3c9a1）
        startFrom,
        // S1-T5：全量重跑标记（受理成功后清空剪辑域·清空在 _startRun 内消费·runFlow 本体零改）
        full,
      });
      if (result.ok && result.stem) {
        // S1-T5：受理成功即清空剪辑域（409/预检失败不清）·重建走既有增量链
        if (full) _clearEditingForFullRerun(liveProject.id);
        _stoppedStems.delete(result.stem);   // #64：真新任务同 stem → 清旧停止标记
        // R-44 I2：闭包项目快照传给轮询链——终态落账/toast 项目名取此（不活读 getProject）
        // G2·#57：histOpts=队列行来源字段（直跑 main·继续完成 resume）
        startPoll(result.stem, result.csv_path, liveProject, { kind: startFrom > 0 ? "resume" : "main" });
        startLive(); // B7-T1 · C1：提交成功且 stem 非空 → 实时推流（WS 仅增强·轮询链零改动）
        // 批 9 T3 · 18-8：提交受理成功回调（恰此一拍——失败/恢复链不触发）
        if (typeof onSubmitted === "function") {
          try { onSubmitted(result.stem); } catch (_) { /* 回调异常不阻断轮询链 */ }
        }
      }
    };
    const _gate = _preRunGate(liveProject);
    if (_gate.action === "run") {
      await _startRun(0);
      return;
    }
    // 竞态守卫（弹窗期间切 TAB 起跑/删项目的脏态防护）：确认回调时点复查——占用
    //   （submitting/polling·与上方点击守卫同口径）或项目已删 → 按取消处理。
    const _proceed = (startFrom, opts) => {
      if (state.phase === "submitting" || state.phase === "polling" || !storeLoad(liveProject && liveProject.id)) {
        showToast("info", t("sb.guard.stateChanged"));
        return;
      }
      void _startRun(startFrom, opts);
    };
    _openPreRunDialog(_gate, _proceed);
  });
  container.appendChild(button);

  // 批1-T5 · H3：运行中态独立「停止」钮（ghostbtn·同 cancel 端点）——主钮二次点击取消之外的
  //   显式入口（运行中主钮文案=运行中…，停止语义靠本钮承载；两入口并存）
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.id = "submitStopBtn";
  stopBtn.className = "ghostbtn submit-stop-btn";
  stopBtn.textContent = t("sb.stop.btn");
  stopBtn.title = t("sb.stop.title");
  stopBtn.style.display = "none";
  stopBtn.addEventListener("click", () => { _confirmStopCurrent(); });
  container.appendChild(stopBtn);

  // 走查反馈⑧（2026-09-27 老板报：运行中切 TAB 后按钮回「运行项目」）：
  //   挂载时读 runs[0] 恢复在途态——running=true 且有 stem → 重启轮询（状态跨 TAB/跨视图不失忆）
  // 批1-T5 还款：原位置在 const button 之前 → refresh() 读 button 落 TDZ 抛错被 catch 吞掉，
  //   恢复链从未生效；本件把它挪到按钮/停止钮建好之后（恢复即渲染运行中态+停止钮可见）。
  try {
    const _p0 = typeof getProject === "function" ? getProject() : project;
    const _r0 = _p0 && Array.isArray(_p0.runs) ? _p0.runs[0] : null;
    // B4-T2 + R-44：恢复链认「无 kind 字段」的主提交记录 + kind:"resume"（R-20②「继续完成」
    //   落账恰写 kind:"resume"——原 `!_r0.kind` 排除误伤它·切页/刷新后按钮回 idle·轮询死）。
    //   其余 kind（rerun/seg_edit 两类重跑链）仍排除：重跑链自持轮询
    //   （views/rerun_flow.pollAndSettle 按 stem settle），被主链接管会成双链双 toast。
    if (_r0 && _r0.running === true && _r0.stem && (!_r0.kind || _r0.kind === "resume")) {
      state.stem = _r0.stem;
      setState({ phase: "polling", stem: _r0.stem });
      // 批 M5 T2b（F109·B-3-9/3-10）：重启轮询前先探引擎活——引擎已死时轮询只会恒失败拍空转
      //   （按钮恒「运行中」= F109 症状）。双拍全失败 → 不重启·落中断终态；任一拍通 → 照旧重启。
      void _probeThenResumePoll(_p0, _r0);
      // R-44 S4：startLive 单例守卫——模块级 WS 已在（跨 TAB 存活）则不动·仅刷新后
      //   （_liveWs=null）重建。无条件 startLive 会 stopLive 掐断跨 TAB 连接
      //   （切页往返必断连重连 + 降级条闪 = 本批要修的场景）。
      if (!_liveWs) startLive();
    } else if (_r0 && _r0.running !== true && _r0.result && !_r0.resultAck && (!_r0.kind || _r0.kind === "resume")) {
      // R-44：终态恢复链（顺序在 running 之后）——未确认终态落盘 → 按钮显「任务完成/任务失败」
      //   跨刷新；resultAck 已置位（用户已复位）→ 不重复翻。
      //   kind 排除与上方 running 分支同口径：M5b-T1 给重跑链中断 settle 加 result:"failed" 后，
      //   rerun/seg_edit 终态行会误命中本分支劫持主按钮（全任务主链并未失败）——其「已中断」
      //   语义由运行记录区 buildRunRow（shell.js）承担，主按钮保持 idle。
      // 批 M5 T2b（F109·A-S5）：中断终态（interrupted+reason）同走本分支——显通用「任务失败」态，
      //   不渲染 interrupted 专属文案（无渲染点·字段仅供判定与测试断言）。
      state.stem = _r0.stem || state.stem;
      setState({ phase: _r0.result });
    }
  } catch (_e) { /* 恢复失败按 idle 走（不影响正常使用） */ }

  // 批 M5b T2（R-48·刷新断链对账）：重跑链的轮询持有者随刷新弃掉（rerun_flow 模块级活链表随页重建），
  //   刷新后行恒「重跑中…」至天荒地老——引擎活着也不翻。档 A 保守：主链分支一行未动（防双链双 toast），
  //   这里只补对账步：引擎活 → 重挂重跑链；双拍全死 → 落中断终态（不复活「重跑中」）。
  void _reconcileRerunRuns(typeof getProject === "function" ? getProject() : project);

  // F109 恢复链探活（引擎跑活才重启轮询）：探 /system_stats 连拍 2 次（间隔 3s·单请求 10s 超时·
  //   批3 #48 自 2s 迁移·TIMEOUTS.probe 单值），
  //   全失败 = 引擎不可达 → settleLatestRun 两参（带 stem·按记录定位·缺 stem 会误写 runs[0] 他记录）
  //   落中断终态并翻失败按钮。任一拍通 → 照旧重启轮询（终态由轮询自落兜底）。
  //   双拍期按钮已先显「运行中」，最坏多等 ~23s 才翻态（10+3+10·B 建议5 观感登记·批3 值迁移后复算）。
  async function _probeThenResumePoll(proj, r0) {
    for (let i = 0; i < 2; i++) {
      if (i > 0) await _probeGap();
      if (await _probeAliveOnce()) {
        // G2·#57：attach:true——同 taskId 已有 running 行挂旧行不新增（刷新重建后同 stem 恒 1 行）
        startPoll(r0.stem, "", proj, { attach: true, kind: r0.kind || "main" });
        return;
      }
    }
    settleLatestRun(proj && proj.id, {
      running: false,
      result: "failed",
      resultAck: false,
      interrupted: true,
      reason: "engine_unreachable",
      stem: r0.stem,
    });
    // G2·#57：队列历史行同口径收口——running 行翻 failed（治 running 残留第二来源；
    //   recordSubmitFinal 只认 id → 按 taskId===stem && running 自扫命中·照 M5b-T2 对账步先例）
    for (const e of loadHistory()) {
      if (e && e.taskId === r0.stem && e.status === "running") recordSubmitFinal(e.id, { _engineDeadByNull: true });
    }
    setState({ phase: "failed" });
  }

  // F109 探活单拍（主链恢复链与 M5b T2 重跑对账步共用口径：/system_stats + 10s 超时·TIMEOUTS.probe）
  //   地基批1档2 T3：探测动作改走 settings.refreshChip 同源出口（探测体单一化·失败拍芯片同帧落 idle）；
  //   连拍 2 次 / 间隔 3s / 单请求 10s 超时（批3 #48 值迁移·TIMEOUTS.probe）/ 返回形态（布尔）编排逻辑一字未动。
  async function _probeAliveOnce() {
    try {
      const info = await refreshChip({ timeoutMs: TIMEOUTS.probe });
      return !!(info && info.ok);
    } catch (e) { return false; }   // refreshChip 已内吞网络错·此处仅防注塑态抛出
  }

  // 两拍间隔（Node 单测续探定时器不吊住测试进程·对齐 core/submit.js _pushStopNotif 口径）
  function _probeGap() {
    return new Promise((res) => {
      const t = setTimeout(res, 3000);
      if (t && typeof t.unref === "function") t.unref();
    });
  }

  // 批 M5b T2：重跑行对账步（重跑链断链修复）
  //   行龄门 24h：r.at 是 runStamp 本地字符串（"YYYY-MM-DD HH:mm"·禁字符串直比数字），
  //   超 24h 的 running 行不参与对账——陈旧跨日行误报代价大于漏报（后续批对账清扫另立）。
  async function _reconcileRerunRuns(proj) {
    const pid = proj && proj.id;
    if (!pid) return;
    try {
      const rows = (proj && Array.isArray(proj.runs)) ? proj.runs : [];
      const targets = rows.filter((r) => r && r.running === true && r.stem
        && (r.kind === "rerun" || r.kind === "seg_edit")
        && Date.parse(r.at) > Date.now() - 24 * 3600 * 1000);
      if (targets.length === 0) return;
      const alive = await _probeRerunEngine();
      // 动态导入：rerun_flow.js 静态依赖本模块（runStamp/appendRunRecord…）·静态回引成 ESM 环
      const rf = await import("./rerun_flow.js");
      if (!alive) {
        for (const r of targets) {
          rf.settleRunByStem(pid, r.stem, { running: false, result: "failed", interrupted: true, reason: "engine_unreachable" });
          // 队列历史行翻失败：recordSubmitFinal 只认 id → 按 taskId===stem && running 自扫命中
          for (const e of loadHistory()) {
            if (e && e.taskId === r.stem && e.status === "running") recordSubmitFinal(e.id, { _engineDeadByNull: true });
          }
        }
        showToast("error", t("sb.rerun.deadToast"));
        return;
      }
      // 活：逐行重挂。查表去重（对齐主链 _livePoll 守卫 :851 形态「同任务恒一条链」）——
      //   检查与登记同处一个同步块（pollAndSettle 同步登记活链表），并发对账步不会各建一条。
      for (const r of targets) {
        if (rf.isRerunPolling(r.stem)) continue;
        removeRunningByTaskId(r.stem);   // 重挂前删旧 running 行（任务还在跑·翻终态皆谎报）
        rf.pollAndSettle(r.stem, { projectId: pid, label: r.label, kind: r.kind, sids: r.sids });
      }
    } catch (_e) { /* 对账失败按原样走（不影响主链与使用·重跑行维持 running 待下次挂载再对账） */ }
  }

  // 重跑对账步探活（与 _probeThenResumePoll 同款口径：连拍 2 次·间隔 3s·单请求 10s 超时·TIMEOUTS.probe；
  //   单拍失败可能是引擎瞬时抖动，误杀活任务不可逆 → 必须两拍全失败才判死）
  async function _probeRerunEngine() {
    if (_rerunProbeOverride !== null) return _rerunProbeOverride;   // 单测注入位：免 3s 间隔
    for (let i = 0; i < 2; i++) {
      if (i > 0) await _probeGap();
      if (await _probeAliveOnce()) return true;
    }
    return false;
  }

  // R-44 §三.3：忙时确认弹窗（主钮 + 独立「停止」钮同款·老板原话「点击=弹窗问是否中断」）
  //   竞态守卫（S1·照抄 :943 先例形态）：确认回调时点复查 phase——弹窗开着任务可能已自然
  //   跑完/被别处停止，再按「停止」会空停一个已结束的任务 → 白话提示不动作。
  function _confirmStopCurrent() {
    (_openConfirmFn || openConfirmModal)({
      title: t("sb.stop.confirmTitle"),
      danger: true,
      confirmText: t("sb.stop.confirmOk"),
      cancelText: t("sb.stop.confirmNo"),
      onConfirm: () => {
        if (state.phase !== "submitting" && state.phase !== "polling") {
          showToast("info", t("sb.guard.stateChanged"));
          return;
        }
        void cancelCurrent();
      },
    });
  }

  async function cancelCurrent() {
    try {
      const r = await cancelBatch();
      if (!r.ok) {
        // 网络/协议层失败：未确认停止 → 保持轮询，不得误标已取消
        showToast("error", t("sb.stop.fail", { reason: r.error?.msg || r.error?.code || t("sb.common.unknown") }));
        return;
      }
      if (!r.cancelled) {
        // H3 两形态（收尾在途 / 句柄未就绪）：白话提示 + 保持运行中（轮询跟到真终态）
        showToast("warn", cancelUnavailableToast(r.msg));
        return;
      }
      // #64 停止 = 停止请求成立：记会话标记（onFinal 判据「因停止而终」）——
      //   该标记须先于轮询停摆落下：停止请求与终态 tick 存在竞态窗口。
      if (state.stem) _stoppedStems.add(state.stem);
      const _pid = ((typeof getProject === "function" && getProject()) || project || {}).id;
      // #64 联动停后期编排：core 令牌（当次在跑链 interrupted 收口·不再发下一段）+
      //   该项目 postfx 行墓碑（running:false/user_stopped·刷新对账不续排）。
      try {
        const pp = await import("../core/postfx_pipeline.js");
        if (pp && typeof pp.cancelPostfxFor === "function") pp.cancelPostfxFor(_pid, "user_stopped");
      } catch (_e) { /* 后期取消失败不阻断停止链 */ }
      if (pollHandle && typeof pollHandle.stop === "function") {
        pollHandle.stop();
        pollHandle = null;
      }
      if (_livePoll && _livePoll.handle) _livePoll = null;   // 已取消 → 清轮询单例（不再复用）
      // R-07 · 18-9（批 G-b T5）：取消成功即断实时预览连接——引擎侧停跑后 WS 随之断，
      //   close/error 会触发「预览已断开·轮询兜底」降级条（断线兜底文案误报）。
      //   比照 onFinal 终态惯例（:853 一带）先置 _liveDone 再 stopLive；stopLive 本身不置
      //   _liveDone（语义=「运行已结束≠断线」·取消同属用户主导的终态，同享抑制口径）。
      _liveDone = true;
      stopLive();
      // 停止成功 → runs[0] 退出 running（否则下次挂载按 running 记忆误恢复轮询）
      settleLatestRun(_pid, { running: false });
      setState({ phase: "cancelled" });
      showToast("info", t("sb.stopped.toast"));
    } catch (e) {
      showToast("error", t("sb.stop.except", { msg: e.message || e }));
    }
  }

  // 批1-T5 · H4：Ctrl+Enter = 触发运行（同点击·预检拦截照旧）
  //   守卫①输入保护（INPUT/TEXTAREA/SELECT/contentEditable·range 滑杆除外——对齐 edit.js:1567-1571 口径）
  //   守卫②运行中不抢（否则 Ctrl+Enter 会把在跑任务取消；取消入口=主钮二次点击/停止钮）
  function onDocKeydown(e) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    const t = e.target || {};
    const inRange = t.tagName === "INPUT" && String(t.type || (t.getAttribute && t.getAttribute("type")) || "") === "range";
    const typing = (t.tagName === "INPUT" && !inRange) || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
    if (typing) return;
    if (state.phase === "submitting" || state.phase === "polling") return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    button.click();
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("keydown", onDocKeydown);
  }

  refresh();
  return {
    refresh,
    getPhase: () => state.phase,
    submit: () => button.click(),
    cancel: cancelCurrent,
    // 批1-T5 · H4：摘文档键监听（TAB 往返不累积；轮询不在此停——跨 TAB 恢复走 runs[0] 记忆通道）
    unmount: () => {
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("keydown", onDocKeydown);
      }
      // 批 9 T3 · 18-7：摘现役登记（仅当本挂载仍是登记主——后挂已接管时不误清）
      if (_liveMount && _liveMount.setState === setState) _liveMount = null;
      // 批 M6-T2（R-30）：摘显示行登记（同上「登记主」口径）
      if (_tplLine && _tplLine.el === tplLine) _tplLine = null;
    },
  };
}