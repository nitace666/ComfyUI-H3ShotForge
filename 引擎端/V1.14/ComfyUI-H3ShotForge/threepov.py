"""V1.11c 波1+波2: 出三视图端点 (#45/#46) + 任务注册表 + 渲染接线.

设计要点 (锁定方案 §二):
  - 自建接线 (不调 submit): pool + quick_data_to_csv_data + build_csv + H3BatchEngine.run()
  - port 钉死 _own_server_port() (严禁裸 0)
  - 任务号前缀 threepov_; manifest 命名 h3_threepov_manifest_*.json (不进 history)
  - 状态落盘 h3_threepov_registry.json; 服务重启 interrupted 读盘返回
  - 三视图占 _active, 与跑批双向互斥 409 (active_busy 同款文案)
  - 渲染完成后 _extract_last_frame 抽尾帧 → asset_library/asset_images/threepov/

波1 仅 text 给法启用; image_path 波3; card_name 波2 (本文件实现):
  - 读卡走 archive_docs/<safe_name>.json (v3 一档一文件, 与 batch_core
    _load_assets_for_cast_plan 同口径 — archive_docs 优先)
  - 卡有图 → ref2v (参照图放池 Picture 1, 模板 h3_ref2va_8V8A_CK.json; 批 J J1 起)
  - 卡有服装图 (subject_outfit media 非空) → 双参考槽: 槽 1 主图 (|subject_look) +
    槽 2 服装图 (|subject_outfit) + 服装锚定句 (批 J J3; T-A 修法 1-4)
  - 卡无图 (subject_look media 空) → t2v (与纯文字模式等价)
  - 渲染+尾帧成功后: PNG → archive_images/<卡名>/threepov.png (固定名)
    写卡新增/覆盖 '三视图' 行 (subject_look 行字节不动)
  - 删卡连删: archive_purge rmtree archive_images/<卡名> (既有, 本文件零代码)
"""
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback

import folder_paths
from aiohttp import web

# 命名空间 / 文件名常量 (api.md V1.11c 三视图契约 §"threepov 落盘与命名空间声明")
TASK_ID_PREFIX = "threepov_"
THREEPOV_OUTPUT_SUBDIR = "h3_threepov"          # output_dir 下专属子目录
MANIFEST_PREFIX = "h3_threepov_manifest_"        # 不带 h3_batch_manifest_ 前缀 → history 扫描器天然放行
MANIFEST_SUFFIX = ".json"
REGISTRY_FILENAME = "h3_threepov_registry.json"
THREEPOV_ASSET_SUBDIR = "threepov"               # asset_library/asset_images/threepov/
ASSET_PNG_FILENAME_FMT = "threepov_%s.png"        # threepov_<task_id>.png

# 状态机 (api.md #46)
STATUS_STARTED = "started"
STATUS_RENDERING = "rendering"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_INTERRUPTED = "interrupted"

# 文本最大长度
TEXT_MAX_LEN = 4096

# 模板文件名 — 无图 t2v; 有图 ref2v (批 J J1: 画布 ref2v 化, 画布 i2v 接线退役
# — 批 I D5 起 i2v 模板已废除, 画布是最后使用面)
TEMPLATE_T2V = "turboVA+CK/h3_t2v_8V8A_CK.json"
TEMPLATE_REF2V = "turboVA+CK/h3_ref2va_8V8A_CK.json"

# 卡名模式 PNG 落盘子目录 (asset_library/archive_images/<卡名>/, 固定名 threepov.png)
THREEPOV_CARD_PNG_NAME = "threepov.png"

# ---- V1.12 T6: 场景画布 (#47/#48) 独立命名空间 ----
# 任务号前缀 / 专属 output 子目录 / manifest 前缀 (不带 h3_batch_manifest_ → 不进 history)
SCENE_TASK_ID_PREFIX = "scenecv_"
SCENE_OUTPUT_SUBDIR = "h3_scene_canvas"
SCENE_MANIFEST_PREFIX = "h3_scene_canvas_manifest_"
SCENE_REGISTRY_FILENAME = "h3_scene_canvas_registry.json"
SCENE_ASSET_SUBDIR = "scene_canvas"                 # asset_library/asset_images/scene_canvas/
SCENE_ASSET_PNG_FILENAME_FMT = "scene_canvas_%s.png"
SCENE_CARD_PNG_NAME = "scene_canvas.png"            # 卡名模式固定名 (重出覆盖)
SCENE_REF_BASENAME_FMT = "scene_canvas_ref_%s.png"  # image_path 模式参照副本 (input 根)

# ---- V1.12b T3: 道具多角度画布 (#53/#54) 独立命名空间 ----
# 同 scene/threepov 命名空间隔离 — task_id 前缀 / manifest 前缀 / output 子目录均独立;
# 防同秒撞名 + history 扫描器天然隔离 (manifest 文件名不以 h3_batch_manifest_ 起头).
ITEM_TASK_ID_PREFIX = "itemcv_"
ITEM_OUTPUT_SUBDIR = "h3_item_canvas"
ITEM_MANIFEST_PREFIX = "h3_item_canvas_manifest_"
ITEM_REGISTRY_FILENAME = "h3_item_canvas_registry.json"
ITEM_ASSET_SUBDIR = "item_canvas"                # asset_library/asset_images/item_canvas/
ITEM_ASSET_PNG_FILENAME_FMT = "item_canvas_%s.png"
ITEM_CARD_PNG_NAME = "item_canvas.png"           # 卡名模式固定名 (重出覆盖)
ITEM_REF_BASENAME_FMT = "item_canvas_ref_%s.png" # image_path 模式参照副本 (input 根)


# V1.12b v4 T4: 建档路由 kind → 命名空间/写卡目标名 派发表 (单一真相源, 与三端点卡名模式固定名一致).
# submit pre-batch 钩子用此查 dst_png / manifest_prefix / task_prefix / output_subdir.

def _kind_to_card_png_name(kind):
    """kind → 卡名模式固定 PNG 名 (写卡目标名, 与 _save_card_with_*_row 内部口径一致)."""
    return {
        "character": THREEPOV_CARD_PNG_NAME,
        "scene": SCENE_CARD_PNG_NAME,
        "item": ITEM_CARD_PNG_NAME,
    }.get(kind, "")


def _kind_to_manifest_prefix(kind):
    """kind → manifest 文件名前缀 (独立命名空间, 三端点 h3_*_manifest_ 一致)."""
    return {
        "character": MANIFEST_PREFIX,
        "scene": SCENE_MANIFEST_PREFIX,
        "item": ITEM_MANIFEST_PREFIX,
    }.get(kind, "")


def _kind_to_task_prefix(kind):
    """kind → task_id 前缀 (注册表命名空间隔离)."""
    return {
        "character": TASK_ID_PREFIX,
        "scene": SCENE_TASK_ID_PREFIX,
        "item": ITEM_TASK_ID_PREFIX,
    }.get(kind, "")


def _kind_to_output_subdir(kind):
    """kind → output_dir 下专属子目录 (注册表/manifest 落点)."""
    return {
        "character": THREEPOV_OUTPUT_SUBDIR,
        "scene": SCENE_OUTPUT_SUBDIR,
        "item": ITEM_OUTPUT_SUBDIR,
    }.get(kind, "")


# 用户补充文本长度上限 — 与 api.md #45 text 限长同档
PROMPT_EXTRA_MAX_LEN = 4096

# V1.14 整改批 K: 三类画布模板 — MiniMax H3 官方六段式英文骨架.
# 锚点 = 一致性设计 (1.11a/1.12/1.12b): 中文 desc 直嵌 subject_definitions 首句 (老板裁:
# "中文直接嵌英文骨架, 不加翻译"). 锁段序/字段名 (官方精确 token 不可改名重排):
# subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape
# → non_diegetic_music. 骨架固定件: 逐项保留声明 (this is a documentation sheet of an existing
# subject, not a new design) + 每格显式命名 + 冻结帧声明 (FROZEN FRAME / reads as a single
# photograph). 槽位 = {DESC} (中文 desc 注入位); 模板常量不含描述句, 拼装时由
# _build_*_canvas_prompt 注入. 严禁运行时读 docs 文件 (契约: 引擎仓自包含).

# 人物 (character) — 有图变体 (ref2v). subject_definitions 首句含 <Picture 1> 引用 +
# retention_analysis 用官方保留 token (partially_preserved) + detailed_description 含
# WHAT IS TAKEN FROM THE REFERENCE IMAGE 块 (设计附录 A 有图版).
_TEMPLATE_C = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single subject shown in <Picture 1>. {DESC}. Only the subject itself is "
    "taken from the reference image: not its background, not its lighting, and no other object "
    "visible in it.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a reference data sheet "
    "that lays out <Subject 1> as a grid of four views on a neutral studio backdrop. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen reference data sheet in flat product-photography "
    "style, with no motion of any kind from the first frame to the last: a seamless neutral "
    "light-grey studio background, soft even studio light from the front and both sides so every "
    "surface is readable and nothing falls into black shadow, neutral accurate colour, no colour "
    "cast, no stylised grading, no environment of any kind.\n"
    "\n"
    "WHAT IS TAKEN FROM THE REFERENCE IMAGE: the subject exactly as it already is. Every part, "
    "edge, surface and detail keeps the shape, size and position it has there. Every colour and "
    "material keeps its exact hue and finish. The proportions and the silhouette are the same. "
    "Nothing is redesigned, restyled, simplified, tidied, embellished, modernised or improved, "
    "nothing is added that is not in the reference and nothing in it is left out. This is a "
    "documentation sheet of an existing subject, not a new design.\n"
    "\n"
    "[Shot 1] The frame is a grid of four panels on that grey background, separated by thin "
    "even neutral-grey gutters of equal width, with a matching margin around the outside. Every "
    "panel is a plain rectangle, flat to the camera, with no tilt, no perspective and no drop "
    "shadow: three tall equal panels side by side on the left half of the frame, and one large "
    "panel filling the right half.\n"
    "\n"
    "THE FOUR PANELS - four different views of the same subject, shown at the same scale, lit "
    "identically, photographed from the same camera height and distance:\n"
    "  1 - LEFT TALL PANEL: FRONT full-body view, standing in a relaxed natural pose, arms "
    "hanging naturally at her sides, facing the camera straight on.\n"
    "  2 - MIDDLE TALL PANEL: THREE-QUARTER full-body view, turned 45 degrees to her own "
    "right. This panel must be clearly different from panel 1.\n"
    "  3 - THIRD TALL PANEL: BACK full-body view, seen from directly behind, her hair falling "
    "down her back.\n"
    "  4 - RIGHT LARGE PANEL: close-up of her face, neutral calm expression, looking straight "
    "into the camera, her hair framing her face.\n"
    "\n"
    "It is one and the same subject in every panel, with the same face, the same hair, the same "
    "clothing and the same proportions. Nothing is added, removed, redesigned or restyled "
    "between panels.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot and does not "
    "move, zoom, tilt, shake or drift. The panels do not slide, resize, reorder, cross-fade or "
    "animate. The subject does not move, turn, gesture or change pose inside any panel. Every "
    "frame is identical to the first: the shot reads as a single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no second copy of the subject inside a panel; no repeated "
    "panel; no extra panels; no empty panels; no overlapping panels; no other person; no room, "
    "no furniture, no mirror, no floor pattern; no camera movement, no cuts, no fades, no "
    "dissolves, no motion blur, no depth-of-field blur, no stylised or cartoon rendering, no "
    "dramatic or coloured lighting.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# 人物 (character) — 无图变体 (t2v). 设计附录 A: 首句无 <Picture 1> 引用; retention_analysis
# 不用官方保留 token (无参照图无"保留"语义, 伪 token 有伤格式); detailed_description 去掉
# WHAT IS TAKEN FROM THE REFERENCE IMAGE 块. 其余骨架逐字相同.
_TEMPLATE_C_T2V = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single subject. {DESC}.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a reference data sheet "
    "that lays out <Subject 1> as a grid of four views on a neutral studio backdrop. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen reference data sheet in flat product-photography "
    "style, with no motion of any kind from the first frame to the last: a seamless neutral "
    "light-grey studio background, soft even studio light from the front and both sides so every "
    "surface is readable and nothing falls into black shadow, neutral accurate colour, no colour "
    "cast, no stylised grading, no environment of any kind.\n"
    "\n"
    "[Shot 1] The frame is a grid of four panels on that grey background, separated by thin "
    "even neutral-grey gutters of equal width, with a matching margin around the outside. Every "
    "panel is a plain rectangle, flat to the camera, with no tilt, no perspective and no drop "
    "shadow: three tall equal panels side by side on the left half of the frame, and one large "
    "panel filling the right half.\n"
    "\n"
    "THE FOUR PANELS - four different views of the same subject, shown at the same scale, lit "
    "identically, photographed from the same camera height and distance:\n"
    "  1 - LEFT TALL PANEL: FRONT full-body view, standing in a relaxed natural pose, arms "
    "hanging naturally at her sides, facing the camera straight on.\n"
    "  2 - MIDDLE TALL PANEL: THREE-QUARTER full-body view, turned 45 degrees to her own "
    "right. This panel must be clearly different from panel 1.\n"
    "  3 - THIRD TALL PANEL: BACK full-body view, seen from directly behind, her hair falling "
    "down her back.\n"
    "  4 - RIGHT LARGE PANEL: close-up of her face, neutral calm expression, looking straight "
    "into the camera, her hair framing her face.\n"
    "\n"
    "It is one and the same subject in every panel, with the same face, the same hair, the same "
    "clothing and the same proportions. Nothing is added, removed, redesigned or restyled "
    "between panels.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot and does not "
    "move, zoom, tilt, shake or drift. The panels do not slide, resize, reorder, cross-fade or "
    "animate. The subject does not move, turn, gesture or change pose inside any panel. Every "
    "frame is identical to the first: the shot reads as a single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no second copy of the subject inside a panel; no repeated "
    "panel; no extra panels; no empty panels; no overlapping panels; no other person; no room, "
    "no furniture, no mirror, no floor pattern; no camera movement, no cuts, no fades, no "
    "dissolves, no motion blur, no depth-of-field blur, no stylised or cartoon rendering, no "
    "dramatic or coloured lighting.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# 场景 (scene) — 有图变体 (ref2v). 布局替换原"四机位环绕"为 2×2 景别制 (全景/中景/俯瞰/低视角,
# 老板已批, 同质化根治). 骨架其余字段同人物版.
_TEMPLATE_SCENE = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single scene shown in <Picture 1>. {DESC}. Only the scene itself is "
    "taken from the reference image: not its background framing, not its lighting, and no other "
    "location or subject visible in it.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a four-view scene "
    "reference sheet that lays out <Subject 1> as a 2x2 grid of four camera views. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a scene reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen four-view scene reference sheet, with no motion "
    "of any kind from the first frame to the last, rendered in a clean, neutral style, with "
    "neutral accurate colour and no stylised grading.\n"
    "\n"
    "WHAT IS TAKEN FROM THE REFERENCE IMAGE: the scene exactly as it already is. Every "
    "visible element keeps the shape, colour and position it has there, under the same "
    "lighting. Nothing is redesigned, simplified or embellished, nothing is added "
    "that is not in the reference and nothing in it is left out. This is a documentation sheet "
    "of an existing place, not a new design.\n"
    "\n"
    "[Shot 1] The frame is a 2x2 grid of four equal panels, separated by thin even neutral-grey "
    "gutters of equal width, with a matching margin around the outside. Every panel is a plain "
    "rectangle, flat to the camera, with no tilt and no drop shadow.\n"
    "\n"
    "THE FOUR PANELS - four clearly different camera views of one and the same scene. Each panel "
    "shows a different framing and no two panels look alike:\n"
    "Every panel shows the SAME single scene as the reference picture(s) named above, from a "
    "different angle; do not introduce a second scene, a different location, or a different "
    "layout.\n"
    "  1 - TOP-LEFT: WIDE ESTABLISHING PANORAMA from the front, the whole scene readable in one "
    "view, the scene's elements filling the frame from foreground to background.\n"
    "  2 - TOP-RIGHT: MEDIUM VIEW from the front-left, closer to one side of the scene, with "
    "the rest of the scene behind it.\n"
    "  3 - BOTTOM-LEFT: HIGH OVERVIEW from above, looking down at the whole scene so the layout "
    "of the scene is readable from the air.\n"
    "  4 - BOTTOM-RIGHT: CLOSE LOW VIEW at ground level, near foreground details filling the "
    "frame, with a recognizable part of the same scene visible (same main elements as panel 1).\n"
    "\n"
    "The scene is continuous across the panels: the same layout and the same main "
    "elements are identical across all four views. Only the camera position, height and "
    "framing change between panels.\n"
    "\n"
    "The background outside and between the panels is a flat uniform neutral grey (#B0B0B0), "
    "no gradient, no colour cast, no vignette.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot in every "
    "panel; the panels do not slide, resize, reorder, cross-fade or animate; the scene's details "
    "are frozen mid-instant. Every frame is identical to the first: the shot reads as a "
    "single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no repeated panel; no two panels showing the same framing; "
    "no extra panels; no empty panels; no overlapping panels; no scene element that is neither "
    "in the written description nor visible in the reference picture(s) named above; no added "
    "locations; no added structures; no camera movement, no cuts, no fades, no dissolves, no "
    "motion blur, no stylised or cartoon rendering, no dramatic or coloured lighting.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# 场景 (scene) — 无图变体 (t2v).
_TEMPLATE_SCENE_T2V = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single scene. {DESC}.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a four-view scene "
    "reference sheet that lays out <Subject 1> as a 2x2 grid of four camera views. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a scene reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen four-view scene reference sheet, with no motion "
    "of any kind from the first frame to the last, rendered in a clean, neutral style, with "
    "neutral accurate colour and no stylised grading.\n"
    "\n"
    "[Shot 1] The frame is a 2x2 grid of four equal panels, separated by thin even neutral-grey "
    "gutters of equal width, with a matching margin around the outside. Every panel is a plain "
    "rectangle, flat to the camera, with no tilt and no drop shadow.\n"
    "\n"
    "THE FOUR PANELS - four clearly different camera views of one and the same scene. Each panel "
    "shows a different framing and no two panels look alike:\n"
    "Every panel shows the SAME single scene described above, from a different angle; do not "
    "introduce a second scene, a different location, or a different layout.\n"
    "  1 - TOP-LEFT: WIDE ESTABLISHING PANORAMA from the front, the whole scene readable in one "
    "view, the scene's elements filling the frame from foreground to background.\n"
    "  2 - TOP-RIGHT: MEDIUM VIEW from the front-left, closer to one side of the scene, with "
    "the rest of the scene behind it.\n"
    "  3 - BOTTOM-LEFT: HIGH OVERVIEW from above, looking down at the whole scene so the layout "
    "of the scene is readable from the air.\n"
    "  4 - BOTTOM-RIGHT: CLOSE LOW VIEW at ground level, near foreground details filling the "
    "frame, with a recognizable part of the same scene visible (same main elements as panel 1).\n"
    "\n"
    "The scene is continuous across the panels: the same elements and the same lighting are "
    "identical. Only the camera position, height and framing change between panels.\n"
    "\n"
    "The background outside and between the panels is a flat uniform neutral grey (#B0B0B0), "
    "no gradient, no colour cast, no vignette.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot in every "
    "panel; the panels do not slide, resize, reorder, cross-fade or animate; the scene's details "
    "are frozen mid-instant. Every frame is identical to the first: the shot reads as a "
    "single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no repeated panel; no two panels showing the same framing; "
    "no extra panels; no empty panels; no overlapping panels; no scene element that is neither "
    "in the written description nor part of the described scene; no added locations; no added "
    "structures; no camera movement, no cuts, no fades, no dissolves, no motion blur, no "
    "stylised or cartoon rendering, no dramatic or coloured lighting.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# 道具 (item) — 有图变体 (ref2v). 布局 = 2×2 四视角 (正面/左前 45°/右前 45°/俯视).
_TEMPLATE_ITEM = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single object shown in <Picture 1>. {DESC}. Every part, surface, colour "
    "and material is exactly as it appears there. Only the object itself is taken from the "
    "reference image: not its background, not its lighting, and no other object visible in it.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a reference data sheet "
    "that lays out <Subject 1> as a 2x2 grid of four views on a neutral studio backdrop. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen reference data sheet in flat product-photography "
    "style, with no motion of any kind from the first frame to the last: a seamless neutral "
    "mid-grey background, soft even studio light from the front and both sides so every surface "
    "is readable and nothing falls into black shadow, neutral accurate colour, no colour cast, "
    "no stylised grading, no environment of any kind.\n"
    "\n"
    "WHAT IS TAKEN FROM THE REFERENCE IMAGE: the object exactly as it already is. Every part, "
    "edge, seam, button and attachment keeps the shape, size and position it has there. Every "
    "colour, metal and surface keeps its exact hue and finish. The proportions and the "
    "silhouette are the same. Nothing is redesigned, restyled, simplified, tidied, embellished, "
    "modernised or improved, nothing is added that is not in the reference and nothing in it "
    "is left out. This is a documentation sheet of an existing object, not a new design.\n"
    "\n"
    "[Shot 1] The frame is a 2x2 grid of four equal panels on that grey background, separated "
    "by thin even neutral-grey gutters of equal width, with a matching margin around the "
    "outside. Every panel is a plain rectangle, flat to the camera, with no tilt, no perspective "
    "and no drop shadow.\n"
    "\n"
    "THE FOUR PANELS - four different views of the same object, shown at the same scale, "
    "centred in their panels, lit identically, photographed from the same camera height and "
    "distance. Each panel shows the object ONCE and no two panels show the same view:\n"
    "Every panel shows the SAME single object as the reference picture(s) named above, from a "
    "different angle; do not introduce a second object, a different design, or a different "
    "colourway.\n"
    "  1 - TOP-LEFT: FRONT view, facing the camera straight on, resting flat on the ground "
    "plane.\n"
    "  2 - TOP-RIGHT: turned exactly 45 degrees to its own right, a three-quarter view showing "
    "the depth between its left side and its front. This panel must be clearly different from "
    "panel 1.\n"
    "  3 - BOTTOM-LEFT: turned exactly 45 degrees to its own left, a three-quarter view showing "
    "the depth between its right side and its front. This panel must be clearly different from "
    "panels 1 and 2, mirrored, not a repeat.\n"
    "  4 - BOTTOM-RIGHT: TOP-DOWN view seen from directly above, showing the top surface and "
    "the layout of its outlines.\n"
    "\n"
    "It is one and the same object in every panel, with the same colours, materials, "
    "proportions and number of parts. Nothing is added, removed, redesigned or restyled between "
    "panels, and each view belongs to the same object as the others.\n"
    "All four views share the same material, colour and finish; the top-down view must not be "
    "overexposed, desaturated or grey.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot and does not "
    "move, zoom, tilt, shake or drift. The panels do not slide, resize, reorder, cross-fade or "
    "animate. The object does not move, turn or change in any panel. Every frame is identical "
    "to the first: the shot reads as a single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no second copy of the object inside a panel; no material "
    "or colour change between views; no overexposed or desaturated top view; no repeated "
    "panel; no two panels showing the same view; no extra panels; no empty panels; no "
    "overlapping panels; no other object; no human figure; no room, no furniture, no floor "
    "pattern, no cast shadow on the background; no camera movement, no cuts, no fades, no "
    "dissolves, no motion blur, no depth-of-field blur, no stylised or cartoon rendering, no "
    "dramatic or coloured lighting, no lens flare.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# 道具 (item) — 无图变体 (t2v).
