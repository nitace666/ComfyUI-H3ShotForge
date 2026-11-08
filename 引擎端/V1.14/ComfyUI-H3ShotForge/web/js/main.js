// V1.9 D1 拆分: 核心域 — 入口/表单骨架/分镜行/collectData/回填/生成/预览/开关(R-B1)/页签/队列模式/全局参数区/CSV 工具
// 依赖: pool.js/assets.js/bindings.js (表单装配 ensureOverlay 需各域 section 构建函数;
// 域文件亦从本文件拉状态, 构成 ESM 环 — 各域顶层无副作用, 环安全)
import { api } from "../../../scripts/api.js";
import { app } from "../../../scripts/app.js";
import { openPicker } from "./path_picker.js";
import { buildPoolSection, attachOverrideButton,
         getPoseStyle, setPoseStyle, readPoolPoseStyles } from "./pool.js";
import { buildAssetsSection, loadAssets, lookupCardPoseStyle } from "./assets.js";
import {
    readBindingsState, renderBindingsPanel, snapshotBindingSlotsFromResult,
    upsertBindingFromCard, invalidateCastBlockCache, removeBinding,
} from "./bindings.js";
import { buildResourcesSection, initResourcesPanel } from "./resources.js";

// ============================================================================
// 1. 常量
// ============================================================================

const POOL_KEYS = ["Picture", "Video", "Audio"];
// 表单槽位数: 引擎侧仍按 1-9 槽解析 CSV, 表单只少给 Video/Audio 的 4-9 槽
const POOL_SLOTS = { Picture: 9, Video: 3, Audio: 3 };
const GLOBAL_KEYS = ["比例", "质量", "步数", "语言", "关音乐", "关对白", "关水印字幕", "默认负面", "配乐", "氛围声",
    // V1.10 批1 T4: BGM 通道表单控件 (D2) — 必须排在 提示词 之前;
    // 同步追加到 csv_gen.build_csv 白名单与 batch_core._parse_global/_apply_global.
    // 音乐文件 = BGM 物理路径 (空 = 功能关, 引擎 _bgm_path=='' 判定);
    // 音乐混入方式 = 替换(replace)/混合(mix), 默认 替换.
    //
    // 顺序契约 (P0 错位事故: 老板真机报 提示词框显示替换 — 2026-08):
    //   提示词 textarea 在 buildGlobalSection 渲染循环外最后 push 到 globalInputs,
    //   因此 GLOBAL_KEYS 中除 提示词 外的所有键必须全部排在 提示词 前,
    //   才能保证 fillForm/collectData 按下标位一一对齐 (GLOBAL_INPUT_KEYS 第 i 个 ↔ globalInputs 第 i 个).
    //   详见 .tmp/fix-global-misalign-brief.md.
    "音乐文件", "音乐混入方式",
    // V1.10 批2 T1: 审片门 (D1 数据层) — 0=关(默认), N≥1=每 N 段插入一个审片点;
    // 走通用 input 路径 (placeholder="0=关"), 不在 buildGlobalSection 加特判分支 (最小侵入).
    // 落 _review_every_n 引擎属性 → T2 接出暂停机制/审片报告; 解析层脏值防御: 非负整数 & ≤50.
    // 同步追加到 csv_gen.build_csv 白名单与 batch_core._parse_global/_apply_global.
    "审片门", "提示词"];
// 批 A 后小迭代: 三独立勾选 (替代原 "默认负面" 单开关)
// - label 逐字: 关音乐 / 关对白 / 关水印字幕 (UI 文案, 与 CSV 键同名)
// - 数据键逐字: 同 label
// - 值: 开/关 (与原 默认负面 兼容)
const NEGATIVE_TOGGLE_LABELS = ["关音乐", "关对白", "关水印字幕"];
const NEGATIVE_TOGGLE_KEYS = ["关音乐", "关对白", "关水印字幕"];
const NEGATIVE_TOGGLE_VALUES = { on: "开", off: "关" };
// 兼容 anchor: 旧 CSV 单开关仍认 (导入 → 三全勾映射; 导出仅在三勾选全不勾时写入 "默认负面,关" 以保兼容)
const DEFAULT_NEGATIVE_KEY = "默认负面";
const DEFAULT_NEGATIVE_VALUES = { on: "开", off: "关" };
// 表单侧平行数组: 与 globalInputs 一一对位 (三勾选走 checkbox 单独持, 不进数组)
const GLOBAL_INPUT_KEYS = GLOBAL_KEYS.filter((k) => !NEGATIVE_TOGGLE_KEYS.includes(k) && k !== DEFAULT_NEGATIVE_KEY);
// 批 A 节点 5 (5a): 分镜行 UI 移除「出场角色」列 — 引擎侧旧 CSV 仍认 (节点 2 retention 接线),
//                   导出 CSV 不再写该键; 导入旧 CSV 含此键时 collectData 不读 → 自然兼容
// 1.11b 波2 T6: 自定义模式逐段拼接勾选列 — 须与引擎 shot_vocab.CONCAT_FLAG_COL 同步, 否则 collectData 拿到
//   空串 → 引擎判否 → 整批走分镜 (静默错位). 末尾追加 = CSV 列序 = SHOT_HEADER + [该列] (csv_gen.py).
const CONCAT_FLAG_COL = "与上一片段拼接";
const SHOT_KEYS = ["ID", "镜头角度", "景别", "运镜方式", "运镜方向", "运镜幅度", "运镜速度", "焦段", "氛围", "情绪", "prompt", "段落时长", "种子", "导出文件名", CONCAT_FLAG_COL];
const SHOT_VOCAB_KEYS = ["镜头角度", "景别", "运镜方式", "运镜方向", "运镜幅度", "运镜速度", "焦段", "氛围", "情绪"];
// R5: 运镜方式 → 运镜方向允许集 (空数组 = 该方式无方向概念, 下拉清空并禁用);
// 未列出的方式与"未选方式" = 全量可选
const MOVE_DIR_ALLOW = {
  "固定机位": [],
  "推近": ["向前","向左前方","向右前方"],
  "拉远": ["向后","向左后方","向右后方"],
  "摇镜": ["向左","向右","向上","向下"],
  "移镜": ["向前","向后","向左","向右","向上","向下","向左前方","向右前方","向左后方","向右后方"],
  "跟拍": ["向前","向后","向左","向右","向上","向下","向左前方","向右前方","向左后方","向右后方"],
  "升降": ["向上","向下"],
  "环绕": ["顺时针","逆时针"],
  "手持摄影": [],
  "变焦推近": [],
  "变焦拉远": [],
  "横滚": ["顺时针","逆时针"],
  "强烈晃动": [],
};

// V1.10 批3 T1: 分镜行画线选运镜 — 小画布尺寸 + 几何阈值常量
//   画布 140×70 (深色背景+浅色描线), 用户按住拖动画一条线, 松手后纯前端几何识别
//   自动填 "运镜方式+运镜方向" 两个下拉 (所见即所得, 可手改); CSV/引擎零变化
const STROKE_CANVAS_W = 140;
const STROKE_CANVAS_H = 70;
const STROKE_MIN_LEN = 10;          // 最短笔距 (px), 起终 < 此值忽略 (防单击误触 NaN)
const STROKE_STRAIGHT_RATIO = 0.15; // 垂距/弦长阈值 (≤ 此值=直线, > 此值=弧线)

// V1.10 批3 T1: 笔画识别 — 纯函数, 几何 + 8 扇区 + 弧线顺逆时针判定
//   入参: [{x,y}, ...] 屏幕坐标采样点 (y 向下)
//   出参: {move, dir} 或 null (太短/点不足 → null)
//   直线 (垂距比 ≤ 0.15) → 8 扇区 (45° 一格, 中心 atan2 = k*π/4) → 钉死映射表:
//     右/左  → 移镜+向右/向左;  上/下  → 升降+向上/向下
//     右上/左上 → 推近+向右前方/向左前方;  右下/左下 → 拉远+向右后方/向左后方
//   弧线 (垂距比 > 0.15) → 累计有向转角 (sumCross): 屏幕坐标下, 正交叉积累计 >0 → 顺时针, <0 → 逆时针
//   验收钉死: 从左下向右上、向上凸的弧 → 环绕+顺时针 (sumCross > 0, 中点 y 偏小)
function _recognizeStroke(points) {
    if (!points || points.length < 2) return null;
    const x0 = points[0].x, y0 = points[0].y;
    const xn = points[points.length - 1].x, yn = points[points.length - 1].y;
    const dx = xn - x0, dy = yn - y0;
    const chordLen = Math.hypot(dx, dy);
    if (chordLen < STROKE_MIN_LEN) return null;  // 最短笔距防护
    // 弦向量旋转到 +x 方向, 各采样点垂直分量取绝对值最大
    const chordAngle = Math.atan2(dy, dx);
    const cosA = Math.cos(chordAngle), sinA = Math.sin(chordAngle);
    let maxDist = 0;
    for (const p of points) {
        const px = p.x - x0, py = p.y - y0;
        const perpDist = Math.abs(-sinA * px + cosA * py);
        if (perpDist > maxDist) maxDist = perpDist;
    }
    const ratio = maxDist / chordLen;
    if (ratio <= STROKE_STRAIGHT_RATIO) {
        // 直线 — 8 扇区映射 (at 2 行 SHOT_KEYS 外置, 此处仅引用文案)
        const angle = Math.atan2(dy, dx);
        // 8 扇区以 π/4 整数倍为中心; round 命中最近扇区, idx 经 mod 8 + 8 归正
        const sector = Math.round(angle / (Math.PI / 4));
        const idx = ((sector % 8) + 8) % 8;
        // 钉死映射: 0 右 / 1 右下 / 2 下 / 3 左下 / 4 左 / 5 左上 / 6 上 / 7 右上
        const mapping = [
            ["移镜", "向右"],
            ["拉远", "向右后方"],
            ["升降", "向下"],
            ["拉远", "向左后方"],
            ["移镜", "向左"],
            ["推近", "向左前方"],
            ["升降", "向上"],
            ["推近", "向右前方"],
        ];
        const [move, dir] = mapping[idx];
        return { move, dir };
    }
    // 弧线 — 累计有向转角: 屏幕坐标下 sumCross > 0 → 顺时针 (中点偏"上" 视觉)
    let sumCross = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y;
        const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y;
        sumCross += ax * by - ay * bx;
    }
    if (sumCross > 0) return { move: "环绕", dir: "顺时针" };
    return { move: "环绕", dir: "逆时针" };
}

// V1.9 R-B1: 分镜表单简洁/完整模式 — PRD v1.4 §十五
//   简洁: 卡片只显示 prompt + 段落时长; 九宫格/ID/种子/导出文件名 收进高级折叠区
//   完整: 与现状完全一致 (全部显示)
//   缺省简洁, localStorage 记忆 (key="h3_form_simple_mode", 值 "1"=简洁 / "0"=完整)
const FORM_MODE_KEY = "h3_form_simple_mode";
const FORM_MODE_SIMPLE = "simple";
const FORM_MODE_FULL = "full";

