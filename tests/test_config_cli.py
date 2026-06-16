"""Tests for the config CLI commands."""
from __future__ import annotations

import json

from typer.testing import CliRunner

from token_goat import config as config_mod
from token_goat.cli import app


def test_config_get_and_set_round_trip(tmp_data_dir):
    runner = CliRunner()

    result = runner.invoke(app, ["config", "get", "compact_assist.enabled"])
    assert result.exit_code == 0
    assert json.loads(result.output) is True

    result = runner.invoke(app, ["config", "set", "compact_assist.enabled", "false"])
    assert result.exit_code == 0
    assert "compact_assist.enabled" in result.output
    assert config_mod.load().compact_assist.enabled is False

    result = runner.invoke(app, ["config", "set", "compact_assist.min_events", "9"])
    assert result.exit_code == 0
    assert "compact_assist.min_events" in result.output
    assert config_mod.load().compact_assist.min_events == 9

    result = runner.invoke(app, ["config", "set", "compact_assist.triggers", "manual,auto"])
    assert result.exit_code == 0
    assert "compact_assist.triggers" in result.output
    assert config_mod.load().compact_assist.triggers == ["manual", "auto"]


def test_config_get_unknown_key_exits_2(tmp_data_dir):
    """config get with a nonexistent key must exit 2 and emit an error message."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "get", "compact_assist.does_not_exist"])
    assert result.exit_code == 2
    combined = (result.output or "") + (result.stderr or "")
    assert "config key" in combined.lower()


def test_config_set_unknown_key_exits_2(tmp_data_dir):
    """config set with a nonexistent key must exit 2 and emit an error message."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.no_such_field", "42"])
    assert result.exit_code == 2


def test_config_set_invalid_bool_value_exits_2(tmp_data_dir):
    """config set with a non-boolean value for a bool field must exit 2."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.enabled", "maybe"])
    assert result.exit_code == 2


def test_config_set_invalid_int_value_exits_2(tmp_data_dir):
    """config set with a non-integer value for an int field must exit 2."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.min_events", "not_a_number"])
    assert result.exit_code == 2


def test_config_get_nested_int_key(tmp_data_dir):
    """config get for compact_assist.max_manifest_tokens returns the default (400)."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "get", "compact_assist.max_manifest_tokens"])
    assert result.exit_code == 0
    assert json.loads(result.output) == 400


def test_config_set_max_manifest_tokens_round_trip(tmp_data_dir):
    """config set compact_assist.max_manifest_tokens persists and is readable back."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.max_manifest_tokens", "250"])
    assert result.exit_code == 0
    assert "compact_assist.max_manifest_tokens" in result.output
    assert "250" in result.output
    assert config_mod.load().compact_assist.max_manifest_tokens == 250

    # Read it back via CLI to confirm persistence
    result = runner.invoke(app, ["config", "get", "compact_assist.max_manifest_tokens"])
    assert result.exit_code == 0
    assert json.loads(result.output) == 250


def test_config_get_section_returns_json_object(tmp_data_dir):
    """config get compact_assist returns the full section as a JSON object."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "get", "compact_assist"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert isinstance(data, dict)
    assert "enabled" in data
    assert "triggers" in data
    assert "min_events" in data
    assert "max_manifest_tokens" in data


def test_config_set_triggers_json_list_syntax(tmp_data_dir):
    """config set accepts a JSON array string for a list field."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.triggers", '["manual"]'])
    assert result.exit_code == 0
    assert "compact_assist.triggers" in result.output
    assert config_mod.load().compact_assist.triggers == ["manual"]


def test_config_set_enabled_truthy_variants(tmp_data_dir):
    """config set accepts 'yes', 'on', '1' as truthy boolean values."""
    runner = CliRunner()
    for truthy in ("yes", "on", "1", "true"):
        # First disable
        runner.invoke(app, ["config", "set", "compact_assist.enabled", "false"])
        result = runner.invoke(app, ["config", "set", "compact_assist.enabled", truthy])
        assert result.exit_code == 0, f"Failed for truthy={truthy!r}"
        assert config_mod.load().compact_assist.enabled is True, f"Expected True for truthy={truthy!r}"


def test_config_set_enabled_falsy_variants(tmp_data_dir):
    """config set accepts 'no', 'off', '0', 'false' as falsy boolean values."""
    runner = CliRunner()
    for falsy in ("no", "off", "0", "false"):
        # First enable
        runner.invoke(app, ["config", "set", "compact_assist.enabled", "true"])
        result = runner.invoke(app, ["config", "set", "compact_assist.enabled", falsy])
        assert result.exit_code == 0, f"Failed for falsy={falsy!r}"
        assert config_mod.load().compact_assist.enabled is False, f"Expected False for falsy={falsy!r}"


