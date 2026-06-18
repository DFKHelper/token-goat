"""Strip cell outputs from Jupyter notebooks to reduce token burn.

``strip_notebook(nb_dict)`` strips all cell outputs and execution counts from
a notebook dict in-place-safe (returns a new dict).  ``get_or_create_sidecar``
caches the stripped version keyed on the SHA-256 of the original bytes so that
subsequent reads of an unchanged notebook skip the stripping work.
"""
from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

#: Minimum bytes saved by output stripping before a redirect is worth emitting.
NB_STRIP_MIN_SAVINGS: int = 4096


def strip_notebook(nb_dict: dict[str, Any]) -> dict[str, Any]:
    """Return a new notebook dict with all code-cell outputs cleared.

    Markdown and raw cells are left untouched.  ``execution_count`` on code
    cells is set to ``null`` so re-execution counts are not misleading.
    The ``outputs`` array is replaced with ``[]``; other fields are preserved.
    """
    cells = []
    for cell in nb_dict.get("cells", []):
        if cell.get("cell_type") == "code":
            cell = {**cell, "outputs": [], "execution_count": None}
        cells.append(cell)
    return {**nb_dict, "cells": cells}


def get_or_create_sidecar(raw_bytes: bytes, cache_root: Path) -> tuple[Path, bool]:
    """Return ``(sidecar_path, created)`` for the stripped version of *raw_bytes*.

    If a sidecar already exists for this exact content (same SHA-256), return it
    directly without re-stripping (``created=False``).  Otherwise parse, strip,
    write, and return (``created=True``).  Raises ``ValueError`` if *raw_bytes*
    is not valid JSON or not a recognisable notebook dict.
    """
    sha = hashlib.sha256(raw_bytes).hexdigest()
    sidecar_dir = cache_root / "nb_strip" / sha
    sidecar_path = sidecar_dir / "stripped.ipynb"
    if sidecar_path.exists():
        return sidecar_path, False
    nb = json.loads(raw_bytes)
    if not isinstance(nb, dict) or "cells" not in nb:
        raise ValueError("Not a notebook")
    stripped = strip_notebook(nb)
    sidecar_dir.mkdir(parents=True, exist_ok=True)
    sidecar_path.write_bytes(json.dumps(stripped, ensure_ascii=False).encode())
    return sidecar_path, True
