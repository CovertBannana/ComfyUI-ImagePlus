import os
import json
import aiohttp
import urllib.request
import urllib.error
import uuid

from aiohttp import web
from urllib.parse import urlparse, parse_qs
from typing import Optional

import server


# ------------------------------------------------------------
# Paths and Settings
# ------------------------------------------------------------

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
API_KEY_FILE = os.path.join(NODE_DIR, "api_key.txt")

FAVOURITES_FILE = os.path.join(
    NODE_DIR,
    "favourites.json"
)

RECENT_FILE = os.path.join(
    NODE_DIR,
    "recent.json"
)

DEFAULT_SITE_API_BASES = (
    "https://civitai.com/api/v1",
    "https://civitai.red/api/v1",
)

DEFAULT_PAGE_BASES = {
    "com": "https://civitai.com",
    "red": "https://civitai.red",
}


# ------------------------------------------------------------
# API Key
# ------------------------------------------------------------

def load_api_key():
    if not os.path.exists(API_KEY_FILE):
        return None

    with open(API_KEY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("CIVITAI_API_KEY="):
                return line.split("=", 1)[1].strip()

    return None


# ------------------------------------------------------------
# Domain Settings
# ------------------------------------------------------------

def get_site_api_bases():
    env_base = (os.getenv("CIVITAI_SITE_API_BASE") or "").strip().rstrip("/")
    bases = []

    if env_base:
        bases.append(env_base)

    for base in DEFAULT_SITE_API_BASES:
        if base not in bases:
            bases.append(base)

    return tuple(bases)


def get_page_domain_mode():
    mode = (os.getenv("CIVITAI_PAGE_DOMAIN_MODE") or "auto").strip().lower()

    if mode not in ("auto", "com", "red"):
        return "auto"

    return mode


# ------------------------------------------------------------
# URL Helpers
# ------------------------------------------------------------

def is_allowed_page_host(host: str) -> bool:
    host = (host or "").lower()

    return host in {
        "civitai.com",
        "www.civitai.com",
        "civitai.red",
        "www.civitai.red",
    }

def blank_image_tensor(width=64, height=64):
    import numpy as np
    import torch

    array = np.zeros((height, width, 3), dtype=np.float32)
    return torch.from_numpy(array)[None,]


def image_tensor_from_url(
    raw_url: str,
    api_key: str | None = None,
    timeout_s: int = 60,
    referer_url: str = "",
):
    import io
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    url = (raw_url or "").strip()

    if not url:
        return blank_image_tensor()

    if url.startswith("blob:") or url.startswith("data:"):
        return blank_image_tensor()

    if api_key:
        image_bytes, _content_type = fetch_bytes_authed_sync(
            url,
            api_key,
            timeout_s=timeout_s,
            referer_url=referer_url,
        )
    else:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        )
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            image_bytes = response.read()

    image = Image.open(io.BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image)
    image = image.convert("RGB")

    array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array)[None,]

def image_tensor_from_bytes(image_bytes: bytes):
    import io
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    image = Image.open(io.BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image)
    image = image.convert("RGB")

    array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array)[None,]


def image_tensor_from_upload_id(upload_id: str, fallback_width=64, fallback_height=64):
    upload_key = str(upload_id or "").strip()

    if not upload_key:
        return blank_image_tensor(fallback_width, fallback_height)

    item = IMAGEPLUS_LOCAL_IMAGE_STORE.get(upload_key) or {}
    image_bytes = item.get("bytes")

    if not image_bytes:
        print(f"[ImagePlus Inspector] local upload missing from backend store: {upload_key}")
        return blank_image_tensor(fallback_width, fallback_height)

    try:
        return image_tensor_from_bytes(image_bytes)
    except Exception as exc:
        print(f"[ImagePlus Inspector] local upload decode failed: {exc}")
        return blank_image_tensor(fallback_width, fallback_height)


def is_allowed_page_url(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)

        if parsed.scheme not in ("http", "https"):
            return False

        return is_allowed_page_host(parsed.netloc)

    except Exception:
        return False


def is_allowed_image_url(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)

        if parsed.scheme not in ("http", "https"):
            return False

        host = (parsed.netloc or "").lower()

        if host == "image.civitai.com":
            return True

        if host.endswith(".civitai.com"):
            return True

        if host == "civitai.com":
            return True

        if host.endswith(".civitai.red"):
            return True

        if host == "civitai.red":
            return True

        return False

    except Exception:
        return False


def page_base_from_url(raw_url: str) -> Optional[str]:
    if not raw_url:
        return None

    try:
        parsed = urlparse(raw_url)

        if parsed.scheme not in ("http", "https"):
            return None

        if not is_allowed_page_host(parsed.netloc):
            return None

        return f"{parsed.scheme}://{parsed.netloc}"

    except Exception:
        return None


def preferred_page_base(
    explicit_url: str = "",
    source_url: str = "",
    page_domain: str = "",
) -> str:
    forced = (page_domain or "").strip().lower()

    if forced in DEFAULT_PAGE_BASES:
        return DEFAULT_PAGE_BASES[forced]

    explicit_base = page_base_from_url(explicit_url)

    if explicit_base:
        return explicit_base

    source_base = page_base_from_url(source_url)

    if source_base:
        return source_base

    mode = get_page_domain_mode()

    if mode in DEFAULT_PAGE_BASES:
        return DEFAULT_PAGE_BASES[mode]

    return DEFAULT_PAGE_BASES["com"]


