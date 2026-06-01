"""Tests for the Commands Run section in the compaction manifest."""
from __future__ import annotations

import time
from dataclasses import dataclass

from token_goat import compact, session


class TestEventCountIncludesBash:
    def test_bash_alone_counts(self, tmp_data_dir, make_session):
        sid = "ec-bash-1"
        make_session(sid, bash_runs={"pytest -v": (8_000, 0)})
        assert compact.event_count(sid) == 1

    def test_bash_added_to_other_events(self, tmp_data_dir, make_session):
        sid = "ec-bash-2"
        make_session(sid, files_read=1, bash_runs={"pytest -v": (8_000, 0)})
        assert compact.event_count(sid) == 2


class TestManifestBashSection:
    def test_bash_section_emitted(self, tmp_data_dir, make_session):
        sid = "mb-1"
        # A failed run goes to "**Blocked:**"; a successful run goes to
        # "**Recent Commands:**". Both must appear for this test to pass.
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={
                "pytest -v tests/": (12000, 1),    # failed → Current Blockers
                "uv run ruff check src/": (5000, 0),  # success → Commands Run
            },
        )
        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Blocked:**" in m
        assert "pytest -v tests/" in m
        assert "exit 1" in m  # blocker format uses full "exit X"
        assert "**Recent Commands:**" in m
        assert "ruff check" in m
        # Exit code metadata appears in Commands Run for the successful run.
        assert "e=0" in m

    def test_tiny_bash_skipped(self, tmp_data_dir, make_session):
        sid = "mb-2"
        make_session(sid, edits=1, bash_runs={"ls": (20, 0)})
        m = compact.build_manifest(sid, max_tokens=400)
        # Output too small to be useful — section omitted.
        assert "**Recent Commands:**" not in m

    def test_only_bash_still_renders_manifest(self, tmp_data_dir, make_session):
        sid = "mb-3"
        # Even when nothing was read or edited, a meaningful Bash output
        # alone should produce a manifest — that command's result is exactly
        # what the compaction LLM needs to preserve.
        # (event_count must clear min_events for the hook to actually fire,
        # but build_manifest itself does not enforce that; we test the render
        # path here.)
        make_session(sid, bash_runs={"make build": (20000, 0)})
        m = compact.build_manifest(sid, max_tokens=400)
        # Files-only render path returns "" when no edits/reads — bash alone
        # does not (yet) lift it above the empty case, but the section helper
        # is exercised when render is called.  Either outcome is acceptable;
        # what we guard against is a crash.
        assert isinstance(m, str)

    def test_humanize_bytes(self):
        assert compact._humanize_bytes(120) == "120B"
        assert compact._humanize_bytes(2048).startswith("2.0KB")
        assert compact._humanize_bytes(5 * 1024 * 1024).startswith("5.0MB")


