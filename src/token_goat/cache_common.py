"""Shared constants and helpers used by both :mod:`bash_cache` and :mod:`web_cache`.

This module exists solely to remove genuine duplication between the two
output-cache modules.  It must not grow into a generic cache base-class —
each cache retains its own directory helper, log module, and metadata shape.
"""
from __future__ import annotations

__all__ = [
    "OUTPUT_FILENAME_RE",
    "OutputStatDict",
    "build_keyed_output_id",
    "build_output_id",
    "evict_cache_dir",
    "find_markdown_boundary",
    "get_cache_dir",
    "list_cache_outputs",
    "load_blob_gz",
    "load_output_meta_stat",
    "load_output_text",
    "load_sidecar_json",
    "path_mtime_key",
    "safe_cache_op",
    "safe_join_output_id",
    "safe_session_fragment",
    "short_content_hash",
    "short_output_id",
    "sidecar_path_for",
    "store_blob",
    "store_blob_gz",
    "truncate_tail_preserve",
    "write_sidecar_metadata",
]

import contextlib
import gzip
import hashlib
import json
import os
import re
import stat as _stat_module
import sys
import time
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING, Any, TypedDict

from .util import get_logger

if TYPE_CHECKING:
    import logging
    from collections.abc import Callable, Generator
    from pathlib import Path

# Filename pattern shared by both the bash-output and web-output caches.
# Components are intentionally kept short so the full path stays well within
# PATH_MAX even when the data directory lives several levels deep (e.g. roaming
# AppData on Windows).
# Format: <session_short>-<timestamp_ms>-<contenthash>.txt
OUTPUT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$")

# Pre-compiled pattern used by safe_session_fragment — module-level so it is
# only compiled once across both callers.
_SESSION_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def get_cache_dir(name: str) -> Path:
    """Return ``data_dir() / name`` and create it on first use.

    Shared implementation of the ``_bash_outputs_dir`` / ``_web_outputs_dir`` /
    ``_skill_outputs_dir`` pattern used in every cache module.  All three called
    either ``paths.ensure_dir(paths.data_dir() / name)`` or inlined the
    equivalent ``mkdir`` — this centralises the one-liner so a future storage
    layout change lands here once.
    """
    from . import paths as _paths
    return _paths.ensure_dir(_paths.data_dir() / name)


@contextmanager
def safe_cache_op(op_name: str, *, log: logging.Logger) -> Generator[None, None, None]:
    """Context manager that catches and logs ``OSError`` from a cache write operation.

    Use inside ``store_output`` and similar functions to replace the boilerplate::

        try:
            # ... write logic ...
            return result
        except OSError as exc:
            _LOG.warning("%s: store failed: %s", log_prefix, exc)
            return None

    with::

        with safe_cache_op("store_output", log=_LOG):
            # ... write logic ...
            return result
        return None  # reached only when the context manager suppresses an OSError

    Parameters
    ----------
    op_name:
        Short descriptive name for the operation (e.g. ``"store_output"``, ``"store"``).
        Included in the warning message so log readers know which step failed.
    log:
        The module-level logger to emit the warning on.

    Notes
    -----
    Only ``OSError`` (and its subclasses) are caught; all other exceptions
    propagate normally.  This matches the contract of the cache modules, where
    I/O failures are expected (full disk, antivirus lock, read-only filesystem)
    but programming errors should still surface.
    """
    try:
        yield
    except OSError as exc:
        log.warning("cache: %s failed: %s", op_name, exc)


def sidecar_path_for(output_path: Path) -> Path:
    """Return the ``.json`` sidecar path for *output_path* (``.txt`` body file).

    Each cache module's ``sidecar_meta_path`` previously duplicated
    ``base.with_suffix(".json")``.  Centralising the one-liner means any future
    change to the sidecar extension or naming convention lands in one place.
    """
    return output_path.with_suffix(".json")


def path_mtime_key(p: Path) -> float:
    """Return the mtime of *p* as a float, or 0.0 on ``OSError``.

    Used as a ``key=`` argument to ``sorted()`` when ordering cache sidecar
    files by recency.  The 0.0 fallback guards against concurrent eviction:
    if a sidecar is deleted between the ``glob()`` and the ``stat()``, the
    sort still completes instead of propagating ``OSError`` into the
    surrounding ``safe_cache_op`` context.

    Previously defined as an identical inner function inside
    ``bash_cache.get_recent_error_outputs``, ``bash_cache.find_cached_for_command``,
    and ``web_cache.find_cached_for_url``.  Centralised here so the pattern
    lives once.
    """
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


