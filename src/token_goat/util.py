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
from typing import TYPE_CHECKING

from .render.ansi import strip_ansi as strip_ansi

if TYPE_CHECKING:
    from pathlib import Path

__all__ = [
    "configure_stdout_encoding",
    "ellipsize",
    "env_float",
    "env_int",
    "get_logger",
    "normalize_path",
    "run_git",
    "sanitize_control_chars",
    "sanitize_surrogates",
    "strip_ansi",
    "strip_bom",
    "utf8_bytes",
]


def get_logger(name: str) -> Logger:
    """Return ``logging.getLogger("token_goat.<name>")``.

    Centralises the ``token_goat.`` prefix so each module only needs::

        _LOG = get_logger(__name__.split(".")[-1])

    or equivalently::

        _LOG = get_logger("module_name")
    """
    return logging.getLogger(f"token_goat.{name}")


# Compiled once at import time — avoids recompiling on every normalize_path call.
# Accept either case for the drive letter ([a-zA-Z]); the captured group is lowercased
# below so /mnt/C/foo and /mnt/c/foo collapse to the same canonical key.
_WSL_PATH_RE = re.compile(r"^/mnt/([a-zA-Z])/(.*)$", re.DOTALL)


def normalize_path(path: str | Path) -> str:
    """Normalize a file path to a canonical string form for cross-platform key lookups.

    Transformations applied in order:

    1. Convert a ``pathlib.Path`` (or any ``os.PathLike``) to ``str`` first so
       the function accepts both forms uniformly.
    2. Replace all backslashes with forward slashes.  Done before the WSL check
       so mixed-separator paths like ``/mnt/c/foo\\bar`` are fully normalised
       before the regex runs.
    3. Detect WSL paths of the form ``/mnt/<drive>/rest`` and convert them to
       the Windows canonical form ``<drive>:/rest``.  For example,
       ``/mnt/c/Users/zelys/foo`` becomes ``c:/Users/zelys/foo``.  Only
       single-letter drive components are converted; other ``/mnt/...`` paths
       (e.g. ``/mnt/data``) are left unchanged.
    4. Lowercase the Windows drive letter prefix (``C:`` → ``c:``).

    The result is a consistent canonical string suitable for use as a dict key
    or SQLite lookup value regardless of whether the path arrived from a Windows
    process (``C:\\foo``), a WSL process (``/mnt/c/foo``), or was already in
    forward-slash form (``c:/foo``).

    Note: this is a *string* canonicalizer, not a *filesystem* canonicalizer.
    Symlinks, junctions, and case-insensitive NTFS paths are not resolved.
    Paths that do not match any of the recognized patterns are returned with only
    backslashes replaced and the leading drive letter lowercased.

    Examples::

        >>> normalize_path("/mnt/c/foo/bar")
        'c:/foo/bar'
        >>> normalize_path("C:\\\\foo\\\\bar")
        'c:/foo/bar'
        >>> normalize_path("c:/foo/bar")
        'c:/foo/bar'
        >>> normalize_path("/home/user/project")
        '/home/user/project'
    """
    s = str(path)

    # Step 2: replace backslashes before WSL check so mixed-separator paths like /mnt/c/foo\bar are fully normalized before the regex runs.
    if "\\" in s:
        s = s.replace("\\", "/")

    # Step 3: convert WSL /mnt/<single-letter-drive>/rest → <drive>:/rest
    m = _WSL_PATH_RE.match(s)
    if m:
        drive_letter = m.group(1).lower()  # lowercase so /mnt/C and /mnt/c agree
        rest = m.group(2)
        s = f"{drive_letter}:/{rest}"

    # Step 4: lowercase the drive letter prefix (C: → c:) on all platforms.
    # WSL processes emit Windows-format paths on Linux; both must produce the
    # same cache key, so lowercasing must be unconditional.
    if len(s) >= 2 and s[1] == ":" and s[0].isalpha() and s[0].isupper():
        s = s[0].lower() + s[1:]

    return s


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


def run_git_silent(
    args: list[str],
    cwd: str | Path | None = None,
    *,
    timeout: float = 10,
) -> str | None:
    """Run ``git <args>`` and return stripped stdout, or ``None`` on any failure.

    Returns ``None`` when git is not found, the working directory does not exist,
    the process times out, the exit code is non-zero, or the output is empty after
    stripping.  Only ``OSError`` and ``subprocess.SubprocessError`` are swallowed —
    programming errors are allowed to propagate so they surface in tests rather than
    being silently masked.
    """
    import subprocess as _subprocess

    try:
        result = run_git(args, cwd=str(cwd) if cwd is not None else None, timeout=timeout)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return result.stdout.strip()
    except (OSError, _subprocess.SubprocessError):
        return None


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


def utf8_bytes(s: str) -> bytes:
    """Encode *s* to UTF-8 bytes, replacing lone surrogates with U+FFFD.

    This is the canonical byte-length helper for all token-saving and cache
    byte-count calculations across the codebase.  It is equivalent to
    ``s.encode("utf-8", errors="replace")`` but centralises the encoding
    contract so callers don't need to repeat the ``errors="replace"`` guard.

    Use this wherever you need ``len(s.encode("utf-8"))`` (byte-length check)
    or need the raw bytes for storage — it is safe on all strings, including
    those with surrogate-escape sequences from subprocess output.

    >>> utf8_bytes("hello")
    b'hello'
    >>> len(utf8_bytes("café"))
    5
    """
    return s.encode("utf-8", errors="replace")


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


def _norm(p: str) -> str:
    """Normalize a path for case-insensitive comparison on Windows.

    Replaces backslashes with forward slashes and lowercases the entire path
    on Windows (where paths are case-insensitive). On other platforms, returns
    the path unchanged.

    Args:
        p: Path string to normalize.

    Returns:
        Normalized path.

    Examples:
        >>> _norm("C:\\Users\\test")  # On Windows
        'c:/users/test'
        >>> _norm("/home/user")  # On Linux
        '/home/user'
    """
    return p.replace("\\", "/").casefold() if sys.platform == "win32" else p
