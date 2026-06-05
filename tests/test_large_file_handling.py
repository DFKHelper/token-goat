"""Tests for large-file handling: skip threshold, symbol-only threshold, config, and --report-large."""
from __future__ import annotations

import shutil
from pathlib import Path
from unittest.mock import patch

from token_goat.config import IndexingConfig
from token_goat.config import load as load_config
from token_goat.parser import (
    LargeFileInfo,
    index_file,
    index_project,
    iter_source_files,
)
from token_goat.project import Project, canonicalize, project_hash

FIXTURE_DIR = Path(__file__).parent / "fixtures"
PY_SAMPLE = FIXTURE_DIR / "py_sample"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_project(root: Path) -> Project:
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


# tlp.process() is O(n²) in file size — keep fixtures just above their threshold.
# 3× threshold → 9× parse time (measured: 648 KB = 26.4 s, 207 KB ≈ 1.5 s).
_FIXTURE_ABOVE_200KB = 207_000   # just above 200 KB (204_800 bytes)
_FIXTURE_ABOVE_100KB = 104_000   # just above 100 KB (102_400 bytes)


def _write_py(path: Path, size_bytes: int) -> None:
    """Write a valid-looking Python file of approximately *size_bytes* bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Header with real function to ensure symbol extraction succeeds
    header = "def placeholder():\n    pass\n\n"
    padding_needed = max(0, size_bytes - len(header.encode()))
    # Pad with comment lines so the file is syntactically valid
    pad = "# " + "x" * 78 + "\n"
    reps = (padding_needed // len(pad)) + 1
    content = header + pad * reps
    path.write_text(content[:size_bytes] if len(content) > size_bytes else content, encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. File > skip_kb is skipped entirely
# ---------------------------------------------------------------------------

def test_oversized_file_skipped_by_iter_source_files(tmp_path, tmp_data_dir):
    """iter_source_files with a low skip_threshold should not yield oversized files."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    small = root / "small.py"
    small.write_text("def ok(): pass\n", encoding="utf-8")

    big = root / "big.py"
    _write_py(big, 100_000)  # 100 KB

    proj = _make_project(root)
    # skip_threshold = 50 KB — big.py should be excluded
    files = list(iter_source_files(proj, skip_threshold=50_000))
    rel_names = {f.name for f in files}
    assert "small.py" in rel_names
    assert "big.py" not in rel_names


def test_oversized_file_included_above_threshold(tmp_path, tmp_data_dir):
    """iter_source_files with a high skip_threshold should yield all files."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    big = root / "big.py"
    _write_py(big, 100_000)

    proj = _make_project(root)
    files = list(iter_source_files(proj, skip_threshold=200_000))
    assert any(f.name == "big.py" for f in files)


# ---------------------------------------------------------------------------
# 2. File > symbol_only_kb gets symbol_only=True on FileIndex
# ---------------------------------------------------------------------------

def test_index_file_symbol_only_flag_set(tmp_path, tmp_data_dir):
    """index_file sets symbol_only=True when file exceeds symbol_only_threshold."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    big = root / "large.py"
    _write_py(big, 150_000)  # 150 KB

    proj = _make_project(root)
    fi = index_file(proj, big, symbol_only_threshold=100_000)
    assert fi is not None
    assert fi.symbol_only is True
    # Symbols should still be present (symbol-only means no embeddings, not no symbols)
    assert len(fi.symbols) > 0


def test_index_file_symbol_only_not_set_below_threshold(tmp_path, tmp_data_dir):
    """index_file does NOT set symbol_only when file is below the threshold."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    small = root / "small.py"
    small.write_text("def foo(): pass\n", encoding="utf-8")

    proj = _make_project(root)
    fi = index_file(proj, small, symbol_only_threshold=100_000)
    assert fi is not None
    assert fi.symbol_only is False


def test_index_file_symbol_only_disabled_when_threshold_zero(tmp_path, tmp_data_dir):
    """symbol_only_threshold=0 disables the feature (default behaviour)."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    big = root / "big.py"
    _write_py(big, 150_000)

    proj = _make_project(root)
    fi = index_file(proj, big, symbol_only_threshold=0)
    assert fi is not None
    assert fi.symbol_only is False


# ---------------------------------------------------------------------------
# 3. index_project carries large_files in result
# ---------------------------------------------------------------------------

