"""install + uninstall: scheduled tasks, settings.json, CLAUDE.md, skill, permission allowlist."""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from . import paths

# Markers for idempotent Codex AGENTS.md patching
CODEX_AGENTS_BEGIN = "<!-- tokenwise-codex-begin -->"
CODEX_AGENTS_END = "<!-- tokenwise-codex-end -->"

_LOG = logging.getLogger("tokenwise.install")

# Markers for idempotent CLAUDE.md patching
CLAUDE_MD_BEGIN = "<!-- tokenwise-begin -->"
CLAUDE_MD_END = "<!-- tokenwise-end -->"

# Scheduled task names
TASK_WORKER = "tokenwise-worker"
TASK_UPDATE = "tokenwise-update"


def claude_dir() -> Path:
    """Return ~/.claude/"""
    return Path.home() / ".claude"


def claude_settings_path() -> Path:
    return claude_dir() / "settings.json"


def claude_md_path() -> Path:
    return claude_dir() / "CLAUDE.md"


def skill_dir() -> Path:
    return claude_dir() / "skills" / "tokenwise"


def tokenwise_binary() -> str:
    """Return the path to the tokenwise executable. Falls back to 'tokenwise' (PATH-resolved)."""
    binary = shutil.which("tokenwise")
    if binary:
        return binary
    return "tokenwise"


def tokenwise_hook_binary() -> str:
    """Path to the windowless (GUI-subsystem) entry for hooks.

    On Windows, this is `tokenwise-hook.exe` from pyproject `[project.gui-scripts]`.
    It runs the same code as `tokenwise` but with the Windows GUI subsystem so no
    console window is allocated when Claude Code spawns it for every hook call.
    Falls back to `tokenwise` if the windowless variant isn't installed.
    """
    binary = shutil.which("tokenwise-hook")
    if binary:
        return binary
    return tokenwise_binary()


def tokenwise_worker_binary() -> str:
    """Windowless entry for the background worker. Falls back to tokenwise."""
    binary = shutil.which("tokenwise-worker")
    if binary:
        return binary
    return tokenwise_binary()


# ---------------------------------------------------------------------------
# Scheduled Tasks (Windows)
# ---------------------------------------------------------------------------


def _run_schtasks(args: list[str]) -> tuple[int, str]:
    """Wrap schtasks.exe subprocess call."""
    try:
        result = subprocess.run(
            ["schtasks.exe"] + args,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode, (result.stdout or "") + (result.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def task_exists(name: str) -> bool:
    code, _ = _run_schtasks(["/Query", "/TN", name])
    return code == 0


def install_worker_task() -> tuple[bool, str]:
    """Register the tokenwise worker to run at user logon via the HKCU Run key.

    schtasks ONLOGON requires admin even with /RU on most Windows UAC setups.
    HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run is the standard
    user-scope at-logon mechanism and never needs elevation.

    Command uses ``pythonw.exe -m tokenwise.cli worker --daemon`` so AV/EDR
    products don't behavior-flag the at-logon spawn (a tiny launcher .exe in
    a user-writable directory is a textbook payload-drop signature; pythonw
    invoking a module is not).
    """
    import sys
    cmd = paths.python_runner_command("worker", "--daemon")

    if sys.platform != "win32":
        return True, "non-Windows: skipped"

    try:
        import winreg  # type: ignore[import]
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        )
        winreg.SetValueEx(key, TASK_WORKER, 0, winreg.REG_SZ, cmd)
        winreg.CloseKey(key)
        return True, f"HKCU Run key set: {cmd}"
    except Exception as exc:
        return False, str(exc)


def install_update_task() -> tuple[bool, str]:
    """Create the weekly auto-update scheduled task (Sunday 03:00, user scope)."""
    import os
    if task_exists(TASK_UPDATE):
        _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"])

    username = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    args = [
        "/Create",
        "/TN", TASK_UPDATE,
        "/SC", "WEEKLY",
        "/D", "SUN",
        "/ST", "03:00",
        "/RL", "LIMITED",
        "/F",
        "/TR", 'cmd /c "uv tool upgrade tokenwise"',
    ]
    if username:
        args += ["/RU", username]
    code, out = _run_schtasks(args)
    return code == 0, out


def uninstall_tasks() -> list[str]:
    """Remove worker Run key + update scheduled task. Returns list of names removed."""
    import sys
    removed = []

    # Worker: HKCU Run registry key
    if sys.platform == "win32":
        try:
            import winreg  # type: ignore[import]
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_SET_VALUE,
            )
            winreg.DeleteValue(key, TASK_WORKER)
            winreg.CloseKey(key)
            removed.append(TASK_WORKER)
        except FileNotFoundError:
            pass  # key didn't exist
        except Exception:
            pass

    # Update task: still a schtasks WEEKLY entry
    if task_exists(TASK_UPDATE):
        code, _ = _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"])
        if code == 0:
            removed.append(TASK_UPDATE)

    return removed


