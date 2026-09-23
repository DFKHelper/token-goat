/**
 * Code graph inspection commands: dead, deps, types, and scope.
 *
 * Implements:
 * - token-goat dead: Unreferenced symbol detection with test exclusion and reachability filters
 * - token-goat deps: Internal and external import dependency analysis
 * - token-goat types: Type declaration listing and filtering
 * - token-goat scope: Enclosing symbol resolution for a file:line coordinate
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { querySymbols, queryRefs, distinctSymbolKinds } from './index_reader.js'
import { displaySafeText, normalizePath, resolveIndexPath, toDisplayPath, displaySafeJson } from './paths.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { REF_BLIND_KIND_REASON, isRefIndexedFile } from './ref_blindness.js'
import { symbolExtractorGap, extractImports, importsExtensionFor, fileConfinementRefusal, guardJsonRows, rankSimilarNames, didYouMean } from './read_commands.js'
import { decodeSource, isTestFile, compileGrepMatcher, grepFilteredToEmptyNotice, excludeTestsHiddenNote, countNoun } from './util.js'
import type { SymbolEntry } from './parser_types.js'
import { globalDbPath } from './constants.js'
import { formatSymbolLocation } from './indexed_source.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import {
  ALL_SYMBOLS_IN_FILE_LIMIT,
  DEFAULT_REF_QUERY_LIMIT,
  UNBOUNDED_REF_LIMIT,
  enclosingNamedScope,
  looksLikeTypeClass,
  isDeadSymbol,
  buildFileSymCache,
  filterRefsForSymbol,
  hasAncestorDispatchRef,
  REF_BLIND_KINDS,
  CORE_SYMBOL_KINDS,
  TYPE_KINDS,
} from './graph_traversal.js'
import { emit, emitErr } from './emit.js'

// ---- dead -------------------------------------------------------------------

export interface DeadOptions {
  kind?: string
  includePrivate?: boolean
  top?: number
  json?: boolean
  /** `--exclude-tests`: drop dead symbols DEFINED in a test file (per isTestFile), not ones merely referenced there. */
  excludeTests?: boolean
  /** Only list dead symbols whose NAME matches this pattern. */
  grep?: string
}

