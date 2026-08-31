/**
 * CLI command handlers for code-graph commands.
 *
 * Implements callers, call-chain, impact, dead, deps, types, and scope.
 * All commands query the global symbol index (one global.db keyed by absolute path).
 * Pure exported helpers (enclosingSymbol, bfsCallChains, looksLikeTypeClass,
 * isDeadSymbol, compareHopEntries) are kept side-effect-free so they can be
 * unit-tested without a DB.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { querySymbols, queryRefs, queryRefsByContext, searchSymbolsFts, distinctSymbolKinds } from './index_reader.js'
import { normalizePath, resolveIndexPath, toDisplayPath } from './paths.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { extractImports, importsExtensionFor, fileConfinementRefusal, findSpecSeparator, guardJsonRows, resolveSymbolSpecOrEmitError, rankSimilarNames, didYouMean, unknownSymbolSuggestion } from './read_commands.js'
import { getTrackedFiles } from './repomap.js'
import { estimateTokens } from './overflow_guard.js'
import { decodeSource, runGit, ensureNewline, isTestFile, foldPath, extractErrorMessage, buildContextWindow, renderContextWindow, compileGrepMatcher, grepFilteredToEmptyNotice, excludeTestsHiddenNote, countNoun, windowsCmdQuoteArg } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'
import { globalDbPath } from './constants.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'

// ---- helpers ----------------------------------------------------------------

/** Reference-query cap shared by every {@link queryRefs} call in this file (existence checks,
 * caller resolution, dead-symbol detection) -- keeping this as one constant instead of a
 * hardcoded 500 at each site means a future cap change can't miss a site and silently
 * reintroduce the "existence check stops too early" bug this value was raised to fix. */
const DEFAULT_REF_QUERY_LIMIT = 500

/** Symbol-query cap for "every symbol in one file" lookups -- large enough that no real file
 * gets truncated, shared so every call site stays in sync. */
export const ALL_SYMBOLS_IN_FILE_LIMIT = 10000

/** SQLite: `LIMIT -1` (even as a bound parameter) means unbounded. Used by {@link runTestFor}
 * and {@link runCoverageGaps}, whose "does a test reference this symbol" check needs to see
 * every ref regardless of ref count -- unlike the other {@link queryRefs} call sites in this
 * file, DEFAULT_REF_QUERY_LIMIT's alphabetical-by-file-path ordering has no reason to sort
 * test-file refs before the cutoff, so a capped query on a symbol with 500+ refs can silently
 * drop every test-file ref and produce a false "untested" verdict. Also used for the reachability
 * walks ({@link runCallChain}, {@link runImpact}) and the whole-project kind scans
 * ({@link runDead}, {@link runCoverageGaps}), where the same (file_path, line) ordering means a
 * cap does not merely shorten the answer, it silently changes the verdict. */
const UNBOUNDED_REF_LIMIT = -1

function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

// ---- pure helpers (exported for unit tests) ---------------------------------

/** Return the innermost symbol whose [lineStart, lineEnd] contains `line`, or null. Innermost is the one with the largest lineStart among all containing symbols. */
export function enclosingSymbol(symbols: SymbolEntry[], line: number): SymbolEntry | null {
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if (s.lineStart <= line && line <= s.lineEnd) {
      if (best === null || s.lineStart > best.lineStart) best = s
    }
  }
  return best
}

/** Return the innermost class-or-function symbol containing `line`, or null. Unlike
 * {@link enclosingSymbol} (which returns the innermost symbol of ANY kind), this filters to
 * kind === 'class' || kind === 'function' -- calling enclosingSymbol with a method's own
 * lineStart returns the method itself (its own span always contains its own start line and is
 * more "innermost" than its enclosing class), never the scope that declares it. Function is
 * included alongside class because an anonymous class expression (`new (class extends Base {
 * ... })()`) has no name of its own -- the parser's context stack (parser.ts::extractRefs)
 * never pushes a name for it, so the extends-clause ref's `context` falls back to the nearest
 * NAMED enclosing scope, which for a factory-function pattern like `makeAiCliFilter` is the
 * function itself, not a (nonexistent) class symbol. */
function enclosingNamedScope(symbols: SymbolEntry[], line: number): SymbolEntry | null {
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if ((s.kind === 'class' || s.kind === 'function') && s.lineStart <= line && line <= s.lineEnd) {
      if (best === null || s.lineStart > best.lineStart) best = s
    }
  }
  return best
}

/** Return true when a class body matches Python type-container patterns (BaseModel, TypedDict, Protocol, or @dataclass). */
export function looksLikeTypeClass(body: string): boolean {
  return (
    /\bBaseModel\b/.test(body) ||
    /\bTypedDict\b/.test(body) ||
    /\bProtocol\b/.test(body) ||
    /@dataclass\b/.test(body)
  )
}

/** Caller function signature for the BFS helper. Receives a symbol name, returns the names of its direct callers. */
export type CallersOfFn = (name: string) => string[]

/** BFS over the caller relation starting from `start`. Returns every unique chain as a string[]. Cycle-safe: a cycle inserts a `(cycle:name)` sentinel and stops that branch. Depth is bounded by `maxDepth` hops from the start node. */
export function bfsCallChains(start: string, callersOf: CallersOfFn, maxDepth: number): string[][] {
  if (maxDepth <= 0) return [[start]]
  const complete: string[][] = []
  const queue: string[][] = [[start]]
  const globalVisited = new Set<string>([start])

  while (queue.length > 0) {
    const chain = queue.shift()
    if (chain === undefined) break
    const tip = chain[chain.length - 1]
    if (tip === undefined) continue
    const callers = callersOf(tip)
    if (callers.length === 0) {
      complete.push(chain)
      continue
    }
    if (chain.length > maxDepth) {
      // The tip still HAS callers, the walk just ran out of depth. Without a sentinel this chain renders exactly like one that ended at a real entry point, so a truncated result reads as a complete one -- same convention as the (cycle:X)/(visited:X) markers below.
      complete.push([...chain, '(depth-limit)'])
      continue
    }
    let expanded = false
    for (const caller of callers) {
      if (chain.includes(caller)) {
        // Real cycle: caller is an ancestor in THIS chain, so following it would loop back on itself.
        complete.push([...chain, `(cycle:${caller})`])
        expanded = true
        continue
      }
      if (globalVisited.has(caller)) {
        // Cross-branch dedup: caller was already explored via a different branch, not an ancestor here — not a real cycle.
        complete.push([...chain, `(visited:${caller})`])
        expanded = true
        continue
      }
      globalVisited.add(caller)
      queue.push([...chain, caller])
      expanded = true
    }
    if (!expanded) complete.push(chain)
  }
  return complete
}

/** Well-known entry-point names excluded from dead-symbol analysis. */
const ENTRY_NAMES: ReadonlySet<string> = new Set([
  'main', 'default', 'index', '__init__', '__main__', 'setup', 'run', 'handler', 'constructor',
])

/** Return true when a symbol with the given name and reference count is dead. The refs table does NOT include a symbol's own definition line (verified: queryRefs({name:'querySymbols'}) returns no ref at the definition line 84 of index_reader.ts, and likewise for runRead at line 128 of read_commands.ts), so refCount === 0 is the correct test for a truly unreferenced symbol. Entry-point names are always excluded. */
export function isDeadSymbol(name: string, refCount: number): boolean {
  if (ENTRY_NAMES.has(name)) return false
  return refCount === 0
}

// ---- file cache helper used by multiple commands ----------------------------

/** Splits a `token-goat callers/call-chain/impact` positional argument into the bare symbol name to query plus, when a `::`-prefixed file was given, the raw file text -- the same `file::symbol` grammar `refs`/`brief` use to disambiguate WHICH same-named definition is meant. Reimplements read_commands.ts's unexported `parseReadSpec` locally via its exported `findSpecSeparator` instead of widening that module's public surface for a single three-line split; both stay in sync automatically since `findSpecSeparator` IS the shared separator logic both would otherwise duplicate. With no `::`, returns only `name` (the whole input unchanged), so every bare-symbol call path stays byte-for-byte identical to before this function existed. */
function parseGraphSymbolSpec(spec: string): { name: string; file?: string } {
  const colonIdx = findSpecSeparator(spec)
  if (colonIdx === -1) return { name: spec }
  return { name: spec.slice(colonIdx + 2), file: spec.slice(0, colonIdx) }
}

function buildFileSymCache(): (fp: string) => SymbolEntry[] {
  const cache = new Map<string, SymbolEntry[]>()
  return (fp: string): SymbolEntry[] => {
    let syms = cache.get(fp)
    if (syms === undefined) {
      syms = querySymbols({ filePath: fp, limit: ALL_SYMBOLS_IN_FILE_LIMIT }, undefined)
      cache.set(fp, syms)
    }
    return syms
  }
}

// ---- callers ----------------------------------------------------------------