# ---------------------------------------------------------------------------
# _coerce_config_value unit tests (internal helper, but has meaningful branches)
# ---------------------------------------------------------------------------

def test_coerce_config_value_empty_string_becomes_empty_list():
    """An empty string coerces to [] for a list field."""
    from token_goat.cli import _coerce_config_value
    result = _coerce_config_value(["manual"], "")
    assert result == []


def test_coerce_config_value_comma_separated_list():
    """Comma-separated string coerces to list of stripped items."""
    from token_goat.cli import _coerce_config_value
    result = _coerce_config_value(["manual"], "manual, auto")
    assert result == ["manual", "auto"]


def test_coerce_config_value_json_list_strips_inner_quotes():
    """JSON list string like '["manual"]' coerces to Python list."""
    from token_goat.cli import _coerce_config_value
    result = _coerce_config_value(["manual"], '["manual", "auto"]')
    assert result == ["manual", "auto"]


# ---------------------------------------------------------------------------
# config list tests
# ---------------------------------------------------------------------------

def test_config_list_shows_all_keys(tmp_data_dir):
    """config list outputs all known config keys."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "list"])
    assert result.exit_code == 0
    assert "compact_assist.enabled" in result.output
    assert "compact_assist.triggers" in result.output
    assert "compact_assist.min_events" in result.output
    assert "compact_assist.max_manifest_tokens" in result.output


def test_config_list_shows_defaults(tmp_data_dir):
    """config list shows 'default:' annotation for each key."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "list"])
    assert result.exit_code == 0
    assert "default:" in result.output


