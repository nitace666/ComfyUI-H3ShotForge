"""V1.12 批 L (LLM 智能分镜) 波次 1 批次 C — T5B 权限读档.

对齐 #50 行为 3 (权限档承载 / 读文档进 system) 契约:
  - 读取根锚点: os.path.dirname(os.path.realpath(__file__)) 上溯两级
    → workflow/节点方案/  (仿 __init__.py:1058-1062 软链先例,
    不用 cwd 相对路径 — pytest cwd 与真机 Junction 部署 cwd 不同).
  - 白名单 (按 permission_tier):
      普通 (默认): 单篇固定绝对路径 .md (H3提示词规则与技巧.md;
        2026-10-26 裁决起仅此一篇, 版本定位与路线图.md 与引擎仓
        README.md 已移除, 历史见 git)
      高级: 普通 + <节点方案>/** 下所有 .md
      完全: 高级 + folder_paths.get_input_directory() 下 *.md/*.txt
  - 黑名单 (三档均强制, 根内也禁):
      llm_presets.json*, h3_config.json, .git/**, .ssh/**, node_modules/**
      文件名含 secret / token / apikey / api_key / credential / .env
      *.pem / *.key / *.p12 / *.pfx / *.jks / id_rsa* / id_ed25519*
      credentials* / .netrc / .npmrc / .pypirc
  - 文件不存在 → 静默跳过; 二进制 → 静默跳过 (按后缀白名单隐式过滤).
  - 返回 system 字符串 (带文件名溯源标注).

调用方 (T5 chat handler):
  - 异步路径: await build_system_prompt_async(permission_tier, snapshot)
    → asyncio.to_thread 包装, 读盘移出事件循环 (1.14 整改批 D · D3)
  - 同步路径: build_system_prompt(permission_tier, snapshot)
    → 仅供测试 / 一次性脚本使用; 真机 handler 走异步入口.
返回最终 system 字符串 (档位文档 + 本会话 snapshot 的 globals/分镜提示词).

字符预算截停 (1.14 整改批 D · D3):
  - 单文件读盘硬上限 = _FILE_READ_BUDGET (默认 524288 字符 — 注: 文本模式
    按字符计数, ASCII 等价于字节, CJK 等多字节字符下预算比 512 KiB 更大).
  - 超预算 → 按字符边界截停 + 追加 "[...truncated at N bytes...]" 标注
    (标注保留原字串以保回归稳定, 数字 N 即预算字符数), 防止超大文件
    (日志 / 备份 / 误命名) 长时间阻塞读盘.
  - 预算可经 _read_text_file(..., max_bytes=...) 显式注入.
"""
import asyncio
import json
import os
import re


# 模块级开关: 锚点路径可被测试 monkeypatch.
_PERMISSION_ROOT_OVERRIDE = None  # 测试用: 非 None 时优先
_INPUT_DIR_OVERRIDE = None       # 测试用: 完全档 input 目录注入
_DOC_WHITELIST_OVERRIDE = None  # 测试用: 非 None 时优先 (闲时批 D 白名单注入)


# ---------- 锚点解析 ----------

def _project_root():
    """读取根锚点: __file__ 上溯两级 → workflow/节点方案/.

    真机: __file__ 走软链 → realpath 解开 → 节点方案/ComfyUI-H3-BatchRenderer/llm_permissions.py
    → dirname 两次 = 节点方案/. 测试注入 _PERMISSION_ROOT_OVERRIDE 优先.
    """
    if _PERMISSION_ROOT_OVERRIDE:
        return os.path.abspath(_PERMISSION_ROOT_OVERRIDE)
    return os.path.normpath(os.path.join(
        os.path.dirname(os.path.realpath(__file__)), "..", ".."))


def _input_dir():
    """完全档白名单根: folder_paths.get_input_directory(). 注入 _INPUT_DIR_OVERRIDE 优先."""
    if _INPUT_DIR_OVERRIDE:
        return os.path.abspath(_INPUT_DIR_OVERRIDE)
    try:
        import folder_paths
        return os.path.abspath(folder_paths.get_input_directory())
    except Exception:
        return ""