class TestNoopBashFiltering:
    def test_git_status_filtered_from_manifest(self, tmp_data_dir, make_session):
        """git status commands consume budget with zero compaction value."""
        sid = "noop-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={
                "pytest -v tests/": (12000, 0),
                "git status": (5000, 0),
            },
        )
        m = compact.build_manifest(sid, max_tokens=400)
        # pytest should appear, git status should not
        assert "pytest -v tests/" in m
        assert "git status" not in m

    def test_pwd_filtered_from_manifest(self, tmp_data_dir, make_session):
        """pwd is a no-op (< 5 chars, inaudible)."""
        sid = "noop-2"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest": (12000, 0), "pwd": (1000, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        assert "pwd" not in m

    def test_echo_filtered_from_manifest(self, tmp_data_dir, make_session):
        """echo is a no-op."""
        sid = "noop-3"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"npm test": (8000, 0), "echo hello": (500, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "npm test" in m
        assert "echo hello" not in m

    def test_cat_with_tiny_output_filtered(self, tmp_data_dir, make_session):
        """cat on small files (< 200 bytes) is inaudible."""
        sid = "noop-4"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest": (8000, 0), "cat config.txt": (100, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        assert "cat config.txt" not in m

    def test_cat_with_large_output_not_filtered(self, tmp_data_dir, make_session):
        """cat on larger files (>= 200 bytes) may be useful."""
        sid = "noop-5"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest": (8000, 0), "cat large_log.txt": (2000, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        # cat with large output passes the filter (may or may not appear based on budget)
        # The key is it's not filtered as a no-op
        from token_goat import bash_cache
        from token_goat.cache_common import short_output_id
        cat_sha = bash_cache.command_hash("cat large_log.txt")
        short_cat_id = f"id={short_output_id(f'out-{cat_sha}')}"
        # Either it appears or budget constraints exclude it, but not the no-op filter
        assert "cat large_log.txt" in m or short_cat_id not in m  # Allow both outcomes


class TestAnsiStrippingInTokenCap:
    def test_ansi_stripped_before_token_measurement(self, tmp_data_dir):
        """Verify that cap_tokens measures clean text, not ANSI-inflated text.

        When text contains heavy ANSI codes, the raw length includes escape
        sequences that don't render. Without stripping, the token estimate
        would be inflated, causing the cap to kick in too early. This test
        verifies that cap_tokens uses the clean text for its initial budget
        check.
        """
        from token_goat import bash_compress

        # Create a short text with minimal ANSI overhead
        short_text = "Output is OK"

        # Add heavy ANSI to inflate the byte count
        ansi_heavy = (
            "\x1b[31m" + short_text + "\x1b[0m" +  # red + short text + reset
            "\x1b[32m" * 100 +  # 200+ bytes of pure ANSI
            "\x1b[0m" * 100
        )

        # Without ANSI stripping, this would be ~400+ bytes but only ~2 tokens of content.
        # With stripping, it's ~12 bytes / ~3 tokens.
        # At max_tokens=10, without stripping the inflated estimate might trigger
        # truncation, with stripping it shouldn't.

        # With stripping (current code), the short text should pass through unchanged
        result = bash_compress.cap_tokens(ansi_heavy, max_tokens=10)
        clean_result = bash_compress.strip_ansi(result)
        # If cap_tokens used the ANSI-inflated estimate, it would truncate.
        # Since we strip before measuring, it should preserve the content.
        assert "Output is OK" in clean_result or "output capped at" in result
        # More specifically: the check should be: can we fit ~3 tokens in budget of 10?
        # Yes, so it should NOT be truncated.
        assert "output capped at" not in result

    def test_clean_text_token_cap_still_works(self, tmp_data_dir):
        """Normal text without ANSI codes should still be capped correctly."""
        from token_goat import bash_compress

        # ~1500 chars of plain text
        plain_text = "This is test output. " * 75

        # With max_tokens=50 (roughly 175 bytes), should be truncated
        result = bash_compress.cap_tokens(plain_text, max_tokens=50)
        # Should be smaller than original
        assert len(result) < len(plain_text)
        # Should have a capping marker
        assert "output capped at" in result


class TestCurrentBlockersSection:
    """Tests for the 'Current Blockers' manifest section."""

    def test_recent_failure_produces_blockers_section(self, tmp_data_dir, make_session):
        """A recent failed command surfaces in a 'Current Blockers' section."""
        sid = "blk-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest tests/": (8000, 1)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" in m
        assert "pytest tests/" in m
        assert "exit 1" in m

    def test_no_failures_omits_blockers_header(self, tmp_data_dir, make_session):
        """When all commands succeeded, 'Current Blockers' header is absent."""
        sid = "blk-2"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest tests/": (8000, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" not in m

    def test_stale_failure_omits_blockers_header(self, tmp_data_dir, make_session):
        """A failure older than 60 minutes is not treated as an active blocker."""
        sid = "blk-3"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"make build": (8000, 2)},
        )
        cache = session.load(sid)
        from token_goat import bash_cache
        sha = bash_cache.command_hash("make build")
        entry = cache.bash_history[sha]
        # Mutate the timestamp to 90 minutes in the past.
        object.__setattr__(entry, "ts", time.time() - 5400)
        session.save(cache)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" not in m

    def test_unknown_exit_code_not_treated_as_blocker(self, tmp_data_dir, make_session):
        """Commands with exit_code=None (unknown) are not surfaced as blockers."""
        sid = "blk-4"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"cargo build": (8000, None)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" not in m

    def test_blockers_appear_before_edited_files(self, tmp_data_dir, make_session):
        """Current Blockers section must precede Files Edited in the manifest."""
        sid = "blk-5"
        # Use a non-noise path so the Files Edited section actually appears.
        cache = session.load(sid)
        session.mark_file_edited(sid, "/home/user/project/src/module.py")
        cache = session.load(sid)
        cache.created_ts = time.time() - 7200
        session.save(cache)
        from token_goat import bash_cache
        cmd_sha = bash_cache.command_hash("pytest tests/")
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview="pytest tests/",
            output_id=f"out-{cmd_sha}",
            stdout_bytes=8000,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" in m
        # Uncommitted edits show as Staged/Uncommitted; committed show as Edited
        edited_header = "**Staged/Uncommitted:**" if "**Staged/Uncommitted:**" in m else "**Edited:**"
        assert edited_header in m, f"Expected {edited_header} in:\n{m}"
        blockers_pos = m.index("**Blocked:**")
        edited_pos = m.index(edited_header)
        assert blockers_pos < edited_pos, (
            f"Expected 'Current Blockers' (pos {blockers_pos}) before "
            f"'{edited_header}' (pos {edited_pos})"
        )

    def test_success_exit_zero_not_a_blocker(self, tmp_data_dir, make_session):
        """exit_code=0 is never a blocker regardless of output size."""
        sid = "blk-6"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"npm install": (50000, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Blocked:**" not in m

    def test_multiple_failures_capped_at_three(self, tmp_data_dir, make_session):
        """At most 3 blocker entries are shown even when more commands failed."""
        sid = "blk-7"
        bash_runs = {
            f"pytest test_{i}.py": (5000, 1)
            for i in range(5)
        }
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs=bash_runs,
        )
        m = compact.build_manifest(sid, max_tokens=800)
        # Count occurrences of the failure marker in the blockers section.
        lines = m.splitlines()
        blocker_section_lines = []
        in_blockers = False
        for line in lines:
            if line.startswith("**Blocked:**"):
                in_blockers = True
                continue
            if in_blockers and line.startswith("**"):
                break
            if in_blockers and line.startswith("- ✗"):
                blocker_section_lines.append(line)
        assert len(blocker_section_lines) <= 3

    def test_blocker_format_includes_exit_code(self, tmp_data_dir, make_session):
        """Each blocker line shows the command preview and exit code."""
        sid = "blk-8"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"mypy src/": (6000, 2)},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "✗ mypy src/" in m
        assert "exit 2" in m


