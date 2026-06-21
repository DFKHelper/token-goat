"""User-facing CLI: all ``token-goat`` subcommands in one Typer application.

Entry point: :func:`main` / ``token-goat`` (console script).  Subcommands are
organised into groups:

- **Surgical reads** — ``symbol``, ``read``, ``section``, ``semantic``,
  ``deps``: return narrow slices of indexed files instead of the whole file.
- **Repo overview** — ``map``: PageRank-ranked, token-budgeted repo overview.
- **Session / compaction** — ``compact-hint``, ``recovery``, ``resume``,
  ``decision``, ``pinned``: inspect or replay pre-compaction manifests and
  the post-compact recovery hint.
- **Skill preservation** — ``skill-body``, ``skill-compact``, ``skill-diff``,
  ``skill-size``, ``skill-list``: inspect cached skill bodies.
- **Google Drive** — ``gdrive-fetch``, ``gdrive-sections``, ``gdrive-list``,
  ``gdrive-auth``: download and shrink Drive files.
- **Web / Bash history** — ``web-output``, ``bash-output``, ``history``,
  ``bash-history``: replay cached tool output.
- **Image tools** — ``fetch-image``, ``image-shrink``, ``compress``.
- **Indexing** — ``index``, ``reindex``, ``stats``, ``memory``,
  ``git-history``: manage the per-project SQLite index.
- **Lifecycle** — ``install``, ``uninstall``, ``doctor``, ``worker``.

All CLI handlers call :func:`raise_for_error` on non-zero exits and use
:func:`~token_goat.util.get_logger` for structured logging.
"""
from __future__ import annotations

import builtins
import contextlib
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast, get_args

if TYPE_CHECKING:
    from collections.abc import Callable

    from .project import Project

# Force UTF-8 on stdout/stderr (Windows defaults to cp1252 which can't encode
# the punctuation we use in maps, hints, and stats: → ›  etc.).
# `.reconfigure` exists on TextIOWrapper but not on the generic TextIO base.
# contextlib.suppress(AttributeError) handles environments where it isn't there.
with contextlib.suppress(AttributeError, OSError):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]  # TextIOWrapper.reconfigure() exists at runtime but not on TextIO base; contextlib.suppress above handles AttributeError
with contextlib.suppress(AttributeError, OSError):
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]  # same

import typer

from . import baseline as baseline_mod
from . import config as config_mod
from . import hooks_cli
from .hooks_common import is_real_int
from .render.ansi import color_stderr
from .util import get_logger, json_compact

_LOG = get_logger("cli")


def _error(msg: str) -> None:
    """Print a user-facing error message to stderr with a consistent 'Error: ' prefix.

    On a TTY the prefix is rendered in red (ANSI 31); in a pipe or when NO_COLOR
    is set the message is plain text so it stays grep-friendly and CI-safe.
    """
    prefix = "\033[31mError:\033[0m " if color_stderr() else "Error: "
    typer.echo(f"{prefix}{msg}", err=True)


def _warn(msg: str) -> None:
    """Print a user-facing warning to stderr with a consistent 'Warning: ' prefix."""
    prefix = "\033[33mWarning:\033[0m " if color_stderr() else "Warning: "
    typer.echo(f"{prefix}{msg}", err=True)


def _require_project(
    msg: str = "no project detected — run from a project directory",
) -> Project:
    """Return the current project or exit with code 1.

    Centralises the repeated pattern::

        proj = find_project(Path.cwd())
        if proj is None:
            _error("...")
            raise typer.Exit(1)

    All callers that import ``find_project`` at module scope can use this
    instead; it performs the import lazily so startup time is unaffected.
    """
    from .project import find_project

    proj = find_project(Path.cwd())
    if proj is None:
        _error(msg)
        raise typer.Exit(1)
    return proj


def _emit_json(data: object, *, indent: int | None = None) -> None:
    """Echo ``data`` as JSON and raise ``typer.Exit(0)``.

    Centralises the repeated ``if json_output: typer.echo(json.dumps(...)); return``
    pattern.  Callers should invoke this inside an ``if json_output:`` block::

        if json_output:
            _emit_json(results)

    When *indent* is ``None`` (the default), compact ``separators=(",", ":")`` are
    used to minimise output size — consistent with all other JSON-output sites in
    this module.  Passing a non-``None`` *indent* enables pretty-printing and
    omits the separators override so indented output remains readable.
    """
    if indent is None:
        typer.echo(json_compact(data))
    else:
        typer.echo(json.dumps(data, ensure_ascii=False, indent=indent))
    raise typer.Exit(0)


def _lazy_import(name: str) -> Any:
    """Lazy intra-package module import.  Use inside command bodies to defer cold-start cost.

    Returns the imported module as ``Any`` so callers can access attributes
    without mypy complaints.  Typical usage::

        _db = _lazy_import("db")
        with _db.open_project(proj_hash) as conn:
            ...

    The single ``# noqa: PLC0415`` lives here rather than at every call site,
    eliminating the per-import suppression comment on each lazy-load line.
    """
    from importlib import import_module
    return import_module(f"token_goat.{name}")


# ---------------------------------------------------------------------------
# Reusable Typer option constants
#
# Declaring these once at module level eliminates the ~19 identical
# ``typer.Option(False, "--json")`` repetitions across commands and avoids
# the per-site ``noqa: B008`` suppressions that were needed at every call site.
# Typer reads the annotation type from the parameter signature; these objects
# carry only the CLI flag name, default value, and help text.
# ---------------------------------------------------------------------------

#: ``--json`` flag shared by every command that can emit structured output.
_OPT_JSON: bool = typer.Option(False, "--json", help="Output structured JSON instead of human-readable text.")
#: ``--limit`` / ``-n`` option shared by web-history, bash-history, mcp-history, skill-history.
_OPT_LIMIT_HISTORY: int = typer.Option(20, "--limit", "-n", help="Maximum entries to show (newest first)")

#: ``--context`` / ``-c`` lines option shared by bash-output and web-output commands.
_OPT_CONTEXT_LINES: int = typer.Option(0, "--context", "-c", help="Extra lines before/after")

#: Optional ``--session-id`` / ``-s`` flag.  When omitted the command uses the
#: current or most-recent session automatically.
_OPT_SESSION_ID: str | None = typer.Option(None, "--session-id", "-s")


def _format_path_output(path: Path, json_mode: bool = False) -> str:
    """Format a path for output, optionally as JSON.

    Handles path resolution and relative-path fallback uniformly across commands.
    When not in JSON mode, returns the resolved path as a string (absolute);
    when in JSON mode, returns a JSON object string with path and optional size.

    Args:
        path:      Path to format (will be resolved).
        json_mode: When True, return JSON object string ``{"path": "...", "size": N}``.
                   When False, return bare resolved path string.

    Returns:
        Formatted path string (either JSON or plain absolute path).
    """
    abs_path = path.resolve()
    if json_mode:
        return json.dumps({"path": str(abs_path), "size": abs_path.stat().st_size}, separators=(",", ":"))
    return str(abs_path)


def _emit_path_result(path: Path, json_output: bool) -> None:
    """Echo a local file path result, either as JSON or plain text.

    Both ``cmd_gdrive_fetch`` and ``cmd_fetch_image`` return a single path with an
    optional size field — identical output shape — so they share this helper instead
    of duplicating the three-line ``if json_output / else`` block.

    Args:
        path:        Local filesystem path to emit.
        json_output: When True, emit ``{"path": "...", "size": N}`` as JSON.
                     When False, emit the bare path string.
    """
    typer.echo(_format_path_output(path, json_mode=json_output))


def _validate_session_id(session_id: str) -> None:
    """Validate *session_id* or exit with code 1.

    Centralises the repeated pattern::

        try:
            session_mod.validate_session_id(session_id)
        except ValueError as exc:
            _error(f"invalid session ID: {exc}")
            raise typer.Exit(1) from exc

    All five session-aware commands use this instead of duplicating that block.
    """
    session_mod = _lazy_import("session")

    try:
        session_mod.validate_session_id(session_id)
    except ValueError as exc:
        _error(f"invalid session ID: {exc}")
        raise typer.Exit(1) from exc


# Close-match thresholds for "did you mean…?" suggestions on a symbol miss.
# 5 caps suggestion count (difflib default); 0.6 is difflib's default cutoff.
# Centralised here so the symbol/read/section paths stay consistent.
_SYMBOL_DIDYOUMEAN_LIMIT = 5
_SYMBOL_DIDYOUMEAN_CUTOFF = 0.6
# Confidence cutoff for the auto-redirect path (default behaviour when no
# ``--strict`` flag).  Set high so the redirect only fires on near-typos
# (``getuser`` ≈ ``getUser``, ``Sesion`` ≈ ``Session``) and not on
# weakly-related substring matches.  0.85 corresponds to roughly one
# single-character edit on a 7-character identifier; below this the agent
# should make the choice itself from the suggestion list.
_SYMBOL_AUTO_REDIRECT_CUTOFF = 0.85


def _auto_redirect_target(name: str, candidate_pool: list[str]) -> str | None:
    """Return the unambiguous high-confidence close match, or None.

    The auto-redirect only fires when:

    1. There is exactly one candidate at or above
       :data:`_SYMBOL_AUTO_REDIRECT_CUTOFF`.  Two candidates at equal
       similarity (e.g. ``foo`` vs ``foa`` for query ``fob``) means the
       agent should still choose; we refuse to guess.
    2. The candidate is not the exact query itself (defensive: the caller
       should not normally pass an exact match through this helper).

    Returns ``None`` when the redirect should NOT fire so callers can fall
    through to the standard "Did you mean …?" suggestion path.
    """
    from difflib import get_close_matches

    if not candidate_pool or not name:
        return None
    high_conf = get_close_matches(
        name, candidate_pool, n=2, cutoff=_SYMBOL_AUTO_REDIRECT_CUTOFF,
    )
    if len(high_conf) != 1:
        return None
    target = high_conf[0]
    if target == name:
        return None
    return target
# Hard ceiling on rows pulled into Python for fuzzy matching. Without this the
# global index (potentially hundreds of thousands of symbols across many
# projects) could push memory pressure on a casual `token-goat symbol` miss.
_SYMBOL_DIDYOUMEAN_POOL = 50_000


def _project_symbol_pool(proj_hash: str) -> list[str]:
    """Return the deduplicated symbol-name pool for *proj_hash*.

    Capped at :data:`_SYMBOL_DIDYOUMEAN_POOL` (50k) so a giant monorepo
    cannot push memory pressure on a casual ``token-goat symbol`` miss.
    Returns ``[]`` on any DB error so the miss path still emits.

    Centralising the pool query here means the close-match suggestion list
    and the auto-redirect lookup hit the DB exactly once per command
    invocation instead of twice.
    """
    _db = _lazy_import("db")

    try:
        with _db.open_project_readonly(proj_hash) as conn:
            rows = conn.execute(
                "SELECT DISTINCT name FROM symbols WHERE name IS NOT NULL LIMIT ?",
                (_SYMBOL_DIDYOUMEAN_POOL,),
            ).fetchall()
    except (_db.DBError, sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("symbol pool query failed for project %s: %s", proj_hash[:8], exc)
        return []
    return [r["name"] for r in rows if r["name"]]


def _project_close_symbol_matches(proj_hash: str, name: str) -> list[str]:
    """Return up to :data:`_SYMBOL_DIDYOUMEAN_LIMIT` distinct symbol names from this
    project that are close lexical matches for ``name``.

    Surfaced as a "Did you mean:" hint on a single-project symbol miss so the
    agent has an actionable next step instead of falling back to ``Read``.

    Returns an empty list on any DB error so the miss path still emits its
    headline message.
    """
    from difflib import get_close_matches

    names = _project_symbol_pool(proj_hash)
    return get_close_matches(
        name, names, n=_SYMBOL_DIDYOUMEAN_LIMIT, cutoff=_SYMBOL_DIDYOUMEAN_CUTOFF,
    )


def _global_symbol_pool() -> list[str]:
    """Return the deduplicated symbol-name pool across the global index.

    Mirrors :func:`_project_symbol_pool` for cross-project lookups.
    """
    _db = _lazy_import("db")

    try:
        with _db.open_global_readonly() as gconn:
            rows = gconn.execute(
                "SELECT DISTINCT name FROM symbols_global WHERE name IS NOT NULL LIMIT ?",
                (_SYMBOL_DIDYOUMEAN_POOL,),
            ).fetchall()
    except (_db.DBError, sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("global symbol pool query failed: %s", exc)
        return []
    return [r["name"] for r in rows if r["name"]]


def _global_close_symbol_matches(name: str) -> list[str]:
    """Return up to :data:`_SYMBOL_DIDYOUMEAN_LIMIT` close matches for ``name``
    across the global symbol index.

    Mirrors :func:`_project_close_symbol_matches` but queries ``symbols_global``
    so ``token-goat symbol foo --all-projects`` can suggest names from any
    indexed project (skills, plugins, sibling repos).
    """
    from difflib import get_close_matches

    names = _global_symbol_pool()
    return get_close_matches(
        name, names, n=_SYMBOL_DIDYOUMEAN_LIMIT, cutoff=_SYMBOL_DIDYOUMEAN_CUTOFF,
    )


def _query_project(proj_hash: str, sql: str, params: tuple[object, ...]) -> list[sqlite3.Row]:
    """Run a SELECT against the project DB, exiting on DBError.

    Centralises the repeated pattern::

        try:
            with _db.open_project(proj.hash) as conn:
                rows = conn.execute(sql, params).fetchall()
        except _db.DBError as exc:
            _error(f"project index unavailable: {exc}. Run ...")
            raise typer.Exit(1) from None

    Returns the raw sqlite3.Row list on success.
    """
    _db = _lazy_import("db")

    try:
        with _db.open_project(proj_hash) as conn:
            return conn.execute(sql, params).fetchall()
    except _db.DBError as exc:
        _error(f"project index unavailable: {exc}. Run `token-goat index --full` to rebuild.")
        raise typer.Exit(1) from None


def _sum_file_sizes(project_hash: str, file_rels: list[str]) -> int:
    """Return the sum of ``files.size`` for the given *file_rels* in one project.

    Used by :func:`_record_lookup_stat` to estimate the bytes an agent *would*
    have needed to read the source files directly, so the savings reported for
    ``symbol_lookup``, ``semantic_search``, and ``map_lookup`` reflect the
    real context reduction rather than zero.

    Best-effort: returns 0 on any DB or data error so the caller can use the
    result without guarding against exceptions.

    Args:
        project_hash: The project whose ``files`` table to query.
        file_rels:    Relative paths to look up.  Duplicates are deduplicated
                      before the query so each file is counted once.

    Returns:
        Sum of ``size`` for all matched rows; 0 if none match or on error.
    """
    if not file_rels or not project_hash:
        return 0
    try:
        _db_mod = _lazy_import("db")
        unique_rels = list(dict.fromkeys(file_rels))  # dedup, preserve order
        placeholders = ",".join("?" * len(unique_rels))
        sql = f"SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE rel_path IN ({placeholders})"
        with _db_mod.open_project_readonly(project_hash) as conn:
            row = conn.execute(sql, unique_rels).fetchone()
        return int(row["total"]) if row else 0
    except Exception as exc:
        _LOG.debug("_sum_file_sizes failed project=%s: %s", project_hash[:8] if project_hash else "", exc)
        return 0


def _total_project_bytes(project_hash: str) -> int:
    """Return the sum of ``files.size`` for every file in *project_hash*.

    Used to compute ``map_lookup`` savings: the map overview is a token-budgeted
    summary of the whole repo, so the counterfactual is the agent reading every
    source file individually.

    Best-effort: returns 0 on any DB or data error.
    """
    if not project_hash:
        return 0
    try:
        _db_mod = _lazy_import("db")
        sql = "SELECT COALESCE(SUM(size), 0) AS total FROM files"
        with _db_mod.open_project_readonly(project_hash) as conn:
            row = conn.execute(sql).fetchone()
        return int(row["total"]) if row else 0
    except Exception as exc:
        _LOG.debug("_total_project_bytes failed project=%s: %s", project_hash[:8] if project_hash else "", exc)
        return 0


def _record_lookup_stat(
    kind: str,
    query_text: str,
    result_count: int,
    *,
    scope: str,
    project_hash: str | None = None,
    bytes_saved: int = 0,
) -> None:
    """Record an adoption-tracking stat for a CLI lookup command.

    Lookup commands (``token-goat symbol`` / ``token-goat semantic``) steer
    the agent toward a narrow surgical read instead of a full-file Read or
    shotgun Grep.  When the caller provides *bytes_saved* (estimated as
    ``sum(source file sizes) − output bytes``), the row records real context
    reduction.  Without it, ``bytes_saved`` is 0 and the row only shows up in
    ``token-goat stats`` when ``[stats] record_zero_savings = true`` (same
    opt-in policy as ``image_shrink_skipped``).

    The row exists so adoption — how often the agent reaches for a lookup
    instead of a raw Read/Grep — is measurable.  ``detail`` packs ``query``,
    ``scope`` (``project`` | ``all_projects``), and ``hits`` so a follow-up
    query can split adoption by hit/miss without re-reading the source query
    text.

    Best-effort: a DB error must never block the user-visible command output,
    so all exceptions are caught and logged at debug level.
    """
    try:
        _db = _lazy_import("db")

        # Detail capped to 200 chars to keep ``stats.detail`` modest under a
        # long natural-language semantic query; the truncation marker is
        # explicit so ``token-goat stats --json`` consumers can detect it.
        q = query_text[:180] + ("…" if len(query_text) > 180 else "")
        detail = f"q={q!r} scope={scope} hits={result_count}"
        tokens_saved = max(1, bytes_saved // 3 + 1) if bytes_saved > 0 else 0
        _db.record_stat(
            project_hash,
            kind,
            bytes_saved=bytes_saved,
            tokens_saved=tokens_saved,
            detail=detail,
        )
    except Exception as exc:
        _LOG.debug("record lookup stat failed kind=%s: %s", kind, exc)


def _record_body_recall_stat(
    body: str,
    result: str,
    stat_name: str,
    detail: str,
) -> tuple[int, int, int, int]:
    """Record a skill/body recall stat with bytes and tokens saved calculations.

    Computes saved bytes (original size - result size) and saved tokens,
    then records to the adoption-tracking stats DB.

    Returns (body_bytes, returned_bytes, saved_bytes, tokens_saved). Best-effort:
    a DB error must never block the user-visible command output, so all exceptions
    are caught and logged at debug level.
    """
    body_bytes = len(body.encode())
    returned_bytes = len(result.encode())
    saved_bytes = max(0, body_bytes - returned_bytes)
    try:
        _db = _lazy_import("db")
        from . import compact as _compact

        tokens_saved = max(0, _compact.estimate_tokens(body) - _compact.estimate_tokens(result))
        _db.record_stat(
            None,
            stat_name,
            bytes_saved=saved_bytes,
            tokens_saved=tokens_saved,
            detail=detail,
        )
    except Exception as exc:
        _LOG.debug("record body recall stat failed stat_name=%s: %s", stat_name, exc)
        tokens_saved = 0
    return body_bytes, returned_bytes, saved_bytes, tokens_saved


app = typer.Typer(name="token-goat", no_args_is_help=True)
hook_app = typer.Typer(name="hook", no_args_is_help=True)
config_app = typer.Typer(
    name="config",
    no_args_is_help=True,
    help="Inspect and edit token-goat's config.toml (compact_assist, paths, hint thresholds).",
)

app.add_typer(hook_app, hidden=True)
app.add_typer(config_app, rich_help_panel="Config")


def _version_callback(value: bool) -> None:
    if value:
        from . import __version__

        typer.echo(f"token-goat {__version__}")
        raise typer.Exit


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show the installed token-goat version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """token-goat — token optimizer for Claude Code, Codex CLI, opencode, and openclaw."""
    # The callback is required to register --version on the root command; the
    # body is intentionally empty so the no_args_is_help behaviour still fires.
    _ = version


def main() -> None:
    """Process entry point. Wraps ``app()`` so hook subcommands NEVER propagate
    a non-zero exit even when click/typer itself rejects unknown arguments.

    Hook harnesses (Codex in particular) pass version-specific args we can't
    predict; click's ``no_such_option`` raises before our handler runs and
    becomes a top-level ``SystemExit(2)``. Catching it here, emitting a
    ``{"continue": true}`` placeholder, and exiting 0 keeps the harness happy.
    Non-hook commands keep their normal exit behaviour so real CLI usage still
    surfaces bad flags to the user.
    """
    try:
        app()
    except SystemExit as exc:
        code = exc.code
        if not isinstance(code, int) or code == 0:
            raise
        argv = sys.argv[1:] if len(sys.argv) > 1 else []
        is_hook_call = bool(argv) and argv[0] == "hook"
        if not is_hook_call:
            raise
        try:
            sys.stdout.write('{"continue": true}')
            sys.stdout.flush()
        except Exception as e:
            _LOG.exception("failed to emit hook response: %s", e)
        raise SystemExit(0) from None


# ---------------------------------------------------------------------------
# Symbol command helpers
# ---------------------------------------------------------------------------

# How recently a file must have been modified to qualify for an on-the-fly
# parse when it is not yet in the index.  60 s covers the "just saved a new
# file and immediately ran symbol" case without scanning every file on disk.
_INLINE_INDEX_RECENCY_SECS = 60


def _inline_symbol_search(
    name: str,
    proj: Project,
    *,
    kind_filter: list[str] | None = None,
) -> list[dict]:
    """Parse recently-modified unindexed files and search for *name*.

    Called when the DB returns 0 results for a project that is otherwise
    indexed.  Walks files under the project root whose mtime is within
    :data:`_INLINE_INDEX_RECENCY_SECS`, runs them through
    :func:`~token_goat.parser.index_file`, and returns any symbol whose name
    matches (exact or glob, case-sensitive).  Results are annotated with the
    ``not_indexed`` flag so callers can surface the ``(not yet indexed)``
    marker to the user.

    Returns an empty list on any error so the caller falls through normally.
    """
    import fnmatch

    try:
        from . import parser as parser_mod

        is_glob = _is_glob_pattern(name)
        cutoff = time.time() - _INLINE_INDEX_RECENCY_SECS
        results: list[dict] = []
        root = proj.root
        for candidate in root.rglob("*"):
            if not candidate.is_file():
                continue
            if any(part in parser_mod.SKIP_DIRS for part in candidate.parts):
                continue
            suffix = candidate.suffix.lower()
            basename = candidate.name.lower()
            if basename not in parser_mod._KNOWN_BASENAMES and suffix not in parser_mod._KNOWN_EXTENSIONS:
                continue
            try:
                if candidate.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            fi = parser_mod.index_file(proj, candidate)
            if fi is None:
                continue
            for sym in fi.symbols:
                name_match = fnmatch.fnmatchcase(sym.name, name) if is_glob else sym.name == name
                if not name_match:
                    continue
                if kind_filter and sym.kind not in kind_filter:
                    continue
                results.append({
                    "file": fi.rel_path,
                    "line": sym.line,
                    "kind": sym.kind,
                    "name": sym.name,
                    "signature": sym.signature,
                    "not_indexed": True,
                })
        return _rank_symbol_results(results, name)
    except Exception:
        _LOG.debug("_inline_symbol_search failed for %r", name, exc_info=True)
        return []


_SYMBOL_KIND_ALIASES: dict[str, list[str]] = {
    "fn": ["function"],
    "func": ["function"],
    "class": ["class"],
    "method": ["method"],
    "const": ["const"],
    "interface": ["interface"],
    "enum": ["enum"],
    "var": ["var"],
    "type": ["type"],
}


def _symbol_kind_filter(types: list[str]) -> list[str]:
    """Expand user-supplied ``--type`` values to canonical DB kind strings."""
    out: list[str] = []
    for t in types:
        out.extend(_SYMBOL_KIND_ALIASES.get(t.lower(), [t.lower()]))
    return list(dict.fromkeys(out))


def _is_glob_pattern(query: str) -> bool:
    return "*" in query or "?" in query


def _glob_to_sql_like(query: str) -> str:
    escaped = query.replace("%", r"\%").replace("_", r"\_")
    return escaped.replace("*", "%").replace("?", "_")


def _rank_symbol_results(results: list[dict], query: str) -> list[dict]:
    """Sort results by match tier: exact name → prefix → substring.

    Within each tier, non-test files rank above test files — a production
    definition (``src/models.py``) is almost always more relevant than a
    same-named stub or fixture (``tests/test_models.py``, ``spec/``,
    ``__tests__/``).  When both tier and test-file status tie, the original
    DB order is preserved (stable sort).

    Wildcard queries skip tiering and return in DB order.
    """
    if _is_glob_pattern(query):
        return results
    q_lower = query.lower()

    def _sort_key(row: dict) -> tuple[int, int]:
        n = row["name"].lower()
        # Primary key: name-match tier (0=exact, 1=prefix, 2=substring).
        if n == q_lower:
            tier = 0
        elif n.startswith(q_lower):
            tier = 1
        else:
            tier = 2
        # Secondary key: 0 for non-test paths, 1 for test paths so tests
        # sink below production definitions at the same tier.
        file_path = row.get("file", "")
        is_test = _is_test_path(file_path)
        return (tier, int(is_test))

    return sorted(results, key=_sort_key)


def _is_test_path(file_path: str) -> bool:
    """Return True when *file_path* looks like a test or spec file.

    Covers the common conventions across Python, JavaScript/TypeScript,
    Go, Ruby, and Rust:

    * Leading path component is ``tests``, ``test``, ``spec``, or ``__tests__``
    * Any path component is one of those names (e.g. ``src/tests/…``)
    * Filename starts with ``test_`` (pytest convention)
    * Filename ends with ``_test.py``, ``_test.go``, ``_spec.rb``, ``.test.ts``,
      ``.test.js``, ``.spec.ts``, ``.spec.js``

    False positives are acceptable — this is a tie-breaking hint, not a hard
    filter.  When every match is a test file the function returns True for all
    of them and the original DB order is preserved.
    """
    normed = file_path.replace("\\", "/")
    parts = normed.split("/")
    # Check any path component against known test-directory names.
    test_dirs = {"tests", "test", "spec", "__tests__"}
    if any(part.lower() in test_dirs for part in parts[:-1]):  # all but the filename
        return True
    basename = parts[-1].lower() if parts else ""
    # Filename-level patterns.
    if basename.startswith("test_"):
        return True
    test_suffixes = (
        "_test.py", "_test.go", "_spec.rb",
        ".test.ts", ".test.js", ".spec.ts", ".spec.js",
        ".test.tsx", ".spec.tsx",
    )
    return any(basename.endswith(s) for s in test_suffixes)


def _symbol_json_snippet(
    proj_root: str,
    file_rel: str,
    line: int,
    end_line: int | None,
    max_snippet_lines: int = 8,
) -> str | None:
    """Extract a short source snippet for a symbol for JSON output.

    Returns the first *max_snippet_lines* lines of the symbol's body, with
    trailing whitespace stripped and blank-only lines omitted.  Returns None
    if the source file cannot be read.
    """
    import pathlib
    try:
        abs_path = pathlib.Path(proj_root) / file_rel
        src_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None

    # line is 1-indexed; cap at end_line if known.
    start_idx = max(0, line - 1)
    stop_idx = min(len(src_lines), end_line or start_idx + max_snippet_lines)
    chunk = src_lines[start_idx:stop_idx][:max_snippet_lines]
    # Drop trailing blank lines.
    while chunk and not chunk[-1].strip():
        chunk.pop()
    return "\n".join(chunk) if chunk else None


def _enrich_symbols_with_snippets(
    results: list[dict],
    proj_root: str,
    end_lines: dict[tuple[str, int], int | None],
) -> None:
    """Mutate *results* in-place: add ``symbol`` and ``snippet`` keys for JSON output.

    ``end_lines`` maps ``(file_rel, line)`` → ``end_line | None`` and is pre-fetched
    by the caller from the DB to avoid per-symbol file stats.
    """
    for r in results:
        r.setdefault("symbol", r.get("name"))
        end_line = end_lines.get((r.get("file", ""), r.get("line", 0)))
        r["snippet"] = _symbol_json_snippet(proj_root, r["file"], r["line"], end_line)


@app.command(rich_help_panel="Core")
def symbol(
    name: str,
    file: str | None = typer.Argument(
        None,
        help=(
            "Optional file path to scope the search (case-insensitive partial "
            "match on rel_path, e.g. 'auth/service.py' matches 'src/auth/service.py'). "
            "Disambiguates a symbol name defined in more than one file."
        ),
    ),
    all_projects: bool = typer.Option(False, "--all-projects"),
    as_json: bool = _OPT_JSON,
    limit: int = typer.Option(50, "--limit"),
    strict: bool = typer.Option(
        False,
        "--strict",
        help=(
            "Disable close-match auto-redirect on a miss.  By default a "
            "single high-confidence close match (no other candidates) is "
            "followed transparently with a `(redirected from: <typo>)` "
            "marker; ``--strict`` returns 'no matches' instead."
        ),
    ),
    show_refs: bool = typer.Option(
        False,
        "--refs",
        help="Annotate each result with its reference count: [N refs].",
    ),
    filter_types: list[str] = typer.Option(  # noqa: B008
        [],
        "--type",
        help=(
            "Filter by symbol kind: fn, class, method, const, interface, enum, var, type. "
            "Repeat to allow multiple kinds: --type fn --type method"
        ),
    ),
    full: bool = typer.Option(
        False,
        "--full",
        "-f",
        help=(
            "When combined with token-goat read, bypass smart truncation. "
            "For the symbol search command itself this flag is accepted but has no effect "
            "(symbol lists file locations, not bodies)."
        ),
    ),
    quiet: bool = typer.Option(
        False,
        "--quiet",
        "-q",
        help="Suppress non-essential output (count lines, hints). Results only.",
    ),
    context_lines: int = typer.Option(
        0,
        "--context",
        "-C",
        help=(
            "Show N lines before and after each symbol's definition. "
            "Saves a follow-up Read call when you need a quick look at the surrounding code."
        ),
        min=0,
    ),
) -> None:
    """Find a symbol definition by name (function, class, method, type, constant, etc.).

    Searches the indexed project for functions, classes, methods, variables, types, and
    other named definitions matching the given name. Use ``--all-projects`` to search
    across all indexed projects (useful for skills and plugins). Use ``--limit`` to
    control max results (default 50).

    Glob patterns: ``get_*`` matches any symbol starting with ``get_``.

    File scope: pass an optional second positional FILE to restrict matches to
    symbols whose ``rel_path`` contains that path (case-insensitive, partial —
    ``token-goat symbol UserService auth/service.py``).  Useful when the same
    symbol name is defined in several files.  When a FILE scope is given and no
    symbol matches inside it, the command exits 1 with an informative message.

    Type filter: ``--type fn`` returns only functions; ``--type class --type interface``
    returns classes and interfaces.  Shorthand ``fn`` maps to ``function``.

    Close-match auto-redirect: when the requested name returns zero results
    *and* the project has exactly one close-match candidate at high
    confidence (difflib ratio >= 0.85), the lookup is automatically re-run
    against that candidate.  The redirected response carries a
    ``redirected_from`` field in JSON output and a ``(redirected from: ...)``
    marker in plain-text output so the substitution is auditable.  Use
    ``--strict`` to opt out and get the previous behaviour."""
    _db = _lazy_import("db")

    kind_filter = _symbol_kind_filter(filter_types) if filter_types else []
    is_glob = _is_glob_pattern(name)

    _file_needle = file.replace("\\", "/").lower() if file else None
    # Pre-built SQL LIKE pattern for pushing the file scope into the WHERE
    # clause so it applies BEFORE the row LIMIT (otherwise a target file among
    # the rows truncated by LIMIT produces a false "No symbol found"). LIKE
    # wildcards are escaped so the needle matches literally; file paths often
    # contain '_' (a single-char wildcard). Backslashes were already normalized
    # to '/', so '\' is a safe ESCAPE character.
    _file_like_param: str | None = None
    if _file_needle is not None:
        _escaped_needle = (
            _file_needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        _file_like_param = f"%{_escaped_needle}%"

    def _apply_file_scope(rows: list[dict]) -> list[dict]:
        if _file_needle is None:
            return rows
        return [
            r for r in rows
            if _file_needle in str(r.get("file", "")).replace("\\", "/").lower()
        ]

    use_tty_color = sys.stdout.isatty() and not as_json

    def _context_block(row: dict, n: int) -> list[str] | None:
        """Return up to *n* source lines before and after the symbol body.

        Returns a list of ``"<lineno>: <text>"`` strings centred on the symbol,
        or None if the source file cannot be read.  The symbol's own lines are
        included; context lines outside the symbol are prefixed with ``>`` in TTY
        mode to distinguish them visually from the symbol body.
        """
        import pathlib

        # Determine the project root for this result.
        # Single-project branch: proj is available in the outer scope.
        # All-projects branch: row["project"] is the root string.
        if "project" in row:
            proj_root = pathlib.Path(row["project"])
        else:
            try:
                proj_root = proj.root  # type: ignore[name-defined]
            except NameError:
                return None

        file_rel = row.get("file", "")
        sym_start = row.get("line", 1)
        sym_end = row.get("end_line") or sym_start

        try:
            src_lines = (proj_root / file_rel).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None

        total = len(src_lines)
        # 1-indexed → 0-indexed
        first_idx = max(0, sym_start - 1 - n)
        last_idx = min(total, sym_end + n)  # exclusive

        output: list[str] = []
        for i in range(first_idx, last_idx):
            lineno = i + 1  # back to 1-indexed
            text = src_lines[i]
            is_body = sym_start <= lineno <= sym_end
            if use_tty_color:
                marker = " " if is_body else ">"
                output.append(f"{marker}{lineno:>6}: {text}")
            else:
                output.append(f"{lineno:>6}: {text}")
        return output

    def _fmt_plain(rows: list[dict]) -> None:
        """Print symbol rows as plain text, optionally with ANSI colour when stdout is a TTY."""
        for row in rows:
            project_prefix = f"[{row.get('project', '')}] " if "project" in row else ""
            sig_part = f"  {row['signature']}" if row.get("signature") else ""
            kind_name = f"{row['kind']} {row['name']}"
            not_indexed_suffix = " (not yet indexed)" if row.get("not_indexed") else ""
            ref_count = row.get("ref_count")
            ref_suffix = f"  [{ref_count} refs]" if ref_count is not None else ""
            if use_tty_color:
                kind_name = f"\033[90m{kind_name}\033[0m"
                sig_part = f"\033[2m{sig_part}\033[0m"
                if not_indexed_suffix:
                    not_indexed_suffix = f"\033[33m{not_indexed_suffix}\033[0m"
                if ref_suffix:
                    ref_suffix = f"\033[36m{ref_suffix}\033[0m"
            typer.echo(f"{project_prefix}{row['file']}:{row['line']}: {kind_name}{sig_part}{ref_suffix}{not_indexed_suffix}")
            if context_lines > 0:
                block = _context_block(row, context_lines)
                if block:
                    typer.echo("\n".join(block))

    def _emit_results(
        results: list[dict],
        not_found_extra: str | None = None,
        close_matches: list[str] | None = None,
        redirected_from: str | None = None,
        over_cap_hint: str | None = None,
        file_scope_hint: str | None = None,
    ) -> None:
        """Emit symbol results as JSON or plain text; print a not-found message when empty.

        Args:
            results:         List of symbol dicts to emit.
            not_found_extra: When given, shown as a hint in the empty case (single-project
                             branch passes the indexed-file hint here; global branch passes None).
            close_matches:   Optional list of close-match symbol names to surface as
                             "Did you mean:" suggestions when no results are returned.
                             Skipped silently for JSON output (callers can request the
                             same data themselves) — text mode is where agents get stuck.
            redirected_from: The original (typoed) name the agent supplied,
                             when results were resolved via the close-match
                             auto-redirect path.  Surfaces in JSON as a
                             top-level ``redirected_from`` field and in
                             plain-text as a ``(redirected from: ...)``
                             marker preceding the result block so the
                             substitution is auditable.
        """
        if as_json:
            # Enrich results with context lines when requested.
            if context_lines > 0 and results:
                for r in results:
                    block = _context_block(r, context_lines)
                    if block is not None:
                        r["context"] = "\n".join(block)
            # Always emit the unified envelope: {"query":..., "results":[...], "total":N}
            # plus optional "redirected_from" when a close-match redirect was applied.
            envelope: dict[str, object] = {
                "query": name,
                "results": results,
                "total": len(results),
            }
            if redirected_from is not None:
                envelope["redirected_from"] = redirected_from
            # When --file scopes the search to a file skipped at index time for
            # exceeding the size cap, surface that signal in the envelope so an
            # empty result set is distinguishable from "symbol not in that file".
            if file and not results and over_cap_hint is not None:
                envelope["over_cap"] = over_cap_hint
            # When the --file scope resolved to a single indexed file, attach the skeleton-or-empty hint so JSON callers see the same guidance as text.
            if file and not results and file_scope_hint is not None:
                envelope["file_hint"] = file_scope_hint
            typer.echo(json_compact(envelope))
        elif results:
            if redirected_from is not None:
                marker = f"(redirected from: {redirected_from!r})"
                if use_tty_color:
                    marker = f"\033[33m{marker}\033[0m"
                typer.echo(marker)
            _fmt_plain(results)
        else:
            # Empty results path: pick the appropriate headline (project hint
            # if not yet indexed, plain "no matches" otherwise), then append
            # close-match suggestions when we have any. Surfacing suggestions
            # alongside the not-indexed hint is intentionally suppressed —
            # close matches in a half-indexed project would be misleading.
            if not quiet:
                if file:
                    # When --file names a file that exists but was skipped at
                    # index time for exceeding the size cap, explain that instead
                    # of the generic "no symbol found" miss (the symbol may well
                    # live in the unindexed file; line-range reads still work).
                    if over_cap_hint:
                        typer.echo(over_cap_hint)
                    else:
                        typer.echo(f"No symbol {name!r} found in files matching {file!r}")
                        # Point at skeleton when the scoped file has symbols, or explain the emptiness when it has none; suppressed when the scope is ambiguous or matched no indexed file.
                        if file_scope_hint:
                            typer.echo(file_scope_hint)
                else:
                    typer.echo(not_found_extra or f"No matches for {name!r}")
                    if close_matches and not not_found_extra:
                        from .render.common import render_list
                        if len(close_matches) == 1:
                            typer.echo(f"Did you mean: `token-goat symbol {close_matches[0]}`")
                        else:
                            typer.echo("Did you mean:")
                            typer.echo(render_list(close_matches, bullet="-"))

    def _global_query(target: str) -> list[dict]:
        """Run the symbols_global query for *target* and shape the rows.

        Pulled out so the auto-redirect path can re-run the same query with
        a different name without duplicating the SELECT or the row-shaping.
        """
        _is_glob_q = _is_glob_pattern(target)
        name_op = "LIKE" if _is_glob_q else "="
        name_param = _glob_to_sql_like(target) if _is_glob_q else target
        kind_clause = ""
        kind_params: tuple[object, ...] = ()
        if kind_filter:
            placeholders = ",".join("?" * len(kind_filter))
            kind_clause = f" AND sg.kind IN ({placeholders})"
            kind_params = tuple(kind_filter)
        file_clause = ""
        file_params: tuple[object, ...] = ()
        if _file_like_param is not None:
            file_clause = " AND sg.file_rel LIKE ? ESCAPE '\\'"
            file_params = (_file_like_param,)
        sql = (
            "SELECT sg.project_hash, p.root, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature "
            "FROM symbols_global sg "
            "JOIN projects p ON p.hash = sg.project_hash "
            f"WHERE sg.name {name_op} ?{kind_clause}{file_clause} LIMIT ?"
        )
        with _db.open_global() as gconn:
            rows_raw_inner = gconn.execute(
                sql,
                (name_param, *kind_params, *file_params, limit),
            ).fetchall()
        raw = [
            {
                "project": r["root"],
                "file": r["file_rel"],
                "line": r["line"],
                "kind": r["kind"],
                "name": r["name"],
                "signature": r["signature"],
            }
            for r in rows_raw_inner
        ]
        return _rank_symbol_results(raw, target)

    if all_projects:
        try:
            results = _global_query(name)
        except (_db.DBError, sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
            _error(f"global index unavailable: {exc}. Run `token-goat index` first.")
            raise typer.Exit(1) from None

        # On a global miss, query distinct symbol names across all projects.
        # The same pool feeds both the close-match suggestions list AND the
        # auto-redirect target so the DB is hit exactly once.
        close: list[str] = []
        redirected: str | None = None
        if not results and not is_glob:
            from difflib import get_close_matches

            pool = _global_symbol_pool()
            if not strict:
                redirect_target = _auto_redirect_target(name, pool)
                if redirect_target is not None:
                    try:
                        redirect_results = _global_query(redirect_target)
                    except (_db.DBError, sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
                        _error(f"global index unavailable: {exc}. Run `token-goat index` first.")
                        raise typer.Exit(1) from None
                    if redirect_results:
                        results = redirect_results
                        redirected = name
                        _LOG.info(
                            "symbol --all-projects: auto-redirected %r -> %r",
                            name, redirect_target,
                        )
            if not results:
                close = get_close_matches(
                    name, pool,
                    n=_SYMBOL_DIDYOUMEAN_LIMIT, cutoff=_SYMBOL_DIDYOUMEAN_CUTOFF,
                )
        # Savings for all_projects: aggregate file sizes across results' source files.
        # Each result's project_hash is available from _global_query output.
        _sym_bytes_saved = 0
        if results:
            results_by_proj: dict[str, list[str]] = {}
            for r in results:
                proj_hash = r.get("project") or ""
                # Extract project hash from the project root in results.
                # We need to map back to project hash for _sum_file_sizes.
                # For now, use best-effort aggregation across all projects.
                if proj_hash not in results_by_proj:
                    results_by_proj[proj_hash] = []
                results_by_proj[proj_hash].append(r.get("file", ""))
            # Compute total file bytes by summing across projects
            _sym_file_total = 0
            for proj_root, file_rels in results_by_proj.items():
                # Look up project hash from root
                try:
                    _db_tmp = _lazy_import("db")
                    with _db_tmp.open_global() as gconn:
                        ph_row = gconn.execute(
                            "SELECT hash FROM projects WHERE root = ?", (proj_root,)
                        ).fetchone()
                    if ph_row:
                        proj_hash_val = ph_row["hash"]
                        _sym_file_total += _sum_file_sizes(proj_hash_val, file_rels)
                except Exception:
                    pass
            _sym_output_bytes = max(80 * len(results), len(json_compact(results).encode()))
            _sym_bytes_saved = max(0, _sym_file_total - _sym_output_bytes)
        _record_lookup_stat(
            "symbol_lookup", name, len(results), scope="all_projects",
            bytes_saved=_sym_bytes_saved,
        )
        _emit_results(results, close_matches=close, redirected_from=redirected)
        if file and not results:
            raise typer.Exit(1)
        return

    proj = _require_project()

    def _project_query(target: str) -> list[dict]:
        """Run the per-project symbols query for *target*.

        Same role as :func:`_global_query` for the single-project branch.
        """
        _is_glob_q = _is_glob_pattern(target)
        name_op = "LIKE" if _is_glob_q else "="
        name_param = _glob_to_sql_like(target) if _is_glob_q else target
        kind_clause = ""
        kind_params: tuple[object, ...] = ()
        if kind_filter:
            placeholders = ",".join("?" * len(kind_filter))
            kind_clause = f" AND kind IN ({placeholders})"
            kind_params = tuple(kind_filter)
        file_clause = ""
        file_params: tuple[object, ...] = ()
        if _file_like_param is not None:
            file_clause = " AND file_rel LIKE ? ESCAPE '\\'"
            file_params = (_file_like_param,)
        sql = f"SELECT name, kind, file_rel, line, end_line, signature FROM symbols WHERE name {name_op} ?{kind_clause}{file_clause} LIMIT ?"
        rows_raw_inner = _query_project(
            proj.hash,
            sql,
            (name_param, *kind_params, *file_params, limit),
        )
        raw = [
            {
                "file": r["file_rel"],
                "line": r["line"],
                "end_line": r["end_line"] if "end_line" in r else None,  # noqa: SIM401
                "kind": r["kind"],
                "name": r["name"],
                "signature": r["signature"],
            }
            for r in rows_raw_inner
        ]
        return _rank_symbol_results(raw, target)

    results = _project_query(name)

    from . import read_commands

    if show_refs and results:
        try:
            _db2 = _lazy_import("db")
            with _db2.open_project_readonly(proj.hash) as _rconn:
                count_row = _rconn.execute(
                    "SELECT COUNT(*) AS cnt FROM refs WHERE symbol_name = ?",
                    (name,),
                ).fetchone()
            ref_count_val: int | None = int(count_row["cnt"]) if count_row else None
        except Exception:
            ref_count_val = None
        if ref_count_val is not None:
            for r in results:
                r["ref_count"] = ref_count_val

    hint = read_commands._not_indexed_hint(proj.hash)
    inline_hit = False
    close = []
    redirected = None
    if not results and not hint:
        # Project is indexed but symbol not found — check recently-modified files
        # that the background worker may not have processed yet.
        inline = _apply_file_scope(_inline_symbol_search(name, proj, kind_filter=kind_filter or None))
        if inline:
            results = inline
            inline_hit = True
            _LOG.info(
                "symbol: inline fallback found %d match(es) for %r in recently-modified files",
                len(inline), name,
            )

    if not results and not hint and not inline_hit and not is_glob:
        from difflib import get_close_matches

        pool = _project_symbol_pool(proj.hash)
        if not strict:
            redirect_target = _auto_redirect_target(name, pool)
            if redirect_target is not None:
                redirect_results = _project_query(redirect_target)
                if redirect_results:
                    results = redirect_results
                    redirected = name
                    _LOG.info(
                        "symbol: auto-redirected %r -> %r in project %s",
                        name, redirect_target, proj.hash[:8],
                    )
        if not results:
            close = get_close_matches(
                name, pool,
                n=_SYMBOL_DIDYOUMEAN_LIMIT, cutoff=_SYMBOL_DIDYOUMEAN_CUTOFF,
            )
    # Enrich JSON output with symbol + snippet fields.
    if as_json and results:
        end_lines_map: dict[tuple[str, int], int | None] = {
            (r["file"], r["line"]): r.get("end_line")
            for r in results
        }
        _enrich_symbols_with_snippets(results, str(proj.root), end_lines_map)

    # Savings: the agent's alternative would have been to Read each source
    # file.  Estimate savings as sum(file sizes) − the size of our compact
    # metadata output (file:line:kind:name:sig lines, roughly 80 bytes each).
    _sym_file_rels = [r["file"] for r in results if r.get("file")]
    _sym_file_total = _sum_file_sizes(proj.hash, _sym_file_rels)
    _sym_output_bytes = max(80 * len(results), len(json_compact(results).encode()))
    _sym_bytes_saved = max(0, _sym_file_total - _sym_output_bytes)
    _record_lookup_stat(
        "symbol_lookup", name, len(results), scope="project",
        project_hash=proj.hash,
        bytes_saved=_sym_bytes_saved,
    )
    not_found_extra = hint
    if inline_hit and not not_found_extra:
        not_found_extra = None
    # If --file scoped the search to a file that was skipped at index time for
    # exceeding the size cap, surface that as the miss reason rather than the
    # generic "no symbol found in files matching" message.
    over_cap_hint = (
        read_commands.over_cap_file_hint(file, proj) if (file and not results) else None
    )
    # When --file scoped the miss to a single indexed file, resolve it and attach a skeleton hint (file has symbols) or a "no indexed symbols" note (it does not); only over-cap takes precedence and ambiguous/unmatched scopes get None.
    file_scope_hint: str | None = None
    if file and not results and over_cap_hint is None and _file_like_param is not None:
        _matched_file = read_commands.resolve_scoped_file(proj.hash, _file_like_param)
        if _matched_file is not None:
            file_scope_hint = read_commands.skeleton_or_empty_hint(proj.hash, _matched_file)
    _emit_results(
        results,
        not_found_extra=not_found_extra,
        close_matches=close,
        redirected_from=redirected,
        over_cap_hint=over_cap_hint,
        file_scope_hint=file_scope_hint,
    )
    if file and not results:
        raise typer.Exit(1)


@app.command(rich_help_panel="Core")
def ref(
    name: str,
    as_json: bool = _OPT_JSON,
    limit: int = typer.Option(100, "--limit"),
) -> None:
    """Find all code references to a symbol by name.

    Locates every place in the codebase where the given symbol is referenced
    (called, imported, assigned, etc.). Results include file path, line number,
    column, and surrounding context. Use ``--limit`` to cap results (default 100)."""
    proj = _require_project()

    rows_raw = _query_project(
        proj.hash,
        "SELECT file_rel, line, col, context FROM refs WHERE symbol_name = ? LIMIT ?",
        (name, limit),
    )

    results = [
        {
            "name": name,
            "file": r["file_rel"],
            "line": r["line"],
            "col": r["col"],
            "context": r["context"],
        }
        for r in rows_raw
    ]

    if as_json:
        typer.echo(json_compact(
            {"query": name, "results": results, "total": len(results)},
        ))
    elif results:
        use_tty_color = sys.stdout.isatty()
        for row in results:
            ctx = f"  {row['context']}" if row.get("context") else ""
            if use_tty_color:
                ctx = f"\033[2m{ctx}\033[0m"
            typer.echo(f"{row['file']}:{row['line']}: ref {name!r}{ctx}")
    else:
        from . import read_commands

        hint = read_commands._not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        else:
            typer.echo(f"No references found for {name!r}")


@app.command(rich_help_panel="Core")
def refs(
    symbol: str,
    file: str | None = typer.Option(None, "--file", "-f", help="Only show refs in this file (partial path match)"),
    limit: int = typer.Option(50, "--limit", "-n", help="Cap results (default 50)"),
    as_json: bool = _OPT_JSON,
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress count/summary lines. Results only."),
    show_callers: bool = typer.Option(
        False,
        "--callers",
        help=(
            "Resolve enclosing function/method for each reference.  "
            "Output is grouped by file and shows caller names instead of raw "
            "line context.  Only available with the <file>::<symbol> format."
        ),
    ),
) -> None:
    """Show all files and line numbers where SYMBOL is referenced.

    Each result shows the file path, line number, and the surrounding line of
    source code.  Use ``--file`` to restrict output to a single file.  Use
    ``--limit`` to cap results (default 50).

    When SYMBOL contains ``::`` (e.g. ``src/auth.py::login``), the file part
    is used to narrow results to callers of a symbol defined in that specific
    file.  This replaces a multi-file ``rg`` search for callers.

    Add ``--callers`` (requires ``::`` format) to resolve the enclosing
    function or method name for each reference::

        token-goat refs src/auth.py::login --callers

    Output::

        src/app.py:
          handle_request() at line 42
          <module level> at line 10

    Example usage::

        token-goat refs login
        token-goat refs login --file src/auth.py
        token-goat refs src/auth.py::login
        token-goat refs src/auth.py::login --callers
        token-goat refs login --json
    """
    # <file>::<symbol> format: delegate to targeted refs lookup.
    if "::" in symbol:
        from . import read_commands

        read_commands.refs(symbol, limit=limit, json_output=as_json, callers=show_callers)
        return

    if show_callers:
        typer.echo(
            "--callers requires the <file>::<symbol> format "
            "(e.g. 'src/auth.py::login --callers').  "
            "Plain symbol refs do not resolve enclosing functions.",
            err=True,
        )
        raise typer.Exit(1)

    proj = _require_project()

    if file is not None:
        rows_raw = _query_project(
            proj.hash,
            "SELECT file_rel, line, col, context FROM refs "
            "WHERE symbol_name = ? AND file_rel LIKE ? "
            "ORDER BY file_rel, line LIMIT ?",
            (symbol, f"%{file}%", limit),
        )
    else:
        rows_raw = _query_project(
            proj.hash,
            "SELECT file_rel, line, col, context FROM refs "
            "WHERE symbol_name = ? "
            "ORDER BY file_rel, line LIMIT ?",
            (symbol, limit),
        )

    results = [
        {
            "symbol": symbol,
            "file": r["file_rel"],
            "line": r["line"],
            "col": r["col"],
            "context": r["context"],
        }
        for r in rows_raw
    ]

    if as_json:
        typer.echo(json_compact(
            {"query": symbol, "results": results, "total": len(results)},
        ))
        return

    if not results:
        from . import read_commands

        hint = read_commands._not_indexed_hint(proj.hash)
        if hint:
            if not quiet:
                typer.echo(hint)
        elif file is not None:
            if not quiet:
                typer.echo(f"No references to {symbol!r} found in files matching {file!r}")
        else:
            if not quiet:
                typer.echo(f"No references found for {symbol!r}")
        return

    use_tty_color = sys.stdout.isatty()
    for row in results:
        loc = f"{row['file']}:{row['line']}"
        ctx = row.get("context") or ""
        ctx_stripped = ctx.strip()
        if ctx_stripped:
            sep = "  "
            if use_tty_color:
                ctx_part = f"{sep}\033[2m{ctx_stripped}\033[0m"
            else:
                ctx_part = f"{sep}{ctx_stripped}"
        else:
            ctx_part = ""
        typer.echo(f"{loc}{ctx_part}")


@app.command(rich_help_panel="Core")
def callers(
    name: str,
    as_json: bool = _OPT_JSON,
    limit: int = typer.Option(100, "--limit"),
) -> None:
    """Show which functions and methods call a given symbol.

    Groups results by caller: for each function that references <name>, shows
    the caller's file, name, and every line where it invokes the symbol.

    Complements ``refs`` (which lists raw usage lines) by surfacing the
    call hierarchy — useful for understanding downstream impact before
    changing a symbol's signature.

    Examples::

        token-goat callers dispatch
        token-goat callers semantic_search --json
        token-goat callers index_file --limit 50
    """
    from . import read_commands

    read_commands.callers(name, json_output=as_json, limit=limit)


@app.command(rich_help_panel="Core")
def call_chain(
    name: str = typer.Argument(..., help="Symbol name to trace callers for."),  # noqa: B008
    depth: int = typer.Option(3, "--depth", "-d", help="Levels to traverse up the call tree."),
    limit: int = typer.Option(10, "--limit", help="Max callers shown per level."),
    as_json: bool = _OPT_JSON,
) -> None:
    """Trace who calls a symbol, then who calls those callers, up to N levels deep.

    Walks the caller graph starting from <name> and recurses until --depth
    levels are exhausted or a cycle is detected. Useful for understanding the
    reach of a low-level helper before changing its signature.

    Examples::

        token-goat call-chain dispatch
        token-goat call-chain index_file --depth 4 --json
    """
    from . import read_commands

    read_commands.call_chain(name, depth=depth, limit=limit, json_output=as_json)


@app.command(rich_help_panel="Core")
def impact(
    name: str = typer.Argument(..., help="Symbol name to assess."),  # noqa: B008
    as_json: bool = _OPT_JSON,
) -> None:
    """Show the change impact for a symbol: callers, reference count, and test coverage.

    Combines callers, refs, and test discovery into one report so you can
    assess risk before modifying a symbol's signature or behavior.

    Examples::

        token-goat impact build_read_hint
        token-goat impact dispatch --json
    """
    from . import read_commands

    read_commands.impact(name, json_output=as_json)


@app.command(rich_help_panel="Core")
def todo(
    json_output: bool = _OPT_JSON,
    kinds: str = typer.Option(
        "TODO,FIXME,HACK,XXX,NOTE",
        "--kinds",
        "-k",
        help="Comma-separated list of marker types to include.",
    ),
    group: str = typer.Option(
        "file",
        "--group",
        "-g",
        help="Group output by 'file' (default) or 'kind'.",
    ),
) -> None:
    """Scan indexed project files for TODO/FIXME/HACK/XXX/NOTE markers.

    Lists every marker with its file path, line number, and comment text,
    grouped either by file (default) or by marker kind.

    Results come from the symbol index so they are instantaneous — no
    filesystem walk needed.  Run ``token-goat index`` first if the project
    has not been indexed yet.

    Examples::

        token-goat todo
        token-goat todo --kinds TODO,FIXME
        token-goat todo --group kind
        token-goat todo --json
    """
    from . import todo as _todo

    proj = _require_project()
    kind_set = frozenset(k.strip().upper() for k in kinds.split(",") if k.strip())
    items = _todo.find_todos(proj.hash, proj.root, kinds=kind_set)

    if json_output:
        typer.echo(_todo.format_todos_json(items))
    else:
        typer.echo(_todo.format_todos_text(items, group_by=group))


def _keyword_fallback_hits(
    proj: Project,
    query: str,
    k: int,
) -> list[dict[str, object]]:
    """Keyword grep fallback when embeddings are unavailable.

    Tokenises the query into words (>=3 chars), builds a case-insensitive
    pattern from the first two distinct tokens, and scans indexed project
    files for matching lines.  Returns up to *k* results as dicts with the
    same keys as the JSON output of ``semantic_search``.

    This is intentionally lightweight: it uses Python's ``re`` module (no
    subprocess) so it works on all platforms and requires no extra deps.
    The caller is responsible for printing the ``(keyword fallback …)`` note.
    """
    import re as _re

    from . import db as _db

    tokens = [w.lower() for w in _re.findall(r"\w+", query) if len(w) >= 3]
    if not tokens:
        return []

    # Build an OR-pattern from up to two tokens so a two-word query still
    # returns results when no line contains both words.
    pattern = _re.compile(
        "|".join(_re.escape(t) for t in dict.fromkeys(tokens[:2])),
        _re.IGNORECASE,
    )

    results: list[dict[str, object]] = []
    try:
        with _db.open_project_readonly(proj.hash) as conn:
            file_rows = conn.execute(
                "SELECT rel_path FROM files ORDER BY rel_path"
            ).fetchall()
    except Exception:
        return []

    for frow in file_rows:
        if len(results) >= k:
            break
        rel = frow["rel_path"]
        try:
            text = (proj.root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                snippet = line.strip()[:120]
                results.append({
                    "file": rel,
                    "start": lineno,
                    "end": lineno,
                    "kind": "keyword",
                    "distance": 0.0,
                    "preview": snippet,
                })
                if len(results) >= k:
                    break

    return results


@app.command(rich_help_panel="Core")
def semantic(
    query: str = typer.Argument(...),
    k: int = typer.Option(8, "-k", help="Top-k results"),
    json_output: bool = _OPT_JSON,
    max_distance: float = typer.Option(
        -1.0,
        "--max-distance",
        help=(
            "Effective-distance threshold; results above this are filtered out. "
            "Negative value (default) uses the built-in threshold; pass a large "
            "number (e.g. 99) to disable filtering."
        ),
    ),
    no_rerank: bool = typer.Option(
        False,
        "--no-rerank",
        help="Disable verbatim-token boost and generated-path demotion.",
    ),
    compact: bool = typer.Option(
        True,
        "--compact/--full",
        help=(
            "Compact output: one line per result (<path>:<line>  <snippet>). "
            "Use --full to restore verbose two-line output with kind and distance."
        ),
    ),
    all_projects: bool = typer.Option(
        False,
        "--all-projects",
        help=(
            "Search across all indexed projects, not just the current one. "
            "Useful when skill files are indexed as a separate project "
            "(e.g. after `token-goat index --root ~/.claude/skills/`). "
            "Results include the project root path as a prefix."
        ),
    ),
    mode: str = typer.Option(
        "vector",
        "--mode",
        "-m",
        help="Search mode: vector (default), keyword (BM25 only), or hybrid (RRF fusion).",
    ),
) -> None:
    """Semantic search using local embeddings (fastembed + sqlite-vec)."""
    from . import embeddings

    # Negative sentinel means "use library default".  Anything >= 0 is treated
    # as an explicit threshold; pass a large value to effectively disable.
    threshold: float | None = (
        embeddings.DEFAULT_DISTANCE_THRESHOLD if max_distance < 0 else max_distance
    )

    if all_projects:
        # Cross-project semantic search: run against every known project DB and
        # merge results, deduplicating by (project_hash, file_rel, start_line).
        # Results are re-sorted globally by effective distance so the top-k
        # across all projects are returned.  Each hit's file_rel is prefixed with
        # the project root so the user can tell which project it came from.
        from . import db as _db_mod
        from .project import make_project_at

        project_hashes = _db_mod.list_all_project_hashes()
        if not project_hashes:
            typer.echo("(no indexed projects found — run `token-goat index` first)")
            raise typer.Exit(0)

        all_hits: list[tuple[str, embeddings.SearchHit]] = []  # (project_root, hit)
        # Use a dict as a dedup tracker keyed by (project_hash, file_rel, start_line).
        # Avoid referencing `set` (the builtin) because cli.py also defines a typer
        # command function named `set`, which makes mypy treat the builtin as shadowed.
        seen_dedup: dict[tuple[str, str, int], bool] = {}
        for ph in project_hashes:
            try:
                with _db_mod.open_global_readonly() as gconn:
                    row = gconn.execute(
                        "SELECT root FROM projects WHERE hash = ?", (ph,)
                    ).fetchone()
                if row is None:
                    continue
                proj_root = str(row["root"])
                proj = make_project_at(Path(proj_root))
                proj_hits = embeddings.semantic_search(
                    proj,
                    query,
                    k=k,
                    max_distance=threshold,
                    boost_verbatim=not no_rerank,
                    demote_generated=not no_rerank,
                )
            except (embeddings.EmbeddingsUnavailable, Exception):
                # Skip projects without embeddings or unavailable DBs.
                continue
            for h in proj_hits:
                dedup_key = (ph, h.file_rel, h.start_line)
                if dedup_key not in seen_dedup:
                    seen_dedup[dedup_key] = True
                    all_hits.append((proj_root, h))

        # Sort globally by effective distance, take top-k.
        all_hits.sort(key=lambda x: x[1].distance)
        all_hits = all_hits[:k]

        # Savings for all_projects: aggregate file sizes across results' source files.
        _sem_bytes_saved = 0
        if all_hits:
            results_by_proj: dict[str, list[str]] = {}
            for proj_root, h in all_hits:
                if proj_root not in results_by_proj:
                    results_by_proj[proj_root] = []
                results_by_proj[proj_root].append(h.file_rel)
            # Compute total file bytes by summing across projects
            _sem_file_total = 0
            for proj_root, file_rels in results_by_proj.items():
                # Look up project hash from root
                try:
                    _db_tmp = _lazy_import("db")
                    with _db_tmp.open_global() as gconn:
                        ph_row = gconn.execute(
                            "SELECT hash FROM projects WHERE root = ?", (proj_root,)
                        ).fetchone()
                    if ph_row:
                        proj_hash_val = ph_row["hash"]
                        _sem_file_total += _sum_file_sizes(proj_hash_val, file_rels)
                except Exception:
                    pass
            _sem_output_bytes = sum(len(h.text.encode()) for _, h in all_hits)
            _sem_bytes_saved = max(0, _sem_file_total - _sem_output_bytes)

        _record_lookup_stat(
            "semantic_search", query, len(all_hits), scope="all_projects",
            bytes_saved=_sem_bytes_saved,
        )

        if json_output:
            out = [
                {
                    "project": pr,
                    "file": h.file_rel,
                    "start": h.start_line,
                    "end": h.end_line,
                    "kind": h.kind,
                    "distance": h.distance,
                    "preview": h.text[:200],
                }
                for pr, h in all_hits
            ]
            typer.echo(json_compact(
                {"query": query, "results": out, "total": len(out)},
            ))
            return

        if not all_hits:
            typer.echo("(no results)")
            return

        for proj_root, h in all_hits:
            if compact:
                first_line = next(
                    (ln.strip() for ln in h.text.splitlines() if ln.strip()),
                    h.text.replace("\n", " ")[:120],
                )[:120]
                typer.echo(f"[{proj_root}] {h.file_rel}:{h.start_line} [{h.kind}]  {first_line}")
            else:
                preview = h.text.replace("\n", " ")[:120]
                typer.echo(
                    f"[{proj_root}] {h.file_rel}:{h.start_line}-{h.end_line} "
                    f"({h.kind}, d={h.distance:.4f})"
                )
                typer.echo(f"  {preview}")
        return

    proj = _require_project()

    try:
        if mode == "keyword":
            hits = embeddings.bm25_search(proj, query, k=k)
        elif mode == "hybrid":
            hits = embeddings.hybrid_search(proj, query, k=k, max_distance=threshold)
        else:
            hits = embeddings.semantic_search(
                proj,
                query,
                k=k,
                max_distance=threshold,
                boost_verbatim=not no_rerank,
                demote_generated=not no_rerank,
            )
    except embeddings.EmbeddingsUnavailable as e:
        _warn(
            f"embeddings unavailable ({e}). Falling back to keyword search "
            "(run `token-goat index --embeddings` for full semantic search)."
        )
        fallback = _keyword_fallback_hits(proj, query, k)
        _record_lookup_stat(
            "semantic_search", query, len(fallback), scope="project",
            project_hash=proj.hash,
        )
        if json_output:
            note = "(keyword fallback — embeddings not ready)"
            typer.echo(json_compact(
                {"query": query, "results": fallback, "total": len(fallback), "fallback": note},
            ))
            return
        if not fallback:
            typer.echo("(no results)")
            return
        typer.echo("(keyword fallback — embeddings not ready)")
        for r in fallback:
            snippet = str(r.get("preview", ""))[:100]
            typer.echo(f"{r['file']}:{r['start']}  {snippet}")
        return

    # Savings: unique source files minus the snippet chunks actually returned.
    _sem_file_rels = list(dict.fromkeys(h.file_rel for h in hits))
    _sem_file_total = _sum_file_sizes(proj.hash, _sem_file_rels)
    _sem_output_bytes = sum(len(h.text.encode()) for h in hits)
    _sem_bytes_saved = max(0, _sem_file_total - _sem_output_bytes)
    _record_lookup_stat(
        "semantic_search", query, len(hits), scope="project",
        project_hash=proj.hash,
        bytes_saved=_sem_bytes_saved,
    )

    if json_output:
        out = [
            {
                "file": h.file_rel,
                "start": h.start_line,
                "end": h.end_line,
                "kind": h.kind,
                "distance": h.distance,
                "preview": h.text[:200],
            }
            for h in hits
        ]
        typer.echo(json_compact(
            {"query": query, "results": out, "total": len(out)},
        ))
        return

    if not hits:
        typer.echo("(no results)")
        return

    if compact:
        for h in hits:
            # Show the first non-blank line as the snippet — it carries the
            # function/class/rule signature rather than a flat 100-char slice
            # of potentially mid-body text.  Falls back to a flat slice if the
            # first line is blank (rare, but guard-worthy).
            first_line = next(
                (ln.strip() for ln in h.text.splitlines() if ln.strip()),
                h.text.replace("\n", " ")[:120],
            )[:120]
            typer.echo(f"{h.file_rel}:{h.start_line} [{h.kind}]  {first_line}")
    else:
        for h in hits:
            preview = h.text.replace("\n", " ")[:120]
            typer.echo(
                f"{h.file_rel}:{h.start_line}-{h.end_line} ({h.kind}, d={h.distance:.4f})"
            )
            typer.echo(f"  {preview}")


@app.command("map", rich_help_panel="Core")
def cmd_map(
    budget: int = typer.Option(4000, "--budget", "-b", help="Approximate token budget"),
    json_output: bool = _OPT_JSON,
    fmt: str = typer.Option(
        "text",
        "--format",
        "-f",
        help="Output format: text (default), json, or mermaid.",
    ),
    compact: bool = typer.Option(
        False,
        "--compact",
        help="One line per file (no symbol detail). "
             "Auto-engages below ~300 token budget. Use to force on a larger budget.",
    ),
    full: bool = typer.Option(
        False,
        "--full",
        help="Restore the full per-file list even when --compact is active and the "
             "project exceeds the compact_file_threshold. Overrides the 1-line "
             "summary that compact mode emits for large projects.",
    ),
    top: int | None = typer.Option(
        None,
        "--top",
        help="Limit output to the top N most important files by PageRank score. "
             "Outputs in compact format: filename (rank: score). Overrides budget.",
    ),
    top_n: int = typer.Option(
        20,
        "--top-n",
        help="Number of top files to include in the mermaid diagram.",
    ),
    since: str | None = typer.Option(
        None,
        "--since",
        help=(
            "Show only files changed since this git ref (commit, branch, or tag). "
            "Example: --since HEAD~1, --since main, --since v1.0.0"
        ),
    ),
    filter_glob: str | None = typer.Option(
        None,
        "--filter",
        help=(
            "Limit output to files whose path matches this glob pattern. "
            "Example: --filter '*.py', --filter 'src/**/*.ts'. "
            "Applied after all other filtering."
        ),
    ),
    since_minutes: int | None = typer.Option(
        None,
        "--since-minutes",
        help=(
            "Show only files modified in the last N minutes (based on filesystem mtime). "
            "Example: --since-minutes 30. Useful for seeing what changed recently."
        ),
    ),
) -> None:
    """Generate a PageRank-ranked, token-budgeted overview of the current project.

    Formats: text (default), json, mermaid.  Use --format mermaid to emit a
    Mermaid graph TD diagram suitable for GitHub READMEs.

    Use --since <ref> to show only files changed since a git ref (branch,
    commit, tag).  Example: --since HEAD~1 or --since main.

    Use --filter GLOB to limit output to files matching a glob pattern.
    Use --since-minutes N to show only files modified in the last N minutes.
    """
    from . import repomap

    proj = _require_project(
        "no project detected (no .git, package.json, etc. found). "
        "Run from a project directory."
    )

    # --json flag is a legacy alias for --format json
    if json_output and fmt == "text":
        fmt = "json"

    _valid_formats = {"text", "json", "mermaid"}
    if fmt not in _valid_formats:
        _error(f"unknown format {fmt!r}. Choose one of: {', '.join(sorted(_valid_formats))}")
        raise typer.Exit(1)

    _LOG.info(
        "map start: project=%s budget=%d format=%s compact=%s full=%s top=%s since=%s filter=%s since_minutes=%s",
        proj.root.name, budget, fmt, compact, full, top, since, filter_glob, since_minutes,
    )
    t0 = time.monotonic()
    # Savings baseline: total indexed source bytes in the project.
    # Queried once outside each branch so all map modes share the same denominator.
    # Best-effort: _total_project_bytes returns 0 on any error.
    _map_proj_total = _total_project_bytes(proj.hash)

    try:
        # --top: show only top N files by PageRank
        if top is not None:
            if top <= 0:
                _error("--top must be a positive integer")
                raise typer.Exit(1)
            text = repomap.build_map(
                proj,
                budget_tokens=budget,
                top_n=top,
            )
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s top=%d dur=%.3fs", proj.root.name, top, elapsed)
            top_count = sum(1 for line in text.splitlines() if "rank:" in line)
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=top,top={top}",
                top_count,
                scope="project",
                project_hash=proj.hash,
                bytes_saved=max(0, _map_proj_total - len(text.encode())),
            )
            typer.echo(text)
            return

        # --since: show only changed files, regardless of format
        if since is not None:
            text = repomap.build_map_since(
                proj,
                since,
                budget_tokens=budget,
                compact=True if compact else None,
                full=full,
            )
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s since=%s dur=%.3fs", proj.root.name, since, elapsed)
            changed_lines = sum(1 for line in text.splitlines() if "[changed]" in line)
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=since,ref={since}",
                changed_lines,
                scope="project",
                project_hash=proj.hash,
                bytes_saved=max(0, _map_proj_total - len(text.encode())),
            )
            typer.echo(text)
            return

        # --since-minutes: show only files modified in the last N minutes by mtime
        if since_minutes is not None:
            if since_minutes <= 0:
                _error("--since-minutes must be a positive integer")
                raise typer.Exit(1)
            import fnmatch
            cutoff = time.time() - since_minutes * 60
            recent_files: list[str] = []
            with contextlib.suppress(Exception):
                for rel_path_str, _info in (repomap._load_and_rank(proj) or type("_empty", (), {"ranked": []})()).ranked:  # type: ignore[attr-defined]
                    abs_path = proj.root / rel_path_str
                    try:
                        mtime = abs_path.stat().st_mtime
                    except OSError:
                        continue
                    if mtime >= cutoff and (filter_glob is None or fnmatch.fnmatch(rel_path_str, filter_glob)):
                        recent_files.append(rel_path_str)
            elapsed = time.monotonic() - t0
            _LOG.info(
                "map complete: project=%s since_minutes=%d files=%d dur=%.3fs",
                proj.root.name, since_minutes, len(recent_files), elapsed,
            )
            header = (
                f"# {proj.root.name} — {len(recent_files)} file(s) modified in last {since_minutes}m"
            )
            if filter_glob:
                header += f" (filter: {filter_glob})"
            header += "\n"
            if recent_files:
                body = header + "".join(f"  {p}\n" for p in recent_files)
            else:
                body = header + "(no recently modified files found)\n"
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=since_minutes,minutes={since_minutes}",
                len(recent_files),
                scope="project",
                project_hash=proj.hash,
                bytes_saved=max(0, _map_proj_total - len(body.encode())),
            )
            typer.echo(body)
            return

        if fmt == "json":
            data = repomap.build_map_json(proj)
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s files=%d dur=%.3fs", proj.root.name, len(data), elapsed)
            _map_json_bytes = len(json_compact(data).encode())
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=json,compact={compact},full={full}",
                len(data),
                scope="project",
                project_hash=proj.hash,
                bytes_saved=max(0, _map_proj_total - _map_json_bytes),
            )
            typer.echo(json_compact(data))
            return

        if fmt == "mermaid":
            diagram = repomap.build_map_mermaid(proj, top_n=top_n)
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s format=mermaid dur=%.3fs", proj.root.name, elapsed)
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=mermaid,top_n={top_n}",
                top_n,
                scope="project",
                project_hash=proj.hash,
                bytes_saved=max(0, _map_proj_total - len(diagram.encode())),
            )
            typer.echo(diagram)
            return

        # Pass compact=True only if the user opted in; None lets build_map
        # auto-engage the compact path when the budget is below the threshold.
        text = repomap.build_map(
            proj,
            budget_tokens=budget,
            compact=True if compact else None,
            full=full,
        )

        # --filter GLOB: post-filter output lines to only include lines whose
        # path matches the glob pattern.  Lines without a recognizable path
        # (headers, blank lines, footers) are kept verbatim so the output
        # retains its structure.
        if filter_glob is not None:
            import fnmatch
            filtered_lines = []
            for ln in text.splitlines(keepends=True):
                stripped = ln.strip()
                # Keep non-file lines (headers start with #, blank lines, etc.)
                if not stripped or stripped.startswith(("#", "[token-goat")):
                    filtered_lines.append(ln)
                    continue
                # Extract relative path: first whitespace-delimited token on
                # file-entry lines (the path is always the first word).
                candidate = stripped.split()[0] if stripped.split() else ""
                if fnmatch.fnmatch(candidate, filter_glob):
                    filtered_lines.append(ln)
            text = "".join(filtered_lines)

        elapsed = time.monotonic() - t0
        _LOG.info("map complete: project=%s dur=%.3fs filter=%s", proj.root.name, elapsed, filter_glob)
        # Adoption telemetry: count map calls so token-goat stats can show
        # how often agents reach for the ranked overview instead of recursive
        # ls + multiple Reads.  result_count = number of file-entry lines
        # actually emitted (approximate, but stable across compact / full).
        file_lines = sum(1 for line in text.splitlines() if "[" in line)
        _record_lookup_stat(
            "map_lookup",
            f"budget={budget},mode=text,compact={compact},full={full},filter={filter_glob}",
            file_lines,
            scope="project",
            project_hash=proj.hash,
            bytes_saved=max(0, _map_proj_total - len(text.encode())),
        )
        typer.echo(text)
        # Active skills footer: append a brief "Active skills" section when the
        # current session has cached skills.  Appears after the repo overview
        # so agents orienting in a new codebase immediately see which skills
        # are loaded and recoverable.  Suppressed when there are no skills (the
        # typical case for a fresh session) to avoid cluttering the output.
        _map_skills_footer = _build_map_skills_footer()
        if _map_skills_footer:
            typer.echo(_map_skills_footer)
    except Exception as exc:
        _error(f"failed to build repo map: {exc}. Try `token-goat index --full` to rebuild the index.")
        raise typer.Exit(1) from None


def _build_map_skills_footer() -> str:
    """Build a brief 'Active skills' footer for ``token-goat map`` text output.

    Returns an empty string when no session exists or no skills are cached,
    so the caller can test with a simple truthiness check.  Failures are
    swallowed — a broken session cache must never abort the map command.

    Session resolution: uses the most-recently modified session that has
    cached skills (same heuristic as ``token-goat skill-list``), so the
    footer reflects the session the agent is currently running in without
    requiring an explicit ``--session-id`` argument on the map command.
    """
    try:
        from . import compact as _compact_mod
        from . import session as _session_mod
        from . import skill_cache as _sc

        # Find the most recent session that has skill entries.
        outputs = _sc.list_outputs()
        if not outputs:
            return ""
        first_oid = outputs[0].get("output_id", "")
        sid = first_oid[:16] if len(first_oid) >= 16 else first_oid
        if not sid:
            return ""

        skill_history = _session_mod.get_skill_history(sid)
        if not skill_history:
            return ""

        _session_started_ts = 0.0
        try:
            _cache = _session_mod.safe_load(sid)
            _session_started_ts = float(getattr(_cache, "started_ts", 0.0) or 0.0)
        except Exception:
            _LOG.debug("skill-sections: failed to load session timestamp for %s (using 0.0)", sid, exc_info=True)

        entries = _compact_mod._select_top_skill_entries(
            skill_history,
            session_started_ts=_session_started_ts,
        )
        if not entries:
            return ""

        skill_names = [
            getattr(e, "skill_name", "") for e in entries if getattr(e, "skill_name", "")
        ]
        if not skill_names:
            return ""

        lines = ["", "## Active skills"]
        for sname in skill_names:
            entry = skill_history.get(sname)
            run_count = getattr(entry, "run_count", 1) if entry else 1
            compact_note = ""
            try:
                ct = _sc.get_compact(sid, sname)
                if ct:
                    from .compact import estimate_tokens as _est
                    compact_note = f" (compact: ~{_est(ct)} tok)"
            except Exception:
                _LOG.debug("skill-sections: failed to get compact info for %r (skip)", sname, exc_info=True)
            run_note = f" ×{run_count}" if run_count > 1 else ""
            lines.append(f"- {sname}{run_note}{compact_note} — `token-goat skill-body {sname}`")
        return "\n".join(lines)
    except Exception:
        return ""


@app.command(rich_help_panel="Core")
def deps(
    file: str,
    json_output: bool = _OPT_JSON,
    depth: int = typer.Option(1, "--depth", "-d", help="Transitive depth (1=direct, 0=unlimited)"),
) -> None:
    """Show the dependency graph (imports and references) for a file.

    Lists all modules and symbols that the given file imports, depends on, or
    references. Use ``--depth`` to control transitive depth (1=direct imports,
    0=unlimited recursion)."""
    from . import read_commands

    read_commands.deps(file, json_output=json_output, depth=depth)


@app.command(rich_help_panel="Core")
def arch(
    json_output: bool = _OPT_JSON,
    top: int = typer.Option(10, "--top", "-n", help="Number of hub modules to show."),
) -> None:
    """Show a project-wide architecture summary: hubs, entry points, circular deps.

    Analyses the full import graph to identify the most-imported modules,
    files that are never imported (entry points), and circular dependency chains.
    Use ``--top`` to control how many hubs are listed."""
    from . import arch as _arch

    proj = _require_project()
    project_name = Path(proj.root).name
    result = _arch.build_arch(proj.hash, top_hubs=top)

    if json_output:
        typer.echo(_arch.format_arch_json(result, project_name))
    else:
        typer.echo(_arch.format_arch_text(result, project_name))


@app.command(rich_help_panel="Core")
def pack(
    patterns: list[str] = typer.Argument(  # noqa: B008
        None,
        help=(
            "File paths or glob patterns to include, e.g. 'src/auth/**' 'tests/*.py'. "
            "Omit to read newline-separated paths from stdin."
        ),
    ),
    style: str = typer.Option(
        "markdown",
        "--style",
        "-s",
        help="Output style: markdown (default), xml, or plain.",
    ),
    output: Path | None = typer.Option(  # noqa: B008
        None,
        "--output",
        "-o",
        help="Write output to this file instead of stdout.",
    ),
    line_numbers: bool = typer.Option(
        False,
        "--line-numbers",
        "-n",
        help="Prefix every line with its line number.",
    ),
    instruction_file: Path | None = typer.Option(  # noqa: B008
        None,
        "--instruction-file",
        "-i",
        help="Append this file's contents as an instructions section at the end.",
    ),
    no_ignore: bool = typer.Option(
        False,
        "--no-ignore",
        help="Skip .tokengoatignore patterns (include all matched files).",
    ),
    strip_comments: bool = typer.Option(
        False,
        "--strip-comments",
        help="Remove comments from source files before packing. Reduces token count by 15–40% on heavily commented code.",
    ),
    scan_secrets: bool = typer.Option(
        False,
        "--scan-secrets",
        help="Scan for credentials and secrets before emitting. Prints warnings and exits non-zero if any are found.",
    ),
    budget: int = typer.Option(
        0,
        "--budget",
        help=(
            "Fail if the total token estimate exceeds N. "
            "Exit code 3 when over budget. 0 = no limit (default)."
        ),
    ),
) -> None:
    """Bundle files into a single LLM-ready output with token estimates.

    Accepts glob patterns relative to the project root, or reads a
    newline-separated file list from stdin when no patterns are given
    (compatible with ``fd``, ``fzf``, ``find``, and similar tools).

    Per-file token estimates are shown in the manifest header.  Use
    ``token-goat budget`` to check costs before running pack.

    Output styles:

    * ``markdown`` — fenced code blocks with a manifest table (default)
    * ``xml`` — Anthropic-recommended ``<documents>`` format for long context
    * ``plain`` — separator lines with no markdown syntax

    Examples::

        token-goat pack "src/auth/**" "src/models.py"
        token-goat pack "src/**/*.py" --style xml --output context.xml
        token-goat pack --line-numbers "src/payments.py"
        fd -e py src/ | token-goat pack
        token-goat pack "src/**" --instruction-file AGENTS.md
        token-goat pack "src/**" --budget 50000
    """
    from . import pack as _pack
    from .parser import load_project_ignore_patterns

    proj = _require_project()
    project_root = proj.root

    ignore = [] if no_ignore else load_project_ignore_patterns(project_root)

    if not patterns:
        # No CLI patterns → read from stdin.
        if sys.stdin.isatty():
            _error(
                "No patterns given and stdin is a terminal.\n"
                "Usage: token-goat pack 'src/**/*.py'\n"
                "       fd -e py | token-goat pack"
            )
            raise typer.Exit(1)
        result = _pack.collect_from_stdin(
            project_root,
            ignore_patterns=ignore or None,
            do_strip_comments=strip_comments,
        )
    else:
        result = _pack.collect_files(
            project_root,
            list(patterns),
            ignore_patterns=ignore or None,
            do_strip_comments=strip_comments,
        )

    if not result.files:
        msg = "No files matched"
        if result.skipped:
            msg += f" ({len(result.skipped)} skipped)"
        _error(msg + ".")
        raise typer.Exit(1)

    if budget < 0:
        _error("--budget must be a positive integer.")
        raise typer.Exit(1)
    if budget and result.total_tokens > budget:
        typer.echo(
            f"Over budget: {result.total_tokens:,} tokens > {budget:,} limit "
            f"({len(result.files)} files).",
            err=True,
        )
        raise typer.Exit(3)

    if scan_secrets:
        hits = _pack.scan_secrets(result.files)
        if hits:
            typer.echo("Warning: potential secrets found in pack output:", err=True)
            for h in hits:
                typer.echo(f"  {h.rel_path}:{h.line}  [{h.kind}]  {h.snippet}", err=True)
            typer.echo(
                f"\n{len(hits)} issue(s) found. Add affected files to .tokengoatignore or remove secrets before packing.",
                err=True,
            )
            raise typer.Exit(2)

    if style not in ("markdown", "xml", "plain"):
        _error(f"Unknown style {style!r}. Choose from: markdown, xml, plain.")
        raise typer.Exit(1)

    instruction: str | None = None
    if instruction_file:
        try:
            instruction = instruction_file.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            _error(f"Cannot read instruction file: {exc}")
            raise typer.Exit(1) from None

    text = _pack.format_pack(result, style, line_numbers=line_numbers, instruction=instruction)

    if output:
        try:
            output.write_text(text, encoding="utf-8")
            n = len(result.files)
            noun = "file" if n == 1 else "files"
            note = " (comments stripped)" if strip_comments else ""
            typer.echo(
                f"Packed {n} {noun} (~{result.total_tokens:,} tokens){note} → {output}",
                err=True,
            )
        except OSError as exc:
            _error(f"Cannot write output: {exc}")
            raise typer.Exit(1) from None
    else:
        typer.echo(text, nl=False)


@app.command(rich_help_panel="Core")
def budget(
    patterns: list[str] = typer.Argument(  # noqa: B008
        None,
        help="File paths or glob patterns, e.g. 'src/**' 'tests/*.py'.",
    ),
    context_k: int = typer.Option(
        0,
        "--context",
        "-c",
        help="Context window in thousands of tokens (e.g. 200 for 200K). Shows usage percentage.",
    ),
    json_output: bool = _OPT_JSON,
    no_ignore: bool = typer.Option(
        False,
        "--no-ignore",
        help="Skip .tokengoatignore patterns.",
    ),
) -> None:
    """Estimate token cost of files before reading them.

    Shows a table of each matched file with its line count and approximate
    token count, sorted by cost (most expensive first).  Use this before
    ``token-goat pack`` or a batch read to decide whether the payload fits
    within your context window.

    Token estimates are rough (characters ÷ 4) — accurate to within ~10% for
    typical source code.

    Examples::

        token-goat budget "src/**"
        token-goat budget "src/auth.py" "tests/" --context 200
        token-goat budget "src/**/*.py" --json
    """
    from . import pack as _pack
    from .parser import load_project_ignore_patterns

    proj = _require_project()
    project_root = proj.root

    ignore = [] if no_ignore else load_project_ignore_patterns(project_root)
    _patterns = list(patterns) if patterns else ["."]

    result = _pack.estimate_budget(project_root, _patterns, ignore_patterns=ignore or None)

    if json_output:
        import json as _json

        _json_output = {
            "total_tokens": result.total_tokens,
            "total_lines": result.total_lines,
            "files": [
                {
                    "file": e.rel_path,
                    "lines": e.lines,
                    "tokens": e.tokens,
                    "size_bytes": e.size_bytes,
                }
                for e in result.entries
            ],
            "skipped": result.skipped,
        }
        typer.echo(_json.dumps(_json_output, indent=2))
    else:
        cw = context_k or None
        typer.echo(_pack.format_budget_text(result, context_k=cw))


@app.command(rich_help_panel="Core")
def tokens(
    patterns: list[str] = typer.Argument(  # noqa: B008
        None,
        help="File paths or glob patterns. Omit to scan the entire project.",
    ),
    top: int = typer.Option(
        0,
        "--top",
        "-n",
        help="Show only the N largest files. 0 = show all.",
    ),
    tree: bool = typer.Option(
        False,
        "--tree",
        "-t",
        help="Show a directory tree with per-directory token subtotals.",
    ),
    asc: bool = typer.Option(
        False,
        "--asc",
        help="Sort ascending (smallest first).",
    ),
    json_output: bool = _OPT_JSON,
    no_ignore: bool = typer.Option(
        False,
        "--no-ignore",
        help="Skip .tokengoatignore patterns.",
    ),
) -> None:
    """Show token footprint by file, sorted by cost.

    Estimates how many tokens each file would consume in a context window
    (characters ÷ 3 + 1).  Use this to find which files dominate your
    token budget before deciding what to include or exclude.

    With ``--tree``, rolls up token counts per directory so you can see
    which subtrees are most expensive at a glance.

    Examples::

        token-goat tokens
        token-goat tokens "src/**"
        token-goat tokens --top 20
        token-goat tokens --tree
        token-goat tokens "src/**" --top 10 --json
    """
    import json as _json
    from collections import defaultdict

    from . import pack as _pack
    from .parser import load_project_ignore_patterns

    proj = _require_project()
    project_root = proj.root

    ignore = [] if no_ignore else load_project_ignore_patterns(project_root)
    _patterns = list(patterns) if patterns else ["."]

    result = _pack.estimate_budget(
        project_root,
        _patterns,
        ignore_patterns=ignore or None,
        max_file_bytes=100 * 1024 * 1024,
    )

    entries = list(result.entries)
    if not entries and not result.skipped:
        typer.echo("No files found.", err=True)
        raise typer.Exit(0)

    if asc:
        entries.sort(key=lambda e: e.tokens)
    # estimate_budget already sorts descending — keep that as default

    if top and top > 0:
        entries = entries[:top]

    if json_output:
        typer.echo(
            _json.dumps(
                {
                    "total_tokens": result.total_tokens,
                    "total_files": len(result.entries),
                    "files": [
                        {"file": e.rel_path, "tokens": e.tokens, "lines": e.lines}
                        for e in entries
                    ],
                    "skipped": result.skipped,
                },
                indent=2,
            )
        )
        return

    if tree:
        # Build directory subtotals from the *full* result (not truncated list)
        dir_tokens: dict[str, int] = defaultdict(int)
        dir_files: dict[str, list[_pack.BudgetEntry]] = defaultdict(list)
        for e in result.entries:
            parent = str(Path(e.rel_path).parent)
            dir_tokens[parent] += e.tokens
            dir_files[parent].append(e)

        dirs_sorted = sorted(dir_tokens.items(), key=lambda x: x[1], reverse=not asc)

        lines: list[str] = []
        grand = result.total_tokens
        for dir_name, dtok in dirs_sorted:
            pct = (dtok / grand * 100) if grand else 0
            lines.append(f"{dir_name}/  {dtok:>9,} tok  ({pct:.1f}%)")
            for fe in sorted(dir_files[dir_name], key=lambda e: e.tokens, reverse=not asc):
                name = Path(fe.rel_path).name
                lines.append(f"  {name:<48} {fe.tokens:>8,} tok")

        lines.append("")
        lines.append(f"Total: {grand:,} tokens across {len(result.entries)} files")
        if result.skipped:
            lines.append(f"Skipped: {len(result.skipped)} files")
        typer.echo("\n".join(lines))
        return

    # Flat list
    col = max((len(e.rel_path) for e in entries), default=4)
    col = min(col, 60)
    header = f"{'File':<{col}}  {'Tokens':>9}  {'Lines':>7}"
    typer.echo(header)
    typer.echo("-" * len(header))
    for e in entries:
        name = e.rel_path if len(e.rel_path) <= col else "…" + e.rel_path[-(col - 1):]
        typer.echo(f"{name:<{col}}  {e.tokens:>9,}  {e.lines:>7,}")
    typer.echo("-" * len(header))
    shown = sum(e.tokens for e in entries)
    typer.echo(f"{'Total shown':<{col}}  {shown:>9,}  {sum(e.lines for e in entries):>7,}")
    if len(entries) < len(result.entries):
        typer.echo(
            f"(showing {len(entries)} of {len(result.entries)} files"
            f", {result.total_tokens:,} tokens total)"
        )
    if result.skipped:
        typer.echo(f"Skipped: {len(result.skipped)} files")


@app.command(rich_help_panel="Core")
def note(
    action: str = typer.Argument(  # noqa: B008
        ...,
        help="Subcommand: set, get, unset, list, clear.",
    ),
    key: str | None = typer.Argument(  # noqa: B008
        None,
        help="Note key (alphanumeric, hyphens, underscores; max 80 chars). Required for set/get/unset.",
    ),
    value: str | None = typer.Argument(  # noqa: B008
        None,
        help="Note value. Required for 'set'.",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Manage persistent per-project notes that survive conversation compaction.

    Notes are short text facts that token-goat injects into the context at
    session start. Use them to pin decisions, reminders, or constraints that
    must not be forgotten when the conversation window rolls over.

    Subcommands:

      set KEY VALUE   Store a note under KEY.
      get KEY         Print the value stored at KEY.
      unset KEY       Remove the note at KEY.
      list            Show all notes for this project.
      clear           Delete every note for this project.

    Keys may contain letters, digits, hyphens, and underscores (max 80 chars).
    Values have no length restriction in storage, but very long values are
    truncated at session-start injection.

    Examples::

        token-goat note set auth-backend "use Supabase JWT, not sessions"
        token-goat note list
        token-goat note unset auth-backend
    """
    import json as _json  # noqa: PLC0415

    from . import project_memory as _pm

    proj = _require_project()
    project_hash = proj.hash

    action = action.lower().strip()

    if action == "set":
        if not key:
            _error("'set' requires a KEY argument.")
            raise typer.Exit(1)
        if value is None:
            _error("'set' requires a VALUE argument.")
            raise typer.Exit(1)
        try:
            _pm.set_entry(project_hash, key, value)
        except ValueError as exc:
            _error(str(exc))
            raise typer.Exit(1) from None
        typer.echo(f"Note set: {key}")

    elif action == "get":
        if not key:
            _error("'get' requires a KEY argument.")
            raise typer.Exit(1)
        entries = _pm.load_entries(project_hash)
        if key not in entries:
            _error(f"No note found for key: {key!r}")
            raise typer.Exit(1)
        typer.echo(entries[key])

    elif action == "unset":
        if not key:
            _error("'unset' requires a KEY argument.")
            raise typer.Exit(1)
        try:
            _pm.unset_entry(project_hash, key)
        except ValueError as exc:
            _error(str(exc))
            raise typer.Exit(1) from None
        typer.echo(f"Note removed: {key}")

    elif action == "list":
        entries = _pm.load_entries(project_hash)
        if json_output:
            typer.echo(_json.dumps(entries, indent=2))
            return
        if not entries:
            typer.echo("No notes stored for this project.")
            return
        max_k = max(len(k) for k in entries)
        for k, v in sorted(entries.items()):
            display = v if len(v) <= 80 else v[:77] + "..."
            typer.echo(f"  {k:<{max_k}}  {display}")

    elif action == "clear":
        _pm.clear_all(project_hash)
        typer.echo("All notes cleared.")

    else:
        _error(f"Unknown subcommand {action!r}. Choose from: set, get, unset, list, clear.")
        raise typer.Exit(1)


@app.command(rich_help_panel="Core")
def failures(
    src: str = typer.Argument(  # noqa: B008
        "-",
        help="File to read. Use '-' (default) to read from stdin.",
    ),
    runner: str = typer.Option(
        "",
        "--runner",
        "-r",
        help="Force a specific runner: pytest, jest, go, cargo. Auto-detected by default.",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Extract failing test blocks from test runner output.

    Reads test output from stdin (default) or a file and prints only the
    failure blocks, stripping passing-test noise.  Auto-detects the test
    runner (pytest, jest, go test, cargo test).

    Examples::

        uv run pytest 2>&1 | token-goat failures
        token-goat failures pytest.log
        token-goat failures --runner jest jest.log --json
    """
    import sys
    from pathlib import Path as _Path

    from . import failures as _failures

    if src == "-":
        text = sys.stdin.read()
    else:
        p = _Path(src)
        if not p.exists():
            typer.echo(f"File not found: {src}", err=True)
            raise typer.Exit(1)
        text = p.read_text(encoding="utf-8", errors="replace")

    result = _failures.extract_failures(text, runner=runner or None)

    if json_output:
        typer.echo(_failures.format_failures_json(result))
    else:
        typer.echo(_failures.format_failures_text(result))


@app.command(rich_help_panel="Core")
def trace(
    src: str = typer.Argument(  # noqa: B008
        "-",
        help="File to read. Use '-' (default) to read from stdin.",
    ),
    keep: int = typer.Option(
        5,
        "--keep",
        "-k",
        help="Maximum number of project-owned frames to keep per exception block.",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Condense an exception traceback to project-owned frames.

    Strips library, stdlib, and virtual-environment frames and keeps only
    the frames that point into your own code.  Useful for pasting a large
    traceback into a prompt without spending tokens on unactionable frames.

    Examples::

        cat error.log | token-goat trace
        token-goat trace --keep 3 error.log
        python script.py 2>&1 | token-goat trace --json
    """
    import sys
    from pathlib import Path as _Path

    from . import trace as _trace

    if src == "-":
        text = sys.stdin.read()
    else:
        p = _Path(src)
        if not p.exists():
            typer.echo(f"File not found: {src}", err=True)
            raise typer.Exit(1)
        text = p.read_text(encoding="utf-8", errors="replace")

    result = _trace.condense_trace(text, keep_frames=keep)

    if json_output:
        typer.echo(_trace.format_trace_json(result))
    else:
        typer.echo(_trace.format_trace_text(result))


@app.command(rich_help_panel="Core")
def lockdeps(
    path: str = typer.Argument(  # noqa: B008
        "",
        help=(
            "Path to a lock file or dependency spec.  Omit to auto-discover "
            "(poetry.lock, uv.lock, package-lock.json, requirements.txt, Cargo.lock, Pipfile.lock)."
        ),
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Summarize a lock file as a compact dependency table.

    Reads poetry.lock, uv.lock, package-lock.json, requirements.txt,
    Cargo.lock, Pipfile.lock, or yarn.lock and emits a trimmed table of
    package names and resolved versions — no transitive-dep noise.

    When no path is given, the command looks for a supported lock file in
    the current directory.

    Examples::

        token-goat lockdeps
        token-goat lockdeps poetry.lock
        token-goat lockdeps package-lock.json --json
    """
    from pathlib import Path as _Path

    from . import lockdeps as _lockdeps

    _CANDIDATES = [
        "poetry.lock",
        "uv.lock",
        "package-lock.json",
        "Cargo.lock",
        "Pipfile.lock",
        "yarn.lock",
        "requirements.txt",
    ]

    if path:
        lock_path = _Path(path)
        if not lock_path.exists():
            typer.echo(f"File not found: {path}", err=True)
            raise typer.Exit(1)
    else:
        cwd = _Path.cwd()
        _found: _Path | None = next((cwd / c for c in _CANDIDATES if (cwd / c).exists()), None)
        if _found is None:
            typer.echo("No supported lock file found in the current directory.", err=True)
            raise typer.Exit(1)
        lock_path = _found

    result = _lockdeps.summarize_lockfile(lock_path)

    if json_output:
        typer.echo(_lockdeps.format_lockdeps_json(result))
    else:
        typer.echo(_lockdeps.format_lockdeps_text(result))


@app.command(rich_help_panel="Core")
def logfold(
    src: str = typer.Argument(  # noqa: B008
        "-",
        help="File to read. Use '-' (default) to read from stdin.",
    ),
    tail: int = typer.Option(
        0,
        "--tail",
        "-n",
        help="Keep only the last N output lines after folding. 0 = no limit.",
    ),
    no_normalize: bool = typer.Option(
        False,
        "--no-normalize",
        help="Disable timestamp/UUID normalization; collapse only exact duplicates.",
    ),
) -> None:
    """Collapse repeated log lines to reduce noise before pasting into a prompt.

    Consecutive identical lines are folded to ``[Nx] <line>``.  Lines that
    differ only in timestamps, UUIDs, or numeric values (request durations,
    byte counts) are treated as duplicates and also folded.

    Examples::

        tail -f app.log | token-goat logfold
        token-goat logfold --tail 100 app.log
        token-goat logfold --no-normalize deploy.log
    """
    import sys
    from pathlib import Path as _Path

    from . import logfold as _logfold

    if src == "-":
        text = sys.stdin.read()
    else:
        p = _Path(src)
        if not p.exists():
            typer.echo(f"File not found: {src}", err=True)
            raise typer.Exit(1)
        text = p.read_text(encoding="utf-8", errors="replace")

    result = _logfold.fold_log(text, normalize=not no_normalize, tail=tail or None)
    typer.echo(_logfold.format_fold_text(result))


@app.command(rich_help_panel="Core")
def read(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'parser.py::index_project' or 'auth.py::Session.refresh' for a qualified method."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    context_lines: int = _OPT_CONTEXT_LINES,
    full: bool = typer.Option(False, "--full", "-f", help="Return the complete symbol body without smart truncation (bypasses the 60-line threshold)."),
) -> None:
    """Read just <symbol> from <file>, not the whole file.

    Long symbol bodies (> 60 lines) are smart-truncated by default.  Pass
    ``--full`` (``-f``) to bypass truncation and return the complete body.
    """
    from . import read_commands

    if session_id:
        _validate_session_id(session_id)

    read_commands.read(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        full=full,
    )


@app.command(rich_help_panel="Core")
def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'. Append #N to disambiguate duplicate headings, e.g. 'doc.md::Setup#2'."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    context_lines: int = _OPT_CONTEXT_LINES,
) -> None:
    """Extract just <heading> section from <file>, not the whole file."""
    from . import read_commands

    if session_id:
        _validate_session_id(session_id)

    read_commands.section(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
    )


@app.command("skill-section", rich_help_panel="Core")
def cmd_skill_section(
    skill_name: str = typer.Argument(..., help="Skill name (e.g. 'ralph', 'plugin:improve')."),
    heading: str = typer.Argument(..., help="Section heading to extract (case-insensitive prefix match)."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    context_lines: int = _OPT_CONTEXT_LINES,
) -> None:
    """Extract a named section from an installed skill file without reading the whole thing.

    Resolves *skill_name* to its on-disk SKILL.md (checking the skill body
    cache first, then ``~/.claude/skills/<name>/SKILL.md`` and plugin install
    locations).  Then extracts the heading section exactly like
    ``token-goat section``.

    Enables skills to self-reference by short name without hardcoded paths::

        token-goat skill-section ralph "Definition of Done"
        token-goat skill-section plugin:improve "Step 4"
    """
    from . import read_commands

    if session_id:
        _validate_session_id(session_id)

    read_commands.skill_section(
        skill_name=skill_name,
        heading=heading,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
    )


@app.command("skeleton", rich_help_panel="Core")
def skeleton(
    file: str = typer.Argument(..., help="File to show signatures for"),
    json_output: bool = _OPT_JSON,
    include_private: bool = typer.Option(False, "--private", "-p", help="Include _private names"),
) -> None:
    """Show all signatures in <file> without bodies — typically 70-90% fewer tokens."""
    from . import read_commands

    read_commands.stub_view(file, json_output=json_output, include_private=include_private)


@app.command("outline", rich_help_panel="Core")
def outline(
    file: str = typer.Argument(..., help="File to outline — e.g., 'src/token_goat/hints.py'"),
    json_output: bool = _OPT_JSON,
    max_depth: int = typer.Option(
        0,
        "--max-depth",
        "-d",
        help="Maximum nesting depth to include (0 = top-level only; 1 = also methods/nested classes, etc.).",
        min=0,
    ),
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress the '# Outline:' header line. Results only."),
    min_lines: int = typer.Option(
        0,
        "--min-lines",
        help="Only show symbols whose body spans at least N lines. Useful for finding large functions. Default 0 (no filter).",
        min=0,
    ),
) -> None:
    """List symbols in <file> with line ranges, line counts, and docstring hints.

    Returns a compact structured list: kind, name, line range, line count, and
    the first line of each symbol's docstring.  Body text is omitted, so the
    output is typically ~5% of the cost of reading the full file.

    Use --max-depth N to also show symbols nested N levels deep.
    Use --min-lines N to show only symbols with at least N lines (find large functions).
    Use ``token-goat read <file>::<symbol>`` to retrieve any symbol body.
    """
    from . import read_commands

    read_commands.outline(file, json_output=json_output, max_depth=max_depth, quiet=quiet, min_lines=min_lines)


@app.command("exports", rich_help_panel="Core")
def cmd_exports(
    file: str = typer.Argument(..., help="File to inspect — e.g., 'src/token_goat/hints.py'"),
    json_output: bool = _OPT_JSON,
) -> None:
    """List public (exported) symbols from <file> with types and docstring hints.

    Shows every top-level symbol whose name does not start with ``_``.
    If the file defines ``__all__``, only names listed there are shown.

    Use ``token-goat read <file>::<symbol>`` to retrieve any symbol body.
    """
    from . import read_commands

    read_commands.exports(file, json_output=json_output)


@app.command("scope", rich_help_panel="Core")
def scope(
    target: str = typer.Argument(
        ...,
        help="<file>:<line> — e.g., 'src/token_goat/hints.py:42'",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show symbols in scope at <file>:<line>.

    Returns the enclosing function/class chain, module-level imports, and a
    suggested ``token-goat read`` command for the innermost enclosing function.
    Useful for understanding what names are visible at a specific line without
    reading the whole file.
    """
    from . import read_commands

    read_commands.scope(target, json_output=json_output)


@app.command("changed", rich_help_panel="Core")
def cmd_changed(
    since: str = typer.Option("HEAD~5", "--since", help="Git ref to compare against (commit, branch, tag). Default: HEAD~5."),
    json_output: bool = _OPT_JSON,
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress count/summary lines. Results only."),
    limit: int = typer.Option(50, "--limit", help="Maximum number of symbol entries to return."),
    symbol_mode: bool = typer.Option(False, "--symbol", help="Use the DB index to find symbols that overlap changed line ranges (more reliable than git hunk context). Output grouped by file."),
) -> None:
    """List symbols that changed since a git ref — replaces full diff reads.

    Parses ``git diff --unified=0 <since>..HEAD`` hunk headers to extract the
    function or class name git associates with each changed hunk.  Results are
    deduplicated by (file, symbol) and line counts are summed across multiple
    hunks touching the same symbol.

    Use ``--symbol`` to query the tree-sitter DB instead of git hunk context
    for more reliable symbol identification — output is grouped by file:
    ``src/auth.py: login(), logout() — 2 symbols changed``.

    Examples::

        token-goat changed
        token-goat changed --since HEAD~10
        token-goat changed --since main --json
        token-goat changed --symbol
        token-goat changed --symbol --since HEAD~3 --json
    """
    from . import read_commands

    read_commands.changed(since_ref=since, json_output=json_output, limit=limit, symbol_mode=symbol_mode, quiet=quiet)


@app.command("blame", rich_help_panel="Core")
def cmd_blame(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'src/auth.py::login'"),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show git blame for the lines of a specific symbol — no whole-file blame needed.

    Resolves *symbol* to its line range from the index, then runs
    ``git blame -L start,end`` on those lines only.

    Output format (text)::

        a1b2c3d4 (Author Name 2026-01-15) 42: def my_function():
        a1b2c3d4 (Author Name 2026-01-15) 43:     pass

    Output format (JSON)::

        {"file": "...", "symbol": "...", "start_line": N, "end_line": N,
         "lines": [{"line_no": N, "commit_hash": "...", "author": "...",
                    "date": "YYYY-MM-DD", "content": "..."}, ...]}

    Examples::

        token-goat blame src/token_goat/hints.py::build_hint
        token-goat blame git_history.py::blame_symbol --json
    """
    from . import read_commands

    read_commands.blame(target, json_output=json_output)


@app.command("recent", rich_help_panel="Core")
def cmd_recent(
    n: int = typer.Option(10, "--n", help="Number of files to show."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
) -> None:
    """Show the N most recently edited/accessed files (session + git commits) with their symbols.

    Merges three sources in priority order: session-edited files (highest priority),
    session-read files (marked "read this session" — already in context), then files
    from recent git commits.  Deduplicates by path and shows the symbol names touched
    in each file.

    Examples::

        token-goat recent
        token-goat recent --n 5
        token-goat recent --session-id <id> --json
    """
    from . import read_commands

    read_commands.recent(n=n, session_id=session_id, json_output=json_output)


@app.command("find", rich_help_panel="Core")
def cmd_find(
    query: str = typer.Argument(..., help="Search term — name, keyword, or natural-language phrase."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Unified search: symbol (exact/fuzzy) + semantic, merged and ranked.

    Runs both search strategies in the current project and presents results
    in two sections: exact/fuzzy name matches first, then semantically
    similar code that did not already appear above.

    Examples::

        token-goat find login
        token-goat find "rate limit retry"
        token-goat find build_manifest --json
    """
    from . import read_commands

    read_commands.find(query=query, json_output=json_output)


@app.command("similar", rich_help_panel="Core")
def cmd_similar(
    target: str = typer.Argument(
        ...,
        help="Symbol to compare — 'file::symbol', e.g. 'src/auth.py::login'.",
    ),
    k: int = typer.Option(5, "-k", help="Number of similar symbols to return."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Find the top-k symbols most semantically similar to <file>::<symbol>.

    Uses sqlite-vec embeddings to locate symbols whose implementation is
    semantically close to the query symbol.  The query symbol itself is
    excluded from the results.

    Examples::

        token-goat similar src/token_goat/embeddings.py::semantic_search
        token-goat similar src/auth.py::login -k 3
        token-goat similar src/token_goat/hints.py::build_hint --json
    """
    from . import read_commands

    read_commands.similar(target, json_output=json_output, top_k=k)


@app.command("test-for", rich_help_panel="Core")
def cmd_test_for(
    file: str = typer.Argument(..., help="Implementation file — e.g., 'src/token_goat/read_commands.py'"),
    json_output: bool = _OPT_JSON,
) -> None:
    """Find test file(s) for an implementation file and list their test functions.

    Searches by convention (``tests/test_{module}.py``), sibling layout, and
    import references.  For each test file found, lists top-level ``test_*``
    functions.

    Examples::

        token-goat test-for src/token_goat/read_commands.py
        token-goat test-for hints.py --json
    """
    from . import read_commands

    read_commands.test_for(file, json_output=json_output)


@app.command("dead", rich_help_panel="Core")
def cmd_dead(
    kinds: list[str] = typer.Option(  # noqa: B008
        ["function", "method", "async_function", "class"],
        "--kind",
        "-k",
        help="Symbol kinds to check (can be repeated).",
    ),
    include_private: bool = typer.Option(
        False,
        "--include-private",
        help="Include symbols whose names start with an underscore.",
    ),
    top: int = typer.Option(
        0,
        "--top",
        "-n",
        help="Show only the first N results. 0 = show all.",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """List symbols with no known callers or references in the project.

    Queries the indexed symbol and reference tables for definitions that do not
    appear in any call-site record.  Results are heuristic: dynamic dispatch,
    reflection, and external callers are not visible to static indexing.
    Conventional entry-point names (main, setup, conftest) are excluded.

    Use this to surface dead-code candidates or to find functions that have no
    tests and may need them before removal is safe.

    Examples::

        token-goat dead
        token-goat dead --kind function --kind method
        token-goat dead --include-private
        token-goat dead --top 20 --json
    """
    import json as _json

    SKIP_NAMES: frozenset[str] = frozenset({
        "main", "__main__", "setup", "teardown", "conftest",
        "pytest_configure", "pytest_collection_modifyitems",
        "app", "create_app", "application",
    })

    proj = _require_project()

    kinds_placeholders = ",".join("?" * len(kinds))
    private_clause = "" if include_private else "AND s.name NOT GLOB '_*'"

    rows = _query_project(
        proj.hash,
        f"""
        SELECT s.name, s.kind, s.file_rel, s.line
        FROM symbols s
        WHERE s.kind IN ({kinds_placeholders})
          {private_clause}
          AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.symbol_name = s.name)
        ORDER BY s.file_rel, s.line
        """,
        tuple(kinds),
    )

    results = [r for r in rows if r["name"] not in SKIP_NAMES]
    if top > 0:
        results = results[:top]

    if json_output:
        typer.echo(
            _json.dumps(
                [
                    {
                        "name": r["name"],
                        "kind": r["kind"],
                        "file": r["file_rel"],
                        "line": r["line"],
                    }
                    for r in results
                ],
                indent=2,
            )
        )
        return

    if not results:
        typer.echo("No unreferenced symbols found.")
        return

    typer.echo(f"Unreferenced symbols ({len(results)} found):\n")
    current_file: str | None = None
    for r in results:
        if r["file_rel"] != current_file:
            current_file = r["file_rel"]
            typer.echo(f"  {current_file}")
        typer.echo(f"    line {r['line']:>5}  {r['kind']:<18}  {r['name']}")
    typer.echo("\nNote: dynamic dispatch and external callers are not visible to static indexing.")


@app.command("coverage-gaps", rich_help_panel="Core")
def cmd_coverage_gaps(
    top: int = typer.Option(
        0,
        "--top",
        "-n",
        help="Show only the first N results. 0 = show all.",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Find functions and methods that no test file references.

    Searches indexed callables in non-test source files for names that do not
    appear in any test file's reference records.  Results are a starting point:
    a function may be exercised through integration tests or may be a private
    helper intentionally without direct coverage.

    Examples::

        token-goat coverage-gaps
        token-goat coverage-gaps --top 30
        token-goat coverage-gaps --json
    """
    import json as _json

    CALLABLE_KINDS = ("function", "async_function", "method", "constructor")
    kinds_placeholders = ",".join("?" * len(CALLABLE_KINDS))

    proj = _require_project()

    rows = _query_project(
        proj.hash,
        f"""
        SELECT s.name, s.kind, s.file_rel, s.line
        FROM symbols s
        WHERE s.kind IN ({kinds_placeholders})
          AND s.file_rel NOT GLOB '*/test_*'
          AND s.file_rel NOT GLOB 'test_*'
          AND s.name NOT GLOB '_*'
          AND NOT EXISTS (
              SELECT 1 FROM refs r
              WHERE r.symbol_name = s.name
                AND (r.file_rel GLOB '*/test_*' OR r.file_rel GLOB 'test_*')
          )
        ORDER BY s.file_rel, s.line
        """,
        CALLABLE_KINDS,
    )

    results = list(rows)
    if top > 0:
        results = results[:top]

    if json_output:
        typer.echo(
            _json.dumps(
                [
                    {
                        "name": r["name"],
                        "kind": r["kind"],
                        "file": r["file_rel"],
                        "line": r["line"],
                    }
                    for r in results
                ],
                indent=2,
            )
        )
        return

    if not results:
        typer.echo("All indexed callables have test references.")
        return

    typer.echo(f"Functions with no test references ({len(results)} found):\n")
    current_file: str | None = None
    for r in results:
        if r["file_rel"] != current_file:
            current_file = r["file_rel"]
            typer.echo(f"  {current_file}")
        typer.echo(f"    line {r['line']:>5}  {r['kind']:<18}  {r['name']}")
    typer.echo("\nNote: indirect coverage through integration tests is not visible to reference scanning.")


@app.command("types", rich_help_panel="Core")
def cmd_types(
    file: str | None = typer.Argument(None, help="File to inspect — e.g., 'src/token_goat/db.py'. Omit for project-wide search."),
    json_output: bool = _OPT_JSON,
) -> None:
    """List type definitions (TypedDict, Protocol, dataclass, namedtuple, Pydantic) in a file or project.

    Detects Python type-like constructs by inspecting class base classes and
    decorators.  For each type found, lists its annotated field names.

    Examples::

        token-goat types src/token_goat/db.py
        token-goat types
        token-goat types src/token_goat/read_commands.py --json
    """
    from . import read_commands

    read_commands.types(file, json_output=json_output)


@app.command("imports", rich_help_panel="Core")
def cmd_imports(
    file: str = typer.Argument(..., help="File to inspect — e.g., 'src/token_goat/db.py'"),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show the import graph for <file> one level deep.

    Two sections are emitted:

    - **Imports from** — project-internal files that this file imports.
    - **Imported by** — project-internal files that import this file.

    Only relative and intra-package imports are included; stdlib / third-party
    imports are excluded because they have no indexed ``file_rel``.

    Examples::

        token-goat imports src/token_goat/db.py
        token-goat imports read_commands.py --json
    """
    from . import read_commands

    read_commands.imports(file, json_output=json_output)


@app.command("grep", rich_help_panel="Core")
def cmd_grep(
    pattern: str = typer.Argument(..., help="Regex pattern to search for (forwarded to rg)"),
    path: str = typer.Argument(".", help="Directory or file to search (default: current directory)"),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
) -> None:
    """Session-aware grep: run rg and cache results within the session.

    On the first call, runs ``rg {pattern} {path}`` and records the result hash
    in the session.  On subsequent calls with the same pattern + path, if the
    results are identical (same content hash), emits the output with a
    ``⚡ Cached grep result (session hit)`` hint so you know the results haven't
    changed since the last search.

    Output is compressed to at most 200 lines: first 100 lines, then
    ``... N more lines ...``, then last 20 lines.

    Examples::

        token-goat grep "def build_hint" src/token_goat/
        token-goat grep "TODO" . --session-id abc123
        token-goat grep "pattern" --json
    """
    from . import read_commands

    read_commands.grep(pattern, path, session_id=session_id, json_output=json_output)


@app.command("memory", rich_help_panel="Core")
def memory_cmd(
    action: str = typer.Argument(..., help="show | set | unset | clear"),
    key: str | None = typer.Argument(None, help="Memory key (required for set/unset)"),
    value: str | None = typer.Argument(None, help="Memory value (required for set)"),
    project_dir: str | None = typer.Option(None, "--project", "-p", help="Project root (default: cwd)"),
) -> None:
    """Manage persistent per-project memory facts injected at session start."""
    import os
    from pathlib import Path

    from . import project_memory
    from .project import find_project

    root = Path(project_dir) if project_dir else Path(os.getcwd())
    proj = find_project(root)
    if proj is None:
        typer.echo("Not in an indexed project root.", err=True)
        raise typer.Exit(1)

    if action == "show":
        entries = project_memory.load_entries(proj.hash)
        if not entries:
            typer.echo("(no memory entries)")
        else:
            for k, v in sorted(entries.items()):
                typer.echo(f"{k}: {v}")
    elif action == "set":
        if not key or value is None:
            typer.echo("Usage: memory set <key> <value>", err=True)
            raise typer.Exit(1)
        project_memory.set_entry(proj.hash, key, value)
        typer.echo(f"Set {key!r}")
    elif action == "unset":
        if not key:
            typer.echo("Usage: memory unset <key>", err=True)
            raise typer.Exit(1)
        project_memory.unset_entry(proj.hash, key)
        typer.echo(f"Removed {key!r}")
    elif action == "clear":
        project_memory.clear_all(proj.hash)
        typer.echo("Memory cleared.")
    else:
        typer.echo(f"Unknown action {action!r}. Use: show | set | unset | clear", err=True)
        raise typer.Exit(1)


@app.command("git-history", rich_help_panel="Core")
def git_history_cmd(
    file: str = typer.Argument(..., help="File path to look up in git history"),
    limit: int = typer.Option(5, "--limit", "-n", help="Number of commits to show"),
) -> None:
    """Show recent git commits that touched <file> (from the indexed git history)."""
    import os
    import time
    from pathlib import Path

    from . import git_history
    from .project import find_project

    cwd = Path(os.getcwd())
    proj = find_project(cwd)
    if proj is None:
        typer.echo("Not in an indexed project root.", err=True)
        raise typer.Exit(1)

    try:
        abs_file = Path(file) if Path(file).is_absolute() else (cwd / file)
        rel_path = abs_file.relative_to(proj.root).as_posix()
    except ValueError:
        typer.echo(f"File is not under project root: {proj.root}", err=True)
        raise typer.Exit(1) from None

    commits = git_history.find_commits_for_file(proj.hash, rel_path, limit=limit)
    if not commits:
        typer.echo(f"No indexed commits found for {rel_path}.")
        typer.echo("Tip: run 'token-goat index' to (re)index, or wait for session-start indexing.")
        return

    now = time.time()
    for c in commits:
        age_days = int((now - float(str(c["author_ts"]))) / 86_400)
        age_str = f"{age_days}d ago" if age_days > 0 else "today"
        typer.echo(f"{str(c['commit_short'])[:8]}  {c['summary']} ({age_str})")


@app.command("cache-audit", rich_help_panel="Advanced")
def cache_audit() -> None:
    """Audit Claude Code config for patterns that bust the prompt cache."""
    from . import install

    issues: list[str] = []

    # Check settings.json for hook coverage (cache-busting if PreToolUse fires on every call).
    settings_path = install.claude_settings_path()
    if settings_path.exists():
        try:
            cfg = json.loads(settings_path.read_text(encoding="utf-8"))
            hooks = cfg.get("hooks", {})
            pre_hooks = hooks.get("PreToolUse", [])
            post_hooks = hooks.get("PostToolUse", [])
            for h in pre_hooks:
                matchers = h.get("matcher", "")
                if "Read" in matchers or "Bash" in matchers or "Grep" in matchers:
                    issues.append(f"PreToolUse hook matches high-frequency tools ({matchers!r}): every call recomputes cache")
            for h in post_hooks:
                matchers = h.get("matcher", "")
                if "Bash" in matchers or "WebFetch" in matchers:
                    issues.append(f"PostToolUse hook on {matchers!r}: may add dynamic content that busts cache")
        except Exception:
            issues.append(f"Could not parse {settings_path}")
    else:
        issues.append(f"settings.json not found at {settings_path}")

    # Check CLAUDE.md for dynamic content patterns.
    claude_md = install.claude_md_path()
    if claude_md and claude_md.exists():
        content = claude_md.read_text(encoding="utf-8", errors="replace")
        size_kb = len(content.encode()) / 1024
        if size_kb > 50:
            issues.append(f"CLAUDE.md is {size_kb:.1f}KB — large system prompts bust cache on every token-count change")
        issues.extend(f"CLAUDE.md contains dynamic pattern {pat!r} — changes every session, busting cache" for pat in ("{{date}}", "{{time}}", "Date:", "Time:", "today is") if pat.lower() in content.lower())

    if issues:
        from .render.common import render_list
        typer.echo("Cache-busting issues found:")
        typer.echo(render_list(issues, bullet="-"))
    else:
        typer.echo("No obvious cache-busting patterns detected.")


@app.command("session-touched", rich_help_panel="Advanced")
def session_touched(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = _OPT_JSON,
) -> None:
    """List files already read in the given Claude session."""
    from . import session as session_mod

    _validate_session_id(session_id)

    entries = session_mod.list_touched(session_id)
    if json_output:
        out = [
            {
                "path": e.rel_or_abs,
                "read_count": e.read_count,
                "line_ranges": e.line_ranges,
                "symbols_read": e.symbols_read,
                "last_read_ts": e.last_read_ts,
            }
            for e in entries
        ]
        typer.echo(json_compact(out))
        return
    if not entries:
        typer.echo("(no files touched in this session)")
        return
    for e in entries:
        ranges = ", ".join(f"{s}-{en}" for s, en in e.line_ranges) or "(symbols only)"
        symbols = f" symbols={','.join(e.symbols_read)}" if e.symbols_read else ""
        typer.echo(f"{e.rel_or_abs}  reads={e.read_count}  lines={ranges}{symbols}")


@app.command("session-summary", rich_help_panel="Advanced")
def cmd_session_summary(
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
) -> None:
    """Compact one-liner about current session state for orchestrators.

    Detects the current session ID from CLAUDE_SESSION_ID env var, or uses the
    most recently modified session file.  Reports: files read, files edited,
    commits made since session start, and token savings estimate.

    Examples::

        token-goat session-summary
        token-goat session-summary --json
        token-goat session-summary --session-id abc123
    """
    from . import paths as _paths
    from . import session as session_mod
    from . import stats as _stats
    from .util import run_git

    # Detect session ID
    if session_id is None:
        # Try env var first
        session_id = os.environ.get("CLAUDE_SESSION_ID")
        if not session_id:
            # Find most recently modified session file
            sessions_dir = _paths.sessions_dir()
            if sessions_dir.exists():
                session_files = [f for f in sessions_dir.iterdir() if f.suffix == ".json"]
                if session_files:
                    most_recent = max(session_files, key=lambda f: f.stat().st_mtime)
                    session_id = most_recent.stem

    if not session_id:
        msg = {"session_id": None, "files_read": 0, "files_edited": 0, "commits_this_session": 0, "tokens_saved_estimate": 0, "message": "No active session"}
        _emit_json(msg) if json_output else typer.echo("No active session")
        raise typer.Exit(0) from None

    _validate_session_id(session_id)

    # Check if session file actually exists before trying to load
    sess_path = _paths.session_cache_path(session_id)
    if not sess_path.exists():
        msg = {"session_id": session_id, "files_read": 0, "files_edited": 0, "commits_this_session": 0, "tokens_saved_estimate": 0, "message": "Session not found"}
        _emit_json(msg) if json_output else typer.echo("No active session")
        raise typer.Exit(0)

    # Load session cache
    try:
        sess = session_mod.load(session_id)
    except Exception:
        msg = {"session_id": session_id, "files_read": 0, "files_edited": 0, "commits_this_session": 0, "tokens_saved_estimate": 0, "message": "Session not found or corrupted"}
        _emit_json(msg) if json_output else typer.echo("No active session")
        raise typer.Exit(0) from None

    # Count files read and edited
    files_read = len(sess.files)
    files_edited = len(sess.edited_files)

    # Count commits since session started
    commits_count = 0
    try:
        # Get git log since session started; count lines
        session_start_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sess.started_ts))
        result = run_git(
            ["log", "--oneline", f"--since={session_start_iso}"],
            cwd=sess.cwd or None,
            timeout=5,
        )
        if result.returncode == 0:
            # Count non-empty lines
            commits_count = len([line for line in result.stdout.strip().split("\n") if line.strip()])
    except Exception:
        _LOG.debug("session brief: git log failed (commits_count=0)", exc_info=True)

    # Estimate token savings from stats or formula
    tokens_saved_estimate = 0
    try:
        # Try to get actual tokens saved from stats for this session
        summary = _stats.summarize(window_days=30)
        total_tokens = summary.total_tokens_saved
        tokens_saved_estimate = max(0, total_tokens)
    except Exception:
        # Fallback: rough estimate = (files_read * 1000) + (files_edited * 200)
        tokens_saved_estimate = (files_read * 1000) + (files_edited * 200)

    # Format output
    short_id = session_id[:12] if len(session_id) > 12 else session_id
    if json_output:
        _emit_json({
            "session_id": session_id,
            "files_read": files_read,
            "files_edited": files_edited,
            "commits_this_session": commits_count,
            "tokens_saved_estimate": tokens_saved_estimate,
        })
    else:
        result_text = (
            f"Session {short_id}: {files_read} files read, "
            f"{files_edited} edited, {commits_count} commits, ~{tokens_saved_estimate // 1000}k tokens saved"
        )
        typer.echo(result_text)


@app.command("session-mark", rich_help_panel="Advanced", hidden=True)
def session_mark(
    file_path: str = typer.Argument(...),
    session_id: str = typer.Option(..., "--session-id", "-s"),
    offset: int = typer.Option(0, "--offset"),
    limit: int = typer.Option(0, "--limit", help="0 means unlimited"),
) -> None:
    """Manually mark a file/range as read for the given session. (Mostly used by hooks.)"""
    from . import session as session_mod

    _validate_session_id(session_id)

    session_mod.mark_file_read(session_id, file_path, offset or None, limit or None)
    typer.echo("ok")


@app.command("gdrive-fetch", hidden=True)
def cmd_gdrive_fetch(
    file_id: str = typer.Argument(...),
    json_output: bool = _OPT_JSON,
) -> None:
    """Fetch a Google Drive file (image gets auto-shrunk). Returns the local path."""
    from . import gdrive

    try:
        path = gdrive.fetch_file(file_id)
    except gdrive.GDriveCredsUnavailable as e:
        _warn(str(e))
        raise typer.Exit(0) from None  # fail-soft: don't break Claude's session
    except Exception as e:
        _warn(f"Drive fetch failed: {e}")
        raise typer.Exit(0) from None
    _emit_path_result(path, json_output)


@app.command("gdrive-sections", rich_help_panel="Core")
def cmd_gdrive_sections(
    file_id: str = typer.Argument(...),
    json_output: bool = _OPT_JSON,
    max_sections: int = typer.Option(
        80, "--max-sections",
        help="Maximum number of sections to list (rest are summarised). Keeps the hint compact.",
    ),
) -> None:
    """Download a Drive markdown/text doc and emit its section index (not the body).

    Lets the agent see the document's heading structure for ~50–200 tokens
    instead of pulling the whole file (which can run to 50k+ tokens). The agent
    can then request a single section via ``token-goat section <path>::<heading>``.

    Always exits 0 (fail-soft) so a Drive outage or auth issue never derails the
    agent — the worst case is the agent falls back to ``gdrive-fetch``.
    """
    from . import gdrive

    try:
        # Image-shrink is disabled because if the agent asked for sections, it
        # expects text content; we still pass through the cached binary path
        # untouched if the file happens to be non-text.
        local_path = gdrive.fetch_file(file_id, shrink_if_image=False)
    except gdrive.GDriveCredsUnavailable as e:
        _warn(str(e))
        raise typer.Exit(0) from None
    except Exception as e:
        _warn(f"Drive fetch failed: {e}")
        raise typer.Exit(0) from None

    index = gdrive.extract_section_index(local_path)

    # Cap the section list so an enormous doc (hundreds of headings) doesn't
    # itself become the token sink we are trying to avoid.
    sections = cast("list[dict[str, object]]", index.get("sections", []))
    truncated = False
    if len(sections) > max_sections:
        sections = sections[:max_sections]
        truncated = True
        index["sections"] = sections
        index["truncated"] = True
        index["truncated_at"] = max_sections

    if json_output:
        _emit_json(index)
        return

    # Plain-text output: path on line 1, then a compact heading list.
    path_to_display = Path(cast("str", index.get("path", local_path)))
    typer.echo(_format_path_output(path_to_display))
    size_bytes = cast("int", index.get("size_bytes", 0))
    line_count = cast("int", index.get("line_count", 0))
    typer.echo(f"size={size_bytes}B lines={line_count} sections={len(sections)}")
    if not index.get("extractor_available", False):
        typer.echo(
            "(no section index available — file is not a recognised markdown/text type "
            "or is too large to parse; use `token-goat gdrive-fetch` instead)"
        )
        return
    for sec in sections:
        prefix = "#" * cast("int", sec.get("level", 1))
        heading = cast("str", sec.get("heading", ""))
        line = cast("int", sec.get("line", 0))
        end_line = sec.get("end_line")
        approx = cast("int", sec.get("approx_bytes", 0))
        end_str = "" if end_line is None else f"-{end_line}"
        typer.echo(f"L{line}{end_str} ~{approx}B {prefix} {heading}")
    if truncated:
        typer.echo(f"(... truncated at {max_sections} sections)")


@app.command("gdrive-list")
def cmd_gdrive_list(
    folder: str | None = typer.Option(None, "--folder", help="Filter to files in a specific folder (by folder ID)"),
    max_results: int = typer.Option(20, "--max", help="Maximum files to list"),
    json_output: bool = _OPT_JSON,
) -> None:
    """List accessible Google Drive files."""
    from . import gdrive

    files = gdrive.list_drive_files(folder_id=folder, max_results=max_results)

    if not files:
        if json_output:
            _emit_json([])
        _warn("No files found. Run `token-goat gdrive-auth` to set up credentials.")
        raise typer.Exit(0)

    if json_output:
        _emit_json(files)

    # Human-readable output
    for f in files:
        file_id = f.get("id", "")
        name = f.get("name", "")
        mime = f.get("mimeType", "")
        size_bytes = f.get("size_bytes", 0)

        # Format size
        if size_bytes == 0:
            size_str = "0 B"
        elif size_bytes < 1024:
            size_str = f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            size_str = f"{size_bytes // 1024} KB"
        else:
            size_str = f"{size_bytes // (1024 * 1024)} MB"

        # Extract human-readable type from MIME type
        if "google-apps.document" in mime:
            type_str = "Google Docs"
        elif "google-apps.presentation" in mime:
            type_str = "Google Slides"
        elif mime == "application/pdf":
            type_str = "PDF"
        elif mime == "text/plain":
            type_str = "Text"
        else:
            type_str = mime

        typer.echo(f"{file_id}  {name} ({type_str}, {size_str})")


@app.command("gdrive-auth", hidden=True)
def cmd_gdrive_auth(
    client_secrets: Path | None = typer.Option(None, "--client-secrets", help="Path to OAuth client_secrets.json"),  # noqa: B008
) -> None:
    """One-time Google Drive auth setup. Tries ADC first, then OAuth flow."""
    from . import gdrive

    # Check ADC
    creds = gdrive._try_adc()
    if creds is not None:
        typer.echo("Google Application Default Credentials detected. token-goat gdrive-fetch will work.")
        raise typer.Exit(0)

    # Check existing stored creds
    creds = gdrive._try_stored_oauth()
    if creds is not None:
        typer.echo("Stored OAuth credentials valid. token-goat gdrive-fetch will work.")
        raise typer.Exit(0)

    # Need to set up OAuth
    if client_secrets is None:
        typer.echo("No credentials available. To set up:")
        typer.echo("")
        typer.echo("Option A (recommended if you have gcloud installed):")
        typer.echo("  gcloud auth application-default login --scopes https://www.googleapis.com/auth/drive.readonly")
        typer.echo("")
        typer.echo("Option B: OAuth client secrets")
        typer.echo("  1. Visit https://console.cloud.google.com/apis/credentials")
        typer.echo("  2. Create OAuth 2.0 Client ID (type: Desktop)")
        typer.echo("  3. Download the JSON, then run:")
        typer.echo("       token-goat gdrive-auth --client-secrets path/to/client_secret.json")
        typer.echo("")
        typer.echo("Option C: skip — token-goat gdrive-fetch will fall back to a clear error,")
        typer.echo("and Claude's existing Drive MCP will be used directly (no token-savings).")
        raise typer.Exit(0)

    if not client_secrets.exists():
        _error(f"file not found: {client_secrets}")
        raise typer.Exit(1)

    try:
        out_path = gdrive.run_oauth_oob_flow(client_secrets)
        typer.echo(f"Credentials saved to {out_path}. token-goat gdrive-fetch will work.")
    except Exception as e:
        _error(f"OAuth flow failed: {e}")
        raise typer.Exit(1) from None


@app.command("fetch-image", hidden=True)
def cmd_fetch_image(
    url: str = typer.Argument(...),
    json_output: bool = _OPT_JSON,
) -> None:
    """Fetch an image URL (auto-shrunk). Returns the local cached path."""
    from . import webfetch

    try:
        path = webfetch.fetch_url(url)
    except (ValueError, RuntimeError, OSError) as e:
        _warn(f"WebFetch failed: {e}")
        raise typer.Exit(0) from None  # fail-soft
    _emit_path_result(path, json_output)


@app.command(hidden=True)
def caption_instead(path: str) -> None:
    """Generate text caption instead of image (v2 feature)."""
    typer.echo("v2 feature, not in v1")


_WATCH_POLL_INTERVAL = 5.0


def _watch_project(proj: Project) -> None:
    """Poll the project directory for changed files and reindex them.

    Runs until interrupted by Ctrl+C.  Falls back to polling (no watchdog
    required) by scanning file mtimes every ``_WATCH_POLL_INTERVAL`` seconds.
    """
    from . import db
    from .parser import (
        SKIP_DIRS,
        _is_generated_filename,
        index_file,
        write_file_index,
    )

    typer.echo(f"Watching {proj.root} — press Ctrl+C to stop")

    # Snapshot: rel_path -> mtime
    mtimes: dict[str, float] = {}

    def _scan_mtimes() -> dict[str, float]:
        result: dict[str, float] = {}
        root = proj.root
        for dirpath, dirs, files in __import__("os").walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            base = Path(dirpath)
            for name in files:
                if _is_generated_filename(name):
                    continue
                fp = base / name
                with contextlib.suppress(OSError):
                    result[fp.relative_to(root).as_posix()] = fp.stat().st_mtime
        return result

    # Build initial snapshot without printing anything (index already ran)
    mtimes = _scan_mtimes()

    try:
        while True:
            time.sleep(_WATCH_POLL_INTERVAL)
            new_mtimes = _scan_mtimes()

            changed = [rel for rel, mtime in new_mtimes.items() if mtimes.get(rel) != mtime]
            # Also track deletions (removed files need no reindex, just update snapshot)

            for rel in changed:
                fp = proj.root / rel
                fi = index_file(proj, fp)
                if fi is None:
                    _LOG.debug("watch: index_file returned None for %s", rel)
                    continue
                try:
                    with db.project_writer_lock(proj.hash, timeout_sec=10.0), db.open_project(proj.hash) as conn:
                        write_file_index(conn, fi)
                except Exception as exc:
                    _LOG.warning("watch: failed to write index for %s: %s", rel, exc)
                    continue
                n_sym = len(fi.symbols)
                sym_word = "symbol" if n_sym == 1 else "symbols"
                typer.echo(f"reindexed: {rel} ({n_sym} {sym_word})")

            mtimes = new_mtimes
    except KeyboardInterrupt:
        typer.echo("Stopped watching.")


@app.command(rich_help_panel="Core")
def index(
    full: bool = typer.Option(False, "--full"),
    embeddings: bool = typer.Option(False, "--embeddings"),
    root: str | None = typer.Option(None, "--root", help="Index an arbitrary directory (skips project detection)"),
    skills: bool = typer.Option(False, "--skills", help="Index ~/.claude/skills/"),
    plugins: bool = typer.Option(False, "--plugins", help="Index ~/.claude/plugins/"),
    watch: bool = typer.Option(False, "--watch", help="Watch for file changes and reindex automatically (polling, Ctrl+C to stop)."),
    report_large: bool = typer.Option(False, "--report-large", help="After indexing, print a table of files that were skipped or received symbol-only treatment due to their size."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Print each file as it's indexed with symbol count."),
    check: bool = typer.Option(False, "--check", help="Report pending dirty files without indexing. Exit 1 if dirty files exist, 0 if clean."),
    ext: list[str] | None = typer.Option(None, "--ext", help="Only (re-)index files with this extension. May be repeated: --ext py --ext ts. Useful after adding a new indexer."),  # noqa: B008
) -> None:
    """Rebuild project/global indices."""
    from . import paths as _paths
    from .parser import index_project
    from .project import find_project, make_project_at

    # Handle --check flag: read dirty queue and report pending files without indexing.
    if check:

        queue_path = _paths.dirty_queue_path()
        pending_entries = []
        if queue_path.exists():
            try:
                lines = queue_path.read_text(encoding="utf-8").splitlines()
                for line in lines:
                    if line.strip():
                        try:
                            entry = json.loads(line)
                            if isinstance(entry, dict):
                                pending_entries.append(entry)
                        except json.JSONDecodeError:
                            pass
            except OSError:
                pass

        n_pending = len(pending_entries)
        if n_pending > 0:
            typer.echo(f"{n_pending} files pending re-index. Run `token-goat index` to update.")
            raise typer.Exit(1)
        typer.echo("0 files pending re-index.")
        raise typer.Exit(0)

    proj: Project | None = None
    if root is not None:
        root_path = Path(root).expanduser().resolve()
        if not root_path.is_dir():
            _error(f"{root_path} is not a directory")
            raise typer.Exit(2)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing {root_path} ...")
    elif skills:
        root_path = _paths.claude_skills_dir()
        if not root_path.is_dir():
            _error(f"skills directory not found: {root_path}")
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing skills: {root_path} ...")
    elif plugins:
        root_path = _paths.claude_plugins_dir()
        if not root_path.is_dir():
            _error(f"plugins directory not found: {root_path}")
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing plugins: {root_path} ...")
    else:
        proj = find_project(Path.cwd())
        if proj is None:
            _error("no project detected — run from a project directory")
            raise typer.Exit(1)

    assert proj is not None  # guaranteed: all branches either set proj or return/exit early

    import sys as _sys

    _tty = _sys.stderr.isatty()

    def _progress(done: int, total: int) -> None:
        if _tty:
            _sys.stderr.write(f"\r  {done}/{total} files scanned...")
            _sys.stderr.flush()
        else:
            typer.echo(f"  {done}/{total} files scanned...", err=True)

    # Build frozenset of lowercased extensions with leading dot for the filter.
    _ext_filter: frozenset[str] | None = None
    if ext:
        _ext_filter = frozenset(
            (e if e.startswith(".") else f".{e}").lower()
            for e in ext
        )

    _LOG.info("index start: project=%s mode=%s", proj.root.name, "full" if full else "incremental")
    try:
        summary = index_project(proj, full=full, progress=_progress, verbose=verbose, ext_filter=_ext_filter)
    except Exception as exc:
        _error(f"indexing failed: {exc}")
        raise typer.Exit(1) from None

    if _tty and summary["total_files"] > 0:
        _sys.stderr.write("\r" + " " * 40 + "\r")
        _sys.stderr.flush()

    langs = ", ".join(summary["languages"]) if summary["languages"] else "none"
    _LOG.info(
        "index complete: project=%s files=%d indexed=%d errors=%d dur=%.2fs",
        proj.root.name,
        summary["total_files"],
        summary["indexed"],
        summary["errors"],
        summary["duration_sec"],
    )
    sym_part = f", {summary['total_symbols']} symbols" if summary["total_symbols"] > 0 else ""
    typer.echo(
        f"Indexed {summary['total_files']} files "
        f"({summary['indexed']} indexed, "
        f"{summary['skipped_unchanged']} skipped unchanged, "
        f"{summary['errors']} errors{sym_part}) "
        f"— {langs} "
        f"— in {summary['duration_sec']}s"
    )

    # Per-extension breakdown (shown when there are multiple distinct extensions indexed).
    ext_counts: dict[str, int] = summary.get("ext_counts", {})  # type: ignore[assignment]
    if ext_counts and len(ext_counts) > 1:
        breakdown = ", ".join(
            f"{count} {extension}"
            for extension, count in sorted(ext_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        )
        typer.echo(f"  by type: {breakdown}")

    # --report-large: print a table of files that were skipped or symbol-only.
    large_files = summary.get("large_files", [])
    if large_files:
        n_skipped = sum(1 for lf in large_files if lf.reason == "skipped")
        n_symbol_only = sum(1 for lf in large_files if lf.reason == "symbol_only")
        _large_parts = []
        if n_skipped:
            _large_parts.append(f"{n_skipped} skipped")
        if n_symbol_only:
            _large_parts.append(f"{n_symbol_only} symbol-only")
        typer.echo(f"Large files: {', '.join(_large_parts)} — use --report-large for details")
    if report_large:
        if not large_files:
            typer.echo("Large files: none (all files within configured thresholds)")
        else:
            typer.echo("\nLarge file report:")
            typer.echo(f"  {'Reason':<12} {'Size':>10}  Path")
            typer.echo(f"  {'-'*12} {'-'*10}  {'-'*40}")
            for lf in sorted(large_files, key=lambda x: (-x.size_bytes, x.rel_path)):
                size_str = f"{lf.size_bytes / 1024:.0f} KB" if lf.size_bytes < 1024 * 1024 else f"{lf.size_bytes / (1024*1024):.1f} MB"
                typer.echo(f"  {lf.reason:<12} {size_str:>10}  {lf.rel_path}")

    if embeddings:
        from . import embeddings as emb
        try:
            result = emb.index_project_embeddings(proj)
            typer.echo(
                f"Embeddings: {result['chunks_embedded']} new, "
                f"{result['chunks_skipped_unchanged']} unchanged "
                f"in {result['duration_sec']}s (model={result['model']})"
            )
        except emb.EmbeddingsUnavailable as e:
            typer.echo(f"Embeddings skipped: {e}")

    if watch:
        _watch_project(proj)


@app.command(rich_help_panel="Core")
def ignores(
    json_output: bool = _OPT_JSON,
) -> None:
    """Show active exclusion patterns for the current project.

    Displays built-in skip lists (directories, filenames, suffixes) and any
    custom patterns from .tokengoatignore.
    """
    from . import paths as _paths
    from .parser import (
        SKIP_DIRS,
        SKIP_FILE_BASENAMES,
        SKIP_FILE_SUFFIXES,
        load_project_ignore_patterns,
    )
    from .project import find_project

    proj = find_project(Path.cwd())
    if proj is None:
        _error("no project detected — run from a project directory")
        raise typer.Exit(1)

    ignore_patterns = load_project_ignore_patterns(proj.root)
    ignore_file = _paths.project_ignore_file_path(proj.root)

    if json_output:
        output = {
            "skip_dirs": sorted(SKIP_DIRS),
            "skip_basenames": sorted(SKIP_FILE_BASENAMES),
            "skip_suffixes": list(SKIP_FILE_SUFFIXES),
            "project_patterns": ignore_patterns,
            "project_file_path": ignore_file.as_posix(),
        }
        typer.echo(json.dumps(output, indent=2))
    else:
        typer.echo(f"Built-in skip directories ({len(SKIP_DIRS)}):")
        for d in sorted(SKIP_DIRS):
            typer.echo(f"  {d}/")
        typer.echo(f"\nBuilt-in skip filenames ({len(SKIP_FILE_BASENAMES)}):")
        for f in sorted(SKIP_FILE_BASENAMES):
            typer.echo(f"  {f}")
        typer.echo(f"\nBuilt-in skip suffixes ({len(SKIP_FILE_SUFFIXES)}):")
        for s in SKIP_FILE_SUFFIXES:
            typer.echo(f"  {s}")
        if ignore_patterns:
            typer.echo(f"\nProject-specific patterns from {ignore_file.name} ({len(ignore_patterns)}):")
            for p in ignore_patterns:
                typer.echo(f"  {p}")
        else:
            typer.echo(f"\nProject-specific patterns: none (no {ignore_file.name})")


@app.command(rich_help_panel="Core")
def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = _OPT_JSON,
    by_project: bool = typer.Option(False, "--by-project", help="Show per-project breakdown table"),
    by_command: bool = typer.Option(False, "--by-command", help="Show per-CLI-command breakdown table"),
    top: int = typer.Option(10, "--top", help="Number of projects to show with --by-project"),
    since: int | None = typer.Option(
        None,
        "--since",
        help=(
            "Show data for the last N days only. Equivalent to --window N. "
            "Example: --since 7 for last 7 days, --since 1 for today."
        ),
    ),
    session_id: str | None = _OPT_SESSION_ID,
    global_: bool = typer.Option(False, "--global", help="Show all-time compression metrics instead of session-scoped view"),
) -> None:
    """Show cumulative token savings.

    With ``--session-id`` or ``--global``, prints a focused compression summary
    (bash outputs compressed, tokens saved, reread denies, images shrunk) instead
    of the full rich table.  Use ``--json`` with either flag for machine-readable output.
    """
    from . import cli_stats

    # --session-id / --global trigger the focused compression metrics view.
    if session_id is not None or global_:
        from . import db as _db
        sid = None if global_ else session_id
        label = "all-time" if global_ else f"session {session_id[:8] if session_id else ''}"
        data = _db.get_compression_stats(session_id=sid)
        _hook_timing = _db.get_hook_timing_stats(window_days=7)
        if json_output:
            data["hook_timing"] = _hook_timing
            typer.echo(json_compact(data))
        else:
            typer.echo(f"Token savings ({label}):")
            typer.echo(f"  Bash outputs compressed : {data['outputs_compressed']:,}")
            typer.echo(f"  Estimated tokens saved  : {data['tokens_saved']:,}")
            typer.echo(f"  Reread denies           : {data['reread_denies']:,}")
            typer.echo(f"  Images shrunk           : {data['images_shrunk']:,}")
            if _hook_timing:
                typer.echo("\nHook latency (last 7d):")
                for _evt, _ht in sorted(_hook_timing.items(), key=lambda x: -x[1]["avg_ms"]):
                    typer.echo(
                        f"  {_evt:<30s} N={_ht['count']:>4}  "
                        f"avg={_ht['avg_ms']:>5}ms  p95={_ht['p95_ms']:>5}ms  max={_ht['max_ms']:>5}ms"
                    )
        return

    # --since is a friendlier alias for --window; it takes precedence when both are specified.
    effective_window = since if since is not None else window
    cli_stats.stats(window=effective_window, json_output=json_output, by_project=by_project, by_command=by_command, top=top)


@app.command(rich_help_panel="Core")
def cost(
    session: str | None = typer.Option(
        None,
        "--session",
        "-s",
        help=(
            "Show savings for a specific session (full or 8-char short form). "
            "When omitted, shows all-time summary."
        ),
    ),
) -> None:
    """Show estimated tokens saved (session or all-time)."""
    from . import paths as _paths
    from . import session as session_mod
    from . import stats as stats_mod

    sessions_dir = _paths.sessions_dir()

    if session is not None:
        # Resolve session ID (full, short, or most recent)
        def _resolve_session_id(raw: str) -> str | None:
            """Resolve full / short session id against the on-disk cache."""
            if len(raw) >= 32:
                return raw
            # Short prefix lookup.
            if sessions_dir.exists():
                for f in sessions_dir.glob(f"{raw}*.json"):
                    return f.stem
            return None

        resolved = _resolve_session_id(session.strip())
        if resolved is None:
            _error(f"no session cache found for: {session!r}")
            raise typer.Exit(1)

        cache = session_mod.safe_load(resolved)
        if cache is None:
            _error(f"failed to load session cache: {resolved!r}")
            raise typer.Exit(1)

        # Compute session savings
        tokens_saved = 0
        avoided_reads = 0
        dedup_hits = 0

        # Count files read and estimate token savings
        for file_entry in cache.files.values():
            # Estimate tokens saved per re-read: roughly file_size / 4 tokens
            # (conservative: not counting all dedup benefits)
            if file_entry.read_count > 1:
                # Multiple reads of same file → likely saved via diff-hint or caching
                avoided_reads += file_entry.read_count - 1

        # Count dedup hits from grep/bash/web
        dedup_hits += len([g for g in cache.greps if g.ts > 0])
        dedup_hits += len(cache.bash_history)
        dedup_hits += len(cache.web_history)

        # Very rough estimate: assume 500 tokens per file read on average
        # For dedup hits (bash/web/grep repeat), assume 200 tokens saved each
        tokens_saved = avoided_reads * 500 + dedup_hits * 200

        typer.echo(f"Session {resolved[:8]}: ~{tokens_saved:,} tokens saved via {avoided_reads} cached reads + {dedup_hits} dedup hits")
        raise typer.Exit(0)

    # All-time summary (no --session flag)
    summary = stats_mod.summarize(window_days=0)

    total_tokens = summary.total_tokens_saved
    total_bytes = summary.total_bytes_saved

    by_source = summary.by_source
    top_str = ""
    if by_source:
        top_sources = sorted(by_source.items(), key=lambda x: x[1]["tokens_saved"], reverse=True)[:3]
        top_str = " (" + ", ".join(f"{src}: {data['tokens_saved']:,}" for src, data in top_sources) + ")"

    typer.echo(f"All-time: {total_tokens:,} tokens saved, {total_bytes / 1024 / 1024:.1f} MB data avoided{top_str}")


# Smart-default constants for no-flag recall of bash-output / web-output.
# Head is small: just enough to show the command invocation and early output.
_SMART_DEFAULT_HEAD = 30
# Tail is generous: pytest/cargo/ruff failure summaries and tracebacks can be
# 40-60 lines on their own; 80 ensures a full trailing error block survives.
_SMART_DEFAULT_TAIL = 80
# Only apply the smart default when the output exceeds head+tail combined.
# Outputs at or below this threshold are returned in full — no elision.
_SMART_DEFAULT_THRESHOLD = _SMART_DEFAULT_HEAD + _SMART_DEFAULT_TAIL

# --head-tail constants (Item 7): first+last N lines with an omission marker.
_HEAD_TAIL_LINES = 20
_HEAD_TAIL_THRESHOLD = _HEAD_TAIL_LINES * 2  # no-op when body <= this many lines

# --grep-max default cap (Item 10).
_GREP_MAX_DEFAULT = 20

# Shared Typer option objects for the output-slicing flags used by bash-output,
# web-output, and skill-body.  Defined once so help text and defaults stay in
# sync across all three commands.  Typer treats these as immutable descriptors —
# it reads the default at registration time and does not mutate the objects.
_OPT_HEAD: int = typer.Option(0, "--head", help="Show first N lines (0 = no head limit)")
_OPT_TAIL: int = typer.Option(0, "--tail", help="Show last N lines (0 = no tail limit)")
_OPT_GREP: str | None = typer.Option(None, "--grep", "-g", help="Show only lines matching a regex pattern (case-insensitive by default; see --case-sensitive; falls back to literal match if the pattern is not valid regex)")
_OPT_GREP_MAX: int = typer.Option(_GREP_MAX_DEFAULT, "--grep-max", help="Max matching lines to show with --grep (0 = no cap)")
_OPT_CASE_SENSITIVE: bool = typer.Option(False, "--case-sensitive", help="Make --grep matching case-sensitive")
_OPT_FULL: bool = typer.Option(False, "--full", help="Return the entire cached output (disables smart-default head+tail)")
_OPT_HEAD_TAIL: bool = typer.Option(False, "--head-tail", help="Emit first+last 20 lines with an omission marker instead of full body")
_OPT_SECTION: str | None = typer.Option(None, "--section", "-s", help="Extract a specific markdown/HTML section by heading text (case-insensitive; use Heading#2 for the second occurrence)")


# ---------------------------------------------------------------------------
# Section extraction for cached output bodies (no DB required)
# ---------------------------------------------------------------------------

# ATX heading pattern: 1-6 # characters at the start of a line followed by
# the heading text.  Used by _extract_body_section to find headings in cached
# text bodies (HTML pages rendered as markdown, documentation, etc.).
_BODY_ATX_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def _extract_body_section(body: str, heading: str) -> str | None:
    """Extract a markdown section by heading from a raw text body.

    This is a lightweight in-memory variant of ``read_section`` that operates
    on arbitrary cached text (web pages, bash output with embedded docs, etc.)
    without requiring the file to be DB-indexed.

    Supports ordinal suffixes: ``Heading#2`` selects the second occurrence of
    a heading named ``Heading`` (1-based).  Without an ordinal the first
    occurrence is returned.

    Returns the section text (including the heading line) or ``None`` when the
    heading is not found.
    """
    # Parse ordinal suffix (``Heading#2`` -> ``Heading``, 2).
    base_heading, ordinal = _parse_body_section_ordinal(heading)
    target_lower = base_heading.lower()

    lines = body.splitlines()
    # Collect (line_index, level) for every ATX heading matching the target.
    matches: list[tuple[int, int]] = []
    for idx, line in enumerate(lines):
        m = _BODY_ATX_RE.match(line)
        if m and m.group(2).strip().lower() == target_lower:
            matches.append((idx, len(m.group(1))))

    if not matches:
        return None

    # Apply ordinal selection.
    occ = (ordinal or 1) - 1  # convert to 0-based index
    if occ >= len(matches):
        return None
    start_idx, level = matches[occ]

    # Find the end of the section: the next heading at the same or higher level
    # (fewer or equal number of # symbols), or end of document.
    end_idx = len(lines)
    for idx in range(start_idx + 1, len(lines)):
        m = _BODY_ATX_RE.match(lines[idx])
        if m and len(m.group(1)) <= level:
            end_idx = idx
            break

    return "\n".join(lines[start_idx:end_idx])


def _parse_body_section_ordinal(heading: str) -> tuple[str, int | None]:
    """Split ``Heading#N`` into ``("Heading", N)``.

    Returns ``(heading, None)`` when no valid ordinal suffix is present.
    """
    if "#" not in heading:
        return heading, None
    base, _, ordinal_str = heading.rpartition("#")
    if not base or not ordinal_str:
        return heading, None
    try:
        ordinal = int(ordinal_str)
    except ValueError:
        return heading, None
    if ordinal < 1:
        return heading, None
    return base, ordinal


def _compile_grep_pattern(pattern: str, *, case_sensitive: bool) -> re.Pattern[str]:
    """Compile *pattern* as a regex, falling back to ``re.escape`` on invalid syntax.

    This lets agents pass either regex patterns (``"def \\w+"`` ) or plain
    literal strings (``"TODO"``), both of which work correctly — invalid regex
    patterns are treated as literals rather than raising an error.
    """
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(pattern, flags)
    except re.error:
        return re.compile(re.escape(pattern), flags)


def _apply_recall_filters(
    lines: list[str],
    *,
    head: int,
    tail: int,
    grep: str | None,
    full: bool,
    case_sensitive: bool = False,
) -> list[str]:
    """Apply the standard head/tail/grep/full slicing pipeline to *lines*.

    This is the subset of output-recall filtering that is common to all three
    output-recall commands (bash-output, web-output, skill-body).  More
    specialised logic — grep-max capping, head-tail mode, numbered-lines JSON
    anchoring — lives in :func:`_run_output_recall_command` because it is only
    needed for the bash/web pair.

    Args:
        lines: Source lines (already split on newlines).
        head:  Return first N lines (0 = no limit).
        tail:  Return last N lines (0 = no limit).
        grep:  Regex pattern filter; ``None`` or ``""`` = no filter.  Invalid
               regex patterns are treated as literal strings.  Case-insensitive
               by default; pass ``case_sensitive=True`` for exact matching.
        full:  When True, skip the smart-default elision even if no explicit
               slice flags were passed.
        case_sensitive: When True, apply grep as a case-sensitive match.

    Returns:
        Filtered list of lines; caller joins with ``"\\n"`` for output.
    """
    slicing_requested = bool(grep) or head > 0 or tail > 0
    if grep:
        _pat = _compile_grep_pattern(grep, case_sensitive=case_sensitive)
        lines = [ln for ln in lines if _pat.search(ln)]
    if head > 0 and tail > 0:
        # Combine the first ``head`` and last ``tail`` lines. When the two
        # ranges would overlap (head + tail >= total) return every line once
        # instead of duplicating the middle, matching the non-overlapping
        # convention of the ``--head-tail`` preset.
        if head + tail < len(lines):
            lines = [*lines[:head], *lines[-tail:]]
    elif head > 0:
        lines = lines[:head]
    elif tail > 0:
        lines = lines[-tail:]
    if not slicing_requested and not full:
        lines = _apply_smart_default(lines)
    return lines


def _apply_smart_default(lines: list[str]) -> list[str]:
    """Return head+tail slice with an elision marker, or the original list unchanged."""
    total = len(lines)
    if total <= _SMART_DEFAULT_THRESHOLD:
        return lines
    elided = total - _SMART_DEFAULT_HEAD - _SMART_DEFAULT_TAIL
    marker = f"[token-goat: {elided} lines elided; pass --full for all {total} lines]"
    return [*lines[:_SMART_DEFAULT_HEAD], marker, *lines[-_SMART_DEFAULT_TAIL:]]


def _apply_head_tail(lines: list[str]) -> list[str]:
    """Return first + last _HEAD_TAIL_LINES with an omission marker (Item 7).

    When the body has <= _HEAD_TAIL_THRESHOLD lines the list is returned
    unchanged — the flag is a no-op for short outputs.
    """
    total = len(lines)
    if total <= _HEAD_TAIL_THRESHOLD:
        return lines
    omitted = total - _HEAD_TAIL_LINES * 2
    marker = f"--- {omitted} lines omitted ---"
    return [*lines[:_HEAD_TAIL_LINES], marker, *lines[-_HEAD_TAIL_LINES:]]


def _apply_grep_cap(
    matched_lines: list[str],
    grep_max: int,
) -> tuple[list[str], str]:
    """Cap grep results to *grep_max* and return a footer when truncated (Item 10).

    Args:
        matched_lines: Lines already filtered by the grep pattern.
        grep_max: Maximum lines to return.  0 means no cap (current behaviour).

    Returns:
        ``(capped_lines, footer)`` where *footer* is an empty string when no
        truncation occurred, or a hint string when matches were trimmed.
    """
    total = len(matched_lines)
    if grep_max <= 0 or total <= grep_max:
        return matched_lines, ""
    footer = f"(use --grep-max 0 for all {total} matches)"
    return matched_lines[:grep_max], footer


def _format_age(age_secs: float) -> str:
    """Return a human-readable age string for *age_secs* seconds.

    Examples: ``"3s ago"``, ``"4m ago"``, ``"2h ago"``, ``"1d ago"``.
    """
    secs = int(age_secs)
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def _run_output_recall_command(
    *,
    output_id: str,
    head: int,
    tail: int,
    grep: str | None,
    full: bool,
    json_output: bool,
    cache_module: object,
    stat_kind: str,
    not_found_msg: str,
    head_tail: bool = False,
    grep_max: int = _GREP_MAX_DEFAULT,
    case_sensitive: bool = False,
    section: str | None = None,
) -> None:
    """Shared implementation for bash-output and web-output recall commands.

    ``cache_module`` must expose ``load_output``, ``load_output_meta``, and
    ``read_sidecar``.  The sidecar object's attributes are written into the
    JSON payload verbatim, so bash and web sidecars each add their own fields
    (``cmd_preview``/``exit_code`` vs ``url_preview``/``status_code``) without
    any special-casing here.

    Args:
        head_tail: When True, emit the first + last ``_HEAD_TAIL_LINES`` lines
            with an omission marker instead of the full body (Item 7).
            No-op when the body has <= ``_HEAD_TAIL_THRESHOLD`` lines.
        grep_max: Cap on grep-filtered results (Item 10).  Prepends a
            ``Match count: N`` header and appends a truncation footer when the
            cap fires.  ``0`` means no cap.
        case_sensitive: When True, apply ``--grep`` as a case-sensitive match
            (default is case-insensitive).
        section: When set, extract only the named markdown/HTML section from
            the body before applying any other filters.  Supports ordinal
            suffixes (``Heading#2``).  Emits an error and exits with code 1
            when the heading is not found.
    """
    from . import db as _db

    load_output = cache_module.load_output  # type: ignore[attr-defined]  # cache_module typed as object to accept both bash_cache and web_cache modules at call sites
    load_output_meta = cache_module.load_output_meta  # type: ignore[attr-defined]  # same — both modules expose this function
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]  # same

    body = load_output(output_id)
    if body is None:
        # Adoption-telemetry: the agent attempted a recall but the cached
        # body is gone (evicted, mistyped, or from a different session).
        # Record a zero-savings stat so `token-goat stats` can surface a
        # miss rate without conflating it with successful recalls.  The
        # miss kind is the hit kind with a ``_miss`` suffix
        # (``bash_output_recall_miss`` / ``web_output_recall_miss``); both
        # are registered in ``stats._KIND_TO_SOURCE``.  Telemetry must never
        # block the error path, hence the broad suppress.
        import contextlib
        with contextlib.suppress(Exception):
            _db.record_stat(
                None,
                f"{stat_kind}_miss",
                bytes_saved=0,
                tokens_saved=0,
                detail=output_id[:64],
            )
        _error(not_found_msg)
        raise typer.Exit(1)

    # --section: narrow the body to a single markdown section before any other
    # filters are applied.  Allows agents to jump directly to e.g.
    # "## Installation" in a large documentation page, avoiding the cost of
    # returning the entire cached body.
    if section:
        extracted = _extract_body_section(body, section)
        if extracted is None:
            _error(f"section not found in cached output: {section!r}")
            raise typer.Exit(1)
        body = extracted

    # Compile the grep regex once (with fallback to literal on invalid syntax)
    # so the pattern is applied consistently across the line filter and the
    # JSON match count.
    _grep_pat: re.Pattern[str] | None = (
        _compile_grep_pattern(grep, case_sensitive=case_sensitive) if grep else None
    )

    def _grep_matches(line: str) -> bool:
        if _grep_pat is None:
            return True
        return bool(_grep_pat.search(line))

    lines = body.splitlines()
    _slicing_requested = grep or head > 0 or tail > 0 or head_tail
    _grep_footer = ""
    if grep:
        matched = [ln for ln in lines if _grep_matches(ln)]
        match_count = len(matched)
        matched, _grep_footer = _apply_grep_cap(matched, grep_max)
        lines = matched
        # Prepend a match-count header so the agent knows the total even when
        # results are truncated.
        if match_count > 0:
            lines = [f"Match count: {match_count}", *lines]
    if head > 0 and tail > 0:
        # Combine the first ``head`` and last ``tail`` lines. When the two
        # ranges would overlap (head + tail >= total) return every line once
        # instead of duplicating the middle, matching the non-overlapping
        # convention of the ``--head-tail`` preset.
        if head + tail < len(lines):
            lines = [*lines[:head], *lines[-tail:]]
    elif head > 0:
        lines = lines[:head]
    elif tail > 0:
        lines = lines[-tail:]
    if head_tail and not grep:
        lines = _apply_head_tail(lines)
    if not _slicing_requested and not full:
        lines = _apply_smart_default(lines)
    if _grep_footer:
        lines = [*lines, _grep_footer]
    sliced = "\n".join(lines)

    # Record a recall stat so `token-goat stats` reflects the value of avoiding
    # a re-run/re-fetch.  Saving = full cached body − what was actually returned.
    # A full unsliced recall returns everything → saved = 0 (honest).
    # A sliced recall returns less → saved > 0 (real saving).
    _body_bytes = len(body.encode())
    _returned_bytes = len(sliced.encode())
    _saved_bytes = max(0, _body_bytes - _returned_bytes)
    _db.record_stat(
        None,
        stat_kind,
        bytes_saved=_saved_bytes,
        tokens_saved=max(1, _saved_bytes // 3 + 1) if _saved_bytes > 0 else 0,
        detail=output_id[:64],
    )

    if json_output:
        meta = load_output_meta(output_id) or {}
        sidecar = read_sidecar(output_id)
        # Match the surgical-read shape: surface a ``{lineno, text}`` list
        # anchored to the *original* body line numbers (not filtered positions)
        # so an agent can follow up with --head/--tail slicers that map back to
        # the on-disk file.  Duplicate lines map to their first occurrence —
        # same convention as the Read tool.
        original_lines = body.splitlines()
        original_index: dict[str, int] = {}
        for i, ln in enumerate(original_lines, start=1):
            if ln not in original_index:
                original_index[ln] = i
        # The text-mode "Match count:" header and footer are presentation-only
        # for terminal readers; JSON consumers get the count as a structured
        # field instead, with numbered_lines holding only real matches.
        json_lines = [
            ln for ln in lines
            if not ln.startswith("Match count: ") and ln != _grep_footer
        ]
        numbered: list[dict[str, object]] = [
            {"lineno": original_index.get(ln, 0), "text": ln}
            for ln in json_lines
        ]
        payload: dict[str, object] = {
            "output_id": output_id,
            "text": sliced,
            "lines": len(json_lines),
            "numbered_lines": numbered,
            "total_lines": len(original_lines),
        }
        if section:
            payload["section"] = section
        if grep:
            payload["match_count"] = len([ln for ln in original_lines if _grep_matches(ln)])
        payload.update(meta)
        if sidecar is not None:
            payload.update(vars(sidecar))
        typer.echo(json_compact(payload))
        return

    # Text mode: prepend a one-line metadata header showing cache age and key
    # context fields (exit code for bash, status code for web, and a preview).
    # Loading meta + sidecar is fast (small JSON files); the header gives the
    # agent the most useful facts without forcing a --json round-trip.
    sidecar = read_sidecar(output_id)
    _header_parts: list[str] = []
    if sidecar is not None:
        _meta_stat = load_output_meta(output_id)
        if _meta_stat is not None and "mtime" in _meta_stat:
            _age = time.time() - float(_meta_stat["mtime"])
            _header_parts.append(f"cached {_format_age(_age)}")
        # bash sidecar fields
        _exit = getattr(sidecar, "exit_code", None)
        if _exit is not None:
            _header_parts.append(f"exit={_exit}")
        _cmd = getattr(sidecar, "cmd_preview", None)
        if _cmd:
            _header_parts.append(f"$ {_cmd}")
        # web sidecar fields
        _status = getattr(sidecar, "status_code", None)
        if _status is not None:
            _header_parts.append(f"status={_status}")
        _url = getattr(sidecar, "url_preview", None)
        if _url:
            _header_parts.append(_url)
    if _header_parts:
        typer.echo("# " + "  ".join(_header_parts))

    # Safety net: even with smart-default slicing, `--full` recall can dump an unbounded cached body. Cap it so one recall can't overflow context.
    from . import overflow_guard

    _cmd_label = stat_kind.replace("_output_recall", "-output")
    typer.echo(overflow_guard.guard(sliced, command=_cmd_label))


@app.command("bash-output", rich_help_panel="Core")
def cmd_bash_output(
    output_id: str = typer.Argument(..., help="ID returned by the post-bash hook or `bash-history`."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
    case_sensitive: bool = _OPT_CASE_SENSITIVE,
    full: bool = _OPT_FULL,
    head_tail: bool = _OPT_HEAD_TAIL,
    section: str | None = _OPT_SECTION,
    json_output: bool = _OPT_JSON,
    diff: bool = typer.Option(False, "--diff", help="Show unified diff of what was elided by the smart-default trimming (compressed vs full)."),
) -> None:
    """Retrieve a sliced view of a cached Bash output.

    The post-Bash hook stores each non-trivial command output to disk under
    ``data_dir() / "bash_outputs"``. Use this command to retrieve specific
    parts of that output without forcing the agent to re-run the command —
    typically much cheaper in tokens.

    By default (no flags), large outputs are trimmed to the first
    30 lines and last 80 lines with an elision marker.  Pass ``--full`` to
    get everything.  Pass ``--diff`` to see a unified diff of what the
    smart-default trimming removed (lines present in the full output but
    absent from the default view).  Combine ``--head``, ``--tail``,
    ``--grep``, and ``--section`` to narrow further; those flags suppress the
    smart default automatically.  ``--grep`` accepts regex patterns (falls
    back to literal on invalid syntax) and is case-insensitive by default;
    add ``--case-sensitive`` for exact matching.  ``--section HEADING``
    extracts a specific markdown section by heading text (case-insensitive;
    supports ``Heading#2`` for the second occurrence).  Use ``--head-tail``
    to get just the first+last 20 lines (useful for large outputs where you
    only need the gist).  Use ``--grep-max N`` to cap the number of matching
    lines returned (default 20; 0 = no cap).  JSON mode includes the full
    path and stored byte size.
    """
    from . import bash_cache

    if full and diff:
        _error("Use --full or --diff, not both.")
        raise typer.Exit(1)

    if diff:
        import difflib
        body = bash_cache.load_output(output_id)
        if body is None:
            _error(f"no cached output for id: {output_id}")
            raise typer.Exit(1)
        full_lines = body.splitlines()
        compressed_lines = _apply_smart_default(full_lines)
        diff_lines = list(difflib.unified_diff(
            compressed_lines,
            full_lines,
            fromfile="compressed",
            tofile="full",
            lineterm="",
        ))
        if diff_lines:
            typer.echo("\n".join(diff_lines))
        else:
            typer.echo("(no diff: output is short enough that trimming was not applied)")
        return

    _run_output_recall_command(
        output_id=output_id,
        head=head,
        tail=tail,
        grep=grep,
        full=full,
        json_output=json_output,
        cache_module=bash_cache,
        stat_kind="bash_output_recall",
        not_found_msg=f"no cached output for id: {output_id}",
        head_tail=head_tail,
        grep_max=grep_max,
        case_sensitive=case_sensitive,
        section=section,
    )


@app.command("web-output", rich_help_panel="Core")
def cmd_web_output(
    output_id: str | None = typer.Argument(None, help="ID returned by the post-fetch hook or `web-history`. Omit when using --from-session or --list."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
    case_sensitive: bool = _OPT_CASE_SENSITIVE,
    full: bool = _OPT_FULL,
    head_tail: bool = _OPT_HEAD_TAIL,
    section: str | None = _OPT_SECTION,
    json_output: bool = _OPT_JSON,
    from_session: str | None = typer.Option(
        None,
        "--from-session",
        help=(
            "List all web outputs cached during SESSION_ID instead of retrieving a specific entry. "
            "When set, the output_id argument is not required."
        ),
    ),
    list_all: bool = typer.Option(
        False,
        "--list",
        help=(
            "List all cached web outputs (URL, age, size). "
            "When set, the output_id argument is not required."
        ),
    ),
) -> None:
    """Retrieve a sliced view of a cached WebFetch response body.

    The post-WebFetch hook stores each non-trivial text response to disk
    under ``data_dir() / "web_outputs"``. Use this command to retrieve
    specific parts of that body without forcing the agent to re-fetch the
    URL — typically much cheaper in tokens.

    By default (no flags), large outputs are trimmed to the first
    30 lines and last 80 lines with an elision marker.  Pass ``--full`` to
    get everything.  Combine ``--head``, ``--tail``, ``--grep``, and
    ``--section`` to narrow further; those flags suppress the smart default
    automatically.  ``--grep`` accepts regex patterns (falls back to literal
    on invalid syntax) and is case-insensitive by default; add
    ``--case-sensitive`` for exact matching.  ``--section HEADING`` extracts a
    specific markdown section by heading text (case-insensitive; supports
    ``Heading#2`` for the second occurrence of the same heading).  Use
    ``--head-tail`` to get just the first+last 20 lines (useful for large
    documentation pages where you only need the gist).  Use ``--grep-max N``
    to cap the number of matching lines returned (default 20; 0 = no cap).
    JSON mode includes the full path, stored byte size, status code, and a
    1-based ``numbered_lines`` list anchored to the original body.

    Use ``--from-session SESSION_ID`` to list all web outputs cached during a
    specific session without needing to know their IDs in advance.

    Use ``--list`` to list all cached web outputs (URL, age, size).
    """
    from . import web_cache
    from .cache_common import safe_session_fragment

    if list_all:
        # Global listing mode: show all cached web outputs regardless of session.
        all_entries = web_cache.list_outputs()
        if not all_entries:
            typer.echo("(no web outputs cached)")
            return
        if json_output:
            out_list: list[dict[str, object]] = []
            for e in all_entries:
                row = dict(e)
                sidecar = web_cache.read_sidecar(str(e["output_id"]))
                if sidecar is not None:
                    row.update({"url_preview": sidecar.url_preview, "status_code": sidecar.status_code})
                out_list.append(row)
            typer.echo(json_compact(out_list))
            return
        now = time.time()
        for e in all_entries:
            oid = str(e["output_id"])
            size = int(e.get("size_bytes", 0))  # type: ignore[arg-type]
            age = int(now - float(e.get("mtime", now)))  # type: ignore[arg-type]
            sidecar = web_cache.read_sidecar(oid)
            url_str = sidecar.url_preview if sidecar is not None else "(no sidecar)"
            status_str = f" status={sidecar.status_code}" if sidecar is not None and sidecar.status_code is not None else ""
            typer.echo(f"{oid}  {size:>10,}B  {_format_age(age)}{status_str}  {url_str}")
        return

    if from_session is not None:
        # Listing mode: show all web outputs whose ID starts with the session fragment.
        _sess_prefix = safe_session_fragment(from_session) + "-"
        all_entries = web_cache.list_outputs()
        entries = [e for e in all_entries if str(e["output_id"]).startswith(_sess_prefix)]
        if not entries:
            typer.echo(f"(no web outputs cached for session: {from_session})")
            return
        if json_output:
            out: list[dict[str, object]] = []
            for e in entries:
                row = dict(e)
                sidecar = web_cache.read_sidecar(str(e["output_id"]))
                if sidecar is not None:
                    row.update({"url_preview": sidecar.url_preview, "status_code": sidecar.status_code})
                out.append(row)
            typer.echo(json_compact(out))
            return
        now = time.time()
        for e in entries:
            oid = str(e["output_id"])
            size = int(e.get("size_bytes", 0))  # type: ignore[arg-type]  # list_outputs() returns Mapping[str, object]; object is not accepted by int() even though the values are ints
            age = int(now - float(e.get("mtime", now)))  # type: ignore[arg-type]  # same — Mapping[str, object] causes arg-type error for float()
            sidecar = web_cache.read_sidecar(oid)
            url_str = sidecar.url_preview if sidecar is not None else "(no sidecar)"
            status_str = f" status={sidecar.status_code}" if sidecar is not None and sidecar.status_code is not None else ""
            typer.echo(f"{oid}  {size:>10,}B  {age:>6}s ago{status_str}  {url_str}")
        return

    if output_id is None:
        _error("output_id is required unless --from-session or --list is specified")
        raise typer.Exit(2)

    _run_output_recall_command(
        output_id=output_id,
        head=head,
        tail=tail,
        grep=grep,
        full=full,
        json_output=json_output,
        cache_module=web_cache,
        stat_kind="web_output_recall",
        not_found_msg=f"no cached web output for id: {output_id}",
        head_tail=head_tail,
        grep_max=grep_max,
        case_sensitive=case_sensitive,
        section=section,
    )


def _run_history_listing_command(
    cache_module: object,
    *,
    json_output: bool,
    limit: int,
    empty_msg: str,
    json_sidecar_fields: Callable[[object], dict[str, object]],
    format_entry: Callable[[str, int, int, object], str],
    since_secs: float | None = None,
) -> None:
    """Shared implementation for bash-history, web-history, and skill-history.

    ``cache_module`` must expose ``list_outputs()``, which returns a list of
    dicts with at least ``output_id``, ``size_bytes``, and ``mtime`` keys, and
    ``read_sidecar(output_id)`` which returns a sidecar dataclass or ``None``.

    ``json_sidecar_fields`` converts a non-None sidecar into extra key/value
    pairs that are merged into each JSON row.

    ``format_entry(oid, size, age_secs, sidecar)`` produces the human-readable
    line for one entry (sidecar may be ``None``).

    ``since_secs``: when set, only entries whose ``mtime`` is within the last
    ``since_secs`` seconds are returned (applied before the ``limit`` cap).
    """
    list_outputs = cache_module.list_outputs  # type: ignore[attr-defined]  # cache_module typed as object; both bash_cache and web_cache expose this function
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]  # same

    entries = list_outputs()
    if since_secs is not None:
        cutoff = time.time() - since_secs
        entries = [e for e in entries if float(cast("float", e["mtime"])) >= cutoff]
    if limit > 0:
        entries = entries[:limit]

    if json_output:
        out: list[dict[str, object]] = []
        for e in entries:
            sidecar = read_sidecar(str(e["output_id"]))
            row = dict(e)
            if sidecar is not None:
                row.update(json_sidecar_fields(sidecar))
            out.append(row)
        typer.echo(json_compact(out))
        return

    if not entries:
        typer.echo(empty_msg)
        return

    now = time.time()
    for e in entries:
        oid = str(e["output_id"])
        size = int(cast("int", e["size_bytes"]))
        age = int(now - float(cast("float", e["mtime"])))
        sidecar = read_sidecar(oid)
        typer.echo(format_entry(oid, size, age, sidecar))


@app.command("web-history", rich_help_panel="Core")
def cmd_web_history(
    json_output: bool = _OPT_JSON,
    limit: int = _OPT_LIMIT_HISTORY,
) -> None:
    """List cached WebFetch responses, newest first.

    Each row shows the cache ID, byte size, age, status code (when known),
    and a sanitised URL preview.  Use the ID with ``token-goat web-output
    <id>`` to retrieve the body.
    """
    from . import web_cache

    def _json_fields(s: object) -> dict[str, object]:
        return {"url_preview": s.url_preview, "status_code": s.status_code, "truncated": s.truncated, "content_type": s.content_type}  # type: ignore[attr-defined]  # s typed as object; web_cache sidecar dataclass at runtime

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        url_str = s.url_preview if s is not None else "(no sidecar)"  # type: ignore[attr-defined]  # s typed as object; web sidecar dataclass at runtime
        status_str = f" status={s.status_code}" if s is not None and s.status_code is not None else ""  # type: ignore[attr-defined]  # same
        return f"{oid}  {size:>10,}B  {age:>6}s ago{status_str}  {url_str}"

    _run_history_listing_command(
        web_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached WebFetch responses)",
        json_sidecar_fields=_json_fields,
        format_entry=_fmt,
    )


@app.command("mcp-output", rich_help_panel="Core")
def cmd_mcp_output(
    output_id: str = typer.Argument(..., help="ID returned by the post-fetch hook or `mcp-history`."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
    case_sensitive: bool = _OPT_CASE_SENSITIVE,
    full: bool = _OPT_FULL,
    head_tail: bool = _OPT_HEAD_TAIL,
    section: str | None = _OPT_SECTION,
    json_output: bool = _OPT_JSON,
) -> None:
    """Retrieve a sliced view of a cached MCP tool result.

    The post-fetch hook stores each read-only MCP tool result to disk under
    ``data_dir() / "mcp_outputs"``.  Use this command to retrieve specific
    parts of that result without re-running the MCP call — typically much
    cheaper in tokens.

    By default (no flags), large results are trimmed to the first 30 lines and
    last 80 lines with an elision marker.  Pass ``--full`` to get everything.
    Combine ``--head``, ``--tail``, ``--grep``, and ``--section`` to narrow
    further.  ``--grep`` accepts regex patterns (falls back to literal on
    invalid syntax) and is case-insensitive by default; add ``--case-sensitive``
    for exact matching.  ``--section HEADING`` extracts a specific markdown
    section.  JSON mode includes the full path, stored byte size, and sidecar
    metadata (tool name, input preview).
    """
    from . import mcp_cache

    _run_output_recall_command(
        output_id=output_id,
        head=head,
        tail=tail,
        grep=grep,
        full=full,
        json_output=json_output,
        cache_module=mcp_cache,
        stat_kind="mcp_output_recall",
        not_found_msg=f"no cached MCP output for id: {output_id}",
        head_tail=head_tail,
        grep_max=grep_max,
        case_sensitive=case_sensitive,
        section=section,
    )


@app.command("mcp-history", rich_help_panel="Core")
def cmd_mcp_history(
    json_output: bool = _OPT_JSON,
    limit: int = _OPT_LIMIT_HISTORY,
) -> None:
    """List cached MCP tool results, newest first.

    Each row shows the cache ID, byte size, age, the originating tool name,
    and an input preview.  Use the ID with ``token-goat mcp-output <id>`` to
    retrieve the body.
    """
    from . import mcp_cache

    def _json_fields(s: object) -> dict[str, object]:
        return {  # s typed as object; McpOutputMeta dataclass at runtime
            "tool_name": s.tool_name,  # type: ignore[attr-defined]
            "input_preview": s.input_preview,  # type: ignore[attr-defined]
            "result_bytes": s.result_bytes,  # type: ignore[attr-defined]
        }

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        if s is not None:
            tool = s.tool_name or "(unknown)"  # type: ignore[attr-defined]
            preview = s.input_preview or ""  # type: ignore[attr-defined]
            preview_str = f"  {preview[:60]}" if preview else ""
        else:
            tool = "(no sidecar)"
            preview_str = ""
        return f"{oid}  {size:>10,}B  {age:>6}s ago  {tool}{preview_str}"

    _run_history_listing_command(
        mcp_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached MCP results)",
        json_sidecar_fields=_json_fields,
        format_entry=_fmt,
    )


def _parse_since_duration(since: str) -> float | None:
    """Parse a human duration string (e.g. ``'30m'``, ``'2h'``, ``'1d'``) into seconds.

    Returns the number of seconds represented, or ``None`` when the string is
    not recognised.  Accepted suffixes (case-insensitive): ``s`` (seconds),
    ``m`` (minutes), ``h`` (hours), ``d`` (days).  A bare integer is treated as
    seconds.

    >>> _parse_since_duration("30m")
    1800.0
    >>> _parse_since_duration("2h")
    7200.0
    """
    since = since.strip().lower()
    _multipliers = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}
    suffix = since[-1] if since else ""
    multiplier = _multipliers.get(suffix)
    if multiplier is not None:
        try:
            return float(since[:-1]) * multiplier
        except ValueError:
            return None
    # Bare number — treat as seconds
    try:
        return float(since)
    except ValueError:
        return None


@app.command("bash-history", rich_help_panel="Core")
def cmd_bash_history(
    json_output: bool = _OPT_JSON,
    limit: int = _OPT_LIMIT_HISTORY,
    since: str | None = typer.Option(
        None,
        "--since",
        help=(
            "Only show entries newer than this duration (e.g. '30m', '2h', '1d'). "
            "Accepts s/m/h/d suffixes or a bare integer (seconds)."
        ),
    ),
) -> None:
    """List cached Bash outputs, newest first.

    Helpful when you want to find an earlier command's output without
    re-running it.  Each row shows the cache ID, byte size, age, and (if a
    sidecar file is present) the command preview and exit code.  Use the ID
    with ``token-goat bash-output <id>`` to retrieve the body.

    Use ``--since 30m`` to show only entries from the last 30 minutes.
    """
    from . import bash_cache

    since_secs: float | None = None
    if since is not None:
        since_secs = _parse_since_duration(since)
        if since_secs is None:
            _error(f"unrecognised --since value: {since!r}  (expected e.g. '30m', '2h', '1d')")
            raise typer.Exit(2)

    def _json_fields(s: object) -> dict[str, object]:
        return {"cmd_preview": s.cmd_preview, "exit_code": s.exit_code, "truncated": s.truncated}  # type: ignore[attr-defined]  # s typed as object; bash_cache sidecar dataclass at runtime

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        if s is not None:
            preview = s.cmd_preview  # type: ignore[attr-defined]  # same — bash sidecar dataclass
            if len(preview) > 100:
                preview = preview[:100] + "…"
            exit_str = f" [exit:{s.exit_code}]" if s.exit_code is not None else ""  # type: ignore[attr-defined]  # same
        else:
            preview = "(no sidecar)"
            exit_str = ""
        return f"{oid}  {size:>10,}B  {age:>6}s ago{exit_str}  {preview}"

    _run_history_listing_command(
        bash_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached Bash outputs)",
        json_sidecar_fields=_json_fields,
        format_entry=_fmt,
        since_secs=since_secs,
    )


@app.command("history", rich_help_panel="Core")
def cmd_history(
    session_id: str | None = _OPT_SESSION_ID,
    bash: bool = typer.Option(False, "--bash", help="Show bash command history only"),
    web: bool = typer.Option(False, "--web", help="Show URL fetch history only"),
    grep: bool = typer.Option(False, "--grep", help="Show grep pattern history only"),
    limit: int = typer.Option(10, "--limit", "-n", help="Maximum entries per section (default 10)"),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show current session access history: bash commands, URLs, and grep patterns.

    Displays recent bash commands run, URLs fetched, and grep patterns used in
    the current session, most recent first. Each entry shows relevant metadata:
    - Bash: command, exit code, cache status, and size
    - Web: URL, cache status, and size
    - Grep: pattern, file scope, and match counts

    By default (no flags), shows all three sections with up to --limit entries
    per section. Pass ``--bash``, ``--web``, or ``--grep`` to show only one section.

    Use ``--limit`` to control how many entries appear per section.
    """
    import json as json_lib
    import time as time_lib

    from . import session as session_module

    # Validate and resolve session ID
    if session_id:
        _validate_session_id(session_id)
    else:
        _error("--session-id is required")
        raise typer.Exit(1)

    # Load session cache
    cache = session_module.safe_load(session_id)
    if cache is None or cache.unavailable:
        _error(f"Session cache unavailable: {session_id}")
        raise typer.Exit(1)

    # Determine what to show (default: all)
    show_bash = bash or (not bash and not web and not grep)
    show_web = web or (not bash and not web and not grep)
    show_grep = grep or (not bash and not web and not grep)

    current_time = time_lib.time()

    if json_output:
        output = {}

        if show_bash and not cache.is_bash_history_empty():
            entries = []
            for _cmd_sha, entry in list(cache.bash_history.items())[-limit:]:  # type: ignore[assignment]  # mypy overly conservative
                age_secs = int(current_time - entry.ts)
                cached = "yes" if entry.output_id else "no"
                entries.append({
                    "command": entry.cmd_preview,
                    "exit_code": entry.exit_code,
                    "cached": cached,
                    "size_bytes": entry.stdout_bytes + entry.stderr_bytes,
                    "age_seconds": age_secs,
                    "run_count": entry.run_count,
                })
            output["bash"] = entries

        if show_web and not cache.is_web_history_empty():
            entries = []
            for _url_sha, entry in list(cache.web_history.items())[-limit:]:  # type: ignore[assignment]  # mypy overly conservative
                age_secs = int(current_time - entry.ts)
                cached = "yes" if entry.output_id else "no"
                entries.append({
                    "url": entry.url_preview,  # type: ignore[attr-defined]  # mypy overly conservative
                    "cached": cached,
                    "size_kb": entry.body_bytes // 1024,  # type: ignore[attr-defined]  # mypy overly conservative
                    "status_code": entry.status_code,  # type: ignore[attr-defined]  # mypy overly conservative
                    "age_seconds": age_secs,
                })
            output["web"] = entries

        if show_grep and not cache.is_greps_empty():
            entries = []
            for grep_entry in cache.greps[-limit:]:  # type: ignore[index]  # mypy overly conservative
                age_secs = int(current_time - grep_entry.ts)
                entries.append({
                    "pattern": grep_entry.pattern,
                    "path": grep_entry.path,
                    "result_count": grep_entry.result_count,
                    "age_seconds": age_secs,
                })
            output["grep"] = entries

        typer.echo(json_lib.dumps(output, ensure_ascii=False, indent=2))
    else:
        # Text output
        had_output = False

        if show_bash:
            if not cache.is_bash_history_empty():
                typer.echo("## Bash History (most recent first)")
                for _cmd_sha, entry in list(cache.bash_history.items())[-limit:]:  # type: ignore[assignment]  # mypy overly conservative
                    age_secs = int(current_time - entry.ts)
                    exit_str = f" exit={entry.exit_code}" if entry.exit_code is not None else ""
                    cached_str = "cached" if entry.output_id else "not cached"
                    total_bytes = entry.stdout_bytes + entry.stderr_bytes
                    size_mb = total_bytes / (1024 * 1024)
                    size_str = f"{size_mb:.1f} MB" if size_mb >= 1 else f"{total_bytes:,} B"
                    typer.echo(
                        f"  {age_secs:6,}s ago {exit_str:>8} [{cached_str:>12}] {size_str:>12}  {entry.cmd_preview}"
                    )
                had_output = True
            else:
                typer.echo("## Bash History")
                typer.echo("  (no entries)")
                had_output = True

        if show_web:
            if had_output:
                typer.echo()
            if not cache.is_web_history_empty():
                typer.echo("## Web History (most recent first)")
                for _url_sha, entry in list(cache.web_history.items())[-limit:]:  # type: ignore[assignment]  # mypy overly conservative
                    age_secs = int(current_time - entry.ts)
                    cached_str = "cached" if entry.output_id else "not cached"
                    size_kb = entry.body_bytes // 1024  # type: ignore[attr-defined]  # mypy overly conservative
                    status_str = f" status={entry.status_code}" if entry.status_code is not None else ""  # type: ignore[attr-defined]  # mypy overly conservative
                    typer.echo(
                        f"  {age_secs:6,}s ago {status_str:>9} [{cached_str:>12}] {size_kb:>8} KB  {entry.url_preview}"  # type: ignore[attr-defined]  # mypy overly conservative
                    )
                had_output = True
            else:
                typer.echo("## Web History")
                typer.echo("  (no entries)")
                had_output = True

        if show_grep:
            if had_output:
                typer.echo()
            if not cache.is_greps_empty():
                typer.echo("## Grep History (most recent first)")
                for grep_entry in cache.greps[-limit:]:  # type: ignore[index]  # mypy overly conservative
                    age_secs = int(current_time - grep_entry.ts)
                    path_str = f" in {grep_entry.path}" if grep_entry.path else " (global)"
                    result_str = f" → {grep_entry.result_count} matches" if grep_entry.result_count is not None else ""
                    typer.echo(
                        f"  {age_secs:6,}s ago  {grep_entry.pattern}{path_str}{result_str}"
                    )
                had_output = True
            else:
                typer.echo("## Grep History")
                typer.echo("  (no entries)")


@app.command("skill-body", rich_help_panel="Core")
def cmd_skill_body(
    name: str = typer.Argument(..., help="Skill name (e.g. 'ralph', 'plugin:improve')."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    full: bool = _OPT_FULL,
    json_output: bool = _OPT_JSON,
    section: str | None = typer.Option(
        None,
        "--section",
        help=(
            "Extract only the named H2 section from the skill body (case-insensitive prefix match). "
            "When absent, all available section headings are listed below the body output."
        ),
    ),
    compact: bool = typer.Option(
        False,
        "--compact",
        help=(
            "Return a compact summary (~400 tokens) instead of the full body. "
            "Includes description, H2/H3 headings, CRITICAL/MUST/NEVER/RULE lines, "
            "and bold-emphasis directives."
        ),
    ),
) -> None:
    """Retrieve a sliced view of a cached Skill body.

    The PostToolUse(Skill) hook stores each loaded skill body to disk under
    ``data_dir() / "skills"``.  After a compaction event, use this command
    to recall the full skill text (Ralph's DoD gates, /improve's iteration
    sequence, etc.) without re-invoking the skill — which would replay any
    side effects and pollute the conversation with a fresh tool-result block.

    Looks the skill up by name, picking the most-recent cached entry across
    all sessions.  When the on-disk cache has been evicted but the original
    skill file is still resolvable (e.g. ``~/.claude/skills/<name>/SKILL.md``),
    falls back to reading it from there.

    By default (no flags), large bodies are trimmed to the first 30 lines and
    last 80 lines with an elision marker.  Pass ``--full`` to get everything.
    Combine ``--head``, ``--tail``, and ``--grep`` to narrow further.

    Use ``--section DoD`` to extract only the ``## DoD`` section, saving
    thousands of tokens when only one section of a large skill is needed.
    When ``--section`` is absent and the body has H2 headings, the command
    appends a ``**Sections available:** ...`` line listing them.
    """
    from . import compact as _compact
    from . import hooks_skill, skill_cache

    # Walk every cached entry for this skill, newest first.  An older entry's
    # body may still be on disk even when the most-recent entry's body has
    # been LRU-evicted (sidecar + body are unlinked independently inside the
    # byte-cap eviction loop).  This avoids "no cached body" failures when the
    # cache has been partially evicted.
    meta_candidates = skill_cache.lookup_all_by_name(name)
    meta: skill_cache.SkillMeta | None = meta_candidates[0] if meta_candidates else None
    body: str | None = None
    source_label = "cache"
    for candidate in meta_candidates:
        body = skill_cache.load_output(candidate.output_id)
        if body is not None:
            meta = candidate
            break
        # Body evicted; try the source path the hook recorded at capture.
        if candidate.source_path:
            try:
                from pathlib import Path

                body = Path(candidate.source_path).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{candidate.source_path}"
                meta = candidate
                break
            except OSError:
                continue
    # Final fallback: even if no cached entry has a usable body, the skill may
    # still be installed on disk.  Re-resolve the source path at recall time
    # (the install location may have changed since capture, or the original
    # resolve attempt may have failed because the plugin was installed after
    # the body was captured).
    if body is None:
        resolved = hooks_skill._resolve_skill_body_path(name)
        if resolved:
            try:
                from pathlib import Path

                body = Path(resolved).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{resolved}"
            except OSError:
                body = None

    if body is None:
        _error(
            f"no cached body for skill: {name}. "
            "The PostToolUse(Skill) hook captures bodies automatically when skills are invoked. "
            f"To populate the cache: invoke the skill first (Skill(skill={name!r})), "
            "or if the skill file is installed, index it with: "
            "token-goat index --root ~/.claude/skills/"
        )
        raise typer.Exit(1)

    # --compact: return a compact summary (~400 tokens) instead of the full body.
    if compact:
        _compact_session_id = os.environ.get("CLAUDE_SESSION_ID", "")
        # Try cached compact first; generate and store if absent.
        compact_text = skill_cache.get_compact(_compact_session_id, name)
        # Staleness check: compare the sha embedded in the compact header against
        # the current body's sha.  When they differ the compact was generated from
        # an older version of the skill body — warn so callers know the compact may
        # not reflect the latest body content.  This can happen when a skill file
        # is updated on disk between two loads within the same session.
        compact_stale = False
        if compact_text and meta is not None and meta.content_sha:
            compact_sha = skill_cache.extract_compact_source_sha(compact_text)
            if compact_sha is not None and not meta.content_sha.startswith(compact_sha):
                compact_stale = True
                _LOG.info(
                    "skill-body --compact: stale compact for %s "
                    "(compact sha=%s, body sha=%s…); regenerating",
                    name, compact_sha, meta.content_sha[:12],
                )
                # Regenerate from the current body so the user gets fresh content.
                compact_text = None
        if not compact_text:
            compact_text = skill_cache.generate_compact_summary(body)
            body_sha = meta.content_sha if meta is not None else None
            skill_cache.store_compact(_compact_session_id, name, compact_text, source_sha=body_sha)
            compact_stale = False  # freshly generated — no longer stale
        # Normalise: strip the stored-file header (added by store_compact) so we
        # can always prepend a fresh one.  get_compact() returns the stored bytes
        # verbatim (header included), while a freshly generated compact has no
        # header yet — stripping is idempotent when no header is present.
        compact_bare = skill_cache._strip_compact_header(compact_text)
        compact_tokens = max(1, _compact.estimate_tokens(compact_bare))
        compact_display = f"--- compact form ({compact_tokens} tokens) ---\n{compact_bare}"
        body_bytes, _, _, _ = _record_body_recall_stat(
            body,
            compact_display,
            "skill_body_recall",
            f"{name[:48]}:compact",
        )
        if json_output:
            payload_c: dict[str, object] = {
                "skill_name": name,
                "compact": True,
                "source": source_label,
                "text": compact_display,
                "body_bytes": body_bytes,
                "compact_stale": compact_stale,
            }
            if meta is not None:
                payload_c["output_id"] = meta.output_id
            typer.echo(json_compact(payload_c))
        else:
            typer.echo(compact_display)
        return

    # --section: extract a single named H2/H3/H4 section from the body.
    if section:
        section_text = skill_cache.extract_named_section(body, section)
        if section_text is None:
            all_headings = skill_cache.extract_all_headings(body, max_level=4)
            if all_headings:
                heading_labels = [
                    f"    {title}" if level >= 4 else (f"  {title}" if level >= 3 else title)
                    for level, title in all_headings
                ]
                _error(
                    f"section {section!r} not found in skill {name!r}. "
                    f"Available (##, ###, ####): {', '.join(heading_labels)}"
                )
            else:
                _error(f"section {section!r} not found in skill {name!r} (no headings detected)")
            raise typer.Exit(1)
        sliced = section_text
        # Record stat for the bytes saved vs. full body.
        body_bytes, _, _, _ = _record_body_recall_stat(
            body,
            sliced,
            "skill_body_recall",
            f"{name[:48]}::{section[:16]}",
        )
        if json_output:
            payload: dict[str, object] = {
                "skill_name": name,
                "section": section,
                "source": source_label,
                "text": sliced,
                "body_bytes": body_bytes,
            }
            if meta is not None:
                payload["output_id"] = meta.output_id
            typer.echo(json_compact(payload))
        else:
            typer.echo(sliced)
        return

    lines = _apply_recall_filters(body.splitlines(), head=head, tail=tail, grep=grep, full=full)
    sliced = "\n".join(lines)

    # Append a sections-available line when headings exist and we're in text mode.
    # Include H2, H3, and H4 headings so subsections of large skills (ralph, improve, etc.)
    # are discoverable — extract_named_section can reach them but they were previously
    # invisible, leaving H3/H4-only sections like "Wild Ideas Phase" or "Operating Modes"
    # unreachable without knowing the exact name in advance.
    if not json_output and not section:
        all_headings = skill_cache.extract_all_headings(body, max_level=4)
        if all_headings:
            # Prefix H3 headings with two spaces, H4 with four, so depth is visually distinct.
            heading_labels = [
                f"    {title}" if level >= 4 else (f"  {title}" if level >= 3 else title)
                for level, title in all_headings
            ]
            sliced = sliced + "\n\n**Sections available:** " + ", ".join(heading_labels)

    # Record a recall stat so `token-goat stats` reflects the value of avoiding
    # a re-load (and the side effects + tool-result block that come with it).
    body_bytes, returned_bytes, saved_bytes, _tokens_saved = _record_body_recall_stat(
        body,
        sliced,
        "skill_body_recall",
        name[:64],
    )

    if json_output:
        original_lines = body.splitlines()
        original_index: dict[str, int] = {}
        for i, ln in enumerate(original_lines, start=1):
            if ln not in original_index:
                original_index[ln] = i
        numbered: list[dict[str, object]] = [
            {"lineno": original_index.get(ln, 0), "text": ln}
            for ln in lines
        ]
        payload2: dict[str, object] = {
            "skill_name": name,
            "source": source_label,
            "text": sliced,
            "lines": len(lines),
            "numbered_lines": numbered,
            "total_lines": len(original_lines),
            "body_bytes": body_bytes,
        }
        if meta is not None:
            payload2["output_id"] = meta.output_id
            payload2["content_sha"] = meta.content_sha
            payload2["ts"] = meta.ts
            payload2["truncated"] = meta.truncated
            payload2["source_path"] = meta.source_path
        typer.echo(json_compact(payload2))
        return

    typer.echo(sliced)


def _resolve_skill_body_for_compact(
    name: str,
) -> tuple[str | None, Any | None, str]:
    """Resolve the skill body, meta, and source label for ``skill-compact``.

    Shared by the single-skill and ``--all`` code paths to avoid duplication.
    Returns ``(body, meta, source_label)``; *body* is ``None`` when the skill
    cannot be located.  *meta* is a :class:`skill_cache.SkillMeta` or ``None``.
    """
    from . import hooks_skill
    from . import skill_cache as skill_cache_mod

    meta_candidates = skill_cache_mod.lookup_all_by_name(name)
    meta: skill_cache_mod.SkillMeta | None = meta_candidates[0] if meta_candidates else None
    body: str | None = None
    source_label = "cache"
    for candidate in meta_candidates:
        body = skill_cache_mod.load_output(candidate.output_id)
        if body is not None:
            meta = candidate
            break
        if candidate.source_path:
            try:
                from pathlib import Path

                body = Path(candidate.source_path).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{candidate.source_path}"
                meta = candidate
                break
            except OSError:
                continue
    if body is None:
        resolved = hooks_skill._resolve_skill_body_path(name)
        if resolved:
            try:
                from pathlib import Path

                body = Path(resolved).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{resolved}"
            except OSError:
                body = None
    return body, meta, source_label


def _generate_compact_for_body(
    body: str,
    name: str,
    meta: Any | None,
    session_id: str,
) -> tuple[str, str, str]:
    """Generate a compact for *body* and store it in the cache.

    Returns ``(compact_display, compact_source, body_sha_or_empty)``.
    *compact_display* is the full display text including the header line.
    """
    from . import compact as _compact
    from . import skill_cache as skill_cache_mod

    marker_compact = skill_cache_mod.extract_compact_from_marker(body)
    compact_text = (
        marker_compact if marker_compact is not None
        else skill_cache_mod.generate_compact_summary(body)
    )
    compact_source = "marker" if marker_compact is not None else "auto"
    body_sha = meta.content_sha if meta is not None else None
    skill_cache_mod.store_compact(session_id, name, compact_text, source_sha=body_sha)
    compact_tokens = max(1, _compact.estimate_tokens(compact_text))
    compact_display = f"--- compact form ({compact_tokens} tokens) ---\n{compact_text}"
    return compact_display, compact_source, (body_sha or "")


@app.command("skill-compact", rich_help_panel="Core")
def cmd_skill_compact(
    name: str = typer.Argument(
        None,  # type: ignore[assignment]
        help="Skill name (e.g. 'ralph', 'plugin:improve'). Omit with --all to process every cached skill.",
    ),
    json_output: bool = _OPT_JSON,
    all_skills: bool = typer.Option(
        False,
        "--all",
        help=(
            "Regenerate compacts for every skill cached in the current session "
            "whose stored compact is stale (source SHA mismatch) or absent. "
            "Skips skills with a fresh compact already on disk. "
            "Prints a one-line status for each skill processed."
        ),
    ),
) -> None:
    """Generate and print a compact summary (~400 tokens) for a cached skill body.

    Extracts from the full body:

    * The YAML frontmatter ``description`` field (if present).
    * All H2 and H3 headings as a table of contents.
    * Lines containing CRITICAL/MUST/NEVER/RULE keywords (first unique occurrence).
    * Lines starting with ``**`` (bold directives).

    The result is capped at 1600 characters (~400 tokens).  The compact is also
    stored in the skill cache under ``{session}-{name}-compact`` for instant
    recall via ``token-goat skill-body --compact <name>``.

    Use ``--all`` to regenerate compacts for all skills in the current session
    that are stale or have no compact yet.  Useful after a skill is updated on
    disk between loads — the staleness check compares the SHA embedded in the
    stored compact header against the body's current content SHA.
    """
    from . import skill_cache

    _compact_session_id = os.environ.get("CLAUDE_SESSION_ID", "")

    # ── --all mode: batch-regenerate stale or missing compacts ────────────────
    if all_skills:
        if name is not None:
            _error("Cannot combine a skill NAME argument with --all.")
            raise typer.Exit(1)

        # First pass: pre-generate compacts for all skill files on disk.
        # This covers skills that have never been loaded in any session.
        from . import install as _install_mod
        try:
            pregen_summary = _install_mod.pregen_skill_compacts()
            if not json_output:
                typer.echo(f"  [pre-gen: {pregen_summary}]")
        except Exception as _pregen_exc:
            _LOG.warning("skill-compact --all: pregen pass failed: %s", _pregen_exc)
            if not json_output:
                typer.echo(f"  [pre-gen: FAILED — {_pregen_exc}]")

        # Enumerate unique skill names visible in the current session (or, when
        # no session is set, all entries in the cache directory).
        if _compact_session_id:
            from . import session as _session_mod
            session_cache = _session_mod.load(_compact_session_id)
            skill_names_raw: list[str] = list(
                {entry.skill_name for entry in skill_cache.list_by_session(_compact_session_id)}
            )
            # Also include skills recorded in the session skill_history dict, which may
            # differ slightly in name normalisation from the cache file list.
            for sname in (getattr(session_cache, "skill_history", None) or {}):
                if sname not in skill_names_raw:
                    skill_names_raw.append(sname)
        else:
            # No session: process all unique skill names across the whole cache.
            skill_names_raw = list(
                {
                    meta.skill_name
                    for entry in skill_cache.list_outputs()
                    if (oid := entry.get("output_id"))
                    and not oid.endswith("-compact")
                    and (meta := skill_cache.read_sidecar(oid)) is not None
                }
            )

        if not skill_names_raw:
            msg = "No cached skills found"
            if _compact_session_id:
                msg += f" for session {_compact_session_id[:16]}"
            typer.echo(msg + ".")
            return

        processed = 0
        skipped = 0
        failed = 0
        results: list[dict[str, object]] = []

        for sname in sorted(skill_names_raw):
            body, meta, source_label = _resolve_skill_body_for_compact(sname)
            if body is None:
                if json_output:
                    results.append({"skill_name": sname, "status": "not_found"})
                else:
                    typer.echo(f"  {sname}: not found (skipped)")
                failed += 1
                continue

            # Staleness check: does an up-to-date compact already exist?
            body_sha = meta.content_sha if meta is not None else ""
            existing_compact = skill_cache.get_compact(_compact_session_id, sname)
            if existing_compact and body_sha:
                compact_sha = skill_cache.extract_compact_source_sha(existing_compact)
                if compact_sha is not None and body_sha.startswith(compact_sha):
                    if json_output:
                        results.append({
                            "skill_name": sname,
                            "status": "up_to_date",
                        })
                    else:
                        typer.echo(f"  {sname}: up-to-date (skipped)")
                    skipped += 1
                    continue

            # Generate and store the compact.
            try:
                compact_display, compact_source, _sha = _generate_compact_for_body(
                    body, sname, meta, _compact_session_id
                )
                body_bytes, _, saved_bytes, _tokens_saved = _record_body_recall_stat(
                    body,
                    compact_display,
                    "skill_body_recall",
                    f"{sname[:48]}:compact:{compact_source}:all",
                )
                if json_output:
                    results.append({
                        "skill_name": sname,
                        "status": "regenerated",
                        "compact_source": compact_source,
                        "body_bytes": body_bytes,
                        "saved_bytes": saved_bytes,
                        "saved_tokens": _tokens_saved,
                    })
                else:
                    typer.echo(f"  {sname}: regenerated ({compact_source}, saved {_tokens_saved} tokens)")
                processed += 1
            except Exception as exc:
                if json_output:
                    results.append({"skill_name": sname, "status": "error", "error": str(exc)})
                else:
                    typer.echo(f"  {sname}: error — {exc}")
                failed += 1

        if json_output:
            typer.echo(json_compact({
                "all": True,
                "processed": processed,
                "skipped": skipped,
                "failed": failed,
                "skills": results,
            }))
        else:
            typer.echo(
                f"\nDone: {processed} regenerated, {skipped} up-to-date, {failed} failed/not-found."
            )
        return

    # ── Single-skill mode ─────────────────────────────────────────────────────
    if name is None:
        _error("Provide a skill NAME or use --all to process every cached skill.")
        raise typer.Exit(1)

    body, meta, source_label = _resolve_skill_body_for_compact(name)

    if body is None:
        _error(
            f"no cached body for skill: {name}. "
            "Invoke the skill first to populate the cache, "
            "or index the skill directory: token-goat index --root ~/.claude/skills/"
        )
        raise typer.Exit(1)

    compact_display, compact_source, body_sha = _generate_compact_for_body(
        body, name, meta, _compact_session_id
    )

    body_bytes, returned_bytes, saved_bytes, _tokens_saved = _record_body_recall_stat(
        body,
        compact_display,
        "skill_body_recall",
        f"{name[:48]}:compact:{compact_source}",
    )

    if json_output:
        # Strip header from compact_display to get the bare body for quality scoring.
        compact_bare = skill_cache._strip_compact_header(compact_display)
        quality = skill_cache.score_compact(compact_bare, body)
        payload: dict[str, object] = {
            "skill_name": name,
            "compact": True,
            "compact_source": compact_source,
            "source": source_label,
            "text": compact_display,
            "body_bytes": body_bytes,
            "returned_bytes": returned_bytes,
            "saved_bytes": saved_bytes,
            "saved_tokens": _tokens_saved,
            "compact_quality": quality,
        }
        if meta is not None:
            payload["output_id"] = meta.output_id
        typer.echo(json_compact(payload))
    else:
        typer.echo(compact_display)


@app.command("compact-doc", rich_help_panel="Core")
def cmd_compact_doc(
    path: Path = typer.Argument(..., help="Path to the reference document to compact (must be .md or .markdown)."),  # noqa: B008
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite an existing compact even if it is already fresh."),
    sentences: int = typer.Option(
        2,
        "--sentences",
        "-s",
        help="Number of content lines to extract per section heading (default 2).",
    ),
    show: bool = typer.Option(False, "--show", help="Print the compact body to stdout after writing."),
) -> None:
    """Create an extractive compact sidecar for a large reference document.

    The compact is a headings + first-N-sentences-per-section summary stored
    beside the project's token-goat data dir.  On the next session, pre_read
    serves the compact instead of the full file, saving 80–95% of context
    tokens on the first read.

    The compact is invalidated automatically when the source file is edited.
    Re-run this command (or use --force) to regenerate it.

    Examples::

        token-goat compact-doc docs/api-reference.md
        token-goat compact-doc docs/api-reference.md --force
        token-goat compact-doc docs/api-reference.md --sentences 3 --show
    """
    from . import doc_compact as _dc
    from .project import find_project

    abs_path = Path(path).resolve()
    if not abs_path.exists():
        _error(f"File not found: {_format_path_output(abs_path)}")
        raise typer.Exit(1)
    suffix = abs_path.suffix.lower()
    if suffix not in {".md", ".markdown"}:
        _error(f"Only .md / .markdown files are supported (got {suffix!r}).")
        raise typer.Exit(1)

    proj = find_project(abs_path.parent)
    if proj is None:
        _error("Could not find a token-goat project for this path. Is token-goat installed in this repo?")
        raise typer.Exit(1)

    compact_path = _dc.compact_path_for(abs_path, proj.hash)

    if compact_path.exists() and not force and _dc.is_compact_fresh(compact_path, abs_path):
            typer.echo(f"Compact is already fresh: {compact_path}")
            body = _dc.read_compact_body(compact_path)
            if body:
                full_bytes = abs_path.stat().st_size
                compact_bytes = len(body.encode())
                full_tok = max(1, full_bytes // 4)
                compact_tok = max(1, compact_bytes // 4)
                pct = int(compact_tok * 100 / full_tok)
                typer.echo(f"Size: {compact_tok:,} tokens ({pct}% of original {full_tok:,} tokens) — use --force to regenerate")
            raise typer.Exit(0)

    try:
        source_text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _error(f"Cannot read {_format_path_output(abs_path)}: {exc}")
        raise typer.Exit(1) from exc

    body = _dc.build_extractive_compact(source_text, max_sentences=sentences)

    try:
        rel = abs_path.relative_to(Path.cwd())
    except ValueError:
        rel = abs_path

    _dc.write_compact(compact_path, abs_path, body, source_rel=str(rel))

    full_bytes = abs_path.stat().st_size
    compact_bytes = len(body.encode())
    full_tok = max(1, full_bytes // 4)
    compact_tok = max(1, compact_bytes // 4)
    pct = int(compact_tok * 100 / full_tok)
    typer.echo(f"Compact written: {compact_path}")
    typer.echo(f"Size: {compact_tok:,} tokens ({pct}% of original {full_tok:,} tokens)")

    if show:
        typer.echo("")
        typer.echo(body)


@app.command("skill-history", rich_help_panel="Core")
def cmd_skill_history(
    json_output: bool = _OPT_JSON,
    limit: int = _OPT_LIMIT_HISTORY,
) -> None:
    """List cached Skill bodies, newest first.

    Each row shows the skill name, byte size, age, and (if a sidecar is
    present) the truncation flag and source path.  Use the name with
    ``token-goat skill-body <name>`` to retrieve the body.
    """
    from . import skill_cache

    def _json_fields(s: object) -> dict[str, object]:
        return {"skill_name": s.skill_name, "body_bytes": s.body_bytes, "truncated": s.truncated, "source_path": s.source_path}  # type: ignore[attr-defined]  # s typed as object; skill_cache sidecar dataclass at runtime

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        name_str = s.skill_name if s is not None else "(no sidecar)"  # type: ignore[attr-defined]  # same — skill sidecar dataclass
        trunc_str = " (truncated)" if s is not None and s.truncated else ""  # type: ignore[attr-defined]  # same
        return f"{oid}  {size:>10,}B  {age:>6}s ago  {name_str}{trunc_str}"

    _run_history_listing_command(
        skill_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached Skill bodies)",
        json_sidecar_fields=_json_fields,
        format_entry=_fmt,
    )


@app.command("skill-diff", rich_help_panel="Core")
def cmd_skill_diff(
    name: str = typer.Argument(..., help="Skill name to diff (e.g. 'ralph', 'plugin:improve')."),
) -> None:
    """Show a unified diff between the two most recent cached versions of a Skill.

    When a skill is updated between loads within a session, token-goat stores
    each distinct body as a separate cache entry.  This command finds all
    entries for *name* across all sessions, sorts them by modification time
    newest-first, and diffs the two most recent using ``difflib.unified_diff``.

    If only one version is cached, a brief message is printed instead.
    Colour is applied when the terminal supports it: ``-`` lines are red,
    ``+`` lines are green, header lines are bold.
    """
    import difflib
    import sys

    from . import skill_cache

    # Collect all cached versions for this skill name, newest first.
    all_entries = skill_cache.list_outputs()
    safe_name = name.replace(":", "_")

    # Filter by matching skill name embedded in output_id (last segment before sha is safe_name).
    # Fall back to sidecar skill_name comparison for entries with sidecars.
    matching: list[tuple[float, str]] = []  # (mtime, output_id)
    for entry in all_entries:
        oid = entry.get("output_id", "")
        if not oid:
            continue
        # Try fast path: output_id = {session}-{safe_name}-{sha16}
        # Find whether safe_name appears as a middle segment.
        parts = oid.split("-")
        # session prefix is 16 chars; sha is last 16 chars; middle is skill name.
        if len(parts) >= 3:
            # middle segments joined (safe_name may contain underscores, not hyphens)
            mid = "-".join(parts[1:-1])
            if mid == safe_name:
                matching.append((float(entry.get("mtime", 0.0)), oid))
                continue
        # Fallback: check sidecar
        meta = skill_cache.read_sidecar(oid)
        if meta is not None and meta.skill_name == name:
            matching.append((float(entry.get("mtime", 0.0)), oid))

    # Sort newest first
    matching.sort(key=lambda t: t[0], reverse=True)

    if not matching:
        _error(f"no cached versions found for skill: {name}")
        raise typer.Exit(1)

    if len(matching) == 1:
        typer.echo(f"Only one cached version of '{name}' found — nothing to diff.")
        raise typer.Exit(0)

    # Load the two most recent bodies
    newer_oid = matching[0][1]
    older_oid = matching[1][1]
    newer_body = skill_cache.load_output(newer_oid) or ""
    older_body = skill_cache.load_output(older_oid) or ""

    newer_lines = newer_body.splitlines(keepends=True)
    older_lines = older_body.splitlines(keepends=True)

    diff = list(difflib.unified_diff(
        older_lines,
        newer_lines,
        fromfile=f"{name} (older: {older_oid[-16:]})",
        tofile=f"{name} (newer: {newer_oid[-16:]})",
        lineterm="",
    ))

    if not diff:
        typer.echo(f"No differences between the two most recent cached versions of '{name}'.")
        raise typer.Exit(0)

    # Apply colour when stdout is a TTY
    use_colour = sys.stdout.isatty()
    for line in diff:
        if use_colour:
            if line.startswith(("+++", "---", "@@")):
                typer.echo(typer.style(line, bold=True))
            elif line.startswith("+"):
                typer.echo(typer.style(line, fg=typer.colors.GREEN))
            elif line.startswith("-"):
                typer.echo(typer.style(line, fg=typer.colors.RED))
            else:
                typer.echo(line)
        else:
            typer.echo(line)


@app.command("skill-size", rich_help_panel="Core")
def cmd_skill_size(
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
) -> None:
    """Show size and estimated per-session overhead for all cached skills.

    For each cached skill, displays:
    - Name of the skill
    - Total tokens (~body_chars/3, using the canonical token estimator)
    - Compact tokens (~compact_chars/3, using the canonical token estimator)
    - Per-100-turn overhead (compact_tokens * 100, worst-case if loaded in every turn)
    - Flag: "⚠ restructure" if overhead > 50,000 tokens

    When --session-id is provided, filters skills to that session.
    When omitted, shows all cached skills across all sessions.

    Results are sorted by overhead descending (highest overhead first).
    Total line shows cumulative overhead across all skills.
    """
    from . import skill_cache

    skills = skill_cache.get_all_cached_skills(session_id)

    if not skills:
        if session_id:
            typer.echo(f"No cached skills for session: {session_id}")
        else:
            typer.echo("No cached skills found")
        raise typer.Exit(0)

    # Calculate metrics for each skill.
    items: list[dict[str, object]] = []
    total_overhead = 0

    for skill in skills:
        name = str(skill["name"])
        body_len = int(skill["body_len"])  # type: ignore[call-overload]
        compact_len = int(skill["compact_len"])  # type: ignore[call-overload]

        # Prefer char-based counts when available (added in get_all_cached_skills
        # iter-5).  Chars give a consistent token estimate matching the canonical
        # ``compact.estimate_tokens`` formula (max(1, len(text) // 3 + 1)) and
        # avoid inflating the count with UTF-8 multi-byte overhead or the stored
        # header line.  Fall back to byte-based counts for older cache entries.
        body_chars = skill.get("body_chars")  # type: ignore[union-attr]
        body_measure = int(body_chars) if isinstance(body_chars, int) else body_len  # type: ignore[call-overload]

        # Estimate tokens using the canonical estimator: ~3 chars/token (conservative).
        # Mirrors compact.estimate_tokens(text) = max(1, len(text) // 3 + 1).
        body_tokens = max(1, body_measure // 3 + 1)
        # compact_chars: char count of the compact *body* (header stripped), set
        # by get_all_cached_skills when compact text is present.  When absent or
        # zero, fall back to body_measure so overhead is not misleadingly zero.
        compact_chars = skill.get("compact_chars")  # type: ignore[union-attr]
        compact_measure = (
            int(compact_chars)  # type: ignore[call-overload]
            if isinstance(compact_chars, int) and int(compact_chars) > 0  # type: ignore[call-overload]
            else (compact_len if compact_len > 0 else body_measure)
        )
        compact_tokens = max(1, compact_measure // 3 + 1)
        compact_is_estimated = compact_len == 0

        # Worst-case overhead at 100 turns: loaded in every turn.
        per_100_overhead = compact_tokens * 100

        flag = "⚠ restructure" if per_100_overhead > 50_000 else ""
        if compact_is_estimated:
            flag = (flag + " (no compact, using body estimate)").strip()

        items.append({
            "name": name,
            "body_tokens": body_tokens,
            "compact_tokens": compact_tokens,
            "compact_is_estimated": compact_is_estimated,
            "per_100_overhead": per_100_overhead,
            "flag": flag,
        })

        total_overhead += per_100_overhead

    # Sort by overhead descending.
    items.sort(key=lambda x: int(x["per_100_overhead"]), reverse=True)  # type: ignore[call-overload]

    if json_output:
        output: dict[str, object] = {
            "session_id": session_id,
            "skills": items,
            "total_overhead_at_100_turns": total_overhead,
        }
        _emit_json(output)

    # Human-readable output.
    for item in items:
        name = str(item["name"])
        body_tokens = int(item["body_tokens"])  # type: ignore[call-overload]
        compact_tokens = int(item["compact_tokens"])  # type: ignore[call-overload]
        per_100_overhead = int(item["per_100_overhead"])  # type: ignore[call-overload]
        flag = str(item["flag"])

        overhead_k = per_100_overhead / 1_000.0
        line = f"{name:40} body:~{body_tokens:>6}  compact:~{compact_tokens:>5}  per-100:~{overhead_k:>6.0f}k"
        if flag:
            line += f"  {flag}"
        typer.echo(line)

    typer.echo()
    total_k = total_overhead / 1_000.0
    typer.echo(f"Total overhead at 100 turns: ~{total_k:.0f}k tokens")


@app.command("baseline", rich_help_panel="Core")
def cmd_baseline(
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    subagent: bool = typer.Option(
        False,
        "--subagent",
        help="Show only the fixed sources a freshly spawned subagent inherits, framed as its starting context fill.",
    ),
    window: int = typer.Option(
        baseline_mod.DEFAULT_WINDOW_TOKENS,
        "--window",
        help="Context-window size (tokens) used as the pct-of-window denominator. Default 200,000 (the model window).",
    ),
    usage: bool = typer.Option(
        False,
        "--usage",
        help="Annotate rows with historical call counts from project transcripts; flags zero-use skills and MCP servers as removal candidates.",
    ),
) -> None:
    """Attribute the session's environmental context baseline (the "expense report").

    Scans the persisted SessionStart/UserPromptSubmit hook dumps, both CLAUDE.md
    files, this project's MEMORY.md, the skill listing, and the configured MCP
    servers; costs each at ~4 bytes/token (matching ``token-goat doctor``); and
    ranks them by token cost with an owner (you / harness / ``plugin:<name>``) and a
    concrete fix. This is the invisible context a spawned subagent inherits before it
    does any work.

    Read-only. Complements ``token-goat doctor`` (which covers loaded-skill bodies
    and conversation) — loaded-skill body cost is not repeated here.

    Detection picks the current session from ``CLAUDE_SESSION_ID``, the
    ``--session-id`` flag, or the most-recently-active session.

    Examples::

        token-goat baseline
        token-goat baseline --subagent
        token-goat baseline --usage
        token-goat baseline --json
        token-goat baseline --window 1000000
    """
    report = baseline_mod.collect_baseline(Path.cwd(), session_id, window_tokens=window, usage=usage)
    if json_output:
        _emit_json(report.as_dict())
    for line in baseline_mod.format_report(report, subagent=subagent):
        typer.echo(line)


@app.command("skill-list", rich_help_panel="Core")
def cmd_skill_list(
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
) -> None:
    """List skills cached in the current (or specified) session.

    For each cached skill, displays:
    - Skill name
    - Cached token count (~body_chars/3, using the canonical token estimator)
    - Whether a compact slice is available and its token count
    - Hits: how many times the compact was inlined in a PreCompact manifest this session
      ("-" when no compact exists; "0" when compact exists but not yet served)
    - Age: when the skill was cached (seconds ago)

    When --session-id is omitted, the most-recently active session in the
    cache directory is used.  Pass --session-id to inspect a specific session.

    Useful after a compaction event to confirm which skills are recoverable
    via ``token-goat skill-body <name>``.
    """
    import time as _time

    from . import compact as _compact
    from . import session as _session_mod
    from . import skill_cache

    # Resolve session_id: use the provided one or fall back to most-recent session.
    resolved_session = session_id
    if resolved_session is None:
        # Find the most-recently modified session file in the skills cache.
        outputs = skill_cache.list_outputs()
        if not outputs:
            typer.echo("No cached skills found (no skills have been loaded in any session).")
            raise typer.Exit(0)
        # list_outputs() returns newest-first; extract session prefix from first entry.
        first_oid = outputs[0].get("output_id", "")
        # Session prefix is the first 16 chars of the output_id.
        resolved_session = first_oid[:16] if len(first_oid) >= 16 else first_oid

    if not resolved_session:
        typer.echo("No cached skills found.")
        raise typer.Exit(0)

    entries = skill_cache.list_by_session(resolved_session)
    if not entries:
        typer.echo(f"No cached skills for session: {resolved_session}")
        raise typer.Exit(0)

    # Enrich each entry with compact availability and timestamps from list_outputs().
    # Build a lookup: output_id -> mtime from list_outputs (which has mtime).
    mtime_by_oid: dict[str, float] = {}
    for entry in skill_cache.list_outputs():
        oid = entry.get("output_id")
        if oid:
            mtime_by_oid[oid] = float(entry.get("mtime", 0.0))

    now = _time.time()
    rows: list[dict[str, object]] = []

    # Build a lookup of compact_served_count from the live session history.
    # This is the per-session hit counter incremented each time the compact
    # form is inlined into a PreCompact manifest — distinct from run_count
    # (how many times the skill was loaded) and compact availability (whether
    # a compact exists at all).
    _compact_hit_by_name: dict[str, int] = {}
    try:
        _skill_entries = _session_mod.get_skill_history(resolved_session)
        for _sk_name, _sk_entry in (_skill_entries or {}).items():
            _compact_hit_by_name[_sk_name] = getattr(_sk_entry, "compact_served_count", 0)
    except Exception:
        _LOG.debug("skill list: failed to load compact-hit counts for session %s", resolved_session, exc_info=True)

    for meta in entries:
        mtime = mtime_by_oid.get(meta.output_id, meta.ts)
        age_secs = max(0.0, now - mtime) if mtime > 0 else -1.0

        # Load the body to get accurate token count and compact availability.
        body = skill_cache.load_output(meta.output_id)
        body_text = body or ""
        body_tokens = _compact.estimate_tokens(body_text) if body_text else 0

        compact_text = skill_cache.get_compact(resolved_session, meta.skill_name)
        if compact_text is None:
            # Normalise plugin-namespaced name (underscore vs colon) for lookup.
            alt_name = meta.skill_name.replace("_", ":")
            compact_text = skill_cache.get_compact(resolved_session, alt_name)
        has_compact = compact_text is not None

        compact_body = skill_cache._strip_compact_header(compact_text) if compact_text else ""
        compact_tokens = _compact.estimate_tokens(compact_body) if compact_body else 0

        # Compute compact age (seconds since compact file was last written) so
        # users can distinguish a freshly-generated compact from one that is days
        # old.  This is independent of body age (age_secs) — a body can be loaded
        # once and then have its compact regenerated many times.
        compact_mtime = skill_cache.get_compact_mtime(resolved_session, meta.skill_name)
        if compact_mtime is None and has_compact:
            # Also try the alt_name form for plugin-namespaced skills.
            alt_name_compact = meta.skill_name.replace("_", ":")
            compact_mtime = skill_cache.get_compact_mtime(resolved_session, alt_name_compact)
        compact_age_secs: int | None = round(now - compact_mtime) if compact_mtime is not None else None

        compact_served_count = _compact_hit_by_name.get(meta.skill_name, 0)

        # Determine whether the cached compact is stale relative to the body.
        # A compact is stale when its embedded source_sha (written by store_compact)
        # does not match the body's content_sha from the sidecar.  When no compact
        # exists, compact_stale is None (not applicable).  When the compact predates
        # source-sha tracking (no embedded sha), compact_stale is also None because
        # we cannot determine staleness without the reference hash.
        compact_stale: bool | None = None
        if has_compact and compact_text:
            compact_src_sha = skill_cache.extract_compact_source_sha(compact_text) or ""
            body_sha = meta.content_sha or ""
            if compact_src_sha and body_sha:
                # Compare by prefix length of the stored compact SHA fragment
                # (store_compact embeds only the first 12 hex chars).
                frag_len = len(compact_src_sha)
                compact_stale = body_sha[:frag_len] != compact_src_sha

        # Score the compact quality when a compact exists.
        compact_quality: dict[str, object] | None = None
        compact_quality_score: int | None = None
        compact_quality_issues: list[str] | None = None
        if has_compact and compact_body and body_text:
            compact_quality = skill_cache.score_compact(compact_body, body_text)
            compact_quality_score = int(compact_quality["score"])  # type: ignore[call-overload]
            compact_quality_issues = list(compact_quality.get("issues", []))  # type: ignore[call-overload]

        # Compute a per-skill compact coverage score (0-100) that combines
        # availability (has_compact), freshness (not stale), and quality.
        # Components:
        #   +50 if has_compact
        #   +30 if compact is fresh or freshness is unknown (not explicitly stale)
        #   +20 scaled from compact_quality_score (0-100 → 0-20)
        # A skill with a fresh, high-quality compact scores near 100.
        # A skill with no compact at all scores 0.
        _coverage_base = 50 if has_compact else 0
        # Freshness: stale=True subtracts the freshness bonus; stale=None (unknown) keeps it.
        _coverage_fresh = 30 if (has_compact and compact_stale is not True) else 0
        _coverage_quality = ((compact_quality_score or 0) * 20 // 100) if has_compact else 0
        compact_coverage_score: int = _coverage_base + _coverage_fresh + _coverage_quality

        rows.append({
            "name": meta.skill_name,
            "body_tokens": body_tokens,
            "has_compact": has_compact,
            "compact_tokens": compact_tokens,
            "compact_stale": compact_stale,
            "compact_age_secs": compact_age_secs,
            "age_secs": round(age_secs),
            "compact_served_count": compact_served_count,
            "compact_quality": compact_quality,
            "compact_quality_score": compact_quality_score,
            "compact_quality_issues": compact_quality_issues,
            "compact_coverage_score": compact_coverage_score,
        })

    if json_output:
        # Each skill entry includes:
        #   compact_served_count — hits in PreCompact manifests this session
        #   compact_stale — True when the compact's source_sha differs from the
        #     body's content_sha (null when no compact or SHA unavailable)
        #   compact_quality_score — int 0-100 quality score (null when no compact)
        #   compact_quality_issues — list of human-readable quality problem strings
        #   compact_coverage_score — composite 0-100: availability (50) + freshness (30) + quality (20)
        # Session-level fields:
        #   compact_coverage_pct — average compact_coverage_score across all skills (0-100)
        #     Provides a single number for "how well are this session's skills covered
        #     by fresh, high-quality compacts?" — useful for CI checks and dashboards.
        _total_cov = sum(int(r.get("compact_coverage_score", 0)) for r in rows)  # type: ignore[call-overload]
        compact_coverage_pct: int = round(_total_cov / len(rows)) if rows else 0
        _emit_json({
            "session_id": resolved_session,
            "compact_coverage_pct": compact_coverage_pct,
            "skills": rows,
        })
        return

    if not rows:
        typer.echo(f"No cached skills for session: {resolved_session}")
        raise typer.Exit(0)

    typer.echo(f"Session: {resolved_session}")
    typer.echo()
    header = f"{'Skill':<40}  {'Body':>6}  {'Compact':>14}  {'Hits':>5}  {'Cached'}"
    typer.echo(header)
    typer.echo("-" * len(header))
    for row in rows:
        name = str(row["name"])
        body_tokens = int(row["body_tokens"])  # type: ignore[call-overload]
        has_compact = bool(row["has_compact"])
        compact_tokens = int(row["compact_tokens"])  # type: ignore[call-overload]
        age_secs = int(row["age_secs"])  # type: ignore[call-overload]
        compact_served = int(row.get("compact_served_count", 0))  # type: ignore[call-overload]
        compact_stale = cast("bool | None", row.get("compact_stale"))
        _raw_compact_age = row.get("compact_age_secs")
        compact_age_secs = int(_raw_compact_age) if _raw_compact_age is not None else None  # type: ignore[call-overload]
        _raw_quality_score = row.get("compact_quality_score")
        compact_quality_score = int(_raw_quality_score) if _raw_quality_score is not None else None  # type: ignore[call-overload]

        # Quality score thresholds for human-readable display:
        #   < 40  → "poor"  — likely missing rules or severely under-covered
        #   40-59 → "fair"  — below ideal but not critically bad
        #   >= 60 → no quality flag (acceptable or good)
        _QUALITY_POOR_THRESHOLD = 40
        _QUALITY_FAIR_THRESHOLD = 60

        if not has_compact:
            compact_col = "no"
        elif compact_stale is True:
            compact_col = f"~{compact_tokens} tok [stale]"
        elif compact_quality_score is not None and compact_quality_score < _QUALITY_POOR_THRESHOLD:
            compact_col = f"~{compact_tokens} tok [poor]"
        elif compact_quality_score is not None and compact_quality_score < _QUALITY_FAIR_THRESHOLD:
            compact_col = f"~{compact_tokens} tok [fair]"
        elif compact_age_secs is not None and compact_age_secs > 86400:
            # Compact is older than 1 day — flag it so users know it may be outdated.
            compact_age_days = compact_age_secs // 86400
            compact_col = f"~{compact_tokens} tok [{compact_age_days}d old]"
        else:
            compact_col = f"~{compact_tokens} tok"

        # Hits column: number of times the compact was inlined in a manifest.
        # "-" when no compact exists (hit is impossible), "0" when compact
        # exists but was never served yet (generated but not yet used).
        hits_col = "-" if not has_compact else str(compact_served)

        if age_secs < 0:
            age_str = "unknown"
        elif age_secs < 60:
            age_str = f"{age_secs}s ago"
        elif age_secs < 3600:
            age_str = f"{age_secs // 60}m ago"
        else:
            age_str = f"{age_secs // 3600}h {(age_secs % 3600) // 60}m ago"

        typer.echo(f"{name:<40}  ~{body_tokens:>5}  {compact_col:>14}  {hits_col:>5}  {age_str}")

    typer.echo()
    typer.echo(f"{len(rows)} skill(s) cached in this session.")


@app.command("decision", rich_help_panel="Core")
def cmd_decision(
    text: str = typer.Argument(
        "",
        help=(
            "Decision text. Pass an empty string with --list to inspect the log instead. "
            "Example: token-goat decision \"Picked option A over B because lower risk\"."
        ),
    ),
    session_id: str = typer.Option(
        "",
        "--session-id",
        "-s",
        help=(
            "Session to record the decision against (full or 8-char short form). "
            "When omitted, the most-recently-active session in the cache directory is used."
        ),
    ),
    tag: str = typer.Option(
        "",
        "--tag",
        "-t",
        help=(
            "Optional short label rendered as a column-style prefix in the compact manifest. "
            "Conventions: 'rationale', 'ruled-out', 'invariant'. Capped at 24 characters."
        ),
    ),
    list_log: bool = typer.Option(
        False,
        "--list",
        help=(
            "List the recent decisions for the resolved session instead of appending one. "
            "Pairs well with the compact manifest **Decisions:** overflow recall hint."
        ),
    ),
    limit: int = typer.Option(
        10,
        "--limit",
        min=1,
        max=100,
        help="When --list is set, the maximum number of entries to display (newest last).",
    ),
) -> None:
    """Record or list opt-in decisions for the current session.

    Decision logs preserve the *why* behind a step — option-A-vs-B trade-offs,
    invariants locked, approaches ruled out — through compaction events.  The
    compact manifest surfaces the most recent decisions in a dedicated section
    so the post-compact agent inherits the reasoning, not just the artifacts.

    Without ``--list``, the command appends a new entry::

        token-goat decision "Picked option A because lower regression risk"
        token-goat decision --tag invariant "Every save() must bump version"

    With ``--list``, the recent decisions are printed newest-last so the agent
    (or a human reviewer) can audit the running rationale without parsing the
    raw session JSON.  No session ID is needed in the common case; the most
    recently active cache file in ``data_dir() / "sessions"`` is selected.

    A ``decision_log`` stats event is recorded on append so ``token-goat stats``
    can track adoption alongside the other compact-assist mechanisms.
    """
    from . import db as _db
    from . import paths as _paths
    from . import session as session_mod

    sessions_dir = _paths.sessions_dir()

    def _resolve_session_id(raw: str) -> str | None:
        """Resolve full / short / empty session id against the on-disk cache."""
        if raw and len(raw) >= 32:
            return raw
        if raw:
            # Short prefix lookup.
            if sessions_dir.exists():
                for f in sessions_dir.glob(f"{raw}*.json"):
                    return f.stem
            return None
        # No session id given → pick the most recently modified cache file.
        if not sessions_dir.exists():
            return None
        candidates = []
        for f in sessions_dir.glob("*.json"):
            try:
                candidates.append((f.stat().st_mtime, f.stem))
            except OSError:
                continue
        if not candidates:
            return None
        candidates.sort(key=lambda t: t[0], reverse=True)
        return candidates[0][1]

    resolved = _resolve_session_id(session_id.strip())
    if resolved is None:
        if session_id:
            _error(f"no session cache found for: {session_id!r}")
        else:
            _error(
                "no session cache files present in "
                f"{sessions_dir} — start a Claude/Codex session first or pass --session-id"
            )
        raise typer.Exit(1)

    if list_log:
        cache = session_mod.safe_load(resolved)
        if cache is None or not cache.decisions:
            typer.echo(f"(no decisions recorded for session {resolved[:8]})")
            raise typer.Exit(0)
        # Print newest-last, capped at `limit`.  The list is append-only newest-last
        # already; slice the tail without rebuilding the list.
        shown = cache.decisions[-limit:]
        for entry in shown:
            tag_str = f"[{entry.tag}] " if entry.tag else ""
            typer.echo(f"{tag_str}{entry.text}")
        raise typer.Exit(0)

    if not text or not text.strip():
        _error(
            "decision text is empty — pass a non-empty string, or use --list to view the log"
        )
        raise typer.Exit(1)

    session_mod.mark_decision(resolved, text, tag=tag)
    # Record stats so adoption is visible in `token-goat stats`.  Tokens saved is
    # 0 (the row is an adoption signal, like resume_packet), bytes is the entry
    # text length so a total-decisions-by-bytes line is meaningful over time.
    _db.record_stat(
        None,
        "decision_log",
        bytes_saved=len(text.encode("utf-8")),
        tokens_saved=0,
        detail=resolved[:32],
    )
    typer.echo(f"recorded decision for session {resolved[:8]}")


@app.command("pinned", rich_help_panel="Core")
def cmd_pinned(
    action: str = typer.Argument(
        ...,
        help=(
            "Sub-command: 'add', 'remove', or 'list'. "
            "Example: token-goat pinned add src/foo.py::MyClass"
        ),
    ),
    spec: str = typer.Argument(
        "",
        help=(
            "Symbol spec in '<file>::<symbol>' format. "
            "Required for 'add' and 'remove'; ignored for 'list'."
        ),
    ),
    session_id: str = typer.Option(
        "",
        "--session-id",
        "-s",
        help=(
            "Session to operate against (full or 8-char short form). "
            "When omitted, the most-recently-active session is used."
        ),
    ),
) -> None:
    """Manage pinned symbols for the current session.

    Pinned symbols always appear at the top of session hints and at the top of
    the compaction manifest.  Up to 20 symbols can be pinned per session.

    Sub-commands::

        token-goat pinned add src/auth.py::login
        token-goat pinned remove src/auth.py::login
        token-goat pinned list

    Pinned symbols persist in the session JSON and survive re-reads.  They are
    surfaced in the manifest under ``## Pinned`` before all other sections so
    they survive aggressive compaction.
    """
    from . import paths as _paths
    from . import session as session_mod

    sessions_dir = _paths.sessions_dir()

    def _resolve_session_id(raw: str) -> str | None:
        if raw and len(raw) >= 32:
            return raw
        if raw:
            if sessions_dir.exists():
                for f in sessions_dir.glob(f"{raw}*.json"):
                    return f.stem
            return None
        if not sessions_dir.exists():
            return None
        candidates = []
        for f in sessions_dir.glob("*.json"):
            try:
                candidates.append((f.stat().st_mtime, f.stem))
            except OSError:
                continue
        if not candidates:
            return None
        candidates.sort(key=lambda t: t[0], reverse=True)
        return candidates[0][1]

    action = action.lower().strip()
    if action not in ("add", "remove", "list"):
        _error(f"unknown action {action!r}; expected 'add', 'remove', or 'list'")
        raise typer.Exit(1)

    resolved = _resolve_session_id(session_id.strip())
    if resolved is None:
        if session_id:
            _error(f"no session cache found for: {session_id!r}")
        else:
            _error(
                "no session cache files present in "
                f"{sessions_dir} — start a Claude/Codex session first or pass --session-id"
            )
        raise typer.Exit(1)

    if action == "list":
        cache = session_mod.safe_load(resolved)
        if cache is None or not cache.pinned_symbols:
            typer.echo(f"(no pinned symbols for session {resolved[:8]})")
            raise typer.Exit(0)
        for entry in cache.pinned_symbols:
            typer.echo(entry)
        raise typer.Exit(0)

    # add or remove — spec required
    spec = spec.strip()
    if not spec:
        _error(f"spec is required for '{action}'; pass '<file>::<symbol>'")
        raise typer.Exit(1)
    if "::" not in spec:
        _error(f"invalid spec {spec!r}; expected '<file>::<symbol>' (must contain '::')")
        raise typer.Exit(1)

    cache = session_mod.safe_load(resolved)
    if cache is None:
        _error(f"could not load session cache for {resolved[:8]}")
        raise typer.Exit(1)

    if action == "add":
        try:
            cache.add_pinned(spec)
        except ValueError as exc:
            _error(str(exc))
            raise typer.Exit(1) from exc
        session_mod.save(cache)
        typer.echo(f"pinned: {spec} (session {resolved[:8]})")
    else:  # remove
        removed = cache.remove_pinned(spec)
        if removed:
            session_mod.save(cache)
            typer.echo(f"unpinned: {spec} (session {resolved[:8]})")
        else:
            typer.echo(f"(not pinned: {spec})")
        raise typer.Exit(0)


@app.command("resume", rich_help_panel="Core")
def cmd_resume(
    session_id: str = typer.Argument(
        ...,
        help=(
            "Session ID (or 8-char short form) to restore context from. "
            "Shown in the recovery hint as 'token-goat resume <short_id>'."
        ),
    ),
) -> None:
    """Emit a single-command post-compact restoration packet.

    Assembles in one call what the agent would otherwise retrieve via 5–10
    separate round-trips after a compaction event:

    \\b
    1. Skill checklists inline (up to 3 skills, ≤ 400 chars each).
    2. Last 2 Bash outputs — first 20 + last 20 lines with a gap marker.
    3. Per-file diffs for the top 2 edited files.
    4. Current git diff stat summary.

    Each section is annotated with an ``as of HH:MM`` freshness timestamp.
    Total output is hard-capped at ~2000 tokens so one command cannot
    balloon the context window.

    The session ID is the full UUID from the session JSON filename, or the
    8-char prefix shown in the post-compact recovery hint.
    """
    from . import db as _db
    from . import resume as _resume

    # Resolve partial (short) session IDs by scanning the sessions directory.
    resolved_id: str | None = None
    if len(session_id) >= 32:
        # Full ID — use directly.
        resolved_id = session_id
    else:
        # Short prefix — find the first session file matching it.
        try:
            from . import paths as _paths

            sessions_dir = _paths.sessions_dir()
            for f in sessions_dir.glob(f"{session_id}*.json"):
                candidate = f.stem  # strip .json
                resolved_id = candidate
                break
        except Exception:
            _LOG.debug("resume: failed to resolve short session id %r", session_id, exc_info=True)
        if resolved_id is None:
            _error(f"no session found for short id: {session_id!r}")
            raise typer.Exit(1)

    packet = _resume.build_resume_packet(resolved_id)
    if not packet:
        _warn(f"session {session_id!r} has no recoverable state (empty or unavailable)")
        raise typer.Exit(0)

    # Record a stat so `token-goat stats` can show resume usage.
    _db.record_stat(
        None,
        "resume_packet",
        bytes_saved=0,
        tokens_saved=0,
        detail=resolved_id[:32],
    )

    typer.echo(packet)


@app.command("recovery", rich_help_panel="Core")
def cmd_recovery(
    session_id: str = typer.Argument(
        ...,
        help=(
            "Session ID (full or 8-char short form) to inspect. "
            "Same form as `token-goat resume` accepts."
        ),
    ),
    pending: bool = typer.Option(
        False,
        "--pending",
        help=(
            "Read the deferred recovery sidecar if present (what would be "
            "injected on the next tool call), instead of rebuilding from cache."
        ),
    ),
) -> None:
    """Inspect the post-compact recovery hint for a session.

    By default rebuilds the hint from the current session cache so you can
    preview what a fresh ``/compact`` followed by a SessionStart-with-source=
    compact would surface.  Use ``--pending`` to read the deferred sidecar
    (``sentinels/recovery_pending_{session_id}``) for sessions where the
    SessionStart hook has already fired but the first tool call has not
    consumed the hint yet.

    Useful for:

    \\b
    1. Debugging the recovery hint shape after a code change.
    2. Verifying the sidecar contents for an already-deferred session.
    3. A human peeking at "what would the agent see if it resumed here?"
       without actually triggering a compact event.
    """
    from . import hooks_session as _hs
    from . import paths as _paths

    # Resolve short session IDs the same way `resume` does.
    resolved_id: str | None = None
    if len(session_id) >= 32:
        resolved_id = session_id
    else:
        try:
            sessions_dir = _paths.sessions_dir()
            for f in sessions_dir.glob(f"{session_id}*.json"):
                resolved_id = f.stem
                break
        except Exception:
            _LOG.debug("recovery-sidecar: failed to resolve short session id %r", session_id, exc_info=True)
        if resolved_id is None:
            _error(f"no session found for short id: {session_id!r}")
            raise typer.Exit(1)

    if pending:
        sidecar = _paths.recovery_pending_path(resolved_id)
        if not sidecar.exists():
            _warn(
                f"no deferred recovery sidecar for {resolved_id[:16]!r} "
                "(either the SessionStart hook has not fired with source=compact, "
                "or the next tool call already consumed it)"
            )
            raise typer.Exit(0)
        try:
            typer.echo(sidecar.read_text(encoding="utf-8"))
        except OSError as exc:
            _error(f"failed to read sidecar: {exc}")
            raise typer.Exit(1) from exc
        return

    hint = _hs._build_recovery_hint(resolved_id)
    if not hint:
        _warn(
            f"session {resolved_id[:16]!r} has no recoverable state "
            "(empty cache or no qualifying entries)"
        )
        raise typer.Exit(0)
    typer.echo(hint)


@app.command(rich_help_panel="Install")
def doctor(
    fix: bool = typer.Option(
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
    context: bool = typer.Option(
        False,
        "--context",
        help="Always show the Context footprint section (auto-shown when context > 40% or an uncompacted loaded skill exists).",
    ),
) -> None:
    """Diagnose the health of the token-goat installation and indices.

    Runs checks on Python version, dependencies, database integrity, hook registration,
    worker status, and project indices. Use ``--fix`` to clear stale ``.indexing``
    spawn markers (same reaping the background worker does on startup).
    """
    from . import cli_doctor

    cli_doctor.doctor(fix=fix, crashes=False, context=context)


_VALID_TARGETS = {"claude", "codex", "gemini", "opencode", "openclaw", "pi", "all"}


@app.command("context-stats", rich_help_panel="Install")
def context_stats(
    fix: bool = typer.Option(
        False,
        "--fix",
        help="Apply safe structural pruning: remove dead links and exact-duplicate "
             "entries from the project's MEMORY.md index. Never edits memory bodies "
             "or CLAUDE.md files.",
    ),
    json_output: bool = typer.Option(False, "--json", help="Machine-readable output."),
    project: Path | None = typer.Option(  # noqa: B008
        None,
        "--project",
        help="Project root to analyse (defaults to CWD).",
        exists=False,
    ),
) -> None:
    """Show startup context footprint and optionally prune stale MEMORY.md entries.

    Estimates how many tokens are consumed before any real work begins:
    CLAUDE.md files, MEMORY.md, and known fixed overhead (system prompt,
    skill/agent listings).  With ``--fix``, safely removes dead links and
    exact-duplicate index entries from MEMORY.md.
    """
    from . import cli_context_stats

    cli_context_stats.run(fix=fix, json_out=json_output, project=project)


@app.command("install", rich_help_panel="Install")
def cmd_install(
    codex: bool = typer.Option(False, "--codex", help="Also install Codex CLI integration"),  # noqa: B008
    opencode: bool = typer.Option(False, "--opencode", help="Also install opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also install openclaw plugin bridge"),  # noqa: B008
    pi: bool = typer.Option(False, "--pi", help="Also install pi extension bridge (global ~/.pi/agent/extensions)"),  # noqa: B008
    target: list[str] = typer.Option(  # noqa: B008
        None,
        "--target",
        help=(
            "Install hooks for a specific tool. May be repeated. "
            "Choices: claude, codex, gemini, opencode, openclaw, pi, all. "
            "Overrides --codex/--opencode/--openclaw/--pi when provided."
        ),
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would change; make no changes"),
    verify: bool = typer.Option(False, "--verify", help="After install, run a structured self-check"),
    check: bool = typer.Option(False, "--check", help="Print current autostart registration and interpreter match; no side effects"),
) -> None:
    """One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog.

    Use --target to selectively install hooks for specific tools:

        token-goat install --target claude
        token-goat install --target codex
        token-goat install --target all
        token-goat install --target claude --target codex

    Use --check to inspect the current autostart registration without making changes:

        token-goat install --check
    """
    from . import install as inst

    if check:
        info = inst.check_autostart()
        typer.echo(f"Autostart: {info['status']}")
        if info["command"]:
            typer.echo(f"Command: {info['command']}")
        if info["registered_interp"]:
            typer.echo(f"Interpreter: {info['registered_interp']}")
            match = info["match"]
            if match == "YES":
                typer.echo("Match: YES (current interpreter matches)")
            elif match == "NO":
                typer.echo(
                    f"Match: NO (registered: {info['registered_interp']}, "
                    f"current: {info['current_interp']})"
                )
            else:
                typer.echo("Match: UNKNOWN (could not compare interpreters)")
        else:
            typer.echo(f"Current interpreter: {info['current_interp']}")
        return

    targets: builtins.set[str] | None = None
    if target:
        unknown = builtins.set(target) - _VALID_TARGETS
        if unknown:
            typer.echo(
                f"Unknown --target value(s): {', '.join(sorted(unknown))}. "
                f"Valid choices: {', '.join(sorted(_VALID_TARGETS))}",
                err=True,
            )
            raise typer.Exit(1)
        targets = builtins.set(target)

    if dry_run:
        plan = inst.plan_install(
            install_codex=codex,
            install_opencode=opencode,
            install_openclaw=openclaw,
            install_pi=pi,
            targets=targets,
        )
        typer.echo("token-goat install --dry-run (no changes made):")
        for row in plan:
            typer.echo(
                f"  [{row['action']:>17}] {row['component']}: {row['target']}"
            )
            if row.get("detail"):
                typer.echo(f"      {row['detail']}")
        typer.echo("")
        typer.echo("Re-run without --dry-run to apply.")
        return

    # Show current integration state before making changes
    status = inst.check_status()
    typer.echo("Current integration status:")
    for integration, state in status.items():
        icon = "+" if state == "installed" else "-"
        typer.echo(f"  [{icon}] {integration}: {state}")
    typer.echo("")

    result = inst.install_all(
        install_codex=codex,
        install_opencode=opencode,
        install_openclaw=openclaw,
        install_pi=pi,
        targets=targets,
    )
    typer.echo("token-goat install:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")
    typer.echo("")

    # Re-probe codecs so we can print a loud, actionable warning. install_all
    # already ran the same probe and stored a one-line summary in result, but
    # the structured report carries platform-specific install hints that a
    # one-line dict entry can't convey.
    codec_report = inst.probe_image_codecs()
    if not codec_report["ok"]:
        typer.echo("!" * 72)
        typer.echo("WARNING — image codecs incomplete; WebP shrink will be degraded or broken.")
        typer.echo(f"  detected: {codec_report['summary']}")
        if codec_report["missing"]:
            typer.echo(f"  missing:  {', '.join(codec_report['missing'])}")
        typer.echo("")
        typer.echo("To fix (part of the install — do not skip):")
        for line in codec_report["hint"].splitlines():
            typer.echo(f"  {line}")
        typer.echo("")
        typer.echo("After fixing, re-run: token-goat doctor")
        typer.echo("!" * 72)
        typer.echo("")
    if verify:
        typer.echo("Verifying install:")
        for row in inst.verify_install():
            icon = "+" if row["action"] == "ok" else "-" if row["action"] == "missing" else "!"
            typer.echo(f"  [{icon}] {row['component']}: {row['detail']}")
        typer.echo("")
    typer.echo("All set. token-goat will be invisible from here on.")
    typer.echo("Run `token-goat doctor` anytime to check status.")
    typer.echo("Defender exclusion (optional, for max perf):")
    typer.echo(r'  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\dfk-helper\token-goat"')


@app.command("uninstall", rich_help_panel="Install")
def cmd_uninstall(
    purge: bool = typer.Option(False, "--purge", help=r"Also delete %LOCALAPPDATA%\dfk-helper\token-goat"),  # noqa: B008
    codex: bool = typer.Option(False, "--codex", help="Also remove Codex CLI integration"),  # noqa: B008
    gemini: bool = typer.Option(False, "--gemini", help="Also remove Gemini CLI hook integration"),  # noqa: B008
    opencode: bool = typer.Option(False, "--opencode", help="Also remove opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also remove openclaw plugin bridge"),  # noqa: B008
    pi: bool = typer.Option(False, "--pi", help="Also remove pi extension bridge (global ~/.pi/agent/extensions)"),  # noqa: B008
) -> None:
    """Cleanly reverse install."""
    from . import install as inst

    result = inst.uninstall_all(purge=purge, codex=codex, gemini=gemini, opencode=opencode, openclaw=openclaw, pi=pi)
    typer.echo("token-goat uninstall:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")


@app.command("image-shrink", hidden=True)
def cmd_image_shrink(
    src: Path = typer.Argument(...),  # noqa: B008
    json_output: bool = _OPT_JSON,
) -> None:
    """Manually shrink an image (also used by hooks)."""
    from . import image_shrink

    abs_src = src.resolve()
    if not abs_src.exists():
        _error(f"file not found: {_format_path_output(abs_src)}")
        raise typer.Exit(1)
    out = image_shrink.shrink(abs_src)
    if out is None:
        typer.echo(f"Not shrunk (below threshold or not an image): {_format_path_output(abs_src)}")
        raise typer.Exit(0)
    stats = image_shrink.stats_for(abs_src, out)
    if json_output:
        typer.echo(json.dumps({"shrunken_path": _format_path_output(out), **stats}, separators=(",", ":")))
    else:
        src_fmt = _format_path_output(abs_src)
        out_fmt = _format_path_output(out)
        typer.echo(
            f"{src_fmt} → {out_fmt} "
            f"({stats['src_bytes']:,} → {stats['out_bytes']:,} bytes, "
            f"saved {stats['bytes_saved']:,})"
        )


@app.command("worker", hidden=True)
def cmd_worker(
    daemon: bool = typer.Option(False, "--daemon", help="Run as background daemon (otherwise interactive)"),
    status: bool = typer.Option(False, "--status", help="Show worker status and exit"),
    check: bool = typer.Option(False, "--check", help="Check for a running worker and report its interpreter; exit 1 if a duplicate (different interpreter) is detected"),
    kill_duplicate: bool = typer.Option(False, "--kill-duplicate", help="Kill a running worker whose interpreter differs from the current Python executable"),
) -> None:
    """Internal: background worker daemon. Should be invoked by the SessionStart watchdog, not directly.

    Under CI (``TOKEN_GOAT_NO_WORKER_SPAWN=1`` in the environment) this
    entry point exits immediately without invoking ``run_daemon``.  The
    env var is inherited by the spawned child via ``subprocess.Popen``'s
    default env-passing behaviour, so a daemon launched from a test
    suite (or any CI step that sets the var) terminates cleanly instead
    of holding the GitHub Actions Windows step open until the six-hour
    timeout fires.  Direct unit tests of ``worker_daemon.run_daemon``
    do not go through this entry point, so they remain unaffected.
    """
    if kill_duplicate:
        from . import worker_daemon as _wd

        result = _wd.kill_duplicate_daemon()
        typer.echo(result)
        return

    if check:
        from . import paths as _paths
        from . import worker as _worker_mod

        pid_path = _paths.worker_pid_path()
        if not pid_path.exists():
            typer.echo("Worker: not running (no pid file)")
            raise typer.Exit(0)
        try:
            pid_text = pid_path.read_text(encoding="utf-8")
            pid, worker_interp = _worker_mod._read_pid_info(pid_text)
        except (OSError, ValueError) as e:
            typer.echo(f"Worker: pid file unreadable ({e})")
            raise typer.Exit(0) from e

        from . import worker_daemon as _wd
        running = _wd._pid_is_alive(pid)
        if not running:
            typer.echo(f"Worker: stale pid file (pid {pid} not alive)")
            raise typer.Exit(0)

        typer.echo(f"Worker: running (pid {pid})")
        if worker_interp:
            typer.echo(f"Interpreter: {worker_interp}")
            current = sys.executable

            def _norm_interp(p: str) -> str:
                return p.replace("\\", "/").casefold() if sys.platform == "win32" else p

            if _norm_interp(worker_interp) != _norm_interp(current):
                typer.echo(
                    f"DUPLICATE DETECTED: worker interpreter ({worker_interp}) "
                    f"differs from current ({current})"
                )
                raise typer.Exit(1)
            typer.echo("Match: YES (worker interpreter matches current)")
        else:
            typer.echo("Interpreter: unknown (legacy pid file format)")
        raise typer.Exit(0)

    if status:
        from . import worker_daemon

        info = worker_daemon.query_worker_status()
        pid_str = f" (pid {info['pid']})" if info["pid"] is not None else ""
        state = "running" if info["running"] else "stopped"
        typer.echo(f"Worker: {state}{pid_str}")
        if info.get("interpreter"):
            typer.echo(f"Interpreter: {info['interpreter']}")
        if info.get("started_at") and info["running"]:
            # Compute uptime from started_at ISO timestamp.
            try:
                import datetime as _dt
                started = _dt.datetime.fromisoformat(str(info["started_at"]))
                if started.tzinfo is None:
                    started = started.replace(tzinfo=_dt.UTC)
                now = _dt.datetime.now(tz=_dt.UTC)
                uptime_secs = max(0, int((now - started).total_seconds()))
                hours, rem = divmod(uptime_secs, 3600)
                mins, secs = divmod(rem, 60)
                uptime_str = f"{hours}h {mins}m {secs}s" if hours else f"{mins}m {secs}s"
                typer.echo(f"Uptime: {uptime_str}")
            except Exception:
                pass
        typer.echo(f"Pool size: {info.get('pool_size', 4)}")
        if info["autostart"] is not None:
            active_str = "enabled" if info["autostart_active"] else (
                "disabled" if info["autostart_active"] is False else "unknown"
            )
            typer.echo(f"Autostart: {info['autostart']} ({active_str})")
        if info["last_log_line"]:
            typer.echo(f"Last log: {info['last_log_line']}")
        return

    if os.environ.get("TOKEN_GOAT_NO_WORKER_SPAWN", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        return

    from . import worker_daemon

    worker_daemon.run_daemon()


@app.command(
    "compress",
    rich_help_panel="Advanced",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
)
def cmd_compress(
    cmd: str = typer.Option(
        ...,
        "--cmd",
        "-c",
        help="The original shell command to run, captured into a single string.",
    ),
    filter_name: str | None = typer.Option(
        None,
        "--filter",
        "-f",
        help="Filter name (pytest, jest, git, ...). Auto-detected from the command when omitted.",
    ),
    timeout: int = typer.Option(
        0,
        "--timeout",
        help="Wall-clock timeout in seconds (0 = use built-in default).",
    ),
    no_compress: bool = typer.Option(
        False,
        "--no-compress",
        help="Skip compression and stream output raw (for debugging the wrapper).",
    ),
    profile: str | None = typer.Option(
        None,
        "--profile",
        help="Compression profile: aggressive (50 lines), balanced (200 lines), minimal (500 lines, skip progress). "
             "Overrides config and auto-detection.",
    ),
    max_tokens: int = typer.Option(
        0,
        "--max-tokens",
        help="Post-compress token cap (0 = no cap). Passed by the pre-Bash hook to tighten output at high context pressure.",
    ),
) -> None:
    """Run a shell command and emit a compressed view of its output.

    Used internally by the PreToolUse hook to wrap commands whose output
    would otherwise burn excess tokens (pytest, jest, npm install, docker
    build, kubectl get, ...).  Can also be invoked directly from a terminal
    to preview the compression for any command::

        token-goat compress --cmd 'pytest tests/'
        token-goat compress --cmd 'git log --oneline -n 200'
        token-goat compress --filter docker --cmd 'docker build -t foo .'

    Always exits with the wrapped command's exit code so it composes cleanly
    with shell chaining.  Set ``TOKEN_GOAT_BASH_COMPRESS=0`` to bypass the
    compression layer at the hook level (this CLI still works when invoked
    directly because it is the layer being bypassed).
    """
    from . import bash_runner

    if no_compress:
        # Stream straight through; useful for debugging.
        import subprocess as _sp

        proc = _sp.run(cmd, shell=True, check=False)
        raise typer.Exit(proc.returncode)

    effective_timeout = timeout if timeout > 0 else bash_runner.DEFAULT_TIMEOUT_SECONDS
    exit_code = bash_runner.run(
        cmd,
        filter_name=filter_name,
        timeout=effective_timeout,
        compression_profile=profile,
        max_tokens=max_tokens,
    )
    raise typer.Exit(exit_code)


# Hook entry points. Each one delegates to hooks_cli.safe_run, which is
# bulletproof: catches BaseException, always emits valid JSON, always exits 0.
# That way a hook never marks itself failed to Claude Code or Codex even when
# the underlying handler trips on an unexpected payload shape or environment.
#
# context_settings tells typer/click to ACCEPT any unknown options or extra
# positional args silently. Codex passes hook-specific args that vary between
# its versions; without this, typer would exit 2 ("No such option ...") before
# safe_run ever runs and the entire hook would appear to fail.

_HARNESS_OPT = typer.Option("claude", "--harness", help="Hook harness: claude or codex")
_INPUT_OPT = typer.Option(None, "--input-file")
_HOOK_CTX = {"ignore_unknown_options": True, "allow_extra_args": True}

_VALID_HARNESSES = get_args(hooks_cli.Harness)


def _parse_harness(raw: str) -> hooks_cli.Harness:
    """Validate and narrow a raw CLI harness string to the ``Harness`` literal type.

    Typer infers the ``harness`` parameter as ``str`` from the option default, so
    mypy cannot prove the value is a valid ``Harness`` literal.  This helper
    performs a runtime check and returns the narrowed type, giving mypy a
    concrete ``Harness`` at every :func:`~token_goat.hooks_cli.safe_run` call site.

    Unknown values fall back to ``"claude"`` (the safe default) so an unrecognised
    ``--harness`` flag from a newer harness version does not abort the hook.
    """
    if raw in _VALID_HARNESSES:
        return cast("hooks_cli.Harness", raw)
    _LOG.debug("unknown harness %r; defaulting to 'claude'", raw)
    return "claude"


@hook_app.command(context_settings=_HOOK_CTX)
def session_start(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: session-start event."""
    hooks_cli.safe_run("session-start", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-read event."""
    hooks_cli.safe_run("pre-read", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_fetch(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-fetch event."""
    hooks_cli.safe_run("pre-fetch", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_edit(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-edit event."""
    hooks_cli.safe_run("post-edit", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-read event."""
    hooks_cli.safe_run("post-read", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_bash(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-bash event (caches Bash output for dedup + retrieval)."""
    hooks_cli.safe_run("post-bash", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_fetch(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-fetch event (caches WebFetch text body for dedup + retrieval)."""
    hooks_cli.safe_run("post-fetch", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_compact(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-compact event."""
    hooks_cli.safe_run("pre-compact", input_file, _parse_harness(harness))


@hook_app.command("user-prompt-submit", context_settings=_HOOK_CTX)
def user_prompt_submit(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: user-prompt-submit event."""
    hooks_cli.safe_run("user-prompt-submit", input_file, _parse_harness(harness))


@hook_app.command("subagent-stop", context_settings=_HOOK_CTX)
def subagent_stop(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: subagent-stop event."""
    hooks_cli.safe_run("subagent-stop", input_file, _parse_harness(harness))


@hook_app.command("pre-skill", context_settings=_HOOK_CTX)
def pre_skill(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-skill event (blocks repeat skill loads; serves compact on first load when curated)."""
    hooks_cli.safe_run("pre-skill", input_file, _parse_harness(harness))


@hook_app.command("post-skill", context_settings=_HOOK_CTX)
def post_skill(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-skill event (caches loaded skill bodies for post-compact recall)."""
    hooks_cli.safe_run("post-skill", input_file, _parse_harness(harness))


@hook_app.command("pre-screenshot", context_settings=_HOOK_CTX)
def pre_screenshot(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-screenshot event (redirects MCP screenshots without filePath so image-shrink applies)."""
    hooks_cli.safe_run("pre-screenshot", input_file, _parse_harness(harness))


def _compact_hint_watch(
    session_id: str,
    auto: bool,
    max_tokens: int,
    trigger: str,
    interval: int = 60,
) -> None:
    """Poll manifest generation in a loop, printing a compact diff each cycle.

    Separated from the main ``compact_hint`` command so it can be unit-tested
    with mocked sleep and manifest generation without spinning up the full Typer
    command tree.
    """
    import difflib
    import time
    from datetime import datetime

    from . import compact as compact_mod
    from . import config as config_mod

    def _resolve_session() -> str:
        sid = session_id.strip()
        if auto or sid.lower() == "auto" or not sid:
            detected = compact_mod.find_latest_session_id()
            if not detected:
                typer.echo(
                    "No session files found under token-goat data directory.  "
                    "Start a Claude Code session first, or pass --session-id explicitly.",
                    err=True,
                )
                raise typer.Exit(code=1)
            if not sid or sid.lower() == "auto":
                typer.echo(f"(auto-detected session: {detected})")
            return detected
        return sid

    def _build(sid: str) -> str:
        cfg = config_mod.load().compact_assist
        base_tokens = int(max_tokens) if max_tokens > 0 else int(cfg.max_manifest_tokens)
        multiplier = compact_mod.get_auto_trigger_multiplier(
            config_explicit_multiplier=cfg.auto_trigger_multiplier
        )
        effective_tokens = (
            int(base_tokens * multiplier)
            if trigger == "auto" and multiplier > 1.0
            else base_tokens
        )
        return compact_mod.build_manifest(sid, max_tokens=effective_tokens) or ""

    def _show_diff(previous: str, current: str) -> None:
        # Strip the volatile trailing "# as-of:" line from both sides so a timestamp-only tick (identical content built a clock-second apart) is not reported as a change.
        prev_lines = compact_mod.normalize_for_cache(previous).splitlines(keepends=True)
        curr_lines = compact_mod.normalize_for_cache(current).splitlines(keepends=True)
        diff = list(
            difflib.unified_diff(prev_lines, curr_lines, lineterm="", n=1)
        )
        # Strip the @@ and --- / +++ header lines; emit compact +/- lines only.
        changed = [ln for ln in diff if ln.startswith(("+", "-", " ")) and not ln.startswith(("---", "+++"))]
        if not changed:
            typer.echo("  (no changes)")
            return
        for ln in changed:
            typer.echo(ln)

    resolved_sid = _resolve_session()
    previous_manifest: str | None = None

    typer.echo(f"--- compact-hint watch [started, interval={interval}s] ---")
    typer.echo("Press Ctrl+C to stop.")
    typer.echo("")

    try:
        while True:
            ts = datetime.now().strftime("%H:%M:%S")
            typer.echo(f"--- compact-hint watch [{ts}] ---")
            current_manifest = _build(resolved_sid)
            if previous_manifest is None:
                # First cycle: show full manifest.
                if current_manifest:
                    typer.echo(current_manifest)
                else:
                    typer.echo("  (no manifest generated)")
            else:
                _show_diff(previous_manifest, current_manifest)
            previous_manifest = current_manifest
            typer.echo("")
            time.sleep(interval)
    except KeyboardInterrupt:
        typer.echo("")
        typer.echo("Stopped watching.")


@app.command("compact-hint", rich_help_panel="Advanced")
def compact_hint(
    session_id: str = typer.Option(
        "",
        "--session-id",
        "-s",
        help=(
            "Claude session_id to inspect.  Pass 'auto' (or omit and use --auto) "
            "to auto-detect the most-recently-modified session file."
        ),
    ),
    auto: bool = typer.Option(
        False,
        "--auto",
        help="Auto-detect the most-recently-modified session and use it.",
    ),
    json_output: bool = _OPT_JSON,
    max_tokens: int = typer.Option(
        0,
        "--max-tokens",
        help="Override token budget for the manifest (0 = use config.max_manifest_tokens).",
    ),
    trigger: str = typer.Option(
        "manual",
        "--trigger",
        help=(
            "Simulate the PreCompact trigger that fired the hook.  When 'auto' and "
            "auto_trigger_multiplier > 1, the effective budget is boosted exactly as the "
            "live hook does.  Use 'manual' (default) to preview a user-invoked /compact."
        ),
    ),
    explain_skip: bool = typer.Option(
        False,
        "--explain-skip",
        help=(
            "Show a detailed breakdown of why the compact-skip sentinel fired (or didn't), "
            "including skip reason, sentinel age, and the per-gate evaluation chain.  "
            "Useful when diagnosing silent skips where the hook returns {continue:true} "
            "without injecting a manifest."
        ),
    ),
    show_diff: bool = typer.Option(
        False,
        "--diff",
        help=(
            "Show a unified diff between the manifest that would be emitted NOW and "
            "the manifest from the last emit stored in the text sidecar.  "
            "Lines prefixed '+' are new; lines prefixed '-' were removed.  "
            "Prints 'No previous manifest to compare against' when no sidecar exists yet."
        ),
    ),
    show_sections: bool = typer.Option(
        False,
        "--sections",
        help=(
            "List just the section names in the manifest, plus the estimated token count "
            "for each, without printing the full text.  Empty sections are flagged.  "
            "Useful for quickly auditing what made it into the manifest."
        ),
    ),
    show_score: bool = typer.Option(
        False,
        "--score",
        help=(
            "Print the manifest quality score (from _score_manifest) with a per-section "
            "breakdown of what contributed to the score, plus whether the session would "
            "trigger the noop fast-path."
        ),
    ),
    watch: bool = typer.Option(
        False,
        "--watch",
        "-w",
        help=(
            "Poll continuously: generate the manifest every 60 seconds and show a "
            "compact +/- diff of what changed.  Press Ctrl+C to stop."
        ),
    ),
    watch_interval: int = typer.Option(
        60,
        "--watch-interval",
        help="Seconds between watch cycles (default: 60).",
        hidden=True,
    ),
) -> None:
    """Show the compaction manifest token-goat would inject for a session.

    Faithfully previews what the PreCompact hook will emit as ``systemMessage``
    before Claude Code compacts the conversation, applying the *same* gates the
    live hook applies:

    * ``[compact_assist] enabled`` config flag
    * Trigger membership in ``cfg.triggers`` (simulate via ``--trigger``)
    * Pressure-aware budget boost when ``trigger=auto`` (via ``auto_trigger_multiplier``)
    * Compact-skip sentinel fast-path (would the hook short-circuit silently?)
    * Noop-session gate (zero edits, zero bash, zero symbols)
    * ``min_events`` event-count gate
    * Sidecar manifest cache hit (the 1-line "unchanged since" stub)

    The trailing token estimate uses the canonical ``compact.estimate_tokens``
    helper — the same function ``_render`` uses internally — so the preview
    matches the actual emitted size rather than under-counting.

    Use this to debug why a manifest is (or isn't) being emitted, what its
    final size will be, and which sections survive after the per-section
    budget split.

    Pass ``--session-id auto`` or ``--auto`` to skip looking up the session ID
    manually — token-goat will use the most-recently-modified session file.

    Add ``--explain-skip`` to see a detailed breakdown of the skip gates,
    including the sentinel reason, age, and activity-floor counts.

    Add ``--diff`` to compare the current manifest against the last emitted one.

    Add ``--sections`` to list section names and token counts without full text.

    Add ``--score`` to see the manifest quality score with a section breakdown.

    Add ``--watch`` (or ``-w``) to poll continuously: the manifest is generated
    immediately, then re-generated every 60 seconds.  Each cycle prints a compact
    ``+``/``-`` diff showing lines added or removed (with 1 line of context).
    Press Ctrl+C to stop.  ``--watch-interval N`` overrides the 60-second default.
    """
    import difflib

    from . import compact as compact_mod
    from . import config as config_mod
    from . import hooks_cli as hooks_cli_mod
    from . import paths as paths_mod

    # --- --watch: continuous poll loop ----------------------------------------
    # Dispatched early (before expensive setup) so --watch can control the loop
    # and call back into the same resolution logic each cycle.
    if watch:
        _compact_hint_watch(
            session_id=session_id,
            auto=auto,
            max_tokens=max_tokens,
            trigger=trigger,
            interval=watch_interval,
        )
        return

    # --- Resolve session ID --------------------------------------------------
    # Support --session-id auto, --auto flag, or a missing session_id.
    resolved_session_id = session_id.strip()
    if auto or resolved_session_id.lower() == "auto" or not resolved_session_id:
        detected = compact_mod.find_latest_session_id()
        if not detected:
            typer.echo(
                "No session files found under token-goat data directory.  "
                "Start a Claude Code session first, or pass --session-id explicitly.",
                err=True,
            )
            raise typer.Exit(code=1)
        if not resolved_session_id or resolved_session_id.lower() == "auto":
            typer.echo(f"(auto-detected session: {detected})")
        resolved_session_id = detected

    _validate_session_id(resolved_session_id)

    cfg = config_mod.load().compact_assist

    # --- Resolve the effective budget the live hook would use ----------------
    # `max_tokens=0` (the new default) means "use whatever the live hook
    # would use": cfg.max_manifest_tokens, scaled by auto_trigger_multiplier
    # when trigger == "auto".  This makes the preview faithful out of the box
    # without forcing the caller to look up the config value first.
    base_tokens = int(max_tokens) if max_tokens > 0 else int(cfg.max_manifest_tokens)
    multiplier = compact_mod.get_auto_trigger_multiplier(
        config_explicit_multiplier=cfg.auto_trigger_multiplier
    )
    if trigger == "auto" and multiplier > 1.0:
        effective_tokens = int(base_tokens * multiplier)
    else:
        effective_tokens = base_tokens

    # --- Apply hook-side gates so the preview matches reality ----------------
    trigger_allowed = bool(cfg.triggers) and trigger in cfg.triggers
    # Use the detail variant so we can surface reason + age in --explain-skip.
    try:
        skip_detail = hooks_cli_mod._check_compact_skip_sentinel_detail(resolved_session_id)
        sentinel_fast_path = bool(skip_detail)
        sentinel_reason = skip_detail.reason
        sentinel_age = skip_detail.age_secs
    except Exception:
        sentinel_fast_path = False
        sentinel_reason = ""
        sentinel_age = 0.0

    # Noop-session gate: mirror the pre_compact guard.
    _is_noop = False
    try:
        from . import session as _session_mod

        _sc = _session_mod.safe_load(resolved_session_id, caller="compact-hint")
        if _sc is not None:
            _is_noop = hooks_cli_mod._is_noop_session(_sc)
    except Exception:
        _LOG.debug("compact-hint: failed to load noop-session flag for %s", resolved_session_id, exc_info=True)

    n_events = compact_mod.event_count(resolved_session_id)
    events_sufficient = n_events >= cfg.min_events

    # --- For --diff: capture the prior manifest text BEFORE build_manifest
    # writes a new text sidecar.  build_manifest updates the sidecar on every
    # full render, so if we read it after we'd always see the current version.
    _prior_manifest_text: str | None = None
    if show_diff:
        try:
            text_sidecar = paths_mod.manifest_text_sidecar_path(resolved_session_id)
            if text_sidecar.exists():
                _prior_manifest_text = text_sidecar.read_text(encoding="utf-8")
        except Exception:
            _prior_manifest_text = None

    # Render the manifest with the *effective* budget (matching the hook).
    # We still render even when gates fail so the user can see "what would
    # have been emitted if the gates passed" — but `would_emit` reflects the
    # full gate chain accurately.
    manifest = compact_mod.build_manifest(resolved_session_id, max_tokens=effective_tokens)
    is_cached_stub = manifest.startswith("## Token-Goat Manifest — unchanged since")
    quality_score = compact_mod._score_manifest([manifest]) if manifest else 0
    would_emit = bool(
        cfg.enabled
        and trigger_allowed
        and not sentinel_fast_path
        and not _is_noop
        and events_sufficient
        and manifest
    )

    if json_output:
        typer.echo(json.dumps({
            "enabled": cfg.enabled,
            "triggers": cfg.triggers,
            "trigger_requested": trigger,
            "trigger_allowed": trigger_allowed,
            "min_events": cfg.min_events,
            "max_manifest_tokens": cfg.max_manifest_tokens,
            "auto_trigger_multiplier": multiplier,
            "effective_max_tokens": effective_tokens,
            "event_count": n_events,
            "events_sufficient": events_sufficient,
            "sentinel_fast_path": sentinel_fast_path,
            "sentinel_reason": sentinel_reason,
            "sentinel_age_secs": sentinel_age,
            "is_noop_session": _is_noop,
            "is_cached_stub": is_cached_stub,
            "quality_score": quality_score,
            "token_estimate": compact_mod.estimate_tokens(manifest) if manifest else 0,
            "char_count": len(manifest),
            "would_emit": would_emit,
            "manifest": manifest,
        }, separators=(",", ":")))
        return

    # --- --sections: list section names + token counts -----------------------
    if show_sections:
        if not manifest:
            typer.echo("(no manifest to parse sections from)")
            return
        sections_list = compact_mod._parse_manifest_sections(manifest)
        total_tokens = compact_mod.estimate_tokens(manifest)
        typer.echo(f"Manifest sections  (~{total_tokens} tokens total):")
        typer.echo("")
        for sec_name, sec_tokens, sec_empty in sections_list:
            empty_tag = "  [empty, would be dropped]" if sec_empty else ""
            protected_tag = "  [protected]" if "Edited" in sec_name or "MUST_PRESERVE" in sec_name else ""
            typer.echo(f"  {sec_name:<30}  {sec_tokens:>4} tokens{protected_tag}{empty_tag}")
        return

    # --- --score: quality score breakdown ------------------------------------
    if show_score:
        score_breakdown = compact_mod._score_manifest_breakdown([manifest]) if manifest else {}
        activity_score = compact_mod._session_activity_score(_sc) if not _is_noop and "_sc" in dir() and _sc is not None else 0  # type: ignore[possibly-undefined]  # _sc defined in try block above; runtime guard "_sc" in dir() prevents NameError
        typer.echo(f"Quality score: {quality_score}")
        typer.echo(f"Noop fast-path would fire: {_is_noop}")
        typer.echo(f"Session activity score: {activity_score}  (floor={compact_mod._ACTIVITY_FLOOR})")
        if score_breakdown:
            typer.echo("")
            typer.echo("Score breakdown by section:")
            for sec, pts in sorted(score_breakdown.items(), key=lambda x: -x[1]):
                typer.echo(f"  {sec:<30}  +{pts}")
        else:
            typer.echo("(no scored content in manifest)")
        return

    # --- --diff: unified diff against last emitted manifest ------------------
    if show_diff:
        # _prior_manifest_text was captured BEFORE build_manifest ran above, so
        # it reflects the previous emit, not the one we just rendered.
        if _prior_manifest_text is None:  # type: ignore[possibly-undefined]  # defined in 'if show_diff' block above; show_diff is True here by condition
            typer.echo("No previous manifest to compare against.")
            typer.echo(
                "(The text sidecar is written the first time compact-hint or the "
                "PreCompact hook renders a manifest for this session.)"
            )
            return

        # Strip the volatile trailing "# as-of:" line from both sides so a timestamp-only tick (identical content built a clock-second apart) is not reported as a change.
        current_text = compact_mod.normalize_for_cache(manifest or "")
        prior_lines = compact_mod.normalize_for_cache(_prior_manifest_text).splitlines(keepends=True)
        current_lines = current_text.splitlines(keepends=True)
        diff_lines = list(difflib.unified_diff(
            prior_lines,
            current_lines,
            fromfile="previous manifest",
            tofile="current manifest",
            lineterm="",
        ))
        if not diff_lines:
            typer.echo("Manifest unchanged from last emit (no diff).")
        else:
            for dl in diff_lines:
                typer.echo(dl)
        return

    # --- Human-readable preview with explicit gate chain ---------------------
    typer.echo(f"compact-assist enabled: {cfg.enabled}")
    typer.echo(f"triggers: {', '.join(cfg.triggers)}")
    boost_note = ""
    if trigger == "auto" and multiplier > 1.0:
        boost_note = f"  (auto boost ×{multiplier:g}: {base_tokens} → {effective_tokens})"
    typer.echo(
        f"trigger: {trigger} "
        f"({'allowed' if trigger_allowed else 'BLOCKED — not in cfg.triggers'})"
    )
    typer.echo(
        f"budget: {effective_tokens} tokens"
        f"{boost_note}"
    )
    typer.echo(f"min_events: {cfg.min_events}  |  session events: {n_events}")
    sentinel_state = (
        "FRESH — hook would short-circuit before reaching this manifest"
        if sentinel_fast_path
        else "absent or stale (hook would run normally)"
    )
    typer.echo(f"compact-skip sentinel: {sentinel_state}")

    if explain_skip or sentinel_fast_path or _is_noop:
        typer.echo("")
        typer.echo("--- skip gate breakdown ---")
        typer.echo(f"  sentinel_fast_path : {sentinel_fast_path}")
        if sentinel_fast_path or sentinel_age > 0.0:
            reason_str = sentinel_reason or "(none)"
            typer.echo(f"  sentinel reason    : {reason_str}")
            typer.echo(f"  sentinel age       : {sentinel_age:.0f}s")
            # Surface activity-floor counts when available.
            try:
                _sent_path = hooks_cli_mod.paths.compact_skip_sentinel_path(resolved_session_id)
                _s_edited, _s_bash = hooks_cli_mod._read_sentinel_counts(_sent_path)
                _c_edited, _c_bash = hooks_cli_mod._current_session_counts(resolved_session_id)
                if _s_edited is not None:
                    typer.echo(
                        f"  sentinel counts    : edited={_s_edited}, bash={_s_bash}"
                    )
                    typer.echo(
                        f"  current counts     : edited={_c_edited}, bash={_c_bash}"
                    )
            except Exception:
                _LOG.debug("compact-hint: failed to read sentinel/current counts for debug output", exc_info=True)
        typer.echo(f"  noop_session       : {_is_noop}")
        typer.echo("")

    # Gate chain — fail-fast in the order the live hook applies them.
    if not cfg.enabled:
        typer.echo("(disabled — set TOKEN_GOAT_COMPACT_ASSIST=1 or edit config.toml to enable)")
        return
    if not trigger_allowed:
        typer.echo(
            f"(no manifest: trigger '{trigger}' not in configured triggers "
            f"{list(cfg.triggers)})"
        )
        return
    if sentinel_fast_path:
        typer.echo(
            "(no manifest: compact-skip sentinel is fresh — the hook would return "
            "{continue:true} without building a manifest)"
        )
        return
    if not events_sufficient:
        typer.echo(f"(no manifest: {n_events} events < min_events {cfg.min_events})")
        return
    if not manifest:
        typer.echo("(no manifest: session cache empty or all-noise)")
        return

    typer.echo("--- manifest that would be injected as systemMessage ---")
    typer.echo(manifest)
    typer.echo("---")
    # Use the canonical token estimator (compact.estimate_tokens) instead of
    # `len // 4`.  The old approximation under-counted by ~25 % vs. the actual
    # estimator used inside `_render`, so the preview's "~N tokens" footer was
    # consistently smaller than the value the hook reports in its debug log.
    est_tokens = compact_mod.estimate_tokens(manifest)
    stub_note = "  [cached stub: sidecar fingerprint matched]" if is_cached_stub else ""
    typer.echo(f"({len(manifest)} chars, ~{est_tokens} tokens){stub_note}")


def _config_get_value(config: object, key: str) -> object:
    """Retrieve a nested config attribute by dotted key (e.g. ``"compact_assist.enabled"``).

    Walks the dataclass hierarchy attribute-by-attribute and returns the leaf
    value.  Raises ``KeyError`` if any component of *key* is absent.
    """
    target: object = config
    parts = [part for part in key.split(".") if part]
    if not parts:
        raise KeyError(key)
    for part in parts:
        if not hasattr(target, part):
            raise KeyError(key)
        target = getattr(target, part)
    return target


def _coerce_config_value(current: object, raw_value: str) -> object:
    """Coerce *raw_value* (a CLI string) to the same type as *current*.

    Dispatch table:
    - dataclass → parsed from JSON object
    - bool      → accepts ``1/true/yes/on`` or ``0/false/no/off``
    - int       → ``int(raw_value)``
    - list      → JSON array literal or comma-separated string
    - str       → returned as-is (stripped)

    Raises ``ValueError`` for invalid inputs.
    """
    raw_value = raw_value.strip()

    if is_dataclass(current):
        parsed = json.loads(raw_value)
        if not isinstance(parsed, dict):
            raise ValueError("expected a JSON object")
        return current.__class__(**parsed)

    if isinstance(current, bool):
        lowered = raw_value.lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
        raise ValueError("expected a boolean value")

    if is_real_int(current):
        return int(raw_value)

    if isinstance(current, list):
        if raw_value.startswith("["):
            parsed = json.loads(raw_value)
            if not isinstance(parsed, list):
                raise ValueError("expected a JSON list")
            return [str(item) for item in parsed]
        if not raw_value:
            return []
        return [part.strip() for part in raw_value.split(",") if part.strip()]

    return raw_value


def _config_set_value(config: config_mod.Config, key: str, raw_value: str) -> object:
    """Set a nested config attribute by dotted key, coercing *raw_value* to the right type.

    Navigates the dataclass hierarchy to the parent of the leaf attribute, calls
    :func:`_coerce_config_value` to convert the string, then uses ``setattr`` to
    mutate *config* in place.  Returns the coerced value so callers can echo it.
    Raises ``KeyError`` if any path component is missing.
    """
    parts = [part for part in key.split(".") if part]
    if not parts:
        raise KeyError(key)

    target: object = config
    for part in parts[:-1]:
        if not hasattr(target, part):
            raise KeyError(key)
        target = getattr(target, part)

    attr = parts[-1]
    if not hasattr(target, attr):
        raise KeyError(key)

    current = getattr(target, attr)
    updated = _coerce_config_value(current, raw_value)
    setattr(target, attr, updated)
    return updated


@config_app.command(name="list")
def config_list(
    json_output: bool = _OPT_JSON,
) -> None:
    """List all config keys with their current values and defaults."""
    defaults = config_mod.Config()
    current = config_mod.load()

    # Flatten a dataclass to dotted-key -> value pairs
    def _flatten(obj: object, prefix: str = "") -> list[tuple[str, object]]:
        """Recursively expand a dataclass into ``(dotted_key, value)`` pairs."""
        from dataclasses import fields as _fields
        pairs: list[tuple[str, object]] = []
        if not is_dataclass(obj) or isinstance(obj, type):
            return pairs
        for f in _fields(obj):
            key = f"{prefix}{f.name}" if not prefix else f"{prefix}.{f.name}"
            val = getattr(obj, f.name)
            if is_dataclass(val) and not isinstance(val, type):
                pairs.extend(_flatten(val, prefix=key))
            else:
                pairs.append((key, val))
        return pairs

    default_pairs = dict(_flatten(defaults))
    current_pairs = dict(_flatten(current))

    if json_output:
        out = {
            k: {"value": current_pairs[k], "default": default_pairs[k]}
            for k in current_pairs
        }
        typer.echo(json_compact(out))
        return

    # Human-readable table
    col_key = max(len(k) for k in current_pairs) + 2
    for k in current_pairs:
        cur = current_pairs[k]
        dflt = default_pairs[k]
        cur_str = json.dumps(cur, ensure_ascii=False)
        dflt_str = json.dumps(dflt, ensure_ascii=False)
        changed = cur != dflt
        marker = "*" if changed else " "
        if sys.stdout.isatty() and not os.environ.get("NO_COLOR"):
            key_fmt = f"\033[36m{k}\033[0m"
            cur_fmt = f"\033[33m{cur_str}\033[0m" if changed else cur_str
        else:
            key_fmt = k
            cur_fmt = cur_str
        typer.echo(f"{marker} {key_fmt:<{col_key + 9}} {cur_fmt}  (default: {dflt_str})")


@config_app.command(name="validate")
def config_validate(
    json_output: bool = _OPT_JSON,
) -> None:
    """Validate config.toml and report unknown keys with did-you-mean suggestions.

    Parses the raw TOML file and compares every top-level key against the set of
    known sections.  Unknown keys are reported with the closest matching known key
    so a typo (``compac_assist``) produces a helpful ``did you mean: compact_assist``
    suggestion.
    """
    import difflib
    import tomllib
    from dataclasses import fields as _dc_fields

    from . import paths as _paths

    def _section_keys(cls: type) -> frozenset[str]:
        return frozenset(f.name for f in _dc_fields(cls))

    # Reuse the module-level set from config.py so a new section only needs
    # to be registered in one place — adding it to _KNOWN_SECTIONS there
    # automatically makes config validate accept it here.
    _KNOWN_TOP_LEVEL: frozenset[str] = config_mod._KNOWN_SECTIONS

    # Derived from dataclasses.fields() — auto-tracks new config fields.
    _KNOWN_SECTION_KEYS: dict[str, frozenset[str]] = {
        "compact_assist":    _section_keys(config_mod.CompactAssistConfig),
        "bash_compress":     _section_keys(config_mod.BashCompressConfig),
        "session_brief":     _section_keys(config_mod.SessionBriefConfig),
        "skill_preservation": _section_keys(config_mod.SkillPreservationConfig),
        "image_shrink":      _section_keys(config_mod.ImageShrinkConfig),
        "curator":           _section_keys(config_mod.CuratorConfig),
        "hint_budget":       _section_keys(config_mod.HintBudgetConfig),
        "hints":             _section_keys(config_mod.HintsConfig),
        "repomap":           _section_keys(config_mod.RepomapConfig),
        "stats":             _section_keys(config_mod.StatsConfig),
        "webfetch":          _section_keys(config_mod.WebFetchConfig),
    }

    cfg_path = _paths.config_path()
    issues: list[dict[str, object]] = []

    if not cfg_path.exists():
        if json_output:
            typer.echo(json.dumps({"ok": True, "issues": [], "note": "config file not found (defaults in use)"}, separators=(",", ":")))
        else:
            typer.echo("config file not found — defaults in use, nothing to validate")
        return

    try:
        raw = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        issue: dict[str, object] = {"path": str(cfg_path), "error": f"TOML parse error: {exc}"}
        if json_output:
            typer.echo(json_compact({"ok": False, "issues": [issue]}))
        else:
            _error(f"TOML parse error in {cfg_path}: {exc}")
        raise typer.Exit(1) from None

    def _closest(key: str, known: frozenset[str]) -> str | None:
        matches = difflib.get_close_matches(key, sorted(known), n=1, cutoff=0.6)
        return matches[0] if matches else None

    # Check top-level keys
    _issue: dict[str, object]
    for key in raw:
        if key not in _KNOWN_TOP_LEVEL:
            suggestion = _closest(key, _KNOWN_TOP_LEVEL)
            _issue = {"path": str(cfg_path), "key": key, "message": f"unknown top-level key: '{key}'"}
            if suggestion:
                _issue["suggestion"] = f"did you mean: {suggestion}"
            issues.append(_issue)

    # Check per-section keys
    for section_key, known_section_keys in _KNOWN_SECTION_KEYS.items():
        section_val = raw.get(section_key)
        if not isinstance(section_val, dict):
            continue
        for sub_key in section_val:
            if sub_key not in known_section_keys:
                suggestion = _closest(sub_key, known_section_keys)
                _issue = {"path": str(cfg_path), "key": f"{section_key}.{sub_key}", "message": f"unknown key: '{section_key}.{sub_key}'"}
                if suggestion:
                    _issue["suggestion"] = f"did you mean: {section_key}.{suggestion}"
                issues.append(_issue)

    ok = not issues
    if json_output:
        typer.echo(json.dumps({"ok": ok, "issues": issues, "config_path": str(cfg_path)}, separators=(",", ":")))
        if not ok:
            raise typer.Exit(1)
        return

    if ok:
        typer.echo(f"config OK: {cfg_path}")
        return

    for _issue in issues:
        line = f"  [UNKNOWN] {_issue['key']}"
        if "suggestion" in _issue:
            line += f"  ({_issue['suggestion']})"
        typer.echo(line)
    typer.echo(f"\n{len(issues)} issue(s) found in {cfg_path}")
    raise typer.Exit(1)


@config_app.command()
def get(
    key: str | None = typer.Argument(None, help="Dotted key to retrieve (e.g. compact_assist.enabled). Omit to show all config in TOML format."),
) -> None:
    """Show current config value(s).

    With no KEY, prints the full config.toml in TOML format.  With KEY, prints
    just that value (supports dot notation: ``compact_assist.max_manifest_tokens``).
    Sections are accepted as keys and return a JSON object.
    """
    import tomli_w

    cfg = config_mod.load()

    if key is None:
        data = asdict(cfg)
        data["schema_version"] = config_mod.CONFIG_SCHEMA_VERSION
        typer.echo(tomli_w.dumps(data).rstrip())
        return

    try:
        value = _config_get_value(cfg, key)
    except KeyError:
        _error(f"unknown config key: {key}")
        raise typer.Exit(2) from None

    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)

    typer.echo(json_compact(value))


@config_app.command()
def set(key: str, value: str) -> None:
    """Set a config value, creating config.toml if it does not exist.

    VALUE is coerced to the correct type automatically:
    booleans accept ``true``/``false``/``yes``/``no``/``1``/``0``,
    integers accept decimal strings, lists accept comma-separated values or
    a JSON array literal.
    """
    cfg = config_mod.load()
    try:
        updated = _config_set_value(cfg, key, value)
    except KeyError:
        _error(f"unknown config key: {key}")
        raise typer.Exit(2) from None
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        _error(f"invalid value for {key}: {exc}")
        raise typer.Exit(2) from None

    config_mod.save(cfg)
    if is_dataclass(updated) and not isinstance(updated, type):
        updated_display = json.dumps(asdict(updated), ensure_ascii=False)
    else:
        updated_display = json.dumps(updated, ensure_ascii=False)
    typer.echo(f"Set {key} = {updated_display}")


@config_app.command()
def reset(
    key: str | None = typer.Argument(None, help="Dotted key to reset (e.g. compact_assist.enabled). Omit to reset ALL settings."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),
) -> None:
    """Reset config to defaults — one key or everything.

    With no KEY, deletes config.toml entirely (restoring all defaults).  With
    KEY, removes that specific key from the file so it falls back to its default.
    Prompts for confirmation when deleting the whole file unless ``--yes`` is given.
    """
    from . import paths as _paths

    cfg_path = _paths.config_path()

    if key is None:
        if not cfg_path.exists():
            typer.echo("Config file does not exist — already at defaults.")
            return
        if not yes:
            confirmed = typer.confirm("Delete config.toml and restore all defaults?", default=False)
            if not confirmed:
                typer.echo("Aborted.")
                raise typer.Exit(0)
        cfg_path.unlink()
        config_mod._config_mtime_cache = None  # type: ignore[attr-defined]  # resetting the module-level cache sentinel; accessing private module variable by design
        typer.echo(f"Deleted {cfg_path} — all settings restored to defaults.")
        return

    # Single-key reset: load current config, reset that field to its default,
    # then save.  If the key is a section, replace the whole sub-dataclass.
    cfg = config_mod.load()
    defaults = config_mod.Config()
    try:
        default_value = _config_get_value(defaults, key)
    except KeyError:
        _error(f"unknown config key: {key}")
        raise typer.Exit(2) from None

    parts = [p for p in key.split(".") if p]
    target: object = cfg
    for part in parts[:-1]:
        target = getattr(target, part)
    setattr(target, parts[-1], default_value)
    config_mod.save(cfg)
    if is_dataclass(default_value) and not isinstance(default_value, type):
        default_display = json.dumps(asdict(default_value), ensure_ascii=False)
    else:
        default_display = json.dumps(default_value, ensure_ascii=False)
    typer.echo(f"Reset {key} = {default_display} (default)")


@config_app.command()
def path() -> None:
    """Print the path to token-goat's config.toml."""
    from . import paths as _paths

    typer.echo(str(_paths.config_path()))


@app.command("clean-cache", rich_help_panel="Advanced")
def cmd_clean_cache(
    images: bool = typer.Option(False, "--images", help="Prune the image shrink cache to its configured floor."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Prune on-disk caches to their configured floor.

    Currently supported targets:

    ``--images``: Prune the image shrink cache (``images/`` under the data dir)
    so its total size falls at or below the configured LRU floor.  Uses the
    same eviction logic as the background worker — oldest files first.

    At least one target flag (``--images``) must be specified.
    """
    if not images:
        _error("specify at least one cache target: --images")
        raise typer.Exit(2)

    results: dict[str, object] = {}

    if images:
        try:
            from . import paths as _paths
            from . import worker as _worker

            cache_dir = _paths.image_cache_dir()
            if not cache_dir.exists():
                results["images"] = {"status": "skipped", "reason": "cache dir does not exist"}
            else:
                # Gather current size before eviction
                before_bytes = sum(
                    f.stat().st_size
                    for f in cache_dir.iterdir()
                    if f.is_file() and not f.is_symlink()
                )
                bytes_freed, files_evicted = _worker.evict_image_cache_if_over_limit()
                after_bytes = before_bytes - bytes_freed
                results["images"] = {
                    "status": "ok",
                    "evicted_files": files_evicted,
                    "before_bytes": before_bytes,
                    "after_bytes": after_bytes,
                    "freed_bytes": bytes_freed,
                }
        except Exception as exc:
            results["images"] = {"status": "error", "error": str(exc)}

    if json_output:
        typer.echo(json_compact(results))
        return

    for target, info in results.items():
        if not isinstance(info, dict):
            typer.echo(f"  {target}: {info}")
            continue
        status = info.get("status", "?")
        if status == "ok":
            freed = int(info.get("freed_bytes", 0))
            evicted_count = info.get("evicted_files", 0)
            after = int(info.get("after_bytes", 0))
            typer.echo(f"  {target}: evicted {evicted_count} file(s), freed {freed:,} bytes  (cache now {after:,} bytes)")
        elif status == "skipped":
            typer.echo(f"  {target}: skipped — {info.get('reason', '')}")
        else:
            typer.echo(f"  {target}: ERROR — {info.get('error', 'unknown')}")


@app.command("prune-cache", rich_help_panel="Advanced")
def cmd_prune_cache(
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would be removed without deleting."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Manually trigger cache eviction across all cache directories.

    Prunes images/, bash_outputs/, web_outputs/, skills/, and session files.
    Old session files (>7 days) and orphaned sidecar files are also cleaned.

    With ``--dry-run``: show what would be removed without actually deleting.
    """
    from . import bash_cache as _bash_cache
    from . import cache_common as _cache_common
    from . import paths as _paths
    from . import skill_cache as _skill_cache
    from . import web_cache as _web_cache

    results: dict[str, object] = {}
    total_freed_bytes = 0
    total_files = 0

    # Helper to gather cache stats before and after (or for dry-run)
    def get_cache_stats(cache_dir: Path) -> dict[str, int | bool]:
        """Return size and file count for a cache directory."""
        if not cache_dir.exists():
            return {"exists": False, "size_bytes": 0, "file_count": 0}
        try:
            size = sum(
                f.stat().st_size
                for f in cache_dir.iterdir()
                if f.is_file() and not f.is_symlink()
            )
            count = len([f for f in cache_dir.iterdir() if f.is_file() and not f.is_symlink()])
        except OSError:
            return {"exists": True, "size_bytes": 0, "file_count": 0}
        else:
            return {"exists": True, "size_bytes": size, "file_count": count}

    # Prune bash_outputs
    try:
        cache_dir = _cache_common.get_cache_dir("bash_outputs")
        before = get_cache_stats(cache_dir)
        if before["exists"]:
            removed = 0 if dry_run else _bash_cache.evict_old_entries()
            after = get_cache_stats(cache_dir) if not dry_run else before
            freed = before["size_bytes"] - after["size_bytes"]
            results["bash_outputs"] = {
                "status": "ok",
                "files_removed": removed,
                "bytes_freed": freed,
            }
            total_freed_bytes += freed
            total_files += removed
        else:
            results["bash_outputs"] = {"status": "skipped", "reason": "cache dir does not exist"}
    except Exception as exc:
        results["bash_outputs"] = {"status": "error", "error": str(exc)}

    # Prune web_outputs
    try:
        cache_dir = _cache_common.get_cache_dir("web_outputs")
        before = get_cache_stats(cache_dir)
        if before["exists"]:
            removed = 0 if dry_run else _web_cache.evict_old_entries()
            after = get_cache_stats(cache_dir) if not dry_run else before
            freed = before["size_bytes"] - after["size_bytes"]
            results["web_outputs"] = {
                "status": "ok",
                "files_removed": removed,
                "bytes_freed": freed,
            }
            total_freed_bytes += freed
            total_files += removed
        else:
            results["web_outputs"] = {"status": "skipped", "reason": "cache dir does not exist"}
    except Exception as exc:
        results["web_outputs"] = {"status": "error", "error": str(exc)}

    # Prune mcp_outputs
    try:
        from . import mcp_cache as _mcp_cache
        cache_dir = _cache_common.get_cache_dir("mcp_outputs")
        before = get_cache_stats(cache_dir)
        if before["exists"]:
            removed = 0 if dry_run else _mcp_cache.evict_old_entries()
            after = get_cache_stats(cache_dir) if not dry_run else before
            freed = before["size_bytes"] - after["size_bytes"]
            results["mcp_outputs"] = {
                "status": "ok",
                "files_removed": removed,
                "bytes_freed": freed,
            }
            total_freed_bytes += freed
            total_files += removed
        else:
            results["mcp_outputs"] = {"status": "skipped", "reason": "cache dir does not exist"}
    except Exception as exc:
        results["mcp_outputs"] = {"status": "error", "error": str(exc)}

    # Prune skills
    try:
        cache_dir = _cache_common.get_cache_dir("skills")
        before = get_cache_stats(cache_dir)
        if before["exists"]:
            removed = 0 if dry_run else _skill_cache.evict_old_entries()
            after = get_cache_stats(cache_dir) if not dry_run else before
            freed = before["size_bytes"] - after["size_bytes"]
            results["skills"] = {
                "status": "ok",
                "files_removed": removed,
                "bytes_freed": freed,
            }
            total_freed_bytes += freed
            total_files += removed
        else:
            results["skills"] = {"status": "skipped", "reason": "cache dir does not exist"}
    except Exception as exc:
        results["skills"] = {"status": "error", "error": str(exc)}

    # Prune images
    try:
        from . import worker as _worker
        cache_dir = _paths.image_cache_dir()
        before = get_cache_stats(cache_dir)
        if before["exists"]:
            if dry_run:
                removed = 0
                freed = 0
            else:
                freed, removed = _worker.evict_image_cache_if_over_limit()
            results["images"] = {
                "status": "ok",
                "files_removed": removed,
                "bytes_freed": freed,
            }
            total_freed_bytes += freed
            total_files += removed
        else:
            results["images"] = {"status": "skipped", "reason": "cache dir does not exist"}
    except Exception as exc:
        results["images"] = {"status": "error", "error": str(exc)}

    # Clean old session files (>7 days)
    try:
        sessions_dir = _paths.session_cache_path("dummy").parent
        if sessions_dir.exists():
            now = time.time()
            removed = 0
            freed = 0
            seven_days_secs = 7 * 24 * 3600
            for f in sessions_dir.glob("*.json"):
                if f.is_file() and not f.is_symlink():
                    try:
                        mtime = f.stat().st_mtime
                        if now - mtime > seven_days_secs:
                            size = f.stat().st_size
                            if not dry_run:
                                f.unlink()
                            removed += 1
                            freed += size
                    except OSError:
                        continue
            if removed > 0:
                results["sessions"] = {
                    "status": "ok",
                    "files_removed": removed,
                    "bytes_freed": freed,
                }
                total_freed_bytes += freed
                total_files += removed
            else:
                results["sessions"] = {"status": "ok", "files_removed": 0, "bytes_freed": 0}
        else:
            results["sessions"] = {"status": "skipped", "reason": "sessions dir does not exist"}
    except Exception as exc:
        results["sessions"] = {"status": "error", "error": str(exc)}

    if json_output:
        output = {
            "dry_run": dry_run,
            "total_files_removed": total_files,
            "total_bytes_freed": total_freed_bytes,
            "details": results,
        }
        typer.echo(json_compact(output))
        return

    # Text output
    action_verb = "would free" if dry_run else "freed"
    for cache_name in ["bash_outputs", "web_outputs", "mcp_outputs", "skills", "images", "sessions"]:
        info = results.get(cache_name, {})
        if not isinstance(info, dict):
            continue
        status = info.get("status", "?")
        if status == "ok":
            freed = int(info.get("bytes_freed", 0))
            removed = int(info.get("files_removed", 0))
            if freed > 0 or removed > 0:
                typer.echo(f"{cache_name}: {action_verb} {freed:,} bytes ({removed} file{'s' if removed != 1 else ''})")
            else:
                typer.echo(f"{cache_name}: no cleanup needed")
        elif status == "skipped":
            typer.echo(f"{cache_name}: skipped — {info.get('reason', '')}")
        else:
            typer.echo(f"{cache_name}: ERROR — {info.get('error', 'unknown')}")

    typer.echo()
    typer.echo(f"Total: {action_verb} {total_freed_bytes:,} bytes ({total_files} file{'s' if total_files != 1 else ''})")
    if dry_run:
        typer.echo("(Use without --dry-run to actually delete)")


@app.command("diff", rich_help_panel="Core")
def cmd_diff(
    since: str = typer.Option("HEAD~1", "--since", help="Git ref to diff against (commit, branch, tag). Default: HEAD~1."),
    session_id: str | None = typer.Option(None, "--session", "-s", help="Show files edited in this session instead of running git diff."),
    symbols: bool = typer.Option(False, "--symbols", help="List changed symbols (functions/classes) for each file."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show files changed since a git ref, with optional symbol-level context.

    By default diffs ``HEAD~1..HEAD`` (the last commit).  Use ``--since`` to
    compare against any ref: a branch name, tag, or commit hash.

    ``--session`` switches to session mode: shows files edited in the given
    Claude session (from the session cache) rather than running ``git diff``.

    ``--symbols`` parses the diff output for changed function/class names
    extracted from ``git diff`` hunk headers (the text after the fourth ``@@``).

    Examples::

        token-goat diff
        token-goat diff --since main
        token-goat diff --since HEAD~5 --symbols
        token-goat diff --session abc123 --symbols
    """
    import os as _os
    import sys as _sys

    from .util import run_git

    cwd = _os.getcwd()

    # ---- session mode -------------------------------------------------------
    if session_id is not None:
        _validate_session_id(session_id)
        from . import session as session_mod

        edited = session_mod.list_edited(session_id)
        if not edited:
            if json_output:
                _emit_json({"mode": "session", "session_id": session_id, "files": []})
            typer.echo("(no files edited in this session)")
            return

        # Sort by edit count descending so the most-edited files appear first.
        sorted_edited = sorted(edited.items(), key=lambda kv: kv[1], reverse=True)

        if json_output:
            _emit_json({
                "mode": "session",
                "session_id": session_id,
                "files": [{"path": p, "edits": c} for p, c in sorted_edited],
            })

        typer.echo(f"Files edited in session {session_id[:8]}:")
        for path, count in sorted_edited:
            edit_label = f"{count} edit{'s' if count != 1 else ''}"
            typer.echo(f"  {path}  ({edit_label})")

        if symbols:
            # For session mode + --symbols: diff HEAD~1 for the edited files.
            edited_paths = [p for p, _ in sorted_edited]
            _show_symbols_for_paths(edited_paths, since, cwd, json_output=False)
        return

    # ---- git diff mode -------------------------------------------------------
    # Verify this is a git repo and the ref exists.
    check_ref = run_git(["rev-parse", "--verify", since], cwd=cwd)
    if check_ref.returncode != 0:
        _error(f"git ref not found: {since!r}")
        raise typer.Exit(1)

    # Get the summary (file names + insertions/deletions).
    stat_result = run_git(["diff", "--stat", f"{since}..HEAD"], cwd=cwd)
    if stat_result.returncode != 0:
        _error(f"git diff failed: {stat_result.stderr.strip()}")
        raise typer.Exit(1)

    # Parse changed file paths from --stat output.
    # Lines look like: " src/foo.py | 12 ++++-------"
    # Last line is the summary: " 3 files changed, ..."
    stat_lines = stat_result.stdout.splitlines()
    file_lines = [ln for ln in stat_lines if "|" in ln]
    changed_files: list[str] = []
    for ln in file_lines:
        path_part = ln.split("|")[0].strip()
        # Handle rename notation "a => b" — keep the right-hand side.
        if "=>" in path_part:
            path_part = path_part.split("=>")[-1].strip().rstrip("}")
        changed_files.append(path_part)

    summary_line = next((ln for ln in reversed(stat_lines) if "changed" in ln), "")

    if not changed_files:
        if json_output:
            _emit_json({"mode": "git", "since": since, "summary": summary_line.strip(), "files": []})
        typer.echo(f"No changes between {since!r} and HEAD.")
        return

    # Build symbol data if requested.
    symbol_map: dict[str, list[str]] = {}
    if symbols:
        symbol_map = _extract_diff_symbols(since, cwd)

    if json_output:
        files_out = []
        for f in changed_files:
            entry: dict[str, object] = {"path": f}
            if symbols:
                entry["symbols"] = symbol_map.get(f, [])
            files_out.append(entry)
        _emit_json({
            "mode": "git",
            "since": since,
            "summary": summary_line.strip(),
            "files": files_out,
        })

    # Human-readable output.
    use_colour = _sys.stdout.isatty()
    typer.echo(f"Changes since {since!r}:")
    for ln in file_lines:
        typer.echo(f"  {ln.strip()}")
    if summary_line:
        typer.echo(f"  {summary_line.strip()}")

    if symbols and symbol_map:
        typer.echo("")
        typer.echo("Symbols changed:")
        for f in changed_files:
            syms = symbol_map.get(f)
            if not syms:
                continue
            label = typer.style(f, bold=True) if use_colour else f
            typer.echo(f"  {label}")
            for s in syms:
                typer.echo(f"    {s}")


def _extract_diff_symbols(since: str, cwd: str) -> dict[str, list[str]]:
    """Parse ``git diff --unified=0 <since>..HEAD`` hunk headers for symbol names.

    Each ``@@`` header optionally ends with a function/class name after the
    fourth ``@@``, e.g. ``@@ -10,3 +10,5 @@ def my_function``.  This function
    collects those names, deduplicated and ordered by first appearance.

    Returns a dict mapping relative file path → list of changed symbol names.
    """
    import re as _re

    from .util import run_git

    result = run_git(["diff", "--unified=0", f"{since}..HEAD"], cwd=cwd, timeout=30)
    if result.returncode != 0:
        return {}

    symbol_map: dict[str, list[str]] = {}
    current_file: str | None = None
    _HUNK_RE = _re.compile(r"^@@ [^@]+ @@ ?(.+)$")
    _FILE_RE = _re.compile(r"^\+\+\+ b/(.+)$")

    for line in result.stdout.splitlines():
        m_file = _FILE_RE.match(line)
        if m_file:
            current_file = m_file.group(1)
            continue
        if current_file is None:
            continue
        m_hunk = _HUNK_RE.match(line)
        if m_hunk:
            raw = m_hunk.group(1).strip()
            if not raw:
                continue
            # Extract just the first identifier-like name (drop parameter list noise).
            # "def foo(a, b):" → "foo", "class Bar:" → "Bar", "func baz() {" → "baz"
            name_part = raw.split("(")[0].split("{")[0].strip()
            # Drop leading keywords: def, func, function, class, async def, fn, pub fn, etc.
            for kw in ("async def ", "def ", "func ", "function ", "class ", "fn ", "pub fn ", "pub async fn "):
                if name_part.startswith(kw):
                    name_part = name_part[len(kw):]
                    break
            # Strip trailing colon (Python class/def lines) and surrounding whitespace.
            name_part = name_part.strip().rstrip(":")
            if not name_part:
                continue
            syms = symbol_map.setdefault(current_file, [])
            if name_part not in syms:
                syms.append(name_part)

    return symbol_map


def _show_symbols_for_paths(paths: list[str], since: str, cwd: str, *, json_output: bool) -> None:
    """Print symbol changes for the given file paths, filtering from a full diff."""
    symbol_map = _extract_diff_symbols(since, cwd)
    if not symbol_map:
        return
    filtered = {p: syms for p, syms in symbol_map.items() if p in paths}
    if not filtered:
        return
    typer.echo("")
    typer.echo("Symbols changed (vs HEAD~1):")
    for f, syms in filtered.items():
        typer.echo(f"  {f}")
        for s in syms:
            typer.echo(f"    {s}")


def _format_relative_time(age_secs: float) -> str:
    """Return a compact human-readable age string (e.g. '5m', '2h', '3d')."""
    if age_secs < 60:
        return f"{int(age_secs)}s"
    if age_secs < 3600:
        return f"{int(age_secs / 60)}m"
    if age_secs < 86400:
        return f"{int(age_secs / 3600)}h"
    return f"{int(age_secs / 86400)}d"


def _load_session_summaries(
    limit: int,
    project_filter: str | None,
) -> list[dict[str, object]]:
    """Scan the sessions directory and return summary dicts sorted by last_activity_ts desc."""
    import contextlib

    from . import paths as _paths

    sessions_dir = _paths.sessions_dir()
    if not sessions_dir.exists():
        return []

    rows: list[dict[str, object]] = []
    for f in sessions_dir.iterdir():
        if not f.is_file() or f.suffix != ".json":
            continue
        with contextlib.suppress(Exception):
            raw = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            sid = str(raw.get("session_id", f.stem))
            cwd = raw.get("cwd") or ""
            last_ts = float(raw.get("last_activity_ts") or f.stat().st_mtime)
            started_ts = float(raw.get("started_ts") or last_ts)
            file_count = len(raw.get("files") or {})
            edit_count = sum(int(v or 0) for v in (raw.get("edited_files") or {}).values())
            hints_emitted = int(raw.get("hints_emitted") or 0)
            bash_count = len(raw.get("bash_history") or {})
            web_count = len(raw.get("web_history") or {})

            project_basename = ""
            if cwd:
                project_basename = Path(cwd).name

            if project_filter:
                norm_filter = Path(project_filter).resolve()
                cwd_path = Path(cwd).resolve() if cwd else None
                if cwd_path != norm_filter:
                    continue

            rows.append({
                "session_id": sid,
                "project": project_basename,
                "cwd": cwd,
                "last_activity_ts": last_ts,
                "started_ts": started_ts,
                "file_count": file_count,
                "edit_count": edit_count,
                "hints_emitted": hints_emitted,
                "bash_count": bash_count,
                "web_count": web_count,
            })

    rows.sort(key=lambda r: float(r["last_activity_ts"]), reverse=True)  # type: ignore[arg-type]  # r["last_activity_ts"] is float at runtime; dict typed as dict[str,object] so mypy sees object here
    if limit > 0:
        rows = rows[:limit]
    return rows


@app.command("sessions", rich_help_panel="Core")
def cmd_sessions(
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum sessions to show (newest first)"),
    project: str | None = typer.Option(
        None,
        "--project",
        help="Filter to sessions for this project root path (defaults to all projects).",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """List recent sessions with per-session stats.

    Shows session ID (truncated), project name, last active time, file count,
    edit count, and hints emitted.  Use ``token-goat sessions show SESSION_ID``
    for full details on one session.
    """
    rows = _load_session_summaries(limit, project)

    if json_output:
        typer.echo(json_compact(rows))
        return

    if not rows:
        typer.echo("(no sessions found)")
        return

    now = time.time()
    header = f"{'SESSION':>26}  {'PROJECT':<20}  {'LAST ACTIVE':>11}  {'FILES':>5}  {'EDITS':>5}  {'HINTS':>5}  {'BASH':>4}  {'WEB':>4}"
    typer.echo(header)
    typer.echo("-" * len(header))
    for r in rows:
        sid = str(r["session_id"])
        sid_short = sid[:24] if len(sid) > 24 else sid
        proj = str(r["project"])[:20]
        age = _format_relative_time(now - cast("float", r["last_activity_ts"]))
        typer.echo(
            f"{sid_short:>26}  {proj:<20}  {age:>11}  {cast('int', r['file_count']):>5}  "
            f"{cast('int', r['edit_count']):>5}  {cast('int', r['hints_emitted']):>5}  "
            f"{cast('int', r['bash_count']):>4}  {cast('int', r['web_count']):>4}"
        )


@app.command(rich_help_panel="Core")
def hot(
    limit: int = typer.Option(20, "--limit", "-n", help="Number of files to show."),
    project: str | None = typer.Option(
        None,
        "--project",
        help="Filter to sessions from this project root (defaults to current project).",
    ),
    json_output: bool = _OPT_JSON,
) -> None:
    """Rank files by how often they appear across all recent sessions.

    Aggregates read and edit counts across every session on record and shows
    which files get touched most.  Useful for finding the most-read files before starting a task.

    Examples::

        token-goat hot
        token-goat hot --limit 10 --project /path/to/repo
        token-goat hot --json
    """
    import contextlib
    import os

    from . import paths as _paths

    sessions_dir = _paths.sessions_dir()
    cwd_str = str(Path.cwd())

    project_filter: str | None = project or cwd_str

    freq: dict[str, int] = {}
    edit_freq: dict[str, int] = {}

    if sessions_dir.exists():
        for f in sessions_dir.iterdir():
            if not f.is_file() or f.suffix != ".json":
                continue
            with contextlib.suppress(Exception):
                import json as _json

                raw = _json.loads(f.read_text(encoding="utf-8", errors="replace"))
                sess_cwd = str(raw.get("cwd", ""))
                if project_filter and not (
                    sess_cwd == project_filter
                    or sess_cwd.startswith(project_filter + os.sep)
                    or sess_cwd.startswith(project_filter + "/")
                ):
                    continue
                for path_key in (raw.get("files") or {}):
                    freq[path_key] = freq.get(path_key, 0) + 1
                for path_key in (raw.get("edited_files") or {}):
                    edit_freq[path_key] = edit_freq.get(path_key, 0) + 1

    all_files = sorted(dict.fromkeys(list(freq.keys()) + list(edit_freq.keys())))
    if not all_files:
        if json_output:
            typer.echo("[]")
        else:
            typer.echo("No session data found for this project.")
        return

    rows = sorted(
        [
            {
                "file": fp,
                "reads": freq.get(fp, 0),
                "edits": edit_freq.get(fp, 0),
                "total": freq.get(fp, 0) + edit_freq.get(fp, 0),
            }
            for fp in all_files
        ],
        key=lambda r: (-cast("int", r["total"]), str(r["file"])),
    )[:limit]

    if json_output:
        import json as _json2

        typer.echo(_json2.dumps(rows, ensure_ascii=False, separators=(",", ":")))
        return

    header = f"{'FILE':<60}  {'READS':>5}  {'EDITS':>5}  {'TOTAL':>5}"
    typer.echo(header)
    typer.echo("-" * len(header))
    for r in rows:
        fp = str(r["file"])
        if len(fp) > 60:
            fp = "…" + fp[-59:]
        typer.echo(
            f"{fp:<60}  {cast('int', r['reads']):>5}  "
            f"{cast('int', r['edits']):>5}  {cast('int', r['total']):>5}"
        )


@app.command("context-for", rich_help_panel="Core")
def context_for(
    task: str = typer.Argument(..., help="Natural-language description of the task."),  # noqa: B008
    budget: int = typer.Option(20_000, "--budget", "-b", help="Approximate token budget."),
    top: int = typer.Option(8, "--top", "-t", help="Max files to include."),
    as_json: bool = _OPT_JSON,
) -> None:
    """Build a prioritized read list for a task description, within a token budget.

    Runs semantic search across the indexed codebase and emits a list of
    ``token-goat read`` commands trimmed to --budget tokens.  Use this at the
    start of a task to fetch only the relevant slices instead of reading
    entire files.

    Examples::

        token-goat context-for "add rate limiting to the API"
        token-goat context-for "fix session cache race" --budget 40000
        token-goat context-for "refactor hook dispatch" --json
    """
    from . import read_commands

    read_commands.context_for(task, budget=budget, top=top, json_output=as_json)


@app.command("ask", rich_help_panel="Core", hidden=True)
def cmd_ask(
    question: str = typer.Argument(..., help="Natural-language question about the codebase."),  # noqa: B008
    scope: str = typer.Option(None, "--scope", help="Glob/substring to restrict retrieval (e.g. 'src/**' or 'hooks')."),  # noqa: B008
    budget: int = typer.Option(6_000, "--budget", "-b", help="Approximate token budget for retrieved slices."),
    model: str = typer.Option(None, "--model", help="Backend model id (overrides TOKEN_GOAT_ASK_MODEL)."),  # noqa: B008
    as_json: bool = _OPT_JSON,
    no_cache: bool = typer.Option(False, "--no-cache", help="Bypass the cross-session answer cache."),
    show_sources: bool = typer.Option(False, "--show-sources", help="Also dump the exact slices used."),
) -> None:
    """[experimental] Answer a question about the codebase out-of-band, returning a cited answer.

    Retrieves the relevant slices, synthesizes a short answer in token-goat's own process
    (via an opt-in backend), and returns only the answer plus pointer-citations — so the
    primary model never pays for the slice bodies.

    Synthesis is strictly opt-in: with no backend configured it makes no network call and
    degrades to context-for-style read pointers.  Enable it by setting a backend:

        TOKEN_GOAT_ASK_MODEL=claude-haiku-4-5  (auto-detects the claude/codex CLI)
        TOKEN_GOAT_ASK_CMD="claude --print"    (explicit command; prompt piped via stdin)

    Examples::

        token-goat ask "how does the worker drain the dirty queue?"
        token-goat ask "where is image shrinking gated?" --scope "src/**" --json
    """
    from . import ask as _ask

    _ask.run_ask(
        question,
        scope=scope,
        budget=budget,
        model=model,
        json_output=as_json,
        no_cache=no_cache,
        show_sources=show_sources,
    )


@app.command("sessions-show", rich_help_panel="Core")
def cmd_sessions_show(
    session_id: str = typer.Argument(..., help="Session ID to inspect (prefix match accepted)."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show full details for one session: edited files, bash history, and web history.

    Accepts a full session ID or a unique prefix.  Use ``token-goat sessions``
    to list IDs.
    """
    import contextlib

    from . import paths as _paths

    sessions_dir = _paths.sessions_dir()
    if not sessions_dir.exists():
        _error("no sessions directory found")
        raise typer.Exit(1)

    matches: list[Path] = []
    for f in sessions_dir.iterdir():
        if f.is_file() and f.suffix == ".json":
            stem = f.stem
            if stem == session_id or stem.startswith(session_id):
                matches.append(f)

    if not matches:
        _error(f"no session found matching {session_id!r}")
        raise typer.Exit(1)
    if len(matches) > 1:
        _error(f"ambiguous prefix {session_id!r} matches {len(matches)} sessions; be more specific")
        raise typer.Exit(1)

    session_file = matches[0]
    raw: dict[str, object] = {}
    with contextlib.suppress(Exception):
        raw = json.loads(session_file.read_text(encoding="utf-8", errors="replace"))

    if not raw:
        _error(f"could not read session file: {session_file}")
        raise typer.Exit(1)

    if json_output:
        typer.echo(json_compact(raw))
        return

    now = time.time()
    sid = str(raw.get("session_id", session_file.stem))
    cwd = str(raw.get("cwd") or "(unknown)")
    _raw_last = raw.get("last_activity_ts")
    last_ts = float(_raw_last) if _raw_last is not None else session_file.stat().st_mtime  # type: ignore[arg-type]  # raw is dict[str, Any]; Any not accepted by float() without suppression
    _raw_started = raw.get("started_ts")
    started_ts = float(_raw_started) if _raw_started is not None else last_ts  # type: ignore[arg-type]  # same
    age = _format_relative_time(now - last_ts)
    duration_secs = last_ts - started_ts
    duration = _format_relative_time(duration_secs) if duration_secs > 0 else "0s"

    typer.echo(f"session:     {sid}")
    typer.echo(f"project:     {cwd}")
    typer.echo(f"last active: {age} ago")
    typer.echo(f"duration:    {duration}")
    _hints_e = int(raw.get("hints_emitted") or 0)  # type: ignore[call-overload]  # raw is dict[str, Any]; int(Any | int) hits a mypy overload mismatch
    _hints_i = int(raw.get("hints_ignored") or 0)  # type: ignore[call-overload]  # same
    typer.echo(f"hints:       {_hints_e} emitted, {_hints_i} ignored")

    edited: dict[str, int] = {}
    raw_edited = raw.get("edited_files")
    if isinstance(raw_edited, dict):
        edited = {k: int(v or 0) for k, v in raw_edited.items()}
    if edited:
        typer.echo(f"\nEdited files ({len(edited)}):")
        for path, count in sorted(edited.items(), key=lambda x: x[1], reverse=True):
            typer.echo(f"  {count:>3}x  {path}")
    else:
        typer.echo("\nEdited files: (none)")

    files: dict[str, object] = {}
    raw_files = raw.get("files")
    if isinstance(raw_files, dict):
        files = raw_files
    if files:
        typer.echo(f"\nRead files ({len(files)}):")
        file_list = sorted(
            ((k, v) for k, v in files.items() if isinstance(v, dict)),
            key=lambda x: float(x[1].get("last_read_ts") or 0),  # type: ignore[union-attr]  # x[1] is object (dict[str,object] value); isinstance(v, dict) filter above guarantees .get() exists
            reverse=True,
        )
        for path, entry in file_list[:20]:
            rc = int(entry.get("read_count") or 0)  # type: ignore[union-attr]  # entry is object; isinstance(v, dict) filter above guarantees .get() exists
            typer.echo(f"  {rc:>3}x  {path}")
        if len(files) > 20:
            typer.echo(f"  ... and {len(files) - 20} more")

    bash_hist: dict[str, object] = {}
    raw_bash = raw.get("bash_history")
    if isinstance(raw_bash, dict):
        bash_hist = raw_bash
    if bash_hist:
        typer.echo(f"\nBash history ({len(bash_hist)}):")
        bash_entries = sorted(
            ((k, v) for k, v in bash_hist.items() if isinstance(v, dict)),
            key=lambda x: float(x[1].get("ts") or 0),  # type: ignore[union-attr]  # x[1] is object; isinstance(v, dict) filter guarantees .get() exists
            reverse=True,
        )
        for _key, entry in bash_entries[:15]:
            preview = str(entry.get("cmd_preview") or "(no preview)")[:80]  # type: ignore[union-attr]  # entry is object; isinstance(v, dict) filter guarantees .get() exists
            rc = int(entry.get("run_count") or 1)  # type: ignore[union-attr]  # same
            typer.echo(f"  {'x'+str(rc):>4}  {preview}")
        if len(bash_hist) > 15:
            typer.echo(f"  ... and {len(bash_hist) - 15} more")

    web_hist: dict[str, object] = {}
    raw_web = raw.get("web_history")
    if isinstance(raw_web, dict):
        web_hist = raw_web
    if web_hist:
        typer.echo(f"\nWeb history ({len(web_hist)}):")
        web_entries = sorted(
            ((k, v) for k, v in web_hist.items() if isinstance(v, dict)),
            key=lambda x: float(x[1].get("ts") or 0),  # type: ignore[union-attr]  # x[1] is object; isinstance(v, dict) filter guarantees .get() exists
            reverse=True,
        )
        for _key, entry in web_entries[:15]:
            preview = str(entry.get("url_preview") or "(no preview)")[:80]  # type: ignore[union-attr]  # entry is object; isinstance(v, dict) filter guarantees .get() exists
            typer.echo(f"  {preview}")
        if len(web_hist) > 15:
            typer.echo(f"  ... and {len(web_hist) - 15} more")


@app.command("export", rich_help_panel="Core")
def cmd_export(
    fmt: str = typer.Option("json", "--format", "-f", help="Output format: json, csv, or ctags."),
    output: str | None = typer.Option(None, "--output", "-o", help="Write output to FILE instead of stdout."),
    project: str | None = typer.Option(None, "--project", "-p", help="Project root (default: current directory)."),
) -> None:
    """Export the indexed symbol database for a project.

    Dumps all symbols from the project's index in the requested format so they
    can be consumed by editors, scripts, or other LLM workflows without going
    through SQLite directly.

    Supported formats::

        json  — JSON array of objects: name, kind, file, start_line, end_line, parent_name
        csv   — CSV with the same columns (header row included)
        ctags — ctags-compatible output for Vim, Emacs, VS Code

    Examples::

        token-goat export
        token-goat export --format csv --output symbols.csv
        token-goat export --format ctags --output tags
        token-goat export --format json --project /path/to/project
    """
    import csv as _csv
    import io
    from pathlib import Path as _Path

    _db = _lazy_import("db")

    from .project import find_project

    root = _Path(project) if project else _Path(os.getcwd())
    proj = find_project(root)
    if proj is None:
        _error("no project detected — run from a project directory or pass --project")
        raise typer.Exit(1)

    fmt_lower = fmt.lower()
    if fmt_lower not in {"json", "csv", "ctags"}:
        _error(f"unknown format {fmt!r} — choose json, csv, or ctags")
        raise typer.Exit(1)

    try:
        with _db.open_project_readonly(proj.hash) as conn:
            rows = conn.execute(
                """
                SELECT s.name, s.kind, s.file_rel, s.line, s.end_line,
                       p.name AS parent_name
                FROM   symbols s
                LEFT JOIN symbols p ON p.id = s.parent_id
                ORDER BY s.file_rel, s.line
                """
            ).fetchall()
    except FileNotFoundError:
        rows = []
    except Exception as exc:
        _error(f"could not read project index: {exc}")
        raise typer.Exit(1) from exc

    def _to_dicts() -> list[dict[str, object]]:
        return [
            {
                "name": row["name"],
                "kind": row["kind"],
                "file": row["file_rel"],
                "start_line": row["line"],
                "end_line": row["end_line"],
                "parent_name": row["parent_name"],
            }
            for row in rows
        ]

    if fmt_lower == "json":
        text = json.dumps(_to_dicts(), ensure_ascii=False, indent=2)

    elif fmt_lower == "csv":
        buf = io.StringIO()
        writer = _csv.DictWriter(
            buf,
            fieldnames=["name", "kind", "file", "start_line", "end_line", "parent_name"],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(_to_dicts())
        text = buf.getvalue()

    else:  # ctags
        lines: list[str] = [
            "!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/",
            "!_TAG_FILE_FORMAT\t2\t/extended format/",
        ]
        for row in rows:
            name = row["name"]
            file_rel = row["file_rel"].replace("\\", "/")
            line_num = row["line"]
            kind = str(row["kind"])
            kind_char = kind[0] if kind else "?"
            parent_name = row["parent_name"]
            tag = f"{name}\t{file_rel}\t{line_num};\"\t{kind_char}"
            if parent_name:
                tag += f"\tclass:{parent_name}"
            lines.append(tag)
        text = "\n".join(lines) + ("\n" if lines else "")

    if output:
        out_path = _Path(output)
        out_path.write_text(text, encoding="utf-8")
        typer.echo(f"exported {len(rows)} symbol(s) to {out_path}", err=True)
    else:
        typer.echo(text, nl=False)


@app.command("clean", rich_help_panel="Advanced")
def cmd_clean(
    images: bool = typer.Option(False, "--images", help="Clear the image shrink cache."),
    bash: bool = typer.Option(False, "--bash", help="Clear the bash output cache."),
    web: bool = typer.Option(False, "--web", help="Clear the web output cache."),
    sessions: bool = typer.Option(False, "--sessions", help="Remove session files older than --older-than days."),
    all_caches: bool = typer.Option(False, "--all", help="Clear all caches (equivalent to --images --bash --web --sessions)."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would be deleted without deleting."),
    older_than: int = typer.Option(7, "--older-than", help="Only delete files older than N days (applies to all categories)."),
) -> None:
    """Clear caches to free disk space.

    Specify one or more target flags, or use ``--all`` to clear everything.
    Use ``--dry-run`` to preview what would be removed without making changes.
    The ``--older-than DAYS`` filter applies to all categories (default: 7 days).

    Examples::

        token-goat clean --all
        token-goat clean --bash --web --dry-run
        token-goat clean --sessions --older-than 30
    """
    import contextlib
    import time as _time

    from . import paths as _paths

    if all_caches:
        images = bash = web = sessions = True

    if not any([images, bash, web, sessions]):
        _error("specify at least one target: --images, --bash, --web, --sessions, or --all")
        raise typer.Exit(2)

    prefix = "[dry run] " if dry_run else ""
    cutoff = _time.time() - older_than * 86400

    def _clear_dir(cache_dir: Path, label: str) -> None:
        if not cache_dir.exists():
            typer.echo(f"{prefix}skipped — {label} cache dir does not exist")
            return
        files = [f for f in cache_dir.iterdir() if f.is_file() and not f.is_symlink()]
        eligible = [f for f in files if f.stat().st_mtime < cutoff]
        total_bytes = sum(f.stat().st_size for f in eligible)
        mb = total_bytes / (1024 * 1024)
        if not eligible:
            typer.echo(f"{prefix}nothing to remove — {label} (0 files older than {older_than}d)")
            return
        if not dry_run:
            for f in eligible:
                with contextlib.suppress(OSError):
                    f.unlink(missing_ok=True)
        typer.echo(f"{prefix}cleared {len(eligible)} file(s) ({mb:.1f} MB) — {label}")

    if images:
        _clear_dir(_paths.image_cache_dir(), "images")

    if bash:
        _clear_dir(_paths.data_dir() / "bash_outputs", "bash")

    if web:
        _clear_dir(_paths.data_dir() / "web_outputs", "web")

    if sessions:
        sess_dir = _paths.sessions_dir()
        if not sess_dir.exists():
            typer.echo(f"{prefix}skipped — sessions dir does not exist")
        else:
            files = [
                f for f in sess_dir.iterdir()
                if f.is_file() and f.suffix == ".json" and f.stat().st_mtime < cutoff
            ]
            total_bytes = sum(f.stat().st_size for f in files)
            mb = total_bytes / (1024 * 1024)
            if not files:
                typer.echo(f"{prefix}nothing to remove — sessions (0 files older than {older_than}d)")
            else:
                if not dry_run:
                    for f in files:
                        with contextlib.suppress(OSError):
                            f.unlink(missing_ok=True)
                typer.echo(f"{prefix}cleared {len(files)} file(s) ({mb:.1f} MB) — sessions")


@app.command("config-get", rich_help_panel="Core")
def cmd_config_get(
    file: str = typer.Argument(..., help="Path to a TOML, YAML, JSON, or INI file (e.g. pyproject.toml)."),
    key: str = typer.Argument(..., help="Dot-notation key to extract (e.g. project.version, tool.ruff.line-length)."),
    json_output: bool = _OPT_JSON,
) -> None:
    """Extract a single value from a TOML, YAML, JSON, or INI config file.

    Reads the file, resolves *key* using dot-notation, and prints just that
    value — not the surrounding context.  Returns exit code 2 on a missing
    key or unsupported file format.

    Examples::

        token-goat config-get pyproject.toml project.version
        token-goat config-get pyproject.toml tool.ruff.line-length
        token-goat config-get package.json devDependencies.typescript
        token-goat config-get .env.yaml database.host
        token-goat config-get setup.cfg metadata.name

    For arrays the value is emitted as a JSON array.  For objects it is a
    JSON object.  Scalars are printed bare (no surrounding quotes) unless
    *--json* is passed, in which case scalars are also JSON-encoded.
    """
    import configparser
    import tomllib

    path = Path(file)
    if not path.exists():
        _error(f"file not found: {file}")
        raise typer.Exit(2)

    suffix = path.suffix.lower()

    # ------------------------------------------------------------------
    # Parse the file into a plain nested dict
    # ------------------------------------------------------------------
    data: object
    try:
        if suffix == ".toml":
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        elif suffix in {".yaml", ".yml"}:
            try:
                import yaml  # type: ignore[import-untyped]
            except ImportError:
                _error("PyYAML is not installed; install it with: pip install pyyaml")
                raise typer.Exit(2) from None
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        elif suffix == ".json":
            data = json.loads(path.read_text(encoding="utf-8"))
        elif suffix in {".ini", ".cfg"}:
            parser = configparser.ConfigParser()
            parser.read(str(path), encoding="utf-8")
            # Convert ConfigParser to a nested dict; DEFAULT section excluded.
            data = {s: dict(parser.items(s)) for s in parser.sections()}
        else:
            _error(
                f"unsupported file format: {suffix!r}; "
                "supported: .toml, .yaml/.yml, .json, .ini/.cfg"
            )
            raise typer.Exit(2)
    except (OSError, UnicodeDecodeError) as exc:
        _error(f"could not read {file}: {exc}")
        raise typer.Exit(2) from None
    except Exception as exc:
        _error(f"parse error in {file}: {exc}")
        raise typer.Exit(2) from None

    # ------------------------------------------------------------------
    # Resolve dot-notation key
    # ------------------------------------------------------------------
    parts = [p for p in key.split(".") if p]
    if not parts:
        _error(f"empty key: {key!r}")
        raise typer.Exit(2)

    target: object = data
    for part in parts:
        if isinstance(target, dict):
            if part not in target:
                _error(f"key not found: {key!r} (missing segment: {part!r})")
                raise typer.Exit(2)
            target = target[part]
        elif isinstance(target, list):
            try:
                idx = int(part)
            except ValueError:
                _error(f"key not found: {key!r} (segment {part!r} is not an integer index into a list)")
                raise typer.Exit(2) from None
            try:
                target = target[idx]
            except IndexError:
                _error(f"key not found: {key!r} (index {idx} out of range)")
                raise typer.Exit(2) from None
        else:
            _error(f"key not found: {key!r} (cannot descend into {type(target).__name__} at segment {part!r})")
            raise typer.Exit(2)

    # ------------------------------------------------------------------
    # Emit
    # ------------------------------------------------------------------
    if json_output or isinstance(target, (dict, list)):
        typer.echo(json.dumps(target, ensure_ascii=False))
    else:
        # Scalars: print bare so scripts can consume without stripping quotes.
        typer.echo(str(target) if target is not None else "null")


@app.command("version", rich_help_panel="Core")
def cmd_version(
    json_output: bool = _OPT_JSON,
) -> None:
    """Print the installed token-goat version.

    Equivalent to ``token-goat --version`` but works as a subcommand so it
    can be composed in scripts::

        token-goat version
        token-goat version --json
    """
    from . import __version__

    if json_output:
        typer.echo(json.dumps({"version": __version__}, ensure_ascii=False))
    else:
        typer.echo(__version__)


# ---------------------------------------------------------------------------
# Hook-registry startup assertion
# ---------------------------------------------------------------------------
# Runs after every ``@hook_app.command`` decorator has registered its
# subcommand.  Raises ImportError if any event declared in
# :data:`token_goat.hook_registry.HOOK_EVENTS` lacks a matching typer
# subcommand — the package fails to import on drift, so a missing decorator
# can never reach production silently.  See the module docstring on
# :mod:`token_goat.hook_registry` for the bug class this prevents.
def _assert_hook_registry_aligned() -> None:
    """Verify every registry event has a matching ``@hook_app.command``.

    Uses ``builtins.set`` because the ``config`` subcommand at module scope
    shadows the built-in ``set`` name — without the explicit lookup this
    function would resolve ``set()`` to the typer command.
    """
    import builtins

    from . import hook_registry

    registered: builtins.set[str] = builtins.set()
    for info in hook_app.registered_commands:
        # Typer auto-derives subcommand names by replacing underscores with
        # hyphens in the callback's ``__name__`` unless the decorator passed
        # an explicit ``name``; mirror that resolution here.
        explicit_name = info.name
        if explicit_name:
            registered.add(explicit_name)
        elif info.callback is not None:
            registered.add(info.callback.__name__.replace("_", "-"))
    hook_registry.assert_typer_subcommands_aligned(registered)


# Runs once per process at module import; cache is automatic via sys.modules.
# Do not call from request paths or command bodies.
_assert_hook_registry_aligned()


if __name__ == "__main__":
    app()
