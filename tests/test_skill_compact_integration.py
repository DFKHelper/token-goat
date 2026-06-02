"""End-to-end COMPACT_END integration tests.

Covers the full pipeline:
  skill loaded (PostToolUse Skill hook) →
  COMPACT_END detected →
  compact cached →
  manifest shows compact rules inline

Also covers the no-marker fallback (auto-extract) and the skill-body --compact
CLI command serving the cached compact.
"""
from __future__ import annotations

import json

from typer.testing import CliRunner

from token_goat import cli, compact, hooks_skill, session, skill_cache

runner = CliRunner()

# ---------------------------------------------------------------------------
# Realistic skill fixture bodies
# ---------------------------------------------------------------------------

# A skill body where the compact section sits at ~30% of the total length.
# Everything above <!-- COMPACT_END --> is the author-curated compact.
_RALPH_COMPACT_SECTION = """\
# ralph

Autonomous iterative refinement loop with DoD, anti-shortcut guards, and
walk-away capability.

## Key Rules

- CRITICAL: Never skip a DoD gate — test failure = not done.
- MUST: Run the full test suite before marking any iteration complete.
- NEVER: Claim success without evidence (passing test output).
- RULE: Commit after each validated checkpoint; never batch.

## DoD

1. All tests pass (`uv run pytest -x -q`).
2. Lint clean (`uv run ruff check`).
3. Types pass (`uv run mypy src`).
"""

# The "detail" section that follows the marker (should NOT appear in compact).
# Must be large enough that total body exceeds 4000 bytes (the hook's compact threshold).
_RALPH_DETAIL_SECTION = """
## Iteration Loop

Each iteration runs independently.  The orchestrator boots a fresh sub-agent,
hands it the task, and waits for a `{"done": true}` signal or a commit.

### Phase 1 — Explore

Read the codebase.  Do not write files in this phase.  Understand the full
call chain before touching anything.

### Phase 2 — Plan

Draft a multi-step plan.  Each step must be atomic and verifiable.

### Phase 3 — Execute

Implement one step at a time.  Run validation after every step.

### Phase 4 — Validate

Run the full test suite.  Fix failures before proceeding.  Never skip.

### Phase 5 — Commit

One commit per iteration.  Commit message describes the change concisely.

## Anti-shortcut Guards

These guards fire automatically and cannot be bypassed:

- Returning a stub is not done.
- "Works locally" is not done.
- "Tests skipped" is not done.
- "TODO" comments in submitted code = not done.
""" + ("Padding text to push detail section past the 4000-byte threshold. " * 100)

# Full body: compact section + marker + detail section.
_RALPH_SKILL_BODY = (
    _RALPH_COMPACT_SECTION
    + "\n<!-- COMPACT_END -->\n"
    + _RALPH_DETAIL_SECTION
)

# A skill body WITHOUT a <!-- COMPACT_END --> marker — tests auto-extraction fallback.
# Must be > 4000 bytes so the hook triggers compact storage.
_IMPROVE_SKILL_BODY = """\
# improve

Autonomous self-improvement loop. Runs N iterations of ralph improve → commit
→ context compact.

## DoD

- CRITICAL: Each iteration must produce at least one real code change.
- MUST: All tests pass before the iteration is marked complete.
- NEVER: Increment the counter without a real commit.

## Loop Steps

1. Run ralph improve.
2. Commit the change.
3. Context compact.
4. Repeat N times (default 10).

## Flags

- `--manual`: one iteration per call.
- `--iterations N`: change loop count.
- `--area "X"`: lock focus to a subsystem.

## Extended Reference

This section provides background on how each phase works in depth.
The self-improvement loop is designed to be robust against context loss.

""" + ("Extended reference text for the improve loop. " * 200)


# ---------------------------------------------------------------------------
# Unit tests: extract_compact_from_marker
# ---------------------------------------------------------------------------

