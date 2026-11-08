"""prompt_assembler.py — 单镜最终提示词组装模块 (批 A 节点 1 收口 + 节点 2 六字段改造)

目的: 把原本散落在 batch_core.py / shot_vocab.py / __init__.py 的 8 处组装散点
收拢为**单一组装入口**, 行为零变化 (golden 期望文本逐字节锁定).

散点列表 (收口前):
  batch_core.py: usages_to_blocks, enrich_blocks, cast_blocks, merged_prompt,
                 _compose_subject_line, _filter_global_subject_lines
  shot_vocab.py: _compile_row, _compile_row_en, assemble_prompt
  __init__.py:   _h3_preview_prompt / _h3_gen_csv 的内联编排链

公开 API:
  assemble_final_prompt(*, row, ...) — 单镜最终提示词组装唯一入口
  cast_blocks(cast_spec, lang="zh")  — 单角色块生成 (前端 /h3_batch/cast_block 用)

向后兼容:
  - 旧函数保留在 batch_core.py 中, 测试 import 路径不变
  - 引擎内部 (_apply_shot_common / apply_shot_pool / apply_shot_concat) 走本模块
  - 端点层 (__init__.py) 仅调本模块的入口

行为契约:
  - 与原三处内联编排链逐字节等价 (见 tests/golden_legacy/ 54 个场景)
  - 批 A 节点 2: ref2v + cast_spec 路径走六字段结构 (新); 旧路径 (池用途/无绑定) 逐字节不变
"""
import os as _os
import re as _re
import sys as _sys

# ComfyUI 以 spec_from_file_location 加载 custom node (目录不进 sys.path),
# 本模块可能先于 batch_core 被导入 —— 复用 batch_core.py:18 的自举模式
_SELF_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _SELF_DIR not in _sys.path:
    _sys.path.insert(0, _SELF_DIR)

import batch_core as _bc


# ===== 批 A 节点 2: 六字段结构标签头 (按规格一顺序逐字锁定) =====
SIX_FIELD_LABELS = (
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)

# retention_analysis 级别映射 — 批 B 节点 B-II: 智能推断 (确定性规则, 可测)
# 规格 (逐字锁定):
#   subject_look      → 容貌 fully_preserved
#   subject_outfit    → 服装 fully_preserved (默认级) /
#                       partially_preserved (desc 含弱化词表)
#   subject_prop      → 道具 attribute_transfer
#   pose              → 姿势 fully_preserved
#   scene             → 场景 weak_reference
#   video_motion      → 单视频段 <Video N>: fully_preserved (#76 复刻形态)
#                       多视频段 (槽数>=2) → 动作 weak_reference (锁现状)
# 1.11c 波2-T4: 三视图 → 三视图 fully_preserved (三视图是另一类外貌参照, 与 subject_look 同级)
_RETENTION_LEVEL = {
    "subject_look": "fully_preserved",
    "subject_outfit": "fully_preserved",   # 默认级, 弱化词分档见 _infer_outfit_level
    "subject_prop": "attribute_transfer",
    "pose": "fully_preserved",
    "scene": "weak_reference",
    "video_motion": "fully_preserved",
    "三视图": "fully_preserved",
}
# #76: 多视频段 (video_ref 槽数>=2) 的动作保留级别 — 维持现状弱参考 (复刻框架仅对单视频段生效)
_RETENTION_LEVEL_VIDEO_MULTI = "weak_reference"
# outfit 弱化词表 (写死常量, 词典确定性可测, 详见 test_b_ii_smart_inference.py)
_OUTFIT_WEAK_WORDS = ("参考", "近似", "类似", "风格")
# retention_analysis Subject 侧属性名 (zh)
_RETENTION_ATTR_ZH = {
    "subject_look": "容貌",
    "subject_outfit": "服装",
    "subject_prop": "道具",
    "pose": "姿势",
    "三视图": "三视图",
}
# retention_analysis 无 Subject 前缀的属性名 (zh)
_RETENTION_NO_PREFIX_ZH = {
    "scene": "场景",
    "video_motion": "动作",
}

# 批 A 后小迭代: 三勾选语义常量 (逐字锁定)
_NEG_MUSIC_LINE_ZH = "non_diegetic_music: N/A"
_NEG_MUSIC_VALUE_ZH = "N/A"
_NEG_DIALOGUE_ZH = "人物全程不张嘴、不说话，无旁白。"
_NEG_TEXT_ZH = "无字幕，无文字水印。"
_NEG_EN_FULL = "no narration, no voiceover, no subtitles, no text watermark, no music"


# ===== 批 C 节点 C-I: 对话标签自动转换 (转换函数 + 挂点) =====
# 转换发生在名字替换前; 产出的 (SN) / <d> 标记不参与也不受名字替换影响.

# L1 引号集 (开/闭) — 直引号 `"` 与中文引号全列
_DIALOGUE_QUOTE_PAIRS = (
    ("\u300c", "\u300d"),  # 「」
    ("\u300e", "\u300f"),  # 『』
    ("\u201c", "\u201d"),  # ""
    ("\u2018", "\u2019"),  # ''
    ('"', '"'),
    ("'", "'"),
)
# L2 终止符集 (写死): 。！？!?.
_DIALOGUE_TERMINALS = "。！？!?."
# 动词表 (初始, 中文) — 按长度降序优先, 防 "大声说" 截断成 "说"
_ZH_DIALOGUE_VERBS = (
    "大声说", "低声说",
    "说道", "喊着", "喊道", "叫着", "叫道",
    "回答道", "答道", "问道",
    "说着",
    "说", "喊", "叫", "答", "问",
)
# 去重保序 (按长度降序排列)
_ZH_DIALOGUE_VERBS_SORTED = sorted(
    set(_ZH_DIALOGUE_VERBS), key=lambda v: -len(v))
# 动词表 (英文) — \b 词边界
_EN_DIALOGUE_VERBS = (
    "whispered", "whispers",
    "shouted", "shouts",
    "replied", "replies",
    "speaks", "spoke",
    "asked", "asks",
    "said", "says",
)
# 行头排除清单 (strip 后命中即整行跳过)
# 批 C 节点 C-I: 与方案一致 12 项 (D2 修复 2026-08-28 补 integrated_multimodal_description)
_DIALOGUE_LINE_HEADERS = (
    "声音", "音乐", "Sound", "Music",
    "<Subject",
    "overall_soundscape", "non_diegetic_music",
    "subject_definitions", "summary", "retention_analysis",
    "detailed_description",
    "integrated_multimodal_description",
)
# 行内已有 <d> 标记检测
_DIALOGUE_TAG_INLINE = _re.compile(r"<d\b[^>]*>.*?</d>", _re.IGNORECASE | _re.DOTALL)
# A→B 说话人前介词 (A 对/向/跟/和/朝着 B 动词)
_A_TO_B_PREPS = ("对", "向", "跟", "和", "朝着")
# 名字 token 正则 (非空白 CJK + 字母数字下划线)
_NAME_TOKEN_RE = _re.compile(r"[\w\u4e00-\u9fff]+", _re.UNICODE)


def _lookup_binding_no(bindings, name):
    """查 bindings 表拿 no. 找不到返回 None."""
    if not bindings:
        return None
    for b in bindings:
        if isinstance(b, dict) and b.get("name") == name:
            no = b.get("no")
            if isinstance(no, int):
                return no
    return None


def _is_dialogue_header_line(line):
    """行头排除: strip 后命中 _DIALOGUE_LINE_HEADERS 任一前缀 → True (整行跳过)."""
    s = line.lstrip()
    for h in _DIALOGUE_LINE_HEADERS:
        if s.startswith(h):
            return True
    return False


def _line_has_dialogue_tag(line):
    """行内已有 <d>...</d> → True (幂等跳过)."""
    return _DIALOGUE_TAG_INLINE.search(line) is not None


def _find_zhi_dialogue_verb(line):
    """在 line 中找中文动词. 返回 (verb, start, end) 或 None.

    选择规则 (D5 修复 2026-08-28, 跨进程确定):
      1) 行内位置最靠前的命中优先 (start 升序)
      2) 位置相同时, 长度降序 (防 '说' 吞 '大声说')
    注: 旧实现按 _ZH_DIALOGUE_VERBS_SORTED 顺序 find, set 迭代序受 PYTHONHASHSEED
    影响, 同长度组内顺序跨进程变化 → 跨进程选择不可重现.
    """
    hits = []
    for v in _ZH_DIALOGUE_VERBS_SORTED:
        idx = line.find(v)
        if idx >= 0:
            hits.append((v, idx, idx + len(v)))
    if not hits:
        return None
    # 位置最靠前; 位置同时按长度降序 (start 升序主键, -len(v) 副键)
    hits.sort(key=lambda h: (h[1], -len(h[0])))
    return hits[0]


def _find_en_dialogue_verb(line):
    """在 line 中找首个英文动词 (\b 词边界). 返回 (verb, start, end) 或 None."""
    for v in _EN_DIALOGUE_VERBS:
        m = _re.search(r"\b" + _re.escape(v) + r"\b", line, _re.IGNORECASE)
        if m:
            return (v, m.start(), m.end())
    return None


def _find_dialogue_verb(line, lang):
    """找动词 (中英文都查). lang 仅影响后续 marker (语言标签), 不限制动词识别."""
    r = _find_zhi_dialogue_verb(line)
    if r:
        return r
    r = _find_en_dialogue_verb(line)
    return r


