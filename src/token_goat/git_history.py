"""Git history indexing and hint generation for pre-read context.

Indexes recent commit messages and their changed-file lists into the per-project
SQLite DB, then surfaces the most-relevant commits as a compact hint when the
agent reads a file that was recently changed.

Design decisions
================
* **Shallow index** — 200 most-recent commits only.  Beyond that the signal
  degrades (old commits are rarely relevant to current work) and indexing cost
  grows linearly.
* **Fail-soft** — every public function catches BaseException and returns an
  empty result rather than propagating.  Git may be absent, the repo may be
  shallow, or the project root may not be a git repo; none of these should
  interrupt a hook.
* **Async-safe** — indexing is triggered from session-start in a background
  daemon thread and never blocks the hook response.
* **Deduplication** — commits are keyed by the first 12 chars of their hash;
  re-indexing is idempotent (INSERT OR IGNORE).
* **Staleness guard** — ``git_history_meta`` records the last index timestamp
  so re-indexing is skipped for ``_REINDEX_STALENESS_SECS`` after the last run,
  regardless of the age of commits in the repo.

Schema (per-project DB)::

    CREATE TABLE IF NOT EXISTS git_commits (
        commit_short  TEXT PRIMARY KEY,   -- first 12 chars of hash
        summary       TEXT NOT NULL,      -- subject line
        author_ts     INTEGER NOT NULL,   -- Unix timestamp
        changed_files TEXT NOT NULL       -- JSON array of POSIX rel-paths
    );

    CREATE TABLE IF NOT EXISTS git_history_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"""
from __future__ import annotations

__all__ = [
    "blame_symbol",
    "build_hint",
    "find_commits_for_file",
    "get_changed_symbols",
    "get_changed_symbols_db",
    "index_project_history",
]

import contextlib
import json
import re
import sqlite3
import time
from pathlib import Path

from .util import get_logger
from .util import run_git_silent as _run_git

_LOG = get_logger("git_history")

# Number of recent commits to index.
_HISTORY_DEPTH: int = 200

# Maximum file-change records per commit stored in changed_files JSON.
_MAX_FILES_PER_COMMIT: int = 40

# How many related commits to surface in a hint.
_MAX_HINT_COMMITS: int = 3

# Maximum age of commits to include in the index.
_MAX_COMMIT_AGE_DAYS: int = 60

# Minimum commit summary length to index. Single-word commits ("wip", "fix")
# carry no useful signal.
_MIN_SUMMARY_LEN: int = 6

# Minimum elapsed seconds before re-indexing an already-indexed project.
# Tracks wall-clock time since the last successful index run (stored in
# git_history_meta), NOT the age of commits in the repo.
_REINDEX_STALENESS_SECS: int = 3_600  # 1 hour


def _parse_log(raw: str) -> list[dict[str, object]]:
    """Parse ``git log --format=%x00%H%x01%s%x01%at --name-only`` output.

    The null-byte separator between commits avoids ambiguity with newlines in
    commit messages.  Each record is a dict with:
        commit_short (str), summary (str), author_ts (int), changed_files (list[str])
    """
    commits: list[dict[str, object]] = []
    for block in raw.split("\x00"):
        block = block.strip()
        if not block:
            continue
        header, _, rest = block.partition("\n")
        parts = header.split("\x01")
        if len(parts) < 3:
            continue
        full_hash, summary, ts_str = parts[0], parts[1], parts[2]
        try:
            ts = int(ts_str.strip())
        except ValueError:
            ts = 0
        if not summary or len(summary) < _MIN_SUMMARY_LEN:
            continue
        changed = [
            ln.strip() for ln in rest.splitlines()
            if ln.strip() and not ln.startswith(" ")
        ][:_MAX_FILES_PER_COMMIT]
        commits.append({
            "commit_short": full_hash[:12],
            "summary": summary[:200],
            "author_ts": ts,
            "changed_files": changed,
        })
    return commits


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create git history tables if they don't exist."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS git_commits (
            commit_short  TEXT PRIMARY KEY,
            summary       TEXT NOT NULL,
            author_ts     INTEGER NOT NULL,
            changed_files TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS git_commits_ts ON git_commits(author_ts DESC);

        CREATE TABLE IF NOT EXISTS git_history_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    conn.commit()


