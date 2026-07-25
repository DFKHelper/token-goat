# Important Issues Audit — 2026-05-24

Five issues identified through code review of the post-55-iteration codebase that the optimization loop did not address. Severity definitions: P0 = data loss / silent corruption / security exploit; P1 = correctness bug or performance cliff with high blast radius; P2 = latent correctness gap with bounded impact.

---

### 1. `webfetch.py` — sidecar `shrunk_path` returned without path containment check — Severity: P0, Affected: `src/token_goat/webfetch.py`

**Issue:** `fetch_url()` (lines ~633-637) reads `shrunk_path` from an on-disk `.meta` sidecar JSON file and returns `Path(shrunk_pointer)` directly to the caller, which then passes the path to the model as the "shrunk image":

```python
if shrink_if_image and (shrunk_pointer := meta.get("shrunk_path")):
    shrunk_path = Path(shrunk_pointer)
    if shrunk_path.exists():
        return shrunk_path  # returned with no containment check
```

The `.meta` JSON is cached under `web_cache_dir()`, but the `shrunk_path` value inside it is an absolute path written at shrink time. If the sidecar is externally tampered (e.g., a malicious web server writes a crafted URL whose response caches a sidecar pointing to `C:\Users\<user>\.ssh\id_rsa` or a secrets file), `fetch_url()` will return the attacker-controlled path as the shrunk image, causing the agent to read and embed that file into the conversation with no warning.

**Why it matters:** The attack surface is any URL the model fetches. The sidecar lives in a world-readable cache directory. The returned path is directly rendered into the agent's context window. This is a path-traversal / secret-leakage vulnerability — the model reads whatever the sidecar points to.

**Proposed fix:** After resolving `shrunk_pointer` to a `Path`, assert containment before returning:

```python
allowed_roots = (image_cache_dir(), web_cache_dir())
if not any(str(shrunk_path).startswith(str(r)) for r in allowed_roots):
    logger.warning("webfetch: sidecar shrunk_path outside cache roots, ignoring: %s", shrunk_path)
    shrunk_path = None
```

Use `Path.is_relative_to()` (Python 3.9+) for robustness against symlink tricks, or resolve both paths first.

**Risk of fix:** Low. The check adds a few microseconds per cached fetch. Legitimate shrunk paths are always written into `image_cache_dir()` by `image_shrink.py`, so the guard never triggers on valid data.

**Files touched:** `src/token_goat/webfetch.py`, `tests/test_webfetch.py` (add tampered-sidecar test).

---

### 2. `image_shrink.py` — no PIL decompression bomb guard (`MAX_IMAGE_PIXELS` unset) — Severity: P1, Affected: `src/token_goat/image_shrink.py`

**Issue:** `shrink_image()` calls `Image.open(src_path)` (line ~409) with no `Image.MAX_IMAGE_PIXELS` override anywhere in the codebase. PIL's default limit is 178M pixels (about 13,369×13,369), but the `SIZE_THRESHOLD_BYTES = 100_000` gate only inspects *compressed* file size — a 90KB JPEG can decode to an 8000×6000 (192MB) bitmap. Images exceeding PIL's default limit raise `DecompressionBombError`, which is silently swallowed by the broad `except Exception` block (line ~499), returning `None` (fail-safe). However, images below PIL's default but above a sane working limit (e.g., 4000×4000 = 48MB) are decoded in full before the hook process can react, causing a spike in the hook process's RSS that can take hundreds of milliseconds to GC.

More critically: the `except Exception` catch means a legitimate `DecompressionBombWarning` (raised as an exception when `LOAD_TRUNCATED_IMAGES` is set) is silently discarded, and an image that genuinely causes OOM is never logged — the hook process dies without a useful trace.

**Why it matters:** The hook process runs inside Claude Code's execution loop. A 200MB unexpected allocation in the hook stalls all other hook events for that session. On a machine with tight memory (CI, constrained dev machine), it can OOM-kill the hook process, making image shrink silently unavailable for the rest of the session without any diagnostic.

**Proposed fix:** Add an explicit pixel cap before decoding, sized to a sensible working ceiling (e.g., 4000×4000 = 16M pixels at 4 bytes = 64MB):

```python
# Near the top of image_shrink.py module body
_MAX_PIXELS = int(os.getenv("TOKEN_GOAT_MAX_IMAGE_PIXELS", 16_000_000))
Image.MAX_IMAGE_PIXELS = _MAX_PIXELS
```

Alternatively, use `Image.open()` in "lazy" mode and check `img.size` before calling `.load()`, skipping oversized images with a logged warning rather than silently catching the error.

**Risk of fix:** Low. Setting `MAX_IMAGE_PIXELS` is the standard PIL guidance. Reducing it below PIL's default means some large images that currently crash silently will now be skipped with a log entry — strictly better behavior. Env-var override preserves flexibility.

**Files touched:** `src/token_goat/image_shrink.py`, `tests/test_image_shrink.py` (add oversized-image test).

---

### 3. `embeddings.py` — `_load_existing_chunk_hashes` full table scan on every embedding run — Severity: P1, Affected: `src/token_goat/embeddings.py`

**Issue:** `_load_existing_chunk_hashes(conn)` (lines ~602-614) executes:

```python
for row in conn.execute(
    "SELECT file_rel, start_line, end_line, content_sha256 FROM chunks"
):
    existing[(row["file_rel"], row["start_line"], row["end_line"])] = row["content_sha256"]
```

