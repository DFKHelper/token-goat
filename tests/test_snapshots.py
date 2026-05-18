"""Tests for the per-session file-content snapshot store + diff-aware re-read."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hints, hooks_read, session, snapshots


class TestSnapshotStore:
    def test_store_and_load_round_trip(self, tmp_data_dir):
        result = snapshots.store("sess1", "/tmp/foo.py", b"hello\nworld\n")
        assert result is not None
        loaded = snapshots.load("sess1", "/tmp/foo.py")
        assert loaded == b"hello\nworld\n"

    def test_oversized_file_not_stored(self, tmp_data_dir):
        big = b"X" * (snapshots.MAX_SNAPSHOT_BYTES + 1)
        result = snapshots.store("sess2", "/tmp/big.py", big)
        assert result is None
        assert snapshots.load("sess2", "/tmp/big.py") is None

    def test_path_with_traversal_chars_normalised(self, tmp_data_dir):
        """Snapshot store accepts any path string but the on-disk name is a hash."""
        result = snapshots.store("sess3", "../../etc/passwd", b"x")
        assert result is not None
        assert result.path.parent.name.startswith("sess3")

    def test_cleanup_session_removes_files(self, tmp_data_dir):
        snapshots.store("sess4", "/tmp/a.py", b"a")
        snapshots.store("sess4", "/tmp/b.py", b"b")
        removed = snapshots.cleanup_session("sess4")
        assert removed == 2
        assert snapshots.load("sess4", "/tmp/a.py") is None

    def test_eviction_keeps_per_session_under_cap(self, tmp_data_dir, monkeypatch):
        """When more than MAX_SNAPSHOTS_PER_SESSION are stored, oldest go first."""
        monkeypatch.setattr(snapshots, "MAX_SNAPSHOTS_PER_SESSION", 3)
        for i in range(5):
            snapshots.store("sess5", f"/tmp/f{i}.py", f"v{i}".encode())
        # The first two snapshots should have been evicted by the time we've
        # stored five with a cap of three.
        assert snapshots.load("sess5", "/tmp/f0.py") is None
        assert snapshots.load("sess5", "/tmp/f4.py") == b"v4"


class TestDiffHint:
    def test_no_snapshot_means_no_hint(self, tmp_data_dir):
        hint = hints.build_diff_hint(
            session_id="diff1",
            file_path="/tmp/missing.py",
            current_text="def foo():\n    pass\n",
        )
        assert hint is None

    def test_identical_snapshot_means_no_hint(self, tmp_data_dir):
        content = "def foo():\n    return 1\n" * 20
        snapshots.store("diff2", "/tmp/same.py", content.encode())
        hint = hints.build_diff_hint(
            session_id="diff2", file_path="/tmp/same.py", current_text=content,
        )
        assert hint is None

    def test_meaningful_diff_emits_hint(self, tmp_data_dir):
        """A small diff against a large file produces a positive-saving hint.

        The file is ~6 KB so a re-read costs ~1500 tokens; a one-line change
        produces a tiny diff so the saving easily clears the minimum threshold.
        Unique per-line content keeps difflib's autojunk heuristic from
        treating the surrounding context as noise.
        """
        body = "".join(f"# filler line {i}\n" for i in range(500))
        old = "x = 1\n" + body
        new = "x = 2\n" + body
        snapshots.store("diff3", "/tmp/changed.py", old.encode())
        hint = hints.build_diff_hint(
            session_id="diff3", file_path="/tmp/changed.py", current_text=new,
        )
        assert hint is not None
        assert hint.tokens_saved > 0
        assert "```diff" in str(hint)

    def test_huge_diff_suppressed(self, tmp_data_dir):
        """When the diff would exceed the size cap, no hint is emitted."""
        old = "old\n" * 5000
        new = "new\n" * 5000
        snapshots.store("diff4", "/tmp/huge.py", old.encode())
        hint = hints.build_diff_hint(
            session_id="diff4", file_path="/tmp/huge.py", current_text=new,
        )
        assert hint is None


class TestPostReadSnapshots:
    def test_post_read_captures_snapshot(self, tmp_data_dir, tmp_path):
        """post_read writes a snapshot of the read file's bytes."""
        src = tmp_path / "small.py"
        src.write_text("def x(): pass\n", encoding="utf-8")
        payload = {
            "session_id": "post-read-snap-1",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }
        _assert_continue(hooks_read.post_read(payload))
        assert snapshots.load("post-read-snap-1", str(src)) == b"def x(): pass\n"
        # Session also records the snapshot SHA so a future hook can short-circuit.
        sha = session.get_snapshot_sha("post-read-snap-1", str(src))
        assert sha and len(sha) == 64

    def test_post_read_oversized_skips_snapshot(self, tmp_data_dir, tmp_path):
        """A file larger than the snapshot cap is not snapshotted."""
        src = tmp_path / "big.py"
        src.write_bytes(b"X" * (snapshots.MAX_SNAPSHOT_BYTES + 1))
        payload = {
            "session_id": "post-read-snap-2",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }
        _assert_continue(hooks_read.post_read(payload))
        assert snapshots.load("post-read-snap-2", str(src)) is None