def _needs_reindex(conn: sqlite3.Connection) -> bool:
    """Return True when the git history index is stale or absent.

    Staleness is measured against the last index *write time* stored in
    git_history_meta — not the age of the newest commit, which would cause
    false staleness on repos that haven't received new commits recently.
    """
    try:
        row = conn.execute(
            "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'"
        ).fetchone()
        if row is None:
            return True
        age = time.time() - float(row[0])
        return age > _REINDEX_STALENESS_SECS
    except Exception:
        return True


def index_project_history(project_root: Path, project_hash: str) -> int:
    """Index recent git history for *project_root* into the per-project DB.

    Returns the number of commits indexed (0 on any failure or skip).
    Safe to call from a background thread.
    """
    try:
        return _index_history_inner(project_root, project_hash)
    except Exception:
        _LOG.debug("git_history: index_project_history failed", exc_info=True)
        return 0


def _index_history_inner(project_root: Path, project_hash: str) -> int:
    from . import db, paths

    db_path = paths.project_db_path(project_hash)
    if not db_path.exists():
        _LOG.debug("git_history: project DB not found, skipping: %s", db_path)
        return 0

    with db.open_project(project_hash) as conn:
        _ensure_schema(conn)
        if not _needs_reindex(conn):
            _LOG.debug("git_history: index is fresh, skipping reindex")
            return 0

    raw = _run_git(
        [
            "log",
            f"--max-count={_HISTORY_DEPTH}",
            f"--after={_MAX_COMMIT_AGE_DAYS} days ago",
            "--no-merges",
            "--format=%x00%H%x01%s%x01%at",
            "--name-only",
            "--diff-filter=d",  # skip deleted-only commits
        ],
        cwd=project_root,
    )
    if not raw:
        _LOG.debug("git_history: git log returned nothing for %s", project_root)
        return 0

    commits = _parse_log(raw)
    if not commits:
        return 0

    with db.open_project(project_hash) as conn:
        _ensure_schema(conn)
        stored = 0
        # Wrap the whole batch in one transaction: connections open in autocommit mode (isolation_level=None), so without an explicit BEGIN each INSERT commits on its own — re-acquiring the writer lock and fsyncing once per row instead of once per batch.
        in_txn = False
        try:
            conn.execute("BEGIN")
            in_txn = True
        except sqlite3.OperationalError as exc:
            _LOG.debug("git_history: BEGIN skipped (%s); using autocommit", exc)
        n_errors = 0
        try:
            for commit in commits:
                try:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO git_commits"
                        "(commit_short, summary, author_ts, changed_files) "
                        "VALUES (?, ?, ?, ?)",
                        (
                            commit["commit_short"],
                            commit["summary"],
                            commit["author_ts"],
                            json.dumps(commit["changed_files"]),
                        ),
                    )
                    stored += cur.rowcount  # 1 for new insert, 0 for ignored duplicate
                except Exception as exc:
                    n_errors += 1
                    _LOG.debug(
                        "git_history: failed to store commit %s: %s",
                        commit["commit_short"], exc,
                    )
            # Stamp last_indexed_at when the index is up-to-date: either new commits
            # were stored, or all commits were already present (all-duplicates = already
            # fresh). Only skip the timestamp when every insert failed with an exception
            # (wholly-failed batch) so the next cycle retries instead of being suppressed
            # for _REINDEX_STALENESS_SECS.
            if stored > 0 or n_errors < len(commits):
                conn.execute(
                    "INSERT OR REPLACE INTO git_history_meta(key, value) "
                    "VALUES ('last_indexed_at', ?)",
                    (str(time.time()),),
                )
            if in_txn:
                with contextlib.suppress(sqlite3.OperationalError):
                    conn.execute("COMMIT")
        except Exception:
            if in_txn:
                with contextlib.suppress(sqlite3.OperationalError):
                    conn.execute("ROLLBACK")
            raise

    _LOG.info("git_history: indexed %d commits for project=%s", stored, project_hash[:8])
    return stored


