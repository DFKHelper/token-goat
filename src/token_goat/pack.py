"""Bundle project files into a single LLM-ready output with token estimates."""
from __future__ import annotations

import fnmatch
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


def collect_files(
    project_root: Path,
    patterns: list[str],
    *,
    ignore_patterns: list[str] | None = None,
    max_file_bytes: int = 2 * 1024 * 1024,
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
) -> PackResult:
    """Read newline-separated file paths from stdin and collect them."""
    paths = [ln.strip() for ln in sys.stdin.read().splitlines() if ln.strip()]
    return collect_files(project_root, paths, ignore_patterns=ignore_patterns, max_file_bytes=max_file_bytes)


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
