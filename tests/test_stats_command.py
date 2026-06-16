"""Tests for `token-goat stats --session-id / --global` and get_compression_stats()."""
from __future__ import annotations

import json
import time

from typer.testing import CliRunner

from token_goat import cli
from token_goat import db as _db

runner = CliRunner()


# ---------------------------------------------------------------------------
# get_compression_stats() unit tests
# ---------------------------------------------------------------------------

class TestGetCompressionStats:

    def test_empty_db_returns_zero_counts(self, tmp_data_dir):
        # No stats rows exist; every field must be 0 and no error raised.
        result = _db.get_compression_stats()
        assert result["tokens_saved"] == 0
        assert result["outputs_compressed"] == 0
        assert result["reread_denies"] == 0
        assert result["images_shrunk"] == 0
        assert result["top_filters"] == []

    def test_all_expected_keys_present(self, tmp_data_dir):
        result = _db.get_compression_stats()
        assert set(result) == {"tokens_saved", "outputs_compressed", "reread_denies", "images_shrunk", "top_filters"}

    def test_bash_output_cached_counted(self, tmp_data_dir):
        _db.record_stat(None, "bash_output_cached", tokens_saved=100, bytes_saved=400, detail="pytest")
        _db.record_stat(None, "bash_output_cached", tokens_saved=200, bytes_saved=800, detail="pytest")
        result = _db.get_compression_stats()
        assert result["outputs_compressed"] == 2
        assert result["tokens_saved"] >= 300

    def test_reread_deny_counted(self, tmp_data_dir):
        _db.record_stat(None, "reread_deny", tokens_saved=50, bytes_saved=200, detail="src/foo.py")
        result = _db.get_compression_stats()
        assert result["reread_denies"] == 1

    def test_image_shrink_and_cache_hit_both_counted(self, tmp_data_dir):
        _db.record_stat(None, "image_shrink", tokens_saved=80, bytes_saved=320)
        _db.record_stat(None, "image_shrink_cache_hit", tokens_saved=80, bytes_saved=320)
        result = _db.get_compression_stats()
        assert result["images_shrunk"] == 2

    def test_overhead_rows_excluded_from_tokens_saved(self, tmp_data_dir):
        _db.record_stat(None, "reread_deny", tokens_saved=100, bytes_saved=400)
        _db.record_stat(None, "reread_deny_overhead", tokens_saved=-10, bytes_saved=-40)
        result = _db.get_compression_stats()
        # overhead row is negative and excluded; only the positive row counts
        assert result["tokens_saved"] == 100

    def test_top_filters_sorted_desc(self, tmp_data_dir):
        _db.record_stat(None, "symbol_read", tokens_saved=500, bytes_saved=2000)
        _db.record_stat(None, "reread_deny", tokens_saved=300, bytes_saved=1200)
        _db.record_stat(None, "bash_output_cached", tokens_saved=100, bytes_saved=400)
        result = _db.get_compression_stats()
        filters = result["top_filters"]
        assert len(filters) <= 3
        # Must be in descending order of tokens_saved
        for i in range(len(filters) - 1):
            assert filters[i]["tokens_saved"] >= filters[i + 1]["tokens_saved"]
        assert filters[0]["filter"] == "symbol_read"

    def test_session_scoping_excludes_old_events(self, tmp_data_dir):
        # Seed a stat row in the past, then create a session starting after it.
        _db.record_stat(None, "reread_deny", tokens_saved=999, bytes_saved=3996)
        # Build a session with started_ts in the future relative to the seeded row.
        from token_goat import paths as paths_mod
        from token_goat import session as session_mod
        sid = "aabbccdd11223344aabbccdd11223344"
        future_ts = time.time() + 3600
        cache = session_mod.SessionCache(session_id=sid, started_ts=future_ts, last_activity_ts=future_ts)
        sessions_dir = paths_mod.data_dir() / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        (sessions_dir / f"{sid}.json").write_text(cache.to_json(), encoding="utf-8")
        session_mod._proc_load_cache.pop(sid, None)

        result = _db.get_compression_stats(session_id=sid)
        # The row was inserted before session started_ts, so it must be excluded.
        assert result["reread_denies"] == 0
        assert result["tokens_saved"] == 0

    def test_session_none_returns_alltime(self, tmp_data_dir):
        _db.record_stat(None, "reread_deny", tokens_saved=42, bytes_saved=168)
        result = _db.get_compression_stats(session_id=None)
        assert result["reread_denies"] == 1
        assert result["tokens_saved"] == 42


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------

class TestStatsCLI:

    def test_global_flag_exits_zero_empty_db(self, tmp_data_dir):
        result = runner.invoke(cli.app, ["stats", "--global"])
        assert result.exit_code == 0

    def test_global_flag_shows_all_four_metrics(self, tmp_data_dir):
        result = runner.invoke(cli.app, ["stats", "--global"])
        assert "Bash outputs compressed" in result.stdout
        assert "Estimated tokens saved" in result.stdout
        assert "Reread denies" in result.stdout
        assert "Images shrunk" in result.stdout

    def test_json_flag_with_global_returns_valid_json(self, tmp_data_dir):
        result = runner.invoke(cli.app, ["stats", "--global", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "tokens_saved" in data
        assert "outputs_compressed" in data
        assert "reread_denies" in data
        assert "images_shrunk" in data
        assert "top_filters" in data

    def test_global_shows_nonzero_after_seeding(self, tmp_data_dir):
        _db.record_stat(None, "bash_output_cached", tokens_saved=77, bytes_saved=308)
        _db.record_stat(None, "reread_deny", tokens_saved=33, bytes_saved=132)
        result = runner.invoke(cli.app, ["stats", "--global"])
        assert result.exit_code == 0
        assert "77" in result.stdout or "110" in result.stdout  # tokens_saved total

    def test_session_id_flag_with_valid_session(self, tmp_data_dir):
        from token_goat import paths as paths_mod
        from token_goat import session as session_mod
        sid = "ccddee00112233ccddee001122334455"
        ts = time.time()
        cache = session_mod.SessionCache(session_id=sid, started_ts=ts, last_activity_ts=ts)
        sessions_dir = paths_mod.data_dir() / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        (sessions_dir / f"{sid}.json").write_text(cache.to_json(), encoding="utf-8")
        session_mod._proc_load_cache.pop(sid, None)

        result = runner.invoke(cli.app, ["stats", "--session-id", sid])
        assert result.exit_code == 0
        assert "Token savings" in result.stdout

    def test_no_flags_falls_through_to_full_stats(self, tmp_data_dir):
        # Without --global or --session-id, existing full stats path runs (no crash).
        result = runner.invoke(cli.app, ["stats"])
        assert result.exit_code == 0

    def test_global_option_is_functional(self, tmp_data_dir):
        # Verifies --global is registered and accepted (not a help-text parse).
        result = runner.invoke(cli.app, ["stats", "--global"])
        assert result.exit_code == 0
