# Session Mining: 4ad86853

Mined from Copilot CLI session `4ad86853-9bef-4ed9-b289-a38e8e55945e` (session
state: `C:\Users\Gabriel.Grillo\.copilot\session-state\4ad86853-9bef-4ed9-b289-a38e8e55945e`).

Context: this session debugged and extended a persistent-PowerShell-session
project (`persistent-session`), whose `SCRATCH.md` lessons-learned doc grew
across the session to 23+ headings / ~35KB. token-goat's preToolUse hook
correctly denied `view`/`edit` on that file every time (even for a 9-line
`view_range`) and redirected to `token-goat section`/`replace`/`write-file`,
which is exactly the intended surgical-read/write behavior — this is a real
dogfooding data point that the hook fires as designed. Separately, a `view` of
`src/cli.ts` (3350 lines) in this same session got only a postToolUse
*suggestion* to use `skeleton`/`outline`, not a hard deny — worth a deliberate
look at whether that markdown-vs-code asymmetry is intentional (see item 6).

All six `token-goat replace` calls in this session followed the identical
pattern of appending a new subsection immediately before a file's final `---`,
which is the single biggest source of friction found (items 1, 4, 5 below).

## Deferred Improvements

- [ ] Add an anchor-free "insert after a matched section" primitive to avoid
  the exact-byte-anchor staleness trap. Every edit this session was the same
  shape: append a new `## Lesson N+1` subsection right after the current last
  subsection, before the file's trailing `---`. The only way to do this today
  is `replace --old-from/--old-b64` with the *exact current trailing bytes* of
  the previous section as the anchor — which is inherently stale-prone the
  moment two edits land back-to-back (see Bug Fixes below for the concrete
  failure this caused). A command like
  `token-goat insert-section <file> --after "<heading-prefix>" --content-from <file>`
  (insert immediately after a *matched section's own end boundary*, resolved
  the same way `section`/`replace` already resolve headings, rather than by
  reproducing trailing bytes) would remove the staleness window entirely for
  this extremely common "append to a running log" pattern. — `src/cli.ts`
  (`replace`/`section` commands), `src/section_reader.ts`
- [ ] Add an opt-in `--normalize-newlines` (or `--eol=auto`) flag to `replace`
  (and `write-file`) that converts the provided `--old-from`/`--new-from` (or
  b64) text's line endings to match the target file's dominant line ending
  before matching/writing. `cli.ts` already has a diagnostic specifically for
  this exact case (`"a near-match exists that differs only by line endings —
  ... check the exact content"`, `src/cli.ts:1728,1731`) but it's
  diagnostic-only by design. On Windows, an agent's intermediate/anchor text
  defaults to CRLF while the target file (commonly LF, e.g. anything git
  auto-normalizes) does not — this session hit that exact mismatch on its
  *first* `replace` call and had to add a manual PowerShell
  `-replace "\`r\`n","\`n"` conversion step before every single one of the six
  `replace` invocations that followed. An opt-in auto-normalize flag would
  remove that repeated manual step for the common case while leaving the
  current byte-exact behavior as the (safe) default. — `src/cli.ts` (~line
  1712-1780, `cmdReplace`)
- [ ] Add a best-effort fallback diagnostic to `replace` when neither an exact
  match nor a CRLF/trailing-newline near-match is found (today: a bare
  `"old string not found in '<file>'"`, `src/cli.ts:~1712` area). This session
  hit exactly that case once: a `replace` anchor became stale mid-session
  because an earlier `replace` call had already changed the trailing text of
  the section it was anchored to, and the resulting error gave no lead at all
  — forcing a full extra `token-goat section` re-fetch round-trip just to find
  the current correct anchor text. A cheap closest-matching-line-range hint
  (e.g. line-level diff/similarity against the target file) mirroring the
  "Did you mean" pattern `section` already has for unresolvable headings
  (`src/read_commands.ts:280,736`, `didYouMean`) would let the agent
  self-correct in the same turn instead of a second round-trip. — `src/cli.ts`
  `cmdReplace`, possibly reusing `didYouMean`'s approach from
  `read_commands.ts`

## Documentation

- [ ] Surface `section`'s existing normalized-prefix matching in its own
  `--description`/help text and in `--list` output. `section_reader.ts` (~line
  370-422) already resolves an unambiguous heading *prefix* to the full
  heading (e.g. `"Business"` resolving a lone `"Business / logic"` heading),
  which would have let this session reference every long lesson heading (some
  100+ characters, several containing embedded `"quotes"`, colons, and
  parentheticals) as a short unique prefix like `"Lesson 16"` instead of
  retyping the full heading text verbatim on every read. Nothing in
  `section`'s CLI description (`src/cli.ts:2149-2150`,
  `'read one section from a file (spec: file::heading)'`) or in `--list`'s
  output mentions this, so an agent has no reason to discover it and defaults
  to copying full headings — costing real, repeated tokens in tool-call
  arguments across a session, and in this case also directly *causing* a
  crash: the PowerShell invocation of
  `token-goat section "file::Lesson 16: \"the\" PowerShell profile is..."`
  failed because PowerShell's own quoting rules mangled the embedded escaped
  double-quotes before the CLI ever saw them (`Section 'Lesson 16: \' not
  found`). Referencing the same section as `file::Lesson 16` would have
  resolved correctly *and* sidestepped the shell-quoting problem entirely,
  since short prefixes rarely contain punctuation that needs escaping. —
  `src/cli.ts` (`section` command description, ~line 2149), `--list` output
  in `read_commands.ts`
- [ ] Promote `--old-b64`/`--new-b64` as the recommended low-overhead path for
  `replace`, ideally right at the point of friction. This session used
  `--old-from`/`--new-from` for all six `replace` calls, which meant creating
  two throwaway temp files (via a separate file-write step) *per edit*, converting
  each to LF, running `replace`, then deleting both temp files — real,
  repeated tool-call overhead that `--old-b64`/`--new-b64` (inline payload,
  already fully supported, `src/cli.ts:3282-3285`) would have avoided
  completely, since the payload could be produced and passed in a single
  shell command with no intermediate files at all. The only reason it wasn't
  used: it was never mentioned anywhere except incidentally inside an
  unrelated CRLF-mismatch diagnostic string (`src/cli.ts:1728`), so its
  existence as the *preferred* path for agents was never actually surfaced.
  Consider mentioning it in the preToolUse hook's own denial message for
  large markdown files (the message that already tells the agent to use
  `token-goat replace ... --old-from <oldfile> --new-from <newfile>`) — that's
  precisely the moment an agent is deciding how to proceed, and today it
  models the temp-file path as the example, reinforcing the costlier pattern
  by omission. — hook denial-message source (wherever the "Denied by
  preToolUse hook" text for large markdown files is generated — not found
  under `src/` in this pass, likely a separate hook config/script), plus
  `src/cli.ts` `replace`/`write-file` descriptions

## Notes

- Item 6 (markdown-heading-count hard-deny vs. TypeScript-line-count
  soft-suggest asymmetry) is flagged as an observation, not a clear bug — code
  files sometimes have a legitimate reason to need full-file context (e.g. a
  rewrite) that a lessons-learned doc rarely does, so the stricter treatment
  for markdown may well be intentional. Worth a deliberate confirm-or-fix
  decision rather than a blind consistency pass.
- No bugs were found in the *indexing/worker* critical path this session —
  all findings are in the surgical-write (`replace`/`write-file`) and
  surgical-read (`section`) command UX/discoverability layer, not the
  indexer. Nothing here touches `src/parser.ts`/`src/worker.ts`.
