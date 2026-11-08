// ui/progress.js — 统一进度条（批 1-T3 · C3）.
//
// 出处：legacy/app/js/components/progress_bar.js:24/36（GUI1.0 批 22 A8 统一进度组件）。
// 改造点 = ①批 1-T3 只实装 phase 态（彼时无百分比数据源，不造假百分比）
//           ②DOM 契约与文案格式照搬 1.0（`data-h3-role` 三层 + 「阶段（已等待 X）」秒级刷新）
//           ③1.3 宿主为行内文本行（gap 12px flex）→ 轨道给显式 120px 宽（1.0 宿主是块容器无需）
//           ④B7-T1 · C1 增 percent 态：WS 真进度（0..1）到达 → 轨道填充+文案切百分比；
//             缺省/断流回退 phase 态（width 0 + 已等待计时——不造假冻结百分比）
//
// 接口：renderProgress(el, opts) → { update(next), destroy() }
//   opts.phaseText    阶段文案（缺省「处理中」）
//   opts.startedAtMs  起算毫秒（缺省 Date.now()）；已等待 = now - startedAtMs
//   update({ phaseText?, startedAtMs?, percent? })
//     percent: 0..1 数值（越界钳制）→ percent 态（轨道填充 + 「阶段 N%」文案）
//     percent 缺省/非数值 → 回退 phase 态（WS 断流·流数据不再到时消费方推 undefined）
//   destroy()  清 interval + 清空容器 + 去 data-mode/data-h3-role（幂等，可重复调）
//
// 起算口径：消费方传 runs[0].at（"YYYY-MM-DD HH:MM" 本地·分钟精度）经 parseRunStamp；
//   脏值回退 0 → 组件内按当下起算（不编造历史）。

import { t } from "../core/i18n.js";   // #89 T5a：模板骨架词入典 ui.prog.*（phaseText 实参由消费方传入·本件只翻骨架）

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return t("ui.prog.sec", { s });
  return t("ui.prog.minSec", { m: Math.floor(s / 60), s: s % 60 });
}

// 运行记录戳（submit-bar runStamp 写侧格式）→ 本地毫秒；非契约格式 → 0（不猜）
export function parseRunStamp(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp || ""));
  if (!m) return 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function renderProgress(el, opts) {
  if (!el) return { update() {}, destroy() {} };
  const o = opts || {};

  el.dataset.mode = "phase";
  const roleSetByMe = !el.dataset.h3Role;
  if (roleSetByMe) el.dataset.h3Role = "progress-bar";
  el.textContent = "";

  const wrap = document.createElement("div");
  wrap.dataset.h3Role = "progress-bar-wrap";
  wrap.style.cssText = "height:4px;width:120px;background:#333;border-radius:2px;overflow:hidden";
  const bar = document.createElement("div");
  bar.dataset.h3Role = "progress-bar-inner";
  bar.style.cssText = "height:100%;width:0;background:var(--accent-primary,#4caf50)";
  wrap.appendChild(bar);

  const label = document.createElement("span");
  label.dataset.h3Role = "progress-label";
  label.style.cssText = "font-size:11px;color:var(--txt2,#ccc)";

  el.appendChild(wrap);
  el.appendChild(label);

  let startedAtMs = Number(o.startedAtMs) || Date.now();
  let timer = null;
  let percent = null; // B7-T1: 0..1 数值 = percent 态（WS 真进度）；null = phase 态（缺省/断流回退）

  function paint() {
    if (percent != null) {
      el.dataset.mode = "percent";
      bar.style.width = Math.round(percent * 100) + "%";
      label.textContent = (o.phaseText || t("ui.prog.defaultPhase")) + " " + Math.round(percent * 100) + "%";
      return;
    }
    el.dataset.mode = "phase";
    bar.style.width = "0"; // phase 态不填宽度（不造假百分比）
    label.textContent = (o.phaseText || t("ui.prog.defaultPhase")) + t("ui.prog.waited", { t: fmtElapsed(Date.now() - startedAtMs) });
  }
  paint();
  timer = setInterval(paint, 1000);

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    update(next) {
      const n = next || {};
      if (typeof n.startedAtMs === "number") startedAtMs = n.startedAtMs;
      if (n.phaseText != null) o.phaseText = n.phaseText;
      // B7-T1: 数值（0..1·越界钳制）→ percent 态；缺省/非数值 → 回退 phase 态
      percent = (typeof n.percent === "number" && Number.isFinite(n.percent))
        ? Math.min(1, Math.max(0, n.percent))
        : null;
      paint();
    },
    destroy() {
      stopTimer();
      el.textContent = "";
      if (el.removeAttribute) el.removeAttribute("data-mode");
      if (roleSetByMe && el.removeAttribute) el.removeAttribute("data-h3-role");
    },
  };
}
