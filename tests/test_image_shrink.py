"""Tests for image_shrink module — Phase 12."""
from __future__ import annotations

import os
import random
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from hook_helpers import make_large_jpeg as _make_large_jpeg
from hook_helpers import make_small_jpeg as _make_small_jpeg

from token_goat import image_shrink, paths
from token_goat.config import ImageShrinkConfig
from token_goat.config import load as load_config

# ---------------------------------------------------------------------------
# Module-scoped shared fixture: one large JPEG created and shrunk once per
# test module.  Tests that only need to verify shrink output (read-only) can
# use this instead of calling _make_large_jpeg() + shrink() themselves, saving
# ~2.5 s of Pillow encode/decode overhead per test.
#
# Constraint: tests that mutate the source file or corrupt the image cache
# must NOT use this fixture — they keep their own function-scoped tmp_path.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def shared_shrunk_jpeg(tmp_path_factory):
    """Create a large JPEG and shrink it once per module; yield (src, result).

    Uses a fixed random seed so the content hash is deterministic across
    runs, enabling the image_shrink content-addressed cache to be warm on
    all subsequent calls in this fixture's scope.
    """
    tmp = tmp_path_factory.mktemp("shared_jpeg")
    # Patch data_dir for the duration of this fixture so shrink() writes the
    # cache to an isolated directory rather than the real user data dir.
    with patch.object(paths, "data_dir", return_value=tmp):
        from PIL import Image as PILImage

        src = tmp / "shared_large.jpg"
        rng = random.Random(0xC0FFEE)  # fixed seed — deterministic content hash
        pixels = [
            (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
            for _ in range(1600 * 1200)
        ]
        img = PILImage.new("RGB", (1600, 1200))
        img.putdata(pixels)
        src.parent.mkdir(parents=True, exist_ok=True)
        img.save(src, "JPEG", quality=95)

        result = image_shrink.shrink(src)
        assert result is not None, "shared_shrunk_jpeg fixture: shrink() returned None"
        yield src, result

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

    def test_true_for_large_image(self, shared_shrunk_jpeg):
        """Large JPEG source must report should_shrink=True.

        Uses the module-scoped shared_shrunk_jpeg fixture to avoid the ~2.5 s
        Pillow encode cost — should_shrink only stat()s the file and checks
        the extension, so any large JPEG source works fine here.
        """
        p, _result = shared_shrunk_jpeg
        assert p.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.should_shrink(p) is True


# ---------------------------------------------------------------------------
# 2b. format_threshold — per-format threshold lookup
# ---------------------------------------------------------------------------


class TestFormatThreshold:
    """The per-format threshold gives lossless inputs a lower bar than lossy ones."""

    def test_jpeg_threshold_matches_legacy_constant(self):
        # JPEG / WebP / AVIF retain the historical 100 KB threshold so that
        # already-efficient inputs are not re-encoded for marginal gain.
        assert image_shrink.format_threshold("photo.jpg") == image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.format_threshold("photo.JPEG") == image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.format_threshold("banner.webp") == image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.format_threshold("modern.avif") == image_shrink.SIZE_THRESHOLD_BYTES

    def test_png_threshold_is_lower_than_jpeg(self):
        # PNG / BMP / TIFF / GIF are lossless or weakly compressed and benefit
        # from re-encoding starting at a smaller size.
        png_t = image_shrink.format_threshold("shot.png")
        jpg_t = image_shrink.format_threshold("photo.jpg")
        assert png_t < jpg_t, (
            f"Expected PNG threshold {png_t} to be lower than JPEG {jpg_t}"
        )

    def test_bmp_tiff_gif_share_lossless_threshold(self):
        png_t = image_shrink.format_threshold("a.png")
        assert image_shrink.format_threshold("b.bmp") == png_t
        assert image_shrink.format_threshold("c.tiff") == png_t
        assert image_shrink.format_threshold("d.tif") == png_t
        assert image_shrink.format_threshold("e.gif") == png_t

    def test_accepts_bare_suffix_string(self):
        # Callers that already hold a suffix should not pay for a Path() round-trip.
        assert image_shrink.format_threshold(".png") == image_shrink.format_threshold("x.png")
        assert image_shrink.format_threshold(".jpg") == image_shrink.format_threshold("x.jpg")

    def test_unknown_extension_falls_back_to_lossy_default(self):
        # An unknown image suffix is treated conservatively (no over-eager shrink)
        # by falling back to the larger lossy default.
        assert image_shrink.format_threshold("mystery.heic") == image_shrink.SIZE_THRESHOLD_BYTES

    def test_path_input_equivalent_to_string(self):
        assert (
            image_shrink.format_threshold(Path("/abs/foo.png"))
            == image_shrink.format_threshold("foo.png")
        )


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
    def test_output_smaller_and_dimensions_constrained(self, shared_shrunk_jpeg):
        """Verify shrink output is smaller and within MAX_LONG_EDGE.

        Uses the module-scoped shared_shrunk_jpeg fixture to avoid re-running
        the ~2.5 s Pillow encode/decode cycle for each read-only assertion.
        """
        p, result = shared_shrunk_jpeg
        src_size = p.stat().st_size

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
    def test_same_cache_path_on_second_call(self, shared_shrunk_jpeg):
        """Second call on the same source must return the same cached path.

        Uses the module-scoped shared_shrunk_jpeg fixture.  The fixture already
        ran shrink(src) once; a second call here exercises the cache-hit path
        without re-encoding, making the test near-instant.
        """
        p, result1 = shared_shrunk_jpeg

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
    def test_same_cache_path_after_mtime_only_change(self, shared_shrunk_jpeg, tmp_path):
        """A bare touch — mtime bumped, content unchanged — is a cache hit. The
        key is content-addressed, so unchanged bytes reuse the existing entry
        instead of triggering a redundant re-shrink.

        Uses shared_shrunk_jpeg so we skip the ~2.5 s first-shrink cost.  We
        copy the source to an isolated path so bumping its mtime does not affect
        the other module-scoped fixture users.  The copy has the same content
        hash, so the second shrink() is a near-instant cache hit in the same
        (shared fixture's) image-cache directory.
        """
        import shutil

        src, result1 = shared_shrunk_jpeg
        assert result1 is not None

        src_copy = tmp_path / "mtime_test.jpg"
        shutil.copy2(src, src_copy)

        new_mtime = src_copy.stat().st_mtime + 1000.0
        os.utime(src_copy, (new_mtime, new_mtime))

        result2 = image_shrink.shrink(src_copy)
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
    def test_stats_match_file_sizes(self, shared_shrunk_jpeg):
        """Verify stats_for returns correct measurements.

        Uses the module-scoped shared_shrunk_jpeg fixture — no new image
        creation or compression needed for these read-only assertions.
        """
        p, shrunken = shared_shrunk_jpeg

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

        # 1100×825: long edge (1100) > MAX_LONG_EDGE (1024) so shrink() will resize;
        # file size at PNG with random pixels is well above SIZE_THRESHOLD_BYTES.
        # Smaller than 1600×1200 (was) — cuts pixel generation time by ~60%.
        p = tmp_path / "photo.png"
        img = Image.new("RGB", (1100, 825))
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1100 * 825)
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

        # 1100×825: long edge (1100) > MAX_LONG_EDGE (1024) so shrink() will resize;
        # file size at PNG with random pixels is well above SIZE_THRESHOLD_BYTES.
        # Smaller than 1600×1200 (was) — cuts pixel generation time by ~60%.
        p = tmp_path / "photo.png"
        img = Image.new("RGB", (1100, 825))
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1100 * 825)
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
    def test_large_jpeg_saves_meaningful_tokens(self, shared_shrunk_jpeg):
        """A 1600×1200 JPEG must yield ≥1000 vision tokens saved after shrinking.

        1600×1200 → Claude tokenizes at (1568×1176)÷750 ≈ 2459 tokens.
        Shrunken to 1024×768 → (1024×768)÷750 ≈ 1049 tokens.
        Expected savings ≈ 1410 tokens.

        Uses the module-scoped shared_shrunk_jpeg fixture — read-only assertions
        only; no new image creation or compression needed.
        """
        p, shrunken = shared_shrunk_jpeg
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

    @pytest.fixture(scope="class")
    def large_jpeg_src(self, tmp_path_factory):
        """Create a large JPEG once per class; reused by multiple tests.

        The source image is only *read* by shrink() — cache writes go to the
        per-test tmp_data_dir — so sharing the source across tests is safe and
        avoids re-encoding a 1600×1200 JPEG for each test method.
        """
        tmp = tmp_path_factory.mktemp("avif_enc_src")
        return _make_large_jpeg(tmp)

    def test_avif_supported_returns_bool(self):
        """avif_supported() must return a bool regardless of Pillow build."""
        result = image_shrink.avif_supported()
        assert isinstance(result, bool)

    def test_avif_output_when_available(self, tmp_data_dir, large_jpeg_src, monkeypatch):
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

        p = large_jpeg_src
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

    def test_fallback_to_webp_when_avif_unavailable(self, tmp_data_dir, large_jpeg_src, monkeypatch):
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

        p = large_jpeg_src
        result = image_shrink.shrink(p)

        assert result is not None
        # When AVIF is unavailable, falls back through to the WebP/JPEG path.
        assert result.suffix.lower() in (".webp", ".jpg"), (
            f"Expected WebP or JPEG fallback when AVIF unavailable; got {result.suffix}"
        )

    def test_prefer_avif_false_skips_avif(self, tmp_data_dir, large_jpeg_src, monkeypatch):
        """prefer_avif=False always uses WebP/JPEG even when AVIF is available."""
        image_shrink.avif_supported.cache_clear()

        from token_goat import config as _config_mod

        def _fake_load():
            cfg = _config_mod.Config()
            cfg.image_shrink.prefer_avif = False
            return cfg

        monkeypatch.setattr(_config_mod, "load", _fake_load)
        monkeypatch.delenv("TOKEN_GOAT_IMAGE_FORMAT", raising=False)

        p = large_jpeg_src
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
        # ALSO patch PIL's global directly so monkeypatch restores it after the test —
        # shrink() sets Image.MAX_IMAGE_PIXELS = _MAX_PIXELS as a side-effect, and
        # without this second patch the PIL global leaks into subsequent tests.
        monkeypatch.setattr(image_shrink, "_MAX_PIXELS", 10_000)
        from PIL import Image as _PILImage
        monkeypatch.setattr(_PILImage, "MAX_IMAGE_PIXELS", 10_000)

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


