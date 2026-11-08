"""V1.12 批 L (LLM 智能分镜) 波次 1 批次 B — T4 会话层 (文件读写 + 会话级锁).

对齐 #50 行为 1 + #51 端点契约:
  - 会话文件: <input_dir>/h3_llm_sessions/<session_id>.json (28hex)
  - 结构: {id, messages:[{role, content, ts}], snapshot|None,
           metadata: {permission_tier, model, created_at, updated_at,
                      manual_edits: {global: bool, shots: {}},
                      _snapshot_writes: [{target, after, ts}]}}
  - session_id 生成: uuid4().hex[:28] (28 位小写 hex, 匹配 SESSION_ID_RE)
  - 原子写专用 (不注 _schema 键, 区别 _manifest_write)
  - 会话级锁 (key=session_id): #50 追加 / #52 写 snapshot 同锁; LLM 调用在锁外,
    锁内全同步 (handler 在锁外调 LLM, 锁内只 read→mutate→atomic write).

模块内同步函数, 由 __init__.py 在 async handler 内调. 测试通过 _LLM_SESSIONS_DIR_OVERRIDE
注入 tmp_path, 生产路径走 folder_paths.get_input_directory().
"""
import json
import os
import re
import threading
import time
import uuid


SESSION_ID_RE = re.compile(r"^[0-9a-f]{28}$")

_SESSIONS_SUBDIR = "h3_llm_sessions"

# 测试注入: 非空时 _get_sessions_dir() 优先返回此值. 生产环境保持 None, 走 folder_paths.
_LLM_SESSIONS_DIR_OVERRIDE = None

# 模块级 session_id → threading.Lock 字典. 进程内常驻, 不在测试间自动清理 (锁对象无害).
_SESSION_LOCKS = {}
_SESSION_LOCKS_GUARD = threading.Lock()


def _get_sessions_dir():
    """返回会话目录绝对路径. 测试 _LLM_SESSIONS_DIR_OVERRIDE 优先; 否则按 folder_paths 走."""
    if _LLM_SESSIONS_DIR_OVERRIDE:
        return os.path.abspath(_LLM_SESSIONS_DIR_OVERRIDE)
    try:
        import folder_paths
        base = folder_paths.get_input_directory()
    except Exception:
        base = ""
    if not base:
        # 兜底: cwd 下的 h3_llm_sessions (不至于丢失会话; 生产不会到这)
        base = os.getcwd()
    return os.path.abspath(os.path.join(base, _SESSIONS_SUBDIR))


def _session_path(session_id):
    """会话文件绝对路径. 假定 session_id 已通过 SESSION_ID_RE 校验."""
    return os.path.join(_get_sessions_dir(), session_id + ".json")


def _get_lock(session_id):
    """会话级写锁: 同 session_id 返同 lock, 不同返不同."""
    with _SESSION_LOCKS_GUARD:
        lk = _SESSION_LOCKS.get(session_id)
        if lk is None:
            lk = threading.Lock()
            _SESSION_LOCKS[session_id] = lk
        return lk


def _new_session_id():
    """引擎内部生成: uuid4().hex[:28] (28 位小写 hex, 不含连字符)."""
    return uuid.uuid4().hex[:28]


def _atomic_write_session(path, data):
    """原子写 — 仿 _manifest_write 模式但不注入 _schema 键.

    data 必为 dict. 失败模式: 写盘异常抛 OSError; 调方已持锁, 锁释放后磁盘未动.
    """
    abs_p = os.path.abspath(path)
    os.makedirs(os.path.dirname(abs_p) or ".", exist_ok=True)
    tmp = "%s.tmp.%d.%s" % (abs_p, os.getpid(), uuid.uuid4().hex[:8])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    replaced = False
    last_err = None
    for _ in range(100):
        try:
            os.replace(tmp, abs_p)
            replaced = True
            break
        except PermissionError as e:
            last_err = e
            time.sleep(0.005)
    if not replaced:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise last_err if last_err is not None else RuntimeError("会话原子替换失败")