export function runDead(opts: DeadOptions): number {
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const kinds = opts.kind !== undefined
    ? [...new Set(opts.kind.split(',').map((k) => k.trim()).filter((k) => k.length > 0))]
    : ['function']
  const rootDir = resolveProjectRoot({ project: process.cwd() })

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

  const blindKinds = kinds.filter((k) => REF_BLIND_KINDS.includes(k))
  const assessableKinds = kinds.filter((k) => !REF_BLIND_KINDS.includes(k))
  if (blindKinds.length > 0 && assessableKinds.length === 0) {
    const blindLabel = blindKinds.length === 1 ? 'kind' : 'kinds'
    emitErr(`Cannot assess deadness for ${blindLabel}: ${blindKinds.map((k) => `'${k}'`).join(', ')} -- ${REF_BLIND_KIND_REASON}.`)
    emitErr(`Every symbol of ${blindKinds.length === 1 ? 'this kind' : 'these kinds'} would be reported dead, so no result is emitted rather than a wrong one. To hunt unused type declarations, list them with 'token-goat types --json' and search the source for each name directly.`)
    return 1
  }
  const blindKindNote = blindKinds.length > 0
    ? `Note: ${blindKinds.map((k) => `'${k}'`).join(', ')} excluded -- ${REF_BLIND_KIND_REASON}.`
    : undefined
  if (blindKindNote !== undefined && opts.json !== true) emitErr(blindKindNote)

  const syms = assessableKinds.flatMap((k) => querySymbols({ kind: k, limit: UNBOUNDED_REF_LIMIT, rootDir }))
  const getSyms = buildFileSymCache()

  const results: Array<{ name: string; kind: string; file: string; line: number }> = []

  let suppressed = 0
  let refBlindByLanguage = 0
  for (const sym of syms) {
    if (!isRefIndexedFile(sym.filePath)) {
      refBlindByLanguage += 1
      continue
    }
    if (opts.includePrivate !== true && sym.name.startsWith('_')) continue
    const refs = queryRefs({ name: sym.name, limit: DEFAULT_REF_QUERY_LIMIT, rootDir })
    let scoped = filterRefsForSymbol(refs, sym.name, sym.filePath, getSyms)
    if (scoped.length === 0 && refs.length >= DEFAULT_REF_QUERY_LIMIT) {
      scoped = filterRefsForSymbol(queryRefs({ name: sym.name, limit: UNBOUNDED_REF_LIMIT, rootDir }), sym.name, sym.filePath, getSyms)
    }
    if (!isDeadSymbol(sym.name, scoped.length)) continue
    if (sym.kind === 'method') {
      const ownScope = enclosingNamedScope(getSyms(sym.filePath), sym.lineStart)
      if (ownScope !== null && hasAncestorDispatchRef(sym.name, ownScope.name, sym.filePath, rootDir)) continue
    }
    if (opts.excludeTests === true && isTestFile(sym.filePath)) {
      suppressed += 1
      continue
    }
    results.push({ name: sym.name, kind: sym.kind, file: sym.filePath, line: sym.lineStart })
  }

  if (refBlindByLanguage > 0 && opts.json !== true) {
    emitErr(`Note: ${countNoun(refBlindByLanguage, 'symbol')} skipped -- defined in a language whose call sites token-goat does not index, so deadness cannot be determined for them.`)
  }

  const preGrepCount = results.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const grepped = matchesGrep !== undefined ? results.filter((r) => matchesGrep(r.name)) : results
  const sliced = grepped.slice(0, opts.top ?? grepped.length)

  if (opts.json === true) {
    const capped = guardJsonRows(sliced.map((r) => {
      const displayPath = toDisplayPath(rootDir, r.file)
      return { ...r, file: displayPath, filePath: displayPath }
    }))
    const topTruncated = sliced.length < grepped.length
    const hiddenByGrep = preGrepCount - grepped.length
    emit(displaySafeJson({
      items: capped.items,
      truncated: capped.truncated || topTruncated,
      totalCount: grepped.length,
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      ...(opts.excludeTests === true && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}),
      ...(blindKinds.length > 0 ? { excludedKinds: blindKinds, excludedKindsReason: REF_BLIND_KIND_REASON } : {}),
      ...(refBlindByLanguage > 0 ? { unassessableByLanguage: refBlindByLanguage } : {}),
    }))
    return 0
  }

  if (sliced.length === 0) {
    if (matchesGrep !== undefined && preGrepCount > 0) {
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'dead symbol', 'dead symbols'))
      return 0
    }
    if (opts.excludeTests === true && suppressed > 0) {
      emit(`No dead symbols found (${excludeTestsHiddenNote(suppressed)}).`)
    } else {
      emit('No dead symbols found.')
    }
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) emit(emptyIndexMessage(rootDir))
    return 0
  }

  if (opts.excludeTests === true && suppressed > 0) {
    emit(`${countNoun(sliced.length, 'dead symbol')} (${excludeTestsHiddenNote(suppressed)})`)
  }

  for (const r of sliced) {
    emit(`${displaySafeText(r.name)}\t${displaySafeText(toDisplayPath(rootDir, r.file))}:${r.line}`)
  }
  return 0
}

// ---- deps -------------------------------------------------------------------

export interface DepsOptions {
  file: string
  json?: boolean
  /** Only list dependencies whose MODULE SPECIFIER matches this pattern. */
  grep?: string
}

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
        const baseExt = path.extname(base)
        const bareBase = SOURCE_EXTENSIONS.includes(baseExt) ? base.slice(0, -baseExt.length) : base
        for (const srcExt of SOURCE_EXTENSIONS) {
          const candidate = bareBase + srcExt
          if (fs.existsSync(candidate)) {
            resolved = candidate
            break
          }
        }
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
      internal.push(imp)
    } else {
      external.push(imp)
    }
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const displayInternal = internal.map((i) => (path.isAbsolute(i) ? toDisplayPath(rootDir, normalizePath(i)) : i))

  const preFilterCount = displayInternal.length + external.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredInternal = matchesGrep !== undefined ? displayInternal.filter((i) => matchesGrep(i)) : displayInternal
  const filteredExternal = matchesGrep !== undefined ? external.filter((e) => matchesGrep(e)) : external

  if (opts.json === true) {
    const hiddenByGrep = preFilterCount - (filteredInternal.length + filteredExternal.length)
    emit(displaySafeJson({ file: toDisplayPath(rootDir, normalizePath(opts.file)), internal: filteredInternal, external: filteredExternal, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) }))
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

export interface TypesOptions {
  file?: string
  json?: boolean
  limit?: number
  /** Only list type declarations whose NAME matches this pattern. */
  grep?: string
  /** `--exclude-tests`: drop type declarations DEFINED in a test file (per isTestFile). */
  excludeTests?: boolean
}

export const TYPES_SCAN_LIMIT = -1

