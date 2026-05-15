<p align="center">
  <img src="assets/logo.png" alt="Token-Goat" width="220">
</p>

# Token-Goat

Cuts the tokens Claude Code and Codex CLI burn on Windows. Install once, then forget it.

## Requirements

- Windows 10 or 11
- Python 3.11, 3.12, or 3.13

## The problem

Long sessions accumulate waste. Screenshots cross the model at full resolution. The agent re-reads files it parsed earlier in the same conversation. Compactions lose track of which files were edited. Token-Goat intercepts each automatically.

## What you get

Four wins, all silent, all automatic.

**Large images shrink before the model ever sees them.** When the agent opens a big PNG or JPEG from disk, Google Drive, or a URL, Token-Goat returns a compressed copy. A 3.3 MB screenshot from a recent session landed at 84 KB on the way through — a 97.4% cut on a single read. Drive shrinking requires Google Drive authorization. Token-Goat uses Google Application Default Credentials if available (set up via `gcloud auth application-default login`), or its own OAuth token from a one-time `token-goat gdrive-auth` run. It never touches Claude Code's credentials.

**No more re-reading the same file.** When the agent tries to read a file already pulled into the current session, it gets a short reminder of the prior read and a nudge to grab a narrower slice instead. Long sessions stop replaying themselves.

**Compaction stays useful.** Before Claude Code compacts a long conversation, Token-Goat injects a structured session manifest — which files were edited, which symbols were accessed, which files were read most — so the compaction LLM knows what to preserve. The manifest is typically under 400 tokens. Sessions that would otherwise lose important context are better positioned to keep it.

**Surgical reads from a small CLI.** Pull one function, one Markdown heading, or one semantic match instead of dumping a whole module into context. Targeted reads run about 85% smaller than whole-file reads on the same source.

Four hours of use on the author's machine: 59.7 MB of data that never hit the model, with an estimated 11.5 million tokens avoided. Image token savings are estimated using Claude's vision pricing formula (pixel dimensions ÷ 750, capped at 1568 px per side). Text savings use bytes ÷ 4. Both are estimates — treat them as directional.

## Install

```
uv tool install token-goat
token-goat install
```

That wires up Claude Code. Hooks register, a background worker starts at logon and stays out of the way. No terminal popups, no tray icon, no service to babysit.

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

First `token-goat semantic` call downloads a small embedding model, about 130 MB, into `%LOCALAPPDATA%\token-goat\models\`. One-time. Offline after that.

## Set and forget

After `token-goat install`, there is nothing to start, stop, or restart. The worker:

- starts itself at logon via the Windows startup registry (HKCU Run key — no admin rights needed)
- runs as your user account only, without a console window
- survives reboots
- needs zero ongoing attention

To remove it later, `token-goat uninstall` reverses every change, including the startup entry.

## Windows Defender

Optional speed-up for large repos. Token-goat works fine without it.

Real-time scanning slows indexing. To exclude the token-goat folder, open PowerShell as administrator (right-click PowerShell, "Run as administrator") and run:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\token-goat"
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

All caches and the index live in `%LOCALAPPDATA%\token-goat\`. Delete the folder any time. Nothing else on the system depends on it.

## About

I built this because long Claude Code sessions on my machine kept burning context in the same ways: screenshots landing at 2-3 MB, the agent re-reading a file it parsed hours earlier in the same conversation, compactions that forgot which functions were edited. Each felt preventable. The architecture for how it's wired is in [CLAUDE.md](CLAUDE.md).

This is a solo project. I use it daily on Windows 11. Tests run across Python 3.11, 3.12, and 3.13.

## Available for work

Senior or staff engineering. Developer tools, AI infrastructure, or context management.

I've spent months inside Claude Code's hook system, session management, and compaction pipeline. Not reading the docs. Instrumenting them to see what was actually happening. The work is in this repo.

I build systems that run without babysitting, measure their own impact, and fail quietly. If you're building tooling for developers who work with AI, reach out.

token-goat@dfkhelper.com

## Disclaimer

Token-Goat runs on your machine and touches your files. The software is provided as-is, without warranty of any kind. DFK Helper LLC is not liable for any damages arising from use. Full terms — including the No Liability clause — are in the LICENSE file.

## License

Token-Goat is licensed under the PolyForm Noncommercial License 1.0.0. See the LICENSE file for the full terms.

Individual developers may install and use Token-Goat on their own machines for personal productivity without a commercial license, provided the use does not involve providing Token-Goat as a service to others, incorporating it into a commercial product or platform, or deploying it as shared infrastructure across a team or organization. Employment at a for-profit company does not by itself make use commercial — but if your employer is the primary beneficiary of the deployment, a commercial license applies. When in doubt, email token-goat@dfkhelper.com.

Commercial use is reserved. That means copying or incorporating this codebase into a product, charging for access to it, or running it as shared infrastructure across a team at a for-profit company. Commercial licensing: token-goat@dfkhelper.com.

Copyright (c) 2026 DFK Helper LLC.

Patent Pending — U.S. Provisional Application No. 64/066,067.
