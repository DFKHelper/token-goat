"""Typer CLI with stub subcommands."""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast, get_args

if TYPE_CHECKING:
    from .project import Project

# Force UTF-8 on stdout/stderr (Windows defaults to cp1252 which can't encode
# the punctuation we use in maps, hints, and stats: → ›  etc.).
# `.reconfigure` exists on TextIOWrapper but not on the generic TextIO base.
# contextlib.suppress(AttributeError) handles environments where it isn't there.
with contextlib.suppress(AttributeError, OSError):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
with contextlib.suppress(AttributeError, OSError):
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

import typer

from . import config as config_mod
from . import hooks_cli
from .hooks_common import is_real_int
from .render.ansi import color_stderr
from .util import get_logger

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
    from .project import find_project  # noqa: PLC0415

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
    """
    typer.echo(json.dumps(data, indent=indent))
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
    from importlib import import_module  # noqa: PLC0415
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
_OPT_JSON: bool = typer.Option(False, "--json", help="Output structured JSON instead of human-readable text.")  # noqa: B008

#: ``--context`` / ``-c`` lines option shared by bash-output and web-output commands.
_OPT_CONTEXT_LINES: int = typer.Option(0, "--context", "-c", help="Extra lines before/after")  # noqa: B008

#: Optional ``--session-id`` / ``-s`` flag.  When omitted the command uses the
#: current or most-recent session automatically.
_OPT_SESSION_ID: str | None = typer.Option(None, "--session-id", "-s")  # noqa: B008


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
    if json_output:
        typer.echo(json.dumps({"path": str(path), "size": path.stat().st_size}))
    else:
        typer.echo(str(path))


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
    from difflib import get_close_matches  # noqa: PLC0415

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
    from difflib import get_close_matches  # noqa: PLC0415

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
    from difflib import get_close_matches  # noqa: PLC0415

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


def _record_lookup_stat(
    kind: str,
    query_text: str,
    result_count: int,
    *,
    scope: str,
    project_hash: str | None = None,
) -> None:
    """Record an adoption-tracking stat for a CLI lookup command.

    Lookup commands (``token-goat symbol`` / ``token-goat semantic``) are not
    content fetches — their job is to steer the agent toward a narrow surgical
    read instead of a full-file Read or shotgun Grep.  ``bytes_saved`` /
    ``tokens_saved`` are always 0; the row only shows up in ``token-goat
    stats`` when ``[stats] record_zero_savings = true`` (same opt-in policy as
    ``image_shrink_skipped`` and ``predictive_prefetch_hit``).

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
        _db.record_stat(
            project_hash,
            kind,
            bytes_saved=0,
            tokens_saved=0,
            detail=detail,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("record lookup stat failed kind=%s: %s", kind, exc)


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
        from . import __version__  # noqa: PLC0415

        typer.echo(f"token-goat {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(  # noqa: B008
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
        except Exception as e:  # noqa: BLE001
            _LOG.exception("failed to emit hook response: %s", e)
        raise SystemExit(0) from None


# ---------------------------------------------------------------------------
# Symbol command helpers
# ---------------------------------------------------------------------------

# How recently a file must have been modified to qualify for an on-the-fly
# parse when it is not yet in the index.  60 s covers the "just saved a new
# file and immediately ran symbol" case without scanning every file on disk.
_INLINE_INDEX_RECENCY_SECS = 60


def _inline_symbol_search(name: str, proj: Project) -> list[dict]:
    """Parse recently-modified unindexed files and search for *name*.

    Called when the DB returns 0 results for a project that is otherwise
    indexed.  Walks files under the project root whose mtime is within
    :data:`_INLINE_INDEX_RECENCY_SECS`, runs them through
    :func:`~token_goat.parser.index_file`, and returns any symbol whose name
    matches (exact, case-sensitive).  Results are annotated with the
    ``not_indexed`` flag so callers can surface the ``(not yet indexed)``
    marker to the user.

    Returns an empty list on any error so the caller falls through normally.
    """
    try:
        from . import parser as parser_mod  # noqa: PLC0415

        cutoff = time.time() - _INLINE_INDEX_RECENCY_SECS
        results: list[dict] = []
        root = proj.root
        for candidate in root.rglob("*"):
            if not candidate.is_file():
                continue
            # Skip directories we never index.
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
                if sym.name == name:
                    results.append({
                        "file": fi.rel_path,
                        "line": sym.line,
                        "kind": sym.kind,
                        "name": sym.name,
                        "signature": sym.signature,
                        "not_indexed": True,
                    })
        return results
    except Exception:  # noqa: BLE001
        _LOG.debug("_inline_symbol_search failed for %r", name, exc_info=True)
        return []


@app.command(rich_help_panel="Core")
def symbol(
    name: str,
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
) -> None:
    """Find a symbol definition by name (function, class, method, type, constant, etc.).

    Searches the indexed project for functions, classes, methods, variables, types, and
    other named definitions matching the given name. Use ``--all-projects`` to search
    across all indexed projects (useful for skills and plugins). Use ``--limit`` to
    control max results (default 50).

    Close-match auto-redirect: when the requested name returns zero results
    *and* the project has exactly one close-match candidate at high
    confidence (difflib ratio >= 0.85), the lookup is automatically re-run
    against that candidate.  The redirected response carries a
    ``redirected_from`` field in JSON output and a ``(redirected from: ...)``
    marker in plain-text output so the substitution is auditable.  Use
    ``--strict`` to opt out and get the previous behaviour."""
    _db = _lazy_import("db")

    use_tty_color = sys.stdout.isatty() and not as_json

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

    def _emit_results(
        results: list[dict],
        not_found_extra: str | None = None,
        close_matches: list[str] | None = None,
        redirected_from: str | None = None,
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
            if redirected_from is not None:
                # Wrap the result list with an envelope when a redirect was
                # applied so structured callers can detect and (optionally)
                # surface the substitution.  Non-redirect callers stay on the
                # pre-existing bare-list shape — adding the envelope
                # unconditionally would be a breaking change for anyone who
                # parses the JSON output today.
                envelope = {"redirected_from": redirected_from, "results": results}
                typer.echo(json.dumps(envelope))
            else:
                typer.echo(json.dumps(results))
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
            typer.echo(not_found_extra if not_found_extra else f"No matches for {name!r}")
            if close_matches and not not_found_extra:
                typer.echo("Did you mean:")
                for candidate in close_matches:
                    typer.echo(f"  - {candidate}")

    def _global_query(target: str) -> list[dict]:
        """Run the symbols_global query for *target* and shape the rows.

        Pulled out so the auto-redirect path can re-run the same query with
        a different name without duplicating the SELECT or the row-shaping.
        """
        with _db.open_global() as gconn:
            rows_raw_inner = gconn.execute(
                "SELECT sg.project_hash, p.root, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature "
                "FROM symbols_global sg "
                "JOIN projects p ON p.hash = sg.project_hash "
                "WHERE sg.name = ? LIMIT ?",
                (target, limit),
            ).fetchall()
        return [
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
        if not results:
            from difflib import get_close_matches  # noqa: PLC0415

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
        _record_lookup_stat("symbol_lookup", name, len(results), scope="all_projects")
        _emit_results(results, close_matches=close, redirected_from=redirected)
        return

    proj = _require_project()

    def _project_query(target: str) -> list[dict]:
        """Run the per-project symbols query for *target*.

        Same role as :func:`_global_query` for the single-project branch.
        """
        rows_raw_inner = _query_project(
            proj.hash,
            "SELECT name, kind, file_rel, line, signature FROM symbols WHERE name = ? LIMIT ?",
            (target, limit),
        )
        return [
            {
                "file": r["file_rel"],
                "line": r["line"],
                "kind": r["kind"],
                "name": r["name"],
                "signature": r["signature"],
            }
            for r in rows_raw_inner
        ]

    results = _project_query(name)

    from . import read_commands  # noqa: PLC0415

    if show_refs and results:
        try:
            _db2 = _lazy_import("db")
            with _db2.open_project_readonly(proj.hash) as _rconn:
                count_row = _rconn.execute(
                    "SELECT COUNT(*) AS cnt FROM refs WHERE symbol_name = ?",
                    (name,),
                ).fetchone()
            ref_count_val: int | None = int(count_row["cnt"]) if count_row else None
        except Exception:  # noqa: BLE001
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
        inline = _inline_symbol_search(name, proj)
        if inline:
            results = inline
            inline_hit = True
            _LOG.info(
                "symbol: inline fallback found %d match(es) for %r in recently-modified files",
                len(inline), name,
            )

    if not results and not hint and not inline_hit:
        from difflib import get_close_matches  # noqa: PLC0415

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
    _record_lookup_stat(
        "symbol_lookup", name, len(results), scope="project",
        project_hash=proj.hash,
    )
    not_found_extra = hint
    if inline_hit and not not_found_extra:
        not_found_extra = None
    _emit_results(
        results,
        not_found_extra=not_found_extra,
        close_matches=close,
        redirected_from=redirected,
    )


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
        typer.echo(json.dumps(results))
    elif results:
        use_tty_color = sys.stdout.isatty()
        for row in results:
            ctx = f"  {row['context']}" if row.get("context") else ""
            if use_tty_color:
                ctx = f"\033[2m{ctx}\033[0m"
            typer.echo(f"{row['file']}:{row['line']}: ref {name!r}{ctx}")
    else:
        from . import read_commands  # noqa: PLC0415

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
) -> None:
    """Show all files and line numbers where SYMBOL is referenced.

    Each result shows the file path, line number, and the surrounding line of
    source code.  Use ``--file`` to restrict output to a single file.  Use
    ``--limit`` to cap results (default 50).

    Example usage::

        token-goat refs login
        token-goat refs login --file src/auth.py
        token-goat refs login --json
    """
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
        typer.echo(json.dumps(results))
        return

    if not results:
        from . import read_commands  # noqa: PLC0415

        hint = read_commands._not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        elif file is not None:
            typer.echo(f"No references to {symbol!r} found in files matching {file!r}")
        else:
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
    import re as _re  # noqa: PLC0415

    from . import db as _db  # noqa: PLC0415

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
    except Exception:  # noqa: BLE001
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
    k: int = typer.Option(5, "-k", help="Top-k results"),
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
) -> None:
    """Semantic search using local embeddings (fastembed + sqlite-vec)."""
    from . import embeddings  # noqa: PLC0415

    proj = _require_project()

    # Negative sentinel means "use library default".  Anything >= 0 is treated
    # as an explicit threshold; pass a large value to effectively disable.
    threshold: float | None = (
        embeddings.DEFAULT_DISTANCE_THRESHOLD if max_distance < 0 else max_distance
    )

    try:
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
            typer.echo(json.dumps({"fallback": note, "results": fallback}, separators=(",", ":")))
            return
        if not fallback:
            typer.echo("(no results)")
            return
        typer.echo("(keyword fallback — embeddings not ready)")
        for r in fallback:
            snippet = str(r.get("preview", ""))[:100]
            typer.echo(f"{r['file']}:{r['start']}  {snippet}")
        return

    _record_lookup_stat(
        "semantic_search", query, len(hits), scope="project",
        project_hash=proj.hash,
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
        typer.echo(json.dumps(out, separators=(",", ":")))
        return

    if not hits:
        typer.echo("(no results)")
        return

    if compact:
        for h in hits:
            snippet = h.text.replace("\n", " ")[:100]
            typer.echo(f"{h.file_rel}:{h.start_line}  {snippet}")
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
    fmt: str = typer.Option(  # noqa: B008
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
    top_n: int = typer.Option(  # noqa: B008
        20,
        "--top-n",
        help="Number of top files to include in the mermaid diagram.",
    ),
) -> None:
    """Generate a PageRank-ranked, token-budgeted overview of the current project.

    Formats: text (default), json, mermaid.  Use --format mermaid to emit a
    Mermaid graph TD diagram suitable for GitHub READMEs.
    """
    from . import repomap  # noqa: PLC0415

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
        "map start: project=%s budget=%d format=%s compact=%s full=%s",
        proj.root.name, budget, fmt, compact, full,
    )
    t0 = time.monotonic()
    try:
        if fmt == "json":
            data = repomap.build_map_json(proj)
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s files=%d dur=%.3fs", proj.root.name, len(data), elapsed)
            _record_lookup_stat(
                "map_lookup",
                f"budget={budget},mode=json,compact={compact},full={full}",
                len(data),
                scope="project",
                project_hash=proj.hash,
            )
            typer.echo(json.dumps(data, separators=(",", ":")))
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
        elapsed = time.monotonic() - t0
        _LOG.info("map complete: project=%s dur=%.3fs", proj.root.name, elapsed)
        # Adoption telemetry: count map calls so token-goat stats can show
        # how often agents reach for the ranked overview instead of recursive
        # ls + multiple Reads.  result_count = number of file-entry lines
        # actually emitted (approximate, but stable across compact / full).
        file_lines = sum(1 for line in text.splitlines() if "[" in line)
        _record_lookup_stat(
            "map_lookup",
            f"budget={budget},mode=text,compact={compact},full={full}",
            file_lines,
            scope="project",
            project_hash=proj.hash,
        )
        typer.echo(text)
    except Exception as exc:  # noqa: BLE001
        _error(f"failed to build repo map: {exc}. Try `token-goat index --full` to rebuild the index.")
        raise typer.Exit(1) from None


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
    from . import read_commands  # noqa: PLC0415

    read_commands.deps(file, json_output=json_output, depth=depth)


@app.command(rich_help_panel="Core")
def read(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'parser.py::index_project' or 'auth.py::Session.refresh' for a qualified method."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    context_lines: int = _OPT_CONTEXT_LINES,
) -> None:
    """Read just <symbol> from <file>, not the whole file."""
    from . import read_commands  # noqa: PLC0415

    if session_id:
        _validate_session_id(session_id)

    read_commands.read(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
    )


@app.command(rich_help_panel="Core")
def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'. Append #N to disambiguate duplicate headings, e.g. 'doc.md::Setup#2'."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = _OPT_JSON,
    context_lines: int = _OPT_CONTEXT_LINES,
) -> None:
    """Extract just <heading> section from <file>, not the whole file."""
    from . import read_commands  # noqa: PLC0415

    if session_id:
        _validate_session_id(session_id)

    read_commands.section(
        target=target,
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
    from . import read_commands  # noqa: PLC0415

    read_commands.stub_view(file, json_output=json_output, include_private=include_private)


@app.command("memory", rich_help_panel="Core")
def memory_cmd(
    action: str = typer.Argument(..., help="show | set | unset | clear"),
    key: str | None = typer.Argument(None, help="Memory key (required for set/unset)"),
    value: str | None = typer.Argument(None, help="Memory value (required for set)"),
    project_dir: str | None = typer.Option(None, "--project", "-p", help="Project root (default: cwd)"),
) -> None:
    """Manage persistent per-project memory facts injected at session start."""
    import os  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from . import project_memory  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

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
    import os  # noqa: PLC0415
    import time  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from . import git_history  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

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
    import json as _json  # noqa: PLC0415

    from . import install  # noqa: PLC0415

    issues: list[str] = []

    # Check settings.json for hook coverage (cache-busting if PreToolUse fires on every call).
    settings_path = install.claude_settings_path()
    if settings_path.exists():
        try:
            cfg = _json.loads(settings_path.read_text(encoding="utf-8"))
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
        except Exception:  # noqa: BLE001
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
        for pat in ("{{date}}", "{{time}}", "Date:", "Time:", "today is"):
            if pat.lower() in content.lower():
                issues.append(f"CLAUDE.md contains dynamic pattern {pat!r} — changes every session, busting cache")

    if issues:
        typer.echo("Cache-busting issues found:")
        for issue in issues:
            typer.echo(f"  - {issue}")
    else:
        typer.echo("No obvious cache-busting patterns detected.")


@app.command("session-touched", rich_help_panel="Advanced")
def session_touched(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = _OPT_JSON,
) -> None:
    """List files already read in the given Claude session."""
    from . import session as session_mod  # noqa: PLC0415

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
        typer.echo(json.dumps(out, separators=(",", ":")))
        return
    if not entries:
        typer.echo("(no files touched in this session)")
        return
    for e in entries:
        ranges = ", ".join(f"{s}-{en}" for s, en in e.line_ranges) or "(symbols only)"
        symbols = f" symbols={','.join(e.symbols_read)}" if e.symbols_read else ""
        typer.echo(f"{e.rel_or_abs}  reads={e.read_count}  lines={ranges}{symbols}")


@app.command("session-mark", rich_help_panel="Advanced", hidden=True)
def session_mark(
    file_path: str = typer.Argument(...),
    session_id: str = typer.Option(..., "--session-id", "-s"),
    offset: int = typer.Option(0, "--offset"),
    limit: int = typer.Option(0, "--limit", help="0 means unlimited"),
) -> None:
    """Manually mark a file/range as read for the given session. (Mostly used by hooks.)"""
    from . import session as session_mod  # noqa: PLC0415

    _validate_session_id(session_id)

    session_mod.mark_file_read(session_id, file_path, offset or None, limit or None)
    typer.echo("ok")


@app.command("gdrive-fetch", hidden=True)
def cmd_gdrive_fetch(
    file_id: str = typer.Argument(...),
    json_output: bool = _OPT_JSON,
) -> None:
    """Fetch a Google Drive file (image gets auto-shrunk). Returns the local path."""
    from . import gdrive  # noqa: PLC0415

    try:
        path = gdrive.fetch_file(file_id)
    except gdrive.GDriveCredsUnavailable as e:
        _warn(str(e))
        raise typer.Exit(0) from None  # fail-soft: don't break Claude's session
    except Exception as e:  # noqa: BLE001
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
    from . import gdrive  # noqa: PLC0415

    try:
        # Image-shrink is disabled because if the agent asked for sections, it
        # expects text content; we still pass through the cached binary path
        # untouched if the file happens to be non-text.
        local_path = gdrive.fetch_file(file_id, shrink_if_image=False)
    except gdrive.GDriveCredsUnavailable as e:
        _warn(str(e))
        raise typer.Exit(0) from None
    except Exception as e:  # noqa: BLE001
        _warn(f"Drive fetch failed: {e}")
        raise typer.Exit(0) from None

    index = gdrive.extract_section_index(local_path)

    # Cap the section list so an enormous doc (hundreds of headings) doesn't
    # itself become the token sink we are trying to avoid.
    sections = cast(list[dict[str, object]], index.get("sections", []))
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
    typer.echo(str(index.get("path", local_path)))
    size_bytes = cast(int, index.get("size_bytes", 0))
    line_count = cast(int, index.get("line_count", 0))
    typer.echo(f"size={size_bytes}B lines={line_count} sections={len(sections)}")
    if not index.get("extractor_available", False):
        typer.echo(
            "(no section index available — file is not a recognised markdown/text type "
            "or is too large to parse; use `token-goat gdrive-fetch` instead)"
        )
        return
    for sec in sections:
        prefix = "#" * cast(int, sec.get("level", 1))
        heading = cast(str, sec.get("heading", ""))
        line = cast(int, sec.get("line", 0))
        end_line = sec.get("end_line")
        approx = cast(int, sec.get("approx_bytes", 0))
        end_str = "" if end_line is None else f"-{end_line}"
        typer.echo(f"L{line}{end_str} ~{approx}B {prefix} {heading}")
    if truncated:
        typer.echo(f"(... truncated at {max_sections} sections)")


@app.command("gdrive-auth", hidden=True)
def cmd_gdrive_auth(
    client_secrets: Path | None = typer.Option(None, "--client-secrets", help="Path to OAuth client_secrets.json"),  # noqa: B008
) -> None:
    """One-time Google Drive auth setup. Tries ADC first, then OAuth flow."""
    from . import gdrive  # noqa: PLC0415

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
    except Exception as e:  # noqa: BLE001
        _error(f"OAuth flow failed: {e}")
        raise typer.Exit(1) from None


@app.command("fetch-image", hidden=True)
def cmd_fetch_image(
    url: str = typer.Argument(...),
    json_output: bool = _OPT_JSON,
) -> None:
    """Fetch an image URL (auto-shrunk). Returns the local cached path."""
    from . import webfetch  # noqa: PLC0415

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
    from . import db  # noqa: PLC0415
    from .parser import (  # noqa: PLC0415
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

            changed: list[str] = []
            for rel, mtime in new_mtimes.items():
                if mtimes.get(rel) != mtime:
                    changed.append(rel)
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
                except Exception as exc:  # noqa: BLE001
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
) -> None:
    """Rebuild project/global indices."""
    from . import paths as _paths  # noqa: PLC0415
    from .parser import index_project  # noqa: PLC0415
    from .project import find_project, make_project_at  # noqa: PLC0415

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

    import sys as _sys  # noqa: PLC0415

    _tty = _sys.stderr.isatty()

    def _progress(done: int, total: int) -> None:
        if _tty:
            _sys.stderr.write(f"\r  {done}/{total} files scanned...")
            _sys.stderr.flush()
        else:
            typer.echo(f"  {done}/{total} files scanned...", err=True)

    _LOG.info("index start: project=%s mode=%s", proj.root.name, "full" if full else "incremental")
    try:
        summary = index_project(proj, full=full, progress=_progress)
    except Exception as exc:  # noqa: BLE001
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

    if embeddings:
        from . import embeddings as emb  # noqa: PLC0415
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
def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = _OPT_JSON,
    by_project: bool = typer.Option(False, "--by-project", help="Show per-project breakdown table"),
    top: int = typer.Option(10, "--top", help="Number of projects to show with --by-project"),
) -> None:
    """Show cumulative token savings."""
    from . import cli_stats  # noqa: PLC0415

    cli_stats.stats(window=window, json_output=json_output, by_project=by_project, top=top)


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
_OPT_HEAD: int = typer.Option(0, "--head", help="Show first N lines (0 = no head limit)")  # noqa: B008
_OPT_TAIL: int = typer.Option(0, "--tail", help="Show last N lines (0 = no tail limit)")  # noqa: B008
_OPT_GREP: str | None = typer.Option(None, "--grep", "-g", help="Show only lines matching the substring (case-insensitive by default; see --case-sensitive)")  # noqa: B008
_OPT_GREP_MAX: int = typer.Option(_GREP_MAX_DEFAULT, "--grep-max", help="Max matching lines to show with --grep (0 = no cap)")  # noqa: B008
_OPT_CASE_SENSITIVE: bool = typer.Option(False, "--case-sensitive", help="Make --grep matching case-sensitive")  # noqa: B008
_OPT_FULL: bool = typer.Option(False, "--full", help="Return the entire cached output (disables smart-default head+tail)")  # noqa: B008
_OPT_HEAD_TAIL: bool = typer.Option(False, "--head-tail", help="Emit first+last 20 lines with an omission marker instead of full body")  # noqa: B008


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
        grep:  Substring filter; ``None`` or ``""`` = no filter.  Case-insensitive
               by default; pass ``case_sensitive=True`` for exact matching.
        full:  When True, skip the smart-default elision even if no explicit
               slice flags were passed.
        case_sensitive: When True, apply grep as an exact-case substring match.

    Returns:
        Filtered list of lines; caller joins with ``"\\n"`` for output.
    """
    slicing_requested = bool(grep) or head > 0 or tail > 0
    if grep:
        if case_sensitive:
            lines = [ln for ln in lines if grep in ln]
        else:
            _lc = grep.lower()
            lines = [ln for ln in lines if _lc in ln.lower()]
    if head > 0:
        lines = lines[:head]
    if tail > 0:
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
    """
    from . import db as _db  # noqa: PLC0415

    load_output = cache_module.load_output  # type: ignore[attr-defined]
    load_output_meta = cache_module.load_output_meta  # type: ignore[attr-defined]
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]

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
        import contextlib  # noqa: PLC0415
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

    # Resolve grep matching key once (case-folded or raw) so the check is
    # applied consistently across both the line filter and the JSON match count.
    _grep_key = grep if (grep and case_sensitive) else (grep.lower() if grep else None)

    def _grep_matches(line: str) -> bool:
        if _grep_key is None:
            return True
        return _grep_key in (line if case_sensitive else line.lower())

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
    if head > 0:
        lines = lines[:head]
    if tail > 0:
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
        tokens_saved=_saved_bytes // 4,
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
        if grep:
            payload["match_count"] = len([ln for ln in original_lines if _grep_matches(ln)])
        payload.update(meta)
        if sidecar is not None:
            payload.update(vars(sidecar))
        typer.echo(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
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

    typer.echo(sliced)


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
    json_output: bool = _OPT_JSON,
) -> None:
    """Retrieve a sliced view of a cached Bash output.

    The post-Bash hook stores each non-trivial command output to disk under
    ``data_dir() / "bash_outputs"``. Use this command to retrieve specific
    parts of that output without forcing the agent to re-run the command —
    typically much cheaper in tokens.

    By default (no flags), large outputs are trimmed to the first
    30 lines and last 80 lines with an elision marker.  Pass ``--full`` to
    get everything.  Combine ``--head``, ``--tail``, and ``--grep`` to
    narrow further; those flags suppress the smart default automatically.
    ``--grep`` is case-insensitive by default; add ``--case-sensitive`` for
    exact matching.  Use ``--head-tail`` to get just the first+last 20 lines
    (useful for large outputs where you only need the gist).  Use ``--grep-max N``
    to cap the number of matching lines returned (default 20; 0 = no cap).
    JSON mode includes the full path and stored byte size.
    """
    from . import bash_cache  # noqa: PLC0415

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
    )


