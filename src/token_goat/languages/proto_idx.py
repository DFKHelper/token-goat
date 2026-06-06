"""Protocol Buffers (.proto) extractor — messages, services, RPCs, enums.

``.proto`` files define the contract between services and can grow large
(hundreds of messages across multiple files).  Agents typically need one
message or RPC definition, not the whole IDL.  This extractor gives
``token-goat section api.proto::UserRequest`` the ability to return a
20-line message block instead of the full file.

What is extracted
-----------------
Symbols:
* ``proto_message``   — top-level ``message Name`` definitions.
* ``proto_enum``      — top-level ``enum Name`` definitions.
* ``proto_service``   — ``service Name`` definitions.
* ``proto_rpc``       — ``rpc Name(...)`` method declarations (inside a service).
* ``proto_oneof``     — ``oneof Name`` field groups (inside a message).
* ``proto_extend``    — ``extend Name`` extension blocks.

Imports:
* Each ``import "other.proto";`` statement produces an :class:`ImpExp` with
  ``kind="import"`` and ``target`` set to the raw path string from the
  directive (e.g. ``"google/protobuf/timestamp.proto"``).  These entries feed
  the PageRank cross-reference graph and are surfaced by ``token-goat imports``.

Sections:
Each symbol also becomes a Section so ``token-goat section`` can slice the
definition body.  End-lines are assigned by the flat algorithm (content up to
the next section header, or EOF for the last one).

What is NOT extracted
---------------------
* Field names (``required int32 id = 1;``) — too fine-grained.
* ``option`` statements.
* ``package`` declarations.
* Nested messages / enums — only top-level definitions are indexed to avoid
  flooding the symbol table.  A nested ``message Address`` inside ``message
  User`` is skipped; use ``token-goat section file.proto::User`` to see the
  outer block.

Design choices
--------------
Pure-regex scanner at column-0 anchoring (or minimal indentation for ``rpc``
and ``oneof`` which appear inside blocks).  No tree-sitter — Grammar wheels for
.proto on Windows are not yet in the CI matrix.

Block and line comments are stripped in a pre-pass so names inside comments
don't appear as false positives.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_strip_comments = common.strip_cstyle_comments

_LOG = get_logger("languages.proto_idx")

# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

# Block comments ``/* ... */`` (DOTALL so content can span lines).

# Line comments ``// ...``

# ---------------------------------------------------------------------------
# Extraction regexes
# ---------------------------------------------------------------------------

# Top-level ``message Name`` or ``enum Name`` at column 0 or with minimal
# indent (proto3 allows top-level definitions at column 0).
# For ``extend``, the target type can be a fully-qualified name like
# ``google.protobuf.FieldOptions`` containing dots, so we allow dots in names
# for the extend keyword only.
_TOP_LEVEL_RE = re.compile(
    r"^(?P<keyword>message|enum|service)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\{",
    re.MULTILINE,
)

# ``extend QualifiedName { }`` — target type may be dotted (e.g.
# ``google.protobuf.FieldOptions``).
_EXTEND_RE = re.compile(
    r"^extend\s+(?P<name>[A-Za-z_][A-Za-z0-9_.]*)\s*\{",
    re.MULTILINE,
)

# ``rpc MethodName(...)`` inside a service block.  We don't restrict depth
# so that RPCs inside nested services are found, but in practice proto services
# are not nested.
_RPC_RE = re.compile(
    r"^\s+rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)

# ``oneof name { }`` inside a message.
_ONEOF_RE = re.compile(
    r"^\s+oneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{",
    re.MULTILINE,
)

# ``import "path/to/other.proto";`` — file-level import directive.
# Both double and single quotes are accepted.  The ``weak`` and ``public``
# modifiers are allowed before the path string.
_IMPORT_RE = re.compile(
    r'^import\s+(?:weak\s+|public\s+)?["\']([^"\']+)["\']',
    re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

_MAX_SYMBOLS: int = 500
_MAX_HEADING_LEN: int = 120

_KIND_MAP: dict[str, str] = {
    "message": "proto_message",
    "enum":    "proto_enum",
    "service": "proto_service",
}

def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract Protocol Buffer symbols, imports, and sections from *source*.

    The return signature matches every other language extractor:
    ``(symbols, refs, imports, sections)``.  ``import "..."`` directives are
    returned as :class:`ImpExp` entries with ``kind="import"``.
    """
    text = common.decode_source_text(source, _LOG, "proto_idx")
    if text is None:
        return [], [], [], []

    try:
        stripped = _strip_comments(text)
        total_lines = text.count("\n") + 1

        symbols: list[Symbol] = []
        imp_exp: list[ImpExp] = []
        sections: list[Section] = []
        seen: set[tuple[str, int]] = set()

        _emit = common.make_symbol_emitter(symbols, sections, seen)

        # import "path/to/file.proto" — extract before stripping comments
        # (imports appear at top of file, rarely inside comments)
        for m in _IMPORT_RE.finditer(stripped):
            path = m.group(1).strip()
            if path:
                line = stripped[: m.start()].count("\n") + 1
                imp_exp.append(ImpExp(kind="import", target=path, line=line))

        # Top-level: message / enum / service
        for m in _TOP_LEVEL_RE.finditer(stripped):
            keyword = m.group("keyword")
            name = m.group("name").strip()
            if name:
                kind = _KIND_MAP.get(keyword, "proto_message")
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, kind, line)

        # extend QualifiedName { } — target may be dotted (google.protobuf.X)
        for m in _EXTEND_RE.finditer(stripped):
            name = m.group("name").strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "proto_extend", line)

        # rpc methods inside services
        for m in _RPC_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "proto_rpc", line)

        # oneof groups inside messages
        for m in _ONEOF_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "proto_oneof", line)

        # Sort sections by line then assign end_lines.
        sections.sort(key=lambda s: s.line)
        common.assign_flat_end_lines(sections, total_lines)

        return symbols, [], imp_exp, sections

    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        _LOG.debug("proto_idx: parse failed for %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
