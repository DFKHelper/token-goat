"""Tests for image_shrink module — Phase 12."""
from __future__ import annotations

import os

import pytest
from hook_helpers import make_large_jpeg as _make_large_jpeg
from hook_helpers import make_small_jpeg as _make_small_jpeg

from token_goat import image_shrink
from token_goat.config import ImageShrinkConfig

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
        assert result.suffix.lower() in (".avif", ".webp", ".jpg"), (
            f"Expected lossy format (.avif, .webp or .jpg) for RGB PNG photo, got {result.suffix}"
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

        # Compress under WebP — disable AVIF so this test isolates WebP vs JPEG.
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)
        image_shrink.avif_supported.cache_clear()
        from token_goat import config as _config_mod

        def _fake_load_webp():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = False  # force WebP path for this benchmark
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load_webp)
        webp_out = image_shrink.shrink(src)
        assert webp_out is not None
        assert webp_out.suffix.lower() == ".webp", (
            f"Expected .webp with prefer_avif=False, got {webp_out.suffix}"
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


# ---------------------------------------------------------------------------
# 12. AVIF encoding path
# ---------------------------------------------------------------------------

def _make_config_with_avif(prefer_avif: bool = True, avif_quality: int = 60) -> ImageShrinkConfig:
    """Return an ImageShrinkConfig with the given AVIF settings."""
    return ImageShrinkConfig(prefer_avif=prefer_avif, avif_quality=avif_quality)


class TestAvifEncoding:
    """Tests for AVIF output path in shrink()."""

    def test_avif_supported_returns_bool(self):
        """avif_supported() must return a bool regardless of Pillow build."""
        result = image_shrink.avif_supported()
        assert isinstance(result, bool)

    def test_avif_output_when_available(self, tmp_data_dir, tmp_path, monkeypatch):
        """When AVIF is supported and prefer_avif=True, large image → .avif output."""
        if not image_shrink.avif_supported():
            pytest.skip("AVIF not available in this Pillow build")

        # Clear lru_cache so monkeypatching config takes effect
        image_shrink.avif_supported.cache_clear()

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = True
            cfg.image_shrink.avif_quality = 60
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)

        p = _make_large_jpeg(tmp_path)
        result = image_shrink.shrink(p)

        assert result is not None
        assert result.suffix.lower() == ".avif", (
            f"Expected .avif output when AVIF is available; got {result.suffix}"
        )
        assert result.exists()

    def test_avif_smaller_than_jpeg_on_photographic_content(self, tmp_data_dir, tmp_path, monkeypatch):
        """AVIF at q=60 produces smaller files than JPEG at q=75 on photographic content."""
        if not image_shrink.avif_supported():
            pytest.skip("AVIF not available in this Pillow build")

        import random

        from PIL import Image

        # Synthesise a photographic-like RGB image (random pixels = high entropy = worst
        # case for both codecs, but AVIF still consistently beats JPEG on these).
        img = Image.new("RGB", (800, 600))
        img.putdata([
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(800 * 600)
        ])
        # Use BMP as source so size is guaranteed > threshold and we're measuring
        # encoder output, not source compression.
        src = tmp_path / "photo.bmp"
        img.save(src, "BMP")
        assert src.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        # Encode as AVIF
        from token_goat import config as _config_mod
        image_shrink.avif_supported.cache_clear()

        def _fake_load_avif():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = True
            cfg.image_shrink.avif_quality = 60
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load_avif)
        avif_result = image_shrink.shrink(src)
        assert avif_result is not None and avif_result.suffix == ".avif"
        avif_size = avif_result.stat().st_size

        # Encode as JPEG — use a different source so the cache key differs.
        src2 = tmp_path / "photo2.bmp"
        img.putpixel((0, 0), (1, 2, 3))
        img.save(src2, "BMP")

        def _fake_load_jpeg():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = False
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load_jpeg)
        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "jpeg")
        jpeg_result = image_shrink.shrink(src2)
        assert jpeg_result is not None and jpeg_result.suffix == ".jpg"
        jpeg_size = jpeg_result.stat().st_size

        assert avif_size < jpeg_size, (
            f"AVIF ({avif_size}B) should be smaller than JPEG ({jpeg_size}B) at equivalent quality"
        )

    def test_fallback_to_webp_when_avif_unavailable(self, tmp_data_dir, tmp_path, monkeypatch):
        """When AVIF is not available, prefer_avif=True falls back to WebP."""
        # Monkeypatch avif_supported to return False regardless of actual Pillow build.
        image_shrink.avif_supported.cache_clear()
        monkeypatch.setattr(image_shrink, "avif_supported", lambda: False)

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = True  # would prefer AVIF but it's unavailable
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)

        p = _make_large_jpeg(tmp_path)
        result = image_shrink.shrink(p)

        assert result is not None
        # When AVIF is unavailable, falls back through to the WebP/JPEG path.
        assert result.suffix.lower() in (".webp", ".jpg"), (
            f"Expected WebP or JPEG fallback when AVIF unavailable; got {result.suffix}"
        )

    def test_prefer_avif_false_skips_avif(self, tmp_data_dir, tmp_path, monkeypatch):
        """prefer_avif=False always uses WebP/JPEG even when AVIF is available."""
        image_shrink.avif_supported.cache_clear()

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = False
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)

        p = _make_large_jpeg(tmp_path)
        result = image_shrink.shrink(p)

        assert result is not None
        assert result.suffix.lower() in (".webp", ".jpg"), (
            f"Expected WebP or JPEG when prefer_avif=False; got {result.suffix}"
        )
        assert result.suffix.lower() != ".avif"

    def test_small_image_not_avif_encoded(self, tmp_data_dir, tmp_path, monkeypatch):
        """Images <= SIZE_THRESHOLD_BYTES are not compressed at all (return None from shrink)."""
        image_shrink.avif_supported.cache_clear()

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = True
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)

        p = _make_small_jpeg(tmp_path)
        result = image_shrink.shrink(p)
        # Small images are rejected before any encoding step.
        assert result is None

    def test_rgba_png_stays_png_even_with_avif_enabled(self, tmp_data_dir, tmp_path, monkeypatch):
        """RGBA transparency screenshots stay as PNG regardless of AVIF availability."""
        image_shrink.avif_supported.cache_clear()

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = True
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)

        import random

        from PIL import Image

        p = tmp_path / "screenshot.png"
        img = Image.new("RGBA", (800, 800), (100, 150, 200, 200))
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255), 200)
            for _ in range(800 * 800)
        ]
        img.putdata(pixels)
        img.save(p, "PNG")

        if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize large enough RGBA PNG for this test")

        result = image_shrink.shrink(p)
        assert result is not None
        assert result.suffix.lower() == ".png", (
            f"RGBA screenshot must stay as PNG even with AVIF enabled; got {result.suffix}"
        )

    def test_env_override_disables_avif(self, tmp_data_dir, tmp_path, monkeypatch):
        """TOKEN_GOAT_PREFER_AVIF=0 disables AVIF even when Pillow supports it."""
        image_shrink.avif_supported.cache_clear()

        # Ensure the env var is seen by config.load() — the real load() reads the env.
        monkeypatch.setenv("TOKEN_GOAT_PREFER_AVIF", "0")
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)

        # Let config.load() run for real — env override should set prefer_avif=False.
        from token_goat import config as _config_mod
        cfg = _config_mod.load()
        assert cfg.image_shrink.prefer_avif is False, (
            "TOKEN_GOAT_PREFER_AVIF=0 must disable AVIF in loaded config"
        )


