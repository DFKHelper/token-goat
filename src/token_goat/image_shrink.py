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
    "AVIF_QUALITY",
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
    "avif_supported",
    "ensure_cache_dir",
    "extract_image_summary",
    "format_threshold",
    "is_image_path",
    "should_shrink",
    "shrink",
    "shrink_if_image",
    "stats_for",
    "vision_tokens",
]

import contextlib
import errno
import functools
import hashlib
import os
import shutil
import stat
import time
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    import types

    from PIL import Image as _PilImage

from . import paths
from .util import get_logger

_LOG = get_logger("image_shrink")

# One-shot orphan sweep flag: set to True after the sweep runs in this process.
# Module init fires the sweep once, idempotent across repeated imports.
_sweep_done = False

# Maximum pixel count on the long axis after resizing.  1024 px keeps the image
# legible for Claude while roughly halving token cost versus the Claude API's own
# 1568 px ceiling (see CLAUDE_MAX_VISION_EDGE_PX below).
MAX_LONG_EDGE = 1024

# Images smaller than this are already cheap enough to send unmodified.
# 100 KB is a conservative threshold: most PNGs below this size are small icons
# or diagrams whose pixel area is already within Claude's efficient range.
SIZE_THRESHOLD_BYTES = 100 * 1024

# Per-format lower bound below which a re-encode is unlikely to pay off.
# JPEG / WebP / AVIF are already lossy-compressed by their producer, so files in
# the 32–100 KB band are usually already efficient and the encode cost (30–80 ms
# on commodity hardware) outweighs any token savings.  PNG / BMP / TIFF / GIF are
# either lossless or weakly compressed: a 40 KB PNG screenshot typically drops to
# 12–20 KB as lossless WebP at zero quality loss, so we lower the threshold for
# those formats.  Falls back to SIZE_THRESHOLD_BYTES for any unrecognized suffix.
_LOSSY_FORMAT_THRESHOLD_BYTES = SIZE_THRESHOLD_BYTES        # JPEG/WebP/AVIF
_LOSSLESS_FORMAT_THRESHOLD_BYTES = 32 * 1024                 # PNG/BMP/TIFF/GIF

_LOSSY_INPUT_SUFFIXES = frozenset({".jpg", ".jpeg", ".webp", ".avif"})
_LOSSLESS_INPUT_SUFFIXES = frozenset({".png", ".bmp", ".tiff", ".tif", ".gif"})


def format_threshold(path_or_suffix: str | Path) -> int:
    """Return the per-format byte threshold below which shrink is a no-op.

    Recognises lossy producer formats (JPEG, WebP, AVIF) and gives them the
    historical :data:`SIZE_THRESHOLD_BYTES` (100 KB) — bytes in those formats
    are likely already efficient, so a re-encode is pure CPU overhead until
    the file is genuinely large.  PNG / BMP / TIFF / GIF inputs get the
    smaller :data:`_LOSSLESS_FORMAT_THRESHOLD_BYTES` (32 KB) because lossless
    inputs at modest size still compress meaningfully when re-emitted as
    lossless WebP or as the configured lossy format.

    Unknown extensions fall back to :data:`SIZE_THRESHOLD_BYTES` so any new
    image format that arrives at the hook is treated conservatively
    (no over-eager shrink).
    """
    if isinstance(path_or_suffix, str):
        suffix = path_or_suffix.lower()
        if not suffix.startswith("."):
            suffix = Path(path_or_suffix).suffix.lower()
    else:
        suffix = path_or_suffix.suffix.lower()
    if suffix in _LOSSLESS_INPUT_SUFFIXES:
        return _LOSSLESS_FORMAT_THRESHOLD_BYTES
    return _LOSSY_FORMAT_THRESHOLD_BYTES

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

# AVIF quality for output when Pillow has AVIF encoder support (libaom).
# Quality 60 is perceptually equivalent to JPEG quality 85 and typically
# 30–50% smaller, giving a further token-budget reduction on top of the
# existing resize step.  Applied only to images > SIZE_THRESHOLD_BYTES and
# only when avif_supported() returns True.
AVIF_QUALITY = 60