# ---------- 黑名单 (filename 模式匹配) ----------

# 黑名单名: 文件名基名命中任一即禁 (大小写不限). 编译为正则.
# 子串匹配 (re.search) — 契约: "文件名含 secret/token/credential/.env..."
# .pem/.key/.p12 等带后缀锚定; id_rsa/id_ed25519 前缀锚定 (允许 .pub 后缀).
_BLACKLIST_NAME_PATTERNS = [
    r"^llm_presets\.json",    # 引擎预设 (含 .tmp.* 变体) — 任意路径一律禁
    r"^h3_config\.json",      # 引擎配置 (含 .tmp.* 变体) — 任意路径一律禁
    r"secret",                # 子串含 secret
    r"token",                 # 子串含 token
    r"apikey",                # 子串含 apikey (无下划线/连字符的写法)
    r"api_key",               # 子串含 api_key (下划线写法)
    r"credential",            # 子串含 credential
    r"\.env",                 # .env (子串)
    r"\.pem$",                # 后缀 .pem
    r"\.key$",                # 后缀 .key
    r"\.p12$",                # 后缀 .p12
    r"\.pfx$",                # 后缀 .pfx
    r"\.jks$",                # 后缀 .jks
    r"^id_rsa",               # 前缀 id_rsa (id_rsa, id_rsa.pub)
    r"^id_ed25519",           # 前缀 id_ed25519
    r"^credentials",          # 前缀 credentials (credentials.json)
    r"\.netrc$",              # 后缀 .netrc
    r"\.npmrc$",              # 后缀 .npmrc
    r"\.pypirc$",             # 后缀 .pypirc
]

_BLACKLIST_NAME_RES = [re.compile(p, re.I) for p in _BLACKLIST_NAME_PATTERNS]


def _is_blacklisted_name(name):
    """基名命中任一黑名单正则即 True (子串匹配, 大小写不限)."""
    base = os.path.basename(name)
    if not base:
        return False
    for r in _BLACKLIST_NAME_RES:
        if r.search(base):
            return True
    return False


# 黑名单路径段: 路径任意段含以下目录名即禁.
# 闲时批A扩段(2026-09-22 老板裁修): 高级档递归读 <节点方案>/** .md, 项目树积累到
# 1.7万文件/97MB 后冷盘单调用 12s+ 且随积累线性恶化; 大头为各版本仓 .tmp 测试日志等
# 技术性临时目录 — 扩黑名单后 13.3MB(降86%), 语义无损(临时文件纪律本就排除正式内容).
_BLACKLIST_DIR_SEGMENTS = {".git", ".ssh", "node_modules", ".tmp", "__pycache__",
                           ".pytest_cache", ".venv", "venv"}


def _explicit_blacklist_files():
    """黑名单显式文件路径集合 (绝对路径). 锚当前模块真实所在引擎仓目录.

    用 __file__ realpath 而非 _project_root() 上溯 —— Junction 指到任意树时,
    命中的是当前实际加载的引擎仓 (而非写死的 1.11 树).
    """
    engine_dir = os.path.dirname(os.path.realpath(__file__))
    return {
        os.path.join(engine_dir, "llm_presets.json"),
        os.path.join(engine_dir, "h3_config.json"),
    }


def _is_blacklisted_dir(path):
    """路径中含 .git / .ssh / node_modules 任一段即 True."""
    parts = path.replace("\\", "/").split("/")
    return any(seg in _BLACKLIST_DIR_SEGMENTS for seg in parts)


def _is_blacklisted_path(path, explicit_set):
    """综合判定 path 是否被黑名单禁读."""
    abs_p = os.path.normpath(os.path.abspath(path))
    # 黑名单文件名 (基名模式)
    if _is_blacklisted_name(abs_p):
        return True
    # 显式黑名单文件
    if abs_p in explicit_set:
        return True
    # 黑名单目录段
    if _is_blacklisted_dir(abs_p):
        return True
    return False


# ---------- 普通档白名单 (单篇固定) ----------

