// Bundle project files into a single LLM-ready output with token estimates.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as minimatch from 'minimatch'
import { estimateTokens } from './overflow_guard.js'

const LANG_MAP: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'fish',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.tf': 'hcl',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
}

export interface PackFile {
  path: string
  rel_path: string
  content: string
  lines: number
  tokens: number
}

export interface PackResult {
  files: PackFile[]
  skipped: string[]
  total_lines: number
  total_tokens: number
}

export interface SecretHit {
  rel_path: string
  line: number
  kind: string
  snippet: string
}

export interface BudgetEntry {
  rel_path: string
  lines: number
  tokens: number
  size_bytes: number
}

export interface BudgetResult {
  entries: BudgetEntry[]
  skipped: string[]
  total_lines: number
  total_tokens: number
}

function getLang(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return LANG_MAP[ext] ?? ''
}

function matches(rel: string, patterns: string[]): boolean {
  const norm = rel.replace(/\\/g, '/')
  const base = norm.split('/').pop() ?? norm
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = minimatch as any
  return patterns.some((pat) => mm.minimatch(norm, pat) || mm.minimatch(base, pat))
}

/**
 * True when `resolvedPath` (an already symlink-resolved absolute path)
 * lives inside `rootReal` (itself already symlink-resolved). Uses
 * `path.relative` plus a `..`/absolute-path guard so a sibling that merely
 * shares a string prefix (e.g. `root-evil`) is never mistaken for a path
 * inside `root`.
 */
function isPathWithinRoot(rootReal: string, resolvedPath: string): boolean {
  const rel = path.relative(rootReal, resolvedPath)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/**
 * Opens `p` exactly once and returns a descriptor already bound to a file
 * that has been validated as living inside `rootReal`. This closes the
 * TOCTOU gap between "check" and "use": `collectFiles`/`estimateBudget`
 * used to resolve `p` via `fs.realpathSync` to check containment, then
 * separately `fs.statSync(p)` and `fs.readFileSync(p)` the same path again
 * to get the size and content — three independent path lookups, each free
 * to land on a different filesystem entry if whatever `p` points to (a
 * symlink at `p` itself, or at any ancestor directory) is swapped out by a
 * concurrent process between calls. Opening the fd first binds it to one
 * specific inode; everything the caller does afterward via that same fd
 * (`fstatSync`, `readFileSync`) is guaranteed to operate on that exact
 * inode no matter what happens to the path afterward.
 *
 * Node has no cross-platform fd -> realpath call, so the containment check
 * still has to resolve `p` by path — racy relative to the open by itself —
 * but the result is cross-checked against the already-open fd's own
 * `fstatSync` device/inode via `fs.statSync` on the resolved path. A
 * mismatch means the path resolved to something other than what the fd is
 * bound to (i.e. it was repointed between the open and the check), so the
 * candidate is rejected rather than trusted.
 *
 * Returns `null` when `p` can't be opened or isn't a regular file (silent
 * skip, matching the previous pre-check), `'outside-root'` when the
 * validated target doesn't resolve inside `rootReal` (or the identity
 * cross-check fails), or `{ fd, stat }` on success — `stat` is the fd's own
 * `fstatSync`, safe to use for the size check. The caller owns the returned
 * fd and must close it.
 */
function openWithinRoot(rootReal: string, p: string): { fd: number; stat: fs.Stats } | 'outside-root' | null {
  let fd: number
  try {
    fd = fs.openSync(p, 'r')
  } catch {
    return null
  }

  let ownershipTransferred = false
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return null

    let realPath: string
    try {
      realPath = fs.realpathSync(p)
    } catch {
      return 'outside-root'
    }

    if (!isPathWithinRoot(rootReal, realPath)) return 'outside-root'

    let realStat: fs.Stats
    try {
      realStat = fs.statSync(realPath)
    } catch {
      return 'outside-root'
    }
    if (realStat.dev !== stat.dev || realStat.ino !== stat.ino) return 'outside-root'

    ownershipTransferred = true
    return { fd, stat }
  } finally {
    if (!ownershipTransferred) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed or invalid; nothing more to do
      }
    }
  }
}

