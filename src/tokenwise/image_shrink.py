"""Image shrinker: resize + recompress large images to save token budget."""
from __future__ import annotations

import contextlib
import hashlib
import logging
import stat
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypedDict

if TYPE_CHECKING:
    from PIL import Image as _PilImage

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
    """sha256 of the image's *content*.

    Content-addressing — rather than keying on path+mtime+size — means identical
    images share one cache entry regardless of where they live, and any real
    content change invalidates the entry while a bare mtime touch does not. This
    matters because Claude Code stages prompt-attached images to a fresh temp
    filename on every prompt: a path/mtime key misses the cache for the same
    image re-used across prompts, and even for one image referenced twice in a
    single prompt.
    """
    try:
        h = hashlib.sha256()
        with src_path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return hashlib.sha256(str(src_path).encode()).hexdigest()


def _cache_path_for(src_path: Path) -> Path:
    """Cache filename stem: <hash>.shrunk — suffix determined at save time."""
    key = _cache_key(src_path)
    return paths.image_cache_dir() / f"{key}.shrunk"


class ImageStats(TypedDict):
    """Return value of stats_for(): per-image compression telemetry."""

    src_bytes: int
    out_bytes: int
    bytes_saved: int


def _looks_like_screenshot_or_text(img: _PilImage.Image) -> bool:
    """Cheap heuristic: PNG images with palette/alpha modes are probably screenshots."""
    mode = img.mode
    w, h = img.size
    return mode in ("L", "LA", "P", "RGBA") and max(w, h) <= 1500


def should_shrink(src_path: Path) -> bool:
    """Threshold check: is this image worth shrinking?"""
    try:
        if not is_image_path(str(src_path)):
            return False
        st = src_path.stat()  # single syscall: raises FileNotFoundError if absent
        return stat.S_ISREG(st.st_mode) and st.st_size > SIZE_THRESHOLD_BYTES
    except OSError:
        return False


def _is_safe_path(path: Path) -> bool:
    """Validate path is absolute and doesn't attempt traversal."""
    try:
        # Must be absolute
        if not path.is_absolute():
            return False
        # Resolve to catch any .. or symlink tricks
        resolved = path.resolve()
        # Path must exist to be processable
        return resolved.exists()
    except (OSError, ValueError):
        return False


def _ensure_rgb(img: _PilImage.Image, Image_module: Any) -> _PilImage.Image:  # noqa: N803
    """Flatten any non-RGB image to an RGB canvas (white background).

    Handles alpha channels by compositing over white before discarding the
    alpha plane, which avoids the black-fill artefact that a bare ``convert``
    produces for RGBA/LA images.
    """
    if img.mode == "RGB":
        return img
    bg = Image_module.new("RGB", img.size, (255, 255, 255))
    if "A" in img.mode:
        bg.paste(img, mask=img.split()[-1])
    else:
        bg.paste(img)
    return bg


def shrink(src_path: Path) -> Path | None:
    """Shrink the image and return the path to the cached shrunken version. None on failure."""
    # Validate input path for safety
    if not _is_safe_path(src_path):
        _LOG.warning("rejected unsafe path: %s", src_path)
        return None
    try:
        src_size = src_path.stat().st_size
    except OSError:
        return None
    if not (is_image_path(str(src_path)) and src_size > SIZE_THRESHOLD_BYTES):
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
                img = _ensure_rgb(img, Image)
                final_path = stem.with_suffix(".jpg")
                img.save(final_path, "JPEG", quality=JPEG_QUALITY, optimize=True)

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


def stats_for(src_path: Path, shrunken_path: Path) -> ImageStats:
    """Return savings stats for telemetry."""
    try:
        # Validate both paths
        if not _is_safe_path(src_path) or not _is_safe_path(shrunken_path):
            _LOG.warning("rejected unsafe path in stats_for")
            return ImageStats(src_bytes=0, out_bytes=0, bytes_saved=0)
        src_size = src_path.stat().st_size
        out_size = shrunken_path.stat().st_size
        return ImageStats(
            src_bytes=src_size,
            out_bytes=out_size,
            bytes_saved=max(0, src_size - out_size),
        )
    except OSError:
        return ImageStats(src_bytes=0, out_bytes=0, bytes_saved=0)
