"""Tests for image-shrink integration in the pre_read hook — Phase 12."""
from __future__ import annotations

from pathlib import Path

import pytest
from hook_helpers import assert_continue as _assert_continue
from hook_helpers import make_large_jpeg as _make_large_jpeg
from hook_helpers import make_small_jpeg as _make_small_jpeg

from token_goat import hooks_cli, image_shrink


@pytest.fixture(autouse=True)
def _raise_watchdog(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "5000")


# ---------------------------------------------------------------------------
# 11. Large image → hook returns updatedInput with shrunken path
# ---------------------------------------------------------------------------

class TestPreReadHookLargeImage:
    def test_large_image_returns_updated_input(self, tmp_data_dir, tmp_path):
        src = _make_large_jpeg(tmp_path)
        assert src.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        payload = {
            "session_id": "img_s1",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }
        result = hooks_cli.dispatch("pre-read", payload)

        _assert_continue(result)
        assert "hookSpecificOutput" in result, "Expected hookSpecificOutput for large image"

        hso = result["hookSpecificOutput"]
        assert "updatedInput" in hso, "Expected updatedInput in hookSpecificOutput"
        assert "file_path" in hso["updatedInput"]

        shrunken_path = Path(hso["updatedInput"]["file_path"])
        assert shrunken_path.exists(), "Shrunken path must exist"
        assert shrunken_path != src, "Shrunken path must differ from source"
        assert shrunken_path.stat().st_size < src.stat().st_size

    def test_large_image_additional_context_mentions_savings(self, tmp_data_dir, tmp_path):
        src = _make_large_jpeg(tmp_path)

        payload = {
            "session_id": "img_s2",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }
        result = hooks_cli.dispatch("pre-read", payload)

        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "")
        assert "token-goat" in ctx
        # New format: "X MB → Y KB (saving ~Z%)" — verify sizes and % are present.
        assert "→" in ctx
        assert "saving ~" in ctx


# ---------------------------------------------------------------------------
# 12. Small image → no updatedInput, falls through
# ---------------------------------------------------------------------------

class TestPreReadHookSmallImage:
    def test_small_image_no_updated_input(self, tmp_data_dir, tmp_path):
        src = _make_small_jpeg(tmp_path)
        assert src.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES

        payload = {
            "session_id": "img_s3",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }
        result = hooks_cli.dispatch("pre-read", payload)

        _assert_continue(result)
        # Small image → falls through to hint logic → no hookSpecificOutput
        # (no session cache hit either, so plain continue:true)
        hso = result.get("hookSpecificOutput", {})
        assert "updatedInput" not in hso


# ---------------------------------------------------------------------------
# 13. Non-image file → no updatedInput, falls through to hint logic
# ---------------------------------------------------------------------------

class TestPreReadHookNonImage:
    def test_non_image_no_updated_input(self, tmp_data_dir, tmp_path):
        p = tmp_path / "source.py"
        p.write_text("x = 1\n" * 100)

        payload = {
            "session_id": "img_s4",
            "tool_name": "Read",
            "tool_input": {"file_path": str(p)},
            "cwd": str(tmp_path),
        }
        result = hooks_cli.dispatch("pre-read", payload)

        _assert_continue(result)
        hso = result.get("hookSpecificOutput", {})
        assert "updatedInput" not in hso


# ---------------------------------------------------------------------------
# 14. Garbage payload → continue:true, no crash
# ---------------------------------------------------------------------------

