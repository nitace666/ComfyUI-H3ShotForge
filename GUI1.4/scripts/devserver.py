#!/usr/bin/env python3
"""GUI1.3 开发反代：静态服务仓库根 + /h3_batch|/upload|/view|/system_stats 等引擎路径转发（剥 Origin·
引擎地址取 _engine_cfg：env > data/settings.json engine_addr > 默认 http://127.0.0.1:8190）
+ /ws WebSocket 代理（B7-T1b：同源 ws://127.0.0.1:8940/ws → 裸 socket 连引擎·转发握手但剥 Origin/Sec-Fetch-*
——引擎 0.35.0 origin_only 中间件 Host≠Origin 即 403，剥后校验即过；双向字节管道任一侧关即双侧收尾）。
用法：python scripts/devserver.py <port>（默认 8940）。同源模式：localStorage["gui13.dev.base"]=""。
起前 netstat 确认端口独占，发现旧进程先杀（旧进程提供陈旧文件）。登记项 9 转正（原 .tmp/ 会丢）。

批 10-M M-T1：数据端点 /gui13-data（GET 读 / PUT 写）——浏览器零持久（方案 docs/方案-数据服务侧化-2026-10-03.md）：
  GET  /gui13-data?path=data/settings.json → 该文件 JSON 内容（404 归一 {"ok":false,"error":"not_found"}）
  PUT  /gui13-data  body {"path":"data/settings.json","value":<整文件内容>} → 原子写（temp+os.replace）
  数据基址 = **仓库根**（data/ 在仓库根·非静态 ROOT=app/）·data/ 不存在自动创建。
  四重安全：①URL 解码后逐路径段校验（任一段 . / .. 或含反斜杠 → 403）②os.path.realpath 必落在
  <仓库根>/data/ 内（双保险·挡符号链接逃逸）③键白名单正则 ^data/[a-z0-9/_.-]+\.json$ ④**不加 ACAO 头**
  （勿沿用 _forward 的 ACAO:*·防任意网页跨源读）+ Host 头须为回环（防 DNS rebinding）。
  OPTIONS/CORS 预检不需要（同源反代使用）。

批6 E1 #33：/gui13-data 并发加固（方案 docs/方案-索引并发修复-2026-10-29.md v2.1 §四.2/§四.3）——
  ①全局单锁 _data_io_lock：_data_get/_data_put（含删除支路）文件读写临界段同锁，消并发写 os.replace
  竞争 500 与读竞争（读侧覆盖）；②CAS：PUT body 可选 _base_rev 仅 data/index.json 生效，≠当前文件
  rev → 409 {"error":"index_conflict","rev":<当前>}，不带=盲写兼容旧客户端；_base_rev 在 body 层不落盘。
  锁为进程内·多 devserver 共享同 data/ 无效（残留风险·方案§六）。

批 M5 T0：引擎进程端点 /gui13-fs/engine_start|/gui13-fs/engine_stop（body {"port":N}·白名单=engine_addr 端口）：
  引擎进程系统能力归本服（架构口径=引擎仓零改）——探活通则 already 不重拉；不通则僵尸清理（三条件命令行
  匹配集 ∩ 监听集树杀·清后复查·残留非引擎占用回 port_taken_by_other 不杀）→ venv 解释器拉起 → 秒退检测。
  在途单例（409 带 since 毫秒）+ PID 落 .tmp/engine-proc-<port>.json（**不落 data/**·GUI 可写白名单=投毒面）。

地基批1 T7 #52：首启体检端点 GET /gui13-fs/healthcheck（回环 Host 闸同 engine_start·只读零写）→ 200
  {"ok": 全部项 ok 才 true, "items": [{id, ok, detail}]} 七项（顺序固定）：①engine（/system_stats 探活 2s·
  解析 version/vram_total_mb·取不到字段给 null 不失败）②data_service（本端点可达即活）③ffmpeg（ffmpeg+
  派生 ffprobe 存在）④engine_dir（目录+venv python 存在）⑤engine_port（socket 试连）⑥disk（工作盘+
  引擎盘剩余≥10GB）⑦custom_nodes（直读 engine_dir/custom_nodes 目录·REQUIRED=[ComfyUI-H3-BatchRenderer|ComfyUI-H3ShotForge 任一在位即过]·
  版本比对不做）。引擎侧零改：引擎信息走现成 /system_stats 端点·节点清单直读目录（#52 detail.体检七裁决）。

释放显存批：GET /gui13-fs/engine_busy（回环 Host 闸同 healthcheck·只读）转发引擎 GET /queue →
  {ok, running, pending, busy}·不可达 200 {ok:false,error:"engine_unreachable"}（状态查询循 healthcheck 全 200）。
  POST /gui13-fs/free_vram（同源写闸同 engine_start）：先查忙闲，忙且 body 未带 {"force":true} → 409
  {ok:false,error:"engine_busy",running,pending}（前端二次确认）；否则调引擎 POST /free（unload_models+
  free_memory）→ 返回 {ok, before_free_gb, after_free_gb, total_gb}（VRAM 取不到给 null 不失败）。
"""
import sys, os, re, json, socket, threading, subprocess, tempfile, time, uuid, shutil, hashlib, urllib.request, urllib.error, zipfile
import email.utils
from concurrent.futures import ThreadPoolExecutor   # U-批 U4：scan_engine 并发探活（13 路并行·总预算 ≤6s）
from urllib.parse import parse_qs, unquote, urlsplit
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8940
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(REPO_ROOT, "app")   # 静态根=app/（index.html 相对路径 css/ js/）
DATA_DIR = os.environ.get("GUI13_DATA_DIR") or os.path.join(REPO_ROOT, "data")  # M-T1：数据基址=仓库根（GUI13_DATA_DIR 仅测试用·不设=现推导零变化）
DATA_KEY_RE = re.compile(r"^data/[a-z0-9/_.-]+\.json$")  # 文件键白名单（方案 §三.1）
DATA_DIR_RE = re.compile(r"^data/[a-z0-9/_-]+/$")         # 目录键白名单（尾斜杠=目录语义·M-T3 列举）
# 批6 E1 #33：/gui13-data 数据读写全局单锁（方案 docs/方案-索引并发修复-2026-10-29.md v2.1 §四.2）——
# _data_get 与 _data_put 临界段同锁（读侧覆盖·消 PUT×PUT 的 os.replace 竞争 500 与 PUT×GET 读竞争）；
# 一把不搞 per-path dict（方案审建议 9）·毫秒级文件读写临界段·不包网络 IO。
# 进程内锁·多 devserver 共享同 data/ 无效（残留场景风险栏在案·方案§六）。
_data_io_lock = threading.Lock()
ENGINE = os.environ.get("GUI13_ENGINE_ADDR", "http://127.0.0.1:8190")  # env 覆盖口 + **默认定义处**（_engine_cfg 默认档取此·不设时与原硬编码逐字等价）
# 批 C #13 收窄：/queue /prompt /object_info /api 四 legacy 前缀 GUI 零消费（复核 grep 证实）已移除
# ——现存四前缀与 api.js ENGINE_PATH_RE 同族，两处收扩须同步（C7/C13 锁钉）。
FWD_PREFIXES = ("/h3_batch", "/upload", "/view", "/system_stats")

# ===== 批 B #13：本地文件流常量（方案-#13解耦B档-2026-10-16 §四.批B）=====
MEDIA_TYPES = {  # Content-Type 自映射（mimetypes 在 Windows 随注册表漂移·白名单内扩展名自钉）
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".m4v": "video/mp4", ".avi": "video/x-msvideo",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".ogg": "audio/ogg",
}
THUMB_DIR = os.path.join(REPO_ROOT, ".tmp", "thumb-cache")  # 缩略产物缓存（.tmp 过程产物·_pid_file 同区先例·
                                                            # 不落 data/——GUI 数据面可写白名单=投毒面）
THUMB_FFMPEG_TIMEOUT = 30   # 单次出图超时秒数（_probe_one 先例 10s·出图含大视频首帧解码放宽）
THUMB_CACHE_MAX_FILES = 2000               # 批 C #13：缓存件数上限（LRU 按 mtime 淘汰）
THUMB_CACHE_MAX_BYTES = 200 * 1024 * 1024  # 批 C #13：缓存字节上限（200MB）
MEDIA_PROBE_COOLDOWN = 30.0  # 引擎活探失败负缓存秒数（半死引擎=占端口不回包·防每媒体请求 10s 阻塞）
_media_probe_fail_at = 0.0