class TestExtractCompactFromMarker:
    """Unit tests for skill_cache.extract_compact_from_marker."""

    def test_returns_pre_marker_text(self):
        """Everything above the marker line is returned, stripped."""
        result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY)
        assert result is not None
        # Should contain the compact section content.
        assert "CRITICAL" in result
        assert "Never skip a DoD gate" in result

    def test_does_not_contain_detail_section(self):
        """Text below the marker must not appear in the compact."""
        result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY)
        assert result is not None
        assert "Iteration Loop" not in result
        assert "Phase 1" not in result

    def test_compact_is_at_most_30_percent_of_full_body(self):
        """Compact length should be roughly ≤30% of full body (author intent)."""
        result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY)
        assert result is not None
        compact_len = len(result)
        full_len = len(_RALPH_SKILL_BODY)
        ratio = compact_len / full_len
        assert ratio <= 0.35, (
            f"Compact section is {ratio:.1%} of full body — marker not at ~30%."
        )

    def test_returns_none_when_no_marker(self):
        """Returns None for a body without the marker."""
        result = skill_cache.extract_compact_from_marker(_IMPROVE_SKILL_BODY)
        assert result is None

    def test_returns_none_for_empty_body(self):
        assert skill_cache.extract_compact_from_marker("") is None

    def test_marker_at_very_start_returns_none(self):
        """Marker on the first line produces an empty pre-section — returns None."""
        body = "<!-- COMPACT_END -->\n\nSome content after."
        result = skill_cache.extract_compact_from_marker(body)
        assert result is None

    def test_marker_inline_not_matched(self):
        """A marker embedded in a line (not alone) must NOT trigger extraction."""
        body = (
            "# Skill\n\nSome text <!-- COMPACT_END --> here.\n\nMore text.\n"
        )
        result = skill_cache.extract_compact_from_marker(body)
        assert result is None

    def test_marker_with_surrounding_whitespace_matched(self):
        """Marker line with leading/trailing whitespace should still be matched."""
        body = (
            "# Compact heading\n\nImportant rule.\n\n  <!-- COMPACT_END -->  \n\nDetail.\n"
        )
        result = skill_cache.extract_compact_from_marker(body)
        assert result is not None
        assert "Important rule." in result
        assert "Detail." not in result


# ---------------------------------------------------------------------------
# Full pipeline: hook fires → compact cached
# ---------------------------------------------------------------------------