// ui-thumb-cache2: 格式集对齐 ComfyUI 官方支持 (LoadImage/LoadVideo/LoadAudio content_type)
//   Picture: image; Video: video; Audio: audio+video (音频槽可从视频提音)
// 与 quick_shot.js KIND_EXTS 保持一致
const POOL_EXTS = {
    Picture: [".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff"],
    Video: [".mp4", ".webm", ".mov", ".avi", ".mpeg", ".mpg", ".mkv"],
    Audio: [".wav", ".mp3", ".flac", ".aac", ".aiff", ".m4a", ".ogg", ".opus", ".mp4", ".webm", ".mov"],
};
// V1.10 批1 T4: BGM 文件选择器扩展集 — 与 Audio 池行全集 (POOL_EXTS.Audio) 子集对齐:
// 仅留常规纯音频容器 (含 .m4a / .ogg), 排除 .aiff / .opus (池行已支持但少用, 简报钉死 6 种).
// path_picker 不动, 在 main.js 调用 openPicker 处传此 const.
const BGM_FILE_EXTS = [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"];

// V1.4 T6b: 七类用途选项 — label 与 batch_core.py USAGE_REGISTRY["<id>"]["label"] 逐字对齐
// (改动必须同步: 后端加新用途 → 这里加条目; label 中含 · 字符仅作 UI 文案, id 用于数据)
// 1.11c 波2-T4: 加"三视图"条目 — 与 batch_core.USAGE_REGISTRY 单源同步
const USAGE_OPTIONS = [
    { id: "subject_look",   label: "人物·外貌" },
    { id: "subject_outfit", label: "人物·服装" },
    { id: "subject_prop",   label: "人物·道具" },
    { id: "三视图",         label: "人物·三视图" },
    { id: "scene",          label: "场景·环境" },
    { id: "pose",           label: "姿态·动作" },
    { id: "first_frame",    label: "首帧锚定" },
    { id: "video_ref",      label: "视频·动作参考" },
    { id: "audio_ref",      label: "音频参考" },
];

// V1.4 T6b: 按 kind 过滤用途 — Picture 6 类, Video 仅 video_ref, Audio 仅 audio_ref
// 与 batch_core.py USAGE_REGISTRY[*]["kind"] 单源同形(字段语义一致); 顺序与 USAGE_OPTIONS 同步
// T8 批2: subject_prop (Picture kind) 插 Picture 数组 — 收集与胶囊链路 F1 硬前提
// 1.11c 波2-T4: 三视图入 Picture 数组 (block="subject", 不进 ref / anchor)
const USAGE_BY_KIND = {
    Picture: ["subject_look", "subject_outfit", "subject_prop", "三视图", "scene", "pose", "first_frame"],
    Video:   ["video_ref"],
    Audio:   ["audio_ref"],
};

// T8 批3 (任务⑥): usage → kind 反向索引, 给 computeAssignResult / detectRowConflicts 单点查
// 单源: 由 USAGE_BY_KIND 反向构造, 与 batch_core USAGE_REGISTRY[id].kind 同形 (零漂移)
const _USAGE_KIND = {};
for (const [k, ids] of Object.entries(USAGE_BY_KIND)) {
    for (const id of ids) _USAGE_KIND[id] = k;
}

// 批 A 节点 5 (5e): H3 交替式模板常量 — 与 batch_core._H3_SEG_ORDER/_H3_SEG_TAG/_H3_SEG_ATTR 逐字一致
// 段顺序: 外貌 → 服装 → 道具 → 姿势; 同 usage 多槽按 slot 升序合并; desc 空省 desc 文字段保留锚定句
// 注: 这三个常量仅供 bindings.js 的 composeSubjectLineZh 使用, 实际声明在 bindings.js
// (本处只保留占位注释, 避免重复声明导致 bindings.js 与 main.js 双向 import 循环)

// G6: 新建档案表单复选框短文案映射 — 仅 makeRow 渲染消费, 不改 USAGE_OPTIONS 本身
//   id 对应短标签 (用于"左图右字段"两列式紧凑布局); 其他消费方(池 UI 等)继续读 USAGE_OPTIONS.label
// 批 A 节点 5 (5b/5c): pose 显示标签 = 人物·姿势 (与引擎 H3 锚定句 "人物姿势" 归位联动);
//   任务单 5b 明确"标签固定不可删(外貌/服装/道具/姿势——与引擎段落标签一致)" —
//   pose 改"人物·姿势"是显示标签 (5c), 引擎段内标签保持 _H3_SEG_TAG[""pose""]="姿势" 不变。
const USAGE_SHORT_LABEL = {
    subject_look:   "外貌",
    subject_outfit: "服装",
    subject_prop:   "道具",
    pose:           "人物·姿势",
    scene:          "场景",
    first_frame:    "首帧",
    video_ref:      "视频",
    audio_ref:      "音频",
};

// ============================================================================
// 2. 模块级状态 (跨域共享; 导出为 live binding)
// ============================================================================

export let overlay = null;
export let globalPromptTa = null;     // 2.6: 全局提示词 textarea 句柄, 供 fetchPreview 读取
export let previewTimer = null;       // 2.6: 防抖定时器, 编辑后 400ms 内合并刷新
const PREVIEW_DEBOUNCE_MS = 400;

export let poolInputs = {};             // POOL_KEYS → input 数组 (保留: collectData 仍读 .value)
export let poolUsageSets = {};          // V1.4 T6b: POOL_KEYS → Set<id>[] 每槽一个 Set, 多选用途 id
export let poolPillEls = {};            // V1.4 T6b: POOL_KEYS → 胶囊 span 数组 (按 USAGE_BY_KIND 顺序) — 视觉同步用
export let globalInputs = [];
// 批 A 后小迭代: 三独立勾选 checkbox 句柄
// 索引: 0=关音乐, 1=关对白, 2=关水印字幕
export let negativeSwitchEls = [];
export let repeatInput = null;
export let shotRows = [];
export let shotRowsEl = null;
export let modeRadios = [];
export let statusEl = null;
export let queueRows = [];
export let queueRowsEl = null;
export let tabBar = null;            // V1.4 T6b: tab 按钮容器 (队列清单模式下隐藏)
export let tabPanes = {};            // V1.4 T6b: tab 内容面板 {pool, global, shot} → div
export let tabBtns = {};             // V1.4 T6b: tab 按钮 {pool, global, shot, assets} → button
export let _h3ActiveTab = "pool";    // 2026-09-03 fixround: 当前活跃 tab — 模式切换后 restore 源
export let editSections = [];        // 分镜/拼接模式显示的 tab pane (队列清单模式隐藏, 数据保留)
export let queueSection = null;
export let current = null;
export let VOCAB = {};
export let pic9Input = null;       // 拼接模式 Picture 9 号槽(动态衔接槽: 可填=第1段起点, 第2段起自动=上一段尾帧)
export let assetsListEl = null;     // Task 5: 资产库 tab 内卡列表容器
export let assetsListErrEl = null;  // Task 5: 资产库损坏/错误信息显示位
export let assetsKindRadios = [];   // Task 5: kind 二选一 (character/scene), 用于 saveCardAsAsset 读
export let assignRoleSelect = null;  // T3: 层3 分配器 — 本批角色下拉 (含 v2 character 档案)
export let assignSceneSelect = null; // T3: 层3 分配器 — 本批场景下拉 (含 v2 scene 档案)
export let assetsByName = {};       // T3: 资产库 name → card 索引, 给分配器 + buildAssetRow 复用
// G1: v3 档案编辑态 — 模块级 (跨函数共享; editingCard = 当前正在编辑的卡名, null = 非编辑态)
export let editingCard = null;
// G1: 编辑入口模块级句柄 — buildV3ArchiveForm 构建时挂载, buildAssetRow 编辑按钮消费
export let editArchiveHandler = null;
// 批 H2-2: 绑定表状态 — [{name, no, slots:[{idx,usage,media,desc}..]}]
// 面板 UI 渲染依赖此数组; CSV 读写入口 (collectData/fillForm) 也读写它
export let castBindings = [];
export let castBindingsPanelEl = null;        // 绑定面板容器 (资产库 tab 建卡区上方)
export let castBindingsBlockCache = new Map();  // C6: 块拉取缓存 — name → {blocks, fingerprint}
export let castBindingAllocatedRecently = false; // C3: 控制 applyStateToFormDOM 触发新建条目
// 批 A 节点 5 (5a): 出场角色列移除 → CAST_DATALIST_ID / ensureCastDatalist / refreshCastDatalist 全部下线
// T4 AI 协作: 应用前快照(collectData()) + 导入响应容器, 用于「撤销导入」还原会话级状态
export let _aiPreSnapshot = null;
export let _aiImportLastData = null;  // 最近一次 ok=true 的响应 data, 应用按钮消费

// ============================================================================
// 3. 共享小工具 + 跨域桥接函数 (cycle-breaking 集中点)
// ============================================================================

function toast(severity, summary, detail) {
    const t = app.extensionManager?.toast?.add;
    if (t) t({ severity, summary, detail, life: 5000 });
}

// V1.10 批2 T4: 审片门 — 轮询句柄 (单例 — 重开面板先清旧; closeForm 清)
//   全局 setInterval 持句柄, openForm 启动, closeForm clearInterval. 失败静默 (徽标保持现状).
let _reviewPollTimer = null;
// V1.10 批2 T4: 放行续跑按钮句柄 (buildShotSection 挂载到 lab, applyReviewBadges/轮询回调控显隐)
let _reviewResumeBtn = null;
// V1.10 批2 T5: 审片门 — manifest 缺失防呆提示 (单例 DOM 句柄, ensureReviewNotice 内 if 已存在直接复用,
//   openForm 重复调用不堆积; closeForm 复位 style.display="none" 防重开闪现).
//   轮询 tick 内 noManifest 判定 (响应无 total 键 + shots 空对象) 命中时显示, 否则隐藏.
let _reviewNoticeEl = null;
// V1.10 批3 T3: 拼接模式 ≥5 段色彩对齐 flatten 提示条 (单例 DOM 句柄, ensureFlattenHint 内 if 已存在直接复用).
//   V1.9 色彩诊断结论: 拼接链续接时亮度逐段累积衰减, flatten 拉平段间均值是默认推荐 —
//   h3_config.json 默认已开. 长批次 (≥5 段) 显示黄条提醒用户保持开启, 避免误关导致色彩漂移.
//   显隐由 _updateFlattenHint 控制, 触发点: applyModeSections (模式切换) / 加分镜行 / 删分镜行.
let _flattenHintEl = null;
// V1.10 批3 T4b: 作废二选一确认浮层 (单例 DOM 句柄, ensureVoidChoiceDialog 内 if 已存在直接复用,
//   重复点击 void 按钮不堆积; 关闭路径: 取消按钮 / 点遮罩 / 选完动作后自动关).
//   按当前模式分支 — 拼接三按钮 (仅重做本段 / 级联 / 取消) / 分镜两按钮 (重做本段 / 取消).
//   选 solo → POST void body 加 solo:true; 选级联 → solo 不传 (缺省级联语义零变化).
let _voidChoiceDialogEl = null;
// V1.10 批3 T4b: P2 重跑作废段引导 (单例 DOM 句柄, ensureRerunVoidHint 内 if 已存在直接复用).
//   挂 tabBar 下方, 与 _reviewNoticeEl 同区域同风格 (灰黄小字).
//   条件: data.running === false 且 shots 中 review=="void" 的段数 ≥1 (实现按 review 字段计数,
//   无 status 过滤 — 老板决裁钉死: 任何 review==='void' 即计入, 不论生成状态).
//   按钮"重跑作废段" → toast 引导文案 (不自动提交 — 老板裁决钉死).
let _rerunVoidHintEl = null;

// V1.11 批 2 T1: 历史任务 tab 模块级句柄 — 上移到所有函数调用之前!
//   关键: buildHistorySection() 在 ensureOverlay 装配期 (≈ L687) 即被调用, 内部写
//   historyListEl/historyCountLab/historyMoreBtn; 若这 6 个 let 声明在文件下方
//   (原 ≈ L1304-1309), 触发 TDZ ReferenceError → ensureOverlay 中断 → historyPane
//   未挂载 → 浏览器点"历史任务"全 pane display:none (GUI 真机复现 P0).
//   必须与文件顶部其他 let 单例句柄 (_reviewPollTimer 等) 同区域声明.
let historyListEl = null;
let historyCountLab = null;
let historyMoreBtn = null;
let _historyTasks = [];       // 当前已加载任务 (时间倒序)
let _historyExpanded = new Set();  // 已展开任务 id 集合 (跨刷新保留展开态)
let _historyLoaded = false;   // 首次进 tab 懒加载标记

// V1.10 批2 T5: manifest 缺失防呆提示 — 单例建节点, 挂 tabBar 下方 (跨 tab 可见, 与具体 tab 内容无关),
//   灰黄小字风格 (沿用 form 既有的黄条 cssText 写法, 与 renderPreviewChecks 黄块一致).
//   初始隐藏; tick 内 noManifest 命中 → style.display="" 显示; 否则 = "none".
function ensureReviewNotice() {
    if (_reviewNoticeEl) return _reviewNoticeEl;
    const notice = document.createElement("div");
    notice.style.cssText = "color:#f9a825;background:rgba(249,168,37,.12);padding:6px 10px;border-radius:3px;font-size:12px;line-height:1.5;margin-bottom:8px;display:none;";
    notice.textContent = "未找到此 CSV 对应的批次记录——若重新生成过 CSV，批次跟随最新文件名；提交批次后此处恢复显示审片状态";
    // 挂载: tabBar 下方等价醒目位置 (跨 tab 可见, 提示与具体 tab 内容无关)
    if (tabBar && tabBar.parentNode) {
        tabBar.parentNode.insertBefore(notice, tabBar.nextSibling);
    } else if (typeof overlay !== "undefined" && overlay) {
        overlay.appendChild(notice);  // 退化: tabBar 尚未建时挂 overlay 顶部
    }
    _reviewNoticeEl = notice;
    return notice;
}

// V1.10 批3 T4b: P2 重跑作废段引导 — 单例建节点, 挂 tabBar 下方 (与 _reviewNoticeEl 同区域同风格).
//   初始隐藏; tick 内 (_updateRerunVoidHint) 判定 running===false 且 void 段计数 ≥1 → 显示;
//   否则隐藏. closeForm 复位 display="none" 防重开闪现.
function ensureRerunVoidHint() {
    if (_rerunVoidHintEl) return _rerunVoidHintEl;
    const notice = document.createElement("div");
    notice.id = "h3_rerun_void_hint";
    notice.style.cssText = "color:#f9a825;background:rgba(249,168,37,.12);padding:6px 10px;border-radius:3px;font-size:12px;line-height:1.5;margin-bottom:8px;display:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const txt = document.createElement("span");
    txt.style.cssText = "flex:1 1 auto;";
    txt.textContent = "";
    notice.appendChild(txt);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "重跑作废段";
    btn.style.cssText = "flex:none;padding:2px 10px;cursor:pointer;font-size:11px;color:#f9a825;background:rgba(249,168,37,.18);border:1px solid #f9a825;border-radius:3px;";
    btn.title = "查看重跑引导 (不自动提交 — 需手动重新点节点 Queue Prompt)";
    // 老板裁决钉死: 重提交只改提示文案不自动放行 — 按钮不调任何端点, 仅 toast 引导.
    btn.onclick = () => {
        toast("info", "H3 审片",
              "请重新提交批次任务（同 CSV，点节点 Queue Prompt）——引擎将自动用新种子重跑作废段，已通过段不会重跑。");
    };
    notice.appendChild(btn);
    notice._textEl = txt;
    // 挂载: tabBar 下方等价醒目位置 (跨 tab 可见, 与具体 tab 内容无关)
    if (tabBar && tabBar.parentNode) {
        tabBar.parentNode.insertBefore(notice, tabBar.nextSibling);
    } else if (typeof overlay !== "undefined" && overlay) {
        overlay.appendChild(notice);  // 退化: tabBar 尚未建时挂 overlay 顶部
    }
    _rerunVoidHintEl = notice;
    return notice;
}

// V1.10 批3 T4b: P2 提示条显隐刷新 — running===false 且 void 段数 ≥1 → 显示;
//   否则隐藏. 文案含 void 段数. 由轮询 tick 调用.
function _updateRerunVoidHint(data) {
    if (!_rerunVoidHintEl) return;
    // 1.11a 波 3 T2: 三态 unknown — 不显示"运行中"提示, 中性文案 (manifest 损坏/不可达时)
    const running = data && data.running === true;
    if (running) {
        _rerunVoidHintEl.style.display = "none";
        return;
    }
    if (data && data.running === "unknown") {
        _rerunVoidHintEl.style.display = "flex";
        _rerunVoidHintEl._textEl.textContent = "状态未知: 本批状态数据不可读, 等待恢复或刷新…";
        return;
    }
    let n = 0;
    if (data && data.shots && typeof data.shots === "object") {
        for (const sid of Object.keys(data.shots)) {
            const info = data.shots[sid];
            if (info && typeof info === "object" && info.review === "void") n += 1;
        }
    }
    const show = n >= 1;
    _rerunVoidHintEl.style.display = show ? "flex" : "none";
    if (show) {
        _rerunVoidHintEl._textEl.textContent = "本批已结束，有 " + n + " 段已作废未重做";
    }
}

// V1.10 批3 T3: 拼接模式 ≥5 段色彩对齐 flatten 提示条 — 单例创建, 挂分镜列表 tab 内 rowsEl 上方.
//   沿用 ensureReviewNotice 的黄条 cssText 字面 (color:#f9a825 + rgba(249,168,37,.12)),
//   与既有黄条视觉一致; 文案含段数 N (≥5) 与"色彩对齐/flatten"关键词.
function ensureFlattenHint(parentEl) {
    if (_flattenHintEl) return _flattenHintEl;
    const hint = document.createElement("div");
    hint.id = "h3_flaten_hint";
    hint.style.cssText = "color:#f9a825;background:rgba(249,168,37,.12);padding:6px 10px;border-radius:3px;font-size:12px;line-height:1.5;margin-bottom:8px;display:none;";
    hint.textContent = "本批 0 段（≥5），拼接链色彩会逐段漂移，建议保持色彩对齐 flatten 开启（h3_config.json 默认已开）";
    // 挂载: 分镜列表 tab 内, rowsEl 上方 — 调用方传 rowsEl.parentNode (即 sectionBox 返回的 box)
    // 这样 addBtn 在 hint 下方, 视觉上"提示 → 行列表 → 加行按钮"由上至下连贯.
    if (parentEl && parentEl.firstChild) {
        parentEl.insertBefore(hint, parentEl.firstChild);
    } else if (parentEl) {
        parentEl.appendChild(hint);
    }
    _flattenHintEl = hint;
    return hint;
}

// V1.10 批3 T3: 显隐刷新 — 模式=拼接 且 shotRows.length >= 5 时显示, 否则隐藏.
//   段数动态写进文案; 触发点: applyModeSections / 加分镜行 / 删分镜行.
// 1.11b 波2 T6: 单一刷新钩子 — 行结构 (加/删) / 模式切换 / AI 回填 / 初始化 共 4 路径已覆盖.
//   在末尾调 _refreshConcatFlagVisibility, 自定义模式拼接勾选列的显隐一并刷.
function _updateFlattenHint() {
    if (!_flattenHintEl) return;
    const mode = (modeRadios.find((r) => r.checked) || {}).value;
    const n = (typeof shotRows !== "undefined" && Array.isArray(shotRows)) ? shotRows.length : 0;
    const show = (mode === "拼接") && (n >= 5);
    _flattenHintEl.style.display = show ? "" : "none";
    if (show) {
        _flattenHintEl.textContent = "本批 " + n + " 段（≥5），拼接链色彩会逐段漂移，建议保持色彩对齐 flatten 开启（h3_config.json 默认已开）";
    }
    _refreshConcatFlagVisibility();
}

// 1.11b 波2 T6: 拼接勾选列显隐 + 第 1 段防串值.
//   仅 "自定义" 模式: 第 1 段恒隐藏 (引擎 _seg_mode 强制分镜; 显式勾选会被引擎第 1 段恒独立分支忽略但写入 CSV 触发 WARN),
//   隐藏时同步清空 (checked=false + value=""), 切回非自定义时保留其值 (防切模式丢数据).
function _refreshConcatFlagVisibility() {
    const mode = (modeRadios.find((r) => r.checked) || {}).value;
    const rows = (typeof shotRows !== "undefined" && Array.isArray(shotRows)) ? shotRows : [];
    rows.forEach((ctrls, idx) => {
        const cell = ctrls && ctrls._concatFlagCell;
        const cb = ctrls && ctrls[CONCAT_FLAG_COL];
        if (!cell || !cb) return;
        const isCustom = mode === "自定义";
        if (idx === 0) {
            // 第 1 段: 自定义模式恒隐藏 + 清空 (防第 1 段把 "是" 带进 CSV 触发引擎 WARN)
            cell.style.display = isCustom ? "none" : "";
            if (isCustom) { cb.checked = false; cb.value = ""; }
        } else {
            // 第 2 段起: 仅自定义模式显示; 非自定义保留值 (防切模式丢数据)
            cell.style.display = isCustom ? "" : "none";
        }
    });
}

// 批 B 节点 B-III 返工 必修 1 + 必修 3: 浮层拖选换算纯函数
// 输入: dragRect (container css px), imgOffsetX/Y (img 在 container 内偏移, object-fit:contain 居中),
//       imgDisplayW/H (img 实际显示区 px), origW/H (原图像素, 由 /h3_batch/image_meta 返回)
// 输出: 原图像素 {x, y, w, h}; 输入非法 (拖太小/显示区无效) → null
// 模块顶层声明 — parity 沙箱测试可直接 require 调用 (test_parity_crop_rect.py)
function h3ComputeRectFromDrag(dragRect, imgOffsetX, imgOffsetY, imgDisplayW, imgDisplayH, origW, origH) {
    if (!dragRect || dragRect.w < 1 || dragRect.h < 1) return null;
    if (imgDisplayW <= 0 || imgDisplayH <= 0) return null;
    if (!isFinite(origW) || !isFinite(origH) || origW <= 0 || origH <= 0) return null;
    const sx = origW / imgDisplayW;
    const sy = origH / imgDisplayH;
    const px = Math.max(0, Math.floor((dragRect.x - imgOffsetX) * sx));
    const py = Math.max(0, Math.floor((dragRect.y - imgOffsetY) * sy));
    const pw = Math.min(origW - px, Math.ceil(dragRect.w * sx));
    const ph = Math.min(origH - py, Math.ceil(dragRect.h * sy));
    if (pw <= 0 || ph <= 0) return null;
    return { x: px, y: py, w: pw, h: ph };
}

// 同步胶囊视觉 (按 set 状态重绘) — 抽出来给 filled/skipped 复用
// 从 pool.js 上移以打破 pool ↔ bindings 循环 import
function syncPillsVisual(pills, set) {
    for (const pill of pills) {
        const on = set.has(pill.dataset.usageId);
        pill.style.cssText = on
            ? "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;background:rgba(240,160,64,.18);color:#f0a040;border:1px solid #f0a040;"
            : "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;background:#1a1a1e;color:#aaa;border:1px solid #555;";
    }
}

// 清池联动: 槽被清空 → 删该 idx; 空 → 删条目
// 由 assignArchiveToForm / 池变更链路调用; name, slotIdx
// 从 bindings.js 上移以打破 pool ↔ bindings 循环 import
function onBindingSlotCleared(name, slotIdx) {
    const entry = castBindings.find((b) => b && b.name === name);
    if (!entry) return;
    entry.slots = (entry.slots || []).filter((s) => s.idx !== slotIdx);
    if (!entry.slots.length) {
        // V1.13 波2 D10: 复用 removeBinding 的 Subject 行清理 (避开孤儿 <Subject N> 残留).
        // removeBinding 同时清理池槽 (幂等 — 此处池槽已被外部清)、删 Subject 行、
        // 删条目、invalidate cache、schedule preview、toast — 与 ✕ 按钮路径字节级对齐.
        removeBinding(name);
        return;
    }
    renderBindingsPanel();
}

// V1.6: 分镜 ID/导出文件名自动递增 — 空项用最近一个可递增值 +1 填充.
// increment 用 /^(.*?)(\d+)$/ 拆前缀+数字, padStart 保持原位数 (S999 → S1000 自然进位不截断).
// 非空行: 可递增则更新锚; 无尾随数字(手填怪名)保留原值但不打断链 — 序列跳过它继续递增.
function cascadeIncrements(values) {
    const out = (Array.isArray(values) ? values : []).map((x) => String(x || ""));
    let last = "";
    for (let i = 0; i < out.length; i++) {
        if (out[i]) { if (/^(.*?)(\d+)$/.test(out[i])) last = out[i]; continue; }
        const m = /^(.*?)(\d+)$/.exec(last);
        if (!m) continue;
        out[i] = m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
        last = out[i];
    }
    return out;
}

// V1.6: 对 shotRows 的指定字段做级联递增 — 只写空白行, 不动手动已填行.
function applyCascadeToBlankRows(key) {
    const all = shotRows.map((c) => (c[key] && c[key].value) || "");
    const cascaded = cascadeIncrements(all);
    for (let i = 0; i < shotRows.length; i++) {
        if (!all[i].trim() && cascaded[i]) shotRows[i][key].value = cascaded[i];
    }
}

// 极简带引号容错的单行 CSV 解析 (队列清单只有三列纯文本)
function parseCsvLine(line) {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

function csvEscape(v) {
    v = String(v == null ? "" : v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function sectionBox(text) {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #555;border-radius:6px;padding:10px;margin-bottom:12px;";
    const lab = document.createElement("div");
    lab.textContent = text;
    lab.style.cssText = "font-weight:700;margin-bottom:8px;";
    box.appendChild(lab);
    return box;
}

// ============================================================================
// 4. 主要函数 — 表单模式 / 加载
// ============================================================================

function getFormMode() {
    try {
        const v = localStorage.getItem(FORM_MODE_KEY);
        // 无记录或 "1" → 简洁; 显式 "0" → 完整
        return v === "0" ? FORM_MODE_FULL : FORM_MODE_SIMPLE;
    } catch (e) {
        return FORM_MODE_SIMPLE;
    }
}
function setFormMode(mode) {
    try { localStorage.setItem(FORM_MODE_KEY, mode === FORM_MODE_FULL ? "0" : "1"); } catch (e) {}
}

async function loadVocab() {
    try {
        return await (await api.fetchApi("/h3_batch/vocab")).json();
    } catch (e) {
        return {};
    }
}

async function loadExisting(widgets) {
    const p = widgets.get?.("csv_path") || "";
    if (!p.toLowerCase().endsWith(".csv")) return null;
    try {
        const r = await api.fetchApi("/h3_batch/parse_csv?path=" + encodeURIComponent(p));
        const j = await r.json();
        return j.error ? null : j;
    } catch (e) {
        return null;
    }
}

// 批 L2: 自动入库 — 库外媒体路径 (含绝对盘符如 I:\...) 复制进 archive_images\<archive_name>\.
// 库内路径 (含 "asset_library" + "archive_images") 直接返回. 失败抛 Error (含后端 error 文案).
// 调用方负责 catch 后 toast + 早返. 用于三处: rectCropBtn / saveCardAsAsset / v3 保存循环.
async function ensureMediaInLibrary(src, archiveName) {
    const s = String(src || "").trim();
    if (!s) return s;
    if (s.indexOf("asset_library") >= 0 && s.indexOf("archive_images") >= 0) return s;
    const arch = String(archiveName || "").trim();
    if (!arch) throw new Error("未填写卡名, 库外图无法入库");
    const baseName = s.replace(/\\/g, "/").split("/").pop() || s;
    const cr = await api.fetchApi("/h3_batch/asset_copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src: s, archive_name: arch, suggest_name: baseName }),
    });
    let cj = null;
    try { cj = await cr.json(); } catch (_) { /* 留空 */ }
    if (!cr.ok || !cj || cj.error || !cj.path) {
        throw new Error((cj && cj.error) ? cj.error : ("HTTP " + cr.status));
    }
    return cj.path;
}

// V1.4 T6b: 切 tab — 同一容器 display 切换(非 DOM 重建), 已填数据不丢
// V1.11 批 2 T1: 历史任务 tab (resources 之后) — order 数组同步 tabs 数组
// 2026-09-03 fixround: 写 _h3ActiveTab — 模式切换后 applyModeSections 恢复当前 tab 用
function switchTab(name) {
    _h3ActiveTab = name;
    const order = ["pool", "global", "shot", "assets", "resources", "history"];
    for (const k of order) {
        const show = k === name;
        const pane = tabPanes[k];
        const btn = tabBtns[k];
        if (pane) pane.style.display = show ? "" : "none";
        if (btn) {
            // 高亮当前 tab
            if (show) {
                btn.style.background = "#3a3a3e";
                btn.style.color = "#f0a040";
                btn.style.borderBottomColor = "#f0a040";
            } else {
                btn.style.background = "transparent";
                btn.style.color = "#aaa";
                btn.style.borderBottomColor = "transparent";
            }
        }
    }
    // V1.11 批 2 T1: 首次进 history tab → 懒加载历史任务列表
    if (name === "history" && typeof _loadHistoryListIfNeeded === "function") {
        _loadHistoryListIfNeeded();
    }
}

function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;";

    const panel = document.createElement("div");
    // V1.11 fix2: panel 高度改为固定 height:90vh (不再 max-height), 切模式时内容
    // 变化不引起面板跳动; resize:both 给右下角原生缩放手柄; min-* 防压缩破布局。
    panel.style.cssText = "background:#2a2a2e;color:#e6e6e6;border:1px solid #666;border-radius:8px;padding:16px;width:940px;max-width:96vw;height:90vh;min-width:560px;min-height:400px;resize:both;overflow:auto;font:13px/1.6 sans-serif;";

    const title = document.createElement("div");
    title.textContent = "H3 批次 CSV 表单";
    title.style.cssText = "font-size:15px;font-weight:700;margin-bottom:12px;";

    // 顶部: 模式单选(保持原位置行为)
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "margin-bottom:12px;";
    modeRow.appendChild(document.createTextNode("模式: "));
    for (const m of ["分镜", "拼接", "自定义", "队列清单"]) {
        const lab = document.createElement("label");
        lab.style.marginRight = "14px";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "h3_mode";
        radio.value = m;
        radio.onchange = applyModeSections;
        modeRadios.push(radio);
        lab.appendChild(radio);
        lab.appendChild(document.createTextNode(m));
        modeRow.appendChild(lab);
    }

    // V1.4 T6b: Tab 栏(三项) — 队列清单模式下整栏隐藏
    // V1.9 批 2 T2.4 R1: 加 "资源编排" tab (assets 之后)
    // V1.11 批 2 T1: 加 "历史任务" tab (resources 之后) — 缩略图墙 + 段网格 + 拼接置灰
    tabBar = document.createElement("div");
    tabBar.style.cssText = "display:flex;gap:2px;border-bottom:1px solid #555;margin-bottom:12px;white-space:nowrap;";  // V1.4 T6c: 窄窗口不折行, 溢出可滚动
    const tabs = [
        ["pool",      "素材池"],
        ["global",    "全局参数"],
        ["shot",      "分镜列表"],
        ["assets",    "资产库"],
        ["resources", "资源编排"],
        ["history",   "历史任务"],
    ];
    for (const [k, label] of tabs) {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.type = "button";
        btn.dataset.tab = k;
        btn.style.cssText = "padding:8px 18px;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:4px 4px 0 0;background:transparent;color:#aaa;font-size:13px;font-weight:600;";
        btn.onclick = () => switchTab(k);
        tabBtns[k] = btn;
        tabBar.appendChild(btn);
    }

    // Tab pane: 素材池
    const poolPane = document.createElement("div");
    poolPane.dataset.tabPane = "pool";
    for (const key of POOL_KEYS) {
        poolPane.appendChild(buildPoolSection(key));
    }
    tabPanes.pool = poolPane;

    // Tab pane: 全局参数
    const globalPane = document.createElement("div");
    globalPane.dataset.tabPane = "global";
    globalPane.appendChild(buildGlobalSection());
    tabPanes.global = globalPane;

    // Tab pane: 分镜列表
    const shotPane = document.createElement("div");
    shotPane.dataset.tabPane = "shot";
    shotPane.appendChild(buildShotSection());
    tabPanes.shot = shotPane;

    // Tab pane: 资产库 (Task 5)
    const assetsPane = document.createElement("div");
    assetsPane.dataset.tabPane = "assets";
    assetsPane.appendChild(buildAssetsSection());
    tabPanes.assets = assetsPane;

    // V1.9 批 2 T2.4 R1: 资源编排 tab pane (assets 之后)
    // 装配时建空壳; 真实数据在 openForm 时由 initResourcesPanel 异步加载 (含后端 template_loras 发现)
    const resourcesPane = document.createElement("div");
    resourcesPane.dataset.tabPane = "resources";
    // 沙箱拼接测试 (test_rb1_simple_mode) 只拼 main/pool/bindings/assets, 不含 resources.js;
    // 真实浏览器环境 always import 了 resources.js (ESM 链)。资源段可缺失时降级为空 div 容器。
    if (typeof buildResourcesSection === "function") {
        resourcesPane.appendChild(buildResourcesSection());
    }
    tabPanes.resources = resourcesPane;

    // V1.11 批 2 T1: 历史任务 tab pane (resources 之后) — 缩略图墙 + 段网格 + 拼接置灰
    // 首次进 tab 时由 _loadHistoryListIfNeeded 懒加载 (GET history limit=50)
    const historyPane = document.createElement("div");
    historyPane.dataset.tabPane = "history";
    historyPane.appendChild(buildHistorySection());
    tabPanes.history = historyPane;

    editSections = [poolPane, globalPane, shotPane, assetsPane, resourcesPane, historyPane];
    // V1.4 T6c: 三 pane 统一固定高度+内部滚动 — 内容多少都不影响外层总高, 切 tab 底部生成栏位置恒定
    for (const pane of editSections) { pane.style.height = "560px"; pane.style.overflowY = "auto"; }

    // 队列清单模式专属区块: 每行 csv_path + mode + repeat (与 V1.4 T6 一致,零改动)
    const qBox = sectionBox("队列任务 (每行一个 CSV 任务)");
    const qRows = document.createElement("div");
    qBox.appendChild(qRows);
    queueRowsEl = qRows;
    const qAdd = document.createElement("button");
    qAdd.textContent = "➕ 加任务";
    qAdd.style.cssText = "margin-top:8px;padding:4px 12px;cursor:pointer;";
    qAdd.onclick = () => qRows.appendChild(buildQueueRow());
    qBox.appendChild(qAdd);
    queueSection = qBox;

    // 底部常驻: 批次次数 + 生成/重置/取消 + 状态行 (切 tab 不消失)
    // V1.11 fix2: sticky 钉底 — 内容多时, bottom 不滚走 (panel 已 overflow:auto)
    const bottom = document.createElement("div");
    bottom.style.cssText = "position:sticky;bottom:0;background:#2a2a2e;display:flex;align-items:center;gap:12px;margin-top:14px;padding-top:10px;border-top:1px solid #555;z-index:1;";
    const repLab = document.createElement("span");
    repLab.textContent = "批次次数";
    repLab.style.cssText = "flex:none;";
    repeatInput = document.createElement("input");
    repeatInput.type = "number";
    repeatInput.min = "1";
    repeatInput.max = "50";
    repeatInput.placeholder = "1=不重复";
    repeatInput.style.cssText = "width:90px;padding:4px 6px;box-sizing:border-box;";
    const genBtn = document.createElement("button");
    genBtn.textContent = "生成 CSV";
    genBtn.style.cssText = "padding:6px 18px;cursor:pointer;white-space:nowrap;flex:none;";
    genBtn.onclick = () => generate(genBtn);
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "🔄 重置";
    resetBtn.style.cssText = "padding:6px 18px;cursor:pointer;white-space:nowrap;flex:none;";
    // Electron 下原生 confirm 关闭后 webview 拿不回焦点, 改为二次点击确认(零弹窗)
    let resetArmed = null;
    resetBtn.onclick = () => {
        if (resetArmed) {
            clearTimeout(resetArmed); resetArmed = null;
            resetBtn.textContent = "🔄 重置"; resetBtn.style.color = "";
            resetForm(true);
            shotRowsEl.appendChild(buildShotRow());
            // 1.11b 波2 T5b 返工: 重置后首行可能落在自定义模式, 必须立即刷勾选框显隐
            _refreshConcatFlagVisibility();
            queueRowsEl.appendChild(buildQueueRow());
            statusEl.textContent = "已重置";
            return;
        }
        resetBtn.textContent = "⚠ 再点一次确认重置"; resetBtn.style.color = "#e5534b";
        resetArmed = setTimeout(() => { resetArmed = null; resetBtn.textContent = "🔄 重置"; resetBtn.style.color = ""; }, 3000);
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 18px;cursor:pointer;white-space:nowrap;flex:none;";
    cancelBtn.onclick = closeForm;
    // T5 停止按钮: 二次点击确认 (同重置/删除按钮 3 秒未点第二次恢复原文案)。
    // 常显; 无任务时后端 cancel 返 cancelled:False 自然提示。
    // POST /h3_batch/cancel — 当前段跑完收尾, 余段标记 stopped (断点续跑可重跑)。
    const stopBtn = document.createElement("button");
    stopBtn.textContent = "停止";
    stopBtn.style.cssText = "padding:6px 18px;cursor:pointer;white-space:nowrap;flex:none;";
    let stopArmed = null;
    stopBtn.onclick = async () => {
        if (stopArmed) {
            clearTimeout(stopArmed); stopArmed = null;
            stopBtn.textContent = "停止"; stopBtn.style.color = "";
            try {
                const r = await api.fetchApi("/h3_batch/cancel", { method: "POST" });
                const j = await r.json();
                if (j && j.cancelled) {
                    toast("info", "H3 批量", "已停止; 余段标记 stopped, 重跑可断点续跑");
                } else {
                    toast("warn", "H3 批量", "当前没有任务在跑");
                }
            } catch (e) {
                toast("error", "H3 批量", "停止失败: " + (e && e.message ? e.message : e));
            }
            return;
        }
        stopBtn.textContent = "确认停止?"; stopBtn.style.color = "#e5534b";
        stopArmed = setTimeout(() => { stopArmed = null; stopBtn.textContent = "停止"; stopBtn.style.color = ""; }, 3000);
    };
    // T5 状态文案: 跑批结果显示在节点控制台日志; 表单侧 statusEl 仅做生成/保存提示。
    // stopped/missing_file 段在 manifest 落盘, 续跑会自动重跑。
    // "⚠ 缺产物" 提示文案常量, 供控制台日志/二次提示复用 (最小实现: 文本常量存在即视为链路通).
    window.__H3_STATUS_HINTS__ = Object.freeze({
        stopped: "已停止",
        missing_file: "⚠ 缺产物",
        success: "已完成",
        failed: "失败",
        rendering: "渲染中",
    });
    statusEl = document.createElement("span");
    statusEl.style.cssText = "color:#ff9a62;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";  // V1.13 必修1R: 省略号三件套补 nowrap — 真实浏览器量测暴露: 挤压态无 nowrap 时状态文字折竖条行高暴涨
    bottom.appendChild(repLab);
    bottom.appendChild(repeatInput);
    bottom.appendChild(genBtn);
    bottom.appendChild(resetBtn);
    bottom.appendChild(stopBtn);
    bottom.appendChild(cancelBtn);
    bottom.appendChild(statusEl);

    panel.appendChild(title);
    panel.appendChild(modeRow);
    panel.appendChild(tabBar);
    panel.appendChild(poolPane);
    panel.appendChild(globalPane);
    panel.appendChild(shotPane);
    panel.appendChild(assetsPane);
    panel.appendChild(resourcesPane);
    panel.appendChild(historyPane);
    panel.appendChild(qBox);
    panel.appendChild(bottom);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // 默认激活素材池 tab
    switchTab("pool");
    return overlay;
}

function buildGlobalSection() {
    const box = sectionBox("全局参数 (比例/质量/步数/语言/三勾选 + 全局提示词)");
    const shortRow = document.createElement("div");
    // 2026-09-03 fixround: 统一三列网格 — 窄窗降级到 auto-fill minmax(240px, 1fr)
    //   所有控件 cell (含 BGM 路径/三勾选/自动拼接复选/预设行) 入 grid; 预设行跨 3 列; 提示词 textarea 跨 3 列独立行
    shortRow.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;align-items:center;margin-bottom:8px;";
    shortRow.dataset.h3Role = "global-grid";
    // 窄窗媒体查询 — 由本节点注入一次性 <style> 覆盖 (按当前节点实例无副作用)
    if (typeof document !== "undefined" && !document.getElementById("h3-global-grid-responsive")) {
        const _style = document.createElement("style");
        _style.id = "h3-global-grid-responsive";
        _style.textContent = "@media (max-width:900px){[data-h3-role='global-grid']{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));}}";
        document.head.appendChild(_style);
    }
    // R5: 普通字段在前、三勾选 append 在 shortRow 尾部 (用户: 开关类放后面)
    GLOBAL_KEYS.forEach((key) => {
        if (key === "提示词") return;
        // 三勾选已在下方统一渲染, 此处跳过
        if (NEGATIVE_TOGGLE_KEYS.includes(key)) return;
        const cell = document.createElement("div");
        cell.style.cssText = "display:flex;align-items:center;gap:6px;";
        const lab = document.createElement("span");
        // 默认负面不再单独渲染 UI (数据键保留, 仅作兼容 anchor)
        if (key === DEFAULT_NEGATIVE_KEY) return;
        lab.textContent = key;
        // R5: min-width:3em 统一标签宽 — 3em 容 3 字, 2 字标签后的输入框左缘与三字标签对齐
        // (R4 去定宽改 nowrap 解决折行, 但 2/3 字标签宽差仍使输入框左缘错落)
        lab.style.cssText = "flex:none;min-width:3em;white-space:nowrap;";
        let inp;
        if (key === "语言") {
            // 2.9: 语言特例 — select 选项 ""/中文/英文, 默认 ""(空=中文), label 提示
            inp = document.createElement("select");
            inp.appendChild(new Option("", ""));
            inp.appendChild(new Option("中文", "中文"));
            inp.appendChild(new Option("英文", "英文"));
            inp.title = "语言(空=中文)";
            inp.style.cssText = "width:110px;padding:2px 6px;box-sizing:border-box;";
            inp.addEventListener("change", schedulePreviewAll);  // 2.9: 即时预览
        } else if (key === "音乐文件") {
            // V1.10 批1 T4: BGM 文件路径 — input + 📁 按钮 (openPicker, exts=BGM_FILE_EXTS);
            // 空路径 = 功能关 (引擎 _bgm_path=="" 判定), 故无独立 checkbox.
            // cell 内追加两个子节点 (input + button), 与其他 cell "label + ctrl" 模式不同.
            inp = document.createElement("input");
            inp.placeholder = "BGM 文件路径 (空=关)";
            inp.title = "BGM 文件路径 (空 = 功能关)";
            inp.style.cssText = "flex:1;min-width:0;padding:2px 6px;box-sizing:border-box;";
            inp.dataset.key = "音乐文件";
            const bgmBtn = document.createElement("button");
            bgmBtn.type = "button";
            bgmBtn.textContent = "📁";
            bgmBtn.title = "浏览选择 BGM 文件";
            bgmBtn.style.cssText = "flex:none;padding:0 4px;cursor:pointer;";
            bgmBtn.onclick = () => openPicker({
                kind: "file",
                exts: BGM_FILE_EXTS,
                onPick: (p) => { inp.value = p; },
                nativePick: null,
                title: "选择 BGM 文件",
                current: inp.value,
            });
            cell.appendChild(inp);
            cell.appendChild(bgmBtn);
            shortRow.appendChild(cell);
            globalInputs.push(inp);
            return;  // 已自行 appendChild, 跳过下面通用 append 路径
        } else if (key === "音乐混入方式") {
            // V1.10 批1 T4: BGM 混入方式 — select 选项 替换/混合, 默认 替换;
            // 引擎侧 _parse_global 已做白名单防御, 此处仅负责中文标签 + 默认选中.
            inp = document.createElement("select");
            const optR = new Option("替换", "替换");
            const optM = new Option("混合", "混合");
            optR.defaultSelected = true;  // 浏览器渲染时即选中 (Option 内置属性)
            inp.appendChild(optR);
            inp.appendChild(optM);
            inp.title = "BGM 与视频原音的混合方式 (替换 / 混合)";
            inp.style.cssText = "width:110px;padding:2px 6px;box-sizing:border-box;";
            cell.appendChild(inp);
            shortRow.appendChild(cell);
            globalInputs.push(inp);
            return;  // 已自行 appendChild, 跳过下面通用 append 路径
        } else {
            inp = document.createElement("input");
            // V1.10 批2 T4: 审片门 placeholder="0=关" (0=关闭, N≥1=每 N 段插入审片点);
            // 通用 input 路径未做专用分支, 最小侵入 (与 T1 报告说明一致).
            inp.placeholder = key === "比例" ? "16:9" : key === "质量" ? "0.4" : key === "配乐" ? "如: 钢琴曲" : key === "氛围声" ? "如: 雨声" : key === "审片门" ? "0=关" : "8V8A";
            inp.style.cssText = "width:110px;padding:2px 6px;box-sizing:border-box;";
            // T2: 配乐/氛围声 — 提示 title 说明语义(写入每段提示词独立行)
            if (key === "配乐") inp.title = "全局配乐描述, 写入每段提示词独立行(如 钢琴)";
            else if (key === "氛围声") inp.title = "全局氛围声描述, 写入每段提示词独立行(如 雨声)";
            else if (key === "审片门") {
                // V1.10 批2 T4: 审片门 — dataset.key 标记 (供 applyModeSections 队列模式置灰定位);
                // 其他通用 input 仍按下标对齐 (GLOBAL_INPUT_KEYS[i]↔globalInputs[i]), 不动契约.
                inp.dataset.key = "审片门";
                inp.title = "审片门 N=每 N 段插入一个审片点 (0=关闭, 引擎暂停等候裁决)";
            }
            // T7 fix 2: 配乐/氛围声 — datalist 预设下拉(可选可自由输入), id 固定供 setAttribute 引用
            if (key === "配乐") {
                const dl = document.createElement("datalist");
                dl.id = "h3-music-presets";
                ["钢琴曲","弦乐","吉他","电子乐","轻快乐曲","舒缓乐曲","紧张鼓点","忧伤乐曲","宏大交响乐","悠扬笛声"].forEach((v) => {
                    const o = document.createElement("option"); o.value = v; dl.appendChild(o);
                });
                inp.setAttribute("list", "h3-music-presets");
                box.appendChild(dl);
            } else if (key === "氛围声") {
                const dl = document.createElement("datalist");
                dl.id = "h3-ambient-presets";
                ["雨声","风声","海浪声","鸟鸣","虫鸣","街道嘈杂","人群喧闹","雷声","流水声","篝火噼啪声"].forEach((v) => {
                    const o = document.createElement("option"); o.value = v; dl.appendChild(o);
                });
                inp.setAttribute("list", "h3-ambient-presets");
                box.appendChild(dl);
            }
        }
        cell.appendChild(lab);
        cell.appendChild(inp);
        shortRow.appendChild(cell);
        globalInputs.push(inp);
    });
    // R5: 三勾选作为一组 append 在 shortRow 尾部 (普通字段之后)
    NEGATIVE_TOGGLE_KEYS.forEach((key, idx) => {
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
        const lab = document.createElement("span");
        lab.textContent = key;  // label 逐字 = 键名 (关音乐 / 关对白 / 关水印字幕)
        lab.style.cssText = "flex:none;width:auto;white-space:nowrap;";
        const inp = document.createElement("input");
        inp.type = "checkbox";
        // 批 A 后小迭代 (R5): 默认不勾 — 与引擎 _parse_global 缺键=关语义对齐, 避免 round-trip 漂移
        inp.checked = false;
        inp.dataset.key = key;
        inp.dataset.toggleIdx = String(idx);
        // title 说明该勾选注入的负句 (供 hover 提示)
        if (key === "关音乐") inp.title = "勾选后: non_diegetic_music: N/A (六字段) / 末追 non_diegetic_music: N/A (平铺); 关音乐 + 全局配乐非空 → 黄条";
        else if (key === "关对白") inp.title = "勾选后: detailed_description 区末追加 \"人物全程不张嘴、不说话，无旁白。\" (六字段) / 末追 (平铺)";
        else if (key === "关水印字幕") inp.title = "勾选后: detailed_description 区末追加 \"无字幕，无文字水印。\" (六字段) / 末追 (平铺)";
        inp.style.cssText = "margin:0 6px 0 0;cursor:pointer;";
        inp.addEventListener("change", schedulePreviewAll);
        negativeSwitchEls[idx] = inp;  // collectData/fillForm/resetForm 单源读写
        wrap.appendChild(inp);
        wrap.appendChild(lab);
        shortRow.appendChild(wrap);
    });
    box.appendChild(shortRow);

    // V1.11 批 2 T3c: "跑完自动拼接" 复选 — 拼接模式下显示, 默认勾选. CSV 生成时该键
    // 值映射为 "自动"/"不拼" (与批 1 T6 csv_gen 白名单一致). 此处只挂 UI 与全局开关,
    // collectData() 走通用 input 路径时通过下方 autoConcatInput.dataset.h3AutoConcat 读.
    // 2026-09-03 fixround: 挂入 shortRow 网格并 grid-column:1/-1 跨三列 — 排版整齐
    const autoConcatWrap = document.createElement("label");
    autoConcatWrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:#bbb;font-size:12px;grid-column:1/-1;";
    autoConcatWrap.dataset.h3Role = "auto-concat-wrap";
    const autoConcatCb = document.createElement("input");
    autoConcatCb.type = "checkbox";
    autoConcatCb.checked = true;  // 默认勾选 — 与任务单"拼接模式默认勾"一致
    autoConcatCb.dataset.h3Role = "auto-concat-cb";
    autoConcatWrap.appendChild(autoConcatCb);
    const autoConcatLab = document.createElement("span");
    autoConcatLab.textContent = "跑完自动拼接";
    autoConcatWrap.appendChild(autoConcatLab);
    shortRow.appendChild(autoConcatWrap);
    // 模块级句柄 — collectData 读取状态写 "自动拼接" 键
    autoConcatInput = autoConcatCb;

    // 1.14b U3: 后处理三键 (放大复选 + 插帧复选 + 放大引擎选择) — 拼接模式有效 (X4)
    // 排版: shortRow 已含 autoConcatWrap, 在其后追加三个控件
    const postfxRow = document.createElement("div");
    postfxRow.style.cssText = "display:flex;align-items:center;gap:8px;grid-column:1/-1;flex-wrap:wrap;color:#bbb;font-size:12px;";
    // 放大复选
    const upscaleWrap = document.createElement("label");
    upscaleWrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
    const upscaleCb = document.createElement("input");
    upscaleCb.type = "checkbox";
    upscaleCb.dataset.h3Role = "postfx-upscale-cb";
    upscaleWrap.appendChild(upscaleCb);
    const upscaleLab = document.createElement("span");
    upscaleLab.textContent = "放大 (×2)";
    upscaleWrap.appendChild(upscaleLab);
    postfxRow.appendChild(upscaleWrap);
    // 插帧复选
    const interpWrap = document.createElement("label");
    interpWrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
    const interpCb = document.createElement("input");
    interpCb.type = "checkbox";
    interpCb.dataset.h3Role = "postfx-interp-cb";
    interpWrap.appendChild(interpCb);
    const interpLab = document.createElement("span");
    interpLab.textContent = "插帧 (×N fps)";
    interpWrap.appendChild(interpLab);
    postfxRow.appendChild(interpWrap);
    // 放大引擎选择
    const engineLab = document.createElement("span");
    engineLab.textContent = "放大引擎:";
    engineLab.style.cssText = "color:#888;";
    postfxRow.appendChild(engineLab);
    const engineSel = document.createElement("select");
    engineSel.style.cssText = "padding:1px 4px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:11px;";
    for (const [v, t] of [["seedvr2", "SeedVR2 (3B FP8)"], ["rtxvsr", "RTX VSR"]]) {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = t;
        engineSel.appendChild(opt);
    }
    engineSel.dataset.h3Role = "postfx-engine-sel";
    postfxRow.appendChild(engineSel);
    // X4 文案注明: 仅拼接模式生效
    const noteSpan = document.createElement("span");
    noteSpan.textContent = "(仅拼接模式生效)";
    noteSpan.style.cssText = "color:#666;font-size:11px;";
    postfxRow.appendChild(noteSpan);
    shortRow.appendChild(postfxRow);
    // 模块级句柄
    postfxUpscaleInput = upscaleCb;
    postfxInterpInput = interpCb;
    postfxEngineSelect = engineSel;

    // V1.11 批 3 T3: 预设 行 — 列表下拉 + 保存 / 加载 / 删除; 加载走 confirm 覆盖 + fillForm
    //   通道 (与 T2 导入配置共用 fillForm, 一条回填路径). 保存走 serializeFormConfig() 与
    //   generate_csv POST body.config 同源 (T2/T3 共用序列化函数).
    // 2026-09-03 fixround: 预设行跨三列 (grid-column:1/-1) — 视觉分组 + 网格基线对齐
    const presetRow = buildPresetRow();
    presetRow.style.gridColumn = "1/-1";
    shortRow.appendChild(presetRow);

    const promptLine = document.createElement("div");
    promptLine.style.cssText = "display:flex;align-items:flex-start;gap:6px;grid-column:1/-1;";
    const pLab = document.createElement("span");
    pLab.textContent = "提示词";
    pLab.style.cssText = "flex:none;white-space:nowrap;";  // R4: 同款去定宽改 nowrap
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.placeholder = "cinematic, photorealistic, 红衣少女...(会拼在每段提示词前面)";
    ta.style.cssText = "flex:1;padding:4px 6px;box-sizing:border-box;resize:vertical;font:inherit;min-height:60px;max-height:500px;";  // V1.4 T6c: 独立可拖拽调高, 上限放宽
    promptLine.appendChild(pLab);
    promptLine.appendChild(ta);
    shortRow.appendChild(promptLine);
    globalInputs.push(ta);
    globalPromptTa = ta;                          // 2.6: 给 fetchPreview 抓全局提示词
    ta.addEventListener("input", schedulePreviewAll);
    // T4: AI 协作区 — 导出到 AI / 从 AI 导入 + 应用 + 撤销
    box.appendChild(buildAiSection());
    return box;
}

// V1.11 批 3 T3: 预设 行 (下拉 + 保存 / 加载 / 删除). 加载走 fillForm 与 T2 导入配置同通道.
function buildPresetRow() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap;";
    wrap.dataset.h3Role = "preset-row";
    const lab = document.createElement("span");
    lab.textContent = "预设";
    lab.style.cssText = "flex:none;color:#bbb;font-size:12px;";
    wrap.appendChild(lab);
    const sel = document.createElement("select");
    sel.style.cssText = "padding:2px 6px;min-width:160px;";
    sel.dataset.h3Role = "preset-select";
    wrap.appendChild(sel);
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.textContent = "刷新";
    refreshBtn.style.cssText = "padding:2px 8px;cursor:pointer;";
    refreshBtn.dataset.h3Role = "preset-refresh";
    refreshBtn.onclick = () => _h3PresetsRefresh(sel);
    // V1.11 fix2: 预设名输入改为内嵌 input, 桌面版
    // popup 经常被遮挡/取消静默; 名字非规 (空/超长/含非法字符) 走前端预检 + toast warn 明示
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "预设名";
    nameInput.maxLength = 40;
    nameInput.style.cssText = "padding:2px 6px;width:120px;";
    nameInput.dataset.h3Role = "preset-name-input";
    wrap.appendChild(nameInput);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "保存";
    saveBtn.style.cssText = "padding:2px 8px;cursor:pointer;";
    saveBtn.dataset.h3Role = "preset-save";
    saveBtn.onclick = async () => {
        const name = (nameInput.value || "").trim();
        // 前端预校验: 名字仅支持中英数字/下划线/连字符, 1-40 字
        if (!name) {
            toast("warn", "H3 预设", "名字不能为空; 名字仅支持中英数字/下划线/连字符, 1-40 字");
            nameInput.focus();
            return;
        }
        if (name.length > 40) {
            toast("warn", "H3 预设", "名字仅支持中英数字/下划线/连字符, 1-40 字");
            nameInput.focus();
            return;
        }
        if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]+$/.test(name)) {
            toast("warn", "H3 预设", "名字仅支持中英数字/下划线/连字符, 1-40 字");
            nameInput.focus();
            return;
        }
        try {
            const r = await api.fetchApi("/h3_batch/presets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, config: serializeFormConfig() }),
            });
            const j = await r.json();
            if (j && j.ok) {
                toast("success", "H3 预设", "已保存: " + name);
                nameInput.value = "";
                _h3PresetsRefresh(sel);
            } else if (j && (j.error === "preset_name_invalid" || /preset_name/i.test(j.error || ""))) {
                toast("warn", "H3 预设", "名字仅支持中英数字/下划线/连字符, 1-40 字");
                nameInput.focus();
            } else {
                toast("error", "H3 预设", "保存失败: " + ((j && j.error) || "未知"));
            }
        } catch (e) {
            toast("error", "H3 预设", "网络错误: " + (e && e.message ? e.message : e));
        }
    };
    wrap.appendChild(saveBtn);
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.textContent = "加载";
    loadBtn.style.cssText = "padding:2px 8px;cursor:pointer;";
    loadBtn.dataset.h3Role = "preset-load";
    loadBtn.onclick = async () => {
        const name = sel.value;
        if (!name) { toast("warn", "H3 预设", "请先选一个预设"); return; }
        try {
            const r = await api.fetchApi("/h3_batch/presets?name=" + encodeURIComponent(name), { cache: "no-store" });
            const j = await r.json();
            if (!j || j.ok !== true || !j.config) {
                toast("error", "H3 预设", "加载失败: " + ((j && j.error) || "未知"));
                return;
            }
            if (!confirm("将覆盖当前表单内容，确定继续？")) return;
            try { fillForm(j.config); }
            catch (e) {
                toast("warn", "H3 预设", "表单部分回填失败: " + (e && e.message ? e.message : e));
                return;
            }
            toast("success", "H3 预设", "已加载: " + name);
        } catch (e) {
            toast("error", "H3 预设", "网络错误: " + (e && e.message ? e.message : e));
        }
    };
    wrap.appendChild(loadBtn);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "删除";
    delBtn.style.cssText = "padding:2px 8px;cursor:pointer;color:#f5534b;";
    delBtn.dataset.h3Role = "preset-delete";
    delBtn.onclick = async () => {
        const name = sel.value;
        if (!name) { toast("warn", "H3 预设", "请先选一个预设"); return; }
        if (!confirm("删除预设 " + name + " ?")) return;
        try {
            const r = await api.fetchApi("/h3_batch/presets?name=" + encodeURIComponent(name), { method: "DELETE" });
            const j = await r.json();
            if (j && j.ok) {
                toast("success", "H3 预设", "已删除: " + name);
                _h3PresetsRefresh(sel);
            } else {
                toast("error", "H3 预设", "删除失败: " + ((j && j.error) || "未知"));
            }
        } catch (e) {
            toast("error", "H3 预设", "网络错误: " + (e && e.message ? e.message : e));
        }
    };
    wrap.appendChild(delBtn);
    // 初次刷新 (best-effort; 失败不影响表单)
    _h3PresetsRefresh(sel);
    return wrap;
}

