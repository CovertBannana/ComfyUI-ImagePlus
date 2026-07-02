# ComfyUI ImagePlus

ComfyUI ImagePlus is a custom unified nodes pack primarily for Image to Image generation with a toggleable Text to Image option for easy switch back. It allows for CivitAI image inspection, local image upload/drop, metadata extraction, prompt syncing, and ImagePlus workflow helper nodes.
It is a unified (combined nodes) successor to ComfyUI CivitAI ImagePlus, https://github.com/CovertBannana/ComfyUI_CivitAI_ImagePlus
Since CivitAI released their own node pack, with different functions to ImagePlus, it still seemed necessary to change the naming relation to CivitAI, for this new unified node pack.

The new nodes feature Model, Clip and VAE pass through for a smoother work flow.
The KSampler Adv includes a VAE encode for direct image input and built-in empty latent image options that combined with a toggle will instantly switch between I2I and T2I.
The effort was to eliminate the common vae encode, empty latent image and clip text encode (prompt) that are used in almost all workflows.
The Nodes are not restricted to being used exclusively with the packs other nodes and should incorporate the necessary outputs to be used with standard nodes.

## Nodes

- ImagePlus Inspector
- ImagePlus Prompt
- ImagePlus KSampler Adv

## Features

- CivitAI gallery browsing
- Fetch image/post URL support
- Local image upload and drag/drop
- Image preview with dimensions
- Metadata tabs
- Positive and negative prompt extraction
- Prompt conditioning outputs
- Model/VAE pass-through
- ImagePlus KSampler Adv node for switching between Image In and Empty Latent sampling paths

## Installation

Clone this repository into your ComfyUI `custom_nodes` folder:

```
Open a command prompt in: ComfyUI/custom_nodes
git clone https://github.com/CovertBannana/ComfyUI-ImagePlus.git
```

Restart ComfyUI after installation.

## Requirements

The package currently uses:

```txt
aiohttp>=3.9.0
```

ComfyUI normally provides `torch`, `numpy`, and `Pillow`.

## Optional CivitAI API Key

To use a CivitAI API key, add your CivitAI API to this file inside the node folder api_key.txt


## ImagePlus Inspector

`ImagePlus Inspector` provides the image selection, upload, preview, metadata, and prompt inspection workflow.

### Outputs

- `image`: IMAGE output for downstream image or latent workflows
- `positive`: extracted positive prompt string
- `negative`: extracted negative prompt string
- `info`: filtered info/metadata string

### Uses

- Browse/select CivitAI images
- Fetch an image/post URL
- Upload or drag/drop a local image
- Preview selected image and dimensions
- Extract prompts and metadata
- Send image output into img2img workflows

## ImagePlus Prompt

`ImagePlus Prompt` receives model, clip, and vae inputs, then outputs prompt conditioning and pass-through model/VAE connections.

### Inputs

- `model`: MODEL
- `clip`: CLIP
- `vae`: VAE

### Outputs

- `model`: MODEL pass-through
- `vae`: VAE pass-through
- `positive_conditioning`: CONDITIONING for KSampler positive input
- `negative_conditioning`: CONDITIONING for KSampler negative input
- `positive_prompt`: extracted positive prompt string
- `negative_prompt`: extracted negative prompt string

### Recommended Wiring

```text
Checkpoint Loader:model
  → ImagePlus Prompt:model

Checkpoint Loader:clip
  → ImagePlus Prompt:clip

Checkpoint Loader:vae
  → ImagePlus Prompt:vae

ImagePlus Prompt:model
  → ImagePlus KSampler Adv:model

ImagePlus Prompt:vae
  → ImagePlus KSampler Adv:vae

ImagePlus Prompt:positive_conditioning
  → ImagePlus KSampler Adv:positive

ImagePlus Prompt:negative_conditioning
  → ImagePlus KSampler Adv:negative
```

## ImagePlus KSampler Adv

`ImagePlus KSampler Adv` is an ImagePlus workflow helper node that combines the common img2img/txt2img latent setup with KSampler execution.

It can operate in two modes using the `image_in` toggle:

- `image_in = true`  
  Encodes the connected `IMAGE` input through the connected VAE, then runs sampling.

- `image_in = false`  
  Creates an empty latent internally using the selected width, height, and batch size, then runs sampling.

This replaces the need for a separate `VAE Encode`, `Empty Latent Image`, and latent switch node.

### Inputs

- `model`: model input from `ImagePlus Prompt` or Checkpoint Loader
- `vae`: VAE input from `ImagePlus Prompt` or Checkpoint Loader
- `positive`: positive conditioning
- `negative`: negative conditioning
- `image_in`: toggle between image input mode and empty latent mode
- `width`: empty latent width
- `height`: empty latent height
- `batch_size`: empty latent batch count
- `seed`: sampler seed
- `steps`: sampler steps
- `cfg`: CFG scale
- `sampler_name`: sampler selection
- `scheduler`: scheduler selection
- `denoise`: denoise strength
- `image`: optional image input used when `image_in` is enabled

### Outputs

- `samples`: latent output for VAE Decode
- `vae`: VAE pass-through output for VAE Decode


### Denoise Notes

When using `image_in = true`, this behaves like an img2img workflow. Typical denoise values are usually below `1.0`, such as:

```
0.35 to 0.75
```

When using `image_in = false`, this behaves like a txt2img workflow from an empty latent. Typical denoise is:

```
1.0
```

The node does not automatically change denoise. The user controls denoise manually.


## License

MIT License. See `LICENSE` for details.
