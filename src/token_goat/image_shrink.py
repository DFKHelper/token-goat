"""Image shrinker: resize + recompress large images to save token budget.

Claude charges vision tokens proportional to pixel area, so a 3000×2000 screenshot
can cost 1 000+ tokens before the model reads a single word.  This module intercepts
image paths on the pre-read hook, compresses them to fit within MAX_LONG_EDGE pixels
on the longest axis, and returns the cached output path so the model receives the
cheaper version transparently.

The cache is content-addressed (SHA-256 of file bytes) so identical images that live
at different temp paths — a pattern Claude Code uses for prompt-attached images — share
one cache entry and are never re-compressed.
"""
from __future__ import annotations

import contextlib
import hashlib
import logging
import stat
import time
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    import types

    from PIL import Image as _PilImage

from . import paths

_LOG = logging.getLogger("token_goat.image_shrink")

# Maximum pixel count on the long axis after resizing.  1024 px keeps the image
# legible for Claude while roughly halving token cost versus the Claude API's own
# 1568 px ceiling (see CLAUDE_MAX_VISION_EDGE_PX below).
MAX_LONG_EDGE = 1024

# Images smaller than this are already cheap enough to send unmodified.
# 100 KB is a conservative threshold: most PNGs below this size are small icons
# or diagrams whose pixel area is already within Claude's efficient range.
SIZE_THRESHOLD_BYTES = 100 * 1024

# JPEG quality for photographic output.  75 is the standard "high quality"
# threshold: visually lossless for natural images, typically 5–20× smaller than
# lossless PNG, and well within what Claude's vision model can read accurately.
JPEG_QUALITY = 75

# Claude vision API parameters (source: Anthropic docs).
# Claude downscales images to fit within this many pixels on the long edge
# before tokenizing; the cost formula is (effective_width × effective_height) / pixels_per_token.
CLAUDE_MAX_VISION_EDGE_PX = 1568
CLAUDE_VISION_PIXELS_PER_TOKEN = 750

# Heuristic max long-edge for images that look like screenshots or text
# (palette/alpha modes at reasonable sizes). Above this threshold the image is
# treated as a photograph and converted to JPEG rather than kept as PNG.
_SCREENSHOT_MAX_EDGE_PX = 1500