def build_civitai_page_url(
    image_id=None,
    post_id=None,
    page_base: str = "",
) -> str:
    base = (page_base or DEFAULT_PAGE_BASES["com"]).rstrip("/")

    if image_id:
        return f"{base}/images/{image_id}"

    if post_id:
        return f"{base}/posts/{post_id}"

    return ""


# ------------------------------------------------------------
# Request Helpers
# ------------------------------------------------------------

def auth_headers(api_key: str, referer_url: str = "") -> dict:
    referer_base = preferred_page_base(explicit_url=referer_url)

    return {
        "User-Agent": "ComfyUI-ImagePlus-Inspector",
        "Authorization": f"Bearer {api_key}",
        "Referer": referer_base.rstrip("/") + "/",
    }


def redact_params(params: dict) -> dict:
    safe = dict(params or {})

    if "token" in safe and safe["token"]:
        safe["token"] = "***redacted***"

    return safe


def safe_int(value, default, min_value=None, max_value=None):
    try:
        number = int(value)
    except Exception:
        number = default

    if min_value is not None:
        number = max(min_value, number)

    if max_value is not None:
        number = min(max_value, number)

    return number


# ------------------------------------------------------------
# CivitAI API Helpers
# ------------------------------------------------------------

def nsfw_to_browsing_level(nsfw_value: str):
    rating_map = {
        "none": 1,
        "soft": 3,
        "mature": 7,
        "x": 15,
        "xxx": 31,
        "true": 15,
    }

    value = str(nsfw_value or "").strip().lower()

    return rating_map.get(value, None)


def normalize_tags(raw_tags):
    tags = []

    if isinstance(raw_tags, list):
        for tag in raw_tags:
            if isinstance(tag, dict):
                name = (tag.get("name") or tag.get("label") or "").strip()

                if name:
                    tags.append(name)

            elif isinstance(tag, str):
                name = tag.strip()

                if name:
                    tags.append(name)

    elif isinstance(raw_tags, str):
        for part in raw_tags.split(","):
            name = part.strip()

            if name:
                tags.append(name)

    return tags


def iter_lookup_param_variants(id_key: str, id_value: str, nsfw: str = ""):
    base = {
        id_key: id_value,
        "limit": 1,
        "withMeta": "true",
        "flatMeta": "true",
        "withTags": "true",
    }

    browsing_level = nsfw_to_browsing_level(nsfw)

    if browsing_level is not None:
        base["browsingLevel"] = browsing_level

    if nsfw:
        yield dict(base, nsfw=nsfw)

    yield dict(base)
    yield dict(base, nsfw="X")
    yield dict(base, nsfw="true")
    yield dict(base, nsfw=True)


async def call_site_api_json(
    path: str,
    params: dict,
    api_key: str,
    timeout_s: int = 60,
):
    clean_params = dict(params or {})
    headers = auth_headers(api_key)
    timeout = aiohttp.ClientTimeout(total=timeout_s)
    errors = []

    async with aiohttp.ClientSession(timeout=timeout) as session:
        for base in get_site_api_bases():
            url = base.rstrip("/") + "/" + path.lstrip("/")

            try:
                async with session.get(url, params=clean_params, headers=headers) as response:
                    text = await response.text()
                    final_url = str(response.url)

                    if response.status != 200:
                        errors.append({
                            "base": base,
                            "status": response.status,
                            "url": final_url,
                            "details": text[:1000],
                            "params": redact_params(clean_params),
                        })
                        continue

                    try:
                        return json.loads(text)
                    except json.JSONDecodeError as exc:
                        errors.append({
                            "base": base,
                            "status": response.status,
                            "url": final_url,
                            "details": f"Invalid JSON: {exc}",
                            "body": text[:1000],
                            "params": redact_params(clean_params),
                        })
                        continue

            except aiohttp.ClientResponseError as exc:
                errors.append({
                    "base": base,
                    "status": getattr(exc, "status", 0),
                    "url": url,
                    "details": str(exc),
                    "params": redact_params(clean_params),
                })
                continue

            except aiohttp.ClientConnectorError as exc:
                errors.append({
                    "base": base,
                    "status": 0,
                    "url": url,
                    "details": f"Connection failed: {exc}",
                    "params": redact_params(clean_params),
                })
                continue

            except TimeoutError as exc:
                errors.append({
                    "base": base,
                    "status": 0,
                    "url": url,
                    "details": f"Request timed out: {exc}",
                    "params": redact_params(clean_params),
                })
                continue

            except Exception as exc:
                errors.append({
                    "base": base,
                    "status": 0,
                    "url": url,
                    "details": str(exc),
                    "params": redact_params(clean_params),
                })
                continue

    raise RuntimeError(json.dumps({
        "error": "CivitAI API request failed",
        "path": path,
        "params": redact_params(clean_params),
        "attempts": errors,
    }))