class OutputStatDict(TypedDict, total=False):
    """Stat-derived metadata shape shared by all three output-cache modules.

    Every module previously declared its own ``_OutputStatDict`` with identical
    fields; they are consolidated here.  The fields are the same regardless of
    cache (bash, web, or skill): ``output_id`` is always present; ``size_bytes``
    and ``mtime`` come from :func:`os.stat`.
    """

    output_id: str
    size_bytes: int
    mtime: float


def short_content_hash(text: str) -> str:
    """Return the first 16 hex characters of the SHA-256 of *text*.

    Used by all three cache modules to fingerprint a command, URL, or skill
    body for dedup/id purposes.  SHA-256 is overkill for collision resistance
    at this scale (~hundreds of entries per session) but is stdlib, fast, and
    consistent.  16 hex chars give ~64 bits of collision resistance — more than
    enough.

    Encoding errors are replaced rather than raised so the function is safe for
    any string input including binary-tainted command output.
    """
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def build_output_id(session_id: str, content_token: str, ts: float | None = None) -> str:
    """Build the canonical ``{session_short}-{ms:013d}-{content_token}`` output ID.

    Used by :mod:`bash_cache` and :mod:`web_cache` where the content token is
    the hash of the command or URL (via :func:`short_content_hash`).  The
    millisecond timestamp ensures two invocations of the same command/URL in
    the same session do not collide while both remain addressable.

    *skill_cache* uses a different ID shape (``{session_short}-{safe_name}-{sha}``)
    and therefore does not use this helper; it calls :func:`short_content_hash`
    directly.
    """
    safe_session = safe_session_fragment(session_id)
    ms = int((ts if ts is not None else time.time()) * 1000)
    return f"{safe_session}-{ms:013d}-{content_token}"


def build_keyed_output_id(prefix: str, session_id: str, content_token: str) -> str:
    """Build a timestamp-less ``{prefix}{session_short}-{content_token}`` output ID.

    Used by deduplicating caches where two invocations with the same content
    should collide (i.e. overwrite each other) rather than create a new entry.
    The bash glob-result cache uses this with ``prefix="glob_"`` so re-running
    the same ``Glob`` call in a session refreshes the cached result without
    accumulating one entry per call.

    The result is structurally compatible with :data:`OUTPUT_FILENAME_RE` as
    long as the *prefix* and *content_token* contain only ``[A-Za-z0-9_-]``
    characters.  Callers are responsible for ensuring this; the
    :func:`safe_join_output_id` validator on the write path will reject any
    malformed ID.
    """
    safe_session = safe_session_fragment(session_id)
    return f"{prefix}{safe_session}-{content_token}"


