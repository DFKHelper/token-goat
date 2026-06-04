"""TypeScript bridge plugins for opencode and openclaw interoperability.

Each bridge is a thin TypeScript file that shims the harness-specific plugin API
into token-goat's subprocess hook protocol via child_process.spawnSync.

Supported harnesses
-------------------
opencode  — sst/opencode in-process plugin system; hooks via tool.execute.before/after
            and experimental.session.compacting.
openclaw  — openclawlab plugin system; hooks via before_tool_call / after_tool_call.
"""
from __future__ import annotations

__all__ = [
    "OPENCODE_PLUGIN_TS",
    "OPENCLAW_PLUGIN_TS",
    "install_openclaw_plugin",
    "install_opencode_plugin",
    "openclaw_config_path",
    "openclaw_plugins_dir",
    "opencode_plugins_dir",
    "uninstall_openclaw_plugin",
    "uninstall_opencode_plugin",
]

import json
import os
import sys
from pathlib import Path
from typing import cast

from . import paths
from .util import get_logger

_LOG = get_logger("bridges")

# Maximum size for user-controlled config files (openclaw.json, etc.).
# Prevents OOM from a maliciously large or corrupted config file.
_MAX_CONFIG_BYTES = 1 * 1024 * 1024  # 1 MB


def _load_json_config(path: Path) -> dict[str, object]:
    """Read and parse a JSON config file with a size cap.

    Raises OSError if the file cannot be read, json.JSONDecodeError if the
    content is not valid JSON, and ValueError if the file exceeds 1 MB (guard
    against a maliciously large config consuming unbounded memory).
    """
    try:
        size = path.stat().st_size
    except OSError as e:
        raise OSError(f"could not stat config file {path}: {e}") from e
    if size > _MAX_CONFIG_BYTES:
        raise ValueError(
            f"config file too large ({size} bytes > {_MAX_CONFIG_BYTES} limit): {path}"
        )
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise json.JSONDecodeError(
            f"expected JSON object, got {type(data).__name__}", raw, 0
        )
    # After the isinstance guard, data is dict[str, Any].  We cast to
    # dict[str, object] (the return annotation) which is sound: object is the
    # base of all types, so every value in dict[str, Any] satisfies object.
    return cast(dict[str, object], data)


def _save_json_config(path: Path, cfg: dict[str, object]) -> None:
    """Serialise *cfg* as indented JSON and write atomically to *path*.

    Uses a trailing newline so the file is POSIX-compliant and diff-friendly.
    The directory must already exist; callers are responsible for mkdir.
    """
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

# ---------------------------------------------------------------------------
# TypeScript bridge sources
# ---------------------------------------------------------------------------