_TEMPLATE_ITEM_T2V = (
    "subject_definitions:\n"
    "<Subject 1> is ONE single object. {DESC}.\n"
    "\n"
    "summary:\n"
    "[reference generation] The target video is a single still frame: a reference data sheet "
    "that lays out <Subject 1> as a 2x2 grid of four views on a neutral studio backdrop. The "
    "composition does not change for the length of the clip, so one frame can be exported and "
    "used as a reference sheet.\n"
    "\n"
    "retention_analysis:\n"
    "{RETENTION_BLOCK}\n"
    "\n"
    "detailed_description:\n"
    "The target video is a STILL IMAGE - a frozen reference data sheet in flat product-photography "
    "style, with no motion of any kind from the first frame to the last: a seamless neutral "
    "mid-grey background, soft even studio light from the front and both sides so every surface "
    "is readable and nothing falls into black shadow, neutral accurate colour, no colour cast, "
    "no stylised grading, no environment of any kind.\n"
    "\n"
    "[Shot 1] The frame is a 2x2 grid of four equal panels on that grey background, separated "
    "by thin even neutral-grey gutters of equal width, with a matching margin around the "
    "outside. Every panel is a plain rectangle, flat to the camera, with no tilt, no perspective "
    "and no drop shadow.\n"
    "\n"
    "THE FOUR PANELS - four different views of the same object, shown at the same scale, "
    "centred in their panels, lit identically, photographed from the same camera height and "
    "distance. Each panel shows the object ONCE and no two panels show the same view:\n"
    "Every panel shows the SAME single object described above, from a different angle; do not "
    "introduce a second object, a different design, or a different colourway.\n"
    "  1 - TOP-LEFT: FRONT view, facing the camera straight on, resting flat on the ground "
    "plane.\n"
    "  2 - TOP-RIGHT: turned exactly 45 degrees to its own right, a three-quarter view showing "
    "the depth between its left side and its front. This panel must be clearly different from "
    "panel 1.\n"
    "  3 - BOTTOM-LEFT: turned exactly 45 degrees to its own left, a three-quarter view showing "
    "the depth between its right side and its front. This panel must be clearly different from "
    "panels 1 and 2, mirrored, not a repeat.\n"
    "  4 - BOTTOM-RIGHT: TOP-DOWN view seen from directly above, showing the top surface and "
    "the layout of its outlines.\n"
    "\n"
    "It is one and the same object in every panel, with the same colours, materials, "
    "proportions and number of parts. Nothing is added, removed, redesigned or restyled between "
    "panels, and each view belongs to the same object as the others.\n"
    "All four views share the same material, colour and finish; the top-down view must not be "
    "overexposed, desaturated or grey.\n"
    "\n"
    "This is a FROZEN FRAME. Nothing moves at all. The camera holds a static shot and does not "
    "move, zoom, tilt, shake or drift. The panels do not slide, resize, reorder, cross-fade or "
    "animate. The object does not move, turn or change in any panel. Every frame is identical "
    "to the first: the shot reads as a single photograph, not as a video.\n"
    "\n"
    "No text, letters, numbers, captions, labels, titles, arrows, logos or watermarks anywhere "
    "in the frame or in the gutters; no second copy of the object inside a panel; no material "
    "or colour change between views; no overexposed or desaturated top view; no repeated "
    "panel; no two panels showing the same view; no extra panels; no empty panels; no "
    "overlapping panels; no other object; no human figure; no room, no furniture, no floor "
    "pattern, no cast shadow on the background; no camera movement, no cuts, no fades, no "
    "dissolves, no motion blur, no depth-of-field blur, no stylised or cartoon rendering, no "
    "dramatic or coloured lighting, no lens flare.\n"
    "\n"
    "overall_soundscape:\n"
    "Silence.\n"
    "\n"
    "non_diegetic_music: N/A"
)

# ---- 单视角提示词 (保留设施, 单格重补备用; 生成链消费四格模板) ----
# 方案甲 (拆分生成) 曾改为每视角一条独立指令单图生成 + _compose_canvas_png 拼版, 因
# 格间一致性崩坏已回退为一次生成四格 (老板裁决). 本表与拼版函数保留供单格重补使用;
# _write_*_csv 仅显式传 view 时才消费本表 (顺序 = 拼版格序 1..4).
CANVAS_VIEW_COUNT = 4

_VIEW_LINES_C_ZH = (
    "同一角色正面全身像，自然站姿，双臂垂放。",
    "同一角色四分之三侧面全身像，全身完整入画，头脚不裁切，身体比例与正面一致。",
    "同一角色背面全身像。",
    "同一角色中性的面部特写，表情平静无夸张情绪，五官清晰，平视机位正面直视镜头；"
    "特写必须以中性表情与平视角度重新生成，禁止复用或模仿参考照片的拍摄角度、头部姿态与表情。",
)
_VIEW_COMMON_C_ZH = (
    "角色一致性约束：同一角色的面部、发型、服装、体型完全一致，"
    "发型长度、束放形态、头饰与发色一致。"
    "使用纯灰色无缝影棚背景（纯灰色背景全图统一）；画面中禁止出现任何室内环境、"
    "墙面、墙板、木条、家具、地板、地板反光、装饰边框、装饰线条、文字或水印。"
)

_VIEW_LINES_SCENE_ZH = (
    "摄影机位于场景正面前方，正面拍摄场景全景，展示主面完整布局。",
    "摄影机移动到场景左前方 45° 位置朝主面拍摄，展示左墙与主面的纵深关系。",
    "摄影机移动到场景右前方 45° 位置朝主面拍摄，展示右墙与主面的纵深关系。",
    "摄影机穿过场景、位于主面背后反向 180° 位置朝回拍摄，展示主面背后一侧的景象。",
)
_VIEW_COMMON_SCENE_ZH = (
    "本图只呈现上述一个机位，构图必须与其他机位明显不同。"
    "场景内容以参考图（Picture 1）为唯一依据：参照图中存在的景物如实保留，"
    "参照图中不存在的事物不要添加，既有景物的种类与位置不得删改。"
    "场景的空间布局、建筑与道具的种类形态颜色、材质、光照氛围与参考图完全一致。"
    "画面中不出现人物，仅可以远处小比例人影作尺度参照。"
)

_VIEW_LINES_ITEM_ZH = (
    "同一道具正面视角全貌，自然平放，光照均匀。",
    "同一道具左前方 45° 视角全貌，展示左侧与正面的纵深关系。",
    "同一道具右前方 45° 视角全貌，展示右侧与正面的纵深关系。",
    "同一道具从正上方俯视的全貌，展示顶面与各侧轮廓的形态布局。",
)
_VIEW_COMMON_ITEM_ZH = (
    "本图是参考图（Picture 1）中同一件道具的一个视角，禁止生成相似但不同的物品；"
    "道具的类别、形状、材质、颜色、装饰纹样、比例与参考图完全一致。"
    "使用纯灰色无缝影棚背景（纯灰色背景全图统一）；画面中禁止出现任何室内环境、"
    "墙面、墙板、木条、家具、地板、地板反光、装饰边框、装饰线条、文字或水印。"
)

# kind → 4 条视角指令 (单一真相源; 与 _canvas_cells 版式格序一一对应)
_CANVAS_VIEW_LINES = {
    "character": _VIEW_LINES_C_ZH,
    "scene": _VIEW_LINES_SCENE_ZH,
    "item": _VIEW_LINES_ITEM_ZH,
}

# J1: 画布参考锚定句 — 有参照图 (ref2v) 时追加到画布 prompt 末尾. 句式族 = 锚定块前缀
# "[画面锚定]" (batch_core.USAGE_REGISTRY first_frame / P9 拼接锚定句同族) + ref 族
# "以<Picture {N}>为准" 尾 (scene / 道具多角度 ref 句同族). 单图恒为 Picture 1, 即标签
# 路由 (batch_core.apply_shot_pool) 接 ref_images.ref_image_0. 逐字锁定: 改文案须同步
# test_j1_canvas_ref2v.py.
CANVAS_REF_ANCHOR = "\n[Reference anchoring] In all four panels the subject's form, colours and materials follow <Picture 1> exactly."

# J3: 画布服装锚定句 — 卡带 subject_outfit 行 (服装图进槽 2) 时追加到画布 prompt 末尾.
# 句式同 CANVAS_REF_ANCHOR ("[锚定] 四格中的…以<Picture N>为准"); 槽 2 由标签路由
# (batch_core.apply_shot_pool) 接 ref_images.ref_image_1. 逐字锁定: 改文案须同步
# test_j3_canvas_outfit.py. 注: T-A 修法 4 的"由产句链自动产出"在画布行不可达 (画布锚定句
# 手写引用槽 1/2 → enrich 手写去重后 look 槽为空 → subject 块不产), 故本行显式补句.
CANVAS_OUTFIT_ANCHOR = "\n[Outfit anchoring] In all four panels the clothing's style, colours and materials follow <Picture 2> exactly."

# F36 §3.3 (方案-F36-2026-10-01): 画布锚定句表 — 按 usage 查表产句, 按槽号 N 渲染.
# 数据源 = 画布自持表 (非 USAGE_REGISTRY — registry 模板是跑批产句链文案, 与画布句式
# 族不同源). look/outfit 模板自现行 CANVAS_REF_ANCHOR / CANVAS_OUTFIT_ANCHOR 单源派生
# (槽号 → {N} 占位): N=1/N=2 渲染逐字节 = 现行两常量 (J1/J3 字节锁); look 可落槽 ≥2
# (行序首行规则下三视图行在前/多 look 卡). 其余 usage 为 F36 新写 zh 句 (方案 §3.3
# 文案表; 句式族 = "\n[画面锚定]" 前缀 + ref 尾, 同 first_frame zh 族).
CANVAS_ANCHOR_TEMPLATES = {
    "subject_look": CANVAS_REF_ANCHOR.replace("<Picture 1>", "<Picture {N}>"),
    "subject_outfit": CANVAS_OUTFIT_ANCHOR.replace("<Picture 2>", "<Picture {N}>"),
    "subject_prop": "\n[画面锚定] 道具以 <Picture {N}> 的参考为准",
    "三视图": "\n[画面锚定] 三视图参照以 <Picture {N}> 为准",
    "scene": "\n[画面锚定] 场景以 <Picture {N}> 的参考为准",
    "道具多角度": "\n[画面锚定] 道具多角度以 <Picture {N}> 的参考为准",
}
# 无 usage 槽 (image_paths 模式) 通用句: 槽 2-8 用 (槽 1 复用 look 句 = 单图语义).
CANVAS_ANCHOR_GENERIC = "\n[画面锚定] 以 <Picture {N}> 的参考图为准"

# #61 §3.2.5: 锚定尾句例外化 — override=True (有图卡 + 有按图忽略句) 时尾追加例外,
# 防最末高权重锚定句继续命令「照抄参考图」. override=False 逐字节不变 (J1/J3 字节锁).
_CANVAS_ANCHOR_EXCEPT_EN = (
    ", except the excluded attributes listed in retention_analysis; those follow the "
    "written description")
_CANVAS_ANCHOR_EXCEPT_ZH = "（忽略项以文字描述为准）"


def _anchor_with_override(sentence, tpl, override):
    """override=True 时按句式族追加例外尾 (英文 look/outfit: `, except ...`;
    中文锚定: `（忽略项以文字描述为准）`); False → 原句返回."""
    if not override:
        return sentence
    if tpl.startswith("\n[Reference anchoring]") or tpl.startswith("\n[Outfit anchoring]"):
        stem = sentence[:-1] if sentence.endswith(".") else sentence
        return stem + _CANVAS_ANCHOR_EXCEPT_EN + "."
    return sentence + _CANVAS_ANCHOR_EXCEPT_ZH


def _canvas_anchor_sentence(usage, n, *, override=False):
    """画布锚定句: usage 查表按槽号 n 渲染; 无 usage (或表外 usage) → 槽 1 复用
    look 句 (= CANVAS_REF_ANCHOR 同单图语义), 槽 2-8 通用句.

    override=True: 英文 look/outfit 句尾追加英文例外句; 中文锚定句尾追加
    「（忽略项以文字描述为准）」."""
    if usage:
        tpl = CANVAS_ANCHOR_TEMPLATES.get(usage)
        if tpl is not None:
            return _anchor_with_override(tpl.replace("{N}", str(n)), tpl, override)
    if n <= 1:
        tpl = CANVAS_ANCHOR_TEMPLATES["subject_look"]
        return _anchor_with_override(tpl.replace("{N}", "1"), tpl, override)
    tpl = CANVAS_ANCHOR_GENERIC
    return _anchor_with_override(tpl.replace("{N}", str(n)), tpl, override)

# ---- 1.14 整改批 J J2b: 画布可配置化 (h3_config「canvas」段 + 三端点覆盖参数) ----
# 契约: 工作区《规格卡-1.14整改-J2a画布配置-2026-09-18.md》(键表 §2 / 参数 §3 / 校验矩阵 §4).
# 键默认值 = 现状硬编码值; 缺块/缺键/空值 = 默认 (零迁移). 配置面 = h3_config.json 顶层可选
# 对象 "canvas"; 请求面 = 三端点可选参数 workflow_path/lora_overrides/resource_overrides;
# 优先级 = 请求 (已给出, 含 "{}" 显式清空) > 配置 > 默认. 实时读取: 每次提交/建档重读
# h3_config.json (经 batch_core._load_h3_config, 不用导入期缓存 _H3_CONFIG), 改文件免重启.
CANVAS_SECTION = "canvas"
CANVAS_DEFAULTS = {
    "ref2v_workflow": TEMPLATE_REF2V,
    "t2v_workflow": TEMPLATE_T2V,
    "aspect": "16:9",
    "megapixels": "0.4",
    "duration_seconds": "2",
    "steps": "8V8A",
    "seed": "0",
    "lora_overrides": {},
    "resource_overrides": {},
}

# 模块级互斥标志 — threepov 任务注册时置 True, 完成后清 (供跑批互斥反向检查)
_THREEPOV_ACTIVE = False
# V1.12 T6: 场景画布任务活跃标志 (同款双向互斥; 与 _THREEPOV_ACTIVE 并列为二级门)
_SCENE_CANVAS_ACTIVE = False
# V1.12b T3: 道具画布任务活跃标志 (与 _THREEPOV/_SCENE_CANVAS_ACTIVE 并列三级门)
_ITEM_CANVAS_ACTIVE = False
# 测试专用: 测试 fixture 显式注入, 指向已加载的父包 (h3pkg/__init__.py 模块对象);
# 生产环境此键为 None, _resolve_ext 走 sys.modules 路径.
_EXT_MOD_OVERRIDE = None
# 1.11c 波2: card_name 模式启用开关 — 测试桩用 (回滚波1 not_implemented_in_wave1 契约)
_CARD_NAME_ENABLED = True
# 1.11c 波3: image_path 模式启用开关 — 测试桩用 (回滚波1 not_implemented_in_wave1 契约)
_IMAGE_PATH_ENABLED = True


def _safe_hasattr(obj, attr):
    """hasattr 安全版: 防 torch._classes 等代理 __getattr__ 抛 RuntimeError."""
    try:
        getattr(obj, attr)
        return True
    except Exception:
        return False


def _resolve_ext():
    """定位父包命名空间 (h3pkg/__init__.py 模块对象).

    本模块在生产环境由 ComfyUI 加载为 h3pkg.threepov (__name__ = "h3pkg.threepov");
    测试环境可能被平铺为顶层模块 (ROOT 已加 sys.path, 直接 import threepov).
    两种情况下 __package__ / __name__ 路径不同, 用 sys.modules 兜底定位.

    测试场景下: 测试 fixture 通过 _EXT_MOD_OVERRIDE 或 sys.modules['h3pkg'] 注入
    目标 mod. handler 内部统一调用 _resolve_ext, 拿到目标 mod 后 _active / 引擎构造
    等都走同一路径, 测试桩才能命中.
    """
    # 1. 测试注入 (优先): _EXT_MOD_OVERRIDE (测试 fixture 显式设置)
    if _EXT_MOD_OVERRIDE is not None and _safe_hasattr(_EXT_MOD_OVERRIDE, "_active_lock"):
        return _EXT_MOD_OVERRIDE
    # 2. 测试注入 (peer 查找): sys.modules 里其他 threepov 模块的 override.
    # 必须先 snapshot list(sys.modules.items()) —— 协程并发下 dict 可能被改
    # (实测: 1.11c 波1 真机启动后 status 端点触发 RuntimeError, 2026-09-10).
    _this_mod = sys.modules.get(__name__)
    for _m_name, _m in list(sys.modules.items()):
        if _m is _this_mod:
            continue
        if _m_name.endswith("threepov") and _safe_hasattr(_m, "_EXT_MOD_OVERRIDE"):
            other_override = getattr(_m, "_EXT_MOD_OVERRIDE", None)
            if other_override is not None and _safe_hasattr(other_override, "_active_lock"):
                return other_override
    # 3. sys.modules["h3pkg"] (生产路径: __init__.py 注册到 sys.modules)
    _mod = sys.modules.get("h3pkg")
    if _mod is not None and _safe_hasattr(_mod, "_active_lock"):
        return _mod
    # 4. 终极兜底 — 同样 snapshot, 杜绝 RuntimeError: dict changed size during iteration.
    # 严格筛: _active_lock 必须为真值 (Lock 实例, 非 None). 第三方包 peft.tuners.hira
    # 也有同名 _active_lock=None + build_engine_from_params 属性 (v0.13+ 注入), 若仅
    # hasattr 检查会被错选为最后一项, 导致 submit 时 _ext._active_lock 为 None.
    # 优先匹配 __name__ 含 'H3' / 'h3pkg' 的真父包, 防御第三方同名属性.
    def _is_real_ext(m):
        try:
            lk = getattr(m, "_active_lock", None)
        except Exception:
            return False
        if lk is None:
            return False
        try:
            enter = getattr(lk, "__enter__", None)
        except Exception:
            return False
        if not callable(enter):
            return False
        try:
            bp = getattr(m, "build_engine_from_params", None)
        except Exception:
            return False
        if bp is None or not callable(bp):
            return False
        return True
    h3_candidates = [m for m in list(sys.modules.values())
                     if _is_real_ext(m) and "H3" in (getattr(m, "__name__", "") or "")]
    if h3_candidates:
        return h3_candidates[-1]
    candidates = [m for m in list(sys.modules.values()) if _is_real_ext(m)]
    if candidates:
        return candidates[-1]
    raise AttributeError("threepov: 无法定位父包模块 (__name__=%r __package__=%r)" % (
        __name__, __package__))


# ============ 路径 ============

def _threepov_dir(output_dir):
    return os.path.join(output_dir, THREEPOV_OUTPUT_SUBDIR)


def _registry_path(output_dir):
    return os.path.join(_threepov_dir(output_dir), REGISTRY_FILENAME)


def _manifest_path(output_dir, task_id):
    return os.path.join(_threepov_dir(output_dir),
                        MANIFEST_PREFIX + task_id + MANIFEST_SUFFIX)


def _asset_png_path(server_input_dir, task_id):
    return os.path.join(server_input_dir, "asset_library", "asset_images",
                        THREEPOV_ASSET_SUBDIR,
                        ASSET_PNG_FILENAME_FMT % task_id)


def _archive_threepov_png_path(server_input_dir, card_name):
    """卡名模式 PNG 固定名: archive_images/<卡名>/threepov.png (重出覆盖)."""
    return os.path.join(server_input_dir, "asset_library", "archive_images",
                        card_name, THREEPOV_CARD_PNG_NAME)


# image_path 模式参照图副本: <input_dir>/threepov_ref_<task_id>.png (input 根 + task_id 隔离命名).
# 必须落到 input_dir 根: 引擎 _resolve_file 用 basename join input_dir 找图 (batch_core.py:3903);
# 子目录位置 basename 不带路径, join 不到; 根目录 + task_id 命名已足够隔离.
THREEPOV_REF_BASENAME_FMT = "threepov_ref_%s.png"

# J3: 卡模式服装图副本 (槽 2) 同款落 input 根 + task_id 隔离命名 (与主图副本并列, 不撞名).
THREEPOV_OUTFIT_REF_BASENAME_FMT = "threepov_outfit_ref_%s.png"


def _image_ref_copy_path(server_input_dir, task_id):
    """image_path 模式参照图副本路径: <input_dir>/threepov_ref_<task_id>.png."""
    return os.path.join(server_input_dir, THREEPOV_REF_BASENAME_FMT % task_id)


# ============ 场景画布路径 (V1.12 T6, 独立命名空间) ============

def _scene_dir(output_dir):
    return os.path.join(output_dir, SCENE_OUTPUT_SUBDIR)


def _scene_registry_path(output_dir):
    return os.path.join(_scene_dir(output_dir), SCENE_REGISTRY_FILENAME)


def _scene_manifest_path(output_dir, task_id):
    return os.path.join(_scene_dir(output_dir),
                        SCENE_MANIFEST_PREFIX + task_id + MANIFEST_SUFFIX)


def _scene_asset_png_path(server_input_dir, task_id):
    """直接模式 PNG: asset_library/asset_images/scene_canvas/scene_canvas_<task_id>.png."""
    return os.path.join(server_input_dir, "asset_library", "asset_images",
                        SCENE_ASSET_SUBDIR, SCENE_ASSET_PNG_FILENAME_FMT % task_id)


def _scene_archive_png_path(server_input_dir, card_name):
    """卡名模式 PNG 固定名: archive_images/<卡名>/scene_canvas.png (重出覆盖)."""
    return os.path.join(server_input_dir, "asset_library", "archive_images",
                        card_name, SCENE_CARD_PNG_NAME)


