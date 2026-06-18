"""Config loader/saver for token-goat. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

__all__ = [
    "BashCompressConfig",
    "CodeCompressConfig",
    "CompactAssistConfig",
    "CompressionConfig",
    "Config",
    "ContextConfig",
    "CuratorConfig",
    "HintBudgetConfig",
    "HintsConfig",
    "HooksConfig",
    "ImageShrinkConfig",
    "InjectionConfig",
    "IndexingConfig",
    "OverflowGuardConfig",
    "RepomapConfig",
    "SessionBriefConfig",
    "SkillPreservationConfig",
    "StatsConfig",
    "WebFetchConfig",
    "WorkerConfig",
    "WORKER_MAX_POOL_CEILING",
    "CONFIG_SCHEMA_VERSION",
    "load",
    "save",
]

import os
import tomllib
from dataclasses import dataclass, field
from typing import Any, Final, TypedDict, cast

from . import paths
from .util import get_logger

_LOG = get_logger("config")

# Process-level config cache: (Config, mtime, env_fingerprint) or None.
# Keyed by (config_file_mtime, env_fingerprint) — invalidates on file edits
# AND env-var changes (common in tests that monkeypatch TOKEN_GOAT_*).
_config_mtime_cache: tuple[Config, float, str] | None = None


def _config_env_fingerprint() -> str:
    """Return a string encoding all TOKEN_GOAT_* (and TOKENWISE_COMPACT_ASSIST) env var values.

    Used as a secondary cache key so that test monkeypatching (or a user exporting
    TOKEN_GOAT_* between hook calls) busts the process-level cache without requiring
    a file-system change. Auto-picks up new TOKEN_GOAT_* vars without a static list.
    """
    parts = [f"{key}={val}" for key, val in os.environ.items() if key.startswith("TOKEN_GOAT_") or key == "TOKENWISE_COMPACT_ASSIST"]
    return "|".join(sorted(parts))

_ENV_COMPACT_ASSIST: Final[str] = "TOKEN_GOAT_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable
_ENV_COMPACT_ASSIST_LEGACY: Final[str] = "TOKENWISE_COMPACT_ASSIST"  # backward-compat alias
_ENV_BASH_COMPRESS: Final[str] = "TOKEN_GOAT_BASH_COMPRESS"  # set to "0"/"false"/"no"/"off" to disable
_ENV_SESSION_BRIEF: Final[str] = "TOKEN_GOAT_SESSION_BRIEF"  # set to "0"/"false"/"no"/"off" to disable
_ENV_SKILL_PRESERVATION: Final[str] = "TOKEN_GOAT_SKILL_PRESERVATION"  # set to "0"/"false"/"no"/"off" to disable
_ENV_PREFER_AVIF: Final[str] = "TOKEN_GOAT_PREFER_AVIF"  # set to "0"/"false"/"no"/"off" to force JPEG/WebP
_ENV_ORPHAN_SWEEP: Final[str] = "TOKEN_GOAT_ORPHAN_SWEEP"  # set to "0"/"false"/"no"/"off" to disable
_ENV_CURATOR: Final[str] = "TOKEN_GOAT_CURATOR"  # set to "0"/"false"/"no"/"off" to disable
_ENV_HINT_BUDGET: Final[str] = "TOKEN_GOAT_HINT_BUDGET"  # set to "0"/"false"/"no"/"off" to disable
_ENV_HINT_JSON_SIDECAR: Final[str] = "TOKEN_GOAT_HINT_JSON_SIDECAR"  # set to "1"/"true"/"yes"/"on" to enable
_ENV_BASH_DEDUP_MIN_BYTES: Final[str] = "TOKEN_GOAT_BASH_DEDUP_MIN_BYTES"  # integer override (bytes)
_ENV_WEB_DEDUP_MIN_BYTES: Final[str] = "TOKEN_GOAT_WEB_DEDUP_MIN_BYTES"  # integer override (bytes)
_ENV_GREP_DEDUP_MIN_MATCHES: Final[str] = "TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES"  # integer override (result count)
_ENV_LARGE_READ_BYTES: Final[str] = "TOKEN_GOAT_LARGE_READ_BYTES"  # integer override (bytes); 0 disables the large-read redirect
_ENV_BASELINE_BUDGET_TOKENS: Final[str] = "TOKEN_GOAT_BASELINE_BUDGET_TOKENS"  # integer override (tokens); 0 disables the session-start baseline advisory
_ENV_REPOMAP_COMPACT_THRESHOLD: Final[str] = "TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"  # integer override
_ENV_WEB_CACHE_MAX_FILES: Final[str] = "TOKEN_GOAT_WEB_CACHE_MAX_FILES"  # integer override (file count)
_ENV_WEB_CACHE_MAX_BYTES: Final[str] = "TOKEN_GOAT_WEB_CACHE_MAX_BYTES"  # integer override (bytes)
_ENV_WEB_COMPRESS: Final[str] = "TOKEN_GOAT_WEB_COMPRESS"  # set to "0"/"false"/"no"/"off" to disable body gzip
_ENV_BASH_CACHE_MIN_BYTES: Final[str] = "TOKEN_GOAT_BASH_CACHE_MIN_BYTES"  # integer override (min bytes to cache)
_ENV_BASH_CACHE_MAX_FILES: Final[str] = "TOKEN_GOAT_BASH_CACHE_MAX_FILES"  # integer override (file count)
_ENV_BASH_CACHE_MAX_BYTES: Final[str] = "TOKEN_GOAT_BASH_CACHE_MAX_BYTES"  # integer override (total bytes)
_ENV_BASH_CACHE_MAX_BYTES_PER_OUTPUT: Final[str] = "TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT"  # integer override (max per single output)
_ENV_WORKER_WATCHDOG: Final[str] = "TOKEN_GOAT_WORKER_WATCHDOG"  # set to "0"/"false"/"no"/"off" to disable
_ENV_WORKER_MAX_POOL: Final[str] = "TOKEN_GOAT_WORKER_MAX_POOL"  # integer override for max indexing thread-pool workers (1–8)
_ENV_COMPRESS_PROFILE: Final[str] = "TOKEN_GOAT_COMPRESS_PROFILE"  # "auto"|"aggressive"|"balanced"|"minimal"
_ENV_SKILL_COMPRESS: Final[str] = "TOKEN_GOAT_SKILL_COMPRESS"  # set to "0"/"false"/"no"/"off" to disable body gzip
_ENV_LAZY_SKILL_INJECTION: Final[str] = "TOKEN_GOAT_LAZY_SKILL_INJECTION"  # set to "0"/"false"/"no"/"off" for eager injection
_ENV_SERVE_DIFF_ON_REREAD: Final[str] = "TOKEN_GOAT_SERVE_DIFF_ON_REREAD"  # set to "1"/"true"/"yes"/"on" to enable diff-as-tool-result
_ENV_OVERFLOW_GUARD: Final[str] = "TOKEN_GOAT_OVERFLOW_GUARD"  # set to "0"/"false"/"no"/"off" to disable
_ENV_OVERFLOW_MAX_TOKENS: Final[str] = "TOKEN_GOAT_OVERFLOW_MAX_TOKENS"  # integer override (max tokens)

CONFIG_SCHEMA_VERSION: Final[int] = 1

_VALID_TRIGGERS: Final[frozenset[str]] = frozenset(["manual", "auto"])

_FALSY_ENV_VALUES: Final[frozenset[str]] = frozenset(["0", "false", "no", "off"])
_TRUTHY_ENV_VALUES: Final[frozenset[str]] = frozenset(["1", "true", "yes", "on"])


def _apply_env_enable(cfg_obj: Any, attr: str, env_key: str, label: str) -> None:
    """Set ``cfg_obj.attr = True`` when *env_key* holds a truthy env-var value.

    Mirror of :func:`_apply_env_disable` for opt-in features whose default is
    ``False``.  Recognises ``"1"``, ``"true"``, ``"yes"``, and ``"on"``
    (case-insensitive, whitespace-stripped).  No-ops when the variable is unset
    or holds any other value.  Logs an INFO line on enable so the change is
    visible in the token-goat log.
    """
    val = os.environ.get(env_key, "").strip().lower()
    if val in _TRUTHY_ENV_VALUES:
        _LOG.info("%s enabled by environment variable (%s=%s)", label, env_key, val)
        setattr(cfg_obj, attr, True)

# Every top-level TOML section that token-goat recognises.  A key present in
# the file but absent from this set almost certainly indicates a typo (e.g.
# ``[compact_assit]`` instead of ``[compact_assist]``); we warn rather than
# crash so the user's config remains functional.
_KNOWN_SECTIONS: Final[frozenset[str]] = frozenset([
    "schema_version",
    "compact_assist",
    "bash_compress",
    "session_brief",
    "skill_preservation",
    "image_shrink",
    "curator",
    "hint_budget",
    "repomap",
    "overflow_guard",
    "stats",
    "hints",
    "hooks",
    "webfetch",
    "worker",
    "indexing",
    "compression",
    "context",
    "bash_diff",
    "bash_severity_log",
    "injection",
])


def _apply_env_disable(cfg_obj: Any, attr: str, env_key: str, label: str) -> None:
    """Set ``cfg_obj.attr = False`` when *env_key* holds a falsy env-var value.

    Recognises ``"0"``, ``"false"``, ``"no"``, and ``"off"`` (case-insensitive,
    whitespace-stripped).  No-ops when the variable is unset or holds any other
    value.  Logs an INFO message on disable so the change is visible in the
    token-goat log.
    """
    val = os.environ.get(env_key, "").strip().lower()
    if val in _FALSY_ENV_VALUES:
        _LOG.info("%s disabled by environment variable (%s=%s)", label, env_key, val)
        setattr(cfg_obj, attr, False)


def _env_int(env_key: str, default: int, lo: int, hi: int, config_path: str) -> int:
    """Read and validate an integer from an environment variable.

    Retrieves the env var, strips whitespace, parses as int, validates range,
    logs on success or failure, and returns the validated value or default.

    Args:
        env_key: Environment variable name.
        default: Fallback value when var is unset or invalid.
        lo: Lower bound (inclusive).
        hi: Upper bound (inclusive).
        config_path: Human-readable config path for logging (e.g., "hints.bash_dedup_min_bytes").

    Returns:
        Validated int in [lo, hi], or default on parse/range error.
    """
    env_val = os.environ.get(env_key, "").strip()
    if not env_val:
        return default
    try:
        v = _validated_int(env_val, default, lo, hi, config_path + "(env)")
        if v != default:
            _LOG.info("%s overridden by environment: %d", config_path, v)
        return v
    except (TypeError, ValueError):
        _LOG.warning("%s env override invalid (not an int): %s; using default %d", config_path, env_val, default)
        return default


def _env_bool(env_key: str, default: bool) -> bool:
    """Read a boolean from an environment variable.

    Accepts 1/true/yes (case-insensitive) as True, 0/false/no as False.
    Returns *default* when the variable is unset or has an unrecognised value.
    """
    val = os.environ.get(env_key, "").strip().lower()
    if val in ("1", "true", "yes"):
        return True
    if val in ("0", "false", "no"):
        return False
    return default


class _CompactAssistToml(TypedDict, total=False):
    """Expected shape of the [compact_assist] TOML section."""

    enabled: bool
    triggers: list[str]
    min_events: int
    max_manifest_tokens: int
    auto_trigger_multiplier: float
    compact_skip_ttl_secs: float
    noise_floor_tokens: int
    edited_dir_group_threshold: int
    max_section_lines: int
    wide_session_threshold: int
    orchestrator_commit_threshold: int
    lazy_skill_injection: bool
    max_manifest_chars: int
    harness: str


class _BashCompressToml(TypedDict, total=False):
    """Expected shape of the [bash_compress] TOML section."""

    enabled: bool
    disabled_filters: list[str]
    max_lines: int
    max_bytes: int
    timeout_seconds: int
    cache_min_bytes: int
    cache_max_file_count: int
    cache_max_bytes: int
    cache_max_bytes_per_output: int


class _SessionBriefToml(TypedDict, total=False):
    """Expected shape of the [session_brief] TOML section."""

    enabled: bool


class _SkillPreservationToml(TypedDict, total=False):
    """Expected shape of the [skill_preservation] TOML section."""

    enabled: bool
    max_cache_bytes: int
    orphan_sweep_enabled: bool
    orphan_age_secs: int
    truncation_budget_tokens: int
    compress_bodies: bool
    compress_min_bytes: int
    inline_snippets: bool
    pre_skill_enabled: bool
    first_load_compact: bool
    post_compact_full_loads: bool


class _ImageShrinkToml(TypedDict, total=False):
    """Expected shape of the [image_shrink] TOML section."""

    prefer_avif: bool
    avif_quality: int
    jpeg_quality: int
    max_image_pixels: int
    orphan_sweep_enabled: bool
    orphan_age_secs: int


class _CuratorToml(TypedDict, total=False):
    """Expected shape of the [curator] TOML section."""

    enabled: bool
    min_samples: int
    threshold_pct: int


class _HintBudgetToml(TypedDict, total=False):
    """Expected shape of the [hint_budget] TOML section."""

    enabled: bool
    max_per_session: int
    max_structured_per_session: int
    max_index_only_per_session: int


class _RepomapToml(TypedDict, total=False):
    """Expected shape of the [repomap] TOML section."""

    compact_file_threshold: int
    exclude_tests: bool


class _StatsToml(TypedDict, total=False):
    """Expected shape of the [stats] TOML section."""

    record_zero_savings: bool


class _HooksToml(TypedDict, total=False):
    """Expected shape of the [hooks] TOML section."""

    watchdog_ms: int


class _HintsToml(TypedDict, total=False):
    """Expected shape of the [hints] TOML section."""

    suppress_after_ignored: int
    quiet_hours: str
    json_sidecar: bool
    verbose_until_seen_count: int
    min_file_lines_for_hint: int
    bash_dedup_min_bytes: int
    web_dedup_min_bytes: int
    grep_dedup_min_matches: int
    serve_diff_on_reread: bool
    backoff_thresholds: list[int]
    git_hint_max_ms: int
    min_session_hint_savings_bytes: int
    diff_hint_min_tokens_saved: int
    large_read_redirect_bytes: int
    reread_deny: bool
    reread_deny_min_bytes: int
    baseline_budget_tokens: int
    prompt_triggers: list[dict[str, Any]]


class _WebFetchToml(TypedDict, total=False):
    """Expected shape of the [webfetch] TOML section."""

    allow: list[str]
    deny: list[str]
    max_file_count: int
    max_bytes: int
    compress_bodies: bool
    compress_min_bytes: int


class _WorkerToml(TypedDict, total=False):
    """Expected shape of the [worker] TOML section."""

    watchdog_enabled: bool
    max_pool_workers: int


class _IndexingToml(TypedDict, total=False):
    """Expected shape of the [indexing] TOML section."""

    large_file_symbol_only_kb: int
    large_file_skip_kb: int
    skip_dirs: list[str]


class _ContextToml(TypedDict, total=False):
    """Expected shape of the [context] TOML section."""

    model_window_tokens: int


class _CompressionToml(TypedDict, total=False):
    """Expected shape of the [compression] TOML section."""

    profile: str


class _OverflowGuardToml(TypedDict, total=False):
    """Expected shape of the [overflow_guard] TOML section."""

    enabled: bool
    max_tokens: int


class _InjectionToml(TypedDict, total=False):
    """Expected shape of the [injection] TOML section."""

    enabled: bool


class _ConfigToml(TypedDict, total=False):
    """Expected shape of the token-goat config TOML file."""

    schema_version: int
    compact_assist: _CompactAssistToml
    bash_compress: _BashCompressToml
    session_brief: _SessionBriefToml
    skill_preservation: _SkillPreservationToml
    image_shrink: _ImageShrinkToml
    curator: _CuratorToml
    hint_budget: _HintBudgetToml
    repomap: _RepomapToml
    stats: _StatsToml
    hints: _HintsToml
    hooks: _HooksToml
    webfetch: _WebFetchToml
    worker: _WorkerToml
    indexing: _IndexingToml
    compression: _CompressionToml
    overflow_guard: _OverflowGuardToml
    injection: _InjectionToml
    context: _ContextToml


@dataclass
class CompactAssistConfig:
    """Configuration for the compaction-assist feature.

    Controls whether and how token-goat injects a session manifest as a
    ``systemMessage`` before Claude Code compacts the conversation, so the
    compaction LLM knows which files and symbols are most important to preserve.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_COMPACT_ASSIST=0`` (or ``false``/``no``/``off``).
        triggers: Which compaction events activate the manifest.  Recognized
            values are ``"manual"`` (user-invoked ``/compact``) and ``"auto"``
            (automatic compaction triggered by context pressure).
        min_events: Minimum number of tracked events (reads + greps + edits) that
            must have occurred before a manifest is emitted.  Sessions below this
            threshold are too short to benefit, so the manifest is suppressed to
            avoid injecting noise into tiny conversations.
        max_manifest_tokens: Approximate upper bound on manifest size in tokens.
            ``compact.build_manifest()`` trims output to stay within this budget.
        auto_trigger_multiplier: Multiplier applied to ``max_manifest_tokens`` when
            the PreCompact hook fires with ``trigger="auto"`` (Claude Code's
            automatic compaction at high context pressure).  A larger manifest at
            auto-trigger time is net-positive: when context is near-full and the
            harness is forced to compact, every preserved fact saves a re-read in
            the next iteration.  ``"manual"`` triggers keep the base budget — the
            user explicitly chose to compact, usually with plenty of room to spare.
            Default 2.0 (doubles the budget at auto-compact).  Clamped to
            ``[1.0, 10.0]``; the product is also clamped by ``_MAX_MANIFEST_TOKENS_CAP``
            inside ``build_manifest`` so an overzealous multiplier cannot blow past
            the hard ceiling.
    """

    enabled: bool = True
    # Hook triggers that activate the manifest: "manual" (/compact) and/or "auto"
    triggers: list[str] = field(default_factory=lambda: ["manual", "auto"])
    # Minimum tracked-event count before emitting a manifest (avoids noise on tiny sessions).
    #
    # Tuning note (iter 17): lowered from 5 → 3. A single Read of a 3000-line
    # file is itself ~50k tokens of context cost; even with only 3 tracked
    # events the manifest's edited-files + key-files breakdown is materially
    # more useful to the compaction LLM than nothing. The 400-token manifest
    # cap means a tiny session still produces a tiny manifest — the lower
    # bound was about avoiding noise on a session that did *nothing*, not
    # about needing five events worth of signal.
    min_events: int = 3
    # Approximate token budget for the manifest injected as systemMessage
    max_manifest_tokens: int = 400
    # Budget multiplier applied when trigger="auto" (context-pressure compaction).
    # See class docstring for rationale.  1.0 disables the boost.
    auto_trigger_multiplier: float = 2.0
    # TTL (seconds) for the compact-skip sentinel written by no-op pre-compact
    # exits.  When a fresh sentinel exists and the session JSON file has not
    # been modified since the sentinel was written, the next PreCompact returns
    # immediately without importing the heavy compact/session modules.  Lower
    # this to make the hook more eager to re-emit manifests after activity;
    # raise it to suppress more redundant fast-path work on near-idle sessions.
    # The activity floor (session mtime > sentinel mtime) busts the cache
    # whenever the user is active, so a long TTL only affects truly quiet
    # sessions.  Clamped to (0, 3600] s.
    compact_skip_ttl_secs: float = 300.0
    # Noise floor (tokens): sections with estimated token count less than this
    # value are dropped from the manifest before final assembly, saving tokens
    # when low-signal sections add clutter.  Default 0 disables the filter
    # (no sections are dropped).  When > 0, only body subsections are dropped;
    # the header and critical sections (edited, blockers, skills) are always preserved.
    noise_floor_tokens: int = 0
    # Directory-grouping threshold for edited files in the manifest. When the
    # manifest's edited-files section contains >= N files in the same directory,
    # they are rendered as a single grouped line (e.g. "src/foo/ (5 files): a.py,
    # b.py, c.py, ...") instead of individual lines. Threshold 0 disables
    # grouping (all files listed separately). Default 3 — matches the prior
    # hardcoded behavior; lower values group more aggressively.
    edited_dir_group_threshold: int = 3
    # Per-section line cap for the manifest. When > 0, each list-shaped section
    # (Edited files, Key Files Read, Symbols Accessed, Active Skills) is truncated
    # to at most this many items. Truncated sections gain a final line of the form
    # "- ... (+N more)". Prevents a single bloated section from dominating the
    # manifest budget at the expense of other sections. Default 0 disables capping.
    max_section_lines: int = 0
    # Wide-session threshold: when a session has accessed at least this many
    # unique files, the Symbols Accessed section is replaced by a single
    # ``token-goat map --compact`` pointer. At wide-session scale the per-file
    # symbol listing consumes 200–300 tokens the compaction LLM cannot usefully
    # retain. Clamped to [1, 10000]. Default 15.
    wide_session_threshold: int = 15
    # Orchestrator-mode threshold: when a session has >= this many git commits
    # since session start AND fewer than 10 edited files (characteristic of
    # /improve orchestrator loops), the manifest switches to orchestrator mode.
    # In orchestrator mode the symbols-accessed section is replaced by a
    # ``### Recent Commits`` section (git log --oneline -10) and the bash
    # history section is suppressed (too noisy across long loop iterations).
    # Clamped to [1, 10000]. Default 5.
    orchestrator_commit_threshold: int = 5
    # Lazy skill injection: when True (default), the manifest's Active Skills
    # section lists only "name (NNN tokens) → token-goat skill-body name --compact"
    # for each cached skill instead of inlining the full compact text.  The
    # model fetches compacts on demand after compaction, paying the token cost
    # only for skills it actually needs.  Set to False (or
    # TOKEN_GOAT_LAZY_SKILL_INJECTION=0) to revert to eager injection (full
    # compact text inlined at manifest-build time).
    lazy_skill_injection: bool = True
    # Hard character budget for the final manifest string returned by build_manifest().
    # When the fully assembled manifest exceeds this cap (default 1600 chars ≈ 400
    # tokens at ~4 chars/token), the manifest is truncated with priority:
    #   1. version header + edited files section (always kept in full)
    #   2. symbols section (kept if it fits; truncated to first N lines otherwise)
    #   3. skills section (kept if it fits; truncated to first N lines otherwise)
    #   4. remaining sections (dropped when over budget)
    # A warning line "... (manifest truncated at budget limit)" is appended on
    # truncation.  Set to 0 to disable the cap (no hard limit beyond max_manifest_tokens).
    # Valid range: 0 or [400, 16000].  The lower bound of 400 prevents setting a cap
    # so small that the header + edited files can't fit.
    max_manifest_chars: int = 1600
    # Harness type for manifest customisation.  ``"auto"`` (default) detects the
    # active AI harness from environment variables at manifest-build time and
    # adjusts section inclusion accordingly:
    #   * ``"claudecode"`` — current default behaviour (skills + edited + symbols).
    #   * ``"codex"`` — skip the Active Skills section; expand bash history.
    #   * ``"opencode"`` — add a ``### harness: opencode`` tag; wrap for opencode context API.
    #   * ``"generic"`` — minimal output: edited files + symbols only.
    # Set to any of the named values above to override auto-detection.
    harness: str = "auto"


@dataclass
class BashCompressConfig:
    """Configuration for the Bash output-compression feature.

    Token-Goat intercepts Bash tool calls whose binary matches a registered
    output filter (``pytest``, ``git``, ``npm``, ``docker``, ``kubectl``, ...)
    and rewrites the command to flow through ``token-goat compress``, which
    captures stdout + stderr and prints a per-tool compressed view that keeps
    every error block, drops progress bars and duplicate warnings, and groups
    linter issues by rule.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_BASH_COMPRESS=0`` (or ``false``/``no``/``off``).
        disabled_filters: Filter names (``pytest``, ``git``, ...) to disable
            without turning the whole feature off.  Useful when a specific
            filter is too aggressive for a particular project.
        max_lines: Per-invocation line cap.  Output longer than this is
            truncated with a head/tail split and an elision marker.
        max_bytes: Per-invocation byte cap (backstop for unusually long lines).
        timeout_seconds: Wall-clock timeout passed to the wrapper subprocess.
            Default 600 s covers ``npm install`` on a fresh ``node_modules``;
            raise for longer-running builds (e.g. ``terraform apply`` on a
            large stack).
        cache_min_bytes: Minimum output size (bytes) to cache. Outputs smaller
            than this are not stored to disk. Default 0 disables the filter.
            Set to 1024 or higher to skip tiny outputs and save cache space.
        cache_max_file_count: Maximum number of cached bash-output body files
            before oldest-first eviction fires (default 4096, matching web cache).
            Override via ``TOKEN_GOAT_BASH_CACHE_MAX_FILES`` env var.
        cache_max_bytes: Maximum total bytes for the bash-output cache directory
            (default 16 MiB).  Override via ``TOKEN_GOAT_BASH_CACHE_MAX_BYTES``.
        cache_max_bytes_per_output: Maximum size per single bash output file
            (default 50 MB). Outputs larger than this are not cached, preventing
            one huge build log from filling the entire cache directory.
            Override via ``TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT`` env var.
    """

    enabled: bool = True
    disabled_filters: list[str] = field(default_factory=list)
    max_lines: int = 1000
    max_bytes: int = 64 * 1024
    timeout_seconds: int = 600
    cache_min_bytes: int = 0
    cache_max_file_count: int = 4096
    cache_max_bytes: int = 16 * 1024 * 1024
    cache_max_bytes_per_output: int = 50 * 1024 * 1024


@dataclass
class BashDiffConfig:
    """Per-file hunk density cap applied by diff filters.

    Attributes:
        max_hunks_per_file: Keep only this many hunks per file, chosen by highest change density.
            Files with at most this many hunks are left untouched.  Default 10.
        hunk_density_cap: Master switch; set to false to disable density filtering entirely.
    """

    max_hunks_per_file: int = 10
    hunk_density_cap: bool = True


@dataclass
class SeverityLogConfig:
    """Config for severity-scored log stream compression (SeverityLogFilter).

    Attributes:
        context_lines: Lines to keep above and below each high-severity line.
        score_threshold: Minimum score to keep a line unconditionally (0.0–1.0).
    """

    context_lines: int = 3
    score_threshold: float = 0.5


@dataclass
class CodeCompressConfig:
    """Configuration for post-read structural code compression.

    When a Read tool call returns a source file with at least ``min_lines``
    lines, token-goat replaces the verbatim content with a skeleton view that
    keeps only imports, type aliases, __all__, and def/class signatures.

    Attributes:
        min_lines: Minimum line count to trigger compression. Files shorter
            than this are passed through unchanged. Default 200.
    """

    min_lines: int = 200


@dataclass
class SessionBriefConfig:
    """Configuration for the session-start orientation brief.

    When enabled, token-goat injects a compact git-status + recent-commits
    summary into the session context at startup.  This saves the model 3-4
    orientation tool calls (``git status``, ``git log``, ``git branch``) that
    it would otherwise spend discovering the same info from scratch.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_SESSION_BRIEF=0`` (or ``false``/``no``/``off``).
    """

    enabled: bool = True


@dataclass
class SkillPreservationConfig:
    """Configuration for the skill-preservation feature.

    When enabled, token-goat captures every Skill tool invocation to a
    persistent on-disk cache so the agent can recall the full skill body
    after a compaction event without re-invoking the skill.  The compaction
    manifest also lists every loaded skill as a hint to the compaction LLM
    that this content is load-bearing and should not be summarised away.

    Solves the "I forgot parts of the skill after compaction" problem: skill
    bodies (Ralph's DoD gates, /improve's iteration sequence, etc.) are
    typically multi-thousand-token prose blocks that the compaction LLM
    aggressively trims; this feature preserves them as an external pointer
    while keeping the conversation lean.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_SKILL_PRESERVATION=0`` (or
            ``false``/``no``/``off``).
        max_cache_bytes: Total byte budget for the on-disk skill cache.  When
            exceeded, oldest entries are evicted until the cap is met.
            Default 5 MB holds dozens of skill bodies; raise for environments
            that load very large skills repeatedly.
        orphan_sweep_enabled: When ``True``, a one-shot sweep at startup removes
            skill body blobs older than ``orphan_age_secs``.  Sessions never
            last more than a few hours, so any body older than the default
            7 days is dead by definition.  Disable via
            ``TOKEN_GOAT_ORPHAN_SWEEP=0`` or ``orphan_sweep_enabled = false``
            in ``[skill_preservation]``.
        orphan_age_secs: Age threshold for the orphan sweep (default 7 days).
            Blobs whose mtime is older than this are removed.  Valid range:
            1 s – 30 days (2 592 000 s).
        truncation_budget_tokens: When a skill has no ``<!-- COMPACT_END -->``
            marker, ``generate_compact_summary`` auto-extracts a compact.  This
            setting caps the injected compact at a configurable token budget so
            very large skills without an explicit marker don't dominate the
            session manifest.  Default 800 tokens (≈ 3200 chars at 4 chars/token).
            Set to 0 to disable the cap (use the module-level ``_COMPACT_MAX_CHARS``
            limit of ~400 tokens instead).  Valid range: 0 – 8000 tokens.
        compress_bodies: When ``True`` (default), skill body files larger than
            ``compress_min_bytes`` are stored gzip-compressed to reduce disk
            footprint and eviction pressure.  Decompression is transparent on
            read so callers see plain text regardless of whether the body was
            stored compressed or not.  Can be disabled by setting
            ``TOKEN_GOAT_SKILL_COMPRESS=0``.
        compress_min_bytes: Minimum body size (bytes) for gzip compression to
            apply when ``compress_bodies`` is ``True``.  Bodies smaller than
            this threshold are stored as plain text (compression overhead not
            worth it for small files).  Default 16 384 (16 KB).
            Valid range: 1 024 – 10 485 760 (1 KB – 10 MB).
        inline_snippets: When ``True`` (default), the compaction manifest
            inlines a compact snippet for each cached skill directly into the
            ``### Active Skills`` section instead of emitting only a
            ``token-goat skill-body`` recall command.  For skills with a
            ``<!-- COMPACT_END -->`` marker the curated compact section is
            used; for skills without a marker a heuristic extract of the first
            heading and all CRITICAL/MUST/NEVER/RULE lines is inlined instead.
            Set to ``False`` to revert to recall-command-only behaviour (saves
            ~150–200 tokens per skill at manifest-build time but requires the
            agent to fetch the snippet manually after compaction).
        pre_skill_enabled: When ``True`` (default), a PreToolUse hook fires
            before every Skill invocation.  Repeat loads of the same skill
            in the same session are blocked and the cached compact is injected
            as ``additionalContext`` instead (or a recall pointer when no
            compact is available), saving the full body size on every reload.
            First-load blocking is separately gated by ``first_load_compact``.
            Disable with ``TOKEN_GOAT_PRE_SKILL=0``.
        first_load_compact: When ``True`` *and* the skill has an explicit
            ``<!-- COMPACT_END -->`` marker, the pre-skill hook also blocks the
            *first* load of the skill and serves only the compact section.  The
            full body is accessible on demand via
            ``token-goat skill-body <name> --section <heading>``.  Defaults to
            ``False`` (safe default: full body on first load, compact on
            subsequent loads only).  Enable only after verifying that your
            skill compacts are functional standalones.
        post_compact_full_loads: When ``False`` (default), the pre-skill hook
            serves the compact form even after a compaction event — dedup stays
            armed through the entire session.  Set to ``True`` to allow one
            full body reload per compaction epoch (the pre-1.7 behaviour).
    """

    enabled: bool = True
    max_cache_bytes: int = 5 * 1024 * 1024
    orphan_sweep_enabled: bool = True
    orphan_age_secs: int = 604800
    truncation_budget_tokens: int = 800
    compress_bodies: bool = True
    compress_min_bytes: int = 16 * 1024
    inline_snippets: bool = True
    pre_skill_enabled: bool = True
    first_load_compact: bool = False
    post_compact_full_loads: bool = False


@dataclass
class CuratorConfig:
    """Configuration for the curator pass — skip dedup hints when ignored.

    When the agent repeatedly ignores dedup hints (reads the same file after
    being told it was already in context), those hints cost tokens without
    providing value.  The curator tracks the ignore rate and suppresses future
    dedup hints for the session once the rate falls below *threshold_pct* with
    a sufficient *min_samples* sample size.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_CURATOR=0`` (or ``false``/``no``/``off``).
        min_samples: Minimum number of emitted hints before the rate is evaluated.
            Below this threshold all hints fire unconditionally (no data to decide).
            Default 10.
        threshold_pct: If hints_ignored/hints_emitted * 100 falls below this value
            AND hints_emitted >= min_samples, future dedup hints are suppressed.
            Default 20 (i.e. suppress when fewer than 20% of hints were acted on).
    """

    enabled: bool = True
    min_samples: int = 10
    threshold_pct: int = 20


@dataclass
class HintBudgetConfig:
    """Hard cap on total hints emitted per session to bound cumulative overhead.

    In long sessions (100 k+ tokens) dedup hints can accumulate to hundreds of
    tokens even after the curator has done its work.  ``HintBudgetConfig`` adds
    an absolute ceiling: once a counter reaches its limit every subsequent hint
    of that kind is silently suppressed for the rest of the session.

    Three independent counters guard three hint categories:

    * *max_per_session* — dedup-style hints (re-read, grep-dedup, bash-dedup,
      web-dedup, glob-dedup).  These share the single ``hints_emitted`` counter
      already tracked on ``SessionCache``.
    * *max_structured_per_session* — structured-file hints (CSV/JSON/log).
    * *max_index_only_per_session* — index-only / lockfile / bundle hints.

    Structured and index-only hints each have their own counter in
    ``SessionCache`` (``structured_hints_emitted`` / ``index_only_hints_emitted``)
    so the budgets are independent: hitting the dedup ceiling does not suppress
    the two higher-value hint families, and vice versa.

    Setting any limit to 0 disables that hint kind for the whole session.
    Setting *enabled* to ``False`` (or ``TOKEN_GOAT_HINT_BUDGET=0``) disables
    all budget enforcement while leaving the curator logic intact.

    Attributes:
        enabled: Master on/off switch.  Defaults to ``True``.
        max_per_session: Max dedup hints emitted per session.  Default 100.
        max_structured_per_session: Max structured-file hints per session.  Default 30.
        max_index_only_per_session: Max index-only hints per session.  Default 30.
    """

    enabled: bool = True
    max_per_session: int = 100
    max_structured_per_session: int = 30
    max_index_only_per_session: int = 30


@dataclass
class ImageShrinkConfig:
    """Configuration for the image-shrink feature.

    When ``prefer_avif`` is ``True`` and the runtime Pillow has AVIF encoder
    support (requires libaom; available in Pillow ≥ 10.x with AVIF build),
    large images (> SIZE_THRESHOLD_BYTES) are encoded as AVIF instead of WebP
    or JPEG.  AVIF at quality 60 is perceptually equivalent to JPEG at quality
    85 while producing files that are typically 30–50% smaller, yielding a
    further token-budget reduction on top of the existing resize step.

    Images with transparency (RGBA/LA mode) always stay as PNG regardless of
    this setting, since lossy AVIF/JPEG on transparent screenshots produces
    visible artefacts on sharp edges.

    Attributes:
        prefer_avif: Enable AVIF output when Pillow supports it.  Can also be
            disabled at runtime by setting ``TOKEN_GOAT_PREFER_AVIF=0``
            (or ``false``/``no``/``off``).  Defaults to ``True``.
        avif_quality: AVIF encoder quality (1 = worst, 100 = best).  Default
            60 is perceptually equivalent to JPEG quality 85 and typically
            30–50% smaller.  Valid range: 1–100.
        jpeg_quality: JPEG encoder quality used as the non-AVIF lossy fallback
            (when AVIF is unavailable or disabled).  Default 75, same as the
            pre-existing ``JPEG_QUALITY`` constant.  Valid range: 1–100.
        max_image_pixels: Hard pixel-count cap passed to ``Image.MAX_IMAGE_PIXELS``
            before decoding.  Images whose decoded bitmap would exceed this value
            cause Pillow to raise ``DecompressionBombError``; ``shrink()`` catches
            it and returns ``None`` (skip).  Default 16 000 000 (≈ 4000×4000).
            Set to 0 to disable the cap (matches Pillow's built-in 178 MP default).
            Override with ``TOKEN_GOAT_MAX_IMAGE_PIXELS=<n>``.
    """

    prefer_avif: bool = True
    avif_quality: int = 60
    jpeg_quality: int = 75
    max_image_pixels: int = 16_000_000
    orphan_sweep_enabled: bool = True
    orphan_age_secs: int = 604800  # 7 days
    screenshot_redirect: bool = True


@dataclass
class RepomapConfig:
    """Configuration for the repo-map feature.

    Controls how ``token-goat map --compact`` renders the file-list preamble
    when the project has many files.  When ``compact`` mode is active AND the
    number of map-worthy files exceeds *compact_file_threshold*, the full
    per-file ranked list is replaced with a single summary line
    (``"N files indexed. Top modules: a.py, b.py, c.py (+M more)"``).

    The full list is always available via ``--full`` regardless of this setting.
    Override at runtime by setting ``TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD=<n>``.

    Attributes:
        compact_file_threshold: File count above which compact mode suppresses
            the per-file list preamble.  Default 50.  Set to 0 to disable
            (always emit the full list even in compact mode).
        exclude_tests: When True (default), test directories (``tests/``,
            ``__tests__/``, ``test/``, ``spec/``, ``e2e/``) are excluded from
            the repo map.  Test files import production modules heavily, which
            inflates PageRank of those modules via test edges rather than real
            production dependencies.  The map is more useful when it reflects
            production structure only.  Set to False to include test files.
            Override at runtime by setting ``TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS=0``.
    """

    compact_file_threshold: int = 50
    exclude_tests: bool = True


@dataclass
class OverflowGuardConfig:
    """Caps oversized command output so a single dump can't overflow context."""

    enabled: bool = True
    max_tokens: int = 25000


@dataclass
class StatsConfig:
    """Configuration for stats recording.

    Controls whether and how token-goat records statistics about hints and
    dedup operations to the database.

    Attributes:
        record_zero_savings: When False (default), ``record_hint_stat_pair``
            skips writing stat rows for hints with zero tokens saved and zero
            injection cost (suggestion-only hints like large-file nudges).
            This reduces SQLite write overhead on the hot pre-read path
            (~0.5–1 ms per skipped write). When True, all stat rows are written
            as before, preserving complete hint history for analysis.
    """

    record_zero_savings: bool = False


@dataclass
class PromptTrigger:
    """A keyword-to-hint rule for the UserPromptSubmit hook.

    When any word in *keywords* appears (case-insensitive, whole-word) in the
    user's prompt, *hint* is appended to the session-context summary that
    token-goat injects as ``additionalContext``.  This pre-populates relevant
    context before the model searches for it, saving tool-call round-trips.

    Configure via ``[[hints.prompt_triggers]]`` in config.toml::

        [[hints.prompt_triggers]]
        keywords = ["release", "publish", "tag", "changelog"]
        hint = "Release: bump pyproject + uv lock, CHANGELOG, push main, create tag"

        [[hints.prompt_triggers]]
        keywords = ["commit", "push"]
        hint = "Git: SSH fallback if auth fails; no Co-Authored-By lines"
    """

    keywords: list[str]
    hint: str


@dataclass
class HintsConfig:
    """Configuration for adaptive hint suppression, quiet-hours, verbose suppression, and the
    structured-JSON sidecar.

    Attributes:
        suppress_after_ignored: How many consecutive ignored hints for a category
            before that category is suppressed for the rest of the session.
            Default 5. Set to 0 to disable adaptive suppression.
        quiet_hours: Time range in local time during which hints are suppressed,
            in "HH:MM-HH:MM" format (24-hour clock). Empty string disables.
            Example: "22:00-07:00" suppresses hints from 10pm to 7am.
            Midnight wrap-around is supported.
        json_sidecar: When True, every dedup / re-read / unchanged-file / structured
            file hint is prefixed with a one-line JSON sidecar carrying the same
            information in a machine-parseable form (``{"hint":"already_read",
            "file":"...", "ranges":[[1,40]], ...}``).  The original prose line is
            preserved verbatim so existing dedup, fingerprints, curator metrics
            and test assertions keep working unchanged.  Opt-in (default False)
            because the sidecar adds ~30-80 chars per hint and the feature is
            still proving itself; flip the bit per-session via
            ``TOKEN_GOAT_HINT_JSON_SIDECAR=1`` to evaluate. Defaults to False
            unless overridden in config or env.
        verbose_until_seen_count: Number of times a hint fingerprint must be seen
            before suppressing its verbose text in favor of a short stub. Default 2
            means the first two occurrences are full text; the 3rd+ emits only
            "(↳ same hint seen Nx, see prior context)". Set to 0 to always emit
            verbose (never use short stub). Set to 1 to use short stub from the
            2nd occurrence onward.
        min_file_lines_for_hint: Minimum number of lines in a file before full-file
            hints (already-read / index-based large-file suggestions) are emitted.
            Default 0 (disabled). When >0, files with fewer lines are not hinted,
            since the cost of the hint (~25 tokens) exceeds the saving on a cheap
            re-read. Surgical hints (symbol/section/diff) are never suppressed.
        bash_dedup_min_bytes: Minimum output size (bytes of post-compression
            stdout+stderr) before bash output dedup hints are emitted. Default 200.
            At 200 bytes output is ~50 tokens; a short dedup hint costs ~12 tokens,
            netting ~38 tokens saved. Below this threshold the hint cost exceeds
            the saving and dedup is suppressed. Clamped to [0, 100000].
        web_dedup_min_bytes: Minimum response body size (bytes, UTF-8 encoded)
            before WebFetch dedup hints are emitted. Default 200. At 200 bytes
            response is ~50 tokens; a short dedup hint costs ~12 tokens, netting
            ~38 tokens saved. Below this threshold the hint cost exceeds the saving
            and dedup is suppressed. Clamped to [0, 100000].
        grep_dedup_min_matches: Minimum number of match results before grep dedup
            hints are emitted. Default 5. At 5 matches × 120 bytes/match ≈ 600 bytes
            ≈ 150 tokens saved; a short dedup hint costs ~12 tokens, netting ~138
            tokens saved. Below this threshold the hint cost exceeds the saving and
            dedup is suppressed. Clamped to [0, 100000].
        backoff_thresholds: Sorted list of read_count values at which a session
            re-read hint is emitted. A hint fires only when the file's read_count
            (number of prior reads in this session) is in this set; all other
            re-reads are silently suppressed as ``hint_backoff_suppressed``.
            Default [1, 3, 10, 30] fires on the 2nd, 4th, 11th, and 31st reads,
            cutting hint volume by ~70% on heavily-used files. Set to [] to
            disable backoff (emit on every re-read, original behaviour).
        git_hint_max_ms: Maximum wall-clock time in milliseconds allowed for
            computing a git-history hint during pre-read. If the operation
            (SQLite lookup in the commit index) takes longer than this threshold,
            the hint is skipped for this read and a ``git_hint_timeout`` stat is
            recorded. Default 50 ms. Set to 0 to disable the timeout cap (always
            wait). Override via ``[hints] git_hint_max_ms = N`` in config.toml.
            Clamped to [0, 10000].
    """

    suppress_after_ignored: int = 5
    quiet_hours: str = ""
    # Opt-in structured-JSON line prepended to prose hints. See class docstring.
    json_sidecar: bool = False
    # Verbose-suppression threshold for repeated hint fingerprints.
    verbose_until_seen_count: int = 2
    # Minimum line count for full-file hints. 0 disables suppression.
    min_file_lines_for_hint: int = 0
    # Minimum output size (bytes) for bash dedup hints. Default 200.
    bash_dedup_min_bytes: int = 200
    # Minimum response body size (bytes) for web dedup hints. Default 200.
    web_dedup_min_bytes: int = 200
    # Minimum match result count for grep dedup hints. Default 5.
    grep_dedup_min_matches: int = 5
    # When True, a re-read of a changed file is intercepted: the pre-read hook
    # denies the Read tool call and injects a unified diff (via difflib) as the
    # tool result instead of the full file content.  This can save 10-100x tokens
    # compared to a full re-read when only a few lines changed.  Opt-in (default
    # False) because it changes the tool result format — the model receives a diff
    # instead of the raw file, which may confuse agents not expecting it.  Enable
    # via TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1 or [hints] serve_diff_on_reread = true.
    serve_diff_on_reread: bool = False
    # Exponential backoff thresholds for session re-read hints.  A session hint is
    # emitted only when the file's read_count (reads before this one) is in this set.
    # The default sequence {1, 3, 10, 30} fires on the 2nd, 4th, 11th, and 31st
    # reads; all other re-reads are suppressed as hint_backoff_suppressed.  This
    # cuts hint volume by ~70% on heavily-used files without losing signal.
    # Set to [] to disable backoff (emit on every re-read).
    # Override via [hints] backoff_thresholds = [1, 3, 10, 30] in config.toml.
    backoff_thresholds: list[int] = field(default_factory=lambda: [1, 3, 10, 30])
    # Maximum wall-clock time (ms) for git-history hint lookup. 0 disables the cap.
    # When exceeded, the hint is skipped and git_hint_timeout stat is recorded.
    git_hint_max_ms: int = 50
    # Minimum bytes-saved threshold for session re-read hints.  When the estimated
    # bytes saved by suppressing a re-read is below this value, the hint is not
    # emitted — the hint cost (~12-25 tokens ≈ 36-75 bytes) would exceed the saving.
    # Default 512 bytes (≈170 tokens saved floor).  Set to 0 to disable the threshold
    # (always emit hints regardless of savings).  Override via
    # ``TOKEN_GOAT_SESSION_HINT_MIN_BYTES`` env var or
    # ``[hints] min_session_hint_savings_bytes = N`` in config.toml.
    # Clamped to [0, 1_000_000].
    min_session_hint_savings_bytes: int = 512
    # When True, emit a non-blocking advisory in pre_skill when estimated context
    # fill exceeds 60 % AND the incoming skill body exceeds 4,000 tokens.  Uses
    # additionalContext so the load is NOT blocked.  Opt-out via
    # ``[hints] pre_skill_advisory = false`` in config.toml.
    pre_skill_advisory: bool = True
    # When True, emit threshold-crossing context advisories in user_prompt_submit
    # at 50 %, 70 %, and every turn above 85 % estimated context fill.  Opt-out
    # via ``[hints] context_threshold_advisory = false`` in config.toml.
    context_threshold_advisory: bool = True
    # Minimum tokens saved (full-file tokens minus diff tokens) before a diff-hint
    # is emitted.  The module-level default of 250 is the breakeven with the
    # ~80-token hint preamble; raising to 1000 keeps only diffs that meaningfully
    # offset context cost.  Override via ``[hints] diff_hint_min_tokens_saved = N``
    # in config.toml.  Clamped to [0, 100_000].
    diff_hint_min_tokens_saved: int = 1000
    # Minimum on-disk file size (bytes) at which a full Read is denied and redirected to surgical reads (skeleton/section/semantic/symbol) or an offset/limit window. Default 45000 (~45 KB) catches the 47-86 KB recon-dump / large-transcript class that overflows a near-full subagent window while leaving typical source reads untouched. A Read that already sets offset or limit is exempt (it is deliberately windowed, and the redirect itself points there — so exempting it also prevents a redirect loop). 0 disables. Override via TOKEN_GOAT_LARGE_READ_BYTES or [hints] large_read_redirect_bytes. Clamped to [0, 100_000_000].
    large_read_redirect_bytes: int = 45_000
    # When True, deny re-reads of a file window already in context this session. The file must be unchanged since last read (last_edit_ts <= last_read_ts); the anti-loop guard allows the second identical attempt through so the model is never hard-blocked. Opt-out via [hints] reread_deny = false. Default on.
    reread_deny: bool = True
    # Minimum on-disk file size (bytes) before reread_deny fires. Files smaller than this threshold are never denied — the token saving is negligible compared to the hint cost (~25 tokens). Default 2048 (~512 tokens). Set to 0 to deny all sizes.
    reread_deny_min_bytes: int = 2048
    # Token budget for the session-start environmental-baseline advisory. When >0 and the cheap fixed baseline (other plugins' SessionStart dumps + CLAUDE.md + MEMORY.md + MCP blocks) exceeds this many estimated tokens, session_start appends one quiet line pointing at `token-goat baseline`, once per session. Default 0 disables the advisory entirely. Override via TOKEN_GOAT_BASELINE_BUDGET_TOKENS or [hints] baseline_budget_tokens. Clamped to [0, 10_000_000].
    baseline_budget_tokens: int = 0
    # Keyword-triggered hint rules.  Each rule fires when any of its keywords
    # appears (whole-word, case-insensitive) in the user's prompt, appending
    # the rule's hint text to the session-context summary injected by
    # UserPromptSubmit.  Default empty — configure per-project via
    # ``[[hints.prompt_triggers]]`` in config.toml.
    # When True, pre_read serves a user-created compact sidecar for large reference docs when one exists and is fresh (source hash matches). Compact must be created explicitly with `token-goat compact-doc <path>`. Default on; disable via [hints] stable_doc_compacts = false.
    stable_doc_compacts: bool = True
    # Minimum total-line count before the truncated-read advisory fires in post_read. Files shorter than this are skipped (default 200). Set to 0 to disable.
    truncated_read_min_lines: int = 200
    # Number of tool calls after a read during which re-read hints are suppressed. Content is still fresh in context so the hint is noise. Default 4. Set to 0 to disable suppression (hints always fire). Clamped to [0, 100].
    protect_recent_reads: int = 4

    prompt_triggers: list[PromptTrigger] = field(default_factory=list)


@dataclass
class HooksConfig:
    """Configuration for hook subprocess timeout and adaptive timeouts.

    Controls the default watchdog budget (wall-clock timeout) for hook subprocess
    invocations. When a hook subprocess exceeds the timeout, it is killed and the
    hook payload is passed through unchanged (fail-soft).

    The effective timeout is determined by three layers (in precedence):
    1. Environment variable ``TOKEN_GOAT_HOOK_WATCHDOG_MS`` (per-invocation override)
    2. Configuration value from [hooks].watchdog_ms (per-project baseline)
    3. Default hardcoded value (currently 5000 ms)

    When a hook subprocess hits the timeout, an adaptive mechanism doubles the
    timeout for the remainder of the session (capped at 30000 ms) to allow
    recovery on slow CI machines or during cold-cache scenarios.

    Attributes:
        watchdog_ms: Hook subprocess wall-clock timeout in milliseconds.
            Default 5000. Clamped to [100, 30000].
    """

    watchdog_ms: int = 5000


@dataclass
class WebFetchConfig:
    """Configuration for pre-WebFetch URL allowlist, denylist, and output cache.

    Patterns are Unix-style globs matched against the full URL.  The denylist
    is checked first; if the URL matches any deny pattern the fetch is blocked.
    If the allowlist is non-empty the URL must match at least one allow pattern
    to proceed.  Empty allowlist means "allow everything not denied".

    The cache caps (max_file_count and max_bytes) mirror the bash_cache caps:
    entries are evicted oldest-first when either cap is exceeded.

    Attributes:
        allow: List of glob patterns; if non-empty, only matching URLs are allowed.
        deny: List of glob patterns; matching URLs are blocked before allow check.
        max_file_count: Maximum number of cached response body files (default 4096).
            Set to 0 to disable file-count eviction.
        max_bytes: Maximum total bytes stored across all cached responses (default 32 MB).
            Set to 0 to disable byte-based eviction (not recommended).
        compress_bodies: When ``True`` (default), response body files larger than
            ``compress_min_bytes`` are stored gzip-compressed to reduce disk usage.
            Reads are transparently decompressed.  Set to ``False`` to store bodies
            as plain text (slightly higher read speed at the cost of ~70% more disk
            space for large HTML responses).  Can also be disabled at runtime by
            setting ``TOKEN_GOAT_WEB_COMPRESS=0``.
        compress_min_bytes: Minimum body size (bytes) for gzip compression to
            apply when ``compress_bodies`` is ``True``.  Bodies smaller than this
            are stored uncompressed (the gzip overhead outweighs the saving for
            tiny blobs).  Default 16 KB.  Valid range: 1 KB to 10 MB.
    """

    allow: list[str] = field(default_factory=list)
    deny: list[str] = field(default_factory=list)
    max_file_count: int = 4096
    max_bytes: int = 32 * 1024 * 1024
    compress_bodies: bool = True
    compress_min_bytes: int = 16 * 1024


# Hard ceiling for worker.max_pool_workers — applied after config load and env override.
# A single daemon must never spawn more than this many index threads regardless of config.
WORKER_MAX_POOL_CEILING: Final[int] = 8


@dataclass
class WorkerConfig:
    """Configuration for the background worker daemon.

    Controls behaviour of the long-running indexing worker process that drains
    the dirty queue and runs periodic maintenance tasks.

    Attributes:
        watchdog_enabled: When True (default), a watchdog thread monitors the
            worker process and restarts it automatically if it exits unexpectedly
            (not via a graceful stop signal).  Set to False to disable auto-restart.
            Can also be disabled at runtime by setting ``TOKEN_GOAT_WORKER_WATCHDOG=0``
            (or ``false``/``no``/``off``).
        max_pool_workers: Maximum number of threads in the per-index
            ThreadPoolExecutor.  Hard-capped at ``WORKER_MAX_POOL_CEILING`` (8)
            regardless of the configured value so a single daemon cannot spawn an
            unbounded thread pool.  Defaults to 4.  Override at runtime with
            ``TOKEN_GOAT_WORKER_MAX_POOL=<n>`` (1–8).
    """

    watchdog_enabled: bool = True
    max_pool_workers: int = 4


@dataclass
class IndexingConfig:
    """Configuration for file-size thresholds during project indexing.

    Controls how the indexer handles large files to avoid spending time and
    memory on content that contributes little signal relative to its cost.

    Two tiers apply:

    * Files larger than ``large_file_symbol_only_kb`` KB but smaller than
      ``large_file_skip_kb`` KB are indexed for symbols only — the expensive
      embedding/chunking pass is skipped.  Symbol search and ``token-goat read``
      still work for these files; semantic search does not.
    * Files larger than ``large_file_skip_kb`` KB are skipped entirely with a
      logged warning.  They do not appear in the symbol index or the embedding
      store.

    Both thresholds are configurable in ``config.toml`` under ``[indexing]``
    and can be tuned upward for projects that legitimately contain large
    generated files that are still worth partial indexing, or downward for
    memory-constrained environments.

    Attributes:
        large_file_symbol_only_kb: Files larger than this many KB get
            symbol-only indexing (no embeddings/chunking). Default 500 KB.
            Valid range: 1 KB to 1 GB (1048576 KB).
        large_file_skip_kb: Files larger than this many KB are skipped entirely
            with a warning. Must be >= large_file_symbol_only_kb. Default 2048 KB.
            Valid range: 1 KB to 1 GB (1048576 KB).
        skip_dirs: Additional directory basenames to exclude during indexing,
            merged with the built-in ``SKIP_DIRS`` set in ``parser.py``.
            Useful for project-specific generated environments (e.g. test venvs,
            build sandboxes) that don't match a standard skip pattern.
            Stored as a list; converted to a frozenset at parse time.
            Example: ``skip_dirs = ["tmptg-py313-venv", "tmptg-py313b"]``.
    """

    large_file_symbol_only_kb: int = 500
    large_file_skip_kb: int = 2048
    skip_dirs: list[str] = field(default_factory=list)


#: Valid profile values for :attr:`CompressionConfig.profile`.
_VALID_COMPRESSION_PROFILES: Final[frozenset[str]] = frozenset(
    ["auto", "aggressive", "balanced", "minimal"]
)

#: Maximum output lines per profile when the profile is explicitly set.
#: "auto" defers to harness detection at hook time.
COMPRESSION_PROFILE_MAX_LINES: Final[dict[str, int]] = {
    "aggressive": 50,
    "balanced": 200,
    "minimal": 500,
}


@dataclass
class CompressionConfig:
    """Harness-specific compression profiles for Bash output.

    Different AI tools have different context window sizes.  Gemini (1 M token
    window) can afford less aggressive compression; smaller-context tools benefit
    from tighter caps.  This section controls the default profile and the
    per-profile line caps applied before output reaches the model.

    Profiles:

    * ``"auto"`` (default) — detect the harness at hook time and choose
      automatically: Gemini → ``"minimal"``; Claude Code and Codex → ``"balanced"``.
    * ``"aggressive"`` — cap output at 50 lines, apply all filters including
      dot-progress stripping.  Use for tools with very small context windows or
      when token budget is critical.
    * ``"balanced"`` — current default behaviour: apply all filters, cap at 200
      lines.  Suitable for Claude Code's 200 k token window.
    * ``"minimal"`` — skip dot-progress (``\\r``-overwrite) filtering; apply ANSI
      strip and control-char sanitization only; cap at 500 lines.  Use for large-
      context tools where progress output is tolerable noise.

    The profile can also be overridden at runtime by setting the environment
    variable ``TOKEN_GOAT_COMPRESS_PROFILE`` to one of the four values above.

    Attributes:
        profile: One of ``"auto"``, ``"aggressive"``, ``"balanced"``, ``"minimal"``.
            Default ``"auto"``.
    """

    profile: str = "auto"


@dataclass
class ContextConfig:
    """Records the model's context-window size.

    Note: the live context-pressure estimate in ``compact.get_context_pressure``
    divides the sum of known context contributors (loaded skill tokens, bash
    history, web history, read files) by the fixed autocompact budget
    (``compact.CONTEXT_AUTOCOMPACT_TOKENS``, 660 K), not by this field.  That
    budget is the point at which Claude Code triggers auto-compaction, so it is
    a model-independent basis for the fill fraction.  This field is retained for
    callers that need the raw window size and is not currently consumed by the
    fill calculation.

    Attributes:
        model_window_tokens: The model's context window size in tokens.
            Default 200_000.  Valid range: [10_000, 10_000_000].
            Override with the ``TOKEN_GOAT_MODEL_WINDOW_TOKENS`` env var.
    """

    model_window_tokens: int = 200_000


@dataclass
class InjectionConfig:
    """Configuration for prompt injection and exfiltration detection.

    Attributes:
        enabled: When ``True`` (default), fetched web content is scanned for
            injection/exfiltration patterns, warning banners are prepended when
            patterns are found, and all content is wrapped in untrusted-content
            fences.  File hints are scanned and exfiltration matches are
            redacted.  Set to ``False`` to disable all injection protection.
            Override with the ``TOKEN_GOAT_INJECTION_ENABLED`` env var.
    """

    enabled: bool = True


@dataclass
class Config:
    """Top-level token-goat configuration.

    Loaded from ``%LOCALAPPDATA%\\dfk-helper\\token-goat\\config.toml`` by ``load()``.
    Missing or unreadable files silently fall back to all defaults so token-goat
    never blocks the agent even when the config is absent.
    """

    compact_assist: CompactAssistConfig = field(default_factory=CompactAssistConfig)
    bash_compress: BashCompressConfig = field(default_factory=BashCompressConfig)
    session_brief: SessionBriefConfig = field(default_factory=SessionBriefConfig)
    skill_preservation: SkillPreservationConfig = field(default_factory=SkillPreservationConfig)
    image_shrink: ImageShrinkConfig = field(default_factory=ImageShrinkConfig)
    curator: CuratorConfig = field(default_factory=CuratorConfig)
    hint_budget: HintBudgetConfig = field(default_factory=HintBudgetConfig)
    repomap: RepomapConfig = field(default_factory=RepomapConfig)
    overflow_guard: OverflowGuardConfig = field(default_factory=OverflowGuardConfig)
    stats: StatsConfig = field(default_factory=StatsConfig)
    hints: HintsConfig = field(default_factory=HintsConfig)
    hooks: HooksConfig = field(default_factory=HooksConfig)
    webfetch: WebFetchConfig = field(default_factory=WebFetchConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    indexing: IndexingConfig = field(default_factory=IndexingConfig)
    compression: CompressionConfig = field(default_factory=CompressionConfig)
    context: ContextConfig = field(default_factory=ContextConfig)
    bash_diff: BashDiffConfig = field(default_factory=BashDiffConfig)
    bash_severity_log: SeverityLogConfig = field(default_factory=SeverityLogConfig)
    post_read_code_compress: CodeCompressConfig = field(default_factory=CodeCompressConfig)
    injection: InjectionConfig = field(default_factory=InjectionConfig)


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validated_numeric(
    val: object,
    default: int | float,
    lo: int | float,
    hi: int | float,
    name: str,
    *,
    kind: type,
    type_name: str,
) -> int | float:
    """Coerce *val* to a numeric type within ``[lo, hi]``, returning *default* on failure.

    Shared implementation for :func:`_validated_int` and :func:`_validated_float`.
    Both functions have identical structure: type-guard, bool-rejection, conversion,
    range-check, and fallback.  They differ only in which converter is applied
    (``int`` vs ``float``) and which label appears in log messages.

    Parameters
    ----------
    kind:
        The converter callable — ``int`` or ``float``.
    type_name:
        Human-readable type label for log messages — ``"int"`` or ``"float"``.
    """
    if not isinstance(val, (int, float, str)):
        _LOG.warning("config: %s=%r is not an %s; using default %s", name, val, type_name, default)
        return default
    try:
        # bool is a subclass of int; treat it as invalid since TOML true/false
        # is not a sensible value for a numeric config field.
        if isinstance(val, bool):
            _LOG.warning("config: %s=%r is not an %s; using default %s", name, val, type_name, default)
            return default
        v = kind(val)
        if not lo <= v <= hi:
            _LOG.warning(
                "config: %s=%r out of range [%s, %s]; using default %s",
                name, val, lo, hi, default,
            )
            return default
        return v
    except (TypeError, ValueError):
        _LOG.warning("config: %s=%r is not an %s; using default %s", name, val, type_name, default)
        return default


def _validated_int(val: object, default: int, lo: int, hi: int, name: str) -> int:
    """Coerce *val* to an ``int`` within ``[lo, hi]``, returning *default* on failure.

    Accepts ``int``, ``float``, or ``str`` (any type that ``int()`` can convert
    without ambiguity). Out-of-range values and non-convertible types both fall
    back to *default* with a ``WARNING`` log entry that includes the key name
    and the bad value, making misconfigured TOML easy to diagnose.
    """
    return int(_validated_numeric(val, default, lo, hi, name, kind=int, type_name="int"))


def _validated_float(val: object, default: float, lo: float, hi: float, name: str) -> float:
    """Coerce *val* to a ``float`` within ``[lo, hi]``, returning *default* on failure.

    Mirrors :func:`_validated_int` but accepts the broader numeric range needed
    for ratios and multipliers (e.g. ``auto_trigger_multiplier``).  Bool is
    rejected explicitly because ``True``/``False`` are technically convertible
    via ``float()`` but never sensible as a TOML multiplier value.
    """
    return float(_validated_numeric(val, default, lo, hi, name, kind=float, type_name="float"))


def _validated_bool(val: object, default: bool, name: str) -> bool:
    """Coerce *val* to a ``bool``, returning *default* on failure.

    Accepts ``bool`` directly or ``int`` (``0`` → ``False``, non-zero → ``True``).
    Any other type falls back to *default* with a ``WARNING`` log entry.
    TOML native booleans arrive as Python ``bool``, so the common case hits
    the first branch with no conversion overhead.
    """
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return bool(val)
    _LOG.warning("config: %s=%r is not a bool; using default %s", name, val, default)
    return default


def _validated_str_list(val: object, default: list[str], name: str) -> list[str]:
    """Validate a TOML list-of-strings, dropping non-string entries with a warning.

    Returns a fresh list copy of ``default`` when *val* is not a list at all.
    Empty lists are accepted as a meaningful value (e.g.
    ``bash_compress.disabled_filters = []`` explicitly enables every filter).
    """
    if not isinstance(val, list):
        _LOG.warning("config: %s must be a list of strings; using default %s", name, default)
        return list(default)
    valid: list[str] = []
    unknown: list[object] = []
    for item in val:
        if isinstance(item, str):
            valid.append(item)
        else:
            unknown.append(item)
    if unknown:
        _LOG.warning("config: %s contained non-string entries (ignored): %s", name, unknown)
    return valid


def _validated_int_list(val: object, default: list[int], name: str) -> list[int]:
    """Validate a TOML list-of-ints, dropping non-integer entries with a warning.

    Returns a fresh list copy of ``default`` when *val* is not a list at all.
    Empty lists are accepted as a meaningful value (disables the feature).
    Non-negative integers only; negative entries are dropped with a warning.
    The returned list is always sorted in ascending order; if the input is
    provided out of order a WARNING is logged and the sorted result is used.
    """
    if not isinstance(val, list):
        _LOG.warning("config: %s must be a list of integers; using default %s", name, default)
        return list(default)
    valid: list[int] = []
    invalid: list[object] = []
    for item in val:
        if isinstance(item, bool):
            # bool is a subclass of int in Python; reject it explicitly.
            invalid.append(item)
        elif isinstance(item, int) and item >= 0:
            valid.append(item)
        else:
            invalid.append(item)
    if invalid:
        _LOG.warning("config: %s contained invalid entries (ignored): %s", name, invalid)
    # Enforce sorted-ascending contract: the thresholds are documented as sorted
    # and callers may rely on ascending order for bisect / iteration.
    if valid != sorted(valid):
        _LOG.warning(
            "config: %s must be sorted in ascending order; got %s — using sorted: %s",
            name,
            valid,
            sorted(valid),
        )
        valid = sorted(valid)
    return valid


def _parse_prompt_triggers(val: object) -> list[PromptTrigger]:
    """Parse ``[[hints.prompt_triggers]]`` TOML array into :class:`PromptTrigger` objects.

    Each entry must be a table with a ``keywords`` list-of-strings and a ``hint`` string.
    Malformed entries are skipped with a warning; the rest are returned.
    """
    if not isinstance(val, list):
        _LOG.warning("config: hints.prompt_triggers must be a list of tables; ignoring")
        return []
    result: list[PromptTrigger] = []
    for i, entry in enumerate(val):
        if not isinstance(entry, dict):
            _LOG.warning("config: hints.prompt_triggers[%d] must be a table; skipping", i)
            continue
        kws = entry.get("keywords", [])
        hint = entry.get("hint", "")
        if not isinstance(kws, list) or not all(isinstance(k, str) for k in kws):
            _LOG.warning("config: hints.prompt_triggers[%d].keywords must be list[str]; skipping", i)
            continue
        if not isinstance(hint, str) or not hint.strip():
            _LOG.warning("config: hints.prompt_triggers[%d].hint must be a non-empty string; skipping", i)
            continue
        result.append(PromptTrigger(keywords=[k.lower() for k in kws if k.strip()], hint=hint.strip()))
    return result


_VALID_HARNESS_VALUES: Final[frozenset[str]] = frozenset(
    ["auto", "claudecode", "codex", "opencode", "generic"]
)


def _validated_harness(val: object) -> str:
    """Validate the ``compact_assist.harness`` config value.

    Returns *val* unchanged when it is one of the recognised harness strings.
    Falls back to ``"auto"`` with a WARNING log when the value is unrecognised.
    """
    if isinstance(val, str) and val in _VALID_HARNESS_VALUES:
        return val
    _LOG.warning(
        "config: compact_assist.harness=%r is not one of %s; using 'auto'",
        val,
        sorted(_VALID_HARNESS_VALUES),
    )
    return "auto"


def _validated_triggers(val: object, default: list[str]) -> list[str]:
    """Validate a list of hook-trigger strings against ``_VALID_TRIGGERS``.

    *val* must be a TOML list of strings; any element not in ``_VALID_TRIGGERS``
    is silently dropped with a ``WARNING`` log.  If *val* is not a list at all,
    or if every element is invalid, *default* is returned unchanged.  This
    prevents a misconfigured ``triggers`` key from disabling all hooks.
    """
    if not isinstance(val, list):
        _LOG.warning("config: triggers must be a list; using default %s", default)
        return list(default)
    valid: list[str] = []
    unknown: list[object] = []
    for t in val:
        if isinstance(t, str) and t in _VALID_TRIGGERS:
            valid.append(t)
        else:
            unknown.append(t)
    if unknown:
        _LOG.warning("config: unknown trigger values ignored: %s", unknown)
    return valid or list(default)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load() -> Config:
    """Load config from TOML. Returns defaults if file is absent or unreadable.

    A process-level mtime cache avoids re-parsing the TOML file on every call.
    The first call per process pays full cost; subsequent calls within the same
    process pay one ``os.stat`` (~0.1 ms) instead of stat + read_text + tomllib.loads.
    The cache is invalidated when the config file's mtime changes, so edits
    take effect on the next hook subprocess invocation.
    """
    global _config_mtime_cache  # noqa: PLW0603
    p = paths.config_path()
    # Fast path: check (mtime, env_fingerprint) against cached values.
    try:
        current_mtime: float = os.stat(p).st_mtime
    except OSError:
        current_mtime = 0.0
    current_env_fp = _config_env_fingerprint()
    if _config_mtime_cache is not None:
        cached_cfg, cached_mtime, cached_env_fp = _config_mtime_cache
        if current_mtime == cached_mtime and current_env_fp == cached_env_fp:
            return cached_cfg

    raw: _ConfigToml = cast("_ConfigToml", {})
    if p.exists():
        try:
            parsed: dict[str, Any] = tomllib.loads(p.read_text(encoding="utf-8"))
            raw = cast("_ConfigToml", parsed)
            _LOG.info("config loaded from file: %s", p)
        except (OSError, tomllib.TOMLDecodeError) as e:
            _LOG.warning("config load failed for %s (%s); using defaults", p, e)
    else:
        _LOG.info("config file not found at %s; using all defaults", p)

    # Warn on any top-level keys that token-goat doesn't recognise — almost
    # always a typo (e.g. ``[compact_assit]`` instead of ``[compact_assist]``).
    # We warn rather than crash so the rest of the config remains effective.
    for section_key in raw:
        if section_key not in _KNOWN_SECTIONS:
            _LOG.warning(
                "unknown config section: %r — check config.toml for typos"
                " (known sections: %s)",
                section_key,
                ", ".join(sorted(_KNOWN_SECTIONS)),
            )

    schema_v = raw.get("schema_version", 0)
    try:
        schema_v_int = int(schema_v) if schema_v else 0
    except (TypeError, ValueError):
        schema_v_int = 0
    if schema_v_int > CONFIG_SCHEMA_VERSION:
        _LOG.warning(
            "config schema_version %s > current %s; some keys may be ignored",
            schema_v,
            CONFIG_SCHEMA_VERSION,
        )

    ca_raw: _CompactAssistToml = cast("_CompactAssistToml", raw.get("compact_assist", {}))
    ca = CompactAssistConfig(
        enabled=_validated_bool(ca_raw.get("enabled", True), True, "compact_assist.enabled"),
        triggers=_validated_triggers(ca_raw.get("triggers", ["manual", "auto"]), ["manual", "auto"]),
        min_events=_validated_int(ca_raw.get("min_events", 3), 3, 0, 1000, "compact_assist.min_events"),
        max_manifest_tokens=_validated_int(
            ca_raw.get("max_manifest_tokens", 400), 400, 50, 10000, "compact_assist.max_manifest_tokens"
        ),
        auto_trigger_multiplier=_validated_float(
            ca_raw.get("auto_trigger_multiplier", 2.0),
            2.0, 1.0, 10.0, "compact_assist.auto_trigger_multiplier",
        ),
        # Clamp (0, 3600] seconds.  0 would disable the fast-path entirely, which
        # is fine but better expressed via [compact_assist] enabled=false; the
        # lower bound prevents accidental "never skip" + log spam.
        compact_skip_ttl_secs=_validated_float(
            ca_raw.get("compact_skip_ttl_secs", 300.0),
            300.0, 1.0, 3600.0, "compact_assist.compact_skip_ttl_secs",
        ),
        noise_floor_tokens=_validated_int(
            ca_raw.get("noise_floor_tokens", 0), 0, 0, 10000, "compact_assist.noise_floor_tokens"
        ),
        edited_dir_group_threshold=_validated_int(
            ca_raw.get("edited_dir_group_threshold", 3), 3, 0, 100, "compact_assist.edited_dir_group_threshold"
        ),
        max_section_lines=_validated_int(
            ca_raw.get("max_section_lines", 0), 0, 0, 10000, "compact_assist.max_section_lines"
        ),
        wide_session_threshold=_validated_int(
            ca_raw.get("wide_session_threshold", 15), 15, 1, 10000, "compact_assist.wide_session_threshold"
        ),
        orchestrator_commit_threshold=_validated_int(
            ca_raw.get("orchestrator_commit_threshold", 5), 5, 1, 10000, "compact_assist.orchestrator_commit_threshold"
        ),
        lazy_skill_injection=_validated_bool(
            ca_raw.get("lazy_skill_injection", True), True, "compact_assist.lazy_skill_injection"
        ),
        max_manifest_chars=_validated_int(
            ca_raw.get("max_manifest_chars", 1600), 1600, 0, 16000, "compact_assist.max_manifest_chars"
        ),
        harness=_validated_harness(ca_raw.get("harness", "auto")),
    )

    # Environment override: TOKEN_GOAT_COMPACT_ASSIST=0 / false / no / off disables
    # Also accepts legacy TOKENWISE_COMPACT_ASSIST for backward compatibility.
    # Check the canonical key first; fall back to the legacy alias.
    _env_ca_key = _ENV_COMPACT_ASSIST if os.environ.get(_ENV_COMPACT_ASSIST) else _ENV_COMPACT_ASSIST_LEGACY
    _apply_env_disable(ca, "enabled", _env_ca_key, "compact_assist")
    # TOKEN_GOAT_LAZY_SKILL_INJECTION=0 reverts to eager injection (full compact text).
    _apply_env_disable(ca, "lazy_skill_injection", _ENV_LAZY_SKILL_INJECTION, "compact_assist.lazy_skill_injection")

    bc_raw: _BashCompressToml = cast("_BashCompressToml", raw.get("bash_compress", {}))
    bc = BashCompressConfig(
        enabled=_validated_bool(bc_raw.get("enabled", True), True, "bash_compress.enabled"),
        disabled_filters=_validated_str_list(
            bc_raw.get("disabled_filters", []), [], "bash_compress.disabled_filters"
        ),
        max_lines=_validated_int(
            bc_raw.get("max_lines", 1000), 1000, 50, 100_000, "bash_compress.max_lines"
        ),
        max_bytes=_validated_int(
            bc_raw.get("max_bytes", 64 * 1024),
            64 * 1024,
            1024,
            16 * 1024 * 1024,
            "bash_compress.max_bytes",
        ),
        timeout_seconds=_validated_int(
            bc_raw.get("timeout_seconds", 600), 600, 5, 7200, "bash_compress.timeout_seconds"
        ),
        cache_min_bytes=_validated_int(
            bc_raw.get("cache_min_bytes", 0), 0, 0, 100 * 1024 * 1024, "bash_compress.cache_min_bytes"
        ),
        cache_max_file_count=_validated_int(
            bc_raw.get("cache_max_file_count", 4096), 4096, 1, 1_000_000, "bash_compress.cache_max_file_count"
        ),
        cache_max_bytes=_validated_int(
            bc_raw.get("cache_max_bytes", 16 * 1024 * 1024),
            16 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024, "bash_compress.cache_max_bytes",
        ),
        cache_max_bytes_per_output=_validated_int(
            bc_raw.get("cache_max_bytes_per_output", 50 * 1024 * 1024),
            50 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024, "bash_compress.cache_max_bytes_per_output",
        ),
    )
    _apply_env_disable(bc, "enabled", _ENV_BASH_COMPRESS, "bash_compress")
    # Apply env overrides for bash output cache caps
    bc.cache_min_bytes = _env_int(
        _ENV_BASH_CACHE_MIN_BYTES, bc.cache_min_bytes, 0, 4 * 1024 * 1024 * 1024, "bash_compress.cache_min_bytes"
    )
    bc.cache_max_file_count = _env_int(
        _ENV_BASH_CACHE_MAX_FILES, bc.cache_max_file_count, 1, 1_000_000, "bash_compress.cache_max_file_count"
    )
    bc.cache_max_bytes = _env_int(
        _ENV_BASH_CACHE_MAX_BYTES, bc.cache_max_bytes, 1024, 4 * 1024 * 1024 * 1024, "bash_compress.cache_max_bytes"
    )
    bc.cache_max_bytes_per_output = _env_int(
        _ENV_BASH_CACHE_MAX_BYTES_PER_OUTPUT, bc.cache_max_bytes_per_output, 1024, 4 * 1024 * 1024 * 1024, "bash_compress.cache_max_bytes_per_output"
    )

    sb_raw: _SessionBriefToml = cast("_SessionBriefToml", raw.get("session_brief", {}))
    sb = SessionBriefConfig(
        enabled=_validated_bool(sb_raw.get("enabled", True), True, "session_brief.enabled"),
    )
    _apply_env_disable(sb, "enabled", _ENV_SESSION_BRIEF, "session_brief")

    sp_raw: _SkillPreservationToml = cast("_SkillPreservationToml", raw.get("skill_preservation", {}))
    sp = SkillPreservationConfig(
        enabled=_validated_bool(sp_raw.get("enabled", True), True, "skill_preservation.enabled"),
        max_cache_bytes=_validated_int(
            sp_raw.get("max_cache_bytes", 5 * 1024 * 1024),
            5 * 1024 * 1024,
            64 * 1024,           # 64 KB floor — must hold at least one tiny skill
            512 * 1024 * 1024,   # 512 MB ceiling — generous; skills are not that big
            "skill_preservation.max_cache_bytes",
        ),
        orphan_sweep_enabled=_validated_bool(
            sp_raw.get("orphan_sweep_enabled", True), True, "skill_preservation.orphan_sweep_enabled",
        ),
        orphan_age_secs=_validated_int(
            sp_raw.get("orphan_age_secs", 604800), 604800, 1, 2_592_000, "skill_preservation.orphan_age_secs",
        ),
        truncation_budget_tokens=_validated_int(
            sp_raw.get("truncation_budget_tokens", 800), 800, 0, 8000,
            "skill_preservation.truncation_budget_tokens",
        ),
        compress_bodies=_validated_bool(
            sp_raw.get("compress_bodies", True), True, "skill_preservation.compress_bodies",
        ),
        compress_min_bytes=_validated_int(
            sp_raw.get("compress_min_bytes", 16 * 1024), 16 * 1024, 1024, 10 * 1024 * 1024,
            "skill_preservation.compress_min_bytes",
        ),
        inline_snippets=_validated_bool(
            sp_raw.get("inline_snippets", True), True, "skill_preservation.inline_snippets",
        ),
        pre_skill_enabled=_validated_bool(
            sp_raw.get("pre_skill_enabled", True), True, "skill_preservation.pre_skill_enabled",
        ),
        first_load_compact=_validated_bool(
            sp_raw.get("first_load_compact", False), False, "skill_preservation.first_load_compact",
        ),
        post_compact_full_loads=_validated_bool(
            sp_raw.get("post_compact_full_loads", False), False, "skill_preservation.post_compact_full_loads",
        ),
    )
    _apply_env_disable(sp, "enabled", _ENV_SKILL_PRESERVATION, "skill_preservation")
    _apply_env_disable(sp, "orphan_sweep_enabled", _ENV_ORPHAN_SWEEP, "skill_preservation.orphan_sweep_enabled")
    _apply_env_disable(sp, "compress_bodies", _ENV_SKILL_COMPRESS, "skill_preservation.compress_bodies")
    _apply_env_disable(sp, "pre_skill_enabled", "TOKEN_GOAT_PRE_SKILL", "skill_preservation.pre_skill_enabled")

    is_raw: _ImageShrinkToml = cast("_ImageShrinkToml", raw.get("image_shrink", {}))
    is_cfg = ImageShrinkConfig(
        prefer_avif=_validated_bool(is_raw.get("prefer_avif", True), True, "image_shrink.prefer_avif"),
        avif_quality=_validated_int(is_raw.get("avif_quality", 60), 60, 1, 100, "image_shrink.avif_quality"),
        jpeg_quality=_validated_int(is_raw.get("jpeg_quality", 75), 75, 1, 100, "image_shrink.jpeg_quality"),
        max_image_pixels=_validated_int(
            is_raw.get("max_image_pixels", 16_000_000),
            16_000_000,
            0,
            500_000_000,
            "image_shrink.max_image_pixels",
        ),
        orphan_sweep_enabled=_validated_bool(is_raw.get("orphan_sweep_enabled", True), True, "image_shrink.orphan_sweep_enabled"),
        orphan_age_secs=_validated_int(is_raw.get("orphan_age_secs", 604800), 604800, 1, 2_592_000, "image_shrink.orphan_age_secs"),
    )
    _apply_env_disable(is_cfg, "prefer_avif", _ENV_PREFER_AVIF, "image_shrink.prefer_avif")
    _apply_env_disable(is_cfg, "orphan_sweep_enabled", _ENV_ORPHAN_SWEEP, "image_shrink.orphan_sweep_enabled")

    cur_raw: _CuratorToml = cast("_CuratorToml", raw.get("curator", {}))
    cur = CuratorConfig(
        enabled=_validated_bool(cur_raw.get("enabled", True), True, "curator.enabled"),
        min_samples=_validated_int(cur_raw.get("min_samples", 10), 10, 1, 10_000, "curator.min_samples"),
        threshold_pct=_validated_int(cur_raw.get("threshold_pct", 20), 20, 0, 100, "curator.threshold_pct"),
    )
    _apply_env_disable(cur, "enabled", _ENV_CURATOR, "curator")

    hb_raw: _HintBudgetToml = cast("_HintBudgetToml", raw.get("hint_budget", {}))
    hb = HintBudgetConfig(
        enabled=_validated_bool(hb_raw.get("enabled", True), True, "hint_budget.enabled"),
        max_per_session=_validated_int(
            hb_raw.get("max_per_session", 100), 100, 0, 1_000_000, "hint_budget.max_per_session",
        ),
        max_structured_per_session=_validated_int(
            hb_raw.get("max_structured_per_session", 30), 30, 0, 1_000_000, "hint_budget.max_structured_per_session",
        ),
        max_index_only_per_session=_validated_int(
            hb_raw.get("max_index_only_per_session", 30), 30, 0, 1_000_000, "hint_budget.max_index_only_per_session",
        ),
    )
    _apply_env_disable(hb, "enabled", _ENV_HINT_BUDGET, "hint_budget")

    rm_raw: _RepomapToml = cast("_RepomapToml", raw.get("repomap", {}))
    rm = RepomapConfig(
        compact_file_threshold=_validated_int(
            rm_raw.get("compact_file_threshold", 50),
            50,
            0,
            100_000,
            "repomap.compact_file_threshold",
        ),
        exclude_tests=_validated_bool(
            rm_raw.get("exclude_tests", True), True, "repomap.exclude_tests"
        ),
    )
    # Apply env override for repomap compact file threshold
    rm.compact_file_threshold = _env_int(
        _ENV_REPOMAP_COMPACT_THRESHOLD, rm.compact_file_threshold, 0, 100_000, "repomap.compact_file_threshold"
    )

    og_raw: _OverflowGuardToml = cast("_OverflowGuardToml", raw.get("overflow_guard", {}))
    og = OverflowGuardConfig(
        enabled=_validated_bool(og_raw.get("enabled", True), True, "overflow_guard.enabled"),
        max_tokens=_validated_int(
            og_raw.get("max_tokens", 25000), 25000, 0, 10_000_000, "overflow_guard.max_tokens"
        ),
    )
    _apply_env_disable(og, "enabled", _ENV_OVERFLOW_GUARD, "overflow_guard.enabled")
    og.max_tokens = _env_int(
        _ENV_OVERFLOW_MAX_TOKENS, og.max_tokens, 0, 10_000_000, "overflow_guard.max_tokens"
    )

    stats_raw: _StatsToml = cast("_StatsToml", raw.get("stats", {}))
    stats = StatsConfig(
        record_zero_savings=_validated_bool(
            stats_raw.get("record_zero_savings", False), False, "stats.record_zero_savings"
        ),
    )

    hints_raw: _HintsToml = cast("_HintsToml", raw.get("hints", {}))
    hints_cfg = HintsConfig(
        suppress_after_ignored=_validated_int(
            hints_raw.get("suppress_after_ignored", 5), 5, 0, 1000, "hints.suppress_after_ignored"
        ),
        quiet_hours=str(hints_raw.get("quiet_hours", "")).strip(),
        json_sidecar=_validated_bool(
            hints_raw.get("json_sidecar", False), False, "hints.json_sidecar"
        ),
        verbose_until_seen_count=_validated_int(
            hints_raw.get("verbose_until_seen_count", 2), 2, 0, 1000, "hints.verbose_until_seen_count"
        ),
        min_file_lines_for_hint=_validated_int(
            hints_raw.get("min_file_lines_for_hint", 0), 0, 0, 100000, "hints.min_file_lines_for_hint"
        ),
        bash_dedup_min_bytes=_validated_int(
            hints_raw.get("bash_dedup_min_bytes", 200), 200, 0, 100000, "hints.bash_dedup_min_bytes"
        ),
        web_dedup_min_bytes=_validated_int(
            hints_raw.get("web_dedup_min_bytes", 200), 200, 0, 100000, "hints.web_dedup_min_bytes"
        ),
        grep_dedup_min_matches=_validated_int(
            hints_raw.get("grep_dedup_min_matches", 5), 5, 0, 100000, "hints.grep_dedup_min_matches"
        ),
        serve_diff_on_reread=_validated_bool(
            hints_raw.get("serve_diff_on_reread", False), False, "hints.serve_diff_on_reread"
        ),
        backoff_thresholds=_validated_int_list(
            hints_raw.get("backoff_thresholds", [1, 3, 10, 30]),
            [1, 3, 10, 30],
            "hints.backoff_thresholds",
        ),
        git_hint_max_ms=_validated_int(
            hints_raw.get("git_hint_max_ms", 50), 50, 0, 10000, "hints.git_hint_max_ms"
        ),
        min_session_hint_savings_bytes=_validated_int(
            hints_raw.get("min_session_hint_savings_bytes", 512), 512, 0, 1_000_000,
            "hints.min_session_hint_savings_bytes",
        ),
        diff_hint_min_tokens_saved=_validated_int(
            hints_raw.get("diff_hint_min_tokens_saved", 1000), 1000, 0, 100_000,
            "hints.diff_hint_min_tokens_saved",
        ),
        large_read_redirect_bytes=_validated_int(
            hints_raw.get("large_read_redirect_bytes", 45_000), 45_000, 0, 100_000_000,
            "hints.large_read_redirect_bytes",
        ),
        reread_deny=_validated_bool(
            hints_raw.get("reread_deny", True), True, "hints.reread_deny"
        ),
        reread_deny_min_bytes=_validated_int(
            hints_raw.get("reread_deny_min_bytes", 2048), 2048, 0, 100_000_000,
            "hints.reread_deny_min_bytes",
        ),
        baseline_budget_tokens=_validated_int(
            hints_raw.get("baseline_budget_tokens", 0), 0, 0, 10_000_000,
            "hints.baseline_budget_tokens",
        ),
        prompt_triggers=_parse_prompt_triggers(hints_raw.get("prompt_triggers", [])),
        truncated_read_min_lines=_validated_int(
            hints_raw.get("truncated_read_min_lines", 200), 200, 0, 1_000_000,
            "hints.truncated_read_min_lines",
        ),
        protect_recent_reads=_validated_int(
            hints_raw.get("protect_recent_reads", 4), 4, 0, 100,
            "hints.protect_recent_reads",
        ),
    )
    # Opt-in env override: TOKEN_GOAT_HINT_JSON_SIDECAR=1/true/yes/on enables.
    _apply_env_enable(hints_cfg, "json_sidecar", _ENV_HINT_JSON_SIDECAR, "hints.json_sidecar")
    # Opt-in env override: TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1/true/yes/on enables.
    _apply_env_enable(hints_cfg, "serve_diff_on_reread", _ENV_SERVE_DIFF_ON_REREAD, "hints.serve_diff_on_reread")
    # Integer env overrides for dedup thresholds
    hints_cfg.bash_dedup_min_bytes = _env_int(
        _ENV_BASH_DEDUP_MIN_BYTES, hints_cfg.bash_dedup_min_bytes, 0, 100000, "hints.bash_dedup_min_bytes"
    )
    hints_cfg.web_dedup_min_bytes = _env_int(
        _ENV_WEB_DEDUP_MIN_BYTES, hints_cfg.web_dedup_min_bytes, 0, 100000, "hints.web_dedup_min_bytes"
    )
    hints_cfg.grep_dedup_min_matches = _env_int(
        _ENV_GREP_DEDUP_MIN_MATCHES, hints_cfg.grep_dedup_min_matches, 0, 100000, "hints.grep_dedup_min_matches"
    )
    hints_cfg.min_session_hint_savings_bytes = _env_int(
        "TOKEN_GOAT_SESSION_HINT_MIN_BYTES",
        hints_cfg.min_session_hint_savings_bytes,
        0, 1_000_000, "hints.min_session_hint_savings_bytes"
    )
    hints_cfg.large_read_redirect_bytes = _env_int(
        _ENV_LARGE_READ_BYTES,
        hints_cfg.large_read_redirect_bytes,
        0, 100_000_000, "hints.large_read_redirect_bytes"
    )
    hints_cfg.baseline_budget_tokens = _env_int(
        _ENV_BASELINE_BUDGET_TOKENS,
        hints_cfg.baseline_budget_tokens,
        0, 10_000_000, "hints.baseline_budget_tokens"
    )

    wf_raw: _WebFetchToml = cast("_WebFetchToml", raw.get("webfetch", {}))
    wf_cfg = WebFetchConfig(
        allow=_validated_str_list(wf_raw.get("allow", []), [], "webfetch.allow"),
        deny=_validated_str_list(wf_raw.get("deny", []), [], "webfetch.deny"),
        max_file_count=_validated_int(
            wf_raw.get("max_file_count", 4096), 4096, 1, 1_000_000, "webfetch.max_file_count",
        ),
        max_bytes=_validated_int(
            wf_raw.get("max_bytes", 32 * 1024 * 1024),
            32 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024, "webfetch.max_bytes",
        ),
        compress_bodies=_validated_bool(
            wf_raw.get("compress_bodies", True), True, "webfetch.compress_bodies",
        ),
        compress_min_bytes=_validated_int(
            wf_raw.get("compress_min_bytes", 16 * 1024), 16 * 1024, 1024, 10 * 1024 * 1024,
            "webfetch.compress_min_bytes",
        ),
    )
    # Apply env overrides for web cache caps
    wf_cfg.max_file_count = _env_int(
        _ENV_WEB_CACHE_MAX_FILES, wf_cfg.max_file_count, 1, 1_000_000, "webfetch.max_file_count"
    )
    wf_cfg.max_bytes = _env_int(
        _ENV_WEB_CACHE_MAX_BYTES, wf_cfg.max_bytes, 1024, 4 * 1024 * 1024 * 1024, "webfetch.max_bytes"
    )
    _apply_env_disable(wf_cfg, "compress_bodies", _ENV_WEB_COMPRESS, "webfetch.compress_bodies")

    wk_raw: _WorkerToml = cast("_WorkerToml", raw.get("worker", {}))
    wk = WorkerConfig(
        watchdog_enabled=_validated_bool(
            wk_raw.get("watchdog_enabled", True), True, "worker.watchdog_enabled"
        ),
        max_pool_workers=_validated_int(
            wk_raw.get("max_pool_workers", 4), 4, 1, WORKER_MAX_POOL_CEILING,
            "worker.max_pool_workers",
        ),
    )
    _apply_env_disable(wk, "watchdog_enabled", _ENV_WORKER_WATCHDOG, "worker.watchdog_enabled")
    # Apply env override for pool size; clamp to [1, ceiling] after any override.
    wk.max_pool_workers = _env_int(
        _ENV_WORKER_MAX_POOL, wk.max_pool_workers, 1, WORKER_MAX_POOL_CEILING,
        "worker.max_pool_workers",
    )
    # Enforce ceiling regardless of how the value was set.
    if wk.max_pool_workers > WORKER_MAX_POOL_CEILING:
        _LOG.warning(
            "worker.max_pool_workers=%d exceeds hard ceiling %d; clamping",
            wk.max_pool_workers, WORKER_MAX_POOL_CEILING,
        )
        wk.max_pool_workers = WORKER_MAX_POOL_CEILING

    hk_raw: _HooksToml = cast("_HooksToml", raw.get("hooks", {}))
    hk = HooksConfig(
        watchdog_ms=_validated_int(
            hk_raw.get("watchdog_ms", 5000), 5000, 100, 30_000, "hooks.watchdog_ms"
        ),
    )
    # Apply env override for hook watchdog (if set, takes precedence)
    hk.watchdog_ms = _env_int(
        "TOKEN_GOAT_HOOK_WATCHDOG_MS", hk.watchdog_ms, 100, 30_000, "hooks.watchdog_ms"
    )

    idx_raw: _IndexingToml = cast("_IndexingToml", raw.get("indexing", {}))
    _idx_symbol_only_kb = _validated_int(
        idx_raw.get("large_file_symbol_only_kb", 500),
        500, 1, 1_048_576, "indexing.large_file_symbol_only_kb",
    )
    _idx_skip_kb = _validated_int(
        idx_raw.get("large_file_skip_kb", 2048),
        2048, 1, 1_048_576, "indexing.large_file_skip_kb",
    )
    # Ensure skip >= symbol_only: if someone sets skip < symbol_only in TOML,
    # clamp skip up to symbol_only so the tiers don't overlap in a confusing way.
    if _idx_skip_kb < _idx_symbol_only_kb:
        _LOG.warning(
            "config: indexing.large_file_skip_kb (%d) < large_file_symbol_only_kb (%d); "
            "clamping skip_kb to symbol_only_kb",
            _idx_skip_kb, _idx_symbol_only_kb,
        )
        _idx_skip_kb = _idx_symbol_only_kb
    _idx_skip_dirs_raw = idx_raw.get("skip_dirs", [])
    if not isinstance(_idx_skip_dirs_raw, list):
        _LOG.warning("config: indexing.skip_dirs must be a list; ignoring")
        _idx_skip_dirs_raw = []
    _idx_skip_dirs: list[str] = [str(d) for d in _idx_skip_dirs_raw if isinstance(d, str)]
    idx_cfg = IndexingConfig(
        large_file_symbol_only_kb=_idx_symbol_only_kb,
        large_file_skip_kb=_idx_skip_kb,
        skip_dirs=_idx_skip_dirs,
    )

    cmp_raw: _CompressionToml = cast("_CompressionToml", raw.get("compression", {}))
    _cmp_profile_raw = str(cmp_raw.get("profile", "auto")).strip().lower()
    if _cmp_profile_raw not in _VALID_COMPRESSION_PROFILES:
        _LOG.warning(
            "config: compression.profile=%r is not valid (expected %s); using 'auto'",
            _cmp_profile_raw,
            ", ".join(sorted(_VALID_COMPRESSION_PROFILES)),
        )
        _cmp_profile_raw = "auto"
    # Env override: TOKEN_GOAT_COMPRESS_PROFILE takes precedence over config file.
    _cmp_profile_env = os.environ.get(_ENV_COMPRESS_PROFILE, "").strip().lower()
    if _cmp_profile_env:
        if _cmp_profile_env in _VALID_COMPRESSION_PROFILES:
            _LOG.info(
                "compression.profile overridden by environment: %s=%s",
                _ENV_COMPRESS_PROFILE,
                _cmp_profile_env,
            )
            _cmp_profile_raw = _cmp_profile_env
        else:
            _LOG.warning(
                "compression.profile env override %r not valid (expected %s); ignoring",
                _cmp_profile_env,
                ", ".join(sorted(_VALID_COMPRESSION_PROFILES)),
            )
    cmp_cfg = CompressionConfig(profile=_cmp_profile_raw)

    ctx_raw: _ContextToml = cast("_ContextToml", raw.get("context", {}))
    _ctx_window = _validated_int(
        ctx_raw.get("model_window_tokens", 200_000),
        200_000, 10_000, 10_000_000, "context.model_window_tokens",
    )
    _ctx_window = _env_int("TOKEN_GOAT_MODEL_WINDOW_TOKENS", _ctx_window, 10_000, 10_000_000, "context.model_window_tokens")
    ctx_cfg = ContextConfig(model_window_tokens=_ctx_window)

    bd_raw = cast("dict[str, Any]", raw.get("bash_diff", {}))
    bd_cfg = BashDiffConfig(
        max_hunks_per_file=_validated_int(bd_raw.get("max_hunks_per_file", 10), 10, 0, 10000, "bash_diff.max_hunks_per_file"),
        hunk_density_cap=_validated_bool(bd_raw.get("hunk_density_cap", True), True, "bash_diff.hunk_density_cap"),
    )
    bsl_raw = cast("dict[str, Any]", raw.get("bash_severity_log", {}))
    bsl_cfg = SeverityLogConfig(
        context_lines=_validated_int(bsl_raw.get("context_lines", 3), 3, 0, 100, "bash_severity_log.context_lines"),
        score_threshold=_validated_float(bsl_raw.get("score_threshold", 0.5), 0.5, 0.0, 1.0, "bash_severity_log.score_threshold"),
    )
    prc_raw = cast("dict[str, Any]", cast("dict[str, Any]", raw.get("post_read", {})).get("code_compress", {}))
    prc_cfg = CodeCompressConfig(
        min_lines=_validated_int(prc_raw.get("min_lines", 200), 200, 1, 100_000, "post_read.code_compress.min_lines"),
    )
    inj_raw: _InjectionToml = cast("_InjectionToml", raw.get("injection", {}))
    inj_cfg = InjectionConfig(
        enabled=_validated_bool(inj_raw.get("enabled", True), True, "injection.enabled"),
    )
    inj_cfg.enabled = _env_bool("TOKEN_GOAT_INJECTION_ENABLED", inj_cfg.enabled)

    _LOG.debug(
        "config resolved: compact_assist enabled=%s triggers=%s min_events=%d max_tokens=%d; "
        "bash_compress enabled=%s disabled_filters=%s max_lines=%d max_bytes=%d timeout=%d cache_files=%d cache_bytes=%d; "
        "session_brief enabled=%s; "
        "skill_preservation enabled=%s max_cache_bytes=%d truncation_budget_tokens=%d; "
        "image_shrink prefer_avif=%s avif_quality=%d jpeg_quality=%d max_image_pixels=%d; "
        "curator enabled=%s min_samples=%d threshold_pct=%d; "
        "hint_budget enabled=%s max=%d max_structured=%d max_index_only=%d; "
        "repomap compact_file_threshold=%d; "
        "stats record_zero_savings=%s; "
        "hints suppress_after_ignored=%d quiet_hours=%r; "
        "webfetch allow=%s deny=%s max_files=%d max_bytes=%d; "
        "worker watchdog_enabled=%s max_pool_workers=%d",
        ca.enabled,
        ca.triggers,
        ca.min_events,
        ca.max_manifest_tokens,
        bc.enabled,
        bc.disabled_filters,
        bc.max_lines,
        bc.max_bytes,
        bc.timeout_seconds,
        bc.cache_max_file_count,
        bc.cache_max_bytes,
        sb.enabled,
        sp.enabled,
        sp.max_cache_bytes,
        sp.truncation_budget_tokens,
        is_cfg.prefer_avif,
        is_cfg.avif_quality,
        is_cfg.jpeg_quality,
        is_cfg.max_image_pixels,
        cur.enabled,
        cur.min_samples,
        cur.threshold_pct,
        hb.enabled,
        hb.max_per_session,
        hb.max_structured_per_session,
        hb.max_index_only_per_session,
        rm.compact_file_threshold,
        stats.record_zero_savings,
        hints_cfg.suppress_after_ignored,
        hints_cfg.quiet_hours,
        wf_cfg.allow,
        wf_cfg.deny,
        wf_cfg.max_file_count,
        wf_cfg.max_bytes,
        wk.watchdog_enabled,
        wk.max_pool_workers,
    )
    result = Config(
        compact_assist=ca, bash_compress=bc, session_brief=sb, skill_preservation=sp,
        image_shrink=is_cfg, curator=cur, hint_budget=hb, repomap=rm, overflow_guard=og,
        stats=stats,
        hints=hints_cfg, hooks=hk, webfetch=wf_cfg, worker=wk, indexing=idx_cfg,
        compression=cmp_cfg, context=ctx_cfg, bash_diff=bd_cfg, bash_severity_log=bsl_cfg,
        post_read_code_compress=prc_cfg, injection=inj_cfg,
    )
    _config_mtime_cache = (result, current_mtime, current_env_fp)
    return result


def save(config: Config) -> None:
    """Persist config to TOML atomically, creating parent dirs as needed."""
    global _config_mtime_cache  # noqa: PLW0603
    import tomli_w  # noqa: PLC0415

    p = paths.config_path()
    paths.ensure_dir(p.parent)
    ca = config.compact_assist
    bc = config.bash_compress
    sb = config.session_brief
    sp = config.skill_preservation
    is_cfg = config.image_shrink
    cur = config.curator
    hb = config.hint_budget
    stats = config.stats
    data: _ConfigToml = {
        "schema_version": CONFIG_SCHEMA_VERSION,
        "compact_assist": {
            "enabled": ca.enabled,
            "triggers": ca.triggers,
            "min_events": ca.min_events,
            "max_manifest_tokens": ca.max_manifest_tokens,
            "auto_trigger_multiplier": ca.auto_trigger_multiplier,
            "compact_skip_ttl_secs": ca.compact_skip_ttl_secs,
            "noise_floor_tokens": ca.noise_floor_tokens,
            "edited_dir_group_threshold": ca.edited_dir_group_threshold,
            "max_section_lines": ca.max_section_lines,
            "wide_session_threshold": ca.wide_session_threshold,
            "orchestrator_commit_threshold": ca.orchestrator_commit_threshold,
            "lazy_skill_injection": ca.lazy_skill_injection,
        },
        "bash_compress": {
            "enabled": bc.enabled,
            "disabled_filters": bc.disabled_filters,
            "max_lines": bc.max_lines,
            "max_bytes": bc.max_bytes,
            "timeout_seconds": bc.timeout_seconds,
            "cache_max_file_count": bc.cache_max_file_count,
            "cache_max_bytes": bc.cache_max_bytes,
        },
        "session_brief": {
            "enabled": sb.enabled,
        },
        "skill_preservation": {
            "enabled": sp.enabled,
            "max_cache_bytes": sp.max_cache_bytes,
            "orphan_sweep_enabled": sp.orphan_sweep_enabled,
            "orphan_age_secs": sp.orphan_age_secs,
            "truncation_budget_tokens": sp.truncation_budget_tokens,
            "compress_bodies": sp.compress_bodies,
            "compress_min_bytes": sp.compress_min_bytes,
            "inline_snippets": sp.inline_snippets,
        },
        "image_shrink": {
            "prefer_avif": is_cfg.prefer_avif,
            "avif_quality": is_cfg.avif_quality,
            "jpeg_quality": is_cfg.jpeg_quality,
            "max_image_pixels": is_cfg.max_image_pixels,
            "orphan_sweep_enabled": is_cfg.orphan_sweep_enabled,
            "orphan_age_secs": is_cfg.orphan_age_secs,
        },
        "curator": {
            "enabled": cur.enabled,
            "min_samples": cur.min_samples,
            "threshold_pct": cur.threshold_pct,
        },
        "hint_budget": {
            "enabled": hb.enabled,
            "max_per_session": hb.max_per_session,
            "max_structured_per_session": hb.max_structured_per_session,
            "max_index_only_per_session": hb.max_index_only_per_session,
        },
        "repomap": {
            "compact_file_threshold": config.repomap.compact_file_threshold,
            "exclude_tests": config.repomap.exclude_tests,
        },
        "overflow_guard": {
            "enabled": config.overflow_guard.enabled,
            "max_tokens": config.overflow_guard.max_tokens,
        },
        "stats": {
            "record_zero_savings": stats.record_zero_savings,
        },
        "hints": {
            "suppress_after_ignored": config.hints.suppress_after_ignored,
            "quiet_hours": config.hints.quiet_hours,
            "json_sidecar": config.hints.json_sidecar,
            "verbose_until_seen_count": config.hints.verbose_until_seen_count,
            "min_file_lines_for_hint": config.hints.min_file_lines_for_hint,
            "bash_dedup_min_bytes": config.hints.bash_dedup_min_bytes,
            "web_dedup_min_bytes": config.hints.web_dedup_min_bytes,
            "grep_dedup_min_matches": config.hints.grep_dedup_min_matches,
        },
        "webfetch": {
            "allow": config.webfetch.allow,
            "deny": config.webfetch.deny,
            "max_file_count": config.webfetch.max_file_count,
            "max_bytes": config.webfetch.max_bytes,
            "compress_bodies": config.webfetch.compress_bodies,
            "compress_min_bytes": config.webfetch.compress_min_bytes,
        },
        "worker": {
            "watchdog_enabled": config.worker.watchdog_enabled,
            "max_pool_workers": config.worker.max_pool_workers,
        },
        "indexing": {
            "large_file_symbol_only_kb": config.indexing.large_file_symbol_only_kb,
            "large_file_skip_kb": config.indexing.large_file_skip_kb,
            "skip_dirs": config.indexing.skip_dirs,
        },
        "compression": {
            "profile": config.compression.profile,
        },
        "injection": {
            "enabled": config.injection.enabled,
        },
    }
    try:
        # _ConfigToml is a TypedDict — a subtype of dict — so tomli_w.dumps
        # (which accepts Mapping[str, Any]) does not require a cast here.
        paths.atomic_write_bytes(p, tomli_w.dumps(data).encode("utf-8"))
        # Invalidate the process-level cache so the next load() re-reads the
        # file we just wrote rather than serving the pre-save cached value.
        _config_mtime_cache = None
    except OSError as e:
        _LOG.warning("config save failed: %s", e)
