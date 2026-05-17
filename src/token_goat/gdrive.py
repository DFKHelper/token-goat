"""Google Drive image fetcher: downloads + shrinks + caches."""
from __future__ import annotations

import contextlib
import io
import logging
import os
import sys
import time
from pathlib import Path
from typing import Protocol

from . import image_shrink, paths
from .hooks_common import sanitize_log_str

_LOG = logging.getLogger("token_goat.gdrive")


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
    so we simply write the file normally — the user's profile directory already
    provides the required isolation.

    Uses an atomic write-then-rename pattern so a partial write never leaves a
    truncated credential file behind.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        # Write via a low-level fd opened with restrictive mode so the file is
        # never world-readable, even briefly before a post-write chmod.
        tmp = path.with_suffix(path.suffix + ".tmp")
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
        import google.auth  # noqa: PLC0415

        creds, _project = google.auth.default(scopes=_DRIVE_SCOPES)
        return creds  # type: ignore[return-value]  # google.auth returns untyped object
    except Exception as e:  # noqa: BLE001
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
        from google.auth.transport.requests import Request  # noqa: PLC0415
        from google.oauth2.credentials import Credentials  # noqa: PLC0415

        creds: _GoogleCredentials = Credentials.from_authorized_user_file(str(creds_path), scopes=_DRIVE_SCOPES)  # type: ignore[assignment]
        if creds.expired and creds.refresh_token:
            t_refresh = time.monotonic()
            try:
                creds.refresh(Request())
            except Exception as refresh_err:  # noqa: BLE001
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
    except Exception:  # noqa: BLE001
        # Do NOT log the exception message if it contains credentials
        _LOG.warning("stored OAuth invalid or refresh failed")
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
    raise GDriveCredsUnavailable(
        "No Google Drive credentials. Run `token-goat gdrive-auth` once, "
        "or set up gcloud Application Default Credentials via "
        "`gcloud auth application-default login`."
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

# Maximum characters kept in a sanitised local filename derived from the Drive
# file's display name.  Long names can exceed filesystem path limits; 200 chars
# gives ample readability headroom while staying well under the 255-byte limit
# common to most filesystems.
_MAX_SAFE_FILENAME_CHARS = 200


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

    try:
        from googleapiclient.discovery import build  # noqa: PLC0415
        from googleapiclient.http import MediaIoBaseDownload  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "google-api-python-client is not installed. "
            "Install it with: pip install google-api-python-client"
        ) from exc

    cache_dir = image_shrink.ensure_cache_dir(paths.gdrive_cache_dir())

    service = build("drive", "v3", credentials=creds, cache_discovery=False)

    # Get metadata first
    t_meta_start = time.monotonic()
    try:
        meta = service.files().get(fileId=file_id, fields="id, name, mimeType, size").execute()
    except Exception as e:  # noqa: BLE001 — Google API can raise many undocumented exceptions
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

    # Build a safe local filename — remove path separators and control chars
    # Allow only alphanumeric, dot, hyphen, underscore
    safe_name = "".join(c for c in name if c.isalnum() or c in "._-")
    if not safe_name:
        safe_name = file_id
    # Truncate to reasonable length to prevent filesystem issues
    safe_name = safe_name[:_MAX_SAFE_FILENAME_CHARS]
    local_path = cache_dir / f"{file_id}_{safe_name}"

    # Final safety check: ensure the path is still within cache_dir
    try:
        local_path.resolve().relative_to(cache_dir.resolve())
    except ValueError:
        raise RuntimeError(f"Computed path escapes cache directory: {local_path}") from None

    if local_path.exists():
        cached_size = local_path.stat().st_size
        _LOG.info("gdrive cache hit: file_id=%s name=%s size=%d elapsed=%.3fs",
                  file_id, sanitize_log_str(local_path.name), cached_size, time.monotonic() - t_fetch_start)
    else:
        # Google Workspace formats can't be downloaded directly — export as PDF
        if mime.startswith("application/vnd.google-apps"):
            export_mime = "application/pdf"
            request = service.files().export_media(fileId=file_id, mimeType=export_mime)
            if not local_path.suffix:
                local_path = local_path.with_suffix(".pdf")
        else:
            request = service.files().get_media(fileId=file_id)

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
        except Exception as e:  # noqa: BLE001 — Google API can raise many undocumented exceptions
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
            local_path.parent.mkdir(parents=True, exist_ok=True)
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

    # Shrink if image
    if shrink_if_image:
        result_path = image_shrink.shrink_if_image(local_path)
        _LOG.debug(
            "gdrive fetch_file complete: file_id=%s total_elapsed=%.3fs path=%s",
            file_id, time.monotonic() - t_fetch_start, sanitize_log_str(result_path.name),
        )
        return result_path

    _LOG.debug(
        "gdrive fetch_file complete: file_id=%s total_elapsed=%.3fs path=%s",
        file_id, time.monotonic() - t_fetch_start, sanitize_log_str(local_path.name),
    )
    return local_path


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

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "google-auth-oauthlib is not installed. "
            "Install it with: pip install google-auth-oauthlib"
        ) from exc

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
    except Exception:  # noqa: BLE001
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
