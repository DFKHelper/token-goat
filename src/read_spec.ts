import * as path from 'node:path'
import { loadConfig } from './config.js'
import { globalDbPath } from './constants.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { querySymbols } from './index_reader.js'
import { detectLanguage } from './parser_types.js'
import type { SymbolEntry } from './parser_types.js'
import { resolveLineRegions, type LineRegion } from './line_regions.js'
export { resolveLineRegions, type LineRegion } from './line_regions.js'
import { displaySafeJson, displaySafeText, normalizePath, toDisplayPath } from './paths.js'
import { expandSpecPath, resolveSpecPath } from './spec_path.js'
import { findProject, getDisplayRoot, isInsideRoot, resolveProjectRoot } from './project.js'
import { fileExists, findSpecSeparator, guardText, healStaleIndex, indexFileSyncPinned, indexFreshness, readFileText, recordStaleServed, resolveAgainstProjectRoot, staleWarning, type ReadOptions } from './read_commands.js'
import { emitErr } from './emit.js'
import { FIND_SCAN_LIMIT } from './query_limits.js'
import {
  didYouMean,
  endsWithPathBoundary,
  formatCrossFileLead,
  rankSimilarNames,
} from './read_suggest.js'
import { countNoun, foldPath } from './util.js'
import { CliError, formatCommandError } from './command_error.js'
import { couldNotRead, echoedValue, fencedCommand, quotedArg } from './hint_suggestion_guard.js'

const PARENT_IDENTIFIER_RE = /^[\w$]+$/

export type SymbolResolution =
  | { kind: 'ok'; entry: SymbolEntry }
  | { kind: 'confined'; message: string }
  | { kind: 'ambiguous'; symbol: string; file: string; candidates: SymbolEntry[] }
  | { kind: 'none' }

export function parseReadSpec(spec: string): { file: string; symbol?: string } {
  const colonIdx = findSpecSeparator(spec)
  if (colonIdx === -1) return { file: spec }
  return { file: spec.slice(0, colonIdx), symbol: spec.slice(colonIdx + 2) }
}

export function parseCrossFileMultiSpec(spec: string): { file: string; symbol: string }[] | null {
  const segments = spec.split(',')
  if (segments.length < 2) return null
  if (findSpecSeparator(segments[0]!) === -1) return null
  if (segments.filter((seg) => findSpecSeparator(seg) !== -1).length < 2) return null

  let currentFile: string | undefined
  const pairs: { file: string; symbol: string }[] = []
  for (const rawSeg of segments) {
    const seg = rawSeg.trim()
    const idx = findSpecSeparator(seg)
    if (idx !== -1) {
      currentFile = seg.slice(0, idx)
      const sym = seg.slice(idx + 2)
      if (sym.length > 0) pairs.push({ file: currentFile, symbol: sym })
      continue
    }
    if (currentFile !== undefined && seg.length > 0) pairs.push({ file: currentFile, symbol: seg })
  }
  return pairs.length > 1 ? pairs : null
}

export function parseMultiFileSpec(spec: string): string[] | null {
  if (!spec.includes(',')) return null
  if (fileExists(spec)) return null
  if (findSpecSeparator(spec) !== -1) return null
  const parts = spec.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return parts.length > 1 ? parts : null
}

/** The file portion of one `read`/`section` spec: `file::symbol`, `file@N-M`, `file:N-M`, or a bare path. Reuses {@link parseLineRange} and {@link findSpecSeparator} instead of restating their grammar here, so the MCP confinement gate's notion of "the file part" agrees with the execution layer's by construction. Two hand-kept-in-sync regexes previously drifted apart on both syntaxes they cover: an `@` suffix that parseLineRange would decline (no trailing digits, a `::` in the prefix, or a literal file that happens to contain `@`) was still stripped here, validating a shorter in-root prefix while runRead resolved the untouched, longer, possibly out-of-root spec; and a spec with two `::` occurrences split on the FIRST one here but the LAST one in findSpecSeparator (used by both runRead and runSection), so `a::../../b::c` was validated as `a` while `a::../../b` was actually read. When in doubt, this returns the more inclusive (longer) string, never a shortened prefix -- see parseLineRange/findSpecSeparator for the precedence (`@`-range first, then the `:N`/`:N-M` region spec, matching runRead's own check order). */
export function specFilePart(spec: string): string {
  const range = parseLineRange(spec)
  if (range !== null) return range.file
  const region = parseColonLineSpec(spec)
  if (region !== null) return region.file
  const colonIdx = findSpecSeparator(spec)
  return colonIdx === -1 ? spec : spec.slice(0, colonIdx)
}

