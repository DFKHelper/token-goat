"""Tests for image-shrink integration in the pre_read hook — Phase 12."""
from __future__ import annotations

import random
from pathlib import Path

from token_goat import hooks_cli, image_shrink

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assert_continue(result: dict) -> None:
    """Assert continue:True, tolerating diagnostic fields added by dispatch."""
    assert result.get("continue") is True


def _make_large_jpeg(tmp_path: Path) -> Path:
    """Synthesize a >100 KB JPEG for hook tests."""
    from PIL import Image

    p = tmp_path / "hook_test_large.jpg"
    img = Image.new("RGB", (1600, 1200))
    pixels = [
        (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        for _ in range(1600 * 1200)
    ]
    img.putdata(pixels)
    img.save(p, "JPEG", quality=95)

    # Fall back to BMP-renamed-to-jpg if JPEG compression got too small
    if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
        img.save(p.with_suffix(".bmp"), "BMP")
        p.with_suffix(".bmp").rename(p)

    return p


def _make_small_jpeg(tmp_path: Path) -> Path:
    """Synthesize a tiny JPEG below threshold."""
    from PIL import Image

    p = tmp_path / "hook_test_small.jpg"
    img = Image.new("RGB", (32, 32), (100, 150, 200))
    img.save(p, "JPEG")
    return p


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

        assert result["continue"] is True
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

        assert result["continue"] is True
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

        assert result["continue"] is True
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
        assert result["continue"] is True
        # Non-existent image → should_shrink=False → falls through, no updatedInput
        hso = result.get("hookSpecificOutput", {})
        assert "updatedInput" not in hso
