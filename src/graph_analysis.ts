/**
 * Code graph analysis and query commands: similar, context-for, test-for, coverage-gaps, arch, blame, and ask.
 */

import * as fs from 'node:fs'

import { querySymbols, queryRefs, searchSymbolsFts } from './index_reader.js'
import { displaySafeText, toDisplayPath, displaySafeJson, resolveIndexPath } from './paths.js'
import { fenceUntrusted } from './untrusted_fence.js'
import { UNTRUSTED_FILE_TAG } from './injection_scan.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { resolveSymbolSpecOrEmitError, guardJsonRows } from './read_commands.js'
import { buildImportGraph } from './import_graph.js'
import { detectModules, renderModules } from './modules.js'
import { estimateTokens } from './overflow_guard.js'
import { runGit, isTestFile, extractErrorMessage, countNoun } from './util.js'
import { globalDbPath } from './constants.js'
import { formatSymbolLocation } from './indexed_source.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import {
  ALL_SYMBOLS_IN_FILE_LIMIT,
  UNBOUNDED_REF_LIMIT,
  MAX_CYCLES,
  ENTRY_NAMES,
  enclosingSymbol,
  buildFileSymCache,
  findCyclesCapped,
} from './graph_traversal.js'
import { emit, emitErr } from './emit.js'

// ---- similar ----------------------------------------------------------------

export interface SimilarOptions {
  spec: string
  top?: number
  json?: boolean
}

export function runSimilar(opts: SimilarOptions): number {
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

  const anchor = resolveSymbolSpecOrEmitError('similar', opts.spec, undefined)
  if (anchor === null) return 1

  const words = [anchor.name, ...(anchor.docstring ?? '').split(/\s+/).filter((w: string) => w.length > 4)]
  const query = words.slice(0, 8).join(' ')

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const hits = searchSymbolsFts(query, UNBOUNDED_REF_LIMIT, undefined, rootDir)
  const matches = hits.filter((h) => !(h.filePath === anchor.filePath && h.name === anchor.name))
  const results = matches.slice(0, top)

  if (matches.length > results.length) {
    emitErr(`Showing top ${results.length} of ${matches.length} similar symbols (raise --top to see the rest).`)
  }

  if (opts.json === true) {
    emit(displaySafeJson(results.map((h) => ({ name: h.name, kind: h.kind, file: h.filePath, line: h.lineStart }))))
    return 0
  }
  for (const h of results) emit(`${displaySafeText(h.name)}\t${displaySafeText(h.kind)}\t${formatSymbolLocation(displaySafeText(toDisplayPath(rootDir, h.filePath)), h.lineStart)}`)
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
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 12
  const budget = opts.budget

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const fetched = searchSymbolsFts(opts.task, top + 1, undefined, rootDir)
  const moreBeyondTop = fetched.length > top
  const hits = fetched.slice(0, top)

  if (hits.length === 0) {
    emitErr(`No matches found for '${opts.task}'`)
    return 1
  }

  interface ContextEntry { file: string; symbol: string; kind: string; line: number; readCmd: string }
  const entries: ContextEntry[] = []
  let tokensSoFar = 0

  for (const h of hits) {
    const bodyTokens = estimateTokens(h.body ?? '')
    if (budget !== undefined && tokensSoFar + bodyTokens > budget) continue
    tokensSoFar += bodyTokens
    entries.push({ file: h.filePath, symbol: h.name, kind: h.kind, line: h.lineStart, readCmd: `token-goat read "${h.filePath}::${h.name}@${h.lineStart}"` })
  }

  const skippedByBudget = hits.length - entries.length
  const notices: string[] = []
  if (skippedByBudget > 0) {
    notices.push(
      entries.length === 0
        ? `All ${countNoun(skippedByBudget, 'matching symbol')} were larger than --budget ${String(opts.budget)} tokens, so none are shown. Raise --budget.`
        : `Showing ${entries.length} of ${countNoun(hits.length, 'matching symbol')}; ${skippedByBudget} did not fit --budget ${String(opts.budget)} tokens.`,
    )
  }
  if (moreBeyondTop) notices.push(`More matches exist beyond --top ${top} (raise it to see them).`)
  for (const n of notices) emitErr(n)

  if (opts.json === true) {
    emit(displaySafeJson(entries))
    return 0
  }
  for (const e of entries) emit(`token-goat read "${displaySafeText(toDisplayPath(rootDir, e.file))}::${displaySafeText(e.symbol)}@${e.line}"`)
  return 0
}

