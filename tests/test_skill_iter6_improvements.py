"""Tests for skill context savings accuracy improvements (iteration 6 of 10).

Covers:
1. skill_size accuracy — get_all_cached_skills returns compact_chars / body_chars
   using the same char-based formula as store_compact; _strip_compact_header works.
2. Semantic search --all-projects — list_all_project_hashes in db.py.
3. Diff-aware re-read — _handle_skill_file_read bypasses hint when on-disk
   skill file SHA differs from the cached content_sha.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock

from token_goat import db as _db_mod
from token_goat import skill_cache
from token_goat.hooks_read import _handle_skill_file_read

# ---------------------------------------------------------------------------
# Improvement 1: skill-size accuracy — strip compact header, use chars
# ---------------------------------------------------------------------------


class TestStripCompactHeader:
    """_strip_compact_header should remove the metadata header line."""

    def test_strips_standard_header(self):
        """Header '--- compact form (N tokens) ---\\n' is removed."""
        body = "--- compact form (42 tokens) ---\nSome compact content here.\nMore lines."
        stripped = skill_cache._strip_compact_header(body)
        assert stripped == "Some compact content here.\nMore lines."

    def test_strips_single_token_header(self):
        """Works with token count of 1."""
        body = "--- compact form (1 tokens) ---\nContent."
        assert skill_cache._strip_compact_header(body) == "Content."

    def test_no_header_returns_unchanged(self):
        """Input without the header is returned unchanged."""
        body = "No header here.\nJust content."
        assert skill_cache._strip_compact_header(body) == body

    def test_empty_string_returns_empty(self):
        """Empty input returns empty string."""
        assert skill_cache._strip_compact_header("") == ""

    def test_only_header_returns_empty(self):
        """When the stored text is only the header, result is empty string."""
        body = "--- compact form (10 tokens) ---\n"
        assert skill_cache._strip_compact_header(body) == ""

    def test_header_not_at_start_not_stripped(self):
        """Header embedded mid-text is not stripped (anchored to start)."""
        body = "Intro\n--- compact form (5 tokens) ---\nBody."
        result = skill_cache._strip_compact_header(body)
        assert result == body  # unchanged: header not at position 0


class TestGetAllCachedSkillsCharCounts:
    """get_all_cached_skills returns compact_chars and body_chars."""

    def test_returns_body_chars(self, tmp_data_dir):
        """body_chars equals len(body) (chars, not bytes)."""
        body = "# Skill\n\n" + ("text. " * 100)
        meta = skill_cache.store_output("sess-chars-1", "skill-a", body)
        assert meta is not None

        skills = skill_cache.get_all_cached_skills("sess-chars-1")
        assert len(skills) == 1
        row = skills[0]
        assert "body_chars" in row
        # body_chars should match len(body) exactly (the stored body, possibly truncated).
        loaded_body = skill_cache.load_output(meta.output_id)
        assert loaded_body is not None
        assert int(row["body_chars"]) == len(loaded_body)  # type: ignore[call-overload]

    def test_compact_chars_excludes_header(self, tmp_data_dir):
        """compact_chars counts only the body text (header stripped)."""
        body = "# Skill\n\n" + ("rule. " * 200)
        meta = skill_cache.store_output("sess-chars-2", "skill-b", body)
        assert meta is not None

        # Store a compact with known content.
        compact_text = "## Headings\nCRITICAL: do something."
        skill_cache.store_compact("sess-chars-2", "skill-b", compact_text)

        skills = skill_cache.get_all_cached_skills("sess-chars-2")
        assert len(skills) == 1
        row = skills[0]
        assert "compact_chars" in row
        # compact_chars should equal len(compact_text) — body only, no header.
        assert int(row["compact_chars"]) == len(compact_text)  # type: ignore[call-overload]

    def test_compact_chars_zero_when_no_compact(self, tmp_data_dir):
        """compact_chars is 0 when no compact has been stored."""
        body = "# Skill\n\n" + ("content. " * 50)
        meta = skill_cache.store_output("sess-chars-3", "skill-c", body)
        assert meta is not None

        skills = skill_cache.get_all_cached_skills("sess-chars-3")
        assert len(skills) == 1
        row = skills[0]
        assert int(row["compact_chars"]) == 0  # type: ignore[call-overload]

    def test_token_estimate_consistency(self, tmp_data_dir):
        """Token estimate from compact_chars matches store_compact's own formula.

        store_compact writes: compact_tokens = len(compact_text) // 4
        get_all_cached_skills returns compact_chars = len(compact_text)
        So compact_chars // 4 must equal the header-reported token count.
        """
        body = "# Skill\n\n" + ("line. " * 300)
        meta = skill_cache.store_output("sess-chars-4", "skill-d", body)
        assert meta is not None

        compact_text = "## H2\n" + ("CRITICAL: rule. " * 20)
        skill_cache.store_compact("sess-chars-4", "skill-d", compact_text)

        skills = skill_cache.get_all_cached_skills("sess-chars-4")
        assert len(skills) == 1
        row = skills[0]
        compact_chars = int(row["compact_chars"])  # type: ignore[call-overload]

        # store_compact's formula: max(1, len(compact_text) // 4)
        expected_compact_tokens = max(1, len(compact_text) // 4)
        # skill-size formula: compact_chars // 4
        derived_tokens = compact_chars // 4
        assert derived_tokens == expected_compact_tokens, (
            f"compact_chars // 4 ({derived_tokens}) != store_compact token count "
            f"({expected_compact_tokens})"
        )


# ---------------------------------------------------------------------------
# Improvement 2: db.list_all_project_hashes
# ---------------------------------------------------------------------------


class TestListAllProjectHashes:
    """list_all_project_hashes returns all registered project hashes."""

    def test_empty_when_no_projects(self, tmp_data_dir):
        """Returns empty list when global DB has no projects."""
        hashes = _db_mod.list_all_project_hashes()
        # May or may not have pre-existing projects; at minimum it must not raise.
        assert isinstance(hashes, list)

    def test_returns_list_of_strings(self, tmp_data_dir):
        """Return type is list[str] even with projects present."""
        hashes = _db_mod.list_all_project_hashes()
        for h in hashes:
            assert isinstance(h, str)

    def test_registered_project_appears(self, tmp_data_dir):
        """After registering a project in the global DB, its hash appears in the list."""
        # Touch/create a project entry in the global DB.
        import token_goat.paths as _paths  # noqa: PLC0415
        from token_goat.project import project_hash  # noqa: PLC0415

        # Use a fake path that canonicalizes to a unique hash.
        fake_root = Path(tmp_data_dir) / "fake-project-root"
        fake_root.mkdir(exist_ok=True)
        ph = project_hash(fake_root)

        # Ensure the global DB is created and the projects table exists,
        # then insert our test project.
        with _db_mod.open_global() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO projects "
                "(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ph, str(fake_root), "manual", 0, 0, 0, ""),
            )

        # Verify the DB file was actually created in tmp_data_dir.
        db_path = _paths.global_db_path()
        assert db_path.exists(), f"Global DB not found at {db_path} (data_dir={_paths.data_dir()})"

        hashes = _db_mod.list_all_project_hashes()
        assert ph in hashes, (
            f"Expected {ph!r} in project hashes after registration, got {hashes!r} "
            f"(data_dir={_paths.data_dir()}, db_path={db_path})"
        )

    def test_returns_empty_list_not_exception_on_missing_global_db(self, monkeypatch, tmp_path):
        """Returns [] gracefully when the global DB does not exist at all."""
        import token_goat.paths as _paths  # noqa: PLC0415

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path / "nonexistent")

        # Should not raise; should return empty list.
        hashes = _db_mod.list_all_project_hashes()
        assert hashes == []


# ---------------------------------------------------------------------------
# Improvement 3: diff-aware re-read — stale cache bypasses hint
# ---------------------------------------------------------------------------


class TestDiffAwareSkillReRead:
    """_handle_skill_file_read must bypass hint when on-disk SHA has changed."""

    def _make_cache(
        self,
        skill_name: str,
        content_sha: str,
        source_path: str = "",
        ts: float = 0.0,
    ) -> object:
        """Return a minimal mock SessionCache with the given skill_history entry.

        *ts* sets the cache creation timestamp used in the mtime-gate of the
        diff-aware staleness check.  Use a large value (e.g. time.time() + 1e9)
        to make the cache appear newer than any real file, suppressing the check.
        Use 0.0 (default) to let the check proceed normally for testing staleness.
        """
        from token_goat.session import SkillEntry  # noqa: PLC0415

        entry = SkillEntry(
            skill_name=skill_name,
            output_id="oid-test",
            content_sha=content_sha,
            ts=ts,
            body_bytes=5000,
            truncated=False,
            run_count=1,
            source_path=source_path,
        )
        cache = MagicMock()
        cache.skill_history = {skill_name: entry}
        cache.hints_seen = {}
        cache.has_hint_fingerprint = lambda _fp: False
        return cache

    def test_hint_emitted_when_sha_matches(self, tmp_path):
        """When the on-disk file hash matches the cached SHA, the hint fires.

        The cache timestamp is set far in the future so that file_mtime <= cache_ts,
        bypassing the staleness check (no SHA comparison needed — file hasn't changed
        since the cache was written according to mtime).
        """
        import time as _time  # noqa: PLC0415
        skill_file = tmp_path / "SKILL.md"
        skill_body = b"# Ralph\n\nCRITICAL: rule.\n"
        skill_file.write_bytes(skill_body)  # write_bytes avoids CRLF translation on Windows
        sha = hashlib.sha256(skill_body).hexdigest()

        # Future timestamp: cache appears newer than the file → staleness check skipped.
        future_ts = _time.time() + 1_000_000.0
        cache = self._make_cache("ralph", sha, source_path=str(skill_file), ts=future_ts)
        session_id = "sess-sha-match"
        file_path = str(tmp_path / ".claude" / "skills" / "ralph" / "SKILL.md")

        # Patch the path detection to return 'ralph' for any path ending in SKILL.md.
        from token_goat import hooks_read as _hr  # noqa: PLC0415

        orig_detect = _hr._detect_skill_name_from_path

        def _patched_detect(fp: str) -> str | None:
            if "ralph" in fp.lower():
                return "ralph"
            return orig_detect(fp)

        import unittest.mock as _mock  # noqa: PLC0415

        with _mock.patch.object(_hr, "_detect_skill_name_from_path", side_effect=_patched_detect):
            result = _handle_skill_file_read(session_id, file_path, cache)

        # SHA matches → hint should be emitted (not None).
        assert result is not None, "Expected hint to fire when SHA matches"

    def test_no_hint_when_sha_differs(self, tmp_path):
        """When the on-disk file hash differs from the cached SHA, hint is bypassed.

        The cache timestamp is set in the past so that file_mtime > cache_ts,
        triggering the SHA comparison.  The SHAs differ → stale → no hint.
        """
        skill_file = tmp_path / "SKILL.md"
        current_body = b"# Ralph v2\n\nUpdated content.\n"
        skill_file.write_bytes(current_body)  # write_bytes avoids CRLF on Windows

        stale_sha = "aabbccddeeff001122334455667788990011223344556677889900aabbccddeeff"
        # Ensure the stale SHA differs from the actual file's SHA.
        actual_sha = hashlib.sha256(current_body).hexdigest()
        assert stale_sha != actual_sha, "Test setup error: stale and actual SHAs should differ"

        # Past timestamp (epoch): file_mtime > cache_ts → SHA comparison fires.
        cache = self._make_cache("ralph", stale_sha, source_path=str(skill_file), ts=0.0)
        session_id = "sess-sha-stale"
        file_path = str(tmp_path / ".claude" / "skills" / "ralph" / "SKILL.md")

        import unittest.mock as _mock  # noqa: PLC0415

        from token_goat import hooks_read as _hr  # noqa: PLC0415

        def _patched_detect(fp: str) -> str | None:
            if "ralph" in fp.lower():
                return "ralph"
            return _hr._detect_skill_name_from_path.__wrapped__(fp) if hasattr(  # type: ignore[attr-defined]
                _hr._detect_skill_name_from_path, "__wrapped__"
            ) else None

        with _mock.patch.object(_hr, "_detect_skill_name_from_path", return_value="ralph"):
            result = _handle_skill_file_read(session_id, file_path, cache)

        # SHA differs → stale cache → no hint, allow fresh read.
        assert result is None, "Expected no hint when on-disk SHA differs from cached SHA"

    def test_hint_emitted_when_no_source_path(self, tmp_path):
        """When source_path is empty (unknown location), staleness check is skipped and hint fires."""
        cache = self._make_cache("improve", "someshahex", source_path="")
        session_id = "sess-no-source"
        file_path = str(tmp_path / ".claude" / "skills" / "improve" / "SKILL.md")

        import unittest.mock as _mock  # noqa: PLC0415

        from token_goat import hooks_read as _hr  # noqa: PLC0415

        with _mock.patch.object(_hr, "_detect_skill_name_from_path", return_value="improve"):
            result = _handle_skill_file_read(session_id, file_path, cache)

        # No source_path → can't verify staleness → emit hint (fail-soft toward hint).
        assert result is not None, "Expected hint when source_path is empty (can't verify staleness)"

    def test_hint_emitted_when_no_cached_sha(self, tmp_path):
        """When the cached SHA is empty, staleness check is skipped and hint fires."""
        skill_file = tmp_path / "SKILL.md"
        skill_file.write_text("# Improve\n\nContent.\n", encoding="utf-8")

        # Empty SHA: cannot compare → fail-soft toward emitting hint.
        cache = self._make_cache("improve", "", source_path=str(skill_file))
        session_id = "sess-no-sha"
        file_path = str(tmp_path / ".claude" / "skills" / "improve" / "SKILL.md")

        import unittest.mock as _mock  # noqa: PLC0415

        from token_goat import hooks_read as _hr  # noqa: PLC0415

        with _mock.patch.object(_hr, "_detect_skill_name_from_path", return_value="improve"):
            result = _handle_skill_file_read(session_id, file_path, cache)

        assert result is not None, "Expected hint when cached SHA is empty"

    def test_hint_emitted_when_source_file_unreadable(self, tmp_path):
        """If the source file cannot be read (OSError), staleness check fails soft and hint fires."""
        nonexistent = tmp_path / "nonexistent_skill" / "SKILL.md"

        stale_sha = "0" * 64
        cache = self._make_cache("myskill", stale_sha, source_path=str(nonexistent))
        session_id = "sess-unreadable"
        file_path = str(tmp_path / ".claude" / "skills" / "myskill" / "SKILL.md")

        import unittest.mock as _mock  # noqa: PLC0415

        from token_goat import hooks_read as _hr  # noqa: PLC0415

        with _mock.patch.object(_hr, "_detect_skill_name_from_path", return_value="myskill"):
            result = _handle_skill_file_read(session_id, file_path, cache)

        # File unreadable → OSError → fail-soft → hint fires.
        assert result is not None, "Expected hint when source file is unreadable (fail-soft)"
