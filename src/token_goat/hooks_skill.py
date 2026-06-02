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

# Hard upper bound on skill body size accepted for caching.  Bodies larger
# than this are truncated by skill_cache.store_output (cap = 256 KB), but
# encoding a multi-MB string to UTF-8 bytes twice — once here for the size
# check and once inside store_output — wastes CPU in a hook that must be
# fast.  We take only the first _SKILL_CACHE_MAX_CHARS characters and let
# store_output do the byte-precise tail-preserve truncation from there.
# 2 MB of characters covers all realistic skill bodies (the largest known
# skill, ralph, is ~30 KB) and ensures the hook never stalls on a runaway
# tool response.
_SKILL_CACHE_MAX_CHARS: int = 2 * 1024 * 1024  # 2 MB character cap


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


def _record_skill_compact_stat(skill_name: str, bytes_saved: int, tokens_saved: int) -> None:
    """Record a ``skill_compact_served`` savings row in the stats DB.

    Fires whenever a compact form is stored for a skill body (either via
    explicit ``<!-- COMPACT_END -->`` marker or auto-extraction).  The savings
    represent the token reduction from serving the compact form in the
    PreCompact manifest instead of the full body.  Failures are logged and
    swallowed — a broken stats DB must never abort the hook.
    """
    try:
        from . import db as _db  # noqa: PLC0415

        _db.record_stat(
            None,
            "skill_compact_served",
            bytes_saved=bytes_saved,
            tokens_saved=tokens_saved,
            detail=sanitize_log_str(skill_name, max_len=200),
        )
    except Exception:  # noqa: BLE001
        _LOG.debug("post-skill: skill_compact_served stat record failed", exc_info=True)


