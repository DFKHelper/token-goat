"""TypeScript/TSX/JS/JSX symbol extractor using tree_sitter_language_pack."""
from __future__ import annotations

__all__ = ["extract"]

import logging
import re
from os.path import basename

from ..parser import ImpExp, Ref, Section, Symbol
from . import common

_LOG = logging.getLogger("token_goat.languages.typescript")


# Matches a TypeScript decorator line: optional indent, then ``@Name`` where Name
# is a (possibly dotted) identifier.  ``@Component({…})`` and ``@Inject(TOKEN)``
# share the same prefix, so we anchor on ``@<ident>`` and rely on the multi-line
# logic below to follow the parenthesized argument list when present.
_TS_DECORATOR_LINE_RE = re.compile(r"^\s*@[A-Za-z_$][A-Za-z0-9_$.]*")


def _decorator_block_start(text_lines: list[str], def_line_1based: int) -> int:
    """Walk *def_line_1based* upward over a contiguous decorator block.

    TypeScript decorators may stretch across several source lines when their
    argument list contains object/array literals — for example:

        @Component({
            selector: 'x-foo',
            template: '<div></div>',
        })
        export class Foo {}

    A naive "previous line starts with @" check would only catch the final
    ``})`` line and stop short.  Instead we walk upward while tracking
    bracket balance: a line with more closers than openers ``)`` / ``}`` /
    ``]`` (negative cumulative balance) means we are still inside a
    multi-line construct whose opening token lives further up.  We keep
    walking until we hit either:

      1. A line that starts with ``@`` (a decorator) — claim it and reset
         the bracket counters since the decorator's own openers balance
         everything we've counted below it.
      2. A line with non-negative balance that is not a decorator and is
         not blank-after-decorator-seen — stop and return.

    Returns the 1-based start line that includes every preceding decorator,
    or *def_line_1based* itself when no decorators precede the definition.
    """
    n = len(text_lines)
    if def_line_1based <= 1 or def_line_1based > n:
        return def_line_1based

    new_start = def_line_1based
    i = def_line_1based - 2  # 0-based index of the line directly above the def
    # Cumulative balance counters across all lines walked since the most
    # recently seen decorator.  Negative = unclosed brackets above us.
    balance_paren = 0
    balance_brace = 0
    balance_bracket = 0
    saw_decorator = False
    while i >= 0:
        line = text_lines[i]
        if _TS_DECORATOR_LINE_RE.match(line):
            new_start = i + 1  # 1-based
            saw_decorator = True
            # Reset balance: the decorator's own openers on this line account
            # for every closer we counted below.
            balance_paren = 0
            balance_brace = 0
            balance_bracket = 0
            i -= 1
            continue
        # Tolerate blank lines between stacked decorators, but only after we
        # have already locked onto a decorator block above.  A blank line
        # before any decorator means we crossed a real boundary.
        if saw_decorator and not line.strip():
            i -= 1
            continue
        # Strip line comments before counting brackets so ``// foo (bar)``
        # does not pollute the balance.
        sanitized = line.split("//", 1)[0]
        balance_paren += sanitized.count(")") - sanitized.count("(")
        balance_brace += sanitized.count("}") - sanitized.count("{")
        balance_bracket += sanitized.count("]") - sanitized.count("[")
        if balance_paren > 0 or balance_brace > 0 or balance_bracket > 0:
            # We're inside an unclosed decorator-arg literal — keep walking
            # so we can reach the ``@Name(`` line that opened it.
            i -= 1
            continue
        # Balance is non-negative and the line is not a decorator (or blank
        # gap).  We've left the decorator block.
        break
    return new_start


