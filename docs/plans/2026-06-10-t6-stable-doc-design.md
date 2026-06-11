# T6 — Stable-doc compact serving: Design gate verdict

**Date:** 2026-06-10  
**Gate outcome:** DEFER (auto-generation path KILL; explicit-sidecar design deferred to v-next)

---

## Problem

Large reference docs read at session start every session burn 1K–10K tokens per first-read in each new session. T5's baseline now surfaces these by name. Users have no automated mitigation.

The fundamental constraint: cross-session caching cannot reduce these tokens. Each new session has an empty window and genuinely needs the content once. The only real savings come from serving a *smaller version* on first read.

---

## Approaches evaluated

### A — Section-map hint in `pre_read` (no compact)

When `pre_read` fires on a file >5KB with ≥5 indexed sections, inject a structured hint:

> "This file has 12 sections. Section map: [headings]. Use `token-goat section "file::Heading"` for targeted reads."

Token savings on first read: **0%** — the model still reads the full file.  
Behavioral value: shapes the model toward surgical reads on *subsequent* turns in the same session.  
Quality risk: none.  
Infra cost: ~20 lines in `hints.py`, zero new state.

**Verdict: worth doing as a standalone micro-improvement, not as T6.**

### B — Extractive compact (headings + first sentence per section)

Intercept reads of known-stable docs and serve headings + first-sentence-of-each-section (~15–20% of original size). Deterministic, no LLM.

**Killed.** The failure mode is silent and costly: for the highest-value docs (API references, dense style guides, canon worldbuilding files), section headings are the least predictive of whether they contain the answer. The model requests full content after reading the compact — paying compact tokens *plus* full tokens instead of just full tokens. This failure is unmeasurable from the outside. The plan's own caution ("for creative-writing canon, lossy summaries may be unacceptable") already anticipates it; section-map-only mode produces no real savings on first read; and the extractive case fails silently at exactly the docs users care most about.

### C — Explicit user-authored sidecar compacts (deferred design)

`token-goat compact-doc "path"` CLI command: user runs it once, gets an LLM-assisted draft they can edit, stored as `.tokengoat/compacts/<hash-or-slug>.compact.md`. `pre_read` serves the sidecar when it exists; no auto-generation, no frequency tracking, no quality risk.

Token savings: **85–95%** when a sidecar exists (user-controlled quality).  
Quality risk: none — user authored or approved it.  
Infra cost: medium (CLI command + one `pre_read` branch + invalidation hook).  
Activation gate: user demand surfaces via baseline report; `compact-doc` CLI gives users the tool to act on that motivation.

**Not killed — deferred.** This is the correct design. It's small, safe, and has zero quality risk. It should be implemented when user demand surfaces, not preemptively.

---

## Savings estimate against named top files

From the audit's 42.7M cross-session pattern (large stable reference .md files re-read every session in writing-heavy projects):

| Scenario | Per-session cost | With sidecar compact | Savings |
|---|---|---|---|
| 50KB vendor API reference | ~12,500 tokens | ~1,500 tokens (12% compact) | ~11,000 tokens/session |
| 30KB style guide | ~7,500 tokens | ~900 tokens | ~6,600 tokens/session |
| 15KB worldbuilding canon | ~3,750 tokens | ~450 tokens | ~3,300 tokens/session |

These savings are real — *when the user has authored a compact*. Without the compact, savings are zero. The explicit-sidecar design is honest about this: it saves tokens only when the user decided savings were worthwhile and quality was acceptable.

---

## Why not BUILD now

1. **Auto-generation without LLM is lossy in the cases that matter most.** Extractive compacts fail silently on the exact doc types (dense reference material, narrative canon) where users need accurate content most.

2. **Cross-session frequency tracking is new indexer state** — a counter that must be initialized, migrated, invalidated via the dirty queue, and kept consistent across the Windows/WSL dual-worker pattern. Nontrivial blast radius for a speculative feature.

3. **The escape mechanism is an unsolved UX design problem.** If Claude is silently served a compact and needs the full doc, how does it signal that? How does the user know a compact was served? Shipping the compact-serving protocol without solving this creates a confusing UX that's hard to change once users rely on it (soft one-way door).

4. **The null option is not weak.** T5's baseline now names expensive docs. Users can act today: author a compact manually, use `token-goat section` surgically, or restructure session workflow. The problem is visible; the mitigation tools exist.

---

## Deferred design spec (implement in v-next on user demand)

### CLI: `token-goat compact-doc <path>`

- Reads the file
- Offers two modes: `--extractive` (headings + first sentence, no LLM) and `--llm` (LLM-assisted summary, requires API key)
- Writes sidecar to `.tokengoat/compacts/<normalized-name>.compact.md`
- Prints token estimate: "Compact is 1,240 tokens (11% of original 11,200 tokens)"

### `pre_read` integration

- New branch: check for `.tokengoat/compacts/<name>.compact.md` before emitting existing hints
- If sidecar exists and is fresh (source hash matches header in sidecar): serve compact + section map + escape instruction: `"[COMPACT] Full content available: token-goat read \"path\" --full"`
- If sidecar is stale (source hash mismatch): emit warning hint: `"Compact sidecar may be stale — source doc changed. Re-run: token-goat compact-doc \"path\""`

### Invalidation

- `invalidate_for_path` (already exists in `skill_cache.py`) extended to check `.tokengoat/compacts/` — marks sidecar stale on source edit.
- Sidecar is not deleted on staleness; user re-runs `compact-doc` to refresh.

### Config

```toml
[hints]
stable_doc_compacts = true   # default true; serves sidecar compacts when present
```

Per-doc opt-out: prefix the sidecar with `# token-goat: no-compact` to disable serving for that file.

---

## Immediate micro-improvement (outside T6, file separately)

Add structured section-map hint in `hints.py` for files >5KB with ≥5 indexed sections. ~20 lines, no new state, zero quality risk. Guides the model toward surgical reads on subsequent turns in the same session. This is Idea A from the brainstorming arc — worth doing as a drive-by when touching `hints.py` next.

---

## Summary

| Decision | Scope |
|---|---|
| KILL | Auto-extractive compact serving (B) — silent quality failures |
| DEFER | Full T6 explicit-sidecar design (C) — correct design, wrong time |
| QUICK WIN | Section-map hint in `hints.py` (A) — drive-by improvement, file as separate task |