interface OpenCandidate {
  readonly p: string
  readonly rel: string
  readonly fd: number
  readonly stat: fs.Stats
}

/**
 * Shared by {@link collectFiles} and {@link estimateBudget}: resolve each pattern to its
 * candidate path under `projectRoot`, skip already-`seen` or ignore-matched paths, and
 * validate the survivor doesn't escape the project root via a symlink ({@link openWithinRoot}).
 * Yields an open fd + stat for each valid candidate -- the caller owns the size-limit check
 * (thresholds and skip-message wording differ between the two callers), reading the body, and
 * closing the fd (including via the ignore-match path here, which closes before continuing).
 * `seen` is read-only here; callers add to it themselves once a candidate is fully processed,
 * matching each caller's own "only mark seen on success" contract.
 */
function* resolveOpenCandidates(
  projectRoot: string,
  patterns: string[],
  rootReal: string,
  ignorePatterns: string[] | undefined,
  seen: ReadonlySet<string>,
  skipped: string[],
): Generator<OpenCandidate> {
  for (const pattern of patterns) {
    const p = path.isAbsolute(pattern) ? pattern : path.join(projectRoot, pattern)
    if (seen.has(p)) continue

    let rel: string
    try {
      rel = path.relative(projectRoot, p).replace(/\\/g, '/')
    } catch {
      skipped.push(`${p} (outside project root)`)
      continue
    }

    const opened = openWithinRoot(rootReal, p)
    if (opened === null) continue
    if (opened === 'outside-root') {
      skipped.push(`${rel} (symlink points outside project root)`)
      continue
    }

    if (ignorePatterns && matches(rel, ignorePatterns)) {
      fs.closeSync(opened.fd)
      continue
    }

    yield { p, rel, fd: opened.fd, stat: opened.stat }
  }
}

// Comment stripping patterns
const PY_LINE_COMMENT_RE = /[ \t]*#(?!!)[^\r\n]*/gm
const CSTYLE_BLOCK_RE = /\/\*.*?\*\//gs
const CSTYLE_LINE_RE = /[ \t]*\/\/[^\r\n]*/gm
const SQL_LINE_RE = /[ \t]*--[^\r\n]*/gm
const HASH_LINE_RE = /[ \t]*#(?!!)[^\r\n]*/gm

const CSTYLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.kt', '.swift', '.dart'])
const HASH_COMMENT_EXTS = new Set(['.rb', '.sh', '.bash', '.zsh', '.fish', '.r', '.lua'])

/** Which quote character (if any) is open, tracked as a single running toggle per quote kind. */
interface QuoteState {
  dq: boolean
  sq: boolean
  bt: boolean
}

/**
 * Advances `state` across `text[from, to)`, toggling the appropriate open/closed flag on each
 * unescaped quote character. A backslash is only treated as an escape while immediately followed
 * by another character (mirroring `countUnescapedQuotes`'s consecutive-backslash-parity rule),
 * and is otherwise passed through untouched.
 */
function advanceQuoteState(text: string, from: number, to: number, state: QuoteState): QuoteState {
  let backslashes = 0
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (backslashes % 2 === 0) {
      if (ch === '"') state.dq = !state.dq
      else if (ch === "'") state.sq = !state.sq
      else if (ch === '`') state.bt = !state.bt
    }
    backslashes = 0
  }
  return state
}

/**
 * Precomputes which quote kind(s) are open at the START of every line in `content`, by running
 * `advanceQuoteState` once over the whole file. Needed so `isInsideStringLiteral` below can tell
 * a comment-like sequence sitting inside a multi-line string (one whose opening quote is on an
 * earlier line) from a real comment - without this, per-line quote counting from a fixed
 * "start of line" always looks "not inside a string" for every line after the one the string
 * actually opened on, since none of that line's own characters include the opening quote.
 */
