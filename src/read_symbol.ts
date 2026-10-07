/** The `symbol` command: every indexed definition of a name, or of each name `--grep` matches, printed with a short body preview. A bare name searches every indexed project unless `--project` scopes it or `indexing.cross_project_symbols = false` confines it to the project it is run from. Each hit is tagged when its file is gone from disk or could not be reindexed, and a name with no match gets the nearest indexed names instead. */

import { isIgnoredIndexPath } from './baseline.js'
import { querySymbols, queryRefCounts, countSymbols, distinctSymbolKinds, DEFAULT_QUERY_LIMIT } from './index_reader.js'
import { CORE_SYMBOL_KINDS } from './graph_traversal.js'
import { formatSymbolLocation } from './indexed_source.js'
import { toDisplayPath, displaySafeJson, displaySafeText } from './paths.js'
import { resolveSpecPath } from './spec_path.js'
import { globalDbPath } from './constants.js'
import { compileGrepMatcher, excludeTestsHiddenNote, countNoun, isTestFile } from './util.js'
import { grepFilteredToEmptyNotice } from './filter_notice.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import type { SymbolEntry } from './parser_types.js'
import { FirstRows, forEachSymbol, projectStructuredFiles, symbolsById, type SymbolHead } from './symbol_scan.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import { DIDYOUMEAN_LIMIT, didYouMean, findStructuredKeyPath, nearNamesSkippedNote, nearSymbolNames, rankSimilarNames } from './read_suggest.js'
import { confinementRefusal, resolveProjectConfinement, stripHtmlIdSpelling } from './read_spec.js'
import { formatStatsSuffix, hasRealDocstring } from './read_meta.js'
import { DELETED_TAG, docCommentLines, fileIsGone, guardJsonRows, guardText, healStaleIndex, healStaleResultFiles, indexFreshness, largestFileSize, recordReadStat, recordStaleServed, resolveBody, sinkGoneRows, staleWarning, truncationFooter, type TruncationTotal } from './read_commands.js'
import { fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import { forClient } from './mcp_client_text.js'

/** Body lines shown per `symbol` match before the preview is cut and the cut is announced. */
const SYMBOL_PREVIEW_LINES = 5


// The STALE counterpart of DELETED_TAG, for a result row whose file changed on disk and whose reindex was attempted and failed. A per-row suffix for the same reason DELETED_TAG is one: a bare `symbol NAME` spans every indexed project, so one hit can be current and the next one not.
const STALE_TAG = '⚠ STALE: file changed on disk and could not be reindexed'

/** Shared empty set for the common path where nothing was left stale, so the ordinary lookup allocates nothing. */
const EMPTY_PATH_SET: ReadonlySet<string> = new Set<string>()

export interface SymbolOptions {
  name?: string
  file?: string
  kind?: string
  limit?: number
  json?: boolean
  context?: number
  /** Project root to scope the search to. Defaults to `process.cwd()`; same field name as {@link SemanticOptions.projectRoot}. When `file` is a relative path, this is the base it resolves against. When no `file` filter is given, this also scopes a bare-name search to the given project instead of matching a same-named symbol anywhere across the machine-wide index -- relevant for callers (e.g. an MCP server) whose cwd is not the workspace root. */
  projectRoot?: string
  /** Only list symbols whose NAME matches this pattern, project-wide. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. Mutually exclusive with `name`: an exact `name` match is already pinned to one identifier, so regex-filtering that same fixed name is never useful. */
  grep?: string
  /** `--exclude-tests`: drop symbols DEFINED in a test file (per isTestFile), matching the flag already on refs/callers/dead/semantic. Opt-in; omitted or false leaves output byte-identical to today. Like `--grep`, this filters client-side, so it forces the over-fetch below -- filtering after the SQL LIMIT would let suppressed test symbols occupy slots ahead of the cutoff and silently under-return. */
  excludeTests?: boolean
  /** `--exclude-vendored`: drop symbols DEFINED under a directory the indexer itself skips (node_modules, dist, site-packages, ... -- the shared `isIgnoredIndexPath` predicate, not a second copy). Older index generations still hold such rows, so a bare name search can answer with a `node_modules/pdfjs-dist/...` definition ahead of the project's own. Opt-in; omitted or false leaves output byte-identical to today. Filters client-side like `--grep`, so it forces the same over-fetch -- filtering after the SQL LIMIT would let vendored rows occupy slots ahead of the cutoff and silently under-return. */
  excludeVendored?: boolean
  /** `--stats`: add a per-result reference count and doc-coverage flag, same shape as read/skeleton/outline's `--stats`. Opt-in; omitted or false leaves output byte-identical to today, and the extra `queryRefCounts` round trip is only paid when this is set. `symbol` is the one command in the family where this matters most for disambiguation -- it can return several same-named candidates across files -- but that is also where its known limitation bites hardest: `queryRefCounts` keys by symbol NAME (project-wide), not by definition site, so several same-named symbols in different files (e.g. under `--grep`) all show the identical count rather than a per-file one. Documented, not fixed, here for the same reason it is not fixed in read/skeleton/outline. */
  stats?: boolean
}

// A destructuring re-bind of an imported name: `const { x } = require('m')`, or the `await import()` form. The parser records one of these as a symbol named `x`, which is true as far as scope goes and wrong as an answer to "where is x defined" -- the definition is in the module being imported from, and this line is a use of it. Matched on the body rather than on `kind` because the kind these land in is `variable`, which is also what a genuine `export const HINT_CATEGORIES = [...]` is: demoting by kind would sink real definitions to fix a shape this regex identifies exactly. Linear-time by construction -- `[^}]*` is bounded by the following `\}` and no quantifier nests inside another.
const IMPORT_BIND_BODY_RE = /^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(/

/** Orders import re-binds after everything else while preserving the incoming order within each group (Array.prototype.sort is stable), so an exact-name lookup leads with a definition when one is present. */
function stableSortImportBindsLast<T extends { body?: string | null }>(rows: readonly T[]): T[] {
  const isBind = (r: T): number => (typeof r.body === 'string' && IMPORT_BIND_BODY_RE.test(r.body) ? 1 : 0)
  return [...rows].sort((a, b) => isBind(a) - isBind(b))
}

/** Handle ``token-goat symbol <name>``. */
export function runSymbol(opts: SymbolOptions): { text: string; code: number } {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero rows regardless of whether the symbol exists -- silently reporting "no matches" for a symbol that's actually indexed. Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    return { text: `--limit must be a positive number, got: "${opts.limit}"`, code: 1 }
  }
  // `--grep` IS the query when there is no exact name to anchor on. Combining it with a name is near-useless -- an exact `name = ?` match is already pinned to one identifier, so regex-filtering that same fixed name either matches everything or nothing -- and more likely a caller mistake than real intent, so reject the combination outright rather than silently pick a winner.
  if (opts.name !== undefined && opts.grep !== undefined) {
    return {
      text: 'symbol: --grep cannot be combined with a name; drop the name to search by pattern, or drop --grep to search by exact name',
      code: 1,
    }
  }
  if (opts.name === undefined && opts.grep === undefined) {
    return { text: 'symbol requires a name or --grep <pattern>', code: 1 }
  }

  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const excludeTests = opts.excludeTests === true
  const excludeVendored = opts.excludeVendored === true

  // `symbol` is the one read command that searches the machine-wide index by default, which is documented and useful on a personal machine and a disclosure channel on a shared one: from any indexed directory, `symbol --grep .` enumerates every symbol of every project ever indexed here, bodies included, without touching the filesystem -- so a directory sandbox around the agent does not contain it. `indexing.cross_project_symbols = false` confines the command to the project it is run from. The confinement has to cover --project and an absolute --file as well, or the setting is bypassed by the same caller it exists to constrain.
  const { root: confinedRoot, denial: projectDenial } = resolveProjectConfinement(opts.projectRoot)
  if (projectDenial !== null) return { text: projectDenial, code: 1 }
  if (confinedRoot !== null && opts.file !== undefined) {
    const fileDenial = confinementRefusal('--file', resolveSpecPath(opts.file, opts.projectRoot ?? process.cwd()), confinedRoot)
    if (fileDenial !== null) return { text: fileDenial, code: 1 }
  }

  const queryOpts: Parameters<typeof querySymbols>[0] = {}
  if (opts.file !== undefined) {
    queryOpts.filePath = resolveSpecPath(opts.file, opts.projectRoot ?? process.cwd())
    // Self-heal before querying so a stale index serves fresh data instead of a warning.
    healStaleIndex(queryOpts.filePath)
  }
  if (opts.name !== undefined) queryOpts.name = queryOpts.filePath !== undefined ? stripHtmlIdSpelling(opts.name, queryOpts.filePath) : opts.name
  if (opts.kind !== undefined) queryOpts.kind = opts.kind
  // `--grep` filters client-side on NAME (no regex support in SQL) and `--exclude-tests`/`--exclude-vendored` on file path, so none of the three can become a SQL `LIMIT`: filtering after the slice returns however many of the top-N unfiltered rows happen to match, not N matching rows, and N test-file symbols could fill the result set and leave nothing to show, reporting "no matches" for a symbol that is indexed. That was papered over by over-fetching 20,000 rows first, which is a cap all the same -- three indexed projects on the machine this was measured on exceed it -- so the filtered path now walks the whole scope (src/symbol_scan.ts) and keeps only what it will print. The unfiltered path keeps its SQL `LIMIT`, which is exact there because nothing narrows the rows after the query.
  const anyClientFilter = matchesGrep !== undefined || excludeTests || excludeVendored
  // Matches querySymbols's own fallback, so the unfiltered path's SQL `LIMIT` and the filtered path's keep-ceiling stay the same number rather than two spellings of it.
  const effectiveLimit = opts.limit ?? DEFAULT_QUERY_LIMIT
  if (!anyClientFilter && opts.limit !== undefined) {
    queryOpts.limit = opts.limit
  }
  // Only scope a bare-name search to projectRoot; when `file` already pins an exact indexed path there's nothing left to disambiguate across projects.
  if (opts.file === undefined && opts.projectRoot !== undefined) queryOpts.rootDir = opts.projectRoot
  // Confinement supplies the scope the caller left open, so a bare-name lookup with no --project searches this project instead of the whole machine.
  if (opts.file === undefined && queryOpts.rootDir === undefined && confinedRoot !== null) queryOpts.rootDir = confinedRoot

  // One pass over the scope that keeps only the rows this call can print, alongside the exact counts the notices below quote. Both shapes run through it so the filter, the counts and the heal retry stay in one place: a client-filtered call walks every row, a plain lookup takes the single SQL-limited page it always did.
  interface SymbolSweep { kept: SymbolEntry[]; keptCount: number; scanned: number; hiddenByExcludeTests: number; files: Set<string>; mineCount: number; mineKept: number }
  // An unconfined lookup lists the current project's rows ahead of every other project's: the machine-wide index is ordered by file path, so a project whose path sorts earlier buried the local definition under pages of someone else's.
  const preferRoot = opts.file === undefined && queryOpts.rootDir === undefined ? resolveProjectRoot({ project: process.cwd() }) : undefined
  const rowKept = (s: { filePath: string; name: string }): boolean =>
    (matchesGrep === undefined || matchesGrep(s.name)) && !(excludeTests && isTestFile(s.filePath)) && !(excludeVendored && isIgnoredIndexPath(s.filePath))
  const runSweep = (): SymbolSweep => {
    const found: SymbolSweep = { kept: [], keptCount: 0, scanned: 0, hiddenByExcludeTests: 0, files: new Set(), mineCount: 0, mineKept: 0 }
    const admit = (s: { filePath: string; name: string }): boolean => {
      found.scanned++
      found.files.add(s.filePath)
      const nameKept = matchesGrep === undefined || matchesGrep(s.name)
      if (rowKept(s)) {
        found.keptCount++
        return true
      }
      // Counted after --grep so the two filters never report the same row twice; only used to explain an empty result below.
      if (excludeTests && nameKept && isTestFile(s.filePath)) found.hiddenByExcludeTests++
      return false
    }
    if (anyClientFilter) {
      // The scan reads no bodies: only the rows that will print are read in full, once the walk has picked them. With a preferred project the walk runs twice: once inside it for the leading rows, once over everything for the counts and the rest, whose cap leaves room for the leading rows it will meet again.
      const mine = new FirstRows<SymbolHead>(effectiveLimit)
      if (preferRoot !== undefined) {
        forEachSymbol({ ...queryOpts, rootDir: preferRoot }, (s: SymbolHead) => {
          if (rowKept(s)) {
            found.mineKept++
            mine.offer(s)
          }
        })
      }
      const mineRows = mine.rows()
      const mineIds = new Set(mineRows.map((s) => s.id))
      const first = new FirstRows<SymbolHead>(effectiveLimit + mineRows.length)
      forEachSymbol(queryOpts, (s: SymbolHead) => {
        if (admit(s)) first.offer(s)
      })
      const rest = first.rows().filter((s) => !mineIds.has(s.id))
      found.mineCount = mineRows.length
      found.kept = symbolsById([...mineRows, ...rest].slice(0, effectiveLimit).map((s) => s.id))
    } else if (preferRoot !== undefined) {
      const mineRows = querySymbols({ ...queryOpts, rootDir: preferRoot, limit: effectiveLimit })
      // A short page is the whole project's matches, so the global page below can drop exactly those rows; a full page leaves no room for anything else.
      const rowKey = (r: SymbolEntry): string => [r.filePath, r.lineStart, r.name].join('|')
      const mineKeys = new Set(mineRows.map(rowKey))
      const all = querySymbols({ ...queryOpts, limit: effectiveLimit + mineRows.length })
      for (const row of all) admit(row)
      found.kept = [...mineRows, ...all.filter((r) => !mineKeys.has(rowKey(r)))].slice(0, effectiveLimit)
      found.mineCount = mineRows.length
    } else {
      for (const row of querySymbols(queryOpts)) if (admit(row) && found.kept.length < effectiveLimit) found.kept.push(row)
    }
    return found
  }

  let sweep = runSweep()
  // A bare `symbol NAME` names no file, so the pre-query heal above never ran for it -- and that is the form `symbol --help` documents first. It answered from stale rows with no warning at all, while `read "file::symbol"` against the same file self-healed and returned the current body: the same data, two documented commands, two different answers. Heal whatever the query actually hit, then ask again.
  let stillStale: ReadonlySet<string> = EMPTY_PATH_SET
  if (opts.file === undefined) {
    const heal = healStaleResultFiles([...sweep.files])
    stillStale = heal.stillStale
    if (heal.healed) sweep = runSweep()
  }
  const preFilterCount = sweep.scanned
  const unordered = sweep.kept.slice(0, effectiveLimit)
  // Applied inside each group, so the leading project's rows stay ahead of everyone else's whatever their kind.
  const orderGroup = (rows: SymbolEntry[]): SymbolEntry[] => (opts.name === undefined ? rows : stableSortImportBindsLast(rows))
  const ordered = [...orderGroup(unordered.slice(0, sweep.mineCount)), ...orderGroup(unordered.slice(sweep.mineCount))]
  // An exact-name lookup asks where a thing is defined, and `file_path, line_start` answers it by alphabet: `const { ambigProbeFn } = await import('../src/thing.js')` in scripts/ sorts ahead of the real function in src/ purely because "scripts" precedes "src", so the first block a caller reads is an import statement rather than the body it went looking for. Sink the rows that only re-bind an imported name, keeping the query's own order within each group so the existing tie-breaks and paging behaviour are untouched. Nothing is dropped -- every candidate still prints, so a misjudged row costs one position and never an answer, which is the reason this reorders rather than filters. `--grep` listings are deliberately excluded: those are a browse of many different names, where file order is the useful one.
  const results = sinkGoneRows(ordered, (s) => s.filePath)
  // A named file is judged once by staleWarning below (or the JSON branch); a bare lookup spans many files, so it books the states its own rows carry.
  if (opts.file === undefined) {
    if (results.some((s) => stillStale.has(s.filePath))) recordStaleServed('symbol', 'stale')
    if (results.some((s) => fileIsGone(s.filePath))) recordStaleServed('symbol', 'deleted')
  }

  const hiddenByExcludeTests = sweep.hiddenByExcludeTests

  if (excludeTests && sweep.keptCount === 0 && hiddenByExcludeTests > 0) {
    // The symbol IS indexed, just only ever in test files. Saying "No matches" here would be a lie that stops the caller looking; name the filter that hid them instead.
    const label = opts.name ?? opts.grep ?? '*'
    const notice = `no non-test matches for '${label}' (${excludeTestsHiddenNote(hiddenByExcludeTests)})`
    if (opts.json === true) {
      return { text: displaySafeJson({ items: [], truncated: false, totalCount: 0 }), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }

  if (matchesGrep !== undefined && sweep.keptCount === 0 && preFilterCount > 0) {
    // The scope (--file/--kind/--project) genuinely has symbols, but --grep matched none of them -- distinct from the `results.length === 0` branch below, which means there was nothing in scope at all. Same "filtered store renders as populated" trap already fixed for types/dead/exports.
    if (opts.json === true) {
      const text = displaySafeJson({ items: [], truncated: false, totalCount: 0 })
      return { text, code: 0 }
    }
    return { text: grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'symbol', 'symbols'), code: 0 }
  }

  if (results.length === 0) {
    // The same empty payload every other zero-result branch of this command emits, so a miss parses: `symbol NAME --json | jq` used to receive the prose line below, on stderr, with exit 1. None of the text-mode diagnosis runs for it -- a JSON caller reads `totalCount`, not prose.
    if (opts.json === true) {
      return { text: displaySafeJson({ items: [], truncated: false, totalCount: 0 }), code: 0 }
    }
    let text = `No matches for '${opts.name ?? opts.grep ?? '*'}'`
    // Kinds are matched exactly and stored lower-case, so `--kind Method` empties the scope on its own; name a kind no indexed symbol carries, as `dead --kind` does, instead of letting the miss read as an empty project. A recognized kind is skipped without a query: its absence is an ordinary miss.
    if (opts.kind !== undefined && !CORE_SYMBOL_KINDS.includes(opts.kind)) {
      const storedKinds = distinctSymbolKinds(opts.projectRoot)
      if (!storedKinds.includes(opts.kind)) {
        text += `\nno indexed symbol has kind '${opts.kind}'`
        // A different-case spelling of a real kind is the answer on its own; ranking it beside every kind containing it would bury it under apex_method and lwc_api_method.
        const lower = opts.kind.toLowerCase()
        const recased = [...new Set([...storedKinds, ...CORE_SYMBOL_KINDS])].filter((k) => k.toLowerCase() === lower)
        const closes = recased.length > 0 ? recased : rankSimilarNames(storedKinds, opts.kind)
        if (closes.length > 0) text += `\n${didYouMean(closes)}`
      }
    }
    // Resolved once here, before the near-name ranking, because both the `Try: semantic` fallback and the trailing empty-index note need the answer -- and the fallback needs it to decide whether to print at all. Still only paid after the query already came back empty.
    const emptyIndexRoot = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
    const indexEmpty = isIndexEmptyForProject(globalDbPath(), emptyIndexRoot)
    if (opts.name !== undefined) {
      // Same near-name mechanism as `find`: match the project's names by case-insensitive substring in either direction, so a typo'd or partial name still gets a cheap next step instead of dead-ending into a full-file Read or a wide Grep.
      const rootDir = emptyIndexRoot
      // Each question below is its own narrow query rather than one visit over every row. That visit, a forEachSymbol walk when it still paged by OFFSET, cost 187 s of SQLite time on a 546,394-symbol project, all of it in 55 pages that each sorted every row in scope with its body, while none of these answers needs more than names, and a walk of every row is still more than they need now that the pages are keyset pages. The exact-name one is an indexed `name = ?` lookup with no cap problem: it is scoped to the same project and asks for the same name, so every row it could miss past its limit is one the count below still reports.
      const exactMatches = querySymbols({ name: opts.name, rootDir, limit: DIDYOUMEAN_LIMIT })
      // An EXACT name match in the project cannot be a typo: the caller spelled the symbol correctly and the lookup above only came back empty because a scope filter (--kind/--file) narrowed it away. Reporting that as "Did you mean: alphaOne" for the query `alphaOne` prints a correction byte-identical to what was typed, and pairs it with a "No matches" line that reads as proof the symbol does not exist -- so the caller concludes it is absent and falls back to a full Read. Name the scope that hid it instead.
      if (exactMatches.length > 0) {
        const total = exactMatches.length < DIDYOUMEAN_LIMIT ? exactMatches.length : countSymbols({ name: opts.name, rootDir })
        const where = exactMatches.map((s) => `${s.kind} at ${formatSymbolLocation(toDisplayPath(rootDir, s.filePath), s.lineStart)}`).join('; ')
        const more = total > exactMatches.length ? ` (+${total - exactMatches.length} more)` : ''
        const flags = [opts.kind !== undefined ? '--kind' : null, opts.file !== undefined ? '--file' : null].filter((f): f is string => f !== null)
        const widen = flags.length > 0 ? `drop ${flags.join('/')} to see it` : 'widen the search scope to see it'
        text += `\n'${opts.name}' IS indexed (${where}${more}) -- ${widen}`
      } else {
        const near = nearSymbolNames(opts.name, rootDir)
        // On an empty index `semantic` fails exactly as `symbol` just did, so suggesting it sends the caller into a second dead end before they ever reach the note below that names the real fix. Suppressed only in that case: with any index at all the fallback is still the right next step, and it is the one left when the ranking was skipped for size.
        const semanticHint = indexEmpty ? '' : `\nTry: token-goat semantic ${quotedArg(opts.name)}`
        if (near.skipped) text += `\n${nearNamesSkippedNote()}${semanticHint}`
        else text += near.candidates.length > 0 ? `\n${didYouMean(near.candidates)}` : semanticHint
      }
      // Appended in BOTH branches on purpose: the didYouMean case is exactly the one that needs correcting, since a near-name suggestion ("Did you mean: sql" for `better-sqlite3`) reads as a confident answer and points away from the real one.
      const structuredFiles = projectStructuredFiles(rootDir)
      const hit = findStructuredKeyPath(opts.name, structuredFiles)
      if (hit !== null) {
        const display = toDisplayPath(rootDir, hit.filePath)
        // quotedArg single-quotes a key holding `$` (a JSON Schema `$ref`), which bash and PowerShell both leave unexpanded.
        text += `\n'${opts.name}' is a key in ${display} at ${hit.dotPath} -- JSON/YAML keys below the top level are not symbols; read it with: ${fencedCommand(`token-goat ${hit.command} ${quotedArg(display)} ${quotedArg(hit.dotPath)}`)}`
      }
    }
    if (indexEmpty) {
      text += `\n${emptyIndexMessage(emptyIndexRoot)}`
    }
    return { text, code: 1 }
  }

  const fullSourceBytes = largestFileSize(results.map((s) => s.filePath))

  // Shared by both the --json payload and the human blocks below, so a caller-supplied projectRoot (or none) resolves the same way for either output mode.
  const symbolDisplayRoot = getDisplayRoot(opts.projectRoot)

  // Only queried when --stats is actually requested, and only after every early-return above -- a zero-result or filtered-to-empty call must not pay for an extra DB round trip. Same call shape as read's single-symbol lookup and prepareSymbolListing's skeleton/outline lookup.
  const refCounts =
    opts.stats === true
      ? queryRefCounts(
          results.map((s) => s.name),
          globalDbPath(),
          resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }),
        )
      : undefined

  if (opts.json === true) {
    const capped = guardJsonRows(results)
    let trueTotal: number
    let truncatedFlag: boolean
    if (anyClientFilter) {
      // No SQL regex support, and no SQL notion of "is a test file" either -- `keptCount` is the post-filter count over the whole scope, since the sweep above walks every row rather than a window, so it is the honest total for what --grep/--exclude-tests actually matched. countSymbols(queryOpts) would instead report the pre-filter count of the whole kind/file/rootDir scope, which contradicts the filtered rows below.
      trueTotal = sweep.keptCount
      truncatedFlag = capped.truncated || results.length < sweep.keptCount
    } else {
      // `results` is already truncated by querySymbols's own SQL `LIMIT` (opts.limit, or the default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length) is not the real number of matching symbols -- countSymbols reruns the same filters with no LIMIT to report an honest total, the same distinction json_query's --head already makes (its totalCount survives --head unlike this one used to).
      trueTotal = countSymbols(queryOpts)
      truncatedFlag = capped.truncated || trueTotal > results.length
    }
    // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(symbolDisplayRoot, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json.
    const items = capped.items.map((s) => ({
      ...s,
      filePath: toDisplayPath(symbolDisplayRoot, s.filePath),
      // Only present when true, so a result set of live files stays byte-identical to what this command has always emitted and only the genuinely-gone rows grow a field.
      ...(fileIsGone(s.filePath) ? { deleted: true } : {}),
      ...(stillStale.has(s.filePath) ? { stale: true } : {}),
      ...(refCounts !== undefined ? { refCount: refCounts.get(s.name) ?? 0, hasDoc: hasRealDocstring(s.docstring) } : {}),
    }))
    const payload = { items, truncated: truncatedFlag, totalCount: trueTotal }
    if (opts.file !== undefined) recordStaleServed('symbol', indexFreshness(resolveSpecPath(opts.file, opts.projectRoot ?? process.cwd())))
    const text = displaySafeJson(payload)
    recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file ?? opts.grep)
    return { text, code: 0 }
  }

  // Header + short body preview per match (mirrors the richer surface that the native CLI handler used before the two read surfaces were consolidated).
  const blocks = results.map((sym) => {
    const statsStr = formatStatsSuffix(refCounts, sym)
    // Per match, not one banner for the whole result set: a bare `symbol NAME` searches every indexed project, so one hit can be a live file and the next one a checkout that was deleted months ago. A single header line would have to lie about one of them.
    const goneTag = fileIsGone(sym.filePath) ? `  ${DELETED_TAG}` : ''
    const staleTag = stillStale.has(sym.filePath) ? `  ${STALE_TAG}` : ''
    // The doc comment sits above lineStart, outside the body, so `symbol` printed the body alone while `read` printed both; it is shown in full and kept out of the SYMBOL_PREVIEW_LINES count, which is a budget for the body.
    const doc = docCommentLines(sym)
    const docLabel = doc.length > 0 ? ` + ${doc.length}-line doc comment` : ''
    const header = `# ${displaySafeText(sym.name)} (${sym.kind}) — ${formatSymbolLocation(displaySafeText(toDisplayPath(symbolDisplayRoot, sym.filePath)), sym.lineStart, sym.lineEnd)}${docLabel}${statsStr}${goneTag}${staleTag}`
    const body = resolveBody(sym)
    const bodyLines = body.split(/\r?\n/)
    const preview = [...doc, ...bodyLines.slice(0, SYMBOL_PREVIEW_LINES)].join('\n')
    // The header states the symbol's real line span, so a five-line preview of a forty-line function looked like the whole thing was five lines long -- a silent cap of exactly the kind truncationFooter below exists to prevent. Say what was cut and how to get the rest.
    const dropped = bodyLines.length - SYMBOL_PREVIEW_LINES
    const elided =
      dropped > 0
        ? forClient(`\n  ...(${countNoun(dropped, 'more line')}; full body: ${fencedCommand('token-goat read ' + quotedArg(`${displaySafeText(toDisplayPath(symbolDisplayRoot, sym.filePath))}::${displaySafeText(sym.name)}`))})`)
        : ''
    return preview.trim() !== '' ? `${header}\n${preview}${elided}` : header
  })
  const warning = opts.file !== undefined ? staleWarning(resolveSpecPath(opts.file, opts.projectRoot ?? process.cwd()), 'symbol') : ''
  const text = guardText(warning + blocks.join('\n\n'), 'symbol')
  recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file ?? opts.grep)
  // Under a client-side filter the sweep walked every row in scope, so its kept count is the exact total rather than a floor.
  let cachedTotal: TruncationTotal | undefined
  const symbolTotal = (): TruncationTotal => {
    cachedTotal ??= anyClientFilter ? { count: sweep.keptCount, exact: true } : { count: countSymbols(queryOpts), exact: true }
    return cachedTotal
  }
  const footer = truncationFooter(results.length, effectiveLimit, symbolTotal, 'matches', '--limit')
  // Only said when a page was cut and some of it is this project's: the reader needs to know the leading rows are theirs and how to see only them.
  const mineTotal = footer !== '' && preferRoot !== undefined ? (anyClientFilter ? sweep.mineKept : countSymbols({ ...queryOpts, rootDir: preferRoot })) : 0
  // `-p` only narrows the search when some matches live in other projects: with every match already local the flag is a no-op.
  const someElsewhere = mineTotal > 0 && mineTotal < symbolTotal().count
  const mineNote = someElsewhere ? `\ntoken-goat: ${mineTotal} of the matches are in this project and listed first; pass -p to search only it` : ''
  return { text: text + footer + mineNote, code: 0 }
}