def _tier_normal_files():
    """普通档白名单 (单篇): 默认 H3提示词规则与技巧.md; h3_config.json 顶层键
    llm_chat_doc 有效配置时替换为该文档 (校验前置 _resolve_chat_doc,
    任一环不过回默认篇 — V41 文档源可配置, 见方案 §2.1).
    测试注入 _PERMISSION_ROOT_OVERRIDE 时按覆盖根解析默认篇, 保住夹具假树的封闭性.
    """
    return [_resolve_chat_doc()[0]]


# ---------- #41 文档源可配置 (V41): llm_chat_doc 解析 ----------

_CHAT_DOC_OVERRIDE = None  # 测试用: 非 None 时优先 (V41 文档源注入, 照 _DOC_WHITELIST_OVERRIDE 先例)
_H3_CONFIG_FILE = None     # 测试用: h3_config.json 路径注入 (端点读写同源; None → realpath 仓根)


def _h3_config_path():
    """h3_config.json 定位: 注入 _H3_CONFIG_FILE 优先 (端点 POST 写/GET 读同源),
    否则引擎仓根 realpath 定位 (同 _load_doc_whitelist 先例)."""
    if _H3_CONFIG_FILE:
        return os.path.abspath(_H3_CONFIG_FILE)
    return os.path.join(
        os.path.dirname(os.path.realpath(__file__)), "h3_config.json")


def _load_chat_doc():
    """读 h3_config.json 顶层键 llm_chat_doc (实时读盘免重启, 照 llm_doc_whitelist 先例).

    返回非空字符串 (配置值, 已 strip) 或 None (缺键/空串/坏配置/读失败).
    沙箱隔离 (照 _load_doc_whitelist 机制): _PERMISSION_ROOT_OVERRIDE (假树) 在场时
    只认 _CHAT_DOC_OVERRIDE 不读真配置 — 既有假树用例语义不受真仓配置影响.
    """
    if _PERMISSION_ROOT_OVERRIDE is not None or _CHAT_DOC_OVERRIDE is not None:
        v = _CHAT_DOC_OVERRIDE
        if not isinstance(v, str) or not v.strip():
            return None
        return v.strip()
    try:
        with open(_h3_config_path(), encoding="utf-8") as f:
            v = (json.load(f) or {}).get("llm_chat_doc")
    except (OSError, ValueError):
        return None
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def _resolve_chat_doc():
    """单一解析 (校验前置, GET 端点与档位装配共用): 返回 (effective_path, ok, exists).

    path 非空 → 相对值先按 <节点方案>根 展开 (方案 §2.1.1, 照 _expand_whitelist
    isabs/join 先例) → 后缀 .md/.txt → 不撞黑名单 (文件名正则+目录段+显式集)
    → 文件存在 → (该路径, True, True);
    任一环不过 → (默认篇路径, False, 用户文件是否存在);
    path 空/缺键 → (默认篇路径, True, True).
    禁止依赖装配层 (_build_doc_text) 静默跳过实现回退 — 失效时普通档保持默认篇非空.
    """
    root = _project_root()
    default = os.path.join(root, "H3提示词规则与技巧.md")
    path = _load_chat_doc()
    if not path:
        return (default, True, True)
    if not os.path.isabs(path):
        path = os.path.normpath(os.path.join(root, path))
    if not path.lower().endswith(_TEXT_SUFFIXES):
        return (default, False, os.path.isfile(path))
    if _is_blacklisted_path(path, _explicit_blacklist_files()):
        return (default, False, os.path.isfile(path))
    if not os.path.isfile(path):
        return (default, False, False)
    return (path, True, True)


# ---------- 高档: 普通 + <节点方案>/** 下所有 .md ----------

