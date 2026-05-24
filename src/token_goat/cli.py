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
from typing import TYPE_CHECKING, cast, get_args

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
    from . import session as session_mod  # noqa: PLC0415

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
    from . import db as _db  # noqa: PLC0415

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
    from . import db as _db  # noqa: PLC0415

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
    from . import db as _db  # noqa: PLC0415

    try:
        with _db.open_project(proj_hash) as conn:
            return conn.execute(sql, params).fetchall()
    except _db.DBError as exc:
        _error(f"project index unavailable: {exc}. Run `token-goat index --full` to rebuild.")
        raise typer.Exit(1) from None


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
    from . import db as _db  # noqa: PLC0415

    use_tty_color = sys.stdout.isatty() and not as_json

    def _fmt_plain(rows: list[dict]) -> None:
        """Print symbol rows as plain text, optionally with ANSI colour when stdout is a TTY."""
        for row in rows:
            project_prefix = f"[{row.get('project', '')}] " if "project" in row else ""
            sig_part = f"  {row['signature']}" if row.get("signature") else ""
            kind_name = f"{row['kind']} {row['name']}"
            if use_tty_color:
                kind_name = f"\033[90m{kind_name}\033[0m"
                sig_part = f"\033[2m{sig_part}\033[0m"
            typer.echo(f"{project_prefix}{row['file']}:{row['line']}: {kind_name}{sig_part}")

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
        except _db.DBError as exc:
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
                    except _db.DBError as exc:
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

    hint = read_commands._not_indexed_hint(proj.hash)
    close = []
    redirected = None
    if not results and not hint:
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
    _emit_results(
        results,
        not_found_extra=hint,
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
            f"embeddings unavailable ({e}). Try `token-goat index --embeddings` first, "
            "or use `token-goat symbol`/`token-goat map` for non-semantic navigation."
        )
        raise typer.Exit(0) from None

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
) -> None:
    """Generate a PageRank-ranked, token-budgeted overview of the current project."""
    from . import repomap  # noqa: PLC0415

    proj = _require_project(
        "no project detected (no .git, package.json, etc. found). "
        "Run from a project directory."
    )

    _LOG.info(
        "map start: project=%s budget=%d json=%s compact=%s full=%s",
        proj.root.name, budget, json_output, compact, full,
    )
    t0 = time.monotonic()
    try:
        if json_output:
            data = repomap.build_map_json(proj)
            elapsed = time.monotonic() - t0
            _LOG.info("map complete: project=%s files=%d dur=%.3fs", proj.root.name, len(data), elapsed)
            typer.echo(json.dumps(data, separators=(",", ":")))
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


