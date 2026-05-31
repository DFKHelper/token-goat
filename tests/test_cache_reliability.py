"""Reliability tests for image_shrink, web_cache, webfetch, and cache_common.

Covers:
- image_shrink: disk-full detection (low free space skips shrink)
- image_shrink: ENOSPC on write returns None without crashing
- image_shrink: corrupt cache entry triggers re-shrink (existing feature, regression guard)
- web_cache: orphan sidecar (meta without body) treated as cache miss
- web_cache: write order — body always before meta
- webfetch: TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS env var is respected
- cache_common: concurrent eviction race — FileNotFoundError on unlink is silent
"""
from __future__ import annotations

import errno
import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from token_goat import image_shrink, web_cache
from token_goat.cache_common import evict_cache_dir

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cache_entry(cache_dir: Path, output_id: str, body: str = "hello") -> tuple[Path, Path]:
    """Write a valid body + sidecar pair into *cache_dir*."""
    body_path = cache_dir / f"{output_id}.txt"
    sidecar_path = cache_dir / f"{output_id}.json"
    body_path.write_text(body, encoding="utf-8")
    sidecar_path.write_text(json.dumps({"output_id": output_id}), encoding="utf-8")
    return body_path, sidecar_path


def _make_valid_output_id() -> str:
    """Return a valid cache output_id that matches OUTPUT_FILENAME_RE (as stem)."""
    return f"anon-{int(time.time() * 1000):013d}-abcdef0123456789"


# ---------------------------------------------------------------------------
# image_shrink — disk-full (low free space) skips shrink
# ---------------------------------------------------------------------------