class TestPreReadHookGarbage:
    def test_none_payload_does_not_crash(self, tmp_data_dir):
        result = hooks_cli.pre_read(None)  # type: ignore[arg-type]
        _assert_continue(result)

    def test_empty_dict_does_not_crash(self, tmp_data_dir):
        result = hooks_cli.dispatch("pre-read", {})
        _assert_continue(result)

    def test_missing_file_path_does_not_crash(self, tmp_data_dir):
        payload = {
            "session_id": "img_s5",
            "tool_name": "Read",
            "tool_input": {},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        _assert_continue(result)

    def test_nonexistent_image_path_does_not_crash(self, tmp_data_dir, tmp_path):
        payload = {
            "session_id": "img_s6",
            "tool_name": "Read",
            "tool_input": {"file_path": str(tmp_path / "ghost.png")},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        _assert_continue(result)
        # Non-existent image → should_shrink=False → falls through, no updatedInput
        hso = result.get("hookSpecificOutput", {})
        assert "updatedInput" not in hso


# ---------------------------------------------------------------------------
# Item A21: shrink hint always shows before→after sizes with % savings
# ---------------------------------------------------------------------------


def _fmt_bytes(n: int) -> str:
    """Mirror the _fmt_bytes helper in hooks_read._try_shrink_image."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1_000:
        return f"{n / 1_000:.0f} KB"
    return f"{n} B"


class TestShrinkNoteRatioFormat:
    """The shrink hint always shows 'X MB → Y KB (saving ~Z%)' regardless of ratio.

    This replaced the old conditional format that only showed the output size
    for >= 4× compression ratios. The new format gives the agent full context
    at a glance without reading the file.
    """

    def _build_note(self, src_bytes: int, out_bytes: int, bytes_saved: int, file_path: str) -> str:
        """Re-implement the note-building logic from _try_shrink_image for unit tests."""
        savings_pct = (
            100.0 * bytes_saved / src_bytes if src_bytes > 0 else 0.0
        )
        size_str = f"{_fmt_bytes(src_bytes)} → {_fmt_bytes(out_bytes)} (saving ~{savings_pct:.0f}%)"
        return (
            f"Note: image auto-shrunk by token-goat "
            f"({size_str}). "
            f"Original: {file_path}"
        )

    def test_high_ratio_shows_before_after_and_percent(self):
        """High compression ratio: shows both sizes and the % savings."""
        note = self._build_note(4_000_000, 180_000, 3_820_000, "/tmp/big.jpg")
        assert "→" in note
        # 4MB → 180KB, saving ~96%
        assert "4.0 MB" in note
        assert "180 KB" in note
        assert "saving ~96%" in note

    def test_low_ratio_also_shows_before_after_and_percent(self):
        """Even modest compression ratio: shows both sizes and the % savings."""
        note = self._build_note(200_000, 100_000, 100_000, "/tmp/small.jpg")
        assert "→" in note
        assert "200 KB" in note
        assert "100 KB" in note
        assert "saving ~50%" in note

    def test_sub_kb_shown_as_bytes(self):
        """Values below 1000 bytes are shown as 'N B'."""
        note = self._build_note(500, 200, 300, "/tmp/tiny.jpg")
        assert "500 B" in note
        assert "200 B" in note

    def test_percentage_included_for_any_ratio(self):
        """Percentage savings is included regardless of the ratio."""
        note_small = self._build_note(10_000, 4_000, 6_000, "/tmp/a.jpg")
        note_large = self._build_note(40_000, 9_000, 31_000, "/tmp/b.jpg")
        assert "saving ~" in note_small
        assert "saving ~" in note_large

    def test_zero_out_bytes_shows_100_percent(self):
        """When out_bytes is 0, savings pct computes to 100%."""
        note = self._build_note(10_000, 0, 10_000, "/tmp/zero.jpg")
        assert "saving ~100%" in note

    def test_original_path_included(self):
        """Original file path always appears in the hint."""
        note = self._build_note(200_000, 80_000, 120_000, "/home/user/photo.png")
        assert "Original: /home/user/photo.png" in note


class TestShrinkHintPercentOnRealImage:
    """Integration test: the live hook response for a large image includes
    the before→after sizes and % savings in the additionalContext."""

    def test_large_jpeg_hint_contains_percent_and_arrow(self, tmp_data_dir, tmp_path):
        src = _make_large_jpeg(tmp_path)

        payload = {
            "session_id": "img_pct1",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }
        result = hooks_cli.dispatch("pre-read", payload)

        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "")
        # Must contain arrow (before→after) and percent
        assert "→" in ctx, f"Expected '→' in hint: {ctx!r}"
        assert "saving ~" in ctx, f"Expected 'saving ~N%' in hint: {ctx!r}"
        assert "%" in ctx, f"Expected percentage in hint: {ctx!r}"


# ---------------------------------------------------------------------------
# Bypass telemetry: sub-threshold images record image_shrink_skipped stat
# so the bypass rate is measurable from the stats DB.
# ---------------------------------------------------------------------------


class TestTryShrinkImageBypassTelemetry:
    """Sub-threshold images record an informational image_shrink_skipped row.

    The row carries the actual file size and the threshold that was checked
    against, so a follow-up `token-goat stats` (or a manual sqlite query) can
    answer "how often is the threshold bypassed?" and "is the threshold tuned
    to real data?".
    """

    def test_small_image_records_skipped_stat(self, tmp_path, monkeypatch):
        from unittest.mock import patch

        from token_goat.hooks_read import _try_shrink_image

        # Build a sub-threshold file ourselves so we don't depend on PIL: a
        # 1 KB .jpg is well under both the lossy and lossless thresholds.
        src = tmp_path / "tiny.jpg"
        src.write_bytes(b"\xff\xd8\xff" + b"\x00" * 1024)

        recorded: list[tuple[str, int, int, str]] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail=""):
            recorded.append((kind, bytes_saved, tokens_saved, detail))

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            result = _try_shrink_image(str(src), {"file_path": str(src)})

        assert result is None, "Sub-threshold image must not produce a redirect"
        # Exactly one stat row for the bypass should be recorded.
        skipped = [r for r in recorded if r[0] == "image_shrink_skipped"]
        assert skipped, f"Expected image_shrink_skipped stat; got {recorded}"
        kind, bytes_saved, tokens_saved, detail = skipped[0]
        assert bytes_saved == 0
        assert tokens_saved == 0
        # Detail string includes the actual size and threshold so the bypass
        # histogram is queryable from the DB.
        assert "size=" in detail
        assert "threshold=" in detail

    def test_missing_file_does_not_record_skipped(self, tmp_path):
        """OSError from stat() falls through; no bypass stat is recorded."""
        from unittest.mock import patch

        from token_goat.hooks_read import _try_shrink_image

        # Ghost path: no file on disk.
        ghost = tmp_path / "ghost.jpg"
        recorded: list[tuple[str, int, int, str]] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail=""):
            recorded.append((kind, bytes_saved, tokens_saved, detail))

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            _try_shrink_image(str(ghost), {"file_path": str(ghost)})

        skipped = [r for r in recorded if r[0] == "image_shrink_skipped"]
        assert not skipped, (
            f"Missing file must not record image_shrink_skipped; got {recorded}"
        )

    def test_non_image_does_not_record_skipped(self, tmp_path):
        """Non-image paths short-circuit before any size or stat work."""
        from unittest.mock import patch

        from token_goat.hooks_read import _try_shrink_image

        txt = tmp_path / "notes.txt"
        txt.write_text("hello")
        recorded: list[tuple[str, int, int, str]] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail=""):
            recorded.append((kind, bytes_saved, tokens_saved, detail))

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            _try_shrink_image(str(txt), {"file_path": str(txt)})

        assert not recorded, (
            f"Non-image path must not record any image stats; got {recorded}"
        )
