"""resources_scan.py — V1.9 批 2 T2.2 资源目录扫描 + R4 筛选(减污染)。

设计要点:
- 资源目录由 ComfyUI folder_paths.get_filename_list(kind) 提供(已聚合多 base_path),
  此处不重新扫描文件系统, 仅做按 kind 的轻量包装 + 筛选标注。
- R4 筛选词 + 官方资产清单来自 h3_config.json.resource_filter_terms /
  resource_official_assets(外置免重启)。文件缺失/字段类型错 → 回落内置默认。
- 分类(category):
    "turbo"  — 文件名含 turbo 关键词 或 命中带 turbo 的官方资产
    "style"  — 命中其他筛选词(minimax/h3 等)
    None     — pass-through(纯官方直通 或 all=1 下未匹配项)
- known_h3: 命中筛选词 OR 命中官方清单。
- why_included:
    "term:<词>" — 第一个命中的筛选词(小写比对)
    "official"  — 命中官方清单(精确或前缀)
    "all"       — show_all 模式兜底, 未匹配任何词/官方
- 双模式一致性: 筛选模式 items ⊆ all 模式 items(同一快照内)。
"""
import json
import os
import sys


# 默认文件路径(节点包根目录)
_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG_PATH = os.path.join(_HERE, "h3_config.json")


# ---- 内置默认词表 (T0.4 盘点实测; 配置可覆盖) ----
# 词表小写比对(不区分大小写)
DEFAULT_FILTER_TERMS = ["h3", "minimax"]
# T2.7 修正: 不加 "turbo" 词——turbo 类资产已由官方清单覆盖,
# 词表含 turbo 会把异生态(hy3dgen 3D/z_image_turbo)误入默认列表 (T0.4 混装实测)

# 官方资产直通清单 (精确匹配或前缀匹配; 同样小写比对)
# 涵盖 T0.4 实测用户机器 H3 资产中不含 h3/minimax/turbo 词的关键项
DEFAULT_OFFICIAL_ASSETS = [
    # 模型(Ref2VA / FL2VA)
    "MiniMax_H3_Ref2VA_pruned_int8_convrot.safetensors",
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "minimax_h3_fl2va_int8_convrot.safetensors",
    "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
    # VAE
    "minimax_h3_video_vae_fp16.safetensors",
    "minimax_h3_audio_vae_fp32.safetensors",
    # Turbo 资产 (独立命名, 含 minimax 词会双重命中 — 仍归官方)
    "minimax_h3_turbo_v4_step600_ema.safetensors",
    # CLIP / 量化版
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
    "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    # Latent upscaler (不带 h3/minimax/turbo 词 → 靠官方清单直通)
    "minimax_h3_latent_upscaler_3d_fp16.safetensors",
]


# kind → folder_paths 内置 key (ComfyUI 已聚合多 base_path)
KIND_TO_FOLDER = {
    "lora": "loras",
    "model": "diffusion_models",
    "clip": "clip",
    "vae": "vae",
}


def load_resource_config(path=None):
    """每次实时读取 h3_config.json, 返回 (filter_terms, official_assets)。

    - 文件缺失 → (默认词表, 默认清单)
    - 非对象/损坏 JSON → (默认词表, 默认清单)
    - resource_filter_terms 类型错(非数组) → 回落默认; 官方清单若合法则保留
    - resource_official_assets 类型错 → 回落默认; 词表若合法则保留
    - 两字段独立回落: 单字段损坏不影响另一字段(防御性, 便于本地调参)
    """
    p = path or DEFAULT_CONFIG_PATH
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return list(DEFAULT_FILTER_TERMS), list(DEFAULT_OFFICIAL_ASSETS)
    if not isinstance(data, dict):
        return list(DEFAULT_FILTER_TERMS), list(DEFAULT_OFFICIAL_ASSETS)

    raw_terms = data.get("resource_filter_terms", None)
    raw_official = data.get("resource_official_assets", None)

    terms = list(DEFAULT_FILTER_TERMS) if not isinstance(raw_terms, list) else [str(t) for t in raw_terms]
    official = list(DEFAULT_OFFICIAL_ASSETS) if not isinstance(raw_official, list) else [str(o) for o in raw_official]

    return terms, official


