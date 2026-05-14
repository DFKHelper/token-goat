"""Config loader/saver for tokenwise. Reads/writes TOML at paths.config_path()."""
from __future__ import annotations

import logging
import os
import tomllib
from dataclasses import dataclass, field
from typing import Any

import tomli_w

from . import paths

_LOG = logging.getLogger("tokenwise.config")

_ENV_COMPACT_ASSIST = "TOKENWISE_COMPACT_ASSIST"  # set to "0"/"false"/"no"/"off" to disable


@dataclass
class CompactAssistConfig:
    enabled: bool = True
    # Hook triggers that activate the manifest: "manual" (/compact) and/or "auto"
    triggers: list[str] = field(default_factory=lambda: ["manual", "auto"])
    # Minimum tracked-event count before emitting a manifest (avoids noise on tiny sessions)
    min_events: int = 5
    # Approximate token budget for the manifest injected as systemMessage
    max_manifest_tokens: int = 400


@dataclass
class Config:
    compact_assist: CompactAssistConfig = field(default_factory=CompactAssistConfig)


def load() -> Config:
    """Load config from TOML. Returns defaults if file is absent or unreadable."""
    p = paths.config_path()
    raw: dict[str, Any] = {}
    if p.exists():
        try:
            raw = tomllib.loads(p.read_text(encoding="utf-8"))
            _LOG.debug("config loaded from %s", p)
        except Exception as e:  # noqa: BLE001
            _LOG.warning("config load failed (%s); using defaults", e)
    else:
        _LOG.debug("config not found; using defaults")

    ca_raw = raw.get("compact_assist", {})
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
    data: dict[str, Any] = {
        "compact_assist": {
            "enabled": ca.enabled,
            "triggers": ca.triggers,
            "min_events": ca.min_events,
            "max_manifest_tokens": ca.max_manifest_tokens,
        }
    }
    try:
        p.write_bytes(tomli_w.dumps(data).encode("utf-8"))
    except Exception as e:  # noqa: BLE001
        _LOG.warning("config save failed: %s", e)
