"""Extract failing test blocks from test runner output."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field


@dataclass
class FailureBlock:
    name: str
    body: str


@dataclass
class FailureResult:
    runner: str = "unknown"
    blocks: list[FailureBlock] = field(default_factory=list)
    summary_lines: list[str] = field(default_factory=list)
    stats_line: str = ""

    @property
    def count(self) -> int:
        return len(self.blocks) or len(self.summary_lines)


# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

_PYTEST_SECTION = re.compile(r"^=+ (.+?) =+$")
_PYTEST_BLOCK_SEP = re.compile(r"^_+ (.+?) _+$")
_JEST_BLOCK_START = re.compile(r"^\s+● ")
_GO_FAIL = re.compile(r"^--- FAIL:\s+(\S+)")
_CARGO_FAIL = re.compile(r"^test .+ \.\.\. FAILED")


# ---------------------------------------------------------------------------
# Runner detection
# ---------------------------------------------------------------------------


def _detect_runner(text: str) -> str:
    if "=== FAILURES ===" in text or "=== ERRORS ===" in text:
        return "pytest"
    if re.search(r"\bFAILED\b.+::test_", text) or re.search(r"short test summary", text):
        return "pytest"
    if re.search(r"^\s+●\s", text, re.MULTILINE) or re.search(r"^FAIL\s+\S+\.test\b", text, re.MULTILINE):
        return "jest"
    if re.search(r"^--- FAIL:", text, re.MULTILINE):
        return "go"
    if re.search(r"^test .+ \.\.\. FAILED", text, re.MULTILINE):
        return "cargo"
    return "unknown"


# ---------------------------------------------------------------------------
# Per-runner extractors
# ---------------------------------------------------------------------------


def _extract_pytest(lines: list[str]) -> FailureResult:
    result = FailureResult(runner="pytest")

    in_failures = False
    in_block = False
    in_summary = False
    current_name = ""
    current_body: list[str] = []

    for line in lines:
        s = line.rstrip()

        m = _PYTEST_SECTION.match(s)
        if m:
            section = m.group(1)
            # Close any open block
            if in_block and current_name:
                result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))
                current_name = ""
                current_body = []
                in_block = False

            if section in ("FAILURES", "ERRORS"):
                in_failures = True
                in_summary = False
            elif "short test summary" in section:
                in_failures = False
                in_summary = True
            elif re.match(r"\d+ (failed|error)", section):
                result.stats_line = s
                in_summary = False
            else:
                in_failures = False
                in_summary = False
            continue

        if in_summary:
            result.summary_lines.append(s)
            continue

        if in_failures:
            bm = _PYTEST_BLOCK_SEP.match(s)
            if bm:
                if in_block and current_name:
                    result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))
                current_name = bm.group(1)
                current_body = []
                in_block = True
                continue
            if in_block:
                current_body.append(s)

    # Flush last block
    if in_block and current_name:
        result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))

    # Fallback: no section structure — collect FAILED lines
    if not result.blocks and not result.summary_lines:
        for line in lines:
            if line.startswith("FAILED "):
                result.summary_lines.append(line.rstrip())

    return result


def _extract_jest(lines: list[str]) -> FailureResult:
    result = FailureResult(runner="jest")

    in_block = False
    current_name = ""
    current_body: list[str] = []

    for line in lines:
        s = line.rstrip()

        if _JEST_BLOCK_START.match(s):
            if in_block and current_name:
                result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))
            current_name = re.sub(r"^\s+●\s+", "", s)
            current_body = [s]
            in_block = True
            continue

        if in_block:
            # A FAIL header or "Tests:" line closes the block
            if re.match(r"^(FAIL|PASS|Tests:|Test Suites:)\s", s):
                result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))
                in_block = False
                current_name = ""
                current_body = []
            else:
                current_body.append(s)

        if re.match(r"^FAIL\s", s):
            result.summary_lines.append(s)

    if in_block and current_name:
        result.blocks.append(FailureBlock(current_name, "\n".join(current_body)))

    return result


def _extract_go(lines: list[str]) -> FailureResult:
    result = FailureResult(runner="go")
    for line in lines:
        m = _GO_FAIL.match(line.rstrip())
        if m:
            result.blocks.append(FailureBlock(m.group(1), line.rstrip()))
    return result


def _extract_cargo(lines: list[str]) -> FailureResult:
    result = FailureResult(runner="cargo")
    for line in lines:
        s = line.rstrip()
        if _CARGO_FAIL.match(s):
            result.blocks.append(FailureBlock(s, s))
    return result


def _extract_generic(lines: list[str]) -> FailureResult:
    result = FailureResult(runner="unknown")
    for line in lines:
        s = line.rstrip()
        if re.search(r"\b(FAILED|FAILURE|ERROR)\b", s, re.IGNORECASE):
            result.summary_lines.append(s)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def extract_failures(text: str, *, runner: str | None = None) -> FailureResult:
    """Parse test runner output and return only the failing blocks."""
    lines = text.splitlines()
    detected = runner or _detect_runner(text)
    if detected == "pytest":
        return _extract_pytest(lines)
    if detected == "jest":
        return _extract_jest(lines)
    if detected == "go":
        return _extract_go(lines)
    if detected == "cargo":
        return _extract_cargo(lines)
    return _extract_generic(lines)


def format_failures_text(result: FailureResult) -> str:
    if not result.blocks and not result.summary_lines:
        return "No failures found."

    parts: list[str] = []
    sep = "─" * 60

    for block in result.blocks:
        parts += [sep, f"FAIL  {block.name}", sep, block.body, ""]

    if result.summary_lines:
        if parts:
            parts.append(sep)
        parts.extend(result.summary_lines)

    if result.stats_line:
        parts.append(result.stats_line)

    n = result.count
    parts.append(f"\n{n} failure(s)  [{result.runner}]")
    return "\n".join(parts)


def format_failures_json(result: FailureResult) -> str:
    return json.dumps(
        {
            "runner": result.runner,
            "count": result.count,
            "failures": [{"name": b.name, "body": b.body} for b in result.blocks],
            "summary": result.summary_lines,
            "stats": result.stats_line,
        },
        indent=2,
    )