async def fetch_bytes_authed(
    url: str,
    api_key: str,
    timeout_s: int = 60,
    referer_url: str = "",
) -> tuple[bytes, str]:
    headers = auth_headers(api_key, referer_url=referer_url)
    timeout = aiohttp.ClientTimeout(total=timeout_s)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                content_type = response.headers.get(
                    "Content-Type",
                    "application/octet-stream",
                )

                if response.status != 200:
                    text = await response.text()
                    raise RuntimeError(json.dumps({
                        "error": "Upstream image fetch failed",
                        "status": response.status,
                        "url": str(response.url),
                        "content_type": content_type,
                        "details": text[:1000],
                    }))

                data = await response.read()

                if not data:
                    raise RuntimeError(json.dumps({
                        "error": "Upstream image response was empty",
                        "status": response.status,
                        "url": str(response.url),
                        "content_type": content_type,
                    }))

                return data, content_type

    except aiohttp.ClientConnectorError as exc:
        raise RuntimeError(json.dumps({
            "error": "Image connection failed",
            "url": url,
            "details": str(exc),
        }))

    except TimeoutError as exc:
        raise RuntimeError(json.dumps({
            "error": "Image request timed out",
            "url": url,
            "details": str(exc),
        }))

    except RuntimeError:
        raise

    except Exception as exc:
        raise RuntimeError(json.dumps({
            "error": "Image fetch failed",
            "url": url,
            "details": str(exc),
        }))


def fetch_bytes_authed_sync(
    url: str,
    api_key: str,
    timeout_s: int = 60,
    referer_url: str = "",
) -> tuple[bytes, str]:
    headers = auth_headers(api_key, referer_url=referer_url)
    request = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            data = response.read()
            content_type = response.headers.get(
                "Content-Type",
                "application/octet-stream",
            )

            if not data:
                raise RuntimeError(json.dumps({
                    "error": "Upstream image response was empty",
                    "url": url,
                    "content_type": content_type,
                }))

            return data, content_type

    except urllib.error.HTTPError as exc:
        details = ""

        try:
            details = exc.read().decode("utf-8", errors="replace")[:1000]
        except Exception:
            details = str(exc)

        raise RuntimeError(json.dumps({
            "error": "Upstream image fetch failed",
            "status": exc.code,
            "url": url,
            "details": details,
        }))

    except urllib.error.URLError as exc:
        raise RuntimeError(json.dumps({
            "error": "Image connection failed",
            "url": url,
            "details": str(exc.reason),
        }))

    except TimeoutError as exc:
        raise RuntimeError(json.dumps({
            "error": "Image request timed out",
            "url": url,
            "details": str(exc),
        }))

    except RuntimeError:
        raise

    except Exception as exc:
        raise RuntimeError(json.dumps({
            "error": "Image fetch failed",
            "url": url,
            "details": str(exc),
        }))

# ------------------------------------------------------------
# CivitAI Item Helpers
# ------------------------------------------------------------

def first_value(*values):
    for value in values:
        if value is not None and value != "":
            return value

    return ""


def extract_dimensions_from_meta(meta: dict):
    if not isinstance(meta, dict):
        return 0, 0

    width = first_value(
        meta.get("width"),
        meta.get("Width"),
        meta.get("imageWidth"),
        meta.get("ImageWidth"),
    )

    height = first_value(
        meta.get("height"),
        meta.get("Height"),
        meta.get("imageHeight"),
        meta.get("ImageHeight"),
    )

    size = first_value(
        meta.get("size"),
        meta.get("Size"),
    )

    if (not width or not height) and isinstance(size, str):
        normalized = (
            size.lower()
            .replace("px", "")
            .replace(" ", "")
            .replace("Ã—", "x")
        )

        if "x" in normalized:
            left, right = normalized.split("x", 1)

            try:
                width = int(left)
                height = int(right)
            except Exception:
                pass

    try:
        width = int(width)
    except Exception:
        width = 0

    try:
        height = int(height)
    except Exception:
        height = 0

    return width, height


def extract_prompts_from_meta(meta: dict):
    if not isinstance(meta, dict):
        return "", ""

    positive = first_value(
        meta.get("prompt"),
        meta.get("positivePrompt"),
        meta.get("positive"),
        meta.get("Positive"),
        meta.get("PositivePrompt"),
    )

    negative = first_value(
        meta.get("negativePrompt"),
        meta.get("negative"),
        meta.get("Negative"),
        meta.get("NegativePrompt"),
    )

    parameters = meta.get("parameters")

    if isinstance(parameters, dict):
        positive = first_value(
            positive,
            parameters.get("prompt"),
            parameters.get("positivePrompt"),
            parameters.get("positive"),
        )

        negative = first_value(
            negative,
            parameters.get("negativePrompt"),
            parameters.get("negative"),
        )

    return str(positive or ""), str(negative or "")


def extract_model_name_from_meta(meta: dict):
    if not isinstance(meta, dict):
        return ""

    direct_model = first_value(
        meta.get("Model"),
        meta.get("model"),
        meta.get("Model type"),
        meta.get("modelName"),
        meta.get("checkpoint"),
        meta.get("ckpt_name"),
        meta.get("unet_name"),
        meta.get("ecosystem"),
    )

    if direct_model:
        return str(direct_model).strip()

    resources = meta.get("resources")

    if isinstance(resources, list):
        for resource in resources:
            if not isinstance(resource, dict):
                continue

            resource_type = str(resource.get("type") or "").strip().lower()
            name = str(resource.get("name") or "").strip()

            if not name:
                continue

            if resource_type not in ("lora", "textualinversion", "embedding", "embeddings"):
                return name

    return ""