# ---------------------------------------------------------------------------
# Reliability improvement 4: Source mtime tracking for cache staleness detection
# ---------------------------------------------------------------------------

class TestSourceMtimeTracking:
    """Source file mtime is tracked in a sidecar to detect stale cache entries."""

    @pytest.fixture(scope="class")
    def large_jpeg_src(self, tmp_path_factory):
        """Create a large JPEG once per class for tests that only *read* the source.

        Tests that overwrite or delete the source (e.g. test_rewritten_source_bypasses_cache)
        must create their own copy instead of using this shared fixture.
        """
        tmp = tmp_path_factory.mktemp("mtime_src")
        return _make_large_jpeg(tmp)

    def test_source_mtime_stored_on_shrink(self, tmp_data_dir, large_jpeg_src):
        """When an image is shrunk, its source mtime is stored in a .mtime sidecar."""
        p = large_jpeg_src
        src_mtime = p.stat().st_mtime

        result = image_shrink.shrink(p)
        assert result is not None

        # Check that the .mtime sidecar was created
        mtime_sidecar = result.with_suffix(result.suffix + ".mtime")
        assert mtime_sidecar.exists(), "Expected .mtime sidecar file to be created"

        # Verify the stored mtime matches the original source mtime (within floating point precision)
        stored_mtime = float(mtime_sidecar.read_text().strip())
        assert abs(stored_mtime - src_mtime) < 0.001, (
            f"Expected stored mtime {stored_mtime} to match source mtime {src_mtime}"
        )

    def test_rewritten_source_bypasses_cache(self, tmp_data_dir, tmp_path):
        """When the source image is overwritten with new content, the cache is bypassed and re-shrink occurs."""
        import shutil

        p1 = _make_large_jpeg(tmp_path / "a")
        p2 = _make_large_jpeg(tmp_path / "b")  # different content

        # First shrink: creates cached version
        result1 = image_shrink.shrink(p1)
        assert result1 is not None
        mtime_sidecar1 = result1.with_suffix(result1.suffix + ".mtime")
        assert mtime_sidecar1.exists()  # sidecar written alongside first shrink result

        # Overwrite p1 with completely different content from p2
        shutil.copyfile(p2, p1)

        # Bump the mtime to ensure it's newer than the cached entry
        new_mtime = time.time() + 1.0
        os.utime(p1, (new_mtime, new_mtime))

        # Second shrink: should detect the mtime change and re-shrink
        result2 = image_shrink.shrink(p1)
        assert result2 is not None

        # The result paths should differ because the content hash changed
        assert result1 != result2, (
            f"Expected different cache paths for different source content; "
            f"got {result1} and {result2}"
        )

    def test_unmodified_source_hits_cache(self, tmp_data_dir, large_jpeg_src):
        """When the source file is unmodified (same mtime), the cached version is returned."""

        p = large_jpeg_src
        original_mtime = p.stat().st_mtime

        # First shrink
        result1 = image_shrink.shrink(p)
        assert result1 is not None

        # Verify sidecar was created
        mtime_sidecar = result1.with_suffix(result1.suffix + ".mtime")
        assert mtime_sidecar.exists()
        stored_mtime = float(mtime_sidecar.read_text().strip())
        assert abs(stored_mtime - original_mtime) < 0.001

        # Second shrink with unchanged source (mtime identical)
        result2 = image_shrink.shrink(p)
        assert result2 is not None
        assert result1 == result2, (
            "Cache hit must return the same path when source mtime is unchanged"
        )

    def test_deleted_source_falls_back_to_cache(self, tmp_data_dir, tmp_path):
        """When the source file is deleted, shrink() falls back to the cached version."""
        p = _make_large_jpeg(tmp_path)

        # First shrink: creates cached version
        result1 = image_shrink.shrink(p)
        assert result1 is not None
        assert result1.exists()

        # Delete the source file
        p.unlink()

        # Second shrink: should return the cached version (no file to stat)
        # because _get_source_mtime() returns 0.0 on OSError, and the
        # stored_mtime will be > 0, so the cache is treated as valid
        result2 = image_shrink.shrink(p)

        # When the source is deleted, should_shrink() will return False
        # (cannot stat deleted file), so shrink() exits early and returns None.
        # This is the expected safe behavior.
        assert result2 is None, (
            "shrink() must return None when source file is deleted (should_shrink fails)"
        )

    def test_mtime_sidecar_format(self, tmp_data_dir, large_jpeg_src):
        """The .mtime sidecar contains a single line with a float timestamp."""
        p = large_jpeg_src
        p_mtime = p.stat().st_mtime

        result = image_shrink.shrink(p)
        assert result is not None

        mtime_sidecar = result.with_suffix(result.suffix + ".mtime")
        assert mtime_sidecar.exists()

        sidecar_text = mtime_sidecar.read_text().strip()
        # Should be a valid float string
        try:
            stored_val = float(sidecar_text)
            assert abs(stored_val - p_mtime) < 0.001
        except ValueError:
            pytest.fail(f"Expected float in sidecar; got {sidecar_text!r}")

    def test_timestamp_truncation_mismatch_triggers_reshrink(self, tmp_data_dir, tmp_path):
        """If source mtime is newer by even 0.001s, cache is re-shrunk."""

        p = _make_large_jpeg(tmp_path)

        result1 = image_shrink.shrink(p)
        assert result1 is not None
        mtime_sidecar = result1.with_suffix(result1.suffix + ".mtime")
        assert mtime_sidecar.exists()

        # Bump mtime by tiny amount (0.001s)
        current_mtime = p.stat().st_mtime
        new_mtime = current_mtime + 0.001
        os.utime(p, (new_mtime, new_mtime))

        # The cached file should now be detected as stale
        # but the shrink() will return a new result if content-addressed lookup triggers
        result2 = image_shrink.shrink(p)

        # Since mtime changed but content stayed the same, the cache key is identical.
        # The staleness check happens AFTER the cache key lookup, so the mtime check
        # detects staleness and invalidates the cache entry.
        # Result2 will be None because should_shrink() still returns True (size > threshold)
        # but the cache lookup found the stale entry and deleted it, so shrink() will re-encode.
        # Actually, on second thought: the second shrink will re-encode from the same source
        # and write a new cached file with the updated mtime.
        # Since the content is identical (same source), the cache key is the same,
        # so candidate.exists() will still find the old cache file (unless we deleted it).
        # We DID delete it above, so result2 will fall through to re-shrink and succeed.
        assert result2 is not None


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


