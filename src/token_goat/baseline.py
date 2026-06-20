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

* It does not measure the loaded-skill *body* cost (the full SKILL.md injected when a
  skill is invoked) — ``token-goat doctor`` already covers that; the report points
  there.  The skill *listing* (injected on every session start and subagent spawn) is
  now costed here.
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
import re
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

# Fallback per-skill-entry byte estimate for the listing injected on every session
# start and subagent spawn.  Derived from an audit of the skill listing format:
# 71 tok/entry × 4 bytes/tok ≈ 284 bytes per entry.
_AVG_SKILL_LISTING_ENTRY_BYTES = 284

# Max number of transcript .jsonl files scanned by scan_transcript_usage.
_USAGE_MAX_FILES = 2000


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
        pass
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
    return bool(siblings)


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


def _parse_skill_md_frontmatter(path: Path) -> tuple[str, str]:
    """Return (name, description_first_line) from a SKILL.md YAML frontmatter block.

    Returns ("", "") when the file is absent, unreadable, or has no frontmatter.
    """
    try:
        head = path.read_bytes()[:512].decode("utf-8", errors="replace")
    except OSError:
        return "", ""
    if not head.startswith("---"):
        return "", ""
    name = ""
    desc_first = ""
    in_desc = False
    for line in head.splitlines()[1:]:
        if line.startswith("---"):
            break
        if line.startswith("name:") and not name:
            name = line[5:].strip().strip("\"'")
        elif line.startswith("description:") and not desc_first:
            val = line[12:].strip()
            if val and val != "|":
                desc_first = val[:150]
                in_desc = False
            else:
                in_desc = True
        elif in_desc and line.startswith("  ") and not desc_first:
            desc_first = line.strip()[:150]
            in_desc = False
    return name, desc_first


