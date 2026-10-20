"""Streaming serializers for extracted entities."""

from __future__ import annotations

import csv
import json
from typing import Any, Iterable, TextIO

CSV_FIELDS = ("source", "unit", "id", "content", "line_start", "line_end", "metadata")


def write_entities(
    entities: Iterable[dict[str, Any]], stream: TextIO, output_format: str,
    *, summary: dict[str, Any] | None = None, chunks: list[dict[str, Any]] | None = None,
) -> None:
    if output_format == "csv":
        writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        for entity in entities:
            writer.writerow({
                **entity,
                "metadata": json.dumps(entity["metadata"], ensure_ascii=False),
            })
    elif output_format == "jsonl":
        for entity in entities:
            stream.write(json.dumps(entity, ensure_ascii=False) + "\n")
    else:
        stream.write('{"entities": [' if summary is not None else "[")
        separator = ""
        for entity in entities:
            stream.write(separator + json.dumps(entity, ensure_ascii=False))
            separator = ",\n"
        stream.write("]")
        if summary is not None:
            stream.write(', "summary": ' + json.dumps(summary, ensure_ascii=False))
            if chunks is not None:
                stream.write(', "chunks": ' + json.dumps(chunks, ensure_ascii=False))
            stream.write("}")
        stream.write("\n")