def test_index_project_large_files_in_result(tmp_path, tmp_data_dir):
    """index_project returns large_files list with symbol-only entries."""
    root = tmp_path / "proj"
    shutil.copytree(PY_SAMPLE, root)
    (root / ".git").mkdir(exist_ok=True)

    big = root / "huge.py"
    _write_py(big, _FIXTURE_ABOVE_200KB)  # above the 200 KB threshold used by mock_cfg

    proj = _make_project(root)

    # Patch config to return a low symbol_only threshold so the test is deterministic
    from token_goat.config import Config, IndexingConfig
    mock_cfg = Config()
    mock_cfg.indexing = IndexingConfig(
        large_file_symbol_only_kb=200,  # 200 KB threshold
        large_file_skip_kb=2048,
    )

    import token_goat.parser as _parser_mod
    with patch.object(_parser_mod, "_config" if hasattr(_parser_mod, "_config") else "__name__", new=None, create=True):
        # Directly patch the config import inside index_project by patching at the module level
        pass

    # Simplest approach: patch token_goat.config.load to return our custom config
    import token_goat.config as _config_mod
    with patch.object(_config_mod, "load", return_value=mock_cfg):
        result = index_project(proj, full=True)

    large_files = result["large_files"]
    symbol_only = [lf for lf in large_files if lf.reason == "symbol_only"]
    assert any("huge.py" in lf.rel_path for lf in symbol_only), (
        f"Expected huge.py in symbol_only list, got: {large_files}"
    )


def test_index_project_large_files_empty_for_small_project(tmp_path, tmp_data_dir):
    """index_project returns empty large_files when all files are small."""
    root = tmp_path / "proj"
    shutil.copytree(PY_SAMPLE, root)
    (root / ".git").mkdir(exist_ok=True)

    proj = _make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config, IndexingConfig
    mock_cfg = Config()
    mock_cfg.indexing = IndexingConfig(
        large_file_symbol_only_kb=10_000,  # 10 GB — nothing will exceed this
        large_file_skip_kb=20_000,
    )
    with patch.object(_config_mod, "load", return_value=mock_cfg):
        result = index_project(proj, full=True)

    assert result["large_files"] == []


def test_index_project_skip_tier_recorded(tmp_path, tmp_data_dir):
    """Files over the skip threshold are recorded in large_files with reason='skipped'."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()

    small = root / "small.py"
    small.write_text("def foo(): pass\n", encoding="utf-8")

    big = root / "giant.py"
    _write_py(big, _FIXTURE_ABOVE_200KB)  # above the 200 KB skip threshold in mock_cfg

    proj = _make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config, IndexingConfig
    mock_cfg = Config()
    mock_cfg.indexing = IndexingConfig(
        large_file_symbol_only_kb=50,   # 50 KB symbol-only tier
        large_file_skip_kb=200,         # 200 KB skip tier — giant.py (400 KB) exceeds this
    )
    with patch.object(_config_mod, "load", return_value=mock_cfg):
        result = index_project(proj, full=True)

    skipped = [lf for lf in result["large_files"] if lf.reason == "skipped"]
    assert any("giant.py" in lf.rel_path for lf in skipped), (
        f"Expected giant.py in skipped list, got: {result['large_files']}"
    )


# ---------------------------------------------------------------------------
# 4. Config: IndexingConfig defaults and validation
# ---------------------------------------------------------------------------

def test_indexing_config_defaults():
    """IndexingConfig has correct defaults: 500 KB symbol-only, 2048 KB skip."""
    cfg = IndexingConfig()
    assert cfg.large_file_symbol_only_kb == 500
    assert cfg.large_file_skip_kb == 2048


def test_config_load_indexing_defaults(tmp_path, monkeypatch):
    """config.load() returns IndexingConfig with defaults when no TOML is present."""
    import token_goat.paths as _paths
    monkeypatch.setattr(_paths, "config_path", lambda: tmp_path / "nonexistent.toml")
    # Clear the process-level cache so load() re-reads
    import token_goat.config as _cfg_mod
    _cfg_mod._config_mtime_cache = None

    cfg = load_config()
    assert cfg.indexing.large_file_symbol_only_kb == 500
    assert cfg.indexing.large_file_skip_kb == 2048
    # Restore cache to avoid polluting other tests
    _cfg_mod._config_mtime_cache = None


def test_config_load_indexing_from_toml(tmp_path, monkeypatch):
    """config.load() reads [indexing] section from TOML file."""
    import tomli_w

    import token_goat.config as _cfg_mod
    import token_goat.paths as _paths

    toml_path = tmp_path / "config.toml"
    data = {
        "schema_version": 1,
        "indexing": {
            "large_file_symbol_only_kb": 250,
            "large_file_skip_kb": 1000,
        },
    }
    toml_path.write_bytes(tomli_w.dumps(data).encode("utf-8"))
    monkeypatch.setattr(_paths, "config_path", lambda: toml_path)
    _cfg_mod._config_mtime_cache = None

    cfg = load_config()
    assert cfg.indexing.large_file_symbol_only_kb == 250
    assert cfg.indexing.large_file_skip_kb == 1000
    _cfg_mod._config_mtime_cache = None


def test_config_skip_clamped_to_symbol_only(tmp_path, monkeypatch):
    """When skip_kb < symbol_only_kb in TOML, skip_kb is clamped to symbol_only_kb."""
    import tomli_w

    import token_goat.config as _cfg_mod
    import token_goat.paths as _paths

    toml_path = tmp_path / "config.toml"
    data = {
        "schema_version": 1,
        "indexing": {
            "large_file_symbol_only_kb": 1000,
            "large_file_skip_kb": 100,  # intentionally < symbol_only_kb
        },
    }
    toml_path.write_bytes(tomli_w.dumps(data).encode("utf-8"))
    monkeypatch.setattr(_paths, "config_path", lambda: toml_path)
    _cfg_mod._config_mtime_cache = None

    cfg = load_config()
    # skip_kb must be >= symbol_only_kb after clamping
    assert cfg.indexing.large_file_skip_kb >= cfg.indexing.large_file_symbol_only_kb
    _cfg_mod._config_mtime_cache = None


# ---------------------------------------------------------------------------
# 5. LargeFileInfo named tuple structure
# ---------------------------------------------------------------------------

def test_large_file_info_fields():
    """LargeFileInfo carries rel_path, size_bytes, and reason."""
    lfi = LargeFileInfo(rel_path="src/big.py", size_bytes=600_000, reason="symbol_only")
    assert lfi.rel_path == "src/big.py"
    assert lfi.size_bytes == 600_000
    assert lfi.reason == "symbol_only"


def test_large_file_info_skipped_reason():
    """LargeFileInfo with reason='skipped' is valid."""
    lfi = LargeFileInfo(rel_path="src/giant.py", size_bytes=3_000_000, reason="skipped")
    assert lfi.reason == "skipped"


# ---------------------------------------------------------------------------
# 6. --report-large CLI output format
# ---------------------------------------------------------------------------

def test_report_large_flag_no_large_files(tmp_path, tmp_data_dir):
    """--report-large outputs 'none' message when all files are within thresholds."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    root = tmp_path / "proj"
    shutil.copytree(PY_SAMPLE, root)
    (root / ".git").mkdir(exist_ok=True)

    import token_goat.config as _config_mod
    from token_goat.config import Config, IndexingConfig
    mock_cfg = Config()
    mock_cfg.indexing = IndexingConfig(
        large_file_symbol_only_kb=10_000,
        large_file_skip_kb=20_000,
    )

    runner = CliRunner()
    with (
        patch("token_goat.paths.data_dir", return_value=tmp_path),
        patch.object(_config_mod, "load", return_value=mock_cfg),
    ):
        result = runner.invoke(
            app,
            ["index", "--report-large", "--root", str(root)],
        )

    assert result.exit_code == 0
    assert "none" in result.output.lower() or "within" in result.output.lower()


