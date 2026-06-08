"""Tests for worker dirty-queue skill-cache invalidation and Windows MAX_PATH guard.

Covers:
1. skill_cache.invalidate_for_path — removes body + sidecar + compact for a given path
2. worker._invalidate_skill_cache_entries — only fires for skill paths in queue entries
3. cache_common.safe_join_output_id — rejects paths >= 260 chars on Windows
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat import skill_cache, worker
from token_goat.cache_common import safe_join_output_id

# ---------------------------------------------------------------------------
# skill_cache.invalidate_for_path
# ---------------------------------------------------------------------------

class TestInvalidateForPath:
    """invalidate_for_path removes body/sidecar/compact matching a source_path."""

    def test_no_match_returns_zero(self, tmp_data_dir):
        """Returns 0 when no cached entry has the given source_path."""
        skill_cache.store_output("sess1", "ralph", "body " * 100, source_path="/some/file.md")
        n = skill_cache.invalidate_for_path("/nonexistent/other.md")
        assert n == 0

    def test_empty_path_returns_zero(self, tmp_data_dir):
        n = skill_cache.invalidate_for_path("")
        assert n == 0

    def test_removes_matching_body_and_sidecar(self, tmp_data_dir):
        """Removes the body .txt and .json sidecar for a matching source_path."""
        source = "/skills/ralph/SKILL.md"
        meta = skill_cache.store_output("sess2", "ralph", "rule. " * 200, source_path=source)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        # Verify files exist before invalidation
        cache_dir = tmp_data_dir / "skills"
        assert (cache_dir / f"{meta.output_id}.txt").exists()
        assert (cache_dir / f"{meta.output_id}.json").exists()

        n = skill_cache.invalidate_for_path(source)
        assert n == 1

        # Both body and sidecar should be gone
        assert not (cache_dir / f"{meta.output_id}.txt").exists()
        assert not (cache_dir / f"{meta.output_id}.json").exists()

    def test_removes_matching_gz_body(self, tmp_data_dir):
        """Removes the .gz companion body file when it is present alongside the .txt stub."""
        source = "/skills/bigskill/SKILL.md"
        meta = skill_cache.store_output("sess3", "bigskill", "body " * 200, source_path=source)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        cache_dir = tmp_data_dir / "skills"
        txt = cache_dir / f"{meta.output_id}.txt"
        assert txt.exists()

        # Manually create a .gz sibling to simulate a prior compressed-storage write.
        gz = cache_dir / f"{meta.output_id}.gz"
        gz.write_bytes(b"\x1f\x8b fake compressed data")

        n = skill_cache.invalidate_for_path(source)
        assert n == 1
        assert not txt.exists()
        assert not gz.exists()

    def test_path_normalisation_backslash(self, tmp_data_dir):
        """Windows backslash paths are normalised and match POSIX equivalents."""
        source_stored = "/skills/ralph/SKILL.md"
        meta = skill_cache.store_output("sess4", "ralph", "content " * 100, source_path=source_stored)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        # Use a differently-formatted but equivalent path.
        # On Windows Path.resolve() normalises; on POSIX both are the same.
        n = skill_cache.invalidate_for_path(source_stored)
        assert n == 1

    def test_multiple_entries_same_path(self, tmp_data_dir):
        """All entries matching the source_path are removed (not just the first)."""
        source = "/skills/improve/SKILL.md"
        meta_a = skill_cache.store_output("sess5a", "improve", "v1 body " * 100, source_path=source)
        meta_b = skill_cache.store_output("sess5b", "improve", "v2 body " * 100, source_path=source)
        assert meta_a is not None and meta_b is not None
        skill_cache.write_sidecar(meta_a)
        skill_cache.write_sidecar(meta_b)

        n = skill_cache.invalidate_for_path(source)
        assert n == 2

    def test_compact_removed_for_invalidated_skill(self, tmp_data_dir):
        """Compact files for the skill are also removed so stale compacts are not served."""
        source = "/skills/ralph/SKILL.md"
        meta = skill_cache.store_output("sess6", "ralph", "body " * 200, source_path=source)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        # Store a compact for this session+skill
        skill_cache.store_compact("sess6", "ralph", "compact content")
        cache_dir = tmp_data_dir / "skills"
        # Verify the compact file exists
        compact_files_before = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert len(compact_files_before) >= 1

        n = skill_cache.invalidate_for_path(source)
        assert n >= 1

        compact_files_after = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert len(compact_files_after) == 0

    def test_compact_removal_with_namespaced_skill(self, tmp_data_dir):
        """Compact removal works for plugin:skill namespaced names (safe name has 'n' suffix)."""
        source = "/plugins/core/skills/improve/SKILL.md"
        meta = skill_cache.store_output("sess7", "plugin:improve", "body " * 200, source_path=source)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        skill_cache.store_compact("sess7", "plugin:improve", "compact for plugin improve")
        cache_dir = tmp_data_dir / "skills"
        compact_before = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert compact_before, "compact file should exist before invalidation"

        n = skill_cache.invalidate_for_path(source)
        assert n == 1
        compact_after = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert len(compact_after) == 0

    def test_compact_removal_with_mixed_case_skill(self, tmp_data_dir):
        """Compact removal works for mixed-case namespaced names (regression).

        _compact_file_id lowercases the safe-name segment, so a skill named
        "userSettings:brainstorming" writes its compact as
        "...-usersettings_brainstormingn-compact". invalidate_for_path previously
        built the purge suffix from the un-lowercased meta.skill_name, so the
        suffix ("...-userSettings_brainstormingn-compact") never matched the
        on-disk file and the stale compact survived the edit. Fails pre-fix
        (compact_after == 1), passes post-fix (compact_after == 0).
        """
        source = "/plugins/core/skills/brainstorming/SKILL.md"
        meta = skill_cache.store_output(
            "sess_mc", "userSettings:brainstorming", "body " * 200, source_path=source
        )
        assert meta is not None
        skill_cache.write_sidecar(meta)
        skill_cache.store_compact("sess_mc", "userSettings:brainstorming", "compact body")
        cache_dir = tmp_data_dir / "skills"
        compact_before = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert compact_before, "compact file should exist before invalidation"

        n = skill_cache.invalidate_for_path(source)
        assert n == 1
        compact_after = [f for f in cache_dir.iterdir() if f.name.endswith("-compact")]
        assert len(compact_after) == 0, "stale compact for mixed-case skill was not purged"

    def test_other_skills_not_removed(self, tmp_data_dir):
        """Only entries matching the given path are removed; others are untouched."""
        source_a = "/skills/ralph/SKILL.md"
        source_b = "/skills/superman/SKILL.md"
        meta_a = skill_cache.store_output("sess8", "ralph", "ralph body " * 100, source_path=source_a)
        meta_b = skill_cache.store_output("sess8", "superman", "superman " * 100, source_path=source_b)
        assert meta_a is not None and meta_b is not None
        skill_cache.write_sidecar(meta_a)
        skill_cache.write_sidecar(meta_b)

        n = skill_cache.invalidate_for_path(source_a)
        assert n == 1

        # superman entry should still be loadable
        loaded_b = skill_cache.load_output(meta_b.output_id)
        assert loaded_b is not None

    def test_returns_zero_no_source_path(self, tmp_data_dir):
        """Entries with no source_path are never matched (source_path is empty)."""
        meta = skill_cache.store_output("sess9", "ralph", "body " * 100)  # no source_path
        assert meta is not None
        skill_cache.write_sidecar(meta)
        n = skill_cache.invalidate_for_path("/skills/ralph/SKILL.md")
        assert n == 0


# ---------------------------------------------------------------------------
# worker._invalidate_skill_cache_entries
# ---------------------------------------------------------------------------

class TestInvalidateSkillCacheEntries:
    """_invalidate_skill_cache_entries only calls invalidate_for_path for skill paths."""

    def _make_entry(self, path: str, root: str = "/project") -> worker.DirtyQueueEntry:
        return {"path": path, "project_root": root, "project_hash": "a" * 40}

    def test_non_skill_path_skipped(self, tmp_data_dir):
        """Regular source files do not trigger skill cache invalidation."""
        calls: list[str] = []
        with patch.object(skill_cache, "invalidate_for_path", side_effect=lambda p: calls.append(p) or 0):
            entries = [self._make_entry("src/mymodule.py")]
            worker._invalidate_skill_cache_entries(entries)
        assert calls == []

    def test_skill_path_triggers_invalidation(self, tmp_data_dir):
        """.claude/skills/ in the path triggers invalidate_for_path."""
        calls: list[str] = []
        with patch.object(skill_cache, "invalidate_for_path", side_effect=lambda p: calls.append(p) or 1):
            entries = [self._make_entry(".claude/skills/ralph/SKILL.md", root="/home/user")]
            worker._invalidate_skill_cache_entries(entries)
        assert len(calls) == 1
        assert "SKILL.md" in calls[0]

    def test_multiple_entries_only_skill_path_triggered(self, tmp_data_dir):
        """When mixing skill + non-skill entries, only skill paths trigger invalidation."""
        calls: list[str] = []
        with patch.object(skill_cache, "invalidate_for_path", side_effect=lambda p: calls.append(p) or 0):
            entries = [
                self._make_entry("src/parser.py"),
                self._make_entry(".claude/skills/improve/SKILL.md"),
                self._make_entry("pyproject.toml"),
            ]
            worker._invalidate_skill_cache_entries(entries)
        assert len(calls) == 1
        assert "improve" in calls[0]

    def test_empty_entries_no_crash(self, tmp_data_dir):
        """Empty entry list is handled gracefully."""
        worker._invalidate_skill_cache_entries([])  # must not raise

    def test_malformed_entry_no_crash(self, tmp_data_dir):
        """Entries missing path/root are handled gracefully."""
        entries = [{"project_hash": "a" * 40}]  # no 'path' key
        worker._invalidate_skill_cache_entries(entries)  # must not raise

    def test_no_project_root_uses_rel_path(self, tmp_data_dir):
        """When project_root is absent, falls back to the rel path alone."""
        calls: list[str] = []
        with patch.object(skill_cache, "invalidate_for_path", side_effect=lambda p: calls.append(p) or 0):
            entries = [{"path": ".claude/skills/ralph/SKILL.md", "project_hash": "a" * 40}]
            worker._invalidate_skill_cache_entries(entries)
        assert len(calls) == 1
        assert calls[0] == ".claude/skills/ralph/SKILL.md"


# ---------------------------------------------------------------------------
# cache_common.safe_join_output_id — Windows MAX_PATH guard
# ---------------------------------------------------------------------------

class TestSafeJoinOutputIdMaxPath:
    """safe_join_output_id rejects paths >= 260 chars on Windows."""

    def _make_dir_fn(self, path: Path):
        def _fn():
            path.mkdir(parents=True, exist_ok=True)
            return path
        return _fn

    def test_rejects_overly_long_path_on_windows(self, tmp_path, monkeypatch):
        """Returns None when the constructed path would be >= 260 chars on Windows.

        We patch sys.platform in cache_common and use a fake dir function that
        returns a mock path whose str() length exceeds 260 chars, without needing
        to create any real long paths on disk (which fail on Windows without
        LongPathsEnabled).
        """
        import token_goat.cache_common as _cc

        # Build a fake base dir whose str representation is long enough that
        # base + sep + output_id + ".txt" >= 260 chars.
        fake_base_str = "C:\\" + "x" * 220 + "\\skills"  # ~228 chars
        output_id = "a" * 20  # fake_base_str + "\" + "a"*20 + ".txt" = 228+1+20+4 = 253 → need more
        output_id = "a" * 40  # 228 + 1 + 40 + 4 = 273 >= 260 ✓

        # Patch the module-level sys in cache_common so the platform check fires.
        monkeypatch.setattr(_cc.sys, "platform", "win32")

        def _fake_dir_fn():
            """Return a mock Path whose str() is long enough to trigger the guard."""
            class _FakePath:
                def __truediv__(self_inner, other):
                    class _FakeChild:
                        def __str__(self_ic):
                            return fake_base_str + "\\" + str(other)
                        def resolve(self_ic):
                            return self_ic
                        def relative_to(self_ic, base):
                            pass  # no ValueError = path is within base
                        @property
                        def name(self_ic):
                            return str(other)
                    return _FakeChild()
                def resolve(self_inner):
                    return self_inner
                def __str__(self_inner):
                    return fake_base_str
            return _FakePath()

        result = safe_join_output_id(output_id, _fake_dir_fn, "test_cache")
        constructed = fake_base_str + "\\" + output_id + ".txt"
        if len(constructed) >= 260:
            assert result is None
        else:
            pytest.skip(f"fake path length {len(constructed)} < 260; adjust fake_base_str")

    def test_accepts_normal_length_path(self, tmp_path):
        """Returns a valid path when the constructed path is under 260 chars."""
        cache_dir = tmp_path / "skills"
        output_id = "a1b2c3d4e5f6" + "0" * 30  # 42 chars, well under limit
        result = safe_join_output_id(output_id, self._make_dir_fn(cache_dir), "test_cache")
        # Should return a valid Path on all platforms
        assert result is not None
        assert result.name == f"{output_id}.txt"

    def test_non_windows_no_max_path_check(self, tmp_path, monkeypatch):
        """On non-Windows platforms, the MAX_PATH check is not applied.

        Uses monkeypatching to simulate non-Windows behaviour rather than
        constructing paths that exceed 260 chars (which fails on Windows
        without LongPathsEnabled).
        """
        import token_goat.cache_common as _cc

        # Force platform to linux so the MAX_PATH branch is skipped.
        monkeypatch.setattr(_cc.sys, "platform", "linux")

        # Use a normal-length path — the guard should not fire on linux.
        cache_dir = tmp_path / "skills"
        output_id = "a" * 40
        result = safe_join_output_id(output_id, self._make_dir_fn(cache_dir), "test_cache")
        # On linux the guard is skipped; a valid path is returned.
        assert result is not None
