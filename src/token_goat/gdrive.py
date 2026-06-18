"""Google Drive image fetcher: downloads + shrinks + caches."""
from __future__ import annotations

__all__ = [
    "TEXT_EXTENSIONS",
    "GDriveCredsUnavailable",
    "extract_section_index",
    "fetch_file",
    "get_credentials",
    "is_text_path",
    "list_drive_files",
    "run_oauth_oob_flow",
]

import contextlib
import io
import os
import re
import sys
import time
from typing import TYPE_CHECKING, Protocol

from . import image_shrink, paths
from .hooks_common import sanitize_log_str
from .util import get_logger

if TYPE_CHECKING:
    from pathlib import Path

_LOG = get_logger("gdrive")


class _GoogleCredentials(Protocol):
    """Structural interface for a google-auth credentials object.

    Declares only the attributes and methods that token-goat's gdrive helpers
    actually access.  Using a Protocol (rather than ``object``) lets mypy verify
    that callers of :func:`get_credentials` receive something with the expected
    shape, without pulling in the optional ``google-auth`` stubs package as a
    hard dependency.
    """

    expired: bool
    refresh_token: str | None

    def refresh(self, request: object) -> None: ...
    def to_json(self) -> str: ...

_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# OAuth error messages that indicate the refresh token is permanently invalid
# (revoked or expired grant), as opposed to a transient network failure.
_PERMANENT_OAUTH_ERROR_KEYWORDS = (
    "invalid_grant",
    "token has been expired",
    "token has been revoked",
    "unauthorized_client",
)


def _write_creds_secure(path: Path, content: str) -> None:
    """Write OAuth credential JSON to *path* with owner-only permissions (0o600).

    On POSIX systems this prevents other local users from reading refresh tokens.
    On Windows, ``os.chmod`` has no meaningful effect (NTFS ACLs control access),
    so we delegate to ``paths.atomic_write_text`` which uses the user-profile
    location for isolation.

    Uses an atomic write-then-rename pattern so a partial write never leaves a
    truncated credential file behind.  The temp file name includes thread ID and
    monotonic_ns (same scheme as ``paths.atomic_write_text``) to prevent a
    predictable-name symlink attack on systems where multiple users share a
    ``/tmp``-style parent directory.
    """
    import threading
    import time

    paths.ensure_dir(path.parent)
    if sys.platform != "win32":
        # Write via a low-level fd opened with restrictive mode so the file is
        # never world-readable, even briefly before a post-write chmod.
        # Unique temp name prevents a predictable-path symlink attack.
        tmp = path.with_name(
            f"{path.name}.{threading.get_ident()}.{time.monotonic_ns()}.tmp"
        )
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
        except OSError:
            tmp.unlink(missing_ok=True)
            raise
        tmp.replace(path)
        # Ensure mode on the destination (replace may inherit umask on some FSes)
        with contextlib.suppress(OSError):
            os.chmod(path, 0o600)
    else:
        paths.atomic_write_text(path, content)


class GDriveCredsUnavailable(Exception):
    """Raised when Google Drive credentials cannot be obtained via any method.

    Attempts multiple fallback paths in order: Application Default Credentials (ADC)
    via gcloud auth, stored OAuth tokens, and browser-based OAuth flow. If all fail,
    this exception is raised, indicating that Google Drive integration is unavailable
    for this session.
    """


def _try_adc() -> _GoogleCredentials | None:
    """Try Google Application Default Credentials (gcloud auth application-default login)."""
    try:
        import google.auth

        creds, _project = google.auth.default(scopes=_DRIVE_SCOPES)
        return creds  # type: ignore[return-value]  # google.auth returns untyped object
    except Exception as e:
        _LOG.info("ADC unavailable: %s", e)
        return None


