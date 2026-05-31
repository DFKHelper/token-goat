"""Cross-cutting helpers shared across token_goat modules.

Kept intentionally small — only utilities that would otherwise be duplicated
in two or more modules with no natural owner belong here.
"""

from __future__ import annotations

import logging
import os
import subprocess
from logging import Logger
from subprocess import CompletedProcess


def get_logger(name: str) -> Logger:
    """Return ``logging.getLogger("token_goat.<name>")``.

    Centralises the ``token_goat.`` prefix so each module only needs::

        _LOG = get_logger(__name__.split(".")[-1])

    or equivalently::

        _LOG = get_logger("module_name")
    """
    return logging.getLogger(f"token_goat.{name}")


def run_git(
    args: list[str],
    *,
    cwd: str | None = None,
    timeout: float = 10,
    env_extra: dict[str, str] | None = None,
    check: bool = False,
) -> CompletedProcess[str]:
    """Run ``git --no-optional-locks <args>`` and return the CompletedProcess.

    Design rationale for each kwarg:

    * ``--no-optional-locks`` is prepended automatically so git never acquires
      the optional ``.git/index.lock`` (used for e.g. ``status`` refreshes).
      This prevents interference with the editor / agent that already owns the
      lock during a write operation.
    * ``capture_output=True`` — every caller inspects stdout/stderr; letting them
      inherit the terminal would pollute hook output and break JSON responses.
    * ``text=True`` — all callers work with strings, not bytes.
    * ``encoding="utf-8"`` — explicit encoding so behaviour is the same on every
      platform regardless of the locale's default encoding.
    * ``errors="replace"`` — on Windows, non-UTF-8 path bytes can appear in git
      output (e.g. filenames with high-byte characters).  ``replace`` ensures we
      always get a valid string rather than a UnicodeDecodeError.
    * ``check=False`` by default — many callers treat non-zero exit as a sentinel
      (e.g. "not a git repo" returns exit 128).  Callers that want an exception
      on failure may pass ``check=True``.
    * ``env_extra`` — merged on top of ``os.environ`` so callers can set
      ``GIT_TERMINAL_PROMPT=0`` (prevents git from blocking on a password prompt)
      without having to reconstruct the whole environment.
    """
    env = {**os.environ, **(env_extra or {})}
    return subprocess.run(
        ["git", "--no-optional-locks", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=check,
        env=env,
    )


def sanitize_surrogates(text: str) -> str:
    """Replace lone surrogate characters (U+DC80–U+DCFF) with U+FFFD.

    On Windows, subprocess.run can return stdout/stderr containing surrogate-escape
    bytes (Python's mechanism for round-tripping non-UTF-8 bytes from the OS).
    These ``\\udcXX`` code points are not valid Unicode and cause a
    ``UnicodeEncodeError: 'utf-8' codec can't encode character`` when the string
    is later serialised or printed (e.g. when persisting to the bash cache or
    writing to a log).

    This helper sanitises the string at the input boundary so no surrogate ever
    propagates into the cache, session JSON, or log output.  Normal text (including
    legitimate multi-byte Unicode) is returned unchanged.
    """
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def ellipsize(s: str, max_chars: int) -> str:
    """Return *s* truncated to *max_chars* with a trailing ``…`` when it exceeds that length.

    When ``len(s) <= max_chars`` the string is returned unchanged.  When it
    exceeds *max_chars*, the string is sliced to ``max_chars - 1`` characters
    and ``…`` is appended so the result is exactly *max_chars* characters long.

    >>> ellipsize("hello world", 8)
    'hello w…'
    >>> ellipsize("hi", 8)
    'hi'
    """
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


def _humanize_bytes(n: int) -> str:
    """Return a short human-readable byte count: ``1.2KB``, ``3.4MB``, ``120B``.

    Compact (no spaces, two significant digits) so it fits inside a manifest
    line without competing with the command preview for visual space.  Sizes
    below 1024 use plain bytes; above that we step through KB/MB/GB at
    1024-byte boundaries.
    """
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f}MB"
    return f"{n / (1024 * 1024 * 1024):.1f}GB"


def env_float(env_key: str, default: float, *, lo: float | None = None, hi: float | None = None) -> float:
    """Read a float from an environment variable, falling back to *default* on any error.

    Parses ``os.environ.get(env_key)``, strips whitespace, and converts to
    ``float``.  Returns *default* when the variable is unset, empty, or
    non-numeric.  Optionally clamps the result to ``[lo, hi]`` when either
    bound is given.

    This consolidates the repeated ``float(os.environ.get(key, str(default)))``
    pattern that crashes on non-numeric values.

    Args:
        env_key: Environment variable name.
        default: Fallback value when the var is absent or invalid.
        lo:      Lower bound (inclusive); ``None`` means no lower clamp.
        hi:      Upper bound (inclusive); ``None`` means no upper clamp.

    Returns:
        Parsed float, clamped to ``[lo, hi]`` when bounds are given, or *default*.
    """
    raw = os.environ.get(env_key, "").strip()
    if not raw:
        return default
    try:
        val = float(raw)
    except (ValueError, OverflowError):
        return default
    if lo is not None and val < lo:
        val = lo
    if hi is not None and val > hi:
        val = hi
    return val


def env_int(env_key: str, default: int, *, lo: int | None = None, hi: int | None = None) -> int:
    """Read an integer from an environment variable, falling back to *default* on any error.

    Parses ``os.environ.get(env_key)``, strips whitespace, and converts to
    ``int``.  Returns *default* when the variable is unset, empty, or
    non-numeric.  Optionally clamps the result to ``[lo, hi]`` when either
    bound is given.

    This consolidates the repeated ``int(os.environ.get(key, str(default)))``
    pattern and the manual ``try: int(raw) except ValueError: default`` blocks
    found across multiple modules.

    Args:
        env_key: Environment variable name.
        default: Fallback value when the var is absent or invalid.
        lo:      Lower bound (inclusive); ``None`` means no lower clamp.
        hi:      Upper bound (inclusive); ``None`` means no upper clamp.

    Returns:
        Parsed int, clamped to ``[lo, hi]`` when bounds are given, or *default*.
    """
    raw = os.environ.get(env_key, "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
    except (ValueError, OverflowError):
        return default
    if lo is not None and val < lo:
        val = lo
    if hi is not None and val > hi:
        val = hi
    return val
