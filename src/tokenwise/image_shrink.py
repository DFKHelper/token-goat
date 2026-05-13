"""Image shrinker: resize + recompress large images to save token budget."""
from __future__ import annotations

import contextlib
import hashlib
import logging
from pathlib import Path

from . import paths

_LOG = logging.getLogger("tokenwise.image_shrink")

# Behavior tuning
MAX_LONG_EDGE = 1024
SIZE_THRESHOLD_BYTES = 100 * 1024  # only shrink if original > 100 KB
JPEG_QUALITY = 75

# Recognized image extensions
IMAGE_EXTENSIONS = frozenset(
    [".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".tif", ".bmp", ".gif"]
)


def is_image_path(path: str) -> bool:
    """Does this look like an image path?"""
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def _cache_key(src_path: Path) -> str:
    """sha256 of (absolute_path, mtime, size) to invalidate cache when the source changes."""
    try:
        st = src_path.stat()
        canon = str(src_path.resolve()).lower().replace("\\", "/")
        material = f"{canon}|{st.st_mtime_ns}|{st.st_size}".encode()
        return hashlib.sha256(material).hexdigest()
    except OSError:
        return hashlib.sha256(str(src_path).encode()).hexdigest()


def _cache_path_for(src_path: Path) -> Path:
    """Cache filename stem: <hash>.shrunk — suffix determined at save time."""
    key = _cache_key(src_path)
    return paths.image_cache_dir() / f"{key}.shrunk"


def _looks_like_screenshot_or_text(img) -> bool:  # type: ignore[no-untyped-def]
    """Cheap heuristic: PNG images with palette/alpha modes are probably screenshots."""
    mode = img.mode
    w, h = img.size
    return mode in ("L", "LA", "P", "RGBA") and max(w, h) <= 1500


def should_shrink(src_path: Path) -> bool:
    """Threshold check: is this image worth shrinking?"""
    try:
        if not src_path.is_file():
            return False
        if not is_image_path(str(src_path)):
            return False
        size = src_path.stat().st_size
        return size > SIZE_THRESHOLD_BYTES
    except OSError:
        return False


def shrink(src_path: Path) -> Path | None:
    """Shrink the image and return the path to the cached shrunken version. None on failure."""
    if not should_shrink(src_path):
        return None

    cache_dir = paths.image_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    stem = _cache_path_for(src_path)  # e.g. .../abc123.shrunk
    # Check for already-cached variants (jpg or png)
    for suffix in (".jpg", ".png"):
        candidate = stem.with_suffix(suffix)
        if candidate.exists():
            _LOG.debug("image cache hit: %s -> %s", src_path.name, candidate.name)
            return candidate

    try:
        from PIL import Image, ImageOps  # noqa: PLC0415

        # Image.open returns ImageFile; downstream resize/convert/paste return
        # Image. Annotate broadly so reassignment doesn't trip the type checker.
        img: Image.Image
        with Image.open(src_path) as img:
            # Preserve EXIF orientation
            with contextlib.suppress(Exception):
                img = ImageOps.exif_transpose(img)

            # Resize if needed
            w, h = img.size
            long_edge = max(w, h)
            if long_edge > MAX_LONG_EDGE:
                scale = MAX_LONG_EDGE / long_edge
                new_size = (int(w * scale), int(h * scale))
                img = img.resize(new_size, Image.Resampling.LANCZOS)

            # Choose output format
            is_screenshot = _looks_like_screenshot_or_text(img)
            if is_screenshot and img.mode in ("RGBA", "LA"):
                # Keep PNG with alpha for screenshots
                final_path = stem.with_suffix(".png")
                img.save(final_path, "PNG", optimize=True)
            else:
                # Convert to RGB JPEG (smallest)
                if img.mode != "RGB":
                    bg = Image.new("RGB", img.size, (255, 255, 255))
                    if "A" in img.mode:
                        bg.paste(img, mask=img.split()[-1])
                    else:
                        bg.paste(img)
                    img = bg
                final_path = stem.with_suffix(".jpg")
                img.save(final_path, "JPEG", quality=JPEG_QUALITY, optimize=True)

        src_size = src_path.stat().st_size
        out_size = final_path.stat().st_size
        savings_pct = 100.0 * (1.0 - out_size / src_size) if src_size > 0 else 0.0
        _LOG.info(
            "image shrink: %s | %d → %d bytes (%.1f%% reduction, %s)",
            src_path.name,
            src_size,
            out_size,
            savings_pct,
            final_path.suffix,
        )
        return final_path
    except Exception as e:  # noqa: BLE001
        _LOG.warning("shrink failed for %s: %s", src_path, e)
        return None


def stats_for(src_path: Path, shrunken_path: Path) -> dict:
    """Return savings stats for telemetry."""
    try:
        src_size = src_path.stat().st_size
        out_size = shrunken_path.stat().st_size
        return {
            "src_bytes": src_size,
            "out_bytes": out_size,
            "bytes_saved": max(0, src_size - out_size),
        }
    except OSError:
        return {"src_bytes": 0, "out_bytes": 0, "bytes_saved": 0}