def _term_match(name_lower, filter_terms):
    """返回第一个命中筛选词的 (词, 索引); 无命中返回 None。"""
    for t in filter_terms:
        if t and t in name_lower:
            return t
    return None


def _official_match(name, official_assets):
    """精确或前缀匹配; 文件名 str 一致比对(清单项可任意大小写, 都按原串比对)。

    返回首个匹配的官方项(或 None)。
    """
    if not name:
        return None
    for o in official_assets:
        if not o:
            continue
        # 精确
        if name == o or name.lower() == o.lower():
            return o
        # 前缀(官方项末尾无 /, 文件名以官方项为前缀)
        if name.startswith(o) or name.lower().startswith(o.lower()):
            return o
    return None


def classify_resource(filename, filter_terms, official_assets):
    """对单个文件名做 R4 分类。

    返回 (category, known_h3, why_included):
      category ∈ {"turbo", "style", None}
      known_h3 ∈ {True, False}
      why_included ∈ {"term:<词>", "official", "all"}
    """
    if not isinstance(filename, str) or not filename:
        return None, False, "all"

    name_lower = filename.lower()

    # 优先: 词命中 (决定 category 与 why)
    term = _term_match(name_lower, [t.lower() for t in filter_terms])
    if term:
        # 词命中后文件名含 turbo → 一律 turbo (词表顺序取首词会让 minimax_h3_turbo_*
        # 先命中 "h3"/"minimax" 被误归 style, 与 discover_template_loras 的 turbo
        # 补偿规则两条路径不一致); 词不命中的文件不进此分支, 非 H3 生态不受影响
        category = "turbo" if (term == "turbo" or "turbo" in name_lower) else "style"
        return category, True, "term:%s" % term

    # 次选: 官方清单 (直通)
    off = _official_match(filename, official_assets)
    if off:
        return None, True, "official"

    # 未匹配: 在 show_all 模式才会出现, 标 known_h3=False / why=all
    return None, False, "all"


def scan_kind(kind, folder_paths_mod, *, show_all=False, config_path=None):
    """端点 handler 调用入口。

    参数:
      kind: "lora"/"model"/"clip"/"vae" — 决定调哪个 folder_paths key
      folder_paths_mod: 模块对象(注入式, 测试可桩; 真实环境用 folder_paths)
      show_all: True → 跳过 R4 过滤, 全量返回 (category/known_h3 仍按规则标注)
      config_path: 测试可注入; 缺省用 DEFAULT_CONFIG_PATH

    返回: dict {items, filter_terms} — 端点直接序列化。
    异常: ValueError (kind 非法) 由 handler 转 400。
    """
    if kind not in KIND_TO_FOLDER:
        raise ValueError("kind 必须是 lora/model/clip/vae, 收到: %r" % kind)
    terms, official = load_resource_config(config_path)
    folder_key = KIND_TO_FOLDER[kind]
    try:
        files = list(folder_paths_mod.get_filename_list(folder_key) or [])
    except Exception:
        # ComfyUI 扫描异常 → 视为空列表(端点仍返 200, items 空)
        files = []

    items = []
    for fname in files:
        cat, known, why = classify_resource(fname, terms, official)
        if not show_all and not known:
            # R4 过滤: 未命中 → 跳过
            continue
        items.append({
            "file": fname,
            "category": cat,
            "known_h3": known,
            "why_included": why,
        })
    return {"items": items, "filter_terms": list(terms)}


