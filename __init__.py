from .imageplus_inspector_backend import (
    ImagePlusInspectorNode,
    ImagePlusPromptNode,
    ImagePlusKSamplerAdvNode,
)

NODE_CLASS_MAPPINGS = {
    "ImagePlusInspectorNode": ImagePlusInspectorNode,
    "ImagePlusPromptNode": ImagePlusPromptNode,
    "ImagePlusKSamplerAdvNode": ImagePlusKSamplerAdvNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImagePlusInspectorNode": "ImagePlus Inspector",
    "ImagePlusPromptNode": "ImagePlus Prompt",
    "ImagePlusKSamplerAdvNode": "ImagePlus KSampler Adv",
}

WEB_DIRECTORY = "./js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