def _scene_image_ref_copy_path(server_input_dir, task_id):
    """image_path 模式参照副本: <input_dir>/scene_canvas_ref_<task_id>.png."""
    return os.path.join(server_input_dir, SCENE_REF_BASENAME_FMT % task_id)


# ============ 道具画布路径 (V1.12b T3, 独立命名空间) ============

def _item_dir(output_dir):
    return os.path.join(output_dir, ITEM_OUTPUT_SUBDIR)


def _item_registry_path(output_dir):
    return os.path.join(_item_dir(output_dir), ITEM_REGISTRY_FILENAME)


def _item_manifest_path(output_dir, task_id):
    return os.path.join(_item_dir(output_dir),
                        ITEM_MANIFEST_PREFIX + task_id + MANIFEST_SUFFIX)


def _item_asset_png_path(server_input_dir, task_id):
    """直接模式 PNG: asset_library/asset_images/item_canvas/item_canvas_<task_id>.png."""
    return os.path.join(server_input_dir, "asset_library", "asset_images",
                        ITEM_ASSET_SUBDIR, ITEM_ASSET_PNG_FILENAME_FMT % task_id)


def _item_archive_png_path(server_input_dir, card_name):
    """卡名模式 PNG 固定名: archive_images/<卡名>/item_canvas.png (重出覆盖)."""
    return os.path.join(server_input_dir, "asset_library", "archive_images",
                        card_name, ITEM_CARD_PNG_NAME)


def _item_image_ref_copy_path(server_input_dir, task_id):
    """image_path 模式参照副本: <input_dir>/item_canvas_ref_<task_id>.png."""
    return os.path.join(server_input_dir, ITEM_REF_BASENAME_FMT % task_id)


def _safe_filename(name):
    """卡名清洗: 与 __init__.py:_h3_safe_filename 同口径 (禁止改 __init__.py).

    把 /\\ 与 .. 序列替为 _; 去除前后空白与点. 仅给卡名模式写 archive_images 子目录
    用 — 与存档存档存储主路径一致 (档案卡存储在 archive_docs/<safe_name>.json)."""
    if not isinstance(name, str):
        name = str(name)
    s = name.strip()
    while ".." in s:
        s = s.replace("..", "_")
    s = s.replace("/", "_").replace("\\", "_")
    s = s.strip().strip(".")
    return s


def _card_path(server_input_dir, card_name):
    """v3 档案卡路径: archive_docs/<safe_name>.json (与 _h3_post_assets 写盘同口径)."""
    return os.path.join(server_input_dir, "asset_library", "archive_docs",
                        _safe_filename(card_name) + ".json")


def _read_v3_card(server_input_dir, card_name):
    """读档案卡 → dict | None. 卡不存在/损坏/非 v3 → None.

    错误返回语义: 读盘失败返回 None (调用方区分 None=缺/坏; 非 v3 通过 _validate_v3_card)."""
    p = _card_path(server_input_dir, card_name)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _is_v3_character(card):
    """batch_core.resolve_cast 同口径: _v=3 + kind=character 才算合法 character 卡.
    语义参照 batch_core.py:444-446 (resolve_cast 错误码 not_v3_character)."""
    return (isinstance(card, dict)
            and card.get("_v") == 3
            and card.get("kind") == "character")


# F36 §3.1 (方案-F36-2026-10-01): 画布给法层 — 端点白名单子集 (CAST_ROW_USAGES ∩ 端点
# 语义; pose 不进画布参照池 — 与 batch_core.py:556 白名单数据契约一致, pose 行走
# prompt 文案通道).
_CANVAS_MEDIA_WHITELIST = {
    "character": ("subject_look", "三视图", "subject_outfit", "subject_prop"),
    "scene": ("scene",),
    "item": ("subject_prop", "道具多角度"),
}
# 画布参照槽上限 (槽域 1-8; 9 = 分镜动态衔接槽, 画布禁用).
_CANVAS_MEDIA_MAX = 8


def _iter_card_media(card, whitelist):
    """卡白名单行行序展开 → [(media, usage), ...] (media 归一 str: None/非 str → '').

    空 media 行保留为哨兵项 — _first_*_media 的"首行空即空不续扫"防御契约 (既有测试
    锁定) 依赖哨兵保序; 池构造消费方 (_collect_card_media) 滤空."""
    rows = (card or {}).get("rows") or []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        usage = r.get("usage")
        if usage not in whitelist:
            continue
        m = r.get("media")
        out.append((m if isinstance(m, str) else "", usage))
    return out


def _collect_card_media(card, kind):
    """F36 §3.1: 端点白名单行序展开收集画布参照 [(media, usage), ...].

    去空 (空 media 行剔除) / 去重 (同图保序首现 usage 生效) / 上限 _CANVAS_MEDIA_MAX
    (超限截断 + WARN 日志 — 卡数据可多于 8, 不阻断). 主锚点 = 行序首行白名单行
    (卡行序决定, [outfit 在前] 的卡 outfit 占槽 1)."""
    whitelist = _CANVAS_MEDIA_WHITELIST.get(kind) or ()
    out, seen, dropped = [], set(), 0
    for m, usage in _iter_card_media(card, whitelist):
        if not m or m in seen:
            continue
        if len(out) >= _CANVAS_MEDIA_MAX:
            dropped += 1
            continue
        seen.add(m)
        out.append((m, usage))
    if dropped:
        print("[H3Batch canvas] WARN: 卡名参照行超 %d, 截断 %d 行 (kind=%s)"
              % (_CANVAS_MEDIA_MAX, dropped, kind), flush=True)
    return out


def _first_look_media(card):
    """v3 character 卡首行 subject_look media (basename), 无/空 → ''.

    F36 E1 薄封装: 行序展开底座按 usage 过滤取首 (禁 [0] — 行序展开的 [0] 恒为
    行序首行白名单行, 不恒为 look). 防御契约保留: 首 look 行 media 空 → '' 不续扫."""
    for m, usage in _iter_card_media(card, _CANVAS_MEDIA_WHITELIST["character"]):
        if usage == "subject_look":
            return m
    return ""


def _first_prop_media(card):
    """v3 character 卡首行 subject_prop media (basename), 无/空 → ''.

    F36 E1 薄封装 (_collect_card_media 同底座, 按 usage 过滤取首); item_canvas 端点
    卡名模式消费该函数判 ref2v/t2v (非空 → ref2v, 空 → t2v). 防御契约同上."""
    for m, usage in _iter_card_media(card, _CANVAS_MEDIA_WHITELIST["character"]):
        if usage == "subject_prop":
            return m
    return ""


def _first_outfit_media(card):
    """v3 character 卡首行 subject_outfit media (绝对路径), 无/空 → ''.

    T-A 修法 1 (审查记录/T-A-三视图忽略服装-诊断报告.md §五.1): 卡名模式消费: 非空 →
    服装图进槽 2 (双参考, 用途 subject_outfit); 空 → 单槽现状. F36 E1 薄封装 (按 usage
    过滤取首); 防御契约保留: 首 outfit 行 media 空 → '' 不续扫."""
    for m, usage in _iter_card_media(card, _CANVAS_MEDIA_WHITELIST["character"]):
        if usage == "subject_outfit":
            return m
    return ""


def _is_v3_scene(card):
    """_v=3 且 kind="scene" 才算合法 scene 卡 (契约 #47: character 卡 → 400 not_v3_scene)."""
    return (isinstance(card, dict)
            and card.get("_v") == 3
            and card.get("kind") == "scene")


def _first_scene_media(card):
    """v3 scene 卡首行 usage=="scene" media (basename 由调用方取), 无/空 → ''.

    首 scene 行 media 非空 → ref2v (现画布为参照); 空 → t2v (契约 #47 行为 3).
    F36 E1 薄封装 (按 usage 过滤取首); 防御契约同 _first_look_media."""
    for m, usage in _iter_card_media(card, _CANVAS_MEDIA_WHITELIST["scene"]):
        if usage == "scene":
            return m
    return ""


def _extract_card_desc(card):
    """从 v3 character 卡 rows 收集非空 desc 拼接 (lookup 顺序不假定; 去重保序).

    卡 desc 越细越准 — 任务单验收: 卡 desc 拼入最终 prompt. rows 字段规范是 dict,
    含 desc 字段; rows 之间可能同名 usage 多行 (如多个 subject_look), 按行序拼接全部
    非空 desc 用中文分号 '；' 分隔."""
    rows = (card or {}).get("rows") or []
    parts = []
    for r in rows:
        if isinstance(r, dict):
            d = (r.get("desc") or "").strip()
            if d:
                parts.append(d)
    return "；".join(parts)


def _extract_card_ignore_words(card):
    """从 v3 卡 rows 收集非空 ignore_words (去重保序; 多行非空时合并为 'X、Y' 句).

    V1.14 整改批 K T2: 卡行级 ignore_words 字段 (字符串、缺省空串、视频链路同源
    batch_core.py:6639 一带 r.get("ignore_words","")). 多行非空合并用中文顿号 '、'
    (与卡表头的中文场景用词习惯一致; 去重保序避免重复行 spam).
    """
    rows = (card or {}).get("rows") or []
    parts = []
    seen = set()
    for r in rows:
        if isinstance(r, dict):
            iw = (r.get("ignore_words") or "").strip()
            if iw and iw not in seen:
                parts.append(iw)
                seen.add(iw)
    return "、".join(parts)


# ---- #61 (方案-61描述词忽略词生效-2026-10-30 §3.2.1/§3.2.2): 卡行 → Picture 槽映射 +
# 按图忽略句. 忽略词 = 显式覆盖开关: 某属性写入忽略词 → 该项不从参考图取, 以文字描述为准.
# 槽号来源 = _collect_card_media 去重结果 (1..N, 上限 8); 白名单外 usage / 空 media /
# 被截断行 → picture_no=0 (进全局句, 词不丢). 收全部卡行 (与 _extract_card_ignore_words
# 同范围, 含 pose/audio_ref 行).
_IGNORE_PREFIX_PATTERNS = (
    re.compile(r"^请?\s*忽略\s*"),
    re.compile(r"^(?:<\s*Picture\s*\d+\s*>|Picture\s*\d+)\s*(?:中|的)?\s*的?"),
    re.compile(r"^参考图[中的]\s*的?"),
    re.compile(r"^图片[中的]\s*的?"),
    re.compile(r"^图\s*中\s*的?"),
    re.compile(r"^该图[中的]?\s*的?"),
)


def _strip_ignore_prefix(word):
    """剥离开头 请?忽略 / <Picture N> 中|的 / Picture N 中|的 / 图片中|图片的|图中|
    参考图中|参考图的|该图 (UI 例文「忽略 Picture 2 中的人群」→「人群」)."""
    s = (word or "").strip()
    for pat in _IGNORE_PREFIX_PATTERNS:
        m = pat.match(s)
        if m:
            s = s[m.end():].strip()
    return s


def _normalize_ignore_words(words):
    """忽略词归一 (映射器内做一次): 拆分 [、,，] → 前缀剥离 → 去重保序 → 顿号回拼."""
    parts, seen = [], set()
    for raw in re.split(r"[、,，]", (words or "").strip()):
        w = _strip_ignore_prefix(raw)
        if w and w not in seen:
            seen.add(w)
            parts.append(w)
    return "、".join(parts)


def _map_card_rows_to_pictures(card, kind):
    """卡行 → [(picture_no, usage, desc, ignore_words), ...] (行序; 0 = 全局句).

    槽号来源 = _collect_card_media 去重结果 (1..N, 上限 8); 白名单外 usage / 空 media /
    被截断行 → 0. 忽略词在此归一一次 (段内与 retention 共用同一结果, 不产同词两形).
    """
    whitelist = _CANVAS_MEDIA_WHITELIST.get(kind) or ()
    slot_of = {}
    for i, (media, _usage) in enumerate(_collect_card_media(card, kind)):
        slot_of[media] = i + 1
    out = []
    for r in (card or {}).get("rows") or []:
        if not isinstance(r, dict):
            continue
        usage = r.get("usage")
        desc = r.get("desc") if isinstance(r.get("desc"), str) else ""
        iw = r.get("ignore_words") if isinstance(r.get("ignore_words"), str) else ""
        media = r.get("media")
        if usage in whitelist and isinstance(media, str) and media:
            pic = slot_of.get(media, 0)
        else:
            pic = 0
        out.append((pic, usage, desc.strip(), _normalize_ignore_words(iw)))
    return out


def _render_ignore_clause(mapped_rows):
    """按图忽略句: `忽略 <Picture 1> 中的X、Y；忽略 <Picture 2> 中的Z`; 全局词挂尾
    `；忽略 X`. 消费映射器归一结果 (不再二次剥离前缀), 跨行去重保序; 无词 → 空串."""
    groups, seen = {}, set()
    for row in mapped_rows or []:
        picture_no, words = row[0], row[3]
        for raw in re.split(r"[、,，]", words or ""):
            w = raw.strip()
            if not w or w in seen:
                continue
            seen.add(w)
            groups.setdefault(picture_no, []).append(w)
    parts = ["忽略 <Picture %d> 中的%s" % (pic, "、".join(groups[pic]))
             for pic in sorted(p for p in groups if p != 0)]
    if 0 in groups:
        parts.append("忽略 %s" % "、".join(groups[0]))
    return "；".join(parts)


def _h3_seg_text(pic, tag, attr, desc, iw):
    """H3 zh 段串 (与 batch_core._build_h3_subject_line 同句族/同分隔符)."""
    if desc:
        seg = "【%s】%s，%s以 <Picture %d> 的%s为准" % (tag, desc, attr, pic, attr)
    else:
        seg = "【%s】%s以 <Picture %d> 的%s为准" % (tag, attr, pic, attr)
    if iw:
        seg += "；忽略 <Picture %d> 中的%s" % (pic, iw)
    return seg


def _ref_seg_text(pic, noun, desc, iw):
    """场景/道具段串: `【noun】desc，noun以 <Picture N> 的参考为准[；忽略 …]`."""
    if desc:
        seg = "【%s】%s，%s以 <Picture %d> 的参考为准" % (noun, desc, noun, pic)
    else:
        seg = "【%s】%s以 <Picture %d> 的参考为准" % (noun, noun, pic)
    if iw:
        seg += "；忽略 <Picture %d> 中的%s" % (pic, iw)
    return seg


def _build_card_subject_segments(card, kind, mapped):
    """v2.1 逐用途主体句 — {DESC} 槽位替换为逐用途成句.

    有参考图 (存在 picture_no>0 行) 时一定产段; 无参考图/无映射 → "" (调用方回落
    _extract_card_desc, 整卡 desc 合并仅保留给 t2v). character 有 look 行复用
    batch_core._build_h3_subject_line (剥 "<Subject 1>: " 前缀); 无 look 行
    (outfit/prop-only) 用同句族逐行成段, 不回落整卡合并. picture_no=0 且有 desc 的行
    追加 【tag】desc (无锚定; tag 表外回落原 usage 串).
    """
    anchored = [r for r in (mapped or []) if r[0] > 0]
    if not anchored:
        return ""
    bc = _bc_mod()

    def _tag(usage):
        if not isinstance(usage, str) or not usage:
            return ""
        return bc._H3_SEG_TAG.get(usage, usage)

    parts = []
    if kind == "character":
        seg_rows = [r for r in anchored if r[1] in bc._H3_SEG_ORDER]
        if any(r[1] == "subject_look" for r in seg_rows):
            line = bc._build_h3_subject_line(1, seg_rows, "zh")
            if line and line.startswith("<Subject 1>: "):
                parts.append(line[len("<Subject 1>: "):])
        else:
            order = {u: i for i, u in enumerate(bc._H3_SEG_ORDER)}
            for pic, usage, desc, iw in sorted(
                    seg_rows, key=lambda r: (order[r[1]], r[0])):
                parts.append(_h3_seg_text(pic, _tag(usage), bc._H3_SEG_ATTR[usage],
                                          desc, iw))
    elif kind == "scene":
        for pic, usage, desc, iw in anchored:
            if usage == "scene":
                parts.append(_ref_seg_text(pic, "场景", desc, iw))
    elif kind == "item":
        for pic, usage, desc, iw in anchored:
            tag = _tag(usage)
            if tag:
                parts.append(_ref_seg_text(pic, tag, desc, iw))
    for pic, usage, desc, _iw in mapped or []:
        tag = _tag(usage)
        if pic == 0 and desc and tag:
            parts.append("【%s】%s" % (tag, desc))
    return "；".join(p for p in parts if p)


# ---- #61 §3.2.4: 模板覆盖句 (仅 override 时应用, 在 {DESC} 替换之前) ----
# (OLD, NEW) 常量对逐条 count()==1 断言 — 模板漂移即 RuntimeError, 不静默降级.
_OVERRIDE_CLAUSES = {
    "character": (
        ("WHAT IS TAKEN FROM THE REFERENCE IMAGE: the subject exactly as it already is.",
         "WHAT IS TAKEN FROM THE REFERENCE IMAGE: the subject as it is, except the "
         "excluded attributes listed in retention_analysis; those follow the written description."),
        ("Nothing is redesigned, restyled, simplified, tidied, embellished, modernised "
         "or improved,",
         "Except for the excluded attributes, nothing is redesigned, restyled, "
         "simplified, tidied, embellished, modernised or improved,"),
        ("with the same face, the same hair, the same clothing and the same proportions.",
         "with the same face, and the same hair and clothing as described above, except "
         "the excluded attributes."),
        ("her hair falling down her back.", "her hair as described above."),
        ("her hair framing her face.", "her hair as described above."),
        # v2.2/T6: 覆盖模式显式约束块 (仅 character + override; 按锁定 OLD/NEW 对紧贴
        # 冻结帧句前, 末位权重高). 注: 模板实际段序为 FROZEN 段在 "No text, letters ..."
        # 负向清单之前 (方案 §4.2.7 "置于负向清单后" 与模板段序不符, 以 OLD/NEW 对为准).
        # 依据 = 第一轮真机 run2/3/4 失败模式 (特写服装失控/第2格视角退化/发长不一致/空行穿模).
        ("This is a FROZEN FRAME. Nothing moves at all.",
         "OVERRIDE CONSTRAINTS - these win over any conflicting instruction above:\n"
         "- The character wears ONLY the outfit described above. Do NOT copy any "
         "clothing from the reference image. No white shirt, no shirt collar, no "
         "buttoned placket, no white blouse or underlayer, no pinafore over a white "
         "shirt.\n"
         "- The close-up panel is framed at the chest: her face, neck, shoulders and "
         "the outfit's neckline and shoulder fabric are visible. No bare shoulders, "
         "no exposed chest.\n"
         "- Panel 2 is a THREE-QUARTER FRONT view with her face visible. It is not "
         "her back and not a profile.\n"
         "- The hairstyle and hair length are identical in all four panels, including "
         "the close-up. The close-up must not show longer hair.\n"
         "- Exactly four panels: no partial cells, no empty rows above or below the "
         "panels, no grid line crossing a figure.\n"
         "\n"
         "This is a FROZEN FRAME. Nothing moves at all."),
    ),
    "scene": (
        ("the scene exactly as it already is.",
         "the scene as it is, except the excluded attributes listed in retention_analysis; those follow "
         "the written description."),
        ("Nothing is redesigned, simplified or embellished,",
         "Except for the excluded attributes, nothing is redesigned, simplified or "
         "embellished,"),
        ("the same layout and the same main elements are identical across all "
         "four views.",
         "the same layout and the same main elements are identical across all "
         "four views, except the excluded attributes."),
    ),
    "item": (
        ("the object exactly as it already is.",
         "the object as it is, except the excluded attributes listed in retention_analysis; those follow "
         "the written description."),
        ("Every part, surface, colour and material is exactly as it appears there.",
         "Every part, surface, colour and material is exactly as it appears there, "
         "except the excluded attributes listed in retention_analysis; those follow the written "
         "description."),
        ("Nothing is redesigned, restyled, simplified, tidied, embellished, modernised "
         "or improved,",
         "Except for the excluded attributes, nothing is redesigned, restyled, "
         "simplified, tidied, embellished, modernised or improved,"),
        ("with the same colours, materials, proportions and number of parts.",
         "with the same colours, materials, proportions and number of parts, except the "
         "excluded attributes."),
    ),
}


def _apply_override_clauses(template, kind):
    """按 kind 应用模板覆盖句; 目标句 count()!=1 → RuntimeError (模板漂移 fail loud)."""
    pairs = _OVERRIDE_CLAUSES.get(kind)
    if not pairs:
        raise RuntimeError("threepov: 未知覆盖句 kind: %r" % (kind,))
    for old, new in pairs:
        n = template.count(old)
        if n != 1:
            raise RuntimeError(
                "threepov: %s 模板覆盖目标句 count=%d (应恰为 1): %r" % (kind, n, old))
        template = template.replace(old, new, 1)
    return template


# 有图版 + 忽略词: 基础句尾接例外句 (基础句尾句号由调用点剥离).
_RETENTION_EXCEPT = (
    ", EXCEPT the attributes listed below; those follow the written description and "
    "must not be copied from the reference.")


def _render_retention_block(has_picture, ignore_words, kind, ignore_clause=""):
    """渲染 retention_analysis 段 (有图版 + 无图版 共 4 种形态 × 3 kind).

    ignore_words 非空 → partially_preserved (有图版) / No reference image is used...
    (t2v) + EXCLUDED 声明 (含中文忽略词直嵌);
    ignore_words 为空 → fully_preserved (有图版) / No reference image is used... (t2v).

    V1.14 整改批 K T2: 消除人物模板硬编码 partially_preserved 中间态 (B 档 T1 复核登记
    'partially_preserved 中间态待 T2' — T1 时人物模板硬编码 partially_preserved + 通用
    EXCLUDED 声明, 该中间态应迁由 ignore_words 触发). 无忽略词 → 人物走 fully_preserved
    (与其他两类一致); 有忽略词 → partially_preserved + 特定 EXCLUDED 声明 (含中文忽略词
    直嵌). v10 教训: 排除槽之外不自动加正面态补充.

    #61 (§3.2.3): 有图版且给出按图 ignore_clause → 基础句尾接例外句 + ignore_clause
    (忽略项以文字描述为准); t2v 维持 ignore_words 旧负向句 (无参考可忽略, 语义不变).
    """
    iw = (ignore_words or "").strip()
    clause = (ignore_clause or "").strip()
    if has_picture:
        if kind == "scene":
            base = ("<Picture 1>: fully_preserved - the spatial layout, all visible elements, "
                    "their colours, materials and the lighting atmosphere are retained. Nothing "
                    "is added, nothing is removed, nothing is relocated.")
        elif kind == "item":
            base = ("<Picture 1>: fully_preserved - the shape, colours, materials, proportions "
                    "and every detail of the object are retained exactly as shown.")
        else:  # character
            base = ("<Picture 1>: fully_preserved - the subject, her face, her hair, her clothing "
                    "and her overall appearance are retained exactly as shown.")
        if clause:
            partially = base.replace("fully_preserved", "partially_preserved", 1)
            stem = partially[:-1] if partially.endswith(".") else partially
            return stem + _RETENTION_EXCEPT + " " + clause
        if not iw:
            return base
        partially = base.replace("fully_preserved", "partially_preserved", 1)
        return (partially + " " + iw
                + " is EXCLUDED and must not appear anywhere in the output.")
    else:
        if kind == "scene":
            base = ("No reference image is used. The scene is generated strictly from the "
                    "written description above.")
        elif kind == "item":
            base = ("No reference image is used. The object is generated strictly from the "
                    "written description above.")
        else:  # character
            base = ("No reference image is used. The subject is generated strictly from the "
                    "written description above.")
        if not iw:
            return base
        return (base + " " + iw
                + " is EXCLUDED and must not appear anywhere in the output.")


