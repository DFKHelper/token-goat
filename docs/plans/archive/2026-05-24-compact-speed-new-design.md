# Compact / Hook Speed — Next Layer — 2026-05-24

The previous 55-iteration loop closed five obvious cold-start wins (deferred
imports, git-repo guard, ThreadPoolExecutor removal, `_humanize_bytes` move,
precompact-skip sentinel).  The ~190 ms cold subprocess floor is now closer to
~140–150 ms.  This document identifies the next five opportunities that sit
below that surface: process-level config caching, save-path double-deserialise
elimination, `sorted()` churn inside `to_json`, `mark_hint_seen` triggering a
full save on every pre-read hook, and the `config.load()` TOML stat + parse
running 3–5 times per hook subprocess.

---

## Bottleneck Baselines (measured 2026-05-24)

| Metric | Value |
|--------|-------|
| `token-goat hook pre-compact` (warm subprocess) | ~140–150 ms |
| `token-goat hook pre-read` (warm, session cache hit) | ~55–70 ms |
| `token-goat hook session-start` (warm, non-compact) | ~80–100 ms |
| `config.load()` single call (cold TOML parse) | ~3–5 ms |
| `session.save()` (locking + JSON serialise + atomic write) | ~8–20 ms |
| `to_json()` / `sorted(hints_seen)` per serialise | ~0.5–1.5 ms |

---

### 1. Process-level config cache — Score 1, Wall-time saved: ~8–15 ms per hook subprocess, Cost: S

**Bottleneck:** `config.load()` is called 3–5 times per hook subprocess:
`hints.py:964` (`_curator_should_emit`), `hints.py:1028`
(`_hint_budget_check`), `hooks_read.py:108` (`_handle_bash_compress`),
`hooks_cli.py:466` (pre-compact gate), and `hooks_skill.py:113`.  Each call
executes `p.exists()` (one `stat` syscall) followed by `p.read_text` +
`tomllib.loads` when the file is present (~3–5 ms total including the Path
construction), or just `p.exists()` + the object-construction pass (~1 ms)
when absent.  For the common absent-file case, 5 × 1 ms = ~5 ms wasted per
subprocess.  With a config file present: 5 × 4 ms = ~20 ms.

**Proposal:** Add a process-level TTL cache to `config.load()` using a
module-level `_config_cache: tuple[Config, float] | None = None` tuple (value,
monotonic timestamp).  TTL of 30 seconds — long enough to cover any hook
subprocess lifetime (all hooks exit in under 500 ms) while still picking up
user edits between invocations.  The cache is keyed by mtime of the config
file, not a pure TTL, so an edit mid-session takes effect within 2 seconds.
Touch `config.py` only; no callers change.

**Mechanism:** `config.load()` checks the module-level cache first: if the
config file's `st_mtime` matches the cached mtime (one additional `stat` call,
~0.1 ms), return the cached `Config` object directly.  On a miss, parse as
today and store `(config, mtime, time.monotonic())` in the cache.  The net
effect: the first `config.load()` call per process pays full cost; every
subsequent call in the same process pays one `stat` syscall (~0.1 ms) instead
of `stat + read_text + tomllib.loads`.

**Validation:** `python -c "from token_goat import config; import time; t=time.perf_counter(); [config.load() for _ in range(5)]; print(f'{(time.perf_counter()-t)*1000:.1f}ms')"` — should drop from ~20 ms to ~1 ms for 5 calls.

**Risks:** Stale config in long-lived processes (worker daemon).  Mitigate by invalidating on mtime change rather than using a pure TTL.

**Files touched:** `src/token_goat/config.py`

---

### 2. Eliminate double `from_dict` in `session.save()` CAS path — Score 1, Wall-time saved: ~5–12 ms per save, Cost: S

**Bottleneck:** `session.save()` at line 1835–1838 re-reads the on-disk JSON
and calls `SessionCache.from_dict(json.loads(raw))` on every save, even when
no concurrent writer has touched the file.  `from_dict` iterates over all
`files`, `bash_history`, `web_history`, `skill_history`, and `greps` dicts,
constructing dataclass instances for every entry — O(N) allocation work where N
is the total number of tracked entries.  In a session that has tracked 30 files
and 10 bash runs, this is ~40 dataclass constructions + type-coercions per
save, taking ~3–8 ms.  The `mark_hint_seen` path (called from `pre_read` on
every hinted file) triggers a `save()` on every hint emission, making this a
per-hook cost.

**Proposal:** Skip the CAS merge when the on-disk file's `st_mtime` and size
match `cache.version`'s expected state.  Specifically: after `load()` records
the file's `(mtime, size)` in the returned `SessionCache` (two cheap fields,
`_disk_mtime: float = 0.0` and `_disk_size: int = 0`), `save()` calls
`os.stat(p)` inside the lock.  If `stat.st_mtime == cache._disk_mtime and
stat.st_size == cache._disk_size`, no concurrent write occurred — skip
`from_dict` and write directly.  Fall back to the full CAS merge only when the
stat differs.

