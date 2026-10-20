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
import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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


class DocumentChunk:
    def __init__(self, source: str, unit: str, text: str, metadata: Optional[Dict[str, Any]] = None):
        self.source = source
        self.unit = unit
        self.text = text
        self.metadata = metadata or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "unit": self.unit,
            "text": self.text,
            "metadata": self.metadata,
        }


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


def _load_csv(path: Path) -> List[DocumentChunk]:
    lines: List[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        for row in reader:
            row_txt = " | ".join(c.strip() for c in row if c.strip())
            if row_txt:
                lines.append(row_txt)
    return [DocumentChunk(source=str(path), unit="CSV", text="\n".join(lines))]


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


def _load_code_or_style(path: Path) -> List[DocumentChunk]:
    content = path.read_text(encoding="utf-8", errors="replace")
    lines = content.splitlines()
    chunks: List[DocumentChunk] = []

    CHUNK_SIZE = 100
    for i in range(0, len(lines), CHUNK_SIZE):
        batch = lines[i : i + CHUNK_SIZE]
        start_line = i + 1
        end_line = min(i + CHUNK_SIZE, len(lines))
        unit_label = f"Lines {start_line}-{end_line}"
        chunks.append(
            DocumentChunk(
                source=str(path),
                unit=unit_label,
                text="\n".join(batch),
                metadata={"start_line": start_line, "end_line": end_line},
            )
        )
    return chunks


def _extract_comments(text: str) -> str:
    """Extracts comments and docstrings from source code or stylesheets."""
    comments: List[str] = []
    # Block comments /* ... */ (CSS, JS, TS, C, Java, etc.)
    for block in re.finditer(r"/\*([\s\S]*?)\*/", text):
        comments.append(block.group(1))
    # Line comments // (JS, TS, C, Java, Go, Rust, etc.)
    for line in re.finditer(r"//\s*(.*)", text):
        comments.append(line.group(1))
    # Python / Shell / YAML / TOML comments #
    for line in re.finditer(r"#\s*(.*)", text):
        comments.append(line.group(1))
    # HTML / XML comments <!-- ... -->
    for block in re.finditer(r"<!--([\s\S]*?)-->", text):
        comments.append(block.group(1))
    # Python docstrings """ ... """ or ''' ... '''
    for doc in re.finditer(r'"""([\s\S]*?)"""|\'\'\'([\s\S]*?)\'\'\'', text):
        comments.append(doc.group(1) or doc.group(2) or "")
    return "\n".join(comments)


def _load_json(path: Path) -> List[DocumentChunk]:
    content = path.read_text(encoding="utf-8", errors="replace")
    chunks: List[DocumentChunk] = []
    try:
        data = json.loads(content)
        if isinstance(data, list):
            for idx, item in enumerate(data, start=1):
                if isinstance(item, dict):
                    unit = item.get("unit") or f"Page {item.get('page')}" if "page" in item else f"Item {idx}"
                    text = item.get("text") or item.get("content") or json.dumps(item)
                    meta = {k: v for k, v in item.items() if k not in ("text", "content")}
                    chunks.append(DocumentChunk(source=str(path), unit=str(unit), text=str(text), metadata=meta))
                else:
                    chunks.append(DocumentChunk(source=str(path), unit=f"Item {idx}", text=str(item)))
        elif isinstance(data, dict):
            # Check if dict wraps pages or sections
            if "pages" in data and isinstance(data["pages"], list):
                for idx, p in enumerate(data["pages"], start=1):
                    unit = p.get("unit") or f"Page {p.get('page', idx)}" if isinstance(p, dict) else f"Page {idx}"
                    text = p.get("text", "") if isinstance(p, dict) else str(p)
                    chunks.append(DocumentChunk(source=str(path), unit=str(unit), text=str(text)))
            else:
                chunks.append(DocumentChunk(source=str(path), unit="Root", text=json.dumps(data, indent=2)))
    except json.JSONDecodeError:
        # Fallback to JSONL
        for idx, line in enumerate(content.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    unit = item.get("unit") or f"Page {item.get('page')}" if "page" in item else f"Line {idx}"
                    text = item.get("text") or item.get("content") or line
                    chunks.append(DocumentChunk(source=str(path), unit=str(unit), text=str(text)))
                else:
                    chunks.append(DocumentChunk(source=str(path), unit=f"Line {idx}", text=str(item)))
            except Exception:
                chunks.append(DocumentChunk(source=str(path), unit=f"Line {idx}", text=line))
    return chunks


def _load_text(path: Path) -> List[DocumentChunk]:
    content = path.read_text(encoding="utf-8", errors="replace")
    # Split on form feed or markdown double-horizontal rules if present, else return document
    if "\x0c" in content:
        pages = content.split("\x0c")
        return [DocumentChunk(source=str(path), unit=f"Page {i}", text=p) for i, p in enumerate(pages, start=1) if p.strip()]
    return [DocumentChunk(source=str(path), unit="Text", text=content)]


def load_document(source_path: str | Path) -> List[DocumentChunk]:
    """Loads and normalizes any supported file format into DocumentChunk objects."""
    p = Path(source_path)
    if not p.exists():
        raise FileNotFoundError(f"Input file not found: {source_path}")

    ext = p.suffix.lower()
    if ext == ".pdf":
        return _load_pdf(p)
    elif ext in (".docx", ".doc"):
        return _load_docx(p)
    elif ext in (".xlsx", ".xlsm"):
        return _load_xlsx(p)
    elif ext == ".xls":
        return _load_xls(p)
    elif ext in (".csv", ".tsv"):
        return _load_csv(p)
    elif ext in (".json", ".jsonl"):
        return _load_json(p)
    elif ext in (
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
        ".py", ".pyw",
        ".css", ".scss", ".sass", ".less",
        ".go", ".rs", ".java", ".cs", ".c", ".cpp", ".cc", ".h", ".hpp",
        ".sh", ".bash", ".ps1", ".psm1",
        ".yaml", ".yml", ".toml", ".xml", ".sql",
    ):
        return _load_code_or_style(p)
    elif ext in (".txt", ".md", ".markdown", ".rst", ".html", ".htm"):
        return _load_text(p)
    else:
        # Generic text attempt
        return _load_text(p)


ENTITY_PRESETS = {
    "activities": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Activity\s+)?(\d{1,3})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Activity\s+)?\d{1,3}[.:|\s-])|\Z)",
    "tasks": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Task\s+)?(\d{1,4})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Task\s+)?\d{1,4}[.:|\s-])|\Z)",
    "requirements": r"\b(REQ(?:-[A-Za-z0-9]+)?-\d{1,5})\b[:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?REQ)|\Z)",
    "steps": r"(?:^|\n)\s*(?:[#/*\-=>]+\s*)?(?:Step\s+)?(\d{1,3})[.:|\s-]+(.+?)(?=(?:\n\s*(?:[#/*\-=>]+\s*)?(?:Step\s+)?\d{1,3}[.:|\s-])|\Z)",
}