# ---------------------------------------------------------------------------
# settings.json patching
# ---------------------------------------------------------------------------


def _hooks_block(binary: str | None = None) -> dict:
    """Build the hooks structure tokenwise wants to install.

    The ``binary`` parameter is kept for backwards compatibility but unused;
    commands now invoke ``pythonw.exe -m tokenwise.cli`` directly. See
    ``paths.python_runner_command`` for why (AV/EDR launcher-binary flagging).
    """
    runner = paths.python_runner_command
    return {
        "SessionStart": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "session-start"),
                        "timeout": 30000,
                    }
                ],
            }
        ],
        "PreToolUse": [
            {
                "matcher": "Read",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-read"),
                        "timeout": 5000,
                    }
                ],
            },
            {
                "matcher": "mcp__claude_ai_Google_Drive__.*|WebFetch",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-fetch"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "Edit|Write|MultiEdit",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-edit"),
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Read|Grep|Glob",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-read"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
    }


def _strip_tokenwise_entries(entries: list[dict]) -> list[dict]:
    """Remove any hook entries whose command string contains 'tokenwise'."""
    kept = []
    for entry in entries:
        hooks_list = entry.get("hooks", [])
        non_cc = [h for h in hooks_list if "tokenwise" not in h.get("command", "")]
        if non_cc:
            kept.append({"matcher": entry.get("matcher", "*"), "hooks": non_cc})
    return kept


def patch_settings_json() -> tuple[bool, str]:
    """Add tokenwise hooks to ~/.claude/settings.json idempotently. Preserves other hooks."""
    settings_path = claude_settings_path()
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    if settings_path.exists():
        try:
            current = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False, "settings.json is malformed JSON"
    else:
        current = {}

    binary = tokenwise_hook_binary()
    our_hooks = _hooks_block(binary)

    # Backup before any modification
    if settings_path.exists():
        backup = settings_path.with_suffix(
            f".json.bak.{datetime.now():%Y%m%d-%H%M%S}"
        )
        shutil.copy2(settings_path, backup)

    existing_hooks = current.get("hooks", {})
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        # Strip any prior tokenwise entries, then append fresh ones
        kept = _strip_tokenwise_entries(existing_entries)
        existing_hooks[event] = kept + entries
    current["hooks"] = existing_hooks

    # Permission allowlist
    perms = current.get("permissions", {})
    allowed = list(perms.get("allow", []))
    if "Bash(tokenwise:*)" not in allowed:
        allowed.append("Bash(tokenwise:*)")
    perms["allow"] = allowed
    current["permissions"] = perms

    settings_path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return True, str(settings_path)


def unpatch_settings_json() -> str:
    """Remove tokenwise entries from settings.json."""
    settings_path = claude_settings_path()
    if not settings_path.exists():
        return "settings.json not found (nothing to do)"
    try:
        current = json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return "settings.json malformed; not modifying"

    hooks = current.get("hooks", {})
    for event in list(hooks.keys()):
        cleaned = _strip_tokenwise_entries(hooks.get(event, []))
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    current["hooks"] = hooks

    perms = current.get("permissions", {})
    allowed = [a for a in perms.get("allow", []) if a != "Bash(tokenwise:*)"]
    perms["allow"] = allowed
    # Drop permissions key entirely if it has no meaningful content left
    if not perms.get("allow") and not perms.get("deny") and not perms.get("ask"):
        current.pop("permissions", None)
    else:
        current["permissions"] = perms

    settings_path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return str(settings_path)


# ---------------------------------------------------------------------------
# CLAUDE.md patching
# ---------------------------------------------------------------------------

