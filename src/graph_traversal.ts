/**
 * Core graph traversal, scope analysis, and cycle detection primitives.
 *
 * Implements pure and DB-backed graph helpers: enclosingSymbol, looksLikeTypeClass,
 * bfsCallChains, isDeadSymbol, resolveCallers, ancestry dispatch resolution,
 * symbol kind classifications, and Tarjan SCC cycle detection.
 */

import { querySymbols, queryRefs, queryRefsByContext } from './index_reader.js'
import { resolveProjectRoot } from './project.js'
import { findSpecSeparator } from './read_commands.js'
import { foldPath } from './util.js'
import { resolveQualifiedSpec, type SymbolResolution } from './read_spec.js'
import { isTsPath, resolveTypedRefs, resolveTypedRefsBatch, type ResolveTypedRefsInput, type TypedRefsSession } from './ts_refs.js'
import { UNBOUNDED_QUERY_LIMIT } from './query_limits.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'

// ---- helpers ----------------------------------------------------------------

/** Reference-query cap shared by every {@link queryRefs} call in code graph traversal (existence checks,
 * caller resolution, dead-symbol detection) -- keeping this as one constant instead of a
 * hardcoded 500 at each site means a future cap change can't miss a site and silently
 * reintroduce the "existence check stops too early" bug this value was raised to fix. */
export const DEFAULT_REF_QUERY_LIMIT = 500

/** Symbol-query cap for "every symbol in one file" lookups. A single filePath already narrows the query to one file with no other predicate to combine against, so any finite cap here is a silent truncation waiting to happen rather than a real bound: a file indexed with more than 10000 symbols (e.g. a generated file with one const per data row) had its tail dropped, and every enclosingSymbol lookup on a line past the cut returned null instead of the real symbol, misreporting callers/impact rows as "(module scope)" and letting runTestFor/find --symbol report false negatives. Set to the same unbounded sentinel as UNBOUNDED_REF_LIMIT below (SQLite: LIMIT -1 is unlimited) rather than a bigger finite number, since there is no size at which "every symbol in one file" stops needing to mean literally every symbol. */
export const ALL_SYMBOLS_IN_FILE_LIMIT = UNBOUNDED_QUERY_LIMIT

/** SQLite: `LIMIT -1` (even as a bound parameter) means unbounded. */
export const UNBOUNDED_REF_LIMIT = UNBOUNDED_QUERY_LIMIT

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

