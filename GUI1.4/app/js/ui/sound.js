// ui/sound.js — 渲染完成提醒音（空挂 X-10 转正·自主排期批 2）

import { readAgg, SETTINGS_JSON } from "../core/server_storage.js";  // 批 10-M M-T4：remind 读走聚合文件
//
// 设置门控：localStorage gui13.settings.remind 的 sound===true（settings.js 提醒与恢复组开关）。
// 触发点：core/submit.js _pushTerminalNotif（渲染终态·与通知中心同源事件）动态 import 本模块。
// 形态：Web Audio 两声短音（成功 880→660Hz / 失败与部分失败 520→400Hz·各 180ms）；
//   无 AudioContext 环境（Node/测试桩/老浏览器）静默 no-op，绝不影响提交链。
const REMIND_KEY = "gui13.settings.remind";

let _ctx = null;

export function remindSoundEnabled(storage) {
  try {
    // 批 10-M M-T4：提醒音门控读 server 聚合文件 data/settings.json 的 remind 子键
    //   （R1 点名读点：settings.js 改适配层后，本处若仍读 localStorage 会读到冻结旧值·提醒音失灵）
    const s = storage || (typeof globalThis !== "undefined" && globalThis.localStorage) || null;
    const v = readAgg(SETTINGS_JSON, "remind", s);
    const obj = v != null ? v : JSON.parse((s && typeof s.getItem === "function" ? s.getItem(REMIND_KEY) : null) || "{}");
    return !!(obj && obj.sound === true);
  } catch (_e) {
    return false;
  }
}

export function playRemindChime(kind) {
  try {
    const AC = (typeof globalThis !== "undefined" && globalThis.AudioContext)
      || (typeof window !== "undefined" && window.AudioContext) || null;
    if (!AC || typeof AC !== "function") return false;
    if (!_ctx) _ctx = new AC();
    if (_ctx.state === "suspended" && typeof _ctx.resume === "function") {
      try { void _ctx.resume(); } catch (_e) { /* 用户手势前 resume 被拒：静默 */ }
    }
    const t0 = _ctx.currentTime;
    const freqs = kind === "error" ? [520, 400] : [880, 660];
    freqs.forEach((f, i) => {
      const osc = _ctx.createOscillator();
      const gain = _ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const st = t0 + i * 0.3;
      gain.gain.setValueAtTime(0.0001, st);
      gain.gain.exponentialRampToValueAtTime(0.18, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.18);
      osc.connect(gain);
      gain.connect(_ctx.destination);
      osc.start(st);
      osc.stop(st + 0.2);
    });
    return true;
  } catch (_e) {
    return false;
  }
}

// 组合入口（提交终态调用）：设置开 → 按结果选音色（失败/部分失败低音·成功高音）
export function playRemindChimeIfEnabled(payload, storage) {
  if (!remindSoundEnabled(storage)) return false;
  const p = (payload && typeof payload === "object") ? payload : {};
  const failed = typeof p.failed === "number" ? p.failed : 0;
  const isErr = p._engineDeadAfterEmpty === true || failed > 0;
  return playRemindChime(isErr ? "error" : "success");
}
