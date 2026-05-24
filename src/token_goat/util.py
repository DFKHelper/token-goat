"""Cross-cutting helpers shared across token_goat modules.

Kept intentionally small — only utilities that would otherwise be duplicated
in two or more modules with no natural owner belong here.
"""

from __future__ import annotations


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
