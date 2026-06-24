/**
 * Repo map: structured overview of tracked files and their top symbols.
 *
 * Simpler than the Python PageRank-based repomap: collects files via `git ls-files`,
 * queries symbols from the index for each file, and renders a summary with per-file
 * symbol lists. Compact mode respects a token budget by pruning low-symbol-count files.
 */

import * as path from 'path'
import { runGit } from './util.js'
import { querySymbols } from './index_reader.js'
import { estimateTokens, isNoisePath } from './compact.js'
import { detectLanguage } from './parser_types.js'

export interface RepoEntry {
  filePath: string
  language: string
  symbolCount: number
  topSymbols: Array<{ kind: string; name: string }>
}

/**
 * Get all tracked files from git, filtered to source files only.
 * Returns absolute paths on Windows, relative POSIX paths elsewhere.
 */
export function getTrackedFiles(cwd: string = process.cwd()): string[] {
  try {
    const result = runGit(['ls-files'], { cwd })
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((rel) => path.join(cwd, rel))
  } catch {
    return []
  }
}

/**
 * Build a RepoEntry list from tracked files.
 * Queries the index for each file's top symbols, filters noise paths.
 */
export function buildMap(cwd: string = process.cwd()): RepoEntry[] {
  const files = getTrackedFiles(cwd)
  const entries: RepoEntry[] = []

  for (const filePath of files) {
    if (isNoisePath(filePath)) continue

    const lang = detectLanguage(filePath)
    if (lang === 'unknown') continue

    const symbols = querySymbols({ filePath, limit: 8 })

    entries.push({
      filePath,
      language: lang,
      symbolCount: symbols.length,
      topSymbols: symbols.map((s) => ({ kind: s.kind, name: s.name })),
    })
  }

  return entries.sort((a, b) => b.symbolCount - a.symbolCount)
}

/**
 * Build a RepoEntry list respecting a token budget.
 * Prunes lowest-symbol-count files first when approaching maxTokens.
 */
export function buildCompactMap(maxTokens: number = 2000, cwd: string = process.cwd()): RepoEntry[] {
  const entries = buildMap(cwd)
  if (entries.length === 0) return []

  let usedTokens = 0
  const budgetReserve = Math.ceil(maxTokens * 0.1) // 10% reserve

  const filtered: RepoEntry[] = []

  for (const entry of entries) {
    const estimatedTokens = estimateTokens(JSON.stringify(entry))
    if (usedTokens + estimatedTokens + budgetReserve > maxTokens) {
      break
    }
    filtered.push(entry)
    usedTokens += estimatedTokens
  }

  return filtered
}

interface FormatOptions {
  compact?: boolean
  maxEntries?: number
}

/**
 * Format RepoEntry list to human-readable text block.
 * Compact mode omits symbol details.
 */
export function formatMap(entries: RepoEntry[], opts: FormatOptions = {}): string {
  if (entries.length === 0) {
    return '# Repo map\n(no tracked files)\n'
  }

  const lines: string[] = []
  const { compact = false, maxEntries } = opts

  lines.push(`# Repo map (${entries.length} file${entries.length === 1 ? '' : 's'})`)

  const langCounts: Record<string, number> = {}
  for (const e of entries) {
    langCounts[e.language] = (langCounts[e.language] ?? 0) + 1
  }

  const langSummary = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `${lang} ${n}`)
    .join(', ')

  lines.push(`Languages: ${langSummary || '(none)'}`)

  const shown = maxEntries ? entries.slice(0, maxEntries) : entries
  if (shown.length > 0) {
    lines.push('')
    lines.push('## Files')
    for (const e of shown) {
      const rel = path.relative(process.cwd(), e.filePath)
      if (compact) {
        lines.push(`- ${rel} (${e.language})`)
      } else {
        lines.push(`- ${rel}`)
        if (e.topSymbols.length > 0) {
          for (const sym of e.topSymbols) {
            lines.push(`  - ${sym.name} (${sym.kind})`)
          }
        }
      }
    }
  }

  return lines.join('\n')
}
