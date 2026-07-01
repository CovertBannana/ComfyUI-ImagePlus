import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[ImagePlus Inspector] frontend script loaded - runtime cache fix 2026-06-29");


// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const STORAGE_KEY = "imageplus_inspector_v1";

const PAGE_BASES = {
  com: "https://civitai.com",
  red: "https://civitai.red",
};

const ROUTES = {
  images: "/imageplus_inspector/images",
  imageByUrl: "/imageplus_inspector/image_by_url",
  proxyImage: "/imageplus_inspector/proxy_image",
  setState: "/imageplus_inspector/set_state",
  uploadImage: "/imageplus_inspector/upload_image",
};

const DEFAULT_INSPECTOR_SIZE = [760, 520];
const MIN_INSPECTOR_SIZE = [620, 420];

const DEFAULT_PROMPT_SIZE = [760, 560];
const MIN_PROMPT_SIZE = [700, 440];


// ------------------------------------------------------------
// Node Detection
// ------------------------------------------------------------

function isImagePlusInspectorNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();

  return (
    node?.comfyClass === "ImagePlusInspectorNode" ||
    title.includes("imageplus inspector") ||
    title.includes("imageplus image inspector")
  );
}


function isImagePlusPromptNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();

  return (
    node?.comfyClass === "ImagePlusPromptNode" ||
    title.includes("imageplus prompt")
  );
}


// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

function normalizePageDomain(value) {
  const v = String(value ?? "").trim().toLowerCase();

  if (v === "com" || v === "red" || v === "auto") {
    return v;
  }

  return "auto";
}


function pageBaseFromSetting(value) {
  const v = normalizePageDomain(value);

  if (v === "com" || v === "red") {
    return PAGE_BASES[v];
  }

  return "";
}


function pageBaseFromUrl(raw) {
  try {
    if (!raw) {
      return "";
    }

    const url = new URL(String(raw));
    const host = String(url.hostname || "").toLowerCase();

    if (
      host === "civitai.com" ||
      host === "www.civitai.com" ||
      host === "civitai.red" ||
      host === "www.civitai.red"
    ) {
      return `${url.protocol}//${url.host}`;
    }
  } catch {}

  return "";
}


function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}


function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (raw) {
      const parsed = JSON.parse(raw);

      return {
        sort: parsed.sort ?? "Most Reactions",
        period: parsed.period ?? "AllTime",
        limit: parsed.limit ?? 36,
        nsfw: parsed.nsfw ?? "None",
        pageDomain: normalizePageDomain(parsed.pageDomain ?? "auto"),
      };
    }
  } catch {}

  return {
    sort: "Most Reactions",
    period: "AllTime",
    limit: 36,
    nsfw: "None",
    pageDomain: "auto",
  };
}


// ------------------------------------------------------------
// State
// ------------------------------------------------------------

function ensureInspectorState(node) {
  node.__imagePlusSource ??= "";
  node.__imagePlusSourceUrl ??= "";
  node.__imagePlusPageUrl ??= "";
  node.__imagePlusFileName ??= "";
  node.__imagePlusLocalUploadId ??= "";
  node.__imagePlusBackendUrl ??= "";
  node.__imagePlusFetchUrl ??= "";

  node.__imagePlusFilteredInfo ??= "";
  node.__imagePlusRawMetadata ??= "";
  node.__imagePlusMeta ??= {};
  node.__imagePlusRawMeta ??= {};

  node.__imagePlusPositive ??= "";
  node.__imagePlusNegative ??= "";

  node.__imagePlusThumbUrl ??= "";
  node.__imagePlusThumbImg ??= null;

  node.__imagePlusImageWidth ??= 0;
  node.__imagePlusImageHeight ??= 0;
  node.__imagePlusImageSizeText ??= "";

  node.__imagePlusActiveTab ??= "filtered";
  node.__imagePlusDragOver ??= false;

  node.__imagePlusRects ??= [];
  node.__imagePlusDropRect ??= null;

  return node;
}


function clearInspectorPreview(node) {
  ensureInspectorState(node);

  node.__imagePlusThumbUrl = "";

  if (node.__imagePlusThumbImg) {
    try {
      node.__imagePlusThumbImg.onload = null;
      node.__imagePlusThumbImg.onerror = null;
      node.__imagePlusThumbImg.src = "";
    } catch {}
  }

  node.__imagePlusThumbImg = null;
}


function setInspectorImageSize(node, width, height) {
  ensureInspectorState(node);

  const w = Number.parseInt(width || 0, 10) || 0;
  const h = Number.parseInt(height || 0, 10) || 0;

  node.__imagePlusImageWidth = w;
  node.__imagePlusImageHeight = h;
  node.__imagePlusImageSizeText = w && h ? `${w} × ${h} px` : "";

  node.graph?.setDirtyCanvas(true, true);
}

function purgeLegacyInspectorWidgets(node) {
  if (!node || !Array.isArray(node.widgets)) {
    return;
  }

  const removeNames = new Set([
    "image_data",
  ]);

  for (const widget of node.widgets) {
    if (!removeNames.has(widget?.name)) {
      continue;
    }

    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
  }

  node.widgets = node.widgets.filter((widget) => !removeNames.has(widget?.name));
}

function writeInspectorWidget(node, data) {
  purgeLegacyInspectorWidgets(node);
  setTimeout(() => purgeLegacyInspectorWidgets(node), 100);

  try {
    const payload = {
      node_id: String(node.id),
      node_type: "inspector",
      updatedAt: Date.now(),
      ...(data || {}),
    };

    if (payload.source === "local" || payload.localUploadId) {
      console.log("[ImagePlus Inspector] posting inspector state", {
        node_id: payload.node_id,
        localUploadId: payload.localUploadId || "",
        width: payload.width || 0,
        height: payload.height || 0,
      });
    }

    postJSON(ROUTES.setState, payload).catch(() => {});
  } catch {}
}

function getInspectorUrlForCopy(node) {
  ensureInspectorState(node);

  return String(
    node.__imagePlusPageUrl ||
    node.__imagePlusSourceUrl ||
    ""
  ).trim();
}


function getInspectorUrlForOpen(node) {
  ensureInspectorState(node);

  return String(
    node.__imagePlusThumbUrl ||
    node.__imagePlusSourceUrl ||
    ""
  ).trim();
}


// ------------------------------------------------------------
// Serialization
// ------------------------------------------------------------

function serializeInspectorState(node, output) {
  ensureInspectorState(node);

  output.__imagePlusSource = node.__imagePlusSource || "";
  output.__imagePlusSourceUrl = node.__imagePlusSourceUrl || "";
  output.__imagePlusPageUrl = node.__imagePlusPageUrl || "";
  output.__imagePlusFileName = node.__imagePlusFileName || "";
  output.__imagePlusLocalUploadId = node.__imagePlusLocalUploadId || "";
  output.__imagePlusBackendUrl = node.__imagePlusBackendUrl || "";
  output.__imagePlusFetchUrl = node.__imagePlusFetchUrl || "";

  output.__imagePlusFilteredInfo = node.__imagePlusFilteredInfo || "";
  output.__imagePlusRawMetadata = node.__imagePlusRawMetadata || "";
  output.__imagePlusMeta = node.__imagePlusMeta || {};
  output.__imagePlusRawMeta = node.__imagePlusRawMeta || {};

  output.__imagePlusPositive = node.__imagePlusPositive || "";
  output.__imagePlusNegative = node.__imagePlusNegative || "";

  output.__imagePlusImageWidth = node.__imagePlusImageWidth || 0;
  output.__imagePlusImageHeight = node.__imagePlusImageHeight || 0;
  output.__imagePlusImageSizeText = node.__imagePlusImageSizeText || "";

  output.__imagePlusActiveTab = node.__imagePlusActiveTab || "filtered";
}


function configureInspectorState(node, input) {
  ensureInspectorState(node);

  node.__imagePlusSource = input?.__imagePlusSource || "";
  node.__imagePlusSourceUrl = input?.__imagePlusSourceUrl || "";
  node.__imagePlusPageUrl = input?.__imagePlusPageUrl || "";
  node.__imagePlusFileName = input?.__imagePlusFileName || "";
  node.__imagePlusLocalUploadId = input?.__imagePlusLocalUploadId || "";
  node.__imagePlusBackendUrl = input?.__imagePlusBackendUrl || "";
  node.__imagePlusFetchUrl = input?.__imagePlusFetchUrl || "";

  node.__imagePlusFilteredInfo = input?.__imagePlusFilteredInfo || "";
  node.__imagePlusRawMetadata = input?.__imagePlusRawMetadata || "";
  node.__imagePlusMeta = input?.__imagePlusMeta || {};
  node.__imagePlusRawMeta = input?.__imagePlusRawMeta || {};

  node.__imagePlusPositive = input?.__imagePlusPositive || "";
  node.__imagePlusNegative = input?.__imagePlusNegative || "";

  node.__imagePlusImageWidth = input?.__imagePlusImageWidth || 0;
  node.__imagePlusImageHeight = input?.__imagePlusImageHeight || 0;
  node.__imagePlusImageSizeText = input?.__imagePlusImageSizeText || "";

  node.__imagePlusActiveTab = input?.__imagePlusActiveTab || "filtered";

  node.graph?.setDirtyCanvas(true, true);
}


// ------------------------------------------------------------
// Basic Helpers
// ------------------------------------------------------------

function asText(value) {
  if (value == null) {
    return "";
  }

  return String(value);
}


function firstValue(...values) {
  for (const value of values) {
    if (value !== null && typeof value !== "undefined" && value !== "") {
      return value;
    }
  }

  return "";
}


function safeJsonStringify(value, fallback = "") {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return fallback;
  }
}


function buildProxyImageUrl(srcUrl, pageUrl = "") {
  const proxy = new URL(ROUTES.proxyImage, window.location.origin);

  proxy.searchParams.set("url", srcUrl ?? "");

  if (pageUrl) {
    proxy.searchParams.set("page_url", pageUrl);
  }

  return proxy.toString();
}