function computeLineStartQuoteStates(content: string): QuoteState[] {
  const states: QuoteState[] = [{ dq: false, sq: false, bt: false }]
  let state: QuoteState = { dq: false, sq: false, bt: false }
  let lineStart = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      state = advanceQuoteState(content, lineStart, i, { ...state })
      states.push({ ...state })
      lineStart = i + 1
    }
  }
  return states
}

/**
 * True when `index` (an offset into `text`) falls inside an opening quoted string, tracking
 * state across line boundaries via `lineStates` (see `computeLineStartQuoteStates`) rather than
 * always assuming "not inside a string" at the start of each line - a multi-line string (e.g. a
 * JS template literal or a Python triple-quoted string) that opened on an earlier line is still
 * open on this one. Single, double, and backtick quotes are tracked independently so a
 * comment-like sequence (`//`, `#`, `--`) that only appears inside a string's actual content — a
 * URL such as `https://example.com` or a CSS hex color like `#fff` — is left untouched instead of
 * being misread as a real comment opener.
 */
function isInsideStringLiteral(text: string, index: number, lineStates: QuoteState[]): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const lineNum = text.slice(0, lineStart).split('\n').length - 1
  const startState = lineStates[lineNum] ?? { dq: false, sq: false, bt: false }
  const state = advanceQuoteState(text, lineStart, index, { ...startState })
  return state.dq || state.sq || state.bt
}

/** Applies a line-comment regex, skipping any match that starts inside a string literal. */
function stripLineComments(content: string, pattern: RegExp, lineStates: QuoteState[]): string {
  return content.replace(pattern, (match, offset: number) =>
    isInsideStringLiteral(content, offset, lineStates) ? match : '',
  )
}

/**
 * Applies a block-comment regex, skipping any match whose opener starts inside a string
 * literal. A block comment can span multiple lines, but isInsideStringLiteral only needs
 * to check the match's start offset: none of the CSTYLE_EXTS/CSS languages allow an unescaped
 * string literal to span multiple lines, so if the block-comment opener is inside a string,
 * the whole match is part of that string's content.
 */
function stripBlockComments(content: string, pattern: RegExp, lineStates: QuoteState[]): string {
  return content.replace(pattern, (match, offset: number) =>
    isInsideStringLiteral(content, offset, lineStates) ? match : '\n'.repeat(match.split('\n').length - 1),
  )
}

export function stripComments(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const lineStates = computeLineStartQuoteStates(content)

  if (ext === '.py') {
    return stripLineComments(content, PY_LINE_COMMENT_RE, lineStates)
  }

  if (ext === '.sql') {
    return stripLineComments(content, SQL_LINE_RE, lineStates)
  }

  if (CSTYLE_EXTS.has(ext)) {
    content = stripBlockComments(content, CSTYLE_BLOCK_RE, lineStates)
    return stripLineComments(content, CSTYLE_LINE_RE, computeLineStartQuoteStates(content))
  }

  if (HASH_COMMENT_EXTS.has(ext)) {
    return stripLineComments(content, HASH_LINE_RE, lineStates)
  }

  if (ext === '.css' || ext === '.scss') {
    return stripBlockComments(content, CSTYLE_BLOCK_RE, lineStates)
  }

  return content
}

