"""Tests for image_shrink module — Phase 12."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from tokenwise import image_shrink

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_image(path: Path, width: int, height: int, mode: str = "RGB") -> Path:
    """Create a synthetic image at *path* using Pillow."""
    import random

    from PIL import Image

    img = Image.new(mode, (width, height))
    if mode == "RGB":
        # Fill with random pixel data so it's genuinely large when uncompressed
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(width * height)
        ]
        img.putdata(pixels)
    elif mode == "RGBA":
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255), 200)
            for _ in range(width * height)
        ]
        img.putdata(pixels)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Save as JPEG for RGB (high quality to get a large file), PNG for RGBA
    if mode == "RGB":
        img.save(path, "JPEG", quality=95)
    else:
        img.save(path, "PNG")
    return path


def _make_large_jpeg(tmp_path: Path) -> Path:
    """Create a synthetic >100 KB JPEG (1600×1200 random colors)."""
    p = tmp_path / "big_photo.jpg"
    _make_image(p, 1600, 1200, mode="RGB")
    # Ensure it's actually >100 KB; if not, recreate with less compression
    if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
        import random

        from PIL import Image
        img = Image.new("RGB", (1600, 1200))
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1600 * 1200)
        ]
        img.putdata(pixels)
        img.save(p, "BMP")  # BMP is always large
        p = p.with_suffix(".bmp")
        # rename to jpg for the test
        dest = tmp_path / "big_photo_bmp.jpg"
        p.rename(dest)
        p = dest
    return p


def _make_small_jpeg(tmp_path: Path) -> Path:
    """Create a synthetic <100 KB JPEG (50×50)."""
    p = tmp_path / "tiny.jpg"
    _make_image(p, 50, 50, mode="RGB")
    return p


# ---------------------------------------------------------------------------
# 1. is_image_path
# ---------------------------------------------------------------------------

class TestIsImagePath:
    def test_recognizes_png(self):
        assert image_shrink.is_image_path("photo.png") is True

    def test_recognizes_jpg(self):
        assert image_shrink.is_image_path("photo.jpg") is True

    def test_recognizes_jpeg(self):
        assert image_shrink.is_image_path("photo.jpeg") is True

    def test_recognizes_webp(self):
        assert image_shrink.is_image_path("banner.webp") is True

    def test_rejects_txt(self):
        assert image_shrink.is_image_path("notes.txt") is False

    def test_rejects_md(self):
        assert image_shrink.is_image_path("README.md") is False

    def test_rejects_py(self):
        assert image_shrink.is_image_path("app.py") is False

    def test_case_insensitive(self):
        assert image_shrink.is_image_path("PHOTO.PNG") is True
        assert image_shrink.is_image_path("PHOTO.JPG") is True


# ---------------------------------------------------------------------------
# 2 & 3. should_shrink
# ---------------------------------------------------------------------------

class TestShouldShrink:
    def test_false_for_non_image(self, tmp_path):
        p = tmp_path / "file.txt"
        p.write_text("hello")
        assert image_shrink.should_shrink(p) is False

    def test_false_for_missing_file(self, tmp_path):
        p = tmp_path / "ghost.png"
        assert image_shrink.should_shrink(p) is False

    def test_false_for_small_image(self, tmp_path):
        p = _make_small_jpeg(tmp_path)
        assert p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.should_shrink(p) is False

    def test_true_for_large_image(self, tmp_path):
        p = _make_large_jpeg(tmp_path)
        assert p.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.should_shrink(p) is True


# ---------------------------------------------------------------------------
# 4. shrink returns None for small image
# ---------------------------------------------------------------------------

class TestShrinkSmall:
    def test_none_for_small(self, tmp_data_dir, tmp_path):
        p = _make_small_jpeg(tmp_path)
        result = image_shrink.shrink(p)
        assert result is None


# ---------------------------------------------------------------------------
# 5. shrink produces valid output for large JPEG
# ---------------------------------------------------------------------------

class TestShrinkLargeJpeg:
    def test_output_smaller_and_dimensions_constrained(self, tmp_data_dir, tmp_path):
        p = _make_large_jpeg(tmp_path)
        src_size = p.stat().st_size

        result = image_shrink.shrink(p)

        assert result is not None, "Expected a shrunken output"
        assert result.exists(), "Shrunken path must exist on disk"
        assert result.stat().st_size < src_size, "Shrunken image must be smaller"

        from PIL import Image
        with Image.open(result) as img:
            w, h = img.size
            assert max(w, h) <= image_shrink.MAX_LONG_EDGE, (
                f"Long edge {max(w, h)} exceeds {image_shrink.MAX_LONG_EDGE}"
            )


# ---------------------------------------------------------------------------
# 6. shrink is idempotent — same cache path returned on second call
# ---------------------------------------------------------------------------

class TestShrinkIdempotent:
    def test_same_cache_path_on_second_call(self, tmp_data_dir, tmp_path):
        p = _make_large_jpeg(tmp_path)

        result1 = image_shrink.shrink(p)
        result2 = image_shrink.shrink(p)

        assert result1 is not None
        assert result2 is not None
        assert result1 == result2, "Second call must return same cached path"

    def test_identical_content_different_paths_share_cache(self, tmp_data_dir, tmp_path):
        """The same image staged under two different filenames — exactly what
        Claude Code does when a prompt references one image more than once, or
        re-uses an image across prompts — is shrunk once and shares a single
        cache entry. The cache key is content-addressed, so the path differs but
        the bytes are identical."""
        import shutil

        p1 = _make_large_jpeg(tmp_path)
        p2 = tmp_path / "staged_copy.jpg"
        shutil.copyfile(p1, p2)

        result1 = image_shrink.shrink(p1)
        result2 = image_shrink.shrink(p2)

        assert result1 is not None
        assert result2 is not None
        assert result1 == result2, "identical content must map to one cache entry"


# ---------------------------------------------------------------------------
# 7. Cache invalidation on source change
# ---------------------------------------------------------------------------

class TestCacheInvalidation:
    def test_same_cache_path_after_mtime_only_change(self, tmp_data_dir, tmp_path):
        """A bare touch — mtime bumped, content unchanged — is a cache hit. The
        key is content-addressed, so unchanged bytes reuse the existing entry
        instead of triggering a redundant re-shrink."""
        p = _make_large_jpeg(tmp_path)

        result1 = image_shrink.shrink(p)
        assert result1 is not None

        new_mtime = p.stat().st_mtime + 1000.0
        os.utime(p, (new_mtime, new_mtime))

        result2 = image_shrink.shrink(p)
        assert result2 is not None
        assert result1 == result2, "mtime-only change must still hit the cache"

    def test_new_cache_path_after_content_change(self, tmp_data_dir, tmp_path):
        """Changing the image's actual content invalidates the cache entry."""
        import shutil

        p1 = _make_large_jpeg(tmp_path / "a")
        p2 = _make_large_jpeg(tmp_path / "b")  # different random pixel data

        result1 = image_shrink.shrink(p1)
        assert result1 is not None

        # Overwrite p1's bytes with genuinely different content.
        shutil.copyfile(p2, p1)

        result2 = image_shrink.shrink(p1)
        assert result2 is not None
        assert result1 != result2, "content change must produce a new cache path"


