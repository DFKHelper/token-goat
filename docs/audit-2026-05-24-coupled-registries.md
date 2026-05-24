# Coupled-registry audit — 2026-05-24

Catalog of places in the codebase where related state is split across N files that must stay in sync, with nothing enforcing it. The bug class: adding (or renaming) an entry in registry A silently leaves B/C/D stale; production breaks, often with no test failure.

Patterns are ranked by **risk** and **fix-now-vs-defer** so future iterations can pick them up in priority order.

---

## 1. Hook event registry — FIXED THIS ITERATION

**Files involved (5 tables):**
- `src/token_goat/install.py::_hooks_block()` — settings.json wire format for Claude Code (matcher pattern + timeout per event).
- `src/token_goat/install.py::_codex_hooks_block()` — Codex CLI config.toml wire format (subset of events, harness-specific matchers).
- `src/token_goat/hooks_cli.py::_HANDLER_LOOKUP` — event name → `(submodule, attr)` dispatcher map.
- `src/token_goat/hooks_cli.py::EVENTS` — event name → lazy-proxy callable.
- `src/token_goat/hooks_cli.py::__getattr__::event_map` — module-level attribute exports (for legacy `hooks_cli.session_start` lookups).
- `src/token_goat/cli.py::@hook_app.command(...)` — typer subcommands (one decorator per event).

**Risk:** SILENT BREAK. Settings.json fires the hook, typer returns "No such command" with exit 2, and for BLOCKING events (UserPromptSubmit, PostToolUse:Skill, SubagentStop) Claude Code aborts the user's operation. Two prior incidents:
- `e53d553` — `user-prompt-submit` + `subagent-stop` missing typer subcommands.
- `a71092b` — `post-skill` missing typer subcommand.

**Fix shipped:** `src/token_goat/hook_registry.py` is the single source of truth. `install._hooks_block`, `install._codex_hooks_block`, `hooks_cli._HANDLER_LOOKUP`, `hooks_cli.EVENTS`, and `hooks_cli.__getattr__` all derive from it. The `@hook_app.command` decorators stay hand-written (typer requires decorator-based registration), but a startup assertion in `cli.py` (after all decorators run, via `_assert_hook_registry_aligned()`) raises `ImportError` if any registry event lacks a registered typer subcommand — the package fails to import if drift exists. Tests strengthened in `tests/test_install.py` to verify `_HANDLER_LOOKUP`, `_codex_hooks_block`, and the lazy `__getattr__` event_map all stay aligned with the registry.

---

## 2. Bridge hook event tables (opencode + openclaw TS shims) — DEFER

**Files involved:**
- `src/token_goat/bridges.py::OPENCODE_PLUGIN_TS` — embedded TS source containing two tables: `TOOL_TO_TG` (harness tool → token-goat tool name) and `POST_HOOK` (token-goat tool → hook event name).
- `src/token_goat/bridges.py::OPENCLAW_PLUGIN_TS` — same two tables, duplicated.
- Both implicitly couple to hook event names declared in `hooks_cli._HANDLER_LOOKUP` (now `hook_registry`).

**Risk:** SILENT BREAK across harnesses. If we rename `post-bash` → `post-shell` in the registry, the bridge TS strings keep emitting the old name and the harness fires a hook that doesn't exist. Worse, the typo is invisible in Python tests because the TS strings are opaque to Python's type checker.

**Why defer:** The `POST_HOOK` table only references 5 events (post-read, post-bash, post-fetch, post-edit) plus pre-read/pre-fetch/pre-compact/session-start hard-coded into the function body. Each TS source is a string constant; templating it from the Python registry is doable (use `.format()`) but requires escaping the existing TS `${}` template literals.

**Suggested fix:** Add a registry test that scans the TS strings for `"hook", "<event-name>"` patterns and asserts each event exists in `hook_registry.all_events()`. Cheap regex check, no templating needed.

---

## 3. Language adapter registration — LOW RISK (already partially solved)

**Files involved:**
- `src/token_goat/parser.py::LANG_BY_EXT` — extension → language key.
- `src/token_goat/parser.py::LANG_BY_BASENAME` — basename → language key.
- `src/token_goat/parser.py::_EXTRACTOR_REGISTRY` — language key → lazy importer factory.
- `src/token_goat/languages/{lang}.py` — actual adapter module.
- `pyproject.toml::[[tool.mypy.overrides]]::token_goat.languages.*` — mypy override (wildcard, no per-language entry).
- `CLAUDE.md::"Adding a New Language"` — checklist.

**Risk:** LOUD BREAK. The mypy override uses `token_goat.languages.*` wildcard so new adapters are auto-covered. If a language key is in `LANG_BY_EXT` but missing from `_EXTRACTOR_REGISTRY`, `parser.py::_get_extractor` raises `KeyError` at indexing time — loud, not silent. The CLAUDE.md checklist is the only "registry" that drifts, and that has zero runtime impact.

**Why defer:** Risk is loud-fail (caught by integration tests indexing real files), not silent corruption. No customer impact from drift. A test that asserts `set(_EXTRACTOR_REGISTRY.keys()) >= set(LANG_BY_EXT.values()) | set(LANG_BY_BASENAME.values())` would close the gap entirely and cost ~5 lines.

**Suggested fix:** One-liner test in `tests/test_parser.py` (defer to next iteration).

---

## 4. Bash filter + bash_parser read-equivalent commands — LOW RISK