def _load_doc_whitelist():
    """高档文档白名单 (闲时批 D · 老板裁"白名单吧" 2026-09-22).

    h3_config.json 顶层键 llm_doc_whitelist: 非空字符串数组 → 高档改为
    普通档 1 篇 + 清单内文件/目录 (目录递归 .md, 受黑名单段约束).
    缺键/空数组/坏配置/读失败 → None (维持递归现状, 开关式零迁移).
    路径语义: 相对 <节点方案>/ 项目根 或 绝对路径.
    """
    # 测试沙箱隔离: _PERMISSION_ROOT_OVERRIDE (假树) 在场时白名单只认
    # _DOC_WHITELIST_OVERRIDE, 不读真配置 — 既有假树用例语义不受真仓
    # h3_config.json 白名单开关影响 (真配置只在真 root/生产下生效).
    if _PERMISSION_ROOT_OVERRIDE is not None or _DOC_WHITELIST_OVERRIDE is not None:
        wl = _DOC_WHITELIST_OVERRIDE
        if wl is None:
            return None
        return [x for x in wl if isinstance(x, str) and x.strip()] or None
    try:
        cfg_path = os.path.join(
            os.path.dirname(os.path.realpath(__file__)), "h3_config.json")
        with open(cfg_path, encoding="utf-8") as f:
            wl = (json.load(f) or {}).get("llm_doc_whitelist")
    except (OSError, ValueError):
        return None
    if isinstance(wl, list) and wl and all(
            isinstance(x, str) and x.strip() for x in wl):
        return [x.strip() for x in wl]
    return None


def _expand_whitelist(root):
    """白名单条目 → 文件路径列表 (文件直取; 目录递归 .md 受黑名单段约束)."""
    out = []
    for entry in _load_doc_whitelist():
        p = entry if os.path.isabs(entry) else os.path.join(root, entry)
        if os.path.isdir(p):
            for dirpath, dirnames, filenames in os.walk(p):
                dirnames[:] = [d for d in dirnames
                               if d not in _BLACKLIST_DIR_SEGMENTS]
                for fn in filenames:
                    if fn.lower().endswith(".md"):
                        out.append(os.path.join(dirpath, fn))
        else:
            out.append(p)
    return out


def _tier_high_files():
    """高档白名单 = 普通档全部 + <节点方案>/** 下 .md (递归).

    llm_doc_whitelist 在场 (闲时批 D) → 普通档 1 篇 + 清单内 (收窄)."""
    out = list(_tier_normal_files())
    root = _project_root()
    if _load_doc_whitelist() is not None:
        out.extend(_expand_whitelist(root))
        return out
    if os.path.isdir(root):
        for dirpath, dirnames, filenames in os.walk(root):
            # 跳过黑名单目录: 防深入到 .git/.ssh/node_modules 浪费 + 兼容黑名单
            dirnames[:] = [d for d in dirnames if d not in _BLACKLIST_DIR_SEGMENTS]
            for fn in filenames:
                if fn.lower().endswith(".md"):
                    out.append(os.path.join(dirpath, fn))
    return out


# ---------- 完全档: 高档 + input 资产区 *.md/*.txt ----------

def _tier_full_files():
    out = list(_tier_high_files())
    inp = _input_dir()
    if inp and os.path.isdir(inp):
        for dirpath, dirnames, filenames in os.walk(inp):
            # input 资产区也禁黑名单目录
            dirnames[:] = [d for d in dirnames if d not in _BLACKLIST_DIR_SEGMENTS]
            for fn in filenames:
                low = fn.lower()
                if low.endswith(".md") or low.endswith(".txt"):
                    out.append(os.path.join(dirpath, fn))
    return out


_TIER_FILES = {
    "普通": _tier_normal_files,
    "高级": _tier_high_files,
    "完全": _tier_full_files,
}


# ---------- 读文件 + 拼 system ----------

_TEXT_SUFFIXES = (".md", ".txt")

# 单文件读盘硬上限 (字符). 超此预算按预算截停 + 追加标注, 不无限读.
# 524288 字符: 容纳正常 README / 文档; 截停日志/备份/误命名等超大文件, 避免
# 高档装配期间阻塞事件循环 (WS1-T5b1-必改2). 注: 文本模式按字符计数
# (ASCII ≈ 字节, CJK 多字节字符下预算对应字节数更大).
_FILE_READ_BUDGET = 524288