def find_commits_for_file(
    project_hash: str,
    rel_path: str,
    *,
    limit: int = _MAX_HINT_COMMITS,
) -> list[dict[str, object]]:
    """Return recent commits that touched *rel_path*, ordered by recency.

    Falls back to an empty list on any failure, including when the index has
    not been built yet (FileNotFoundError from a missing project DB).
    """
    try:
        return _find_commits_inner(project_hash, rel_path, limit=limit)
    except FileNotFoundError:
        # Project DB not yet created — silently return empty.
        return []
    except Exception:
        _LOG.debug("git_history: find_commits_for_file failed", exc_info=True)
        return []


def _find_commits_inner(
    project_hash: str,
    rel_path: str,
    *,
    limit: int,
) -> list[dict[str, object]]:
    from . import db

    with db.open_project_readonly(project_hash) as conn:
        try:
            # json_each provides exact element matching — avoids the false
            # positives that LIKE-based substring search produces when one
            # path is a suffix of another (e.g. "foo.py" inside "bar/foo.py").
            rows = conn.execute(
                """
                SELECT DISTINCT c.commit_short, c.summary, c.author_ts
                FROM   git_commits c, json_each(c.changed_files) AS f
                WHERE  f.value = ?
                ORDER  BY c.author_ts DESC
                LIMIT  ?
                """,
                (rel_path, limit),
            ).fetchall()
        except Exception:
            return []

    return [
        {
            "commit_short": row[0],
            "summary": row[1],
            "author_ts": row[2],
        }
        for row in rows
    ]


def build_hint(project_hash: str, rel_path: str) -> str | None:
    """Build a compact git-history hint for *rel_path*.

    Returns None when there are no relevant commits or the index is absent.
    The hint is short (<80 tokens) and structured for easy scanning.
    """
    commits = find_commits_for_file(project_hash, rel_path, limit=_MAX_HINT_COMMITS)
    if not commits:
        return None

    now = time.time()
    lines = [f"git: {rel_path}"]
    for c in commits:
        age_days = int((now - float(str(c["author_ts"]))) / 86_400)
        age_str = f"{age_days}d" if age_days > 0 else "today"
        summary = str(c["summary"])[:72]
        short = str(c["commit_short"])[:8]
        lines.append(f"  {short} {summary} ({age_str})")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Changed symbols — diff-based symbol extraction
# ---------------------------------------------------------------------------