def _extract_speaker(line, verb_end_pos, bindings):
    """在 verb_end_pos 之前找说话人 token.

    说话人词法 (写死, 批 C 节点 C-I):
      1) A (对|向|跟|和|朝着) B 动词 句式 → 说话人 = A (前置名, 优先级最高)
      2) 绑定名按长度降序匹配, 取最右 (距离 verb 最近的)
      3) 否则任意非空白 CJK / 字母数字串 (覆盖未绑定名 路人甲), 取最右
      4) 动词前无名字 token → 返回 None
    """
    head = line[:verb_end_pos]

    # 1) A→B 句式检测 (优先级最高) — 在 head 末端找 "A + prep + B" 形态 (B 在最右)
    #    说话人 = A (前置名), 即 prep 之前的 token
    last_prep_match = None
    for prep in _A_TO_B_PREPS:
        idx = head.rfind(prep)
        if idx < 0:
            continue
        # prep 之前的最后一个 name token (即 A)
        before_prep = head[:idx]
        tokens = list(_NAME_TOKEN_RE.finditer(before_prep))
        if tokens:
            if last_prep_match is None or idx > last_prep_match[0]:
                last_prep_match = (idx, tokens[-1])

    if last_prep_match is not None:
        return last_prep_match[1].group(0)

    # 2) 找所有绑定名在 head 中出现的位置
    # D4 修复 2026-08-28: 候选名命中后检查右边界 — 名字后一字符为 ASCII
    # 字母/数字/下划线视为前缀吞并, 拒绝该次匹配. 例如:
    #   '少女11' 未绑定, '少女1' 命中位置 0 后下一字符 '1' 数字 → 拒绝,
    #   走未绑定路径 (无 (S1) + D1 黄条).
    # CJK (中文) 不算续接 — 不破坏验收⑥ '少女1对少女2说:你好' → (S1),
    #   也不破坏验收⑨ '少女11' 已绑定 → (S11) (动词首字 '说' CJK 不拒绝),
    #   也不破坏常规 '少女1开心地说:你好' → (S1) ('开' CJK 不拒绝).
    # 注: Python 3 _re 默认 UNICODE 模式, \w 含中文 CJK — 不能直接用 \w,
    # 必须用 [A-Za-z0-9_] 限定 ASCII.
    candidates = []
    for b in (bindings or []):
        if not isinstance(b, dict):
            continue
        name = b.get("name") or ""
        if not name:
            continue
        start = 0
        while True:
            idx = head.find(name, start)
            if idx < 0:
                break
            # D4 右边界检查: 名字后一字符为 ASCII 字母/数字/下划线 → 拒绝 (前缀吞并)
            end_idx = idx + len(name)
            if end_idx < len(head):
                next_ch = head[end_idx]
                if _re.match(r"[A-Za-z0-9_]", next_ch):
                    start = idx + 1
                    continue
            candidates.append((idx, end_idx, name, b.get("no")))
            start = idx + 1
    if candidates:
        # 取最右 (距离 verb 最近的) — 若并列取最长
        candidates.sort(key=lambda c: (-c[0], -(c[1] - c[0])))
        return candidates[0][2]

    # 3) 未绑定名: head 末端最后一个 name token
    tokens = list(_NAME_TOKEN_RE.finditer(head))
    if tokens:
        return tokens[-1].group(0)
    return None


def _sentence_start_index(line, pos):
    """找 line 中 pos 之前最近的句末标点位置+1 (即下一句起点).

    句末标点集: 。！？!?. . pos 已是行首或前无标点 → 返回 0 (行首).
    """
    if pos <= 0:
        return 0
    for i in range(pos - 1, -1, -1):
        if line[i] in _DIALOGUE_TERMINALS:
            return i + 1
    return 0


def _try_l1_quote_conversion(line, bindings, lang, marker, events, line_idx):
    """L1 引号集: 动词 + 开引号 + 内容 + 闭引号.
    引号边界优先于句边界; 行内引号未闭合 → 不转.
    """
    for open_q, close_q in _DIALOGUE_QUOTE_PAIRS:
        for m in _re.finditer(_re.escape(open_q), line):
            open_pos = m.start()
            close_pos = line.find(close_q, open_pos + len(open_q))
            if close_pos < 0:
                continue  # 未闭合, 跳过
            verb_info = _find_dialogue_verb(line[:open_pos], lang)
            if not verb_info:
                continue
            _, verb_start, verb_end = verb_info
            speaker = _extract_speaker(line, verb_start, bindings)
            if not speaker:
                continue
            sn_anchor = _sentence_start_index(line, open_pos)
            content = line[open_pos + len(open_q):close_pos]
            no = _lookup_binding_no(bindings, speaker)
            if no is None:
                new_line = (
                    line[:open_pos + len(open_q)]
                    + marker + content + "</d>"
                    + line[close_pos:]
                )
                events.append(("missing_speaker", speaker, line_idx))
            else:
                new_line = (
                    line[:sn_anchor]
                    + "(S%d)" % no
                    + line[sn_anchor:open_pos + len(open_q)]
                    + marker + content + "</d>"
                    + line[close_pos:]
                )
            return new_line, True
    return line, False


def _find_dialogue_end(line, start):
    """在 line 中从 start 起找第一个终止符 (含) 位置; 若到行尾无终止符 → 返回行尾.

    L2 终止符集: 。！？!?. + 行尾.
    """
    i = start
    while i < len(line):
        if line[i] in _DIALOGUE_TERMINALS:
            return i + 1
        i += 1
    return len(line)


def _try_l2_colon_conversion(line, bindings, lang, marker, events, line_idx):
    """L2 冒号: 动词 + 全角/半角冒号 + 台词 + 行内终止符.

    冒号集: : : (全角/半角均认)
    """
    verb_info = _find_dialogue_verb(line, lang)
    if not verb_info:
        return line, False
    verb, verb_start, verb_end = verb_info
    # 冒号在 verb 之后
    colon_pos = -1
    for i in range(verb_end, len(line)):
        if line[i] in (':', '\uff1a'):
            colon_pos = i
            break
    if colon_pos < 0:
        return line, False
    content_start = colon_pos + 1  # 冒号位置后 1 (保留冒号在原文中)
    content_text_start = content_start
    while content_text_start < len(line) and line[content_text_start] in (' ', '\t'):
        content_text_start += 1
    if content_text_start >= len(line):
        return line, False  # 冒号后无内容, 不转
    content_end = _find_dialogue_end(line, content_text_start)
    if content_end <= content_text_start:
        return line, False
    content = line[content_text_start:content_end]
    speaker = _extract_speaker(line, verb_start, bindings)
    if not speaker:
        return line, False
    sn_anchor = _sentence_start_index(line, colon_pos)
    no = _lookup_binding_no(bindings, speaker)
    if no is None:
        new_line = (
            line[:content_text_start]  # 保留冒号 + 中间空白
            + marker + content + "</d>"
            + line[content_end:]
        )
        events.append(("missing_speaker", speaker, line_idx))
    else:
        new_line = (
            line[:sn_anchor]
            + "(S%d)" % no
            + line[sn_anchor:content_text_start]  # 保留冒号 + 中间空白
            + marker + content + "</d>"
            + line[content_end:]
        )
    return new_line, True


def _try_l2prime_theater_conversion(line, bindings, lang, marker, events, line_idx):
    """L2' 剧本体: 仅绑定名 + 直冒号 (无动词).

    名字 token 按长度降序匹配绑定名; 命中后冒号必须紧跟其后.
    """
    if not bindings:
        return line, False
    sorted_bound = sorted(bindings, key=lambda b: -len(b.get("name", "") or ""))
    for b in sorted_bound:
        if not isinstance(b, dict):
            continue
        name = b.get("name") or ""
        if not name:
            continue
        idx = line.find(name)
        if idx < 0:
            continue
        after = idx + len(name)
        while after < len(line) and line[after] in (' ', '\t'):
            after += 1
        if after >= len(line) or line[after] not in (':', '\uff1a'):
            continue
        content_start = after + 1  # 冒号位置后 1 (保留冒号)
        content_text_start = content_start
        while content_text_start < len(line) and line[content_text_start] in (' ', '\t'):
            content_text_start += 1
        if content_text_start >= len(line):
            continue
        content_end = _find_dialogue_end(line, content_text_start)
        if content_end <= content_text_start:
            continue
        content = line[content_text_start:content_end]
        no = b.get("no")
        sn_anchor = _sentence_start_index(line, idx)
        new_line = (
            line[:sn_anchor]
            + "(S%d)" % no
            + line[sn_anchor:content_text_start]  # 保留冒号 + 中间空白
            + marker + content + "</d>"
            + line[content_end:]
        )
        return new_line, True
    return line, False


def _try_l3_bare_verb_check(line, lang, events, line_idx):
    """L3 裸动词: 动词 + 后跟文字 + 无冒号无引号 → 发 bare_verb 事件, 不转."""
    verb_info = _find_dialogue_verb(line, lang)
    if not verb_info:
        return
    _, verb_start, verb_end = verb_info
    rest = line[verb_end:]
    if not rest or not rest.strip():
        return
    # 动词后紧跟冒号/开引号 → 已由 L1/L2 处理, 不发 L3
    stripped = rest.lstrip()
    if stripped and stripped[0] in (':', '\uff1a'):
        return
    # 开引号 → L1 处理
    if stripped:
        for open_q, _close_q in _DIALOGUE_QUOTE_PAIRS:
            if stripped.startswith(open_q):
                return
    events.append(("bare_verb", line, line_idx))


def _convert_single_line(line, *, bindings, lang, marker, events, line_idx):
    """单行转换: 行头排除 → 幂等 → 行内引号闭合检查 → L1 → L2 → L2' → L3.

    返回: 新行 (str). 事件追加到 events.

    行内引号闭合检查: 若存在任一开引号无对应闭引号, 整行不转不提示
    (批 C 方案 验收⑨ — 防 L2 误吞半截引号行).
    """
    if _is_dialogue_header_line(line):
        return line
    if _line_has_dialogue_tag(line):
        return line
    # 行内引号闭合检查 (优先于 L1/L2/L2')
    for open_q, close_q in _DIALOGUE_QUOTE_PAIRS:
        if open_q in line:
            if line.count(open_q) != line.count(close_q):
                # 有开引号无匹配闭引号 (行内未闭合) → 整行不转
                return line
            # 配对但需 L1 进一步按位置配对 (此处只过滤明显未闭合)
    new_line, ok = _try_l1_quote_conversion(
        line, bindings, lang, marker, events, line_idx)
    if ok:
        return new_line
    new_line, ok = _try_l2_colon_conversion(
        line, bindings, lang, marker, events, line_idx)
    if ok:
        return new_line
    new_line, ok = _try_l2prime_theater_conversion(
        line, bindings, lang, marker, events, line_idx)
    if ok:
        return new_line
    _try_l3_bare_verb_check(line, lang, events, line_idx)
    return line


