"""Environmental baseline attribution — the per-session "expense report".

A spawned subagent starts every task with its context window already heavily
pre-loaded by content it never requested and cannot see itemized: both CLAUDE.md
files, MEMORY.md, MCP instruction blocks, and other plugins' SessionStart dumps
(the worst single offender observed: a 58.8 KB Vercel knowledge-graph re-injected
on every session start). This module measures and *attributes* that baseline so
"why did that subagent overflow at hello?" becomes a quick, actionable lookup
instead of an invisible failure.

It is strictly **read-only** — it scans the Claude Code session's persisted hook
output, the two CLAUDE.md files, MEMORY.md, and the configured MCP servers, costs
each source, and tags it by owner (you / harness / ``plugin:<name>``), a concrete
fix, and whether the cost is fixed (recurs every session) or variable
(prompt-driven). Each scanner is fail-soft: a missing or unreadable source adds a
note and is skipped, never raising.

Costing uses ``bytes // 4`` — the same convention ``token-goat doctor``'s
"Context footprint" and :func:`token_goat.compact._token_count` already use — so a
baseline total reconciles with the doctor rather than contradicting it.

What this module deliberately does *not* do (see ``docs/plans`` design doc):

* It does not measure the skill catalog / loaded-skill cost — ``token-goat doctor``
  already does that well; duplicating it here would drift. The report points there.
* It does not reconcile against the transcript (``--exact``) or detect
  loaded-but-unused MCP servers — both are schema-coupled and deferred.
* It does not edit or suppress any injection (impossible — hooks are append-only);
  it advises, and a later opt-in ``slim`` mutator will act on the sources you own.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from . import paths
from .util import get_logger

_LOG = get_logger("baseline")

# Default context window (tokens) used as the pct-of-window denominator.  This is
# the model's actual window — the figure that matters for the subagent-overflow
# problem this report exists to surface.  It is intentionally *not*
# ``compact.CONTEXT_AUTOCOMPACT_TOKENS`` (660,000): that is Claude Code's
# conversation auto-compact budget, a different denominator answering a different
# question.  Override per invocation with ``--window``.
DEFAULT_WINDOW_TOKENS = 200_000

# Bytes of a persisted hook dump to sniff for owner attribution and a title.
_SNIFF_BYTES = 2048

# Best-effort owner attribution from a hook dump's leading bytes.  This is a
# heuristic (the reliable signal — a transcript cross-reference — is deferred);
# an unmatched dump is reported as ``plugin:unknown`` rather than guessed.  First
# match wins, so order from most to least specific if substrings ever overlap.
_PLUGIN_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("vercel", "plugin:vercel"),
    ("supabase", "plugin:supabase"),
    ("stripe", "plugin:stripe"),
    ("atlassian", "plugin:atlassian"),
    ("firebase", "plugin:firebase"),
    ("sentry", "plugin:sentry"),
    ("goodmem", "plugin:goodmem"),
    ("=== remember ===", "plugin:remember"),
    ("remember", "plugin:remember"),
)


def _tokens_from_bytes(n_bytes: int) -> int:
    """Token estimate matching ``token-goat doctor`` and ``compact._token_count``.

    1 token ≈ 4 bytes — the conservative convention used across token-goat's
    context-budget accounting.  Using it here keeps a baseline total consistent
    with the doctor's Context footprint instead of presenting a second, larger
    number from ``estimate_tokens`` (``len // 3 + 1``).
    """
    return max(0, n_bytes) // 4


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BaselineRow:
    """One attributed contributor to the session's environmental baseline.

    Attributes:
        source: Human-readable label (e.g. the dump's title, or ``CLAUDE.md (global)``).
        n_bytes: On-disk / content byte count.
        tokens: ``n_bytes // 4`` — see :func:`_tokens_from_bytes`.
        owner: ``you`` | ``harness`` | ``plugin:<name>`` | ``unknown``.
        fix: Concrete next action — ``slim`` | ``disable-hook`` | ``disable-mcp``
            | ``lazy-load`` | ``none``.
        kind: ``fixed`` (recurs every session start) or ``variable`` (prompt-driven).
        detail: Optional extra context (fire count, path, "already lazy").
    """

    source: str
    n_bytes: int
    tokens: int
    owner: str
    fix: str
    kind: str
    detail: str = ""

    def pct_of(self, window_tokens: int) -> float:
        """This row's share of *window_tokens*, as a fraction in ``[0, ...]``."""
        if window_tokens <= 0:
            return 0.0
        return self.tokens / window_tokens

    def as_dict(self, window_tokens: int) -> dict[str, object]:
        """JSON-serialisable view including the derived pct-of-window."""
        return {
            "source": self.source,
            "bytes": self.n_bytes,
            "tokens": self.tokens,
            "pct_of_window": round(self.pct_of(window_tokens), 4),
            "owner": self.owner,
            "fix": self.fix,
            "kind": self.kind,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class BaselineReport:
    """Result of :func:`collect_baseline` — rows plus session/window context."""

    rows: list[BaselineRow]
    window_tokens: int
    session_id: str | None
    tool_results_available: bool
    notes: list[str] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        """Sum of every row's token cost."""
        return sum(r.tokens for r in self.rows)

    @property
    def fixed_tokens(self) -> int:
        """Token cost a fresh subagent inherits — ``kind == "fixed"`` rows only."""
        return sum(r.tokens for r in self.rows if r.kind == "fixed")

    def pct(self, tokens: int) -> float:
        """Fraction of the window *tokens* represents."""
        if self.window_tokens <= 0:
            return 0.0
        return tokens / self.window_tokens

    def as_dict(self) -> dict[str, object]:
        """Full JSON-serialisable report."""
        return {
            "session_id": self.session_id,
            "window_tokens": self.window_tokens,
            "tool_results_available": self.tool_results_available,
            "total_tokens": self.total_tokens,
            "fixed_tokens": self.fixed_tokens,
            "total_pct_of_window": round(self.pct(self.total_tokens), 4),
            "fixed_pct_of_window": round(self.pct(self.fixed_tokens), 4),
            "rows": [r.as_dict(self.window_tokens) for r in self.rows],
            "notes": list(self.notes),
        }


# ---------------------------------------------------------------------------
# Session / tool-results resolution
# ---------------------------------------------------------------------------


def _resolve_session(session_id: str | None) -> tuple[str | None, Path | None]:
    """Resolve ``(session_id, tool_results_dir)`` for the report.

    Precedence: an explicit *session_id* arg, then ``CLAUDE_SESSION_ID`` (set by
    Claude Code in hook/CLI subprocesses), then — when neither is available — the
    most-recently-modified ``<session>/tool-results`` directory across all
    projects (a best-effort "current session" stand-in for ad-hoc CLI runs).

    Either element may be ``None``: no session could be identified, or the
    identified session has no persisted ``tool-results`` directory (it never
    persisted a large hook dump).  Never raises.
    """
    sid = session_id or os.environ.get("CLAUDE_SESSION_ID") or None
    if sid:
        return sid, paths.claude_session_tool_results_dir(sid)
    return _newest_tool_results_dir()


def _newest_tool_results_dir() -> tuple[str | None, Path | None]:
    """Return ``(session_id, dir)`` for the newest ``tool-results`` dir, or ``(None, None)``.

    Scans every ``~/.claude/projects/<proj>/<session>/tool-results`` directory and
    picks the one with the most recent mtime.  Used only when no session id is
    supplied; the resolved id is reported back so the user can ``--session-id``
    override if the heuristic crossed into another project.
    """
    root = paths.claude_projects_dir()
    best: tuple[float, str, Path] | None = None
    try:
        if not root.is_dir():
            return None, None
        for proj_dir in root.iterdir():
            try:
                if not proj_dir.is_dir():
                    continue
                for sess_dir in proj_dir.iterdir():
                    tr = sess_dir / "tool-results"
                    try:
                        if not tr.is_dir():
                            continue
                        mtime = tr.stat().st_mtime
                    except OSError:
                        continue
                    if best is None or mtime > best[0]:
                        best = (mtime, sess_dir.name, tr)
            except OSError:
                continue
    except OSError:
        return None, None
    if best is None:
        return None, None
    return best[1], best[2]


# ---------------------------------------------------------------------------
# Scanners — each appends rows / notes, never raises
# ---------------------------------------------------------------------------


def _sniff_owner_and_title(head: str) -> tuple[str, str]:
    """Best-effort ``(owner, title)`` from a hook dump's leading text.

    Owner is matched against :data:`_PLUGIN_KEYWORDS` (lowercased substring,
    first match wins), defaulting to ``plugin:unknown``.  Title is the first
    markdown ``# H1`` or, failing that, the first non-empty line — capped so the
    table stays readable.
    """
    lowered = head.lower()
    owner = "plugin:unknown"
    for needle, name in _PLUGIN_KEYWORDS:
        if needle in lowered:
            owner = name
            break
    title = ""
    for line in head.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        title = stripped.lstrip("# ").strip() if stripped.startswith("#") else stripped
        break
    if len(title) > 60:
        title = title[:57].rstrip() + "..."
    return owner, title or "hook dump"


@dataclass
class _DumpGroup:
    """Mutable accumulator for content-identical hook dumps (fire-count rollup)."""

    n_bytes: int
    owner: str
    title: str
    fires: int


def _scan_hook_dumps(
    tool_results: Path | None, rows: list[BaselineRow], notes: list[str]
) -> None:
    """Cost the persisted SessionStart/UserPromptSubmit hook dumps.

    Globs ``hook-*-stdout.txt`` (the harness's persisted-hook-output naming),
    *deduplicating by content hash*: a plugin that re-injects the same dump on
    every session start writes one identical file per fire, but a fresh subagent
    pays that cost only once — so the report shows the distinct dump once, with a
    ``×N fires`` note.  A dump seen more than once is treated as ``fixed`` (a
    per-start subscription); a single-fire dump is ``variable`` (a one-off push).

    Non-``hook-`` files in the directory (e.g. ``<random>.txt`` persisted large
    *tool* outputs) are conversation, not environmental baseline, and are skipped
    by the glob.
    """
    if tool_results is None:
        notes.append(
            "hook dumps: no tool-results directory for this session "
            "(no large hook output was persisted, or the session could not be resolved)."
        )
        return
    try:
        dump_paths = sorted(tool_results.glob("hook-*-stdout.txt"))
    except OSError as exc:
        notes.append(f"hook dumps: unreadable tool-results directory ({exc.__class__.__name__}).")
        return
    if not dump_paths:
        notes.append("hook dumps: none persisted this session.")
        return

    # Group identical dumps by content hash: the first occurrence records the
    # size/owner/title; later occurrences only bump the fire count.
    groups: dict[str, _DumpGroup] = {}
    for p in dump_paths:
        try:
            data = p.read_bytes()
        except OSError:
            continue
        digest = hashlib.sha256(data).hexdigest()
        g = groups.get(digest)
        if g is None:
            head = data[:_SNIFF_BYTES].decode("utf-8", errors="replace")
            owner, title = _sniff_owner_and_title(head)
            groups[digest] = _DumpGroup(n_bytes=len(data), owner=owner, title=title, fires=1)
        else:
            g.fires += 1

    for g in groups.values():
        kind = "fixed" if g.fires > 1 else "variable"
        detail = f"x{g.fires} fires this session" if g.fires > 1 else "1 fire this session"
        rows.append(
            BaselineRow(
                source=g.title,
                n_bytes=g.n_bytes,
                tokens=_tokens_from_bytes(g.n_bytes),
                owner=g.owner,
                fix="disable-hook",
                kind=kind,
                detail=detail,
            )
        )


def _cost_file(path: Path) -> int | None:
    """Return *path*'s size in bytes, or ``None`` if it is absent/unreadable."""
    try:
        if path.is_file():
            return path.stat().st_size
    except OSError:
        return None
    return None


def _scan_claude_md(cwd: Path, rows: list[BaselineRow], notes: list[str]) -> None:
    """Cost the global (``~/.claude/CLAUDE.md``) and project (``./CLAUDE.md``) files.

    Both are injected verbatim on every turn and are owned by the user, so the
    fix is ``slim`` (move detail into ``token-goat section``-served sidecars).
    ``@import`` expansion is deferred (the global file contains ``@``-bearing
    text — emails, decorators — that naive matching would misread).
    """
    candidates = (
        ("CLAUDE.md (global)", paths.claude_config_dir() / "CLAUDE.md"),
        ("CLAUDE.md (project)", cwd / "CLAUDE.md"),
    )
    any_found = False
    for label, path in candidates:
        size = _cost_file(path)
        if size is None:
            continue
        any_found = True
        rows.append(
            BaselineRow(
                source=label,
                n_bytes=size,
                tokens=_tokens_from_bytes(size),
                owner="you",
                fix="slim",
                kind="fixed",
                detail=str(path),
            )
        )
    if not any_found:
        notes.append("CLAUDE.md: none found (global or project).")


def _memory_is_already_lazy(memory_md: Path) -> bool:
    """True when ``MEMORY.md`` is an index over sibling ``*.md`` memory files.

    The lazy pattern (already used in this project) keeps MEMORY.md as a short
    one-line-per-memory index and stores each fact in its own file, served on
    demand — so the injected cost is just the index, and ``fix`` is ``none``.
    Heuristic: the memory directory holds at least one ``*.md`` *besides*
    MEMORY.md.
    """
    try:
        siblings = [
            p for p in memory_md.parent.glob("*.md") if p.name.lower() != "memory.md"
        ]
    except OSError:
        return False
    return len(siblings) > 0


def _scan_memory_md(
    tool_results: Path | None, cwd: Path, rows: list[BaselineRow], notes: list[str]
) -> None:
    """Cost the current project's ``MEMORY.md`` auto-memory index.

    Located via the resolved session's project directory
    (``<tool-results>/../../memory/MEMORY.md``) so no path-slug scheme is
    reimplemented.  When the session/tool-results dir is unknown, MEMORY.md is
    skipped with a note rather than summed across unrelated projects (which is
    what ``token-goat doctor`` does, deliberately, for its broad health view).
    """
    if tool_results is None:
        notes.append("MEMORY.md: skipped (no session resolved to locate the project's memory dir).")
        return
    memory_md = tool_results.parent.parent / "memory" / "MEMORY.md"
    size = _cost_file(memory_md)
    if size is None:
        notes.append("MEMORY.md: not found for this project.")
        return
    lazy = _memory_is_already_lazy(memory_md)
    rows.append(
        BaselineRow(
            source="MEMORY.md (auto-memory index)",
            n_bytes=size,
            tokens=_tokens_from_bytes(size),
            owner="you",
            fix="none" if lazy else "lazy-load",
            kind="fixed",
            detail="already an index over sibling files" if lazy else str(memory_md),
        )
    )


def _read_mcp_server_names(path: Path) -> list[str]:
    """Return the ``mcpServers`` keys declared in a JSON config *path*.

    Handles both the project ``.mcp.json`` shape (top-level ``mcpServers``) and
    the user ``~/.claude.json`` shape (top-level ``mcpServers`` plus per-project
    ``projects[<dir>].mcpServers``).  Unreadable / malformed files yield ``[]``.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    names: list[str] = []
    if isinstance(data, dict):
        top = data.get("mcpServers")
        if isinstance(top, dict):
            names.extend(str(k) for k in top)
        projects = data.get("projects")
        if isinstance(projects, dict):
            for proj in projects.values():
                if isinstance(proj, dict) and isinstance(proj.get("mcpServers"), dict):
                    names.extend(str(k) for k in proj["mcpServers"])
    return names


def _scan_mcp(cwd: Path, rows: list[BaselineRow], notes: list[str]) -> None:
    """Inventory configured MCP servers (instruction-block cost not costed in v1).

    Each connected MCP server injects an instruction block into the system
    prompt, but that text lives on the server, not on disk, so v1 cannot cost it
    precisely (a transcript cross-reference is deferred).  We therefore emit a
    single visible 0-token inventory row — so the fixable surface is listed —
    plus a note naming the servers and how to disable unused ones.
    """
    server_names: list[str] = []
    with contextlib.suppress(Exception):
        server_names.extend(_read_mcp_server_names(cwd / ".mcp.json"))
    with contextlib.suppress(Exception):
        server_names.extend(_read_mcp_server_names(paths.claude_config_dir().parent / ".claude.json"))
    with contextlib.suppress(Exception):
        server_names.extend(_read_mcp_server_names(Path.home() / ".claude.json"))
    # Dedupe, preserve first-seen order.
    seen: dict[str, None] = {}
    for n in server_names:
        seen.setdefault(n, None)
    unique = list(seen)
    if not unique:
        notes.append("MCP: no configured servers found in .mcp.json / ~/.claude.json.")
        return
    rows.append(
        BaselineRow(
            source=f"MCP instruction blocks ({len(unique)} servers)",
            n_bytes=0,
            tokens=0,
            owner="harness",
            fix="disable-mcp",
            kind="fixed",
            detail="not costed in v1 (lives on the server, not on disk)",
        )
    )
    notes.append(
        f"MCP: {len(unique)} server(s) configured ({', '.join(sorted(unique))}) — "
        "not all are necessarily active this session (plugin-bundled servers are not "
        "listed here). Each active one injects an instruction block; disable unused ones "
        "with `claude mcp remove <name>`."
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def collect_baseline(
    cwd: Path,
    session_id: str | None = None,
    *,
    window_tokens: int = DEFAULT_WINDOW_TOKENS,
) -> BaselineReport:
    """Scan and attribute the session's environmental baseline.

    Runs every source scanner fail-soft (a broken source becomes a note, not an
    exception), costs each contributor at ``bytes // 4``, and returns a
    :class:`BaselineReport` with rows sorted by token cost descending.

    Args:
        cwd: The project working directory (locates the project ``CLAUDE.md``).
        session_id: Explicit session id; falls back to ``CLAUDE_SESSION_ID`` then
            the newest ``tool-results`` directory.
        window_tokens: Denominator for pct-of-window (default the 200k model window).

    Returns:
        A populated :class:`BaselineReport`.  Never raises for ordinary
        filesystem problems.
    """
    rows: list[BaselineRow] = []
    notes: list[str] = []
    sid, tool_results = _resolve_session(session_id)

    _scan_hook_dumps(tool_results, rows, notes)
    _scan_claude_md(cwd, rows, notes)
    _scan_memory_md(tool_results, cwd, rows, notes)
    _scan_mcp(cwd, rows, notes)

    rows.sort(key=lambda r: r.tokens, reverse=True)
    notes.append("Skill catalog & loaded-skill cost: run `token-goat doctor`.")
    return BaselineReport(
        rows=rows,
        window_tokens=window_tokens,
        session_id=sid,
        tool_results_available=tool_results is not None,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Rendering (pure — testable without the CLI)
# ---------------------------------------------------------------------------


def _fmt_pct(fraction: float) -> str:
    """Render a fraction as a one-decimal percentage (e.g. ``7.4%``)."""
    return f"{fraction * 100:.1f}%"


def format_report(report: BaselineReport, *, subagent: bool = False) -> list[str]:
    """Render *report* as plain-text lines (the default, non-JSON CLI output).

    With *subagent* True, shows only the fixed sources a freshly spawned agent
    inherits and frames the total as its starting fill — the figure that answers
    "how full is a subagent before its first action?".
    """
    selected = [r for r in report.rows if r.kind == "fixed"] if subagent else list(report.rows)
    short_sid = (report.session_id or "unknown")[:8]
    win = report.window_tokens

    lines: list[str] = []
    if subagent:
        lines.append(f"Subagent spawn baseline — fixed sources a fresh agent inherits  (session {short_sid})")
    else:
        lines.append(f"Session baseline — {short_sid}  (window {win:,} tok)")
    lines.append("")

    if not selected:
        lines.append("  (no baseline sources measured — see notes below)")
    else:
        lines.append(f"  {'TOKENS':>8}  {'%WIN':>5}  {'OWNER':<16}{'FIX':<14}SOURCE")
        for r in selected:
            lines.append(
                f"  {r.tokens:>8,}  {_fmt_pct(r.pct_of(win)):>5}  "
                f"{r.owner:<16}{r.fix:<14}{r.source}"
                + (f"  [{r.detail}]" if r.detail else "")
            )
        lines.append("  " + "-" * 6)

    if subagent:
        fixed = report.fixed_tokens
        lines.append(
            f"  A spawned agent starts at ~{fixed:,} tok "
            f"({_fmt_pct(report.pct(fixed))} of a {win:,}-tok window) before its first action."
        )
    else:
        total = report.total_tokens
        fixed = report.fixed_tokens
        lines.append(
            f"  ~{total:,} tok total ({_fmt_pct(report.pct(total))} of a {win:,}-tok window)"
            f"   fixed/recurring: ~{fixed:,} tok"
        )

    if report.notes:
        lines.append("")
        lines.append("Notes:")
        lines.extend(f"  - {n}" for n in report.notes)
    return lines
