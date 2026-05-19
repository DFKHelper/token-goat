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

__all__ = [
    "CACHE_KEY_VERSION",
    "CLAUDE_MAX_VISION_EDGE_PX",
    "CLAUDE_VISION_PIXELS_PER_TOKEN",
    "IMAGE_EXTENSIONS",
    "ImageStats",
    "JPEG_QUALITY",
    "MAX_LONG_EDGE",
    "SIZE_THRESHOLD_BYTES",
    "WEBP_METHOD",
    "WEBP_QUALITY",
    "ensure_cache_dir",
    "is_image_path",
    "should_shrink",
    "shrink",
    "shrink_if_image",
    "stats_for",
    "vision_tokens",
]

import contextlib
import functools
import hashlib
import logging
import os
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

# WebP quality for photographic output.  WebP at q=80 typically produces files
# 30–50% smaller than JPEG at q=75 on screenshot/UI/text content while preserving
# more edge fidelity.  On noisy photographic content the two formats are roughly
# comparable in size — WebP rarely loses, frequently wins, never wins less than a
# few percent.  Claude's vision API accepts image/webp natively per Anthropic docs
# (jpeg / png / gif / webp are the four supported types), so emitting WebP is a
# strict token-cost reduction with no compatibility cost.
WEBP_QUALITY = 80
# WebP encoder method: 0 (fast) – 6 (slow, best compression).  Method 6 squeezes
# out an additional 5–10% versus the default 4, at the cost of about 2× encode time.
# For 1024 px images this is still under 100 ms — well within the hook budget.
WEBP_METHOD = 6

# Output format for lossy compression.  Defaults to WebP because it produces
# meaningfully smaller files than JPEG on the typical content the hook sees
# (screenshots, UI, diagrams with text).  Set TOKEN_GOAT_IMAGE_FORMAT=jpeg to
# fall back to JPEG — useful for environments where a downstream consumer does
# not handle WebP, or for A/B comparison.
_ENV_IMAGE_FORMAT = "TOKEN_GOAT_IMAGE_FORMAT"
_DEFAULT_LOSSY_FORMAT = "webp"

# Cache key version.  Bumped whenever the compression pipeline changes in a way
# that would produce different bytes for the same input — quality knobs, format
# selection, downscale algorithm.  Included in the content hash so old cache
# entries are silently superseded rather than serving stale (worse-compressed)
# output indefinitely.
CACHE_KEY_VERSION = 2

# Claude vision API parameters (source: Anthropic docs).
# Claude downscales images to fit within this many pixels on the long edge
# before tokenizing; the cost formula is (effective_width × effective_height) / pixels_per_token.
CLAUDE_MAX_VISION_EDGE_PX = 1568
CLAUDE_VISION_PIXELS_PER_TOKEN = 750

# Heuristic max long-edge for images that look like screenshots or text
# (palette/alpha modes at reasonable sizes). Set just below CLAUDE_MAX_VISION_EDGE_PX
# (1568): an image this large and still in palette/alpha mode is almost certainly a
# photograph mislabelled by its encoder, not a UI screenshot — JPEG will compress it
# far better than PNG regardless of its palette.
_SCREENSHOT_MAX_EDGE_PX = 1500

