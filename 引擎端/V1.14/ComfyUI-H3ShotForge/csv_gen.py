import csv
import io
import json
import os
import sys

# 兼容包内(__init__.py)与平铺(测试/mcp_server)两种导入方式
_SELF_DIR = os.path.dirname(os.path.abspath(__file__))
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)
from shot_vocab import STRUCT_FIELDS, CONCAT_FLAG_COL

# 批 A6 T6: 出场角色列移除 — 引擎按 prompt 文本自动检测在场角色 (批 H 的名字检测复用),
# CSV 不再导出该空列. 旧 CSV 含该列仍可解析: _parse_shots 按列头名认列, retention 接线不受影响.
# A1 多角色: "出场角色" 此前插在 STRUCT_FIELDS 与 prompt 之间; 现已下线.
SHOT_HEADER = ["ID"] + list(STRUCT_FIELDS) + ["prompt", "段落时长", "种子", "导出文件名"]


def build_csv(mode, data):
    """生成与引擎解析兼容的 CSV 文本。data 结构:
    {
      "pool": {"Picture": {1: "a.png", ...}, "Video": {...}, "Audio": {...}},
      "pool_usage": {"Picture": {1: ["subject_look", "scene"], ...}, ...},   # V1.4 T6: list[str]
      "globals": {"比例": "16:9", "质量": "0.4", "步数": "8V8A"},
      "shots": [{"ID": "s01", "prompt": "...", "段落时长": "5", "种子": "42", "导出文件名": "s01"}],
    }
    V1.4 T6: 池行 "文件名|用途A+用途B" 输出 ('+' 分隔; 空 list 视同无标注输出纯文件名;
    旧调用无 pool_usage / 无用途 → 与 V1.3 逐字节一致).
    """
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
    # 前端 JS 对象键是字符串 ("1", "2"), 统一归一化为字符串再查
    pool = {k: {str(sk): sv for sk, sv in v.items()} for k, v in data.get("pool", {}).items()}
    # V1.4 T6: pool_usage 归一化为字符串槽 key, 兼容 int key (后端偶尔直传 int)
    pool_usage = {k: {str(sk): sv for sk, sv in (v or {}).items() if str(sk).strip()}
                  for k, v in (data.get("pool_usage") or {}).items()}
    # 1.14a T4: pool_pose_style 归一化 (与 pool_usage 同口径); 缺/None/非 dict → 空
    pool_pose_style = ({k: {str(sk): sv for sk, sv in (v or {}).items()
                            if str(sk).strip() and isinstance(sv, str)}
                        for k, v in (data.get("pool_pose_style") or {}).items()}
                       if isinstance(data.get("pool_pose_style"), dict) else {})
    for key in ("Picture", "Video", "Audio"):
        slots = pool.get(key, {})
        usages = pool_usage.get(key, {})
        cells = []
        for i in range(1, 10):
            fname = slots.get(str(i), "")
            uid = usages.get(str(i), "")
            # V1.4 T6: list 形态; 空 list 视同无标注
            # V1.4 T8 (登记 T5): 拼装前过滤纯空白 (str 且 strip 后为空); 过滤后空视同无标注输出纯文件名
            clean_uid = [u for u in uid if isinstance(u, str) and u.strip()] if isinstance(uid, list) else []
            # 1.14a T4: 单 pose 槽 + 样式 ∈ {skeleton,depth} → 三段式 "文件名|pose|样式";
            # 其余逐字走原两段式 (空 / 非 pose / 无样式) — 两段式旧行为逐字节不变
            style = pool_pose_style.get(key, {}).get(str(i))
            if (fname and clean_uid == ["pose"]
                    and style in ("skeleton", "depth")):
                cells.append("%s|pose|%s" % (fname, style))
            elif fname and clean_uid:
                cells.append("%s|%s" % (fname, "+".join(clean_uid)))
            else:
                cells.append(fname)
        w.writerow([key] + cells)
    g = data.get("globals", {})
    # 2.9: "语言"追加在末尾 — 全局级开关,globals 无该键时不写行(旧 CSV 零变化)
    # 批 A 后小迭代: "默认负面" 单一开关 → 三独立勾选 "关音乐"/"关对白"/"关水印字幕"
    #   行序固定追加在 "语言" 之后(逐字锁定); 三键存在即写出(开/关都写, 便于 reload 回填)
    #   旧 CSV 含 "默认负面" 行 → 仍写出 (作为兼容 anchor, 引擎 _parse_global 读旧键做映射)
    # T2: "配乐","氛围声" 行固定追加在 三勾选 之后; 仅值非空描述文本才写出
    # 批J: "角色绑定" 追加在末尾 — JSON 紧凑串(前端 collectData 写入 globals)。
    #   此前白名单缺此键 → CSV 不落绑定 → 重开表单回填丢绑定(用户真机问题1)。
    #   值是 JSON 串, csv.writer 自动引号转义, 引擎 _parse_global 按行读回后 json.loads 还原。
    # V1.10 批1 T4: "音乐文件","音乐混入方式" 追加在 角色绑定 之后 (BGM 通道 D2) —
    #   前端表单控件值 (路径串 / "替换"/"混合"), 引擎 _parse_global 按行认后
    #   _apply_global 写 self._bgm_path / self._bgm_mix_mode (中文→英文映射).
    # V1.10 批2 T1: "审片门" 追加在 BGM 两键之后 (审片门 D1 数据层) —
    #   值=非负整数串(空=关, 不写出, 沿"配乐"/"氛围声"同款节奏),
    #   引擎 _parse_global 防御性过滤 (非数字/负数/>50 落默认 0),
    #   _apply_global 落 self._review_every_n.
    # V1.11 批1 T6: "自动拼接" 追加在 审片门 之后 (D1 数据层) —
    #   值=白名单 "自动"/"不拼" (空/缺省 = 自动, 旧 CSV 天然兼容),
    #   引擎 _parse_global 防御性过滤 (脏值不落键), _apply_global 落 self._auto_concat
    #   (run/rerun/_rerun_finalize 三处收尾消费). 表单 UI 批2 T5 做, 本任务不碰 web/.
    # V1.12 T4: "关场景" 追加在 自动拼接 之后 (场景参考句批次开关) —
    #   值=开/空 (空=不关, 旧 CSV 天然兼容; 与 关对白 同款非空才写出),
    #   引擎 _parse_global 认后 _apply_global 落 self._scene_disabled.
    # V1.12b v4 M5: "人物建档" 追加在 关场景 之后 (建档路由批次开关, 同款非空才写出) —
    #   引擎 _parse_global 认后 preflight 裸比较落 self._enrollment_enabled (M5 二轮 A4 闭合).
    for k in ("比例", "质量", "步数", "批次次数", "提示词", "语言",
              "关音乐", "关对白", "关水印字幕", "默认负面",
              "配乐", "氛围声", "角色绑定",
              "音乐文件", "音乐混入方式", "审片门", "自动拼接", "关场景", "人物建档",
              "放大", "插帧", "放大引擎"):  # 1.14b U3: 后处理三键 (值开/关 + 引擎白名单)
        v = g.get(k)
        # V1.11 批1 T6: 自动拼接 缺省值 = "自动" (其他键沿"非空才写出"惯例).
        if k == "自动拼接" and not v:
            v = "自动"
        # 1.14b U3: 放大引擎 白名单 — 非 seedvr2/rtxvsr 不写出 (回落默认 seedvr2)
        if k == "放大引擎" and v not in ("seedvr2", "rtxvsr"):
            continue
        if not v:
            continue
        # 批J: "角色绑定" 双形态兜底 — 前端 collectData 传 JSON 字符串;
        # parse_csv_to_data 回读后是数组(list)。非 str 一律 dumps 回 JSON,
        # 否则 csv.writer 会把 list 写成 Python repr(单引号), 回读再解析即脏。
        if k == "角色绑定" and not isinstance(v, str):
            v = json.dumps(v, ensure_ascii=False)
        w.writerow([k, v])
    # 1.11b 波1 T1: 自定义模式在分镜行末尾追加 "与上一片段拼接" 列 (内联表达式, SHOT_HEADER 本体不变)
    shot_cols = SHOT_HEADER + ([CONCAT_FLAG_COL] if mode == "自定义" else [])
    w.writerow(shot_cols)
    for s in data.get("shots", []):
        w.writerow([str(s.get(k, "") or "") for k in shot_cols])
    return buf.getvalue()


