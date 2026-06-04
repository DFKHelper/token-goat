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

    def test_error_message_contains_exact_creds_path(self, tmp_data_dir):
        """GDriveCredsUnavailable message must include the exact credentials path so
        users know where to look after running ``token-goat gdrive-auth``."""
        with (
            patch("google.auth.default", side_effect=Exception("no ADC")),
            pytest.raises(gdrive.GDriveCredsUnavailable) as exc_info,
        ):
            gdrive.get_credentials()
        msg = str(exc_info.value)
        assert "token-goat gdrive-auth" in msg
        # Path must be platform-aware and present in the error message so users
        # can immediately see where to look.
        assert str(paths.gdrive_creds_path()) in msg

    def test_error_message_mentions_adc_alternative(self, tmp_data_dir):
        """Error message must mention gcloud ADC as an alternative auth path."""
        with (
            patch("google.auth.default", side_effect=Exception("no ADC")),
            pytest.raises(gdrive.GDriveCredsUnavailable) as exc_info,
        ):
            gdrive.get_credentials()
        msg = str(exc_info.value)
        assert "gcloud auth application-default login" in msg

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
            patch.object(gdrive.image_shrink, "should_shrink", return_value=True),
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


# ---------------------------------------------------------------------------
# Section-index extraction (drive markdown docs)
# ---------------------------------------------------------------------------

class TestIsTextPath:
    def test_markdown_extensions_recognised(self, tmp_path):
        assert gdrive.is_text_path(tmp_path / "spec.md")
        assert gdrive.is_text_path(tmp_path / "README.MD")
        assert gdrive.is_text_path(tmp_path / "notes.markdown")
        assert gdrive.is_text_path(tmp_path / "notes.txt")

    def test_non_text_extensions_rejected(self, tmp_path):
        assert not gdrive.is_text_path(tmp_path / "image.png")
        assert not gdrive.is_text_path(tmp_path / "binary")
        assert not gdrive.is_text_path(tmp_path / "doc.pdf")


class TestExtractSectionIndex:
    def test_markdown_with_headings(self, tmp_path):
        md = tmp_path / "spec.md"
        md.write_text(
            "# Title\n\nIntro text.\n\n## Install\n\nRun the thing.\n\n"
            "## Usage\n\nCall the API.\n\n### Advanced\n\nDeeper stuff.\n",
            encoding="utf-8",
        )
        idx = gdrive.extract_section_index(md)
        assert idx["extractor_available"] is True
        assert idx["size_bytes"] > 0
        headings = [s["heading"] for s in idx["sections"]]  # type: ignore[index]
        assert "Title" in headings
        assert "Install" in headings
        assert "Usage" in headings
        assert "Advanced" in headings
        # Each section should carry a positive approx_bytes
        for sec in idx["sections"]:  # type: ignore[union-attr]
            assert sec["approx_bytes"] >= 0
            assert sec["line"] >= 1

    def test_non_markdown_extension_returns_empty_sections(self, tmp_path):
        p = tmp_path / "image.png"
        p.write_bytes(b"\x89PNG\x00fake")
        idx = gdrive.extract_section_index(p)
        assert idx["extractor_available"] is False
        assert idx["sections"] == []
        assert idx["size_bytes"] > 0

    def test_missing_file_returns_zero_size(self, tmp_path):
        idx = gdrive.extract_section_index(tmp_path / "nope.md")
        assert idx["extractor_available"] is False
        assert idx["size_bytes"] == 0

    def test_oversized_file_skips_parse(self, tmp_path, monkeypatch):
        # Force the max-bytes threshold low so we don't have to write 2 MB.
        monkeypatch.setattr(gdrive, "_MAX_SECTION_INDEX_BYTES", 100)
        p = tmp_path / "huge.md"
        p.write_text("# Heading\n" + ("filler line\n" * 50), encoding="utf-8")
        idx = gdrive.extract_section_index(p)
        assert idx["extractor_available"] is False
        assert idx["sections"] == []
        assert idx["size_bytes"] > 100


