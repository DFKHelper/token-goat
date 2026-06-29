// Batch D — git filter family.
//
// Faithfully ported from the Python `bash_compress.py` git family:
// GitFilter (generic catch-all), GitLogFilter, GitDiffFilter,
// GitStatusVerboseFilter, GitBlameFilter, GitCommitFilter, GitPushFilter.
//
// Dispatch order in GIT_FILTERS: specific subcommand filters first, generic
// GitFilter last.  GitFilter remains the catch-all for every other git
// subcommand not claimed by a more specific filter.
//
// CRLF warning stripping runs via postNormalise on every stream before the
// per-subcommand compressor sees the text — the base class pipeline calls it
// after normalise() on both stdout and stderr.

import { ToolFilter } from './base.js'
import {
  ERROR_SIGNAL_RE,
  dedupeCombinedOutput,
  positionalArgs,
  splitBlocks,
  squeezeBlankLines,
} from './helpers.js'

// ---------------------------------------------------------------------------
// CRLF warning stripping (git.postNormalise)
// ---------------------------------------------------------------------------

// Modern git 2.37+: self-contained single-line warning
const _GIT_CRLF_MODERN_RE =
  /^warning: in the working copy of '.*', (?:LF will be replaced by CRLF|CRLF will be replaced by LF) the next time Git touches it\.?\r?$/m

// Legacy pre-2.37: header line
const _GIT_CRLF_WARNING_RE =
  /^warning: (?:LF will be replaced by CRLF|CRLF will be replaced by LF) in .*\.?\r?$/

// Legacy continuation line that follows the header
const _GIT_CRLF_CONTINUATION_RE =
  /^The file will have its original line endings in your working directory\.?\r?$/

