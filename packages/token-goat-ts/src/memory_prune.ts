/**
 * Automatic pruning and analysis of Claude Code's native auto-memory store.
 *
 * The auto-memory store lives at `~/.claude/projects/<slug>/memory/`.
 * It uses a lazy-index pattern: `MEMORY.md` is a short one-line-per-entry index;
 * each fact lives in a sibling `*.md` file (YAML frontmatter + body).
 *
 * **What this module does automatically (safe, structural-only):**
 * - Remove index lines whose target `.md` file is absent (dead links).
 * - Remove duplicate index lines pointing to the same target file (keep first).
 *
 * **What it reports but never auto-edits:**
 * - Near-duplicate sibling bodies (via embedding cosine similarity or Jaccard).
 * - Exact-duplicate lines / sections inside `CLAUDE.md` files.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { estimateTokens } from './compact.js'
import { atomicWriteText } from './util.js'

// Entry regex: matches markdown link entries in MEMORY.md.
const ENTRY_RE = /^\s*-\s*\[(?<title>[^\]]+)\]\((?<target>[^)]+?\.md)\)/

/**
 * One parsed line from MEMORY.md.
 */
export interface IndexEntry {
  raw: string
  title: string
  target: string
  lineno: number
}

/**
 * Parse MEMORY.md text into passthrough lines and entries.
 *
 * Returns `[passthrough, entries]` where passthrough is a list of
 * `[lineno, raw_line]` tuples for lines that are NOT index entries
 * (headers, blank lines, freeform notes). These are preserved verbatim.
 */
export function parseIndex(text: string): [Array<[number, string]>, IndexEntry[]] {
  const passthrough: Array<[number, string]> = []
  const entries: IndexEntry[] = []
  if (!text) return [passthrough, entries]

  // Split preserving newlines (matches Python splitlines(keepends=True))
  const lines: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (char === '\n') {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)

  for (let lineno = 0; lineno < lines.length; lineno++) {
    const rawLine = lines[lineno]!

    const m = ENTRY_RE.exec(rawLine)
    if (m?.groups) {
      const title = m.groups['title']
      const target = m.groups['target']
      if (title && target) {
        entries.push({
          raw: rawLine,
          title,
          target,
          lineno,
        })
        continue
      }
    }
    passthrough.push([lineno, rawLine])
  }

  return [passthrough, entries]
}

/**
 * Result of a `pruneIndex()` call.
 */
export interface PruneResult {
  removedDead: IndexEntry[]
  removedDup: IndexEntry[]
  kept: number
  changed: boolean
  tokensSaved: number
}

/**
 * Read MEMORY.md, drop dead-link and exact-dup-target entries, rewrite atomically.
 *
 * `memoryDir` is the directory containing MEMORY.md and its siblings.
 * When `dryRun` is true the file is never written; the returned result still
 * reflects what *would* have been removed.
 *
 * Returns `PruneResult(changed=false)` when the file is absent, unreadable,
 * or already clean. Never throws — caller decides on logging.
 */
export function pruneIndex(memoryDir: string, opts?: { dryRun?: boolean }): PruneResult {
  const result: PruneResult = {
    removedDead: [],
    removedDup: [],
    kept: 0,
    changed: false,
    tokensSaved: 0,
  }

  const memoryMd = path.join(memoryDir, 'MEMORY.md')

  let text: string
  try {
    text = fs.readFileSync(memoryMd, 'utf-8')
  } catch {
    return result
  }

  const [passthrough, entries] = parseIndex(text)

  const seenTargets = new Set<string>()
  const keep: IndexEntry[] = []
  const dead: IndexEntry[] = []
  const dups: IndexEntry[] = []

  for (const entry of entries) {
    const targetPath = path.join(memoryDir, entry.target)
    if (!fs.existsSync(targetPath)) {
      dead.push(entry)
    } else if (seenTargets.has(entry.target)) {
      dups.push(entry)
    } else {
      seenTargets.add(entry.target)
      keep.push(entry)
    }
  }

  result.removedDead = dead
  result.removedDup = dups
  result.kept = keep.length
  result.changed = dead.length > 0 || dups.length > 0
  result.tokensSaved = estimateTokens(
    dead.map((e) => e.raw).join('') + dups.map((e) => e.raw).join(''),
  )

  if (!result.changed || opts?.dryRun) {
    return result
  }

  // Reconstruct in original line order by merging passthrough + kept entries.
  const lineMap = new Map<number, string>()
  for (const [lineno, rawLine] of passthrough) {
    lineMap.set(lineno, rawLine)
  }
  for (const entry of keep) {
    lineMap.set(entry.lineno, entry.raw)
  }

  // Sort by original line number and join.
  const sortedKeys = Array.from(lineMap.keys()).sort((a, b) => a - b)
  let reconstructed = sortedKeys.map((k) => lineMap.get(k)).join('')

  // Ensure trailing newline.
  if (reconstructed && !reconstructed.endsWith('\n')) {
    reconstructed += '\n'
  }

  try {
    atomicWriteText(memoryMd, reconstructed)
  } catch {
    result.changed = false
  }

  return result
}

/**
 * Jaccard similarity between two strings (token-set, whitespace-tokenised, lowercased).
 */
function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/))
  const tb = new Set(b.toLowerCase().split(/\s+/))

  if (ta.size === 0 && tb.size === 0) return 1.0
  if (ta.size === 0 || tb.size === 0) return 0.0

  const intersection = new Set([...ta].filter((x) => tb.has(x)))
  const union = new Set([...ta, ...tb])

  return intersection.size / union.size
}

/**
 * Return description + first ~500 body chars for similarity comparison.
 */
