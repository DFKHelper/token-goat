"""Tests for memory file frontmatter stripping in post_read.

Covers:
- _is_memory_file detection (positive and negative)
- _strip_memory_frontmatter with and without frontmatter
- CRLF line endings
- MEMORY.md exclusion
- Integration via post_read (mocked session)
"""
from __future__ import annotations

import sys
import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from token_goat.hooks_read import _is_memory_file, _strip_memory_frontmatter, post_read

# ---------------------------------------------------------------------------
# _is_memory_file
# ---------------------------------------------------------------------------

class TestIsMemoryFile:
    @pytest.mark.skipif(sys.platform != "win32", reason="Windows path format")
    def test_typical_windows_path(self) -> None:
        path = r"C:\Users\zelys\.claude\projects\C--Projects-token-goat\memory\feedback_wsl_tools.md"
        assert _is_memory_file(path) is True

    def test_typical_posix_path(self) -> None:
        path = "/home/user/.claude/projects/myproject/memory/reference_api.md"
        assert _is_memory_file(path) is True

    def test_memory_index_excluded(self) -> None:
        path = r"C:\Users\zelys\.claude\projects\C--Projects-token-goat\memory\MEMORY.md"
        assert _is_memory_file(path) is False

    def test_memory_index_lowercase_excluded(self) -> None:
        path = "/home/user/.claude/projects/proj/memory/memory.md"
        assert _is_memory_file(path) is False

    def test_non_md_extension_excluded(self) -> None:
        path = r"C:\Users\zelys\.claude\projects\proj\memory\notes.txt"
        assert _is_memory_file(path) is False

    def test_no_claude_dir_excluded(self) -> None:
        path = "/home/user/projects/memory/feedback.md"
        assert _is_memory_file(path) is False

    def test_no_memory_dir_excluded(self) -> None:
        path = r"C:\Users\zelys\.claude\projects\proj\feedback.md"
        assert _is_memory_file(path) is False

    def test_memory_in_filename_not_directory(self) -> None:
        # "memory" appears only in the filename, not as a path component
        path = r"C:\Users\zelys\.claude\projects\proj\memory_notes.md"
        assert _is_memory_file(path) is False

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows path format")
    def test_claude_case_insensitive(self) -> None:
        # On Windows path components may be any case
        path = r"C:\Users\zelys\.CLAUDE\projects\proj\memory\note.md"
        assert _is_memory_file(path) is True

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows path format")
    def test_memory_case_insensitive(self) -> None:
        path = r"C:\Users\zelys\.claude\projects\proj\Memory\note.md"
        assert _is_memory_file(path) is True


# ---------------------------------------------------------------------------
# _strip_memory_frontmatter
# ---------------------------------------------------------------------------

_FRONTMATTER = """\
---
name: my-note
description: a test memory file
metadata:
  type: feedback
---

This is the body content.
It has multiple lines.
"""

_BODY_ONLY = """\
This is the body content.
It has multiple lines.
"""


class TestStripMemoryFrontmatter:
    def test_strips_frontmatter_and_returns_body(self) -> None:
        body, n = _strip_memory_frontmatter(_FRONTMATTER)
        assert body == _BODY_ONLY
        assert n > 0

    def test_returns_zero_when_no_frontmatter(self) -> None:
        content = "# Just a heading\n\nNo frontmatter here.\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == content
        assert n == 0

    def test_passthrough_unchanged_when_no_frontmatter(self) -> None:
        content = "plain text with no yaml\n"
        body, n = _strip_memory_frontmatter(content)
        assert body is content or body == content
        assert n == 0

    def test_strips_blank_line_after_closing_fence(self) -> None:
        content = "---\nkey: value\n---\n\nBody starts here.\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == "Body starts here.\n"
        assert n > 0

    def test_no_blank_line_after_closing_fence(self) -> None:
        content = "---\nkey: value\n---\nBody starts immediately.\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == "Body starts immediately.\n"
        assert n > 0

    def test_malformed_no_closing_fence_passthrough(self) -> None:
        content = "---\nkey: value\nno closing fence\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == content
        assert n == 0

    def test_crlf_line_endings(self) -> None:
        content = "---\r\nname: test\r\ndesc: x\r\n---\r\n\r\nBody line.\r\n"
        body, n = _strip_memory_frontmatter(content)
        assert "name: test" not in body
        assert "Body line." in body
        assert n > 0

    def test_crlf_no_frontmatter_passthrough(self) -> None:
        content = "No frontmatter here.\r\nSecond line.\r\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == content
        assert n == 0

    def test_lines_stripped_count_includes_fence_and_blank(self) -> None:
        # 3 frontmatter lines + opening fence + closing fence + blank = 7 lines stripped
        content = "---\na: 1\nb: 2\nc: 3\n---\n\nBody.\n"
        _, n = _strip_memory_frontmatter(content)
        # opening(1) + 3 kv lines + closing(1) + blank(1) = 6
        assert n == 6

    def test_empty_body_after_frontmatter(self) -> None:
        content = "---\nname: x\n---\n"
        body, n = _strip_memory_frontmatter(content)
        assert body == ""
        assert n > 0


