// JavaScript and TypeScript linter filters (Batch C): tsc, eslint, oxlint, biome and prettier, plus the generic LinterFilter, whose stylelint and rome path reuses the ESLint stanza compressor defined here. Each is a faithful TypeScript port of its Python counterpart in bash_compress.py, and LINTER_FILTERS in linters.ts sets its dispatch position.

import { countNoun } from '../util.js'
import { ToolFilter } from './base.js'
import type { CompressContext } from './base.js'
import { plural } from './families.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, squeezeBlankLines } from './helpers.js'

// --------------------------------------------------------------------------- Shared helper: ESLint-stanza compression (reused by generic LinterFilter) ---------------------------------------------------------------------------

// ESLint location line: "  12:8  error   msg   rule"
const _ESLINT_LOC_RE = /^\s+\d+:\d+\s+(error|warning|info)\s/

// ESLint / stylelint file header: starts with abs-path or known JS extension
const _ESLINT_FILE_RE = /^(?:\/|[A-Za-z]:|[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|vue))/

// ESLint summary footer: "✖ 47 problems …"
const _ESLINT_SUMMARY_RE = /^[✖✗✘x×]\s+\d+\s+problem/

function _emitEslintRules(perRule: Map<string, string[]>): string[] {
  const out: string[] = []
  for (const [rule, entries] of [...perRule.entries()].sort()) {
    out.push(...entries.slice(0, 3))
    if (entries.length > 3) out.push(`  [token-goat: +${countNoun(entries.length - 3, `more ${rule} violation`)}]`)
  }
  return out
}

function _compressEslintStanza(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let currentFile: string[] = []

  function flushFile(): void {
    if (!currentFile.length) return
    const header = currentFile[0]!
    const body = currentFile.slice(1)
    out.push(header)
    let perRule = new Map<string, string[]>()
    for (const line of body) {
      if (!_ESLINT_LOC_RE.test(line)) {
        // Not an issue line; flush accumulated rules then keep in place
        if (perRule.size) {
          out.push(..._emitEslintRules(perRule))
          perRule = new Map()
        }
        out.push(line)
        continue
      }
      const rule = line.trimEnd().split(/\s+/).pop() ?? '__unknown__'
      const bucket = perRule.get(rule) ?? []
      bucket.push(line)
      perRule.set(rule, bucket)
    }
    out.push(..._emitEslintRules(perRule))
    currentFile = []
  }

  for (const line of lines) {
    if (_ESLINT_FILE_RE.test(line)) {
      flushFile()
      currentFile = [line]
    } else if (currentFile.length) {
      currentFile.push(line)
    } else {
      out.push(line)
    }
  }
  flushFile()
  return squeezeBlankLines(out.join('\n'))
}

// --------------------------------------------------------------------------- TscFilter ---------------------------------------------------------------------------

const _TSC_WATCH_INIT_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Starting compilation in watch mode\.\.\.$/
const _TSC_WATCH_CYCLE_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] (?:File change detected\. )?Starting incremental compilation\.\.\.$/
const _TSC_BUILD_PROJECTS_HDR_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Projects in this build:$/
const _TSC_BUILD_PROJECT_ITEM_RE = /^\s+\*\s+\S/
const _TSC_BUILD_UPTODATE_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Project '.+' is up to date/
const _TSC_ERROR_OLD_RE = /^\S+\.tsx?\(\d+,\d+\): (?:error|warning|message) TS\d+:/
const _TSC_ERROR_NEW_RE = /^\S+\.tsx?:\d+:\d+ - (?:error|warning|message) TS\d+:/
const _TSC_ERROR_CODE_RE = /\bTS(\d+)\b/

function _isTscCmd(argv: string[]): boolean {
  if (!argv.length) return false
  function base(s: string): string {
    let b = s.replace(/\\/g, '/').split('/').pop()!.toLowerCase()
    for (const ext of ['.exe', '.cmd']) {
      if (b.endsWith(ext)) { b = b.slice(0, -ext.length); break }
    }
    return b
  }
  const b0 = base(argv[0]!)
  if (b0 === 'tsc') return true
  if (b0 === 'npx' || b0 === 'yarn' || b0 === 'pnpm') {
    let i = 1
    while (i < argv.length) {
      const tok = argv[i]!
      if (tok.startsWith('-')) {
        if (tok === '--package' || tok === '-p') i += 2
        else i++
      } else {
        if (b0 === 'pnpm' && tok === 'exec') { i++; continue }
        return base(tok) === 'tsc'
      }
    }
    return false
  }
  return false
}

