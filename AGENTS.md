# AGENTS.md

Guidance for AI agents and human contributors working in this repository. This file follows the tool-agnostic [AGENTS.md](https://agents.md) convention, so it is read by Claude Code, Codex, Cursor, Copilot, and any agent that honors it. For local toolchain rough edges and the release flow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

token-goat is a Claude Code / Codex CLI companion, written in TypeScript and bundled to `dist/token-goat.mjs`, that reduces token burn through three mechanisms: image shrinking, session-aware read hints, and surgical reads (CLI commands that extract one symbol or section instead of a whole file).

## Build, test, lint

```bash
npm install
npm test          # fast test suite
npm run typecheck # tsc --noEmit
npm run lint      # ESLint
```

Lefthook runs lint + typecheck on `pre-commit` and the full test suite on `pre-push`.

## The indexer and worker are the critical path — prioritize them

The indexer (`src/parser.ts`: parse, then write symbols/refs/sections, plus embeddings) and the worker that drives it (`src/worker.ts`: drain the dirty queue, reindex changed files) are the core of the product. Every surgical-read command — `symbol`, `read`, `skeleton`, `outline`, `semantic`, read-dedup — returns nothing if this pipeline is broken. Treat it as the **highest priority for tests, bug-fixing, and improvements**, above hooks, image-shrinking, formatting, and CLI ergonomics, when triaging or planning work.

Test it on the *real* wiring. A release once shipped with the worker draining the queue into a default **stub** callback, so nothing ever wrote to the `symbols` table and the parser was tree-shaken out of the built bundle — yet the suite was green, because every worker test injected its own callback (exercising the loop, never the production default path), the parser was only unit-tested in isolation, and nothing ran the built bundle. So any change touching the worker or indexer needs:

- an **end-to-end test on the real default path** (drain → index → `symbols` populated → a known symbol resolves), not a mock-callback test, and
- a **smoke test against the built `dist` bundle**, to catch code that gets tree-shaken out of the shipped artifact.

The failure mode to watch for is the **injected-seam trap**: a test always supplies the dependency that the shipping path omits, so the production default is never exercised and the suite stays green over a broken feature. It applies wherever behavior hides behind an injectable callback or a default parameter.
