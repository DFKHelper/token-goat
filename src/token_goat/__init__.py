"""token-goat: Claude Code token-saver companion."""
from __future__ import annotations

from typing import Any

# Lazy ``__version__`` lookup — ``importlib.metadata`` costs ~60 ms at cold start
# (it triggers ``email.message``, ``email.utils``, ``importlib.resources``, and
# friends).  Hooks fire on every Read/Write/Edit/Bash tool call, so that cost is
# multiplied across every dispatch.  Defer the import until ``__version__`` is
# actually accessed via PEP 562 module-level ``__getattr__``.  Hook handlers
# never read it, so the cost is paid only by ``cli.py --version`` and similar.
__all__ = ["__version__"]


def __getattr__(name: str) -> Any:
    if name == "__version__":
        from importlib.metadata import PackageNotFoundError, version

        try:
            value = version("token-goat")
        except PackageNotFoundError:
            value = "0.0.0.dev0"
        # Cache on the module so subsequent attribute reads skip the import.
        globals()["__version__"] = value
        return value
    raise AttributeError(f"module 'token_goat' has no attribute {name!r}")
