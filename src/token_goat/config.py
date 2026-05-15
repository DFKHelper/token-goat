"""Config loader/saver for tokenwise. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

import logging
import os
import tomllib
from dataclasses import dataclass, field
from typing import Any, TypedDict

import tomli_w

from . import paths

_LOG = logging.getLogger("token_goat.config")

_ENV_COMPACT_ASSIST = "TOKENWISE_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable


class _CompactAssistToml(TypedDict, total=False):
    """Expected shape of the [compact_assist] TOML section."""

    enabled: bool
    triggers: list[str]
    min_events: int
    max_manifest_tokens: int


class _ConfigToml(TypedDict, total=False):
    """Expected shape of the tokenwise config TOML file."""

    compact_assist: _CompactAssistToml


@dataclass
class CompactAssistConfig:
    """Configuration for the compaction-assist feature.

    Controls whether and how token-goat injects a session manifest as a
    ``systemMessage`` before Claude Code compacts the conversation, so the
    compaction LLM knows which files and symbols are most important to preserve.

    Attributes:
        enabled: Master on/off switch.  Can also be disabled at runtime by
            setting ``TOKENWISE_COMPACT_ASSIST=0`` (or ``false``/``no``/``off``).
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

    Loaded from ``%LOCALAPPDATA%\\Zelys\\token-goat\\config.toml`` by ``load()``.
    Missing or unreadable files silently fall back to all defaults so token-goat
    never blocks the agent even when the config is absent.
    """

    compact_assist: CompactAssistConfig = field(default_factory=CompactAssistConfig)


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

    ca_raw: _CompactAssistToml = raw.get("compact_assist", {})  # type: ignore[typeddict-item]
    ca = CompactAssistConfig(
        enabled=bool(ca_raw.get("enabled", True)),
        triggers=list(ca_raw.get("triggers", ["manual", "auto"])),
        min_events=int(ca_raw.get("min_events", 5)),
        max_manifest_tokens=int(ca_raw.get("max_manifest_tokens", 400)),
    )

    # Environment override: TOKENWISE_COMPACT_ASSIST=0 / false / no / off disables
    env_val = os.environ.get(_ENV_COMPACT_ASSIST, "").strip().lower()
    if env_val in ("0", "false", "no", "off"):
        _LOG.debug("%s=%s; compact_assist disabled", _ENV_COMPACT_ASSIST, env_val)
        ca.enabled = False

    return Config(compact_assist=ca)


def save(config: Config) -> None:
    """Persist config to TOML, creating parent dirs as needed."""
    p = paths.config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    ca = config.compact_assist
    data: _ConfigToml = {
        "compact_assist": {
            "enabled": ca.enabled,
            "triggers": ca.triggers,
            "min_events": ca.min_events,
            "max_manifest_tokens": ca.max_manifest_tokens,
        }
    }
    try:
        p.write_bytes(tomli_w.dumps(data).encode("utf-8"))  # type: ignore[arg-type]
    except Exception as e:  # noqa: BLE001
        _LOG.warning("config save failed: %s", e)