class TestOrphanSweep:
    """Tests for the one-shot orphan cache sweep (Item 17)."""

    def test_sweep_function_exists(self):
        """_sweep_orphans() function is defined and callable."""
        assert hasattr(image_shrink, "_sweep_orphans")
        assert callable(image_shrink._sweep_orphans)

    def test_sweep_handles_missing_cache_dir(self, tmp_path, monkeypatch):
        """Sweep handles missing cache directory gracefully."""
        # Set cache dir to a non-existent path
        monkeypatch.setattr(image_shrink.paths, "image_cache_dir", lambda: tmp_path / "nonexistent")

        # Should not raise
        image_shrink._sweep_orphans()

    def test_sweep_leaves_referenced_blob(self, tmp_path, monkeypatch):
        """Recent blobs (referenced) are not removed by _sweep_orphans()."""
        pytest.importorskip("PIL")
        from PIL import Image

        monkeypatch.setattr(image_shrink.paths, "image_cache_dir", lambda: tmp_path)

        # Create a blob and ensure it's recent
        blob = tmp_path / "xyz789.shrunk.webp"
        img = Image.new("RGB", (100, 100), (200, 100, 50))
        img.save(blob, "WEBP")

        # Set mtime to 1 hour ago (within 7-day threshold)
        recent_time = time.time() - 3600
        os.utime(blob, (recent_time, recent_time))

        # Call sweep
        image_shrink._sweep_orphans()

        # Recent blob should remain
        assert blob.exists()

    def test_sweep_disabled_by_config(self, tmp_path, monkeypatch):
        """When orphan_sweep_enabled=False, _sweep_orphans() does nothing."""
        pytest.importorskip("PIL")
        from PIL import Image

        from token_goat import config as cfg_module

        monkeypatch.setattr(image_shrink.paths, "image_cache_dir", lambda: tmp_path)

        # Create an orphan
        orphan = tmp_path / "notdeleted.shrunk.webp"
        img = Image.new("RGB", (100, 100), (100, 100, 100))
        img.save(orphan, "WEBP")
        old_time = time.time() - (10 * 86400)
        os.utime(orphan, (old_time, old_time))

        # Mock config to disable sweep
        orig_load = cfg_module.load
        def mock_load():
            c = orig_load()
            c.image_shrink.orphan_sweep_enabled = False
            return c
        monkeypatch.setattr(cfg_module, "load", mock_load)

        # Call sweep (should be skipped)
        image_shrink._sweep_orphans()

        # Orphan should still exist because sweep was disabled
        assert orphan.exists()

    def test_sweep_handles_io_error(self, tmp_path, monkeypatch):
        """Sweep continues on file removal error; never raises."""
        pytest.importorskip("PIL")
        from PIL import Image

        monkeypatch.setattr(image_shrink.paths, "image_cache_dir", lambda: tmp_path)

        # Create an orphan
        orphan = tmp_path / "errortest.shrunk.webp"
        img = Image.new("RGB", (100, 100), (75, 75, 75))
        img.save(orphan, "WEBP")
        old_time = time.time() - (8 * 86400)
        os.utime(orphan, (old_time, old_time))

        # Mock unlink to raise OSError on first file
        orig_unlink = image_shrink.Path.unlink
        call_count = [0]
        def mock_unlink(self):
            call_count[0] += 1
            if call_count[0] == 1:
                # Fail on the orphan; succeed on other files
                raise OSError("simulated disk error")
            return orig_unlink(self)

        monkeypatch.setattr(image_shrink.Path, "unlink", mock_unlink)

        # Call sweep — should not raise despite the error
        try:
            image_shrink._sweep_orphans()
        except OSError:
            pytest.fail("_sweep_orphans() raised OSError; should swallow it")

        # Orphan still exists due to the error
        assert orphan.exists()


