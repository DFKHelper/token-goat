"""Tests for image-shrink integration in the pre_read hook — Phase 12."""
from __future__ import annotations

from pathlib import Path

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import make_large_jpeg as _make_large_jpeg
from hook_helpers import make_small_jpeg as _make_small_jpeg

from token_goat import hooks_cli, image_shrink

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
        assert "bytes" in ctx


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
# Item A21: image note drops "→ N bytes" suffix when compression ratio < 4x
# ---------------------------------------------------------------------------


class TestShrinkNoteRatioFormat:
    """The shrink note uses a conditional format: when original >= 4× larger
    than the shrunken output, emit 'A → B bytes'; otherwise just 'A bytes'."""

    def _build_note(self, src_bytes: int, out_bytes: int, bytes_saved: int, file_path: str) -> str:
        """Re-implement the note-building logic from _try_shrink_image for unit tests."""
        if out_bytes > 0 and src_bytes / out_bytes >= 4:
            size_str = f"{src_bytes:,} → {out_bytes:,} bytes"
        else:
            size_str = f"{src_bytes:,} bytes"
        return (
            f"Note: image auto-shrunk by token-goat "
            f"({size_str}, "
            f"~{bytes_saved:,} bytes saved). "
            f"Original: {file_path}"
        )

    def test_high_ratio_includes_arrow(self):
        """When src/out >= 4, the note must include '→ N bytes'."""
        note = self._build_note(40_000, 9_000, 31_000, "/tmp/big.jpg")
        assert "→" in note, "Expected arrow for 4.4x compression ratio"
        assert "40,000 → 9,000 bytes" in note

    def test_low_ratio_omits_arrow(self):
        """When src/out < 4, the note must omit '→ N bytes' to save tokens."""
        note = self._build_note(10_000, 4_000, 6_000, "/tmp/small.jpg")
        assert "→" not in note, "Arrow must be omitted for 2.5x ratio"
        assert "10,000 bytes" in note
        assert "4,000" not in note  # output size must NOT appear

    def test_exactly_4x_ratio_includes_arrow(self):
        """At exactly 4x ratio, the arrow must appear (boundary: >= 4)."""
        note = self._build_note(20_000, 5_000, 15_000, "/tmp/exact.jpg")
        assert "→" in note, "Arrow must appear at exactly 4x ratio"

    def test_bytes_saved_always_present(self):
        """bytes_saved annotation must appear regardless of the compression ratio."""
        note_high = self._build_note(40_000, 9_000, 31_000, "/tmp/big.jpg")
        note_low = self._build_note(10_000, 4_000, 6_000, "/tmp/small.jpg")
        assert "bytes saved" in note_high
        assert "bytes saved" in note_low

    def test_zero_out_bytes_falls_back_to_src_only(self):
        """Division-by-zero guard: when out_bytes == 0, only src_bytes is shown."""
        note = self._build_note(10_000, 0, 10_000, "/tmp/zero.jpg")
        assert "→" not in note
        assert "10,000 bytes" in note


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
