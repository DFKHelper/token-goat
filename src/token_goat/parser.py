"""Tree-sitter orchestration: walks a project, dispatches to per-language extractors, writes to DB."""
from __future__ import annotations

__all__ = [
    "LANG_BY_EXT",
    "MAX_SYMBOLS_PER_FILE",
    "SKIP_DIRS",
    "Extractor",
    "FileIndex",
    "ImpExp",
    "IndexProjectResult",
    "LargeFileInfo",
    "Ref",
    "Section",
    "Symbol",
    "get_extractor",
    "index_file",
    "index_project",
    "iter_source_files",
    "load_project_ignore_patterns",
    "parser_cache_clear",
    "parser_cache_stats",
    "register_extractor",
    "write_file_index",
]

import contextlib
import fnmatch
import hashlib
import heapq
import json
import os
import sqlite3
import threading
import time
from collections import Counter, OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Final, NamedTuple, TypedDict

from . import db
from .util import get_logger

if TYPE_CHECKING:
    from .project import Project

_LOG = get_logger("parser")

# Extension -> language_key
LANG_BY_EXT: dict[str, str] = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".c": "c",
    ".h": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".phtml": "php",
    ".liquid": "liquid",
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".toml": "toml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".ini": "ini",
    ".cfg": "ini",
    ".dockerfile": "dockerfile",
    ".css": "css",
    ".scss": "css",
    ".less": "css",
    ".sql": "sql",
    ".pgsql": "sql",
    ".psql": "sql",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".proto": "proto",
    ".mk": "makefile",
}

# Files identified by full basename rather than suffix.  Dotfiles like ``.env``
# and ``.envrc`` have an empty ``Path.suffix``, so the standard suffix lookup
# would silently skip them.  We resolve these by lowercase basename and fall
# through to the suffix-based ``LANG_BY_EXT`` path when no match is found.
# ``Dockerfile`` and ``Containerfile`` are also recognised by basename
# because the conventional spelling has no extension.
LANG_BY_BASENAME: dict[str, str] = {
    ".env": "env",
    ".envrc": "env",
    ".env.example": "env_file",
    ".env.sample": "env_file",
    ".env.local": "env_file",
    ".env.test": "env_file",
    ".env.development": "env_file",
    ".env.production": "env_file",
    ".env.staging": "env_file",
    "dockerfile": "dockerfile",
    "containerfile": "dockerfile",
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "makefile.am": "makefile",
    "makefile.in": "makefile",
}
# Frozenset view of LANG_BY_BASENAME (already-lowercase keys) — see the
# matching declaration above ``_KNOWN_EXTENSIONS`` for why this is precomputed.
_KNOWN_BASENAMES = frozenset(LANG_BY_BASENAME)

# Frozenset of all known extensions (already lowercase).  Used by iter_source_files
# for a fast O(1) membership test before the LANG_BY_EXT dict lookup, avoiding a
# .lower() string allocation on every file whose extension is not in the map.
_KNOWN_EXTENSIONS: frozenset[str] = frozenset(LANG_BY_EXT)

# Directories that should never be indexed
SKIP_DIRS: Final[frozenset[str]] = frozenset({
    "node_modules", ".git", ".hg", ".svn", ".bzr",
    ".next", "dist", "build", ".venv", "venv", "env",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    "target", "out", "coverage", ".turbo", ".vercel", ".svelte-kit",
    ".cache", ".idea", ".vscode", ".DS_Store", ".angular",
    ".nuxt", ".tox", ".eggs", "htmlcov", "bower_components", "vendor",
})

# Exact basenames (lowercase) that should never be indexed. These are generated
# lockfiles or OS metadata that match an extension in LANG_BY_EXT (e.g.
# ``package-lock.json`` has the indexed ``.json`` extension) but carry no
# semantic content the LLM would care about — a 100k-line lockfile blows up
# the symbol table and pollutes search results.
SKIP_FILE_BASENAMES: Final[frozenset[str]] = frozenset({
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
    "poetry.lock", "uv.lock", "pdm.lock", "pipfile.lock",
    "cargo.lock", "composer.lock", "gemfile.lock",
    ".ds_store", "thumbs.db", "desktop.ini",
})

# File-suffix markers that indicate a generated/minified artifact. Checked
# against the lowercased basename — matches ``app.min.js``, ``style.min.css``,
# ``app.js.map``, ``vendor.bundle.js``. Bundled/minified files have valid
# extensions (``.js``, ``.css``) so the extension check alone won't skip them.
SKIP_FILE_SUFFIXES: Final[tuple[str, ...]] = (
    ".min.js", ".min.css", ".min.mjs",
    ".bundle.js", ".bundle.mjs",
    ".js.map", ".mjs.map", ".css.map", ".ts.map",
    "-lock.json",  # catches package-lock.json variants and similar
)

# Default skip threshold (bytes) for oversized files — overridden at runtime by
# config.indexing.large_file_skip_kb so users can tune it without code changes.
# This constant is the hard-coded fallback used when config is unavailable (e.g.
# when iter_source_files is called from tests that patch the config module).
MAX_FILE_SIZE: Final[int] = 2_000_000  # 2 MB (matches default large_file_skip_kb=2048)

# Hard cap on the number of symbols stored per file.  Generated files (compiled
# CSS bundles, minified JS, auto-generated protobuf stubs) can contain tens of
# thousands of identifiers; storing them all would balloon the project DB, slow
# every query, and produce noise in --type filters.  When a file exceeds this
# limit the first MAX_SYMBOLS_PER_FILE symbols (in source order) are kept and
# the rest are silently dropped.  1 000 is conservative enough to cover any
# real hand-written source file while still capping pathological generated files.
MAX_SYMBOLS_PER_FILE: Final[int] = 1_000


def _is_generated_filename(name: str) -> bool:
    """Return True when *name* (a file basename) is a known generated/lock artifact.

    Combines the exact-basename and suffix-pattern checks into a single helper so
    ``iter_source_files`` can short-circuit before paying for ``stat()`` or symlink
    resolution.  Matching is case-insensitive (Windows-friendly).
    """
    lower = name.lower()
    if lower in SKIP_FILE_BASENAMES:
        return True
    return any(lower.endswith(suf) for suf in SKIP_FILE_SUFFIXES)