export function extraFileArgsNote(
  command: string,
  first: string,
  extras: readonly string[],
  opts: { noun?: 'file' | 'spec'; mergeable?: boolean } = {},
): string {
  const noun = opts.noun ?? 'file'
  const head = `Note: ${countNoun(extras.length, `extra ${noun} argument`)} ignored (${extras.join(', ')}).`
  // An unquoted path holding spaces reaches the CLI split into words; when the words rejoined with spaces name a real file, that path is what was meant, so suggest it quoted rather than a comma list of its fragments.
  const spaced = [first, ...extras].join(' ')
  if (fileExists(expandSpecPath(noun === 'spec' ? specFilePart(spaced) : spaced))) return `${head} Together they make one ${noun === 'spec' ? 'spec' : 'path'} holding spaces, which a shell splits unless it is quoted: token-goat ${command} ${quotedArg(spaced)}`
  if (opts.mergeable === false) return `${head} Run ${command} once per ${noun}.`
  return `${head} ${command} reads one ${noun}, or a comma-separated list: token-goat ${command} ${quotedArg([first, ...extras].join(','))}`
}

export function parseLineRange(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null) return null
  if (fileExists(spec)) return null
  if (m[1]!.includes('::')) return null
  const start = parseInt(m[2]!, 10)
  const end = m[3] !== undefined ? parseInt(m[3], 10) : start
  return { file: m[1]!, start, end }
}

/** A `file:142` / `file:142-160` line spec -- the shape an agent already holds when a grep hit, a stack trace, or a diff hunk handed it a line number. Split on the LAST `:` by index rather than with a regex group, for the same reason findSpecSeparator does: a Windows absolute path (`C:/Projects/foo.ts:142`) carries a drive-letter colon that a lazy group would split on, turning the path into `C` and the line spec into `/Projects/foo.ts:142`. The suffix must match `^\d+(-\d+)?$` in its entirety, so anything else after the last colon (`file::symbol`, `C:/Projects/foo.ts`) stays a path. One guard keeps the existing `::` grammar whole and the error messages honest: the file part must be colon-free past its optional drive colon. That declines `file::120` and `file::2:4` (whose last colon is the range separator, not a path one), the same cases the `endsWith(':')` / `includes('::')` pair it replaced was written for -- without it `file::2:4` was captured with file = `file::2`, breaking a range spelling that already worked -- and it also declines the stray-colon specs those two missed. */
export function parseColonLineSpec(spec: string): { file: string; start: number; end: number } | null {
  const colonIdx = spec.lastIndexOf(':')
  if (colonIdx <= 0) return null
  const suffix = spec.slice(colonIdx + 1)
  if (!/^\d+(?:-\d+)?$/.test(suffix)) return null
  const file = spec.slice(0, colonIdx)
  if (file === '') return null
  // The file part may carry exactly one colon, the Windows drive colon at index 1. Any other colon means this spec is not a line spec at all, and the two shapes that proves matter: `src/f.ts:1:2` used to be captured with file = `src/f.ts:1`, and the drive-relative `C:142` (drive C, file `142`) with file = `C` -- both then failed with `Could not read:` naming a path the user never typed. A single leading letter is that drive colon and nothing else, so it declines; a longer prefix keeps its drive colon and is checked past it. This subsumes the two guards that used to stand here, `endsWith(':')` for `file::120` and `includes('::')` for `file::2:4`, whose own reasons are recorded above.
  if (/^[A-Za-z]$/.test(file)) return null
  const pastDrive = /^[A-Za-z]:/.test(file) ? file.slice(2) : file
  if (pastDrive === '' || pastDrive.includes(':')) return null
  if (fileExists(spec)) return null
  const dash = suffix.indexOf('-')
  const start = parseInt(dash === -1 ? suffix : suffix.slice(0, dash), 10)
  const end = dash === -1 ? start : parseInt(suffix.slice(dash + 1), 10)
  return { file, start, end }
}