async function _h3PresetsRefresh(sel) {
    if (!sel) return;
    try {
        const r = await api.fetchApi("/h3_batch/presets", { cache: "no-store" });
        const j = await r.json();
        if (!j || j.ok !== true || !Array.isArray(j.presets)) return;
        sel.innerHTML = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "(无)";
        sel.appendChild(blank);
        for (const p of j.presets) {
            const opt = document.createElement("option");
            opt.value = p.name || "";
            opt.textContent = p.name + " · " + new Date((p.time || 0) * 1000).toLocaleString();
            sel.appendChild(opt);
        }
    } catch (_) {
        // 静默 — 表单打开期不打扰
    }
}

// T4: AI 协作区 — 全局参数 pane 内底部子盒; 队列清单模式随 pane 隐藏
function buildAiSection() {
    const box = document.createElement("div");
    box.style.cssText = "margin-top:14px;padding:8px;border:1px dashed #777;border-radius:6px;";
    const head = document.createElement("div");
    head.textContent = "AI 协作 (导出/导入, 含撤销)";
    head.style.cssText = "font-weight:bold;margin-bottom:6px;color:#cfd2da;";
    box.appendChild(head);

    // --- 导出 ---
    const expRow = document.createElement("div");
    expRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;";
    const expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.textContent = "导出到 AI";
    expBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
    expBtn.onclick = async () => {
        try {
            const snap = collectData();
            const resp = await api.fetchApi("/h3_batch/ai_export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snap),
            });
            const j = await resp.json();
            const text = JSON.stringify(j, null, 2);
            let copied = false;
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (e) { copied = false; }
            if (copied) {
                toast("success", "H3 AI 协作", "已复制到剪贴板, 粘贴给 AI 即可");
            } else {
                // 降级: 选中文本, 让用户 Ctrl+C
                expTa.value = text;
                expTa.style.display = "";
                expTa.focus();
                expTa.select();
                toast("warn", "H3 AI 协作", "剪贴板不可用, 请按 Ctrl+C 复制下方文本");
            }
        } catch (e) {
            toast("error", "H3 AI 协作", "导出失败: " + (e && e.message ? e.message : e));
        }
    };
    expRow.appendChild(expBtn);
    const expTa = document.createElement("textarea");
    expTa.rows = 4;
    expTa.placeholder = "(剪贴板降级时的备选复制区)";
    expTa.style.cssText = "display:none;flex:1;min-width:200px;font:inherit;padding:4px;";
    expRow.appendChild(expTa);
    box.appendChild(expRow);

    // --- 导入 ---
    const impArea = document.createElement("div");
    impArea.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const impTa = document.createElement("textarea");
    impTa.rows = 6;
    impTa.placeholder = "粘贴 AI 返回的文本 (含或不含 ```json 围栏均可)";
    impTa.style.cssText = "width:100%;font:inherit;padding:4px;box-sizing:border-box;";
    // T7 fix 3: 粘贴内容变化 → 旧校验结果已失效, 隐藏三个结果条 + applyBtn(回调异步触发, 闭包引用 const 在用户交互前已全部初始化)
    impTa.addEventListener("input", () => {
        impErrBox.style.display = "none";
        impWarnBox.style.display = "none";
        impOkBox.style.display = "none";
        applyBtn.style.display = "none";
    });
    impArea.appendChild(impTa);

    const impBtnRow = document.createElement("div");
    impBtnRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
    const impBtn = document.createElement("button");
    impBtn.type = "button";
    impBtn.textContent = "从 AI 导入";
    impBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
    impBtn.onclick = async () => {
        impErrBox.style.display = "none";
        impWarnBox.style.display = "none";
        impOkBox.style.display = "none";
        try {
            const resp = await api.fetchApi("/h3_batch/ai_import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: impTa.value }),
            });
            const j = await resp.json();
            if (!j.ok) {
                impErrBox.innerHTML = "";
                (j.errors || []).forEach((e) => {
                    const line = document.createElement("div");
                    line.style.cssText = "background:#5a1a1a;color:#ffb4b4;padding:3px 8px;border-radius:3px;font-size:12px;";
                    line.textContent = e;
                    impErrBox.appendChild(line);
                });
                impErrBox.style.display = "";
                return;
            }
            _aiImportLastData = j.data;
            if (j.warnings && j.warnings.length) {
                impWarnBox.innerHTML = "";
                j.warnings.forEach((w) => {
                    const line = document.createElement("div");
                    line.style.cssText = "background:#5a4a1a;color:#ffe6a8;padding:3px 8px;border-radius:3px;font-size:12px;";
                    line.textContent = w;
                    impWarnBox.appendChild(line);
                });
                impWarnBox.style.display = "";
            }
            impOkBox.textContent = "校验通过 (含 " + ((j.data && j.data.shots) ? j.data.shots.length : 0) + " 条分镜) — 点击「应用到表单」确认";
            impOkBox.style.display = "";
            applyBtn.style.display = "";
            undoBtn.style.display = "none";  // 还没应用, 撤销隐藏
        } catch (e) {
            impErrBox.innerHTML = "";
            const line = document.createElement("div");
            line.style.cssText = "background:#5a1a1a;color:#ffb4b4;padding:3px 8px;border-radius:3px;font-size:12px;";
            line.textContent = "请求失败: " + (e && e.message ? e.message : e);
            impErrBox.appendChild(line);
            impErrBox.style.display = "";
        }
    };
    impBtnRow.appendChild(impBtn);

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "应用到表单";
    applyBtn.style.cssText = "padding:4px 12px;cursor:pointer;display:none;";
    applyBtn.onclick = () => {
        if (!_aiImportLastData) return;
        // 4. 应用前快照 → 模块级内存, 会话级不落盘
        _aiPreSnapshot = collectData();
        fillForm(_aiImportLastData);
        // 4. 导入后刷新池缩略图/预览(fillForm 既有链路已含 _refreshThumb + schedulePreviewAll)
        applyBtn.style.display = "none";
        undoBtn.style.display = "";
        toast("success", "H3 AI 协作", "已应用 AI 返回的表单");
    };
    impBtnRow.appendChild(applyBtn);

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "撤销导入";
    undoBtn.style.cssText = "padding:4px 12px;cursor:pointer;display:none;";
    undoBtn.onclick = () => {
        if (!_aiPreSnapshot) return;
        fillForm(_aiPreSnapshot);
        _aiPreSnapshot = null;
        _aiImportLastData = null;
        undoBtn.style.display = "none";
        applyBtn.style.display = "none";
        toast("success", "H3 AI 协作", "已还原导入前状态");
    };
    impBtnRow.appendChild(undoBtn);

    impArea.appendChild(impBtnRow);

    const impErrBox = document.createElement("div");
    impErrBox.style.cssText = "display:none;flex-direction:column;gap:2px;";
    impArea.appendChild(impErrBox);
    const impWarnBox = document.createElement("div");
    impWarnBox.style.cssText = "display:none;flex-direction:column;gap:2px;";
    impArea.appendChild(impWarnBox);
    const impOkBox = document.createElement("div");
    impOkBox.style.cssText = "display:none;background:#1a4a1a;color:#b4ffb4;padding:4px 8px;border-radius:3px;font-size:12px;";
    impArea.appendChild(impOkBox);

    box.appendChild(impArea);
    return box;
}

// V1.4 T6b: 分镜列表区 — 复用 buildShotRow (V1.4 T6 已实现, 整体搬进 tab pane)
// V1.9 R-B1: section 标题旁加简洁/完整开关 — 状态写 localStorage, 触发 applyFormMode()
function buildShotSection() {
    const box = sectionBox("分镜行 (每镜一张卡片, 编辑后实时预览)");
    // V1.9 R-B1: 在标题 div 旁插入简洁/完整 radio (不改 sectionBox, 只调本区)
    const lab = box.firstChild;
    const titleText = lab.firstChild ? lab.firstChild.nodeValue : "";
    lab.textContent = "";
    lab.style.cssText = "font-weight:700;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = titleText;
    lab.appendChild(titleSpan);
    const modeGroup = document.createElement("label");
    modeGroup.style.cssText = "font-weight:400;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;";
    const radioS = document.createElement("input");
    radioS.type = "radio";
    radioS.name = "h3_form_mode";
    radioS.value = FORM_MODE_SIMPLE;
    const radioF = document.createElement("input");
    radioF.type = "radio";
    radioF.name = "h3_form_mode";
    radioF.value = FORM_MODE_FULL;
    if (getFormMode() === FORM_MODE_FULL) radioF.checked = true; else radioS.checked = true;
    radioS.onchange = () => { if (radioS.checked) { setFormMode(FORM_MODE_SIMPLE); applyFormMode(); } };
    radioF.onchange = () => { if (radioF.checked) { setFormMode(FORM_MODE_FULL); applyFormMode(); } };
    modeGroup.appendChild(radioS);
    modeGroup.appendChild(document.createTextNode("简洁"));
    modeGroup.appendChild(radioF);
    modeGroup.appendChild(document.createTextNode("完整"));
    lab.appendChild(modeGroup);
    // V1.10 批2 T4: 审片门 — 放行续跑按钮 (置于分镜列表 tab 顶部工具行, 沿 titleSpan 旁挂载);
    //   仅引擎处于审片门暂停时可用 — 默认隐藏, 轮询 status 响应 phase==="审片门暂停" 时显示.
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.textContent = "放行续跑";
    resumeBtn.title = "POST /h3_batch/review/resume — 引擎解除审片门暂停, 继续跑剩余段";
    resumeBtn.style.cssText = "flex:none;padding:4px 12px;cursor:pointer;font-size:12px;display:none;background:#1a4a1a;color:#b4ffb4;border:1px solid #60c878;";
    resumeBtn.onclick = () => _reviewResumeBatch();
    lab.appendChild(resumeBtn);
    _reviewResumeBtn = resumeBtn;
    // V1.10 批3 T3: 拼接模式 ≥5 段色彩对齐 flatten 提示条 — 单例创建, 挂分镜列表 tab 内 rowsEl 上方
    ensureFlattenHint(box);
    const rowsEl = document.createElement("div");
    box.appendChild(rowsEl);
    shotRowsEl = rowsEl;
    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ 加分镜行";
    addBtn.style.cssText = "margin-top:8px;padding:4px 12px;cursor:pointer;";
    addBtn.onclick = () => {
        // V1.6: 新行 append 后, 若上一行 ID/导出文件名有值且可递增 → 预填两字段
        const newCard = buildShotRow();
        rowsEl.appendChild(newCard);
        const prev = shotRows[shotRows.length - 2];
        const newCtrls = shotRows[shotRows.length - 1];
        if (prev && newCtrls) {
            for (const key of ["ID", "导出文件名"]) {
                const inc = cascadeIncrements([(prev[key] && prev[key].value || "").trim(), ""])[1];
                if (inc) newCtrls[key].value = inc;
            }
        }
        schedulePreviewAll();
        // V1.10 批3 T3: 行数 +1 → 刷新 flatten 提示条显隐 (拼接 ≥5 才显)
        _updateFlattenHint();
    };
    box.appendChild(addBtn);
    return box;
}

// V1.11 批 2 T1: 比例换算纯函数 (w, h) → "1:1"/"16:9"/.../或"a:b"/或"w:h".
//   规则 (主代理裁决口径 2026-09-02):
//     1) gcd(w,h) → (a,b)
//     2) a:b 精确匹配常见表 (1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3) → 表名
//     3) 否则若 a ≤ 21 且 b ≤ 21 (小整数比阈值) → "a:b"
//     4) 否则 → "${w}:${h}" 原值 (实测为准, 不近似 snap, 避免 832x480 误显 "16:9")
//   函数自包含 (常量内嵌) — 让 node 沙箱抽取后能独立对拍 (无外部依赖).
function h3AspectRatio(w, h) {
    const RATIO = { "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4", "3:2": "3:2", "2:3": "2:3" };
    if (!w || !h) return "--";
    const a = Math.round(Number(w)), b = Math.round(Number(h));
    if (!a || !b) return "--";
    const gcd = (x, y) => { while (y) { [x, y] = [y, x % y]; } return Math.abs(x); };
    const g = gcd(a, b);
    const ra = a / g, rb = b / g;
    const key = ra + ":" + rb;
    if (RATIO[key]) return RATIO[key];
    if (ra <= 21 && rb <= 21) return key;
    return a + ":" + b;
}

// V1.11 批 2 T3b: 版本计数纯函数 h3VersionCount(_reruns, sid) → sid 在 _reruns 中出现的次数 (整型).
//   _reruns 形态: [{seq, time, sids: [...], files, seeds, reason}, ...] (manifest 既有).
//   抽纯函数让 jsdom 沙箱独立对拍 (无 DOM 依赖).
function h3VersionCount(reruns, sid) {
    if (!Array.isArray(reruns)) return 0;
    let n = 0;
    for (const r of reruns) {
        if (r && Array.isArray(r.sids) && r.sids.indexOf(sid) >= 0) n++;
    }
    return n;
}

// 交付前审查 FE-P1-1: 读表单级 server_output_dir 的统一 helper. 取代原代码里 7 处裸
//   `typeof widgets !== "undefined" && widgets && widgets.get(...)` (模块作用域无 widgets,
//   实际恒 false → outDir 恒空 → 所有 detail/config/restore/trash 请求丢 output_dir 参数).
//   改读 current.widgets.get("server_output_dir") (与 3390 行 _reviewApproveRow 同款形态).
function _h3FormOutputDir() {
    try {
        return ((current && current.widgets && typeof current.widgets.get === "function")
            ? (current.widgets.get("server_output_dir") || "") : "");
    } catch (_) { return ""; }
}

// V1.11 批 2 T3: 默认重跑勾选纯函数 h3DefaultRerunSelection(shots) → 默认勾选段 sid 列表.
//   规则 (与批 1 history 列表 pending 计数口径一致):
//     - status === 'failed' → 勾选
//     - status === 'stopped' → 勾选
//     - status === 'success' && review === 'void' (作废) → 勾选
//     - 其他 (success 无 review / pending) → 不勾选
//   shots 形态: [{sid, status, review}, ...] (允许 sid 缺省时回落到对象 id).
function h3DefaultRerunSelection(shots) {
    const out = [];
    if (!Array.isArray(shots)) return out;
    for (const s of shots) {
        if (!s || typeof s !== "object") continue;
        const sid = s.sid || s.id || "";
        const status = s.status || "";
        const review = s.review || "";
        const isFailed = (status === "failed" || status === "stopped");
        const isVoid = (status === "success" && review === "void");
        if (isFailed || isVoid) {
            if (sid) out.push(sid);
        }
    }
    return out;
}

// V1.11 批 2 T3b: 版本列表数据构造纯函数 h3VersionList(reruns, sid, currentInfo)
//   → 现行版本排第一 + 按 seq 倒序各次重跑.
//   currentInfo = {run_dir, file, seed} | null. reruns 中不含 sid 的条目过滤掉.
//   输出 entries: [{type:'current'|'rerun', seq, time, seed, file, run_dir}, ...].
//   抽纯函数让 jsdom 沙箱独立对拍, render 函数 (_h3RenderVersionList) 仅消费 entries.
function h3VersionList(reruns, sid, currentInfo) {
    const out = [];
    if (currentInfo && typeof currentInfo === "object") {
        out.push({
            type: "current",
            seq: 0,
            time: null,
            seed: currentInfo.seed,
            file: currentInfo.file,
            run_dir: currentInfo.run_dir,
        });
    }
    if (Array.isArray(reruns)) {
        const filtered = [];
        for (const r of reruns) {
            if (!r || typeof r !== "object") continue;
            if (!Array.isArray(r.sids) || r.sids.indexOf(sid) < 0) continue;
            const files = (r && typeof r.files === "object" && r.files) || {};
            const seeds = (r && typeof r.seeds === "object" && r.seeds) || {};
            filtered.push({
                type: "rerun",
                seq: r.seq,
                time: r.time,
                seed: seeds[sid],
                file: files[sid],
                run_dir: r.run_dir || null,  // V1.13k T2: 入账时落 run_dir (绝对路径), 存量旧条目无该键兜底 null
                // V1.11 批 3 T1 P1-6: 透传 params/res_changed/prompt_edited 给前端 —
                // 弹窗默认值优先取 entry.params (重跑记录行同seed重跑入口).
                params: r.params || null,
                res_changed: !!r.res_changed,
                prompt_edited: !!r.prompt_edited,
            });
        }
        filtered.sort((a, b) => (b.seq || 0) - (a.seq || 0));
        for (const e of filtered) out.push(e);
    }
    return out;
}

// V1.11 批 2 T3: 重跑确认弹窗流程函数 (自绘浮层, _h3ShowVoidChoiceDialog 同款风格).
//   参数: {sids, keepSeed} → 弹窗展示勾选清单 + "保留原种子"复选 + 确认/取消按钮.
//   回调 close → confirm(sids, keepSeed). 由 _h3HistoryRenderDetail 展开区按钮触发.
function _h3ShowRerunConfirmDialog(taskId, sids, onConfirm) {
    const dlg = ensureVoidChoiceDialog();
    dlg._currentCtrls = null;
    dlg._currentStem = taskId;
    dlg._currentOutDir = null;
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "确认重跑 " + sids.length + " 段";
    dlg._descEl.innerHTML = "<div>勾选段: " + sids.join(", ") + "</div>" +
        "<div>默认换新种子；老片改名保留；全部完成后统一重拼。</div>";
    // 保留原种子复选
    const keepRow = document.createElement("label");
    keepRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:#bbb;margin-bottom:8px;";
    const keepCb = document.createElement("input");
    keepCb.type = "checkbox";
    keepCb.id = "h3_rerun_keep_seed";
    const keepSpan = document.createElement("span");
    keepSpan.textContent = "保留原种子";
    keepRow.appendChild(keepCb);
    keepRow.appendChild(keepSpan);
    dlg._descEl.appendChild(keepRow);
    // 确认按钮
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "确认重跑";
    okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;";
    okBtn.onclick = () => { _closeVoidChoiceDialog(); if (onConfirm) onConfirm(sids, keepCb.checked); };
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(okBtn);
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";
}

// V1.11 批 2 T3c: 拼接 dry_run 预览弹窗流程函数.
//   onConfirm(mode) → 弹窗让用户选 global/inherit, POST concat dry_run 拿组合预览,
//   弹窗内展示逐段文件 + base_desc 基准 + missing/fallback_sids, 确认按钮 → 触发执行 onExecute.
function _h3ShowConcatPreviewDialog(taskId, onConfirm, rerunSeq) {
    // rerunSeq: 可选; 非空 → 弹窗内拼接到该次重跑组合 (后端 concat 已支持 rerun_seq)
    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "拼接任务 " + taskId + (rerunSeq ? " (重跑#" + rerunSeq + ")" : "");
    dlg._descEl.innerHTML = "<div>选择拼接组合:</div>";
    const mkBtn = (text, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
        b.onclick = () => { _closeVoidChoiceDialog(); if (onClick) onClick(); };
        dlg._btnsEl.appendChild(b);
    };
    mkBtn("拼接到全局 (global)", () => onConfirm && onConfirm("global"));
    mkBtn("继承上次组合 (inherit)", () => onConfirm && onConfirm("inherit"));
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";
}

// V1.11 批 3 T1: 同 seed 重跑弹窗 — 比例/质量/步数 三个覆写 + 种子只读列表 + 防白跑提示.
//   source="task" → 默认值: localStorage "h3_same_seed_params" > 全局当前值;
//   source="rerun" → 额外优先 _reruns[seq-1].params (该次实际生效参数).
//   onConfirm(formBody, force) → POST /h3_batch/rerun_same_seed; force=true 跳 confirm_required.
//   弹窗底部说明"参数仅作用于本次重跑的段, 不改全局参数".
// ASPECT_OPTIONS 与 batch_core.ASPECT_OPTIONS 同源 (前端硬编码, 见 h3AspOpts).
function _h3ShowSameSeedDialog(taskId, source, rerunSeq, onDone) {
    // 拉全局参数当前值 (作为默认值兜底)
    // V1.13 波 3 T12 (D11): 改直读模块状态 globalInputs + GLOBAL_INPUT_KEYS 下标契约 —
    // 旧实现走三级 DOM 查找 (data-h3-shot-card / input[data-key] / form 内 label 匹配),
    // 三者皆无设置 ⇒ 弹窗默认值恒空退化 localStorage. 直读 globalInputs[i].value 即对齐
    // buildGlobalSection 装配的真实控件, 与 collectData (4141) 写出路径同一坐标系.
    let globalRatio = "", globalQuality = "", globalSteps = "";
    try {
        const _keys = (typeof GLOBAL_INPUT_KEYS !== "undefined"
                       && GLOBAL_INPUT_KEYS)
                      ? GLOBAL_INPUT_KEYS : [];
        const _ins = (typeof globalInputs !== "undefined" && globalInputs)
                     ? globalInputs : [];
        for (let i = 0; i < _keys.length; i++) {
            const k = _keys[i];
            const ctrl = _ins[i];
            const v = ctrl && ctrl.value ? String(ctrl.value).trim() : "";
            if (k === "比例") globalRatio = v;
            else if (k === "质量") globalQuality = v;
            else if (k === "步数") globalSteps = v;
        }
    } catch (_) {}
    // localStorage 记忆上次填写
    let mem = { 比例: "", 质量: "", 步数: "" };
    try {
        const s = localStorage.getItem("h3_same_seed_params");
        if (s) { const j = JSON.parse(s); if (j && typeof j === "object") mem = j; }
    } catch (_) {}
    // P1-6: source=rerun 入口优先取 _reruns[seq].params (该次实际生效参数,
    // 清单 A-3). 弹窗打开时由调用方塞进 window._h3LastSameSeedParams (在
    // 重跑记录行按钮 onClick 内 fetchApi 拉到 _reruns[seq] 后传入).
    let _rerunEntryParams = null;
    if (source === "rerun" && rerunSeq != null) {
        try {
            const _p = window._h3LastSameSeedParams;
            if (_p && _p.seq === rerunSeq && _p.params) _rerunEntryParams = _p.params;
        } catch (_) {}
    }
    const ratio = (_rerunEntryParams && _rerunEntryParams.比例)
        || (mem.比例 || globalRatio || "");
    const quality = (_rerunEntryParams && _rerunEntryParams.质量)
        || (mem.质量 || globalQuality || "");
    const steps = (_rerunEntryParams && _rerunEntryParams.步数)
        || (mem.步数 || globalSteps || "");

    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "同seed重跑 " + taskId
        + (source === "rerun" && rerunSeq ? " (基于重跑#" + rerunSeq + ")" : "");
    const desc = document.createElement("div");
    desc.style.cssText = "color:#bbb;font-size:12px;line-height:1.6;";
    desc.innerHTML = "<div>种子继承: 任务记录行从 manifest 各段现行 seed 取; 重跑记录行从该次 seeds 取.</div>"
        + "<div style='margin-top:6px;color:#888;font-size:11px;'>参数仅作用于本次重跑的段, 不改全局参数.</div>";
    // 比例下拉
    const h3AspOpts = ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)",
                       "3:4 (Portrait Standard)", "4:3 (Standard)",
                       "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"];
    const mkRow = (labelText, ctrl, hint) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;";
        const lab = document.createElement("span");
        lab.style.cssText = "flex:none;color:#aaa;font-size:12px;width:60px;";
        lab.textContent = labelText;
        row.appendChild(lab);
        row.appendChild(ctrl);
        if (hint) {
            const h = document.createElement("span");
            h.style.cssText = "color:#666;font-size:10px;";
            h.textContent = hint;
            row.appendChild(h);
        }
        return row;
    };
    const ratioSel = document.createElement("select");
    ratioSel.style.cssText = "padding:2px 6px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:12px;";
    const _blankOpt = document.createElement("option");
    _blankOpt.value = ""; _blankOpt.textContent = "(不覆写)";
    ratioSel.appendChild(_blankOpt);
    for (const v of h3AspOpts) {
        const o = document.createElement("option"); o.value = v; o.textContent = v;
        ratioSel.appendChild(o);
    }
    ratioSel.value = ratio;
    desc.appendChild(mkRow("比例", ratioSel));

    const qualInp = document.createElement("input");
    qualInp.type = "text"; qualInp.placeholder = "如 0.4";
    qualInp.style.cssText = "width:90px;padding:2px 6px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:12px;";
    qualInp.value = quality;
    desc.appendChild(mkRow("质量", qualInp, "空=不覆写"));

    const stepsInp = document.createElement("input");
    stepsInp.type = "text"; stepsInp.placeholder = "8V8A";
    stepsInp.style.cssText = "width:90px;padding:2px 6px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:12px;";
    stepsInp.value = steps;
    desc.appendChild(mkRow("步数", stepsInp, "NVNA 大写; A≥V"));

    // 种子列表只读 (滚动上限 10+展开) — 详情可拉 (task_id + output_dir)
    const seedsBox = document.createElement("div");
    seedsBox.style.cssText = "margin-top:8px;padding:6px;background:#0e0e10;border:1px solid #333;border-radius:3px;font-size:11px;color:#aaa;max-height:80px;overflow-y:auto;";
    seedsBox.textContent = "(种子列表: 加载中...)";
    desc.appendChild(seedsBox);
    (async () => {
        try {
            const outDir = _h3FormOutputDir();
            const url = "/h3_batch/history/detail?task_id=" + encodeURIComponent(taskId)
                + (outDir ? "&output_dir=" + encodeURIComponent(outDir) : "");
            const resp = await api.fetchApi(url, { cache: "no-store" });
            const data = await resp.json();
            if (!data || data.ok !== true) {
                seedsBox.textContent = "(种子列表: 拉取失败)";
                return;
            }
            const lines = [];
            const shots = data.shots || {};
            const sids = Object.keys(shots).filter(k => !k.startsWith("_"));
            if (source === "rerun" && rerunSeq) {
                const entry = ((data._reruns || []).find(r => r && r.seq === rerunSeq)) || {};
                const seedsMap = entry.seeds || {};
                const sidsRun = entry.sids || sids;
                for (const sid of sidsRun) {
                    const s = seedsMap[sid];
                    lines.push(sid + ": seed " + (s == null ? "(随机)" : s));
                }
            } else {
                for (const sid of sids) {
                    const info = shots[sid] || {};
                    const s = info.seed;
                    lines.push(sid + ": seed " + (s == null ? "(随机)" : s));
                }
            }
            seedsBox.textContent = lines.length ? lines.join("\n") : "(无种子记录)";
        } catch (e) {
            seedsBox.textContent = "(种子列表: 拉取异常)";
        }
    })();

    dlg._descEl.innerHTML = "";
    dlg._descEl.appendChild(desc);

    // 记忆: 写入 localStorage (下次默认值)
    const _persist = () => {
        try {
            localStorage.setItem("h3_same_seed_params", JSON.stringify({
                比例: ratioSel.value, 质量: qualInp.value.trim(), 步数: stepsInp.value.trim(),
            }));
        } catch (_) {}
    };

    const doPost = async (force) => {
        const body = {
            task_id: taskId,
            source: source,
            比例: ratioSel.value,
            质量: qualInp.value.trim(),
            步数: stepsInp.value.trim(),
        };
        if (source === "rerun") body.rerun_seq = rerunSeq;
        if (force) body.force = true;
        _persist();
        _closeVoidChoiceDialog();
        try {
            const r = await api.fetchApi("/h3_batch/rerun_same_seed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const j = await r.json();
            if (!j || j.ok !== true) {
                toast("error", "H3 同seed重跑", "失败: " + (j && j.error || "未知"));
                return;
            }
            if (j.confirm_required) {
                // 防白跑二次确认
                _h3ShowSameSeedConfirmDialog(j, body, onDone);
                return;
            }
            // P1-6: res_changed 同步预检 → toast 提示用户降级行为 (端点响应)
            if (j.res_changed && j.res_changed_sids && j.res_changed_sids.length) {
                toast("warn", "H3 同seed重跑",
                      "分辨率已变更 (" + j.res_changed_sids.join(",")
                      + "), 总片未重拼, 需全段同分辨率后手动拼");
            }
            toast("info", "H3 同seed重跑", "提交 " + (j.sids || []).length + " 段, 轮询中...");
            _h3PollStatus(taskId, "同seed重跑", (j.sids || []).length, onDone);
        } catch (e) {
            toast("error", "H3 同seed重跑", "网络错误: " + (e && e.message ? e.message : e));
        }
    };

    const okBtn = document.createElement("button");
    okBtn.type = "button"; okBtn.textContent = "确认重跑";
    okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;";
    okBtn.onclick = () => doPost(false);
    dlg._btnsEl.appendChild(okBtn);
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";
}