def evict_cache_dir(
    *,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
    max_total_bytes: int,
    max_file_count: int = 4096,
    protect_ids: frozenset[str] | None = None,
) -> int:
    """Evict the oldest ``.txt`` entries from a cache directory until the total
    on-disk size is at or under *max_total_bytes* AND the file count is at or
    under *max_file_count*.

    This is the shared implementation of the LRU-eviction algorithm used by
    both :func:`bash_cache.evict_old_entries` and
    :func:`web_cache.evict_old_entries`.  Callers supply the values that
    differ between the two modules; everything else — the scan loop, symlink
    guard, oldest-first sort, body+sidecar pair deletion, and orphan-sidecar
    sweep — is identical and lives here once.

    Parameters
    ----------
    cache_dir_fn:
        Zero-argument callable that returns (and creates if absent) the cache
        directory.  Matches the ``_bash_outputs_dir`` / ``_web_outputs_dir``
        pattern used inside each module.
    log_name:
        Module-qualified prefix for all log messages emitted by this function
        (e.g. ``"bash_cache"`` or ``"web_cache"``).  Each log record looks like
        ``"<log_name>: <message>"``, preserving the per-module context that
        existing log consumers expect.
    max_total_bytes:
        Byte budget for the directory.  Entries are deleted oldest-first until
        the summed size of remaining ``.txt`` files is at or below this value.
    max_file_count:
        File count cap for the directory expressed as the maximum number of
        ``.txt`` body files.  Each body file may have a matching ``.json``
        sidecar, so the physical directory-entry count may be up to
        ``2 * max_file_count``.  Entries are deleted oldest-first until the
        number of ``.txt`` files is at or below this value.  The default of
        4096 prevents unbounded growth when many sub-1 KB entries accumulate —
        Windows NTFS ``iterdir`` on tens of thousands of files adds measurable
        hook cold-start latency (~200–500 ms).
    protect_ids:
        Output ids (the ``<id>`` stem of an ``<id>.txt`` body file) that must
        never be evicted by this call, regardless of mtime.  The just-written
        entry of a ``store_output`` call passes its own id here so a coarse
        Windows ``st_mtime`` tie — which the stable oldest-first sort would
        otherwise break by arbitrary ``iterdir`` order — can never evict the
        freshest entry (MRU protection).  Protected bytes still count toward
        the byte/count caps, so if a protected entry alone exceeds the cap the
        loop stops with it intact (best-effort: an oversized fresh entry is
        kept rather than deleted or looped on forever).

    Returns
    -------
    int
        Number of body (``.txt``) files removed.  Orphaned sidecar-only
        entries swept at the end do not count toward this total — the sweep is
        purely defensive cleanup with no body to remove.

    Safety
    ------
    * Symlinks in the cache directory are skipped (logged at WARNING level) so a
      crafted symlink cannot direct deletes to arbitrary filesystem paths.
    * All I/O errors are swallowed; eviction is opportunistic.  A failure in the
      scan phase returns 0; a failure to delete an individual entry is skipped
      with ``continue`` so the loop keeps trying the next candidate.
    * Sidecar (``.json``) deletion after each body removal is best-effort: a
      failed sidecar unlink is logged at DEBUG and will be cleaned up by the
      next orphan sweep.
    """
    _log = get_logger(log_name)

    try:
        d = cache_dir_fn()
    except OSError:
        return 0

    entries: list[tuple[Path, float, int]] = []
    total = 0
    try:
        for fp in d.iterdir():
            if not fp.name.endswith(".txt"):
                continue
            if not OUTPUT_FILENAME_RE.match(fp.name):
                continue
            try:
                st = os.lstat(fp)
            except OSError:
                continue
            if _stat_module.S_ISLNK(st.st_mode):
                _log.warning("%s: skipping symlink in cache dir: %s", log_name, fp.name)
                continue
            # A gzip-compressed entry keeps its real bytes in a ``<id>.gz``
            # sibling behind a 0-byte ``<id>.txt`` stub; attribute the sibling's
            # size to its owning entry so the byte cap and eviction accounting
            # both see the bytes actually on disk (else the cap is silently
            # defeated and the .gz body never freed).
            entry_size = int(st.st_size) + gz_companion_size(fp)
            entries.append((fp, float(st.st_mtime), entry_size))
            total += entry_size
    except OSError:
        return 0

    # Orphan-sidecar sweep — a sidecar whose body was deleted out-of-band
    # (e.g. a previous eviction whose body unlink succeeded before the sidecar
    # unlink could run, or a manual ``rm cache/*.txt``) would otherwise live
    # forever.  We sweep BEFORE the early-return so orphans are cleaned even
    # when both caps are already satisfied.  Cost: one additional iterdir pass,
    # which is the same order as the scan pass we already paid above.
    #
    # Defensive: only consider .json files whose stem would form a valid cache
    # filename (the .txt sibling that would have to exist).  Without this guard,
    # an unrelated .json file dropped into the cache dir — e.g. a user-managed
    # ``config.json`` or a debugger artifact — would be silently deleted on the
    # next eviction pass.  The cache directory belongs to token-goat but the
    # token-goat philosophy is "fail-soft, never own more than you wrote": we
    # touch only files whose names we would have generated.
    with contextlib.suppress(OSError):
        for sp in d.iterdir():
            # Reap orphaned companions of both kinds: a ``.json`` sidecar or a
            # ``.gz`` compressed body whose owning ``.txt`` stub was deleted
            # out-of-band (a prior eviction whose body unlink ran before the
            # companion unlink could, or a manual ``rm cache/*.txt``).  Without
            # a .txt stub the companion is invisible to the LRU scan above, so
            # it would otherwise live forever.
            if sp.name.endswith(".json"):
                companion_kind = "sidecar"
            elif sp.name.endswith(_GZ_SUFFIX):
                companion_kind = "gz body"
            else:
                continue
            # Validate that the corresponding .txt name would be a cache file
            # we own.  This prevents the sweep from deleting unrelated .json /
            # .gz files that happen to live in the cache dir.
            body_name = sp.stem + ".txt"
            if not OUTPUT_FILENAME_RE.match(body_name):
                continue
            body = sp.with_name(body_name)
            if body.exists():
                continue
            try:
                # missing_ok=True handles the concurrent-delete race: if another
                # process already removed this orphan between the body.exists()
                # check above and this unlink, we treat it as success.
                sp.unlink(missing_ok=True)
            except OSError as exc:
                _log.debug("%s: orphan %s removal failed: %s: %s", log_name, companion_kind, sp.name, exc)

    if total <= max_total_bytes and len(entries) <= max_file_count:
        _log.debug(
            "%s: eviction skipped (within limits): %.1f KB / %.1f KB, %d / %d files",
            log_name,
            total / 1024,
            max_total_bytes / 1024,
            len(entries),
            max_file_count,
        )
        return 0

    entries.sort(key=lambda t: t[1])  # oldest first
    remaining = len(entries)
    removed = 0
    for fp, _mtime, size in entries:
        if total <= max_total_bytes and remaining <= max_file_count:
            break
        # MRU protection: never evict an id the caller just wrote. Coarse
        # Windows st_mtime can tie the fresh entry with older ones; the stable
        # sort then falls back to arbitrary iterdir order, which could place the
        # newest file first and delete it. Skipping it here is deterministic
        # regardless of timestamp granularity. Its bytes still count toward
        # total, so other candidates keep being evicted; if only protected
        # entries remain over cap, the loop exhausts them and stops (best-effort).
        if protect_ids and fp.stem in protect_ids:
            continue
        # Concurrent-eviction safety: two worker processes may both reach this
        # loop with the same set of candidate files.  The first to call unlink()
        # succeeds; the second receives FileNotFoundError (a subclass of OSError).
        # We only adjust accounting (total, remaining, removed) when *our* unlink
        # succeeds so double-counting is impossible.  The `continue` after any
        # OSError skips the sidecar cleanup, which is safe — the first process will
        # handle the sidecar on its own pass, or the orphan sweep will catch it.
        try:
            fp.unlink()
            total -= size
            remaining -= 1
            removed += 1
        except OSError:
            continue
        sidecar = fp.with_suffix(".json")
        try:
            sidecar.unlink()
        except FileNotFoundError:
            pass  # already removed by a concurrent eviction pass — harmless
        except OSError as exc:
            _log.debug("%s: sidecar cleanup failed for %s: %s", log_name, sidecar.name, exc)
        # Free the compressed body too.  Plain (uncompressed) entries have no
        # .gz sibling, so FileNotFoundError here is the common, harmless case.
        gz_sibling = fp.with_name(fp.stem + _GZ_SUFFIX)
        try:
            gz_sibling.unlink()
        except FileNotFoundError:
            pass  # uncompressed entry, or already removed by a concurrent pass
        except OSError as exc:
            _log.debug("%s: gz body cleanup failed for %s: %s", log_name, gz_sibling.name, exc)
    if removed:
        _log.info(
            "%s: evicted %d entries (bytes cap=%d, count cap=%d)",
            log_name, removed, max_total_bytes, max_file_count,
        )

    return removed