export function parseColonLineRange(symbol: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:[-:,](\d+))?$/.exec(symbol)
  if (m === null) return null
  const start = parseInt(m[1]!, 10)
  const end = m[2] !== undefined ? parseInt(m[2], 10) : start
  return { start, end }
}

/** Whether `read` would still serve every one of `specs` if they were comma-joined into a single argument -- the question {@link extraFileArgsNote} has to answer before it prints that joined string as advice. Answered by replaying {@link runRead}'s own dispatch over the joined string in its own order rather than by re-deriving which shapes merge: a merged spec is served only if it reaches `runReadMulti`, so anything the two line-spec branches claim first (`a@1-2,b@3-4` is one `@` range ending in `3-4`; `a.ts:40,b.ts:120` and a bare `a.ts,b.ts` reach neither multi path) is not mergeable, however plausible the comma looks. The note used to promise the comma form unconditionally, and for those shapes printed a command that exits 1. */
export function readSpecsMergeable(specs: readonly string[]): boolean {
  if (specs.length < 2) return true
  const joined = specs.join(',')
  if (parseLineRange(joined) !== null) return false
  if (parseColonLineSpec(joined) !== null) return false
  if (parseCrossFileMultiSpec(joined) !== null) return true
  const { symbol } = parseReadSpec(joined)
  return symbol !== undefined && symbol !== '' && symbol.includes(',') && parseColonLineRange(symbol) === null
}

/** The same question {@link readSpecsMergeable} answers, for `brief`, `refs` and `section`, which do not share `read`'s dispatch and so cannot share its predicate. All three take a spec naming something inside a file, and all three merge a comma list only while every element still does. Verified against the shipped binary: `a.ts::x,b.ts::y`, `a.ts::x,a.ts::y` and the anchor form `a.ts::x@97,a.ts::y` each exit 0, while `a.ts:40,a.ts:120`, `a.ts@40-42,a.ts@50-52` and a bare `a.ts,b.ts` each exit 1. Without this the note promised the comma form unconditionally and printed a command that exits 1, the same defect the `read` note carried. */
export function namedSpecsMergeable(specs: readonly string[]): boolean {
  if (specs.length < 2) return true
  return specs.every((spec) => spec.includes('::'))
}

export function runLineRange(
  range: { file: string; start: number; end: number },
  opts: ReadOptions,
): { text: string; code: number } {
  const { file, start, end } = range
  const diskPath = resolveAgainstProjectRoot(file, opts.projectRoot)
  if (start < 1) {
    return { text: `Invalid line range: start must be >= 1 (got ${start})`, code: 1 }
  }
  if (end < start) {
    return { text: `Invalid line range: end (${end}) is before start (${start})`, code: 1 }
  }
  const text = readFileText(diskPath)
  if (text === null) {
    return { text: couldNotRead(file), code: 1 }
  }
  const allLines = text.split(/\r?\n/)
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    return { text: `Line ${start} is past end of file (${countNoun(allLines.length, 'line')}): ${file}`, code: 1 }
  }
  const clampedEnd = Math.min(end, allLines.length)
  const slice = allLines.slice(start - 1, clampedEnd)
  if (opts.json === true) {
    return { text: displaySafeJson({ file, start, end: clampedEnd, lines: slice }), code: 0 }
  }
  const tok = Math.ceil(slice.join('\n').length / 4)
  return {
    text: guardText(
      [`# lines ${start}-${clampedEnd} of ${allLines.length} (~${tok} tok)`, slice.join('\n')].join('\n'),
      'lines',
    ),
    code: 0,
  }
}

