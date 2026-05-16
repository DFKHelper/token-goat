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

import json
import logging
from pathlib import Path

_LOG = logging.getLogger("token_goat.bridges")

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

      callHook(tgTool === "Edit" ? "post-edit" : "post-read", {
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
  Bash: "post-read",
  WebFetch: "post-read",
  Edit: "post-edit",
  Write: "post-edit",
};

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
# Path helpers
# ---------------------------------------------------------------------------


def opencode_plugins_dir() -> Path:
    """Return the opencode plugins directory (platform-aware)."""
    import sys  # noqa: PLC0415

    if sys.platform == "win32":
        import os  # noqa: PLC0415

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

_OPENCODE_FILENAME = "token-goat.ts"
_OPENCODE_FINGERPRINT = ("token-goat", "spawnSync")  # strings that must appear in our plugin


def install_opencode_plugin() -> str:
    """Write the opencode bridge plugin to the opencode plugins directory. Returns the path."""
    plugins_dir = opencode_plugins_dir()
    plugins_dir.mkdir(parents=True, exist_ok=True)
    plugin_path = plugins_dir / _OPENCODE_FILENAME
    plugin_path.write_text(OPENCODE_PLUGIN_TS, encoding="utf-8")
    _LOG.info("opencode plugin written: %s", plugin_path)
    return str(plugin_path)


def uninstall_opencode_plugin() -> str:
    """Remove the opencode bridge plugin. Returns a status string."""
    plugin_path = opencode_plugins_dir() / _OPENCODE_FILENAME
    if plugin_path.exists():
        plugin_path.unlink()
        return f"removed {plugin_path}"
    return "not found"


def _check_opencode_plugin() -> str:
    """Return install status of the opencode bridge plugin."""
    plugin_path = opencode_plugins_dir() / _OPENCODE_FILENAME
    if not plugin_path.exists():
        return "not installed"
    try:
        content = plugin_path.read_text(encoding="utf-8")
        if all(fp in content for fp in _OPENCODE_FINGERPRINT):
            return "installed"
        return "present but not token-goat bridge"
    except OSError:
        return "error reading plugin file"


# ---------------------------------------------------------------------------
# Openclaw install / uninstall / check
# ---------------------------------------------------------------------------

_OPENCLAW_PLUGIN_ID = "token-goat-bridge"
_OPENCLAW_FILENAME = "token-goat-bridge.ts"
_OPENCLAW_FINGERPRINT = ("token-goat", "spawnSync")


def install_openclaw_plugin() -> str:
    """Write the openclaw bridge plugin and register it in openclaw.json. Returns the path."""
    plugins_dir = openclaw_plugins_dir()
    plugins_dir.mkdir(parents=True, exist_ok=True)
    plugin_path = plugins_dir / _OPENCLAW_FILENAME
    plugin_path.write_text(OPENCLAW_PLUGIN_TS, encoding="utf-8")

    cfg_path = openclaw_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cfg: dict = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        cfg = {}

    plugins = cfg.setdefault("plugins", {})
    entries = plugins.setdefault("entries", {})
    entries[_OPENCLAW_PLUGIN_ID] = {"enabled": True, "path": str(plugin_path)}
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

    _LOG.info("openclaw plugin written: %s", plugin_path)
    return str(plugin_path)


def uninstall_openclaw_plugin() -> str:
    """Remove the openclaw bridge plugin and deregister from openclaw.json. Returns a status string."""
    removed: list[str] = []

    plugin_path = openclaw_plugins_dir() / _OPENCLAW_FILENAME
    if plugin_path.exists():
        plugin_path.unlink()
        removed.append(str(plugin_path))

    cfg_path = openclaw_config_path()
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            entries = cfg.get("plugins", {}).get("entries", {})
            if _OPENCLAW_PLUGIN_ID in entries:
                del entries[_OPENCLAW_PLUGIN_ID]
                cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
                removed.append("deregistered from openclaw.json")
        except (json.JSONDecodeError, OSError) as e:
            _LOG.warning("openclaw config not updated during uninstall: %s", e)

    return ", ".join(removed) if removed else "not found"


def _check_openclaw_plugin() -> str:
    """Return install status of the openclaw bridge plugin."""
    plugin_path = openclaw_plugins_dir() / _OPENCLAW_FILENAME
    cfg_path = openclaw_config_path()

    file_ok = plugin_path.exists()
    if file_ok:
        try:
            content = plugin_path.read_text(encoding="utf-8")
            if not all(fp in content for fp in _OPENCLAW_FINGERPRINT):
                return "present but not token-goat bridge"
        except OSError:
            return "error reading plugin file"

    registered = False
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            registered = _OPENCLAW_PLUGIN_ID in cfg.get("plugins", {}).get("entries", {})
        except (json.JSONDecodeError, OSError):
            pass

    if file_ok and registered:
        return "installed"
    if file_ok:
        return "file present but not registered in openclaw.json"
    if registered:
        return "registered in openclaw.json but plugin file missing"
    return "not installed"