def load_project_ignore_patterns(project_root: Path) -> list[str]:
    """Load custom exclusion patterns from .tokengoatignore at project root.

    Returns a list of non-empty, non-comment lines. Strips comments (text after #)
    and blank lines. Returns [] if file doesn't exist or is unreadable.
    """
    from . import paths
    ignore_file = paths.project_ignore_file_path(project_root)
    if not ignore_file.exists():
        return []
    try:
        content = ignore_file.read_text(encoding="utf-8")
    except OSError as e:
        _LOG.debug("failed to read %s: %s", ignore_file, e)
        return []
    patterns = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Strip inline comment: '#' is a comment delimiter only when preceded by whitespace
        for _delim in (" #", "\t#"):
            _pos = line.find(_delim)
            if _pos != -1:
                line = line[:_pos].rstrip()
                break
        if line:
            patterns.append(line)
    return patterns


def _matches_ignore_pattern(rel_path: str, patterns: list[str]) -> bool:
    """Return True if rel_path matches any of the gitignore-style patterns.

    Tests both the full relative path and its basename. Normalizes path separators
    to forward slash before matching.
    """
    if not patterns:
        return False
    normalized = rel_path.replace("\\", "/")
    basename = normalized.split("/")[-1]
    for pattern in patterns:
        if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(basename, pattern):
            return True
    return False


@dataclass
class Symbol:
    """Represents a named entity (function, class, variable, etc.) in source code.

    Attributes:
        name: Symbol name as declared in code (e.g., 'getUserId', 'UserService', 'VERSION').
        kind: Symbol type: 'function', 'class', 'method', 'type', 'interface', 'const',
              'enum', 'var', 'arrow_fn', 'trait', 'impl', 'abi_export', etc. Language-specific.
        line: 1-based line number where symbol definition begins.
        col: 0-based column offset (default 0). Optional; not all languages track column data.
        end_line: 1-based line where symbol definition ends (inclusive). None if single-line or unavailable.
        signature: Parsed signature string for callables (e.g., '(x: int, y: str) -> bool').
                  None if not a callable or signature extraction not implemented for this language.
        parent_name: For nested symbols (methods, inner functions), the name of the enclosing
                    scope (e.g., 'UserService' for method hello). None for top-level symbols.
    """
    name: str
    kind: str            # function|class|method|type|interface|const|enum|var|arrow_fn
    line: int            # 1-indexed
    col: int = 0
    end_line: int | None = None
    signature: str | None = None
    parent_name: str | None = None   # for methods, nested fns


@dataclass
class Ref:
    """Represents a reference to a symbol in source code (usage or mention).

    Used to identify where symbols are invoked/accessed, supporting cross-file tracing
    and dependency analysis.

    Attributes:
        name: Name of the symbol being referenced.
        line: 1-based line number where the reference occurs.
        col: 0-based column offset (default 0).
        context: Optional contextual snippet around the reference (e.g., the surrounding
                statement or method name). Helps disambiguate which 'name' is referenced.
    """
    name: str
    line: int
    col: int = 0
    context: str | None = None


@dataclass
class ImpExp:
    """An import or export relationship extracted from a source file.

    Used to build the cross-reference graph that drives PageRank scoring in
    ``repomap.py``.

    Attributes:
        kind: Relationship type — one of ``"import"``, ``"export"``, or ``"reexport"``.
        target: The module path or symbol being imported/exported (as written in
            the source, e.g. ``"./db"`` or ``"token_goat.session"``).
        line: 1-based line number in the source file where the relationship appears.
    """

    kind: str            # import|export|reexport
    target: str
    line: int


@dataclass
class Section:
    """Represents a heading/section in a document (markdown, HTML, etc.).

    Attributes:
        heading: The text of the heading (e.g., 'Installation', 'API Reference').
        level: Heading hierarchy level. Markdown/HTML: 1-6; Liquid/other: language-specific.
               Lower numbers = higher level in hierarchy (1 = top-level, 6 = nested).
        line: 1-based line number where the heading appears.
        end_line: 1-based line where this section's content ends (before next heading or EOF).
                 None if unavailable.
    """
    heading: str
    level: int
    line: int
    end_line: int | None = None


class LargeFileInfo(NamedTuple):
    """Describes a file that was skipped or received reduced indexing due to its size.

    Attributes:
        rel_path: Path relative to the project root (POSIX-style).
        size_bytes: File size in bytes at index time.
        reason: Either ``"skipped"`` (file too large to index at all) or
            ``"symbol_only"`` (file was indexed for symbols but not embedded).
    """

    rel_path: str
    size_bytes: int
    reason: str  # "skipped" | "symbol_only"


@dataclass
class FileIndex:
    """Complete analysis of a single file: symbols, references, imports/exports, and sections.

    Produced by index_file() and persisted in the SQLite DB. Enables symbol search, cross-file
    dependency tracking, and section-based document navigation.

    Attributes:
        rel_path: Path to the file, relative to project root (normalized to POSIX style).
        language: Detected language ('python', 'typescript', 'go', 'rust', 'markdown', etc.).
        size: File size in bytes.
        line_count: Exact number of newline-delimited lines in the file.
        mtime: Last-modified timestamp (unix epoch, float).
        content_sha256: SHA256 hash of file content. Used to detect changes and skip re-indexing.
        symbols: List of named definitions (functions, classes, variables, etc.) in the file.
        refs: List of symbol references (usages) within the file.
        imports_exports: List of import/export statements (modules pulled in, symbols exposed).
        sections: List of headings/sections (only for document formats like markdown, HTML).
    """
    rel_path: str
    language: str
    size: int
    line_count: int
    mtime: float
    content_sha256: str
    symbols: list[Symbol] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    imports_exports: list[ImpExp] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    # When True, this file exceeded the large_file_symbol_only_kb threshold and
    # was indexed for symbols only — the embedding/chunking pass is skipped for it.
    symbol_only: bool = False


# Each language module exposes: extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]
Extractor = Callable[[bytes, str], tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]]