export interface CallersOptions {
  symbol: string
  json?: boolean
  limit?: number
  /** `-C, --context <n>`: lines of real call-site source to show either side of each caller, in `grep -C`'s framing. Defaults to 0, in which case output is byte-for-byte unchanged. */
  context?: number
  /** `--exclude-tests`: drop callers whose call site lives in a test file (per isTestFile). Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only list callers whose enclosing symbol NAME matches this pattern (the primary field each row is keyed on: `symbol<TAB>file:line`). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
}

export interface CallerEntry {
  caller: string
  kind: string
  file: string
  line: number
}

/** True when `fp` has its own symbol definition named `name` -- used by {@link filterRefsForSymbol} to tell a local/shadowing reference apart from one that actually targets a different, same-named symbol elsewhere in the project. */
function fileDefinesName(fp: string, name: string, getSyms: (fp: string) => SymbolEntry[]): boolean {
  return getSyms(fp).some((s) => s.name === name)
}

/**
 * Filter `refs` (all matching a bare `name`) down to the ones plausibly attributable to the
 * symbol defined at `filePath`, for use when multiple symbols in the project share that name.
 *
 * The refs table has no import resolution -- a ref only records the bare callee name, never
 * which definition it binds to. Without this filter, a same-name reference anywhere in the
 * project counts as evidence for every same-named symbol project-wide: a genuinely dead
 * symbol in one file looks "alive" because of an unrelated call resolving to a different
 * file's same-named symbol, and `callers` misattributes that call to the wrong definition.
 *
 * A ref is kept when it is in the symbol's own defining file (the common case: a local call,
 * or an exported symbol imported elsewhere with no local shadow) or its file does NOT itself
 * define a same-named symbol (so it cannot be resolving to a local shadow instead). A ref in a
 * file that defines its OWN symbol of the same name is dropped for every OTHER same-named
 * symbol's computation, since a bare-name call there almost certainly resolves to that file's
 * local definition.
 *
 * This does not fully resolve every ambiguous case -- a third file with no local definition of
 * its own, calling a name that collides across two other files, still can't be attributed
 * precisely without real import resolution, which this index does not perform.
 */
function filterRefsForSymbol(
  refs: RefEntry[],
  name: string,
  filePath: string,
  getSyms: (fp: string) => SymbolEntry[],
): RefEntry[] {
  return refs.filter((ref) => foldPath(ref.filePath) === foldPath(filePath) || !fileDefinesName(ref.filePath, name, getSyms))
}

/** Resolves callers of a symbol: enclosing-function-aware, unlike the file-grouping-only logic in read_commands.ts's `refs --callers`. Shared by `runCallers` and `runBrief`.
 *
 * `filePath`, when provided, scopes the result to callers plausibly attributable to the symbol
 * defined there (via {@link filterRefsForSymbol}) -- needed when another symbol in the same
 * project shares `name`, so a caller of the other symbol isn't misattributed. Omitted by the
 * bare `token-goat callers <name>` CLI path, which intentionally reports every reference to
 * `name` project-wide regardless of which same-named definition it targets. */
export function resolveCallers(name: string, limit?: number, filePath?: string, rootDir?: string, excludeTests?: boolean): CallerEntry[] {
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope the ref lookup to the current project root so callers of a same-named
  // symbol in an unrelated project on the same machine don't leak into this project's results.
  // A caller that has already resolved its own project root (e.g. runCallers, which also needs
  // it to shorten the printed paths for HUMAN output) passes it in so this doesn't shell out to
  // git a second time for the same value.
  const resolvedRootDir = rootDir ?? resolveProjectRoot({ project: process.cwd() })
  // When excludeTests is set, the requested `limit` (or the 500 default) must apply AFTER
  // test-file refs are dropped, not before -- querying with the requested limit first would
  // silently under-return whenever test refs occupy slots that would otherwise hold production
  // callers. UNBOUNDED_REF_LIMIT scans everything in-project so the caller (runCallers) has full
  // headroom to filter by entry.file and re-slice to the requested limit itself.
  const queryLimit = excludeTests === true ? UNBOUNDED_REF_LIMIT : (limit ?? 500)
  const refs = queryRefs({ name, limit: queryLimit, rootDir: resolvedRootDir })
  const getSyms = buildFileSymCache()
  const scoped = filePath === undefined ? refs : filterRefsForSymbol(refs, name, filePath, getSyms)

  return scoped.map((ref) => {
    const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
    return {
      caller: enc?.name ?? '(module scope)',
      kind: enc?.kind ?? '',
      file: ref.filePath,
      line: ref.line,
    }
  })
}

export function runCallers(opts: CallersOptions): number {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero
  // rows regardless of whether callers exist -- silently reporting "no references found" for
  // a symbol that's actually called. Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  // Resolved once here (not left to resolveCallers' own internal default) so the same value
  // scopes the query AND shortens the printed paths below -- one git shell-out, not two.
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name, file } = parseGraphSymbolSpec(opts.symbol)
  // `file`, when present, only disambiguates WHICH same-named definition is meant -- resolved to an index-path hint and threaded straight into resolveCallers' pre-existing `filePath` parameter (its own `filterRefsForSymbol` attribution logic above), never used to filter queryRefs' results by call-SITE file, which is the exact bug 0ec04da8 fixed: a call site's file is where a call OCCURS, not where the symbol is DEFINED, so filtering refs by it would silently drop legitimate callers living in every other file.
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined
  if (fileHint !== undefined && querySymbols({ name, filePath: fileHint, limit: 1 }).length === 0) {
    emitErr(`Symbol '${name}' not found in '${file}'`)
    return 1
  }
  // resolveCallers must query unbounded (full headroom) whenever either --exclude-tests or
  // --grep is set, since both filter the resolved set client-side, AFTER the query -- slicing
  // to the requested limit before either filter runs would silently under-return by letting
  // suppressed/non-matching entries occupy slots ahead of the cutoff.
  // A `file::symbol` spec is the third such filter, and had been missed: resolveCallers runs filterRefsForSymbol (same-name attribution) on the rows the SQL LIMIT already chose, so refs belonging to a different same-named definition occupied slots ahead of the cutoff and were then dropped. `callers "a.ts::foo" --limit 2` returned one caller with truncated:false when three attributable callers existed. Same headroom treatment: scan unbounded, attribute, then slice.
  const unbounded = opts.excludeTests === true || opts.grep !== undefined || fileHint !== undefined
  // On the bounded path the SQL LIMIT is invisible once the rows come back: exactly `requestedLimit` rows reads the same whether that was the whole caller set or a page clipped out of a much larger one, so `truncated` reported false for a result that had silently dropped callers -- the same invocation with --grep (which forces the unbounded path) correctly reported true. Ask for one row past the limit and use the overflow purely as the truncation signal; the probe row is sliced off here and never reaches `filtered`, the counts, or the output.
  const requestedLimit = opts.limit ?? DEFAULT_REF_QUERY_LIMIT
  const probed = resolveCallers(name, unbounded ? opts.limit : requestedLimit + 1, fileHint, rootDir, unbounded)
  const sqlTruncated = !unbounded && probed.length > requestedLimit
  const resolved = sqlTruncated ? probed.slice(0, requestedLimit) : probed
  // Filter target is the caller's call SITE, not the resolved symbol's own definition site.
  const suppressed = opts.excludeTests === true ? resolved.filter((e) => isTestFile(e.file)).length : 0
  let filtered = opts.excludeTests === true ? resolved.filter((e) => !isTestFile(e.file)) : resolved
  // --grep narrows by the caller's enclosing symbol NAME (the field each row is keyed on:
  // `symbol<TAB>file:line`), and runs BEFORE the requested-limit slice below so it selects from
  // the whole (test-filtered) set rather than from an already-capped page.
  const preGrepCount = filtered.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  if (matchesGrep !== undefined) filtered = filtered.filter((e) => matchesGrep(e.caller))
  const entries = unbounded ? filtered.slice(0, opts.limit ?? 500) : filtered
  if (entries.length === 0) {
    // Distinguish "--grep matched none of the N callers that do exist" from a genuinely
    // caller-less symbol -- same "filtered store renders as populated" trap already fixed for
    // dead/deps/types. Checked first so it takes priority over the --exclude-tests message
    // below when both filters are active and --grep is what zeroed the remaining set.
    if (matchesGrep !== undefined && preGrepCount > 0) {
      // This branch exits 0 (the store is non-empty, the filter just matched none of it), so
      // under --json a prose notice would hand the consumer a success status with an unparseable
      // body. Emit the same `{items, truncated, totalCount}` envelope the populated branch below
      // does, with `totalCount: 0` -- the post-filter count, never `preGrepCount`. Matches
      // `types`' own filtered-to-empty --json branch; text mode keeps the human notice. The
      // `hiddenByGrep` count is what tells the consumer this empty page is a filtered view and
      // not a caller-less symbol -- `totalCount: 0` alone reads the same for both.
      if (opts.json === true) {
        emit(JSON.stringify({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preGrepCount }, null, 2))
        return 0
      }
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'caller', 'callers'))
      return 0
    }
    // "No references found" plus exit 1 for a symbol that IS referenced -- only from tests -- reads as "this symbol is unused", which invites deleting live code. Name the suppressed count so the filtered view is never mistaken for absence. Flag-absent output is untouched: suppressed is always 0 then.
    if (opts.excludeTests === true && suppressed > 0) {
      // Exit code stays 1 (unchanged, existing tests pin it), but under --json the body must
      // still be parseable JSON -- previously this fell through to emitErr's plain prose even
      // with --json set, the same "--json returns unparseable text" gap --grep's own sibling
      // branch above never had. `hiddenByExcludeTests` mirrors --grep's `hiddenByGrep`: it is
      // what tells a JSON consumer this is a filtered view, not a caller-less symbol.
      if (opts.json === true) {
        emit(JSON.stringify({ items: [], truncated: false, totalCount: 0, hiddenByExcludeTests: suppressed }, null, 2))
        return 1
      }
      emitErr(`No non-test references found for '${opts.symbol}' (${excludeTestsHiddenNote(suppressed)})`)
      return 1
    }
    // Distinguish "not indexed at all" from "indexed, genuinely zero callers" -- same trap as
    // above, one step earlier. `fileHint`, when set, already proved `name` exists in that file
    // (the check at the top of this function), so this can only fire on the bare-name path.
    if (querySymbols({ name, rootDir, limit: 1 }).length === 0) {
      emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(name, rootDir)}`)
      // Same empty-index note as the "No references found" branch below -- an empty project
      // index makes EVERY symbol look unindexed, so this must still surface the real cause.
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
    emitErr(`No references found for '${opts.symbol}'`)
    // Only paid after the query already came back empty, and only in text mode -- this branch
    // already emits plain prose regardless of --json (see runRefsSingle's sibling comment), so
    // there's no JSON envelope here to protect either way.
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  const contextLines = opts.context ?? 0

  if (opts.json === true) {
    // `contextLines` is added alongside the existing fields, never in place of any of them, so a consumer that ignores it sees today's payload verbatim. `file` is rewritten to the same root-relative spelling the text rows below render (toDisplayPath(rootDir, ...)) -- done AFTER contextLines is attached, since buildContextWindow reads real source off disk and needs the raw absolute path, not the display spelling.
    const withContext = contextLines > 0
      ? entries.map((e) => ({ ...e, contextLines: buildContextWindow(e.file, e.line, contextLines) ?? [] }))
      : entries
    // Shared `{items, truncated, totalCount}` envelope so `--json` consumers never branch on
    // payload shape. `totalCount` is `filtered.length` -- the post-`--exclude-tests`,
    // post-`--grep`, PRE-`--limit`-slice count. In the `unbounded` path `entries` is a slice of
    // `filtered`, so that slice also feeds `truncated`; in the bounded path the limit was already
    // applied in SQL, `entries === filtered`, and `filtered.length` is the honest count of what
    // this invocation actually resolved -- there, `sqlTruncated` (the +1 probe row above) is what
    // tells the consumer more callers exist beyond the page it was handed.
    const rows = withContext.map((e) => {
      const displayPath = toDisplayPath(rootDir, e.file)
      return { ...e, file: displayPath, filePath: displayPath }
    })
    const capped = guardJsonRows(rows)
    const limitTruncated = entries.length < filtered.length || sqlTruncated
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially
    // filtered page carries the count too rather than only the fully emptied one.
    const hiddenByGrep = preGrepCount - filtered.length
    // Same partial-suppression case for --exclude-tests: some (not all) callers were test-only
    // and pruned before this envelope was built, so the count belongs alongside hiddenByGrep
    // rather than only in the fully-emptied branch above.
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated || limitTruncated, totalCount: filtered.length, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}), ...(opts.excludeTests === true && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}) }, null, 2))
    return 0
  }

  // Additive note only: printed solely when --exclude-tests actually hid something, so default
  // (flag-absent) output is untouched and a filtered view is never mistaken for the whole graph.
  if (opts.excludeTests === true && suppressed > 0) {
    emit(`${countNoun(entries.length, 'caller')} found (${excludeTestsHiddenNote(suppressed)})`)
  }

  for (const e of entries) {
    const displayPath = toDisplayPath(rootDir, e.file)
    emit(`${e.caller}\t${displayPath}:${e.line}`)
    const window = buildContextWindow(e.file, e.line, contextLines)
    if (window !== null) for (const l of renderContextWindow(displayPath, e.line, window, '', '    ')) emit(l)
  }
  return 0
}

// ---- call-chain -------------------------------------------------------------

export interface CallChainOptions {
  symbol: string
  depth?: number
  json?: boolean
  /** `--exclude-tests`: prune callers whose call site lives in a test file (per isTestFile) before they're admitted to the BFS, so nothing walks through a test node. Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only keep chains containing at least one symbol NAME matching this pattern (BFS still walks the full graph; this only narrows which completed chains are reported). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
}

export function runCallChain(opts: CallChainOptions): number {
  // A depth of 0 (or negative) makes bfsCallChains short-circuit to `[[start]]` for ANY symbol,
  // indistinguishable from a genuine no-callers result -- reject it explicitly instead of letting
  // it silently masquerade as "no callers", matching runCallers'/runSimilar's own limit/top
  // validation convention.
  if (opts.depth !== undefined && opts.depth <= 0) {
    emitErr(`--depth must be a positive number, got: ${opts.depth}`)
    return 1
  }
  const maxDepth = opts.depth ?? 8
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope every ref lookup to the current project root so a same-named symbol in
  // an unrelated project on the same machine doesn't leak into this project's call chains.
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name, file } = parseGraphSymbolSpec(opts.symbol)
  // `file`, when present, only disambiguates WHICH same-named definition is the BFS root -- resolved to an index-path hint, never used to filter queryRefs' results by call-SITE file (the 0ec04da8 bug class: a call site's file is where a call OCCURS, not where the symbol is DEFINED).
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined

  // Verify the symbol is actually indexed before doing any BFS work -- otherwise a nonexistent
  // symbol falls straight through to bfsCallChains, which has no way to distinguish "no callers"
  // from "no such symbol" and returns `[[symbol]]` either way, fabricating a false "root entry
  // point" result (and, with --json, a machine-consumable one). Every sibling command
  // (similar/blame/refs/callers) already errors on an unknown symbol; this makes call-chain match.
  if (fileHint !== undefined) {
    // A `file::symbol` spec names a specific definition, so the existence check must be scoped to that file too -- matching refs'/brief's own "Symbol 'X' not found in 'Y'" wording verbatim rather than the generic message below, which stays reserved for the bare-name path.
    if (querySymbols({ name, filePath: fileHint, limit: 1 }).length === 0) {
      emitErr(`Symbol '${name}' not found in '${file}'`)
      // Only paid after the query already came back empty, and only in text mode -- this branch
      // already emits plain prose regardless of --json, matching runRefsSingle's convention.
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
  } else if (querySymbols({ name, rootDir, limit: 1 }).length === 0) {
    // Suggestion appended to the existing message rather than replacing it -- unlike
    // refs/callers/impact this command already distinguishes "not indexed" from "no callers"
    // (that's the whole point of this branch), so there's no separate wording to preserve here.
    emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(name, rootDir)}`)
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  // Hoisted once outside the BFS loop -- buildFileSymCache() must run a single time and be reused
  // across every node visited, not rebuilt per-node (which would defeat the point of caching it).
  const getSyms = buildFileSymCache()

  // Counts refs pruned by --exclude-tests across the whole BFS (root + every hop), so the
  // suppressed-everything message below can distinguish a filtered view from a genuinely
  // caller-less symbol. Flag-absent, this stays 0 and the message path below is unreachable.
  // Declared ABOVE the closure that mutates it: `callersOf` captures this binding, and today it
  // is only invoked later (via bfsCallChains), but a `let` declared after its own capturing
  // closure is a temporal-dead-zone trap for any future edit that calls the closure earlier.
  let suppressedCount = 0

  const callersOf: CallersOfFn = (n: string): string[] => {
    // Scanned uncapped, like runTestFor/runCoverageGaps: a call chain is a reachability claim, and queryRefs orders by (file_path, line) with no preference for the files that matter here. Under DEFAULT_REF_QUERY_LIMIT a name referenced 500+ times from alphabetically-earlier files loses every later ref at the cutoff, so a real caller (and the entire chain hanging off it) silently disappears -- and at the root hop filterRefsForSymbol can discard all 500 in-cap rows outright, turning a reachable symbol into "No call chains found".
    const refs = queryRefs({ name: n, limit: UNBOUNDED_REF_LIMIT, rootDir })
    if (refs.length === 0) return []
    // Only the ROOT hop (n === name, the exact symbol the spec asked to disambiguate) can be scoped by fileHint via filterRefsForSymbol, mirroring resolveCallers' own attribution pattern -- every hop beyond that resolves to a caller's bare symbol NAME with no file attached to disambiguate against, so it deliberately stays unscoped rather than fabricating a hint the BFS has no way to carry forward past the first hop.
    const scoped = fileHint !== undefined && n === name ? filterRefsForSymbol(refs, n, fileHint, getSyms) : refs
    const names = new Set<string>()
    for (const ref of scoped) {
      // Skipped before the caller is admitted so the BFS never walks THROUGH a test node -- a
      // test-file caller that itself has real (non-test) callers must not drag them in either.
      // Filter target is the call SITE (ref.filePath), never the resolved symbol's own definition
      // site (the 0ec04da8 bug class documented above).
      if (opts.excludeTests === true && isTestFile(ref.filePath)) {
        suppressedCount += 1
        continue
      }
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc !== null) names.add(enc.name)
    }
    return [...names]
  }

  const chains = bfsCallChains(name, callersOf, maxDepth)

  // bfsCallChains can never return an empty array -- a caller-less tip still pushes its chain
  // via `complete.push(chain)`, so `[[symbol]]` (one chain, one element) is the actual "no
  // callers" signal, not `chains.length === 0`. The depth<=0 rejection above rules out the only
  // other way bfsCallChains produces this exact shape (its own `maxDepth <= 0` short-circuit).
  const noCallers = chains.length === 1 && chains[0]?.length === 1 && chains[0][0] === name

  // --grep runs on the completed chains, AFTER the BFS -- it narrows which chains get reported,
  // never which nodes the walk visits, so a chain that passes THROUGH a matching symbol on its
  // way to an unrelated root still surfaces. Skipped entirely for the degenerate "no callers"
  // chain so that case keeps its own dedicated message below rather than being reinterpreted as
  // "--grep matched nothing".
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredChains = matchesGrep !== undefined && !noCallers ? chains.filter((chain) => chain.some((n) => matchesGrep(n))) : chains

  if (opts.json === true) {
    // How many chains --grep dropped, so a JSON consumer can tell "the filter matched none of the
    // N chains that exist" from "genuinely no callers" -- `chains: []` alone says both. Omitted
    // when zero (flag absent, or nothing filtered) so default output stays byte-identical, same
    // convention as brief --json's own hiddenByGrep.
    const hiddenByGrep = chains.length - filteredChains.length
    // Same disambiguation as hiddenByGrep above, but for --exclude-tests: `chains: [[name]]`
    // (the noCallers shape) reads the same whether the symbol has zero real callers or every
    // caller was test-only and pruned by the BFS. Only meaningful in the noCallers shape --
    // --exclude-tests never zeroes a non-empty chain set the way --grep can, it only prunes BFS
    // hops before chains are built. Text mode's own sibling branch below already names this.
    const hiddenByExcludeTests = noCallers && opts.excludeTests === true ? suppressedCount : 0
    emit(JSON.stringify({ chains: filteredChains, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}), ...(hiddenByExcludeTests > 0 ? { hiddenByExcludeTests } : {}) }, null, 2))
    return 0
  }

  if (noCallers) {
    // "(no callers)" plus exit 0 for a symbol that IS called -- only from tests -- reads as
    // genuinely unreferenced. Name the suppressed count so the filtered view is never mistaken
    // for absence. Flag-absent, suppressedCount is always 0 so this stays unreachable and output
    // is byte-identical to today.
    if (opts.excludeTests === true && suppressedCount > 0) {
      emit(`${name}  (no non-test callers; ${excludeTestsHiddenNote(suppressedCount)})`)
      return 0
    }
    emit(`${name}  (no callers)`)
    return 0
  }

  if (matchesGrep !== undefined && filteredChains.length === 0) {
    // Distinguish "--grep matched none of the N chains that do exist" from a genuinely
    // caller-less symbol -- same "filtered store renders as populated" trap already fixed for
    // dead/deps/types/callers.
    emit(grepFilteredToEmptyNotice(chains.length, opts.grep as string, 'chain', 'chains'))
    return 0
  }

  for (const chain of filteredChains) {
    emit(chain.join(' -> '))
  }
  return 0
}