# Recognized image extensions — the pre-read hook uses this list to decide
# whether to attempt shrinking before the image is read into context.
IMAGE_EXTENSIONS = frozenset(
    [".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".tif", ".bmp", ".gif"]
)


def is_image_path(path: str | Path) -> bool:
    """Return True if *path* has a recognised image extension (case-insensitive).

    Accepts either a string or a :class:`~pathlib.Path` so callers that already
    hold a ``Path`` object do not pay for a redundant ``str()`` round-trip
    followed by a fresh ``Path()`` construction inside this function.
    Only checks the extension string — does not open the file or verify content.
    Used as a fast pre-filter before the more expensive stat/PIL operations.
    """
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def _cache_key(src_path: Path) -> str:
    """sha256 of the image's *content*, prefixed with the cache key version.

    Content-addressing — rather than keying on path+mtime+size — means identical
    images share one cache entry regardless of where they live, and any real
    content change invalidates the entry while a bare mtime touch does not. This
    matters because Claude Code stages prompt-attached images to a fresh temp
    filename on every prompt: a path/mtime key misses the cache for the same
    image re-used across prompts, and even for one image referenced twice in a
    single prompt.

    The ``CACHE_KEY_VERSION`` byte prefix means changing the compression pipeline
    (new format, new quality, new downscale ceiling) automatically supersedes old
    cache entries without us having to crawl the cache dir to evict them — old
    files simply stop being looked up and age out via the LRU cleaner.

    Uses streaming 1 MB chunks to avoid memory spikes on large images.
    """
    try:
        h = hashlib.sha256()
        # Mix the cache version into the hash so a pipeline change invalidates
        # everything previously cached without touching the filesystem.
        h.update(f"v{CACHE_KEY_VERSION}\n".encode())
        # Stream in 1 MB chunks to avoid loading large images into memory.
        # chunk_size = 1 << 20 means 1 MB; this is the same buffer size used
        # throughout the codebase for efficient streaming (see webfetch.py).
        with src_path.open("rb") as f:
            chunk_size = 1 << 20
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError as exc:
        _LOG.debug("_cache_key: could not read %s for content hash, falling back to path hash: %s", src_path.name, exc)
        return hashlib.sha256(f"v{CACHE_KEY_VERSION}|{src_path}".encode()).hexdigest()


def _cache_path_for(src_path: Path) -> Path:
    """Return the base cache path (stem only) for *src_path*.

    The actual output file is one of ``<hash>.shrunk.webp`` (default lossy
    output), ``<hash>.shrunk.jpg`` (JPEG fallback via ``TOKEN_GOAT_IMAGE_FORMAT``
    or for paranoid-compatibility paths), or ``<hash>.shrunk.png`` (screenshots
    with transparency).  Callers probe all three suffixes when checking for a
    cache hit, so switching the lossy format at runtime via env var still
    correctly re-uses an existing cached output if one is present in any format.
    """
    key = _cache_key(src_path)
    return paths.image_cache_dir() / f"{key}.shrunk"


def _lossy_format() -> str:
    """Return the lossy output format selected at runtime.

    Defaults to WebP (``_DEFAULT_LOSSY_FORMAT``); falls back to JPEG when
    ``TOKEN_GOAT_IMAGE_FORMAT=jpeg`` (or ``jpg``).  Any other value logs a
    warning and falls back to the default, so a typo in the env var can never
    silently disable image shrinking.
    """
    raw = os.environ.get(_ENV_IMAGE_FORMAT, "").strip().lower()
    if raw in ("", _DEFAULT_LOSSY_FORMAT):
        return _DEFAULT_LOSSY_FORMAT
    if raw in ("jpeg", "jpg"):
        return "jpeg"
    if raw == "webp":
        return "webp"
    _LOG.warning(
        "Unknown %s=%r; expected webp or jpeg, using default %s",
        _ENV_IMAGE_FORMAT, raw, _DEFAULT_LOSSY_FORMAT,
    )
    return _DEFAULT_LOSSY_FORMAT


@functools.lru_cache(maxsize=256)
def vision_tokens(width: int, height: int) -> int:
    """Approximate Claude vision token cost for an image of given dimensions.

    Claude resizes images to fit within CLAUDE_MAX_VISION_EDGE_PX on the long
    edge before tokenizing. Token cost ≈ (effective_width × effective_height) /
    CLAUDE_VISION_PIXELS_PER_TOKEN.

    Cached with maxsize=256: repeated dimension lookups within a session
    (common for identical screenshots or documents) skip recalculation.
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
        if not is_image_path(src_path):
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
    if not is_image_path(src_path):
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
    # Check for already-cached variants in any supported output format.  The
    # configured lossy format is probed first; all other formats follow so a
    # format switch via TOKEN_GOAT_IMAGE_FORMAT still finds existing cache entries.
    lossy_fmt = _lossy_format()
    lossy_suffix = f".{lossy_fmt}" if lossy_fmt != "jpeg" else ".jpg"
    suffixes = [lossy_suffix] + [s for s in (".webp", ".jpg", ".png") if s != lossy_suffix]

    for suffix in suffixes:
        candidate = stem.with_suffix(suffix)
        if candidate.exists():
            elapsed = time.time() - t0
            _LOG.debug("image cache hit: %s -> %s (%.3fs)", src_path.name, candidate.name, elapsed)
            # Bump mtime so the LRU evictor in worker.evict_image_cache_if_over_limit
            # treats a frequently-hit cache entry as recently-used.  Without this,
            # the cache is content-addressed and *never modified after creation*,
            # so st_mtime equals creation time — the eviction sort would degenerate
            # to FIFO and discard hot entries first.  Windows atime is unreliable
            # (often disabled at the volume level), so bumping mtime is the most
            # portable per-hit "touch" signal available.
            # Only bump if the file was last touched >1 hour ago; this reduces
            # unnecessary I/O for hot images in a session without materially
            # affecting LRU accuracy (1 hour is well below typical session length).
            try:
                now = time.time()
                st = candidate.stat()
                if now - st.st_mtime > 3600:  # 1 hour in seconds
                    os.utime(candidate, (now, now))
            except OSError:
                pass  # Benign — cache still works, just loses a little LRU fidelity
            return candidate

    try:
        from PIL import Image, ImageOps  # noqa: PLC0415

        # Image.open returns ImageFile; downstream resize/convert/paste return
        # Image. Annotate broadly so reassignment doesn't trip the type checker.
        img: Image.Image
        with Image.open(src_path) as img:
            # Preserve EXIF orientation — some cameras embed rotation metadata
            # rather than rotating pixels; ignoring this produces upside-down output.
            # Suppress only the documented failure modes of exif_transpose:
            # OSError / ValueError from malformed EXIF bytes, AttributeError if the
            # image has no EXIF segment, and ZeroDivisionError from certain corrupt
            # rational tags.  We do NOT suppress MemoryError or BaseException here.
            with contextlib.suppress(OSError, ValueError, AttributeError, ZeroDivisionError):
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
            # compressed into lossy blur artifacts.  Everything else flows to
            # the configured lossy format (WebP by default — typically 30–50%
            # smaller than JPEG at equivalent perceived quality on screenshot
            # and UI content, and Claude's vision API accepts it natively).
            #
            # WebP compression of RGBA is also supported, but we keep the PNG
            # path for RGBA screenshots because alpha through WebP-lossy is
            # quality-sensitive in ways PNG simply isn't, and screenshots are
            # the workload where preserved fidelity matters most.
            is_screenshot = _looks_like_screenshot_or_text(img)
            if is_screenshot and img.mode in ("RGBA", "LA"):
                # Keep PNG with alpha for screenshots
                final_path = stem.with_suffix(".png")
                img.save(final_path, "PNG", optimize=True)
            else:
                # Flatten to RGB and emit the configured lossy format.
                img = _ensure_rgb(img, Image)
                fmt = _lossy_format()
                if fmt == "webp":
                    final_path = stem.with_suffix(".webp")
                    # method=6 is the slowest/best encoder setting — at 1024 px
                    # this still completes in well under 100 ms on commodity
                    # hardware, comfortably inside the hook budget.
                    img.save(
                        final_path,
                        "WEBP",
                        quality=WEBP_QUALITY,
                        method=WEBP_METHOD,
                    )
                else:
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
    except Exception as e:  # noqa: BLE001 — PIL raises many undocumented exception subclasses
        elapsed = time.time() - t0
        _LOG.warning(
            "shrink failed for %s (%s): %s (%.3fs)",
            src_path, type(e).__name__, e, elapsed, exc_info=True,
        )
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

    Uses should_shrink() for fast pre-check before calling shrink(), avoiding
    PIL overhead on small images or non-image files.

    Raises ``TypeError`` if *path* is None so callers get a meaningful message
    instead of an ``AttributeError`` deep inside ``is_image_path``.
    """
    if path is None:
        raise TypeError("shrink_if_image: path must not be None")
    # Fast pre-check: should_shrink() does extension + size check without PIL.
    # This avoids calling shrink() on small files or non-image types.
    if should_shrink(path):
        shrunken = shrink(path)
        if shrunken is not None:
            return shrunken
        _LOG.debug("shrink_if_image: shrink returned None for %s, using original path", path.name)
    return path


def stats_for(src_path: Path, shrunken_path: Path, src_size_bytes: int | None = None) -> ImageStats:
    """Compute compression telemetry for a source/shrunken image pair.

    Reads file sizes via stat and image dimensions via PIL. Both dimension
    reads are best-effort: if PIL is not installed or either file is unreadable,
    the width/height fields are 0 and only byte savings are reported.
    Returns an all-zero ImageStats on any OS error rather than raising.

    Args:
        src_path: Path to the original image file.
        shrunken_path: Path to the compressed/shrunk image file.
        src_size_bytes: Optional pre-computed source file size in bytes. If provided,
            avoids a redundant stat() call on the source file. Useful when stats_for()
            is called immediately after shrinking, where the source size is already known.

    Optimizations:
    - PIL is imported only once and reused for both image reads.
    - Short-circuit on missing files or unsafe paths before importing PIL.
    - Accepts pre-computed source size to avoid double-statting during shrinking pipeline.
    """
    _empty = ImageStats(
        src_bytes=0, out_bytes=0, bytes_saved=0,
        orig_width=0, orig_height=0, out_width=0, out_height=0,
    )
    try:
        if not _is_safe_path(src_path) or not _is_safe_path(shrunken_path):
            _LOG.warning("rejected unsafe path in stats_for")
            return _empty
        # Use pre-computed src_size if provided to avoid redundant stat() call.
        # When called from pre-read hook or shrink pipeline, the source size is
        # already known from should_shrink() or shrink() and we can skip re-statting.
        src_size = src_size_bytes if src_size_bytes is not None else src_path.stat().st_size
        out_size = shrunken_path.stat().st_size

        orig_w = orig_h = out_w = out_h = 0
        try:
            # Import PIL once and reuse it for both image opens; avoids the
            # per-call import overhead in the next-exception path.
            from PIL import Image  # noqa: PLC0415
            try:
                with Image.open(src_path) as img:
                    orig_w, orig_h = img.size
            except (OSError, MemoryError, ValueError):
                pass  # Best effort; dimension reads are optional.
            try:
                with Image.open(shrunken_path) as img:
                    out_w, out_h = img.size
            except (OSError, MemoryError, ValueError):
                pass  # Best effort; dimension reads are optional.
        except ImportError:
            # PIL not installed; skip dimension reads.
            _LOG.debug("gather_stats: PIL not available; skipping dimension reads")
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