def _prune_thumb_cache(cache_dir=None, max_files=None, max_bytes=None):
    """批 C #13：缩略缓存上限清理（LRU 按 mtime 淘汰·devserver 启动时调用一次·不加后台线程）。

    仅当件数或字节超限才动手；删最旧（mtime 升序）直到双维回到线内。返回删除件数。
    """
    d = cache_dir or THUMB_DIR
    mf = THUMB_CACHE_MAX_FILES if max_files is None else max_files
    mb = THUMB_CACHE_MAX_BYTES if max_bytes is None else max_bytes
    try:
        names = os.listdir(d)
    except OSError:
        return 0
    entries = []   # (mtime, size, path)
    total = 0
    for n in names:
        p = os.path.join(d, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if not os.path.isfile(p):
            continue
        entries.append((st.st_mtime, st.st_size, p))
        total += st.st_size
    if len(entries) <= mf and total <= mb:
        return 0
    entries.sort(key=lambda e: (e[0], e[2]))   # 最旧在前（同刻按路径稳定序）
    removed = 0
    for _mt, sz, p in entries:
        if len(entries) - removed <= mf and total <= mb:
            break
        try:
            os.remove(p)
        except OSError:
            continue   # 并发清走等：跳过该件（循环按既有序推进·不会死循环）
        removed += 1
        total -= sz
    return removed

# ===== 批 M5 T0：引擎进程端点 /gui13-fs/engine_start|engine_stop（方案 docs/方案-批M5-引擎连接批-2026-10-09.md §一.T0）=====
ENGINE_DIR = r"N:\Comfy-Desktop\ComfyUI-Installs\Comfyui\ComfyUI"  # **默认定义处**（地基批1 T1 #46：实际值取 _engine_cfg·默认=值同 engine-watchdog.ps1）
ENGINE_PROBE_TIMEOUT = 2                 # 探活秒数（半死引擎=占端口不回包形态·方案 §三.6 复用件）
ENGINE_FREE_TIMEOUT = 30                 # 引擎 /free 释放模型秒数（动作非探活·给足卸载时间）
_DETACHED_PROCESS = 0x00000008           # subprocess 模块无此常量·winbase.h 值
_CREATE_NEW_PROCESS_GROUP = 0x00000200   # 同上（值与 subprocess.CREATE_NEW_PROCESS_GROUP 相同·钉死避免取属性）
_engine_op_lock = threading.Lock()
_engine_op = {"since": None}             # 在途单例：None=空闲 / 否则 epoch 毫秒（在途起点·409 回应带·B-3-12）

# ===== 批 H T1：导出渲染管线伴生（方案 docs/方案-批H-导出渲染管线-2026-10-06.md v3·裁决 1/2/3/3b/5）=====
FFMPEG = r"I:\ffmpeg\bin\ffmpeg.exe"    # **默认定义处**（绝对路径调用·H-T0 实证任意 cwd 可起跑·实际值取 _engine_cfg)
EXPORT_JOB_TIMEOUT = 1800   # job 超时秒数（threading.Timer 到期 kill→status=timeout）
# 转场真名白名单（批 H T7·与 GUI 组装器 XFADE_MAP 同 8 键·服务端独立钉一份防注入）。
# 真名经 `ffmpeg -h filter=xfade` 实测枚举号：fade 0/slideleft 5/slideright 6/slideup 7/slidedown 8/
#   fadeblack 12/fadewhite 13/circleopen 19。
XFADE_NAMES = frozenset(("fade", "fadeblack", "fadewhite", "slideleft", "slideright",
                         "slideup", "slidedown", "circleopen"))
_export_roots_cache = None  # 双根缓存 (input_root, output_root)·仅推导成功后缓存（失败不缓存·下请求重试）
_jobs = {}                  # job 表：id → {id,kind,status,phase,error,argv,outPath,startedAt,proc,timer}
_jobs_lock = threading.Lock()  # 护：roots 缓存写 / execute check-then-act（同时一 job）/ 状态迁移（v3 S-5）

def _data_cur_rev(full):
    """批6 E1 #33 CAS 用：当前文件 rev（JSON 顶层 rev 字段）——缺文件/坏 JSON/无 rev → 0（首写基线）。
    须持 _data_io_lock 调用（与写入同临界段才是原子 check-then-act）。"""
    try:
        with open(full, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return 0
    rev = doc.get("rev") if isinstance(doc, dict) else None
    return rev if isinstance(rev, int) else 0

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    # ===== 批 10-M M-T1：/gui13-data 读端点 =====
    def _host_ok(self):
        """Host 头须为回环（防 DNS rebinding：攻击域解析到 127.0.0.1 时 Host 是攻击域）。"""
        h = (self.headers.get("Host") or "").strip().lower()
        return h == "127.0.0.1" or h.startswith("127.0.0.1:") or h == "localhost" or h.startswith("localhost:")

    def _data_key(self, raw):
        """四重安全校验 → (key, abs_path)；不通过返回 (None, None)。"""
        if not self._host_ok():
            return None, None
        key = unquote(str(raw or "")).strip()
        if not key or "\\" in key:              # ① 反斜杠（Windows 路径绕过）直接拒
            return None, None
        is_dir = key.endswith("/")
        probe = key[:-1] if is_dir else key       # 目录形态：尾斜杠是语义标记·不参与分段校验
        if not probe:
            return None, None
        for seg in probe.split("/"):
            if seg in ("", ".", ".."):            # ① 逐路径段：无空段/无 . / ..
                return None, None
        # ③ 键白名单：文件形态 ^data/….json$ ·目录形态 ^data/…/$（尾斜杠语义）
        if not (DATA_DIR_RE.match(key) if is_dir else DATA_KEY_RE.match(key)):
            return None, None
        base = os.path.realpath(DATA_DIR)         # ② realpath 双保险（挡符号链接逃逸）
        if key.startswith("data/projects/"):      # R-59 T1：projects 实体随工作区根搬家（其余 data/ 键永不搬家）
            root = _workspace_root_setting()
            if root:
                pbase = os.path.realpath(os.path.join(root, "projects"))
                full = os.path.realpath(os.path.join(pbase, key[len("data/projects/"):]))
                if not (full == pbase or full.startswith(pbase + os.sep)): return None, None
                return key, full
        full = os.path.realpath(os.path.join(REPO_ROOT, key))
        if not (full == base or full.startswith(base + os.sep)):
            return None, None
        return key, full

    def _json(self, code, obj, ctype="application/json; charset=utf-8"):
        """统一 JSON 出口：**刻意不带 Access-Control-Allow-Origin**（同源才可读·防跨源读）。"""
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(json.dumps(obj, ensure_ascii=False).encode("utf-8"))))
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _data_list_dir(self, full):
        """目录列举（M-T3）：仅一层 *.json（不递归·不列子目录）→ {"ok":true,"ids":[文件名去 .json]}"""
        try:
            names = sorted(os.listdir(full))
        except OSError:
            return self._json(404, {"ok": False, "error": "not_found"})
        ids = [n[:-5] for n in names if n.endswith(".json") and os.path.isfile(os.path.join(full, n))]
        return self._json(200, {"ok": True, "ids": ids})

    def _data_get(self, qs):
        raw = (parse_qs(qs).get("path") or [""])[0]
        key, full = self._data_key(raw)
        if key is None:
            return self._json(403, {"ok": False, "error": "forbidden"})
        if key.endswith("/"):                      # 目录语义 → 列举（防漏对账用）
            if not os.path.isdir(full):
                return self._json(404, {"ok": False, "error": "not_found"})
            return self._data_list_dir(full)
        try:
            with _data_io_lock:                    # 批6 E1 #33：读侧同锁（消与 _data_put os.replace 的竞争）
                with open(full, "r", encoding="utf-8") as f:
                    body = f.read()
        except FileNotFoundError:
            return self._json(404, {"ok": False, "error": "not_found"})
        except OSError:
            return self._json(500, {"ok": False, "error": "read_failed"})
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _data_put(self):
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._json(400, {"ok": False, "error": "bad_json"})
        if not isinstance(payload, dict):
            return self._json(400, {"ok": False, "error": "bad_body"})
        key, full = self._data_key(payload.get("path"))
        if key is None:
            return self._json(403, {"ok": False, "error": "forbidden"})
        # M-T8 致命单（F95）：value=null → **删文件**（客户端 writeFile(null)=清除语义）。
        #   旧实现 json.dump(None) 会落出 4 字节 "null" 字面文件——读侧曾因此误判连锁降级。
        #   幂等：文件不存在也返回 ok+deleted（客户端可重复清）。注释契约同步：
        #   PUT body {"path":…, "value":null} = 删除该数据文件。
        if payload.get("value") is None:
            with _data_io_lock:                    # 批6 E1 #33：删除也是数据写·同锁
                try:
                    if os.path.exists(full):
                        os.remove(full)
                    if key.startswith("data/projects/"):
                        _project_snapshot_dir_cleanup(key, full)   # #63 T6：快照目录随项目实体删除
                    resp = (200, {"ok": True, "path": key, "deleted": True})
                except OSError:
                    resp = (500, {"ok": False, "error": "delete_failed"})
            return self._json(*resp)
        # 批6 E1 #33 CAS（方案 §四.3）：带 _base_rev 仅 data/index.json 生效——≠当前文件 rev → 409
        # {"error":"index_conflict","rev":<当前>}；不带=盲写完全兼容旧客户端。_base_rev 在 body 层、
        # 落盘内容恒为 payload["value"] 天然不落盘。检查+写入同锁临界段·锁内零网络 IO（响应锁外发）。
        with _data_io_lock:
            resp = self._data_put_locked(payload, key, full)
        return self._json(*resp)

    def _data_put_locked(self, payload, key, full):
        """批6 E1 #33：写临界段（CAS 检查+原子写）→ (code, obj)。须持 _data_io_lock 调用·零网络 IO。"""
        if key == "data/index.json" and "_base_rev" in payload:   # CAS 仅 index 生效
            cur = _data_cur_rev(full)
            if payload.get("_base_rev") != cur:
                return 409, {"error": "index_conflict", "rev": cur}
        folder = os.path.dirname(full)
        try:
            os.makedirs(folder, exist_ok=True)   # data/ 与 data/projects/ 自动创建
        except OSError:
            return 500, {"ok": False, "error": "mkdir_failed"}
        # 原子写：同目录 temp + os.replace（半写不破既有文件·方案 §三.1 写入原子性）
        tmp = ""
        try:
            fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload.get("value"), f, ensure_ascii=False)
            # WinError 5 重试：handler 间竞争已被 _data_io_lock 串行化，残留 5 为外部进程瞬时占用
            # （Defender/索引器扫刚落盘文件·锁下实测 4/1200≈0.3%）——小退避重试消之；真死锁仍 500。
            for attempt in range(3):
                try:
                    os.replace(tmp, full)
                    tmp = ""
                    break
                except OSError:
                    if attempt == 2:
                        raise
                    time.sleep(0.002 * (attempt + 1))
        except OSError:
            if tmp:
                try: os.unlink(tmp)
                except OSError: pass
            return 500, {"ok": False, "error": "write_failed"}
        return 200, {"ok": True, "path": key}

    # ===== 批 B #13：/gui13-fs/media 本地流 + /gui13-fs/thumb 本地缩略（同源·四重闸）=====
    def _media_get(self, qs):
        """本地媒体流（批 B T1·Range/206/Content-Range/304 本地新写非透传）：
        四重闸 → 条件请求（If-None-Match/If-Modified-Since→304）→ 单区间 Range（206/416）→ 分块流。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        rp = _path_in_media_roots((parse_qs(qs).get("path") or [""])[0])
        if rp is None:
            return self._json(403, {"ok": False, "error": "forbidden"})
        if not os.path.isfile(rp):
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            size = os.path.getsize(rp)
            mtime = os.path.getmtime(rp)
        except OSError:
            return self._json(500, {"ok": False, "error": "read_failed"})
        etag = '"gui13-%d-%d"' % (size, int(mtime * 1000))
        heads = {"ETag": etag, "Last-Modified": self.date_time_string(int(mtime)),
                 "Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
        inm = self.headers.get("If-None-Match")
        if (inm and etag in [t.strip() for t in inm.split(",")]) or \
                (not inm and _ims_fresh(self.headers.get("If-Modified-Since"), mtime)):
            self.send_response(304)
            for k, v in heads.items():
                self.send_header(k, v)
            self.end_headers()
            return
        start, end, code, extra = 0, size - 1, 200, {}
        rng = self.headers.get("Range")
        ifr = self.headers.get("If-Range")
        if rng and (not ifr or ifr.strip() == etag):     # If-Range 不匹配 → 忽略 Range 回 200 全量
            m = re.match(r"^bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):         # 多区间/畸形 → 忽略（RFC 允许·浏览器不发多区间）
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                else:
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                code, extra = 206, {"Content-Range": "bytes %d-%d/%d" % (start, end, size)}
        try:
            f = open(rp, "rb")
        except OSError:
            return self._json(500, {"ok": False, "error": "read_failed"})
        with f:
            self.send_response(code)
            self.send_header("Content-Type", MEDIA_TYPES.get(os.path.splitext(rp)[1].lower(), "application/octet-stream"))
            for k, v in heads.items():
                self.send_header(k, v)
            for k, v in extra.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _thumb_get(self, qs):
        """本地缩略（批 B T2·引擎 thumb 语义对齐 path+max_size）：ffmpeg 出图（视频抽帧/图片缩放同式）
        → .tmp/thumb-cache 产物缓存（key=normcase 路径+size+mtime_ns+max_size·temp+os.replace 原子落位）。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        qs_d = parse_qs(qs)
        rp = _path_in_media_roots((qs_d.get("path") or [""])[0])
        if rp is None:
            return self._json(403, {"ok": False, "error": "forbidden"})
        if not os.path.isfile(rp):
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            max_size = int((qs_d.get("max_size") or ["512"])[0])
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad_max_size"})
        if max_size <= 0:
            return self._json(400, {"ok": False, "error": "bad_max_size"})
        try:
            st = os.stat(rp)
        except OSError:
            return self._json(500, {"ok": False, "error": "read_failed"})
        key = hashlib.sha1("\x00".join((os.path.normcase(rp), str(st.st_size),
                                        str(st.st_mtime_ns), str(max_size))).encode("utf-8", "replace")).hexdigest()
        cache_path = os.path.join(THUMB_DIR, key + ".jpg")
        if not os.path.isfile(cache_path):
            try:
                os.makedirs(THUMB_DIR, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=THUMB_DIR, suffix=".jpg")
                os.close(fd)
            except OSError:
                return self._json(500, {"ok": False, "error": "thumb_failed"})
            ok = False
            try:
                r = subprocess.run(_thumb_argv(rp, max_size, tmp), capture_output=True,
                                   timeout=THUMB_FFMPEG_TIMEOUT, stdin=subprocess.DEVNULL)
                ok = r.returncode == 0 and os.path.getsize(tmp) > 0
            except (subprocess.TimeoutExpired, OSError):
                ok = False
            if ok:
                try:
                    os.replace(tmp, cache_path)   # 并发同键各自 replace·后到胜·无半写可读
                except OSError:
                    ok = False
            if not ok:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                return self._json(502, {"ok": False, "error": "thumb_failed"})
        try:
            with open(cache_path, "rb") as f:
                body = f.read()
        except OSError:
            return self._json(500, {"ok": False, "error": "read_failed"})
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _forward(self, method):
        url = _engine_cfg()["addr"] + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=method)
        # M7-T3（方案 §四）：If-None-Match/If-Range 透传——引擎 304/Range 条件请求通道（浏览器缓存协商·断点续传）。
        for h in ("Content-Type", "Accept", "Authorization", "X-Requested-With", "Range", "If-None-Match", "If-Range"):
            if self.headers.get(h): req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=3600) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection", "access-control-allow-origin"):
                        self.send_header(k, v)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk: break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502); self.end_headers()
            self.wfile.write(str(e).encode())
    def _is_ws_upgrade(self):
        conn = (self.headers.get("Connection") or "").lower()
        return "upgrade" in conn and (self.headers.get("Upgrade") or "").lower() == "websocket"

    def _proxy_ws(self):
        """同源 /ws → 引擎：重建握手（剥 Origin/Sec-Fetch-*·Host 重写引擎——与 urllib HTTP 转发同政策）
        → 原样回传引擎 101/错误响应 → 双向字节管道（任一侧关即双侧收尾）。"""
        cfg = _engine_cfg()
        eng_addr = (urlsplit(cfg["addr"]).hostname, cfg["port"])   # WS 目标随 HTTP 目标同源（同址引擎 WS/HTTP 同端口）
        lines = [f"GET {self.path} HTTP/1.1", f"Host: {eng_addr[0]}:{eng_addr[1]}"]
        for name, value in self.headers.items():
            if name.lower() in ("host", "origin", "connection", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"):
                continue
            lines.append(f"{name}: {value}")
        lines.append("Connection: Upgrade")
        self.close_connection = True
        try:
            eng = socket.create_connection(eng_addr, timeout=10)
        except OSError as e:
            self.send_response(502); self.end_headers(); self.wfile.write(str(e).encode())
            return
        try:
            eng.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            eng.settimeout(10)
            head = b""
            # 批 9 T4（18-2）：握手读超时归一——引擎 10s 内无响应时 recv 抛 socket.timeout，
            #   此前裸抛出 handler 线程 traceback；改单行日志退出（finally 关 eng，客户端侧静默收线）
            try:
                while b"\r\n\r\n" not in head:
                    chunk = eng.recv(65536)
                    if not chunk: return
                    head += chunk
            except socket.timeout:
                print(f"[devserver] ws handshake timeout (10s): {self.path}", file=sys.stderr, flush=True)
                return
            self.connection.sendall(head)  # 引擎握手响应原样回传（101 或错误态均透传）
            eng.settimeout(None)
            client = self.connection

            def pump(src, dst):  # 任一侧断（EOF/错）→ 双侧收尾
                try:
                    while True:
                        data = src.recv(65536)
                        if not data: break
                        dst.sendall(data)
                except OSError:
                    pass
                finally:
                    for s in (client, eng):
                        try: s.shutdown(socket.SHUT_RDWR)
                        except OSError: pass

            up = threading.Thread(target=pump, args=(client, eng), daemon=True)  # 客户端→引擎
            up.start()
            pump(eng, client)  # 引擎→客户端（占本 handler 线程·ThreadingHTTPServer 不阻塞其他请求）
            # #52 证伪注释（批5 2026-10-29 桩测）：此 join 仅「下行结束后等上行线程收尾」的兜底（上限 5 秒），
            #   不是连接期空闲/读超时（数据面 settimeout(None)）——实测长会话双向静默远超 5 秒仍正常。
            up.join(timeout=5)
        finally:
            eng.close()

    # ===== 批 H T1：/gui13-export 与 /gui13-fs/open_dir（同源·_json 无 ACAO 同 _data_*）=====
    def _read_body(self):
        """JSON body 读取（同 _data_put 模式）→ 解析结果·失败 None。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return None

    def _export_get(self, qs):
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "forbidden"})
        jid = (parse_qs(qs).get("job") or [""])[0]
        with _jobs_lock:
            job = _jobs.get(jid)
            snap = None if job is None else {k: v for k, v in job.items() if k not in ("proc", "timer")}
        if snap is None:
            return self._json(404, {"ok": False, "error": "not_found"})
        return self._json(200, {"ok": True, "job": snap})

    def _export_post(self):
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        body = self._read_body()
        if not isinstance(body, dict):
            return self._json(400, {"ok": False, "error": "bad_json"})
        op = body.get("op")
        if op == "probe":
            return self._export_probe(body)
        if op == "dry-run":
            return self._export_dryrun(body)
        if op == "execute":
            return self._export_execute(body)
        if op == "cancel":
            return self._export_cancel(body)
        return self._json(400, {"ok": False, "error": "bad_op"})

    def _export_probe(self, body):
        """probe 同步返回不走 job 表（v3 I-2）：越界 403 / 不存在 404 / ffprobe 失败·超时 502。"""
        files = body.get("files")
        if not isinstance(files, list) or not files or not all(isinstance(f, str) and f for f in files):
            return self._json(400, {"ok": False, "error": "bad_body"})
        roots = _export_roots()
        if roots is None:
            return self._json(502, {"ok": False, "error": "engine_unreachable"})
        checked = []
        for f in files:
            rp = _path_in_roots(f, roots)
            if rp is None:
                return self._json(403, {"ok": False, "error": "forbidden"})
            if not os.path.isfile(rp):
                return self._json(404, {"ok": False, "error": "not_found"})
            checked.append((f, rp))
        out = []
        for f, rp in checked:
            info = _probe_one(rp)
            if info is None:
                return self._json(502, {"ok": False, "error": "probe_failed"})
            out.append({"file": f, "w": info["w"], "h": info["h"], "fps": info["fps"], "duration": info["duration"]})
        return self._json(200, {"ok": True, "files": out})

    def _export_dryrun(self, body):
        """dry-run：只拼 argv 返回·不建 job 不起进程（workdir 为占位路径·out_path 与 execute 同调
        _export_out_path——dry-run 无前端消费方·同调纯一致性收益·方案 S5）。"""
        roots = _export_roots()
        if roots is None:
            return self._json(502, {"ok": False, "error": "engine_unreachable"})
        spec, err = _normalize_spec(body.get("spec"))
        if spec is None:
            return self._json(err[0], _spec_error_body(err))
        if not _spec_paths_ok(spec, roots):
            return self._json(403, {"ok": False, "error": "forbidden"})
        out_path = _export_out_path(spec, roots)
        workdir = os.path.join(tempfile.gettempdir(), "gui13_export_dryrun")
        return self._json(200, {"ok": True, "argv": _stage_argvs(spec, out_path, workdir)})

    def _export_execute(self, body):
        roots = _export_roots()
        if roots is None:
            return self._json(502, {"ok": False, "error": "engine_unreachable"})
        spec, err = _normalize_spec(body.get("spec"))
        if spec is None:
            return self._json(err[0], _spec_error_body(err))
        if not _spec_paths_ok(spec, roots):
            return self._json(403, {"ok": False, "error": "forbidden"})
        out_path = _export_out_path(spec, roots)
        workdir = tempfile.mkdtemp(prefix="gui13_export_")   # 中间段落盘系统临时目录·worker finally 清理
        stages = _stage_argvs(spec, out_path, workdir)
        jid = "exp-" + uuid.uuid4().hex[:12]
        job = {"id": jid, "kind": "export", "status": "running", "phase": "queued", "error": None,
               "argv": stages, "outPath": out_path, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "startedAtMs": time.time() * 1000, "proc": None, "timer": None}
        timer = threading.Timer(EXPORT_JOB_TIMEOUT, _job_timeout, args=(jid,))
        timer.daemon = True
        busy = False
        with _jobs_lock:                     # check-then-act 同锁段（v3 S-5 第一段·ThreadingHTTPServer 下非原子必护）
            if any(j["status"] == "running" for j in _jobs.values()):
                busy = True
            else:
                job["timer"] = timer
                _jobs[jid] = job
        if busy:
            shutil.rmtree(workdir, ignore_errors=True)
            return self._json(409, {"ok": False, "error": "busy"})
        timer.start()
        threading.Thread(target=_export_worker, args=(job, spec, stages, workdir), daemon=True).start()
        return self._json(200, {"ok": True, "job_id": jid})

    def _export_cancel(self, body):
        jid = body.get("id")
        if not isinstance(jid, str):
            return self._json(404, {"ok": False, "error": "not_found"})
        with _jobs_lock:
            job = _jobs.get(jid)
            if job is None:
                return self._json(404, {"ok": False, "error": "not_found"})
            if job["status"] != "running":
                return self._json(409, {"ok": False, "error": "not_running"})
            job["status"] = "cancelled"
            job["finishedAtMs"] = time.time() * 1000
            timer, proc = job.get("timer"), job.get("proc")
        if timer:
            timer.cancel()                   # Timer 并撤（v2 I5）
        _kill(proc)
        return self._json(200, {"ok": True, "status": "cancelled"})

    def _open_dir_post(self):
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        roots = _export_roots()
        if roots is None:
            return self._json(502, {"ok": False, "error": "engine_unreachable"})
        path, status, err = _open_dir_target(self._read_body(), roots)   # J-P6：path 缺省/null → output 根兜底
        if status:
            return self._json(status, {"ok": False, "error": err})
        if not os.path.isdir(path):   # 白名单内但不存在 → 404（explorer 对不存在路径静默弹默认窗·不让用户误会打开了）
            return self._json(404, {"ok": False, "error": "not_found"})
        try:
            proc = subprocess.Popen(["explorer.exe", path])
        except OSError:
            return self._json(500, {"ok": False, "error": "open_failed"})
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            rc = 0   # 进程已起·窗口通常已开（explorer 偶不退出）
        # explorer 正常打开退出码也是 1——0/1 均 success（勿当失败）·回实际路径供前端提示
        return self._json(200, {"ok": True, "path": path}) if rc in (0, 1) else self._json(500, {"ok": False, "error": "open_failed"})

    # ===== 资产库导出 POST /gui13-fs/assets_export（同源写闸·只读资产文件·zip 临时目录现打包现清）=====
    def _assets_export_post(self):
        """档案卡缓存 + 卡内 media 图片 → assets-export-<时间戳>.zip（内 cards.json + images/）。
        空库 404 归一 JSON；损档 500；越界/不存在图片跳过并计入 X-Export-Missing（不伪造、不读白名单外文件）。
        大库不阻塞进程：逐请求 handler 线程内打包 + 流式回传，无全局锁；浏览器下载由准备时长决定。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        self._read_body()   # 端点无参数：仅排空 body 保持 keep-alive 语义
        try:
            collected = _asset_export_collect()
        except (OSError, ValueError):
            return self._json(500, {"ok": False, "error": "cache_corrupt"})
        if collected is None:
            return self._json(404, {"ok": False, "error": "empty_library"})
        entries, images, missing = collected
        if not entries:
            return self._json(404, {"ok": False, "error": "empty_library"})
        tmpdir = tempfile.mkdtemp(prefix="gui13_assets_export_")
        zip_path = os.path.join(tmpdir, "assets.zip")
        try:
            try:
                with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                    zf.writestr("cards.json", json.dumps(entries, ensure_ascii=False, indent=2))
                    for src, arc in images:
                        zf.write(src, arc)
                size = os.path.getsize(zip_path)
            except OSError:
                return self._json(500, {"ok": False, "error": "zip_failed"})
            filename = "assets-export-%s.zip" % time.strftime("%Y%m%d-%H%M%S")
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Export-Cards", str(len(entries)))
            self.send_header("X-Export-Images", str(len(images)))
            self.send_header("X-Export-Missing", str(missing))
            self.end_headers()
            with open(zip_path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # ===== 批 M5 T0：/gui13-fs/engine_start|engine_stop（同源写侧闸同 open_dir）=====
    def _engine_post(self, op):
        """引擎进程端点（M5 T0）：安全闸 → 端口白名单 → **在途单例（全程 finally 必释放·B-3-12）** → 委托 _engine_*_run。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        port, err = _engine_port_ok(self._read_body())
        if err is not None:
            return self._json(err[0], {"ok": False, "error": err[1]})
        took, since = _engine_op_take()
        if not took:
            return self._json(409, {"ok": False, "error": "engine_start_busy", "since": since})
        try:
            code, payload = _engine_start_run(port) if op == "start" else _engine_stop_run(port)
            return self._json(code, payload)
        finally:
            _engine_op_drop()

    # ===== 地基批1 T7 #52：首启体检 GET /gui13-fs/healthcheck（只读诊断·零写）=====
    def _healthcheck_get(self):
        """首启体检七项（回环 Host 闸同 engine_start·GET 只读故不加 Origin 写闸）→ 200 {ok, items}。"""
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "forbidden"})
        items = _health_items()
        return self._json(200, {"ok": all(i["ok"] for i in items), "items": items})

    # ===== U-批 U4：引擎端口自动扫描 GET /gui13-fs/scan_engine（只读零写·回环 Host 闸同 healthcheck）=====
    def _scan_engine_get(self):
        """并发探 8188-8200 引擎健康端点 → 200 {ok, port}（GET 只读故不加 Origin 写闸）。"""
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "forbidden"})
        return self._json(200, _engine_scan_run())

    # ===== 释放显存批：引擎忙闲只读 + 释放动作 =====
    def _engine_busy_get(self):
        """引擎忙闲（回环 Host 闸同 healthcheck·只读）→ 200 {ok,running,pending,busy}；不可达 200 归一（状态查询不判 HTTP 失败）。"""
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "forbidden"})
        q = _engine_queue()
        if q is None:
            return self._json(200, {"ok": False, "error": "engine_unreachable"})
        return self._json(200, {"ok": True, "running": q["running"], "pending": q["pending"],
                                "busy": q["running"] + q["pending"] > 0})

    def _free_vram_post(self):
        """释放显存（同源写闸同 engine_start）：忙且未 force → 409（前端二次确认）；否则 /free 并回释放前后 VRAM。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        body = self._read_body()
        if not isinstance(body, dict):
            return self._json(400, {"ok": False, "error": "bad_json"})
        q = _engine_queue()
        if q is None:
            return self._json(502, {"ok": False, "error": "engine_unreachable"})
        if q["running"] + q["pending"] > 0 and body.get("force") is not True:
            return self._json(409, {"ok": False, "error": "engine_busy",
                                    "running": q["running"], "pending": q["pending"]})
        before = _vram_gb(_engine_stats())
        if not _engine_free_vram():
            return self._json(502, {"ok": False, "error": "free_failed"})
        after = _vram_gb(_engine_stats())
        return self._json(200, {"ok": True, "before_free_gb": before["free_gb"],
                                "after_free_gb": after["free_gb"],
                                "total_gb": after["total_gb"] if after["total_gb"] is not None else before["total_gb"]})

    def _workspace_post(self):
        """R-59 T1：输出根设置 + projects 数据搬家（同源写闸同 _engine_post）·body {"root": 绝对路径|""}·先配置后搬家（写入/删键即生效）：设根=data/projects→<根>/projects，清空=反向搬回。"""
        if not self._host_ok() or not _write_origin_ok(self.headers.get("Origin"), self.headers.get("Sec-Fetch-Site")):
            return self._json(403, {"ok": False, "error": "forbidden"})
        body = self._read_body()
        if not isinstance(body, dict) or not isinstance(body.get("root"), str):
            return self._json(400, {"ok": False, "error": "bad_body"})
        root, err = _workspace_root_validate(body["root"])
        if err is not None: return self._json(err[0], {"ok": False, "error": err[1]})
        if root:
            if not _settings_put_key("workspace_root", root): return self._json(500, {"ok": False, "error": "settings_write_failed"})
            os.makedirs(os.path.join(root, "video", "shots"), exist_ok=True)   # 引擎预检要求输出根含 video\shots 子目录（batch_core 预检启发式）——设根时建骨架防首跑被拒（R-59 真机测试发现 2026-10-11）
            moved, skipped, failed = _projects_migrate(os.path.join(DATA_DIR, "projects"),
                                                       os.path.join(root, "projects"))
        else:
            old = _workspace_root_setting()
            if not _settings_put_key("workspace_root", None): return self._json(500, {"ok": False, "error": "settings_write_failed"})
            moved, skipped, failed = (0, 0, []) if not old else _projects_migrate(
                os.path.join(old, "projects"), os.path.join(DATA_DIR, "projects"))
        return self._json(200, {"ok": True, "root": root, "moved": moved, "skipped": skipped, "failed": failed})

    # ===== #41 文档只读端点（T2）：本地 .md/.txt 文本回包·不触引擎不写盘 =====
    def _read_doc_get(self):
        """GET /gui13-fs/read_doc?path=<绝对路径>（回环 Host 闸同 engine_busy·只读）。
        绝对路径（拒 ../ 与相对盘符）·后缀 .md/.txt·getsize 预检 ≤1MB（不读超限文件）→ 200 文本
        （utf-8·errors=replace 防坏档）；各失败分支 _json 4xx。"""
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "forbidden"})
        p = (parse_qs(self.path.partition("?")[2]).get("path") or [""])[0]
        norm = os.path.normpath(p)
        if not p or not os.path.isabs(p) or ".." in norm.replace("\\", "/").split("/"):
            return self._json(400, {"ok": False, "error": "invalid_path"})
        if not p.lower().endswith((".md", ".txt")):
            return self._json(400, {"ok": False, "error": "bad_suffix"})
        try:
            if not os.path.isfile(p):
                return self._json(404, {"ok": False, "error": "not_found"})
            if os.path.getsize(p) > 1_048_576:
                return self._json(413, {"ok": False, "error": "too_large"})
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            return self._json(404, {"ok": False, "error": "not_found"})
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 静态模块防缓存（批 J 缓存坑治本·P10 遗留⑤）：无此头 Chrome 启发式缓存喂旧 JS——
        #   多起「已修好老板仍见旧行为」的根源。仅静态分支置位（引擎转发/视频流不受影响）。
        if getattr(self, "_static_no_cache", False):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):
        _p, _, _q = self.path.partition("?")
        if _p == "/gui13-data": return self._data_get(_q)   # M-T1 数据读（同源·优先于静态与转发）
        if _p == "/gui13-export": return self._export_get(_q)   # H-T1 job 轮询
        if _p == "/gui13-fs/media": return self._media_get(_q)   # B-T1 本地媒体流（Range/304 本地实现）
        if _p == "/gui13-fs/thumb": return self._thumb_get(_q)   # B-T2 本地缩略（ffmpeg 出图）
        if _p == "/gui13-fs/healthcheck": return self._healthcheck_get()   # T7 #52 首启体检（只读·七项）
        if _p == "/gui13-fs/scan_engine": return self._scan_engine_get()   # U-批 U4：引擎端口自动扫描（只读·回环闸）
        if _p == "/gui13-fs/engine_busy": return self._engine_busy_get()   # 释放显存批：引擎忙闲（只读）
        if _p == "/gui13-fs/read_doc": return self._read_doc_get()   # #41 文档源只读（回环 Host 闸·绝对路径·.md/.txt·1MB）
        if self.path.split("?")[0] == "/ws" and self._is_ws_upgrade(): return self._proxy_ws()
        if self.path.startswith(FWD_PREFIXES): return self._forward("GET")
        # 加固 A（#31）：未注册 /gui13-fs/* 端点直返 JSON 404（不落静态 HTML）
        if self.path.startswith("/gui13-fs/"): return self._json(404, {"ok": False, "error": "unknown_gui13_endpoint"})
        if self.path.startswith("/app/"):  # 兼容 app/ 前缀（预热命令形态）
            self.path = self.path[4:]
        self._static_no_cache = True
        super().do_GET()
        self._static_no_cache = False
    def do_POST(self):
        _p = self.path.split("?")[0]
        if _p == "/gui13-export": return self._export_post()   # H-T1 导出伴生（_forward 前拦截·方案 §五 首验点）
        if _p == "/gui13-fs/open_dir": return self._open_dir_post()
        if _p == "/gui13-fs/assets_export": return self._assets_export_post()   # 资产库 zip 导出（只读）
        if _p == "/gui13-fs/engine_start": return self._engine_post("start")   # M5 T0：探活/清理/拉起
        if _p == "/gui13-fs/engine_stop": return self._engine_post("stop")     # M5 T0：树杀/清 PID 文件
        if _p == "/gui13-fs/free_vram": return self._free_vram_post()          # 释放显存批：忙时 409·force 放行
        if _p == "/gui13-fs/set_workspace": return self._workspace_post()      # R-59 T1：输出根+projects 搬家
        # 加固 A（#31）：未注册 /gui13-fs/* 端点直返 JSON 404——闸在转发兜底之前·绝不转发引擎
        if self.path.startswith("/gui13-fs/"): return self._json(404, {"ok": False, "error": "unknown_gui13_endpoint"})
        return self._forward("POST")
    def do_PUT(self):   # M-T1 数据写（引擎侧无 PUT 转发·非本端点一律 405）
        if self.path.split("?")[0] == "/gui13-data": return self._data_put()
        return self._json(405, {"ok": False, "error": "method_not_allowed"})
    def do_DELETE(self): return self._forward("DELETE")
    def do_HEAD(self):
        if self.path.startswith(FWD_PREFIXES): return self._forward("HEAD")
        super().do_HEAD()
    def log_message(self, *a): pass

