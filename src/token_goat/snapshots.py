"""Per-session content snapshots used for diff-aware re-read hints.

When a file is read inside a Claude session, ``post_read`` captures a copy of
its contents under ``data_dir() / "session_snapshots" / "<session_short>"``.
If the agent later edits the file and tries to re-read it, the pre-read hook
computes a unified diff against the stored snapshot and offers the agent the
diff as ``additionalContext`` so it can decide whether the full re-read is
still warranted.

Design notes
------------
* Snapshots are scoped to a single session.  We do not share snapshots across
  sessions because each session has its own context window and a "you already
  read this" claim only makes sense within the same conversation.

* Snapshots live on disk (not in the session JSON) so a single 200 KB file
  does not push the session cache to half a megabyte on every read.

* Snapshot filenames are derived from the SHA of the file path so the on-disk
  layout is flat and a long file path never blows out PATH_MAX.

* Files larger than :data:`MAX_SNAPSHOT_BYTES` are not snapshotted.  The diff
  would be too large to inject as a hint anyway, and the snapshot store is
  bounded by per-session total size + per-file size caps.

* Snapshots are best-effort: any I/O error is logged and swallowed.  A missing
  snapshot simply means the pre-read hook falls back to its existing behaviour
  (suppress the hint when the file has been edited since last read).

Concurrency
-----------
Snapshots are written via :func:`paths.atomic_write_bytes` so a concurrent
reader sees either the old complete file or the new complete file — never a
partial write.  We rely on the same write-and-rename invariant the session
cache uses; no additional locking is needed because the unique-per-(session,
path) filenames mean two hooks cannot legitimately race on the same key.
"""
from __future__ import annotations

__all__ = [
    "MAX_SNAPSHOTS_PER_SESSION",
    "MAX_SNAPSHOT_BYTES",
    "SNAPSHOT_TRUNCATE_BYTES",
    "SnapshotResult",
    "cleanup_session",
    "load",
    "load_kind",
    "snapshot_path",
    "store",
    "symbol_changed_since_read",
]

import contextlib
import hashlib
import os
import re
import stat as _stat_module
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from . import paths
from .cache_common import safe_cache_op
from .hooks_common import sanitize_log_str
from .util import get_logger, safe_stat_size

if TYPE_CHECKING:
    from pathlib import Path

_LOG = get_logger("snapshots")

# Recognised snapshot origin kinds.  Stored as a tiny sidecar next to the
# binary snapshot so the diff-hint path can distinguish a normal post-read
# capture (``read``) from one written speculatively by the predictive
# prefetch path (``predictive``).  The default is ``read`` because the vast
# majority of snapshots originate from post-read.
_KIND_READ: str = "read"
_KIND_PREDICTIVE: str = "predictive"
_VALID_KINDS: frozenset[str] = frozenset({_KIND_READ, _KIND_PREDICTIVE})

# Largest file size eligible for snapshotting.  Beyond this the diff itself
# would not fit comfortably in a hint, so we save nothing rather than store
# bytes we will never use.  256 KB covers nearly every source file (a 10K LoC
# file averages ~300 KB at 30 chars/line).
MAX_SNAPSHOT_BYTES: int = 256 * 1024

# Truncation threshold.  Files larger than this are stored truncated to this
# many bytes (with a ``<truncated at NNN bytes>`` marker appended) rather than
# skipped entirely.  This lets diff hints fire for the first 50 KB of large
# files — the portion where most edits concentrate — without storing the full
# 200–256 KB in the snapshot dir.  Files larger than MAX_SNAPSHOT_BYTES still
# skip as before; only files in the range (SNAPSHOT_TRUNCATE_BYTES,
# MAX_SNAPSHOT_BYTES] are affected.
SNAPSHOT_TRUNCATE_BYTES: int = 50 * 1024

# Sentinel appended to truncated snapshots so the diff hint and
# symbol_changed_since_read can recognise that the stored bytes are partial.
_TRUNCATED_MARKER: bytes = b"\n<snapshot truncated at %d bytes>\n"

# Per-session ceiling on snapshot count.  Above this the oldest snapshot is
# evicted when a new one is taken.  150 covers any realistic session — even
# a long refactor rarely reads 150 distinct files.
MAX_SNAPSHOTS_PER_SESSION: int = 150

# Used to scrub session_id before embedding it in a directory name.  The
# session module already validates session_id against a stricter regex, but
# we apply a second pass here so this module is safe to call even when a
# caller bypassed validation.
_SESSION_DIR_RE = re.compile(r"[^a-zA-Z0-9_\-]")