# Output format for lossy compression.  Defaults to WebP because it produces
# meaningfully smaller files than JPEG on the typical content the hook sees
# (screenshots, UI, diagrams with text).  Set TOKEN_GOAT_IMAGE_FORMAT=jpeg to
# fall back to JPEG — useful for environments where a downstream consumer does
# not handle WebP, or for A/B comparison.
_ENV_IMAGE_FORMAT = "TOKEN_GOAT_IMAGE_FORMAT"
_DEFAULT_LOSSY_FORMAT = "webp"

@functools.lru_cache(maxsize=1)
def avif_supported() -> bool:
    """Return True if the runtime Pillow can encode AVIF images.

    AVIF support requires Pillow built with libaom (the AV1 reference encoder).
    Available in Pillow ≥ 10.x when the package was compiled with AVIF enabled.
    The result is cached after the first call because ``Image.init()`` is not
    free and the encoder set does not change at runtime.

    Falls back gracefully to False on any import or attribute error so callers
    can treat this as a capability probe without try/except at every call site.
    """
    try:
        from PIL import Image  # noqa: PLC0415
        Image.init()
        return "AVIF" in Image.SAVE
    except Exception:  # noqa: BLE001
        return False


# Cache key version.  Bumped whenever the compression pipeline changes in a way
# that would produce different bytes for the same input — quality knobs, format
# selection, downscale algorithm.  Included in the content hash so old cache
# entries are silently superseded rather than serving stale (worse-compressed)
# output indefinitely.
CACHE_KEY_VERSION = 3

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

# Hard pixel-count cap applied at module load time.  A 90 KB JPEG can decode to
# a 200 MB+ bitmap; without a cap the hook process RSS spikes silently on tight-
# memory machines.  Pillow raises DecompressionBombWarning (and then
# DecompressionBombError) when MAX_IMAGE_PIXELS is exceeded, so we catch it in
# shrink() and return None (skip) rather than crashing the hook.
# Override with TOKEN_GOAT_MAX_IMAGE_PIXELS=<n> (set to 0 to disable the cap).
_MAX_PIXELS = int(os.getenv("TOKEN_GOAT_MAX_IMAGE_PIXELS", "16000000"))

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


def _get_source_mtime(src_path: Path) -> float:
    """Return the source file's mtime, or 0.0 if unreadable."""
    try:
        return src_path.stat().st_mtime
    except OSError:
        return 0.0


def _store_source_mtime(cache_path: Path, src_mtime: float) -> None:
    """Store the source file's mtime in a companion .mtime sidecar file.

    The sidecar is a simple text file containing a single float timestamp.
    Fail-soft: any IO error is logged but does not block the shrink.
    """
    mtime_path = cache_path.with_suffix(cache_path.suffix + ".mtime")
    try:
        mtime_path.write_text(f"{src_mtime:.6f}")
    except OSError as exc:
        _LOG.debug("_store_source_mtime: failed to write sidecar for %s: %s", cache_path.name, exc)


def _load_source_mtime(cache_path: Path) -> float | None:
    """Load the stored source file's mtime from the companion .mtime sidecar file.

    Returns None if the sidecar does not exist or is unreadable; this signals
    "cache hit but no mtime record" which is treated as a valid (unverified) cache hit
    for backwards compatibility with existing cached entries.
    """
    mtime_path = cache_path.with_suffix(cache_path.suffix + ".mtime")
    try:
        if not mtime_path.exists():
            return None
        text = mtime_path.read_text(encoding="utf-8").strip()
        return float(text)
    except (OSError, ValueError) as exc:
        _LOG.debug("_load_source_mtime: failed to read sidecar for %s: %s", cache_path.name, exc)
        return None


def _cache_path_for(src_path: Path) -> Path:
    """Return the base cache path (stem only) for *src_path*.

    The actual output file is one of ``<hash>.shrunk.avif`` (AVIF when
    supported and preferred), ``<hash>.shrunk.webp`` (default lossy output),
    ``<hash>.shrunk.jpg`` (JPEG fallback via ``TOKEN_GOAT_IMAGE_FORMAT`` or for
    paranoid-compatibility paths), or ``<hash>.shrunk.png`` (screenshots with
    transparency).  Callers probe all four suffixes when checking for a cache
    hit, so switching the lossy format at runtime still correctly re-uses an
    existing cached output if one is present in any format.
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

    The per-format threshold from :func:`format_threshold` lets PNG / BMP /
    TIFF / GIF inputs cross the bar at 32 KB while JPEG / WebP / AVIF inputs
    still need 100 KB — lossy producer formats below 100 KB are usually
    already efficient and the encode CPU outweighs the saving, but lossless
    inputs in the 32–100 KB band typically halve under a lossless WebP pass.
    """
    try:
        if not is_image_path(src_path):
            return False
        st = src_path.stat()  # single syscall: raises FileNotFoundError if absent
        return stat.S_ISREG(st.st_mode) and st.st_size > format_threshold(src_path)
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