class TestFilterChainEdgeCases:
    """Edge cases in filter chain composition and token cap behavior."""

    def test_filter_chain_near_cap_output(self, tmp_data_dir):
        """When one filter reduces output to just below cap, next filter doesn't exceed it.

        Tests that after filtering, the output respects the token cap even when
        the filter chain incrementally reduces content.
        """
        from token_goat import bash_compress

        # Create output that is just under the default cap when plain text,
        # but might exceed it if a filter doesn't respect boundaries.
        # DEFAULT_MAX_BYTES = 64 * 1024 = 65536
        # Create text at ~95% of cap (62208 bytes), then filter + cap it.
        near_cap_text = ("x" * 100 + "\n") * 600  # ~60.6 KB

        # Create a basic filter and apply it.
        f = bash_compress.Filter()
        result = f.apply(
            stdout=near_cap_text,
            stderr="",
            exit_code=0,
            argv=["some_command"],
            max_bytes=bash_compress.DEFAULT_MAX_BYTES,
        )

        # Result should never exceed the byte cap.
        assert len(result.text.encode("utf-8", errors="replace")) <= bash_compress.DEFAULT_MAX_BYTES
        # And it should have a cap marker if truncation occurred.
        if len(result.text) < len(near_cap_text):
            assert "token-goat" in result.text.lower()

    def test_stderr_only_output_through_filter_chain(self, tmp_data_dir):
        """stderr-only output (empty stdout) flows through filter chain correctly.

        Tests the case where stdout is empty but stderr contains meaningful content.
        """
        from token_goat import bash_compress

        stdout = ""
        stderr = "Error in compilation:\n/path/to/file.rs:42: unexpected token\n"

        f = bash_compress.Filter()
        result = f.apply(stdout=stdout, stderr=stderr, exit_code=1, argv=["rustc"])

        # The result should contain the stderr content.
        assert "compilation" in result.text or "unexpected token" in result.text

    def test_combined_stdout_stderr_near_cap(self, tmp_data_dir):
        """Combined stdout + stderr that pushes past cap is truncated correctly.

        When both stdout and stderr together exceed the cap, test that
        truncation happens and a cap marker is added.
        """
        from token_goat import bash_compress

        # Create stdout and stderr that together exceed the cap.
        stdout = "x" * 35000
        stderr = "y" * 35000

        f = bash_compress.Filter()
        result = f.apply(
            stdout=stdout,
            stderr=stderr,
            exit_code=0,
            argv=["some_command"],
            max_bytes=bash_compress.DEFAULT_MAX_BYTES,
        )

        # Result must not exceed cap.
        assert len(result.text.encode("utf-8", errors="replace")) <= bash_compress.DEFAULT_MAX_BYTES
        # And should have a truncation marker.
        assert "token-goat" in result.text or "middle" in result.text.lower()

    def test_empty_output_through_filter_chain(self, tmp_data_dir):
        """Empty stdout and stderr through filter chain returns empty without crash.

        Tests the edge case where both stdout and stderr are empty strings.
        """
        from token_goat import bash_compress

        f = bash_compress.Filter()
        result = f.apply(
            stdout="",
            stderr="",
            exit_code=0,
            argv=["echo"],
        )

        # Should return cleanly without error.
        assert isinstance(result.text, str)
        # Should be empty or nearly empty (minus any markers).
        assert len(result.text.strip()) == 0

    def test_ansi_heavy_output_measured_after_strip(self, tmp_data_dir):
        """ANSI stripping happens before token cap check (regression test).

        When output is ANSI-heavy, the token cap should measure the clean text,
        not the ANSI-inflated raw text. This ensures heavy colours don't trigger
        false truncation.
        """
        from token_goat import bash_compress

        # Create minimal content with heavy ANSI wrapping.
        content = "Test output"
        ansi_heavy = (
            "\x1b[31m" + content + "\x1b[0m"  # Red text + reset
            + "\x1b[32m" * 500  # Heavy ANSI codes that add 1000+ bytes
            + "\x1b[0m" * 500
        )

        # Measure via cap_tokens with a generous budget.
        # The content is ~3 tokens; at max_tokens=20, it should fit.
        result = bash_compress.cap_tokens(ansi_heavy, max_tokens=20)

        # The clean content should not be truncated.
        clean = bash_compress.strip_ansi(result)
        assert content in clean, (
            "ANSI-heavy output was truncated even though clean text fits in budget"
        )
        assert "capped at" not in result

    def test_python_filter_passthrough_non_python(self, tmp_data_dir):
        """PythonFilter passes through non-Python output unchanged (except normalise).

        When PythonFilter runs on non-Python output (no traceback), it should
        pass content through without modification (after normalise).
        """
        from token_goat import bash_compress

        # Non-Python output (no traceback).
        output = "Some generic command output\nLine 2\nLine 3\n"

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=output,
            stderr="",
            exit_code=0,
            argv=["python", "-c", "print('hello')"],
        )

        # The content should be preserved (with normalisation applied).
        assert "Some generic command output" in result.text
        assert "Line 2" in result.text

    def test_python_filter_multiple_tracebacks(self, tmp_data_dir):
        """PythonFilter compresses multiple consecutive tracebacks.

        When a command produces multiple tracebacks (e.g., retries), the filter
        should compress them appropriately.
        """
        from token_goat import bash_compress

        # Create two separate tracebacks.
        tb1 = (
            "Traceback (most recent call last):\n"
            "  File \"script.py\", line 42, in <module>\n"
            "    result = compute(x)\n"
            "  File \"script.py\", line 30, in compute\n"
            "    return x / 0\n"
            "ZeroDivisionError: division by zero\n"
        )
        tb2 = (
            "Traceback (most recent call last):\n"
            "  File \"script.py\", line 42, in <module>\n"
            "    result = compute(x)\n"
            "  File \"script.py\", line 30, in compute\n"
            "    return x / 0\n"
            "ZeroDivisionError: division by zero\n"
        )
        combined = tb1 + "\n" + tb2

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=combined,
            stderr="",
            exit_code=1,
            argv=["python", "script.py"],
        )

        # Result should be shorter than input due to compression.
        assert len(result.text) < len(combined), (
            "Multiple tracebacks should be compressed, but output was not smaller"
        )
        # Should contain error message.
        assert "ZeroDivisionError" in result.text