/** Strip git LF/CRLF line-ending normalisation warnings from text. */
function _stripGitCrlfWarnings(text: string): string {
  if (
    !text.includes('will be replaced by') &&
    !text.includes('original line endings') &&
    !text.includes('next time Git touches it')
  ) {
    return text
  }
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]!
    if (_GIT_CRLF_MODERN_RE.test(line)) {
      i++
      continue
    }
    if (_GIT_CRLF_WARNING_RE.test(line)) {
      // Legacy pair: skip the header and its continuation if present.
      if (i + 1 < n && _GIT_CRLF_CONTINUATION_RE.test(lines[i + 1]!)) {
        i += 2
      } else {
        i++
      }
      continue
    }
    if (_GIT_CRLF_CONTINUATION_RE.test(line)) {
      i++
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Shared base: postNormalise strips CRLF warnings on every stream
// ---------------------------------------------------------------------------

abstract class GitBaseFilter extends ToolFilter {
  override readonly binaries = new Set(['git'])

  override postNormalise(text: string): string {
    return _stripGitCrlfWarnings(text)
  }
}

// ---------------------------------------------------------------------------
// Shared git regexes used across multiple filters
// ---------------------------------------------------------------------------

const _GIT_LOG_COMMIT_RE = /^commit [0-9a-f]{7,}/
const _GIT_DIFF_FILE_RE = /^diff --git /
const _GIT_DIFF_HUNK_RE = /^@@\s/
const _GIT_STATUS_HEADER_RE =
  /^(?:On branch|Your branch|Untracked files|Changes (?:not staged|to be committed):|Unmerged paths|Changes to be committed|nothing to commit)/

// ---------------------------------------------------------------------------
// GitLogFilter — "git log"
// ---------------------------------------------------------------------------

const _GIT_LOG_ONELINE_RE = /^[0-9a-f]{7,}\s/
const _GIT_LOG_MERGE_RE = /^Merge:/
const _GIT_LOG_AUTHOR_RE = /^Author:\s+(.+)/
const _GIT_LOG_DATE_RE = /^Date:\s+(.+)/

/** Simple log compression: keep first max_commits in full, summarise rest. */
function _compressGitLogSimple(stdout: string, stderr: string, maxCommits = 10): string {
  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
  if (!blocks.length) return stdout
  const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
  const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))
  if (commits.length <= maxCommits) return stdout
  const kept = commits.slice(0, maxCommits)
  const elided = commits.slice(maxCommits)
  const firstElided = (elided[0]!.split('\n', 1)[0] ?? '').slice(0, 80)
  const lastElided = (elided[elided.length - 1]!.split('\n', 1)[0] ?? '').slice(0, 80)
  const summary =
    `\n[token-goat: +${elided.length} earlier commits elided; ` +
    `oldest: ${lastElided}; first elided: ${firstElided}]`
  let text = (prelude ? prelude + '\n' : '') + kept.join('\n') + summary
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/** Collapse commits to one-liner summaries when there are more than 10. */
function _compressGitLogFull(stdout: string, stderr: string): string {
  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
  if (!blocks.length) return stdout
  const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
  const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))
  if (commits.length <= 10) return stdout

  const collapsed: string[] = []
  for (const block of commits) {
    const lines = block.split('\n')
    const hashLine = lines[0] ?? ''
    const merge = lines.find((ln) => _GIT_LOG_MERGE_RE.test(ln)) ?? ''
    let author = ''
    let dateStr = ''
    let subject = ''
    for (const ln of lines) {
      if (!author) {
        const m = _GIT_LOG_AUTHOR_RE.exec(ln)
        if (m) author = (m[1] ?? '').split('<')[0]!.trim()
      }
      if (!dateStr) {
        const m = _GIT_LOG_DATE_RE.exec(ln)
        if (m) dateStr = (m[1] ?? '').trim()
      }
      if (!subject && ln.startsWith('    ') && ln.trim()) {
        subject = ln.trim()
      }
    }
    const parts = [hashLine]
    if (merge) parts.push(merge)
    const detailParts: string[] = []
    if (author) detailParts.push(author)
    if (dateStr) detailParts.push(dateStr)
    if (subject) detailParts.push(`"${subject}"`)
    if (detailParts.length) parts.push('  ' + detailParts.join(' | '))
    collapsed.push(parts.join('\n'))
  }
  let text = (prelude ? prelude + '\n' : '') + collapsed.join('\n\n')
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/** Compress -p/--patch log: truncate large diff sections per commit. */
function _compressGitLogPatch(stdout: string, stderr: string): string {
  const MAX_PATCH_LINES = 30
  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
  if (!blocks.length) return stdout
  const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
  const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))

  const outBlocks: string[] = []
  for (const block of commits) {
    const lines = block.split('\n')
    const diffStart = lines.findIndex((ln) => _GIT_DIFF_FILE_RE.test(ln))
    if (diffStart === -1) {
      outBlocks.push(block)
      continue
    }
    const headerLines = lines.slice(0, diffStart)
    let diffLines = lines.slice(diffStart)
    if (diffLines.length > MAX_PATCH_LINES) {
      const elided = diffLines.length - MAX_PATCH_LINES
      diffLines = [
        ...diffLines.slice(0, MAX_PATCH_LINES),
        `--- patch: ${elided} lines omitted by token-goat ---`,
      ]
    }
    outBlocks.push([...headerLines, ...diffLines].join('\n'))
  }

  let text = (prelude ? prelude + '\n' : '') + outBlocks.join('\n')
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/** Compress --stat log: limit file list per commit block. */
function _compressGitLogStat(stdout: string, stderr: string): string {
  const MAX_STAT_FILES = 20
  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
  if (!blocks.length) return stdout
  const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
  const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))

  const outBlocks: string[] = []
  for (let block of commits) {
    const lines = block.split('\n')
    const statLines = lines.filter(
      (ln) => ln.includes(' | ') && (ln.includes('+') || ln.includes('-')),
    )
    if (statLines.length > MAX_STAT_FILES) {
      const elided = statLines.length - MAX_STAT_FILES
      const newLines: string[] = []
      let statIdx = 0
      let replaced = false
      for (const ln of lines) {
        if (ln.includes(' | ') && (ln.includes('+') || ln.includes('-'))) {
          if (statIdx < MAX_STAT_FILES) {
            newLines.push(ln)
          } else if (!replaced) {
            newLines.push(`[token-goat: +${elided} more stat lines omitted]`)
            replaced = true
          }
          statIdx++
        } else {
          newLines.push(ln)
        }
      }
      block = newLines.join('\n')
    }
    outBlocks.push(block)
  }

  let text = (prelude ? prelude + '\n' : '') + outBlocks.join('\n')
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/** Format-aware log compression: dispatch to the right strategy. */
function _compressGitLogEnhanced(stdout: string, stderr: string, argv: string[]): string {
  const flags = new Set(argv)

  // Detect --oneline / short format
  let isOneline =
    flags.has('--oneline') ||
    flags.has('--format=oneline') ||
    flags.has('--pretty=oneline') ||
    argv.some((a) => a.startsWith('--format=%h') || a.startsWith('--pretty=%h'))

  if (!isOneline) {
    const nonEmpty = stdout.split('\n').filter((ln) => ln.trim())
    if (nonEmpty.length > 0 && nonEmpty.slice(0, 5).every((ln) => _GIT_LOG_ONELINE_RE.test(ln))) {
      isOneline = true
    }
  }

  if (isOneline) {
    const ONELINE_CAP = 50
    const lines = stdout.split('\n').filter((ln) => ln.trim())
    let keptLines: string[]
    if (lines.length > ONELINE_CAP) {
      const elided = lines.length - ONELINE_CAP
      keptLines = [...lines.slice(0, ONELINE_CAP), `[token-goat: +${elided} more commits]`]
    } else {
      keptLines = lines
    }
    let out = keptLines.join('\n')
    if (stderr.trim()) out += '\n---\n' + stderr.replace(/\s+$/, '')
    return out
  }

  const isPatch = flags.has('-p') || flags.has('--patch') || flags.has('-u')
  if (isPatch) return _compressGitLogPatch(stdout, stderr)

  const isStat = flags.has('--stat') || flags.has('--shortstat') || flags.has('--name-status')
  if (isStat) return _compressGitLogStat(stdout, stderr)

  return _compressGitLogFull(stdout, stderr)
}