async function postJSON(path, payload) {
  const response = await api.fetchApi(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  return response.json().catch(() => ({}));
}


async function copyText(text) {
  const value = String(text || "").trim();

  if (!value) {
    return false;
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  try {
    const textarea = document.createElement("textarea");

    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";

    document.body.appendChild(textarea);
    textarea.select();

    const ok = document.execCommand("copy");

    textarea.remove();

    if (ok) {
      return true;
    }
  } catch {}

  try {
    window.prompt("Copy to clipboard:", value);
    return true;
  } catch {}

  return false;
}


function openUrlInNewTab(url) {
  const finalUrl = String(url || "").trim();

  if (!finalUrl) {
    alert("No image is currently loaded.");
    return;
  }

  const anchor = document.createElement("a");

  anchor.href = finalUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// ------------------------------------------------------------
// Prompt Helpers
// ------------------------------------------------------------

function extractPrompts(meta) {
  if (!meta || typeof meta !== "object") {
    return {
      positive: "",
      negative: "",
    };
  }

  const parameters = meta.parameters || {};

  const positive = firstValue(
    meta.prompt,
    meta.positivePrompt,
    meta.positive,
    meta.Positive,
    meta.PositivePrompt,
    parameters.prompt,
    parameters.positivePrompt,
    parameters.positive
  );

  const negative = firstValue(
    meta.negativePrompt,
    meta.negative,
    meta.Negative,
    meta.NegativePrompt,
    parameters.negativePrompt,
    parameters.negative
  );

  return {
    positive: asText(positive),
    negative: asText(negative),
  };
}


function extractDimensionsFromMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return {
      width: 0,
      height: 0,
    };
  }

  let width = firstValue(
    meta.width,
    meta.Width,
    meta.imageWidth,
    meta.ImageWidth
  );

  let height = firstValue(
    meta.height,
    meta.Height,
    meta.imageHeight,
    meta.ImageHeight
  );

  const size = firstValue(
    meta.size,
    meta.Size
  );

  if ((!width || !height) && typeof size === "string") {
    const normalized = size
      .toLowerCase()
      .replaceAll("px", "")
      .replaceAll(" ", "")
      .replaceAll("×", "x");

    if (normalized.includes("x")) {
      const [left, right] = normalized.split("x", 2);

      const parsedWidth = Number.parseInt(left, 10);
      const parsedHeight = Number.parseInt(right, 10);

      if (parsedWidth && parsedHeight) {
        width = parsedWidth;
        height = parsedHeight;
      }
    }
  }

  return {
    width: Number.parseInt(width || 0, 10) || 0,
    height: Number.parseInt(height || 0, 10) || 0,
  };
}


// ------------------------------------------------------------
// Info Text
// ------------------------------------------------------------

function buildImageSizeText(width, height) {
  const w = Number.parseInt(width || 0, 10) || 0;
  const h = Number.parseInt(height || 0, 10) || 0;

  return w && h ? `${w} × ${h} px` : "";
}


function buildFilteredInfoText(normalized) {
  const lines = [];

  const source = normalized?.source || "";

  if (source === "local") {
    lines.push("Source: Local image");
  } else if (source === "civitai") {
    lines.push("Source: CivitAI");
  } else {
    lines.push("Source: Unknown");
  }

  if (normalized?.filename) {
    lines.push(`File: ${normalized.filename}`);
  }

  if (normalized?.pageUrl) {
    lines.push(`CivitAI Page: ${normalized.pageUrl}`);
  }

  if (normalized?.id) {
    lines.push(`Image ID: ${normalized.id}`);
  }

  if (normalized?.postId) {
    lines.push(`Post ID: ${normalized.postId}`);
  }

  const imageSizeText =
    normalized?.imageSizeText ||
    buildImageSizeText(normalized?.width, normalized?.height);

  if (imageSizeText) {
    lines.push(`Image Size: ${imageSizeText}`);
  }

  const meta = normalized?.meta || {};

  const model = firstValue(
    meta.Model,
    meta.model,
    meta["Model type"],
    meta.modelName,
    meta.checkpoint,
    meta.ckpt_name,
    meta.unet_name,
    meta.ecosystem
  );

  const steps = firstValue(
    meta.steps,
    meta.Steps
  );

  const cfg = firstValue(
    meta.cfgScale,
    meta["CFG scale"],
    meta.CFG,
    meta.cfg
  );

  const sampler = firstValue(
    meta.sampler,
    meta.Sampler
  );

  const scheduler = firstValue(
    meta.scheduler,
    meta.Scheduler,
    meta["Schedule type"],
    meta.schedule_type,
    meta.scheduleType
  );

  const seed = firstValue(
    meta.seed,
    meta.Seed
  );

  const vae = firstValue(
    meta.vae_name,
    meta.VAE,
    meta.vae
  );

  const clip = firstValue(
    meta.clip_name,
    meta.CLIP,
    meta.clip
  );

  const denoise = firstValue(
    meta.denoise,
    meta.Denoise
  );

  if (model) {
    lines.push(`Model: ${model}`);
  }

  if (vae) {
    lines.push(`VAE: ${vae}`);
  }

  if (clip) {
    lines.push(`CLIP: ${clip}`);
  }

  if (steps) {
    lines.push(`Steps: ${steps}`);
  }

  if (cfg) {
    lines.push(`CFG: ${cfg}`);
  }

  if (sampler) {
    lines.push(`Sampler: ${sampler}`);
  }

  if (scheduler) {
    lines.push(`Scheduler: ${scheduler}`);
  }

  if (seed) {
    lines.push(`Seed: ${seed}`);
  }

  if (denoise) {
    lines.push(`Denoise: ${denoise}`);
  }

return lines.join("\n");
}

// ------------------------------------------------------------
// Preview
// ------------------------------------------------------------

function isLocalPreviewUrl(url) {
  const value = String(url || "");

  return (
    value.startsWith("blob:") ||
    value.startsWith("data:")
  );
}


function setInspectorPreview(node, srcUrl, pageUrl = "") {
  ensureInspectorState(node);

  clearInspectorPreview(node);

  const sourceUrl = String(srcUrl || "").trim();

  if (!sourceUrl) {
    node.graph?.setDirtyCanvas(true, true);
    return;
  }

  const previewUrl = isLocalPreviewUrl(sourceUrl)
    ? sourceUrl
    : buildProxyImageUrl(sourceUrl, pageUrl);

  node.__imagePlusThumbUrl = previewUrl;
  node.__imagePlusThumbImg = new Image();

  node.__imagePlusThumbImg.onload = () => {
    const img = node.__imagePlusThumbImg;

    if (img?.naturalWidth && img?.naturalHeight) {
      if (!node.__imagePlusImageWidth || !node.__imagePlusImageHeight) {
        setInspectorImageSize(
          node,
          img.naturalWidth,
          img.naturalHeight
        );

        syncInspectorImageDataWidget(node);
      }
    }

    node.graph?.setDirtyCanvas(true, true);
  };

  node.__imagePlusThumbImg.onerror = () => {
    node.graph?.setDirtyCanvas(true, true);
  };

  node.__imagePlusThumbImg.src = previewUrl;
  node.graph?.setDirtyCanvas(true, true);
}


// ------------------------------------------------------------
// Normalization
// ------------------------------------------------------------

function normalizeInspectorPayload(input) {
  const data = input || {};
  const meta = data.meta || {};
  const rawMeta = data.rawMeta || data.raw_metadata || {};
  const prompts = extractPrompts(meta);

  const dimensions = {
    width: Number.parseInt(data.width || 0, 10) || 0,
    height: Number.parseInt(data.height || 0, 10) || 0,
  };

  if (!dimensions.width || !dimensions.height) {
    const metaDimensions = extractDimensionsFromMeta(meta);

    if (!dimensions.width) {
      dimensions.width = metaDimensions.width;
    }

    if (!dimensions.height) {
      dimensions.height = metaDimensions.height;
    }
  }

  const normalized = {
    source: data.source || "",
    id: data.id || "",
    postId: data.postId || data.post_id || "",
    url: data.url || data.imageUrl || data.src || "",
    pageUrl: data.pageUrl || data.page_url || "",
    sourcePageUrl: data.sourcePageUrl || data.source_page_url || "",
    pageDomain: data.pageDomain || data.page_domain || "",
    filename: data.filename || data.fileName || "",
    localUploadId: data.localUploadId || data.local_upload_id || data.upload_id || "",
    backendUrl: data.backendUrl || data.backend_url || "",
    type: data.type || "",
    size: data.size || 0,
    width: dimensions.width,
    height: dimensions.height,
    imageSizeText:
      data.imageSizeText ||
      buildImageSizeText(dimensions.width, dimensions.height),
    meta,
    rawMeta,
    positive: data.positive || data.positivePrompt || prompts.positive || "",
    negative: data.negative || data.negativePrompt || prompts.negative || "",
    infoText: "",
  };

  normalized.infoText = buildFilteredInfoText(normalized);

  return normalized;
}

function buildInspectorWidgetPayload(node) {
  ensureInspectorState(node);

  return {
    source: node.__imagePlusSource || "",
    url: node.__imagePlusSourceUrl || "",
    pageUrl: node.__imagePlusPageUrl || "",
    filename: node.__imagePlusFileName || "",
    localUploadId: node.__imagePlusLocalUploadId || "",
    backendUrl: node.__imagePlusBackendUrl || "",
    width: node.__imagePlusImageWidth || 0,
    height: node.__imagePlusImageHeight || 0,
    imageSizeText: node.__imagePlusImageSizeText || "",
    positive: node.__imagePlusPositive || "",
    negative: node.__imagePlusNegative || "",
    info: node.__imagePlusFilteredInfo || "",
    infoText: node.__imagePlusFilteredInfo || "",
    meta: node.__imagePlusMeta || {},
    rawMeta: node.__imagePlusRawMeta || {},
  };
}

function syncInspectorImageDataWidget(node) {
  const payload = buildInspectorWidgetPayload(node);

  writeInspectorWidget(node, payload);
}


// ------------------------------------------------------------
// Apply Pipeline
// ------------------------------------------------------------

async function applyImageToInspectorNode(node, input) {
  ensureInspectorState(node);

  const normalized = normalizeInspectorPayload(input);

  node.__imagePlusSource = normalized.source || "";
  node.__imagePlusSourceUrl = normalized.url || "";
  node.__imagePlusPageUrl = normalized.pageUrl || "";
  node.__imagePlusFileName = normalized.filename || "";
  node.__imagePlusLocalUploadId = normalized.localUploadId || "";
  node.__imagePlusBackendUrl = normalized.backendUrl || "";

  node.__imagePlusMeta = normalized.meta || {};
  node.__imagePlusRawMeta = normalized.rawMeta || {};

  node.__imagePlusPositive = normalized.positive || "";
  node.__imagePlusNegative = normalized.negative || "";

  node.__imagePlusImageWidth = normalized.width || 0;
  node.__imagePlusImageHeight = normalized.height || 0;
  node.__imagePlusImageSizeText =
    normalized.imageSizeText ||
    buildImageSizeText(normalized.width, normalized.height);

  node.__imagePlusFilteredInfo = buildFilteredInfoText(normalized);

  node.__imagePlusRawMetadata = safeJsonStringify(
    normalized.rawMeta && Object.keys(normalized.rawMeta).length
      ? normalized.rawMeta
      : normalized.meta,
    ""
  );

syncInspectorImageDataWidget(node);
syncImagePlusPromptNodesFromInspector(node);

setInspectorPreview(
  node,
  normalized.url || "",
  normalized.pageUrl || ""
);

node.graph?.setDirtyCanvas(true, true);
}

// ------------------------------------------------------------
// Drawing Helpers
// ------------------------------------------------------------

function drawRoundedRect(ctx, x, y, w, h, radius = 6) {
  const r = Math.min(radius, w / 2, h / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}


function drawButton(ctx, node, name, label, x, y, w, h, action) {
  ensureInspectorState(node);

  ctx.save();

  drawRoundedRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = "rgba(58,58,58,0.96)";
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#eeeeee";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);

  ctx.restore();

  node.__imagePlusRects.push({
    name,
    x,
    y,
    w,
    h,
    action,
  });
}

function drawUrlField(ctx, node, x, y, w, h) {
  ensureInspectorState(node);

  ctx.save();
  drawRoundedRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = "rgba(18,18,18,0.96)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const value = String(node.__imagePlusFetchUrl || "").trim();

  ctx.beginPath();
  ctx.rect(x + 8, y + 4, w - 16, h - 8);
  ctx.clip();

  const placeholder = "Paste image/post URL here…";
  ctx.fillStyle = value ? "#dddddd" : "#b8c7dc";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(value || placeholder, x + 8, y + h / 2);

  ctx.restore();

  node.__imagePlusRects.push({
    name: "editFetchUrl",
    x,
    y,
    w,
    h,
    action: () => openFetchUrlDialog(node),
  });
}

function drawPanelBox(ctx, x, y, w, h) {
  ctx.save();

  drawRoundedRect(ctx, x, y, w, h, 7);
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function breakLongToken(ctx, token, maxWidth) {
  const pieces = [];
  let current = "";

  for (const char of String(token || "")) {
    const test = current + char;

    if (ctx.measureText(test).width > maxWidth && current) {
      pieces.push(current);
      current = char;
    } else {
      current = test;
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces.length ? pieces : [""];
}

function wrapTextLines(ctx, text, maxWidth) {
  const value = String(text || "");
  const sourceLines = value.split(/\r?\n/g);
  const lines = [];

  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }

    const words = sourceLine.split(/(\s+)/g).filter((part) => part !== "");
    let line = "";

    for (const word of words) {
      const isWhitespace = /^\s+$/.test(word);

      if (ctx.measureText(word).width > maxWidth) {
        if (line.trim()) {
          lines.push(line.trimEnd());
          line = "";
        }

        const pieces = breakLongToken(ctx, word, maxWidth);
        for (const piece of pieces) {
          lines.push(piece);
        }

        continue;
      }

      const test = line + word;

      if (ctx.measureText(test).width > maxWidth && line.trim()) {
        lines.push(line.trimEnd());
        line = isWhitespace ? "" : word;
      } else {
        line = test;
      }
    }

    lines.push(line.trimEnd());
  }

  return lines;
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxHeight) {
  const lines = wrapTextLines(ctx, text, maxWidth);
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));

  let drawn = 0;

  for (let i = 0; i < lines.length && drawn < maxLines; i++) {
    const line = lines[i];

    if (drawn === maxLines - 1 && i < lines.length - 1) {
      ctx.fillText("…", x, y + drawn * lineHeight);
      drawn++;
      break;
    }

    ctx.fillText(line, x, y + drawn * lineHeight);
    drawn++;
  }

  return drawn;
}


function drawTab(ctx, node, name, label, x, y, w, h, active, action) {
  ensureInspectorState(node);

  ctx.save();

  drawRoundedRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = active
    ? "rgba(76,104,140,0.95)"
    : "rgba(45,45,45,0.95)";
  ctx.fill();

  ctx.strokeStyle = active
    ? "rgba(160,200,255,0.35)"
    : "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = active ? "#ffffff" : "#cccccc";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);

  ctx.restore();

  node.__imagePlusRects.push({
    name,
    x,
    y,
    w,
    h,
    action,
  });
}


function drawPreviewSizeBadge(ctx, text, x, y, w, h) {
  const value = String(text || "").trim();

  if (!value) {
    return;
  }

  ctx.save();

  ctx.font = "12px sans-serif";
  const padX = 8;
  const padY = 5;
  const textWidth = ctx.measureText(value).width;
  const badgeW = Math.min(textWidth + padX * 2, w - 12);
  const badgeH = 24;
  const badgeX = x + 8;
  const badgeY = y + h - badgeH - 8;

  drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 6);
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#eeeeee";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(value, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);

  ctx.restore();
}


