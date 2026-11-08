// core/open_dir.js —— 「打开目录」发包 + run_dir 解析共享件（R-31 三处收敛·单一事实源）
//   消费方: preview.js _fsOpenDir / shell.js _openProjectFolder / edit.js openClipDir·copyRunPath·openBrowseModal
//   收敛前三份复制: preview.js _fsOpenDir / shell.js _openProjectFolder（均直连 fetch）/
//     edit.js openClipDir（经 gui13Json 信封·网络失败落兜底文案）
//   参数化口径（既有三分文案逐字不变）:
//     - opts.verb: 兜底文案动词「目录」(preview/edit) /「文件夹」(shell)——记档口径差①不修
//     - opts.plainNetworkError: 网络失败文案「连不上本地服务…」(preview/shell 直连口径)；
//       缺省 `打开{verb}失败：network_error`(edit gui13Json 信封同源语义·既有锁 edit.test.mjs 网络失败分支)
//   run_dir 解析: firstRunDirFromShots 纯函数单源（object/array 双形态·sid 字典序·首个非空）；
//     resolveRunDir = taskId 维度包装（loadDetail 拉取 + 每任务缓存·自 edit.js 原样迁入）
//   成片取径口径差②记档不修: shell 成片链走 resolveRunFilmPath（含 _concat_history 回退·#26-T3b），
//     preview 直读 raw.concat.file——两口径保持各自原处不动。
//   core 不静态依赖 ui（server_storage.js 同款惯例）: toast 函数一律由调用方经 opts 注入。
import { loadDetail } from "./history_ops.js";
import { t, pickDisplay } from "./i18n.js";   // #89 T6：failMsg 模板入典 od.openFail；verb 显示词经 MAPS.openDirVerb 渲染侧映射（调用方实参=数据值零改）

// 发包 + 三分白话（403 不在范围 / 404 不存在 / 其余兜底带 err）。成功零 toast（explorer 已开窗）。
// #92 B1：三条白话入典 od.netDown/od.forbidden/od.notFound（zh 与源码字面量逐字一致）。
export async function openDirRequest(path, opts = {}) {
  const toast = opts.toast;
  const failMsg = (err) => t("od.openFail", { verb: pickDisplay("openDirVerb", opts.verb), err });
  let resp;
  try {
    resp = await fetch("/gui13-fs/open_dir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  } catch (_e) {
    toast("error", opts.plainNetworkError ? t("od.netDown") : failMsg("network_error"));
    return;
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { json = null; }
  if (resp.ok && json && json.ok === true) return;
  const err = (json && json.error) || ("http_" + resp.status);
  if (resp.status === 403 || err === "forbidden") toast("error", t("od.forbidden"));
  else if (resp.status === 404 || err === "not_found") toast("error", t("od.notFound"));
  else toast("error", failMsg(err));
}

// shots 首个非空 run_dir（兼容 object/array 两形态·sid 字典序）；全空返 ""。
export function firstRunDirFromShots(shotsRaw) {
  const obj = (shotsRaw && typeof shotsRaw === "object" && !Array.isArray(shotsRaw))
    ? shotsRaw
    : (Array.isArray(shotsRaw) ? Object.fromEntries(shotsRaw.map((s) => [s && s.sid, s])) : {});
  for (const sid of Object.keys(obj).sort()) {
    const s = obj[sid];
    if (s && typeof s.run_dir === "string" && s.run_dir) return s.run_dir;
  }
  return "";
}

// ---- S2-3 T3: 行级 run_dir 解析（taskId 维度·「复制路径」+「目录」弹窗两入口共用）----
//   listHistory 列表项顶层无 run_dir（历史列表端点不回传），真源 = 引擎 detail 端点；
//   每任务命中后缓存（TAB 切换不残留·卸载经 clearRunDirCache 清，不欠债）。
//   缺 run_dir 时返 {ok:false,error}，调用方弹错兜底 toast，不静默（旧任务或 manifest 损坏即触发）。
const _runDirCache = {};
export function clearRunDirCache() {
  for (const k of Object.keys(_runDirCache)) delete _runDirCache[k];
}
export async function resolveRunDir(taskId, deps = {}) {
  // 命中缓存且非强制刷新 → 直接返回
  if (!deps.skipCache && _runDirCache[taskId]) {
    return { ok: true, runDir: _runDirCache[taskId] };
  }
  const loader = deps.loader || loadDetail;
  const r = await loader({ taskId });
  if (!r.ok) return { ok: false, error: (r.error && r.error.msg) || "engine_no_response" };
  // 归一 shots: 兼容 object / array 两种引擎形态（parse 单源见 firstRunDirFromShots）
  const rawShots = (r.raw && r.raw.shots != null) ? r.raw.shots : (r.shots != null ? r.shots : null);
  const runDir = firstRunDirFromShots(rawShots);
  if (runDir) {
    _runDirCache[taskId] = runDir;
    return { ok: true, runDir };
  }
  return { ok: false, error: "no_run_dir" };
}