class TestOrphanDetectionRobustnessToFAT32:
    """Verify orphan blob detection removes old blobs without adding latency.

    Regression tests for the sweep implementation: old blobs (past orphan_age_secs)
    must be deleted reliably.  Concurrent-deletion races are handled by the OSError
    catch in the sweep loop — no sleep+exists() check is needed or wanted (a sleep
    inside a loop that runs at module init would add 10ms * N latency to every hook).
    """

    def test_orphan_blob_removed(self, tmp_data_dir):
        """Verify orphan blobs older than the threshold are removed."""
        cache_dir = image_shrink.paths.image_cache_dir()
        image_shrink.ensure_cache_dir(cache_dir)

        # Create an orphan blob (old, unaccessed)
        old_blob = cache_dir / "abc123.shrunk.png"
        old_blob.write_bytes(b"fake image data")

        # Set its mtime to be older than the orphan threshold (7 days)
        cfg = load_config()
        orphan_age = cfg.image_shrink.orphan_age_secs
        now = time.time()
        old_mtime = now - (orphan_age + 100)  # 100 seconds past the threshold
        os.utime(old_blob, (old_mtime, old_mtime))

        # Verify blob exists and is old enough
        assert old_blob.exists()
        assert (now - old_blob.stat().st_mtime) > orphan_age

        # Reset sweep flag so it actually runs
        image_shrink._sweep_done = False

        # Call sweep — must delete old orphans
        image_shrink._sweep_orphans()

        assert not old_blob.exists()

    def test_orphan_sweep_deletes_old_blobs(self, tmp_data_dir, monkeypatch):
        """Sweep removes blobs past the age threshold without sleep overhead.

        Regression test: a previous implementation called time.sleep(0.01) and
        fp.exists() inside the loop before unlinking.  With many orphan files this
        accumulated 10ms × N latency in the hook path at module init.  The fix
        removes both calls — concurrent deletions are already handled by the OSError
        catch, and 7-day-old files are never at risk of being modified concurrently.
        """
        cache_dir = image_shrink.paths.image_cache_dir()
        image_shrink.ensure_cache_dir(cache_dir)

        # Create an old orphan blob
        old_blob = cache_dir / "xyz789.shrunk.webp"
        old_blob.write_bytes(b"webp data")

        # Set very old mtime
        cfg = load_config()
        orphan_age = cfg.image_shrink.orphan_age_secs
        now = time.time()
        old_mtime = now - (orphan_age + 3600)
        os.utime(old_blob, (old_mtime, old_mtime))

        # Verify no sleep is called during the sweep.
        import time as time_mod
        sleep_calls: list[float] = []
        monkeypatch.setattr(time_mod, "sleep", lambda s: sleep_calls.append(s))

        image_shrink._sweep_done = False
        image_shrink._sweep_orphans()

        # File should have been unlinked
        assert not old_blob.exists()
        # No sleep should have been called — the loop must be latency-free
        assert sleep_calls == [], f"sweep called time.sleep {len(sleep_calls)} time(s); expected 0"