CLAUDE_MD_CONTENT = """\
## tokenwise - route code reads through tokenwise first

tokenwise is installed. Before you call Read or Grep on a source file, check for a tokenwise command that does the same job for a fraction of the tokens. This is the default path, not an optimization. Skipping it burns context you will need later in the session.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `tokenwise symbol getUser` | `Grep "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `tokenwise read "src/auth.py::login"` | `Read src/auth.py` (about 85% more tokens) |
| Read one section of a doc | `tokenwise section "README.md::Install"` | `Read README.md` |
| Find code by meaning, not name | `tokenwise semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `tokenwise map --budget 4000` | Recursive `ls` plus multiple `Read` calls |

Add `--all-projects` to `tokenwise symbol` for cross-repo lookups.

Read is the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- It is an image you need to see visually. The shrink runs automatically. Just Read it.

Verify the habit. Run `tokenwise stats` and watch event counts climb. Flat counts during code work mean you are reaching for Read or Grep where tokenwise would apply.
"""


def patch_claude_md() -> str:
    """Add or update the tokenwise block in ~/.claude/CLAUDE.md, idempotently."""
    md_path = claude_md_path()
    md_path.parent.mkdir(parents=True, exist_ok=True)
    block = f"{CLAUDE_MD_BEGIN}\n{CLAUDE_MD_CONTENT}\n{CLAUDE_MD_END}"

    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")
        if CLAUDE_MD_BEGIN in content and CLAUDE_MD_END in content:
            # Replace existing block in place
            pattern = re.compile(
                re.escape(CLAUDE_MD_BEGIN) + r".*?" + re.escape(CLAUDE_MD_END),
                re.DOTALL,
            )
            content = pattern.sub(block, content)
        else:
            # Append
            if not content.endswith("\n"):
                content += "\n"
            content += "\n" + block + "\n"
    else:
        content = block + "\n"

    md_path.write_text(content, encoding="utf-8")
    return str(md_path)


def unpatch_claude_md() -> str:
    md_path = claude_md_path()
    if not md_path.exists():
        return "CLAUDE.md not found"
    content = md_path.read_text(encoding="utf-8")
    pattern = re.compile(
        r"\n*"
        + re.escape(CLAUDE_MD_BEGIN)
        + r".*?"
        + re.escape(CLAUDE_MD_END)
        + r"\n*",
        re.DOTALL,
    )
    new = pattern.sub("\n", content).strip()
    # Write back with a trailing newline
    md_path.write_text(new + "\n" if new else "", encoding="utf-8")
    return str(md_path)


# ---------------------------------------------------------------------------
# Skill
# ---------------------------------------------------------------------------

SKILL_MD_CONTENT = """\
---
name: tokenwise
description: Use BEFORE reaching for Read or Grep on a source file. tokenwise commands replace symbol search, single-function reads, doc-section reads, semantic search, and repo overviews at a fraction of the token cost. Hooks handle image shrink, Drive intercept, and read dedup automatically. Skipping tokenwise burns session context.
---

# tokenwise

tokenwise is installed. Route code and content reads through it first. This is the default path, not optional polish. Tokens you spend rereading files or grepping wide are tokens you will not have for the work that matters.

## Automatic. Do not duplicate.

- Large images on Read get redirected to a shrunken cached copy (about 95% fewer tokens).
- Google Drive downloads get redirected to a tokenwise fetch that downloads, shrinks, and caches.
- WebFetch on an image URL gets the same treatment.
- Repeat reads of the same file in one session trigger a system reminder so you do not pay twice.

You do not call these. They run on their own.

## What you DO call

Before reaching for Read or Grep on a code file, check this table.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `tokenwise symbol getUser` | `Grep "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `tokenwise read "src/auth.py::login"` | `Read src/auth.py` (about 85% more tokens) |
| Read one section of a doc | `tokenwise section "README.md::Install"` | `Read README.md` |
| Find code by meaning, not name | `tokenwise semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `tokenwise map --budget 4000` | Recursive `ls` plus multiple `Read` calls |
| See what you have already touched | `tokenwise session-touched` | Re-reading and hoping you remember |

Add `--all-projects` to `tokenwise symbol` to search every indexed repo at once.

## When Read is the right call

- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- You need to view an image visually. The shrink already ran. Just Read it.

## Verify the habit

Run `tokenwise stats` and watch event counts climb. Flat counts during code work mean you are reaching for Read or Grep where a tokenwise command would apply. Run `tokenwise doctor` if anything looks wrong.
"""


