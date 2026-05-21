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
    "index_project_history",
    "find_commits_for_file",
    "build_hint",
]

import contextlib
import json
import logging
import sqlite3
import subprocess
import time
from pathlib import Path

_LOG = logging.getLogger("token_goat.git_history")

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


def _run_git(args: list[str], cwd: Path, timeout: int = 10) -> str | None:
    """Run a git command and return stdout, or None on any failure."""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            _LOG.debug("git %s exited %d: %s", args[0], result.returncode, result.stderr[:200])
            return None
        return result.stdout
    except (OSError, subprocess.TimeoutExpired) as exc:
        _LOG.debug("git %s failed: %s", args[0], exc)
        return None


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
    except Exception:  # noqa: BLE001
        return True


def index_project_history(project_root: Path, project_hash: str) -> int:
    """Index recent git history for *project_root* into the per-project DB.

    Returns the number of commits indexed (0 on any failure or skip).
    Safe to call from a background thread.
    """
    try:
        return _index_history_inner(project_root, project_hash)
    except Exception:  # noqa: BLE001
        _LOG.debug("git_history: index_project_history failed", exc_info=True)
        return 0


def _index_history_inner(project_root: Path, project_hash: str) -> int:
    from . import db, paths  # noqa: PLC0415

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
        try:
            for commit in commits:
                try:
                    conn.execute(
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
                    stored += 1
                except Exception as exc:  # noqa: BLE001
                    _LOG.debug(
                        "git_history: failed to store commit %s: %s",
                        commit["commit_short"], exc,
                    )
            # Stamp last_indexed_at only when at least one commit stored — a wholly-failed batch must leave the index stale so the next cycle retries, rather than being suppressed for _REINDEX_STALENESS_SECS.
            if stored:
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
    except Exception:  # noqa: BLE001
        _LOG.debug("git_history: find_commits_for_file failed", exc_info=True)
        return []


def _find_commits_inner(
    project_hash: str,
    rel_path: str,
    *,
    limit: int,
) -> list[dict[str, object]]:
    from . import db  # noqa: PLC0415

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
        except Exception:  # noqa: BLE001
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
