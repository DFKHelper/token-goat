"""Single source of truth for token-goat hook event registration.

Why this module exists
----------------------
Hook events used to be declared in **five** independent tables:

1. ``install._hooks_block()`` — Claude Code ``settings.json`` wire format.
2. ``install._codex_hooks_block()`` — Codex CLI ``config.toml`` wire format.
3. ``hooks_cli._HANDLER_LOOKUP`` — ``event name → (submodule, attr)`` dispatcher.
4. ``hooks_cli.EVENTS`` — ``event name → lazy proxy callable`` dispatch dict.
5. ``hooks_cli.__getattr__::event_map`` — module-level attribute exports.

Plus the per-event ``@hook_app.command(...)`` decorators in ``cli.py``.

Adding a new event required editing six locations.  Two recent incidents
(``e53d553`` + ``a71092b``) shipped to production with mismatched tables;
``UserPromptSubmit`` / ``PostToolUse:Skill`` are *blocking* events, so when
``settings.json`` fired a hook that ``cli.py`` did not register, Claude Code
exited with "No such command" and aborted the user's operation.

This module is now the canonical definition.  ``install``, ``hooks_cli``, and
``cli`` all derive their tables from :data:`HOOK_EVENTS` via the helpers
exposed here.  The ``@hook_app.command`` decorators stay hand-written
(typer requires decorator-based registration), but ``cli.py`` calls
:func:`assert_typer_subcommands_aligned` after all decorators run — the
package fails to import if any registry event lacks a registered subcommand.
"""
from __future__ import annotations

__all__ = [
    "CANONICAL_TOOLS",
    "HOOK_EVENTS",
    "HookEvent",
    "all_events",
    "assert_typer_subcommands_aligned",
    "claude_events",
    "codex_events",
    "handler_lookup",
    "lazy_attr_map",
    "lookup",
]

from dataclasses import dataclass
from typing import Literal

Harness = Literal["claude", "codex", "both"]