def load_sidecar_json(path: Path) -> dict[str, Any] | None:
    """Load and validate a JSON sidecar file, returning a ``dict`` or ``None``.

    Returns ``None`` when the file is absent, unreadable, contains malformed
    JSON, or has a top-level type other than ``dict``.  This covers every
    failure mode that :func:`bash_cache.read_sidecar` and
    :func:`web_cache.read_sidecar` must tolerate; callers keep the
    dataclass-construction step so the two metadata shapes stay independent.
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def write_sidecar_metadata(
    sidecar_path: Path | None,
    meta: Any,
    *,
    log: logging.Logger,
    log_prefix: str,
) -> None:
    """Persist ``meta`` (a dataclass instance) as a JSON sidecar at *sidecar_path*.

    Both bash_cache.write_sidecar and web_cache.write_sidecar previously
    duplicated this exact wrapping: build the path, json-encode the asdict
    payload via the atomic-write helper, and log on OSError. Centralising the
    body keeps the call sites to one line each and ensures any future hardening
    (compression, schema-version stamp, etc.) lands in one place.

    ``log_prefix`` is the human-readable cache name surfaced in the debug log
    (``"bash_cache"`` or ``"web_cache"``) so the merged log stream still tells
    you which cache failed.
    """
    from dataclasses import asdict

    if sidecar_path is None:
        return
    try:
        from . import paths as _paths
        _paths.atomic_write_text(
            sidecar_path,
            json.dumps(asdict(meta), ensure_ascii=False),
        )
    except OSError as exc:
        log.debug(
            "%s: sidecar write failed for %s: %s",
            log_prefix,
            getattr(meta, "output_id", "?"),
            exc,
        )


def find_markdown_boundary(text: str, max_chars: int, *, min_keep: int = 128) -> int:
    """Return the best cut index within *text[:max_chars]* at a markdown boundary.

    Prefers cutting just before a markdown heading (a line starting with ``#``)
    or at a paragraph break (a blank line, i.e. ``\\n\\n``).  Falls back to the
    last plain newline.  If no newline is found within the window, returns
    *max_chars* unchanged so the caller can still hard-cut.

    This helper is used by compact-text truncation in the skill-preservation
    pipeline so that text cut to fit a token budget ends at a coherent point
    (end of a section or paragraph) rather than mid-sentence.  The returned
    index is exclusive — the slice ``text[:result]`` is the coherent prefix.

    The search window is ``text[:max_chars]`` (not the whole string) so the
    function is O(*max_chars*), not O(len(text)).

    *min_keep* sets a lower bound on the returned index.  A boundary found
    before *min_keep* is discarded (too close to the start — it would produce
    a nearly-empty slice) and the next lower-priority strategy is tried.
    Defaults to 128 characters; callers may override it.

    Strategy (in priority order):
    1. Last ``\\n#`` in the window at position >= *min_keep* — cut just before
       the ``#`` so the heading belongs to the *next* slice rather than
       producing an orphaned header.
    2. Last ``\\n\\n`` in the window at position >= *min_keep* — cut after the
       double-newline so the paragraph break is included in the kept prefix.
    3. Last ``\\n`` in the window at position >= *min_keep* — cut after the
       newline.
    4. *max_chars* — hard cut, no useful boundary found within the minimum
       window.

    Examples::

        >>> text = "## Intro\\n\\nSome text.\\n\\n## Section 2\\nMore."
        >>> find_markdown_boundary(text, 30)  # cuts before '## Section 2'
        22
    """
    window = text[:max_chars]

    # Priority 1: last '\n#' whose cut position is at or beyond min_keep.
    # rfind returns the rightmost occurrence; if that falls before min_keep
    # the boundary would produce a nearly-empty kept slice, so skip it.
    heading_pos = window.rfind("\n#")
    if heading_pos >= min_keep:
        # Include the '\n', exclude the '#' so the heading belongs to the
        # next slice and the kept prefix ends cleanly after the blank line.
        return heading_pos + 1

    # Priority 2: last blank line (paragraph break) at a useful position.
    para_pos = window.rfind("\n\n")
    if para_pos >= min_keep:
        return para_pos + 2  # include both '\n' characters in the kept prefix

    # Priority 3: last plain newline at a useful position.
    nl_pos = window.rfind("\n")
    if nl_pos >= min_keep:
        return nl_pos + 1

    # Fallback: hard cut at max_chars.  The caller appends "…" to signal
    # truncation; the mid-sentence cut is unavoidable here.
    return max_chars


def truncate_tail_preserve(
    content: str,
    max_bytes: int,
    *,
    marker_template: str,
) -> tuple[str, bool]:
    """Tail-preserve *content* if its utf-8 byte length exceeds ``max_bytes``.

    Returns ``(stored, was_truncated)``. When the content fits, returns the
    content unchanged and ``False``. When it doesn't, returns the trailing
    portion whose utf-8 byte length is at or under ``max_bytes`` with
    ``marker_template`` (a format string accepting ``{n}`` for the kept byte
    count and ``{total}`` for the original byte count) prepended, and ``True``.

    Both bash_cache and web_cache pages favour the tail because page footers,
    JSON response bodies, error stack traces, and the latest portion of test
    output all tend to live there.

    Implementation note: the slice is computed in bytes, not codepoints, so
    the stored body's byte length is guaranteed to be at or under
    ``max_bytes``.  For ASCII-only content the two are equivalent; for
    multi-byte UTF-8 (CJK, emoji) codepoint slicing would store up to 4×
    ``max_bytes`` on disk, which would silently break the directory byte
    cap.  Slicing on raw bytes then decoding with ``errors="replace"``
    handles split-codepoint boundaries safely — at most one trailing
    replacement character (``\\ufffd``) may appear at the head of the kept
    region.
    """
    encoded = content.encode("utf-8", errors="replace")
    body_bytes = len(encoded)
    if body_bytes <= max_bytes:
        return content, False
    keep_bytes = encoded[-max_bytes:]
    # Advance the slice start to the next valid utf-8 codepoint boundary so a
    # cut mid-codepoint does not produce a leading U+FFFD that re-encodes to 3
    # bytes (which would push us over the cap).  Continuation bytes have the
    # high bits 10xxxxxx (i.e. 0x80..0xBF).  Walking forward at most 3 bytes
    # finds a leading byte or exhausts the slice (worst case empty slice if
    # the entire window is continuations, which cannot happen in valid utf-8
    # of non-trivial length but the guard is cheap).
    skip = 0
    while skip < len(keep_bytes) and (keep_bytes[skip] & 0xC0) == 0x80:
        skip += 1
    if skip:
        keep_bytes = keep_bytes[skip:]
    # Decode the tail.  errors="replace" is retained as a final safety net —
    # the boundary advance above already eliminates the common mid-codepoint
    # case, but malformed input (e.g. lone surrogates from errors="replace"
    # in the encode step) can still trigger replacement during decode.
    keep = keep_bytes.decode("utf-8", errors="replace")
    return marker_template.format(n=max_bytes, total=body_bytes) + keep, True


def safe_session_fragment(session_id: str) -> str:
    """Return a filesystem-safe 16-character prefix of *session_id*.

    Replaces every character that is not alphanumeric, underscore, or hyphen
    with an underscore, then truncates to 16 characters.  Falls back to the
    literal string ``"anon"`` when the result would otherwise be empty (i.e.
    *session_id* is empty or contains only characters that map to underscores
    at the very start before any alphanumeric content appears, then are fully
    stripped by the truncation).

    This fragment is used as the leading component of output-cache filenames
    so that entries can be associated with a session at a glance without
    re-parsing the JSON sidecar.

    Examples::

        safe_session_fragment("abc-123_xyz")   # "abc-123_xyz"
        safe_session_fragment("a" * 64)        # "aaaaaaaaaaaaaaaa"
        safe_session_fragment("!@#$")          # "____"  (or "anon" if truncated to empty)
        safe_session_fragment("")              # "anon"
    """
    return _SESSION_UNSAFE_RE.sub("_", session_id)[:16] or "anon"


# ---------------------------------------------------------------------------
# Shared path / I/O helpers for bash_cache and web_cache
# ---------------------------------------------------------------------------


def safe_join_output_id(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> Path | None:
    """Validate *output_id* and return the corresponding ``<id>.txt`` path.

    Returns ``None`` (with a warning log) when the ID is malformed — for
    example a traversal attempt like ``../etc/passwd`` or an embedded null
    byte.  The on-disk store sits next to other token-goat data; an
    attacker-influenced ID must not be able to walk out of it.

    The returned path may or may not exist on disk; callers that need to
    read an existing file should check ``path.exists()``.  The read path
    (:func:`load_output_text`) adds a suffix-fallback scan for short ids;
    the write path uses this function directly and always writes to the
    full canonical path.

    Parameters
    ----------
    output_id:
        The raw ID string to validate (full id only; suffix resolution is
        handled by :func:`load_output_text`).
    cache_dir_fn:
        Zero-argument callable that returns (and creates if absent) the cache
        directory.  Matches the ``_bash_outputs_dir`` / ``_web_outputs_dir``
        pattern inside each module.
    log_name:
        Module prefix for warning messages (e.g. ``"bash_cache"``).
    """
    if not output_id:
        return None
    _log = get_logger(log_name)
    name = f"{output_id}.txt"
    if not OUTPUT_FILENAME_RE.match(name):
        _log.warning("%s: rejected output_id with invalid chars: %r", log_name, output_id[:200])
        return None
    base = cache_dir_fn().resolve()
    candidate = (base / name).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        _log.warning("%s: rejected output_id escaping base dir: %r", log_name, output_id[:200])
        return None
    # Windows MAX_PATH guard: paths >= 260 chars cause silent OSError failures on
    # systems without the LongPathsEnabled registry key.  The filename component
    # is capped by OUTPUT_FILENAME_RE to 84 chars (80 id + ".txt"), so this guard
    # only fires when the data directory itself is unusually deep (long username,
    # managed profile, OneDrive redirection, etc.).  Returning None is safe: the
    # caller will treat it as a cache miss rather than writing to an unreachable
    # path that silently fails.
    if sys.platform == "win32" and len(str(candidate)) >= 260:
        _log.warning(
            "%s: rejected output_id — resulting path exceeds Windows MAX_PATH (260 chars): "
            "len=%d path=%r",
            log_name, len(str(candidate)), str(candidate)[:260],
        )
        return None
    return candidate


def store_blob(
    output_id: str,
    body: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> Path | None:
    """Validate *output_id*, write *body* atomically, and return the path.

    Returns ``None`` when the ID is malformed (same guard as
    :func:`safe_join_output_id`).  On success returns the ``.txt`` path that
    was written, so callers can derive the sidecar path or log the location.

    This consolidates the three-line pattern that every cache ``store_output``
    function repeats::

        path = safe_join_output_id(out_id, cache_dir_fn, log_name)
        if path is None:
            return None
        paths.atomic_write_text(path, body)

    into a single call.  Any :exc:`OSError` from the write propagates to the
    caller so the surrounding ``try/except OSError`` block in each store
    function still handles it uniformly.
    """
    from . import paths as _paths

    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None:
        return None
    _paths.atomic_write_text(path, body)
    return path


def short_output_id(output_id: str) -> str:
    """Return the display form of *output_id*: ``…<last8>`` (13 chars total).

    Hints and manifests embed this short form so agents can copy-paste the
    suffix into ``token-goat bash-output <suffix>`` or ``web-output <suffix>``.
    The CLI resolves the suffix via :func:`safe_join_output_id`'s suffix fallback.

    For ids shorter than 8 chars the full id is returned unchanged (no ellipsis).
    """
    if len(output_id) <= 8:
        return output_id
    return f"…{output_id[-8:]}"


def load_output_text(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> str | None:
    """Return the cached output body for *output_id*, or ``None`` if absent.

    Shared implementation for :func:`bash_cache.load_output` and
    :func:`web_cache.load_output`.

    Accepts both full ids and trailing 8-char suffixes (as rendered by
    :func:`short_output_id`).  When the exact file is not found, scans the
    cache directory for any file whose stem ends with *output_id*.  If
    exactly one match is found it is loaded; if zero or multiple are found
    ``None`` is returned.
    """
    _log = get_logger(log_name)
    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None:
        return None
    if not path.exists():
        # Suffix fallback: allow short (8-char) ids as rendered in hints.
        base = cache_dir_fn()
        if base.is_dir():
            suffix = output_id.lower()
            matches = [
                p for p in base.iterdir()
                if p.suffix == ".txt"
                and OUTPUT_FILENAME_RE.match(p.name)
                and p.stem.lower().endswith(suffix)
            ]
            if len(matches) == 1:
                path = matches[0]
            elif len(matches) > 1:
                _log.warning(
                    "%s: ambiguous suffix %r matches %d entries; pass a longer id",
                    log_name, output_id[:200], len(matches),
                )
                return None
            else:
                return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _log.warning("%s: load failed for %s: %s", log_name, output_id[:200], exc)
        return None


def load_output_meta_stat(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None.

    Shared implementation for :func:`bash_cache.load_output_meta` and
    :func:`web_cache.load_output_meta`.
    """
    path = safe_join_output_id(output_id, cache_dir_fn, log_name)
    if path is None or not path.exists():
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return OutputStatDict(
        output_id=output_id,
        # True on-disk footprint: the ``.txt`` stub plus its ``.gz`` sibling, if
        # any.  A compressed entry's stub is 0 bytes, so the sibling carries the
        # real size — counting only the stub would report ~0 to ``--list`` and
        # ``doctor`` and to get_output_size's no-sidecar fallback.
        size_bytes=int(st.st_size) + gz_companion_size(path),
        mtime=float(st.st_mtime),
    )


def list_cache_outputs(cache_dir_fn: Callable[[], Path]) -> list[OutputStatDict]:
    """Return metadata for every cached output in *cache_dir_fn()*, newest first.

    Shared implementation for :func:`bash_cache.list_outputs` and
    :func:`web_cache.list_outputs`.  Returns an empty list when the directory
    is missing or unreadable; never raises.
    """
    try:
        d = cache_dir_fn()
    except OSError:
        return []

    results: list[OutputStatDict] = []
    try:
        for fp in d.iterdir():
            if not fp.name.endswith(".txt"):
                continue
            if not OUTPUT_FILENAME_RE.match(fp.name):
                continue
            try:
                st = fp.stat()
            except OSError:
                continue
            results.append(OutputStatDict(
                output_id=fp.stem,
                # On-disk footprint includes the ``.gz`` sibling for compressed
                # entries (whose ``.txt`` stub is 0 bytes); see load_output_meta_stat.
                size_bytes=int(st.st_size) + gz_companion_size(fp),
                mtime=float(st.st_mtime),
            ))
    except OSError:
        return results

    results.sort(key=lambda r: r["mtime"], reverse=True)
    return results


# Default gzip compression level used by both web_cache and skill_cache.  Level 6
# balances speed and ratio well for text content (HTML, JSON, Markdown).
_GZ_SUFFIX: str = ".gz"
_GZ_LEVEL: int = 6


def gz_companion_size(txt_path: Path) -> int:
    """Return the byte size of the ``<id>.gz`` sibling of a ``.txt`` stub, or 0.

    A gzip-compressed cache entry (:func:`store_blob_gz`) keeps its real bytes in
    a ``<id>.gz`` sibling and writes a 0-byte ``<id>.txt`` stub.  Any code that
    reports an entry's on-disk footprint from the ``.txt`` stat alone therefore
    under-reports compressed entries as ~0 bytes.  This helper is the single
    source of truth for the sibling's contribution — used by eviction accounting
    (so the byte cap counts the bytes actually on disk) and by the metadata /
    listing functions (so ``--list`` and ``doctor`` show the true footprint).

    Never raises: a missing sibling (the common, uncompressed case) or any stat
    failure returns 0.  Symlinks are ignored to match the eviction path's
    refusal to follow links inside the cache directory.
    """
    try:
        gz_st = os.lstat(txt_path.with_name(txt_path.stem + _GZ_SUFFIX))
    except OSError:
        return 0
    if _stat_module.S_ISLNK(gz_st.st_mode):
        return 0
    return int(gz_st.st_size)


def store_blob_gz(
    output_id: str,
    text: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> Path | None:
    """Write *text* gzip-compressed to the cache directory identified by *cache_dir_fn*.

    Writes the compressed body as ``output_id.gz`` AND an empty ``output_id.txt``
    stub file.  The stub ensures the entry is discoverable by :func:`list_outputs`
    and subject to the normal LRU eviction machinery (which scans for ``.txt``
    files).  :func:`load_blob_gz` checks for the ``.gz`` sibling first so callers
    transparently receive the decompressed text.

    Returns the ``.gz`` path on success, or ``None`` on I/O error.

    This is the shared implementation used by both :mod:`web_cache` and
    :mod:`skill_cache`; callers differ only in which directory function they pass.
    """
    from . import paths as _paths

    _log = get_logger(log_name)
    with safe_cache_op("store_blob_gz", log=_log):
        out_dir = cache_dir_fn()
        gz_path = out_dir / (output_id + _GZ_SUFFIX)
        try:
            raw_bytes = text.encode("utf-8", errors="replace")
            compressed = gzip.compress(raw_bytes, compresslevel=_GZ_LEVEL)
            _paths.atomic_write_bytes(gz_path, compressed)
            _log.debug(
                "store_blob_gz: wrote %s (%d bytes raw -> %d compressed)",
                gz_path.name, len(raw_bytes), len(compressed),
            )
        except OSError as exc:
            _log.debug("store_blob_gz: failed to write %s: %s", output_id, exc)
            return None

        # Write an empty .txt stub so list_outputs() / evict_old_entries() can
        # discover and manage this entry through the standard cache machinery.
        stub_result = store_blob(output_id, "", cache_dir_fn, log_name)
        if stub_result is None:
            _log.debug("store_blob_gz: stub write failed for %s", output_id)
            # Clean up the gz file so we don't leave an orphaned compressed file.
            with suppress(OSError):
                gz_path.unlink()
            return None

        return gz_path
    return None  # safe_cache_op suppressed an exception


def load_blob_gz(
    output_id: str,
    cache_dir_fn: Callable[[], Path],
    log_name: str,
) -> str | None:
    """Return the decompressed text for a gzip-compressed cache entry, or ``None``.

    Checks for ``output_id.gz`` in the directory returned by *cache_dir_fn*.
    Returns ``None`` when no ``.gz`` file exists so the caller can fall back to
    plain-text loading.

    This is the shared implementation used by both :mod:`web_cache` and
    :mod:`skill_cache`; callers differ only in which directory function they pass.
    """
    _log = get_logger(log_name)
    out_dir = cache_dir_fn()
    gz_path = out_dir / (output_id + _GZ_SUFFIX)
    if not gz_path.is_file():
        return None
    try:
        with gzip.open(gz_path, "rb") as fh:
            return fh.read().decode("utf-8", errors="replace")
    except (OSError, gzip.BadGzipFile) as exc:
        _log.debug("load_blob_gz: failed to decompress %s: %s", gz_path.name, exc)
        return None
