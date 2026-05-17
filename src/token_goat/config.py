"""Config loader/saver for token-goat. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

__all__ = ["CompactAssistConfig", "Config", "CONFIG_SCHEMA_VERSION", "load", "save"]

import logging
import os
import tomllib
from dataclasses import dataclass, field
from typing import Any, Final, TypedDict, cast

from . import paths

_LOG = logging.getLogger("token_goat.config")

_ENV_COMPACT_ASSIST: Final[str] = "TOKEN_GOAT_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable
_ENV_COMPACT_ASSIST_LEGACY: Final[str] = "TOKENWISE_COMPACT_ASSIST"  # backward-compat alias

CONFIG_SCHEMA_VERSION: Final[int] = 1

_VALID_TRIGGERS: Final[frozenset[str]] = frozenset(["manual", "auto"])


class _CompactAssistToml(TypedDict, total=False):
    """Expected shape of the [compact_assist] TOML section."""

    enabled: bool
    triggers: list[str]
    min_events: int
    max_manifest_tokens: int


class _ConfigToml(TypedDict, total=False):
    """Expected shape of the token-goat config TOML file."""

    schema_version: int
    compact_assist: _CompactAssistToml


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
    # Minimum tracked-event count before emitting a manifest (avoids noise on tiny sessions)
    min_events: int = 5
    # Approximate token budget for the manifest injected as systemMessage
    max_manifest_tokens: int = 400


@dataclass
class Config:
    """Top-level token-goat configuration.

    Loaded from ``%LOCALAPPDATA%\\dfk-helper\\token-goat\\config.toml`` by ``load()``.
    Missing or unreadable files silently fall back to all defaults so token-goat
    never blocks the agent even when the config is absent.
    """

    compact_assist: CompactAssistConfig = field(default_factory=CompactAssistConfig)


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
        min_events=_validated_int(ca_raw.get("min_events", 5), 5, 0, 1000, "compact_assist.min_events"),
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

    _LOG.debug(
        "config resolved: compact_assist enabled=%s triggers=%s min_events=%d max_tokens=%d",
        ca.enabled,
        ca.triggers,
        ca.min_events,
        ca.max_manifest_tokens,
    )
    return Config(compact_assist=ca)


def save(config: Config) -> None:
    """Persist config to TOML atomically, creating parent dirs as needed."""
    import tomli_w  # noqa: PLC0415

    p = paths.config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    ca = config.compact_assist
    data: _ConfigToml = {
        "schema_version": CONFIG_SCHEMA_VERSION,
        "compact_assist": {
            "enabled": ca.enabled,
            "triggers": ca.triggers,
            "min_events": ca.min_events,
            "max_manifest_tokens": ca.max_manifest_tokens,
        },
    }
    try:
        # _ConfigToml is a TypedDict — a subtype of dict — so tomli_w.dumps
        # (which accepts Mapping[str, Any]) does not require a cast here.
        paths.atomic_write_bytes(p, tomli_w.dumps(data).encode("utf-8"))
    except OSError as e:
        _LOG.warning("config save failed: %s", e)