@dataclass
class SnapshotResult:
    """Outcome of :func:`store` — what was written and where.

    A non-None ``path`` indicates the snapshot exists on disk and can be
    loaded later via :func:`load`.  ``content_sha`` is the SHA-256 hex digest
    of the stored bytes, used by the pre-read hint logic to short-circuit when
    the on-disk file's SHA hasn't changed since the snapshot.
    """

    path: Path
    content_sha: str
    size_bytes: int


def _session_dir(session_id: str) -> Path | None:
    """Resolve the snapshots directory for *session_id*, or None on invalid input."""
    if not session_id:
        return None
    safe = _SESSION_DIR_RE.sub("_", session_id)[:64] or "anon"
    base = (paths.data_dir() / "session_snapshots").resolve()
    candidate = (base / safe).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        _LOG.warning("snapshots: session_dir escaped base for %r", sanitize_log_str(session_id))
        return None
    return candidate


def _path_key(file_path: str) -> str:
    """Return the on-disk filename component for *file_path*.

    Hashes the absolute or relative path so a long real path becomes a short
    stable filename.  Truncated to 32 hex chars — ~128 bits of collision
    resistance, more than enough for a per-session set of at most ~150 entries.
    """
    return hashlib.sha256(file_path.encode("utf-8", errors="replace")).hexdigest()[:32]


def snapshot_path(session_id: str, file_path: str) -> Path | None:
    """Return the snapshot file path for ``(session_id, file_path)``, or None.

    Always returns a path even when the snapshot does not yet exist.  Callers
    can use :meth:`Path.exists` to distinguish.
    """
    d = _session_dir(session_id)
    if d is None:
        return None
    return d / f"{_path_key(file_path)}.bin"


def _kind_sidecar_path(snapshot_p: Path) -> Path:
    """Return the sidecar path that holds the snapshot's origin kind.

    The sidecar is a 1-line text file next to ``snapshot_p`` that records why
    the snapshot was written (``read`` vs ``predictive``).  Kept as a separate
    file rather than embedded in the snapshot bytes so the snapshot itself
    stays a pristine copy of the source file — the diff machinery compares
    bytes directly and any in-band header would break that contract.
    """
    return snapshot_p.with_suffix(snapshot_p.suffix + ".kind")


def _read_snapshot_kind(sidecar_path: Path) -> str | None:
    """Read and validate the snapshot kind from a sidecar file.

    Returns one of the values in :data:`_VALID_KINDS`, or ``None`` when the
    sidecar does not exist, cannot be read, or contains an invalid kind.
    Never raises — any I/O error returns ``None`` so callers are not blocked.
    """
    if not sidecar_path.exists():
        return None
    try:
        with sidecar_path.open("rb") as fh:
            raw = fh.read(32)
    except OSError:
        return None
    try:
        text = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        return None
    return text if text in _VALID_KINDS else None


def _write_snapshot_kind(sidecar_path: Path, kind: str, file_path_for_log: str) -> bool:
    """Write the snapshot kind to a sidecar file atomically.

    Returns True on success, False on I/O error. Logs at debug level on failure;
    the snapshot itself remains valid even if the sidecar write fails (degrades
    gracefully to unknown kind).
    """
    safe_kind = kind if kind in _VALID_KINDS else _KIND_READ
    try:
        paths.atomic_write_bytes(sidecar_path, safe_kind.encode("ascii"))
        return True
    except OSError as exc:
        _LOG.debug(
            "snapshots: kind sidecar write failed for %s: %s",
            sanitize_log_str(file_path_for_log), exc,
        )
        return False


def _evict_oldest(d: Path, max_count: int) -> int:
    """Drop the oldest snapshots in *d* until at most *max_count* remain.

    Returns the number of ``.bin`` snapshots removed (sidecar ``.kind`` files
    are evicted alongside their owning ``.bin`` but do not count toward the
    return value).  The cap applies to snapshots only — sidecars are
    bookkeeping and must not pre-trigger eviction.  Silently ignores I/O
    errors so a transient permission glitch does not abort the snapshot write
    the caller is about to attempt.
    """
    try:
        entries = [
            (p, p.stat().st_mtime)
            for p in d.iterdir()
            if p.is_file() and not p.is_symlink() and p.suffix == ".bin"
        ]
    except OSError:
        return 0
    if len(entries) <= max_count:
        return 0
    entries.sort(key=lambda t: t[1])
    removed = 0
    over = len(entries) - max_count
    for p, _mtime in entries[:over]:
        try:
            p.unlink()
            removed += 1
        except OSError:
            continue
        # Best-effort sidecar removal: an orphan .kind is harmless (load_kind
        # returns None when the .bin is gone via snapshot_path) but cleaning it
        # up keeps the on-disk dir from growing without bound under heavy
        # eviction churn.
        with contextlib.suppress(OSError):
            _kind_sidecar_path(p).unlink()
    if removed:
        _LOG.debug("snapshots: evicted %d entries from %s (cap=%d)", removed, d.name, max_count)
    return removed