def convert_dialogue(text, *, bindings=None, lang="zh",
                     warn_sink=None, shot_id="",
                     negative_dialogue=False):
    """对话标签自动转换 — 按方案 L1/L2/L2'/L3 + 行头排除 + 说话人词法.

    参数:
      text              — 原始文本 (按行处理; \\n 分隔)
      bindings          — 角色绑定表 [{"name": str, "no": int, ...}, ...]; None/[] = 全未绑定
      lang              — "zh" (默认) → [中文]; "en" → [English]
      warn_sink         — 可选 list; 事件追加到此 (按分镜聚合用)
      shot_id           — 分镜号 (用于事件溯源)
      negative_dialogue — D3 修复 2026-08-28: 关对白开关. True + 转换产生 <d> →
                          发 collision_d_neg 事件并入 warn_sink 黄条

    返回: (新文本, 事件列表)
      事件类型:
        ("missing_speaker", name, line_idx)   — 未绑定说话人 (路径已转, 仅缺 SN)
        ("bare_verb", line, line_idx)         — L3 裸动词疑似
        ("collision_d_neg", line_idx)         — <d> 与 negative_dialogue 同开 (D3)

    规格锚点 (批 C 节点 C-I):
      - 转换发生在名字替换前; 产出的 (SN) / <d> 标记不参与也不受名字替换影响
      - 幂等粒度=行; 行内已有 <d> → 该行跳过
      - (SN) 锚点=触发句句首 (该台词所属句子的开头)
      - L1 引号未闭合 → 不转不提示
      - L2' 仅绑定名生效 (未绑定直冒号不转不提示)
      - L3 每分镜聚合一条黄条
    """
    if not text:
        return text or "", []
    bindings = bindings or []
    # marker = "<d>[中文] " 或 "<d>[English] " — 含开标签 + 1 个空格 (分隔内容)
    lang_tag = "[English]" if lang == "en" else "[中文]"
    marker = "<d>" + lang_tag + " "
    events = []
    new_lines = []
    for line_idx, line in enumerate(text.split("\n")):
        new_line = _convert_single_line(
            line, bindings=bindings, lang=lang, marker=marker,
            events=events, line_idx=line_idx)
        new_lines.append(new_line)
        # V1.11 批 4 T3b: D3 检测扩到手写 <d> 行 — 之前按行首字面子串 (literal substring) 判定
        # 使手写 <d> × 关对白对撞漏报; 现在统一用 _line_has_dialogue_tag 正则 (匹配行内 <d> 标签),
        # 手写或 L1/L2/L2' 转换产生 + 关对白 → 报 collision_d_neg. 配合 batch_core 删 5977-5981 重复块,
        # 单一通道收口.
        if negative_dialogue and _line_has_dialogue_tag(new_line):
            events.append(("collision_d_neg", line_idx))
    new_text = "\n".join(new_lines)
    # 同步事件到 warn_sink (按分镜聚合)
    # 既有范式: bare_verb → 裸动词黄条
    # D1 修复 2026-08-28: missing_speaker → 未绑定说话人黄条 (含分镜号 + 引导绑定)
    # D3 修复 2026-08-28: collision_d_neg → <d> × 关对白 同开 (与既有 batch_core 黄条同款风格)
    if warn_sink is not None:
        prefix = ("分镜 %s " % shot_id) if shot_id else ""
        for ev in events:
            if ev[0] == "bare_verb":
                warn_sink.append(
                    "%s疑似台词, 建议动词后加冒号或引号 (例: `少女1说：…` 或 `少女1说：「…」`)" % prefix
                )
            elif ev[0] == "missing_speaker":
                _, name, _ = ev
                warn_sink.append(
                    "%s台词说话人「%s」未绑定, 已只包 <d> 未加 (SN); 建议在表单绑定该角色"
                    % (prefix, name)
                )
            elif ev[0] == "collision_d_neg":
                warn_sink.append(
                    "%s已含 <d> 台词 × 关对白开关同开 (语义对撞), "
                    "请二选一 (保留台词则取消关对白, 或保留关对白则去掉 <d> 行)" % prefix
                )
    return new_text, events


def assemble_final_prompt(
    *,
    row,
    pool=None,
    pool_usage=None,
    global_text="",
    audio_blocks=None,
    bindings=None,
    cmode=None,
    pic9_present=False,
    cast_spec=None,
    scene_nos=None,
    lang="zh",
    negative=False,
    negative_music=False,
    negative_dialogue=False,
    negative_text=False,
    warn_sink=None,
    extra_blocks=None,
    text_combined=None,
    dedup_text=None,
    shots_in_scene=None,
    current_shot_no=None,
    shot_no=None,
    cum_ms=None,
    is_fl2v=False,
    subject_anchors=None,
    slot_descs=None,
):
    """单镜最终提示词组装: 名字替换 → Subject 行过滤 → enrich → 六字段/旧 merged_prompt.

    参数:
      row            — 分镜行 dict (含 prompt 等字段; prompt 字段将做名字替换)
      pool           — 素材池 (供端点层使用; 引擎侧透传给 enrich_blocks 即可)
      pool_usage     — 池行用途标注; extra_blocks=None 时作为 enrich_blocks 输入
      global_text    — 全局提示词原文 (将做名字替换); "" 表示无
      audio_blocks   — 全局音频段: [("配乐",..), ("氛围声",..)] 任一为空则不进
      bindings       — 角色绑定表: [{"name": str, "no": int, "slots": [...]}, ...]
      cmode          — 模板族: ref2v/i2v/fl2v/t2v/None
      pic9_present   — Picture 9 是否在场 (拼接模式 + prev_frame / pool P9)
      cast_spec      — 多角色 cast_spec: [(subject_no, [(slot, usage, desc), ...]), ...]
                       非空列表 = 走六字段结构; 空/None = 旧代写句路径
      scene_nos      — 本镜在场 Subject 编号集; None = 不过滤 Subject 行
                       (旧路径透传 = 与改前逐字节一致)
      lang           — "zh" (默认) / "en" (英文路径走词库查表)
      negative       — 旧入口兼容: True = 三全勾 (negative_music/dialogue/text 均 True);
                      False = 不勾 (与三键全 False 等价, V1.4 字节锁定)。
                      当三键与 negative 同时给定时, 三键优先 (显式 > 旧默认)
      negative_music     — True = 关音乐 (zh 六字段: non_diegetic_music: N/A; zh 平铺: 末追一行)
      negative_dialogue  — True = 关对白 (zh: detailed_description 区末追加 / 平铺: 末追一句)
      negative_text      — True = 关水印字幕 (zh: detailed_description 区末追加 / 平铺: 末追一句)
      en 路径维持旧行为: 任一勾选 = 末追旧 NEGATIVE_SUFFIX_EN 整句
      warn_sink      — enrich_blocks 手写去重警告接收器 (list | None)
      extra_blocks   — 已算好的 enrich 块; 非 None 时跳过 enrich_blocks 调用
                       (引擎侧 _apply_shot_common / 端点 / gen_csv 三处共用此入口)
      text_combined  — 喂给 enrich_blocks 的拼接文本; None = 默认 g + "\\n" + row_prompt
                       (引擎 apply_shot_pool/concat 透传其 wiring 用文本)
      dedup_text     — 喂给 _filter_cast_spec_for_dedup 的文本;
                       None  → 默认 = text_combined (apply_shot_pool/concat 路径);
                       ""    → 跳过 dedup (gen_csv 路径, 原内联链不调 dedup);
                       非空  → 用此文本做 dedup (端点预览透传 global_replaced 以保留 V1.7 行为)
      shots_in_scene — 批 A 节点 2 新增: 批级每镜出场角色名列表, 1-indexed;
                       与 bindings 对照计算 retention_analysis 行内 [Shot N] 集合;
                       None = 当前镜不在场 cast_spec 全员兜底
      current_shot_no — 当前镜号 (1 起); 用于 retention 行内 appears in 集剔除当前镜号以外镜号
                       (与规格 "appears in" 集合语义保持: 含当前镜号即正确)
      shot_no        — 批 A 节点 3 (A1): 时序标记镜号; None = 不插 prefix (旧调用方兼容);
                       1 = "[Shot 1]"; >=2 = "[Shot N] At MM:SS.mmm"
      cum_ms         — 批 A 节点 3 (A1): 当前镜前累计渲染毫秒 (按帧网格累加);
                       None = 不带时间戳 (分镜模式 / 单镜预览)
      subject_anchors — 1.13f 引擎侧锚定行覆盖入口: string 多行文本 (None/空/纯空白 = 行为零变);
                       非空 (strip 后) → ref2v + cast_spec 路径下六字段 subject_definitions 段体 = 该文本;
                       其余五段照常生成; 优先级: subject_anchors > 全局手写锚定(dedup) > 自动注入。
      slot_descs   — #83: 段级槽的场景文字摘要表 {kind: {slot: desc}} (合并层 _merge_seg_pools_entry 带出);
                       单视频段 (video_ref 槽数=1) 且 desc 非空 → 复刻句的"替换目标"引用该 desc;
                       空/缺省 → 复刻句与 #76 现状逐字一致 (回落锁死·不省略不添句)。

    返回: 最终发送文本 str
      - ref2v + cast_spec 非空 → 六字段结构
      - 其它 → 旧 merged_prompt 路径 (逐字节与批 A 节点 1 一致)
      - shot_no != None → 在文本最前插 [Shot N] / [Shot N] At MM:SS.mmm
    """
    # ----- 0) 对话标签自动转换 (批 C 节点 C-I, 名字替换前)
    # 转换发生在名字替换前: row.get("prompt") 原文 + global_text 原文各过一遍.
    # 此时卡名尚未替换 (少女1 原形在场), 说话人识别用原始卡名查 bindings.
    # 转换产出的 (S N) / <d> 标记不参与也不受后续名字替换影响;
    # 下游六字段/旧路径/text_combined 全部自动同源, 无分裂.
    # 角色绑定 JSON 行不在此路径 (独立解析, 不进被转换文本 — 批 C 方案 二轮核实).
    _dialogue_warn_sink = warn_sink if isinstance(warn_sink, list) else None
    if isinstance(row, dict):
        _row_raw_prompt = row.get("prompt") or ""
    else:
        _row_raw_prompt = row or ""
    if _row_raw_prompt:
        _row_raw_prompt, _row_dialogue_events = convert_dialogue(
            _row_raw_prompt, bindings=bindings, lang=lang,
            warn_sink=_dialogue_warn_sink,
            shot_id=str(shot_no) if shot_no is not None else "",
            negative_dialogue=bool(negative_dialogue))
    else:
        _row_dialogue_events = []
    _g_raw = global_text or ""
    if _g_raw:
        _g_raw, _g_dialogue_events = convert_dialogue(
            _g_raw, bindings=bindings, lang=lang,
            warn_sink=_dialogue_warn_sink,
            shot_id=str(shot_no) if shot_no is not None else "",
            negative_dialogue=bool(negative_dialogue))
    else:
        _g_dialogue_events = []
    # 记录事件供后续 batch_core 预检黄条消费 (D1 missing_speaker / D3 collision_d_neg)
    _dialogue_events = list(_row_dialogue_events) + list(_g_dialogue_events)

    # ----- 1) 名字替换 (绑定表卡名 → "Subject N") -----
    row_prompt = _row_raw_prompt
    if bindings and row_prompt:
        row_prompt = _bc.replace_cast_names(row_prompt, bindings)
    g = _g_raw
    if bindings and g:
        g = _bc.replace_cast_names(g, bindings)

    # ----- 2) 逐镜 Subject 行过滤 (per_shot_plan 提供的 scene_nos 非 None 时执行) -----
    if scene_nos is not None:
        g = _bc._filter_global_subject_lines(g, scene_nos)

    # ----- 3) 拼接文本 (默认 = g + "\n" + row_prompt) -----
    if text_combined is None:
        text_combined = g + "\n" + row_prompt

    # ----- 4) enrich_blocks (extra_blocks 预计算时跳过) -----
    # 批 A 节点 2 修正: cast_spec=[] (空 list) 与 cast_spec=None 同义 → 走 legacy 路径
    # (前者表示 "本镜无绑定", 与 cast_spec="初始 [(1,...)] 经 dedup 后变 []" 不同)
    # cast_spec="[(1,...)]" → 防双份 dedup → 可能变 [], 经 enrich_blocks 透传保留语义
    cs_for_enrich = None  # 喂给 enrich_blocks 的 cast_spec (dedup 后)
    cs_for_six_field = cast_spec  # 喂给 _assemble_six_field 的 cast_spec (dedup 后)
    # 1.13f: subject_anchors 非空时, 豁免 dedup (单点: cs_for_six_field = cast_spec 原值);
    # cs_for_enrich 与 enrich_blocks(...) 仍走 dedup 后值 (防双份不豁免).
    _sa_override = bool(subject_anchors) and bool((subject_anchors or "").strip())
    if extra_blocks is None:
        if cast_spec:
            # 防双份: dedup_text 默认 = text_combined (与 apply_shot_pool/concat 同口径)
            cs_for_enrich = _bc._filter_cast_spec_for_dedup(
                cast_spec, dedup_text if dedup_text is not None else text_combined)
            # 豁免点 (单点): subject_anchors 非空 → cs_for_six_field = cast_spec 原值
            # 跳过 dedup — 保证六字段路径可达, summary/retention 按全 cast 生成
            if _sa_override:
                cs_for_six_field = cast_spec
            else:
                cs_for_six_field = cs_for_enrich
            extra_blocks = _bc.enrich_blocks(
                pool_usage or {}, text_combined, cmode, pic9_present,
                lang=lang, warns=warn_sink, cast_spec=cs_for_enrich)
        else:
            extra_blocks = _bc.enrich_blocks(
                pool_usage or {}, text_combined, cmode, pic9_present,
                lang=lang, warns=warn_sink, cast_spec=None)

    # ----- 5) row_for_plan (prompt 字段写回替换后的文本) -----
    if isinstance(row, dict):
        row_for_plan = dict(row)
    else:
        row_for_plan = {"prompt": row_prompt}
    row_for_plan["prompt"] = row_prompt

    # ----- 6) 触发矩阵分流 -----
    # 批 A 节点 2 修复: 加 lang=="zh" 门
    # ref2v + cast_spec 非空 + lang=zh → 六字段结构
    # en 场景 (绑定 / 纯池) 全走旧 merged_prompt 路径, 行为 = 批 A 节点 1 基线逐字节
    # 批 A 后小迭代: 三勾选优先于旧 negative 兼容映射 (显式 > 旧默认)
    # - 三键已显式传 (任何键是 True) → 三键生效, 旧 negative 不参与
    # - 三键全 False 且旧 negative=True → 旧入口映射, 三键全 True
    # - 三键全 False 且旧 negative=False → 三键全 False (字节锁定 V1.4)
    neg_music = bool(negative_music)
    neg_dialogue = bool(negative_dialogue)
    neg_text = bool(negative_text)
    # 旧入口兼容: 三键全 False 且旧 negative=True → 三键全 True
    if negative and not neg_music and not neg_dialogue and not neg_text:
        neg_music = neg_dialogue = neg_text = True
    use_six_field = (cmode == "ref2v" and bool(cs_for_six_field) and lang == "zh")
    if use_six_field:
        body = _assemble_six_field(
            row_for_plan=row_for_plan,
            global_text=g,
            extra_blocks=extra_blocks,
            audio_blocks=audio_blocks,
            cast_spec=cs_for_six_field,
            pool_usage=pool_usage or {},
            bindings=bindings or [],
            shots_in_scene=shots_in_scene,
            current_shot_no=current_shot_no,
            lang=lang,
            negative_music=neg_music,
            negative_dialogue=neg_dialogue,
            negative_text=neg_text,
            warn_sink=warn_sink,
            subject_anchors=subject_anchors,
            # #83: 段级槽摘要 → 复刻句替换目标 (空 → 与 #76 现状逐字一致)
            video_ref_desc=_video_ref_desc_of(slot_descs, pool_usage),
        )
    else:
        # 旧路径 — 逐字节锁定 (节点 1 收口基线)
        # 批 A 后小迭代: zh 平铺 / en 路径 — merged_prompt 接三键
        # #83 平铺路径补全: 段级槽 desc 同样作复刻句的"替换目标" (措辞与六字段路径
        #   同一改写函数 _apply_video_ref_desc → 逐字一致; desc 空 → 原句逐字保留)。
        _flat_blocks = _apply_flat_video_ref_desc(extra_blocks, slot_descs)
        body = _bc.merged_prompt(
            row_for_plan, g, lang, _flat_blocks or None,
            negative=negative, audio_blocks=audio_blocks, warn_sink=warn_sink,
            negative_music=neg_music,
            negative_dialogue=neg_dialogue,
            negative_text=neg_text)
    # 批 A 节点 3 (A1): [Shot N] 时序标记前插 — 通用, 六字段路径与旧平铺路径都生效
    if shot_no is not None:
        body = _format_shot_prefix(shot_no, cum_ms) + body
    # 批 C 节点 C-II part-2 (C3): fl2v 拼接每镜前置对齐句 — 在 [Shot N] 前缀之后
    # 再前置 (最终结构: 第一行对齐句 / 第二行空行 / 第三行 [Shot N] / 正文)
    if is_fl2v:
        body = _format_fl2v_alignment(row, shot_no) + "\n\n" + body
    return body