def _sweep_orphans() -> None:
    """One-shot cleanup of orphan image-cache blobs (files older than orphan_age_secs).

    An orphan is a ``.shrunk.*`` blob in the image cache directory that was
    written but never looked up. This can accumulate when a hook is interrupted
    between writing the blob and recording/accessing the index (in our case,
    content-addressed lookups via _cache_key).

    Runs once per process (guarded by _sweep_done flag) at module init so the
    LRU eviction does not have to compete with dead bytes. Fail-soft: any IO
    error is logged as a warning and the sweep skips to the next file without
    crashing. Never raises; safe to call from hot paths.

    The age threshold is configurable via config.toml [image_shrink]
    orphan_age_secs (default 7 days) or disabled via TOKEN_GOAT_ORPHAN_SWEEP=0.

    Orphan detection uses mtime-based age check; on FAT32/network drives where
    mtime has 2-second resolution, we verify with exists() after a small delay
    to handle filesystem race conditions.
    """
    global _sweep_done  # noqa: PLW0603
    if _sweep_done:
        return
    _sweep_done = True

    try:
        from .config import load as _load_config  # noqa: PLC0415
        _cfg = _load_config()
        if not _cfg.image_shrink.orphan_sweep_enabled:
            _LOG.debug("_sweep_orphans: disabled by config")
            return
        age_secs = _cfg.image_shrink.orphan_age_secs
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("_sweep_orphans: config load failed, skipping: %s", exc)
        return

    cache_dir = paths.image_cache_dir()
    if not cache_dir.is_dir():
        return

    now = time.time()
    removed = 0
    try:
        for fp in cache_dir.iterdir():
            if not fp.name.endswith((".shrunk.avif", ".shrunk.webp", ".shrunk.jpg", ".shrunk.png")):
                continue
            try:
                st = fp.stat()
                age = now - st.st_mtime
                if age > age_secs:
                    # Files older than orphan_age_secs (default 7 days) are safe
                    # to remove. Any concurrent deletion is handled by the OSError
                    # catch below (FileNotFoundError is a subclass of OSError).
                    # A sleep+exists() check was previously here but added 10ms of
                    # latency per orphan and provided no real protection — the OSError
                    # catch already handles all concurrent-deletion races.
                    fp.unlink()
                    removed += 1
                    _LOG.debug("_sweep_orphans: removed %s (age=%.1f days)", fp.name, age / 86400.0)
            except OSError as exc:
                _LOG.debug("_sweep_orphans: failed to remove %s: %s", fp.name, exc)
                continue
    except OSError as exc:
        _LOG.debug("_sweep_orphans: directory scan failed: %s", exc)
        return

    if removed > 0:
        _LOG.info("_sweep_orphans: removed %d orphan blob(s)", removed)


# Minimum free-disk-space required before writing a shrunk image to the cache.
# Below this threshold the shrink is skipped and the original path is returned
# so a full disk doesn't stall the hook with a partial-write crash.
# Configurable via TOKEN_GOAT_MIN_FREE_MB (integer MiB).
_MIN_FREE_MB: int = int(os.getenv("TOKEN_GOAT_MIN_FREE_MB", "50"))
_MIN_FREE_BYTES: int = _MIN_FREE_MB * 1024 * 1024


def _check_disk_space(path: Path) -> bool:
    """Return True if there is at least _MIN_FREE_BYTES free on *path*'s filesystem.

    Uses :func:`shutil.disk_usage` which is cross-platform and does not require
    OS-specific imports.  Falls back to True on any error so a transient stat
    failure never prevents a shrink that could succeed.
    """
    try:
        usage = shutil.disk_usage(path)
        return usage.free >= _MIN_FREE_BYTES
    except OSError:
        return True  # fail-open: if we can't check, try the write anyway


