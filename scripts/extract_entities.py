#!/usr/bin/env python3
"""
scripts/extract_entities.py

Universal Document & Entity Extractor
Ingests PDF, DOCX, XLSX, CSV, JSON/JSONL, TXT, and Markdown files,
normalizes them into structured units, and extracts numbered/labeled entities
(Activities 1-250, Requirements, Tasks, Steps, etc.) without inline shell
syntax issues, nested quote collisions, or read-hook bypass denials.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

if __package__:
    from .entity_document import CHUNK_CHARS, DocumentChunk, MarkupMasker, iter_csv, iter_json, iter_jsonl, iter_markdown, iter_text
    from .entity_output import write_entities
else:
    from entity_document import CHUNK_CHARS, DocumentChunk, MarkupMasker, iter_csv, iter_json, iter_jsonl, iter_markdown, iter_text
    from entity_output import write_entities

# Optional 3rd party format loaders
try:
    import pypdf
except ImportError:
    pypdf = None

try:
    import docx
except ImportError:
    docx = None

try:
    import openpyxl
except ImportError:
    openpyxl = None

try:
    import xlrd
except ImportError:
    xlrd = None


def _load_pdf(path: Path) -> List[DocumentChunk]:
    if pypdf is None:
        raise ImportError("pypdf is required to read PDF files (pip install pypdf)")
    reader = pypdf.PdfReader(str(path))
    chunks: List[DocumentChunk] = []
    for idx, page in enumerate(reader.pages, start=1):
        txt = page.extract_text() or ""
        chunks.append(DocumentChunk(source=str(path), unit=f"Page {idx}", text=txt, metadata={"page": idx}))
    return chunks


def _load_docx(path: Path) -> List[DocumentChunk]:
    chunks: List[DocumentChunk] = []
    if docx is not None:
        doc = docx.Document(str(path))
        lines: List[str] = []
        for para in doc.paragraphs:
            if para.text.strip():
                lines.append(para.text)
        for table in doc.tables:
            for row in table.rows:
                row_txt = " | ".join(c.text.strip() for c in row.cells if c.text.strip())
                if row_txt:
                    lines.append(row_txt)
        chunks.append(DocumentChunk(source=str(path), unit="Document", text="\n".join(lines)))
    else:
        # Fallback to direct zip extraction of word/document.xml
        import zipfile
        with zipfile.ZipFile(path, "r") as z:
            xml_content = z.read("word/document.xml")
            tree = ET.fromstring(xml_content)
            texts = [node.text for node in tree.iter() if node.tag.endswith("}t") and node.text]
            chunks.append(DocumentChunk(source=str(path), unit="Document", text="\n".join(texts)))
    return chunks


def _load_xlsx(path: Path) -> List[DocumentChunk]:
    chunks: List[DocumentChunk] = []
    if openpyxl is not None:
        wb = openpyxl.load_workbook(str(path), data_only=True)
        for sheetname in wb.sheetnames:
            ws = wb[sheetname]
            rows_txt: List[str] = []
            for row in ws.iter_rows(values_only=True):
                non_empty = [str(val).strip() for val in row if val is not None and str(val).strip()]
                if non_empty:
                    rows_txt.append(" | ".join(non_empty))
            if rows_txt:
                chunks.append(DocumentChunk(source=str(path), unit=f"Sheet {sheetname}", text="\n".join(rows_txt), metadata={"sheet": sheetname}))
    else:
        raise ImportError("openpyxl is required to read XLSX files (pip install openpyxl)")
    return chunks


def _load_xls(path: Path) -> List[DocumentChunk]:
    chunks: List[DocumentChunk] = []
    if xlrd is not None:
        try:
            book = xlrd.open_workbook(str(path))
            for sheet_idx in range(book.nsheets):
                sheet = book.sheet_by_index(sheet_idx)
                rows_txt: List[str] = []
                for row_idx in range(sheet.nrows):
                    row_vals = [str(sheet.cell_value(row_idx, col_idx)).strip() for col_idx in range(sheet.ncols)]
                    non_empty = [v for v in row_vals if v]
                    if non_empty:
                        rows_txt.append(" | ".join(non_empty))
                if rows_txt:
                    chunks.append(DocumentChunk(source=str(path), unit=f"Sheet {sheet.name}", text="\n".join(rows_txt), metadata={"sheet": sheet.name}))
            if chunks:
                return chunks
        except Exception:
            pass
    # Many web-exported .xls files are actually HTML table dumps
    content = path.read_text(encoding="utf-8", errors="replace")
    if "<table" in content.lower():
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", content, re.DOTALL | re.IGNORECASE)
        rows_txt = []
        for r in rows:
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.DOTALL | re.IGNORECASE)
            cleaned = [re.sub(r"<[^>]+>", "", c).strip() for c in cells if c.strip()]
            if cleaned:
                rows_txt.append(" | ".join(cleaned))
        if rows_txt:
            return [DocumentChunk(source=str(path), unit="HTML Table", text="\n".join(rows_txt))]
    return [DocumentChunk(source=str(path), unit="Raw Sheet", text=content)]


def _extract_comments(text: str, state: Optional[List[str]] = None) -> str:
    """Mask non-comment characters without moving any source locations."""
    masked = ["\n" if char == "\n" else " " for char in text]
    pattern = r'/\*([\s\S]*?)(?:\*/|\Z)|//([^\n]*)|#([^\n]*)|<!--([\s\S]*?)(?:-->|\Z)|"""([\s\S]*?)(?:"""|\Z)|\'\'\'([\s\S]*?)(?:\'\'\'|\Z)'
    state = state if state is not None else []
    offset = 0
    if state:
        closing = state[0]
        prefix = state[1] if len(state) > 1 else ""
        end = (prefix + text).find(closing)
        if end == -1:
            state[:] = [closing, _closing_prefix(prefix + text, closing)]
            return text
        end = max(0, end - len(prefix))
        masked[:end] = text[:end]
        offset = len(closing) - len(prefix) if (prefix + text).startswith(closing) else end + len(closing)
        state.clear()
    for match in re.finditer(pattern, text[offset:]):
        for group in range(1, 7):
            if match.group(group) is not None:
                start, end = match.span(group)
                start, end = start + offset, end + offset
                masked[start:end] = text[start:end]
                closing = {1: "*/", 2: "\n", 3: "\n", 4: "-->", 5: '"""', 6: "'''"}
                if end == len(text):
                    state[:] = [closing[group], _closing_prefix(text[start:end], closing[group])]
                break
    return "".join(masked)


def _closing_prefix(text: str, closing: str) -> str:
    for size in range(len(closing) - 1, 0, -1):
        if text.endswith(closing[:size]):
            return closing[:size]
    return ""


def load_document(source_path: str | Path) -> List[DocumentChunk]:
    """Loads and normalizes any supported file format into DocumentChunk objects."""
    return list(iter_document(source_path))


def iter_document(source_path: str | Path) -> Iterator[DocumentChunk]:
    """Stream line-based inputs; keep load_document's list API for existing callers."""
    p = Path(source_path)
    if not p.exists():
        raise FileNotFoundError(f"Input file not found: {source_path}")

    ext = p.suffix.lower()
    if ext == ".pdf":
        yield from _load_pdf(p)
    elif ext in (".docx", ".doc"):
        yield from _load_docx(p)
    elif ext in (".xlsx", ".xlsm"):
        yield from _load_xlsx(p)
    elif ext == ".xls":
        yield from _load_xls(p)
    elif ext in (".csv", ".tsv"):
        yield from iter_csv(p)
    elif ext == ".jsonl":
        yield from iter_jsonl(p)
    elif ext == ".json":
        yield from iter_json(p)
    elif ext in (".md", ".markdown", ".mdx"):
        yield from iter_markdown(p)
    else:
        # Source, stylesheets, RST, AsciiDoc, configs and unknown text formats.
        yield from iter_text(p)


ENTITY_PRESETS = {
    "activities": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Activity\s+)?(\d{1,3})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Activity\s+)?\d{1,3}[.:|\s-])|\Z)",
    "tasks": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Task\s+)?(\d{1,4})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Task\s+)?\d{1,4}[.:|\s-])|\Z)",
    "requirements": r"\b(REQ(?:-[A-Za-z0-9]+)?-\d{1,5})\b[:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?REQ)|\Z)",
    "steps": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Step\s+)?(\d{1,3})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Step\s+)?\d{1,3}[.:|\s-])|\Z)",
}