def test_config_list_json_output(tmp_data_dir):
    """config list --json returns a dict with value + default for each key."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "list", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert isinstance(data, dict)
    assert "compact_assist.enabled" in data
    entry = data["compact_assist.enabled"]
    assert "value" in entry
    assert "default" in entry
    assert entry["value"] is True
    assert entry["default"] is True


def test_config_list_json_shows_changed_values(tmp_data_dir):
    """config list --json reflects a value changed via config set."""
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.min_events", "99"])
    result = runner.invoke(app, ["config", "list", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["compact_assist.min_events"]["value"] == 99
    assert data["compact_assist.min_events"]["default"] == 3


def test_config_list_marks_changed_keys(tmp_data_dir):
    """config list marks keys that differ from defaults with an asterisk."""
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.enabled", "false"])
    result = runner.invoke(app, ["config", "list"])
    assert result.exit_code == 0
    # The changed key line should start with '* '
    changed_line = next(
        (ln for ln in result.output.splitlines() if "compact_assist.enabled" in ln), None
    )
    assert changed_line is not None
    assert changed_line.startswith("*")


class TestConfigValidate:
    """Tests for ``token-goat config validate``."""

    def test_no_config_file_reports_ok(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["config", "validate", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["ok"] is True

    def test_empty_config_reports_ok(self, tmp_data_dir, tmp_path):
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("", encoding="utf-8")
        import unittest.mock as mock

        import token_goat.paths as _paths
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        assert result.exit_code == 0
        assert json.loads(result.output)["ok"] is True

    def test_all_known_section_keys_pass(self, tmp_data_dir, tmp_path):
        import dataclasses
        import unittest.mock as mock

        import token_goat.paths as _paths

        sections = {
            "compact_assist": config_mod.CompactAssistConfig,
            "bash_compress": config_mod.BashCompressConfig,
            "session_brief": config_mod.SessionBriefConfig,
            "skill_preservation": config_mod.SkillPreservationConfig,
            "image_shrink": config_mod.ImageShrinkConfig,
            "curator": config_mod.CuratorConfig,
            "hint_budget": config_mod.HintBudgetConfig,
            "hints": config_mod.HintsConfig,
            "repomap": config_mod.RepomapConfig,
            "stats": config_mod.StatsConfig,
            "webfetch": config_mod.WebFetchConfig,
        }
        lines = ["schema_version = 1\n"]
        for section, cls in sections.items():
            lines.append(f"[{section}]\n")
            for f in dataclasses.fields(cls):
                val = getattr(cls(), f.name)
                if isinstance(val, bool):
                    lines.append(f"{f.name} = {'true' if val else 'false'}\n")
                elif isinstance(val, (int, float)):
                    lines.append(f"{f.name} = {val}\n")
                elif isinstance(val, list):
                    items = ", ".join(f'"{x}"' for x in val)
                    lines.append(f"{f.name} = [{items}]\n")
                elif isinstance(val, str):
                    lines.append(f'{f.name} = "{val}"\n')

        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("".join(lines), encoding="utf-8")
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        data = json.loads(result.output)
        assert data["ok"] is True, f"Unexpected issues: {data.get('issues')}"

    def test_unknown_top_level_key_flagged(self, tmp_data_dir, tmp_path):
        import unittest.mock as mock

        import token_goat.paths as _paths

        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compac_assist]\nenabled = true\n", encoding="utf-8")
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        assert result.exit_code == 1
        data = json.loads(result.output)
        assert data["ok"] is False
        assert any("compac_assist" in i["key"] for i in data["issues"])
        assert any("compact_assist" in i.get("suggestion", "") for i in data["issues"])

    def test_unknown_section_sub_key_flagged(self, tmp_data_dir, tmp_path):
        import unittest.mock as mock

        import token_goat.paths as _paths

        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nmin_eventss = 5\n", encoding="utf-8")
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        assert result.exit_code == 1
        data = json.loads(result.output)
        assert data["ok"] is False
        assert any("min_eventss" in i["key"] for i in data["issues"])
        assert any("min_events" in i.get("suggestion", "") for i in data["issues"])

    def test_hints_and_webfetch_sections_accepted(self, tmp_data_dir, tmp_path):
        import unittest.mock as mock

        import token_goat.paths as _paths

        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            "[hints]\njson_sidecar = true\n\n[webfetch]\nmax_file_count = 1000\n",
            encoding="utf-8",
        )
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        data = json.loads(result.output)
        assert data["ok"] is True, f"Unexpected issues: {data.get('issues')}"

    def test_validate_known_top_level_matches_config_known_sections(self, tmp_data_dir, tmp_path):
        """config validate must accept every section listed in config._KNOWN_SECTIONS.

        Guards against the two-place update bug where a new section is added to
        config._KNOWN_SECTIONS but the validate command's local set is not updated,
        causing valid configs to be falsely flagged as unknown sections.
        """
        import dataclasses
        import unittest.mock as mock

        import token_goat.paths as _paths

        # Build a TOML file that contains every section listed in _KNOWN_SECTIONS
        # (excluding schema_version, which is a scalar, not a table).
        section_to_cls = {
            "compact_assist": config_mod.CompactAssistConfig,
            "bash_compress": config_mod.BashCompressConfig,
            "session_brief": config_mod.SessionBriefConfig,
            "skill_preservation": config_mod.SkillPreservationConfig,
            "image_shrink": config_mod.ImageShrinkConfig,
            "curator": config_mod.CuratorConfig,
            "hint_budget": config_mod.HintBudgetConfig,
            "hints": config_mod.HintsConfig,
            "hooks": config_mod.HooksConfig,
            "repomap": config_mod.RepomapConfig,
            "stats": config_mod.StatsConfig,
            "webfetch": config_mod.WebFetchConfig,
            "worker": config_mod.WorkerConfig,
            "indexing": config_mod.IndexingConfig,
            "compression": config_mod.CompressionConfig,
            "overflow_guard": config_mod.OverflowGuardConfig,
            "context": config_mod.ContextConfig,
            "bash_diff": config_mod.BashDiffConfig,
            "bash_severity_log": config_mod.SeverityLogConfig,
        }
        # Verify that section_to_cls covers exactly _KNOWN_SECTIONS minus schema_version.
        expected = config_mod._KNOWN_SECTIONS - {"schema_version"}
        assert set(section_to_cls) == expected, (
            f"Test out-of-sync: _KNOWN_SECTIONS has {expected - set(section_to_cls)!r} "
            f"not in section_to_cls. Update this test when adding a new config section."
        )

        lines = ["schema_version = 1\n"]
        for section, cls in section_to_cls.items():
            lines.append(f"[{section}]\n")
            for f in dataclasses.fields(cls):
                val = getattr(cls(), f.name)
                if isinstance(val, bool):
                    lines.append(f"{f.name} = {'true' if val else 'false'}\n")
                elif isinstance(val, (int, float)):
                    lines.append(f"{f.name} = {val}\n")
                elif isinstance(val, list):
                    items = ", ".join(f'"{x}"' for x in val)
                    lines.append(f"{f.name} = [{items}]\n")
                elif isinstance(val, str):
                    lines.append(f'{f.name} = "{val}"\n')

        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("".join(lines), encoding="utf-8")
        runner = CliRunner()
        with mock.patch.object(_paths, "config_path", return_value=cfg_path):
            result = runner.invoke(app, ["config", "validate", "--json"])
        data = json.loads(result.output)
        assert data["ok"] is True, (
            f"config validate rejected a known section. Issues: {data.get('issues')}\n"
            "Did you add a section to config._KNOWN_SECTIONS without also updating "
            "config_validate()'s _KNOWN_TOP_LEVEL?"
        )


# ---------------------------------------------------------------------------
# config get (no-arg — TOML dump)
# ---------------------------------------------------------------------------

def test_config_get_no_arg_dumps_toml(tmp_data_dir):
    """config get with no argument prints all config in TOML format."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "get"])
    assert result.exit_code == 0
    import tomllib
    parsed = tomllib.loads(result.output)
    assert "compact_assist" in parsed
    assert "bash_compress" in parsed
    assert "hints" in parsed


