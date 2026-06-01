"""CLI integration tests for outline, scope, map, and compact-hint commands."""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_PROJ = SimpleNamespace(root=MagicMock(), hash="deadbeef", name="test-proj")


def _fake_file_target(proj=_FAKE_PROJ, rel_path="src/foo.py"):
    return SimpleNamespace(
        project=proj,
        rel_path=rel_path,
        current_project=proj,
    )


# ---------------------------------------------------------------------------
# outline — happy path
# ---------------------------------------------------------------------------

def test_outline_happy_path():
    """outline returns symbol names with kind and line range for an indexed file."""
    fake_rows = [
        {"name": "MyClass", "kind": "class", "line": 10, "end_line": 50},
        {"name": "my_function", "kind": "function", "line": 55, "end_line": 70},
    ]
    fake_conn = MagicMock()
    fake_conn.__enter__ = MagicMock(return_value=fake_conn)
    fake_conn.__exit__ = MagicMock(return_value=False)
    fake_conn.execute.return_value.fetchall.return_value = fake_rows

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=_fake_file_target()),
        patch("token_goat.read_commands.db.open_project_readonly", return_value=fake_conn),
        patch("token_goat.read_commands.db.record_stat"),
    ):
        # Mock the project root so abs_path.stat().st_size doesn't blow up.
        _FAKE_PROJ.root.__truediv__ = MagicMock(
            return_value=MagicMock(
                read_text=MagicMock(return_value=""),
                stat=MagicMock(return_value=MagicMock(st_size=100)),
            )
        )
        result = runner.invoke(cli.app, ["outline", "src/foo.py"])

    assert result.exit_code == 0, result.output
    assert "MyClass" in result.output
    assert "my_function" in result.output


# ---------------------------------------------------------------------------
# outline — error path (file not in any indexed project)
# ---------------------------------------------------------------------------

def test_outline_file_not_found():
    """outline exits non-zero when the file is not in any indexed project."""
    fake_target = SimpleNamespace(
        project=None,
        rel_path=None,
        current_project=None,
    )
    with patch("token_goat.read_commands._resolve_file_target", return_value=fake_target):
        result = runner.invoke(cli.app, ["outline", "nonexistent/path.py"])

    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# scope — happy path
# ---------------------------------------------------------------------------

def test_scope_happy_path():
    """scope returns enclosing scope header and module-level section for a valid target."""
    fake_enclosing = [
        {"name": "build_index", "kind": "function", "line": 20, "end_line": 60},
    ]
    fake_imports = [
        {"target": "os", "line": 1},
        {"target": "pathlib.Path", "line": 2},
    ]

    file_row = {"line_count": 100}

    fake_conn = MagicMock()
    fake_conn.__enter__ = MagicMock(return_value=fake_conn)
    fake_conn.__exit__ = MagicMock(return_value=False)

    def _execute(query, *args, **kwargs):
        m = MagicMock()
        if "line_count" in query:
            m.fetchone.return_value = file_row
        elif "imports_exports" in query:
            m.fetchall.return_value = fake_imports
        else:
            m.fetchall.return_value = fake_enclosing
        return m

    fake_conn.execute.side_effect = _execute

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=_fake_file_target()),
        patch("token_goat.read_commands.db.open_project_readonly", return_value=fake_conn),
    ):
        result = runner.invoke(cli.app, ["scope", "src/foo.py:42"])

    assert result.exit_code == 0, result.output
    assert "Enclosing scope" in result.output
    assert "build_index" in result.output


# ---------------------------------------------------------------------------
# scope — error path (missing colon separator)
# ---------------------------------------------------------------------------