def extract_entities(
    chunks: Iterable[DocumentChunk],
    entity_type: str = "activities",
    custom_pattern: Optional[str] = None,
    id_range: Optional[Tuple[int, int]] = (1, 250),
    keyword_filter: Optional[str] = None,
    comments_only: bool = False,
    dedup: bool = False,
) -> List[Dict[str, Any]]:
    """Extracts entities from chunks using regex rules with validation and filtering."""
    return list(iter_entities(
        chunks, entity_type, custom_pattern, id_range, keyword_filter, comments_only, dedup,
    ))


def _normalize_content(text: str) -> str:
    text = "".join(
        char for char in text
        if char.isspace() or unicodedata.category(char) not in ("Cc", "Cf")
    )
    return " ".join(text.split())


def _iter_matches(
    chunks: Iterable[DocumentChunk], regex: re.Pattern, comments_only: bool,
    *, custom_pattern: bool = False,
) -> Iterator[Tuple[DocumentChunk, re.Match]]:
    pending = None
    comment_state: List[str] = []
    markup_masker = MarkupMasker()
    for chunk in chunks:
        if pending and (pending.source != chunk.source or pending.metadata.get("heading_line") != chunk.metadata.get("heading_line")):
            comment_state.clear()
            markup_masker = MarkupMasker()
        if comments_only and pending and len(comment_state) > 1:
            closing, prefix = comment_state
            if prefix and (prefix + chunk.text).startswith(closing):
                pending.text = pending.text[:-len(prefix)] + " " * len(prefix)
        text = _extract_comments(chunk.text, comment_state) if comments_only else chunk.text
        extension = Path(chunk.source).suffix.lower()
        if not comments_only and extension in (".md", ".markdown", ".mdx"):
            text = re.sub(r"(?m)^([ \t]*\|[^\n]*)", lambda m: re.sub(r"(?<!\\)\|", " ", m[0]), text)
        if not comments_only and extension in (".yaml", ".yml", ".toml"):
            text = re.sub(
                r'''(?m)^([ \t]*[\w.-]+[ \t]*[:=][ \t]*)(["']?)([^\n]*?)\2[ \t]*$''',
                lambda m: " " * len(m[1] + m[2]) + m[3] + " " * (len(m[0]) - len(m[1] + m[2] + m[3])),
                text,
            )
        line_map = None
        if not comments_only and extension in (".xml", ".html", ".htm", ".mdx"):
            text, line_map = markup_masker.mask(text, chunk.line_start)
        current = DocumentChunk(
            chunk.source, chunk.unit, text, chunk.metadata,
            line_start=chunk.line_start, line_end=chunk.line_end,
            continuous=chunk.continuous, exact_lines=chunk.exact_lines,
            line_map=line_map,
        )
        if pending:
            if (pending.source == current.source
                    and pending.metadata.get("heading") == current.metadata.get("heading")
                    and pending.metadata.get("heading_line") == current.metadata.get("heading_line")
                    and pending.metadata.get("page") == current.metadata.get("page")):
                current.text = pending.text + current.text
                current.line_start = pending.line_start
                if current.line_map is not None and pending.line_map is not None:
                    current.line_map = pending.line_map + current.line_map[1:]
            else:
                for match in regex.finditer(pending.text):
                    yield pending, match
            pending = None
        matches = list(regex.finditer(current.text))
        if current.continuous:
            if custom_pattern and not matches and len(current.text) > CHUNK_CHARS:
                raise ValueError("Custom pattern has no match within the 65,536-character streaming prefix; use smaller document units")
            cut = matches[-1].start() if matches else (
                0 if custom_pattern else max(current.text.rfind("\n") + 1, len(current.text) - CHUNK_CHARS)
            )
            for match in matches[:-1]:
                yield current, match
            start, _ = current.location(cut, cut)
            pending = DocumentChunk(
                current.source, current.unit, current.text[cut:], current.metadata,
                line_start=start, line_end=current.line_end,
                line_map=current.line_map[current.text.count("\n", 0, cut):] if current.line_map is not None else None,
            )
        else:
            for match in matches:
                yield current, match
            comment_state.clear()
            markup_masker = MarkupMasker()
    if pending:
        for match in regex.finditer(pending.text):
            yield pending, match


