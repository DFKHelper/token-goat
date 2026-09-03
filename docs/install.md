---
title: "Install guide"
description: "How to install, wire it into Claude Code, Codex, Gemini, Qwen, Kimi, opencode, OpenClaw, pi, Copilot, Grok, Cline or Cursor, and what lands on your machine."
image: /token-goat/assets/goat-social.png
---

[← Back to the token-goat README](../README.md)

# Install

> **Easiest install:** paste this repo's URL into your AI and ask it to install token-goat properly. It will run the commands, check codecs, and confirm everything is working.

**Requirements:** Node.js 22.16 or later (all platforms)

```
npm install -g token-goat
token-goat install
token-goat doctor          # confirms hooks and sharp are working; look for "sharp: ok"
```

Three commands. Done. Hooks register and start working immediately; no terminal popups, no tray icon, no service to babysit.

### Agents choose the commands

People install token-goat. Agents use it. You do not need to memorize its commands or tell the agent which file type it has.

Installation adds a short routing guide to the agent's instructions. When the agent tries to read a supported binary document, a hook identifies the extension and returns the right next step. The agent starts with an inventory, then reads only the relevant part.

| Task | Agent flow |
| --- | --- |
| Review a PDF | `pdf-meta` and `pdf-outline`, then `pdf-locate` to find the pages that mention a term and `pdf-extract --pages` only those |
| Review a Word document | `docx-outline`, then `docx-text` |
| Review a slide deck | `pptx-outline`, then `pptx-slide` or `pptx-notes` |
| Review a workbook | `xlsx-sheets`, then `xlsx-head`, `xlsx-range`, or `xlsx-query` |

Give the agent the file and the task: “Review `manual.pdf` for warranty exceptions.” It selects the bounded reader. If no routing rule fits, it can run `token-goat commands` instead of guessing.

The commands stay separate so every retrieval is visible, repeatable, and easy to narrow. The agent chooses the sequence; the developer can still inspect or run any step directly.