// ---- impact -----------------------------------------------------------------

export interface ImpactOptions {
  symbol: string
  top?: number
  json?: boolean
  /** `--exclude-tests`: prune callers (including module-scope entries) whose call site lives in a test file (per isTestFile) before they're admitted to the BFS, so nothing walks through a test node. Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** `--grep`: only show impacted entries whose symbol name (or module-scope key) matches this pattern; applied AFTER the BFS but BEFORE the `--top` slice, matching runDead/runCallers' own grep-before-top convention. */
  grep?: string
}

/**
 * Deterministic tiebreak for impact-hop entries: primary key is hop distance,
 * secondary is a plain ordinal (UTF-16 code-unit) string comparison. Never use
 * localeCompare() here -- with no explicit locale it resolves to the host's
 * default ICU collation (Windows regional setting, or LANG/LC_ALL on
 * Linux/CI), which genuinely differs across locales for non-ASCII names (for
 * example sv-SE collates the letter after 'z' in the Swedish alphabet
 * differently than en-US/de-DE do). Since runImpact() sorts BEFORE slicing to
 * top-N, a locale-dependent tiebreak can silently return a different SET of
 * impacted callers on different machines, not just a different order.
 */
export function compareHopEntries(a: readonly [string, number], b: readonly [string, number]): number {
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

export function runImpact(opts: ImpactOptions): number {
  // A --top of 0 (or negative) would slice the sorted hop list down to zero entries and report
  // "No callers found" even when callers genuinely exist -- reject explicitly instead of
  // silently rendering an empty result, matching runRefs' own --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 20
  const DEPTH_CAP = 8
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope every ref lookup to the current project root so a same-named symbol in
  // an unrelated project on the same machine doesn't leak into this project's impact analysis.
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name: rootName, file } = parseGraphSymbolSpec(opts.symbol)
  // `file`, when present, only disambiguates WHICH same-named definition is the BFS root -- resolved to an index-path hint, never used to filter queryRefs' results by call-SITE file (the 0ec04da8 bug class: a call site's file is where a call OCCURS, not where the symbol is DEFINED).
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined
  // Unlike runCallChain, runImpact never checked symbol existence up front (a nonexistent bare name just BFS's to zero refs and reports "No callers found" below, which is a fine existing contract) -- this check is added ONLY on the file::symbol path, where a spec names a specific definition and must match refs'/brief's own "Symbol 'X' not found in 'Y'" wording rather than silently falling through to the generic empty-result message.
  if (fileHint !== undefined && querySymbols({ name: rootName, filePath: fileHint, limit: 1 }).length === 0) {
    emitErr(`Symbol '${rootName}' not found in '${file}'`)
    return 1
  }
  // Hoisted once outside the BFS loop -- buildFileSymCache() must run a single time and be reused
  // across every node visited, not rebuilt per-node (which would defeat the point of caching it).
  const getSyms = buildFileSymCache()

  const hops = new Map<string, number>([[rootName, 0]])
  const queue: Array<[string, number]> = [[rootName, 0]]
  // Counts refs pruned by --exclude-tests across the whole BFS, so the suppressed-everything
  // message below can distinguish a filtered view from a genuinely caller-less symbol.
  // Flag-absent, this stays 0 and the message branch below is unreachable.
  let suppressedCount = 0
  // Counts BFS nodes that reached DEPTH_CAP and were therefore never expanded. Non-zero means the impacted set below is a floor, not the whole set, and the notice at the end says so: without it a depth-truncated result is byte-identical to a complete one, the same gap call-chain closed with its own `(depth-limit)` sentinel.
  let depthCapped = 0

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    const [name, depth] = item
    if (depth >= DEPTH_CAP) { depthCapped += 1; continue }
    // Scanned uncapped for the same reason runCallChain's callersOf is: impact is a reachability claim, so a ref dropped at DEFAULT_REF_QUERY_LIMIT's (file_path, line) cutoff does not just omit one row, it prunes every symbol reachable only through that caller.
    const refs = queryRefs({ name, limit: UNBOUNDED_REF_LIMIT, rootDir })
    // Only the ROOT hop (name === rootName, the exact symbol the spec asked to disambiguate) can be scoped by fileHint via filterRefsForSymbol, mirroring resolveCallers'/runCallChain's own attribution pattern -- every hop beyond that resolves to a caller's bare symbol NAME with no file attached to disambiguate against.
    const scoped = fileHint !== undefined && name === rootName ? filterRefsForSymbol(refs, name, fileHint, getSyms) : refs
    for (const ref of scoped) {
      // Skipped before the caller (or module-scope entry) is admitted so the BFS never walks
      // THROUGH a test node -- a test-file caller that itself has real (non-test) callers must
      // not drag them into the impacted set. Filter target is the call SITE (ref.filePath),
      // never the resolved symbol's own definition site (the 0ec04da8 bug class documented
      // above). Must run before the module-scope branch below too: it `continue`s before the
      // normal caller-admission code, so a naive skip placed after it would miss test-file
      // top-level references entirely.
      if (opts.excludeTests === true && isTestFile(ref.filePath)) {
        suppressedCount += 1
        continue
      }
      const newHop = depth + 1
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc === null) {
        // Module-scope reference (top-level code, not inside a function/class) -- surface it as a
        // file-level entry instead of silently dropping it, mirroring resolveCallers' '(module
        // scope)' handling below. Not enqueued for further BFS since a bare file path has no
        // symbol name to look up callers for.
        const fileKey = `(module scope) ${ref.filePath}`
        const existing = hops.get(fileKey)
        if (existing === undefined || existing > newHop) hops.set(fileKey, newHop)
        continue
      }
      const callerName = enc.name
      const existing = hops.get(callerName)
      if (existing === undefined || existing > newHop) {
        hops.set(callerName, newHop)
        queue.push([callerName, newHop])
      }
    }
  }

  hops.delete(rootName)

  const allSorted = [...hops.entries()].sort(compareHopEntries)
  // --grep narrows the impacted set BEFORE the --top slice, matching runDead/runCallers' own
  // grep-before-top convention -- filtering after would silently under-return by selecting from
  // an already-capped page instead of the whole impacted set.
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const grepped = matchesGrep !== undefined ? allSorted.filter(([symbol]) => matchesGrep(symbol)) : allSorted
  const sorted = grepped.slice(0, top)

  // Both notices go to stderr because `impact --json` is a deliberate bare array (it is on json_envelope_shape's NON_ENVELOPE_JSON_COMMANDS list) with nowhere to carry a truncation flag -- same channel the --grep-filtered-to-empty notice below already uses, so stdout keeps its shape while the human (and anything reading both streams) can tell a clipped impact set from a complete one.
  if (depthCapped > 0) {
    emitErr(`Impact truncated at the ${DEPTH_CAP}-hop depth limit: ${depthCapped} symbol${depthCapped === 1 ? '' : 's'} at that depth ${depthCapped === 1 ? 'was' : 'were'} not expanded, so callers reachable only beyond ${DEPTH_CAP} hops are missing.`)
  }
  if (grepped.length > sorted.length) {
    emitErr(`Showing top ${sorted.length} of ${grepped.length} impacted symbols (raise --top to see the rest).`)
  }

  if (matchesGrep !== undefined && sorted.length === 0 && allSorted.length > 0) {
    // Distinguish "--grep matched none of the N impacted symbols that do exist" from a
    // genuinely impact-free symbol -- same "filtered store renders as populated" trap already
    // fixed for dead/deps/types/callers/call-chain. Those carry a `hiddenByGrep` key, which this
    // command has nowhere to put: `impact --json` is a deliberate bare array (it is on
    // json_envelope_shape's NON_ENVELOPE_JSON_COMMANDS list), and wrapping it in an envelope to
    // hold one diagnostic would break every existing consumer. So stdout keeps the bare `[]` the
    // populated branch's shape demands, and the count goes to stderr instead of being dropped --
    // the distinction survives for a human and for anything reading both streams, without the
    // parsed payload changing shape between the filtered and unfiltered cases.
    if (opts.json === true) {
      emitErr(grepFilteredToEmptyNotice(allSorted.length, opts.grep as string, 'impacted symbol', 'impacted symbols'))
      emit(JSON.stringify([], null, 2))
      return 0
    }
    emit(grepFilteredToEmptyNotice(allSorted.length, opts.grep as string, 'impacted symbol', 'impacted symbols'))
    return 0
  }

  if (sorted.length === 0) {
    // "No callers found" for a symbol that IS called -- only from tests -- reads as genuinely
    // unreferenced and invites deleting live code. Name the suppressed count so the filtered
    // view is never mistaken for absence. Flag-absent, suppressedCount is always 0 so this
    // stays unreachable and output/exit code is byte-identical to today.
    if (opts.excludeTests === true && suppressedCount > 0) {
      // Exit code stays 1 (unchanged, existing tests pin it), but under --json the body must
      // still be parseable -- previously this fell through to emitErr's plain prose even with
      // --json set, the same "--json returns unparseable text" gap runRefsSingle had. `[]`
      // matches the shape the populated branch below emits (a bare array, no envelope object),
      // so a --json consumer never has to branch on payload shape between the two exit codes.
      if (opts.json === true) {
        emit(JSON.stringify([], null, 2))
        return 1
      }
      emitErr(`No non-test impact found for '${opts.symbol}' (${excludeTestsHiddenNote(suppressedCount)})`)
      return 1
    }
    // Distinguish "not indexed at all" from "indexed, genuinely zero impact" -- same trap as
    // runCallers/runRefsSingle. `fileHint`, when set, already proved `rootName` exists in that
    // file (the check near the top of this function), so this can only fire on the bare-name path.
    if (querySymbols({ name: rootName, rootDir, limit: 1 }).length === 0) {
      emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(rootName, rootDir)}`)
      return 1
    }
    emitErr(`No callers found for '${opts.symbol}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(sorted.map(([symbol, h]) => ({ symbol, hops: h })), null, 2))
    return 0
  }

  // `symbol` is either a real symbol name or a synthetic "(module scope) <file>" key (see the
  // fileKey branch above); only the latter embeds an indexed path that needs shortening for
  // HUMAN output -- a real symbol name must never be run through toDisplayPath.
  const MODULE_SCOPE_PREFIX = '(module scope) '
  for (const [symbol, h] of sorted) {
    const displaySymbol = symbol.startsWith(MODULE_SCOPE_PREFIX)
      ? MODULE_SCOPE_PREFIX + toDisplayPath(rootDir, symbol.slice(MODULE_SCOPE_PREFIX.length))
      : symbol
    emit(`${displaySymbol}\t(hops: ${h})`)
  }
  return 0
}

// ---- dead -------------------------------------------------------------------

/** How many `extends` links to walk up a class hierarchy when looking for a virtual-dispatch base -- deep enough for any realistic chain, capped against a corrupt/cyclic extends graph. */
const MAX_ANCESTOR_DEPTH = 8

/** The direct base class name a class extends, per the extends-clause ref recorded at its own declaration (`context` = the extending class's name -- or, for an anonymous class expression, its enclosing named function's name, see {@link enclosingNamedScope} -- `name` = the extended class; see the extends-clause parser fix). `scopeName` is whatever {@link enclosingNamedScope} resolved for the class in question. Returns null when there's no such ref (no base class, or an unresolvable heritage expression). */
function directBaseClassName(scopeName: string, classFile: string, rootDir: string): string | null {
  const candidates = queryRefsByContext(scopeName, classFile)
  for (const ref of candidates) {
    if (querySymbols({ name: ref.name, kind: 'class', limit: 1, rootDir }).length > 0) return ref.name
  }
  return null
}

/**
 * True when a method named `methodName`, whose own class/scope resolves to `scopeName` (declared
 * in `classFile` -- see {@link enclosingNamedScope} for why this may be a function name rather
 * than a class name), is reachable through a self-dispatch call (`this.<methodName>(...)`)
 * recorded inside one of its ancestor classes' own files -- the classic polymorphic-override
 * pattern (e.g. `compressBody` overrides in `tool_filters/*.ts`, all dispatched through one
 * `this.compressBody(...)` call in the shared base class `tool_filters/base.ts`).
 * `filterRefsForSymbol`'s cross-file heuristic (a ref is attributed elsewhere only if its own
 * file doesn't ALSO define the same name) misattributes that one shared dispatch ref entirely to
 * the base class's own same-named method, starving every subclass override of credit for it --
 * this check restores that credit by walking the extends chain and looking for the base's own
 * self-referential ref directly, bypassing the cross-file heuristic for this specific
 * ancestor-dispatch shape.
 */
function hasAncestorDispatchRef(methodName: string, scopeName: string, classFile: string, rootDir: string): boolean {
  let currentName = scopeName
  let currentFile = classFile
  const seen = new Set<string>([scopeName])
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const baseName = directBaseClassName(currentName, currentFile, rootDir)
    if (baseName === null || seen.has(baseName)) return false
    seen.add(baseName)
    const baseSyms = querySymbols({ name: baseName, kind: 'class', limit: 1, rootDir })
    const baseSym = baseSyms[0]
    if (baseSym === undefined) return false
    const baseRefs = queryRefs({ name: methodName, filePath: baseSym.filePath, limit: DEFAULT_REF_QUERY_LIMIT, rootDir })
    if (baseRefs.some((ref) => ref.line >= baseSym.lineStart && ref.line <= baseSym.lineEnd)) return true
    currentName = baseName
    currentFile = baseSym.filePath
  }
  return false
}