def _try_stored_oauth() -> _GoogleCredentials | None:
    """Try cached OAuth tokens from a previous token-goat gdrive-auth run.

    On a permanent credential failure (revoked token / invalid grant), the stale
    creds file is deleted so the next call falls through to the OAuth flow rather
    than silently failing on every request until the user manually removes the file.
    """
    creds_path = paths.gdrive_creds_path()
    if not creds_path.exists():
        return None
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds: _GoogleCredentials = Credentials.from_authorized_user_file(str(creds_path), scopes=_DRIVE_SCOPES)  # type: ignore[assignment]  # google-auth stubs declare classmethod return type as Self; our alias _GoogleCredentials is the same class
        if creds.expired and creds.refresh_token:
            t_refresh = time.monotonic()
            try:
                creds.refresh(Request())
            except Exception as refresh_err:
                # Distinguish permanent failures (revoked/invalid grant) from
                # transient network errors so we only delete stale creds when
                # the server definitively rejects them.
                refresh_err_lower = str(refresh_err).lower()
                if any(kw in refresh_err_lower for kw in _PERMANENT_OAUTH_ERROR_KEYWORDS):
                    _LOG.warning(
                        "OAuth refresh token permanently invalid (revoked or expired grant); "
                        "removing stale credentials so re-auth is triggered"
                    )
                    try:
                        creds_path.unlink(missing_ok=True)
                    except OSError as unlink_err:
                        _LOG.debug("could not remove stale creds file: %s", unlink_err)
                else:
                    # Transient error (network timeout, DNS failure, etc.) — keep creds
                    _LOG.warning(
                        "OAuth token refresh failed after %.3fs (transient); keeping cached creds",
                        time.monotonic() - t_refresh,
                    )
                return None
            # Do NOT log creds.to_json() — it contains refresh tokens
            _write_creds_secure(creds_path, creds.to_json())
            _LOG.info("OAuth credentials refreshed in %.3fs", time.monotonic() - t_refresh)
        return creds
    except Exception as exc:
        # Do NOT log exc directly — the message may contain credential material.
        # Log the exception type so the failure mode is diagnosable without leaking secrets.
        _LOG.warning("stored OAuth invalid or refresh failed (%s)", type(exc).__name__)
        return None


def get_credentials() -> _GoogleCredentials:
    """Try ADC then stored OAuth. Raise GDriveCredsUnavailable if neither works."""
    creds = _try_adc()
    if creds is not None:
        _LOG.debug("using Application Default Credentials (ADC) for Drive access")
        return creds
    creds = _try_stored_oauth()
    if creds is not None:
        _LOG.debug("using stored OAuth credentials for Drive access")
        return creds
    creds_path = paths.gdrive_creds_path()
    raise GDriveCredsUnavailable(
        "No Google Drive credentials available. To authenticate, run:\n"
        "  token-goat gdrive-auth\n"
        f"This stores OAuth tokens at: {creds_path}\n"
        "Alternatively, use Application Default Credentials:\n"
        "  gcloud auth application-default login"
    )


def _validate_file_id(file_id: str) -> None:
    """Validate file_id to prevent path traversal attacks.

    Google Drive file IDs are base64url without padding, ~25-40 chars.
    Reject anything that looks like a path or is otherwise malformed.
    """
    if not isinstance(file_id, str) or not file_id.strip():
        raise ValueError("file_id cannot be empty or whitespace-only")
    stripped = file_id.strip()
    if len(stripped) > 128:
        raise ValueError(f"file_id too long (max 128 chars): {len(stripped)}")
    # Reject path-like patterns
    if "/" in stripped or "\\" in stripped or ".." in stripped:
        raise ValueError(f"file_id contains invalid characters: {stripped!r}")
    # Allow alphanumeric, hyphen, underscore (base64url alphabet)
    if not all(c.isalnum() or c in "-_" for c in stripped):
        raise ValueError(f"file_id contains invalid characters: {stripped!r}")


_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB — same order of magnitude as webfetch cap

# Drive API can return arbitrary mimeType strings from user-controlled metadata.
# Allow only the characters that appear in legitimate MIME types (RFC 2045 token +
# slash + optional parameter suffix) so a crafted type cannot be used to inject
# unexpected values into googleapiclient calls.
_MIME_TYPE_RE = re.compile(r'^[A-Za-z0-9!#$&\-^_.+]+/[A-Za-z0-9!#$&\-^_.+]+(?:;[^\x00-\x1f\x7f]*)?$')
_MAX_MIME_TYPE_LEN = 256

# Maximum characters kept in a sanitised local filename derived from the Drive
# file's display name.  Long names can exceed filesystem path limits; 200 chars
# gives ample readability headroom while staying well under the 255-byte limit
# common to most filesystems.
_MAX_SAFE_FILENAME_CHARS = 200