# Regex matching a unified-diff hunk header line:
#   @@ -old_start[,old_count] +new_start[,new_count] @@ [optional context]
_HUNK_RE = re.compile(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@ ?(.*)$")

# Extended regex that also captures the new-file start line and count.
# Groups: (new_start, new_count_or_none, context)
_HUNK_RANGE_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$")

# Regex matching a +++ b/<file> line (new-file side of a diff header).
_FILE_RE = re.compile(r"^\+\+\+ b/(.+)$")

# Leading language keywords to strip when extracting a bare symbol name.
_SYMBOL_STRIP_PREFIXES = (
    "async def ",
    "def ",
    "func ",
    "function ",
    "class ",
    "fn ",
    "pub fn ",
    "pub async fn ",
)


def _parse_symbol_from_hunk_context(context: str) -> str | None:
    """Extract a bare symbol name from the hunk context text (after the fourth @@).

    Returns None when the context is empty or produces only noise.
    """
    raw = context.strip()
    if not raw:
        return None
    # Drop parameter list and brace noise: "def foo(a, b):" → "def foo"
    name_part = raw.split("(")[0].split("{")[0].strip()
    # Strip leading language keywords.
    for kw in _SYMBOL_STRIP_PREFIXES:
        if name_part.startswith(kw):
            name_part = name_part[len(kw):]
            break
    # Strip trailing colon (Python class/def) and surrounding whitespace.
    name_part = name_part.strip().rstrip(":")
    return name_part or None


def get_changed_symbols(
    repo_root: str | Path,
    since_ref: str = "HEAD~5",
    limit: int = 50,
) -> list[dict[str, object]]:
    """Return symbols that changed between *since_ref* and HEAD.

    Runs ``git diff --unified=0 <since_ref>..HEAD -- "*.py"`` and parses
    each hunk header for the optional context text (the name git infers for
    the surrounding function or class).

    Returns a list of dicts, one per unique (file, symbol) pair::

        [
            {
                "file": "src/token_goat/hints.py",
                "symbol": "build_hint",
                "lines_added": 12,
                "lines_removed": 3,
            },
            ...
        ]

    *lines_added* and *lines_removed* are summed across all hunks that name
    the same symbol in the same file.  Results are ordered by (file, symbol).
    The list is capped at *limit* entries (default 50).

    Fail-soft: returns ``[]`` on git error, missing repo, invalid ref, or
    any other exception.  Never raises.
    """
    try:
        return _get_changed_symbols_inner(str(repo_root), since_ref, limit)
    except Exception:
        _LOG.debug("get_changed_symbols failed", exc_info=True)
        return []


def _get_changed_symbols_inner(
    repo_root: str,
    since_ref: str,
    limit: int,
) -> list[dict[str, object]]:
    raw = _run_git(
        ["diff", "--unified=0", f"{since_ref}..HEAD", "--", "*.py"],
        cwd=Path(repo_root),
        timeout=30,
    )
    if not raw:
        return []

    # Accumulate counts per (file, symbol) — use a list of keys to preserve
    # insertion order for stable output.
    counts: dict[tuple[str, str], dict[str, int]] = {}
    key_order: list[tuple[str, str]] = []

    current_file: str | None = None

    for line in raw.splitlines():
        m_file = _FILE_RE.match(line)
        if m_file:
            current_file = m_file.group(1)
            continue
        if current_file is None:
            continue
        m_hunk = _HUNK_RE.match(line)
        if not m_hunk:
            continue
        removed_str, added_str, context = m_hunk.group(1), m_hunk.group(2), m_hunk.group(3)
        # group(1) is None when the count is absent (meaning 1 line).
        lines_removed = int(removed_str) if removed_str is not None else 1
        lines_added = int(added_str) if added_str is not None else 1
        symbol = _parse_symbol_from_hunk_context(context)
        if not symbol:
            continue
        key = (current_file, symbol)
        if key not in counts:
            counts[key] = {"lines_added": 0, "lines_removed": 0}
            key_order.append(key)
        counts[key]["lines_added"] += lines_added
        counts[key]["lines_removed"] += lines_removed

    result: list[dict[str, object]] = []
    for key in key_order:
        if len(result) >= limit:
            break
        file_path, symbol = key
        result.append({
            "file": file_path,
            "symbol": symbol,
            "lines_added": counts[key]["lines_added"],
            "lines_removed": counts[key]["lines_removed"],
        })

    # Sort by file then symbol for stable, scannable output.
    result.sort(key=lambda r: (str(r["file"]), str(r["symbol"])))
    return result


def get_changed_symbols_db(
    repo_root: str | Path,
    since_ref: str = "HEAD~1",
    limit: int = 50,
) -> list[dict[str, object]]:
    """Return symbols changed between *since_ref* and HEAD, resolved via the DB index.

    Unlike :func:`get_changed_symbols` (which relies on git's hunk-context text),
    this function queries the tree-sitter symbol index for symbols whose line ranges
    overlap each changed hunk.  Results are grouped by file and typically more
    reliable for languages where git's hunk context is absent or imprecise.

    Returns a list of per-file dicts, one per changed file that has indexed symbols::

        [
            {
                "file": "src/token_goat/hints.py",
                "symbols": ["build_hint", "format_hint"],
                "symbol_count": 2,
            },
            ...
        ]

    *symbol_count* equals ``len(symbols)``.  Results are ordered by file path.
    The list is capped at *limit* file entries (not symbol entries).

    Fail-soft: returns ``[]`` on any error.  Never raises.
    """
    try:
        return _get_changed_symbols_db_inner(str(repo_root), since_ref, limit)
    except Exception:
        _LOG.debug("get_changed_symbols_db failed", exc_info=True)
        return []


def _get_changed_symbols_db_inner(
    repo_root: str,
    since_ref: str,
    limit: int,
) -> list[dict[str, object]]:
    """Inner implementation — may raise; caller catches."""
    from . import db as _db
    from .project import find_project

    raw = _run_git(
        ["diff", "--unified=0", f"{since_ref}..HEAD"],
        cwd=Path(repo_root),
        timeout=30,
    )
    if not raw:
        return []

    # Parse hunk headers to build: file -> list of (new_start, new_end) line ranges.
    # new_end is inclusive; a hunk with count 0 means a pure deletion (no new lines),
    # so we still record the insertion point as a 1-line range for overlap queries.
    file_ranges: dict[str, list[tuple[int, int]]] = {}
    current_file: str | None = None

    for line in raw.splitlines():
        m_file = _FILE_RE.match(line)
        if m_file:
            current_file = m_file.group(1)
            continue
        if current_file is None:
            continue
        m_hunk = _HUNK_RANGE_RE.match(line)
        if not m_hunk:
            continue
        new_start = int(m_hunk.group(1))
        new_count_str = m_hunk.group(2)
        # When count is absent, git means "1 line"; count "0" means pure deletion.
        new_count = 1 if new_count_str is None else int(new_count_str)
        # A hunk with new_count=0 is a pure deletion — use the surrounding line.
        new_end = max(new_start, new_start + new_count - 1)
        if current_file not in file_ranges:
            file_ranges[current_file] = []
        file_ranges[current_file].append((new_start, new_end))

    if not file_ranges:
        return []

    # Resolve the project to get its DB.
    project = find_project(repo_root)
    if project is None:
        _LOG.debug("get_changed_symbols_db: no project found at %s", repo_root)
        return []

    result: list[dict[str, object]] = []

    try:
        with _db.open_project_readonly(project.hash) as conn:
            for file_rel, ranges in sorted(file_ranges.items()):
                if len(result) >= limit:
                    break
                # Build a WHERE clause that checks overlap for any of the ranges.
                # Symbol overlaps range if: sym_start <= range_end AND sym_end >= range_start
                # (sym_end may be NULL for top-level assignments — exclude those).
                where_parts: list[str] = []
                params: list[object] = [file_rel]
                for rng_start, rng_end in ranges:
                    where_parts.append("(line <= ? AND end_line >= ?)")
                    params.extend([rng_end, rng_start])

                where_clause = " OR ".join(where_parts)
                rows = conn.execute(
                    f"SELECT DISTINCT name FROM symbols "
                    f"WHERE file_rel = ? AND end_line IS NOT NULL AND ({where_clause}) "
                    f"ORDER BY line",
                    params,
                ).fetchall()

                if not rows:
                    continue

                symbol_names = [str(r["name"]) for r in rows]
                result.append({
                    "file": file_rel,
                    "symbols": symbol_names,
                    "symbol_count": len(symbol_names),
                })
    except Exception:
        _LOG.debug("get_changed_symbols_db: DB query failed", exc_info=True)
        return []

    return result


# ---------------------------------------------------------------------------
# blame_symbol — git blame for a specific line range
# ---------------------------------------------------------------------------


def blame_symbol(
    repo_root: str | Path,
    file_path: str,
    start_line: int,
    end_line: int,
) -> list[dict[str, object]]:
    """Return git blame information for *file_path* lines *start_line*–*end_line*.

    Runs ``git blame -L {start_line},{end_line} --porcelain {file_path}`` and
    parses the porcelain output into a list of dicts, one per line::

        [
            {
                "line_no": int,        -- 1-based line number in the file
                "commit_hash": str,    -- full 40-char commit hash
                "author": str,         -- author name
                "date": str,           -- author date as "YYYY-MM-DD"
                "content": str,        -- raw source line content
            },
            ...
        ]

    Fail-soft: returns ``[]`` on any git error, missing repo, or parse failure.
    Never raises.
    """
    try:
        return _blame_symbol_inner(str(repo_root), file_path, start_line, end_line)
    except Exception:
        _LOG.debug("blame_symbol failed", exc_info=True)
        return []


def _blame_symbol_inner(
    repo_root: str,
    file_path: str,
    start_line: int,
    end_line: int,
) -> list[dict[str, object]]:
    """Inner (non-fail-soft) implementation of :func:`blame_symbol`."""
    raw = _run_git(
        ["blame", f"-L{start_line},{end_line}", "--porcelain", file_path],
        cwd=Path(repo_root),
        timeout=30,
    )
    if not raw:
        return []
    return _parse_blame_porcelain(raw, start_line)


# Regex that matches the opening line of a porcelain blame block:
#   <40-char-hash> <orig_line> <final_line> [<count>]
_BLAME_HEADER_RE = re.compile(r"^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$")


def _parse_blame_porcelain(raw: str, start_line: int) -> list[dict[str, object]]:
    """Parse ``git blame --porcelain`` output into a list of line dicts.

    Porcelain format repeats for each line::

        <hash> <orig_line> <result_line> [<group_count>]
        author <name>
        author-time <unix_ts>
        ... (other header fields)
        \t<line content>

    Lines that have been grouped (same commit, consecutive) reuse the previously
    seen commit metadata; only the first occurrence of a hash emits the full
    header block.
    """
    lines = raw.splitlines()
    entries: list[dict[str, object]] = []

    # Cached metadata per commit hash (porcelain omits headers for repeated commits).
    commit_cache: dict[str, dict[str, str]] = {}
    current_hash: str = ""
    current_meta: dict[str, str] = {}
    current_line_no: int = start_line

    i = 0
    while i < len(lines):
        line = lines[i]

        m = _BLAME_HEADER_RE.match(line)
        if m:
            current_hash = m.group(1)
            current_line_no = int(m.group(2))
            if current_hash in commit_cache:
                current_meta = commit_cache[current_hash]
            else:
                current_meta = {}
                commit_cache[current_hash] = current_meta
            i += 1
            continue

        if line.startswith("author ") and not line.startswith("author-"):
            current_meta["author"] = line[7:]
            i += 1
            continue

        if line.startswith("author-time "):
            try:
                ts = int(line[12:].strip())
                import datetime as _dt
                current_meta["date"] = _dt.datetime.fromtimestamp(
                    ts, tz=_dt.UTC
                ).strftime("%Y-%m-%d")
            except (ValueError, OSError):
                current_meta["date"] = ""
            i += 1
            continue

        # Content line — tab-prefixed.
        if line.startswith("\t"):
            content = line[1:]  # strip leading tab
            entries.append({
                "line_no": current_line_no,
                "commit_hash": current_hash,
                "author": current_meta.get("author", ""),
                "date": current_meta.get("date", ""),
                "content": content,
            })
            i += 1
            continue

        # Any other header field (summary, committer, filename, …) — skip.
        i += 1

    return entries
