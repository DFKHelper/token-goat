<p align="center">
  <img src="assets/logo.png" alt="Token-Goat" width="700">
</p>

<p align="center">
  A Claude Code companion that cuts token costs on long sessions. Works with Claude Code, Codex CLI, opencode, and openclaw. Windows, Linux, WSL, and macOS. Install once, forget it.
</p>

<p align="center">
  <a href="https://pypi.org/project/token-goat/"><img src="https://img.shields.io/pypi/v/token-goat?label=PyPI&logo=pypi&logoColor=white" alt="PyPI version"></a>
  <a href="https://github.com/DFKHelper/token-goat/actions/workflows/ci.yml"><img src="https://github.com/DFKHelper/token-goat/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://pypi.org/project/token-goat/"><img src="https://img.shields.io/pypi/pyversions/token-goat?logo=python&logoColor=white" alt="Python 3.11 | 3.12 | 3.13"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-lightgrey" alt="PolyForm Noncommercial"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?logo=windows&logoColor=white" alt="Windows 10 | 11">
  <img src="https://img.shields.io/badge/Linux-including%20WSL-FCC624?logo=linux&logoColor=black" alt="Linux including WSL">
  <img src="https://img.shields.io/badge/macOS-untested-lightgrey?logo=apple&logoColor=white" alt="macOS (untested)">
  <img src="https://img.shields.io/badge/requires-uv-6340ac" alt="requires uv">
</p>

<p align="center">
  <b>Token-Goat is built by one person and given away free.</b> If it saves you tokens, please drop a ⭐️ at the top of this page. One click, takes a second, and it genuinely makes my day. Thank you.
</p>

---

<p align="center">
  <b>97.4%</b> image compression &nbsp;·&nbsp; <b>85%</b> smaller reads via surgical CLI &nbsp;·&nbsp; <b>zero</b> ongoing maintenance
</p>

---

## The problem

Claude reads `auth.py`. Then reads it again. Then a third time after compaction wipes the session. You pay for every token.

Long sessions accumulate waste four ways. Screenshots cross the model at full resolution. A single PNG can land at 3.3 MB. The agent re-reads files it already parsed earlier in the same conversation. When a session compacts, the summary LLM doesn't know which files were edited or which symbols mattered, so it preserves the wrong things. And every `pytest`, `npm install`, `docker build`, or `git log` dumps thousands of lines of progress bars, deprecation warnings, and passing-test names that bury the one line that actually matters.

The fastest way to reduce Claude Code token costs is fixing these four, not writing shorter prompts. Each one is preventable. Token-Goat intercepts all four, automatically.

## What changes

| Without Token-Goat | With Token-Goat |
|--------------------|-----------------|
| 3.3 MB screenshot lands in model context | 84 KB compressed copy, 97.4% smaller |
| Agent re-reads files from earlier in the session | "Already read this" reminder with narrow slice suggestion |
| Agent re-reads a file edited mid-session | Unified diff injected as a hint — full Read avoided when the diff covers the change |
| Compaction forgets which files were edited | Structured session manifest injected before compact |
| Same files re-read from scratch after `/compact` | Recovery hint at SessionStart lists cached snapshot + bash + WebFetch IDs |
| Full file read for one function or section | `token-goat read file::symbol`, about 85% smaller |
| `pytest` dumps 150 PASSED lines + dots + tracebacks | Failures-first view, 80 to 97% smaller |
| `npm install` floods deprecation warnings + spinner | Errors kept; warnings collapsed by package, ~90% smaller |
| `docker build` emits sha256 digests + transfer progress | Step headers + errors kept; noise dropped, ~75% smaller |
| `ruff` / `eslint` / `mypy` repeat the same rule 50 times | Grouped by rule with first 3 examples, ~80% smaller |
| Same `pytest` / `cargo` / `git log` re-run mid-session | Pre-Bash dedup hint points at the cached output (`token-goat bash-output <id>`) |
| Same `Grep` pattern re-run with hundreds of matches | Pre-Grep dedup hint quotes the prior match count |
| Same docs URL fetched twice | Pre-WebFetch dedup hint points at the cached body (`token-goat web-output <id>`) |
| `token-goat section pyproject.toml::tool.ruff` | One TOML table extracted instead of the whole config; same for `.yaml`/`.yml`/`.json`/`.ini`/`.cfg`/`.env`/`Dockerfile` |
| Typoed `token-goat symbol getUserr` | Auto-redirects to the unambiguous close match (use `--strict` to opt out) |
| `grep`/`rg` returns 50+ match lines | File-level summary: top 20 files by match count; full result cached, ~80% smaller |
| Same "already read" hint fires on every re-read | Suppressed after first injection; SHA-256 fingerprinting prevents the same nag twice per session |
| Same bash command runs 3+ times in one session | Escalating warning: "ran 2×" on repeat, "WARNING: ran N×" by the third; output always cached |
| Agent starts cold with no git context in a dirty repo | Branch, change counts, and 5 recent commits injected at startup (~50 tokens) |
| Re-read hint shows only the line range | Hint includes previously-accessed symbol names: `[symbols: login, refresh, …]` |