OPENCODE_PLUGIN_TS = """\
// token-goat bridge plugin for opencode
// Bridges opencode's plugin API to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import { spawnSync } from "child_process";

const TOOL_TO_TG: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  apply_patch: "Edit",
  shell: "Bash",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
};

// opencode uses camelCase args; token-goat expects snake_case tool_input
const ARGS_TO_TG: Record<string, Record<string, string>> = {
  read: { filePath: "file_path", offset: "offset", limit: "limit" },
  edit: { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" },
  apply_patch: { patchText: "patch_text" },
  shell: { command: "command" },
  bash: { command: "command" },
  grep: { pattern: "pattern", path: "path", include: "glob" },
  glob: { pattern: "pattern", path: "path" },
  webfetch: { url: "url", prompt: "prompt" },
};

// Post-call hook event per token-goat tool name (mirrors openclaw's POST_HOOK table)
const POST_HOOK: Record<string, string> = {
  Read: "post-read",
  Grep: "post-read",
  Glob: "post-read",
  Bash: "post-bash",
  WebFetch: "post-fetch",
  Edit: "post-edit",
  Write: "post-edit",
};

// Tools that have a pre-hook (read/search/fetch types only).
// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "WebFetch"]);

const _seenSessions = new Set<string>();

function reverseArgMap(tool: string): Record<string, string> {
  const fwd = ARGS_TO_TG[tool] ?? {};
  return Object.fromEntries(Object.entries(fwd).map(([cc, tg]) => [tg, cc]));
}

function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = spawnSync("token-goat", ["hook", event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = r.stdout?.trim();
    if (!out) return null;
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const server = async (pluginInput: { directory: string }) => {
  const cwd = pluginInput.directory;

  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => {
      const tgTool = TOOL_TO_TG[input.tool];
      if (!tgTool) return;

      if (!_seenSessions.has(input.sessionID)) {
        _seenSessions.add(input.sessionID);
        callHook("session-start", { session_id: input.sessionID, cwd });
      }

      // Edit/Write/apply_patch only have post-hooks; skip pre-hook dispatch.
      if (!PRE_HOOK_TOOLS.has(tgTool)) return;

      const argMap = ARGS_TO_TG[input.tool] ?? {};
      const toolInput: Record<string, unknown> = {};
      for (const [ccKey, tgKey] of Object.entries(argMap)) {
        if (output.args[ccKey] !== undefined) toolInput[tgKey] = output.args[ccKey];
      }

      const hookEvent = tgTool === "WebFetch" ? "pre-fetch" : "pre-read";
      const resp = callHook(hookEvent, {
        session_id: input.sessionID,
        tool_name: tgTool,
        tool_input: toolInput,
        cwd,
      });
      if (!resp) return;

      const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
      const updated = hso?.["updatedInput"] as Record<string, unknown> | undefined;
      if (updated) {
        const rev = reverseArgMap(input.tool);
        for (const [tgKey, val] of Object.entries(updated)) {
          output.args[rev[tgKey] ?? tgKey] = val;
        }
      }
    },

    "tool.execute.after": async (input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: Record<string, unknown>;
    }) => {
      const tgTool = TOOL_TO_TG[input.tool];
      if (!tgTool) return;

      const argMap = ARGS_TO_TG[input.tool] ?? {};
      const toolInput: Record<string, unknown> = {};
      for (const [ccKey, tgKey] of Object.entries(argMap)) {
        if (input.args[ccKey] !== undefined) toolInput[tgKey] = input.args[ccKey];
      }

      callHook(POST_HOOK[tgTool] ?? "post-read", {
        session_id: input.sessionID,
        tool_name: tgTool,
        tool_input: toolInput,
        cwd,
      });
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[] },
    ) => {
      const resp = callHook("pre-compact", { session_id: input.sessionID, trigger: "auto" });
      const manifest = resp?.["systemMessage"] as string | undefined;
      if (manifest) output.context.push(manifest);
    },
  };
};
"""

OPENCLAW_PLUGIN_TS = """\
// token-goat bridge plugin for openclaw
// Bridges openclaw's plugin API to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import { spawnSync } from "child_process";

// openclaw tool names → token-goat internal tool names
const TOOL_TO_TG: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  exec: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
};

// Post-call hook event per token-goat tool name
const POST_HOOK: Record<string, string> = {
  Read: "post-read",
  Grep: "post-read",
  Glob: "post-read",
  Bash: "post-bash",
  WebFetch: "post-fetch",
  Edit: "post-edit",
  Write: "post-edit",
};

// Tools that have a pre-hook (read/search/fetch types only).
// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "WebFetch"]);

// Stable pseudo-session for this process lifetime (openclaw has no session concept)
const SESSION_ID = `openclaw-${process.pid}-${Date.now()}`;

function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = spawnSync("token-goat", ["hook", event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = r.stdout?.trim();
    if (!out) return null;
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Fire session-start once when the plugin module is loaded
callHook("session-start", { session_id: SESSION_ID, cwd: process.cwd() });

export default {
  id: "token-goat-bridge",
  name: "token-goat",

  register(api: any): void {
    api.on("before_tool_call", async (event: any) => {
      const tgTool = TOOL_TO_TG[event.toolName];
      if (!tgTool) return {};

      // Edit/Write/apply_patch only have post-hooks; skip pre-hook dispatch.
      if (!PRE_HOOK_TOOLS.has(tgTool)) return {};

      const hookEvent = tgTool === "WebFetch" ? "pre-fetch" : "pre-read";
      const resp = callHook(hookEvent, {
        session_id: SESSION_ID,
        tool_name: tgTool,
        tool_input: event.params ?? {},
        cwd: process.cwd(),
      });
      if (!resp) return {};

      const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
      if (!hso) return {};

      // Deny: block the tool call with a reason
      if (hso["permissionDecision"] === "deny") {
        return {
          block: true,
          blockReason: (hso["permissionDecisionReason"] as string) ?? "blocked by token-goat",
        };
      }

      // Update: redirect to modified params (e.g. image-shrunk file path)
      const updated = hso["updatedInput"] as Record<string, unknown> | undefined;
      if (updated) {
        return { params: { ...event.params, ...updated } };
      }

      return {};
    });

    api.on("after_tool_call", async (event: any) => {
      const tgTool = TOOL_TO_TG[event.toolName];
      if (!tgTool) return;

      callHook(POST_HOOK[tgTool] ?? "post-read", {
        session_id: SESSION_ID,
        tool_name: tgTool,
        tool_input: event.params ?? {},
        cwd: process.cwd(),
      });
    });
  },
};
"""