class TestPostSkillHookCompactPipeline:
    """End-to-end: PostToolUse Skill hook with a realistic skill body."""

    def _fire_hook(self, session_id: str, skill_name: str, body: str) -> dict:
        payload = {
            "session_id": session_id,
            "tool_name": "Skill",
            "tool_input": {"skill": skill_name},
            "tool_response": body,
        }
        return hooks_skill.post_skill(payload)

    # ── marker path ────────────────────────────────────────────────────────

    def test_marker_compact_stored_after_hook(self, tmp_data_dir):
        """Firing the hook with a COMPACT_END body stores the compact."""
        sid = "integ-marker-stored"
        resp = self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)
        assert resp.get("continue") is True

        stored = skill_cache.get_compact(sid, "ralph")
        assert stored is not None, "compact must be stored when marker is present"
        assert len(stored) > 0

    def test_marker_compact_contains_key_rules(self, tmp_data_dir):
        """The stored compact must include the CRITICAL/MUST/NEVER rules."""
        sid = "integ-marker-rules"
        self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "ralph")
        assert stored is not None
        assert "CRITICAL" in stored
        assert "MUST" in stored
        assert "NEVER" in stored

    def test_marker_compact_smaller_than_full_body(self, tmp_data_dir):
        """Stored compact must be strictly smaller than the full body."""
        sid = "integ-marker-size"
        self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "ralph")
        assert stored is not None
        assert len(stored) < len(_RALPH_SKILL_BODY)

    def test_marker_compact_within_30pct_of_body(self, tmp_data_dir):
        """Compact should be at most ~35% of the full body (marker at ~30%)."""
        sid = "integ-marker-ratio"
        self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "ralph")
        assert stored is not None
        ratio = len(stored) / len(_RALPH_SKILL_BODY)
        assert ratio <= 0.35, f"Compact is {ratio:.1%} of full body — too large."

    def test_hook_system_message_emitted_for_marker_skill(self, tmp_data_dir):
        """Hook should set systemMessage when a compact section is found."""
        sid = "integ-marker-sysmsg"
        resp = self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)
        # systemMessage is optional but should be present for marker path.
        system_msg = resp.get("systemMessage", "")
        assert "ralph" in system_msg.lower() or system_msg == "", (
            "systemMessage should either mention the skill name or be absent"
        )
        # If present, it should reference the compact section.
        if system_msg:
            assert "compact" in system_msg.lower() or "marker" in system_msg.lower()

    def test_session_records_skill_after_hook(self, tmp_data_dir):
        """Session history should have a 'ralph' entry after the hook fires."""
        sid = "integ-marker-session"
        self._fire_hook(sid, "ralph", _RALPH_SKILL_BODY)

        cache = session.load(sid)
        assert "ralph" in cache.skill_history

    # ── no-marker fallback ─────────────────────────────────────────────────

    def test_no_marker_falls_back_to_auto_extract(self, tmp_data_dir):
        """Without a marker, auto-extraction still produces a compact."""
        sid = "integ-auto-extract"
        self._fire_hook(sid, "improve", _IMPROVE_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "improve")
        assert stored is not None, "auto-extract should store a compact"
        assert len(stored) > 0

    def test_no_marker_auto_extract_contains_dod_rules(self, tmp_data_dir):
        """Auto-extracted compact for the improve skill includes CRITICAL/MUST rules."""
        sid = "integ-auto-extract-rules"
        self._fire_hook(sid, "improve", _IMPROVE_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "improve")
        assert stored is not None
        # Auto-extract grabs CRITICAL/MUST/NEVER lines.
        assert "CRITICAL" in stored or "MUST" in stored

    def test_no_marker_auto_extract_smaller_than_body(self, tmp_data_dir):
        """Auto-extracted compact must be smaller than the full body."""
        sid = "integ-auto-extract-size"
        self._fire_hook(sid, "improve", _IMPROVE_SKILL_BODY)

        stored = skill_cache.get_compact(sid, "improve")
        assert stored is not None
        assert len(stored) < len(_IMPROVE_SKILL_BODY)

    def test_small_body_no_compact_stored(self, tmp_data_dir):
        """Bodies under 4000 chars do not trigger compact storage (either path)."""
        sid = "integ-small-no-compact"
        small_body = "# Small\n\n" + ("Line. " * 100)  # well under 4000 chars
        assert len(small_body.encode()) < 4000
        self._fire_hook(sid, "small-skill", small_body)

        stored = skill_cache.get_compact(sid, "small-skill")
        assert stored is None, "compact must not be stored for small bodies"


# ---------------------------------------------------------------------------
# Manifest embeds compact inline
# ---------------------------------------------------------------------------