# Recognized image extensions — the pre-read hook uses this list to decide
# whether to attempt shrinking before the image is read into context.
IMAGE_EXTENSIONS = frozenset(
    [".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".tif", ".bmp", ".gif"]
)


def is_image_path(path: str) -> bool:
    """Return True if *path* has a recognised image extension (case-insensitive).

    Only checks the extension string — does not open the file or verify content.
    Used as a fast pre-filter before the more expensive stat/PIL operations.
    """
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
    except OSError as exc:
        _LOG.debug("_cache_key: could not read %s for content hash, falling back to path hash: %s", src_path.name, exc)
        return hashlib.sha256(str(src_path).encode()).hexdigest()


def _cache_path_for(src_path: Path) -> Path:
    """Return the base cache path (stem only) for *src_path*.

    The actual output file is either ``<hash>.shrunk.jpg`` or ``<hash>.shrunk.png``
    depending on which format was chosen during compression (JPEG for photos,
    PNG for screenshots with transparency).  Callers probe both suffixes to check
    for a cache hit before re-compressing.
    """
    key = _cache_key(src_path)
    return paths.image_cache_dir() / f"{key}.shrunk"


def vision_tokens(width: int, height: int) -> int:
    """Approximate Claude vision token cost for an image of given dimensions.

    Claude resizes images to fit within CLAUDE_MAX_VISION_EDGE_PX on the long
    edge before tokenizing. Token cost ≈ (effective_width × effective_height) /
    CLAUDE_VISION_PIXELS_PER_TOKEN.
    """
    if width <= 0 or height <= 0:
        return 0
    if max(width, height) > CLAUDE_MAX_VISION_EDGE_PX:
        scale = CLAUDE_MAX_VISION_EDGE_PX / max(width, height)
        width = int(width * scale)
        height = int(height * scale)
    return max(1, (width * height) // CLAUDE_VISION_PIXELS_PER_TOKEN)


class ImageStats(TypedDict):
    """Return value of stats_for(): per-image compression telemetry."""

    src_bytes: int
    out_bytes: int
    bytes_saved: int
    orig_width: int
    orig_height: int
    out_width: int
    out_height: int


def _looks_like_screenshot_or_text(img: _PilImage.Image) -> bool:
    """Return True if the image is likely a screenshot, diagram, or UI capture.

    Palette (P), grayscale (L/LA), and RGBA modes with sharp edges compress poorly
    under JPEG due to ringing artefacts near hard colour boundaries.  PNG is the
    correct format for these images because it is lossless and handles large flat
    regions efficiently.  We only apply this heuristic up to _SCREENSHOT_MAX_EDGE_PX:
    larger images are almost certainly photographs regardless of their mode and
    are better served by JPEG's superior continuous-tone compression.
    """
    mode = img.mode
    w, h = img.size
    return mode in ("L", "LA", "P", "RGBA") and max(w, h) <= _SCREENSHOT_MAX_EDGE_PX


def should_shrink(src_path: Path) -> bool:
    """Return True if this image is large enough to be worth compressing.

    Uses a single ``stat()`` call to check size. Skips non-regular files
    (directories, device nodes, etc.) by checking the S_ISREG flag, so
    callers don't need to guard against special filesystem entries.
    Returns False on any OS error rather than raising so callers can treat
    the answer as a conservative hint, not a guarantee.
    """
    try:
        if not is_image_path(str(src_path)):
            return False
        st = src_path.stat()  # single syscall: raises FileNotFoundError if absent
        return stat.S_ISREG(st.st_mode) and st.st_size > SIZE_THRESHOLD_BYTES
    except OSError as exc:
        _LOG.debug("should_shrink: stat failed for %s: %s", src_path, exc)
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


def _ensure_rgb(img: _PilImage.Image, Image_module: types.ModuleType) -> _PilImage.Image:  # noqa: N803
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
    """Compress and cache a large image; return the cached output path, or None on failure.

    Processing pipeline:
    1. Safety and threshold checks (path traversal guard, extension, size).
    2. Content-addressed cache lookup: if a .jpg or .png with the same SHA256 content
       hash already exists in the image cache, return it immediately without re-processing.
    3. Open with PIL, applying EXIF orientation so the image isn't rotated after resize.
    4. Resize to fit within MAX_LONG_EDGE on the longest axis (Lanczos resampling).
    5. Format selection:
       - Screenshots and text images (palette/alpha modes, reasonable size) → PNG with alpha
         preserved when the mode is RGBA or LA, to avoid aliasing on sharp edges.
       - Everything else (photographs, large PNGs, RGB images) → JPEG at JPEG_QUALITY,
         which gives the best compression for continuous-tone images. Non-RGB modes
         are composited over a white background by _ensure_rgb() before JPEG save.
    6. Log size reduction percentage for telemetry.

    Returns None (never raises) on any PIL, OS, or memory error. Callers treat None
    as "use original path".
    """
    t0 = time.time()
    # Validate input path for safety
    if not _is_safe_path(src_path):
        _LOG.warning("rejected unsafe path: %s", src_path)
        return None
    # Guard: extension check first (cheap string op) then size (one stat syscall).
    # The original code called stat() then repeated is_image_path(); we hoist the
    # cheap extension test before the syscall so non-image paths skip stat entirely.
    if not is_image_path(str(src_path)):
        return None
    try:
        src_size = src_path.stat().st_size
    except OSError:
        return None
    if src_size <= SIZE_THRESHOLD_BYTES:
        return None

    cache_dir = paths.image_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    stem = _cache_path_for(src_path)  # e.g. .../abc123.shrunk
    # Check for already-cached variants (jpg or png)
    for suffix in (".jpg", ".png"):
        candidate = stem.with_suffix(suffix)
        if candidate.exists():
            elapsed = time.time() - t0
            _LOG.debug("image cache hit: %s -> %s (%.3fs)", src_path.name, candidate.name, elapsed)
            return candidate

    try:
        from PIL import Image, ImageOps  # noqa: PLC0415

        # Image.open returns ImageFile; downstream resize/convert/paste return
        # Image. Annotate broadly so reassignment doesn't trip the type checker.
        img: Image.Image
        with Image.open(src_path) as img:
            # Preserve EXIF orientation — some cameras embed rotation metadata
            # rather than rotating pixels; ignoring this produces upside-down output.
            with contextlib.suppress(Exception):
                img = ImageOps.exif_transpose(img)

            # Resize if needed
            w, h = img.size
            long_edge = max(w, h)
            if long_edge > MAX_LONG_EDGE:
                scale = MAX_LONG_EDGE / long_edge
                new_size = (int(w * scale), int(h * scale))
                img = img.resize(new_size, Image.Resampling.LANCZOS)

            # Choose output format based on image characteristics.
            # Screenshots with transparency keep PNG so sharp UI edges aren't
            # compressed into JPEG blur artifacts. Photographs and other images
            # are always saved as JPEG because JPEG achieves far higher compression
            # ratios on continuous-tone content (typically 5–20× smaller than PNG).
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
        elapsed = time.time() - t0
        _LOG.info(
            "shrink: %s -> %s | %d -> %d bytes (%.1f%% reduction, %.3fs)",
            src_path.name,
            final_path.suffix,
            src_size,
            out_size,
            savings_pct,
            elapsed,
        )
        return final_path
    except (OSError, MemoryError, ValueError, TypeError) as e:
        elapsed = time.time() - t0
        _LOG.warning("shrink failed for %s: %s (%.3fs)", src_path, e, elapsed, exc_info=True)
        return None
    except Exception as e:  # noqa: BLE001 — PIL raises many undocumented exception subclasses
        elapsed = time.time() - t0
        _LOG.warning("shrink failed for %s (unexpected %s): %s (%.3fs)", src_path, type(e).__name__, e, elapsed, exc_info=True)
        return None


def ensure_cache_dir(cache_dir: Path) -> Path:
    """Create *cache_dir* (and any missing parents) idempotently and return it.

    Idempotent because ``mkdir(exist_ok=True)`` is safe to call on a directory
    that already exists.  Separated from ``shrink()`` so tests can pre-create the
    cache directory with known contents without triggering a full shrink cycle.

    Raises ``OSError`` with additional path context if the directory cannot be
    created (e.g. permission denied, disk full).
    """
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise OSError(
            f"image_shrink: cannot create cache directory {cache_dir}: {exc}"
        ) from exc
    return cache_dir


def shrink_if_image(path: Path) -> Path:
    """Shrink *path* if it is a large image; return the (possibly shrunken) path.

    Centralises the "maybe shrink" pattern used by both gdrive.py and
    webfetch.py so neither module needs to repeat the is_image_path guard.

    Raises ``TypeError`` if *path* is None so callers get a meaningful message
    instead of an ``AttributeError`` deep inside ``is_image_path``.
    """
    if path is None:
        raise TypeError("shrink_if_image: path must not be None")
    if is_image_path(str(path)):
        shrunken = shrink(path)
        if shrunken is not None:
            return shrunken
    return path


def stats_for(src_path: Path, shrunken_path: Path) -> ImageStats:
    """Compute compression telemetry for a source/shrunken image pair.

    Reads file sizes via stat and image dimensions via PIL. Both dimension
    reads are best-effort: if PIL is not installed or either file is unreadable,
    the width/height fields are 0 and only byte savings are reported.
    Returns an all-zero ImageStats on any OS error rather than raising.
    """
    _empty = ImageStats(
        src_bytes=0, out_bytes=0, bytes_saved=0,
        orig_width=0, orig_height=0, out_width=0, out_height=0,
    )
    try:
        if not _is_safe_path(src_path) or not _is_safe_path(shrunken_path):
            _LOG.warning("rejected unsafe path in stats_for")
            return _empty
        src_size = src_path.stat().st_size
        out_size = shrunken_path.stat().st_size

        orig_w = orig_h = out_w = out_h = 0
        try:
            from PIL import Image  # noqa: PLC0415
            with Image.open(src_path) as img:
                orig_w, orig_h = img.size
            with Image.open(shrunken_path) as img:
                out_w, out_h = img.size
        except (OSError, MemoryError, ValueError) as exc:
            _LOG.debug("gather_stats: could not read image dimensions for %s: %s", src_path.name, exc)
        except Exception as exc:  # noqa: BLE001 — PIL raises many undocumented exception subclasses
            _LOG.debug("gather_stats: unexpected error reading dimensions for %s (%s): %s", src_path.name, type(exc).__name__, exc)

        return ImageStats(
            src_bytes=src_size,
            out_bytes=out_size,
            bytes_saved=max(0, src_size - out_size),
            orig_width=orig_w,
            orig_height=orig_h,
            out_width=out_w,
            out_height=out_h,
        )
    except OSError:
        return _empty
