"""End-to-end: post_read snapshots, post_edit invalidates, pre_read emits diff."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_edit, hooks_read, session


class TestDiffHintEndToEnd:
    def test_read_then_edit_then_reread_emits_diff(self, tmp_data_dir, tmp_path):
        """A read followed by an edit and a re-read should yield a diff hint."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        # Generously large file so the saving easily clears the min threshold.
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        original = "VERSION = 1\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "diff-e2e-1"

        # 1. Read — populates snapshot.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. Edit — bumps last_edit_ts so the pre_read invalidates the dedup hint.
        src.write_text("VERSION = 2\n" + body, encoding="utf-8")
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read — should produce a diff-based hint.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        # A 1-line change (VERSION = 1 → VERSION = 2) is a micro-diff: the hint
        # emits a compact summary line rather than a full unified diff block.
        # Either format is acceptable — verify the hint fires and mentions the file.
        assert "module.py" in ctx or "```diff" in ctx, (
            f"Expected diff hint referencing module.py, got: {ctx!r}"
        )

    def test_no_snapshot_falls_back_to_session_hint(self, tmp_data_dir, tmp_path):
        """When no snapshot exists, pre_read uses the regular cache hint path."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        src.write_text("x = 1\n", encoding="utf-8")

        sid = "diff-e2e-2"
        # Mark file as already read (line range) but skip the snapshot step.
        session.mark_file_read(sid, str(src), offset=0, limit=200)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 0, "limit": 200},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        # The standard cache hint uses "⌘" (terse for "cached") / "already read" —
        # distinct from the diff hint's "edited in this session" wording.
        assert "⌘" in ctx or "already read" in ctx or "previously read" in ctx
        assert "```diff" not in ctx

    def test_diff_hint_suppressed_for_non_overlapping_range(self, tmp_data_dir, tmp_path):
        """Diff hint is suppressed when the re-read range doesn't overlap prior reads."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "large.py"
        # 600 lines: first 200 are "old" block, rest are independent.
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(300))
        original_content = body
        src.write_text(original_content, encoding="utf-8")

        sid = "diff-e2e-range-no-overlap"

        # 1. Read lines 1-100 (offset=0, limit=100) — snapshot stored for these.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 0, "limit": 100},
        }))

        # 2. Edit the file (first few lines).
        modified = original_content.replace("def fn_0", "def fn_0_renamed", 1)
        src.write_text(modified, encoding="utf-8")
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read a completely different section (lines 450+ = offset 449+).
        # The prior read covered lines 1-100 and slop is 200, so offset 349
        # is exactly at the edge — use offset=500 to be well outside the slop band.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 500, "limit": 50},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        # Diff hint should be suppressed: requested range [501,550] is far outside
        # cached range [1,100] plus slop (200), so no diff is relevant.
        assert "```diff" not in ctx

    def test_diff_hint_fires_for_overlapping_range(self, tmp_data_dir, tmp_path):
        """Diff hint fires when the re-read range overlaps prior reads."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module_overlap.py"
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(300))
        original_content = "VERSION = 1\n" + body
        src.write_text(original_content, encoding="utf-8")

        sid = "diff-e2e-overlap"

        # 1. Read lines 1-200 (offset=0, limit=200).
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 0, "limit": 200},
        }))

        # 2. Edit the first line.
        modified = original_content.replace("VERSION = 1", "VERSION = 2", 1)
        src.write_text(modified, encoding="utf-8")
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read the same range — diff hint should fire.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 0, "limit": 200},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        # Diff hint should fire: the range overlaps the prior read.
        assert "module_overlap.py" in ctx or "```diff" in ctx, (
            f"Expected diff hint, got: {ctx!r}"
        )


class TestPredictivePrefetchTelemetry:
    """A diff-hint hit against a predictive snapshot records an attribution row.

    End-to-end: post_edit prefetches an adjacent module → the agent later
    reads that module → the pre-read diff hint fires → a
    ``predictive_prefetch_hit`` row is appended to the stats table.  Without
    this row the value of the prefetch path is invisible in
    ``token-goat stats``.
    """

    def test_diff_hint_against_predictive_snapshot_records_attribution(
        self, tmp_data_dir, tmp_path,
    ):
        """When the diff hint fires against a kind=predictive snapshot, a
        predictive_prefetch_hit row appears in the global stats DB."""
        import time

        from token_goat import db, hooks_edit, hooks_read, snapshots

        (tmp_path / ".git").mkdir()

        # Sufficient body to clear the diff-hint min-saving threshold.
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        util_py = tmp_path / "util.py"
        util_original = "VERSION = 1\n" + body
        util_py.write_text(util_original, encoding="utf-8")

        main_py = tmp_path / "main.py"
        main_py.write_text("from .util import fn_0\n", encoding="utf-8")

        sid = "pred-prefetch-tele-01"

        # 1. Edit main.py — triggers the predictive-prefetch snapshot of util.py.
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(main_py)},
            "cwd": str(tmp_path),
        }))
        # Wait for the daemon thread to finish.
        time.sleep(0.4)

        # Sanity: the predictive snapshot exists and is tagged.
        assert snapshots.load_kind(sid, str(util_py)) == "predictive", (
            "precondition: util.py must have been pre-snapshotted as predictive"
        )

        # 2. The user edits util.py externally before the agent reads it.
        util_py.write_text("VERSION = 2\n" + body, encoding="utf-8")

        # 3. Agent reads util.py → diff hint fires against the predictive snapshot.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(util_py)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        # The diff hint must have fired — otherwise the attribution test below
        # would silently pass for the wrong reason.
        assert "util.py" in ctx or "```diff" in ctx, (
            f"diff hint expected, got: {ctx!r}"
        )

        # 4. The predictive_prefetch_hit attribution row was written.
        with db.open_global() as conn:
            row = conn.execute(
                "SELECT detail FROM stats "
                "WHERE kind = 'predictive_prefetch_hit' "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
        assert row is not None, (
            "expected a predictive_prefetch_hit row after diff-hint fired on a "
            "predictive snapshot"
        )
        # detail should mention util.py (the file the prefetch paid off on).
        assert "util.py" in (row[0] or ""), (
            f"detail must identify the prefetched file; got {row[0]!r}"
        )

    def test_diff_hint_against_read_snapshot_no_attribution(
        self, tmp_data_dir, tmp_path,
    ):
        """A normal post-read snapshot must NOT generate a prefetch_hit row.

        Negative control for the test above: without this guard, a buggy
        load_kind that returned "predictive" for every snapshot would still
        pass the positive test but pollute stats with false attributions.
        """
        from token_goat import db, hooks_edit, hooks_read

        (tmp_path / ".git").mkdir()
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        src = tmp_path / "mod.py"
        src.write_text("VERSION = 1\n" + body, encoding="utf-8")

        sid = "pred-prefetch-neg-01"

        # Capture how many prefetch_hit rows existed at start of test (other
        # tests in this file run before this one and may have written rows).
        with db.open_global() as conn:
            before_count = conn.execute(
                "SELECT COUNT(*) FROM stats WHERE kind = 'predictive_prefetch_hit'"
            ).fetchone()[0]

        # 1. Normal post-read → kind=read snapshot.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))
        # 2. Edit so the diff has something to show.
        src.write_text("VERSION = 2\n" + body, encoding="utf-8")
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))
        # 3. Re-read → diff hint fires, but against a read-flavoured snapshot.
        _assert_continue(hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        with db.open_global() as conn:
            after_count = conn.execute(
                "SELECT COUNT(*) FROM stats WHERE kind = 'predictive_prefetch_hit'"
            ).fetchone()[0]
        assert after_count == before_count, (
            "post-read snapshot must not produce a predictive_prefetch_hit row "
            f"(before={before_count}, after={after_count})"
        )