// ------------------------------------------------------------
// Inspector Drawing
// ------------------------------------------------------------

function drawInspectorTopControls(ctx, node, layout) {
  const {
    pad,
    top,
    width,
    previewX,
    previewW,
    connectorGutterRight = 86,
  } = layout;

  ensureInspectorState(node);

  const buttonH = 24;
  const gap = 6;
  const leftX = pad;

  const previewButtonsW = Math.min(128, Math.max(96, previewW));
  const previewButtonsX = Math.max(
    leftX,
    Math.min(
      previewX,
      width - pad - connectorGutterRight - previewButtonsW
    )
  );

  drawButton(
    ctx,
    node,
    "openGallery",
    "Open Gallery",
    leftX,
    top,
    144,
    buttonH,
    () => openFullGallery(node)
  );

  drawButton(
    ctx,
    node,
    "copyUrl",
    "Copy image URL",
    previewButtonsX,
    top,
    previewButtonsW,
    buttonH,
    async () => {
      const copied = await copyText(getInspectorUrlForCopy(node));
      if (!copied) {
        alert("No URL is currently loaded.");
      }
    }
  );

  const row2Y = top + buttonH + gap;

  const fetchButtonW = 132;
  const urlFieldX = leftX + fetchButtonW + gap;
  const previewButtonClearance = 14;
  const maxUrlFieldW = Math.max(
    140,
    previewButtonsX - urlFieldX - previewButtonClearance
  );
  const urlFieldW = Math.max(
    180,
    Math.min(260, maxUrlFieldW)
  );

  drawButton(
    ctx,
    node,
    "fetchUrl",
    "Fetch URL",
    leftX,
    row2Y,
    fetchButtonW,
    buttonH,
    () => fetchAndApplyUrl(node, node.__imagePlusFetchUrl || "")
  );

  drawUrlField(
    ctx,
    node,
    urlFieldX,
    row2Y,
    urlFieldW,
    buttonH
  );

  drawButton(
    ctx,
    node,
    "openImage",
    "Open Image",
    previewButtonsX,
    row2Y,
    previewButtonsW,
    buttonH,
    () => openUrlInNewTab(getInspectorUrlForOpen(node))
  );

  const row3Y = row2Y + buttonH + gap;

  drawButton(
    ctx,
    node,
    "uploadImage",
    "Upload image",
    leftX,
    row3Y,
    144,
    buttonH,
    () => openLocalImagePicker(node)
  );
}

function drawInspectorInfoPanel(ctx, node, x, y, w, h) {
  ensureInspectorState(node);
  drawPanelBox(ctx, x, y, w, h);

  const tabY = y + 8;
  const tabH = 25;
  const tabGap = 6;
  const tabW = Math.floor((w - 24 - tabGap) / 2);

  drawTab(
    ctx,
    node,
    "tabFiltered",
    "Filtered Info",
    x + 8,
    tabY,
    tabW,
    tabH,
    node.__imagePlusActiveTab === "filtered",
    () => {
      node.__imagePlusActiveTab = "filtered";
      node.graph?.setDirtyCanvas(true, true);
    }
  );

  drawTab(
    ctx,
    node,
    "tabRaw",
    "Raw Metadata",
    x + 8 + tabW + tabGap,
    tabY,
    tabW,
    tabH,
    node.__imagePlusActiveTab === "raw",
    () => {
      node.__imagePlusActiveTab = "raw";
      node.graph?.setDirtyCanvas(true, true);
    }
  );

  const textX = x + 10;
  const textY = y + tabH + 28;
  const textW = w - 20;
  const textH = h - tabH - 42;

  const activeText =
    node.__imagePlusActiveTab === "raw"
      ? node.__imagePlusRawMetadata
      : node.__imagePlusFilteredInfo;

  const placeholder =
    "Open Gallery, fetch a CivitAI URL, upload an image, or drop an image here.";

  ctx.save();
  ctx.beginPath();
  ctx.rect(textX, textY, textW, textH);
  ctx.clip();

  ctx.fillStyle = "#dddddd";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  drawWrappedText(
    ctx,
    activeText || placeholder,
    textX,
    textY,
    textW,
    14,
    textH
  );

  ctx.restore();

  node.__imagePlusDropRect = {
    x,
    y,
    w,
    h,
  };

  if (node.__imagePlusDragOver) {
    ctx.save();
    drawRoundedRect(ctx, x + 4, y + 4, w - 8, h - 8, 8);
    ctx.strokeStyle = "rgba(120,200,255,0.95)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(120,200,255,0.12)";
    ctx.fill();
    ctx.fillStyle = "#d8f0ff";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Drop image here", x + w / 2, y + h / 2);
    ctx.restore();
  }
}

function drawInspectorPreviewPanel(ctx, node, x, y, w, h) {
  ensureInspectorState(node);
  drawPanelBox(ctx, x, y, w, h);

  const img = node.__imagePlusThumbImg;

  if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
    ctx.save();
    ctx.fillStyle = "#bbbbbb";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No preview loaded", x + w / 2, y + h / 2);
    ctx.restore();

    drawPreviewSizeBadge(ctx, node.__imagePlusImageSizeText, x, y, w, h);
    return;
  }

  const pad = 10;
  const innerX = x + pad;
  const innerY = y + pad;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.min(innerW / iw, innerH / ih);

  const dw = iw * scale;
  const dh = ih * scale;
  const dx = innerX + (innerW - dw) / 2;
  const dy = innerY + (innerH - dh) / 2;

  ctx.save();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  drawPreviewSizeBadge(
    ctx,
    node.__imagePlusImageSizeText || buildImageSizeText(iw, ih),
    x,
    y,
    w,
    h
  );
}

function drawImagePlusInspectorNode(ctx, node) {
  ensureInspectorState(node);
  node.__imagePlusRects = [];

  const width = node.size?.[0] || DEFAULT_INSPECTOR_SIZE[0];
  const height = node.size?.[1] || DEFAULT_INSPECTOR_SIZE[1];

  const pad = 10;
  const top = 42;
  const controlsH = 84;
  const gap = 10;
  const connectorGutterRight = 86;

  const contentY = top + controlsH + gap;
  const contentH = height - contentY - pad;
  const usableWidth = width - pad * 2 - connectorGutterRight;

  const leftW = Math.max(220, Math.floor((usableWidth - gap) * 0.48));
  const rightW = Math.max(80, usableWidth - gap - leftW);
  const leftX = pad;
  const rightX = pad + leftW + gap;

  drawInspectorTopControls(ctx, node, {
    pad,
    top,
    width,
    height,
    previewX: rightX,
    previewW: rightW,
    connectorGutterRight,
  });

  drawInspectorInfoPanel(
    ctx,
    node,
    leftX,
    contentY,
    leftW,
    contentH
  );

  drawInspectorPreviewPanel(
    ctx,
    node,
    rightX,
    contentY,
    rightW,
    contentH
  );
}

// ------------------------------------------------------------
// Inspector Events
// ------------------------------------------------------------

function handleInspectorMouseDown(node, event, localPos, graphcanvas, oldMouseDown) {
  ensureInspectorState(node);

  const rects = node.__imagePlusRects || [];

  if (Array.isArray(rects) && localPos) {
    const mouseX = localPos[0];
    const mouseY = localPos[1];

    for (const rect of rects) {
      if (
        mouseX >= rect.x &&
        mouseX <= rect.x + rect.w &&
        mouseY >= rect.y &&
        mouseY <= rect.y + rect.h
      ) {
        try {
          rect.action?.();
        } catch (err) {
          console.warn("[ImagePlus Inspector] button action failed", err);
        }

        return true;
      }
    }
  }

  return oldMouseDown
    ? oldMouseDown(event, localPos, graphcanvas)
    : false;
}


// ------------------------------------------------------------
// Inspector Setup
// ------------------------------------------------------------

function setupImagePlusInspectorNode(node) {
  if (node.__imagePlusInspectorHooked) {
    return;
  }

  node.__imagePlusInspectorHooked = true;

  ensureInspectorState(node);

  node.size = node.size || [...DEFAULT_INSPECTOR_SIZE];
  node.size[0] = Math.max(node.size[0], MIN_INSPECTOR_SIZE[0]);
  node.size[1] = Math.max(node.size[1], MIN_INSPECTOR_SIZE[1]);

  const imageDataWidget = node.widgets?.find((widget) => widget.name === "image_data");

  if (imageDataWidget) {
    imageDataWidget.type = "hidden";
    imageDataWidget.computeSize = () => [0, -4];
  }

  const oldSerialize = node.onSerialize?.bind(node);

  node.onSerialize = function (output) {
    oldSerialize?.(output);
    serializeInspectorState(this, output);
  };

  const oldConfigure = node.onConfigure?.bind(node);

  node.onConfigure = function (input) {
    oldConfigure?.(input);
    configureInspectorState(this, input);

    if (this.__imagePlusSourceUrl) {
      setInspectorPreview(
        this,
        this.__imagePlusSourceUrl,
        this.__imagePlusPageUrl
      );
    }
  };

  const oldDrawBackground = node.onDrawBackground?.bind(node);

  node.onDrawBackground = function (ctx) {
    purgeLegacyInspectorWidgets(this);
    oldDrawBackground?.(ctx);
  };

  const oldMouseDown = node.onMouseDown?.bind(node);

  node.onMouseDown = function (event, localPos, graphcanvas) {
    return handleInspectorMouseDown(
      this,
      event,
      localPos,
      graphcanvas,
      oldMouseDown
    );
  };

const oldDrawForeground = node.onDrawForeground?.bind(node);
node.onDrawForeground = function (ctx) {
  purgeLegacyInspectorWidgets(this);
  oldDrawForeground?.(ctx);

  try {
    drawImagePlusInspectorNode(ctx, this);
  } catch (err) {
    console.warn("[ImagePlus Inspector] draw failed", err);
  }
};

node.graph?.setDirtyCanvas(true, true);
}

// ------------------------------------------------------------
// Modal Editor
// ------------------------------------------------------------

function openModalEditor({ title, value, onSave }) {
  const overlay = document.createElement("div");

  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.72)",
    zIndex: "20000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  });

  const panel = document.createElement("div");

  Object.assign(panel.style, {
    width: "min(1000px, 92vw)",
    height: "min(700px, 82vh)",
    background: "#1f1f1f",
    border: "1px solid #444",
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
  });

  const header = document.createElement("div");

  Object.assign(header.style, {
    padding: "12px 14px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    borderBottom: "1px solid #333",
    background: "#242424",
  });

  const titleEl = document.createElement("div");

  Object.assign(titleEl.style, {
    color: "#eeeeee",
    fontSize: "14px",
    fontWeight: "600",
    flex: "1",
  });

  titleEl.textContent = title || "Edit";

  const makeButton = (label) => {
    const button = document.createElement("button");

    button.textContent = label;

    Object.assign(button.style, {
      background: "#3a3a3a",
      border: "1px solid #666",
      color: "#eeeeee",
      padding: "8px 12px",
      borderRadius: "6px",
      cursor: "pointer",
    });

    return button;
  };

  const cancelButton = makeButton("Cancel");
  const saveButton = makeButton("Save");

  header.append(titleEl, cancelButton, saveButton);

  const body = document.createElement("div");

  Object.assign(body.style, {
    padding: "12px",
    flex: "1",
    display: "flex",
  });

  const textarea = document.createElement("textarea");

  textarea.value = value || "";
  textarea.spellcheck = false;

  Object.assign(textarea.style, {
    flex: "1",
    width: "100%",
    height: "100%",
    resize: "none",
    background: "#111111",
    color: "#dddddd",
    border: "1px solid #333",
    borderRadius: "8px",
    padding: "10px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.35",
  });

  body.appendChild(textarea);
  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  cancelButton.onclick = () => close();

  saveButton.onclick = () => {
    try {
      onSave?.(textarea.value);
    } finally {
      close();
    }
  };

  setTimeout(() => textarea.focus(), 50);
}


// ------------------------------------------------------------
// Prompt State
// ------------------------------------------------------------

function ensurePromptState(node) {
  node.__imagePlusPromptPositive ??= "";
  node.__imagePlusPromptNegative ??= "";
  node.__imagePlusPromptOriginal ??= {
    positive: node.__imagePlusPromptPositive || "",
    negative: node.__imagePlusPromptNegative || "",
  };

  node.__imagePlusPromptRects ??= [];

  return node;
}