// V1.11 批 3 T1: 防白跑二次确认弹窗 (confirm_required=true) — 强制执行复选 + 取消.
function _h3ShowSameSeedConfirmDialog(prevResp, body, onDone) {
    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "参数与该任务历史完全相同";
    dlg._descEl.innerHTML = "<div>确认仍要执行?</div>";
    const forceCb = document.createElement("label");
    forceCb.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:#bbb;margin-bottom:8px;";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "h3_force_same_seed";
    const cs = document.createElement("span"); cs.textContent = "强制执行 (force=true)";
    forceCb.appendChild(cb); forceCb.appendChild(cs);
    dlg._descEl.appendChild(forceCb);
    const okBtn = document.createElement("button");
    okBtn.type = "button"; okBtn.textContent = "确认";
    okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#8a5a3a;color:#e6e6e6;border:1px solid #aa7a5a;border-radius:4px;";
    okBtn.onclick = async () => {
        _closeVoidChoiceDialog();
        const body2 = Object.assign({}, body, { force: cb.checked });
        try {
            const r = await api.fetchApi("/h3_batch/rerun_same_seed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body2),
            });
            const j = await r.json();
            if (!j || j.ok !== true) {
                toast("error", "H3 同seed重跑", "失败: " + (j && j.error || "未知"));
                return;
            }
            toast("info", "H3 同seed重跑", "提交 " + (j.sids || []).length + " 段, 轮询中...");
            _h3PollStatus(body.task_id, "同seed重跑", (j.sids || []).length, onDone);
        } catch (e) {
            toast("error", "H3 同seed重跑", "网络错误: " + (e && e.message ? e.message : e));
        }
    };
    dlg._btnsEl.appendChild(okBtn);
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";
}

// V1.11 批 3 T1: 改词重跑弹窗 — 全宽编辑 + 只读信息行 + 大 textarea 预填提示词 +
//   保留原种子复选 (默认不勾 = 换新种子) + 确认重跑.
// #78 B 路径: 预填侧车裸段词优先 (shots[sid].prompt_text), 无侧车回 final_prompt —
//   二次改词不再以装配全文为 payload (防嵌套膨胀).
// onConfirm(text, keepSeed) → POST /h3_batch/rerun_edit_prompt.
// 交付前审查 FE-P0-2: 整体 async, fetch full_prompt 迟到 → 单例 dlg 可能已被取消/复用.
// 修法: 闭包 cancelled 标志 + dlg 身份检查 (title 仍是本弹窗的) → 否则丢弃 okBtn 插入与状态变更.
function _h3ShowPromptEditDialog(taskId, sid, info, onDone) {
    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    const myTitle = "改词重跑 " + taskId + " / " + sid;
    dlg._titleEl.textContent = myTitle;
    dlg._descEl.style.cssText = "color:#bbb;font-size:12px;line-height:1.6;";
    let cancelled = false;
    // 只读信息行
    const ratio = (info && info.width && info.height)
        ? (Math.abs(info.width / info.height - 16 / 9) < 0.05 ? "16:9"
           : Math.abs(info.width / info.height - 9 / 16) < 0.05 ? "9:16" : "其他")
        : "--";
    const infoLine = document.createElement("div");
    infoLine.style.cssText = "font-size:11px;color:#888;margin-bottom:6px;";
    infoLine.textContent = "段名: " + sid
        + "  ·  seed: " + (info.seed != null ? info.seed : "(随机)")
        + "  ·  分辨率: " + (info.width && info.height ? info.width + "x" + info.height + " (" + ratio + ")" : "--");
    dlg._descEl.innerHTML = "";
    dlg._descEl.appendChild(infoLine);
    // 加载态
    const loading = document.createElement("div");
    loading.style.cssText = "color:#888;font-size:11px;margin-bottom:6px;";
    loading.textContent = "加载提示词...";
    dlg._descEl.appendChild(loading);
    const ta = document.createElement("textarea");
    ta.rows = 14;
    ta.style.cssText = "width:96%;padding:6px;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:12px;font-family:monospace;";
    ta.value = "";
    ta.disabled = true;
    dlg._descEl.appendChild(ta);
    // 保留原种子复选 (默认不勾)
    const keepRow = document.createElement("label");
    keepRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:#bbb;margin-top:8px;";
    const keepCb = document.createElement("input");
    keepCb.type = "checkbox"; keepCb.id = "h3_rerun_edit_keep_seed";
    const keepSpan = document.createElement("span");
    keepSpan.textContent = "保留原种子 (默认换新种子)";
    keepRow.appendChild(keepCb); keepRow.appendChild(keepSpan);
    dlg._descEl.appendChild(keepRow);

    // 确认/取消按钮先挂上 (loading 中可取消)
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => { cancelled = true; _closeVoidChoiceDialog(); };
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";

    // 拉 full_prompt=true 全文 (FE-P0-2: 闭包内查 cancelled + 弹窗身份; 不满足则丢弃)
    (async () => {
        try {
            const outDir = _h3FormOutputDir();
            const url = "/h3_batch/history/detail?task_id=" + encodeURIComponent(taskId)
                + (outDir ? "&output_dir=" + encodeURIComponent(outDir) : "")
                + "&full_prompt=true";
            const resp = await api.fetchApi(url, { cache: "no-store" });
            const data = await resp.json();
            // 迟到返回: 已取消 或 单例 dlg 已被其他弹窗接管 → 丢弃 okBtn 插入 + 不改 textarea
            if (cancelled || dlg._titleEl.textContent !== myTitle) return;
            if (data && data.ok === true) {
                // #78 B 路径: 侧车裸段词优先; 无侧车回装配全文
                const segInfo = (data.shots && data.shots[sid]) || {};
                const fp = segInfo.prompt_text || segInfo.final_prompt || "";
                ta.value = fp;
                ta.disabled = false;
                loading.textContent = "已加载全文 (" + fp.length + " 字符). 修改后点确认.";
            } else {
                loading.textContent = "拉取失败: " + (data && data.error || "未知");
            }
        } catch (e) {
            if (cancelled || dlg._titleEl.textContent !== myTitle) return;
            loading.textContent = "拉取异常: " + (e && e.message ? e.message : e);
        }
        // 再次检查 — 异步 try/catch 边界之后仍可能被切走
        if (cancelled || dlg._titleEl.textContent !== myTitle) return;
        const okBtn = document.createElement("button");
        okBtn.type = "button"; okBtn.textContent = "确认重跑";
        okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;";
        okBtn.onclick = async () => {
            const text = ta.value;
            if (!text.trim()) {
                toast("error", "H3 改词重跑", "提示词不能为空");
                return;
            }
            _closeVoidChoiceDialog();
            try {
                const r = await api.fetchApi("/h3_batch/rerun_edit_prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        task_id: taskId, sid: sid,
                        prompt_text: text, keep_seed: keepCb.checked,
                    }),
                });
                const j = await r.json();
                if (!j || j.ok !== true) {
                    toast("error", "H3 改词重跑", "失败: " + (j && j.error || "未知"));
                    return;
                }
                toast("info", "H3 改词重跑", "提交 " + sid + ", 轮询中...");
                _h3PollStatus(taskId, "改词重跑", 1, onDone);
            } catch (e) {
                toast("error", "H3 改词重跑", "网络错误: " + (e && e.message ? e.message : e));
            }
        };
        dlg._btnsEl.insertBefore(okBtn, dlg._btnsEl.firstChild);
    })();
}

// V1.11 批 3 T1: 轮询 status 工具 (复用 _h3_history poll 逻辑). onDone 完成后调用.
// 2026-09-03 fixround: 改词重跑轮询句柄改挂 _h3PollStatusTimer 模块级 — closeForm 一并清理 (deadef5 放大 13 倍后句柄曾泄漏)
// 交付前审查 FE-P0-3: 加 _h3PollToken 代际令牌 — 每次新轮询自增, tick 闭包捕获本代 token,
//   续期前若 token 不再是最新的则直接 return (孤儿 tick 自动失效). closeForm 自增 token + clearTimeout 兜底.
function _h3PollStatus(taskId, label, count, onDone) {
    const outDir = _h3FormOutputDir();
    const pollUrl = "/h3_batch/status?output_dir=" + encodeURIComponent(outDir)
        + "&stem=" + encodeURIComponent(taskId);
    const myToken = ++_h3PollToken;
    let elapsed = 0;
    const tick = async () => {
        // 代际令牌: 已被新轮询或 closeForm 替换 → 立即终止, 不再续期
        if (myToken !== _h3PollToken) { _h3PollStatusTimer = null; return; }
        if (elapsed > 1200) { toast("info", "H3 " + label, "重跑仍在进行, 可在历史任务中查看进度"); _h3PollStatusTimer = null; return; }
        try {
            const resp = await api.fetchApi(pollUrl, { cache: "no-store" });
            const sd = await resp.json();
            if (myToken !== _h3PollToken) { _h3PollStatusTimer = null; return; }
            // 1.11a 波 3 T2: 三态 unknown — 不触发完成分支, 继续轮询
            if (sd && sd.running === "unknown") {
                // 不提示, 不触发 onDone, 继续 tick (manifest 损坏恢复后再判定)
            } else if (sd && sd.running === false) {
                toast("success", "H3 " + label, "已完成 " + count + " 段");
                if (typeof onDone === "function") onDone();
                _h3PollStatusTimer = null;
                return;
            }
        } catch (_) {}
        if (myToken !== _h3PollToken) { _h3PollStatusTimer = null; return; }
        elapsed += (elapsed < 300 ? 2 : 10);
        _h3PollStatusTimer = setTimeout(tick, elapsed < 300 ? 2000 : 10000);
    };
    _h3PollStatusTimer = setTimeout(tick, 1000);
}

// V1.11 批 2 T3c: 彻底删除二次确认弹窗 (含"永久删除不可找回，仅视频文件保留"提示).
//   onConfirm() → 触发 purge DELETE. 与 ensureVoidChoiceDialog 同款浮层.
function _h3ShowTrashPurgeDialog(taskId, onConfirm) {
    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "彻底删除 " + taskId;
    dlg._descEl.innerHTML =
        "<div>永久删除不可找回，仅视频文件保留。</div>" +
        "<div>该操作无法撤销，确认继续?</div>";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "确认彻底删除";
    okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#8a3a3a;color:#e6e6e6;border:1px solid #aa5a5a;border-radius:4px;";
    okBtn.onclick = () => { _closeVoidChoiceDialog(); if (onConfirm) onConfirm(); };
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(okBtn);
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "";
}

// V1.11 批 2 T3c: 删除确认 (软删) — 直接用 confirm() 弹窗 (既有两按钮/三按钮弹窗之外的轻量场景).
//   任务单: "移入回收站，可恢复；视频文件不动".
//   注: 用全局 confirm() 而非 window.confirm, 让单测源码断言能直接匹配 (window. 前缀会漏).
function _h3ConfirmDelete(taskId) {
    if (typeof confirm === "function") {
        return confirm("确认将 " + taskId + " 移入回收站？可恢复；视频文件不动。");
    }
    return true;
}


// V1.11 批 2 T1: 多数派判定纯函数 — 输入 [{width,height}, ...] 返回 {majority, inconsistent}.
//   majority = {w, h} | null; inconsistent = [idx, ...] 与多数派不同的段索引.
//   缺尺寸段不参与多数派矛盾判定 (信息不足不误伤, 后端 concat 再校验兜底).
//   数据缺失/全空 → majority=null; 仅 1 段有数据 → 该尺寸即为 majority, inconsistent=[].
//   抽纯函数为 T3c 拼接按钮逻辑复用 (节点 B/任务决策 = 与多数派不同则禁拼接).
function h3ResolutionMajority(shots) {
    const buckets = new Map();   // "w,h" → count
    const seen = [];             // [{idx, key}] 与 shots 等长
    shots.forEach((s, i) => {
        const w = s && s.width, h = s && s.height;
        if (w && h) {
            const key = w + "," + h;
            seen.push({ idx: i, key });
            buckets.set(key, (buckets.get(key) || 0) + 1);
        } else {
            seen.push({ idx: i, key: null });
        }
    });
    if (buckets.size === 0) return { majority: null, inconsistent: [] };
    // 多数派 = 出现次数最多的 key; 并列时取 seen 中首次出现者
    let bestKey = null, bestN = 0;
    for (const [k, n] of buckets) {
        if (n > bestN || (n === bestN && bestKey === null)) { bestKey = k; bestN = n; }
    }
    if (!bestKey) return { majority: null, inconsistent: [] };
    // 1 段也视为自身一致 (T3c 拼接按钮逻辑放行); 仅当 ≥2 段时不一致才算.
    const [mw, mh] = bestKey.split(",").map(Number);
    const inconsistent = [];
    for (const { idx, key } of seen) {
        if (key !== null && key !== bestKey) inconsistent.push(idx);
    }
    return { majority: { w: mw, h: mh }, inconsistent };
}

// V1.11 批 2 T1: 历史任务 tab pane — 折叠任务列表 + 点击展开段网格 (缩略图墙).
//   数据契约: GET /h3_batch/history?limit=&offset=; 点击行 → GET /h3_batch/history/detail?task_id=.
//   段卡: 缩略图 (lazy) + 左上角色点 (绿/红/灰/黄) + 段名 + seed 短显 + 下方分辨率行.
//   拼接按钮: 多数派不一致 → disabled; 否则 enabled (点击 no-op, T3c 接执行).
//   刷新: 手动按钮 + 首次进 tab 懒加载 (无自动轮询; rerun 提交后由 T3 挂自动刷新钩子).
function buildHistorySection() {
    const box = sectionBox("历史任务 (时间倒序; 点击行展开段缩略图墙)");

    // 顶部操作行: 手动刷新按钮 + 共 N 个任务 计数
    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:10px;";
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "🔄 手动刷新";
    refreshBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
    refreshBtn.dataset.h3Role = "history-refresh";
    refreshBtn.onclick = () => _h3HistoryLoad(true);
    topRow.appendChild(refreshBtn);
    const countLab = document.createElement("span");
    countLab.style.cssText = "color:#aaa;font-size:12px;";
    countLab.textContent = "共 0 个任务";
    countLab.dataset.h3Role = "history-count";
    topRow.appendChild(countLab);
    box.appendChild(topRow);

    // 任务列表容器 (滚动)
    const listEl = document.createElement("div");
    listEl.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    listEl.dataset.h3Role = "history-list";
    box.appendChild(listEl);

    // 加载更多按钮 (还有剩余时显示, 点击 GET offset=当前数追加)
    const moreBtn = document.createElement("button");
    moreBtn.textContent = "加载更多";
    moreBtn.style.cssText = "margin-top:8px;padding:4px 12px;cursor:pointer;display:none;";
    moreBtn.dataset.h3Role = "history-more";
    moreBtn.onclick = () => _h3HistoryLoadMore();
    box.appendChild(moreBtn);

    // V1.11 批 2 T3c: 回收站入口 — 折叠区, 点开懒加载 GET /h3_batch/history/trash
    const trashToggle = document.createElement("button");
    trashToggle.textContent = "回收站";
    trashToggle.style.cssText = "margin-top:8px;padding:4px 12px;cursor:pointer;";
    trashToggle.dataset.h3Role = "trash-toggle";
    trashToggle.onclick = () => _h3TrashToggle(trashToggle);
    box.appendChild(trashToggle);

    const trashBox = document.createElement("div");
    trashBox.style.cssText = "display:none;margin-top:8px;padding:8px;border:1px dashed #555;border-radius:4px;";
    trashBox.dataset.h3Role = "trash-box";
    box.appendChild(trashBox);

    // 模块级句柄 (供其他函数读 listEl/countLab/moreBtn 与 _h3HistoryLoad 协作)
    historyListEl = listEl;
    historyCountLab = countLab;
    historyMoreBtn = moreBtn;

    // 首次进 tab 懒加载 (确保 _loadHistoryListIfNeeded 已就绪 — 由 _h3HistoryLoad 占位)
    return box;
}

// V1.11 批 2 T3c: 回收站入口 — 懒加载 GET /h3_batch/history/trash, 已删记录列表 (只读,
//   复用任务行渲染但拼接/重跑/备注按钮全部隐藏; 缩略图可看; 每条"恢复"+"彻底删除"按钮).
let _h3TrashLoaded = false;
async function _h3TrashToggle(btn) {
    const trashBox = btn.parentNode.querySelector('[data-h3-role="trash-box"]');
    if (!trashBox) return;
    if (trashBox.style.display !== "none") {
        trashBox.style.display = "none";
        return;
    }
    trashBox.style.display = "";
    if (!_h3TrashLoaded) {
        try {
            // 交付前审查 FE-P1-1: trash 列表 GET 补 output_dir 参数 (与 DELETE 2607 对齐)
            const outDir = _h3FormOutputDir();
            const url = "/h3_batch/history/trash" + (outDir ? "?output_dir=" + encodeURIComponent(outDir) : "");
            const r = await api.fetchApi(url, { cache: "no-store" });
            const data = await r.json();
            _h3TrashLoaded = true;
            _h3TrashRender(trashBox, data && data.tasks ? data.tasks : []);
        } catch (e) {
            trashBox.textContent = "加载回收站失败: " + (e && e.message ? e.message : e);
        }
    }
}

// V1.11 批 2 T3c: 渲染回收站列表 — 只读任务行 + 恢复 + 彻底删除按钮
// 1.11a 波 3 T2 (F8): 行尾加"展开"按钮 → 懒加载 detail 端点只读展示段缩略图与状态
//   (无重跑/拼接段级按钮; 复用 detail 端点的 trash 寻址兜底 — :2764-2770 已就位).
function _h3TrashRender(box, tasks) {
    box.textContent = "";
    if (!tasks.length) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#888;font-size:12px;padding:8px;text-align:center;";
        empty.textContent = "回收站为空";
        box.appendChild(empty);
        return;
    }
    for (const t of tasks) {
        // 复用 _h3HistoryRow 但任务数据 in_trash=true — 该函数渲染时不识别 in_trash,
        // 因此这里手写一个只读行: 时间+模式+stem, 配 恢复/彻底删除 按钮.
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px;border:1px solid #555;border-radius:4px;margin-bottom:4px;background:#252529;";
        const info = document.createElement("div");
        info.style.cssText = "flex:1;font-size:12px;color:#ccc;";
        info.textContent = t.task_id + " · " + _h3FmtTime(t.time) + " · " + (t.mode || "分镜");
        row.appendChild(info);
        // F8: 展开按钮 — 懒加载 detail, 只读展示段级缩略图与状态, 无段级操作按钮.
        const expandBtn = document.createElement("button");
        expandBtn.textContent = "展开";
        expandBtn.style.cssText = "padding:2px 8px;cursor:pointer;";
        expandBtn.dataset.h3Role = "trash-expand-btn";
        const detailBox = document.createElement("div");
        detailBox.style.cssText = "display:none;padding:8px 0 4px 8px;border-top:1px dashed #444;margin-top:6px;flex-basis:100%;font-size:12px;color:#bbb;";
        detailBox.dataset.h3Role = "trash-detail-box";
        expandBtn.onclick = async () => {
            if (detailBox.style.display !== "none") {
                detailBox.style.display = "none";
                expandBtn.textContent = "展开";
                return;
            }
            if (detailBox.dataset.h3Loaded === "1") {
                detailBox.style.display = "";
                expandBtn.textContent = "收起";
                return;
            }
            expandBtn.textContent = "加载中…";
            expandBtn.disabled = true;
            try {
                const outDir = _h3FormOutputDir();
                const url = `/h3_batch/history/detail?task_id=${encodeURIComponent(t.task_id)}`
                    + (outDir ? `&output_dir=${encodeURIComponent(outDir)}` : "");
                const r = await api.fetchApi(url, { cache: "no-store" });
                const j = await r.json();
                detailBox.dataset.h3Loaded = "1";
                if (!j || j.ok !== true) {
                    detailBox.textContent = "详情加载失败: " + (j && j.error || "未知");
                } else {
                    detailBox.textContent = "";
                    const shots = j.shots || {};
                    const sids = Object.keys(shots).sort();
                    if (!sids.length) {
                        const none = document.createElement("div");
                        none.textContent = "(无段记录)";
                        detailBox.appendChild(none);
                    } else {
                        for (const sid of sids) {
                            const seg = shots[sid] || {};
                            const segRow = document.createElement("div");
                            segRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0;";
                            const lab = document.createElement("span");
                            lab.style.cssText = "min-width:54px;color:#9ab;";
                            lab.textContent = sid;
                            segRow.appendChild(lab);
                            // 缩略图 (成功段 + run_dir+files) — 复用历史 tab 缩略图 URL 拼法
                            const files = seg.files;
                            const runDir = seg.run_dir;
                            const fname = (Array.isArray(files) && files.length) ? files[0] : null;
                            if (seg.status === "success" && runDir && fname) {
                                const absPath = runDir + (runDir.endsWith("\\") || runDir.endsWith("/") ? "" : "/") + fname;
                                const img = document.createElement("img");
                                img.loading = "lazy";
                                img.style.cssText = "width:64px;height:auto;border:1px solid #555;background:#1a1a1e;";
                                img.src = "/h3_batch/thumb?path=" + encodeURIComponent(absPath) + "&max_size=128";
                                segRow.appendChild(img);
                            } else {
                                const ph = document.createElement("span");
                                ph.style.cssText = "display:inline-block;width:64px;height:36px;border:1px dashed #555;color:#666;line-height:36px;text-align:center;font-size:11px;";
                                ph.textContent = "--";
                                segRow.appendChild(ph);
                            }
                            const stLab = document.createElement("span");
                            const stTxt = seg.status || "未知";
                            stLab.style.cssText = "color:" + (
                                stTxt === "success" ? "#52c878" :
                                stTxt === "failed" ? "#f5534b" :
                                stTxt === "blocked" ? "#f9a825" : "#bbb");
                            stLab.textContent = stTxt;
                            segRow.appendChild(stLab);
                            detailBox.appendChild(segRow);
                        }
                    }
                }
                detailBox.style.display = "";
                expandBtn.textContent = "收起";
            } catch (e) {
                detailBox.textContent = "详情加载失败: " + (e && e.message ? e.message : e);
                detailBox.style.display = "";
                expandBtn.textContent = "收起";
            } finally {
                expandBtn.disabled = false;
            }
        };
        row.appendChild(expandBtn);
        const restoreBtn = document.createElement("button");
        restoreBtn.textContent = "恢复";
        restoreBtn.style.cssText = "padding:2px 8px;cursor:pointer;";
        restoreBtn.dataset.h3Role = "trash-restore-btn";
        restoreBtn.onclick = async () => {
            try {
                // 交付前审查 FE-P1-1: restore POST 补 output_dir 参数 (与 trash 列表/DELETE 对齐)
                const outDir = _h3FormOutputDir();
                const url = `/h3_batch/history/restore?task_id=${encodeURIComponent(t.task_id)}`
                    + (outDir ? `&output_dir=${encodeURIComponent(outDir)}` : "");
                const r = await api.fetchApi(url, { method: "POST" });
                const j = await r.json();
                if (j && j.ok) {
                    toast("success", "H3 回收站", t.task_id + " 已恢复");
                    _h3TrashLoaded = false;
                    _h3HistoryLoad(true);
                    box.textContent = "";
                } else {
                    toast("error", "H3 回收站", "恢复失败: " + (j && j.error || "未知"));
                }
            } catch (e) {
                toast("error", "H3 回收站", "网络错误: " + (e && e.message ? e.message : e));
            }
        };
        row.appendChild(restoreBtn);
        const purgeBtn = document.createElement("button");
        purgeBtn.textContent = "彻底删除";
        purgeBtn.style.cssText = "padding:2px 8px;cursor:pointer;color:#f5534b;";
        purgeBtn.dataset.h3Role = "trash-purge-btn";
        purgeBtn.onclick = () => _h3ShowTrashPurgeDialog(t.task_id, async () => {
            try {
                const r = await api.fetchApi(`/h3_batch/history?task_id=${encodeURIComponent(t.task_id)}&purge=true`, { method: "DELETE" });
                const j = await r.json();
                if (j && j.ok) {
                    toast("success", "H3 回收站", t.task_id + " 已彻底删除");
                    _h3TrashLoaded = false;
                    box.textContent = "";
                } else {
                    toast("error", "H3 回收站", "失败: " + (j && j.error || "未知"));
                }
            } catch (e) {
                toast("error", "H3 回收站", "网络错误: " + (e && e.message ? e.message : e));
            }
        });
        row.appendChild(purgeBtn);
        // detailBox 作为行扩展, flex-basis:100% 触发时占满整行 (在 row wrap 时)
        row.style.flexWrap = "wrap";
        row.appendChild(detailBox);
        box.appendChild(row);
    }
}

// 懒加载占位 (switchTab 钩子调用) — 防止表单未开时直接拉
function _loadHistoryListIfNeeded() {
    if (!_historyLoaded && historyListEl) {
        _h3HistoryLoad(false);
    }
}

