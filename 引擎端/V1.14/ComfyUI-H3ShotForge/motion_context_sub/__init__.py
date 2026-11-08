"""H3 Motion Context 节点包:latent 续接家族节点 + 两个 ComfyUI patch。

- patch_layout:解除 stock PackedLayout 的 keyframe 仅 first/last 限制,
  支持中间帧锚点(M2)
- patch_payload:修复 stock extra_conds 的 refs 覆盖 keyframes bug,
  使钉住画面与钉住音频可共存(M3)

两个 patch 都在节点首次运行时安装(惰性),不是 import 时:ComfyUI 在启动
时 import 每个 custom_nodes 目录,那时安装会把包装放进这台机器上的每个
H3 图;首次使用时安装则装有本包之前,行为与 stock 完全一致。安装前各
patch 先对当前 ComfyUI 代码自检,失败即拒绝安装并让依赖节点报明确错误。

4 个节点: H3MotionContext / H3MotionContextTrim / H3MotionContextSaveLatent /
H3MotionContextLoadLatent,定义见 .nodes。
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