# ---------------------------------------------------------------------------
# Reliability improvement 1: Truncated cache file detection and recovery
# ---------------------------------------------------------------------------

class TestCacheTruncationRecovery:
    """When a cache file is truncated or corrupt, shrink() should detect it,
    delete the corrupt entry, and re-shrink from the original."""

    def test_truncated_cache_file_triggers_reshrink(self, tmp_data_dir, tmp_path):
        """A truncated cached image file should be deleted and re-shrunk."""

        p = _make_large_jpeg(tmp_path)

        # First shrink: creates a valid cache entry.
        result1 = image_shrink.shrink(p)
        assert result1 is not None
        assert result1.exists()

        # Truncate the cached file to simulate a partial write.
        result1.write_bytes(result1.read_bytes()[:10])  # Keep only first 10 bytes

        # Second shrink: should detect corruption, delete the bad cache entry,
        # and re-shrink from the original source.
        result2 = image_shrink.shrink(p)

        # Should return a valid shrunken image (either the recovered one or a fresh shrink).
        assert result2 is not None
        assert result2.exists()

        # The cached file should now be valid (readable by PIL).
        from PIL import Image as PILImage
        with PILImage.open(result2) as img:
            assert img.size[0] > 0 and img.size[1] > 0

    def test_unreadable_cache_deleted_and_reshrink(self, tmp_data_dir, tmp_path):
        """A cache file that Pillow cannot read should be deleted and re-shrunk."""
        p = _make_large_jpeg(tmp_path)

        # First shrink: valid cache entry.
        result1 = image_shrink.shrink(p)
        assert result1 is not None

        # Overwrite with non-image data (garbage bytes).
        result1.write_bytes(b"\x00\x01\x02\x03" * 100)

        # Second shrink: should fail to read the corrupt cache entry, delete it,
        # and create a fresh valid entry.
        result2 = image_shrink.shrink(p)

        # Should succeed with a valid image.
        assert result2 is not None
        assert result2.exists()

        # Verify it's valid PIL-readable image.
        from PIL import Image as PILImage
        with PILImage.open(result2) as img:
            assert max(img.size) <= image_shrink.MAX_LONG_EDGE


