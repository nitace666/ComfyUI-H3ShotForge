// core/filekey.js — file 路径比较归一键 + 本地互换防回滚守则（R53变更20-T2）
//
// 单一事实源：edit.js 6932 既有 normFileKey 上提（实现零语义变化），submit-bar.js
// syncRunProducts / edit.js applyHistory / inpaint_dialog.js landProductOnClip 三落点守则共用。

// 路径比较归一键（反斜杠→斜杠 + 内部双分隔符折叠 + 去尾斜杠 + 小写·Windows 大小写不敏感）。
//   引擎 run_dir 形态不一（分隔符/大小写/尾斜杠）且裸文件名 vs 全路径两套拼法并存——仅比较侧用·不改存储值。
//   双分隔符折叠（//+→单杠·卫生3a）: run_dir 带尾斜杠再拼 "/name" 出 "//" 时，与单杠拼法必须
//   收敛相等（Windows 文件系统本就视连续分隔符为单杠）——否则 localPick 追平判等永不收敛·守则拦到死。
export function normFileKey(x) {
  return String(x).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
}

// 防回滚守则（方案 v2 §五）——「引擎产物写回 mainClips 某段 file」落点写前判：
//   该段 localPick 存在（本地互换·T1 落标）且归一化引擎全路径 ≠ 归一化 localPick.file
//   → 拦（调用方跳过该段 file 覆写及其 fileChanged 副作用·localPick 保留）。
//   相等 → 引擎已追上（如老板走引擎侧旧入口后收敛）→ 返 false，调用方清 localPick 标记后正常写入。
export function localPickBlocks(clip, engineFile) {
  const pick = clip && clip.localPick;
  return !!(pick && pick.file && normFileKey(engineFile) !== normFileKey(pick.file));
}

// 现行判定单一事实源（R53变更20-T3·edit.js 废弃补拦/弹窗行显示 + candidates.js rebuild 烘焙共用）：
//   候选 file 与该段现行 mainClips.file 归一化相等 = 它就是现行（不论来源是本地互换还是引擎采纳）。
//   accepted 只是「曾上岗」弱语义（同段两条 accepted 可并存）——现行显示/废弃拦截均以本判据为准。
//   R-53 域修: retired（退位存档）永远不是"现行"——它是被现行版本换下来的东西，即使文件恰好
//   相同（同种子重跑产物与原片同路径同文件名 → 否则双双判真 → 双徽章叠同位点·备选轨全块消失）。
export function isCurrentPick(mainClip, cand) {
  if (cand && cand.kind === "retired") return false;
  return !!(mainClip && mainClip.file && cand && cand.file
    && normFileKey(mainClip.file) === normFileKey(cand.file));
}
