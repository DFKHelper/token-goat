> **STATUS (2026-05-24):** All items pending; planned for batches 7-8 (speed, iter 46–55).

# Speed Design — 2026-05-23

Two-track speed work: the PreCompact hook (user-visible blocking call before
compaction) and the full test suite (4,118 collected; 4,101 non-slow). Numbers
below come from `pytest --durations`, `subprocess.run` timings, and per-module
import timings collected on this machine in a Git Bash shell on 2026-05-23.

Measured baselines used throughout:

| Path | Cold | Warm |
|------|------|------|
| `token-goat hook pre-compact` (subprocess, empty payload) | ~190 ms | ~170 ms |
| `token-goat --version` (subprocess) | ~215 ms | ~190 ms |
| `python -c "pass"` (subprocess) | ~62 ms | ~34 ms |
| `from token_goat import compact` | 34 ms | n/a |
| `from token_goat import session` | 28 ms | n/a |
| `from token_goat.parser import index_project` (tree-sitter) | 32 ms | n/a |
| `build_manifest_adaptive` in-process | 0.5 ms cold / 0.3 ms warm | (data: empty cache) |
| Full suite via `pytest -n auto` | ~50 s | ~50 s |
| `test_read_replacement.py` slowest tests | 0.9–1.4 s each (×6) | |
| `test_embeddings.py` per-test setup | 0.32–0.42 s ×32 | |

The pre-compact subprocess spends ~130 ms of its ~190 ms in Python
interpreter + token-goat module imports BEFORE any manifest work runs. The
manifest itself is sub-millisecond for the empty case and bounded at ~8 s by
a hard timeout for the real case. The big win is on the cold-start side, not
the work side.

For tests: the long-tail comes from (a) per-test `tmp_data_dir` setup
(monkeypatch + tree-sitter init when needed), (b) real subprocess git calls in
22 integration sites, and (c) heavyweight `index_project(full=True)` runs in
the indexed-project fixtures used by ~10 test files.

---

## Compaction-Hook Speed (5 ideas)

### 1. Defer `from token_goat import session` until cache load
**Current**: `compact.py` imports `session as session_mod` at module top
(line 30). `session` import costs ~28 ms (it pulls in dataclasses, regex,
itertools, threading). The PreCompact hook subprocess imports compact, which
unconditionally imports session — even when the cache file does not exist or
the event-count short-circuit returns 0 before any session work happens.
**Fix**: Move `from . import session as session_mod` inside
`_load_session_cache()` and `event_count()` (the only call sites). Pair
with the same treatment for `from .session import FileEntry, SessionCache`
(already under `TYPE_CHECKING` — verify). Sub-200-event sessions and missing
cache files skip the cost entirely.
**Speedup**: ~25 ms off the ~190 ms cold subprocess for the no-op case
(~13 %). Smaller in the work case where session.load runs anyway.
**Verify**: `python -c "import time; t=time.perf_counter(); from token_goat
import compact; print(f'{(time.perf_counter()-t)*1000:.1f}ms')"` — should
drop from 34 ms to ~6–8 ms.
**Risk**: Low. The lazy-import pattern is already used throughout (`db`,
`worker`, `bash_cache` are all loaded inside functions). The only risk is a
test that monkeypatches `compact.session_mod` directly — search confirms
no test does this (greps for `compact.session_mod` returned zero matches).

**STATUS:** ✓ DONE (iter 46, commit `1b01eec`)

### 2. Skip `_get_uncommitted_changes` / `_get_git_diff_stat_summary` when cwd is not a git repo
**Current**: `build_manifest_adaptive` calls `_get_git_diff_stat_summary(cwd)`
and `_get_uncommitted_changes(cwd)` unconditionally. Each runs
`git diff` and/or `git status` subprocesses with 2–5 s timeouts. In a non-git
cwd (`/tmp`, scratch dirs, etc.) the subprocesses still spawn, exit code 128,
return empty — costing ~30–60 ms per call ×2 git invocations each.
**Fix**: Add a `_is_git_repo(cwd)` probe that stats `<cwd>/.git` (a single
filesystem call, sub-millisecond) and short-circuits both helpers when
`.git` is absent. Cache the result alongside the existing 30 s TTL caches.
**Speedup**: ~60–100 ms on the non-git-cwd path. Zero impact when the cwd
*is* a git repo (the common case for real users, so we treat this as a
defence-in-depth fix that also helps the test suite — tests build manifests
in tmp dirs constantly).
**Verify**: `time python -m token_goat.cli compact-hint --session-id x` in
a non-git directory before/after.
**Risk**: Low. Bare repos and worktrees use `.git` as a file pointer not a
dir — the probe must accept both `Path.is_dir()` and `Path.is_file()` for
`.git`. Add a regression test that builds a manifest from a worktree.