// 加载/刷新历史列表 — refresh=true 是手动刷新按钮触发 (重置 offset)
// 交付前审查 FE-P1-2: 模块级 in-flight 守卫 + 代际令牌 — 加载更多/刷新并发 → 迟到响应自动丢弃,
//   concat 后按 task_id 去重保序.
let _h3HistoryLoadInFlight = false;
let _h3HistoryLoadToken = 0;
async function _h3HistoryLoad(refresh) {
    if (!historyListEl) return;
    if (_h3HistoryLoadInFlight) return;  // 防并发 — 已有请求在飞则忽略新触发
    _h3HistoryLoadInFlight = true;
    const myToken = ++_h3HistoryLoadToken;
    if (refresh) { _historyTasks = []; _historyExpanded.clear(); _historyLoaded = false; }
    const limit = 50;
    const offset = _historyTasks.length;
    try {
        const resp = await api.fetchApi(`/h3_batch/history?limit=${limit}&offset=${offset}`, { cache: "no-store" });
        const data = await resp.json();
        if (myToken !== _h3HistoryLoadToken) return;  // 迟到响应: 已有更新发起 → 丢弃
        if (!data || data.ok !== true) {
            historyListEl.textContent = "";
            const err = document.createElement("div");
            err.style.cssText = "color:#f44336;font-size:12px;";
            err.textContent = "加载失败: " + (data && data.error || "未知错误");
            historyListEl.appendChild(err);
            return;
        }
        const newTasks = data.tasks || [];
        // concat + 按 task_id 去重保序 (防止刷新/加载更多交错时多次出现同一 task_id)
        const merged = _historyTasks.concat(newTasks);
        const seen = new Set();
        _historyTasks = merged.filter(t => {
            const k = t && t.task_id;
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        _historyLoaded = true;
        _h3HistoryRender();
        if (historyCountLab) {
            const total = (typeof data.total === "number") ? data.total : _historyTasks.length;
            historyCountLab.textContent = "共 " + total + " 个任务";
        }
        if (historyMoreBtn) {
            historyMoreBtn.style.display = (_historyTasks.length < (data.total || 0)) ? "" : "none";
        }
    } catch (e) {
        if (myToken !== _h3HistoryLoadToken) return;  // 迟到异常同样丢弃
        if (historyListEl) {
            historyListEl.textContent = "";
            const err = document.createElement("div");
            err.style.cssText = "color:#f44336;font-size:12px;";
            err.textContent = "网络错误: " + (e && e.message ? e.message : e);
            historyListEl.appendChild(err);
        }
    } finally {
        if (myToken === _h3HistoryLoadToken) _h3HistoryLoadInFlight = false;
    }
}

function _h3HistoryLoadMore() { _h3HistoryLoad(false); }

// 渲染任务列表 (折叠态) — 根据 _historyTasks 重建 DOM (简单全量重建, 数据量小无性能问题)
function _h3HistoryRender() {
    if (!historyListEl) return;
    historyListEl.textContent = "";
    if (_historyTasks.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#888;font-size:12px;padding:12px;text-align:center;";
        empty.textContent = "暂无历史任务";
        historyListEl.appendChild(empty);
        return;
    }
    for (const t of _historyTasks) {
        historyListEl.appendChild(_h3HistoryRow(t));
    }
}

// 单任务行 (折叠态) — 时间 + 模式 + 成功N/失败N/作废N + 总段数 + 拼接徽标 + 备注截断 + 归档 + degraded
// V1.11 fix2: 折叠行顶部追加 总段数 (task.total) + 拼接徽标 (task.concat_badge),
// 信息密度提升但不撑高行高 (单行 + overflow ellipsis 留原有滚动条契约)
function _h3HistoryRow(task) {
    const row = document.createElement("div");
    const isExpanded = _historyExpanded.has(task.task_id);
    row.style.cssText = "border:1px solid #555;border-radius:4px;padding:8px;cursor:pointer;background:" + (isExpanded ? "#2e2e32" : "#252529");
    row.dataset.taskId = task.task_id;

    // 顶部行: 时间 + 模式标签 + 计数 + 总段数 + 拼接徽标 (单行不换行, 超出由 flex 自然压)
    const top = document.createElement("div");
    top.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:nowrap;overflow:hidden;";
    const time = document.createElement("span");
    time.style.cssText = "color:#aaa;font-size:12px;flex:none;";
    time.textContent = _h3FmtTime(task.time);
    top.appendChild(time);
    const mode = document.createElement("span");
    mode.style.cssText = "padding:1px 8px;border-radius:3px;font-size:11px;background:" + (task.mode === "拼接" ? "#3a4a6a" : "#3a3a3e") + ";color:#cfd8ff;flex:none;";
    mode.textContent = task.mode || "分镜";
    top.appendChild(mode);
    const counts = document.createElement("span");
    counts.style.cssText = "font-size:12px;color:#bbb;flex:none;";
    const parts = [];
    if (task.success) parts.push("成功 " + task.success);
    if (task.failed) parts.push("失败 " + task.failed);
    if (task.void) parts.push("作废 " + task.void);
    if (task.pending) parts.push("待审 " + task.pending);
    counts.textContent = parts.join(" / ") || "无段";
    top.appendChild(counts);
    // V1.11 fix2: 总段数徽标 — 一眼看到任务规模
    if (typeof task.total === "number" && task.total > 0) {
        const tot = document.createElement("span");
        tot.style.cssText = "font-size:11px;color:#9ec6ff;border:1px solid #5a7a9a;border-radius:3px;padding:0 4px;flex:none;";
        tot.textContent = "共 " + task.total + " 段";
        top.appendChild(tot);
    }
    // V1.11 fix2: 拼接徽标 (后端已派生: 已拼/未拼/拼失败/拼接中); 仅在有值时显示
    if (task.concat_badge) {
        const cb = document.createElement("span");
        const cbColor = task.concat_badge === "已拼" ? "#52c878"
                       : task.concat_badge === "拼失败" ? "#f5534b"
                       : task.concat_badge === "拼接中" ? "#ffc850"
                       : "#aaa";
        cb.style.cssText = "font-size:11px;color:" + cbColor + ";border:1px solid " + cbColor + ";border-radius:3px;padding:0 4px;flex:none;";
        cb.textContent = task.concat_badge;
        top.appendChild(cb);
    }
    // 1.14b U4b: 后处理徽标 (后端已派生: 后处理成功/后处理失败/后处理中, ⚠ 表示有 fallback).
    // 仿 concat_badge 派生样式, 锁三色: 成功=绿 / 失败=红 / 中=黄 / 含 ⚠=橙.
    if (task.postfx_badge) {
        const pb = document.createElement("span");
        let pbColor = "#aaa";
        if (task.postfx_badge === "后处理成功") pbColor = "#52c878";
        else if (task.postfx_badge === "后处理失败") pbColor = "#f5534b";
        else if (task.postfx_badge === "后处理中") pbColor = "#ffc850";
        else if (task.postfx_badge.indexOf("⚠") >= 0) pbColor = "#f9a825";
        pb.style.cssText = "font-size:11px;color:" + pbColor + ";border:1px solid " + pbColor + ";border-radius:3px;padding:0 4px;flex:none;";
        pb.textContent = task.postfx_badge;
        top.appendChild(pb);
    }
    if (task.archived) {
        const arch = document.createElement("span");
        arch.style.cssText = "font-size:11px;color:#80c0ff;border:1px solid #80c0ff;border-radius:3px;padding:0 4px;flex:none;";
        arch.textContent = "归档";
        top.appendChild(arch);
    }
    if (task.degraded) {
        const deg = document.createElement("span");
        deg.style.cssText = "font-size:11px;color:#f9a825;flex:none;";
        deg.textContent = "旧格式";
        top.appendChild(deg);
    }
    // 展开箭头
    const arrow = document.createElement("span");
    arrow.style.cssText = "margin-left:auto;color:#888;font-size:11px;flex:none;";
    arrow.textContent = isExpanded ? "▾" : "▸";
    top.appendChild(arrow);
    row.appendChild(top);

    // 备注行 (截断显示)
    if (task.note) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:12px;color:#888;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        note.textContent = "备注: " + task.note;
        row.appendChild(note);
    }

    row.onclick = (ev) => {
        // 老板报障 2026-09-04: 详情区内按钮(重跑/拼接/删除等)点击冒泡到行 → 误收起详情。
        // 交互控件一律不触发展开切换 (点行头信息区仍可收起)。
        if (ev && ev.target && ev.target.closest
            && ev.target.closest('button,input,select,textarea,label,a,[data-h3-role="history-detail"]')) return;
        if (_historyExpanded.has(task.task_id)) {
            _historyExpanded.delete(task.task_id);
        } else {
            _historyExpanded.add(task.task_id);
        }
        _h3HistoryRender();
        // 交付前审查 FE-P2-3: 去掉此处直接 _h3HistoryRenderDetail 调用 — 重建后 isExpanded=true 行
        //   会自动挂 det div + setTimeout(...,0) 调用一次 detail (避免重复 GET /history/detail).
    };

    // 展开区 (如已展开则挂 detail 容器; row 重新渲染后会丢, 下面 _h3HistoryRenderDetail 重挂)
    if (isExpanded) {
        const det = document.createElement("div");
        det.dataset.taskId = task.task_id;
        det.dataset.h3Role = "history-detail";
        det.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #444;";
        det.textContent = "加载中...";
        row.appendChild(det);
        // 异步拉 detail
        setTimeout(() => _h3HistoryRenderDetail(task.task_id), 0);
    }
    return row;
}

function _h3FmtTime(ts) {
    if (!ts) return "";
    try {
        const d = new Date(ts * 1000);
        const pad = (n) => (n < 10 ? "0" + n : "" + n);
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch (_) { return String(ts); }
}

// V1.11 批 2 T3/T3c/T4: 拉任务 detail → 段网格 + 段卡勾选 + 拼接按钮 (置灰/可点) +
//   note 编辑框 (非回收站) + 删除按钮 (非回收站) + 重跑选中按钮 (非回收站) +
//   段卡版本徽标 (N≥2) + in_trash 只读守卫
async function _h3HistoryRenderDetail(task_id) {
    const det = historyListEl && historyListEl.querySelector(`[data-h3-role="history-detail"][data-task-id="${task_id}"]`);
    if (!det) return;
    try {
        const resp = await api.fetchApi(`/h3_batch/history/detail?task_id=${encodeURIComponent(task_id)}`, { cache: "no-store" });
        const data = await resp.json();
        if (!data || data.ok !== true) {
            det.textContent = "加载失败: " + (data && data.error || "未知错误");
            return;
        }
        det.textContent = "";
        // V1.11 批 2 T6: 回收站内任务 (data.in_trash=true) → 只读模式, 不渲染写按钮
        const inTrash = data.in_trash === true;

        // 顶部操作行: 拼接 / 重跑选中 / 删除 (回收站内只显示只读标记)
        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;";
        const concatBtn = document.createElement("button");
        concatBtn.textContent = "拼接";
        concatBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
        btnRow.appendChild(concatBtn);
        // 1.14b U4a: 后处理按钮 — 点击弹窗选 kinds (放大/插帧) → POST /h3_batch/postfx
        const postfxBtn = document.createElement("button");
        postfxBtn.textContent = "放大/插帧";
        postfxBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
        postfxBtn.dataset.h3Role = "history-postfx-btn";
        postfxBtn.dataset.h3TaskId = task_id;
        postfxBtn.onclick = () => _h3ShowPostfxDialog(task_id, () => _h3HistoryLoad(true));
        btnRow.appendChild(postfxBtn);
        const rerunBtn = document.createElement("button");
        rerunBtn.textContent = "重跑选中段";
        rerunBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
        rerunBtn.dataset.h3Role = "history-rerun-btn";
        btnRow.appendChild(rerunBtn);
        // V1.11 批 3 T1: 同 seed 重跑 (改分辨率/步数, 种子继承) — source=task 入口
        const sameSeedBtn = document.createElement("button");
        sameSeedBtn.textContent = "同seed重跑";
        sameSeedBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
        sameSeedBtn.dataset.h3Role = "history-same-seed-btn";
        sameSeedBtn.dataset.h3TaskId = task_id;
        sameSeedBtn.onclick = () => {
            // 拉全局参数当前值 → 弹窗默认; localStorage "h3_same_seed_params" 记忆上次填写
            _h3ShowSameSeedDialog(task_id, "task", null, () => _h3HistoryLoad(true));
        };
        btnRow.appendChild(sameSeedBtn);
        // V1.11 批 3 T2: 导入配置按钮 — GET config → confirm 覆盖 → fillForm 三区回填.
        // 资源编排区结构不匹配 (V1.10 旧版无 _resources 等键) → fillForm 自然跳过该区,
        // 此处 catch 后 toast 提示用户该任务不可完整回填资源编排.
        const importCfgBtn = document.createElement("button");
        importCfgBtn.textContent = "导入配置";
        importCfgBtn.style.cssText = "padding:4px 12px;cursor:pointer;";
        importCfgBtn.dataset.h3Role = "history-import-config-btn";
        importCfgBtn.dataset.h3TaskId = task_id;
        importCfgBtn.onclick = async () => {
            const outDir = _h3FormOutputDir();
            try {
                const r = await api.fetchApi(`/h3_batch/history/config?task_id=${encodeURIComponent(task_id)}&output_dir=${encodeURIComponent(outDir)}`, { cache: "no-store" });
                const j = await r.json();
                if (!j || j.ok !== true || !j.config) {
                    toast("error", "H3 导入配置", "失败: " + ((j && j.error) || "未知"));
                    return;
                }
                if (!confirm("将覆盖当前表单内容，确定继续？")) return;
                try {
                    fillForm(j.config);
                } catch (e) {
                    toast("warn", "H3 导入配置", "表单部分回填失败 (可能为旧版快照结构不匹配): " + (e && e.message ? e.message : e));
                    return;
                }
                toast("success", "H3 导入配置", "已回填表单三区");
            } catch (e) {
                toast("error", "H3 导入配置", "网络错误: " + (e && e.message ? e.message : e));
            }
        };
        btnRow.appendChild(importCfgBtn);
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "删除";
        deleteBtn.style.cssText = "padding:4px 12px;cursor:pointer;color:#f5534b;";
        deleteBtn.dataset.h3Role = "history-delete-btn";
        btnRow.appendChild(deleteBtn);
        if (inTrash) {
            // V1.11 批 2 T6: 回收站只读 — 不渲染写按钮 (拼接/重跑/删除/note 编辑全部隐藏)
            rerunBtn.style.display = "none";
            deleteBtn.style.display = "none";
            concatBtn.style.display = "none";
            sameSeedBtn.style.display = "none";
            importCfgBtn.style.display = "none";
            const trashTag = document.createElement("span");
            trashTag.style.cssText = "color:#888;font-size:12px;";
            trashTag.textContent = "回收站只读";
            btnRow.appendChild(trashTag);
        }
        det.appendChild(btnRow);

        // 段网格
        const shots = data.shots || {};
        const segArr = Object.entries(shots).map(([sid, info]) => ({ sid, info }));
        const majority = h3ResolutionMajority(segArr.map((s) => s.info));
        const ratioOf = (info) => h3AspectRatio(info.width, info.height);
        // V1.11 批 2 T3b: 版本徽标 (N = 1 + reruns 中出现次数)
        const reruns = data._reruns || [];
        const versionCount = (sid) => 1 + h3VersionCount(reruns, sid);
        // V1.11 批 2 T3: 段卡默认勾选 (内存 Map, task_id → Set)
        if (!_h3RerunSel) _h3RerunSel = new Map();
        if (!_h3RerunSel.has(task_id)) {
            // 交付前审查 FE-P0-1: segArr 元素是 {sid, info:{status,review,...}}, 而
            // h3DefaultRerunSelection 期望 [{sid,status,review}] — 调用点扁平化避免读 undefined.
            const flat = segArr.map(({ sid, info }) => Object.assign({ sid }, info || {}));
            _h3RerunSel.set(task_id, new Set(h3DefaultRerunSelection(flat)));
        }
        const selSet = _h3RerunSel.get(task_id);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;";
        for (const { sid, info } of segArr) {
            const card = _h3HistorySegCard(sid, info, majority, ratioOf, selSet);
            // V1.11 批 2 T3b: 版本徽标 (右下角, N≥2 才显示) + 点击展开版本列表
            const N = versionCount(sid);
            if (N >= 2) {
                const badge = document.createElement("span");
                badge.style.cssText = "position:absolute;bottom:6px;right:6px;background:#3a3a6a;color:#cfd8ff;font-size:10px;padding:1px 6px;border-radius:8px;cursor:pointer;";
                badge.textContent = "版本 " + N;
                badge.dataset.h3Role = "version-badge";
                badge.dataset.sid = sid;
                card.appendChild(badge);
                // 1f2cfbc 真机缺口 (P0): 旧版 badge 渲染但无 click handler — 1f2cfbc 后追加
                badge.onclick = (ev) => {
                    ev.stopPropagation();
                    _h3RenderVersionList(card, sid, info, reruns);
                };
            }
            grid.appendChild(card);
        }
        det.appendChild(grid);

        // 拼接按钮置灰逻辑: 存在不一致段 → disabled
        if (majority.inconsistent.length > 0) {
            concatBtn.disabled = true;
            concatBtn.title = "存在分辨率不一致片段";
        } else {
            concatBtn.disabled = false;
            concatBtn.title = "";
        }
        _h3RenderRerunRecords(det, reruns, task_id, majority.inconsistent.length > 0, inTrash);
        // 拼接点击 (T3c): 二选一弹窗 (global/inherit) → dry_run 预览 → 执行
        concatBtn.onclick = () => _h3ShowConcatPreviewDialog(task_id, async (mode) => {
            try {
                const r = await api.fetchApi("/h3_batch/concat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ task_id: task_id, mode: mode, dry_run: true }),
                });
                const preview = await r.json();
                if (!preview || preview.ok !== true) {
                    toast("error", "H3 拼接", "dry_run 失败: " + (preview && preview.error || "未知"));
                    return;
                }
                // 二次确认: 弹窗内显示预览 + 确认执行按钮
                const dlg = ensureVoidChoiceDialog();
                dlg._btnsEl.innerHTML = "";
                dlg._titleEl.textContent = "拼接预览 (" + mode + ")";
                const lines = ["<div>基准: " + (preview.base_desc || "(无)") + "</div>"];
                if (preview.fell_back) lines.push("<div style='color:#f9a825'>触发回退: " + (preview.fallback_sids || []).join(", ") + "</div>");
                if (preview.missing && preview.missing.length) lines.push("<div style='color:#f44336'>缺件: " + preview.missing.join(", ") + "</div>");
                dlg._descEl.innerHTML = lines.join("");
                const okBtn = document.createElement("button");
                okBtn.type = "button";
                okBtn.textContent = "确认执行";
                okBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;";
                okBtn.onclick = async () => {
                    _closeVoidChoiceDialog();
                    const er = await api.fetchApi("/h3_batch/concat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ task_id: task_id, mode: mode }),
                    });
                    const ej = await er.json();
                    if (ej && ej.ok) {
                        // 1.11a 波 3 T2: started 响应不再立即报产物文件路径 (异步执行,
                        // 报文件路径属 UX 欺骗). 后端 detail 回任务目录 task_folder,
                        // 提示用户到该目录查看拼接产物. 后端失败时退化到 output 字段兼容旧调用方.
                        const folder = ej.task_folder || (ej.output ? ej.output.replace(/[\\/][^\\/]+$/, "") : "");
                        toast("success", "H3 拼接", "拼接已启动, 完成后在任务目录查看: " + (folder || "(无)"));
                        _h3HistoryLoad(true);
                    } else {
                        toast("error", "H3 拼接", "失败: " + (ej && ej.error || "未知"));
                    }
                };
                const cancelBtn = document.createElement("button");
                cancelBtn.type = "button";
                cancelBtn.textContent = "取消";
                cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
                cancelBtn.onclick = () => _closeVoidChoiceDialog();
                dlg._btnsEl.appendChild(okBtn);
                dlg._btnsEl.appendChild(cancelBtn);
                dlg.style.display = "";
            } catch (e) {
                toast("error", "H3 拼接", "网络错误: " + (e && e.message ? e.message : e));
            }
        });
        // 重跑按钮 (T3): 弹窗 → POST rerun → 轮询 → toast → 刷新
        rerunBtn.onclick = () => {
            const sids = Array.from(selSet);
            if (!sids.length) {
                toast("warn", "H3 重跑", "未勾选任何段");
                return;
            }
            _h3ShowRerunConfirmDialog(task_id, sids, async (confirmedSids, keepSeed) => {
                try {
                    const r = await api.fetchApi("/h3_batch/rerun", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ task_id: task_id, sids: confirmedSids, keep_seed: !!keepSeed }),
                    });
                    const j = await r.json();
                    if (!j || j.ok !== true) {
                        toast("error", "H3 重跑", "失败: " + (j && j.error || "未知"));
                        return;
                    }
                    // 轮询 status 直到 running=false — 2026-09-03 fixround: 上限 1200s/降频/中性文案
                    //   5 分钟内 2s 一次, 之后 10s 一次 (覆盖多段重跑, 减请求). 表单关闭由 _h3RerunPoll 在 closeForm 清理.
                    const stem = task_id;
                    const outDir = _h3FormOutputDir();
                    const pollUrl = `/h3_batch/status?output_dir=${encodeURIComponent(outDir)}&stem=${encodeURIComponent(stem)}`;
                    _h3RerunPoll = { elapsed: 0, timer: null, taskId: task_id };
                    // 原地重渲染 detail: 重跑进行中 _reruns 账本为空, 记录区显示"重跑进行中"占位行
                    _h3HistoryRenderDetail(task_id);
                    const POLL_MAX = 1200;          // 20 分钟, 覆盖多段重跑
                    const POLL_FAST_S = 2;          // 5 分钟内 2s 一次
                    const POLL_SLOW_S = 10;         // 5 分钟后降频到 10s 一次
                    const POLL_SWITCH = 300;        // 5 分钟 = 300s 切换降频
                    const tick = async () => {
                        if (!_h3RerunPoll) return;  // 表单关闭时已清理
                        if (_h3RerunPoll.elapsed >= POLL_MAX) {
                            toast("info", "H3 重跑", "重跑仍在进行, 可在历史任务中查看进度");
                            _h3RerunPoll = null;
                            return;
                        }
                        try {
                            const resp = await api.fetchApi(pollUrl, { cache: "no-store" });
                            const sd = await resp.json();
                            // 1.11a 波 3 T2: 三态 unknown — 不触发完成, 不 toast, 继续 tick
                            if (sd && sd.running === "unknown") {
                                // 静默等待, 不触发完成逻辑, 不 toast
                            } else if (sd && sd.running === false) {
                                toast("success", "H3 重跑", "已完成 " + confirmedSids.length + " 段");
                                _h3RerunPoll = null;
                                _h3HistoryLoad(true);
                                // 刷新清空展开态 → 回展开本任务, detail 重拉后重跑记录直接可见
                                _historyExpanded.add(task_id);
                                return;
                            }
                        } catch (_) {}
                        const step = _h3RerunPoll.elapsed >= POLL_SWITCH ? POLL_SLOW_S : POLL_FAST_S;
                        _h3RerunPoll.elapsed += step;
                        _h3RerunPoll.timer = setTimeout(tick, step * 1000);
                    };
                    toast("info", "H3 重跑", "提交 " + confirmedSids.length + " 段, 轮询中…");
                    _h3RerunPoll.timer = setTimeout(tick, POLL_FAST_S * 1000);
                } catch (e) {
                    toast("error", "H3 重跑", "网络错误: " + (e && e.message ? e.message : e));
                }
            });
        };
        // 删除按钮 (T3c): confirm → DELETE → 刷新
        deleteBtn.onclick = async () => {
            if (!_h3ConfirmDelete(task_id)) return;
            try {
                const r = await api.fetchApi(`/h3_batch/history?task_id=${encodeURIComponent(task_id)}&output_dir=${encodeURIComponent(_h3FormOutputDir())}`, { method: "DELETE" });
                const j = await r.json();
                if (j && j.ok) {
                    toast("success", "H3 删除", task_id + " 已移入回收站");
                    _h3HistoryLoad(true);
                } else {
                    toast("error", "H3 删除", "失败: " + (j && j.error || "未知"));
                }
            } catch (e) {
                toast("error", "H3 删除", "网络错误: " + (e && e.message ? e.message : e));
            }
        };

        // V1.11 批 2 T4: 备注编辑框 (回收站不渲染)
        if (!inTrash) {
            const noteBox = document.createElement("div");
            noteBox.style.cssText = "margin-top:10px;padding:8px;border:1px solid #555;border-radius:4px;";
            const noteLab = document.createElement("div");
            noteLab.style.cssText = "font-size:12px;color:#bbb;margin-bottom:4px;";
            noteLab.textContent = "备注";
            noteBox.appendChild(noteLab);
            const noteTa = document.createElement("textarea");
            noteTa.rows = 2;
            noteTa.style.cssText = "width:100%;padding:4px;box-sizing:border-box;background:#1a1a1e;color:#e6e6e6;border:1px solid #555;border-radius:3px;font-size:12px;";
            noteTa.value = data.note || "";
            noteTa.dataset.h3Role = "history-note-input";
            noteBox.appendChild(noteTa);
            const saveBtn = document.createElement("button");
            saveBtn.textContent = "保存备注";
            saveBtn.style.cssText = "margin-top:4px;padding:4px 12px;cursor:pointer;";
            saveBtn.dataset.h3Role = "history-note-save";
            saveBtn.onclick = async () => {
                try {
                    const r = await api.fetchApi("/h3_batch/history/note", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ task_id: task_id, note: noteTa.value }),
                    });
                    const j = await r.json();
                    if (j && j.ok) {
                        toast("success", "H3 备注", "已保存");
                        _h3HistoryLoad(true);
                    } else {
                        toast("error", "H3 备注", "失败: " + (j && j.error || "未知"));
                    }
                } catch (e) {
                    toast("error", "H3 备注", "网络错误: " + (e && e.message ? e.message : e));
                }
            };
            noteBox.appendChild(saveBtn);
            det.appendChild(noteBox);
        }
    } catch (e) {
        if (det) det.textContent = "网络错误: " + (e && e.message ? e.message : e);
    }
}

// V1.11 rerunrows: 重跑记录区块 — 段网格后渲染 _reruns 台账 (空数组整块不渲染).
//   每行: #seq + 时间 + 涉及段 + 原因标签 + 该次参数 + 同seed重跑/拼接按钮 (复用
//   版本树行绑定模式: source=rerun + seq / onConfirm 直发 POST concat 含 rerun_seq).
//   resolutionBad → 拼接 disabled (与任务级按钮同规则同文案); inTrash → 按钮隐藏 (只读).
function _h3RenderRerunRecords(det, reruns, task_id, resolutionBad, inTrash) {
    // 老板报障 2026-09-04: 重跑进行中账本(_reruns)尚未落盘 → 记录区整体消失。
    // 补占位行: 本任务重跑轮询在飞时至少显示"重跑进行中", 完成后自动回展开刷新。
    const pending = _h3RerunPoll && _h3RerunPoll.taskId === task_id;
    if (!det || !Array.isArray(reruns) || (!reruns.length && !pending)) return;
    const box = document.createElement("div");
    box.style.cssText = "margin-top:10px;padding:8px;border:1px solid #555;border-radius:4px;";
    const title = document.createElement("div");
    title.style.cssText = "font-size:12px;color:#bbb;margin-bottom:4px;";
    title.textContent = "重跑记录";
    box.appendChild(title);
    if (pending) {
        const pr = document.createElement("div");
        pr.dataset.h3Role = "rerun-record-pending";
        pr.style.cssText = "padding:2px 0;font-size:11px;color:#f9a825;";
        pr.textContent = "重跑进行中…（完成后此处显示记录）";
        box.appendChild(pr);
    }
    const reasonLabels = { manual: "手动重跑", same_seed: "同seed", prompt_edit: "改词" };
    // seq 倒序 (最新在上)
    const sorted = reruns.filter(r => r && r.seq != null).sort((a, b) => b.seq - a.seq);
    for (const r of sorted) {
        const row = document.createElement("div");
        row.dataset.h3Role = "rerun-record-row";
        row.dataset.seq = r.seq;
        row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0;font-size:11px;color:#aaa;";
        const lab = document.createElement("span");
        lab.style.cssText = "flex:none;color:#e6e6e6;";
        lab.textContent = "#" + r.seq;
        row.appendChild(lab);
        const t = document.createElement("span");
        t.style.cssText = "flex:none;color:#888;";
        t.textContent = _h3FmtTime(r.time);
        row.appendChild(t);
        const sids = document.createElement("span");
        sids.style.cssText = "flex:none;";
        sids.textContent = (r.sids || []).join(",");
        row.appendChild(sids);
        const reason = document.createElement("span");
        reason.style.cssText = "flex:none;padding:1px 6px;border-radius:3px;background:#3a3a5a;color:#e6e6e6;font-size:10px;";
        reason.textContent = reasonLabels[r.reason] || String(r.reason);
        row.appendChild(reason);
        const p = r.params || {};
        if (p.比例 != null || p.质量 != null || p.步数 != null) {
            const params = document.createElement("span");
            params.style.cssText = "flex:none;color:#888;";
            params.textContent = [p.比例, p.质量, p.步数].map(v => (v == null ? "-" : v)).join("/");
            row.appendChild(params);
        }
        const ssBtn = document.createElement("button");
        ssBtn.type = "button";
        ssBtn.textContent = "同seed重跑";
        ssBtn.dataset.h3Role = "rerun-record-same-seed-btn";
        ssBtn.dataset.seq = r.seq;
        ssBtn.style.cssText = "padding:1px 6px;font-size:10px;cursor:pointer;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:3px;";
        ssBtn.onclick = (ev) => {
            ev.stopPropagation();
            window._h3LastSameSeedParams = { seq: r.seq, params: r.params || null };
            _h3ShowSameSeedDialog(task_id, "rerun", r.seq, () => _h3HistoryLoad(true));
            setTimeout(() => { window._h3LastSameSeedParams = null; }, 100);
        };
        row.appendChild(ssBtn);
        const ccBtn = document.createElement("button");
        ccBtn.type = "button";
        ccBtn.textContent = "拼接";
        ccBtn.dataset.h3Role = "rerun-record-concat-btn";
        ccBtn.dataset.seq = r.seq;
        ccBtn.style.cssText = "padding:1px 6px;font-size:10px;cursor:pointer;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:3px;";
        if (resolutionBad === true) {
            ccBtn.disabled = true;
            ccBtn.title = "存在分辨率不一致片段";
        }
        ccBtn.onclick = (ev) => {
            ev.stopPropagation();
            _h3ShowConcatPreviewDialog(task_id, async (mode) => {
                try {
                    const resp = await api.fetchApi("/h3_batch/concat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ task_id: task_id, mode: mode, rerun_seq: r.seq, dry_run: false }),
                    });
                    const j = await resp.json();
                    if (j && j.ok) {
                        // 1.11a 波 3 T2: 拼接已启动 → 提示任务目录而非产物文件路径 (异步执行)
                        const folder = j.task_folder || (j.output ? j.output.replace(/[\\/][^\\/]+$/, "") : "");
                        toast("success", "H3 拼接", "拼接已启动, 完成后在任务目录查看: " + (folder || "(无)"));
                        _h3HistoryLoad(true);
                    } else {
                        toast("error", "H3 拼接", "失败: " + (j && j.error || "未知"));
                    }
                } catch (err) {
                    toast("error", "H3 拼接", "网络错误: " + (err && err.message ? err.message : err));
                }
            }, r.seq);
        };
        row.appendChild(ccBtn);
        if (inTrash === true) {
            ssBtn.style.display = "none";
            ccBtn.style.display = "none";
        }
        box.appendChild(row);
    }
    det.appendChild(box);
}

// V1.11 批 2 T3: 段卡重跑勾选状态 (内存 Map, task_id → Set<sid>)
let _h3RerunSel = null;

// V1.11 批 2 T3c: "跑完自动拼接" 复选句柄 — 上移到所有调用之前 (TDZ 防呆).
//   buildGlobalSection 装配期即写, 与 history section 同约束 (批 2 T1/T2 修复后).
let autoConcatInput = null;
// 1.14b U3: 后处理三键句柄 — 放大/插帧 复选 + 放大引擎 选择
let postfxUpscaleInput = null;
let postfxInterpInput = null;
let postfxEngineSelect = null;

// 2026-09-03 fixround: 重跑轮询句柄 (timer id + 已用秒) — 表单关闭由 closeForm 清理, 防泄漏
let _h3RerunPoll = null;

// 2026-09-03 fixround: 改词重跑轮询句柄 (deadef5 把上限提到 1200s/降频后, 句柄曾无清理路径) — closeForm 清理
let _h3PollStatusTimer = null;
// 交付前审查 FE-P0-3: 代际令牌 — _h3PollStatus 自增, tick 闭包捕获本代 token, 续期前比对新值;
//   closeForm 自增 token 使所有在飞 tick 失效 (clearTimeout 兜底). 防止两次发起 + 关闭后孤儿 tick 复活句柄.
let _h3PollToken = 0;


// 2026-09-03 fixround: 段卡 hover + selected 视觉 — 一次性注入 <style>, 多次渲染共用
(function _injectSegCardHoverStyle() {
    if (typeof document === "undefined") return;
    if (document.getElementById("h3-seg-card-hover-style")) return;
    const _style = document.createElement("style");
    _style.id = "h3-seg-card-hover-style";
    _style.textContent = "[data-h3-role='history-seg-card']:hover{background:#25252a;}" +
        "[data-h3-role='history-seg-card'].selected{border:2px solid #4caf50;background:#1e2a1e;padding:5px;}";
    document.head.appendChild(_style);
})();