// Generic (non-type-specific) symbol `kind` values every language adapter in this repo is known
// to emit, plus every adapter-specific kind not already covered by TYPE_KINDS below (Apex,
// GraphQL/proto siblings aside, this also covers Salesforce/Liquid/LWC bundle kinds, doc/markup
// kinds like 'heading'/'section', and config-file kinds like 'env_key'/'key'). CORE_SYMBOL_KINDS
// itself is assembled as a union with TYPE_KINDS further down so the two lists cannot drift apart
// the way they did before this fix (see CORE_SYMBOL_KINDS's own comment).
const GENERIC_SYMBOL_KINDS: ReadonlyArray<string> = [
  'function', 'method', 'class', 'variable', 'const', 'namespace', 'module', 'property',
  'field', 'constructor', 'macro', 'alias', 'directive', 'var', 'impl',
]
// Adapter-specific kinds not already covered by GENERIC_SYMBOL_KINDS or TYPE_KINDS -- doc/markup
// kinds ('heading', 'section', 'selector', 'html_class', 'html_id'), config-file kinds ('env_key',
// 'key'), and the Salesforce/Liquid/LWC family ('apex_method', 'sf_*', 'liquid_*', 'lwc_*'). Kept
// deliberately in this list rather than folded into GENERIC_SYMBOL_KINDS above: `dead --kind
// property` already returns rows from package.json/package-lock.json today, so `dead` already
// operates on non-code kinds in practice -- excluding these doc/markup/config kinds here would be
// an inconsistent carve-out, not a principled one, so they're included for the same reason.
const OTHER_ADAPTER_SYMBOL_KINDS: ReadonlyArray<string> = [
  'heading', 'selector', 'env_key', 'key', 'section', 'html_class', 'html_id',
  'apex_method', 'sf_record_type', 'sf_apex_class', 'sf_flow', 'sf_flow_record_lookup',
  'sf_flow_action', 'sf_flow_subflow', 'sf_mystery_type', 'sf_lightning_component_bundle',
  'sf_lwc_target', 'sf_lwc_property', 'liquid_schema', 'liquid_section_file',
  'lwc_bundle', 'lwc_component_alias', 'lwc_api_property', 'lwc_api_method', 'lwc_ref',
]