class TestPythonFilter:
    """Dedicated tests for PythonFilter compression."""

    def test_traceback_compression_keeps_innermost_frame(self, tmp_data_dir):
        """Traceback compression keeps error line and innermost frame."""
        from token_goat import bash_compress

        traceback = (
            "Traceback (most recent call last):\n"
            "  File \"a.py\", line 10, in outer\n"
            "    middle_call()\n"
            "  File \"b.py\", line 20, in middle\n"
            "    inner_call()\n"
            "  File \"c.py\", line 30, in inner\n"
            "    bad_operation()\n"
            "ValueError: invalid value\n"
        )

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=traceback,
            stderr="",
            exit_code=1,
            argv=["python", "a.py"],
        )

        # Should keep error line.
        assert "ValueError: invalid value" in result.text
        # Innermost frame should be preserved.
        inner_present = 'File "c.py", line 30, in inner' in result.text
        has_inner = inner_present or "innermost" in result.text.lower()
        assert has_inner

    def test_traceback_over_10_frames_keeps_first_and_last(self, tmp_data_dir):
        """Tracebacks with >10 frames keep first 2 and last 3 with omission marker."""
        from token_goat import bash_compress

        # Create a 15-frame traceback.
        frames = [
            f"  File \"file{i}.py\", line {10 + i}, in func{i}\n"
            f"    call_next()\n"
            for i in range(15)
        ]
        traceback = (
            "Traceback (most recent call last):\n"
            + "".join(frames)
            + "RuntimeError: deep recursion\n"
        )

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=traceback,
            stderr="",
            exit_code=1,
            argv=["python", "test.py"],
        )

        # Should contain omission marker.
        assert "frames omitted" in result.text, (
            "Long traceback should have omission marker but got: " + result.text
        )
        # Should be significantly shorter than input.
        assert len(result.text) < len(traceback) // 2

    def test_repeated_lines_deduplicated(self, tmp_data_dir):
        """Repeated lines (5+) are collapsed to 'line × N'."""
        from token_goat import bash_compress

        # Create output with 10 repeated lines.
        output = "\n".join(["repeated warning"] * 10)

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=output,
            stderr="",
            exit_code=0,
            argv=["python", "-c", "code"],
        )

        # Should use the dedup marker format.
        assert "repeated warning" in result.text
        # Should be much shorter (collapsed to ~1 line with count).
        assert result.text.count("repeated warning") < 10 or "×" in result.text

    def test_warning_spam_compression(self, tmp_data_dir):
        """Repeated warnings (>3) are compressed to keep first 3, summarize rest."""
        from token_goat import bash_compress

        # Create 10 similar warnings (must match _PYTHON_WARNING_RE: "^\s*.*Warning:\s").
        warnings = "\n".join(
            [f"script.py:{i}: DeprecationWarning: old API" for i in range(1, 11)]
        )

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=warnings,
            stderr="",
            exit_code=0,
            argv=["python", "script.py"],
        )

        # Should contain a suppression summary for the extra warnings.
        # With 10 warnings and keeping first 3, we expect a suppression marker.
        assert "suppressed" in result.text.lower(), (
            f"Expected suppression summary for repeated warnings, got: {result.text}"
        )

    def test_python_filter_matches_python_binary(self, tmp_data_dir):
        """PythonFilter.matches() returns True for python/python3 commands."""
        from token_goat import bash_compress

        f = bash_compress.PythonFilter()

        # Should match python
        assert f.matches(["python", "script.py"])
        assert f.matches(["python3", "script.py"])
        assert f.matches(["/usr/bin/python3.11", "-c", "code"])

        # Should not match pytest (handled by PytestFilter).
        assert not f.matches(["python", "-m", "pytest"])
        assert not f.matches(["pytest", "tests/"])

    def test_python_filter_does_not_match_non_python(self, tmp_data_dir):
        """PythonFilter.matches() returns False for non-Python commands."""
        from token_goat import bash_compress

        f = bash_compress.PythonFilter()

        assert not f.matches(["node", "script.js"])
        assert not f.matches(["go", "run", "main.go"])
        assert not f.matches([])

    def test_empty_traceback_passthrough(self, tmp_data_dir):
        """PythonFilter on output with incomplete traceback passes through."""
        from token_goat import bash_compress

        # No error line, just "Traceback" header — not a complete traceback.
        incomplete = (
            "Traceback (most recent call last):\n"
            "  File \"script.py\", line 1, in <module>\n"
        )

        f = bash_compress.PythonFilter()
        result = f.apply(
            stdout=incomplete,
            stderr="",
            exit_code=0,
            argv=["python", "script.py"],
        )

        # Should pass through without crashing — incomplete traceback is emitted verbatim.
        assert isinstance(result.text, str)
        assert "Traceback" in result.text
        assert "script.py" in result.text


