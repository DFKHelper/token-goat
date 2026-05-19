"""Shared utilities for language-specific symbol extractors."""
from __future__ import annotations

__all__ = [
    "AddSymbolFn",
    "CALL_RE",
    "KindStr",
    "add_imports",
    "add_symbol_info",
    "assign_flat_end_lines",
    "bom_strip_first_line",
    "build_line_index",
    "build_signature",
    "collect_symbols_and_refs",
    "decode_source_text",
    "extract_and_finalize_html_sections",
    "extract_html_headings",
    "extract_refs_from_source",
    "get_tlp",
    "kind_str",
    "make_add_symbol",
    "make_process_config",
    "offset_to_line",
    "parse_source",
    "sym_kind_str",
]

import logging
import re
import types
from collections.abc import Callable
from typing import TYPE_CHECKING, Protocol, TypeAlias

if TYPE_CHECKING:
    from ..parser import ImpExp, Ref, Section, Symbol

_LOG = logging.getLogger("token_goat.languages.common")

# Shared call-site ref pattern for languages whose identifiers follow
# [A-Za-z_][A-Za-z0-9_]* (Python, Go, Rust).  TypeScript/JS extends this with
# '$' and defines its own local variant.  Compiled once here so each adapter
# avoids a redundant re.compile() call at import time.
CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(")


class AddSymbolFn(Protocol):
    """Protocol for the recursive ``_add_symbol`` closure returned by :func:`make_add_symbol`.

    Defines the exact callable signature — ``(item, parent_name=None) -> None`` —
    so that callers get precise type checking instead of the looser
    ``Callable[..., None]``.
    """

    def __call__(self, item: object, parent_name: str | None = None) -> None: ...


# Canonical kind string (e.g. "function", "class", "method", "const", "var")
KindStr: TypeAlias = str

# Base mapping shared by most languages (Go, TypeScript, Python)
_BASE_KIND_STR_MAPPING: dict[str, KindStr] = {
    "Function": "function",
    "Method": "method",
    "Class": "class",
    "Struct": "type",
    "Interface": "interface",
    "Enum": "enum",
    "Trait": "interface",
    "Impl": "class",
    "Module": "const",
    "Namespace": "const",
    "Other": "var",
}

# Python-specific mapping (uses same base plus "Method")
_PYTHON_KIND_STR_MAPPING: dict[str, KindStr] = _BASE_KIND_STR_MAPPING

# Rust-specific overrides (Impl -> impl, Module -> module, Namespace -> module)
_RUST_KIND_STR_MAPPING: dict[str, KindStr] = {
    **_BASE_KIND_STR_MAPPING,
    "Impl": "impl",
    "Module": "module",
    "Namespace": "module",
}

# Base mapping shared by all languages
_BASE_SYM_KIND_STR_MAPPING: dict[str, KindStr] = {
    "Function": "function",
    "Class": "class",
    "Interface": "interface",
    "Type": "type",
    "Enum": "enum",
    "Constant": "const",
    "Variable": "var",
    "Module": "const",
    "Other": "var",
}

# Rust-specific overrides (Module -> module)
_RUST_SYM_KIND_STR_MAPPING: dict[str, KindStr] = {
    **_BASE_SYM_KIND_STR_MAPPING,
    "Module": "module",
}


def kind_str(structure_kind: object, language: str = "go") -> str:
    """Convert tree-sitter StructureKind to canonical kind string.

    Supports language-specific overrides for Impl, Module, Namespace mappings.
    Python, Go, TypeScript use base mapping; Rust has overrides.
    """
    s = str(structure_kind).rpartition(".")[-1]
    mapping = _RUST_KIND_STR_MAPPING if language == "rust" else _BASE_KIND_STR_MAPPING
    return mapping.get(s, "var")


def sym_kind_str(sym_kind: object, language: str = "go") -> str:
    """Convert tree-sitter SymbolKind to canonical kind string.

    Supports language-specific overrides for Module mappings.
    """
    s = str(sym_kind).rpartition(".")[-1]
    mapping = _RUST_SYM_KIND_STR_MAPPING if language == "rust" else _BASE_SYM_KIND_STR_MAPPING
    return mapping.get(s, "var")


def get_tlp() -> types.ModuleType | None:
    """Return the tree_sitter_language_pack module, or None if not installed."""
    try:
        import tree_sitter_language_pack as tlp  # noqa: PLC0415
    except ModuleNotFoundError:
        return None
    return tlp


def parse_source(
    source: bytes,
    language: str,
    rel_path: str,
    log: logging.Logger,
    **process_config_kwargs: bool,
) -> tuple[object, str] | tuple[None, None]:
    """Decode *source* and run tree-sitter processing, returning ``(result, text)``.

    Consolidates the repeated preamble found in every tree-sitter language
    adapter::

        text = source.decode("utf-8", errors="replace")
        tlp, cfg = common.make_process_config(language=language)
        if tlp is None:
            return [], [], [], []
        try:
            result = tlp.process(text, cfg)
        except Exception:
            _LOG.debug(...)
            return [], [], [], []

    Returns ``(result, text)`` on success, or ``(None, None)`` when tree-sitter
    is unavailable or parsing fails.  Callers should guard with::

        result, text = common.parse_source(source, "go", rel_path, _LOG)
        if result is None:
            return [], [], [], []

    Parameters
    ----------
    source:
        Raw file bytes to decode and parse.
    language:
        Language name forwarded to :func:`make_process_config`.
    rel_path:
        Relative file path used in the debug log message on parse failure.
    log:
        Logger instance for the calling module.
    **process_config_kwargs:
        Extra keyword arguments forwarded to :func:`make_process_config`
        (e.g. ``exports=True`` for TypeScript).
    """
    text = source.decode("utf-8", errors="replace")
    tlp, cfg = make_process_config(language=language, **process_config_kwargs)
    if tlp is None:
        _LOG.debug("tree-sitter language pack unavailable; skipping parse for %s", rel_path)
        return None, None
    try:
        result = tlp.process(text, cfg)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "tree-sitter parse failed for %s (%s): %s — file will be indexed without symbols",
            rel_path, language, exc,
        )
        return None, None
    return result, text