export interface DeadOptions {
  kind?: string
  includePrivate?: boolean
  top?: number
  json?: boolean
  /** `--exclude-tests`: drop dead symbols DEFINED in a test file (per isTestFile), not ones merely referenced there. Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only list dead symbols whose NAME matches this pattern. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
}

export function runDead(opts: DeadOptions): number {
  // A --top of 0 (or negative) would slice the results list down to zero entries and report "No
  // dead symbols found." even when dead symbols genuinely exist -- reject explicitly instead of
  // silently rendering a false-clean result, matching runRefs' own --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  // Comma-separated, matching every other multi-spec surface in this CLI (read/refs/skeleton/
  // outline/section) -- splits on ',', trims, drops empties; `--kind` absent keeps the old
  // single-kind default untouched.
  const kinds = opts.kind !== undefined
    ? [...new Set(opts.kind.split(',').map((k) => k.trim()).filter((k) => k.length > 0))]
    : ['function']
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts) -- both the symbol scan and the per-symbol ref-count lookup must be scoped
  // to the current project root, or a function dead in this project but referenced by a
  // same-named symbol in an unrelated project on the same machine is wrongly scored ALIVE.
  const rootDir = resolveProjectRoot({ project: process.cwd() })

  // An unrecognized kind (typo, or a kind this language's adapter never emits) must not silently
  // fall through to zero rows and read as a clean codebase. Validated against the UNION of what
  // this project's own index already contains (distinctSymbolKinds) and CORE_SYMBOL_KINDS, a
  // static list of kind names every language adapter in this repo is known to emit -- the
  // index alone is not enough, since a genuinely valid kind (e.g. 'class' in a project with zero
  // classes) would never appear in a small project's own distinct-kind set and would otherwise be
  // wrongly rejected as unrecognized (see the empty-index-hint guard's "class" fixture case).
  // CORE_SYMBOL_KINDS is checked on its own first, and the index is only consulted for a kind that
  // list does not already cover. The scoped distinct-kind query cannot use an index (the project
  // scope is a LIKE over a lowercased column), so it scans the whole shared index: 171ms of a
  // 785ms `dead` here, spent to re-derive an answer the static list already had. The union below
  // is unchanged for the case that needs it, and only that case pays for it.
  let knownKinds: string[] = [...CORE_SYMBOL_KINDS]
  let unknownKinds = kinds.filter((k) => !knownKinds.includes(k))
  if (unknownKinds.length > 0) {
    knownKinds = [...new Set([...distinctSymbolKinds(rootDir), ...CORE_SYMBOL_KINDS])]
    unknownKinds = kinds.filter((k) => !knownKinds.includes(k))
  }
  if (unknownKinds.length > 0) {
    const label = unknownKinds.length === 1 ? 'kind' : 'kinds'
    const quoted = unknownKinds.map((k) => `'${k}'`).join(', ')
    emitErr(`Unrecognized ${label}: ${quoted}`)
    for (const k of unknownKinds) {
      const closes = rankSimilarNames(knownKinds, k)
      if (closes.length > 0) emitErr(didYouMean(closes))
    }
    return 1
  }

  // Scanned uncapped. The previous 5000-per-kind cap was exceeded by real projects (querySymbols orders by (file_path, line), so past 5000 every symbol in the alphabetically-later part of the tree went unexamined), and nothing downstream said so: `totalCount` counted the SCANNED set while reading as the whole one, so half a project's dead code was invisible with no notice at all.
  const syms = kinds.flatMap((k) => querySymbols({ kind: k, limit: UNBOUNDED_REF_LIMIT, rootDir }))
  const getSyms = buildFileSymCache()

  const results: Array<{ name: string; kind: string; file: string; line: number }> = []

  let suppressed = 0
  for (const sym of syms) {
    if (opts.includePrivate !== true && sym.name.startsWith('_')) continue
    // limit raised from 1 to 500 (matching resolveCallers' default cap): a bare-name existence
    // check can no longer stop at the first match, since that match might be filtered out below
    // as belonging to a different, same-named symbol elsewhere in the project.
    const refs = queryRefs({ name: sym.name, limit: DEFAULT_REF_QUERY_LIMIT, rootDir })
    let scoped = filterRefsForSymbol(refs, sym.name, sym.filePath, getSyms)
    // A "dead" verdict is an absence claim, so it must not be made over a truncated scan. queryRefs orders by (file_path, line) and caps at DEFAULT_REF_QUERY_LIMIT, while filterRefsForSymbol then DISCARDS every ref living in a file that defines its own same-named symbol -- so for a widely-used name, all 500 rows inside the cap can be discarded while the genuine callers sit just past it, and a live symbol is reported dead. Re-run the query uncapped, but only when the cap was actually reached and the scoped set came back empty, so the expensive scan is paid for the handful of candidate-dead common names rather than for every symbol. Same UNBOUNDED_REF_LIMIT rescue runTestFor and runCoverageGaps already use.
    if (scoped.length === 0 && refs.length >= DEFAULT_REF_QUERY_LIMIT) {
      scoped = filterRefsForSymbol(queryRefs({ name: sym.name, limit: UNBOUNDED_REF_LIMIT, rootDir }), sym.name, sym.filePath, getSyms)
    }
    if (!isDeadSymbol(sym.name, scoped.length)) continue
    // Rescue check for methods only: a zero-ref method might be a polymorphic override reached
    // only through a base class's own self-dispatch (`this.<method>(...)`) -- see
    // hasAncestorDispatchRef's doc comment.
    if (sym.kind === 'method') {
      const ownScope = enclosingNamedScope(getSyms(sym.filePath), sym.lineStart)
      if (ownScope !== null && hasAncestorDispatchRef(sym.name, ownScope.name, sym.filePath, rootDir)) continue
    }
    // Filter target is the symbol's own DEFINITION site, not a reference site -- a dead
    // symbol defined in a test file (fixture, test helper) is what --exclude-tests hides here,
    // unlike refs/callers which filter on where a REFERENCE occurs. Applied only once the
    // symbol is confirmed dead, so `suppressed` counts dead symbols hidden, not every test-file
    // symbol scanned. Also applied before the --top slice below, or the flag would silently
    // under-return by leaving suppressed test entries occupying slots ahead of the cutoff.
    if (opts.excludeTests === true && isTestFile(sym.filePath)) {
      suppressed += 1
      continue
    }
    results.push({ name: sym.name, kind: sym.kind, file: sym.filePath, line: sym.lineStart })
  }

  // --grep narrows the confirmed-dead set (after --exclude-tests already dropped test-file
  // definitions), and it runs BEFORE the --top slice so it selects from the whole dead set
  // rather than from an already-capped page.
  const preGrepCount = results.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const grepped = matchesGrep !== undefined ? results.filter((r) => matchesGrep(r.name)) : results
  const sliced = grepped.slice(0, opts.top ?? grepped.length)

  if (opts.json === true) {
    // `file` rewritten to the same root-relative spelling the text rows below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing.
    // Shared `{items, truncated, totalCount}` envelope, emitted unconditionally (empty result
    // included) so `--json` consumers never branch on payload shape. `totalCount` is
    // `grepped.length` -- the post-`--exclude-tests`, post-`--grep`, PRE-`--top` count -- not
    // `sliced.length`, which would report the already-truncated page as if it were the total.
    // `--top` therefore also feeds `truncated`, same as the `--head` handling in read_commands.
    const capped = guardJsonRows(sliced.map((r) => {
      const displayPath = toDisplayPath(rootDir, r.file)
      return { ...r, file: displayPath, filePath: displayPath }
    }))
    const topTruncated = sliced.length < grepped.length
    // How many dead symbols --grep dropped, omitted when zero: `items: []` with `totalCount: 0`
    // alone cannot tell a filtered-to-empty view from a genuinely clean codebase, and the text
    // branch below already says so in prose. Same convention as brief --json's hiddenByGrep.
    const hiddenByGrep = preGrepCount - grepped.length
    // Same disambiguation, but for --exclude-tests: `items: []`/`totalCount: 0` alone cannot
    // tell "--exclude-tests hid every dead symbol" from "no dead symbols hidden by tests
    // either, the codebase is genuinely clean" -- brief's own hiddenByExcludeTests field, same
    // omit-when-zero convention.
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated || topTruncated, totalCount: grepped.length, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}), ...(opts.excludeTests === true && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}) }, null, 2))
    return 0
  }

  if (sliced.length === 0) {
    // Distinguish "--grep matched none of the N dead symbols that do exist" from a genuinely
    // clean codebase (or one fully hidden by --exclude-tests below) -- same "filtered store
    // renders as populated" trap already fixed for skeleton/outline.
    if (matchesGrep !== undefined && preGrepCount > 0) {
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'dead symbol', 'dead symbols'))
      return 0
    }
    // When --exclude-tests filtered EVERYTHING out, a bare "No dead symbols found." is indistinguishable from a genuinely clean codebase, so the agent concludes there is nothing to do while findings sit hidden behind the flag. Say what was suppressed. Flag-absent output is untouched: suppressed is always 0 then.
    if (opts.excludeTests === true && suppressed > 0) {
      emit(`No dead symbols found (${excludeTestsHiddenNote(suppressed)}).`)
    } else {
      emit('No dead symbols found.')
    }
    // Only paid after the query already came back empty (this branch is only reached once the
    // --json path above has already returned, so this is always text mode).
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) emit(emptyIndexMessage(rootDir))
    return 0
  }

  // Additive note only: printed solely when --exclude-tests actually hid something, so default
  // (flag-absent) output is untouched and a filtered view is never mistaken for the whole graph.
  if (opts.excludeTests === true && suppressed > 0) {
    emit(`${countNoun(sliced.length, 'dead symbol')} (${excludeTestsHiddenNote(suppressed)})`)
  }

  for (const r of sliced) {
    emit(`${r.name}\t${toDisplayPath(rootDir, r.file)}:${r.line}`)
  }
  return 0
}

// ---- deps -------------------------------------------------------------------

export interface DepsOptions {
  file: string
  json?: boolean
  /** Only list dependencies whose MODULE SPECIFIER (internal path or external package name) matches this pattern. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
}

// `.mts`/`.cts` are real, recognized TypeScript source extensions elsewhere in this codebase
// (parser_types.ts's EXTENSION_LANGUAGE map, ts_refs.ts's TS_EXTENSIONS) but were missing here,
// so a relative import resolving onto a .mts/.cts file (e.g. "./config" backed by
// "./config.cts") never matched and fell through as an unresolved specifier.
const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp', '.hpp',
]

export function runDeps(opts: DepsOptions): number {
  let text: string
  try {
    text = decodeSource(fs.readFileSync(opts.file))
  } catch {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const ext = importsExtensionFor(opts.file)
  const raw = extractImports(text, ext)
  const dir = path.dirname(opts.file)

  const internal: string[] = []
  const external: string[] = []

  for (const imp of raw) {
    if (imp.startsWith('./') || imp.startsWith('../')) {
      const base = path.resolve(dir, imp)
      let resolved = imp
      if (fs.existsSync(base) && fs.statSync(base).isFile()) {
        resolved = base
      } else {
        // NodeNext/ESM-style specifiers reference the compiled-.js output even when the
        // source is TypeScript ("./foo.js" resolving to foo.ts) -- this codebase's own
        // imports are written that way. Appending a source extension onto a base that
        // already ends in one of them (e.g. base + '.ts' -> 'foo.js.ts') never matches
        // anything, so strip a recognized source extension from base first and search from
        // the bare stem instead.
        const baseExt = path.extname(base)
        const bareBase = SOURCE_EXTENSIONS.includes(baseExt) ? base.slice(0, -baseExt.length) : base
        for (const srcExt of SOURCE_EXTENSIONS) {
          const candidate = bareBase + srcExt
          if (fs.existsSync(candidate)) {
            resolved = candidate
            break
          }
        }
        // A specifier pointing at a directory (barrel import, e.g. "./utils" backed by
        // "./utils/index.ts") never matches the bareBase+ext probes above -- those only try
        // appending an extension directly onto the directory's own path, never look inside it.
        // Without this fallback the raw unresolved specifier is pushed instead of the real file,
        // unlike runArch's resolveRelImport (which already has this same index.* fallback), so
        // `token-goat deps` silently under-resolves barrel imports that `token-goat arch` resolves
        // correctly.
        if (resolved === imp && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
          for (const srcExt of SOURCE_EXTENSIONS) {
            const candidate = path.join(base, 'index' + srcExt)
            if (fs.existsSync(candidate)) {
              resolved = candidate
              break
            }
          }
        }
      }
      internal.push(resolved)
    } else if (/^\.+/.test(imp)) {
      // Python relative import ("from . import foo", "from ..pkg import bar")
      // -- a leading-dot module name can only resolve within the current
      // package, so it's always internal even though it never matches an
      // external package name and has no "./"/"../" path prefix to key off.
      internal.push(imp)
    } else {
      external.push(imp)
    }
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  // Only resolved entries are absolute filesystem paths; unresolved specifiers and Python
  // bare module names (pushed above as-is) aren't real paths and must pass through unchanged.
  // Normalize before handing to toDisplayPath, which returns the target verbatim when it cannot relativize (a file outside this project). Without this the fallback keeps native backslashes while the payload's own `file` field is forward-slash, so the two disagree in exactly the case the relative form cannot cover. Unresolved specifiers and bare module names are not paths and pass through untouched.
  const displayInternal = internal.map((i) => (path.isAbsolute(i) ? toDisplayPath(rootDir, normalizePath(i)) : i))

  // --grep filters on the specifier each row lists: the resolved/display path for internal
  // deps, the bare package name for external ones. Applied before any output is built, so it
  // selects from the whole dependency set rather than an already-formatted page.
  const preFilterCount = displayInternal.length + external.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredInternal = matchesGrep !== undefined ? displayInternal.filter((i) => matchesGrep(i)) : displayInternal
  const filteredExternal = matchesGrep !== undefined ? external.filter((e) => matchesGrep(e)) : external

  if (opts.json === true) {
    // `file` echoed the argument verbatim, so an absolute or backslash-spelled argument produced a payload whose own two path fields disagreed no matter how `internal` was rendered. Relative arguments -- the common case -- are unchanged by normalizePath.
    // How many dependencies --grep dropped, omitted when zero: two empty arrays alone cannot tell
    // a filtered-to-empty view from a file with no dependencies, which is exactly what the text
    // branch below spells out in prose. Same convention as brief --json's hiddenByGrep.
    const hiddenByGrep = preFilterCount - (filteredInternal.length + filteredExternal.length)
    emit(JSON.stringify({ file: toDisplayPath(rootDir, normalizePath(opts.file)), internal: filteredInternal, external: filteredExternal, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) }, null, 2))
    return 0
  }

  if (matchesGrep !== undefined && preFilterCount > 0 && filteredInternal.length === 0 && filteredExternal.length === 0) {
    emit(grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'dependency', 'dependencies'))
    return 0
  }

  if (filteredInternal.length > 0) {
    emit('internal:')
    for (const i of filteredInternal) emit(`  ${i}`)
  }
  if (filteredExternal.length > 0) {
    emit('external:')
    for (const e of filteredExternal) emit(`  ${e}`)
  }
  if (filteredInternal.length === 0 && filteredExternal.length === 0) {
    emit('(no imports found)')
  }
  return 0
}

// ---- types ------------------------------------------------------------------

// 'protocol' (Swift) is a type declaration exactly analogous to 'interface' -- already fixed
// once for Rust's 'union' (which is analogous to struct/enum/trait); the same gap existed for
// Swift protocols, indexed by languages/swift.ts but never surfaced by `token-goat types`.
// 'opaque' (Zig) is the same gap again: languages/zig.ts's CONTAINER_RE matches
// struct/enum/union/opaque with one shared code path, but only struct/enum/union were ever
// added here -- opaque types were indexed and silently excluded from `token-goat types`.
// 'mixin' (Dart) and 'extension' (Dart, Swift) are the same gap a fourth time: languages/dart.ts's
// MIXIN_RE/EXTENSION_RE and languages/swift.ts's TYPE_HEADER_RE all emit these kinds via the same
// code path that emits 'class'/'struct'/'protocol' (already in this list), but neither was ever
// added here. 'actor' (Swift) is the same gap again -- TYPE_HEADER_RE emits it alongside
// 'class'/'struct'/'protocol'/'extension' from the identical match, but it alone was omitted.
export const TYPE_KINDS: ReadonlyArray<string> = [
  'type',
  'interface',
  'enum',
  'struct',
  'trait',
  'union',
  'protocol',
  'opaque',
  'mixin',
  'extension',
  // 'extension_type' (Dart 3.3's zero-cost wrapper type, `extension type Meters(int value)`) is
  // a distinct declaration kind from a plain 'extension' -- languages/dart.ts's
  // EXTENSION_TYPE_RE emits it via the same makeLineSymbol code path as 'class'/'mixin'/
  // 'extension' above, so it needs the same TYPE_KINDS entry those already have.
  'extension_type',
  'actor',
  // Protocol Buffers (languages/proto_idx.ts's KIND_MAP) uses its own kind strings rather
  // than the generic 'enum'/'interface' -- a proto message is a struct-shaped type, a proto
  // enum is exactly what its name says, and a proto service's RPC method set is analogous to
  // an interface. Without these, every .proto declaration was indexed but silently excluded
  // from `token-goat types`, the same class of gap already fixed for Rust/Swift/Zig/Dart kinds.
  'proto_message',
  'proto_enum',
  'proto_service',
  // Apex (languages/apex.ts) uses its own prefixed kind strings rather than the generic
  // 'class'/'interface'/'enum' TYPE_KINDS already recognizes -- and the separate
  // looksLikeTypeClass(cls.body) fallback below only ever queries kind === 'class' literally,
  // so it never picks these up either. Without them, every Apex class/interface/enum was
  // indexed but silently excluded from `token-goat types` in its entirety, the same class of
  // gap already fixed for Rust/Swift/Zig/Dart/proto kinds.
  'apex_class',
  'apex_interface',
  'apex_enum',
  // GraphQL (languages/graphql_idx.ts's KIND_MAP) uses its own prefixed kind strings rather
  // than the generic 'type'/'interface'/'union'/'enum' TYPE_KINDS already recognizes -- a
  // GraphQL `input` declaration is likewise a struct-shaped type with no generic equivalent
  // above. Without these, every GraphQL type/interface/input/enum/union declaration was
  // indexed but silently excluded from `token-goat types` in its entirety, the same class of
  // gap already fixed for Rust/Swift/Zig/Dart/proto/Apex kinds. 'graphql_scalar' -- the same
  // KIND_MAP's entry for the `scalar` keyword (e.g. `scalar DateTime`) -- was omitted from this
  // same fix; a custom scalar declaration is a first-class SDL type declaration exactly like
  // enum/union, so it was indexed but silently excluded from `token-goat types` too.
  'graphql_type',
  'graphql_interface',
  'graphql_input',
  'graphql_enum',
  'graphql_union',
  'graphql_scalar',
  // languages/kotlin.ts and languages/scala.ts both deliberately emit kind 'object' (not folded
  // into 'class', per each file's own comment) for a top-level `object Foo { ... }` singleton
  // declaration or a Kotlin companion object. Unlike a plain class, the looksLikeTypeClass(cls.body)
  // fallback below only ever queries kind === 'class' literally, so it never picks up 'object'
  // either -- every Kotlin/Scala object/companion-object declaration was indexed but silently
  // excluded from `token-goat types` in its entirety, the same class of gap already fixed for
  // Rust union, Swift protocol/actor, Zig opaque, Dart mixin/extension, proto message/enum/
  // service, Apex class/interface/enum, and GraphQL type/interface/input/enum/union.
  'object',
  // languages/sfc_idx.ts (Vue/Svelte/Astro single-file components) emits 'sfc_script_class' for
  // a top-level class declaration in the component's script block, a distinct kind string rather
  // than the generic 'class' -- so unlike a plain class it never reaches the looksLikeTypeClass
  // fallback below either, which only ever queries kind === 'class' literally. Every SFC
  // top-level class was indexed but silently excluded from `token-goat types` in its entirety,
  // the same class of gap already fixed for Rust union, Swift protocol/actor, Zig opaque, Dart
  // mixin/extension, proto message/enum/service, Apex class/interface/enum, GraphQL
  // type/interface/input/enum/union, and Kotlin/Scala object.
  'sfc_script_class',
  // languages/graphql_idx.ts's TYPE_RE handler maps EVERY `extend type|interface|input|enum|
  // union|scalar Foo { ... }` declaration to this one shared kind regardless of which keyword
  // follows `extend` -- GraphQL's mechanism for adding fields to a type from another file/module,
  // ubiquitous in federation and schema-stitching -- but unlike the six non-extend KIND_MAP
  // entries already listed above, this kind was never added here, so every `extend` declaration
  // was indexed but silently excluded from `token-goat types` in its entirety, the same class of
  // gap already fixed for the other six GraphQL kinds, Rust union, Swift protocol/actor, Zig
  // opaque, Dart mixin/extension, proto message/enum/service, Apex class/interface/enum, and
  // Kotlin/Scala object.
  'graphql_extend',
]

// Symbol `kind` values every language adapter in this repo is known to emit (collected from the
// language adapter source, not the runtime index) -- used by `dead --kind` to recognize a
// genuinely valid kind that just happens to have zero instances in the current project, distinct
// from a typo/nonexistent kind. Built as a deduplicated union of GENERIC_SYMBOL_KINDS, TYPE_KINDS,
// and OTHER_ADAPTER_SYMBOL_KINDS rather than as an independent hand-maintained literal, so
// TYPE_KINDS entries (Rust/Swift/Zig/Dart/proto/Apex/GraphQL/Kotlin/Scala/SFC type kinds) cannot
// silently drift out of this list the way they previously did -- CORE_SYMBOL_KINDS is meant to be
// a superset of TYPE_KINDS by definition, and this construction makes that structurally true
// instead of merely documented. Not exhaustive by construction (a future adapter can add a new
// kind), which is fine: distinctSymbolKinds(rootDir) still covers anything actually indexed, and
// this list only widens what counts as "known" rather than narrowing it.
export const CORE_SYMBOL_KINDS: ReadonlyArray<string> = [
  ...new Set([...GENERIC_SYMBOL_KINDS, ...TYPE_KINDS, ...OTHER_ADAPTER_SYMBOL_KINDS]),
]

export interface TypesOptions {
  file?: string
  json?: boolean
  limit?: number
  /** Only list type declarations whose NAME matches this pattern. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
  /** `--exclude-tests`: drop type declarations DEFINED in a test file (per isTestFile), matching dead's own opt-in semantics (definition site, not reference site). Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
}

// Per-kind scan headroom used only when --exclude-tests is active, matching dead's own 5000-per-kind scan (runDead): filtered-out test declarations must not leave fewer than --limit real results ahead of the cutoff, which filtering after the SQL LIMIT would silently do.
// Every `types` scan over-fetches to this bound, not just the --exclude-tests one. `--limit` is a
// per-kind DISPLAY cap now, applied in JS after --exclude-tests and --grep have run. Pushing it into
// SQL (as this did) had two consequences: the rows past it were never fetched, so `totalCount` could
// only ever report the count of what survived -- it reported 2 of 9 as `totalCount: 2, truncated:
// false`, a wrong number rather than a missing one -- and --grep could only ever match inside the
// capped window, so a declaration ranked below the cap was unfindable by name.
const TYPES_SCAN_LIMIT = 5000

export function runTypes(opts: TypesOptions): number {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0` on every kind-scan, always
  // returning zero rows regardless of whether type declarations exist -- silently reporting "no
  // type declarations found". Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const limit = opts.limit ?? 500
  const excludeTests = opts.excludeTests === true
  const filePath = opts.file !== undefined ? resolveIndexPath(opts.file) : undefined
  const fpOpt = filePath !== undefined ? { filePath } : {}
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope every kind-scan to the current project root so `types` doesn't mix in
  // type/interface/enum/class symbols from an unrelated project on the same machine.
  const rootDir = resolveProjectRoot({ project: process.cwd() })

  // Every declaration that survives --exclude-tests, uncapped. `--limit` is applied further down,
  // after --grep, so that both the reported total and the set --grep searches are the real ones.
  const results: SymbolEntry[] = []
  let suppressed = 0

  for (const k of TYPE_KINDS) {
    const syms = querySymbols({ kind: k, ...fpOpt, limit: TYPES_SCAN_LIMIT, rootDir })
    for (const sym of syms) {
      if (excludeTests && isTestFile(sym.filePath)) {
        suppressed += 1
        continue
      }
      results.push(sym)
    }
  }

  const classes = querySymbols({ kind: 'class', ...fpOpt, limit: TYPES_SCAN_LIMIT, rootDir })
  for (const cls of classes) {
    if (!looksLikeTypeClass(cls.body)) continue
    if (excludeTests && isTestFile(cls.filePath)) {
      suppressed += 1
      continue
    }
    results.push(cls)
  }

  results.sort(
    // Pin the locale: an unlocaled localeCompare() sorts differently across
    // Node's small-icu vs full-icu builds and different system default
    // locales, making output nondeterministic across machines/CI runners.
    (a, b) => a.filePath.localeCompare(b.filePath, 'en') || a.lineStart - b.lineStart,
  )

  if (results.length === 0) {
    // A path that does not exist reads as "this file declares no types", so a typo or a stale path guess looks like a definitive answer about a real file and the caller stops looking. Only distinguishable here, after the query came back empty: an existing-but-unindexed file must keep the message below. Wording is `runDeps`/`runExports`' verbatim, which already close this same gap.
    if (opts.file !== undefined && !fs.existsSync(opts.file)) {
      emitErr(`Could not read: ${opts.file}`)
      return 1
    }
    const ctx = opts.file !== undefined ? ` in '${opts.file}'` : ''
    // The store IS non-empty -- --exclude-tests hid every declaration -- so a bare "No type declarations found" would be a lie that stops the caller looking; name the filter instead, exiting 0 like symbol's own hiddenByExcludeTests branch.
    if (excludeTests && suppressed > 0) {
      if (opts.json === true) {
        // `hiddenByExcludeTests` names the filter as the cause -- `items: []`/`totalCount: 0`
        // alone reads identically to a file that genuinely declares no types, same convention
        // as dead/refs/callers' own hiddenByExcludeTests.
        emit(JSON.stringify({ items: [], truncated: false, totalCount: 0, hiddenByExcludeTests: suppressed }, null, 2))
        return 0
      }
      emit(`No non-test type declarations found${ctx} (${excludeTestsHiddenNote(suppressed)})`)
      return 0
    }
    emitErr(`No type declarations found${ctx}`)
    // Only paid after the query already came back empty, and only in text mode -- this branch
    // already emits plain prose regardless of --json, matching runRefsSingle's convention.
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  // --grep narrows on NAME, applied to the whole uncapped result set. It has to run before the
  // per-kind --limit below, not after: a cap ahead of the predicate can drop the very row the
  // predicate was looking for, and then report honestly on a set the caller never wanted.
  const preFilterCount = results.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const matched = matchesGrep !== undefined ? results.filter((r) => matchesGrep(r.name)) : results

  // The per-kind display cap. `eligibleCount` is measured here, before it runs, so the count
  // reported below is of what MATCHED rather than of what survived -- the distinction the old
  // SQL-side limit made impossible, because the rows past it were never fetched to be counted.
  const eligibleCount = matched.length
  const perKindShown = new Map<string, number>()
  const filtered = matched.filter((r) => {
    const seen = perKindShown.get(r.kind) ?? 0
    if (seen >= limit) return false
    perKindShown.set(r.kind, seen + 1)
    return true
  })
  const cappedOut = eligibleCount - filtered.length

  if (filtered.length === 0) {
    // The store is genuinely non-empty (preFilterCount > 0, already confirmed above) but --grep
    // matched none of it -- distinct from the "no type declarations found" case above, which
    // exits 1 because there was nothing to find at all.
    if (opts.json === true) {
      // Same `{items, truncated, totalCount}` envelope the populated branch below emits, so a
      // filtered-to-empty result is a well-formed envelope with `totalCount: 0` rather than a
      // second shape a consumer has to branch on. `totalCount` is the post-`--grep` count (0
      // here by definition), never `preFilterCount` -- it counts what MATCHED the filter. The
      // `hiddenByGrep` count is what tells the consumer this empty envelope is a filtered view
      // and not an empty store.
      emit(JSON.stringify({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preFilterCount }, null, 2))
      return 0
    }
    emit(grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'type declaration', 'type declarations'))
    return 0
  }

  if (opts.json === true) {
    // `filePath` rewritten to the same root-relative spelling the text rows below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing.
    // Wrapped in the shared `{items, truncated, totalCount}` envelope (symbol/refs/skeleton/
    // outline's own shape) so `--json` consumers never branch on payload shape. `totalCount` is
    // the post-`--grep`, pre-overflow-guard count: `filtered` is the whole matched set, and
    // nothing truncates it between here and guardJsonRows.
    const capped = guardJsonRows(filtered.map((r) => ({ ...r, filePath: toDisplayPath(rootDir, r.filePath) })))
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially
    // filtered set carries the count too rather than only the fully emptied one. Measured against
    // `matched`, not `filtered`, so --limit's own drop is not double-counted as a --grep drop.
    const hiddenByGrep = preFilterCount - eligibleCount
    // Two independent ways to lose a row -- the per-kind --limit here, and the overflow guard
    // inside guardJsonRows -- so `truncated` is the OR of both and `totalCount` is the count
    // before either ran. Reporting only the guard's view is what made `--limit 1` on a 9-row file
    // answer `totalCount: 2, truncated: false`.
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated || cappedOut > 0, totalCount: eligibleCount, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}), ...(excludeTests && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}) }, null, 2))
    return 0
  }

  // Additive note only: printed solely when --exclude-tests actually hid something (matching dead's own convention), so default (flag-absent) output is untouched and a filtered view is never mistaken for the whole set.
  if (excludeTests && suppressed > 0) {
    emit(`${countNoun(filtered.length, 'type declaration')} (${excludeTestsHiddenNote(suppressed)})`)
  }

  for (const r of filtered) {
    emit(`${r.name}\t${r.kind}\t${toDisplayPath(rootDir, r.filePath)}:${r.lineStart}`)
  }
  // stderr, so a shell pipeline reading the rows is unaffected, and only when the cap bit.
  if (cappedOut > 0) {
    emitErr(`Showing ${filtered.length} of ${eligibleCount} type declarations (--limit is per kind; raise it to see the rest).`)
  }
  return 0
}

// ---- scope ------------------------------------------------------------------

export interface ScopeOptions {
  spec: string
  json?: boolean
}

export function runScope(opts: ScopeOptions): number {
  const colonIdx = opts.spec.lastIndexOf(':')
  if (colonIdx <= 0) {
    emitErr(`Invalid spec — expected "file:line", got: ${opts.spec}`)
    return 1
  }

  const file = opts.spec.slice(0, colonIdx)
  const lineStr = opts.spec.slice(colonIdx + 1)

  // Reject anything but an exact integer literal so trailing garbage (e.g. "12abc") is caught
  // instead of Number.parseInt silently truncating it to 12.
  if (!/^\d+$/.test(lineStr)) {
    emitErr(`Invalid line number: ${lineStr}`)
    return 1
  }
  const line = Number.parseInt(lineStr, 10)
  // `Number.isSafeInteger`, not `isFinite`: `/^\d+$/` above admits a digit run longer than a double
  // can hold exactly, and `parseInt` rounds it silently rather than failing. `1e21` is finite, so
  // the old check passed it through, and the "No symbols enclosing line ${line}" message below then
  // echoed the rounded value -- reporting a line number the caller never typed. Every other
  // validation error on this path quotes the literal input; this one has to reject instead.
  if (!Number.isSafeInteger(line) || line < 1) {
    emitErr(`Invalid line number: ${lineStr}`)
    return 1
  }

  // `scope --json` renders each enclosing symbol's full indexed BODY, so it discloses exactly what
  // the other index-backed reads do and answers to the same confinement.
  const confined = fileConfinementRefusal('This file', file, undefined)
  if (confined !== null) {
    emitErr(confined)
    return 1
  }

  const filePath = resolveIndexPath(file)
  // The enclosing predicate belongs in the query, not after it. Filtering a capped page in JS meant
  // `limit` was applied first, so in a file with more indexed symbols than the cap every symbol
  // past it was discarded before the filter ran, and a line wrapped only by one of those reported
  // "No symbols enclosing" -- the same words as an honest miss, with nothing on either channel to
  // say the answer had been truncated away.
  const enclosing = querySymbols({ filePath, enclosingLine: line, limit: ALL_SYMBOLS_IN_FILE_LIMIT })
    // Innermost first, which a later start alone does not establish. Symbols sharing a start line
    // are common -- a signature that declares an inline object type indexes the function and each
    // of its members at the signature's own line -- and on those the descending-start comparator
    // returned 0 and left the order to `querySymbols`, whose SQL sorts by `line_start` with no
    // tiebreak. That handed back the widest span first: `scope src/batch_serve.ts:58` listed the
    // 23-line function above the three one-line symbols nested inside it, the exact inversion of
    // what this command's one sentence of documentation promises. Same start plus an earlier end
    // is a strictly narrower span, so it is the more deeply nested of the two. The name is a last
    // resort for symbols that share both bounds: they are siblings rather than nested, so no
    // nesting order exists to get right, but leaving them to the database's unspecified row order
    // means the same query can print a different order after a reindex. The locale is pinned for
    // the reason runArch's comparator pins it: an unlocaled localeCompare sorts differently across
    // hosts, so leaving it off would trade one source of instability for another.
    .sort((a, b) => b.lineStart - a.lineStart || a.lineEnd - b.lineEnd || a.name.localeCompare(b.name, 'en'))

  // "the file isn't there", "the file is there but unindexed", and "nothing wraps that line" are
  // three different answers, and the first two used to print the identical no-symbols line — so a
  // typo'd path read as a real file with a bare line, the most misleading of the three. `outline`
  // already separates them; match it. The one-row probe only runs once the enclosing query has
  // come back empty, so the common case still costs a single query.
  if (enclosing.length === 0) {
    if (querySymbols({ filePath, limit: 1 }).length === 0) {
      if (!fs.existsSync(filePath)) {
        emitErr(`Could not read: ${file}`)
        return 1
      }
      emitErr(
        `No indexed symbols in '${file}' — the file exists but nothing is indexed for it, so every line looks empty`,
      )
      return 1
    }
    emitErr(`No symbols enclosing line ${line} in '${file}'`)
    return 1
  }

  const scopeDisplayRoot = getDisplayRoot()

  // Both branches render the same path the same way. The JSON branch used to emit the stored row
  // verbatim, so one command answered the same question with a repo-relative path in text mode and
  // this machine's absolute path in --json.
  if (opts.json === true) {
    emit(
      JSON.stringify(
        enclosing.map((s) => ({ ...s, filePath: toDisplayPath(scopeDisplayRoot, s.filePath) })),
        null,
        2,
      ),
    )
    return 0
  }

  for (const s of enclosing) {
    emit(`${s.name}\t${s.kind}\t${toDisplayPath(scopeDisplayRoot, s.filePath)}:${s.lineStart}-${s.lineEnd}`)
  }
  return 0
}

// ---- isTestFile (exported pure helper) --------------------------------------
// Implementation lives in util.ts (shared with repomap.ts/baseline.ts's file-walk
// exclude_tests filtering) and is imported above; re-exported here so existing
// importers of this module are unaffected.
export { isTestFile }

// ---- findCycles (exported pure helper) --------------------------------------

const MAX_CYCLES = 200

/**
 * Tarjan's strongly-connected-components algorithm. A node can only be part of a cycle if it
 * lies in a component of size > 1, or has a self-loop - restricting the exhaustive per-path
 * cycle search below to just these components keeps it safe on large, mostly-acyclic import
 * graphs (real codebases) instead of exploring every DAG diamond in the whole graph.
 *
 * Implemented iteratively (an explicit work stack of {node, neighbor-iterator} frames standing
 * in for the call stack) rather than as the textbook recursive `strongconnect`: `runArch` builds
 * this graph from every file `getTrackedFiles` returns across the whole project, so a
 * moderately deep import chain in a large real-world repo (verified: a plain linear chain of
 * ~5000 files reliably blows Node's default stack via the recursive version, well within range
 * for a large monorepo) would throw "Maximum call stack size exceeded" and crash `token-goat
 * arch` outright. The iterative form has no recursion depth at all, so it scales to any chain
 * length bounded only by heap, not stack.
 */
function tarjanSCCs(graph: Map<string, string[]>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []

  interface Frame {
    node: string
    iter: Iterator<string>
  }

  for (const start of graph.keys()) {
    if (indices.has(start)) continue

    const workStack: Frame[] = [{ node: start, iter: (graph.get(start) ?? [])[Symbol.iterator]() }]
    indices.set(start, index)
    lowlink.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1]!
      const v = frame.node
      const next = frame.iter.next()

      if (!next.done) {
        const w = next.value
        if (!indices.has(w)) {
          indices.set(w, index)
          lowlink.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          workStack.push({ node: w, iter: (graph.get(w) ?? [])[Symbol.iterator]() })
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
        }
        continue
      }

      // Neighbors of v exhausted: pop v's frame and propagate its lowlink up to its parent
      // (the frame now on top, if any) before checking whether v roots its own component.
      workStack.pop()
      const parentFrame = workStack[workStack.length - 1]
      if (parentFrame !== undefined) {
        lowlink.set(parentFrame.node, Math.min(lowlink.get(parentFrame.node)!, lowlink.get(v)!))
      }

      if (lowlink.get(v) === indices.get(v)) {
        const component: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          component.push(w)
        } while (w !== v)
        result.push(component)
      }
    }
  }
  return result
}