# ===== 批 H T1：导出伴生纯函数与 job 执行体（模块级·与既有转发零纠缠）=====

# J5-T1 裁决 1（S1）：写侧同源 Origin 白名单（默认端口 8940 = 方案钉死集合 {http://127.0.0.1:8940, http://localhost:8940}）
_SAME_ORIGIN_ORIGINS = frozenset(("http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT))

def _write_origin_ok(origin, site):
    """写侧同源校验（J5-T1 裁决 1·S1 纯函数 header 值→bool）：Origin 命中本服同源白名单 或
    Sec-Fetch-Site=same-origin → 过（二者其一）；皆缺/皆不命中 → 拒（调用方 403）。
    _host_ok 防 DNS rebinding 不防跨站 text/plain 表单 POST（方案 I1 如实化）——本函数补该面：
    跨站表单 Origin=攻击域或 null、无 Sec-Fetch-* 的盲打均不命中。"""
    if isinstance(origin, str) and origin.strip().lower() in _SAME_ORIGIN_ORIGINS:
        return True
    return isinstance(site, str) and site.strip().lower() == "same-origin"

def _g(v):
    """ffmpeg 参数数值格式化：%g 去尾零（0.0→"0"·1.25→"1.25"）。"""
    return "%g" % (v,)

def _num(v, default=None):
    """spec 数值字段收数：bool 是 int 子类须显式排除。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    return float(v)

def _rate(s):
    """ffprobe 帧率分数（"30000/1001"）→ float·无效 None。"""
    if not isinstance(s, str) or "/" not in s:
        return None
    try:
        n, d = s.split("/", 1)
        n, d = float(n), float(d)
        return n / d if d else None
    except (ValueError, ZeroDivisionError):
        return None

def _probe_one(path):
    """单文件探测（v2 I1·GUI 探测唯一通道）：ffprobe JSON 优先·ffprobe 不存在时 ffmpeg -i stderr 兜底。
    失败/超时 10s → None（调用方 502 probe_failed）。"""
    cfg = _engine_cfg()
    if os.path.isfile(cfg["ffprobe"]):
        argv = [cfg["ffprobe"], "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path]
        def _pf(v):                          # ffprobe 数值字段：duration 在 JSON 里是字符串
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        try:
            r = subprocess.run(argv, capture_output=True, timeout=10)
            if r.returncode != 0:
                return None
            data = json.loads(r.stdout.decode("utf-8", "replace"))
            vs = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
            fps = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate")) if vs else None
            dur = _pf(data.get("format", {}).get("duration"))
            if dur is None and vs:
                dur = _pf(vs.get("duration"))
            if not (vs and vs.get("width") and vs.get("height") and fps and dur):
                return None
            return {"w": int(vs["width"]), "h": int(vs["height"]), "fps": fps, "duration": dur}
        except (subprocess.TimeoutExpired, ValueError, KeyError, OSError):
            return None
    try:                                     # 兜底：ffmpeg -i 信息转储在 stderr（无输出规格·退出码必非 0）
        r = subprocess.run([cfg["ffmpeg"], "-i", path], capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
        s = r.stderr.decode("utf-8", "replace")
        md = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", s)
        iv = s.find("Video:")
        mv = re.search(r"(\d{2,5})x(\d{2,5})", s[iv:]) if iv >= 0 else None
        mf = re.search(r"([\d.]+)\s*fps", s[iv:]) if iv >= 0 else None
        if not (md and mv and mf):
            return None
        return {"w": int(mv.group(1)), "h": int(mv.group(2)), "fps": float(mf.group(1)),
                "duration": int(md.group(1)) * 3600 + int(md.group(2)) * 60 + float(md.group(3))}
    except (subprocess.TimeoutExpired, OSError):
        return None

def _export_roots():
    """双根推导（裁决 1/S5）：input=引擎 /h3_batch/input_dir 实答 dir·output=同父 output/。
    失败→None（调用方 502·不降级放开校验）。"""
    global _export_roots_cache
    with _jobs_lock:
        if _export_roots_cache:
            return _export_roots_cache
    cfg = _engine_cfg()
    try:
        with urllib.request.urlopen(cfg["addr"] + "/h3_batch/input_dir", timeout=10) as resp:
            inp = json.loads(resp.read().decode("utf-8"))["dir"]
        if not isinstance(inp, str) or not inp:
            raise ValueError("bad input_dir")
    except Exception:
        return None
    inp = os.path.realpath(inp.rstrip("\\/") or inp)
    roots = (inp, os.path.realpath(os.path.join(os.path.dirname(inp), "output")))
    with _jobs_lock:
        if _export_roots_cache is None:
            _export_roots_cache = roots
    _persist_engine_roots(_export_roots_cache)   # 批 B：成功探得即持久化（离线冷启动白名单兜底·值不变不写盘）
    return _export_roots_cache

def _path_in_roots(p, roots):
    """realpath 前缀白名单（复用 _data_key 模式·三根：input/output/REPO_ROOT/data·normcase 防 Windows 大小写假阴）。
    R-59 T1：workspace 已设追加 <根>/projects 子树（projects 实体搬家后的落点·其余白名单不变）。"""
    rp = os.path.realpath(str(p or ""))
    rn = os.path.normcase(rp)
    cands = (roots[0], roots[1], os.path.realpath(DATA_DIR))
    ws = _workspace_root_setting()
    if ws:
        cands += (os.path.realpath(os.path.join(ws, "projects")),)
    for root in cands:
        c = os.path.normcase(root)
        if rn == c or rn.startswith(c + os.sep):
            return rp
    return None

# ===== 批 B #13：本地文件流伴生纯函数与根三轨（与既有导出双根/白名单同款·零纠缠）=====

def _media_engine_roots():
    """引擎双根活探（媒体路径专用）：成功缓存归 _export_roots（含持久化副作用）·失败负缓存冷却
    （MEDIA_PROBE_COOLDOWN·防半死引擎每媒体请求 10s 阻塞；连接拒绝本就瞬时·冷却只对挂起形态生效）。"""
    global _media_probe_fail_at
    with _jobs_lock:
        if _export_roots_cache:
            return _export_roots_cache
        if time.time() - _media_probe_fail_at < MEDIA_PROBE_COOLDOWN:
            return None
    roots = _export_roots()
    if roots is None:
        with _jobs_lock:
            _media_probe_fail_at = time.time()
    return roots

def _media_roots():
    """媒体/缩略白名单根集（批 B 三轨）→ cands 元组：
    ①workspace_root（R-59-T2b 口径·含 projects 子树）②引擎双根（活探·失败退 data/settings.json
    持久化根——离线冷启动兜底）③engine_dir/output（旧轨产物默认树）。"""
    cands = []
    ws = _workspace_root_setting()
    if ws:
        cands += [ws, os.path.realpath(os.path.join(ws, "projects"))]
    roots = _media_engine_roots()
    if roots:
        cands += [roots[0], roots[1]]
    else:
        for k in ("engine_input_root", "engine_output_root"):
            v = _settings_load().get(k)
            if isinstance(v, str) and v:
                cands.append(os.path.realpath(v))
    cands.append(os.path.realpath(os.path.join(_engine_cfg()["engine_dir"], "output")))
    return tuple(cands)

def _path_in_media_roots(p):
    """媒体白名单（_path_in_roots 同式）：realpath+normcase 前缀判定（.. 逃逸折叠后出根即拒）→ rp | None。"""
    rp = os.path.realpath(str(p or ""))
    rn = os.path.normcase(rp)
    for root in _media_roots():
        c = os.path.normcase(root)
        if rn == c or rn.startswith(c + os.sep):
            return rp
    return None

def _persist_engine_roots(roots):
    """引擎双根持久化（批 B·离线冷启动白名单兜底）：成功探得即落 data/settings.json 两键（值不变不写盘）。"""
    doc = _settings_load()
    if doc.get("engine_input_root") == roots[0] and doc.get("engine_output_root") == roots[1]:
        return
    _settings_put_key("engine_input_root", roots[0])
    _settings_put_key("engine_output_root", roots[1])

# ===== 资产库导出端点 /gui13-fs/assets_export（2026-10-25 老板裁决：真导出卡+图 zip·只读）=====
ASSET_CARDS_CACHE = "asset-cards-cache.json"
ASSET_IMAGE_EXTS = frozenset((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"))

def _asset_input_roots():
    """当前引擎 input 可读根（相对 media 首选解析）：settings 持久化 > 活探 > engine_dir/input。
    每请求现读 settings（同 _media_roots 口径）；去重按 normcase（Windows 大小写）。"""
    roots = []
    persisted = _settings_str("engine_input_root")
    if persisted:
        roots.append(os.path.realpath(persisted))
    live = _media_engine_roots()
    if live:
        roots.append(os.path.realpath(live[0]))
    roots.append(os.path.realpath(os.path.join(_engine_cfg()["engine_dir"], "input")))
    out, seen = [], set()
    for r in roots:
        c = os.path.normcase(r)
        if c not in seen:
            seen.add(c)
            out.append(r)
    return tuple(out)

def _asset_export_abs_ok(rp, roots):
    """绝对媒体路径白名单：当前引擎 input 根内，或任意 .../input|output 子树
    （历史卡跨引擎安装的绝对路径兜底·只读·normalize 后的 .. 逃逸出这些树即拒）。"""
    rn = os.path.normcase(rp)
    for root in roots:
        c = os.path.normcase(root)
        if rn == c or rn.startswith(c + os.sep):
            return True
    parts = [p.lower() for p in re.split(r"[\\/]+", rp)]
    return "input" in parts or "output" in parts

def _asset_export_resolve(media, roots, engine_dir):
    """卡内 media → 可读绝对路径 | None（越界/不存在/非图片均 None）。"""
    s = media.strip()
    if not s or "\x00" in s:
        return None
    if os.path.splitext(s.replace("\\", "/"))[1].lower() not in ASSET_IMAGE_EXTS:
        return None   # 视频/音频不打包（卡数据仍原样进 cards.json）
    if re.match(r"^[A-Za-z]:[\\/]", s) or s.startswith(("\\\\", "//", "/")):
        rp = os.path.realpath(s)
        return rp if os.path.isfile(rp) and _asset_export_abs_ok(rp, roots) else None
    rel = s.replace("\\", "/").lstrip("/")
    segs = rel.split("/")
    if not rel or any(seg in ("", ".", "..") for seg in segs):
        return None
    for root in roots:
        cand = os.path.realpath(os.path.join(root, rel))
        if os.path.normcase(cand).startswith(os.path.normcase(root) + os.sep) and os.path.isfile(cand):
            return cand
    if segs[0].lower() == "input":   # thumb 规范形态（input/...）相对 ComfyUI 根
        cand = os.path.realpath(os.path.join(engine_dir, rel))
        if os.path.normcase(cand).startswith(os.path.normcase(engine_dir) + os.sep) and os.path.isfile(cand):
            return cand
    return None

def _asset_export_image_name(basename, used):
    """zip 内图片名：清洗路径分隔符/控制符 → 同名去重加 -2/-3（不区分大小写·Windows 解压友好）。"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", basename).strip().lstrip(".") or "image"
    stem, ext = os.path.splitext(name)
    cand, i = name, 2
    while cand.lower() in used:
        cand = "%s-%d%s" % (stem, i, ext)
        i += 1
    used.add(cand.lower())
    return "images/" + cand

def _asset_export_collect():
    """读 data/asset-cards-cache.json → (cards 数组, [(源路径, zip 内名)], missing 数)。
    cards 数组元素 = {name, card}（与前端 parseAssetImport 的 [{name,card}] 分支同构）。
    缓存缺失/空库返回 None；损档抛 ValueError/OSError（调用方归一 500）。"""
    path = os.path.join(DATA_DIR, ASSET_CARDS_CACHE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return None
    assets = doc.get("assets") if isinstance(doc, dict) else None
    if not isinstance(assets, dict):
        raise ValueError("bad asset-cards-cache")
    entries, images, used, seen, missing = [], [], set(), set(), set()
    roots = _asset_input_roots()
    engine_dir = os.path.realpath(_engine_cfg()["engine_dir"])
    for name, card in assets.items():
        if not isinstance(name, str) or not name or not isinstance(card, dict):
            continue
        entries.append({"name": name, "card": card})
        rows = card.get("rows")
        if not isinstance(rows, list):
            continue
        for row in rows:
            media = row.get("media") if isinstance(row, dict) else None
            if not isinstance(media, str) or os.path.splitext(media.replace("\\", "/"))[1].lower() not in ASSET_IMAGE_EXTS:
                continue
            rp = _asset_export_resolve(media, roots, engine_dir)
            if rp is None:
                missing.add(media)
                continue
            key = os.path.normcase(rp)
            if key in seen:
                continue
            seen.add(key)
            images.append((rp, _asset_export_image_name(os.path.basename(rp), used)))
    return entries, images, len(missing)

def _ims_fresh(header_val, mtime):
    """If-Modified-Since 判定（纯函数）：头缺/解析失败 → False（回 200）；文件秒级 mtime ≤ 头时刻 → True。"""
    if not header_val:
        return False
    t = email.utils.parsedate_tz(header_val.strip())
    if t is None:
        return False
    try:
        return int(mtime) <= email.utils.mktime_tz(t)
    except (OverflowError, ValueError):
        return False

def _thumb_argv(path, max_size, out_path):
    """thumb 出图 argv（视频抽帧/图片缩放同式）：首帧 + 等比缩到 max_size 内（min 防放大·高 -2 偶数化）。"""
    return [_engine_cfg()["ffmpeg"], "-y", "-nostats", "-loglevel", "error", "-i", path, "-frames:v", "1",
            "-vf", "scale='min(iw,%d)':-2" % max_size, "-q:v", "3", out_path]

def _export_out_dir_setting():
    """data/settings.json 聚合子键 export_out_dir（J5-T1 裁决 4·与前端 readAgg 同键同源）：
    非空字符串 → realpath+normcase 归一值；缺席/空/非字符串/损档 → None（不注入·现状口径）。"""
    try:
        with open(os.path.join(DATA_DIR, "settings.json"), "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    val = doc.get("export_out_dir") if isinstance(doc, dict) else None
    if not isinstance(val, str):
        return None
    val = val.strip()
    return os.path.normcase(os.path.realpath(val)) if val else None

def _settings_load():
    """data/settings.json 读档 → dict（缺失/损档/非对象 → {}·R-59 T1 workspace 两用件共用）。"""
    try:
        with open(os.path.join(DATA_DIR, "settings.json"), "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}

def _settings_str(key):
    """data/settings.json 字符串子键 → strip 值（非字符串/缺失/空 → ""·空串即未设）。"""
    v = _settings_load().get(key)
    return v.strip() if isinstance(v, str) else ""

def _engine_port(addr):
    """origin 串 → 端口｜非法（scheme 非 http/https·无 host·端口非数字）→ None。
    urlsplit.port 对非数字端口抛 ValueError·此处一并吞（配置键可被手改成任意串·不可让整请求炸）。"""
    sp = urlsplit(addr)
    try:
        port = sp.port
    except ValueError:
        return None
    return port if (sp.scheme in ("http", "https") and sp.hostname and port) else None

def _engine_cfg():
    """引擎连接配置三级读取（地基批1 T1 #46：env > data/settings.json 键 > 默认·**每请求现读勿缓存**·
    循 _workspace_root_setting 先例）→ {addr, engine_dir, ffmpeg, ffprobe, port}。
    addr 须完整 origin（http/https + host + 显式端口·端口即白名单端口），空/缺失/非法 → 默认档。
    ffprobe 自 ffmpeg 同目录派生（不单存键）。不设 env 不设键 → 逐字回落默认常量（与旧硬编码等价）。"""
    addr = os.environ.get("GUI13_ENGINE_ADDR") or _settings_str("engine_addr") or ENGINE
    port = _engine_port(addr)
    if port is None:
        addr = ENGINE            # 非法=未设 → 默认档
        port = _engine_port(addr)
    ffmpeg = os.environ.get("GUI13_FFMPEG") or _settings_str("ffmpeg_path") or FFMPEG
    return {"addr": addr,
            "engine_dir": os.environ.get("GUI13_ENGINE_DIR") or _settings_str("engine_dir") or ENGINE_DIR,
            "ffmpeg": ffmpeg,
            "ffprobe": os.path.join(os.path.dirname(ffmpeg), "ffprobe.exe"),
            "port": port}

def _workspace_root_validate(raw):
    """workspace_root 四步校验（R-59 T1·次序仿 _normalize_spec out_dir）→ (归一路径, None) | ("", (码, err))；空串=恢复默认。①拒 .. ②须绝对 ③须盘符或 UNC ④normcase+realpath。"""
    raw = raw.strip()
    if not raw: return "", None
    if ".." in re.split(r"[\\/]+", raw): return "", (400, "bad_root_traversal")
    if not os.path.isabs(raw): return "", (400, "bad_root_relative")
    if not (re.match(r"^[A-Za-z]:", raw) or raw.startswith(("\\\\", "//"))): return "", (400, "bad_root_nodrive")
    return os.path.normcase(os.path.realpath(raw)), None

def _workspace_root_setting():
    """data/settings.json 聚合子键 workspace_root（R-59 T1·每请求现读勿缓存）→ 归一值；缺失/空/非法 → ""（未设=现状）。"""
    val = _settings_load().get("workspace_root")
    return _workspace_root_validate(val)[0] if isinstance(val, str) else ""

def _settings_put_key(key, val):
    """settings.json 单键原子改写（R-59 T1·val=None=删键·temp+os.replace 同 _data_put·其余键保留）→ True/False。"""
    doc = _settings_load()
    if val is None: doc.pop(key, None)
    else: doc[key] = val
    tmp = ""
    try:
        fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(DATA_DIR, "settings.json"))
        return True
    except OSError:
        if tmp:
            try: os.unlink(tmp)
            except OSError: pass
        return False

def _projects_migrate(src_dir, dst_dir):
    """projects 实体 *.json 与 <projectId>/ 快照目录整体 shutil.move（幂等：目标同名跳过·失败收集不中断）→ (moved, skipped, failed)；在途 PUT 并发窗口由既有对账兜底（已裁决接受）。"""
    try: names = sorted(os.listdir(src_dir))
    except OSError: return 0, 0, []
    try: os.makedirs(dst_dir, exist_ok=True)
    except OSError: return 0, 0, [n for n in names if n.endswith(".json") or os.path.isdir(os.path.join(src_dir, n))]
    moved, skipped, failed = 0, 0, []
    for n in names:
        s = os.path.join(src_dir, n)
        if not ((n.endswith(".json") and os.path.isfile(s)) or os.path.isdir(s)): continue
        d = os.path.join(dst_dir, n)
        if os.path.exists(d): skipped += 1; continue
        try:
            shutil.move(s, d)
            moved += 1
        except OSError:
            failed.append(n)
    return moved, skipped, failed

def _snapshot_dir_removable(d):
    """<projectId>/ 只含 runs/ 且 runs/ 只含 *.json 快照（无未知内容）→ True；空目录视同无用户数据。"""
    try: names = os.listdir(d)
    except OSError: return False
    if not names: return True
    if names != ["runs"]: return False
    runs = os.path.join(d, "runs")
    if not os.path.isdir(runs): return False
    try: subs = os.listdir(runs)
    except OSError: return False
    return all(n.endswith(".json") and os.path.isfile(os.path.join(runs, n)) for n in subs)

def _project_snapshot_dir_cleanup(key, full):
    """项目实体删除（value=null）后清理同名 <projectId>/ 快照目录——仅只含 runs/ 快照时删；未知内容保留并留日志一行（防误删用户数据）。"""
    rest = key[len("data/projects/"):]
    if "/" in rest: return                       # runs/ 子键等非项目实体：不触发目录清理
    pid = rest[:-5] if rest.endswith(".json") else ""
    if not pid: return
    d = os.path.join(os.path.dirname(full), pid)
    if not os.path.isdir(d): return
    if _snapshot_dir_removable(d):
        try:
            shutil.rmtree(d)
        except OSError:
            print(f"[projects-delete] snapshot dir remove failed: {d}", file=sys.stderr, flush=True)
        return
    print(f"[projects-delete] kept non-snapshot dir: {d}", file=sys.stderr, flush=True)

def _open_dir_target(body, roots):
    """open_dir 目标解算（纯函数·J-P6 便于回归锁）：→ (path, status, err)·status=0 即成功。
    path 缺省/null → 双根推导的 output 根（客户端不必知道引擎默认根·老板报障 18 兜底）；
    非对象/空串 → 400 bad_body；白名单外 → 403 forbidden（兜底不放宽校验）。
    J5-T1 裁决 4：白名单 miss 后以 export_out_dir 作额外根复调一次前缀判定——
    _path_in_roots 本体签名与行为不动（四端点共享面不连带放宽·仅 open_dir 注入）。"""
    if not isinstance(body, dict):
        return None, 400, "bad_body"
    raw = body.get("path")
    if raw is None:
        return roots[1], 0, None
    if not isinstance(raw, str) or not raw:
        return None, 400, "bad_body"
    if _path_in_roots(raw, roots) is None:
        out_dir = _export_out_dir_setting()
        # roots 形参按位取前两元·out_dir 同占两位（幂等；DATA_DIR 三度校验在首轮已排除·无害）
        if out_dir is None or _path_in_roots(raw, (out_dir, out_dir)) is None:
            return None, 403, "forbidden"
    return raw, 0, None

def _spec_paths_ok(spec, roots):
    """spec 全部输入文件（main+bgm）白名单校验·越界 False。"""
    files = [s["file"] for s in spec["main"]] + [b["file"] for b in spec["bgm"]]
    return all(_path_in_roots(f, roots) is not None for f in files)

def _export_out_path(spec, roots):
    """产物落位解算（J5-T1 裁决 1 纯函数）：spec.outDir（已归一值）在场 → <outDir>/<out>·
    缺省 → output 根（与改造前 dry-run/execute 内联式 realpath(join(roots[1], out)) 逐字等价）。"""
    return os.path.realpath(os.path.join(spec.get("outDir") or roots[1], spec["out"]))

OUTDIR_UNREG_MSG = "导出目录未登记：请在导出弹窗保存目录后再试"   # 批3 T4 #51 档2：第五步未命中前缀集的指路白话

def _out_dir_roots():
    """导出目录位置白名单根集（批3 T4 #51 档2·四源·每请求现读 settings 不缓存）：
    ①workspace_root 输出根（未设则 DATA_DIR 基）②engine_output_root 键 ③<engine_dir>/output
    （与 _media_roots 第三轨同源）④export_out_dir 已持久化键（GUI 导出弹窗显式保存所得）。"""
    cands = [_workspace_root_setting() or DATA_DIR]
    for k in ("engine_output_root", "export_out_dir"):
        v = _settings_str(k)
        if v:
            cands.append(v)
    cands.append(os.path.join(_engine_cfg()["engine_dir"], "output"))
    return tuple(cands)

def _out_dir_ok(p):
    """outDir 第五步位置判定：normcase+realpath 归一后逐根前缀比对（_path_in_roots 同式）→ bool。"""
    rn = os.path.normcase(os.path.realpath(str(p or "")))
    for root in _out_dir_roots():
        c = os.path.normcase(os.path.realpath(root))
        if rn == c or rn.startswith(c + os.sep):
            return True
    return False

def _spec_error_body(err):
    """_normalize_spec 错误元组 → 400 信封：error 必带·第三元为白话 msg 时并入（无 msg 者形状不变）。"""
    body = {"ok": False, "error": err[1]}
    if len(err) > 2:
        body["msg"] = err[2]
    return body

def _normalize_spec(body):
    """spec 收敛（T2 契约字段）：→ (spec, None) | (None, (code, err))。dur 已 probe 补过·T1 直信不裁域。"""
    if not isinstance(body, dict):
        return None, (400, "bad_body")
    video = body.get("video")
    if not isinstance(video, dict):
        return None, (400, "bad_spec")
    w, h, fps = _num(video.get("w")), _num(video.get("h")), _num(video.get("fps"))
    if not (w and h and fps) or w != int(w) or h != int(h) or min(w, h, fps) <= 0:
        return None, (400, "bad_spec")
    raw = body.get("main")
    if not isinstance(raw, list) or not raw:
        return None, (400, "bad_spec")
    main = []
    for i, m in enumerate(raw):
        if not isinstance(m, dict) or not isinstance(m.get("file"), str) or not m["file"]:
            return None, (400, "bad_spec")
        dur, speed = _num(m.get("dur")), _num(m.get("speed"), 1.0)
        if dur is None or dur <= 0 or speed is None or speed <= 0:
            return None, (400, "bad_spec")
        # 交界转场（批 H T7·裁决 B）：name 白名单硬校验（xfade 名字拼进 filter_complex 字符串·
        # 白名单外一律 400·防脏档注入额外滤镜参数）·dur>0·只允许挂在非末段（末段无交界）。
        xf = m.get("xfade")
        xfade = None
        if xf is not None:
            if not isinstance(xf, dict) or xf.get("name") not in XFADE_NAMES or i == len(raw) - 1:
                return None, (400, "bad_spec")
            xd = _num(xf.get("dur"))
            if xd is None or xd <= 0:
                return None, (400, "bad_spec")
            xfade = {"name": xf["name"], "dur": xd}
        main.append({"file": m["file"], "triml": max(0.0, _num(m.get("triml"), 0.0)), "dur": dur,
                     "speed": speed, "volume": max(0.0, _num(m.get("volume"), 1.0)),
                     "fadeIn": max(0.0, _num(m.get("fadeIn"), 0.0)), "fadeOut": max(0.0, _num(m.get("fadeOut"), 0.0)),
                     "splitAV": bool(m.get("splitAV")), "xfade": xfade})
    bgm = []
    for b in (body.get("bgm") or []):
        if not isinstance(b, dict) or not isinstance(b.get("file"), str) or not b["file"]:
            return None, (400, "bad_spec")
        win = _num(b.get("winDur"))
        if win is None or win <= 0:
            return None, (400, "bad_spec")
        spd = _num(b.get("speed"), 1.0)   # 锚定条变速（批 H T7·裁决 C·轴条缺省 1）
        if spd is None or spd <= 0:
            return None, (400, "bad_spec")
        bgm.append({"file": b["file"], "offset": max(0.0, _num(b.get("offset"), 0.0)),
                    "volume": max(0.0, _num(b.get("volume"), 1.0)), "triml": max(0.0, _num(b.get("triml"), 0.0)),
                    "winDur": win, "fadeIn": max(0.0, _num(b.get("fadeIn"), 0.0)),
                    "fadeOut": max(0.0, _num(b.get("fadeOut"), 0.0)), "speed": spd})
    out = body.get("out")
    if out is None:
        out = "gui13_export_%d.mp4" % int(time.time())
    if not isinstance(out, str) or not re.match(r"^[A-Za-z0-9._-]+\.mp4$", out):
        return None, (400, "bad_spec")
    # 可选 outDir（J5-T1 裁决 1·四步校验次序钉死·非法值 400 带各自原因）：
    #   ①realpath 前逐段拒 ..（realpath 会折叠 .. 使检查空文）②必须绝对
    #   ③要求盘符或 UNC（Windows isabs 对 \foo 为 True 会静默落当前盘）④normcase+realpath 归一入 spec
    #   ⑤批3 T4 #51 档2：位置约束——须命中前缀集四源（未登记目录 400 bad_outdir + 指路白话）
    out_dir = body.get("outDir")
    if out_dir is not None:
        if not isinstance(out_dir, str):
            return None, (400, "bad_out_dir")
        if ".." in re.split(r"[\\/]+", out_dir):
            return None, (400, "bad_out_dir_traversal")
        if not os.path.isabs(out_dir):
            return None, (400, "bad_out_dir_relative")
        if not (re.match(r"^[A-Za-z]:", out_dir) or out_dir.startswith(("\\\\", "//"))):
            return None, (400, "bad_out_dir_nodrive")
        out_dir = os.path.normcase(os.path.realpath(out_dir))
        if not _out_dir_ok(out_dir):
            return None, (400, "bad_outdir", OUTDIR_UNREG_MSG)
    spec = {"out": out, "video": {"w": int(w), "h": int(h), "fps": fps},
            "mutedMain": bool(body.get("mutedMain")), "main": main, "bgm": bgm}
    if out_dir is not None:
        spec["outDir"] = out_dir   # 缺省不发键（现状零变化）
    return spec, None

def _atempo_chain(speed):
    """atempo 单值域 [0.5,2] 链式拆分（3b-③ 双端：<0.5 与 >2。0.25=0.5×0.5·10=2×2×2×1.25）。"""
    vals, s = [], float(speed)
    while s < 0.5:
        vals.append(0.5)
        s *= 2.0
    while s > 2.0:
        vals.append(2.0)
        s /= 2.0
    vals.append(round(s, 6))
    return vals

def _mixed_audio(spec):
    """主轨音轨布局是否混排（批 J-P3 根因判定）：既有静音段·又有有声段。
    交界 concat demuxer 取**首段**流布局：混排且首段静音 → 整片音轨在拼接中丢失
    （无 BGM 静默丢音·有 BGM 时 mix 的 [0:a] 绑定失败：ffmpeg Invalid argument·老板 2026-10-07 复验）。"""
    silent = [bool(spec["mutedMain"] or s["splitAV"]) for s in spec["main"]]
    return any(silent) and not all(silent)

def _seg_argv(spec, seg, out_path):
    """①每段归一化 argv（裁决 3①+3b 四注记）：统一 w/h/fps/采样率——xfade/concat 同参前提。
    跳废 filter：speed=1 无 setpts/atempo·volume=1 无 volume·fade=0 无对应 afade。
    混排时静音段补 anullsrc 等长静音轨（统一各段流布局=交界前提·J-P3）；均匀轨维持 -an 零回归。"""
    w, h, fps = spec["video"]["w"], spec["video"]["h"], spec["video"]["fps"]
    speed, dur = seg["speed"], seg["dur"]
    vf = []
    if speed != 1.0:
        vf.append("setpts=PTS/%s" % _g(speed))
    vf.append("fps=%s" % _g(fps))           # fps 统一（3b-② 段间硬一致·-c copy concat 前提）
    vf.append("scale=%d:%d:force_original_aspect_ratio=decrease" % (w, h))
    vf.append("pad=%d:%d:(ow-iw)/2:(oh-ih)/2" % (w, h))
    vf.append("format=yuv420p")
    silent = spec["mutedMain"] or seg["splitAV"]  # 静音条件 = mutedMain || splitAV（裁决 5·previewSurfaceOf 同式）
    pad = silent and _mixed_audio(spec)           # 混排才补（均匀轨补=无用编码）
    argv = [_engine_cfg()["ffmpeg"], "-y", "-nostats", "-progress", "pipe:1",
            "-ss", _g(seg["triml"]), "-t", _g(dur), "-i", seg["file"]]
    if pad:   # anullsrc 输入须在 -vf 之前（其后 -vf 会被判给该输入·ffmpeg 拒）；-t 取输出域长 dur/speed（与 setpts 后视频等长）
        argv += ["-f", "lavfi", "-t", _g(_out_len(seg)),
                 "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    argv += ["-vf", ",".join(vf), "-c:v", "libx264"]
    if silent:
        argv += ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ac", "2"] if pad else ["-an"]
    else:
        af = []
        if speed != 1.0:
            af += ["atempo=%s" % _g(x) for x in _atempo_chain(speed)]
        if seg["volume"] != 1.0:
            af.append("volume=%s" % _g(seg["volume"]))
        if seg["fadeIn"] > 0:                # afade speed 域换算（3b-④：源秒域→输出域 = /speed）
            af.append("afade=t=in:st=0:d=%s" % _g(seg["fadeIn"] / speed))
        if seg["fadeOut"] > 0:
            af.append("afade=t=out:st=%s:d=%s" % (_g(max(0.0, dur - seg["fadeOut"]) / speed), _g(seg["fadeOut"] / speed)))
        af.append("aresample=44100")
        argv += ["-af", ",".join(af), "-ac", "2", "-c:a", "aac"]
    argv += ["-video_track_timescale", "30000", out_path]   # timescale 统一（3b-②）
    return argv

def _out_len(seg):
    """段输出域长（成片几何基准·与 GUI effDurOf 同式）= dur/speed。"""
    return seg["dur"] / seg["speed"]

def _join_total(spec):
    """拼接后成片长：Σ dur/speed − Σ 转场 dur（xfade 重叠消耗）。
    无转场交界走 concat（精确保长）→ 公式退化为旧值·零回归。供 mix 链 apad whole_dur 与封长使用。"""
    total = 0.0
    for i, s in enumerate(spec["main"]):
        total += _out_len(s)
        x = s.get("xfade")
        if x and i < len(spec["main"]) - 1:
            total -= x["dur"]
    return total

def _xfade_argv(spec, workdir, out_path):
    """④交界拼接链（批 H T7·裁决 B）：段归一化产物 → filter_complex 逐交界 xfade；
    无转场交界用 concat filter（**不用** xfade 0.04 最小交叉——concat 精确保长·非转场交界不该丢帧）。
    音轨全程 concat filter **硬切**（acrossfade 不做·音轨转场=硬切·方案登记迭代）:
    静音段（mutedMain||splitAV·段归一化已 -an）补 anullsrc 等长静音轨·否则 concat 滤波缺输入。"""
    n = len(spec["main"])
    silent = [i for i, s in enumerate(spec["main"]) if spec["mutedMain"] or s["splitAV"]]
    argv = [_engine_cfg()["ffmpeg"], "-y", "-nostats", "-progress", "pipe:1"]
    for i in range(n):
        argv += ["-i", os.path.join(workdir, "seg%d.mp4" % i)]
    for i in silent:                          # anullsrc 无限长 → -t 限到该段输出域长
        argv += ["-f", "lavfi", "-t", _g(_out_len(spec["main"][i])),
                 "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    a_idx = {i: n + k for k, i in enumerate(silent)}   # 静音段音频改指 anullsrc 输入号
    parts, vprev, aprev, acc = [], None, None, 0.0
    for i, s in enumerate(spec["main"]):
        parts.append("[%d:v]setsar=1[v%d]" % (i, i))   # SAR 归一（concat 滤波要求各段一致）
        parts.append("[%d:a]aresample=44100[a%d]" % (a_idx.get(i, i), i))
        if i == 0:
            vprev, aprev = "[v0]", "[a0]"
            acc = _out_len(s)
            continue
        x = spec["main"][i - 1].get("xfade")   # 交界转场挂**前一段**（编辑态出口语义·组装器同式）
        if x:   # 转场交界：xfade 重叠 = 时长 dur·offset = 前段累计末端 − dur（两两链式）
            parts.append("%s[v%d]xfade=transition=%s:duration=%s:offset=%s[x%d]"
                         % (vprev, i, x["name"], _g(x["dur"]), _g(max(0.0, acc - x["dur"])), i))
            acc += _out_len(s) - x["dur"]
        else:
            parts.append("%s[v%d]concat=n=2:v=1:a=0[x%d]" % (vprev, i, i))
            acc += _out_len(s)
        vprev = "[x%d]" % i
        parts.append("%s[a%d]concat=n=2:v=0:a=1[y%d]" % (aprev, i, i))   # 音轨硬切
        aprev = "[y%d]" % i
    argv += ["-filter_complex", ";".join(parts), "-map", vprev, "-map", aprev,
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2",
             "-video_track_timescale", "30000", out_path]
    return argv

def _mix_argv(spec, main_file, out_path, total):
    """③BGM 二次混入（裁决 3②·3b-① amix 必须 normalize=0+显式 volume+duration=first）。
    main 全静音→无 [0:a]：仅 BGM amix（duration=longest + -t total 封长）。
    尾段静音时 concat 音轨短于成片（实测洞语义）→ apad 补齐主音轨，防 duration=first 截断 BGM。
    变速条（批 H T7·裁决 C·锚定条 speed≠1）：源域读长 = winDur×speed·atempo 拉回输出域窗长。"""
    bgms = spec["bgm"]
    argv = [_engine_cfg()["ffmpeg"], "-y", "-nostats", "-progress", "pipe:1", "-i", main_file]
    for b in bgms:                           # 轴窗条语义：-ss triml -t winDur 读源（winDur=输出域窗长）
        argv += ["-ss", _g(b["triml"]), "-t", _g(b["winDur"] * b.get("speed", 1.0)), "-i", b["file"]]
    parts, outs = [], []
    for i, b in enumerate(bgms):
        ch = []
        if b.get("speed", 1.0) != 1.0:        # 变速先施（其后 adelay/volume/afade 均在输出域）
            ch += ["atempo=%s" % _g(x) for x in _atempo_chain(b["speed"])]
        if b["offset"] > 0:
            ch.append("adelay=%d:all=1" % int(round(b["offset"] * 1000)))
        if b["volume"] != 1.0:
            ch.append("volume=%s" % _g(b["volume"]))
        if b["fadeIn"] > 0:
            ch.append("afade=t=in:st=0:d=%s" % _g(b["fadeIn"]))
        if b["fadeOut"] > 0:
            ch.append("afade=t=out:st=%s:d=%s" % (_g(max(0.0, b["winDur"] - b["fadeOut"])), _g(b["fadeOut"])))
        ch.append("aresample=44100")
        parts.append("[%d:a]%s[b%d]" % (i + 1, ",".join(ch), i))
        outs.append("[b%d]" % i)
    has_main_audio = any(not (spec["mutedMain"] or s["splitAV"]) for s in spec["main"])
    main_ref = "[ma]" if has_main_audio else None
    if has_main_audio:
        # atrim 到成片长：转场链里音轨硬切不重叠（音轨长 = Σdur/speed·比视频长 Σ转场 dur），
        #   不对齐会让容器时长被音轨拖长（无转场时 total == 音轨长·atrim 为空操作·零回归）。
        parts.insert(0, "[0:a]atrim=end=%s,apad=whole_dur=%s[ma]" % (_g(total), _g(total)))
    parts.append("%samix=inputs=%d:duration=%s:normalize=0[aout]"
                 % ("".join(([main_ref] if main_ref else []) + outs),
                    (1 if main_ref else 0) + len(outs),
                    "first" if main_ref else "longest"))
    argv += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac"]
    if not main_ref:
        argv += ["-t", _g(total)]
    argv.append(out_path)
    return argv

def _stage_labels(spec):
    """各阶段名（进度标签用）：段 → 交界（xfade/concat）→（有 BGM 时）mix。"""
    labels = ["seg %d/%d" % (i + 1, len(spec["main"])) for i in range(len(spec["main"]))]
    labels.append("xfade" if any(s.get("xfade") for s in spec["main"]) else "concat")
    if spec["bgm"]:
        labels.append("mix")
    return labels

def _stage_argvs(spec, out_path, workdir):
    """全 argv：每段归一化 + 拼接（有转场 → filter_complex xfade 链；无转场 → concat -c copy 旧管线·
    零回归）+（有 BGM 时）mix。
    workdir=execute 真临时目录 / dry-run 占位目录（仅 argv 结构清样·不起进程）。"""
    argvs = [_seg_argv(spec, seg, os.path.join(workdir, "seg%d.mp4" % i)) for i, seg in enumerate(spec["main"])]
    has_x = any(s.get("xfade") for s in spec["main"])
    join_out = out_path if not spec["bgm"] else os.path.join(workdir, "concat.mp4")
    if has_x:
        argvs.append(_xfade_argv(spec, workdir, join_out))
    else:
        argvs.append([_engine_cfg()["ffmpeg"], "-y", "-nostats", "-progress", "pipe:1", "-f", "concat", "-safe", "0",
                      "-i", os.path.join(workdir, "concat_list.txt"), "-c", "copy", join_out])
    if spec["bgm"]:
        argvs.append(_mix_argv(spec, os.path.join(workdir, "concat.mp4"), out_path, _join_total(spec)))
    return argvs

def _write_concat_list(workdir, n):
    """concat demuxer 清单：单引号包裹·内部单引号 '\'' 转义。"""
    listf = os.path.join(workdir, "concat_list.txt")
    with open(listf, "w", encoding="utf-8") as f:
        for i in range(n):
            p = os.path.join(workdir, "seg%d.mp4" % i)
            f.write("file '%s'\n" % p.replace("'", "'\\''"))
    return listf

def _pump_progress(proc, job, label):
    """-progress pipe:1 行解析：out_time → job.phase（持锁写·仅 running 态）。"""
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        val = None
        if line.startswith("out_time="):
            val = line[9:]
        elif line.startswith("out_time_us="):
            try:
                val = "%.1fs" % (int(line[12:]) / 1e6)
            except ValueError:
                val = None
        if val:
            with _jobs_lock:
                if job["status"] == "running":
                    job["phase"] = "%s %s" % (label, val)

def _kill(proc):
    if proc is not None:
        try:
            proc.kill()
        except OSError:
            pass

def _job_finish(job, status, error=None):
    """终态迁移（v3 S-5 第二段持锁）：仅 running 可迁（cancel/timeout 已迁移勿覆盖）·Timer 并撤（v2 I5）。"""
    with _jobs_lock:
        if job["status"] != "running":
            return
        job["status"] = status
        job["finishedAtMs"] = time.time() * 1000
        if error is not None:
            job["error"] = error
        timer = job.get("timer")
    if timer:
        timer.cancel()

def _job_timeout(job_id):
    """Timer 到期（30min）：running→timeout+kill（v2 I5）。"""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job["status"] != "running":
            return
        job["status"] = "timeout"
        job["finishedAtMs"] = time.time() * 1000
        proc = job.get("proc")
    _kill(proc)

def _run_stage(argv, job, label):
    """起一个 ffmpeg（参数列表直传·无 shell=True 防注入）→ (rc, stderr 尾 500 字)。
    stderr 落临时文件（防 PIPE 塞死）·stdout 供 -progress 解析。"""
    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=errf, stdin=subprocess.DEVNULL)
        with _jobs_lock:
            if job["status"] != "running":       # cancel/timeout 先至·立即杀
                _kill(proc)
                proc.wait()
                return 0, ""
            job["proc"] = proc
        t = threading.Thread(target=_pump_progress, args=(proc, job, label), daemon=True)
        t.start()
        rc = proc.wait()
        t.join(timeout=5)
        errf.seek(0)
        return rc, errf.read()[-500:].decode("utf-8", "replace")

def _export_worker(job, spec, stages, workdir):
    """job 线程体：顺序跑 stages（段→concat→mix）·退出码映射（v3 I-2：0→success·非0→failed[stderr 尾 500 字]）·
    finally 清临时目录（裁决 2）。"""
    labels = _stage_labels(spec)   # 段 → 交界（xfade/concat）→（有 BGM 时）mix
    try:
        os.makedirs(os.path.dirname(job["outPath"]), exist_ok=True)
        for label, argv in zip(labels, stages):
            if label == "concat":
                _write_concat_list(workdir, len(spec["main"]))
            rc, err = _run_stage(argv, job, label)
            with _jobs_lock:
                alive = job["status"] == "running"
            if not alive:
                return
            if rc != 0:
                _job_finish(job, "failed", error=(err or "").strip()[-500:] or ("ffmpeg exit %d" % rc))
                return
        _job_finish(job, "success")
    except Exception as e:
        _job_finish(job, "failed", error="export_error: %s" % e)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        with _jobs_lock:
            job["proc"] = None


# ===== 批 M5 T0：引擎进程系统能力（纯函数 + 进程编排·与既有导出 job 零纠缠）=====

def _engine_port_ok(body):
    """端口白名单校验（3-18）→ (port, None) | (None, (码, 错误码))。非对象 → 400 bad_json。
    白名单=engine_addr 解析端口（地基批1 T1 #46·engine_ports 不落独立键·单源防双源漂移）。"""
    if not isinstance(body, dict):
        return None, (400, "bad_json")
    port = body.get("port")
    # bool 是 int 子类但恒不在白名单·字符串 "8190" 亦不入（勿做隐式转换·收窄攻击面）
    if isinstance(port, int) and not isinstance(port, bool) and port == _engine_cfg()["port"]:
        return port, None
    return None, (400, "bad_port")

def _engine_op_take():
    """在途单例取位（check-then-act·同锁段）→ (True, None) 抢到 | (False, since 毫秒) 在途（B-3-12）。"""
    with _engine_op_lock:
        if _engine_op["since"] is not None:
            return False, _engine_op["since"]
        _engine_op["since"] = int(time.time() * 1000)
        return True, None

def _engine_op_drop():
    """在途单例释放（**全链 finally 必调**·防闸泄漏致端点永久 409）。"""
    with _engine_op_lock:
        _engine_op["since"] = None

def _engine_alive(port):
    """/system_stats 探活（2s）：200 即活。超时/异常/非 200 → False（半死引擎亦落 False·走清理路径·§三.6）。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/system_stats" % port, timeout=ENGINE_PROBE_TIMEOUT) as resp:
            return resp.status == 200
    except Exception:
        return False

def _engine_scan_run():
    """U-批 U4：并发探测 8188-8200 引擎健康端点（复用 _engine_alive 同口径）→ {ok, port}。
    线程池 13 路并行·单路超时 ENGINE_PROBE_TIMEOUT(2s) → 墙钟≈单路超时·总预算 ≤6s。只读零写。"""
    ports = list(range(8188, 8201))
    with ThreadPoolExecutor(max_workers=len(ports)) as ex:
        alive = list(ex.map(_engine_alive, ports))
    for port, up in zip(ports, alive):
        if up:
            return {"ok": True, "port": port}
    return {"ok": False, "port": None}

def _ps_json(script, timeout=20):
    """PowerShell 取 JSON（-NoProfile 禁 profile 副作用·OutputEncoding=UTF8 防 OEM 码页乱码）→ 解析值/None。
    进程查询唯一通道（Get-CimInstance Win32_Process·WD:27 口径——勿用 wmic like：会被含该字样的 shell 命令污染）。"""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout.decode("utf-8-sig", "replace").strip() or "null")
    except ValueError:
        return None

def _ps_items(obj):
    """ConvertTo-Json 单对象/空集 → list 归一。"""
    if obj is None:
        return []
    return obj if isinstance(obj, list) else [obj]

def _ps_proc(script):
    """PowerShell 取 [{ProcessId,Name,CommandLine}] → list（过滤非 dict 项）。"""
    return [i for i in _ps_items(_ps_json(script)) if isinstance(i, dict)]

def _engine_procs(port):
    """命令行三条件匹配集 M → {pid: cmdline}（WD:27 口径）：Name -eq python.exe ∧ 含 main.py ∧ 含 --port N。
    **Name 闸必带**（A-P4/B-1.2.4）：去掉后查询串自身与同名 shell 进程会自匹配污染。"""
    items = _ps_proc("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process"
                     " | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*main.py*'"
                     " -and $_.CommandLine -like '*--port %d*' }"
                     " | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress" % port)
    return {i["ProcessId"]: str(i.get("CommandLine") or "") for i in items if isinstance(i.get("ProcessId"), int)}

def _proc_info(pid):
    """按 PID 反查 {Name,CommandLine}（杀前身份校验用·A-P7：PID 会复用·PID 文件可能过期）→ dict/None。"""
    items = _ps_proc("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process"
                     " -Filter 'ProcessId=%d' | Select-Object ProcessId,Name,CommandLine"
                     " | ConvertTo-Json -Compress" % pid)
    return items[0] if items else None

def _engine_cmdline_ok(info, port):
    """三条件判定（纯函数·stop 杀前校验复用·口径与 _engine_procs 的 PS 侧同款·大小写同 -like 语义）。"""
    if not isinstance(info, dict):
        return False
    cmd = str(info.get("CommandLine") or "").lower()
    return (str(info.get("Name") or "").lower() == "python.exe"
            and "main.py" in cmd and ("--port %d" % port) in cmd)

def _listen_pids(port):
    """netstat -ano 取 <port> LISTENING 的 PID 集 S（IPv4/IPv6 同 socket 两行同 PID·set 去重）。
    非引擎占用照实收——判定交调用方求交/相减（B-N4 定序的 S/S'）。"""
    try:
        r = subprocess.run(["netstat", "-ano"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    tag = ":%d" % port
    pids = set()
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        f = line.split()                                  # TCP <本地> <外端> LISTENING <PID>
        if len(f) >= 5 and f[0].upper() == "TCP" and f[1].endswith(tag) and f[3].upper() == "LISTENING":
            try:
                pids.add(int(f[4]))
            except ValueError:
                pass
    return pids

def _taskkill(pid, timeout=20):
    """树杀 /T /F（引擎多进程树·单杀父进程会留子进程占端口）→ True 成功 / False 失败或已消失。"""
    try:
        return subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                              capture_output=True, timeout=timeout).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

def _pid_file(port):
    """PID 文件落 .tmp/（**不落 data/**·B-3-6：data/*.json 在 PUT /gui13-data 可写白名单内=投毒面）。"""
    return os.path.join(REPO_ROOT, ".tmp", "engine-proc-%d.json" % port)

def _read_pid_file(port):
    try:
        with open(_pid_file(port), "r", encoding="utf-8") as f:
            pid = json.load(f).get("pid")
        return pid if isinstance(pid, int) and not isinstance(pid, bool) else None
    except (OSError, ValueError, AttributeError):
        return None

def _write_pid_file(port, pid):
    try:
        os.makedirs(os.path.dirname(_pid_file(port)), exist_ok=True)
        with open(_pid_file(port), "w", encoding="utf-8") as f:
            json.dump({"port": port, "pid": pid, "ts": int(time.time() * 1000)}, f)
    except OSError:
        pass

def _clear_pid_file(port):
    try:
        os.remove(_pid_file(port))
    except OSError:
        pass

def _log_tail(path, n=300):
    """日志尾 300 字（秒退失败诊断附回·GUI 据此提示用户看 .tmp/engine-devserver-*）。"""
    try:
        with open(path, "rb") as f:
            return f.read()[-n:].decode("utf-8", "replace").strip()
    except OSError:
        return ""

def _engine_clean(port):
    """僵尸清理（B-N4 定序）：M ∩ S 树杀 → sleep 2 → 重查 netstat。
    重查仍占端口且非引擎（S'−M' 非空）→ (400, port_taken_by_other 附 pid·**绝不杀**)；空 → None（可拉起）。"""
    for pid in sorted(_listen_pids(port) & set(_engine_procs(port))):
        _taskkill(pid)
    time.sleep(2)
    left = _listen_pids(port) - set(_engine_procs(port))
    if left:
        return 400, {"ok": False, "error": "port_taken_by_other", "pid": sorted(left)[0]}
    return None

def _engine_launch(port):
    """拉起引擎（WD:33 argv 口径+venv 解释器必写死·A-P5）→ (码, 信封)。
    秒退检测 3s：poll() 非 None → 500 engine_launch_failed（附 rc + stderr 日志尾）。"""
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_path = os.path.join(REPO_ROOT, ".tmp", "engine-devserver-%d-%s.log" % (port, ts))
    err_path = out_path[:-4] + ".err.log"
    try:                                                 # stdout/stderr 分两文件（B-3-22·合并会丢诊断）
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        log_f, err_f = open(out_path, "wb"), open(err_path, "wb")
    except OSError:
        return 500, {"ok": False, "error": "engine_launch_failed", "err": "log_open_failed"}
    cfg = _engine_cfg()
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(cfg["ffmpeg"]) + os.pathsep + env.get("PATH", "")   # ffmpeg/bin 前缀（引擎侧依赖）
    # venv 解释器必走 engine_dir 内（A-P5·勿走 PATH 里的别的 python）
    argv = [os.path.join(cfg["engine_dir"], ".venv", "Scripts", "python.exe"),
            "main.py", "--port", str(port), "--listen", "127.0.0.1",
            "--disable-auto-launch", "--multi"]
    root = _workspace_root_setting()   # R-59 T1：输出根自选（""=未设·argv 与现状逐字节一致）
    if root: argv += ["--output-directory", root]
    try:
        proc = subprocess.Popen(argv, cwd=cfg["engine_dir"], env=env, stdin=subprocess.DEVNULL,
                                stdout=log_f, stderr=err_f,
                                creationflags=_DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP)
    except OSError as e:
        return 500, {"ok": False, "error": "engine_launch_failed", "err": str(e)}
    finally:
        log_f.close()                                   # 父侧句柄可关：Popen 已把句柄复制给子进程
        err_f.close()
    try:
        proc.wait(timeout=3)
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        rc = None                                        # 3s 未退 = 起来了（引擎冷启动 1-2 分钟·勿等就绪）
    if rc is not None:
        return 500, {"ok": False, "error": "engine_launch_failed", "rc": rc, "err": _log_tail(err_path)}
    _write_pid_file(port, proc.pid)
    return 200, {"ok": True, "pid": proc.pid}

def _engine_start_run(port):
    """engine_start 主体（调用方 finally 释放在途单例）→ (码, 信封)。"""
    if _engine_alive(port):
        return 200, {"ok": True, "already": True}       # A-S1：GUI 统一进启动轮询·不重拉即消竞态
    blocked = _engine_clean(port)
    if blocked is not None:
        return blocked
    return _engine_launch(port)

def _engine_stop_run(port):
    """engine_stop 主体（调用方 finally 释放在途单例）→ (码, 信封)。
    PID 来源 = 命令行三条件匹配集 ∪ PID 文件（**匹配集优先**·B-N3：start-all.bat 起的引擎无 PID 文件·
    日常主场景）；杀前逐个按 PID 反查校验三条件——存活但不匹配 → 400 pid_mismatch **绝不盲杀**（A-P7）。
    进程已不存在（非 PID 复用·引擎自己死了）→ 跳过该个（无从校验亦无可杀·不回 pid_mismatch 误报）。"""
    targets = sorted(_engine_procs(port))                # 匹配集优先
    file_pid = _read_pid_file(port)
    if file_pid is not None and file_pid not in targets:
        targets.append(file_pid)
    killed = []
    for pid in targets:
        info = _proc_info(pid)
        if info is None:
            continue
        if not _engine_cmdline_ok(info, port):
            return 400, {"ok": False, "error": "pid_mismatch", "pid": pid}
        if _taskkill(pid):
            killed.append(pid)
    _clear_pid_file(port)
    return (200, {"ok": True}) if killed else (200, {"ok": True, "noop": True})


# ===== 地基批1 T7 #52：首启体检取数（引擎侧零改·配置一律现读 _engine_cfg）=====

DISK_MIN_GB = 10                                     # 磁盘剩余下限 GB（阈值固定不做可配·方案 ●审 E-2）
REQUIRED_CUSTOM_NODES = ["ComfyUI-H3-BatchRenderer", "ComfyUI-H3ShotForge"]  # 引擎节点候选名（唯一强依赖起步·版本比对不做）·双名兼容：本机 N: 旧名符号链接与接收方新名都要能过健检（任一在位即过）

def _engine_stats():
    """引擎 /system_stats 探活取 JSON（超时=现成 ENGINE_PROBE_TIMEOUT 2s·形态同 _engine_alive）→ dict|None（不可达/非 JSON → None）。"""
    try:
        with urllib.request.urlopen(_engine_cfg()["addr"] + "/system_stats", timeout=ENGINE_PROBE_TIMEOUT) as resp:
            if resp.status != 200:
                return None
            doc = json.loads(resp.read().decode("utf-8", "replace"))
            return doc if isinstance(doc, dict) else None
    except Exception:
        return None

def _stats_fields(doc):
    """system_stats → {version, vram_total_mb}（字段取不到 → None·不判失败）。
    version=system.comfyui_version（回退 system.version / 顶层 version）；
    vram_total_mb=Σ devices[].vram_total 字节→MB 取整（回退顶层 vram_total_mb·已是 MB）。"""
    system = doc.get("system") if isinstance(doc.get("system"), dict) else {}
    version = system.get("comfyui_version") or system.get("version") or doc.get("version")
    total = 0
    for d in (doc.get("devices") if isinstance(doc.get("devices"), list) else []):
        v = d.get("vram_total") if isinstance(d, dict) else None
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            total += v
    vram = round(total / (1024 * 1024)) if total else doc.get("vram_total_mb")
    return {"version": version, "vram_total_mb": vram}

def _vram_gb(doc):
    """system_stats → {free_gb, total_gb}（Σ devices[].vram_free/vram_total 字节→GB·取不到 → None）。"""
    devices = doc.get("devices") if isinstance(doc, dict) and isinstance(doc.get("devices"), list) else []
    def _sum(key):
        vals = [d.get(key) for d in devices if isinstance(d, dict)]
        vals = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
        return round(sum(vals) / (1024 ** 3), 2) if vals else None
    return {"free_gb": _sum("vram_free"), "total_gb": _sum("vram_total")}

def _engine_queue():
    """引擎 GET /queue 忙闲（经 _engine_cfg addr·超时同 ENGINE_PROBE_TIMEOUT）→ {running,pending}|None（不可达/非 JSON → None）。"""
    try:
        with urllib.request.urlopen(_engine_cfg()["addr"] + "/queue", timeout=ENGINE_PROBE_TIMEOUT) as resp:
            if resp.status != 200:
                return None
            doc = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(doc, dict):
        return None
    def _n(key):
        v = doc.get(key)
        return len(v) if isinstance(v, list) else 0
    return {"running": _n("queue_running"), "pending": _n("queue_pending")}

def _engine_free_vram():
    """引擎 POST /free（unload_models+free_memory·超时 ENGINE_FREE_TIMEOUT）→ bool（2xx 即成功）。"""
    body = json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8")
    req = urllib.request.Request(_engine_cfg()["addr"] + "/free", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=ENGINE_FREE_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False

def _port_listening(host, port, timeout=1.0):
    """本地 socket 试连（引擎端口预检·1s 超时）→ bool（连不上不算错·只报红）。"""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False

def _disk_free_gb(path):
    """路径所在盘剩余空间 GB（盘不存在/取不到 → None·调用方判红）。"""
    try:
        root = os.path.splitdrive(os.path.abspath(str(path)))[0] + os.sep
        return round(shutil.disk_usage(root).free / (1024 ** 3), 2)
    except OSError:
        return None

def _disk_ok(*free_gbs):
    """磁盘剩余判定（纯函数·阈值锁）：任一 < DISK_MIN_GB 或取不到 → False。"""
    return all(f is not None and f >= DISK_MIN_GB for f in free_gbs)

def _custom_nodes_state(engine_dir):
    """custom_nodes 一级子目录名 → (installed, missing)：直读目录（引擎仓零改·版本比对不做）。
    双名兼容：REQUIRED 任一候选在位即不缺（全缺才回全部候选名）。"""
    d = os.path.join(engine_dir, "custom_nodes")
    try:
        installed = sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))
    except OSError:
        installed = []
    if any(n in installed for n in REQUIRED_CUSTOM_NODES):
        return installed, []
    return installed, list(REQUIRED_CUSTOM_NODES)

def _health_items():
    """首启体检七项（顺序固定·GUI 侧按序渲染）→ [{id, ok, detail}]。配置一律现读 _engine_cfg()（每请求现读勿缓存·循 T1 #46 口径）。"""
    cfg = _engine_cfg()
    items = []
    stats = _engine_stats()
    items.append({"id": "engine", "ok": stats is not None,
                  "detail": _stats_fields(stats) if stats is not None else {"error": "engine_unreachable"}})
    items.append({"id": "data_service", "ok": True, "detail": "self"})   # 本端点可达即数据服务活着
    ff = {"ffmpeg": os.path.exists(cfg["ffmpeg"]), "ffprobe": os.path.exists(cfg["ffprobe"])}
    ff["missing"] = [k for k in ("ffmpeg", "ffprobe") if not ff[k]]
    items.append({"id": "ffmpeg", "ok": not ff["missing"], "detail": ff})
    ed = {"engine_dir_exists": os.path.isdir(cfg["engine_dir"]),
          "venv_python": os.path.exists(os.path.join(cfg["engine_dir"], ".venv", "Scripts", "python.exe"))}
    items.append({"id": "engine_dir", "ok": ed["engine_dir_exists"] and ed["venv_python"], "detail": ed})
    listening = _port_listening(urlsplit(cfg["addr"]).hostname, cfg["port"])
    items.append({"id": "engine_port", "ok": listening, "detail": {"listening": listening}})
    free_ws = _disk_free_gb(_workspace_root_setting() or DATA_DIR)
    free_eng = _disk_free_gb(cfg["engine_dir"])
    items.append({"id": "disk", "ok": _disk_ok(free_ws, free_eng),
                  "detail": {"workspace_free_gb": free_ws, "engine_free_gb": free_eng}})
    installed, missing = _custom_nodes_state(cfg["engine_dir"])
    items.append({"id": "custom_nodes", "ok": not missing, "detail": {"installed": installed, "missing": missing}})
    return items




if __name__ == "__main__":
    _prune_thumb_cache()   # 批 C #13：缩略缓存启动清理（LRU by mtime·2000 件/200MB·不加后台线程）
    print(f"devserver on http://127.0.0.1:{PORT} root={ROOT} engine={_engine_cfg()['addr']}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
