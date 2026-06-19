"""Bundle project files into a single LLM-ready output with token estimates."""
from __future__ import annotations

import fnmatch
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

_LANG_MAP: dict[str, str] = {
    ".py": "python", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript",
    ".jsx": "jsx", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c",
    ".cpp": "cpp", ".h": "c", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "fish",
    ".sql": "sql", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".json": "json", ".md": "markdown", ".html": "html", ".css": "css",
    ".scss": "scss", ".tf": "hcl", ".kt": "kotlin", ".swift": "swift",
    ".lua": "lua", ".r": "r", ".dart": "dart", ".ex": "elixir", ".exs": "elixir",
}


@dataclass
class PackFile:
    path: Path
    rel_path: str
    content: str
    lines: int
    tokens: int


@dataclass
class PackResult:
    files: list[PackFile] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    total_lines: int = 0
    total_tokens: int = 0


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _lang(path: Path) -> str:
    return _LANG_MAP.get(path.suffix.lower(), "")


def _matches(rel: str, patterns: list[str]) -> bool:
    norm = rel.replace("\\", "/")
    base = norm.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(norm, pat) or fnmatch.fnmatch(base, pat) for pat in patterns)


# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

_PY_DOCSTRING_RE = re.compile(r'""".*?"""|\'\'\'.*?\'\'\'', re.DOTALL)
_PY_LINE_COMMENT_RE = re.compile(r'(?m)[ \t]*#[^\r\n]*')
_CSTYLE_BLOCK_RE = re.compile(r'/\*.*?\*/', re.DOTALL)
_CSTYLE_LINE_RE = re.compile(r'(?m)[ \t]*//[^\r\n]*')
_SQL_LINE_RE = re.compile(r'(?m)[ \t]*--[^\r\n]*')
_HASH_LINE_RE = re.compile(r'(?m)[ \t]*#[^\r\n]*')

_CSTYLE_EXTS = frozenset({
    ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java", ".c", ".cpp",
    ".h", ".hpp", ".cs", ".kt", ".swift", ".dart",
})
_HASH_COMMENT_EXTS = frozenset({".rb", ".sh", ".bash", ".zsh", ".fish", ".r", ".lua"})


def strip_comments(content: str, path: Path) -> str:
    """Remove comments from *content* based on the file extension.

    Preserves line count (blank lines replace comment lines) so that
    line-number references in the remaining code stay accurate.
    For Python files, also strips triple-quoted docstrings.

    Returns *content* unchanged when the extension has no registered handler.
    """
    ext = path.suffix.lower()

    if ext == ".py":
        # Remove docstrings (triple-quoted strings used as standalone expressions)
        def _blank_block(m: re.Match[str]) -> str:
            return "\n" * m.group(0).count("\n")
        content = _PY_DOCSTRING_RE.sub(_blank_block, content)
        content = _PY_LINE_COMMENT_RE.sub("", content)
        return content

    if ext == ".sql":
        return _SQL_LINE_RE.sub("", content)

    if ext in _CSTYLE_EXTS:
        def _blank_block2(m: re.Match[str]) -> str:
            return "\n" * m.group(0).count("\n")
        content = _CSTYLE_BLOCK_RE.sub(_blank_block2, content)
        content = _CSTYLE_LINE_RE.sub("", content)
        return content

    if ext in _HASH_COMMENT_EXTS:
        return _HASH_LINE_RE.sub("", content)

    # CSS/SCSS: only block comments
    if ext in (".css", ".scss"):
        def _blank_block3(m: re.Match[str]) -> str:
            return "\n" * m.group(0).count("\n")
        return _CSTYLE_BLOCK_RE.sub(_blank_block3, content)

    return content


# ---------------------------------------------------------------------------
# Secret scanning
# ---------------------------------------------------------------------------

@dataclass
class SecretHit:
    rel_path: str
    line: int
    kind: str
    snippet: str


