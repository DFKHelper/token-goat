import {
  displaySafeJson,
  displaySafeText,
  resolveIndexPath,
  toDisplayPath,
} from './paths.js'
import {
  compileGrepMatcher,
  countNoun,
  excludeTestsHiddenNote,
  grepFilteredToEmptyNotice,
  isTestFile,
} from './util.js'
import {
  buildContextWindow,
  renderContextWindow,
} from './util_context.js'
import { resolveCallers, type CallerEntry } from './graph_commands.js'
import { resolveProjectRoot } from './project.js'
import { globalDbPath } from './constants.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import { findContainingSection, type SectionResult } from './section_reader.js'
import { formatSymbolLocation } from './indexed_source.js'
import type { SymbolEntry } from './parser_types.js'
import {
  emit,
  emitErr,
  fileIsGone,
  findSpecSeparator,
  formatAmbiguity,
  formatBareNameSpecError,
  guardText,
  parseCrossFileMultiSpec,
  parseReadSpec,
  readFileText,
  recordReadStat,
  resolveBody,
  resolveSymbolSpec,
  staleWarning,
  sumFileSizes,
  trimBlankLines,
} from './read_commands.js'

export interface BriefOptions {
  spec: string
  limit?: number
  json?: boolean
  /**
   * Project root to scope symbol resolution and relative-path resolution to. Defaults to
   * `process.cwd()`; same field name as {@link ReadOptions.projectRoot}. Callers whose cwd is not
   * the workspace root (e.g. an MCP server launched from an opaque directory) should pass the
   * actual workspace root explicitly -- otherwise a relative file spec resolves against the wrong
   * project, and the display paths in the rendered output name a root the caller never asked for.
   */
  projectRoot?: string
  /** `-C, --context <n>`: lines of real call-site source around each entry of the caller block, in `grep -C`'s framing. Defaults to 0 (output unchanged). */
  context?: number
  /** `--exclude-tests`: drop callers whose call SITE is in a test file, matching `refs`/`callers` (which filter the call site) rather than `dead`/`symbol` (which filter the definition). Opt-in; output is byte-identical when omitted. */
  excludeTests?: boolean
  /** `--grep <pattern>`: only show callers whose enclosing caller NAME matches this regex (literal substring if it does not compile) -- narrows a high-fanout symbol's caller block the same way `refs --grep`/`call-chain --grep` narrow theirs, so a symbol with hundreds of callers doesn't need a separate `refs` round-trip just to find the ones that matter. Opt-in; output is byte-identical when omitted. */
  grep?: string
  /** Internal only -- set by {@link runBriefMulti} on each per-symbol recursive `runBriefCore` call so the single-symbol path skips its own `recordReadStat`, same convention as {@link ReadOptions.suppressStat} for `runReadMulti`. Not a CLI/MCP-facing option. */
  suppressStat?: boolean
}

export interface BriefResult {
  symbol: SymbolEntry
  callers: CallerEntry[]
  totalCallers: number
  truncated: boolean
  /** How many callers `--exclude-tests` dropped. Omitted entirely when the flag is off or hid nothing, so default output stays byte-identical; present and non-zero it explains a `totalCallers` that would otherwise look inconsistent with an unfiltered `refs` count. */
  hiddenByExcludeTests?: number
  /** How many (post `--exclude-tests`) callers `--grep` dropped. Same omit-when-zero convention as {@link hiddenByExcludeTests}. */
  hiddenByGrep?: number
  /** Present and `true` only when the resolved symbol's file is no longer on disk, mirroring `runRead`'s json branch -- omitted for a live file so existing output keeps its shape. */
  deleted?: boolean
  section: SectionResult | null
}

