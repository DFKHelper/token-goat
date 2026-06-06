"""Tests for skill caching improvements (iteration 14).

Covers:
1. Cross-session dedup: find_cross_session_entry + store_output reuse behaviour
2. Minimal-body guard in post_skill: tiny/stub responses are skipped gracefully
"""
from __future__ import annotations

import logging
from unittest.mock import patch

from compact_test_helpers import DataDirMixin
from conftest import fire_skill_hook

from token_goat import skill_cache

# ---------------------------------------------------------------------------
# Improvement 1: Cross-session dedup
# ---------------------------------------------------------------------------


class TestCrossSessionDedup(DataDirMixin):
    """store_output reuses an existing body file when (name, sha) already cached."""


    # ------------------------------------------------------------------
    # find_cross_session_entry
    # ------------------------------------------------------------------

    def test_find_cross_session_entry_returns_none_on_empty_cache(self):
        """Returns None when the cache is empty."""
        result = skill_cache.find_cross_session_entry("ralph", "abc123")
        assert result is None

    def test_find_cross_session_entry_no_match(self):
        """Returns None when skill exists but sha differs."""
        body_a = "# Ralph skill\n\n" + "rule line. " * 200
        meta_a = skill_cache.store_output("sess-alpha", "ralph", body_a)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        # Different body => different sha => no cross-session hit.
        different_sha = "0000000000000000"
        result = skill_cache.find_cross_session_entry("ralph", different_sha)
        assert result is None

    def test_find_cross_session_entry_match(self):
        """Returns SkillMeta when (name, sha) already exists in another session."""
        body = "# Improve skill\n\n" + "step. " * 300
        sha = skill_cache.content_hash(body)
        meta_a = skill_cache.store_output("sess-first", "improve", body)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        # Now search from a different session's perspective.
        hit = skill_cache.find_cross_session_entry("improve", sha)
        assert hit is not None
        assert hit.skill_name == "improve"
        assert hit.content_sha == sha
        assert hit.output_id == meta_a.output_id

    def test_find_cross_session_entry_exported_in_all(self):
        """find_cross_session_entry is in skill_cache.__all__."""
        assert "find_cross_session_entry" in skill_cache.__all__

    def test_find_cross_session_entry_invalid_name_returns_none(self):
        """Returns None for invalid skill name without scanning the cache."""
        result = skill_cache.find_cross_session_entry("with/slash", "abc123")
        assert result is None

    def test_find_cross_session_entry_empty_sha_returns_none(self):
        """Returns None when content_sha is empty."""
        result = skill_cache.find_cross_session_entry("ralph", "")
        assert result is None

    # ------------------------------------------------------------------
    # store_output cross-session dedup path
    # ------------------------------------------------------------------

    def test_second_session_reuses_existing_body_file(self):
        """A second session storing the same skill body produces no new .txt file."""
        body = "# Shared skill body\n\n" + "content line. " * 300
        skills_dir = self.tmp_data_dir / "skills"

        # Session A stores the body for the first time.
        meta_a = skill_cache.store_output("sess-A-longid", "shared-skill", body)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        txt_files_after_a = list(skills_dir.glob("*.txt"))
        assert len(txt_files_after_a) == 1, (
            f"Expected 1 .txt file after session A, got {len(txt_files_after_a)}"
        )

        # Session B stores the same body: should NOT create a second .txt file.
        meta_b = skill_cache.store_output("sess-B-longid", "shared-skill", body)
        assert meta_b is not None, "store_output must succeed even on dedup hit"
        skill_cache.write_sidecar(meta_b)

        txt_files_after_b = list(skills_dir.glob("*.txt"))
        assert len(txt_files_after_b) == 1, (
            f"Expected still 1 .txt file after session B dedup, "
            f"got {len(txt_files_after_b)}: {[f.name for f in txt_files_after_b]}"
        )

    def test_second_session_meta_points_at_original_body(self):
        """The dedup meta output_id resolves to the same body content."""
        body = "# Skills are shared\n\n" + "shared content. " * 250

        meta_a = skill_cache.store_output("sess-orig-001", "shared-skill2", body)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        meta_b = skill_cache.store_output("sess-new-002", "shared-skill2", body)
        assert meta_b is not None
        # Both metas should resolve to the same loadable body.
        loaded_a = skill_cache.load_output(meta_a.output_id)
        loaded_b = skill_cache.load_output(meta_b.output_id)
        assert loaded_a is not None
        assert loaded_b is not None
        # Content should be identical (both read the same body file).
        # Strip any truncation marker and compare starts.
        assert loaded_a[:50] == loaded_b[:50], (
            f"Dedup body mismatch:\n  A: {loaded_a[:80]!r}\n  B: {loaded_b[:80]!r}"
        )

    def test_dedup_meta_has_updated_timestamp(self):
        """The dedup meta carries a fresh ts (>= original), not the original session's ts."""
        body = "# Timestamped skill\n\n" + "ts content. " * 200

        # Patch time.time so the second store_output call returns a strictly later
        # timestamp without incurring a real sleep.
        _times = iter([1_000_000.0, 1_000_001.0])
        with patch("token_goat.skill_cache.time.time", side_effect=lambda: next(_times)):
            meta_a = skill_cache.store_output("sess-ts-aaa", "ts-skill", body)
            assert meta_a is not None
            skill_cache.write_sidecar(meta_a)

            meta_b = skill_cache.store_output("sess-ts-bbb", "ts-skill", body)
        assert meta_b is not None
        assert meta_b.ts >= meta_a.ts, (
            f"Dedup meta ts ({meta_b.ts}) should be >= original ts ({meta_a.ts})"
        )

    def test_different_skill_different_sha_no_dedup(self):
        """Different skill bodies are NOT deduped even in same session."""
        body_x = "# Skill X\n\n" + "x content. " * 200
        body_y = "# Skill Y\n\n" + "y content. " * 200  # different body => different sha
        skills_dir = self.tmp_data_dir / "skills"

        meta_x = skill_cache.store_output("sess-multi", "skill-x", body_x)
        meta_y = skill_cache.store_output("sess-multi", "skill-y", body_y)
        assert meta_x is not None and meta_y is not None

        txt_files = list(skills_dir.glob("*.txt"))
        assert len(txt_files) == 2, (
            f"Expected 2 separate .txt files for different bodies, "
            f"got {len(txt_files)}: {[f.name for f in txt_files]}"
        )

    def test_dedup_preserves_source_path_from_caller(self):
        """Caller-supplied source_path takes precedence over the original entry's path."""
        body = "# Path test skill\n\n" + "path content. " * 200

        meta_a = skill_cache.store_output(
            "sess-path-aaa", "path-skill", body,
            source_path="/original/path/SKILL.md",
        )
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        meta_b = skill_cache.store_output(
            "sess-path-bbb", "path-skill", body,
            source_path="/new/path/SKILL.md",
        )
        assert meta_b is not None
        # The caller's path should win over the original entry's path.
        assert meta_b.source_path == "/new/path/SKILL.md", (
            f"Expected caller source_path to win, got: {meta_b.source_path!r}"
        )

    def test_dedup_falls_back_to_original_source_path_when_caller_omits(self):
        """When caller does not supply source_path, original entry's path is kept."""
        body = "# Fallback path skill\n\n" + "fallback content. " * 200

        meta_a = skill_cache.store_output(
            "sess-fb-aaa", "fallback-skill", body,
            source_path="/original/fallback/SKILL.md",
        )
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        # No source_path supplied by caller.
        meta_b = skill_cache.store_output("sess-fb-bbb", "fallback-skill", body)
        assert meta_b is not None
        assert meta_b.source_path == "/original/fallback/SKILL.md", (
            f"Expected original source_path to be preserved, got: {meta_b.source_path!r}"
        )

    def test_dedup_scan_skips_entry_with_missing_body_file(self, caplog):
        """find_cross_session_entry skips entries whose body file has been evicted."""
        body = "# Evicted skill\n\n" + "evict content. " * 200
        sha = skill_cache.content_hash(body)

        meta_a = skill_cache.store_output("sess-evict-aaa", "evict-skill", body)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        # Manually remove the body file to simulate eviction.
        skills_dir = self.tmp_data_dir / "skills"
        body_file = skills_dir / f"{meta_a.output_id}.txt"
        if body_file.exists():
            body_file.unlink()
        gz_file = skills_dir / f"{meta_a.output_id}.gz"
        if gz_file.exists():
            gz_file.unlink()

        # Now the cross-session probe should not find this evicted entry.
        result = skill_cache.find_cross_session_entry("evict-skill", sha)
        assert result is None, (
            "find_cross_session_entry must return None for entries with no body file"
        )

    def test_dedup_same_session_same_body_idempotent(self):
        """Repeated store_output calls within the same session remain idempotent."""
        body = "# Idempotent skill\n\n" + "idem content. " * 200

        meta_1 = skill_cache.store_output("sess-idem", "idem-skill", body)
        assert meta_1 is not None
        skill_cache.write_sidecar(meta_1)

        meta_2 = skill_cache.store_output("sess-idem", "idem-skill", body)
        assert meta_2 is not None
        # Both should resolve to the same output_id (within the same session).
        assert meta_1.output_id == meta_2.output_id

    # ------------------------------------------------------------------
    # Log output for dedup path
    # ------------------------------------------------------------------

    def test_dedup_hit_logs_debug_message(self, caplog):
        """A dedup hit emits a debug log with 'cross-session dedup hit'."""
        body = "# Log test skill\n\n" + "log content. " * 200

        meta_a = skill_cache.store_output("sess-log-aaa", "log-skill", body)
        assert meta_a is not None
        skill_cache.write_sidecar(meta_a)

        with caplog.at_level(logging.DEBUG, logger="token_goat.skill_cache"):
            skill_cache.store_output("sess-log-bbb", "log-skill", body)

        dedup_records = [r for r in caplog.records if "cross-session dedup" in r.message]
        assert len(dedup_records) >= 1, (
            f"Expected a 'cross-session dedup' debug log; got: {[r.message for r in caplog.records]}"
        )