#: Canonical PascalCase tool names that token-goat handlers recognise.
#: This is the single source of truth referenced by:
#:   - ``hooks_cli._TG_KNOWN_TOOLS`` (imports this set)
#:   - the harness-specific tool-name maps in ``hooks_cli`` (Codex, Gemini)
#:   - the embedded ``TOOL_TO_TG`` tables in ``bridges`` (opencode, openclaw)
#:   - ``tests/test_tool_name_registry.py`` (cross-harness consistency check)
#:
#: When adding a new tool: update this set, then update each harness map that
#: should cover it.  The cross-harness tests will fail fast if a map's values
#: reference a name not in this set (typo guard) or if a harness's declared
#: coverage expectation drifts.
CANONICAL_TOOLS: frozenset[str] = frozenset(
    {"Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "WebFetch", "Grep", "Skill"}
)


@dataclass(frozen=True)
class HookEvent:
    """One row of the hook registry.

    Attributes:
        name: Canonical hook event name (e.g. ``"post-skill"``).  Matches the
            CLI subcommand name and the dispatcher key in
            :data:`hooks_cli._HANDLER_LOOKUP`.
        typer_func: Python identifier used by the ``@hook_app.command`` decorator
            in ``cli.py``.  Equal to *name* with hyphens replaced by underscores.
        module: Submodule under ``token_goat`` that hosts the handler function
            (e.g. ``"hooks_skill"`` for ``post-skill``).  Imported lazily on
            first dispatch so the cost is paid only when the event fires.
        attr: Attribute name on *module* that is the actual handler callable.
        claude_event: Top-level ``settings.json`` key for Claude Code
            (e.g. ``"PostToolUse"``), or ``None`` when the event is not exposed
            to Claude (Codex-only).
        claude_matcher: Matcher pattern under that key for Claude Code wire
            format (e.g. ``"Skill"``).  ``"*"`` for unfiltered events.
        claude_timeout_ms: Timeout in milliseconds for the Claude wire format.
        codex_event: Top-level ``config.toml`` key for Codex (subset of Claude
            event names), or ``None`` when the event is not exposed to Codex.
        codex_matcher: Matcher pattern for Codex (e.g. ``"view_image|Bash"``).
        codex_timeout_ms: Timeout in milliseconds for the Codex wire format.
        docstring: One-line description of what the event does, used as the
            ``@hook_app.command`` docstring source-of-truth.
    """

    name: str
    typer_func: str
    module: str
    attr: str
    claude_event: str | None
    claude_matcher: str
    claude_timeout_ms: int
    codex_event: str | None
    codex_matcher: str
    codex_timeout_ms: int
    docstring: str

    @property
    def harness(self) -> Harness:
        """Return which harness wire formats this event applies to."""
        if self.claude_event and self.codex_event:
            return "both"
        if self.codex_event:
            return "codex"
        return "claude"


# Canonical event registry.  Order matters only for stable iteration in tests
# and for stable settings.json diff output — group by Claude top-level event
# (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, SubagentStop,
# PreCompact) for readability.
HOOK_EVENTS: tuple[HookEvent, ...] = (
    HookEvent(
        name="session-start",
        typer_func="session_start",
        module="hooks_session",
        attr="session_start",
        claude_event="SessionStart",
        claude_matcher="*",
        claude_timeout_ms=30000,
        codex_event="SessionStart",
        codex_matcher="*",
        codex_timeout_ms=30000,
        docstring="session-start event.",
    ),
    HookEvent(
        name="pre-read",
        typer_func="pre_read",
        module="hooks_read",
        attr="pre_read",
        claude_event="PreToolUse",
        # Bash → noisy-output compression; Grep/Glob → dedup hint; Read → image shrink + session hint.
        claude_matcher="Read|Grep|Glob|Bash",
        claude_timeout_ms=5000,
        codex_event="PreToolUse",
        codex_matcher="view_image|Bash",
        codex_timeout_ms=5000,
        docstring="pre-read event.",
    ),
    HookEvent(
        name="pre-fetch",
        typer_func="pre_fetch",
        module="hooks_fetch",
        attr="pre_fetch",
        claude_event="PreToolUse",
        claude_matcher="mcp__.*|WebFetch",
        claude_timeout_ms=2000,
        codex_event="PreToolUse",
        codex_matcher="mcp__.*|web_search",
        codex_timeout_ms=2000,
        docstring="pre-fetch event.",
    ),
    HookEvent(
        name="pre-screenshot",
        typer_func="pre_screenshot",
        module="hooks_read",
        attr="pre_screenshot",
        claude_event="PreToolUse",
        claude_matcher=r"mcp__.*take_screenshot$",
        claude_timeout_ms=2000,
        codex_event=None,
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="pre-screenshot event (redirects MCP screenshots without filePath so image-shrink applies).",
    ),
    HookEvent(
        name="post-edit",
        typer_func="post_edit",
        module="hooks_edit",
        attr="post_edit",
        claude_event="PostToolUse",
        claude_matcher="Edit|Write|MultiEdit",
        claude_timeout_ms=2000,
        codex_event="PostToolUse",
        codex_matcher="apply_patch",
        codex_timeout_ms=2000,
        docstring="post-edit event.",
    ),
    HookEvent(
        name="post-read",
        typer_func="post_read",
        module="hooks_read",
        attr="post_read",
        claude_event="PostToolUse",
        claude_matcher="Read|Grep|Glob",
        claude_timeout_ms=2000,
        codex_event=None,  # Codex post-read goes through post-bash + cat detection.
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="post-read event.",
    ),
    HookEvent(
        name="post-bash",
        typer_func="post_bash",
        module="hooks_read",
        attr="post_bash",
        claude_event="PostToolUse",
        claude_matcher="Bash",
        claude_timeout_ms=3000,
        codex_event="PostToolUse",
        codex_matcher="Bash",
        codex_timeout_ms=3000,
        docstring="post-bash event (caches Bash output for dedup + retrieval).",
    ),
    HookEvent(
        name="post-fetch",
        typer_func="post_fetch",
        module="hooks_fetch",
        attr="post_fetch",
        claude_event="PostToolUse",
        claude_matcher="mcp__.*|WebFetch",
        claude_timeout_ms=3000,
        codex_event=None,
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="post-fetch event (caches WebFetch text body for dedup + retrieval; captures MCP results).",
    ),
    HookEvent(
        name="pre-skill",
        typer_func="pre_skill",
        module="hooks_skill",
        attr="pre_skill",
        claude_event="PreToolUse",
        claude_matcher="Skill",
        claude_timeout_ms=3000,
        codex_event=None,  # Codex has no Skill tool.
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="pre-skill event (blocks repeat skill loads; serves compact on first load when curated).",
    ),
    HookEvent(
        name="post-skill",
        typer_func="post_skill",
        module="hooks_skill",
        attr="post_skill",
        claude_event="PostToolUse",
        claude_matcher="Skill",
        claude_timeout_ms=3000,
        codex_event=None,  # Codex has no Skill tool.
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="post-skill event (caches loaded skill bodies for post-compact recall).",
    ),
    HookEvent(
        name="user-prompt-submit",
        typer_func="user_prompt_submit",
        module="hooks_session",
        attr="user_prompt_submit",
        claude_event="UserPromptSubmit",
        claude_matcher="*",
        claude_timeout_ms=5000,
        codex_event=None,  # Codex has no UserPromptSubmit equivalent.
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="user-prompt-submit event.",
    ),
    HookEvent(
        name="subagent-stop",
        typer_func="subagent_stop",
        module="hooks_session",
        attr="subagent_stop",
        claude_event="SubagentStop",
        claude_matcher="*",
        claude_timeout_ms=5000,
        codex_event=None,
        codex_matcher="",
        codex_timeout_ms=0,
        docstring="subagent-stop event.",
    ),
    HookEvent(
        name="pre-compact",
        typer_func="pre_compact",
        module="hooks_cli",  # Handler lives in hooks_cli itself, not a submodule.
        attr="pre_compact",
        claude_event="PreCompact",
        claude_matcher="*",
        claude_timeout_ms=5000,
        codex_event="PreCompact",
        codex_matcher="*",
        codex_timeout_ms=5000,
        docstring="pre-compact event.",
    ),
)

#: Sentinel set returned by ``lazy_attr_map()`` for quick membership tests.
_BY_NAME: dict[str, HookEvent] = {e.name: e for e in HOOK_EVENTS}


def all_events() -> tuple[str, ...]:
    """Return the canonical event names in registration order."""
    return tuple(e.name for e in HOOK_EVENTS)


def claude_events() -> tuple[HookEvent, ...]:
    """Return events that are wired into Claude Code's settings.json."""
    return tuple(e for e in HOOK_EVENTS if e.claude_event)


def codex_events() -> tuple[HookEvent, ...]:
    """Return events that are wired into Codex CLI's config.toml."""
    return tuple(e for e in HOOK_EVENTS if e.codex_event)


def lookup(name: str) -> HookEvent | None:
    """Return the :class:`HookEvent` for *name*, or None when unknown.

    Used by tests and callers that want a single-event view without iterating
    the full registry.
    """
    return _BY_NAME.get(name)


def handler_lookup() -> dict[str, tuple[str, str]]:
    """Build the ``hooks_cli._HANDLER_LOOKUP`` mapping from the registry.

    Returns ``{event_name: (submodule_name, attr_name)}``.  ``pre-compact`` is
    excluded — its handler is defined directly inside ``hooks_cli`` (not a
    submodule), so dispatch resolves through ``EVENTS`` instead of through
    the lazy import path.
    """
    return {
        e.name: (e.module, e.attr)
        for e in HOOK_EVENTS
        if e.module != "hooks_cli"
    }


def lazy_attr_map() -> dict[str, str]:
    """Build the ``hooks_cli.__getattr__::event_map`` from the registry.

    Returns ``{typer_func_name: event_name}`` for every event that lives in a
    submodule (excludes ``pre-compact`` which is already a module attribute).
    """
    return {
        e.typer_func: e.name
        for e in HOOK_EVENTS
        if e.module != "hooks_cli"
    }


def assert_typer_subcommands_aligned(registered_names: set[str]) -> None:
    """Verify that every registry event has a matching ``@hook_app.command``.

    Raises :class:`ImportError` on mismatch so the package fails to import if
    drift exists.  Called from ``cli.py`` immediately after the last
    ``@hook_app.command`` decorator runs.

    Args:
        registered_names: Set of subcommand names actually registered on the
            ``hook_app`` typer instance.  Caller derives this from
            ``hook_app.registered_commands``.

    Raises:
        ImportError: When the registry contains an event name that is not in
            *registered_names*.  Error message includes the missing names and
            the file to edit (``cli.py``) so the fix is obvious.
    """
    expected = set(all_events())
    missing = expected - registered_names
    if missing:
        raise ImportError(
            f"hook_registry drift: event(s) {sorted(missing)} declared in "
            f"hook_registry.HOOK_EVENTS but NOT registered as @hook_app.command "
            f"in cli.py. Add `@hook_app.command(\"<name>\", "
            f"context_settings=_HOOK_CTX)` decorators in cli.py."
        )
