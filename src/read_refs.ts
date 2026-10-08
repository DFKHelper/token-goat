/** The `refs` command: every call site of a symbol, found by name in the index, narrowed by the TypeScript checker when the definition is a single TypeScript symbol, and printed per line, grouped by caller, or ranked by file with `--top`. */

import { globalDbPath } from './constants.js'
import { deliveredOutputBytes } from './delivery_cap.js'
import { emit, emitErr } from './emit.js'
import { refBlindKindVerdict } from './graph_commands.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import { querySymbols, queryRefs, countRefs, DEFAULT_QUERY_LIMIT } from './index_reader.js'
import { detectLanguageOfFile, type RefEntry, type SymbolEntry } from './parser_types.js'
import { displaySafeJson, displaySafeText, toDisplayPath } from './paths.js'
import { resolveSpecPath } from './spec_path.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { UNBOUNDED_QUERY_LIMIT } from './query_limits.js'
import { DELETED_TAG, emitGuarded, fileIsGone, findSpecSeparator, guardJsonRows, guardText, healStaleIndex, healStaleResultFiles, recordReadStat, sinkGoneRows, truncationFooter, truncationNotice, warnIfFilesStale, type TruncationTotal } from './read_commands.js'
import { confinedProjectRoot, confinementRefusal, parseCrossFileMultiSpec, formatAmbiguity, parseReadSpec, resolveProjectConfinement, resolveQualifiedSpec, resolveQualifiedSpecDef } from './read_spec.js'
import { unknownSymbolSuggestion } from './read_suggest.js'
import { isRefIndexedFile, refBlindLanguageNotice, refBlindKindNotice, refBlindKindPartialNote, REF_BLIND_DEF_PROBE_LIMIT } from './ref_blindness.js'
import { typedRefsForDef } from './graph_traversal.js'
import { compileGrepMatcher, countNoun, excludeTestsHiddenNote, isTestFile } from './util.js'
import { grepFilteredToEmptyNotice } from './filter_notice.js'
import { forClient } from './mcp_client_text.js'
import { buildContextWindow, renderContextWindow, type SourceContextLine } from './util_context.js'
import { CliError, formatCommandError } from './command_error.js'
import { echoedValue } from './hint_suggestion_guard.js'

export interface RefsOptions {
  spec: string
  callers?: boolean
  json?: boolean
  limit?: number
  /** Group references by file (count only, no per-line context) and show only the top N files by reference count. For a high-fanout symbol (hundreds of refs across dozens of files -- e.g. a widely-extended base class or widely-implemented interface) the normal per-line output degrades into the unusable wall of text this tool exists to prevent; this mode stays surgical by trading per-line context for a ranked-by-fanout summary. Independent of `--callers`: when both are set, `--top` wins for text output (its summary supersedes the caller-grouped per-line view; the choice is between them, not a composition of both). */
  top?: number
  /** `-C, --context <n>`: lines of real source text to show either side of each reference. The existing per-reference line already answers *where* a symbol is used and names the enclosing symbol, but never shows the call site itself; this adds the surrounding source in `grep -C`'s exact framing (see {@link renderContextWindow}). Defaults to 0, in which case every output byte -- text and JSON alike -- is unchanged. */
  context?: number
  /** `--exclude-tests`: drop references whose call site lives in a test file (per isTestFile). Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only list references whose call-site FILE PATH matches this pattern (rows render as `file:line: symbol`, so this is the field each row is keyed on -- matched against the path as RENDERED under displayRoot, so an anchored `--grep "^src/"` matches what the caller sees; the high-value case is a wide-fanout symbol where that drops test/vendored hits). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
  /** Workspace root to scope this lookup to: resolves the `file::symbol` defining-file hint against, and scopes queryRefs' call-site rows to this root (the same `queryOpts.rootDir` mechanism `symbol` uses) so refs from other projects in the shared global index never surface. Optional and unset for CLI callers, who resolve against `process.cwd()` -- see `resolveAgainstProjectRoot`/`SemanticOptions.projectRoot` for the established convention this mirrors. */
  projectRoot?: string
}

// The ONE place every `refs` output path -- text rows, --top summaries, --json payloads, and the --grep filter -- turns a stored absolute path into the path a caller sees. It takes no root argument on purpose: the previous shape passed a root per call site, so runRefsSingle rendered root-relative while the multi-symbol and cross-file paths passed `undefined` and rendered absolute (the same path spelled two ways depending only on how many symbols you asked for), and a filter handed a different root than its renderer silently tested a string the caller could not see (the `--grep "^src/"` matches-nothing bug). Sourcing the root here makes both divergences unrepresentable rather than merely fixed.
function refsDisplayPath(p: string): string {
  return toDisplayPath(getDisplayRoot(), p)
}

/** The per-row DELETED suffix `symbol` prints, for a reference whose file is gone from disk (a deleted worktree's rows survive sweepKnownRoots' missing-root grace), so a caller never edits a call site that no longer exists. */
function goneSuffix(filePath: string): string {
  return fileIsGone(filePath) ? `  ${DELETED_TAG}` : ''
}

function refGrepFilter(grep: string | undefined): ((r: RefEntry) => boolean) | undefined {
  if (grep === undefined) return undefined
  const matches = compileGrepMatcher(grep)
  return (r) => matches(refsDisplayPath(r.filePath))
}

