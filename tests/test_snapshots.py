"""Tests for the per-session file-content snapshot store + diff-aware re-read."""
from __future__ import annotations

import hashlib
from pathlib import Path

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import post_edit_sync as _post_edit_sync

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
        """When more than MAX_SNAPSHOTS_PER_SESSION are stored, oldest go first.

        We set explicit mtimes via ``os.utime`` after each store because on
        Windows the system clock and the NTFS mtime cache can yield identical
        timestamps for files written within ~10 ms of each other, which makes
        a naive "oldest first" assertion flaky.  Forcing a known mtime
        sequence gives the eviction loop a deterministic ordering.
        """
        import os as _os
        import time as _time

        monkeypatch.setattr(snapshots, "MAX_SNAPSHOTS_PER_SESSION", 3)
        base_ts = _time.time() - 100  # well in the past, ascending order
        stored: list = []
        for i in range(5):
            result = snapshots.store("sess5", f"/tmp/f{i}.py", f"v{i}".encode())
            assert result is not None
            # Stamp each snapshot with a distinct, strictly-ascending mtime so
            # the in-store eviction triggered by the *next* store has an
            # unambiguous oldest candidate.  We stamp *before* the next call
            # so that call's _evict_oldest sees the right age ordering.
            _os.utime(result.path, (base_ts + i, base_ts + i))
            stored.append(result.path)
        # After 5 stores with cap=3 (eviction trigger at MAX-1=2 before each
        # write), exactly two of the oldest entries are evicted.  f4 must
        # always survive (it was the most recent insertion); the other two
        # survivors are the two most-recently-inserted before f4.
        assert snapshots.load("sess5", "/tmp/f0.py") is None
        assert snapshots.load("sess5", "/tmp/f1.py") is None
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

        A single-line change now emits a compact summary (e.g. "-1 line @ L1")
        rather than a full unified diff block — either format is acceptable as
        long as the hint is non-None, saves tokens, and mentions the file.
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
        # Either the compact summary form or a full diff block is acceptable.
        hint_str = str(hint)
        assert "changed.py" in hint_str or "```diff" in hint_str

    def test_huge_diff_suppressed(self, tmp_data_dir):
        """When the diff would exceed the size cap, no hint is emitted."""
        old = "old\n" * 5000
        new = "new\n" * 5000
        snapshots.store("diff4", "/tmp/huge.py", old.encode())
        hint = hints.build_diff_hint(
            session_id="diff4", file_path="/tmp/huge.py", current_text=new,
        )
        assert hint is None

    def test_diff_hint_suppressed_on_snapshot_integrity_mismatch(
        self, tmp_data_dir,
    ):
        """A snapshot whose on-disk bytes drift from the recorded SHA is
        treated as untrusted and the diff hint is suppressed.

        Models the edge case where a snapshot file is overwritten out-of-band
        (partial-write recovery, manual tampering, or an evict-and-rewrite
        race that lands a different file under the same hashed key) between
        the post-read SHA persistence and the next pre-read diff attempt.
        Without the integrity check the diff would be computed against the
        wrong bytes and emitted as if the bytes were authoritative.

        The tampered snapshot bytes are chosen so the resulting diff against
        ``current_text`` is *small* — well under :data:`hints.DIFF_HINT_MAX_BYTES`
        — to ensure suppression is driven by the integrity gate rather than
        the size cap.  Any larger tampering would short-circuit on the diff
        size check and never exercise the freshness path.

        This test is a regression guard for the snapshot-freshness audit:
        with the integrity check in place the hint is None; without it the
        hint fires against tampered content.
        """
        body = "".join(f"# unique line {i}\n" for i in range(500))
        old = "x = 1\n" + body
        new = "x = 2\n" + body

        sid = "diff-integrity-1"
        fp = "/tmp/tampered.py"
        store_result = snapshots.store(sid, fp, old.encode())
        assert store_result is not None
        session.set_snapshot_sha(sid, fp, store_result.content_sha)

        # Sanity baseline: with an untouched snapshot, a meaningful diff
        # would normally fire.  Anchors the rest of the test.
        baseline = hints.build_diff_hint(
            session_id=sid, file_path=fp, current_text=new,
        )
        assert baseline is not None

        # Tamper with the snapshot bytes on disk.  Use *near-identical* bytes
        # (only the second line differs) so the resulting diff is tiny and
        # cannot be suppressed by the size cap — only the SHA gate stops it.
        # Without the gate, this would emit a "x = 2 -> x = 3" diff hint that
        # bears no relation to what the agent actually saw at the prior Read.
        tampered = "x = 3\n" + body
        snap_path = snapshots.snapshot_path(sid, fp)
        assert snap_path is not None
        snap_path.write_bytes(tampered.encode())

        # The freshness gate must suppress the hint.  Otherwise a misleading
        # diff against tampered bytes is presented to the agent.
        hint = hints.build_diff_hint(
            session_id=sid, file_path=fp, current_text=new,
        )
        assert hint is None, (
            "diff hint must not fire when the snapshot bytes no longer match "
            "the recorded SHA — the diff would mislead the agent"
        )

    def test_diff_hint_still_fires_when_sha_unrecorded(self, tmp_data_dir):
        """Legacy snapshots (no recorded SHA) keep the unverified-load path.

        When the session cache has no ``snapshot_sha`` entry for the file —
        e.g. a snapshot written before ``set_snapshot_sha`` was wired, or a
        predictive snapshot whose sha persist failed — the integrity check
        is skipped and the diff hint still fires.  Without this fallback the
        new gate would silently disable diff hints for every legacy snapshot.
        """
        body = "".join(f"# unique line {i}\n" for i in range(500))
        old = "x = 1\n" + body
        new = "x = 2\n" + body
        sid = "diff-legacy-1"
        fp = "/tmp/legacy.py"
        store_result = snapshots.store(sid, fp, old.encode())
        assert store_result is not None
        # Note: we deliberately do NOT call set_snapshot_sha here.

        # Without a recorded sha the integrity check is skipped and the diff
        # hint behaves identically to its pre-integrity behaviour.
        hint = hints.build_diff_hint(
            session_id=sid, file_path=fp, current_text=new,
        )
        assert hint is not None
        assert hint.tokens_saved > 0


