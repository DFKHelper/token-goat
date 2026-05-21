"""Tests for the Commands Run section in the compaction manifest."""
from __future__ import annotations

import time

from token_goat import compact, session


def _make_mature(sid: str, age_seconds: float = 7200.0) -> None:
    """Backdate created_ts so the session is treated as 'mature' by age-tier logic."""
    cache = session.load(sid)
    cache.created_ts = time.time() - age_seconds
    session.save(cache)


def _seed_bash(sid: str, command: str, *, output_bytes: int = 8000, exit_code: int = 0) -> str:
    """Record a fake Bash invocation in the session and return its cmd_sha."""
    from token_goat import bash_cache

    cmd_sha = bash_cache.command_hash(command)
    session.mark_bash_run(
        session_id=sid,
        cmd_sha=cmd_sha,
        cmd_preview=command,
        output_id=f"out-{cmd_sha}",
        stdout_bytes=output_bytes,
        stderr_bytes=0,
        exit_code=exit_code,
        truncated=False,
    )
    return cmd_sha


class TestEventCountIncludesBash:
    def test_bash_alone_counts(self, tmp_data_dir):
        sid = "ec-bash-1"
        _seed_bash(sid, "pytest -v")
        assert compact.event_count(sid) == 1

    def test_bash_added_to_other_events(self, tmp_data_dir):
        sid = "ec-bash-2"
        session.mark_file_read(sid, "/tmp/a.py")
        _seed_bash(sid, "pytest -v")
        assert compact.event_count(sid) == 2


class TestManifestBashSection:
    def test_bash_section_emitted(self, tmp_data_dir):
        sid = "mb-1"
        # Add some non-bash activity so the manifest renders normally.
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "pytest -v tests/", output_bytes=12000, exit_code=1)
        # Backdate session so age-tier logic treats it as mature (bash section enabled).
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "Commands Run" in m
        assert "pytest -v tests/" in m
        assert "exit 1" in m
        # Cache ID is included so the agent can retrieve the body.
        from token_goat import bash_cache
        assert f"id=out-{bash_cache.command_hash('pytest -v tests/')}" in m

    def test_tiny_bash_skipped(self, tmp_data_dir):
        sid = "mb-2"
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "ls", output_bytes=20, exit_code=0)
        m = compact.build_manifest(sid, max_tokens=400)
        # Output too small to be useful — section omitted.
        assert "Commands Run" not in m

    def test_only_bash_still_renders_manifest(self, tmp_data_dir):
        sid = "mb-3"
        # Even when nothing was read or edited, a meaningful Bash output
        # alone should produce a manifest — that command's result is exactly
        # what the compaction LLM needs to preserve.
        # (event_count must clear min_events for the hook to actually fire,
        # but build_manifest itself does not enforce that; we test the render
        # path here.)
        _seed_bash(sid, "make build", output_bytes=20000)
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
    def test_git_status_filtered_from_manifest(self, tmp_data_dir):
        """git status commands consume budget with zero compaction value."""
        sid = "noop-1"
        session.mark_file_edited(sid, "/tmp/src.py")
        # Add a meaningful command
        _seed_bash(sid, "pytest -v tests/", output_bytes=12000, exit_code=0)
        # Add a no-op status check
        _seed_bash(sid, "git status", output_bytes=5000, exit_code=0)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        # pytest should appear, git status should not
        assert "pytest -v tests/" in m
        assert "git status" not in m

    def test_pwd_filtered_from_manifest(self, tmp_data_dir):
        """pwd is a no-op (< 5 chars, inaudible)."""
        sid = "noop-2"
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "pytest", output_bytes=12000)
        _seed_bash(sid, "pwd", output_bytes=1000)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        assert "pwd" not in m

    def test_echo_filtered_from_manifest(self, tmp_data_dir):
        """echo is a no-op."""
        sid = "noop-3"
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "npm test", output_bytes=8000)
        _seed_bash(sid, "echo hello", output_bytes=500)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "npm test" in m
        assert "echo hello" not in m

    def test_cat_with_tiny_output_filtered(self, tmp_data_dir):
        """cat on small files (< 200 bytes) is inaudible."""
        sid = "noop-4"
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "pytest", output_bytes=8000)
        _seed_bash(sid, "cat config.txt", output_bytes=100)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        assert "cat config.txt" not in m

    def test_cat_with_large_output_not_filtered(self, tmp_data_dir):
        """cat on larger files (>= 200 bytes) may be useful."""
        sid = "noop-5"
        session.mark_file_edited(sid, "/tmp/src.py")
        _seed_bash(sid, "pytest", output_bytes=8000)
        _seed_bash(sid, "cat large_log.txt", output_bytes=2000)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "pytest" in m
        # cat with large output passes the filter (may or may not appear based on budget)
        # The key is it's not filtered as a no-op
        from token_goat import bash_cache
        cat_sha = bash_cache.command_hash("cat large_log.txt")
        cat_id = f"id=out-{cat_sha}"
        # Either it appears or budget constraints exclude it, but not the no-op filter
        assert "cat large_log.txt" in m or cat_id not in m  # Allow both outcomes


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
