"""Tests for resume.build_resume_packet.

Exercises the happy path (all four sections), the empty/unavailable-session
short-circuits, budget capping, and each section's presence in the output.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from token_goat import session
from token_goat.resume import (
    _MAX_RESUME_CHARS,
    build_resume_packet,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_bash(sid: str, *, count: int = 1) -> list[str]:
    """Add *count* bash entries and return their output_ids."""
    ids = []
    for i in range(count):
        sha = f"cmd{i:012x}"
        oid = f"{sha}-output"
        session.mark_bash_run(
            sid,
            cmd_sha=sha,
            cmd_preview=f"pytest -v test_{i}.py",
            output_id=oid,
            stdout_bytes=500,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        ids.append(oid)
    return ids


def _seed_skill(sid: str, name: str = "ralph") -> str:
    """Add a skill entry and return its output_id."""
    oid = f"skill_{name}_out"
    session.mark_skill_loaded(
        sid,
        skill_name=name,
        output_id=oid,
        content_sha="deadbeef",
        body_bytes=2000,
        truncated=False,
    )
    return oid


def _write_cwd(sid: str, cwd: str, tmp_data_dir_fixture) -> None:
    """Persist a cwd value into the session cache on disk."""
    from token_goat import paths as _paths
    cache = session.load(sid)
    cache.cwd = cwd
    _paths.ensure_dir(_paths.data_dir() / "sessions")
    cache_path = _paths.data_dir() / "sessions" / f"{sid}.json"
    cache_path.write_text(cache.to_json(), encoding="utf-8")
    # Bust the process-local load cache so the next load sees the new cwd.
    from token_goat import session as _sess
    _sess._proc_load_cache.pop(sid, None)


# ---------------------------------------------------------------------------
# Empty / unavailable session
# ---------------------------------------------------------------------------

class TestEmptySession:
    """build_resume_packet returns '' when there is nothing to resume from."""

    def test_unknown_session_returns_empty(self, tmp_data_dir) -> None:
        result = build_resume_packet("nonexistent-session-id")
        assert result == ""

    def test_fresh_session_with_no_history_returns_empty(self, tmp_data_dir) -> None:
        sid = "fresh-no-history"
        _ = session.load(sid)  # creates the session file
        result = build_resume_packet(sid)
        assert result == ""

    def test_session_load_exception_returns_empty(self, tmp_data_dir) -> None:
        """OSError from session.load must not propagate — return '' gracefully."""
        with patch("token_goat.session.load", side_effect=OSError("disk full")):
            result = build_resume_packet("boom-sid")
        assert result == ""

    def test_unavailable_session_returns_empty(self, tmp_data_dir) -> None:
        """A session that reports unavailable must short-circuit to ''."""
        unavail_cache = MagicMock()
        unavail_cache.unavailable = True
        with patch("token_goat.session.load", return_value=unavail_cache):
            result = build_resume_packet("unavail-sid")
        assert result == ""


# ---------------------------------------------------------------------------
# Packet header
# ---------------------------------------------------------------------------

class TestPacketHeader:
    """The packet must open with a ## Resume header containing the session id prefix."""

    def test_header_contains_session_prefix(self, tmp_data_dir) -> None:
        sid = "header-test-session-1234"
        _seed_bash(sid)
        result = build_resume_packet(sid)
        assert result.startswith("## Resume")
        assert "header-t" in result  # first 8 chars of session id

    def test_header_contains_as_of_time(self, tmp_data_dir) -> None:
        sid = "hdr-time-session"
        _seed_bash(sid)
        result = build_resume_packet(sid)
        assert "as of" in result


# ---------------------------------------------------------------------------
# Bash section
# ---------------------------------------------------------------------------

class TestBashSection:
    """A session with bash history must produce a ### Bash outputs section."""

    def test_bash_section_present(self, tmp_data_dir) -> None:
        sid = "bash-present-session"
        _seed_bash(sid)
        result = build_resume_packet(sid)
        assert "### Bash outputs" in result

    def test_bash_command_preview_appears(self, tmp_data_dir) -> None:
        sid = "bash-preview-session"
        _seed_bash(sid)
        result = build_resume_packet(sid)
        assert "pytest -v test_0.py" in result

    def test_bash_output_body_included_when_cache_hit(self, tmp_data_dir) -> None:
        """When bash_cache has the output, its text appears in the packet."""
        sid = "bash-cache-hit-session"
        _seed_bash(sid)
        fake_output = "\n".join(f"line {i}" for i in range(10))
        with patch("token_goat.resume._load_bash_output", return_value=fake_output):
            result = build_resume_packet(sid)
        assert "line 0" in result

    def test_bash_evicted_output_shows_fallback(self, tmp_data_dir) -> None:
        """When _load_bash_output returns None, a 'body evicted' fallback appears."""
        sid = "bash-evicted-session"
        _seed_bash(sid)
        with patch("token_goat.resume._load_bash_output", return_value=None):
            result = build_resume_packet(sid)
        # Either the output_id reference or an "evicted" note must appear.
        assert "evicted" in result or "bash-output" in result

    def test_bash_head_tail_gap_marker(self, tmp_data_dir) -> None:
        """Long bash outputs get head + gap + tail, not the full text."""
        sid = "bash-headtail-session"
        _seed_bash(sid)
        many_lines = "\n".join(f"output line {i}" for i in range(60))
        with patch("token_goat.resume._load_bash_output", return_value=many_lines):
            result = build_resume_packet(sid)
        assert "lines omitted" in result