/** Serve a `file:142` / `file:142-160` spec by resolving the line span to the regions it overlaps ({@link resolveLineRegions}) and printing each one whole. Every block discloses both what it is and its true line span, because the failure mode here is a narrowed answer that reads as a complete one: a caller that asked for line 142 and got lines 120-190 has to be able to tell. A file with no indexed symbols, or a line past EOF, is reported as such rather than answered with an adjacent slice. */
export function runLineRegion(
  range: { file: string; start: number; end: number },
  opts: ReadOptions,
): { text: string; code: number } {
  const { file, start, end } = range
  if (start < 1) return { text: `Invalid line range: start must be >= 1 (got ${start})`, code: 1 }
  if (end < start) return { text: `Invalid line range: end (${end}) is before start (${start})`, code: 1 }
  const resolved = resolveSpecPath(file, opts.projectRoot ?? process.cwd())
  const confined = fileConfinementRefusal('This file', file, opts.projectRoot)
  if (confined !== null) return { text: confined, code: 1 }
  const text = readFileText(resolveAgainstProjectRoot(file, opts.projectRoot))
  if (text === null) return { text: couldNotRead(file), code: 1 }
  const allLines = text.split(/\r?\n/)
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    return { text: `Line ${start} is past end of file (${countNoun(allLines.length, 'line')}): ${file}`, code: 1 }
  }
  if (opts.forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
  } else {
    healStaleIndex(resolved)
  }
  const symbols = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT })
  const regions = resolveLineRegions(symbols, allLines.length, start, end)
  const asked = start === end ? `${start}` : `${start}-${end}`
  if (regions.length === 0) {
    return {
      text:
        `No indexed symbols in ${echoedValue(file)}, so line ${asked} cannot be resolved to a region.\n` +
        `Read the raw lines instead: token-goat read ${quotedArg(`${file}@${asked}`)}`,
      code: 1,
    }
  }
  const slice = (r: LineRegion): string => allLines.slice(r.start - 1, Math.min(r.end, allLines.length)).join('\n')
  if (opts.json === true) {
    const freshness = indexFreshness(resolved)
    recordStaleServed('read', freshness)
    return {
      text: displaySafeJson({
        file,
        requested: { start, end },
        regions: regions.map((r) => ({
          kind: r.kind,
          label: r.label,
          start: r.start,
          end: Math.min(r.end, allLines.length),
          lines: allLines.slice(r.start - 1, Math.min(r.end, allLines.length)),
        })),
        // The text form prepends staleWarning's line; these are the keys the other --json outputs use for the same two states (runRead's `deleted`, runSymbol's per-row `stale`).
        ...(freshness === 'deleted' ? { deleted: true } : freshness === 'stale' ? { stale: true } : {}),
      }),
      code: 0,
    }
  }
  const blocks: string[] = []
  if (regions.length > 1) blocks.push(`# ${file}:${asked} -> ${countNoun(regions.length, 'region')}`)
  regions.forEach((r, i) => {
    const body = slice(r)
    const tag = regions.length > 1 ? `[${i + 1}/${regions.length}] ` : `${file}:${asked} -> `
    const span = `lines ${r.start}-${Math.min(r.end, allLines.length)} of ${allLines.length}`
    blocks.push(`# ${tag}${r.label}  ${span} (~${Math.ceil(body.length / 4)} tok)\n${body}`)
  })
  // The trailing half of the healStaleIndex/staleWarning pair every other single-file surgical-read command runs (runRead's symbol path, read_section, read_outline, cli_file_ops). healStaleIndex fails safe on a reparse it cannot complete: the stale rows stay, and this second look is what tells the reader the regions below were resolved against them.
  return { text: guardText(staleWarning(resolved, 'read') + blocks.join('\n\n'), 'lines'), code: 0 }
}

export function findParentName(entry: SymbolEntry, fileSymbols: SymbolEntry[]): string | null {
  let best: SymbolEntry | null = null
  for (const s of fileSymbols) {
    const sameSpan = s.lineStart === entry.lineStart && s.lineEnd === entry.lineEnd
    if (sameSpan) continue
    if (s.lineStart <= entry.lineStart && s.lineEnd >= entry.lineEnd) {
      if (best === null || s.lineStart > best.lineStart) best = s
    }
  }
  if (best !== null) return best.name
  const parent = (entry.parent ?? '').trim()
  if (parent !== '') return parent
  const doc = entry.docstring.trim()
  if (doc !== '' && PARENT_IDENTIFIER_RE.test(doc)) return doc
  return null
}

