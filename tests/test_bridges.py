"""Tests for bridges.py — opencode and openclaw bridge plugin install/check/uninstall."""
from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from token_goat import bridges, hook_registry

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

    def test_opencode_ts_bash_routes_to_post_bash(self) -> None:
        # Bash output caching requires post-bash, not post-read.
        # opencode now uses a POST_HOOK table (same as openclaw) instead of a ternary chain.
        assert "post-bash" in bridges.OPENCODE_PLUGIN_TS
        assert 'Bash: "post-bash"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_webfetch_routes_to_post_fetch(self) -> None:
        # Web-fetch caching requires post-fetch, not post-read.
        assert 'WebFetch: "post-fetch"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_has_post_hook_table(self) -> None:
        # opencode now uses a POST_HOOK lookup table, mirroring openclaw's pattern.
        assert "POST_HOOK" in bridges.OPENCODE_PLUGIN_TS
        assert 'Edit: "post-edit"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_post_hook_table_used_in_after_handler(self) -> None:
        # The after handler must dispatch via POST_HOOK, not a ternary chain.
        assert "POST_HOOK[tgTool]" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_bash_routes_to_post_bash(self) -> None:
        # Bash output caching requires post-bash, not post-read.
        assert 'Bash: "post-bash"' in bridges.OPENCLAW_PLUGIN_TS

    def test_openclaw_ts_webfetch_routes_to_post_fetch(self) -> None:
        # Web-fetch caching requires post-fetch, not post-read.
        assert 'WebFetch: "post-fetch"' in bridges.OPENCLAW_PLUGIN_TS

    # --- PRE_HOOK_TOOLS guard tests ---

    def test_opencode_ts_has_pre_hook_tools_guard(self) -> None:
        # The before handler must skip pre-hook dispatch for edit-type tools.
        # Edit/Write/apply_patch have no pre-hook in token-goat.
        assert "PRE_HOOK_TOOLS" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_has_pre_hook_tools_guard(self) -> None:
        # Same guard required in openclaw's before_tool_call handler.
        assert "PRE_HOOK_TOOLS" in bridges.OPENCLAW_PLUGIN_TS

    def test_opencode_ts_pre_hook_guard_skips_edit(self) -> None:
        # The guard expression must check whether the resolved tgTool is in the
        # PRE_HOOK_TOOLS set and return early when it is not.
        assert "PRE_HOOK_TOOLS.has(tgTool)" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_pre_hook_guard_skips_edit(self) -> None:
        assert "PRE_HOOK_TOOLS.has(tgTool)" in bridges.OPENCLAW_PLUGIN_TS

    def test_opencode_ts_pre_hook_tools_excludes_edit(self) -> None:
        # PRE_HOOK_TOOLS must NOT include Edit or Write — only read/search/fetch tools.
        # Verify by checking that Edit is absent from the PRE_HOOK_TOOLS initializer
        # (the set literal lists only Read, Grep, Glob, Bash, WebFetch).
        import re
        match = re.search(r'const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)', bridges.OPENCODE_PLUGIN_TS)
        assert match, "PRE_HOOK_TOOLS Set literal not found in OPENCODE_PLUGIN_TS"
        members = match.group(1)
        assert '"Edit"' not in members
        assert '"Write"' not in members
        assert '"Read"' in members
        assert '"Bash"' in members

    def test_openclaw_ts_pre_hook_tools_excludes_edit(self) -> None:
        import re
        match = re.search(r'const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)', bridges.OPENCLAW_PLUGIN_TS)
        assert match, "PRE_HOOK_TOOLS Set literal not found in OPENCLAW_PLUGIN_TS"
        members = match.group(1)
        assert '"Edit"' not in members
        assert '"Write"' not in members
        assert '"Read"' in members
        assert '"Bash"' in members

    # --- callHook error handling tests ---

    def test_opencode_ts_callhook_checks_r_error(self) -> None:
        # callHook must return null immediately when spawnSync sets r.error
        # (binary not found / ENOENT) rather than proceeding to stdout parsing.
        assert "r.error" in bridges.OPENCODE_PLUGIN_TS

    def test_openclaw_ts_callhook_checks_r_error(self) -> None:
        assert "r.error" in bridges.OPENCLAW_PLUGIN_TS

    def test_opencode_ts_callhook_error_before_stdout(self) -> None:
        # The r.error guard must appear before the stdout check to avoid
        # dereferencing stdout on a failed spawn.
        oc = bridges.OPENCODE_PLUGIN_TS
        error_pos = oc.find("r.error")
        stdout_pos = oc.find("r.stdout")
        assert error_pos != -1 and stdout_pos != -1
        assert error_pos < stdout_pos, "r.error check must precede r.stdout access"

    def test_openclaw_ts_callhook_error_before_stdout(self) -> None:
        ocl = bridges.OPENCLAW_PLUGIN_TS
        error_pos = ocl.find("r.error")
        stdout_pos = ocl.find("r.stdout")
        assert error_pos != -1 and stdout_pos != -1
        assert error_pos < stdout_pos, "r.error check must precede r.stdout access"

    # --- opencode PreCompact / experimental.session.compacting tests ---

    def test_opencode_ts_precompact_calls_pre_compact_hook(self) -> None:
        # The compacting handler must call callHook("pre-compact", ...).
        assert 'callHook("pre-compact"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_precompact_passes_session_id(self) -> None:
        # The compacting handler must forward input.sessionID as session_id.
        # Verify both the source field (input.sessionID) and the dest key (session_id).
        oc = bridges.OPENCODE_PLUGIN_TS
        assert "input.sessionID" in oc
        # The pre-compact call must include session_id: input.sessionID
        assert "session_id: input.sessionID" in oc

    def test_opencode_ts_precompact_extracts_systemMessage(self) -> None:
        # The compacting handler must extract resp["systemMessage"] from the hook response.
        assert '"systemMessage"' in bridges.OPENCODE_PLUGIN_TS

    def test_opencode_ts_precompact_uses_context_push(self) -> None:
        # Injection must use output.context.push(), not output.context.set() or any other API.
        oc = bridges.OPENCODE_PLUGIN_TS
        assert "output.context.push(" in oc

    def test_opencode_ts_precompact_guards_empty_manifest(self) -> None:
        # The compacting handler must guard with `if (manifest)` before calling push.
        # An empty string or undefined systemMessage must not inject an empty context entry.
        oc = bridges.OPENCODE_PLUGIN_TS
        # The guard must appear BEFORE the push call in the source.
        guard_pos = oc.find("if (manifest)")
        push_pos = oc.find("output.context.push(")
        assert guard_pos != -1, "if (manifest) guard not found in OPENCODE_PLUGIN_TS"
        assert push_pos != -1, "output.context.push not found in OPENCODE_PLUGIN_TS"
        assert guard_pos < push_pos, "if (manifest) guard must precede output.context.push call"

    def test_opencode_ts_precompact_push_inside_guard(self) -> None:
        # Verify the structural invariant: push is inside the `if (manifest)` block.
        # Extract the compacting handler body and confirm the guard wraps the push.
        oc = bridges.OPENCODE_PLUGIN_TS
        compact_start = oc.find('"experimental.session.compacting"')
        assert compact_start != -1, "compacting handler not found"
        handler_body = oc[compact_start:]
        # Within the compacting handler, `if (manifest)` must appear before push.
        guard_in_handler = handler_body.find("if (manifest)")
        push_in_handler = handler_body.find("output.context.push(")
        assert guard_in_handler != -1, "if (manifest) guard not in compacting handler scope"
        assert push_in_handler != -1, "output.context.push not in compacting handler scope"
        assert guard_in_handler < push_in_handler

    def test_opencode_ts_precompact_no_unconditional_push(self) -> None:
        # There must not be an unconditional output.context.push() call.
        # The only push must be inside the `if (manifest)` guard.
        oc = bridges.OPENCODE_PLUGIN_TS
        # Count occurrences of `output.context.push(` — must be exactly one (the guarded one).
        push_count = oc.count("output.context.push(")
        assert push_count == 1, (
            f"Expected exactly 1 output.context.push call (guarded), found {push_count}"
        )

    # --- pi extension TS source smoke checks ---

    def test_pi_ts_contains_spawnSync(self) -> None:
        assert "spawnSync" in bridges.PI_EXTENSION_TS

    def test_pi_ts_contains_token_goat(self) -> None:
        assert "token-goat" in bridges.PI_EXTENSION_TS

    def test_pi_ts_exports_default_factory(self) -> None:
        assert "export default function" in bridges.PI_EXTENSION_TS

    def test_pi_ts_imports_extension_api(self) -> None:
        # The factory's single argument is typed against pi's ExtensionAPI.
        assert "ExtensionAPI" in bridges.PI_EXTENSION_TS
        assert "@earendil-works/pi-coding-agent" in bridges.PI_EXTENSION_TS

    def test_pi_ts_subscribes_session_start(self) -> None:
        assert 'pi.on("session_start"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_subscribes_tool_call(self) -> None:
        assert 'pi.on("tool_call"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_subscribes_tool_result(self) -> None:
        assert 'pi.on("tool_result"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_subscribes_compaction_events(self) -> None:
        assert 'pi.on("session_before_compact"' in bridges.PI_EXTENSION_TS
        assert 'pi.on("session_compact"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_maps_read_tool(self) -> None:
        # TS object keys are unquoted: `read: "Read",`
        assert 'read: "Read"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_maps_find_to_glob(self) -> None:
        # pi's find tool is the glob-equivalent.
        assert 'find: "Glob"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_has_deny_support(self) -> None:
        assert "block: true" in bridges.PI_EXTENSION_TS

    def test_pi_ts_has_updated_input_support(self) -> None:
        assert "updatedInput" in bridges.PI_EXTENSION_TS

    def test_pi_ts_bash_routes_to_post_bash(self) -> None:
        assert 'Bash: "post-bash"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_post_edit_for_write(self) -> None:
        assert 'Write: "post-edit"' in bridges.PI_EXTENSION_TS

    def test_pi_ts_has_post_hook_table(self) -> None:
        assert "POST_HOOK" in bridges.PI_EXTENSION_TS
        assert "POST_HOOK[tg]" in bridges.PI_EXTENSION_TS

    def test_pi_ts_has_pre_hook_tools_guard(self) -> None:
        assert "PRE_HOOK_TOOLS" in bridges.PI_EXTENSION_TS
        assert "PRE_HOOK_TOOLS.has(tg)" in bridges.PI_EXTENSION_TS

    def test_pi_ts_pre_hook_tools_excludes_edit(self) -> None:
        match = re.search(r'const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)', bridges.PI_EXTENSION_TS)
        assert match, "PRE_HOOK_TOOLS Set literal not found in PI_EXTENSION_TS"
        members = match.group(1)
        assert '"Edit"' not in members
        assert '"Write"' not in members
        assert '"Read"' in members
        assert '"Bash"' in members

    def test_pi_ts_callhook_checks_r_error(self) -> None:
        assert "r.error" in bridges.PI_EXTENSION_TS

    def test_pi_ts_callhook_error_before_stdout(self) -> None:
        pts = bridges.PI_EXTENSION_TS
        error_pos = pts.find("r.error")
        stdout_pos = pts.find("r.stdout")
        assert error_pos != -1 and stdout_pos != -1
        assert error_pos < stdout_pos, "r.error check must precede r.stdout access"

    def test_pi_ts_no_backslash_escapes(self) -> None:
        # The TS is embedded in a plain (non-raw) Python triple-quoted string.
        # Backslashes would risk invalid-escape SyntaxWarnings and corrupted
        # regex, so the source must avoid them entirely.
        assert "\\" not in bridges.PI_EXTENSION_TS


