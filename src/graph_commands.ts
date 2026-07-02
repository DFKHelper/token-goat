/**
 * CLI command handlers for code-graph commands.
 *
 * Implements callers, call-chain, impact, dead, deps, types, and scope.
 * All commands query the global symbol index (one global.db keyed by absolute path).
 * Pure exported helpers (enclosingSymbol, bfsCallChains, looksLikeTypeClass,
 * isDeadSymbol) are kept side-effect-free so they can be unit-tested without a DB.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { execFileSync, spawnSync } from 'node:child_process'

import { querySymbols, queryRefs, searchSymbolsFts } from './index_reader.js'
import { resolveIndexPath } from './paths.js'
import { extractImports } from './read_commands.js'
import { getTrackedFiles } from './repomap.js'
import { estimateTokens } from './overflow_guard.js'
import { ensureNewline } from './util.js'
import type { SymbolEntry } from './parser_types.js'

// ---- helpers ----------------------------------------------------------------

function emit(text: string): void {
  process.stdout.write(ensureNewline(text))
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
    if (callers.length === 0 || chain.length > maxDepth) {
      complete.push(chain)
      continue
    }
    let expanded = false
    for (const caller of callers) {
      if (globalVisited.has(caller)) {
        complete.push([...chain, `(cycle:${caller})`])
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
  'main', 'default', 'index', '__init__', '__main__', 'setup', 'run', 'handler',
])

/** Return true when a symbol with the given name and reference count is dead. The refs table does NOT include a symbol's own definition line (verified: queryRefs({name:'querySymbols'}) returns no ref at the definition line 84 of index_reader.ts, and likewise for runRead at line 128 of read_commands.ts), so refCount === 0 is the correct test for a truly unreferenced symbol. Entry-point names are always excluded. */
export function isDeadSymbol(name: string, refCount: number): boolean {
  if (ENTRY_NAMES.has(name)) return false
  return refCount === 0
}

// ---- file cache helper used by multiple commands ----------------------------

