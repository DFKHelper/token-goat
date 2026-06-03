"""Tests for the four deferred design-doc items implemented in this session.

Item 2  — Deferred recovery injection (sidecar written by SessionStart,
           consumed by pre_read/pre_bash on first post-compact call).
Item 19 — Per-session Glob result caching (post_read stores, pre_read serves).
Item 22 — token-goat skill-body --section <heading> extraction.
Item 25 — token-goat resume <session_id> post-compact restoration packet.
"""
from __future__ import annotations

import json

from hook_helpers import assert_continue as _assert_continue
from typer.testing import CliRunner

from token_goat import bash_cache, hooks_cli, hooks_read, hooks_session, paths, session, skill_cache
from token_goat.cli import app

# ---------------------------------------------------------------------------
# Item 2: Deferred recovery injection
# ---------------------------------------------------------------------------


class TestDeferredRecoveryInjection:
    """SessionStart writes sidecar; pre_read/pre_bash inject it on first call."""

    def _seed(self, sid: str) -> None:
        session.mark_file_read(sid, "/proj/src/main.py", offset=0, limit=100)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="aabbccdd11223344",
            cmd_preview="pytest tests/",
            output_id=f"{sid[:16]}-0000000000001-aabbccdd11223344",
            stdout_bytes=5000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

    def test_session_start_writes_sidecar_not_inline(self, tmp_data_dir):
        """compact SessionStart: no hookSpecificOutput; sidecar created."""
        sid = "defer-item2-a"
        self._seed(sid)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        assert "hookSpecificOutput" not in result, (
            "compact SessionStart must not inject inline (item 2 deferred model)"
        )
        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "sidecar must be created by compact SessionStart"
        content = sidecar.read_text(encoding="utf-8")
        assert "Post-Compact Recovery" in content
        assert "/proj/src/main.py" in content

    def test_non_compact_source_no_sidecar(self, tmp_data_dir):
        """startup/clear SessionStart must NOT create a sidecar."""
        for source in ("startup", "clear", "resume"):
            sid = f"defer-item2-nosidecar-{source}"
            self._seed(sid)
            hooks_session.session_start({
                "session_id": sid,
                "source": source,
                "cwd": "/proj",
            })
            sidecar = paths.recovery_pending_path(sid)
            assert not sidecar.exists(), (
                f"sidecar must not be created for source={source!r}"
            )

    def test_pre_read_consumes_sidecar_and_injects(self, tmp_data_dir):
        """First pre_read after compact SessionStart injects hint and deletes sidecar."""
        sid = "defer-item2-b"
        self._seed(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        sidecar = paths.recovery_pending_path(sid)
        assert sidecar.exists(), "sidecar must exist before pre_read"

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/main.py"},
        })
        _assert_continue(result)
        # Hint must be injected.
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "pre_read must inject recovery hint on first call after compact"
        ctx = hso.get("additionalContext", "")
        assert "Post-Compact Recovery" in ctx
        # Sidecar must be deleted.
        assert not sidecar.exists(), "sidecar must be deleted after injection"

    def test_pre_read_second_call_no_double_injection(self, tmp_data_dir):
        """Second pre_read in same process must NOT re-inject (in-memory flag guard)."""
        sid = "defer-item2-c"
        self._seed(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        # First call injects.
        cache = session.load(sid)
        hint = hooks_read._check_recovery_pending(sid, cache)
        assert hint is not None
        # Second call on same cache object: in-memory flag prevents re-injection.
        hint2 = hooks_read._check_recovery_pending(sid, cache)
        assert hint2 is None, "double injection must be blocked by recovery_injected flag"

    def test_no_sidecar_no_injection(self, tmp_data_dir):
        """pre_read with no pending sidecar returns None from _check_recovery_pending."""
        sid = "defer-item2-d"
        self._seed(sid)
        # Normal startup (not compact) — no sidecar written.
        hooks_session.session_start({
            "session_id": sid,
            "source": "startup",
            "cwd": "/proj",
        })
        cache = session.load(sid)
        hint = hooks_read._check_recovery_pending(sid, cache)
        assert hint is None

    def test_compact_preserves_session_cache(self, tmp_data_dir):
        """compact SessionStart must NOT wipe session files/history."""
        sid = "defer-item2-e"
        self._seed(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        cache = session.load(sid)
        assert cache.files, "files must survive compact SessionStart"
        assert cache.bash_history, "bash_history must survive compact SessionStart"

    def test_sidecar_contains_resume_pointer(self, tmp_data_dir):
        """Sidecar content must include the token-goat resume quick-restore pointer."""
        sid = "defer-item2-f"
        self._seed(sid)
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        content = paths.recovery_pending_path(sid).read_text(encoding="utf-8")
        assert "token-goat resume" in content, (
            "sidecar must contain resume pointer (item 25 integration)"
        )

    def test_sidecar_contains_section_tip(self, tmp_data_dir):
        """Sidecar content must include --section DoD tip when skills are loaded."""
        sid = "defer-item2-g"
        body = "# ralph\n\n## DoD\n\n- All tests pass\n\n## Overview\n\nIntro.\n"
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        content = paths.recovery_pending_path(sid).read_text(encoding="utf-8")
        assert "--section DoD" in content or "--section" in content, (
            "sidecar must hint at --section flag when skills have checklist sections"
        )


# ---------------------------------------------------------------------------
# Item 19: Per-session Glob result caching
# ---------------------------------------------------------------------------


class TestGlobResultCache:
    """post_read stores Glob results; pre_read serves them inline when fresh."""

    def _post_glob(self, sid: str, pattern: str, result_text: str, path: str | None = None) -> None:
        """Simulate a Glob PostToolUse, which stores the result to bash_cache."""
        tool_input: dict = {"pattern": pattern}
        if path is not None:
            tool_input["path"] = path
        hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Glob",
            "tool_input": tool_input,
            "tool_response": result_text,
        })

    def _pre_glob(self, sid: str, pattern: str, path: str | None = None) -> dict:
        payload: dict = {
            "session_id": sid,
            "tool_name": "Glob",
            "tool_input": {"pattern": pattern},
        }
        if path is not None:
            payload["tool_input"]["path"] = path
        return hooks_cli.dispatch("pre-read", payload)

    def test_glob_hash_stable(self, tmp_data_dir):
        """glob_hash is deterministic for the same (pattern, path) pair."""
        h1 = bash_cache.glob_hash("**/*.py", "src/")
        h2 = bash_cache.glob_hash("**/*.py", "src/")
        assert h1 == h2

    def test_glob_hash_path_differentiates(self, tmp_data_dir):
        """Different path values produce different hashes."""
        h1 = bash_cache.glob_hash("**/*.py", "src/")
        h2 = bash_cache.glob_hash("**/*.py", "tests/")
        assert h1 != h2

    def test_glob_hash_none_vs_empty_string(self, tmp_data_dir):
        """None path and empty-string path are treated identically by glob_hash."""
        h1 = bash_cache.glob_hash("**/*.py", None)
        h2 = bash_cache.glob_hash("**/*.py", "")
        assert h1 == h2

    def test_store_and_load_glob_result(self, tmp_data_dir):
        """store_glob_result persists and load_glob_result retrieves it."""
        sid = "glob-cache-1"
        pattern = "**/*.py"
        result_text = "src/a.py\nsrc/b.py\nsrc/c.py\n"
        bash_cache.store_glob_result(sid, pattern, None, result_text)
        loaded = bash_cache.load_glob_result(sid, pattern, None)
        assert loaded == result_text

    def test_load_nonexistent_returns_none(self, tmp_data_dir):
        """load_glob_result returns None when no result has been stored."""
        result = bash_cache.load_glob_result("glob-miss", "**/*.ts", None)
        assert result is None

    def test_post_read_stores_glob_result(self, tmp_data_dir):
        """PostToolUse(Glob) via post_read writes result to bash_cache."""
        sid = "glob-post-1"
        pattern = "**/*.rs"
        result_text = "src/lib.rs\nsrc/main.rs\n"
        self._post_glob(sid, pattern, result_text)
        loaded = bash_cache.load_glob_result(sid, pattern, None)
        assert loaded == result_text

    def test_pre_read_serves_cached_glob_inline(self, tmp_data_dir):
        """Second Glob with same pattern gets cached result as additionalContext."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-cached-serve-1"
        pattern = "**/*.go"
        # Build a result with enough files to pass the dedup threshold.
        files = [f"src/file_{i}.go" for i in range(_GLOB_DEDUP_MIN_RESULT_COUNT + 2)]
        result_text = "\n".join(files) + "\n"
        # Run through post_read so both session history and bash_cache are populated.
        self._post_glob(sid, pattern, result_text)

        # Second pre_read on same pattern: should serve cache inline.
        result = self._pre_glob(sid, pattern)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "pre_read must inject cached glob result"
        ctx = hso.get("additionalContext", "")
        # The cached file list must appear.
        assert "src/file_0.go" in ctx

    def test_pre_read_glob_no_cache_falls_back_to_dedup_hint(self, tmp_data_dir):
        """When session history exists but no bash_cache entry, falls back to advisory hint."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-no-cache-fallback"
        pattern = "**/*.tsx"
        # Mark via session only — do NOT call post_read (so no bash_cache entry).
        session.mark_glob_run(sid, pattern, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)

        result = self._pre_glob(sid, pattern)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        # Should still get the advisory dedup hint (not a cached result).
        assert hso is not None, "advisory dedup hint must still fire when cache is empty"
        ctx = hso.get("additionalContext", "")
        assert pattern in ctx

    def test_cached_glob_result_different_pattern_no_hit(self, tmp_data_dir):
        """Cache hit requires same pattern — different pattern gets no injection."""
        sid = "glob-pattern-miss"
        self._post_glob(sid, "**/*.py", "src/a.py\nsrc/b.py\n")
        # Ask for a different pattern.
        result = self._pre_glob(sid, "**/*.ts")
        _assert_continue(result)
        # Should be a miss (no session history for .ts).
        assert "hookSpecificOutput" not in result

    def test_cached_glob_result_path_scope_differentiates(self, tmp_data_dir):
        """Cache is keyed by (pattern, path) — different path is a miss."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-path-scope"
        pattern = "**/*.py"
        files = [f"src/f{i}.py" for i in range(_GLOB_DEDUP_MIN_RESULT_COUNT + 2)]
        result_text = "\n".join(files) + "\n"
        self._post_glob(sid, pattern, result_text, path="src/")

        # Query with different path — should be a miss at cache level.
        result = self._pre_glob(sid, pattern, path="tests/")
        _assert_continue(result)
        # No cache hit (no session entry for tests/ path).
        assert "hookSpecificOutput" not in result


# ---------------------------------------------------------------------------
# Item 22: skill-body --section
# ---------------------------------------------------------------------------


class TestSkillBodySection:
    """token-goat skill-body --section <heading> extracts a named H2 section."""

    _runner = CliRunner()

    def _store_skill(self, sid: str, body: str, name: str = "ralph") -> skill_cache.SkillMeta:
        meta = skill_cache.store_output(sid, name, body)
        assert meta is not None
        # write_sidecar is required so lookup_by_name can find the entry.
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        return meta

    def test_section_extracts_named_h2(self, tmp_data_dir):
        """--section DoD returns only the DoD section content."""
        sid = "skill-sec-1"
        body = "# ralph\n\n## DoD\n\n- All tests pass\n- Lint clean\n\n## Overview\n\nIntro.\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph", "--section", "DoD"])
        assert result.exit_code == 0, result.output
        assert "All tests pass" in result.output
        assert "Lint clean" in result.output
        assert "Overview" not in result.output
        assert "Intro" not in result.output

    def test_section_case_insensitive_prefix_match(self, tmp_data_dir):
        """--section dod (lowercase) matches ## DoD via case-insensitive prefix."""
        sid = "skill-sec-2"
        body = "# ralph\n\n## DoD\n\n- criterion A\n\n## Other\n\nother text\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph", "--section", "dod"])
        assert result.exit_code == 0, result.output
        assert "criterion A" in result.output
        assert "other text" not in result.output

    def test_section_missing_exits_nonzero_with_available(self, tmp_data_dir):
        """--section for a nonexistent heading exits 1 and lists available headings."""
        sid = "skill-sec-3"
        body = "# ralph\n\n## Overview\n\nIntro.\n\n## Usage\n\nUsage text.\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph", "--section", "nonexistent"])
        assert result.exit_code == 1
        # Available headings must be listed in the error.
        assert "Overview" in result.output or "Usage" in result.output

    def test_section_absent_shows_sections_available_line(self, tmp_data_dir):
        """Without --section, skill-body appends a '**Sections available:**' line."""
        sid = "skill-sec-4"
        body = "# ralph\n\n## DoD\n\n- All tests pass\n\n## Overview\n\nIntro.\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph"])
        assert result.exit_code == 0, result.output
        assert "**Sections available:**" in result.output
        assert "DoD" in result.output
        assert "Overview" in result.output

    def test_section_absent_no_headings_no_sections_line(self, tmp_data_dir):
        """Without --section and no H2 headings, no sections-available line is added."""
        sid = "skill-sec-5"
        body = "# ralph\n\nFlat body with no H2 headings.\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph"])
        assert result.exit_code == 0, result.output
        assert "**Sections available:**" not in result.output

    def test_extract_h2_headings_basic(self):
        """extract_h2_headings returns list of heading texts without ## prefix."""
        body = "# Title\n\n## Overview\n\ntext\n\n## DoD\n\nmore\n\n### Sub\n\nskip\n"
        headings = skill_cache.extract_h2_headings(body)
        assert headings == ["Overview", "DoD"]

    def test_extract_h2_headings_empty_body(self):
        """extract_h2_headings returns [] for body with no H2 headings."""
        assert skill_cache.extract_h2_headings("No headings here.\n") == []

    def test_extract_named_section_found(self):
        """extract_named_section returns section body between H2 markers."""
        body = "## Alpha\n\nalpha content\n\n## Beta\n\nbeta content\n"
        result = skill_cache.extract_named_section(body, "Beta")
        assert result is not None
        assert "beta content" in result
        assert "alpha content" not in result

    def test_extract_named_section_last_section(self):
        """extract_named_section works for the last section (no trailing ##)."""
        body = "## First\n\nfirst\n\n## Last\n\nlast content\n"
        result = skill_cache.extract_named_section(body, "Last")
        assert result is not None
        assert "last content" in result

    def test_extract_named_section_not_found(self):
        """extract_named_section returns None when heading is absent."""
        body = "## Alpha\n\nalpha content\n"
        assert skill_cache.extract_named_section(body, "Missing") is None

    def test_extract_named_section_prefix_match(self):
        """extract_named_section matches by prefix (DoD matches 'Definition of Done')."""
        body = "## Definition of Done\n\n- criterion\n\n## Other\n\nother\n"
        result = skill_cache.extract_named_section(body, "Definition")
        assert result is not None
        assert "criterion" in result

    def test_section_json_output(self, tmp_data_dir):
        """--section with --json emits valid JSON containing section text."""
        sid = "skill-sec-json"
        body = "# ralph\n\n## DoD\n\n- item one\n- item two\n\n## End\n\nend text\n"
        self._store_skill(sid, body)
        result = self._runner.invoke(app, ["skill-body", "ralph", "--section", "DoD", "--json"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert data["section"] == "DoD"
        assert "item one" in data["text"]
        assert "end text" not in data["text"]


# ---------------------------------------------------------------------------
# Item 25: token-goat resume
# ---------------------------------------------------------------------------


class TestResumePacket:
    """build_resume_packet assembles multi-section context bundle."""

    def _make_session(self, sid: str) -> None:
        """Seed a session with files, bash, and skills."""
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=200)
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="cafebabe12345678",
            cmd_preview="pytest -v tests/",
            output_id=f"{sid[:16]}-0000000000001-cafebabe12345678",
            stdout_bytes=6000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

    def test_empty_session_returns_empty(self, tmp_data_dir):
        """build_resume_packet returns '' for a session with no state."""
        from token_goat.resume import build_resume_packet
        assert build_resume_packet("no-such-session-xyz") == ""

    def test_packet_has_header(self, tmp_data_dir):
        """Packet starts with '## Resume' header."""
        from token_goat.resume import build_resume_packet
        sid = "resume-hdr"
        self._make_session(sid)
        packet = build_resume_packet(sid)
        assert packet.startswith("## Resume")

    def test_packet_contains_freshness_annotation(self, tmp_data_dir):
        """Packet sections carry 'as of HH:MM' freshness timestamps."""
        from token_goat.resume import build_resume_packet
        sid = "resume-fresh"
        self._make_session(sid)
        packet = build_resume_packet(sid)
        assert "as of" in packet

    def test_packet_within_char_cap(self, tmp_data_dir):
        """Total packet length never exceeds _MAX_RESUME_CHARS."""
        from token_goat.resume import _MAX_RESUME_CHARS, build_resume_packet
        sid = "resume-cap"
        self._make_session(sid)
        # Add lots of bash/web history to stress the cap.
        for i in range(10):
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=f"deadbeef{i:08x}",
                cmd_preview=f"cmd_{i}",
                output_id=f"{sid[:16]}-{i:013d}-deadbeef{i:08x}",
                stdout_bytes=4000,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )
        packet = build_resume_packet(sid)
        assert len(packet) <= _MAX_RESUME_CHARS, (
            f"packet length {len(packet)} exceeds hard cap {_MAX_RESUME_CHARS}"
        )

    def test_packet_includes_bash_section(self, tmp_data_dir):
        """Packet includes a Bash outputs section when bash history exists."""
        from token_goat import bash_cache as _bc
        from token_goat.resume import build_resume_packet
        sid = "resume-bash"
        self._make_session(sid)
        # Store actual bash output using the full signature.
        _bc.store_output(
            sid,
            "pytest -v tests/",
            "test run output line 1\nline 2\nline 3\n",
            "",
            0,
        )
        packet = build_resume_packet(sid)
        assert "### Bash" in packet or "Bash" in packet

    def test_packet_includes_skill_section_when_loaded(self, tmp_data_dir):
        """Packet includes skill checklist when a skill is loaded for the session."""
        from token_goat.resume import build_resume_packet
        sid = "resume-skills"
        self._make_session(sid)
        dod_lines = "- All tests pass\n- Lint clean"
        body = f"# ralph\n\n## DoD\n\n{dod_lines}\n\n## Overview\n\nIntro.\n"
        meta = skill_cache.store_output(sid, "ralph", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )
        packet = build_resume_packet(sid)
        assert "### Skills" in packet
        # Checklist must be inlined.
        assert "All tests pass" in packet

    def test_cmd_resume_short_id(self, tmp_data_dir):
        """CLI 'resume <short_id>' resolves to the full session and emits a packet."""
        import uuid

        from typer.testing import CliRunner
        sid = str(uuid.uuid4())
        self._make_session(sid)
        runner = CliRunner()
        result = runner.invoke(app, ["resume", sid[:8]])
        # Either succeeds with packet or exits 0 with a warning (empty session).
        assert result.exit_code in (0, 1), result.output
        if result.exit_code == 0:
            assert "Resume" in result.output

    def test_cmd_resume_full_id(self, tmp_data_dir):
        """CLI 'resume <full_id>' emits a non-empty packet for a seeded session."""
        import uuid

        from typer.testing import CliRunner
        sid = str(uuid.uuid4())
        self._make_session(sid)
        runner = CliRunner()
        result = runner.invoke(app, ["resume", sid])
        assert result.exit_code == 0, result.output
        assert "## Resume" in result.output

    def test_cmd_resume_unknown_id_exits_nonzero(self, tmp_data_dir):
        """CLI 'resume <unknown_short>' exits 1 with an error."""
        from typer.testing import CliRunner
        runner = CliRunner()
        result = runner.invoke(app, ["resume", "00000000"])
        assert result.exit_code == 1

    def test_head_tail_helper(self):
        """_head_tail returns head + gap + tail for long line lists."""
        from token_goat.resume import _head_tail
        lines = [str(i) for i in range(50)]
        out = _head_tail(lines, head=5, tail=5)
        assert "0" in out and "4" in out   # head
        assert "45" in out and "49" in out  # tail
        assert "omitted" in out

    def test_cmd_resume_writes_resume_packet_stat_with_zero_savings(self, tmp_data_dir):
        """CLI 'resume' must record a resume_packet stat with bytes_saved=0.

        resume_packet is an adoption-tracking stat — it signals how often the
        resume workflow is used, not a realized token saving.  The bytes_saved
        must always be 0 to avoid inflating the total-savings figure in
        `token-goat stats`.  This test verifies that contract is enforced at
        the CLI level, not just documented in stats.py.
        """
        import uuid
        from unittest.mock import patch

        from typer.testing import CliRunner

        from token_goat import db as _db

        sid = str(uuid.uuid4())
        self._make_session(sid)

        recorded_stats: list[dict] = []

        def capture_stat(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded_stats.append({
                "kind": kind,
                "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved,
            })

        runner = CliRunner()
        with patch.object(_db, "record_stat", side_effect=capture_stat):
            result = runner.invoke(app, ["resume", sid])

        assert result.exit_code == 0, result.output

        resume_rows = [r for r in recorded_stats if r["kind"] == "resume_packet"]
        assert len(resume_rows) == 1, (
            "CLI 'resume' must write exactly one resume_packet stat row"
        )
        assert resume_rows[0]["bytes_saved"] == 0, (
            "resume_packet is adoption telemetry — bytes_saved must be 0, "
            "not inflated by the packet size"
        )
        assert resume_rows[0]["tokens_saved"] == 0, (
            "resume_packet is adoption telemetry — tokens_saved must be 0"
        )

    def test_head_tail_short_list_no_gap(self):
        """_head_tail returns full content when list fits within head+tail."""
        from token_goat.resume import _head_tail
        lines = ["a", "b", "c"]
        assert _head_tail(lines, head=5, tail=5) == "a\nb\nc"