def _save_card_with_threepov_row(server_input_dir, card_name, original_card,
                                   png_abs_path):
    """写卡: 原卡 rows 保留, 新增/覆盖 '三视图' 行 (media = png_abs_path).

    原 subject_look 行字节不变 (走 list 浅拷贝, 原地改 rows). 重出=覆盖同名行
    (按 usage 查重). atomic write (tmp + os.replace)."""
    card = dict(original_card or {})
    rows = list(card.get("rows") or [])
    new_rows = []
    replaced = False
    for r in rows:
        r_copy = dict(r) if isinstance(r, dict) else r
        if isinstance(r_copy, dict) and r_copy.get("usage") == "三视图":
            r_copy["media"] = png_abs_path
            replaced = True
        new_rows.append(r_copy)
    if not replaced:
        new_rows.append({
            "usage": "三视图",
            "kind": "Picture",
            "media": png_abs_path,
            "slot": "1",
            "desc": "",
        })
    card["rows"] = new_rows
    p = _card_path(server_input_dir, card_name)
    tmp = p + ".tmp"
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)
    return p


def _save_card_with_scene_row(server_input_dir, card_name, original_card,
                              png_abs_path):
    """写卡 (V1.12 T6): 原卡 rows 保留, 写回/覆盖 usage=="scene" 行 (media = png_abs_path).

    按 usage 查重: 已有 scene 行 → 只改 media (desc 等其余字段不动); 无 → 追加
    {usage:"scene", kind:"Picture", media, slot:"1", desc:""}. 其他行字节不变.
    atomic write (tmp + os.replace)."""
    card = dict(original_card or {})
    new_rows = []
    replaced = False
    for r in list(card.get("rows") or []):
        r_copy = dict(r) if isinstance(r, dict) else r
        if isinstance(r_copy, dict) and r_copy.get("usage") == "scene":
            r_copy["media"] = png_abs_path
            replaced = True
        new_rows.append(r_copy)
    if not replaced:
        new_rows.append({
            "usage": "scene",
            "kind": "Picture",
            "media": png_abs_path,
            "slot": "1",
            "desc": "",
        })
    card["rows"] = new_rows
    p = _card_path(server_input_dir, card_name)
    _write_json_atomic(p, card)
    return p


def _save_card_with_item_row(server_input_dir, card_name, original_card,
                             png_abs_path):
    """写卡 (V1.12b T3): 原卡 rows 保留, 写回/覆盖 usage=="道具多角度" 行 (media = png_abs_path).

    按 usage 查重: 已有 道具多角度 行 → 只改 media (desc 等其余字段不动); 无 → 追加
    {usage:"道具多角度", kind:"Picture", media, slot:"1", desc:""}. 其他行字节不变
    (与 _save_card_with_threepov_row / _save_card_with_scene_row 同构; M4 I2 修正:
    只覆盖本端点产物行, 用户原有 subject_prop/scene/三视图 行 media 不动).
    atomic write (tmp + os.replace)."""
    card = dict(original_card or {})
    new_rows = []
    replaced = False
    for r in list(card.get("rows") or []):
        r_copy = dict(r) if isinstance(r, dict) else r
        if isinstance(r_copy, dict) and r_copy.get("usage") == "道具多角度":
            r_copy["media"] = png_abs_path
            replaced = True
        new_rows.append(r_copy)
    if not replaced:
        new_rows.append({
            "usage": "道具多角度",
            "kind": "Picture",
            "media": png_abs_path,
            "slot": "1",
            "desc": "",
        })
    card["rows"] = new_rows
    p = _card_path(server_input_dir, card_name)
    _write_json_atomic(p, card)
    return p


# ============ 注册表读写 ============

def _read_json_dict(path):
    """读 JSON → dict; 文件缺失/损坏/非 dict → {} (不抛)."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_atomic(path, data):
    """atomic write (tmp + os.replace); 父目录自动创建."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _load_registry(output_dir):
    p = _registry_path(output_dir)
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_registry(output_dir, data):
    p = _registry_path(output_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def _set_status(output_dir, task_id, status, *, result_png_path=None, error=None):
    """原子更新单个任务状态 (短临界区)."""
    reg = _load_registry(output_dir)
    entry = dict(reg.get(task_id) or {})
    entry["status"] = status
    entry["ts"] = int(time.time())
    if result_png_path is not None:
        entry["result_png_path"] = result_png_path
    if error is not None:
        entry["error"] = error
    reg[task_id] = entry
    _save_registry(output_dir, reg)


# ---- 场景画布注册表 (V1.12 T6, 独立目录/文件, 与 threepov 注册表互不影响) ----

def _load_scene_registry(output_dir):
    return _read_json_dict(_scene_registry_path(output_dir))


def _save_scene_registry(output_dir, data):
    _write_json_atomic(_scene_registry_path(output_dir), data)


def _set_scene_status(output_dir, task_id, status, *, result_png_path=None, error=None):
    """原子更新单个场景画布任务状态 (短临界区)."""
    reg = _load_scene_registry(output_dir)
    entry = dict(reg.get(task_id) or {})
    entry["status"] = status
    entry["ts"] = int(time.time())
    if result_png_path is not None:
        entry["result_png_path"] = result_png_path
    if error is not None:
        entry["error"] = error
    reg[task_id] = entry
    _save_scene_registry(output_dir, reg)


# ---- 道具画布注册表 (V1.12b T3, 独立目录/文件, 与 threepov/scene_canvas 注册表互不影响) ----

def _load_item_registry(output_dir):
    return _read_json_dict(_item_registry_path(output_dir))


def _save_item_registry(output_dir, data):
    _write_json_atomic(_item_registry_path(output_dir), data)


def _set_item_status(output_dir, task_id, status, *, result_png_path=None, error=None):
    """原子更新单个道具画布任务状态 (短临界区)."""
    reg = _load_item_registry(output_dir)
    entry = dict(reg.get(task_id) or {})
    entry["status"] = status
    entry["ts"] = int(time.time())
    if result_png_path is not None:
        entry["result_png_path"] = result_png_path
    if error is not None:
        entry["error"] = error
    reg[task_id] = entry
    _save_item_registry(output_dir, reg)


# ============ 渲染接线 ============

def _build_threepov_prompt(user_text, *, has_picture=True, ignore_words="",
                           ignore_clause="", override=False):
    """拼装模板 C 六段式英文骨架 + 中文 desc 直嵌 → 最终 prompt.

    has_picture=True (默认, ref2v): 用 _TEMPLATE_C (含 <Picture 1> 引用 + 官方保留 token +
    WHAT IS TAKEN FROM THE REFERENCE 块); False (t2v): 用 _TEMPLATE_C_T2V (首句无 <Picture 1> 引用,
    retention_analysis 纯声明句, 详细描述去 WHAT IS TAKEN FROM THE REFERENCE 块 — 设计附录 A).
    中文 desc 通过 {DESC} 槽位注入 subject_definitions 首句; retention_analysis 段
    通过 {RETENTION_BLOCK} 槽位由 _render_retention_block 渲染 (V1.14 T2 接入 ignore_words).
    #61: ignore_clause = 按图忽略句 (挂 retention 例外句后); override=True (门禁
    = bool(refs) and bool(clause)) 时在 {DESC} 替换之前应用模板覆盖句.
    模板恰含 1 个 {DESC} + 1 个 {RETENTION_BLOCK} (自检). 产出 prompt 必含六段全部字段名
    (subject_definitions/summary/retention_analysis/detailed_description/overall_soundscape/
    non_diegetic_music) 且段序固定.
    """
    template = _TEMPLATE_C if has_picture else _TEMPLATE_C_T2V
    if override:
        template = _apply_override_clauses(template, "character")
    if template.count("{DESC}") != 1:
        raise RuntimeError("threepov: 模板 C 描述槽异常, 应恰含 1 个 {DESC}")
    if template.count("{RETENTION_BLOCK}") != 1:
        raise RuntimeError("threepov: 模板 C 忽略槽异常, 应恰含 1 个 {RETENTION_BLOCK}")
    result = template.replace("{DESC}", user_text, 1)
    result = result.replace(
        "{RETENTION_BLOCK}",
        _render_retention_block(has_picture, ignore_words, "character",
                                ignore_clause=ignore_clause), 1)
    return result


def _build_scene_canvas_prompt(user_text, *, has_picture=True, ignore_words="",
                               ignore_clause="", override=False):
    """拼装场景画布六段式英文骨架 + 中文 desc → 最终 prompt.

    形态与 _build_threepov_prompt 同构, 走 _TEMPLATE_SCENE / _TEMPLATE_SCENE_T2V 分支.
    V1.14 T2: 新增 ignore_words 槽位 (T2 文档: 假保留同样中间态消除机制).
    #61: 同 _build_threepov_prompt (ignore_clause + override).
    """
    template = _TEMPLATE_SCENE if has_picture else _TEMPLATE_SCENE_T2V
    if override:
        template = _apply_override_clauses(template, "scene")
    if template.count("{DESC}") != 1:
        raise RuntimeError("threepov: 场景模板描述槽异常, 应恰含 1 个 {DESC}")
    if template.count("{RETENTION_BLOCK}") != 1:
        raise RuntimeError("threepov: 场景模板忽略槽异常, 应恰含 1 个 {RETENTION_BLOCK}")
    result = template.replace("{DESC}", user_text, 1)
    result = result.replace(
        "{RETENTION_BLOCK}",
        _render_retention_block(has_picture, ignore_words, "scene",
                                ignore_clause=ignore_clause), 1)
    return result


def _build_item_canvas_prompt(user_text, *, has_picture=True, ignore_words="",
                              ignore_clause="", override=False):
    """拼装道具画布六段式英文骨架 + 中文 desc → 最终 prompt.

    形态与 _build_threepov_prompt / _build_scene_canvas_prompt 同构, 走
    _TEMPLATE_ITEM / _TEMPLATE_ITEM_T2V 分支. V1.14 T2: 新增 ignore_words 槽位.
    #61: 同 _build_threepov_prompt (ignore_clause + override).
    """
    template = _TEMPLATE_ITEM if has_picture else _TEMPLATE_ITEM_T2V
    if override:
        template = _apply_override_clauses(template, "item")
    if template.count("{DESC}") != 1:
        raise RuntimeError("threepov: 道具模板描述槽异常, 应恰含 1 个 {DESC}")
    if template.count("{RETENTION_BLOCK}") != 1:
        raise RuntimeError("threepov: 道具模板忽略槽异常, 应恰含 1 个 {RETENTION_BLOCK}")
    result = template.replace("{DESC}", user_text, 1)
    result = result.replace(
        "{RETENTION_BLOCK}",
        _render_retention_block(has_picture, ignore_words, "item",
                                ignore_clause=ignore_clause), 1)
    return result


# ---- 单视角拼装函数 (保留设施, 单格重补备用; 不进生成链) ----

def _view_line(kind, view):
    """取 kind 的第 view 条单视角指令 (0 起). kind/下标非法 → ValueError (不静默取错视角)."""
    lines = _CANVAS_VIEW_LINES.get(kind)
    if lines is None:
        raise ValueError("threepov: 未知画布 kind: %r" % kind)
    if isinstance(view, bool) or not isinstance(view, int) or not 0 <= view < len(lines):
        raise ValueError("threepov: 视角下标越界: %r (应 0-%d)" % (view, len(lines) - 1))
    return lines[view]


def _build_threepov_view_prompt(user_text, view):
    """人物单视角 prompt: 视角指令 + "角色设定：<text>。" + 一致性/影棚背景锚定句."""
    return ("[单一视角] 这是一张人物设定参考图，仅一个视角、一格画面，禁止分格与多面板。"
            "%s角色设定：%s。%s"
            % (_view_line("character", view), user_text, _VIEW_COMMON_C_ZH))


def _build_scene_view_prompt(user_text, view):
    """场景单视角 prompt: 机位指令 + "场景设定：<text>。" + 忠实锚定/构图互不相同句."""
    return ("[单一视角] 这是一张场景设定参考图，仅一个机位、一格画面，禁止分格与多面板。"
            "%s场景设定：%s。%s"
            % (_view_line("scene", view), user_text, _VIEW_COMMON_SCENE_ZH))


def _build_item_view_prompt(user_text, view):
    """道具单视角 prompt: 视角指令 + "道具描述：<text>。" + 同物锚定/灰底禁室内句."""
    return ("[单一视角] 这是一张道具设定参考图，仅一个视角、一格画面，禁止分格与多面板。"
            "%s道具描述：%s。%s"
            % (_view_line("item", view), user_text, _VIEW_COMMON_ITEM_ZH))


# ============ 画布配置 (J2b: h3_config「canvas」段读取/模板选择/覆写参数) ============

def _bc_mod():
    """batch_core 模块对象 (配置读取/模板解析/判族/覆写解析 复用面; 父包已 re-export).

    逐调用解析 (不缓存) — 测试打桩与生产同路径 (_resolve_ext 先例).
    """
    return _resolve_ext().batch_core


def _canvas_norm(key, value, default):
    """canvas 键值归一 (卡 §2 键表): 缺失/空值/形态不符 → 默认值.

    值域与结构校验不在端点层 replicate (卡 §4 总原则): 数字串/覆写对象等原样落 CSV/引擎参数,
    由引擎既有软回退 (分辨率/步数/时长前检) 与解析函数 (_parse_lora_overrides /
    _parse_overrides → 400 engine_init) 承担.
    """
    if key in ("megapixels", "duration_seconds"):
        # number|数字串 (卡 §2 值形态: 写 CSV 前 str()); 非数字 → 默认 (F3 软回退)
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str) and value.strip():
            try:
                float(value)
            except ValueError:
                return default
            return value
        return default
    if key == "seed":
        # int|整数字串; 0 = 随机语义随 CSV 字面传递 (卡 §7-1: 不得实现为固定种子)
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            return str(value)
        if isinstance(value, str) and value.strip():
            try:
                int(value)
            except ValueError:
                return default
            return value
        return default
    if key in ("lora_overrides", "resource_overrides"):
        # object; 仅 None (空值) 视同缺省; 其余值原样交给引擎解析函数判结构 (卡 §2 值形态)
        return default if value is None else value
    # str 类 (ref2v_workflow / t2v_workflow / aspect / steps): 非 str / 空串 → 默认
    if isinstance(value, str) and value.strip():
        return value
    return default


def _canvas_config():
    """读 h3_config.json「canvas」段 (实时; 每次提交/建档重读).

    缺块/缺键/损坏/非对象 → 全默认 (F4 裁决: 非对象视同无配置, 与 _load_h3_config 损坏回退口径对齐).
    """
    raw = _bc_mod()._load_h3_config()
    sec = raw.get(CANVAS_SECTION) if isinstance(raw, dict) else None
    if not isinstance(sec, dict):
        sec = {}
    return {k: _canvas_norm(k, sec.get(k), dv) for k, dv in CANVAS_DEFAULTS.items()}


def _canvas_request_param(body, key):
    """请求面覆盖参数 (卡 §3): 已给出且非空 → 原样透传; 缺省/None/空串 → None (未给出).

    类型不给保证 (str 之外的值同样透传) — lora/resource 结构校验单源 = 引擎解析函数.
    """
    if not isinstance(body, dict) or key not in body:
        return None
    v = body[key]
    if v is None:
        return None
    if isinstance(v, str) and not v.strip():
        return None
    return v


def _canvas_engine_param(body, key, cfg_value):
    """引擎参数字符串: 优先级 请求 (原样透传) > 配置/默认 (对象 → 紧凑 JSON 文本, 卡 §2 值形态)."""
    v = _canvas_request_param(body, key)
    if v is not None:
        return v
    return json.dumps(cfg_value, ensure_ascii=False, separators=(",", ":"))


def _canvas_media_request_overrides(body, cfg):
    """R-03 (批②): 请求三可选键 aspect/megapixels/duration_seconds 合并进画布配置.

    仅形态校验 (实施条件 3): aspect 非空 str / 两数字键 int·float·数字串 → 覆盖配置
    对应键; 缺省/形态不符 → 软回退配置值 (不新增 400); 值域不在端点层校验, 域外
    数值原样透传由既有 linter/生成侧兜底 (与 _canvas_norm 配置面同口径).
    """
    out = dict(cfg)
    v = _canvas_request_param(body, "aspect")
    if isinstance(v, str):
        out["aspect"] = v
    for key in ("megapixels", "duration_seconds"):
        v = _canvas_request_param(body, key)
        if v is None or isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            out[key] = str(v)
        elif isinstance(v, str):
            try:
                float(v)
            except ValueError:
                continue
            out[key] = v
    return out


def _canvas_workflow(has_ref, override, cfg):
    """画布模板选择 + 提交时族校验 (卡 §4 模板族行 / §3 参数表 / F5).

    优先级: 请求 override (str 非空) > 配置 ref2v_workflow / t2v_workflow > 内置默认.
    Returns (abs_path, error): error 非空 = 应 400 (error 即信封 error 值).

    判据序 (批入口先例 __init__.build_batch_engine_from_params: 先判废除族):
      ① i2v/fl2v → RETIRED_TEMPLATE_MSG (单源 batch_core._retired_template_error, 拼模板名);
      ② 文件不存在 → canvas_template_not_found;
      ③ 判族 != 输入面对应族 (有图→ref2v / 无图→t2v; 判不出族归此档 F5) → canvas_template_mismatch.
    """
    _bcm = _bc_mod()
    raw = override if (isinstance(override, str) and override.strip()) else None
    if raw is None:
        raw = cfg["ref2v_workflow"] if has_ref else cfg["t2v_workflow"]
    path = _bcm._resolve_workflow_path(raw)
    retired = _bcm._retired_template_error(path)
    if retired:
        return "", retired
    if not path or not os.path.isfile(path):
        return "", "canvas_template_not_found: 模板文件不存在: %s" % (path or raw)
    want = "ref2v" if has_ref else "t2v"
    got = _bcm._template_mode(path)
    if got != want:
        return "", ("canvas_template_mismatch: 模板族不符: 需 %s, 实为 %s (%s)"
                    % (want, got or "判不出", os.path.basename(path)))
    return path, ""


def _canvas_csv_keys(canvas):
    """画布 CSV 键值: canvas None/缺键 → 默认 (= 现状字面值, 零回归).

    返回 (shot 段键, globals 全局键); 值以 str 落 CSV (build_csv 前约定).
    """
    c = dict(CANVAS_DEFAULTS)
    if canvas:
        c.update(canvas)
    return ({"段落时长": c["duration_seconds"], "种子": c["seed"]},
            {"比例": c["aspect"], "质量": c["megapixels"], "步数": c["steps"],
             "提示词": "", "语言": "中文"})


def _canvas_pool_rows(refs, *, override=False):
    """F36 §3.2 (方案-F36-2026-10-01): 画布池构造纯函数 — refs [(槽号, 文件名, usage), ...]
    → (pool 增量, pool_usage 增量, prompt 追加段).

    prompt 追加段顺序不变量: 锚定句 (槽号升序逐槽, _canvas_anchor_sentence) 在前,
    标签序列 (" <Picture N>" 空格前缀逐槽) 在后 — 与 J3 现行拼装序逐字节一致.
    usage 为空的槽不进 pool_usage (J1 单图裸池行锁).
    #61: override=True → 逐槽锚定句带忽略例外尾 (池/用途/标签不变)."""
    pool_inc, usage_inc, anchors, tags = {}, {}, [], []
    for slot, fname, usage in sorted(refs, key=lambda t: t[0]):
        pool_inc[str(slot)] = fname
        if usage:
            usage_inc[str(slot)] = [usage]
        anchors.append(_canvas_anchor_sentence(usage, slot, override=override))
        tags.append(" <Picture %d>" % slot)
    return ({"Picture": pool_inc}, {"Picture": usage_inc},
            "".join(anchors) + "".join(tags))


def _canvas_ref_basename(ref_basename_fmt, slot, usage, task_id):
    """F36 §3.4 命名公式: 槽 1 沿用各端点现行 REF_BASENAME_FMT (J1 兼容);
    槽 2 且 usage=subject_outfit 沿用 threepov_outfit_ref (J3 兼容·按 usage 判定特例);
    其余 n≥2 → <端点前缀>_ref{n}_<tid>.png (如 scene_canvas_ref2_<tid>.png)."""
    if slot == 2 and usage == "subject_outfit":
        return THREEPOV_OUTFIT_REF_BASENAME_FMT % task_id
    if slot <= 1:
        return ref_basename_fmt % task_id
    prefix = ref_basename_fmt.split("_ref_")[0]
    return "%s_ref%d_%s.png" % (prefix, slot, task_id)


def _canvas_csv_refs(picture_ref, outfit_ref, refs):
    """F36 E2: _write_*_csv 槽表归一 — refs 给定时直用 (多槽面), 否则走现行
    picture_ref/outfit_ref 翻译 (E1 规则, 单图路径逐字节不变)."""
    if refs is not None:
        return list(refs)
    out = []
    if picture_ref:
        out.append((1, picture_ref, "subject_look" if outfit_ref else None))
    if outfit_ref:
        out.append((2, outfit_ref, "subject_outfit"))
    return out