// A cycle path is [n0, n1, ..., nk, n0] (closing node repeats the start). Rotate to start at the
// lexicographically smallest node so the same cycle discovered from different start nodes
// normalizes to one key, without conflating a cycle with its reverse-direction traversal.
function canonicalCycleKey(cyclePath: string[]): string {
  const nodes = cyclePath.slice(0, -1)
  let minIdx = 0
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[minIdx]!) minIdx = i
  }
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(' ')
}

/**
 * Find all simple cycles in a directed graph. Returns each cycle as a string[] of node names,
 * each cycle path starting and ending at the same node.
 *
 * Restricts the exhaustive per-path search to one strongly-connected component at a time (via
 * Tarjan's algorithm above), and within a component tracks only the current recursion path (not
 * a global visited set) so that two distinct cycles sharing a node - e.g. A->B->C->A and
 * A->D->C->A sharing C - are both found instead of the second being silently dropped because C
 * was already marked visited while exploring the first. Capped at MAX_CYCLES as a safety bound
 * against pathological densely-connected components (rare in real import graphs, but a complete
 * subgraph has combinatorially many simple cycles).
 */
export function findCycles(graph: Map<string, string[]>): string[][] {
  return findCyclesCapped(graph).cycles
}

/** Same enumeration as findCycles, but also reports whether the MAX_CYCLES bound actually cut the search short. Callers that render a count (runArch's `cycles (N found)`) need this: at the cap the count is exactly MAX_CYCLES, byte-identical to a project that genuinely has that many, so a truncated result reads as a complete one -- the same gap runCallChain closed with `(depth-limit)` and runImpact with its depth-cap notice. The flag is set at the point enumeration stops rather than derived from `cycles.length === MAX_CYCLES`, so a project with exactly MAX_CYCLES real cycles is not mislabelled truncated. */
export function findCyclesCapped(graph: Map<string, string[]>): { cycles: string[][]; truncated: boolean } {
  const cycles: string[][] = []
  const seen = new Set<string>()
  const sccs = tarjanSCCs(graph)
  // Enumerate one cycle past the reported cap and use that overflow purely as the truncation signal, the same probe-row convention resolveCallers uses for its SQL LIMIT: deriving the flag from `cycles.length === MAX_CYCLES` would mislabel a graph that genuinely has exactly MAX_CYCLES cycles. The probe entry is sliced off below and never reaches the caller.
  const probeLimit = MAX_CYCLES + 1

  for (const component of sccs) {
    if (cycles.length >= probeLimit) break
    if (component.length === 1) {
      const [only] = component
      if (only !== undefined && (graph.get(only) ?? []).includes(only)) cycles.push([only, only])
      continue
    }
    const sccSet = new Set(component)
    const stack = new Set<string>()

    function dfs(start: string, node: string, pathSoFar: string[]): void {
      if (cycles.length >= probeLimit) return
      stack.add(node)
      for (const nb of graph.get(node) ?? []) {
        if (!sccSet.has(nb)) continue
        if (cycles.length >= probeLimit) break
        if (nb === start) {
          const cyclePath = [...pathSoFar, node, start]
          const key = canonicalCycleKey(cyclePath)
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push(cyclePath)
          }
        } else if (!stack.has(nb)) {
          dfs(start, nb, [...pathSoFar, node])
        }
      }
      stack.delete(node)
    }

    for (const start of component) {
      if (cycles.length >= probeLimit) break
      dfs(start, start, [])
    }
  }

  if (cycles.length > MAX_CYCLES) return { cycles: cycles.slice(0, MAX_CYCLES), truncated: true }
  return { cycles, truncated: false }
}

// ---- similar ----------------------------------------------------------------