class TestManifestCompactIntegration:
    """compact.build_manifest embeds the compact text inline for loaded skills."""

    def _load_skill_via_hook(self, session_id: str, skill_name: str, body: str) -> None:
        """Fire the hook and register the skill in the session cache."""
        payload = {
            "session_id": session_id,
            "tool_name": "Skill",
            "tool_input": {"skill": skill_name},
            "tool_response": body,
        }
        hooks_skill.post_skill(payload)

    def test_manifest_contains_compact_key_rules_for_marker_skill(self, tmp_data_dir):
        """Manifest embeds marker-compact inline under 'ralph key-rules:'."""
        sid = "integ-manifest-marker"
        self._load_skill_via_hook(sid, "ralph", _RALPH_SKILL_BODY)

        m = compact.build_manifest(sid, max_tokens=800)
        assert "**Skills:**" in m
        assert "ralph" in m
        # Key-rules heading and content should be embedded.
        assert "ralph key-rules:" in m
        assert "CRITICAL" in m or "MUST" in m

    def test_manifest_compact_excludes_detail_section(self, tmp_data_dir):
        """Detail text below the marker must not appear in the manifest."""
        sid = "integ-manifest-no-detail"
        self._load_skill_via_hook(sid, "ralph", _RALPH_SKILL_BODY)

        m = compact.build_manifest(sid, max_tokens=800)
        # These strings are only in the detail section (after the marker).
        assert "Phase 1" not in m
        assert "Anti-shortcut Guards" not in m

    def test_manifest_contains_compact_for_auto_extract_skill(self, tmp_data_dir):
        """Manifest also embeds auto-extracted compact when no marker is present."""
        sid = "integ-manifest-auto"
        self._load_skill_via_hook(sid, "improve", _IMPROVE_SKILL_BODY)

        m = compact.build_manifest(sid, max_tokens=800)
        assert "improve" in m
        # The auto-extracted compact's key-rules should appear.
        assert "improve key-rules:" in m or "CRITICAL" in m or "MUST" in m

    def test_manifest_skill_section_present_even_without_compact(self, tmp_data_dir):
        """When compact is absent, the manifest still lists the skill name."""
        sid = "integ-manifest-no-compact"
        # Small body — hook won't store a compact.
        small_body = "# TinySkill\n\n" + ("word " * 60)
        assert len(small_body.encode()) < 4000
        # Manually register in session (bypass hook body-size guard).
        meta = skill_cache.store_output(sid, "tiny-skill", small_body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        session.mark_skill_loaded(
            sid, meta.skill_name, meta.output_id, meta.content_sha,
            meta.body_bytes, meta.truncated,
        )

        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Skills:**" in m
        assert "tiny-skill" in m
        # No compact was stored — key-rules section must be absent for this skill.
        assert "tiny-skill key-rules:" not in m

    def test_manifest_multiple_skills_each_get_compact(self, tmp_data_dir):
        """When two skills are loaded, both get their compact inline."""
        sid = "integ-manifest-two-skills"
        self._load_skill_via_hook(sid, "ralph", _RALPH_SKILL_BODY)
        self._load_skill_via_hook(sid, "improve", _IMPROVE_SKILL_BODY)

        m = compact.build_manifest(sid, max_tokens=1200)
        assert "ralph" in m
        assert "improve" in m
        # At least one compact section should appear.
        assert "key-rules:" in m


# ---------------------------------------------------------------------------
# skill-size command reflects compact token count
# ---------------------------------------------------------------------------

class TestSkillSizeWithCompact:
    """skill-size reports correct compact_tokens when a compact is cached."""

    def test_skill_size_marker_skill_compact_tokens(self, tmp_data_dir):
        """skill-size shows a compact_tokens value > 0 after marker extraction."""
        sid = "integ-size-marker"
        # Manually store the body and compact (same as the hook would do).
        meta = skill_cache.store_output(sid, "ralph", _RALPH_SKILL_BODY)
        assert meta is not None
        compact_text = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY)
        assert compact_text is not None
        skill_cache.store_compact(sid, "ralph", compact_text)

        result = runner.invoke(cli.app, ["skill-size", "--session-id", sid, "--json"])
        assert result.exit_code == 0, f"skill-size failed: {result.stdout}"
        data = json.loads(result.stdout)

        skills = data.get("skills", [])
        ralph_entry = next((s for s in skills if s["name"] == "ralph"), None)
        assert ralph_entry is not None, f"ralph not in skill-size output: {skills}"
        assert ralph_entry["compact_tokens"] > 0, (
            "compact_tokens should be > 0 when compact was extracted from marker"
        )
        # Compact tokens must be strictly less than body tokens.
        assert ralph_entry["compact_tokens"] < ralph_entry["body_tokens"]

    def test_skill_size_auto_extract_skill_compact_tokens(self, tmp_data_dir):
        """skill-size shows compact_tokens > 0 for auto-extracted compact."""
        sid = "integ-size-auto"
        meta = skill_cache.store_output(sid, "improve", _IMPROVE_SKILL_BODY)
        assert meta is not None
        compact_text = skill_cache.generate_compact_summary(_IMPROVE_SKILL_BODY)
        assert compact_text
        skill_cache.store_compact(sid, "improve", compact_text)

        result = runner.invoke(cli.app, ["skill-size", "--session-id", sid, "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        skills = data.get("skills", [])
        improve_entry = next((s for s in skills if s["name"] == "improve"), None)
        assert improve_entry is not None
        assert improve_entry["compact_tokens"] > 0

    def test_skill_size_has_marker_via_api(self, tmp_data_dir):
        """get_all_cached_skills marks skills that have a COMPACT_END marker."""
        sid = "integ-size-has-marker"
        meta = skill_cache.store_output(sid, "ralph", _RALPH_SKILL_BODY)
        assert meta is not None

        skills = skill_cache.get_all_cached_skills(sid)
        ralph_entry = next((s for s in skills if s["name"] == "ralph"), None)
        assert ralph_entry is not None
        # has_marker should be True for a skill with <!-- COMPACT_END -->
        assert ralph_entry.get("has_marker") is True

    def test_skill_size_no_marker_via_api(self, tmp_data_dir):
        """get_all_cached_skills marks skills without a COMPACT_END marker as has_marker=False."""
        sid = "integ-size-no-marker"
        meta = skill_cache.store_output(sid, "improve", _IMPROVE_SKILL_BODY)
        assert meta is not None

        skills = skill_cache.get_all_cached_skills(sid)
        improve_entry = next((s for s in skills if s["name"] == "improve"), None)
        assert improve_entry is not None
        assert improve_entry.get("has_marker") is False


# ---------------------------------------------------------------------------
# skill-body --compact returns marker compact
# ---------------------------------------------------------------------------

class TestSkillBodyCompactCommand:
    """skill-body --compact serves the cached compact (marker or auto-extract)."""

    def test_skill_body_compact_returns_marker_text(self, tmp_data_dir, monkeypatch):
        """skill-body --compact returns the marker-extracted compact, not the full body."""
        sid = "integ-body-compact-marker"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)

        # Store via hook so the compact is persisted.
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": _RALPH_SKILL_BODY,
        }
        hooks_skill.post_skill(payload)

        result = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert result.exit_code == 0, f"skill-body --compact failed: {result.stdout}"

        # Output should be the compact section (pre-marker content).
        output = result.stdout
        assert "CRITICAL" in output or "MUST" in output
        # Detail section should not be present.
        assert "Phase 1" not in output
        assert "Anti-shortcut Guards" not in output

    def test_skill_body_compact_smaller_than_full(self, tmp_data_dir, monkeypatch):
        """skill-body --compact output is smaller than the full body."""
        sid = "integ-body-compact-size"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)

        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": _RALPH_SKILL_BODY,
        }
        hooks_skill.post_skill(payload)

        # Full body output.
        full_result = runner.invoke(cli.app, ["skill-body", "--full", "ralph"])
        assert full_result.exit_code == 0

        # Compact output.
        compact_result = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert compact_result.exit_code == 0

        assert len(compact_result.stdout) < len(full_result.stdout), (
            "--compact output should be strictly shorter than --full output"
        )

    def test_skill_body_compact_without_marker_uses_auto_extract(self, tmp_data_dir, monkeypatch):
        """skill-body --compact on a no-marker skill uses auto-extract (not cached compact)."""
        sid = "integ-body-compact-auto"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)

        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "improve"},
            "tool_response": _IMPROVE_SKILL_BODY,
        }
        hooks_skill.post_skill(payload)

        result = runner.invoke(cli.app, ["skill-body", "--compact", "improve"])
        assert result.exit_code == 0
        output = result.stdout
        # Auto-extract should include headings and key rules.
        assert len(output) > 0
        assert len(output) < len(_IMPROVE_SKILL_BODY)

    def test_skill_body_compact_json_output(self, tmp_data_dir, monkeypatch):
        """skill-body --compact --json returns valid JSON with 'compact': True."""
        sid = "integ-body-compact-json"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)

        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": "ralph"},
            "tool_response": _RALPH_SKILL_BODY,
        }
        hooks_skill.post_skill(payload)

        result = runner.invoke(cli.app, ["skill-body", "--compact", "--json", "ralph"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert data.get("compact") is True
        assert "text" in data
        assert len(data["text"]) > 0
        assert "CRITICAL" in data["text"] or "MUST" in data["text"]


class TestSkillBodyCompactHeaderConsistency:
    """skill-body --compact always emits the '--- compact form (N tokens) ---' header."""

    def _store_skill(self, sid: str, skill_name: str, body: str) -> None:
        payload = {
            "session_id": sid,
            "tool_name": "Skill",
            "tool_input": {"skill": skill_name},
            "tool_response": body,
        }
        hooks_skill.post_skill(payload)

    def test_first_call_has_header(self, tmp_data_dir, monkeypatch):
        """On the first invocation (no cached compact), output includes the header."""
        sid = "header-test-first"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        self._store_skill(sid, "ralph", _RALPH_SKILL_BODY)

        result = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert result.exit_code == 0, f"unexpected exit: {result.stdout}"
        # Header must be present on first call (freshly generated, not yet cached).
        assert result.stdout.startswith("--- compact form ("), (
            f"expected '--- compact form …' header on first call, got: {result.stdout[:80]!r}"
        )

    def test_second_call_has_same_header(self, tmp_data_dir, monkeypatch):
        """On a subsequent invocation (compact already cached), header is still present."""
        sid = "header-test-second"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        self._store_skill(sid, "ralph", _RALPH_SKILL_BODY)

        # First call populates the cache.
        r1 = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert r1.exit_code == 0
        # Second call reads from cache — must also start with the header.
        r2 = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert r2.exit_code == 0
        assert r2.stdout.startswith("--- compact form ("), (
            f"expected '--- compact form …' header on second (cached) call, got: {r2.stdout[:80]!r}"
        )

    def test_both_calls_produce_identical_output(self, tmp_data_dir, monkeypatch):
        """First and second calls produce identical output (header + body are consistent)."""
        sid = "header-test-idempotent"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        self._store_skill(sid, "ralph", _RALPH_SKILL_BODY)

        r1 = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        r2 = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert r1.exit_code == 0 and r2.exit_code == 0
        assert r1.stdout == r2.stdout, (
            "first and second --compact calls should produce identical output"
        )

    def test_skill_compact_command_has_header(self, tmp_data_dir, monkeypatch):
        """'token-goat skill-compact' also always emits the compact form header."""
        sid = "skill-compact-header"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        self._store_skill(sid, "ralph", _RALPH_SKILL_BODY)

        result = runner.invoke(cli.app, ["skill-compact", "ralph"])
        assert result.exit_code == 0, f"unexpected exit: {result.stdout}"
        assert result.stdout.startswith("--- compact form ("), (
            f"expected '--- compact form …' header from skill-compact, got: {result.stdout[:80]!r}"
        )

    def test_header_token_count_matches_body(self, tmp_data_dir, monkeypatch):
        """The token count in the header accurately reflects the compact body length."""
        import re

        sid = "header-token-count"
        monkeypatch.setenv("CLAUDE_SESSION_ID", sid)
        self._store_skill(sid, "ralph", _RALPH_SKILL_BODY)

        result = runner.invoke(cli.app, ["skill-body", "--compact", "ralph"])
        assert result.exit_code == 0
        output = result.stdout
        m = re.match(r"--- compact form \((\d+) tokens\) ---\n(.*)", output, re.DOTALL)
        assert m is not None, f"header pattern not found in: {output[:120]!r}"
        claimed_tokens = int(m.group(1))
        body_text = m.group(2)
        expected_tokens = max(1, len(body_text) // 4)
        assert claimed_tokens == expected_tokens, (
            f"header claims {claimed_tokens} tokens but body has {len(body_text)} chars "
            f"({expected_tokens} tokens)"
        )


class TestStoreCompactAtomicWrite:
    """store_compact uses atomic write so concurrent callers can't produce torn files."""

    def test_stored_file_readable_after_concurrent_writes(self, tmp_data_dir):
        """Two concurrent store_compact calls for the same skill don't corrupt the file."""
        import threading

        errors: list[Exception] = []

        def write_compact(thread_id: int) -> None:
            try:
                skill_cache.store_compact(
                    f"session-{thread_id}",
                    "ralph",
                    f"compact body from thread {thread_id} " * 50,
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=write_compact, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"threads raised exceptions: {errors}"

        # Every written file must be readable and non-empty UTF-8.
        for i in range(8):
            text = skill_cache.get_compact(f"session-{i}", "ralph")
            assert text is not None, f"session-{i} compact was None after concurrent write"
            assert f"compact body from thread {i}" in text or "--- compact form" in text

    def test_store_compact_header_present_in_stored_file(self, tmp_data_dir):
        """The stored file (not the CLI display) always contains the header."""
        skill_cache.store_compact("sess-atomic", "testskill", "bare compact body text " * 10)
        stored = skill_cache.get_compact("sess-atomic", "testskill")
        assert stored is not None
        assert stored.startswith("--- compact form ("), (
            f"stored compact should start with header, got: {stored[:80]!r}"
        )