// ---- test-for ---------------------------------------------------------------

export interface TestForOptions {
  file: string
  json?: boolean
}

export interface TestForEntry { testFile: string; testFunctions: string[] }

export function runTestFor(opts: TestForOptions): number {
  const filePath = resolveIndexPath(opts.file)
  const symbols = querySymbols({ filePath, limit: ALL_SYMBOLS_IN_FILE_LIMIT })

  if (!fs.existsSync(opts.file) && symbols.length === 0) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const testFileMap = new Map<string, Set<string>>()
  const getSyms = buildFileSymCache()

  for (const sym of symbols) {
    const refs = queryRefs({ name: sym.name, limit: UNBOUNDED_REF_LIMIT, rootDir })
    for (const ref of refs) {
      if (!isTestFile(ref.filePath)) continue
      if (!testFileMap.has(ref.filePath)) testFileMap.set(ref.filePath, new Set())
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc !== null) {
        testFileMap.get(ref.filePath)!.add(enc.name)
      }
    }
  }

  const results: TestForEntry[] = []

  for (const [tf, referencingFns] of testFileMap) {
    const testSyms = querySymbols({ filePath: tf, limit: ALL_SYMBOLS_IN_FILE_LIMIT })
    const testFns = testSyms
      .filter((s) => /^(test|Test|spec|describe|it)(?:[A-Z_0-9]|$)/.test(s.name) && referencingFns.has(s.name))
      .map((s) => s.name)
    results.push({ testFile: tf, testFunctions: testFns })
  }

  if (opts.json === true) {
    const capped = guardJsonRows(results.map((r) => ({ ...r, testFile: toDisplayPath(rootDir, r.testFile) })))
    emit(displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }))
    return 0
  }
  if (results.length === 0) {
    emit(`No test files found referencing symbols in '${displaySafeText(opts.file)}'`)
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
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 50
  const rootDir = resolveProjectRoot({ project: process.cwd() })
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

  if (gaps.length > sliced.length) {
    emitErr(`Showing top ${sliced.length} of ${gaps.length} coverage gaps (raise --top to see the rest).`)
  }

  if (opts.json === true) {
    emit(displaySafeJson(sliced))
    return 0
  }
  if (sliced.length === 0) {
    emit('No coverage gaps found.')
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) emit(emptyIndexMessage(rootDir))
    return 0
  }
  for (const g of sliced) emit(`${displaySafeText(g.name)}\t${displaySafeText(g.kind)}\t${displaySafeText(toDisplayPath(rootDir, g.file))}:${g.line}`)
  return 0
}

// ---- arch -------------------------------------------------------------------

export interface ArchOptions {
  top?: number
  json?: boolean
  cwd?: string
  modules?: boolean
}