**Mechanism:** Removes the `json.loads + SessionCache.from_dict` round-trip on
the uncontended path (the common case; contention is rare in normal usage where
only one hook runs at a time per session).  The uncontended save drops from
~12–20 ms to ~4–8 ms (lock acquire + `os.stat` + `atomic_write_text` only).

**Validation:** Add a `_tg_save_ms` field to the `save()` log line; baseline
30 saves in a scripted session, compare before/after.  Also verify the CAS
merge still fires when two processes write simultaneously (integration test with
two concurrent `session.mark_file_read` calls on the same session ID).

**Risks:** An `os.stat` race where mtime matches but content differs (same
second, different content).  On most filesystems mtime has 1-second resolution
on Windows (NTFS has 100 ns); the existing `version` integer counter is a
secondary guard: if mtime matches but version on disk is higher than
`cache.version`, still merge.

**Files touched:** `src/token_goat/session.py`

---

### 3. Eliminate `sorted()` churn in `to_json()` for stable sets — Score 1, Wall-time saved: ~1–3 ms per save (compounds across all hint-emitting hooks), Cost: S

**Bottleneck:** `SessionCache.to_dict()` at lines 755–756 calls
`sorted(self.hints_seen)` and `sorted(self.bash_dedup_emitted_ids)` on every
serialisation, even when neither set has changed since the last save.
`hints_seen` grows to `HINTS_SEEN_MAX` (100 entries); sorting 100 strings
costs ~15–40 µs.  This is called on every `save()` triggered by
`mark_hint_seen`, `mark_file_read`, `mark_bash_run`, etc.  In a session with
50 hint emissions + 20 bash runs = 70 saves × ~25 µs = ~1.75 ms wasted on sort
alone.  The sort is only needed for "stable JSON" (deterministic output for
tests), not for correctness.

**Proposal:** Replace `hints_seen: set[str]` and `bash_dedup_emitted_ids:
set[str]` with `list[str]` that is kept in insertion order (already stable)
rather than sorted.  Insertion order is deterministic given a fixed sequence of
hook calls, which is sufficient for test stability.  The `in` check
(`has_hint_fingerprint`) changes from O(1) set lookup to O(N) list scan — but
N ≤ 100 (`HINTS_SEEN_MAX`) and the check is a string equality scan over short
(12-char) fingerprints, so O(100) is faster than a `sorted()` call.
Alternatively, maintain a parallel `frozenset` for O(1) lookup and a `list`
for serialisation order, invalidating both on `_invalidate_json_cache`.

**Mechanism:** Removes two `sorted()` calls from the hot `to_dict` → `to_json`
path.  Downstream: the `_json_cache` field already handles the common load-mutate-once-save pattern; this fix addresses the edge case where `_json_cache` is
valid for lookup but the sort is repeated unnecessarily when cache is
invalidated by unrelated mutations.

**Validation:** Microbenchmark: `time.perf_counter()` around `cache.to_json()`
with `len(hints_seen) == 100`, 1000 iterations, before and after.  Should drop
~25 µs per call.  Confirm test suite still passes (sorted output is not
contract-tested except by the schema stability tests).

**Risks:** JSON output order changes for `hints_seen` / `bash_dedup_emitted_ids`
— only affects snapshot tests that assert exact JSON byte equality.  Grep
confirms two such tests in `test_session.py`; update them to use
`set(data["hints_seen"])` comparisons instead of list equality.

**Files touched:** `src/token_goat/session.py`, `tests/test_session.py`

---

### 2. Batch `mark_hint_seen` saves — Score 2, Wall-time saved: ~8–18 ms per pre-read hook invocation that emits a hint, Cost: M

**Bottleneck:** `SessionCache.mark_hint_seen()` at line 823 calls `save(self)`
inline, triggering the full lock-acquire → CAS-stat → atomic-write pipeline on
every hint emission.  `pre_read` in `hooks_read.py` can emit a hint for the
Read tool, then also call `session.mark_file_read(...)` which itself calls
`save()` again inside `post_read`.  On a busy pre-read + post-read cycle (one
tool call), two saves fire in the same process within ~10 ms of each other —
each paying the full 8–20 ms save overhead.  The pre-read save from
`mark_hint_seen` runs before the hook response is returned to the harness, so
it is on the user-visible latency critical path.