def post_skill(payload: HookPayload) -> HookResponse:
    """PostToolUse(Skill) hook: persist the loaded skill body to disk + session history.

    Always returns CONTINUE — this hook never modifies the tool result.
    Failures at any step are logged and swallowed so a degraded cache or a
    misshapen payload never blocks the agent.
    """
    if not isinstance(payload, dict):
        _LOG.debug("post-skill: non-dict payload (type=%s); skipping", type(payload).__name__)
        return CONTINUE()
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
        _LOG.debug(
            "post-skill: tool_input 'skill' field missing or non-string (type=%s); skipping",
            type(skill_name_raw).__name__,
        )
        return CONTINUE()
    # Normalize: strip whitespace, strip any leading path components (e.g.
    # "~/.claude/skills/ralph" → "ralph"), and lowercase so cache lookups are
    # consistent across invocations regardless of how the skill was referenced.
    skill_name_stripped = skill_name_raw.strip()
    # Strip path separators: if the name contains slashes or backslashes, take
    # only the last component (and strip a trailing .md suffix if present).
    import os as _os  # noqa: PLC0415
    if "/" in skill_name_stripped or _os.sep in skill_name_stripped:
        skill_name_stripped = skill_name_stripped.replace("\\", "/").split("/")[-1]
    if skill_name_stripped.lower().endswith(".md"):
        skill_name_stripped = skill_name_stripped[:-3]
    skill_name = skill_name_stripped.lower() if skill_name_stripped else skill_name_raw.strip()
    # Guard: if the name is empty after all normalization (e.g. input was "/" or
    # "/.md"), there is nothing safe to cache.  Log and bail rather than letting
    # the downstream name-validation in skill_cache.store_output reject it
    # silently after we have already extracted the body.
    if not skill_name:
        _LOG.debug("post-skill: skill name empty after normalization (raw=%r); skipping",
                   sanitize_log_str(skill_name_raw, max_len=120))
        return CONTINUE()

    body = _extract_skill_body(payload)
    # Pre-cap runaway bodies before the byte-count: encoding a multi-MB string
    # twice (here + inside store_output) wastes hook latency.  Store_output
    # handles byte-precise tail-preserve truncation from the capped string.
    if len(body) > _SKILL_CACHE_MAX_CHARS:
        _LOG.debug(
            "post-skill: body exceeds max chars cap (%d chars > %d); pre-truncating",
            len(body), _SKILL_CACHE_MAX_CHARS,
        )
        body = body[-_SKILL_CACHE_MAX_CHARS:]  # keep tail (most useful content)
    body_size = len(body.encode("utf-8", errors="replace"))
    if body_size < _SKILL_CACHE_MIN_BYTES:
        _LOG.debug(
            "post-skill: body too small to cache (%d bytes < %d threshold); skipping",
            body_size, _SKILL_CACHE_MIN_BYTES,
        )
        return CONTINUE()

    source_path = _resolve_skill_body_path(skill_name)

    from . import session, skill_cache  # noqa: PLC0415

    # Check whether this skill was already loaded in this session.  When it was,
    # the body is already in context (from the earlier Skill tool result) and the
    # compaction manifest already lists it.  Emit a systemMessage so the model
    # knows it can use the cached body via ``token-goat skill-body`` rather than
    # treating this as a fresh first load.
    prior_entry = session.lookup_skill_entry(session_id, skill_name)
    if prior_entry is not None:
        run_count = getattr(prior_entry, "run_count", 1)
        body_tokens = body_size // 4  # rough estimate: 4 chars/token
        reload_msg = (
            f"Note: skill '{skill_name}' was already loaded in this session "
            f"({run_count}x prior). Its body ({body_tokens} tokens) is already "
            f"in context — you do not need to re-read it. "
            f"Recall the cached body: `token-goat skill-body {skill_name}`. "
            f"Recall a specific section: `token-goat skill-section {skill_name} <heading>`."
        )
        _LOG.info(
            "post-skill: duplicate load for skill %s (run_count=%d); emitting reload hint",
            sanitize_log_str(skill_name, max_len=80), run_count,
        )
        resp = CONTINUE()
        resp["systemMessage"] = reload_msg
        return resp

    meta = skill_cache.store_output(
        session_id, skill_name, body,
        source_path=source_path,
        max_total_bytes=cfg.max_cache_bytes,
    )
    if meta is None:
        return CONTINUE()
    skill_cache.write_sidecar(meta)

    # Compact large skill bodies (> 4000 chars ~= 1000 tokens) for fast recall
    # in the PreCompact manifest.  Two strategies are tried in order:
    #
    # 1. Explicit marker: if the body contains ``<!-- COMPACT_END -->`` on its
    #    own line, everything above the marker is the author-curated compact
    #    section.  This is preferred because it is deterministic and reflects
    #    deliberate authorial intent.
    #
    # 2. Auto-extraction: when no marker is present, ``generate_compact_summary``
    #    heuristically extracts headings, CRITICAL/MUST/NEVER/RULE lines, and
    #    bold directives.  This is the pre-existing behaviour (iter 71/72).
    #
    # Either result is stored via ``store_compact`` and served by the manifest
    # renderer without any change to the downstream contract.
    system_message: str | None = None
    if body_size > 4000:
        try:
            marker_compact = skill_cache.extract_compact_from_marker(body)
            if marker_compact is not None:
                skill_cache.store_compact(session_id, skill_name, marker_compact)
                compact_bytes = len(marker_compact.encode("utf-8", errors="replace"))
                compact_tokens = compact_bytes // 4  # rough estimate: 4 bytes/token
                total_tokens = body_size // 4
                _LOG.debug(
                    "post-skill: compact stored for %s via explicit marker (%d chars)",
                    sanitize_log_str(skill_name, max_len=80),
                    len(marker_compact),
                )
                # Record tokens saved = full body − compact (serving compact saves
                # this many tokens per manifest emission vs re-reading the full body).
                _saved_bytes = max(0, body_size - compact_bytes)
                _saved_tokens = max(0, total_tokens - compact_tokens)
                _record_skill_compact_stat(skill_name, _saved_bytes, _saved_tokens)
                system_message = (
                    f"Skill '{skill_name}' has explicit compact section"
                    f" ({compact_tokens} tokens above marker vs {total_tokens} total)."
                    f" Detail at: token-goat skill-section {skill_name} <heading>."
                )
            else:
                compact_text = skill_cache.generate_compact_summary(body)
                if compact_text:
                    # Apply the configurable truncation_budget_tokens cap so that
                    # skills without an explicit COMPACT_END marker don't inject
                    # oversized compacts into the manifest.  4 chars ≈ 1 token.
                    try:
                        from .config import load as _load_cfg  # noqa: PLC0415
                        _cfg_budget = _load_cfg().skill_preservation.truncation_budget_tokens
                    except Exception:  # noqa: BLE001
                        _cfg_budget = 800
                    if _cfg_budget > 0:
                        _budget_chars = _cfg_budget * 4
                        if len(compact_text) > _budget_chars:
                            _cut = compact_text.rfind("\n", 0, _budget_chars)
                            if _cut <= 0:
                                _cut = _budget_chars
                            compact_text = compact_text[:_cut].rstrip() + "…"
                            _LOG.debug(
                                "post-skill: compact for %s truncated to budget (%d tokens)",
                                sanitize_log_str(skill_name, max_len=80),
                                _cfg_budget,
                            )
                    skill_cache.store_compact(session_id, skill_name, compact_text)
                    _compact_bytes = len(compact_text.encode("utf-8", errors="replace"))
                    _compact_tokens = _compact_bytes // 4
                    _full_tokens = body_size // 4
                    _record_skill_compact_stat(
                        skill_name,
                        max(0, body_size - _compact_bytes),
                        max(0, _full_tokens - _compact_tokens),
                    )
                    _LOG.debug(
                        "post-skill: compact stored for %s via auto-extraction (%d chars)",
                        sanitize_log_str(skill_name, max_len=80),
                        len(compact_text),
                    )
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("post-skill: compact failed: %s", exc)

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
    if system_message:
        resp = CONTINUE()
        resp["systemMessage"] = system_message
        return resp
    return CONTINUE()