/** The spelling that picks each candidate out of an ambiguous `symbol`: `Parent.symbol` when the parent tells them apart, with `@line` added when it does not (or when there is no parent and the file holds several). Every returned qualifier resolves to exactly its own definition. */
export function ambiguityPicks(symbol: string, candidates: SymbolEntry[]): { candidate: SymbolEntry; qualifier: string }[] {
  const fileSymCache = new Map<string, SymbolEntry[]>()
  const getFileSyms = (filePath: string): SymbolEntry[] => {
    let fileSyms = fileSymCache.get(filePath)
    if (fileSyms === undefined) {
      fileSyms = querySymbols({ filePath, limit: FIND_SCAN_LIMIT })
      fileSymCache.set(filePath, fileSyms)
    }
    return fileSyms
  }
  const parents = candidates.map((c) => findParentName(c, getFileSyms(c.filePath)))
  const plainQualifiers = candidates.map((c, i) => (parents[i] !== null ? `${parents[i]}.${symbol}` : symbol))
  const qualifierCounts = new Map<string, number>()
  const fileGroupSize = new Map<string, number>()
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const key = `${c.filePath} ${plainQualifiers[i]}`
    qualifierCounts.set(key, (qualifierCounts.get(key) ?? 0) + 1)
    fileGroupSize.set(c.filePath, (fileGroupSize.get(c.filePath) ?? 0) + 1)
  }
  const picks: { candidate: SymbolEntry; qualifier: string }[] = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const parent = parents[i]!
    const plainQualifier = plainQualifiers[i]!
    const collides =
      (qualifierCounts.get(`${c.filePath} ${plainQualifier}`) ?? 0) > 1 ||
      (parent === null && (fileGroupSize.get(c.filePath) ?? 0) > 1)
    picks.push({ candidate: c, qualifier: collides ? `${plainQualifier}@${c.lineStart}` : plainQualifier })
  }
  return picks
}

export function formatAmbiguity(symbol: string, file: string, candidates: SymbolEntry[], explicitRoot?: string, commandName = 'read'): string {
  const multiFile = new Set(candidates.map((c) => c.filePath)).size > 1
  const displayRoot = getDisplayRoot(explicitRoot)
  const lines = [
    `Ambiguous symbol ${echoedValue(symbol)} in ${echoedValue(file)}: ${countNoun(candidates.length, 'definition')} match. ` +
      `Retry with one of the qualified commands below to pick one:`,
  ]
  for (const { candidate: c, qualifier } of ambiguityPicks(symbol, candidates)) {
    const retryFile = multiFile ? toDisplayPath(displayRoot, c.filePath) : file
    const label = multiFile ? `${toDisplayPath(displayRoot, c.filePath)}::${qualifier}` : qualifier
    lines.push(`  - ${displaySafeText(label)} (line ${c.lineStart})  ->  token-goat ${commandName} ${quotedArg(displaySafeText(`${retryFile}::${qualifier}`))}`)
  }
  return lines.join('\n')
}

export function confinedProjectRoot(explicitRoot?: string): string | null {
  if (loadConfig().indexing.cross_project_symbols) return null
  return resolveProjectRoot(explicitRoot !== undefined && explicitRoot.trim().length > 0 ? { project: explicitRoot } : {})
}

function isProjectRootAllowed(candidateRoot: string, baseConfinedRoot: string): boolean {
  if (isInsideRoot(candidateRoot, baseConfinedRoot)) return true
  const allowedRoots = loadConfig().mcp.allowed_roots
  if (allowedRoots.length > 0 && allowedRoots.some((allowed) => isInsideRoot(candidateRoot, path.resolve(allowed)))) {
    return true
  }
  return false
}

/** The root a name-searched lookup (`symbol`, `refs`) is confined to, and the refusal for an explicit `--project` it may not widen to. `root` is null when `indexing.cross_project_symbols` leaves lookups unconfined. An explicit root moves the confinement only when it sits inside the one the command runs from or inside `mcp.allowed_roots`; any other is refused rather than silently ignored. */
export function resolveProjectConfinement(projectRoot: string | undefined): { root: string | null; denial: string | null } {
  const base = confinedProjectRoot()
  if (base === null || projectRoot === undefined) return { root: base, denial: null }
  const root = isProjectRootAllowed(projectRoot, base) ? (confinedProjectRoot(projectRoot) ?? base) : base
  return { root, denial: root !== base ? null : confinementRefusal('--project', projectRoot, base) }
}