// Secret patterns
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['AWS secret key', /(?:aws|AWS).{0,20}secret.{0,20}["']([A-Za-z0-9/+]{40})["']/],
  ['GitHub token', /(?:gh[pousr]_|github_pat_)[A-Za-z0-9]{36,255}/],
  ['Generic API key', /(?:api[_-]?key|apikey|api_secret)[\s"']*[:=][\s"']*([A-Za-z0-9_\\-]{20,})/i],
  ['Bearer token', /(?:authorization):\s*bearer\s+([A-Za-z0-9\-._~+/]+=*)/i],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Stripe key', /sk_(?:live|test)_[A-Za-z0-9]{24,}/],
  ['OpenAI key', /sk-[A-Za-z0-9]{32,}/],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['Google API key', /AIza[0-9A-Za-z\-_]{35}/],
  ['Database URL', /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^:]+:[^@\s]+@[^\s]+/i],
  ['Password literal', /(?:password|passwd|pwd)\s*[:=]\s*["']([^"']{6,})["']/i],
]

const SAFE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.lock'])

export function scanSecrets(files: PackFile[]): SecretHit[] {
  const hits: SecretHit[] = []
  for (const pf of files) {
    if (SAFE_EXTS.has(path.extname(pf.path).toLowerCase())) {
      continue
    }
    for (const [lineno, line] of pf.content.split('\n').entries()) {
      for (const [kind, pattern] of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          const snip = line.trim().slice(0, 80)
          hits.push({
            rel_path: pf.rel_path,
            line: lineno + 1,
            kind,
            snippet: snip,
          })
          break
        }
      }
    }
  }
  return hits
}

export function collectFiles(
  projectRoot: string,
  patterns: string[],
  opts: {
    ignore_patterns?: string[]
    max_file_bytes?: number
    do_strip_comments?: boolean
  } = {},
): PackResult {
  const result: PackResult = { files: [], skipped: [], total_lines: 0, total_tokens: 0 }
  const seen = new Set<string>()
  const rootResolved = path.resolve(projectRoot)
  let rootReal: string
  try {
    rootReal = fs.realpathSync(rootResolved)
  } catch {
    rootReal = rootResolved
  }
  const maxFileBytes = opts.max_file_bytes ?? 2 * 1024 * 1024

  for (const { p, rel, fd, stat } of resolveOpenCandidates(projectRoot, patterns, rootReal, opts.ignore_patterns, seen, result.skipped)) {
    try {
      const size = stat.size
      if (size > maxFileBytes) {
        result.skipped.push(`${rel} (too large: ${Math.floor(size / 1024)}KB)`)
        continue
      }

      let content: string
      try {
        content = fs.readFileSync(fd, 'utf8')
      } catch {
        result.skipped.push(`${rel} (unreadable)`)
        continue
      }

      if (opts.do_strip_comments) {
        content = stripComments(content, p)
      }

      seen.add(p)
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
      const tokens = estimateTokens(content)
      const pf: PackFile = {
        path: p,
        rel_path: rel,
        content,
        lines,
        tokens,
      }
      result.files.push(pf)
      result.total_lines += lines
      result.total_tokens += tokens
    } finally {
      fs.closeSync(fd)
    }
  }

  return result
}

export function collectFromStdin(
  projectRoot: string,
  opts: {
    ignore_patterns?: string[]
    max_file_bytes?: number
    do_strip_comments?: boolean
  } = {},
): PackResult {
  const input = fs.readFileSync(0, 'utf8')
  const paths = input
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0)
  return collectFiles(projectRoot, paths, opts)
}

