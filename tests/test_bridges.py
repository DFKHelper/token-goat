"""Tests for bridges.py — opencode and openclaw bridge plugin install/check/uninstall."""
from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from token_goat import bridges

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_fake_plugin(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# TypeScript source content smoke checks
# ---------------------------------------------------------------------------


class TestPluginTsSources:
    def test_opencode_ts_contains_spawnSync(self) -> None:
        assert "spawnSync" in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_contains_token_goat(self) -> None:
        assert "token-goat" in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_exports_server(self) -> None:
        assert "export const server" in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_handles_tool_execute_before(self) -> None:
        assert "tool.execute.before" in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_handles_tool_execute_after(self) -> None:
        assert "tool.execute.after" in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_handles_compacting(self) -> None:
        assert "experimental.session.compacting" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_contains_spawnSync(self) -> None:
        assert "spawnSync" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_contains_token_goat(self) -> None:
        assert "token-goat" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_has_register_function(self) -> None:
        assert "register(" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_handles_before_tool_call(self) -> None:
        assert "before_tool_call" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_handles_after_tool_call(self) -> None:
        assert "after_tool_call" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_has_deny_support(self) -> None:
        assert "block: true" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_has_updated_input_support(self) -> None:
        assert "updatedInput" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_session_id_uses_pid(self) -> None:
        assert "process.pid" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_exports_default(self) -> None:
        assert "export default" in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_plugin_id(self) -> None:
        assert "token-goat-bridge" in bridges.OPENCLAW_PLUGIN_TS

    def test_opencode_ts_maps_read_tool(self) -> None:
        # TS object keys are unquoted: `read: "Read",`
        assert 'read: "Read"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_maps_webfetch_to_pre_fetch(self) -> None:
        assert "pre-fetch" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_maps_exec_tool(self) -> None:
        # TS object keys are unquoted: `exec: "Bash",`
        assert 'exec: "Bash"' in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_post_edit_for_write(self) -> None:
        # TS object keys are unquoted: `Write: "post-edit",`
        assert 'Write: "post-edit"' in bridges.OPENCLAW_PLUGIN_TS


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


class TestPathHelpers:
    def test_opencode_plugins_dir_returns_path(self) -> None:
        result = bridges.opencode_plugins_dir()
        assert isinstance(result, Path)
        assert "opencode" in str(result).lower()
        assert "plugins" in str(result)

    def test_opencode_plugins_dir_platform_win32(self) -> None:
        fake_appdata = Path("/fake/appdata")
        with patch.dict("os.environ", {"APPDATA": str(fake_appdata)}), patch.object(sys, "platform", "win32"):
            result = bridges.opencode_plugins_dir()
        assert result == fake_appdata / "opencode" / "plugins"

    def test_opencode_plugins_dir_platform_linux(self) -> None:
        with patch.object(sys, "platform", "linux"):
            result = bridges.opencode_plugins_dir()
        assert result == Path.home() / ".config" / "opencode" / "plugins"

    def test_opencode_plugins_dir_platform_darwin(self) -> None:
        with patch.object(sys, "platform", "darwin"):
            result = bridges.opencode_plugins_dir()
        assert result == Path.home() / ".config" / "opencode" / "plugins"

    def test_openclaw_plugins_dir(self) -> None:
        result = bridges.openclaw_plugins_dir()
        assert result == Path.home() / ".openclaw" / "plugins"

    def test_openclaw_config_path(self) -> None:
        result = bridges.openclaw_config_path()
        assert result == Path.home() / ".openclaw" / "openclaw.json"


# ---------------------------------------------------------------------------
# Opencode install / uninstall / check
# ---------------------------------------------------------------------------


class TestOpencodePlugin:
    def test_install_writes_file(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path / "plugins"):
            path_str = bridges.install_opencode_plugin()
        written = Path(path_str)
        assert written.exists()
        assert written.read_text(encoding="utf-8") == bridges.OPENCODE_PLUGIN_TS

    def test_install_creates_parent_dirs(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "plugins"
        with patch.object(bridges, "opencode_plugins_dir", return_value=nested):
            bridges.install_opencode_plugin()
        assert nested.exists()

    def test_install_returns_path_string(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges.install_opencode_plugin()
        assert isinstance(result, str)
        assert "token-goat.ts" in result

    def test_install_is_idempotent(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            bridges.install_opencode_plugin()
            bridges.install_opencode_plugin()
        assert (tmp_path / bridges._OPENCODE_FILENAME).exists()

    def test_uninstall_removes_file(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._OPENCODE_FILENAME
        _write_fake_plugin(plugin_path, bridges.OPENCODE_PLUGIN_TS)
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges.uninstall_opencode_plugin()
        assert not plugin_path.exists()
        assert "removed" in result

    def test_uninstall_not_found(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges.uninstall_opencode_plugin()
        assert result == "not found"

    def test_check_not_installed(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges._check_opencode_plugin()
        assert result == "not installed"

    def test_check_installed(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._OPENCODE_FILENAME
        _write_fake_plugin(plugin_path, bridges.OPENCODE_PLUGIN_TS)
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges._check_opencode_plugin()
        assert result == "installed"

    def test_check_foreign_file(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._OPENCODE_FILENAME
        _write_fake_plugin(plugin_path, "// some other plugin")
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            result = bridges._check_opencode_plugin()
        assert "not token-goat bridge" in result

    def test_check_after_install(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            bridges.install_opencode_plugin()
            result = bridges._check_opencode_plugin()
        assert result == "installed"

    def test_check_after_uninstall(self, tmp_path: Path) -> None:
        with patch.object(bridges, "opencode_plugins_dir", return_value=tmp_path):
            bridges.install_opencode_plugin()
            bridges.uninstall_opencode_plugin()
            result = bridges._check_opencode_plugin()
        assert result == "not installed"


# ---------------------------------------------------------------------------
# Openclaw install / uninstall / check
# ---------------------------------------------------------------------------


class TestOpenclawPlugin:
    def _patch(self, tmp_path: Path):
        plugins_dir = tmp_path / "plugins"
        cfg_path = tmp_path / "openclaw.json"
        return (
            patch.object(bridges, "openclaw_plugins_dir", return_value=plugins_dir),
            patch.object(bridges, "openclaw_config_path", return_value=cfg_path),
        )

    def test_install_writes_plugin_file(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            path_str = bridges.install_openclaw_plugin()
        assert Path(path_str).read_text(encoding="utf-8") == bridges.OPENCLAW_PLUGIN_TS

    def test_install_registers_in_config(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
        cfg = json.loads((tmp_path / "openclaw.json").read_text(encoding="utf-8"))
        entries = cfg["plugins"]["entries"]
        assert bridges._OPENCLAW_PLUGIN_ID in entries
        entry = entries[bridges._OPENCLAW_PLUGIN_ID]
        assert entry["enabled"] is True
        assert "path" in entry

    def test_install_merges_existing_config(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "openclaw.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(
            json.dumps({"other": "value", "plugins": {"entries": {"other-plugin": {"enabled": True}}}}),
            encoding="utf-8",
        )
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        assert cfg["other"] == "value"
        assert "other-plugin" in cfg["plugins"]["entries"]
        assert bridges._OPENCLAW_PLUGIN_ID in cfg["plugins"]["entries"]

    def test_install_handles_corrupt_config(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "openclaw.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text("not valid json {{{{", encoding="utf-8")
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            # Should not raise; recovers from corrupt config
            bridges.install_openclaw_plugin()
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        assert bridges._OPENCLAW_PLUGIN_ID in cfg["plugins"]["entries"]

    def test_install_creates_parent_dirs(self, tmp_path: Path) -> None:
        nested_plugins = tmp_path / "deep" / "plugins"
        cfg_path = tmp_path / "deep" / "openclaw.json"
        with (
            patch.object(bridges, "openclaw_plugins_dir", return_value=nested_plugins),
            patch.object(bridges, "openclaw_config_path", return_value=cfg_path),
        ):
            bridges.install_openclaw_plugin()
        assert nested_plugins.exists()

    def test_uninstall_removes_file_and_deregisters(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
            result = bridges.uninstall_openclaw_plugin()
        assert bridges._OPENCLAW_FILENAME not in [f.name for f in (tmp_path / "plugins").iterdir() if f.exists()] if (tmp_path / "plugins").exists() else True
        assert "deregistered" in result

    def test_uninstall_not_found(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            result = bridges.uninstall_openclaw_plugin()
        assert result == "not found"

    def test_uninstall_removes_only_our_entry(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "openclaw.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(
            json.dumps({"plugins": {"entries": {"other-plugin": {"enabled": True}}}}),
            encoding="utf-8",
        )
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
            bridges.uninstall_openclaw_plugin()
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        assert "other-plugin" in cfg["plugins"]["entries"]
        assert bridges._OPENCLAW_PLUGIN_ID not in cfg["plugins"]["entries"]

    def test_check_not_installed(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            result = bridges._check_openclaw_plugin()
        assert result == "not installed"

    def test_check_installed(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
            result = bridges._check_openclaw_plugin()
        assert result == "installed"

    def test_check_file_present_not_registered(self, tmp_path: Path) -> None:
        plugins_dir = tmp_path / "plugins"
        plugin_path = plugins_dir / bridges._OPENCLAW_FILENAME
        _write_fake_plugin(plugin_path, bridges.OPENCLAW_PLUGIN_TS)
        cfg_path = tmp_path / "openclaw.json"
        with (
            patch.object(bridges, "openclaw_plugins_dir", return_value=plugins_dir),
            patch.object(bridges, "openclaw_config_path", return_value=cfg_path),
        ):
            result = bridges._check_openclaw_plugin()
        assert "not registered" in result

    def test_check_registered_but_file_missing(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "openclaw.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(
            json.dumps({"plugins": {"entries": {bridges._OPENCLAW_PLUGIN_ID: {"enabled": True}}}}),
            encoding="utf-8",
        )
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            result = bridges._check_openclaw_plugin()
        assert "missing" in result

    def test_check_foreign_file(self, tmp_path: Path) -> None:
        plugins_dir = tmp_path / "plugins"
        cfg_path = tmp_path / "openclaw.json"
        plugin_path = plugins_dir / bridges._OPENCLAW_FILENAME
        _write_fake_plugin(plugin_path, "// some other plugin entirely")
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(
            json.dumps({"plugins": {"entries": {bridges._OPENCLAW_PLUGIN_ID: {"enabled": True}}}}),
            encoding="utf-8",
        )
        with (
            patch.object(bridges, "openclaw_plugins_dir", return_value=plugins_dir),
            patch.object(bridges, "openclaw_config_path", return_value=cfg_path),
        ):
            result = bridges._check_openclaw_plugin()
        assert "not token-goat bridge" in result

    def test_check_after_uninstall(self, tmp_path: Path) -> None:
        p1, p2 = self._patch(tmp_path)
        with p1, p2:
            bridges.install_openclaw_plugin()
            bridges.uninstall_openclaw_plugin()
            result = bridges._check_openclaw_plugin()
        assert result == "not installed"


# ---------------------------------------------------------------------------
# install.py integration: check_status, install_all, uninstall_all
# ---------------------------------------------------------------------------


class TestInstallIntegration:
    """Verify that install.py wires bridges.py correctly without hitting the filesystem."""

    def test_check_status_includes_opencode(self) -> None:
        from token_goat import install

        with (
            patch.object(install, "_check_codex_config", return_value="not installed"),
            patch.object(bridges, "_check_opencode_plugin", return_value="not installed"),
            patch.object(bridges, "_check_openclaw_plugin", return_value="not installed"),
        ):
            status = install.check_status()
        assert "opencode plugin" in status

    def test_check_status_includes_openclaw(self) -> None:
        from token_goat import install

        with (
            patch.object(install, "_check_codex_config", return_value="not installed"),
            patch.object(bridges, "_check_opencode_plugin", return_value="not installed"),
            patch.object(bridges, "_check_openclaw_plugin", return_value="not installed"),
        ):
            status = install.check_status()
        assert "openclaw plugin" in status

    def test_install_all_opencode_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_opencode_plugin", return_value="/fake/path") as mock_install,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(install_opencode=True)
        mock_install.assert_called_once()
        assert "opencode: plugin" in result
        assert "ok" in result["opencode: plugin"]

    def test_install_all_openclaw_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_openclaw_plugin", return_value="/fake/path") as mock_install,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(install_openclaw=True)
        mock_install.assert_called_once()
        assert "openclaw: plugin" in result

    def test_install_all_bridges_not_called_without_flags(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_opencode_plugin") as mock_oc,
            patch.object(bridges, "install_openclaw_plugin") as mock_oclaw,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            install.install_all()
        mock_oc.assert_not_called()
        mock_oclaw.assert_not_called()

    def test_uninstall_all_opencode_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "uninstall_opencode_plugin", return_value="removed") as mock_un,
            patch.object(install, "_stop_worker", return_value="stopped"),
            patch.object(install, "unpatch_settings_json", return_value="ok"),
            patch.object(install, "unpatch_claude_md", return_value="ok"),
            patch.object(install, "remove_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            _patch_platform_uninstalls(install),
        ):
            result = install.uninstall_all(opencode=True)
        mock_un.assert_called_once()
        assert "opencode: plugin" in result

    def test_uninstall_all_openclaw_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "uninstall_openclaw_plugin", return_value="removed") as mock_un,
            patch.object(install, "_stop_worker", return_value="stopped"),
            patch.object(install, "unpatch_settings_json", return_value="ok"),
            patch.object(install, "unpatch_claude_md", return_value="ok"),
            patch.object(install, "remove_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            _patch_platform_uninstalls(install),
        ):
            result = install.uninstall_all(openclaw=True)
        mock_un.assert_called_once()
        assert "openclaw: plugin" in result

    def test_uninstall_all_bridges_not_called_without_flags(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "uninstall_opencode_plugin") as mock_oc,
            patch.object(bridges, "uninstall_openclaw_plugin") as mock_oclaw,
            patch.object(install, "_stop_worker", return_value="stopped"),
            patch.object(install, "unpatch_settings_json", return_value="ok"),
            patch.object(install, "unpatch_claude_md", return_value="ok"),
            patch.object(install, "remove_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            _patch_platform_uninstalls(install),
        ):
            install.uninstall_all()
        mock_oc.assert_not_called()
        mock_oclaw.assert_not_called()

    def test_install_all_opencode_fail_soft(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_opencode_plugin", side_effect=RuntimeError("disk full")),
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(install_opencode=True)
        assert "FAIL" in result["opencode: plugin"]


# ---------------------------------------------------------------------------
# Platform-neutral install/uninstall patch helpers
# ---------------------------------------------------------------------------


@contextmanager
def _patch_platform_installs(install_mod) -> Iterator[None]:  # type: ignore[type-arg]
    """Patch all platform-specific install steps to avoid touching the real system."""
    with (
        patch.object(install_mod, "install_worker_task", return_value=(True, "ok")),
        patch.object(install_mod, "install_update_task", return_value=(True, "ok")),
        patch.object(install_mod, "install_linux_autostart", return_value=(True, "ok")),
        patch.object(install_mod, "install_linux_update_cron", return_value=(True, "ok")),
        patch.object(install_mod, "install_mac_autostart", return_value=(True, "ok")),
    ):
        yield


@contextmanager
def _patch_platform_uninstalls(install_mod) -> Iterator[None]:  # type: ignore[type-arg]
    """Patch all platform-specific uninstall steps."""
    with (
        patch.object(install_mod, "uninstall_tasks", return_value=[]),
        patch.object(install_mod, "uninstall_linux_autostart", return_value=[]),
        patch.object(install_mod, "uninstall_linux_update_cron", return_value="ok"),
        patch.object(install_mod, "uninstall_mac_autostart", return_value=[]),
    ):
        yield
