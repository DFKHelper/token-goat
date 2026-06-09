"""End-to-end: post_read snapshots, post_edit invalidates, pre_read emits diff."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import (
    assert_well_formed_unified_diff,
    extract_diff_block,
)
from hook_helpers import post_edit_sync as _post_edit_sync

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

    def test_full_diff_block_is_well_formed(self, tmp_data_dir, tmp_path):
        """Regression: a multi-hunk diff hint must render a valid unified diff.

        ``build_diff_hint`` builds its lines with ``splitlines(keepends=True)``
        and joins with ``"".join`` — so the ``unified_diff`` call must use the
        default ``lineterm="\\n"``. Forcing ``lineterm=""`` glues the
        ``---``/``+++``/``@@`` headers onto one line. The fixture changes three
        well-separated lines (multi-hunk, >2 changed lines so the micro-diff
        summary collapse does not apply) and contains no blank content lines, so
        any glued header or empty interior line is the malformation.
        """
        (tmp_path / ".git").mkdir()
        src = tmp_path / "settings_full.py"
        # 500 lines (~7,500 chars / 3.5 ≈ 2,143 tokens) — savings exceed the
        # configurable diff_hint_min_tokens_saved default (1,000) so the diff
        # hint fires regardless of project config.
        lines = [f"OPTION_{i} = {i}\n" for i in range(500)]
        src.write_text("".join(lines), encoding="utf-8")

        sid = "diff-e2e-full-block"

        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # Three widely separated edits → three hunks → full unified diff block
        # (not the micro-diff one-liner summary).
        lines[0] = "OPTION_0 = 999\n"
        lines[250] = "OPTION_250 = 999\n"
        lines[499] = "OPTION_499 = 999\n"
        src.write_text("".join(lines), encoding="utf-8")
        _assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        ctx = (result.get("hookSpecificOutput") or {}).get("additionalContext", "")
        diff_block = extract_diff_block(ctx)
        assert_well_formed_unified_diff(diff_block)
        assert diff_block.count("@@ ") >= 3, (
            f"expected >=3 hunk headers, got: {diff_block!r}"
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


class TestDiffHintFingerprintDedup:
    """Diff hint fingerprint deduplication — same diff suppressed, new edit re-fires."""

    def _make_large_file(self, path, version: int = 1) -> str:
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        content = f"VERSION = {version}\n" + body
        path.write_text(content, encoding="utf-8")
        return content

    def test_second_prereread_same_diff_suppressed(self, tmp_data_dir, tmp_path):
        """After a diff hint fires once, a second pre_read with the same edit
        should suppress the diff hint (identical fingerprint in hints_seen)."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "dedup_test.py"
        self._make_large_file(src, version=1)

        sid = "diff-dedup-suppress-1"

        # 1. Read — populates snapshot.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. Edit — bumps last_edit_ts and updates file on disk.
        self._make_large_file(src, version=2)
        _assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. First pre_read — diff hint should fire.
        result1 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result1)
        hso1 = result1.get("hookSpecificOutput") or {}
        ctx1 = hso1.get("additionalContext", "") if isinstance(hso1, dict) else ""
        assert "dedup_test.py" in ctx1 or "```diff" in ctx1, (
            f"First pre_read should emit diff hint; got: {ctx1!r}"
        )

        # 4. Second pre_read with no new edit — diff hint should be suppressed.
        result2 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result2)
        hso2 = result2.get("hookSpecificOutput") or {}
        ctx2 = hso2.get("additionalContext", "") if isinstance(hso2, dict) else ""
        # The diff hint should be suppressed (fingerprint already in hints_seen).
        # Either no context at all, or a different (session / cooldown) hint — not a diff.
        assert "```diff" not in ctx2, (
            f"Second pre_read with same edit should suppress diff hint; got: {ctx2!r}"
        )

    def test_new_edit_after_dedup_fires_diff_hint_again(self, tmp_data_dir, tmp_path):
        """After the diff hint is suppressed by fingerprint dedup, a subsequent
        edit that produces a distinguishably different diff fires the hint again.

        To guarantee a different diff fingerprint, the second edit adds new
        function definitions (changes a different number of lines) rather than
        just bumping a version integer, so the micro-diff summary text differs.
        """
        (tmp_path / ".git").mkdir()
        src = tmp_path / "refire_test.py"
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        original = "VERSION = 1\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "diff-dedup-refire-1"

        # 1. Read — populates snapshot.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. First edit: bump VERSION line (1 line changed → micro-diff ±2 lines @ L1).
        v2 = "VERSION = 2\n" + body
        src.write_text(v2, encoding="utf-8")
        _assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. First pre_read — diff hint fires (fingerprint registered).
        result1 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result1)
        hso1 = result1.get("hookSpecificOutput") or {}
        ctx1 = hso1.get("additionalContext", "") if isinstance(hso1, dict) else ""
        assert "refire_test.py" in ctx1 or "```diff" in ctx1, (
            f"First pre_read should emit diff hint; got: {ctx1!r}"
        )

        # 4. Second pre_read — same diff, suppressed.
        result_suppressed = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result_suppressed)
        hso_s = result_suppressed.get("hookSpecificOutput") or {}
        ctx_s = hso_s.get("additionalContext", "") if isinstance(hso_s, dict) else ""
        assert "```diff" not in ctx_s, (
            f"Second pre_read with same edit should suppress diff hint; got: {ctx_s!r}"
        )

        # 5. Update snapshot to current (VERSION=2) content then make a
        # structurally different edit: add several new lines at the top so the
        # diff involves more changed lines than the first edit.  This guarantees
        # the micro-diff summary text (or full diff text) differs from the first
        # hint, producing a new fingerprint.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))
        # Add 5 extra lines at the start — diff will show ±7 lines (5 added + 1
        # removed + 1 added for VERSION, i.e. a large structural change) rather
        # than the ±2 of the first edit.
        extra_header = "EXTRA_1 = 1\nEXTRA_2 = 2\nEXTRA_3 = 3\nEXTRA_4 = 4\nEXTRA_5 = 5\n"
        v3 = extra_header + "VERSION = 3\n" + body
        src.write_text(v3, encoding="utf-8")
        _assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 6. Third pre_read — new diff content → new fingerprint → should fire again.
        result3 = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result3)
        hso3 = result3.get("hookSpecificOutput") or {}
        ctx3 = hso3.get("additionalContext", "") if isinstance(hso3, dict) else ""
        assert "refire_test.py" in ctx3 or "```diff" in ctx3, (
            f"After structurally different edit, diff hint should re-fire; got: {ctx3!r}"
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
        from token_goat import db, hooks_edit, hooks_read, snapshots  # noqa: F401

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
        # _post_edit_sync joins the daemon thread so no sleep is needed.
        _assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(main_py)},
            "cwd": str(tmp_path),
        }))

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