class TestGdriveSectionsCli:
    def test_emits_section_index_for_markdown(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        md = tmp_path / "spec.md"
        md.write_text("# Title\n\nbody\n\n## Install\n\nsteps\n", encoding="utf-8")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=md):
            result = runner.invoke(app, ["gdrive-sections", "fake_id"])

        assert result.exit_code == 0
        assert str(md) in result.output
        assert "Title" in result.output
        assert "Install" in result.output
        assert "size=" in result.output

    def test_json_output(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        md = tmp_path / "spec.md"
        md.write_text("# A\n\n## B\n", encoding="utf-8")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=md):
            result = runner.invoke(app, ["gdrive-sections", "fake_id", "--json"])

        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["extractor_available"] is True
        assert any(s["heading"] == "A" for s in data["sections"])
        assert any(s["heading"] == "B" for s in data["sections"])

    def test_truncates_when_too_many_sections(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        # 5 headings, --max-sections 3 → result lists 3 + truncated marker.
        md = tmp_path / "spec.md"
        md.write_text("# A\n## B\n## C\n## D\n## E\n", encoding="utf-8")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=md):
            result = runner.invoke(app, ["gdrive-sections", "fake_id", "--max-sections", "3"])

        assert result.exit_code == 0
        assert "truncated at 3" in result.output

    def test_no_creds_exits_zero_fail_soft(self, tmp_data_dir):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = runner.invoke(app, ["gdrive-sections", "fake_id_for_test"])

        assert result.exit_code == 0
        assert "No Google Drive credentials" in result.output

    def test_non_markdown_file_falls_back_gracefully(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        binary = tmp_path / "image.png"
        binary.write_bytes(b"\x89PNGfake")

        runner = CliRunner()
        with patch.object(gdrive, "fetch_file", return_value=binary):
            result = runner.invoke(app, ["gdrive-sections", "fake_id"])

        assert result.exit_code == 0
        assert "no section index available" in result.output


# ---------------------------------------------------------------------------
# list_drive_files tests
# ---------------------------------------------------------------------------

class TestListDriveFiles:
    def test_returns_empty_list_when_no_credentials(self, tmp_data_dir):
        """list_drive_files returns [] when credentials unavailable (fail-soft)."""
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = gdrive.list_drive_files()
        assert result == []

    def test_returns_files_list_with_metadata(self, tmp_data_dir):
        """list_drive_files returns list of dicts with id, name, mimeType, size_bytes."""
        fake_creds = MagicMock()
        mock_service = MagicMock()
        mock_files = MagicMock()
        mock_list = MagicMock()

        # Mock the service chain: service.files().list()
        mock_service.files.return_value = mock_files
        mock_files.list.return_value = mock_list
        mock_list.execute.return_value = {
            "files": [
                {
                    "id": "doc-id-1",
                    "name": "My Doc",
                    "mimeType": "application/vnd.google-apps.document",
                    "size": "0",
                },
                {
                    "id": "pdf-id-2",
                    "name": "Report.pdf",
                    "mimeType": "application/pdf",
                    "size": "102400",
                },
            ]
        }

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=mock_service),
        ):
            result = gdrive.list_drive_files()

        assert len(result) == 2
        assert result[0]["id"] == "doc-id-1"
        assert result[0]["name"] == "My Doc"
        assert result[0]["mimeType"] == "application/vnd.google-apps.document"
        assert result[0]["size_bytes"] == 0
        assert result[1]["id"] == "pdf-id-2"
        assert result[1]["size_bytes"] == 102400

    def test_filters_by_folder_id(self, tmp_data_dir):
        """list_drive_files includes folder_id in query when provided."""
        fake_creds = MagicMock()
        mock_service = MagicMock()
        mock_files = MagicMock()
        mock_list = MagicMock()

        mock_service.files.return_value = mock_files
        mock_files.list.return_value = mock_list
        mock_list.execute.return_value = {"files": []}

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=mock_service),
        ):
            gdrive.list_drive_files(folder_id="folder-123")

        # Verify list() was called with query containing folder ID
        call_args = mock_files.list.call_args
        query = call_args.kwargs.get("q", "")
        assert "folder-123" in query
        assert "in parents" in query

    def test_handles_missing_size_field(self, tmp_data_dir):
        """list_drive_files treats missing size field as 0 (Workspace files)."""
        fake_creds = MagicMock()
        mock_service = MagicMock()
        mock_files = MagicMock()
        mock_list = MagicMock()

        mock_service.files.return_value = mock_files
        mock_files.list.return_value = mock_list
        # Google Workspace files often omit the size field
        mock_list.execute.return_value = {
            "files": [
                {
                    "id": "sheets-id",
                    "name": "Budget Sheet",
                    "mimeType": "application/vnd.google-apps.spreadsheet",
                    # note: no "size" field
                }
            ]
        }

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=mock_service),
        ):
            result = gdrive.list_drive_files()

        assert len(result) == 1
        assert result[0]["size_bytes"] == 0

    def test_returns_empty_on_api_error(self, tmp_data_dir):
        """list_drive_files returns [] on any API error (fail-soft)."""
        fake_creds = MagicMock()
        mock_service = MagicMock()
        mock_files = MagicMock()

        mock_service.files.return_value = mock_files
        mock_files.list.side_effect = RuntimeError("API error")

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=mock_service),
        ):
            result = gdrive.list_drive_files()

        assert result == []

    def test_respects_max_results_parameter(self, tmp_data_dir):
        """list_drive_files passes max_results to pageSize."""
        fake_creds = MagicMock()
        mock_service = MagicMock()
        mock_files = MagicMock()
        mock_list = MagicMock()

        mock_service.files.return_value = mock_files
        mock_files.list.return_value = mock_list
        mock_list.execute.return_value = {"files": []}

        with (
            patch("google.auth.default", return_value=(fake_creds, "proj")),
            patch("googleapiclient.discovery.build", return_value=mock_service),
        ):
            gdrive.list_drive_files(max_results=50)

        call_args = mock_files.list.call_args
        assert call_args.kwargs.get("pageSize") == 50


