#!/usr/bin/env python3
"""
scripts/process_activities.py

Extracts structured text and numbered activities (1 to 250) across all document
and source code formats (PDF, DOCX, XLSX, XLS, CSS, TS, PY, JSON, TXT)
by delegating to extract_entities.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if __package__:
    from .extract_entities import DocumentChunk, extract_entities, load_document
else:
    from extract_entities import DocumentChunk, extract_entities, load_document


def extract_pdf_to_json(pdf_path: str | Path, json_out_path: str | Path | None = None) -> list[dict]:
    """Loads any document (PDF, Office, Code, Text) and dumps normalized chunks to JSON."""
    chunks = load_document(pdf_path)
    pages = [{"page": idx, **c.to_dict()} for idx, c in enumerate(chunks, start=1)]

    if json_out_path:
        Path(json_out_path).write_text(
            json.dumps(pages, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    return pages


def extract_activities(pages: list[dict], *, dedup: bool = False) -> list[dict]:
    """Extracts numbered activities (IDs 1-250) across pages or chunks."""
    chunks = [
        DocumentChunk(
            source=p.get("source", "doc"),
            unit=p.get("unit") or f"Page {p.get('page', idx)}",
            text=p.get("text", ""),
            metadata=p.get("metadata", {}),
            line_start=p.get("line_start"),
            line_end=p.get("line_end"),
            continuous=p.get("continuous", False),
            exact_lines=p.get("exact_lines", True),
        )
        for idx, p in enumerate(pages, start=1)
    ]
    raw_entities = extract_entities(chunks, entity_type="activities", id_range=(1, 250), dedup=dedup)
    return [
        {
            "page": ent.get("unit"),
            "id": int(ent["id"]),
            "content": ent["content"],
            "line_start": ent["line_start"],
            "line_end": ent["line_end"],
        }
        for ent in raw_entities
    ]


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Process document and extract activities 1-250")
    parser.add_argument("input", nargs="?", default="demo/fixtures/token-goat-eval.pdf", help="Input document path")
    parser.add_argument("output", nargs="?", default="pdf_extracted.json", help="Output JSON path")
    parser.add_argument("--inspect", action="store_true", help="Print sample extracted activities")
    parser.add_argument("--dedup", action="store_true", help="Remove duplicate (id, content) pairs")

    args = parser.parse_args()

    if not Path(args.input).exists():
        print(f"Error: Input file '{args.input}' not found.", file=sys.stderr)
        sys.exit(1)

    pages = extract_pdf_to_json(args.input, args.output)
    activities = extract_activities(pages, dedup=args.dedup)

    print(f"Successfully processed '{args.input}':")
    print(f"  - Units/Pages extracted: {len(pages)}")
    print(f"  - Structured JSON saved to: '{args.output}'")
    print(f"  - Activities detected (1-250): {len(activities)}")

    if args.inspect:
        print("\nInspecting first 5 detected activities:")
        for act in activities[:5]:
            snippet = act['content'][:80].replace('\n', ' ')
            print(f"  [{act['page']}] Activity {act['id']}: {snippet}...")


if __name__ == "__main__":
    main()
