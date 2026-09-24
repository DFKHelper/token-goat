import * as fs from 'node:fs'

import { querySymbols } from './index_reader.js'
import { displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { resolveProjectRoot } from './project.js'
import { readFileText } from './read_commands.js'
import { parseYamlDocument } from './read_structured_data.js'
import { forEachSymbol } from './symbol_scan.js'
import { foldPath } from './util.js'

export const DIDYOUMEAN_LIMIT = 5
export const TYPO_TWO_EDIT_MIN_LEN = 8
export const TYPO_MAX_QUERY_LEN = 64
export const MIN_REVERSE_MATCH_LEN = 3
export const MIN_WORD_SIMILARITY_LEN = 3

export const STRUCTURED_MISS_MAX_BYTES = 128 * 1024
export const STRUCTURED_MISS_MAX_FILES = 12
export const STRUCTURED_MISS_MAX_NODES = 20_000

export function endsWithPathBoundary(full: string, suffix: string): boolean {
  if (!full.endsWith(suffix)) return false
  if (full.length === suffix.length) return true
  const boundaryChar = full[full.length - suffix.length - 1]
  return boundaryChar === '/' || boundaryChar === '\\'
}

export function sortByLengthCloseness(items: string[], query: string): string[] {
  return [...items].sort((a, b) => {
    const diff = Math.abs(a.length - query.length) - Math.abs(b.length - query.length)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  if (a === b) return true
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return false
    prev = cur
  }
  return (prev[b.length] ?? Number.MAX_SAFE_INTEGER) <= max
}

export function typoBudget(queryLen: number): number {
  return queryLen >= TYPO_TWO_EDIT_MIN_LEN ? 2 : 1
}

export function rankSimilarNames(candidates: string[], query: string): string[] {
  const queryLower = query.toLowerCase()
  const filtered = candidates.filter((c) => {
    const cLower = c.toLowerCase()
    return cLower.includes(queryLower) || (cLower.length >= MIN_REVERSE_MATCH_LEN && queryLower.includes(cLower))
  })
  if (filtered.length === 0 && queryLower.length <= TYPO_MAX_QUERY_LEN) {
    const budget = typoBudget(queryLower.length)
    const near = candidates.filter((c) => withinEditDistance(c.toLowerCase(), queryLower, budget))
    return sortByLengthCloseness([...new Set(near)], query)
  }
  return sortByLengthCloseness([...new Set(filtered)], query)
}

export function filterSimilarHeadings(available: string[], query: string): string[] {
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_WORD_SIMILARITY_LEN)
  const matched = available.filter((heading) => {
    const headingLower = heading.toLowerCase()
    if (headingLower.includes(queryLower)) return true
    if (queryLower.length >= MIN_WORD_SIMILARITY_LEN && queryLower.includes(headingLower)) return true
    if (queryWords.length === 0) return false
    const headingWords = headingLower.split(/[^a-z0-9]+/).filter((w) => w.length > 0)
    return queryWords.every((qw) => headingWords.some((hw) => hw.includes(qw)))
  })
  if (matched.length === 0 && queryWords.length > 0) {
    const near = available.filter((heading) => {
      const headingWords = heading.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0)
      return queryWords.some((qw) => qw.length <= TYPO_MAX_QUERY_LEN && headingWords.some((hw) => withinEditDistance(hw, qw, typoBudget(qw.length))))
    })
    return sortByLengthCloseness(near, query)
  }
  return sortByLengthCloseness(matched, query)
}

export function didYouMean(candidates: string[]): string {
  return didYouMeanLines(candidates).join('\n')
}