_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("AWS access key", re.compile(r'AKIA[0-9A-Z]{16}')),
    ("AWS secret key", re.compile(r'(?i)aws.{0,20}secret.{0,20}["\']([A-Za-z0-9/+]{40})["\']')),
    ("GitHub token", re.compile(r'gh[pousr]_[A-Za-z0-9]{36,255}')),
    ("Generic API key", re.compile(r'(?i)(?:api[_-]?key|apikey|api_secret)["\s]*[:=]["\s]*([A-Za-z0-9_\-]{20,})')),
    ("Bearer token", re.compile(r'(?i)authorization:\s*bearer\s+([A-Za-z0-9\-._~+/]+=*)')),
    ("Private key block", re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ("Stripe key", re.compile(r'sk_(?:live|test)_[A-Za-z0-9]{24,}')),
    ("OpenAI key", re.compile(r'sk-[A-Za-z0-9]{32,}')),
    ("Slack webhook", re.compile(r'https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+')),
    ("Google API key", re.compile(r'AIza[0-9A-Za-z\-_]{35}')),
    ("Database URL", re.compile(r'(?i)(?:postgres|mysql|mongodb)://[^:]+:[^@\s]+@[^\s]+')),
    ("Password literal", re.compile(r'(?i)(?:password|passwd|pwd)\s*[:=]\s*["\']([^"\']{6,})["\']')),
]

_SAFE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".lock"})


def scan_secrets(files: list[PackFile]) -> list[SecretHit]:
    """Scan packed files for patterns that look like credentials or secrets.

    Returns a list of hits — each with file path, line number, kind, and a
    redacted snippet showing the surrounding context.
    """
    hits: list[SecretHit] = []
    for pf in files:
        if Path(pf.path).suffix.lower() in _SAFE_EXTS:
            continue
        for lineno, line in enumerate(pf.content.splitlines(), 1):
            for kind, pattern in _SECRET_PATTERNS:
                if pattern.search(line):
                    snip = line.strip()[:80]
                    hits.append(SecretHit(rel_path=pf.rel_path, line=lineno, kind=kind, snippet=snip))
                    break  # one hit per line is enough
    return hits


def collect_files(
    project_root: Path,
    patterns: list[str],
    *,
    ignore_patterns: list[str] | None = None,
    max_file_bytes: int = 2 * 1024 * 1024,
    do_strip_comments: bool = False,
) -> PackResult:
    """Walk patterns and return PackFile list with per-file token estimates."""
    result = PackResult()
    seen: set[Path] = set()
    root_resolved = project_root.resolve()

    for pattern in patterns:
        # Accept absolute paths directly; otherwise treat as glob relative to root.
        if Path(pattern).is_absolute():
            candidates = [Path(pattern)]
        else:
            try:
                candidates = sorted(project_root.glob(pattern))
            except Exception:
                result.skipped.append(f"{pattern} (glob error)")
                continue

        for p in candidates:
            if not p.is_file() or p in seen:
                continue
            try:
                rel = p.relative_to(project_root).as_posix()
            except ValueError:
                result.skipped.append(f"{p.as_posix()} (outside project root)")
                continue
            try:
                p.resolve().relative_to(root_resolved)
            except ValueError:
                result.skipped.append(f"{rel} (symlink points outside project root)")
                continue

            if ignore_patterns and _matches(rel, ignore_patterns):
                continue

            size = p.stat().st_size
            if size > max_file_bytes:
                result.skipped.append(f"{rel} (too large: {size // 1024}KB)")
                continue

            try:
                content = p.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                result.skipped.append(f"{rel} (unreadable: {e})")
                continue

            if do_strip_comments:
                content = strip_comments(content, p)

            seen.add(p)
            lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
            tokens = _estimate_tokens(content)
            pf = PackFile(path=p, rel_path=rel, content=content, lines=lines, tokens=tokens)
            result.files.append(pf)
            result.total_lines += lines
            result.total_tokens += tokens

    return result


