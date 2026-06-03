"""GraphQL schema / document extractor — types, queries, mutations, subscriptions, fragments.

GraphQL files (``.graphql``, ``.gql``) can be large schemas with hundreds of
type definitions.  Agents typically need only one type, resolver, or field
definition.  This extractor gives ``token-goat section schema.graphql::User``
the ability to return a 30-line type block instead of a 1000-line schema.

What is extracted
-----------------
Symbols:
* ``graphql_type``        — ``type Name`` object type definitions.
* ``graphql_input``       — ``input Name`` input object types.
* ``graphql_interface``   — ``interface Name`` interface definitions.
* ``graphql_enum``        — ``enum Name`` enum definitions.
* ``graphql_union``       — ``union Name`` union types.
* ``graphql_scalar``      — ``scalar Name`` custom scalar definitions.
* ``graphql_directive``   — ``directive @name`` definitions.
* ``graphql_fragment``    — ``fragment Name on Type`` fragment definitions.
* ``graphql_query``       — ``query Name`` named operation definitions.
* ``graphql_mutation``    — ``mutation Name`` named mutation definitions.
* ``graphql_subscription``— ``subscription Name`` named subscription definitions.
* ``graphql_extend``      — ``extend type/interface/input Name`` extension declarations.
* ``graphql_schema``      — ``schema { }`` root schema block (emitted as "schema").

Sections:
Each symbol also becomes a Section so ``token-goat section`` can slice the
definition block.  End-lines are assigned by the flat algorithm (content up to
the next section header, or EOF for the last one).

What is NOT extracted
---------------------
* Field names inside type bodies — too fine-grained; they flood the index.
* Anonymous operations (``{ users { id } }``).
* Inline fragments (``... on User { id }``).

Design choices
--------------
Pure-regex scanner, no tree-sitter.  GraphQL grammars in the tree-sitter
ecosystem have inconsistent Windows wheel support on the CI matrix (Windows 2022
with Python 3.11–3.13).  The regex approach covers real-world GraphQL patterns
with zero native-extension dependencies.

Comment stripping runs as a pre-pass (``#`` line comments only — GraphQL has no
block-comment syntax) to avoid false positives inside comments.
"""
from __future__ import annotations

__all__ = ["extract"]

import re

from ..parser import ImpExp, Ref, Section, Symbol
from ..util import get_logger
from . import common

_LOG = get_logger("languages.graphql_idx")

# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

# GraphQL uses ``# comment`` line comments only — no block comments.
_LINE_COMMENT_RE = re.compile(r"#[^\n]*")


def _strip_comments(text: str) -> str:
    """Replace ``#`` comment regions with whitespace, preserving line numbers."""
    return _LINE_COMMENT_RE.sub("", text)


# ---------------------------------------------------------------------------
# Extraction regexes
# ---------------------------------------------------------------------------

# GraphQL type/interface/input/enum/union/scalar/directive definitions.
# The ``type Name`` form may optionally carry ``implements Interface &
# Interface2`` before the ``{``, but we capture only the Name.
# WHY allow optional leading ``extend``: ``extend type Foo`` adds fields to a
# type and is a first-class definition worth surfacing separately.
_TYPE_RE = re.compile(
    r"^[ \t]*(extend\s+)?(?P<keyword>type|interface|input|enum|union|scalar)"
    r"\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)

# ``directive @name`` definitions.  The ``@`` is required and not captured into
# the name so the symbol is ``name`` (consistent with how callers refer to them
# as ``@name``).
_DIRECTIVE_RE = re.compile(
    r"^[ \t]*directive\s+@([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)

# ``fragment FragmentName on TypeName`` definitions.
_FRAGMENT_RE = re.compile(
    r"^[ \t]*fragment\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+",
    re.MULTILINE,
)

# Named operations: ``query Name``, ``mutation Name``, ``subscription Name``.
# Anonymous operations have no name and are skipped.
_OPERATION_RE = re.compile(
    r"^[ \t]*(?P<op>query|mutation|subscription)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)

# The root ``schema { }`` declaration.  Emitted as the symbol "schema".
_SCHEMA_RE = re.compile(
    r"^[ \t]*schema\s*\{",
    re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

_MAX_SYMBOLS: int = 500
_MAX_HEADING_LEN: int = 120

# Map GraphQL keyword → symbol kind.
_KIND_MAP: dict[str, str] = {
    "type":       "graphql_type",
    "interface":  "graphql_interface",
    "input":      "graphql_input",
    "enum":       "graphql_enum",
    "union":      "graphql_union",
    "scalar":     "graphql_scalar",
}


def extract(
    source: bytes, rel_path: str
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract GraphQL symbols and sections from *source*.

    The return signature matches every other language extractor:
    ``(symbols, refs, imports, sections)``.  Refs and imports are always empty
    for GraphQL — there is no cross-file call-site model in schema files (SDL
    ``@import`` directives are tool-specific and not standardised).
    """
    text = common.decode_source_text(source, _LOG, "graphql_idx")
    if text is None:
        return [], [], [], []

    try:
        stripped = _strip_comments(text)
        total_lines = text.count("\n") + 1

        symbols: list[Symbol] = []
        sections: list[Section] = []
        seen: set[tuple[str, int]] = set()

        def _emit(name: str, kind: str, line: int) -> None:
            if len(name) > _MAX_HEADING_LEN:
                return
            if len(symbols) >= _MAX_SYMBOLS:
                return
            key = (name, line)
            if key in seen:
                return
            seen.add(key)
            symbols.append(Symbol(name=name, kind=kind, line=line))
            sections.append(Section(heading=name, level=1, line=line))

        # type / interface / input / enum / union / scalar (+ extend variants)
        for m in _TYPE_RE.finditer(stripped):
            keyword = m.group("keyword")
            name = m.group("name").strip()
            is_extend = bool(m.group(1))
            if name:
                kind = ("graphql_extend" if is_extend
                        else _KIND_MAP.get(keyword, "graphql_type"))
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, kind, line)

        # directive @name
        for m in _DIRECTIVE_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(f"@{name}", "graphql_directive", line)

        # fragment FragmentName on ...
        for m in _FRAGMENT_RE.finditer(stripped):
            name = m.group(1).strip()
            if name:
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, "graphql_fragment", line)

        # query/mutation/subscription Name
        for m in _OPERATION_RE.finditer(stripped):
            op = m.group("op")
            name = m.group("name").strip()
            if name:
                kind = f"graphql_{op}"
                line = stripped[: m.start()].count("\n") + 1
                _emit(name, kind, line)

        # schema { }
        for m in _SCHEMA_RE.finditer(stripped):
            line = stripped[: m.start()].count("\n") + 1
            _emit("schema", "graphql_schema", line)

        # Sort sections by line then assign end_lines.
        sections.sort(key=lambda s: s.line)
        common.assign_flat_end_lines(sections, total_lines)

        return symbols, [], [], sections

    except (re.error, UnicodeDecodeError, AttributeError, IndexError, OverflowError) as exc:
        _LOG.debug("graphql_idx: parse failed for %s: %s", rel_path, exc, exc_info=True)
        return [], [], [], []