> Four hours of use on the author's machine: **59.7 MB** of data that never hit the model, with an estimated **11.5 million tokens** avoided.

<p align="center">
  <img src="assets/stats.png" alt="token-goat stats" width="800">
</p>

On a per-token API plan, 100K wasted tokens per session runs about $0.30. Five sessions a week is ~$450/year. AI coding cost reduction at that scale comes from fixing the waste, not from using the product less. Token-goat is free.

## Token savings, measured

Numbers below come from synthetic-fixture benchmarks in the test suite. Each row points at the source file where the measurement is reproduced.

| Source | Improvement | Measured impact | Where |
|--------|-------------|-----------------|-------|
| Image shrink | WebP encoder beats JPEG on screenshot-shaped images | ~39% smaller than the same image at JPEG quality 85 | `image_shrink.py` (codec selection) |
| Repomap output | Short labels (`f:`, `s:`, `c:`) and auto-compact mode below 6 KB | ~30–40% denser output for the same byte budget | `repomap.py` (`token-goat map --budget`) |
| DB reindex | Batched single transaction + composite indexes on `(file_id, kind)` | 100 files / 10K rows: 84 s → 1 s (~80× faster) | `parser.py`, `db.py` (index migration) |
| Hook cold-start | Lazy import of heavy modules; unknown events short-circuit | 86 ms → 30 ms (~65% faster); unknown-event dispatch <1 ms | `hooks_cli.py` |
| Symbol start_line | TypeScript decorators captured in symbol span | One `token-goat read` returns the decorator + signature + body; no re-read | `languages/typescript.py` |
| Section extraction | Setext headings, h5/h6, anchor IDs, and `__frontmatter__` | `token-goat section` resolves more headings without falling back to a full file read | `languages/markdown.py` |
| Image cache | Real LRU eviction (was FIFO; old hot entries got dropped) | Higher hit rate on repeat screenshots in long sessions | `image_shrink.py` |
| Monorepo defaults | Reindex batch 500 → 2000; compact `min_events` 5 → 3 | Fewer worker wakeups; compact manifests fire on shorter sessions | `config.py` defaults |
| Miss suggestions | `symbol` auto-redirects on a single high-confidence close match (`--strict` opts out); `read` / `section` print "Did you mean…?" | Keeps agents on the surgical-read path instead of falling back to full-file `Read` | `read_replacement.py` |

## Token-savings examples

Concrete before/after for the four interception points. Token counts use the ~4-chars-per-token rule of thumb.

**1. Image — screenshot interception**

```
$ ls -lh screenshot.png
-rw-r--r-- 1 user user 1.2M screenshot.png

# Without token-goat: Claude reads the 1.2 MB PNG.
# With token-goat: hook re-encodes as WebP and substitutes the cached copy.

$ token-goat shrink-image screenshot.png
out: ~74 KB WebP   (94% smaller)
```

The same image at JPEG quality 85 lands around 120 KB. WebP wins by another ~39% on screenshot-shaped content (large flat regions, sharp text edges).

**2. Surgical read — one function, not the whole file**

```
# Without token-goat: full file read.
$ wc -l src/auth.py
512 src/auth.py            # ~12,000 tokens

# With token-goat: pull just the function.
$ token-goat read "src/auth.py::login"
out: 38 lines              # ~300 tokens   (97% smaller)
```