# ===== 批 C 节点 C-II part-2 (C3): fl2v 首行对齐句 =====

_FL2V_ALIGNMENT_TEMPLATE = (
    "How the reference pictures align with the target video — "
    "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; "
    "Picture 2 (from Shot %d) aligns with the %s-second mark of the target video."
)


def _format_fl2v_alignment(row, shot_no):
    """生成 fl2v 拼接每镜首行的对齐句 (批 C 节点 C-II part-2).

    参数:
      row     — 分镜行 dict (取 '段落时长' 字段, 留空/非法 → 5.0 默认, 与 _row_duration_frames 同口径)
      shot_no — 本镜镜号 (Picture 2 from Shot N); shot_no 为 None 时按 1 处理 (防退化)

    返回: 对齐句 str (不含前后换行)
    """
    n = int(shot_no) if shot_no is not None else 1
    dur_raw = ""
    if isinstance(row, dict):
        dur_raw = row.get("段落时长")
    if dur_raw is None:
        sec = 5.0
    else:
        s = str(dur_raw).strip()
        if not s:
            sec = 5.0
        else:
            try:
                sec = float(s)
            except ValueError:
                sec = 5.0
    return _FL2V_ALIGNMENT_TEMPLATE % (n, "%.2f" % sec)


def cast_blocks(cast_spec, lang="zh"):
    """单角色 / 多角色块生成 — 与 batch_core.cast_blocks 同源 (H3 交替式, 批 A 节点 2).

    供前端 /h3_batch/cast_block 端点对拍用 (subject_no = no, 与引擎对拍逐字相等).
    本模块 re-export 是为让 __init__.py 不再直接调 batch_core.cast_blocks.
    """
    return _bc.cast_blocks(cast_spec, lang=lang)


def prepare_global(global_text, bindings=None, scene_nos=None, warn_sink=None):
    """计算 global_text 经名字替换 + Subject 行过滤后的等价文本.

    供端点预览等需要把 "global_replaced" 传给 check_prompt_rules / dedup_text 的调用方
    使用: 本函数在 prompt_assembler 模块内, 内部调 _filter_global_subject_lines,
    __init__.py 不直接调该函数 (避免触发 grep 引擎模块外调用检查).

    参数:
      global_text — 原始全局文本
      bindings    — 角色绑定表 (用于名字替换); None/[] 时跳过
      scene_nos   — 本镜在场 Subject 编号集; None 时跳过 Subject 行过滤
      warn_sink   — 批 A 节点 4 (4a): 空集镜兜底反转黄条入此通道 (与 audio_warns 同源)

    返回: 处理后的 global_text str
    """
    g = global_text or ""
    if bindings and g:
        g = _bc.replace_cast_names(g, bindings)
    if scene_nos is not None:
        g = _bc._filter_global_subject_lines(g, scene_nos, warn_sink=warn_sink)
    return g


def prepare_row(row, bindings=None):
    """计算 row 经名字替换后的 row_for_plan dict (深浅拷贝, prompt 字段替换).

    供端点预览等需要把 "row_for_plan" 传给 check_prompt_rules 的调用方使用.
    本函数在 prompt_assembler 模块内, 内部调 replace_cast_names (不在 grep 名单内,
    可选直接 import; 但封装成 helper 后 grep 检查结果更整洁).

    参数:
      row       — 原始分镜行 dict
      bindings  — 角色绑定表 (用于名字替换); None/[] 时返回原 row 的浅拷贝

    返回: row_for_plan dict (与原 row 同结构, 仅 prompt 字段被替换)
    """
    if not isinstance(row, dict):
        return {"prompt": ""}
    if bindings:
        row_for_plan = dict(row)
        row_for_plan["prompt"] = _bc.replace_cast_names(row.get("prompt") or "", bindings)
        return row_for_plan
    return dict(row)


# ===== 批 A 节点 3 (A1): [Shot N] 时序标记 =====

def _format_shot_prefix(shot_no, cum_ms):
    """生成 [Shot N] / [Shot N] At MM:SS.mmm 前缀串 (末尾含 \\n 与正文分隔)。

    规格:
      - shot_no=1 (或 cum_ms=None) → "[Shot 1]\\n" 无时间戳
      - shot_no>=2 且 cum_ms 给定 → "[Shot N] At MM:SS.mmm\\n" 三位毫秒, 0 填充
      - cum_ms=0 (极少首镜跨边界, 0ms 即紧接着第一段) → 也按无时间戳形态输出
        (避免 [Shot 2] At 00:00.000 的语义混淆: 仍视为第二镜但与首镜无缝衔接)
        实测锚点: 124 帧 / 24fps = 5.16666s ≈ 5167ms → "00:05.167"

    帧网格公式 (与 _inject_h3_length_for_no_va 同源):
      f = max(5, round(sec*24)) + (5 - f%17) % 17
      cum_ms = sum(前段 frames) / 24 * 1000 → round
    """
    if shot_no is None:
        return ""
    if cum_ms is None or cum_ms <= 0:
        # 首镜 / 分镜模式 / 0 累加 → 无时间戳
        return "[Shot %d]\n" % int(shot_no)
    # cum_ms → MM:SS.mmm
    total_ms = int(round(cum_ms))
    millis = total_ms % 1000
    total_s = total_ms // 1000
    seconds = total_s % 60
    minutes = total_s // 60
    return "[Shot %d] At %02d:%02d.%03d\n" % (int(shot_no), minutes, seconds, millis)


