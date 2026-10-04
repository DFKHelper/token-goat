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

Lefthook runs lint, the typechecks (source, tests, VS Code extension), `npm audit signatures`, the VS Code extension tests, a secrets scan and `npm run test:guards` on `pre-commit`, the commit-message checks on `commit-msg`, and the full test suite on `pre-push`. After a pull, merge or rebase, the `post-merge` and `post-rewrite` hooks run `scripts/post-merge.mjs`, which reinstalls dependencies when `package-lock.json` changed, rebuilds `dist/token-goat.mjs`, stops the resident hook servers, restarts the worker, refreshes the harness shims and instructions, and triggers a reindex, so a running agent never keeps using a bundle the checkout has replaced.

`lefthook` is a devDependency and `npm install` runs `prepare` → `lefthook install`, so a fresh clone gets the hooks automatically. If `.git/hooks/pre-commit` is missing, run `npx lefthook install` — the guards below only protect you if the hook actually exists.

The `commit-msg` hook checks the message itself. It refuses AI attribution trailers, any name on the confidential denylist, and a hard-wrapped body: write each paragraph and each list item on one line and let the viewer wrap it, because GitHub and `git log` show a message exactly as written. It also refuses a verification checklist ("Why didn't a test catch this?", "Mutation check:", "Dogfood:") in place of a description; what was tested belongs in the tests. `tests/commit_msg_style.test.ts` and `tests/commit_msg_hook_denylist.test.ts` run the real scripts.

The pre-commit guards (`tests/guards/`) are pure-introspection invariants with no I/O: no bundle build, no SQLite DB, no git fixtures. They run in ~2s and exist to catch the *implemented-but-unregistered / unfunctional command* class before a commit lands, rather than discovering it later at push or in CI. Keep them fast — do not move the full suite, the built-bundle smoke tests, or the command matrix into pre-commit.

The heavy coverage stays on `pre-push` / CI: the full suite plus the built-bundle command matrix (`tests/command_matrix_e2e.*.test.ts`), which runs every registered command against the shipped `dist/token-goat.mjs`. The suite is occasionally racy on Windows under heavy disk pressure; the gating fact is CI on `origin/main`, so when the pre-push hook hangs intermittently it is reasonable to push with `--no-verify`.

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

## Adoption numbers

`npm run adoption` prints npm downloads, GitHub stars and GitHub forks for each week since the repository was created, newest week first. It rebuilds the table from the public npm and GitHub APIs on every run and stores nothing. GitHub does not list stargazers without a token, so set `GH_TOKEN` (`GH_TOKEN=$(gh auth token) npm run adoption` works locally). `--json` prints the rows as data and `--since YYYY-MM-DD` starts later. The scheduled `adoption.yml` workflow puts the same table in its job summary every Monday. The script lives in the repository and does not ship in the npm package.

## Session mining for improvements

If you notice missed token savings, hook friction, or command errors during an AI coding session (Copilot CLI, Claude Code, Cursor, etc.), run the [Session Mining Prompt](docs/PROMPT_SESSION_MINING.md) on your session history to generate an actionable Maintainer Feedback Card before submitting a bug report or pull request.