# ---------------------------------------------------------------------------
# Bridge TS event-table alignment with hook_registry
# ---------------------------------------------------------------------------


_EVENT_PREFIXES = re.compile(r'^(?:pre|post|session|user|subagent)-')


def _extract_bridge_events(ts_source: str) -> set[str]:
    """Return every hook-event name string referenced in *ts_source*.

    Covers three patterns:
    1. Direct callHook first argument:  callHook("session-start", ...)
    2. POST_HOOK table values:          Bash: "post-bash",
    3. Ternary / variable assignments:  ? "pre-fetch" : "pre-read"

    Only strings matching the canonical event prefix pattern
    (pre-, post-, session-, user-, subagent-) are collected, which filters
    out incidental hyphenated strings like "token-goat" or "before_tool_call".
    """
    all_quoted = set(re.findall(r'["\']([a-z][a-z0-9-]+)["\']', ts_source))
    return {v for v in all_quoted if _EVENT_PREFIXES.match(v)}


class TestBridgeEventRegistryAlignment:
    """Verify every event name hard-coded in the bridge TS strings is registered
    in hook_registry.  A rename in hook_registry that leaves the bridge TS stale
    would silently produce no-op hook calls; this test catches that drift."""

    def test_opencode_events_all_registered(self) -> None:
        canonical = set(hook_registry.all_events())
        bridge_events = _extract_bridge_events(bridges.OPENCODE_PLUGIN_TS)
        assert bridge_events, "regex found no event names in OPENCODE_PLUGIN_TS — pattern may need update"
        unknown = bridge_events - canonical
        assert not unknown, (
            f"OPENCODE_PLUGIN_TS references event(s) not in hook_registry: {sorted(unknown)}\n"
            f"Canonical events: {sorted(canonical)}"
        )

    def test_openclaw_events_all_registered(self) -> None:
        canonical = set(hook_registry.all_events())
        bridge_events = _extract_bridge_events(bridges.OPENCLAW_PLUGIN_TS)
        assert bridge_events, "regex found no event names in OPENCLAW_PLUGIN_TS — pattern may need update"
        unknown = bridge_events - canonical
        assert not unknown, (
            f"OPENCLAW_PLUGIN_TS references event(s) not in hook_registry: {sorted(unknown)}\n"
            f"Canonical events: {sorted(canonical)}"
        )

    def test_pi_events_all_registered(self) -> None:
        canonical = set(hook_registry.all_events())
        bridge_events = _extract_bridge_events(bridges.PI_EXTENSION_TS)
        assert bridge_events, "regex found no event names in PI_EXTENSION_TS — pattern may need update"
        unknown = bridge_events - canonical
        assert not unknown, (
            f"PI_EXTENSION_TS references event(s) not in hook_registry: {sorted(unknown)}\n"
            f"Canonical events: {sorted(canonical)}"
        )

    def test_combined_bridge_events_cover_common_subset(self) -> None:
        """Each bridge must reference the core events appropriate for its harness.

        opencode and pi have compaction support, so they must include
        pre-compact.  openclaw has no compaction API, so pre-compact is
        intentionally absent there.
        """
        # Events required in both bridges (common integration surface)
        shared_core = {"session-start", "pre-read", "pre-fetch", "post-edit", "post-bash"}
        # Events only required where the harness supports them
        compaction_bridges = {"pre-compact"}

        opencode_events = _extract_bridge_events(bridges.OPENCODE_PLUGIN_TS)
        openclaw_events = _extract_bridge_events(bridges.OPENCLAW_PLUGIN_TS)
        pi_events = _extract_bridge_events(bridges.PI_EXTENSION_TS)

        for event in shared_core:
            assert event in opencode_events, f"shared core event '{event}' missing from OPENCODE_PLUGIN_TS"
            assert event in openclaw_events, f"shared core event '{event}' missing from OPENCLAW_PLUGIN_TS"
            assert event in pi_events, f"shared core event '{event}' missing from PI_EXTENSION_TS"

        for event in compaction_bridges:
            assert event in opencode_events, f"compaction event '{event}' missing from OPENCODE_PLUGIN_TS"
            assert event in pi_events, f"compaction event '{event}' missing from PI_EXTENSION_TS"