def write_skill() -> str:
    sd = skill_dir()
    sd.mkdir(parents=True, exist_ok=True)
    skill_path = sd / "SKILL.md"
    skill_path.write_text(SKILL_MD_CONTENT, encoding="utf-8")
    return str(skill_path)


def remove_skill() -> str:
    sd = skill_dir()
    if sd.exists():
        shutil.rmtree(sd, ignore_errors=True)
        return str(sd)
    return "skill dir not found"


# ---------------------------------------------------------------------------
# Codex integration
# ---------------------------------------------------------------------------


def codex_dir() -> Path:
    """Return ~/.codex/"""
    return Path.home() / ".codex"


def codex_config_path() -> Path:
    return codex_dir() / "config.toml"


def codex_agents_path() -> Path:
    return codex_dir() / "AGENTS.md"


def _codex_hooks_block(binary: str | None = None) -> dict:
    """The hooks structure for Codex's config.toml.

    The ``binary`` parameter is kept for backwards compatibility but unused.
    """
    runner = paths.python_runner_command
    return {
        "SessionStart": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "session-start", "--harness", "codex"),
                        "timeout": 30000,
                    }
                ],
            }
        ],
        "PreToolUse": [
            {
                "matcher": "view_image|Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-read", "--harness", "codex"),
                        "timeout": 5000,
                    }
                ],
            },
            {
                "matcher": "mcp__claude_ai_Google_Drive__.*|web_search",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-fetch", "--harness", "codex"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "apply_patch",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-edit", "--harness", "codex"),
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-read", "--harness", "codex"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
    }


def _strip_codex_tokenwise_entries(entries: list[dict]) -> list[dict]:
    """Remove hook entries whose command string contains 'tokenwise'."""
    kept = []
    for e in entries:
        hooks_list = e.get("hooks", [])
        non_tw = [h for h in hooks_list if "tokenwise" not in h.get("command", "")]
        if non_tw:
            kept.append({"matcher": e.get("matcher", "*"), "hooks": non_tw})
    return kept


def patch_codex_config(binary: str) -> str:
    """Merge tokenwise hooks into ~/.codex/config.toml idempotently."""
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    cfg_path = codex_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)

    existing = tomllib.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}

    our_hooks = _codex_hooks_block(binary)
    existing_hooks = existing.get("hooks", {})
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        kept = _strip_codex_tokenwise_entries(existing_entries)
        existing_hooks[event] = kept + entries
    existing["hooks"] = existing_hooks

    cfg_path.write_text(tomli_w.dumps(existing), encoding="utf-8")
    return str(cfg_path)


def unpatch_codex_config() -> str:
    """Remove tokenwise entries from ~/.codex/config.toml."""
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    cfg_path = codex_config_path()
    if not cfg_path.exists():
        return "codex config not found"

    existing = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    hooks = existing.get("hooks", {})
    for event in list(hooks.keys()):
        cleaned = _strip_codex_tokenwise_entries(hooks[event])
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    existing["hooks"] = hooks

    cfg_path.write_text(tomli_w.dumps(existing), encoding="utf-8")
    return str(cfg_path)


CODEX_AGENTS_MD_CONTENT = """\
## tokenwise - route code reads through tokenwise first (Codex)

tokenwise is installed. Before you run `rg`, `grep`, `cat`, `head`, `bat`, or any Bash read of a source file, check whether a tokenwise command does the same job for a fraction of the tokens. Route through tokenwise by default. Skipping it burns context you will need later in the session.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `tokenwise symbol getUser` | `rg "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `tokenwise read "src/auth.py::login"` | `cat src/auth.py` (about 85% more tokens) |
| Read one section of a doc | `tokenwise section "README.md::Install"` | `cat README.md` |
| Find code by meaning, not name | `tokenwise semantic "rate limit retry"` | Several rounds of `rg` |
| Get oriented in an unfamiliar repo | `tokenwise map --budget 4000` | `ls -R` plus multiple `cat` calls |

Add `--all-projects` to `tokenwise symbol` for cross-repo lookups.

Plain Bash reads are the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- You need exact bytes to build an `apply_patch` hunk that must match the file verbatim.

Verify the habit. Run `tokenwise stats` and watch event counts climb. Flat counts during code work mean you are reaching for `rg` or `cat` where a tokenwise command would apply.
"""