class TestImageShrinkDiskSpaceCheck:
    """_check_disk_space prevents a write when free space is below the threshold."""

    def test_check_disk_space_returns_true_when_plenty_of_space(self, tmp_path: Path) -> None:
        # tmp_path is on the real filesystem which has more than 50 MB free.
        assert image_shrink._check_disk_space(tmp_path) is True

    def test_check_disk_space_returns_false_when_below_threshold(self, tmp_path: Path) -> None:
        import shutil
        # Patch shutil.disk_usage to return a usage with only 1 MB free.
        fake_usage = shutil.disk_usage(tmp_path)
        low_usage = type(fake_usage)(
            total=fake_usage.total,
            used=fake_usage.used,
            free=1 * 1024 * 1024,  # 1 MB — below the default 50 MB threshold
        )
        with patch("token_goat.image_shrink.shutil.disk_usage", return_value=low_usage):
            result = image_shrink._check_disk_space(tmp_path)
        assert result is False

    def test_check_disk_space_returns_true_on_oserror(self, tmp_path: Path) -> None:
        # If the disk_usage call fails, fail-open so the write is still attempted.
        with patch("token_goat.image_shrink.shutil.disk_usage", side_effect=OSError("test")):
            result = image_shrink._check_disk_space(tmp_path)
        assert result is True

    def test_shrink_skips_when_low_disk_space(self, tmp_path: Path) -> None:
        """shrink() returns None (without writing) when free space is below threshold."""
        import shutil

        from hook_helpers import make_large_jpeg

        src = make_large_jpeg(tmp_path)
        assert image_shrink.should_shrink(src)

        fake_usage = shutil.disk_usage(tmp_path)
        low_usage = type(fake_usage)(
            total=fake_usage.total,
            used=fake_usage.used,
            free=1 * 1024 * 1024,  # 1 MB — below the 50 MB threshold
        )
        with patch("token_goat.image_shrink.shutil.disk_usage", return_value=low_usage), \
             patch("token_goat.image_shrink.paths.image_cache_dir", return_value=tmp_path / "cache"):
            result = image_shrink.shrink(src)

        assert result is None, "shrink must return None when disk is nearly full"

    def test_shrink_skips_min_free_mb_env_override(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """TOKEN_GOAT_MIN_FREE_MB=0 disables the disk-space guard entirely."""
        import shutil


        # Simulate 20 MB free; normally blocked by the 50 MB default.
        fake_usage = shutil.disk_usage(tmp_path)
        twenty_mb_free = type(fake_usage)(
            total=fake_usage.total,
            used=fake_usage.used,
            free=20 * 1024 * 1024,
        )
        # With threshold 0 MB (disabled), the check should pass even at 20 MB free.
        monkeypatch.setenv("TOKEN_GOAT_MIN_FREE_MB", "0")
        # Recompute the module-level constants after env change.
        # Since _MIN_FREE_MB is set at module load, we patch the constants directly.
        with patch("token_goat.image_shrink._MIN_FREE_BYTES", 0), \
             patch("token_goat.image_shrink.shutil.disk_usage", return_value=twenty_mb_free):
            result = image_shrink._check_disk_space(tmp_path)
        assert result is True


# ---------------------------------------------------------------------------
# image_shrink — ENOSPC on write returns None
# ---------------------------------------------------------------------------

class TestImageShrinkEnospc:
    """OSError(ENOSPC) from Pillow's save path is caught and returns None."""

    def test_shrink_returns_none_on_enospc(self, tmp_path: Path) -> None:
        """ENOSPC during img.save() must return None, not propagate the exception."""
        from hook_helpers import make_large_jpeg
        from PIL import Image

        src = make_large_jpeg(tmp_path)
        assert image_shrink.should_shrink(src)

        # Simulate ENOSPC by making img.save() raise OSError with errno.ENOSPC.
        enospc = OSError("No space left on device")
        enospc.errno = errno.ENOSPC

        def _save_raises(*args, **kwargs):
            raise enospc

        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()

        with patch("token_goat.image_shrink.paths.image_cache_dir", return_value=cache_dir), \
             patch.object(Image.Image, "save", _save_raises):
            result = image_shrink.shrink(src)

        assert result is None, "ENOSPC from img.save() must return None, not raise"

    def test_shrink_returns_none_generic_oserror(self, tmp_path: Path) -> None:
        """Other OSError variants (permission denied, etc.) also return None."""
        from hook_helpers import make_large_jpeg
        from PIL import Image

        src = make_large_jpeg(tmp_path)

        perm_error = OSError("Permission denied")
        perm_error.errno = errno.EACCES

        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()

        with patch("token_goat.image_shrink.paths.image_cache_dir", return_value=cache_dir), \
             patch.object(Image.Image, "save", side_effect=perm_error):
            result = image_shrink.shrink(src)

        assert result is None


# ---------------------------------------------------------------------------
# image_shrink — corrupt cache entry detection (regression guard)
# ---------------------------------------------------------------------------

class TestImageShrinkCorruptCache:
    """Corrupt cache entries are detected, deleted, and re-shrunk."""

    def test_corrupt_cached_file_triggers_reshrink(self, tmp_path: Path) -> None:
        """A cached file that Pillow cannot open is deleted and re-shrunk."""
        from hook_helpers import make_large_jpeg

        src = make_large_jpeg(tmp_path)
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()

        with patch("token_goat.image_shrink.paths.image_cache_dir", return_value=cache_dir):
            # First shrink: produces a valid cache entry.
            result1 = image_shrink.shrink(src)
            assert result1 is not None
            assert result1.exists()

            # Corrupt the cached file in-place.
            result1.write_bytes(b"CORRUPT_GARBAGE_NOT_AN_IMAGE")
            assert result1.exists()

            # Second shrink: should detect corruption, delete the file, and re-shrink.
            result2 = image_shrink.shrink(src)
            assert result2 is not None, "re-shrink after corrupt cache entry should succeed"
            assert result2.exists()

            # The re-shrunken file must not be the same corrupt bytes.
            content = result2.read_bytes()
            assert content != b"CORRUPT_GARBAGE_NOT_AN_IMAGE"

    def test_corrupt_cache_file_is_deleted(self, tmp_path: Path) -> None:
        """After detecting a corrupt cache entry, the file is removed from disk."""
        from hook_helpers import make_large_jpeg

        src = make_large_jpeg(tmp_path)
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()

        with patch("token_goat.image_shrink.paths.image_cache_dir", return_value=cache_dir):
            result1 = image_shrink.shrink(src)
            assert result1 is not None
            corrupt_path = result1
            corrupt_path.write_bytes(b"NOT_VALID")

            image_shrink.shrink(src)

            # The corrupt file by its original name should no longer be the corrupt bytes.
            # (it may be overwritten by a fresh valid file)
            if corrupt_path.exists():
                assert corrupt_path.read_bytes() != b"NOT_VALID"


# ---------------------------------------------------------------------------
# web_cache — orphan sidecar (meta without body) treated as cache miss
# ---------------------------------------------------------------------------

class TestWebCacheOrphanSidecar:
    """find_cached_for_url treats an orphan sidecar (no body) as a cache miss."""

    def test_find_cached_for_url_skips_orphan_sidecar(self, tmp_path: Path) -> None:
        """A sidecar without a body file is skipped and returns None."""

        url = "https://example.com/page"
        url_sha = web_cache.url_hash(url)
        output_id = _make_valid_output_id()

        # Write a sidecar with the right url_sha but NO body file.
        sidecar = tmp_path / f"{output_id}.json"
        sidecar.write_text(
            json.dumps({
                "output_id": output_id,
                "url_sha": url_sha,
                "url_preview": url[:200],
                "body_bytes": 100,  # non-zero to pass the body_bytes > 0 check
                "status_code": 200,
                "ts": time.time(),
                "truncated": False,
                "content_type": "text/html",
            }),
            encoding="utf-8",
        )
        # Verify body does NOT exist.
        body = tmp_path / f"{output_id}.txt"
        assert not body.exists()

        with patch("token_goat.web_cache._web_outputs_dir", return_value=tmp_path):
            result = web_cache.find_cached_for_url(url)

        assert result is None, (
            "find_cached_for_url must return None when the body file is missing"
        )

    def test_find_cached_for_url_removes_orphan_sidecar(self, tmp_path: Path) -> None:
        """An orphan sidecar is deleted when detected during a lookup."""

        url = "https://example.com/cleanup"
        url_sha = web_cache.url_hash(url)
        output_id = _make_valid_output_id()

        sidecar = tmp_path / f"{output_id}.json"
        sidecar.write_text(
            json.dumps({
                "output_id": output_id,
                "url_sha": url_sha,
                "url_preview": url[:200],
                "body_bytes": 50,
                "status_code": 200,
                "ts": time.time(),
                "truncated": False,
            }),
            encoding="utf-8",
        )

        with patch("token_goat.web_cache._web_outputs_dir", return_value=tmp_path):
            web_cache.find_cached_for_url(url)

        # The orphan sidecar should have been removed.
        assert not sidecar.exists(), "orphan sidecar must be deleted after detection"

    def test_find_cached_for_url_returns_meta_when_body_exists(self, tmp_path: Path) -> None:
        """When both body and sidecar exist, find_cached_for_url returns the metadata."""

        url = "https://example.com/valid"
        url_sha = web_cache.url_hash(url)
        output_id = _make_valid_output_id()

        body = tmp_path / f"{output_id}.txt"
        body.write_text("page content", encoding="utf-8")

        sidecar = tmp_path / f"{output_id}.json"
        sidecar.write_text(
            json.dumps({
                "output_id": output_id,
                "url_sha": url_sha,
                "url_preview": url[:200],
                "body_bytes": 12,
                "status_code": 200,
                "ts": time.time(),
                "truncated": False,
            }),
            encoding="utf-8",
        )

        with patch("token_goat.web_cache._web_outputs_dir", return_value=tmp_path):
            result = web_cache.find_cached_for_url(url)

        assert result is not None
        assert result.url_sha == url_sha


# ---------------------------------------------------------------------------
# web_cache — write order: body before meta
# ---------------------------------------------------------------------------

class TestWebCacheWriteOrder:
    """store_output always writes the body before the sidecar."""

    def test_body_written_before_sidecar(self, tmp_path: Path) -> None:
        """store_output writes the .txt body file before write_sidecar is called."""
        # store_output writes the body (.txt); write_sidecar() is the caller's responsibility.
        # Test the contract: after store_output returns non-None, the body file must exist.

        session_id = "test_session"
        url = "https://example.com/order-test"
        body = "body content"
        status_code = 200

        with patch("token_goat.web_cache._web_outputs_dir", return_value=tmp_path):
            meta = web_cache.store_output(session_id, url, body, status_code)

        assert meta is not None
        # The body (.txt) must exist immediately after store_output.
        body_path = tmp_path / f"{meta.output_id}.txt"
        assert body_path.exists(), "body file must exist after store_output"
        assert body_path.stat().st_size > 0

    def test_meta_without_body_is_a_cache_miss(self, tmp_path: Path) -> None:
        """If only the sidecar exists (interrupted write), load_output returns None."""

        output_id = _make_valid_output_id()
        # Write sidecar but NO body.
        sidecar = tmp_path / f"{output_id}.json"
        sidecar.write_text(
            json.dumps({"output_id": output_id, "body_bytes": 50}),
            encoding="utf-8",
        )

        with patch("token_goat.web_cache._web_outputs_dir", return_value=tmp_path):
            result = web_cache.load_output(output_id)

        assert result is None, "load_output must return None when body file is missing"


# ---------------------------------------------------------------------------
# webfetch — TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS env var
# ---------------------------------------------------------------------------

class TestWebfetchTimeoutEnvVar:
    """fetch_url respects TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS for the HTTP timeout."""

    def test_webfetch_timeout_default_is_30(self) -> None:
        """_webfetch_timeout() returns 30.0 when env var is not set."""
        from token_goat import webfetch

        with patch.dict(os.environ, {}, clear=False):
            # Remove the var if it exists.
            os.environ.pop("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", None)
            result = webfetch._webfetch_timeout()

        assert result == 30.0

    def test_webfetch_timeout_reads_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """_webfetch_timeout() returns the env var value when set."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "60")
        assert webfetch._webfetch_timeout() == 60.0

    def test_webfetch_timeout_float_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """_webfetch_timeout() accepts a decimal value."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "10.5")
        assert webfetch._webfetch_timeout() == 10.5

    def test_webfetch_timeout_invalid_env_var_falls_back_to_30(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A non-numeric env var value falls back to 30 s."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "not-a-number")
        assert webfetch._webfetch_timeout() == 30.0

    def test_webfetch_timeout_zero_env_var_falls_back_to_30(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A zero (or negative) env var value falls back to 30 s."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "0")
        assert webfetch._webfetch_timeout() == 30.0

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "-5")
        assert webfetch._webfetch_timeout() == 30.0

    def test_fetch_url_uses_timeout_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """fetch_url passes the env-configured timeout to httpx.Client."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "5")
        captured_timeouts: list[float] = []

        import httpx

        class _MockClient:
            def __init__(self, *, timeout, **kwargs):
                captured_timeouts.append(timeout)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def stream(self, *args, **kwargs):
                # Return a context manager that raises immediately to abort the request.
                raise httpx.RequestError("mock abort")

            def get(self, *args, **kwargs):
                raise httpx.RequestError("mock abort")

        with patch("token_goat.webfetch._is_ssrf_safe", return_value=True), \
             patch("token_goat.webfetch._resolve_and_validate_ip", return_value="1.2.3.4"), \
             patch("token_goat.webfetch._make_pinned_transport", return_value=MagicMock()), \
             patch("token_goat.image_shrink.ensure_cache_dir"), \
             patch("httpx.Client", _MockClient), \
             pytest.raises(RuntimeError):
            webfetch.fetch_url("https://example.com/img.png")

        assert captured_timeouts, "httpx.Client must have been constructed with a timeout"
        assert captured_timeouts[0] == 5.0, (
            f"expected timeout 5.0, got {captured_timeouts[0]}"
        )

    def test_fetch_url_explicit_timeout_overrides_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An explicit timeout_sec argument overrides the env var."""
        from token_goat import webfetch

        monkeypatch.setenv("TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS", "5")
        captured_timeouts: list[float] = []

        import httpx

        class _MockClient:
            def __init__(self, *, timeout, **kwargs):
                captured_timeouts.append(timeout)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def stream(self, *args, **kwargs):
                raise httpx.RequestError("mock abort")

            def get(self, *args, **kwargs):
                raise httpx.RequestError("mock abort")

        with patch("token_goat.webfetch._is_ssrf_safe", return_value=True), \
             patch("token_goat.webfetch._resolve_and_validate_ip", return_value="1.2.3.4"), \
             patch("token_goat.webfetch._make_pinned_transport", return_value=MagicMock()), \
             patch("token_goat.image_shrink.ensure_cache_dir"), \
             patch("httpx.Client", _MockClient), \
             pytest.raises(RuntimeError):
            webfetch.fetch_url("https://example.com/img.png", timeout_sec=99.0)

        assert captured_timeouts[0] == 99.0, (
            f"explicit timeout_sec=99 should override env var, got {captured_timeouts[0]}"
        )


# ---------------------------------------------------------------------------
# cache_common — concurrent eviction race
# ---------------------------------------------------------------------------

class TestEvictionRaceSafety:
    """evict_cache_dir handles FileNotFoundError from concurrent deletions."""

    def _make_cache_dir(self, tmp_path: Path) -> Path:
        """Create a fake cache directory with enough files to trigger eviction."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        return cache_dir

    def test_body_unlink_fnfe_does_not_crash(self, tmp_path: Path) -> None:
        """If a body file disappears between scan and unlink, eviction continues."""
        cache_dir = self._make_cache_dir(tmp_path)

        # Write two entries exceeding max_total_bytes.
        id1 = _make_valid_output_id()
        id2 = _make_valid_output_id()
        body1 = cache_dir / f"{id1}.txt"
        body2 = cache_dir / f"{id2}.txt"
        body1.write_bytes(b"x" * 100)
        body2.write_bytes(b"x" * 100)
        # Adjust mtime so id1 is older.
        now = time.time()
        os.utime(body1, (now - 10, now - 10))
        os.utime(body2, (now - 5, now - 5))

        # Simulate concurrent deletion: body1 is already gone when our eviction tries to unlink it.
        original_unlink = Path.unlink

        _first_call = [True]

        def _unlink_race(self_path: Path, missing_ok: bool = False) -> None:
            if _first_call[0] and self_path == body1:
                _first_call[0] = False
                # Simulate the file having been removed concurrently.
                original_unlink(self_path, missing_ok=True)
                raise FileNotFoundError(errno.ENOENT, "No such file", str(self_path))
            return original_unlink(self_path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", _unlink_race):
            removed = evict_cache_dir(
                cache_dir_fn=lambda: cache_dir,
                log_name="test_cache",
                max_total_bytes=50,  # below the 200 bytes we wrote, triggers eviction
                max_file_count=4096,
            )

        # evict_cache_dir must not raise — it catches the OSError and continues.
        # At least one file was evicted (body2 survives our patch, or body1 was
        # already gone so body2 gets evicted on the next iteration).
        assert isinstance(removed, int)

    def test_sidecar_fnfe_on_cleanup_is_silent(self, tmp_path: Path) -> None:
        """FileNotFoundError during sidecar cleanup is swallowed silently."""
        cache_dir = self._make_cache_dir(tmp_path)

        output_id = _make_valid_output_id()
        body_path, sidecar_path = _make_cache_entry(cache_dir, output_id, body="x" * 100)

        # Simulate another process having deleted the sidecar before our cleanup.
        original_unlink = Path.unlink

        def _no_sidecar(self_path: Path, missing_ok: bool = False) -> None:
            if self_path == sidecar_path:
                raise FileNotFoundError(errno.ENOENT, "No such file", str(self_path))
            return original_unlink(self_path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", _no_sidecar):
            # Must not raise.
            removed = evict_cache_dir(
                cache_dir_fn=lambda: cache_dir,
                log_name="test_cache",
                max_total_bytes=0,  # force eviction of everything
                max_file_count=4096,
            )

        assert removed >= 0  # returned without exception

    def test_orphan_sidecar_missing_ok_on_concurrent_delete(self, tmp_path: Path) -> None:
        """Orphan sidecar sweep uses missing_ok so concurrent delete doesn't crash."""
        cache_dir = self._make_cache_dir(tmp_path)

        output_id = _make_valid_output_id()
        # Write ONLY a sidecar (orphan: no body).
        sidecar = cache_dir / f"{output_id}.json"
        sidecar.write_text("{}", encoding="utf-8")
        assert not (cache_dir / f"{output_id}.txt").exists()

        # Simulate concurrent delete: sidecar is removed before our orphan sweep gets to it.
        original_unlink = Path.unlink

        def _concurrent_delete(self_path: Path, missing_ok: bool = False) -> None:
            if self_path == sidecar:
                # Remove it first (simulating another process), then raise FNFE.
                original_unlink(self_path, missing_ok=True)
                if not missing_ok:
                    raise FileNotFoundError(errno.ENOENT, "No such file", str(self_path))
            else:
                original_unlink(self_path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", _concurrent_delete):
            # Must not raise.
            evict_cache_dir(
                cache_dir_fn=lambda: cache_dir,
                log_name="test_cache",
                max_total_bytes=1024 * 1024,  # well above zero bytes, so only orphan sweep runs
                max_file_count=4096,
            )

        # The orphan sidecar is gone (removed by our simulated concurrent process).
        assert not sidecar.exists()
