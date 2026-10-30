/** Shared guidance-block builder for every harness that gets a token-goat routing block written into its instructions file (Claude Code's CLAUDE.md, Codex's AGENTS.md, Copilot CLI's copilot-instructions.md). There used to be three hand-maintained copies of this text -- one per call site -- and they drifted: the CLAUDE.md and AGENTS.md blocks differed, and a user's hand-written Copilot block differed from both. Factoring the wording here makes drift impossible: every call site renders the same body, and only the two things that legitimately differ per harness are parameters -- the begin/end markers and the one clause that names *that harness's own* read tools when resolving the conflict with its built-in tool-preference rules. Design intent (why this reads as a gate, not a tip): an advisory "prefer token-goat" line loses to a harness's imperative tool-preference rule that fires at the exact moment a read happens. This block is therefore phrased as a pre-call gate with an exhaustive exemption list (so it is decidable, not a judgment call) and concrete failure shapes (recognizable shapes beat abstract rules), and it explicitly subordinates the harness's own read-tool rules to the fallback decision rather than the whether-to-check decision. */

/** One harness's parameters for {@link buildGuidanceBlock}. */
export interface GuidanceHarness {
  /** Opening HTML-comment marker, e.g. `<!-- token-goat-begin -->`. */
  readonly beginMarker: string
  /** Closing HTML-comment marker, e.g. `<!-- token-goat-end -->`. */
  readonly endMarker: string
  /** Names this harness's own read tools for the conflict-resolution clause, e.g. "Claude Code's own Read, Grep, and Glob preference rules". Rendered inline after "Your harness's own read-tool rules (…)". */
  readonly fallbackToolClause: string
  /** See {@link GuidanceOptions.gdrive}. */
  readonly gdrive?: boolean
}

/** Per-install switches that change which commands the gate advertises. */
export interface GuidanceOptions {
  /** Whether to name `gdrive-sections` in the `Commands:` line. False when an operator has set `gdrive.enabled = false`, which refuses the command outright: advertising a command the install will refuse teaches an agent to reach for a dead end, and an organisation that does not use Google Drive asked not to see the integration at all. Defaults to true. */
  readonly gdrive?: boolean
}

