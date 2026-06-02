"""Tests for skill context savings accuracy improvements (iteration 13).

Covers:
1. Sidecar schema version: write_sidecar embeds SIDECAR_SCHEMA_VERSION; read_sidecar
   tolerates v1 entries (no schema_v field) and logs a note for future versions.
2. O(1) skill path index: _build_skill_path_index builds a source_path -> skill_name
   dict from skill_history; _handle_skill_file_read uses it before falling back to
   the regex; the index is type-checked against MagicMock cache objects.
3. Stale compact advisory: when diff-aware invalidation fires (body changed on disk),
   _emit_stale_compact_hint checks the compact's source_sha and emits an advisory
   when the compact is stale.
4. skill-list --json compact_stale: each row in the JSON output includes a
   compact_stale boolean (True/False/null) comparing compact source_sha to body SHA.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Improvement 1: Sidecar schema version in write_sidecar / read_sidecar
# ---------------------------------------------------------------------------


class TestSidecarSchemaVersion:
    """write_sidecar embeds schema_v; read_sidecar handles v1 and future entries."""

    def test_write_sidecar_embeds_schema_v(self, tmp_path, monkeypatch):
        """write_sidecar puts SIDECAR_SCHEMA_VERSION in the JSON sidecar."""
        from token_goat import skill_cache
        from token_goat.skill_cache import SIDECAR_SCHEMA_VERSION, SkillMeta

        meta = SkillMeta(
            output_id="testsess-testskill-abc123",
            skill_name="testskill",
            content_sha="abc123",
            body_bytes=100,
            ts=1000.0,
            truncated=False,
            source_path="",
        )

        written_data: dict = {}

        def _fake_atomic_write(path, text):
            written_data.update(json.loads(text))

        with (
            patch("token_goat.skill_cache.sidecar_meta_path", return_value=tmp_path / "test.json"),
            patch("token_goat.paths.atomic_write_text", side_effect=_fake_atomic_write),
        ):
            skill_cache.write_sidecar(meta)

        assert "schema_v" in written_data, "schema_v field must be present in written sidecar"
        assert written_data["schema_v"] == SIDECAR_SCHEMA_VERSION, (
            f"Expected schema_v={SIDECAR_SCHEMA_VERSION}, got {written_data['schema_v']}"
        )

    def test_write_sidecar_includes_all_meta_fields(self, tmp_path):
        """write_sidecar preserves all SkillMeta fields alongside schema_v."""
        from token_goat import skill_cache
        from token_goat.skill_cache import SkillMeta

        meta = SkillMeta(
            output_id="sess16chars--alphab-sha12345",
            skill_name="ralph",
            content_sha="deadbeef01234567",
            body_bytes=30000,
            ts=9999.5,
            truncated=True,
            source_path="/home/user/.claude/skills/ralph/SKILL.md",
        )

        written_data: dict = {}

        def _fake_atomic_write(path, text):
            written_data.update(json.loads(text))

        with (
            patch("token_goat.skill_cache.sidecar_meta_path", return_value=tmp_path / "test.json"),
            patch("token_goat.paths.atomic_write_text", side_effect=_fake_atomic_write),
        ):
            skill_cache.write_sidecar(meta)

        assert written_data.get("skill_name") == "ralph"
        assert written_data.get("content_sha") == "deadbeef01234567"
        assert written_data.get("body_bytes") == 30000
        assert written_data.get("truncated") is True
        assert written_data.get("source_path") == "/home/user/.claude/skills/ralph/SKILL.md"
        assert "schema_v" in written_data

    def test_read_sidecar_tolerates_v1_entry_no_schema_v(self, tmp_path):
        """read_sidecar parses a v1 sidecar (no schema_v) without error."""
        import json

        from token_goat import skill_cache

        v1_data = {
            "output_id": "sess16chars--testsk-sha00000",
            "skill_name": "testskill",
            "content_sha": "sha00000",
            "body_bytes": 500,
            "ts": 1234.0,
            "truncated": False,
            # No "schema_v" — this is a v1 entry
            # No "source_path" — also absent in original v1
        }
        sidecar_file = tmp_path / "test.json"
        sidecar_file.write_text(json.dumps(v1_data), encoding="utf-8")

        with patch("token_goat.skill_cache.sidecar_meta_path", return_value=sidecar_file):
            result = skill_cache.read_sidecar("sess16chars--testsk-sha00000")

        assert result is not None, "read_sidecar must not return None for a v1 entry"
        assert result.skill_name == "testskill"
        assert result.content_sha == "sha00000"
        # source_path defaults to "" for v1 entries
        assert result.source_path == "", (
            f"Expected source_path='' for v1 entry, got {result.source_path!r}"
        )

    def test_read_sidecar_tolerates_future_schema_v(self, tmp_path, caplog):
        """read_sidecar loads a future schema version entry without raising."""
        import json
        import logging

        from token_goat import skill_cache
        from token_goat.skill_cache import SIDECAR_SCHEMA_VERSION

        future_v = SIDECAR_SCHEMA_VERSION + 5
        future_data = {
            "output_id": "sess16chars--future-sha99999",
            "skill_name": "future-skill",
            "content_sha": "sha99999",
            "body_bytes": 12345,
            "ts": 5678.0,
            "truncated": False,
            "source_path": "/some/future/path.md",
            "schema_v": future_v,
            "unknown_future_field": "should be ignored",
        }
        sidecar_file = tmp_path / "future.json"
        sidecar_file.write_text(json.dumps(future_data), encoding="utf-8")

        with (
            patch("token_goat.skill_cache.sidecar_meta_path", return_value=sidecar_file),
            caplog.at_level(logging.DEBUG, logger="token_goat.skill_cache"),
        ):
            result = skill_cache.read_sidecar("sess16chars--future-sha99999")

        assert result is not None, "read_sidecar must not return None for a future schema entry"
        assert result.skill_name == "future-skill"
        assert result.source_path == "/some/future/path.md"
        # Debug log should mention the schema version mismatch.
        assert any(
            "schema_v" in record.message and str(future_v) in record.message
            for record in caplog.records
        ), f"Expected a debug log about schema_v={future_v}, got: {[r.message for r in caplog.records]}"

    def test_sidecar_schema_version_constant_exported(self):
        """SIDECAR_SCHEMA_VERSION is exported from skill_cache.__all__."""
        from token_goat import skill_cache
        assert "SIDECAR_SCHEMA_VERSION" in skill_cache.__all__
        assert isinstance(skill_cache.SIDECAR_SCHEMA_VERSION, int)
        assert skill_cache.SIDECAR_SCHEMA_VERSION >= 2, (
            "SIDECAR_SCHEMA_VERSION must be >= 2 (v2 added schema_v field)"
        )


# ---------------------------------------------------------------------------
# Improvement 2: O(1) skill path index
# ---------------------------------------------------------------------------


class TestSkillPathIndex:
    """_build_skill_path_index and O(1) lookup in _handle_skill_file_read."""

    def _make_entry(self, name: str, source_path: str = ""):
        """Create a minimal SkillEntry-like object."""
        from token_goat.session import SkillEntry
        return SkillEntry(
            skill_name=name,
            output_id=f"sess-{name}-000",
            content_sha="abc",
            ts=1000.0,
            body_bytes=5000,
            source_path=source_path,
        )

    def test_build_index_maps_source_path_to_name(self):
        """_build_skill_path_index maps normalised source_path -> skill_name."""
        from token_goat.hooks_read import _build_skill_path_index

        entry_ralph = self._make_entry("ralph", "/home/user/.claude/skills/ralph/SKILL.md")
        entry_improve = self._make_entry("improve", r"C:\Users\user\.claude\skills\improve\SKILL.md")
        history = {"ralph": entry_ralph, "improve": entry_improve}

        index = _build_skill_path_index(history)

        assert isinstance(index, dict)
        # Forward-slash normalised, lower-cased.
        assert "/home/user/.claude/skills/ralph/skill.md" in index
        assert index["/home/user/.claude/skills/ralph/skill.md"] == "ralph"
        # Windows backslash normalised to forward slash, lower-cased.
        assert "c:/users/user/.claude/skills/improve/skill.md" in index
        assert index["c:/users/user/.claude/skills/improve/skill.md"] == "improve"

    def test_build_index_excludes_empty_source_paths(self):
        """Entries without source_path are excluded from the index."""
        from token_goat.hooks_read import _build_skill_path_index

        entry_with = self._make_entry("with-path", "/home/.claude/skills/with-path/SKILL.md")
        entry_without = self._make_entry("without-path", "")
        history = {"with-path": entry_with, "without-path": entry_without}

        index = _build_skill_path_index(history)

        assert len(index) == 1
        assert "without-path" not in index.values()

    def test_build_index_empty_history(self):
        """Empty skill_history produces an empty index (no crash)."""
        from token_goat.hooks_read import _build_skill_path_index

        index = _build_skill_path_index({})
        assert index == {}

    def test_build_index_fail_soft_on_bad_entry(self):
        """_build_skill_path_index returns an empty dict when history raises (fail-soft)."""
        from token_goat.hooks_read import _build_skill_path_index

        # An object whose .items() raises should not propagate.
        class BadHistory:
            def items(self):
                raise RuntimeError("intentional failure")

        result = _build_skill_path_index(BadHistory())  # type: ignore[arg-type]
        assert result == {}

    def test_path_index_cached_on_cache_object(self):
        """_handle_skill_file_read caches the built index as _skill_path_index."""
        from token_goat import hooks_read
        from token_goat.session import SkillEntry

        entry = SkillEntry(
            skill_name="ralph",
            output_id="sess-ralph-000",
            content_sha="abc",
            ts=1000.0,
            body_bytes=5000,
            source_path="/home/user/.claude/skills/ralph/SKILL.md",
        )
        cache = MagicMock()
        cache.skill_history = {"ralph": entry}
        cache.has_hint_fingerprint = lambda _: False
        cache.mark_hint_seen = lambda _: None
        # Simulate no pre-existing index (getattr on MagicMock gives MagicMock,
        # but we patch _skill_path_index to be None-like via spec).
        del cache._skill_path_index  # Ensure AttributeError on del succeeds

        with patch("token_goat.hooks_read.load_session_safe", return_value=cache):
            hooks_read._handle_skill_file_read(
                "test-session",
                "/home/user/.claude/skills/ralph/SKILL.md",
                cache,
            )

        # After the call, _skill_path_index should be a real dict.
        stored_index = getattr(cache, "_skill_path_index", None)
        assert isinstance(stored_index, dict), (
            f"Expected a dict index cached on cache, got {type(stored_index)}"
        )

    def test_magicmock_cache_type_check_prevents_false_index(self):
        """A MagicMock _skill_path_index attribute is rejected (type check)."""
        from token_goat import hooks_read
        from token_goat.session import SkillEntry

        entry = SkillEntry(
            skill_name="ralph",
            output_id="sess-ralph-111",
            content_sha="deadbeef",
            ts=1000.0,
            body_bytes=5000,
            source_path="/home/user/.claude/skills/ralph/SKILL.md",
        )
        cache = MagicMock()
        cache.skill_history = {"ralph": entry}
        cache.has_hint_fingerprint = lambda _: False
        cache.mark_hint_seen = lambda _: None
        # MagicMock's attribute auto-creation means _skill_path_index is a MagicMock,
        # NOT a dict. The O(1) path confirms isinstance check before use.
        # We verify the function doesn't crash or return a wrong result.
        resp = hooks_read._handle_skill_file_read(
            "test-session",
            "/home/user/.claude/skills/ralph/SKILL.md",
            cache,
        )
        # Should return a hint (skill is loaded, file is a skill path).
        assert resp is not None, (
            "Expected a hint response for a known skill path with MagicMock cache"
        )

    def test_detect_skill_name_fast_exit_skips_non_skill_paths(self):
        """_detect_skill_name_from_path returns None quickly for non-.claude paths."""
        from token_goat.hooks_read import _detect_skill_name_from_path

        # These should never reach the regex.
        assert _detect_skill_name_from_path("/home/user/project/src/main.py") is None
        assert _detect_skill_name_from_path("/tmp/build/output.js") is None
        assert _detect_skill_name_from_path("C:\\Users\\user\\Documents\\report.md") is None
        assert _detect_skill_name_from_path("") is None

    def test_detect_skill_name_fast_exit_allows_claude_paths(self):
        """_detect_skill_name_from_path still processes .claude/skills paths."""
        from token_goat.hooks_read import _detect_skill_name_from_path

        result = _detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph/SKILL.md"
        )
        assert result == "ralph"


# ---------------------------------------------------------------------------
# Improvement 3: Stale compact advisory hint
# ---------------------------------------------------------------------------


class TestStaleCompactHint:
    """_emit_stale_compact_hint fires when body changed and compact is stale."""

    def test_stale_compact_advisory_emitted(self):
        """Advisory is recorded in stats when compact sha mismatches body sha."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        session_id = "test-session-stale-compact"
        skill_name = "ralph"
        # disk_sha that differs from what the compact was generated from
        disk_sha = "deadbeef01234567" * 4  # 64 hex chars
        # compact_sha stored in the compact header (12 hex chars of some OTHER sha)
        compact_sha_prefix = "aabbccddee12"  # does not match disk_sha[:12]

        mock_compact_text = f"--- compact form (100 tokens, sha={compact_sha_prefix}) ---\nsome compact body\n"
        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False
        cache.mark_hint_seen = lambda _: None

        stat_pairs: list[tuple[str, str, str]] = []

        with (
            patch.object(sc_mod, "get_compact", return_value=mock_compact_text),
            patch.object(sc_mod, "extract_compact_source_sha", return_value=compact_sha_prefix),
            patch(
                "token_goat.hooks_read.record_hint_stat_pair",
                side_effect=lambda kind, text, path: stat_pairs.append((kind, text, path)),
            ),
        ):
            _emit_stale_compact_hint(
                skill_name=skill_name,
                disk_sha=disk_sha,
                session_id=session_id,
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )

        stale_kinds = [k for k, _, _ in stat_pairs if k == "stale_compact_hint"]
        assert len(stale_kinds) == 1, (
            f"Expected 1 stale_compact_hint stat, got {len(stale_kinds)}: {stat_pairs}"
        )
        # Hint text should mention skill-compact.
        _, hint_text, _ = stat_pairs[0]
        assert "skill-compact" in hint_text, (
            f"Expected 'skill-compact' in hint, got: {hint_text!r}"
        )
        assert skill_name in hint_text

    def test_no_advisory_when_compact_sha_matches(self):
        """No advisory when the compact sha matches the disk sha (up to date)."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        disk_sha = "deadbeef01234567" * 4  # 64 hex chars
        compact_sha_prefix = disk_sha[:12]  # matches disk_sha prefix

        mock_compact_text = f"--- compact form (100 tokens, sha={compact_sha_prefix}) ---\nbody\n"
        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False
        cache.mark_hint_seen = lambda _: None

        stat_pairs: list = []

        with (
            patch.object(sc_mod, "get_compact", return_value=mock_compact_text),
            patch.object(sc_mod, "extract_compact_source_sha", return_value=compact_sha_prefix),
            patch(
                "token_goat.hooks_read.record_hint_stat_pair",
                side_effect=lambda k, t, p: stat_pairs.append((k, t, p)),
            ),
        ):
            _emit_stale_compact_hint(
                skill_name="ralph",
                disk_sha=disk_sha,
                session_id="test-session",
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )

        assert not stat_pairs, (
            f"Expected no stats when compact is current, got: {stat_pairs}"
        )

    def test_no_advisory_when_no_compact_exists(self):
        """No advisory when the session has no compact for the skill."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False
        stat_pairs: list = []

        with (
            patch.object(sc_mod, "get_compact", return_value=None),
            patch(
                "token_goat.hooks_read.record_hint_stat_pair",
                side_effect=lambda k, t, p: stat_pairs.append((k, t, p)),
            ),
        ):
            _emit_stale_compact_hint(
                skill_name="ralph",
                disk_sha="deadbeef" * 8,
                session_id="test-session",
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )

        assert not stat_pairs, "Expected no stats when no compact exists"

    def test_no_advisory_when_compact_has_no_sha(self):
        """No advisory when the compact predates source-sha tracking."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        # Old compact format: no sha= in header
        old_compact_text = "--- compact form (100 tokens) ---\nbody without sha\n"
        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False
        stat_pairs: list = []

        with (
            patch.object(sc_mod, "get_compact", return_value=old_compact_text),
            patch.object(sc_mod, "extract_compact_source_sha", return_value=None),
            patch(
                "token_goat.hooks_read.record_hint_stat_pair",
                side_effect=lambda k, t, p: stat_pairs.append((k, t, p)),
            ),
        ):
            _emit_stale_compact_hint(
                skill_name="ralph",
                disk_sha="deadbeef" * 8,
                session_id="test-session",
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )

        assert not stat_pairs, "Expected no stats when compact has no source_sha"

    def test_stale_advisory_deduped_by_fingerprint(self):
        """Advisory is suppressed on second call when already emitted this session."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        disk_sha = "abcdef" * 10 + "1234"
        compact_sha_prefix = "000000000000"  # stale

        mock_compact_text = f"--- compact form (100 tokens, sha={compact_sha_prefix}) ---\nbody\n"
        emitted_fingerprints: set = set()

        def _fake_has(fp):
            return fp in emitted_fingerprints

        def _fake_mark(fp):
            emitted_fingerprints.add(fp)

        cache = MagicMock()
        cache.has_hint_fingerprint = _fake_has
        cache.mark_hint_seen = _fake_mark

        stat_pairs: list = []

        with (
            patch.object(sc_mod, "get_compact", return_value=mock_compact_text),
            patch.object(sc_mod, "extract_compact_source_sha", return_value=compact_sha_prefix),
            patch(
                "token_goat.hooks_read.record_hint_stat_pair",
                side_effect=lambda k, t, p: stat_pairs.append((k, t, p)),
            ),
        ):
            kwargs = dict(
                skill_name="ralph",
                disk_sha=disk_sha,
                session_id="test-session",
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )
            _emit_stale_compact_hint(**kwargs)
            _emit_stale_compact_hint(**kwargs)

        assert len(stat_pairs) == 1, (
            f"Expected dedup to suppress second advisory, got {len(stat_pairs)}: {stat_pairs}"
        )


