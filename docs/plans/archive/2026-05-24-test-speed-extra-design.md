> **STATUS (2026-05-24):** All items pending; candidates for the next speed batch.

# Test-Suite Speed — Extra 5 (2026-05-24)

Context: the full suite currently runs in ~50 s under `pytest -n auto
--dist=loadscope`. Items 1 and 4 from `2026-05-23-speed-design.md` are
done; items 2, 3, 5 are deferred. The five items below are distinct
opportunities found by inspecting test structure, sleep calls, xdist
serialization, and fixture scope on 2026-05-24.

Baselines referenced:
- `test_compact.py`: 420 tests, 72 classes, 5,819 lines — the single
  largest file. `--dist=loadscope` serialises all 420 tests onto one
  worker.
- `time.sleep` calls: 12 in `test_compact.py`, 4 in `test_session.py`,
  4 in `test_worker.py`.
- `test_embeddings.py`, `test_read_replacement.py`, `test_index_pipeline.py`
  still use function-scoped `ts_project`/`py_project`/`md_project` fixtures
  (95 combined usages); `test_repomap.py` already shadows with module scope.

---

### 1. Split `test_compact.py` into domain sub-files — Score 1, Time saved: ~8–12 s local / ~10–15 s CI, Cost: M

**Bottleneck:** `test_compact.py` has 420 tests across 72 classes. With
`--dist=loadscope`, xdist assigns the *entire file* to one worker. On a
12-core box the other 11 workers sit idle while one grinds through 420
compact tests serially, capping parallel speedup at roughly 35× instead
of the theoretical max.

**Proposal:** Split `test_compact.py` into 3–4 focused sub-files by
domain: `test_compact_manifest.py` (manifest generation, budget,
trimming), `test_compact_git.py` (git diff/stat helpers, `TestGitDiffStat`,
`TestGetGitDiffStatSummary`, `TestGitDiffStatSummaryCache`,
`TestIsGitRepo`, `TestNonGitShortCircuit`), `test_compact_hook.py`
(`TestPreCompactHandler`, `TestDispatcherIntegration`,
`TestPreCompactHookFailSoft`), keeping `test_compact.py` for the
remaining core classes. Each sub-file becomes an independent xdist work
unit.

**Mechanism:** `--dist=loadscope` groups by module. Four smaller modules
spread across four workers in parallel instead of one worker taking all
420 tests. The git classes (~60 tests) are particularly expensive because
several set up per-test `_clear_caches` autouse fixtures; isolating them
lets the rest run concurrently.

**Validation:** `time uv run pytest -n auto tests/test_compact*.py` before
and after split; compare wall-clock. Also `pytest --collect-only
tests/test_compact*.py | grep "test session starts"` to confirm xdist
assigns to multiple workers.

**Risks:** Class moves can break imports of module-level helpers like
`_populate_session` and `make_git_repo`; move shared helpers to a
`compact_helpers.py` test utility or import from `conftest`. Rename churn
in git blame, but no coverage regression.

**Files touched:** `tests/test_compact.py`, new
`tests/test_compact_git.py`, `tests/test_compact_hook.py`,
`tests/test_compact_manifest.py`.

---

### 2. Replace `time.sleep()` ordering probes with explicit timestamp injection — Score 1, Time saved: ~0.8–1.2 s local / ~1.5–2 s CI, Cost: S

**Bottleneck:** `test_compact.py` has 12 `time.sleep()` calls and
`test_session.py` has 4, all used to guarantee timestamp ordering (e.g.,
`mark_file_read(older)` then `sleep(0.01)` then `mark_file_read(newer)`
so `last_read_ts` is strictly ordered). At 0.01–0.1 s each and with
`--dist=loadscope` serialising all test_compact tests onto one worker, the
accumulated sleep wall-time is ~350 ms per worker run of test_compact
alone. The 0.1 s call in `TestSymbolRecencyRanking` and the two 0.3 s
calls in `TestBuildManifestTimeout` contribute the most.

**Proposal:** Add a `_ts_counter` helper to the test module (a simple
`itertools.count(start=1_000_000_000.0, step=0.01)`) and monkeypatch
`time.time` inside the specific test methods that need ordering. Each call
to the monkeypatched `time.time()` advances the counter by 10 ms —
deterministic, zero-wait. The `TestBuildManifestTimeout` tests can keep
their `time.sleep(0.3)` inside the injected slow-git mock but shrink
`_MANIFEST_TIMEOUT_SECS` to `0.0` and use `time.sleep(0.001)` — enough
to exceed zero without 300 ms of real wall-clock.

