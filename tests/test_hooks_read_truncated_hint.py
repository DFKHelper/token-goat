"""Tests for the truncated-read advisory hint injected by post_read."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from token_goat.hooks_read import _detect_partial_read, post_read

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_payload(file_path: str, resp_text: str, offset: int | None = None, limit: int | None = None) -> dict[str, Any]:
    """Build a minimal PostToolUse payload for a Read tool call."""
    tool_input: dict[str, Any] = {"file_path": file_path}
    if offset is not None:
        tool_input["offset"] = offset
    if limit is not None:
        tool_input["limit"] = limit
    return {
        "tool_name": "Read",
        "tool_input": tool_input,
        "tool_response": resp_text,
        "session_id": "test-session-id",
        "cwd": "/tmp",
    }


def _run_post_read_no_session(payload: dict[str, Any]) -> dict[str, Any]:
    """Run post_read with session/cache stubbed out so only the truncated-read path matters."""
    mock_cache = MagicMock()
    mock_cache.observed_tool_tokens = 0
    mock_cache.recent_hints = {}
    mock_cache.hints_ignored = {}

    mock_session = MagicMock()

    with (
        patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/tmp")),
        patch("token_goat.hooks_read._get_session", return_value=mock_session),
        patch("token_goat.hooks_read.load_session_safe", return_value=mock_cache),
        patch("token_goat.hooks_read._check_ignored_hint"),
        patch("token_goat.hooks_read._read_is_windowed", return_value=True),
        patch("token_goat.hooks_read._try_snapshot"),
        patch("token_goat.hooks_read._is_memory_file", return_value=False),
    ):
        return post_read(payload)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _detect_partial_read unit tests
# ---------------------------------------------------------------------------

class TestDetectPartialRead:
    def test_hyphen_form(self) -> None:
        result = _detect_partial_read("Showing lines 1-200 of 1500 total.")
        assert result == (1, 200, 1500)

    def test_en_dash_form(self) -> None:
        result = _detect_partial_read("lines 1–200 of 900")
        assert result == (1, 200, 900)

    def test_to_form(self) -> None:
        result = _detect_partial_read("(showing lines 1 to 200 of 1500)")
        assert result == (1, 200, 1500)

    def test_case_insensitive(self) -> None:
        result = _detect_partial_read("Lines 50-300 of 2000")
        assert result == (50, 300, 2000)

    def test_no_sentinel(self) -> None:
        assert _detect_partial_read("normal file content, no partial notice") is None

    def test_empty_string(self) -> None:
        assert _detect_partial_read("") is None

    def test_mid_offset_range(self) -> None:
        result = _detect_partial_read("lines 400-600 of 3000")
        assert result == (400, 600, 3000)


# ---------------------------------------------------------------------------
# post_read integration tests
# ---------------------------------------------------------------------------

PARTIAL_NOTICE_1500 = "File content here.\n(lines 1-200 of 1500)\nMore content."
PARTIAL_NOTICE_EN_DASH = "File content.\nlines 1–200 of 1500\nEnd."
PARTIAL_NOTICE_TO_FORM = "File content.\n(showing lines 1 to 200 of 1500)\nEnd."


class TestTruncatedHintInjected:
    """Cases where the hint SHOULD be injected."""

    def test_hint_injected_on_partial_read(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert result.get("continue") is True
        msg = result.get("systemMessage", "")
        assert "[token-goat]" in msg
        assert "1500" in msg

    def test_hint_contains_section_command(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert "token-goat section" in result.get("systemMessage", "")

    def test_hint_contains_skeleton_command(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert "token-goat skeleton" in result.get("systemMessage", "")

    def test_hint_contains_read_command(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert "token-goat read" in result.get("systemMessage", "")

    def test_en_dash_sentinel_triggers_hint(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_EN_DASH)
        result = _run_post_read_no_session(payload)
        assert "token-goat section" in result.get("systemMessage", "")

    def test_to_form_sentinel_triggers_hint(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_TO_FORM)
        result = _run_post_read_no_session(payload)
        assert "token-goat section" in result.get("systemMessage", "")

    def test_hint_includes_file_path(self) -> None:
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert "/project/src/big_file.py" in result.get("systemMessage", "")


class TestTruncatedHintSkipped:
    """Cases where the hint should NOT be injected."""

    def test_no_partial_sentinel_no_hint(self) -> None:
        payload = _make_payload("/project/src/big_file.py", "Normal file content without any partial notice.")
        result = _run_post_read_no_session(payload)
        assert "systemMessage" not in result or "token-goat section" not in result.get("systemMessage", "")

    def test_full_file_start_equals_end_no_hint(self) -> None:
        # start=1, end=1500, total=1500 → full file, skip
        payload = _make_payload("/project/src/big_file.py", "lines 1-1500 of 1500")
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    def test_total_at_min_threshold_no_hint(self) -> None:
        # Z=200, default threshold=200 → Z <= min_lines, skip
        payload = _make_payload("/project/src/small.py", "lines 1-100 of 200")
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    def test_total_below_min_threshold_no_hint(self) -> None:
        # Z=50 → well below threshold
        payload = _make_payload("/project/src/tiny.py", "lines 1-25 of 50")
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    @pytest.mark.parametrize("ext", [".png", ".jpg", ".jpeg", ".gif", ".ico",
                                     ".pdf", ".zip", ".tar", ".gz", ".exe",
                                     ".dll", ".so", ".dylib", ".woff", ".ttf", ".eot"])
    def test_binary_and_image_extensions_no_hint(self, ext: str) -> None:
        payload = _make_payload(f"/project/assets/file{ext}", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    def test_bash_compress_disabled_no_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", "0")
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    @pytest.mark.parametrize("val", ["false", "no", "off", "False", "NO"])
    def test_bash_compress_disabled_variants_no_hint(self, monkeypatch: pytest.MonkeyPatch, val: str) -> None:
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", val)
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    def test_bash_compress_enabled_no_suppression(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Explicitly set to "1" (enabled) → hint should still fire
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", "1")
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        result = _run_post_read_no_session(payload)
        assert "token-goat section" in result.get("systemMessage", "")


class TestTruncatedHintConfigMinLines:
    """Verify truncated_read_min_lines config is respected."""

    def test_custom_min_lines_suppresses_hint(self) -> None:
        # Z=500 but min_lines=600 → skip
        notice = "lines 1-200 of 500"
        payload = _make_payload("/project/src/big_file.py", notice)
        mock_cfg = MagicMock()
        mock_cfg.hints.truncated_read_min_lines = 600
        with patch("token_goat.hooks_read.post_read.__module__"):
            pass
        mock_cache = MagicMock()
        mock_cache.observed_tool_tokens = 0
        mock_cache.recent_hints = {}
        mock_cache.hints_ignored = {}
        mock_session = MagicMock()
        with (
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/tmp")),
            patch("token_goat.hooks_read._get_session", return_value=mock_session),
            patch("token_goat.hooks_read.load_session_safe", return_value=mock_cache),
            patch("token_goat.hooks_read._check_ignored_hint"),
            patch("token_goat.hooks_read._read_is_windowed", return_value=True),
            patch("token_goat.hooks_read._try_snapshot"),
            patch("token_goat.hooks_read._is_memory_file", return_value=False),
            patch("token_goat.hooks_read.post_read.__globals__['__builtins__']", create=True),
        ):
            # Patch config inside the function via the module's namespace
            import token_goat.hooks_read as hr_mod
            orig = getattr(hr_mod, "_cfg_trunc", None)
            try:
                with patch.dict("sys.modules", {"token_goat.hooks_read._cfg_trunc": mock_cfg}):
                    # Use importlib-level patch of config.load
                    import token_goat.config as cfg_mod
                    with patch.object(cfg_mod, "load", return_value=mock_cfg):
                        result = post_read(payload)  # type: ignore[arg-type]
            finally:
                if orig is not None:
                    hr_mod._cfg_trunc = orig
        sm = result.get("systemMessage", "")
        assert "token-goat section" not in sm

    def test_custom_min_lines_allows_hint(self) -> None:
        # Z=1500, min_lines=100 → hint fires
        payload = _make_payload("/project/src/big_file.py", PARTIAL_NOTICE_1500)
        mock_cache = MagicMock()
        mock_cache.observed_tool_tokens = 0
        mock_cache.recent_hints = {}
        mock_cache.hints_ignored = {}
        mock_session = MagicMock()
        import token_goat.config as cfg_mod
        mock_cfg = MagicMock()
        mock_cfg.hints.truncated_read_min_lines = 100
        with (
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/tmp")),
            patch("token_goat.hooks_read._get_session", return_value=mock_session),
            patch("token_goat.hooks_read.load_session_safe", return_value=mock_cache),
            patch("token_goat.hooks_read._check_ignored_hint"),
            patch("token_goat.hooks_read._read_is_windowed", return_value=True),
            patch("token_goat.hooks_read._try_snapshot"),
            patch("token_goat.hooks_read._is_memory_file", return_value=False),
            patch.object(cfg_mod, "load", return_value=mock_cfg),
        ):
            result = post_read(payload)  # type: ignore[arg-type]
        assert "token-goat section" in result.get("systemMessage", "")