function addLineNumbers(content: string): string {
  const lines = content.split('\n')
  const width = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(width, ' ')}  ${line}`).join('\n')
}

export function formatMarkdown(
  result: PackResult,
  opts: { line_numbers?: boolean; instruction?: string } = {},
): string {
  const parts: string[] = []
  const n = result.files.length
  const noun = n === 1 ? 'file' : 'files'

  parts.push('# Packed context\n')
  parts.push(`> **${n} ${noun} · ~${result.total_tokens.toLocaleString()} tokens**\n`)

  if (result.files.length > 0) {
    parts.push('>')
    parts.push('> | # | File | Lines | ~Tokens |')
    parts.push('> |---|------|-------|---------|')
    let rowNum = 1
    for (let i = 0; i < result.files.length; i++) {
      const pf = result.files[i]
      if (!pf) continue
      parts.push(
        `> | ${rowNum} | \`${pf.rel_path}\` | ${pf.lines.toLocaleString()} | ${pf.tokens.toLocaleString()} |`,
      )
      rowNum++
    }
    parts.push('')
  }

  if (result.skipped.length > 0) {
    const skipped = result.skipped.slice(0, 3).join(', ')
    const ellipsis = result.skipped.length > 3 ? '...' : ''
    parts.push(`> *Skipped ${result.skipped.length} file(s): ${skipped}${ellipsis}*\n`)
  }

  parts.push('---\n')

  for (let i = 0; i < result.files.length; i++) {
    const pf = result.files[i]
    if (!pf) continue
    const body = opts.line_numbers ? addLineNumbers(pf.content) : pf.content
    const lang = getLang(pf.path)
    parts.push(`## \`${pf.rel_path}\`\n`)
    parts.push(`\`\`\`${lang}`)
    parts.push(body.trimEnd())
    parts.push('```\n')
  }

  if (opts.instruction) {
    parts.push('---\n')
    parts.push('## Instructions\n')
    parts.push(opts.instruction.trimEnd())
    parts.push('')
  }

  return parts.join('\n')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function formatXml(result: PackResult, opts: { line_numbers?: boolean; instruction?: string } = {}): string {
  const parts: string[] = ['<documents>']

  let docNum = 1
  for (let i = 0; i < result.files.length; i++) {
    const pf = result.files[i]
    if (!pf) continue
    const body = opts.line_numbers ? addLineNumbers(pf.content) : pf.content
    const escaped = escapeXml(body)
    parts.push(`<document index="${docNum}">`)
    const escSrc = escapeXml(pf.rel_path)
    parts.push(`<source>${escSrc}</source>`)
    parts.push(`<document_content>\n${escaped}\n</document_content>`)
    parts.push('</document>')
    docNum++
  }

  if (opts.instruction) {
    parts.push(`<document index="${docNum}">`)
    parts.push('<source>instructions</source>')
    const escInst = escapeXml(opts.instruction)
    parts.push(`<document_content>\n${escInst}\n</document_content>`)
    parts.push('</document>')
  }

  parts.push('</documents>')
  return parts.join('\n')
}

export function formatPlain(
  result: PackResult,
  opts: { line_numbers?: boolean; instruction?: string } = {},
): string {
  const sep = '='.repeat(60)
  const parts: string[] = []
  const n = result.files.length
  const noun = n === 1 ? 'file' : 'files'
  parts.push(`${n} ${noun} · ~${result.total_tokens.toLocaleString()} tokens total\n`)

  for (let i = 0; i < result.files.length; i++) {
    const pf = result.files[i]
    if (!pf) continue
    const body = opts.line_numbers ? addLineNumbers(pf.content) : pf.content
    parts.push(sep)
    parts.push(`File: ${pf.rel_path}  (${pf.lines.toLocaleString()} lines, ~${pf.tokens.toLocaleString()} tokens)`)
    parts.push(sep)
    parts.push(body.trimEnd())
    parts.push('')
  }

  if (opts.instruction) {
    parts.push(sep)
    parts.push('Instructions')
    parts.push(sep)
    parts.push(opts.instruction.trimEnd())
    parts.push('')
  }

  return parts.join('\n')
}

export function formatPack(
  result: PackResult,
  style: string,
  opts: { line_numbers?: boolean; instruction?: string } = {},
): string {
  if (style === 'xml') {
    return formatXml(result, opts)
  }
  if (style === 'plain') {
    return formatPlain(result, opts)
  }
  if (style !== 'markdown') {
    throw new Error(`Unknown style ${JSON.stringify(style)}; expected one of: markdown, xml, plain`)
  }
  return formatMarkdown(result, opts)
}

