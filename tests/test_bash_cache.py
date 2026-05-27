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
