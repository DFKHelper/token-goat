<p align="center">
  <img src="assets/logo.png" alt="Tokenwise" width="220">
</p>

# Tokenwise

Cuts the tokens Claude Code and Codex CLI burn on Windows. Install once, then forget it.

Copyright (c) 2026 DFK Helper LLC. Built by Zelys.

## Requirements

- Windows 10 or 11
- Python 3.11, 3.12, or 3.13

## What you get

Three wins, all silent, all automatic.

**Large images shrink before the model ever sees them.** When the agent opens a big PNG or JPEG from disk, Google Drive, or a URL, Tokenwise returns a compressed copy. A 3.3 MB screenshot from a recent session landed at 84 KB on the way through. That is a 97.4% cut on a single read. Drive shrinking only kicks in if you have already authorized Google Drive in Claude Code's built-in connector. Tokenwise reuses that auth and never asks for its own.

**No more re-reading the same file.** When the agent tries to read a file already pulled into the current session, it gets a short reminder of the prior read and a nudge to grab a narrower slice instead. Long sessions stop replaying themselves.

**Surgical reads from a small CLI.** Pull one function, one Markdown heading, or one semantic match instead of dumping a whole module into context. Targeted reads run about 85% smaller than whole-file reads on the same source.

Cumulative on the author's machine after a handful of sessions: 12+ MB saved.

## Install

```
uv tool install tokenwise
tokenwise install
```

That wires up Claude Code. Hooks register, a background worker starts at logon and stays out of the way. No terminal popups, no tray icon, no service to babysit.

### Codex CLI users

```
tokenwise install --codex
```

The `--codex` flag patches both Claude Code and Codex CLI in one pass.

## CLI

| Command | What it does |
|---------|-------------|
| `tokenwise symbol <name>` | Jump to a symbol definition |
| `tokenwise read "file::symbol"` | Pull one function or class, not the whole file |
| `tokenwise section "doc.md::Heading"` | Pull one Markdown section by heading |
| `tokenwise semantic "<query>"` | Find code by meaning, not by filename |
| `tokenwise map` | Get a compact orientation of the repo |
| `tokenwise stats` | See how many tokens you have saved |
| `tokenwise doctor` | Confirm everything is wired correctly |

First `tokenwise semantic` call downloads a small embedding model, about 130 MB, into `%LOCALAPPDATA%\tokenwise\models\`. One-time. Offline after that.

## Set and forget

After `tokenwise install`, there is nothing to start, stop, or restart. The worker:

- starts itself at logon
- runs without a console window
- survives reboots
- needs zero ongoing attention

To remove it later, `tokenwise uninstall` reverses every change.

## Windows Defender

Optional speed-up for large repos. Tokenwise works fine without it.

Real-time scanning slows indexing. To exclude the Tokenwise folder, open PowerShell as administrator (right-click PowerShell, "Run as administrator") and run:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\tokenwise"
```

If you see `0x800106ba`, the prompt is not elevated. Reopen as administrator.

On enterprise-managed Windows (domain-joined or Intune-managed), Defender exclusions may be locked by Group Policy. The command will fail even with admin rights. That is expected and harmless.

## Verify

```
tokenwise doctor
tokenwise stats
```

`doctor` confirms the install is healthy. `stats` shows cumulative savings.

## Uninstall

```
tokenwise uninstall
```

## Privacy

No telemetry. No analytics. Nothing phones home.

Outbound network only in three honest cases:

- First `tokenwise semantic` call downloads the embedding model. After that, semantic search runs offline.
- Google Drive API calls, only if you already authorized Drive in Claude Code. Tokenwise never prompts for its own auth.
- Explicit, user-triggered URL fetches via `tokenwise fetch-image <url>`.

All caches and the index live in `%LOCALAPPDATA%\tokenwise\`. Delete the folder any time. Nothing else on the system depends on it.

## Hire

Available for senior or staff engineering roles. tokenwise@dfkhelper.com

## Disclaimer

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.**

Use Tokenwise at your own risk. DFK Helper LLC and its contributors make no guarantees about correctness, completeness, data integrity, or fitness for any purpose. See the LICENSE file for the full limitation of liability terms.

## License

Tokenwise is licensed under the PolyForm Noncommercial License 1.0.0. See the LICENSE file for the full terms.

In short: you can install, use, modify, and share Tokenwise for any non-commercial purpose. Personal use, study, hobby projects, internal use at a nonprofit or school, and contributing improvements back are all welcome and require no permission.

Commercial use is reserved. That includes shipping Tokenwise inside a product, charging for it, integrating it into a paid service, or using it internally at a for-profit company as part of operations. Commercial licensing: tokenwise@dfkhelper.com.

Copyright (c) 2026 DFK Helper LLC.