/** JSON reference rows as emitted: `-C` windows attached first (they read from disk, so they need the raw absolute path), then `filePath` rewritten to the same display spelling the text rows use -- root-relative and reproducible rather than absolute and specific to one machine's drive-letter casing, matching what outline/skeleton `--json` already do. */
function refsJsonItems<T extends RefEntry>(items: T[], contextLines: number): (T & { contextLines?: SourceContextLine[] })[] {
  return withContextLines(items, contextLines).map((r) => ({ ...r, filePath: refsDisplayPath(r.filePath), ...(fileIsGone(r.filePath) ? { deleted: true } : {}) }))
}

/** One reference rendered as `path:line: <enclosing symbol>` (today's line, always emitted verbatim), optionally followed by its `-C` source window. Shared by all three `refs` rendering paths (single, multi-symbol, cross-file) so `-C` cannot drift between them. */
function renderRefLines(ref: RefEntry, contextLines: number, indent = '  '): string[] {
  const displayPath = refsDisplayPath(ref.filePath)
  // The path and the one-line context are repo-chosen text quoted into token-goat's own listing row. The `-C` window below is file content and is deliberately left as it is: that is the payload the reader asked for, and this file's read output is unfenced by design.
  const base = `${indent}${displaySafeText(displayPath)}:${ref.line}: ${displaySafeText(ref.context)}${goneSuffix(ref.filePath)}`
  const window = buildContextWindow(ref.filePath, ref.line, contextLines)
  if (window === null) return [base]
  return [base, ...renderContextWindow(displaySafeText(displayPath), ref.line, window, '', `${indent}  `)]
}

/** Attaches a `contextLines` array to each JSON reference item when `-C` was requested. The pre-existing `context` field (the enclosing symbol NAME) is left untouched -- these are different things and consumers already depend on the old one. */
function withContextLines<T extends RefEntry>(items: T[], contextLines: number): (T & { contextLines?: SourceContextLine[] })[] {
  if (!(contextLines > 0)) return items
  return items.map((r) => ({ ...r, contextLines: buildContextWindow(r.filePath, r.line, contextLines) ?? [] }))
}

/** Best-effort "exact" tier for `refs`: name-based matching (via `queryRefs`) conflates two unrelated symbols that happen to share a name -- see `ts_refs.ts`'s module doc. When the symbol's definition is unambiguous (exactly one `querySymbols` hit for `symName`/`file`) and is a TypeScript file, this narrows `results` using the TypeScript compiler API's type checker. Always degrades to `results` unchanged when the tier can't apply: ambiguous or missing definition, non-TS definition file, `typescript` unavailable, or any resolution failure. No CLI flag gates this -- it applies silently whenever the file type qualifies, the same best-available-accuracy pattern `embeddings.ts`'s `isAvailable()`-gated semantic tier uses. */
function applyTypedRefsTier(
  symName: string,
  file: string | undefined,
  results: RefEntry[],
  qualifiedDef?: SymbolEntry,
): RefEntry[] {
  if (results.length === 0) return results
  try {
    const symbolQueryOpts: Parameters<typeof querySymbols>[0] = { name: symName, limit: 2 }
    if (file !== undefined) symbolQueryOpts.filePath = file
    // A qualified spec already named its one definition, which a same-file name collision (Circle.area / Square.area) would otherwise make ambiguous here.
    const defs = qualifiedDef !== undefined ? [qualifiedDef] : querySymbols(symbolQueryOpts)
    if (defs.length !== 1) return results
    return typedRefsForDef(results, defs[0]) ?? results
  } catch {
    return results
  }
}

/** Splits a refs spec into an optional `::`-prefixed file scope and the comma-separated symbol list after it. With no `::`, the whole spec is the comma-separated symbol list; with no comma, a single-element list (the original single-symbol form). */
function parseMultiRefsSpec(spec: string): { file: string | undefined; symbols: string[] } {
  const colonIdx = findSpecSeparator(spec)
  const file = colonIdx === -1 ? undefined : spec.slice(0, colonIdx)
  const symPart = colonIdx === -1 ? spec : spec.slice(colonIdx + 2)
  const symbols = symPart.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return { file, symbols }
}

/** The root every `refs` query is scoped to. `refs` searches the whole index by symbol NAME, so unlike the file-spec commands it cannot be gated by one path: leaving `rootDir` unset returns reference sites -- path, line and surrounding source context -- from every project on the machine. Falling back to the confining root scopes the search the same way `symbol`'s bare-name path already does. */
function refsRootDir(opts: { projectRoot?: string }): string | undefined {
  return opts.projectRoot ?? confinedProjectRoot() ?? undefined
}

/** Every file named by a `refs` spec: the cross-file form's per-pair files, or the single file of a `file::symbol` spec. A bare symbol name contributes none, and is confined by {@link refsRootDir} instead. */
function refsSpecFiles(spec: string): string[] {
  const crossFile = parseCrossFileMultiSpec(spec)
  if (crossFile !== null) return [...new Set(crossFile.map((p) => p.file))]
  const { file } = parseMultiRefsSpec(spec)
  return file === undefined ? [] : [file]
}

/** One name to report references for: the symbol, the file that DEFINES it (used only to disambiguate same-named symbols, never to narrow the query -- and absent for a bare-name spec, which is why it is optional), and the key it is listed under in the output. */
interface RefsTarget {
  file: string | undefined
  symbol: string
  key: string
}