class TestSnapshotLoadIntegrity:
    def test_load_returns_bytes_when_expected_sha_matches(self, tmp_data_dir):
        """``snapshots.load`` returns bytes when the expected sha matches."""
        content = b"def foo(): pass\n"
        result = snapshots.store("integ1", "/tmp/match.py", content)
        assert result is not None
        loaded = snapshots.load(
            "integ1", "/tmp/match.py", expected_sha=result.content_sha,
        )
        assert loaded == content

    def test_load_returns_none_on_sha_mismatch(self, tmp_data_dir):
        """``snapshots.load`` discards the load when sha disagrees."""
        result = snapshots.store("integ2", "/tmp/mismatch.py", b"original\n")
        assert result is not None
        # Pass a bogus expected sha that cannot match the stored bytes.
        loaded = snapshots.load(
            "integ2", "/tmp/mismatch.py",
            expected_sha="0" * 64,
        )
        assert loaded is None

    def test_load_without_expected_sha_skips_integrity_check(
        self, tmp_data_dir,
    ):
        """Omitting *expected_sha* preserves the legacy unchecked load path."""
        snapshots.store("integ3", "/tmp/legacy.py", b"hello\n")
        # No expected_sha keyword — should return the stored bytes.
        loaded = snapshots.load("integ3", "/tmp/legacy.py")
        assert loaded == b"hello\n"


class TestPostReadSnapshots:
    def test_post_read_captures_snapshot(self, tmp_data_dir, tmp_path):
        """post_read writes a snapshot of the read file's bytes.

        Uses ``write_bytes`` rather than ``write_text`` so the on-disk content
        is exact and platform-independent — ``write_text`` on Windows expands
        ``\\n`` to ``\\r\\n`` which would break a byte-equality assertion that
        passes on Linux.
        """
        src = tmp_path / "small.py"
        src.write_bytes(b"def x(): pass\n")
        payload = {
            "session_id": "post-read-snap-1",
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }
        _assert_continue(hooks_read.post_read(payload))
        # Compare against the exact disk bytes so the test is invariant to any
        # newline translation that the harness might apply.  The snapshot is
        # read straight from a binary file open and stored verbatim, so it
        # must match the source byte-for-byte regardless of platform.
        expected = src.read_bytes()
        assert snapshots.load("post-read-snap-1", str(src)) == expected
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