/** Core of ``token-goat brief "file::symbol"``: bundles the symbol body, its resolved callers (enclosing-function-aware, via graph_commands.ts's real caller-resolution logic), and its containing doc section (if the file has heading structure) into one response -- cutting the common "understand this function" pattern from 2-3 round-trips to 1. Returns text+code instead of emitting directly so {@link runBrief} can both dispatch to {@link runBriefMulti} for a comma-separated spec and reuse this exact single-symbol path for each sub-call, mirroring runRead/runSection's core-vs-dispatcher split. Note that --limit validation deliberately lives in {@link runBrief}, not here: it is a whole-invocation flag, so validating per sub-call would repeat one usage error once per symbol and frame it as a per-symbol resolution failure. */
export function runBriefCore(opts: BriefOptions): { text: string; code: number } {
  const resolution = resolveSymbolSpec(opts.spec, undefined, opts.projectRoot)
  if (resolution.kind === 'confined') return { text: resolution.message, code: 1 }
  if (resolution.kind === 'ambiguous') {
    return {
      // Name the command explicitly: formatAmbiguity defaults to 'read', so brief's retry lines would otherwise tell the user to run `token-goat read`, which answers a different question than the one they asked.
      text: formatAmbiguity(
        resolution.symbol,
        resolution.file,
        resolution.candidates,
        opts.projectRoot,
        'brief',
      ),
      code: 1,
    }
  }
  if (resolution.kind === 'none') {
    // A bare name (no `::` at all) is a spec-format mistake, not evidence the symbol is
    // missing -- see formatBareNameSpecError. A proper `file::symbol` spec that genuinely
    // resolves to nothing keeps the original wording below, untouched.
    if (findSpecSeparator(opts.spec) === -1) {
      return { text: formatBareNameSpecError('brief', opts.spec, opts.projectRoot), code: 1 }
    }
    // Only paid after the query already came back empty, and only in text mode -- this branch's
    // text is emitted verbatim via emitErr regardless of --json (no separate opts.json check
    // exists in runBrief's caller for this path), so there's no JSON envelope to protect either
    // way.
    if (opts.json !== true) {
      const rootDir = resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() })
      if (isIndexEmptyForProject(globalDbPath(), rootDir)) {
        return { text: `Symbol not found: ${opts.spec}\n${emptyIndexMessage(rootDir)}`, code: 1 }
      }
    }
    return { text: `Symbol not found: ${opts.spec}`, code: 1 }
  }
  const match = resolution.entry

  // resolveCallers(name) with no explicit limit still applies its own internal default cap (500, in graph_commands.ts's queryRefs call) -- so a capped callers.length is not the true count once more than 500 references exist. The earlier fix for that took the total from a separate COUNT(*) query (queryRefCounts), but queryRefCounts keys by symbol NAME project-wide while resolveCallers additionally scopes to THIS definition site (filterRefsForSymbol drops refs living in a file that defines its own same-named symbol), so for a name defined in two files brief printed the other definition's callers into its own "Callers (N)" header and invented an "...(N more elided)" tail for rows that were never going to be listed. The scoped scan is the only thing that knows the real total, so it always runs unbounded here and its post-filter length is the total.
  const rootDir = resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() })
  const excludeTests = opts.excludeTests === true
  // The unbounded scan also covers --grep and --exclude-tests, which both filter client-side below -- otherwise a high-fanout symbol's grep match could hide inside the callers that fell past resolveCallers' 500-row default page before the filter ever ran.
  // resolveCallers' last argument makes it scan unbounded instead of stopping at its 500 default, but it does NOT filter -- like runCallers, the test-file drop happens here, on the call SITE (c.file), so a production symbol exercised mostly by tests still yields a full page of real callers rather than whatever survived a pre-filter cap. rootDir is threaded in for the same reason runCallers threads it: it is already resolved, and resolveCallers would otherwise shell out to git a second time for the identical value.
  const allCallers = resolveCallers(match.name, undefined, match.filePath, rootDir, true)
  const testFiltered = excludeTests ? allCallers.filter((c) => !isTestFile(c.file)) : allCallers
  const hiddenByExcludeTests = excludeTests ? allCallers.length - testFiltered.length : 0
  // --grep narrows by the caller's enclosing symbol NAME, same field/convention as
  // runCallers'/call-chain's own --grep -- runs after the exclude-tests drop so both filters
  // compose (grep sees the already test-filtered set, matching runCallers' ordering).
  const preGrepCount = testFiltered.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const callers = matchesGrep !== undefined ? testFiltered.filter((c) => matchesGrep(c.caller)) : testFiltered
  const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - callers.length : 0
  // The unbounded scan above IS the complete in-project, definition-scoped set, so its post-filter length is the true total: it counts exactly the rows that can appear in the list below, which is what the "Callers (N)" header and the "...(N more elided)" tail both describe.
  const totalCallers = callers.length
  const section = findContainingSection(match.filePath, match.lineStart, match.lineEnd, readFileText)
  const limit = opts.limit ?? 20
  const shown = callers.slice(0, limit)
  const truncated = totalCallers > shown.length
  // brief carries a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry (brief_view),
  // but nothing here ever called recordStat -- the brief bucket in `token-goat stats --full`
  // stayed permanently zero regardless of real usage, the same class of registry/producer
  // desync previously fixed for map_lookup/changed_lookup/csv_query (see
  // project_runchanged_missing_stat memory). "Full source" is the on-disk size of the file the
  // resolved symbol lives in, mirroring recordReadStat's fullSourceBytes convention elsewhere in
  // this file -- brief folds a symbol read + callers lookup + section lookup into that one file.
  const fullSourceBytes = sumFileSizes([match.filePath])

  if (opts.json === true) {
    // callers' contextLines attached first (buildContextWindow reads real source off disk and needs the raw absolute `c.file`), THEN both symbol.filePath and callers[].file rewritten to the same root-relative spelling the text block above renders (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing.
    const callersWithContext = (opts.context ?? 0) > 0
      ? shown.map((c) => ({ ...c, contextLines: buildContextWindow(c.file, c.line, opts.context ?? 0) ?? [] }))
      : shown
    const result: BriefResult = {
      symbol: { ...match, filePath: toDisplayPath(rootDir, match.filePath) },
      callers: callersWithContext.map((c) => ({ ...c, file: toDisplayPath(rootDir, c.file) })),
      totalCallers,
      truncated,
      ...(hiddenByExcludeTests > 0 ? { hiddenByExcludeTests } : {}),
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      // Mirrors runRead's json branch: emitting the row verbatim would hand a JSON consumer a deleted file's stale body with no signal it is no longer live.
      ...(fileIsGone(match.filePath) ? { deleted: true } : {}),
      section,
    }
    const jsonText = displaySafeJson(result)
    if (opts.suppressStat !== true) recordReadStat('brief_view', fullSourceBytes, jsonText, opts.spec)
    return { text: jsonText, code: 0 }
  }

  const body = resolveBody(match)
  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    // This header is token-goat's own line quoting a repo-chosen name, kind and path, so it is escaped. `body` below it is the source the reader asked for and stays byte-for-byte.
    `# ${displaySafeText(match.name)}  ${displaySafeText(match.kind)}  ${formatSymbolLocation(displaySafeText(toDisplayPath(rootDir, match.filePath)), match.lineStart, match.lineEnd)}`,
    `# ${countNoun(bodyLen, 'line')} (~${Math.ceil(body.length / 4)} tok)`,
    body,
    '',
  ]

  // Same staleWarning/healStaleIndex pair every other single-file surgical-read command runs (resolveSymbolSpec above already heals a stale-but-reparseable file in place; this is the same trailing check runRead makes to catch what healing could not fix -- most visibly a deleted file, which healStaleIndex leaves untouched).
  const warning = staleWarning(match.filePath)

  // An empty caller block reads as "nothing calls this", which for a symbol exercised only by tests is the opposite of the truth and invites deleting live code -- so when the filter is what emptied it, say so instead of showing a bare zero.
  const hiddenNote = excludeTests && hiddenByExcludeTests > 0 ? ` (${excludeTestsHiddenNote(hiddenByExcludeTests)})` : ''
  if (callers.length === 0 && matchesGrep !== undefined && preGrepCount > 0) {
    // Distinguishes "--grep matched none of the N callers that do exist" from a genuinely
    // caller-less symbol -- same "filtered store renders as populated" trap already fixed for
    // refs/callers/dead/types/deps. preGrepCount already reflects --exclude-tests (if both are
    // set), so this fires only once the grep filter is what zeroed the remaining set.
    lines.push(`Callers (0): ${grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'caller', 'callers').trim()}`)
  } else {
    lines.push(callers.length === 0 && hiddenNote !== ''
      ? `Callers (0): no non-test callers${hiddenNote}`
      : `Callers (${totalCallers}):${hiddenNote}`)
  }
  for (const c of shown) {
    const callerDisplayPath = toDisplayPath(rootDir, c.file)
    lines.push(`  ${c.caller}\t${callerDisplayPath}:${c.line}`)
    // brief's caller block is its OWN rendering site, not a call into runCallers -- `-C` has to be
    // threaded here separately or the flag would silently do nothing for `brief`.
    const window = buildContextWindow(c.file, c.line, opts.context ?? 0)
    if (window !== null) lines.push(...renderContextWindow(callerDisplayPath, c.line, window, '', '    '))
  }
  if (truncated) {
    lines.push(`  ...(${totalCallers - shown.length} more elided)`)
  }

  if (section !== null) {
    lines.push('')
    lines.push(`Section: ${section.heading} (lines ${section.lineStart}-${section.lineEnd})`)
  }

  const text = guardText(warning + trimBlankLines(lines).join('\n'), 'symbol')
  if (opts.suppressStat !== true) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