export class GitLogFilter extends GitBaseFilter {
  readonly name = 'git-log'
  override readonly subcommands = new Set(['log'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    return _compressGitLogEnhanced(stdout, stderr, argv)
  }
}

// ---------------------------------------------------------------------------
// GitDiffFilter — "git diff", "git show"
// ---------------------------------------------------------------------------

const _GIT_DIFF_BINARY_RE = /^Binary files? .+ (?:and .+ )?differ$/
const _GIT_DIFF_STAT_FILE_RE = /^\s+\S.*\|\s+\d+/
const _GIT_DIFF_STAT_SUMMARY_RE = /^\s*\d+ files? changed/
const _DIFF_STAT_DIR_ROLLUP_THRESHOLD = 20

function _isDiffAdd(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++')
}

function _isDiffRemove(line: string): boolean {
  return line.startsWith('-') && !line.startsWith('---')
}

/** Roll up per-file stat lines into per-directory summaries. */
function _diffStatDirRollup(statLines: string[]): string[] {
  const dirAdds = new Map<string, number>()
  const dirDels = new Map<string, number>()
  const dirCount = new Map<string, number>()

  for (const ln of statLines) {
    const stripped = ln.trimStart()
    if (!stripped.includes(' | ')) continue
    let pathPart = stripped.split(' | ')[0]!.trim()
    // Resolve rename notation: "old/path => new/path"
    if (pathPart.includes(' => ')) {
      pathPart = (pathPart.split(' => ').pop() ?? '').trim().replace(/^\{/, '').replace(/\}$/, '')
    }
    const topDir = pathPart.includes('/') ? pathPart.split('/')[0]! + '/' : '(root)'
    const statPart = stripped.includes(' | ') ? stripped.split(' | ').slice(1).join(' | ') : ''
    dirAdds.set(topDir, (dirAdds.get(topDir) ?? 0) + (statPart.match(/\+/g) ?? []).length)
    dirDels.set(topDir, (dirDels.get(topDir) ?? 0) + (statPart.match(/-/g) ?? []).length)
    dirCount.set(topDir, (dirCount.get(topDir) ?? 0) + 1)
  }

  const rollup: string[] = []
  for (const dir of [...dirAdds.keys()].sort()) {
    const n = dirCount.get(dir) ?? 0
    const a = dirAdds.get(dir) ?? 0
    const d = dirDels.get(dir) ?? 0
    rollup.push(`  ${dir} (${n} file${n !== 1 ? 's' : ''}, +${a}/-${d})`)
  }
  return rollup
}

/** Compress --stat diff output: roll up into directory groups when too many files. */
function _compressGitDiffStat(stdout: string, stderr: string, argv: string[]): string {
  const lines = stdout.split('\n')
  const statLines = lines.filter((ln) => _GIT_DIFF_STAT_FILE_RE.test(ln))
  const summaryLines = lines.filter((ln) => _GIT_DIFF_STAT_SUMMARY_RE.test(ln))
  const otherLines = lines.filter(
    (ln) => !_GIT_DIFF_STAT_FILE_RE.test(ln) && !_GIT_DIFF_STAT_SUMMARY_RE.test(ln),
  )

  let out: string
  if (statLines.length <= _DIFF_STAT_DIR_ROLLUP_THRESHOLD) {
    out = stdout
  } else {
    const hasPathspec = argv.includes('--')
    if (hasPathspec) {
      const HEAD_FILES = 10
      const elided = statLines.length - HEAD_FILES
      let adds = 0
      let dels = 0
      for (const ln of statLines.slice(HEAD_FILES)) {
        adds += (ln.match(/\+/g) ?? []).length
        dels += (ln.match(/-/g) ?? []).length
      }
      const keptStat = [
        ...statLines.slice(0, HEAD_FILES),
        ` [token-goat: +${elided} more files changed, +${adds} -${dels} lines]`,
      ]
      out = [...otherLines, ...keptStat, ...summaryLines].join('\n')
    } else {
      out = [...otherLines, ..._diffStatDirRollup(statLines), ...summaryLines].join('\n')
    }
  }

  if (stderr.trim()) out = out.replace(/\s+$/, '') + '\n---\n' + stderr.replace(/\s+$/, '')
  return out
}

/**
 * Detect whether a hunk is dominated by repetitive JSON dict lines.
 * True when ≥75% of added lines are valid JSON dicts with ≤5 distinct key-sets
 * and there are at least 8 valid lines.
 */
function _isRepetitiveJsonHunk(hunkLines: string[]): boolean {
  const added = hunkLines.filter(_isDiffAdd).map((ln) => ln.slice(1))
  if (added.length < 8) return false
  let valid = 0
  const keySets = new Set<string>()
  for (const line of added) {
    const stripped = line.trim()
    if (!stripped) continue
    try {
      const obj: unknown = JSON.parse(stripped)
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        valid++
        keySets.add(JSON.stringify(Object.keys(obj as Record<string, unknown>).sort()))
      }
    } catch {
      // not JSON
    }
  }
  if (valid < 8) return false
  return valid / added.length >= 0.75 && keySets.size <= 5
}

/**
 * Trim trailing context lines from a hunk, keeping at most maxTrail after
 * the last changed line. Returns [trimmedLines, nTrimmed].
 */
function _trimHunkTrailingContext(hunkLines: string[], maxTrail = 2): [string[], number] {
  let lastChanged = -1
  for (let i = 0; i < hunkLines.length; i++) {
    const ln = hunkLines[i]!
    if (ln.startsWith('+') || ln.startsWith('-')) lastChanged = i
  }
  if (lastChanged === -1) return [hunkLines, 0]
  const trailingContext = hunkLines.slice(lastChanged + 1).filter((ln) => ln.startsWith(' '))
  const nTrim = Math.max(0, trailingContext.length - maxTrail)
  if (nTrim === 0) return [hunkLines, 0]
  return [hunkLines.slice(0, lastChanged + 1 + maxTrail), nTrim]
}