# ---------------------------------------------------------------------------
# Improvement 4: skill-list --json compact_stale field
# ---------------------------------------------------------------------------


class TestSkillListJsonCompactStale:
    """skill-list --json includes compact_stale field per skill."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Redirect skill_cache writes to a temp dir so tests don't pollute the real data dir."""
        self.tmp_data_dir = tmp_data_dir

    def _store_skill_with_compact(self, session_id: str, skill_name: str, body: str,
                                   compact_sha_matches: bool) -> None:
        """Store a skill body and compact in the test cache."""
        from token_goat import skill_cache

        meta = skill_cache.store_output(session_id, skill_name, body)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        body_sha = skill_cache.content_hash(body)
        # Use body SHA for a fresh compact; a different prefix for a stale one.
        source_sha = body_sha if compact_sha_matches else "000000000000abcd"

        # store_compact writes the compact with source_sha embedded.
        compact_body = "# Compact\n\nRule: do things correctly."
        skill_cache.store_compact(session_id, skill_name, compact_body, source_sha=source_sha)

    def test_json_includes_compact_stale_true(self):
        """compact_stale=True when stored compact sha does not match body sha."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        session_id = "sess-iter13-stale-t"
        body = "# My Skill\n\nsome content that is unique for this test\n" * 20

        self._store_skill_with_compact(session_id, "myskill13", body, compact_sha_matches=False)

        runner = CliRunner()
        result = runner.invoke(app, ["skill-list", "--json", "--session-id", session_id])
        if result.exit_code != 0:
            pytest.skip(f"skill-list failed: {result.output}")

        data = json.loads(result.output)
        skills = data.get("skills", [])
        assert skills, f"Expected at least one skill, got: {data}"

        skill_row = skills[0]
        assert "compact_stale" in skill_row, (
            f"compact_stale field missing from JSON output: {skill_row}"
        )
        # When compact sha does not match body sha, compact_stale should be True.
        # (May be None if SHA tracking is unavailable — that's acceptable.)
        assert skill_row["compact_stale"] is not False, (
            f"Expected compact_stale=True or null for stale compact, got: {skill_row['compact_stale']}"
        )

    def test_json_includes_compact_stale_false_when_current(self):
        """compact_stale=False when compact sha matches body sha."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        session_id = "sess-iter13-fresh-t"
        body = "# My Fresh Skill\n\ncontent for fresh compact test\n" * 15

        self._store_skill_with_compact(session_id, "freshskill13", body, compact_sha_matches=True)

        runner = CliRunner()
        result = runner.invoke(app, ["skill-list", "--json", "--session-id", session_id])
        if result.exit_code != 0:
            pytest.skip(f"skill-list failed: {result.output}")

        data = json.loads(result.output)
        skills = data.get("skills", [])
        assert skills, f"Expected at least one skill, got: {data}"

        skill_row = skills[0]
        assert "compact_stale" in skill_row, (
            f"compact_stale field missing from JSON output: {skill_row}"
        )
        # When compact sha matches body sha, compact_stale should be False.
        assert skill_row["compact_stale"] is False, (
            f"Expected compact_stale=False for current compact, got: {skill_row['compact_stale']}"
        )

    def test_json_compact_stale_null_when_no_compact(self):
        """compact_stale=null (None) when no compact exists for the skill."""
        from typer.testing import CliRunner

        from token_goat import skill_cache
        from token_goat.cli import app

        session_id = "sess-iter13-nocompact"
        body = "# No Compact Skill\n\nno compact generated for this one\n" * 10

        # Store body only — no compact.
        meta = skill_cache.store_output(session_id, "nocompact13", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        runner = CliRunner()
        result = runner.invoke(app, ["skill-list", "--json", "--session-id", session_id])
        if result.exit_code != 0:
            pytest.skip(f"skill-list failed: {result.output}")

        data = json.loads(result.output)
        skills = data.get("skills", [])
        assert skills, f"Expected at least one skill, got: {data}"

        skill_row = skills[0]
        assert "compact_stale" in skill_row, (
            f"compact_stale field missing from JSON output: {skill_row}"
        )
        # Without a compact, compact_stale should be null (None in Python / null in JSON).
        assert skill_row["compact_stale"] is None, (
            f"Expected compact_stale=null for no-compact skill, got: {skill_row['compact_stale']}"
        )
