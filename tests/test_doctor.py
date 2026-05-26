"""Smoke tests for `token-goat doctor`."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from typer.testing import CliRunner

from token_goat import cli, paths

runner = CliRunner()


def test_doctor_exits_zero_and_prints_sections():
    result = subprocess.run(
        [sys.executable, "-m", "token_goat.cli", "doctor"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    out = result.stdout
    assert "Python:" in out
    assert "SQLite" in out
    assert "Project" in out
    # Worker self-heal + queue diagnostics added alongside the watchdog work.
    assert "claim file" in out
    assert "index marker" in out  # "index markers: none" or per-marker "index marker:"
    assert "Dirty queue" in out


def test_doctor_via_entry_point():
    """Run via the installed entry point (uv tool run)."""
    result = subprocess.run(
        ["uv", "run", "token-goat", "doctor"],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(Path(__file__).parent.parent),
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "token-goat doctor" in result.stdout


def test_doctor_fix_reaps_stale_index_markers(tmp_data_dir):
    """`doctor --fix` clears stale `.indexing` markers but spares active ones.

    This is the on-demand counterpart to the worker's startup reaping — it
    closes the gap that left 16 stale markers on disk with nothing to clear
    them while the worker was down.
    """
    paths.ensure_dirs()
    locks = paths.locks_dir()
    stale = locks / "stalehash.indexing"
    stale.write_text(f"999999999\n{time.time()}", encoding="utf-8")
    active = locks / "activehash.indexing"
    active.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    result = runner.invoke(cli.app, ["doctor", "--fix"])
    assert result.exit_code == 0, result.stdout
    assert "reaped" in result.stdout
    assert not stale.exists(), "stale marker should have been reaped"
    assert active.exists(), "an active index marker must not be reaped"


def test_doctor_without_fix_leaves_markers_untouched(tmp_data_dir):
    """Plain `doctor` only reports — it must not delete any markers."""
    paths.ensure_dirs()
    stale = paths.locks_dir() / "stalehash.indexing"
    stale.write_text(f"999999999\n{time.time()}", encoding="utf-8")

    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0, result.stdout
    assert "reaped" not in result.stdout
    assert stale.exists(), "doctor without --fix must not delete markers"


# ---------------------------------------------------------------------------
# Branch coverage for individual doctor checks (using CliRunner + mocks)
# ---------------------------------------------------------------------------


class TestDoctorBranches:
    """Cover specific error/warn branches that the subprocess smoke tests miss."""

    def _run(self, monkeypatch_fn=None, extra_args=None):
        args = ["doctor"] + (extra_args or [])
        return runner.invoke(cli.app, args)

    def test_token_goat_version_unknown_on_import_error(self, tmp_data_dir):
        """When the package metadata isn't found, version is shown as 'unknown'."""
        import importlib.metadata
        from unittest.mock import patch
        with patch.object(
            importlib.metadata,
            "version",
            side_effect=importlib.metadata.PackageNotFoundError("token-goat"),
        ):
            result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "unknown" in result.stdout

    def test_uv_not_found_shown_as_warn(self, tmp_data_dir):
        """When uv is not on PATH, doctor shows a WARN for it."""
        import subprocess as sp
        from unittest.mock import patch
        with patch.object(sp, "run", side_effect=FileNotFoundError("uv not found")):
            result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "[WARN]" in result.stdout or "WARN" in result.stdout

    def test_pid_alive_fresh_heartbeat(self, tmp_data_dir):
        """PID exists and heartbeat is fresh → ok lines for both."""

        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        paths.worker_heartbeat_path().write_text("x", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert str(pid) in result.stdout

    def test_pid_alive_stale_heartbeat(self, tmp_data_dir):
        """PID exists but heartbeat is old → WARN stale."""
        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        hb = paths.worker_heartbeat_path()
        hb.write_text("x", encoding="utf-8")
        os.utime(hb, (0.0, 0.0))  # epoch → ancient

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "stale" in result.stdout

    def test_pid_alive_missing_heartbeat(self, tmp_data_dir):
        """PID exists but no heartbeat file → WARN missing."""
        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        # No heartbeat file written

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "missing" in result.stdout or "heartbeat" in result.stdout.lower()

    def test_dead_pid_shown_as_warn(self, tmp_data_dir):
        """PID file present but process is gone → WARN."""
        paths.ensure_dirs()
        paths.worker_pid_path().write_text("99999999", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "99999999" in result.stdout

    def test_dirty_queue_empty_file(self, tmp_data_dir):
        """Queue file exists but has no non-blank lines → depth 0."""
        paths.ensure_dirs()
        paths.dirty_queue_path().write_text("   \n\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "0" in result.stdout

    def test_dirty_queue_moderate_depth(self, tmp_data_dir):
        """Queue with < 200 entries shows depth + 'pending' message."""
        paths.ensure_dirs()
        import json as _json
        lines = "\n".join(_json.dumps({"path": f"f{i}.py"}) for i in range(10))
        paths.dirty_queue_path().write_text(lines + "\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "pending" in result.stdout

    def test_dirty_queue_large_depth_warns(self, tmp_data_dir):
        """Queue with >= 200 entries triggers a WARN."""
        paths.ensure_dirs()
        import json as _json
        lines = "\n".join(_json.dumps({"path": f"f{i}.py"}) for i in range(250))
        paths.dirty_queue_path().write_text(lines + "\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "250" in result.stdout

    def test_stats_contention_events_shown(self, tmp_data_dir):
        """When session-cache contention events exist, doctor flags them."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        with _db.open_global() as conn:
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (int(_time.time()), "session_cache_unavailable", 0, 0),
            )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "contention" in result.stdout

    def test_stats_no_events(self, tmp_data_dir):
        """When stats table is empty, doctor shows 'no recorded savings yet'."""
        paths.ensure_dirs()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "no recorded savings yet" in result.stdout

    def test_compaction_utilization_section_no_data(self, tmp_data_dir):
        """Compaction utilization section appears even when there are no rows."""
        paths.ensure_dirs()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Compaction utilization" in result.stdout

    def test_compaction_utilization_renders_percentiles(self, tmp_data_dir):
        """compact_manifest rows are parsed into p50/p95/max percentages."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        now = int(_time.time())
        # Five manual emits with utilizations 50%, 60%, 70%, 80%, 90%.
        rows = [
            ("budget=500,actual=250,trigger=manual,events=10", 50),
            ("budget=500,actual=300,trigger=manual,events=10", 60),
            ("budget=500,actual=350,trigger=manual,events=10", 70),
            ("budget=500,actual=400,trigger=manual,events=10", 80),
            ("budget=500,actual=450,trigger=auto,events=10", 90),
        ]
        with _db.open_global() as conn:
            for detail, _pct in rows:
                conn.execute(
                    "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (now, "compact_manifest", 0, 0, detail),
                )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        assert "Compaction utilization" in result.stdout
        # The 5-row series spans 50%-90% — the line should report multiple
        # emits and surface p95/max in the upper band.
        assert "emits" in result.stdout
        # Trigger breakdown — both manual and auto rows should render.
        assert "manual trigger" in result.stdout
        assert "auto trigger" in result.stdout

    def test_compaction_utilization_warns_on_high_p95(self, tmp_data_dir):
        """When p95 exceeds 95%, doctor flags an over-utilization warning."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        now = int(_time.time())
        # 10 emits all at ~97% utilization — clear truncation signal.
        with _db.open_global() as conn:
            for _i in range(10):
                conn.execute(
                    "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (now, "compact_manifest", 0, 0,
                     "budget=500,actual=487,trigger=manual,events=20"),
                )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        assert "raising compact_assist.max_manifest_tokens" in result.stdout

    def test_compaction_utilization_warns_on_low_p95(self, tmp_data_dir):
        """When p95 is below 30% with enough samples, doctor flags waste."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        now = int(_time.time())
        # 10 emits all at ~10% utilization — manifest is rattling around.
        with _db.open_global() as conn:
            for _i in range(10):
                conn.execute(
                    "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (now, "compact_manifest", 0, 0,
                     "budget=4000,actual=400,trigger=manual,events=5"),
                )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        assert "lowering compact_assist.max_manifest_tokens" in result.stdout

    def test_compaction_utilization_ignores_malformed_detail(self, tmp_data_dir):
        """Rows with corrupted detail strings are skipped, not crash doctor."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        now = int(_time.time())
        with _db.open_global() as conn:
            # Mix of valid and malformed rows.
            for detail in (
                "budget=500,actual=250,trigger=manual,events=10",
                "",  # empty
                "garbage",  # no key-value pairs
                "budget=abc,actual=xyz",  # non-integer
                "budget=0,actual=100",  # zero budget skipped
                "budget=500,actual=250,trigger=manual",  # valid
            ):
                conn.execute(
                    "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (now, "compact_manifest", 0, 0, detail),
                )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        # Two valid 50% rows should yield p50=50%.
        assert "Compaction utilization" in result.stdout
        assert "2" in result.stdout  # at least the emit count survives

    def test_doctor_does_not_create_global_db(self, tmp_data_dir):
        """doctor must not create global.db as a side effect of diagnosing.

        Reading stats through open_global() (read-write) creates the file when
        absent and runs PRAGMA integrity_check — multi-second on a large
        production global.db, which timed out the doctor subprocess smoke tests
        under full-suite load. open_global_readonly() does neither.
        """
        paths.ensure_dirs()
        assert not paths.global_db_path().exists()  # precondition: no DB yet

        result = runner.invoke(cli.app, ["doctor"])

        assert result.exit_code == 0, result.stdout
        assert "no recorded savings yet" in result.stdout
        assert not paths.global_db_path().exists(), (
            "doctor created global.db — stats must be read via open_global_readonly()"
        )

    def test_project_db_file_count_zero_shows_not_yet_indexed(self, tmp_data_dir, tmp_path):
        """Project found but file_count == 0 → '(not yet indexed)' label."""
        (tmp_path / ".git").mkdir()
        import os as _os
        orig_cwd = _os.getcwd()
        try:
            _os.chdir(tmp_path)
            result = runner.invoke(cli.app, ["doctor"])
        finally:
            _os.chdir(orig_cwd)

        assert result.exit_code == 0
        assert "not yet indexed" in result.stdout

    def test_claim_file_stale_warns(self, tmp_data_dir):
        """Stale claim file (dead PID) shows a WARN."""
        from token_goat import worker as _worker
        paths.ensure_dirs()
        claim = _worker._worker_claim_path()
        claim.write_text("99999999\n0.0", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "stale" in result.stdout

    def test_claim_file_live_pid_shown(self, tmp_data_dir):
        """Live-PID claim file shows the PID in the output."""
        from token_goat import worker as _worker
        paths.ensure_dirs()
        claim = _worker._worker_claim_path()
        pid = os.getpid()
        # Claim file format: "pid\ncreate_time" — use actual process creation
        # time so _worker_claim_is_stale does not flag this as recycled.
        try:
            import psutil
            create_time = psutil.Process(pid).create_time()
        except Exception:
            create_time = 0.0
        claim.write_text(f"{pid}\n{create_time}", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert str(pid) in result.stdout


class TestDoctorConfigurationSection:
    """Lock down the Configuration section so every opt-in flag stays visible.

    Run 1-5 added a stream of config-toggleable features (session_brief,
    image_shrink AVIF/JPEG fallback + decompression-bomb cap, curator,
    hint_budget, repomap compact threshold, stats record_zero_savings,
    webfetch allow/deny).  All of them are reachable via ``token-goat
    config show``, but doctor is the surface that flags "is feature X
    actually on for this install?".  A missing line here means a user
    debugging a misbehaving feature has to grep config.toml by hand —
    exactly the failure mode the section exists to prevent.

    The Configuration block was previously untested (see the doctor smoke
    suite above), so this class establishes the contract: every top-level
    config dataclass field that controls user-observable behaviour must be
    surfaced.
    """

    def test_configuration_lists_every_opt_in_feature(self, tmp_data_dir):
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        # One representative field per config section.  If a future refactor
        # drops a section from doctor, exactly one of these assertions fires
        # and points at the missing surface.
        required_labels = [
            "Configuration",  # the section header itself
            "compact_assist.enabled",  # CompactAssistConfig
            "compact_assist.auto_trigger_multiplier",
            "compact_assist.max_manifest_tokens",
            "skill_preservation.enabled",  # SkillPreservationConfig
            "hints.json_sidecar",  # HintsConfig
            "hints.suppress_after_ignored",
            "bash_compress.enabled",  # BashCompressConfig
            "bash_compress.max_lines",
            "session_brief.enabled",  # SessionBriefConfig
            "image_shrink.prefer_avif",  # ImageShrinkConfig
            "image_shrink.avif_quality",
            "image_shrink.jpeg_quality",
            "image_shrink.max_image_pixels",
            "curator.enabled",  # CuratorConfig
            "curator.min_samples",
            "curator.threshold_pct",
            "hint_budget.enabled",  # HintBudgetConfig
            "hint_budget.max_per_session",
            "hint_budget.max_structured_per_session",
            "hint_budget.max_index_only_per_session",
            "repomap.compact_file_threshold",  # RepomapConfig
            "stats.record_zero_savings",  # StatsConfig
            "webfetch.allow",  # WebFetchConfig
            "webfetch.deny",
            "decision_log.max_per_session",  # session.DECISION_HISTORY_MAX
        ]
        missing = [lbl for lbl in required_labels if lbl not in result.stdout]
        assert not missing, (
            f"doctor Configuration block is missing {missing}; if a config "
            f"section was intentionally removed, drop the corresponding "
            f"assertion. Full output:\n{result.stdout}"
        )

    def test_webfetch_allowlist_count_shown_not_contents(self, tmp_data_dir):
        """Doctor must NOT leak full URL allow/deny lists.

        The list contents may contain sensitive internal hostnames that a
        user could accidentally paste into a public bug report.  Showing
        only the count keeps the diagnostic useful without the disclosure
        risk.  This test would catch a future "helpful" change that prints
        the patterns verbatim.
        """
        from unittest.mock import patch

        from token_goat import config as _config

        cfg = _config.Config()
        cfg.webfetch.allow = ["https://internal.example.com/*"]
        cfg.webfetch.deny = ["https://leak.example.com/*"]
        with patch.object(_config, "load", return_value=cfg):
            result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0, result.stdout
        assert "webfetch.allow" in result.stdout
        assert "1 pattern" in result.stdout
        # The actual URL must NOT appear in the doctor output.
        assert "internal.example.com" not in result.stdout
        assert "leak.example.com" not in result.stdout
