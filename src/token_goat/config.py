"""Config loader/saver for token-goat. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

__all__ = [
    "BashCompressConfig",
    "CompactAssistConfig",
    "Config",
    "CuratorConfig",
    "HintBudgetConfig",
    "ImageShrinkConfig",
    "SessionBriefConfig",
    "SkillPreservationConfig",
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

_ENV_COMPACT_ASSIST: Final[str] = "TOKEN_GOAT_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable
_ENV_COMPACT_ASSIST_LEGACY: Final[str] = "TOKENWISE_COMPACT_ASSIST"  # backward-compat alias
_ENV_BASH_COMPRESS: Final[str] = "TOKEN_GOAT_BASH_COMPRESS"  # set to "0"/"false"/"no"/"off" to disable
_ENV_SESSION_BRIEF: Final[str] = "TOKEN_GOAT_SESSION_BRIEF"  # set to "0"/"false"/"no"/"off" to disable
_ENV_SKILL_PRESERVATION: Final[str] = "TOKEN_GOAT_SKILL_PRESERVATION"  # set to "0"/"false"/"no"/"off" to disable
_ENV_PREFER_AVIF: Final[str] = "TOKEN_GOAT_PREFER_AVIF"  # set to "0"/"false"/"no"/"off" to force JPEG/WebP
_ENV_CURATOR: Final[str] = "TOKEN_GOAT_CURATOR"  # set to "0"/"false"/"no"/"off" to disable
_ENV_HINT_BUDGET: Final[str] = "TOKEN_GOAT_HINT_BUDGET"  # set to "0"/"false"/"no"/"off" to disable

CONFIG_SCHEMA_VERSION: Final[int] = 1

_VALID_TRIGGERS: Final[frozenset[str]] = frozenset(["manual", "auto"])


class _CompactAssistToml(TypedDict, total=False):
    """Expected shape of the [compact_assist] TOML section."""

    enabled: bool
    triggers: list[str]
    min_events: int
    max_manifest_tokens: int


class _BashCompressToml(TypedDict, total=False):
    """Expected shape of the [bash_compress] TOML section."""

    enabled: bool
    disabled_filters: list[str]
    max_lines: int
    max_bytes: int
    timeout_seconds: int


class _SessionBriefToml(TypedDict, total=False):
    """Expected shape of the [session_brief] TOML section."""

    enabled: bool


class _SkillPreservationToml(TypedDict, total=False):
    """Expected shape of the [skill_preservation] TOML section."""

    enabled: bool
    max_cache_bytes: int


class _ImageShrinkToml(TypedDict, total=False):
    """Expected shape of the [image_shrink] TOML section."""

    prefer_avif: bool
    avif_quality: int
    jpeg_quality: int


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
    """

    enabled: bool = True
    disabled_filters: list[str] = field(default_factory=list)
    max_lines: int = 1000
    max_bytes: int = 64 * 1024
    timeout_seconds: int = 600


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
    """

    enabled: bool = True
    max_cache_bytes: int = 5 * 1024 * 1024


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
    """

    prefer_avif: bool = True
    avif_quality: int = 60
    jpeg_quality: int = 75


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


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validated_int(val: object, default: int, lo: int, hi: int, name: str) -> int:
    """Coerce *val* to an ``int`` within ``[lo, hi]``, returning *default* on failure.

    Accepts ``int``, ``float``, or ``str`` (any type that ``int()`` can convert
    without ambiguity). Out-of-range values and non-convertible types both fall
    back to *default* with a ``WARNING`` log entry that includes the key name
    and the bad value, making misconfigured TOML easy to diagnose.
    """
    if not isinstance(val, (int, float, str)):
        _LOG.warning("config: %s=%r is not an int; using default %d", name, val, default)
        return default
    try:
        # bool is a subclass of int; treat it as invalid since TOML true/false
        # is not a sensible value for an integer config field.
        if isinstance(val, bool):
            _LOG.warning("config: %s=%r is not an int; using default %d", name, val, default)
            return default
        v = int(val)
        if not lo <= v <= hi:
            _LOG.warning("config: %s=%r out of range [%d, %d]; using default %d", name, val, lo, hi, default)
            return default
        return v
    except (TypeError, ValueError):
        _LOG.warning("config: %s=%r is not an int; using default %d", name, val, default)
        return default


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
    return valid if valid else list(default)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load() -> Config:
    """Load config from TOML. Returns defaults if file is absent or unreadable."""
    p = paths.config_path()
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
    )

    # Environment override: TOKEN_GOAT_COMPACT_ASSIST=0 / false / no / off disables
    # Also accepts legacy TOKENWISE_COMPACT_ASSIST for backward compatibility.
    env_val = (
        os.environ.get(_ENV_COMPACT_ASSIST, "")
        or os.environ.get(_ENV_COMPACT_ASSIST_LEGACY, "")
    ).strip().lower()
    if env_val in ("0", "false", "no", "off"):
        _LOG.info(
            "compact_assist disabled by environment variable (%s=%s)",
            _ENV_COMPACT_ASSIST,
            env_val,
        )
        ca.enabled = False

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
    )
    env_bash = os.environ.get(_ENV_BASH_COMPRESS, "").strip().lower()
    if env_bash in ("0", "false", "no", "off"):
        _LOG.info(
            "bash_compress disabled by environment variable (%s=%s)",
            _ENV_BASH_COMPRESS,
            env_bash,
        )
        bc.enabled = False

    sb_raw: _SessionBriefToml = cast("_SessionBriefToml", raw.get("session_brief", {}))
    sb = SessionBriefConfig(
        enabled=_validated_bool(sb_raw.get("enabled", True), True, "session_brief.enabled"),
    )
    env_brief = os.environ.get(_ENV_SESSION_BRIEF, "").strip().lower()
    if env_brief in ("0", "false", "no", "off"):
        _LOG.info(
            "session_brief disabled by environment variable (%s=%s)",
            _ENV_SESSION_BRIEF,
            env_brief,
        )
        sb.enabled = False

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
    )
    env_skill = os.environ.get(_ENV_SKILL_PRESERVATION, "").strip().lower()
    if env_skill in ("0", "false", "no", "off"):
        _LOG.info(
            "skill_preservation disabled by environment variable (%s=%s)",
            _ENV_SKILL_PRESERVATION,
            env_skill,
        )
        sp.enabled = False

    is_raw: _ImageShrinkToml = cast("_ImageShrinkToml", raw.get("image_shrink", {}))
    is_cfg = ImageShrinkConfig(
        prefer_avif=_validated_bool(is_raw.get("prefer_avif", True), True, "image_shrink.prefer_avif"),
        avif_quality=_validated_int(is_raw.get("avif_quality", 60), 60, 1, 100, "image_shrink.avif_quality"),
        jpeg_quality=_validated_int(is_raw.get("jpeg_quality", 75), 75, 1, 100, "image_shrink.jpeg_quality"),
    )
    env_avif = os.environ.get(_ENV_PREFER_AVIF, "").strip().lower()
    if env_avif in ("0", "false", "no", "off"):
        _LOG.info(
            "image_shrink.prefer_avif disabled by environment variable (%s=%s)",
            _ENV_PREFER_AVIF,
            env_avif,
        )
        is_cfg.prefer_avif = False

    cur_raw: _CuratorToml = cast("_CuratorToml", raw.get("curator", {}))
    cur = CuratorConfig(
        enabled=_validated_bool(cur_raw.get("enabled", True), True, "curator.enabled"),
        min_samples=_validated_int(cur_raw.get("min_samples", 10), 10, 1, 10_000, "curator.min_samples"),
        threshold_pct=_validated_int(cur_raw.get("threshold_pct", 20), 20, 0, 100, "curator.threshold_pct"),
    )
    env_curator = os.environ.get(_ENV_CURATOR, "").strip().lower()
    if env_curator in ("0", "false", "no", "off"):
        _LOG.info(
            "curator disabled by environment variable (%s=%s)",
            _ENV_CURATOR,
            env_curator,
        )
        cur.enabled = False

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
    env_hint_budget = os.environ.get(_ENV_HINT_BUDGET, "").strip().lower()
    if env_hint_budget in ("0", "false", "no", "off"):
        _LOG.info(
            "hint_budget disabled by environment variable (%s=%s)",
            _ENV_HINT_BUDGET,
            env_hint_budget,
        )
        hb.enabled = False

    _LOG.debug(
        "config resolved: compact_assist enabled=%s triggers=%s min_events=%d max_tokens=%d; "
        "bash_compress enabled=%s disabled_filters=%s max_lines=%d max_bytes=%d timeout=%d; "
        "session_brief enabled=%s; "
        "skill_preservation enabled=%s max_cache_bytes=%d; "
        "image_shrink prefer_avif=%s avif_quality=%d jpeg_quality=%d; "
        "curator enabled=%s min_samples=%d threshold_pct=%d; "
        "hint_budget enabled=%s max=%d max_structured=%d max_index_only=%d",
        ca.enabled,
        ca.triggers,
        ca.min_events,
        ca.max_manifest_tokens,
        bc.enabled,
        bc.disabled_filters,
        bc.max_lines,
        bc.max_bytes,
        bc.timeout_seconds,
        sb.enabled,
        sp.enabled,
        sp.max_cache_bytes,
        is_cfg.prefer_avif,
        is_cfg.avif_quality,
        is_cfg.jpeg_quality,
        cur.enabled,
        cur.min_samples,
        cur.threshold_pct,
        hb.enabled,
        hb.max_per_session,
        hb.max_structured_per_session,
        hb.max_index_only_per_session,
    )
    return Config(
        compact_assist=ca, bash_compress=bc, session_brief=sb, skill_preservation=sp,
        image_shrink=is_cfg, curator=cur, hint_budget=hb,
    )