/** One name's references as every `refs` renderer receives them, with the counts each needs for an honest total (see {@link refsTotal}). */
interface CollectedRefs {
  queryOpts: Parameters<typeof queryRefs>[0]
  defFileHint: string | undefined
  results: RefEntry[]
  preScanCount: number
  scanLimit: number
  suppressed: number
  preGrepCount: number
  clientFiltered: boolean
  filteredTotal: number | undefined
}

/** Query and filter one name's references the same way for every spec form -- single symbol, same-file multi-symbol, cross-file pairs: the query window, the typed tier, `--exclude-tests`, `--grep`, then the requested-limit slice when a client-side filter ran. These steps were written out twice, once in runRefsSingle and once in the multi-target loop, and the copies had drifted: only the single form resolved the defining file before the typed tier looked it up. */
function collectRefs(requestedName: string, defFile: string | undefined, opts: RefsOptions, resolvedDef?: SymbolEntry): CollectedRefs {
  // The multi-symbol paths pass `Parent.method` through unresolved; the single path has already resolved it.
  const qualifiedDef = resolvedDef ?? (defFile !== undefined && requestedName.includes('.') ? resolveQualifiedSpecDef(`${defFile}::${requestedName}`, opts.projectRoot ?? process.cwd()) : undefined)
  const symName = qualifiedDef?.name ?? requestedName
  const queryOpts: Parameters<typeof queryRefs>[0] = { name: symName }
  // `defFile` (the `file` in `file::symbol`) names where the symbol is DEFINED, used only to disambiguate a same-named symbol elsewhere in the index (fed to applyTypedRefsTier's querySymbols({name, filePath}) call, where filePath genuinely is the defining file). It must never be passed to queryRefs/countRefs: refs.file_path there is the file a REFERENCE occurs in, not where the symbol is defined, so doing so would wrongly narrow every result (not just --callers) to same-file references only. Resolved to the absolute path the index stores, since a relative spelling matches no definition and silently skips the typed tier.
  const defFileHint = defFile !== undefined ? resolveSpecPath(defFile, opts.projectRoot ?? process.cwd()) : undefined
  // --grep needs the same full-headroom query as --exclude-tests, since it also filters the resolved set client-side (on filePath) AFTER the query -- slicing to the requested limit before it runs would silently under-return by letting non-matching refs occupy slots ahead of the cutoff.
  if (opts.excludeTests === true || opts.grep !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
  else if (opts.limit !== undefined) queryOpts.limit = opts.limit
  else if (opts.top !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
  const rootDir = refsRootDir(opts)
  if (rootDir !== undefined) queryOpts.rootDir = rootDir

  // The spec's defining file is the one file this command names up front, so it heals before the query the way `read`/`symbol` heal theirs: a call added to it out of band has no row yet, and no row can lead the query to it afterwards.
  if (defFileHint !== undefined && !fileIsGone(defFileHint)) healStaleIndex(defFileHint)
  let scanned = queryRefs(queryOpts)
  // The other files are found only by querying, so heal what the query hit and ask once more: answering from the rows already fetched would print pre-edit line numbers (or a call that is gone) under a note saying a repeat would be current. A file whose reparse failed stays stale and warnIfFilesStale still warns about it.
  if (healStaleResultFiles(scanned.map((r) => r.filePath)).healed) scanned = queryRefs(queryOpts)
  // How full the query window came back, and how big that window was, so a client-side filter drawn from a window that filled can report its count as a floor rather than as a total. See {@link refsTotal}.
  const preScanCount = scanned.length
  const scanLimit = queryOpts.limit ?? DEFAULT_QUERY_LIMIT
  let results = applyTypedRefsTier(symName, defFileHint, scanned, qualifiedDef)
  // Whether the type-based tier filter itself dropped anything, not merely whether it ran: a query where it dropped nothing is still entitled to the exact-total form. Measured before --exclude-tests/--grep can drop further rows of their own, so this reflects only the typed filter's own effect on the scanned window.
  const typedFilterDropped = results.length < scanned.length
  let suppressed = 0
  if (opts.excludeTests === true) {
    const f = applyExcludeTestsFilter(results)
    suppressed = f.suppressed
    results = f.refs
  }
  // --grep narrows by the reference's call-site FILE PATH (the field each row is keyed on: `file:line: symbol`), and runs BEFORE the requested-limit slice below so it selects from the whole (test-filtered) set rather than from an already-capped page. It tests the path as refsDisplayPath renders it, so an anchored pattern matches what the caller sees.
  const preGrepCount = results.length
  const matchesGrep = refGrepFilter(opts.grep)
  if (matchesGrep !== undefined) results = results.filter(matchesGrep)
  // The typed-tier filter is a client-side filter over the same window as --exclude-tests/--grep, so a query where it alone dropped rows reports a floor whenever that window was finite: see refsTotal's doc comment.
  const clientFiltered = opts.excludeTests === true || matchesGrep !== undefined || typedFilterDropped
  const filteredTotal = clientFiltered ? results.length : undefined
  // Ahead of the page slice, so a page cut short keeps the live call sites and lets the dead ones fall off the end: see sinkGoneRows.
  results = sinkGoneRows(results, (r) => r.filePath)
  if (clientFiltered && opts.top === undefined) results = results.slice(0, opts.limit ?? 100)
  return { queryOpts, defFileHint, results, preScanCount, scanLimit, suppressed, preGrepCount, clientFiltered, filteredTotal }
}

/** The honest reference total for a page of `refs` output. `countRefs` reruns the SQL filters with no LIMIT, which is exact. The client-side filters (`--exclude-tests`, `--grep`, and the typed-refs tier) have no SQL equivalent, so their total is the post-filter count of the window the rows came from: exact only while that window had room to spare, a floor once it filled. `scanLimit` is the window the rows were actually fetched under, which is NOT one fixed number. `--exclude-tests`/`--grep`/`--top` scan unbounded (`UNBOUNDED_QUERY_LIMIT`, negative), an explicit `--limit` sets it, and a query with none of those gets queryRefs' own DEFAULT_QUERY_LIMIT. A negative window never fills, so the client-side filters on those routes saw every matching row and their post-filter count is the exact total rather than a floor -- which is why the sign is tested rather than the count compared against a constant that no longer exists. No CLI path reaches that wrong branch today, and the fix is deliberately not sold as one: {@link truncationNotice} prints nothing unless `shown >= limit` and `count > shown`, and on every route that leaves this window narrow the window IS the display limit, so the post-filter count cannot exceed what was shown. That is a coincidence held together three call frames apart, and it is the whole reason to compare against the window actually used instead: widening a default here, or slicing to something other than the query limit there, silently turns a floor into a claimed total with no test able to see it happen. */
function refsTotal(clientFiltered: boolean, filteredTotal: number | undefined, shown: number, countExact: () => number, preScanCount: number, scanLimit: number): TruncationTotal {
  if (!clientFiltered) return { count: countExact(), exact: true }
  if (scanLimit < 0) return { count: filteredTotal ?? shown, exact: true }
  return { count: filteredTotal ?? shown, exact: preScanCount < scanLimit }
}

/** Counterfactual byte cost of the search `refs` replaces: one `path:line: label` hit line per reference, the shape `grep -n <symbol>` prints. This is deliberately NOT sumFileSizes over the files those references live in: nobody reads forty files end to end to find call sites, they run a search, so crediting `refs` with those files' whole contents overstated a multi-file result by orders of magnitude (a real ledger showed ~466KB claimed per `refs` event, because the 100KB-per-file ceiling in sumFileSizes bounds each file and never the sum). Deliberately a LOWER bound on what the equivalent search would emit, and only a lower bound: `ref.context` is the short enclosing-symbol label refs renders, where a grep hit line carries the whole matched source line, and a textual grep also returns comments, strings and unrelated same-named symbols that are not references at all. Neither of those is knowable without re-reading every hit file, so the ledger claims only what it can prove from rows already in hand. Requested `--context` lines are excluded for the same reason they cannot earn credit: they are extra output the caller asked for on top of what the plain search prints. That search is one shell command, so its output is priced the way every shell saving is, by what the harness would have delivered of it (deliveredOutputBytes): a 10MB hit list reaches the model as a 2KB preview, not 10MB, and a real ledger credited one `refs` call 2.5M tokens by skipping that step. */
function refsSearchBaselineBytes(rows: Iterable<RefEntry>): number {
  let total = 0
  for (const ref of rows) total += Buffer.byteLength(`${refsDisplayPath(ref.filePath)}:${ref.line}: ${ref.context}\n`, 'utf8')
  return deliveredOutputBytes(total)
}

/** Render references for several named targets, one block (or JSON entry) each. Shared by runRefs's same-file multi-symbol path (`file::a,b`, keyed by bare symbol) and runRefsCrossFile's pair path (`a.ts::x,b.ts::y`, keyed by symbol or by the full `file::symbol` pair). Those were two loops written out separately and kept in step by hand, described in runRefsCrossFile's own docblock as mirroring this one -- same query construction, same `--callers`/`--limit`/`--top`/`--grep`/`--exclude-tests`/`--json` handling, differing only in where each target's `file` and output key come from. Keeping two copies of that in step by hand is how they drift, and they already had: only the same-file loop carried `hiddenByGrep`. Prints directly and returns a bare exit code rather than `{text, code}`, per runRefs's own existing convention. */
function renderRefsTargets(targets: RefsTarget[], opts: RefsOptions): number {
  // An overloaded `Class.method` target would otherwise print "(no references found)" for a symbol that exists: refuse the whole request with the @line picks, as the single-symbol form does.
  for (const { file, symbol } of targets) {
    if (file === undefined || !symbol.includes('.')) continue
    const qualified = resolveQualifiedSpec(`${file}::${symbol}`, opts.projectRoot ?? process.cwd())
    if (qualified?.kind !== 'ambiguous') continue
    emitErr(formatCommandError(new CliError(formatAmbiguity(qualified.symbol, qualified.file, qualified.candidates, opts.projectRoot, 'refs').split('\n'))))
    return 1
  }
  // Every entry uses the same envelope shape as the single-symbol `refs`/`symbol`/`skeleton`/ `outline` JSON output ({ items, truncated, totalCount }), whether or not it was truncated — a JSON consumer should never have to branch on shape depending on truncation. `--top` opts into a distinct, deliberately different envelope ({ fileCounts, totalFiles, totalRefs, shown }) since the caller explicitly asked for the grouped summary shape instead.
  const jsonOut: Record<string, RefsJsonEntry> = {}
  let anyFound = false
  // A target whose references --grep filtered out entirely is an answer, not a miss: the single-symbol path prints that notice on stdout and exits 0, so a call whose every target was filtered must too, rather than reporting the same outcome as a failure because two names were asked for instead of one.
  let anyFilteredByGrep = false
  const lines: string[] = []
  const refRows: RefEntry[] = []
  for (const { file, symbol, key } of targets) {
    const { queryOpts, results, preScanCount, scanLimit, suppressed, preGrepCount, clientFiltered, filteredTotal } = collectRefs(symbol, file, opts)
    if (results.length > 0) anyFound = true
    else if (opts.grep !== undefined && preGrepCount > 0) anyFilteredByGrep = true
    refRows.push(...results)
    if (opts.json === true) {
      // Same omit-when-zero `hiddenByGrep` the single-spec JSON path emits, per target here: a symbol whose entry is `items: []` because --grep matched none of its references must not be indistinguishable from one that genuinely has none.
      const hiddenByGrep = opts.grep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
      const withHidden = <T extends object>(payload: T): T => ({ ...payload, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) })
      if (opts.top !== undefined) {
        jsonOut[key] = withHidden(topFilesJsonPayload(results, opts.top))
      } else {
        // `results` is already truncated by queryRefs's own SQL `LIMIT` (opts.limit, or the default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length) is not the real number of matching refs -- countRefs reruns the same filters with no LIMIT to report an honest total (same fix as runSymbol's countSymbols call). Under --exclude-tests or --grep, countRefs has no way to rerun that filter, so filteredTotal (the pre-slice filtered count, already scanned with full headroom above) is the honest total.
        const capped = guardJsonRows(results)
        const trueTotal = clientFiltered ? (filteredTotal ?? results.length) : countRefs(queryOpts)
        jsonOut[key] = withHidden({ items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal })
      }
      continue
    }
    if (results.length === 0) {
      // Distinguish "--grep matched none of the N references that do exist" for this target from a genuine absence -- same trap already fixed for dead/deps/types, and checked first so it takes priority over the --exclude-tests message below.
      if (opts.grep !== undefined && preGrepCount > 0) {
        lines.push(`${key}: ${grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'reference', 'references').trim()}`)
        continue
      }
      // A symbol referenced only from tests must not read as unreferenced here either -- same reasoning as the single-spec path above. Flag-absent output is untouched: suppressed is always 0 then.
      lines.push(opts.excludeTests === true && suppressed > 0 ? `${key}: (no non-test references found; ${excludeTestsHiddenNote(suppressed)})` : `${key}: (no references found)`)
      continue
    }
    lines.push(`${key}:`)
    if (opts.top !== undefined) {
      lines.push(...renderTopFilesSummary(results, opts.top, suppressed))
    } else if (opts.callers === true) {
      if (opts.excludeTests === true && suppressed > 0) lines.push(`  ${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`)
      lines.push(...renderCallerGroups(results, opts.context ?? 0))
    } else {
      if (opts.excludeTests === true && suppressed > 0) lines.push(`  ${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`)
      for (const ref of results) lines.push(...renderRefLines(ref, opts.context ?? 0))
    }
    // Per target, not once for the whole call: each name has its own total, and a single footer under the last block would read as applying to all of them. `--top` renders its own note.
    if (opts.top === undefined) {
      const notice = truncationNotice(
        results.length,
        opts.limit ?? 100,
        () => refsTotal(clientFiltered, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount, scanLimit),
        'references',
        '--limit',
      )
      if (notice !== null) lines.push(`  token-goat: ${notice}`)
    }
  }
  warnIfFilesStale(refRows.map((r) => r.filePath), 'refs')
  const fullSourceBytes = refsSearchBaselineBytes(refRows)
  if (opts.json === true) {
    const text = displaySafeJson(jsonOut)
    emit(text)
    if (anyFound) recordReadStat('symbol_read', fullSourceBytes, text, opts.spec)
    return anyFound || anyFilteredByGrep ? 0 : 1
  }
  // Every target missed, so the call failed: its per-target reasons are the error, written to stderr under one token-goat: line as the single-symbol miss is, never to stdout beside an exit 1. Under --json the map above stays the stdout answer, as writeCommandFailure keeps a --json body.
  if (!anyFound && !anyFilteredByGrep) {
    emitErr(formatCommandError(new CliError(lines)))
    return 1
  }
  const text = lines.join('\n')
  emitGuarded(text, 'symbol')
  if (anyFound) recordReadStat('symbol_read', fullSourceBytes, text, opts.spec)
  return 0
}

/** Handle ``token-goat refs <spec>``. A comma-separated spec (`a,b,c` or `file::a,b`) merges the references of several symbols into one call, each group headed by its symbol name; a single symbol keeps the original behavior verbatim via {@link runRefsSingle}. */
export function runRefs(opts: RefsOptions): number {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero rows regardless of whether references exist -- silently reporting "no references found" for a symbol that's actually referenced. Reject it explicitly instead of querying with it. Both callers (this multi-symbol path and the single-symbol runRefsSingle it delegates to) are covered by this one check since runRefsSingle is never called from outside this file.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(formatCommandError(`--limit must be a positive number, got: ${echoedValue(String(opts.limit))}`))
    return 1
  }
  // Same reasoning: --top 0 (or negative) is never a meaningful request -- reject explicitly rather than silently rendering an empty summary.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(formatCommandError(`--top must be a positive number, got: ${echoedValue(String(opts.top))}`))
    return 1
  }

  // Same confinement the file-spec read commands enforce, applied before any query: an explicit --project or an out-of-root file in the spec would otherwise re-open the channel that refsRootDir closes for the bare-name form.
  const { root: confinedRoot, denial: projectDenial } = resolveProjectConfinement(opts.projectRoot)
  if (projectDenial !== null) {
    emitErr(formatCommandError(projectDenial))
    return 1
  }
  if (confinedRoot !== null) {
    for (const file of refsSpecFiles(opts.spec)) {
      const denial = confinementRefusal('This file', resolveSpecPath(file, opts.projectRoot ?? process.cwd()), confinedRoot)
      if (denial !== null) {
        emitErr(formatCommandError(denial))
        return 1
      }
    }
  }

  // Cross-file multi-spec `src/a.ts::fnA,src/b.ts::fnB`. Checked before the single-file `::` handling below for the same reason runRead/runSection check it first (see parseCrossFileMultiSpec) -- parseMultiRefsSpec's findSpecSeparator is a lastIndexOf('::'), so a spec crossing a file boundary would otherwise fold into one bogus file/symbol-list pair and silently miss every symbol but the last (the reported bug: `refs "a.ts::x,b.ts::y"` parsed as file=`a.ts::x,b.ts` symbol=`y`, that nonexistent file matched nothing, and a referenced symbol was reported as unreferenced). parseCrossFileMultiSpec already declines (falling through here unchanged) for every spec the single-file path below already handles correctly, including the pre-existing same-file `file::a,b` multi-symbol form.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runRefsCrossFile(crossFilePairs, opts)

  const { file, symbols } = parseMultiRefsSpec(opts.spec)
  if (symbols.length <= 1) return runRefsSingle(opts)

  return renderRefsTargets(
    symbols.map((symbol) => ({ file, symbol, key: symbol })),
    opts,
  )
}