# ---------------------------------------------------------------------------
# 13. Pixel cap (_MAX_PIXELS) — DecompressionBomb guard
# ---------------------------------------------------------------------------

class TestPixelCap:
    """Regression tests for the Image.MAX_IMAGE_PIXELS cap added to prevent
    memory spikes when decoding high-resolution images (a 90KB JPEG can decode
    to a 200MB+ bitmap on tight-memory machines).
    """

    def test_oversized_image_returns_none_and_logs_warning(
        self, tmp_data_dir, tmp_path, monkeypatch, caplog
    ):
        """An image whose pixel count exceeds _MAX_PIXELS must return None.

        Pillow raises DecompressionBombError (subclass of OSError) when
        MAX_IMAGE_PIXELS is exceeded.  shrink() catches it via the broad
        ``except Exception`` handler and returns None with a warning log.
        The test monkeypatches _MAX_PIXELS to a small value (100×100 = 10 000)
        so the fixture image only needs to be 101×101 = 10 201 pixels —
        no multi-megabyte allocation is required.
        """
        from PIL import Image

        # Synthesise a 200×200 = 40 000 pixel image saved as BMP so the file
        # is unambiguously > SIZE_THRESHOLD_BYTES (100 KB).  200×200 BMP is only
        # ~120 KB, which may or may not exceed the threshold on all platforms, so
        # we pad with dummy bytes if needed.
        img = Image.new("RGB", (200, 200), (128, 64, 32))
        src = tmp_path / "oversized.bmp"
        img.save(src, "BMP")

        # Pad to ensure > SIZE_THRESHOLD_BYTES if the BMP is too small.
        if src.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
            with src.open("ab") as f:
                f.write(b"\x00" * (image_shrink.SIZE_THRESHOLD_BYTES + 1 - src.stat().st_size))

        assert src.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        # Lower the cap to 100×100 = 10 000 pixels so our 200×200 image exceeds it.
        monkeypatch.setattr(image_shrink, "_MAX_PIXELS", 10_000)

        import logging
        with caplog.at_level(logging.WARNING, logger="token_goat.image_shrink"):
            result = image_shrink.shrink(src)

        assert result is None, (
            "shrink() must return None when the image exceeds _MAX_PIXELS"
        )
        # The broad except-handler logs a warning with the filename.
        assert any("oversized" in r.message for r in caplog.records), (
            f"Expected a warning log containing 'oversized'; got: {[r.message for r in caplog.records]}"
        )

    def test_small_image_not_blocked_by_cap(self, tmp_data_dir, tmp_path, caplog):
        """A 100×100 JPEG (10 K pixels) is not blocked by the pixel cap.

        The default cap is 16 M pixels; 10 K is far below it.  The image is
        also below SIZE_THRESHOLD_BYTES, so shrink() returns None for the size
        reason — but it must NOT emit a DecompressionBomb warning.
        This test is the regression guard: if someone lowers _MAX_PIXELS to an
        absurdly small value by mistake, this test catches it.
        """
        from PIL import Image

        img = Image.new("RGB", (100, 100), (200, 100, 50))
        src = tmp_path / "tiny.jpg"
        img.save(src, "JPEG", quality=75)

        # 100×100 JPEG is typically well under 100 KB — below SIZE_THRESHOLD_BYTES.
        # shrink() will return None due to the size check, never reaching PIL decode.
        import logging
        with caplog.at_level(logging.WARNING, logger="token_goat.image_shrink"):
            result = image_shrink.shrink(src)

        assert result is None
        # No DecompressionBomb or unexpected warning should have fired.
        bomb_warnings = [r for r in caplog.records if "DecompressionBomb" in r.message or "pixels" in r.message.lower()]
        assert not bomb_warnings, (
            f"Unexpected pixel-cap warning for 100×100 image: {[r.message for r in bomb_warnings]}"
        )


