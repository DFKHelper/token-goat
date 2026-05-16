<p align="center">
  <img src="assets/logo.png" alt="Token-Goat" width="700">
</p>

<p align="center">
  Cuts the tokens Claude Code and Codex CLI burn. Windows, Linux, and WSL. Install once, then forget it.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?logo=windows&logoColor=white" alt="Windows 10 | 11">
  <img src="https://img.shields.io/badge/Linux-including%20WSL-FCC624?logo=linux&logoColor=black" alt="Linux including WSL">
  <img src="https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-3776ab?logo=python&logoColor=white" alt="Python 3.11 | 3.12 | 3.13">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-lightgrey" alt="PolyForm Noncommercial">
  <img src="https://img.shields.io/badge/requires-uv-6340ac" alt="requires uv">
</p>

---

<p align="center">
  <b>97.4%</b> image compression &nbsp;·&nbsp; <b>85%</b> smaller reads via surgical CLI &nbsp;·&nbsp; <b>zero</b> ongoing maintenance
</p>

---

## The problem

Long sessions accumulate waste three ways. Screenshots cross the model at full resolution. A single PNG can land at 3.3 MB. The agent re-reads files it already parsed earlier in the same conversation. And when a session compacts, the summary LLM doesn't know which files were edited or which symbols mattered, so it preserves the wrong things.

Each one is preventable. Token-Goat intercepts all three, automatically.

## What changes

| Without Token-Goat | With Token-Goat |
|--------------------|-----------------|
| 3.3 MB screenshot lands in model context | 84 KB compressed copy — 97.4% smaller |
| Agent re-reads files from earlier in the session | "Already read this" reminder with narrow slice suggestion |
| Compaction forgets which files were edited | Structured session manifest injected before compact |
| Full file read for one function or section | `token-goat read file::symbol` — about 85% smaller |

> Four hours of use on the author's machine: **59.7 MB** of data that never hit the model, with an estimated **11.5 million tokens** avoided.

<p align="center">
  <img src="assets/stats.png" alt="token-goat stats" width="800">
</p>

## Install

**Windows requirements:** Windows 10 or 11 · Python 3.11, 3.12, or 3.13 · [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`)

**Linux / WSL requirements:** Python 3.11, 3.12, or 3.13 · [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

```
uv tool install token-goat
token-goat install
```

Two commands. Done. Hooks register, a background worker starts at logon and stays out of the way. No terminal popups, no tray icon, no service to babysit.

On Linux and WSL, the worker registers as a systemd user service when systemd is available. On WSL without systemd, the SessionStart hook ensures the worker is running at the start of every Claude Code session.

### Codex CLI users

```
token-goat install --codex
```

The `--codex` flag patches both Claude Code and Codex CLI in one pass.

## CLI

| Command | What it does |
|---------|-------------|
| `token-goat symbol <name>` | Jump to a symbol definition |
| `token-goat read "file::symbol"` | Pull one function or class, not the whole file |
| `token-goat section "doc.md::Heading"` | Pull one Markdown section by heading |
| `token-goat semantic "<query>"` | Find code by meaning, not by filename |
| `token-goat map` | Get a compact orientation of the repo |
| `token-goat stats` | See how many tokens you have saved |
| `token-goat compact-hint --session-id <id>` | Inspect the compaction manifest for a session |
| `token-goat doctor` | Confirm everything is wired correctly |

First `token-goat semantic` call downloads a small embedding model, about 130 MB, into `%LOCALAPPDATA%\dfk-helper\token-goat\models\`. One-time. Offline after that.

## Zero maintenance

After `token-goat install`, there is nothing to start, stop, or restart. The worker:

- **Windows:** starts at logon via the Windows startup registry (HKCU Run key, no admin rights needed), runs without a console window
- **Linux with systemd:** registers as a systemd user service (`~/.config/systemd/user/token-goat-worker.service`), starts at login automatically
- **WSL without systemd:** the SessionStart hook starts the worker at the beginning of every Claude Code session
- survives reboots on all platforms
- needs zero ongoing attention

To remove it later, `token-goat uninstall` reverses every change, including the startup entry.

## Windows Defender (Windows only)

Optional speed-up for large repos. Token-goat works fine without it.

Real-time scanning slows indexing. To exclude the token-goat folder, open PowerShell as administrator and run:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\dfk-helper\token-goat"
```

If you see `0x800106ba`, the prompt is not elevated. Reopen as administrator.

On enterprise-managed Windows (domain-joined or Intune-managed), Defender exclusions may be locked by Group Policy. The command will fail even with admin rights. That is expected and harmless.

## Verify

```
token-goat doctor
token-goat stats
```

`doctor` confirms the install is healthy. `stats` shows cumulative savings.

## Uninstall

```
token-goat uninstall
```

## Privacy

No telemetry. No analytics. No background reporting or silent outbound connections.

Outbound network only in three explicitly disclosed cases:

- First `token-goat semantic` call downloads the embedding model. After that, semantic search runs offline.
- Google Drive API calls, only if you already authorized Drive in Claude Code. Token-goat never prompts for its own auth.
- Explicit, user-triggered URL fetches via `token-goat fetch-image <url>`.

All caches and the index live in `%LOCALAPPDATA%\dfk-helper\token-goat\`. Delete the folder any time. Nothing else on the system depends on it.

## About

I built this because long Claude Code and Codex sessions on my machine kept burning context in the same ways: screenshots landing at 2-3 MB, the agent re-reading a file it parsed hours earlier in the same conversation, compactions that forgot which functions were edited. Each felt preventable.

This is a solo project. I use it daily on Windows 11. Tests run across Python 3.11, 3.12, and 3.13.

## Available for work

Senior or staff engineering. Developer tools, AI infrastructure, or context management.

I've spent months inside Claude Code's hook system, session management, and compaction pipeline. Not reading the docs. Instrumenting them to see what was actually happening. The work is in this repo.

I build systems that run without babysitting, measure their own impact, and fail quietly. If you're building tooling for developers who work with AI, reach out.

[token-goat@dfkhelper.com](mailto:token-goat@dfkhelper.com)

## Disclaimer

Token-Goat runs on your machine and touches your files. The software is provided as-is, without warranty of any kind. DFK Helper LLC is not liable for any damages arising from use. Full terms, including the No Liability clause, are in the LICENSE file.

## License

Token-Goat is licensed under the PolyForm Noncommercial License 1.0.0. See the LICENSE file for the full terms.

Individual developers may install and use Token-Goat on their own machines for personal productivity without a commercial license, provided the use does not involve providing Token-Goat as a service to others, incorporating it into a commercial product or platform, or deploying it as shared infrastructure across a team or organization. Employment at a for-profit company does not by itself make use commercial — but if your employer is the primary beneficiary of the deployment, a commercial license applies. When in doubt, email token-goat@dfkhelper.com.

Commercial use is reserved. That means copying or incorporating this codebase into a product, charging for access to it, or running it as shared infrastructure across a team at a for-profit company. Commercial licensing: token-goat@dfkhelper.com.

Copyright (c) 2026 DFK Helper LLC.

Patent Pending.