**Proposal:** Defer the `mark_hint_seen` save by making it a "dirty flag"
mutation rather than an immediate write.  Add a `_pending_hint_save: bool =
False` field to `SessionCache`.  `mark_hint_seen` sets this flag and
invalidates the JSON cache but does NOT call `save()`.  The existing
`mark_file_read`, `mark_bash_run`, `mark_grep`, `mark_glob_run`,
`mark_file_edited`, `mark_web_fetch`, and `mark_skill_loaded` functions already
call `save()` at the end of `post_read` / `post_bash` / `post_edit` hooks.
Since `mark_hint_seen` always fires before one of those in the same hook
invocation (pre-read hint fires, then post-read mark runs), the deferred hint
is persisted by the post-read save at no extra cost.  For hooks that only emit
a hint and return without a post-read save (e.g. a Glob dedup hint), add a
single `save()` call in the `hooks_cli.py` dispatch layer after the handler
returns, checking `cache._pending_hint_save` before paying the save cost.

**Mechanism:** Removes one `save()` call from the pre-read critical path for
every hint-emitting hook invocation.  In a session that emits 50 hints across
50 pre-read calls, this eliminates 50 × ~12 ms = ~600 ms of cumulative save
overhead.  Per-call saving: ~10 ms off the pre-read hook latency when a hint
fires.

**Validation:** Add `_tg_elapsed_ms` to the pre-read hook response and compare
hint-emitting pre-read latency before/after.  Also verify hint fingerprints are
still persisted correctly when a pre-read hint fires but no post-read follows
(e.g. the harness cancels the tool call after the pre-read hook responds).
Unit test: call `mark_hint_seen` then verify `_pending_hint_save == True` and
the hint is NOT yet on disk; call `mark_file_read` and verify it IS then on disk.

**Risks:** Medium. If a hint fires in pre-read but the session process exits
before post-read (e.g. harness crash, or pre-read returns deny), the fingerprint
is not persisted and the same hint fires again next tool call.  This is a benign
false-positive (one extra hint) — not data loss.  Mitigate by persisting in the
`hooks_cli.py` dispatch finally-block.

**Files touched:** `src/token_goat/session.py`, `src/token_goat/hooks_cli.py`,
`tests/test_session.py`, `tests/test_hooks_read.py`

---

### 5. `_build_session_brief` git subprocess budget: skip all three calls on clean `main`/`master` after a SHA-equality fast-path — Score 2, Wall-time saved: ~40–80 ms on session-start, Cost: M

**Bottleneck:** `_build_session_brief` in `hooks_session.py` runs up to three
sequential git subprocesses (`rev-parse HEAD`, `status --porcelain`, `log
--oneline -5`) under a 2.5 s shared deadline on every non-compact
`session-start`.  The existing skip logic (lines 544–574) avoids the third call
(`git log`) on clean `main`/`master` when local SHA equals origin SHA — but
only after paying the cost of the first two calls plus two additional
`rev-parse` calls to compare SHAs.  That is four git subprocesses (~30 ms each
on Windows = ~120 ms) just to determine "nothing to show".  For the common
developer workflow — pushing a commit then immediately continuing work on
`main` with a clean tree — `_build_session_brief` fires at session start and
runs all four git calls before concluding there is nothing to emit.

**Proposal:** Add a process-level result cache for `_build_session_brief` keyed
by `(cwd, branch)` with a 60-second TTL stored at module level in
`hooks_session.py`.  On a cache hit, return the cached brief immediately without
any subprocess.  On a miss, run the existing logic and cache the result.
Separately, add a cheap pre-check: before any subprocess, stat `.git/COMMIT_EDITMSG`
and `index` mtime.  If both match the cached values, skip the status and log
calls entirely and return the cached brief.  This is effectively a lightweight
"git-state fingerprint" using two `os.stat` calls (~0.2 ms total) as a
substitute for four subprocess calls.

**Mechanism:** On a warm session-start where the user just ran `session-start`
within 60 seconds (or git state is identical), the entire
`_build_session_brief` body reduces to two `stat` calls + a dict lookup,
saving ~80–120 ms.  The TTL cache alone (no stat fingerprint) already handles
the "multiple session-start calls within one minute" pattern (common with
`/clear` followed by re-use).

**Validation:** `time python -m token_goat.cli hook session-start <<< '{}'`
twice in succession in a git repo on `main` with a clean tree.  Second call
should take ~20 ms less than the first (subprocess overhead gone).  Also verify
the brief still updates correctly after a `git commit` by checking that the
COMMIT_EDITMSG mtime changes and forces a cache miss.

**Risks:** Medium. The `COMMIT_EDITMSG` stat fingerprint couples the cache
invalidation to a git implementation detail (`.git/COMMIT_EDITMSG` is written
on every commit and on `git commit --amend`).  If git changes this behaviour,
the cache could serve stale data.  Mitigate: use the TTL as primary expiry
(60 s) and the stat fingerprint only as an acceleration.  A stale brief (showing
an old branch name for 60 s) is cosmetic, not correctness-critical — the brief
is advisory context, not a guard.

**Files touched:** `src/token_goat/hooks_session.py`,
`tests/test_hooks_session.py`