def store(
    session_id: str,
    file_path: str,
    content: bytes,
    *,
    kind: str = _KIND_READ,
) -> SnapshotResult | None:
    """Persist *content* as the current snapshot for ``(session_id, file_path)``.

    Returns ``None`` (and logs at debug) when the file is too large, the
    session dir cannot be created, or any I/O error occurs.  Otherwise returns
    a :class:`SnapshotResult` describing the stored snapshot.

    Snapshots are stored verbatim — no compression — because they are short
    (≤256 KB) and we read them back exactly once per re-read attempt.  The
    write is atomic via rename-over so a concurrent reader never observes a
    partial file.

    The *kind* tag identifies why the snapshot was written:

    * ``"read"`` (default) — captured by ``post_read`` after the agent read
      the file.  Used by the diff hint to render edits-since-read.
    * ``"predictive"`` — captured speculatively by ``post_edit`` for an
      adjacent module the agent is likely to read next.  When the diff hint
      later fires against this snapshot, it counts as a *predictive prefetch
      hit* and is recorded under a distinct stat kind so the value of the
      prefetch path can be measured.

    Any unrecognised kind falls back to ``"read"`` so the on-disk format
    cannot be poisoned by a future caller passing an arbitrary string.
    """
    orig_len = len(content)
    if orig_len > MAX_SNAPSHOT_BYTES:
        _LOG.debug(
            "snapshots: skipping oversized file (%d bytes > %d cap): %s",
            orig_len, MAX_SNAPSHOT_BYTES, sanitize_log_str(file_path),
        )
        return None
    # Truncation: files larger than SNAPSHOT_TRUNCATE_BYTES but still within
    # MAX_SNAPSHOT_BYTES are stored truncated so the snapshot dir does not
    # accumulate very large files for every big source file read this session.
    # The truncated snapshot is sufficient for the diff-hint path: most edits
    # concentrate at the top of a file and the first 50 KB covers the majority
    # of them.  A sentinel line is appended so callers can detect truncation.
    #
    # Note on SHA semantics: the SHA stored in SnapshotResult (and later in the
    # session cache) is the SHA of the *stored* (truncated) bytes, not of the
    # original file.  The unchanged-file hint path (build_unchanged_file_hint)
    # reads the current file and truncates to SNAPSHOT_TRUNCATE_BYTES before
    # comparing, so the semantics stay consistent: "unchanged" means the first
    # SNAPSHOT_TRUNCATE_BYTES of the file have not changed, which is the
    # relevant invariant for a truncated snapshot anyway.
    if orig_len > SNAPSHOT_TRUNCATE_BYTES:
        marker = _TRUNCATED_MARKER % orig_len
        content = content[:SNAPSHOT_TRUNCATE_BYTES] + marker
        _LOG.debug(
            "snapshots: truncating %d-byte file to %d bytes (threshold=%d): %s",
            orig_len, len(content), SNAPSHOT_TRUNCATE_BYTES,
            sanitize_log_str(file_path),
        )
    p = snapshot_path(session_id, file_path)
    if p is None:
        return None
    sha = hashlib.sha256(content).hexdigest()

    # Content-hash dedup: skip the disk write when the existing snapshot is
    # byte-for-byte identical.  Common when a file is re-read without edits
    # between reads — this avoids writing 256 KB of unchanged bytes on every
    # subsequent read of a large file, which also keeps the session snapshot
    # directory mtime stable so stale-cleanup does not evict live snapshots.
    if p.exists():
        with contextlib.suppress(OSError):
            if p.read_bytes() == content:
                _LOG.debug(
                    "snapshots: content unchanged, skipping write for %s",
                    sanitize_log_str(file_path),
                )
                return SnapshotResult(path=p, content_sha=sha, size_bytes=len(content))

    with safe_cache_op(f"store:{sanitize_log_str(file_path)}", log=_LOG):
        paths.ensure_dir(p.parent)
        _evict_oldest(p.parent, MAX_SNAPSHOTS_PER_SESSION - 1)
        paths.atomic_write_bytes(p, content)
        # Sidecar write is best-effort: if it fails the snapshot itself is
        # still valid, the diff hint just won't recognise this as a
        # predictive hit (degrades gracefully to the original behaviour).
        sidecar = _kind_sidecar_path(p)
        _write_snapshot_kind(sidecar, kind, file_path)
        return SnapshotResult(path=p, content_sha=sha, size_bytes=len(content))
    return None