class TestPredictiveSnapshot:
    """Item 17: post_edit pre-snapshots locally imported modules for .py files."""

    def test_relative_import_creates_snapshot(self, tmp_path, tmp_data_dir):
        """Editing a .py file with a relative import pre-snapshots the imported module."""
        from token_goat import hooks_edit  # noqa: F401 — ensure module is loaded

        # Create two files: main.py imports .util
        util_py = tmp_path / "util.py"
        util_py.write_text("def helper(): pass\n", encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text("from .util import helper\n\ndef main(): pass\n", encoding="utf-8")

        sid = "pred-snap-rel-01" * 2
        payload = {
            "session_id": sid,
            "tool_name": "Write",
            "tool_input": {"file_path": str(main_py)},
            "tool_response": "ok",
            "cwd": str(tmp_path),
        }
        _assert_continue(_post_edit_sync(payload))

        stored = snapshots.load(sid, str(util_py))
        assert stored == util_py.read_bytes(), (
            "Expected util.py to be pre-snapshotted after editing main.py"
        )

    def test_non_python_file_no_snapshot(self, tmp_path, tmp_data_dir):
        """post_edit on a non-.py file does not trigger predictive snapshots."""
        from token_goat import hooks_edit  # noqa: F401 — ensure module is loaded

        ts_file = tmp_path / "component.ts"
        ts_file.write_text("import { foo } from './bar';\n", encoding="utf-8")

        sid = "pred-snap-ts-01" * 2
        payload = {
            "session_id": sid,
            "tool_name": "Write",
            "tool_input": {"file_path": str(ts_file)},
            "tool_response": "ok",
            "cwd": str(tmp_path),
        }
        # Non-.py file: no snapshot thread is spawned, so direct post_edit is fine.
        _assert_continue(hooks_edit.post_edit(payload))

        # No snapshots should have been created for this session
        session_dir_base = snapshots._session_dir(sid)
        if session_dir_base and session_dir_base.exists():
            files = list(session_dir_base.iterdir())
            assert len(files) == 0, f"Expected no snapshots for non-.py edit, got {files}"

    def test_cap_at_three_imports(self, tmp_path, tmp_data_dir):
        """Predictive snapshot caps at 3 imports per post_edit."""
        from token_goat import hooks_edit  # noqa: F401 — ensure module is loaded

        # Create 5 sibling modules
        for i in range(5):
            (tmp_path / f"mod{i}.py").write_text(f"# mod{i}\n", encoding="utf-8")

        imports = "\n".join(f"from .mod{i} import x" for i in range(5))
        main_py = tmp_path / "main.py"
        main_py.write_text(imports + "\n\ndef run(): pass\n", encoding="utf-8")

        sid = "pred-snap-cap-01" * 2
        payload = {
            "session_id": sid,
            "tool_name": "Write",
            "tool_input": {"file_path": str(main_py)},
            "tool_response": "ok",
            "cwd": str(tmp_path),
        }
        _assert_continue(_post_edit_sync(payload))

        # Count how many mod*.py files got snapshotted
        snap_count = sum(
            1 for i in range(5)
            if snapshots.load(sid, str(tmp_path / f"mod{i}.py")) is not None
        )
        assert snap_count <= 3, f"Expected at most 3 pre-snapshots, got {snap_count}"
        assert snap_count >= 1, "Expected at least 1 pre-snapshot to have been taken"

    def test_imports_below_type_checking_block_picked_up(self, tmp_path):
        """Imports under ``if TYPE_CHECKING:`` or ``try:`` are not a hard stop."""
        from token_goat.hooks_edit import _parse_local_imports

        # The real bug: legacy regex broke on the first non-import line, which
        # meant ``if TYPE_CHECKING:`` (or a docstring, decorator, ``try:``)
        # silently aborted the scan and the ``.util`` import below was lost.
        util_py = tmp_path / "util.py"
        util_py.write_text("def helper(): pass\n", encoding="utf-8")
        other_py = tmp_path / "other.py"
        other_py.write_text("def go(): pass\n", encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text(
            '"""Module docstring."""\n'
            "from __future__ import annotations\n"
            "\n"
            "from typing import TYPE_CHECKING\n"
            "\n"
            "if TYPE_CHECKING:\n"
            "    from .util import helper\n"
            "\n"
            "try:\n"
            "    from .other import go\n"
            "except ImportError:\n"
            "    go = None\n",
            encoding="utf-8",
        )

        resolved = _parse_local_imports(
            main_py.read_text(encoding="utf-8"), str(main_py), str(tmp_path),
        )
        # Both .util and .other should be discoverable — neither is at the
        # top of the file, but neither should have been silently skipped.
        assert any(r.endswith("util.py") for r in resolved), \
            f"util.py missing from {resolved}"
        assert any(r.endswith("other.py") for r in resolved), \
            f"other.py missing from {resolved}"

    def test_multiline_parenthesized_import(self, tmp_path):
        """``from foo import (\\n  bar,\\n)`` resolves like its single-line form."""
        from token_goat.hooks_edit import _parse_local_imports

        (tmp_path / "util.py").write_text("def a(): pass\n", encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text(
            "from .util import (\n"
            "    a,\n"
            "    b,\n"
            "    c,\n"
            ")\n"
            "\n"
            "def run(): pass\n",
            encoding="utf-8",
        )
        resolved = _parse_local_imports(
            main_py.read_text(encoding="utf-8"), str(main_py), str(tmp_path),
        )
        assert any(r.endswith("util.py") for r in resolved), \
            f"util.py not found in multi-line import scan: {resolved}"

    def test_duplicate_import_paths_deduped_before_cap(self, tmp_path):
        """Two imports of the same module count as one toward the cap."""
        from token_goat.hooks_edit import _parse_local_imports

        # Three real modules + duplicate imports of one of them.  Without
        # dedup, the duplicate would consume a slot in the cap-of-3 budget
        # and starve a real third module.
        for name in ("a", "b", "c"):
            (tmp_path / f"{name}.py").write_text(f"# {name}\n", encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text(
            "from .a import x\n"
            "from .a import y\n"  # duplicate target — must not consume a slot
            "from .b import z\n"
            "from .c import w\n",
            encoding="utf-8",
        )
        resolved = _parse_local_imports(
            main_py.read_text(encoding="utf-8"), str(main_py), str(tmp_path),
        )
        # We should get three distinct resolved paths, not two-plus-a-duplicate.
        assert len(resolved) == len(set(resolved)), \
            f"duplicates leaked through dedup: {resolved}"
        names = {Path(r).name for r in resolved}
        assert {"a.py", "b.py", "c.py"} == names, \
            f"expected all three distinct modules, got {names}"


class TestSnapshotKind:
    """Tagging snapshots with origin (read vs predictive) for telemetry.

    The kind sidecar is the single source of truth that lets the diff-hint
    path attribute a hit to the predictive-prefetch mechanism rather than to
    a normal post-read snapshot.  These tests pin the sidecar contract so
    later refactors (e.g. moving the kind into a manifest file) cannot
    silently drop attribution without flipping a test.
    """

    def test_default_kind_is_read(self, tmp_data_dir):
        """A store() without kind= produces a snapshot tagged ``read``.

        Backwards-compat sentinel: every existing call site passes no kind=,
        so the default must continue to be the post-read flavour.
        """
        snapshots.store("kind1", "/tmp/k1.py", b"hello\n")
        assert snapshots.load_kind("kind1", "/tmp/k1.py") == "read"

    def test_predictive_kind_stored_and_loaded(self, tmp_data_dir):
        """kind="predictive" round-trips through load_kind."""
        snapshots.store("kind2", "/tmp/k2.py", b"hi\n", kind="predictive")
        assert snapshots.load_kind("kind2", "/tmp/k2.py") == "predictive"

    def test_unknown_kind_falls_back_to_read(self, tmp_data_dir):
        """An unrecognised kind is normalised to ``read`` on write.

        Defensive — protects the on-disk format from being poisoned by a
        future caller passing an arbitrary string (e.g. a typo or a hostile
        payload).  The sidecar must only ever hold one of the known values.
        """
        snapshots.store("kind3", "/tmp/k3.py", b"x", kind="bogus-value")
        assert snapshots.load_kind("kind3", "/tmp/k3.py") == "read"

    def test_load_kind_missing_snapshot_returns_none(self, tmp_data_dir):
        """No snapshot at all → load_kind returns None.

        Pre-tag legacy snapshots also return None here; the diff-hint path
        treats None as "unknown / read" and proceeds without attribution.
        """
        assert snapshots.load_kind("kind4-none", "/tmp/never.py") is None

    def test_load_kind_missing_sidecar_returns_none(self, tmp_data_dir):
        """Snapshot exists, sidecar deleted → load_kind returns None.

        Models the legacy-snapshot path: a snapshot written by an older
        token-goat (before kind tagging) has no sidecar.  load_kind must
        degrade gracefully to None — never raise, never assume a default.
        """
        snapshots.store("kind5", "/tmp/k5.py", b"x", kind="predictive")
        p = snapshots.snapshot_path("kind5", "/tmp/k5.py")
        assert p is not None
        # Unlink the sidecar that store() wrote, leaving the .bin intact.
        sidecar = p.with_suffix(p.suffix + ".kind")
        assert sidecar.exists()
        sidecar.unlink()
        assert snapshots.load_kind("kind5", "/tmp/k5.py") is None
        # The snapshot itself is still loadable — only the attribution is lost.
        assert snapshots.load("kind5", "/tmp/k5.py") == b"x"

    def test_cleanup_session_removes_sidecars(self, tmp_data_dir):
        """``cleanup_session`` evicts both the snapshot and its kind sidecar."""
        snapshots.store("kind6", "/tmp/k6.py", b"a", kind="predictive")
        p = snapshots.snapshot_path("kind6", "/tmp/k6.py")
        assert p is not None
        sidecar = p.with_suffix(p.suffix + ".kind")
        assert sidecar.exists()
        snapshots.cleanup_session("kind6")
        assert not sidecar.exists()
        assert snapshots.load_kind("kind6", "/tmp/k6.py") is None

    def test_eviction_drops_orphan_sidecar(self, tmp_data_dir, monkeypatch):
        """When _evict_oldest drops a .bin, its .kind sidecar goes with it.

        The cap counts only .bin files (sidecars are bookkeeping), so an
        orphaned .kind after eviction is a leak.  Verify the cleanup happens
        in-band rather than waiting for the periodic stale sweep.
        """
        import os as _os
        import time as _time

        monkeypatch.setattr(snapshots, "MAX_SNAPSHOTS_PER_SESSION", 2)
        base_ts = _time.time() - 100
        for i in range(4):
            result = snapshots.store(
                "kind7-evict", f"/tmp/ke{i}.py", f"v{i}".encode(), kind="predictive",
            )
            assert result is not None
            _os.utime(result.path, (base_ts + i, base_ts + i))
            sidecar = result.path.with_suffix(result.path.suffix + ".kind")
            if sidecar.exists():
                _os.utime(sidecar, (base_ts + i, base_ts + i))

        # The two oldest .bin files should be evicted along with their
        # sidecars.  Walk the session dir and confirm no orphan .kind exists.
        sess_dir = snapshots._session_dir("kind7-evict")
        assert sess_dir is not None
        kinds = sorted(p.name for p in sess_dir.iterdir() if p.suffix == ".kind")
        bins = sorted(p.name for p in sess_dir.iterdir() if p.suffix == ".bin")
        # Every kind sidecar must have a matching .bin counterpart.
        bin_stems = {p[:-len(".bin")] for p in bins}
        kind_stems = {p[:-len(".bin.kind")] for p in kinds}
        assert kind_stems.issubset(bin_stems), \
            f"orphan .kind files: {kind_stems - bin_stems}"


class TestPredictivePrefetchAttribution:
    """The post_edit prefetch path must tag its snapshots as ``predictive``.

    Together with TestSnapshotKind this anchors the end-to-end attribution
    chain: post_edit writes ``predictive``, the diff-hint path reads back
    ``predictive`` and emits a ``predictive_prefetch_hit`` stat row.  If
    either side regresses, the stat row stops appearing in ``token-goat
    stats`` and the prefetch mechanism becomes unmeasurable again.
    """

    def test_predictive_snapshot_kind_is_predictive(self, tmp_path, tmp_data_dir):
        """End-to-end: editing a .py with a local import tags the prefetched
        snapshot as ``predictive`` (not the default ``read``)."""
        from token_goat import hooks_edit  # noqa: F401 — ensure module is loaded

        util_py = tmp_path / "util.py"
        util_py.write_text("def helper(): pass\n", encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text("from .util import helper\n", encoding="utf-8")

        sid = "pred-kind-end-to-end-01"
        payload = {
            "session_id": sid,
            "tool_name": "Write",
            "tool_input": {"file_path": str(main_py)},
            "tool_response": "ok",
            "cwd": str(tmp_path),
        }
        # Use _post_edit_sync to join the daemon thread before asserting.
        _assert_continue(_post_edit_sync(payload))

        # The prefetched util.py snapshot must carry the predictive tag.
        assert snapshots.load_kind(sid, str(util_py)) == "predictive"


# ---------------------------------------------------------------------------
# Content-hash dedup
# ---------------------------------------------------------------------------

class TestSnapshotContentHashDedup:
    """store() skips the disk write when content is unchanged (C3.4)."""

    def test_second_store_same_content_skips_write(self, tmp_data_dir, monkeypatch):
        """Storing the same content twice does not rewrite the file."""
        import os
        content = b"def foo(): pass\n"
        sid = "dedup-01"
        fp = "/proj/src/foo.py"

        r1 = snapshots.store(sid, fp, content)
        assert r1 is not None

        # Backdate the file's mtime by 2 s so any subsequent write is
        # unambiguously detectable without a real time.sleep().
        past_ts = os.stat(r1.path).st_mtime - 2.0
        os.utime(r1.path, (past_ts, past_ts))
        mtime1 = os.stat(r1.path).st_mtime

        r2 = snapshots.store(sid, fp, content)
        assert r2 is not None
        assert r2.content_sha == r1.content_sha
        # File must not have been rewritten — mtime unchanged.
        mtime2 = os.stat(r2.path).st_mtime
        assert mtime1 == mtime2, "snapshot should not be rewritten for identical content"

    def test_different_content_rewrites_snapshot(self, tmp_data_dir):
        """Changed content triggers a write; new snapshot replaces old."""
        content_v1 = b"def foo(): return 1\n"
        content_v2 = b"def foo(): return 2\n"
        sid = "dedup-02"
        fp = "/proj/src/bar.py"

        r1 = snapshots.store(sid, fp, content_v1)
        assert r1 is not None

        r2 = snapshots.store(sid, fp, content_v2)
        assert r2 is not None
        assert r2.content_sha != r1.content_sha
        loaded = snapshots.load(sid, fp)
        assert loaded == content_v2

    def test_first_store_writes_when_no_existing_snapshot(self, tmp_data_dir):
        """When no snapshot exists, the first store() always writes."""
        content = b"brand new content\n"
        sid = "dedup-03"
        fp = "/proj/src/new_file.py"
        r = snapshots.store(sid, fp, content)
        assert r is not None
        assert snapshots.load(sid, fp) == content

    def test_returns_correct_sha_even_on_cache_hit(self, tmp_data_dir):
        """SHA in the returned SnapshotResult is always the content hash."""
        import hashlib
        content = b"class Baz:\n    pass\n"
        sid = "dedup-04"
        fp = "/proj/src/baz.py"
        snapshots.store(sid, fp, content)
        r = snapshots.store(sid, fp, content)
        assert r is not None
        expected_sha = hashlib.sha256(content).hexdigest()
        assert r.content_sha == expected_sha

    def test_read_error_on_existing_falls_through_to_write(self, tmp_data_dir, monkeypatch):
        """If reading the existing snapshot fails, we fall through to a normal write."""
        content = b"def boo(): pass\n"
        sid = "dedup-05"
        fp = "/proj/src/boo.py"
        r1 = snapshots.store(sid, fp, content)
        assert r1 is not None

        # Simulate a read error on the second call.
        orig_read_bytes = Path.read_bytes
        call_count = [0]
        def fail_read(self):
            call_count[0] += 1
            if call_count[0] == 1:
                raise OSError("simulated read error")
            return orig_read_bytes(self)
        monkeypatch.setattr(Path, "read_bytes", fail_read)

        # Must not raise; falls through to write.
        r2 = snapshots.store(sid, fp, content)
        assert r2 is not None


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------

class TestSnapshotTruncation:
    """Files between SNAPSHOT_TRUNCATE_BYTES and MAX_SNAPSHOT_BYTES are stored
    truncated so the snapshot dir stays small while diff hints still fire on
    the prefix (C4.1 — size cap with partial-snapshot fallback).
    """

    def test_small_file_stored_verbatim(self, tmp_data_dir):
        """Files at or below SNAPSHOT_TRUNCATE_BYTES are stored unchanged."""
        content = b"x" * snapshots.SNAPSHOT_TRUNCATE_BYTES
        sid = "trunc-small-01"
        fp = "/proj/small.py"
        r = snapshots.store(sid, fp, content)
        assert r is not None
        loaded = snapshots.load(sid, fp)
        # Full content must be stored; no truncation marker.
        assert loaded == content

    def test_large_file_truncated_with_marker(self, tmp_data_dir):
        """A file above SNAPSHOT_TRUNCATE_BYTES but below MAX_SNAPSHOT_BYTES
        is stored truncated and the truncation marker is appended.
        """
        orig_len = snapshots.SNAPSHOT_TRUNCATE_BYTES + 1024
        content = b"A" * orig_len
        sid = "trunc-large-01"
        fp = "/proj/large.py"
        r = snapshots.store(sid, fp, content)
        assert r is not None, "large file should be stored (truncated, not skipped)"
        loaded = snapshots.load(sid, fp)
        assert loaded is not None
        # Stored bytes must be smaller than the original.
        assert len(loaded) < orig_len
        # Prefix must be the first SNAPSHOT_TRUNCATE_BYTES bytes.
        assert loaded[:snapshots.SNAPSHOT_TRUNCATE_BYTES] == content[:snapshots.SNAPSHOT_TRUNCATE_BYTES]
        # Truncation marker must mention the original byte count.
        assert str(orig_len).encode() in loaded, (
            f"truncation marker should embed original length {orig_len!r}"
        )

    def test_truncated_snapshot_integrity_check_consistent(self, tmp_data_dir):
        """Integrity check passes when expected_sha matches the truncated bytes.

        The SHA stored in SnapshotResult (and later in the session) is the SHA
        of the *stored* (truncated+marker) bytes.  load() with that expected_sha
        must succeed — verifying the round-trip is internally consistent.
        """
        orig_len = snapshots.SNAPSHOT_TRUNCATE_BYTES + 512
        content = b"B" * orig_len
        sid = "trunc-integ-01"
        fp = "/proj/trunc_integ.py"
        r = snapshots.store(sid, fp, content)
        assert r is not None
        # Passing the stored sha must succeed (on-disk bytes == truncated bytes).
        loaded = snapshots.load(sid, fp, expected_sha=r.content_sha)
        assert loaded is not None, "load with matching sha should succeed for truncated snapshot"
        # Passing the SHA of the *original* content must fail: the integrity
        # check compares against the stored (truncated) bytes, not the original.
        original_sha = hashlib.sha256(content).hexdigest()
        # The original SHA only fails when it differs from the truncated SHA,
        # which is always the case when the file is actually truncated.
        if original_sha != r.content_sha:
            bad_load = snapshots.load(sid, fp, expected_sha=original_sha)
            assert bad_load is None, (
                "load with original (untruncated) sha should fail — "
                "the stored bytes are truncated and have a different hash"
            )

    def test_oversized_file_still_skipped(self, tmp_data_dir):
        """Files above MAX_SNAPSHOT_BYTES are still skipped entirely (not truncated).

        The truncation path only handles files in the range
        (SNAPSHOT_TRUNCATE_BYTES, MAX_SNAPSHOT_BYTES].
        """
        content = b"Z" * (snapshots.MAX_SNAPSHOT_BYTES + 1)
        sid = "trunc-over-01"
        fp = "/proj/toobig.py"
        r = snapshots.store(sid, fp, content)
        assert r is None, "files above MAX_SNAPSHOT_BYTES must still return None"
        assert snapshots.load(sid, fp) is None


# ---------------------------------------------------------------------------
# symbol_changed_since_read integrity gate
# ---------------------------------------------------------------------------

class TestSymbolChangedIntegrity:
    """symbol_changed_since_read must use the integrity-gated load path so a
    corrupted or tampered snapshot cannot produce a misleading stale-symbol
    warning.
    """

    def test_symbol_changed_returns_true_when_changed(self, tmp_data_dir):
        """Basic sanity: returns True when the symbol body differs."""
        body = "def foo():\n    return 1\n"
        filler = "# filler\n" * 20
        old_text = filler + body
        sid = "sym-integ-01"
        fp = "/proj/sym_test.py"
        snapshots.store(sid, fp, old_text.encode())
        # Symbol is at lines 21-22 (1-based) in the original.
        result = snapshots.symbol_changed_since_read(
            session_id=sid,
            file_path=fp,
            symbol_name="foo",
            current_start_line=21,
            current_end_line=22,
            current_text="def foo():\n    return 99\n",
        )
        assert result is True

    def test_symbol_changed_returns_false_when_unchanged(self, tmp_data_dir):
        """Returns False when the symbol body is identical in the snapshot."""
        body = "def bar():\n    pass\n"
        filler = "# filler\n" * 10
        text = filler + body
        sid = "sym-integ-02"
        fp = "/proj/sym_unch.py"
        snapshots.store(sid, fp, text.encode())
        result = snapshots.symbol_changed_since_read(
            session_id=sid,
            file_path=fp,
            symbol_name="bar",
            current_start_line=11,
            current_end_line=12,
            current_text=body,
        )
        assert result is False

    def test_symbol_changed_suppressed_on_corrupted_snapshot(self, tmp_data_dir):
        """When the snapshot SHA is recorded but the on-disk bytes are corrupted,
        the integrity-gated load discards the snapshot and returns False (no
        false stale-symbol warning) rather than comparing against wrong bytes.

        This is the correctness regression guard: without the integrity gate,
        a tampered snapshot could cause symbol_changed_since_read to claim a
        symbol changed when it did not, or vice versa.
        """
        body = "def baz():\n    return 42\n"
        filler = "# filler\n" * 20
        orig_text = filler + body
        sid = "sym-integ-corrupt-01"
        fp = "/proj/sym_corrupt.py"

        result = snapshots.store(sid, fp, orig_text.encode())
        assert result is not None
        # Record the sha in the session so the integrity gate activates.
        session.set_snapshot_sha(sid, fp, result.content_sha)

        # Tamper with the snapshot: write completely different content to disk.
        snap_path = snapshots.snapshot_path(sid, fp)
        assert snap_path is not None
        corrupted = b"GARBAGE DATA " * 50
        snap_path.write_bytes(corrupted)

        # With the integrity gate, the load must fail and return False (no
        # misleading stale-symbol warning based on corrupted bytes).
        changed = snapshots.symbol_changed_since_read(
            session_id=sid,
            file_path=fp,
            symbol_name="baz",
            current_start_line=21,
            current_end_line=22,
            current_text=body,
        )
        assert changed is False, (
            "symbol_changed_since_read must return False when the snapshot "
            "is corrupted — the integrity gate should discard the bad bytes "
            "rather than comparing against them and emitting a false warning"
        )

    def test_symbol_changed_without_recorded_sha_uses_legacy_path(self, tmp_data_dir):
        """When no SHA is recorded in the session (legacy snapshot), the
        integrity check is skipped and the snapshot bytes are used directly.

        This preserves backward compatibility: old snapshots that pre-date
        SHA recording still drive symbol-change detection.
        """
        body = "def legacy():\n    return 0\n"
        filler = "# filler\n" * 10
        old_text = filler + body
        sid = "sym-legacy-01"
        fp = "/proj/sym_legacy.py"
        snapshots.store(sid, fp, old_text.encode())
        # Note: we deliberately do NOT call session.set_snapshot_sha() here.

        # Symbol is unchanged — should return False via the unverified path.
        result = snapshots.symbol_changed_since_read(
            session_id=sid,
            file_path=fp,
            symbol_name="legacy",
            current_start_line=11,
            current_end_line=12,
            current_text=body,
        )
        assert result is False


# ---------------------------------------------------------------------------
# Content-hash dedup
# ---------------------------------------------------------------------------

class TestStoreContentHashDedup:
    """store() skips the disk write when content is identical to the existing snapshot."""

    def test_same_content_skips_write(self, tmp_data_dir, monkeypatch):
        from token_goat import paths as _tg_paths
        write_log: list = []
        orig = _tg_paths.atomic_write_bytes

        def spy(p, data):
            write_log.append(p)
            orig(p, data)

        monkeypatch.setattr(_tg_paths, "atomic_write_bytes", spy)
        content = b"def foo():\n    pass\n"
        r1 = snapshots.store("dedup-01", "/p/file.py", content)
        assert r1 is not None
        writes_after_first = len(write_log)

        r2 = snapshots.store("dedup-01", "/p/file.py", content)
        assert r2 is not None
        assert r2.content_sha == r1.content_sha
        assert len(write_log) == writes_after_first  # no new writes for unchanged content

    def test_changed_content_writes_through(self, tmp_data_dir):
        r1 = snapshots.store("dedup-02", "/p/file.py", b"version 1")
        r2 = snapshots.store("dedup-02", "/p/file.py", b"version 2")
        assert r1 is not None and r2 is not None
        assert r1.content_sha != r2.content_sha
        assert snapshots.load("dedup-02", "/p/file.py") == b"version 2"


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------

class TestStoreTruncation:
    """Files above SNAPSHOT_TRUNCATE_BYTES are stored truncated with a sentinel."""

    def test_oversized_body_stored_truncated(self, tmp_data_dir):
        content = b"A" * (snapshots.SNAPSHOT_TRUNCATE_BYTES + 512)
        r = snapshots.store("trunc-01", "/p/big.py", content)
        assert r is not None
        stored = snapshots.load("trunc-01", "/p/big.py")
        assert stored is not None
        assert len(stored) < len(content)
        assert b"<snapshot truncated at" in stored
        assert stored[: snapshots.SNAPSHOT_TRUNCATE_BYTES] == content[: snapshots.SNAPSHOT_TRUNCATE_BYTES]

    def test_file_exactly_at_threshold_not_truncated(self, tmp_data_dir):
        content = b"B" * snapshots.SNAPSHOT_TRUNCATE_BYTES
        r = snapshots.store("trunc-02", "/p/exact.py", content)
        assert r is not None
        stored = snapshots.load("trunc-02", "/p/exact.py")
        assert stored == content
        assert b"<snapshot truncated at" not in stored


# ---------------------------------------------------------------------------
# load() integrity check
# ---------------------------------------------------------------------------

class TestLoadIntegrityCheck:
    """load() with expected_sha rejects snapshots whose bytes don't match."""

    def test_sha_mismatch_returns_none(self, tmp_data_dir):
        r = snapshots.store("integ-01", "/p/file.py", b"original")
        assert r is not None
        result = snapshots.load("integ-01", "/p/file.py", expected_sha="0" * 64)
        assert result is None

    def test_correct_sha_returns_content(self, tmp_data_dir):
        content = b"trusted content"
        r = snapshots.store("integ-02", "/p/file.py", content)
        assert r is not None
        result = snapshots.load("integ-02", "/p/file.py", expected_sha=r.content_sha)
        assert result == content

    def test_none_sha_skips_integrity_check(self, tmp_data_dir):
        content = b"no check"
        snapshots.store("integ-03", "/p/file.py", content)
        result = snapshots.load("integ-03", "/p/file.py", expected_sha=None)
        assert result == content


# ---------------------------------------------------------------------------
# load_kind() edge cases
# ---------------------------------------------------------------------------

class TestLoadKindEdgeCases:
    """load_kind() returns None for absent, undecodable, or unrecognised sidecar."""

    def test_missing_sidecar_returns_none(self, tmp_data_dir):
        r = snapshots.store("kind-01", "/p/file.py", b"content")
        assert r is not None
        sidecar = r.path.with_suffix(r.path.suffix + ".kind")
        if sidecar.exists():
            sidecar.unlink()
        assert snapshots.load_kind("kind-01", "/p/file.py") is None

    def test_invalid_bytes_sidecar_returns_none(self, tmp_data_dir):
        r = snapshots.store("kind-02", "/p/file.py", b"content")
        assert r is not None
        sidecar = r.path.with_suffix(r.path.suffix + ".kind")
        sidecar.write_bytes(b"\xff\xfe not ascii")
        assert snapshots.load_kind("kind-02", "/p/file.py") is None

    def test_unknown_kind_string_returns_none(self, tmp_data_dir):
        r = snapshots.store("kind-03", "/p/file.py", b"content")
        assert r is not None
        sidecar = r.path.with_suffix(r.path.suffix + ".kind")
        sidecar.write_bytes(b"not_a_valid_kind")
        assert snapshots.load_kind("kind-03", "/p/file.py") is None

    def test_predictive_kind_roundtrips(self, tmp_data_dir):
        r = snapshots.store("kind-04", "/p/file.py", b"content", kind="predictive")
        assert r is not None
        assert snapshots.load_kind("kind-04", "/p/file.py") == "predictive"


# ---------------------------------------------------------------------------
# cleanup_stale()
# ---------------------------------------------------------------------------

class TestCleanupStale:
    """cleanup_stale() removes old snapshots and prunes empty session dirs."""

    def test_stale_snapshots_removed(self, tmp_data_dir):
        import os
        import time

        r = snapshots.store("stale-01", "/p/file.py", b"old")
        assert r is not None
        old_ts = time.time() - 48 * 3600
        os.utime(r.path, (old_ts, old_ts))
        sidecar = r.path.with_suffix(r.path.suffix + ".kind")
        if sidecar.exists():
            os.utime(sidecar, (old_ts, old_ts))

        removed = snapshots.cleanup_stale(max_age_hours=24.0)
        assert removed >= 1
        assert snapshots.load("stale-01", "/p/file.py") is None

    def test_fresh_snapshots_not_removed(self, tmp_data_dir):
        r = snapshots.store("stale-02", "/p/file.py", b"fresh")
        assert r is not None
        removed = snapshots.cleanup_stale(max_age_hours=24.0)
        assert removed == 0
        assert snapshots.load("stale-02", "/p/file.py") == b"fresh"

    def test_missing_base_dir_returns_zero(self, tmp_data_dir):
        # No snapshots stored in this test — session_snapshots dir does not exist.
        assert snapshots.cleanup_stale(max_age_hours=1.0) == 0

    def test_empty_session_dir_pruned(self, tmp_data_dir):
        import os
        import time

        r = snapshots.store("stale-empty", "/p/file.py", b"x")
        assert r is not None
        session_dir = r.path.parent
        old_ts = time.time() - 48 * 3600
        os.utime(r.path, (old_ts, old_ts))
        sidecar = r.path.with_suffix(r.path.suffix + ".kind")
        if sidecar.exists():
            os.utime(sidecar, (old_ts, old_ts))

        snapshots.cleanup_stale(max_age_hours=24.0)
        assert not session_dir.exists()