def make_process_config(
    language: str,
    structure: bool = True,
    imports: bool = True,
    exports: bool = False,
    symbols: bool = True,
) -> tuple[types.ModuleType, object] | tuple[None, None]:
    """Create a ProcessConfig for tree-sitter language pack processing.

    Extracted common pattern to avoid duplicating the ProcessConfig setup
    in every language adapter.

    Parameters
    ----------
    language:
        The language to process (e.g., "go", "python", "typescript", "rust").
    structure:
        Whether to extract structure (functions, classes, etc.).
    imports:
        Whether to extract imports.
    exports:
        Whether to extract exports (TypeScript/JavaScript only).
    symbols:
        Whether to extract symbols.

    Returns
    -------
    tuple[types.ModuleType, object] | tuple[None, None]
        A tuple of (tlp_module, ProcessConfig) if tree-sitter is available,
        or (None, None) if not.
    """
    tlp = get_tlp()
    if tlp is None:
        return None, None
    return tlp, tlp.ProcessConfig(
        language=language,
        structure=structure,
        imports=imports,
        exports=exports,
        symbols=symbols,
    )


def build_signature(source: bytes, item_span: object, body_span: object | None) -> str | None:
    """Extract declaration header (before body brace/colon) from raw source bytes.

    Returns at most 200 characters of the header, or None if unavailable.
    """
    if body_span is None:
        return None
    try:
        header = source[item_span.start_byte : body_span.start_byte]  # type: ignore[union-attr]
        text = header.decode("utf-8", errors="replace").strip()
        if len(text) > 200:
            text = text[:200]
        return text or None
    except (IndexError, AttributeError) as exc:
        # AttributeError: span objects are duck-typed C extension structs; .start_byte /
        # .end_byte may be absent on unexpected node shapes from newer tree-sitter grammars.
        _LOG.debug("build_signature: skipping malformed span (no signature extracted): %s", exc)
        return None


def extract_refs_from_source(
    source: bytes,
    call_re: re.Pattern[str],
    call_noise: frozenset[str],
) -> list[Ref]:
    """Extract call-site refs using regex on the source text.

    Shared implementation for all language adapters.  Each adapter supplies its
    own ``call_re`` (identifier pattern) and ``call_noise`` (builtins to skip).

    Returns a list of :class:`~token_goat.parser.Ref` objects.
    """
    from ..parser import Ref  # noqa: PLC0415

    refs: list[Ref] = []
    seen: set[tuple[str, int]] = set()
    text = source.decode("utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in call_re.finditer(line):
            name = m.group(1)
            if name in call_noise or len(name) <= 1:
                continue
            key = (name, lineno)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Ref(name=name, line=lineno, col=m.start(1), context=line.strip()[:120]))
    return refs


