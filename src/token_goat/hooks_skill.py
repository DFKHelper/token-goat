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

__all__ = ["pre_skill", "post_skill"]

from pathlib import Path

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    deny_redirect,
    get_hook_context,
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
        # Nested subdir layout: ``skills/<name>/<name>/SKILL.md``
        # Some Claude Code skill packages use a double-directory layout where
        # the skill files live one level deeper (e.g.
        # ``skills/brainstorming/brainstorming/SKILL.md``).
        candidates.append(
            home / ".claude" / "skills" / skill_name / skill_name / "SKILL.md"
        )

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


def _normalize_skill_name(raw: str) -> str:
    """Normalize a raw skill name from tool_input to a consistent cache key.

    Mirrors the normalization in ``post_skill``: strip whitespace, take the last
    path component when slashes are present, strip a trailing ``.md`` suffix, and
    lowercase the result.  Returns ``""`` when the result is empty after all
    steps so callers can bail early on an unusable name.
    """
    stripped = raw.strip()
    if "/" in stripped or "\\" in stripped:
        stripped = stripped.replace("\\", "/").split("/")[-1]
    if stripped.lower().endswith(".md"):
        stripped = stripped[:-3]
    return stripped.lower() if stripped else ""


def _compaction_occurred_after(session_id: str, skill_ts: float) -> bool:
    """Return ``True`` when a compaction event fired more recently than *skill_ts*.

    Uses the mtime of the manifest-SHA sidecar as a proxy for the most recent
    compaction.  When the sidecar does not exist (no compaction yet this
    session) returns ``False``.  Failures are caught and return ``False`` so
    a broken path lookup never accidentally blocks a reload.
    """
    try:
        from . import paths  # noqa: PLC0415

        sidecar = paths.manifest_sha_sidecar_path(session_id)
        if not sidecar.exists():
            return False
        return sidecar.stat().st_mtime > skill_ts
    except Exception:  # noqa: BLE001
        return False


def _read_first_load_compact(skill_name: str) -> str | None:
    """Try to extract a compact form from the skill file on disk for first-load serving.

    Resolves the skill body path, reads the file, and applies
    :func:`skill_cache.extract_compact_from_marker`.  Returns ``None`` when the
    file cannot be found, the file cannot be read, or it has no
    ``<!-- COMPACT_END -->`` marker.  Failures are caught and return ``None``
    so the caller falls through to a normal full-body load.

    The compact is NOT stored here — that is still done by ``post_skill`` after
    the PostToolUse event fires.  We read it inline so the pre-skill hook can
    serve it without waiting for the post-hook round-trip.
    """
    path = _resolve_skill_body_path(skill_name)
    if not path:
        return None
    try:
        body = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    from . import skill_cache  # noqa: PLC0415

    return skill_cache.extract_compact_from_marker(body)