def _extend_starts_for_decorators(symbols: list[Symbol], source: bytes) -> None:
    """Mirror of the Python adapter's decorator post-pass for TypeScript.

    Tree-sitter reports the ``class``/``function``/method line as the symbol
    start, dropping any preceding decorators (``@Component``, ``@Injectable``,
    ``@deprecated``, parameter-property decorators on methods, etc.).  Without
    this pass an agent asking ``token-goat read "file.ts::Foo"`` for a
    decorated class loses the decorator's configuration object — exactly the
    metadata that explains how the class is wired into the application.

    Only ``class``, ``interface``, ``function``, and ``method`` kinds are
    walked back; const/var/type/enum exports cannot be decorated.
    """
    try:
        text_lines = source.decode("utf-8", errors="replace").splitlines()
    except (UnicodeDecodeError, AttributeError):
        return
    if not text_lines:
        return
    eligible = {"class", "interface", "function", "method"}
    for sym in symbols:
        if sym.kind not in eligible:
            continue
        new_start = _decorator_block_start(text_lines, sym.line)
        if new_start != sym.line:
            sym.line = new_start


# ---------------------------------------------------------------------------
# ABI special-case config (tunable via caller meta, not exposed in CLI yet)
# ---------------------------------------------------------------------------

_ABI_SIZE_THRESHOLD = 100_000       # bytes — files smaller than this are never ABI mode
_ABI_MAX_SYMBOLS = 500              # cap on symbols emitted for ABI files

# Top-level export extraction for ABI mode
_ABI_EXPORT_RE = re.compile(
    r"^export\s+(?:const|default|let|var|function|class|interface|type|enum)\s+"
    r"([A-Za-z_$][A-Za-z0-9_$]*)",
    re.MULTILINE,
)


def _looks_like_abi_filename(name: str, parts: list[str]) -> bool:
    """Return True when the filename or directory path matches known ABI naming patterns.

    Checked before reading file content so we avoid decoding large files whose
    name already identifies them as generated ABI constants.

    Patterns:
    - ``*abi.ts``, ``*abi.d.ts``, ``*.abi.ts`` — common generated type suffixes
    - Parent directory named ``abi/`` — conventional ABI bundle directory
    """
    return (
        name.endswith("abi.ts")
        or name.endswith("abi.d.ts")
        or name.endswith(".abi.ts")
        or (len(parts) >= 2 and parts[-2].lower() == "abi")
    )


def _is_abi_file(source: bytes, rel_path: str, threshold: int = _ABI_SIZE_THRESHOLD) -> bool:
    """Return True if this file should be treated as a generated ABI file.

    ABI files are large auto-generated TypeScript constants that encode Solidity
    contract interfaces.  Full tree-sitter parsing of these files is slow and
    produces thousands of near-useless symbols; the fast path in
    :func:`_extract_abi` handles them with a single regex pass instead.

    Three independent heuristics are checked in order (short-circuit on first
    match so we avoid reading the file content when the name already tells us):

    1. **Size gate** — files smaller than *threshold* bytes are never ABI mode,
       regardless of name or content.  This prevents mis-classifying tiny hand-
       written files that happen to share a name pattern.
    2. **Filename heuristic** — ``*abi.ts``, ``*abi.d.ts``, ``*.abi.ts``, or
       files inside an ``abi/`` directory are almost certainly generated.
    3. **Content heuristics** (read only when size + name both pass):
       - First 2 KB contains ``// generated`` / ``// auto-generated`` comment.
       - First 8 KB contains ``as const`` plus more than five ``"inputs":`` /
         ``"outputs":`` keys, which is the structural fingerprint of an ABI
         constant array.
    """
    if len(source) < threshold:
        return False

    # Filename heuristic
    name = basename(rel_path).lower()
    parts = rel_path.replace("\\", "/").split("/")
    if _looks_like_abi_filename(name, parts):
        return True

    # Content heuristic: check the first 2 KB for autogenerated headers
    head = source[:2048].decode("utf-8", errors="replace").lower()
    if any(marker in head for marker in ("// generated", "// auto-generated", "// autogenerated")):
        return True

    # Content heuristic: as const + many abi inputs/outputs
    text_sample = source[:8192].decode("utf-8", errors="replace")
    if "as const" in text_sample:
        n_inputs = text_sample.count('"inputs": [') + text_sample.count('"inputs":[')
        n_outputs = text_sample.count('"outputs": [') + text_sample.count('"outputs":[')
        if (n_inputs + n_outputs) > 5:
            return True

    return False