def build_info_text_from_civitai_item(item: dict):
    meta = item.get("meta") or {}
    page_url = item.get("pageUrl") or ""
    width = item.get("width") or 0
    height = item.get("height") or 0

    positive, negative = extract_prompts_from_meta(meta)
    model = extract_model_name_from_meta(meta)

    sampler = first_value(
        meta.get("sampler"),
        meta.get("Sampler"),
    )

    scheduler = first_value(
        meta.get("scheduler"),
        meta.get("Scheduler"),
    )

    steps = first_value(
        meta.get("steps"),
        meta.get("Steps"),
    )

    cfg = first_value(
        meta.get("cfgScale"),
        meta.get("CFG scale"),
        meta.get("CFG"),
        meta.get("cfg"),
    )

    seed = first_value(
        meta.get("seed"),
        meta.get("Seed"),
    )

    lines = ["Source: CivitAI"]

    if page_url:
        lines.append(f"CivitAI Page: {page_url}")

    if item.get("id"):
        lines.append(f"Image ID: {item.get('id')}")

    if item.get("postId"):
        lines.append(f"Post ID: {item.get('postId')}")

    if width and height:
        lines.append(f"Image Size: {width} x {height}")

    if model:
        lines.append(f"Model: {model}")

    if steps:
        lines.append(f"Steps: {steps}")

    if cfg:
        lines.append(f"CFG: {cfg}")

    if sampler:
        lines.append(f"Sampler: {sampler}")

    if scheduler:
        lines.append(f"Scheduler: {scheduler}")

    if seed:
        lines.append(f"Seed: {seed}")

    if positive:
        lines.append("")
        lines.append("Positive Prompt:")
        lines.append(positive)

    if negative:
        lines.append("")
        lines.append("Negative Prompt:")
        lines.append(negative)

    return "\n".join(lines)


def normalize_civitai_api_item(
    raw_item: dict,
    source_page_url: str = "",
    page_domain: str = "",
):
    raw_item = raw_item or {}

    image_id = first_value(
        raw_item.get("id"),
        raw_item.get("imageId"),
    )

    post_id = first_value(
        raw_item.get("postId"),
        raw_item.get("post_id"),
    )

    url = first_value(
        raw_item.get("url"),
        raw_item.get("imageUrl"),
        raw_item.get("src"),
    )

    meta = raw_item.get("meta") or {}

    if isinstance(meta, dict) and isinstance(meta.get("meta"), dict):
        if not image_id:
            image_id = meta.get("id")

        meta = meta.get("meta") or {}

    width = first_value(
        raw_item.get("width"),
        raw_item.get("imageWidth"),
    )

    height = first_value(
        raw_item.get("height"),
        raw_item.get("imageHeight"),
    )

    meta_width, meta_height = extract_dimensions_from_meta(meta)

    if not width:
        width = meta_width

    if not height:
        height = meta_height

    try:
        width = int(width)
    except Exception:
        width = 0

    try:
        height = int(height)
    except Exception:
        height = 0

    explicit_page_url = first_value(
        raw_item.get("pageUrl"),
        raw_item.get("page_url"),
        source_page_url,
    )

    page_base = preferred_page_base(
        explicit_url=explicit_page_url,
        source_url=source_page_url,
        page_domain=page_domain,
    )

    page_url = explicit_page_url

    if not page_url:
        page_url = build_civitai_page_url(
            image_id=image_id,
            post_id=post_id,
            page_base=page_base,
        )

    positive, negative = extract_prompts_from_meta(meta)

    item = {
        "source": "civitai",
        "id": str(image_id) if image_id else "",
        "postId": str(post_id) if post_id else "",
        "url": url or "",
        "pageUrl": page_url or "",
        "sourcePageUrl": source_page_url or "",
        "pageDomain": page_domain or "",
        "width": width,
        "height": height,
        "imageSizeText": f"{width} x {height}" if width and height else "",
        "positive": positive,
        "negative": negative,
        "meta": meta or {},
        "rawMeta": raw_item,
        "tags": normalize_tags(raw_item.get("tags")),
    }

    item["infoText"] = build_info_text_from_civitai_item(item)

    return item


def parse_civitai_url_ids(raw_url: str):
    parsed = urlparse(raw_url)
    path = (parsed.path or "").strip("/")
    parts = [part for part in path.split("/") if part]

    result = {
        "image_id": "",
        "post_id": "",
    }

    for index, part in enumerate(parts):
        lower = part.lower()

        if lower == "images" and index + 1 < len(parts):
            result["image_id"] = parts[index + 1]
            break

        if lower == "posts" and index + 1 < len(parts):
            result["post_id"] = parts[index + 1]
            break

    query = parse_qs(parsed.query or "")

    if not result["image_id"]:
        image_values = query.get("imageId") or query.get("image_id") or query.get("id")

        if image_values:
            result["image_id"] = image_values[0]

    if not result["post_id"]:
        post_values = query.get("postId") or query.get("post_id")

        if post_values:
            result["post_id"] = post_values[0]

    return result


# ------------------------------------------------------------
# Persistent Storage
# ------------------------------------------------------------