def load_kind(session_id: str, file_path: str) -> str | None:
    """Return the recorded kind for the snapshot of ``(session_id, file_path)``.

    Returns one of the values in :data:`_VALID_KINDS`, or ``None`` when no
    sidecar exists (either the snapshot pre-dates the kind tag, the sidecar
    write failed, or no snapshot is present at all).  Treat ``None`` as
    "unknown / legacy snapshot" and fall back to the default behaviour.

    Never raises — any I/O error returns ``None`` so callers on the hot hint
    path are not impacted by a transient permission glitch.
    """
    p = snapshot_path(session_id, file_path)
    if p is None:
        return None
    sidecar = _kind_sidecar_path(p)
    return _read_snapshot_kind(sidecar)


def load(
    session_id: str,
    file_path: str,
    *,
    expected_sha: str | None = None,
) -> bytes | None:
    """Return the snapshot bytes for ``(session_id, file_path)``, or ``None``.

    Returns ``None`` when the snapshot is absent, unreadable, or too large to
    safely return (defensive: a snapshot that has somehow grown past
    :data:`MAX_SNAPSHOT_BYTES` between write and load is treated as missing).

    Integrity check
    ~~~~~~~~~~~~~~~
    When *expected_sha* is provided, the loaded bytes are hashed and the digest
    is compared to the caller's expected SHA-256 hex digest.  On mismatch the
    snapshot is treated as untrusted and ``None`` is returned (with a warning
    log) — diff-aware re-read consumers pass the SHA recorded at store time so
    a snapshot that has been corrupted, partially-written, or evicted-and-
    rewritten under the same filename hash cannot drive a misleading hint.
    Comparison is case-insensitive on the hex digest.

    A ``None`` *expected_sha* skips the integrity check (legacy callers retain
    the unconditional behaviour).
    """
    p = snapshot_path(session_id, file_path)
    if p is None or not p.exists():
        return None
    size = safe_stat_size(p)
    if size is None:
        return None
    if size > MAX_SNAPSHOT_BYTES:
        _LOG.warning(
            "snapshots: refusing to load oversized snapshot (%d bytes): %s",
            size, sanitize_log_str(file_path),
        )
        return None
    try:
        data = p.read_bytes()
    except OSError as exc:
        _LOG.warning(
            "snapshots: load failed for %s: %s",
            sanitize_log_str(file_path), exc,
        )
        return None
    if expected_sha is not None:
        actual_sha = hashlib.sha256(data).hexdigest()
        if actual_sha.lower() != expected_sha.lower():
            _LOG.warning(
                "snapshots: integrity mismatch for %s "
                "(expected sha[:8]=%s, got sha[:8]=%s, size=%d) — discarding",
                sanitize_log_str(file_path),
                expected_sha[:8] if expected_sha else "",
                actual_sha[:8],
                size,
            )
            return None
    return data


def cleanup_session(session_id: str) -> int:
    """Remove every snapshot for *session_id*.  Returns the count removed.

    Called when a session is reset (``/clear`` or compact).  Silently ignores
    missing directories.  Refuses to follow symlinks: a planted symlink in the
    snapshot directory must not be able to redirect unlink calls.
    """
    d = _session_dir(session_id)
    if d is None or not d.exists():
        return 0
    removed = 0  # count of .bin snapshots removed (sidecars excluded)
    try:
        for fp in d.iterdir():
            try:
                st = os.lstat(fp)
            except OSError:
                continue
            if _stat_module.S_ISLNK(st.st_mode):
                _LOG.warning("snapshots: skipping symlink in cleanup: %s", fp.name)
                continue
            # Sidecar .kind files are bookkeeping — they get unlinked alongside
            # the .bin but are not user-visible snapshots, so they do not bump
            # the returned count.  Callers (and existing tests) expect the
            # return value to track snapshots, not on-disk file pairs.
            is_snapshot = fp.suffix == ".bin"
            try:
                fp.unlink()
                if is_snapshot:
                    removed += 1
            except OSError:
                continue
    except OSError:
        return removed
    with contextlib.suppress(OSError):
        d.rmdir()  # only succeeds when empty; ignore otherwise
    _LOG.debug("snapshots: cleanup_session %s removed=%d", sanitize_log_str(session_id), removed)
    return removed