def patch_codex_agents_md() -> str:
    """Append/replace the delimited tokenwise block in ~/.codex/AGENTS.md."""
    md = codex_agents_path()
    md.parent.mkdir(parents=True, exist_ok=True)

    block = f"{CODEX_AGENTS_BEGIN}\n{CODEX_AGENTS_MD_CONTENT}\n{CODEX_AGENTS_END}"

    if md.exists():
        content = md.read_text(encoding="utf-8")
        if CODEX_AGENTS_BEGIN in content and CODEX_AGENTS_END in content:
            pattern = re.compile(
                re.escape(CODEX_AGENTS_BEGIN) + r".*?" + re.escape(CODEX_AGENTS_END),
                re.DOTALL,
            )
            content = pattern.sub(block, content)
        else:
            if not content.endswith("\n"):
                content += "\n"
            content += "\n" + block + "\n"
    else:
        content = block + "\n"

    md.write_text(content, encoding="utf-8")
    return str(md)


def unpatch_codex_agents_md() -> str:
    """Remove the tokenwise block from ~/.codex/AGENTS.md."""
    md = codex_agents_path()
    if not md.exists():
        return "codex AGENTS.md not found"

    content = md.read_text(encoding="utf-8")
    pattern = re.compile(
        r"\n*" + re.escape(CODEX_AGENTS_BEGIN) + r".*?" + re.escape(CODEX_AGENTS_END) + r"\n*",
        re.DOTALL,
    )
    md.write_text(pattern.sub("\n", content), encoding="utf-8")
    return str(md)


# ---------------------------------------------------------------------------
# Top-level install / uninstall
# ---------------------------------------------------------------------------


def install_all(install_codex: bool = False) -> dict:
    """Run the full install. Returns a dict of step -> result string."""
    paths.ensure_dirs()
    result: dict[str, str] = {}

    settings_ok, settings_detail = patch_settings_json()
    result["settings.json"] = ("ok" if settings_ok else "FAIL") + f" — {settings_detail}"

    md_out = patch_claude_md()
    result["CLAUDE.md"] = f"ok — {md_out}"

    skill_path = write_skill()
    result["skill"] = f"ok — {skill_path}"

    worker_ok, worker_out = install_worker_task()
    result["task: worker"] = ("ok" if worker_ok else "FAIL") + f" — {worker_out[:200]}"

    update_ok, update_out = install_update_task()
    result["task: update"] = ("ok" if update_ok else "FAIL") + f" — {update_out[:200]}"

    # Spawn the worker right now (fail-soft)
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        result["worker"] = f"spawned, pid={pid}" if pid else "spawn failed"
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"FAIL — {e}"

    if install_codex:
        binary = tokenwise_hook_binary()
        try:
            result["codex: config.toml"] = f"ok — {patch_codex_config(binary)}"
        except Exception as e:  # noqa: BLE001
            result["codex: config.toml"] = f"FAIL — {e}"
        try:
            result["codex: AGENTS.md"] = f"ok — {patch_codex_agents_md()}"
        except Exception as e:  # noqa: BLE001
            result["codex: AGENTS.md"] = f"FAIL — {e}"

    return result


def uninstall_all(purge: bool = False, codex: bool = False) -> dict:
    """Reverse install. With purge=True also deletes the data directory."""
    result: dict[str, str] = {}

    # Stop worker first
    try:
        pid_path = paths.worker_pid_path()
        if pid_path.exists():
            import psutil  # noqa: PLC0415

            try:
                pid = int(pid_path.read_text(encoding="utf-8").strip())
                if psutil.pid_exists(pid):
                    psutil.Process(pid).terminate()
            except Exception:  # noqa: BLE001
                pass
            pid_path.unlink(missing_ok=True)
        result["worker"] = "stopped"
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"stop failed: {e}"

    removed_tasks = uninstall_tasks()
    result["tasks"] = f"removed: {removed_tasks}"

    result["settings.json"] = f"unpatched — {unpatch_settings_json()}"
    result["CLAUDE.md"] = f"unpatched — {unpatch_claude_md()}"
    result["skill"] = f"removed — {remove_skill()}"

    if purge:
        target = paths.data_dir()
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            result["data_dir"] = f"purged — {target}"
        else:
            result["data_dir"] = "already absent"

    if codex:
        result["codex: config.toml"] = unpatch_codex_config()
        result["codex: AGENTS.md"] = unpatch_codex_agents_md()

    return result
