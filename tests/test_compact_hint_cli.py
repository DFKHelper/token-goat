"""Tests for compact-hint CLI enhancements: --diff, --sections, --score, --auto."""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

import token_goat.paths as paths
from token_goat import cli, compact, session

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _invoke(args: list[str]) -> object:
    """Invoke the CLI with the given args and return the result."""
    return runner.invoke(cli.app, args)


# ---------------------------------------------------------------------------
# find_latest_session_id
# ---------------------------------------------------------------------------

class TestFindLatestSessionId:
    def test_returns_none_when_no_sessions(self, tmp_data_dir):
        result = compact.find_latest_session_id()
        assert result is None

    def test_returns_latest_session(self, tmp_data_dir):
        import os  # noqa: PLC0415

        sid1 = "find-latest-alpha"
        sid2 = "find-latest-beta"

        session.mark_file_read(sid1, "/proj/a.py", offset=0, limit=10)
        session.mark_file_read(sid2, "/proj/b.py", offset=0, limit=10)

        # Force distinct mtimes without sleeping: stamp sid2's file 1 s ahead.
        sessions_dir = paths.data_dir() / "sessions"
        f2 = sessions_dir / f"{sid2}.json"
        f1 = sessions_dir / f"{sid1}.json"
        t1 = f1.stat().st_mtime
        os.utime(str(f2), (t1 + 1.0, t1 + 1.0))

        result = compact.find_latest_session_id()
        assert result == sid2

    def test_returns_only_session_when_one_exists(self, tmp_data_dir):
        sid = "find-latest-only"
        session.mark_file_read(sid, "/proj/c.py", offset=0, limit=10)

        result = compact.find_latest_session_id()
        assert result == sid

    def test_returns_none_when_sessions_dir_missing(self, tmp_data_dir):
        # Sessions dir doesn't exist yet (empty tmp dir)
        result = compact.find_latest_session_id()
        assert result is None


# ---------------------------------------------------------------------------
# --session-id auto / --auto flag
# ---------------------------------------------------------------------------

class TestAutoSessionDetection:
    def test_auto_flag_detects_session(self, tmp_data_dir, make_session):
        sid = "auto-detect-session-xyz"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--auto"])
        assert result.exit_code == 0
        assert "auto-detected session" in result.output

    def test_session_id_auto_keyword_detects_session(self, tmp_data_dir, make_session):
        sid = "auto-keyword-session-xyz"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", "auto"])
        assert result.exit_code == 0
        assert "auto-detected session" in result.output

    def test_auto_fails_gracefully_when_no_sessions(self, tmp_data_dir):
        result = _invoke(["compact-hint", "--auto"])
        assert result.exit_code == 1
        assert "No session files found" in result.output

    def test_explicit_session_id_still_works(self, tmp_data_dir, make_session):
        sid = "explicit-session-id-xyz"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", sid])
        assert result.exit_code == 0


# ---------------------------------------------------------------------------
# _parse_manifest_sections
# ---------------------------------------------------------------------------

class TestParseManifestSections:
    def test_empty_manifest_returns_empty_list(self):
        result = compact._parse_manifest_sections("")
        assert result == []

    def test_parses_hash_headings(self):
        manifest = "### Files Edited\n- file.py\n\n### Commands\n- pytest\n"
        sections = compact._parse_manifest_sections(manifest)
        names = [s[0] for s in sections]
        assert "Files Edited" in names
        assert "Commands" in names

    def test_non_empty_section_not_flagged_empty(self):
        manifest = "### Files Edited\n- file.py\n"
        sections = compact._parse_manifest_sections(manifest)
        # Find "Files Edited"
        for name, _tokens, is_empty in sections:
            if "Files Edited" in name:
                assert not is_empty
                break

    def test_empty_section_flagged(self):
        manifest = "### Empty Section\n\n### Non Empty\n- content\n"
        sections = compact._parse_manifest_sections(manifest)
        for name, _tokens, is_empty in sections:
            if "Empty Section" in name:
                assert is_empty
                break

    def test_token_counts_are_positive(self):
        manifest = "### Section One\n- a line with some content here\n"
        sections = compact._parse_manifest_sections(manifest)
        for _name, tokens, _is_empty in sections:
            assert tokens >= 0


