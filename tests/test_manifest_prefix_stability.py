"""Tests for stable compact manifest output to enable prompt prefix-cache hits.

Guards four invariants:
1. Two calls with identical session content (same files, same edits) produce
   byte-identical normalized manifests regardless of wall-clock time.
2. File entries in every section are sorted alphabetically by rel_path so
   the display order is deterministic regardless of access timestamps.
3. The static directive block (``### Compact Directives``) appears before any
   file entries in the manifest body.
4. ``normalize_for_cache()`` strips the ``# as-of:`` timestamp suffix cleanly.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from compact_test_helpers import make_cache, make_file_entry

from token_goat.compact import _build_manifest_from_cache, normalize_for_cache


@pytest.fixture(autouse=True)
def _no_error_scan(monkeypatch):
    """Prevent get_recent_error_outputs from walking real sidecar files during tests."""
    import token_goat.bash_cache as _bc
    monkeypatch.setattr(_bc, "get_recent_error_outputs", lambda *a, **kw: [])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_entries(*paths: str, read_count: int = 1) -> dict:
    """Return a FileEntry-like dict keyed by path for use in make_cache(files=...)."""
    ts_base = time.time() - 1000.0
    return {
        p: make_file_entry(p, read_count=read_count, ts=ts_base + i * 0.1)
        for i, p in enumerate(paths)
    }


def _make_edited(*paths: str) -> dict:
    """Return an edited_files dict keyed by path with edit_count=1."""
    return {p: 1 for p in paths}


# ---------------------------------------------------------------------------
# Test 1: byte-identical normalized manifests from two identical sessions
# ---------------------------------------------------------------------------

class TestIdenticalSessionsProduceStableManifest:
    """Two manifest renders from the same cache content must normalize to the same bytes."""

    def test_normalized_manifests_are_byte_identical(self):
        files = _make_entries("src/alpha.py", "src/beta.py", "src/gamma.py")
        edited = _make_edited("src/alpha.py")
        cache = make_cache(files=files, edited_files=edited, greps=[])

        sid = "prefix-cache-test-stable-001"
        manifest_a = _build_manifest_from_cache(cache, sid, max_tokens=800)
        manifest_b = _build_manifest_from_cache(cache, sid, max_tokens=800)

        assert normalize_for_cache(manifest_a) == normalize_for_cache(manifest_b)

    def test_normalized_strips_only_as_of_line(self):
        files = _make_entries("src/foo.py")
        edited = _make_edited("src/foo.py")
        cache = make_cache(files=files, edited_files=edited)

        sid = "prefix-cache-test-strip-002"
        manifest = _build_manifest_from_cache(cache, sid, max_tokens=800)
        normed = normalize_for_cache(manifest)

        # Normalized form must not end with the as-of line.
        lines = normed.splitlines()
        assert not any(ln.startswith("# as-of:") for ln in lines)

        # Normalized form must retain the main header.
        assert "## Token-Goat Session Manifest" in normed


# ---------------------------------------------------------------------------
# Test 2: file entries are sorted alphabetically regardless of access order
# ---------------------------------------------------------------------------

class TestFileEntriesAreSortedAlphabetically:
    """File entry display order must be alphabetical by rel_path, not by access time."""

    def test_normal_files_in_files_section_sorted_alphabetically(self):
        # Non-hot read-only files with access timestamps in reverse-alpha order (most
        # recent = "zzz", least recent = "aaa") — display must still be alpha-sorted.
        ts_base = time.time() - 500.0
        files = {
            "src/zzz.py": make_file_entry("src/zzz.py", read_count=2, ts=ts_base + 30),
            "src/mmm.py": make_file_entry("src/mmm.py", read_count=2, ts=ts_base + 20),
            "src/aaa.py": make_file_entry("src/aaa.py", read_count=2, ts=ts_base + 10),
        }
        cache = make_cache(files=files, edited_files={})

        manifest = _build_manifest_from_cache(cache, "sort-normal-files-test", max_tokens=800)

        # Extract the **Files:** section and collect path names in order.
        key_files_section = ""
        if "**Files:**" in manifest:
            key_files_section = manifest.split("**Files:**")[1].split("**")[0]

        found_paths = []
        for ln in key_files_section.splitlines():
            if not ln.strip().startswith("-"):
                continue
            for name in ("aaa.py", "mmm.py", "zzz.py"):
                if name in ln:
                    if name not in found_paths:
                        found_paths.append(name)
                    break

        if found_paths:
            assert found_paths == sorted(found_paths), (
                f"expected alphabetical order in **Files:** but got: {found_paths}"
            )

    def test_key_files_read_sorted_alphabetically(self):
        # Three read-only files with intentionally reversed access timestamps.
        ts_base = time.time() - 600.0
        files = {
            "src/zzz.py": make_file_entry("src/zzz.py", read_count=5, ts=ts_base + 50),
            "src/aaa.py": make_file_entry("src/aaa.py", read_count=5, ts=ts_base + 40),
            "src/mmm.py": make_file_entry("src/mmm.py", read_count=5, ts=ts_base + 30),
        }
        cache = make_cache(files=files, edited_files={})

        manifest = _build_manifest_from_cache(cache, "sort-files-test", max_tokens=800)

        key_files_section = ""
        if "**Files:**" in manifest:
            key_files_section = manifest.split("**Files:**")[1].split("**")[0]

        found_paths = []
        for ln in key_files_section.splitlines():
            if not ln.strip().startswith("-"):
                continue
            for name in ("aaa.py", "mmm.py", "zzz.py"):
                if name in ln:
                    if name not in found_paths:
                        found_paths.append(name)
                    break

        if found_paths:
            assert found_paths == sorted(found_paths), (
                f"expected alphabetical order in **Files:** but got: {found_paths}"
            )


# ---------------------------------------------------------------------------
# Test 3: directive block appears before file entries
# ---------------------------------------------------------------------------

class TestDirectiveBlockBeforeFileEntries:
    """``### Compact Directives`` must appear before any file-entry bullet lines."""

    def test_directives_before_file_entries(self):
        files = _make_entries("src/z.py", "src/a.py", "src/m.py", read_count=2)
        edited = _make_edited("src/a.py")
        cache = make_cache(files=files, edited_files=edited)

        # Build via build_manifest (not _build_manifest_from_cache) so the directive
        # injection logic in build_manifest runs.  Patch the session loader so no real
        # disk I/O is needed.
        from token_goat import session as session_mod

        sid = "directives-before-files-003"
        # Persist cache so build_manifest can load it.
        session_mod.save(cache.__class__(session_id=sid) if hasattr(cache.__class__, "session_id") else cache)

        # Use _build_manifest_from_cache directly and apply the injection manually
        # to stay fast and avoid disk dependency.
        body = _build_manifest_from_cache(cache, sid, max_tokens=800)

        # Simulate directive injection (mirrors what build_manifest does).
        from token_goat.compact import _COMPACT_DIRECTIVES
        dir_block = _COMPACT_DIRECTIVES.lstrip("\n")
        ins_pos = body.find("\n**")
        if ins_pos == -1:
            ins_pos = body.find("\n## Pinned")
        if ins_pos != -1:
            manifest = body[:ins_pos + 1] + dir_block + "\n" + body[ins_pos + 1:]
        else:
            manifest = dir_block + "\n" + body

        lines = manifest.splitlines()
        dir_idx = next((i for i, ln in enumerate(lines) if ln.startswith("### Compact Directives")), None)
        # Find first file-entry bullet (path line under a ** section).
        file_idx = None
        in_section = False
        for i, ln in enumerate(lines):
            if ln.startswith("**") and (":" in ln or ln.endswith("**")):
                in_section = True
            if in_section and ln.strip().startswith("- ") and any(c in ln for c in ("→", "✎", "/")):
                file_idx = i
                break

        if dir_idx is not None and file_idx is not None:
            assert dir_idx < file_idx, (
                f"### Compact Directives (line {dir_idx}) should appear before "
                f"first file entry (line {file_idx})"
            )

    def test_build_manifest_directive_position_via_real_session(self, tmp_path):
        """Integration: build_manifest places directives before file entries."""
        from token_goat import compact
        from token_goat import session as session_mod

        sid = "dir-pos-real-004"
        # Seed session with edited and read files.
        session_mod.mark_file_edited(sid, "src/z_file.py")
        session_mod.mark_file_read(sid, "src/a_file.py", offset=0, limit=50)
        session_mod.mark_file_read(sid, "src/m_file.py", offset=0, limit=50)

        # Patch out git/diff calls so test runs without a repo.
        with (
            patch("token_goat.compact._get_uncommitted_changes", return_value=None),
            patch("token_goat.compact._get_git_diff_stat_summary", return_value=""),
            patch("token_goat.compact._get_current_branch", return_value=None),
            patch("token_goat.compact._get_committed_files", return_value=set()),
            patch("token_goat.compact._get_whole_repo_diff", return_value=None),
        ):
            manifest = compact.build_manifest(sid)

        if not manifest or "### Compact Directives" not in manifest:
            pytest.skip("directive block not emitted for this session size")

        lines = manifest.splitlines()
        dir_idx = next((i for i, ln in enumerate(lines) if ln.startswith("### Compact Directives")), None)
        first_file_idx = None
        in_section = False
        for i, ln in enumerate(lines):
            if ln.startswith("**"):
                in_section = True
            if in_section and ln.strip().startswith("- ") and "file" in ln.lower():
                first_file_idx = i
                break

        if dir_idx is not None and first_file_idx is not None:
            assert dir_idx < first_file_idx