function _isTscContextLine(line: string): boolean {
  if (!line.trim()) return true
  if (/^\d+\s/.test(line)) return true
  const stripped = line.trim()
  if (stripped && /^[~^ ]+$/.test(stripped)) return true
  return line.startsWith('  ') && !_TSC_ERROR_OLD_RE.test(line.trimStart()) && !_TSC_ERROR_NEW_RE.test(line.trimStart())
}

class TscFilter extends ToolFilter {
  readonly name = 'tsc'
  override readonly binaries = new Set(['tsc'])
  private static readonly _MAX_PER_CODE = 3

  override matches(argv: string[]): boolean {
    return _isTscCmd(argv)
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const argvFlags = new Set(argv.slice(1).map((a) => a.toLowerCase()))
    const isWatch = argvFlags.has('-w') || argvFlags.has('--watch')
    const isBuild = argvFlags.has('-b') || argvFlags.has('--build')
    const combined = this.combineOutput(stdout, stderr)
    if (isWatch) return this._compressWatch(combined)
    if (isBuild) return this._compressBuild(combined)
    return this._compressTypecheck(combined)
  }

  private _compressTypecheck(combined: string): string {
    const lines = combined.split('\n')
    const kept: string[] = []
    const codeKept = new Map<string, number>()
    const codeDropped = new Map<string, number>()
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (_TSC_ERROR_OLD_RE.test(line) || _TSC_ERROR_NEW_RE.test(line)) {
        const m = _TSC_ERROR_CODE_RE.exec(line)
        const code = m ? m[1]! : ''
        const stanza = [line]
        let j = i + 1
        while (j < lines.length && _isTscContextLine(lines[j]!)) {
          stanza.push(lines[j]!)
          j++
        }
        const n = codeKept.get(code) ?? 0
        if (n < TscFilter._MAX_PER_CODE) {
          kept.push(...stanza)
          if (code) codeKept.set(code, n + 1)
        } else {
          codeDropped.set(code, (codeDropped.get(code) ?? 0) + 1)
        }
        i = j
      } else {
        kept.push(line)
        i++
      }
    }
    for (const code of [...codeDropped.keys()].sort((a, b) => (Number(a) || 0) - (Number(b) || 0))) {
      const n = codeDropped.get(code)!
      const pl = n > 1 ? 's' : ''
      kept.push(`[token-goat: dropped ${n} more TS${code} error${pl} (kept first ${TscFilter._MAX_PER_CODE})]`)
    }
    return squeezeBlankLines(kept.join('\n'))
  }

  private _compressWatch(combined: string): string {
    const lines = combined.split('\n')
    const cycles: string[][] = []
    let current: string[] = []
    for (const line of lines) {
      if (_TSC_WATCH_INIT_RE.test(line) || _TSC_WATCH_CYCLE_RE.test(line)) {
        if (current.length) cycles.push(current)
        current = [line]
      } else {
        current.push(line)
      }
    }
    if (current.length) cycles.push(current)
    if (cycles.length <= 2) return squeezeBlankLines(combined)
    const dropped = cycles.length - 2
    const pl = dropped > 1 ? 's' : ''
    const keptLines: string[] = [...cycles[0]!]
    keptLines.push(`[token-goat: dropped ${dropped} intermediate watch cycle${pl}]`)
    keptLines.push(...cycles[cycles.length - 1]!)
    return squeezeBlankLines(keptLines.join('\n'))
  }

  private _compressBuild(combined: string): string {
    const lines = combined.split('\n')
    const kept: string[] = []
    let upToDateCount = 0
    let inProjectsHdr = false
    for (const line of lines) {
      if (_TSC_BUILD_PROJECTS_HDR_RE.test(line)) { inProjectsHdr = true; continue }
      if (inProjectsHdr) {
        if (_TSC_BUILD_PROJECT_ITEM_RE.test(line) || !line.trim()) continue
        inProjectsHdr = false
      }
      if (_TSC_BUILD_UPTODATE_RE.test(line)) { upToDateCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    if (upToDateCount) {
      const pl = upToDateCount > 1 ? 's' : ''
      notes.push(`dropped ${upToDateCount} up-to-date project line${pl}`)
    }
    this.emitNotes(kept, notes)
    return squeezeBlankLines(kept.join('\n'))
  }
}

// --------------------------------------------------------------------------- ESLintFilter ---------------------------------------------------------------------------

// ESLint issue line: "  12:8  error   msg   rule-name"
const _ESLINT_ISSUE_RE = /^\s+\d+:\d+\s+(error|warning|info)\s+.+\S\s+\S+$/

// ESLint --format compact: "<path>: line N, col N, Severity - message (rule)"
const _ESLINT_COMPACT_ISSUE_RE = /^(.+?): line \d+, col \d+, (Error|Warning|Info)\b/
// ESLint --format unix: "<path>:N:N: message [Severity/rule]" (rule suffix optional)
const _ESLINT_UNIX_ISSUE_RE = /^(.+?):\d+:\d+: .+ \[(Error|Warning|Info)(?:\/\S+)?\]$/

// Returns the lowercased severity for a stylish, compact, or unix format issue line, or null if the line doesn't match any known ESLint issue format.
function _eslintIssueSeverity(issue: string): string | null {
  const stylish = _ESLINT_ISSUE_RE.exec(issue)
  if (stylish) return stylish[1]!.toLowerCase()
  const compact = _ESLINT_COMPACT_ISSUE_RE.exec(issue)
  if (compact) return compact[2]!.toLowerCase()
  const unix = _ESLINT_UNIX_ISSUE_RE.exec(issue)
  if (unix) return unix[2]!.toLowerCase()
  return null
}

// Returns the file path captured from a compact/unix single-line issue, or null if the line is a stylish-format issue/header line instead.
function _eslintSingleLineIssuePath(line: string): string | null {
  const compact = _ESLINT_COMPACT_ISSUE_RE.exec(line)
  if (compact) return compact[1]!
  const unix = _ESLINT_UNIX_ISSUE_RE.exec(line)
  if (unix) return unix[1]!
  return null
}

// Shape per https://eslint.org/docs/latest/use/formatters/#json: an array of { filePath, messages: [{ ruleId, severity (1 warning, 2 error), message, line, column }] }.
function _eslintJsonToStylish(stdout: string): string | null {
  const text = stdout.trim()
  if (!text.startsWith('[') || !text.endsWith(']')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: string[] = []
  let errors = 0
  let warnings = 0
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null
    const { filePath, messages } = entry as { filePath?: unknown; messages?: unknown }
    if (typeof filePath !== 'string' || !Array.isArray(messages)) return null
    if (messages.length === 0) continue
    out.push(filePath)
    for (const m of messages as Array<{ ruleId?: unknown; severity?: unknown; message?: unknown; line?: unknown; column?: unknown }>) {
      const isError = m.severity === 2
      if (isError) errors++
      else warnings++
      const where = `${typeof m.line === 'number' ? m.line : 0}:${typeof m.column === 'number' ? m.column : 0}`
      const msg = (typeof m.message === 'string' ? m.message : '').replace(/\s+/g, ' ').trim()
      out.push(`  ${where}  ${isError ? 'error' : 'warning'}  ${msg}${typeof m.ruleId === 'string' ? `  ${m.ruleId}` : ''}`)
    }
    out.push('')
  }
  const problems = errors + warnings
  if (problems === 0) return 'ESLint: no problems'
  out.push(`✖ ${problems} problem${problems === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`)
  return out.join('\n')
}

class ESLintFilter extends ToolFilter {
  readonly name = 'eslint'
  override readonly binaries = new Set(['eslint'])

  // `-f json` prints the whole report on one line, which the generic wide-line clip cuts to its two ends before compress runs, so the other files and every count are gone. Rewritten here as the stylish report compress already groups.
  protected override preClip(stdout: string, _argv: string[]): string {
    return _eslintJsonToStylish(stdout) ?? stdout
  }

  override compress(stdout: string, stderr: string, exitCode: number, _argv: string[], ctx: CompressContext = {}): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')

    // Fast path: truly clean exit -- zero problems, not just zero errors. ESLint exits 0 whenever there are no *errors*, even when warnings were emitted (unless --max-warnings is set), so exitCode alone can't tell "nothing to report" from "warnings only". Only take the elide-everything shortcut when no line looks like an actual issue (stylish, compact, or unix format); otherwise fall through to the same grouping logic used for a non-zero exit so warning text is never silently dropped.
    if (exitCode === 0 && !lines.some((ln) => _eslintIssueSeverity(ln) !== null)) {
      const summary = lines.find((ln) => _ESLINT_SUMMARY_RE.test(ln.trim()))
      return summary ?? 'ESLint: no errors'
    }

    // Every top-level line is either a passthrough (prelude, blank separator between stanzas, or the trailing summary) or a completed file stanza. Recording that structure instead of flattening straight to text lets the renderer below reflow a stanza three different ways -- verbatim, error-capped, or collapsed to one line -- without re-parsing, and lets a file's header survive even when its body doesn't.
    type _Block = { readonly kind: 'line'; readonly text: string } | { readonly kind: 'file'; readonly header: string; readonly issues: readonly string[] }
    const blocks: _Block[] = []
    let currentFileHeader: string | null = null
    let currentIssues: string[] = []
    let currentHasIssues = false

    function flushFile(): void {
      if (currentFileHeader === null) {
        currentIssues = []
        currentHasIssues = false
        return
      }
      if (currentHasIssues) blocks.push({ kind: 'file', header: currentFileHeader, issues: currentIssues })
      currentFileHeader = null
      currentIssues = []
      currentHasIssues = false
    }

    for (const line of lines) {
      if (_ESLINT_SUMMARY_RE.test(line.trim())) {
        flushFile()
        blocks.push({ kind: 'line', text: line })
        continue
      }
      // --format compact/unix: each violation is a self-contained single line that also happens to start with a file path, so it must be checked BEFORE _ESLINT_FILE_RE or every violation is misread as a new (empty) file header and silently dropped by flushFile's no-issues branch.
      const singleLinePath = _eslintSingleLineIssuePath(line)
      if (singleLinePath !== null) {
        if (currentFileHeader !== singleLinePath) {
          flushFile()
          currentFileHeader = singleLinePath
        }
        currentIssues.push(line)
        currentHasIssues = true
        continue
      }
      if (_ESLINT_FILE_RE.test(line)) {
        flushFile()
        currentFileHeader = line
        currentIssues = []
        currentHasIssues = false
        continue
      }
      if (currentFileHeader !== null && _ESLINT_ISSUE_RE.test(line)) {
        currentIssues.push(line)
        currentHasIssues = true
        continue
      }
      if (currentFileHeader === null) {
        blocks.push({ kind: 'line', text: line })
      } else {
        // Non-issue line inside stanza (blank separator, etc.)
        currentIssues.push(line)
      }
    }
    flushFile()

    // tier 0 renders a stanza exactly as the original flat compress did: errors (and any other non-warning line) verbatim in original order, then warnings grouped 3/rule with a "+N more" marker -- so anything that already fits the cap ships byte-identical. tier 1 additionally caps errors 3/rule/file the same way, for when warnings alone weren't the problem. tier 2 collapses the whole stanza to one line so a run with hundreds of error lines still names every file.
    const renderFile = (header: string, issues: readonly string[], tier: 0 | 1 | 2): string[] => {
      if (tier === 2) {
        const errorsByRule = new Map<string, number>()
        const warningsByRule = new Map<string, number>()
        for (const issue of issues) {
          const severity = _eslintIssueSeverity(issue)
          const bucket = severity === 'error' ? errorsByRule : severity === 'warning' ? warningsByRule : null
          if (bucket !== null) {
            const rule = issue.trimEnd().split(/\s+/).pop() ?? '__unknown__'
            bucket.set(rule, (bucket.get(rule) ?? 0) + 1)
          }
        }
        const summarize = (byRule: Map<string, number>, noun: string): string | null => {
          const total = [...byRule.values()].reduce((a, b) => a + b, 0)
          if (total === 0) return null
          return `${total} ${noun}${plural(total)}: ${[...byRule.entries()].sort().map(([rule, n]) => `${rule} ×${n}`).join(', ')}`
        }
        const parts = [summarize(errorsByRule, 'error'), summarize(warningsByRule, 'warning')].filter((p): p is string => p !== null)
        return parts.length > 0 ? [`${header}  [token-goat: ${parts.join('; ')}]`] : [header]
      }
      const fileOut: string[] = [header]
      const errorsByRule = new Map<string, string[]>()
      const warningsByRule = new Map<string, string[]>()
      // The blank line stylish prints after a stanza separates it from the next file, so it goes after the grouped warnings rather than between the errors and them.
      let lastBody = issues.length
      while (lastBody > 0 && issues[lastBody - 1]?.trim() === '') lastBody--
      for (const issue of issues.slice(0, lastBody)) {
        const severity = _eslintIssueSeverity(issue)
        const byRule = severity === 'warning' ? warningsByRule : tier === 1 && severity === 'error' ? errorsByRule : null
        if (byRule === null) {
          fileOut.push(issue)
          continue
        }
        const rule = issue.trimEnd().split(/\s+/).pop() ?? '__unknown__'
        const bucket = byRule.get(rule) ?? []
        bucket.push(issue)
        byRule.set(rule, bucket)
      }
      for (const [byRule, noun] of [[errorsByRule, 'error'], [warningsByRule, 'warning']] as const) {
        for (const [rule, entries] of [...byRule.entries()].sort()) {
          fileOut.push(...entries.slice(0, 3))
          if (entries.length > 3) fileOut.push(`  [token-goat: +${countNoun(entries.length - 3, `more ${rule} ${noun}`)}]`)
        }
      }
      fileOut.push(...issues.slice(lastBody))
      return fileOut
    }

    const render = (tier: 0 | 1 | 2): string =>
      squeezeBlankLines(blocks.flatMap((block) => (block.kind === 'line' ? [block.text] : renderFile(block.header, block.issues, tier))).join('\n'))

    let text = render(0)
    if (ctx.maxLines !== undefined) {
      if (text.split('\n').length > ctx.maxLines) text = render(1)
      if (text.split('\n').length > ctx.maxLines) text = render(2)
    }
    return text
  }
}