/** Return the innermost class-or-function symbol containing `line`, or null. */
export function enclosingNamedScope(symbols: SymbolEntry[], line: number): SymbolEntry | null {
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
      complete.push([...chain, '(depth-limit)'])
      continue
    }
    let expanded = false
    for (const caller of callers) {
      if (chain.includes(caller)) {
        complete.push([...chain, `(cycle:${caller})`])
        expanded = true
        continue
      }
      if (globalVisited.has(caller)) {
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
export const ENTRY_NAMES: ReadonlySet<string> = new Set([
  'main', 'default', 'index', '__init__', '__main__', 'setup', 'run', 'handler', 'constructor',
])

// An operator (`operator+`, `operator int`), a destructor or finalizer (`~Foo`) and an indexer (`this[]`) run from syntax, a `+`, a cast, scope exit or `a[i]`, so no call site ever names them and a name-based ref count of zero says nothing about whether they are used.
const SYNTAX_INVOKED_NAME = /^(?:operator(?:\s|[^\w\s])|~|this\[)/

/** True for a member the language invokes through syntax rather than by name, which ref-based dead and coverage analysis cannot assess. */
export function isSyntaxInvokedName(name: string): boolean {
  return SYNTAX_INVOKED_NAME.test(name)
}

/** Return true when a symbol with the given name and reference count is dead. */
export function isDeadSymbol(name: string, refCount: number): boolean {
  if (ENTRY_NAMES.has(name) || isSyntaxInvokedName(name)) return false
  return refCount === 0
}

// ---- file cache helper used by multiple commands ----------------------------

/** Splits a `token-goat callers/call-chain/impact` positional argument into the bare symbol name to query plus, when a `::`-prefixed file was given, the raw file text. */
export function parseGraphSymbolSpec(spec: string): { name: string; file?: string } {
  const colonIdx = findSpecSeparator(spec)
  if (colonIdx === -1) return { name: spec }
  return { name: spec.slice(colonIdx + 2), file: spec.slice(0, colonIdx) }
}

/** Like parseGraphSymbolSpec, but a qualified `file::Parent.method` spec is resolved through the same candidate lookup `read` uses, so the name to query is the method's own name and `def` is the one definition it names. A spec that resolves to nothing, or to several, keeps the raw name so each command's own not-found/ambiguity message still fires. */
export function resolveGraphSpec(spec: string, rootDir: string): { name: string; file?: string; def?: SymbolEntry; ambiguous?: Extract<SymbolResolution, { kind: 'ambiguous' }> } {
  const parsed = parseGraphSymbolSpec(spec)
  if (parsed.file === undefined || !parsed.name.includes('.')) return parsed
  const resolution = resolveQualifiedSpec(spec, rootDir)
  if (resolution?.kind === 'ok') return { name: resolution.entry.name, file: parsed.file, def: resolution.entry }
  // An overloaded `Class.method` is a real symbol with several definitions; the commands print the same pick-one list `read` does rather than a not-found for a literal dotted name.
  if (resolution?.kind === 'ambiguous') return { ...parsed, ambiguous: resolution }
  return parsed
}

/** The references that bind to `def` according to the type checker (TypeScript only), or null when it cannot tell: no definition, a non-TypeScript file, the compiler unavailable, or a resolution failure. The one typed tier `refs --callers`, `callers`, `brief` and `impact` all share. */
export function typedRefsForDef(refs: RefEntry[], def: SymbolEntry | undefined): RefEntry[] | null {
  if (def === undefined || refs.length === 0 || !isTsPath(def.filePath)) return null
  try {
    return resolveTypedRefs(typedInput(refs, def))
  } catch {
    return null
  }
}

function typedInput(refs: RefEntry[], def: SymbolEntry): ResolveTypedRefsInput {
  return { defFile: def.filePath, defLineStart: def.lineStart, defLineEnd: def.lineEnd, symbolName: def.name, candidates: refs }
}

/** {@link typedRefsForDef} for many definitions, sharing one compiler program across them so a whole-project scan does not build one per symbol. Returns one entry per item, in order. */
export function typedRefsForDefs(items: ReadonlyArray<{ refs: RefEntry[]; def: SymbolEntry }>): Array<RefEntry[] | null> {
  try {
    return resolveTypedRefsBatch(items.map(({ refs, def }) => typedInput(refs, def)))
  } catch {
    return items.map(() => null)
  }
}

/** Narrows name-matched references to the ones that bind to `def` when the type checker can tell (TypeScript only); otherwise returns them unchanged, since the refs table is keyed by name alone. */
export function narrowRefsToDef(refs: RefEntry[], def: SymbolEntry | undefined): RefEntry[] {
  return typedRefsForDef(refs, def) ?? refs
}

export function buildFileSymCache(): (fp: string) => SymbolEntry[] {
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

export interface CallerEntry {
  caller: string
  kind: string
  file: string
  line: number
}

/** True when `fp` has its own symbol definition named `name`. */
export function fileDefinesName(fp: string, name: string, getSyms: (fp: string) => SymbolEntry[]): boolean {
  return getSyms(fp).some((s) => s.name === name)
}

/** Filter `refs` down to the ones plausibly attributable to the symbol defined at `filePath`. */
export function filterRefsForSymbol(
  refs: RefEntry[],
  name: string,
  filePath: string,
  getSyms: (fp: string) => SymbolEntry[],
): RefEntry[] {
  return refs.filter((ref) => foldPath(ref.filePath) === foldPath(filePath) || !fileDefinesName(ref.filePath, name, getSyms))
}

/** The references attributable to the symbol `name` defined at `filePath`, tiered like `refs --callers`: the type checker's binding when it can tell, and the same-name-in-another-file heuristic only as the fallback. The heuristic must not run first: it drops every reference in a file that defines its own same-named symbol, including a typed call that binds to this definition. Without a `def` (a plain `file::name` spec) the definition is the one symbol of that name in the file, when there is exactly one. */
export function scopeRefsToDefinition(
  refs: RefEntry[],
  name: string,
  filePath: string,
  getSyms: (fp: string) => SymbolEntry[],
  def?: SymbolEntry,
): RefEntry[] {
  const target = def ?? soleDefinitionIn(name, filePath)
  return typedRefsForDef(refs, target) ?? filterRefsForSymbol(refs, name, filePath, getSyms)
}

export interface ScopeRequest {
  refs: RefEntry[]
  name: string
  filePath: string
  def?: SymbolEntry | undefined
}

/** {@link scopeRefsToDefinition} for many requests at once, resolving every typed lookup through `session`, so a traversal that scopes many nodes (`impact`, one hop at a time) grows one compiler program instead of building one per node. Returns one list per request, in order. */
export function scopeRefsToDefinitions(session: TypedRefsSession, requests: readonly ScopeRequest[], getSyms: (fp: string) => SymbolEntry[]): RefEntry[][] {
  const typedAt: number[] = []
  const inputs: ResolveTypedRefsInput[] = []
  requests.forEach((r, i) => {
    const target = r.def ?? soleDefinitionIn(r.name, r.filePath)
    if (target === undefined || r.refs.length === 0 || !isTsPath(target.filePath)) return
    typedAt.push(i)
    inputs.push(typedInput(r.refs, target))
  })
  let typed: Array<RefEntry[] | null>
  try {
    typed = session.resolve(inputs)
  } catch {
    typed = inputs.map(() => null)
  }
  const typedByRequest = new Map(typedAt.map((i, k) => [i, typed[k] ?? null]))
  return requests.map((r, i) => typedByRequest.get(i) ?? filterRefsForSymbol(r.refs, r.name, r.filePath, getSyms))
}

/** The one symbol named `name` in `filePath`, or undefined when there are none or several. */
function soleDefinitionIn(name: string, filePath: string): SymbolEntry | undefined {
  const defs = querySymbols({ name, filePath, limit: 2 })
  return defs.length === 1 ? defs[0] : undefined
}

/** Resolves callers of a symbol. */
export function resolveCallers(name: string, limit?: number, filePath?: string, rootDir?: string, excludeTests?: boolean, def?: SymbolEntry): CallerEntry[] {
  const resolvedRootDir = rootDir ?? resolveProjectRoot({ project: process.cwd() })
  const queryLimit = excludeTests === true ? UNBOUNDED_REF_LIMIT : (limit ?? 500)
  const refs = queryRefs({ name, limit: queryLimit, rootDir: resolvedRootDir })
  const getSyms = buildFileSymCache()
  const scoped = filePath === undefined ? narrowRefsToDef(refs, def) : scopeRefsToDefinition(refs, name, filePath, getSyms, def)

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

/** Deterministic tiebreak for impact-hop entries: primary key is hop distance, secondary key is symbol name alphabetical. */
export function compareHopEntries(a: readonly [string, number], b: readonly [string, number]): number {
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

// ---- ancestor dispatch -------------------------------------------------------

export const MAX_ANCESTOR_DEPTH = 8

export function directBaseClassName(scopeName: string, classFile: string, rootDir: string): string | null {
  const candidates = queryRefsByContext(scopeName, classFile)
  for (const ref of candidates) {
    if (querySymbols({ name: ref.name, kind: 'class', limit: 1, rootDir }).length > 0) return ref.name
  }
  return null
}

export function hasAncestorDispatchRef(methodName: string, scopeName: string, classFile: string, rootDir: string): boolean {
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
    let baseRefs = queryRefs({ name: methodName, filePath: baseSym.filePath, limit: DEFAULT_REF_QUERY_LIMIT, rootDir })
    if (baseRefs.length >= DEFAULT_REF_QUERY_LIMIT && !baseRefs.some((ref) => ref.line >= baseSym.lineStart && ref.line <= baseSym.lineEnd)) {
      baseRefs = queryRefs({ name: methodName, filePath: baseSym.filePath, limit: UNBOUNDED_REF_LIMIT, rootDir })
    }
    if (baseRefs.some((ref) => ref.line >= baseSym.lineStart && ref.line <= baseSym.lineEnd)) return true
    currentName = baseName
    currentFile = baseSym.filePath
  }
  return false
}

// ---- symbol kind classifications --------------------------------------------

export const GENERIC_SYMBOL_KINDS: ReadonlyArray<string> = [
  'function', 'method', 'class', 'variable', 'const', 'namespace', 'module', 'property',
  'field', 'constructor', 'macro', 'alias', 'directive', 'var', 'impl',
]

export const OTHER_ADAPTER_SYMBOL_KINDS: ReadonlyArray<string> = [
  'heading', 'selector', 'env_key', 'key', 'section', 'html_class', 'html_id',
  'apex_method', 'sf_record_type', 'sf_apex_class', 'sf_flow', 'sf_flow_record_lookup',
  'sf_flow_action', 'sf_flow_subflow', 'sf_mystery_type', 'sf_lightning_component_bundle',
  'sf_lwc_target', 'sf_lwc_property', 'liquid_schema', 'liquid_section_file',
  'lwc_bundle', 'lwc_component_alias', 'lwc_api_property', 'lwc_api_method', 'lwc_ref',
]

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
  'extension_type',
  'actor',
  'proto_message',
  'proto_enum',
  'proto_service',
  'apex_class',
  'apex_interface',
  'apex_enum',
  'graphql_type',
  'graphql_interface',
  'graphql_input',
  'graphql_enum',
  'graphql_union',
  'graphql_scalar',
  'object',
  'sfc_script_class',
  'graphql_extend',
]

export const REF_BLIND_KINDS: ReadonlyArray<string> = [...new Set([...TYPE_KINDS, 'impl'])]

export function refBlindKindVerdict(rows: ReadonlyArray<{ kind: string }>): { blindKinds: string[]; blindCount: number; allBlind: boolean } {
  const blind = rows.filter((r) => REF_BLIND_KINDS.includes(r.kind))
  return {
    blindKinds: [...new Set(blind.map((r) => r.kind))],
    blindCount: blind.length,
    allBlind: rows.length > 0 && blind.length === rows.length,
  }
}

export const CORE_SYMBOL_KINDS: ReadonlyArray<string> = [
  ...new Set([...GENERIC_SYMBOL_KINDS, ...TYPE_KINDS, ...OTHER_ADAPTER_SYMBOL_KINDS]),
]

// ---- cycle detection --------------------------------------------------------

export const MAX_CYCLES = 200

export function tarjanSCCs(graph: Map<string, string[]>): string[][] {
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

export function canonicalCycleKey(cyclePath: string[]): string {
  const nodes = cyclePath.slice(0, -1)
  let minIdx = 0
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[minIdx]!) minIdx = i
  }
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(' ')
}

export function findCycles(graph: Map<string, string[]>): string[][] {
  return findCyclesCapped(graph).cycles
}

export function findCyclesCapped(graph: Map<string, string[]>): { cycles: string[][]; truncated: boolean } {
  const cycles: string[][] = []
  const seen = new Set<string>()
  const sccs = tarjanSCCs(graph)
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