class IndexProjectResult(TypedDict):
    """Result of index_project operation."""

    total_files: int
    indexed: int
    skipped_unchanged: int
    errors: int
    languages: list[str]
    duration_sec: float
    total_symbols: int
    large_files: list[LargeFileInfo]
    ext_counts: dict[str, int]  # extension -> count of files indexed (e.g. {".py": 45, ".ts": 12})


def _language_importer(module_name: str, attr: str = "extract") -> Callable[[], Extractor]:
    """Return a zero-arg factory that lazily imports ``languages.<module_name>.<attr>``.

    All language extractors follow the same pattern: a ``languages/`` submodule
    whose ``extract`` function matches the ``Extractor`` signature.  This factory
    eliminates eight nearly-identical ``_import_*`` helpers, each differing only
    in the module name.  Grammars are still loaded lazily — the import happens
    inside the returned callable, not at module load time.

    ``module_name`` is the submodule under ``token_goat.languages`` (e.g.
    ``"typescript"``, ``"json_idx"``).  ``attr`` selects the callable to return
    (default ``"extract"``).
    """
    def _factory() -> Extractor:
        # Import deferred to first call so tree-sitter grammars (each ~1 MB of C extension)
        # are not loaded at module import time — only the languages actually needed for a
        # given project ever get loaded.
        import importlib
        # rsplit strips the submodule name ("parser") leaving the package root ("token_goat"),
        # so the relative import ".languages.X" resolves correctly however the module is invoked.
        mod = importlib.import_module(f".languages.{module_name}", package=__name__.rsplit(".", 1)[0])
        return getattr(mod, attr)  # type: ignore[return-value]  # getattr returns object; Extractor is callable — caller validated attr exists in the language module
    return _factory


# Registry: language key → zero-arg factory that imports and returns the extractor.
# Extend here when adding a new language; no other code needs to change.
# javascript reuses the typescript extractor (same tree-sitter grammar/rules).
_EXTRACTOR_REGISTRY: dict[str, Callable[[], Extractor]] = {
    "typescript": _language_importer("typescript"),
    "javascript": _language_importer("typescript"),
    "python":     _language_importer("python"),
    "go":         _language_importer("go"),
    "rust":       _language_importer("rust"),
    "java":       _language_importer("java"),
    "kotlin":     _language_importer("kotlin"),
    "csharp":     _language_importer("csharp"),
    "cpp":        _language_importer("cpp"),
    "c":          _language_importer("cpp", attr="extract_c"),
    "ruby":       _language_importer("ruby"),
    "php":        _language_importer("php"),
    "liquid":     _language_importer("liquid"),
    "markdown":   _language_importer("markdown"),
    "html":       _language_importer("html"),
    "json":       _language_importer("json_idx"),
    "toml":       _language_importer("toml_idx"),
    "yaml":       _language_importer("yaml_idx"),
    "ini":        _language_importer("ini_idx"),
    "env":        _language_importer("ini_idx", attr="extract_env"),
    "env_file":   _language_importer("env_idx"),
    "dockerfile": _language_importer("dockerfile_idx"),
    "css":        _language_importer("css_idx"),
    "sql":        _language_importer("sql_idx"),
    "graphql":    _language_importer("graphql_idx"),
    "proto":      _language_importer("proto_idx"),
    "makefile":   _language_importer("makefile_idx"),
}

# Cache resolved extractors so each language module is imported at most once.
_EXTRACTOR_CACHE: dict[str, Extractor] = {}

# ---------------------------------------------------------------------------
# Extraction-result LRU cache (in-memory, per-process)
# ---------------------------------------------------------------------------
# Why: even with the mtime/SHA short-circuits in index_project(), single-file
# re-indexes triggered by the dirty-queue worker still pay for a fresh
# tree-sitter parse every time. When an editor "saves without modification"
# (mtime bumped, content unchanged) we currently still walk the AST. Caching
# the (symbols, refs, imports_exports, sections) tuple by content-SHA lets the
# second extract() with the same bytes skip tree-sitter entirely.
#
# Scope: per-process, in-memory. Crossed-process worker invocations don't
# benefit (no on-disk persistence yet), but the worker stays resident in the
# common case, and within a single Claude Code session multiple files often
# share boilerplate (e.g. regenerated codegen, duplicated stubs) that produce
# identical hashes.
#
# Sizing: 256 entries is generous given typical files yield <1 kB of Symbol
# objects each — total memory ceiling is well under 1 MB.
_RESULT_CACHE_MAX: Final[int] = 256
_ResultTuple = tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]
_RESULT_CACHE: OrderedDict[tuple[str, str], _ResultTuple] = OrderedDict()
# Worker may invoke extract() from multiple threads when scaling; guard the
# OrderedDict with a Lock so move_to_end() and popitem() don't race.
_RESULT_CACHE_LOCK: threading.Lock = threading.Lock()
# Hit/miss counters exposed for tests + observability via parser_cache_stats().
_RESULT_CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0, "evictions": 0}


def _result_cache_get(language: str, sha: str) -> _ResultTuple | None:
    """Return the cached extraction tuple for (language, sha), or None.

    On hit, the entry is moved to the end of the LRU so it survives the next
    eviction.  Returns *shallow copies* of the symbol/ref/imp/section lists so
    callers cannot mutate the cached payload (the lists are wrapped in
    FileIndex objects that the DB writer iterates non-destructively, but a
    defensive copy is cheap and prevents future bugs).
    """
    key = (language, sha)
    with _RESULT_CACHE_LOCK:
        hit = _RESULT_CACHE.get(key)
        if hit is None:
            _RESULT_CACHE_STATS["misses"] += 1
            return None
        _RESULT_CACHE.move_to_end(key)
        _RESULT_CACHE_STATS["hits"] += 1
        symbols, refs, imp_exp, sections = hit
    return list(symbols), list(refs), list(imp_exp), list(sections)