# ---------------------------------------------------------------------------
# Shared file-level helpers
# ---------------------------------------------------------------------------


class TestWritePluginFile:
    def test_writes_content(self, tmp_path: Path) -> None:
        result = bridges._write_plugin_file(tmp_path, "foo.ts", "content here")
        assert result.read_text(encoding="utf-8") == "content here"

    def test_returns_absolute_path(self, tmp_path: Path) -> None:
        result = bridges._write_plugin_file(tmp_path, "foo.ts", "x")
        assert result.is_absolute()
        assert result.name == "foo.ts"

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "c"
        bridges._write_plugin_file(nested, "foo.ts", "x")
        assert nested.is_dir()

    def test_idempotent_overwrite(self, tmp_path: Path) -> None:
        bridges._write_plugin_file(tmp_path, "foo.ts", "first")
        bridges._write_plugin_file(tmp_path, "foo.ts", "second")
        assert (tmp_path / "foo.ts").read_text(encoding="utf-8") == "second"


class TestRemovePluginFile:
    def test_removes_existing_file(self, tmp_path: Path) -> None:
        p = tmp_path / "foo.ts"
        p.write_text("x", encoding="utf-8")
        result = bridges._remove_plugin_file(p)
        assert not p.exists()
        assert "removed" in result
        assert str(p) in result

    def test_returns_not_found_when_absent(self, tmp_path: Path) -> None:
        result = bridges._remove_plugin_file(tmp_path / "missing.ts")
        assert result == "not found"


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

    def test_pi_extensions_dir(self) -> None:
        result = bridges.pi_extensions_dir()
        assert result == Path.home() / ".pi" / "agent" / "extensions"

    def test_pi_plugin_path_default(self) -> None:
        result = bridges.pi_plugin_path()
        assert result == bridges.pi_extensions_dir() / bridges._PI_FILENAME

    def test_pi_plugin_path_target_dir(self, tmp_path: Path) -> None:
        target = tmp_path / "proj" / ".pi" / "extensions"
        result = bridges.pi_plugin_path(target)
        assert result == target / bridges._PI_FILENAME


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
# Pi install / uninstall / check
# ---------------------------------------------------------------------------