def ensure_json_store(path):
    if os.path.exists(path):
        return

    with open(
        path,
        "w",
        encoding="utf-8"
    ) as f:
        json.dump([], f)

def load_json_store(path):
    ensure_json_store(path)

    try:
        with open(
            path,
            "r",
            encoding="utf-8"
        ) as f:

            data = json.load(f)

            if isinstance(data, list):
                return data

    except Exception:

        corrupt_path = (
            path +
            ".corrupt"
        )

        try:
            os.replace(
                path,
                corrupt_path
            )
        except Exception:
            pass

    ensure_json_store(path)

    return []

def save_json_store(
    path,
    data
):
    with open(
        path,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            data,
            f,
            indent=2,
            ensure_ascii=False
        )

ensure_json_store(
    FAVOURITES_FILE
)

ensure_json_store(
    RECENT_FILE
)
# ------------------------------------------------------------
# Route Helpers
# ------------------------------------------------------------

def json_error(message: str, status: int = 400, **extra):
    payload = {
        "error": message,
    }

    payload.update(extra)

    return web.json_response(payload, status=status)


def parse_runtime_error(exc: Exception):
    text = str(exc or "")

    try:
        data = json.loads(text)

        if isinstance(data, dict):
            return data

    except Exception:
        pass

    return {
        "details": text,
    }


# ------------------------------------------------------------
# Routes
# ------------------------------------------------------------

prompt_server = server.PromptServer.instance

IMAGEPLUS_STATE_STORE = {}
IMAGEPLUS_LOCAL_IMAGE_STORE = {}
@prompt_server.routes.get(
    "/imageplus_inspector/favourites/load"
)
async def load_favourites(request):

    return web.json_response({
        "items":
            load_json_store(
                FAVOURITES_FILE
            )
    })


@prompt_server.routes.post(
    "/imageplus_inspector/favourites/save"
)
async def save_favourites(request):

    body = await request.json()

    items = body.get(
        "items",
        []
    )

    save_json_store(
        FAVOURITES_FILE,
        items
    )

    print(
        "[ImagePlus] favourites saved:",
        len(items)
    )

    return web.json_response(
        {"ok":True}
    )


@prompt_server.routes.get(
    "/imageplus_inspector/recent/load"
)
async def load_recent(request):

    return web.json_response({
        "items":
            load_json_store(
                RECENT_FILE
            )
    })


@prompt_server.routes.post(
    "/imageplus_inspector/recent/save"
)
async def save_recent(request):

    body = await request.json()

    items = body.get(
        "items",
        []
    )

    items = items[:100]

    save_json_store(
        RECENT_FILE,
        items
    )

    print(
        "[ImagePlus] recent saved:",
        len(items)
    )

    return web.json_response(
        {"ok":True}
    )



@prompt_server.routes.post("/imageplus_inspector/set_state")
async def imageplus_set_state(request):
    try:
        body = await request.json()
    except Exception:
        return json_error("Invalid JSON.", status=400)

    node_id = str(body.get("node_id") or "").strip()

    if not node_id:
        return json_error("Missing node_id.", status=400)

    state = dict(body or {})
    state["node_id"] = node_id
    state["node_type"] = str(state.get("node_type") or state.get("type") or "").strip().lower()
    state["source"] = str(state.get("source") or "")
    state["url"] = str(state.get("url") or state.get("source_url") or state.get("sourceUrl") or "")
    state["pageUrl"] = str(state.get("pageUrl") or state.get("page_url") or "")
    state["filename"] = str(state.get("filename") or state.get("fileName") or "")
    state["localUploadId"] = str(
        state.get("localUploadId")
        or state.get("local_upload_id")
        or state.get("upload_id")
        or ""
    )
    state["width"] = state.get("width") or state.get("imageWidth") or 0
    state["height"] = state.get("height") or state.get("imageHeight") or 0
    state["positive"] = str(
        state.get("positive")
        or state.get("positive_prompt")
        or state.get("positivePrompt")
        or state.get("__imagePlusPromptPositive")
        or ""
    )
    state["negative"] = str(
        state.get("negative")
        or state.get("negative_prompt")
        or state.get("negativePrompt")
        or state.get("__imagePlusPromptNegative")
        or ""
    )
    state["positive_prompt"] = state["positive"]
    state["negative_prompt"] = state["negative"]
    state["info"] = str(state.get("info") or state.get("infoText") or "")
    state["infoText"] = str(state.get("infoText") or state.get("info") or "")
    state["meta"] = state.get("meta") or {}
    state["rawMeta"] = state.get("rawMeta") or state.get("raw_metadata") or {}
    state["_updated_at"] = state.get("updatedAt") or state.get("updated_at") or 0

    IMAGEPLUS_STATE_STORE[node_id] = state

    if state.get("node_type") == "inspector" and (state.get("source") == "local" or state.get("localUploadId")):
        print(
            "[ImagePlus Inspector] set inspector state",
            {
                "node_id": node_id,
                "localUploadId": state.get("localUploadId") or "",
                "url": state.get("url") or "",
                "size": f"{state.get('width') or 0}x{state.get('height') or 0}",
                "info_len": len(str(state.get("info") or state.get("infoText") or "")),
                "positive_len": len(str(state.get("positive") or "")),
                "negative_len": len(str(state.get("negative") or "")),
            },
        )

    return web.json_response({
        "ok": True,
        "node_id": node_id,
    })