# ===== 批 A 节点 2: 六字段结构组装 (仅 cmode=ref2v 且 cast_spec 非空时激活) =====

def _assemble_six_field(
    *, row_for_plan, global_text, extra_blocks, audio_blocks,
    cast_spec, pool_usage, bindings, shots_in_scene,
    current_shot_no, lang, negative=False,
    negative_music=False, negative_dialogue=False, negative_text=False,
    warn_sink=None,
    subject_anchors=None,
    video_ref_desc="",
):
    """六字段结构组装: 6 段标签头 + 字段体, 段间 \\n\\n 分隔, 末段后无尾随空段。

    输出形如:
      subject_definitions:
      <Subject 1>: ...
      <Subject 2>: ...

      summary:
      [reference generation] 目标视频展示 <Subject 1> 与 <Subject 2> 在指定场景中的活动。

      retention_analysis:
      <Subject 1> 容貌: fully_preserved (appears in [Shot 1], [Shot 2])
      场景: attribute_transfer (appears in [Shot 1])

      detailed_description:
      <画面文本>

      overall_soundscape:
      <sound>

      non_diegetic_music:
      <music>
    负面句三拆注入 (批 A 后小迭代):
      - 关音乐 → non_diegetic_music 字段值置 N/A (覆盖行级/全局 配乐, 配乐冲突时入 warn_sink)
      - 关对白 → detailed_description 区末追加 "人物全程不张嘴、不说话，无旁白。"
      - 关水印字幕 → detailed_description 区末追加 "无字幕，无文字水印。"
    en 路径走 _append_negative_en (旧 negative=True 兼容整句末追)。
    """
    # ---- subject_definitions ----
    # 1.13f: subject_anchors 非空 (strip 后) → 段体=用户文本覆盖, 跳过自动生成
    _sa_stripped = (subject_anchors or "").strip() if subject_anchors else ""
    subj_lines = _build_subject_lines(cast_spec, pool_usage, lang=lang,
                                      video_ref_desc=video_ref_desc)
    subj_body = "\n".join(subj_lines) if subj_lines else ""
    if _sa_stripped:
        subj_body = _sa_stripped

    # ---- summary ----
    summary_text = _build_summary_text(cast_spec, pool_usage=pool_usage or {},
                                       video_ref_desc=video_ref_desc)

    # ---- retention_analysis ----
    ret_lines = _build_retention_lines(
        cast_spec, pool_usage, bindings,
        shots_in_scene, lang=lang)
    ret_body = "\n".join(ret_lines) if ret_lines else ""

    # ---- detailed_description ----
    # 批 A 节点 2 修复: scene / video_motion 代写句并入 detailed_description 区;
    # look / outfit / prop / pose 由 H3 主体行承载, 重复出现即过滤;
    # audio_ref 由 audio_ref 句承载并保留 (参考音频不进 audio_blocks — 后者只来自
    # 全局配乐/氛围声行, 不承载参考音频);
    # first_frame 锚定句属于拼接模式专属, 六字段路径不消费, 丢弃。
    detailed_text = _bc.assemble_prompt(row_for_plan, lang=lang)
    # 1.14 追加批 T4 (+ T4-fix): 全局提示词并入 detailed_description (与平铺路径
    # text_combined = g + "\n" + row_prompt 同口径 — 全局在前, 单 "\n" 拼接).
    # T4-fix: 并入前对 global_text 过同款过滤链 (replace_cast_names +
    # _filter_global_subject_lines), 与平铺路径调用形态同款.
    #
    # 幂等性结论: 不严格幂等. outer scene_nos (cast_plan cast_spec 派生, pre-dedup)
    # 与 inner scene_nos (cast_spec post-dedup 派生) 在 dedup 实际剔除某 Subject
    # 时不同 — 此差异是 dedup 在 global_text 侧的正确延伸 (A7 preview 测试断言
    # global 含 `<Subject N>:` 时该 Subject 不在 detailed_description 重复, 由
    # post-dedup cast_spec 的 inner scene_nos 实现过滤). 主代理裁允许此路径,
    # 要求: 仅在 global_text 实际含 Subject 行时才执行过滤链 (非 Subject 行文本
    # 走幂等路径, 与平铺同构, 旧契约零变化).
    _subject_line_re = getattr(_bc, "_SUBJECT_LINE_RE", None)
    _filtered_global = global_text or ""
    if _filtered_global and bindings:
        _filtered_global = _bc.replace_cast_names(_filtered_global, bindings)
    if _filtered_global and _subject_line_re is not None \
            and _subject_line_re.search(_filtered_global):
        # inner scene_nos 取自 cast_spec (post-dedup, 由外层 cs_for_six_field 注入)
        _inner_scene_nos = {no for no, _ in (cast_spec or [])
                            if isinstance(no, int)}
        if _inner_scene_nos:
            _filtered_global = _bc._filter_global_subject_lines(
                _filtered_global, _inner_scene_nos)
    if _filtered_global and detailed_text:
        detailed_text = _filtered_global + "\n" + detailed_text
    elif _filtered_global:
        detailed_text = _filtered_global
    scene_blocks = _filter_scene_video_motion_blocks(extra_blocks, lang=lang,
                                                      video_ref_desc=video_ref_desc)
    if scene_blocks:
        # 批 A 节点 3 (A4) 修复 (R1): 段间用 "\n\n" 与 shot_vocab 段间隔一致
        # (此前用 "\n" 单换行, _extract_row_level_audio 找不到段终止边界,
        #  把后续 scene / video 代写句吞入音频字段值)
        joined = "\n\n".join(scene_blocks)
        if detailed_text:
            detailed_text = detailed_text + "\n\n" + joined
        else:
            detailed_text = joined

    # 批 A 节点 3 (A4) 补丁: 行级 overall_soundscape: / non_diegetic_music: 段剥离
    # shot_vocab 行编译会在画面文本后拼接行级音频段（overall_soundscape/non_diegetic_music）;
    # 旧平铺路径下 (merged_prompt) 由 _merge_global_audio_into_official_fields 做单字段去重,
    # 但六字段结构末尾自带同名官方字段, 直接拼接会产生两段重复标签头。
    # 修复: 从 detailed_text 提取行级音频值, 剥离其段, 再合并行级 + 全局 (行级优先)。
    # R1 边界修复: 段终止按 "\n\n" 段落边界取界, 不再以"文本末尾"或"下一标签头"为界,
    # 防止尾随 scene / video 代写句被吞入音频字段值。
    detailed_text, row_sound, row_music = _extract_row_level_audio(detailed_text)

    # ---- overall_soundscape / non_diegetic_music ----
    # 行级值与全局 audio_blocks 一并送入既有合并函数; 行级优先 + 全局兜底, 冲突场景保留黄条
    sound_text, music_text = _merge_six_field_audio(
        row_sound=row_sound, row_music=row_music,
        audio_blocks=audio_blocks, warn_sink=warn_sink)
    # 批 A 后小迭代: 关音乐优先 — 强制 music_text = N/A (覆盖行级/全局 配乐)
    if negative_music:
        music_text = _NEG_MUSIC_VALUE_ZH

    # ---- 组装 ----
    parts = []
    parts.append("subject_definitions:\n" + subj_body if subj_body else "subject_definitions:")
    parts.append("summary:\n" + summary_text if summary_text else "summary:")
    parts.append("retention_analysis:\n" + ret_body if ret_body else "retention_analysis:")
    parts.append("detailed_description:\n" + detailed_text if detailed_text else "detailed_description:")
    parts.append("overall_soundscape:\n" + sound_text if sound_text else "overall_soundscape:")
    parts.append("non_diegetic_music:\n" + music_text if music_text else "non_diegetic_music:")

    base = "\n\n".join(parts)

    # ---- 批 A 后小迭代: 三勾选六字段路径 ----
    # 1) 关音乐 + 全局 audio_blocks 含 配乐 → 黄条 [音频冲突] / [负面选项]
    #    (勾选优先: music_text 已被关音乐=N/A 覆盖; 此处只入黄条不改变字段值)
    #    检测范围: 仅全局 audio_blocks 内的 配乐 (music_text 由行级/全局合并而来, 行级来源
    #    已在 _merge_six_field_audio 阶段触发了既有黄条, 不重复)
    if negative_music and audio_blocks:
        has_global_music = False
        neg_variants = getattr(_bc, "_AUDIO_NEG_VARIANTS", frozenset())
        for kv in audio_blocks:
            if isinstance(kv, (list, tuple)) and len(kv) == 2 and kv[0] in ("配乐", "音乐", "music", "Music"):
                v = kv[1]
                if isinstance(v, str) and v.strip() and v.strip() not in neg_variants:
                    has_global_music = True
                    break
        if has_global_music and warn_sink is not None:
            warn_sink.append(
                "[音频冲突][负面选项] 关音乐已勾选, 全局配乐描述被忽略"
            )

    # 2) 关对白 / 关水印字幕 → detailed_description 区末追加 (在六字段结构内)
    #    实现: 把这两句 join 到 base 内 detailed_description 段的体末尾
    if negative_dialogue or negative_text:
        extras = []
        if negative_dialogue:
            extras.append(_NEG_DIALOGUE_ZH)
        if negative_text:
            extras.append(_NEG_TEXT_ZH)
        base = _append_to_detailed_description(base, "\n".join(extras))

    # 3) en 路径: 旧 negative=True 兼容 → 整句; (本函数仅 zh 路径, 但保留兼容入口以防回归)
    if negative and lang == "en":
        base = _append_negative_en(base, global_text)

    return base


def _video_ref_desc_of(slot_descs, pool_usage):
    """#83: 单视频段 (video_ref 槽数=1) 的场景文字摘要 (复刻句的替换目标)。

    slot_descs = {kind: {slot: desc}} (合并层 _merge_seg_pools_entry 带出);
    非单视频段 / 无 desc / 缺省 → "" (复刻句回落 #76 现状逐字)。
    """
    if not slot_descs or not isinstance(slot_descs, dict):
        return ""
    slots = _bc.video_ref_slots(pool_usage)
    if len(slots) != 1:
        return ""
    desc = ((slot_descs.get("Video") or {}).get(slots[0]))
    return desc if isinstance(desc, str) else ""