# 文档装配总字符预算 (闲时批A·老板裁修 2026-09-22): _build_doc_text 全部拼接的
# 总量上限, 防项目文档再积累后膨胀 (与单文件预算同款截停机制). 4194304 字符
# = 单文件预算 8 倍, 黑名单扩段后常规体量在其内; 超限截停并标注.
_TOTAL_DOC_BUDGET = 4194304


# ---------- 场景角色段 (1.14 追加批 · T1) ----------
# 视频分镜创作助手口径: 内置 system 顶端加一段角色定义, 明确"研发文档仅作
# 知识参考, 回答面向创作者而非研发". 拼接位置: build_system_prompt sections
# 最前面 (在档位文档与 snapshot 段之前).
_SCENE_ROLE_PROMPT = (
    "你是视频分镜创作助手, 服务于短视频分镜/提示词工作流. "
    "以下文档仅作知识参考, 回答面向创作者而非研发."
)


# ---------- LLM 响应剥离 (1.14 追加批 · T2) ----------
# 老板实测: 部分模型回复会夹带 mm:think 推理块 / tool_call 片段, 这些是
# 模型内部实现细节, 不应泄漏到正常回复与会话存档. 响应层在写入 reply_text
# 前过本函数. 形态覆盖 (mm:think 兼顾尖括号标签与裸标记两形态; tool_call
# 仅识别明确标签形态以免误伤 fenced JSON 代码块 — 分镜 JSON 在 ``` 块里是
# 合法产物, 裸 JSON 段落无法安全区分则不剥离).
_STRIP_LLM_ARTIFACTS_RE_CLOSED_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_STRIP_LLM_ARTIFACTS_RE_UNCLOSED_THINK = re.compile(r"<think>.*", re.DOTALL)
_STRIP_LLM_ARTIFACTS_RE_MM_THINK = re.compile(r"(?ms)^mm:think:.*?(?=\n\n|\Z)")
_STRIP_LLM_ARTIFACTS_RE_TOOL_CALL = re.compile(r"<tool_call>.*?</tool_call>", re.DOTALL)
_STRIP_LLM_ARTIFACTS_RE_TOOL_CALLS = re.compile(r"<tool_calls>.*?</tool_calls>", re.DOTALL)


def _strip_llm_artifacts(text):
    """剥离 LLM 响应中的 mm:think 思考块 / tool_call 片段.

    返回剥离后的字符串 (外围 strip). 非字符串输入 → 原样返回.
    """
    if not isinstance(text, str) or not text:
        return text if isinstance(text, str) else ""
    s = text
    s = _STRIP_LLM_ARTIFACTS_RE_CLOSED_THINK.sub("", s)
    s = _STRIP_LLM_ARTIFACTS_RE_UNCLOSED_THINK.sub("", s)
    s = _STRIP_LLM_ARTIFACTS_RE_MM_THINK.sub("", s)
    s = _STRIP_LLM_ARTIFACTS_RE_TOOL_CALL.sub("", s)
    s = _STRIP_LLM_ARTIFACTS_RE_TOOL_CALLS.sub("", s)
    return s.strip()


def _read_text_file(path, max_bytes=None):
    """读文本 — 失败/非文本后缀/二进制 → 返回 None (静默跳过).

    字符预算截停 (1.14 整改批 D · D3): max_bytes=None 走 _FILE_READ_BUDGET 默认值;
    显式传 0 / 正数用于测试与小预算场景. 超预算按字符边界截停, 追加截断标注,
    防止超大文件长时间阻塞读盘. 注: 文本模式 f.read(n) 按字符读取, 参数名沿用
    max_bytes 仅作历史 API 兼容, 实际单位为字符数.
    """
    low = path.lower()
    if not low.endswith(_TEXT_SUFFIXES):
        return None
    budget = _FILE_READ_BUDGET if max_bytes is None else max_bytes
    try:
        with open(path, encoding="utf-8", errors="strict") as f:
            if budget <= 0:
                data = ""
            else:
                data = f.read(budget + 1)  # 多读 1 字符判是否截断
        if budget > 0 and len(data) > budget:
            data = data[:budget] + "\n[...truncated at %d bytes...]" % budget
        return data
    except (OSError, UnicodeDecodeError):
        return None