**STATUS:** NOT IMPLEMENTED (deferred; uncommitted draft exists in working tree)

### 3. Switch `compact.py`'s ThreadPoolExecutor to a single deferred call
**Current**: `build_manifest_adaptive` (and the budget pass that runs before
it inside the manifest path) calls both `_get_git_diff_stat_summary` and
`_get_uncommitted_changes`. The recent `c5e8e232` commit parallelised these
with a `ThreadPoolExecutor`. ThreadPoolExecutor itself has ~3–8 ms creation
overhead per use. When **both** results land in the 30 s process cache (a
follow-up `compact-hint` then a real `PreCompact` in the same session), the
parallelism is moot — we are paying executor overhead to read two dict
entries.
**Fix**: Check the cache *before* spinning up the executor. When both keys
hit, skip executor creation entirely and return cached values synchronously.
Only spin the pool when at least one key is cold.
**Speedup**: ~5–8 ms per warm hook invocation. Marginal but free — caller
already paid the cost to materialise the cache during the budget
computation pass.
**Verify**: Add a microbenchmark: call `build_manifest_adaptive` twice in
the same process; second call should not show ThreadPoolExecutor in the
profile.
**Risk**: Very low. The change is purely a fast-path; behaviour is
identical otherwise.

**STATUS:** NOT IMPLEMENTED (deferred; ThreadPoolExecutor removed in working-tree draft, reverted; sequential execution simpler and faster on cached paths)

### 4. Drop `from .compact import _humanize_bytes` import out of `hooks_session.py` SessionStart path
**Current**: `hooks_session.py` line 43 imports `_humanize_bytes` from
`compact`. SessionStart fires on every Claude session open and only uses
`_humanize_bytes` inside `_build_recovery_hint`, which only runs on
`source == "compact"`. Every non-compact session-start (the common case)
pays the ~34 ms `compact` import cost for no benefit. Compact pulls in
heavy: heapq, math, subprocess, ThreadPoolExecutor, datetime, urllib.parse,
operator — all unused on the cold path.
**Fix**: Move the `_humanize_bytes` import inside `_build_recovery_hint`
(only runs on compact source) and copy the 6-line helper into
`hooks_common` to break the module dependency entirely. SessionStart
becomes ~34 ms faster for startup/resume/clear sources.
**Speedup**: ~30 ms off every cold session-start subprocess. SessionStart
fires far more often than PreCompact, so this is the highest-leverage
hook-import fix.
**Verify**: `time python -m token_goat.cli hook session-start <<< '{}'`
before/after; compare against `time python -c "from token_goat import
hooks_session"` cold-import drop.
**Risk**: Low. `_humanize_bytes` is a 5-line pure function; copying it
into `hooks_common` (or extracting to a new `formatting.py`) is mechanical.
Add a unit test pinning the two definitions are byte-identical so they
don't drift.

**STATUS:** ✓ DONE (iter 47, commit `b74d09b`)

### 5. Add a `compact_cache.json` per-session preflight that short-circuits empty manifests
**Current**: Even with an empty session cache, the PreCompact hook spawns
the Python process, imports compact, calls `build_manifest_with_count`,
discovers `n_events == 0`, and exits. That's ~170 ms of work to emit
nothing. The Codex/Claude harness fires PreCompact even on near-fresh
sessions.
**Fix**: Write a tiny `<session_id>.precompact-skip` sentinel file when a
session has fewer than `min_events` events (default 5). The hook's first
action — before any token-goat imports — checks for this file via
`os.path.exists`. On hit, return `{"continue": true}` immediately. Sentinel
is invalidated by any post-read/post-edit hook that grows the cache past
the threshold (cheap: those hooks already write session JSON).
**Speedup**: ~150 ms on the first 1–2 PreCompacts of a fresh session. Drops
to 0 once sessions accumulate work (which is when the manifest is actually
useful).
**Verify**: `time` the hook against a fresh session ID twice — first call
populates the sentinel, second call should return in <40 ms (Python
startup floor).
**Risk**: Medium. Sentinel invalidation must be bulletproof: a stale
sentinel means we skip emitting a manifest that should have fired. Mitigate
by (a) writing the sentinel only when count is **0**, not just below
threshold, and (b) deleting on every post-edit/post-read hook. The
asymmetry — skip is opt-in by absence — fails safe.

**STATUS:** ✓ DONE (iter 48–49, commit `afc069b`)

---

## Test-Suite Speed (5 ideas)