export function confinementRefusal(label: string, resolved: string, root: string | null): string | null {
  if (root === null || isInsideRoot(resolved, root)) return null
  return `${label} is outside this project root, and indexing.cross_project_symbols = false confines symbol lookups to it: ${toDisplayPath(root, resolved)}`
}

/** The refusal for a file that `indexing.cross_project_symbols = false` puts out of reach, or null. The confining root is the one {@link resolveProjectConfinement} settles on, so a caller-named `projectRoot` (every MCP call carries one) moves it only as far as it moves `symbol` and `refs`; confining to whatever root the caller named let an MCP `read` serve another project's index rows. */
export function fileConfinementRefusal(label: string, file: string, projectRoot: string | undefined): string | null {
  const { root, denial } = resolveProjectConfinement(projectRoot)
  if (denial !== null) return denial
  return confinementRefusal(label, resolveSpecPath(file, projectRoot ?? process.cwd()), root)
}

/** The project root a `file::symbol` graph command (`callers`, `impact`, `call-chain`, `brief`) scopes its queries to, and the refusal when `indexing.cross_project_symbols = false` keeps the spec's file out of reach, the same confinement `refs` applies. `cwdRoot` is the project the command runs from, which a relative file is resolved against. A file inside it keeps it; a file outside it scopes to the project that owns the file, so a spec naming a sibling project's file looks up that project's rows rather than coming back empty. A spec with no file (a bare name) keeps `cwdRoot`. */
export function specScopeRoot(spec: string, cwdRoot: string): { root: string; denial: string | null } {
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || file === '') return { root: cwdRoot, denial: null }
  const abs = resolveSpecPath(file, cwdRoot)
  const { root: confined, denial } = resolveProjectConfinement(undefined)
  if (denial !== null) return { root: cwdRoot, denial }
  if (confined !== null) return { root: confined, denial: confinementRefusal('This file', abs, confined) }
  if (isInsideRoot(abs, cwdRoot)) return { root: cwdRoot, denial: null }
  // A file in a directory with no project marker belongs to no project, so the cwd project stays the scope and the file keeps its absolute spelling
  const dir = path.dirname(abs)
  const owner = resolveProjectRoot({ project: dir })
  return { root: findProject(dir) === null && normalizePath(owner) === normalizePath(dir) ? cwdRoot : owner, denial: null }
}

/** `#id` is the CSS-selector spelling an agent reaches for; accept it as a spelling of the html_id symbol name in read/section/symbol alike, for html files only. Likewise Dart's own `operator +` spelling (bare or after a `Point.` qualifier) names the member indexed as `+`. */
export function stripHtmlIdSpelling(name: string, filePath: string): string {
  const language = detectLanguage(filePath)
  if (language === 'dart') return name.replace(/(^|\.)operator\s+/, '$1')
  return name.startsWith('#') && language === 'html' ? name.slice(1) : name
}

const CONTAINER_KINDS = new Set(['class', 'struct', 'interface', 'type', 'namespace', 'module', 'trait', 'enum', 'impl', 'object', 'package', 'exception', 'module_type', 'package_body'])

// Whether the last qualifier.length names of an ancestor chain are exactly the (lowercased) qualifier
function endsWithChain(chain: string[], qualifier: string[]): boolean {
  if (qualifier.length === 0 || chain.length < qualifier.length) return false
  const offset = chain.length - qualifier.length
  return qualifier.every((q, i) => chain[offset + i]!.toLowerCase() === q)
}