def save(config: Config) -> None:
    """Persist config to TOML atomically, creating parent dirs as needed."""
    import tomli_w  # noqa: PLC0415

    p = paths.config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    ca = config.compact_assist
    bc = config.bash_compress
    sb = config.session_brief
    sp = config.skill_preservation
    is_cfg = config.image_shrink
    cur = config.curator
    hb = config.hint_budget
    data: _ConfigToml = {
        "schema_version": CONFIG_SCHEMA_VERSION,
        "compact_assist": {
            "enabled": ca.enabled,
            "triggers": ca.triggers,
            "min_events": ca.min_events,
            "max_manifest_tokens": ca.max_manifest_tokens,
        },
        "bash_compress": {
            "enabled": bc.enabled,
            "disabled_filters": bc.disabled_filters,
            "max_lines": bc.max_lines,
            "max_bytes": bc.max_bytes,
            "timeout_seconds": bc.timeout_seconds,
        },
        "session_brief": {
            "enabled": sb.enabled,
        },
        "skill_preservation": {
            "enabled": sp.enabled,
            "max_cache_bytes": sp.max_cache_bytes,
        },
        "image_shrink": {
            "prefer_avif": is_cfg.prefer_avif,
            "avif_quality": is_cfg.avif_quality,
            "jpeg_quality": is_cfg.jpeg_quality,
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
    }
    try:
        # _ConfigToml is a TypedDict — a subtype of dict — so tomli_w.dumps
        # (which accepts Mapping[str, Any]) does not require a cast here.
        paths.atomic_write_bytes(p, tomli_w.dumps(data).encode("utf-8"))
    except OSError as e:
        _LOG.warning("config save failed: %s", e)