# V1.9 批 2 T2.4 R1: 模板 LoRA 发现 — 只读扫描 UI 形态模板 (nodes/links/widgets_values),
# 提取 LoRA 节点 (LoraLoader / LoraLoaderModelOnly / MiniMaxH3TurboLoRA) 供前端"工作流自带"
# 列表展示 + 编辑护栏 (template 源条目禁止删除/改强度)。
#
# 与 batch_core.convert 不同点:
# - convert 是 API 形态 (输出 prompt); 本函数读 UI 形态 (输入工作流文件)
# - 本函数不调 /object_info; 不解析 Primitive*; 不连线; 仅读 widgets_values
#   (足够拿 lora_name + strength)
#
# 顺序约定: order = nodes 列表出现顺序 (UI 顺序), 而非 nid 大小 —
# UI 工作流的 LoRA 顺序与注入链一致; 注入链按数组序串接, 顺序敏感。
TEMPLATE_LORA_CLASS_TYPES = ("LoraLoader", "LoraLoaderModelOnly", "MiniMaxH3TurboLoRA")
# V1.11 批4 T4 D6: PDD 加速节点 (MiniMaxH3PDDAccApply) 检测 — 用于前端预警条 + 端点响应.
#   与 batch_core.PDD_ACC_CLASS 同源; 模块独立可测 (无 side effect).
PDD_ACCELERATOR_CLASS = "MiniMaxH3PDDAccApply"


def template_has_pdd(workflow_dict):
    """D6: 检查工作流 (UI 形态 dict) 是否含 MiniMaxH3PDDAccApply 节点.

    输入: workflow_dict — UI 形态 JSON 已 json.loads 后的 dict (含 nodes 数组);
          也兼容 API 形态 (class_type 字段) — 内部统一按节点列表扫.
    返回: bool.
    """
    if not isinstance(workflow_dict, dict):
        return False
    nodes = workflow_dict.get("nodes") or workflow_dict  # API 形态 prompt 直接是 {nid: {...}}
    if not isinstance(nodes, list):
        # API 形态: dict[nid] → {"class_type": ...}
        if isinstance(nodes, dict):
            for n in nodes.values():
                if isinstance(n, dict) and n.get("class_type") == PDD_ACCELERATOR_CLASS:
                    return True
        return False
    for n in nodes:
        if isinstance(n, dict):
            ct = n.get("type") or n.get("class_type")
            if ct == PDD_ACCELERATOR_CLASS:
                return True
    return False


def _extract_lora_widget_field(node, class_type):
    """按节点类名从 widgets_values 提取 (lora_name, strength) 二元组.

    签名 (与 batch_core.convert :2385/2372-2375 一致):
      LoraLoader:           widgets_values = [lora_name, strength_model, strength_clip]
      LoraLoaderModelOnly:  widgets_values = [lora_name, strength_model]
      MiniMaxH3TurboLoRA:   widgets_values = [lora_name, strength, low_vram]

    返回 (name, strength); widgets_values 缺失/空/类型错 → (None, None)
    (调用方负责跳过空名条目)。
    """
    wv = node.get("widgets_values")
    if not isinstance(wv, list) or len(wv) < 2:
        return None, None
    name = wv[0]
    strength = wv[1]
    if not isinstance(name, str) or not name.strip():
        return None, None
    # strength 必为数字; 不是数字 (UI 未填/类型错) → 视作 1.0 兜底 (避免空值传播)
    if not isinstance(strength, (int, float)):
        try:
            strength = float(strength)
        except (TypeError, ValueError):
            strength = 1.0
    return name, strength