export function estimateBudget(
  projectRoot: string,
  patterns: string[],
  opts: { ignore_patterns?: string[]; max_file_bytes?: number } = {},
): BudgetResult {
  const result: BudgetResult = { entries: [], skipped: [], total_lines: 0, total_tokens: 0 }
  const seen = new Set<string>()
  const rootResolved = path.resolve(projectRoot)
  let rootReal: string
  try {
    rootReal = fs.realpathSync(rootResolved)
  } catch {
    rootReal = rootResolved
  }
  const maxFileBytes = opts.max_file_bytes ?? 10 * 1024 * 1024

  for (const { p, rel, fd, stat } of resolveOpenCandidates(projectRoot, patterns, rootReal, opts.ignore_patterns, seen, result.skipped)) {
    try {
      const size = stat.size
      if (size > maxFileBytes) {
        result.skipped.push(`${rel} (>${Math.floor(maxFileBytes / 1024 / 1024)}MB)`)
        continue
      }

      let lines: number
      let tokens: number
      try {
        const data = fs.readFileSync(fd)
        const sampleSize = Math.min(1000, data.length)
        const sampleLines = (data.toString('utf8', 0, sampleSize).match(/\n/g) || []).length
        lines = data.length > sampleSize ? Math.ceil(sampleLines * (data.length / sampleSize)) : sampleLines + 1
        const tokenSampleSize = Math.min(100000, data.length)
        const text = data.toString('utf8', 0, tokenSampleSize)
        const sampleTokens = estimateTokens(text)
        // Extrapolate the same way `lines` does above -- estimateTokens only saw the first
        // tokenSampleSize bytes, so for a file bigger than that sample this must be scaled up
        // by the truncation ratio or large files silently report a tiny fraction of their real
        // token count (e.g. a 1MB file capped at ~25000 tokens instead of ~255000).
        tokens = data.length > tokenSampleSize ? Math.ceil(sampleTokens * (data.length / tokenSampleSize)) : sampleTokens
      } catch {
        result.skipped.push(`${rel} (unreadable)`)
        continue
      }

      seen.add(p)
      const entry: BudgetEntry = { rel_path: rel, lines, tokens, size_bytes: size }
      result.entries.push(entry)
      result.total_lines += lines
      result.total_tokens += tokens
    } finally {
      fs.closeSync(fd)
    }
  }

  result.entries.sort((a, b) => b.tokens - a.tokens)
  return result
}

export function formatBudgetText(result: BudgetResult, contextK?: number): string {
  if (result.entries.length === 0 && result.skipped.length === 0) {
    return 'No files matched.'
  }

  // Reduce instead of Math.max(...array): spreading a large project's file list as call
  // arguments blows the engine's call-stack limit (RangeError: Maximum call stack size
  // exceeded) well within realistic file counts -- see transcript_extract.ts's durationSeconds
  // for the same fix applied to a different large-array Math.max spread.
  const colW = result.entries.reduce((max, e) => Math.max(max, e.rel_path.length), 4)
  const lines: string[] = [
    `  ${'File'.padEnd(colW, ' ')}  ${'Lines'.padStart(6, ' ')}  ${'~Tokens'.padStart(8, ' ')}`,
    `  ${'-'.repeat(colW)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}`,
  ]

  for (const e of result.entries) {
    lines.push(`  ${e.rel_path.padEnd(colW, ' ')}  ${String(e.lines).padStart(6, ' ')}  ${String(e.tokens).padStart(8, ' ')}`)
  }

  lines.push(`  ${'-'.repeat(colW)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}`)

  let pct = ''
  if (contextK) {
    pct = `  (${Math.round((result.total_tokens / (contextK * 1000)) * 100)}% of ${contextK}K)`
  }
  lines.push(
    `  ${'Total'.padEnd(colW, ' ')}  ${String(result.total_lines).padStart(6, ' ')}  ${String(result.total_tokens).padStart(8, ' ')}${pct}`,
  )

  if (result.skipped.length > 0) {
    const skipped = result.skipped.slice(0, 5).join(', ')
    const ellipsis = result.skipped.length > 5 ? '...' : ''
    lines.push(`\n  Skipped: ${skipped}${ellipsis}`)
  }

  return lines.join('\n')
}