# ---------------------------------------------------------------------------
# Integration: post_read with a mocked session
# ---------------------------------------------------------------------------

_SID = "test-session-memory-strip"
_CWD = r"C:\Projects\token-goat"

_MEMORY_PATH = "/home/user/.claude/projects/C--Projects-token-goat/memory/feedback_wsl.md"

_MEMORY_CONTENT = """\
---
name: feedback-wsl
description: WSL tool patterns
metadata:
  type: feedback
---

Use wsl -d Ubuntu for image processing.
"""

_MEMORY_BODY = "Use wsl -d Ubuntu for image processing.\n"


def _make_payload(file_path: str, content: str) -> dict[str, Any]:
    return {
        "session_id": _SID,
        "cwd": _CWD,
        "tool_name": "Read",
        "tool_input": {"file_path": file_path},
        "tool_response": content,
    }


def _make_fresh_cache():
    from token_goat.session import SessionCache  # noqa: PLC0415
    now = time.time()
    return SessionCache(session_id=_SID, started_ts=now, last_activity_ts=now)


class TestPostReadMemoryStrip:
    def _call(self, payload: dict[str, Any]) -> dict[str, Any]:
        cache = _make_fresh_cache()
        mock_session = MagicMock()
        mock_session.mark_file_read = MagicMock()
        mock_session.save = MagicMock()

        with (
            patch("token_goat.hooks_read.get_hook_context", return_value=(_SID, _CWD)),
            patch("token_goat.hooks_read._get_session", return_value=mock_session),
            patch("token_goat.hooks_read.load_session_safe", return_value=cache),
            patch("token_goat.hooks_read._check_ignored_hint"),
            patch("token_goat.hooks_read._read_is_windowed", return_value=True),
            patch("token_goat.hooks_read._try_snapshot"),
        ):
            return post_read(payload)  # type: ignore[arg-type]

    def test_memory_file_with_frontmatter_returns_system_message(self) -> None:
        payload = _make_payload(_MEMORY_PATH, _MEMORY_CONTENT)
        result = self._call(payload)
        assert result.get("continue") is True
        sys_msg = result.get("systemMessage", "")
        assert "[token-goat] memory file:" in sys_msg
        assert "frontmatter lines stripped" in sys_msg
        assert _MEMORY_BODY in sys_msg

    def test_memory_file_system_message_excludes_frontmatter_keys(self) -> None:
        payload = _make_payload(_MEMORY_PATH, _MEMORY_CONTENT)
        result = self._call(payload)
        sys_msg = result.get("systemMessage", "")
        assert "name: feedback-wsl" not in sys_msg
        assert "type: feedback" not in sys_msg

    def test_memory_file_no_frontmatter_returns_continue(self) -> None:
        content = "Just body content, no frontmatter.\n"
        payload = _make_payload(_MEMORY_PATH, content)
        result = self._call(payload)
        # No frontmatter to strip — should continue without systemMessage modification
        assert result.get("continue") is True
        assert "systemMessage" not in result or "frontmatter" not in result.get("systemMessage", "")

    def test_memory_index_not_stripped(self) -> None:
        index_path = "/home/user/.claude/projects/C--Projects-token-goat/memory/MEMORY.md"
        payload = _make_payload(index_path, _MEMORY_CONTENT)
        result = self._call(payload)
        # MEMORY.md should not trigger stripping
        assert "systemMessage" not in result or "frontmatter" not in result.get("systemMessage", "")

    def test_non_memory_file_not_stripped(self) -> None:
        regular_path = "/home/user/projects/token-goat/src/token_goat/hooks_read.py"
        payload = _make_payload(regular_path, _MEMORY_CONTENT)
        result = self._call(payload)
        assert "systemMessage" not in result or "frontmatter" not in result.get("systemMessage", "")

    def test_crlf_memory_content_stripped(self) -> None:
        crlf_content = "---\r\nname: x\r\ndesc: y\r\n---\r\n\r\nBody text.\r\n"
        payload = _make_payload(_MEMORY_PATH, crlf_content)
        result = self._call(payload)
        sys_msg = result.get("systemMessage", "")
        assert "frontmatter lines stripped" in sys_msg
        assert "Body text." in sys_msg
