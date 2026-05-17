"""token-goat: Claude Code token-saver companion."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("token-goat")
except PackageNotFoundError:  # running from source tree without install
    __version__ = "0.0.0.dev0"