Same applies to `token-goat section "README.md::Install"` — one heading instead of the whole document. Anchor IDs and setext headings resolve too, so `section "doc.md::Quick-start"` works when the file uses `Quick start` as an `<h2>` with an explicit `{#quick-start}` anchor.

**3. Compact manifest — preserve what mattered**

```
# Without token-goat: PreCompact fires with no extra context.
# The summarizer LLM picks what to keep, often loses the edit set.

# With token-goat: PreCompact hook injects a structured manifest.
$ token-goat compact-hint --session-id <id>
out: ~280 tokens covering 8 edited files + 12 symbols accessed + 4 key reads
```

The 280-token manifest is one-shot during compaction. The win is downstream: post-compaction, the agent doesn't re-read files it had already edited, saving a full-file Read pass on each one.

**4. Repomap — orientation without an `ls -R` dump**

```
# Without token-goat: recursive ls + a handful of Read calls to figure out the repo.
$ ls -R . | wc -c
51234                       # ~50 KB of raw paths, no signal about importance

# With token-goat: PageRank-ranked, token-budgeted summary.
$ token-goat map --budget 4000
out: ~4 KB                  # top-ranked files + key symbols   (92% smaller)
```

`--budget` is a hard cap. Below 6 KB the output automatically switches to short-label mode (`f:` files, `s:` symbols, `c:` calls) to fit more signal per byte. `token-goat map --compact` is a shortcut for a 300-token budget when you only need the high-rank cluster.

**5. Bash output compression**

```
# Without token-goat: pytest dumps every PASSED line + dots + tracebacks.
$ pytest -v tests/
... (3 KB of output, 150 PASSED lines, 1 FAILED at the bottom)

# With token-goat: the PreToolUse hook rewrites the command to
# `token-goat compress --filter pytest`. The wrapper runs pytest, captures
# stdout+stderr, applies the per-tool filter, and prints failures first.
$ token-goat compress --filter pytest --cmd "pytest -v tests/"
= test session starts =
collected 150 items
FAILED tests/test_x.py::test_one
= 1 failed, 149 passed in 2.3s =

[token-goat: collapsed 149 PASSED lines]
[token-goat: pytest filter compressed 4.8 KiB to 0.1 KiB (97% saved)]
```

Twelve built-in filters cover the noisiest dev commands: `pytest`, `jest` / `vitest`, `cargo`, `npm` / `pnpm` / `yarn`, `docker`, `kubectl` / `helm`, `aws`, `ruff` / `eslint` / `mypy`, `git`, `make` / `gradle` / `mvn` / `go`, `terraform`, and `pip`. Each one strips ANSI escapes, collapses `\r` progress bars, dedupes repeated lines, groups linter issues by rule, keeps every error block verbatim, and caps total output at 1000 lines / 64 KiB. Disable globally with `TOKEN_GOAT_BASH_COMPRESS=0`, per-filter via `[bash_compress] disabled_filters = ["docker"]` in config.toml, or preview the output of any command with `token-goat compress --cmd '<your command>'`.

## Install