def iter_entities(
    chunks: Iterable[DocumentChunk],
    entity_type: str = "activities",
    custom_pattern: Optional[str] = None,
    id_range: Optional[Tuple[int, int]] = (1, 250),
    keyword_filter: Optional[str] = None,
    comments_only: bool = False,
    dedup: bool = False,
) -> Iterator[Dict[str, Any]]:
    """Yield normalized entities, retaining only an unfinished entity between batches."""
    pattern_str = custom_pattern or ENTITY_PRESETS.get(entity_type.lower(), ENTITY_PRESETS["activities"])
    regex = re.compile(pattern_str, re.DOTALL | re.IGNORECASE if entity_type == "requirements" else re.DOTALL)
    seen = set()
    for chunk, match in _iter_matches(chunks, regex, comments_only, custom_pattern=custom_pattern is not None):
        if keyword_filter and keyword_filter.lower() not in chunk.text.lower():
            continue
        raw_id = match.group(1).strip()
        content = _normalize_content(match.group(2))
        if id_range is not None:
            numeric_match = re.search(r"\d+", raw_id)
            if numeric_match:
                num_val = int(numeric_match.group(0))
                if not (id_range[0] <= num_val <= id_range[1]):
                    continue
            else:
                continue
        parsed_id: Any = int(raw_id) if raw_id.isdigit() else raw_id
        key = (parsed_id, content)
        if dedup and key in seen:
            continue
        if dedup:
            seen.add(key)
        end = match.start(2) + len(match.group(2).rstrip()) - 1
        line_start, line_end = chunk.location(match.start(1), max(match.start(1), end))
        unit, metadata = chunk.unit, chunk.metadata
        if unit.startswith("Lines ") and line_start is not None:
            unit = f"Lines {line_start}-{line_end}"
            metadata = {**metadata, "start_line": line_start, "end_line": line_end}
        yield {
            "source": chunk.source, "unit": unit,
            "id": parsed_id, "content": content, "metadata": metadata,
            "line_start": line_start, "line_end": line_end,
        }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    parser = argparse.ArgumentParser(description="Universal Document & Entity Extractor")
    parser.add_argument("input", help="Path to input document (PDF, DOCX, XLSX, CSV, JSON, TXT, MD)")
    parser.add_argument("--out", "-o", help="Output file (.jsonl and .csv select their native format)", default=None)
    parser.add_argument(
        "--type", "-t",
        choices=["activities", "tasks", "requirements", "steps"],
        default="activities",
        help="Entity extraction preset (default: activities)",
    )
    parser.add_argument("--pattern", "-p", help="Custom regex (unmatched streaming prefix limited to 65,536 characters)", default=None)
    parser.add_argument("--range", "-r", help="ID range floor-ceiling, e.g. 1-250", default="1-250")
    parser.add_argument("--filter", "-f", help="Case-insensitive keyword filter for units", default=None)
    parser.add_argument("--format", choices=["summary", "json", "jsonl", "csv"], default="summary", help="Output format (default: summary; --out defaults to JSON)")
    parser.add_argument("--dedup", action="store_true", help="Keep the first occurrence of each normalized (id, content) pair")
    parser.add_argument("--comments-only", "-c", action="store_true", help="Extract entities exclusively from code/stylesheet comments")
    parser.add_argument("--dump-chunks", action="store_true", help="Dump normalized document chunks to output JSON")

    args = parser.parse_args()

    id_range: Optional[Tuple[int, int]] = None
    if args.range and args.range.lower() != "none":
        parts = args.range.split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            id_range = (int(parts[0]), int(parts[1]))

    summary = {
        "source": str(args.input),
        "total_units": 0,
        "total_entities": 0,
        "entity_type": args.type,
    }
    dumped_chunks = [] if args.dump_chunks else None

    def counted_chunks():
        for chunk in iter_document(args.input):
            summary["total_units"] += 1
            if dumped_chunks is not None:
                dumped_chunks.append(chunk.to_dict())
            yield chunk

    def counted_entities():
        for entity in iter_entities(
            counted_chunks(), args.type, args.pattern, id_range, args.filter,
            args.comments_only, args.dedup,
        ):
            summary["total_entities"] += 1
            yield entity

    output_format = args.format
    if args.out:
        suffix = Path(args.out).suffix.lower()
        output_format = {".jsonl": "jsonl", ".csv": "csv"}.get(suffix, args.format)
        if output_format == "summary":
            output_format = "json"
    if args.dump_chunks and (not args.out or output_format != "json"):
        parser.error("--dump-chunks requires --out with JSON format")
    if args.out and Path(args.out).resolve() == Path(args.input).resolve():
        parser.error("--out must not overwrite the input document")
    try:
        if args.out:
            out_path = Path(args.out)
            if out_path.exists() and out_path.samefile(args.input):
                parser.error("--out must not overwrite the input document")
            with out_path.open("w", encoding="utf-8", newline="") as stream:
                write_entities(counted_entities(), stream, output_format, summary=summary, chunks=dumped_chunks)
            print(f"Extracted {summary['total_entities']} {args.type} from {summary['total_units']} units in '{args.input}'.")
            print(f"Saved to '{args.out}'.")
        elif output_format != "summary":
            write_entities(counted_entities(), sys.stdout, output_format)
        else:
            sample = []
            for entity in counted_entities():
                if len(sample) < 5:
                    sample.append(entity)
            print(f"Summary: {json.dumps(summary, indent=2)}")
            print(f"Sample Entities ({len(sample)} of {summary['total_entities']}):")
            for entity in sample:
                print(f"  [{entity['unit']}] {entity['id']}: {entity['content'][:80]}...")
    except (OSError, ValueError, ImportError) as error:
        print(f"Error extracting '{args.input}': {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
