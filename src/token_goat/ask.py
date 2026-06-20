"""Experimental ``token-goat ask`` — out-of-band codebase Q&A.

The idea: instead of pulling raw slices into the *primary* model's scarce context
window and making it read-and-synthesize there, do the retrieve-and-synthesize in
token-goat's own process and return only a short, cited answer.  The primary model
pays for the answer plus pointer-citations, not for the slice bodies.

Design constraints (see ASK-EXPERIMENT-SPEC.md):

* **Degradable / offline-first.** Synthesis is strictly additive.  With no backend
  CLI on PATH, ``ask`` makes no network call at all — it degrades to context-for-style
  read pointers with a one-line notice.  Nothing ever blocks.
* **Cheap by default.** When the ``claude`` CLI (Claude Code) is on PATH, ``ask``
  synthesizes with Haiku — its cheapest tier.  ``codex`` falls back to its own
  configured default model (token-goat can't know its cheapest).  ``--model`` /
  ``TOKEN_GOAT_ASK_MODEL`` override the model and ``TOKEN_GOAT_ASK_CMD`` overrides the
  whole command.  The command itself is hidden (experimental).
* **Verifiable.** Every answer carries deterministic citations generated from the
  retrieved slices (not from the model), and ``--show-sources`` dumps the exact text.
* **Cached across sessions.** Keyed on the question + slice content hashes + backend,
  so a repeated question reuses the stored answer and skips the backend entirely.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import TypedDict

import typer

from . import db
from .project import find_project
from .util import env_int, get_logger

_LOG = get_logger("token_goat.ask")

# Default retrieval budget (tokens of slice text fed to the backend). Smaller than context-for's 20k: ask sends slices to a backend, it does not return them.
DEFAULT_BUDGET = 6_000
DEFAULT_TOP = 8
# Terse-answer guardrails. The prompt asks for <= this many words; the hard cap is a safety net so a chatty backend can never blow the primary window.
DEFAULT_ANSWER_WORDS = 200
MAX_ANSWER_CHARS = 4_000
# Reliability knobs.
DEFAULT_TIMEOUT_SECS = 30
_ENV_MODEL = "TOKEN_GOAT_ASK_MODEL"
_ENV_CMD = "TOKEN_GOAT_ASK_CMD"
_ENV_TIMEOUT = "TOKEN_GOAT_ASK_TIMEOUT_SECS"
# Claude Code's cheapest tier; the default model when ask runs via the claude CLI with no model set. Override with --model / TOKEN_GOAT_ASK_MODEL.
_CLAUDE_CHEAPEST = "claude-haiku-4-5"


# ---------------------------------------------------------------------------
# Token estimation (rough — the CLIs don't reliably report usage via --print)
# ---------------------------------------------------------------------------

def _est_tokens(text: str) -> int:
    """Estimate token count from character length (~4 chars/token). Floor of 1 for non-empty."""
    if not text:
        return 0
    return max(1, len(text) // 4)


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

class Slice:
    """A retrieved code slice: file, line range, content, relevance distance."""

    __slots__ = ("file_rel", "start_line", "end_line", "text", "distance")

    def __init__(self, file_rel: str, start_line: int, end_line: int, text: str, distance: float) -> None:
        self.file_rel = file_rel
        self.start_line = start_line
        self.end_line = end_line
        self.text = text
        self.distance = distance

    def citation(self) -> dict[str, object]:
        """Return the deterministic citation pointer for this slice."""
        return {"file": self.file_rel, "start_line": self.start_line, "end_line": self.end_line}

    def relevance_pct(self) -> int:
        return max(0, int((1.0 - self.distance) * 100))


def retrieve(project_hash_obj: object, question: str, *, scope: str | None, budget: int, top: int) -> list[Slice]:
    """Run semantic search, filter by --scope glob, dedup, and cap to --budget tokens.

    Returns slices ranked by relevance.  Falls back to an empty list (caller emits the
    no-context message) when semantic search is unavailable or finds nothing.
    """
    from . import embeddings as _embeddings

    try:
        raw_hits = _embeddings.semantic_search(
            project_hash_obj,  # type: ignore[arg-type]
            question,
            k=max(top * 3, top),
            max_distance=_embeddings.DEFAULT_DISTANCE_THRESHOLD,
        )
    except Exception as exc:  # embeddings model/extension unavailable
        _LOG.debug("ask retrieval: semantic search unavailable (%s)", exc)
        return []

    slices: list[Slice] = []
    seen: set[tuple[str, int, int]] = set()
    tokens_used = 0
    for h in raw_hits:
        if scope and not _matches_scope(h.file_rel, scope):
            continue
        key = (h.file_rel, h.start_line, h.end_line)
        if key in seen:
            continue
        seen.add(key)
        text = h.text or ""
        est = _est_tokens(text)
        if tokens_used + est > budget and slices:
            break
        tokens_used += est
        slices.append(Slice(h.file_rel, h.start_line, h.end_line, text, h.distance))
        if len(slices) >= top:
            break
    return slices


def _matches_scope(file_rel: str, scope: str) -> bool:
    """Return True if file_rel matches the --scope glob (POSIX-normalized, substring-friendly)."""
    norm = file_rel.replace("\\", "/")
    pat = scope.replace("\\", "/")
    if fnmatch.fnmatch(norm, pat):
        return True
    # A bare directory or stem (no glob metachar) matches as a path substring too, so `--scope hooks` catches `src/token_goat/hooks_edit.py`.
    if not any(c in pat for c in "*?[]"):
        return pat in norm
    return False


# ---------------------------------------------------------------------------
# Cache key
# ---------------------------------------------------------------------------

def _normalize_question(question: str) -> str:
    """Lowercase and collapse whitespace so trivially different phrasings share a cache entry."""
    return " ".join(question.lower().split())


def cache_key(question: str, slices: list[Slice], backend_label: str) -> str:
    """Compute the cross-session cache key: sha256(normalized question + backend + slice hashes).

    Slice content hashes are part of the key, so the entry self-invalidates when any cited
    slice's text changes — no explicit cache-bust step required.
    """
    sig_parts = sorted(
        f"{s.file_rel}:{s.start_line}-{s.end_line}:{hashlib.sha256(s.text.encode('utf-8')).hexdigest()[:16]}"
        for s in slices
    )
    payload = "\x00".join([_normalize_question(question), backend_label, *sig_parts])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class CachedAnswer(TypedDict):
    """A cache_get hit: the stored answer plus its provenance and token estimates."""

    answer: str
    citations: list[dict[str, object]]
    backend: str
    tokens_in: int
    tokens_out: int


def cache_get(project_hash: str, key: str) -> CachedAnswer | None:
    """Return the cached answer row for *key*, or None on miss/error."""
    try:
        with db.open_project_readonly(project_hash) as conn:
            row = conn.execute(
                "SELECT answer, citations, backend, tokens_in, tokens_out FROM ask_cache WHERE cache_key = ?",
                (key,),
            ).fetchone()
    except Exception as exc:
        _LOG.debug("ask cache_get failed: %s", exc)
        return None
    if row is None:
        return None
    try:
        citations = json.loads(row["citations"])
    except (ValueError, TypeError):
        citations = []
    return CachedAnswer(
        answer=str(row["answer"]),
        citations=citations,
        backend=str(row["backend"]),
        tokens_in=int(row["tokens_in"]),
        tokens_out=int(row["tokens_out"]),
    )


def cache_put(
    project_hash: str,
    key: str,
    *,
    question: str,
    answer: str,
    citations: list[dict[str, object]],
    backend_label: str,
    tokens_in: int,
    tokens_out: int,
) -> None:
    """Best-effort store of a synthesized answer. Never raises — a cache miss is harmless."""
    try:
        with db.open_project(project_hash) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO ask_cache "
                "(cache_key, question, answer, citations, backend, tokens_in, tokens_out, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    key,
                    question,
                    answer,
                    json.dumps(citations, separators=(",", ":")),
                    backend_label,
                    tokens_in,
                    tokens_out,
                    int(time.time()),
                ),
            )
    except Exception as exc:
        _LOG.debug("ask cache_put failed: %s", exc)


# ---------------------------------------------------------------------------
# Backend resolution + synthesis
# ---------------------------------------------------------------------------

class Backend:
    """A resolved synthesis backend: a label for the cache key plus an argv to shell out to."""

    __slots__ = ("label", "argv")

    def __init__(self, label: str, argv: list[str]) -> None:
        self.label = label
        self.argv = argv


def resolve_backend(model_override: str | None) -> Backend | None:
    """Resolve the synthesis backend, or None to degrade to slices.

    Resolution order:
      1. ``TOKEN_GOAT_ASK_CMD`` — explicit command (shlex-split); prompt piped via stdin.
      2. ``claude`` on PATH — ``--model`` / ``TOKEN_GOAT_ASK_MODEL`` if set, else Haiku
         (Claude Code's cheapest tier).
      3. ``codex`` on PATH — ``--model`` / ``TOKEN_GOAT_ASK_MODEL`` if set, else codex's
         own configured default model.
      4. None — no CLI on PATH; the caller degrades to read pointers (no network).
    """
    cmd = os.environ.get(_ENV_CMD, "").strip()
    if cmd:
        try:
            argv = shlex.split(cmd, posix=os.name != "nt")
        except ValueError as exc:
            _LOG.warning("TOKEN_GOAT_ASK_CMD parse failed (%s); falling back to naive split", exc)
            argv = cmd.split()
        if argv:
            return Backend(label=f"custom:{argv[0]}", argv=argv)

    model = (model_override or os.environ.get(_ENV_MODEL, "")).strip()

    # Use the full resolved path: on Windows the CLI is a .CMD and subprocess (CreateProcess) cannot launch it from a bare name.
    claude_path = shutil.which("claude")
    if claude_path:
        # Claude Code's cheapest tier is Haiku; default to it when no model is set so ask works out of the box without spending on a premium model.
        chosen = model or _CLAUDE_CHEAPEST
        return Backend(label=f"claude:{chosen}", argv=[claude_path, "--print", "--model", chosen])
    codex_path = shutil.which("codex")
    if codex_path:
        # token-goat can't know codex's cheapest model; with no explicit model, let codex use its own configured default (no --model flag).
        if model:
            return Backend(label=f"codex:{model}", argv=[codex_path, "exec", "--model", model])
        return Backend(label="codex:default", argv=[codex_path, "exec"])
    _LOG.debug("ask: no backend CLI (claude/codex) on PATH; degrading to slices")
    return None


def build_prompt(question: str, slices: list[Slice], *, max_words: int = DEFAULT_ANSWER_WORDS) -> str:
    """Assemble the terse, slices-only synthesis prompt.

    Note: the question and slice text are concatenated into the backend prompt verbatim.
    Use only with codebases and questions you trust — untrusted slice content could try to
    inject instructions to the synthesis backend. Acceptable here because retrieval runs
    over the user's own indexed project, and the answer is always verifiable via citations.
    """
    blocks = []
    for i, s in enumerate(slices, 1):
        blocks.append(f"[{i}] {s.file_rel} L:{s.start_line}-{s.end_line}\n{s.text}")
    slices_block = "\n\n".join(blocks)
    return (
        "You are a precise code assistant. Answer the QUESTION using ONLY the SLICES below.\n"
        f"Be concise: at most {max_words} words. Do not restate the question.\n"
        "If the slices lack the answer, say exactly what is missing. "
        "Refer to slices by their [n] tag when useful.\n\n"
        f"QUESTION:\n{question}\n\n"
        f"SLICES:\n{slices_block}\n\n"
        "ANSWER:"
    )


def synthesize(prompt: str, backend: Backend, *, timeout: int) -> str:
    """Shell out to the backend, returning the answer text. Raises on any failure.

    One retry on failure is handled by the caller (run_ask); this function makes a
    single attempt and surfaces the error so the caller can retry-then-degrade.
    """
    proc = subprocess.run(
        backend.argv,
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"backend exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    answer = (proc.stdout or "").strip()
    if not answer:
        raise RuntimeError("backend returned empty output")
    return answer


def _cap_answer(answer: str) -> str:
    """Hard-truncate an over-long answer so a verbose backend can't blow the primary window."""
    if len(answer) <= MAX_ANSWER_CHARS:
        return answer
    return answer[:MAX_ANSWER_CHARS].rstrip() + "\n… [truncated]"


# ---------------------------------------------------------------------------
# Orchestration + output
# ---------------------------------------------------------------------------

def run_ask(
    question: str,
    *,
    scope: str | None = None,
    budget: int = DEFAULT_BUDGET,
    model: str | None = None,
    json_output: bool = False,
    no_cache: bool = False,
    show_sources: bool = False,
    top: int = DEFAULT_TOP,
) -> None:
    """Entry point for the ``ask`` command. Retrieve → cache → synthesize-or-degrade → emit."""
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected — run from a project directory", err=True)
        raise typer.Exit(1)

    question = question.strip()
    if not question:
        typer.echo("Question cannot be empty", err=True)
        raise typer.Exit(1)

    slices = retrieve(proj, question, scope=scope, budget=budget, top=top)
    if not slices:
        if json_output:
            _emit_json_no_context(question)
        else:
            typer.echo(
                "No relevant indexed context found. "
                "Run `token-goat index --embeddings` to enable semantic search."
            )
        return

    baseline_tokens = sum(_est_tokens(s.text) for s in slices)
    backend = resolve_backend(model)
    backend_label = backend.label if backend else "slices"
    key = cache_key(question, slices, backend_label)

    # Cache hit: return the stored answer — skips the backend entirely.
    if backend is not None and not no_cache:
        cached = cache_get(proj.hash, key)
        if cached is not None:
            _emit_answer(
                question,
                project_hash=proj.hash,
                answer=cached["answer"],
                citations=cached["citations"],
                backend_label=cached["backend"],
                cached=True,
                tokens_in=cached["tokens_in"],
                tokens_out=cached["tokens_out"],
                baseline_tokens=baseline_tokens,
                slices=slices,
                show_sources=show_sources,
                json_output=json_output,
            )
            return

    # Synthesis path (opt-in): try the backend, retry once, then degrade.
    if backend is not None:
        prompt = build_prompt(question, slices)
        timeout = env_int(_ENV_TIMEOUT, DEFAULT_TIMEOUT_SECS, lo=1, hi=600)
        answer = None
        for attempt in (1, 2):
            try:
                answer = _cap_answer(synthesize(prompt, backend, timeout=timeout))
                break
            except Exception as exc:
                _LOG.debug("ask synthesis attempt %d failed: %s", attempt, exc)
        if answer is not None:
            tokens_in = _est_tokens(prompt)
            tokens_out = _est_tokens(answer)
            citations = [s.citation() for s in slices]
            if not no_cache:
                cache_put(
                    proj.hash, key,
                    question=question, answer=answer, citations=citations,
                    backend_label=backend.label, tokens_in=tokens_in, tokens_out=tokens_out,
                )
            _emit_answer(
                question,
                project_hash=proj.hash,
                answer=answer, citations=citations, backend_label=backend.label,
                cached=False, tokens_in=tokens_in, tokens_out=tokens_out,
                baseline_tokens=baseline_tokens, slices=slices,
                show_sources=show_sources, json_output=json_output,
            )
            return

    # Degrade path: no backend CLI on PATH, or synthesis failed. Emit read pointers.
    _emit_degraded(
        question, slices,
        baseline_tokens=baseline_tokens,
        synthesis_attempted=backend is not None,
        show_sources=show_sources,
        json_output=json_output,
    )


def _record_savings(project_hash: str, primary_tokens: int, baseline_tokens: int, backend_label: str) -> None:
    """Record the primary-context tokens saved vs. read-and-synthesize-in-primary."""
    saved = max(0, baseline_tokens - primary_tokens)
    db.record_stat(project_hash, "ask", tokens_saved=saved, detail=backend_label)


def _emit_answer(
    question: str,
    *,
    project_hash: str,
    answer: str,
    citations: list[dict[str, object]],
    backend_label: str,
    cached: bool,
    tokens_in: int,
    tokens_out: int,
    baseline_tokens: int,
    slices: list[Slice],
    show_sources: bool,
    json_output: bool,
) -> None:
    """Emit a synthesized (or cached) answer with deterministic citations + measurement."""
    citation_text = "\n".join(
        f"  [{i}] {c['file']}  L:{c['start_line']}-{c['end_line']}"
        for i, c in enumerate(citations, 1)
    )
    primary_tokens = _est_tokens(answer) + _est_tokens(citation_text)
    saved = max(0, baseline_tokens - primary_tokens)

    _record_savings(project_hash, primary_tokens, baseline_tokens, backend_label)

    if json_output:
        payload: dict[str, object] = {
            "question": question,
            "synthesized": True,
            "cached": cached,
            "backend": backend_label,
            "answer": answer,
            "citations": citations,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "primary_tokens": primary_tokens,
            "baseline_tokens": baseline_tokens,
            "saved_tokens": saved,
        }
        if show_sources:
            payload["sources"] = [
                {**s.citation(), "text": s.text} for s in slices
            ]
        typer.echo(json.dumps(payload, separators=(",", ":")))
        return

    typer.echo(answer)
    if citation_text:
        typer.echo("\nsources:")
        typer.echo(citation_text)
    if show_sources:
        typer.echo("\n--- slices ---")
        for i, s in enumerate(slices, 1):
            typer.echo(f"[{i}] {s.file_rel}  L:{s.start_line}-{s.end_line}")
            typer.echo(s.text)
    typer.echo(
        f"ask: ~{primary_tokens:,} primary tokens · saved ~{saved:,} vs read-and-synthesize "
        f"· backend={backend_label} · cached={'yes' if cached else 'no'}",
        err=True,
    )


def _emit_degraded(
    question: str,
    slices: list[Slice],
    *,
    baseline_tokens: int,
    synthesis_attempted: bool,
    show_sources: bool,
    json_output: bool,
) -> None:
    """Emit context-for-style read pointers when synthesis is unavailable."""
    pointers = [
        {
            "read_cmd": f'token-goat read "{s.file_rel}::{s.start_line}-{s.end_line}"',
            "file": s.file_rel,
            "start_line": s.start_line,
            "end_line": s.end_line,
            "est_tokens": _est_tokens(s.text),
            "relevance_pct": s.relevance_pct(),
        }
        for s in slices
    ]
    notice = (
        "synthesis unavailable; returning slices"
        if synthesis_attempted
        else "no synthesis backend (install the claude or codex CLI, or set TOKEN_GOAT_ASK_CMD); returning slices"
    )

    if json_output:
        payload: dict[str, object] = {
            "question": question,
            "synthesized": False,
            "cached": False,
            "backend": None,
            "answer": None,
            "notice": notice,
            "citations": [s.citation() for s in slices],
            "entries": pointers,
            "baseline_tokens": baseline_tokens,
        }
        if show_sources:
            payload["sources"] = [{**s.citation(), "text": s.text} for s in slices]
        typer.echo(json.dumps(payload, separators=(",", ":")))
        return

    typer.echo(notice)
    for p in pointers:
        typer.echo(f"  {p['read_cmd']}  ~{p['est_tokens']} tok  {p['relevance_pct']}% relevant")
    if show_sources:
        typer.echo("\n--- slices ---")
        for i, s in enumerate(slices, 1):
            typer.echo(f"[{i}] {s.file_rel}  L:{s.start_line}-{s.end_line}")
            typer.echo(s.text)


def _emit_json_no_context(question: str) -> None:
    typer.echo(json.dumps(
        {
            "question": question,
            "synthesized": False,
            "cached": False,
            "backend": None,
            "answer": None,
            "notice": "no relevant indexed context",
            "citations": [],
            "entries": [],
            "baseline_tokens": 0,
        },
        separators=(",", ":"),
    ))