# ---------------------------------------------------------------------------
# Improvement 2: Minimal-body guard in post_skill
# ---------------------------------------------------------------------------


class TestPostSkillMinimalBodyGuard(DataDirMixin):
    """post_skill skips caching when the body is too small (stub/confirmation response)."""


    def _fire(self, session_id: str, skill_name: str, body: str) -> dict:
        return fire_skill_hook(session_id, skill_name, body)

    def test_stub_response_not_cached(self):
        """A 'Skill loaded' one-liner is below the min-bytes threshold and is skipped."""
        resp = self._fire("sess-stub", "ralph", "Skill loaded.")
        assert resp.get("continue") is True, "Hook must always return continue=True"

        # No body should have been written to the cache.
        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt")) if skills_dir.exists() else []
        gz_files = list(skills_dir.glob("*.gz")) if skills_dir.exists() else []
        assert len(txt_files) + len(gz_files) == 0, (
            f"Expected no body files for stub response, "
            f"got txt={[f.name for f in txt_files]}, gz={[f.name for f in gz_files]}"
        )

    def test_stub_response_logs_debug(self, caplog):
        """A body below min-bytes logs a debug message and returns continue."""
        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks_skill"):
            resp = self._fire("sess-stub-log", "improve", "Loaded.")

        assert resp.get("continue") is True
        small_records = [
            r for r in caplog.records
            if "too small" in r.message or "threshold" in r.message
        ]
        assert len(small_records) >= 1, (
            f"Expected a 'too small' debug log for stub body; "
            f"got: {[r.message for r in caplog.records]}"
        )

    def test_empty_body_not_cached(self):
        """An empty body is treated as a stub and is not cached."""
        resp = self._fire("sess-empty", "ralph", "")
        assert resp.get("continue") is True

        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt")) if skills_dir.exists() else []
        assert len(txt_files) == 0, (
            f"Expected no .txt files for empty body, got: {[f.name for f in txt_files]}"
        )

    def test_minimal_confirmation_variants_not_cached(self):
        """Multiple stub-response variants are all below the min-bytes threshold."""
        stub_variants = [
            "Skill loaded.",
            "OK",
            "Done.",
            "✓",
            "Loaded",
        ]
        for variant in stub_variants:
            resp = self._fire("sess-variant", "some-skill", variant)
            assert resp.get("continue") is True, (
                f"Hook must continue for stub variant: {variant!r}"
            )

        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt")) if skills_dir.exists() else []
        assert len(txt_files) == 0, (
            f"Expected no body files for stub variants, "
            f"got: {[f.name for f in txt_files]}"
        )

    def test_real_body_above_threshold_is_cached(self):
        """A normal skill body (above min-bytes) is still cached correctly."""
        real_body = "# Ralph skill\n\n" + "rule directive here. " * 100
        # Ensure body is well above the 256-byte threshold.
        assert len(real_body.encode()) > 256

        resp = self._fire("sess-real", "ralph", real_body)
        assert resp.get("continue") is True

        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt"))
        assert len(txt_files) >= 1, (
            f"Expected at least 1 body file for real skill body, "
            f"got: {[f.name for f in txt_files]}"
        )

    def test_boundary_body_at_min_bytes_not_cached(self):
        """A body exactly at the min-bytes boundary (255 bytes) is skipped."""
        from token_goat.hooks_skill import _SKILL_CACHE_MIN_BYTES

        # Build a body of exactly min_bytes - 1 (just below threshold).
        short_body = "x" * (_SKILL_CACHE_MIN_BYTES - 1)
        assert len(short_body.encode()) < _SKILL_CACHE_MIN_BYTES

        resp = self._fire("sess-boundary", "boundary-skill", short_body)
        assert resp.get("continue") is True

        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt")) if skills_dir.exists() else []
        assert len(txt_files) == 0, (
            f"Expected no body files for below-threshold body, "
            f"got: {[f.name for f in txt_files]}"
        )

    def test_body_at_exactly_min_bytes_is_cached(self):
        """A body of exactly _SKILL_CACHE_MIN_BYTES is accepted (boundary inclusive)."""
        from token_goat.hooks_skill import _SKILL_CACHE_MIN_BYTES

        # Build a body of exactly min_bytes (at threshold).
        at_threshold = "y" * _SKILL_CACHE_MIN_BYTES
        assert len(at_threshold.encode()) == _SKILL_CACHE_MIN_BYTES

        resp = self._fire("sess-at-threshold", "at-threshold-skill", at_threshold)
        assert resp.get("continue") is True

        skills_dir = self.tmp_data_dir / "skills"
        txt_files = list(skills_dir.glob("*.txt"))
        assert len(txt_files) >= 1, (
            f"Expected at least 1 body file for body at threshold, "
            f"got: {[f.name for f in txt_files]}"
        )
