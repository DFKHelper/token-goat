"""Tests for gdrive.py — Phase 13.

All tests mock the Google API client and google.auth; no real network calls are made.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from token_goat import gdrive, paths

# ---------------------------------------------------------------------------
# 1. _try_adc returns None when google.auth.default raises
# ---------------------------------------------------------------------------

class TestTryAdc:
    def test_adc_unavailable_returns_none(self):
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = gdrive._try_adc()
        assert result is None

    def test_adc_available_returns_creds(self):
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "my-project")):
            result = gdrive._try_adc()
        assert result is fake_creds


# ---------------------------------------------------------------------------
# 2. _try_stored_oauth returns None when creds file is missing
# ---------------------------------------------------------------------------

class TestTryStoredOauth:
    def test_missing_creds_file_returns_none(self, tmp_data_dir):
        # gdrive_creds_path() resolves to tmp_data_dir / "gdrive_creds.json" — doesn't exist
        result = gdrive._try_stored_oauth()
        assert result is None

    def test_present_valid_creds_file_returns_creds(self, tmp_data_dir):
        creds_path = paths.gdrive_creds_path()
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({
            "token": "tok",
            "refresh_token": "ref",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "cid",
            "client_secret": "csec",
            "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
        }), encoding="utf-8")

        fake_creds = MagicMock()
        fake_creds.expired = False
        fake_creds.refresh_token = "ref"

        with patch("google.oauth2.credentials.Credentials.from_authorized_user_file", return_value=fake_creds):
            result = gdrive._try_stored_oauth()

        assert result is fake_creds

    def test_invalid_creds_file_returns_none(self, tmp_data_dir):
        creds_path = paths.gdrive_creds_path()
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text("not-json", encoding="utf-8")

        result = gdrive._try_stored_oauth()
        assert result is None


# ---------------------------------------------------------------------------
# 3. get_credentials raises GDriveCredsUnavailable when both paths fail
# ---------------------------------------------------------------------------

class TestGetCredentials:
    def test_raises_when_no_creds_available(self, tmp_data_dir):
        with (
            patch("google.auth.default", side_effect=Exception("no ADC")),
            pytest.raises(gdrive.GDriveCredsUnavailable),
        ):
            gdrive.get_credentials()

    def test_returns_adc_creds_when_available(self, tmp_data_dir):
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = gdrive.get_credentials()
        assert result is fake_creds

    def test_falls_through_to_stored_oauth_when_adc_missing(self, tmp_data_dir):
        fake_creds = MagicMock()
        fake_creds.expired = False

        creds_path = paths.gdrive_creds_path()
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text("{}", encoding="utf-8")

        with (
            patch("google.auth.default", side_effect=Exception("no ADC")),
            patch("google.oauth2.credentials.Credentials.from_authorized_user_file", return_value=fake_creds),
        ):
            result = gdrive.get_credentials()
        assert result is fake_creds


# ---------------------------------------------------------------------------
# 4. fetch_file writes file to cache_dir
# ---------------------------------------------------------------------------

def _make_drive_service_mock(
    file_name: str = "image.jpg",
    mime: str = "image/jpeg",
    content: bytes = b"FAKE",
) -> tuple[MagicMock, bytes]:
    """Build a mock googleapiclient service that returns a single file."""
    meta_result = {"id": "fake_id", "name": file_name, "mimeType": mime, "size": str(len(content))}
    service = MagicMock()
    service.files.return_value.get.return_value.execute.return_value = meta_result
    service.files.return_value.get_media.return_value = MagicMock()
    service.files.return_value.export_media.return_value = MagicMock()
    return service, content


class TestFetchFile:
    def _patch_build_and_download(self, service_mock: MagicMock, content: bytes):
        """Return context manager patches for build() and MediaIoBaseDownload."""

        def fake_downloader(buf, request, **kwargs):
            obj = MagicMock()
            calls = [0]

            def next_chunk():
                if calls[0] == 0:
                    calls[0] += 1
                    buf.write(content)
                    return MagicMock(progress=lambda: 1.0), True
                return MagicMock(), True

            obj.next_chunk = next_chunk
            return obj

        build_patch = patch("googleapiclient.discovery.build", return_value=service_mock)
        download_patch = patch("googleapiclient.http.MediaIoBaseDownload", side_effect=fake_downloader)
        return build_patch, download_patch

    def test_downloads_and_writes_to_cache(self, tmp_data_dir):
        content = b"JPEG_FAKE_BYTES" * 100
        service_mock, _ = _make_drive_service_mock(content=content)
        build_p, dl_p = self._patch_build_and_download(service_mock, content)

        fake_creds = MagicMock()
        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            build_p,
            dl_p,
            patch.object(gdrive.image_shrink, "is_image_path", return_value=False),
        ):
            result = gdrive.fetch_file("fake_id")

        assert result.exists()
        assert result.read_bytes() == content

    def test_image_mime_triggers_shrink(self, tmp_data_dir, tmp_path):
        content = b"PNG" * 200
        service_mock, _ = _make_drive_service_mock(file_name="photo.png", mime="image/png", content=content)
        build_p, dl_p = self._patch_build_and_download(service_mock, content)

        fake_creds = MagicMock()
        shrunken_path = tmp_path / "shrunken.png"
        shrunken_path.write_bytes(b"small")

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            build_p,
            dl_p,
            patch.object(gdrive.image_shrink, "is_image_path", return_value=True),
            patch.object(gdrive.image_shrink, "shrink", return_value=shrunken_path) as mock_shrink,
        ):
            result = gdrive.fetch_file("fake_id")

        mock_shrink.assert_called_once()
        assert result == shrunken_path

    def test_no_shrink_when_shrink_returns_none(self, tmp_data_dir):
        content = b"BMP" * 50
        service_mock, _ = _make_drive_service_mock(file_name="logo.bmp", mime="image/bmp", content=content)
        build_p, dl_p = self._patch_build_and_download(service_mock, content)

        fake_creds = MagicMock()

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            build_p,
            dl_p,
            patch.object(gdrive.image_shrink, "is_image_path", return_value=True),
            patch.object(gdrive.image_shrink, "shrink", return_value=None),
        ):
            result = gdrive.fetch_file("fake_id")

        # Should return the original downloaded path
        assert result.exists()

    def test_cached_file_no_re_download(self, tmp_data_dir):
        """Second call with same file_id returns cached path, no re-download."""
        content = b"CACHED_CONTENT"
        service_mock, _ = _make_drive_service_mock(content=content)

        # Pre-create the cache file as if already downloaded.
        # safe_name from "image.jpg" preserves the dot: "image.jpg"
        # → path = "fake_id_image.jpg"
        cache_dir = paths.gdrive_cache_dir()
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached = cache_dir / "fake_id_image.jpg"
        cached.write_bytes(content)

        fake_creds = MagicMock()
        mock_download_cls = MagicMock()

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=service_mock),
            patch("googleapiclient.http.MediaIoBaseDownload", mock_download_cls),
            patch.object(gdrive.image_shrink, "is_image_path", return_value=False),
        ):
            result = gdrive.fetch_file("fake_id")

        # MediaIoBaseDownload should never have been instantiated
        mock_download_cls.assert_not_called()
        assert result == cached

    def test_raises_creds_unavailable_when_no_creds(self, tmp_data_dir):
        with (
            patch("google.auth.default", side_effect=Exception("no ADC")),
            pytest.raises(gdrive.GDriveCredsUnavailable),
        ):
            gdrive.fetch_file("any_id")


# ---------------------------------------------------------------------------
# CLI tests
# ---------------------------------------------------------------------------

class TestGdriveAuthCli:
    def test_no_setup_prints_instructions_exit_zero(self, tmp_data_dir):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = runner.invoke(app, ["gdrive-auth"])

        assert result.exit_code == 0
        assert "Option A" in result.output
        assert "Option B" in result.output
        assert "Option C" in result.output

    def test_with_missing_client_secrets_file_exits_one(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        missing = str(tmp_path / "does_not_exist.json")
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = runner.invoke(app, ["gdrive-auth", "--client-secrets", missing])

        assert result.exit_code == 1

    def test_adc_detected_prints_confirmation_exit_zero(self, tmp_data_dir):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = runner.invoke(app, ["gdrive-auth"])

        assert result.exit_code == 0
        assert "Application Default Credentials" in result.output


class TestGdriveFetchCli:
    def test_no_creds_prints_error_exit_zero(self, tmp_data_dir):
        """No creds → helpful message in output, exit 0 (fail-soft)."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = runner.invoke(app, ["gdrive-fetch", "fake_id_for_test"])

        assert result.exit_code == 0
        # Typer's CliRunner mixes stdout/stderr into result.output by default
        assert "No Google Drive credentials" in result.output

    def test_successful_fetch_prints_path(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        cached = tmp_path / "fake_id_imagejpg"
        cached.write_bytes(b"data")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=cached):
            result = runner.invoke(app, ["gdrive-fetch", "fake_id"])

        assert result.exit_code == 0
        assert str(cached) in result.output

    def test_json_output_flag(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        cached = tmp_path / "fake_id_imagejpg"
        cached.write_bytes(b"data")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=cached):
            result = runner.invoke(app, ["gdrive-fetch", "fake_id", "--json"])

        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "path" in data
        assert "size" in data