def pre_skill(payload: HookPayload) -> HookResponse:
    """PreToolUse(Skill) hook: block repeat loads; serve compact on first load when curated.

    Two interception modes:

    **Repeat-load dedup (always on, gated by pre_skill_enabled):**
    When the same skill has already been loaded in this session and no
    compaction has fired since (which would evict it from context), the
    full re-load is blocked.  The cached compact is injected via
    ``additionalContext`` so the model has the operative rules without the
    full body cost.  Falls back to a recall-pointer-only message when no
    compact is available.

    **First-load compact (opt-in, gated by first_load_compact):**
    When the skill has never been loaded this session AND the skill file on
    disk contains a ``<!-- COMPACT_END -->`` marker AND ``first_load_compact``
    is ``True`` in config, the first load is also blocked and the curated
    compact section is served instead.  The full body remains accessible via
    ``token-goat skill-body <name> --section <heading>``.

    Always returns CONTINUE on any exception — a broken pre_skill must never
    interrupt the agent's work.
    """
    if not isinstance(payload, dict):
        return CONTINUE()

    tool_name = payload.get("tool_name", "")
    if tool_name != "Skill":
        return CONTINUE()

    from . import config as config_mod  # noqa: PLC0415

    cfg = config_mod.load().skill_preservation
    if not cfg.enabled or not cfg.pre_skill_enabled:
        return CONTINUE()

    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return CONTINUE()

    tool_input = get_tool_input(payload)
    skill_name_raw = (
        tool_input.get("skill")
        or tool_input.get("skillName")
        or tool_input.get("name")
    )
    if not isinstance(skill_name_raw, str) or not skill_name_raw:
        return CONTINUE()

    skill_name = _normalize_skill_name(skill_name_raw)
    if not skill_name:
        return CONTINUE()

    from . import session, skill_cache  # noqa: PLC0415

    prior_entry = session.lookup_skill_entry(session_id, skill_name)

    # -----------------------------------------------------------------------
    # Repeat-load branch: skill was loaded before in this session.
    # Block re-injection unless a compaction may have evicted it from context.
    # -----------------------------------------------------------------------
    if prior_entry is not None:
        skill_ts = prior_entry.ts
        if _compaction_occurred_after(session_id, skill_ts):
            # Compaction may have evicted the body; allow the reload.
            _LOG.debug(
                "pre-skill: compaction detected after skill load (skill=%s ts=%.0f); allowing reload",
                sanitize_log_str(skill_name, max_len=80),
                skill_ts,
            )
            return CONTINUE()

        run_count = prior_entry.run_count
        body_tokens = prior_entry.body_bytes // 4  # rough: 4 bytes/token
        compact_text = skill_cache.get_compact(session_id, skill_name)

        if compact_text:
            compact_tokens = len(compact_text.encode("utf-8", errors="replace")) // 4
            context = (
                f"Skill **{skill_name}** is already in context from this session "
                f"({run_count}× loaded, ~{body_tokens} tokens). "
                f"Re-loading blocked to save {body_tokens - compact_tokens} tokens.\n\n"
                f"**Compact operative summary** (~{compact_tokens} tokens):\n\n"
                f"{compact_text}\n\n"
                f"Full sections: `token-goat skill-body {skill_name} --section <heading>`"
            )
            _LOG.info(
                "pre-skill: blocked repeat load of %s (run_count=%d); served compact (%d tokens)",
                sanitize_log_str(skill_name, max_len=80),
                run_count,
                compact_tokens,
            )
        else:
            context = (
                f"Skill **{skill_name}** is already in context from this session "
                f"({run_count}× loaded, ~{body_tokens} tokens). "
                f"Re-loading blocked — its instructions are still active.\n\n"
                f"Recall the cached body: `token-goat skill-body {skill_name}`\n"
                f"Recall a specific section: `token-goat skill-body {skill_name} --section <heading>`"
            )
            _LOG.info(
                "pre-skill: blocked repeat load of %s (run_count=%d); no compact cached",
                sanitize_log_str(skill_name, max_len=80),
                run_count,
            )

        return deny_redirect(
            reason=f"Skill '{skill_name}' already loaded in this session (run {run_count}×); re-injection skipped",
            context=context,
        )

    # -----------------------------------------------------------------------
    # First-load compact branch: opt-in; requires COMPACT_END marker in file.
    # -----------------------------------------------------------------------
    if cfg.first_load_compact:
        compact_text = _read_first_load_compact(skill_name)
        if compact_text:
            compact_tokens = len(compact_text.encode("utf-8", errors="replace")) // 4
            context = (
                f"Skill **{skill_name}** has a curated compact section "
                f"(~{compact_tokens} tokens). "
                f"Serving compact on first load (`first_load_compact` is enabled).\n\n"
                f"**Compact operative summary**:\n\n"
                f"{compact_text}\n\n"
                f"Full skill body: `token-goat skill-body {skill_name}`\n"
                f"Specific section: `token-goat skill-body {skill_name} --section <heading>`"
            )
            _LOG.info(
                "pre-skill: first-load compact served for %s (~%d tokens)",
                sanitize_log_str(skill_name, max_len=80),
                compact_tokens,
            )
            return deny_redirect(
                reason=f"Skill '{skill_name}' first load: compact section served (full body available via skill-body)",
                context=context,
            )
        _LOG.debug(
            "pre-skill: first_load_compact enabled but no COMPACT_END marker found for %s; allowing full load",
            sanitize_log_str(skill_name, max_len=80),
        )

    return CONTINUE()


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

    session_id, _cwd = get_hook_context(payload)
    if session_id is None:
        return CONTINUE()

    tool_input = get_tool_input(payload)
    # Claude Code sends the skill name in tool_input["skill"] (snake_case).
    # Guard against alternative field names that may appear in future Claude Code
    # versions or third-party harnesses (e.g. "skillName" camelCase, "name").
    skill_name_raw = (
        tool_input.get("skill")
        or tool_input.get("skillName")
        or tool_input.get("name")
    )
    if not isinstance(skill_name_raw, str) or not skill_name_raw:
        _LOG.debug(
            "post-skill: tool_input skill field missing or non-string "
            "(tried 'skill', 'skillName', 'name'; type=%s); skipping",
            type(skill_name_raw).__name__,
        )
        return CONTINUE()
    skill_name = _normalize_skill_name(skill_name_raw)
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
                skill_cache.store_compact(session_id, skill_name, marker_compact, source_sha=meta.content_sha)
                compact_bytes = len(marker_compact.encode("utf-8", errors="replace"))
                compact_tokens = compact_bytes // 4  # rough estimate: 4 bytes/token
                total_tokens = body_size // 4
                _LOG.debug(
                    "post-skill: compact stored for %s via explicit marker (%d chars)",
                    sanitize_log_str(skill_name, max_len=80),
                    len(marker_compact),
                )
                # Warn when the explicit compact slice exceeds the configured
                # truncation_budget_tokens so skill authors know the COMPACT_END
                # marker is placed too late in the file.
                try:
                    from .config import load as _load_cfg  # noqa: PLC0415
                    _budget = _load_cfg().skill_preservation.truncation_budget_tokens
                    if _budget > 0 and compact_tokens > _budget:
                        import sys as _sys  # noqa: PLC0415
                        _sys.stderr.write(
                            f"token-goat warning: skill '{sanitize_log_str(skill_name, max_len=80)}'"
                            f" compact slice is {compact_tokens} tokens"
                            f" (budget: {_budget} tokens)."
                            f" Move <!-- COMPACT_END --> earlier in the file.\n"
                        )
                        _LOG.warning(
                            "post-skill: compact for %s exceeds budget (%d > %d tokens)",
                            sanitize_log_str(skill_name, max_len=80),
                            compact_tokens,
                            _budget,
                        )
                except Exception:  # noqa: BLE001
                    pass
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
                # Warn when a large body has no COMPACT_END marker.  Large skills
                # without an explicit marker force the auto-extractor to guess the
                # compact section, which is less accurate and may miss load-bearing
                # content.  The threshold of 32 KB (32_768 bytes) is chosen to
                # flag skills comparable to ralph (~30 KB) while leaving small
                # helper skills quiet.
                _LARGE_BODY_WARN_BYTES: int = 32_768
                if body_size >= _LARGE_BODY_WARN_BYTES:
                    import sys as _sys  # noqa: PLC0415
                    _sys.stderr.write(
                        f"token-goat warning: skill '{sanitize_log_str(skill_name, max_len=80)}'"
                        f" body is {body_size // 1024} KB but has no <!-- COMPACT_END --> marker."
                        f" Add the marker after the section the agent needs most to improve"
                        f" context savings accuracy.\n"
                    )
                    _LOG.warning(
                        "post-skill: large skill body (%d bytes) without COMPACT_END marker: %s",
                        body_size,
                        sanitize_log_str(skill_name, max_len=80),
                    )
                compact_text = skill_cache.generate_compact_summary(body)
                if compact_text:
                    # Apply the configurable truncation_budget_tokens cap so that
                    # skills without an explicit COMPACT_END marker don't inject
                    # oversized compacts into the manifest.  4 chars ≈ 1 token.
                    # Cut at a markdown heading or paragraph boundary so the stored
                    # compact ends at a coherent structural point rather than
                    # mid-sentence (uses find_markdown_boundary from cache_common).
                    try:
                        from .config import load as _load_cfg  # noqa: PLC0415
                        _cfg_budget = _load_cfg().skill_preservation.truncation_budget_tokens
                    except Exception:  # noqa: BLE001
                        _cfg_budget = 800
                    if _cfg_budget > 0:
                        _budget_chars = _cfg_budget * 4
                        if len(compact_text) > _budget_chars:
                            from .cache_common import (
                                find_markdown_boundary as _fmb,  # noqa: PLC0415
                            )
                            _cut = _fmb(compact_text, _budget_chars)
                            if _cut <= 0:
                                _cut = _budget_chars
                            compact_text = compact_text[:_cut].rstrip() + "…"
                            _LOG.debug(
                                "post-skill: compact for %s truncated to budget (%d tokens)"
                                " at markdown boundary",
                                sanitize_log_str(skill_name, max_len=80),
                                _cfg_budget,
                            )
                    skill_cache.store_compact(session_id, skill_name, compact_text, source_sha=meta.content_sha)
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

    record_cached_stat("skill_cached", sanitize_log_str(skill_name, max_len=200), bytes_saved=body_size)

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