def test_config_get_no_arg_reflects_changed_value(tmp_data_dir):
    """config get (no-arg) shows a value changed via config set."""
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.min_events", "7"])
    result = runner.invoke(app, ["config", "get"])
    assert result.exit_code == 0
    import tomllib
    parsed = tomllib.loads(result.output)
    assert parsed["compact_assist"]["min_events"] == 7


# ---------------------------------------------------------------------------
# config set output format
# ---------------------------------------------------------------------------

def test_config_set_output_format(tmp_data_dir):
    """config set prints 'Set KEY = VALUE' on success."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.min_events", "11"])
    assert result.exit_code == 0
    assert result.output.strip() == "Set compact_assist.min_events = 11"


def test_config_set_bool_output_format(tmp_data_dir):
    """config set for a bool field prints the canonical JSON boolean."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "set", "compact_assist.enabled", "false"])
    assert result.exit_code == 0
    assert result.output.strip() == "Set compact_assist.enabled = false"


# ---------------------------------------------------------------------------
# config path
# ---------------------------------------------------------------------------

def test_config_path_prints_path(tmp_data_dir):
    """config path prints a non-empty filesystem path."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "path"])
    assert result.exit_code == 0
    output = result.output.strip()
    assert output  # non-empty
    assert "config" in output.lower() or "token" in output.lower() or "goat" in output.lower()


# ---------------------------------------------------------------------------
# config reset
# ---------------------------------------------------------------------------

def test_config_reset_single_key(tmp_data_dir):
    """config reset KEY restores that key to its default without deleting the file."""
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.min_events", "99"])
    assert config_mod.load().compact_assist.min_events == 99

    result = runner.invoke(app, ["config", "reset", "compact_assist.min_events"])
    assert result.exit_code == 0
    assert "compact_assist.min_events" in result.output
    assert config_mod.load().compact_assist.min_events == 3  # default


def test_config_reset_all_with_yes_flag(tmp_data_dir):
    """config reset --yes deletes config.toml and restores all defaults."""
    from token_goat import paths as _paths
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.min_events", "99"])
    assert _paths.config_path().exists()

    result = runner.invoke(app, ["config", "reset", "--yes"])
    assert result.exit_code == 0
    assert not _paths.config_path().exists()
    assert config_mod.load().compact_assist.min_events == 3  # default restored


def test_config_reset_all_prompts_confirmation(tmp_data_dir):
    """config reset (no --yes) prompts; answering 'n' aborts without deleting."""
    from token_goat import paths as _paths
    runner = CliRunner()
    runner.invoke(app, ["config", "set", "compact_assist.min_events", "55"])
    assert _paths.config_path().exists()

    # Simulate user typing 'n' at the prompt
    result = runner.invoke(app, ["config", "reset"], input="n\n")
    assert result.exit_code == 0
    assert _paths.config_path().exists()  # file still there
    assert config_mod.load().compact_assist.min_events == 55  # unchanged


def test_config_reset_all_no_file_is_noop(tmp_data_dir):
    """config reset when no config file exists reports already-at-defaults."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "reset", "--yes"])
    assert result.exit_code == 0
    assert "default" in result.output.lower()


def test_config_reset_unknown_key_exits_2(tmp_data_dir):
    """config reset with an unknown key exits with code 2."""
    runner = CliRunner()
    result = runner.invoke(app, ["config", "reset", "compact_assist.no_such_field"])
    assert result.exit_code == 2