def collect_from_stdin(
    project_root: Path,
    *,
    ignore_patterns: list[str] | None = None,
    max_file_bytes: int = 2 * 1024 * 1024,
    do_strip_comments: bool = False,
) -> PackResult:
    """Read newline-separated file paths from stdin and collect them."""
    paths = [ln.strip() for ln in sys.stdin.read().splitlines() if ln.strip()]
    return collect_files(
        project_root,
        paths,
        ignore_patterns=ignore_patterns,
        max_file_bytes=max_file_bytes,
        do_strip_comments=do_strip_comments,
    )


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


def _add_line_numbers(content: str) -> str:
    lines = content.splitlines(keepends=True)
    width = len(str(len(lines)))
    return "".join(f"{i + 1:{width}}  {line}" for i, line in enumerate(lines))


def format_markdown(result: PackResult, *, line_numbers: bool = False, instruction: str | None = None) -> str:
    parts: list[str] = []
    n = len(result.files)
    noun = "file" if n == 1 else "files"

    # Header manifest
    parts.append("# Packed context\n")
    parts.append(f"> **{n} {noun} · ~{result.total_tokens:,} tokens**\n")
    if result.files:
        parts.append(">")
        parts.append("> | # | File | Lines | ~Tokens |")
        parts.append("> |---|------|-------|---------|")
        for i, pf in enumerate(result.files, 1):
            parts.append(f"> | {i} | `{pf.rel_path}` | {pf.lines:,} | {pf.tokens:,} |")
        parts.append("")

    if result.skipped:
        parts.append(f"> *Skipped {len(result.skipped)} file(s): {', '.join(result.skipped[:3])}"
                     f"{'...' if len(result.skipped) > 3 else ''}*\n")

    parts.append("---\n")

    for pf in result.files:
        body = _add_line_numbers(pf.content) if line_numbers else pf.content
        lang = _lang(pf.path)
        parts.append(f"## `{pf.rel_path}`\n")
        parts.append(f"```{lang}")
        parts.append(body.rstrip())
        parts.append("```\n")

    if instruction:
        parts.append("---\n")
        parts.append("## Instructions\n")
        parts.append(instruction.rstrip())
        parts.append("")

    return "\n".join(parts)