// 单段卡 — 缩略图 + 角色点 + 段名 + seed + 分辨率信息行 (含红字不一致警示)
// V1.11 批 2 T3: +勾选框 (默认勾选状态由 selSet 控制) — 回收站内不渲染 (caller 守卫)
// 2026-09-03 fixround: 整卡=勾选区 (缩略图/信息行/角标均可点切换), stopPropagation 阻断行收起;
//   勾选框 (左上角色点旁) 恢复 — cb 与整卡共用 toggleSel, 各自 stopPropagation 不互相冒泡
function _h3HistorySegCard(sid, info, majority, ratioOf, selSet) {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #555;border-radius:4px;padding:6px;background:#1a1a1e;position:relative;cursor:pointer;";
    card.dataset.sid = sid;
    card.dataset.h3Role = "history-seg-card";
    if (selSet) {
        let cb = null;
        const syncVis = () => {
            if (cb) cb.checked = selSet.has(sid);
            card.classList.toggle("selected", selSet.has(sid));
        };
        const toggleSel = () => {
            if (selSet.has(sid)) selSet.delete(sid); else selSet.add(sid);
            syncVis();
        };
        cb = document.createElement("input");
        cb.type = "checkbox";
        cb.style.cssText = "position:absolute;top:6px;left:22px;z-index:2;";
        cb.dataset.h3Role = "seg-recheck-cb";
        cb.dataset.sid = sid;
        cb.checked = selSet.has(sid);
        cb.onclick = (ev) => { ev.stopPropagation(); toggleSel(); };
        card.appendChild(cb);
        card.onclick = (ev) => { ev.stopPropagation(); toggleSel(); };
        if (selSet.has(sid)) card.classList.add("selected");
    }

    // 角色点 (成功绿/失败红/作废灰/待审黄)
    const dot = document.createElement("span");
    dot.style.cssText = "position:absolute;top:6px;left:6px;width:10px;height:10px;border-radius:50%;";
    const status = info.status;
    const review = info.review;
    const isPending = review === "pending" || (review == null && status === "success");
    if (status === "success" && review === "void") {
        dot.style.background = "#9e9e9e";   // 作废
    } else if (status === "failed" || status === "stopped") {
        dot.style.background = "#f44336";   // 失败
    } else if (isPending) {
        dot.style.background = "#ff9800";   // 待审
    } else if (status === "success") {
        dot.style.background = "#4caf50";   // 成功
    } else {
        dot.style.background = "#9e9e9e";
    }
    card.appendChild(dot);

    // 缩略图 — 产物绝对路径 = run_dir + files[0] (encodeURIComponent)
    const files = info.files || [];
    const fname = Array.isArray(files) ? files[0] : null;
    const runDir = info.run_dir || "";
    if (fname && runDir && status === "success") {
        // 绝对路径: Windows 风格 join (run_dir 可能以 \ 或 / 结尾)
        const sep = runDir.includes("\\") && !runDir.includes("/") ? "\\" : "/";
        const cleanDir = runDir.replace(/[\\/]+$/, "");
        const absPath = cleanDir + sep + fname;
        const img = document.createElement("img");
        // 段卡渲染: <img loading="lazy" src="/h3_batch/thumb?path=...&max_size=256"> — 滚动到才请求
        img.loading = "lazy";
        img.src = "/h3_batch/thumb?path=" + encodeURIComponent(absPath) + "&max_size=256";
        img.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:3px;background:#000;";
        img.onerror = () => { img.style.display = "none"; };
        card.appendChild(img);
    } else {
        // 失败/停止/无产物 → 灰底占位
        const ph = document.createElement("div");
        ph.style.cssText = "width:100%;aspect-ratio:16/9;background:#2a2a2e;color:#666;display:flex;align-items:center;justify-content:center;border-radius:3px;font-size:12px;";
        ph.textContent = "无产物";
        card.appendChild(ph);
    }

    // 段名 + seed 短显
    const name = document.createElement("div");
    name.style.cssText = "margin-top:6px;font-size:12px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const seedShort = info.seed != null ? " · seed " + String(info.seed).slice(0, 6) : "";
    name.textContent = sid + seedShort;
    card.appendChild(name);

    // 分辨率信息行: WxH · 比例; 不一致追加红字
    const infoRow = document.createElement("div");
    infoRow.style.cssText = "font-size:11px;color:#aaa;margin-top:2px;";
    const ratio = ratioOf(info);
    let infoText = "";
    if (info.width && info.height) {
        infoText = info.width + "x" + info.height + " · " + ratio;
    } else {
        infoText = "--";
    }
    infoRow.textContent = infoText;
    card.appendChild(infoRow);
    if (majority.inconsistent.length > 0 && info.width && info.height
        && majority.majority
        && (info.width !== majority.majority.w || info.height !== majority.majority.h)) {
        const warn = document.createElement("div");
        warn.style.cssText = "font-size:11px;color:#f44336;margin-top:2px;";
        warn.textContent = ratio + " 与其他片段不符，无法拼接";
        card.appendChild(warn);
    }
    // V1.11 批 3 T1: 改词重跑按钮 — 段卡右下角 (版本徽标同区, 在其左侧).
    // status=success 段才允许改词 (失败/停止段无产物可改).
    if (info.status === "success") {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "\u270f\ufe0f 改词重跑";
        editBtn.dataset.h3Role = "seg-edit-prompt-btn";
        editBtn.dataset.h3Sid = sid;
        editBtn.style.cssText = "position:absolute;bottom:6px;right:6px;font-size:10px;padding:1px 6px;background:#3a5a3a;color:#e6e6e6;border:1px solid #5a7a5a;border-radius:3px;cursor:pointer;z-index:2;";
        editBtn.onclick = (ev) => {
            ev.stopPropagation();
            // 拉 final_prompt 全文 (full_prompt=true) → 全宽编辑弹窗
            const det = card.closest('[data-h3-role="history-detail"]');
            const tid = det && det.dataset ? det.dataset.taskId : "";
            _h3ShowPromptEditDialog(tid, sid, info, () => _h3HistoryLoad(true));
        };
        card.appendChild(editBtn);
    }
    return card;
}

// V1.11 批 2 T3b (1f2cfbc 后追加): 渲染段卡版本列表 — 点击徽标展开/收起.
//   数据由纯函数 h3VersionList(reruns, sid, currentInfo) 提供; 本函数仅消费 entries 渲染 DOM.
//   列表结构: 容器 div (data-h3-role="version-list") > 每行 div (时间 + 标签 + seed + 缩略图).
//   现行版本标签 = "现行", 重跑条目标签 = "重跑 N" (N=seq).
//   缩略图 img: /h3_batch/thumb?path=<run_dir+file>&max_size=128 (懒加载, run_dir 缺省不渲染).
//   再点徽标收起 (切换 data-h3-expanded).
function _h3RenderVersionList(card, sid, info, reruns) {
    // 已有列表 → 收起
    const existing = card.querySelector('[data-h3-role="version-list"]');
    if (existing) {
        existing.remove();
        card.dataset.h3Expanded = "";
        return;
    }
    const files = info.files || [];
    const curFile = Array.isArray(files) ? files[0] : null;
    const curRunDir = info.run_dir || "";
    const entries = h3VersionList(reruns, sid, {
        run_dir: curRunDir, file: curFile, seed: info.seed,
    });
    if (!entries.length) return;
    const list = document.createElement("div");
    list.dataset.h3Role = "version-list";
    list.dataset.sid = sid;
    list.style.cssText = "margin-top:6px;padding:6px;border-top:1px solid #444;display:flex;flex-direction:column;gap:4px;font-size:11px;color:#bbb;";
    for (const e of entries) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;";
        // 标签 (现行 / 重跑 N)
        const lab = document.createElement("span");
        lab.style.cssText = "padding:1px 6px;border-radius:3px;background:" +
            (e.type === "current" ? "#3a5a3a" : "#3a3a5a") + ";color:#e6e6e6;font-size:10px;flex:none;";
        lab.textContent = e.type === "current" ? "现行" : ("重跑 " + e.seq);
        row.appendChild(lab);
        // 时间
        if (e.time != null) {
            const t = document.createElement("span");
            t.style.cssText = "color:#888;flex:none;";
            t.textContent = _h3FmtTime(e.time);
            row.appendChild(t);
        }
        // seed
        if (e.seed != null) {
            const s = document.createElement("span");
            s.style.cssText = "color:#aaa;flex:none;";
            s.textContent = "seed " + e.seed;
            row.appendChild(s);
        }
        // 缩略图 (lazy) — run_dir 与 file 都需存在; 缺一不渲染
        if (e.run_dir && e.file) {
            const sep = e.run_dir.includes("\\") && !e.run_dir.includes("/") ? "\\" : "/";
            const cleanDir = e.run_dir.replace(/[\\/]+$/, "");
            const absPath = cleanDir + sep + e.file;
            const img = document.createElement("img");
            img.loading = "lazy";
            img.src = "/h3_batch/thumb?path=" + encodeURIComponent(absPath) + "&max_size=128";
            img.style.cssText = "width:60px;height:34px;object-fit:cover;border-radius:3px;background:#000;";
            img.onerror = () => { img.style.display = "none"; };
            row.appendChild(img);
        }
        // V1.11 批 3 T1: 重跑记录行按钮 (C 组) — 同seed重跑 (基于该次 seeds+params)
        // + 拼接 (用该次重跑的组合). 现行行不挂按钮 (无 seq).
        if (e.type === "rerun") {
            const det = card.closest('[data-h3-role="history-detail"]');
            const tid = det && det.dataset ? det.dataset.taskId : "";
            const ssBtn = document.createElement("button");
            ssBtn.type = "button";
            ssBtn.textContent = "同seed重跑";
            ssBtn.dataset.h3Role = "version-row-same-seed-btn";
            ssBtn.style.cssText = "padding:1px 6px;font-size:10px;cursor:pointer;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:3px;";
            ssBtn.onclick = (ev) => {
                ev.stopPropagation();
                // P1-6: source=rerun 入口默认值优先取该次 entry.params.
                // 设 window 全局供 _h3ShowSameSeedDialog 读取 (避免改函数签名).
                window._h3LastSameSeedParams = { seq: e.seq, params: e.params || null };
                _h3ShowSameSeedDialog(tid, "rerun", e.seq, () => _h3HistoryLoad(true));
                // 弹窗开完清理 (避免影响下次 source=task 入口 — task 入口不读它)
                setTimeout(() => { window._h3LastSameSeedParams = null; }, 100);
            };
            row.appendChild(ssBtn);
            const ccBtn = document.createElement("button");
            ccBtn.type = "button";
            ccBtn.textContent = "拼接";
            ccBtn.dataset.h3Role = "version-row-concat-btn";
            ccBtn.style.cssText = "padding:1px 6px;font-size:10px;cursor:pointer;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:3px;";
            ccBtn.onclick = (ev) => {
                ev.stopPropagation();
                _h3ShowConcatPreviewDialog(tid, async (mode) => {
                    try {
                        const r = await api.fetchApi("/h3_batch/concat", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ task_id: tid, mode: mode, rerun_seq: e.seq, dry_run: false }),
                        });
                        const j = await r.json();
                        if (j && j.ok) {
                            // 1.11a 波 3 T2: 拼接已启动 → 提示任务目录而非产物文件路径 (异步执行)
                            const folder = j.task_folder || (j.output ? j.output.replace(/[\\/][^\\/]+$/, "") : "");
                            toast("success", "H3 拼接", "拼接已启动, 完成后在任务目录查看: " + (folder || "(无)"));
                            _h3HistoryLoad(true);
                        } else {
                            toast("error", "H3 拼接", "失败: " + (j && j.error || "未知"));
                        }
                    } catch (err) {
                        toast("error", "H3 拼接", "网络错误: " + (err && err.message ? err.message : err));
                    }
                }, e.seq);
            };
            row.appendChild(ccBtn);
        }
        list.appendChild(row);
    }
    card.appendChild(list);
    card.dataset.h3Expanded = "1";
}

// R5: 运镜方式 change → 同一卡片内重建"运镜方向" select 的 options (多行独立, 各自联动);
//   方式空值/不在 MOVE_DIR_ALLOW → 全量 VOCAB["运镜方向"]; 当前方向仍在允许集 → 保留, 否则清空;
//   允许集为空 (固定机位等) → options 只剩空项 + disabled;
//   数据契约: collectData/fillForm 不动 (回填按值直设, 不在当前 options 显示空是既有行为)
function _refillMoveDirCtrls(evt) {
    const moveSel = evt.target;
    const card = moveSel.closest("[data-h3-shot-card]");
    const dirSel = card && card.querySelector('[data-key="运镜方向"]');
    if (!dirSel) return;
    const mapped = MOVE_DIR_ALLOW[moveSel.value];
    const opts = (mapped ? mapped : (VOCAB["运镜方向"] || [])).slice();
    const cur = dirSel.value;
    dirSel.innerHTML = "";
    dirSel.appendChild(new Option("", ""));
    for (const opt of opts) dirSel.appendChild(new Option(opt, opt));
    dirSel.value = (cur && opts.includes(cur)) ? cur : "";
    dirSel.disabled = !!(mapped && !mapped.length);
}

// 卡片布局: 高级折叠区 line1 (ID + 九宫格 + 种子/导出文件名, 同一 grid) + line2 (prompt + 段落时长 + 按钮)。
// 控件按字段名存入 ctrls (dataset.key 同步标记), collectData/回填按键名读写, 不依赖列顺序。
// V1.9 R-B1: 九宫格/ID/种子/导出文件名 收入"高级"折叠区(_advanced), 简洁模式默认隐藏;
//            collectData 照常读全部字段 (隐藏≠清空, 控件对象与 .value 全程保留)。
function buildShotRow() {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #555;border-radius:6px;padding:8px;margin-bottom:8px;background:rgba(255,255,255,.03);";
    card.dataset.h3ShotCard = "1";  // R5: 方式→方向联动的同卡片定位锚

    const ctrls = {};
    // R4: 第三参改原样拼接 — grid 行格子传 "100%" (格子内自适应填充), flex 行传 "70px"
    const mkCell = (key, ctrl, width) => {
        ctrl.dataset.key = key;
        ctrl.style.cssText = "width:" + width + ";padding:2px 4px;box-sizing:border-box;";
        const cell = document.createElement("label");
        cell.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:none;";
        const lab = document.createElement("span");
        lab.textContent = key;
        lab.style.cssText = "color:#9a9a9a;font-size:11px;";
        cell.appendChild(lab);
        cell.appendChild(ctrl);
        return cell;
    };

    // V1.9 R-B1: 高级折叠区 — 包住 line1 (九宫格+ID+种子+导出文件名)
    const advanced = document.createElement("div");
    advanced.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:6px;";
    card.appendChild(advanced);
    ctrls._advanced = advanced;

    const line1 = document.createElement("div");
    // R4: grid 网格对齐 — 九宫格/ID 格子等宽对齐 (控件 100% 填充格子)
    // R5: 种子/导出文件名并入同一 grid — 列边界天然对齐, 第二行不满时后续字段接续填充
    line1.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;";
    advanced.appendChild(line1);
    SHOT_KEYS.forEach((key) => {
        if (key === "prompt" || key === "段落时长") return;
        // 1.11b 波2 T6: 自定义模式拼接勾选列 — 走 input[type=checkbox] 特例 (非 select / 非 text);
        //   .value 必须在 change 时同步 (collectData/fetchPreview 只读 .value, 否则拿到 "on" → 引擎判否).
        let ctrl;
        if (key === CONCAT_FLAG_COL) {
            ctrl = document.createElement("input");
            ctrl.type = "checkbox";
            ctrl.value = "";                       // 初值空串, 与 collectData 读法对齐
            ctrl.addEventListener("change", () => {
                ctrl.value = ctrl.checked ? "是" : "";   // N1: 同步 .value (否则 .value 默认 "on" → 引擎判否)
                schedulePreviewAll();
            });
        } else {
            ctrl = SHOT_VOCAB_KEYS.includes(key) ? document.createElement("select") : document.createElement("input");
            if (ctrl.tagName === "SELECT") {
                ctrl.appendChild(new Option("", ""));
                for (const opt of (VOCAB[key] || [])) ctrl.appendChild(new Option(opt, opt));
                ctrl.addEventListener("change", schedulePreviewAll);   // 2.6: 分项改词触发预览刷新
                // R5: 运镜方式 → 运镜方向允许集联动 (追加监听, 不影响上面的预览刷新)
                if (key === "运镜方式") ctrl.addEventListener("change", _refillMoveDirCtrls);
            }
            // V1.6: ID 失焦触发级联递增 — 只填空白行
            if (key === "ID") ctrl.addEventListener("change", () => { applyCascadeToBlankRows("ID"); schedulePreviewAll(); });
            // V1.6: 导出文件名 失焦触发级联递增 — 只填空白行 (R5: 并入 line1 循环, 不再单独成行)
            if (key === "导出文件名") ctrl.addEventListener("change", () => { applyCascadeToBlankRows("导出文件名"); schedulePreviewAll(); });
            // 批 A 节点 5 (5a): 分镜行 UI 移除「出场角色」列 → 不再有 datalist 注入分支
        }
        ctrls[key] = ctrl;
        const _cell = mkCell(key, ctrl, "100%");
        // 1.11b 波2 T6: 保存 cell 引用 — _refreshConcatFlagVisibility 隐藏时整 cell 一起藏
        //   (mkCell 返回 label.cell 含 key span + ctrl; 只藏 ctrl 会残留标签文字)
        if (key === CONCAT_FLAG_COL) ctrls._concatFlagCell = _cell;
        line1.appendChild(_cell);
    });

    // V1.10 批3 T1: 画线选运镜小画布 — 高级折叠区内 (跟随 _advanced 显隐, 简洁模式自动隐藏).
    //   用户按住拖动画一条线, 松手后 _recognizeStroke 识别 → 自动填 "运镜方式+运镜方向".
    //   拉在 advanced 容器下而不是 line1 grid 内: 画布 140×70 与 line1 的 104px 网格列不匹配,
    //   单独一行更贴合 UX (画线姿势需要横向空间); 简洁模式隐藏时画布一并隐藏.
    const strokeCanvas = document.createElement("canvas");
    strokeCanvas.width = STROKE_CANVAS_W;
    strokeCanvas.height = STROKE_CANVAS_H;
    // 显示尺寸锁定 width:140px / height:70px + flex:none — 防高级折叠区 flex/grid 容器
    //   把 140×70 内部位图拉伸到 ~1320×640 (老板真机报障 2026-08-31: 占位文字放大 9 倍模糊发虚,
    //   画布占据卡片绝大部分). CSS 显示尺寸与内部位图尺寸严格一致, 配合下方
    //   _strokeCanvasPoint 的等比换算 (canvas.width/rect.width 等), 即使容器被强拉伸
    //   描线坐标仍精确映射到 140×70 内部位图.
    strokeCanvas.style.cssText = "display:block;width:140px;height:70px;flex:none;background:#1a1a1a;border:1px solid #555;border-radius:3px;cursor:crosshair;touch-action:none;";
    // getContext("2d") 在 jsdom 单元测试环境下可能返回 null; 走 _strokeCtx?. 守卫
    // 让 ESM 探针能在无 canvas 实现的环境下无错加载, 真实浏览器下走全功能
    const strokeCtx = strokeCanvas.getContext("2d");
    const _strokeCtxOK = !!strokeCtx;
    if (strokeCtx) {
        strokeCtx.strokeStyle = "#f0a040";  // 暖橙 — 在 #1a1a1a 深底上高对比
        strokeCtx.lineWidth = 2;             // 任务单"2px 左右"; 旧 1.5 偏细发虚
        strokeCtx.lineCap = "round";
        strokeCtx.lineJoin = "round";
    }
    const _strokeDrawPlaceholder = () => {
        if (!_strokeCtxOK) return;
        strokeCtx.clearRect(0, 0, STROKE_CANVAS_W, STROKE_CANVAS_H);
        strokeCtx.fillStyle = "#666";
        strokeCtx.font = "11px sans-serif";
        strokeCtx.textAlign = "center";
        strokeCtx.fillText("画线选运镜", STROKE_CANVAS_W / 2, STROKE_CANVAS_H / 2 + 4);
    };
    _strokeDrawPlaceholder();
    const strokeBox = document.createElement("label");
    strokeBox.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:none;";
    const strokeLab = document.createElement("span");
    strokeLab.textContent = "画线选运镜";
    strokeLab.style.cssText = "color:#9a9a9a;font-size:11px;display:flex;justify-content:space-between;align-items:center;";
    const strokeClearBtn = document.createElement("button");
    strokeClearBtn.type = "button";
    strokeClearBtn.textContent = "清除";
    strokeClearBtn.style.cssText = "padding:0 6px;font-size:10px;cursor:pointer;background:#2a2a2a;color:#bbb;border:1px solid #555;border-radius:2px;";
    strokeClearBtn.onclick = (ev) => {
        ev.stopPropagation();
        _strokeDrawPlaceholder();
        // V1.11 fix2: 连清运镜方式/方向下拉 — 用户识别过的填入不属于"画布笔迹",
        // 只清画布看着像没反应; 这里重置两个 select 为默认值 + dispatch change
        // 让既有联动链 (_refillMoveDirCtrls / schedulePreviewAll) 刷新。
        const moveSel = ctrls["运镜方式"];
        const dirSel = ctrls["运镜方向"];
        if (moveSel && moveSel.options && moveSel.options.length) {
            moveSel.selectedIndex = 0;
            moveSel.dispatchEvent(new Event("change"));
        }
        if (dirSel && dirSel.options && dirSel.options.length) {
            dirSel.selectedIndex = 0;
            dirSel.dispatchEvent(new Event("change"));
        }
    };
    strokeLab.appendChild(strokeClearBtn);
    strokeBox.appendChild(strokeLab);
    strokeBox.appendChild(strokeCanvas);
    advanced.appendChild(strokeBox);
    ctrls._strokeCanvas = strokeCanvas;

    // 笔迹采样状态 (每行独立, 闭包内)
    let strokePoints = [];
    let stroking = false;
    // pointer 事件坐标 → canvas 内部位图坐标 等比换算:
    //   即使 cssText 已锁定 width/height = 140px, 仍按 canvas.width/rect.width 比例式做兜底 —
    //   一旦未来 cssText 锁定失效或外部 transform 强制缩放, 此处仍能保证采样不越界 (140×70 内).
    //   (老板真机报障: 拉伸后直接 ev.clientX - rect.left 当内部坐标 → 采样点超出 140×70 位图,
    //   描线画不上. 此处乘以 内部位图尺寸 / CSS 显示尺寸 把 CSS 像素映射回内部位图像素.)
    const _strokeCanvasPoint = (ev) => {
        const rect = strokeCanvas.getBoundingClientRect();
        return {
            x: (ev.clientX - rect.left) * (strokeCanvas.width / rect.width),
            y: (ev.clientY - rect.top) * (strokeCanvas.height / rect.height),
        };
    };
    const _strokeStopEvt = (ev) => { ev.stopPropagation(); };
    strokeCanvas.addEventListener("pointerdown", (ev) => {
        _strokeStopEvt(ev);
        stroking = true;
        strokePoints = [_strokeCanvasPoint(ev)];
        if (_strokeCtxOK) {
            strokeCtx.clearRect(0, 0, STROKE_CANVAS_W, STROKE_CANVAS_H);
            strokeCtx.beginPath();
            strokeCtx.moveTo(strokePoints[0].x, strokePoints[0].y);
        }
    });
    strokeCanvas.addEventListener("pointermove", (ev) => {
        _strokeStopEvt(ev);
        if (!stroking) return;
        const p = _strokeCanvasPoint(ev);
        const last = strokePoints[strokePoints.length - 1];
        // 简单节流: 至少移动 1px 才采, 减少冗余点
        if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
        strokePoints.push(p);
        if (_strokeCtxOK) {
            strokeCtx.lineTo(p.x, p.y);
            strokeCtx.stroke();
        }
    });
    strokeCanvas.addEventListener("pointerup", (ev) => {
        _strokeStopEvt(ev);
        if (!stroking) return;
        stroking = false;
        const result = _recognizeStroke(strokePoints);
        strokePoints = [];
        if (!result) {
            // 短笔画: 视觉清空 + placeholder 恢复 (不动下拉)
            _strokeDrawPlaceholder();
            return;
        }
        // 填入运镜方式 → dispatch change 触发 _refillMoveDirCtrls 重建方向 options
        // → 再设运镜方向 → dispatch change 触发 schedulePreviewAll 预览刷新
        const moveSel = ctrls["运镜方式"];
        const dirSel = ctrls["运镜方向"];
        if (moveSel && result.move) {
            moveSel.value = result.move;
            moveSel.dispatchEvent(new Event("change"));
        }
        if (dirSel && result.dir) {
            dirSel.value = result.dir;
            dirSel.dispatchEvent(new Event("change"));
        }
    });
    strokeCanvas.addEventListener("pointercancel", (ev) => {
        _strokeStopEvt(ev);
        // 中断 → 清笔迹不识别 (符合"操作中断 = 取消"语义)
        stroking = false;
        strokePoints = [];
        _strokeDrawPlaceholder();
    });

    // V1.9 R-B1: line2 简洁部分 — 永远显示 (prompt + 段落时长 + 高级按钮 + 删除)
    const line2 = document.createElement("div");
    line2.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;";
    card.appendChild(line2);
    const prompt = document.createElement("textarea");
    prompt.rows = 4;
    prompt.placeholder = "可用 <Picture 1> <Video 2> <Audio 1> 引用素材";
    prompt.dataset.key = "prompt";
    prompt.style.cssText = "min-width:200px;width:100%;padding:2px 4px;box-sizing:border-box;resize:vertical;font:inherit;min-height:40px;max-height:400px;";  // V1.4 T6c: 拖拽调高(flex:1 会与纵向弹性打架压回高度, 移除; 宽度由 pCell 管)
    ctrls.prompt = prompt;
    prompt.addEventListener("input", schedulePreviewAll);   // 2.6: prompt 改动触发预览刷新
    const pCell = document.createElement("label");
    pCell.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1;min-width:200px;";
    const pLab = document.createElement("span");
    pLab.textContent = "prompt";
    pLab.style.cssText = "color:#9a9a9a;font-size:11px;";
    pCell.appendChild(pLab);
    pCell.appendChild(prompt);
    line2.appendChild(pCell);
    for (const key of ["段落时长"]) {
        const ctrl = document.createElement("input");
        ctrls[key] = ctrl;
        line2.appendChild(mkCell(key, ctrl, "70px"));  // line2 仍是 flex 行, 保持定宽
    }
    // V1.9 R-B1: 高级折叠按钮 — 简洁模式常显, 点击展开/收起 advanced 容器
    const advBtn = document.createElement("button");
    advBtn.type = "button";
    advBtn.textContent = "高级 ▾";
    advBtn.title = "展开/收起高级字段 (ID/九宫格/种子/导出文件名)";
    advBtn.style.cssText = "flex:none;padding:2px 8px;cursor:pointer;font-size:11px;align-self:flex-end;height:24px;";
    advBtn.onclick = () => {
        const hidden = advanced.style.display === "none";
        advanced.style.display = hidden ? "" : "none";
        advBtn.textContent = hidden ? "高级 ▴" : "高级 ▾";
    };
    ctrls._advBtn = advBtn;
    line2.appendChild(advBtn);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "删除此行";
    del.style.cssText = "flex:none;width:22px;cursor:pointer;";
    del.onclick = () => {
        const i = shotRows.indexOf(ctrls);
        if (i >= 0) shotRows.splice(i, 1);
        card.remove();
        // V1.10 批3 T3: 行数 -1 → 刷新 flatten 提示条显隐 (从 ≥5 落到 <5 自动隐藏)
        _updateFlattenHint();
    };
    line2.appendChild(del);

    // 2.6: 第三行 = 引擎最终发送文本预览 (只读, 服务端求值)
    const line3 = document.createElement("div");
    line3.style.cssText = "display:flex;align-items:flex-start;gap:6px;margin-top:6px;";
    const preCell = document.createElement("label");
    preCell.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1;min-width:200px;";
    const preLab = document.createElement("span");
    preLab.textContent = "最终提示词预览";
    preLab.style.cssText = "color:#9a9a9a;font-size:11px;";
    const pre = document.createElement("textarea");
    pre.rows = 4;
    pre.readOnly = true;
    pre.placeholder = "编辑分镜或全局提示词后, 此处实时显示最终发送的提示词(服务端求值); 空 = 引擎保持模板默认";
    pre.style.cssText = "min-width:200px;width:100%;padding:2px 4px;box-sizing:border-box;resize:vertical;font:inherit;background:rgba(0,0,0,.25);min-height:40px;max-height:400px;";  // V1.4 T6c: 预览同 prompt, 拖拽调高
    preCell.appendChild(preLab);
    preCell.appendChild(pre);
    // V1.4 T6: checks 提示区(errs 红 / warns 黄), 默认隐藏
    const checksEl = document.createElement("div");
    checksEl.style.cssText = "display:none;flex-direction:column;gap:2px;";
    preCell.appendChild(checksEl);
    line3.appendChild(preCell);
    card.appendChild(line3);
    ctrls._preview = pre;       // 预览框不进 dataset.key/collectData, 只作显示
    ctrls._checksEl = checksEl; // V1.4 T6: preview checks 渲染容器, 三态(有 errs/仅 warns/无)统一入口
    ctrls._pseq = 0;            // 过期响应守卫, 每行独立计数

    // V1.10 批2 T4: 审片门 — 分镜行徽标 (三态: 待审 h3-review-pending / 已通过 h3-review-approved / 已作废 h3-review-void)
    // + 裁决按钮 (通过 / 作废) — 仅 pending 行显示 (PRD 钉死, void 行只显示红徽标).
    // 行徽标 class 由 applyReviewBadges 维护, 默认隐藏.
    const reviewBadge = document.createElement("span");
    reviewBadge.style.cssText = "display:none;padding:2px 8px;font-size:11px;border-radius:10px;line-height:1.5;margin-right:6px;";
    reviewBadge.className = "h3-review-badge";
    reviewBadge.dataset.reviewBadge = "1";
    // V1.10 批2 T4: 裁决按钮 — 通过 / 作废, 默认隐藏, 仅 pending 行显示
    const reviewApprove = document.createElement("button");
    reviewApprove.type = "button";
    reviewApprove.textContent = "通过";
    reviewApprove.title = "标记此段为通过 (status=success + review=approved)";
    reviewApprove.style.cssText = "flex:none;padding:2px 8px;cursor:pointer;font-size:11px;display:none;height:24px;";
    reviewApprove.onclick = () => _reviewApproveRow(ctrls);
    const reviewVoid = document.createElement("button");
    reviewVoid.type = "button";
    reviewVoid.textContent = "作废";
    reviewVoid.title = "作废此段及后续已成功段 (级联作废, 引擎后续用新 seed 重跑)";
    reviewVoid.style.cssText = "flex:none;padding:2px 8px;cursor:pointer;font-size:11px;display:none;height:24px;color:#f88;";
    reviewVoid.onclick = () => _reviewVoidRow(ctrls);
    // 行徽标 + 裁决按钮挂在 line2 (与高级/删除同行, 简洁模式可见)
    line2.appendChild(reviewBadge);
    line2.appendChild(reviewApprove);
    line2.appendChild(reviewVoid);
    ctrls._reviewBadge = reviewBadge;
    ctrls._reviewApprove = reviewApprove;
    ctrls._reviewVoid = reviewVoid;

    // V1.9 R-B1: 按当前模式设初始显隐 (新行跟随当前 mode)
    const simpleInit = (getFormMode() === FORM_MODE_SIMPLE);
    advanced.style.display = simpleInit ? "none" : "";
    advBtn.style.display = simpleInit ? "" : "none";
    advBtn.textContent = simpleInit ? "高级 ▾" : "高级 ▴";

    shotRows.push(ctrls);
    return card;
}

// V1.10 批2 T4: 审片门 — 申请单行徽标三态 + 裁决按钮显隐.
//   review 取值: "approved" / "pending" / "void" / 缺省 (无 review 字段).
//   approved → 绿徽标无按钮; pending → 黄徽标 + 通过 + 作废; void → 红徽标无按钮 (PRD 钉死);
function _applyReviewBadges(shotRowsParam) {
    if (!shotRowsParam) shotRowsParam = shotRows;
    for (const ctrls of (shotRowsParam || [])) {
        if (!ctrls._reviewBadge) continue;
        // 当前 review 值 — 通过 ID 控件 + _reviewBadge 的 dataset.review 缓存避免重复 DOM 读
        // (ID 列即 sid, 与 manifest 段键一一对应 — 来自 T1/T2 端点契约).
        const sid = ((ctrls.ID && ctrls.ID.value) || "").trim();
        const review = ctrls._reviewState || "";  // 由轮询回调设值; 空 = 无 review 字段
        const badge = ctrls._reviewBadge;
        const apprBtn = ctrls._reviewApprove;
        const voidBtn = ctrls._reviewVoid;
        // 重置显示
        badge.style.display = "none";
        badge.className = "h3-review-badge";
        if (apprBtn) apprBtn.style.display = "none";
        if (voidBtn) voidBtn.style.display = "none";
        if (!sid) continue;  // 无 sid 不显示徽标 (新行还没填 ID)
        if (review === "pending") {
            badge.textContent = "待审";
            badge.className = "h3-review-badge h3-review-pending";
            badge.style.cssText = "display:inline-block;padding:2px 8px;font-size:11px;border-radius:10px;line-height:1.5;margin-right:6px;background:rgba(240,160,64,.18);color:#f0a040;border:1px solid #f0a040;";
            if (apprBtn) apprBtn.style.display = "";
            if (voidBtn) voidBtn.style.display = "";
        } else if (review === "approved") {
            badge.textContent = "已通过";
            badge.className = "h3-review-badge h3-review-approved";
            badge.style.cssText = "display:inline-block;padding:2px 8px;font-size:11px;border-radius:10px;line-height:1.5;margin-right:6px;background:rgba(96,200,120,.18);color:#60c878;border:1px solid #60c878;";
        } else if (review === "void") {
            badge.textContent = "已作废";
            badge.className = "h3-review-badge h3-review-void";
            badge.style.cssText = "display:inline-block;padding:2px 8px;font-size:11px;border-radius:10px;line-height:1.5;margin-right:6px;background:rgba(240,80,80,.18);color:#f05050;border:1px solid #f05050;";
        }
        // 缺省 (无 review 字段) → 不显示徽标不显示按钮 (与 PRD 钉死的 "非 pending/void 行无徽标无按钮" 一致)
    }
}