# #83: 复刻句 (zh) 的"替换目标"分句 —— desc 非空时改写为具体替换目标。
#   分句取自 USAGE_REGISTRY["video_ref"]["zh"] 句尾 (模板改动须同改此处);
#   desc 空 → 不改写 (原句逐字保留, 回落锁死)。
_VIDEO_REF_TARGET_ZH = "源片人物形象与场景环境替换为本段提示词所描述的内容"
_VIDEO_REF_TARGET_ZH_DESC = "源片人物形象与场景环境替换为：%s"


def _check_video_ref_target_lock():
    """#42 W3 硬耦合守卫: 句模板须含替换目标子串, 否则 desc 改写静默降级 → 显式红。"""
    tpl = (_bc.USAGE_REGISTRY.get("video_ref") or {}).get("zh") or ""
    if _VIDEO_REF_TARGET_ZH not in tpl:
        raise ValueError(
            "USAGE_REGISTRY['video_ref']['zh'] 缺少 _VIDEO_REF_TARGET_ZH 子串 %r, 实得 %r"
            % (_VIDEO_REF_TARGET_ZH, tpl))


_check_video_ref_target_lock()


def _apply_video_ref_desc(sentence, desc):
    """复刻句替换目标分句改写 (desc 空 → 原句逐字返回)。"""
    if not desc:
        return sentence
    if _VIDEO_REF_TARGET_ZH in sentence:
        return sentence.replace(_VIDEO_REF_TARGET_ZH, _VIDEO_REF_TARGET_ZH_DESC % desc)
    return sentence


def _apply_flat_video_ref_desc(blocks, slot_descs):
    """平铺路径 (无 Subject/cast_spec): 复刻句的"替换目标"分句改写为该视频槽的段级 desc。

    平铺路径无六字段结构 → 复刻句只出现在 extra_blocks (由 USAGE_REGISTRY["video_ref"]["zh"]
    模板产的单视频段形态); 多视频段走 legacy 旧句 (无该句尾) → 逐字不动。
    槽号取自复刻句自身的 <Video N>; desc 取 slot_descs["Video"][N];
    desc 空/缺 → 原句逐字保留 (回落锁死)。
    """
    if not blocks or not slot_descs:
        return blocks
    videos = slot_descs.get("Video") or {}
    if not videos:
        return blocks
    tpl = (_bc.USAGE_REGISTRY.get("video_ref") or {}).get("zh") or ""
    if not tpl:
        return blocks
    # 单视频段复刻句模板 → 捕获槽号 (与 _filter_scene_video_motion_blocks 同款模板派生)
    pat = "^" + _re.escape(tpl).replace(_re.escape("{N}"), r"(\d+)") + "$"
    out = []
    for b in blocks:
        if isinstance(b, str):
            m = _re.match(pat, b.strip())
            if m:
                desc = videos.get(int(m.group(1)))
                if isinstance(desc, str):
                    b = _apply_video_ref_desc(b, desc)
        out.append(b)
    return out


def _build_subject_lines(cast_spec, pool_usage, lang="zh", video_ref_desc=""):
    """Subject 行 — 每角色一行, H3 交替式 (含 cast_spec 中卡行 + pool 中 pose 槽)。

    pose 从 pool_usage 收齐, 每个 pose 槽对**每个 Subject** 追加一段 (pose 是场景级语义)。
    卡行 (look/outfit/prop) 来自 cast_spec (按卡内行序, 同 usage 多槽按 slot 升序)。
    video_ref_desc (#83): 单视频段源声明行追加替换目标 (空 → 与 #76 现状逐字一致)。
    """
    # 1) 收集 pool pose 槽
    pose_segments = []  # [(slot, ""), ...]
    picture = (pool_usage or {}).get("Picture") or {}
    for slot, uids in sorted(picture.items(), key=lambda kv: kv[0]):
        if not isinstance(slot, int):
            continue
        if isinstance(uids, list) and "pose" in uids:
            pose_segments.append((slot, ""))
        elif isinstance(uids, list) and "pose" in [u for u in uids if isinstance(u, str)]:
            pose_segments.append((slot, ""))

    # 2) 每角色行
    out_lines = []
    # #76 方案 §三.5: 单视频段 → 源视频声明行 (行序 = 插在 Subject 行之前);
    # 通用形 (不含源内容描述 — 引擎无源内容输入); 多视频段不触发 (锁现状)
    _video_ref_slots = _bc.video_ref_slots(pool_usage)
    if len(_video_ref_slots) == 1:
        _src_line = ("<Video %d> is the source video to recast; its on-screen "
                     "figures are not Subjects and must not appear in the output."
                     % _video_ref_slots[0])
        if video_ref_desc:
            _src_line += " Replace the figures and the environment with: " + video_ref_desc
        out_lines.append(_src_line)
    for subject_no, rows in (cast_spec or []):
        merged_rows = list(rows or []) + [(s, "pose", d, "") for (s, d) in pose_segments]
        line = _bc._build_h3_subject_line(subject_no, merged_rows, lang=lang)
        if line is not None:
            out_lines.append(line)
    return out_lines


# summary 用途前缀字典 (批 B 节点 B-II: 对齐官方 [face swap] / [environment reference] 式)
# 多个 prefix 用 " + " 连接, 整体在一个 [...] 内 (与官方示例
# [video editing + audio reference] 同形 — 见 1.8提示词.md L87)
# 判定顺序: 收集 cast_spec + pool_usage 中存在的用途, 命中即追加 prefix
_SUMMARY_PREFIX_TABLE = (
    # (predicate_fn, prefix 片段, 不含方括号) — 按列表顺序检测, 多个命中则 " + " 串联
    # character (容貌 / 服装 / 道具 / 姿势 / 三视图) → 角色参考
    # 1.11c 波2-T4: 三视图入角色参考判定 — 三视图是另一类外貌参照
    (lambda usages: any(u in usages for u in (
        "subject_look", "subject_outfit", "subject_prop", "pose", "三视图"
    )), "character reference"),
    # scene → 环境参考
    (lambda usages: "scene" in usages, "environment reference"),
    # #76: video_motion 前缀条目删除 — predicate 键名 video_motion 恒不在 usages 集里
    # (usages 只收注册表 ID video_ref), 原为死代码; 单视频段的复刻整句改由
    # _build_summary_text 内 video_ref 分支产出 (需 Video 槽号, 前缀表拿不到)
)
_SUMMARY_DEFAULT_PREFIX = "reference generation"


def _infer_summary_usages(cast_spec, pool_usage):
    """汇总 cast_spec + pool_usage 中存在的用途集合 (用于 prefix 推断).

    返回: frozenset[str] — 用途集 (含 subject_look / outfit / prop / pose / scene / video_motion)
    """
    usages = set()
    if cast_spec:
        for _, rows in cast_spec:
            for row in (rows or []):
                slot, usage, desc = row[0], row[1], row[2]
                if isinstance(usage, str):
                    usages.add(usage)
    picture = (pool_usage or {}).get("Picture") or {}
    for uids in picture.values():
        if isinstance(uids, list):
            for u in uids:
                if isinstance(u, str):
                    usages.add(u)
    video_pu = (pool_usage or {}).get("Video") or {}
    for uids in video_pu.values():
        if isinstance(uids, list):
            for u in uids:
                if isinstance(u, str):
                    usages.add(u)
    return frozenset(usages)


def _build_summary_prefix(usages):
    """按用途集生成 summary 前缀. 多 prefix 用 " + " 串联, 整体外加方括号 (官方式).

    命中表为空 → 兜底 _SUMMARY_DEFAULT_PREFIX.
    返回形如: "[character reference]" / "[environment reference]" /
              "[character reference + environment reference]" /
              兜底 fallback: "[reference generation]".
    """
    parts = []
    for predicate, label in _SUMMARY_PREFIX_TABLE:
        try:
            if predicate(usages):
                parts.append(label)
        except Exception:
            continue
    if not parts:
        return "[%s]" % _SUMMARY_DEFAULT_PREFIX
    return "[%s]" % " + ".join(parts)


def _build_summary_text(cast_spec, pool_usage=None, video_ref_desc=""):
    """summary 模板: 用途前缀 (按 cast_spec + pool_usage 推断) + 主体列表 + 单一句式。

    批 B 节点 B-II 改造 (对齐官方 [face swap] / [environment reference] / [video editing + audio reference] 式):
      - 前缀由用途推断 (字典化: 详见 _SUMMARY_PREFIX_TABLE)
      - 主体列表按绑定表顺序展开, 单/双/三+ 主体三档 (旧规格保留)
      - 中文句式单模板: "<prefix> 目标视频展示 <S1, S2 与 S3> 在指定场景中的活动。"

    video_ref_desc (#83): 单视频段复刻整句的替换目标 = 该 desc (空 → 与 #76 现状逐字一致)。

    cast_spec 为空 → 返回 "" (兜底, 防御性)
    """
    subj_list = [s for s, _ in (cast_spec or []) if isinstance(s, int)]
    if not subj_list:
        return ""
    # #76 方案 §三.4: video_ref 单视频段 → 复刻整句 (取代 prefix + 主体句式);
    # 多视频段 (槽数>=2) 不触发 → 维持现状 prefix 句式 (锁现状)
    _video_ref_slots = _bc.video_ref_slots(pool_usage)
    if len(_video_ref_slots) == 1:
        if video_ref_desc:
            return ("[video editing] Recast <Video %d>: keep subject motion and timing exactly "
                    "(on-screen figures and scenery are replaced per this shot's prompt), "
                    "only replace the figures and the environment with: %s"
                    % (_video_ref_slots[0], video_ref_desc))
        return ("[video editing] Recast <Video %d>: keep subject motion and timing exactly "
                "(on-screen figures and scenery are replaced per this shot's prompt), "
                "only replace the figures and the environment as described"
                % _video_ref_slots[0])
    if len(subj_list) == 1:
        joined = "<Subject %d>" % subj_list[0]
    elif len(subj_list) == 2:
        joined = "<Subject %d> 与 <Subject %d>" % (subj_list[0], subj_list[1])
    else:
        head = "、".join("<Subject %d>" % n for n in subj_list[:-1])
        joined = "%s 与 <Subject %d>" % (head, subj_list[-1])
    usages = _infer_summary_usages(cast_spec, pool_usage)
    prefix = _build_summary_prefix(usages)
    return "%s 目标视频展示 %s 在指定场景中的活动。" % (prefix, joined)