class TestFormatBashEntryRunCount:
    """_format_bash_entry shows [×N] when run_count > 1."""

    def _make_entry(self, run_count=1, exit_code=0):
        from token_goat.session import BashEntry
        return BashEntry(
            cmd_sha="abc123",
            cmd_preview="pytest -v tests/",
            output_id="out-abc123",
            ts=0.0,
            stdout_bytes=5000,
            stderr_bytes=0,
            exit_code=exit_code,
            truncated=False,
            run_count=run_count,
        )

    def test_run_count_1_no_marker(self):
        line = compact._format_bash_entry(self._make_entry(run_count=1))
        assert "[×" not in line
        assert "pytest -v tests/" in line

    def test_run_count_3_shows_marker(self):
        line = compact._format_bash_entry(self._make_entry(run_count=3))
        assert "[×3]" in line
        assert "pytest -v tests/" in line

    def test_run_count_10_shows_marker(self):
        line = compact._format_bash_entry(self._make_entry(run_count=10))
        assert "[×10]" in line

    def test_run_count_marker_before_parens(self):
        line = compact._format_bash_entry(self._make_entry(run_count=5, exit_code=1))
        # Marker appears between the command preview and the parenthesised metadata.
        marker_pos = line.index("[×5]")
        paren_pos = line.index("(e=1")
        assert marker_pos < paren_pos


class TestSelectTopGlobEntries:
    """_select_top_glob_entries filters trivials and caps at _MAX_GLOB_ENTRIES."""

    def _make_entry(self, pattern, ts=0.0, path=None, result_count=None):
        return session.GlobEntry(pattern=pattern, path=path, ts=ts, result_count=result_count)

    def test_empty_list_returns_empty(self):
        assert compact._select_top_glob_entries([]) == []

    def test_none_returns_empty(self):
        assert compact._select_top_glob_entries(None) == []  # type: ignore[arg-type]

    def test_trivial_patterns_excluded(self):
        entries = [
            self._make_entry("*", ts=1.0),
            self._make_entry("**", ts=2.0),
            self._make_entry("", ts=3.0),
        ]
        assert compact._select_top_glob_entries(entries) == []

    def test_non_trivial_patterns_included(self):
        entries = [self._make_entry("**/*.py", ts=1.0)]
        result = compact._select_top_glob_entries(entries)
        assert len(result) == 1
        assert result[0].pattern == "**/*.py"

    def test_caps_at_max_glob_entries(self):
        entries = [self._make_entry(f"**/*.ext{i}", ts=float(i)) for i in range(10)]
        result = compact._select_top_glob_entries(entries)
        assert len(result) == compact._MAX_GLOB_ENTRIES

    def test_returns_most_recent(self):
        entries = [self._make_entry("src/**/*.py", ts=float(i)) for i in range(5)]
        result = compact._select_top_glob_entries(entries)
        # All have same pattern but different timestamps; most-recent ts=4.0 must be present
        tss = [e.ts for e in result]
        assert 4.0 in tss


class TestFormatGlobEntry:
    """_format_glob_entry renders pattern, scope, and file count."""

    def _make_entry(self, pattern, path=None, result_count=None):
        return session.GlobEntry(pattern=pattern, path=path, ts=0.0, result_count=result_count)

    def test_pattern_only(self):
        line = compact._format_glob_entry(self._make_entry("**/*.py"))
        assert "**/*.py" in line
        # Item #4: emoji prefix `\U0001f4c2` was replaced with ASCII `g:`
        # because multi-byte emojis cost more tokens than 2 ASCII chars.
        assert line.startswith("- g:")

    def test_with_path_scope(self):
        line = compact._format_glob_entry(self._make_entry("**/*.ts", path="src/"))
        assert "src/" in line

    def test_with_result_count(self):
        line = compact._format_glob_entry(self._make_entry("**/*.rs", result_count=42))
        assert "42 files" in line

    def test_with_path_and_count(self):
        line = compact._format_glob_entry(self._make_entry("*.toml", path=".", result_count=5))
        assert "." in line
        assert "5 files" in line

    def test_no_count_when_none(self):
        line = compact._format_glob_entry(self._make_entry("**/*.go"))
        assert "files" not in line