/** Compress diff body: binary detection, large-hunk truncation, JSONL summarisation. */
function _compressGitDiffBody(stdout: string, stderr: string): string {
  const MAX_HUNK_CHANGED = 50
  const HUNK_HEAD_KEEP = 20
  const HUNK_TAIL_KEEP = 5

  const fileBlocks = splitBlocks(stdout, _GIT_DIFF_FILE_RE)
  if (!fileBlocks.length) return stdout

  const outBlocks: string[] = []
  for (const block of fileBlocks) {
    if (!_GIT_DIFF_FILE_RE.test(block)) {
      outBlocks.push(block)
      continue
    }

    const blockLines = block.split('\n')

    // Binary file: collapse to header + summary line.
    const binaryLine = blockLines.find((ln) => _GIT_DIFF_BINARY_RE.test(ln))
    if (binaryLine) {
      outBlocks.push((blockLines[0] ?? '') + '\n' + binaryLine)
      continue
    }

    // Large-hunk compression: split into hunks and compress each.
    const hunks = splitBlocks(block, _GIT_DIFF_HUNK_RE)
    if (hunks.length <= 1) {
      outBlocks.push(block)
      continue
    }

    const compressedHunks: string[] = []
    for (const hunk of hunks) {
      const hunkLines = hunk.split('\n')
      const changed = hunkLines.filter((ln) => ln.startsWith('+') || ln.startsWith('-'))
      if (changed.length > MAX_HUNK_CHANGED) {
        if (_isRepetitiveJsonHunk(hunkLines)) {
          const nAdded = hunkLines.filter(_isDiffAdd).length
          const nRemoved = hunkLines.filter(_isDiffRemove).length
          const sample = hunkLines.filter(_isDiffAdd).slice(0, 2)
          const parts = [`+${nAdded} JSON records added`]
          if (nRemoved) parts.push(`-${nRemoved} removed`)
          compressedHunks.push(
            (hunkLines[0] ?? '') +
              `\n[token-goat: repetitive JSON/JSONL block (${parts.join(', ')}); 2-line sample:]\n` +
              sample.join('\n') +
              '\n[use `token-goat bash-output <id>` for full content]',
          )
        } else {
          const head = hunkLines.slice(0, HUNK_HEAD_KEEP)
          const tail = hunkLines.slice(-HUNK_TAIL_KEEP)
          const omitted = hunkLines.length - HUNK_HEAD_KEEP - HUNK_TAIL_KEEP
          compressedHunks.push(
            head.join('\n') +
              `\n... ${omitted} lines omitted by token-goat ...\n` +
              tail.join('\n'),
          )
        }
      } else {
        const [trimmedLines, nTrimmed] = _trimHunkTrailingContext(hunkLines)
        if (nTrimmed > 0) {
          compressedHunks.push(
            trimmedLines.join('\n') +
              `\n[token-goat: ${nTrimmed} trailing context line(s) trimmed]`,
          )
        } else {
          compressedHunks.push(hunk)
        }
      }
    }
    outBlocks.push(compressedHunks.join('\n'))
  }

  let text = outBlocks.join('\n')
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/**
 * Simple diff compression for the generic GitFilter fallback.
 * Keeps first N hunks per file; for very large diffs (>200 files) emits a stat-only view.
 */
function _compressGitDiffSimple(stdout: string, stderr: string, maxHunksPerFile = 3): string {
  const fileBlocks = splitBlocks(stdout, _GIT_DIFF_FILE_RE)
  if (!fileBlocks.length) return stdout
  const realFiles = fileBlocks.filter((b) => _GIT_DIFF_FILE_RE.test(b))
  if (realFiles.length > 200) {
    const statLines = realFiles.map((b) => {
      const header = b.split('\n', 1)[0] ?? ''
      const lines = b.split('\n')
      const adds = lines.filter(_isDiffAdd).length
      const dels = lines.filter(_isDiffRemove).length
      return `${header}  +${adds} -${dels}`
    })
    return (
      `[token-goat: large diff (${realFiles.length} files); showing stat-only view]\n` +
      statLines.join('\n')
    )
  }
  const outBlocks: string[] = []
  for (const block of fileBlocks) {
    if (!_GIT_DIFF_FILE_RE.test(block)) {
      outBlocks.push(block)
      continue
    }
    const hunks = splitBlocks(block, _GIT_DIFF_HUNK_RE)
    if (hunks.length <= maxHunksPerFile + 1) {
      outBlocks.push(block)
      continue
    }
    const head = hunks.slice(0, maxHunksPerFile + 1)
    const elided = hunks.slice(maxHunksPerFile + 1)
    outBlocks.push(
      head.join('\n') + `\n[token-goat: +${elided.length} more hunks in this file elided]`,
    )
  }
  let text = outBlocks.join('\n')
  if (stderr.trim()) text += '\n---\n' + stderr.replace(/\s+$/, '')
  return text
}

/** Format-aware diff compression. */
function _compressGitDiffEnhanced(stdout: string, stderr: string, argv: string[]): string {
  const flags = new Set(argv)
  const isStat = flags.has('--stat') || flags.has('--shortstat') || flags.has('--name-only')
  if (isStat) return _compressGitDiffStat(stdout, stderr, argv)
  return _compressGitDiffBody(stdout, stderr)
}

export class GitDiffFilter extends GitBaseFilter {
  readonly name = 'git-diff'
  override readonly subcommands = new Set(['diff', 'show'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    return _compressGitDiffEnhanced(stdout, stderr, argv)
  }
}

// ---------------------------------------------------------------------------
// GitStatusVerboseFilter — "git status"
// ---------------------------------------------------------------------------

const _SHORT_STATUS_RE = /^[MADRCU?! ][MADRCU?! ] /
const _GIT_STATUS_SECTION_RE =
  /^(Changes to be committed|Changes not staged for commit|Untracked files|Ignored files|Unmerged paths):/
const _GIT_STATUS_SECTION_KEYS: Record<string, string> = {
  'Changes to be committed': 'staged',
  'Changes not staged for commit': 'unstaged',
  'Untracked files': 'untracked',
  'Ignored files': 'ignored',
  'Unmerged paths': 'unmerged',
}
const _GIT_STATUS_ADVICE_RE =
  /^\s*\(use "git |^no changes added to commit|^nothing added to commit but untracked files present/

function _gitStatusIsShort(argv: string[] | null, lines: string[]): boolean {
  for (const tok of argv ?? []) {
    if (['-s', '--short', '--porcelain', '-z'].includes(tok)) return true
    if (tok.startsWith('--porcelain=')) return true
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('s')) return true
  }
  const nonEmpty = lines.filter((ln) => ln.trim())
  return nonEmpty.length > 0 && nonEmpty.slice(0, 5).every((ln) => _SHORT_STATUS_RE.test(ln))
}

function _gitStatusFileLabel(line: string, section: string): string {
  const body = line.trim()
  if (section === 'untracked' || section === 'ignored') return section
  if (body.includes(':')) return body.split(':')[0]!.trim()
  return section
}

function _compressGitStatusVerbose(
  stdout: string,
  stderr: string,
  argv: string[] | null = null,
): string {
  const lines = stdout.split('\n')
  if (!lines.length) return stdout

  if (_gitStatusIsShort(argv, lines)) {
    let out = stdout
    if (stderr.trim()) out = out.replace(/\s+$/, '') + '\n---\n' + stderr.replace(/\s+$/, '')
    return out
  }

  const kept: string[] = []
  let section: string | null = null
  let counts: Record<string, number> = {}

  function flush(): void {
    if (section !== null && section !== 'unmerged' && Object.keys(counts).length) {
      const parts = Object.entries(counts).map(([label, n]) => `${n} ${label}`)
      kept.push('\t' + parts.join(', '))
    }
    counts = {}
  }

  for (const line of lines) {
    const headerMatch = _GIT_STATUS_SECTION_RE.exec(line)
    if (headerMatch) {
      flush()
      section = _GIT_STATUS_SECTION_KEYS[headerMatch[1]!] ?? null
      kept.push(line)
      continue
    }
    if (_GIT_STATUS_ADVICE_RE.test(line)) continue
    if (section !== null && line.startsWith('\t') && line.trim()) {
      if (section === 'unmerged') {
        kept.push(line)
      } else {
        const label = _gitStatusFileLabel(line, section)
        counts[label] = (counts[label] ?? 0) + 1
      }
      continue
    }
    flush()
    section = null
    kept.push(line)
  }
  flush()

  let out = squeezeBlankLines(kept.join('\n'))
  if (stderr.trim()) out = out.replace(/\s+$/, '') + '\n---\n' + stderr.replace(/\s+$/, '')
  return out
}

export class GitStatusVerboseFilter extends GitBaseFilter {
  readonly name = 'git-status'
  override readonly subcommands = new Set(['status'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    return _compressGitStatusVerbose(stdout, stderr, argv)
  }
}

// ---------------------------------------------------------------------------
// GitBlameFilter — "git blame"
// ---------------------------------------------------------------------------

const _GIT_BLAME_AUTHOR_RE = /^\^?([0-9a-f]{7,40})\s+\(([^)]+?)\s+\d{4}-\d\d-\d\d/
const _GIT_BLAME_PORCELAIN_RE = /^[0-9a-f]{40} \d+ \d+/
const _GIT_BLAME_PORCELAIN_HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/
const _GIT_BLAME_AUTHOR_LINE_RE = /^author (.+)/

/** Collapse same-commit consecutive runs in annotated blame output. */
function _compressGitBlameAnnotated(lines: string[], stderr: string): string {
  const out: string[] = []
  let currentHash: string | null = null
  let currentAuthor: string | null = null
  let runCount = 0
  let runStartLine = ''

  function flushRun(): void {
    if (runCount === 0) return
    out.push(runStartLine)
    if (runCount > 1) {
      const hashShort = currentHash ? currentHash.slice(0, 8) : '?'
      out.push(`[token-goat: ${runCount - 1} more lines by ${currentAuthor} (${hashShort})]`)
    }
  }

  for (const line of lines) {
    const m = _GIT_BLAME_AUTHOR_RE.exec(line)
    if (m) {
      const commitHash = (m[1] ?? '').slice(0, 8)
      const author = (m[2] ?? '').trim()
      if (commitHash === currentHash) {
        runCount++
      } else {
        flushRun()
        currentHash = commitHash
        currentAuthor = author
        runStartLine = line
        runCount = 1
      }
    } else {
      flushRun()
      currentHash = null
      currentAuthor = null
      runCount = 0
      runStartLine = ''
      out.push(line)
    }
  }
  flushRun()

  let outText = out.join('\n')
  if (stderr.trim()) outText += '\n---\n' + stderr.replace(/\s+$/, '')
  return outText
}

/** Collapse same-commit consecutive runs in porcelain blame output. */
function _compressGitBlamePorcelain(lines: string[], stderr: string): string {
  const out: string[] = []
  let currentHash: string | null = null
  let currentAuthor: string | null = null
  let runCount = 0
  let blockLines: string[] = []

  function flushBlock(): void {
    if (!blockLines.length) return
    out.push(...blockLines)
    if (runCount > 1) {
      const hashShort = currentHash ? currentHash.slice(0, 8) : '?'
      out.push(`[token-goat: ${runCount - 1} more lines by ${currentAuthor} (${hashShort})]`)
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const m = _GIT_BLAME_PORCELAIN_HEADER_RE.exec(line)
    if (m) {
      const commitHash = m[1]!
      if (commitHash === currentHash) {
        runCount++
        i++
        // Skip metadata + content line for continuation
        while (i < lines.length && !lines[i]!.startsWith('\t')) i++
        i++ // skip content line
        continue
      }
      // New commit: flush previous block
      flushBlock()
      currentHash = commitHash
      currentAuthor = null
      runCount = 1
      blockLines = [line]
      i++
      // Collect metadata lines until tab-prefixed content line
      while (i < lines.length && !lines[i]!.startsWith('\t')) {
        const meta = lines[i]!
        const am = _GIT_BLAME_AUTHOR_LINE_RE.exec(meta)
        if (am) currentAuthor = (am[1] ?? '').trim()
        blockLines.push(meta)
        i++
      }
      if (i < lines.length) {
        blockLines.push(lines[i]!)
        i++
      }
      continue
    }
    // Non-header line (shouldn't normally appear between commits, but pass through)
    flushBlock()
    blockLines = []
    currentHash = null
    currentAuthor = null
    runCount = 0
    out.push(line)
    i++
  }
  flushBlock()

  let outText = out.join('\n')
  if (stderr.trim()) outText += '\n---\n' + stderr.replace(/\s+$/, '')
  return outText
}

function _compressGitBlame(stdout: string, stderr: string): string {
  const lines = stdout.split('\n')
  if (!lines.length) return stdout
  const isPorcelain = lines.slice(0, 5).some((ln) => ln.trim() && _GIT_BLAME_PORCELAIN_RE.test(ln))
  if (isPorcelain) return _compressGitBlamePorcelain(lines, stderr)
  return _compressGitBlameAnnotated(lines, stderr)
}

export class GitBlameFilter extends GitBaseFilter {
  readonly name = 'git-blame'
  override readonly subcommands = new Set(['blame'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    return _compressGitBlame(stdout, stderr)
  }
}

// ---------------------------------------------------------------------------
// GitCommitFilter — "git commit"
// ---------------------------------------------------------------------------

const _LEFTHOOK_BANNER_RE = /lefthook/i
const _LEFTHOOK_PASS_RE = /[✔✓](?:️)?\s+(\S+)/
const _LEFTHOOK_FAIL_RE = /[✖✗✘]\s+(\S+)/
const _GIT_COMMIT_SUMMARY_RE = /^\[(\S+)\s+([0-9a-f]+)\]\s+(.+)$/
const _GIT_COMMIT_STAT_RE = /^\s*(\d+\s+files?\s+changed.*)/
const _DOT_LINE_RE = /^[.\s]+(?:\[\s*\d+%\])?$/

function _compressGitCommit(stdout: string, stderr: string): string {
  const merged = stderr.trim() ? stdout.replace(/\s+$/, '') + '\n' + stderr.replace(/\s+$/, '') : stdout

  // Use splitlines behaviour (handles both CRLF and LF)
  const lines = merged.split(/\r?\n/)
  const hasLefthook = lines.some((ln) => _LEFTHOOK_BANNER_RE.test(ln))

  // Extract always-useful commit summary lines.
  let commitLine = ''
  let statLine = ''
  for (const ln of lines) {
    if (!commitLine) {
      const m = _GIT_COMMIT_SUMMARY_RE.exec(ln.trim())
      if (m) commitLine = ln.trim()
    }
    if (!statLine) {
      const m2 = _GIT_COMMIT_STAT_RE.exec(ln)
      if (m2) statLine = (m2[1] ?? '').trim()
    }
  }

  if (!hasLefthook) {
    // No lefthook — output is already short; passthrough.
    return merged
  }

  // Detect hook failures and passes.
  const failHooks: string[] = []
  const passHooks: string[] = []
  for (const ln of lines) {
    const fm = _LEFTHOOK_FAIL_RE.exec(ln)
    if (fm) {
      failHooks.push(fm[1]!)
      continue
    }
    const pm = _LEFTHOOK_PASS_RE.exec(ln)
    if (pm) {
      const name = pm[1]!
      if (!passHooks.includes(name)) passHooks.push(name)
    }
  }

  if (failHooks.length) {
    // Keep the output but strip pure-dot progress lines.
    const kept = lines.filter((ln) => !_DOT_LINE_RE.test(ln))
    return kept.join('\n')
  }

  // All hooks passed — build one-line summary.
  const hookParts = passHooks.map((h) => `✔ ${h}`).join(' ')
  const parts: string[] = []
  if (hookParts) parts.push(`pre-commit ${hookParts}`)
  if (commitLine) parts.push(commitLine)
  if (statLine) parts.push(statLine)
  return parts.length ? parts.join(' | ') : merged
}

export class GitCommitFilter extends GitBaseFilter {
  readonly name = 'git-commit'
  override readonly subcommands = new Set(['commit'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    return _compressGitCommit(stdout, stderr)
  }
}

// ---------------------------------------------------------------------------
// GitPushFilter — "git push"
// ---------------------------------------------------------------------------

const _GIT_PUSH_REF_RE = /^\s*(?:To\s|->|\+|\*|!|\s+[0-9a-f]+\.\.[0-9a-f]+)/
const _GIT_PUSH_TRACK_RE = /^Branch\s+'[^']+'\s+set\s+up\s+to\s+track/
const _GIT_REMOTE_PROGRESS_RE =
  /^remote:\s+(?:Resolving deltas|Enumerating objects|Counting objects|Compressing objects|Writing objects):\s+\d+%/
const _GIT_LOCAL_PROGRESS_RE =
  /^(?:Enumerating objects|Counting objects|Compressing objects|Writing objects):\s+\d+%/
const _GIT_REMOTE_BLANK_RE = /^remote:\s*$/
const _PREPUSH_HOOK_TRIGGER_RE =
  /^\s*(?:>\s+|❯\s+|\$\s+)?(?:lefthook|husky|pre-commit|simple-git-hooks)\b|^\s*>\s+\S+@/i

const _BUNDLER_SIGNATURE_RE = new RegExp(
  [
    String.raw`^\s*vite\s+v[\d.]+`,
    String.raw`building for production`,
    String.raw`modules?\s+transformed`,
    String.raw`rendering chunks`,
    String.raw`computing gzip size`,
    String.raw`transforming\s*\(`,
    String.raw`^\s*webpack\s+\d[\d.]+\s+compiled`,
    String.raw`^\s*(?:Asset|asset)\s+\S+\s+\d`,
    String.raw`^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b`,
    String.raw`gzip:\s*[\d.]+\s*(?:k|m|g)?i?b`,
    String.raw`^\s*[⚡✨]?\s*esbuild`,
  ].join('|'),
  'i',
)

const _BUNDLER_NOISE_RE = new RegExp(
  [
    String.raw`building for production`,
    String.raw`^\s*[✓√]?\s*\d+\s+modules?\s+transformed`,
    String.raw`rendering chunks`,
    String.raw`computing gzip size`,
    String.raw`^\s*transforming\s*\(`,
    String.raw`^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b`,
    String.raw`^\s+\./node_modules/`,
    String.raw`^\s*modules by path`,
    String.raw`^\s+\+\s+\d+\s+modules?\s*$`,
    String.raw`^\s*runtime modules\s`,
  ].join('|'),
  'i',
)

const _BUNDLER_DONE_RE = new RegExp(
  [
    String.raw`^\s*[✓√]\s+built in\s`,
    String.raw`^\s*webpack\s+\d[\d.]+\s+compiled\s+successfully`,
    String.raw`^\s*[⚡✨]\s+Done in\s`,
  ].join('|'),
  'i',
)

const _PYTEST_DOT_LINE_RE = /^[.sF ]+(?:\[\s*\d+%\])?$/
const _PYTEST_SUMMARY_RE =
  /(\d+\s+(?:failed|passed|error(?:ed)?|warning)[,\s].*?(?:in\s+[\d:]+[smh.]+)?)/i

/** Collapse repeated remote/local percentage-progress lines; keep only final per stage. */
function _compressGitPushRemoteProgress(lines: string[]): string[] {
  const result: string[] = []
  let currentStage = ''
  let stageLastLine = ''

  function flushStage(): void {
    if (stageLastLine) result.push(stageLastLine)
    currentStage = ''
    stageLastLine = ''
  }

  for (const ln of lines) {
    const stripped = ln.trimEnd()
    if (_GIT_REMOTE_PROGRESS_RE.test(stripped) || _GIT_LOCAL_PROGRESS_RE.test(stripped)) {
      const m = /^(?:remote:\s+)?(\w[\w ]+?):\s+\d+%/.exec(stripped)
      const stage = m ? m[1]!.trim() : '?'
      if (stage !== currentStage) {
        flushStage()
        currentStage = stage
      }
      stageLastLine = stripped
    } else if (_GIT_REMOTE_BLANK_RE.test(stripped)) {
      flushStage()
      // Drop blank "remote:" lines — visual padding.
    } else {
      flushStage()
      result.push(stripped)
    }
  }
  flushStage()
  return result
}

/** Collapse pre-push bundler noise (vite/webpack/esbuild) into a single summary line. */
function _compressGitPushBundler(lines: string[]): string[] {
  if (!lines.some((ln) => _BUNDLER_SIGNATURE_RE.test(ln))) return lines

  const result: string[] = []
  let suppressed = 0

  function flushSuppressed(): void {
    if (suppressed > 0) {
      result.push(`[pre-push hook: bundler output suppressed — ${suppressed} line${suppressed !== 1 ? 's' : ''}]`)
      suppressed = 0
    }
  }

  for (const ln of lines) {
    const stripped = ln.trimEnd()
    if (
      _GIT_PUSH_REF_RE.test(stripped) ||
      _GIT_PUSH_TRACK_RE.test(stripped) ||
      _PREPUSH_HOOK_TRIGGER_RE.test(stripped) ||
      _BUNDLER_DONE_RE.test(stripped)
    ) {
      flushSuppressed()
      result.push(stripped)
      continue
    }
    if (ERROR_SIGNAL_RE.test(stripped) && !_BUNDLER_NOISE_RE.test(stripped)) {
      flushSuppressed()
      result.push(stripped)
      continue
    }
    if (_BUNDLER_NOISE_RE.test(stripped) || _BUNDLER_SIGNATURE_RE.test(stripped)) {
      suppressed++
      continue
    }
    if (!stripped) {
      if (suppressed > 0) {
        suppressed++
        continue
      }
      result.push(stripped)
      continue
    }
    flushSuppressed()
    result.push(stripped)
  }
  flushSuppressed()
  return result
}

function _compressGitPush(stdout: string, stderr: string): string {
  const merged = stderr.trim() ? stdout.replace(/\s+$/, '') + '\n' + stderr.replace(/\s+$/, '') : stdout
  // splitlines() behaviour: handles both CRLF and LF
  let lines = merged.split(/\r?\n/)

  const hasDotLines = lines.some((ln) => _PYTEST_DOT_LINE_RE.test(ln))
  const hasRemoteProgress = lines.some(
    (ln) =>
      _GIT_REMOTE_PROGRESS_RE.test(ln.trimEnd()) || _GIT_LOCAL_PROGRESS_RE.test(ln.trimEnd()),
  )
  const hasBundler = lines.some((ln) => _BUNDLER_SIGNATURE_RE.test(ln))

  if (!hasDotLines && !hasRemoteProgress && !hasBundler) return merged

  if (hasRemoteProgress) {
    lines = _compressGitPushRemoteProgress(lines)
  }
  if (hasBundler) {
    lines = _compressGitPushBundler(lines)
  }

  // Re-check for pytest dots after remote/bundler compression.
  const dotLines = lines.filter((ln) => _PYTEST_DOT_LINE_RE.test(ln))
  if (!dotLines.length) return lines.join('\n')

  // Extract pytest summary line (last match wins).
  let pytestSummary = ''
  for (const ln of lines) {
    if (_PYTEST_DOT_LINE_RE.test(ln)) continue
    const m = _PYTEST_SUMMARY_RE.exec(ln)
    if (m) {
      const lnLower = ln.toLowerCase()
      if (lnLower.includes('passed') || lnLower.includes('failed')) {
        pytestSummary = ln.trim()
      }
    }
  }

  const pushLines = lines
    .filter((ln) => _GIT_PUSH_REF_RE.test(ln) || _GIT_PUSH_TRACK_RE.test(ln))
    .map((ln) => ln.trim())

  const failed = pytestSummary ? pytestSummary.toLowerCase().includes('failed') : false

  if (failed) {
    const kept: string[] = []
    let inError = false
    let errorLinesKept = 0
    const MAX_ERROR_LINES = 30
    for (const ln of lines) {
      if (_PYTEST_DOT_LINE_RE.test(ln)) continue
      if (ln.includes('FAILED') || ln.includes('ERROR') || ERROR_SIGNAL_RE.test(ln)) {
        inError = true
      }
      if (inError && errorLinesKept < MAX_ERROR_LINES) {
        kept.push(ln)
        errorLinesKept++
      } else if (!inError) {
        kept.push(ln)
      }
    }
    const prefix = pytestSummary ? `pre-push FAILED: ${pytestSummary}` : 'pre-push FAILED'
    return prefix + '\n' + kept.join('\n')
  }

  // All tests passed — build 1-2 line summary.
  const parts: string[] = []
  if (pytestSummary) parts.push(`pre-push ✔ ${pytestSummary}`)
  if (pushLines.length) parts.push('pushed ' + pushLines.join(' | '))
  return parts.length ? parts.join('\n') : lines.join('\n')
}

export class GitPushFilter extends GitBaseFilter {
  readonly name = 'git-push'
  override readonly subcommands = new Set(['push'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    return _compressGitPush(stdout, stderr)
  }
}

// ---------------------------------------------------------------------------
// GitFilter — generic catch-all for all other git subcommands
// ---------------------------------------------------------------------------

/** Simple git status truncation: keep first 30 file lines, summarise rest. */
function _compressGitStatus(stdout: string, stderr: string): string {
  const lines = stdout.split('\n')
  const out: string[] = []
  let keptFiles = 0
  const bucket: Record<string, number> = {}
  for (const line of lines) {
    if (_GIT_STATUS_HEADER_RE.test(line) || !line.trim() || line.startsWith('\t(')) {
      out.push(line)
      continue
    }
    if (line.startsWith('\t') || line.startsWith('        ')) {
      keptFiles++
      if (keptFiles <= 30) {
        out.push(line)
      } else {
        const kind = _gitStatusKind(line)
        bucket[kind] = (bucket[kind] ?? 0) + 1
      }
      continue
    }
    out.push(line)
  }
  if (Object.keys(bucket).length) {
    const total = Object.values(bucket).reduce((a, b) => a + b, 0)
    const summary = Object.entries(bucket)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')
    out.push(`[token-goat: +${total} more files: ${summary}]`)
  }
  if (stderr.trim()) out.push('---', stderr.replace(/\s+$/, ''))
  return out.join('\n')
}

function _gitStatusKind(line: string): string {
  const stripped = line.trim()
  if (stripped.startsWith('modified:')) return 'modified'
  if (stripped.startsWith('new file:')) return 'new'
  if (stripped.startsWith('deleted:')) return 'deleted'
  if (stripped.startsWith('renamed:')) return 'renamed'
  if (stripped.startsWith('typechange:')) return 'typechange'
  return 'other'
}

/** Truncate a listing (ls-files, ls-tree) to first N lines. */
function _truncateListing(stdout: string, stderr: string, head = 100): string {
  const lines = stdout.split('\n')
  let merged: string
  if (lines.length <= head) {
    merged = stdout
  } else {
    merged =
      lines.slice(0, head).join('\n') +
      `\n[token-goat: +${lines.length - head} more lines elided]`
  }
  if (stderr.trim()) merged += '\n---\n' + stderr.replace(/\s+$/, '')
  return merged
}

const _GIT_REMOTE_DROP_RE =
  /^(?:remote: (?:Counting|Compressing|Total|Enumerating|Receiving|Resolving) objects|Receiving objects:|Resolving deltas:|Unpacking objects:|Updating files:)/

/** Drop remote: counting/compressing progress lines; keep ref updates and errors. */
function _compressGitRemote(stdout: string, stderr: string): string {
  const mergedLines = [
    ...stdout.split('\n'),
    ...(stderr.trim() ? ['---', ...stderr.split('\n')] : []),
  ]
  const kept: string[] = []
  let dropped = 0
  for (const line of mergedLines) {
    if (_GIT_REMOTE_DROP_RE.test(line)) {
      dropped++
      continue
    }
    kept.push(line)
  }
  if (dropped) kept.push(`[token-goat: dropped ${dropped} 'remote:' progress lines]`)
  return kept.join('\n')
}

export class GitFilter extends GitBaseFilter {
  readonly name = 'git'
  // No subcommands set — matches any git command as catch-all.

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    const positionals = positionalArgs(argv.slice(1))
    const subcommand = positionals[0] ?? ''
    if (subcommand === 'status') return _compressGitStatus(stdout, stderr)
    if (subcommand === 'log') return _compressGitLogSimple(stdout, stderr)
    if (subcommand === 'diff' || subcommand === 'show')
      return _compressGitDiffSimple(stdout, stderr)
    if (subcommand === 'ls-files' || subcommand === 'ls-tree')
      return _truncateListing(stdout, stderr, 100)
    if (
      subcommand === 'fetch' ||
      subcommand === 'pull' ||
      subcommand === 'push' ||
      subcommand === 'clone'
    )
      return _compressGitRemote(stdout, stderr)
    // Fallback: ANSI/progress already stripped; dedupe consecutive identical lines.
    return dedupeCombinedOutput(this.combineOutput(stdout, stderr))
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Ordered filter array for git: specific subcommand filters first, generic
 * GitFilter last as catch-all.  Spread into TOOL_FILTERS after linters.
 */
export const GIT_FILTERS: ToolFilter[] = [
  new GitLogFilter(),
  new GitDiffFilter(),
  new GitStatusVerboseFilter(),
  new GitBlameFilter(),
  new GitCommitFilter(),
  new GitPushFilter(),
  new GitFilter(),
]
