# ComfyUI ImagePlus

A ComfyUI custom node pack for inspecting AI images from CivitAI or local files.

ImagePlus Inspector provides a single combined image inspection node with:

- CivitAI gallery browsing
- CivitAI URL fetch
- local image upload
- local image drag/drop
- image preview
- selected image dimension display
- filtered metadata display
- raw metadata display
- prompt extraction
- open image action
- copy URL action

It also includes a separate ImagePlus Prompt node for users who want an editable prompt node with direct conditioning output.

This project is not affiliated with or endorsed by CivitAI. It provides optional CivitAI browsing/fetch support alongside local image metadata inspection.

---

## Nodes

### ImagePlus Inspector

A combined image and metadata inspection node.

Features:

- Open a CivitAI gallery from inside ComfyUI
- Fetch a CivitAI image by URL
- Upload a local image
- Drop a local image onto the metadata panel
- Preview the selected image
- Display image dimensions in the preview area
- View filtered useful metadata
- View raw embedded metadata
- Extract positive and negative prompts when available
- Copy the CivitAI page URL or source URL
- Open the selected image

The inspector is designed to keep state scoped to the individual node instance.

---

### ImagePlus Prompt

A separate editable prompt node.

Inputs:

- `clip`

Outputs:

- `positive_conditioning`
- `negative_conditioning`
- `positive_prompt`
- `negative_prompt`

This allows users to connect the prompt node directly to a KSampler without adding separate CLIP Text Encode nodes, while still exposing the raw prompt strings for users who prefer other workflow styles.

Example workflow shape:

```text
Checkpoint Loader CLIP
        ↓
ImagePlus Prompt
        ├─ positive_conditioning → KSampler positive
        └─ negative_conditioning → KSampler negative
```

---

## Installation

### Manual Install

Go to your ComfyUI custom nodes folder:

```bash
cd ComfyUI/custom_nodes
```

Clone the repository:

```bash
git clone https://github.com/CovertBannana/ComfyUI_ImagePlus_Inspector.git
```

Restart ComfyUI.

---

## CivitAI API Key

CivitAI browsing, fetching, and protected image preview require a CivitAI API key.

Copy:

```text
api_key.txt.example
```

to:

```text
api_key.txt
```

Then edit `api_key.txt`:

```text
CIVITAI_API_KEY=YOUR_CIVITAI_API_KEY_HERE
```

Restart ComfyUI after adding or changing the key.

---

## Local Image Metadata Support

ImagePlus Inspector can parse local image metadata from:

- PNG `tEXt`
- PNG `iTXt`
- JPEG EXIF `ImageDescription`
- JPEG EXIF `UserComment`
- A1111-style parameter strings
- ComfyUI prompt JSON
- ComfyUI workflow JSON

When available, it extracts:

- positive prompt
- negative prompt
- model/checkpoint
- UNET
- VAE
- CLIP
- seed
- steps
- CFG
- sampler
- scheduler
- denoise
- image size

---

## CivitAI Support

ImagePlus Inspector supports:

- Gallery browsing
- URL fetch from CivitAI image or post URLs
- Preview through a backend proxy route
- `.com` and `.red` page link handling
- filtered metadata summaries
- raw metadata viewing

Supported URL examples:

```text
https://civitai.com/images/<id>
https://civitai.com/posts/<id>
https://civitai.red/images/<id>
https://civitai.red/posts/<id>
```

---

## Image Size Display

The selected image size is displayed in the preview area when available.

For local images, dimensions are read from the browser-loaded image.

For CivitAI images, dimensions are read from API metadata when available, with preview-load fallback when needed.

---

## Design Notes

ImagePlus Inspector is built around node-scoped state.

The node uses a single apply pipeline:

```text
applyImageToInspectorNode(node, normalized)
```

This avoids global support-node updates and keeps CivitAI selections, local uploads, and previews isolated to the node that initiated the action.

The prompt node remains separate so users can choose whether to use:

- ImagePlus Prompt
- standard ComfyUI CLIP Text Encode nodes
- custom prompt nodes
- other workflow-specific prompt tools

---

## Current Scope

The first version focuses on frontend image inspection and metadata extraction.

The inspector outputs:

- positive prompt string
- negative prompt string
- info string

It does not currently output backend `IMAGE` tensors for local uploads.

A future version may add backend image output support using a dedicated upload/temp-storage bridge.

---

## Repository Structure

```text
ComfyUI_ImagePlus_Inspector/
├── __init__.py
├── imageplus_inspector_backend.py
├── js/
│   └── imageplus_inspector.js
├── pyproject.toml
├── README.md
├── LICENSE
├── .comfyignore
└── api_key.txt.example
```

---

## License

MIT