def _result_cache_put(language: str, sha: str, payload: _ResultTuple) -> None:
    """Store *payload* under (language, sha); evicts oldest entry on overflow.

    Stores defensive copies of each list so that callers who mutate the lists
    returned via FileIndex (e.g. test helpers that ``fi.symbols.clear()``) do
    not corrupt the cached payload.  The cost is a single shallow list copy
    per insert — negligible compared to the tree-sitter parse it saves.
    """
    symbols, refs, imp_exp, sections = payload
    key = (language, sha)
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE[key] = (list(symbols), list(refs), list(imp_exp), list(sections))
        _RESULT_CACHE.move_to_end(key)
        while len(_RESULT_CACHE) > _RESULT_CACHE_MAX:
            _RESULT_CACHE.popitem(last=False)
            _RESULT_CACHE_STATS["evictions"] += 1


def parser_cache_stats() -> dict[str, int]:
    """Return a snapshot of {hits, misses, evictions, size} for the result LRU."""
    with _RESULT_CACHE_LOCK:
        return {
            "hits": _RESULT_CACHE_STATS["hits"],
            "misses": _RESULT_CACHE_STATS["misses"],
            "evictions": _RESULT_CACHE_STATS["evictions"],
            "size": len(_RESULT_CACHE),
        }


def parser_cache_clear() -> None:
    """Reset the result LRU and its counters (test helper, also safe at runtime)."""
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE.clear()
        _RESULT_CACHE_STATS["hits"] = 0
        _RESULT_CACHE_STATS["misses"] = 0
        _RESULT_CACHE_STATS["evictions"] = 0


def get_extractor(language: str) -> Extractor | None:
    """Return the extractor for *language*, or None if unsupported.

    Imports the language module lazily on first call; subsequent calls return
    the cached extractor without re-importing.
    """
    if language in _EXTRACTOR_CACHE:
        return _EXTRACTOR_CACHE[language]
    factory = _EXTRACTOR_REGISTRY.get(language)
    if factory is None:
        return None
    t0 = time.time()
    try:
        extractor = factory()
    except ImportError as exc:
        _LOG.error(
            "get_extractor: failed to import %s language module (missing grammar binary?): %s",
            language,
            exc,
        )
        return None
    except Exception as exc:
        _LOG.error(
            "get_extractor: unexpected error loading %s extractor (%s): %s",
            language,
            type(exc).__name__,
            exc,
        )
        return None
    elapsed = time.time() - t0
    _LOG.debug("extractor loaded: language=%s elapsed=%.3fs", language, elapsed)
    _EXTRACTOR_CACHE[language] = extractor
    return extractor


def register_extractor(language: str, factory: Callable[[], Extractor]) -> None:
    """Register a custom extractor factory for *language*.

    Clears any cached extractor for that language so the new factory takes
    effect on the next call to get_extractor().
    Useful for plugins and tests that need to override or add language support.
    """
    _EXTRACTOR_REGISTRY[language] = factory
    _EXTRACTOR_CACHE.pop(language, None)


def iter_source_files(
    project: Project,
    *,
    skip_threshold: int = MAX_FILE_SIZE,
    ext_filter: frozenset[str] | None = None,
    extra_skip_dirs: frozenset[str] = frozenset(),
    ignore_patterns: list[str] | None = None,
) -> Iterable[Path]:
    """Yield absolute paths of indexable source files under the project root.

    Symlinks are not followed during the directory walk (``os.walk`` default).
    Individual file symlinks within the tree are also skipped: a symlink that
    resolves outside the project root would silently index content from an
    unrelated part of the filesystem, which is both a data-leak risk and a
    correctness problem (the cached path won't match the real location).

    Args:
        project: Project whose root to walk.
        skip_threshold: Files larger than this many bytes are skipped entirely.
            Defaults to ``MAX_FILE_SIZE``.  Pass ``config.indexing.large_file_skip_kb * 1024``
            to use the user-configured threshold.
        ext_filter: When not None, only yield files whose suffix (lowercased,
            with leading dot) is in this set.  E.g. ``frozenset({".py", ".pyi"})``.
            Has no effect on basename-matched files (e.g. ``.env``).
        extra_skip_dirs: Additional directory basenames to skip, merged with
            the built-in ``SKIP_DIRS`` frozenset.  Populated from
            ``config.indexing.skip_dirs`` in ``index_project``.
        ignore_patterns: List of gitignore-style glob patterns to exclude files/dirs.
            Loaded from .tokengoatignore if present. Defaults to None (no extra patterns).
    """
    root = project.root
    resolved_root = root.resolve()
    _effective_skip_dirs = SKIP_DIRS | extra_skip_dirs if extra_skip_dirs else SKIP_DIRS
    _ignore_patterns = ignore_patterns or []
    skipped_dirs = 0
    skipped_symlinks = 0
    skipped_oversized = 0
    skipped_generated = 0
    skipped_ignore = 0
    for dirpath, dirs, files in os.walk(root):
        initial_dirs = dirs[:]
        dirs[:] = [d for d in dirs if d not in _effective_skip_dirs]
        skipped_dirs += len(initial_dirs) - len(dirs)
        base = Path(dirpath)
        for name in files:
            if name in _effective_skip_dirs:
                continue
            # Skip generated/lockfile artifacts (package-lock.json, *.min.js, etc.)
            # before the extension check — these have valid extensions in
            # LANG_BY_EXT (``.json``, ``.js``) so the suffix gate alone would
            # let them through, polluting the symbol table with hundreds of
            # auto-generated identifiers per file.
            if _is_generated_filename(name):
                skipped_generated += 1
                continue
            path = base / name
            # Fast membership test against the frozenset avoids a .lower()
            # allocation for each file whose suffix is already lowercase (the
            # common case on Linux/macOS).  Fall back to lowering only when the
            # suffix is not found in the fast path (mixed-case extension on Windows).
            # Basename match (``.env``, ``.envrc``) wins when present: those
            # files have empty suffixes so the standard suffix gate would
            # exclude them.
            name_lower = name.lower()
            if name_lower not in _KNOWN_BASENAMES:
                suffix = path.suffix
                if suffix not in _KNOWN_EXTENSIONS and suffix.lower() not in _KNOWN_EXTENSIONS:
                    continue
                # Apply optional extension filter (e.g. --ext py).
                if ext_filter is not None and suffix.lower() not in ext_filter:
                    continue
            # Reject symlinks whose resolved target escapes the project root.
            # os.walk does not follow symlink *directories* by default, but it
            # does yield symlink *files*, so we must guard here.
            if path.is_symlink():
                try:
                    resolved = path.resolve()
                    resolved.relative_to(resolved_root)
                except (ValueError, OSError):
                    skipped_symlinks += 1
                    _LOG.debug("iter_source_files: skipping symlink outside project root: %s", path)
                    continue
            try:
                file_size = path.stat().st_size
                if file_size > skip_threshold:
                    _LOG.debug(
                        "iter_source_files: skipping oversized file %s (%d bytes > %d limit)",
                        path.name, file_size, skip_threshold,
                    )
                    skipped_oversized += 1
                    continue
            except OSError:
                continue
            if _ignore_patterns:
                try:
                    rel_path = path.relative_to(root).as_posix()
                    if _matches_ignore_pattern(rel_path, _ignore_patterns):
                        skipped_ignore += 1
                        continue
                except ValueError:
                    pass
            yield path
    if skipped_dirs > 0:
        _LOG.debug("file walk excluded %d skip-listed directories", skipped_dirs)
    if skipped_symlinks > 0:
        _LOG.debug("file walk skipped %d symlinks pointing outside project root", skipped_symlinks)
    if skipped_oversized > 0:
        _LOG.info("file walk skipped %d oversized files (> %d bytes)", skipped_oversized, skip_threshold)
    if skipped_generated > 0:
        _LOG.debug("file walk skipped %d generated/lockfile artifacts", skipped_generated)
    if skipped_ignore > 0:
        _LOG.debug("file walk skipped %d files matching .tokengoatignore patterns", skipped_ignore)