**Windows requirements:** Windows 10 or 11 · Python 3.11, 3.12, or 3.13 · [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`)

**Linux / WSL requirements:** Python 3.11, 3.12, or 3.13 · [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

**macOS requirements (untested):** Python 3.11, 3.12, or 3.13 · [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

```
uv tool install token-goat
token-goat install
token-goat doctor          # confirms image codecs (WebP/JPEG/PNG) are available
```

Three commands. Done. Hooks register, a background worker starts at logon and stays out of the way. No terminal popups, no tray icon, no service to babysit.

**Important — image codecs are part of the install.** The biggest single win (~39% smaller than JPEG, ~97% smaller than raw PNG) comes from WebP encoding. Pillow ships with WebP/JPEG/PNG support on Windows and macOS out of the box, but Linux/WSL minimal images sometimes lack the system libraries (libwebp, libjpeg, zlib). `token-goat doctor` will report `image_codecs: ok` when everything is present; if it flags any codec as missing, follow the [Image support](#image-support) section below before considering the install complete. **AI agents performing this install: run `token-goat doctor` after `token-goat install` and resolve any missing codecs as part of the same task — do not treat it as a follow-up.**

Two things change how Claude Code sessions behave: hooks fire automatically (image shrink, re-read dedup, compact manifests), and a block written to `~/.claude/CLAUDE.md` plus a registered skill tell the agent to prefer `token-goat read` / `symbol` / `section` over full-file reads. A `Bash(token-goat:*)` allowlist entry in `settings.json` lets the agent run those commands without a per-call approval prompt.

On Linux and WSL, the worker registers as a systemd user service when systemd is available. On WSL without systemd, and on macOS, the SessionStart hook ensures the worker is running at the start of every Claude Code session.

### Codex CLI users

```
token-goat install --codex
```

The `--codex` flag patches both Claude Code and Codex CLI in one pass.

### opencode users

```
token-goat install --opencode
```

The `--opencode` flag patches Claude Code and drops a TypeScript bridge plugin into opencode's plugins directory — one command, no separate base install. Image shrinking, post-edit indexing, and compact assist work. Session hints don't — opencode's plugin API has no way to inject context before a tool read.

### openclaw users

```
token-goat install --openclaw
```

The `--openclaw` flag patches Claude Code and drops a TypeScript bridge plugin into `~/.openclaw/plugins/` and registers it in `openclaw.json` — one command, no separate base install. Image shrinking, post-edit indexing, and pre-fetch denial work. Session hints and compact assist don't — no context injection point, no compaction event.

### Updating

Updates ship automatically. `token-goat install` schedules a weekly `uv tool upgrade token-goat` run at Sunday 03:00 local time (Windows scheduled task; Linux/macOS crontab line tagged `# token-goat-autoupdate`). `token-goat uninstall` reverses it.

Manual paths:

| When | Command |
|------|---------|
| Update now | `uv tool upgrade token-goat` |
| Reinstall from scratch (broken venv, missing image codec) | `uv tool install --reinstall --force token-goat` |
| Disable auto-updates | Delete the `token-goat-update` scheduled task (Windows) or the `# token-goat-autoupdate` crontab line (Linux/macOS) |

## CLI

| Command | What it does |
|---------|-------------|
| `token-goat symbol <name>` | Jump to a symbol definition. Add `--all-projects` to search across every indexed repo. |
| `token-goat read "file::symbol"` | Pull one function or class, not the whole file. Supports qualified lookups: `read "file.py::Class.method"`. |
| `token-goat section "doc.md::Heading"` | Pull one Markdown section by heading. Disambiguate duplicates with `"doc.md::Heading#2"`. |
| `token-goat semantic "<query>"` | Find code by meaning, not by filename. Tune with `--max-distance <float>` or `--no-rerank`. |
| `token-goat map` | Get a compact orientation of the repo. Add `--compact` to fit a 300-token budget. |
| `token-goat gdrive-sections <file-id>` | List the heading outline of a Google Doc without fetching the body. |
| `token-goat stats` | See how many tokens you have saved. Shows a per-source breakdown (image / hint / read / compact / bash / web). |
| `token-goat bash-output <id>` | Retrieve a cached Bash output by ID instead of re-running the command. Large outputs return a head+tail view by default; pass `--full` for everything, or narrow with `--head N`, `--tail N`, or `--grep PATTERN`. |
| `token-goat bash-history` | List cached Bash outputs (newest first) with their IDs, byte sizes, and exit codes. |
| `token-goat compress --cmd '<command>'` | Preview what the Bash compression hook would do to any command — runs it, applies the matching filter, and prints the compressed view. |
| `token-goat web-output <id>` | Retrieve a cached WebFetch response body by ID — same head+tail default, `--full`, and `--head`/`--tail`/`--grep` slicers as `bash-output`. |
| `token-goat web-history` | List cached WebFetch responses (newest first) with their IDs, byte sizes, status codes, and URL previews. |
| `token-goat compact-hint --session-id <id>` | Inspect the compaction manifest for a session |
| `token-goat install` | Wire up hooks and autostart. `--dry-run` previews the changes, `--verify` audits an existing install. |
| `token-goat doctor` | Confirm everything is wired correctly |

First `token-goat semantic` call downloads a small embedding model, about 130 MB, into the token-goat data directory. One-time. Offline after that.

Missed lookups recover surgically: `symbol` auto-redirects to a single high-confidence close match (pass `--strict` to opt out), while `read` and `section` print a "Did you mean…?" list — a typo costs at most one extra glance, not a re-read.

## What gets installed?

`token-goat install` writes the following on your machine — nothing else, anywhere. Every entry is reversed by `token-goat uninstall`. Run `token-goat doctor` at any time to see which of these are currently present.

**Claude Code integration** (`~/.claude/`)

| Path | What |
|------|------|
| `~/.claude/settings.json` | Hook entries for `SessionStart`, `PreToolUse` (Read/Grep/Bash, Drive/WebFetch), `PostToolUse` (Edit/Write/MultiEdit, Read/Grep/Glob, Bash, WebFetch), and `PreCompact`. Plus a `Bash(token-goat:*)` permission allowlist entry. Existing hooks are preserved; a timestamped `.bak` is written before any change. |
| `~/.claude/CLAUDE.md` | A delimited block (`<!-- token-goat-begin -->` … `<!-- token-goat-end -->`) telling the agent to prefer `token-goat read` / `symbol` / `section` over `Read` / `Grep`. Any existing content is preserved. |
| `~/.claude/skills/token-goat/SKILL.md` | The token-goat skill — the same routing guidance in skill form. |

**Worker autostart** (one of the following, picked by platform)

| Platform | Entry |
|---------|------|
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\token-goat-worker`. No admin rights required. |
| Linux (with `systemd --user`) | `~/.config/systemd/user/token-goat-worker.service`, enabled. |
| Linux (no systemd, incl. WSL) | `~/.config/autostart/token-goat-worker.desktop`. On WSL without systemd, the SessionStart hook also starts the worker on every Claude Code session. |
| macOS (untested) | `~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist`, loaded via `launchctl`. |

The autostart command is `pythonw -m token_goat.cli worker --daemon` from Token-Goat's `uv tool` venv. No PyInstaller-style launcher `.exe` is dropped; AV/EDR products do not behavior-flag this invocation pattern.

**Weekly auto-update** (Sunday 03:00 local time, runs `uv tool upgrade token-goat`)

| Platform | Entry |
|---------|------|
| Windows | Scheduled task `token-goat-update` (`schtasks`). |
| Linux / macOS | A `crontab` line tagged with `# token-goat-autoupdate`. |

**Data directory** (created on first run)

| Platform | Path |
|---------|------|
| Windows | `%LOCALAPPDATA%\dfk-helper\token-goat\` |
| Linux / WSL | `~/.local/share/token-goat/` |
| macOS | `~/Library/Application Support/dfk-helper/token-goat/` |

Contains the symbol index (`global.db`, per-project `.db` files), session cache, shrunken-image cache, embedding model (~130 MB, downloaded on the first `semantic` call), logs, locks, and the dirty-file queue. Nothing outside this directory and `~/.claude/` is written.

**With `--codex`** (Codex CLI integration)

| Path | What |
|------|------|
| `~/.codex/config.toml` | Hooks block with Codex-specific matchers (`view_image|Bash`, `apply_patch`, `web_search`). Existing hooks preserved. |
| `~/.codex/AGENTS.md` | A delimited block (`<!-- token-goat-codex-begin -->` … `<!-- token-goat-codex-end -->`) with the same routing guidance, adapted for Codex tool names. |

**With `--opencode`** (opencode plugin)

| Path | What |
|------|------|
| `~/.config/opencode/plugins/token-goat.ts` (Linux/macOS) or `%APPDATA%\opencode\plugins\token-goat.ts` (Windows) | TypeScript bridge plugin. Fires on `tool.execute.before`, `tool.execute.after`, and `experimental.session.compacting`. Covers image shrinking, post-edit indexing, and compact assist. |

**With `--openclaw`** (openclaw plugin)

| Path | What |
|------|------|
| `~/.openclaw/plugins/token-goat-bridge.ts` | TypeScript bridge plugin. Fires on `before_tool_call` and `after_tool_call`. Covers image shrinking, post-edit indexing, and pre-fetch denial. |
| `~/.openclaw/openclaw.json` | Plugin entry added under `plugins.entries`. Existing entries preserved. |

## Zero maintenance

After install, there is nothing to start, stop, or restart. The worker runs at logon on Windows, Linux, and macOS; on WSL without systemd, the SessionStart hook covers it. Survives reboots on every platform. `token-goat uninstall` reverses every change, including the startup entry.

## Verify

```
token-goat doctor
token-goat stats
```

`doctor` confirms the install is healthy. `stats` shows cumulative savings.

## Image support

The image-shrink pipeline relies on Pillow with WebP, JPEG, and PNG codecs. Pillow ships as a binary wheel on every platform `uv` supports, so a normal `uv tool install token-goat` puts all three codecs in place without extra steps. The instructions below are only needed if `token-goat doctor` reports `Pillow codecs: WebP=MISSING` (or similar) — that flag means Pillow was built from source against a system that did not ship the codec libraries.

Quick check (any platform):

```
token-goat doctor
```

If the `Pillow codecs` line reports any `MISSING` or `FAIL`, follow the platform section below.

### Windows

The official Pillow wheel for Windows bundles libwebp, libjpeg-turbo, and libpng. A failing codec almost always means Pillow was reinstalled inside a stripped-down environment. Reinstall token-goat (and its bundled Pillow wheel) end-to-end:

```powershell
uv tool install --reinstall --force token-goat
token-goat doctor
```

### macOS

Same story as Windows — the universal wheel ships every codec. Reinstall to get the wheel back:

```bash
uv tool install --reinstall --force token-goat
token-goat doctor
```

If you previously installed Pillow via Homebrew with `--build-from-source`, install the libraries first, then reinstall:

```bash
brew install webp jpeg-turbo libpng
uv tool install --reinstall --force token-goat
```

### Linux / WSL

Almost every Linux distro pulls the manylinux Pillow wheel, which bundles every codec. The exceptions are: musl-based distros (Alpine), some ARM boards lacking a matching wheel, and environments where the user forced `--no-binary :all:`. In those cases, install the system headers, then reinstall:

```bash
# Debian / Ubuntu / WSL
sudo apt-get update
sudo apt-get install -y libwebp-dev libjpeg-turbo8-dev libpng-dev
uv tool install --reinstall --force token-goat
token-goat doctor
```

```bash
# Fedora / RHEL / Alma
sudo dnf install -y libwebp-devel libjpeg-turbo-devel libpng-devel
uv tool install --reinstall --force token-goat
```

```bash
# Arch / Manjaro
sudo pacman -S --noconfirm libwebp libjpeg-turbo libpng
uv tool install --reinstall --force token-goat
```

```bash
# Alpine
sudo apk add libwebp-dev libjpeg-turbo-dev libpng-dev
uv tool install --reinstall --force token-goat
```

### AI automated setup

Non-interactive snippets agents can run unattended. Each one is idempotent: it checks current state before changing anything, and re-runs `token-goat doctor` at the end so the agent can verify success from the output.

#### Windows (PowerShell)

```powershell
# 1. Verify token-goat is reachable; reinstall if not
if (-not (Get-Command token-goat -ErrorAction SilentlyContinue)) {
    uv tool install token-goat
}

# 2. If doctor flags any image codec, reinstall the bundled Pillow wheel
$doctor = token-goat doctor 2>&1 | Out-String
if ($doctor -match 'Pillow codecs:.*(MISSING|FAIL)') {
    uv tool install --reinstall --force token-goat
}

# 3. Verify
token-goat doctor
```

#### macOS / Linux / WSL (bash)

```bash
set -e

# 1. Verify token-goat is reachable; reinstall if not
command -v token-goat >/dev/null 2>&1 || uv tool install token-goat

# 2. If doctor flags any image codec, install platform packages then reinstall
need_fix=$(token-goat doctor 2>&1 | grep -E 'Pillow codecs:.*(MISSING|FAIL)' || true)
if [[ -n "$need_fix" ]]; then
    OS="$(uname -s)"
    if [[ "$OS" == "Darwin" ]]; then
        command -v brew >/dev/null 2>&1 && brew install webp jpeg-turbo libpng
    elif [[ "$OS" == "Linux" ]]; then
        if   command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update && sudo apt-get install -y libwebp-dev libjpeg-turbo8-dev libpng-dev
        elif command -v dnf     >/dev/null 2>&1; then
            sudo dnf install -y libwebp-devel libjpeg-turbo-devel libpng-devel
        elif command -v pacman  >/dev/null 2>&1; then
            sudo pacman -S --noconfirm libwebp libjpeg-turbo libpng
        elif command -v apk     >/dev/null 2>&1; then
            sudo apk add libwebp-dev libjpeg-turbo-dev libpng-dev
        fi
    fi
    uv tool install --reinstall --force token-goat
fi

# 3. Verify
token-goat doctor
```

## Stats display

`token-goat stats` uses 24-bit ANSI color and Unicode block characters for gradient bars, sparklines, and the activity heatmap. In the right terminal it renders sharply. In the wrong one you get broken characters, flat gray blocks, or a "rich is not installed" error.

When it's working, the output shows rounded box borders (╭─╮), gradient bars with fractional edges (▏▎▍▌▋▊▉█), sparklines (▁▂▃▄▅▆▇█), and a heatmap where cells step from dark to bright green. Question marks, boxes, or solid-color bars mean the terminal or font needs fixing.

---

### Windows

The old Windows console host — `cmd.exe`, the legacy "Windows PowerShell" app — does not support 24-bit color. Windows Terminal does.

**Step 1: Install Windows Terminal** (already on Windows 11; skip if you have it)
```powershell
winget install --id Microsoft.WindowsTerminal -e --silent
```

**Step 2: Set it as the default terminal** (Windows 10 only — Windows 11 handles this automatically)

Open Windows Terminal → `Ctrl+,` → **Startup** → **Default terminal application** → **Windows Terminal** → **Save**.

**Step 3: Confirm the font**

Windows Terminal ships with Cascadia Code, which covers every character token-goat uses. No additional install needed. To confirm it's selected: `Ctrl+,` → **Profiles → Defaults → Appearance** → Font face should read `Cascadia Code` or `Cascadia Mono`.

If you prefer a Nerd Font, download any variant from [nerdfonts.com](https://www.nerdfonts.com/font-downloads), install it, and select it in the font preference above.

**If bars still look flat** (solid single-color blocks instead of a gradient), add to your PowerShell profile (`$PROFILE`):
```powershell
$env:COLORTERM = "truecolor"
```

---

### macOS

Terminal.app on Catalina and later, iTerm2, and the VS Code integrated terminal all handle truecolor and Unicode without configuration. Most users need nothing here. (macOS is untested — see the badge at the top.)

If sparklines or box borders show as question marks or plain dashes, install a complete font:
```bash
brew install --cask font-jetbrains-mono-nerd-font
```
Set it in your terminal's font preferences and reopen.

If colors look flat, add to `~/.zshrc` or `~/.bash_profile`:
```bash
export COLORTERM=truecolor
```

---

### Linux / WSL

**WSL users:** you're running inside Windows Terminal. Follow the Windows steps above — same terminal, same font.

**SSH sessions:** the remote shell doesn't inherit truecolor from the local terminal. Add to `~/.bashrc` on the remote machine:
```bash
export COLORTERM=truecolor
export TERM=xterm-256color
```

**Missing Unicode characters:** any Nerd Font covers everything token-goat uses.
```bash
# Ubuntu / Debian
sudo apt install fonts-jetbrains-mono

# Arch
sudo pacman -S ttf-jetbrains-mono-nerd
```

---

### AI automated setup

Scripts for non-interactive setup. No prompts.

#### Windows (PowerShell)
```powershell
# 1. Install Windows Terminal if absent
if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    winget install --id Microsoft.WindowsTerminal -e --silent
}