def _skill_listing_entry_bytes(skill_dir: Path) -> int:
    """Estimate the listing bytes for one skill entry.

    Reads SKILL.md frontmatter for a real name + description length.  Falls back
    to :data:`_AVG_SKILL_LISTING_ENTRY_BYTES` when the file is absent or has no
    parseable description.
    """
    name, desc = _parse_skill_md_frontmatter(skill_dir / "SKILL.md")
    if not name:
        name = skill_dir.name
    if not desc:
        return _AVG_SKILL_LISTING_ENTRY_BYTES
    raw = len(name) + 2 + len(desc)
    return max(4, raw + raw // 3)


def _read_enabled_plugin_names(settings_path: Path) -> list[str]:
    """Return enabled ``plugin@marketplace`` keys from ``settings.json``."""
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return []
    enabled = data.get("enabledPlugins", {})
    if not isinstance(enabled, dict):
        return []
    return [str(k) for k, v in enabled.items() if v]


def _enumerate_plugin_skill_dirs(
    enabled_plugin_names: list[str], marketplaces_root: Path
) -> list[tuple[str, Path]]:
    """Return ``(plugin_slug, skill_dir)`` pairs for all enabled plugins.

    Resolves via ``marketplaces_root/<marketplace>/plugins/<plugin>/skills/``.
    Silently skips any entry that cannot be read.
    """
    results: list[tuple[str, Path]] = []
    for entry in enabled_plugin_names:
        if "@" not in entry:
            continue
        plugin_slug, marketplace = entry.rsplit("@", 1)
        skills_dir = marketplaces_root / marketplace / "plugins" / plugin_slug / "skills"
        with contextlib.suppress(OSError):
            if skills_dir.is_dir():
                results.extend((plugin_slug, d) for d in skills_dir.iterdir() if d.is_dir())
    return results


def _scan_skill_listing(
    rows: list[BaselineRow], notes: list[str], *, skill_usage: dict[str, int] | None = None
) -> None:
    """Cost the skill listing injected on every session start and subagent spawn."""
    user_skills_dir = paths.claude_skills_dir()
    user_skill_dirs: list[Path] = []
    with contextlib.suppress(OSError):
        if user_skills_dir.is_dir():
            user_skill_dirs = [d for d in user_skills_dir.iterdir() if d.is_dir()]
    settings_path = paths.claude_config_dir() / "settings.json"
    enabled_plugins = _read_enabled_plugin_names(settings_path)
    marketplaces_root = paths.claude_plugins_dir() / "marketplaces"
    plugin_skill_entries = _enumerate_plugin_skill_dirs(enabled_plugins, marketplaces_root)
    total_skill_dirs = user_skill_dirs + [d for _, d in plugin_skill_entries]
    if not total_skill_dirs:
        notes.append(
            "Skill listing: no skill dirs found (empty skills dir and no enabled plugin skills)."
        )
        return
    total_bytes = sum(_skill_listing_entry_bytes(d) for d in total_skill_dirs)
    total_tokens = total_bytes // 4
    n_user = len(user_skill_dirs)
    n_plugin = len(plugin_skill_entries)
    detail_parts = [
        f"{n_user} user + {n_plugin} plugin skills",
        "re-pays on every session start and subagent spawn",
    ]
    if skill_usage is not None:
        all_names = {d.name for d in total_skill_dirs}
        ever_used = sum(1 for name in all_names if skill_usage.get(name, 0) > 0)
        zero_use = sorted(name for name in all_names if skill_usage.get(name, 0) == 0)
        detail_parts.append(f"{ever_used}/{len(all_names)} skills ever called")
        if zero_use:
            preview = ", ".join(zero_use[:5])
            suffix = f" + {len(zero_use) - 5} more" if len(zero_use) > 5 else ""
            detail_parts.append(f"zero-use: {preview}{suffix}")
    rows.append(
        BaselineRow(
            source=f"Skill listing ({len(total_skill_dirs)} skills)",
            n_bytes=total_bytes,
            tokens=total_tokens,
            owner="you",
            fix="archive-unused",
            kind="fixed",
            detail="; ".join(detail_parts),
        )
    )


def _normalize_server_name(name: str) -> str:
    """Normalize an MCP server name to lowercase alphanum+underscore for fuzzy matching."""
    return re.sub(r"[^a-z0-9]", "_", name.lower())


def _mcp_call_count(server_name: str, mcp_counts: dict[str, int]) -> int:
    """Exact call count for *server_name* matched against transcript tool-name prefixes.

    Normalizes both sides with :func:`_normalize_server_name` so punctuation and
    casing differences (e.g. "claude.ai Vercel" vs "claude_ai_Vercel") resolve to
    the same key without the false-positive risk of substring matching.
    """
    norm = _normalize_server_name(server_name)
    return sum(
        count for key, count in mcp_counts.items() if _normalize_server_name(key) == norm
    )


def _tally_tool_calls(
    line: str, skill_counts: dict[str, int], mcp_counts: dict[str, int]
) -> None:
    """Parse one JSONL transcript line and tally Skill and MCP tool calls in-place."""
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return
    if not isinstance(obj, dict):
        return
    msg = obj.get("message", obj)
    if not isinstance(msg, dict):
        return
    content = msg.get("content", [])
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = block.get("name", "")
        if not isinstance(name, str):
            continue
        if name == "Skill":
            inp = block.get("input", {})
            if isinstance(inp, dict):
                skill = inp.get("skill", "")
                if skill and isinstance(skill, str):
                    skill_counts[skill] = skill_counts.get(skill, 0) + 1
        elif name.startswith("mcp__"):
            parts = name.split("__", 2)
            if len(parts) >= 2:
                server = parts[1]
                mcp_counts[server] = mcp_counts.get(server, 0) + 1


def scan_transcript_usage(
    projects_root: Path | None = None,
    *,
    max_files: int = _USAGE_MAX_FILES,
) -> tuple[dict[str, int], dict[str, int]]:
    """Stream project transcripts and tally Skill and MCP tool calls.

    Returns ``({skill_name: call_count}, {mcp_server_prefix: call_count})``.
    Reads the *max_files* most-recently-modified ``.jsonl`` files under
    *projects_root* (defaults to :func:`~token_goat.paths.claude_projects_dir`).
    Never raises.

    Note: discovery (``rglob("*.jsonl")``) scales with the total number of transcript
    files on disk before the cap is applied. On heavily-used installs this may take a
    moment; the cap only bounds parsing, not file enumeration.
    """
    root = projects_root if projects_root is not None else paths.claude_projects_dir()
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    try:
        jsonl_files = sorted(
            (p for p in root.rglob("*.jsonl")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:max_files]
    except OSError:
        return skill_counts, mcp_counts
    for jsonl_path in jsonl_files:
        try:
            with open(jsonl_path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"Skill"' not in line and '"mcp__' not in line:
                        continue
                    _tally_tool_calls(line, skill_counts, mcp_counts)
        except OSError:
            continue
    return skill_counts, mcp_counts


def _scan_mcp(cwd: Path, rows: list[BaselineRow], notes: list[str], *, mcp_usage: dict[str, int] | None = None) -> None:
    """Enumerate configured MCP servers — one 0-token row per server.

    The instruction block each server injects lives on the server, not on disk, so
    it cannot be costed from local files.  We emit a visible 0-token row per server
    so each appears as a removable line item.  With ``--usage`` the row's detail also
    reports historical call count so zero-use servers stand out as removal candidates.
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
    for server in unique:
        detail_parts: list[str] = [
            "schema not costed (lives on the server); re-pays on every subagent spawn"
        ]
        if mcp_usage is not None:
            calls = _mcp_call_count(server, mcp_usage)
            if calls == 0:
                detail_parts.append("0 calls ever — removal candidate")
            else:
                detail_parts.append(f"{calls:,} calls ever")
        rows.append(
            BaselineRow(
                source=f"MCP: {server}",
                n_bytes=0,
                tokens=0,
                owner="harness",
                fix="disable-mcp",
                kind="fixed",
                detail="; ".join(detail_parts),
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
    usage: bool = False,
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
        usage: When ``True``, stream project transcripts to annotate rows with
            historical call counts and flag zero-use skills / MCP servers.

    Returns:
        A populated :class:`BaselineReport`.  Never raises for ordinary
        filesystem problems.
    """
    rows: list[BaselineRow] = []
    notes: list[str] = []
    sid, tool_results = _resolve_session(session_id)

    skill_usage: dict[str, int] | None = None
    mcp_usage: dict[str, int] | None = None
    if usage:
        skill_usage, mcp_usage = scan_transcript_usage()

    _scan_hook_dumps(tool_results, rows, notes)
    _scan_claude_md(cwd, rows, notes)
    _scan_memory_md(tool_results, cwd, rows, notes)
    _scan_skill_listing(rows, notes, skill_usage=skill_usage)
    _scan_mcp(cwd, rows, notes, mcp_usage=mcp_usage)

    rows.sort(key=lambda r: r.tokens, reverse=True)
    notes.append(
        "Loaded-skill body cost: run `token-goat doctor` "
        "(skills invoked in a session load their full SKILL.md separately)."
    )
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
    selected = [r for r in report.rows if r.kind == "fixed"] if subagent else report.rows
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
        lines.extend(
            f"  {r.tokens:>8,}  {_fmt_pct(r.pct_of(win)):>5}  "
            f"{r.owner:<16}{r.fix:<14}{r.source}"
            + (f"  [{r.detail}]" if r.detail else "")
            for r in selected
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