function getPromptWidget(node, name) {
  const wanted = String(name || "").toLowerCase();

  if (node.__imagePlusPromptHiddenWidgets) {
    for (const [hiddenName, widget] of Object.entries(node.__imagePlusPromptHiddenWidgets)) {
      const lowerHiddenName = String(hiddenName || "").toLowerCase();

      if (
        lowerHiddenName === wanted ||
        lowerHiddenName.includes(wanted) ||
        wanted.includes(lowerHiddenName)
      ) {
        return widget;
      }
    }
  }

  return (
    node.widgets?.find((widget) => String(widget?.name || "").toLowerCase() === wanted) ||
    null
  );
}

function hidePromptTextWidgets(node) {
  if (!node) {
    return;
  }

  node.__imagePlusPromptHiddenWidgets ??= {};

  const widgets = Array.isArray(node.widgets) ? node.widgets : [];

  for (const widget of widgets) {
    if (!widget) {
      continue;
    }

    const name = String(widget.name || "").toLowerCase();

    if (widget.name) {
      node.__imagePlusPromptHiddenWidgets[widget.name] = widget;
    }

    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    widget.callback ??= () => {};
    widget.name = widget.name || name || "hidden_prompt_widget";
  }

  node.widgets = [];

  if (Array.isArray(node.widgets_values)) {
    node.__imagePlusPromptWidgetsValues = [...node.widgets_values];
  }
}

function readPromptWidgets(node) {
  ensurePromptState(node);
  const positiveWidget = getPromptWidget(node, "positive");
  const negativeWidget = getPromptWidget(node, "negative");

  if (positiveWidget) {
    node.__imagePlusPromptPositive = String(positiveWidget.value || "");
  }

  if (negativeWidget) {
    node.__imagePlusPromptNegative = String(negativeWidget.value || "");
  }

  return {
    positive: node.__imagePlusPromptPositive,
    negative: node.__imagePlusPromptNegative,
  };
}
function writePromptWidgets(node, positive, negative) {
  ensurePromptState(node);

  const positiveText = String(positive || "");
  const negativeText = String(negative || "");

  node.__imagePlusPromptPositive = positiveText;
  node.__imagePlusPromptNegative = negativeText;

  const positiveWidget = getPromptWidget(node, "positive");
  const negativeWidget = getPromptWidget(node, "negative");

  if (positiveWidget) {
    positiveWidget.value = positiveText;
    positiveWidget.callback?.(positiveText);
  }

  if (negativeWidget) {
    negativeWidget.value = negativeText;
    negativeWidget.callback?.(negativeText);
  }

  try {
    postJSON(ROUTES.setState, {
      node_id: String(node.id),
      node_type: "prompt",
      updatedAt: Date.now(),
      positive: positiveText,
      negative: negativeText,
      positive_prompt: positiveText,
      negative_prompt: negativeText,
      __imagePlusPromptPositive: positiveText,
      __imagePlusPromptNegative: negativeText,
    }).catch(() => {});
  } catch {}

  node.graph?.setDirtyCanvas(true, true);
}
function syncImagePlusPromptNodesFromInspector(sourceNode) {
  ensureInspectorState(sourceNode);

  const graph = sourceNode.graph || app?.graph;
  if (!graph || !Array.isArray(graph._nodes)) {
    return;
  }

  const positive = sourceNode.__imagePlusPositive || "";
  const negative = sourceNode.__imagePlusNegative || "";

  for (const node of graph._nodes) {
    if (!isImagePlusPromptNode(node)) {
      continue;
    }

    setupImagePlusPromptNode(node);

    node.__imagePlusPromptOriginal = {
      positive,
      negative,
    };

    writePromptWidgets(node, positive, negative);
  }
}

// ------------------------------------------------------------
// Prompt Drawing
// ------------------------------------------------------------

function drawPromptPanel(ctx, x, y, w, h, title, text) {
  drawPanelBox(ctx, x, y, w, h);

  ctx.save();
  ctx.fillStyle = "#bbbbbb";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, x + 10, y + 9);
  ctx.restore();

  const textX = x + 10;
  const textY = y + 34;
  const textW = w - 20;
  const textH = h - 44;

  ctx.save();
  ctx.beginPath();
  ctx.rect(textX, textY, textW, textH);
  ctx.clip();

  ctx.fillStyle = "#dddddd";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  drawWrappedText(
    ctx,
    text || "",
    textX,
    textY,
    textW,
    14,
    textH
  );

  ctx.restore();
}

function drawPromptButton(ctx, node, name, label, x, y, w, h, action) {
  ensurePromptState(node);

  ctx.save();

  drawRoundedRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = "rgba(58,58,58,0.96)";
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#eeeeee";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);

  ctx.restore();

  node.__imagePlusPromptRects.push({
    name,
    x,
    y,
    w,
    h,
    action,
  });
}


function drawImagePlusPromptNode(ctx, node) {
  ensurePromptState(node);
  readPromptWidgets(node);
  node.__imagePlusPromptRects = [];

  const width = node.size?.[0] || DEFAULT_PROMPT_SIZE[0];
  const height = node.size?.[1] || DEFAULT_PROMPT_SIZE[1];


const pad = 10;
const top = 42;
const gap = 10;
const buttonH = 32;
const connectorGutterLeft = 58;
const outputLabels = Array.isArray(node.outputs)
  ? node.outputs.map((output) => String(output?.label || output?.name || ""))
  : [];
ctx.save();
ctx.font = "12px sans-serif";
const outputLabelWidth = outputLabels.reduce((max, label) => {
  return Math.max(max, ctx.measureText(label).width || 0);
}, 0);
ctx.restore();
const connectorGutterRight = Math.max(150, Math.ceil(outputLabelWidth) + 26);
const contentX = pad + connectorGutterLeft;
const contentW = Math.max(
  260,
  width - pad * 2 - connectorGutterLeft - connectorGutterRight
);
const contentH = height - top - pad - buttonH - gap;
const panelH = Math.max(90, Math.floor((contentH - gap) / 2));
drawPromptPanel(
    ctx,
    contentX,
    top,
    contentW,
    panelH,
    "Positive Prompt",
    node.__imagePlusPromptPositive || ""
  );

  drawPromptPanel(
    ctx,
    contentX,
    top + panelH + gap,
    contentW,
    contentH - panelH - gap,
    "Negative Prompt",
    node.__imagePlusPromptNegative || ""
  );

  const buttonY = height - pad - buttonH;
  const buttonGap = 8;
  const labels = [
    "Edit Positive",
    "Edit Negative",
    "Restore",
    "Clear",
  ];

  const actions = [
    () => {
      readPromptWidgets(node);

      openModalEditor({
        title: "Edit Positive Prompt",
        value: node.__imagePlusPromptPositive || "",
        onSave: (value) => {
          writePromptWidgets(
            node,
            value,
            node.__imagePlusPromptNegative || ""
          );
        },
      });
    },
    () => {
      readPromptWidgets(node);

      openModalEditor({
        title: "Edit Negative Prompt",
        value: node.__imagePlusPromptNegative || "",
        onSave: (value) => {
          writePromptWidgets(
            node,
            node.__imagePlusPromptPositive || "",
            value
          );
        },
      });
    },
    () => {
      const original = node.__imagePlusPromptOriginal || {
        positive: "",
        negative: "",
      };

      writePromptWidgets(
        node,
        original.positive || "",
        original.negative || ""
      );
    },
    () => {
      writePromptWidgets(node, "", "");
    },
  ];

  const buttonW = Math.floor(
    (contentW - buttonGap * (labels.length - 1)) / labels.length
  );

  for (let i = 0; i < labels.length; i++) {
    drawPromptButton(
      ctx,
      node,
      `promptButton${i}`,
      labels[i],
      contentX + i * (buttonW + buttonGap),
      buttonY,
      buttonW,
      buttonH,
      actions[i]
    );
  }
}


// ------------------------------------------------------------
// Prompt Events
// ------------------------------------------------------------

function handlePromptMouseDown(node, event, localPos, graphcanvas, oldMouseDown) {
  ensurePromptState(node);

  const rects = node.__imagePlusPromptRects || [];

  if (Array.isArray(rects) && localPos) {
    const mouseX = localPos[0];
    const mouseY = localPos[1];

    for (const rect of rects) {
      if (
        mouseX >= rect.x &&
        mouseX <= rect.x + rect.w &&
        mouseY >= rect.y &&
        mouseY <= rect.y + rect.h
      ) {
        try {
          rect.action?.();
        } catch (err) {
          console.warn("[ImagePlus Prompt] button action failed", err);
        }

        return true;
      }
    }
  }

  return oldMouseDown
    ? oldMouseDown(event, localPos, graphcanvas)
    : false;
}


// ------------------------------------------------------------
// Prompt Slot Cleanup
// ------------------------------------------------------------
function sanitizePromptSlots(node) {
  if (!node) {
    return;
  }

  if (Array.isArray(node.inputs)) {
    const wantedOrder = ["model", "clip", "vae"];
    const keptInputs = [];
    const byName = new Map();

    for (const input of node.inputs) {
      const type = String(input?.type || "").toUpperCase();
      const rawName = String(input?.name || input?.label || "").toLowerCase();
      let name = rawName;

      if (type === "MODEL") {
        name = "model";
      } else if (type === "CLIP") {
        name = "clip";
      } else if (type === "VAE") {
        name = "vae";
      }

      if (!wantedOrder.includes(name) || byName.has(name)) {
        continue;
      }

      input.name = name;
      input.label = name;
      byName.set(name, input);
    }

    for (const name of wantedOrder) {
      const input = byName.get(name);

      if (input) {
        keptInputs.push(input);
      }
    }

    node.inputs = keptInputs;
  }

  if (Array.isArray(node.outputs)) {
    const wantedOrder = [
      "model",
      "vae",
      "positive_conditioning",
      "negative_conditioning",
      "positive_prompt",
      "negative_prompt",
    ];
    const byName = new Map();

    for (const output of node.outputs) {
      const name = String(output?.name || output?.label || "");

      if (!wantedOrder.includes(name) || byName.has(name)) {
        continue;
      }

      output.name = name;
      output.label = name;
      byName.set(name, output);
    }

    const keptOutputs = wantedOrder
      .map((name) => byName.get(name))
      .filter(Boolean);

    if (keptOutputs.length) {
      node.outputs = keptOutputs;
    }
  }
}
// ------------------------------------------------------------
// Prompt Setup
// ------------------------------------------------------------

function setupImagePlusPromptNode(node) {
  if (node.__imagePlusPromptHooked) {
    sanitizePromptSlots(node);
    return;
  }

  node.__imagePlusPromptHooked = true;
  ensurePromptState(node);
  sanitizePromptSlots(node);
  hidePromptTextWidgets(node);

  node.size = node.size || [...DEFAULT_PROMPT_SIZE];
  node.size[0] = Math.max(node.size[0], MIN_PROMPT_SIZE[0]);
  node.size[1] = Math.max(node.size[1], MIN_PROMPT_SIZE[1]);

  readPromptWidgets(node);

  node.__imagePlusPromptOriginal = {
    positive: node.__imagePlusPromptPositive || "",
    negative: node.__imagePlusPromptNegative || "",
  };

  const positiveWidget = getPromptWidget(node, "positive");
  const negativeWidget = getPromptWidget(node, "negative");

  if (positiveWidget) {
    positiveWidget.computeSize = () => [0, -4];
    const oldCallback = positiveWidget.callback;
    positiveWidget.callback = function (value) {
      oldCallback?.call(this, value);
      node.__imagePlusPromptPositive = String(value || "");
      node.graph?.setDirtyCanvas(true, true);
    };
  }

  if (negativeWidget) {
    negativeWidget.computeSize = () => [0, -4];
    const oldCallback = negativeWidget.callback;
    negativeWidget.callback = function (value) {
      oldCallback?.call(this, value);
      node.__imagePlusPromptNegative = String(value || "");
      node.graph?.setDirtyCanvas(true, true);
    };
  }

  const oldSerialize = node.onSerialize?.bind(node);
  node.onSerialize = function (output) {
    oldSerialize?.(output);
    sanitizePromptSlots(this);
    readPromptWidgets(this);
    output.__imagePlusPromptPositive = this.__imagePlusPromptPositive || "";
    output.__imagePlusPromptNegative = this.__imagePlusPromptNegative || "";
    output.__imagePlusPromptOriginal = this.__imagePlusPromptOriginal || {
      positive: "",
      negative: "",
    };
  };

  const oldConfigure = node.onConfigure?.bind(node);
  node.onConfigure = function (input) {
    oldConfigure?.(input);
    sanitizePromptSlots(this);
    this.__imagePlusPromptPositive = input?.__imagePlusPromptPositive || "";
    this.__imagePlusPromptNegative = input?.__imagePlusPromptNegative || "";
    this.__imagePlusPromptOriginal = input?.__imagePlusPromptOriginal || {
      positive: this.__imagePlusPromptPositive || "",
      negative: this.__imagePlusPromptNegative || "",
    };
    writePromptWidgets(
      this,
      this.__imagePlusPromptPositive,
      this.__imagePlusPromptNegative
    );
    hidePromptTextWidgets(this);
    this.graph?.setDirtyCanvas(true, true);
  };

  const oldMouseDown = node.onMouseDown?.bind(node);
  node.onMouseDown = function (event, localPos, graphcanvas) {
    return handlePromptMouseDown(
      this,
      event,
      localPos,
      graphcanvas,
      oldMouseDown
    );
  };

  node.onDrawBackground = function () {
    sanitizePromptSlots(this);
    hidePromptTextWidgets(this);
  };

  node.onDrawForeground = function (ctx) {
    sanitizePromptSlots(this);
    hidePromptTextWidgets(this);
    drawImagePlusPromptNode(ctx, this);
  };

  node.graph?.setDirtyCanvas(true, true);
}
// ------------------------------------------------------------
// File Reading
// ------------------------------------------------------------