def extract_entities(
    chunks: List[DocumentChunk],
    entity_type: str = "activities",
    custom_pattern: Optional[str] = None,
    id_range: Optional[Tuple[int, int]] = (1, 250),
    keyword_filter: Optional[str] = None,
    comments_only: bool = False,
) -> List[Dict[str, Any]]:
    """Extracts entities from chunks using regex rules with validation and filtering."""
    pattern_str = custom_pattern or ENTITY_PRESETS.get(entity_type.lower(), ENTITY_PRESETS["activities"])
    regex = re.compile(pattern_str, re.DOTALL | re.IGNORECASE if entity_type == "requirements" else re.DOTALL)

    results: List[Dict[str, Any]] = []

    for chunk in chunks:
        txt = chunk.text
        if comments_only:
            txt = _extract_comments(txt)
            if not txt.strip():
                continue

        if keyword_filter and keyword_filter.lower() not in txt.lower():
            continue

        for match in regex.finditer(txt):
            raw_id = match.group(1).strip()
            content = match.group(2).strip()

            # If id_range is specified, enforce numeric constraints
            if id_range is not None:
                numeric_match = re.search(r"\d+", raw_id)
                if numeric_match:
                    num_val = int(numeric_match.group(0))
                    if not (id_range[0] <= num_val <= id_range[1]):
                        continue
                else:
                    continue

            parsed_id: Any = int(raw_id) if raw_id.isdigit() else raw_id
            results.append({
                "source": chunk.source,
                "unit": chunk.unit,
                "id": parsed_id,
                "content": content,
                "metadata": chunk.metadata,
            })

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Universal Document & Entity Extractor")
    parser.add_argument("input", help="Path to input document (PDF, DOCX, XLSX, CSV, JSON, TXT, MD)")
    parser.add_argument("--out", "-o", help="Path to write extracted output JSON", default=None)
    parser.add_argument(
        "--type", "-t",
        choices=["activities", "tasks", "requirements", "steps"],
        default="activities",
        help="Entity extraction preset (default: activities)",
    )
    parser.add_argument("--pattern", "-p", help="Custom regex pattern for entity extraction", default=None)
    parser.add_argument("--range", "-r", help="ID range floor-ceiling, e.g. 1-250", default="1-250")
    parser.add_argument("--filter", "-f", help="Case-insensitive keyword filter for units", default=None)
    parser.add_argument("--format", choices=["summary", "json"], default="summary", help="Console output format when --out is not provided (default: summary)")
    parser.add_argument("--comments-only", "-c", action="store_true", help="Extract entities exclusively from code/stylesheet comments")
    parser.add_argument("--dump-chunks", action="store_true", help="Dump normalized document chunks to output JSON")

    args = parser.parse_args()

    id_range: Optional[Tuple[int, int]] = None
    if args.range and args.range.lower() != "none":
        parts = args.range.split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            id_range = (int(parts[0]), int(parts[1]))

    try:
        chunks = load_document(args.input)
    except Exception as e:
        print(f"Error loading document '{args.input}': {e}", file=sys.stderr)
        sys.exit(1)

    entities = extract_entities(
        chunks=chunks,
        entity_type=args.type,
        custom_pattern=args.pattern,
        id_range=id_range,
        keyword_filter=args.filter,
        comments_only=args.comments_only,
    )

    summary = {
        "source": str(args.input),
        "total_units": len(chunks),
        "total_entities": len(entities),
        "entity_type": args.type,
    }

    if args.out:
        out_payload: Dict[str, Any] = {
            "summary": summary,
            "entities": entities,
        }
        if args.dump_chunks:
            out_payload["chunks"] = [c.to_dict() for c in chunks]

        Path(args.out).write_text(json.dumps(out_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Extracted {len(entities)} {args.type} from {len(chunks)} units in '{args.input}'.")
        print(f"Saved to '{args.out}'.")
    elif args.format == "json":
        print(json.dumps(entities, ensure_ascii=False, indent=2))
    else:
        print(f"Summary: {json.dumps(summary, indent=2)}")
        print(f"Sample Entities ({min(5, len(entities))} of {len(entities)}):")
        for ent in entities[:5]:
            preview = ent["content"][:80].replace("\n", " ")
            print(f"  [{ent['unit']}] {ent['id']}: {preview}...")


if __name__ == "__main__":
    main()
