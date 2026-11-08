import json
import os
import re

STRUCT_FIELDS = ("镜头角度", "景别", "运镜方式", "运镜方向", "运镜幅度", "运镜速度", "焦段", "氛围", "情绪")
# 1.11b 波1 T1: 自定义模式 CSV 逐段勾选列名常量 — 归属与同步方: batch_core / csv_gen / __init__ 均从此导入
CONCAT_FLAG_COL = "与上一片段拼接"
_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VOCAB_PATH = os.path.join(_DIR, "shot_vocab.json")
USER_VOCAB_PATH = os.path.join(_DIR, "user_vocab.json")

# 内置兜底词库(shot_vocab.json 缺失/损坏时使用;字段与 shot_vocab.json 保持一致)
# 条目 v2: 短语模板对象 {"phrase": ..., "phrase_en": ...}(phrase_en 供 2.9 英文开关消费)
DEFAULT_VOCAB = {
    "镜头角度": [
        {"phrase": "平视", "phrase_en": "eye-level angle"},
        {"phrase": "俯拍", "phrase_en": "high angle"},
        {"phrase": "仰拍", "phrase_en": "low angle"},
        {"phrase": "过肩视角", "phrase_en": "over-the-shoulder view"},
        {"phrase": "主观视角", "phrase_en": "first-person POV"},
        {"phrase": "荷兰角", "phrase_en": "Dutch angle"},
    ],
    "景别": [
        {"phrase": "大远景", "phrase_en": "extreme long shot"},
        {"phrase": "远景", "phrase_en": "long shot"},
        {"phrase": "全景", "phrase_en": "full shot"},
        {"phrase": "中景", "phrase_en": "medium shot"},
        {"phrase": "中近景", "phrase_en": "medium close-up"},
        {"phrase": "近景", "phrase_en": "close shot"},
        {"phrase": "特写", "phrase_en": "close-up"},
        {"phrase": "大特写", "phrase_en": "extreme close-up"},
    ],
    # 运镜四轴(2.3): 方式/方向按 26 号官方运镜词表(MIT)对照补词; 幅度/速度留空=不入句
    "运镜方式": [
        {"phrase": "固定机位", "phrase_en": "static camera"},
        {"phrase": "推近", "phrase_en": "dolly in"},
        {"phrase": "拉远", "phrase_en": "dolly out"},
        {"phrase": "摇镜", "phrase_en": "pan"},
        {"phrase": "移镜", "phrase_en": "truck"},
        {"phrase": "跟拍", "phrase_en": "tracking shot"},
        {"phrase": "升降", "phrase_en": "pedestal"},
        {"phrase": "环绕", "phrase_en": "orbit"},
        {"phrase": "手持摄影", "phrase_en": "handheld camera"},
        {"phrase": "变焦推近", "phrase_en": "zoom in"},
        {"phrase": "变焦拉远", "phrase_en": "zoom out"},
        {"phrase": "横滚", "phrase_en": "roll"},
        {"phrase": "强烈晃动", "phrase_en": "shake strongly"},
    ],
    "运镜方向": [
        {"phrase": "向前", "phrase_en": "forward"},
        {"phrase": "向后", "phrase_en": "backward"},
        {"phrase": "向左", "phrase_en": "left"},
        {"phrase": "向右", "phrase_en": "right"},
        {"phrase": "向上", "phrase_en": "upward"},
        {"phrase": "向下", "phrase_en": "downward"},
        # R5: +4 斜向 (用户"方向太少"); 插在"向下"后/"顺时针"前, 平移向连续
        {"phrase": "向左前方", "phrase_en": "forward and to the left"},
        {"phrase": "向右前方", "phrase_en": "forward and to the right"},
        {"phrase": "向左后方", "phrase_en": "backward and to the left"},
        {"phrase": "向右后方", "phrase_en": "backward and to the right"},
        {"phrase": "顺时针", "phrase_en": "clockwise"},
        {"phrase": "逆时针", "phrase_en": "counterclockwise"},
    ],
    "运镜幅度": [
        {"phrase": "小幅", "phrase_en": "slight"},
        {"phrase": "大幅", "phrase_en": "large"},
    ],
    "运镜速度": [
        {"phrase": "缓慢", "phrase_en": "slow"},
        {"phrase": "快速", "phrase_en": "fast"},
    ],
    # 焦段(2.4): 方案定稿三档, 不自扩
    "焦段": [
        {"phrase": "广角镜头", "phrase_en": "wide-angle lens"},
        {"phrase": "长焦镜头", "phrase_en": "telephoto lens"},
        {"phrase": "微距镜头", "phrase_en": "macro lens"},
    ],
    "氛围": [
        {"phrase": "紧张", "phrase_en": "tense"},
        {"phrase": "温馨", "phrase_en": "warm and cozy"},
        {"phrase": "悲伤", "phrase_en": "sorrowful"},
        {"phrase": "欢快", "phrase_en": "cheerful"},
        {"phrase": "悬疑", "phrase_en": "suspenseful"},
        {"phrase": "史诗", "phrase_en": "epic"},
        {"phrase": "宁静", "phrase_en": "serene"},
        {"phrase": "梦幻", "phrase_en": "dreamlike"},
    ],
    "情绪": [
        {"phrase": "平静", "phrase_en": "calm"},
        {"phrase": "愤怒", "phrase_en": "angry"},
        {"phrase": "喜悦", "phrase_en": "joyful"},
        {"phrase": "悲伤", "phrase_en": "sad"},
        {"phrase": "恐惧", "phrase_en": "fearful"},
        {"phrase": "惊讶", "phrase_en": "surprised"},
        {"phrase": "期待", "phrase_en": "expectant"},
        {"phrase": "失落", "phrase_en": "dejected"},
    ],
}


