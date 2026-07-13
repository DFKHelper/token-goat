// Shell / file-tool filter family (Batch H): grep/rg, ls/eza/tree/fd, wc, bat, delta, fzf, lazygit, jq, yq, curl/wget, rsync, diff, ffmpeg, xxd/hexdump, file, ps/top.
//
// Ported faithfully from the Python bash_compress.py shell/file family. Dispatch ordering note: RgFilter must precede GrepFilter — both claim `rg`/`grep`, but RgFilter's matches() only claims commands that carry a context flag (-A/-B/-C/--context) for its context-line stripping; GrepFilter is the catch-all for plain rg/grep matches plus ag/ack/egrep/fgrep and git grep. LsFilter must precede EzaFilter — both claim `ls` and `eza` but LsFilter applies simpler truncation while EzaFilter provides richer tree/column-aware compression.

import { ToolFilter } from './base.js'
import { loadConfig } from '../config.js'
import {
  headTailCompress,
  maybeNote,
  normalise,
  pathStem,
  positionalArgs,
  compressTestOutput,
} from './helpers.js'
import { stripAnsiCodes } from '../bash_compress.js'

// ---------------------------------------------------------------------------
// Grep / rg constants
// ---------------------------------------------------------------------------

const _GREP_COMPRESS_THRESHOLD = 30
const _GREP_MAX_FILE_LINES = 20

// ---------------------------------------------------------------------------
// GrepFilter
// ---------------------------------------------------------------------------

export class GrepFilter extends ToolFilter {
  readonly name = 'grep'
  override readonly binaries = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ack-grep'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0] ?? '').toLowerCase()
    if (this.binaries.has(stem)) return true
    // git grep (two-token form)
    if (stem === 'git') {
      const pos = positionalArgs(argv.slice(1))
      return pos.length > 0 && pos[0] === 'grep'
    }
    return false
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const text = this.combineOutput(stdout, stderr)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= _GREP_COMPRESS_THRESHOLD) return text

    const fileCounts = new Map<string, number>()
    let unattributed = 0
    for (const line of nonEmpty) {
      if (line.startsWith('Binary file ') && line.includes(' matches')) {
        const fname = line.slice('Binary file '.length).replace(/ matches$/, '')
        fileCounts.set(fname, (fileCounts.get(fname) ?? 0) + 1)
        continue
      }
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        const candidate = line.slice(0, colonIdx)
        if (candidate.includes('.') || candidate.includes('/') || candidate.includes('\\')) {
          fileCounts.set(candidate, (fileCounts.get(candidate) ?? 0) + 1)
          continue
        }
      }
      unattributed++
    }

    const totalMatches = [...fileCounts.values()].reduce((a, b) => a + b, 0) + unattributed
    const numFiles = fileCounts.size
    const outLines: string[] = [`grep: ${totalMatches} matches across ${numFiles} file(s)`]

    const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1])
    const shown = sorted.slice(0, _GREP_MAX_FILE_LINES)
    for (const [fname, count] of shown) {
      outLines.push(`  ${fname}: ${count} match(es)`)
    }
    if (sorted.length > _GREP_MAX_FILE_LINES) {
      const remaining = sorted.length - _GREP_MAX_FILE_LINES
      outLines.push(
        `  [token-goat: +${remaining} more file(s) elided; use --context or -C flags to narrow]`,
      )
    }
    if (unattributed) {
      outLines.push(`  (unattributed lines: ${unattributed})`)
    }
    outLines.push(
      `[token-goat: grep output compressed from ${nonEmpty.length} lines` +
        ` to ${outLines.length} — disable via TOKEN_GOAT_BASH_COMPRESS]`,
    )
    const result = outLines.join('\n')
    return this.finalize([result])
  }
}

// ---------------------------------------------------------------------------
// RgFilter — context-line suppressor for rg/grep -C/-A/-B output
// ---------------------------------------------------------------------------

const _RG_CONTEXT_THRESHOLD = 30
const _RG_TOP_GROUPS = 5
const _RG_GROUP_THRESHOLD = 10

export class RgFilter extends ToolFilter {
  readonly name = 'rg'
  override readonly binaries = new Set(['rg', 'grep'])

  private static readonly _SEP = '--'
  private static readonly _CTX_LINE_RE = /^.+-\d+-/
  private static readonly _MATCH_LINE_RE = /^.+:\d+:/

