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
    """Register tokenwise-worker to run at user logon via HKCU Run registry key.

    schtasks ONLOGON requires admin rights even with /RU on most Windows UAC
    configurations.  HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run is
    the standard user-scope at-logon mechanism and never needs elevation.
    """
    import sys
    binary = tokenwise_binary()
    cmd = f'"{binary}" worker --daemon'

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


def _hooks_block(binary: str) -> dict:
    """Build the hooks structure tokenwise wants to install."""
    return {
        "SessionStart": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": f'"{binary}" hook session-start',
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
                        "command": f'"{binary}" hook pre-read',
                        "timeout": 5000,
                    }
                ],
            },
            {
                "matcher": "mcp__claude_ai_Google_Drive__.*|WebFetch",
                "hooks": [
                    {
                        "type": "command",
                        "command": f'"{binary}" hook pre-fetch',
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
                        "command": f'"{binary}" hook post-edit',
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Read|Grep|Glob",
                "hooks": [
                    {
                        "type": "command",
                        "command": f'"{binary}" hook post-read',
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

    binary = tokenwise_binary()
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
## tokenwise — code/content navigation and image shrinking

tokenwise is installed and intercepts via hooks. For maximum token savings:

- **Symbol/function lookup** (replaces `grep`): `tokenwise symbol <name>` — add `--all-projects` for cross-repo
- **Just one symbol/section** (replaces full `Read`): `tokenwise read "<file>::<symbol>"` or `tokenwise section "<file>::<heading>"` (typically ~85% token reduction)
- **Concept/meaning search**: `tokenwise semantic "<query>"`
- **Repo orientation**: `tokenwise map --budget 4000`
- **Dedup check**: `tokenwise session-touched --session-id <id>` (the SessionStart hook resets this automatically)

Image-shrinking, Drive intercept, and read-deduplication are all automatic via PreToolUse hooks — you don't need to call them.
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
description: Token-efficient code and content navigation. Use tokenwise commands instead of grep/Read for symbol lookup, section extraction, semantic search, and repo overview. Hooks handle image-shrink, Drive intercept, and read-deduplication automatically.
---

# tokenwise

`tokenwise` is installed system-wide and integrated via hooks. It dramatically reduces token usage in three ways:

## Automatic (no Claude action required)
- **Image shrink**: every `Read` on a large image (>100 KB) is auto-redirected to a shrunken cached version (~95% token reduction).
- **Drive intercept**: `mcp__claude_ai_Google_Drive__download_file_content` is redirected to `tokenwise gdrive-fetch <id>` (downloads, shrinks, caches).
- **WebFetch image intercept**: WebFetch of an image URL is redirected to `tokenwise fetch-image <url>`.
- **Session dedup hints**: PreToolUse on `Read` injects a system reminder if you've already read the same file this session.

## When you should explicitly call tokenwise

| Goal | Command | Why |
|------|---------|-----|
| Find a function/class/type | `tokenwise symbol <name>` | Returns one line per match (`file:line: kind name signature`). 10-50x fewer tokens than `grep`. Add `--all-projects` for cross-repo. |
| Read just one function | `tokenwise read "file.py::name"` | Returns only that function body. Typically ~85% reduction vs reading the whole file. |
| Read a markdown/HTML section | `tokenwise section "article.md::Methodology"` | Returns only that section. |
| Find code by meaning | `tokenwise semantic "<query>"` | Vector search over local embeddings. Good for "where do we handle X". |
| Orient in a new repo | `tokenwise map --budget 4000` | Token-budgeted PageRank overview. |
| Check session reads | `tokenwise session-touched --session-id <id>` | Lists what you've read so far this session. |

## When to NOT use tokenwise
- For small files (<200 lines), `Read` is fine.
- For ambiguous names with many matches, use `grep` first to narrow.
- For binary/image content you actually need to view visually, the auto-shrink already runs — just `Read` normally.

## Status
Run `tokenwise doctor` if anything seems off. Run `tokenwise stats` to see cumulative token savings.
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
# Top-level install / uninstall
# ---------------------------------------------------------------------------


def install_all() -> dict:
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

    return result


def uninstall_all(purge: bool = False) -> dict:
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

    return result