/** Handle ``token-goat brief "file::a,b,c"`` -- bundle several symbols' body+callers+section views from one file in a single call, mirroring `read`/`section`'s comma-separated multi-spec grammar (see {@link runReadMulti}). Delegates each symbol to a recursive {@link runBriefCore} call (`suppressStat: true`) so ambiguity handling, not-found + did-you-mean, and JSON shape all come from the exact same code path the single-symbol form already exercises -- a failure to resolve one symbol is reported inline instead of aborting the whole call, same as `runReadMulti`'s per-symbol handling. */
export function runBriefMulti(file: string, symbols: string[], opts: BriefOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const sym of symbols) {
    const sub = runBriefCore({ ...opts, spec: `${file}::${sym}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real JSON per symbol, never an embedded string -- a failed sub-call has no JSON body of its own, so it is represented by its plain-text error instead.
      jsonOut[sym] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${sym}:\n${sub.text}`)
  }

  // Count the file's on-disk size once for the whole multi-symbol call, not once per symbol -- each sub-call already skipped its own recordReadStat via suppressStat for exactly this reason (see BriefOptions.suppressStat).
  const fullSourceBytes = sumFileSizes([resolveIndexPath(file, opts.projectRoot ?? process.cwd())])
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

/** Cross-file brief, e.g. `src/a.ts::fnA,src/b.ts::fnB`. Body mirrors runBriefMulti's own per-symbol loop above (same runBriefCore sub-call, same suppressStat + single fullSourceBytes-over-all-files convention), swapping the shared `file` for each pair's own -- and mirrors runSectionCrossFile/runRefsCrossFile/runReadMulti's `keyFor` rule: one distinct file across all pairs keys by bare symbol (matches today's same-file `brief "file::a,b"` output byte-for-byte), more than one keys by the full `file::symbol` pair so two files contributing the same symbol name stay distinct. */
export function runBriefCrossFile(pairs: { file: string; symbol: string }[], opts: BriefOptions): { text: string; code: number } {
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string => (distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`)

  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const { file, symbol } of pairs) {
    const key = keyFor({ file, symbol })
    const sub = runBriefCore({ ...opts, spec: `${file}::${symbol}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  const fullSourceBytes = sumFileSizes([...distinctFiles].map((f) => resolveIndexPath(f, opts.projectRoot ?? process.cwd())))
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

/** Handle ``token-goat brief "file::symbol"``: dispatches to {@link runBriefCrossFile} for a cross-file `a.ts::x,b.ts::y` spec, to {@link runBriefMulti} for a comma-separated same-file `file::a,b` spec, otherwise runs the single-symbol {@link runBriefCore} path, then emits the result -- `emitErr` on a nonzero code, `emit` on success. */
export function runBrief(opts: BriefOptions): number {
  // Same reasoning as runRefs/runFind/runTypes: a limit of 0 (or negative) would silently slice the caller list down to zero entries instead of surfacing a clear "you asked for nothing" error, consistent with every other --limit flag in this codebase. Validated once here rather than inside runBriefCore because --limit applies to the whole invocation, so a multi-symbol spec must report it once, not once per symbol.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  // Cross-file multi-spec `src/a.ts::fnA,src/b.ts::fnB`. Checked before the single-file `::` handling below for the same reason runRead/runSection/runRefs check it first (see parseCrossFileMultiSpec) -- parseReadSpec's `lastIndexOf('::')` would otherwise fold a spec crossing a file boundary into one bogus file/symbol-list pair. parseCrossFileMultiSpec already declines (falling through here unchanged) for every spec the single-file path below already handles correctly, including the pre-existing same-file `file::a,b` multi-symbol form.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) {
    const { text, code } = runBriefCrossFile(crossFilePairs, opts)
    if (code === 0) emit(text)
    else emitErr(text)
    return code
  }

  const { file, symbol } = parseReadSpec(opts.spec)
  if (symbol !== undefined && symbol !== '' && symbol.includes(',')) {
    const multiSymbols = symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (multiSymbols.length > 1) {
      const { text, code } = runBriefMulti(file, multiSymbols, opts)
      if (code === 0) emit(text)
      else emitErr(text)
      return code
    }
  }

  const { text, code } = runBriefCore(opts)
  if (code === 0) emit(text)
  else emitErr(text)
  return code
}