// The outermost-first names enclosing an entry: the rows whose span holds it, or the recorded parent or parent-in-docstring for languages whose methods sit outside their type
function chainsOf(entry: SymbolEntry, fileSymbols: SymbolEntry[]): string[][] {
  const enclosing = fileSymbols.filter((s) => {
    if (s === entry || s.filePath !== entry.filePath) return false
    if (s.lineStart === entry.lineStart && s.lineEnd === entry.lineEnd) {
      return s.kind !== entry.kind && CONTAINER_KINDS.has(s.kind) && !CONTAINER_KINDS.has(entry.kind)
    }
    return s.lineStart <= entry.lineStart && s.lineEnd >= entry.lineEnd
  })
  enclosing.sort((x, y) => x.lineStart - y.lineStart || y.lineEnd - x.lineEnd)
  // A TOML table header is one symbol named with its dotted path (`tool.ruff`), so its parts count as separate chain links, the way the qualifier's `.`-split spells them
  const chains: string[][] = [enclosing.flatMap((s) => s.name.split('.'))]
  const parent = (entry.parent ?? '').trim()
  if (parent !== '') chains.push(parent.split('.'))
  else if (entry.docstring !== '' && PARENT_IDENTIFIER_RE.test(entry.docstring)) chains.push([entry.docstring])
  return chains
}

/** The `Class.method` spellings the rows named `name` in `resolved` answer to, for a miss on a wrong qualifier to suggest. */
export function qualifiedSpellings(resolved: string, name: string): string[] {
  const rows = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT })
  const spellings: string[] = []
  for (const row of rows) {
    if (row.name !== name) continue
    const chain = chainsOf(row, rows).find((c) => c.length > 0)
    if (chain !== undefined) spellings.push([...chain, name].join('.'))
  }
  return [...new Set(spellings)]
}

/** The indexed rows a `file::symbol` spec's symbol part names in `resolved`, narrowed to one container when the symbol is a qualified `Class.method`, with the name a miss or ambiguity should print. Shared by `read` and the note anchors, so a name means the same symbol to both. `file` is the spelling the caller typed, used only to find the file's rows when `resolved` has none. */
export function findSymbolCandidates(
  file: string,
  resolved: string,
  symbol: string,
  projectRoot?: string,
  dbPath?: string,
): { candidates: SymbolEntry[]; displaySymbol: string } {
  // Without a database the lookups take querySymbols' own default, exactly as `read` always called it.
  const query = (opts: Parameters<typeof querySymbols>[0]): SymbolEntry[] => (dbPath === undefined ? querySymbols(opts) : querySymbols(opts, dbPath))
  if (symbol.includes('.')) {
    const exactMatch = query({ name: symbol, filePath: resolved, limit: 10 })
    if (exactMatch.length > 0) return { candidates: exactMatch, displaySymbol: symbol }
  }

  const dotParts = symbol.split('.')
  const [symBase, methodName] =
    dotParts.length > 1
      ? [dotParts[0] ?? symbol, dotParts[dotParts.length - 1]]
      : [symbol, undefined]

  const lookupName = methodName ?? symBase
  let candidates = query({ name: lookupName, filePath: resolved, limit: 10 })
  if (candidates.length === 0) {
    const foldedFile = foldPath(file)
    const baseName = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
    candidates = query({
      name: lookupName,
      limit: 50,
      ...(baseName !== '' ? { fileBaseName: baseName } : {}),
      ...(projectRoot !== undefined ? { rootDir: projectRoot } : {}),
    }).filter((s) => {
      const foldedFilePath = foldPath(s.filePath)
      return (
        foldedFilePath === foldedFile ||
        endsWithPathBoundary(foldedFilePath, foldedFile) ||
        endsWithPathBoundary(foldedFile, foldedFilePath)
      )
    })
  }

  // A qualifier always narrows, even for a single candidate, and a qualifier that names no enclosing chain is a miss rather than a fallback to the unscoped rows
  if (methodName !== undefined) {
    const qualifier = dotParts.slice(0, -1).map((p) => p.toLowerCase())
    const fileRows = new Map<string, SymbolEntry[]>()
    const rowsOf = (filePath: string): SymbolEntry[] => {
      let rows = fileRows.get(filePath)
      if (rows === undefined) {
        rows = query({ filePath, limit: FIND_SCAN_LIMIT })
        fileRows.set(filePath, rows)
      }
      return rows
    }
    candidates = candidates.filter((c) => chainsOf(c, rowsOf(c.filePath)).some((chain) => endsWithChain(chain, qualifier)))
  }

  return { candidates, displaySymbol: lookupName }
}

