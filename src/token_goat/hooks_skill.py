"""PostToolUse(Skill) hook: capture loaded-skill bodies to the on-disk cache.

When the agent invokes the Skill tool, Claude Code loads the skill's body
(typically a SKILL.md prose file plus any inlined examples and checklists) into
the conversation as a tool result.  That body is exactly the kind of long-form
protocol content that gets summarised lossily by Claude Code's PreCompact step
— Ralph's DoD gates, /improve's iteration sequence, or any skill's
step-by-step procedure can be partially or fully forgotten after a compaction
event, even though the skill itself remains technically "loaded".

This hook captures the body to ``data_dir() / "skills"`` immediately after
each Skill invocation so the agent can recall the full text later via
``token-goat skill-body NAME`` (cheaper than re-invoking the skill, which
re-triggers any side effects and pollutes the conversation with a fresh
tool-result block).  It also records the name in the session cache so the
compaction manifest's ``### Active Skills`` section can list every skill the
agent has loaded — telling the compaction LLM "these are load-bearing,
preserve them" without re-injecting the entire body.

Behaviour is gated by ``config.toml [skill_preservation]`` and the
``TOKEN_GOAT_SKILL_PRESERVATION`` env override; both default to enabled.
Failures at every step are logged and swallowed — a broken token-goat must
never interrupt the agent's work.
"""
from __future__ import annotations

__all__ = ["post_skill"]

from pathlib import Path

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    get_tool_input,
    record_cached_stat,
    sanitize_log_str,
)
from .util import get_logger

_LOG = get_logger("hooks_skill")

# Smallest skill body worth caching.  Below this size the body is almost
# certainly a confirmation stub ("Skill loaded") rather than the real prose;
# storing it would waste the cache slot without enabling useful recall.
_SKILL_CACHE_MIN_BYTES: int = 256


def _extract_skill_body(payload: HookPayload) -> str:
    """Pull the skill body text from a PostToolUse(Skill) payload.

    Delegates to :func:`hooks_common.extract_tool_response_text` which handles
    all payload shapes (bare string, MCP content array, named-field dict).
    Returns ``""`` when nothing decodable is present — the caller treats an
    empty body as "nothing to cache" and degrades silently.
    """
    from .hooks_common import extract_tool_response_text  # noqa: PLC0415
    return extract_tool_response_text(
        payload,
        text_keys=("output", "text", "body", "content", "response"),
    )


def _resolve_skill_body_path(skill_name: str) -> str:
    """Best-effort lookup of the skill body file on the local filesystem.

    Claude Code skills can live in three shapes:

    * User-installed (no namespace):
      ``~/.claude/skills/<name>/SKILL.md``
    * Plugin-installed, legacy flat layout:
      ``~/.claude/plugins/<plugin>/skills/<name>/SKILL.md``
    * Plugin-installed, marketplace layout (current Claude Code default):
      ``~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md``

    For the plugin-namespaced form ``plugin:skill`` we walk the marketplace
    layout because that is where modern Claude Code installs plugins (the flat
    layout is kept as a fallback for older or hand-installed plugins).  When
    the namespace lookup fails we also try the user-skills directory under the
    bare skill name — some plugin skills surface under a short alias the user
    has hand-installed (or hand-mirrored) at ``~/.claude/skills/<name>``.

    Resolving the on-disk path lets the CLI fall back to reading the source
    file when the cache has been evicted, and lets the manifest cite a stable
    location for the body.  Returns the resolved absolute path as a string
    when a file exists, else an empty string.  Never raises — caller treats
    empty as "no source path".
    """
    if not skill_name:
        return ""

    home = Path.home()
    candidates: list[Path] = []

    if ":" in skill_name:
        plugin, _sep, name = skill_name.partition(":")
        if plugin and name:
            # Legacy flat layout first (cheaper — direct path stat without globbing).
            candidates.append(home / ".claude" / "plugins" / plugin / "skills" / name / "SKILL.md")
            candidates.append(home / ".claude" / "plugins" / plugin / "skills" / name / f"{name}.md")
            # Marketplace layout: ``cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md``.
            # Glob iteratively so a missing intermediate dir aborts early without
            # raising.  We pick the first plugin-dir match by alphabetical version
            # order — newest install path tends to sort last so we walk in reverse.
            cache_root = home / ".claude" / "plugins" / "cache"
            try:
                if cache_root.is_dir():
                    for mkt in cache_root.iterdir():
                        if not mkt.is_dir():
                            continue
                        plugin_dir = mkt / plugin
                        if not plugin_dir.is_dir():
                            continue
                        try:
                            versions = sorted(
                                (v for v in plugin_dir.iterdir() if v.is_dir()),
                                reverse=True,
                            )
                        except OSError:
                            continue
                        for ver in versions:
                            candidates.append(ver / "skills" / name / "SKILL.md")
                            candidates.append(ver / "skills" / name / f"{name}.md")
            except OSError:
                pass
            # Fallback: a user may also have mirrored the plugin skill under the
            # bare name in ``~/.claude/skills/<name>/SKILL.md``.
            candidates.append(home / ".claude" / "skills" / name / "SKILL.md")
            candidates.append(home / ".claude" / "skills" / name / f"{name}.md")
    else:
        candidates.append(home / ".claude" / "skills" / skill_name / "SKILL.md")
        candidates.append(home / ".claude" / "skills" / skill_name / f"{skill_name}.md")

    for p in candidates:
        try:
            if p.is_file():
                return str(p)
        except OSError:
            continue
    return ""