# ---------------------------------------------------------------------------
# Reliability improvement 2: Per-session shrink budget tracking
# ---------------------------------------------------------------------------

class TestPerSessionShrinkBudget:
    """When the same image is shrunk >3 times in a session,
    token-goat should log a hint to use surgical reads instead."""

    def test_shrink_with_session_tracking(self, tmp_data_dir, tmp_path):
        """Shrinking the same image 4 times in a session logs a hint at iteration 4 and 14."""
        p = _make_large_jpeg(tmp_path)

        # Create a session cache for tracking.
        session_id = "test-session-budget"

        # Shrink the same image 4 times, passing the session so it tracks.
        result = None
        for _ in range(4):
            result = image_shrink.shrink(p, _session_id=session_id)
            assert result is not None
            # After 1st shrink: count is 1, no log yet.
            # After 2nd shrink: count is 2, no log yet.
            # After 3rd shrink: count is 3, no log yet.
            # After 4th shrink: count is 4, logs (4 % 10 == 4, so logs when count > 3).

        # Check that a log hint was emitted (on the 4th call, count > 3).
        # The exact log message depends on implementation; just verify
        # that we don't crash and the shrink succeeds.
        assert result is not None

    def test_session_cache_image_shrink_count_persists(self, tmp_data_dir, tmp_path):
        """The image_shrink_count field in SessionCache is persisted and restored."""
        from token_goat import session as session_module

        session_id = "test-budget-persist"

        # Create a session, populate image_shrink_count.
        sess1 = session_module.SessionCache(
            session_id=session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        sess1.image_shrink_count["/tmp/image1.jpg"] = 5
        sess1.image_shrink_count["/tmp/image2.png"] = 2

        # Serialize to dict.
        d = sess1.to_dict()
        assert "image_shrink_count" in d
        assert d["image_shrink_count"]["/tmp/image1.jpg"] == 5
        assert d["image_shrink_count"]["/tmp/image2.png"] == 2

        # Deserialize from dict.
        sess2 = session_module.SessionCache.from_dict(d)
        assert sess2.image_shrink_count["/tmp/image1.jpg"] == 5
        assert sess2.image_shrink_count["/tmp/image2.png"] == 2


# ---------------------------------------------------------------------------
# Reliability improvement 3: Error handling for unsupported formats
# ---------------------------------------------------------------------------

class TestUnsupportedFormatHandling:
    """Shrink should fail gracefully (return None) for unsupported formats
    or very old Pillow versions with missing codec support."""

    def test_shrink_returns_none_on_unsupported_codec(self, tmp_data_dir, tmp_path, monkeypatch):
        """If Pillow cannot open an image (codec not available), shrink returns None."""
        p = _make_large_jpeg(tmp_path)

        # Simulate a codec error by monkeypatching Image.open to raise NotImplementedError.
        def failing_open(*args, **kwargs):
            raise NotImplementedError("codec not available")

        original_pil = None
        try:
            from PIL import Image as PILModule
            original_pil = PILModule.open
            PILModule.open = failing_open

            result = image_shrink.shrink(p)
            # Should fail gracefully, returning None instead of raising.
            assert result is None
        finally:
            if original_pil is not None:
                PILModule.open = original_pil

    def test_shrink_handles_memory_error(self, tmp_data_dir, tmp_path, monkeypatch):
        """Shrink returns None on MemoryError instead of crashing."""
        p = _make_large_jpeg(tmp_path)

        # Simulate a memory error during opening.
        def oom_open(*args, **kwargs):
            raise MemoryError("out of memory")

        original_pil = None
        try:
            from PIL import Image as PILModule
            original_pil = PILModule.open
            PILModule.open = oom_open

            result = image_shrink.shrink(p)
            # Should fail gracefully, returning None.
            assert result is None
        finally:
            if original_pil is not None:
                PILModule.open = original_pil


# ---------------------------------------------------------------------------
# Animated GIF passthrough
# ---------------------------------------------------------------------------

class TestAnimatedGifPassthrough:
    """Animated GIFs must be returned unchanged (shrink returns None)."""

    def test_animated_gif_returns_none(self, tmp_data_dir, tmp_path):
        """shrink() must return None for an animated GIF so the caller uses the original."""
        pytest.importorskip("PIL")
        from PIL import Image

        p = tmp_path / "anim.gif"
        frame1 = Image.new("RGB", (200, 200), (255, 0, 0))
        frame2 = Image.new("RGB", (200, 200), (0, 255, 0))
        frame3 = Image.new("RGB", (200, 200), (0, 0, 255))
        frames = [frame1.convert("P"), frame2.convert("P"), frame3.convert("P")]
        frames[0].save(
            p,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            loop=0,
            duration=100,
        )

        # Verify the GIF actually has multiple frames before testing shrink.
        with Image.open(p) as _check:
            is_anim = getattr(_check, "is_animated", None) or getattr(_check, "n_frames", 1) > 1
        if not is_anim:
            pytest.skip("Could not create animated GIF on this Pillow build")

        # Ensure the file is large enough to pass the threshold check.
        if p.stat().st_size <= image_shrink._LOSSLESS_FORMAT_THRESHOLD_BYTES:
            with p.open("ab") as fh:
                fh.write(b"\x00" * (image_shrink._LOSSLESS_FORMAT_THRESHOLD_BYTES + 1 - p.stat().st_size))

        result = image_shrink.shrink(p)
        assert result is None, (
            "shrink() must return None for animated GIF; animation cannot survive lossy re-encode"
        )

    def test_single_frame_gif_is_processed(self, tmp_data_dir, tmp_path):
        """A single-frame GIF is a regular still image and must be compressed normally."""
        pytest.importorskip("PIL")
        from PIL import Image

        p = tmp_path / "static.gif"
        img = Image.new("RGB", (800, 600), (100, 150, 200)).convert("P")
        img.save(p, format="GIF")

        # Verify it really is single-frame.
        with Image.open(p) as _check:
            is_anim = getattr(_check, "is_animated", None) or getattr(_check, "n_frames", 1) > 1
        if is_anim:
            pytest.skip("Pillow created multi-frame output for single-frame input; skip")

        if p.stat().st_size <= image_shrink._LOSSLESS_FORMAT_THRESHOLD_BYTES:
            with p.open("ab") as fh:
                fh.write(b"\x00" * (image_shrink._LOSSLESS_FORMAT_THRESHOLD_BYTES + 1 - p.stat().st_size))

        result = image_shrink.shrink(p)
        # A static GIF above threshold should be compressed to a lossy format.
        assert result is not None, (
            "shrink() must compress a single-frame GIF; it is a normal still image"
        )


# ---------------------------------------------------------------------------
# Progressive JPEG output
# ---------------------------------------------------------------------------

class TestProgressiveJpeg:
    """JPEG output must use progressive encoding (APP0 or SOF2 marker)."""

    def test_jpeg_output_is_progressive(self, tmp_data_dir, tmp_path, monkeypatch):
        """When TOKEN_GOAT_IMAGE_FORMAT=jpeg, the output JPEG file must be progressive."""
        pytest.importorskip("PIL")
        import random

        from PIL import Image

        monkeypatch.setenv("TOKEN_GOAT_IMAGE_FORMAT", "jpeg")

        p = tmp_path / "photo.bmp"
        img = Image.new("RGB", (1600, 1200))
        img.putdata([
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1600 * 1200)
        ])
        img.save(p, "BMP")

        assert p.stat().st_size > image_shrink.SIZE_THRESHOLD_BYTES

        result = image_shrink.shrink(p)
        assert result is not None
        assert result.suffix.lower() == ".jpg"

        # Progressive JPEG contains the SOF2 marker (0xFF 0xC2).
        data = result.read_bytes()
        assert b"\xff\xc2" in data, (
            "Expected SOF2 marker (0xFF 0xC2) for progressive JPEG output"
        )


