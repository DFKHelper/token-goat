"""Cross-cutting helpers shared across token_goat modules.

Kept intentionally small — only utilities that would otherwise be duplicated
in two or more modules with no natural owner belong here.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
from logging import Logger
from subprocess import CompletedProcess

from .render.ansi import strip_ansi as strip_ansi  # noqa: PLC0414  re-export

__all__ = [
    "strip_ansi",
    "get_logger",
    "run_git",
    "sanitize_surrogates",
    "sanitize_control_chars",
    "ellipsize",
    "env_float",
    "env_int",
    "configure_stdout_encoding",
    "strip_bom",
]


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


def sanitize_control_chars(text: str) -> str:
    """Remove non-printable control characters while preserving safe characters.

    Strips C0 control characters (U+0000–U+001F) EXCEPT tab (U+0009), newline
    (U+000A), and carriage return (U+000D). Also strips C1 control characters
    (U+0080–U+009F). Preserves all printable Unicode including box-drawing
    characters (U+2500–U+257F) and other TUI-tool output.

    This is idempotent and safe to call multiple times.

    Args:
        text: Input string that may contain control characters.

    Returns:
        String with control characters removed except tab, newline, and carriage return.
    """
    # Remove C0 chars (0x00-0x1F) except 0x09 (tab), 0x0A (LF), 0x0D (CR)
    # Remove C1 chars (0x80-0x9F)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x80-\x9f]", "", text)


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


def configure_stdout_encoding() -> None:
    """Reconfigure sys.stdout and sys.stderr to use UTF-8 encoding.

    On Windows, the default terminal encoding is cp1252, which cannot encode
    many Unicode characters (box-drawing chars, arrows, emoji in lefthook output).
    This function reconfigures both streams to use UTF-8 with ``errors='replace'``
    so non-ASCII characters are printed correctly (or replaced with U+FFFD on
    encoding errors).

    This is a no-op if stdout/stderr have no ``reconfigure`` method (older Python
    versions or special environments like closed pipes), or if reconfiguration fails
    (e.g. already-closed stream).

    The function catches and silently ignores all exceptions, so it is safe to call
    at any point in the program lifecycle.
    """
    import contextlib

    with contextlib.suppress(AttributeError, OSError):
        if sys.stdout is not None and hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    with contextlib.suppress(AttributeError, OSError):
        if sys.stderr is not None and hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


def strip_bom(text: str) -> str:
    """Remove UTF-8 BOM (U+FEFF) from the start of a string if present.

    On Windows, files may be written with a UTF-8 BOM (Byte Order Mark).
    When these files are read and parsed as JSON, the BOM becomes U+FEFF
    at the start of the string, causing json.loads() to fail with a JSONDecodeError.

    This function removes the BOM character if it appears at position 0, leaving
    the string unchanged otherwise. It is idempotent — calling it multiple times
    on the same string has no additional effect after the first call.

    Args:
        text: Input string that may start with a UTF-8 BOM.

    Returns:
        String with the BOM removed (if present), or unchanged if no BOM.

    Examples:
        >>> strip_bom("﻿hello")
        'hello'
        >>> strip_bom("hello")
        'hello'
    """
    if text.startswith("﻿"):
        return text[1:]
    return text