def _write_threepov_csv(input_dir, prompt_text, *, picture_ref="", outfit_ref="", refs=None,
                        canvas=None, view=None, ignore_words="", ignore_clause=""):
    """构造 1 段 2s 便宜档 CSV; 复用 quick_data_to_csv_data + _canvas_pool_rows + build_csv.

    view: None (默认 — 生成链) → 四格模板 prompt (_build_threepov_prompt);
        0-3 (单格重补备用) → 单视角 prompt (_build_threepov_view_prompt).
    picture_ref: 非空 → 参照图进池 Picture 槽 1 (ref2v 模式, 经 apply_shot_pool 标签路由
        接 ref_images.ref_image_0) + prompt 追加参考锚定句与 <Picture 1> 标签;
        空 → 纯文字 (池空, t2v 模式).
    outfit_ref: 非空 (需 picture_ref 同给 — 槽 1 主图 / 槽 2 服装) → 双槽: 服装图补
        pool.Picture.2 + 双槽用途标注 (1=subject_look, 2=subject_outfit, csv_gen 原生
        "文件名|用途" 池行) + prompt 追加服装锚定句 + <Picture 2> 标签;
        空 → 单槽现状逐字节不变 (槽 1 裸文件名).
    F36 E1: 槽构造收敛为 _canvas_pool_rows 薄壳 (J3 手工双槽段删除, 行为等价);
        对外签名不变 (picture_ref/outfit_ref 形参保留), handler 调用点 E2 才泛化.
    F36 E2: 新参 refs — 全量槽表 [(槽号, basename, usage), ...] (多槽面直用,
        _canvas_csv_refs 归一); None → 现行 picture_ref/outfit_ref 翻译 (单图路径
        逐字节不变). has_picture 随槽表非空.
    ignore_words: V1.14 T2 — 卡行级忽略词 (中文, 视频链路同源), 由 handler 从卡 rows 收集
        (顿号拼接去重); 非空 → retention_analysis 切 partially_preserved + EXCLUDED 声明;
        空 → fully_preserved. text/image_path 模式无卡数据 → 走空串默认.
    ignore_clause: #61 — 按图忽略句 (_render_ignore_clause 产物); 非空且有图 →
        override 门禁 = bool(refs) and bool(clause): retention 例外句 + 模板覆盖句 +
        锚定句例外; 无图/空 → 原样路径 (t2v 负向句).
    返回: (csv_path) — 引擎构造所需的 csv 绝对路径.
    """
    from .csv_gen import build_csv
    from .quick_shot import quick_data_to_csv_data
    # F36 E1: 双槽参数翻成画布槽表 (槽 1 主图 / 槽 2 服装 — J3 现行槽序). 单图 (无
    # outfit) 槽 1 无用途标注 — J1/J3 单图裸池行字节锁.
    refs = _canvas_csv_refs(picture_ref, outfit_ref, refs)
    override = bool(refs) and bool((ignore_clause or "").strip())
    pool_inc, usage_inc, prompt_tail = _canvas_pool_rows(refs, override=override)
    full_prompt = (_build_threepov_prompt(prompt_text, has_picture=bool(refs),
                                          ignore_words=ignore_words,
                                          ignore_clause=ignore_clause,
                                          override=override) if view is None
                   else _build_threepov_view_prompt(prompt_text, view)) + prompt_tail
    shot_extra, globals_ = _canvas_csv_keys(canvas)
    shot = {"ID": "s01", "prompt": full_prompt, "导出文件名": "s01"}
    shot.update(shot_extra)
    csv_data = quick_data_to_csv_data([shot], globals_)
    csv_data["pool"]["Picture"].update(pool_inc["Picture"])
    if usage_inc["Picture"]:
        csv_data["pool_usage"] = usage_inc
    text_out = build_csv("分镜", csv_data)
    # 落 input_dir 根 (与既有 h3_batch_*.csv 同口径); 单格重补带视角下标防同秒互覆.
    # 确保目录存在 — 测试夹具 (tmp_path) 在多个测试间可能清理目录, 真机 input_dir 通常已存在.
    name = "threepov_%d%s.csv" % (int(time.time()),
                                  "" if view is None else "_%d" % view)
    path = os.path.join(input_dir, name)
    os.makedirs(input_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(text_out)
    return path


def _write_scene_canvas_csv(input_dir, prompt_text, *, picture_ref="", refs=None, canvas=None,
                          view=None, ignore_words="", ignore_clause=""):
    """场景画布 1 段 2s 便宜档 CSV (与 _write_threepov_csv 同构).

    view: None (默认 — 生成链) → 四格模板 prompt (_build_scene_canvas_prompt);
        0-3 (单格重补备用) → 单视角 prompt (_build_scene_view_prompt, 四机位).
    picture_ref 非空 → 池 Picture 1 接种 (ref2v) + 参考锚定句; 空 → 纯文字 (t2v).
    F36 E1: 槽构造收敛为 _canvas_pool_rows 薄壳 (单图槽 1 无用途标注 — 现状字节锁);
        对外签名不变, handler 调用点 E2 才泛化.
    F36 E2: 新参 refs — 全量槽表 [(槽号, basename, usage), ...] (多槽面直用); None →
        现行单图翻译. has_picture 随槽表非空.
    canvas: J2b 画布配置 (缺省 None → 现状字面值).
    ignore_words: V1.14 T2 — 同 _write_threepov_csv, scene 卡行级忽略词 (来自卡 scene 行).
    ignore_clause: #61 — 同 _write_threepov_csv (有图 + 非空 → override 门禁).
    返回 csv 绝对路径."""
    from .csv_gen import build_csv
    from .quick_shot import quick_data_to_csv_data
    refs = _canvas_csv_refs(picture_ref, "", refs)
    override = bool(refs) and bool((ignore_clause or "").strip())
    pool_inc, usage_inc, prompt_tail = _canvas_pool_rows(refs, override=override)
    full_prompt = (_build_scene_canvas_prompt(prompt_text, has_picture=bool(refs),
                                            ignore_words=ignore_words,
                                            ignore_clause=ignore_clause,
                                            override=override) if view is None
                   else _build_scene_view_prompt(prompt_text, view)) + prompt_tail
    shot_extra, globals_ = _canvas_csv_keys(canvas)
    shot = {"ID": "s01", "prompt": full_prompt, "导出文件名": "s01"}
    shot.update(shot_extra)
    csv_data = quick_data_to_csv_data([shot], globals_)
    csv_data["pool"]["Picture"].update(pool_inc["Picture"])
    if usage_inc["Picture"]:
        csv_data["pool_usage"] = usage_inc
    text_out = build_csv("分镜", csv_data)
    name = "scene_canvas_%d%s.csv" % (int(time.time()),
                                      "" if view is None else "_%d" % view)
    path = os.path.join(input_dir, name)
    os.makedirs(input_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(text_out)
    return path


def _write_item_canvas_csv(input_dir, prompt_text, *, picture_ref="", refs=None, canvas=None,
                         view=None, ignore_words="", ignore_clause=""):
    """道具画布 1 段 2s 便宜档 CSV (与 _write_threepov_csv / _write_scene_canvas_csv 同构).

    view: None (默认 — 生成链) → 四格模板 prompt (_build_item_canvas_prompt);
        0-3 (单格重补备用) → 单视角 prompt (_build_item_view_prompt).
    picture_ref 非空 → 池 Picture 1 接种 (ref2v) + 参考锚定句; 空 → 纯文字 (t2v).
    F36 E1: 槽构造收敛为 _canvas_pool_rows 薄壳 (单图槽 1 无用途标注 — 现状字节锁);
        对外签名不变, handler 调用点 E2 才泛化.
    F36 E2: 新参 refs — 全量槽表 [(槽号, basename, usage), ...] (多槽面直用); None →
        现行单图翻译. has_picture 随槽表非空.
    canvas: J2b 画布配置 (缺省 None → 现状字面值).
    ignore_words: V1.14 T2 — 同 _write_threepov_csv, item 卡行级忽略词 (来自卡 subject_prop 行).
    ignore_clause: #61 — 同 _write_threepov_csv (有图 + 非空 → override 门禁).
    返回 csv 绝对路径."""
    from .csv_gen import build_csv
    from .quick_shot import quick_data_to_csv_data
    refs = _canvas_csv_refs(picture_ref, "", refs)
    override = bool(refs) and bool((ignore_clause or "").strip())
    pool_inc, usage_inc, prompt_tail = _canvas_pool_rows(refs, override=override)
    full_prompt = (_build_item_canvas_prompt(prompt_text, has_picture=bool(refs),
                                           ignore_words=ignore_words,
                                           ignore_clause=ignore_clause,
                                           override=override) if view is None
                   else _build_item_view_prompt(prompt_text, view)) + prompt_tail
    shot_extra, globals_ = _canvas_csv_keys(canvas)
    shot = {"ID": "s01", "prompt": full_prompt, "导出文件名": "s01"}
    shot.update(shot_extra)
    csv_data = quick_data_to_csv_data([shot], globals_)
    csv_data["pool"]["Picture"].update(pool_inc["Picture"])
    if usage_inc["Picture"]:
        csv_data["pool_usage"] = usage_inc
    text_out = build_csv("分镜", csv_data)
    name = "item_canvas_%d%s.csv" % (int(time.time()),
                                     "" if view is None else "_%d" % view)
    path = os.path.join(input_dir, name)
    os.makedirs(input_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(text_out)
    return path


def _ensure_threepov_asset_dir(server_input_dir):
    """确保 asset_library/asset_images/threepov/ 存在 — 与 _H3_LIBRARY_SUBDIRS 注册同步."""
    base = os.path.join(server_input_dir, "asset_library", "asset_images",
                        THREEPOV_ASSET_SUBDIR)
    os.makedirs(base, exist_ok=True)
    return base


def _find_latest_mp4(run_dir):
    """run_dir 下产物 mp4 按 mtime 最新取一 — 用于尾帧提取目标."""
    if not run_dir or not os.path.isdir(run_dir):
        return None
    best = None
    best_mt = -1.0
    for fn in os.listdir(run_dir):
        if not fn.lower().endswith((".mp4", ".webm", ".mov")):
            continue
        p = os.path.join(run_dir, fn)
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if mt > best_mt:
            best_mt = mt
            best = p
    return best


def _extract_tail_png(engine, server_input_dir, task_id):
    """跑批完成后抽尾帧 PNG → 拷到 asset_library/asset_images/threepov/.

    复用 batch_core.H3BatchEngine._extract_last_frame (拼接续接同款),
    抽帧产物先落 intermediates/, 再 shutil.copy2 到目标路径.
    兜底: run_dir 下找不到 mp4 也尝试调 _extract_last_frame (桩测试场景).
    """
    run_dir = getattr(engine, "run_dir", None) or ""
    mp4 = _find_latest_mp4(run_dir)
    # 选一个非空路径给 _extract_last_frame — 真路径有 mp4, 桩测试时给个占位也无所谓
    target = mp4 or os.path.join(run_dir or "", "_stub.mp4")
    try:
        rel = engine._extract_last_frame(target)
    except Exception:
        return None
    if not rel:
        return None
    src_abs = os.path.join(server_input_dir, rel)
    if not os.path.isfile(src_abs):
        return None
    _ensure_threepov_asset_dir(server_input_dir)
    dst = _asset_png_path(server_input_dir, task_id)
    shutil.copy2(src_abs, dst)
    return dst


def _extract_tail_to_card_png(engine, server_input_dir, card_name):
    """卡名模式尾帧抽帧: PNG → archive_images/<卡名>/threepov.png (固定名, 重出覆盖).

    返回 PNG 绝对路径; 抽帧失败/无源 → None. 与 _extract_tail_png 同源
    (_extract_last_frame + intermediates/ + shutil.copy2)."""
    run_dir = getattr(engine, "run_dir", None) or ""
    mp4 = _find_latest_mp4(run_dir)
    target = mp4 or os.path.join(run_dir or "", "_stub.mp4")
    try:
        rel = engine._extract_last_frame(target)
    except Exception:
        return None
    if not rel:
        return None
    src_abs = os.path.join(server_input_dir, rel)
    if not os.path.isfile(src_abs):
        return None
    dst = _archive_threepov_png_path(server_input_dir, card_name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src_abs, dst)
    return dst


def _extract_tail_png_to(engine, server_input_dir, dst):
    """抽尾帧 PNG → 拷到 dst (父目录自建); 失败 → None (V1.12 T6 复用同款机制).

    V1.14 A3 (T5a-D2): 三条失败路径各自写入 _RENDER_SHEET_SOFT_ERR (具体原因),
    不再静默 — 调用方 render_sheet 落入注册表 error 字段."""
    global _RENDER_SHEET_SOFT_ERR
    run_dir = getattr(engine, "run_dir", None) or ""
    mp4 = _find_latest_mp4(run_dir)
    target = mp4 or os.path.join(run_dir or "", "_stub.mp4")
    try:
        rel = engine._extract_last_frame(target)
    except Exception as e:
        _RENDER_SHEET_SOFT_ERR = "尾帧提取失败: 抽帧异常: %s" % e
        return None
    if not rel:
        _RENDER_SHEET_SOFT_ERR = "尾帧提取失败: 抽帧未产出 (target=%s)" % target
        return None
    src_abs = os.path.join(server_input_dir, rel)
    if not os.path.isfile(src_abs):
        _RENDER_SHEET_SOFT_ERR = "尾帧提取失败: 抽帧产物不存在: %s" % src_abs
        return None
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src_abs, dst)
    return dst


# ============ 四视角拼版 (PIL; 保留设施 — 生成链已回退为一次四格生成) ============
# 版式: 人物 = 左侧三竖格等高并排 + 右侧一大格 (约整图一半宽); 场景/道具 = 2×2 等大四格.
# 统一浅灰背景填充 + 格间白色间隔条; 四图按格宽等比缩放 (contain, 居中, 不裁切).
CANVAS_SHEET_W = 1600
CANVAS_SHEET_H = 1200
CANVAS_SHEET_MARGIN = 16
CANVAS_SHEET_GAP = 16
CANVAS_SHEET_BG_RGB = (236, 236, 236)    # 浅灰背景
CANVAS_SHEET_GAP_RGB = (255, 255, 255)   # 格间白色间隔条


def _canvas_cells(kind):
    """版式格框 [(x, y, w, h) × 4] — 视角 1..4 顺序 (与 _CANVAS_VIEW_LINES 同序)."""
    m, g = CANVAS_SHEET_MARGIN, CANVAS_SHEET_GAP
    iw, ih = CANVAS_SHEET_W - 2 * m, CANVAS_SHEET_H - 2 * m
    if kind == "character":
        big_w = (iw - 3 * g) // 2                    # 约整图一半宽
        left_w = (iw - big_w - 3 * g) // 3
        big_w = iw - 3 * left_w - 3 * g              # 余数并入大格 (右缘贴版内缘)
        xs = [m + i * (left_w + g) for i in range(3)]
        return [(x, m, left_w, ih) for x in xs] + [(xs[2] + left_w + g, m, big_w, ih)]
    if kind in ("scene", "item"):
        cw, ch = (iw - g) // 2, (ih - g) // 2
        return [(m, m, cw, ch), (m + cw + g, m, cw, ch),
                (m, m + ch + g, cw, ch), (m + cw + g, m + ch + g, cw, ch)]
    raise ValueError("threepov: 未知画布 kind: %r" % kind)


def _gap_spans(spans, lo, hi):
    """区间并集的补集 (版式格间空隙)."""
    out = []
    cur = lo
    for a, b in sorted(spans):
        if a > cur:
            out.append((cur, a))
        cur = max(cur, b)
    if cur < hi:
        out.append((cur, hi))
    return out


def _compose_canvas_png(kind, imgs, dst_png):
    """四张单视角 PNG → 固定版式拼版落 dst_png (PIL).

    imgs: 视角 1..4 的 PNG 路径 (顺序 = _canvas_cells 格序).
    任一张缺失/不可读 (或数量不符) → 返回 None (软失败, 登记缺格, 不落 dst).
    """
    from PIL import Image
    cells = _canvas_cells(kind)
    if not isinstance(imgs, (list, tuple)) or len(imgs) != len(cells):
        return None
    for p in imgs:
        if not (isinstance(p, str) and os.path.isfile(p)):
            return None
    m, g = CANVAS_SHEET_MARGIN, CANVAS_SHEET_GAP
    iw, ih = CANVAS_SHEET_W - 2 * m, CANVAS_SHEET_H - 2 * m
    try:
        tiles = []
        for p in imgs:
            with Image.open(p) as im:
                tiles.append(im.convert("RGB"))
        sheet = Image.new("RGB", (CANVAS_SHEET_W, CANVAS_SHEET_H), CANVAS_SHEET_BG_RGB)
        # 格间白色间隔条 (格框并集的补集)
        for x0, x1 in _gap_spans([(x, x + w) for x, _y, w, _h in cells], m, m + iw):
            sheet.paste(CANVAS_SHEET_GAP_RGB, (x0, m, x1, m + ih))
        for y0, y1 in _gap_spans([(y, y + h) for _x, y, _w, h in cells], m, m + ih):
            sheet.paste(CANVAS_SHEET_GAP_RGB, (m, y0, m + iw, y1))
        for tile, (x, y, w, h) in zip(tiles, cells):
            # 等比缩放 (contain): 完整放入格内, 居中, 不裁切
            sc = min(w / tile.width, h / tile.height)
            nw, nh = max(1, int(round(tile.width * sc))), max(1, int(round(tile.height * sc)))
            sheet.paste(tile.resize((nw, nh), Image.LANCZOS),
                        (x + (w - nw) // 2, y + (h - nh) // 2))
        os.makedirs(os.path.dirname(dst_png), exist_ok=True)
        sheet.save(dst_png, format="PNG")
    except Exception:
        print("[H3Batch 拼版] 异常: %s" % traceback.format_exc(), flush=True)
        return None
    return dst_png


# ============ 公共渲染链 (1.12b T2 抽取) ============
# 三端点 (threepov/scene_canvas/item_canvas) + 1.12b 建档 pre-batch 共用.
# 内部复用模块级既有 helper (签名不变 — 既有端点测试直调它们):
#   _build_threepov_prompt / _build_scene_canvas_prompt / _write_threepov_csv /
#   _write_scene_canvas_csv / _extract_tail_png_to /
#   _save_card_with_threepov_row / _save_card_with_scene_row / _read_v3_card.
# 互斥由调用面负责 — render_sheet 不拿 _active_lock.
# 三调用面各自独立命名空间 (manifest_prefix / task_prefix / output_subdir),
# 防同秒撞名 + history 扫描器天然隔离 (manifest 文件名不以 h3_batch_manifest_ 起头).

# 模块级软错误侧通道: render_sheet 内 tail-extract (抛/无产物) / card-write 软失败不抛,
# 而是写入 _RENDER_SHEET_SOFT_ERR; 调用方在 render_sheet 返回后用 _take_render_sheet_soft_err()
# 取走 (一次性, 立即清空) → 落入注册表 error 字段.
# 既保既有 "尾帧/写卡软失败 → STATUS_DONE with error" 语义, 又让 render_sheet 仍返 dst_png 字符串.
_RENDER_SHEET_SOFT_ERR = None  # type: Optional[str]


def _take_render_sheet_soft_err():
    """弹出最近一次 render_sheet 软错误 (None 表示无); 调用后立即清空."""
    global _RENDER_SHEET_SOFT_ERR
    err = _RENDER_SHEET_SOFT_ERR
    _RENDER_SHEET_SOFT_ERR = None
    return err


def render_sheet(kind, *, prompt_text, ref_src="", outfit_ref_src="", extra_refs=None,
                 card_name="", dst_png, manifest_prefix, task_prefix="", output_subdir="",
                 ignore_words="", ignore_clause="", task_id="", canvas=None, _eng=None,
                 writeback=True) -> str:
    """公共渲染链 (1.12b T2 抽取).

    三端点 (threepov/scene_canvas/item_canvas) 与未来 1.12b 建档 pre-batch 共用.
    内部复用模块级同名同签名 helper (既有端点测试直调它们 — 签名不变).

    生成段 = 一次生成四格多面板帧 (单行 CSV 四格 prompt) → 抽尾帧原样落 dst_png.
    (方案甲的拆分生成已回退: 四图格间一致性崩坏, 老板裁决回四格大图方案.)

    Args:
        kind: "character" / "scene" / "item". "item" 仅留 stub (波 3 接).
        prompt_text: 原始用户文本 (handler 已拼合 card_desc+extra). render_sheet 内部按
            kind 选 _build_threepov_prompt / _build_scene_canvas_prompt + _write_*_csv,
            后者会再套模板; 故此处传 raw user text.
        ref_src: ref2v 参照图源绝对路径 (空 → t2v). 渲染前复制到 input_dir/<ref_basename_fmt % task_id>.png.
        outfit_ref_src: J3 服装图源绝对路径 — 仅 kind="character" 消费; 非空且 ref_src 同给 →
            复制到 input_dir/threepov_outfit_ref_<task_id>.png 并进 CSV 槽 2 (双参考槽);
            空/其他 kind → 单槽现状零变化.
        extra_refs: F36 E2 (方案-F36 §3.4) 全量多槽参照 [(src, usage), ...] (槽 1..n, usage 可
            None = image_paths 模式). 非空时槽构造完全由它决定 (ref_src/outfit_ref_src 不再参与
            槽构造与复制 — ref_src 仍建议同传首槽源, 建档面 C7 契约). 复制命名走 _canvas_ref_basename
            (槽 1 现行 REF_BASENAME_FMT / 槽 2 outfit 特例 / 其余 <端点前缀>_ref{n}); CSV 槽表
            传 _write_*_csv refs. None/空 → 现行 ref_src/outfit_ref_src 路径逐字节不变.
        card_name: 卡名模式时写卡目标名 (空 → 直接模式, 只落 dst_png, 不写卡).
        dst_png: PNG 目标绝对路径 (handler 算好: 直接模式 = asset_images/<kind>/<kind>_<task_id>.png;
            卡名模式 = archive_images/<卡名>/<kind>.png).
        manifest_prefix: manifest 文件名前缀 (独立命名空间, 与既有 MANIFEST_PREFIX /
            SCENE_MANIFEST_PREFIX 同结构, 不以 h3_batch_manifest_ 起头 → history 扫描器天然放行).
        task_prefix: task_id 前缀 (注册表命名空间隔离; 与既有 TASK_ID_PREFIX /
            SCENE_TASK_ID_PREFIX 同款).
        output_subdir: output_dir 下专属子目录名 (注册表/manifest 落点).
        writeback: 卡名模式写卡开关 (默认 True = 现状自动写回); False → 只出图不写卡.
        _eng: 可选 — 已构造好的 H3BatchEngine. 端点调用面在主流程同步构造并传入, 以保证
            测试桩 (test_threepov_endpoint._StubEngine) 在 `_patch_engine()` 上下文内
            被捕获 (背景线程跑渲染时桩 patch 已回滚). 缺省 None → render_sheet 自行构造.

    Returns:
        dst_png 绝对路径 (字符串).

    异常语义:
        - 硬失败 (build_engine_from_params 抛 / eng.run() 抛) → 直接抛出, 调用方映射 STATUS_FAILED.
        - 软失败 (tail-extract 抛/无产物 / card-write 抛) → 不抛, 写入 _RENDER_SHEET_SOFT_ERR,
          调用方用 _take_render_sheet_soft_err() 取走 → STATUS_DONE with error.
    """
    global _RENDER_SHEET_SOFT_ERR
    _RENDER_SHEET_SOFT_ERR = None  # 入口清 — 避免上次污染

    if kind == "character":
        _csv_writer = _write_threepov_csv
        _save_card_row = _save_card_with_threepov_row
        ref_basename_fmt = THREEPOV_REF_BASENAME_FMT
    elif kind == "scene":
        _csv_writer = _write_scene_canvas_csv
        _save_card_row = _save_card_with_scene_row
        ref_basename_fmt = SCENE_REF_BASENAME_FMT
    elif kind == "item":
        _csv_writer = _write_item_canvas_csv
        _save_card_row = _save_card_with_item_row
        ref_basename_fmt = ITEM_REF_BASENAME_FMT
    else:
        raise ValueError(
            "render_sheet: kind 须为 character/scene/item, got %r" % kind)
    if not manifest_prefix:
        raise ValueError("render_sheet: manifest_prefix 必填 (三调用面独立命名空间)")

    _ext = _resolve_ext()
    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()

    # task_id 用 task_prefix + 时间戳 (与既有 TASK_ID_PREFIX/SCENE_TASK_ID_PREFIX 同款).
    # 闲时批 C (flaky-tests.md §三.1 根治): handler 已生成 task_id 的直接透传 (单点取时) —
    # 旧口径此处二次 int(time.time()) 与 handler 跨秒边界差 1, 参照副本/CSV/manifest 名
    # 与注册表键漂移 (测试随机假红 4 面孔 + manifest 孤儿). 未透传的调用面缺省自生成,
    # 行为不变.
    if not task_id:
        task_id = (task_prefix + str(int(time.time()))) if task_prefix else ""

    # ref2v 参照图复制: 与既有 handler 同款 (复制到 input_dir 根, basename 含 task_id).
    picture_ref_basename = ""
    if ref_src:
        if not task_id:
            raise ValueError(
                "render_sheet: ref_src 非空时 task_prefix 必填 (用于隔离命名)")
        if not os.path.isfile(ref_src):
            raise FileNotFoundError("ref_src 文件不存在: %s" % ref_src)
        ref_copy_abs = os.path.join(input_dir, ref_basename_fmt % task_id)
        os.makedirs(os.path.dirname(ref_copy_abs), exist_ok=True)
        shutil.copy2(ref_src, ref_copy_abs)
        picture_ref_basename = ref_basename_fmt % task_id

    # J3 服装图复制 (仅 character; 槽 2 需槽 1 在主 → ref_src 空时不进池, 与 _write_threepov_csv 守卫同调).
    outfit_ref_basename = ""
    if kind == "character" and outfit_ref_src and ref_src:
        if not task_id:
            raise ValueError(
                "render_sheet: outfit_ref_src 非空时 task_prefix 必填 (用于隔离命名)")
        if not os.path.isfile(outfit_ref_src):
            raise FileNotFoundError("outfit_ref_src 文件不存在: %s" % outfit_ref_src)
        outfit_copy_abs = os.path.join(
            input_dir, THREEPOV_OUTFIT_REF_BASENAME_FMT % task_id)
        os.makedirs(os.path.dirname(outfit_copy_abs), exist_ok=True)
        shutil.copy2(outfit_ref_src, outfit_copy_abs)
        outfit_ref_basename = THREEPOV_OUTFIT_REF_BASENAME_FMT % task_id

    # F36 E2 多槽复制 (extra_refs 非空时槽构造完全由它决定 — ref_src/outfit_ref_src 分支跳过):
    # 槽 1 沿用现行 REF_BASENAME_FMT / 槽 2 outfit 特例 / 其余 <端点前缀>_ref{n} (命名公式
    # _canvas_ref_basename). 单槽时槽 1 usage 抹 None (J1 单图裸池行 + image_paths 单项 ≡
    # image_path 单值等价); 多槽时保留收集槽 1 usage (J3 |subject_look 字节锁).
    extra_slot_rows = []
    if extra_refs:
        if not task_id:
            raise ValueError(
                "render_sheet: extra_refs 非空时 task_prefix 必填 (用于隔离命名)")
        picture_ref_basename = ""
        outfit_ref_basename = ""
        for i, item in enumerate(extra_refs):
            src, usage = item
            slot = i + 1
            if not os.path.isfile(src):
                raise FileNotFoundError(
                    "extra_refs[%d] 文件不存在: %s" % (i, src))
            bn = _canvas_ref_basename(ref_basename_fmt, slot, usage, task_id)
            copy_abs = os.path.join(input_dir, bn)
            os.makedirs(os.path.dirname(copy_abs), exist_ok=True)
            shutil.copy2(src, copy_abs)
            extra_slot_rows.append((slot, bn, usage))
        if len(extra_slot_rows) == 1:
            _s, _bn, _u = extra_slot_rows[0]
            extra_slot_rows[0] = (_s, _bn, None)

    # CSV + 引擎 (与既有 handler 字段同款 — 既有端点测试检 args[0]==mode / args[1]==workflow 等).
    # 引擎构造: 优先用调用方传入的 _eng (端点面 — 在主流程同步构造, 与既有 _patch_engine
    # 桩生命周期兼容); 否则 render_sheet 自行构造 (建档面/外部调用方).
    # J2b: 画布配置实时读取 (建档面无请求参数 → 配置 > 默认); CSV/引擎参数按配置落键.
    # R-03 (批②): canvas 形参 — 端点面传合并后画布 (请求三键已覆盖, handler 合并点),
    # 缺省 None → _canvas_config() (建档/scene/item 调用面行为零变化).
    _canvas_cfg = canvas if canvas is not None else _canvas_config()
    if extra_slot_rows:
        _csv_kwargs = {"refs": extra_slot_rows, "canvas": _canvas_cfg,
                       "ignore_words": ignore_words,
                       "ignore_clause": ignore_clause}
    else:
        _csv_kwargs = {"picture_ref": picture_ref_basename, "canvas": _canvas_cfg,
                       "ignore_words": ignore_words,
                       "ignore_clause": ignore_clause}
        if kind == "character":
            # 单槽面唯一接受 outfit 的画布 (scene/item 无服装概念) — 见 _write_threepov_csv.
            _csv_kwargs["outfit_ref"] = outfit_ref_basename
    csv_path = _csv_writer(input_dir, prompt_text, **_csv_kwargs)
    if _eng is None:
        # 自建引擎面 (建档/外部直调): 模板族校验与端点面同判据 (i2v/fl2v 不复活);
        # 硬失败由调用面兜 (建档 catch 后按软失败处理, 不挡批).
        wf_template, _wf_err = _canvas_workflow(
            bool(extra_slot_rows or picture_ref_basename), None, _canvas_cfg)
        if _wf_err:
            raise RuntimeError("render_sheet: %s" % _wf_err)
        params = {
            "mode": "分镜",
            "workflow_path": wf_template,
            "csv_path": csv_path,
            "input_dir": input_dir,
            "server_input_dir": input_dir,
            "server_output_dir": output_dir,
            "port": _ext._own_server_port(),
            "start_from": 0,
            "retries": 2,
            "skip_done": True,
            "on_fail": "阻断",
            "resources_list": "[]",
            "resource_overrides": _canvas_engine_param(
                {}, "resource_overrides", _canvas_cfg["resource_overrides"]),
            "lora_overrides": _canvas_engine_param(
                {}, "lora_overrides", _canvas_cfg["lora_overrides"]),
        }
        eng = _ext.build_engine_from_params(params)
    else:
        eng = _eng
        # params/port 已在调用方算过; eng.csv_path 与上面 csv_path 一致 (无强制同步, 既有 handler 也未强制)
    # 发布到 _ext._active_engine — 端点互斥检查报错时读 phase (例如 "active_busy: ...
    # phase=渲染中"); 否则调用方报 "phase=跑批中" 占位文案. 由 _ext._clear_active() 在线程
    # 退出时清. render_sheet 内部构造, 顺手发布, 不破坏既有调用面协议.
    try:
        with _ext._active_lock:
            _ext._active_engine = eng
    except Exception:
        pass

    # Manifest 占位 + monkey-patch (与既有 threepov :939-962 / scene :1266-1284 同款):
    # 防 engine run() 期间写 h3_batch_manifest_* 被 history 拾取; 输出重定向到专属子目录.
    # 1.12b v4 T-D1 修正笔: monkey-patch 用 try/finally 包裹 eng.run()/join_finalize(),
    # 即使渲染异常也还原 eng._save_manifest 与 eng.manifest_path — 防批引擎被永久改道.
    # 哨兵前置: manifest 占位块可整块跳过 (task_prefix 空 → task_id 空), 下方还原段
    # 引用这些名字不得因未绑定而崩 (1.12b v4 T-D1 修正笔回归: 原实现哨兵在 if 内 → 崩).
    _patched_save_manifest = None
    _orig_save_manifest = None
    _orig_manifest_path = None
    if task_id and output_subdir and manifest_prefix:
        mp = os.path.join(output_dir, output_subdir,
                          manifest_prefix + task_id + MANIFEST_SUFFIX)
        os.makedirs(os.path.dirname(mp), exist_ok=True)
        with open(mp, "w", encoding="utf-8") as f:
            json.dump({"_task_id": task_id, "_mode": kind,
                       "ts": int(time.time())}, f, ensure_ascii=False, indent=2)
        if hasattr(eng, "_save_manifest") and callable(eng._save_manifest):
            _orig_save_manifest = eng._save_manifest
            _orig_manifest_path = getattr(eng, "manifest_path", None)
            _patched_manifest_path = mp
            def _patched_save_manifest(manifest):
                try:
                    eng.manifest_path = _patched_manifest_path
                except Exception:
                    pass
                old_mp = _orig_manifest_path
                try:
                    if (old_mp and os.path.isfile(old_mp)
                            and os.path.normpath(old_mp)
                            != os.path.normpath(_patched_manifest_path)):
                        os.remove(old_mp)
                except OSError:
                    pass
                return _orig_save_manifest(manifest)
            eng._save_manifest = _patched_save_manifest
            eng._orig_manifest_path = _orig_manifest_path

    try:
        # 实际渲染 (硬失败会冒泡 — 由调用方映射 STATUS_FAILED)
        eng.run()
        # 真机引擎 run() 异步收尾 (batch_core._finalize_async 起 daemon 线程, "异常不向上传播"):
        # "全部段失败" RuntimeError 被收尾线程吞进 _finalize_error, 必须 join 重抛,
        # 否则全败会被下面无条件标 done (真机缺陷: 失败被报成 done 且无 error).
        # 桩引擎无此方法 → 跳过 (既有用例不受影响).
        if hasattr(eng, "join_finalize") and callable(eng.join_finalize):
            eng.join_finalize()
    finally:
        # 1.12b v4 T-D1 修正笔: 还原 eng._save_manifest / manifest_path — 批引擎/端点引擎
        # 调用方不感知 monkey-patch; 还原后下一轮调用走原函数, 不再被改道到专属子目录.
        if _patched_save_manifest is not None:
            try:
                if hasattr(eng, "_save_manifest"):
                    eng._save_manifest = _orig_save_manifest
            except Exception:
                pass
            try:
                if _orig_manifest_path is not None:
                    eng.manifest_path = _orig_manifest_path
                elif hasattr(eng, "manifest_path"):
                    try:
                        del eng.manifest_path
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                if hasattr(eng, "_orig_manifest_path"):
                    del eng._orig_manifest_path
            except Exception:
                pass

    # 抽尾帧 → dst_png (软失败: 写 _RENDER_SHEET_SOFT_ERR, 不抛)
    os.makedirs(os.path.dirname(dst_png), exist_ok=True)
    try:
        png = _extract_tail_png_to(eng, input_dir, dst_png)
    except Exception as e:
        _RENDER_SHEET_SOFT_ERR = "尾帧提取失败: %s" % e
        print("[H3Batch %s] 后台异常: %s" % (
            kind, traceback.format_exc()), flush=True)
        return dst_png
    if png is None:
        # V1.14 A3 (T5a-D2): 抽帧失败 return None 不抛 — 原静默成 done+缺图.
        # 内部三条失败路径已写具体原因, 此处兜底防漏; 卡名模式 png=None 不写
        # '三视图' 行 (下方 if card_name and png and writeback), 失败信息经 error 字段可见.
        if not _RENDER_SHEET_SOFT_ERR:
            _RENDER_SHEET_SOFT_ERR = "尾帧提取失败: 未知原因"
        print("[H3Batch %s] %s" % (kind, _RENDER_SHEET_SOFT_ERR), flush=True)
        return dst_png

    # 卡名模式写卡 (软失败: 写 _RENDER_SHEET_SOFT_ERR, 不抛)
    if card_name and png and writeback:
        try:
            card = _read_v3_card(input_dir, card_name)
            if card is not None:
                _save_card_row(input_dir, card_name, card, png)
        except Exception as e:
            _RENDER_SHEET_SOFT_ERR = "写回档案卡失败: %s" % e
            print("[H3Batch %s] 后台异常: %s" % (
                kind, traceback.format_exc()), flush=True)

    return dst_png


def _image_paths_preflight(body):
    """F36 E2 (方案-F36 §3.4): image_paths 前置校验 (三端点同款) — 列表 1-8 项
    (空 → 400 / 9+ → 400 too_many_refs, 槽域 1-8 接口硬错误) + 每项三段校验
    (str 非空 / 存在 / PIL verify — 对齐 image_path 现行口径, 错误文案含项序).
    返回 400 响应 (body 含 image_paths 键时校验不通过) 或 None (通过 / 键不存在)."""
    if "image_paths" not in body:
        return None
    ips = body.get("image_paths")
    if not isinstance(ips, list):
        return web.json_response(
            {"ok": False, "error": "image_paths 必须为字符串列表"}, status=400)
    if not ips:
        return web.json_response(
            {"ok": False, "error": "image_paths 不能为空列表 (1-8 项)"}, status=400)
    if len(ips) > _CANVAS_MEDIA_MAX:
        return web.json_response(
            {"ok": False,
             "error": "too_many_refs: image_paths 至多 %d 项, 实 %d 项"
                      % (_CANVAS_MEDIA_MAX, len(ips))},
            status=400)
    from PIL import Image as _PILImage
    for i, p in enumerate(ips, 1):
        if not isinstance(p, str) or not p:
            return web.json_response(
                {"ok": False,
                 "error": "image_paths 第 %d 项必须为非空字符串" % i}, status=400)
        if not os.path.isfile(p):
            return web.json_response(
                {"ok": False,
                 "error": "image_paths 第 %d 项不存在或不是文件: %s" % (i, p)},
                status=400)
        try:
            _PILImage.open(p).verify()
        except Exception as e:
            return web.json_response(
                {"ok": False,
                 "error": "image_paths 第 %d 项不是合法图片 (PIL open 失败: %s)"
                          % (i, e)},
                status=400)
    return None


# ============ 路由 ============

async def _h3_threepov_submit(request):
    """POST /h3_batch/threepov — 提交三视图任务 (异步两步式)."""
    global _THREEPOV_ACTIVE
    _ext = _resolve_ext()
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 须为 JSON 对象"}, status=400)

    # 四给法互斥校验 (F36 E2: image_paths 扩入 — text/image_path/card_name/image_paths
    # 至多其一, 复用 mutually_exclusive 错误码风格)
    given = [k for k in ("text", "image_path", "card_name", "image_paths") if k in body]
    if len(given) == 0:
        return web.json_response(
            {"ok": False,
             "error": "missing_input: 四选一必填 text / image_path / card_name / image_paths"},
            status=400)
    if len(given) > 1:
        return web.json_response(
            {"ok": False,
             "error": "mutually_exclusive: text/image_path/card_name/image_paths 四选一, 不可同时给出多个",
             "detail": given},
            status=400)

    # image_path 波1 未启用 (波2 已实现卡名模式; 本分支波3 启用)
    # _IMAGE_PATH_ENABLED 闸门: 测试夹具关时可回滚波1 not_implemented_in_wave1 契约.
    if "image_path" in body and not _IMAGE_PATH_ENABLED:
        return web.json_response(
            {"ok": False,
             "error": "not_implemented_in_wave1: image_path 模式将于 1.11c 波 3 启用"},
            status=400)

    # image_path 模式前置校验 (波3 启用): 路径不存在 / 非图片 → 400 契约文案.
    # 校验前置: 不创建 refs 目录, 不动 input_dir; 失败即返.
    if "image_path" in body:
        ip = body.get("image_path")
        if not isinstance(ip, str):
            return web.json_response(
                {"ok": False,
                 "error": "image_path 必须为字符串"},
                status=400)
        if not os.path.isfile(ip):
            return web.json_response(
                {"ok": False,
                 "error": "image_path 不存在或不是文件: %s" % ip},
                status=400)
        # PIL open 校验: 非图片文件 → UnidentifiedImageError.
        try:
            from PIL import Image as _PILImage
            _PILImage.open(ip).verify()
        except Exception as e:
            return web.json_response(
                {"ok": False,
                 "error": "image_path 不是合法图片 (PIL open 失败: %s)" % e},
                status=400)

    # image_paths 前置校验 (F36 E2 多图参照, 三端点同款 _image_paths_preflight).
    _err_resp = _image_paths_preflight(body)
    if _err_resp is not None:
        return _err_resp

    # 端口钉死 (严禁裸 0, 与 submit/rerun/quick 同款铁律)
    try:
        _port_in_int = int(body.get("port") or 0)
    except (TypeError, ValueError):
        _port_in_int = 0
    if not _port_in_int:
        body["port"] = _ext._own_server_port()

    # 任务号提前生成 — image_path 模式复制参照图到 threepov_ref_<task_id>.png 时需用,
    # 保证任务隔离 (不同 task_id 各自 basename). 卡名/text 模式无副作用, 仍按既有 task_id 用法.
    task_id = TASK_ID_PREFIX + str(int(time.time()))

    # image_path 模式 (波3 启用): 源图 → 复制到 input_dir/threepov_ref_<task_id>.png (input 根,
    # 引擎 _resolve_file join input_dir + basename 必须能找到, 子目录 basename 拼不到) →
    # 池 Picture 1 + ref2v 模板 (与卡有图分支同链路, 复用 _write_threepov_csv 的 picture_ref).
    # prompt 用通用措辞 (无 desc 来源; 不加 prompt_extra/text 参数 — 三给法互斥 YAGNI).
    # 复制统一延后到互斥校验后 (见下方 "参照图复制"), 409 拒绝时不留残留副本.
    card_name = None
    card_ignore_words = ""
    card_ignore_clause = ""
    writeback = True          # 卡名模式写卡开关 (请求体 writeback, 缺省 True = 现状)
    card_png_dst_kind = None  # None=直接模式; "card"=卡名模式 (写回 archive_images/<名>/)
    card_refs = []            # F36 E2 多槽参照 [(src, usage), ...] (image_paths / 卡名模式;
                              # 空列表 → 现行单槽/纯文字路径)
    prompt_text = ""
    if "image_paths" in body:
        # F36 E2 多图模式: 各槽 usage=None (槽 1 锚定句 look N=1, 槽 2-8 通用句);
        # 源已在前置校验三段核过 (存在/PIL verify).
        prompt_text = "与参照图完全一致的同一人物"
        card_refs = [(p, None) for p in body["image_paths"]]
    elif "image_path" in body:
        prompt_text = "与参照图完全一致的同一人物"
        # card_png_dst_kind 保持 None (直接模式, 落 asset_images/threepov/, 不写卡)
    elif "card_name" in body:
        # card_name 模式 (波2 启用): 读卡 → 校验 → 决定模板/ref2v-vs-t2v/写盘路径
        # 卡名校验 (与 #35 assets POST 同款)
        cn = body.get("card_name")
        if not isinstance(cn, str):
            return web.json_response(
                {"ok": False, "error": "card_name 必须为字符串"}, status=400)
        if ":" in cn:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 含非法字符 ':' (Windows 文件名禁用)"},
                status=400)
        cn = cn.strip()
        if not cn:
            return web.json_response(
                {"ok": False, "error": "card_name 不能为空"}, status=400)
        card_name = _safe_filename(cn)
        if not card_name:
            return web.json_response(
                {"ok": False, "error": "card_name 不合法: 含路径分隔符或仅为特殊字符"},
                status=400)
        if len(card_name) > 64:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 超过 64 字符限制 (当前 %d)" % len(card_name)},
                status=400)
        # 读卡 — 用 server_input_dir (与 _h3_read_assets 同口径)
        server_input_dir = folder_paths.get_input_directory()
        card = _read_v3_card(server_input_dir, card_name)
        if card is None:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 未在资产库中找到: %s" % card_name},
                status=404)
        if not _is_v3_character(card):
            return web.json_response(
                {"ok": False,
                 "error": "not_v3_character: 仅支持 v3 character 卡, 当前卡 _v=%r kind=%r"
                          % (card.get("_v"), card.get("kind"))},
                status=400)
        # F36 E2: 卡名模式参照改 _collect_card_media 多槽收集 (白名单行序展开:
        # [subject_look, 三视图, subject_outfit, subject_prop]; 主锚点=行序首行白名单行,
        # [outfit 在前] 的卡 outfit 占槽 1 — 方案 §3.1). 槽 1 源缺失 400 / 槽 2+ 缺失剔除
        # 告警 (见下方 ref 决策段, J3 outfit 口径泛化).
        card_refs = _collect_card_media(card, "character")
        # v2.1 逐用途成句: 有参考图 → 段串 (desc + 以 Picture N 为准 + 逐项忽略);
        # 无参考图 (t2v) → 回落整卡 desc 合并. 忽略句同源映射器归一结果.
        card_mapped = _map_card_rows_to_pictures(card, "character")
        card_segments = (_build_card_subject_segments(card, "character", card_mapped)
                         if card_refs else "")
        card_desc = card_segments or _extract_card_desc(card)
        card_ignore_words = _extract_card_ignore_words(card)
        card_ignore_clause = (_render_ignore_clause(card_mapped) if card_refs else "")
        wb = body.get("writeback", True)
        if not isinstance(wb, bool):
            return web.json_response(
                {"ok": False, "error": "writeback 必须为布尔值"}, status=400)
        writeback = wb
        pe = body.get("prompt_extra", "")
        if not isinstance(pe, str):
            return web.json_response(
                {"ok": False, "error": "prompt_extra 必须为字符串"}, status=400)
        if len(pe) > PROMPT_EXTRA_MAX_LEN:
            return web.json_response(
                {"ok": False,
                 "error": "prompt_extra 超过 %d 字符限制 (当前 %d)"
                           % (PROMPT_EXTRA_MAX_LEN, len(pe))},
                status=400)
        if card_desc and pe:
            prompt_text = card_desc + "; " + pe
        elif card_desc:
            prompt_text = card_desc
        elif pe:
            prompt_text = pe
        else:
            return web.json_response(
                {"ok": False,
                 "error": "card 描述为空且未提供 prompt_extra, 无法生成"},
                status=400)
        card_png_dst_kind = "card"

    else:
        # text 模式 (波1)
        text = body.get("text")
        if not isinstance(text, str):
            return web.json_response(
                {"ok": False, "error": "text 必须为字符串"}, status=400)
        if len(text) > TEXT_MAX_LEN:
            return web.json_response(
                {"ok": False,
                 "error": "text 超过 %d 字符限制 (当前 %d)" % (TEXT_MAX_LEN, len(text))},
                status=400)
        prompt_text = text

    # _active 双向互斥 — 三视图占引擎, 跑批运行中提交 → 409
    # 1.12b M1b: 端点互斥块首部查 _ext._enrollment_busy → 409 enrollment_busy
    with _ext._active_lock:
        if getattr(_ext, "_enrollment_busy", False):
            return web.json_response(
                {"ok": False,
                 "error": "enrollment_busy: 建档进行中, 请稍候"},
                status=409)
        if _ext._active is not None and _ext._active.is_alive():
            _phase = getattr(_ext._active_engine, "phase", "") or "跑批中"
            return web.json_response(
                {"ok": False,
                 "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                status=409)
        if _THREEPOV_ACTIVE:
            return web.json_response(
                {"ok": False,
                 "error": "active_busy: 已有三视图任务在运行"},
                status=409)

    # 构造 CSV + 引擎 (自建接线 — 方案 §二.1; 1.12b T2: 渲染链入 render_sheet, handler 变薄壳)
    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()
    # ref_src 决策 (handler 不再复制 — 复制下沉到 render_sheet). 仍保留 400 校验:
    # image_path 源已在前置校验确认存在; 卡上 look 图落在档案树不在 input 根, 而引擎素材
    # 解析只在 input 根按 basename 找 → 卡名模式同样需要源存在 (校验通过 render_sheet 抛
    # FileNotFoundError, 由 _do_run 外层 except 映射 STATUS_FAILED). 但更稳妥是前置 400.
    if "image_paths" in body:
        ref_src = card_refs[0][0]
        ref_err = "image_paths 第 1 项文件不存在: %s"
    elif "image_path" in body:
        ref_src = body["image_path"]
        ref_err = "image_path 文件不存在: %s"
    elif card_refs:
        ref_src = card_refs[0][0]
        ref_err = "card 首行参照 media 文件不存在: %s"
    else:
        ref_src = ref_err = ""
    if ref_src and not os.path.isfile(ref_src):
        return web.json_response(
            {"ok": False, "error": ref_err % ref_src}, status=400)
    # F36 E2 槽 2+ 源缺失 → 剔除仅告警 (J3 outfit 口径泛化 — 槽 1 缺失已 400 挡下,
    # 次槽缺失不阻断主图; 与批侧 "空 media 行剔除仅告警" 同口径).
    if card_png_dst_kind == "card" and len(card_refs) > 1:
        _kept = [card_refs[0]]
        for _src, _usage in card_refs[1:]:
            if os.path.isfile(_src):
                _kept.append((_src, _usage))
            else:
                print("[H3Batch threepov] 卡参照行 media 文件不存在, 该参考槽跳过: %s"
                      % _src, flush=True)
        card_refs = _kept
    # J2b: 画布配置 + 模板选择/族校验 (请求 workflow_path > canvas 配置 > 默认). 前置校验:
    # 不落状态/不留参照副本即返 (与 image_path 前置校验"失败即返"同款口径).
    _canvas_cfg = _canvas_config()
    # R-03 (批②): 请求三键 aspect/megapixels/duration_seconds 合并点 — 真值覆盖配置
    # 对应键得合并画布 (形态不符软回退/域外透传, 见 helper); 随 handler CSV 写点与
    # render_sheet canvas 形参双路落 CSV (render_sheet 后台重建 CSV 为实际生效写点);
    # 其余配置消费点 (模板族/覆写参数) 原样用 _canvas_cfg.
    _canvas_for_csv = _canvas_media_request_overrides(body, _canvas_cfg)
    wf_template, _wf_err = _canvas_workflow(
        bool(ref_src), _canvas_request_param(body, "workflow_path"), _canvas_cfg)
    if _wf_err:
        return web.json_response({"ok": False, "error": _wf_err}, status=400)
    # dst_png 目标 (handler 算好; render_sheet 内部抽尾帧到这里)
    if card_png_dst_kind == "card":
        dst_png = _archive_threepov_png_path(input_dir, card_name)
    else:
        dst_png = _asset_png_path(input_dir, task_id)

    # 状态注册 (started — 渲染中由 _do_run 切到 rendering)
    _set_status(output_dir, task_id, STATUS_STARTED, result_png_path=None, error=None)

    # 引擎构造放在 handler 主流程 (与既有 threepov :919-925 同位置): 在 `_patch_engine()`
    # 桩生命周期内同步构造, 测试桩被捕获. 然后用 _eng 传给后台线程的 render_sheet.
    # 复制/CSV/manifest/run/tail/写卡 这些环节已入 render_sheet.
    if card_refs:
        # F36 E2 多槽: 主流程同步复制各槽 (引擎 CSV 池行用复制名; render_sheet 后台
        # 幂等重做). 单槽槽 1 usage 抹 None (J1 单图裸池行 + image_paths 单项等价).
        csv_refs = []
        for i, (src, usage) in enumerate(card_refs):
            slot = i + 1
            bn = _canvas_ref_basename(THREEPOV_REF_BASENAME_FMT, slot, usage, task_id)
            ref_copy = os.path.join(input_dir, bn)
            os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
            shutil.copy2(src, ref_copy)
            csv_refs.append((slot, bn, usage))
        if len(csv_refs) == 1:
            csv_refs[0] = (1, csv_refs[0][1], None)
        csv_path = _write_threepov_csv(input_dir, prompt_text,
                                       refs=csv_refs, canvas=_canvas_for_csv,
                                       ignore_words=card_ignore_words,
                                       ignore_clause=card_ignore_clause)
    else:
        picture_ref_basename = ""
        if ref_src:
            ref_copy = _image_ref_copy_path(input_dir, task_id)
            os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
            shutil.copy2(ref_src, ref_copy)
            picture_ref_basename = THREEPOV_REF_BASENAME_FMT % task_id
        csv_path = _write_threepov_csv(input_dir, prompt_text,
                                       picture_ref=picture_ref_basename,
                                       canvas=_canvas_for_csv,
                                       ignore_words=card_ignore_words,
                                       ignore_clause=card_ignore_clause)
    params = {
        "mode": "分镜",
        "workflow_path": wf_template,
        "csv_path": csv_path,
        "input_dir": input_dir,
        "server_input_dir": input_dir,
        "server_output_dir": output_dir,
        "port": body["port"],
        "start_from": 0,
        "retries": 2,
        "skip_done": True,
        "on_fail": "阻断",
        "resources_list": "[]",
        "resource_overrides": _canvas_engine_param(
            body, "resource_overrides", _canvas_cfg["resource_overrides"]),
        "lora_overrides": _canvas_engine_param(
            body, "lora_overrides", _canvas_cfg["lora_overrides"]),
    }
    try:
        eng = _ext.build_engine_from_params(params)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "engine_init: %s" % e}, status=400)

    # 后台线程: render_sheet(kind="character", ..., _eng=eng) 抽走渲染链中除 eng.run()
    # 之外的所有环节 (manifest 占位/run/join/tail/写卡) — handler 只剩置位 _THREEPOV_ACTIVE
    # + 调 render_sheet + 取软错误写注册表. 异步两步契约保持: 起线程 → 立即返回.
    def _do_run():
        global _THREEPOV_ACTIVE
        _THREEPOV_ACTIVE = True
        try:
            _set_status(output_dir, task_id, STATUS_RENDERING)
            # render_sheet 软失败 (尾帧/写卡) 落入 _RENDER_SHEET_SOFT_ERR; 硬失败 (eng.run
            # 抛) 直接冒泡 → 外层 except → STATUS_FAILED.
            render_sheet(
                "character",
                prompt_text=prompt_text,
                ref_src=ref_src,
                extra_refs=card_refs or None,
                card_name=card_name if card_png_dst_kind == "card" else "",
                dst_png=dst_png,
                manifest_prefix=MANIFEST_PREFIX,
                task_prefix=TASK_ID_PREFIX,
                task_id=task_id,
                output_subdir=THREEPOV_OUTPUT_SUBDIR,
                ignore_words=card_ignore_words,
                ignore_clause=card_ignore_clause,
                writeback=writeback,
                canvas=_canvas_for_csv,
                _eng=eng,
            )
            png = dst_png if os.path.isfile(dst_png) else None
            writeback_err = _take_render_sheet_soft_err()
            _set_status(output_dir, task_id, STATUS_DONE,
                        result_png_path=png, error=writeback_err)
        except Exception as e:
            print("[H3Batch threepov] 后台异常: %s" % traceback.format_exc(), flush=True)
            _set_status(output_dir, task_id, STATUS_FAILED, error=str(e))
        finally:
            _THREEPOV_ACTIVE = False
            _ext._clear_active()

    with _ext._active_lock:
        # _ext._active_engine 由 render_sheet 接收 _eng 时顺手发布 (供端点互斥检查读 phase);
        # 此处只置 _active (线程引用), 启动线程. 异步两步契约: 立即起线程 → handler 立即返.
        _ext._active = threading.Thread(target=_do_run, daemon=True)
        _ext._active.start()

    return web.json_response({
        "ok": True,
        "started": True,
        "task_id": task_id,
        "status": STATUS_STARTED,
    })


async def _h3_threepov_status(request):
    """GET /h3_batch/threepov/status?task_id=... — 状态/产物路径查询."""
    global _THREEPOV_ACTIVE
    _ext = _resolve_ext()
    task_id = str(request.query.get("task_id", "") or "").strip()
    if not task_id:
        return web.json_response({"ok": False, "error": "task_id 缺失"}, status=400)
    if not task_id.startswith(TASK_ID_PREFIX):
        return web.json_response(
            {"ok": False,
             "error": "invalid_task_id: 必须以 %s 前缀开头" % TASK_ID_PREFIX},
            status=400)
    suffix = task_id[len(TASK_ID_PREFIX):]
    if not suffix.isdigit():
        return web.json_response(
            {"ok": False, "error": "invalid_task_id: 格式非法"}, status=400)

    output_dir = folder_paths.get_output_directory()
    reg = _load_registry(output_dir)
    if task_id not in reg:
        return web.json_response(
            {"ok": False, "error": "not_found: 任务不存在"}, status=404)

    entry = reg[task_id]
    status_v = entry.get("status", STATUS_STARTED)

    # 8190 重启检测: 注册表状态为 started/rendering 但 in-memory 不可达 → interrupted
    if status_v in (STATUS_STARTED, STATUS_RENDERING):
        with _ext._active_lock:
            in_memory = _ext._active is not None and _ext._active.is_alive()
        if not in_memory and not _THREEPOV_ACTIVE:
            status_v = STATUS_INTERRUPTED
            entry = dict(entry)
            entry["error"] = "服务已重启, 请重新提交"

    return web.json_response({
        "ok": True,
        "task_id": task_id,
        "status": status_v,
        "result_png_path": entry.get("result_png_path"),
        "error": entry.get("error"),
    })


# ============ 场景画布路由 (V1.12 T6: #47 / #48) ============

async def _h3_scene_canvas_submit(request):
    """POST /h3_batch/scene_canvas — 提交场景画布任务 (异步两步式, 与 #45 同构).

    三给法互斥: text (纯文字) / image_path (裸图参照) / card_name (v3 scene 卡).
    共用引擎互斥域 (_active) + 自有 _SCENE_CANVAS_ACTIVE 二级门; 与 threepov 互相拒绝.
    F36 E2: image_paths (多图参照, 列表 1-8) 扩入互斥四选一."""
    global _SCENE_CANVAS_ACTIVE
    _ext = _resolve_ext()
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 须为 JSON 对象"}, status=400)

    given = [k for k in ("text", "image_path", "card_name", "image_paths") if k in body]
    if len(given) == 0:
        return web.json_response(
            {"ok": False,
             "error": "missing_input: 四选一必填 text / image_path / card_name / image_paths"},
            status=400)
    if len(given) > 1:
        return web.json_response(
            {"ok": False,
             "error": "mutually_exclusive: text/image_path/card_name/image_paths 四选一, 不可同时给出多个",
             "detail": given},
            status=400)

    # image_path 前置校验 (路径存在 + PIL open), 不落盘即返 (与 #45 同款)
    if "image_path" in body:
        ip = body.get("image_path")
        if not isinstance(ip, str):
            return web.json_response(
                {"ok": False, "error": "image_path 必须为字符串"}, status=400)
        if not os.path.isfile(ip):
            return web.json_response(
                {"ok": False, "error": "image_path 不存在或不是文件: %s" % ip}, status=400)
        try:
            from PIL import Image as _PILImage
            _PILImage.open(ip).verify()
        except Exception as e:
            return web.json_response(
                {"ok": False,
                 "error": "image_path 不是合法图片 (PIL open 失败: %s)" % e},
                status=400)

    # image_paths 前置校验 (F36 E2, 三端点同款 _image_paths_preflight).
    _err_resp = _image_paths_preflight(body)
    if _err_resp is not None:
        return _err_resp

    # 端口钉死 (严禁裸 0, 与 submit/rerun/quick/threepov 同款铁律)
    try:
        _port_in_int = int(body.get("port") or 0)
    except (TypeError, ValueError):
        _port_in_int = 0
    if not _port_in_int:
        body["port"] = _ext._own_server_port()

    task_id = SCENE_TASK_ID_PREFIX + str(int(time.time()))

    card = None
    card_name = None
    card_ignore_words = ""
    card_ignore_clause = ""
    writeback = True          # 卡名模式写卡开关 (请求体 writeback, 缺省 True = 现状)
    card_png_dst_kind = None  # None=直接模式; "card"=卡名模式
    card_refs = []            # F36 E2 多槽参照 [(src, usage), ...] (image_paths / 卡名模式)
    picture_ref_basename = ""
    prompt_text = ""
    if "image_paths" in body:
        # F36 E2 多图模式: 各槽 usage=None (槽 1 锚定句 look N=1, 槽 2-8 通用句);
        # 复制延后到互斥校验后 (见下方多槽复制段, 409 拒绝时不留残留副本).
        prompt_text = "与参照图完全一致的同一场景"
        card_refs = [(p, None) for p in body["image_paths"]]
    elif "image_path" in body:
        server_input_dir = folder_paths.get_input_directory()
        ref_copy = _scene_image_ref_copy_path(server_input_dir, task_id)
        os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
        shutil.copy2(body["image_path"], ref_copy)
        picture_ref_basename = SCENE_REF_BASENAME_FMT % task_id
        prompt_text = "与参照图完全一致的同一场景"
    elif "card_name" in body:
        cn = body.get("card_name")
        if not isinstance(cn, str):
            return web.json_response(
                {"ok": False, "error": "card_name 必须为字符串"}, status=400)
        if ":" in cn:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 含非法字符 ':' (Windows 文件名禁用)"},
                status=400)
        cn = cn.strip()
        if not cn:
            return web.json_response(
                {"ok": False, "error": "card_name 不能为空"}, status=400)
        card_name = _safe_filename(cn)
        if not card_name:
            return web.json_response(
                {"ok": False, "error": "card_name 不合法: 含路径分隔符或仅为特殊字符"},
                status=400)
        if len(card_name) > 64:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 超过 64 字符限制 (当前 %d)" % len(card_name)},
                status=400)
        server_input_dir = folder_paths.get_input_directory()
        card = _read_v3_card(server_input_dir, card_name)
        if card is None:
            return web.json_response(
                {"ok": False, "error": "card_name 未在资产库中找到: %s" % card_name},
                status=404)
        if not _is_v3_scene(card):
            return web.json_response(
                {"ok": False,
                 "error": "not_v3_scene: 仅支持 v3 scene 卡, 当前卡 _v=%r kind=%r"
                          % (card.get("_v"), card.get("kind"))},
                status=400)
        # F36 E2: 卡名模式参照改 _collect_card_media 多槽收集 (scene 白名单 [scene],
        # 多 scene 行展开). 槽 1 源缺失 400 / 槽 2+ 缺失剔除告警 (下方泛化段).
        card_refs = _collect_card_media(card, "scene")
        # v2.1 逐用途成句 (有参考图) / t2v 回落整卡 desc 合并; 忽略句同源归一结果.
        card_mapped = _map_card_rows_to_pictures(card, "scene")
        card_segments = (_build_card_subject_segments(card, "scene", card_mapped)
                         if card_refs else "")
        card_desc = card_segments or _extract_card_desc(card)
        card_ignore_words = _extract_card_ignore_words(card)
        card_ignore_clause = (_render_ignore_clause(card_mapped) if card_refs else "")
        wb = body.get("writeback", True)
        if not isinstance(wb, bool):
            return web.json_response(
                {"ok": False, "error": "writeback 必须为布尔值"}, status=400)
        writeback = wb
        pe = body.get("prompt_extra", "")
        if not isinstance(pe, str):
            return web.json_response(
                {"ok": False, "error": "prompt_extra 必须为字符串"}, status=400)
        if len(pe) > PROMPT_EXTRA_MAX_LEN:
            return web.json_response(
                {"ok": False,
                 "error": "prompt_extra 超过 %d 字符限制 (当前 %d)"
                           % (PROMPT_EXTRA_MAX_LEN, len(pe))},
                status=400)
        if card_desc and pe:
            prompt_text = card_desc + "; " + pe
        elif card_desc:
            prompt_text = card_desc
        elif pe:
            prompt_text = pe
        else:
            return web.json_response(
                {"ok": False,
                 "error": "card 描述为空且未提供 prompt_extra, 无法生成"},
                status=400)
        card_png_dst_kind = "card"
    else:
        text = body.get("text")
        if not isinstance(text, str):
            return web.json_response(
                {"ok": False, "error": "text 必须为字符串"}, status=400)
        if len(text) > TEXT_MAX_LEN:
            return web.json_response(
                {"ok": False,
                 "error": "text 超过 %d 字符限制 (当前 %d)" % (TEXT_MAX_LEN, len(text))},
                status=400)
        prompt_text = text

    # 互斥 (持锁短临界区): 跑批 / threepov / 本类任务任一在跑 → 409
    # 1.12b M1b: 端点互斥块首部查 _ext._enrollment_busy → 409 enrollment_busy
    with _ext._active_lock:
        if getattr(_ext, "_enrollment_busy", False):
            return web.json_response(
                {"ok": False,
                 "error": "enrollment_busy: 建档进行中, 请稍候"},
                status=409)
        if _ext._active is not None and _ext._active.is_alive():
            _phase = getattr(_ext._active_engine, "phase", "") or "跑批中"
            return web.json_response(
                {"ok": False,
                 "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                status=409)
        if _THREEPOV_ACTIVE:
            return web.json_response(
                {"ok": False, "error": "active_busy: 已有三视图任务在运行"}, status=409)
        if _SCENE_CANVAS_ACTIVE:
            return web.json_response(
                {"ok": False, "error": "active_busy: 已有场景画布任务在运行"}, status=409)

    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()
    # J2b: 画布配置 + 模板选择/族校验 (请求 workflow_path > canvas 配置 > 默认). 前置校验:
    # 在卡名参照复制之前 (400 时不留副本).
    _canvas_cfg = _canvas_config()
    wf_template, _wf_err = _canvas_workflow(
        bool(picture_ref_basename or card_refs),
        _canvas_request_param(body, "workflow_path"), _canvas_cfg)
    if _wf_err:
        return web.json_response({"ok": False, "error": _wf_err}, status=400)
    # 卡名模式 ref2v: 卡上画布 PNG 落在 archive_images/<卡名>/, 不在 input 根, 而引擎素材
    # 解析只在 input 根找 → 必须先复制到 input 根, 池用复制名 (与上方 image_path 模式同款
    # 隔离命名; 源文件缺失即 400, 与 image_path 前置校验同款).
    # F36 E2: 槽 1 源缺失 400 / 槽 2+ 缺失剔除告警 (不 400 挡下主图单槽).
    if card_png_dst_kind == "card" and card_refs:
        if not os.path.isfile(card_refs[0][0]):
            return web.json_response(
                {"ok": False,
                 "error": "card 首 scene 行 media 文件不存在: %s" % card_refs[0][0]},
                status=400)
        if len(card_refs) > 1:
            _kept = [card_refs[0]]
            for _src, _usage in card_refs[1:]:
                if os.path.isfile(_src):
                    _kept.append((_src, _usage))
                else:
                    print("[H3Batch scene_canvas] 卡参照行 media 文件不存在, 该参考槽跳过: %s"
                          % _src, flush=True)
            card_refs = _kept
    if card_refs:
        # F36 E2 多槽: 主流程同步复制各槽 (引擎 CSV 池行用复制名; render_sheet 后台
        # 幂等重做). 单槽槽 1 usage 抹 None (J1 单图裸池行 + image_paths 单项等价).
        csv_refs = []
        for i, (src, usage) in enumerate(card_refs):
            slot = i + 1
            bn = _canvas_ref_basename(SCENE_REF_BASENAME_FMT, slot, usage, task_id)
            ref_copy = os.path.join(input_dir, bn)
            os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
            shutil.copy2(src, ref_copy)
            csv_refs.append((slot, bn, usage))
        if len(csv_refs) == 1:
            csv_refs[0] = (1, csv_refs[0][1], None)
        picture_ref_basename = csv_refs[0][1]
        csv_path = _write_scene_canvas_csv(input_dir, prompt_text,
                                           refs=csv_refs, canvas=_canvas_cfg,
                                           ignore_words=card_ignore_words,
                                           ignore_clause=card_ignore_clause)
    else:
        csv_path = _write_scene_canvas_csv(input_dir, prompt_text,
                                           picture_ref=picture_ref_basename,
                                           canvas=_canvas_cfg,
                                           ignore_words=card_ignore_words,
                                           ignore_clause=card_ignore_clause)
    params = {
        "mode": "分镜",
        "workflow_path": wf_template,
        "csv_path": csv_path,
        "input_dir": input_dir,
        "server_input_dir": input_dir,
        "server_output_dir": output_dir,
        "port": body["port"],
        "start_from": 0,
        "retries": 2,
        "skip_done": True,
        "on_fail": "阻断",
        "resources_list": "[]",
        "resource_overrides": _canvas_engine_param(
            body, "resource_overrides", _canvas_cfg["resource_overrides"]),
        "lora_overrides": _canvas_engine_param(
            body, "lora_overrides", _canvas_cfg["lora_overrides"]),
    }
    try:
        eng = _ext.build_engine_from_params(params)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "engine_init: %s" % e}, status=400)

    # dst_png 目标 (handler 算好; render_sheet 内部抽尾帧到这里)
    if card_png_dst_kind == "card":
        dst_png = _scene_archive_png_path(input_dir, card_name)
    else:
        dst_png = _scene_asset_png_path(input_dir, task_id)

    _set_scene_status(output_dir, task_id, STATUS_STARTED, result_png_path=None, error=None)

    # 后台线程: render_sheet(kind="scene", ..., _eng=eng) 抽走 manifest 占位 / run /
    # join / tail / 写卡. handler 只剩置位 _SCENE_CANVAS_ACTIVE + 调 render_sheet +
    # 取软错误写注册表. 异步两步契约保持: 起线程 → 立即返回.
    # ref_src: render_sheet 用作 ref2v 参照图源 (image_path 模式 = body["image_path"];
    # 多槽/卡名模式 = 首槽源; 无 → t2v). handler 主流程已同步复制 + 写 CSV,
    # render_sheet 内部再走一遍 (CSV 重写幂等: 同 refs → 同内容).
    if card_refs:
        _do_run_ref_src = card_refs[0][0]
    elif "image_path" in body:
        _do_run_ref_src = body["image_path"]
    else:
        _do_run_ref_src = ""

    def _do_run():
        global _SCENE_CANVAS_ACTIVE
        _SCENE_CANVAS_ACTIVE = True
        try:
            _set_scene_status(output_dir, task_id, STATUS_RENDERING)
            # render_sheet 软失败 (尾帧/写卡) 落入 _RENDER_SHEET_SOFT_ERR; 硬失败 (eng.run
            # 抛) 直接冒泡 → 外层 except → STATUS_FAILED.
            render_sheet(
                "scene",
                prompt_text=prompt_text,
                ref_src=_do_run_ref_src,
                extra_refs=card_refs or None,
                card_name=card_name if card_png_dst_kind == "card" else "",
                dst_png=dst_png,
                manifest_prefix=SCENE_MANIFEST_PREFIX,
                task_prefix=SCENE_TASK_ID_PREFIX,
                task_id=task_id,
                output_subdir=SCENE_OUTPUT_SUBDIR,
                ignore_words=card_ignore_words,
                ignore_clause=card_ignore_clause,
                writeback=writeback,
                _eng=eng,
            )
            png = dst_png if os.path.isfile(dst_png) else None
            writeback_err = _take_render_sheet_soft_err()
            _set_scene_status(output_dir, task_id, STATUS_DONE,
                              result_png_path=png, error=writeback_err)
        except Exception as e:
            print("[H3Batch scene_canvas] 后台异常: %s" % traceback.format_exc(), flush=True)
            _set_scene_status(output_dir, task_id, STATUS_FAILED, error=str(e))
        finally:
            _SCENE_CANVAS_ACTIVE = False
            _ext._clear_active()

    with _ext._active_lock:
        # _ext._active_engine 由 render_sheet 接收 _eng 时顺手发布 (供端点互斥检查读 phase);
        # 此处只置 _active (线程引用), 启动线程. 异步两步契约: 立即起线程 → handler 立即返.
        _ext._active = threading.Thread(target=_do_run, daemon=True)
        _ext._active.start()

    return web.json_response({
        "ok": True,
        "started": True,
        "task_id": task_id,
        "status": STATUS_STARTED,
    })


