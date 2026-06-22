"""Tests for the ``config-get`` and ``version`` CLI commands."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers — write fixture files
# ---------------------------------------------------------------------------


def _make_toml(tmp_path):
    p = tmp_path / "project.toml"
    p.write_text(
        '[project]\nname = "myapp"\nversion = "2.3.4"\npython = "3.11"\n\n'
        "[tool.ruff]\nline-length = 88\n\n"
        "[tool.ruff.lint]\nselect = [\"E\", \"F\"]\n",
        encoding="utf-8",
    )
    return p


def _make_yaml(tmp_path):
    p = tmp_path / "app.yaml"
    p.write_text(
        "service:\n  host: localhost\n  port: 8080\n"
        "features:\n  - auth\n  - billing\n"
        "debug: false\n",
        encoding="utf-8",
    )
    return p


def _make_json(tmp_path):
    p = tmp_path / "package.json"
    p.write_text(
        json.dumps(
            {
                "name": "my-package",
                "version": "1.2.3",
                "scripts": {"test": "jest", "build": "tsc"},
                "devDependencies": {"typescript": "^5.0.0"},
            }
        ),
        encoding="utf-8",
    )
    return p


def _make_ini(tmp_path):
    p = tmp_path / "setup.cfg"
    p.write_text(
        "[metadata]\nname = mypackage\nversion = 0.1.0\nauthor = Alice\n\n"
        "[options]\npython_requires = >=3.9\n",
        encoding="utf-8",
    )
    return p


# ---------------------------------------------------------------------------
# TOML tests
# ---------------------------------------------------------------------------


class TestConfigGetToml:
    def test_simple_top_level_section_key(self, tmp_path):
        """Read a simple key inside a TOML table."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "project.version"])
        assert result.exit_code == 0
        assert result.output.strip() == "2.3.4"

    def test_nested_key(self, tmp_path):
        """Dot-notation across two levels of nesting."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "tool.ruff.line-length"])
        assert result.exit_code == 0
        assert result.output.strip() == "88"

    def test_array_value_returns_json(self, tmp_path):
        """Array values are emitted as JSON arrays."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "tool.ruff.lint.select"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert isinstance(parsed, list)
        assert "E" in parsed

    def test_section_returns_json_object(self, tmp_path):
        """Requesting a table key returns the whole section as a JSON object."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "tool.ruff"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert isinstance(parsed, dict)
        assert parsed["line-length"] == 88

    def test_missing_key_exits_2(self, tmp_path):
        """A nonexistent key must exit with code 2."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "project.nonexistent"])
        assert result.exit_code == 2

    def test_json_flag_encodes_scalar(self, tmp_path):
        """With --json, scalar values are JSON-encoded (quoted strings, booleans, etc.)."""
        p = _make_toml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "project.name", "--json"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert parsed == "myapp"

    def test_toml_bool_value(self, tmp_path):
        """TOML boolean is printed as lowercase true/false, not Python's True/False."""
        p = tmp_path / "config.toml"
        p.write_text("[settings]\nenabled = true\ndisabled = false\n", encoding="utf-8")
        r_true = runner.invoke(app, ["config-get", str(p), "settings.enabled"])
        r_false = runner.invoke(app, ["config-get", str(p), "settings.disabled"])
        assert r_true.exit_code == 0
        assert r_true.output.strip() == "true"
        assert r_false.exit_code == 0
        assert r_false.output.strip() == "false"

    def test_project_version_from_real_pyproject(self):
        """Smoke test against the real pyproject.toml in this repo."""
        import pathlib
        pyproject = pathlib.Path(__file__).parent.parent / "pyproject.toml"
        result = runner.invoke(app, ["config-get", str(pyproject), "project.version"])
        assert result.exit_code == 0
        ver = result.output.strip()
        # Version must look like X.Y.Z or X.Y.Z.dev0 etc.
        assert ver and ver[0].isdigit()


# ---------------------------------------------------------------------------
# YAML tests
# ---------------------------------------------------------------------------


class TestConfigGetYaml:
    def test_nested_yaml_key(self, tmp_path):
        """Read a nested key from a YAML file."""
        pytest.importorskip("yaml", reason="PyYAML not installed")
        p = _make_yaml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "service.port"])
        assert result.exit_code == 0
        assert result.output.strip() == "8080"

    def test_yaml_string_value(self, tmp_path):
        """Read a string scalar from YAML."""
        pytest.importorskip("yaml", reason="PyYAML not installed")
        p = _make_yaml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "service.host"])
        assert result.exit_code == 0
        assert result.output.strip() == "localhost"

    def test_yaml_array_value(self, tmp_path):
        """YAML list values are returned as JSON arrays."""
        pytest.importorskip("yaml", reason="PyYAML not installed")
        p = _make_yaml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "features"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert "auth" in parsed
        assert "billing" in parsed

    def test_yaml_bool_value(self, tmp_path):
        """YAML boolean is printed as true/false."""
        pytest.importorskip("yaml", reason="PyYAML not installed")
        p = _make_yaml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "debug"])
        assert result.exit_code == 0
        assert result.output.strip() == "false"

    def test_yaml_missing_key_exits_2(self, tmp_path):
        """Missing key in YAML must exit with code 2."""
        pytest.importorskip("yaml", reason="PyYAML not installed")
        p = _make_yaml(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "service.missing"])
        assert result.exit_code == 2