**Mechanism:** Timestamps are stored as `time.time()` floats in
`session.py`. Monkeypatching `time.time` in the test gives fully
deterministic ordering without any real elapsed time.

**Validation:** `time uv run pytest tests/test_compact.py::TestSymbolRecencyRanking
tests/test_compact.py::TestKeyFilesRecencySort tests/test_compact.py::TestGrepSection
tests/test_session.py::TestListTouched tests/test_session.py::TestTimestampTracking -v`
before/after; wall-clock should drop by ~500 ms for this subset.

**Risks:** If `session.py` ever switches from `time.time` to
`datetime.now()` the monkeypatch target changes. Low risk — the pattern
is already used by other session tests (e.g., `make_session` backdates via
`cache.created_ts`). The `TestBuildManifestTimeout` tests must remain
sensitive to real wall-clock for the `timed out after X.Xs` assertion;
keep one real-sleep variant per class and convert the rest.

**Files touched:** `tests/test_compact.py`, `tests/test_session.py`.

---

### 3. Switch `test_embeddings.py` and `test_read_replacement.py` to the existing module-scoped fixtures — Score 1, Time saved: ~4–6 s local / ~6–8 s CI, Cost: S

**Bottleneck:** `conftest.py` already ships `ts_project_module`,
`py_project_module`, `md_project_module`, `ts_project_tuple_module` as
module-scoped indexed-project fixtures (added in iter 51). Only
`test_repomap.py` uses them. `test_embeddings.py` and
`test_read_replacement.py` still use the function-scoped `ts_project` and
`md_project` fixtures — paying `index_project(full=True)` on every one of
their combined ~95 function signatures. `test_read_replacement.py` even
defines a local `ts_project` fixture that aliases `ts_project_tuple`
(function-scoped) rather than `ts_project_tuple_module`.

**Proposal:** In `test_read_replacement.py`, change the local `ts_project`
and `py_project` aliases to use `ts_project_tuple_module` and
`py_project_tuple_module`. In `test_embeddings.py`, change `ts_project`
parameter references to `ts_project_module`. Audit each test in those
files for DB mutation (there is none — all tests are read-only symbol/
section/chunk queries) and confirm safety. `test_index_pipeline.py` is
deliberately excluded: it calls `index_project(full=True)` inside the
test body to validate write behavior and must stay function-scoped.

**Mechanism:** Module scope means `index_project` runs once per test
module rather than once per test function. `test_embeddings.py` alone has
~20 ts_project usages × ~0.35 s each = ~7 s saved at module scope.

**Validation:** `time uv run pytest -n auto tests/test_embeddings.py
tests/test_read_replacement.py` before and after; expect ~50% wall-clock
reduction for those two files.

**Risks:** Any test that mutates the indexed DB (writes a new file to the
project root, calls `write_text`, or re-runs `index_project`) would leak
state. Pre-migration audit: `rg "write_text|index_project|shutil.copy"
tests/test_embeddings.py tests/test_read_replacement.py` — current grep
shows zero mutations in embeddings, one in read_replacement
(`test_extract_chunks_empty_file` creates `empty.ts`). That one test
needs a fresh per-function fixture or a `tmp_path`-isolated copy.

**Files touched:** `tests/test_embeddings.py`,
`tests/test_read_replacement.py`.

---

### 4. Add `pytest-timeout` per-test cap to expose hidden slow tests — Score 2, Time saved: ~5–15 s CI (amortised), Cost: S

**Bottleneck:** `pytest-timeout` is already in `[dependency-groups]` dev
but no `timeout =` is configured in `[tool.pytest.ini_options]`. Without
a cap, a single hung test (polling loop, stuck subprocess, blocked
`Event.wait`) holds the entire xdist worker hostage. `test_worker.py`
runs `run_daemon` with a `threading.Thread` stopper sleeping 0.3 s; if
the stop event logic regresses, that test blocks for the full
`stop_event.wait(interval)` cycle (default 2 s) rather than failing fast.
`TestBuildManifestTimeout` uses `time.sleep(0.3)` inside a monkeypatched
git call — also a silent slow-path if the timeout patch is ever skipped.

**Proposal:** Add `timeout = 10` to `[tool.pytest.ini_options]` in
`pyproject.toml`. This caps every non-slow test at 10 s; a stuck test
fails with `TIMEOUT` instead of blocking the worker indefinitely. Tag the
two `test_worker.py::run_daemon` tests that intentionally run for ~0.3 s
with `@pytest.mark.timeout(2)` to give them a tighter individual budget.
The 7 existing `@pytest.mark.slow` tests already include real git ops and
may need `@pytest.mark.timeout(60)` to avoid false positives.