async def _h3_scene_canvas_status(request):
    """GET /h3_batch/scene_canvas/status?task_id=... — 状态/产物路径查询 (#48, 与 #46 同构)."""
    global _SCENE_CANVAS_ACTIVE
    _ext = _resolve_ext()
    task_id = str(request.query.get("task_id", "") or "").strip()
    if not task_id:
        return web.json_response({"ok": False, "error": "task_id 缺失"}, status=400)
    if not task_id.startswith(SCENE_TASK_ID_PREFIX):
        return web.json_response(
            {"ok": False,
             "error": "invalid_task_id: 必须以 %s 前缀开头" % SCENE_TASK_ID_PREFIX},
            status=400)
    suffix = task_id[len(SCENE_TASK_ID_PREFIX):]
    if not suffix.isdigit():
        return web.json_response(
            {"ok": False, "error": "invalid_task_id: 格式非法"}, status=400)

    output_dir = folder_paths.get_output_directory()
    reg = _load_scene_registry(output_dir)
    if task_id not in reg:
        return web.json_response(
            {"ok": False, "error": "not_found: 任务不存在"}, status=404)

    entry = reg[task_id]
    status_v = entry.get("status", STATUS_STARTED)

    # 重启检测: started/rendering 但 in-memory 不可达 → interrupted (不挂死)
    if status_v in (STATUS_STARTED, STATUS_RENDERING):
        with _ext._active_lock:
            in_memory = _ext._active is not None and _ext._active.is_alive()
        if not in_memory and not _SCENE_CANVAS_ACTIVE:
            status_v = STATUS_INTERRUPTED
            entry = dict(entry)
            entry["error"] = "服务已重启, 请重新提交"

    return web.json_response({
        "ok": True,
        "task_id": task_id,
        "status": status_v,
        "result_png_path": entry.get("result_png_path"),
        "error": entry.get("error"),
    })