// V1.10 批2 T4: 通过 — POST /h3_batch/review/approve, 刷新徽标
async function _reviewApproveRow(ctrls) {
    const sid = ((ctrls.ID && ctrls.ID.value) || "").trim();
    if (!sid) { toast("warn", "H3 审片", "未填 ID, 无法裁决"); return; }
    const stem = _currentCsvStem();
    if (!stem) { toast("warn", "H3 审片", "未填 csv_path, 无法定位批次"); return; }
    const outDir = (current && current.widgets && current.widgets.get?.("server_output_dir") || "").trim();
    try {
        const resp = await api.fetchApi("/h3_batch/review/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stem, sid, output_dir: outDir }),
        });
        const j = await resp.json();
        if (!j.ok) {
            toast("error", "H3 审片", j.msg || j.error || "approve 失败");
            return;
        }
        ctrls._reviewState = "approved";
        _applyReviewBadges();
        toast("success", "H3 审片", "已通过: " + sid);
    } catch (e) {
        toast("error", "H3 审片", "请求失败: " + (e && e.message ? e.message : e));
    }
}

// V1.10 批3 T4b: 作废二选一确认浮层 (单例, ensureVoidChoiceDialog 内 if 已存在直接复用).
//   拼接模式: 三按钮 (仅重做本段 主推 / 作废到本段为止级联 N 段 / 取消).
//   分镜模式: 两按钮 (重做本段 / 取消) — 分镜段独立无级联.
//   沿用 form 内 panel 风格 (#2a2a2e 背景 + #666 边框) 居中浮于表单内.
//   关闭路径: 取消按钮 / 点遮罩 / 选完动作后自动关.
function ensureVoidChoiceDialog() {
    if (_voidChoiceDialogEl) return _voidChoiceDialogEl;
    const dlg = document.createElement("div");
    dlg.style.cssText = "display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10000;background:#2a2a2e;color:#e6e6e6;border:1px solid #666;border-radius:8px;padding:14px 16px;width:420px;max-width:92vw;font:13px/1.6 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);";
    const title = document.createElement("div");
    title.style.cssText = "font-size:14px;font-weight:700;margin-bottom:8px;";
    title.textContent = "作废此段";
    dlg.appendChild(title);
    const desc = document.createElement("div");
    desc.style.cssText = "color:#bbb;margin-bottom:12px;font-size:12px;line-height:1.6;";
    dlg.appendChild(desc);
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    dlg.appendChild(btns);
    // 点遮罩关闭 (用 mousedown 区分按钮 click, 防按钮事件冒泡立刻触发)
    const onBackdrop = (ev) => {
        if (ev.target === dlg) _closeVoidChoiceDialog();
    };
    dlg.addEventListener("mousedown", onBackdrop);
    dlg._titleEl = title;
    dlg._descEl = desc;
    dlg._btnsEl = btns;
    // 挂 overlay 居中浮层 (panel 之内); 退化: overlay 不在时挂 body
    if (typeof overlay !== "undefined" && overlay) {
        overlay.appendChild(dlg);
    } else if (typeof document !== "undefined" && document.body) {
        document.body.appendChild(dlg);
    }
    _voidChoiceDialogEl = dlg;
    return dlg;
}

// V1.10 批3 T4b: 关闭作废二选一浮层 (复位视觉 + 清按钮; state (_currentCtrls / _currentStem /
//   _currentOutDir) 由下次 _showVoidChoiceDialog 打开时覆盖 — 不在此处清, 否则按钮 onclick 内
//   "_closeVoidChoiceDialog(); _doVoidRequest(dlg._current*, ...)" 顺序求值会把 state 置 null,
//   导致 ctrls=null → _doVoidRequest 在 sid 守卫处早返, fetchApi 永远走不到).
function _closeVoidChoiceDialog() {
    if (!_voidChoiceDialogEl) return;
    _voidChoiceDialogEl.style.display = "none";
    _voidChoiceDialogEl._btnsEl.innerHTML = "";
}

// 1.14b U4a: 历史记录后处理弹窗 — 选 kinds (放大/插帧) → POST /h3_batch/postfx
//   弹窗复用 ensureVoidChoiceDialog (单例 DOM); 选哪个 button 决定 kinds 数组内容.
//   服务端 X5 防重 + 4 重防护, 失败响应带 ok:false + error 文案, 前端 toast 提示.
function _h3ShowPostfxDialog(taskId, onDone) {
    const dlg = ensureVoidChoiceDialog();
    dlg._btnsEl.innerHTML = "";
    dlg._titleEl.textContent = "后处理 (放大/插帧)";
    dlg._descEl.innerHTML = "<div>选择该历史任务要触发的后处理 (后台异步执行, 完成后写 manifest._postfx).</div>";
    const makeBtn = (label, kinds) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;"
            + "background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;margin-right:6px;";
        b.onclick = async () => {
            _closeVoidChoiceDialog();
            try {
                const r = await api.fetchApi("/h3_batch/postfx", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ task_id: taskId, kinds: kinds }),
                });
                const j = await r.json();
                if (j && j.ok) {
                    const folder = j.task_folder || "(无)";
                    toast("success", "H3 后处理", "已提交: " + (kinds.join("+"))
                        + ", 完成后在任务目录查看: " + folder);
                    // 1.14b U4b: 提交成功后启动轮询 — 每 3s 问 /h3_batch/postfx_status,
                    // running 转 false 时调 onDone (刷新历史徽标). 用代际令牌防竞态 (同
                    // _h3HistoryLoad 一致): 用户再次提交会顶掉旧轮询.
                    _startPostfxStatusPolling(taskId, onDone);
                } else {
                    toast("error", "H3 后处理", "提交失败: " + (j && j.error || "未知错误"));
                }
            } catch (ex) {
                toast("error", "H3 后处理", "请求异常: " + ex);
            }
        };
        dlg._btnsEl.appendChild(b);
    };
    makeBtn("仅放大", ["upscale"]);
    makeBtn("仅插帧", ["interp"]);
    makeBtn("放大+插帧", ["upscale", "interp"]);
    // 取消按钮
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a3a3e;color:#aaa;border:1px solid #555;border-radius:4px;";
    cancelBtn.onclick = () => _closeVoidChoiceDialog();
    dlg._btnsEl.appendChild(cancelBtn);
}

// 1.14b U4b: 后处理状态轮询 — 每 3s 问 /h3_batch/postfx_status, running 转 false 时调
// onDone 触发历史刷新 (新 manifest._postfx 已落盘). 用单一代际令牌防竞态: 同一 task_id
// 再提交 → 旧轮询停止, 新轮询接管; 不再泄漏 setInterval.
let _postfxPollingTimer = null;
let _postfxPollingTaskId = null;
function _startPostfxStatusPolling(taskId, onDone) {
    if (_postfxPollingTimer) {
        clearInterval(_postfxPollingTimer);
        _postfxPollingTimer = null;
    }
    _postfxPollingTaskId = taskId;
    const pollOnce = async () => {
        try {
            const resp = await api.fetchApi("/h3_batch/postfx_status", { cache: "no-store" });
            const data = await resp.json();
            if (data && data.ok && data.running === false) {
                // 空闲: 后处理已落 manifest, 停轮询 + 刷新历史
                if (_postfxPollingTimer) {
                    clearInterval(_postfxPollingTimer);
                    _postfxPollingTimer = null;
                }
                _postfxPollingTaskId = null;
                if (typeof onDone === "function") onDone();
            }
            // 运行中或异常 → 下一轮继续
        } catch (ex) {
            // 网络抖动: 不停轮询, 继续下一拍; 用户可手动刷新兜底
            console.warn("[H3] postfx_status 轮询异常:", ex);
        }
    };
    // 立即拍一次 + 每 3s 拍 (即时反馈 running 标志位已切)
    pollOnce();
    _postfxPollingTimer = setInterval(pollOnce, 3000);
}

// V1.10 批3 T4b: 显示作废二选一浮层, 按模式分支按钮.
//   拼接: 三按钮 (仅重做本段 主推 / 级联 / 取消).
//   分镜: 两按钮 (重做本段 / 取消).
//   cascadeN 为估算级联数 (含本段, 与后端 cascade_count 一致); 分镜模式不显示级联按钮.
function _showVoidChoiceDialog(ctrls, stem, outDir, cascadeN) {
    const dlg = ensureVoidChoiceDialog();
    const mode = (modeRadios.find((r) => r.checked) || {}).value;
    // 1.11b 波2 T6: 三档文案 — 拼接 / 自定义 / 分镜; 自定义档级联仅到下游连续勾选段, 独立段不受影响.
    const isConcat = mode === "拼接" || mode === "自定义";
    const isCustom = mode === "自定义";
    dlg._currentCtrls = ctrls;
    dlg._currentStem = stem;
    dlg._currentOutDir = outDir;
    // 重建按钮容器
    dlg._btnsEl.innerHTML = "";
    // 描述文案 (随模式分支)
    if (isCustom) {
        dlg._titleEl.textContent = "确认作废此段（自定义模式）";
        dlg._descEl.innerHTML =
            '<div>仅重做本段：其他段不动，本段换新种子重做。</div>' +
            '<div>级联作废其后 ' + Math.max(0, cascadeN - 1) + ' 段 (含本段共 ' + cascadeN + ' 段)：级联作废其后连续勾选段；独立段不受影响。</div>';
    } else if (isConcat) {
        dlg._titleEl.textContent = "确认作废此段（拼接模式）";
        dlg._descEl.innerHTML =
            '<div>仅重做本段：其他段不动，本段换新种子重做。</div>' +
            '<div>级联作废其后 ' + Math.max(0, cascadeN - 1) + ' 段 (含本段共 ' + cascadeN + ' 段)：本段及之后已生成段全部作废重做。</div>';
    } else {
        dlg._titleEl.textContent = "确认作废此段（分镜模式）";
        dlg._descEl.innerHTML =
            '<div>重做本段：仅本段换新种子重做，其他段不动（分镜段独立，无级联）。</div>';
    }
    // 按钮构建 helper
    const mkBtn = (text, primary, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.style.cssText = primary
            ? "padding:6px 12px;cursor:pointer;font-size:13px;background:#3a5a8a;color:#e6e6e6;border:1px solid #5a7aaa;border-radius:4px;"
            : "padding:6px 12px;cursor:pointer;font-size:13px;background:#1a1a1e;color:#bbb;border:1px solid #555;border-radius:4px;";
        b.onclick = onClick;
        return b;
    };
    // 主推: 仅重做本段 (solo) — 拼接与分镜都用此按钮, 但分镜也加 (与任务单一致: 分镜模式两按钮)
    const soloBtn = mkBtn(
        isConcat ? "仅重做本段" : "重做本段",
        true,
        () => { _closeVoidChoiceDialog(); _doVoidRequest(dlg._currentCtrls, dlg._currentStem, dlg._currentOutDir, true); }
    );
    dlg._btnsEl.appendChild(soloBtn);
    // 拼接模式才显示级联按钮
    if (isConcat) {
        const cascadeBtn = mkBtn(
            "作废到本段为止（级联 " + cascadeN + " 段）",
            false,
            () => { _closeVoidChoiceDialog(); _doVoidRequest(dlg._currentCtrls, dlg._currentStem, dlg._currentOutDir, false); }
        );
        dlg._btnsEl.appendChild(cascadeBtn);
    }
    // 取消 (始终最末)
    const cancelBtn = mkBtn("取消", false, () => { _closeVoidChoiceDialog(); });
    dlg._btnsEl.appendChild(cancelBtn);
    dlg.style.display = "block";
}

// V1.10 批3 T4b: 实际发出 void 请求 — solo 参数控制级联 / 单段.
//   solo=true → body {solo:true}; 响应形态 {ok, sid, solo}; 仅刷本行徽标, toast 区分单段文案.
//   solo=false → body 不传 solo (缺省 false 级联语义零变化); 响应含 voided + cascade_count;
//                沿用现有 voided 列表批量刷 + 级联 toast 文案.
async function _doVoidRequest(ctrls, stem, outDir, solo) {
    const sid = ((ctrls && ctrls.ID && ctrls.ID.value) || "").trim();
    if (!sid) { toast("warn", "H3 审片", "未填 ID, 无法裁决"); return; }
    if (!stem) { toast("warn", "H3 审片", "未填 csv_path, 无法定位批次"); return; }
    const body = { stem, sid, output_dir: outDir };
    if (solo) body.solo = true;
    try {
        const resp = await api.fetchApi("/h3_batch/review/void", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const j = await resp.json();
        if (!j.ok) {
            toast("error", "H3 审片", j.msg || j.error || "void 失败");
            return;
        }
        if (j.solo === true) {
            // 单段响应形态: 仅刷本行徽标
            for (const c of shotRows) {
                if (((c.ID && c.ID.value) || "").trim() === sid) {
                    c._reviewState = "void";
                }
            }
            _applyReviewBadges();
            toast("success", "H3 审片", "已作废本段（单段重做）");
        } else {
            // 级联响应形态: 沿用 voided 列表批量刷
            const voided = j.voided || [sid];
            for (const vSid of voided) {
                for (const c of shotRows) {
                    if (((c.ID && c.ID.value) || "").trim() === vSid) {
                        c._reviewState = "void";
                    }
                }
            }
            _applyReviewBadges();
            toast("success", "H3 审片", `已作废 ${voided.length} 段 (含本段)`);
        }
    } catch (e) {
        toast("error", "H3 审片", "请求失败: " + (e && e.message ? e.message : e));
    }
}

// V1.10 批3 T4b: 作废 (改造) — 先估算级联数 (按当前行及之后已生成段数, status=success 且 review 非 void 的行),
//   改弹自绘二选一浮层 (不再走浏览器原生 confirm) — 拼接三按钮 / 分镜两按钮.
//   选 solo → _doVoidRequest(..., true); 选级联 → _doVoidRequest(..., false).
async function _reviewVoidRow(ctrls) {
    const sid = ((ctrls.ID && ctrls.ID.value) || "").trim();
    if (!sid) { toast("warn", "H3 审片", "未填 ID, 无法裁决"); return; }
    const stem = _currentCsvStem();
    if (!stem) { toast("warn", "H3 审片", "未填 csv_path, 无法定位批次"); return; }
    // 估算级联: 当前行及之后 status=success 且 review 非 void 的行数 (含本行, 与 T3 cascade_count 含 target 对齐)
    const idx = shotRows.indexOf(ctrls);
    let cascadeN = 0;
    if (idx >= 0) {
        for (let i = idx; i < shotRows.length; i++) {
            const c = shotRows[i];
            const rs = c._reviewState;
            // 估算依赖 _reviewState (由轮询设值); 未轮到轮询的 success 行按"未裁决"算, 计入级联
            if (rs !== "void") cascadeN += 1;
        }
    }
    const outDir = (current && current.widgets && current.widgets.get?.("server_output_dir") || "").trim();
    _showVoidChoiceDialog(ctrls, stem, outDir, cascadeN);
}

// V1.10 批2 T4: 当前 csv_path 的 stem (CSV 文件名去后缀) — 与 T1/T3 端点契约一致
function _currentCsvStem() {
    const p = (current && current.widgets && current.widgets.get?.("csv_path") || "").trim();
    if (!p) return "";
    const base = p.split(/[\\/]/).pop() || "";
    return base.replace(/\.csv$/i, "");
}

// V1.10 批2 T4: 审片门 — 放行续跑 (POST /h3_batch/review/resume).
//   ok=true → toast "已放行" + 隐藏放行按钮 (轮询 status 会把 phase 拉成非暂停态, 按钮再自动隐藏);
//   ok=false → toast 显示后端 msg (如 "引擎未运行, 请重新提交批次任务(同 CSV) 以续跑" / "引擎未处于审片门暂停").
async function _reviewResumeBatch() {
    const stem = _currentCsvStem();
    if (!stem) { toast("warn", "H3 审片", "未填 csv_path, 无法定位批次"); return; }
    try {
        const resp = await api.fetchApi("/h3_batch/review/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stem }),
        });
        const j = await resp.json();
        if (!j.ok) {
            // 后端 msg 直接透传 (T3 已落: "引擎未运行" / "引擎未处于审片门暂停")
            toast("warn", "H3 审片", j.msg || j.error || "放行失败");
            return;
        }
        toast("success", "H3 审片", "已放行: 引擎继续跑剩余段");
        if (_reviewResumeBtn) _reviewResumeBtn.style.display = "none";
    } catch (e) {
        toast("error", "H3 审片", "请求失败: " + (e && e.message ? e.message : e));
    }
}

function applyModeSections() {
    const mode = (modeRadios.find((r) => r.checked) || {}).value;
    const queueMode = mode === "队列清单";
    // 队列清单模式: 隐藏 tab 栏 + 三个 tab pane, 显示队列区
    if (tabBar) tabBar.style.display = queueMode ? "none" : "";
    for (const sec of editSections) sec.style.display = queueMode ? "none" : "";
    queueSection.style.display = queueMode ? "" : "none";
    // 2026-09-03 fixround: 非队列分支恢复显示后重切回用户原本看的 tab (避免 applyModeSections
    //   把 6 个 pane 全显示后, 旧 pane 仍残留遮住 switchTab 单显的目标)
    if (!queueMode) {
        const order = ["pool", "global", "shot", "assets", "resources", "history"];
        if (order.indexOf(_h3ActiveTab) < 0) _h3ActiveTab = "pool";
        switchTab(_h3ActiveTab);
    }
    // 拼接模式 Picture 9 号槽是动态衔接槽: 保持可填(填图=第1段起点), 第2段起引擎自动用上一段尾帧
    // 1.11b 波2 T6: 自定义模式: 第 1 段起点可选, 仅勾选段自动=上一段尾帧 (独立段不受影响)
    if (pic9Input) {
        const ph = mode === "自定义" ? "第1段起点(可选); 勾选段自动=上一段尾帧"
                 : mode === "拼接"   ? "第1段起点(可选); 第2段起自动=上一段尾帧"
                 : "文件名 (含扩展名)";
        pic9Input.placeholder = ph;
    }
    // V1.10 批2 T4: 队列模式置灰 审片门 input — 引擎队列分支已禁用 _review_every_n, 前端同步置灰;
    //   dataset.key='审片门' 是 T4 通用 input 路径新增的标记 (其他通用 input 仍按下标对齐, 不动).
    for (const inp of globalInputs) {
        if (inp && inp.dataset && inp.dataset.key === "审片门") {
            inp.disabled = queueMode;
            inp.title = queueMode ? "队列模式不支持审片门" : "审片门 N=每 N 段插入一个审片点 (0=关闭, 引擎暂停等候裁决)";
        }
    }
    // V1.10 批3 T3: 模式切换 → 刷新 flatten 提示条显隐 (拼接 ≥5 才显, 切走立刻隐藏)
    _updateFlattenHint();
}

// V1.9 R-B1: 应用简洁/完整模式到所有已建分镜行 — 切换高级区显隐 + 高级按钮显隐
//   隐藏≠清空: 仅改 CSS display, 控件对象与 .value 全程保留 (collectData 照常读全部字段)
function applyFormMode() {
    const simple = (getFormMode() === FORM_MODE_SIMPLE);
    for (const ctrls of shotRows) {
        if (ctrls._advanced) ctrls._advanced.style.display = simple ? "none" : "";
        if (ctrls._advBtn)   ctrls._advBtn.style.display   = simple ? "" : "none";
    }
}

// 队列任务行: csv_path + 📁 / mode 可选可输 (datalist) / repeat 步进 + ➖➕ / ✕ 删除
function buildQueueRow() {
    const card = document.createElement("div");
    card.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;border:1px solid #555;border-radius:6px;padding:8px;margin-bottom:8px;background:rgba(255,255,255,.03);";

    const mkCell = (label, ctrl) => {
        ctrl.style.cssText += "padding:2px 4px;box-sizing:border-box;";
        const cell = document.createElement("label");
        cell.style.cssText = "display:flex;flex-direction:column;gap:2px;";
        const lab = document.createElement("span");
        lab.textContent = label;
        lab.style.cssText = "color:#9a9a9a;font-size:11px;";
        cell.appendChild(lab);
        cell.appendChild(ctrl);
        return cell;
    };

    const pathWrap = document.createElement("div");
    pathWrap.style.cssText = "display:flex;align-items:center;gap:2px;flex:1;min-width:220px;";
    const pathInput = document.createElement("input");
    pathInput.placeholder = "任务 CSV 路径";
    pathInput.style.cssText = "flex:1;min-width:0;";
    const pathBtn = document.createElement("button");
    pathBtn.textContent = "📁";
    pathBtn.type = "button";
    pathBtn.title = "浏览选择任务 CSV";
    pathBtn.style.cssText = "flex:none;padding:0 4px;cursor:pointer;";
    pathBtn.onclick = () => openPicker({
        kind: "file",
        exts: [".csv"],
        onPick: (p) => { pathInput.value = p; },
        nativePick: null,
        title: "选择任务 CSV",
        current: pathInput.value,
    });
    pathWrap.appendChild(pathInput);
    pathWrap.appendChild(pathBtn);
    card.appendChild(mkCell("csv_path", pathWrap));

    const modeList = document.createElement("datalist");
    modeList.id = "h3_queue_mode_list";
    modeList.appendChild(new Option("分镜", "分镜"));
    modeList.appendChild(new Option("拼接", "拼接"));
    if (!document.getElementById("h3_queue_mode_list")) document.body.appendChild(modeList);
    const modeInput = document.createElement("input");
    modeInput.setAttribute("list", "h3_queue_mode_list");
    modeInput.placeholder = "分镜 / 拼接";
    modeInput.style.width = "90px;";
    card.appendChild(mkCell("mode", modeInput));

    const repWrap = document.createElement("div");
    repWrap.style.cssText = "display:flex;align-items:center;gap:4px;";
    const minus = document.createElement("button");
    minus.textContent = "➖";
    minus.type = "button";
    minus.style.cssText = "width:26px;height:24px;cursor:pointer;";
    const repInput = document.createElement("input");
    repInput.type = "number";
    repInput.min = "1";
    repInput.max = "50";
    repInput.step = "1";
    repInput.value = "1";
    repInput.style.width = "64px;";
    const plus = document.createElement("button");
    plus.textContent = "➕";
    plus.type = "button";
    plus.style.cssText = "width:26px;height:24px;cursor:pointer;";
    const clampRep = (v) => { repInput.value = String(Math.max(1, Math.min(50, v || 1))); };
    minus.onclick = () => clampRep(parseInt(repInput.value, 10) - 1);
    plus.onclick = () => clampRep(parseInt(repInput.value, 10) + 1);
    repWrap.appendChild(minus);
    repWrap.appendChild(repInput);
    repWrap.appendChild(plus);
    card.appendChild(mkCell("repeat", repWrap));

    const ctrls = { csv_path: pathInput, mode: modeInput, repeat: repInput };
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "删除此行";
    del.style.cssText = "flex:none;width:22px;cursor:pointer;";
    del.onclick = () => {
        const i = queueRows.indexOf(ctrls);
        if (i >= 0) queueRows.splice(i, 1);
        card.remove();
    };
    card.appendChild(del);

    queueRows.push(ctrls);
    return card;
}

async function loadQueue(widgets) {
    const p = widgets.get?.("queue_path") || "";
    if (!p.toLowerCase().endsWith(".csv")) return;
    try {
        const r = await api.fetchApi("/h3_batch/queue_read?path=" + encodeURIComponent(p));
        const j = await r.json();
        if (j.error || j.text == null) return;
        const lines = String(j.text).split(/\r?\n/).filter((l) => l.trim());
        for (const line of lines) {
            const cols = parseCsvLine(line);
            if (cols[0].trim().toLowerCase() === "csv_path") continue; // 表头
            const rowEl = buildQueueRow();
            queueRowsEl.appendChild(rowEl);
            const ctrls = queueRows[queueRows.length - 1];
            ctrls.csv_path.value = (cols[0] || "").trim();
            ctrls.mode.value = (cols[1] || "").trim();
            const rep = parseInt(cols[2], 10);
            ctrls.repeat.value = String(Math.max(1, Math.min(50, rep || 1)));
        }
    } catch (e) { /* 队列读失败不阻断表单打开 */ }
}

async function generateQueue(btn) {
    const rows = queueRows.filter((c) => c.csv_path.value.trim());
    if (!rows.length) {
        // V1.10 批3 T3: 拦截文案升级 — 含下一步动作 (点 ➕ 加任务 / 📂 选择 CSV / 直接粘贴路径),
        // 旧版本简短指引用户看不出怎么填, 升级为可操作的下一步引导文案.
        statusEl.textContent = "请先点下方「➕ 加任务」建一行, 然后 📂 选择 CSV 路径 或直接粘贴路径, 再提交";
        return;
    }
    const lines = ["csv_path,mode,repeat"];
    for (const c of rows) {
        lines.push([csvEscape(c.csv_path.value.trim()), csvEscape(c.mode.value.trim() || "分镜"), Math.max(1, Math.min(50, parseInt(c.repeat.value, 10) || 1))].join(","));
    }
    btn.disabled = true;
    statusEl.textContent = "保存中...";
    try {
        const resp = await api.fetchApi("/h3_batch/save_queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: lines.join("\r\n") + "\r\n" }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const j = await resp.json();
        if (current && current.widgets?.set) {
            current.widgets.set("queue_path", j.path);
        }
        toast("success", "H3 表单", "队列已保存并加载: " + j.name);
        statusEl.textContent = "已保存: " + j.name;
        setTimeout(closeForm, 600);
    } catch (e) {
        statusEl.textContent = "保存失败: " + (e && e.message ? e.message : e);
    } finally {
        btn.disabled = false;
    }
}

function resetForm(clearPaths) {
    for (const key of POOL_KEYS) {
        // 清空文件名 + 缩略图
        if (poolInputs[key]) {
            poolInputs[key].forEach((inp) => {
                inp.value = "";
                if (inp._refreshThumb) inp._refreshThumb();
            });
        }
        // 清空多选用途 (Set 全部清空 + 胶囊视觉回退)
        if (poolUsageSets[key]) {
            poolUsageSets[key].forEach((set, i) => {
                set.clear();
                if (poolPillEls[key] && poolPillEls[key][i]) {
                    for (const pill of poolPillEls[key][i]) {
                        pill.style.cssText = "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;background:#1a1a1e;color:#aaa;border:1px solid #555;";
                    }
                }
            });
        }
    }
    globalInputs.forEach((inp) => { inp.value = ""; });
    // 批 A 后小迭代 (R5): 重置时三勾选恢复到默认不勾状态 (与引擎 _parse_global 缺键=关语义对齐)
    negativeSwitchEls.forEach((el) => { if (el) el.checked = false; });
    if (repeatInput) repeatInput.value = "";
    shotRowsEl.innerHTML = "";
    shotRows = [];
    queueRowsEl.innerHTML = "";
    queueRows = [];
    // 路径残留会让重开表单回读旧 CSV/队列, 重置必须连节点上的路径一起清空才真正生效
    if (clearPaths && current && current.node) {
        if (current.node._h3Path) {
            current.node._h3Path.set("csv_path", "");
            current.node._h3Path.set("queue_path", "");
        } else if (current.widgets) {
            for (const k of ["csv_path", "queue_path"]) {
                if (current.widgets[k]) current.widgets[k].value = "";
            }
            current.node.setDirtyCanvas?.(true, true);
        }
    }
    // V1.13 波2 D3: 重置表单必清 castBindings — 防止上一个节点的绑定泄漏到当前 CSV.
    // collectData 4210-4211 仅在 bindingsArr.length>0 时写 "角色绑定" 键, 清空后自然不写.
    castBindings = [];
    renderBindingsPanel();
}

function fillForm(existing) {
    if (!existing) {
        // V1.13 波2 D3: 早退前清 castBindings (避免上一个节点的绑定写进当前 CSV).
        // 与 resetForm 末尾行为对齐 — 两条"打开空表单"路径均归零 castBindings + 重渲面板.
        castBindings = [];
        renderBindingsPanel();
        return;
    }
    for (const key of POOL_KEYS) {
        const slots = (existing.pool && existing.pool[key]) || {};
        if (poolInputs[key]) {
            poolInputs[key].forEach((inp, i) => {
                inp.value = slots[String(i + 1)] || "";
                if (inp._refreshThumb) inp._refreshThumb();
            });
        }
        // V1.4 T6b: pool_usage 值恒 list, 旧数据 str 单值容错; 未知 id 静默丢弃
        const usages = (existing.pool_usage && existing.pool_usage[key]) || {};
        const allowedIds = USAGE_BY_KIND[key] || [];
        if (poolUsageSets[key]) {
            poolUsageSets[key].forEach((set, i) => {
                set.clear();
                const raw = usages[String(i + 1)];
                if (raw == null) return;
                const arr = Array.isArray(raw) ? raw : [raw];
                for (const id of arr) {
                    if (allowedIds.includes(id)) set.add(id);
                }
                // 1.14a T4: 回填该槽 pose 样式 (缺省 skeleton, 旧数据无 pool_pose_style 时落默认)
                const sty = ((existing.pool_pose_style
                              && existing.pool_pose_style[key]) || {})[String(i + 1)];
                setPoseStyle(i + 1, sty === "depth" ? "depth" : "skeleton");
                // 胶囊视觉同步 — 按 Set 状态重绘
                if (poolPillEls[key] && poolPillEls[key][i]) {
                    for (const pill of poolPillEls[key][i]) {
                        const on = set.has(pill.dataset.usageId);
                        pill.style.cssText = on
                            ? "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;background:rgba(240,160,64,.18);color:#f0a040;border:1px solid #f0a040;"
                            : "padding:2px 8px;font-size:11px;border-radius:10px;cursor:pointer;user-select:none;line-height:1.5;background:#1a1a1e;color:#aaa;border:1px solid #555;";
                    }
                }
            });
        }
        const extra = Object.keys(slots).filter((n) => +n > POOL_SLOTS[key] && (slots[n] || "").trim());
        if (extra.length) toast("warn", "H3 表单", key + "槽位超过 " + POOL_SLOTS[key] + " 个, 多余槽位未显示");
    }
    const globals = existing.globals || {};
    GLOBAL_INPUT_KEYS.forEach((key, i) => { if (globalInputs[i]) globalInputs[i].value = globals[key] || ""; });
    // 批 A 后小迭代: 三勾选回填 — 优先级: 新三键 > 旧 默认负面; 缺省 = 关 (与引擎 _parse_global 一致)
    //   新三键存在 → 按键值回填 (开→勾, 关→不勾; 缺→不勾)
    //   新三键全缺 + 旧 默认负面 存在 → 默认负面=开 → 三全勾; 默认负面=关 → 三全不勾
    //   新三键全缺 + 旧 默认负面 不存在 → 三全不勾 (与引擎 基线行为 字节对齐: 缺键=关)
    const any_new = NEGATIVE_TOGGLE_KEYS.some((k) => k in globals);
    if (any_new) {
        NEGATIVE_TOGGLE_KEYS.forEach((key, idx) => {
            const el = negativeSwitchEls[idx];
            if (el) {
                const v = globals[key];
                el.checked = (v !== undefined) && (v !== NEGATIVE_TOGGLE_VALUES.off);
            }
        });
    } else {
        const legacy = globals[DEFAULT_NEGATIVE_KEY];
        const all_on = (legacy !== undefined) && (legacy !== DEFAULT_NEGATIVE_VALUES.off);
        negativeSwitchEls.forEach((el) => { if (el) el.checked = all_on; });
    }
    // 批 H2-2: 回填绑定表 — globals["角色绑定"] 是 JSON 紧凑串
    // 批J补: /h3_batch/parse_csv 服务端把该键解析成**数组**返回(_parse_global :1463),
    //   JSON.parse(数组) 会因 String(数组)='[object Object]' 抛错被吞 → 绑定静默清空
    //   (用户实测: 生成 CSV 后重开表单面板必空)。双形态兼容: 数组直用/字符串再 parse。
    if (globals["角色绑定"]) {
        let raw = globals["角色绑定"];
        if (typeof raw === "string") {
            try { raw = JSON.parse(raw); } catch (e) { raw = []; }
        }
        castBindings = Array.isArray(raw) ? raw : [];
    } else {
        castBindings = [];
    }
    renderBindingsPanel();
    for (const shot of (existing.shots || [])) {
        const rowEl = buildShotRow();
        shotRowsEl.appendChild(rowEl);
        const ctrls = shotRows[shotRows.length - 1];
        for (const key of SHOT_KEYS) { if (ctrls[key]) ctrls[key].value = shot[key] || ""; }
        // 1.11b 波2 T6: checkbox 列按值恢复 .checked (N1) — 对 input[type=checkbox] 赋 .value
        //   不会改 .checked (DOM 行为), 必须独立设, 否则重开 CSV 勾选态全丢.
        const _flagCtrl = ctrls[CONCAT_FLAG_COL];
        if (_flagCtrl && _flagCtrl.type === "checkbox") {
            _flagCtrl.checked = (shot[CONCAT_FLAG_COL] || "").trim() === "是";
        }
    }
    // T3 返工 — fillForm 重建 shotRows 后刷新黄条: 覆盖三路径 (openForm 打开 CSV /
    //   AI 导入应用 / 撤销导入), 内部读 modeRadios + shotRows.length 一次即闭环.
    _updateFlattenHint();
}

function collectData() {
    const pool = {};
    const pool_usage = {};        // V1.4 T6b: 多选用途 → list[str]; 顺序按 USAGE_BY_KIND; 无选中不落键
    for (const key of POOL_KEYS) {
        const slots = {};
        if (poolInputs[key]) {
            poolInputs[key].forEach((inp, i) => {
                const v = inp.value.trim();
                if (v) slots[i + 1] = v;
            });
        }
        pool[key] = slots;
        if (poolUsageSets[key]) {
            const usageSlots = {};
            const allowedIds = USAGE_BY_KIND[key] || [];
            poolUsageSets[key].forEach((set, i) => {
                if (!set.size) return;
                // 按 USAGE_BY_KIND 顺序输出 (与 USAGE_REGISTRY kind 字段对齐, 引擎端解析稳定)
                const ids = allowedIds.filter((id) => set.has(id));
                if (ids.length) usageSlots[String(i + 1)] = ids;
            });
            if (Object.keys(usageSlots).length) pool_usage[key] = usageSlots;
        }
    }
    const globals = {};
    GLOBAL_INPUT_KEYS.forEach((key, i) => {
        const v = globalInputs[i] ? globalInputs[i].value.trim() : "";
        if (v) globals[key] = v;
    });
    // V1.11 批 2 T3c: 跑完自动拼接复选 → 写 "自动拼接" 键 (勾="自动" / 不勾="不拼").
    //   csv_gen 白名单 (批 1 T6) 仅接受 "自动"/"不拼", 脏值回落默认 "自动".
    if (autoConcatInput) globals["自动拼接"] = autoConcatInput.checked ? "自动" : "不拼";
    // 1.14b U3: 后处理三键 — 缺省不开 (X4: 仅拼接模式生效由引擎 _finalize_body 兜底)
    if (postfxUpscaleInput) globals["放大"] = postfxUpscaleInput.checked ? "开" : "关";
    if (postfxInterpInput) globals["插帧"] = postfxInterpInput.checked ? "开" : "关";
    if (postfxEngineSelect) globals["放大引擎"] = postfxEngineSelect.value || "seedvr2";
    // 批 H2-2: 角色绑定 — JSON 紧凑串 (空表不写键, 旧 CSV 零变化)
    const bindingsArr = readBindingsState();
    if (bindingsArr.length) globals["角色绑定"] = JSON.stringify(bindingsArr);
    // 批 A 后小迭代: 三勾选 — 写三行 (开/关), 永远写入 (便于 reload 回填状态)
    // 兼容 anchor: 当三勾选全 关 时, 也写 "默认负面,关" 行 (旧 CSV 兜底; 否则旧 CSV 导入视为全开, 矛盾)
    let all_three_off = true;
    NEGATIVE_TOGGLE_KEYS.forEach((key, idx) => {
        const el = negativeSwitchEls[idx];
        const on = el ? !!el.checked : false;
        globals[key] = on ? NEGATIVE_TOGGLE_VALUES.on : NEGATIVE_TOGGLE_VALUES.off;
        if (on) all_three_off = false;
    });
    if (all_three_off) {
        // 三全关 → 兼容 anchor: 写默认负面=关 (旧 CSV 导入时不会误判为全开)
        globals[DEFAULT_NEGATIVE_KEY] = DEFAULT_NEGATIVE_VALUES.off;
    } else {
        // 三键任一开 → 兼容 anchor: 也写默认负面=开 (旧 CSV 兼容语义保持)
        globals[DEFAULT_NEGATIVE_KEY] = DEFAULT_NEGATIVE_VALUES.on;
    }
    // 批次次数双写: 进 CSV 全局行 + 节点 repeat widget (V1.4 T6 已实现, 现 repeatInput 移至底部常驻)
    const rep = repeatInput ? parseInt(repeatInput.value, 10) : 0;
    if (rep >= 1) globals["批次次数"] = String(Math.min(50, rep));
    const shots = [];
    for (const ctrls of shotRows) {
        const rec = {};
        for (const key of SHOT_KEYS) { rec[key] = (ctrls[key]?.value || "").trim(); }
        if (!rec.ID && !rec.prompt) continue;
        shots.push(rec);
    }
    const mode = modeRadios.find((r) => r.checked);
    // 1.14a T4: 下发链扩 pool_pose_style (经 pool.js 导出读取, L6 状态单向归属 pool.js)
    const pool_pose_style = readPoolPoseStyles();
    return { mode: mode ? mode.value : "分镜", pool, pool_usage,
             pool_pose_style: { Picture: pool_pose_style }, globals, shots };
}

// V1.11 批 3 T2/T3: 表单配置快照序列化 — 与 T2 旁车 (<csv>.h3cfg.json) 和 T3 预设
// (presets/<name>.json) 共用一条代码路径. 返回与 collectData() 同构的对象 (含 mode);
// 后端原样存取, 不做字段映射. 用途:
//   - generate_csv POST body.config → 旁车; 引擎首次落盘并入 manifest._config
//   - presets POST body.config → 预设文件; 加载时回填 fillForm (与 AI 导入同通道)
function serializeFormConfig() {
    return collectData();
}

async function generate(btn) {
    if ((modeRadios.find((r) => r.checked) || {}).value === "队列清单") return generateQueue(btn);
    const data = collectData();
    if (!data.shots.length) {
        // V1.10 批3 T3: 拦截文案升级 — 含下一步动作 (点 ➕ 加分镜行 / 填 ID 与 prompt),
        // 旧版本简短指引用户看不出怎么填, 升级为可操作的下一步引导文案.
        statusEl.textContent = "请先点下方「➕ 加分镜行」建一行, 然后填 ID 与 prompt (任一非空即计入), 再提交";
        return;
    }
    btn.disabled = true;
    statusEl.textContent = "生成中...";
    try {
        // V1.4 T5+6: workflow 非空时加键, 后端产双 CSV (h3_batch_*_总提示词.txt)
        // 空模板路径不带键 → 回退 V1.3 单 CSV 路径(零回归)
        const wp = (current && current.widgets && current.widgets.get?.("workflow_path") || "").trim();
        const body = { mode: data.mode, data, config: serializeFormConfig() };
        if (wp) body.workflow = wp;
        const resp = await api.fetchApi("/h3_batch/generate_csv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const j = await resp.json();
        if (current) {
            if (current.node._h3Path) {
                current.node._h3Path.set("csv_path", j.path);
                current.node._h3Path.set("mode", data.mode);
                current.node._h3Path.set("repeat", Math.max(1, Math.min(50, parseInt(repeatInput.value, 10) || 1)));
            } else if (current.widgets && current.widgets["csv_path"]) {
                current.widgets["csv_path"].value = j.path;
                current.node.setDirtyCanvas?.(true, true);
            }
        }
        statusEl.textContent = "已生成: " + j.name;
        setTimeout(closeForm, 600);
    } catch (e) {
        statusEl.textContent = "生成失败: " + (e && e.message ? e.message : e);
    } finally {
        btn.disabled = false;
    }
}

// 2.6: 表单实时预览 —— 调度 + 单行抓取 + 过期守卫
function schedulePreviewAll() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { for (const c of shotRows) fetchPreview(c); }, PREVIEW_DEBOUNCE_MS);
}