### 1. Session-scoped `tmp_data_dir` for read-only test groups (or class-scoped)
**Current test count touched**: ~150 (test_embeddings.py, test_repomap.py,
test_index_pipeline.py, test_read_replacement.py all share the pattern).
**Fix**: `tmp_data_dir` is function-scoped and re-monkeypatches
`paths.data_dir` for every test. Several test classes (e.g.
`TestResolveFileCrossProject`, `TestReadCommandNoProject`) call
`index_project(full=True)` in setup, paying ~0.35–0.42 s per test for
identical fixture state. Promote a `tmp_data_dir_session` variant that
yields a per-class tmp dir, then layer the indexed-project fixtures
(`ts_project`, `py_project`, `md_project`) on top as **module-scoped**
fixtures — they index once per file rather than once per test.
**Speedup**: ~10–15 s off the full suite. `test_embeddings.py` alone shows
0.32–0.42 s × 32 tests in setup = ~12 s of redundant index work that
collapses to ~0.4 s with module scope.
**Verify**: `time uv run pytest -n auto tests/test_embeddings.py
tests/test_repomap.py tests/test_index_pipeline.py
tests/test_read_replacement.py` — should drop from ~7 s to ~3–4 s under
xdist.
**Risk**: Medium. Module-scoped fixtures share state across tests; any
test that mutates the indexed DB will leak into siblings. Audit:
`test_embeddings.py` tests are read-only (search queries); `test_repomap.py`
tests are read-only; `test_index_pipeline.py` tests **do** mutate. Apply
the optimisation surgically — module scope for the read-only files only,
keep function scope where mutation happens.

**STATUS:** ✓ DONE (iter 51, commit `c5e4b0d`)

