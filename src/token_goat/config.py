"""Config loader/saver for token-goat. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

__all__ = ["CompactAssistConfig", "Config", "CONFIG_SCHEMA_VERSION", "load", "save"]

import logging
import os
import threading
import time
import tomllib
from dataclasses import dataclass, field
from typing import Any, TypedDict

import tomli_w

from . import paths

_LOG = logging.getLogger("token_goat.config")

_ENV_COMPACT_ASSIST = "TOKEN_GOAT_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable
_ENV_COMPACT_ASSIST_LEGACY = "TOKENWISE_COMPACT_ASSIST"  # backward-compat alias

CONFIG_SCHEMA_VERSION = 1

_VALID_TRIGGERS = frozenset(["manual", "auto"])


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

def _validated_int(val: Any, default: int, lo: int, hi: int, name: str) -> int:
    try:
        v = int(val)
        if not lo <= v <= hi:
            _LOG.warning("config: %s=%r out of range [%d, %d]; using default %d", name, val, lo, hi, default)
            return default
        return v
    except (TypeError, ValueError):
        _LOG.warning("config: %s=%r is not an int; using default %d", name, val, default)
        return default


def _validated_bool(val: Any, default: bool, name: str) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return bool(val)
    _LOG.warning("config: %s=%r is not a bool; using default %s", name, val, default)
    return default


def _validated_triggers(val: Any, default: list[str]) -> list[str]:
    if not isinstance(val, list):
        _LOG.warning("config: triggers must be a list; using default %s", default)
        return list(default)
    valid = [t for t in val if isinstance(t, str) and t in _VALID_TRIGGERS]
    unknown = [t for t in val if not isinstance(t, str) or t not in _VALID_TRIGGERS]
    if unknown:
        _LOG.warning("config: unknown trigger values ignored: %s", unknown)
    return valid if valid else list(default)


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------

def _atomic_write(path: paths.Path, content: bytes) -> None:
    """Write *content* to *path* atomically via a temp file + rename.

    Uses a per-thread unique stem to avoid collisions when multiple processes
    write concurrently (each will win the rename race independently).
    """
    tmp = path.with_suffix(f".tmp-{threading.get_ident()}-{time.monotonic_ns()}")
    tmp.write_bytes(content)
    # On Windows, Path.rename() raises if the destination exists — use os.replace
    # which is atomic on POSIX and as close as Windows gets.
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load() -> Config:
    """Load config from TOML. Returns defaults if file is absent or unreadable."""
    p = paths.config_path()
    raw: _ConfigToml = {}  # type: ignore[typeddict-item]
    if p.exists():
        try:
            parsed: dict[str, Any] = tomllib.loads(p.read_text(encoding="utf-8"))
            raw = parsed  # type: ignore[assignment]
            _LOG.debug("config loaded from %s", p)
        except Exception as e:  # noqa: BLE001
            _LOG.warning("config load failed (%s); using defaults", e)
    else:
        _LOG.debug("config not found; using defaults")

    schema_v = raw.get("schema_version", 0)
    if schema_v and int(schema_v) > CONFIG_SCHEMA_VERSION:
        _LOG.warning(
            "config schema_version %s > current %s; some keys may be ignored",
            schema_v,
            CONFIG_SCHEMA_VERSION,
        )

    ca_raw: _CompactAssistToml = raw.get("compact_assist", {})  # type: ignore[typeddict-item]
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
        _LOG.debug("%s=%s; compact_assist disabled", _ENV_COMPACT_ASSIST, env_val)
        ca.enabled = False

    return Config(compact_assist=ca)


def save(config: Config) -> None:
    """Persist config to TOML atomically, creating parent dirs as needed."""
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
        _atomic_write(p, tomli_w.dumps(data).encode("utf-8"))  # type: ignore[arg-type]
    except Exception as e:  # noqa: BLE001
        _LOG.warning("config save failed: %s", e)