# 2. Set Windows Terminal as the default console host
#    UI equivalent: Windows Terminal -> Ctrl+, -> Startup -> Default terminal application -> Windows Terminal
#    GUIDs are for Windows Terminal stable release
reg add "HKCU\Console" /v DelegationConsole /t REG_SZ /d "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}" /f
reg add "HKCU\Console" /v DelegationTerminal /t REG_SZ /d "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}" /f

# 3. Enable truecolor for the current session and persistently for the user account
[System.Environment]::SetEnvironmentVariable("COLORTERM", "truecolor", "User")
$env:COLORTERM = "truecolor"

# 4. Verify
token-goat stats
```

#### macOS / Linux / WSL (bash)
```bash
OS="$(uname -s)"

# Install a complete font
if [[ "$OS" == "Darwin" ]]; then
    command -v brew &>/dev/null && brew install --cask font-jetbrains-mono-nerd-font
elif [[ "$OS" == "Linux" ]]; then
    command -v apt-get &>/dev/null && sudo apt-get install -y fonts-jetbrains-mono
    command -v pacman  &>/dev/null && sudo pacman -S --noconfirm ttf-jetbrains-mono-nerd
fi

# Enable truecolor — appends only if not already present
RCFILE="${HOME}/.zshrc"
[[ -f "${HOME}/.bashrc" ]] && RCFILE="${HOME}/.bashrc"
grep -q "COLORTERM=truecolor" "$RCFILE" || echo 'export COLORTERM=truecolor' >> "$RCFILE"
grep -q "TERM=xterm-256color" "$RCFILE" || echo 'export TERM=xterm-256color' >> "$RCFILE"
# shellcheck disable=SC1090
source "$RCFILE"