export function resolveSymbolSpec(spec: string, forceRefresh?: boolean, projectRoot?: string): SymbolResolution {
  const { file, symbol: rawSymbol } = parseReadSpec(spec)
  if (rawSymbol === undefined || rawSymbol === '') return { kind: 'none' }

  const anchorMatch = /^(.+)@(\d+)$/.exec(rawSymbol)
  const anchorSymbol = anchorMatch !== null ? anchorMatch[1]! : rawSymbol
  const lineAnchor = anchorMatch !== null ? parseInt(anchorMatch[2]!, 10) : undefined

  const resolved = resolveSpecPath(file, projectRoot ?? process.cwd())
  const symbol = stripHtmlIdSpelling(anchorSymbol, resolved)
  const confined = fileConfinementRefusal('This file', file, projectRoot)
  if (confined !== null) return { kind: 'confined', message: confined }
  if (forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
  } else {
    healStaleIndex(resolved)
  }

  const finalize = (cands: SymbolEntry[], displaySymbol: string): SymbolResolution => {
    const seen = new Set<string>()
    const distinct: SymbolEntry[] = []
    for (const c of cands) {
      const key = `${c.filePath}|${c.lineStart}|${c.lineEnd}`
      if (seen.has(key)) continue
      seen.add(key)
      distinct.push(c)
    }
    const anchored = lineAnchor === undefined ? distinct : distinct.filter((c) => c.lineStart === lineAnchor)
    if (anchored.length === 0) return { kind: 'none' }
    if (anchored.length === 1) return { kind: 'ok', entry: anchored[0]! }
    return { kind: 'ambiguous', symbol: displaySymbol, file, candidates: anchored }
  }

  const { candidates, displaySymbol } = findSymbolCandidates(file, resolved, symbol, projectRoot)
  return finalize(candidates, displaySymbol)
}

/** How a qualified `file::Parent.method` spec resolved, or undefined when the spec is not qualified. */
export function resolveQualifiedSpec(spec: string, projectRoot: string | undefined): SymbolResolution | undefined {
  const { symbol } = parseReadSpec(spec)
  if (symbol === undefined || !symbol.includes('.')) return undefined
  return resolveSymbolSpec(spec, undefined, projectRoot)
}

/** The one definition a qualified `file::Parent.method` spec names, or undefined when the spec is not qualified or does not resolve to exactly one symbol. */
export function resolveQualifiedSpecDef(spec: string, projectRoot: string | undefined): SymbolEntry | undefined {
  const resolution = resolveQualifiedSpec(spec, projectRoot)
  return resolution?.kind === 'ok' ? resolution.entry : undefined
}

export function resolveSymbolSpecOrEmitError(
  commandName: string,
  spec: string,
  projectRoot: string | undefined,
): SymbolEntry | null {
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') {
    emitErr(formatCommandError(`${fencedCommand('token-goat ' + commandName)} requires a 'file::symbol' spec (got ${echoedValue(spec)})`))
    return null
  }

  const resolution = resolveSymbolSpec(spec, undefined, projectRoot)

  if (resolution.kind === 'confined') {
    emitErr(formatCommandError(resolution.message))
    return null
  }

  if (resolution.kind === 'ambiguous') {
    const ambiguity = formatAmbiguity(resolution.symbol, resolution.file, resolution.candidates, projectRoot, commandName)
    emitErr(formatCommandError(new CliError(ambiguity.split('\n'))))
    return null
  }

  if (resolution.kind === 'none') {
    const messages = [`Symbol ${echoedValue(symbol)} not found in ${echoedValue(file)}`]
    const crossFileLead = formatCrossFileLead(commandName, symbol, file, projectRoot)
    if (crossFileLead !== '') messages.push(crossFileLead)
    const resolved = resolveSpecPath(file, projectRoot ?? process.cwd())
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const methodPart = symbol.slice(symbol.lastIndexOf('.') + 1)
    const qualified = symbol.includes('.') ? qualifiedSpellings(resolved, methodPart) : []
    const closes = qualified.length > 0 ? qualified : rankSimilarNames(scanned, symbol)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (scanned.length > 0) messages.push(`Try: token-goat outline ${quotedArg(file)}`)
    emitErr(formatCommandError(new CliError(messages)))
    return null
  }

  return resolution.entry
}