# ---------------------------------------------------------------------------
# Skill section
# ---------------------------------------------------------------------------

class TestSkillSection:
    """A session with skill history must produce a ### Skills section."""

    def test_skill_section_present_when_checklist_available(self, tmp_data_dir) -> None:
        sid = "skill-section-session"
        _seed_skill(sid, "ralph")
        fake_checklist = "## DoD\n- [ ] Tests pass\n- [ ] Lint clean"
        with patch("token_goat.skill_cache.load_output", return_value="full body text"), \
             patch("token_goat.skill_cache.extract_checklist_section", return_value=fake_checklist):
            result = build_resume_packet(sid)
        assert "### Skills" in result
        assert "ralph" in result

    def test_skill_section_fallback_when_no_body(self, tmp_data_dir) -> None:
        """When skill body is missing, a recall-command fallback appears."""
        sid = "skill-no-body-session"
        _seed_skill(sid, "superman")
        with patch("token_goat.skill_cache.load_output", return_value=None):
            result = build_resume_packet(sid)
        assert "### Skills" in result
        assert "superman" in result
        assert "skill-body" in result  # recall command hint

    def test_skill_section_fallback_when_no_checklist(self, tmp_data_dir) -> None:
        """When body exists but checklist extract returns None, fallback appears."""
        sid = "skill-no-checklist-session"
        _seed_skill(sid, "humanizer")
        with patch("token_goat.skill_cache.load_output", return_value="body text"), \
             patch("token_goat.skill_cache.extract_checklist_section", return_value=None):
            result = build_resume_packet(sid)
        assert "### Skills" in result
        assert "humanizer" in result

    def test_skill_checklist_truncated_at_per_skill_budget(self, tmp_data_dir) -> None:
        """Checklists longer than _SKILL_MAX_CHARS_EACH are truncated with ellipsis."""
        from token_goat.resume import _SKILL_MAX_CHARS_EACH
        sid = "skill-truncate-session"
        _seed_skill(sid, "ralph")
        long_checklist = "x" * (_SKILL_MAX_CHARS_EACH + 200)
        with patch("token_goat.skill_cache.load_output", return_value="body"), \
             patch("token_goat.skill_cache.extract_checklist_section", return_value=long_checklist):
            result = build_resume_packet(sid)
        assert "…" in result


# ---------------------------------------------------------------------------
# Diffs section
# ---------------------------------------------------------------------------

class TestDiffsSection:
    """Edited files + cwd produce a ### Diffs section."""

    def test_diffs_section_present(self, tmp_data_dir) -> None:
        sid = "diffs-present-session"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        _write_cwd(sid, "/proj", tmp_data_dir)
        fake_diff = "- old line\n+ new line"
        with patch("token_goat.resume._inline_diff", return_value=fake_diff):
            result = build_resume_packet(sid)
        assert "### Diffs" in result
        assert "auth.py" in result

    def test_diffs_section_absent_without_cwd(self, tmp_data_dir) -> None:
        """When cwd is None, no diff section is emitted."""
        sid = "diffs-no-cwd-session"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        # cwd stays None (default)
        with patch("token_goat.resume._inline_diff", return_value="some diff"):
            result = build_resume_packet(sid)
        assert "### Diffs" not in result


# ---------------------------------------------------------------------------
# Git stat section
# ---------------------------------------------------------------------------

class TestGitStatSection:
    """build_resume_packet emits a ### Git stat section when cwd + stat exist."""

    def test_stat_section_present(self, tmp_data_dir) -> None:
        sid = "stat-present-session"
        _seed_bash(sid)
        _write_cwd(sid, "/proj", tmp_data_dir)
        fake_stat = " src/auth.py | 3 ++-\n 1 file changed"
        with patch("token_goat.resume._git_diff_stat", return_value=fake_stat):
            result = build_resume_packet(sid)
        assert "### Git stat" in result
        assert "file changed" in result

    def test_stat_section_absent_when_stat_empty(self, tmp_data_dir) -> None:
        """Empty git stat string → section is silently skipped."""
        sid = "stat-empty-session"
        _seed_bash(sid)
        _write_cwd(sid, "/proj", tmp_data_dir)
        with patch("token_goat.resume._git_diff_stat", return_value=""):
            result = build_resume_packet(sid)
        assert "### Git stat" not in result


# ---------------------------------------------------------------------------
# Budget cap
# ---------------------------------------------------------------------------

class TestBudgetCap:
    """Total packet length must never exceed _MAX_RESUME_CHARS."""

    def test_packet_within_hard_cap(self, tmp_data_dir) -> None:
        sid = "budget-cap-session"
        _seed_bash(sid, count=2)
        huge_output = "\n".join(f"out line {i}" for i in range(500))
        with patch("token_goat.resume._load_bash_output", return_value=huge_output):
            result = build_resume_packet(sid)
        assert len(result) <= _MAX_RESUME_CHARS