def _build_doc_text(tier):
    """按档位列出所有允许读的文件 → 黑名单过滤 → 文本读取 → 拼接 system."""
    files_fn = _TIER_FILES.get(tier)
    if files_fn is None:
        return ""
    files = files_fn()
    explicit = _explicit_blacklist_files()
    parts = []
    seen = set()
    total = 0
    budget_hit = False
    for p in files:
        norm = os.path.normpath(os.path.abspath(p))
        if norm in seen:
            continue
        seen.add(norm)
        if _is_blacklisted_path(norm, explicit):
            continue
        if not os.path.isfile(norm):
            continue
        content = _read_text_file(norm)
        if content is None:
            continue
        if total + len(content) > _TOTAL_DOC_BUDGET:
            remaining = _TOTAL_DOC_BUDGET - total
            if remaining > 0:
                content = content[:remaining] + "\n[...truncated at total doc budget...]"
                # 文件名标注便于溯源 (不暴露完整绝对路径)
                parts.append("[文件: %s]\n%s" % (os.path.basename(norm), content))
            budget_hit = True
            break
        total += len(content)
        # 文件名标注便于溯源 (不暴露完整绝对路径)
        parts.append("[文件: %s]\n%s" % (os.path.basename(norm), content))
    if budget_hit:
        parts.append("[...文档总量超预算, 已截停 (预算 %d 字符)...]" % _TOTAL_DOC_BUDGET)
    return "\n\n".join(parts)


# ---------- 入口: build_system_prompt ----------

def _snapshot_to_prompt(snapshot):
    """snapshot 非空 → 提取 globals["提示词"] + shots[*].prompt 拼一段. None/空 → 空串."""
    if not isinstance(snapshot, dict):
        return ""
    parts = []
    gl = snapshot.get("globals") or {}
    if isinstance(gl, dict):
        gp = gl.get("提示词")
        if isinstance(gp, str) and gp.strip():
            parts.append("[全局提示词]\n%s" % gp.strip())
    shots = snapshot.get("shots") or []
    if isinstance(shots, list) and shots:
        shot_lines = []
        for sh in shots:
            if not isinstance(sh, dict):
                continue
            sid = sh.get("ID") or ""
            sp = sh.get("prompt") or ""
            if isinstance(sp, str) and sp.strip():
                head = ("[%s] " % sid) if sid else ""
                shot_lines.append(head + sp.strip())
        if shot_lines:
            parts.append("[分镜提示词]\n" + "\n".join(shot_lines))
    return "\n\n".join(parts)


def build_system_prompt(permission_tier, snapshot):
    """主入口: 档位文档 + 本会话 snapshot 提示词 → 拼成 system 字符串.

    permission_tier: "普通"/"高级"/"完全" — 其它值视为 "普通" (兜底, 调方应已校验).
    snapshot: 会话 snapshot 字段 (dict 或 None). None/空 → 不拼快照段.
    """
    tier = permission_tier if permission_tier in _TIER_FILES else "普通"
    doc_text = _build_doc_text(tier)
    snap_text = _snapshot_to_prompt(snapshot)
    sections = [_SCENE_ROLE_PROMPT]
    if doc_text:
        sections.append(doc_text)
    if snap_text:
        sections.append(snap_text)
    return "\n\n".join(sections)


async def build_system_prompt_async(permission_tier, snapshot):
    """异步入口 (1.14 整改批 D · D3): asyncio.to_thread 包装 build_system_prompt.

    真机 handler 必须走本入口 — 高级/完全档的 os.walk + 多文件 read 在
    同步调用下会阻塞 ComfyUI 主事件循环, 期间 /h3_batch/status 等端点
    卡住/超时 (WS1-T5b1-必改2). 字节预算截停见 _read_text_file.
    """
    return await asyncio.to_thread(build_system_prompt, permission_tier, snapshot)


def is_blacklisted(path):
    """公开给测试 / 调试用: 路径是否被黑名单拒读."""
    explicit = _explicit_blacklist_files()
    return _is_blacklisted_path(path, explicit)