def _line_count_from_bytes(raw: bytes) -> int:
    """Return the exact number of newline-delimited lines in *raw*."""
    if not raw:
        return 0
    return raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1)


def index_file(
    project: Project,
    file_path: Path,
    *,
    symbol_only_threshold: int = 0,
) -> FileIndex | None:
    """Index a single file: read, detect language, dispatch to language extractor, return FileIndex.

    Extracts symbols, references, imports/exports, and sections. Returns None if file cannot
    be read, language is unsupported, or the extractor crashes. Does not write to DB.

    Args:
        project: Project containing the file.
        file_path: Absolute path to the file.
        symbol_only_threshold: When > 0 and the file is larger than this many bytes,
            the returned ``FileIndex.symbol_only`` is set to ``True``.  Callers use
            this flag to skip the embedding/chunking pass for large files.  Default 0
            disables the threshold (all files get full indexing).
    """
    t0 = time.time()
    try:
        pre_mtime = file_path.stat().st_mtime
    except OSError:
        pre_mtime = None
    try:
        raw = file_path.read_bytes()
    except OSError as e:
        _LOG.warning("read failed: %s: %s", file_path, e)
        return None
    try:
        rel = file_path.relative_to(project.root).as_posix()
    except ValueError as e:
        _LOG.warning("index_file: path not under project root (skipping): %s: %s", file_path, e)
        return None
    suffix_lower = file_path.suffix.lower()
    basename_lower = file_path.name.lower()
    # Basename match wins over suffix match: ``.env`` has an empty suffix
    # but a meaningful basename.  When the basename resolves we use that
    # language; otherwise fall back to the suffix table.
    language = LANG_BY_BASENAME.get(basename_lower) or LANG_BY_EXT.get(suffix_lower)
    if language is None:
        _LOG.debug(
            "index_file: unsupported file %r (basename=%r suffix=%r) for %s (skipping)",
            basename_lower, basename_lower, suffix_lower, rel,
        )
        return None
    line_count = _line_count_from_bytes(raw)
    # Compute SHA up front so we can consult the in-memory extraction cache
    # before paying the tree-sitter parse cost.  Hashing 2 MB of bytes is ~5 ms
    # on a typical workstation — orders of magnitude cheaper than a full AST walk.
    content_sha = hashlib.sha256(raw).hexdigest()
    cached = _result_cache_get(language, content_sha)
    if cached is not None:
        symbols, refs, imp_exp, sections = cached
        _LOG.debug("index_file: result-cache hit for %s (lang=%s)", rel, language)
    else:
        extractor = get_extractor(language)
        if extractor is None:
            _LOG.debug("no extractor for %s (%s)", rel, language)
            return None
        try:
            symbols, refs, imp_exp, sections = extractor(raw, rel)
        except Exception:
            _LOG.exception("extractor crashed on %s", rel)
            return None
        # Only cache successful extracts; failed parses must re-run so a future
        # grammar fix is picked up without manual cache invalidation.
        _result_cache_put(language, content_sha, (symbols, refs, imp_exp, sections))

    if not symbols and language not in ("markdown", "html", "json", "css", "sql"):
        _LOG.debug(
            "index_file: 0 symbols extracted from %s (language=%s, %d bytes) "
            "— parser may not cover this file's constructs",
            rel, language, len(raw),
        )

    try:
        stat = file_path.stat()
    except OSError as e:
        _LOG.warning("stat failed after reading: %s: %s", file_path, e)
        return None

    if pre_mtime is not None and stat.st_mtime != pre_mtime:
        _LOG.debug(
            "index_file: mtime changed during read (pre=%.6f post=%.6f) — skipping %s (will retry on next write)",
            pre_mtime, stat.st_mtime, rel,
        )
        return None

    elapsed = time.time() - t0
    _LOG.debug(
        "indexed %s: symbols=%d refs=%d imports=%d sections=%d size=%d elapsed=%.3fs",
        rel, len(symbols), len(refs), len(imp_exp), len(sections), stat.st_size, elapsed
    )

    is_symbol_only = symbol_only_threshold > 0 and stat.st_size > symbol_only_threshold
    if is_symbol_only:
        _LOG.debug(
            "index_file: symbol-only mode for %s (%d bytes > %d symbol_only_threshold)",
            rel, stat.st_size, symbol_only_threshold,
        )

    return FileIndex(
        rel_path=rel,
        language=language,
        size=stat.st_size,
        line_count=line_count,
        mtime=stat.st_mtime,
        # Reuse the SHA we already computed for the result-cache lookup above
        # instead of paying for a second hash of the same bytes.
        content_sha256=content_sha,
        symbols=symbols,
        refs=refs,
        imports_exports=imp_exp,
        sections=sections,
        symbol_only=is_symbol_only,
    )