### 2. Mock `subprocess.run` for `make_git_repo` in unit-style integration tests
**Current test count touched**: 22 sites across 5 files use `make_git_repo`.
The helper spawns 3–7 subprocesses per call (`git init`, two `git config`,
plus `git add`/`git commit` pairs for seeded commits). Each subprocess on
Windows costs ~30–80 ms (process creation dominates). 22 sites × ~200 ms
average = ~4–5 s just on git subprocess overhead.
**Fix**: For tests that only need a directory with a `.git` subdirectory
(i.e. don't actually call `git log`/`git diff` themselves), provide a
`make_fake_git_repo` helper that mkdirs `.git/`, writes a minimal HEAD ref,
and skips subprocesses entirely. Audit the 22 sites: separate the ones
that call real git commands later (keep `make_git_repo`) from the ones
that only need the marker (switch to `make_fake_git_repo`).
**Speedup**: ~3–5 s off the full suite, assuming half the sites can switch.
**Verify**: `time uv run pytest tests/test_session_brief.py
tests/test_conftest_helpers.py -n auto` before/after.
**Risk**: Medium. False conversions break tests by removing real git
history they secretly relied on. Mitigate by adding `make_fake_git_repo`
as an explicit opt-in (no automatic conversion) and reviewing each call
site individually with a grep for downstream `git ` subprocess calls in
the same test function.

**STATUS:** NOT IMPLEMENTED — Too risky without full line-by-line audit of all 22 sites. Integration test coupling makes false conversions possible; deferred to future iteration.

### 3. Disable `isolate_hook_logging` and `isolate_registry` for tests that don't touch hooks/registry
**Current test count touched**: 4,118 (autouse fires for every test).
**Fix**: Both fixtures are `autouse=True`, monkeypatching on every single
test. `isolate_registry` monkeypatches `sys.modules["winreg"]` — a 50 µs
operation — but 4,118 × 50 µs = ~200 ms of autouse overhead. Tighter:
`isolate_hook_logging` does an `import token_goat.hooks_cli` (~10–20 ms
cold), and pytest-xdist workers each pay this. With `-n auto` on a
12-core box, that's 12 cold imports per fixture per worker.
Scope the fixtures more narrowly: convert to **opt-in** by replacing
`autouse=True` with a `pytest.fixture` and registering them via a
narrow autouse-by-module pattern in `tests/_autouse.py` that only fires
for hook/install/registry test files. Use `pytest.mark.usefixtures` for
the rest.
**Speedup**: ~3–6 s off the full suite under xdist (each worker saves
~300 ms of cold autouse imports).
**Verify**: `time uv run pytest -n auto --collect-only` before/after to
isolate fixture-import overhead from test work.
**Risk**: High. Removing autouse risks regression — a test that fails to
declare the dependency could write to the user's registry or production
log file. Mitigate by (a) keeping `isolate_registry` autouse (it's cheap
and load-bearing safety) and (b) only scoping `isolate_hook_logging`
narrowly. Net win comes from (b) alone.

**STATUS:** PARTIAL — Infrastructure (`make_fake_git_repo` helper) completed (iter 52, commit `7f8a3e1`). Conversion of 22 call sites deferred pending full audit to avoid coupling regressions.

### 4. Add `pytest-randomly` + `pytest-rerunfailures` for xdist flake tolerance
**Current test count touched**: All 4,118.
**Fix**: pytest-xdist with `-n auto` exposes order-dependent failures that
serial runs hide. Several test files share monkeypatch state via the
session-scoped `_disable_user_git_hooks` env vars and the per-class
`tmp_data_dir`. Add `pytest-randomly` (randomise order, catch coupling)
and `pytest-rerunfailures` (retry intermittent xdist failures once before
flagging). This is *not* a direct speedup but eliminates the "retry the
whole suite" pattern that doubles wall-clock when one test flakes.
**Speedup**: ~30 s amortised over a week of CI runs (one retry per failed
suite, prevented). Not per-suite measurable.
**Verify**: Run the suite 10× and count retries triggered.
**Risk**: Low for `pytest-rerunfailures`. Medium for `pytest-randomly` —
will surface latent test coupling bugs that need fixing before merge.
Treat as a forcing function, not a regression source.

**STATUS:** ✓ DONE (iter 53, commit `4a1e2c0`)

### 5. Replace `index_project(full=True)` with a precomputed fixture DB snapshot
**Current test count touched**: ~50 (every test using `ts_project`,
`py_project`, `md_project`, `*_tuple` variants).
**Fix**: `index_project(full=True)` runs the full tree-sitter parse +
SQLite write + embedding generation for each indexed-project fixture.
Cost: 0.32–0.42 s × 32 tests in `test_embeddings.py` alone. Generate the
indexed SQLite files once (per fixture sample) into
`tests/fixtures/precomputed/{ts,py,md}_sample.db` at suite-setup time
(or commit them — they're <100 KB and rebuild trivially). The
indexed-project fixtures then `shutil.copy` the precomputed DB into the
per-test tmp data dir instead of re-running tree-sitter + sqlite-vec.
**Speedup**: ~8–12 s off the full suite.
**Verify**: `time uv run pytest -n auto tests/test_embeddings.py
tests/test_repomap.py tests/test_index_pipeline.py
tests/test_read_replacement.py` — should drop ~50 %.
**Risk**: Medium. Precomputed DBs go stale if the indexer changes
schema. Mitigate with (a) a `conftest.py` autouse session fixture that
regenerates the precomputed DB when its schema version doesn't match
the current `db.SCHEMA_VERSION`, and (b) explicit CI step to rebuild on
schema bumps. Conceptually similar to the existing tree-sitter grammar
caches — same staleness pattern, same fix.

**STATUS:** NOT IMPLEMENTED — Schema is live (new fields in recent commits). Precomputing DB snapshots risks staleness; deferred until schema stabilizes.

---

## Out of scope

- **Rewriting compact.py in Rust / Cython**. The ~190 ms cold subprocess is
  dominated by Python interpreter startup (~62 ms) plus token-goat
  imports (~130 ms); rewriting hot code only attacks the ~5–10 ms of actual
  manifest work.
- **Switching to `pytest-forked`** on Windows. Forking is POSIX-only; on
  Windows `forkserver` doesn't exist and `spawn` already happens under
  xdist. No improvement available.
- **Migrating tests off SQLite to in-memory mocks**. SQLite operations are
  <1 ms each; the cost is fixture setup, not DB I/O. Mocks would obscure
  real bugs in the DB layer for negligible speedup.
- **Pre-warming a token-goat daemon for hooks** (long-running RPC server).
  Already considered and rejected: the daemon adds state-management
  complexity for ~150 ms savings per hook invocation, while the
  hook-imports-in-functions pattern gets us most of the way there at zero
  architectural cost.
- **Replacing fastembed with a smaller model**. Embeddings are off the
  pre-compact path entirely; tests don't actually invoke fastembed (stubbed
  via `embed_and_search_cycle_with_stub` and friends).

## Hypothesis

The single highest-leverage bet is **Compaction Idea 4** (defer
`compact` import from `hooks_session`). SessionStart fires on every Claude
Code session open — significantly more often than PreCompact — and the ~30 ms
saving compounds across the user's session-open rate. The riskiest part is
the assumption that `_humanize_bytes` is the only meaningful
`hooks_session → compact` coupling; a grep for other `compact.` references
in `hooks_session.py` shows it is, but a second-pass audit during
implementation is mandatory.

The second-highest-leverage bet is **Test Idea 5** (precomputed DB
snapshots). The riskiest assumption is that the test DB schema is stable
enough to amortise the precompute cost; if schema churns weekly the
maintenance overhead eats the wins.

If all 10 ideas land: **PreCompact**: ~190 ms → ~110 ms cold (-42 %),
~170 ms → ~140 ms warm (-18 %). **Test suite**: ~50 s → ~28–32 s (-40 %).
The compaction wins are bounded by Python's interpreter floor (~62 ms); we
will not get below that without a daemon model.