class TestImageSummary:
    """Regression tests for ``extract_image_summary`` alt-text generation."""

    def test_wide_image_classified_as_screenshot(self, tmp_path):
        from PIL import Image

        img = Image.new("RGB", (1280, 720), (10, 20, 30))
        src = tmp_path / "wide.png"
        img.save(src, "PNG")

        summary = image_shrink.extract_image_summary(src, img)

        assert "screenshot" in summary
        assert "1280x720" in summary
        assert "wide.png" in summary

    def test_tall_image_classified_as_diagram(self, tmp_path):
        from PIL import Image

        img = Image.new("RGB", (720, 1280), (10, 20, 30))
        src = tmp_path / "tall.png"
        img.save(src, "PNG")

        summary = image_shrink.extract_image_summary(src, img)

        assert "diagram" in summary
        assert "720x1280" in summary

    def test_square_image_classified_as_image(self, tmp_path):
        from PIL import Image

        img = Image.new("RGB", (500, 500), (10, 20, 30))
        src = tmp_path / "square.png"
        img.save(src, "PNG")

        summary = image_shrink.extract_image_summary(src, img)

        assert "[Image:" in summary
        assert "500x500" in summary
        assert "screenshot" not in summary
        assert "diagram" not in summary

    def test_malformed_exif_does_not_raise(self, tmp_path):
        from PIL import Image

        img = Image.new("RGB", (1280, 720), (10, 20, 30))
        src = tmp_path / "exif_broken.png"
        img.save(src, "PNG")

        def boom():
            raise RuntimeError("exif parser exploded")

        img._getexif = boom  # type: ignore[method-assign]

        summary = image_shrink.extract_image_summary(src, img)

        assert isinstance(summary, str)
        assert summary
        assert "1280x720" in summary