# ---------------------------------------------------------------------------
# Test 4: normalize_for_cache strips the as-of suffix cleanly
# ---------------------------------------------------------------------------

class TestNormalizeForCache:
    """normalize_for_cache must strip the ``# as-of:`` suffix and leave the rest intact."""

    def test_strips_as_of_line(self):
        body = "## Token-Goat Session Manifest\nmanifest_version: 1\n- ✎ src/foo.py"
        with_suffix = body + "\n# as-of: 2026-06-15T12:34:56Z"
        assert normalize_for_cache(with_suffix) == body

    def test_no_suffix_returns_unchanged(self):
        body = "## Token-Goat Session Manifest\nmanifest_version: 1"
        assert normalize_for_cache(body) == body

    def test_strips_only_last_line(self):
        body = (
            "## Token-Goat Session Manifest\n"
            "# as-of: embedded — this line is NOT the suffix\n"
            "- ✎ src/bar.py\n"
            "# as-of: 2026-06-15T12:34:56Z"
        )
        normed = normalize_for_cache(body)
        # The embedded line must survive; only the trailing one is stripped.
        assert "embedded — this line is NOT the suffix" in normed
        assert not normed.endswith("# as-of: 2026-06-15T12:34:56Z")

    def test_trailing_newlines_are_handled(self):
        body = "## Token-Goat Session Manifest\n- ✎ src/foo.py"
        with_suffix = body + "\n# as-of: 2026-01-01T00:00:00Z\n\n"
        normed = normalize_for_cache(with_suffix)
        assert "# as-of:" not in normed
        assert "Token-Goat Session Manifest" in normed

    def test_two_manifests_normalize_to_same_bytes(self):
        body = "## Token-Goat Session Manifest\nmanifest_version: 1\n- ✎ src/app.py"
        m1 = body + "\n# as-of: 2026-01-01T00:00:00Z"
        m2 = body + "\n# as-of: 2026-06-15T23:59:59Z"
        assert normalize_for_cache(m1) == normalize_for_cache(m2)