def inject_language_row(text, language):
    """2.9: MCP 语言注入 — 在第一个 ID, 行前插入 语言,<language>; 无 ID 行/已有语言行原样返回;
    返回文本行尾统一为 \n(csv.reader 解析不受行尾风格影响)."""
    if not text:
        return text
    lines = text.split("\n")
    # 已有语言行 => 原样返回(CSV 自带优先)
    if any(l.startswith("语言,") for l in lines):
        return text
    # 找第一个 ID, 行(分镜表头)
    for i, line in enumerate(lines):
        if line.startswith("ID,"):
            lines.insert(i, "语言," + str(language))
            return "\n".join(lines)
    # 无 ID 行 => 原样返回
    return text


# 依赖 batch_core 私有解析方法,改动解析时两处同步
def parse_csv_to_data(csv_path):
    from batch_core import H3BatchEngine
    base = os.path.dirname(os.path.abspath(csv_path)) or "."
    e = H3BatchEngine("分镜", "nope.json", csv_path, base, base)
    raw = e._parse_rows()
    pool = {k: {str(n): v for n, v in e._parse_pool(raw)[k].items()}
            for k in ("Picture", "Video", "Audio")}
    g = e._parse_global(raw)
    # 1.11b 波1 T1: 当且仅当解析表头含 "与上一片段拼接" 时, shots 行才附该键 (缺列 = 不附)
    shot_cols = list(SHOT_HEADER)
    for r in raw:
        if r and r[0] == "ID":
            if CONCAT_FLAG_COL in r:
                shot_cols.append(CONCAT_FLAG_COL)
            break
    shots = [{k: str(row.get(k, "") or "") for k in shot_cols}
             for row in e._parse_shots(raw)]
    # V1.4 T5: 回填 pool_usage (int 槽 key → str key, 与 pool 一致; 旧 CSV 三 kind 空 dict)
    pool_usage = {k: {str(n): v for n, v in e._pool_usage.get(k, {}).items()}
                  for k in ("Picture", "Video", "Audio")}
    # 1.14a T4: 回填 pool_pose_style — T1 _parse_pool 已落 _pose_style (仅 Picture 单 pose 槽);
    # 两段式旧 CSV pose 槽不落 _pose_style, 此处回填默认 skeleton (与引擎缺省兜底对齐)
    pool_pose_style = {k: {str(n): v for n, v in e._pose_style.get(k, {}).items()}
                       for k in ("Picture", "Video", "Audio")}
    # 两段式 pose 槽 → 默认回填 skeleton (T1 解析层两段式不落 _pose_style)
    for kind in ("Picture", "Video", "Audio"):
        for n, ids in pool_usage.get(kind, {}).items():
            if ids == ["pose"] and n not in pool_pose_style[kind]:
                pool_pose_style[kind][n] = "skeleton"
    return {"pool": pool, "pool_usage": pool_usage, "pool_pose_style": pool_pose_style,
            "globals": g, "shots": shots}
