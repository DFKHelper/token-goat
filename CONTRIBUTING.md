# Contributing

Dev environment notes specific to this repo. Shared conventions for agents and contributors live in [`AGENTS.md`](AGENTS.md); this file collects the rough edges around the local toolchain.

## Setup

```bash
npm install
npm test                     # fast test suite
npm run typecheck            # type check
npm run lint                 # ESLint
```

## Lefthook (pre-commit / pre-push)

Lefthook wires three fast checks into `pre-commit` — lint, then typecheck, then `npm run test:guards` — and the full test suite into `pre-push`.

`lefthook` is a devDependency and `npm install` runs `prepare` → `lefthook install`, so a fresh clone gets the hooks automatically. If `.git/hooks/pre-commit` is missing, run `npx lefthook install` — the guards below only protect you if the hook actually exists.

The pre-commit guards (`tests/guards/`) are pure-introspection invariants with no I/O: no bundle build, no SQLite DB, no git fixtures. They run in ~2s and exist to catch the *implemented-but-unregistered / unfunctional command* class before a commit lands, rather than discovering it later at push or in CI. Keep them fast — do not move the full suite, the built-bundle smoke tests, or the command matrix into pre-commit.

The heavy coverage stays on `pre-push` / CI: the full suite plus the built-bundle command matrix (`tests/command_matrix_e2e.test.ts`), which runs every registered command against the shipped `dist/token-goat.mjs`. The suite is occasionally racy on Windows under heavy disk pressure; the gating fact is CI on `origin/main`, so when the pre-push hook hangs intermittently it is reasonable to push with `--no-verify`.

### The index must never be allowed to grow unbounded

A second invariant now rides both tiers, because violating it took the tool down rather than degrading it: **stored index bytes must stay proportional to source bytes.** The JSON extractor once stored each top-level key's whole *source line* as its body; minified JSON puts every key on line 1, so a 1.5 MB file with 1142 keys stored 1.6 GB. `global.db` reached 2.9 GB, and reindexing that one file pushed enough bytes through the FTS delete triggers to hold SQLite's writer lock past db.ts's 15s `busy_timeout` — reaching users as `database is locked` and as multi-minute stalls during `token-goat index`.

The permanent defense is architectural, not per-language: every parsed symbol reaches the DB through exactly one `INSERT INTO symbols`, and that INSERT bounds the body at `MAX_SYMBOL_BODY_CHARS`. That makes an unbounded-body bug in *any* present or future extractor incapable of bloating the index. An over-cap body is stored **empty, not truncated** — `read_commands.ts`'s `resolveBody` re-slices an empty body from source over the symbol's line range, so the cap is lossless; a truncated body would be served as though complete.

- [tests/guards/symbol_body_bound.test.ts](tests/guards/symbol_body_bound.test.ts) (pre-commit) — asserts the choke point is still singular, still routed through `boundSymbolBody`, still elides rather than truncates, still capped below 1 MB, and that `resolveBody`'s empty-body fallback still exists.
- [tests/index_amplification_guard.test.ts](tests/index_amplification_guard.test.ts) (pre-push/CI) — drives pathological fixtures through the real pipeline and asserts stored bytes ≤ 4× file size. On the pre-fix parser it reports `1200.0x`.

If you add a language extractor, you do not need a new fixture — the choke point bounds you by construction. If you touch `writeParseResult`, `boundSymbolBody`, or `resolveBody`, assume you are touching this invariant.

## Git Bash / MSYS path mangling

Git Bash (the shell that ships with Git for Windows) rewrites POSIX-looking paths that start with `/` into Windows paths, so a call like `gh api /repos/DFKHelper/token-goat/...` becomes `gh api C:/Program Files/Git/repos/DFKHelper/...` and fails with `invalid API endpoint`. Two ways around it:

```bash
# Option A — omit the leading slash (works for gh):
gh api repos/DFKHelper/token-goat/actions/runs/<id>

# Option B — disable MSYS path conversion for the call:
MSYS_NO_PATHCONV=1 gh api /repos/DFKHelper/token-goat/actions/runs/<id>
```

The same trick applies to any tool that takes URL-style paths on the command line.

## Release flow

1. Bump `version` in `package.json` and run `npm install` to update `package-lock.json`.
2. Fold `[Unreleased]` CHANGELOG entries into the new `[X.Y.Z] - YYYY-MM-DD` heading.
3. Commit, push `main`, create the GitHub release (`gh release create vX.Y.Z`).
4. The release event triggers `.github/workflows/publish.yml` which runs `npm publish`.
5. Verify at `https://www.npmjs.com/package/token-goat`.
