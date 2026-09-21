/**
 * CLI command handlers for code-graph commands.
 *
 * Implements callers, call-chain, and impact, and re-exports the full
 * code graph public API across traversal, inspection, and analysis submodules.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { querySymbols, queryRefs, countRefs, searchSymbolsFts } from './index_reader.js'
import { resolveIndexPath, toDisplayPath, displaySafeJson, displaySafeText } from './paths.js'
import { resolveProjectRoot } from './project.js'
import {
  REF_BLIND_DEF_PROBE_LIMIT,
  isRefIndexedFile,
  refBlindLanguageNotice,
  refBlindKindNotice,
  refBlindKindPartialNote,
} from './ref_blindness.js'
import { detectLanguageOfFile } from './parser_types.js'
import { guardJsonRows, unknownSymbolSuggestion, warnIfFilesStale } from './read_commands.js'
import {
  ensureNewline,
  isTestFile,
  compileGrepMatcher,
  grepFilteredToEmptyNotice,
  excludeTestsHiddenNote,
  countNoun,
  resolveOnPath,
  windowsCmdQuoteArg,
} from './util.js'
import { buildContextWindow, renderContextWindow } from './util_context.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { globalDbPath } from './constants.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'
import { fenceUntrustedFileContent } from './injection_scan.js'
import { redactSecrets } from './secret_redact.js'

import {
  DEFAULT_REF_QUERY_LIMIT,
  UNBOUNDED_REF_LIMIT,
  enclosingSymbol,
  type CallersOfFn,
  bfsCallChains,
  parseGraphSymbolSpec,
  buildFileSymCache,
  filterRefsForSymbol,
  resolveCallers,
  refBlindKindVerdict,
  compareHopEntries,
} from './graph_traversal.js'

// Re-export all graph traversal, inspection, and analysis APIs for 100% backward compatibility
export * from './graph_traversal.js'
export * from './graph_inspection.js'
export * from './graph_analysis.js'
export { isTestFile }

function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

// ---- callers ----------------------------------------------------------------

export interface CallersOptions {
  symbol: string
  json?: boolean
  limit?: number
  context?: number
  excludeTests?: boolean
  grep?: string
}

export function runCallers(opts: CallersOptions): number {
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name, file } = parseGraphSymbolSpec(opts.symbol)
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined
  if (fileHint !== undefined && querySymbols({ name, filePath: fileHint, limit: 1 }).length === 0) {
    emitErr(`Symbol '${name}' not found in '${file}'`)
    return 1
  }

  const unbounded = opts.excludeTests === true || opts.grep !== undefined || fileHint !== undefined
  const requestedLimit = opts.limit ?? DEFAULT_REF_QUERY_LIMIT
  const probed = resolveCallers(name, unbounded ? opts.limit : requestedLimit + 1, fileHint, rootDir, unbounded)
  const sqlTruncated = !unbounded && probed.length > requestedLimit
  const resolved = sqlTruncated ? probed.slice(0, requestedLimit) : probed

  const suppressed = opts.excludeTests === true ? resolved.filter((e) => isTestFile(e.file)).length : 0
  let filtered = opts.excludeTests === true ? resolved.filter((e) => !isTestFile(e.file)) : resolved

  const preGrepCount = filtered.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  if (matchesGrep !== undefined) filtered = filtered.filter((e) => matchesGrep(e.caller))
  const entries = unbounded ? filtered.slice(0, opts.limit ?? 500) : filtered

  if (entries.length === 0) {
    if (matchesGrep !== undefined && preGrepCount > 0) {
      if (opts.json === true) {
        emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preGrepCount }))
        return 0
      }
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'caller', 'callers'))
      return 0
    }
    if (opts.excludeTests === true && suppressed > 0) {
      if (opts.json === true) {
        emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByExcludeTests: suppressed }))
        return 1
      }
      emitErr(`No non-test references found for '${opts.symbol}' (${excludeTestsHiddenNote(suppressed)})`)
      return 1
    }

    const defRows = querySymbols({ name, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    if (defRows.length === 0) {
      emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(name, rootDir)}`)
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }

    const defPaths = fileHint !== undefined ? [fileHint] : defRows.map((r) => r.filePath)
    const firstDefPath = defPaths[0]
    if (firstDefPath !== undefined && defPaths.every((fp) => !isRefIndexedFile(fp))) {
      emitErr(refBlindLanguageNotice(name, detectLanguageOfFile(firstDefPath), toDisplayPath(rootDir, firstDefPath)))
      return 1
    }

    const kindRows = fileHint !== undefined ? querySymbols({ name, filePath: fileHint, limit: REF_BLIND_DEF_PROBE_LIMIT }) : defRows
    const kindVerdict = refBlindKindVerdict(kindRows)
    if (kindVerdict.allBlind) {
      emitErr(refBlindKindNotice(name, kindVerdict.blindKinds))
      return 1
    }
    emitErr(`No references found for '${opts.symbol}'`)
    if (kindVerdict.blindCount > 0) emitErr(refBlindKindPartialNote(name, kindVerdict.blindKinds, kindVerdict.blindCount, kindRows.length))
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  const contextLines = opts.context ?? 0

  if (opts.json === true) {
    const withContext = contextLines > 0
      ? entries.map((e) => ({ ...e, contextLines: buildContextWindow(e.file, e.line, contextLines) ?? [] }))
      : entries
    const rows = withContext.map((e) => {
      const displayPath = toDisplayPath(rootDir, e.file)
      return { ...e, file: displayPath, filePath: displayPath }
    })
    const capped = guardJsonRows(rows)
    const limitTruncated = entries.length < filtered.length || sqlTruncated
    const hiddenByGrep = preGrepCount - filtered.length
    emit(displaySafeJson({
      items: capped.items,
      truncated: capped.truncated || limitTruncated,
      totalCount: filtered.length,
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      ...(opts.excludeTests === true && suppressed > 0 ? { hiddenByExcludeTests: suppressed } : {}),
    }))
    return 0
  }

  if (opts.excludeTests === true && suppressed > 0) {
    emit(`${countNoun(entries.length, 'caller')} found (${excludeTestsHiddenNote(suppressed)})`)
  }

  // Text mode used to stop dead at the bound -- exactly 500 rows by default, exactly --limit N otherwise -- with nothing saying anything was withheld, so a clipped page was indistinguishable from a symbol that genuinely has that many callers. Only `--json` ever carried the `truncated` flag computed above. Mirror `impact --top`'s stderr notice so stdout stays a pure row list (the JSON envelope and the text rows are unchanged), and name the exact total: in the bounded path the client-side filters are all off, so refs map 1:1 to callers and countRefs is that total; in the unbounded path `filtered` already holds every post-filter caller.
  const overflowed = sqlTruncated || entries.length < filtered.length
  if (overflowed) {
    const totalCallers = sqlTruncated ? countRefs({ name, rootDir }) : filtered.length
    emitErr(`Showing the first ${entries.length} of ${countNoun(totalCallers, 'caller')} (raise --limit to see the rest).`)
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
  excludeTests?: boolean
  grep?: string
}

export function runCallChain(opts: CallChainOptions): number {
  if (opts.depth !== undefined && opts.depth <= 0) {
    emitErr(`--depth must be a positive number, got: ${opts.depth}`)
    return 1
  }
  const maxDepth = opts.depth ?? 8
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name, file } = parseGraphSymbolSpec(opts.symbol)
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined

  if (fileHint !== undefined) {
    if (querySymbols({ name, filePath: fileHint, limit: 1 }).length === 0) {
      emitErr(`Symbol '${name}' not found in '${file}'`)
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
  } else if (querySymbols({ name, rootDir, limit: 1 }).length === 0) {
    emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(name, rootDir)}`)
    if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    return 1
  }

  const refBlindRootPath = (): string | undefined => {
    const paths = fileHint !== undefined ? [fileHint] : querySymbols({ name, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT }).map((r) => r.filePath)
    return paths.length > 0 && paths.every((fp) => !isRefIndexedFile(fp)) ? paths[0] : undefined
  }

  const refBlindRootKinds = (): { blindKinds: string[]; blindCount: number; allBlind: boolean; total: number } => {
    const rows = fileHint !== undefined
      ? querySymbols({ name, filePath: fileHint, limit: REF_BLIND_DEF_PROBE_LIMIT })
      : querySymbols({ name, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    return { ...refBlindKindVerdict(rows), total: rows.length }
  }

  const getSyms = buildFileSymCache()
  let suppressedCount = 0

  const callersOf: CallersOfFn = (n: string): string[] => {
    const refs = queryRefs({ name: n, limit: UNBOUNDED_REF_LIMIT, rootDir })
    if (refs.length === 0) return []
    const scoped = fileHint !== undefined && n === name ? filterRefsForSymbol(refs, n, fileHint, getSyms) : refs
    const names = new Set<string>()
    for (const ref of scoped) {
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
  const noCallers = chains.length === 1 && chains[0]?.length === 1 && chains[0][0] === name
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredChains = matchesGrep !== undefined && !noCallers ? chains.filter((chain) => chain.some((n) => matchesGrep(n))) : chains

  if (opts.json === true) {
    const hiddenByGrep = chains.length - filteredChains.length
    const hiddenByExcludeTests = noCallers && opts.excludeTests === true ? suppressedCount : 0
    const refBlindKinds = noCallers ? refBlindRootKinds().blindKinds : []
    const blindRootPath = noCallers ? refBlindRootPath() : undefined
    const refBlindLanguage = blindRootPath !== undefined ? { language: detectLanguageOfFile(blindRootPath), definedIn: toDisplayPath(rootDir, blindRootPath) } : undefined
    emit(displaySafeJson({
      chains: filteredChains,
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      ...(hiddenByExcludeTests > 0 ? { hiddenByExcludeTests } : {}),
      ...(refBlindKinds.length > 0 ? { refBlindKinds } : {}),
      ...(refBlindLanguage !== undefined ? { refBlindLanguage } : {}),
    }))
    return 0
  }

  if (noCallers) {
    if (opts.excludeTests === true && suppressedCount > 0) {
      emit(`${name}  (no non-test callers; ${excludeTestsHiddenNote(suppressedCount)})`)
      return 0
    }
    const blindRoot = refBlindRootPath()
    if (blindRoot !== undefined) {
      emitErr(refBlindLanguageNotice(name, detectLanguageOfFile(blindRoot), toDisplayPath(rootDir, blindRoot)))
      emit(`${name}  (no callers recorded)`)
      return 0
    }
    const rootKinds = refBlindRootKinds()
    if (rootKinds.allBlind) {
      emitErr(refBlindKindNotice(name, rootKinds.blindKinds))
      emit(`${name}  (no callers recorded)`)
      return 0
    }
    emit(`${name}  (no callers)`)
    if (rootKinds.blindCount > 0) emitErr(refBlindKindPartialNote(name, rootKinds.blindKinds, rootKinds.blindCount, rootKinds.total))
    return 0
  }

  if (matchesGrep !== undefined && filteredChains.length === 0) {
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
  excludeTests?: boolean
  grep?: string
}

export function runImpact(opts: ImpactOptions): number {
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 20
  const DEPTH_CAP = 8
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const { name: rootName, file } = parseGraphSymbolSpec(opts.symbol)
  const fileHint = file !== undefined ? resolveIndexPath(file, rootDir) : undefined
  if (fileHint !== undefined && querySymbols({ name: rootName, filePath: fileHint, limit: 1 }).length === 0) {
    emitErr(`Symbol '${rootName}' not found in '${file}'`)
    return 1
  }

  const getSyms = buildFileSymCache()
  const hops = new Map<string, number>([[rootName, 0]])
  const queue: Array<[string, number]> = [[rootName, 0]]
  let suppressedCount = 0
  let depthCapped = 0

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    const [name, depth] = item
    if (depth >= DEPTH_CAP) { depthCapped += 1; continue }
    const refs = queryRefs({ name, limit: UNBOUNDED_REF_LIMIT, rootDir })
    const scoped = fileHint !== undefined && name === rootName ? filterRefsForSymbol(refs, name, fileHint, getSyms) : refs
    for (const ref of scoped) {
      if (opts.excludeTests === true && isTestFile(ref.filePath)) {
        suppressedCount += 1
        continue
      }
      const newHop = depth + 1
      const enc = enclosingSymbol(getSyms(ref.filePath), ref.line)
      if (enc === null) {
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
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const grepped = matchesGrep !== undefined ? allSorted.filter(([symbol]) => matchesGrep(symbol)) : allSorted
  const sorted = grepped.slice(0, top)

  if (depthCapped > 0) {
    emitErr(`Impact truncated at the ${DEPTH_CAP}-hop depth limit: ${depthCapped} symbol${depthCapped === 1 ? '' : 's'} at that depth ${depthCapped === 1 ? 'was' : 'were'} not expanded, so callers reachable only beyond ${DEPTH_CAP} hops are missing.`)
  }
  if (grepped.length > sorted.length) {
    emitErr(`Showing top ${sorted.length} of ${grepped.length} impacted symbols (raise --top to see the rest).`)
  }

  if (matchesGrep !== undefined && sorted.length === 0 && allSorted.length > 0) {
    if (opts.json === true) {
      emitErr(grepFilteredToEmptyNotice(allSorted.length, opts.grep as string, 'impacted symbol', 'impacted symbols'))
      emit(displaySafeJson([]))
      return 0
    }
    emit(grepFilteredToEmptyNotice(allSorted.length, opts.grep as string, 'impacted symbol', 'impacted symbols'))
    return 0
  }

  if (sorted.length === 0) {
    if (opts.excludeTests === true && suppressedCount > 0) {
      if (opts.json === true) {
        emit(displaySafeJson([]))
        return 1
      }
      emitErr(`No non-test impact found for '${opts.symbol}' (${excludeTestsHiddenNote(suppressedCount)})`)
      return 1
    }

    const defRows = querySymbols({ name: rootName, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    if (defRows.length === 0) {
      emitErr(`Symbol not found: ${opts.symbol}${unknownSymbolSuggestion(rootName, rootDir)}`)
      return 1
    }

    const defPaths = fileHint !== undefined ? [fileHint] : defRows.map((r) => r.filePath)
    const firstDefPath = defPaths[0]
    if (firstDefPath !== undefined && defPaths.every((fp) => !isRefIndexedFile(fp))) {
      emitErr(refBlindLanguageNotice(rootName, detectLanguageOfFile(firstDefPath), toDisplayPath(rootDir, firstDefPath)))
      return 1
    }

    const kindRows = fileHint !== undefined ? querySymbols({ name: rootName, filePath: fileHint, limit: REF_BLIND_DEF_PROBE_LIMIT }) : defRows
    const kindVerdict = refBlindKindVerdict(kindRows)
    if (kindVerdict.allBlind) {
      emitErr(refBlindKindNotice(rootName, kindVerdict.blindKinds))
      return 1
    }
    emitErr(`No callers found for '${opts.symbol}'`)
    if (kindVerdict.blindCount > 0) emitErr(refBlindKindPartialNote(rootName, kindVerdict.blindKinds, kindVerdict.blindCount, kindRows.length))
    return 1
  }

  if (opts.json === true) {
    emit(displaySafeJson(sorted.map(([symbol, h]) => ({ symbol, hops: h }))))
    return 0
  }

  const MODULE_SCOPE_PREFIX = '(module scope) '
  for (const [symbol, h] of sorted) {
    const displaySymbol = symbol.startsWith(MODULE_SCOPE_PREFIX)
      ? MODULE_SCOPE_PREFIX + toDisplayPath(rootDir, symbol.slice(MODULE_SCOPE_PREFIX.length))
      : symbol
    emit(`${displaySymbol}\t(hops: ${h})`)
  }
  return 0
}

// ---- ask (experimental) -----------------------------------------------------

export interface AskOptions {
  question: string
  top?: number
  json?: boolean
}

export function runAsk(opts: AskOptions): number {
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }
  const top = opts.top ?? 8
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const fetched = searchSymbolsFts(opts.question, top + 1, undefined, rootDir)
  const moreBeyondTop = fetched.length > top
  const hits = fetched.slice(0, top)
  if (moreBeyondTop) {
    emitErr(`Answer is grounded in the top ${countNoun(top, 'match', 'matches')}; more matched (raise --top to widen the evidence).`)
  }
  warnIfFilesStale(hits.map((h) => h.filePath))

  const BACKEND_ENV = 'TOKEN_GOAT_ASK_BACKEND'
  const backendLabel = process.env[BACKEND_ENV] ?? ''

  interface AskEntry { file: string; symbol: string; kind: string; line: number; readCmd: string }
  const entries: AskEntry[] = hits.map((h) => ({ file: h.filePath, symbol: h.name, kind: h.kind, line: h.lineStart, readCmd: `token-goat read "${h.filePath}::${h.name}@${h.lineStart}"` }))

  const degrade = (reason: string, extraNote?: string): number => {
    if (opts.json === true) {
      emit(displaySafeJson({ degraded: true, note: reason, ...(extraNote !== undefined ? { hint: extraNote } : {}), context: entries }))
      return 0
    }
    emit(`[degraded mode - ${reason}]`)
    if (extraNote !== undefined) emit(extraNote)
    for (const e of entries) emit(`token-goat read "${displaySafeText(toDisplayPath(rootDir, e.file))}::${displaySafeText(e.symbol)}@${e.line}"`)
    return 0
  }

  if (!backendLabel) return degrade(`set ${BACKEND_ENV}=claude|codex for LLM synthesis`)

  if (hits.length === 0) {
    if (isIndexEmptyForProject(globalDbPath(), rootDir)) return degrade(`${BACKEND_ENV}=${backendLabel} is set, but nothing is indexed for this project yet, so there is no context to answer from`, emptyIndexMessage(rootDir))
    return degrade(`${BACKEND_ENV}=${backendLabel} is set, but no indexed symbol matched this question, so there is no context to answer from -- try different wording or token-goat semantic`)
  }

  const isWin = process.platform === 'win32'
  const backendPath = resolveOnPath(backendLabel)

  if (!backendPath) return degrade(`${BACKEND_ENV}=${backendLabel} is set, but '${backendLabel}' was not found on PATH`)

  const rawContext = hits.map((h, i) => `[${i + 1}] ${h.filePath}\n${h.body ?? ''}`).join('\n\n')
  const context = fenceUntrustedFileContent(redactSecrets(rawContext).text)
  const prompt = `Answer the QUESTION using only the CODE SNIPPETS below.\nQUESTION: ${opts.question}\n\nSNIPPETS:\n${context}\n\nANSWER:`

  const isCodex = backendLabel === 'codex'
  let codexOutPath: string | null = null
  try {
    let askArgs: string[]
    if (isCodex) {
      codexOutPath = path.join(os.tmpdir(), `tg-ask-${process.pid}-${randomUUID()}.txt`)
      askArgs = ['exec', '--ephemeral', '--output-last-message', codexOutPath]
    } else {
      askArgs = ['--print', '--bare', '--no-session-persistence']
    }
    const needsShell = isWin && /\.(cmd|bat)$/i.test(backendPath)
    const command = [backendPath, ...askArgs].map(windowsCmdQuoteArg).join(' ')
    const result = needsShell
      ? spawnSync(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { input: prompt, encoding: 'utf8', timeout: 30000, windowsVerbatimArguments: true })
      : spawnSync(backendPath, askArgs, { input: prompt, encoding: 'utf8', timeout: 30000 })
    let answer = ''
    if (result.status === 0) {
      if (codexOutPath) {
        try { answer = fs.readFileSync(codexOutPath, 'utf8').trim() } catch { /* leave answer empty */ }
      } else {
        answer = result.stdout?.trim() ?? ''
      }
    }
    if (answer) {
      if (opts.json === true) {
        emit(displaySafeJson({ answer, context: entries }))
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