function buildFileSymCache(): (fp: string) => SymbolEntry[] {
  const cache = new Map<string, SymbolEntry[]>()
  return (fp: string): SymbolEntry[] => {
    let syms = cache.get(fp)
    if (syms === undefined) {
      syms = querySymbols({ filePath: fp, limit: 10000 }, undefined)
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
}

interface CallerEntry {
  caller: string
  kind: string
  file: string
  line: number
}

export function runCallers(opts: CallersOptions): number {
  const refs = queryRefs({ name: opts.symbol, limit: opts.limit ?? 500 })
  if (refs.length === 0) {
    emitErr(`No references found for '${opts.symbol}'`)
    return 1
  }

  const getSyms = buildFileSymCache()

  const entries: CallerEntry[] = refs.map((ref) => {
    const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
    return {
      caller: enc?.name ?? '(module scope)',
      kind: enc?.kind ?? '',
      file: ref.filePath,
      line: ref.line,
    }
  })

  if (opts.json === true) {
    emit(JSON.stringify(entries, null, 2))
    return 0
  }

  for (const e of entries) {
    emit(`${e.caller}\t${e.file}:${e.line}`)
  }
  return 0
}

// ---- call-chain -------------------------------------------------------------

export interface CallChainOptions {
  symbol: string
  depth?: number
  json?: boolean
}

export function runCallChain(opts: CallChainOptions): number {
  const maxDepth = opts.depth ?? 8

  const callersOf: CallersOfFn = (name: string): string[] => {
    const refs = queryRefs({ name, limit: 500 })
    if (refs.length === 0) return []
    const getSyms = buildFileSymCache()
    const names = new Set<string>()
    for (const ref of refs) {
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc !== null) names.add(enc.name)
    }
    return [...names]
  }

  const chains = bfsCallChains(opts.symbol, callersOf, maxDepth)

  if (opts.json === true) {
    emit(JSON.stringify({ chains }, null, 2))
    return 0
  }

  if (chains.length === 0) {
    emit(`${opts.symbol}  (no callers)`)
    return 0
  }

  for (const chain of chains) {
    emit(chain.join(' -> '))
  }
  return 0
}

// ---- impact -----------------------------------------------------------------

export interface ImpactOptions {
  symbol: string
  top?: number
  json?: boolean
}

export function runImpact(opts: ImpactOptions): number {
  const top = opts.top ?? 20
  const DEPTH_CAP = 8

  const hops = new Map<string, number>([[opts.symbol, 0]])
  const queue: Array<[string, number]> = [[opts.symbol, 0]]

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    const [name, depth] = item
    if (depth >= DEPTH_CAP) continue
    const refs = queryRefs({ name, limit: 500 })
    const getSyms = buildFileSymCache()
    for (const ref of refs) {
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc === null) continue
      const callerName = enc.name
      const newHop = depth + 1
      const existing = hops.get(callerName)
      if (existing === undefined || existing > newHop) {
        hops.set(callerName, newHop)
        queue.push([callerName, newHop])
      }
    }
  }

  hops.delete(opts.symbol)

  const sorted = [...hops.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, top)

  if (sorted.length === 0) {
    emitErr(`No callers found for '${opts.symbol}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(sorted.map(([symbol, h]) => ({ symbol, hops: h })), null, 2))
    return 0
  }

  for (const [symbol, h] of sorted) {
    emit(`${symbol}\t(hops: ${h})`)
  }
  return 0
}

// ---- dead -------------------------------------------------------------------

export interface DeadOptions {
  kind?: string
  includePrivate?: boolean
  top?: number
  json?: boolean
}

export function runDead(opts: DeadOptions): number {
  const kind = opts.kind ?? 'function'
  const syms = querySymbols({ kind, limit: 5000 })

  const results: Array<{ name: string; kind: string; file: string; line: number }> = []

  for (const sym of syms) {
    if (opts.includePrivate !== true && sym.name.startsWith('_')) continue
    const refs = queryRefs({ name: sym.name, limit: 1 })
    if (isDeadSymbol(sym.name, refs.length)) {
      results.push({ name: sym.name, kind: sym.kind, file: sym.filePath, line: sym.lineStart })
    }
  }

  const sliced = results.slice(0, opts.top ?? results.length)

  if (opts.json === true) {
    emit(JSON.stringify(sliced, null, 2))
    return 0
  }

  if (sliced.length === 0) {
    emit('No dead symbols found.')
    return 0
  }

  for (const r of sliced) {
    emit(`${r.name}\t${r.file}:${r.line}`)
  }
  return 0
}

// ---- deps -------------------------------------------------------------------

export interface DepsOptions {
  file: string
  json?: boolean
}

const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp', '.hpp',
]

export function runDeps(opts: DepsOptions): number {
  let text: string
  try {
    text = fs.readFileSync(opts.file, 'utf-8')
  } catch {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const ext = path.extname(opts.file)
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
        for (const srcExt of SOURCE_EXTENSIONS) {
          const candidate = base + srcExt
          if (fs.existsSync(candidate)) {
            resolved = candidate
            break
          }
        }
      }
      internal.push(resolved)
    } else {
      external.push(imp)
    }
  }

  if (opts.json === true) {
    emit(JSON.stringify({ file: opts.file, internal, external }, null, 2))
    return 0
  }

  if (internal.length > 0) {
    emit('internal:')
    for (const i of internal) emit(`  ${i}`)
  }
  if (external.length > 0) {
    emit('external:')
    for (const e of external) emit(`  ${e}`)
  }
  if (internal.length === 0 && external.length === 0) {
    emit('(no imports found)')
  }
  return 0
}

// ---- types ------------------------------------------------------------------

const TYPE_KINDS: ReadonlyArray<string> = ['type', 'interface', 'enum', 'struct', 'trait']

export interface TypesOptions {
  file?: string
  json?: boolean
  limit?: number
}

export function runTypes(opts: TypesOptions): number {
  const limit = opts.limit ?? 500
  const filePath = opts.file !== undefined ? resolveIndexPath(opts.file) : undefined
  const fpOpt = filePath !== undefined ? { filePath } : {}

  const results: SymbolEntry[] = []

  for (const k of TYPE_KINDS) {
    const syms = querySymbols({ kind: k, ...fpOpt, limit })
    results.push(...syms)
  }

  const classes = querySymbols({ kind: 'class', ...fpOpt, limit })
  for (const cls of classes) {
    if (looksLikeTypeClass(cls.body)) results.push(cls)
  }

  results.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart,
  )

  if (opts.json === true) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }

  if (results.length === 0) {
    const ctx = opts.file !== undefined ? ` in '${opts.file}'` : ''
    emitErr(`No type declarations found${ctx}`)
    return 1
  }

  for (const r of results) {
    emit(`${r.name}\t${r.kind}\t${r.filePath}:${r.lineStart}`)
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
  const line = Number.parseInt(lineStr, 10)

  if (!Number.isFinite(line) || line < 1) {
    emitErr(`Invalid line number: ${lineStr}`)
    return 1
  }

  const filePath = resolveIndexPath(file)
  const syms = querySymbols({ filePath, limit: 10000 })

  const enclosing = syms
    .filter((s) => s.lineStart <= line && line <= s.lineEnd)
    .sort((a, b) => b.lineStart - a.lineStart)

  if (opts.json === true) {
    emit(JSON.stringify(enclosing, null, 2))
    return 0
  }

  if (enclosing.length === 0) {
    emitErr(`No symbols enclosing line ${line} in '${file}'`)
    return 1
  }

  for (const s of enclosing) {
    emit(`${s.name}\t${s.kind}\t${s.filePath}:${s.lineStart}-${s.lineEnd}`)
  }
  return 0
}

// ---- isTestFile (exported pure helper) --------------------------------------

/** Return true when a path looks like a test file (tests/ dir or .test./.spec./_test. suffix). */
export function isTestFile(p: string): boolean {
  return /(^|[/\\])(tests?)[/\\]/i.test(p) || /\.(test|spec)\.|_test\.|(^|[/\\])test_/i.test(p)
}

// ---- findCycles (exported pure helper) --------------------------------------

/** Find all cycles in a directed graph using DFS. Returns each cycle as a string[] of node names. Each cycle path starts and ends at the same node. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const stack = new Set<string>()

  function dfs(node: string, pathSoFar: string[]): void {
    if (stack.has(node)) {
      const idx = pathSoFar.indexOf(node)
      if (idx !== -1) cycles.push([...pathSoFar.slice(idx), node])
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    stack.add(node)
    const neighbours = graph.get(node) ?? []
    for (const nb of neighbours) dfs(nb, [...pathSoFar, node])
    stack.delete(node)
  }

  for (const node of graph.keys()) dfs(node, [])
  return cycles
}

// ---- similar ----------------------------------------------------------------

export interface SimilarOptions {
  spec: string
  top?: number
  json?: boolean
}

export function runSimilar(opts: SimilarOptions): number {
  const sepIdx = opts.spec.lastIndexOf('::')
  if (sepIdx < 0) {
    emitErr(`Invalid spec - expected "file::symbol", got: ${opts.spec}`)
    return 1
  }
  const fileArg = opts.spec.slice(0, sepIdx)
  const symbolArg = opts.spec.slice(sepIdx + 2)
  const top = opts.top ?? 10

  const filePath = resolveIndexPath(fileArg)
  const anchors = querySymbols({ name: symbolArg, filePath })
  if (anchors.length === 0) {
    emitErr(`Symbol '${symbolArg}' not found in '${fileArg}'`)
    return 1
  }
  const anchor = anchors[0]!

  const words = [anchor.name, ...(anchor.docstring ?? '').split(/\s+/).filter((w) => w.length > 4)]
  const query = words.slice(0, 8).join(' ')

  const hits = searchSymbolsFts(query, top + 1)
  const results = hits.filter((h) => !(h.filePath === anchor.filePath && h.name === anchor.name)).slice(0, top)

  if (opts.json === true) {
    emit(JSON.stringify(results.map((h) => ({ name: h.name, kind: h.kind, file: h.filePath, line: h.lineStart })), null, 2))
    return 0
  }
  for (const h of results) emit(`${h.name}\t${h.kind}\t${h.filePath}:${h.lineStart}`)
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
  const top = opts.top ?? 12
  const budget = opts.budget

  const hits = searchSymbolsFts(opts.task, top)

  interface ContextEntry { file: string; symbol: string; kind: string; readCmd: string }
  const entries: ContextEntry[] = []
  let tokensSoFar = 0

  for (const h of hits) {
    const bodyTokens = estimateTokens(h.body ?? '')
    if (budget !== undefined && tokensSoFar + bodyTokens > budget) break
    tokensSoFar += bodyTokens
    entries.push({ file: h.filePath, symbol: h.name, kind: h.kind, readCmd: `token-goat read "${h.filePath}::${h.name}"` })
  }

  if (opts.json === true) {
    emit(JSON.stringify(entries, null, 2))
    return 0
  }
  for (const e of entries) emit(e.readCmd)
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
  const symbols = querySymbols({ filePath, limit: 10000 })

  const testFileMap = new Map<string, Set<string>>()

  for (const sym of symbols) {
    const refs = queryRefs({ name: sym.name, limit: 500 })
    for (const ref of refs) {
      if (!isTestFile(ref.filePath)) continue
      if (!testFileMap.has(ref.filePath)) testFileMap.set(ref.filePath, new Set())
    }
  }

  const results: TestForEntry[] = []

  for (const [tf] of testFileMap) {
    const testSyms = querySymbols({ filePath: tf, limit: 10000 })
    const testFns = testSyms.filter((s) => /^(test|Test|spec|describe|it)/.test(s.name)).map((s) => s.name)
    results.push({ testFile: tf, testFunctions: testFns })
  }

  if (opts.json === true) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }
  if (results.length === 0) {
    emit(`No test files found referencing symbols in '${opts.file}'`)
    return 0
  }
  for (const r of results) {
    emit(r.testFile)
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
  const top = opts.top ?? 50
  const allFns = querySymbols({ kind: 'function', limit: 2000 })
  const allMethods = querySymbols({ kind: 'method', limit: 2000 })
  const candidates = [...allFns, ...allMethods]

  const gaps: Array<{ name: string; kind: string; file: string; line: number }> = []

  for (const sym of candidates) {
    if (!opts.includePrivate && sym.name.startsWith('_')) continue
    if (ENTRY_NAMES.has(sym.name)) continue
    const refs = queryRefs({ name: sym.name, limit: 500 })
    const hasTestRef = refs.some((r) => isTestFile(r.filePath))
    if (!hasTestRef) gaps.push({ name: sym.name, kind: sym.kind, file: sym.filePath, line: sym.lineStart })
  }

  const sliced = gaps.slice(0, top)

  if (opts.json === true) {
    emit(JSON.stringify(sliced, null, 2))
    return 0
  }
  if (sliced.length === 0) {
    emit('No coverage gaps found.')
    return 0
  }
  for (const g of sliced) emit(`${g.name}\t${g.kind}\t${g.file}:${g.line}`)
  return 0
}

// ---- arch -------------------------------------------------------------------

export interface ArchOptions {
  top?: number
  json?: boolean
  cwd?: string
}

export function runArch(opts: ArchOptions): number {
  const cwd = opts.cwd ?? process.cwd()
  const top = opts.top ?? 10
  const files = getTrackedFiles(cwd)

  const graph = new Map<string, string[]>()
  const importedBy = new Map<string, Set<string>>()

  const resolveRelImport = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const dir = path.dirname(fromFile)
    // Strip .js/.mjs/.cjs output extensions so we can also probe .ts/.tsx source variants
    const strippedSpec = spec.replace(/\.(m?js|cjs)$/, '')
    const base = path.resolve(dir, strippedSpec)
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.py']) {
      const candidate = base + ext
      if (files.includes(candidate)) return candidate
    }
    const idx = path.join(base, 'index')
    for (const ext of ['.ts', '.js', '.tsx', '.jsx']) {
      const candidate = idx + ext
      if (files.includes(candidate)) return candidate
    }
    return null
  }

  for (const file of files) {
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const ext = path.extname(file)
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

  const hubs = [...importedBy.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, top).map(([f, importers]) => ({ file: f, importedBy: importers.size }))

  const entryPoints = files.filter((f) => !importedBy.has(f) && (graph.get(f) ?? []).length > 0).slice(0, top).map((f) => ({ file: f }))

  const cycles = findCycles(graph)

  if (opts.json === true) {
    emit(JSON.stringify({ hubs, entryPoints, cycles }, null, 2))
    return 0
  }

  emit(`hubs (top ${top} most-imported):`)
  for (const h of hubs) emit(`  ${h.importedBy} importers\t${h.file}`)
  emit(`entry points (imported by nobody, top ${top}):`)
  for (const e of entryPoints) emit(`  ${e.file}`)
  emit(`cycles (${cycles.length} found):`)
  for (const c of cycles) emit(`  ${c.join(' -> ')}`)
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
  const fileArg = opts.spec.slice(0, sepIdx)
  const symbolArg = opts.spec.slice(sepIdx + 2)
  const cwd = opts.cwd ?? process.cwd()

  const filePath = resolveIndexPath(fileArg)
  const syms = querySymbols({ name: symbolArg, filePath })
  if (syms.length === 0) {
    emitErr(`Symbol '${symbolArg}' not found in '${fileArg}'`)
    return 1
  }
  const sym = syms[0]!
  const start = sym.lineStart
  const end = sym.lineEnd

  let raw: string
  try {
    raw = execFileSync('git', ['blame', '-L', `${start},${end}`, '--', filePath], { cwd, encoding: 'utf8' })
  } catch (e) {
    emitErr(`git blame failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  if (opts.json === true) {
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => {
      const m = /^([0-9a-f]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}[^)]*)\s+(\d+)\)(.*)/.exec(l)
      if (!m) return { raw: l }
      return { commit: m[1], author: (m[2] ?? '').trim(), date: (m[3] ?? '').trim(), line: Number.parseInt(m[4] ?? '0', 10), content: m[5] }
    })
    emit(JSON.stringify({ symbol: symbolArg, file: filePath, lines }, null, 2))
    return 0
  }

  emit(`${symbolArg}\t${filePath}:${start}-${end}`)
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
  const top = opts.top ?? 8
  const hits = searchSymbolsFts(opts.question, top)

  const BACKEND_ENV = 'TOKEN_GOAT_ASK_BACKEND'
  const backendLabel = process.env[BACKEND_ENV] ?? ''

  interface AskEntry { file: string; symbol: string; kind: string; readCmd: string }
  const entries: AskEntry[] = hits.map((h) => ({ file: h.filePath, symbol: h.name, kind: h.kind, readCmd: `token-goat read "${h.filePath}::${h.name}"` }))

  const degrade = (): number => {
    if (opts.json === true) {
      emit(JSON.stringify({ degraded: true, note: `Set ${BACKEND_ENV}=claude|codex for LLM synthesis`, context: entries }, null, 2))
      return 0
    }
    emit(`[degraded mode - set ${BACKEND_ENV}=claude|codex for LLM synthesis]`)
    for (const e of entries) emit(e.readCmd)
    return 0
  }

  if (!backendLabel) return degrade()

  const isWin = process.platform === 'win32'
  let backendPath: string | null = null
  try {
    const whichOut = execFileSync(isWin ? 'where.exe' : 'which', [backendLabel], { encoding: 'utf8' })
    const found = (whichOut ?? '').trim().split('\n')[0]?.trim() ?? ''
    if (found) backendPath = found
  } catch { /* fall through */ }

  if (!backendPath) return degrade()

  const context = hits.map((h, i) => `[${i + 1}] ${h.filePath}\n${h.body ?? ''}`).join('\n\n')
  const prompt = `Answer the QUESTION using only the CODE SNIPPETS below.\nQUESTION: ${opts.question}\n\nSNIPPETS:\n${context}\n\nANSWER:`

  try {
    // A resolved backend on Windows is frequently an npm .cmd/.bat wrapper (there is no separate
    // .exe for a Node-based CLI) -- spawnSync cannot exec .cmd/.bat directly without shell:true
    // and throws EINVAL otherwise, which the catch below swallowed into a silent degrade.
    const askArgs = ['--print', '--bare', '--no-session-persistence']
    const needsShell = isWin && /\.(cmd|bat)$/i.test(backendPath)
    // shell:true plus a separate args array is a deprecated (DEP0190) combination on Windows;
    // fold the (static, non-user-controlled) args into a single quoted command string instead.
    const result = needsShell
      ? spawnSync([`"${backendPath}"`, ...askArgs].join(' '), { input: prompt, encoding: 'utf8', timeout: 30000, shell: true })
      : spawnSync(backendPath, askArgs, { input: prompt, encoding: 'utf8', timeout: 30000 })
    if (result.status === 0 && result.stdout?.trim()) {
      if (opts.json === true) {
        emit(JSON.stringify({ answer: result.stdout.trim(), context: entries }, null, 2))
      } else {
        emit(result.stdout.trim())
      }
      return 0
    }
  } catch { /* fall through to degraded */ }

  return degrade()
}