For bounded archive/document comparisons after setup, see the [CLI comparison workflow](cli.md#archivedocument-comparison-workflow).

**Important — sharp is part of the install.** The biggest single win (~39% smaller than JPEG, ~97% smaller than raw PNG) comes from WebP encoding. sharp ships with prebuilt native binaries on Windows, macOS, and most Linux platforms, so a standard `npm install -g token-goat` includes it. On Alpine musl and some ARM boards, npm compiles from source against libvips — that may add a few seconds. `token-goat doctor` will report `sharp: ok` when the image pipeline is working; if it flags a failure, follow the [Image support](../README.md#image-support) section in the README before considering the install complete. **AI agents performing this install: run `token-goat doctor` after `token-goat install` and resolve any sharp failure as part of the same task — do not treat it as a follow-up.**

Two things change how Claude Code sessions behave: hooks fire automatically (image shrink, re-read dedup, compact manifests), and a delimited routing block written to `~/.claude/CLAUDE.md` plus a registered skill gate the agent's reads — before any file read it must ask whether a `token-goat read` / `symbol` / `section` returns just what it needs, and the block explicitly subordinates the harness's own Read/Grep tool-preference rules to the *fallback* choice once token-goat is ruled out. Install writes no permission entry: whether `token-goat` commands need a per-call approval prompt is left to your own `settings.json`, unchanged.

**Keep that block where install put it.** It's plain markdown in a file you own, so moving it into a tidier reference file is tempting — but `install` and `uninstall` resolve one hardcoded path (`~/.claude/CLAUDE.md`). A relocated copy is never refreshed, so it freezes at whatever version was current when it moved, and the next `install` sees CLAUDE.md missing its block and appends a fresh one — leaving the guidance duplicated across two files with only one of them live. `token-goat doctor` warns when it finds a block outside CLAUDE.md, naming the file; `install` warns at write time and `uninstall` reports what it couldn't remove. None of them edit a file token-goat doesn't own, so cleanup stays your call. A pointer that merely *mentions* the markers in prose is fine — detection requires both markers on their own lines.

The background indexer is not started by `install`. Run `token-goat worker start` on any platform to launch it as a detached process; `token-goat worker status` / `token-goat worker stop` manage it from there.

### Companion CLI tools (recommended — install these too)

token-goat covers the **narrow-read** half of cheap context: pulling one symbol, one section, one cached command output instead of a whole file. It does not cover the **deterministic-transform** half — searching wide, rewriting code structurally, converting data, running language tooling. Those belong in utilities, not in model output: an operation with a defined algorithm is reproducible, cheaper, and checkable against a spec rather than re-read for plausibility. Install these alongside token-goat so an agent has a real tool for each job instead of burning tokens simulating one.

**Priority tier**, the three that close actual gaps in a token-goat-only setup:

| Tool | Why it matters next to token-goat |
|---|---|
| `ast-grep` | The symbol-aware **write** half. token-goat reads by symbol; ast-grep matches the AST and rewrites it (`--rewrite`, YAML rule files). Repo-wide renames, call-shape changes, and codemods become a reviewable diff instead of a model regenerating files. Unlike `rg`/`sd` it ignores comments and strings. |
| `uv` | One Rust binary replacing pip, pyenv, virtualenv, and pipx. Every Python env probe and validation cycle gets an order-of-magnitude faster, so verification stops being the slow step agents skip. |
| `ruff` | Python lint + format in one binary. Agent environment probes commonly emit `ruff check` as the Python verify command; without it installed that path silently degrades to no check at all. |

**Base stack**, what a read or a search falls back to once the gate has ruled token-goat out. The guidance token-goat writes names no binary on purpose, because an instruction-file loader will harvest backticked names into a tool allowlist and then warn that every one of them is unknown. So this list is a recommendation, not something the installed block depends on:

`rg` (search) · `fd` (file discovery) · `bat` (paged/piped reads) · `eza` (listings) · `delta` (diff rendering) · `jq` / `yq` (JSON / YAML) · `sd` (find-replace) · `mlr` (CSV/TSV/JSON records) · `sqlite3` (structured queries) · `gh` (PRs, issues, CI) · `hyperfine` (benchmarks) · `fzf`, `lazygit` (interactive)

Optional but useful: `difft` (difftastic — syntax-aware diff, so reformats and moved blocks stop generating review noise), `just` (task runner, keeps verify commands discoverable), `typos` (deterministic spellcheck).

For archive/document work specifically, token-goat's bounded SQLite, XLSX, and PDF readers are documented in the [CLI comparison workflow](cli.md#archivedocument-comparison-workflow); keep rendering and schema-specific lineage interpretation in dedicated document tooling.

```bash
# macOS / Linux (Homebrew)
brew install ast-grep uv ruff ripgrep fd bat eza git-delta jq yq sd miller sqlite gh hyperfine fzf lazygit

# Debian / Ubuntu — note the binary renames: rg=ripgrep, fd=fdfind, bat=batcat
sudo apt install -y ripgrep fd-find bat jq sqlite3 fzf pipx
pipx install uv && pipx ensurepath     # pipx puts uv in ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"   # this shell; ensurepath covers later ones
uv tool install ruff
npm install -g @ast-grep/cli
```

```powershell
# Windows (winget)
winget install BurntSushi.ripgrep.MSVC sharkdp.fd sharkdp.bat eza-community.eza `
               dandavison.delta jqlang.jq MikeFarah.yq chmln.sd Miller.Miller `
               SQLite.SQLite GitHub.cli sharkdp.hyperfine junegunn.fzf JesseDuffield.lazygit
winget install astral-sh.uv        # then: uv tool install ruff
npm install -g @ast-grep/cli       # provides `ast-grep` (the old `sg` alias is deprecated)
```

If `winget` is unavailable (common when a session runs under a service account rather than an interactive login), `uv` also installs via `python -m pip install uv`, and `ast-grep` only needs npm. Verify the whole set in one pass:

```bash
for t in token-goat ast-grep uv ruff rg fd bat eza delta jq yq sd mlr sqlite3 gh hyperfine; do
  command -v "$t" >/dev/null 2>&1 && echo "$t ok" || echo "$t MISSING"
done
```

### Codex CLI users

```
token-goat install --codex
```

The `--codex` flag patches both Claude Code and Codex CLI in one pass.

### Gemini CLI users

```
token-goat install --gemini
```

This writes hook entries into `~/.gemini/settings.json` using Gemini CLI's `BeforeTool` / `AfterTool` / `PreCompress` event names. Token-goat translates between Gemini's snake_case tool names (`run_shell_command`, `read_file`, `grep_search`, etc.) and its internal format automatically. Image shrinking, session hints, post-edit indexing, compact assist, and bash output compression all work. To remove: `token-goat uninstall --gemini`.

### Qwen Code users

```
token-goat install --qwen
```

This writes hook entries into `~/.qwen/settings.json`. Unlike Gemini CLI (its own ancestor, with a custom `BeforeTool`/`AfterTool`/`PreCompress` event/matcher scheme), Qwen Code's hooks system diverged and now mirrors Claude Code's own natively — `PreToolUse`/`PostToolUse`/`PreCompact`/`UserPromptSubmit`/`SubagentStop` event names and snake_case stdin JSON — so token-goat wires all five events with no event-shape translation. Tool names still need translating: Qwen Code's payloads carry its own runtime tool ids (`read_file`, `run_shell_command`, `grep_search`, ...), which token-goat maps to its internal tool vocabulary from Qwen Code's own tool-name source. token-goat uses a catch-all matcher per event rather than an incomplete per-tool list. Image shrinking, session hints, post-edit indexing, compact assist, and bash output compression all work. This bridge was built from QwenLM/qwen-code's published docs, not tested against a live Qwen Code install — if hooks aren't firing, `token-goat doctor` and the settings.json contents are the first things to check. To remove: `token-goat uninstall --qwen`.

### Kimi Code users

```
token-goat install --kimi
```

This writes `[[hooks]]` entries into `~/.kimi-code/config.toml` (or `$KIMI_CODE_HOME/config.toml`), covering Kimi Code's `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, `SubagentStop`, and `SessionStart` events. Kimi Code sends a Claude-Code-shaped snake_case payload on stdin, but it reads a different response: only a top-level `message` and `hookSpecificOutput.permissionDecision` / `permissionDecisionReason`. So the install also writes a small shim at `~/.kimi-code/hooks/token-goat-shim.js` that translates token-goat's answer into that contract, turns a hint into `message`, and writes nothing at all for a no-op. Image shrinking, session hints, post-edit indexing, compact assist, and bash output compression all work. `Notification` and `Stop` are not wired, because token-goat has no handler for them. Input and output rewriting are not wired either: Kimi Code offers no channel to replace a tool's input or its result. This bridge was built from MoonshotAI/kimi-code's own source and docs, not tested against a live Kimi Code install, so if hooks are not firing, `token-goat doctor` and the `config.toml` contents are the first things to check. To remove: `token-goat uninstall --kimi`.

### opencode users

```
token-goat install --opencode
```

The `--opencode` flag patches Claude Code and drops a TypeScript bridge plugin into opencode's plugins directory — one command, no separate base install. Image shrinking, post-edit indexing, compact assist, and rewritten tool results (prompt-injection fencing, secret redaction, and output compression replace the raw result, the same protection Claude Code sessions get) work. So do repeat-search denial for `websearch`, repeat-load denial for `skill`, and the subagent prompt briefing for `task` — all three tool ids and their argument keys were verified against opencode's own source at the installed release's tag. Session hints don't — opencode's plugin API has no way to inject context before a tool read.

### openclaw users

```
token-goat install --openclaw
```

The `--openclaw` flag patches Claude Code and registers a TypeScript bridge plugin with OpenClaw's gateway: it drops `~/.openclaw/plugins/token-goat.ts` and adds it to `~/.openclaw/openclaw.json`'s `plugins.load.paths` / `plugins.entries` (existing config is merged, never overwritten). OpenClaw's plugin SDK does support `before_tool_call`/`after_tool_call` hooks with the block/rewrite shape token-goat needs; unlike the other bridges, no argument-key remapping is needed at all, since OpenClaw's tool-call params are already snake_case (`file_path`, `command`, etc.) — the same keys token-goat's own `tool_input` uses.

What works: **bash output compression**, **re-read denial** and **surgical-read redirects for oversized first reads**, **image shrinking** (`before_tool_call` returns rewritten `params` whose `path` points at a materialized shrunk copy, the same mechanism the pi bridge uses), and **post-edit indexing** (all via `before_tool_call`/`after_tool_call`; OpenClaw's read/edit/write tools send the file path under `path`, which the plugin now forwards to token-goat as `file_path` too — earlier versions of this bridge assumed the keys already matched, so these read/edit hooks silently never engaged). What doesn't: **session hints** — OpenClaw's tool-call hooks have no context-injection channel, only param rewriting — and the **compaction manifest** — OpenClaw's `before_compaction`/`after_compaction` are observation-only, with no return-value mechanism to inject a manifest into the next turn the way pi's compaction hooks do.

This bridge has not been validated against a live OpenClaw instance — it's built from OpenClaw's documented plugin SDK and hook event types, not tested against a real running gateway. If tool calls aren't being intercepted, the built-in tool name list in `openclaw.ts`'s `TOOL_TO_TG` map is the first thing to check. To remove: `token-goat uninstall --openclaw`.

### pi users

```
token-goat install --pi
```

The `--pi` flag patches Claude Code and drops a TypeScript extension into pi's global extensions directory (`~/.pi/agent/extensions/token-goat.ts`). pi auto-discovers it on the next launch (approve the project-trust prompt the first time). The extension is a normal pi extension — a default-exported factory that subscribes to `session_start`, `tool_call`, `tool_result`, `session_before_compact`, and `session_compact` — and bridges those events into token-goat's `token-goat hook <event>` subprocess protocol.

What works: **bash output compression** (the bash command is rewritten in `tool_call`; pi's `powershell` tool, whose input schema is identical to its bash tool's, is bridged the same way), **re-read denial** and **surgical-read redirects for oversized first reads** (both return `{ block, reason }` from `tool_call` — a confirmed re-read, or a first read at/above the pressure-scaled `large_read_redirect_bytes` gate, pointing at `token-goat skeleton`/`section`/`symbol` instead), **image shrinking** (`tool_call` rewrites the read path in place to a materialized shrunk copy), **post-edit indexing**, **output caching** and **rewritten tool output** (all three from `tool_result`: a compressed or redacted result is returned to pi as replacement content, with any image blocks in the result left in place), and the **compaction manifest** (captured at `session_before_compact`, re-injected after `session_compact` since pi's compaction replaces rather than appends). Skill-overhead preservation does not apply — pi has no Skill tool; skills are template expansions. To remove: `token-goat uninstall --pi`.

**Project-local install (single project only).** pi also loads extensions from a project's `.pi/extensions/` directory (after the project is trusted). To install for one project without touching the global directory, drop the extension there:

```bash
npx token-goat install --pi --local
```

This writes `.pi/extensions/token-goat.ts` in the current project only. Remove it by deleting that file.

### Copilot CLI users

```
token-goat install --copilot
```

The `--copilot` flag patches Claude Code and registers a Copilot CLI hook config: `~/.copilot/hooks/token-goat.json` (a `{ version, hooks }` file registering `sessionStart`, `preToolUse`, `postToolUse`, `preCompact`, `agentStop`, `subagentStop`, and `userPromptSubmitted`, per Copilot's own [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)) plus the shim script it points at, `~/.copilot/hooks/token-goat-shim.js`. Unlike Codex, Copilot's event names and response schema (`permissionDecision`/`modifiedArgs` for `preToolUse`, `modifiedResult`/`additionalContext` for `postToolUse`, `decision`/`reason` for `agentStop`/`subagentStop`) genuinely differ from Claude Code's, so the shim translates rather than passes through.

What works: **the command-routing reminder** (`sessionStart` returns `additionalContext`, so Copilot is told token-goat exists before it picks its first read tool — this is the one channel that lands ahead of that decision), **bash output compression and re-read denial** (`preToolUse` returns `modifiedArgs` or `permissionDecision: "deny"`), **background-shell output compression** (`postToolUse` returns `modifiedResult`), **image shrinking** (`preToolUse` on a `view` call returns `modifiedArgs` carrying the full original arguments with `path` swapped to a materialized shrunk copy — Copilot replaces the tool call's arguments wholesale with `modifiedArgs`, so the rewrite must carry them all), **post-edit indexing** (a `postToolUse` side effect; it needs no response channel), and **stop-hallucination logging** (`agentStop`/`subagentStop` map a token-goat `deny` onto `decision: "block"`, everything else onto `decision: "allow"`). `preCompact` and `userPromptSubmitted` are notification-only on real Copilot CLI, per its docs: Copilot never reads a response body for either, so token-goat's compaction manifest and prompt-context hints have no surfacing channel there. The shim still calls through for both so token-goat's internal side effects keep running, but nothing gets injected back into the agent. Copilot's built-in tool names are remapped onto token-goat's internal names where a clear match exists (`view`→Read, `edit`→Edit, `create`→Write, `bash`/`powershell`→Bash, `read_bash`/`read_powershell`→BashOutput, `web_fetch`→WebFetch, `grep`→Grep, `glob`→Glob). MCP-server tool calls, which Copilot names `<server>-<tool>` rather than `mcp__<server>__<tool>`, are translated too, but only when the name matches Copilot's own cached tool list exactly — never guessed from the name's shape, because a server name can itself contain a hyphen and a wrong guess would make the read-only MCP dedup path deny an ordinary built-in call. With no cache to match against, nothing is translated. `memory`, `ask_user`, `write_bash`/`write_powershell` (which send keystrokes to a running shell, not commands), and `stop_bash`/`list_bash` pass through unmapped and simply no-op. `task`, Copilot's subagent tool, is not remapped either, but it is handled under its own name: a `task` spawn gets the same prompt briefing, duplicate-spawn advisory, and recall pointer on a long report that a Claude Code `Agent` spawn gets. The once-per-session unrestricted-spawn advisory is the one exception: it is suppressed under Copilot, because it rides the `postToolUse` `additionalContext` channel Copilot discards, and its `subagent_type` advice describes Claude Code's Task schema, which Copilot's `task` tool does not use.

**Why the background-shell compression matters most on Copilot.** Copilot runs shell commands in the background: a build or a test suite is started once, and the model then checks on it repeatedly while it runs. Each check hands back everything the command has printed since it started, from the first line. So the second check re-sends the whole first check, the third re-sends the first two, and a check ten minutes into a slow build re-sends the same output for the tenth time. The model has already read all of it and pays again for every word, every time. Token-goat sends the first check through untouched, then returns only the new part on each later check, with one line saying that is what it is; a check that found nothing new comes back as a single short line instead of the whole output again. Measured through the installed hook: a second check of 5,200 characters came back as about 1,250, and a third check that added nothing came back as 60 — roughly a quarter of the cost for the second look and about one percent for the third, improving the longer the command runs. Nothing is lost, because what is cut is what was already sent. It only shortens a check when the new output genuinely continues the last one seen; anything else passes straight through, so the worst case is a saving that does not happen rather than a wrong answer.

No ambient environment variable documents "this process is running under Copilot CLI" the way Codex/opencode set one, so the shim sets `TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli` itself before calling `token-goat hook` (same workaround `--pi` uses). Install also writes a token-goat routing block into `~/.copilot/copilot-instructions.md` (the same delimited-block gate written to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`), merged idempotently so any hand-written content outside the markers is preserved byte-for-byte. If you set `COPILOT_HOME`, install follows it — hooks go to `$COPILOT_HOME/hooks/` and the routing block to `$COPILOT_HOME/copilot-instructions.md`, matching where Copilot CLI actually reads them. To install for one project instead of user scope: `token-goat install --copilot --local` (writes `.github/hooks/token-goat.json` and `.github/copilot-instructions.md` in the current project). To remove: `token-goat uninstall --copilot`.

**If Copilot CLI starts denying every tool call with `Denied by preToolUse hook ... (hook errored)`:** this is Copilot's own fail-closed behavior for a `preToolUse` hook that crashes, exits non-zero, or returns unparseable output -- it isn't limited to token-goat's own tool calls, since a fail-closed `preToolUse` hook blocks the whole session. Copilot caches hook configs at session start, so **renaming or reinstalling the hook mid-session has no effect** -- the only recovery is: run `token-goat install --copilot` (or `token-goat doctor`, which now checks the installed hook end-to-end and calls out a stale node-binary path from an nvm/fnm/volta upgrade specifically), then **fully restart Copilot CLI**.

### Grok CLI (xAI Grok Build) users

Grok Build already reads Claude Code's `~/.claude/settings.json` as a "Harness Compatibility" source out of the box (confirmed against grok 0.2.93 and its own [hooks doc](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)), so `token-goat install` alone already gets most of the integration working — image shrinking, session hints, post-edit indexing, and bash output compression all fire. The one gap: Grok's own `PreToolUse` hook contract documents only `{"decision":"allow"}` / `{"decision":"deny","reason":"..."}`, never token-goat's harness-independent `{"decision":"block","reason":"..."}` shape (unlike Gemini CLI, whose docs explicitly confirm `"block"` as an accepted alias for `"deny"`), so re-read denial and oversized-first-read redirects don't reliably block on the Claude Code compat path alone.

```
token-goat install --grok
```

The `--grok` flag patches Claude Code and additionally writes a standalone hook config at `~/.grok/hooks/token-goat.json` (global scope only — Grok's own project-scoped `<project>/.grok/hooks/*.json` requires a separate manual `/hooks-trust` grant this bridge can't perform for you) plus the shim it points at, `~/.grok/hooks/token-goat-shim.js`. The shim's only job is translating that one response shape: a token-goat `{"decision":"block",...}` deny becomes Grok's documented `{"decision":"deny",...}` (with exit code 2, matching Grok's own "explicit deny" convention), and every other event's response is forwarded through unmodified — Grok already sends the raw camelCase wire payload (`toolName`/`toolInput`/`sessionId`) token-goat's built-in `grok` harness detection (`GROK_SESSION_ID`, set on every hook subprocess Grok spawns) already normalizes correctly. That normalization maps every tool id registered in the grok 0.2.93 binary itself — both shell-tool spellings (`run_terminal_command` and `run_terminal_cmd`), `web_fetch`, `web_search`, `glob`, and the `hashline_*`/`*_concise` read/edit/grep variants — onto token-goat's internal tool names, so hooks fire regardless of which id a given Grok build sends.

To remove: `token-goat uninstall --grok`.

### Cline, Windsurf, Cursor, and other AI tool CLIs

No separate install step needed. Token-goat compresses the terminal output of these tools automatically as soon as they appear on your PATH. Run `token-goat doctor` to confirm they are detected — the "Third-party AI tools" section will show `detected — bash output compression active`.

Filters are built in for: **Cline** (`cline` / `claude-dev`), **Windsurf** (`windsurf`, including Cascade AI patterns), **Cursor** (`cursor`), **GitHub Copilot CLI** (`gh copilot explain/suggest` and the standalone `copilot` binary — this passive output filter is separate from the `--copilot` hook bridge above; it works with no install step and covers Copilot CLI's own terminal chrome, not the hook-driven read/index integrations), **Aider** (`aider`), **Continue** (`continue`), **OpenCode** (`opencode`). Each filter strips version banners, spinner/thinking lines, token-usage boilerplate, and tool-call progress noise while keeping the AI response body, error signals, and any user-approval prompts verbatim.

### Updating

There is no auto-update mechanism — token-goat never schedules or runs anything on its own. Updating is always a manual `npm install -g token-goat@latest`.

| When | Command |
|------|---------|
| Update now | `npm install -g token-goat@latest` |
| Reinstall from scratch (broken install, sharp failure) | `npm install -g token-goat@latest` |

### Upgrading from the Python version

The old Python package (`pip install token-goat`) wrote hook entries into `settings.json` with commands containing `token_goat` (underscore), invoking Python directly: something like `pythonw.exe -m token_goat.cli hook pre_tool_use`. The npm package invokes a generated shim instead (`"<node>" "~/.claude/hooks/token-goat-shim.js" pre_tool_use "<entry>"`).

Both `install` and `uninstall` recognize the older command spellings — `token_goat`, `tokenwise`, `tg-hook`, `token-goat-hook`, and the pre-shim `token-goat hook` — so you do not need to hand-edit `settings.json`. Installing replaces a stale entry in place rather than leaving a dead one beside the new one, and uninstalling removes it.

To upgrade cleanly:

1. Remove the Python package: `pip uninstall token-goat`
2. Install and register the npm package: `npm install -g token-goat && token-goat install`
3. Verify: re-run `token-goat install`, which should now report hooks already up to date, or use the `jq` check under [Verify](../README.md#verify).

**AI agents handling an upgrade:** complete all three steps in sequence. After step 3, confirm no `token_goat` entries remain in `settings.json` before reporting the upgrade done.

## What gets installed?

`token-goat install` writes the following on your machine — nothing else, anywhere. Every entry is reversed by `token-goat uninstall`. Integrations for other harnesses are additive on the way out as well as in, so a plain uninstall does not touch one you installed with `--codex`, `--copilot`, or a sibling flag: rather than undo something you did not ask about, it names each one still present and the flag that removes it. Run `token-goat doctor` at any time to see which of these are currently present.

**Claude Code integration** (`~/.claude/`)

| Path | What |
|------|------|
| `~/.claude/settings.json` | Hook entries for `SessionStart`, `PreToolUse` (Read/Grep/Bash, Drive/WebFetch), `PostToolUse` (Edit/Write/MultiEdit, Read/Grep/Glob, Bash, WebFetch, Skill), and `PreCompact`. Hook entries only: install writes nothing under `permissions`, so it never grants the agent unprompted execution of anything. Existing hooks are preserved; a timestamped `.bak` is written before any change.<br><br>The `PreToolUse` and `PostToolUse` matchers are narrowed to exactly the tools token-goat handles (plus `^mcp__`), generated from the live hook registry rather than a fixed list, so they can't fall out of date as handlers change. Claude Code starts a new process per matcher hit and most of that cost is process startup, so a catch-all matcher would make every unrelated tool call — `TodoWrite`, `TaskUpdate`, and friends — pay for a hook that has nothing to do. |
| `~/.claude/hooks/token-goat-shim.js` | The hook script those `settings.json` commands invoke (`"<node>" "<shim>" <event> "<entry>"`). It imports the hook library in-process instead of spawning a second process, and naming the node binary directly skips the npm bin wrapper — on Windows a `cmd.exe` layer every hook would otherwise pay for. Measured 480 ms → 324 ms per hook call. Regenerated on every `install` run. Always written here even for a `--project` install, since the command bakes in machine-specific absolute paths; a project-scope `settings.json` just points at this one. |
| `~/.claude/CLAUDE.md` | A delimited block (`<!-- token-goat-begin -->` … `<!-- token-goat-end -->`) telling the agent to prefer `token-goat read` / `symbol` / `section` over `Read` / `Grep`. Any existing content is preserved. |
| `~/.claude/skills/token-goat/SKILL.md` | The token-goat skill — the same routing guidance in skill form. |

**Background worker.** token-goat does not register any persistent OS-level autostart entry — no Windows registry `Run` key, no systemd user unit, no XDG `.desktop` entry, and no macOS launchd `.plist`. The worker that drains the reindex queue is started manually as a detached child process: `token-goat worker start` launches `node <npm-prefix>/lib/node_modules/token-goat/dist/token-goat.mjs --worker-daemon` and returns immediately, and the child keeps running independent of the parent shell. `token-goat worker status` reports whether it's running; `token-goat worker stop` kills it. If it crashes or is killed while the machine stays up, the next edit hook detects it's gone and respawns it automatically (checked on every edit, rate-limited to roughly once every 5 minutes). It does not survive a reboot or logout, though — re-run `token-goat worker start` after either.

There is no auto-update mechanism. Updating token-goat is always a manual `npm install -g token-goat@latest`.

**Data directory** (created on first run)

| Platform | Path |
|---------|------|
| Windows | `%LOCALAPPDATA%\dfk-helper\token-goat\` |
| Linux / WSL | `~/.local/share/token-goat/` |
| macOS | `~/Library/Application Support/dfk-helper/token-goat/` |

Contains the symbol index (`global.db`, per-project `.db` files), session cache, shrunken-image cache, cached skill bodies (5 MB cap, LRU-evicted), logs, locks, and the dirty-file queue. Nothing outside this directory and `~/.claude/` is written.

**What the index actually holds, in plain terms.** The point of a surgical read is returning a function body without the file around it, which means the database stores those bodies. `symbols.body` holds the source text of every indexed symbol, `symbols.docstring` its doc comment, `refs.context` the line around each reference, and `chunks.text` the passages that semantic search embeds. There is also a full-text index over the bodies and docstrings. So the database is not a list of names and line numbers: it is a substantial copy of your source, sitting in a plain unencrypted SQLite file outside the repository, at the path in the table above.

Three things follow, and they are worth knowing before you decide. It never leaves the machine: token-goat sends no telemetry of any kind, and the only outbound requests it makes at all are the ones listed in the security section, none of which carry index content. It is not protected by your repository's access controls any more, so anything on the machine that can read your home directory can read it, and on Linux and macOS that directory sits under a home that backup and sync tools routinely copy. And it outlives an uninstall unless you say otherwise: `token-goat uninstall --purge` deletes both roots and tells you how much it reclaimed.

**With `--codex`** (Codex CLI integration)

| Path | What |
|------|------|
| `~/.codex/config.toml` | Hooks block with Codex-specific matchers (`view_image|Bash`, `apply_patch`, `web_search`) plus `PreCompact`/`UserPromptSubmit`/`SubagentStop` global hooks. Existing hooks preserved. |
| `~/.codex/AGENTS.md` | A delimited block (`<!-- token-goat-codex-begin -->` … `<!-- token-goat-codex-end -->`) with the same routing guidance, adapted for Codex tool names. |
| `~/.codex/hooks/token-goat-shim.js` | The hook script `config.toml`'s hook commands invoke (`node "<path>" <event>`). Strips internal `_tg_*` keys and injects `hookSpecificOutput.hookEventName` to satisfy Codex's strict schemas. Regenerated on every `install --codex` run. |

**With `--gemini`** (Gemini CLI integration)

| Path | What |
|------|------|
| `~/.gemini/settings.json` | Hook entries under Gemini's `BeforeTool`, `AfterTool`, and `PreCompress` events, using Gemini's own snake_case tool-name matchers (`run_shell_command`, `read_file`, `grep_search`, etc.). Existing hooks preserved; a timestamped `.bak` is written before any change. |

**With `--qwen`** (Qwen Code integration)

| Path | What |
|------|------|
| `~/.qwen/settings.json` | Hook entries under Qwen Code's `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, and `SubagentStop` events (Claude-Code-native names and payload shape, not Gemini's), using a catch-all matcher per event. Existing hooks preserved; a timestamped `.bak` is written before any change. |

**With `--kimi`** (Kimi Code integration)

| Path | What |
|------|------|
| `~/.kimi-code/config.toml` | `[[hooks]]` entries for Kimi Code's `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, `SubagentStop`, and `SessionStart` events. Each entry carries only `event` and `command`, the keys Kimi Code's strict schema accepts. Existing hooks and other config keys preserved; a timestamped `.bak` is written before any change. |
| `~/.kimi-code/hooks/token-goat-shim.js` | The hook script those commands invoke. Rewrites a token-goat block into `hookSpecificOutput.permissionDecision` and a hint into a top-level `message`, and writes empty stdout for a no-op. Regenerated on every `install --kimi` run. |
| `~/.kimi-code/AGENTS.md` | A delimited block (`<!-- token-goat-kimi-begin -->` ... `<!-- token-goat-kimi-end -->`) with the routing guidance, adapted for Kimi Code tool names. |
| `~/.kimi-code/skills/token-goat/SKILL.md` | The same guidance as a Kimi Code skill. |

**With `--opencode`** (opencode plugin)

| Path | What |
|------|------|
| `~/.config/opencode/plugins/token-goat.ts` (Linux/macOS) or `%APPDATA%\opencode\plugins\token-goat.ts` (Windows) | TypeScript bridge plugin. Fires on `tool.execute.before`, `tool.execute.after`, and `experimental.session.compacting`. Covers image shrinking, post-edit indexing, and compact assist. |

**With `--pi`** (pi extension)

| Path | What |
|------|------|
| `~/.pi/agent/extensions/token-goat.ts` | TypeScript extension (default-exported `ExtensionAPI` factory). Subscribes to `session_start`, `tool_call`, `tool_result`, `session_before_compact`, and `session_compact`. Covers bash compression, re-read denial, pressure-scaled surgical-read redirects for oversized first reads, image shrinking, post-edit indexing, output caching, and the compaction manifest. A project-local install writes `<project>/.pi/extensions/token-goat.ts` instead. |

**With `--copilot`** (Copilot CLI hook bridge)

| Path | What |
|------|------|
| `~/.copilot/hooks/token-goat.json` | Hook config (`{ version, hooks }`) registering `preToolUse`, `postToolUse`, `preCompact`, `agentStop`, and `subagentStop`, each pointing at the shim script below. Existing files elsewhere in the hooks directory are untouched. |
| `~/.copilot/hooks/token-goat-shim.js` | The shim `token-goat.json`'s hook commands invoke (`node "<path>"`). Translates Copilot's event names and response schema (`permissionDecision`/`modifiedArgs`, `additionalContext`) to/from token-goat's internal hook protocol. Regenerated on every `install --copilot` run. A project-local install (`--copilot --local`) writes `<project>/.github/hooks/token-goat.json` and `<project>/.github/hooks/token-goat-shim.js` instead. |
| `~/.copilot/copilot-instructions.md` | A delimited block (`<!-- token-goat-begin -->` … `<!-- token-goat-end -->`) with the same routing gate written to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, naming Copilot CLI's own `view`/`grep`/`glob` tools in the conflict-resolution clause. Merged idempotently — everything outside the markers is preserved byte-for-byte. A project-local install (`--copilot --local`) writes `<project>/.github/copilot-instructions.md` instead. |

**With `--grok`** (Grok CLI / xAI Grok Build hook bridge)

| Path | What |
|------|------|
| `~/.grok/hooks/token-goat.json` | Hook config (`{ hooks }`) registering `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, and `SubagentStop` with an empty (match-everything) matcher, each pointing at the shim script below. Existing files elsewhere in the hooks directory are untouched; global scope only (Grok's project-scoped `.grok/hooks/` requires a separate manual `/hooks-trust` grant). |
| `~/.grok/hooks/token-goat-shim.js` | The shim `token-goat.json`'s hook commands invoke. Translates `PreToolUse`'s deny shape only (`{"decision":"block",...}` → Grok's documented `{"decision":"deny",...}`, plus exit code 2); every other event's response is forwarded unmodified. Regenerated on every `install --grok` run. |

**With `--vscode`** (VS Code MCP configuration; user scope by default, `-p`/`--project` for the workspace)

| Path | What |
|------|------|
| `%APPDATA%\Code\User\mcp.json` (Windows) / `~/Library/Application Support/Code/User/mcp.json` (macOS) / `~/.config/Code/User/mcp.json` (Linux) — or `<project>/.vscode/mcp.json` with `-p`/`--project` | Merges the `token-goat` stdio entry under VS Code's `servers` root key, preserving unrelated servers and settings. Refuses to write if the other scope already has a token-goat-managed entry, to avoid a duplicate registration. |
| `<project>/.github/copilot-instructions.md` | Adds a delimited VS Code routing block that documents supported MCP selection and explicitly says MCP does not intercept built-in file reads. |

**With `--hermes`** (Hermes Agent integration)

| Path | What |
|------|------|
| `~/.claude/settings.json` | No new entries beyond the base Claude Code install. Hermes delegates tasks to Claude Code via `claude -p '<task>'`, which loads hooks from this file normally. `token-goat install --hermes` verifies the hooks are present and reports the result. To remove the Hermes detection: `token-goat uninstall --hermes` (removes no files — Hermes shares the Claude Code hook entries). |

**With `--openclaw`** (OpenClaw plugin)

| Path | What |
|------|------|
| `~/.openclaw/plugins/token-goat.ts` | TypeScript bridge plugin (`definePluginEntry` registration). Subscribes to `session_start`, `session_end`, `before_tool_call`, `after_tool_call`, and `before_compaction`. Covers bash compression, re-read denial, pressure-scaled surgical-read redirects for oversized first reads, image shrinking, and post-edit indexing. Not validated against a live OpenClaw instance — see README's "openclaw users" section. |
| `~/.openclaw/openclaw.json` | Adds the plugin path to `plugins.load.paths` and an entry to `plugins.entries.token-goat`. Existing config preserved; a timestamped `.bak` is written before any change. |
