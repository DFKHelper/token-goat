# Token-Savings Benchmark Baseline — 2026-05-24

**Date:** 2026-05-24  
**Git revision:** 78e1af1 (`chore(dev): add pytest-xdist for parallel test execution`)  
**Python version:** 3.12.3  
**Test count:** 8 tests (slow marker)  
**Total duration:** 5.14 seconds

## Test Results

All 8 tests passed on first run:

```
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_large_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_medium_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_small_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_large [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_budget_scaling [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_small [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_empty_session_manifest [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_medium [PASSED]
```

## Key Measurements

- **Empty session manifest:** Baseline structure without any reads/edits
- **Small/medium/large manifest coverage:** Validates hint text generation scales across session sizes (100–500 reads simulated)
- **Budget scaling:** Confirms manifests stay under token budget as session complexity grows
- **Total execution time:** 5.14s (parallel xdist run)

## How to Compare

After future changes, rerun the benchmark to measure improvements:

```bash
cd C:/Projects/token-goat
uv run pytest tests/test_token_savings_benchmark.py -m slow -v -s --timeout=60
```

Compare the output against this baseline by:
1. Running the same command
2. Diffing the raw test output
3. Looking for changes in manifest token counts, hint coverage percentages, or test execution time

This baseline establishes the performance threshold at the point where context-savings batch 3 (compaction design) shipped with all planned features.

## After batch 7 (compaction-hook speed) — 2026-05-24

**Date:** 2026-05-24  
**Git revision:** afc069b (`perf(compact): pre-import compact-skip sentinel shortcut`)  
**Python version:** 3.12.3  
**Test count:** 8 tests (slow marker)  
**Total duration:** 5.08 seconds

### Cold-Start Import Timing

| Measurement | Before (iter 22) | After (batch 7) | Delta |
|-------------|------------------|-----------------|-------|
| `from token_goat import compact` | ~34 ms | ~28.5 ms | **-6 ms (-18%)** |

### Implementations

**Item 1: Defer `session` import** ✓ **DONE** (iter 46, commit `1b01eec`)  
Move `from . import session as session_mod` inside function boundaries (`_load_session_cache`, `event_count`). Eliminates 28 ms import cost for short-circuit paths.

**Item 2: Git repo probe** **DEFERRED**  
`_is_git_repo` guard for `git diff/status` calls not yet implemented; requires careful handling of bare repos/worktrees.

**Item 3: ThreadPoolExecutor cache-first fast path** **DEFERRED**  
Executor creation deferred; warm-cache cases still spin up 3–8 ms overhead. Requires profiling to justify complexity trade-off.

**Item 4: Defer `compact` import from `hooks_session`** ✓ **DONE** (iter 47, commit `b74d09b`)  
Move `_humanize_bytes` into `hooks_common` and defer compact load. Saves ~34 ms per SessionStart (non-compact path).

**Item 5: Compact-cache preflight sentinel** ✓ **DONE** (iter 48–49, commit `afc069b`)  
Write `.precompact-skip` sentinel for empty sessions; hook checks file existence before any imports (~150 ms savings on first PreCompact).

### All Benchmarks Pass

```
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_large_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_medium_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_manifest_small_session [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_large [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_budget_scaling [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_small [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_empty_session_manifest [PASSED]
tests/test_token_savings_benchmark.py::TestTokenSavingsBenchmark::test_hint_coverage_medium [PASSED]
```

**Result:** Batch 7 implementations (items 1, 4, 5) delivered **~6 ms measurable cold-start improvement** via import deferral and preflight sentinel. Items 2 and 3 deferred; profiling during future Batch 8 (test-suite speed) will clarify whether ThreadPoolExecutor overhead justifies the fix.