def discover_template_loras(workflow_path, *, base_dir=None, config_path=None):
    """T2.4 R1: 只读扫描 UI 形态模板, 提取 LoRA 节点列表.

    参数:
      workflow_path: 模板路径; 相对 H3_WORKFLOW_DIR 或绝对路径 (与 _resolve_workflow_path 同口径)
      base_dir: 可选基础目录; 缺省用 batch_core.H3_WORKFLOW_DIR
      config_path: 词表配置路径 (透传 classify_resource); 缺省 DEFAULT_CONFIG_PATH

    返回: list[dict], 每条 {name, strength, class_type, order, category}
      - name: lora 文件名 (str)
      - strength: 节点第二个 widget (单强度字段; LoraLoader 取 strength_model)
      - class_type: "LoraLoader"/"LoraLoaderModelOnly"/"MiniMaxH3TurboLoRA"
      - order: 出现顺序 (UI nodes 列表索引, 从 0 起)
      - category: 复用 classify_resource (turbo/style/None)

    异常:
      FileNotFoundError: 模板文件不存在
      ValueError: JSON 解析失败 (含原始异常信息)
    """
    # 路径解析: 与 batch_core._resolve_workflow_path 同口径 (相对 base_dir, 否则绝对)
    _resolver = None
    try:
        from .batch_core import _resolve_workflow_path  # 相对包内 (节点包运行)
    except (ImportError, ValueError, ModuleNotFoundError):
        # 单文件加载/测试夹具: 退到 sys.modules 直查 batch_core, 再退到绝对路径直读
        _bc = sys.modules.get("batch_core") or sys.modules.get("h3pkg.batch_core")
        if _bc is not None and hasattr(_bc, "_resolve_workflow_path"):
            _resolver = _bc._resolve_workflow_path
    if _resolver is None:
        _resolver = _resolve_workflow_path if "_resolve_workflow_path" in dir() else None
    if _resolver is not None:
        path = _resolver(workflow_path, base_dir=base_dir)  # None→默认 H3_WORKFLOW_DIR
    else:
        # 兜底: 简化版路径解析 (测试直传绝对路径时不需要 _resolver)
        if os.path.isabs(workflow_path):
            path = workflow_path
        elif base_dir:
            path = os.path.join(base_dir, workflow_path.replace("/", os.sep))
        else:
            path = workflow_path

    if not path:
        raise ValueError("workflow_path 为空")
    if not os.path.isfile(path):
        raise FileNotFoundError("模板不存在: %s" % path)

    # 解析 UI 形态 JSON
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        if isinstance(e, ValueError):
            raise ValueError("模板 JSON 解析失败 (%s): %s" % (path, e))
        raise

    nodes = data.get("nodes") or []
    if not isinstance(nodes, list):
        return []

    # 词表 (供 category 标注; 与 R4 扫描端点同源)
    terms, official = load_resource_config(config_path)

    out = []
    order = 0
    for _idx, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        ct = node.get("type") or node.get("class_type")
        if ct not in TEMPLATE_LORA_CLASS_TYPES:
            continue
        name, strength = _extract_lora_widget_field(node, ct)
        if not name:
            continue
        cat, _known, _why = classify_resource(name, terms, official)
        # T2.4 R1: turbo 类别特殊规则 — 文件名含 "turbo" 或类名 = MiniMaxH3TurboLoRA → 强制 turbo
        # 覆盖默认 classify 的"minimax"先于"turbo"匹配导致的 style 误判 (h3/minimax/turbo 默认词表
        # 中 minimax 排第二, 但 minimax_h3_turbo_* 文件名仍属 turbo 系列)
        if cat != "turbo":
            if "turbo" in name.lower() or ct == "MiniMaxH3TurboLoRA":
                cat = "turbo"
        out.append({
            "name": name,
            "strength": strength,
            "class_type": ct,
            "order": order,
            "category": cat,
        })
        order += 1
    return out


# V1.9 批 2 T2.5 R2: 模板加载点发现 — 解析 UI 形态模板, 提取 UNETLoader/CLIPLoader/VAELoader
# 当前值 (unet_name/clip_name/vae_name 第一 widget), 供前端"模型/CLIP/VAE"下拉默认显示 + 引擎
# 覆写目标锚点定位; 双 VAE 槽位按 nodes 出现顺序, vae_video=第 1 个 VAE, vae_audio=第 2 个;
# 单 VAE 时 vae_video 占用它, vae_audio=null; 0 VAE 时两者都 null.
#
# 与 discover_template_loras 关系: 该函数只关心 loader 节点 (与 LoRA 节点零关系), 双函数
# 共用同一份 UI 模板解析; 实现上独立 (避免混合 LoRA 与 loader 数据, 端点组合 loras+loaders).
#
# 返回: dict {unet: str|None, clip: str|None, vae_video: str|None, vae_audio: str|None}
_LOADER_CLASS_TYPES = ("UNETLoader", "CLIPLoader", "VAELoader")