  private static _parseContextDepth(argv: string[]): number {
    let depth = 0
    const longFlags = new Set(['--after-context', '--before-context', '--context'])
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!
      if ((a === '-A' || a === '-B' || a === '-C' || longFlags.has(a)) && i + 1 < argv.length) {
        const v = parseInt(argv[i + 1]!, 10)
        if (!isNaN(v)) depth = Math.max(depth, v)
        i++
        continue
      }
      for (const short of ['-A', '-B', '-C']) {
        if (a.startsWith(short) && a.length > 2) {
          const v = parseInt(a.slice(2), 10)
          if (!isNaN(v)) depth = Math.max(depth, v)
        }
      }
    }
    return depth
  }

  private static _isFilesOnly(argv: string[]): boolean {
    return argv.some(a => a === '-l' || a === '--files-with-matches')
  }

  private static _isCountOnly(argv: string[]): boolean {
    return argv.some(a => a === '-c' || a === '--count')
  }

  /** True when argv carries an actual context flag (-A/-B/-C/--[after|before]-context/--context, short or long form). */
  private static _hasContextFlags(argv: string[]): boolean {
    const longFlags = ['--after-context', '--before-context', '--context']
    for (const a of argv) {
      if (a === '-A' || a === '-B' || a === '-C') return true
      if (/^-[ABC]\d+$/.test(a)) return true
      if (longFlags.some((f) => a === f || a.startsWith(f + '='))) return true
    }
    return false
  }

  // RgFilter only handles context-block output (-A/-B/-C/--context); a plain
  // grep/rg with no context flags falls through to GrepFilter's per-file
  // match-count summarizer, which produces dramatically smaller output.
  override matches(argv: string[]): boolean {
    if (!super.matches(argv)) return false
    return RgFilter._hasContextFlags(argv)
  }

  private _compressGroups(groups: string[]): string {
    const scored = groups
      .map((g, i) => ({
        i,
        score: g.split('\n').filter(l => RgFilter._MATCH_LINE_RE.test(l)).length,
      }))
      .sort((a, b) => b.score - a.score)
    const topIdx = new Set(scored.slice(0, _RG_TOP_GROUPS).map(x => x.i))
    const kept = groups.filter((_, i) => topIdx.has(i))
    const suppressed = groups.length - kept.length
    const joined = kept.join('\n' + RgFilter._SEP + '\n')
    return (
      joined +
      `\n[token-goat: ${suppressed} more match groups suppressed — rerun with -l for filenames only]`
    )
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const text = this.combineOutput(stdout, stderr)
    if (RgFilter._isFilesOnly(argv) || RgFilter._isCountOnly(argv)) return text
    const lines = text.split('\n')
    if (lines.length <= _RG_CONTEXT_THRESHOLD) return text
    if (!lines.some(l => l === RgFilter._SEP)) return text

    const groups = text.split('\n' + RgFilter._SEP + '\n').filter(g => g.trim())
    if (groups.length > _RG_GROUP_THRESHOLD) return this._compressGroups(groups)

    const kept: string[] = []
    let suppressed = 0
    for (const ln of lines) {
      if (
        ln === RgFilter._SEP ||
        (RgFilter._CTX_LINE_RE.test(ln) && !RgFilter._MATCH_LINE_RE.test(ln))
      ) {
        suppressed++
      } else {
        kept.push(ln)
      }
    }
    if (suppressed === 0) return text
    kept.push(
      `[token-goat: ${suppressed} context lines suppressed` +
        ` — rerun with -l for filenames only or without -C/-A/-B for matches only]`,
    )
    return kept.join('\n')
  }
}

// ---------------------------------------------------------------------------
// LsFilter — basic line-count truncation for ls/dir listings
// ---------------------------------------------------------------------------

const _LS_PASSTHROUGH = 25
const _LS_MAX_ENTRIES = 10
const _LS_HIDDEN_MARKER =
  '[token-goat: {n} more entries — use eza --tree or ls | grep PATTERN to filter]'
const _LS_HIDDEN_MARKER_EXT = '[token-goat: {n} more entries — by type: {ext_summary}]'

function _lsExtFromLine(line: string): string | null {
  const stripped = line.trimEnd()
  if (stripped.endsWith('/')) return null
  const parts = stripped.split(/\s+/)
  if (!parts.length) return null
  const firstPart = parts[0] ?? ''
  if (firstPart && firstPart[0] === 'd') return null
  const fname = (parts[parts.length - 1] ?? '').replace(/\/$/, '')
  const dotIdx = fname.lastIndexOf('.')
  if (dotIdx <= 0) return ''
  return fname.slice(dotIdx).toLowerCase()
}

function _lsExtSummary(entries: string[], topN = 4): string {
  const extCounts = new Map<string, number>()
  let otherCount = 0
  for (const ln of entries) {
    const ext = _lsExtFromLine(ln)
    if (ext === null) continue
    if (!ext) {
      otherCount++
    } else {
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
    }
  }
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, topN)
  const parts = top.map(([ext, cnt]) => `${ext}×${cnt}`)
  const sumTop = top.reduce((a, [, c]) => a + c, 0)
  const remaining = [...extCounts.values()].reduce((a, b) => a + b, 0) - sumTop + otherCount
  if (remaining > 0) parts.push(`other×${remaining}`)
  return parts.join(' ')
}

// Windows `dir` banner lines ("Volume in drive C is ...", " Directory of C:\...")
// and the trailing "N File(s)/Dir(s) ... bytes free" summary don't look like
// Unix `ls` entries at all; recognize them so they aren't folded into the
// entry list or dropped by truncation.
const _DIR_EXE_BANNER_RE = /^\s*(?:Volume in drive \S+ (?:is|has no label)|Volume Serial Number is|Directory of)/i
const _DIR_EXE_SUMMARY_RE = /^\s*\d[\d,]*\s+(?:File|Dir)\(s\)/i
const _DIR_EXE_DIR_ENTRY_RE = /<DIR>/