def post_skill(payload: HookPayload) -> HookResponse:
    """PostToolUse(Skill) hook: persist the loaded skill body to disk + session history.

    Always returns CONTINUE — this hook never modifies the tool result.
    Failures at any step are logged and swallowed so a degraded cache or a
    misshapen payload never blocks the agent.
    """
    tool_name = payload.get("tool_name", "")
    if tool_name != "Skill":
        return CONTINUE()

    from . import config as config_mod  # noqa: PLC0415

    cfg = config_mod.load().skill_preservation
    if not cfg.enabled:
        _LOG.debug("post-skill: disabled by config; skipping capture")
        return CONTINUE()

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        _LOG.debug("post-skill: no session_id; skill not cached")
        return CONTINUE()

    tool_input = get_tool_input(payload)
    skill_name_raw = tool_input.get("skill")
    if not isinstance(skill_name_raw, str) or not skill_name_raw:
        _LOG.debug("post-skill: tool_input missing 'skill' field; skipping")
        return CONTINUE()
    skill_name = skill_name_raw.strip()

    body = _extract_skill_body(payload)
    body_size = len(body.encode("utf-8", errors="replace"))
    if body_size < _SKILL_CACHE_MIN_BYTES:
        _LOG.debug(
            "post-skill: body too small to cache (%d bytes < %d threshold); skipping",
            body_size, _SKILL_CACHE_MIN_BYTES,
        )
        return CONTINUE()

    source_path = _resolve_skill_body_path(skill_name)

    from . import session, skill_cache  # noqa: PLC0415

    meta = skill_cache.store_output(
        session_id, skill_name, body,
        source_path=source_path,
        max_total_bytes=cfg.max_cache_bytes,
    )
    if meta is None:
        return CONTINUE()
    skill_cache.write_sidecar(meta)

    # Auto-compact large skill bodies (> 4000 chars ~= 1000 tokens) for fast
    # recall in the PreCompact manifest.  This prevents large skill prose
    # (Ralph's DoD gates, /improve's iteration sequence) from being lossily
    # summarized by the compaction LLM — the compact gives the manifest a
    # concrete key-rules summary to preserve.
    if body_size > 4000:
        try:
            compact_text = skill_cache.generate_compact_summary(body)
            if compact_text:
                skill_cache.store_compact(session_id, skill_name, compact_text)
                _LOG.debug(
                    "post-skill: auto-compact stored for %s (%d chars)",
                    sanitize_log_str(skill_name, max_len=80),
                    len(compact_text),
                )
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("post-skill: auto-compact failed: %s", exc)

    try:
        session.mark_skill_loaded(
            session_id=session_id,
            skill_name=meta.skill_name,
            output_id=meta.output_id,
            content_sha=meta.content_sha,
            body_bytes=meta.body_bytes,
            truncated=meta.truncated,
            source_path=meta.source_path,
        )
    except (ValueError, OSError) as exc:
        _LOG.debug("post-skill: session record failed: %s", exc)

    record_cached_stat("skill_cached", sanitize_log_str(skill_name, max_len=200))

    _LOG.info(
        "post-skill: cached skill name=%s bytes=%d truncated=%s source=%s",
        sanitize_log_str(skill_name, max_len=120),
        body_size,
        meta.truncated,
        sanitize_log_str(source_path, max_len=200) if source_path else "(none)",
    )
    return CONTINUE()