async function readFileAsArrayBuffer(file) {
  return await file.arrayBuffer();
}

function decodeLatin1(bytes) {
  let text = "";

  for (let i = 0; i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i]);
  }

  return text;
}


function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}


function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}


// ------------------------------------------------------------
// PNG Metadata
// ------------------------------------------------------------

function parsePngMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

  for (let i = 0; i < pngSignature.length; i++) {
    if (bytes[i] !== pngSignature[i]) {
      return {};
    }
  }

  const meta = {};
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(view, offset);
    offset += 4;

    const type = decodeLatin1(bytes.slice(offset, offset + 4));
    offset += 4;

    const dataStart = offset;
    const dataEnd = offset + length;
    const data = bytes.slice(dataStart, dataEnd);

    offset = dataEnd + 4;

    if (type === "tEXt") {
      const nul = data.indexOf(0);

      if (nul > -1) {
        const key = decodeLatin1(data.slice(0, nul));
        const value = decodeLatin1(data.slice(nul + 1));

        meta[key] = value;
      }
    }

    if (type === "iTXt") {
      let p = 0;

      const nul1 = data.indexOf(0, p);

      if (nul1 > -1) {
        const key = decodeUtf8(data.slice(p, nul1));

        p = nul1 + 1;

        const compressionFlag = data[p];
        p += 1;

        p += 1;

        const nulLang = data.indexOf(0, p);

        if (nulLang > -1) {
          p = nulLang + 1;

          const nulTranslated = data.indexOf(0, p);

          if (nulTranslated > -1) {
            p = nulTranslated + 1;

            if (compressionFlag === 0) {
              meta[key] = decodeUtf8(data.slice(p));
            }
          }
        }
      }
    }

    if (type === "IEND") {
      break;
    }
  }

  return meta;
}


// ------------------------------------------------------------
// JPEG Metadata
// ------------------------------------------------------------

function cleanExifText(value) {
  return String(value || "")
    .replace(/^ASCII\x00\x00\x00/, "")
    .replace(/\0/g, "")
    .trim();
}


function parseJpegExifMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const meta = {};

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return meta;
  }

  function readAscii(start, length) {
    let text = "";

    for (let i = 0; i < length && start + i < bytes.length; i++) {
      text += String.fromCharCode(bytes[start + i]);
    }

    return text;
  }

  function parseExifSegment(segmentStart) {
    if (readAscii(segmentStart, 6) !== "Exif\0\0") {
      return;
    }

    const tiffStart = segmentStart + 6;
    const endian = readAscii(tiffStart, 2);
    const little = endian === "II";
    const big = endian === "MM";

    if (!little && !big) {
      return;
    }

    const read16 = (offset) => view.getUint16(offset, little);
    const read32 = (offset) => view.getUint32(offset, little);

    const firstIfdOffset = read32(tiffStart + 4);

    function readExifValue(type, count, valueOffsetField) {
      const typeSize = {
        1: 1,
        2: 1,
        3: 2,
        4: 4,
        7: 1,
      }[type] || 1;

      const totalBytes = typeSize * count;
      let valueStart;

      if (totalBytes <= 4) {
        valueStart = valueOffsetField;
      } else {
        const realOffset = read32(valueOffsetField);
        valueStart = tiffStart + realOffset;
      }

      if (valueStart < 0 || valueStart >= bytes.length) {
        return "";
      }

      if (type === 2 || type === 7 || type === 1) {
        return cleanExifText(readAscii(valueStart, totalBytes));
      }

      return "";
    }

    function readIfd(ifdRelativeOffset) {
      const ifdStart = tiffStart + ifdRelativeOffset;

      if (ifdStart < 0 || ifdStart + 2 >= bytes.length) {
        return;
      }

      const entryCount = read16(ifdStart);

      for (let i = 0; i < entryCount; i++) {
        const entry = ifdStart + 2 + i * 12;

        if (entry + 12 > bytes.length) {
          continue;
        }

        const tag = read16(entry);
        const type = read16(entry + 2);
        const count = read32(entry + 4);
        const valueOffsetField = entry + 8;

        if (tag === 270) {
          const value = readExifValue(type, count, valueOffsetField);

          if (value) {
            meta.Description = value;
          }
        }

        if (tag === 37510) {
          const value = readExifValue(type, count, valueOffsetField);

          if (value) {
            meta.UserComment = value;
          }
        }

        if (tag === 34665) {
          const subIfdOffset = read32(valueOffsetField);

          if (subIfdOffset) {
            readIfd(subIfdOffset);
          }
        }
      }
    }

    readIfd(firstIfdOffset);
  }

  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }

    const marker = bytes[offset + 1];

    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const segmentLength = view.getUint16(offset + 2, false);
    const segmentStart = offset + 4;

    if (marker === 0xe1) {
      parseExifSegment(segmentStart);
    }

    offset += 2 + segmentLength;
  }

  const candidate = meta.UserComment || meta.Description || "";

  if (
    candidate &&
    (
      candidate.includes("Negative prompt:") ||
      candidate.includes("Steps:") ||
      candidate.includes("Sampler:") ||
      candidate.includes("CFG scale:")
    )
  ) {
    meta.parameters = candidate;
  }

  return meta;
}


// ------------------------------------------------------------
// Metadata Parsing
// ------------------------------------------------------------

function tryParseJson(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}


function parseAutomatic1111Parameters(parametersText) {
  const raw = String(parametersText || "").trim();

  if (!raw) {
    return {};
  }

  const meta = {
    raw_parameters: raw,
  };

  const negativeMarker = "Negative prompt:";
  const stepsMarker = "Steps:";

  const negIdx = raw.indexOf(negativeMarker);
  const stepsIdx = raw.indexOf(stepsMarker);

  if (negIdx >= 0) {
    meta.prompt = raw.slice(0, negIdx).trim();

    if (stepsIdx >= 0 && stepsIdx > negIdx) {
      meta.negativePrompt = raw
        .slice(negIdx + negativeMarker.length, stepsIdx)
        .trim()
        .replace(/,$/, "");
    } else {
      meta.negativePrompt = raw
        .slice(negIdx + negativeMarker.length)
        .trim();
    }
  } else if (stepsIdx >= 0) {
    meta.prompt = raw.slice(0, stepsIdx).trim();
  } else {
    meta.prompt = raw;
  }

  const settingsText = stepsIdx >= 0 ? raw.slice(stepsIdx) : "";

  if (settingsText) {
    const parts = settingsText.split(",").map((part) => part.trim());

    for (const part of parts) {
      const colon = part.indexOf(":");

      if (colon <= 0) {
        continue;
      }

      const key = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      const lower = key.toLowerCase();

      if (lower === "steps") {
        meta.steps = value;
      } else if (lower === "sampler") {
        meta.sampler = value;
      } else if (lower === "schedule type" || lower === "scheduler") {
        meta.scheduler = value;
      } else if (lower === "cfg scale") {
        meta.cfgScale = value;
      } else if (lower === "seed") {
        meta.seed = value;
      } else if (lower === "size") {
        meta.size = value;
      } else if (lower === "model") {
        meta.Model = value;
      } else if (lower === "model hash") {
        meta.modelHash = value;
      } else {
        meta[key] = value;
      }
    }
  }

  return meta;
}


function assignMissing(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value !== null &&
      typeof value !== "undefined" &&
      value !== "" &&
      (
        typeof target[key] === "undefined" ||
        target[key] === null ||
        target[key] === ""
      )
    ) {
      target[key] = value;
    }
  }
}


// ------------------------------------------------------------
// Comfy Prompt Extraction
// ------------------------------------------------------------

function extractComfyPromptsFromPromptJson(promptJson, options = {}) {
  const allowCivitaiFallback = options.allowCivitaiFallback === true;

  const result = {
    positive: "",
    negative: "",
  };

  if (!promptJson || typeof promptJson !== "object") {
    return result;
  }

  const nodes = promptJson;

  const getNodeText = (node) => {
    const text = node?.inputs?.text;

    if (typeof text === "string") {
      return text;
    }

    return "";
  };

  const isTextEncodeNode = (node) => {
    const classType = String(node?.class_type || "").toLowerCase();
    const title = String(node?._meta?.title || "").toLowerCase();

    return (
      classType.includes("cliptextencode") ||
      classType.includes("textencode") ||
      title.includes("clip text encode") ||
      title.includes("positive prompt") ||
      title.includes("negative prompt")
    );
  };

  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== "object") {
      continue;
    }

    if (!isTextEncodeNode(node)) {
      continue;
    }

    const title = String(node?._meta?.title || "").toLowerCase();
    const text = getNodeText(node);

    if (!text) {
      continue;
    }

    if (!result.positive && title.includes("positive")) {
      result.positive = text;
    }

    if (!result.negative && title.includes("negative")) {
      result.negative = text;
    }
  }

  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== "object") {
      continue;
    }

    const classType = String(node.class_type || "").toLowerCase();

    if (!classType.includes("ksampler")) {
      continue;
    }

    const positiveLink = node.inputs?.positive;
    const negativeLink = node.inputs?.negative;

    if (!result.positive && Array.isArray(positiveLink)) {
      const positiveNodeId = String(positiveLink[0]);
      const positiveNode = nodes[positiveNodeId];
      const text = getNodeText(positiveNode);

      if (text) {
        result.positive = text;
      }
    }

    if (!result.negative && Array.isArray(negativeLink)) {
      const negativeNodeId = String(negativeLink[0]);
      const negativeNode = nodes[negativeNodeId];
      const text = getNodeText(negativeNode);

      if (text) {
        result.negative = text;
      }
    }
  }

  if (!result.positive || !result.negative) {
    const textNodes = [];

    for (const node of Object.values(nodes)) {
      if (!node || typeof node !== "object") {
        continue;
      }

      if (!isTextEncodeNode(node)) {
        continue;
      }

      const text = getNodeText(node);

      if (text) {
        textNodes.push(text);
      }
    }

    if (!result.positive && textNodes[0]) {
      result.positive = textNodes[0];
    }

    if (!result.negative && textNodes[1]) {
      result.negative = textNodes[1];
    }
  }

  if (allowCivitaiFallback && (!result.positive || !result.negative)) {
    const civitaiPrompts = extractPromptsFromCivitaiSelectionData(promptJson);

    if (!result.positive && civitaiPrompts.positive) {
      result.positive = civitaiPrompts.positive;
    }

    if (!result.negative && civitaiPrompts.negative) {
      result.negative = civitaiPrompts.negative;
    }
  }

  return result;
}


function extractPromptsFromCivitaiSelectionData(promptJson) {
  const result = {
    positive: "",
    negative: "",
  };

  if (!promptJson || typeof promptJson !== "object") {
    return result;
  }

  for (const node of Object.values(promptJson)) {
    if (!node || typeof node !== "object") {
      continue;
    }

    const classType = String(node.class_type || "");

    if (classType !== "CivitaiGalleryNode") {
      continue;
    }

    const selectionData = node.inputs?.selection_data;

    if (typeof selectionData !== "string" || !selectionData.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(selectionData);
      const meta = parsed?.item?.meta || {};

      result.positive = firstValue(
        meta.prompt,
        meta.positivePrompt,
        meta.positive
      );

      result.negative = firstValue(
        meta.negativePrompt,
        meta.negative
      );

      if (result.positive || result.negative) {
        return result;
      }
    } catch {}
  }

  return result;
}