export class LsFilter extends ToolFilter {
  readonly name = 'ls'
  override readonly binaries = new Set(['ls', 'll', 'dir'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split(/\r?\n/)
    if (lines.length <= _LS_PASSTHROUGH) return merged
    if (LsFilter._isDirExeOutput(lines)) return this._compressDirExe(lines)
    return this._splitAndCompress(lines)
  }

  private static _isDirExeOutput(lines: string[]): boolean {
    return lines.some(l => _DIR_EXE_BANNER_RE.test(l)) && lines.some(l => _DIR_EXE_SUMMARY_RE.test(l))
  }

  private _compressDirExe(lines: string[]): string {
    const bannerIdx = new Set<number>()
    const summaryIdx = new Set<number>()
    const entryIdx: number[] = []
    lines.forEach((l, i) => {
      if (_DIR_EXE_BANNER_RE.test(l)) bannerIdx.add(i)
      else if (_DIR_EXE_SUMMARY_RE.test(l)) summaryIdx.add(i)
      else if (l.trim()) entryIdx.push(i)
    })

    if (entryIdx.length <= _LS_MAX_ENTRIES) return lines.join('\n')

    const entrySet = new Set(entryIdx)
    const keptEntryIdx = new Set(entryIdx.slice(0, _LS_MAX_ENTRIES))
    const hiddenCount = entryIdx.length - keptEntryIdx.size
    const fileEntries = entryIdx
      .map(i => lines[i]!)
      .filter(l => !_DIR_EXE_DIR_ENTRY_RE.test(l))
    const extPart = _lsExtSummary(fileEntries)
    const hiddenMarker = extPart
      ? _LS_HIDDEN_MARKER_EXT.replace('{n}', String(hiddenCount)).replace('{ext_summary}', extPart)
      : _LS_HIDDEN_MARKER.replace('{n}', String(hiddenCount))

    const out: string[] = []
    let hiddenMarkerEmitted = false
    for (let i = 0; i < lines.length; i++) {
      if (bannerIdx.has(i) || summaryIdx.has(i)) {
        out.push(lines[i]!)
      } else if (keptEntryIdx.has(i)) {
        out.push(lines[i]!)
      } else if (entrySet.has(i) && !hiddenMarkerEmitted) {
        out.push(hiddenMarker)
        hiddenMarkerEmitted = true
      }
    }
    return out.join('\n')
  }

  private static _isSectionHeader(line: string): boolean {
    const stripped = line.trimEnd()
    if (!stripped || !stripped.endsWith(':')) return false
    if (stripped[0] !== undefined && '-dlcbps'.includes(stripped[0])) return false
    const token = stripped.slice(0, -1)
    return !/\s/.test(token.trim())
  }

  private static _compressOneSection(lines: string[]): string[] {
    const out: string[] = []
    let entries: string[]
    if (lines.length && lines[0]!.trimStart().startsWith('total ')) {
      out.push(lines[0]!)
      entries = lines.slice(1)
    } else {
      entries = lines
    }
    if (entries.length <= _LS_MAX_ENTRIES) {
      out.push(...entries)
      return out
    }
    out.push(...entries.slice(0, _LS_MAX_ENTRIES))
    const hidden = entries.length - _LS_MAX_ENTRIES
    const extPart = _lsExtSummary(entries)
    if (extPart) {
      out.push(_LS_HIDDEN_MARKER_EXT.replace('{n}', String(hidden)).replace('{ext_summary}', extPart))
    } else {
      out.push(_LS_HIDDEN_MARKER.replace('{n}', String(hidden)))
    }
    return out
  }

  private _splitAndCompress(lines: string[]): string {
    type Section = { header: string | null; lines: string[] }
    const sections: Section[] = []
    let curHeader: string | null = null
    let curLines: string[] = []

    for (const ln of lines) {
      if (LsFilter._isSectionHeader(ln)) {
        sections.push({ header: curHeader, lines: curLines })
        curHeader = ln
        curLines = []
      } else {
        curLines.push(ln)
      }
    }
    sections.push({ header: curHeader, lines: curLines })

    const out: string[] = []
    for (const { header, lines: sec } of sections) {
      if (header !== null) out.push(header)
      const nonBlank = sec.filter(l => l.trim())
      if (!nonBlank.length) continue
      out.push(...LsFilter._compressOneSection(nonBlank))
    }
    return out.join('\n')
  }
}

// ---------------------------------------------------------------------------
// EzaFilter — tree / flat-listing compression for eza/exa/ls
// ---------------------------------------------------------------------------

const _EZA_PASSTHROUGH = 30
const _HEADER_KEYWORDS = new Set(['permission', 'size', 'date', 'user', 'name'])
const _SUMMARY_KEYWORDS = ['director', 'file', 'total']

export class EzaFilter extends ToolFilter {
  readonly name = 'eza'
  override readonly binaries = new Set(['eza', 'exa', 'ls'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= _EZA_PASSTHROUGH) return text

    const isTree = argv.some(a => a === '--tree' || a.startsWith('--tree='))
    if (isTree) return this._compressTree(nonEmpty)
    return this._compressFlatListing(nonEmpty, argv)
  }

  private _compressTree(nonEmpty: string[]): string {
    if (nonEmpty.length <= 60) return nonEmpty.join('\n').trimEnd()
    return headTailCompress(nonEmpty, 40, 10, 'items').trimEnd()
  }