// V1.4 T6: checks 渲染(每分镜行独立) — errs 红、warns 黄、空集/无键 → 隐藏
// V1.6 T1: "[时间轴] " 前缀消息加 "忽略" 小按钮 — 行内 Set (ctrls._ignored),
// 仅影响本行渲染, 不进任何请求/CSV, 会话级不落盘
function renderPreviewChecks(ctrls, checks) {
    if (!ctrls._checksEl) return;
    const el = ctrls._checksEl;
    if (!ctrls._ignored) ctrls._ignored = new Set();
    const ignored = ctrls._ignored;
    if (!checks || typeof checks !== "object") {
        el.innerHTML = "";
        el.style.display = "none";
        return;
    }
    const errs = (Array.isArray(checks.errs) ? checks.errs : []).filter((e) => !ignored.has(e));
    const warns = (Array.isArray(checks.warns) ? checks.warns : []).filter((w) => !ignored.has(w));
    if (!errs.length && !warns.length) {
        el.innerHTML = "";
        el.style.display = "none";
        return;
    }
    el.innerHTML = "";
    const _append = (msg, color, bg) => {
        const d = document.createElement("div");
        d.textContent = (color === "#d32f2f" ? "🔴 " : "🟡 ") + msg;
        d.style.cssText = "color:" + color + ";background:" + bg + ";padding:3px 6px;border-radius:3px;font-size:12px;line-height:1.5;display:flex;align-items:center;gap:6px;";
        if (msg.startsWith("[时间轴] ")) {
            const btn = document.createElement("button");
            btn.textContent = "忽略";
            btn.style.cssText = "background:none;border:1px solid " + color + ";color:" + color + ";cursor:pointer;padding:2px 8px;border-radius:3px;font-size:11px;";
            btn.onclick = () => { ignored.add(msg); renderPreviewChecks(ctrls, checks); };
            d.appendChild(btn);
        }
        el.appendChild(d);
    };
    for (const e of errs) _append(e, "#d32f2f", "rgba(211,47,47,.12)");
    for (const w of warns) _append(w, "#f9a825", "rgba(249,168,37,.12)");
    el.style.display = "flex";
}

async function fetchPreview(ctrls) {
    const seq = ++ctrls._pseq;                          // 最新响应胜出, 过期不覆盖
    const row = {};
    for (const key of SHOT_KEYS) row[key] = (ctrls[key] && ctrls[key].value || "").trim();
    const global = (globalPromptTa && globalPromptTa.value || "").trim();
    // 2.9: 语言 select 当前值加入 body(空=中文)
    const langIdx = GLOBAL_INPUT_KEYS.indexOf("语言");
    const langEl = (langIdx >= 0) ? globalInputs[langIdx] : null;
    const lang = (langEl ? (langEl.value || "").trim() : "");
    const mode = (modeRadios.find((r) => r.checked) || {}).value || "分镜";
    // 队列清单模式不实时预览(保持 2.6 现状)
    if (mode === "队列清单") return;
    // V1.4 T6: 请求体扩七字段 — pool/pool_usage/seg_index/prev_available/mode/workflow
    // collectData() 已收集全表单状态, 复用同源数据防止后续字段漏定义
    // 批 H2-3: 透传 bindings 给预览端点, 走与执行同源三档在场集+名字替换
    const collected = collectData();
    const { pool, pool_usage } = collected;
    const segIndex = shotRows.indexOf(ctrls);
    // 1.11b 波2 T6: 自定义模式按行判定 — 行内勾选 (ctrls[CONCAT_FLAG_COL].value === "是") 才生效;
    //   未勾选段按分镜语义出图 (无 prev). 分镜/拼接模式行为不变 (拼接模式: 全部段均为 prevAvailable).
    const rowIsConcat = mode === "自定义" && !!(ctrls[CONCAT_FLAG_COL] && ctrls[CONCAT_FLAG_COL].value === "是");
    const prevAvailable = !!((mode === "拼接" || rowIsConcat) && segIndex > 0);
    const workflowPath = (current && current.widgets && current.widgets.get?.("workflow_path") || "").trim();
    // 1.13e: 预览端点批级池检查需 input_dir 解析素材路径 (缺省时服务端回落默认目录)
    const inputDir = (current && current.widgets && current.widgets.get?.("input_dir") || "").trim();
    const body = { row, global, lang, mode, pool, pool_usage,
                   seg_index: segIndex, prev_available: prevAvailable, input_dir: inputDir };
    const bindingsList = readBindingsState();
    if (bindingsList.length) body.bindings = bindingsList;
    if (workflowPath) body.workflow = workflowPath;
    // Task 1 B2: 默认负面开关状态透传预览端点(走与 CSV 同源开关; 缺省=开)
    // 批 A 后小迭代: 三勾选 — body 三键优先; 旧 negative 兼容(端点内部三键全 False 且 negative=true → 三全勾)
    body.negative_music = !!(negativeSwitchEls[0] && negativeSwitchEls[0].checked);
    body.negative_dialogue = !!(negativeSwitchEls[1] && negativeSwitchEls[1].checked);
    body.negative_text = !!(negativeSwitchEls[2] && negativeSwitchEls[2].checked);
    const any_negative = body.negative_music || body.negative_dialogue || body.negative_text;
    body.negative = any_negative;  // 兼容旧调用方
    // T2: 配乐/氛围声 — 仅输入非空时构造 audio 二元组, 全空则不传 audio 键(端点缺省=现状逐字节一致)
    const musicVal = (globalInputs[GLOBAL_INPUT_KEYS.indexOf("配乐")] || {}).value || "";
    const ambVal = (globalInputs[GLOBAL_INPUT_KEYS.indexOf("氛围声")] || {}).value || "";
    const audioPairs = [];
    if (musicVal.trim()) audioPairs.push(["配乐", musicVal.trim()]);
    if (ambVal.trim()) audioPairs.push(["氛围声", ambVal.trim()]);
    if (audioPairs.length) body.audio = audioPairs;
    try {
        const resp = await api.fetchApi("/h3_batch/preview_prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const j = await resp.json();
        if (seq !== ctrls._pseq) return;
        ctrls._preview.value = j.text || "";
        // V1.4 T6: checks 三态渲染; 老后端响应无 j.checks 走 null 分支(隐藏, 零干扰)
        renderPreviewChecks(ctrls, j.checks);
    } catch (e) {
        if (seq !== ctrls._pseq) return;
        ctrls._preview.value = "⚠ 预览不可用(" + (e && e.message ? e.message : e) + "): 生成 CSV 不受影响; 刚部署时重启 ComfyUI 后生效";
        renderPreviewChecks(ctrls, null);
    }
}

// ============================================================================
// 5. openForm / closeForm
// ============================================================================

async function openForm(node, widgets) {
    ensureOverlay();
    statusEl.textContent = "加载中...";
    // 模式自动判定: queue_path 指向 .csv 即队列模式
    const isQueue = /\.csv$/i.test((widgets.get?.("queue_path") || "").trim());
    const [vocab, existing] = await Promise.all([loadVocab(), isQueue ? Promise.resolve(null) : loadExisting(widgets)]);
    VOCAB = vocab;
    current = { node, widgets };
    resetForm();
    // 模式初始状态: queue_path 指向 .csv 选队列页签, 否则跟节点 mode
    const modeVal = isQueue ? "队列清单" : widgets.get?.("mode");
    for (const r of modeRadios) r.checked = r.value === modeVal;
    if (!modeRadios.some((r) => r.checked)) modeRadios[0].checked = true;
    applyModeSections();
    if (isQueue) {
        repeatInput.value = String(widgets.get?.("repeat") || "");
        await loadQueue(widgets);
        if (queueRows.length === 0) queueRowsEl.appendChild(buildQueueRow());
        const name = (widgets.get?.("queue_path") || "").split(/[\\/]/).pop();
        statusEl.textContent = name ? "已加载: " + name : "";
    } else {
        // 回填: CSV 全局行写了批次次数优先, 否则用节点 repeat
        const csvRep = (existing && existing.globals && existing.globals["批次次数"]) || "";
        repeatInput.value = String(csvRep || widgets.get?.("repeat") || "");
        fillForm(existing);
        if (shotRows.length === 0) shotRowsEl.appendChild(buildShotRow());
        // 1.11b 波2 T5b 返工: openForm 首次 append 可能落在自定义模式, 必须立即刷勾选框显隐
        _refreshConcatFlagVisibility();
        if (existing) {
            const name = (widgets.get?.("csv_path") || "").split(/[\\/]/).pop();
            statusEl.textContent = "已加载: " + name;
        } else {
            statusEl.textContent = "";
        }
        schedulePreviewAll();   // 2.6: 回填后立显, 不必等下次编辑
        // 默认激活素材池 tab (队列模式时 tabBar 隐藏, 无副作用)
        switchTab("pool");
    }
    // Task 5: 异步加载资产库 (失败容错 — renderAssetList 显示错误行, 不阻断表单)
    loadAssets();
    // V1.9 批 2 T2.4 R1: 异步加载资源编排 (含后端 template_loras 发现 + widget 回填)
    // 失败容错 — 空列表显示, 不阻断表单打开; UI 资源面板已挂载, 仅缺数据
    // 沙箱拼接测试 (test_rb1_simple_mode) 不含 resources.js → 函数可能未定义, 走降级路径
    if (typeof initResourcesPanel === "function") {
        const wfPath = (widgets.get?.("workflow_path") || "").trim();
        const widgetText = widgets.get?.("resources_list") || "[]";
        try { await initResourcesPanel({ node, widgets }, wfPath, widgetText); }
        catch (_) { /* 容错 — 资源面板保留空列表状态 */ }
    }
    // V1.10 批2 T4: 审片门 — 表单 overlay 打开且非队列模式时, 启动 3s 轮询 status 端点;
    //   响应 shots[sid].review → 写 _reviewState, 触发 _applyReviewBadges 刷新徽标 + 按钮;
    //   phase==="审片门暂停" → 显示放行续跑按钮. 失败静默 (徽标保持现状).
    //   csv_path 空/非 .csv → 不启动 (无 manifest 可轮询).
    //   重开先清旧 (单例 timer 变量, 防重复并发轮询).
    // V1.10 批2 T5: 审片门 — manifest 缺失防呆提示. tick 内 noManifest 判定
    //   (响应无 total 键 + shots 为空对象 = status 端点对未生成 manifest 的批次返 {running:false,shots:{}}),
    //   命中时显示灰黄提示; 否则隐藏. closeForm 复位 display="none" 防重开闪现.
    ensureReviewNotice();  // 单例 — openForm 重复调用不堆积 DOM
    ensureRerunVoidHint();  // V1.10 批3 T4b: P2 重跑作废段引导 — 单例 — openForm 重复调用不堆积 DOM
    const csvPath = (widgets.get?.("csv_path") || "").trim();
    const isCsv = /\.csv$/i.test(csvPath);
    if (!isQueue && isCsv) {
        if (_reviewPollTimer) { clearInterval(_reviewPollTimer); _reviewPollTimer = null; }
        const stem = _currentCsvStem();
        const outDir = (widgets.get?.("server_output_dir") || "").trim();
        const pollUrl = `/h3_batch/status?output_dir=${encodeURIComponent(outDir)}&stem=${encodeURIComponent(stem)}`;
        const tick = async () => {
            try {
                const resp = await api.fetchApi(pollUrl, { cache: "no-store" });
                const data = await resp.json();
                if (data && data.shots) {
                    // V1.10 批2 T5: manifest 不存在 = 响应无 total 键 + shots 空对象 (status 端点 fallback).
                    //   命中显示黄条提示; 否则隐藏. 注: shots 非空但无 review 字段的正常态 (有 total 键)
                    //   不进 noManifest 分支 — 公式含 !("total" in data) 守卫.
                    const noManifest = !("total" in data) && data.shots && Object.keys(data.shots).length === 0;
                    if (_reviewNoticeEl) {
                        _reviewNoticeEl.style.display = noManifest ? "" : "none";
                    }
                    let pendingSeen = false;
                    for (const ctrls of shotRows) {
                        const sid = ((ctrls.ID && ctrls.ID.value) || "").trim();
                        if (!sid) continue;
                        const info = data.shots[sid];
                        if (info && typeof info === "object" && "review" in info) {
                            ctrls._reviewState = info.review;
                            if (info.review === "pending") pendingSeen = true;
                        }
                    }
                    _applyReviewBadges();
                    if (_reviewResumeBtn) {
                        const isPaused = data.phase === "审片门暂停";
                        _reviewResumeBtn.style.display = isPaused ? "" : "none";
                        if (isPaused && pendingSeen) {
                            _reviewResumeBtn.title = "引擎处于审片门暂停, 有 " + shotRows.filter((c) => c._reviewState === "pending").length + " 段待裁决";
                        } else if (isPaused) {
                            _reviewResumeBtn.title = "引擎处于审片门暂停, 点此放行续跑";
                        } else {
                            _reviewResumeBtn.title = "POST /h3_batch/review/resume — 引擎解除审片门暂停, 继续跑剩余段";
                        }
                    }
                    // V1.10 批3 T4b: P2 重跑作废段引导 — running===false 且 void 段≥1 才显示; 否则隐藏.
                    _updateRerunVoidHint(data);
                }
            } catch (_e) {
                // 失败静默 — 徽标保持现状 (PRD 钉死)
            }
        };
        // 立即跑一次 + 3s 间隔
        tick();
        _reviewPollTimer = setInterval(tick, 3 * 1000);
    } else if (_reviewPollTimer) {
        // 队列模式: 清旧轮询, 隐藏放行按钮 (队列分支引擎禁用 _review_every_n, 不可能暂停)
        clearInterval(_reviewPollTimer);
        _reviewPollTimer = null;
        if (_reviewResumeBtn) _reviewResumeBtn.style.display = "none";
    }
    overlay.style.display = "flex";
}

function closeForm() {
    if (!overlay) return;
    // 清 previewTimer (setTimeout 400ms 防抖) — 防反复开关表单后定时器泄漏
    // (批3 审核: 关闭前已 schedule 的 fetchPreview 仍会触发已隐藏表单)
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    // V1.10 批2 T4: 清审片门轮询 — 同 closeForm 路径 (开→关 一处清, 防 setInterval 句柄泄漏)
    if (_reviewPollTimer) { clearInterval(_reviewPollTimer); _reviewPollTimer = null; }
    // V1.10 批2 T5: 复位 manifest 缺失提示 — 防重开闪现 (tick 重跑一次才会再点亮, 避免视觉残留)
    if (_reviewNoticeEl) { _reviewNoticeEl.style.display = "none"; }
    // V1.10 批3 T4b: 复位 P2 重跑作废段提示 — 防重开闪现 (tick 重跑一次才会再点亮, 避免视觉残留)
    if (_rerunVoidHintEl) { _rerunVoidHintEl.style.display = "none"; }
    // V1.10 批3 T4b: 关闭作废二选一浮层 — 防重开表单时旧浮层仍在
    _closeVoidChoiceDialog();
    // 2026-09-03 fixround: 清理重跑轮询定时器 — 防 setTimeout 句柄泄漏
    if (_h3RerunPoll && _h3RerunPoll.timer) { clearTimeout(_h3RerunPoll.timer); }
    _h3RerunPoll = null;
    // 2026-09-03 fixround: 清理改词重跑轮询定时器 — closeForm 同通道, 防 deadef5 后句柄泄漏
    if (_h3PollStatusTimer) { clearTimeout(_h3PollStatusTimer); _h3PollStatusTimer = null; }
    // 交付前审查 FE-P0-3: 自增代际令牌 → 所有在飞 tick 立即失效 (孤儿 tick 不会复活)
    _h3PollToken++;
    // 交付前审查 FE-P2-1: 重置历史/回收站懒加载标志 — 重开表单时强制重新拉, 不显示旧数据.
    // 注意: _h3RerunSel 勾选状态保留 (硬约束: 不动勾选保留语义).
    _historyLoaded = false;
    _h3TrashLoaded = false;
    overlay.style.display = "none";
}

// ============================================================================
// 6. T8 批3 (任务⑤): v3 卡 payload 构建 — form 行 → {name, card:_v=3,rows:[...]}
// 全空行 (usage+media+desc 全空) 静默丢弃; media 空但有 usage/desc 的行保留, slot 默认 "1".
// 任务单中归 assets 域, 但 buildV3ArchiveForm 在 assets 调用, 且 collectData 也在 main 调用 —
//  为消除 pool→assets 与 main→assets 的循环 (确保 assets 不反向被 main 调用),
//  实测仅 main.js 触发, 故归 main.js; assets.js 中通过 import 复用。
// ============================================================================

function buildV3CardPayload(formRows, name, kind) {
    const rows = [];
    for (const row of (formRows || [])) {
        const usage = (row && row.usage || "").toString();
        const media = (row && row.media || "").toString();
        const slot = ((row && row.slot) || "1").toString();
        const desc = (row && row.desc || "").toString();
        // 全空行 静默丢弃
        if (!usage && !media.trim() && !desc.trim()) continue;
        rows.push({ usage: usage, media: media, slot: slot, desc: desc });
    }
    const card = { _v: 3, label: name, kind: kind, rows: rows };
    return { name: name, card: card };
}

// ============================================================================
// 7. snapshotFormState / applyStateToFormDOM (T3 分配器 DOM 薄封装)
//   任务单中归 main 域; assets.js 通过 import 复用
// ============================================================================

function snapshotFormState() {
    const pool = { Picture: {}, Video: {}, Audio: {} };
    const pool_usage = { Picture: {}, Video: {}, Audio: {} };
    for (const k of POOL_KEYS) {
        const inputs = poolInputs[k] || [];
        for (let i = 0; i < inputs.length; i++) {
            const v = (inputs[i].value || "").trim();
            if (v) pool[k][String(i + 1)] = v;
            const set = poolUsageSets[k] && poolUsageSets[k][i];
            if (set && set.size) pool_usage[k][String(i + 1)] = Array.from(set);
        }
    }
    return { pool: pool, pool_usage: pool_usage, globalPrompt: (globalPromptTa && globalPromptTa.value) || "" };
}

function applyStateToFormDOM(name, result) {
    for (const f of result.filled) {
        const inp = poolInputs[f.kind] && poolInputs[f.kind][f.idx - 1];
        if (!inp) continue;
        inp.value = f.value;
        if (inp._refreshThumb) inp._refreshThumb();
        const set = poolUsageSets[f.kind] && poolUsageSets[f.kind][f.idx - 1];
        const pills = poolPillEls[f.kind] && poolPillEls[f.kind][f.idx - 1];
        if (set) {
            // 1.14a T5: 分配器姿势互斥 (决策 2 延伸, L1c 行为声明)
            //   uid==="pose" → usageSet.clear() 姿势独占 (与池面板手动勾选一致)
            //   非 pose → usageSet.delete("pose") 反向摘姿势
            //   非姿势用途间原叠加语义保留
            for (const u of f.usages) {
                if (u === "pose") {
                    set.clear();
                    set.add("pose");
                    // 1.14a T5: 反查档案库卡 pose_style — 找不到兜底 skeleton
                    const sty = lookupCardPoseStyle(f.value);
                    setPoseStyle(f.idx, sty || "skeleton");
                } else {
                    set.delete("pose");
                    set.add(u);
                }
            }
            if (pills) syncPillsVisual(pills, set);
        }
    }
    // G3: 自动顺延反馈 — 存在 idx !== target → toast "已分配 name: 用途→槽N"
    const fellThrough = (result.filled || []).filter((f) => f.idx !== f.target);
    if (fellThrough.length) {
        const desc = fellThrough.map((f) => {
            const opt = (typeof USAGE_OPTIONS !== "undefined" ? USAGE_OPTIONS : []).find((o) => o.id === (f.usages && f.usages[0]));
            const label = opt ? opt.label : (f.usages && f.usages[0]) || "?";
            return label + "→槽" + f.idx;
        }).join(", ");
        toast("info", "H3 资产", "已分配 " + name + ": " + desc);
    }
    if (result.skipped.length) {
        const slotsDesc = result.skipped.map((s) => s.kind + " 槽 " + s.target).join("、");
        toast("warn", "H3 资产", "分配 " + name + ": 跳过 " + slotsDesc + " (已被占用, 点旁「覆盖」按钮替换)");
        for (const s of result.skipped) attachOverrideButton(s.kind, s.target, s.value, s.usages, name);
    }
    if (result.globalPrompt && globalPromptTa && result.globalPrompt !== globalPromptTa.value) {
        globalPromptTa.value = result.globalPrompt;
        schedulePreviewAll();
    }
    // 批 H2-2 C3: 绑定建立 — character 卡分配成功 → upsertBinding
    // 同名卡再分配 (v1.1.1): 更新原 slots, 保 no
    // I-⑤ fix: 此块必须在上面 result.globalPrompt 回写之后执行 — upsert 内的
    // injectSubjectLine 写入 <Subject N> 行, 若先注入再回写, 旧快照会把刚注入的行覆盖掉
    try {
        const card = assetsByName && assetsByName[name];
        if (card && card._v === 3 && card.kind === "character"
            && (result.filled || []).length) {
            const slotsSnap = snapshotBindingSlotsFromResult(name, result.filled || []);
            if (slotsSnap.length) {
                const wasBound = castBindings.some((b) => b && b.name === name);
                upsertBindingFromCard(name, slotsSnap);
                invalidateCastBlockCache(name);
                if (!wasBound) {
                    const newEntry = castBindings.find((b) => b && b.name === name);
                    const sbj = newEntry && newEntry.no;
                    toast("success", "H3 绑定",
                          "已绑定 " + name + " = Subject " + sbj +
                          ", prompt 中写它的名字即可驱动");
                }
                // I-⑤: 注入 Subject 行改变了全局提示词 → 刷新预览 (分配是显式动作, 非 C6 键击场景)
                schedulePreviewAll();
            }
        }
    } catch (e) {
        // 绑定建立容错 — 不阻断分配主链路
    }
}

// ============================================================================
// 8. 跨域导出 — 供 pool/assets/bindings.js 拉取
// ============================================================================

// 跨域共享 (state + utils)
export {
    POOL_KEYS, POOL_SLOTS, POOL_EXTS,
    GLOBAL_KEYS, GLOBAL_INPUT_KEYS, SHOT_KEYS, SHOT_VOCAB_KEYS,
    NEGATIVE_TOGGLE_KEYS, NEGATIVE_TOGGLE_VALUES, DEFAULT_NEGATIVE_KEY, DEFAULT_NEGATIVE_VALUES,
    FORM_MODE_KEY, FORM_MODE_SIMPLE, FORM_MODE_FULL,
USAGE_OPTIONS, USAGE_BY_KIND, USAGE_SHORT_LABEL, _USAGE_KIND,
    // _H3_SEG_*_ZH 声明在 bindings.js (composeSubjectLineZh 唯一消费点, 避免 main↔bindings 循环)
};

// 跨域共享 utils
export {
    toast, csvEscape, parseCsvLine, sectionBox, h3ComputeRectFromDrag,
    syncPillsVisual, onBindingSlotCleared,
    cascadeIncrements, applyCascadeToBlankRows,
    buildV3CardPayload, snapshotFormState, applyStateToFormDOM,
};

// 跨域共享 functions
export {
    getFormMode, setFormMode,
    loadVocab, loadExisting, ensureMediaInLibrary,
    switchTab, ensureOverlay,
    buildGlobalSection, buildAiSection,
    buildShotSection, buildShotRow,
    applyModeSections, applyFormMode,
    buildQueueRow, loadQueue, generateQueue,
    resetForm, fillForm, collectData, generate, serializeFormConfig,
    schedulePreviewAll, renderPreviewChecks, fetchPreview,
    openForm, closeForm,
};

// ============================================================================
// V1.9 D1 修复: 域文件写入共享状态的 setter（ESM import 绑定只读, 域文件经此写入）
// ============================================================================
export function setPic9Input(v) { pic9Input = v; }
export function setAssetsListEl(v) { assetsListEl = v; }
export function setAssetsListErrEl(v) { assetsListErrEl = v; }
export function setAssignRoleSelect(v) { assignRoleSelect = v; }
export function setAssignSceneSelect(v) { assignSceneSelect = v; }
export function setAssetsByName(v) { assetsByName = v; }
export function setEditingCard(v) { editingCard = v; }
export function setEditArchiveHandler(v) { editArchiveHandler = v; }
export function setCastBindings(v) { castBindings = v; }
export function setCastBindingsPanelEl(v) { castBindingsPanelEl = v; }