export function runTypes(opts: TypesOptions): number {
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const limit = opts.limit ?? 500
  const excludeTests = opts.excludeTests === true
  const filePath = opts.file !== undefined ? resolveIndexPath(opts.file) : undefined
  const fpOpt = filePath !== undefined ? { filePath } : {}
  const rootDir = resolveProjectRoot({ project: process.cwd() })

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
    (a, b) => a.filePath.localeCompare(b.filePath, 'en') || a.lineStart - b.lineStart,
  )

  if (results.length === 0) {
    if (opts.file !== undefined && !fs.existsSync(opts.file)) {
      emitErr(`Could not read: ${opts.file}`)
      return 1
    }
    const ctx = opts.file !== undefined ? ` in '${opts.file}'` : ''
    if (excludeTests && suppressed > 0) {
      if (opts.json === true) {
        emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByExcludeTests: suppressed }))
        return 0
      }
      emit(`No non-test type declarations found${ctx} (${excludeTestsHiddenNote(suppressed)})`)
      return 0
    }
    emitErr(`No type declarations found${ctx}`)
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  const preFilterCount = results.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const matched = matchesGrep !== undefined ? results.filter((r) => matchesGrep(r.name)) : results

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
    if (opts.json === true) {
      emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preFilterCount }))
      return 0
    }
    emit(grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'type declaration', 'type declarations'))
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(filtered.map((r) => ({ ...r, filePath: toDisplayPath(rootDir, r.filePath) })))
    const hiddenByGrep = preFilterCount - eligibleCount
    emit(displaySafeJson({
      items: capped.items,
      truncated: capped.truncated || cappedOut > 0,
      totalCount: eligibleCount,
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      ...(excludeTests && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}),
    }))
    return 0
  }

  if (excludeTests && suppressed > 0) {
    emit(`${countNoun(filtered.length, 'type declaration')} (${excludeTestsHiddenNote(suppressed)})`)
  }

  for (const r of filtered) {
    emit(`${displaySafeText(r.name)}\t${displaySafeText(r.kind)}\t${formatSymbolLocation(displaySafeText(toDisplayPath(rootDir, r.filePath)), r.lineStart)}`)
  }
  if (cappedOut > 0) {
    emitErr(`Showing ${filtered.length} of ${eligibleCount} type declarations (--limit is per kind; raise it to see the rest).`)
  }
  return 0
}

// ---- scope ------------------------------------------------------------------

export interface ScopeOptions {
  spec: string
  json?: boolean
  projectRoot?: string
}

export function runScope(opts: ScopeOptions): number {
  const colonIdx = opts.spec.lastIndexOf(':')
  if (colonIdx <= 0) {
    emitErr(`Invalid spec — expected "file:line", got: ${opts.spec}`)
    return 1
  }

  const file = opts.spec.slice(0, colonIdx)
  const lineStr = opts.spec.slice(colonIdx + 1)

  if (!/^\d+$/.test(lineStr)) {
    emitErr(`Invalid line number: ${lineStr}`)
    return 1
  }
  const line = Number.parseInt(lineStr, 10)
  if (!Number.isSafeInteger(line) || line < 1) {
    emitErr(`Invalid line number: ${lineStr}`)
    return 1
  }

  const confined = fileConfinementRefusal('This file', file, opts.projectRoot)
  if (confined !== null) {
    emitErr(confined)
    return 1
  }

  const filePath = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
  const enclosing = querySymbols({ filePath, enclosingLine: line, limit: ALL_SYMBOLS_IN_FILE_LIMIT })
    .sort((a, b) => b.lineStart - a.lineStart || a.lineEnd - b.lineEnd || a.name.localeCompare(b.name, 'en'))

  if (enclosing.length === 0) {
    if (querySymbols({ filePath, limit: 1 }).length === 0) {
      if (!fs.existsSync(filePath)) {
        emitErr(`Could not read: ${file}`)
        return 1
      }
      emitErr(
        symbolExtractorGap(file, filePath) ??
          `No indexed symbols in '${file}' — the file exists but nothing is indexed for it, so every line looks empty`,
      )
      return 1
    }
    emitErr(`No symbols enclosing line ${line} in '${file}'`)
    return 1
  }

  const scopeDisplayRoot = getDisplayRoot()

  if (opts.json === true) {
    emit(
      displaySafeJson(
        enclosing.map((s) => ({ ...s, filePath: toDisplayPath(scopeDisplayRoot, s.filePath) }))),
    )
    return 0
  }

  for (const s of enclosing) {
    emit(`${displaySafeText(s.name)}\t${displaySafeText(s.kind)}\t${formatSymbolLocation(displaySafeText(toDisplayPath(scopeDisplayRoot, s.filePath)), s.lineStart, s.lineEnd)}`)
  }
  return 0
}