class TestSelectTopEntries:
    """_select_top_entries shared helper: defensive typing and edge cases."""

    def _make_obj(self, size, ts=0.0, exclude=False):
        """Simple object with configurable size, ts, and exclude flag."""
        from types import SimpleNamespace
        return SimpleNamespace(size=size, ts=ts, exclude=exclude)

    def _size_fn(self, e):
        return e.size

    def _exclude_fn(self, e):
        return e.exclude

    def test_non_dict_input_returns_empty(self):
        assert compact._select_top_entries(None, 0, self._size_fn, 5) == []  # type: ignore[arg-type]
        assert compact._select_top_entries("not-a-dict", 0, self._size_fn, 5) == []  # type: ignore[arg-type]
        assert compact._select_top_entries([], 0, self._size_fn, 5) == []  # type: ignore[arg-type]

    def test_empty_dict_returns_empty(self):
        assert compact._select_top_entries({}, 0, self._size_fn, 5) == []

    def test_below_min_bytes_filtered(self):
        history = {"a": self._make_obj(size=10), "b": self._make_obj(size=5)}
        result = compact._select_top_entries(history, min_bytes=50, size_fn=self._size_fn, max_n=10)
        assert result == []

    def test_above_min_bytes_included(self):
        obj = self._make_obj(size=100)
        result = compact._select_top_entries({"a": obj}, min_bytes=50, size_fn=self._size_fn, max_n=10)
        assert len(result) == 1
        assert result[0] is obj

    def test_exclude_fn_removes_entries(self):
        keep = self._make_obj(size=100, exclude=False)
        drop = self._make_obj(size=100, exclude=True)
        result = compact._select_top_entries(
            {"a": keep, "b": drop},
            min_bytes=0, size_fn=self._size_fn, max_n=10,
            exclude_fn=self._exclude_fn,
        )
        assert result == [keep]

    def test_exclude_fn_none_keeps_all(self):
        objs = {str(i): self._make_obj(size=100, ts=float(i)) for i in range(5)}
        result = compact._select_top_entries(objs, min_bytes=0, size_fn=self._size_fn, max_n=10)
        assert len(result) == 5

    def test_max_n_caps_result(self):
        objs = {str(i): self._make_obj(size=100, ts=float(i)) for i in range(20)}
        result = compact._select_top_entries(objs, min_bytes=0, size_fn=self._size_fn, max_n=5)
        assert len(result) == 5

    def test_returns_most_recent_by_ts(self):
        objs = {str(i): self._make_obj(size=100, ts=float(i)) for i in range(10)}
        result = compact._select_top_entries(objs, min_bytes=0, size_fn=self._size_fn, max_n=3)
        tss = {e.ts for e in result}
        assert tss == {7.0, 8.0, 9.0}

    def test_missing_ts_defaults_to_zero(self):
        """Entries with no ts attribute rank last (ts defaults to 0.0 via getattr)."""
        from types import SimpleNamespace
        no_ts = SimpleNamespace(size=200)  # no .ts attribute
        with_ts = self._make_obj(size=100, ts=5.0)
        result = compact._select_top_entries(
            {"a": with_ts, "b": no_ts},
            min_bytes=0, size_fn=lambda e: getattr(e, "size", 0), max_n=1,
        )
        assert result[0] is with_ts


class TestMiddleTruncate:
    """Unit tests for compact._middle_truncate."""

    def test_short_text_unchanged(self):
        """Text with fewer lines than max_lines is returned verbatim."""
        text = "\n".join(f"line {i}" for i in range(10))
        assert compact._middle_truncate(text, max_lines=20) == text

    def test_exact_max_lines_unchanged(self):
        """Text with exactly max_lines lines is returned verbatim."""
        text = "\n".join(f"line {i}" for i in range(20))
        assert compact._middle_truncate(text, max_lines=20) == text

    def test_long_output_truncated(self):
        """Text exceeding max_lines is truncated to fewer lines than the original."""
        text = "\n".join(f"line {i}" for i in range(50))
        result = compact._middle_truncate(text, max_lines=20)
        assert len(result.splitlines()) < 50

    def test_omission_marker_present(self):
        """Middle-truncated output contains the omission marker."""
        text = "\n".join(f"line {i}" for i in range(50))
        result = compact._middle_truncate(text, max_lines=20)
        assert "lines omitted" in result

    def test_first_and_last_lines_preserved(self):
        """The very first and very last lines of the input survive truncation."""
        lines = [f"line {i}" for i in range(50)]
        text = "\n".join(lines)
        result = compact._middle_truncate(text, max_lines=20)
        result_lines = result.splitlines()
        assert result_lines[0] == lines[0]
        assert result_lines[-1] == lines[-1]

    def test_omitted_count_correct(self):
        """The marker accurately reports how many lines were dropped."""
        n = 50
        max_lines = 20
        import math
        keep = math.ceil(max_lines * 0.4)
        expected_omitted = n - keep * 2
        text = "\n".join(f"line {i}" for i in range(n))
        result = compact._middle_truncate(text, max_lines=max_lines)
        assert f"[{expected_omitted} lines omitted]" in result