/** Render the shared token-goat routing gate *body* — the guidance itself, without any delimited-block markers. This is the single source of the gate wording used by all four surfaces: - `buildGuidanceBlock` wraps it in begin/end markers for the three files upserted into user-owned instruction files (CLAUDE.md, AGENTS.md, copilot-instructions.md); - the SKILL.md writer in `../install.ts` embeds it whole, under its own frontmatter, because a skill file is written as a complete standalone document rather than patched into a delimited region. `fallbackToolClause` names the surface's own read tools for the conflict-resolution clause, e.g. "Claude Code's own Read, Grep, and Glob preference rules". The sentence about shell binaries and tool identifiers is a shortened form of an older paragraph, kept because instruction-file loaders harvest names into a tool allowlist and warn on each unknown one; it names no tool or binary itself, and the body is byte-budgeted by tests/guards/always_on_payload_budgets.test.ts. */
export function buildGuidanceBody(fallbackToolClause: string, opts: GuidanceOptions = {}): string {
  const gdrive = opts.gdrive !== false
  return [
    '## token-goat',
    '',
    '**Gate — before every file read, answer one question first: is there a token-goat command that returns just what I need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an oversight. The gate is per file: batched or parallel reads do not exempt it.',
    '',
    `This gate decides *whether* to reach for a read tool at all. ${fallbackToolClause} only pick the *fallback* once token-goat has been ruled out for this read — they never authorize skipping the gate.`,
    '',
    "Shell binaries and editor programs are commands run through the shell tool, never tool identifiers: keep them out of an agent's tools and allowed-tools lists, where loaders harvest the names and warn that each is unknown.",
    '',
    'Exemptions (gate passes, read directly): file under ~200 lines (`tokens <file>`) and need all of it; unindexed (new/untracked); opaque binary (not image); target has no symbol handle.',
    '',
    'Failure shapes to catch yourself in, and the command that replaces each:',
    '- not knowing which command answers a question you can already state in words → `answer "<question>"`, which runs the right command and refuses rather than guess',
    '- a shell text search with context flags to find a function body → `read "file::symbol"`',
    '- paging a function/file or receiving a `[tg]` range denial → stop range reads; run its exact command, `read "file::symbol"` for a definition, `read "file@start-end"` for a window, `skeleton file` for structure, or `grep "<pattern>" file -C 15 --symbol` for an excerpt',
    '- reading a symbol plus chasing its callers and containing doc section as separate reads → `brief "file::symbol"`',
    '- reading one heading of a large doc → `section "file::Heading"`',
    "- searching for a symbol's callers → `refs file::symbol --callers`",
    '- searching across symbols, headings, text, and concepts concurrently → `search "<query>"`',
    '- searching for a *concept* rather than a literal string → `semantic "description"`',
    '- re-reading output you already captured → `bash-output`/`web-output`/`mcp-output` by ID',
    '- a directory listing or recursive wildcard walk to orient in an unfamiliar repo → `map --compact`',
    "- pulling one value or subtree out of a JSON/YAML/XML file (manifest, lockfile, spec, config) → `json-query file 'a.b.c'` / `yaml-query file 'a.b.c'` / `xml-query file 'a.b.c'`",
    '- opening an image for dimensions/format/size → `image-meta file`',
    '- opening a screenshot, diagram, or scan to read the text in it → `image-text file`',
    '- running tests immediately on edited code without fast static validation → run language validator first (e.g. `ruff check --select F821 <file>`, `node --check`, `tsc --noEmit`) to catch missing imports and syntax errors before test execution',
    '- checking file size/lines before reading → `tokens <file>`',
    '- passing concatenated or unquoted paths to shell tools → verify whitespace and argument separation in multi-path commands (e.g. `git add path1 path2`, never `git add path1path2`)',
    '',
    'Commands: `symbol NAME`, `tokens <file>`, `outline <file>`, `changed --symbol`, `config-get file KEY`, `json-outline`/`yaml-outline`/`xml-outline`, ' +
      (gdrive ? '`gdrive-sections <file-id>`, ' : '') +
      'and `token-goat --help` for the rest.',
    '',
    'Sub-agent briefs must carry this gate verbatim: a sub-agent inherits none of this context and its reads spend the same token budget.',
    '',
    '`token-goat stats` — self-check. Flat counts during code work mean the gate is being skipped.',
  ].join('\n')
}

/** The `description:` frontmatter line of the Kimi Code skill (`kimiSkillContent` in ./kimi_install.ts). The Claude Code skill does not use it: that one is CANONICAL_SKILL_MD verbatim (../canonical_skill.ts), with a shorter description that opens with the same routing pitch. It is the relevance trigger a harness reads to decide *whether to load the skill at all*, so it is DELIBERATELY exempt from the gate wording {@link buildGuidanceBody} renders: it must stay a plain, keyword-dense one-liner. Do NOT "fix" it into the gate phrasing for consistency with the body -- that degrades skill-loading recall for no benefit. Returned without the trailing newline so each caller can place it. */
export function skillDescriptionLine(gdrive: boolean): string {
  return `description: Use before reading whole files or grepping wide. token-goat commands (symbol, read, section, semantic, outline, skeleton, map, refs, changed, config-get, bash-output, web-output${gdrive ? ', gdrive-sections' : ''}) return narrow slices of code and docs at a fraction of the token cost.`
}

/** Render the shared token-goat routing gate for one harness, wrapped in the harness's begin/end markers. The body is identical across harnesses (see {@link buildGuidanceBody}); only the markers and the fallback-tool clause vary. Returned as a single string ready to hand to `upsertDelimitedBlock`. */
export function buildGuidanceBlock(h: GuidanceHarness): string {
  return [h.beginMarker, buildGuidanceBody(h.fallbackToolClause, h.gdrive === undefined ? {} : { gdrive: h.gdrive }), h.endMarker].join('\n')
}