export function runArch(opts: ArchOptions): number {
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const cwd = opts.cwd ?? process.cwd()
  const top = opts.top ?? 10
  const { files, graph, importedBy, resolve } = buildImportGraph(cwd)
  if (files.length === 0 && opts.json !== true) {
    emit(`no tracked files found under '${toDisplayPath(getDisplayRoot(cwd), cwd)}' (is it a git repo?). Nothing to analyse.`)
    return 0
  }

  const allHubs = [...importedBy.entries()].sort((a, b) => b[1].size - a[1].size).map(([f, importers]) => ({ file: f, importedBy: importers.size }))
  const hubsTotal = allHubs.length
  const hubs = allHubs.slice(0, top)

  const allEntryPoints = files.filter((f) => !importedBy.has(f) && (graph.get(f) ?? []).length > 0).map((f) => ({ file: f }))
  const entryPointsTotal = allEntryPoints.length
  const entryPoints = allEntryPoints.slice(0, top)

  const { cycles, truncated: cyclesTruncated } = findCyclesCapped(graph)
  const moduleResult = opts.modules === true ? detectModules({ files, graph, importedBy, resolve }, cwd, top) : null

  if (opts.json === true) {
    const modulePayload = moduleResult === null ? {} : { modules: moduleResult.modules, modulesTotal: moduleResult.modulesTotal, modulesTruncated: moduleResult.modules.length < moduleResult.modulesTotal, modularity: moduleResult.modularity, isolatedCount: moduleResult.isolatedCount, crossImports: moduleResult.crossImports, crossImportsTotal: moduleResult.crossImportsTotal, crossImportsTruncated: moduleResult.crossImports.length < moduleResult.crossImportsTotal, noImportEdges: moduleResult.noEdges }
    emit(displaySafeJson({ hubs, hubsTotal, hubsTruncated: hubs.length < hubsTotal, entryPoints, entryPointsTotal, entryPointsTruncated: entryPoints.length < entryPointsTotal, cycles, ...(cyclesTruncated ? { cyclesTruncated: true } : {}), ...modulePayload }))
    return 0
  }

  emit(hubs.length < hubsTotal ? `hubs (top ${hubs.length} of ${hubsTotal} most-imported):` : `hubs (${hubsTotal} most-imported):`)
  for (const h of hubs) emit(`  ${h.importedBy} importers\t${displaySafeText(toDisplayPath(getDisplayRoot(opts.cwd), h.file))}`)
  emit(entryPoints.length < entryPointsTotal ? `entry points (imported by nobody, top ${entryPoints.length} of ${entryPointsTotal}):` : `entry points (imported by nobody, ${entryPointsTotal} found):`)
  for (const e of entryPoints) emit(`  ${displaySafeText(toDisplayPath(getDisplayRoot(opts.cwd), e.file))}`)
  emit(cyclesTruncated ? `cycles (first ${cycles.length}, truncated at the ${MAX_CYCLES}-cycle enumeration limit: more cycles exist):` : `cycles (${cycles.length} found):`)
  for (const c of cycles) emit(`  ${c.map((f) => toDisplayPath(getDisplayRoot(opts.cwd), f)).join(' -> ')}`)
  if (moduleResult !== null) for (const line of renderModules(moduleResult, top)) emit(line)
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
    emitErr(`Invalid spec - expected "file::symbol", got: ${displaySafeText(opts.spec)}`)
    return 1
  }
  const cwd = opts.cwd ?? process.cwd()

  const sym = resolveSymbolSpecOrEmitError('blame', opts.spec, undefined)
  if (sym === null) return 1
  const filePath = sym.filePath
  const start = sym.lineStart
  const end = sym.lineEnd

  let raw: string
  try {
    const result = runGit(['blame', '-L', `${start},${end}`, '--', filePath], { cwd })
    if (result.exitCode !== 0) {
      emitErr(`git blame failed: ${displaySafeText(result.stderr)}`)
      return 1
    }
    raw = result.stdout
  } catch (e) {
    emitErr(`git blame failed: ${extractErrorMessage(e)}`)
    return 1
  }

  if (opts.json === true) {
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => {
      const m = /^(\^?)([0-9a-f]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}[^)]*)\s+(\d+)\)(.*)/.exec(l)
      if (!m) return { raw: l }
      return { commit: m[2], boundary: m[1] === '^', author: (m[3] ?? '').trim(), date: (m[4] ?? '').trim(), line: Number.parseInt(m[5] ?? '0', 10), content: m[6] }
    })
    emit(displaySafeJson({ symbol: sym.name, file: filePath, lines }))
    return 0
  }

  emit(`${displaySafeText(sym.name)}\t${displaySafeText(toDisplayPath(getDisplayRoot(opts.cwd), filePath))}:${start}-${end}`)
  emit(fenceUntrusted(raw.trim(), UNTRUSTED_FILE_TAG))
  return 0
}

