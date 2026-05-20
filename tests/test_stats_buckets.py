"""Tests for the kind→source bucket mapping additions."""
from __future__ import annotations

from token_goat import stats


class TestSourceBucketMapping:
    def test_diff_hint_lands_in_hint_bucket(self):
        assert stats.kind_to_source("diff_hint") == stats.SOURCE_HINT
        assert stats.kind_to_source("diff_hint_overhead") == stats.SOURCE_HINT

    def test_bash_dedup_lands_in_bash_bucket(self):
        assert stats.kind_to_source("bash_dedup_hint") == stats.SOURCE_BASH
        assert stats.kind_to_source("bash_dedup_hint_overhead") == stats.SOURCE_BASH

    def test_web_dedup_lands_in_web_bucket(self):
        assert stats.kind_to_source("web_dedup_hint") == stats.SOURCE_WEB
        assert stats.kind_to_source("web_dedup_hint_overhead") == stats.SOURCE_WEB

    def test_bash_output_cached_lands_in_bash_bucket(self):
        assert stats.kind_to_source("bash_output_cached") == stats.SOURCE_BASH

    def test_compact_recovery_lands_in_compact_bucket(self):
        """compact_recovery and its overhead must be attributed to SOURCE_COMPACT,
        not SOURCE_OTHER.  They were previously missing from _KIND_TO_SOURCE."""
        assert stats.kind_to_source("compact_recovery") == stats.SOURCE_COMPACT
        assert stats.kind_to_source("compact_recovery_overhead") == stats.SOURCE_COMPACT

    def test_unknown_kind_falls_back_to_other(self):
        assert stats.kind_to_source("future_unknown_kind") == stats.SOURCE_OTHER

    def test_existing_buckets_unchanged(self):
        """Regression: the pre-existing source mapping must not have shifted."""
        assert stats.kind_to_source("image_shrink") == stats.SOURCE_IMAGE
        assert stats.kind_to_source("session_hint") == stats.SOURCE_HINT
        assert stats.kind_to_source("read_replacement") == stats.SOURCE_READ
        assert stats.kind_to_source("compact_manifest") == stats.SOURCE_COMPACT