function extractComfyGenerationInfoFromPromptJson(promptJson) {
  const info = {};

  if (!promptJson || typeof promptJson !== "object") {
    return info;
  }

  for (const node of Object.values(promptJson)) {
    if (!node || typeof node !== "object") {
      continue;
    }

    const classType = String(node.class_type || "");
    const inputs = node.inputs || {};

    if (classType === "UNETLoader") {
      if (inputs.unet_name && !info.unet_name) {
        info.unet_name = String(inputs.unet_name);
      }

      if (inputs.weight_dtype && !info.weight_dtype) {
        info.weight_dtype = String(inputs.weight_dtype);
      }
    }

    if (classType === "CheckpointLoaderSimple") {
      if (inputs.ckpt_name && !info.ckpt_name) {
        info.ckpt_name = String(inputs.ckpt_name);
      }
    }

    if (classType === "VAELoader") {
      if (inputs.vae_name && !info.vae_name) {
        info.vae_name = String(inputs.vae_name);
      }
    }

    if (classType === "CLIPLoaderGGUF") {
      if (inputs.clip_name && !info.clip_name) {
        info.clip_name = String(inputs.clip_name);
      }

      if (inputs.type && !info.clip_type) {
        info.clip_type = String(inputs.type);
      }
    }

    if (classType === "KSampler") {
      if (inputs.seed != null && info.seed == null) {
        info.seed = String(inputs.seed);
      }

      if (inputs.steps != null && info.steps == null) {
        info.steps = String(inputs.steps);
      }

      if (inputs.cfg != null && info.cfgScale == null) {
        info.cfgScale = String(inputs.cfg);
      }

      if (inputs.sampler_name && !info.sampler) {
        info.sampler = String(inputs.sampler_name);
      }

      if (inputs.scheduler && !info.scheduler) {
        info.scheduler = String(inputs.scheduler);
      }

      if (inputs.denoise != null && info.denoise == null) {
        info.denoise = String(inputs.denoise);
      }
    }
  }

  return info;
}

// ------------------------------------------------------------
// Comfy Workflow Extraction
// ------------------------------------------------------------

function extractComfyPromptsFromWorkflowJson(workflowJson) {
  const result = {
    positive: "",
    negative: "",
  };

  const nodes = Array.isArray(workflowJson?.nodes)
    ? workflowJson.nodes
    : [];

  const links = Array.isArray(workflowJson?.links)
    ? workflowJson.links
    : [];

  if (!nodes.length) {
    return result;
  }

  const nodeById = new Map();
  const linkById = new Map();

  for (const node of nodes) {
    nodeById.set(String(node.id), node);
  }

  for (const link of links) {
    if (Array.isArray(link) && link.length >= 6) {
      linkById.set(String(link[0]), {
        id: link[0],
        originNodeId: String(link[1]),
        originSlot: link[2],
        targetNodeId: String(link[3]),
        targetSlot: link[4],
        type: link[5],
      });
    }
  }

  const isTextEncodeNode = (node) => {
    const type = String(node?.type || node?.class_type || "").toLowerCase();
    const title = String(node?.title || node?._meta?.title || "").toLowerCase();

    return (
      type.includes("cliptextencode") ||
      type.includes("textencode") ||
      title.includes("clip text encode") ||
      title.includes("positive prompt") ||
      title.includes("negative prompt")
    );
  };

  const getWidgetText = (node) => {
    const values = Array.isArray(node?.widgets_values)
      ? node.widgets_values
      : [];

    const strings = values
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!strings.length) {
      return "";
    }

    return strings.join("\n");
  };

  const getLinkedOriginNodeForInput = (node, inputName) => {
    const inputs = Array.isArray(node?.inputs)
      ? node.inputs
      : [];

    const input = inputs.find((item) => {
      return String(item?.name || "").toLowerCase() === inputName;
    });

    if (!input || input.link == null) {
      return null;
    }

    const linkInfo = linkById.get(String(input.link));

    if (!linkInfo) {
      return null;
    }

    return nodeById.get(String(linkInfo.originNodeId)) || null;
  };

  for (const node of nodes) {
    if (!isTextEncodeNode(node)) {
      continue;
    }

    const title = String(node?.title || node?._meta?.title || "").toLowerCase();
    const text = getWidgetText(node);

    if (!text) {
      continue;
    }

    if (!result.positive && title.includes("positive")) {
      result.positive = text;
    }

    if (!result.negative && title.includes("negative")) {
      result.negative = text;
    }
  }

  for (const node of nodes) {
    const type = String(node?.type || node?.class_type || "").toLowerCase();

    if (!type.includes("ksampler")) {
      continue;
    }

    const positiveNode = getLinkedOriginNodeForInput(node, "positive");
    const negativeNode = getLinkedOriginNodeForInput(node, "negative");

    if (!result.positive && positiveNode) {
      const text = getWidgetText(positiveNode);

      if (text) {
        result.positive = text;
      }
    }

    if (!result.negative && negativeNode) {
      const text = getWidgetText(negativeNode);

      if (text) {
        result.negative = text;
      }
    }
  }

  if (!result.positive || !result.negative) {
    const textNodes = nodes
      .filter(isTextEncodeNode)
      .map(getWidgetText)
      .filter(Boolean);

    if (!result.positive && textNodes[0]) {
      result.positive = textNodes[0];
    }

    if (!result.negative && textNodes[1]) {
      result.negative = textNodes[1];
    }
  }

  return result;
}


function extractComfyGenerationInfoFromWorkflowJson(workflowJson) {
  const info = {};

  const nodes = Array.isArray(workflowJson?.nodes)
    ? workflowJson.nodes
    : [];

  for (const node of nodes) {
    const type = String(node?.type || node?.class_type || "");
    const values = Array.isArray(node?.widgets_values)
      ? node.widgets_values
      : [];

    if (type === "UNETLoader") {
      if (values[0] && !info.unet_name) {
        info.unet_name = String(values[0]);
      }

      if (values[1] && !info.weight_dtype) {
        info.weight_dtype = String(values[1]);
      }
    }

    if (type === "CheckpointLoaderSimple") {
      if (values[0] && !info.ckpt_name) {
        info.ckpt_name = String(values[0]);
      }
    }

    if (type === "VAELoader") {
      if (values[0] && !info.vae_name) {
        info.vae_name = String(values[0]);
      }
    }

    if (type === "CLIPLoaderGGUF") {
      if (values[0] && !info.clip_name) {
        info.clip_name = String(values[0]);
      }

      if (values[1] && !info.clip_type) {
        info.clip_type = String(values[1]);
      }
    }

    if (type === "KSampler") {
      if (values[0] != null && info.seed == null) {
        info.seed = String(values[0]);
      }

      if (values[2] != null && info.steps == null) {
        info.steps = String(values[2]);
      }

      if (values[3] != null && info.cfgScale == null) {
        info.cfgScale = String(values[3]);
      }

      if (values[4] && !info.sampler) {
        info.sampler = String(values[4]);
      }

      if (values[5] && !info.scheduler) {
        info.scheduler = String(values[5]);
      }

      if (values[6] != null && info.denoise == null) {
        info.denoise = String(values[6]);
      }
    }
  }

  return info;
}


// ------------------------------------------------------------
// Local Metadata Normalization
// ------------------------------------------------------------

function normalizeLocalImageMetadata(rawMeta) {
  const meta = {};

  for (const [key, value] of Object.entries(rawMeta || {})) {
    meta[key] = value;
  }

  const parsedJsonFields = parseJsonMetadataFields(rawMeta);
  const promptJson =
    parsedJsonFields.prompt ||
    tryParseJson(rawMeta?.prompt) ||
    tryParseJson(rawMeta?.Prompt) ||
    null;

  const workflowJson =
    parsedJsonFields.workflow ||
    tryParseJson(rawMeta?.workflow) ||
    tryParseJson(rawMeta?.Workflow) ||
    null;

  if (promptJson) {
    meta.comfy_prompt = promptJson;

    const comfyPrompts = extractComfyPromptsFromPromptJson(promptJson, {
      allowCivitaiFallback: false,
    });

    const comfyInfo = extractComfyGenerationInfoFromPromptJson(promptJson);

    meta.prompt = comfyPrompts.positive || "";
    meta.negativePrompt = comfyPrompts.negative || "";

    assignMissing(meta, comfyInfo);
  }

  if (workflowJson) {
    meta.comfy_workflow = workflowJson;

    const workflowPrompts = extractComfyPromptsFromWorkflowJson(workflowJson);
    const workflowInfo = extractComfyGenerationInfoFromWorkflowJson(workflowJson);

    if (!meta.prompt && workflowPrompts.positive) {
      meta.prompt = workflowPrompts.positive;
    }

    if (!meta.negativePrompt && workflowPrompts.negative) {
      meta.negativePrompt = workflowPrompts.negative;
    }

    assignMissing(meta, workflowInfo);
  }

  const parameters =
    rawMeta?.parameters ||
    rawMeta?.Parameters ||
    rawMeta?.Description ||
    rawMeta?.UserComment ||
    "";

  if (parameters && typeof parameters === "string") {
    const parsedParams = parseAutomatic1111Parameters(parameters);

    assignMissing(meta, parsedParams);
  }

  for (const parsedValue of Object.values(parsedJsonFields || {})) {
    const genericPrompts = extractPromptPairFromGenericJson(parsedValue);

    if (!meta.prompt && genericPrompts.positive) {
      meta.prompt = genericPrompts.positive;
    }

    if (!meta.negativePrompt && genericPrompts.negative) {
      meta.negativePrompt = genericPrompts.negative;
    }
  }

  if (!meta.Model) {
    meta.Model = meta.ckpt_name || meta.unet_name || meta.model || meta.modelName || "";
  }

  if (!meta.prompt) {
    meta.prompt = firstValue(
      rawMeta?.positive,
      rawMeta?.Positive,
      rawMeta?.positivePrompt,
      rawMeta?.PositivePrompt
    );
  }

  if (!meta.negativePrompt) {
    meta.negativePrompt = firstValue(
      rawMeta?.negative,
      rawMeta?.Negative,
      rawMeta?.negativePrompt,
      rawMeta?.NegativePrompt
    );
  }

  if (typeof meta.prompt === "string") {
    const trimmed = meta.prompt.trim();

    if (
      trimmed.startsWith("{") &&
      trimmed.includes("class_type") &&
      trimmed.includes("inputs")
    ) {
      meta.prompt = "";
    }
  }

  if (typeof meta.negativePrompt === "string") {
    const trimmed = meta.negativePrompt.trim();

    if (
      trimmed.startsWith("{") &&
      trimmed.includes("class_type") &&
      trimmed.includes("inputs")
    ) {
      meta.negativePrompt = "";
    }
  }

  return meta;
}


function buildLocalInfoText({ file, meta, width, height }) {
  const lines = [];

  lines.push("Source: Local image");

  if (file?.name) {
    lines.push(`File: ${file.name}`);
  }

  if (file?.type) {
    lines.push(`Type: ${file.type}`);
  }

  if (file?.size != null) {
    lines.push(`Size: ${file.size} bytes`);
  }

  const imageSizeText = buildImageSizeText(width, height);

  if (imageSizeText) {
    lines.push(`Image Size: ${imageSizeText}`);
  }

  const model = firstValue(
    meta?.Model,
    meta?.model,
    meta?.["Model type"],
    meta?.ckpt_name,
    meta?.unet_name,
    meta?.ecosystem
  );

  const checkpoint = meta?.ckpt_name || "";
  const unet = meta?.unet_name || "";
  const weightDtype = meta?.weight_dtype || "";
  const vae = meta?.vae_name || "";
  const clip = meta?.clip_name || "";
  const clipType = meta?.clip_type || "";

  const steps = firstValue(
    meta?.steps,
    meta?.Steps
  );

  const cfg = firstValue(
    meta?.cfgScale,
    meta?.["CFG scale"],
    meta?.CFG
  );

  const sampler = firstValue(
    meta?.sampler,
    meta?.Sampler
  );

  const scheduler = firstValue(
    meta?.scheduler,
    meta?.Scheduler,
    meta?.["Schedule type"],
    meta?.schedule_type,
    meta?.scheduleType
  );

  const seed = firstValue(
    meta?.seed,
    meta?.Seed
  );

  const denoise = meta?.denoise || "";

  if (model) {
    lines.push(`Model: ${model}`);
  }

  if (checkpoint && checkpoint !== model) {
    lines.push(`Checkpoint: ${checkpoint}`);
  }

  if (unet && unet !== model) {
    lines.push(`UNET: ${unet}`);
  }

  if (weightDtype) {
    lines.push(`Weight dtype: ${weightDtype}`);
  }

  if (vae) {
    lines.push(`VAE: ${vae}`);
  }

  if (clip) {
    lines.push(`CLIP: ${clip}`);
  }

  if (clipType) {
    lines.push(`CLIP Type: ${clipType}`);
  }

  if (steps) {
    lines.push(`Steps: ${steps}`);
  }

  if (cfg) {
    lines.push(`CFG: ${cfg}`);
  }

  if (sampler) {
    lines.push(`Sampler: ${sampler}`);
  }

  if (scheduler) {
    lines.push(`Scheduler: ${scheduler}`);
  }

  if (seed) {
    lines.push(`Seed: ${seed}`);
  }

  if (denoise) {
    lines.push(`Denoise: ${denoise}`);
  }

  return lines.join("\n");
}


