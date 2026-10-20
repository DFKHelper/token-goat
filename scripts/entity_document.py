"""Located, incremental readers for line-based entity extraction inputs."""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any, Iterator

CHUNK_LINES = 100
CHUNK_CHARS = 65536


class DocumentChunk:
    def __init__(
        self, source: str, unit: str, text: str, metadata: dict[str, Any] | None = None,
        *, line_start: int | None = None, line_end: int | None = None,
        continuous: bool = False, exact_lines: bool = True,
        line_map: list[int] | None = None,
    ):
        self.source = source
        self.unit = unit
        self.text = text
        self.metadata = metadata or {}
        self.line_start = line_start
        self.line_end = line_end
        self.continuous = continuous
        self.exact_lines = exact_lines
        self.line_map = line_map

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source, "unit": self.unit, "text": self.text,
            "metadata": self.metadata,
            "line_start": self.line_start, "line_end": self.line_end,
            "continuous": self.continuous, "exact_lines": self.exact_lines,
        }

    def location(self, start: int, end: int) -> tuple[int | None, int | None]:
        if self.line_start is None or not self.exact_lines:
            return self.line_start, self.line_end
        if self.line_map is not None:
            return (
                self.line_map[self.text.count("\n", 0, start)],
                self.line_map[self.text.count("\n", 0, end)],
            )
        return (
            self.line_start + self.text.count("\n", 0, start),
            self.line_start + self.text.count("\n", 0, end),
        )


class MarkupMasker:
    """Mask tags incrementally, including quoted attributes split across batches."""

    def __init__(self):
        self.in_tag = False
        self.quote = ""
        self.prefix = ""
        self.tail = ""

    def mask(self, text: str, start_line: int | None) -> tuple[str, list[int] | None]:
        output: list[str] = []
        number = start_line or 1
        lines = [number]
        for char in text:
            if not self.in_tag and char == "<":
                self.in_tag, self.prefix, self.tail = True, "", ""
                masked = "\n"
            elif self.in_tag:
                masked = "\n" if char == "\n" else " "
                self.prefix = (self.prefix + char)[:3]
                if self.prefix == "!--":
                    if char == ">" and self.tail == "--":
                        self.in_tag = False
                elif self.quote:
                    if char == self.quote:
                        self.quote = ""
                elif char in ("'", '"'):
                    self.quote = char
                elif char == ">":
                    self.in_tag = False
                self.tail = (self.tail + char)[-2:]
            else:
                masked = char
            output.append(masked)
            number += int(char == "\n")
            if masked == "\n":
                lines.append(number)
        return "".join(output), lines if start_line is not None else None


def iter_text(path: Path) -> Iterator[DocumentChunk]:
    """Bound reads even for files with a single very long physical line."""
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        line_number = 1
        page = 1
        parts: list[str] = []
        size = 0
        start = 1
        for_fragment = stream.readline(CHUNK_CHARS)
        while for_fragment:
            fragments = for_fragment.split("\x0c")
            for index, fragment in enumerate(fragments):
                if fragment:
                    if not parts:
                        start = line_number
                    parts.append(fragment)
                    size += len(fragment)
                    line_number += fragment.count("\n")
                page_break = index < len(fragments) - 1
                if parts and (page_break or len(parts) >= CHUNK_LINES or size >= CHUNK_CHARS):
                    text = "".join(parts)
                    end = line_number - int(text.endswith("\n"))
                    yield DocumentChunk(
                        str(path), f"Lines {start}-{end}", text,
                        {"start_line": start, "end_line": end, "page": page},
                        line_start=start, line_end=end, continuous=not page_break,
                    )
                    parts, size = [], 0
                if page_break:
                    page += 1
            for_fragment = stream.readline(CHUNK_CHARS)
        if parts:
            text = "".join(parts)
            end = line_number - int(text.endswith("\n"))
            yield DocumentChunk(
                str(path), f"Lines {start}-{end}", text,
                {"start_line": start, "end_line": end, "page": page},
                line_start=start, line_end=end,
            )


def iter_csv(path: Path) -> Iterator[DocumentChunk]:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as stream:
        reader = csv.reader(stream, delimiter="\t" if path.suffix.lower() == ".tsv" else ",")
        previous_line = 0
        for row in reader:
            start, end = previous_line + 1, reader.line_num
            previous_line = end
            text = " | ".join(cell.strip() for cell in row if cell.strip())
            if text:
                yield DocumentChunk(
                    str(path), "CSV", text, line_start=start, line_end=end, exact_lines=False,
                )