  private _compressFlatListing(nonEmpty: string[], _argv: string[]): string {
    if (nonEmpty.length <= _EZA_PASSTHROUGH) return nonEmpty.join('\n').trimEnd()

    let headerIdx = 0
    if (nonEmpty.length && [..._HEADER_KEYWORDS].some(kw => (nonEmpty[0] ?? '').toLowerCase().includes(kw))) {
      headerIdx = 1
    }

    const kept: string[] = []
    if (headerIdx > 0) kept.push(...nonEmpty.slice(0, headerIdx))

    const dataLines = nonEmpty.slice(headerIdx)
    if (dataLines.length > 30) {
      const compressed = headTailCompress(dataLines, 25, 5, 'entries')
      kept.push(...compressed.split('\n'))
    } else {
      kept.push(...dataLines)
    }

    const summaryLines = nonEmpty
      .slice(Math.max(0, nonEmpty.length - 3))
      .filter(l => _SUMMARY_KEYWORDS.some(kw => l.includes(kw)))
    for (const sl of summaryLines) {
      if (!kept.includes(sl)) kept.push(sl)
    }

    return kept.join('\n').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// TreeFilter — directory-tree depth collapsing
// ---------------------------------------------------------------------------

const _TREE_PASSTHROUGH = 30

export class TreeFilter extends ToolFilter {
  readonly name = 'tree'
  override readonly binaries = new Set(['tree'])

  private _detect(lines: string[]): boolean {
    return lines.slice(0, 10).some(l => l.includes('├──') || l.includes('└──'))
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split(/\r?\n/)
    if (lines.length <= _TREE_PASSTHROUGH) return merged
    if (!this._detect(lines)) return merged
    return this._compressTree(lines)
  }

  private static _treeDepthAndPrefix(line: string): { depth: number; prefix: string } {
    for (const connector of ['├── ', '└── ']) {
      const idx = line.indexOf(connector)
      if (idx >= 0) return { depth: Math.floor(idx / 4), prefix: line.slice(0, idx) }
    }
    return { depth: -1, prefix: '' }
  }

  private _compressTree(lines: string[]): string {
    const body = [...lines]
    let summary = ''
    if (body.length && /^\d+ director/.test((body[body.length - 1] ?? '').trim())) {
      summary = body.pop()!
    }

    const out: string[] = []
    let pendingCount = 0
    let pendingPrefix = ''

    const flush = () => {
      if (pendingCount) {
        out.push(`${pendingPrefix}└── [${pendingCount} items]`)
        pendingCount = 0
        pendingPrefix = ''
      }
    }

    for (const line of body) {
      const { depth, prefix } = TreeFilter._treeDepthAndPrefix(line)
      if (depth < 0) {
        flush()
        out.push(line)
      } else if (depth <= 1) {
        flush()
        out.push(line)
      } else {
        if (!pendingPrefix) pendingPrefix = prefix
        pendingCount++
      }
    }
    flush()
    if (summary) out.push(summary)
    return out.join('\n')
  }
}

// ---------------------------------------------------------------------------
// FdFilter — file-search output (fd/fdfind/find)
// ---------------------------------------------------------------------------

const _FD_COMPRESS_THRESHOLD = 40

export class FdFilter extends ToolFilter {
  readonly name = 'fd'
  override readonly binaries = new Set(['fd', 'fdfind', 'find'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= _FD_COMPRESS_THRESHOLD) return text.trimEnd()
    return headTailCompress(nonEmpty, 35, 5, 'paths')
  }
}

// ---------------------------------------------------------------------------
// WcFilter — normalise wc output (lstrip alignment whitespace)
// ---------------------------------------------------------------------------

export class WcFilter extends ToolFilter {
  readonly name = 'wc'
  override readonly binaries = new Set(['wc'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const stripped = text.split(/\r?\n/).map(l => l.trimStart())
    return stripped.join('\n').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// BatFilter — strip bat borders/decorations, head/tail compress
// ---------------------------------------------------------------------------

const _BAT_BORDER_CHARS = new Set('─━─┬┴┌┐└┘│├┤┼═╔╗╚╝║╠╡╢╣╤╥╦╧╨╩')

function _stripBatBorders(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const s = line.trim()
    if (s && [...s].every(c => _BAT_BORDER_CHARS.has(c))) continue
    out.push(line)
  }
  // Remove first/last blank or border-hint lines
  if (out.length && ((out[0] ?? '').trim() === '' || (out[0] ?? '').includes('──'))) out.shift()
  if (out.length && ((out[out.length - 1] ?? '').trim() === '' || (out[out.length - 1] ?? '').includes('──')))
    out.pop()
  return out
}

export class BatFilter extends ToolFilter {
  readonly name = 'bat'
  override readonly binaries = new Set(['bat', 'batcat'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(stripAnsiCodes(merged))
    const lines = _stripBatBorders(text.split('\n'))
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= 50) return lines.join('\n').trimEnd()
    return headTailCompress(nonEmpty, 40, 10, 'lines').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// DeltaFilter — strip delta separators, head/tail compress
// ---------------------------------------------------------------------------

const _DELTA_SEP_CHARS = new Set('─━')

function _stripDeltaSeparators(lines: string[]): string[] {
  return lines.filter(l => {
    const s = l.trim()
    return !(s && [...s].every(c => _DELTA_SEP_CHARS.has(c)))
  })
}

export class DeltaFilter extends ToolFilter {
  readonly name = 'delta'
  override readonly binaries = new Set(['delta'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(stripAnsiCodes(merged))
    const lines = _stripDeltaSeparators(text.split('\n'))
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= 80) return lines.join('\n').trimEnd()
    return headTailCompress(nonEmpty, 60, 20, 'lines').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// FzfFilter — fuzzy finder output (head/tail compress)
// ---------------------------------------------------------------------------

export class FzfFilter extends ToolFilter {
  readonly name = 'fzf'
  override readonly binaries = new Set(['fzf'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= 50) return text.trimEnd()
    return headTailCompress(nonEmpty, 40, 10, 'lines').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// LazyGitFilter — TUI detection / pass-through
// ---------------------------------------------------------------------------

export class LazyGitFilter extends ToolFilter {
  readonly name = 'lazygit'
  override readonly binaries = new Set(['lazygit'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const hasAnsi = merged.includes('\x1b[') || merged.includes('\x1b(')
    const isEmpty = !merged.trim()
    if (isEmpty || hasAnsi) {
      return '[lazygit is an interactive terminal UI — run it in a terminal session, not piped]'
    }
    return merged.trimEnd()
  }
}

// ---------------------------------------------------------------------------
// JqFilter — JSON processor output (head/tail compress)
// ---------------------------------------------------------------------------

export class JqFilter extends ToolFilter {
  readonly name = 'jq'
  override readonly binaries = new Set(['jq'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= 200) return text.trimEnd()
    return headTailCompress(nonEmpty, 150, 50, 'lines').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// YqFilter — YAML processor output (head/tail compress)
// ---------------------------------------------------------------------------

export class YqFilter extends ToolFilter {
  readonly name = 'yq'
  override readonly binaries = new Set(['yq'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0] ?? '').toLowerCase())
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const text = normalise(merged)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim())
    if (nonEmpty.length <= 150) return text.trimEnd()
    return headTailCompress(nonEmpty, 100, 50, 'lines').trimEnd()
  }
}

// ---------------------------------------------------------------------------
// CurlFilter — curl/wget HTTP client output
// ---------------------------------------------------------------------------

const _CURL_VERBOSE_META_RE = /^[*>](\s|$)/
const _CURL_STATUS_RE = /^<\s+HTTP\/[\d.]+\s+(\d{3})/
const _CURL_USEFUL_HEADER_RE =
  /^<\s+(content-type|location|content-length|www-authenticate|x-ratelimit):/i
const _CURL_PROGRESS_RE =
  /^\s+%\s+Total|^\s+Dload\s+Upload\s|^\d{1,3}\s+\d+\s+\d+\s+\d+\s|^\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/
const _WGET_NOISE_RE =
  /^--\d{4}-\d{2}-\d{2}|^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} URL:|^(Resolving|Connecting to|Reusing|Sending|Saving to|HTTP request sent|Length:|Location:)/
const _WGET_HTTP_STATUS_RE = /^HTTP\/[\d.]+\s+(\d{3})/
const _WGET_SAVED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(/

export class CurlFilter extends ToolFilter {
  readonly name = 'curl'
  override readonly binaries = new Set(['curl', 'wget'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const binary = argv.length ? pathStem(argv[0] ?? '').toLowerCase() : 'curl'
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let droppedMeta = 0
    let droppedReqHeaders = 0
    let droppedRespHeaders = 0
    let droppedProgress = 0

    if (binary === 'wget') {
      for (const line of lines) {
        if (_WGET_SAVED_RE.test(line) || _WGET_HTTP_STATUS_RE.test(line)) {
          kept.push(line)
          continue
        }
        if (_WGET_NOISE_RE.test(line)) {
          droppedMeta++
          continue
        }
        kept.push(line)
      }
    } else {
      for (const line of lines) {
        if (_CURL_PROGRESS_RE.test(line)) {
          droppedProgress++
          continue
        }
        if (_CURL_STATUS_RE.test(line)) {
          kept.push(line.startsWith('< ') ? line.slice(2).trim() : line)
          continue
        }
        if (_CURL_USEFUL_HEADER_RE.test(line)) {
          kept.push(line.startsWith('< ') ? line.slice(2).trim() : line)
          continue
        }
        if (line.startsWith('< ')) {
          droppedRespHeaders++
          continue
        }
        if (_CURL_VERBOSE_META_RE.test(line)) {
          if (line.startsWith('>')) droppedReqHeaders++
          else droppedMeta++
          continue
        }
        kept.push(line)
      }
    }

    const notes: string[] = []
    maybeNote(notes, droppedMeta, `dropped ${droppedMeta} connection-metadata lines`)
    maybeNote(notes, droppedReqHeaders, `dropped ${droppedReqHeaders} request-header lines`)
    maybeNote(notes, droppedRespHeaders, `dropped ${droppedRespHeaders} response-header lines`)
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// RsyncFilter — file-synchronisation output
// ---------------------------------------------------------------------------

const _RSYNC_FILE_PROGRESS_RE = /^\s+[\d,]+\s+\d+%\s/
const _RSYNC_SUMMARY_RE =
  /^(sent|received|total size|Number of files|Number of created|Number of deleted|Number of regular|speedup)/
const _RSYNC_ERROR_RE =
  /\b(error|ERROR|failed|cannot|permission denied|No such file|rsync error)\b/

export class RsyncFilter extends ToolFilter {
  readonly name = 'rsync'
  override readonly binaries = new Set(['rsync'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedFiles = 0

    for (const line of lines) {
      if (_RSYNC_ERROR_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_RSYNC_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_RSYNC_FILE_PROGRESS_RE.test(line)) continue
      const stripped = line.trim()
      if (stripped && stripped.includes('/') && !stripped.startsWith('[')) {
        droppedFiles++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedFiles, `collapsed ${droppedFiles} per-file transfer lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// DiffFilter — unified / normal diff output
// ---------------------------------------------------------------------------

const _DIFF_FILE_HEADER_RE = /^(?:diff\s|---\s)/
const _DIFF_HUNK_RE = /^@@ /
const _DIFF_MAX_FULL_FILES = 20

function _isDiffAdd(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++')
}

function _isDiffRemove(line: string): boolean {
  return line.startsWith('-') && !line.startsWith('---')
}

// `diff -r`/`-ru` prints a `diff -ru <old> <new>` command-echo line immediately
// before each file's `--- `/`+++ ` header pair. Both lines match
// _DIFF_FILE_HEADER_RE, so a naive splitBlocks() call turns one real file into
// two blocks (the lone echo line, then the actual `---`/`+++`/hunks content).
// Merge a lone echo-only block into the block that follows it so each real
// file is counted — and rendered — exactly once.
function _mergeDiffEchoBlocks(rawBlocks: string[]): string[] {
  const merged: string[] = []
  let pendingEcho: string | null = null
  for (const block of rawBlocks) {
    const blockLines = block.split('\n')
    const isLoneEcho = blockLines.length === 1 && /^diff\s/.test(blockLines[0] ?? '')
    if (isLoneEcho) {
      pendingEcho = block
      continue
    }
    if (pendingEcho !== null) {
      merged.push(`${pendingEcho}\n${block}`)
      pendingEcho = null
    } else {
      merged.push(block)
    }
  }
  if (pendingEcho !== null) merged.push(pendingEcho)
  return merged
}

// A bare `--- ` line is only a real unified-diff file-header boundary when it
// is immediately followed by a `+++ ` line (the old-file/new-file header
// pair). Without that lookahead, a removed line whose original content
// happens to start with `-- ` (SQL/Lua/Haskell comments, a markdown `---`
// rule, etc.) renders as a line matching `_DIFF_FILE_HEADER_RE` in isolation
// and would be misdetected as a new file boundary, splitting one file's diff
// into spurious blocks. `diff `-prefixed lines (git's extended header) are
// unambiguous and always start a new block.
function _isDiffFileHeaderLine(line: string, nextLine: string | undefined): boolean {
  if (/^diff\s/.test(line)) return true
  if (/^---\s/.test(line) && nextLine !== undefined && /^\+\+\+\s/.test(nextLine)) return true
  return false
}

function _splitDiffFileBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (_isDiffFileHeaderLine(line, lines[i + 1])) {
      if (current.length) blocks.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) blocks.push(current.join('\n'))
  return blocks
}

function _splitIntoHunks(block: string[]): string[][] {
  const hunks: string[][] = []
  let current: string[] = []
  for (const line of block) {
    if (_DIFF_HUNK_RE.test(line) && current.length) {
      hunks.push(current)
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) hunks.push(current)
  return hunks
}

function _scoreAndCapHunks(hunkLines: string[], maxHunks: number): string[] {
  if (maxHunks <= 0) return hunkLines
  const hunks = _splitIntoHunks(hunkLines)
  const actual = hunks.slice(1)
  if (actual.length <= maxHunks) return hunkLines

  const density = (h: string[]): number => {
    const content = h.slice(1)
    const total = content.length
    if (total === 0) return 0
    const changed = content.filter(l => l.startsWith('+') || l.startsWith('-')).length
    return changed / total
  }

  const scored = actual.map((h, i) => ({ i, d: density(h) }))
  const keepSet = new Set(
    scored
      .slice()
      .sort((a, b) => b.d - a.d)
      .slice(0, maxHunks)
      .map(x => x.i),
  )
  const dropped = scored.filter(x => !keepSet.has(x.i))
  const avg = dropped.length ? dropped.reduce((a, x) => a + x.d, 0) / dropped.length : 0

  const out: string[] = [...(hunks[0] ?? [])]
  for (let i = 0; i < actual.length; i++) {
    if (keepSet.has(i)) out.push(...(actual[i] ?? []))
  }
  out.push(
    `[... ${dropped.length} more hunks, avg density ${avg.toFixed(2)} — likely whitespace/formatting]`,
  )
  return out
}

export class DiffFilter extends ToolFilter {
  readonly name = 'diff'
  override readonly binaries = new Set(['diff', 'diff3', 'sdiff', 'colordiff', 'wdiff'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const text = this.combineOutput(stdout, stderr)
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l)

    if (nonEmpty.length <= 50) return text

    const hasUnified = lines.slice(0, 20).some(l => _DIFF_HUNK_RE.test(l))
    if (hasUnified) return this._compressUnified(lines)
    return compressTestOutput(lines, 300)
  }

  private _compressUnified(lines: string[]): string {
    const text = lines.join('\n')
    const rawBlocks = _mergeDiffEchoBlocks(_splitDiffFileBlocks(text))
    const realFiles = rawBlocks.filter(b => _DIFF_FILE_HEADER_RE.test(b.split('\n')[0] ?? ''))

    if (realFiles.length > _DIFF_MAX_FULL_FILES) {
      const statLines = [
        `[token-goat: large diff (${realFiles.length} files); stat-only view]`,
      ]
      for (const blockStr of realFiles) {
        const blockLines = blockStr.split('\n')
        const header = blockLines[0]
        const adds = blockLines.filter(_isDiffAdd).length
        const dels = blockLines.filter(_isDiffRemove).length
        statLines.push(`${header}  +${adds} -${dels}`)
      }
      return statLines.join('\n')
    }

    const outParts: string[] = []
    for (const blockStr of rawBlocks) {
      const blockLines = blockStr.split('\n')
      const firstLine = blockLines[0] ?? ''
      if (!firstLine || !_DIFF_FILE_HEADER_RE.test(firstLine)) {
        outParts.push(blockStr)
        continue
      }
      // Apply density cap from [bash_diff] max_hunks_per_file (default 10);
      // falls back to disabled (0) on config load failure.
      let maxHunksPerFile = 0
      try {
        maxHunksPerFile = loadConfig().bash_diff.max_hunks_per_file
      } catch {
        // use fallback above
      }
      // The config-driven density cap (_scoreAndCapHunks, honoring
      // [bash_diff] max_hunks_per_file) is the SINGLE source of truth for the
      // per-file hunk cap, matching git.ts. A former second stage re-capped to
      // a hardcoded 3 here, shadowing any configured value above 3 (including
      // the default of 10); removed.
      const capped = _scoreAndCapHunks(blockLines, maxHunksPerFile)
      outParts.push(capped.join('\n'))
    }
    return outParts.join('\n')
  }
}

// ---------------------------------------------------------------------------
// FfmpegFilter — ffmpeg/ffprobe/ffplay output
// ---------------------------------------------------------------------------

const _FFMPEG_VERSION_RE = /^ff(?:mpeg|probe|play)\s+version\s/i
const _FFMPEG_BUILD_NOISE_RE = /^\s+(?:built with\b|configuration:|lib(?:av|sw|post)\w+\s+\d)/
const _FFMPEG_METADATA_SECTION_RE = /^\s{2,}Metadata:\s*$/
const _FFMPEG_METADATA_KV_RE = /^\s{4,}(?!Stream\s*#)[\w][\w ]*\s*:\s+/
const _FFMPEG_INPUT_OUTPUT_RE = /^(?:Input|Output)\s+#\d+,/
const _FFMPEG_DURATION_RE = /^\s{2,}Duration:\s/
const _FFMPEG_STREAM_RE = /^\s{4,}Stream\s+#\d+:\d+/
const _FFMPEG_STREAM_MAPPING_RE = /^Stream mapping:\s*$/
const _FFMPEG_PROGRESS_RE = /^\s*frame=\s*\d+\s+fps=/
const _FFMPEG_FINAL_STATS_RE = /^\s*video:\d+kB\s+audio:\d+kB/
const _FFMPEG_PRESS_Q_RE = /^Press\s+\[q\]\s+to\s+quit/

export class FfmpegFilter extends ToolFilter {
  readonly name = 'ffmpeg'
  override readonly binaries = new Set(['ffmpeg', 'ffprobe', 'ffplay'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const primary = stderr.trim() ? stderr : stdout
    const lines = primary.split('\n')

    const kept: string[] = []
    let droppedBuild = 0
    let droppedMeta = 0
    let droppedProgress = 0
    let lastProgress: string | null = null
    let inStreamMapping = false

    for (const line of lines) {
      const s = line.trimEnd()
      const lower = s.toLowerCase()

      if (lower.includes('error') || lower.includes('warning')) {
        kept.push(s)
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_VERSION_RE.test(s)) {
        kept.push(s)
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_BUILD_NOISE_RE.test(s)) {
        droppedBuild++
        continue
      }
      if (_FFMPEG_PROGRESS_RE.test(s)) {
        droppedProgress++
        lastProgress = s
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_FINAL_STATS_RE.test(s)) {
        if (lastProgress !== null) {
          kept.push(lastProgress)
          lastProgress = null
          droppedProgress--
        }
        kept.push(s)
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_PRESS_Q_RE.test(s)) {
        droppedMeta++
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_STREAM_MAPPING_RE.test(s)) {
        kept.push(s)
        inStreamMapping = true
        continue
      }
      if (inStreamMapping && s.trimStart().startsWith('Stream #')) {
        kept.push(s)
        continue
      }
      if (_FFMPEG_METADATA_SECTION_RE.test(s)) {
        droppedMeta++
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_METADATA_KV_RE.test(s)) {
        droppedMeta++
        continue
      }
      if (_FFMPEG_INPUT_OUTPUT_RE.test(s)) {
        kept.push(s)
        inStreamMapping = false
        continue
      }
      if (_FFMPEG_DURATION_RE.test(s)) {
        kept.push(s)
        continue
      }
      if (_FFMPEG_STREAM_RE.test(s)) {
        kept.push(s)
        inStreamMapping = false
        continue
      }
      kept.push(s)
      inStreamMapping = false
    }

    if (lastProgress !== null) {
      kept.push(lastProgress)
      droppedProgress--
    }

    const notes: string[] = []
    maybeNote(notes, droppedBuild, `dropped ${droppedBuild} build-info lines`)
    maybeNote(notes, droppedMeta, `dropped ${droppedMeta} metadata lines`)
    maybeNote(notes, droppedProgress, `collapsed ${droppedProgress} progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// BinaryInspectFilter — xxd/hexdump/od/hd output
// ---------------------------------------------------------------------------

const _BIN_INSPECT_PASSTHROUGH = 4

const _MAGIC_MAP: Array<[string, string]> = [
  ['89504e47', 'PNG image'],
  ['ffd8ff', 'JPEG image'],
  ['25504446', 'PDF document'],
  ['504b0304', 'ZIP archive'],
  ['7f454c46', 'ELF binary'],
  ['4d5a', 'Windows EXE/DLL'],
  ['cafebabe', 'Java class file'],
  ['1f8b', 'gzip archive'],
  ['377abcaf', '7-zip archive'],
]

const _HEX_DUMP_LINE_RE = /^[0-9a-f]{4,}(?::\s+|\s{2,})([0-9a-f][0-9a-f\s]+)/i

function _identifyHexMagic(firstLine: string): [string, string] {
  const m = _HEX_DUMP_LINE_RE.exec(firstLine)
  if (!m) return ['', 'unrecognised format']
  const raw = (m[1] ?? '').replace(/\s/g, '').toLowerCase()
  const magic8 = raw.slice(0, 8)
  if (magic8.length < 4) return ['', 'unrecognised format']
  for (const [prefix, description] of _MAGIC_MAP) {
    if (magic8.startsWith(prefix)) return [magic8.slice(0, prefix.length), description]
  }
  return [magic8, 'unknown binary type']
}

export class BinaryInspectFilter extends ToolFilter {
  readonly name = 'xxd'
  override readonly binaries = new Set(['xxd', 'hexdump', 'od', 'hd'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split(/\r?\n/)
    if (lines.length <= _BIN_INSPECT_PASSTHROUGH) return merged
    const total = lines.length
    const [magicHex, description] = _identifyHexMagic((lines[0] ?? '').replace(/\r?\n$/, ''))
    const summary = magicHex
      ? `[token-goat: hex dump of ${total} lines — detected: ${description} (magic: ${magicHex})]`
      : `[token-goat: hex dump of ${total} lines — ${description}]`
    const kept = [...lines.slice(0, 2), summary + '\n']
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// FileTypeFilter — `file` command pass-through with batch truncation
// ---------------------------------------------------------------------------

const _FILE_BATCH_LIMIT = 20

export class FileTypeFilter extends ToolFilter {
  readonly name = 'file'
  override readonly binaries = new Set(['file'])

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split(/\r?\n/)
    if (lines.length <= _FILE_BATCH_LIMIT) return merged
    const remaining = lines.length - _FILE_BATCH_LIMIT
    const kept = [...lines.slice(0, _FILE_BATCH_LIMIT), `[token-goat: ${remaining} more file entries truncated]\n`]
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// PsFilter — ps/top/tasklist process listing
// ---------------------------------------------------------------------------

const _PS_MIN_LINES = 20
const _PS_HEADER_KEYWORDS = new Set(['PID', 'COMMAND', 'CMD', 'IMAGE NAME', '%CPU', 'UID'])
const _PS_TOP_PREFIXES = ['top -', 'tasks:', '%cpu', 'mib ', 'kib ', 'gib ']
const _PS_DEV_SUBSTRINGS = [
  'python', 'node', 'uvicorn', 'gunicorn', 'django', 'flask', 'fastapi',
  'cargo', 'rustc', 'go ', 'java', 'ruby', 'rails', 'php', 'postgres',
  'mysql', 'redis', 'nginx', 'caddy', 'docker', 'kubectl', 'npm',
  'pnpm', 'yarn', 'bun', 'deno', 'git', 'ssh',
]

function _psKeepLine(
  line: string,
  opts: {
    cpuCol: number | null
    memCol: number | null
    cmdStart: number
    isTasklist: boolean
    currentUser: string
  },
): boolean {
  const { cpuCol, memCol, cmdStart, isTasklist, currentUser } = opts
  if (isTasklist) {
    return _PS_DEV_SUBSTRINGS.some(sub => line.toLowerCase().includes(sub))
  }
  const cols = line.split(/\s+/).filter(Boolean)
  if (!cols.length) return false
  if (currentUser && (cols[0] ?? '').toLowerCase() === currentUser) return true
  const cmdStr =
    cols.length > cmdStart ? cols.slice(cmdStart).join(' ').toLowerCase() : line.toLowerCase()
  if (_PS_DEV_SUBSTRINGS.some(sub => cmdStr.includes(sub))) return true
  if (
    cpuCol !== null &&
    memCol !== null &&
    cols.length > Math.max(cpuCol, memCol)
  ) {
    const cpu = parseFloat(cols[cpuCol] ?? '')
    const mem = parseFloat(cols[memCol] ?? '')
    if (!isNaN(cpu) && !isNaN(mem) && (cpu > 5.0 || mem > 2.0)) return true
  }
  return false
}

export class PsFilter extends ToolFilter {
  readonly name = 'ps'
  override readonly binaries = new Set(['ps', 'top', 'pstree', 'tasklist'])

  static detect(stdout: string): boolean {
    for (const line of stdout.split(/\r?\n/)) {
      const stripped = line.trim()
      if (!stripped) continue
      if (stripped.toLowerCase().startsWith('top -')) return true
      const upper = stripped.toUpperCase()
      if ([..._PS_HEADER_KEYWORDS.values()].some(kw => upper.includes(kw))) return true
      break
    }
    return false
  }

  protected override compressBody(
    stdout: string,
    _stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const lines = stdout.split(/\r?\n/)
    if (lines.length <= _PS_MIN_LINES) return stdout

    let colHeaderIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const stripped = (lines[i] ?? '').trim()
      if (!stripped) continue
      const lower = stripped.toLowerCase()
      if (_PS_TOP_PREFIXES.some(pfx => lower.startsWith(pfx))) continue
      const upper = stripped.toUpperCase()
      if ([..._PS_HEADER_KEYWORDS.values()].some(kw => upper.includes(kw))) {
        colHeaderIdx = i
        break
      }
    }
    if (colHeaderIdx === -1) return stdout

    const headerUpper = (lines[colHeaderIdx] ?? '').toUpperCase()
    const isTasklist = headerUpper.includes('IMAGE NAME')
    const headerTokens = (lines[colHeaderIdx] ?? '').split(/\s+/).filter(Boolean)
    const cpuCol = headerTokens.findIndex(t => t.toUpperCase() === '%CPU')
    const memCol = headerTokens.findIndex(t => t.toUpperCase() === '%MEM')
    const cmdStart = (() => {
      const idx = headerTokens.findIndex(t => t.toUpperCase() === 'COMMAND' || t.toUpperCase() === 'CMD')
      return idx >= 0 ? idx : 10
    })()
    const currentUser = (process.env['USERNAME'] ?? process.env['USER'] ?? '').toLowerCase()

    const kept: string[] = []
    let suppressedCount = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (i <= colHeaderIdx) {
        kept.push(line)
        continue
      }
      const stripped = line.trim()
      if (!stripped) {
        kept.push(line)
        continue
      }
      if (isTasklist && /^[= ]+$/.test(stripped)) {
        kept.push(line)
        continue
      }
      if (_psKeepLine(line, { cpuCol: cpuCol >= 0 ? cpuCol : null, memCol: memCol >= 0 ? memCol : null, cmdStart, isTasklist, currentUser })) {
        kept.push(line)
      } else {
        suppressedCount++
      }
    }

    if (suppressedCount === 0) return stdout
    while (kept.length && !(kept[kept.length - 1] ?? '').trim()) kept.pop()
    kept.push(`[suppressed ${suppressedCount} system processes]`)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

export const grepFilter = new GrepFilter()
export const rgFilter = new RgFilter()
export const lsFilter = new LsFilter()
export const ezaFilter = new EzaFilter()
export const treeFilter = new TreeFilter()
export const fdFilter = new FdFilter()
export const wcFilter = new WcFilter()
export const batFilter = new BatFilter()
export const deltaFilter = new DeltaFilter()
export const fzfFilter = new FzfFilter()
export const lazyGitFilter = new LazyGitFilter()
export const jqFilter = new JqFilter()
export const yqFilter = new YqFilter()
export const curlFilter = new CurlFilter()
export const rsyncFilter = new RsyncFilter()
export const diffFilter = new DiffFilter()
export const ffmpegFilter = new FfmpegFilter()
export const binaryInspectFilter = new BinaryInspectFilter()
export const fileTypeFilter = new FileTypeFilter()
export const psFilter = new PsFilter()

// ---------------------------------------------------------------------------
// SHELL_FILE_FILTERS — ordered to match Python FILTERS registry: RgFilter before GrepFilter (both claim rg/grep; RgFilter handles context-line stripping), LsFilter before EzaFilter (both claim ls/eza; LsFilter applies simpler truncation), DiffFilter before LsFilter (per Python ordering).
// ---------------------------------------------------------------------------

export const SHELL_FILE_FILTERS: ToolFilter[] = [
  // Grep family — RgFilter (context stripper) before GrepFilter (file-count summariser)
  rgFilter,
  grepFilter,
  // HTTP clients
  curlFilter,
  rsyncFilter,
  // Media processing
  ffmpegFilter,
  // Diff tool (plain POSIX diff; git diff is handled by GitFilter)
  diffFilter,
  // Directory listings — LsFilter (simple) before EzaFilter (richer tree/column-aware)
  lsFilter,
  ezaFilter,
  fdFilter,
  wcFilter,
  treeFilter,
  batFilter,
  deltaFilter,
  fzfFilter,
  lazyGitFilter,
  jqFilter,
  yqFilter,
  // Binary / file inspection
  binaryInspectFilter,
  fileTypeFilter,
  // Process listing
  psFilter,
]