# ---------------------------------------------------------------------------
# JSON tests
# ---------------------------------------------------------------------------


class TestConfigGetJson:
    def test_top_level_scalar(self, tmp_path):
        """Read a top-level scalar from a JSON file."""
        p = _make_json(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "version"])
        assert result.exit_code == 0
        assert result.output.strip() == "1.2.3"

    def test_nested_json_key(self, tmp_path):
        """Read a nested scalar from a JSON file."""
        p = _make_json(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "scripts.test"])
        assert result.exit_code == 0
        assert result.output.strip() == "jest"

    def test_json_object_value(self, tmp_path):
        """Requesting a dict key returns the whole object as JSON."""
        p = _make_json(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "scripts"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert parsed["build"] == "tsc"

    def test_json_bool_value(self, tmp_path):
        """JSON boolean is printed as lowercase true/false, not Python's True/False."""
        import json as _json
        p = tmp_path / "flags.json"
        p.write_text(_json.dumps({"feature_on": True, "feature_off": False}), encoding="utf-8")
        r_true = runner.invoke(app, ["config-get", str(p), "feature_on"])
        r_false = runner.invoke(app, ["config-get", str(p), "feature_off"])
        assert r_true.exit_code == 0
        assert r_true.output.strip() == "true"
        assert r_false.exit_code == 0
        assert r_false.output.strip() == "false"

    def test_json_missing_key_exits_2(self, tmp_path):
        """Missing key in JSON must exit with code 2."""
        p = _make_json(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "scripts.missing"])
        assert result.exit_code == 2


# ---------------------------------------------------------------------------
# INI / CFG tests
# ---------------------------------------------------------------------------


class TestConfigGetIni:
    def test_ini_key_read(self, tmp_path):
        """Read a value from an INI section."""
        p = _make_ini(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "metadata.name"])
        assert result.exit_code == 0
        assert result.output.strip() == "mypackage"

    def test_ini_missing_key_exits_2(self, tmp_path):
        """Missing key in INI must exit with code 2."""
        p = _make_ini(tmp_path)
        result = runner.invoke(app, ["config-get", str(p), "metadata.nosuchkey"])
        assert result.exit_code == 2


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestConfigGetErrors:
    def test_nonexistent_file_exits_2(self, tmp_path):
        """A file path that does not exist must exit with code 2."""
        result = runner.invoke(app, ["config-get", str(tmp_path / "nosuch.toml"), "a.b"])
        assert result.exit_code == 2

    def test_unsupported_extension_exits_2(self, tmp_path):
        """An unrecognised file extension must exit with code 2."""
        p = tmp_path / "data.xml"
        p.write_text("<root/>", encoding="utf-8")
        result = runner.invoke(app, ["config-get", str(p), "root"])
        assert result.exit_code == 2

    def test_malformed_toml_exits_2(self, tmp_path):
        """A broken TOML file must exit with code 2."""
        p = tmp_path / "bad.toml"
        p.write_text("[[[[invalid", encoding="utf-8")
        result = runner.invoke(app, ["config-get", str(p), "x"])
        assert result.exit_code == 2


# ---------------------------------------------------------------------------
# version command
# ---------------------------------------------------------------------------


class TestVersionCommand:
    def test_version_prints_version_string(self):
        """token-goat version prints a version string."""
        result = runner.invoke(app, ["version"])
        assert result.exit_code == 0
        ver = result.output.strip()
        # Must be a non-empty string starting with a digit.
        assert ver and ver[0].isdigit()

    def test_version_json(self):
        """token-goat version --json returns {"version": "X.Y.Z"}."""
        result = runner.invoke(app, ["version", "--json"])
        assert result.exit_code == 0
        parsed = json.loads(result.output)
        assert "version" in parsed
        assert parsed["version"] and parsed["version"][0].isdigit()

    def test_version_matches_flag(self):
        """token-goat version output must match --version output."""
        r_cmd = runner.invoke(app, ["version"])
        r_flag = runner.invoke(app, ["--version"])
        assert r_cmd.exit_code == 0
        # --version embeds "token-goat X.Y.Z", extract just the version
        ver_flag = r_flag.output.strip().split()[-1]
        assert r_cmd.output.strip() == ver_flag