// --------------------------------------------------------------------------- OxlintFilter ---------------------------------------------------------------------------

const _OXLINT_FILE_HEADER_RE = /^\s{2,}\S+\.\w{1,10}\s*$/
const _OXLINT_ISSUE_RE = /^\s{4,}[×✖✗!]\s/
const _OXLINT_LOCATION_RE = /^\s*(?:╭─\[|│\s|╰─)/
const _OXLINT_SUMMARY_RE = /^\s*(?:Found \d+|Finished in \d+|oxlint v\d)/i
const _OXLINT_RULE_RE = /\(([a-zA-Z0-9/_-]+)\)\s*$/

class OxlintFilter extends ToolFilter {
  readonly name = 'oxlint'
  override readonly binaries = new Set(['oxlint', 'oxc_linter'])
  private static readonly _KEEP_PER_RULE = 3

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let deduplicated = 0
    let droppedLocation = 0
    let currentFile: string | null = null
    const ruleCounts = new Map<string, number>()
    let suppressBlock = false
    let pendingPlaceholders: { index: number; rule: string; file: string | null }[] = []

    // ruleCounts (and thus each rule's final tally) resets at every file/summary boundary, so placeholders must be patched with the real elided count right before that reset — not left as a literal "+?" — and again at loop end.
    const finalizePlaceholders = (): void => {
      for (const { index, rule, file } of pendingPlaceholders) {
        const elided = (ruleCounts.get(rule) ?? 0) - OxlintFilter._KEEP_PER_RULE
        kept[index] =
          `  [token-goat: +${elided} more ${JSON.stringify(rule)} in ${file ?? 'file'}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`
      }
      pendingPlaceholders = []
    }

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); suppressBlock = false; continue }
      if (_OXLINT_SUMMARY_RE.test(line)) {
        finalizePlaceholders()
        kept.push(line)
        currentFile = null
        ruleCounts.clear()
        continue
      }
      if (_OXLINT_FILE_HEADER_RE.test(line)) {
        finalizePlaceholders()
        currentFile = line.trim()
        ruleCounts.clear()
        suppressBlock = false
        kept.push(line)
        continue
      }
      if (_OXLINT_ISSUE_RE.test(line)) {
        const m = _OXLINT_RULE_RE.exec(line)
        const rule = m ? m[1]! : '__unknown__'
        const count = (ruleCounts.get(rule) ?? 0) + 1
        ruleCounts.set(rule, count)
        if (count <= OxlintFilter._KEEP_PER_RULE) {
          kept.push(line)
          suppressBlock = false
        } else {
          if (count === OxlintFilter._KEEP_PER_RULE + 1) {
            pendingPlaceholders.push({ index: kept.length, rule, file: currentFile })
            kept.push('')
          }
          deduplicated++
          suppressBlock = true
        }
        continue
      }
      if (_OXLINT_LOCATION_RE.test(line)) {
        if (suppressBlock) { droppedLocation++; continue }
        kept.push(line)
        continue
      }
      kept.push(line)
    }
    finalizePlaceholders()

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule issue lines`)
    maybeNote(notes, droppedLocation, `dropped ${droppedLocation} location-pointer lines for deduped issues`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- BiomeFilter ---------------------------------------------------------------------------

const _BIOME_RULE_LINE_RE = /^\s+[×✖✕]\s+\S+\/\S+\s+(?:━+|─+)/
const _BIOME_SOURCE_LINE_RE = /^\s+\d+\s+[│|]\s/
const _BIOME_HINT_RE = /^\s+(?:[iℹ]|ℹ️|Note:)\s+/
const _BIOME_ANNOTATION_RE = /^\s+(?:Caution:|note:|help:|suggestion:)\s+/i
const _BIOME_SUMMARY_RE =
  /^Found\s+\d+\s+diagnostic|^Checked\s+\d+\s+file|^Formatted\s+\d+\s+file|^\d+\s+(?:error|warning|info)/i

class BiomeFilter extends ToolFilter {
  readonly name = 'biome'
  override readonly binaries = new Set(['biome', '@biomejs/biome'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem === 'npx' || stem === 'pnpx') {
      return argv.length > 1 && (argv[1]!.toLowerCase() === 'biome' || argv[1]!.toLowerCase() === '@biomejs/biome')
    }
    return stem === 'biome'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const nonEmpty = lines.filter((ln) => ln.trim())

    if (nonEmpty.length <= 40) return merged.trimEnd()

    const kept: string[] = []
    const ruleCount = new Map<string, number>()
    const ruleCollapsed = new Map<string, number>()
    let inStanza = false
    let currentRule = ''
    let stanzaLines: string[] = []
    let sourceLinesInStanza = 0
    const _MAX_STANZAS_PER_RULE = 3
    const _MAX_SOURCE_LINES = 2

    function flushStanza(): void {
      if (!stanzaLines.length) return
      const rule = currentRule
      const keptCount = ruleCount.get(rule) ?? 0
      if (keptCount < _MAX_STANZAS_PER_RULE) {
        ruleCount.set(rule, keptCount + 1)
        kept.push(...stanzaLines)
      } else {
        ruleCollapsed.set(rule, (ruleCollapsed.get(rule) ?? 0) + 1)
      }
      stanzaLines = []
      sourceLinesInStanza = 0
    }

    for (const line of lines) {
      if (_BIOME_SUMMARY_RE.test(line)) {
        flushStanza()
        inStanza = false
        kept.push(line)
        continue
      }
      if (ERROR_SIGNAL_RE.test(line) && !_BIOME_SOURCE_LINE_RE.test(line)) {
        flushStanza()
        inStanza = false
        kept.push(line)
        continue
      }
      if (_BIOME_RULE_LINE_RE.test(line)) {
        flushStanza()
        const m = /(\S+\/\S+)/.exec(line)
        currentRule = m ? m[1]! : 'unknown'
        inStanza = true
        stanzaLines = [line]
        sourceLinesInStanza = 0
        continue
      }
      if (!inStanza) { kept.push(line); continue }
      // Inside a stanza
      if (_BIOME_HINT_RE.test(line) || _BIOME_ANNOTATION_RE.test(line)) continue
      if (_BIOME_SOURCE_LINE_RE.test(line)) {
        if (sourceLinesInStanza < _MAX_SOURCE_LINES) {
          stanzaLines.push(line)
          sourceLinesInStanza++
        }
        continue
      }
      stanzaLines.push(line)
    }
    flushStanza()

    if (ruleCollapsed.size) {
      for (const [rule, cnt] of [...ruleCollapsed.entries()].sort()) {
        kept.push(
          `[token-goat: +${cnt} more ${rule} diagnostic(s) elided; run \`biome check\` for full output]`,
        )
      }
    }

    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- Generic LinterFilter (pyright / stylelint / rome — after specific filters) ---------------------------------------------------------------------------

