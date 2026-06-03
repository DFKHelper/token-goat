"""Dotenv / environment variable file extractor.

Handles ``.env``, ``.env.example``, ``.env.sample``, ``.env.local``, and
similar dotenv-family files.  Each ``KEY=value`` or ``KEY = value`` assignment
at column 0 becomes an ``env_key`` symbol so ``token-goat symbol DATABASE_URL``
jumps directly to the line that declares it.

This module is a thin dedicated wrapper over the ``ini_idx.extract_env``
implementation (which already handles ``.env`` / ``.envrc``).  It exists as a
separate file so that:

1. ``.env.example`` and ``.env.sample`` variants (which have a full-filename
   stem, not a bare basename) can be registered here without touching the
   INI-family dispatch path.
2. The symbol kind ``env_key`` is documented in one canonical location.

What is extracted
-----------------
Symbols:
* ``env_key`` — every ``KEY=value`` or ``KEY = value`` assignment at column 0.
  The extracted name is the key only (e.g. ``DATABASE_URL``).

Sections:
Not emitted.  Dotenv files are flat by design; emitting one Section per key
would produce one entry per line and inflate the section index without value.

What is NOT extracted
---------------------
* Values — intentionally omitted because they often contain secrets.
* Lines with leading whitespace (continuation lines, not valid in dotenv).
* Comments (``#`` lines).
* Shell ``export KEY=value`` — the ``export`` prefix is stripped before the
  ``KEY=`` pattern, so these lines ARE captured if you strip the prefix.
  Currently not supported; use a plain ``KEY=value`` or open an issue.

Design choices
--------------
Delegates entirely to ``ini_idx.extract_env`` for the parse logic so the two
paths stay in sync.  Tested independently so regressions surface in the right
module.
"""
from __future__ import annotations

__all__ = ["extract"]

from .ini_idx import extract_env as extract

# ``extract`` is the canonical entry-point name for all language extractors;
# re-exporting ``extract_env`` as ``extract`` makes this module work as a
# first-class language adapter registered under the key ``"env_file"`` in
# ``parser.py``.  The ``ini_idx`` module continues to handle plain ``.env``
# / ``.envrc`` via its own ``extract_env`` export.
