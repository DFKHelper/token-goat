"""Tests for cross-session manifest deduplication (compact.py)."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

from token_goat.compact import (
    merge_session_manifests,
    read_all_session_manifests,
    write_session_manifest,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _manifest(session_id: str, files: list[dict]) -> dict:
    return {"session_id": session_id, "files": files, "updated_at": time.time()}


def _entry(rel_path: str, hit_count: int, last_read_ts: float = 0.0) -> dict:
    return {"rel_path": rel_path, "hit_count": hit_count, "last_read_ts": last_read_ts}


# ---------------------------------------------------------------------------
# write_session_manifest / read_all_session_manifests
# ---------------------------------------------------------------------------

def test_write_then_read_round_trip(tmp_path: Path) -> None:
    """Write a manifest and read it back unchanged."""
    with patch("token_goat.paths.data_dir", return_value=tmp_path):
        write_session_manifest("abc123", "sess-A", _manifest("sess-A", [_entry("foo.py", 3)]))
        results = read_all_session_manifests("abc123")
    assert len(results) == 1
    assert results[0]["session_id"] == "sess-A"
    assert results[0]["files"][0]["rel_path"] == "foo.py"


def test_stale_session_excluded(tmp_path: Path) -> None:
    """Session files older than max_age_seconds are skipped."""
    with patch("token_goat.paths.data_dir", return_value=tmp_path):
        write_session_manifest("proj", "old-sess", _manifest("old-sess", [_entry("bar.py", 1)]))
        sessions_dir = tmp_path / "projects" / "proj" / "sessions"
        stale_file = sessions_dir / "old-sess.json"
        # Back-date the file by 2 hours
        old_mtime = time.time() - 7201
        import os
        os.utime(stale_file, (old_mtime, old_mtime))
        results = read_all_session_manifests("proj", max_age_seconds=3600)
    assert results == []


def test_corrupt_json_silently_skipped(tmp_path: Path) -> None:
    """A corrupt JSON file is silently ignored; valid files still returned."""
    with patch("token_goat.paths.data_dir", return_value=tmp_path):
        write_session_manifest("proj", "good-sess", _manifest("good-sess", [_entry("ok.py", 2)]))
        sessions_dir = tmp_path / "projects" / "proj" / "sessions"
        (sessions_dir / "bad-sess.json").write_text("NOT JSON {{{{", encoding="utf-8")
        results = read_all_session_manifests("proj")
    assert len(results) == 1
    assert results[0]["session_id"] == "good-sess"


def test_empty_sessions_dir_returns_empty(tmp_path: Path) -> None:
    """read_all_session_manifests returns [] when the directory does not exist."""
    with patch("token_goat.paths.data_dir", return_value=tmp_path):
        results = read_all_session_manifests("nonexistent-hash")
    assert results == []


# ---------------------------------------------------------------------------
# merge_session_manifests
# ---------------------------------------------------------------------------

def test_no_duplicate_paths_in_merged_result() -> None:
    """Two sessions with overlapping file coverage produce no duplicate rel_paths."""
    sess_a = _manifest("A", [_entry("src/main.py", 5), _entry("src/util.py", 2)])
    sess_b = _manifest("B", [_entry("src/main.py", 3), _entry("src/other.py", 1)])
    merged = merge_session_manifests([sess_a, sess_b], budget_tokens=1000)
    paths = [e["rel_path"] for e in merged]
    assert len(paths) == len(set(paths)), "duplicate rel_paths in merged result"
    assert set(paths) == {"src/main.py", "src/util.py", "src/other.py"}


def test_higher_hit_count_wins_on_collision() -> None:
    """When both sessions list the same file, the higher hit_count entry is kept."""
    sess_a = _manifest("A", [_entry("lib/core.py", 10)])
    sess_b = _manifest("B", [_entry("lib/core.py", 3)])
    merged = merge_session_manifests([sess_a, sess_b], budget_tokens=1000)
    assert len(merged) == 1
    assert merged[0]["hit_count"] == 10


def test_budget_cap_limits_entries() -> None:
    """Total merged entries are capped when they would exceed budget_tokens."""
    # Each path is 20 chars → ceil(20/10) = 2 tokens each; budget = 5 → max 2 entries
    files = [_entry(f"src/module_{i:02d}.py", i + 1) for i in range(10)]
    sess = _manifest("S", files)
    merged = merge_session_manifests([sess], budget_tokens=5)
    assert len(merged) <= 5


def test_single_session_identity() -> None:
    """With a single session, merge returns exactly that session's file list (deduped)."""
    files = [_entry("a.py", 4), _entry("b.py", 2), _entry("c.py", 7)]
    sess = _manifest("only", files)
    merged = merge_session_manifests([sess], budget_tokens=10000)
    paths_out = {e["rel_path"] for e in merged}
    assert paths_out == {"a.py", "b.py", "c.py"}


def test_entries_sorted_by_hit_count_descending() -> None:
    """Merged entries are ordered highest hit_count first."""
    files = [_entry("low.py", 1), _entry("high.py", 9), _entry("mid.py", 4)]
    merged = merge_session_manifests([_manifest("S", files)], budget_tokens=10000)
    counts = [e["hit_count"] for e in merged]
    assert counts == sorted(counts, reverse=True)


def test_empty_manifests_returns_empty() -> None:
    """merge_session_manifests handles an empty input list gracefully."""
    assert merge_session_manifests([], budget_tokens=500) == []


def test_entries_with_missing_rel_path_skipped() -> None:
    """File entries without a rel_path key are silently ignored."""
    bad_entry = {"hit_count": 5}
    good_entry = _entry("real.py", 3)
    merged = merge_session_manifests([_manifest("S", [bad_entry, good_entry])], budget_tokens=1000)
    assert len(merged) == 1
    assert merged[0]["rel_path"] == "real.py"
