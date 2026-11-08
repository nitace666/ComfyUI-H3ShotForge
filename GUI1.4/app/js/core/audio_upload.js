// core/audio_upload.js — 音频文件进引擎（W-06 音乐文件 + W-08 BGM 公共链路·自主排期批 3）
//
// 通道（2026-09-27 真机实测）：
//   ① ComfyUI POST /upload/image 收任意类型文件（audio/mpeg 实测通过）→ {name, subfolder, type:"input"}
//   ② GET /h3_batch/input_dir → 引擎 input 目录绝对路径
//   → 绝对路径 = dir + "\" + (subfolder? subfolder+"\" : "") + name
//   引擎 BGM 预检 os.path.isfile(bgm_path)（batch_core.py:7351）要绝对路径——本链路产出即绝对路径。
//
// 前端时长读取：Audio 元素 metadata（解不了兜底 0·超时 8s）。

import { uploadImage, request } from "./api.js";
import { t } from "./i18n.js";   // #92 B2：4 条可见错误文案入典 audio.up.*（运行期调用·zh 与源码字面量逐字一致）

export async function engineInputDir() {
  const r = await request("/h3_batch/input_dir", { cache: "no-store" });
  if (!r.ok || !r.data || typeof r.data.dir !== "string" || !r.data.dir) {
    return { ok: false, error: (r.error && r.error.msg) || t("audio.up.noDir") };
  }
  return { ok: true, dir: r.data.dir };
}

// 本地音频 → 上传引擎 input → {absPath, name}
export async function uploadAudioToEngine(file) {
  if (!file) return { ok: false, error: t("audio.up.noFile") };
  const fd = new FormData();
  fd.append("image", file, file.name || "bgm_audio");
  fd.append("subfolder", "");
  fd.append("type", "input");
  fd.append("overwrite", "true");
  const up = await uploadImage(fd);
  if (!up || !up.name) {
    return { ok: false, error: (up && up.error && up.error.msg) || t("audio.up.fail") };
  }
  const d = await engineInputDir();
  if (!d.ok) return { ok: false, error: t("audio.up.dirFail", { err: d.error }) };
  const abs = d.dir.replace(/[\\/]+$/, "") + "\\" + (up.subfolder ? up.subfolder.replace(/[\\/]+$/, "") + "\\" : "") + up.name;
  return { ok: true, absPath: abs, name: up.name };
}

// 前端读音频时长（秒；不可解码/超时 → 0）
export function readAudioDuration(file) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(url); } catch (_e) { /* 静默 */ }
      resolve(v);
    };
    let url = "";
    try {
      url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0);
      a.onerror = () => done(0);
      a.src = url;
      setTimeout(() => done(0), 8000);
    } catch (_e) {
      settled = true;
      resolve(0);
    }
  });
}

// 通用本机文件选择（hidden input 单例·Promise 一次一选；取消 → null）
export function pickLocalFile(accept, inputId) {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(null); return; }
    const id = inputId || "gui13-pick-file";
    let inp = document.getElementById(id);
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file";
      inp.id = id;
      inp.style.display = "none";
      document.body.appendChild(inp);
    }
    inp.accept = accept || "";
    inp.value = "";
    inp.onchange = () => {
      const f = inp.files && inp.files[0] ? inp.files[0] : null;
      inp.onchange = null;
      resolve(f);
    };
    inp.click();
  });
}