def _load_session_dict(path):
    """sync 读盘 — 返回 dict 或 None (文件缺失/损坏/非 dict)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _now_ts():
    """统一时间戳 — 浮点秒 (epoch)."""
    return time.time()


def _create_session(permission_tier, model):
    """新建会话 — 落盘, 返回 (session_id, session_dict).

    metadata 字段全部就位; messages=[]; snapshot=None.
    """
    sid = _new_session_id()
    ts = _now_ts()
    sess = {
        "id": sid,
        "messages": [],
        "snapshot": None,
        "metadata": {
            "permission_tier": permission_tier,
            "model": model,
            "created_at": ts,
            "updated_at": ts,
            "manual_edits": {"global": False, "shots": {}},
            "_snapshot_writes": [],
        },
    }
    _atomic_write_session(_session_path(sid), sess)
    return sid, sess


def _read_session(session_id):
    """sync 读会话 — 返回完整 dict 或 None (不存在/坏 JSON/非 dict)."""
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    return _load_session_dict(_session_path(session_id))


def _append_message(session_id, role, content, ts=None):
    """会话级锁内 read→mutate→atomic write — messages 追加一条.

    返回更新后的 session dict; session 不存在 → None (不抛, 调方决定 404).
    """
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    path = _session_path(session_id)
    lk = _get_lock(session_id)
    with lk:
        data = _load_session_dict(path)
        if data is None:
            return None
        msg = {"role": role, "content": content, "ts": ts if ts is not None else _now_ts()}
        msgs = data.get("messages")
        if not isinstance(msgs, list):
            msgs = []
        msgs.append(msg)
        data["messages"] = msgs
        md = data.get("metadata") or {}
        md["updated_at"] = _now_ts()
        data["metadata"] = md
        _atomic_write_session(path, data)
    return data


def _delete_message(session_id, index):
    """会话级锁内 read→mutate→atomic write — 删除 messages[index] 一条.

    只动 messages; snapshot 与 metadata.manual_edits/_snapshot_writes/created_at 一律不碰
    (批4 E1: 项目设定快照保持, 删后续聊 AI 仍认知项目设定).
    返回更新后的 session dict; 会话不存在 → None; index 越界/负数 → IndexError (调方转 404).
    """
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    path = _session_path(session_id)
    lk = _get_lock(session_id)
    with lk:
        data = _load_session_dict(path)
        if data is None:
            return None
        msgs = data.get("messages")
        if not isinstance(msgs, list):
            msgs = []
        if not isinstance(index, int) or index < 0 or index >= len(msgs):
            raise IndexError("message index out of range: %r" % (index,))
        msgs.pop(index)
        data["messages"] = msgs
        md = data.get("metadata") or {}
        md["updated_at"] = _now_ts()
        data["metadata"] = md
        _atomic_write_session(path, data)
    return data


def _set_snapshot(session_id, snapshot_dict):
    """会话级锁内替换 snapshot 字段 — 供 #50 快照校验通过后写回.

    返回更新后的 session dict; 会话不存在 → None.
    """
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    path = _session_path(session_id)
    lk = _get_lock(session_id)
    with lk:
        data = _load_session_dict(path)
        if data is None:
            return None
        data["snapshot"] = snapshot_dict
        md = data.get("metadata") or {}
        md["updated_at"] = _now_ts()
        data["metadata"] = md
        _atomic_write_session(path, data)
    return data


def _record_snapshot_write(session_id, target, after):
    """会话级锁内追加 metadata._snapshot_writes (供 #51 详情展示).

    返回更新后的 session dict; 会话不存在 → None. 不动 messages (防非法角色污染 #50 上下文).
    """
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    path = _session_path(session_id)
    lk = _get_lock(session_id)
    with lk:
        data = _load_session_dict(path)
        if data is None:
            return None
        md = data.get("metadata") or {}
        writes = md.get("_snapshot_writes")
        if not isinstance(writes, list):
            writes = []
        writes.append({"target": target, "after": after, "ts": _now_ts()})
        md["_snapshot_writes"] = writes
        md["updated_at"] = _now_ts()
        data["metadata"] = md
        _atomic_write_session(path, data)
    return data


def _mark_manual_edit(session_id, target):
    """会话级锁内标记手改 — target='global' → manual_edits.global=True;
    target='shot:<id>' → manual_edits.shots[<id>]=True (供 #50 D3 合并写保护).

    返回更新后的 session dict; 会话不存在 → None.
    """
    if not SESSION_ID_RE.fullmatch(session_id or ""):
        return None
    path = _session_path(session_id)
    lk = _get_lock(session_id)
    with lk:
        data = _load_session_dict(path)
        if data is None:
            return None
        md = data.get("metadata") or {}
        me = md.get("manual_edits")
        if not isinstance(me, dict):
            me = {"global": False, "shots": {}}
        if target == "global":
            me["global"] = True
        elif isinstance(target, str) and target.startswith("shot:"):
            shot_id = target[len("shot:"):]
            shots = me.get("shots")
            if not isinstance(shots, dict):
                shots = {}
            if shot_id:
                shots[shot_id] = True
            me["shots"] = shots
        # 未识别 target: 静默忽略 (调方负责校验)
        md["manual_edits"] = me
        md["updated_at"] = _now_ts()
        data["metadata"] = md
        _atomic_write_session(path, data)
    return data


def _list_sessions():
    """返回 [{id, created_at, updated_at, messages_count}] 按 updated_at 倒序.

    坏 JSON / 非 dict 文件跳过, 不抛.
    """
    d = _get_sessions_dir()
    if not os.path.isdir(d):
        return []
    items = []
    for name in os.listdir(d):
        if not name.endswith(".json") or name.startswith("."):
            continue
        sid = name[:-len(".json")]
        if not SESSION_ID_RE.fullmatch(sid):
            continue
        path = os.path.join(d, name)
        data = _load_session_dict(path)
        if data is None:
            continue
        md = data.get("metadata") or {}
        msgs = data.get("messages")
        items.append({
            "id": sid,
            "created_at": md.get("created_at", 0),
            "updated_at": md.get("updated_at", 0),
            "messages_count": len(msgs) if isinstance(msgs, list) else 0,
        })
    items.sort(key=lambda x: x["updated_at"], reverse=True)
    return items
