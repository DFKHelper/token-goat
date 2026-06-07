"""Tests for serve_diff_on_reread: intercept re-read of changed file and serve diff.

Covers:
- serve_diff_on_reread=True causes pre_read to deny the Read and serve a unified
  diff in additionalContext when the file has a snapshot and has changed.
- serve_diff_on_reread=False (default) leaves existing behavior unchanged.
- diff_served stat is recorded with bytes_saved = file_size - diff_size.
- No diff served when diff >= 50% of file size (large-change guard).
- No diff served when no snapshot exists.
"""
from __future__ import annotations

from unittest.mock import patch

from hook_helpers import (
    assert_continue,
    assert_deny,
    assert_well_formed_unified_diff,
    extract_diff_block,
)
from hook_helpers import post_edit_sync as _post_edit_sync

from token_goat import config as cfg_mod
from token_goat import hooks_read, session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config_with_serve_diff(enabled: bool) -> cfg_mod.Config:
    """Return a Config with hints.serve_diff_on_reread set to *enabled*."""
    base = cfg_mod.load()
    # Build a fresh HintsConfig with serve_diff_on_reread toggled.
    from dataclasses import replace
    new_hints = replace(base.hints, serve_diff_on_reread=enabled)
    return replace(base, hints=new_hints)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestServeDiffOnReread:
    def test_default_disabled_falls_through_to_diff_hint(self, tmp_data_dir, tmp_path):
        """When serve_diff_on_reread is False (default), the existing diff-hint path fires."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        original = "VERSION = 1\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "serve-diff-disabled"

        # 1. Read — populates snapshot.
        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. Edit.
        src.write_text("VERSION = 2\n" + body, encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read — serve_diff_on_reread=False by default: hint fires, Read NOT denied.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        # Must NOT be a deny response.
        assert hso.get("permissionDecision") != "deny", (
            "Read should NOT be denied when serve_diff_on_reread=False"
        )

    def test_serve_diff_enabled_denies_read_and_serves_diff(self, tmp_data_dir, tmp_path):
        """When enabled, pre_read denies the Read and serves a unified diff."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "service.py"
        body = "".join(f"class Handler{i}:\n    pass\n" for i in range(150))
        original = "VERSION = 1\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "serve-diff-enabled"

        # 1. Read — populates snapshot.
        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. Edit (small change).
        src.write_text("VERSION = 2\n" + body, encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read with serve_diff_on_reread=True.
        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_continue(result)
        assert_deny(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        assert "```diff" in ctx, f"Expected diff block in context, got: {ctx[:200]!r}"
        assert "VERSION" in ctx, f"Expected changed field in diff, got: {ctx[:200]!r}"

    def test_serve_diff_records_diff_served_stat(self, tmp_data_dir, tmp_path):
        """diff_served stat is recorded when the diff is served."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "models.py"
        body = "".join(f"class Model{i}:\n    id = {i}\n" for i in range(150))
        original = "SCHEMA = 'v1'\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "serve-diff-stat"

        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        src.write_text("SCHEMA = 'v2'\n" + body, encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        stat_calls: list[tuple] = []

        from token_goat import db as db_mod

        original_record = db_mod.record_stat

        def _capture_stat(project_root, kind, *, bytes_saved=0, tokens_saved=0, detail=""):
            stat_calls.append((project_root, kind, bytes_saved, tokens_saved, detail))
            return original_record(project_root, kind, bytes_saved=bytes_saved,
                                   tokens_saved=tokens_saved, detail=detail)

        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg), \
             patch.object(db_mod, "record_stat", side_effect=_capture_stat):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_deny(result)
        diff_served_calls = [(k, bs) for _, k, bs, _, _ in stat_calls if k == "diff_served"]
        assert diff_served_calls, (
            f"Expected at least one 'diff_served' stat; got: {stat_calls}"
        )
        kind, bytes_saved = diff_served_calls[0]
        assert bytes_saved > 0, f"Expected bytes_saved > 0, got {bytes_saved}"

    def test_no_diff_served_when_no_snapshot(self, tmp_data_dir, tmp_path):
        """When no snapshot exists, serve_diff_on_reread falls through (no deny)."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "utils.py"
        body = "".join(f"def util_{i}():\n    pass\n" for i in range(150))
        src.write_text(body, encoding="utf-8")

        sid = "serve-diff-no-snap"

        # Mark file as edited but do NOT post_read (no snapshot stored).
        session.mark_file_edited(sid, str(src))

        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny", (
            "Read should NOT be denied when no snapshot exists"
        )

    def test_no_diff_served_when_diff_too_large(self, tmp_data_dir, tmp_path):
        """When the diff is >= 50% of the file, serve_diff_on_reread falls through."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "large_change.py"
        # Write an original file that will undergo a near-total replacement.
        original_lines = [f"line_{i} = {i}\n" for i in range(100)]
        original = "".join(original_lines)
        src.write_text(original, encoding="utf-8")

        sid = "serve-diff-large-change"

        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # Replace every line — nearly 100% diff.
        new_lines = [f"replaced_{i} = {i * 2}\n" for i in range(100)]
        src.write_text("".join(new_lines), encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_continue(result)
        # When diff is too large, the Read should NOT be denied — either a
        # diff hint fires (additionalContext without deny) or no hint at all.
        hso = result.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny", (
            "Read should NOT be denied when diff is too large (>= 50% of file)"
        )

    def test_serve_diff_uses_unified_diff_format(self, tmp_data_dir, tmp_path):
        """The served diff uses standard unified diff format with +/- lines."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "config.py"
        body = "".join(f"SETTING_{i} = {i}\n" for i in range(200))
        original = "DEBUG = False\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "serve-diff-format"

        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        src.write_text("DEBUG = True\n" + body, encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_deny(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        # Unified diff has "---" and "+++" headers.
        assert "---" in ctx, "Expected unified diff '---' header in context"
        assert "+++" in ctx, "Expected unified diff '+++' header in context"
        # Changed lines.
        assert "-DEBUG = False" in ctx or "DEBUG = False" in ctx
        assert "+DEBUG = True" in ctx or "DEBUG = True" in ctx

    def test_served_diff_is_well_formed(self, tmp_data_dir, tmp_path):
        """Regression: the served diff must be a structurally valid unified diff.

        Guards against mixing ``splitlines(keepends=True)`` with ``lineterm=""``
        and ``"\\n".join`` — that combination double-counts newlines and renders
        a doubled blank line after every content row. The fixture changes three
        well-separated lines (multi-hunk) and contains no blank content lines, so
        any empty interior line in the rendered diff is the doubled-newline bug.
        """
        (tmp_path / ".git").mkdir()
        src = tmp_path / "settings.py"
        # 200 distinct, non-blank lines so a multi-hunk diff stays well under the
        # 50%-of-file large-change guard.
        lines = [f"OPTION_{i} = {i}\n" for i in range(200)]
        src.write_text("".join(lines), encoding="utf-8")

        sid = "serve-diff-well-formed"

        assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # Change three widely separated lines → three distinct hunks.
        lines[0] = "OPTION_0 = 999\n"
        lines[100] = "OPTION_100 = 999\n"
        lines[199] = "OPTION_199 = 999\n"
        src.write_text("".join(lines), encoding="utf-8")
        assert_continue(_post_edit_sync({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        fake_cfg = _make_config_with_serve_diff(True)
        with patch.object(cfg_mod, "load", return_value=fake_cfg):
            result = hooks_read.pre_read({
                "session_id": sid,
                "tool_name": "Read",
                "tool_input": {"file_path": str(src)},
                "cwd": str(tmp_path),
            })

        assert_deny(result)
        ctx = (result.get("hookSpecificOutput") or {}).get("additionalContext", "")
        diff_block = extract_diff_block(ctx)
        assert_well_formed_unified_diff(diff_block)
        # Three separate hunks → three "@@" header lines, each on its own line.
        assert diff_block.count("@@ ") >= 3, (
            f"expected >=3 hunk headers, got: {diff_block!r}"
        )