# ============ 道具画布路由 (V1.12b T3: #53 / #54) ============

async def _h3_item_canvas_submit(request):
    """POST /h3_batch/item_canvas — 提交道具多角度任务 (异步两步式, 与 #45/#47 同构).

    三给法互斥: text (纯文字) / image_path (裸图参照) / card_name (v3 character 卡, 卡首
    subject_prop 行 media 判 ref2v/t2v). 共用引擎互斥域 (_active) + 自有 _ITEM_CANVAS_ACTIVE
    三级门; 与 threepov/scene_canvas 互相拒绝; 建档期 _enrollment_busy 占位 → 409.
    F36 E2: image_paths (多图参照, 列表 1-8) 扩入互斥四选一."""
    global _ITEM_CANVAS_ACTIVE
    _ext = _resolve_ext()
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError) as e:
        return web.json_response({"ok": False, "error": "invalid_json: %s" % e}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 须为 JSON 对象"}, status=400)

    given = [k for k in ("text", "image_path", "card_name", "image_paths") if k in body]
    if len(given) == 0:
        return web.json_response(
            {"ok": False,
             "error": "missing_input: 四选一必填 text / image_path / card_name / image_paths"},
            status=400)
    if len(given) > 1:
        return web.json_response(
            {"ok": False,
             "error": "mutually_exclusive: text/image_path/card_name/image_paths 四选一, 不可同时给出多个",
             "detail": given},
            status=400)

    # image_path 前置校验 (路径存在 + PIL open), 不落盘即返 (与 #45/#47 同款)
    if "image_path" in body:
        ip = body.get("image_path")
        if not isinstance(ip, str):
            return web.json_response(
                {"ok": False, "error": "image_path 必须为字符串"}, status=400)
        if not os.path.isfile(ip):
            return web.json_response(
                {"ok": False, "error": "image_path 不存在或不是文件: %s" % ip}, status=400)
        try:
            from PIL import Image as _PILImage
            _PILImage.open(ip).verify()
        except Exception as e:
            return web.json_response(
                {"ok": False,
                 "error": "image_path 不是合法图片 (PIL open 失败: %s)" % e},
                status=400)

    # image_paths 前置校验 (F36 E2, 三端点同款 _image_paths_preflight).
    _err_resp = _image_paths_preflight(body)
    if _err_resp is not None:
        return _err_resp

    # 端口钉死 (严禁裸 0, 与 submit/rerun/quick/threepov/scene_canvas 同款铁律)
    try:
        _port_in_int = int(body.get("port") or 0)
    except (TypeError, ValueError):
        _port_in_int = 0
    if not _port_in_int:
        body["port"] = _ext._own_server_port()

    task_id = ITEM_TASK_ID_PREFIX + str(int(time.time()))

    card = None
    card_name = None
    card_ignore_words = ""
    card_ignore_clause = ""
    writeback = True          # 卡名模式写卡开关 (请求体 writeback, 缺省 True = 现状)
    card_png_dst_kind = None  # None=直接模式; "card"=卡名模式
    card_refs = []            # F36 E2 多槽参照 [(src, usage), ...] (image_paths / 卡名模式)
    picture_ref_basename = ""
    prompt_text = ""
    if "image_paths" in body:
        # F36 E2 多图模式: 各槽 usage=None (槽 1 锚定句 look N=1, 槽 2-8 通用句);
        # 复制延后到互斥校验后 (见下方多槽复制段, 409 拒绝时不留残留副本).
        prompt_text = "与参照图完全一致的同一道具"
        card_refs = [(p, None) for p in body["image_paths"]]
    elif "image_path" in body:
        server_input_dir = folder_paths.get_input_directory()
        ref_copy = _item_image_ref_copy_path(server_input_dir, task_id)
        os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
        shutil.copy2(body["image_path"], ref_copy)
        picture_ref_basename = ITEM_REF_BASENAME_FMT % task_id
        prompt_text = "与参照图完全一致的同一道具"
    elif "card_name" in body:
        cn = body.get("card_name")
        if not isinstance(cn, str):
            return web.json_response(
                {"ok": False, "error": "card_name 必须为字符串"}, status=400)
        if ":" in cn:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 含非法字符 ':' (Windows 文件名禁用)"},
                status=400)
        cn = cn.strip()
        if not cn:
            return web.json_response(
                {"ok": False, "error": "card_name 不能为空"}, status=400)
        card_name = _safe_filename(cn)
        if not card_name:
            return web.json_response(
                {"ok": False, "error": "card_name 不合法: 含路径分隔符或仅为特殊字符"},
                status=400)
        if len(card_name) > 64:
            return web.json_response(
                {"ok": False,
                 "error": "card_name 超过 64 字符限制 (当前 %d)" % len(card_name)},
                status=400)
        server_input_dir = folder_paths.get_input_directory()
        card = _read_v3_card(server_input_dir, card_name)
        if card is None:
            return web.json_response(
                {"ok": False, "error": "card_name 未在资产库中找到: %s" % card_name},
                status=404)
        # 1.12b M6: 道具端点收 kind=character 卡 (与 scene 端点反码, 端点语义自洁);
        # scene 卡 → 400 not_v3_character (与 #45 not_v3_character 文案同款).
        if not _is_v3_character(card):
            return web.json_response(
                {"ok": False,
                 "error": "not_v3_character: 仅支持 v3 character 卡, 当前卡 _v=%r kind=%r"
                          % (card.get("_v"), card.get("kind"))},
                status=400)
        # F36 E2: 卡名模式参照改 _collect_card_media 多槽收集 (item 白名单
        # [subject_prop, 道具多角度]). 槽 1 源缺失 400 / 槽 2+ 缺失剔除告警 (下方段).
        card_refs = _collect_card_media(card, "item")
        # v2.1 逐用途成句 (有参考图) / t2v 回落整卡 desc 合并; 忽略句同源归一结果.
        card_mapped = _map_card_rows_to_pictures(card, "item")
        card_segments = (_build_card_subject_segments(card, "item", card_mapped)
                         if card_refs else "")
        card_desc = card_segments or _extract_card_desc(card)
        card_ignore_words = _extract_card_ignore_words(card)
        card_ignore_clause = (_render_ignore_clause(card_mapped) if card_refs else "")
        wb = body.get("writeback", True)
        if not isinstance(wb, bool):
            return web.json_response(
                {"ok": False, "error": "writeback 必须为布尔值"}, status=400)
        writeback = wb
        pe = body.get("prompt_extra", "")
        if not isinstance(pe, str):
            return web.json_response(
                {"ok": False, "error": "prompt_extra 必须为字符串"}, status=400)
        if len(pe) > PROMPT_EXTRA_MAX_LEN:
            return web.json_response(
                {"ok": False,
                 "error": "prompt_extra 超过 %d 字符限制 (当前 %d)"
                           % (PROMPT_EXTRA_MAX_LEN, len(pe))},
                status=400)
        if card_desc and pe:
            prompt_text = card_desc + "; " + pe
        elif card_desc:
            prompt_text = card_desc
        elif pe:
            prompt_text = pe
        else:
            return web.json_response(
                {"ok": False,
                 "error": "card 描述为空且未提供 prompt_extra, 无法生成"},
                status=400)
        card_png_dst_kind = "card"
    else:
        text = body.get("text")
        if not isinstance(text, str):
            return web.json_response(
                {"ok": False, "error": "text 必须为字符串"}, status=400)
        if len(text) > TEXT_MAX_LEN:
            return web.json_response(
                {"ok": False, "error": "text 超过 %d 字符限制 (当前 %d)" % (TEXT_MAX_LEN, len(text))},
                status=400)
        prompt_text = text

    # 互斥 (持锁短临界区): 跑批 / threepov / scene / item 任一在跑 → 409
    # 1.12b M1b: 端点互斥块首部查 _ext._enrollment_busy → 409 enrollment_busy
    with _ext._active_lock:
        if getattr(_ext, "_enrollment_busy", False):
            return web.json_response(
                {"ok": False,
                 "error": "enrollment_busy: 建档进行中, 请稍候"},
                status=409)
        if _ext._active is not None and _ext._active.is_alive():
            _phase = getattr(_ext._active_engine, "phase", "") or "跑批中"
            return web.json_response(
                {"ok": False,
                 "error": "active_busy: 已有批量任务在运行 (phase=%s)" % _phase},
                status=409)
        if _THREEPOV_ACTIVE:
            return web.json_response(
                {"ok": False, "error": "active_busy: 已有三视图任务在运行"}, status=409)
        if _SCENE_CANVAS_ACTIVE:
            return web.json_response(
                {"ok": False, "error": "active_busy: 已有场景画布任务在运行"}, status=409)
        if _ITEM_CANVAS_ACTIVE:
            return web.json_response(
                {"ok": False, "error": "active_busy: 已有道具画布任务在运行"}, status=409)

    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()
    # J2b: 画布配置 + 模板选择/族校验 (请求 workflow_path > canvas 配置 > 默认). 前置校验:
    # 在卡名参照复制之前 (400 时不留副本).
    _canvas_cfg = _canvas_config()
    wf_template, _wf_err = _canvas_workflow(
        bool(picture_ref_basename or card_refs),
        _canvas_request_param(body, "workflow_path"), _canvas_cfg)
    if _wf_err:
        return web.json_response({"ok": False, "error": _wf_err}, status=400)
    # 卡名模式 ref2v: 卡上 prop PNG 落在 archive_images/<卡名>/, 不在 input 根, 而引擎素材
    # 解析只在 input 根找 → 必须先复制到 input 根, 池用复制名 (与上方 image_path 模式同款
    # 隔离命名; 源文件缺失即 400).
    # F36 E2: 槽 1 源缺失 400 / 槽 2+ 缺失剔除告警 (不 400 挡下主图单槽).
    if card_png_dst_kind == "card" and card_refs:
        if not os.path.isfile(card_refs[0][0]):
            return web.json_response(
                {"ok": False,
                 "error": "card 首 subject_prop 行 media 文件不存在: %s" % card_refs[0][0]},
                status=400)
        if len(card_refs) > 1:
            _kept = [card_refs[0]]
            for _src, _usage in card_refs[1:]:
                if os.path.isfile(_src):
                    _kept.append((_src, _usage))
                else:
                    print("[H3Batch item_canvas] 卡参照行 media 文件不存在, 该参考槽跳过: %s"
                          % _src, flush=True)
            card_refs = _kept
    if card_refs:
        # F36 E2 多槽: 主流程同步复制各槽 (引擎 CSV 池行用复制名; render_sheet 后台
        # 幂等重做). 单槽槽 1 usage 抹 None (J1 单图裸池行 + image_paths 单项等价).
        csv_refs = []
        for i, (src, usage) in enumerate(card_refs):
            slot = i + 1
            bn = _canvas_ref_basename(ITEM_REF_BASENAME_FMT, slot, usage, task_id)
            ref_copy = os.path.join(input_dir, bn)
            os.makedirs(os.path.dirname(ref_copy), exist_ok=True)
            shutil.copy2(src, ref_copy)
            csv_refs.append((slot, bn, usage))
        if len(csv_refs) == 1:
            csv_refs[0] = (1, csv_refs[0][1], None)
        picture_ref_basename = csv_refs[0][1]
        csv_path = _write_item_canvas_csv(input_dir, prompt_text,
                                          refs=csv_refs, canvas=_canvas_cfg,
                                          ignore_words=card_ignore_words,
                                          ignore_clause=card_ignore_clause)
    else:
        csv_path = _write_item_canvas_csv(input_dir, prompt_text,
                                          picture_ref=picture_ref_basename,
                                          canvas=_canvas_cfg,
                                          ignore_words=card_ignore_words,
                                          ignore_clause=card_ignore_clause)
    params = {
        "mode": "分镜",
        "workflow_path": wf_template,
        "csv_path": csv_path,
        "input_dir": input_dir,
        "server_input_dir": input_dir,
        "server_output_dir": output_dir,
        "port": body["port"],
        "start_from": 0,
        "retries": 2,
        "skip_done": True,
        "on_fail": "阻断",
        "resources_list": "[]",
        "resource_overrides": _canvas_engine_param(
            body, "resource_overrides", _canvas_cfg["resource_overrides"]),
        "lora_overrides": _canvas_engine_param(
            body, "lora_overrides", _canvas_cfg["lora_overrides"]),
    }
    try:
        eng = _ext.build_engine_from_params(params)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "engine_init: %s" % e}, status=400)

    # dst_png 目标 (handler 算好; render_sheet 内部抽尾帧到这里)
    if card_png_dst_kind == "card":
        dst_png = _item_archive_png_path(input_dir, card_name)
    else:
        dst_png = _item_asset_png_path(input_dir, task_id)

    _set_item_status(output_dir, task_id, STATUS_STARTED, result_png_path=None, error=None)

    # 后台线程: render_sheet(kind="item", ..., _eng=eng) 抽走 manifest 占位 / run /
    # join / tail / 写卡. handler 只剩置位 _ITEM_CANVAS_ACTIVE + 调 render_sheet +
    # 取软错误写注册表. 异步两步契约保持: 起线程 → 立即返回.
    if card_refs:
        _do_run_ref_src = card_refs[0][0]
    elif "image_path" in body:
        _do_run_ref_src = body["image_path"]
    else:
        _do_run_ref_src = ""

    def _do_run():
        global _ITEM_CANVAS_ACTIVE
        _ITEM_CANVAS_ACTIVE = True
        try:
            _set_item_status(output_dir, task_id, STATUS_RENDERING)
            render_sheet(
                "item",
                prompt_text=prompt_text,
                ref_src=_do_run_ref_src,
                extra_refs=card_refs or None,
                card_name=card_name if card_png_dst_kind == "card" else "",
                dst_png=dst_png,
                manifest_prefix=ITEM_MANIFEST_PREFIX,
                task_prefix=ITEM_TASK_ID_PREFIX,
                task_id=task_id,
                output_subdir=ITEM_OUTPUT_SUBDIR,
                ignore_words=card_ignore_words,
                ignore_clause=card_ignore_clause,
                writeback=writeback,
                _eng=eng,
            )
            png = dst_png if os.path.isfile(dst_png) else None
            writeback_err = _take_render_sheet_soft_err()
            _set_item_status(output_dir, task_id, STATUS_DONE,
                             result_png_path=png, error=writeback_err)
        except Exception as e:
            print("[H3Batch item_canvas] 后台异常: %s" % traceback.format_exc(), flush=True)
            _set_item_status(output_dir, task_id, STATUS_FAILED, error=str(e))
        finally:
            _ITEM_CANVAS_ACTIVE = False
            _ext._clear_active()

    with _ext._active_lock:
        _ext._active = threading.Thread(target=_do_run, daemon=True)
        _ext._active.start()

    return web.json_response({
        "ok": True,
        "started": True,
        "task_id": task_id,
        "status": STATUS_STARTED,
    })