@prompt_server.routes.post("/imageplus_inspector/upload_image")
async def imageplus_upload_image(request):
    try:
        reader = await request.multipart()
        field = await reader.next()
    except Exception:
        return json_error("Invalid multipart upload.", status=400)

    if not field or field.name != "file":
        return json_error("Missing file field.", status=400)

    filename = str(field.filename or "uploaded_image").strip() or "uploaded_image"
    content_type = str(field.headers.get("Content-Type") or "application/octet-stream")

    if not content_type.startswith("image/"):
        return json_error("Uploaded file is not an image.", status=400)

    data = bytearray()

    while True:
        chunk = await field.read_chunk()
        if not chunk:
            break
        data.extend(chunk)

    if not data:
        return json_error("Uploaded image was empty.", status=400)

    upload_id = uuid.uuid4().hex
    IMAGEPLUS_LOCAL_IMAGE_STORE[upload_id] = {
        "bytes": bytes(data),
        "filename": filename,
        "content_type": content_type,
        "size": len(data),
    }

    print(f"[ImagePlus Inspector] stored local upload {upload_id}: {filename}, {len(data)} bytes")

    return web.json_response({
        "ok": True,
        "upload_id": upload_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(data),
    })


@prompt_server.routes.get("/imageplus_inspector/images")
async def imageplus_images(request):
    api_key = load_api_key()

    if not api_key:
        return json_error(
            "CivitAI API key missing. Add CIVITAI_API_KEY to api_key.txt.",
            status=401,
        )

    sort = request.query.get("sort", "Most Reactions")
    period = request.query.get("period", "AllTime")
    nsfw = request.query.get("nsfw", "None")
    cursor = request.query.get("cursor", "")
    page_domain = request.query.get("pageDomain", "")

    limit = safe_int(
        request.query.get("limit", 36),
        default=36,
        min_value=1,
        max_value=200,
    )

    params = {
        "sort": sort,
        "period": period,
        "limit": limit,
        "withMeta": "true",
        "flatMeta": "true",
        "withTags": "true",
    }

    browsing_level = nsfw_to_browsing_level(nsfw)

    if browsing_level is not None:
        params["browsingLevel"] = browsing_level

    if nsfw:
        params["nsfw"] = nsfw

    if cursor not in ("", None, "0"):
        params["cursor"] = cursor

    try:
        data = await call_site_api_json(
            "images",
            params=params,
            api_key=api_key,
        )

        raw_items = data.get("items") if isinstance(data, dict) else []
        metadata = data.get("metadata") if isinstance(data, dict) else {}

        if not isinstance(raw_items, list):
            raw_items = []

        items = [
            normalize_civitai_api_item(
                item,
                source_page_url="",
                page_domain=page_domain,
            )
            for item in raw_items
            if isinstance(item, dict)
        ]

        return web.json_response({
            "items": items,
            "metadata": metadata or {},
        })

    except Exception as exc:
        details = parse_runtime_error(exc)

        return json_error(
            "Failed to fetch CivitAI images.",
            status=502,
            **details,
        )


@prompt_server.routes.get("/imageplus_inspector/image_by_url")
async def imageplus_image_by_url(request):
    api_key = load_api_key()

    if not api_key:
        return json_error(
            "CivitAI API key missing. Add CIVITAI_API_KEY to api_key.txt.",
            status=401,
        )

    raw_url = (request.query.get("url") or "").strip()
    nsfw = request.query.get("nsfw", "")
    page_domain = request.query.get("pageDomain", "")

    if not raw_url:
        return json_error("Missing url parameter.", status=400)

    if not is_allowed_page_url(raw_url) and not is_allowed_image_url(raw_url):
        return json_error("Unsupported URL host.", status=400)

    parsed_ids = parse_civitai_url_ids(raw_url)
    image_id = parsed_ids.get("image_id") or ""
    post_id = parsed_ids.get("post_id") or ""

    if not image_id and not post_id and is_allowed_image_url(raw_url):
        item = normalize_civitai_api_item(
            {
                "url": raw_url,
                "pageUrl": "",
                "meta": {},
            },
            source_page_url=raw_url,
            page_domain=page_domain,
        )

        return web.json_response({
            "item": item,
        })

    if not image_id and not post_id:
        return json_error(
            "Could not find an image or post ID in the provided URL.",
            status=400,
            hint="Use a CivitAI /images/<id> or /posts/<id> URL.",
        )

    lookup_key = "imageId" if image_id else "postId"
    lookup_value = image_id or post_id

    errors = []

    for params in iter_lookup_param_variants(lookup_key, lookup_value, nsfw=nsfw):
        try:
            data = await call_site_api_json(
                "images",
                params=params,
                api_key=api_key,
            )

            raw_items = data.get("items") if isinstance(data, dict) else []

            if not isinstance(raw_items, list) or not raw_items:
                continue

            item = normalize_civitai_api_item(
                raw_items[0],
                source_page_url=raw_url,
                page_domain=page_domain,
            )

            if not item.get("pageUrl"):
                page_base = preferred_page_base(
                    explicit_url=raw_url,
                    source_url=raw_url,
                    page_domain=page_domain,
                )

                item["pageUrl"] = build_civitai_page_url(
                    image_id=item.get("id") or image_id,
                    post_id=item.get("postId") or post_id,
                    page_base=page_base,
                )

            item["infoText"] = build_info_text_from_civitai_item(item)

            return web.json_response({
                "item": item,
            })

        except Exception as exc:
            errors.append(parse_runtime_error(exc))
            continue

    return json_error(
        "Could not resolve an image from that URL.",
        status=404,
        lookup={
            "image_id": image_id,
            "post_id": post_id,
        },
        attempts=errors,
    )


