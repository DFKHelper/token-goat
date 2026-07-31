/**
 * Shared guidance-block builder for every harness that gets a token-goat
 * routing block written into its instructions file (Claude Code's CLAUDE.md,
 * Codex's AGENTS.md, Copilot CLI's copilot-instructions.md).
 *
 * There used to be three hand-maintained copies of this text -- one per call
 * site -- and they drifted: the CLAUDE.md and AGENTS.md blocks differed, and a
 * user's hand-written Copilot block differed from both. Factoring the wording
 * here makes drift impossible: every call site renders the same body, and only
 * the two things that legitimately differ per harness are parameters -- the
 * begin/end markers and the one clause that names *that harness's own* read
 * tools when resolving the conflict with its built-in tool-preference rules.
 *
 * Design intent (why this reads as a gate, not a tip): an advisory "prefer
 * token-goat" line loses to a harness's imperative tool-preference rule that
 * fires at the exact moment a read happens. This block is therefore phrased as
 * a pre-call gate with an exhaustive exemption list (so it is decidable, not a
 * judgment call) and concrete failure shapes (recognizable shapes beat abstract
 * rules), and it explicitly subordinates the harness's own read-tool rules to
 * the fallback decision rather than the whether-to-check decision.
 */

/** One harness's parameters for {@link buildGuidanceBlock}. */
export interface GuidanceHarness {
  /** Opening HTML-comment marker, e.g. `<!-- token-goat-begin -->`. */
  readonly beginMarker: string
  /** Closing HTML-comment marker, e.g. `<!-- token-goat-end -->`. */
  readonly endMarker: string
  /**
   * Names this harness's own read tools for the conflict-resolution clause, e.g.
   * "Claude Code's own Read, Grep, and Glob preference rules". Rendered inline
   * after "Your harness's own read-tool rules (…)".
   */
  readonly fallbackToolClause: string
}

/**
 * Render the shared token-goat routing gate *body* — the guidance itself,
 * without any delimited-block markers. This is the single source of the gate
 * wording used by all four surfaces:
 *   - `buildGuidanceBlock` wraps it in begin/end markers for the three files
 *     upserted into user-owned instruction files (CLAUDE.md, AGENTS.md,
 *     copilot-instructions.md);
 *   - the SKILL.md writer in `../install.ts` embeds it whole, under its own
 *     frontmatter, because a skill file is written as a complete standalone
 *     document rather than patched into a delimited region.
 *
 * `fallbackToolClause` names the surface's own read tools for the
 * conflict-resolution clause, e.g. "Claude Code's own Read, Grep, and Glob
 * preference rules".
 */
export function buildGuidanceBody(fallbackToolClause: string): string {
  return [
    '## token-goat',
    '',
    '**Gate — before every file read, answer one question first: is there a token-goat command that returns just what I need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an oversight. The gate is per file: batched or parallel reads do not exempt it.',
    '',
    `This gate decides *whether* to reach for a read tool at all. ${fallbackToolClause} only pick the *fallback* once token-goat has been ruled out for this read — they never authorize skipping the gate.`,
    '',
    'Exemptions (gate passes, read directly): the file is under ~200 lines and you need all of it; it was never indexed (new, untracked, or generated this turn); it is binary or an image; the target has no symbol handle (e.g. a literal mid-function).',
    '',
    'Failure shapes to catch yourself in, and the command that replaces each:',
    '- grep/search with context flags to find a function body → `read "file::symbol"`',
    '- paging one function with view/view_range → `read "file::symbol"`',
    '- reading one heading of a large doc → `section "file::Heading"`',
    "- searching for a symbol's callers → `refs file::symbol --callers`",
    '- searching for a *concept* rather than a literal string → `semantic "description"`',
    '- re-reading output you already captured → `bash-output`/`web-output` by ID',
    '- `glob`/`ls **/*` to orient in an unfamiliar repo → `map --compact`',
    '',
    'Commands: `symbol NAME`, `read "file::symbol"`, `section "file::Heading"`, `semantic "description"`, `outline file`/`skeleton file`, `map --compact`, `refs file::symbol --callers`, `changed --symbol`, `config-get file KEY`, `bash-output`/`web-output`, `gdrive-sections <file-id>`.',
    '',
    'Sub-agent briefs must carry this gate verbatim: a sub-agent inherits none of this context and its reads spend the same token budget.',
    '',
    '`token-goat stats` — self-check. Flat counts during code work mean the gate is being skipped.',
  ].join('\n')
}

/**
 * Render the shared token-goat routing gate for one harness, wrapped in the
 * harness's begin/end markers. The body is identical across harnesses (see
 * {@link buildGuidanceBody}); only the markers and the fallback-tool clause
 * vary. Returned as a single string ready to hand to `upsertDelimitedBlock`.
 */
export function buildGuidanceBlock(h: GuidanceHarness): string {
  return [h.beginMarker, buildGuidanceBody(h.fallbackToolClause), h.endMarker].join('\n')
}
