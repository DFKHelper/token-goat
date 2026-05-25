# Test-speed deferrals — 2026-05-24

Two test-speed items came up multiple times across improvement loops. Both are
now formally DEFERRED with measurements, so the next person can stop spending
iterations on them.

## test_compact.py file split — DEFERRED (negative EV)

**Premise:** split `tests/test_compact.py` (5,541 lines, 65 test classes) into
4-6 smaller files so pytest-xdist can parallelise per-file. Estimated 30-40%
speedup on the suite.

**Why the premise is wrong:** `pyproject.toml` configures xdist with
`--dist=loadscope`. The scheduler groups by `nodeid.rsplit("::", 1)[0]` — for
class-based tests, that's the class scope, not the file. So
`test_compact.py`'s 65 classes are already being parallel-distributed across
xdist workers.

**Measured (2026-05-24):**

| Configuration                                | test_compact.py time |
|----------------------------------------------|----------------------|
| `-n0` (no xdist)                             | ~14.87 s             |
| `-n auto --dist=loadfile`                    | 17.98 s              |
| `-n auto --dist=loadscope` (current default) |  4.35 s              |
| `-n auto --dist=load`                        |  4.31 s              |

`loadscope` is already at parity with the finest-grained `load` mode. There
is no remaining parallelism to extract from splitting.

**Marginal cost of the file to the full suite:**

| Configuration                  | Full suite |
|--------------------------------|------------|
| Full suite minus test_compact  | 48.64 s    |
| Full suite (with test_compact) | 51.09 s    |
| Marginal contribution          |  2.45 s    |

Even hypothetically eliminating the entire 2.45 s would beat measurement
variance by less than half. Realistic savings from a successful split: well
under 1 second. Cost: 5,541 lines of test churn across 65 classes with a
prior failed attempt on record. Net EV is strongly negative.

## test_read_replacement.py + test_embeddings.py fixture-scope flip — DEFERRED (broke isolation)

**Premise:** flip the project fixture in those test files from function scope
to module scope so the per-test setup cost is paid once. Estimated 1-3 s
saved.

**Why it doesn't work:** the tests mutate shared project state (DB rows, file
contents, embeddings cache). Module-scoped fixtures share that state across
tests. The prior attempt produced test-order-dependent failures because tests
that ran later observed mutations from tests that ran earlier in the same
module.

The right fix is either:

  - Make the tests not mutate state (large rewrite — out of scope), or
  - Accept the per-test setup cost as the correctness floor.

Function scope stays.

## What would actually help if test-suite wall time is the real goal

In descending order of EV:

1. Install `hypothesis` as a dev dep so `tests/test_parser_malformed.py`
   stops emitting collection errors and triggering rerunfailures overhead.
2. Profile the full suite to find which integration tests dominate the
   48.64 s baseline (likely tests using `make_git_repo` to spin up real
   repos). Splitting *those* — or making them faster — has real leverage.
3. Audit `--reruns 1` masked flakes — each rerun is a full test setup +
   teardown cycle on a test that already failed once.