def symbol_changed_since_read(
    session_id: str,
    file_path: str,
    symbol_name: str,
    current_start_line: int,
    current_end_line: int,
    current_text: str,
) -> bool:
    """Return True when *symbol_name* in *file_path* differs from what the session last read.

    Compares the symbol's body as it currently appears (``current_text``,
    extracted from ``current_start_line``..``current_end_line`` of the live
    file) against the same line range in the stored snapshot.

    Returns False (no warning) when:

    * no snapshot exists for this ``(session_id, file_path)`` pair — the agent
      has not read the file this session, so there is nothing to compare
    * the snapshot and current text are identical (symbol is unchanged)
    * any I/O error occurs — fail-soft, never block the caller

    Returns True only when a snapshot exists AND the symbol body extracted
    from it differs from ``current_text``.
    """
    if not session_id or not file_path or not symbol_name:
        return False
    # Use the integrity-gated load path when a snapshot SHA has been recorded
    # for this session + file pair.  This prevents a corrupted or tampered
    # snapshot from driving a misleading "symbol changed" warning.  Fall back to
    # the unverified load for legacy snapshots that pre-date SHA recording.
    try:
        from . import session as _session
        expected_sha = _session.get_snapshot_sha(session_id, file_path)
    except Exception:
        expected_sha = None
    snapshot_bytes = load(session_id, file_path, expected_sha=expected_sha)
    if snapshot_bytes is None:
        return False
    try:
        snapshot_text = snapshot_bytes.decode("utf-8", errors="replace")
        snapshot_lines = snapshot_text.splitlines(keepends=True)
        # Extract the same line range from the snapshot.  current_start_line and
        # current_end_line are 1-based inclusive positions from the DB.  The
        # symbol's line numbers reflect the current file; if lines were inserted
        # before the symbol they will be offset in the snapshot.  We use a
        # content-search fallback: if the exact line slice matches, we short-
        # circuit as unchanged; if not, we search for the current body verbatim
        # to distinguish "lines moved" from "content actually changed".
        n_lines = current_end_line - current_start_line + 1
        snap_start = max(0, current_start_line - 1)
        snap_end = snap_start + n_lines
        snapshot_slice = "".join(snapshot_lines[snap_start:snap_end]).rstrip("\n")
        current_stripped = current_text.rstrip("\n")
        if snapshot_slice == current_stripped:
            return False
        # Line-offset check: the body may have moved without changing.  Search for
        # the current text as a literal substring of the snapshot to handle the
        # common case of lines inserted/removed *before* the symbol.
        # Return True only when the body is absent from the snapshot — it changed.
        return not (current_stripped and current_stripped in snapshot_text)
    except Exception:
        _LOG.debug(
            "symbol_changed_since_read: comparison failed for %s::%s",
            sanitize_log_str(file_path), sanitize_log_str(symbol_name),
        )
        return False


def cleanup_stale(max_age_hours: float = 24.0) -> int:
    """Drop snapshots whose mtime is older than *max_age_hours*.

    Run periodically by the background worker.  Stale snapshots are noise
    after their session ends; without this sweep the snapshot store would
    grow without bound across long-lived installations.
    """
    base = paths.data_dir() / "session_snapshots"
    if not base.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    removed = 0  # count of .bin snapshots removed (sidecars excluded)
    try:
        for session_dir in base.iterdir():
            if not session_dir.is_dir() or session_dir.is_symlink():
                continue
            try:
                for fp in session_dir.iterdir():
                    try:
                        st = os.lstat(fp)
                    except OSError:
                        continue
                    if _stat_module.S_ISLNK(st.st_mode):
                        continue
                    if st.st_mtime < cutoff:
                        is_snapshot = fp.suffix == ".bin"
                        try:
                            fp.unlink()
                            if is_snapshot:
                                removed += 1
                        except OSError:
                            continue
            except OSError:
                continue
            # Clean up empty session dirs as we go.
            with contextlib.suppress(OSError):
                session_dir.rmdir()
    except OSError:
        return removed
    if removed:
        _LOG.info("snapshots: cleanup_stale removed=%d (max_age_hours=%.1f)", removed, max_age_hours)
    return removed