# ---------------------------------------------------------------------------
# CLI tests for gdrive-list
# ---------------------------------------------------------------------------

class TestCliGdriveList:
    def test_lists_files_in_human_readable_format(self, tmp_data_dir):
        """token-goat gdrive-list displays files as 'id  name (type, size)'."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        files = [
            {
                "id": "doc-1",
                "name": "Spec",
                "mimeType": "application/vnd.google-apps.document",
                "size_bytes": 0,
            },
            {
                "id": "pdf-1",
                "name": "Guide.pdf",
                "mimeType": "application/pdf",
                "size_bytes": 204800,
            },
        ]

        with patch.object(gdrive, "list_drive_files", return_value=files):
            result = runner.invoke(app, ["gdrive-list"])

        assert result.exit_code == 0
        assert "doc-1  Spec (Google Docs, 0 B)" in result.output
        assert "pdf-1  Guide.pdf (PDF, 200 KB)" in result.output

    def test_shows_helpful_message_when_no_files(self, tmp_data_dir):
        """token-goat gdrive-list shows credential message when no files found."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()

        with patch.object(gdrive, "list_drive_files", return_value=[]):
            result = runner.invoke(app, ["gdrive-list"])

        assert result.exit_code == 0
        assert "No files found" in result.output

    def test_passes_folder_id_to_list_drive_files(self, tmp_data_dir):
        """token-goat gdrive-list --folder passes folder ID to the function."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()

        with patch.object(gdrive, "list_drive_files", return_value=[]) as mock_list:
            result = runner.invoke(app, ["gdrive-list", "--folder", "folder-abc"])

        assert result.exit_code == 0
        mock_list.assert_called_once()
        call_args = mock_list.call_args
        assert call_args.kwargs.get("folder_id") == "folder-abc"

    def test_outputs_json_when_requested(self, tmp_data_dir):
        """token-goat gdrive-list --json outputs JSON."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        files = [
            {
                "id": "id-1",
                "name": "File 1",
                "mimeType": "text/plain",
                "size_bytes": 1024,
            }
        ]

        with patch.object(gdrive, "list_drive_files", return_value=files):
            result = runner.invoke(app, ["gdrive-list", "--json"])

        assert result.exit_code == 0
        output_json = json.loads(result.output)
        assert len(output_json) == 1
        assert output_json[0]["id"] == "id-1"

    def test_formats_size_as_kb_mb(self, tmp_data_dir):
        """token-goat gdrive-list formats sizes as KB/MB appropriately."""
        from typer.testing import CliRunner  # noqa: PLC0415

        from token_goat.cli import app  # noqa: PLC0415

        runner = CliRunner()
        files = [
            {"id": "a", "name": "small", "mimeType": "text/plain", "size_bytes": 512},
            {"id": "b", "name": "med", "mimeType": "text/plain", "size_bytes": 1048576},
            {"id": "c", "name": "big", "mimeType": "text/plain", "size_bytes": 5242880},
        ]

        with patch.object(gdrive, "list_drive_files", return_value=files):
            result = runner.invoke(app, ["gdrive-list"])

        assert result.exit_code == 0
        assert "512 B" in result.output  # < 1 KB
        assert "1 MB" in result.output  # 1 MB
        assert "5 MB" in result.output  # 5 MB
