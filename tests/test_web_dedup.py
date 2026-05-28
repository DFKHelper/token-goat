"""Tests for web_dedup_min_bytes configuration and content-hash validation."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from token_goat import config, hints
from token_goat.session import SessionCache


@pytest.fixture
def mock_cache() -> SessionCache:
    """Create a mock session cache for testing."""
    cache = MagicMock(spec=SessionCache)
    cache.has_hint_fingerprint = MagicMock(return_value=False)
    cache.mark_hint_seen = MagicMock()
    cache.recent_hints = []
    return cache


class TestWebDedupMinBytesConfig:
    """Test web_dedup_min_bytes configuration and env override."""

    def test_default_web_dedup_min_bytes(self) -> None:
        """Default web_dedup_min_bytes is 200 bytes."""
        cfg = config.load()
        assert cfg.hints.web_dedup_min_bytes == 200

    def test_web_dedup_min_bytes_in_config_schema(self) -> None:
        """web_dedup_min_bytes field exists in HintsConfig dataclass."""
        cfg = config.load()
        assert hasattr(cfg.hints, "web_dedup_min_bytes")
        assert isinstance(cfg.hints.web_dedup_min_bytes, int)


class TestWebDedupHintWithMinBytes:
    """Test build_web_dedup_hint respects web_dedup_min_bytes threshold."""

    def test_above_threshold_emits_hint(self, mock_cache) -> None:
        """Web dedup hint fires when body_bytes >= web_dedup_min_bytes (200)."""
        with patch("token_goat.hints.session.lookup_web_entry") as mock_lookup, patch(
            "token_goat.hints.config.load"
        ) as mock_config_load, patch(
            "token_goat.hints.time.time", return_value=1010.0
        ):
            # Setup config mock
            mock_cfg = MagicMock()
            mock_cfg.hints.web_dedup_min_bytes = 200
            mock_config_load.return_value = mock_cfg

            # Create a minimal mock entry with the needed attributes
            entry = MagicMock()
            entry.url_sha = "test_sha"
            entry.url_preview = "https://example.com"
            entry.output_id = "out_123"
            entry.body_bytes = 500  # Above threshold
            entry.status_code = 200
            entry.ts = 1000.0
            entry.truncated = False
            mock_lookup.return_value = entry

            hint = hints.build_web_dedup_hint(
                session_id="test_session",
                url="https://example.com",
                cache=mock_cache,
            )

        assert hint is not None

    def test_below_threshold_suppresses_hint(self, mock_cache) -> None:
        """Web dedup hint is suppressed when body_bytes < web_dedup_min_bytes."""
        with patch("token_goat.hints.session.lookup_web_entry") as mock_lookup, patch(
            "token_goat.hints.config.load"
        ) as mock_config_load, patch(
            "token_goat.hints.time.time", return_value=1010.0
        ):
            # Setup config with high threshold
            mock_cfg = MagicMock()
            mock_cfg.hints.web_dedup_min_bytes = 500
            mock_config_load.return_value = mock_cfg

            entry = MagicMock()
            entry.url_sha = "test_sha"
            entry.url_preview = "https://example.com"
            entry.output_id = "out_123"
            entry.body_bytes = 200  # Below the 500-byte threshold
            entry.status_code = 200
            entry.ts = 1000.0
            entry.truncated = False
            mock_lookup.return_value = entry

            hint = hints.build_web_dedup_hint(
                session_id="test_session",
                url="https://example.com",
                cache=mock_cache,
            )

        assert hint is None

    def test_zero_threshold_fires_on_all_sizes(self, mock_cache) -> None:
        """web_dedup_min_bytes=0 fires for any body size (consistent with bash/grep thresholds)."""
        with patch("token_goat.hints.session.lookup_web_entry") as mock_lookup, patch(
            "token_goat.hints.config.load"
        ) as mock_config_load, patch(
            "token_goat.hints.time.time", return_value=1010.0
        ):
            mock_cfg = MagicMock()
            mock_cfg.hints.web_dedup_min_bytes = 0
            mock_config_load.return_value = mock_cfg

            entry = MagicMock()
            entry.url_sha = "test_sha"
            entry.url_preview = "https://example.com"
            entry.output_id = "out_123"
            entry.body_bytes = 1  # tiny body — should still emit with threshold=0
            entry.status_code = 200
            entry.ts = 1000.0
            entry.truncated = False
            mock_lookup.return_value = entry

            hint = hints.build_web_dedup_hint(
                session_id="test_session",
                url="https://example.com",
                cache=mock_cache,
            )

        assert hint is not None, "threshold=0 must fire for any body size, not suppress"