def _extract_abi(source: bytes) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Fast path for generated ABI files: index top-level exports only, no refs.

    Returns a 4-tuple matching the Extractor protocol (symbols, refs,
    imports/exports, sections). Sections is always empty for ABI files.
    """
    text = source.decode("utf-8", errors="replace")
    lines = text.splitlines()
    symbols: list[Symbol] = []
    seen: set[str] = set()

    for m in _ABI_EXPORT_RE.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        # Compute line number from match position
        line = text[: m.start()].count("\n") + 1
        sig = lines[line - 1].rstrip()[:150] if line <= len(lines) else None
        symbols.append(Symbol(name=name, kind="abi_export", line=line, end_line=line, signature=sig))
        if len(symbols) >= _ABI_MAX_SYMBOLS:
            break

    return symbols, [], [], []

# ---------------------------------------------------------------------------
# Noise filter for call-site refs
# ---------------------------------------------------------------------------

_CALL_NOISE = frozenset([
    # JS builtins and globals
    "console", "Object", "Array", "Math", "JSON", "Promise", "Error",
    "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect",
    "String", "Number", "Boolean", "BigInt", "RegExp", "Date",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
    "decodeURIComponent", "encodeURI", "decodeURI", "setTimeout",
    "setInterval", "clearTimeout", "clearInterval", "fetch", "require",
    # Keywords that can be followed by (
    "if", "for", "while", "switch", "catch", "return", "throw",
    "typeof", "instanceof", "void", "delete", "yield", "await",
    "new", "super",
    # Single-char names
])

# Regex: identifier NOT preceded by . or -> that is immediately followed by (
_CALL_RE = re.compile(r"(?<![.\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(")

# Regex to extract module path from import/export source line
_FROM_RE = re.compile(r"""from\s+['"]([^'"]+)['"]""")
_IMPORT_RE = re.compile(r"""^import\s+.*?['"]([^'"]+)['"]""")

# Export name extraction patterns — compiled once at module level so the
# per-call loop in extract() does not pay re.compile() overhead on every file.
_EXPORT_NAME_RES: list[re.Pattern[str]] = [
    re.compile(r"export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"export\s+(?:type\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
]

# Compiled pattern for const/let/var export symbol extraction (used inside the
# export loop — must not be recreated per iteration).
_EXPORT_CONST_RE = re.compile(
    r"export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"
)


def _extract_module(source_line: str) -> str:
    """Extract the module string from an import/export source text."""
    m = _FROM_RE.search(source_line)
    if m:
        return m.group(1)
    stripped = source_line.strip()
    m = _IMPORT_RE.match(stripped)
    if m:
        return m.group(1)
    return stripped


def extract(
    source: bytes,
    rel_path: str,
    *,
    meta: dict[str, object] | None = None,
) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]:
    """Extract symbols, refs, and imports/exports from a TS/TSX/JS/JSX file.

    ``meta`` is an optional dict supporting:
    - ``abi_size_threshold`` (int): override default 100_000-byte threshold
    - ``abi_max_symbols_per_file`` (int): override default 500-symbol cap
    """
    # Apply meta overrides for ABI config
    abi_threshold = _ABI_SIZE_THRESHOLD
    abi_max = _ABI_MAX_SYMBOLS
    if meta:
        raw_threshold = meta.get("abi_size_threshold")
        raw_max = meta.get("abi_max_symbols_per_file")
        try:
            if isinstance(raw_threshold, (int, float, str)):
                abi_threshold = int(raw_threshold)
            if isinstance(raw_max, (int, float, str)):
                abi_max = int(raw_max)
        except (TypeError, ValueError):
            _LOG.debug(
                "invalid ABI meta values (abi_size_threshold=%r, abi_max_symbols_per_file=%r); "
                "using defaults",
                raw_threshold,
                raw_max,
            )

    # ABI fast path: skip expensive structure walk for huge generated type files
    if len(source) >= abi_threshold and _is_abi_file(source, rel_path, threshold=abi_threshold):
        syms, refs, ie, _ = _extract_abi(source)
        # Honour caller-supplied cap
        capped = syms[:abi_max]
        _LOG.debug(
            "ABI fast path: %s size=%d symbols=%d (capped at %d)",
            rel_path,
            len(source),
            len(capped),
            abi_max,
        )
        return capped, refs, ie, []

    # Detect language for tlp
    lower = rel_path.lower()
    if lower.endswith((".tsx", ".jsx")):
        lang = "tsx"
    elif lower.endswith(".ts"):
        lang = "typescript"
    else:
        lang = "javascript"

    text = source.decode("utf-8", errors="replace")
    tlp, cfg = common.make_process_config(language=lang, exports=True)
    if tlp is None:
        return [], [], [], []
    try:
        result = tlp.process(text, cfg)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "tree-sitter parse failed for %s (typescript): %s — file will be indexed without symbols",
            rel_path, exc,
        )
        return [], [], [], []

    symbols: list[Symbol] = []
    imp_exp: list[ImpExp] = []

    # --- symbols from structure (gives us methods via children) ---
    seen_names: set[tuple[str, int]] = set()
    _add_symbol = common.make_add_symbol(symbols, seen_names, source, language="typescript")
    for item in result.structure:
        _add_symbol(item)

    # --- additional symbols from SymbolInfo (catches type aliases, enums) ---
    common.add_symbol_info(symbols, seen_names, result.symbols, language="typescript")

    # --- const/var from exports not captured above ---
    # exports like 'export const router = express()' aren't in structure;
    # also extract clean names for all export ImpExp entries
    for exp in result.exports:
        name_raw: str = exp.name  # type: ignore[attr-defined]
        span = exp.span
        line = span.start_line + 1

        # Attempt to extract a clean identifier from the statement text.
        # _EXPORT_NAME_RES is compiled once at module level.
        export_name: str | None = None
        for pattern in _EXPORT_NAME_RES:
            m = pattern.match(name_raw)
            if m:
                export_name = m.group(1)
                break

        if export_name is None:
            # Fallback: use first token after 'export'
            tokens = name_raw.strip().split()
            export_name = tokens[1] if len(tokens) > 1 else name_raw[:80]

        # For const/let/var exports not already in structure, add a symbol.
        # _EXPORT_CONST_RE is compiled once at module level.
        const_m = _EXPORT_CONST_RE.match(name_raw)
        if const_m:
            cname = const_m.group(1)
            key = (cname, line)
            if key not in seen_names:
                seen_names.add(key)
                symbols.append(
                    Symbol(name=cname, kind="const", line=line, end_line=line, signature=None)
                )

        # Record as ImpExp
        kind_str = str(exp.kind).rpartition(".")[-1].lower()
        ie_kind = "reexport" if kind_str == "reexport" else "export"
        imp_exp.append(ImpExp(kind=ie_kind, target=export_name, line=line))

    # --- imports ---
    common.add_imports(
        imp_exp,
        result.imports,
        lambda imp: _extract_module(imp.source),  # type: ignore[attr-defined]
    )

    # --- refs via regex ---
    refs: list[Ref] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE)  # type: ignore[no-redef]

    # --- post-pass: extend start_line over preceding decorator lines ---
    # WHY post-pass: tree-sitter's structure walk reports `class`/`function` as
    # the start, missing any `@Component({...})` / `@Injectable()` lines above.
    _extend_starts_for_decorators(symbols, source)

    return symbols, refs, imp_exp, []