**Files involved:**
- `src/token_goat/bash_compress.py::FILTERS` (list of `Filter` subclasses with `name` attribute + `matches(argv)` method).
- `src/token_goat/bash_parser.py` — hard-coded `if cmd in (...)` branches for cat/head/tail/bat/etc.
- `src/token_goat/config.py` — opt-in per-filter enable/disable settings.

**Risk:** LOUD BREAK for filters (a new filter is just a class added to `FILTERS`; missing the list means it never runs — visible in tests). SILENT MISS for bash_parser (a new read-equivalent command not added is just unrecognized, agent falls through to running the raw command — degraded perf but correct behavior).

**Why defer:** No coupling between the two registries except by convention. They serve different layers: bash_compress wraps stdout/stderr for tool output, bash_parser detects file reads inside Bash. Adding a new filter doesn't require touching bash_parser, and vice versa.

**Suggested fix:** No fix needed. Document the layering in CLAUDE.md so future contributors don't assume coupling exists.

---

## 5. Image format handlers + Pillow codec probe — LOW RISK

**Files involved:**
- `src/token_goat/image_shrink.py::IMAGE_EXTENSIONS` (frozenset of recognized image suffixes).
- `src/token_goat/image_shrink.py::_DEFAULT_LOSSY_FORMAT` + `_ENV_IMAGE_FORMAT` (output format selection).
- `src/token_goat/install.py::probe_image_codecs()` — install-time check for webp/jpeg/zlib codec availability.

**Risk:** LOUD BREAK. `image_shrink.py` checks Pillow capabilities at runtime via `features.check()`; the probe just surfaces missing codecs as a friendly install message. No registry mismatch can cause silent corruption — worst case is a missing format never gets shrunk.

**Why defer:** Already well-isolated. Adding a new format (e.g., `.heic`) requires updating only `IMAGE_EXTENSIONS` + `probe_image_codecs()`. Both are clearly visible at the top of their modules.

**Suggested fix:** No fix needed.

---

## 6. Doctor checks ↔ install steps ↔ uninstall steps — MEDIUM RISK

**Files involved:**
- `src/token_goat/install.py::install_all` (the master install sequence).
- `src/token_goat/install.py::uninstall_all` (the reverse).
- `src/token_goat/install.py::check_status` (doctor + integration status).
- `src/token_goat/install.py::plan_install` + `verify_install` (dry-run preview + post-check).
- `src/token_goat/cli_doctor.py` — doctor command rendering.

**Risk:** SILENT DRIFT. Each integration step (CLAUDE.md, settings.json, codex, opencode, openclaw, image codecs, worker autostart, update cron, ...) needs:
1. An `install_*` function called from `install_all`.
2. An `unpatch_*` function called from `uninstall_all`.
3. A `_check_*` function called from `check_status`.
4. A `_PlanEntry` row in `plan_install` and `verify_install`.
5. A renderer in `cli_doctor`.

Forget any one of these (esp. uninstall) and the user is left with leftover state after `token-goat uninstall`. Forget the `_PlanEntry` and `--dry-run` lies about what install would do.

**Why defer:** The split is well-organized but un-enforced. Consolidating would require a `Step` dataclass with `install / uninstall / check / plan / verify` callbacks — a larger refactor (~200 lines) than fits in one iteration.

**Suggested fix:** Promote to its own iteration. Define `_INSTALL_STEPS: list[InstallStep]` where each step bundles all five lifecycle hooks. Drives all five top-level functions from one list.

---

## 7. Routing-table (CLAUDE.md / SKILL.md / AGENTS.md) — ALREADY CONSOLIDATED

**Files involved:**
- `src/token_goat/install.py::_ROUTING_ROWS` — single source of truth.
- Three renderers: `_claude_skill_routing_rows()`, `_codex_routing_rows()`, `_skill_routing_rows()` — derive from `_ROUTING_ROWS` plus per-target extras.

**Status:** Already done. This is the model pattern for the hook registry consolidation in this iteration.

---

## 8. Hook timeout values — INFORMATIONAL ONLY (now consolidated)

**Files involved (before this iteration):**
- `_hooks_block` — Claude Code timeouts (5000, 2000, 3000, 30000 ms variously).
- `_codex_hooks_block` — Codex timeouts (independently specified, mostly the same numbers).

**Risk:** Low. Mismatched timeouts between harnesses would mean different perf characteristics but no functional break.

**Status:** Now driven from `hook_registry.HookEvent.timeout_ms_claude` / `timeout_ms_codex` so the two stay in sync where intended (most events use the same value across harnesses).

---

## Summary

| # | Pattern | Files | Risk | Action |
|---|---------|-------|------|--------|
| 1 | Hook event registry | 5 tables across 3 files | SILENT BREAK | **FIXED** this iteration |
| 2 | Bridge TS event tables | bridges.py | SILENT BREAK | Defer — add regex test |
| 3 | Language adapter registration | parser.py + languages/ | LOUD | Defer — one-line test |
| 4 | Bash filter + parser | bash_compress + bash_parser | LOW | Document, no fix |
| 5 | Image format handlers | image_shrink + install | LOW | No fix needed |
| 6 | Doctor/install/uninstall | install.py | MEDIUM | Own iteration |
| 7 | Routing table | install.py | n/a | Already consolidated |
| 8 | Hook timeouts | install.py | LOW | **FIXED** as side effect of #1 |