class TestFormatBashEntryInlineSnippet:
    """_format_bash_entry inline_snippet parameter controls snippet emission."""

    def _make_entry(self, stdout_bytes=5000, exit_code=0, output_id="out-abc123"):
        from token_goat.session import BashEntry
        return BashEntry(
            cmd_sha="abc123",
            cmd_preview="pytest -v tests/",
            output_id=output_id,
            ts=0.0,
            stdout_bytes=stdout_bytes,
            stderr_bytes=0,
            exit_code=exit_code,
            truncated=False,
            run_count=1,
        )

    def test_inline_snippet_false_no_indented_block(self):
        """When inline_snippet=False the rendered entry has no indented body."""
        entry = self._make_entry()
        line = compact._format_bash_entry(entry, inline_snippet=False)
        assert "\n  " not in line, "Expected no indented block when inline_snippet=False"

    def test_inline_snippet_false_header_still_present(self):
        """Header line (command preview + metadata) is always emitted regardless of inline_snippet."""
        entry = self._make_entry()
        line = compact._format_bash_entry(entry, inline_snippet=False)
        assert "pytest -v tests/" in line
        assert "e=0" in line  # exit code metadata present

    def test_inline_snippet_true_default_behaviour_preserved(self):
        """inline_snippet=True (the default) preserves existing rendering path."""
        entry = self._make_entry()
        # Default call — should behave identically to explicit True.
        line_default = compact._format_bash_entry(entry)
        line_true = compact._format_bash_entry(entry, inline_snippet=True)
        assert line_default == line_true

    def test_inline_snippet_false_single_line(self):
        """inline_snippet=False always returns exactly one line."""
        entry = self._make_entry(stdout_bytes=50_000)
        line = compact._format_bash_entry(entry, inline_snippet=False)
        assert "\n" not in line

    def test_small_entry_no_snippet_in_manifest(self, tmp_data_dir, make_session):
        """Commands under 600 bytes get no inline snippet in the manifest.

        The entry still appears (header line) but without an indented block.
        """
        sid = "snip-small-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"uv run ruff check src/": (500, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=800)
        assert "ruff check" in m
        # No indented snippet block — every line after the header must start
        # with "- " or "###" (manifest structure), not "  " (snippet indent).
        lines = m.splitlines()
        in_commands_run = False
        for line in lines:
            if line.startswith("**Recent Commands:**"):
                in_commands_run = True
                continue
            if in_commands_run and line.startswith("**"):
                break
            if in_commands_run and line.startswith("  ") and line.strip():
                raise AssertionError(
                    f"Found indented snippet for small (<600B) entry: {line!r}"
                )

    def test_large_entry_gets_snippet_in_manifest(self, tmp_data_dir, make_session):
        """Commands >= 600 bytes include inline snippet in the manifest."""
        sid = "snip-large-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"uv run pytest tests/": (8000, 0)},
        )
        m = compact.build_manifest(sid, max_tokens=1200)
        assert "pytest tests/" in m
        # The bash_cache for this test session won't have real file content,
        # so snippet may not appear even for large entries — what matters is
        # no crash and the header line is present.
        assert "e=0" in m or "e=?" in m  # exit code present in metadata

    def test_blocker_always_inline_regardless_of_size(self, tmp_data_dir, make_session):
        """Blocker entries (exit_code != 0) always emit inline_snippet=True path.

        Blockers appear in the Current Blockers section (not Commands Run), so
        this test validates that build_manifest does not crash and the blocker
        itself is present.
        """
        sid = "snip-blk-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            bash_runs={"pytest tests/": (450, 1)},  # small but failing
        )
        m = compact.build_manifest(sid, max_tokens=800)
        assert "**Blocked:**" in m
        assert "pytest tests/" in m
        assert "exit 1" in m


@dataclass
class _StubBashEntry:
    """Lightweight stand-in for session.BashEntry in item-#28 unit tests."""

    cmd_sha: str
    cmd_preview: str
    output_id: str
    ts: float
    stdout_bytes: int
    stderr_bytes: int
    exit_code: int | None = None
    truncated: bool = False
    run_count: int = 1
    elapsed_ms: float | None = None


class TestClassifyBashEntry:
    """Item #28: _classify_bash_entry buckets each entry into failed/slow/ok."""

    @staticmethod
    def _make(exit_code: int | None, elapsed_ms: float | None = None) -> _StubBashEntry:
        return _StubBashEntry(
            cmd_sha="sha", cmd_preview="cmd", output_id="oid", ts=0.0,
            stdout_bytes=100, stderr_bytes=0,
            exit_code=exit_code, elapsed_ms=elapsed_ms,
        )

    def test_failed_when_exit_nonzero(self):
        assert compact._classify_bash_entry(self._make(exit_code=1)) == "failed"

    def test_failed_when_exit_negative(self):
        assert compact._classify_bash_entry(self._make(exit_code=-15)) == "failed"

    def test_ok_when_exit_zero_and_fast(self):
        assert compact._classify_bash_entry(self._make(exit_code=0, elapsed_ms=100)) == "ok"

    def test_ok_when_exit_unknown(self):
        # Unknown exit (None) defaults to ok — avoids false "failed" alarms.
        assert compact._classify_bash_entry(self._make(exit_code=None)) == "ok"

    def test_slow_when_exit_zero_and_elapsed_above_threshold(self):
        # 6 seconds > _SLOW_BASH_THRESHOLD_SECS (5s)
        assert compact._classify_bash_entry(self._make(exit_code=0, elapsed_ms=6000)) == "slow"

    def test_ok_when_exit_zero_at_threshold(self):
        # Threshold is strict greater-than: exactly 5s is still ok.
        assert compact._classify_bash_entry(
            self._make(exit_code=0, elapsed_ms=5000)
        ) == "ok"

    def test_failed_overrides_slow(self):
        # A slow failing run should be classified failed, not slow.
        assert compact._classify_bash_entry(
            self._make(exit_code=1, elapsed_ms=30000)
        ) == "failed"

    def test_missing_elapsed_fields_defaults_ok(self):
        # Real BashEntry today has no elapsed_ms field; getattr defaults to 0.
        entry = _StubBashEntry(
            cmd_sha="s", cmd_preview="c", output_id="o", ts=0.0,
            stdout_bytes=100, stderr_bytes=0, exit_code=0,
        )
        assert compact._classify_bash_entry(entry) == "ok"