class TestPiPlugin:
    def test_install_writes_file(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path / "extensions"):
            path_str = bridges.install_pi_plugin()
        written = Path(path_str)
        assert written.exists()
        assert written.read_text(encoding="utf-8") == bridges.PI_EXTENSION_TS

    def test_install_creates_parent_dirs(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "extensions"
        with patch.object(bridges, "pi_extensions_dir", return_value=nested):
            bridges.install_pi_plugin()
        assert nested.exists()

    def test_install_returns_path_string(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges.install_pi_plugin()
        assert isinstance(result, str)
        assert "token-goat.ts" in result

    def test_install_target_dir_overrides_global(self, tmp_path: Path) -> None:
        # Project-local install: target_dir wins over pi_extensions_dir().
        proj = tmp_path / "proj" / ".pi" / "extensions"
        global_dir = tmp_path / "global"
        with patch.object(bridges, "pi_extensions_dir", return_value=global_dir):
            path_str = bridges.install_pi_plugin(target_dir=proj)
        assert Path(path_str) == proj / bridges._PI_FILENAME
        assert (proj / bridges._PI_FILENAME).exists()
        assert not global_dir.exists()

    def test_install_is_idempotent(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            bridges.install_pi_plugin()
            bridges.install_pi_plugin()
        assert (tmp_path / bridges._PI_FILENAME).exists()

    def test_uninstall_removes_file(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._PI_FILENAME
        _write_fake_plugin(plugin_path, bridges.PI_EXTENSION_TS)
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges.uninstall_pi_plugin()
        assert not plugin_path.exists()
        assert "removed" in result

    def test_uninstall_target_dir(self, tmp_path: Path) -> None:
        proj = tmp_path / "proj" / ".pi" / "extensions"
        bridges.install_pi_plugin(target_dir=proj)
        result = bridges.uninstall_pi_plugin(target_dir=proj)
        assert "removed" in result
        assert not (proj / bridges._PI_FILENAME).exists()

    def test_uninstall_not_found(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges.uninstall_pi_plugin()
        assert result == "not found"

    def test_check_not_installed(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges._check_pi_plugin()
        assert result == "not installed"

    def test_check_installed(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._PI_FILENAME
        _write_fake_plugin(plugin_path, bridges.PI_EXTENSION_TS)
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges._check_pi_plugin()
        assert result == "installed"

    def test_check_foreign_file(self, tmp_path: Path) -> None:
        plugin_path = tmp_path / bridges._PI_FILENAME
        _write_fake_plugin(plugin_path, "// some other extension")
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            result = bridges._check_pi_plugin()
        assert "not token-goat bridge" in result

    def test_check_after_install_uninstall(self, tmp_path: Path) -> None:
        with patch.object(bridges, "pi_extensions_dir", return_value=tmp_path):
            bridges.install_pi_plugin()
            assert bridges._check_pi_plugin() == "installed"
            bridges.uninstall_pi_plugin()
            assert bridges._check_pi_plugin() == "not installed"


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

    def test_check_status_includes_pi(self) -> None:
        from token_goat import install

        with (
            patch.object(install, "_check_codex_config", return_value="not installed"),
            patch.object(bridges, "_check_opencode_plugin", return_value="not installed"),
            patch.object(bridges, "_check_openclaw_plugin", return_value="not installed"),
            patch.object(bridges, "_check_pi_plugin", return_value="not installed"),
        ):
            status = install.check_status()
        assert "pi plugin" in status

    def test_install_all_pi_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_pi_plugin", return_value="/fake/path") as mock_install,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(install_pi=True)
        mock_install.assert_called_once()
        assert "pi: extension" in result
        assert "ok" in result["pi: extension"]

    def test_install_all_pi_via_target(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_pi_plugin", return_value="/fake/path") as mock_install,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(targets={"pi"})
        mock_install.assert_called_once()
        assert "pi: extension" in result

    def test_install_all_pi_not_called_without_flag(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_pi_plugin") as mock_pi,
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            install.install_all()
        mock_pi.assert_not_called()

    def test_uninstall_all_pi_called_when_flag_set(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "uninstall_pi_plugin", return_value="removed") as mock_un,
            patch.object(install, "_stop_worker", return_value="stopped"),
            patch.object(install, "unpatch_settings_json", return_value="ok"),
            patch.object(install, "unpatch_claude_md", return_value="ok"),
            patch.object(install, "remove_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            _patch_platform_uninstalls(install),
        ):
            result = install.uninstall_all(pi=True)
        mock_un.assert_called_once()
        assert "pi: extension" in result

    def test_install_all_pi_fail_soft(self) -> None:
        from token_goat import install

        with (
            patch.object(bridges, "install_pi_plugin", side_effect=RuntimeError("disk full")),
            patch.object(install, "patch_settings_json", return_value=(True, "ok")),
            patch.object(install, "patch_claude_md", return_value="ok"),
            patch.object(install, "write_skill", return_value="ok"),
            patch.object(install, "_remove_legacy_launchers", return_value=[]),
            patch("token_goat.worker.ensure_running", return_value=0),
            _patch_platform_installs(install),
        ):
            result = install.install_all(install_pi=True)
        assert "FAIL" in result["pi: extension"]

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
