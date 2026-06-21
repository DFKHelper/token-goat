"""Tests for the bash_cache on-disk store + post_bash hook integration."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import bash_cache, hooks_read, session


class TestStoreAndLoad:
    def test_small_output_round_trip(self, tmp_data_dir):
        """A small output is written verbatim and read back identical."""
        meta = bash_cache.store_output(
            "sess1", "ls -lh", "total 16\n-rw-r--r-- 1 user user x" * 10,
            "", 0,
        )
        assert meta is not None
        body = bash_cache.load_output(meta.output_id)
        assert body is not None and "total 16" in body
        assert meta.stdout_bytes > 0
        assert meta.exit_code == 0
        assert meta.truncated is False

    def test_large_output_is_tail_preserved(self, tmp_data_dir):
        """An output above the 2 MB cap is truncated head-only with a marker."""
        big = "A" * (3 * 1024 * 1024)
        meta = bash_cache.store_output("sess2", "yes A", big, "", 0)
        assert meta is not None
        assert meta.truncated is True
        body = bash_cache.load_output(meta.output_id)
        assert body is not None
        # Marker is in the head; the trailing portion of the original output
        # (every byte the tail check needs) is preserved.
        assert "token-goat: bash output truncated" in body
        # The very last characters of `big` are preserved at the tail.
        assert body.endswith("A")

    def test_utf8_truncation_bounded_by_bytes_not_chars(self, tmp_data_dir):
        """Regression: store_output must bound the stored body by utf-8 bytes.

        Previously the truncation sliced on codepoints, which for multi-byte
        characters (CJK, emoji) could store up to 4× the cap on disk.  A 2 MB
        cap with all 4-byte emoji would store up to 8 MB and silently
        overshoot the 16 MB directory cap.  The fix slices on raw utf-8 bytes
        with safe decode at the boundary.
        """
        # 3-byte CJK characters.  Aim for ~3 MB on disk pre-truncation.
        # 1_000_000 × 3 bytes = 3_000_000 bytes (above the 2 MB cap).
        big_cjk = "中" * 1_000_000
        meta = bash_cache.store_output("utf8-sess", "echo cjk", big_cjk, "", 0)
        assert meta is not None
        assert meta.truncated is True

        body = bash_cache.load_output(meta.output_id)
        assert body is not None
        # The kept content (after the marker prefix) must be at or under the
        # 2 MB cap when encoded as utf-8.
        marker_end = body.index("]\n") + 2
        kept = body[marker_end:]
        kept_bytes = len(kept.encode("utf-8", errors="replace"))
        max_stored = 2 * 1024 * 1024
        # Allow a tiny overhead for the truncation marker itself, but the kept
        # content slice must be at or under the cap.
        assert kept_bytes <= max_stored, (
            f"kept body {kept_bytes} bytes exceeds cap {max_stored}"
        )

    def test_id_format_rejects_traversal(self, tmp_data_dir):
        """A crafted output_id with traversal characters returns no path."""
        assert bash_cache.load_output("../../etc/passwd") is None
        assert bash_cache.load_output("sess/with/slash") is None

    def test_load_missing_returns_none(self, tmp_data_dir):
        assert bash_cache.load_output("nonexistent-id") is None

    def test_sidecar_round_trip(self, tmp_data_dir):
        """write_sidecar / read_sidecar preserves all metadata fields."""
        meta = bash_cache.store_output(
            "sess3", "pytest -v", "PASS x" * 200, "warn\n", 0,
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)
        loaded = bash_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.cmd_sha == meta.cmd_sha
        assert loaded.exit_code == 0

    def test_evict_old_entries_respects_cap(self, tmp_data_dir):
        """When total cache size exceeds the cap, the oldest entries go first."""
        for i in range(5):
            bash_cache.store_output(
                f"sess{i}", f"echo {i}", "X" * 200_000, "", 0,
            )
        evicted = bash_cache.evict_old_entries(max_total_bytes=300_000)
        assert evicted >= 1

    def test_evict_removes_paired_sidecars(self, tmp_data_dir):
        """Eviction removes both the body and its sidecar JSON together."""
        from pathlib import Path as _Path

        metas = []
        for i in range(5):
            m = bash_cache.store_output(
                f"sess{i}", f"echo {i}", "X" * 200_000, "", 0,
            )
            assert m is not None
            bash_cache.write_sidecar(m)
            metas.append(m)

        # Sanity: every body has a sidecar before eviction.
        for m in metas:
            sp = bash_cache.sidecar_meta_path(m.output_id)
            assert sp is not None and sp.exists()

        bash_cache.evict_old_entries(max_total_bytes=300_000)

        # For any body removed, the sidecar must also be gone.
        for m in metas:
            body = (
                _Path(bash_cache._bash_outputs_dir()) / f"{m.output_id}.txt"
            )
            sp = bash_cache.sidecar_meta_path(m.output_id)
            assert sp is not None
            if not body.exists():
                assert not sp.exists(), f"orphan sidecar left after eviction: {sp.name}"

    def test_orphan_sidecar_sweep(self, tmp_data_dir):
        """An orphan sidecar (no matching body) is removed by the next pass."""
        # Seed a single legitimate entry so the cache directory exists.
        m = bash_cache.store_output("sess0", "ls", "X" * 500, "", 0)
        assert m is not None
        bash_cache.write_sidecar(m)

        # Plant an orphan sidecar with no matching body.
        orphan = bash_cache._bash_outputs_dir() / "anon-0000000000000-deadbeefcafebabe.json"
        orphan.write_text("{}", encoding="utf-8")
        assert orphan.exists()

        # Drive eviction with a tight cap so the body-loop runs and the
        # orphan sweep runs at the end regardless of total size.
        bash_cache.evict_old_entries(max_total_bytes=1)
        # The body in question (orphan's pair) never existed, so the sweep
        # must remove the sidecar.
        assert not orphan.exists()

    def test_evict_old_entries_respects_max_file_count(self, tmp_data_dir):
        """evict_old_entries honours the max_file_count parameter."""
        # Store 5 small outputs (each well under max_total_bytes).
        for i in range(5):
            bash_cache.store_output(
                f"sess_fc_{i}", f"echo {i}", "hello", "", 0,
                max_total_bytes=999_999_999,  # no byte-cap eviction
                max_file_count=999_999,       # no file-count eviction during store
            )
        # Now evict down to 2 files.
        evicted = bash_cache.evict_old_entries(max_total_bytes=999_999_999, max_file_count=2)
        assert evicted >= 3  # at least 3 entries removed to reach the 2-file target

    def test_evict_old_entries_default_max_file_count_is_constant(self):
        """DEFAULT_MAX_FILE_COUNT matches the evict_old_entries default."""
        import inspect
        sig = inspect.signature(bash_cache.evict_old_entries)
        default = sig.parameters["max_file_count"].default
        assert default == bash_cache.DEFAULT_MAX_FILE_COUNT

    def test_store_output_strips_ansi_from_stdout(self, tmp_data_dir):
        """store_output strips ANSI escape sequences from stdout before caching."""
        ansi_stdout = "\x1b[38;2;56;56;56m╭─────────────╮\x1b[m\n\x1b[1mbold text\x1b[0m\n"
        meta = bash_cache.store_output("sess-ansi-1", "lefthook run", ansi_stdout, "", 0)
        assert meta is not None
        body = bash_cache.load_output(meta.output_id)
        assert body is not None
        assert "\x1b" not in body, "cached body must not contain ANSI escape sequences"
        assert "╭─────────────╮" in body
        assert "bold text" in body

    def test_store_output_strips_ansi_from_stderr(self, tmp_data_dir):
        """store_output strips ANSI escape sequences from stderr before caching."""
        ansi_stderr = "\x1b[31mERROR:\x1b[0m something went wrong\n"
        meta = bash_cache.store_output("sess-ansi-2", "make build", "", ansi_stderr, 1)
        assert meta is not None
        body = bash_cache.load_output(meta.output_id)
        assert body is not None
        assert "\x1b" not in body, "cached stderr must not contain ANSI escape sequences"
        assert "ERROR:" in body
        assert "something went wrong" in body

    def test_store_output_ansi_strip_is_idempotent(self, tmp_data_dir):
        """Storing already-clean output is unaffected by the ANSI strip pass."""
        clean = "plain output line 1\nplain output line 2\n"
        meta = bash_cache.store_output("sess-ansi-3", "echo plain", clean, "", 0)
        assert meta is not None
        body = bash_cache.load_output(meta.output_id)
        assert body is not None
        assert "plain output line 1" in body
        assert "plain output line 2" in body

    def test_store_output_eviction_oserror_does_not_discard_write(self, tmp_data_dir, monkeypatch):
        """A confirmed write must return metadata even if eviction raises OSError.

        Regression: evict_old_entries previously ran inside safe_cache_op, so an OSError
        during the directory walk caused the context manager to suppress the exception and
        return None — discarding a successful write even though the file was on disk.
        """
        def _bad_evict(**kwargs):
            raise OSError("antivirus lock simulation")

        monkeypatch.setattr(bash_cache, "evict_old_entries", _bad_evict)

        meta = bash_cache.store_output("sess_evict_err", "ls -lh", "output here", "", 0)
        assert meta is not None, "store_output must succeed even when eviction raises OSError"
        body = bash_cache.load_output(meta.output_id)
        assert body is not None and "output here" in body

    def test_output_below_min_threshold_not_cached(self, tmp_data_dir):
        """Output smaller than min_cache_bytes is not cached."""
        # Small output (500 bytes) with min_cache_bytes=1024 should not be cached.
        meta = bash_cache.store_output(
            "sess-min-threshold", "echo hi", "X" * 500, "", 0,
            min_cache_bytes=1024,
        )
        assert meta is None, "Output below min_cache_bytes should not be cached"

    def test_output_above_max_threshold_not_cached(self, tmp_data_dir):
        """Output larger than max_cache_bytes is not cached."""
        # Large output (100 MB) with max_cache_bytes=50MB should not be cached.
        # Using a smaller size for test speed.
        large_output = "X" * (60 * 1024 * 1024)
        meta = bash_cache.store_output(
            "sess-max-threshold", "cat huge.log", large_output, "", 0,
            max_cache_bytes=50 * 1024 * 1024,
        )
        assert meta is None, "Output above max_cache_bytes should not be cached"

    def test_output_within_threshold_is_cached(self, tmp_data_dir):
        """Output between min and max thresholds IS cached normally."""
        # Output (2 KB) between min (1 KB) and max (50 MB) should be cached.
        meta = bash_cache.store_output(
            "sess-within-threshold", "ls -la", "X" * 2048, "", 0,
            min_cache_bytes=1024,
            max_cache_bytes=50 * 1024 * 1024,
        )
        assert meta is not None, "Output within thresholds should be cached"
        body = bash_cache.load_output(meta.output_id)
        assert body is not None and len(body) > 0

    def test_threshold_zero_min_caches_all(self, tmp_data_dir):
        """With min_cache_bytes=0, even tiny outputs are cached."""
        # With min threshold disabled (0), even 100 bytes should cache.
        meta = bash_cache.store_output(
            "sess-min-zero", "true", "X" * 100, "", 0,
            min_cache_bytes=0,
        )
        assert meta is not None, "With min=0, all outputs should cache"
        body = bash_cache.load_output(meta.output_id)
        assert body is not None


class TestPostBashHook:
    def test_small_output_skipped(self, tmp_data_dir):
        """Output below the cache threshold is not stored."""
        payload = {
            "session_id": "post-bash-1",
            "tool_name": "Bash",
            "tool_input": {"command": "true"},
            "tool_response": {"stdout": "ok\n", "stderr": "", "exit_code": 0},
        }
        result = hooks_read.post_bash(payload)
        _assert_continue(result)
        # No bash history entry was recorded because output was below threshold.
        cache = session.load("post-bash-1")
        assert not cache.bash_history

    def test_large_output_recorded_in_session(self, tmp_data_dir):
        """An output past the threshold lands on disk and in session history."""
        big = "X" * 5000
        payload = {
            "session_id": "post-bash-2",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest -v"},
            "tool_response": {"stdout": big, "stderr": "", "exit_code": 1},
        }
        result = hooks_read.post_bash(payload)
        _assert_continue(result)

        cache = session.load("post-bash-2")
        assert len(cache.bash_history) == 1
        entry = next(iter(cache.bash_history.values()))
        assert entry.stdout_bytes == 5000
        assert entry.exit_code == 1
        assert "pytest" in entry.cmd_preview
        body = bash_cache.load_output(entry.output_id)
        assert body is not None and body.startswith("X")

    def test_missing_session_id_skipped(self, tmp_data_dir):
        """No session_id → no record, but hook still returns CONTINUE."""
        payload = {
            "tool_name": "Bash",
            "tool_input": {"command": "echo " + "X" * 5000},
            "tool_response": {"stdout": "X" * 5000, "stderr": "", "exit_code": 0},
        }
        result = hooks_read.post_bash(payload)
        _assert_continue(result)

    def test_missing_tool_response_no_crash(self, tmp_data_dir):
        """A payload with no tool_response is silently a no-op."""
        payload = {
            "session_id": "post-bash-3",
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi"},
        }
        result = hooks_read.post_bash(payload)
        _assert_continue(result)


class TestSessionLookup:
    def test_mark_and_lookup(self, tmp_data_dir):
        """mark_bash_run stores an entry that lookup_bash_entry can retrieve."""
        sha = bash_cache.command_hash("git log -20")
        session.mark_bash_run(
            session_id="lookup-1",
            cmd_sha=sha,
            cmd_preview="git log -20",
            output_id="out-1",
            stdout_bytes=12345,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        entry = session.lookup_bash_entry("lookup-1", sha)
        assert entry is not None
        assert entry.output_id == "out-1"
        assert entry.stdout_bytes == 12345

    def test_lookup_missing_returns_none(self, tmp_data_dir):
        assert session.lookup_bash_entry("lookup-2", "deadbeef") is None


class TestNormalizeCommandForCacheKey:
    """Tests for normalize_command_for_cache_key function."""

    def test_strip_leading_trailing_whitespace(self):
        """Leading/trailing whitespace is stripped."""
        assert bash_cache.normalize_command_for_cache_key("  pytest tests  ") == "pytest tests"
        assert bash_cache.normalize_command_for_cache_key("\t\necho hello\n\t") == "echo hello"

    def test_normalize_internal_whitespace_runs(self):
        """Multiple internal spaces/tabs/newlines collapse to single space."""
        assert bash_cache.normalize_command_for_cache_key("pytest  tests") == "pytest tests"
        assert bash_cache.normalize_command_for_cache_key("pytest\t\ttests") == "pytest tests"
        assert bash_cache.normalize_command_for_cache_key("pytest\n\ntests") == "pytest tests"
        assert bash_cache.normalize_command_for_cache_key("pytest  \t  tests") == "pytest tests"

    def test_normalize_windows_path_separators(self):
        """Backslashes in paths are converted to forward slashes."""
        assert bash_cache.normalize_command_for_cache_key("cd C:\\foo") == "cd C:/foo"
        assert bash_cache.normalize_command_for_cache_key("rg pattern src\\lib") == "rg pattern src/lib"
        # Mixed slashes in a single path
        assert bash_cache.normalize_command_for_cache_key("cat C:\\foo/bar\\baz") == "cat C:/foo/bar/baz"

    def test_normalize_path_separators_in_flags(self):
        """Backslashes in flag values are also normalized."""
        assert bash_cache.normalize_command_for_cache_key("find . -path src\\tests") == "find . -path src/tests"

    def test_pytest_flag_sorting(self):
        """Single-char flags in pytest commands are sorted."""
        # Trailing / stripped by step 3.5 path normalization
        assert bash_cache.normalize_command_for_cache_key("pytest -x -q tests/") == "pytest -q -x tests"
        assert bash_cache.normalize_command_for_cache_key("pytest -q -x tests/") == "pytest -q -x tests"
        assert bash_cache.normalize_command_for_cache_key("pytest -v -q tests/") == "pytest -q -v tests"

    def test_pytest_with_uv_run(self):
        """pytest via uv run has flags sorted."""
        assert bash_cache.normalize_command_for_cache_key("uv run pytest -x -q tests/") == "uv run pytest -q -x tests"

    def test_rg_flag_sorting(self):
        """Single-char flags in rg commands are sorted, including contiguous runs after positional args."""
        # Flags before positional args are sorted
        assert bash_cache.normalize_command_for_cache_key("rg -o -i pattern") == "rg -i -o pattern"
        assert bash_cache.normalize_command_for_cache_key("rg -i -o pattern") == "rg -i -o pattern"
        # Leading flags get sorted
        assert bash_cache.normalize_command_for_cache_key("rg -x -y -z pattern") == "rg -x -y -z pattern"
        # Flags after positional args are also sorted so rg pattern -o -i == rg pattern -i -o
        assert bash_cache.normalize_command_for_cache_key("rg pattern -o -i") == "rg pattern -i -o"
        assert bash_cache.normalize_command_for_cache_key("rg pattern -i -o") == "rg pattern -i -o"

    def test_grep_flag_sorting(self):
        """Single-char flags in grep commands are sorted (only leading flags before positional args)."""
        # Flags before positional args are sorted
        assert bash_cache.normalize_command_for_cache_key("grep -r -n file") == "grep -n -r file"
        assert bash_cache.normalize_command_for_cache_key("grep -n -r file") == "grep -n -r file"

    def test_git_flag_sorting(self):
        """Single-char flags in git commands are sorted."""
        assert bash_cache.normalize_command_for_cache_key("git log -20 -n") == "git log -20 -n"
        # git flags don't always work with single-char sorting if they have args,
        # but basic flags should sort
        assert bash_cache.normalize_command_for_cache_key("git log -p -v") == "git log -p -v"

    def test_flags_only_before_first_positional(self):
        """Only leading single-char flags are sorted; flags after positional args are not."""
        # Trailing / on 'tests/' is stripped (step 3.5).  The -v after the path is not
        # a leading single-char flag so it stays in place, which is the key assertion.
        assert bash_cache.normalize_command_for_cache_key("pytest -q -x tests/ -v") == "pytest -q -x tests -v"

    def test_ignores_long_flags(self):
        """Long flags (--flag) are not sorted, only single-char flags."""
        # Trailing / on 'tests/' is stripped as part of path normalization (step 3.5),
        # but the key assertion is that --verbose is not re-sorted / moved.
        assert bash_cache.normalize_command_for_cache_key("pytest --verbose -q tests/") == "pytest --verbose -q tests"
        assert bash_cache.normalize_command_for_cache_key("rg -i --type py") == "rg -i --type py"

    def test_no_sorting_for_unknown_tools(self):
        """Tools not in the sort list do not get flag sorting."""
        # 'ls' is not in sort_flag_tools
        result = bash_cache.normalize_command_for_cache_key("ls -l -h")
        # Flags are not sorted for unknown tools
        assert result == "ls -l -h"

    def test_empty_command(self):
        """Empty or whitespace-only commands are handled gracefully."""
        assert bash_cache.normalize_command_for_cache_key("") == ""
        assert bash_cache.normalize_command_for_cache_key("   ") == ""

    def test_combined_normalizations(self):
        """Multiple normalizations applied together."""
        # Whitespace + path sep + flag sorting
        result = bash_cache.normalize_command_for_cache_key(
            "  uv run pytest  -x  -q  C:\\tests  "
        )
        assert result == "uv run pytest -q -x C:/tests"

    def test_real_world_example_1(self):
        """Real-world: pytest with multiple flags and path."""
        # When flags come before the positional arg, they get sorted
        cmd1 = "uv run pytest -q -x tests/"
        cmd2 = "uv run pytest  -x  -q  tests/"
        assert bash_cache.normalize_command_for_cache_key(cmd1) == bash_cache.normalize_command_for_cache_key(cmd2)

    def test_real_world_example_2(self):
        """Real-world: rg with flags and Windows path."""
        cmd1 = "rg -i -o pattern src\\lib"
        cmd2 = "rg -o -i pattern src/lib"
        # Both should normalize to the same key (flags before pattern are sorted)
        assert bash_cache.normalize_command_for_cache_key(cmd1) == bash_cache.normalize_command_for_cache_key(cmd2)

    def test_numeric_single_char_flags(self):
        """Single-char flags with numbers like -1 are also sorted."""
        assert bash_cache.normalize_command_for_cache_key("grep -1 -2 pattern") == "grep -1 -2 pattern"

    def test_preserves_command_semantics(self):
        """Normalization does not change command semantics."""
        # The normalization is idempotent
        cmd = "pytest -q -x tests/"
        normalized_once = bash_cache.normalize_command_for_cache_key(cmd)
        normalized_twice = bash_cache.normalize_command_for_cache_key(normalized_once)
        assert normalized_once == normalized_twice

    def test_dot_slash_prefix_stripped(self):
        """Leading ./ is removed from path tokens for dedup purposes."""
        assert bash_cache.normalize_command_for_cache_key("cat ./src/auth.py") == "cat src/auth.py"
        assert bash_cache.normalize_command_for_cache_key("python ./script.py") == "python script.py"
        assert bash_cache.normalize_command_for_cache_key("node ./index.js") == "node index.js"

    def test_dot_slash_dedup_produces_same_hash(self):
        """cat ./file.py and cat file.py must share the same cache key."""
        h1 = bash_cache.command_hash("cat ./src/auth.py")
        h2 = bash_cache.command_hash("cat src/auth.py")
        assert h1 == h2, "dot-slash and no-dot-slash paths should hash identically"

        h3 = bash_cache.command_hash("pytest ./tests/")
        h4 = bash_cache.command_hash("pytest tests")
        assert h3 == h4, "pytest ./tests/ and pytest tests should hash identically"

    def test_dot_dot_slash_not_stripped(self):
        """../parent.py must NOT be normalised — it refers to a different path."""
        assert bash_cache.normalize_command_for_cache_key("cat ../parent.py") == "cat ../parent.py"
        h1 = bash_cache.command_hash("cat ../parent.py")
        h2 = bash_cache.command_hash("cat parent.py")
        assert h1 != h2, "../ path must not be normalised to the same hash as the bare name"

    def test_trailing_slash_stripped(self):
        """Trailing / on directory tokens is stripped for dedup purposes."""
        assert bash_cache.normalize_command_for_cache_key("pytest tests/") == "pytest tests"
        assert bash_cache.normalize_command_for_cache_key("rg pattern src/") == "rg pattern src"

    def test_filesystem_root_not_stripped(self):
        """The filesystem root '/' must not be changed."""
        assert bash_cache.normalize_command_for_cache_key("ls /") == "ls /"
        assert bash_cache.normalize_command_for_cache_key("ls /etc") == "ls /etc"

    def test_flags_not_affected_by_path_normalisation(self):
        """Short flags (-q, --verbose) are never mutated by step 3.5."""
        assert bash_cache.normalize_command_for_cache_key("rg -i ./src/") == "rg -i src"
        # Flag value is not a positional path token — stays untouched
        assert bash_cache.normalize_command_for_cache_key("rg --include=./foo") == "rg --include=./foo"

    def test_shell_operators_not_affected(self):
        """Shell operators (&&, ||, |, >, ;) are left unchanged."""
        cmd = "cd ./project && pytest ./tests/"
        result = bash_cache.normalize_command_for_cache_key(cmd)
        # cd argument ./project -> project; && untouched; pytest ./tests/ -> pytest tests
        assert result == "cd project && pytest tests"

    def test_bare_dot_slash_becomes_dot(self):
        """A bare './' argument (current dir) normalises to '.' not an empty string."""
        assert bash_cache.normalize_command_for_cache_key("ls ./") == "ls ."
        assert bash_cache.normalize_command_for_cache_key("ls -la ./") == "ls -la ."

    def test_dot_slash_normalisation_is_idempotent(self):
        """Applying the normalisation twice produces the same result."""
        cmds = ["cat ./src/auth.py", "pytest ./tests/", "rg -i ./src/", "ls ./"]
        for cmd in cmds:
            n1 = bash_cache.normalize_command_for_cache_key(cmd)
            n2 = bash_cache.normalize_command_for_cache_key(n1)
            assert n1 == n2, f"Not idempotent: {cmd!r} -> {n1!r} -> {n2!r}"


class TestCommandHashCwdScoping:
    def test_same_command_different_cwd_different_hash(self):
        """Two projects running the same command must not share a cache key."""
        h1 = bash_cache.command_hash("pytest tests/", "/home/user/projectA")
        h2 = bash_cache.command_hash("pytest tests/", "/home/user/projectB")
        assert h1 != h2

    def test_same_command_no_cwd_is_stable(self):
        """Backwards-compat: omitting cwd produces the same hash as before."""
        h_none = bash_cache.command_hash("pytest tests/")
        h_none2 = bash_cache.command_hash("pytest tests/", None)
        assert h_none == h_none2

    def test_cwd_none_differs_from_empty_cwd(self):
        """cwd=None (no info) differs from cwd='' (empty string) for safety."""
        h_none = bash_cache.command_hash("pytest tests/", None)
        h_empty = bash_cache.command_hash("pytest tests/", "")
        assert h_none != h_empty

    def test_normalized_commands_produce_same_hash(self):
        """Semantically equivalent commands normalize to the same hash."""
        # Extra whitespace and flag ordering
        h1 = bash_cache.command_hash("pytest  -x  -q  tests/")
        h2 = bash_cache.command_hash("pytest -q -x tests/")
        assert h1 == h2

    def test_normalized_with_path_separators(self):
        """Windows path separators are normalized in the hash."""
        h1 = bash_cache.command_hash("cd C:\\foo && pytest tests/")
        h2 = bash_cache.command_hash("cd C:/foo && pytest tests/")
        assert h1 == h2

    def test_normalization_respects_cwd_scope(self):
        """Normalization still respects cwd scoping."""
        # Same normalized command, different cwd → different hash
        h1 = bash_cache.command_hash("pytest  -x  -q  tests/", "/home/projectA")
        h2 = bash_cache.command_hash("pytest -q -x tests/", "/home/projectB")
        assert h1 != h2

        # Same normalized command, same cwd → same hash
        h3 = bash_cache.command_hash("pytest  -x  -q  tests/", "/home/projectA")
        assert h3 == h1

    def test_find_cached_for_command_scoped_to_cwd(self, tmp_data_dir):
        """find_cached_for_command does not return entries from a different project."""
        cmd = "pytest tests/"
        cwd_a = "/home/user/projectA"
        cwd_b = "/home/user/projectB"

        meta_a = bash_cache.store_output("sess-cwd-a", cmd, "X" * 500, "", 0, cwd=cwd_a)
        assert meta_a is not None
        bash_cache.write_sidecar(meta_a)

        # Same session_id, different project — must not match.
        result = bash_cache.find_cached_for_command(cmd, cwd=cwd_b)
        assert result is None

        # Correct project — must match.
        result2 = bash_cache.find_cached_for_command(cmd, cwd=cwd_a)
        assert result2 is not None
        assert result2.cmd_sha == meta_a.cmd_sha

    def test_find_cached_for_command_tolerates_concurrent_deletion(self, tmp_data_dir):
        """find_cached_for_command returns a result even if some sidecars are concurrently deleted.

        Regression test for TOCTOU: sorted(..., key=lambda p: p.stat().st_mtime)
        would raise OSError if a sidecar was deleted between glob() and stat().
        The OSError would propagate to safe_cache_op and make the whole function
        return None, silently dropping a valid cache hit.
        """
        from pathlib import Path
        from unittest.mock import patch

        cmd = "pytest tests/"
        cwd = "/home/user/project"

        # Store two entries for the same command so there are multiple sidecars.
        meta1 = bash_cache.store_output("sess-del-a", cmd, "Z" * 500, "", 0, cwd=cwd)
        assert meta1 is not None
        bash_cache.write_sidecar(meta1)
        meta2 = bash_cache.store_output("sess-del-b", cmd, "Z" * 600, "", 0, cwd=cwd)
        assert meta2 is not None
        bash_cache.write_sidecar(meta2)

        original_stat = Path.stat

        def flaky_stat(self: Path, **kwargs: object) -> object:
            # Simulate one sidecar being deleted during the sort by raising
            # OSError on the first stat() call inside the sort key.
            if self.suffix == ".json" and "sess-del-a" in self.name:
                raise OSError("simulated concurrent deletion")
            return original_stat(self, **kwargs)

        with patch.object(Path, "stat", flaky_stat):
            result = bash_cache.find_cached_for_command(cmd, cwd=cwd)

        # The lookup must still succeed using the surviving sidecar.
        assert result is not None
        assert result.cmd_sha == bash_cache.command_hash(cmd, cwd)

    # Regression: command_hash keyed on the raw cwd string, so one directory addressed as C:\proj vs c:/proj vs /mnt/c/proj produced three distinct keys and three cache misses — a dominant source of redundant git/pytest recompute on Windows + WSL. These lock in that those representations now share one key, while genuinely different paths still don't.

    def test_cwd_drive_letter_case_shares_hash(self):
        """Same dir differing only in drive-letter case shares a cache key."""
        h_upper = bash_cache.command_hash("git status", "C:/Projects/token-goat")
        h_lower = bash_cache.command_hash("git status", "c:/Projects/token-goat")
        assert h_upper == h_lower

    def test_cwd_path_separator_shares_hash(self):
        """Same dir differing only in path separators shares a cache key."""
        h_back = bash_cache.command_hash("git status", "C:\\Projects\\token-goat")
        h_fwd = bash_cache.command_hash("git status", "c:/Projects/token-goat")
        assert h_back == h_fwd

    def test_cwd_wsl_form_shares_hash_with_windows_form(self):
        """WSL /mnt/c form and Windows c: form of one dir share a cache key."""
        h_wsl = bash_cache.command_hash("git status", "/mnt/c/Projects/token-goat")
        h_win = bash_cache.command_hash("git status", "C:\\Projects\\token-goat")
        assert h_wsl == h_win

    def test_cwd_posix_case_variance_stays_distinct(self):
        """Safety: on a case-sensitive FS, /srv/Foo and /srv/foo are different
        directories and must NOT collide. normalize_path folds only the drive
        letter, never the path body — this guards against a future over-eager
        lowercase that would serve one project's cached output for another."""
        h1 = bash_cache.command_hash("git status", "/srv/Foo")
        h2 = bash_cache.command_hash("git status", "/srv/foo")
        assert h1 != h2

    def test_find_cached_for_command_matches_across_cwd_representation(self, tmp_data_dir):
        """End-to-end: output stored under the Windows-form cwd is found when the
        lookup arrives with the forward-slash form of the same directory. This is
        the cross-session cache hit the cwd normalization actually unlocks."""
        cmd = "git status"
        meta = bash_cache.store_output(
            "sess-pathvar", cmd, "X" * 500, "", 0, cwd="C:\\Projects\\token-goat"
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.find_cached_for_command(cmd, cwd="c:/Projects/token-goat")
        assert result is not None
        assert result.cmd_sha == meta.cmd_sha


class TestGetRecentErrorOutputs:
    """Tests for get_recent_error_outputs function."""

    def test_empty_cache_returns_empty_list(self, tmp_data_dir):
        """When the cache is empty, get_recent_error_outputs returns an empty list."""
        result = bash_cache.get_recent_error_outputs("sess-empty")
        assert result == []

    def test_non_zero_exit_code_detected(self, tmp_data_dir):
        """A command with non-zero exit code is returned as an error."""
        meta = bash_cache.store_output("sess-error-1", "pytest tests/", "output\n", "", 1)
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-error-1", max_entries=5)
        assert len(result) == 1
        assert result[0]["command"] == "pytest tests/"
        assert "exit 1" in result[0]["error_summary"]

    def test_error_pattern_in_output_detected(self, tmp_data_dir):
        """Error patterns in output are detected and extracted."""
        output = "running tests...\nError: assertion failed on line 42\ndone\n"
        meta = bash_cache.store_output(
            "sess-error-2", "pytest tests/", output, "", 0  # exit 0 but has error pattern
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-error-2", max_entries=5)
        assert len(result) == 1
        assert "assertion failed on line 42" in result[0]["error_summary"]

    def test_traceback_pattern_detected(self, tmp_data_dir):
        """Traceback patterns are detected."""
        output = "Traceback (most recent call last):\n  File 'test.py', line 5\nerror\n"
        meta = bash_cache.store_output(
            "sess-error-3", "python test.py", output, "", 1
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-error-3", max_entries=5)
        assert len(result) == 1
        assert "Traceback" in result[0]["error_summary"]

    def test_failed_pattern_detected(self, tmp_data_dir):
        """FAILED pattern in pytest output is detected."""
        output = "test_foo.py::test_bar FAILED - AssertionError\n"
        meta = bash_cache.store_output(
            "sess-error-4", "pytest test_foo.py", output, "", 1
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-error-4", max_entries=5)
        assert len(result) == 1
        assert "FAILED" in result[0]["error_summary"] or "AssertionError" in result[0]["error_summary"]

    def test_lowercase_error_pattern_detected(self, tmp_data_dir):
        """Lowercase 'error:' pattern is detected (case-sensitive)."""
        output = "Processing complete with error: file not found\n"
        meta = bash_cache.store_output(
            "sess-error-5", "tool process", output, "", 0
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-error-5", max_entries=5)
        assert len(result) == 1
        assert "error:" in result[0]["error_summary"]

    def test_max_entries_limit(self, tmp_data_dir):
        """Only up to max_entries errors are returned."""
        for i in range(5):
            meta = bash_cache.store_output(
                "sess-error-limit", f"cmd{i}", f"Error: code {i}\n", "", i % 2 + 1
            )
            assert meta is not None
            bash_cache.write_sidecar(meta)

        # Request only 2, should get 2
        result = bash_cache.get_recent_error_outputs("sess-error-limit", max_entries=2)
        assert len(result) <= 2

    def test_successful_commands_ignored(self, tmp_data_dir):
        """Commands with exit_code 0 and no error patterns are ignored."""
        meta = bash_cache.store_output(
            "sess-success", "ls -la /tmp", "file1\nfile2\n", "", 0
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)

        result = bash_cache.get_recent_error_outputs("sess-success", max_entries=5)
        assert result == []


    def test_wrong_session_id_ignored(self, tmp_data_dir):
        """Errors from a different session are not returned."""
        meta = bash_cache.store_output("sess-error-a", "pytest", "Error: failed\n", "", 1)
        assert meta is not None
        bash_cache.write_sidecar(meta)

        # Query with different session_id
        result = bash_cache.get_recent_error_outputs("sess-error-b", max_entries=5)
        assert result == []

    def test_fail_soft_on_missing_cache_dir(self, tmp_data_dir, monkeypatch):
        """Missing cache dir is handled gracefully (fail-soft)."""
        def bad_dir():
            raise OSError("no permission")
        monkeypatch.setattr(bash_cache, "_bash_outputs_dir", bad_dir)
        result = bash_cache.get_recent_error_outputs("sess-error-fail", max_entries=5)
        assert result == []  # Fail-soft returns empty list


# ---------------------------------------------------------------------------
# Regression: P2-7 — eviction throttle prevents O(n) scan on every store_output
# ---------------------------------------------------------------------------

class TestEvictionThrottleRegression:
    """store_output must only call evict_old_entries once per _EVICTION_THROTTLE_SECONDS window.

    Regression P2-7: before the fix, every successful store_output call triggered a full
    iterdir+lstat scan of the cache directory (up to 4096 files × 2 for body+sidecar).
    With the throttle, consecutive store_output calls within the window skip eviction.
    """

    def test_eviction_not_called_twice_within_throttle_window(self, tmp_data_dir, monkeypatch):
        """Two rapid store_output calls trigger evict_old_entries only once."""
        call_count = 0

        def _counting_evict(**kwargs):
            nonlocal call_count
            call_count += 1

        monkeypatch.setattr(bash_cache, "evict_old_entries", _counting_evict)
        # Reset the module-level timestamp so the first call always fires eviction
        monkeypatch.setattr(bash_cache, "_last_eviction_ts", 0.0)

        bash_cache.store_output("thr-sess-1", "pytest", "pass\n", "", 0)
        bash_cache.store_output("thr-sess-1", "pytest", "pass2\n", "", 0)

        assert call_count == 1, f"evict_old_entries called {call_count} times; expected 1"

    def test_eviction_called_once_per_window(self, tmp_data_dir, monkeypatch):
        """After the throttle window expires, the next store_output fires eviction again."""
        call_count = 0

        def _counting_evict(**kwargs):
            nonlocal call_count
            call_count += 1

        monkeypatch.setattr(bash_cache, "evict_old_entries", _counting_evict)
        monkeypatch.setattr(bash_cache, "_last_eviction_ts", 0.0)

        # First call — fires eviction
        bash_cache.store_output("thr-sess-2", "pytest", "pass\n", "", 0)
        assert call_count == 1

        # Expire the window by backdating the timestamp
        monkeypatch.setattr(bash_cache, "_last_eviction_ts", 0.0)

        # Second call after window expires — fires eviction again
        bash_cache.store_output("thr-sess-2", "pytest", "pass2\n", "", 0)
        assert call_count == 2

    def test_eviction_skipped_within_window(self, tmp_data_dir, monkeypatch):
        """store_output skips eviction when called within the throttle window."""
        import time
        call_count = 0

        def _counting_evict(**kwargs):
            nonlocal call_count
            call_count += 1

        monkeypatch.setattr(bash_cache, "evict_old_entries", _counting_evict)
        # Set last eviction to "just now" so the next call is within the window
        monkeypatch.setattr(bash_cache, "_last_eviction_ts", time.monotonic())

        bash_cache.store_output("thr-sess-3", "ls", "file.py\n", "", 0)

        assert call_count == 0, "evict_old_entries must not be called within the throttle window"