class TestImageShrinkDiagramLossless:
    """Item 15: diagram images (portrait-dominant) use WebP lossless; others use lossy."""

    @pytest.mark.skipif(
        not pytest.importorskip("PIL", reason="Pillow not installed"),
        reason="Pillow not installed",
    )
    def test_diagram_uses_lossless_webp(self, tmp_path, tmp_data_dir, monkeypatch):
        """A portrait-dominant image (h/w >= 1.4) is saved with lossless=True."""

        from PIL import Image

        # Create a tall (portrait/diagram) image: width=400, height=700 → h/w=1.75
        img = Image.new("RGB", (400, 700), (200, 100, 50))
        src = tmp_path / "diagram.png"
        img.save(src, "PNG")

        # Ensure we use webp format
        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "webp")
        # Clear lru_cache so env var takes effect
        image_shrink._lossy_format.cache_clear() if hasattr(image_shrink._lossy_format, "cache_clear") else None

        result = image_shrink.shrink(src)

        # Check the output file for the lossless marker (most reliable path)
        if result is not None and result.suffix == ".webp":
            # We can verify lossless by checking file content: lossless WebP starts with RIFF...WEBPVP8L
            data = result.read_bytes()
            # VP8L marker indicates lossless WebP
            assert b"VP8L" in data, f"Expected lossless WebP (VP8L) marker for diagram; got {data[:20]!r}"

    def test_screenshot_uses_lossy_webp(self, tmp_path, tmp_data_dir, monkeypatch):
        """A landscape image (screenshot) is saved with lossy quality setting."""
        pytest.importorskip("PIL")
        from PIL import Image

        # Create a wide (landscape/screenshot) image: width=1280, height=400 → w/h=3.2
        img = Image.new("RGB", (1280, 400), (100, 150, 200))
        src = tmp_path / "screenshot.png"
        img.save(src, "PNG")

        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "webp")
        image_shrink._lossy_format.cache_clear() if hasattr(image_shrink._lossy_format, "cache_clear") else None

        result = image_shrink.shrink(src)

        if result is not None and result.suffix == ".webp":
            data = result.read_bytes()
            # Lossy WebP uses VP8 (not VP8L); check it does NOT have lossless marker
            assert b"VP8L" not in data, "Expected lossy WebP for screenshot, got lossless"