def _build_local_cache_path(file_id: str, name: str, cache_dir: Path) -> Path:
    """Derive a safe, cache-dir-bounded local path for a Drive file.

    Strips path separators and control characters from the Drive display name,
    truncates to filesystem-safe length, and verifies the resulting path does
    not escape the cache directory.
    """
    # Allow only alphanumeric, dot, hyphen, underscore — everything else is stripped.
    safe_name = "".join(c for c in name if c.isalnum() or c in "._-")
    if not safe_name:
        safe_name = file_id
    safe_name = safe_name[:_MAX_SAFE_FILENAME_CHARS]
    local_path = cache_dir / f"{file_id}_{safe_name}"
    try:
        local_path.resolve().relative_to(cache_dir.resolve())
    except ValueError:
        raise RuntimeError(f"Computed path escapes cache directory: {local_path}") from None
    return local_path


def _validate_mime_type(mime: str, file_id: str) -> str:
    """Validate and return a Drive API mimeType value.

    The Drive API returns ``mimeType`` from user-controlled file metadata, so a
    compromised or crafted response could contain an unexpected string.  We
    accept only values that match the RFC 2045 token grammar (type/subtype with
    optional parameters limited to printable ASCII) and are within a reasonable
    length.  Any value that fails validation is replaced with
    ``"application/octet-stream"`` so the download falls through to the direct
    (non-export) path rather than raising an error that would block legitimate use.
    """
    if not isinstance(mime, str):
        _LOG.warning("gdrive: non-string mimeType for file %s (%r); treating as octet-stream", file_id, type(mime).__name__)
        return "application/octet-stream"
    if len(mime) > _MAX_MIME_TYPE_LEN:
        _LOG.warning("gdrive: mimeType too long (%d chars) for file %s; treating as octet-stream", len(mime), file_id)
        return "application/octet-stream"
    if not _MIME_TYPE_RE.match(mime):
        _LOG.warning("gdrive: mimeType %r for file %s failed validation; treating as octet-stream", mime, file_id)
        return "application/octet-stream"
    _LOG.debug("gdrive: mimeType accepted: %s for file %s", sanitize_log_str(mime), file_id)
    return mime


def _download_to_cache(
    file_id: str,
    mime: str,
    local_path: Path,
    service: object,
    max_size_bytes: int,
    MediaIoBaseDownload: type,  # type: ignore[valid-type]  # google-api-python-client class passed as a callable; 'type' annotation is imprecise but captures the intent
) -> Path:
    """Download a Drive file into the local cache and return the final local path.

    Handles Google Workspace files (exported as PDF) and binary files (downloaded
    directly).  Enforces *max_size_bytes* per-chunk during streaming and again
    after the download completes.  Uses an atomic write so a crash never leaves a
    truncated cache entry.

    Returns the (possibly adjusted) *local_path* — it gains a ``.pdf`` suffix for
    Workspace exports that had no extension.
    """
    # Validate the MIME type from the Drive API before using it to branch and
    # before passing it to export_media() to prevent injection via crafted metadata.
    mime = _validate_mime_type(mime, file_id)
    # Google Workspace formats can't be downloaded directly — export as PDF.
    if mime.startswith("application/vnd.google-apps"):
        request = service.files().export_media(fileId=file_id, mimeType="application/pdf")  # type: ignore[attr-defined]  # service typed as object; google-api-client resource has .files() at runtime
        if not local_path.suffix:
            local_path = local_path.with_suffix(".pdf")
    else:
        request = service.files().get_media(fileId=file_id)  # type: ignore[attr-defined]  # same — google-api-client resource not in typeshed

    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    t_download_start = time.monotonic()
    try:
        while not done:
            _chunk_status, done = downloader.next_chunk()
            # Check accumulated size after each chunk to avoid holding the full
            # file in memory before detecting an oversize condition.
            if buf.tell() > max_size_bytes:
                raise RuntimeError(
                    f"Drive file {file_id!r} too large during download: "
                    f"{buf.tell()} bytes exceeds limit of {max_size_bytes} bytes"
                )
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Download failed for {file_id}: {e}") from e

    downloaded_bytes = buf.tell()
    if downloaded_bytes > max_size_bytes:
        raise RuntimeError(
            f"Drive file {file_id!r} too large: {downloaded_bytes} bytes "
            f"exceeds limit of {max_size_bytes} bytes"
        )

    t_write_start = time.monotonic()
    download_elapsed = t_write_start - t_download_start
    try:
        paths.ensure_dir(local_path.parent)
        # Atomic write: write to a temp file then rename so a killed/crashed
        # process never leaves a truncated cache file that looks valid.
        paths.atomic_write_bytes(local_path, buf.getvalue())
        written_bytes = local_path.stat().st_size
        write_elapsed = time.monotonic() - t_write_start
        _LOG.info(
            "gdrive downloaded: file_id=%s name=%s bytes=%d download_elapsed=%.3fs write_elapsed=%.3fs",
            file_id, sanitize_log_str(local_path.name), written_bytes, download_elapsed, write_elapsed,
        )
    except OSError as e:
        raise RuntimeError(f"Failed to write downloaded file to {local_path}: {e}") from e

    return local_path


