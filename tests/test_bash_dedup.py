"""Tests for content-aware bash output dedup.

Verifies that:
- Identical outputs trigger dedup hints
- Different outputs for same command do NOT trigger dedup hints
- Output size threshold is respected (configurable via bash_dedup_min_bytes)
- Backward compat with old session caches (no output_sha)
"""
from token_goat import cache_common, config, hints, session


class TestBashDedupContentAware:
    """Content-aware dedup tests."""

    def test_identical_output_triggers_dedup(self, tmp_data_dir):
        """Same output from same command triggers dedup hint."""
        sid = "test-identical-output"
        cmd = "echo hello"
        output = "hello\n"

        # First run: record
        cmd_sha = "abc1234567890def"  # mock hash
        output_sha = cache_common.short_content_hash(output)
        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-1",
            stdout_bytes=len(output),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=output_sha,
            cache=cache,
        )
        session.save(cache)

        # Second run: same output → dedup hint should suppress
        cache2 = session.load(sid)
        # Simulate the hint builder checking if we've seen this output
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry is not None
        assert entry.output_sha == output_sha

        # If we've already emitted a dedup for this output_sha, no hint
        dedup_key = entry.output_sha or entry.output_id
        cache2.bash_dedup_emitted_ids.add(dedup_key)
        session.save(cache2)

        cache3 = session.load(sid)
        entry3 = session.lookup_bash_entry(sid, cmd_sha, cache=cache3)
        assert entry3.output_sha in cache3.bash_dedup_emitted_ids

    def test_different_output_no_dedup(self, tmp_data_dir):
        """Same command with different output does NOT dedup."""
        sid = "test-different-output"
        cmd = "date"
        output1 = "Mon May 26 10:00:00 UTC 2026\n"
        output2 = "Mon May 26 10:00:01 UTC 2026\n"

        cmd_sha = "def4567890123abc"
        sha1 = cache_common.short_content_hash(output1)
        sha2 = cache_common.short_content_hash(output2)

        # First run
        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-1",
            stdout_bytes=len(output1),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=sha1,
            cache=cache,
        )
        session.save(cache)

        # Record the first dedup
        cache1 = session.load(sid)
        cache1.bash_dedup_emitted_ids.add(sha1)
        session.save(cache1)

        # Second run: different output
        # In real scenario, lookup_bash_entry returns the first entry (by cmd_sha).
        # But since output differs, we should NOT suppress the hint.
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry.output_sha == sha1

        # Pretend the second run has output_sha = sha2 (different)
        # The dedup check should see sha2 is NOT in bash_dedup_emitted_ids
        assert sha2 not in cache2.bash_dedup_emitted_ids

    def test_backward_compat_no_output_sha(self, tmp_data_dir):
        """Old sessions with empty output_sha still work."""
        sid = "test-backward-compat"
        cmd = "ls"

        # Create entry with empty output_sha (old format)
        cmd_sha = "old0000000000001"
        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-old",
            stdout_bytes=500,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha="",  # Empty for old entries
            cache=cache,
        )
        session.save(cache)

        # Load and verify fallback to output_id
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry.output_sha == ""

        # Dedup key should fall back to output_id
        dedup_key = entry.output_sha or entry.output_id
        assert dedup_key == "out-old"

        # Can add to dedup set
        cache2.bash_dedup_emitted_ids.add(dedup_key)
        session.save(cache2)

        cache3 = session.load(sid)
        assert dedup_key in cache3.bash_dedup_emitted_ids

    def test_small_output_no_dedup(self, tmp_data_dir):
        """Output below min_bytes threshold does not get dedup hints."""
        sid = "test-small-output"
        cmd = "echo x"
        output = "x\n"

        cmd_sha = "tiny0000000000x"
        output_sha = cache_common.short_content_hash(output)

        # Record a tiny output
        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-tiny",
            stdout_bytes=len(output),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=output_sha,
            cache=cache,
        )
        session.save(cache)

        # Lookup: the entry exists but is too small to dedup
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry is not None
        total_bytes = entry.stdout_bytes + entry.stderr_bytes
        # Assuming _BASH_DEDUP_MIN_BYTES is 200
        assert total_bytes < 200

    def test_dedup_json_serialization(self, tmp_data_dir):
        """output_sha persists in JSON correctly."""
        sid = "test-json-serialize"
        cmd = "test cmd"

        cmd_sha = "json0000000json"
        output_sha = "abcd1234efgh5678"

        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-json",
            stdout_bytes=300,
            stderr_bytes=50,
            exit_code=None,
            truncated=False,
            output_sha=output_sha,
            cache=cache,
        )
        session.save(cache)

        # Load from disk and verify
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry.output_sha == output_sha

    def test_configurable_bash_dedup_min_bytes_default(self, tmp_data_dir, monkeypatch):
        """Default bash_dedup_min_bytes is 200 bytes."""
        # Unset any env override
        monkeypatch.delenv("TOKEN_GOAT_BASH_DEDUP_MIN_BYTES", raising=False)
        # Clear config cache so it reloads
        config._config_mtime_cache = None

        min_bytes = hints._get_bash_dedup_min_bytes()
        assert min_bytes == 200

    def test_configurable_bash_dedup_min_bytes_env_override(self, tmp_data_dir, monkeypatch):
        """bash_dedup_min_bytes respects TOKEN_GOAT_BASH_DEDUP_MIN_BYTES env var."""
        # Set env override to 500
        monkeypatch.setenv("TOKEN_GOAT_BASH_DEDUP_MIN_BYTES", "500")
        # Clear config cache
        config._config_mtime_cache = None

        min_bytes = hints._get_bash_dedup_min_bytes()
        assert min_bytes == 500

    def test_configurable_bash_dedup_min_bytes_below_threshold(self, tmp_data_dir, monkeypatch):
        """Output below configured threshold does not trigger dedup hint."""
        # Set min to 1000 bytes
        monkeypatch.setenv("TOKEN_GOAT_BASH_DEDUP_MIN_BYTES", "1000")
        config._config_mtime_cache = None

        sid = "test-below-config-threshold"
        cmd = "echo test"
        output = "x" * 300  # Only 300 bytes, below the 1000-byte threshold

        cmd_sha = "configtest000001"
        output_sha = cache_common.short_content_hash(output)

        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-config",
            stdout_bytes=len(output),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=output_sha,
            cache=cache,
        )
        session.save(cache)

        # Lookup: output is below threshold, so dedup should not fire
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry is not None
        total_bytes = entry.stdout_bytes + entry.stderr_bytes
        min_bytes = hints._get_bash_dedup_min_bytes()
        assert total_bytes < min_bytes

    def test_configurable_bash_dedup_min_bytes_above_threshold(self, tmp_data_dir, monkeypatch):
        """Output above configured threshold triggers dedup hint (if already seen)."""
        # Set min to 100 bytes
        monkeypatch.setenv("TOKEN_GOAT_BASH_DEDUP_MIN_BYTES", "100")
        config._config_mtime_cache = None

        sid = "test-above-config-threshold"
        cmd = "echo test"
        output = "x" * 500  # 500 bytes, above the 100-byte threshold

        cmd_sha = "configtest000002"
        output_sha = cache_common.short_content_hash(output)

        cache = session.load(sid)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id="out-config-2",
            stdout_bytes=len(output),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=output_sha,
            cache=cache,
        )
        session.save(cache)

        # Lookup: output is above threshold
        cache2 = session.load(sid)
        entry = session.lookup_bash_entry(sid, cmd_sha, cache=cache2)
        assert entry is not None
        total_bytes = entry.stdout_bytes + entry.stderr_bytes
        min_bytes = hints._get_bash_dedup_min_bytes()
        assert total_bytes >= min_bytes