function siblingSnippet(filePath: string): string {
  let text: string
  try {
    text = fs.readFileSync(filePath, { encoding: 'utf-8' })
  } catch {
    return ''
  }

  // Strip YAML frontmatter (--- ... ---) to get the body.
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      const body = text.slice(end + 4).trimStart()
      const fm = text.slice(3, end)

      let desc = ''
      for (const line of fm.split('\n')) {
        if (line.startsWith('description:')) {
          desc = line.slice(12).trim().replace(/^["']|["']$/g, '')
          break
        }
      }

      return `${desc} ${body.slice(0, 500)}`.trim()
    }
    return text.slice(0, 500)
  }

  return text.slice(0, 500)
}

/**
 * A group of memory files with highly similar content.
 */
export interface DupCluster {
  members: string[]
  similarity: number
  method: 'embedding' | 'jaccard'
  tokens: number
}

/**
 * Return clusters of sibling memory files with similar content.
 *
 * Uses embedding cosine similarity when available; falls back to
 * Jaccard >= 0.60 (cruder, flag-only). Pure: never mutates any file.
 */
export async function findContentDuplicates(
  memoryDir: string,
  _opts?: { threshold?: number },
): Promise<DupCluster[]> {
  // threshold is intentionally unused; kept for API compatibility
  // const threshold = _opts?.threshold ?? 0.92

  const siblings = fs
    .readdirSync(memoryDir)
    .filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'memory.md')
    .map((name) => path.join(memoryDir, name))
    .sort()

  if (siblings.length < 2) {
    return []
  }

  const snippets = siblings.map((p) => siblingSnippet(p))

  // Try embedding path (not implemented in this port; skip gracefully).
  // Jaccard fallback.
  const JACCARD_THRESHOLD = 0.60
  const clusters: DupCluster[] = []
  const used = new Set<number>()

  for (let i = 0; i < siblings.length; i++) {
    if (used.has(i)) continue

    const group: number[] = [i]
    for (let j = i + 1; j < siblings.length; j++) {
      if (used.has(j)) continue

      const sim = jaccard(snippets[i]!, snippets[j]!)
      if (sim >= JACCARD_THRESHOLD) {
        group.push(j)
      }
    }

    if (group.length > 1) {
      const members = group.map((k) => siblings[k]!)
      const tok = group.reduce((sum, k) => sum + estimateTokens(snippets[k]!), 0)

      let maxSim = 0
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) {
          const sim = jaccard(snippets[group[a]!]!, snippets[group[b]!]!)
          maxSim = Math.max(maxSim, sim)
        }
      }

      clusters.push({
        members,
        similarity: Math.round(maxSim * 1000) / 1000,
        method: 'jaccard',
        tokens: tok,
      })
      for (const idx of group) {
        used.add(idx)
      }
    }
  }

  return clusters
}

/**
 * Audit findings for a single CLAUDE.md file.
 */
export interface ClaudeMdReport {
  path: string
  tokens: number
  exactDupLines: Array<[number, number, string]>
  dupSections: Array<[string, number[]]>
  crossFileOverlaps: string[]
}

/**
 * Return duplicate-line and duplicate-section findings across CLAUDE.md files.
 *
 * Report-only: never edits any file.
 */
export function auditClaudeMd(files: string[]): ClaudeMdReport[] {
  const reports: ClaudeMdReport[] = []
  const allLines: Array<[string, number, string]> = []

  for (const filePath of files) {
    let text: string
    try {
      text = fs.readFileSync(filePath, { encoding: 'utf-8' })
    } catch {
      continue
    }

    const lines = text.split('\n')
    const tokens = estimateTokens(text)
    const exactDups: Array<[number, number, string]> = []
    const dupSections: Array<[string, number[]]> = []

    // Exact duplicate non-blank lines within this file.
    const seenLines = new Map<string, number>()
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i]!.trim()
      if (!stripped) continue

      if (seenLines.has(stripped)) {
        const firstLine = seenLines.get(stripped)!
        exactDups.push([firstLine, i, stripped])
      } else {
        seenLines.set(stripped, i)
      }
    }

    // Duplicate headings (## / ###).
    const seenHeadings = new Map<string, number[]>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.startsWith('##')) {
        const heading = line.trim()
        if (!seenHeadings.has(heading)) {
          seenHeadings.set(heading, [])
        }
        seenHeadings.get(heading)!.push(i)
      }
    }

    for (const [heading, lnos] of seenHeadings) {
      if (lnos.length > 1) {
        dupSections.push([heading, lnos])
      }
    }

    reports.push({
      path: filePath,
      tokens,
      exactDupLines: exactDups,
      dupSections,
      crossFileOverlaps: [],
    })

    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i]!.trim()
      if (stripped) {
        allLines.push([filePath, i, stripped])
      }
    }
  }

  // Cross-file overlaps: non-blank lines that appear verbatim in >1 file.
  const lineToFiles = new Map<string, Set<string>>()
  for (const [filePath, _i, stripped] of allLines) {
    if (!lineToFiles.has(stripped)) {
      lineToFiles.set(stripped, new Set())
    }
    lineToFiles.get(stripped)!.add(filePath)
  }

  for (const report of reports) {
    const overlaps: string[] = []

    for (const [stripped, filesSet] of lineToFiles) {
      if (filesSet.has(report.path) && filesSet.size > 1) {
        const others = Array.from(filesSet)
          .filter((p) => p !== report.path)
          .map((p) => path.basename(p))

        if (others.length > 0) {
          if (stripped.length > 60) {
            overlaps.push(
              `${JSON.stringify(stripped.slice(0, 60))}… also in ${others.join(', ')}`,
            )
          } else {
            overlaps.push(`${JSON.stringify(stripped)} also in ${others.join(', ')}`)
          }
        }
      }
    }

    report.crossFileOverlaps = overlaps.slice(0, 10)
  }

  return reports
}
