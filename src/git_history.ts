import { runGit } from './util.js'

/**
 * Entry in a git commit history.
 */
export interface CommitEntry {
  readonly commitShort: string
  readonly summary: string
  readonly authorTs: number
}

/**
 * Entry in a git blame result.
 */
export interface BlameEntry {
  readonly lineNo: number
  readonly commitHash: string
  readonly author: string
  readonly date: string
  readonly content: string
}

/**
 * Entry in a changed-symbols result.
 */
export interface ChangedSymbolEntry {
  readonly file: string
  readonly symbol: string
  readonly linesAdded: number
  readonly linesRemoved: number
}

/**
 * Get recent commits from the repository.
 *
 * Runs `git log --format=...` and returns the last N commits.
 * Fail-soft: returns [] on any error.
 */
export function getRecentCommits(n: number = 10, cwd?: string): CommitEntry[] {
  try {
    const result = runGit(
      [
        'log',
        `-n${n}`,
        '--format=%H%n%s%n%at',
        '--no-merges',
      ],
      cwd ? { cwd } : {},
    )
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return parseCommitLog(result.stdout)
  } catch {
    return []
  }
}

/**
 * Parse git log output into CommitEntry[].
 *
 * Expects format: %H (hash), %s (subject), %at (author timestamp),
 * separated by newlines per commit.
 */
function parseCommitLog(raw: string): CommitEntry[] {
  const commits: CommitEntry[] = []
  const lines = raw.split('\n').filter(l => l.length > 0)

  for (let i = 0; i < lines.length; i += 3) {
    if (i + 2 >= lines.length) break
    const fullHash = lines[i]
    const summary = lines[i + 1]
    const tsStr = lines[i + 2]

    if (!fullHash || !summary || !tsStr || summary.length < 6) {
      continue
    }

    const ts = parseInt(tsStr, 10)
    if (!isFinite(ts)) {
      continue
    }

    commits.push({
      commitShort: fullHash.slice(0, 12),
      summary: summary.slice(0, 200),
      authorTs: ts,
    })
  }

  return commits
}

/**
 * Get files changed between two refs.
 *
 * Runs `git diff --name-only <ref>` and returns the list of changed files.
 * Fail-soft: returns [] on error.
 */
export function getChangedFilesSince(ref: string, cwd?: string): string[] {
  try {
    const result = runGit(['diff', '--name-only', ref], cwd ? { cwd } : {})
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return result.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
  } catch {
    return []
  }
}

/**
 * Parse git blame --porcelain output into BlameEntry[].
 *
 * Porcelain format repeats per line:
 *   <hash> <orig_line> <result_line> [<count>]
 *   author <name>
 *   author-time <unix_ts>
 *   ... (other fields)
 *   \t<content>
 *
 * Consecutive lines from the same commit reuse the previously seen metadata.
 */
function parseBlamePortalain(raw: string, startLine: number): BlameEntry[] {
  const entries: BlameEntry[] = []
  const lines = raw.split('\n')

  const commitCache: Record<string, Record<string, string>> = {}
  let currentHash = ''
  let currentMeta: Record<string, string> = {}
  let currentLineNo = startLine

  const blameHeaderRe = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) {
      i++
      continue
    }

    const m = blameHeaderRe.exec(line)
    if (m && m[1] && m[2]) {
      currentHash = m[1]
      currentLineNo = parseInt(m[2], 10)
      if (currentHash in commitCache) {
        currentMeta = commitCache[currentHash] || {}
      } else {
        currentMeta = {}
        commitCache[currentHash] = currentMeta
      }
      i++
      continue
    }

    if (line && line.startsWith('author ') && !line.startsWith('author-')) {
      currentMeta['author'] = line.slice(7)
      i++
      continue
    }

    if (line && line.startsWith('author-time ')) {
      try {
        const ts = parseInt(line.slice(12).trim(), 10)
        const dateStr = new Date(ts * 1000).toISOString().split('T')[0]
        if (dateStr) {
          currentMeta['date'] = dateStr
        }
      } catch {
        currentMeta['date'] = ''
      }
      i++
      continue
    }

    if (line && line.startsWith('\t')) {
      const content = line.slice(1)
      entries.push({
        lineNo: currentLineNo,
        commitHash: currentHash,
        author: currentMeta['author'] || '',
        date: currentMeta['date'] || '',
        content,
      })
      i++
      continue
    }

    i++
  }

  return entries
}

/**
 * Get git blame information for a file line range.
 *
 * Runs `git blame -L<start>,<end> --porcelain <file>` and parses the result.
 * Fail-soft: returns [] on error.
 */
export function getBlame(
  filePath: string,
  startLine: number,
  endLine: number,
  cwd?: string,
): BlameEntry[] {
  try {
    const result = runGit(
      ['blame', `-L${startLine},${endLine}`, '--porcelain', filePath],
      cwd ? { cwd } : {},
    )
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return parseBlamePortalain(result.stdout, startLine)
  } catch {
    return []
  }
}