@app.command("web-output", rich_help_panel="Core")
def cmd_web_output(
    output_id: str | None = typer.Argument(None, help="ID returned by the post-fetch hook or `web-history`. Omit when using --from-session."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
    case_sensitive: bool = _OPT_CASE_SENSITIVE,
    full: bool = _OPT_FULL,
    head_tail: bool = _OPT_HEAD_TAIL,
    json_output: bool = _OPT_JSON,
    from_session: str | None = typer.Option(  # noqa: B008
        None,
        "--from-session",
        help=(
            "List all web outputs cached during SESSION_ID instead of retrieving a specific entry. "
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
    get everything.  Combine ``--head``, ``--tail``, and ``--grep`` to
    narrow further; those flags suppress the smart default automatically.
    ``--grep`` is case-insensitive by default; add ``--case-sensitive`` for
    exact matching.  Use ``--head-tail`` to get just the first+last 20 lines
    (useful for large documentation pages where you only need the gist).
    Use ``--grep-max N`` to cap the number of matching lines returned
    (default 20; 0 = no cap).  JSON mode includes the full path, stored byte
    size, status code, and a 1-based ``numbered_lines`` list anchored to the
    original body.

    Use ``--from-session SESSION_ID`` to list all web outputs cached during a
    specific session without needing to know their IDs in advance.
    """
    from . import web_cache  # noqa: PLC0415
    from .cache_common import safe_session_fragment  # noqa: PLC0415

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
            typer.echo(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
            return
        now = time.time()
        for e in entries:
            oid = str(e["output_id"])
            size = int(e.get("size_bytes", 0))  # type: ignore[arg-type]
            age = int(now - float(e.get("mtime", now)))  # type: ignore[arg-type]
            sidecar = web_cache.read_sidecar(oid)
            url_str = sidecar.url_preview if sidecar is not None else "(no sidecar)"
            status_str = f" status={sidecar.status_code}" if sidecar is not None and sidecar.status_code is not None else ""
            typer.echo(f"{oid}  {size:>10,}B  {age:>6}s ago{status_str}  {url_str}")
        return

    if output_id is None:
        _error("output_id is required unless --from-session is specified")
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
    list_outputs = cache_module.list_outputs  # type: ignore[attr-defined]
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]

    entries = list_outputs()
    if since_secs is not None:
        cutoff = time.time() - since_secs
        entries = [e for e in entries if float(cast(float, e["mtime"])) >= cutoff]
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
        typer.echo(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
        return

    if not entries:
        typer.echo(empty_msg)
        return

    now = time.time()
    for e in entries:
        oid = str(e["output_id"])
        size = int(cast(int, e["size_bytes"]))
        age = int(now - float(cast(float, e["mtime"])))
        sidecar = read_sidecar(oid)
        typer.echo(format_entry(oid, size, age, sidecar))


@app.command("web-history", rich_help_panel="Core")
def cmd_web_history(
    json_output: bool = _OPT_JSON,
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum entries to show (newest first)"),
) -> None:
    """List cached WebFetch responses, newest first.

    Each row shows the cache ID, byte size, age, status code (when known),
    and a sanitised URL preview.  Use the ID with ``token-goat web-output
    <id>`` to retrieve the body.
    """
    from . import web_cache  # noqa: PLC0415

    def _json_fields(s: object) -> dict[str, object]:
        return {"url_preview": s.url_preview, "status_code": s.status_code, "truncated": s.truncated}  # type: ignore[attr-defined]

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        url_str = s.url_preview if s is not None else "(no sidecar)"  # type: ignore[attr-defined]
        status_str = f" status={s.status_code}" if s is not None and s.status_code is not None else ""  # type: ignore[attr-defined]
        return f"{oid}  {size:>10,}B  {age:>6}s ago{status_str}  {url_str}"

    _run_history_listing_command(
        web_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached WebFetch responses)",
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
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum entries to show (newest first)"),
    since: str | None = typer.Option(  # noqa: B008
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
    from . import bash_cache  # noqa: PLC0415

    since_secs: float | None = None
    if since is not None:
        since_secs = _parse_since_duration(since)
        if since_secs is None:
            _error(f"unrecognised --since value: {since!r}  (expected e.g. '30m', '2h', '1d')")
            raise typer.Exit(2)

    def _json_fields(s: object) -> dict[str, object]:
        return {"cmd_preview": s.cmd_preview, "exit_code": s.exit_code, "truncated": s.truncated}  # type: ignore[attr-defined]

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        cmd_str = s.cmd_preview if s is not None else "(no sidecar)"  # type: ignore[attr-defined]
        exit_str = f" exit={s.exit_code}" if s is not None and s.exit_code is not None else ""  # type: ignore[attr-defined]
        return f"{oid}  {size:>10,}B  {age:>6}s ago{exit_str}  {cmd_str}"

    _run_history_listing_command(
        bash_cache,
        json_output=json_output,
        limit=limit,
        empty_msg="(no cached Bash outputs)",
        json_sidecar_fields=_json_fields,
        format_entry=_fmt,
        since_secs=since_secs,
    )


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
    from . import db as _db  # noqa: PLC0415
    from . import hooks_skill, skill_cache  # noqa: PLC0415

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
                from pathlib import Path  # noqa: PLC0415

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
                from pathlib import Path  # noqa: PLC0415

                body = Path(resolved).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{resolved}"
            except OSError:
                body = None

    if body is None:
        _error(f"no cached body for skill: {name}")
        raise typer.Exit(1)

    # --section: extract a single named H2 section from the body.
    if section:
        section_text = skill_cache.extract_named_section(body, section)
        if section_text is None:
            headings = skill_cache.extract_h2_headings(body)
            if headings:
                _error(
                    f"section {section!r} not found in skill {name!r}. "
                    f"Available: {', '.join(headings)}"
                )
            else:
                _error(f"section {section!r} not found in skill {name!r} (no H2 sections detected)")
            raise typer.Exit(1)
        sliced = section_text
        # Record stat for the bytes saved vs. full body.
        body_bytes = len(body.encode())
        returned_bytes = len(sliced.encode())
        saved_bytes = max(0, body_bytes - returned_bytes)
        _db.record_stat(
            None,
            "skill_body_recall",
            bytes_saved=saved_bytes,
            tokens_saved=saved_bytes // 4,
            detail=f"{name[:48]}::{section[:16]}",
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
            typer.echo(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        else:
            typer.echo(sliced)
        return

    lines = _apply_recall_filters(body.splitlines(), head=head, tail=tail, grep=grep, full=full)
    sliced = "\n".join(lines)

    # Append a sections-available line when H2 headings exist and we're in text mode.
    if not json_output and not section:
        headings = skill_cache.extract_h2_headings(body)
        if headings:
            sliced = sliced + "\n\n**Sections available:** " + ", ".join(headings)

    # Record a recall stat so `token-goat stats` reflects the value of avoiding
    # a re-load (and the side effects + tool-result block that come with it).
    body_bytes = len(body.encode())
    returned_bytes = len(sliced.encode())
    saved_bytes = max(0, body_bytes - returned_bytes)
    _db.record_stat(
        None,
        "skill_body_recall",
        bytes_saved=saved_bytes,
        tokens_saved=saved_bytes // 4,
        detail=name[:64],
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
        typer.echo(json.dumps(payload2, ensure_ascii=False, separators=(",", ":")))
        return

    typer.echo(sliced)


@app.command("skill-history", rich_help_panel="Core")
def cmd_skill_history(
    json_output: bool = _OPT_JSON,
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum entries to show (newest first)"),
) -> None:
    """List cached Skill bodies, newest first.

    Each row shows the skill name, byte size, age, and (if a sidecar is
    present) the truncation flag and source path.  Use the name with
    ``token-goat skill-body <name>`` to retrieve the body.
    """
    from . import skill_cache  # noqa: PLC0415

    def _json_fields(s: object) -> dict[str, object]:
        return {"skill_name": s.skill_name, "body_bytes": s.body_bytes, "truncated": s.truncated, "source_path": s.source_path}  # type: ignore[attr-defined]

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        name_str = s.skill_name if s is not None else "(no sidecar)"  # type: ignore[attr-defined]
        trunc_str = " (truncated)" if s is not None and s.truncated else ""  # type: ignore[attr-defined]
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
    import difflib  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from . import skill_cache  # noqa: PLC0415

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
            if line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
                typer.echo(typer.style(line, bold=True))
            elif line.startswith("+"):
                typer.echo(typer.style(line, fg=typer.colors.GREEN))
            elif line.startswith("-"):
                typer.echo(typer.style(line, fg=typer.colors.RED))
            else:
                typer.echo(line)
        else:
            typer.echo(line)


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
    from . import db as _db  # noqa: PLC0415
    from . import paths as _paths  # noqa: PLC0415
    from . import session as session_mod  # noqa: PLC0415

    sessions_dir = _paths.data_dir() / "sessions"

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
    from . import db as _db  # noqa: PLC0415
    from . import resume as _resume  # noqa: PLC0415

    # Resolve partial (short) session IDs by scanning the sessions directory.
    resolved_id: str | None = None
    if len(session_id) >= 32:
        # Full ID — use directly.
        resolved_id = session_id
    else:
        # Short prefix — find the first session file matching it.
        try:
            from . import paths as _paths  # noqa: PLC0415

            sessions_dir = _paths.data_dir() / "sessions"
            for f in sessions_dir.glob(f"{session_id}*.json"):
                candidate = f.stem  # strip .json
                resolved_id = candidate
                break
        except Exception:  # noqa: BLE001
            pass
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
    pending: bool = typer.Option(  # noqa: B008
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
    from . import hooks_session as _hs  # noqa: PLC0415
    from . import paths as _paths  # noqa: PLC0415

    # Resolve short session IDs the same way `resume` does.
    resolved_id: str | None = None
    if len(session_id) >= 32:
        resolved_id = session_id
    else:
        try:
            sessions_dir = _paths.data_dir() / "sessions"
            for f in sessions_dir.glob(f"{session_id}*.json"):
                resolved_id = f.stem
                break
        except Exception:  # noqa: BLE001
            pass
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
def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
) -> None:
    """Diagnose the health of the token-goat installation and indices.

    Runs checks on Python version, dependencies, database integrity, hook registration,
    worker status, and project indices. Use ``--fix`` to clear stale ``.indexing``
    spawn markers (same reaping the background worker does on startup).
    """
    from . import cli_doctor  # noqa: PLC0415

    cli_doctor.doctor(fix=fix)


@app.command("install", rich_help_panel="Install")
def cmd_install(
    codex: bool = typer.Option(False, "--codex", help="Also install Codex CLI integration"),  # noqa: B008
    opencode: bool = typer.Option(False, "--opencode", help="Also install opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also install openclaw plugin bridge"),  # noqa: B008
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would change; make no changes"),  # noqa: B008
    verify: bool = typer.Option(False, "--verify", help="After install, run a structured self-check"),  # noqa: B008
) -> None:
    """One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog."""
    from . import install as inst  # noqa: PLC0415

    if dry_run:
        plan = inst.plan_install(
            install_codex=codex,
            install_opencode=opencode,
            install_openclaw=openclaw,
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

    result = inst.install_all(install_codex=codex, install_opencode=opencode, install_openclaw=openclaw)
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
    opencode: bool = typer.Option(False, "--opencode", help="Also remove opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also remove openclaw plugin bridge"),  # noqa: B008
) -> None:
    """Cleanly reverse install."""
    from . import install as inst  # noqa: PLC0415

    result = inst.uninstall_all(purge=purge, codex=codex, opencode=opencode, openclaw=openclaw)
    typer.echo("token-goat uninstall:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")


@app.command("image-shrink", hidden=True)
def cmd_image_shrink(
    src: Path = typer.Argument(...),  # noqa: B008
    json_output: bool = _OPT_JSON,
) -> None:
    """Manually shrink an image (also used by hooks)."""
    from . import image_shrink  # noqa: PLC0415

    if not src.exists():
        _error(f"file not found: {src}")
        raise typer.Exit(1)
    out = image_shrink.shrink(src)
    if out is None:
        typer.echo(f"Not shrunk (below threshold or not an image): {src}")
        raise typer.Exit(0)
    stats = image_shrink.stats_for(src, out)
    if json_output:
        import json as _json  # noqa: PLC0415

        typer.echo(
            _json.dumps({"shrunken_path": str(out), **stats})
        )
    else:
        typer.echo(
            f"{src} → {out} "
            f"({stats['src_bytes']:,} → {stats['out_bytes']:,} bytes, "
            f"saved {stats['bytes_saved']:,})"
        )


@app.command("worker", hidden=True)
def cmd_worker(
    daemon: bool = typer.Option(False, "--daemon", help="Run as background daemon (otherwise interactive)"),
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
    if os.environ.get("TOKEN_GOAT_NO_WORKER_SPAWN", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        return

    from . import worker_daemon  # noqa: PLC0415

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
    from . import bash_runner  # noqa: PLC0415

    if no_compress:
        # Stream straight through; useful for debugging.
        import subprocess as _sp  # noqa: PLC0415

        proc = _sp.run(cmd, shell=True, check=False)  # noqa: S602
        raise typer.Exit(proc.returncode)

    effective_timeout = timeout if timeout > 0 else bash_runner.DEFAULT_TIMEOUT_SECONDS
    exit_code = bash_runner.run(
        cmd,
        filter_name=filter_name,
        timeout=effective_timeout,
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
        return cast(hooks_cli.Harness, raw)
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


@hook_app.command("post-skill", context_settings=_HOOK_CTX)
def post_skill(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-skill event (caches loaded skill bodies for post-compact recall)."""
    hooks_cli.safe_run("post-skill", input_file, _parse_harness(harness))


@app.command("compact-hint", rich_help_panel="Advanced")
def compact_hint(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
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
) -> None:
    """Show the compaction manifest token-goat would inject for a session.

    Faithfully previews what the PreCompact hook will emit as ``systemMessage``
    before Claude Code compacts the conversation, applying the *same* gates the
    live hook applies:

    * ``[compact_assist] enabled`` config flag
    * Trigger membership in ``cfg.triggers`` (simulate via ``--trigger``)
    * Pressure-aware budget boost when ``trigger=auto`` (via ``auto_trigger_multiplier``)
    * Compact-skip sentinel fast-path (would the hook short-circuit silently?)
    * ``min_events`` event-count gate
    * Sidecar manifest cache hit (the 1-line "unchanged since" stub)

    The trailing token estimate uses the canonical ``compact.estimate_tokens``
    helper — the same function ``_render`` uses internally — so the preview
    matches the actual emitted size rather than under-counting.

    Use this to debug why a manifest is (or isn't) being emitted, what its
    final size will be, and which sections survive after the per-section
    budget split.
    """
    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415
    from . import hooks_cli as hooks_cli_mod  # noqa: PLC0415

    _validate_session_id(session_id)

    cfg = config_mod.load().compact_assist

    # --- Resolve the effective budget the live hook would use ----------------
    # `max_tokens=0` (the new default) means "use whatever the live hook
    # would use": cfg.max_manifest_tokens, scaled by auto_trigger_multiplier
    # when trigger == "auto".  This makes the preview faithful out of the box
    # without forcing the caller to look up the config value first.
    base_tokens = int(max_tokens) if max_tokens > 0 else int(cfg.max_manifest_tokens)
    raw_multiplier = getattr(cfg, "auto_trigger_multiplier", 1.0)
    multiplier = float(raw_multiplier) if isinstance(raw_multiplier, (int, float)) else 1.0
    if trigger == "auto" and multiplier > 1.0:
        effective_tokens = int(base_tokens * multiplier)
    else:
        effective_tokens = base_tokens

    # --- Apply hook-side gates so the preview matches reality ----------------
    trigger_allowed = bool(cfg.triggers) and trigger in cfg.triggers
    # Defensive: `_check_compact_skip_sentinel` is fail-soft in the hook path,
    # but if it ever raises (e.g. a future refactor introduces a non-OSError
    # branch), fall back to "no fast-path" so the preview still renders.
    try:
        sentinel_fast_path = hooks_cli_mod._check_compact_skip_sentinel(session_id)
    except Exception:  # noqa: BLE001
        sentinel_fast_path = False
    n_events = compact_mod.event_count(session_id)
    events_sufficient = n_events >= cfg.min_events

    # Render the manifest with the *effective* budget (matching the hook).
    # We still render even when gates fail so the user can see "what would
    # have been emitted if the gates passed" — but `would_emit` reflects the
    # full gate chain accurately.
    manifest = compact_mod.build_manifest(session_id, max_tokens=effective_tokens)
    is_cached_stub = manifest.startswith("## Token-Goat Manifest — unchanged since")
    would_emit = bool(
        cfg.enabled
        and trigger_allowed
        and not sentinel_fast_path
        and events_sufficient
        and manifest
    )

    if json_output:
        import json as _json  # noqa: PLC0415

        typer.echo(_json.dumps({
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
            "is_cached_stub": is_cached_stub,
            "token_estimate": compact_mod.estimate_tokens(manifest) if manifest else 0,
            "char_count": len(manifest),
            "would_emit": would_emit,
            "manifest": manifest,
        }, separators=(",", ":")))
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
        from dataclasses import fields as _fields  # noqa: PLC0415
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
        typer.echo(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
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
    import difflib  # noqa: PLC0415
    import tomllib  # noqa: PLC0415
    from dataclasses import fields as _dc_fields  # noqa: PLC0415

    from . import paths as _paths  # noqa: PLC0415

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
            typer.echo(json.dumps({"ok": False, "issues": [issue]}, separators=(",", ":")))
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

    ok = len(issues) == 0
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
    key: str | None = typer.Argument(None, help="Dotted key to retrieve (e.g. compact_assist.enabled). Omit to show all config in TOML format."),  # noqa: B008
) -> None:
    """Show current config value(s).

    With no KEY, prints the full config.toml in TOML format.  With KEY, prints
    just that value (supports dot notation: ``compact_assist.max_manifest_tokens``).
    Sections are accepted as keys and return a JSON object.
    """
    import tomli_w  # noqa: PLC0415

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

    typer.echo(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


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
    key: str | None = typer.Argument(None, help="Dotted key to reset (e.g. compact_assist.enabled). Omit to reset ALL settings."),  # noqa: B008
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),  # noqa: B008
) -> None:
    """Reset config to defaults — one key or everything.

    With no KEY, deletes config.toml entirely (restoring all defaults).  With
    KEY, removes that specific key from the file so it falls back to its default.
    Prompts for confirmation when deleting the whole file unless ``--yes`` is given.
    """
    from . import paths as _paths  # noqa: PLC0415

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
        config_mod._config_mtime_cache = None  # type: ignore[attr-defined]
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
    from . import paths as _paths  # noqa: PLC0415

    typer.echo(str(_paths.config_path()))


@app.command("clean-cache", rich_help_panel="Advanced")
def cmd_clean_cache(
    images: bool = typer.Option(False, "--images", help="Prune the image shrink cache to its configured floor."),  # noqa: B008
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
            from . import paths as _paths  # noqa: PLC0415
            from . import worker as _worker  # noqa: PLC0415

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
        except Exception as exc:  # noqa: BLE001
            results["images"] = {"status": "error", "error": str(exc)}

    if json_output:
        typer.echo(json.dumps(results, ensure_ascii=False, separators=(",", ":")))
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


@app.command("diff", rich_help_panel="Core")
def cmd_diff(
    since: str = typer.Option("HEAD~1", "--since", help="Git ref to diff against (commit, branch, tag). Default: HEAD~1."),  # noqa: B008
    session_id: str | None = typer.Option(None, "--session", "-s", help="Show files edited in this session instead of running git diff."),  # noqa: B008
    symbols: bool = typer.Option(False, "--symbols", help="List changed symbols (functions/classes) for each file."),  # noqa: B008
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
    import os as _os  # noqa: PLC0415
    import sys as _sys  # noqa: PLC0415

    from .util import run_git  # noqa: PLC0415

    cwd = _os.getcwd()

    # ---- session mode -------------------------------------------------------
    if session_id is not None:
        _validate_session_id(session_id)
        from . import session as session_mod  # noqa: PLC0415

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
    import re as _re  # noqa: PLC0415

    from .util import run_git  # noqa: PLC0415

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
    import contextlib  # noqa: PLC0415

    from . import paths as _paths  # noqa: PLC0415

    sessions_dir = _paths.data_dir() / "sessions"
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

    rows.sort(key=lambda r: float(r["last_activity_ts"]), reverse=True)  # type: ignore[arg-type]
    if limit > 0:
        rows = rows[:limit]
    return rows


@app.command("sessions", rich_help_panel="Core")
def cmd_sessions(
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum sessions to show (newest first)"),  # noqa: B008
    project: str | None = typer.Option(  # noqa: B008
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
        typer.echo(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
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
        age = _format_relative_time(now - cast(float, r["last_activity_ts"]))
        typer.echo(
            f"{sid_short:>26}  {proj:<20}  {age:>11}  {cast(int, r['file_count']):>5}  "
            f"{cast(int, r['edit_count']):>5}  {cast(int, r['hints_emitted']):>5}  "
            f"{cast(int, r['bash_count']):>4}  {cast(int, r['web_count']):>4}"
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
    import contextlib  # noqa: PLC0415

    from . import paths as _paths  # noqa: PLC0415

    sessions_dir = _paths.data_dir() / "sessions"
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
        typer.echo(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
        return

    now = time.time()
    sid = str(raw.get("session_id", session_file.stem))
    cwd = str(raw.get("cwd") or "(unknown)")
    _raw_last = raw.get("last_activity_ts")
    last_ts = float(_raw_last) if _raw_last is not None else session_file.stat().st_mtime  # type: ignore[arg-type]
    _raw_started = raw.get("started_ts")
    started_ts = float(_raw_started) if _raw_started is not None else last_ts  # type: ignore[arg-type]
    age = _format_relative_time(now - last_ts)
    duration_secs = last_ts - started_ts
    duration = _format_relative_time(duration_secs) if duration_secs > 0 else "0s"

    typer.echo(f"session:     {sid}")
    typer.echo(f"project:     {cwd}")
    typer.echo(f"last active: {age} ago")
    typer.echo(f"duration:    {duration}")
    _hints_e = int(raw.get("hints_emitted") or 0)  # type: ignore[call-overload]
    _hints_i = int(raw.get("hints_ignored") or 0)  # type: ignore[call-overload]
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
            key=lambda x: float(x[1].get("last_read_ts") or 0),  # type: ignore[union-attr]
            reverse=True,
        )
        for path, entry in file_list[:20]:
            rc = int(entry.get("read_count") or 0)  # type: ignore[union-attr]
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
            key=lambda x: float(x[1].get("ts") or 0),  # type: ignore[union-attr]
            reverse=True,
        )
        for _key, entry in bash_entries[:15]:
            preview = str(entry.get("cmd_preview") or "(no preview)")[:80]  # type: ignore[union-attr]
            rc = int(entry.get("run_count") or 1)  # type: ignore[union-attr]
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
            key=lambda x: float(x[1].get("ts") or 0),  # type: ignore[union-attr]
            reverse=True,
        )
        for _key, entry in web_entries[:15]:
            preview = str(entry.get("url_preview") or "(no preview)")[:80]  # type: ignore[union-attr]
            typer.echo(f"  {preview}")
        if len(web_hist) > 15:
            typer.echo(f"  ... and {len(web_hist) - 15} more")


@app.command("export", rich_help_panel="Core")
def cmd_export(
    fmt: str = typer.Option("json", "--format", "-f", help="Output format: json, csv, or ctags."),  # noqa: B008
    output: str | None = typer.Option(None, "--output", "-o", help="Write output to FILE instead of stdout."),  # noqa: B008
    project: str | None = typer.Option(None, "--project", "-p", help="Project root (default: current directory)."),  # noqa: B008
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
    import csv as _csv  # noqa: PLC0415
    import io  # noqa: PLC0415
    from pathlib import Path as _Path  # noqa: PLC0415

    _db = _lazy_import("db")

    from .project import find_project  # noqa: PLC0415

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
    except Exception as exc:  # noqa: BLE001
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
    images: bool = typer.Option(False, "--images", help="Clear the image shrink cache."),  # noqa: B008
    bash: bool = typer.Option(False, "--bash", help="Clear the bash output cache."),  # noqa: B008
    web: bool = typer.Option(False, "--web", help="Clear the web output cache."),  # noqa: B008
    sessions: bool = typer.Option(False, "--sessions", help="Remove session files older than --older-than days."),  # noqa: B008
    all_caches: bool = typer.Option(False, "--all", help="Clear all caches (equivalent to --images --bash --web --sessions)."),  # noqa: B008
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would be deleted without deleting."),  # noqa: B008
    older_than: int = typer.Option(7, "--older-than", help="Only delete files older than N days (applies to all categories)."),  # noqa: B008
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
    import contextlib  # noqa: PLC0415
    import time as _time  # noqa: PLC0415

    from . import paths as _paths  # noqa: PLC0415

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
        sess_dir = _paths.data_dir() / "sessions"
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
    import builtins  # noqa: PLC0415

    from . import hook_registry  # noqa: PLC0415

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
