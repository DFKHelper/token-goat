"""Shared constants and helpers used by both :mod:`bash_cache` and :mod:`web_cache`.

This module exists solely to remove genuine duplication between the two
output-cache modules.  It must not grow into a generic cache base-class —
each cache retains its own directory helper, log module, and metadata shape.
"""
from __future__ import annotations

__all__ = [
    "OUTPUT_FILENAME_RE",
    "safe_session_fragment",
]

import re

# Filename pattern shared by both the bash-output and web-output caches.
# Components are intentionally kept short so the full path stays well within
# PATH_MAX even when the data directory lives several levels deep (e.g. roaming
# AppData on Windows).
# Format: <session_short>-<timestamp_ms>-<contenthash>.txt
OUTPUT_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$")

# Pre-compiled pattern used by safe_session_fragment — module-level so it is
# only compiled once across both callers.
_SESSION_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def safe_session_fragment(session_id: str) -> str:
    """Return a filesystem-safe 16-character prefix of *session_id*.

    Replaces every character that is not alphanumeric, underscore, or hyphen
    with an underscore, then truncates to 16 characters.  Falls back to the
    literal string ``"anon"`` when the result would otherwise be empty (i.e.
    *session_id* is empty or contains only characters that map to underscores
    at the very start before any alphanumeric content appears, then are fully
    stripped by the truncation).

    This fragment is used as the leading component of output-cache filenames
    so that entries can be associated with a session at a glance without
    re-parsing the JSON sidecar.

    Examples::

        safe_session_fragment("abc-123_xyz")   # "abc-123_xyz"
        safe_session_fragment("a" * 64)        # "aaaaaaaaaaaaaaaa"
        safe_session_fragment("!@#$")          # "____"  (or "anon" if truncated to empty)
        safe_session_fragment("")              # "anon"
    """
    return _SESSION_UNSAFE_RE.sub("_", session_id)[:16] or "anon"