def shrink(src_path: Path, *, _session_id: str | None = None) -> Path | None:
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

    Args:
        src_path: Path to the source image file.
        _session_id: (Internal, optional) Session ID used to track per-session shrink
            budgets. When provided, the session cache records this shrink event for
            later dedup analysis. Callers should not set this parameter directly;
            it is for use by hooks that have session context.

    Returns ``None`` (never raises) on any PIL, OS, or memory error. Callers treat
    ``None`` as "use original path". On success returns the cached output ``Path``.
    Callers that want an alt-text summary should reopen the result with PIL and
    pass it to :func:`extract_image_summary`.
    """
    # Fire the one-shot orphan sweep on first shrink call in this process.
    # The sweep is fail-soft: any error is logged and skipped, never blocking.
    _sweep_orphans()

    # Track per-session shrink count to detect repeated shrinking of the same
    # image (e.g., a generated screenshot appearing 50 times in a session).
    # If an image at the same absolute path is shrunk >3 times in a session,
    # we log a hint so the hook can emit a "use --session <id>" suggestion
    # for surgical reads instead of repeatedly shrinking the same input.
    # This is best-effort: if the session ID is not provided or if the session
    # cache is unavailable, the tracking is skipped (fail-soft).
    if _session_id:
        try:
            from . import session as _session_module  # noqa: PLC0415
            _sess = _session_module.safe_load(_session_id)
            if _sess and not _sess.unavailable:
                # Use str(src_path.resolve()) as the per-image key — absolute,
                # canonical path that resolves symlinks so the same physical file
                # is always tracked under one key even if accessed via different paths.
                _img_key = str(src_path.resolve())
                _shrink_count = _sess.image_shrink_count.get(_img_key, 0) + 1
                _sess.image_shrink_count[_img_key] = _shrink_count
                # Enforce cap: evict lowest-count entries when the dict exceeds
                # IMAGE_SHRINK_COUNT_MAX.  Drop _IMAGE_SHRINK_COUNT_EVICT at once
                # to amortise dict-rewrite cost.
                _img_cap = _session_module.IMAGE_SHRINK_COUNT_MAX
                _img_evict = _session_module._IMAGE_SHRINK_COUNT_EVICT  # noqa: SLF001
                if len(_sess.image_shrink_count) > _img_cap:
                    _sorted_img = sorted(
                        _sess.image_shrink_count.items(), key=lambda x: x[1]
                    )
                    _sess.image_shrink_count = dict(_sorted_img[_img_evict:])
                # Log once every 10 shrinks to avoid log spam when count > 3.
                # Helps operators notice the pattern without overwhelming the logs.
                if _shrink_count > 3 and _shrink_count % 10 == 1:
                    _LOG.info(
                        "image %s has been shrunk %d times in this session; "
                        "consider using token-goat read/section for surgical access",
                        src_path.name, _shrink_count,
                    )
                # Mutate the session cache in-memory; the hook's post-read handler
                # will persist it to disk. Fail-soft: if the save later fails, we
                # still return the shrunken image (never block the agent).
        except Exception as exc:  # noqa: BLE001
            # Any error in session tracking (load, mutation) is benign and logged.
            _LOG.debug("image_shrink: per-session tracking failed: %s", exc)
            pass

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
    if src_size <= format_threshold(src_path):
        return None

    # Animated images (multi-frame GIF, animated WebP, APNG) cannot be
    # meaningfully compressed to a single-frame output without losing the
    # animation.  Check before the cache lookup so a stale cache entry from
    # an earlier (pre-check) run never gets served for an animated source.
    # Only open PIL for formats that can carry animation — avoids overhead on
    # the common JPEG/PNG path.  Use is_animated when available (Pillow 9.1+);
    # fall back to n_frames > 1 for older builds.
    _animated_suffixes = frozenset({".gif", ".webp", ".png"})
    if src_path.suffix.lower() in _animated_suffixes:
        try:
            from PIL import Image as _AnimCheck  # noqa: PLC0415
            with _AnimCheck.open(src_path) as _ac_img:
                _is_anim = getattr(_ac_img, "is_animated", None)
                if _is_anim is None:
                    _is_anim = getattr(_ac_img, "n_frames", 1) > 1
                if _is_anim:
                    _LOG.debug(
                        "shrink: skipping animated image %s (n_frames=%d)",
                        src_path.name, getattr(_ac_img, "n_frames", "?"),
                    )
                    return None
        except Exception:  # noqa: BLE001
            pass  # Unreadable or exotic format; fall through to normal pipeline

    # Disk-space guard: check free space on the cache volume before attempting
    # to write.  A Pillow save to a full disk produces a partial file (ENOSPC)
    # that would be flagged as a corrupt cache entry on the next read.  Skipping
    # the shrink entirely returns the original path unchanged — the worst outcome
    # is that the model sees a larger image, not a crash.
    cache_vol = paths.image_cache_dir()
    if not _check_disk_space(cache_vol):
        _LOG.warning(
            "shrink: skipping %s — less than %d MB free on cache volume",
            src_path.name, _MIN_FREE_MB,
        )
        return None

    paths.ensure_dir(paths.image_cache_dir())

    stem = _cache_path_for(src_path)  # e.g. .../abc123.shrunk
    # Check for already-cached variants in any supported output format.  AVIF
    # is probed first when preferred; then the configured lossy format; all
    # other formats follow so a format switch at runtime still finds existing
    # cache entries in whichever format they were originally written.
    lossy_fmt = _lossy_format()
    lossy_suffix = f".{lossy_fmt}" if lossy_fmt != "jpeg" else ".jpg"
    suffixes = [".avif", lossy_suffix] + [s for s in (".webp", ".jpg", ".png") if s not in (".avif", lossy_suffix)]

    # Get the current source file's mtime for validation on cache hit.
    src_mtime = _get_source_mtime(src_path)

    for suffix in suffixes:
        candidate = stem.with_suffix(suffix)
        if candidate.exists():
            # Check source file mtime for staleness: if the source was updated after
            # the cache was created, the cached version is stale and needs re-shrinking.
            # This handles the case where an image file is replaced or modified.
            stored_mtime = _load_source_mtime(candidate)
            if stored_mtime is not None and src_mtime != 0.0 and src_mtime > stored_mtime:
                # Source file mtime changed — cache is stale, invalidate it.
                _LOG.debug(
                    "image cache staleness detected: %s mtime=%.2f > stored=%.2f, will re-shrink from %s",
                    candidate.name, src_mtime, stored_mtime, src_path.name,
                )
                try:
                    candidate.unlink()
                except OSError as _unlink_exc:
                    _LOG.debug("failed to unlink stale cache file %s: %s", candidate.name, _unlink_exc)
                # Also clean up the mtime sidecar
                try:
                    mtime_sidecar = candidate.with_suffix(candidate.suffix + ".mtime")
                    if mtime_sidecar.exists():
                        mtime_sidecar.unlink()
                except OSError:
                    pass
                continue  # Try next suffix or fall through to re-shrink.

            # Before returning a cached image, validate that it's readable.
            # A truncated cache file (partial write from an interrupted shrink)
            # will cause Pillow to raise UnidentifiedImageError or
            # DecompressionBombError. If the cached file is corrupt, delete it,
            # log a warning, and fall through to re-shrink from the original source.
            # This ensures that transient cache corruption doesn't block the agent.
            try:
                from PIL import Image as _ValidateImage  # noqa: PLC0415
                with _ValidateImage.open(candidate) as _:
                    pass  # File is readable; proceed to use it.
            except (OSError, EOFError) as exc:
                # OSError: file deleted between exists() and open() (rare race)
                # EOFError: truncated file (corrupt cache entry)
                # Both cases: fall through to re-shrink below.
                _LOG.warning(
                    "image cache corruption detected: %s (%s), will re-shrink from %s",
                    candidate.name, type(exc).__name__, src_path.name,
                )
                try:
                    candidate.unlink()
                except OSError as _unlink_exc:
                    _LOG.debug("failed to unlink corrupt cache file %s: %s", candidate.name, _unlink_exc)
                continue  # Try next suffix or fall through to re-shrink.
            except Exception as exc:  # noqa: BLE001 — Pillow raises many exception types
                # UnidentifiedImageError, DecompressionBombError, MemoryError, etc.
                # Any unexpected error during validation: delete the corrupt entry
                # and re-shrink. This prevents a partially-written or corrupted
                # cache file from causing the hook to return None (treat as failure).
                _LOG.warning(
                    "image cache validation failed: %s (%s: %s), will re-shrink from %s",
                    candidate.name, type(exc).__name__, exc, src_path.name,
                )
                try:
                    candidate.unlink()
                except OSError as _unlink_exc:
                    _LOG.debug("failed to unlink corrupt cache file %s: %s", candidate.name, _unlink_exc)
                continue  # Try next suffix or fall through to re-shrink.

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

        # Apply the pixel cap each time PIL is imported in this process.
        # Setting MAX_IMAGE_PIXELS to None disables Pillow's bomb guard entirely,
        # so we only set it when _MAX_PIXELS > 0 (i.e. the cap is active).
        if _MAX_PIXELS > 0:
            Image.MAX_IMAGE_PIXELS = _MAX_PIXELS

        # Image.open returns ImageFile; downstream resize/convert/paste return
        # Image. Annotate broadly so reassignment doesn't trip the type checker.
        img: Image.Image
        with Image.open(src_path) as img:
            # Warn when the decoded bitmap is large enough to be a memory concern,
            # even though it falls within the Pillow cap.  Half of _MAX_PIXELS is
            # the threshold — anything above it is "large but still allowed".
            _pixel_count = img.size[0] * img.size[1]
            if _MAX_PIXELS > 0 and _pixel_count > _MAX_PIXELS // 2:
                _LOG.debug(
                    "shrink: large bitmap %s (%d×%d = %d pixels, cap=%d)",
                    src_path.name,
                    img.size[0],
                    img.size[1],
                    _pixel_count,
                    _MAX_PIXELS,
                )

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
            # the best available lossy format:
            #   1. AVIF (when prefer_avif=True and libaom is available) — 30–50%
            #      smaller than JPEG at equivalent perceived quality; q60 ≈ JPEG q85.
            #   2. WebP (default fallback) — typically 30–50% smaller than JPEG
            #      on screenshot/UI content; accepted natively by Claude's vision API.
            #   3. JPEG (TOKEN_GOAT_IMAGE_FORMAT=jpeg or TOKEN_GOAT_PREFER_AVIF=0).
            #
            # WebP/AVIF compression of RGBA is supported by Pillow, but we keep the
            # PNG path for RGBA screenshots because alpha through lossy encoders is
            # quality-sensitive in ways lossless PNG simply isn't, and screenshots
            # are the workload where preserved fidelity matters most.
            is_screenshot = _looks_like_screenshot_or_text(img)
            if is_screenshot and img.mode in ("RGBA", "LA"):
                # Keep PNG with alpha for screenshots — lossless, alpha-safe.
                final_path = stem.with_suffix(".png")
                img.save(final_path, "PNG", optimize=True)
            else:
                # Flatten to RGB and emit the best available lossy format.
                img = _ensure_rgb(img, Image)

                # Load config once per call to check AVIF preference.
                # Import here (not module-level) to avoid circular import:
                # config.py does not import image_shrink, but image_shrink importing
                # config at module level would tie initialisation order tightly.
                from .config import load as _load_config  # noqa: PLC0415
                _cfg = _load_config()
                # TOKEN_GOAT_IMAGE_FORMAT=jpeg is an explicit override that forces JPEG
                # output and therefore disables AVIF — the env var expresses a downstream
                # compatibility constraint that trumps the prefer_avif preference.
                _explicit_fmt = _lossy_format()
                use_avif = (
                    _explicit_fmt != "jpeg"
                    and _cfg.image_shrink.prefer_avif
                    and avif_supported()
                )

                if use_avif:
                    final_path = stem.with_suffix(".avif")
                    img.save(final_path, "AVIF", quality=_cfg.image_shrink.avif_quality)
                else:
                    fmt = _lossy_format()
                    if fmt == "webp":
                        final_path = stem.with_suffix(".webp")
                        # Diagrams (portrait-dominant images classified by extract_image_summary)
                        # contain sharp lines, text labels, and hard colour boundaries that
                        # degrade visibly under lossy WebP.  Use lossless encoding for these
                        # so the model can read diagram annotations accurately.
                        # For all other images (screenshots, photos) lossy quality=WEBP_QUALITY
                        # gives the best size reduction with negligible fidelity loss.
                        _w, _h = img.size
                        _is_diagram = _h > 0 and _w > 0 and (_h / _w) >= 1.4
                        if _is_diagram:
                            img.save(
                                final_path,
                                "WEBP",
                                lossless=True,
                                method=WEBP_METHOD,
                            )
                        else:
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
                        img.save(final_path, "JPEG", quality=_cfg.image_shrink.jpeg_quality, optimize=True, progressive=True)

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

        # Store the source file's mtime in a sidecar so cache staleness can be detected
        # on future lookups. This allows us to invalidate the cache if the source
        # file is modified or replaced.
        _store_source_mtime(final_path, src_mtime)

        return final_path
    except OSError as e:
        elapsed = time.time() - t0
        # ENOSPC (errno 28 on POSIX; also surfaces on Windows as errno 28 via CRT)
        # means the disk filled up mid-write.  The partial cache file is gone
        # (atomic_write / Pillow flushes to a tmp then renames; if that fails the
        # tmp is left behind and the rename never happens).  Log a targeted warning
        # and return None so the caller falls back to the original path.
        if e.errno == errno.ENOSPC:
            _LOG.warning(
                "shrink: disk full writing cache for %s — returning original path (%.3fs)",
                src_path.name, elapsed,
            )
        else:
            _LOG.warning(
                "shrink failed for %s (%s): %s (%.3fs)",
                src_path, type(e).__name__, e, elapsed, exc_info=True,
            )
        return None
    except Exception as e:  # noqa: BLE001 — PIL raises many undocumented exception subclasses
        elapsed = time.time() - t0
        _LOG.warning(
            "shrink failed for %s (%s): %s (%.3fs)",
            src_path, type(e).__name__, e, elapsed, exc_info=True,
        )
        return None


def extract_image_summary(src_path: Path, img: _PilImage.Image) -> str:
    """Build a short textual summary of an image for use as alt-text context.

    Returns a non-empty string of the form::

        "[Image: screenshot ~1280x720, filename: foo.png]"

    or, when an EXIF ImageDescription is present::

        "Some description. [Image: screenshot ~1280x720, filename: foo.png]"

    Classification:
    - ``screenshot``: width/height ratio >= 1.4 (landscape-dominant)
    - ``diagram``:    height/width ratio >= 1.4 (portrait-dominant)
    - ``image``:      everything else (roughly square)

    Never raises; EXIF errors are silently swallowed.
    """
    w, h = img.size
    if h > 0 and w / h >= 1.4:
        kind = "screenshot"
    elif w > 0 and h / w >= 1.4:
        kind = "diagram"
    else:
        kind = "image"

    summary = f"[Image: {kind} ~{w}x{h}, filename: {src_path.name}]"

    try:
        exif = img._getexif()  # type: ignore[attr-defined]  # PIL private but stable
        if exif:
            # EXIF tag 270 = ImageDescription
            description = exif.get(270)
            if description and isinstance(description, str) and description.strip():
                summary = f"{description.strip()}. {summary}"
    except Exception:  # noqa: BLE001
        pass

    return summary


def ensure_cache_dir(cache_dir: Path) -> Path:
    """Create *cache_dir* (and any missing parents) idempotently and return it.

    Idempotent because ``mkdir(exist_ok=True)`` is safe to call on a directory
    that already exists.  Separated from ``shrink()`` so tests can pre-create the
    cache directory with known contents without triggering a full shrink cycle.

    Raises ``OSError`` with additional path context if the directory cannot be
    created (e.g. permission denied, disk full).
    """
    try:
        paths.ensure_dir(cache_dir)
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
            if _MAX_PIXELS > 0:
                Image.MAX_IMAGE_PIXELS = _MAX_PIXELS
            with contextlib.suppress(OSError, MemoryError, ValueError), Image.open(src_path) as img:
                orig_w, orig_h = img.size
            with contextlib.suppress(OSError, MemoryError, ValueError), Image.open(shrunken_path) as img:
                out_w, out_h = img.size
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
