"""Coverage iteration 325: tests for env_float (util.py), _is_noop_bash_command (compact.py),
and cache_common helpers load_output_text / load_output_meta_stat / list_cache_outputs.

All three function groups had zero test coverage prior to this file.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# 1. util.env_float — completely untested
# ---------------------------------------------------------------------------


class TestEnvFloat:
    """env_float: parse float from env var with clamping and fallback."""

    def test_unset_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When the env var is not set, env_float returns the default."""
        monkeypatch.delenv("TG_TEST_FLOAT", raising=False)
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 3.14) == pytest.approx(3.14)

    def test_empty_string_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An empty-string env var falls back to default."""
        monkeypatch.setenv("TG_TEST_FLOAT", "")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 1.0) == pytest.approx(1.0)

    def test_whitespace_only_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A whitespace-only value falls back to default."""
        monkeypatch.setenv("TG_TEST_FLOAT", "   ")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 2.5) == pytest.approx(2.5)

    def test_non_numeric_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A non-numeric value falls back to default."""
        monkeypatch.setenv("TG_TEST_FLOAT", "not-a-number")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 9.9) == pytest.approx(9.9)

    def test_valid_float_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A valid float string is parsed correctly."""
        monkeypatch.setenv("TG_TEST_FLOAT", "2.0")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 1.0) == pytest.approx(2.0)

    def test_integer_value_parsed_as_float(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An integer string is accepted and returned as float."""
        monkeypatch.setenv("TG_TEST_FLOAT", "5")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 0.0)
        assert result == pytest.approx(5.0)
        assert isinstance(result, float)

    def test_value_below_lo_is_clamped_to_lo(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A value below lo is clamped to lo."""
        monkeypatch.setenv("TG_TEST_FLOAT", "0.1")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 1.0, lo=0.5)
        assert result == pytest.approx(0.5)

    def test_value_above_hi_is_clamped_to_hi(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A value above hi is clamped to hi."""
        monkeypatch.setenv("TG_TEST_FLOAT", "100.0")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 1.0, hi=10.0)
        assert result == pytest.approx(10.0)

    def test_value_at_lo_boundary_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A value exactly at lo is accepted unchanged."""
        monkeypatch.setenv("TG_TEST_FLOAT", "0.5")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 1.0, lo=0.5, hi=2.0)
        assert result == pytest.approx(0.5)

    def test_value_at_hi_boundary_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A value exactly at hi is accepted unchanged."""
        monkeypatch.setenv("TG_TEST_FLOAT", "2.0")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 1.0, lo=0.5, hi=2.0)
        assert result == pytest.approx(2.0)

    def test_no_bounds_value_in_range(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When no bounds are set, value is returned as-is."""
        monkeypatch.setenv("TG_TEST_FLOAT", "99.9")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 1.0) == pytest.approx(99.9)

    def test_leading_trailing_whitespace_stripped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Leading/trailing whitespace in the env value is stripped before parsing."""
        monkeypatch.setenv("TG_TEST_FLOAT", "  3.14  ")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 0.0) == pytest.approx(3.14)

    def test_negative_value_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Negative float values are parsed correctly."""
        monkeypatch.setenv("TG_TEST_FLOAT", "-1.5")
        from token_goat.util import env_float

        assert env_float("TG_TEST_FLOAT", 0.0) == pytest.approx(-1.5)

    def test_very_large_exponent_returns_inf(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Python parses '1e999...' as inf (not OverflowError), so env_float returns inf.

        This documents the actual behavior: env_float does not special-case inf.
        Callers that need finite values should supply an ``hi`` bound.
        """
        import math

        monkeypatch.setenv("TG_TEST_FLOAT", "1e999999999999")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 42.0)
        assert math.isinf(result)

    def test_hi_bound_clamps_inf_to_hi(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When a hi bound is supplied, inf is clamped to hi."""
        monkeypatch.setenv("TG_TEST_FLOAT", "1e999999999999")
        from token_goat.util import env_float

        result = env_float("TG_TEST_FLOAT", 42.0, hi=100.0)
        assert result == pytest.approx(100.0)


# ---------------------------------------------------------------------------
# 2. compact._is_noop_bash_command — completely untested
# ---------------------------------------------------------------------------


class _FakeEntry:
    """Minimal stub implementing the duck-typed bash entry interface."""

    def __init__(self, cmd_preview: str, stdout_bytes: int = 0, stderr_bytes: int = 0) -> None:
        self.cmd_preview = cmd_preview
        self.stdout_bytes = stdout_bytes
        self.stderr_bytes = stderr_bytes


class TestIsNoopBashCommand:
    """_is_noop_bash_command: filters out status/navigation commands from manifest."""

    def _call(self, cmd: str) -> bool:
        from token_goat.compact import _is_noop_bash_command

        return _is_noop_bash_command(_FakeEntry(cmd))

    def test_empty_cmd_preview_not_noop(self) -> None:
        """An entry with no cmd_preview is not a no-op (False, not filtered)."""
        assert self._call("") is False

    def test_short_command_is_noop(self) -> None:
        """Commands shorter than 5 chars are classified as no-ops."""
        assert self._call("ls") is True
        assert self._call("pwd") is True
        assert self._call("cd") is True

    def test_git_status_exact_is_noop(self) -> None:
        """'git status' is a no-op."""
        assert self._call("git status") is True

    def test_git_status_with_flag_is_noop(self) -> None:
        """'git status --short' starts with 'git status' → no-op."""
        assert self._call("git status --short") is True

    def test_git_diff_stat_is_noop(self) -> None:
        """'git diff --stat' is a no-op."""
        assert self._call("git diff --stat") is True

    def test_git_log_prefix_is_noop(self) -> None:
        """'git log --oneline -5' starts with 'git log' → no-op."""
        assert self._call("git log --oneline -5") is True

    def test_echo_command_is_noop(self) -> None:
        """echo is listed as an inherently-silent no-op."""
        assert self._call("echo hello") is True

    def test_cd_command_is_noop(self) -> None:
        """cd is listed as inherently-silent."""
        assert self._call("cd /tmp/project") is True

    def test_pytest_is_not_noop(self) -> None:
        """pytest commands are not no-ops."""
        assert self._call("pytest tests/") is False

    def test_uv_run_pytest_is_not_noop(self) -> None:
        """uv run pytest is not a no-op."""
        assert self._call("uv run pytest -x") is False

    def test_rg_search_is_not_noop(self) -> None:
        """rg searches are not no-ops."""
        assert self._call("rg 'def load' src/") is False

    def test_missing_cmd_preview_attr_not_noop(self) -> None:
        """An object without cmd_preview returns False (not filtered)."""
        from token_goat.compact import _is_noop_bash_command

        class NoAttr:
            pass

        assert _is_noop_bash_command(NoAttr()) is False

    def test_none_entry_not_noop(self) -> None:
        """None entry returns False (no cmd_preview attribute)."""
        from token_goat.compact import _is_noop_bash_command

        assert _is_noop_bash_command(None) is False


# ---------------------------------------------------------------------------
# 3. cache_common: load_output_text, load_output_meta_stat, list_cache_outputs
# ---------------------------------------------------------------------------


def _make_cache_dir(tmp_path: Path) -> Path:
    """Return a fresh temporary cache directory."""
    d = tmp_path / "cache"
    d.mkdir()
    return d


def _write_cache_file(
    cache_dir: Path, output_id: str, content: str, mtime: float | None = None
) -> Path:
    """Write a .txt cache body file and optionally set its mtime."""
    p = cache_dir / f"{output_id}.txt"
    p.write_text(content, encoding="utf-8")
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


# A valid output_id that passes OUTPUT_FILENAME_RE (16-char session fragment + _ + content hash + _ + timestamp)
def _valid_output_id(n: int = 0) -> str:
    """Generate a valid output_id string that matches OUTPUT_FILENAME_RE."""
    # Pattern: <session_fragment(16)>_<hash(8)>_<ts(10)>
    ts = int(time.time()) + n
    return f"abcdef1234567890_cafebabe_{ts}"


class TestLoadOutputText:
    """load_output_text returns cached body or None; supports suffix fallback."""

    def test_returns_body_for_existing_full_id(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        oid = _valid_output_id()
        _write_cache_file(cache_dir, oid, "hello world")

        result = load_output_text(oid, lambda: cache_dir, "test_cache")
        assert result == "hello world"

    def test_returns_none_for_missing_id(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        oid = _valid_output_id()  # not written

        result = load_output_text(oid, lambda: cache_dir, "test_cache")
        assert result is None

    def test_suffix_fallback_single_match(self, tmp_path: Path) -> None:
        """When exact file is missing, load_output_text resolves via 8-char suffix."""
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        oid = _valid_output_id()
        _write_cache_file(cache_dir, oid, "suffix body")
        suffix = oid[-8:]  # last 8 chars

        # Pass only the suffix; exact file won't be found, fallback should work.
        result = load_output_text(suffix, lambda: cache_dir, "test_cache")
        assert result == "suffix body"

    def test_suffix_fallback_ambiguous_returns_none(self, tmp_path: Path) -> None:
        """Ambiguous suffix (multiple matches) returns None."""
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        # Build two output_ids with the same last 8 chars by sharing the tail
        ts = int(time.time())
        oid1 = f"aaaaaaaaaaaaaaaa_cafebabe_{ts}"
        oid2 = f"bbbbbbbbbbbbbbbb_cafebabe_{ts}"
        _write_cache_file(cache_dir, oid1, "body1")
        _write_cache_file(cache_dir, oid2, "body2")
        # last 8 chars of both will differ (different ts in theory); but create them
        # with same suffix explicitly
        common_suffix = "1234abcd"
        oid3 = f"cccccccccccccccc_00000000_{common_suffix}"
        oid4 = f"dddddddddddddddd_00000000_{common_suffix}"
        # Rewrite so stems end with common_suffix
        p3 = cache_dir / f"{oid3}.txt"
        p3.write_text("dup1", encoding="utf-8")
        p4 = cache_dir / f"{oid4}.txt"
        p4.write_text("dup2", encoding="utf-8")

        # Both oid3 and oid4 end with common_suffix
        result = load_output_text(common_suffix, lambda: cache_dir, "test_cache")
        assert result is None

    def test_returns_none_for_empty_output_id(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        result = load_output_text("", lambda: cache_dir, "test_cache")
        assert result is None

    def test_returns_none_for_traversal_id(self, tmp_path: Path) -> None:
        """An output_id with traversal chars (../etc) is rejected."""
        from token_goat.cache_common import load_output_text

        cache_dir = _make_cache_dir(tmp_path)
        result = load_output_text("../../../etc/passwd", lambda: cache_dir, "test_cache")
        assert result is None


class TestLoadOutputMetaStat:
    """load_output_meta_stat returns size/mtime dict or None."""

    def test_returns_dict_for_existing_file(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_meta_stat

        cache_dir = _make_cache_dir(tmp_path)
        oid = _valid_output_id()
        p = _write_cache_file(cache_dir, oid, "hello")

        result = load_output_meta_stat(oid, lambda: cache_dir, "test_cache")
        assert result is not None
        assert result["output_id"] == oid
        assert result["size_bytes"] == p.stat().st_size
        assert result["mtime"] == pytest.approx(p.stat().st_mtime, abs=1.0)

    def test_returns_none_for_missing_file(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_meta_stat

        cache_dir = _make_cache_dir(tmp_path)
        oid = _valid_output_id()  # not written

        result = load_output_meta_stat(oid, lambda: cache_dir, "test_cache")
        assert result is None

    def test_returns_none_for_invalid_id(self, tmp_path: Path) -> None:
        from token_goat.cache_common import load_output_meta_stat

        cache_dir = _make_cache_dir(tmp_path)
        result = load_output_meta_stat("../escape", lambda: cache_dir, "test_cache")
        assert result is None


class TestListCacheOutputs:
    """list_cache_outputs returns all .txt cache entries sorted newest first."""

    def test_empty_dir_returns_empty_list(self, tmp_path: Path) -> None:
        from token_goat.cache_common import list_cache_outputs

        cache_dir = _make_cache_dir(tmp_path)
        result = list_cache_outputs(lambda: cache_dir)
        assert result == []

    def test_missing_dir_returns_empty_list(self, tmp_path: Path) -> None:
        from token_goat.cache_common import list_cache_outputs

        # cache_dir_fn raises OSError when dir doesn't exist and isn't created
        # To get OSError, we pass a callable that raises
        def _raise() -> Path:
            raise OSError("no dir")

        result = list_cache_outputs(_raise)
        assert result == []

    def test_returns_entries_for_valid_files(self, tmp_path: Path) -> None:
        from token_goat.cache_common import list_cache_outputs

        cache_dir = _make_cache_dir(tmp_path)
        ts_old = time.time() - 100
        ts_new = time.time()
        oid_old = f"aaaaaaaaaaaaaaaa_oldoldol_{int(ts_old)}"
        oid_new = f"bbbbbbbbbbbbbbbb_newnewne_{int(ts_new)}"
        _write_cache_file(cache_dir, oid_old, "old content", mtime=ts_old)
        _write_cache_file(cache_dir, oid_new, "new content", mtime=ts_new)

        result = list_cache_outputs(lambda: cache_dir)
        assert len(result) == 2
        # Newest first
        assert result[0]["output_id"] == oid_new
        assert result[1]["output_id"] == oid_old

    def test_ignores_non_txt_files(self, tmp_path: Path) -> None:
        from token_goat.cache_common import list_cache_outputs

        cache_dir = _make_cache_dir(tmp_path)
        # A .json sidecar should not appear in the list
        sidecar = cache_dir / "somefile.json"
        sidecar.write_text("{}")
        oid = _valid_output_id()
        _write_cache_file(cache_dir, oid, "body")

        result = list_cache_outputs(lambda: cache_dir)
        assert len(result) == 1
        assert result[0]["output_id"] == oid

    def test_ignores_files_not_matching_output_filename_re(self, tmp_path: Path) -> None:
        """list_cache_outputs skips .txt files whose names contain spaces or dots
        (which fail OUTPUT_FILENAME_RE — pattern requires [a-zA-Z0-9_\\-]{1,80}.txt)."""
        from token_goat.cache_common import list_cache_outputs

        cache_dir = _make_cache_dir(tmp_path)
        # Files that DO NOT match OUTPUT_FILENAME_RE (spaces, dots in stem)
        (cache_dir / "file with spaces.txt").write_text("stuff")
        (cache_dir / "..evil.txt").write_text("evil")
        oid = _valid_output_id()
        _write_cache_file(cache_dir, oid, "valid body")

        result = list_cache_outputs(lambda: cache_dir)
        assert len(result) == 1
        assert result[0]["output_id"] == oid