def test_scope_missing_line_number():
    """scope exits non-zero when the target is missing the :<line> suffix."""
    result = runner.invoke(cli.app, ["scope", "src/foo.py"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# map — happy path
# ---------------------------------------------------------------------------

def test_map_happy_path():
    """map returns the repomap text when project and repomap are available."""
    fake_map_text = "# Repo Map\n[100 tokens]\nsrc/foo.py [function, class]"

    with (
        patch("token_goat.cli._require_project", return_value=_FAKE_PROJ),
        patch("token_goat.repomap.build_map", return_value=fake_map_text),
        patch("token_goat.cli._record_lookup_stat"),
    ):
        result = runner.invoke(cli.app, ["map"])

    assert result.exit_code == 0, result.output
    assert "Repo Map" in result.output


# ---------------------------------------------------------------------------
# map — error path (invalid --format value)
# ---------------------------------------------------------------------------

def test_map_invalid_format():
    """map exits 1 when --format is not one of text/json/mermaid."""
    with patch("token_goat.cli._require_project", return_value=_FAKE_PROJ):
        result = runner.invoke(cli.app, ["map", "--format", "xml"])

    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# compact-hint — happy path
# ---------------------------------------------------------------------------

def test_compact_hint_happy_path():
    """compact-hint outputs gate status and manifest preview for a valid session."""
    fake_manifest = "## Token-Goat Manifest\n### Edited Files\n- src/foo.py"

    cfg_mock = SimpleNamespace(
        enabled=True,
        triggers=["manual"],
        max_manifest_tokens=400,
        min_events=1,
        auto_trigger_multiplier=1.0,
    )
    compact_cfg_mock = MagicMock()
    compact_cfg_mock.compact_assist = cfg_mock

    with (
        patch("token_goat.compact.find_latest_session_id", return_value="sess-abc123"),
        patch("token_goat.compact.build_manifest", return_value=fake_manifest),
        patch("token_goat.compact.estimate_tokens", return_value=42),
        patch("token_goat.compact._score_manifest", return_value=5),
        patch("token_goat.compact.event_count", return_value=3),
        patch("token_goat.config.load", return_value=compact_cfg_mock),
        patch("token_goat.hooks_cli._check_compact_skip_sentinel_detail", return_value=None),
        patch("token_goat.session.safe_load", return_value=None),
        patch("token_goat.hooks_cli._is_noop_session", return_value=False),
        patch("token_goat.cli._validate_session_id"),
    ):
        result = runner.invoke(cli.app, ["compact-hint", "--session-id", "sess-abc123"])

    assert result.exit_code == 0, result.output
    # The human-readable preview contains the gate status line.
    assert "compact-assist enabled" in result.output


# ---------------------------------------------------------------------------
# compact-hint — error path (no session files found)
# ---------------------------------------------------------------------------

def test_compact_hint_no_session_files():
    """compact-hint exits 1 when no session files exist and --auto is used."""
    cfg_mock = SimpleNamespace(
        enabled=True,
        triggers=["manual"],
        max_manifest_tokens=400,
        min_events=1,
        auto_trigger_multiplier=1.0,
    )
    compact_cfg_mock = MagicMock()
    compact_cfg_mock.compact_assist = cfg_mock

    with (
        patch("token_goat.compact.find_latest_session_id", return_value=None),
        patch("token_goat.config.load", return_value=compact_cfg_mock),
    ):
        result = runner.invoke(cli.app, ["compact-hint", "--auto"])

    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# map — --top N flag
# ---------------------------------------------------------------------------

def test_map_top_n_happy_path():
    """map --top 5 limits output to top 5 files by PageRank."""
    fake_map_text = "src/a.py (rank: 0.050)\nsrc/b.py (rank: 0.040)\n"

    with (
        patch("token_goat.cli._require_project", return_value=_FAKE_PROJ),
        patch("token_goat.repomap.build_map", return_value=fake_map_text),
        patch("token_goat.cli._record_lookup_stat"),
    ):
        result = runner.invoke(cli.app, ["map", "--top", "5"])

    assert result.exit_code == 0, result.output
    assert "rank:" in result.output


def test_map_top_zero_error():
    """map --top 0 should error."""
    with patch("token_goat.cli._require_project", return_value=_FAKE_PROJ):
        result = runner.invoke(cli.app, ["map", "--top", "0"])

    assert result.exit_code != 0
    assert "positive integer" in result.output


def test_map_top_negative_error():
    """map --top -5 should error."""
    with patch("token_goat.cli._require_project", return_value=_FAKE_PROJ):
        result = runner.invoke(cli.app, ["map", "--top", "-5"])

    assert result.exit_code != 0
    assert "positive integer" in result.output
