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
    assert json.loads(result.output) is False
    assert config_mod.load().compact_assist.enabled is False

    result = runner.invoke(app, ["config", "set", "compact_assist.min_events", "9"])
    assert result.exit_code == 0
    assert json.loads(result.output) == 9
    assert config_mod.load().compact_assist.min_events == 9

    result = runner.invoke(app, ["config", "set", "compact_assist.triggers", "manual,auto"])
    assert result.exit_code == 0
    assert json.loads(result.output) == ["manual", "auto"]
    assert config_mod.load().compact_assist.triggers == ["manual", "auto"]