def make_add_symbol(
    symbols: list[Symbol],
    seen_names: set[tuple[str, int]],
    source: bytes,
    language: str = "go",
    *,
    promote_methods: bool = False,
) -> AddSymbolFn:
    """Return a recursive ``_add_symbol(item, parent_name)`` closure.

    Extracted from the four language adapters (go, typescript, python, rust) to
    eliminate the duplicated inner-function pattern.  Each adapter passes its own
    ``symbols`` list and ``seen_names`` set so the closure mutates them directly.

    Parameters
    ----------
    symbols:
        The list to append :class:`~token_goat.parser.Symbol` objects to.
    seen_names:
        The deduplication set of ``(name, line)`` pairs.
    source:
        Raw file bytes used by :func:`build_signature`.
    language:
        Forwarded to :func:`kind_str` for language-specific kind mappings.
    promote_methods:
        If ``True``, any ``function`` kind whose parent is not ``None`` is
        promoted to ``method``.  Python and Rust use this; Go and TypeScript do
        not need it (Go has no methods via structure; TypeScript does but
        tree-sitter already labels them).
    """
    from ..parser import Symbol  # noqa: PLC0415

    def _add_symbol(item: object, parent_name: str | None = None) -> None:
        """Recursively walk a tree-sitter node and append named symbols to *symbols*.

        Unnamed nodes (e.g. anonymous scopes, group nodes with no ``name``
        attribute) are transparently descended into so their named children are
        still collected.  Duplicate ``(name, line)`` pairs are skipped via
        *seen_names*.  When *promote_methods* is ``True``, functions nested
        inside a parent scope are recorded with ``kind="method"`` rather than
        ``kind="function"``.
        """
        try:
            name: str = item.name  # type: ignore[attr-defined]
        except AttributeError:
            # Language adapter nodes are duck-typed objects from C extensions; .name is
            # not guaranteed on every node variant — absent means this node has no symbol.
            return
        if not name:
            try:
                children = item.children  # type: ignore[attr-defined]
            except AttributeError:
                return
            for child in children:
                _add_symbol(child, parent_name=parent_name)
            return
        try:
            span = item.span
            body_span = item.body_span if hasattr(item, "body_span") else None
            line = span.start_line + 1
            end_line = span.end_line + 1
            kind = kind_str(item.kind, language=language)
        except AttributeError as exc:
            # .span / .kind may be missing on partial parse results (e.g. error-recovery
            # nodes emitted by tree-sitter when the source contains syntax errors).
            _LOG.debug("make_add_symbol: skipping malformed node %r: %s", name, exc)
            return
        if promote_methods and parent_name is not None and kind == "function":
            kind = "method"
        sig = build_signature(source, span, body_span)

        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=kind,
                    line=line,
                    end_line=end_line,
                    signature=sig,
                    parent_name=parent_name,
                )
            )

        try:
            children = item.children  # type: ignore[attr-defined]
        except AttributeError:
            return
        for child in children:
            _add_symbol(child, parent_name=name)

    return _add_symbol


def add_imports(
    imp_exp: list[ImpExp],
    imports: list[object],
    extract_targets_fn: Callable[[object], str | list[str]],
) -> None:
    """Add imports to the imp_exp list using a caller-supplied extraction function.

    Extracted common pattern used by all language adapters to avoid duplicating
    the imports loop. The extraction function may return one or more targets
    per import (e.g., Python's multi-target imports).

    Parameters
    ----------
    imp_exp:
        The list to append :class:`~token_goat.parser.ImpExp` objects to.
    imports:
        The result.imports list from tree-sitter processing.
    extract_targets_fn:
        A callable(imp) -> str | list[str] that extracts target(s) from an import object.
    """
    from ..parser import ImpExp  # noqa: PLC0415

    for imp in imports:
        try:
            targets = extract_targets_fn(imp)
            if isinstance(targets, str):
                targets = [targets] if targets else []
            line = imp.span.start_line + 1  # type: ignore[union-attr]
        except AttributeError as exc:
            _LOG.debug("add_imports: skipping malformed import node: %s", exc)
            continue
        for target in targets:
            if target:
                imp_exp.append(ImpExp(kind="import", target=target, line=line))