def _infer_outfit_level(desc):
    """outfit 用途保留级别推断 (批 B 节点 B-II, 确定性规则).

    规格:
      - desc 为空 / None       → fully_preserved (默认级, 纯池用途无档案卡场景)
      - desc 含弱化词表 (参考/近似/类似/风格) → partially_preserved
      - desc 非空且无弱化词    → fully_preserved
    """
    if not desc or not desc.strip():
        return "fully_preserved"
    if any(w in desc for w in _OUTFIT_WEAK_WORDS):
        return "partially_preserved"
    return "fully_preserved"


def _build_retention_lines(
    cast_spec, pool_usage, bindings, shots_in_scene, lang="zh",
):
    """retention_analysis 行 — 硬约束: 行内禁止任何 <Picture N> 引用。

    批 B 节点 B-II 智能推断 (确定性规则, 详见 _RETENTION_LEVEL 字典 + _infer_outfit_level):
      Subject 侧属性行: <Subject N> 容貌/服装/道具/姿势: <level> (appears in [Shot ...])
        - subject_look  → 容貌 fully_preserved
        - subject_outfit → 服装 fully_preserved / partially_preserved (desc 含弱化词)
                            默认级 = fully_preserved (无 desc 时)
        - subject_prop  → 道具 attribute_transfer
        - pose          → 姿势 fully_preserved
      无前缀属性行:
        - scene        → 场景 weak_reference (推断值, 销账旧挂账注释)
        - video_motion → 单视频段 <Video N>: fully_preserved (复刻形态, #76) /
                         多视频段 动作 weak_reference (锁现状)
    appears in 镜头集合: 优先用 CSV 出场角色列含该卡名的行号 (1 起);
                       列缺失/为空时兜底 = 全批全部分镜行号 (从 shots_in_scene 推断)。
    集合为该角色全出场镜头 (含当前镜号, 全集口径——规格锚 test_six_field_skeleton)。
    多 Picture 引用 (B1 放宽后) 走 seen_attrs 去重 + 属性名区分, 行内禁 <Picture N> 标签。
    en 路径本节点先保持旧行为不动 (节点 3 接手) — 直接空 return。
    """
    if lang != "zh":
        return []  # en 路径留后批, 本节点不动
    if not cast_spec:
        return []

    # ---- 索引建立 ----
    # card_name_by_subject_no: subject_no -> bindings[].name
    card_name_by_no = {}
    for b in (bindings or []):
        if isinstance(b, dict) and isinstance(b.get("no"), int) and isinstance(b.get("name"), str):
            card_name_by_no[b["no"]] = b["name"]

    # shots_in_scene 兜底: 全部镜 (1-indexed)
    total_shots = len(shots_in_scene) if shots_in_scene else 0
    fallback_indices = list(range(1, total_shots + 1))

    def _shots_for(name):
        if not name or not shots_in_scene:
            return list(fallback_indices)
        out = []
        for i, names in enumerate(shots_in_scene, start=1):
            if isinstance(names, (list, tuple)) and name in names:
                out.append(i)
        return out

    def _format_shots(shot_nums):
        return ", ".join("[Shot %d]" % n for n in shot_nums)

    # ---- 每角色行 ----
    out_lines = []
    picture = (pool_usage or {}).get("Picture") or {}

    # 收集 cast_spec 中每角色的 subject_look/outfit/prop slot 与 desc
    # 以及 pool 中该 subject 共享的 pose slot (当前: 全 subject 共享, 见 _build_subject_lines)
    pose_slots = sorted(s for s, uids in picture.items()
                        if isinstance(s, int) and isinstance(uids, list) and "pose" in uids)

    for subject_no, rows in (cast_spec or []):
        card_name = card_name_by_no.get(subject_no)
        shot_nums = _shots_for(card_name)
        if not shot_nums:
            # 在场集合空 → 兜底全部行号 (列缺失/空: 卡名未在 CSV 命中任何行)
            # 若 shots_in_scene 本身为空 (列整体缺失) → fallback 也空, 跳过
            shot_nums = list(fallback_indices)
            if not shot_nums:
                continue
        shots_str = _format_shots(shot_nums)
        # 卡行的 subject_look/outfit/prop/三视图 (按 cast_spec 卡内行序, 一行一段)
        # 1.11c 波2-T4: 三视图入三元组过滤 — 与 subject_look/outfit/prop 并列产生 retention 行
        seen_attrs = set()
        for row in (rows or []):
            slot, usage, desc = row[0], row[1], row[2]
            if usage not in ("subject_look", "subject_outfit", "subject_prop", "三视图"):
                continue
            attr = _RETENTION_ATTR_ZH[usage]
            key = (subject_no, attr)
            if key in seen_attrs:
                continue  # 卡内同 usage 多槽合并到一条 (与 _build_h3_subject_line 段内 slot 升序合并一致)
            seen_attrs.add(key)
            # outfit 走 desc 推断 (弱化词分档); 其它按固定映射表
            if usage == "subject_outfit":
                level = _infer_outfit_level(desc)
            else:
                level = _RETENTION_LEVEL[usage]
            out_lines.append("<Subject %d> %s: %s (appears in %s)"
                             % (subject_no, attr, level, shots_str))
        # pose 段: pool pose 槽对该角色产一行 (与 _build_subject_lines 每角色追加段对齐)
        if pose_slots:
            out_lines.append("<Subject %d> %s: %s (appears in %s)"
                             % (subject_no, _RETENTION_ATTR_ZH["pose"],
                                _RETENTION_LEVEL["pose"], shots_str))

    # ---- 场景 / 动作行 (无 Subject 前缀, 全镜集合) ----
    scene_present = any(
        isinstance(uids, list) and "scene" in uids
        for uids in picture.values()
    )
    if scene_present and total_shots:
        out_lines.append("%s: %s (appears in %s)"
                         % (_RETENTION_NO_PREFIX_ZH["scene"],
                            _RETENTION_LEVEL["scene"], _format_shots(fallback_indices)))
    # 视频·动作参考 (video_ref) → 单视频段产复刻形态行; 多视频段维持现状弱参考
    # #76 方案 §三.3: 单视频段 (该段 video_ref 槽数=1) → 键+描述完整形态
    # (多视频段槽数>=2 → 锁现状 动作: weak_reference, 与现状逐字节一致)
    _video_ref_slots = _bc.video_ref_slots(pool_usage)
    if len(_video_ref_slots) == 1:
        out_lines.append("<Video %d>: %s - subject motion trajectories, "
                         "direction, speed and rhythm"
                         % (_video_ref_slots[0], _RETENTION_LEVEL["video_motion"]))
    elif len(_video_ref_slots) >= 2 and total_shots:
        out_lines.append("%s: %s (appears in %s)"
                         % (_RETENTION_NO_PREFIX_ZH["video_motion"],
                            _RETENTION_LEVEL_VIDEO_MULTI, _format_shots(fallback_indices)))
    return out_lines


def _filter_scene_video_motion_blocks(extra_blocks, lang="zh", video_ref_desc=""):
    """过滤 extra_blocks, 仅保留 scene / video_motion / audio_ref 代写句。

    六字段路径下 extra_blocks 来自 enrich_blocks (cast_spec 或 pool 路径),
    包含: subject_look / outfit / prop / pose / scene / video_ref / audio_ref / first_frame。
    过滤规则 (批 A 节点 2 修复 + W2a-E):
      - subject_look / outfit / prop / pose → **丢弃** (H3 主体行已承载, 防重复)
      - scene / video_motion (即 video_ref) → **保留** (并入 detailed_description 区)
      - audio_ref → **保留** (参考音频不进 audio_blocks — 后者只来自全局配乐/氛围声行;
        角色语义仅由 audio_ref 句承载)
      - first_frame 锚定句 → **丢弃** (六字段路径不消费锚定句)

    video_ref_desc (#83): 复刻句的"替换目标"分句改写为该 desc (detailed_description 区);
      空 → 原句逐字保留 (回落锁死)。

    实现: 按 USAGE_REGISTRY 模板生成行级 regex, 匹配成功即归类。匹配精度优先于性能。
    """
    if not extra_blocks:
        return []
    import re as _re
    use_en = (lang == "en")
    def _tpl_to_pat(tpl):
        if not tpl:
            return None
        return "^" + _re.escape(tpl).replace(_re.escape("{N}"), r"\d+") + "$"
    def _tpl_to_pat_list(tpl):
        # outfit / prop 模板含 {LIST} 占位符, 内容是 "、" / ", " + "<Picture N>" 列表
        if not tpl:
            return None
        base = _re.escape(tpl).replace(_re.escape("{N}"), r"\d+")
        list_pat = r"(?:(?:、|, )<Picture \d+>)+"
        base = base.replace(_re.escape("{LIST}"), list_pat)
        return "^" + base + "$"
    scene_pat = _tpl_to_pat(
        _bc.USAGE_REGISTRY["scene"]["en"] if use_en else _bc.USAGE_REGISTRY["scene"]["zh"])
    video_pat = _tpl_to_pat(
        _bc.USAGE_REGISTRY["video_ref"]["en"] if use_en else _bc.USAGE_REGISTRY["video_ref"]["zh"])
    # #76 方案 §三.6: 过滤器 video_pat 改双 pattern — 现行模板与 legacy 旧句各派生一条,
    # 任一命中即 keep (多视频段产的 legacy 旧句不得被静默 drop)
    _video_meta = _bc.USAGE_REGISTRY.get("video_ref") or {}
    video_legacy_pat = _tpl_to_pat(
        _video_meta.get("en_legacy") if use_en else _video_meta.get("zh_legacy"))
    look_pat = _tpl_to_pat(
        _bc.USAGE_REGISTRY["subject_look"]["en"] if use_en else _bc.USAGE_REGISTRY["subject_look"]["zh"])
    outfit_pat = _tpl_to_pat_list(_bc.USAGE_REGISTRY["subject_outfit"]["en" if use_en else "zh"])
    prop_pat = _tpl_to_pat_list(_bc.USAGE_REGISTRY["subject_prop"]["en" if use_en else "zh"])
    pose_pat = _tpl_to_pat(
        _bc.USAGE_REGISTRY["pose"]["en"] if use_en else _bc.USAGE_REGISTRY["pose"]["zh"])
    # V1.12b v4 T5: 道具多角度 (新 ID, 1.12b-T1 USAGE_REGISTRY 派生) — 与 scene 同等待遇,
    # 仅单槽模板 (block="ref", 无 {LIST} 占位) → 走 _tpl_to_pat. 在 ref2v+cast 中文批里
    # 道具多角度 ref 句不被静默丢弃, 与 scene/三视图 ref 句并列并入 detailed_description.
    _daoju_meta = _bc.USAGE_REGISTRY.get("道具多角度") or {}
    daoju_pat = _tpl_to_pat(_daoju_meta.get("en") if use_en else _daoju_meta.get("zh"))
    # W2a-E: audio_ref 角色句与 scene 同等待遇 — 参考音频的语义只在句里, 不得静默丢弃
    _audio_meta = _bc.USAGE_REGISTRY.get("audio_ref") or {}
    audio_pat = _tpl_to_pat(_audio_meta.get("en") if use_en else _audio_meta.get("zh"))
    keep = []
    for block in extra_blocks:
        if not isinstance(block, str):
            continue
        s = block.strip()
        if not s:
            continue
        if scene_pat and _re.match(scene_pat, s):
            keep.append(s)
        elif ((video_pat and _re.match(video_pat, s))
              or (video_legacy_pat and _re.match(video_legacy_pat, s))):
            keep.append(_apply_video_ref_desc(s, video_ref_desc))
        elif daoju_pat and _re.match(daoju_pat, s):
            keep.append(s)
        elif audio_pat and _re.match(audio_pat, s):
            keep.append(s)
        # drop cases: silently skip
        elif look_pat and _re.match(look_pat, s):
            continue
        elif outfit_pat and _re.match(outfit_pat, s):
            continue
        elif prop_pat and _re.match(prop_pat, s):
            continue
        elif pose_pat and _re.match(pose_pat, s):
            continue
        # 其他 (first_frame 锚定句 / H3 cast 行) → 不并入 detailed_description
    return keep


