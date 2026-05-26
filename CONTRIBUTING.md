# Contributing

Dev environment notes specific to this repo. Most of the project conventions live in `CLAUDE.md`; this file collects the rough edges around the local toolchain.

## Setup

```powershell
uv sync --all-extras
uv run pytest -m "not slow"      # fast tier; matches CI gating step
uv run pytest                    # full suite (adds the slow tier)
uv run ruff check
uv run mypy src
```

## Lefthook (pre-commit / pre-push)

Lefthook wires lint + a focused WAL-growth regression test into `pre-commit`, and `mypy src` + the full suite into `pre-push`. The full suite is occasionally racy on Windows under heavy disk pressure (see the slow-tier split in `.github/workflows/ci.yml`); the gating fact is CI on `origin/main`, so when the pre-push hook hangs intermittently it is reasonable to push with `--no-verify`. The release flow does this by convention.

## Git Bash / MSYS path mangling

Git Bash (the shell that ships with Git for Windows) rewrites POSIX-looking paths that start with `/` into Windows paths, so a call like `gh api /repos/DFKHelper/token-goat/...` becomes `gh api C:/Program Files/Git/repos/DFKHelper/...` and fails with `invalid API endpoint`. Two ways around it:

```bash
# Option A — omit the leading slash (works for gh):
gh api repos/DFKHelper/token-goat/actions/runs/<id>

# Option B — disable MSYS path conversion for the call:
MSYS_NO_PATHCONV=1 gh api /repos/DFKHelper/token-goat/actions/runs/<id>
```

The same trick applies to any tool that takes URL-style paths on the command line.

## pytest-timeout × Windows stderr

The per-test timeout is 60 s (`pyproject.toml` — raised from 30 s on 2026-05-25 because the lock-loop tests in `test_session.py` trip 30 s under Windows runner load). When a Windows subprocess writes Windows-1252 bytes (most commonly the em dash `0x97`) to stderr and a test then trips the timeout, pytest-timeout 2.4.0's capture-decode path can crash on the invalid UTF-8 byte before it prints the timeout message. The combo is rare but masks the real failure when it fires.

Mitigation: `lefthook.yml` sets `PYTHONIOENCODING=utf-8:replace` on the pre-push test command so subprocesses spawned by tests inherit the same forgiving decoder. (We deliberately do **not** call `sys.stdout.reconfigure(...)` inside `tests/conftest.py` — it disturbs the execnet pipe that pytest-xdist uses to talk between controller and workers on Windows, surfacing as a `Windows fatal exception: access violation` mid-suite. The conftest fixture that previously did this is now guarded by an xdist-worker check + `contextlib.suppress`.)

If you still see a decode crash, run the suspect test directly with `-s` to bypass capture and identify the real failure.

## Release flow

See the release checklist captured in user memory (`project_release_checklist.md`). Summary:

1. Bump `pyproject.toml` and regenerate `uv.lock` (`uv lock`) in one commit.
2. Fold `[Unreleased]` CHANGELOG entries into the new `[X.Y.Z] - YYYY-MM-DD` heading.
3. Commit with `--no-verify` (lefthook precedent), push `main`, tag `vX.Y.Z`, push the tag.
4. `gh release create vX.Y.Z --notes-file …` triggers `.github/workflows/publish.yml` (OIDC publish).
5. Poll `https://pypi.org/pypi/token-goat/json` for the new version.