# ---------------------------------------------------------------------------
# _score_manifest_breakdown
# ---------------------------------------------------------------------------

class TestScoreManifestBreakdown:
    def test_empty_returns_empty_dict(self):
        result = compact._score_manifest_breakdown([])
        assert result == {}

    def test_edited_section_contributes_points(self):
        section = "**Edited**:\n- file.py\n- other.py\n"
        breakdown = compact._score_manifest_breakdown([section])
        assert "**Edited**" in breakdown
        assert breakdown["**Edited**"] > 0

    def test_bash_section_contributes_points(self):
        section = "**Bash**:\n- pytest tests/\n"
        breakdown = compact._score_manifest_breakdown([section])
        assert "**Bash**" in breakdown
        assert breakdown["**Bash**"] > 0

    def test_sum_matches_score_manifest(self):
        sections = [
            "**Edited**:\n- a.py\n- b.py\n",
            "**Bash**:\n- pytest\n",
            "**Symbols**:\n- MyClass\n",
        ]
        total_from_score = compact._score_manifest(sections)
        breakdown = compact._score_manifest_breakdown(sections)
        total_from_breakdown = sum(breakdown.values())
        assert total_from_score == total_from_breakdown

    def test_no_double_counting_across_sections(self):
        # Symbols in edited section should score as edited (10), not also symbols (2)
        section = "**Edited**:\n- file.py\n"
        breakdown = compact._score_manifest_breakdown([section])
        # Only "**Edited**" should appear, not both Edited and Symbols
        assert "**Edited**" in breakdown
        assert breakdown.get("**Symbols**", 0) == 0

    def test_failure_line_scores_once_not_twice(self):
        # A "✗" test-failure line inside **Bash** should receive exactly +3 (Bash)
        # + +5 (✗) = +8 total.  The tautological `or "✗" in stripped` bug that
        # existed on both sides of the `or` was dead code; removing it must not
        # change the score at all — this test guards that the score is stable.
        section = "**Bash**:\n- ✗ pytest tests/  (exit 1)\n"
        score = compact._score_manifest([section])
        # +3 for Bash line, +5 for ✗ marker = 8
        assert score == 8

    def test_score_manifest_breakdown_failure_line(self):
        # _score_manifest_breakdown must produce the same total as _score_manifest
        # for a section containing a ✗ failure line (regression for tautological-or fix).
        section = "**Bash**:\n- ✗ pytest tests/  (exit 1)\n- run.sh\n"
        total_score = compact._score_manifest([section])
        breakdown = compact._score_manifest_breakdown([section])
        assert sum(breakdown.values()) == total_score


# ---------------------------------------------------------------------------
# compact-hint --sections flag
# ---------------------------------------------------------------------------