# ---------------------------------------------------------------------------
# Shared file-level install / uninstall helpers
# ---------------------------------------------------------------------------


def _write_plugin_file(plugins_dir: Path, filename: str, content: str) -> Path:
    """Write *content* to *plugins_dir*/*filename*, creating parent directories.

    Returns the absolute path of the written file.  Both opencode and openclaw
    share this step; the only difference is the filename and content string.
    """
    paths.ensure_dir(plugins_dir)
    plugin_path = plugins_dir / filename
    plugin_path.write_text(content, encoding="utf-8")
    return plugin_path


def _remove_plugin_file(plugin_path: Path) -> str:
    """Remove *plugin_path* if it exists and return a human-readable status.

    Returns ``"removed <path>"`` on success or ``"not found"`` if the file was
    absent.  Both opencode and openclaw share this step; the openclaw uninstall
    additionally deregisters from openclaw.json after calling this helper.
    """
    if plugin_path.exists():
        plugin_path.unlink()
        return f"removed {plugin_path}"
    return "not found"


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def opencode_plugins_dir() -> Path:
    """Return the opencode plugins directory (platform-aware)."""
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return appdata / "opencode" / "plugins"
    # XDG on Linux and macOS
    return Path.home() / ".config" / "opencode" / "plugins"


def openclaw_plugins_dir() -> Path:
    """Return the openclaw plugins directory (~/.openclaw/plugins)."""
    return Path.home() / ".openclaw" / "plugins"


def openclaw_config_path() -> Path:
    """Return the openclaw config file path (~/.openclaw/openclaw.json)."""
    return Path.home() / ".openclaw" / "openclaw.json"


# ---------------------------------------------------------------------------
# Opencode install / uninstall / check
# ---------------------------------------------------------------------------

# Strings that must appear in any token-goat bridge plugin file to confirm it
# is ours (not a leftover from another tool).  Both opencode and openclaw
# plugins share the same fingerprint because they are generated from the same
# template and always contain these markers.
_PLUGIN_FINGERPRINT: tuple[str, ...] = ("token-goat", "spawnSync")

_OPENCODE_FILENAME = "token-goat.ts"


def _check_plugin_file(plugin_path: Path) -> str:
    """Return a status string for a simple single-file bridge plugin.

    Returns one of:
    - ``"not installed"``  — *plugin_path* does not exist
    - ``"installed"``      — file exists and contains all fingerprint strings
    - ``"present but not token-goat bridge"`` — file exists but fingerprint missing
    - ``"error reading plugin file"`` — OSError while reading
    """
    if not plugin_path.exists():
        return "not installed"
    try:
        content = plugin_path.read_text(encoding="utf-8")
        if all(fp in content for fp in _PLUGIN_FINGERPRINT):
            return "installed"
        return "present but not token-goat bridge"
    except OSError as e:
        _LOG.warning("opencode plugin status check failed reading %s: %s", plugin_path, e)
        return "error reading plugin file"


def install_opencode_plugin() -> str:
    """Write the opencode bridge plugin to the opencode plugins directory. Returns the path."""
    plugin_path = _write_plugin_file(opencode_plugins_dir(), _OPENCODE_FILENAME, OPENCODE_PLUGIN_TS)
    _LOG.info("opencode plugin written: %s", plugin_path)
    return str(plugin_path)


def uninstall_opencode_plugin() -> str:
    """Remove the opencode bridge plugin. Returns a status string."""
    return _remove_plugin_file(opencode_plugins_dir() / _OPENCODE_FILENAME)


def _check_opencode_plugin() -> str:
    """Return install status of the opencode bridge plugin."""
    return _check_plugin_file(opencode_plugins_dir() / _OPENCODE_FILENAME)


# ---------------------------------------------------------------------------
# Openclaw install / uninstall / check
# ---------------------------------------------------------------------------

_OPENCLAW_PLUGIN_ID = "token-goat-bridge"
_OPENCLAW_FILENAME = "token-goat-bridge.ts"