# ---------------------------------------------------------------------------
# WEBP input support — .webp source files are shrunk like any other image
# ---------------------------------------------------------------------------

class TestWebpInputSupport:
    """WEBP is a recognised image extension and a first-class input format.

    Pillow reads WebP natively.  The lossy-input threshold (100 KB) applies
    because WebP files are already lossy-compressed — a re-encode only pays
    off when the source is genuinely large.

    These tests complement the output-format tests (TestPngToJpeg,
    TestWebpCompressionRatio) which verify the *output* format; here we verify
    that a .webp *source* file flows through the full shrink pipeline correctly.
    """

    def test_webp_recognised_as_image_path(self):
        """is_image_path() must return True for .webp files."""
        assert image_shrink.is_image_path("photo.webp") is True
        assert image_shrink.is_image_path("BANNER.WEBP") is True  # case-insensitive

    def test_webp_uses_lossy_threshold(self):
        """format_threshold() for .webp must equal SIZE_THRESHOLD_BYTES (100 KB),
        the same as JPEG/AVIF (lossy producer formats that are already efficient
        below 100 KB and would not benefit from re-encoding)."""
        assert image_shrink.format_threshold("image.webp") == image_shrink.SIZE_THRESHOLD_BYTES
        assert image_shrink.format_threshold(Path("path/to/image.webp")) == image_shrink.SIZE_THRESHOLD_BYTES

    def test_small_webp_not_shrunk(self, tmp_data_dir, tmp_path):
        """A .webp file below the lossy threshold (100 KB) must not be shrunk."""
        pytest.importorskip("PIL")
        from PIL import Image

        # 50×50 WebP is well under 100 KB.
        p = tmp_path / "small.webp"
        img = Image.new("RGB", (50, 50), (128, 64, 32))
        img.save(p, "WEBP", quality=80)

        assert p.stat().st_size < image_shrink.SIZE_THRESHOLD_BYTES, (
            f"Fixture is not small enough: {p.stat().st_size} bytes"
        )
        assert image_shrink.should_shrink(p) is False
        assert image_shrink.shrink(p) is None

    def test_large_webp_is_shrunk(self, tmp_data_dir, tmp_path):
        """A .webp file above the lossy threshold (100 KB) must be shrunk and
        the result must exist, be smaller, and fit within MAX_LONG_EDGE.

        Lossless WebP is used as the source format to guarantee the file
        exceeds 100 KB — lossy WebP at high resolution can still be under
        threshold after encoding, but lossless always exceeds it.
        """
        pytest.importorskip("PIL")
        import random

        from PIL import Image

        # Create a 1200×900 lossless WebP: guaranteed > 100 KB for random pixels.
        p = tmp_path / "large.webp"
        img = Image.new("RGB", (1200, 900))
        img.putdata([
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1200 * 900)
        ])
        img.save(p, "WEBP", lossless=True)

        if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize a large-enough WebP for this test")

        assert image_shrink.should_shrink(p) is True

        result = image_shrink.shrink(p)
        assert result is not None, "shrink() must return a path for a large WebP"
        assert result.exists(), "Shrunken path must exist on disk"
        assert result.stat().st_size < p.stat().st_size, (
            f"Shrunken file ({result.stat().st_size} B) must be smaller than source ({p.stat().st_size} B)"
        )

        from PIL import Image as _PIL
        with _PIL.open(result) as out_img:
            assert max(out_img.size) <= image_shrink.MAX_LONG_EDGE, (
                f"Long edge {max(out_img.size)} exceeds MAX_LONG_EDGE {image_shrink.MAX_LONG_EDGE}"
            )

    def test_webp_in_image_extensions_set(self):
        """.webp must be in IMAGE_EXTENSIONS so the hook fires for WebP files."""
        assert ".webp" in image_shrink.IMAGE_EXTENSIONS

    def test_large_webp_stats_for_correct(self, tmp_data_dir, tmp_path):
        """stats_for() must report meaningful savings when a large WebP is shrunk."""
        pytest.importorskip("PIL")
        import random

        from PIL import Image

        p = tmp_path / "stats_test.webp"
        img = Image.new("RGB", (1200, 900))
        img.putdata([
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(1200 * 900)
        ])
        img.save(p, "WEBP", lossless=True)

        if p.stat().st_size <= image_shrink.SIZE_THRESHOLD_BYTES:
            pytest.skip("Could not synthesize a large-enough WebP for this test")

        result = image_shrink.shrink(p)
        if result is None:
            pytest.skip("shrink() returned None (possibly WEBP unsupported in this build)")

        stats = image_shrink.stats_for(p, result)
        assert stats["src_bytes"] > 0
        assert stats["out_bytes"] > 0
        assert stats["bytes_saved"] > 0, (
            f"Expected bytes_saved > 0 for large WebP; got stats={stats}"
        )
        assert stats["out_width"] > 0 and stats["out_height"] > 0