def _read_json(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _phrase(e):
    """条目归一化为短语字符串; 非法条目返回 None(静默丢弃)。"""
    if isinstance(e, str):
        return e
    if isinstance(e, dict):
        p = e.get("phrase")
        if isinstance(p, str) and p:
            return p
    return None


def _phrase_en(e):
    """英文短语归一化: dict 的 phrase_en 或纯字符串自身; 缺/非法返 None(降级原值)。"""
    if isinstance(e, str):
        return e
    if isinstance(e, dict):
        p = e.get("phrase_en")
        if isinstance(p, str) and p:
            return p
    return None


def load_vocab(path=None):
    merged = dict(DEFAULT_VOCAB)
    if path:
        merged.update(_read_json(path))
    else:
        merged.update(_read_json(DEFAULT_VOCAB_PATH))
        merged.update(_read_json(USER_VOCAB_PATH))  # 用户词库优先,可只写要覆盖的字段
    return {f: [p for p in (_phrase(e) for e in merged.get(f, [])) if p]
            for f in STRUCT_FIELDS}


def load_vocab_map(path=None):
    """2.9 英文编译查表: 合并逻辑与 load_vocab 同源, 返回 {字段: {中文: 英文}}.
    纯字符串条目映射自身, dict 缺 phrase_en 时降级原值(不发明内容)."""
    merged = dict(DEFAULT_VOCAB)
    if path:
        merged.update(_read_json(path))
    else:
        merged.update(_read_json(DEFAULT_VOCAB_PATH))
        merged.update(_read_json(USER_VOCAB_PATH))
    out = {}
    for f in STRUCT_FIELDS:
        m = {}
        for e in merged.get(f, []):
            cn = _phrase(e)
            en = _phrase_en(e)
            if cn is not None and en is not None:
                m[cn] = en
        out[f] = m
    return out


_MARKER_SOUND = re.compile(r"^声音[^：]*[：:]")
_MARKER_MUSIC = re.compile(r"^音乐[^：]*[：:]")
# 2.9: 英文模式仅识别半角 Sound:/Music:, 中文标记留画面侧(不路由)
_MARKER_SOUND_EN = re.compile(r"^Sound[^:]*:")
_MARKER_MUSIC_EN = re.compile(r"^Music[^:]*:")


def _capitalize_first(s):
    """2.9 英文路径专用: 首字符转大写; 非 ASCII 字符如中文无副作用(EN-5 缺词回落用)."""
    if not s:
        return s
    return s[0].upper() + s[1:]


def _compile_row(row, lang="zh", vocab_map=None):
    if lang == "en":
        return _compile_row_en(row)
    size = str(row.get("景别", "") or "").strip()
    angle = str(row.get("镜头角度", "") or "").strip()
    move = str(row.get("运镜方式", "") or "").strip()
    direction = str(row.get("运镜方向", "") or "").strip()
    amp = str(row.get("运镜幅度", "") or "").strip()
    speed = str(row.get("运镜速度", "") or "").strip()
    focal = str(row.get("焦段", "") or "").strip()
    mood = str(row.get("氛围", "") or "").strip()
    emotion = str(row.get("情绪", "") or "").strip()
    free = str(row.get("prompt", "") or "").strip()

    visual, sound, music = [], [], []
    for line in free.split("\n"):
        s = line.strip()
        if s and _MARKER_SOUND.match(s):
            sound.append(_MARKER_SOUND.sub("", s, count=1))
        elif s and _MARKER_MUSIC.match(s):
            music.append(_MARKER_MUSIC.sub("", s, count=1))
        else:
            visual.append(line)

    frag = ""
    # 批 C 节点 C-II (C1): 仅"运镜方式"字段输出英文术语; 词条无 phrase_en → 原中文零分隔拼接 (与旧字节一致)
    # 拼接规则: 有英文方式词 = 中文段(速度+幅度+方向, 零分隔) + " " + 英文方式词;
    #          中文段空缺则英文词直接开头; 回落(无 phrase_en) = 旧字节逐字节一致.
    # 用户词库覆盖关系: vocab_map 注入时使用注入表; 缺省 load_vocab_map() (含 user_vocab.json 覆盖)
    move_en = None
    if move:
        _vm = vocab_map if vocab_map is not None else load_vocab_map()
        move_en = _vm.get("运镜方式", {}).get(move)
    if move or direction:
        if move_en:
            # 中文段: 速度+幅度+方向, 零分隔 (与旧 :195-199 顺序照旧)
            cn_seg = speed + amp + direction
            frag = (cn_seg + " " + move_en) if cn_seg else move_en
        else:
            # 回落: 旧行为零分隔拼接
            frag = direction + move
            if amp or speed:
                frag = speed + amp + frag  # 缓慢|大幅|向前|推近 顺序拼接, 零分隔符
    shots = [p for p in (size, angle, focal, frag) if p]
    moods = [p for p in (mood, emotion) if p]

    parts = []
    if shots:
        parts.append("，".join(shots) + "。")
    if moods:
        parts.append("氛围" + "、".join(moods) + "。")
    free_visual = "\n".join(visual).strip()
    if free_visual:
        parts.append(free_visual)

    fields = []
    if parts:
        fields.append("".join(parts))
    if sound:
        fields.append("overall_soundscape: " + "\n".join(sound))
    if music:
        fields.append("non_diegetic_music: " + "\n".join(music))
    return "\n\n".join(fields)


def _compile_row_en(row, vocab_map):
    """2.9 英文路径: 词库查表翻译 + 英文标记路由 + 缺词回落原文.
    vocab_map 由 assemble_prompt 注入(默认 load_vocab_map()), 可注入自定义翻译表(测试用)."""
    def _t(field, value):
        v = str(value or "").strip()
        if not v:
            return ""
        return vocab_map.get(field, {}).get(v, v)

    size = _t("景别", row.get("景别", ""))
    angle = _t("镜头角度", row.get("镜头角度", ""))
    move = _t("运镜方式", row.get("运镜方式", ""))
    direction = _t("运镜方向", row.get("运镜方向", ""))
    amp = _t("运镜幅度", row.get("运镜幅度", ""))
    speed = _t("运镜速度", row.get("运镜速度", ""))
    focal = _t("焦段", row.get("焦段", ""))
    mood = _t("氛围", row.get("氛围", ""))
    emotion = _t("情绪", row.get("情绪", ""))
    free = str(row.get("prompt", "") or "")

    visual, sound, music = [], [], []
    for line in free.split("\n"):
        s = line.strip()
        if s and _MARKER_SOUND_EN.match(s):
            sound.append(_MARKER_SOUND_EN.sub("", s, count=1).lstrip())
        elif s and _MARKER_MUSIC_EN.match(s):
            music.append(_MARKER_MUSIC_EN.sub("", s, count=1).lstrip())
        else:
            visual.append(line)

    frag = ""
    if move or direction:
        # EN 规则(2.1): 运镜片段 = " ".join([速度, 幅度, 方向, 方式] 中非空者)
        if amp or speed:
            frag = " ".join([p for p in (speed, amp, direction, move) if p])
        else:
            frag = direction + " " + move if (direction and move) else (direction or move)
    shots = [p for p in (size, angle, focal, frag) if p]
    moods = [p for p in (mood, emotion) if p]

    parts = []
    if shots:
        sentence = _capitalize_first(", ".join(shots)) + "."
        # EN-5 缺词回落: 首词非 ASCII(中文)时句末改全角"。"(与中文路径句式一致)
        if shots[0] and not shots[0][0].isascii():
            sentence = sentence[:-1] + "。"
        parts.append(sentence)
    if moods:
        parts.append("Mood: " + ", ".join(moods) + ".")
    free_visual = "\n".join(visual).strip()
    if free_visual:
        parts.append(free_visual)

    fields = []
    if parts:
        fields.append(" ".join(parts))
    if sound:
        fields.append("overall_soundscape: " + "\n".join(sound))
    if music:
        fields.append("non_diegetic_music: " + "\n".join(music))
    return "\n\n".join(fields)


def assemble_prompt(row, vocab=None, lang="zh", vocab_map=None):
    # v2(2.2/2.3/2.4): 九分项任一非空 => 三字段编译; 全空 => 纯手写行原样直发(兼容红线, 语言无关)
    # 2.9: 加可选 lang 参数("zh"/"en"); lang="en" 走英文查表翻译路径
    # 批 C 节点 C-II (C1): zh 路径加可选 vocab_map (测试可注入自定义翻译表; 默认 load_vocab_map())
    if not any(str(row.get(f, "") or "").strip() for f in STRUCT_FIELDS):
        return str(row.get("prompt", "") or "").strip()
    if lang == "en":
        # vocab 可注入自定义翻译表(测试用), 默认全局词库
        return _compile_row_en(row, vocab if vocab is not None else load_vocab_map())
    return _compile_row(row, vocab_map=vocab_map)