// ------------------------------------------------------------
// Image Dimension Reading
// ------------------------------------------------------------

function readImageDimensionsFromUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      resolve({
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      });
    };

    img.onerror = () => {
      resolve({
        width: 0,
        height: 0,
      });
    };

    img.src = url;
  });
}


async function uploadLocalImageToBackend(file) {
  const form = new FormData();
  form.append("file", file, file.name || "image");

  const response = await api.fetchApi(ROUTES.uploadImage, {
    method: "POST",
    body: form,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.error || !data?.upload_id) {
    throw new Error(data?.error || "Backend image upload failed.");
  }

  return data;
}

function parseJsonMetadataFields(rawMeta) {
  const result = {};

  for (const [key, value] of Object.entries(rawMeta || {})) {
    if (typeof value !== "string") {
      continue;
    }

    const parsed = tryParseJson(value);

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    result[key] = parsed;

    const lower = String(key || "").toLowerCase();

    if (lower.includes("workflow")) {
      result.workflow = parsed;
    }

    if (lower.includes("prompt")) {
      result.prompt = parsed;
    }
  }

  return result;
}

function extractPromptPairFromGenericJson(value) {
  const result = {
    positive: "",
    negative: "",
  };
  const seen = new Set();

  const visit = (item, keyHint = "") => {
    if (!item || (result.positive && result.negative)) {
      return;
    }

    if (typeof item === "string") {
      const lower = String(keyHint || "").toLowerCase();

      if (!result.negative && lower.includes("negative")) {
        result.negative = item;
      } else if (
        !result.positive &&
        (lower.includes("positive") || lower.includes("prompt") || lower.includes("text"))
      ) {
        result.positive = item;
      }

      return;
    }

    if (typeof item !== "object" || seen.has(item)) {
      return;
    }

    seen.add(item);

    const directFields = [
      ["positive", "positive"],
      ["positivePrompt", "positive"],
      ["prompt", "positive"],
      ["negative", "negative"],
      ["negativePrompt", "negative"],
    ];

    for (const [key, target] of directFields) {
      if (typeof item[key] === "string" && !result[target]) {
        result[target] = item[key];
      }
    }

    if (item.inputs && typeof item.inputs === "object") {
      visit(item.inputs.text, "text");
      visit(item.inputs.positive, "positive");
      visit(item.inputs.negative, "negative");
    }

    for (const [key, child] of Object.entries(item)) {
      visit(child, key);
    }
  };

  visit(value);
  return result;
}

// ------------------------------------------------------------
// Local Upload
// ------------------------------------------------------------

async function openLocalImagePicker(node) {
  const input = document.createElement("input");

  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/*";
  input.style.display = "none";

  input.onchange = async () => {
    const file = input.files?.[0];

    input.remove();

    if (!file) {
      return;
    }

    await handleLocalImageFile(node, file);
  };

  document.body.appendChild(input);
  input.click();
}


async function handleLocalImageFile(node, file) {
  if (!file || !file.type?.startsWith("image/")) {
    alert("Please choose an image file.");
    return;
  }

  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);

    let rawMeta = {};
    const fileNameLower = String(file.name || "").toLowerCase();

    if (file.type === "image/png" || fileNameLower.endsWith(".png")) {
      rawMeta = parsePngMetadata(arrayBuffer);
    } else if (
      file.type === "image/jpeg" ||
      fileNameLower.endsWith(".jpg") ||
      fileNameLower.endsWith(".jpeg")
    ) {
      rawMeta = parseJpegExifMetadata(arrayBuffer);
    }

    const objectUrl = URL.createObjectURL(file);
    const dimensions = await readImageDimensionsFromUrl(objectUrl);
    const uploadInfo = await uploadLocalImageToBackend(file);

    const normalizedMeta = normalizeLocalImageMetadata(rawMeta);
    const prompts = extractPrompts(normalizedMeta);

    let infoText = buildLocalInfoText({
      file,
      meta: normalizedMeta,
      width: dimensions.width,
      height: dimensions.height,
    });

    if (!Object.keys(rawMeta || {}).length) {
      infoText += "\n\nMetadata: No readable AI generation metadata found.";
    }

    await applyImageToInspectorNode(node, {
      source: "local",
      url: objectUrl,
      pageUrl: "",
      filename: file.name,
      localUploadId: uploadInfo.upload_id || "",
      backendUrl: uploadInfo.upload_id || "",
      type: file.type,
      size: file.size,

      width: dimensions.width,
      height: dimensions.height,
      imageSizeText: buildImageSizeText(
        dimensions.width,
        dimensions.height
      ),

      positive: prompts.positive || "",
      negative: prompts.negative || "",
      infoText,

      meta: normalizedMeta,
      rawMeta,
    });
  } catch (err) {
    console.warn("[ImagePlus Inspector] local image parse failed", err);

    const fallbackInfo =
      `Source: Local image\n` +
      `File: ${file.name}\n` +
      `Type: ${file.type}\n` +
      `Size: ${file.size} bytes\n\n` +
      `Metadata parse failed: ${err?.message || err}`;

    await applyImageToInspectorNode(node, {
      source: "local",
      url: URL.createObjectURL(file),
      pageUrl: "",
      filename: file.name,
      type: file.type,
      size: file.size,
      positive: "",
      negative: "",
      infoText: fallbackInfo,
      meta: {},
      rawMeta: {},
    });

    alert("Failed to read image metadata. See browser console for details.");
  }
}

// ------------------------------------------------------------
// Drag Position
// ------------------------------------------------------------

function getCanvasPosFromDragEvent(event) {
  try {
    const canvas = app?.canvas;

    if (!canvas) {
      return null;
    }

    if (typeof canvas.convertEventToCanvasOffset === "function") {
      return canvas.convertEventToCanvasOffset(event);
    }

    const rect = canvas.canvas?.getBoundingClientRect?.();

    if (!rect) {
      return null;
    }

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const ds = canvas.ds;

    if (ds && Array.isArray(ds.offset)) {
      return [
        x / ds.scale - ds.offset[0],
        y / ds.scale - ds.offset[1],
      ];
    }

    return [x, y];
  } catch {
    return null;
  }
}


function isPointInRect(x, y, rect) {
  if (!rect) {
    return false;
  }

  return (
    x >= rect.x &&
    x <= rect.x + rect.w &&
    y >= rect.y &&
    y <= rect.y + rect.h
  );
}


function getLocalNodePoint(node, canvasX, canvasY) {
  const nodeX = node.pos?.[0] || 0;
  const nodeY = node.pos?.[1] || 0;

  return [
    canvasX - nodeX,
    canvasY - nodeY,
  ];
}


// ------------------------------------------------------------
// Drag Target
// ------------------------------------------------------------

function eventHasImageFile(event) {
  const items = Array.from(event.dataTransfer?.items || []);

  return items.some((item) => {
    return item.kind === "file" && item.type?.startsWith("image/");
  });
}


function getImageFileFromDropEvent(event) {
  const files = Array.from(event.dataTransfer?.files || []);

  return files.find((file) => file.type?.startsWith("image/")) || null;
}


function findInspectorNodeAtDropZone(event) {
  const graph = app?.graph;

  if (!graph || !Array.isArray(graph._nodes)) {
    return null;
  }

  const canvasPos = getCanvasPosFromDragEvent(event);

  if (!canvasPos) {
    return null;
  }

  const [canvasX, canvasY] = canvasPos;

  for (let i = graph._nodes.length - 1; i >= 0; i--) {
    const node = graph._nodes[i];

    if (!isImagePlusInspectorNode(node)) {
      continue;
    }

    ensureInspectorState(node);

    const nodeX = node.pos?.[0] || 0;
    const nodeY = node.pos?.[1] || 0;
    const nodeW = node.size?.[0] || 0;
    const nodeH = node.size?.[1] || 0;

    if (
      canvasX < nodeX ||
      canvasX > nodeX + nodeW ||
      canvasY < nodeY ||
      canvasY > nodeY + nodeH
    ) {
      continue;
    }

    const [localX, localY] = getLocalNodePoint(node, canvasX, canvasY);

    if (isPointInRect(localX, localY, node.__imagePlusDropRect)) {
      return node;
    }
  }

  return null;
}


function clearInspectorDragState() {
  const graph = app?.graph;

  if (!graph || !Array.isArray(graph._nodes)) {
    return;
  }

  for (const node of graph._nodes) {
    if (!isImagePlusInspectorNode(node)) {
      continue;
    }

    if (node.__imagePlusDragOver) {
      node.__imagePlusDragOver = false;
      node.graph?.setDirtyCanvas(true, true);
    }
  }
}


// ------------------------------------------------------------
// Drag Guard
// ------------------------------------------------------------

function installImagePlusDropGuard() {
  if (window.__imagePlusInspectorDropGuardInstalled) {
    return;
  }

  window.__imagePlusInspectorDropGuardInstalled = true;

  document.addEventListener(
    "dragover",
    (event) => {
      if (!eventHasImageFile(event)) {
        return;
      }

      const node = findInspectorNodeAtDropZone(event);

      clearInspectorDragState();

      if (!node) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      event.dataTransfer.dropEffect = "copy";

      node.__imagePlusDragOver = true;
      node.graph?.setDirtyCanvas(true, true);
    },
    true
  );

  document.addEventListener(
    "dragleave",
    () => {
      clearInspectorDragState();
    },
    true
  );

  document.addEventListener(
    "drop",
    async (event) => {
      if (!eventHasImageFile(event)) {
        return;
      }

      const node = findInspectorNodeAtDropZone(event);

      clearInspectorDragState();

      if (!node) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const file = getImageFileFromDropEvent(event);

      if (!file) {
        return;
      }

      await handleLocalImageFile(node, file);

      node.graph?.setDirtyCanvas(true, true);
    },
    true
  );
}


installImagePlusDropGuard();

// ------------------------------------------------------------
// Gallery UI Helpers
// ------------------------------------------------------------

let currentGalleryAbort = null;
let nextGalleryCursor = null;
let nextGalleryPageUrl = null;
let seenGalleryIds = new Set();


function stylizeOverlayButton(button) {
  Object.assign(button.style, {
    background: "#3a3a3a",
    border: "1px solid #666",
    color: "#eeeeee",
    padding: "8px 12px",
    borderRadius: "6px",
    cursor: "pointer",
  });
}


function makeOverlaySelect(label, options, defaultValue) {
  const container = document.createElement("label");

  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "12px",
  });

  const labelElement = document.createElement("span");

  labelElement.textContent = label;
  labelElement.style.opacity = "0.8";

  const select = document.createElement("select");

  Object.assign(select.style, {
    background: "#2a2a2a",
    border: "1px solid #555",
    color: "#dddddd",
    padding: "6px 8px",
    borderRadius: "6px",
  });

  for (const [text, value] of options) {
    const option = document.createElement("option");

    option.textContent = text;
    option.value = value;

    select.appendChild(option);
  }

  select.value = defaultValue;

  container.append(labelElement, select);

  return {
    container,
    select,
  };
}


function makeOverlayInput(label, defaultValue, type = "text", attrs = {}) {
  const container = document.createElement("label");

  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    fontSize: "12px",
  });

  const labelElement = document.createElement("span");

  labelElement.textContent = label;
  labelElement.style.opacity = "0.8";

  const input = document.createElement("input");

  input.type = type;
  input.value = defaultValue;

  Object.assign(input.style, {
    background: "#2a2a2a",
    border: "1px solid #555",
    color: "#dddddd",
    padding: "6px 8px",
    borderRadius: "6px",
  });

  for (const [key, value] of Object.entries(attrs)) {
    input.setAttribute(key, value);
  }

  container.append(labelElement, input);

  return {
    container,
    input,
  };
}


function cursorFromNextPage(url) {
  try {
    if (!url) {
      return null;
    }

    const parsed = new URL(url);
    const cursor = parsed.searchParams.get("cursor");

    return cursor ? String(cursor) : null;
  } catch {
    return null;
  }
}


function closeFullGallery() {
  const overlay = document.getElementById("imageplus-gallery-overlay");

  if (overlay) {
    overlay.remove();
  }
}


// ------------------------------------------------------------
// CivitAI Normalization
// ------------------------------------------------------------

function buildPageUrl(imageId, postId, options = {}) {
  const settings = loadSettings();
  const pageDomain = normalizePageDomain(
    options.pageDomain ?? settings.pageDomain ?? "auto"
  );

  const forcedBase = pageBaseFromSetting(pageDomain);
  const explicitBase = pageBaseFromUrl(options.explicitPageUrl);
  const sourceBase = pageBaseFromUrl(options.sourcePageUrl);

  const base = forcedBase || explicitBase || sourceBase || PAGE_BASES.com;

  if (imageId) {
    return `${base}/images/${imageId}`;
  }

  if (postId) {
    return `${base}/posts/${postId}`;
  }

  return "";
}


function normalizeCivitaiItemForInspector(item, settings = {}) {
  const normalized = normalizeInspectorPayload({
    ...item,
    source: "civitai",
  });

  const imageId = normalized.id || item?.imageId || "";
  const postId = normalized.postId || item?.post_id || "";

  let pageUrl = normalized.pageUrl || "";

  if (!pageUrl) {
    pageUrl = buildPageUrl(imageId, postId, {
      explicitPageUrl: item?.pageUrl || item?.page_url || "",
      sourcePageUrl: item?.sourcePageUrl || item?.source_page_url || "",
      pageDomain: item?.pageDomain || settings.pageDomain || "auto",
    });
  }

  return normalizeInspectorPayload({
    ...normalized,
    source: "civitai",
    id: imageId,
    postId,
    pageUrl,
    sourcePageUrl: item?.sourcePageUrl || item?.source_page_url || "",
    pageDomain: item?.pageDomain || settings.pageDomain || "auto",
  });
}


// ------------------------------------------------------------
// Fetch URL
// ------------------------------------------------------------

function openFetchUrlDialog(node) {
  ensureInspectorState(node);

  openModalEditor({
    title: "Fetch Image from URL",
    value: node.__imagePlusFetchUrl || "",
    onSave: async (value) => {
      node.__imagePlusFetchUrl = String(value || "").trim();
      node.graph?.setDirtyCanvas(true, true);
    },
  });
}


async function fetchAndApplyUrl(node, url) {
  const trimmed = String(url || "").trim();

  if (!trimmed) {
    alert("Paste a CivitAI /posts/<id> or /images/<id> URL.");
    return;
  }

  const settings = loadSettings();

  try {
    const params = new URLSearchParams();

    params.set("url", trimmed);

    if (settings.nsfw) {
      params.set("nsfw", settings.nsfw);
    }

    if (settings.pageDomain) {
      params.set("pageDomain", settings.pageDomain);
    }

    const response = await api.fetchApi(
      `${ROUTES.imageByUrl}?${params.toString()}`
    );

    const data = await response.json();

    if (data?.error) {
      const message = [
        "Fetch failed.",
        data.error,
        data.status ? `Status: ${data.status}` : "",
        data.details ? `Details: ${String(data.details).slice(0, 500)}` : "",
        data.hint ? `Hint: ${data.hint}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      alert(message);
      return;
    }

    const item = data?.item;

    if (!item || !item.url) {
      alert("Could not resolve an image from that URL.");
      return;
    }

    const normalized = normalizeCivitaiItemForInspector(
      {
        ...item,
        sourcePageUrl: trimmed,
        pageUrl: item.pageUrl || trimmed,
      },
      settings
    );

    await applyImageToInspectorNode(node, normalized);
  } catch (err) {
    console.warn("[ImagePlus Inspector] fetch URL failed", err);
    alert("Failed to fetch image from the provided URL.");
  }
}


// ------------------------------------------------------------
// Gallery Fetch
// ------------------------------------------------------------

async function fetchGalleryPage(node, grid, settings, cursor, append = false) {
  if (!append && currentGalleryAbort) {
    currentGalleryAbort.abort();
  }

  currentGalleryAbort = new AbortController();

  if (!append) {
    grid.innerHTML = "";

    const spinner = document.createElement("div");

    spinner.textContent = "Loading…";
    spinner.style.color = "#bbbbbb";
    spinner.style.fontSize = "12px";
    spinner.style.padding = "8px";

    grid.appendChild(spinner);

    nextGalleryCursor = null;
    nextGalleryPageUrl = null;
    seenGalleryIds = new Set();
  }

  const params = new URLSearchParams();

  params.set("sort", settings.sort);
  params.set("period", settings.period);
  params.set("limit", String(settings.limit ?? 36));
  params.set("nsfw", settings.nsfw);
  params.set("pageDomain", settings.pageDomain || "auto");

  if (cursor != null && cursor !== "") {
    params.set("cursor", String(cursor));
  }

  try {
    const response = await api.fetchApi(
      `${ROUTES.images}?${params.toString()}`,
      {
        signal: currentGalleryAbort.signal,
      }
    );

    const data = await response.json();

    if (data?.error) {
      grid.innerHTML = "";

      const errorElement = document.createElement("div");

      errorElement.textContent = data.error || "Failed to load gallery.";
      errorElement.style.color = "#ffb8b8";
      errorElement.style.fontSize = "13px";
      errorElement.style.padding = "8px";

      grid.appendChild(errorElement);

      return {
        hasMore: false,
      };
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const metadata = data.metadata || {};

    nextGalleryCursor = metadata.nextCursor ?? null;
    nextGalleryPageUrl = metadata.nextPage ?? null;

    if (!append) {
      grid.innerHTML = "";
    }

    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const itemId = item?.id != null ? String(item.id) : null;

      if (itemId && seenGalleryIds.has(itemId)) {
        continue;
      }

      if (itemId) {
        seenGalleryIds.add(itemId);
      }

      if (!item?.url) {
        continue;
      }

      const normalized = normalizeCivitaiItemForInspector(
        {
          ...item,
          pageDomain: item?.pageDomain || settings.pageDomain || "auto",
        },
        settings
      );

      const card = document.createElement("div");

      Object.assign(card.style, {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      });

      const image = document.createElement("img");

      image.src = buildProxyImageUrl(
        normalized.url,
        normalized.pageUrl
      );

      image.loading = "lazy";

      Object.assign(image.style, {
        width: "100%",
        borderRadius: "6px",
        cursor: "pointer",
        background: "#111111",
      });

      image.onclick = async (event) => {
        event.stopPropagation();

        await applyImageToInspectorNode(node, normalized);
        closeFullGallery();
      };

      card.appendChild(image);

      if (normalized.imageSizeText || normalized.pageUrl) {
        const caption = document.createElement("div");

        caption.textContent = normalized.imageSizeText || normalized.pageUrl;

        Object.assign(caption.style, {
          color: "#aaaaaa",
          fontSize: "11px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        });

        card.appendChild(caption);
      }

      fragment.appendChild(card);
    }

    grid.appendChild(fragment);

    const derivedCursor = cursorFromNextPage(nextGalleryPageUrl);
    const hasMore = nextGalleryCursor != null || derivedCursor != null;

    return {
      hasMore,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        hasMore: false,
      };
    }

    console.warn("[ImagePlus Inspector] gallery fetch failed", err);

    if (!append) {
      grid.innerHTML = "";

      const errorElement = document.createElement("div");

      errorElement.textContent = "Failed to load gallery.";
      errorElement.style.color = "#ffb8b8";
      errorElement.style.fontSize = "13px";
      errorElement.style.padding = "8px";

      grid.appendChild(errorElement);
    }

    return {
      hasMore: false,
    };
  }
}


// ------------------------------------------------------------
// Gallery Overlay
// ------------------------------------------------------------

async function openFullGallery(node) {
  if (document.getElementById("imageplus-gallery-overlay")) {
    return;
  }

  const settings = loadSettings();

  const overlay = document.createElement("div");

  overlay.id = "imageplus-gallery-overlay";

  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.86)",
    zIndex: "10000",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    color: "#dddddd",
    fontFamily: "system-ui, sans-serif",
  });

  const header = document.createElement("div");

  Object.assign(header.style, {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    padding: "12px 16px",
    background: "#1f1f1f",
    borderBottom: "1px solid #444",
  });

  const sortSelect = makeOverlaySelect(
    "Sort",
    [
      ["Most Reactions", "Most Reactions"],
      ["Most Comments", "Most Comments"],
      ["Newest", "Newest"],
    ],
    settings.sort
  );

  const periodSelect = makeOverlaySelect(
    "Period",
    [
      ["AllTime", "AllTime"],
      ["Month", "Month"],
      ["Week", "Week"],
      ["Day", "Day"],
    ],
    settings.period
  );

  const limitInput = makeOverlayInput(
    "Limit",
    String(settings.limit ?? 36),
    "number",
    {
      min: "12",
      max: "200",
    }
  );

  const nsfwSelect = makeOverlaySelect(
    "NSFW",
    [
      ["None", "None"],
      ["Soft", "Soft"],
      ["Mature", "Mature"],
      ["X", "X"],
    ],
    settings.nsfw
  );

  const pageDomainSelect = makeOverlaySelect(
    "Page Links",
    [
      ["Auto", "auto"],
      ["Civitai.com", "com"],
      ["Civitai.red", "red"],
    ],
    settings.pageDomain ?? "auto"
  );

  const searchButton = document.createElement("button");
  searchButton.textContent = "Search";
  stylizeOverlayButton(searchButton);

  const closeButton = document.createElement("button");
  closeButton.textContent = "Close";
  closeButton.style.marginLeft = "auto";
  stylizeOverlayButton(closeButton);

  header.append(
    sortSelect.container,
    periodSelect.container,
    limitInput.container,
    nsfwSelect.container,
    pageDomainSelect.container,
    searchButton,
    closeButton
  );

  const gridWrap = document.createElement("div");

  Object.assign(gridWrap.style, {
    padding: "16px",
    overflow: "auto",
  });

  const grid = document.createElement("div");

  Object.assign(grid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "12px",
    alignItems: "start",
  });

  gridWrap.appendChild(grid);

  const footer = document.createElement("div");

  Object.assign(footer.style, {
    display: "flex",
    gap: "12px",
    padding: "12px 16px",
    borderTop: "1px solid #444",
    background: "#1f1f1f",
    alignItems: "center",
  });

  const loadMoreButton = document.createElement("button");

  loadMoreButton.textContent = "Load more";
  stylizeOverlayButton(loadMoreButton);

  const pagingHint = document.createElement("span");

  Object.assign(pagingHint.style, {
    color: "#aaaaaa",
    fontSize: "12px",
  });

  footer.append(loadMoreButton, pagingHint);

  overlay.append(header, gridWrap, footer);
  document.body.appendChild(overlay);

  const readOverlaySettings = () => {
    return {
      sort: sortSelect.select.value,
      period: periodSelect.select.value,
      limit: Number.parseInt(limitInput.input.value || "36", 10),
      nsfw: nsfwSelect.select.value,
      pageDomain: pageDomainSelect.select.value,
    };
  };

  const runSearch = async () => {
    const nextSettings = readOverlaySettings();

    saveSettings(nextSettings);

    pagingHint.textContent = "";

    const result = await fetchGalleryPage(
      node,
      grid,
      nextSettings,
      0,
      false
    );

    loadMoreButton.disabled = !result.hasMore;
    pagingHint.textContent = result.hasMore ? "More images available." : "";
  };

  saveSettings(readOverlaySettings());

  const initialResult = await fetchGalleryPage(
    node,
    grid,
    readOverlaySettings(),
    0,
    false
  );

  loadMoreButton.disabled = !initialResult.hasMore;
  pagingHint.textContent = initialResult.hasMore ? "More images available." : "";

  searchButton.onclick = async () => {
    await runSearch();
  };

  loadMoreButton.onclick = async () => {
    const nextSettings = readOverlaySettings();

    saveSettings(nextSettings);

    let cursor = nextGalleryCursor;

    if (cursor == null) {
      cursor = cursorFromNextPage(nextGalleryPageUrl);
    }

    if (cursor == null) {
      loadMoreButton.disabled = true;
      pagingHint.textContent = "";
      return;
    }

    const result = await fetchGalleryPage(
      node,
      grid,
      nextSettings,
      cursor,
      true
    );

    loadMoreButton.disabled = !result.hasMore;
    pagingHint.textContent = result.hasMore ? "More images available." : "";
  };

  closeButton.onclick = () => closeFullGallery();

  overlay.onclick = (event) => {
    if (event.target === overlay) {
      closeFullGallery();
    }
  };
}

// ------------------------------------------------------------
// Extension Registration
// ------------------------------------------------------------

app.registerExtension({
  name: "ImagePlus.Inspector.Register",

  nodeCreated(node) {
    if (isImagePlusInspectorNode(node)) {
      setupImagePlusInspectorNode(node);
      return;
    }

    if (isImagePlusPromptNode(node)) {
      setupImagePlusPromptNode(node);
      return;
    }
  },
});

console.log("[ImagePlus Inspector] extension registered");
