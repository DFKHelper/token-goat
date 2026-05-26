"""Tests for the per-session file-content snapshot store + diff-aware re-read."""
from __future__ import annotations

from pathlib import Path

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
        import time

        from token_goat import hooks_edit

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
        _assert_continue(hooks_edit.post_edit(payload))

        # Give the daemon thread time to complete
        time.sleep(0.3)

        stored = snapshots.load(sid, str(util_py))
        assert stored == util_py.read_bytes(), (
            "Expected util.py to be pre-snapshotted after editing main.py"
        )

    def test_non_python_file_no_snapshot(self, tmp_path, tmp_data_dir):
        """post_edit on a non-.py file does not trigger predictive snapshots."""
        import time

        from token_goat import hooks_edit

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
        _assert_continue(hooks_edit.post_edit(payload))
        time.sleep(0.15)

        # No snapshots should have been created for this session
        session_dir_base = snapshots._session_dir(sid)
        if session_dir_base and session_dir_base.exists():
            files = list(session_dir_base.iterdir())
            assert len(files) == 0, f"Expected no snapshots for non-.py edit, got {files}"

    def test_cap_at_three_imports(self, tmp_path, tmp_data_dir):
        """Predictive snapshot caps at 3 imports per post_edit."""
        import time

        from token_goat import hooks_edit

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
        _assert_continue(hooks_edit.post_edit(payload))
        time.sleep(0.4)

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
        import time

        from token_goat import hooks_edit

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
        _assert_continue(hooks_edit.post_edit(payload))
        time.sleep(0.3)

        # The prefetched util.py snapshot must carry the predictive tag.
        assert snapshots.load_kind(sid, str(util_py)) == "predictive"