const _LINTER_DIAG_KEY_RE = /\b([A-Z][A-Z0-9]+\d+|error|warning|note)\b/

class LinterFilter extends ToolFilter {
  readonly name = 'linter'
  override readonly binaries = new Set(['pyright', 'pylint', 'stylelint', 'rome'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : ''

    if (binary === 'pyright' || binary === 'pylint') {
      // dedupe_by_key: group lines by first regex match key, keep first 3 per group
      const seen = new Map<string, number>()
      const summaries = new Map<string, number>()
      const out: string[] = []
      for (const line of merged.split('\n')) {
        const m = _LINTER_DIAG_KEY_RE.exec(line)
        if (!m) { out.push(line); continue }
        const bucket = m[1]!
        const count = (seen.get(bucket) ?? 0) + 1
        seen.set(bucket, count)
        if (count <= 3) out.push(line)
        else summaries.set(bucket, (summaries.get(bucket) ?? 0) + 1)
      }
      for (const [bucket, count] of [...summaries.entries()].sort()) {
        out.push(`[token-goat: +${count} more matching ${bucket}]`)
      }
      return squeezeBlankLines(out.join('\n'))
    }

    // stylelint / rome: stanza-style like ESLint
    return _compressEslintStanza(merged)
  }
}

// --------------------------------------------------------------------------- PrettierFilter ---------------------------------------------------------------------------

const _PRETTIER_FILE_RE = /^(?!\[)\s*\S+[./]\S*\s*(?:\d+ms)?\s*(?:\(unchanged\))?\s*$/
const _PRETTIER_SUMMARY_RE =
  /^(?:All matched files|Code style issues found|Checking formatting|Pretty-Format:|prettier \[warn\]|prettier \[error\]|\[warn\]|\[error\])/i
const _PRETTIER_UNCHANGED_RE = /\(unchanged\)\s*$/

class PrettierFilter extends ToolFilter {
  readonly name = 'prettier'
  override readonly binaries = new Set(['prettier', 'npx', 'pnpx'])
  private static readonly _SAMPLE_SIZE = 5

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem === 'prettier') return true
    return (stem === 'npx' || stem === 'pnpx') && argv.length > 1 && argv[1]!.toLowerCase() === 'prettier'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    const changedSample: string[] = []
    let changedExtra = 0
    let droppedUnchanged = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_PRETTIER_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_PRETTIER_FILE_RE.test(line) && _PRETTIER_UNCHANGED_RE.test(line)) { droppedUnchanged++; continue }
      if (_PRETTIER_FILE_RE.test(line)) {
        if (changedSample.length < PrettierFilter._SAMPLE_SIZE) changedSample.push(line)
        else changedExtra++
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...changedSample]
    if (changedExtra) {
      out.push(`[token-goat: +${countNoun(changedExtra, 'more formatted file')}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    }
    out.push(...kept)
    const notes: string[] = []
    maybeNote(notes, droppedUnchanged, `dropped ${droppedUnchanged} unchanged-file lines`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const tscFilter = new TscFilter()
export const eslintFilter = new ESLintFilter()
export const oxlintFilter = new OxlintFilter()
export const biomeFilter = new BiomeFilter()
export const linterFilter = new LinterFilter()
export const prettierFilter = new PrettierFilter()
