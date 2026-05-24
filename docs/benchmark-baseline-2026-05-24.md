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