def fetch_file(file_id: str, *, shrink_if_image: bool = True, max_size_bytes: int = _MAX_DOWNLOAD_BYTES) -> Path:
    """Download a Drive file. Return the local cached path.

    Shrinks if it's an image and large enough. Raises GDriveCredsUnavailable if
    credentials aren't set up. Raises RuntimeError on download failure or if the
    file exceeds *max_size_bytes* (default 100 MB) to prevent unbounded RAM use.
    """
    _validate_file_id(file_id)
    t_fetch_start = time.monotonic()
    _LOG.debug("gdrive fetch_file: file_id=%s shrink=%s max_bytes=%d", file_id, shrink_if_image, max_size_bytes)
    creds = get_credentials()

    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    cache_dir = image_shrink.ensure_cache_dir(paths.gdrive_cache_dir())
    service = build("drive", "v3", credentials=creds, cache_discovery=False)

    t_meta_start = time.monotonic()
    try:
        meta = service.files().get(fileId=file_id, fields="id, name, mimeType, size").execute()
    except Exception as e:
        raise RuntimeError(f"Failed to fetch Drive file metadata for {file_id}: {e}") from e
    _LOG.debug("gdrive metadata fetched: file_id=%s name=%r mime=%s elapsed=%.3fs",
               file_id,
               sanitize_log_str(str(meta.get("name", ""))),
               sanitize_log_str(str(meta.get("mimeType", ""))),
               time.monotonic() - t_meta_start)

    if not isinstance(meta, dict):
        raise RuntimeError(f"Expected dict metadata from Drive API, got {type(meta).__name__}")
    name: str = meta.get("name", file_id)
    mime: str = meta.get("mimeType", "")

    # Enforce size cap using Drive-reported size before downloading.
    # This is a best-effort pre-check; the post-download check below is the definitive guard.
    # Google Workspace files (Docs, Sheets, etc.) omit the "size" field entirely,
    # so we skip the pre-check when it's absent or non-numeric.
    if meta.get("size") is not None:
        try:
            reported_size = int(meta["size"])
            if reported_size > max_size_bytes:
                raise RuntimeError(
                    f"Drive file {file_id!r} too large: {reported_size} bytes "
                    f"exceeds limit of {max_size_bytes} bytes"
                )
        except (ValueError, TypeError):
            pass  # non-numeric size field — proceed to download

    local_path = _build_local_cache_path(file_id, name, cache_dir)

    if local_path.exists():
        cached_size = local_path.stat().st_size
        _LOG.info("gdrive cache hit: file_id=%s name=%s size=%d elapsed=%.3fs",
                  file_id, sanitize_log_str(local_path.name), cached_size, time.monotonic() - t_fetch_start)
    else:
        local_path = _download_to_cache(file_id, mime, local_path, service, max_size_bytes, MediaIoBaseDownload)

    result_path = image_shrink.shrink_if_image(local_path) if shrink_if_image else local_path
    _LOG.debug(
        "gdrive fetch_file complete: file_id=%s total_elapsed=%.3fs path=%s",
        file_id, time.monotonic() - t_fetch_start, sanitize_log_str(result_path.name),
    )
    return result_path