export interface SimilarOptions {
  spec: string
  top?: number
  json?: boolean
}

export function runSimilar(opts: SimilarOptions): number {
  // A --top of 0 (or negative) would ask searchSymbolsFts for zero-or-negative results and
  // reject explicitly instead of silently rendering an empty result, matching runRefs' own
  // --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const sepIdx = opts.spec.lastIndexOf('::')
  if (sepIdx < 0) {
    emitErr(`Invalid spec - expected "file::symbol", got: ${opts.spec}`)
    return 1
  }
  const top = opts.top ?? 10

  // Same ambiguity check runRead/runBrief already do -- refuse (with qualified retry
  // suggestions) instead of silently comparing against the first same-named definition.
  const anchor = resolveSymbolSpecOrEmitError('similar', opts.spec, undefined)
  if (anchor === null) return 1

  const words = [anchor.name, ...(anchor.docstring ?? '').split(/\s+/).filter((w) => w.length > 4)]
  const query = words.slice(0, 8).join(' ')

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  // Scanned uncapped, for the reason spelled out on runDead's own scan: a fetch of `top + 1` can
  // tell that more matches exist but never how many, so the only number available to report would
  // have been the scanned set restated as the whole one. FTS orders by bm25 rank, so slicing the
  // uncapped result to `top` below returns the identical rows the capped fetch did -- this widens
  // what is counted, not what is shown.
  const hits = searchSymbolsFts(query, UNBOUNDED_REF_LIMIT, undefined, rootDir)
  // The anchor is filtered out before the total is taken: it is not one of its own similar
  // symbols, and counting it would report a total the reader can never reach with --top.
  const matches = hits.filter((h) => !(h.filePath === anchor.filePath && h.name === anchor.name))
  const results = matches.slice(0, top)

  // `similar --json` is a deliberate bare array with no envelope to carry a truncation flag, so a
  // --top-clipped page was indistinguishable from the complete match list in both output modes --
  // and unlike coverage-gaps and impact, which report the clipped count for exactly this reason,
  // this command disclosed nothing on either channel. Emitted before the --json branch so both
  // modes get it.
  if (matches.length > results.length) {
    emitErr(`Showing top ${results.length} of ${matches.length} similar symbols (raise --top to see the rest).`)
  }

  if (opts.json === true) {
    emit(JSON.stringify(results.map((h) => ({ name: h.name, kind: h.kind, file: h.filePath, line: h.lineStart })), null, 2))
    return 0
  }
  for (const h of results) emit(`${h.name}\t${h.kind}\t${toDisplayPath(rootDir, h.filePath)}:${h.lineStart}`)
  return 0
}

// ---- context-for ------------------------------------------------------------

export interface ContextForOptions {
  task: string
  top?: number
  budget?: number
  json?: boolean
}

export function runContextFor(opts: ContextForOptions): number {
  // A --top of 0 (or negative) would ask searchSymbolsFts for zero-or-negative results and
  // reject explicitly instead of silently rendering an empty result, matching runRefs' own
  // --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 12
  const budget = opts.budget

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  // One row beyond the cap, purely to learn whether a remainder exists. The cap goes into
  // searchSymbolsFts' own SQL LIMIT, so rows past it are never fetched and an exact total would
  // cost a second full query; this buys the honest part -- THAT there is more -- for one row.
  // Same treatment `recall` gets, and for the same reason.
  const fetched = searchSymbolsFts(opts.task, top + 1, undefined, rootDir)
  const moreBeyondTop = fetched.length > top
  const hits = fetched.slice(0, top)

  if (hits.length === 0) {
    emitErr(`No matches found for '${opts.task}'`)
    return 1
  }

  // `line` (and the matching `@LINE` anchor on every emitted readCmd) is what makes these
  // suggestions actually runnable: two same-named symbols in one file produce two byte-identical
  // `read "file::name"` commands, and running either one fails with "Ambiguous symbol". The
  // anchor grammar (`file::symbol@LINE`, see resolveSymbolSpec) disambiguates both the emitted
  // text and the JSON entries.
  interface ContextEntry { file: string; symbol: string; kind: string; line: number; readCmd: string }
  const entries: ContextEntry[] = []
  let tokensSoFar = 0

  for (const h of hits) {
    const bodyTokens = estimateTokens(h.body ?? '')
    // A `continue` (not `break`) here: hits are ranked by relevance, not by size, so one
    // oversized top-ranked hit exceeding the remaining budget must not stop consideration of
    // smaller, still-relevant hits ranked below it -- otherwise the whole result set can go
    // empty even when plenty of smaller hits would fit. `hits` is already capped at `top` by
    // searchSymbolsFts's own `limit` param above, so this loop can never emit more than `top`
    // entries regardless.
    if (budget !== undefined && tokensSoFar + bodyTokens > budget) continue
    tokensSoFar += bodyTokens
    entries.push({ file: h.filePath, symbol: h.name, kind: h.kind, line: h.lineStart, readCmd: `token-goat read "${h.filePath}::${h.name}@${h.lineStart}"` })
  }

  // --budget drops entries silently by design (the `continue` above keeps scanning), so the
  // count of what it dropped is the only thing that separates "these are the relevant symbols"
  // from "these are the ones that happened to fit". A tight budget can drop ALL of them, which
  // rendered as zero output and exit 0 -- byte-identical to a search that found nothing, and the
  // reader concludes there is no relevant code rather than that they set the budget too low.
  const skippedByBudget = hits.length - entries.length
  const notices: string[] = []
  if (skippedByBudget > 0) {
    notices.push(
      entries.length === 0
        ? `All ${countNoun(skippedByBudget, 'matching symbol')} were larger than --budget ${String(opts.budget)} tokens, so none are shown. Raise --budget.`
        : `Showing ${entries.length} of ${countNoun(hits.length, 'matching symbol')}; ${skippedByBudget} did not fit --budget ${String(opts.budget)} tokens.`,
    )
  }
  // Reported separately from the budget drop because they are different losses: this one is rows
  // never retrieved, that one is rows retrieved and rejected.
  if (moreBeyondTop) notices.push(`More matches exist beyond --top ${top} (raise it to see them).`)
  // stderr, so `context-for ... | sh` and `--json | jq` are both unaffected. The --json payload
  // is a bare array by contract, so there is no envelope to carry this in band.
  for (const n of notices) emitErr(n)

  if (opts.json === true) {
    emit(JSON.stringify(entries, null, 2))
    return 0
  }
  for (const e of entries) emit(`token-goat read "${toDisplayPath(rootDir, e.file)}::${e.symbol}@${e.line}"`)
  return 0
}

// ---- test-for ---------------------------------------------------------------

export interface TestForOptions {
  file: string
  json?: boolean
}

interface TestForEntry { testFile: string; testFunctions: string[] }

export function runTestFor(opts: TestForOptions): number {
  const filePath = resolveIndexPath(opts.file)
  const symbols = querySymbols({ filePath, limit: ALL_SYMBOLS_IN_FILE_LIMIT })

  // A file that is neither readable from disk nor present in the index is a bad path (typo,
  // wrong cwd), not a file that legitimately has no referencing tests -- report it the same way
  // imports/deps already do. A file indexed but since deleted from disk must NOT hit this
  // branch: `symbols` still has rows for it, so the command falls through and reports from the
  // index instead of erroring.
  if (!fs.existsSync(opts.file) && symbols.length === 0) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope each ref lookup to the current project root so a same-named symbol's
  // test reference in an unrelated project on the same machine isn't returned here.
  const rootDir = resolveProjectRoot({ project: process.cwd() })

  const testFileMap = new Map<string, Set<string>>()
  const getSyms = buildFileSymCache()

  for (const sym of symbols) {
    const refs = queryRefs({ name: sym.name, limit: UNBOUNDED_REF_LIMIT, rootDir })
    for (const ref of refs) {
      if (!isTestFile(ref.filePath)) continue
      if (!testFileMap.has(ref.filePath)) testFileMap.set(ref.filePath, new Set())
      // Record which test function actually exercises the target file's symbol, so the Set
      // narrows testFunctions to the ones that reference the target -- not every test-prefixed
      // symbol that merely happens to live in the same file.
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc !== null) {
        testFileMap.get(ref.filePath)!.add(enc.name)
      }
    }
  }

  const results: TestForEntry[] = []

  for (const [tf, referencingFns] of testFileMap) {
    const testSyms = querySymbols({ filePath: tf, limit: ALL_SYMBOLS_IN_FILE_LIMIT })
    // A bare prefix match with no boundary after the alternation would also match any ordinary
    // identifier that happens to start with the same letters as a test-framework keyword --
    // 'it' alone matches 'itemsToJson'/'iterateOverTargetHelper'/'italicize', and 'test' alone
    // matches 'testament'. Require the prefix to be either the whole name or immediately
    // followed by an uppercase letter, digit, or underscore (camelCase/snake_case continuation
    // boundary), so real test names like 'itWorksCorrectly'/'testFoo'/'test_foo' still match.
    const testFns = testSyms
      .filter((s) => /^(test|Test|spec|describe|it)(?:[A-Z_0-9]|$)/.test(s.name) && referencingFns.has(s.name))
      .map((s) => s.name)
    results.push({ testFile: tf, testFunctions: testFns })
  }

  if (opts.json === true) {
    // `testFile` rewritten to the same root-relative spelling the text rows below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing.
    // Shared `{items, truncated, totalCount}` envelope, emitted unconditionally -- including the
    // "no test files reference this" case, which becomes `{items: [], truncated: false,
    // totalCount: 0}` rather than a bare `[]`. Nothing truncates `results` upstream, so
    // `totalCount` is simply how many test files matched.
    const capped = guardJsonRows(results.map((r) => ({ ...r, testFile: toDisplayPath(rootDir, r.testFile) })))
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
    return 0
  }
  if (results.length === 0) {
    emit(`No test files found referencing symbols in '${opts.file}'`)
    return 0
  }
  for (const r of results) {
    emit(toDisplayPath(rootDir, r.testFile))
    for (const fn of r.testFunctions) emit(`  ${fn}`)
  }
  return 0
}

// ---- coverage-gaps ----------------------------------------------------------

export interface CoverageGapsOptions {
  top?: number
  includePrivate?: boolean
  json?: boolean
}

export function runCoverageGaps(opts: CoverageGapsOptions): number {
  // A --top of 0 (or negative) would slice the gaps list down to zero entries and report "No
  // coverage gaps found." even when gaps genuinely exist -- reject explicitly instead of
  // silently rendering a false-clean result, matching runRefs' own --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 50
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts); scope the kind-scan and each ref lookup to the current project root so a
  // function untested here isn't hidden by a same-named symbol's test reference in an unrelated
  // project on the same machine.
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  // Scanned uncapped, matching runDead's own kind scan: the previous 2000-per-kind cap is exceeded by this repo itself (3444 indexed functions), and querySymbols orders by (file_path, line), so every untested function in the alphabetically-later part of the tree was dropped before the gap check ever ran -- an under-report that reads exactly like a clean result.
  const allFns = querySymbols({ kind: 'function', limit: UNBOUNDED_REF_LIMIT, rootDir })
  const allMethods = querySymbols({ kind: 'method', limit: UNBOUNDED_REF_LIMIT, rootDir })
  const candidates = [...allFns, ...allMethods]

  const gaps: Array<{ name: string; kind: string; file: string; line: number }> = []

  for (const sym of candidates) {
    if (!opts.includePrivate && sym.name.startsWith('_')) continue
    if (ENTRY_NAMES.has(sym.name)) continue
    const refs = queryRefs({ name: sym.name, limit: UNBOUNDED_REF_LIMIT, rootDir })
    const hasTestRef = refs.some((r) => isTestFile(r.filePath))
    if (!hasTestRef) gaps.push({ name: sym.name, kind: sym.kind, file: sym.filePath, line: sym.lineStart })
  }

  const sliced = gaps.slice(0, top)

  // `coverage-gaps --json` is a deliberate bare array with no envelope to carry a truncation flag, so a --top-clipped page was indistinguishable from the complete gap list in both output modes. Report the clipped count on stderr (the channel runImpact already uses for the same reason) rather than changing the payload shape every consumer parses.
  if (gaps.length > sliced.length) {
    emitErr(`Showing top ${sliced.length} of ${gaps.length} coverage gaps (raise --top to see the rest).`)
  }

  if (opts.json === true) {
    emit(JSON.stringify(sliced, null, 2))
    return 0
  }
  if (sliced.length === 0) {
    emit('No coverage gaps found.')
    // Only paid after the query already came back empty (index-empty and genuinely-clean both
    // land here) -- distinguishes "this project has no functions to test" from "nothing is
    // indexed yet", matching runDead's own emptyIndexMessage guard.
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) emit(emptyIndexMessage(rootDir))
    return 0
  }
  for (const g of sliced) emit(`${g.name}\t${g.kind}\t${toDisplayPath(rootDir, g.file)}:${g.line}`)
  return 0
}

// ---- arch -------------------------------------------------------------------

export interface ArchOptions {
  top?: number
  json?: boolean
  cwd?: string
}