def _extract_loader_widget_name(node, class_type):
    """从 loader 节点的 widgets_values 提取"文件名字段"。

    UNETLoader:   widgets_values[0] = unet_name
    CLIPLoader:   widgets_values[0] = clip_name
    VAELoader:    widgets_values[0] = vae_name

    返回 str | None — widgets_values 缺失/空/非字符串 → None (调用方按 None 处理, 不报错)
    """
    wv = node.get("widgets_values")
    if not isinstance(wv, list) or len(wv) < 1:
        return None
    name = wv[0]
    if not isinstance(name, str) or not name.strip():
        return None
    return name


def discover_template_loaders(workflow_path, *, base_dir=None):
    """T2.5 R2: 只读扫描 UI 形态模板, 提取 loader 节点当前值.

    参数:
      workflow_path: 模板路径; 与 discover_template_loras 同口径 (相对 base_dir 或绝对路径)
      base_dir: 可选基础目录; 缺省用 batch_core.H3_WORKFLOW_DIR (与 discover_template_loras 一致)

    返回: dict {unet, clip, vae_video, vae_audio}; 值 = 当前文件名 (str) 或 None (未找到)
      - unet: 第 1 个 UNETLoader 的 unet_name; 若模板无 UNETLoader → None
      - clip: 第 1 个 CLIPLoader 的 clip_name; 若模板无 CLIPLoader → None
      - vae_video: 第 1 个 VAELoader 的 vae_name
      - vae_audio: 第 2 个 VAELoader 的 vae_name; 单 VAE 时为 None

    异常:
      FileNotFoundError: 模板文件不存在
      ValueError: JSON 解析失败 (含原始异常信息) / workflow_path 为空
    """
    # 路径解析: 与 discover_template_loras 完全同口径 (复用 _resolver 查找)
    _resolver = None
    try:
        from .batch_core import _resolve_workflow_path  # 相对包内 (节点包运行)
    except (ImportError, ValueError, ModuleNotFoundError):
        _bc = sys.modules.get("batch_core") or sys.modules.get("h3pkg.batch_core")
        if _bc is not None and hasattr(_bc, "_resolve_workflow_path"):
            _resolver = _bc._resolve_workflow_path
    if _resolver is None:
        _resolver = _resolve_workflow_path if "_resolve_workflow_path" in dir() else None
    if _resolver is not None:
        path = _resolver(workflow_path, base_dir=base_dir)  # None→默认 H3_WORKFLOW_DIR
    else:
        # 兜底: 简化版路径解析 (测试直传绝对路径时不需要 _resolver)
        if os.path.isabs(workflow_path):
            path = workflow_path
        elif base_dir:
            path = os.path.join(base_dir, workflow_path.replace("/", os.sep))
        else:
            path = workflow_path

    if not path:
        raise ValueError("workflow_path 为空")
    if not os.path.isfile(path):
        raise FileNotFoundError("模板不存在: %s" % path)

    # 解析 UI 形态 JSON
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        if isinstance(e, ValueError):
            raise ValueError("模板 JSON 解析失败 (%s): %s" % (path, e))
        raise

    nodes = data.get("nodes") or []
    if not isinstance(nodes, list):
        # 与 discover_template_loras 同: 非列表视为空节点列表
        nodes = []

    # 按 nodes 出现顺序扫描, 维护各类 loader 第一次出现 (nid 最小)
    unet_name = None
    clip_name = None
    vae_names = []  # 双槽位顺序保留
    for node in nodes:
        if not isinstance(node, dict):
            continue
        ct = node.get("type") or node.get("class_type")
        if ct not in _LOADER_CLASS_TYPES:
            continue
        name = _extract_loader_widget_name(node, ct)
        if name is None:
            continue
        if ct == "UNETLoader" and unet_name is None:
            unet_name = name
        elif ct == "CLIPLoader" and clip_name is None:
            clip_name = name
        elif ct == "VAELoader":
            vae_names.append(name)

    # 双 VAE 槽位 (按 nodes 顺序)
    vae_video = vae_names[0] if len(vae_names) >= 1 else None
    vae_audio = vae_names[1] if len(vae_names) >= 2 else None

    return {
        "unet": unet_name,
        "clip": clip_name,
        "vae_video": vae_video,
        "vae_audio": vae_audio,
    }