def _openclaw_entries(cfg: dict[str, object]) -> dict[str, object]:
    """Return the ``plugins.entries`` dict from an openclaw config, creating it if absent.

    The three callers (install, uninstall, check) all traverse the same two-level
    path ``cfg["plugins"]["entries"]`` with identical isinstance guards.  Extracted
    here to avoid repeating the traversal in each caller.

    Mutates *cfg* in-place only when the intermediate keys are missing (safe for
    the install path); for read-only callers (check/uninstall) the dict is already
    present and is returned as-is.
    """
    raw_plugins = cfg.setdefault("plugins", {})
    plugins: dict[str, object] = raw_plugins if isinstance(raw_plugins, dict) else {}
    cfg["plugins"] = plugins
    raw_entries = plugins.setdefault("entries", {})
    entries: dict[str, object] = raw_entries if isinstance(raw_entries, dict) else {}
    plugins["entries"] = entries
    return entries


def _openclaw_entries_readonly(cfg: dict[str, object]) -> dict[str, object]:
    """Return the ``plugins.entries`` dict from an openclaw config without mutating *cfg*.

    Used by read/uninstall paths where creating missing keys would corrupt a
    config that genuinely has no plugins section yet.
    """
    raw_plugins = cfg.get("plugins", {})
    raw_entries = raw_plugins.get("entries", {}) if isinstance(raw_plugins, dict) else {}
    return raw_entries if isinstance(raw_entries, dict) else {}


def install_openclaw_plugin() -> str:
    """Write the openclaw bridge plugin and register it in openclaw.json. Returns the path."""
    plugin_path = _write_plugin_file(openclaw_plugins_dir(), _OPENCLAW_FILENAME, OPENCLAW_PLUGIN_TS)

    cfg_path = openclaw_config_path()
    paths.ensure_dir(cfg_path.parent)
    try:
        cfg: dict[str, object] = _load_json_config(cfg_path) if cfg_path.exists() else {}
    except (json.JSONDecodeError, OSError) as e:
        _LOG.debug("openclaw.json read failed, starting fresh: %s", e)
        cfg = {}

    entries = _openclaw_entries(cfg)
    entries[_OPENCLAW_PLUGIN_ID] = {"enabled": True, "path": str(plugin_path)}
    _save_json_config(cfg_path, cfg)

    _LOG.info("openclaw plugin written: %s", plugin_path)
    return str(plugin_path)


def uninstall_openclaw_plugin() -> str:
    """Remove the openclaw bridge plugin and deregister from openclaw.json. Returns a status string."""
    removed: list[str] = []

    file_result = _remove_plugin_file(openclaw_plugins_dir() / _OPENCLAW_FILENAME)
    if file_result != "not found":
        removed.append(file_result)

    cfg_path = openclaw_config_path()
    if cfg_path.exists():
        try:
            cfg = _load_json_config(cfg_path)
            entries = _openclaw_entries_readonly(cfg)
            if _OPENCLAW_PLUGIN_ID in entries:
                del entries[_OPENCLAW_PLUGIN_ID]
                _save_json_config(cfg_path, cfg)
                removed.append("deregistered from openclaw.json")
        except (json.JSONDecodeError, OSError) as e:
            _LOG.warning("openclaw config not updated during uninstall: %s", e)

    return ", ".join(removed) if removed else "not found"


def _check_openclaw_plugin() -> str:
    """Return install status of the openclaw bridge plugin.

    Unlike the opencode variant, openclaw plugins must also be registered in
    ``openclaw.json``, so this check reports both the file and registry state.
    """
    plugin_path = openclaw_plugins_dir() / _OPENCLAW_FILENAME
    cfg_path = openclaw_config_path()

    file_status = _check_plugin_file(plugin_path)
    # Pass through error/foreign-file states immediately — registry check not meaningful.
    if file_status not in ("not installed", "installed"):
        return file_status
    file_installed = file_status == "installed"

    registered = False
    if cfg_path.exists():
        try:
            cfg = _load_json_config(cfg_path)
            registered = _OPENCLAW_PLUGIN_ID in _openclaw_entries_readonly(cfg)
        except (json.JSONDecodeError, OSError) as e:
            _LOG.debug("openclaw.json read failed in check: %s", e)

    if file_installed and registered:
        return "installed"
    if file_installed and not registered:
        return "file present but not registered in openclaw.json"
    if registered and not file_installed:
        return "registered in openclaw.json but plugin file missing"
    return "not installed"