def iter_markdown(path: Path) -> Iterator[DocumentChunk]:
    headings: list[tuple[int, str]] = []
    fence = ""
    heading_line = 0

    def make_chunk(text: str, start: int, end: int, continuous: bool) -> DocumentChunk:
        heading = " > ".join(title for _, title in headings)
        return DocumentChunk(
            str(path), heading or "Markdown", text,
            {"heading": heading, "heading_line": heading_line},
            line_start=start, line_end=end, continuous=continuous,
        )

    with path.open("r", encoding="utf-8", errors="replace") as stream:
        parts: list[str] = []
        start = number = 1
        size = 0
        line = stream.readline(CHUNK_CHARS)
        while line:
            following = stream.readline(CHUNK_CHARS)
            marker = re.match(r" {0,3}(`{3,}|~{3,})", line)
            if marker:
                token = marker.group(1)
                if not fence:
                    fence = token
                elif token[0] == fence[0] and len(token) >= len(fence):
                    fence = ""
            heading = None if fence else re.match(r" {0,3}(#{1,6})[ \t]+(.+?)\s*$", line)
            setext = (
                not fence and not marker and line.strip()
                and re.match(r" {0,3}(=+|-+)[ \t]*(?:\r?\n)?$", following)
            )
            if heading or setext:
                if parts:
                    text = "".join(parts)
                    yield make_chunk(text, start, number - int(text.endswith("\n")), False)
                    parts, size = [], 0
                level = len(heading.group(1)) if heading else (1 if following.lstrip().startswith("=") else 2)
                title = re.sub(r"(?:^|[ \t]+)#+[ \t]*$", "", heading.group(2)) if heading else line.strip()
                headings = [(depth, text) for depth, text in headings if depth < level]
                headings.append((level, title))
                heading_line = number
                start = number
            parts.append(line)
            size += len(line)
            number += line.count("\n")
            if setext and not heading:
                parts.append(following)
                size += len(following)
                number += following.count("\n")
                following = stream.readline(CHUNK_CHARS)
            if len(parts) >= CHUNK_LINES or size >= CHUNK_CHARS:
                text = "".join(parts)
                yield make_chunk(text, start, number - int(text.endswith("\n")), True)
                parts, size, start = [], 0, number
            line = following
        if parts:
            text = "".join(parts)
            yield make_chunk(text, start, number - int(text.endswith("\n")), False)


def _json_chunk(path: Path, item: Any, index: int, start: int, end: int) -> DocumentChunk:
    metadata: dict[str, Any] = {}
    unit = f"Item {index}"
    text = str(item)
    if isinstance(item, dict):
        unit = item.get("unit") or (f"Page {item['page']}" if "page" in item else unit)
        text = item.get("text") or item.get("content") or json.dumps(item, ensure_ascii=False)
        metadata = {key: value for key, value in item.items() if key not in ("text", "content")}
    return DocumentChunk(
        str(path), str(unit), str(text), metadata,
        line_start=start, line_end=end, exact_lines=False,
    )


def iter_jsonl(path: Path) -> Iterator[DocumentChunk]:
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                item = line.strip()
            yield _json_chunk(path, item, number, number, number)


def iter_json(path: Path) -> Iterator[DocumentChunk]:
    # JSON arrays/objects require structural decoding. JSONL takes the separate
    # incremental path above and never reads or reparses the complete file.
    content = path.read_text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        yield from iter_jsonl(path)
        return
    decoder = json.JSONDecoder()
    if isinstance(data, list):
        items = data
        cursor = content.index("[") + 1
    elif isinstance(data, dict) and isinstance(data.get("pages"), list):
        items = data["pages"]
        # Find the actual top-level pages key, not a string containing "pages".
        cursor = content.index("{") + 1
        while True:
            cursor = _skip_space(content, cursor)
            key, cursor = decoder.raw_decode(content, cursor)
            cursor = _skip_space(content, cursor) + 1
            cursor = _skip_space(content, cursor)
            if key == "pages":
                cursor += 1
                break
            _, cursor = decoder.raw_decode(content, cursor)
            cursor = _skip_space(content, cursor) + 1
    else:
        yield _json_chunk(path, data, 1, 1, max(1, len(content.splitlines())))
        return
    line = content.count("\n", 0, cursor) + 1
    for index, item in enumerate(items, start=1):
        begin = _skip_space(content, cursor)
        if content[begin:begin + 1] == ",":
            begin = _skip_space(content, begin + 1)
        _, end = decoder.raw_decode(content, begin)
        start_line = line + content.count("\n", cursor, begin)
        end_line = start_line + content.count("\n", begin, end)
        yield _json_chunk(path, item, index, start_line, end_line)
        line, cursor = end_line, end


def _skip_space(content: str, cursor: int) -> int:
    while cursor < len(content) and content[cursor].isspace():
        cursor += 1
    return cursor