@prompt_server.routes.get("/imageplus_inspector/proxy_image")
async def imageplus_proxy_image(request):
    api_key = load_api_key()

    if not api_key:
        return json_error(
            "CivitAI API key missing. Add CIVITAI_API_KEY to api_key.txt.",
            status=401,
        )

    raw_url = (request.query.get("url") or "").strip()
    page_url = (request.query.get("page_url") or "").strip()

    if not raw_url:
        return json_error("Missing url parameter.", status=400)

    if not is_allowed_image_url(raw_url):
        return json_error("Unsupported image URL host.", status=400)

    try:
        data, content_type = await fetch_bytes_authed(
            raw_url,
            api_key=api_key,
            referer_url=page_url,
        )

        return web.Response(
            body=data,
            content_type=content_type,
            headers={
                "Cache-Control": "public, max-age=3600",
            },
        )

    except Exception as exc:
        details = parse_runtime_error(exc)

        return json_error(
            "Failed to proxy image.",
            status=502,
            **details,
        )

# ------------------------------------------------------------
# State Helpers
# ------------------------------------------------------------

def get_imageplus_state(unique_id=None, node_type: str = ""):
    node_id = str(unique_id or "").strip()

    if node_id and node_id in IMAGEPLUS_STATE_STORE:
        return IMAGEPLUS_STATE_STORE.get(node_id, {}) or {}

    wanted_type = (node_type or "").strip().lower()
    candidates = []

    for state in IMAGEPLUS_STATE_STORE.values():
        if not isinstance(state, dict):
            continue

        if wanted_type:
            state_type = str(state.get("node_type") or "").strip().lower()
            if state_type and state_type != wanted_type:
                continue

        candidates.append(state)

    if not candidates:
        return {}

    return max(candidates, key=lambda item: item.get("_updated_at") or 0) or {}


def get_state_text(state: dict, *keys):
    for key in keys:
        value = state.get(key)
        if value is not None and value != "":
            return str(value)

    return ""


def imageplus_state_fingerprint(unique_id=None, node_type: str = ""):
    state = get_imageplus_state(unique_id, node_type)

    payload = {
        "node_id": str(unique_id or ""),
        "node_type": node_type or "",
        "updated_at": state.get("_updated_at") or 0,
        "url": get_state_text(state, "url", "source_url", "sourceUrl"),
        "pageUrl": get_state_text(state, "pageUrl", "page_url"),
        "localUploadId": get_state_text(state, "localUploadId", "local_upload_id", "upload_id"),
        "width": state.get("width") or 0,
        "height": state.get("height") or 0,
        "positive": get_state_text(
            state,
            "positive",
            "positive_prompt",
            "positivePrompt",
            "__imagePlusPromptPositive",
        ),
        "negative": get_state_text(
            state,
            "negative",
            "negative_prompt",
            "negativePrompt",
            "__imagePlusPromptNegative",
        ),
    }

    return json.dumps(payload, sort_keys=True, ensure_ascii=False)


# ------------------------------------------------------------
# Node Helpers
# ------------------------------------------------------------

def parse_image_data(image_data: str):
    if not image_data:
        return {}

    try:
        parsed = json.loads(image_data)

        if isinstance(parsed, dict):
            return parsed

    except Exception:
        pass

    return {}


def encode_text_with_clip(clip, text: str):
    tokens = clip.tokenize(text or "")
    conditioning, pooled = clip.encode_from_tokens(
        tokens,
        return_pooled=True,
    )

    return [[conditioning, {"pooled_output": pooled}]]


# ------------------------------------------------------------
# Nodes
# ------------------------------------------------------------

class ImagePlusInspectorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("image", "positive", "negative", "info")
    FUNCTION = "inspect"
    CATEGORY = "imageplus"

    @classmethod
    def IS_CHANGED(cls, unique_id=None, **kwargs):
        return imageplus_state_fingerprint(unique_id, "inspector")

    def inspect(self, unique_id=None):
        state = get_imageplus_state(unique_id, "inspector")

        positive = get_state_text(
            state,
            "positive",
            "positive_prompt",
            "positivePrompt",
            "__imagePlusPromptPositive",
        )
        negative = get_state_text(
            state,
            "negative",
            "negative_prompt",
            "negativePrompt",
            "__imagePlusPromptNegative",
        )
        info = get_state_text(state, "info", "infoText")
        source_url = get_state_text(state, "url", "source_url", "sourceUrl")
        page_url = get_state_text(state, "pageUrl", "page_url")
        local_upload_id = get_state_text(state, "localUploadId", "local_upload_id", "upload_id")
        fallback_width = safe_int(state.get("width") or 64, default=64, min_value=1, max_value=16384)
        fallback_height = safe_int(state.get("height") or 64, default=64, min_value=1, max_value=16384)

        if local_upload_id:
            print(
                "[ImagePlus Inspector] inspect loading local upload",
                {
                    "node_id": str(unique_id or ""),
                    "localUploadId": local_upload_id,
                    "fallback_size": f"{fallback_width}x{fallback_height}",
                    "positive_len": len(positive),
                    "negative_len": len(negative),
                    "info_len": len(info),
                },
            )
            output_image = image_tensor_from_upload_id(
                local_upload_id,
                fallback_width=fallback_width,
                fallback_height=fallback_height,
            )
        else:
            output_image = image_tensor_from_url(
                source_url,
                api_key=load_api_key(),
                referer_url=page_url,
            )

        try:
            print("[ImagePlus Inspector] inspect image shape", tuple(output_image.shape))
        except Exception:
            pass

        return output_image, positive, negative, info


class ImagePlusPromptNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
            },
            "optional": {
                "trigger_words": (
                    "STRING",
                    {
                        "forceInput": True
                    }
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("MODEL", "VAE", "CONDITIONING", "CONDITIONING", "STRING", "STRING")
    RETURN_NAMES = (
        "model",
        "vae",
        "positive_conditioning",
        "negative_conditioning",
        "positive_prompt",
        "negative_prompt"
    )
    FUNCTION = "encode"
    CATEGORY = "imageplus"

    @classmethod
    def IS_CHANGED(cls, model=None, clip=None, vae=None, unique_id=None, **kwargs):
        state = get_imageplus_state(unique_id, "prompt")

        if not state:
            return imageplus_state_fingerprint(None, "inspector")

        return imageplus_state_fingerprint(unique_id, "prompt")

    def encode(self, model, clip, vae, trigger_words="", unique_id=None):
        state = get_imageplus_state(unique_id, "prompt")

        if not state:
            state = get_imageplus_state(None, "inspector")

        positive_text = get_state_text(
            state,
            "positive",
            "positive_prompt",
            "positivePrompt",
            "__imagePlusPromptPositive",
        )
        negative_text = get_state_text(
            state,
            "negative",
            "negative_prompt",
            "negativePrompt",
            "__imagePlusPromptNegative",
        )

        trigger_text = str(
            trigger_words or ""
        ).strip()

        combined_positive = positive_text

        if trigger_text:

            if combined_positive:
                combined_positive += ", "

            combined_positive += trigger_text

        positive_conditioning = encode_text_with_clip(
            clip,
            combined_positive
        )

        negative_conditioning = encode_text_with_clip(
            clip,
            negative_text
        )

        return (
            model,
            vae,
            positive_conditioning,
            negative_conditioning,
            combined_positive,
            negative_text,
        )

# ------------------------------------------------------------
# ImagePlus KSampler Adv Helpers
# ------------------------------------------------------------

def imageplus_get_sampler_options():
    try:
        import comfy.samplers
        return list(comfy.samplers.KSampler.SAMPLERS), list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        return ["euler"], ["normal"]


def imageplus_empty_latent(width, height, batch_size):
    import torch

    try:
        import comfy.model_management
        device = comfy.model_management.intermediate_device()
    except Exception:
        device = "cpu"

    latent = torch.zeros(
        [batch_size, 4, height // 8, width // 8],
        device=device,
    )
    return {"samples": latent}


def imageplus_encode_image_latent(vae, image):
    if image is None:
        raise ValueError("ImagePlus KSampler Adv is set to Image In, but no image is connected.")

    return {"samples": vae.encode(image[:, :, :, :3])}


def imageplus_run_common_ksampler(
    model,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    positive,
    negative,
    latent,
    denoise,
):
    from nodes import common_ksampler

    return common_ksampler(
        model,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        positive,
        negative,
        latent,
        denoise=denoise,
    )[0]


# ------------------------------------------------------------
# ImagePlus KSampler Adv
# ------------------------------------------------------------

class ImagePlusKSamplerAdvNode:
    @classmethod
    def INPUT_TYPES(cls):
        samplers, schedulers = imageplus_get_sampler_options()

        try:
            from nodes import MAX_RESOLUTION
        except Exception:
            MAX_RESOLUTION = 16384

        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "image_in": ("BOOLEAN", {"default": False}),
                "width": ("INT", {"default": 1024, "min": 64, "max": MAX_RESOLUTION, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": MAX_RESOLUTION, "step": 8}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}),
                "sampler_name": (samplers,),
                "scheduler": (schedulers,),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("LATENT", "VAE")
    RETURN_NAMES = ("samples", "vae")
    FUNCTION = "sample"
    CATEGORY = "imageplus"

    def sample(
        self,
        model,
        vae,
        positive,
        negative,
        image_in,
        width,
        height,
        batch_size,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        image=None,
    ):
        width = int(width)
        height = int(height)
        batch_size = int(batch_size)
        denoise = float(denoise)

        if image_in:
            latent = imageplus_encode_image_latent(vae, image)
        else:
            latent = imageplus_empty_latent(width, height, batch_size)

        samples = imageplus_run_common_ksampler(
            model,
            seed,
            steps,
            cfg,
            sampler_name,
            scheduler,
            positive,
            negative,
            latent,
            denoise,
        )

        return (samples, vae)

# ------------------------------------------------------------
# Registration
# ------------------------------------------------------------

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