/** Cross-file refs, e.g. `src/a.ts::fnA,src/b.ts::fnB`. Renders through the shared renderRefsTargets above, same as runRefs's same-file multi-symbol path -- the two used to be separate loops kept in step by hand. What is local to this form is the `keyFor` rule it shares with runSectionCrossFile/runReadMulti: one distinct file across all pairs keys by bare symbol (matches today's same-file `refs "file::a,b"` output byte-for-byte), more than one keys by the full `file::symbol` pair so two files contributing the same symbol name stay distinct. */
function runRefsCrossFile(pairs: { file: string; symbol: string }[], opts: RefsOptions): number {
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string => (distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`)
  return renderRefsTargets(
    pairs.map((p) => ({ file: p.file, symbol: p.symbol, key: keyFor(p) })),
    opts,
  )
}

/** Handle ``token-goat refs file::symbol``. */
function runRefsSingle(opts: RefsOptions): number {
  const { file, symbol } = parseReadSpec(opts.spec)
  // A qualified `file::Parent.method` resolves to the method's own name plus its one definition, so refs are keyed by the real name and the typed tier knows which declaration is meant.
  const qualified = resolveQualifiedSpec(opts.spec, opts.projectRoot ?? process.cwd())
  // An overloaded `Class.method` is a real symbol with several definitions: list them with their @line picks, as `read` does, instead of reporting a literal dotted name as not found.
  if (qualified?.kind === 'ambiguous') {
    emitErr(formatCommandError(new CliError(formatAmbiguity(qualified.symbol, qualified.file, qualified.candidates, opts.projectRoot, 'refs').split('\n'))))
    return 1
  }
  const qualifiedDef = qualified?.kind === 'ok' ? qualified.entry : undefined
  const symName = qualifiedDef?.name ?? symbol ?? file
  // A bare-name spec parses as a file with no symbol, and names no defining file at all.
  const { queryOpts, defFileHint, results, preScanCount, scanLimit, suppressed, preGrepCount, clientFiltered, filteredTotal } = collectRefs(symName, symbol !== undefined ? file : undefined, opts, qualifiedDef)

  if (results.length === 0) {
    // Distinguish "--grep matched none of the N references that do exist" from a symbol that genuinely has no references (or none outside tests) -- same "filtered store renders as populated" trap already fixed for dead/deps/types. Checked first so it takes priority over the --exclude-tests message below when both filters are active and --grep is what zeroed the remaining set.
    if (opts.grep !== undefined && preGrepCount > 0) {
      // Exits 0, so under --json a prose notice would pair a success status with an unparseable body. Same `{items, truncated, totalCount}` envelope the populated branch emits, with the post-filter count; text mode keeps the human notice.
      if (opts.json === true) {
        // `hiddenByGrep` (brief --json's own convention) is what tells the consumer this empty envelope is a filtered view rather than a symbol with no references -- `totalCount: 0` alone reads identically for both.
        emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preGrepCount }))
        return 0
      }
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'reference', 'references'))
      return 0
    }
    // "No references found" plus exit 1 for a symbol that IS referenced -- only from tests -- reads as "this symbol is unused", which invites deleting live code. Name the suppressed count so the filtered view is never mistaken for absence. Flag-absent output is untouched: suppressed is always 0 then.
    if (opts.excludeTests === true && suppressed > 0) {
      emitErr(formatCommandError(`No non-test references found for ${echoedValue(symName)} (${excludeTestsHiddenNote(suppressed)})`))
      return 1
    }
    // Distinguish "not indexed at all" from "indexed, genuinely zero references" -- the latter keeps today's message byte-identical (see unknownSymbolSuggestion's own doc comment for why this matters). Resolved here rather than hoisted to the top of the function since it's only ever paid once the query already came back empty.
    const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
    // Fetched as rows rather than as a bare existence count, because the defining file's LANGUAGE decides whether an empty result is an answer at all: parser.ts's REF_LANGUAGES walks call sites for nine tree-sitter languages only, and for a file outside that set the refs table is empty by construction. Capped rather than unbounded -- this only needs to know whether every definition of the name sits in a ref-blind language, and a name with more definitions than this cap in a single project is not a case where one more row changes that verdict.
    const defRows = querySymbols({ name: symName, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    if (defRows.length === 0) {
      emitErr(formatCommandError(`Symbol not found: ${echoedValue(symName)}${unknownSymbolSuggestion(symName, rootDir)}`))
      // Same empty-index note as the "No references found" branch below -- an empty project index makes EVERY symbol look unindexed, so this must still surface the real cause instead of leaving the caller staring at a suggestion-free "not found" for a project that was simply never indexed.
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
    // The honesty gate for Bug B: when EVERY file defining this name is in a language whose call sites are never indexed, "No references found" is a statement about token-goat's index that reads as a statement about the code, and agents delete code on the strength of it. Say which it is. Requires all definitions to be ref-blind: a name also defined in TypeScript has had its call sites genuinely searched, so the ordinary message is still the honest one there.
    const defPaths = defFileHint !== undefined ? [defFileHint] : defRows.map((r) => r.filePath)
    const firstDefPath = defPaths[0]
    if (firstDefPath !== undefined && defPaths.every((fp) => !isRefIndexedFile(fp))) {
      emitErr(formatCommandError(refBlindLanguageNotice(symName, detectLanguageOfFile(firstDefPath), refsDisplayPath(firstDefPath))))
      return 1
    }
    // The kind half of the same gate, and the one that fires in TypeScript, where the language half correctly never does: `refs` on an interface returns "No references found" today no matter how many files annotate with it, because extractRefs walks value positions only. Checked after the language half so a symbol blind both ways gets the language message, which names a file and is the more actionable of the two. All-or-nothing, and exit 1, matching both the language gate and the ordinary empty result beside it.
    const kindRows = defFileHint !== undefined ? querySymbols({ name: symName, filePath: defFileHint, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT }) : defRows
    const kindVerdict = refBlindKindVerdict(kindRows)
    if (kindVerdict.allBlind) {
      emitErr(formatCommandError(refBlindKindNotice(symName, kindVerdict.blindKinds)))
      return 1
    }
    emitErr(formatCommandError(`No references found for ${echoedValue(symName)}`))
    // A partial answer presented as a whole one is the same defect as a refusal that was not needed: the other definitions were genuinely searched, so the message above stands, but the ref-blind ones it cannot speak for are named rather than dropped.
    if (kindVerdict.blindCount > 0) emitErr(refBlindKindPartialNote(symName, kindVerdict.blindKinds, kindVerdict.blindCount, kindRows.length))
    // Only paid after the query already came back empty, and only in text mode -- this branch already emits plain prose regardless of --json (there's no separate opts.json check here), so there's no JSON envelope to protect either way.
    if (opts.json !== true) {
      if (isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    }
    return 1
  }

  warnIfFilesStale(results.map((r) => r.filePath), 'refs')
  const fullSourceBytes = refsSearchBaselineBytes(results)

  if (opts.json === true) {
    let payload: RefsJsonEntry
    if (opts.top !== undefined) {
      payload = topFilesJsonPayload(results, opts.top)
    } else {
      // Same "SQL LIMIT applied before totalCount is taken" fix as runRefs's per-symbol branch above. Same --exclude-tests/--grep honest-total reasoning as runRefs's per-symbol branch above.
      const capped = guardJsonRows(results)
      const trueTotal = clientFiltered ? (filteredTotal ?? results.length) : countRefs(queryOpts)
      payload = { items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
    }
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially filtered page carries the count too rather than only the fully emptied one. Spread onto the emitted object rather than into `payload` so both `--top` and per-reference envelopes get it without either shape's interface growing an optional field the other never sets.
    const hiddenByGrep = opts.grep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
    const text = displaySafeJson({ ...payload, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) })
    emit(text)
    recordReadStat('symbol_read', fullSourceBytes, text, symName)
    return 0
  }

  const lines =
    opts.top !== undefined
      ? renderTopFilesSummary(results, opts.top, suppressed)
      : opts.callers === true
        ? [...(opts.excludeTests === true && suppressed > 0 ? [`${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`] : []), ...renderCallerGroups(results, opts.context ?? 0)]
        : [...(opts.excludeTests === true && suppressed > 0 ? [`${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`] : []), ...results.flatMap((ref) => renderRefLines(ref, opts.context ?? 0, ''))]
  // `--top` renders its own elision note; the per-reference modes printed exactly `limit` lines and stopped, so 100 of 150 references read as "these are all of them". Same honest total the --json branch above computes, and only paid when the page came back full.
  const refsFooter = opts.top !== undefined ? '' : truncationFooter(results.length, opts.limit ?? 100, () => refsTotal(clientFiltered, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount, scanLimit), 'references', '--limit')
  const text = lines.join('\n')
  // Guarded first, footer after: the overflow guard must not be able to trim off the very line that says how much was left out.
  emit(guardText(text, 'symbol') + refsFooter)
  recordReadStat('symbol_read', fullSourceBytes, text + refsFooter, symName)
  return 0
}

interface FileRefCount {
  readonly file: string
  readonly count: number
  /** Set only in `--top --json` output, and only when the file is gone from disk (same key `symbol --json` uses). */
  readonly deleted?: true
}

/** `--exclude-tests`: drops references whose call site is a test file, per {@link isTestFile}. Callers must query unbounded so this runs BEFORE any `--limit`/`--top` slicing, or the flag silently under-returns by letting suppressed test refs occupy slots ahead of the cutoff -- and no finite headroom is sufficient, since the rows are ordered alphabetically rather than by relevance. */
function applyExcludeTestsFilter(refs: RefEntry[]): { refs: RefEntry[]; suppressed: number } {
  const filtered = refs.filter((r) => !isTestFile(r.filePath))
  return { refs: filtered, suppressed: refs.length - filtered.length }
}

/** Groups `refs` by file, counting occurrences per file and sorting by count descending (ties broken alphabetically by path for stable output). */
function groupRefsByFile(refs: RefEntry[]): FileRefCount[] {
  const byFile = new Map<string, number>()
  for (const ref of refs) byFile.set(ref.filePath, (byFile.get(ref.filePath) ?? 0) + 1)
  return [...byFile.entries()]
    .map(([file, count]) => ({ file, count }))
    // Ordinal (not locale-aware) tiebreak -- an unlocaled localeCompare() sorts differently across Node's small-icu vs full-icu builds and different system default locales, making the truncation-affecting top-N ranking nondeterministic across machines/CI runners.
    .sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** Renders the `--top N` grouped-by-file summary: a header line with total refs/files, then one `count  file` line per shown file, then an elision note naming exactly how many files and refs were dropped (never a silent truncation -- see this repo's no-silent-caps convention). `suppressed`, when > 0, appends an additive note naming how many test-file references `--exclude-tests` hid -- omitted entirely (byte-identical to today) whenever it's 0/undefined. */
function renderTopFilesSummary(refs: RefEntry[], topN: number, suppressed?: number): string[] {
  const grouped = groupRefsByFile(refs)
  const shown = grouped.slice(0, topN)
  const suppressedNote = suppressed !== undefined && suppressed > 0 ? ` (${excludeTestsHiddenNote(suppressed)})` : ''
  const lines = [`${countNoun(refs.length, 'reference')} across ${countNoun(grouped.length, 'file')} (showing top ${shown.length})${suppressedNote}`]
  for (const { file, count } of shown) lines.push(`  ${count}  ${refsDisplayPath(file)}${goneSuffix(file)}`)
  const omittedFiles = grouped.length - shown.length
  if (omittedFiles > 0) {
    const shownRefs = shown.reduce((sum, g) => sum + g.count, 0)
    lines.push(forClient(`  ...(${countNoun(omittedFiles, 'more file')}, ${countNoun(refs.length - shownRefs, 'more reference')} elided; use a higher --top to see more)`))
  }
  return lines
}

/** The `--top N` JSON envelope: ranked-by-count file list plus the totals needed to know how much was elided, without ever including a per-reference line (that's the point of the mode). */
interface RefsTopJsonEntry {
  readonly fileCounts: FileRefCount[]
  readonly totalFiles: number
  readonly totalRefs: number
  readonly shown: number
}

function topFilesJsonPayload(refs: RefEntry[], topN: number): RefsTopJsonEntry {
  const grouped = groupRefsByFile(refs)
  const shown = grouped.slice(0, topN)
  // Same display spelling as the text `--top` summary this envelope mirrors -- see refsDisplayPath.
  return { fileCounts: shown.map((g) => ({ ...g, file: refsDisplayPath(g.file), ...(fileIsGone(g.file) ? { deleted: true } : {}) })), totalFiles: grouped.length, totalRefs: refs.length, shown: shown.length }
}

type RefsJsonEntry = { items: RefEntry[]; truncated: boolean; totalCount: number } | RefsTopJsonEntry

function renderCallerGroups(refs: RefEntry[], contextLines = 0): string[] {
  const byFile = new Map<string, RefEntry[]>()
  for (const ref of refs) {
    const bucket = byFile.get(ref.filePath)
    if (bucket !== undefined) {
      bucket.push(ref)
    } else {
      byFile.set(ref.filePath, [ref])
    }
  }
  const lines: string[] = []
  for (const [file, fileRefs] of byFile) {
    const displayPath = refsDisplayPath(file)
    lines.push(`${displaySafeText(displayPath)}:${goneSuffix(file)}`)
    for (const ref of fileRefs) {
      lines.push(`  :${ref.line}  ${ref.context !== '' ? displaySafeText(ref.context) : '(module scope)'}`)
      const window = buildContextWindow(file, ref.line, contextLines)
      if (window !== null) lines.push(...renderContextWindow(displaySafeText(displayPath), ref.line, window, '', '    '))
    }
  }
  return lines
}