# Verify
token-goat stats
```

#### Truecolor check (any platform)

Run this if the stats output still looks wrong. A smooth green gradient from left to right means truecolor is active. Solid single-shade green means it isn't.

```bash
python3 -c "
import sys
for r in range(0, 256, 32):
    sys.stdout.write(f'\x1b[48;2;0;{r};0m  ')
sys.stdout.write('\x1b[0m\n')
"
```

## Security, privacy, and uninstall

**No telemetry. No analytics. No background reporting or silent outbound connections.**

Outbound network is reserved to three explicit cases:

- First `token-goat semantic` call downloads the embedding model (~130 MB) into the data directory. Offline after that.
- Google Drive API calls, only if you already authorized Drive in Claude Code. Token-goat never prompts for its own auth.
- Image fetches from URLs: either explicit via `token-goat fetch-image <url>`, or when the AI agent issues a WebFetch call that returns image content — the hook intercepts and shrinks the image. The URL always originates from the agent's work, not from token-goat itself.

**Security reports.** See [SECURITY.md](SECURITY.md). Email `token-goat@dfkhelper.com`; do not file as a GitHub issue. Reports are acknowledged within 7 days; coordinated disclosure with a 90-day default window.

**Windows Defender (optional, Windows only).** Real-time scanning slows indexing. To exclude the data folder, open PowerShell as administrator:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\dfk-helper\token-goat"
```