export function runArch(opts: ArchOptions): number {
  // A --top of 0 (or negative) would slice the hubs/entry-points lists down to zero entries --
  // reject explicitly instead of silently rendering an empty result, matching runRefs' own
  // --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const cwd = opts.cwd ?? process.cwd()
  const top = opts.top ?? 10
  const files = getTrackedFiles(cwd)
  // With zero tracked files the three headers below still print, each with nothing under it -- byte-identical to a real repo that genuinely has no hubs, no entry points and no cycles, so an empty result reads as a clean architecture rather than as "there was nothing to analyse." Say which it is, reusing cli.ts's wording for this same condition. The --json branch is untouched: `{hubs: [], entryPoints: [], cycles: []}` is already unambiguous.
  if (files.length === 0 && opts.json !== true) {
    emit(`no tracked files found under '${toDisplayPath(getDisplayRoot(cwd), cwd)}' (is it a git repo?). Nothing to analyse.`)
    return 0
  }
  // Case-insensitive filesystems (Windows/macOS) treat Foo.ts and foo.ts as the
  // same file; an import spec's casing need not match the tracked path's, so
  // membership must be checked through foldPath() rather than raw string
  // equality (matches the convention already applied to session.ts,
  // session_store.ts, hooks_read.ts, walk_index.ts, compact.ts, worker.ts,
  // text_commands.ts, read_commands.ts, snapshots.ts, project.ts,
  // index_prune.ts, and memory_prune.ts).
  const filesByFoldedPath = new Map<string, string>()
  for (const f of files) filesByFoldedPath.set(foldPath(f), f)

  const graph = new Map<string, string[]>()
  const importedBy = new Map<string, Set<string>>()

  const resolveRelImport = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const dir = path.dirname(fromFile)
    // Strip .js/.mjs/.cjs output extensions so we can also probe .ts/.tsx source variants
    const strippedSpec = spec.replace(/\.(m?js|cjs)$/, '')
    const base = path.resolve(dir, strippedSpec)
    // `.cjs`/`.cts` are omitted from the stripped-spec's re-probe list below (runDeps'
    // SOURCE_EXTENSIONS already treats both as real source extensions) -- without them a
    // relative import resolving onto a .cjs/.cts source file never matched here, even though
    // runDeps' resolver (immediately below in this file) resolves the same case correctly.
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.cts', '.py']) {
      const candidate = base + ext
      const match = filesByFoldedPath.get(foldPath(candidate))
      if (match !== undefined) return match
    }
    const idx = path.join(base, 'index')
    for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts']) {
      const candidate = idx + ext
      const match = filesByFoldedPath.get(foldPath(candidate))
      if (match !== undefined) return match
    }
    return null
  }

  for (const file of files) {
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const ext = importsExtensionFor(file)
    const rawImports = extractImports(text, ext)
    const internal: string[] = []
    for (const spec of rawImports) {
      const resolved = resolveRelImport(file, spec)
      if (resolved !== null) {
        internal.push(resolved)
        if (!importedBy.has(resolved)) importedBy.set(resolved, new Set())
        importedBy.get(resolved)!.add(file)
      }
    }
    graph.set(file, internal)
  }

  // Counted before --top slices, so both surfaces below can say how much was left out. The
  // cycles section already did this (findCyclesCapped's `truncated`); hubs and entry points did
  // not, so `--top 2` on a project with 47 hubs rendered 2 with nothing to distinguish that from
  // a project that has exactly 2. The text header said "top 2", which names the cap without
  // saying whether it bit -- and on a project with fewer hubs than the cap it actively implies
  // more exist.
  const allHubs = [...importedBy.entries()].sort((a, b) => b[1].size - a[1].size).map(([f, importers]) => ({ file: f, importedBy: importers.size }))
  const hubsTotal = allHubs.length
  const hubs = allHubs.slice(0, top)

  const allEntryPoints = files.filter((f) => !importedBy.has(f) && (graph.get(f) ?? []).length > 0).map((f) => ({ file: f }))
  const entryPointsTotal = allEntryPoints.length
  const entryPoints = allEntryPoints.slice(0, top)

  // findCycles stops enumerating at MAX_CYCLES, so at the bound `cycles.length` is exactly that number and the `cycles (N found)` line below reads identically to a project that genuinely has N -- a truncated report presented as a complete one. Carry the flag through to both surfaces, the same treatment call-chain's `(depth-limit)` sentinel and impact's depth-cap notice already give their own bounds.
  const { cycles, truncated: cyclesTruncated } = findCyclesCapped(graph)

  if (opts.json === true) {
    // Per-section totals rather than one flag: --top applies to each list independently, so a
    // single `truncated` could not say WHICH list was cut, and a reader of a capped hubs list
    // beside a complete entry-point list would have no way to tell them apart. Additive fields,
    // so an existing consumer of {hubs, entryPoints, cycles} is unaffected.
    emit(JSON.stringify({ hubs, hubsTotal, hubsTruncated: hubs.length < hubsTotal, entryPoints, entryPointsTotal, entryPointsTruncated: entryPoints.length < entryPointsTotal, cycles, ...(cyclesTruncated ? { cyclesTruncated: true } : {}) }, null, 2))
    return 0
  }

  // "top N of M" when the cap bit, plain "N" when it did not -- the old header named the cap
  // unconditionally, which reads as "there are more" on a project that has fewer than N.
  emit(hubs.length < hubsTotal ? `hubs (top ${hubs.length} of ${hubsTotal} most-imported):` : `hubs (${hubsTotal} most-imported):`)
  for (const h of hubs) emit(`  ${h.importedBy} importers\t${toDisplayPath(getDisplayRoot(opts.cwd), h.file)}`)
  emit(entryPoints.length < entryPointsTotal ? `entry points (imported by nobody, top ${entryPoints.length} of ${entryPointsTotal}):` : `entry points (imported by nobody, ${entryPointsTotal} found):`)
  for (const e of entryPoints) emit(`  ${toDisplayPath(getDisplayRoot(opts.cwd), e.file)}`)
  emit(cyclesTruncated ? `cycles (first ${cycles.length}, truncated at the ${MAX_CYCLES}-cycle enumeration limit: more cycles exist):` : `cycles (${cycles.length} found):`)
  for (const c of cycles) emit(`  ${c.map((f) => toDisplayPath(getDisplayRoot(opts.cwd), f)).join(' -> ')}`)
  return 0
}

// ---- blame ------------------------------------------------------------------

export interface BlameOptions {
  spec: string
  json?: boolean
  cwd?: string
}

export function runBlame(opts: BlameOptions): number {
  const sepIdx = opts.spec.lastIndexOf('::')
  if (sepIdx < 0) {
    emitErr(`Invalid spec - expected "file::symbol", got: ${opts.spec}`)
    return 1
  }
  const cwd = opts.cwd ?? process.cwd()

  // Same ambiguity check runRead/runBrief already do -- refuse (with qualified retry
  // suggestions) instead of silently blaming the first same-named definition in the file.
  const sym = resolveSymbolSpecOrEmitError('blame', opts.spec, undefined)
  if (sym === null) return 1
  const filePath = sym.filePath
  const start = sym.lineStart
  const end = sym.lineEnd

  let raw: string
  try {
    const result = runGit(['blame', '-L', `${start},${end}`, '--', filePath], { cwd })
    if (result.exitCode !== 0) {
      emitErr(`git blame failed: ${result.stderr}`)
      return 1
    }
    raw = result.stdout
  } catch (e) {
    emitErr(`git blame failed: ${extractErrorMessage(e)}`)
    return 1
  }

  if (opts.json === true) {
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => {
      // A boundary commit (one at the edge of the blame range's history) is printed with a leading
      // `^`. Without matching it, every such line fell through to the raw fallback, dropping the
      // commit/author/date/line/content the text output shows fine. Capture the marker instead of
      // letting it break the parse, and flag it so the structured output keeps that distinction.
      const m = /^(\^?)([0-9a-f]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}[^)]*)\s+(\d+)\)(.*)/.exec(l)
      if (!m) return { raw: l }
      return { commit: m[2], boundary: m[1] === '^', author: (m[3] ?? '').trim(), date: (m[4] ?? '').trim(), line: Number.parseInt(m[5] ?? '0', 10), content: m[6] }
    })
    emit(JSON.stringify({ symbol: sym.name, file: filePath, lines }, null, 2))
    return 0
  }

  // Label with the RESOLVED symbol's own name rather than the raw spec slice: a spec may carry a disambiguating qualifier or `@LINE` anchor (`cmdUninstall.run`, `run@3999`) which is addressing syntax, not part of the symbol's name.
  emit(`${sym.name}\t${toDisplayPath(getDisplayRoot(opts.cwd), filePath)}:${start}-${end}`)
  emit(raw.trim())
  return 0
}

// ---- ask (experimental) -----------------------------------------------------

export interface AskOptions {
  question: string
  top?: number
  json?: boolean
}

// NOTE: cross-session answer cache is intentionally omitted to keep scope bounded. Add a file-based cache keyed on (question+context hash) if response latency becomes an issue.
export function runAsk(opts: AskOptions): number {
  // A --top of 0 (or negative) would ask searchSymbolsFts for zero-or-negative results --
  // reject explicitly instead of silently degrading with an empty context set, matching
  // runRefs' own --top validation.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 8
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  // `--top` bounds the evidence the answer is built from, which makes a silent cap here worse
  // than a silent cap on a list, not better: a synthesized answer grounded in 8 of 40 candidates
  // reads exactly like one grounded in all of them, and nothing downstream reveals the
  // difference. One extra row is enough to say a remainder exists (the `recall` pattern); an
  // exact total would need a second query and is not worth one per ask.
  const fetched = searchSymbolsFts(opts.question, top + 1, undefined, rootDir)
  const moreBeyondTop = fetched.length > top
  const hits = fetched.slice(0, top)
  if (moreBeyondTop) {
    emitErr(`Answer is grounded in the top ${countNoun(top, 'match', 'matches')}; more matched (raise --top to widen the evidence).`)
  }

  const BACKEND_ENV = 'TOKEN_GOAT_ASK_BACKEND'
  const backendLabel = process.env[BACKEND_ENV] ?? ''

  // Same reasoning as runContextFor's ContextEntry: without the `@LINE` anchor these suggestions
  // are unrunnable for any symbol name that has more than one definition in its file, and two
  // such entries are indistinguishable from each other in --json.
  interface AskEntry { file: string; symbol: string; kind: string; line: number; readCmd: string }
  const entries: AskEntry[] = hits.map((h) => ({ file: h.filePath, symbol: h.name, kind: h.kind, line: h.lineStart, readCmd: `token-goat read "${h.filePath}::${h.name}@${h.lineStart}"` }))

  // Every degrade path used to print one message: "set TOKEN_GOAT_ASK_BACKEND". That advice is only true for the unset case -- for a correctly-set backend that simply matched nothing, or one whose binary is missing from PATH, it tells the user to set a variable that is already set and hides the real reason. Each caller now supplies its own reason, the way runScope separates "cannot read" / "nothing indexed" / "no enclosing symbol".
  const degrade = (reason: string, extraNote?: string): number => {
    if (opts.json === true) {
      emit(JSON.stringify({ degraded: true, note: reason, ...(extraNote !== undefined ? { hint: extraNote } : {}), context: entries }, null, 2))
      return 0
    }
    emit(`[degraded mode - ${reason}]`)
    if (extraNote !== undefined) emit(extraNote)
    for (const e of entries) emit(`token-goat read "${toDisplayPath(rootDir, e.file)}::${e.symbol}@${e.line}"`)
    return 0
  }

  if (!backendLabel) return degrade(`set ${BACKEND_ENV}=claude|codex for LLM synthesis`)

  // A configured backend with zero retrieval hits has no grounding context to answer from --
  // calling the LLM anyway would hand it an empty SNIPPETS block and risk a hallucinated answer
  // presented as if it were grounded in this codebase. Degrade rather than proceeding to
  // synthesis, but say which of the two zero-hit causes it was: an empty index (nothing to
  // retrieve from at all) or a live index in which nothing matched this question.
  if (hits.length === 0) {
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) return degrade(`${BACKEND_ENV}=${backendLabel} is set, but nothing is indexed for this project yet, so there is no context to answer from`, emptyIndexMessage(rootDir))
    return degrade(`${BACKEND_ENV}=${backendLabel} is set, but no indexed symbol matched this question, so there is no context to answer from -- try different wording or token-goat semantic`)
  }

  const isWin = process.platform === 'win32'
  let backendPath: string | null = null
  try {
    const whichOut = execFileSync(isWin ? 'where.exe' : 'which', [backendLabel], { encoding: 'utf8' })
    const found = (whichOut ?? '').trim().split('\n')[0]?.trim() ?? ''
    if (found) backendPath = found
  } catch { /* fall through */ }

  if (!backendPath) return degrade(`${BACKEND_ENV}=${backendLabel} is set, but '${backendLabel}' was not found on PATH`)

  const context = hits.map((h, i) => `[${i + 1}] ${h.filePath}\n${h.body ?? ''}`).join('\n\n')
  const prompt = `Answer the QUESTION using only the CODE SNIPPETS below.\nQUESTION: ${opts.question}\n\nSNIPPETS:\n${context}\n\nANSWER:`

  const isCodex = backendLabel === 'codex'
  let codexOutPath: string | null = null
  try {
    // A resolved backend on Windows is frequently an npm .cmd/.bat wrapper (there is no separate
    // .exe for a Node-based CLI) -- spawnSync cannot exec .cmd/.bat directly without shell:true
    // and throws EINVAL otherwise, which the catch below swallowed into a silent degrade.
    let askArgs: string[]
    if (isCodex) {
      // Codex has no --print/--bare/--no-session-persistence flags -- those are Claude-Code-CLI-
      // specific. Codex's non-interactive entry point is the `exec` subcommand, and --ephemeral
      // is its equivalent of --no-session-persistence. Codex's stdout is very noisy (reasoning
      // summaries, hook logs, a token-usage block), so the answer is read back from
      // --output-last-message instead of result.stdout.
      codexOutPath = path.join(os.tmpdir(), `tg-ask-${process.pid}-${randomUUID()}.txt`)
      askArgs = ['exec', '--ephemeral', '--output-last-message', codexOutPath]
    } else {
      askArgs = ['--print', '--bare', '--no-session-persistence']
    }
    const needsShell = isWin && /\.(cmd|bat)$/i.test(backendPath)
    // A .cmd/.bat backend can't be exec'd directly by spawnSync; it has to go through cmd.exe.
    // Rather than lean on spawnSync's own shell:true string-concatenation (deprecated as DEP0190
    // on Windows, and the previous quoteIfNeeded lambda here only quoted an arg when it contained
    // whitespace, so a cmd metacharacter with no space passed through raw and an embedded `"` was
    // never escaped), invoke cmd.exe directly the way Node's own child_process internals do for a
    // .cmd/.bat target: `cmd.exe /d /s /c "<command>"` with windowsVerbatimArgs so spawnSync
    // doesn't re-quote the already-escaped command string. Every argument goes through
    // windowsCmdQuoteArg so cmd.exe's tokenizer never sees an unquoted metacharacter.
    const command = [backendPath, ...askArgs].map(windowsCmdQuoteArg).join(' ')
    const result = needsShell
      ? spawnSync(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { input: prompt, encoding: 'utf8', timeout: 30000, windowsVerbatimArguments: true })
      : spawnSync(backendPath, askArgs, { input: prompt, encoding: 'utf8', timeout: 30000 })
    let answer = ''
    if (result.status === 0) {
      if (codexOutPath) {
        try { answer = fs.readFileSync(codexOutPath, 'utf8').trim() } catch { /* leave answer empty, fall through to degraded */ }
      } else {
        answer = result.stdout?.trim() ?? ''
      }
    }
    if (answer) {
      if (opts.json === true) {
        emit(JSON.stringify({ answer, context: entries }, null, 2))
      } else {
        emit(answer)
      }
      return 0
    }
  } catch { /* fall through to degraded */
  } finally {
    if (codexOutPath) {
      try { fs.unlinkSync(codexOutPath) } catch { /* best-effort cleanup */ }
    }
  }

  return degrade(`${BACKEND_ENV}=${backendLabel} ran but returned no answer`)
}
