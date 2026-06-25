# Contributing

Dev environment notes specific to this repo. Most of the project conventions live in `CLAUDE.md`; this file collects the rough edges around the local toolchain.

## Setup

```bash
npm install
npm test                     # fast test suite
npm run typecheck            # type check
npm run lint                 # ESLint
```

## Lefthook (pre-commit / pre-push)

Lefthook wires lint + typecheck into `pre-commit` and the full test suite into `pre-push`. The suite is occasionally racy on Windows under heavy disk pressure; the gating fact is CI on `origin/main`, so when the pre-push hook hangs intermittently it is reasonable to push with `--no-verify`.

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
