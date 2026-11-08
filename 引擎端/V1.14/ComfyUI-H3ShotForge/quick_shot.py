import json
import os
import sys

# 兼容包内(__init__.py)与平铺(测试/mcp_server)两种导入方式
_SELF_DIR = os.path.dirname(os.path.abspath(__file__))
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)
from shot_vocab import STRUCT_FIELDS

SHOT_KEYS = ["ID"] + list(STRUCT_FIELDS) + ["prompt", "段落时长", "种子", "导出文件名"]
KINDS = ("Picture", "Video", "Audio")


DEFAULT_GLOBALS = {"比例": "16:9", "质量": "0.4", "步数": "8V8A", "提示词": "", "语言": "中文"}  # 2.9: 加批级语言默认


def quick_payload(s):
    """shots_json 兼容两种格式: {"globals":..., "shots":[...]} 对象; 旧 \n\n 分块文本。"""
    try:
        obj = json.loads(s)
    except (TypeError, ValueError):
        obj = None
    if isinstance(obj, dict) and isinstance(obj.get("shots"), list):
        g = obj.get("globals")
        globals_ = {k: str(g.get(k, v) or v) for k, v in DEFAULT_GLOBALS.items()} if isinstance(g, dict) else dict(DEFAULT_GLOBALS)
        return [x for x in obj["shots"] if isinstance(x, dict)], globals_
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)], dict(DEFAULT_GLOBALS)
    shots = []
    for block in [x.strip() for x in (s or "").split("\n\n") if x.strip()]:
        try:
            o = json.loads(block)
            if isinstance(o, dict):
                shots.append(o)
                continue
        except ValueError:
            pass
        shots.append({"prompt": block})
    return shots, dict(DEFAULT_GLOBALS)


def quick_data_to_csv_data(shots, globals_):
    pool = {k: {} for k in KINDS}
    norm = []
    for i, s in enumerate(shots, 1):
        row = {k: str(s.get(k, "") or "") for k in SHOT_KEYS}
        row["ID"] = row["ID"] or "shot_%03d" % i
        tags = []
        for kind in KINDS:
            p = str(s.get(kind, "") or "").strip()
            if p:
                slot = len(pool[kind]) + 1
                pool[kind][str(slot)] = p
                tags.append("<%s %d>" % (kind, slot))
        if tags:
            row["prompt"] = (row["prompt"] + " " if row["prompt"] else "") + " ".join(tags)
        norm.append(row)
    return {"pool": pool, "globals": dict(globals_), "shots": norm}


class H3QuickShot:
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("shots_json",)
    FUNCTION = "build"
    CATEGORY = "H3/Batch"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {
            "shot_1": ("STRING", {"multiline": False, "default": "",
                "placeholder": "每镜一块,格式: 一行 JSON {\"prompt\":..., \"Picture\": \"路径\", ...} 或留空"}),
        }}

    def build(self, shot_1=""):
        shots, g = quick_payload(shot_1 or "")
        return json.dumps({"globals": g, "shots": shots}, ensure_ascii=False)