def _split_audio_blocks(audio_blocks):
    """audio_blocks = [(key, value), ...] 拆为 (sound_text, music_text) 两组。

    key "氛围声"/"sound" → overall_soundscape;
    key "配乐"/"music" → non_diegetic_music。
    缺/空 → 对应字段空串。
    """
    sound_text = ""
    music_text = ""
    if not audio_blocks:
        return sound_text, music_text
    sound_parts = []
    music_parts = []
    for kv in audio_blocks:
        if not (isinstance(kv, (list, tuple)) and len(kv) == 2):
            continue
        k, v = kv
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        v_stripped = v.strip()
        if not v_stripped:
            continue
        if k in ("氛围声", "sound", "Sound"):
            sound_parts.append(v_stripped)
        elif k in ("配乐", "music", "Music"):
            music_parts.append(v_stripped)
    if sound_parts:
        sound_text = "\n".join(sound_parts)
    if music_parts:
        music_text = "\n".join(music_parts)
    return sound_text, music_text


# ===== 批 A 节点 3 (A4) 补丁: 行级音频段剥离与合并 =====

def _extract_row_level_audio(detailed_text):
    """从 detailed_text (行编译文本) 中剥离行级 overall_soundscape:/non_diegetic_music: 段。

    shot_vocab 行编译会在画面文本后拼接行级音频段
    (如 `overall_soundscape: 雨\\n\\nnon_diegetic_music: 无。`)。
    六字段结构末尾自带同名官方字段, 直接拼接会重复。

    返回: (stripped_text, row_sound, row_music)
      - stripped_text — 去除行级音频段后的剩余文本 (保留行级音频段外的所有内容)
      - row_sound    — 行级 overall_soundscape 字段值 (无则 "")
      - row_music    — 行级 non_diegetic_music 字段值 (无则 "")

    段定位规则 (R1 修复后):
      - 行级音频段以 `\\n\\n` 分隔, 起始位置 = "overall_soundscape:" / "non_diegetic_music:"
      - 段终止 = 下一个 `\\n\\n` (段落边界) — 与 shot_vocab 段间隔规则一致。
        此前实现按"下一标签头或文本末尾"取界, 会把后随的 scene / video 代写句
        (单 `\n` 与音频段衔接) 误吞入音频字段值; 改按段落边界精确取界。
    """
    if not detailed_text:
        return detailed_text or "", "", ""

    heads = ("overall_soundscape:", "non_diegetic_music:")
    SOUND_HEAD = "overall_soundscape:"
    MUSIC_HEAD = "non_diegetic_music:"
    SOUND_HEAD_LEN = len(SOUND_HEAD)
    MUSIC_HEAD_LEN = len(MUSIC_HEAD)

    def _head_at(pos):
        """pos 处的标签头是 SOUND 还是 MUSIC; 不能识别返回 ('', 0)."""
        if detailed_text[pos:pos + SOUND_HEAD_LEN] == SOUND_HEAD:
            return SOUND_HEAD, SOUND_HEAD_LEN
        if detailed_text[pos:pos + MUSIC_HEAD_LEN] == MUSIC_HEAD:
            return MUSIC_HEAD, MUSIC_HEAD_LEN
        return "", 0

    def _value_at(start_idx):
        """start_idx 指向标签头起点; 返回字段值 (去除头与首尾空白, 无值 → '').

        段终止: 下一个 `\\n\\n` (段落边界) 或文本末尾。
        """
        this_head, this_len = _head_at(start_idx)
        if not this_head:
            return ""
        body_start = start_idx + this_len
        nxt_blank = detailed_text.find("\n\n", body_start)
        end = nxt_blank if nxt_blank >= 0 else len(detailed_text)
        body = detailed_text[body_start:end]
        return body.strip()

    # 定位所有标签头起点 (作为段头: 前为 \n 或文本开头)
    positions = []
    for h in heads:
        h_len = len(h)
        idx = 0
        while True:
            j = detailed_text.find(h, idx)
            if j < 0:
                break
            if j == 0 or detailed_text[j - 1] == "\n":
                positions.append(j)
            idx = j + 1

    if not positions:
        return detailed_text, "", ""

    positions = sorted(set(positions))
    # 取第一段为 overall_soundscape (若存在), 最后一段为 non_diegetic_music (若存在)
    row_sound = ""
    row_music = ""
    for j in positions:
        h, _ = _head_at(j)
        if h == SOUND_HEAD and not row_sound:
            row_sound = _value_at(j)
        elif h == MUSIC_HEAD and not row_music:
            row_music = _value_at(j)

    # 从 detailed_text 中删除这些段 (从前往后删, 索引左移)
    # 段边界 = [段头起点, 下一段落边界 / 文本末尾]
    ranges = []
    for j in positions:
        _, this_len = _head_at(j)
        body_start = j + this_len
        nxt_blank = detailed_text.find("\n\n", body_start)
        end = nxt_blank if nxt_blank >= 0 else len(detailed_text)
        ranges.append((j, end))

    # 合并相邻 range (实际中两段以 "\n\n" 分隔, 合并后单段覆盖 [j_first, end_last])
    ranges.sort()
    merged_ranges = []
    cur_s, cur_e = ranges[0]
    for s, e in ranges[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            merged_ranges.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    merged_ranges.append((cur_s, cur_e))

    # 切掉这些段; 切完后去除尾部 \n\n 残留
    stripped = detailed_text
    for s, e in reversed(merged_ranges):
        stripped = stripped[:s] + stripped[e:]
    stripped = stripped.rstrip()

    return stripped, row_sound, row_music


def _merge_six_field_audio(*, row_sound, row_music, audio_blocks, warn_sink=None):
    """行级值 (来自 _extract_row_level_audio) + 全局 audio_blocks → (sound_text, music_text).

    行级优先 (与 batch_core._merge_global_audio_into_official_fields 一致):
      - 行级非空 (含"无"/"none"等否定语义) → 行级值直接进字段, 全局被抑制
        (冲突场景: 行级否定 + 全局非空 → 黄条, 走既有 _merge_global_audio_into_official_fields)
      - 行级空 → 全局入位

    实现: 复用 batch_core._merge_global_audio_into_official_fields 的等价语义。
    组装层不复刻"行级值判否定"分支 — 改为将行级值预填进临时 base, 再调既有函数
    (函数扫描 row-level 字段 → 全局被抑制 + 冲突进黄条), 最后从合并结果中提取字段值。
    """
    # 构造临时 base 含行级字段 (字段头 + 值), 调既有合并函数
    shell_parts = []
    if row_sound:
        shell_parts.append("overall_soundscape: " + row_sound)
    if row_music:
        shell_parts.append("non_diegetic_music: " + row_music)
    shell = "\n\n".join(shell_parts)

    if audio_blocks:
        merged = _bc._merge_global_audio_into_official_fields(
            shell, audio_blocks, warn_sink=warn_sink)
    else:
        merged = shell

    # 从 merged 提取两个字段值 (用 batch_core._row_level_audio_value, 与既有口径一致)
    sound_text = _bc._row_level_audio_value(merged, "overall_soundscape") or ""
    music_text = _bc._row_level_audio_value(merged, "non_diegetic_music") or ""
    return sound_text, music_text


def _append_negative_en(base, global_text):
    """en 路径专用: 整句 NEG_EN_FULL 末追 (与旧 negative=True 兼容)。"""
    remaining = [it for it in
                 ["no narration", "no voiceover", "no subtitles", "no text watermark", "no music"]
                 if it not in (global_text or "")]
    if not remaining:
        return base
    sentence = _NEG_EN_FULL if len(remaining) == 5 else ", ".join(remaining)
    if base:
        return base + "\n" + sentence
    return sentence


def _append_to_detailed_description(base, extra_text):
    """六字段路径: 在 detailed_description 段内字段体末尾追加 extra_text。

    段定位: `detailed_description:\\n` 头 → 下一区头边界 (`\\noverall_soundscape:`) 或文本末尾。
    区头边界优先, 兜底文本末; 不用第一个 `\\n\\n` (区中 scene 代写句 \n\n 拼入时会被错切)。
    extra_text 在字段体内, 段间 \\n\\n 间隔不被破坏。
    """
    if not base or not extra_text:
        return base
    head = "detailed_description:\n"
    head_idx = base.find(head)
    if head_idx < 0:
        # 找不到详细描述段头 — 退回末追 (兜底, 不应发生)
        if base.endswith("\n"):
            return base + extra_text
        return base + "\n" + extra_text
    body_start = head_idx + len(head)
    # 段终止 = 下一区头边界 (\noverall_soundscape:), 兜底文本末尾。
    # 不用第一个 \n\n (detailed 区中 scene / video_motion 代写句以 \n\n 拼入时会被错切,
    # 导致负句插在区中部; 详细描述字段体为空时还会错插进 overall_soundscape 区)。
    nxt_head = base.find("\noverall_soundscape:", body_start)
    end = nxt_head if nxt_head >= 0 else len(base)
    # 在 [body_start, end) 内追加: 若已有字段体, 用 \n 连接; 空字段体则直接放
    current_body = base[body_start:end]
    if current_body.strip():
        # 去掉末尾空白再拼接, 避免多重 \n
        new_body = current_body.rstrip() + "\n" + extra_text
    else:
        new_body = extra_text
    return base[:body_start] + new_body + base[end:]