`0x800106ba` means the prompt is not elevated; reopen as administrator. On enterprise-managed Windows (domain-joined / Intune), Defender exclusions may be locked by Group Policy. The command will fail; that is expected and harmless.

**Uninstall.**

```
token-goat uninstall
```

Reverses everything in [What gets installed?](#what-gets-installed): the scheduled task or systemd unit, the registry value or `.desktop` or `.plist`, the hook entries in `settings.json`, the `CLAUDE.md` block, the skill directory. Add `--codex`, `--opencode`, or `--openclaw` to also strip those integrations. Add `--purge` to also delete the data directory (cache, index, models, logs). Nothing else on the system depends on it.

## About

I built this because long Claude Code and Codex sessions on my machine kept burning context in the same ways: screenshots landing at 2-3 MB, the agent re-reading a file it parsed hours earlier in the same conversation, compactions that forgot which functions were edited. Each felt preventable.

This is a solo project. I use it daily on Windows 11. Tests run across Python 3.11, 3.12, and 3.13.

## Requests and issues

Want token-goat to support something it doesn't yet? Open a GitHub issue. Feature requests: a new agent CLI integration (Cursor, Aider, Continue, Cline), a new language adapter (Ruby, Swift, Kotlin, C++), or an image or document format the shrink path doesn't compress yet. Issues are public and searchable. That's where I work out what to build next. A short repro plus what you'd want the command to do is enough.

Bug reports go to the same place. The most useful ones include:
- Your OS, shell, and token-goat version (`token-goat --version`)
- The matching log line from `%LOCALAPPDATA%\dfk-helper\token-goat\logs\` on Windows or `~/.local/share/token-goat/logs/` on Linux/WSL
- What you expected and what actually happened

For private questions, commercial licensing, or anything you'd rather not post publicly, contact me at token-goat@dfkhelper.com.

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