def format_xml(result: PackResult, *, line_numbers: bool = False, instruction: str | None = None) -> str:
    parts: list[str] = ["<documents>"]

    for i, pf in enumerate(result.files, 1):
        body = _add_line_numbers(pf.content) if line_numbers else pf.content
        # Escape XML reserved chars in content
        escaped = (
            body
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        parts.append(f'<document index="{i}">')
        esc_src = pf.rel_path.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        parts.append(f"<source>{esc_src}</source>")
        parts.append(f"<document_content>\n{escaped}\n</document_content>")
        parts.append("</document>")

    if instruction:
        parts.append(f'<document index="{len(result.files) + 1}">')
        parts.append("<source>instructions</source>")
        esc_inst = instruction.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        parts.append(f"<document_content>\n{esc_inst}\n</document_content>")
        parts.append("</document>")

    parts.append("</documents>")
    return "\n".join(parts)


def format_plain(result: PackResult, *, line_numbers: bool = False, instruction: str | None = None) -> str:
    sep = "=" * 60
    parts: list[str] = []
    n = len(result.files)
    noun = "file" if n == 1 else "files"
    parts.append(f"{n} {noun} · ~{result.total_tokens:,} tokens total\n")

    for pf in result.files:
        body = _add_line_numbers(pf.content) if line_numbers else pf.content
        parts.append(sep)
        parts.append(f"File: {pf.rel_path}  ({pf.lines:,} lines, ~{pf.tokens:,} tokens)")
        parts.append(sep)
        parts.append(body.rstrip())
        parts.append("")

    if instruction:
        parts.append(sep)
        parts.append("Instructions")
        parts.append(sep)
        parts.append(instruction.rstrip())
        parts.append("")

    return "\n".join(parts)


def format_pack(
    result: PackResult,
    style: str,
    *,
    line_numbers: bool = False,
    instruction: str | None = None,
) -> str:
    if style == "xml":
        return format_xml(result, line_numbers=line_numbers, instruction=instruction)
    if style == "plain":
        return format_plain(result, line_numbers=line_numbers, instruction=instruction)
    if style != "markdown":
        raise ValueError(f"Unknown style {style!r}; expected one of: markdown, xml, plain")
    return format_markdown(result, line_numbers=line_numbers, instruction=instruction)


# ---------------------------------------------------------------------------
# Budget / token-cost estimation
# ---------------------------------------------------------------------------


@dataclass
class BudgetEntry:
    rel_path: str
    lines: int
    tokens: int
    size_bytes: int


@dataclass
class BudgetResult:
    entries: list[BudgetEntry] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    total_lines: int = 0
    total_tokens: int = 0


def estimate_budget(
    project_root: Path,
    patterns: list[str],
    *,
    ignore_patterns: list[str] | None = None,
    max_file_bytes: int = 10 * 1024 * 1024,
) -> BudgetResult:
    """Estimate token cost for files matching patterns without reading full content."""
    result = BudgetResult()
    seen: set[Path] = set()
    root_resolved = project_root.resolve()

    for pattern in patterns:
        if Path(pattern).is_absolute():
            candidates = [Path(pattern)]
        else:
            try:
                candidates = sorted(project_root.glob(pattern))
            except Exception:
                result.skipped.append(f"{pattern} (glob error)")
                continue

        for p in candidates:
            if not p.is_file() or p in seen:
                continue
            try:
                rel = p.relative_to(project_root).as_posix()
            except ValueError:
                result.skipped.append(f"{p.as_posix()} (outside project root)")
                continue
            try:
                p.resolve().relative_to(root_resolved)
            except ValueError:
                result.skipped.append(f"{rel} (symlink points outside project root)")
                continue

            if ignore_patterns and _matches(rel, ignore_patterns):
                continue

            try:
                stat = p.stat()
            except OSError:
                result.skipped.append(f"{rel} (stat error)")
                continue

            size = stat.st_size
            if size > max_file_bytes:
                result.skipped.append(f"{rel} (>{max_file_bytes // 1024 // 1024}MB)")
                continue

            try:
                sample = p.read_bytes()
                lines = sample.count(b"\n") + 1
                tokens = _estimate_tokens(sample.decode("utf-8", errors="replace"))
            except OSError:
                result.skipped.append(f"{rel} (unreadable)")
                continue

            seen.add(p)
            entry = BudgetEntry(rel_path=rel, lines=lines, tokens=tokens, size_bytes=size)
            result.entries.append(entry)
            result.total_lines += lines
            result.total_tokens += tokens

    # Sort by token cost descending — most expensive first.
    result.entries.sort(key=lambda e: e.tokens, reverse=True)
    return result


def format_budget_text(result: BudgetResult, context_k: int | None = None) -> str:
    if not result.entries and not result.skipped:
        return "No files matched."

    col_w = max((len(e.rel_path) for e in result.entries), default=4)
    col_w = max(col_w, 4)
    lines: list[str] = [
        f"  {'File':<{col_w}}  {'Lines':>6}  {'~Tokens':>8}",
        f"  {'-' * col_w}  {'-' * 6}  {'-' * 8}",
    ]
    for e in result.entries:
        lines.append(f"  {e.rel_path:<{col_w}}  {e.lines:>6,}  {e.tokens:>8,}")

    lines.append(f"  {'-' * col_w}  {'-' * 6}  {'-' * 8}")

    pct = ""
    if context_k:
        pct = f"  ({result.total_tokens / (context_k * 1000) * 100:.0f}% of {context_k}K)"
    lines.append(f"  {'Total':<{col_w}}  {result.total_lines:>6,}  {result.total_tokens:>8,}{pct}")

    if result.skipped:
        lines.append(f"\n  Skipped: {', '.join(result.skipped[:5])}"
                     f"{'...' if len(result.skipped) > 5 else ''}")
    return "\n".join(lines)