def test_report_large_flag_with_large_file(tmp_path, tmp_data_dir):
    """--report-large prints a table row for files in the symbol-only tier."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    (root / "small.py").write_text("def foo(): pass\n", encoding="utf-8")
    big = root / "huge.py"
    _write_py(big, _FIXTURE_ABOVE_100KB)  # above the 100 KB threshold used by mock_cfg

    import token_goat.config as _config_mod
    from token_goat.config import Config, IndexingConfig
    mock_cfg = Config()
    mock_cfg.indexing = IndexingConfig(
        large_file_symbol_only_kb=100,  # 100 KB threshold
        large_file_skip_kb=2000,
    )

    runner = CliRunner()
    with (
        patch("token_goat.paths.data_dir", return_value=tmp_path),
        patch.object(_config_mod, "load", return_value=mock_cfg),
    ):
        result = runner.invoke(
            app,
            ["index", "--report-large", "--root", str(root)],
        )

    assert result.exit_code == 0
    assert "symbol_only" in result.output
    assert "huge.py" in result.output


# ---------------------------------------------------------------------------
# Regression guard: fixture sizes must stay within 1.2× of their threshold
# ---------------------------------------------------------------------------

def test_large_file_fixture_sizes_within_bound():
    """Guard against O(n²) fixture bloat: fixture writes must not exceed 1.2× their threshold.

    tlp.process() is O(n²) in file size. At 648 KB parse time is ~26 s; at 207 KB it is ~1.5 s.
    If _FIXTURE_ABOVE_200KB or _FIXTURE_ABOVE_100KB are inflated, this test will fail before
    the slow tests become painful again.
    """
    _200KB_THRESHOLD = 200 * 1024  # 204_800 bytes
    _100KB_THRESHOLD = 100 * 1024  # 102_400 bytes
    assert _FIXTURE_ABOVE_200KB < _200KB_THRESHOLD * 1.2, (
        f"_FIXTURE_ABOVE_200KB={_FIXTURE_ABOVE_200KB} is more than 1.2× the 200 KB threshold "
        "(tlp.process() is O(n²) — fixture bloat → test bloat)"
    )
    assert _FIXTURE_ABOVE_100KB < _100KB_THRESHOLD * 1.2, (
        f"_FIXTURE_ABOVE_100KB={_FIXTURE_ABOVE_100KB} is more than 1.2× the 100 KB threshold "
        "(tlp.process() is O(n²) — fixture bloat → test bloat)"
    )