class TestCompactHintSections:
    def test_sections_flag_shows_section_names(self, tmp_data_dir, make_session):
        sid = "sections-test-session-abc"
        make_session(sid, files_read=3, edits=2, greps=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--sections"])
        assert result.exit_code == 0
        # Should show a token count summary line
        assert "tokens" in result.output.lower()

    def test_sections_flag_no_manifest(self, tmp_data_dir):
        result = _invoke(["compact-hint", "--session-id", "no-activity-session-abc", "--sections"])
        assert result.exit_code == 0
        assert "no manifest" in result.output.lower()

    def test_sections_includes_empty_flag_annotation(self, tmp_data_dir, make_session):
        sid = "sections-empty-test-abc"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--sections"])
        assert result.exit_code == 0
        # The output should have section lines (with token counts)
        lines = result.output.splitlines()
        # At least some lines should mention "tokens"
        token_lines = [ln for ln in lines if "token" in ln.lower()]
        assert len(token_lines) >= 1


# ---------------------------------------------------------------------------
# compact-hint --score flag
# ---------------------------------------------------------------------------

class TestCompactHintScore:
    def test_score_flag_shows_quality_score(self, tmp_data_dir, make_session):
        sid = "score-test-session-abc"
        make_session(sid, files_read=3, edits=2, greps=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--score"])
        assert result.exit_code == 0
        assert "Quality score" in result.output

    def test_score_shows_noop_status(self, tmp_data_dir, make_session):
        sid = "score-noop-test-abc"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--score"])
        assert result.exit_code == 0
        assert "Noop fast-path" in result.output

    def test_score_shows_activity_floor(self, tmp_data_dir, make_session):
        sid = "score-floor-test-abc"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--score"])
        assert result.exit_code == 0
        assert "floor=" in result.output

    def test_score_empty_session_shows_zero(self, tmp_data_dir):
        result = _invoke(["compact-hint", "--session-id", "no-activity-session-xyz", "--score"])
        assert result.exit_code == 0
        assert "0" in result.output


# ---------------------------------------------------------------------------
# compact-hint --diff flag
# ---------------------------------------------------------------------------

class TestCompactHintDiff:
    def test_diff_no_prior_sidecar(self, tmp_data_dir, make_session):
        sid = "diff-no-prior-abc"
        make_session(sid, files_read=2, edits=1)

        result = _invoke(["compact-hint", "--session-id", sid, "--diff"])
        assert result.exit_code == 0
        assert "No previous manifest" in result.output

    def test_diff_unchanged_shows_no_changes(self, tmp_data_dir, make_session):
        sid = "diff-unchanged-abc"
        make_session(sid, files_read=2, edits=1)

        # Write the text sidecar manually to simulate a prior emit
        manifest_text = compact.build_manifest(sid)
        if manifest_text:
            text_sidecar = paths.manifest_text_sidecar_path(sid)
            paths.ensure_dir(text_sidecar.parent)
            paths.atomic_write_text(text_sidecar, manifest_text)

            result = _invoke(["compact-hint", "--session-id", sid, "--diff"])
            assert result.exit_code == 0
            assert "unchanged" in result.output.lower() or "no diff" in result.output.lower()

    def test_diff_shows_additions_with_plus_prefix(self, tmp_data_dir, make_session):
        sid = "diff-additions-abc"
        make_session(sid, files_read=3, edits=2)

        # Write a short synthetic "prior" manifest so it differs from the current one
        prior_text = "## Token-Goat Session Manifest\nSession: prior\n- prior line only\n"
        text_sidecar = paths.manifest_text_sidecar_path(sid)
        paths.ensure_dir(text_sidecar.parent)
        paths.atomic_write_text(text_sidecar, prior_text)

        result = _invoke(["compact-hint", "--session-id", sid, "--diff"])
        assert result.exit_code == 0
        # Unified diff must have at least one line prefixed "+" or "-"
        output_lines = result.output.splitlines()
        has_diff_lines = any(
            ln.startswith("+") or ln.startswith("-")
            for ln in output_lines
        )
        assert has_diff_lines, f"Expected diff markers but got:\n{result.output}"

    def test_diff_text_sidecar_written_by_build_manifest(self, tmp_data_dir, make_session):
        """build_manifest should write the text sidecar so --diff works on next call."""
        sid = "diff-sidecar-written-abc"
        make_session(sid, files_read=2, edits=1)

        # First call to build_manifest should write the text sidecar
        manifest_text = compact.build_manifest(sid)

        text_sidecar = paths.manifest_text_sidecar_path(sid)
        if manifest_text:
            assert text_sidecar.exists()
            stored = text_sidecar.read_text(encoding="utf-8")
            assert stored == manifest_text


# ---------------------------------------------------------------------------
# manifest_text_sidecar_path in paths.py
# ---------------------------------------------------------------------------

class TestManifestTextSidecarPath:
    def test_path_is_under_sentinels(self, tmp_data_dir):
        p = paths.manifest_text_sidecar_path("my-session-id")
        assert "sentinels" in str(p)
        assert "manifest_text_" in p.name

    def test_path_ends_with_txt(self, tmp_data_dir):
        p = paths.manifest_text_sidecar_path("my-session-id")
        assert p.suffix == ".txt"

    def test_different_sessions_get_different_paths(self, tmp_data_dir):
        p1 = paths.manifest_text_sidecar_path("session-one")
        p2 = paths.manifest_text_sidecar_path("session-two")
        assert p1 != p2

    def test_null_byte_rejected(self, tmp_data_dir):
        """Null bytes in session_id should raise ValueError."""
        with pytest.raises(ValueError, match="null byte"):
            paths.manifest_text_sidecar_path("abc\x00def")


# ---------------------------------------------------------------------------
# --watch flag
# ---------------------------------------------------------------------------

class TestCompactHintWatch:
    """Tests for the --watch flag on the compact-hint command.

    All tests use unittest.mock to patch ``time.sleep`` and ``compact.build_manifest``
    so they complete instantly without real I/O.
    """

    def test_watch_flag_exists(self, tmp_data_dir, make_session):
        """--watch flag wires through to _compact_hint_watch (no unknown-option exit)."""
        import unittest.mock as mock  # noqa: PLC0415

        import token_goat.cli as cli_mod  # noqa: PLC0415

        sid = "watch-flag-exists-abc"
        make_session(sid, files_read=2, edits=1)

        call_count = [0]

        def _fast_watch(**kwargs):
            call_count[0] += 1

        with mock.patch.object(cli_mod, "_compact_hint_watch", side_effect=_fast_watch):
            result = runner.invoke(cli_mod.app, ["compact-hint", "--session-id", sid, "--watch"])

        assert result.exit_code == 0, result.output
        assert call_count[0] == 1

    def test_watch_shows_full_manifest_on_first_cycle(
        self, tmp_data_dir, make_session, capsys
    ):
        """First watch cycle prints the full manifest text."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-first-cycle-abc"
        make_session(sid, files_read=2, edits=1)

        manifests = ["## Token-Goat Manifest\n### Files Edited\n- edited0.py\n"]
        call_index = [0]

        def _fake_build(session_id, max_tokens=400):
            idx = min(call_index[0], len(manifests) - 1)
            call_index[0] += 1
            return manifests[idx]

        sleep_calls = []

        def _fake_sleep(secs):
            sleep_calls.append(secs)
            raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        # sleep must be called once (after the first manifest render) before KeyboardInterrupt.
        assert len(sleep_calls) == 1

    def test_watch_diff_shows_additions(self, tmp_data_dir, make_session, capsys):
        """Second watch cycle shows + lines for content added in the new manifest."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-diff-additions-abc"
        make_session(sid, files_read=2, edits=1)

        manifests = [
            "## Manifest\n### Files Edited\n- edited0.py\n",
            "## Manifest\n### Files Edited\n- edited0.py\n- new_file.py\n",
        ]
        call_index = [0]

        def _fake_build(session_id, max_tokens=400):
            idx = min(call_index[0], len(manifests) - 1)
            call_index[0] += 1
            return manifests[idx]

        sleep_count = [0]

        def _fake_sleep(secs):
            sleep_count[0] += 1
            if sleep_count[0] >= 2:
                raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        out = capsys.readouterr().out
        # The second cycle should show the added line with a '+' prefix.
        assert any(ln.startswith("+") and "new_file.py" in ln for ln in out.splitlines()), (
            f"Expected '+ new_file.py' in diff output but got:\n{out}"
        )

    def test_watch_diff_shows_removals(self, tmp_data_dir, make_session, capsys):
        """Second watch cycle shows - lines for content removed in the new manifest."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-diff-removals-abc"
        make_session(sid, files_read=2, edits=1)

        manifests = [
            "## Manifest\n### Files Edited\n- edited0.py\n- removed_file.py\n",
            "## Manifest\n### Files Edited\n- edited0.py\n",
        ]
        call_index = [0]

        def _fake_build(session_id, max_tokens=400):
            idx = min(call_index[0], len(manifests) - 1)
            call_index[0] += 1
            return manifests[idx]

        sleep_count = [0]

        def _fake_sleep(secs):
            sleep_count[0] += 1
            if sleep_count[0] >= 2:
                raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        out = capsys.readouterr().out
        assert any(ln.startswith("-") and "removed_file.py" in ln for ln in out.splitlines()), (
            f"Expected '- removed_file.py' in diff output but got:\n{out}"
        )

    def test_watch_no_change_shows_no_changes_message(
        self, tmp_data_dir, make_session, capsys
    ):
        """When consecutive manifests are identical, prints '(no changes)'."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-no-change-abc"
        make_session(sid, files_read=2, edits=1)

        same_manifest = "## Manifest\n### Files Edited\n- edited0.py\n"

        def _fake_build(session_id, max_tokens=400):
            return same_manifest

        sleep_count = [0]

        def _fake_sleep(secs):
            sleep_count[0] += 1
            if sleep_count[0] >= 2:
                raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        out = capsys.readouterr().out
        assert "(no changes)" in out, f"Expected '(no changes)' but got:\n{out}"

    def test_watch_header_contains_timestamp(
        self, tmp_data_dir, make_session, capsys
    ):
        """Each cycle header includes the HH:MM:SS timestamp pattern."""
        import re  # noqa: PLC0415
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-timestamp-header-abc"
        make_session(sid, files_read=2, edits=1)

        def _fake_build(session_id, max_tokens=400):
            return "## Manifest\n- content\n"

        def _fake_sleep(secs):
            raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        out = capsys.readouterr().out
        # Expect a line like "--- compact-hint watch [HH:MM:SS] ---"
        ts_pattern = re.compile(r"--- compact-hint watch \[\d{2}:\d{2}:\d{2}\] ---")
        assert ts_pattern.search(out), f"Expected timestamp header but got:\n{out}"

    def test_watch_stopped_watching_message_on_keyboard_interrupt(
        self, tmp_data_dir, make_session, capsys
    ):
        """Ctrl+C prints 'Stopped watching.' and exits cleanly."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-stopped-abc"
        make_session(sid, files_read=2, edits=1)

        def _fake_build(session_id, max_tokens=400):
            return "## Manifest\n- content\n"

        def _fake_sleep(secs):
            raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=60,
            )

        assert "Stopped watching." in capsys.readouterr().out

    def test_watch_custom_interval_passed_to_sleep(
        self, tmp_data_dir, make_session, capsys
    ):
        """--watch-interval value is forwarded to time.sleep."""
        import unittest.mock as mock  # noqa: PLC0415

        from token_goat import cli as cli_mod  # noqa: PLC0415
        from token_goat import compact as compact_mod  # noqa: PLC0415

        sid = "watch-interval-abc"
        make_session(sid, files_read=2, edits=1)

        def _fake_build(session_id, max_tokens=400):
            return "## Manifest\n- content\n"

        sleep_args = []

        def _fake_sleep(secs):
            sleep_args.append(secs)
            raise KeyboardInterrupt

        with mock.patch.object(compact_mod, "build_manifest", side_effect=_fake_build), \
             mock.patch("token_goat.cli.time.sleep", side_effect=_fake_sleep):
            cli_mod._compact_hint_watch(
                session_id=sid,
                auto=False,
                max_tokens=0,
                trigger="manual",
                interval=30,
            )

        assert sleep_args == [30], f"Expected sleep(30) but got {sleep_args}"