def list_drive_files(folder_id: str | None = None, max_results: int = 20) -> list[dict]:
    """List accessible Google Drive files.

    Returns a list of dicts with keys:
    - ``id``: Drive file ID
    - ``name``: Display name from Drive metadata
    - ``mimeType``: MIME type (e.g. "application/pdf")
    - ``size_bytes``: File size in bytes (0 if unavailable, e.g. for Workspace files)

    Args:
        folder_id: Optional parent folder ID to filter results.
        max_results: Maximum files to return (default 20).

    Returns:
        Empty list if credentials unavailable or API error occurs (fail-soft).
    """
    try:
        creds = get_credentials()
    except GDriveCredsUnavailable:
        return []

    try:
        from googleapiclient.discovery import build

        service = build("drive", "v3", credentials=creds, cache_discovery=False)

        # Build query filters for supported file types
        type_filters = [
            "mimeType='application/vnd.google-apps.document'",
            "mimeType='application/vnd.google-apps.presentation'",
            "mimeType='text/plain'",
            "mimeType='application/pdf'",
        ]
        type_query = " or ".join(f"({f})" for f in type_filters)

        # Add folder filter if specified
        query = type_query
        if folder_id:
            _validate_file_id(folder_id)
            query = f"'{folder_id}' in parents and ({type_query})"

        meta_fields = "files(id,name,mimeType,size)"
        results = service.files().list(
            q=query,
            spaces="drive",
            fields=meta_fields,
            pageSize=max_results,
        ).execute()

        files = results.get("files", [])
        output = [
            {
                "id": f.get("id", ""),
                "name": f.get("name", ""),
                "mimeType": f.get("mimeType", ""),
                "size_bytes": int(f.get("size", 0)) if f.get("size") else 0,
            }
            for f in files
        ]
        return output

    except Exception as e:
        _LOG.debug("list_drive_files failed: %s", e)
        return []


def run_oauth_oob_flow(client_secrets_path: Path) -> Path:
    """Interactive: opens browser, user grants access, pastes code. Saves creds JSON.

    Returns the path to the saved credentials file.

    Raises ``FileNotFoundError`` if *client_secrets_path* does not exist.
    Raises ``OSError`` if the credentials file cannot be written after a successful
    auth flow (e.g. permission denied on the token storage directory).
    Raises ``RuntimeError`` if the OAuth flow itself fails (e.g. user cancels,
    invalid client secrets format).
    """
    if not client_secrets_path.exists():
        raise FileNotFoundError(
            f"Client secrets file not found: {client_secrets_path}. "
            "Download it from Google Cloud Console → APIs & Services → Credentials."
        )

    from google_auth_oauthlib.flow import InstalledAppFlow

    try:
        flow = InstalledAppFlow.from_client_secrets_file(
            str(client_secrets_path),
            scopes=_DRIVE_SCOPES,
        )
    except (ValueError, KeyError) as exc:
        raise RuntimeError(
            f"Invalid client secrets file {client_secrets_path}: {exc}"
        ) from exc

    # Try local server first (loopback), fall back to console
    try:
        creds = flow.run_local_server(port=0, open_browser=True)
    except Exception as e:
        _LOG.debug("OAuth local-server flow failed (%s: %s); falling back to console", type(e).__name__, e)
        creds = flow.run_console()

    out = paths.gdrive_creds_path()
    try:
        _write_creds_secure(out, creds.to_json())
    except OSError as exc:
        raise OSError(
            f"OAuth flow succeeded but credentials could not be saved to {out}: {exc}. "
            "Check directory permissions."
        ) from exc
    return out


# ---------------------------------------------------------------------------
# Section-index extraction for Drive markdown / text docs.
#
# WHY: A 200 KB markdown spec pulled from Drive consumes ~50k tokens of context
# even when the agent only needs one section. By exposing the document's
# heading structure first, the agent can request a single section (via
# ``token-goat section <local-path>::<heading>``) and pay <1 KB instead.
# ---------------------------------------------------------------------------