There is no WHERE clause. This loads the entire `chunks` table into a Python dict on every call to `index_project_embeddings()`, including incremental runs triggered by the 2-second dirty-queue poller when a single file changes. For a large project (2000 files × 50 chunks/file = 100K rows), the dict occupies ~30-50MB of Python objects and the full-table read takes measurable wall time before the actual reindex begins.

**Why it matters:** The dirty queue is designed for low-latency incremental updates (a few changed files). The full table scan forces every incremental run to pay the full-project cost, negating the incremental design. The worker's 2s polling loop means this scan fires dozens of times per minute during active editing sessions.

**Proposed fix:** Pass the set of changed `file_rel` values into `_load_existing_chunk_hashes` and scope the query:

```python
def _load_existing_chunk_hashes(conn, file_rels: list[str]) -> dict:
    placeholders = ",".join("?" * len(file_rels))
    rows = conn.execute(
        f"SELECT file_rel, start_line, end_line, content_sha256 FROM chunks WHERE file_rel IN ({placeholders})",
        file_rels,
    )
    ...
```

Call sites already know which files are dirty (the dirty queue entries). The bulk-index path can pass all `file_rels` for a full scan; the incremental path passes only the changed subset.

**Risk of fix:** Low-medium. Requires threading `file_rels` through call sites. The full-index path must pass all files explicitly rather than relying on the implicit "load everything" behavior. Needs a test that verifies the scoped query only fetches rows for the requested files.

**Files touched:** `src/token_goat/embeddings.py`, `src/token_goat/worker.py` (call site update), `tests/test_embeddings.py`.

---

### 4. `read_replacement.py` — LIKE suffix query without LIMIT materializes entire matching set — Severity: P1, Affected: `src/token_goat/read_replacement.py`

**Issue:** `_resolve_file_rel_db()` (line ~435) issues:

```python
cursor = conn.execute(
    "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\'",
    (f"%{escaped_suffix}",),
)
rows = cursor.fetchall()
```

with no LIMIT clause. When a caller passes a bare extension like `.py` or `.ts` as the suffix (e.g., when the user types `token-goat read "session.py::SomeClass"` and the resolver canonicalizes to a suffix query), SQLite materializes every matching file in memory. For a monorepo with 50K Python files, `cursor.fetchall()` returns a 50K-row result set. `_pick_best_match` then iterates all of them applying edit-distance scoring, which is O(n × m) where m is the suffix length.

**Why it matters:** `token-goat read` and `token-goat section` are supposed to be cheap surgical operations. A latent O(n) full-scan makes them pathologically slow for large repos — exactly the repos where surgical reads are most valuable. The first time a user runs `token-goat read` in a large monorepo they may see a multi-second hang, undermining confidence in the tool.

**Proposed fix:** Add `LIMIT 50` (or a configurable cap) to the LIKE query and short-circuit `_pick_best_match` once a near-exact match is found:

```python
cursor = conn.execute(
    "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT 50",
    (f"%{escaped_suffix}",),
)
```

Additionally, if `escaped_suffix` contains path separators (e.g., `hooks/session.py`), prefer an exact-suffix match (`WHERE rel_path = ?` against the canonical form) before falling back to the LIKE query.

**Risk of fix:** Low. The limit of 50 is generous — `_pick_best_match` uses edit distance, so having 51+ candidates with the same suffix extension is exceedingly rare in practice. Adding an exact-suffix fast path is a pure speedup with no correctness risk.

**Files touched:** `src/token_goat/read_replacement.py`, `tests/test_read_replacement.py`.

---

### 5. `session.py` — `_merge_session_caches` does not re-apply list caps after merge — Severity: P2, Affected: `src/token_goat/session.py`

**Issue:** `_merge_session_caches()` (lines ~307-317) appends entries from the local in-memory cache that are not present in the on-disk (remote) cache to produce the merged result. The merge logic reads:

```python
merged["greps"] = remote_greps + [e for e in local_greps if e not in remote_set]
merged["glob_history"] = remote_globs + [e for e in local_globs if e not in remote_set]
```

`GREPS_HISTORY_MAX = 75` and `GLOB_HISTORY_MAX = 20` are enforced only in `mark_grep()` and `mark_glob_run()` before writing. After a CAS merge (which fires whenever two concurrent hook processes both update the session in the same polling window), the merged lists can silently exceed their caps. In a busy session with many rapid Edit + Grep events, repeated CAS merges cause the lists to grow without bound, making subsequent session serialization and hint generation progressively slower.

**Why it matters:** The caps are not just advisory — hint generation iterates `greps` and `glob_history` to build the "already seen" set. Unbounded list growth makes hint generation O(n) per hook event. Over a long session with many CAS collisions, this compounds into noticeable latency. The caps also guard the session JSON file size (which is read on every pre-read hook invocation).

**Proposed fix:** Apply the caps to the merged lists before returning:

```python
merged["greps"] = (remote_greps + [e for e in local_greps if e not in remote_set])[-GREPS_HISTORY_MAX:]
merged["glob_history"] = (remote_globs + [e for e in local_globs if e not in remote_set])[-GLOB_HISTORY_MAX:]
```

Slicing from the tail (`[-N:]`) preserves the most recent entries, consistent with how `mark_grep` appends and then slices.

**Risk of fix:** Minimal. The cap semantics are already defined and documented. This aligns the merge path with the single-writer path. The only behavior change is that merges after high-concurrency bursts trim to the documented cap rather than silently growing past it.

**Files touched:** `src/token_goat/session.py`, `tests/test_session.py` (add CAS-merge-exceeds-cap test).