/** {@link didYouMean} as separate lines, for a CliError built from lines: its printer escapes a newline inside a line, so a suggestion passed as one joined string reaches stderr with a literal backslash-n before every candidate. */
export function didYouMeanLines(candidates: string[]): string[] {
  const unique = [...new Set(candidates)]
  if (unique.length === 0) return []
  const lines = ['Did you mean:']
  for (const c of unique.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - ${c}`)
  }
  if (unique.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${unique.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines
}

export function unknownSymbolSuggestion(name: string, rootDir: string): string {
  // Ranked over every name in the project rather than a capped page of rows: a near-name suggestion drawn from the alphabetically first slice of a large project proposes whatever happens to sort early, which reads as the closest match and points away from the real one. Only the distinct names are retained, so the cost is the project's vocabulary rather than its symbol count.
  const names = new Set<string>()
  forEachSymbol({ rootDir }, (s) => names.add(s.name))
  const candidates = rankSimilarNames([...names], name)
  return candidates.length > 0 ? `\n${didYouMean(candidates)}` : ''
}

export function formatBareNameSpecError(command: string, name: string, projectRoot?: string): string {
  const rootDir = projectRoot ?? resolveProjectRoot({ project: process.cwd() })
  const matches = querySymbols({ name, limit: 50, rootDir })
  const seen = new Set<string>()
  const specs: string[] = []
  for (const m of matches) {
    const spec = `${toDisplayPath(rootDir, m.filePath)}::${m.name}`
    if (seen.has(spec)) continue
    seen.add(spec)
    specs.push(spec)
  }
  if (specs.length === 0) {
    return `Invalid spec - expected "file::symbol", got: ${name}`
  }
  const lines = [`Not a file: '${displaySafeText(name)}'. Did you mean:`]
  for (const spec of specs.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - token-goat ${command} "${spec}"`)
  }
  if (specs.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${specs.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

export function formatCrossFileLead(command: string, name: string, excludeFilePath: string, projectRoot?: string): string {
  const rootDir = projectRoot ?? process.cwd()
  const matches = querySymbols({ name, limit: 50, rootDir })
  const excludeResolved = resolveIndexPath(excludeFilePath, rootDir)
  const seen = new Set<string>()
  const specs: string[] = []
  for (const m of matches) {
    if (foldPath(m.filePath) === foldPath(excludeResolved)) continue
    const spec = `${toDisplayPath(rootDir, m.filePath)}::${m.name}`
    if (seen.has(spec)) continue
    seen.add(spec)
    specs.push(spec)
  }
  if (specs.length === 0) return ''
  const firstSpec = specs[0]
  const lines = [`'${name}' is defined in ${firstSpec !== undefined ? firstSpec.split('::')[0] : ''}`]
  for (const spec of specs.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - token-goat ${command} "${spec}"`)
  }
  if (specs.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${specs.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

export function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end)
}

export function firstBodyLine(body: string): string {
  return body.split('\n').find((l) => l.trim() !== '') ?? ''
}

export function findStructuredKeyPath(name: string, filePaths: string[]): { filePath: string; dotPath: string; command: string } | null {
  let filesTried = 0
  for (const filePath of filePaths) {
    if (filesTried >= STRUCTURED_MISS_MAX_FILES) break
    const lower = filePath.toLowerCase()
    const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml')
    if (!isYaml && !lower.endsWith('.json')) continue
    let size: number
    try {
      size = fs.statSync(filePath).size
    } catch {
      continue
    }
    if (size > STRUCTURED_MISS_MAX_BYTES) continue
    filesTried += 1
    let data: unknown
    try {
      const text = readFileText(filePath)
      if (text === null) continue
      data = isYaml ? parseYamlDocument(text) : (JSON.parse(text) as unknown)
    } catch {
      continue
    }
    const dotPath = findKeyDotPath(data, name)
    if (dotPath !== null) return { filePath, dotPath, command: isYaml ? 'yaml-query' : 'json-query' }
  }
  return null
}

export function isDotPathSafeKey(key: string): boolean {
  return !key.includes('.') && !key.includes('[') && !key.includes(']')
}

export function findKeyDotPath(root: unknown, name: string): string | null {
  const queue: Array<{ value: unknown; prefix: string; depth: number; safe: boolean }> = [
    { value: root, prefix: '', depth: 0, safe: true },
  ]
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) break
    if (visited++ >= STRUCTURED_MISS_MAX_NODES) return null
    const { value, prefix, depth, safe } = node
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) queue.push({ value: value[i], prefix: `${prefix}[${i}]`, depth, safe })
      continue
    }
    if (value === null || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const keySafe = safe && isDotPathSafeKey(key)
      const childPath = prefix === '' ? key : `${prefix}.${key}`
      if (key === name && depth + 1 >= 2 && keySafe) return childPath
      queue.push({ value: child, prefix: childPath, depth: depth + 1, safe: keySafe })
    }
  }
  return null
}
