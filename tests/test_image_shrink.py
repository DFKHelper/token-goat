"""Tests for image_shrink module — Phase 12."""
from __future__ import annotations

import os

import pytest
from hook_helpers import make_large_jpeg as _make_large_jpeg
from hook_helpers import make_small_jpeg as _make_small_jpeg

from token_goat import image_shrink

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
        assert stats["orig_width"] > 0 and stats["orig_height"] > 0
        assert stats["out_width"] > 0 and stats["out_height"] > 0
        # Shrunken image must be no larger than MAX_LONG_EDGE on its long side
        assert max(stats["out_width"], stats["out_height"]) <= image_shrink.MAX_LONG_EDGE


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
    def test_large_rgb_png_becomes_lossy(self, tmp_data_dir, tmp_path):
        """Large RGB PNG (photo-like) collapses to a lossy format.

        The configured lossy format is WebP by default; JPEG is selectable via
        ``TOKEN_GOAT_IMAGE_FORMAT=jpeg``.  Either one is a correct outcome — the
        invariant the shrinker promises is "lossy compression, not PNG", since
        PNG would defeat the entire compression-ratio goal of this module.
        """
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
        assert result.suffix.lower() in (".webp", ".jpg"), (
            f"Expected lossy format (.webp or .jpg) for RGB PNG photo, got {result.suffix}"
        )

    def test_jpeg_fallback_via_env_var(self, tmp_data_dir, tmp_path, monkeypatch):
        """``TOKEN_GOAT_IMAGE_FORMAT=jpeg`` forces JPEG output even when WebP is the default."""
        import random

        from PIL import Image

        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "jpeg")

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
            f"Expected .jpg under TOKEN_GOAT_IMAGE_FORMAT=jpeg, got {result.suffix}"
        )


# ---------------------------------------------------------------------------
# 10b. WebP compression ratio benchmark — confirms WebP beats JPEG on
# screenshot/UI content (the realistic hot path) by a meaningful margin.
# ---------------------------------------------------------------------------

class TestWebpCompressionRatio:
    def test_webp_smaller_than_jpeg_on_screenshot_content(self, tmp_data_dir, tmp_path, monkeypatch):
        """Render a UI-like image, compress once as WebP and once as JPEG, and
        confirm WebP is at least 25% smaller.

        Real screenshots (large flat regions, sharp text edges, limited colour
        gamut) are exactly the workload WebP handles better than JPEG.  This
        test pins the minimum win at 25%; on the synthesised fixture below it
        is closer to 45%.  The test also doubles as a regression guard against
        accidentally raising ``WEBP_QUALITY`` to a value that erodes the win.
        """
        from PIL import Image, ImageDraw

        # Build a deterministic screenshot fixture: white background with
        # alternating tinted rows and text overlay — characteristic of a code
        # editor or chat UI capture.
        img = Image.new("RGB", (1600, 1200), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        for i in range(40):
            y = i * 28
            draw.rectangle([(20, y), (1580, y + 24)], fill=(245, 247, 250))
            draw.text((30, y + 4), "Lorem ipsum dolor sit amet, " * 6, fill=(20, 30, 40))
        for i in range(5):
            x = i * 320 + 20
            draw.rectangle([(x, 900), (x + 280, 1100)], fill=(50 + 30 * i, 100 + 20 * i, 200 - 20 * i))

        # Use BMP so the file is unambiguously larger than the shrink threshold
        # regardless of how well the rendered content happens to compress as PNG.
        # The pixel content is what we care about for the benchmark; the storage
        # format on disk is irrelevant once shrink() opens it.
        src = tmp_path / "screenshot.bmp"
        img.save(src, "BMP")
        assert src.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        # Compress under default (WebP)
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)
        webp_out = image_shrink.shrink(src)
        assert webp_out is not None
        assert webp_out.suffix.lower() == ".webp", (
            f"Expected .webp under default config, got {webp_out.suffix}"
        )
        webp_bytes = webp_out.stat().st_size

        # Force JPEG and re-shrink a fresh source so the cache key differs and
        # a fresh compression actually runs.  Flip one pixel so the content hash
        # changes — the rendered image is materially the same screenshot.
        src2 = tmp_path / "screenshot_for_jpeg.bmp"
        img.putpixel((0, 0), (1, 2, 3))
        img.save(src2, "BMP")

        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "jpeg")
        jpeg_out = image_shrink.shrink(src2)
        assert jpeg_out is not None
        assert jpeg_out.suffix.lower() == ".jpg", (
            f"Expected .jpg under TOKEN_GOAT_IMAGE_FORMAT=jpeg, got {jpeg_out.suffix}"
        )
        jpeg_bytes = jpeg_out.stat().st_size

        ratio = webp_bytes / jpeg_bytes
        assert ratio < 0.75, (
            f"WebP should be at least 25% smaller than JPEG on screenshot "
            f"content; got WebP={webp_bytes} JPEG={jpeg_bytes} ratio={ratio:.3f}"
        )


# ---------------------------------------------------------------------------
# 11. Token savings — shrinking a large image saves a meaningful token count
# ---------------------------------------------------------------------------

class TestTokenSavings:
    def test_large_jpeg_saves_meaningful_tokens(self, tmp_data_dir, tmp_path):
        """A 1600×1200 JPEG must yield ≥1000 vision tokens saved after shrinking.

        1600×1200 → Claude tokenizes at (1568×1176)÷750 ≈ 2459 tokens.
        Shrunken to 1024×768 → (1024×768)÷750 ≈ 1049 tokens.
        Expected savings ≈ 1410 tokens.
        """
        p = _make_large_jpeg(tmp_path)
        shrunken = image_shrink.shrink(p)
        assert shrunken is not None, "shrink() returned None — no output produced"

        stats = image_shrink.stats_for(p, shrunken)
        tokens_saved = max(0,
            image_shrink.vision_tokens(stats["orig_width"], stats["orig_height"])
            - image_shrink.vision_tokens(stats["out_width"], stats["out_height"])
        )

        assert tokens_saved >= 1000, (
            f"Expected ≥1000 vision tokens saved; got {tokens_saved} "
            f"(orig={stats['orig_width']}×{stats['orig_height']}, "
            f"out={stats['out_width']}×{stats['out_height']})"
        )