# File extensions we treat as markdown-extractable text.  Extending this list
# (e.g. to ``.rst``) requires adding a matching language extractor.
TEXT_EXTENSIONS: tuple[str, ...] = (".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".txt")

# Maximum bytes we will load into memory for section-index extraction. Matches
# parser.MAX_FILE_SIZE so the behaviour is consistent with the local-file path
# and prevents OOM on a pathological Drive doc.
_MAX_SECTION_INDEX_BYTES = 2_000_000


def is_text_path(path: Path) -> bool:
    """Return True if *path* has an extension we know how to extract sections from.

    Used by the pre-fetch hook to decide whether to suggest the
    ``gdrive-sections`` shim instead of ``gdrive-fetch`` for Drive text docs.
    The check is extension-only (no content sniff) because the hook fires
    *before* the file is downloaded — we only have the Drive ``name`` field.
    """
    return path.suffix.lower() in TEXT_EXTENSIONS


def extract_section_index(local_path: Path) -> dict[str, object]:
    """Build a compact section-index summary for a markdown/text file.

    Returns a dict with::

        {
            "path": "<absolute path>",
            "size_bytes": N,
            "line_count": L,
            "sections": [
                {"heading": str, "level": int, "line": int, "end_line": int|None,
                 "approx_bytes": int},
                ...
            ],
            "extractor_available": bool,
        }

    The ``approx_bytes`` field lets the agent gauge how expensive each section
    would be to extract relative to the whole document.  When extraction fails
    (file too large, parser error, non-markdown extension) ``sections`` is an
    empty list and ``extractor_available`` is ``False``; the caller can still
    show the agent the total size and fall back to ``gdrive-fetch``.

    Never raises for malformed content — fail-soft, returns the best-available
    metadata so the hook hint always has something useful to emit.
    """
    result: dict[str, object] = {
        "path": str(local_path),
        "size_bytes": 0,
        "line_count": 0,
        "sections": [],
        "extractor_available": False,
    }
    try:
        size = local_path.stat().st_size
        result["size_bytes"] = size
    except OSError as exc:
        _LOG.debug("extract_section_index: stat failed for %s: %s", local_path, exc)
        return result

    if size > _MAX_SECTION_INDEX_BYTES:
        _LOG.info(
            "extract_section_index: %s too large (%d > %d bytes), skipping parse",
            sanitize_log_str(local_path.name), size, _MAX_SECTION_INDEX_BYTES,
        )
        return result

    if not is_text_path(local_path):
        return result

    try:
        raw = local_path.read_bytes()
    except OSError as exc:
        _LOG.debug("extract_section_index: read failed for %s: %s", local_path, exc)
        return result

    # Compute line offsets so we can attribute byte ranges to each section.
    # Splitting once is cheaper than re-scanning the text per-section.
    try:
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except (UnicodeError, AttributeError) as exc:
        _LOG.debug("extract_section_index: decode failed for %s: %s", local_path, exc)
        return result

    lines = text.split("\n")
    line_count = len(lines)
    result["line_count"] = line_count

    # Build cumulative byte offsets so section approx_bytes is O(1) per section.
    # Index i = byte offset of the *start* of line (i+1).  +1 per line for the
    # newline that ``str.split`` consumed.
    offsets: list[int] = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln.encode("utf-8")) + 1)

    # Import lazily so the extractor cost is only paid when actually invoked.
    try:
        from .languages.markdown import extract as md_extract
    except ImportError as exc:
        _LOG.debug("extract_section_index: markdown extractor unavailable: %s", exc)
        return result

    try:
        _symbols, _refs, _imps, sections = md_extract(raw, local_path.name)
    except Exception as exc:
        _LOG.debug("extract_section_index: parse failed for %s: %s", local_path, exc)
        return result

    out_sections: list[dict[str, object]] = []
    for sec in sections:
        start_line = max(1, min(sec.line, line_count))
        end_line: int | None = sec.end_line
        if end_line is None:
            byte_end = offsets[-1]
        else:
            end_line_clamped = max(start_line, min(end_line, line_count))
            byte_end = offsets[end_line_clamped]
        approx_bytes = max(0, byte_end - offsets[start_line - 1])
        out_sections.append({
            "heading": sec.heading,
            "level": sec.level,
            "line": sec.line,
            "end_line": sec.end_line,
            "approx_bytes": approx_bytes,
        })

    result["sections"] = out_sections
    result["extractor_available"] = True
    return result