**Mechanism:** Faster failure on regressions means fewer "retry whole
suite" cycles (each ~50 s). The immediate per-run saving is zero on a
clean suite, but CI mean time to red is cut by up to 10 s per stuck test
avoided.

**Validation:** Inject a `time.sleep(15)` into one test, run the suite,
confirm `TIMEOUT` appears within 10 s. Then remove the sleep and confirm
clean pass.

**Risks:** A timeout of 10 s could be too tight on slow CI runners (GitHub
Actions Windows 2022 is occasionally 2–3× slower than local). Start at
`timeout = 30` if false positives appear; tighten after a week of CI
data. The `--reruns 1` already in `addopts` means a single timeout flake
gets one retry before failing — acceptable.

**Files touched:** `pyproject.toml`, `tests/test_worker.py`
(per-test timeout markers on the two daemon tests),
`tests/test_compact.py` (per-class timeout marker on
`TestBuildManifestTimeout`).

---

### 5. Lazy-import `tree_sitter_language_pack` in parser.py to cut worker cold-start — Score 2, Time saved: ~2–4 s local / ~4–6 s CI, Cost: M

**Bottleneck:** `parser.py` imports `tree_sitter_language_pack` at module
top-level. The language pack loads all grammar binaries into memory on
first import (~200–400 ms on Windows, ~80–150 ms on Linux). With
`--dist=loadscope` spinning up 12 xdist workers, each worker pays this
cost once when it first collects a test that imports `parser.py` directly
or indirectly (via `conftest.py`'s `from token_goat.parser import
index_project`). Because `conftest.py` is imported by every worker at
startup, all 12 workers pay the full language-pack load even if they only
run tests that never call `index_project`. On a 12-core box: 12 workers ×
~150 ms = ~1.8 s of pure import overhead at worker spin-up, before any
test runs.

**Proposal:** Move the `import tree_sitter_language_pack` call inside
`_get_language()` (or equivalent language-dispatch function in `parser.py`)
behind a module-level `_LANG_CACHE: dict = {}` guard. Workers that never
call `index_project` skip the language-pack load entirely. Workers that do
call it pay once and cache. Separately, move `from token_goat.parser
import index_project` in `conftest.py` inside the fixture bodies that need
it rather than at module top, so collection-only workers don't import
parser at all.

**Mechanism:** Language-pack load is deferred from import time to first
`index_project` call. Workers running pure unit tests (e.g.,
`test_session.py`, `test_compact.py`) never trigger it.

**Validation:** Add a `--import-mode=importlib` run with `time`; compare
`conftest.py` import time before/after. Also check: `python -c "import
time; t=time.perf_counter(); from token_goat import parser;
print(f'{(time.perf_counter()-t)*1000:.1f}ms')"` — should drop from
~200–400 ms to <10 ms.

**Risks:** Medium. Tree-sitter language binaries are not thread-safe
during initialisation on some platforms; if two workers both hit
`_get_language()` for the first time simultaneously the lazy init must be
guarded by a `threading.Lock`. The lock is cheap (taken only on first
call per language per process). Type annotations that reference
`tree_sitter_language_pack` types at module level need `TYPE_CHECKING`
guards. Any test that mocks `parser._get_language` must be audited.

**Files touched:** `src/token_goat/parser.py`, `tests/conftest.py`.

---

## Summary

| # | Title | Score | Local save | CI save | Cost |
|---|-------|-------|-----------|---------|------|
| 1 | Split test_compact.py | 1 | ~8–12 s | ~10–15 s | M |
| 2 | Replace sleep() with timestamp injection | 1 | ~0.8–1.2 s | ~1.5–2 s | S |
| 3 | Module-scope embeddings + read_replacement | 1 | ~4–6 s | ~6–8 s | S |
| 4 | Add pytest-timeout per-test cap | 2 | ~0 (one-time) | ~5–15 s amortised | S |
| 5 | Lazy-import tree_sitter_language_pack | 2 | ~2–4 s | ~4–6 s | M |

Combined upper-bound if all five land: **~16–24 s** off the ~50 s suite
locally, **~27–46 s** on CI (where xdist worker spin-up is slower). Items
2 and 3 are the highest-confidence quick wins (small, safe, measurable).
Item 1 is the highest-ceiling win but requires careful import auditing.
Items 4 and 5 are longer-tail investments that pay off across many future
runs rather than in a single suite execution.