def add_symbol_info(
    symbols: list[Symbol],
    seen_names: set[tuple[str, int]],
    symbol_infos: list[object],
    language: str = "go",
) -> None:
    """Add symbols from result.symbols (SymbolInfo) to the symbol list.

    Extracted common pattern used by all language adapters (go, python, typescript, rust)
    to avoid duplicating the loop body for SymbolInfo processing.

    Parameters
    ----------
    symbols:
        The list to append :class:`~token_goat.parser.Symbol` objects to.
    seen_names:
        The deduplication set of ``(name, line)`` pairs.
    symbol_infos:
        The result.symbols list from tree-sitter processing.
    language:
        Forwarded to :func:`sym_kind_str` for language-specific kind mappings.
    """
    from ..parser import Symbol  # noqa: PLC0415

    before = len(symbols)
    for sym in symbol_infos:
        try:
            name: str = sym.name  # type: ignore[attr-defined]
            span = sym.span
            line = span.start_line + 1
            kind = sym_kind_str(sym.kind, language=language)
        except AttributeError as exc:
            _LOG.debug("add_symbol_info (%s): skipping malformed SymbolInfo: %s", language, exc)
            continue
        key = (name, line)
        if key not in seen_names:
            seen_names.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    kind=kind,
                    line=line,
                    end_line=span.end_line + 1,
                    signature=None,
                    parent_name=None,
                )
            )
    added = len(symbols) - before
    skipped = len(symbol_infos) - added
    _LOG.debug(
        "add_symbol_info (%s): added %d symbol(s) from %d candidates (%d duplicate(s) skipped)",
        language, added, len(symbol_infos), skipped,
    )


def collect_symbols_and_refs(
    source: bytes,
    language: str,
    rel_path: str,
    log: logging.Logger,
    call_re: re.Pattern[str],
    call_noise: frozenset[str],
    *,
    promote_methods: bool = False,
    **process_config_kwargs: bool,
) -> tuple[list[Symbol], list[ImpExp], set[tuple[str, int]], list[Ref], object] | None:
    """Run the standard symbol-extraction pipeline shared by most language adapters.

    Consolidates the five repeated steps found in python, go, and rust adapters:

    1. ``parse_source`` (tree-sitter decode + process; return None on failure)
    2. Initialise ``symbols``, ``imp_exp``, and ``seen_names`` collections.
    3. Walk ``result.structure`` via ``make_add_symbol``.
    4. Add ``result.symbols`` (SymbolInfo) via ``add_symbol_info``.
    5. Extract call-site refs via ``extract_refs_from_source``.

    Returns ``(symbols, imp_exp, seen_names, refs, result)`` so callers can
    append their own language-specific symbols (e.g. Go const/var) and handle
    imports with a per-language extraction function before returning.

    Returns ``None`` when tree-sitter is unavailable or parsing fails, so
    callers can fall through to ``return [], [], [], []`` directly::

        collected = common.collect_symbols_and_refs(source, "go", rel_path, _LOG,
                                                    _CALL_RE, _CALL_NOISE)
        if collected is None:
            return [], [], [], []
        symbols, imp_exp, seen_names, refs, result = collected

    Parameters
    ----------
    source:
        Raw file bytes.
    language:
        Language name forwarded to ``parse_source`` and ``make_add_symbol``.
    rel_path:
        Relative file path used in debug log messages.
    log:
        Logger instance from the calling module.
    call_re:
        Compiled regex for call-site extraction (language-specific).
    call_noise:
        Frozenset of names to exclude from refs (language-specific builtins).
    promote_methods:
        Forwarded to ``make_add_symbol``; True for Python and Rust.
    **process_config_kwargs:
        Extra keyword arguments forwarded to ``parse_source`` / ``make_process_config``
        (e.g. ``exports=True`` for TypeScript).
    """

    result, _text = parse_source(source, language, rel_path, log, **process_config_kwargs)
    if result is None:
        return None

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []
    seen_names: set[tuple[str, int]] = set()

    _add_symbol = make_add_symbol(
        symbols, seen_names, source, language=language, promote_methods=promote_methods
    )
    for item in result.structure:  # type: ignore[attr-defined]
        _add_symbol(item)

    add_symbol_info(symbols, seen_names, result.symbols, language=language)  # type: ignore[attr-defined]

    refs: list[Ref] = extract_refs_from_source(source, call_re, call_noise)

    return symbols, imp_exp, seen_names, refs, result