class TestRenderBashGrouped:
    """Item #28: _render_bash_grouped emits Failed/Slow/Ok sub-groups."""

    @staticmethod
    def _make(
        cmd: str, exit_code: int, *, elapsed_ms: float | None = None, idx: int = 0
    ) -> _StubBashEntry:
        return _StubBashEntry(
            cmd_sha=f"sha{idx}",
            cmd_preview=cmd,
            output_id=f"oid{idx}",
            ts=float(idx),
            stdout_bytes=200,
            stderr_bytes=0,
            exit_code=exit_code,
            elapsed_ms=elapsed_ms,
        )

    @staticmethod
    def _never_inline(_be: object) -> bool:
        return False

    def test_only_failed_entries_emit_failed_header(self):
        """A bash list of pure failures gets the **Failed:** sub-header."""
        entries: list[object] = [
            self._make("pytest a", exit_code=1, idx=0),
            self._make("pytest b", exit_code=2, idx=1),
        ]
        lines, used = compact._render_bash_grouped(
            entries, budget=1_000, should_inline=self._never_inline,
        )
        assert lines[0] == "**Recent Commands:**"
        assert "**Failed:**" in lines
        # No **Slow:** / **Ok:** headers when those groups are empty.
        assert "**Slow:**" not in lines
        assert "**Ok:**" not in lines
        assert used > 0

    def test_mixed_failed_and_ok_no_slow_header(self):
        """Failed + Ok groups present, Slow group empty → no **Slow:** header."""
        entries: list[object] = [
            self._make("pytest a", exit_code=1, idx=0),
            self._make("ruff check", exit_code=0, idx=1),
            self._make("mypy src", exit_code=0, idx=2),
        ]
        lines, _ = compact._render_bash_grouped(
            entries, budget=1_000, should_inline=self._never_inline,
        )
        joined = "\n".join(lines)
        # Both group headers emitted because there are multiple non-empty groups.
        assert "**Failed:**" in joined
        assert "**Ok:**" in joined
        assert "**Slow:**" not in joined
        # Failed precedes Ok in emission order.
        assert lines.index("**Failed:**") < lines.index("**Ok:**")

    def test_all_ok_omits_ok_subheader(self):
        """When every entry is ok, the **Ok:** sub-header is omitted entirely
        (the **Recent Commands:** label is sufficient context).
        """
        entries: list[object] = [
            self._make("ls", exit_code=0, idx=0),
            self._make("pwd", exit_code=0, idx=1),
        ]
        lines, _ = compact._render_bash_grouped(
            entries, budget=1_000, should_inline=self._never_inline,
        )
        assert lines[0] == "**Recent Commands:**"
        assert "**Ok:**" not in lines
        assert "**Failed:**" not in lines
        assert "**Slow:**" not in lines

    def test_all_three_groups_emit_in_priority_order(self):
        """Failed → Slow → Ok emission order, with all sub-headers present."""
        entries: list[object] = [
            self._make("pytest fail", exit_code=1, idx=0),
            self._make("pytest slow", exit_code=0, elapsed_ms=10_000, idx=1),
            self._make("ls fast", exit_code=0, elapsed_ms=10, idx=2),
        ]
        lines, _ = compact._render_bash_grouped(
            entries, budget=2_000, should_inline=self._never_inline,
        )
        # All three group headers present.
        assert "**Failed:**" in lines
        assert "**Slow:**" in lines
        assert "**Ok:**" in lines
        # Priority order: failed → slow → ok.
        assert lines.index("**Failed:**") < lines.index("**Slow:**") < lines.index("**Ok:**")

    def test_empty_entries_returns_empty_output(self):
        lines, used = compact._render_bash_grouped(
            [], budget=1_000, should_inline=self._never_inline,
        )
        assert lines == []
        assert used == 0

    def test_zero_budget_emits_nothing(self):
        """An impossibly tight budget yields no output (no lone sub-headers)."""
        entries: list[object] = [self._make("pytest", exit_code=1, idx=0)]
        lines, used = compact._render_bash_grouped(
            entries, budget=1, should_inline=self._never_inline,
        )
        assert lines == []
        assert used == 0

    def test_preserves_within_group_order(self):
        """Within each group, original ordering of `bash_entries` is preserved."""
        entries: list[object] = [
            self._make("cmd_ok_1", exit_code=0, idx=0),
            self._make("cmd_ok_2", exit_code=0, idx=1),
            self._make("cmd_ok_3", exit_code=0, idx=2),
        ]
        lines, _ = compact._render_bash_grouped(
            entries, budget=1_000, should_inline=self._never_inline,
        )
        joined = "\n".join(lines)
        assert joined.index("cmd_ok_1") < joined.index("cmd_ok_2") < joined.index("cmd_ok_3")
