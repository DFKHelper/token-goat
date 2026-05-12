"""Google Drive image fetcher: downloads + shrinks + caches."""
from __future__ import annotations

import io
import logging
from pathlib import Path

from . import image_shrink, paths

_LOG = logging.getLogger("tokenwise.gdrive")

_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


class GDriveCredsUnavailable(Exception):
    pass


def _try_adc() -> object | None:
    """Try Google Application Default Credentials (gcloud auth application-default login)."""
    try:
        import google.auth  # noqa: PLC0415

        creds, _project = google.auth.default(scopes=_DRIVE_SCOPES)
        return creds
    except Exception as e:  # noqa: BLE001
        _LOG.info("ADC unavailable: %s", e)
        return None


def _try_stored_oauth() -> object | None:
    """Try cached OAuth tokens from a previous tokenwise gdrive-auth run."""
    creds_path = paths.gdrive_creds_path()
    if not creds_path.exists():
        return None
    try:
        from google.auth.transport.requests import Request  # noqa: PLC0415
        from google.oauth2.credentials import Credentials  # noqa: PLC0415

        creds = Credentials.from_authorized_user_file(str(creds_path), scopes=_DRIVE_SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            creds_path.write_text(creds.to_json(), encoding="utf-8")
        return creds
    except Exception as e:  # noqa: BLE001
        _LOG.warning("stored OAuth invalid: %s", e)
        return None


def get_credentials() -> object:
    """Try ADC then stored OAuth. Raise GDriveCredsUnavailable if neither works."""
    creds = _try_adc()
    if creds is not None:
        return creds
    creds = _try_stored_oauth()
    if creds is not None:
        return creds
    raise GDriveCredsUnavailable(
        "No Google Drive credentials. Run `tokenwise gdrive-auth` once, "
        "or set up gcloud Application Default Credentials via "
        "`gcloud auth application-default login`."
    )


def fetch_file(file_id: str, *, shrink_if_image: bool = True) -> Path:
    """Download a Drive file. Return the local cached path.

    Shrinks if it's an image and large enough. Raises GDriveCredsUnavailable if
    credentials aren't set up. Raises RuntimeError on download failure.
    """
    creds = get_credentials()

    from googleapiclient.discovery import build  # noqa: PLC0415
    from googleapiclient.http import MediaIoBaseDownload  # noqa: PLC0415

    cache_dir = paths.gdrive_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    service = build("drive", "v3", credentials=creds, cache_discovery=False)

    # Get metadata first
    meta = service.files().get(fileId=file_id, fields="id, name, mimeType, size").execute()
    name: str = meta.get("name", file_id)
    mime: str = meta.get("mimeType", "")

    # Build a safe local filename
    safe_name = "".join(c for c in name if c.isalnum() or c in "._-")
    if not safe_name:
        safe_name = file_id
    local_path = cache_dir / f"{file_id}_{safe_name}"

    if local_path.exists():
        _LOG.info("gdrive cache hit: %s", local_path.name)
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
        while not done:
            _status, done = downloader.next_chunk()
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(buf.getvalue())
        _LOG.info("gdrive downloaded: %s → %s (%d bytes)", file_id, local_path.name, local_path.stat().st_size)

    # Shrink if image
    if shrink_if_image and image_shrink.is_image_path(str(local_path)):
        shrunken = image_shrink.shrink(local_path)
        if shrunken is not None:
            return shrunken

    return local_path


def run_oauth_oob_flow(client_secrets_path: Path) -> Path:
    """Interactive: opens browser, user grants access, pastes code. Saves creds JSON.

    Returns the path to the saved credentials file.
    """
    from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: PLC0415

    flow = InstalledAppFlow.from_client_secrets_file(
        str(client_secrets_path),
        scopes=_DRIVE_SCOPES,
    )
    # Try local server first (loopback), fall back to console
    try:
        creds = flow.run_local_server(port=0, open_browser=True)
    except Exception:  # noqa: BLE001
        creds = flow.run_console()

    out = paths.gdrive_creds_path()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(creds.to_json(), encoding="utf-8")
    return out