def build_line_index(text: str) -> list[int]:
    """Return a list of character offsets for the start of each line (0-indexed).

    ``build_line_index(text)[i]`` is the character position of the first character
    of line ``i+1`` (1-indexed).  A binary search on this list converts any
    character offset to a 1-indexed line number in O(log n) instead of the O(n)
    slice-and-count pattern ``text[:pos].count("\\n") + 1``.

    Used by html.py and liquid.py for efficient match-position → line-number
    conversion; centralised here so both adapters share a single implementation.
    """
    offsets = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            # Record the start of the *next* line (i+1), not the newline itself,
            # so offsets[k] is always the index of the first char on line k+1.
            offsets.append(i + 1)
    return offsets


def offset_to_line(line_index: list[int], offset: int) -> int:
    """Convert a character offset to a 1-indexed line number using binary search.

    Companion to :func:`build_line_index`.  O(log n) in the number of lines.

    Uses the upper-biased midpoint ``(lo + hi + 1) // 2`` (ceiling) so the
    invariant ``line_index[lo] <= offset`` is maintained when lo == hi - 1,
    preventing the loop from stalling on adjacent elements.  The plain floor
    midpoint would loop infinitely in that case.
    """
    lo, hi = 0, len(line_index) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_index[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def _compute_section_end_lines(sections: list[Section], lines: list[str]) -> None:
    """Assign end_line to each Section based on the next section of equal or lesser level.

    Mutates sections in-place. 'lines' is used only to get the total line count (EOF).
    """
    total = len(lines)
    for i, sec in enumerate(sections):
        end_line = total
        for j in range(i + 1, len(sections)):
            if sections[j].level <= sec.level:
                end_line = sections[j].line - 1
                break
        sec.end_line = end_line


# Shared HTML heading regex used by both html.py and liquid.py.
#
# WHY [1-6] (not [1-4]): HTML headings legally span h1-h6.  Prior versions
# capped at h4 which silently dropped h5/h6 from doc-style HTML (e.g. deeply
# nested API references and TOCs).  WHY DOTALL: heading content may legitimately
# span lines (`<h2>\n  Long Heading\n</h2>`).  WHY capture the full attribute
# string: callers (see :func:`extract_html_headings`) may want the heading's
# `id` for anchor-aware lookup; we expose the whole opening-tag attribute
# blob and let the caller pull `id` out with a separate regex.
_H_TAG_RE = re.compile(r"<h([1-6])([^>]*)>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)

# id="..."` attribute inside an HTML opening tag, used to extract heading
# anchor ids so a caller can resolve `token-goat section path::foo` by heading
# id in addition to heading text.
_HEADING_ID_RE = re.compile(r"""\bid\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

# Strip inline HTML tags from heading inner text so `<h2><a>Title</a></h2>`
# yields "Title" rather than "<a>Title</a>".  WHY non-greedy: nested tags
# (e.g. `<h2><span><b>X</b></span></h2>`) must be removed one tag at a time.
_INLINE_TAG_RE = re.compile(r"<[^>]+>")
# Collapse runs of whitespace (including newlines from DOTALL captures) to a
# single space so headings rendered across multiple lines compare cleanly.
_WS_RUN_RE = re.compile(r"\s+")


def extract_and_finalize_html_sections(
    text: str,
    sections: list[Section],
    lines: list[str],
) -> None:
    """Extract HTML headings from *text* and assign end_line to each Section.

    Combines the two calls that appear identically in ``html.py`` and
    ``liquid.py``::

        common.extract_html_headings(text, sections)
        common._compute_section_end_lines(sections, lines)

    Callers that need only the headings step (without end_line assignment) can
    still call :func:`extract_html_headings` directly.
    """
    extract_html_headings(text, sections)
    _compute_section_end_lines(sections, lines)


def extract_html_headings(text: str, sections: list[Section]) -> None:
    """Append HTML heading Sections parsed from *text* into *sections*.

    Handles ``<h1>``–``<h6>`` tags (the full HTML heading range).  Caller is
    responsible for calling ``_compute_section_end_lines`` afterwards.

    When a heading has an ``id`` attribute (e.g. ``<h2 id="install">Install</h2>``),
    we emit **two** sections covering the same span:

    1. The text content (``"Install"``) — matches a user query like
       ``token-goat section page.html::Install``.
    2. The anchor id (``"install"``) — matches anchor-href-style lookups like
       ``token-goat section page.html::install``.

    Both share the same line/level/end_line so retrieval returns the same span
    regardless of which key the caller used.  Inline HTML tags inside the
    heading (``<a>``, ``<span>``, etc.) are stripped before recording.
    """
    from ..parser import Section as _Section  # noqa: PLC0415

    before = len(sections)
    for match in _H_TAG_RE.finditer(text):
        level = int(match.group(1))
        attrs = match.group(2)
        raw_inner = match.group(3)
        # Strip inline tags and collapse whitespace runs (including newlines
        # captured under DOTALL).
        inner = _INLINE_TAG_RE.sub("", raw_inner)
        heading_text = _WS_RUN_RE.sub(" ", inner).strip()
        if not heading_text:
            continue
        heading_text = heading_text[:100]
        line = text[: match.start()].count("\n") + 1
        sections.append(_Section(heading=heading_text, level=level, line=line))
        id_match = _HEADING_ID_RE.search(attrs or "")
        if id_match:
            anchor = id_match.group(1).strip()[:100]
            # WHY append a second Section: this is the cheapest way to make
            # `token-goat section path::install` work without changing the DB
            # schema or the caller-side resolver.  end_line is recomputed for
            # both by `_compute_section_end_lines` so the span is identical.
            if anchor and anchor != heading_text:
                sections.append(_Section(heading=anchor, level=level, line=line))
    added = len(sections) - before
    _LOG.debug("extract_html_headings: added %d section(s)", added)


# ---------------------------------------------------------------------------
# Config-file helpers (TOML / INI / YAML / Dockerfile)
# ---------------------------------------------------------------------------

def decode_source_text(source: bytes, log: logging.Logger, label: str) -> str | None:
    """Decode *source* bytes to a normalised text string, or return None on failure.

    Consolidates the identical preamble in ``toml_idx``, ``yaml_idx``,
    ``ini_idx``, and ``dockerfile_idx``::

        text = source.decode("utf-8", errors="replace").replace(\"\\r\\n\", \"\\n\").replace(\"\\r\", \"\\n\")

    On :exc:`UnicodeDecodeError` or :exc:`AttributeError` the error is logged
    at DEBUG level and ``None`` is returned so callers can ``return [], [], [], []``
    directly.

    Parameters
    ----------
    source:
        Raw file bytes to decode.
    log:
        Caller's logger; used for the failure message.
    label:
        Short adapter label prepended to the log message (e.g. ``"toml_idx"``).
    """
    try:
        return source.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except (UnicodeDecodeError, AttributeError) as exc:
        log.debug("%s: decode failed: %s", label, exc)
        return None


_UTF8_BOM = "﻿"


def bom_strip_first_line(line: str, idx: int) -> str:
    """Strip a leading UTF-8 BOM from *line* when *idx* is 1, otherwise return *line* unchanged.

    Consolidates the repeated pattern in ``toml_idx``, ``yaml_idx``,
    ``ini_idx``, and ``dockerfile_idx``::

        candidate = line.lstrip(\"\\ufeff\") if idx == 1 else line

    Notepad on Windows saves plain-text files as UTF-8 with BOM by default.
    The BOM character (U+FEFF) appears as the very first byte sequence and
    prevents column-0-anchored regexes from matching headers on the first line.
    Stripping it only on line 1 is safe: BOM is only valid at the start of a
    file, never mid-document.
    """
    return line.lstrip(_UTF8_BOM) if idx == 1 else line


def assign_flat_end_lines(sections: list[Section], total_lines: int) -> None:
    """Assign ``end_line`` to each Section in a flat (non-nested) section list.

    Consolidates the identical end-line computation loop found in
    ``toml_idx``, ``ini_idx``, and ``dockerfile_idx``::

        for i, sec in enumerate(sections):
            if i + 1 < len(sections):
                sec.end_line = max(sec.line, sections[i + 1].line - 1)
            else:
                sec.end_line = max(sec.line, total_lines)

    "Flat" means no nested heading hierarchy — every section is at the same
    level and a section's content ends at the line before the next section
    header (or at ``total_lines`` for the last one).  TOML, INI, and
    Dockerfile all share this shape.

    YAML's nested sections use a different algorithm
    (:func:`_compute_section_end_lines`) and should not use this helper.

    Parameters
    ----------
    sections:
        The ordered list of :class:`~token_goat.parser.Section` objects to mutate.
    total_lines:
        Total number of lines in the file (``len(text.split("\\n"))``).
    """
    for i, sec in enumerate(sections):
        if i + 1 < len(sections):
            sec.end_line = max(sec.line, sections[i + 1].line - 1)
        else:
            sec.end_line = max(sec.line, total_lines)
