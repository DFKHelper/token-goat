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

    def test_overhead_suffix_inherits_from_base(self):
        """Any ``<base>_overhead`` kind resolves via the base lookup.

        The seven ``*_overhead`` rows were previously enumerated in
        ``_KIND_TO_SOURCE``.  ``kind_to_source()`` now strips the suffix and
        re-queries the static dict, so the table only holds the base kinds and
        the pair is impossible to drift out of sync.  This test guards the
        suffix routing for both registered and unregistered hypothetical
        future overhead rows.
        """
        # Registered base + overhead pair
        assert stats.kind_to_source("session_hint_overhead") == stats.SOURCE_HINT
        # The seven overhead kinds collapsed from the static map
        for overhead_kind, expected in (
            ("session_hint_overhead", stats.SOURCE_HINT),
            ("diff_hint_overhead", stats.SOURCE_HINT),
            ("structured_file_hint_overhead", stats.SOURCE_HINT),
            ("grep_dedup_hint_overhead", stats.SOURCE_HINT),
            ("compact_recovery_overhead", stats.SOURCE_COMPACT),
            ("bash_dedup_hint_overhead", stats.SOURCE_BASH),
            ("web_dedup_hint_overhead", stats.SOURCE_WEB),
        ):
            assert stats.kind_to_source(overhead_kind) == expected, (
                f"{overhead_kind} did not inherit from its base"
            )
        # Hypothetical future overhead pair (no entry in the static map)
        assert stats.kind_to_source("nonexistent_kind_overhead") == stats.SOURCE_OTHER, (
            "overhead suffix must not promote unknown bases out of SOURCE_OTHER"
        )

    def test_overhead_not_listed_in_static_map(self):
        """Guard against re-introducing ``_overhead`` entries to the static map.

        The whole point of the suffix routing is to eliminate the mechanical
        pair-duplication.  Any future addition of ``"x_overhead": SOURCE_*``
        to ``_KIND_TO_SOURCE`` would silently bypass the suffix path and
        re-introduce drift risk.
        """
        offenders = [k for k in stats._KIND_TO_SOURCE if k.endswith("_overhead")]
        assert offenders == [], (
            f"_overhead kinds must be routed by suffix, not by static entry; "
            f"found: {offenders}"
        )