# ---------------------------------------------------------------------------
# 8. stats_for reports correct sizes
# ---------------------------------------------------------------------------

class TestStatsFor:
    def test_stats_match_file_sizes(self, tmp_data_dir, tmp_path):
        p = _make_large_jpeg(tmp_path)
        shrunken = image_shrink.shrink(p)
        assert shrunken is not None

        stats = image_shrink.stats_for(p, shrunken)

        assert stats["src_bytes"] == p.stat().st_size
        assert stats["out_bytes"] == shrunken.stat().st_size
        assert stats["bytes_saved"] == max(0, stats["src_bytes"] - stats["out_bytes"])
        assert stats["bytes_saved"] > 0


# ---------------------------------------------------------------------------
# 9. PNG with alpha preserved as PNG
# ---------------------------------------------------------------------------

class TestPngWithAlpha:
    def test_rgba_screenshot_kept_as_png(self, tmp_data_dir, tmp_path):
        """RGBA PNG smaller than 1500px → screenshot heuristic → saved as PNG."""
        from PIL import Image

        p = tmp_path / "screenshot.png"
        # Create a small RGBA image (128×128) that will be classified as screenshot
        img = Image.new("RGBA", (128, 128), (200, 200, 200, 200))
        img.save(p, "PNG")

        # Make it > 100 KB by padding file if needed
        data = p.read_bytes()
        if len(data) <= image_shrink.SIZE_THRESHOLD_BYTES:
            # Pad with a large random payload in another file, then recreate
            # Instead, create a genuinely large RGBA image (800×800)
            img2 = Image.new("RGBA", (800, 800), (100, 150, 200, 200))
            import random
            pixels = [
                (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255), 200)
                for _ in range(800 * 800)
            ]
            img2.putdata(pixels)
            img2.save(p, "PNG")

        if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough RGBA PNG for this test")

        result = image_shrink.shrink(p)
        assert result is not None
        assert result.suffix.lower() == ".png", (
            f"Expected .png for RGBA screenshot, got {result.suffix}"
        )

        # Verify it's actually readable as PNG with alpha
        with Image.open(result) as out_img:
            assert out_img.mode in ("RGBA", "LA", "PA"), (
                f"Expected alpha-capable mode, got {out_img.mode}"
            )


# ---------------------------------------------------------------------------
# 10. PNG without alpha → JPEG conversion
# ---------------------------------------------------------------------------

class TestPngToJpeg:
    def test_large_rgb_png_becomes_jpeg(self, tmp_data_dir, tmp_path):
        """Large RGB PNG (photo-like) → JPEG output."""
        import random

        from PIL import Image

        p = tmp_path / "photo.png"
        img = Image.new("RGB", (1600, 1200))
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1600 * 1200)
        ]
        img.putdata(pixels)
        img.save(p, "PNG")

        assert p.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        result = image_shrink.shrink(p)
        assert result is not None
        assert result.suffix.lower() == ".jpg", (
            f"Expected .jpg for RGB PNG photo, got {result.suffix}"
        )


# ---------------------------------------------------------------------------
# 11. Token savings — shrinking a large image saves a meaningful token count
# ---------------------------------------------------------------------------

class TestTokenSavings:
    # Same formula as hooks_cli.py: 1 token per 4 bytes of base64-encoded image data
    _BYTES_PER_TOKEN = 4

    def test_large_jpeg_saves_meaningful_tokens(self, tmp_data_dir, tmp_path):
        """A 1600×1200 JPEG must yield ≥500 tokens saved after shrinking."""
        p = _make_large_jpeg(tmp_path)
        shrunken = image_shrink.shrink(p)
        assert shrunken is not None, "shrink() returned None — no output produced"

        stats = image_shrink.stats_for(p, shrunken)
        tokens_saved = stats["bytes_saved"] // self._BYTES_PER_TOKEN

        assert tokens_saved >= 500, (
            f"Expected ≥500 tokens saved; got {tokens_saved} "
            f"(src={stats['src_bytes']} B, out={stats['out_bytes']} B, "
            f"saved={stats['bytes_saved']} B)"
        )
