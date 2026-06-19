"""Condense exception tracebacks to actionable project-owned frames."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Patterns identifying non-project (library / stdlib) frame paths
# ---------------------------------------------------------------------------

_LIB_MARKERS = (
    "site-packages",
    "dist-packages",
    "_frozen_importlib",
    "importlib._bootstrap",
    "<frozen ",
)

# Platform path segments that indicate stdlib on common installs
_STDLIB_SEGMENTS = (
    r"[\\/]Python\d*[\\/]Lib[\\/]",
    r"[\\/]python\d+\.\d+[\\/]",
    r"[\\/]usr[\\/]lib[\\/]python",
    r"[\\/]\.tox[\\/]",
)
_STDLIB_RE = re.compile("|".join(_STDLIB_SEGMENTS), re.IGNORECASE)

_FRAME_FILE = re.compile(r'^\s+File "(.+)", line (\d+), in (.+)$')
_CAUSE_RE = re.compile(
    r"^(?:The above exception was the direct cause|During handling of the above exception)"
)
_EXCEPTION_RE = re.compile(r"^(\w[\w.]*Error|[\w.]*Exception|[\w.]*Warning|KeyboardInterrupt|SystemExit|BaseException)(?::.*)?$")


@dataclass
class TraceFrame:
    path: str
    lineno: int
    context: str
    code_line: str = ""
    is_project: bool = True


@dataclass
class TraceBlock:
    """One exception + its frames (represents one level of a chained trace)."""

    exception_type: str = ""
    exception_msg: str = ""
    frames: list[TraceFrame] = field(default_factory=list)
    cause_note: str = ""


@dataclass
class TraceResult:
    blocks: list[TraceBlock] = field(default_factory=list)
    kept_frames: int = 0
    total_frames: int = 0


# ---------------------------------------------------------------------------
# Frame classification
# ---------------------------------------------------------------------------


def _is_library(path: str) -> bool:
    p = path.lower()
    if any(m in p for m in _LIB_MARKERS):
        return True
    return bool(_STDLIB_RE.search(path))


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def _parse_python_trace(lines: list[str], keep_frames: int) -> TraceResult:
    result = TraceResult()
    blocks: list[TraceBlock] = []
    current = TraceBlock()
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()

        if stripped == "Traceback (most recent call last):":
            if current.frames or current.exception_type:
                blocks.append(current)
            current = TraceBlock()
            i += 1
            continue

        m_cause = _CAUSE_RE.match(stripped)
        if m_cause:
            current.cause_note = stripped
            i += 1
            continue

        m_frame = _FRAME_FILE.match(line)
        if m_frame:
            path, lineno_s, ctx = m_frame.group(1), m_frame.group(2), m_frame.group(3)
            is_proj = not _is_library(path)
            frame = TraceFrame(path=path, lineno=int(lineno_s), context=ctx, is_project=is_proj)
            # Next line may be the executed code
            if i + 1 < len(lines) and not _FRAME_FILE.match(lines[i + 1]) and not _EXCEPTION_RE.match(lines[i + 1]):
                frame.code_line = lines[i + 1].strip()
                i += 2
            else:
                i += 1
            current.frames.append(frame)
            result.total_frames += 1
            continue

        # Exception line (possibly multi-line message)
        if _EXCEPTION_RE.match(stripped):
            parts = stripped.split(":", 1)
            current.exception_type = parts[0].strip()
            current.exception_msg = parts[1].strip() if len(parts) > 1 else ""
            i += 1
            # Consume continuation lines; stop before any frame line
            while i < len(lines) and lines[i].startswith(" ") and not _FRAME_FILE.match(lines[i]):
                current.exception_msg += " " + lines[i].strip()
                i += 1
            continue

        i += 1

    if current.frames or current.exception_type:
        blocks.append(current)

    # Filter frames: keep project frames + last `keep_frames` overall
    for block in blocks:
        project_frames = [f for f in block.frames if f.is_project]
        if not project_frames and block.frames:
            # No project frames at all — keep the last keep_frames
            project_frames = block.frames[-keep_frames:]
        elif len(project_frames) > keep_frames:
            project_frames = project_frames[-keep_frames:]
        result.kept_frames += len(project_frames)
        block.frames = project_frames

    result.blocks = blocks
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def condense_trace(text: str, *, keep_frames: int = 5) -> TraceResult:
    """Strip library frames from an exception traceback, keeping project-owned frames."""
    return _parse_python_trace(text.splitlines(), keep_frames)


def format_trace_text(result: TraceResult) -> str:
    if not result.blocks:
        return "No traceback found."

    parts: list[str] = []
    hidden = result.total_frames - result.kept_frames

    for i, block in enumerate(result.blocks):
        if block.cause_note:
            parts.append(f"\n{block.cause_note}")

        frame_note = f"{len(block.frames)} of {result.total_frames} frame(s)"
        if hidden > 0 and i == 0:
            frame_note += f"; {hidden} library frame(s) hidden"
        parts.append(f"Traceback (condensed — {frame_note}):")

        for f in block.frames:
            parts.append(f'  File "{f.path}", line {f.lineno}, in {f.context}')
            if f.code_line:
                parts.append(f"    {f.code_line}")

        if block.exception_type:
            exc = f"{block.exception_type}: {block.exception_msg}" if block.exception_msg else block.exception_type
            parts.append(exc)

    return "\n".join(parts)


def format_trace_json(result: TraceResult) -> str:
    return json.dumps(
        {
            "total_frames": result.total_frames,
            "kept_frames": result.kept_frames,
            "blocks": [
                {
                    "exception": f"{b.exception_type}: {b.exception_msg}" if b.exception_msg else b.exception_type,
                    "cause_note": b.cause_note,
                    "frames": [
                        {
                            "path": f.path,
                            "line": f.lineno,
                            "context": f.context,
                            "code": f.code_line,
                        }
                        for f in b.frames
                    ],
                }
                for b in result.blocks
            ],
        },
        indent=2,
    )