@app.command(rich_help_panel="Core")
def index(
    full: bool = typer.Option(False, "--full"),
    embeddings: bool = typer.Option(False, "--embeddings"),
    root: str | None = typer.Option(None, "--root", help="Index an arbitrary directory (skips project detection)"),
    skills: bool = typer.Option(False, "--skills", help="Index ~/.claude/skills/"),
    plugins: bool = typer.Option(False, "--plugins", help="Index ~/.claude/plugins/"),
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

    def _progress(done: int, total: int) -> None:
        """Emit an indexing progress line to stderr."""
        typer.echo(f"  {done}/{total} files processed...", err=True)

    _LOG.info("index start: project=%s mode=%s", proj.root.name, "full" if full else "incremental")
    try:
        summary = index_project(proj, full=full, progress=_progress)
    except Exception as exc:  # noqa: BLE001
        _error(f"indexing failed: {exc}")
        raise typer.Exit(1) from None

    langs = ", ".join(summary["languages"]) if summary["languages"] else "none"
    _LOG.info(
        "index complete: project=%s files=%d indexed=%d errors=%d dur=%.2fs",
        proj.root.name,
        summary["total_files"],
        summary["indexed"],
        summary["errors"],
        summary["duration_sec"],
    )
    typer.echo(
        f"Indexed {summary['total_files']} files "
        f"({summary['indexed']} indexed, "
        f"{summary['skipped_unchanged']} skipped unchanged, "
        f"{summary['errors']} errors) "
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


@app.command(rich_help_panel="Core")
def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = _OPT_JSON,
) -> None:
    """Show cumulative token savings."""
    from . import cli_stats  # noqa: PLC0415

    cli_stats.stats(window=window, json_output=json_output)


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
_OPT_GREP: str | None = typer.Option(None, "--grep", "-g", help="Show only lines matching the (case-sensitive) substring")  # noqa: B008
_OPT_GREP_MAX: int = typer.Option(_GREP_MAX_DEFAULT, "--grep-max", help="Max matching lines to show with --grep (0 = no cap)")  # noqa: B008
_OPT_FULL: bool = typer.Option(False, "--full", help="Return the entire cached output (disables smart-default head+tail)")  # noqa: B008
_OPT_HEAD_TAIL: bool = typer.Option(False, "--head-tail", help="Emit first+last 20 lines with an omission marker instead of full body")  # noqa: B008


def _apply_recall_filters(
    lines: list[str],
    *,
    head: int,
    tail: int,
    grep: str | None,
    full: bool,
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
        grep:  Case-sensitive substring filter; ``None`` or ``""`` = no filter.
        full:  When True, skip the smart-default elision even if no explicit
               slice flags were passed.

    Returns:
        Filtered list of lines; caller joins with ``"\\n"`` for output.
    """
    slicing_requested = bool(grep) or head > 0 or tail > 0
    if grep:
        lines = [ln for ln in lines if grep in ln]
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
    """
    from . import db as _db  # noqa: PLC0415

    load_output = cache_module.load_output  # type: ignore[attr-defined]
    load_output_meta = cache_module.load_output_meta  # type: ignore[attr-defined]
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]

    body = load_output(output_id)
    if body is None:
        _error(not_found_msg)
        raise typer.Exit(1)

    lines = body.splitlines()
    _slicing_requested = grep or head > 0 or tail > 0 or head_tail
    _grep_footer = ""
    if grep:
        matched = [ln for ln in lines if grep in ln]
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
            payload["match_count"] = len([ln for ln in original_lines if grep in ln])
        payload.update(meta)
        if sidecar is not None:
            payload.update(vars(sidecar))
        typer.echo(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return

    typer.echo(sliced)


@app.command("bash-output", rich_help_panel="Core")
def cmd_bash_output(
    output_id: str = typer.Argument(..., help="ID returned by the post-bash hook or `bash-history`."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
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
    Use ``--head-tail`` to get just the first+last 20 lines (useful for large
    outputs where you only need the gist).  Use ``--grep-max N`` to cap
    the number of matching lines returned (default 20; 0 = no cap).
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
    )


@app.command("web-output", rich_help_panel="Core")
def cmd_web_output(
    output_id: str = typer.Argument(..., help="ID returned by the post-fetch hook or `web-history`."),
    head: int = _OPT_HEAD,
    tail: int = _OPT_TAIL,
    grep: str | None = _OPT_GREP,
    grep_max: int = _OPT_GREP_MAX,
    full: bool = _OPT_FULL,
    head_tail: bool = _OPT_HEAD_TAIL,
    json_output: bool = _OPT_JSON,
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
    Use ``--head-tail`` to get just the first+last 20 lines (useful for large
    documentation pages where you only need the gist).  Use ``--grep-max N``
    to cap the number of matching lines returned (default 20; 0 = no cap).
    JSON mode includes the full path, stored byte size, status code, and a
    1-based ``numbered_lines`` list anchored to the original body.
    """
    from . import web_cache  # noqa: PLC0415

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
    )


def _run_history_listing_command(
    cache_module: object,
    *,
    json_output: bool,
    limit: int,
    empty_msg: str,
    json_sidecar_fields: Callable[[object], dict[str, object]],
    format_entry: Callable[[str, int, int, object], str],
) -> None:
    """Shared implementation for bash-history, web-history, and skill-history.

    ``cache_module`` must expose ``list_outputs()``, which returns a list of
    dicts with at least ``output_id``, ``size_bytes``, and ``mtime`` keys, and
    ``read_sidecar(output_id)`` which returns a sidecar dataclass or ``None``.

    ``json_sidecar_fields`` converts a non-None sidecar into extra key/value
    pairs that are merged into each JSON row.

    ``format_entry(oid, size, age_secs, sidecar)`` produces the human-readable
    line for one entry (sidecar may be ``None``).
    """
    list_outputs = cache_module.list_outputs  # type: ignore[attr-defined]
    read_sidecar = cache_module.read_sidecar  # type: ignore[attr-defined]

    entries = list_outputs()
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


@app.command("bash-history", rich_help_panel="Core")
def cmd_bash_history(
    json_output: bool = _OPT_JSON,
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum entries to show (newest first)"),
) -> None:
    """List cached Bash outputs, newest first.

    Helpful when you want to find an earlier command's output without
    re-running it.  Each row shows the cache ID, byte size, age, and (if a
    sidecar file is present) the command preview and exit code.  Use the ID
    with ``token-goat bash-output <id>`` to retrieve the body.
    """
    from . import bash_cache  # noqa: PLC0415

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
    from . import skill_cache  # noqa: PLC0415

    meta = skill_cache.lookup_by_name(name)
    body: str | None = None
    source_label = "cache"
    if meta is not None:
        body = skill_cache.load_output(meta.output_id)
        if body is None and meta.source_path:
            # Cache file evicted but the source path was recorded — read it back.
            try:
                from pathlib import Path  # noqa: PLC0415

                body = Path(meta.source_path).read_text(encoding="utf-8", errors="replace")
                source_label = f"source:{meta.source_path}"
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
        payload: dict[str, object] = {
            "skill_name": name,
            "source": source_label,
            "text": sliced,
            "lines": len(lines),
            "numbered_lines": numbered,
            "total_lines": len(original_lines),
            "body_bytes": body_bytes,
        }
        if meta is not None:
            payload["output_id"] = meta.output_id
            payload["content_sha"] = meta.content_sha
            payload["ts"] = meta.ts
            payload["truncated"] = meta.truncated
            payload["source_path"] = meta.source_path
        typer.echo(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
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


@app.command("compact-hint", rich_help_panel="Advanced")
def compact_hint(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = _OPT_JSON,
    max_tokens: int = typer.Option(400, "--max-tokens", help="Token budget for the manifest"),
) -> None:
    """Show the compaction manifest token-goat would inject for a session.

    Use this to inspect what the PreCompact hook will emit as systemMessage
    before Claude Code compacts the conversation. Useful for debugging.
    """
    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415

    _validate_session_id(session_id)

    cfg = config_mod.load().compact_assist

    if json_output:
        import json as _json  # noqa: PLC0415

        n_events = compact_mod.event_count(session_id)
        manifest = compact_mod.build_manifest(session_id, max_tokens=max_tokens)
        typer.echo(_json.dumps({
            "enabled": cfg.enabled,
            "triggers": cfg.triggers,
            "min_events": cfg.min_events,
            "max_manifest_tokens": cfg.max_manifest_tokens,
            "event_count": n_events,
            "would_emit": cfg.enabled and n_events >= cfg.min_events and bool(manifest),
            "manifest": manifest,
        }, separators=(",", ":")))
        return

    n_events = compact_mod.event_count(session_id)
    typer.echo(f"compact-assist enabled: {cfg.enabled}")
    typer.echo(f"triggers: {', '.join(cfg.triggers)}")
    typer.echo(f"min_events: {cfg.min_events}  |  session events: {n_events}")
    typer.echo("")

    if not cfg.enabled:
        typer.echo("(disabled — set TOKEN_GOAT_COMPACT_ASSIST=1 or edit config.toml to enable)")
        return

    if n_events < cfg.min_events:
        typer.echo(f"(no manifest: {n_events} events < min_events {cfg.min_events})")
        return

    manifest = compact_mod.build_manifest(session_id, max_tokens=max_tokens)
    if not manifest:
        typer.echo("(no manifest: session cache empty)")
        return

    typer.echo("--- manifest that would be injected as systemMessage ---")
    typer.echo(manifest)
    typer.echo("---")
    typer.echo(f"({len(manifest)} chars, ~{len(manifest) // 4} tokens)")


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


@config_app.command()
def get(key: str) -> None:
    """Get config value."""
    cfg = config_mod.load()
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
    """Set config value."""
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
        updated = asdict(updated)
    typer.echo(json.dumps(updated, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    app()
