# Session Mining Findings — 6b476e93

Source: nest-pilot session (Next.js/TS app) where token-goat ran as the globally-installed companion.
Mined by Opus agent on 2026-06-14. None of these overlap with `2026-06-13-opus-improvement-plan.md`.

## P1 — Invalid `symbol` CLI hint templates (correctness, user-facing)

Seven hint templates emit broken `token-goat symbol` invocations:
- `hints.py:1799` (read-N×-session hint): `` `token-goat symbol {safe_path}` `` — passes a file path as the symbol NAME → `No matches for '<path>'`
- `hints.py:4161,4171,4181,4191,4201,4213` (large-file hints for CSS/SQL/GraphQL/protobuf/env/Makefile): `` `token-goat symbol <name> "<path>"` `` — two-argument form, `symbol` takes one positional → hard usage error

Fix options: (a) rewrite templates to valid forms (`outline <path>`, `read "<path>::<name>"`, `section "<path>::<heading>"`); or (b) add optional file-scoping to `symbol` command. **Effort: S–M.**

## P1 — `reread_deny` blind to sub-agent edits → stale read denies (correctness)

`_handle_reread_deny` (`hooks_read.py:3420`) guards on in-session `last_edit_ts <= last_read_ts`. But `post_edit` keys edits on `session_id` (`hooks_edit.py:510`) and sub-agents run under a different session_id. Result: parent session denies re-reads of files changed by sub-agents, forcing the agent to edit via Bash to dodge the deny (observed at transcript line 2930).

Fix: In the freshness check, also compare current file `(mtime_ns, size)` or sha16 against what was recorded at read time; skip deny when they differ. Token-goat already computes `file_content_seen` fingerprints. **Effort: M.**

## P2 — Pre-read hook latency spikes to ~2s under multi-agent load (performance)

921 `_tg_elapsed_ms` samples: median 78 ms, p90 ≈ 1968 ms, p95 = 2000 ms, max 2047 ms. 130/921 (14%) exceeded 1s. Root cause: `db.py:295 with_timeout(fn, timeout_s=2.0)` sets `PRAGMA busy_timeout = 2000` — under Haiku swarm + build monitors all writing session/index DBs, contended pre-read hooks back off to the full 2s ceiling.

Fix: generate pre-read hints from a non-contending read-only path; return immediately on contended lock (don't wait 2s); defer session-cache write to async path off the read hot path. **Effort: M.**

## P2 — No tests assert hint-embedded commands are valid (test gap)

The P1 broken templates shipped because no test parses command strings that hints emit. Many `test_*hint*.py` files assert hint wording, not that the embedded `token-goat …` commands parse under the Typer CLI.

Fix: add a test that regex-extracts every `` `token-goat <subcmd> …` `` from `hints.py` templates and asserts each parses against registered Typer commands — correct subcommand + positional arity. This is the systemic gap behind P1; the `symbol`-hint fix must land with this test. **Effort: S–M.**

## P3 — `skeleton` on a directory returns misleading "File not found" (UX)

`token-goat skeleton "src/app/(dashboard)"` exits 1 with "File not found in any indexed project: ...". The path is a directory, not a missing file. (`cli.py:2138`)

Fix: detect when the argument resolves to a directory and list its indexed files or redirect to `token-goat map`/`outline`. **Effort: S.**

## P3 — Hint placeholder tokens that don't resolve (UX polish)

Several hints emit literal placeholders the agent can't act on: SQL hint suggests `section "<path>::CreateTable"` (actual table-name heading, not "CreateTable"); other hints emit `::SymbolName`/`::ClassName`/`.class-name`/`TypeName`.

Fix: where a top symbol/section for the file is cheaply available from the index, interpolate the real name; otherwise point at `outline`/`map`. **Effort: S–M.**

## Recommended implementation order

1. Fix invalid `symbol` hint templates + add hint-command-validity test (P1 + P2 test gap)
2. Make `reread_deny` mtime/sha-aware for sub-agent edit detection (P1)
3. Move pre-read hint generation off the 2s-contending DB write path (P2)
4. Fix `skeleton` directory error message (P3)
5. Fix hint placeholder tokens (P3)

Key files: `src/token_goat/hints.py` (lines 1799, 4161–4213), `src/token_goat/hooks_read.py` (`_handle_reread_deny` @3420), `src/token_goat/hooks_edit.py:510`, `src/token_goat/db.py:295`, `src/token_goat/cli.py:2138`