def _upsert_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Insert or replace a single key/value row in the project meta table."""
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        (key, value),
    )


def write_file_index(conn: sqlite3.Connection, fi: FileIndex) -> None:
    """Replace all indexed rows for *fi.rel_path* with fresh data from *fi*.

    Uses a DELETE + INSERT strategy rather than UPDATE because the full symbol/ref/section
    payload changes on every re-index: partial updates would require diffing each list,
    which is both complex and slower than a bulk replace. The ``files`` table DELETE
    cascades to all child tables (symbols, refs, imports_exports, sections, chunks) via
    ``ON DELETE CASCADE``, so child rows are cleaned atomically before re-insertion.

    All child rows are inserted in bulk via ``executemany`` to minimize round-trips.
    Malformed rows (empty name, empty kind, None target) are filtered at insert time
    rather than in the extractor so extractors don't need to enforce these invariants.

    Wrapped in an explicit transaction: connections are opened with
    ``isolation_level=None`` (autocommit), so without BEGIN/COMMIT each DELETE,
    INSERT, and executemany would be its own fsync'd transaction.  Wrapping the
    whole replace as a single transaction is roughly 80x faster on typical files
    (measured: 84s → 1s for 100 files × ~100 rows each).  Best-effort COMMIT/
    ROLLBACK suppresses errors when the connection is in read-only sandbox mode
    (Codex unelevated) where BEGIN itself raises — autocommit fallback still
    produces correct results, just slower.
    """
    t0 = time.time()
    now = int(t0)
    in_txn = False
    try:
        conn.execute("BEGIN")
        in_txn = True
    except sqlite3.OperationalError as e:
        # Read-only sandbox or already-in-transaction: fall through to
        # autocommit path.  This is rare; the speedup is best-effort.
        _LOG.debug("write_file_index: BEGIN skipped (%s); using autocommit", e)
    try:
        # Delete old rows (cascade handles symbols/refs/imports_exports/sections)
        conn.execute("DELETE FROM files WHERE rel_path = ?", (fi.rel_path,))
        conn.execute(
            "INSERT INTO files (rel_path, language, size, line_count, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                fi.rel_path,
                fi.language,
                fi.size,
                fi.line_count,
                fi.mtime,
                fi.content_sha256,
                now,
            ),
        )
        # Batch insert symbols (filter malformed rows, apply per-file cap).
        # Generator expressions avoid allocating an intermediate list — executemany
        # accepts any iterable.  The guard `if fi.symbols` short-circuits so no
        # generator object is created for the common empty case.
        #
        # The cap (MAX_SYMBOLS_PER_FILE) guards against pathological generated files
        # (compiled CSS bundles, auto-generated stubs) that could produce tens of
        # thousands of symbols, bloating the DB and degrading every query.
        if fi.symbols:
            valid_syms = [sym for sym in fi.symbols if sym.name and sym.kind]
            if len(valid_syms) > MAX_SYMBOLS_PER_FILE:
                _LOG.warning(
                    "write_file_index: %s produced %d symbols (cap=%d); "
                    "truncating to first %d — file may be generated/minified",
                    fi.rel_path, len(valid_syms), MAX_SYMBOLS_PER_FILE, MAX_SYMBOLS_PER_FILE,
                )
                valid_syms = valid_syms[:MAX_SYMBOLS_PER_FILE]
            conn.executemany(
                "INSERT INTO symbols (name, kind, file_rel, line, col, end_line, signature, parent_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                (
                    (sym.name, sym.kind, fi.rel_path, sym.line, sym.col, sym.end_line, sym.signature)
                    for sym in valid_syms
                ),
            )

        # Batch insert refs (filter empty names)
        if fi.refs:
            conn.executemany(
                "INSERT INTO refs (symbol_name, file_rel, line, col, context) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    (ref.name, fi.rel_path, ref.line, ref.col, ref.context)
                    for ref in fi.refs if ref.name
                ),
            )

        # Batch insert imports/exports (filter invalid rows)
        if fi.imports_exports:
            conn.executemany(
                "INSERT INTO imports_exports (file_rel, kind, target, line) "
                "VALUES (?, ?, ?, ?)",
                (
                    (fi.rel_path, ie.kind, ie.target, ie.line)
                    for ie in fi.imports_exports if ie.kind and ie.target is not None
                ),
            )

        # Batch insert sections (filter empty headings)
        if fi.sections:
            conn.executemany(
                "INSERT INTO sections (file_rel, heading, level, line, end_line) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    (fi.rel_path, sec.heading, sec.level, sec.line, sec.end_line)
                    for sec in fi.sections if sec.heading
                ),
            )
        if in_txn:
            with contextlib.suppress(sqlite3.OperationalError):
                conn.execute("COMMIT")
    except Exception:
        if in_txn:
            with contextlib.suppress(sqlite3.OperationalError):
                conn.execute("ROLLBACK")
        raise
    elapsed = time.time() - t0
    if elapsed >= 0.5:
        _LOG.warning(
            "write_file_index slow: %s symbols=%d refs=%d sections=%d elapsed=%.3fs",
            fi.rel_path, len(fi.symbols), len(fi.refs), len(fi.sections), elapsed,
        )
    else:
        _LOG.debug(
            "write_file_index: %s symbols=%d refs=%d sections=%d elapsed=%.3fs",
            fi.rel_path, len(fi.symbols), len(fi.refs), len(fi.sections), elapsed,
        )


def index_project(
    project: Project,
    *,
    full: bool = True,
    progress: Callable[[int, int], None] | None = None,
    verbose: bool = False,
    ext_filter: frozenset[str] | None = None,
) -> IndexProjectResult:
    """Index all source files in a project: full or incremental scan and persist to DB.

    Full mode re-indexes all files. Incremental mode uses mtime + SHA256 caching to skip unchanged files.
    Registers the project in the global DB upfront so it's discoverable during indexing (avoids
    race conditions where the worker reindexes a file before project registration completes).
    Acquires an exclusive writer lock to prevent concurrent indexing on the same project.

    Returns IndexProjectResult with total_files, indexed, skipped_unchanged, errors, languages, duration_sec,
    large_files (a list of LargeFileInfo for files that were skipped or got symbol-only treatment), and
    ext_counts (a dict mapping file extension to count of files indexed, e.g. {".py": 45, ".ts": 12}).
    Calls progress(indexed_so_far, total) every 100 files if progress is supplied.
    When verbose is True, prints each file as it's indexed with its symbol count.
    When ext_filter is provided, only files whose suffix (lowercased) is in the set are indexed.
    """
    _LOG.info("index_project started: mode=%s path=%s", "full" if full else "incremental", project.root)

    # Load configurable large-file thresholds.  Fail soft: if config is
    # unavailable (e.g. during tests that don't want any TOML on disk), fall
    # back to the hardcoded defaults defined in this module.
    _extra_skip_dirs: frozenset[str] = frozenset()
    try:
        from . import config as _config
        _idx_cfg = _config.load().indexing
        _skip_threshold = _idx_cfg.large_file_skip_kb * 1024
        _symbol_only_threshold = _idx_cfg.large_file_symbol_only_kb * 1024
        _extra_skip_dirs = frozenset(_idx_cfg.skip_dirs)
    except Exception:
        _skip_threshold = MAX_FILE_SIZE
        _symbol_only_threshold = 0

    # Load per-project ignore patterns from .tokengoatignore
    _ignore_patterns = load_project_ignore_patterns(project.root)
    if _ignore_patterns:
        _LOG.info("index_project: loaded %d custom exclusion patterns from .tokengoatignore", len(_ignore_patterns))

    # Register the project in the global registry up front, before the
    # potentially slow (or hang-prone) file walk. The final registry update
    # below fills in real file_count/languages once indexing completes. Without
    # this, the project is unresolvable for the entire indexing window: the
    # worker's dirty-queue drain hits "unknown project hash" and silently drops
    # every edit made while indexing is in flight — permanently, if the index
    # spawn crashes before reaching the end.
    with db.open_global() as gconn:
        now = int(time.time())
        gconn.execute(
            "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
            "VALUES (?, ?, ?, ?, ?, 0, '') "
            "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, marker=excluded.marker",
            (project.hash, project.root.as_posix(), project.marker, now, now),
        )

    # Collect files that exceed the skip threshold so they appear in the large-file
    # report even though iter_source_files dropped them.  We use a separate walk with
    # a much higher threshold (no skip) so we can capture their sizes.
    # We reuse iter_source_files with a very large threshold to avoid duplicating
    # the extension-filter, symlink-guard, and generated-file logic.
    _skipped_large: list[LargeFileInfo] = []
    if _skip_threshold < MAX_FILE_SIZE * 100:  # only scan when threshold is meaningful
        with contextlib.suppress(Exception):
            for _lp in iter_source_files(project, skip_threshold=MAX_FILE_SIZE * 100, extra_skip_dirs=_extra_skip_dirs, ignore_patterns=_ignore_patterns):
                try:
                    _lp_size = _lp.stat().st_size
                except OSError:
                    continue
                if _lp_size > _skip_threshold:
                    try:
                        _lp_rel = _lp.relative_to(project.root).as_posix()
                    except ValueError:
                        continue
                    _skipped_large.append(LargeFileInfo(
                        rel_path=_lp_rel,
                        size_bytes=_lp_size,
                        reason="skipped",
                    ))
                    _LOG.warning(
                        "index_project: skipping large file %s (%d bytes > %d skip threshold)",
                        _lp_rel, _lp_size, _skip_threshold,
                    )

    files = list(iter_source_files(project, skip_threshold=_skip_threshold, ext_filter=ext_filter, extra_skip_dirs=_extra_skip_dirs, ignore_patterns=_ignore_patterns))
    n_total = len(files)
    if n_total == 0:
        _LOG.debug(
            "index_project: no source files found under %s — check project root and SKIP_DIRS",
            project.root,
        )
    _LOG.debug("index walk: found %d source files (mode=%s)", n_total, "full" if full else "incremental")
    n_indexed = 0
    n_skipped_unchanged = 0
    n_errors = 0
    n_symbols = 0
    languages: set[str] = set()
    # Per-extension file counts for summary output (e.g. {".py": 45, ".ts": 12}).
    ext_counts: Counter[str] = Counter()
    # Collect rel_paths seen in this walk so the end-of-loop stale-file prune
    # can reuse them without a second O(n) relative_to() pass over all files.
    on_disk: set[str] = set()
    # Track files that were skipped entirely or received symbol-only treatment.
    large_files: list[LargeFileInfo] = []
    t0 = time.time()

    with db.project_writer_lock(project.hash, timeout_sec=30.0):
        with db.open_project(project.hash) as conn:
            # For incremental: pre-load existing mtimes + SHAs
            existing_sha: dict[str, str] | None = None
            existing_mtime: dict[str, float] | None = None
            if not full:
                existing_sha = {}
                existing_mtime = {}
                for row in conn.execute("SELECT rel_path, mtime, content_sha256 FROM files"):
                    existing_sha[row["rel_path"]] = row["content_sha256"]
                    existing_mtime[row["rel_path"]] = row["mtime"]
                _LOG.debug("incremental mode: loaded %d cached mtimes+hashes", len(existing_sha))

            for i, fp in enumerate(files):
                rel = fp.relative_to(project.root).as_posix()
                on_disk.add(rel)

                # Two-layer incremental check:
                # 1) mtime fast-path: if the OS-reported mtime matches the cached value we
                #    skip reading the file entirely (no syscall beyond stat).
                # 2) SHA fallback: if mtime matches but content differs (e.g. file copied
                #    from another location with the same mtime, or mtime was touched without
                #    content changes), the SHA comparison catches it. The SHA is computed
                #    inside index_file() from the file's bytes, so this check is free once
                #    the file is already read.
                if existing_mtime is not None and rel in existing_mtime:
                    try:
                        if fp.stat().st_mtime == existing_mtime[rel]:
                            n_skipped_unchanged += 1
                            _LOG.debug("skipped unchanged (mtime): %s", rel)
                            if progress and (i + 1) % 100 == 0:
                                progress(i + 1, n_total)
                            continue
                    except OSError as e:
                        _LOG.debug("mtime check failed for %s (will reindex): %s", rel, e)

                fi = index_file(project, fp, symbol_only_threshold=_symbol_only_threshold)
                if fi is None:
                    n_errors += 1
                else:
                    # SHA check guards against same-mtime content changes (copies, touch+overwrite)
                    sha_unchanged = existing_sha is not None and existing_sha.get(fi.rel_path) == fi.content_sha256
                    if sha_unchanged:
                        n_skipped_unchanged += 1
                        _LOG.debug("skipped unchanged (sha): %s", fi.rel_path)
                    else:
                        write_file_index(conn, fi)
                        n_indexed += 1
                        n_symbols += len(fi.symbols)
                        languages.add(fi.language)
                        # Track per-extension counts for the summary breakdown.
                        _ext = fp.suffix.lower() or fp.name.lower()
                        ext_counts[_ext] += 1
                        if verbose:
                            import typer as _typer
                            sym_word = "symbol" if len(fi.symbols) == 1 else "symbols"
                            _typer.echo(f"indexed: {fi.rel_path} ({len(fi.symbols)} {sym_word})")
                        if existing_sha is not None:
                            _LOG.debug("updated changed file: %s", fi.rel_path)
                    # Track symbol-only files regardless of whether they changed.
                    if fi.symbol_only:
                        large_files.append(LargeFileInfo(
                            rel_path=fi.rel_path,
                            size_bytes=fi.size,
                            reason="symbol_only",
                        ))
                if progress and (i + 1) % 100 == 0:
                    progress(i + 1, n_total)

            # Prune index entries for files that no longer exist on disk.
            # Without this, deleted/renamed files linger forever — token-goat
            # symbol/read/map would surface dead paths. FK ON DELETE CASCADE
            # cleans up symbols/refs/sections/chunks for the removed file.
            # on_disk was populated incrementally during the main loop above,
            # so no second O(n) relative_to() pass is needed here.
            # In incremental mode existing_sha already holds every rel_path in
            # the DB (loaded earlier for the mtime/SHA skip check), so we reuse
            # that dict instead of issuing a second SELECT against the same DB.
            # In full mode we didn't load existing_sha, so we query the DB now.
            # Either way, we end up with the complete set of DB-known paths in
            # one SELECT call (or zero, if reusing the existing_sha dict).
            if existing_sha is not None:
                db_rel_paths = set(existing_sha.keys())
            else:
                db_rel_paths = {r["rel_path"] for r in conn.execute("SELECT rel_path FROM files")}
            stale = db_rel_paths - on_disk
            if stale:
                # Single DELETE … IN (…) instead of one DELETE per file — O(1)
                # round-trips vs O(N). FK ON DELETE CASCADE cleans up child rows.
                stale_list = list(stale)
                ph = ",".join("?" for _ in stale_list)
                conn.execute(f"DELETE FROM files WHERE rel_path IN ({ph})", stale_list)
                _LOG.info(
                    "pruned %d deleted file(s) from index: %s",
                    len(stale),
                    ", ".join(heapq.nsmallest(5, stale)),
                )

            # Update project meta
            _upsert_meta(conn, "last_full_index_at", str(int(time.time())))
            _upsert_meta(conn, "project_root", project.root.as_posix())
            _upsert_meta(conn, "project_marker", project.marker)
            # Persist the over-cap skip list so later read/symbol/outline misses
            # can explain *why* a known file is unreadable (it exceeded the size
            # cap) instead of emitting a generic "not found" with unrelated
            # suggestions.  Only the "skipped" tier is stored — symbol-only files
            # are still in the symbol index, so reads against them resolve.
            _upsert_meta(
                conn,
                "skipped_large_files",
                json.dumps(
                    [
                        {"rel_path": lf.rel_path, "size_bytes": lf.size_bytes}
                        for lf in _skipped_large
                    ],
                    separators=(",", ":"),
                ),
            )

        # Update global registry
        with db.open_global() as gconn:
            now = int(time.time())
            gconn.execute(
                "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, "
                "file_count=excluded.file_count, languages=excluded.languages, marker=excluded.marker",
                (
                    project.hash,
                    project.root.as_posix(),
                    project.marker,
                    now,
                    now,
                    n_total,
                    ",".join(sorted(languages)),
                ),
            )
            # Refresh global symbols snapshot
            gconn.execute(
                "DELETE FROM symbols_global WHERE project_hash = ?", (project.hash,)
            )
            with db.open_project(project.hash) as pconn:
                rows = pconn.execute(
                    "SELECT name, kind, file_rel, line, signature FROM symbols"
                ).fetchall()
            gconn.executemany(
                "INSERT INTO symbols_global(project_hash, name, kind, file_rel, line, signature) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    (project.hash, r["name"], r["kind"], r["file_rel"], r["line"], r["signature"])
                    for r in rows
                ),
            )

    elapsed = time.time() - t0
    # Merge skipped-large (from pre-scan) with symbol-only (collected during indexing).
    all_large_files = _skipped_large + large_files
    result: IndexProjectResult = {
        "total_files": n_total,
        "indexed": n_indexed,
        "skipped_unchanged": n_skipped_unchanged,
        "errors": n_errors,
        "languages": sorted(languages),
        "duration_sec": round(elapsed, 2),
        "total_symbols": n_symbols,
        "large_files": all_large_files,
        "ext_counts": ext_counts,
    }

    files_per_sec = n_total / elapsed if elapsed > 0 else 0.0
    _LOG.info(
        "index_project completed: project=%s total_files=%d indexed=%d skipped=%d errors=%d "
        "large_skipped=%d large_symbol_only=%d "
        "languages=%s duration=%.2fs throughput=%.1f files/s",
        project.hash[:8],
        n_total,
        n_indexed,
        n_skipped_unchanged,
        n_errors,
        sum(1 for lf in all_large_files if lf.reason == "skipped"),
        sum(1 for lf in all_large_files if lf.reason == "symbol_only"),
        ",".join(sorted(languages)),
        elapsed,
        files_per_sec,
    )
    return result