async def _h3_item_canvas_status(request):
    """GET /h3_batch/item_canvas/status?task_id=... — 状态/产物路径查询 (#54, 与 #46/#48 同构)."""
    global _ITEM_CANVAS_ACTIVE
    _ext = _resolve_ext()
    task_id = str(request.query.get("task_id", "") or "").strip()
    if not task_id:
        return web.json_response({"ok": False, "error": "task_id 缺失"}, status=400)
    if not task_id.startswith(ITEM_TASK_ID_PREFIX):
        return web.json_response(
            {"ok": False,
             "error": "invalid_task_id: 必须以 %s 前缀开头" % ITEM_TASK_ID_PREFIX},
            status=400)
    suffix = task_id[len(ITEM_TASK_ID_PREFIX):]
    if not suffix.isdigit():
        return web.json_response(
            {"ok": False, "error": "invalid_task_id: 格式非法"}, status=400)

    output_dir = folder_paths.get_output_directory()
    reg = _load_item_registry(output_dir)
    if task_id not in reg:
        return web.json_response(
            {"ok": False, "error": "not_found: 任务不存在"}, status=404)

    entry = reg[task_id]
    status_v = entry.get("status", STATUS_STARTED)

    # 重启检测: started/rendering 但 in-memory 不可达 → interrupted (不挂死)
    if status_v in (STATUS_STARTED, STATUS_RENDERING):
        with _ext._active_lock:
            in_memory = _ext._active is not None and _ext._active.is_alive()
        if not in_memory and not _ITEM_CANVAS_ACTIVE:
            status_v = STATUS_INTERRUPTED
            entry = dict(entry)
            entry["error"] = "服务已重启, 请重新提交"

    return web.json_response({
        "ok": True,
        "task_id": task_id,
        "status": status_v,
        "result_png_path": entry.get("result_png_path"),
        "error": entry.get("error"),
    })