/**
 * Format a list of CommitEntry into a readable string.
 */
export function formatHistory(entries: CommitEntry[]): string {
  if (entries.length === 0) {
    return '(no commits)'
  }

  const now = Date.now() / 1000
  const lines = ['Recent commits:']

  for (const c of entries) {
    const ageDays = Math.floor((now - c.authorTs) / 86400)
    const ageStr = ageDays > 0 ? `${ageDays}d` : 'today'
    const summary = c.summary.slice(0, 72)
    const short = c.commitShort.slice(0, 8)
    lines.push(`  ${short} ${summary} (${ageStr})`)
  }

  return lines.join('\n')
}

/**
 * Format a list of BlameEntry into a readable string.
 */
export function formatBlame(entries: BlameEntry[]): string {
  if (entries.length === 0) {
    return '(no blame info)'
  }

  const lines: string[] = []
  let lastHash = ''

  for (const b of entries) {
    const short = b.commitHash.slice(0, 8)
    const hashStr = lastHash === b.commitHash ? '       ' : short
    lastHash = b.commitHash
    lines.push(
      `${b.lineNo.toString().padStart(4)} ${hashStr} ${b.author || 'unknown'} (${b.date}): ${b.content}`,
    )
  }

  return lines.join('\n')
}

/**
 * Parse git diff output to extract changed symbols from hunk headers.
 *
 * Returns symbols extracted from hunk context text (the optional 4th @@ section).
 * Fail-soft: returns [] on error.
 */
export function getChangedSymbols(
  repoRoot: string,
  sinceRef: string = 'HEAD~5',
  limit: number = 50,
): ChangedSymbolEntry[] {
  try {
    const result = runGit(['diff', '--unified=0', `${sinceRef}..HEAD`, '--', '*.ts', '*.js'], {
      cwd: repoRoot,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return parseChangedSymbols(result.stdout, limit)
  } catch {
    return []
  }
}

/**
 * Parse changed symbols from diff output.
 */
function parseChangedSymbols(raw: string, limit: number): ChangedSymbolEntry[] {
  const fileRe = /^\+\+\+ b\/(.+)$/
  const hunkRe = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@ ?(.*)$/

  const counts: Map<string, { linesAdded: number; linesRemoved: number }> = new Map()
  const keyOrder: string[] = []

  let currentFile: string | null = null

  for (const line of raw.split('\n')) {
    const mFile = fileRe.exec(line)
    if (mFile) {
      currentFile = mFile[1] || null
      continue
    }

    if (!currentFile) continue

    const mHunk = hunkRe.exec(line)
    if (!mHunk) continue

    const removedStr = mHunk[1]
    const addedStr = mHunk[2]
    const context = mHunk[3] || ''

    const linesRemoved = removedStr ? parseInt(removedStr, 10) : 1
    const linesAdded = addedStr ? parseInt(addedStr, 10) : 1

    const symbol = parseSymbolFromContext(context)
    if (!symbol) continue

    const key = `${currentFile}:${symbol}`
    if (!counts.has(key)) {
      counts.set(key, { linesAdded: 0, linesRemoved: 0 })
      keyOrder.push(key)
    }

    const entry = counts.get(key)
    if (entry) {
      entry.linesAdded += linesAdded
      entry.linesRemoved += linesRemoved
    }
  }

  const result: ChangedSymbolEntry[] = []
  for (const key of keyOrder) {
    if (result.length >= limit) break
    const colonIdx = key.lastIndexOf(':')
    const file = colonIdx === -1 ? key : key.slice(0, colonIdx)
    const symbol = colonIdx === -1 ? '' : key.slice(colonIdx + 1)
    const countsEntry = counts.get(key)
    if (countsEntry) {
      result.push({
        file,
        symbol,
        linesAdded: countsEntry.linesAdded,
        linesRemoved: countsEntry.linesRemoved,
      })
    }
  }

  result.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))
  return result
}

/**
 * Extract a symbol name from diff hunk context text.
 *
 * Strips parameter lists and language keywords.
 */
function parseSymbolFromContext(context: string): string | null {
  const raw = context.trim()
  if (!raw) {
    return null
  }

  const stripPrefixes = [
    'async function ',
    'function ',
    'async ',
    'const ',
    'let ',
    'var ',
    'export ',
    'class ',
  ]

  let namePart = (raw.split('(')[0] || '').split('{')[0]?.trim() || ''
  for (const kw of stripPrefixes) {
    if (namePart.startsWith(kw)) {
      namePart = namePart.slice(kw.length)
      break
    }
  }

  namePart = namePart.trim().replace(/:$/, '')
  return namePart.length > 0 ? namePart : null
}
