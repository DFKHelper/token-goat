// Bundle project files into a single LLM-ready output with token estimates.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as minimatch from 'minimatch'

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

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4))
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

// Comment stripping patterns
const PY_LINE_COMMENT_RE = /[ \t]*#(?!!)[^\r\n]*/gm
const CSTYLE_BLOCK_RE = /\/\*.*?\*\//gs
const CSTYLE_LINE_RE = /[ \t]*\/\/[^\r\n]*/gm
const SQL_LINE_RE = /[ \t]*--[^\r\n]*/gm
const HASH_LINE_RE = /[ \t]*#(?!!)[^\r\n]*/gm

const CSTYLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.kt', '.swift', '.dart'])
const HASH_COMMENT_EXTS = new Set(['.rb', '.sh', '.bash', '.zsh', '.fish', '.r', '.lua'])

export function stripComments(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.py') {
    return content.replace(PY_LINE_COMMENT_RE, '')
  }

  if (ext === '.sql') {
    return content.replace(SQL_LINE_RE, '')
  }

  if (CSTYLE_EXTS.has(ext)) {
    content = content.replace(CSTYLE_BLOCK_RE, (match) => '\n'.repeat(match.split('\n').length - 1))
    return content.replace(CSTYLE_LINE_RE, '')
  }

  if (HASH_COMMENT_EXTS.has(ext)) {
    return content.replace(HASH_LINE_RE, '')
  }

  if (ext === '.css' || ext === '.scss') {
    return content.replace(CSTYLE_BLOCK_RE, (match) => '\n'.repeat(match.split('\n').length - 1))
  }

  return content
}

// Secret patterns
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['AWS secret key', /(?:aws|AWS).{0,20}secret.{0,20}["']([A-Za-z0-9/+]{40})["']/],
  ['GitHub token', /(?:gh[pousr]_|github_pat_)[A-Za-z0-9]{36,255}/],
  ['Generic API key', /(?:api[_-]?key|apikey|api_secret)["\\s]*[:=]["\\s]*([A-Za-z0-9_\\-]{20,})/i],
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
  const maxFileBytes = opts.max_file_bytes ?? 2 * 1024 * 1024

  for (const pattern of patterns) {
    const candidates: string[] = []

    if (path.isAbsolute(pattern)) {
      candidates.push(pattern)
    } else {
      candidates.push(path.join(projectRoot, pattern))
    }

    for (const p of candidates) {
      try {
        if (!fs.statSync(p).isFile()) continue
      } catch {
        continue
      }

      if (seen.has(p)) continue

      let rel: string
      try {
        rel = path.relative(projectRoot, p).replace(/\\/g, '/')
      } catch {
        result.skipped.push(`${p} (outside project root)`)
        continue
      }

      try {
        const resolved = path.resolve(p)
        path.relative(rootResolved, resolved)
        if (resolved.includes('..')) {
          result.skipped.push(`${rel} (symlink points outside project root)`)
          continue
        }
      } catch {
        result.skipped.push(`${rel} (symlink points outside project root)`)
        continue
      }

      if (opts.ignore_patterns && matches(rel, opts.ignore_patterns)) {
        continue
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(p)
      } catch {
        result.skipped.push(`${rel} (unreadable)`)
        continue
      }

      const size = stat.size
      if (size > maxFileBytes) {
        result.skipped.push(`${rel} (too large: ${Math.floor(size / 1024)}KB)`)
        continue
      }

      let content: string
      try {
        content = fs.readFileSync(p, 'utf8')
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

export function formatXml(result: PackResult, opts: { line_numbers?: boolean; instruction?: string } = {}): string {
  const parts: string[] = ['<documents>']

  let docNum = 1
  for (let i = 0; i < result.files.length; i++) {
    const pf = result.files[i]
    if (!pf) continue
    const body = opts.line_numbers ? addLineNumbers(pf.content) : pf.content
    const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    parts.push(`<document index="${docNum}">`)
    const escSrc = pf.rel_path.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    parts.push(`<source>${escSrc}</source>`)
    parts.push(`<document_content>\n${escaped}\n</document_content>`)
    parts.push('</document>')
    docNum++
  }

  if (opts.instruction) {
    parts.push(`<document index="${docNum}">`)
    parts.push('<source>instructions</source>')
    const escInst = opts.instruction.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  const maxFileBytes = opts.max_file_bytes ?? 10 * 1024 * 1024

  for (const pattern of patterns) {
    const candidates: string[] = []

    if (path.isAbsolute(pattern)) {
      candidates.push(pattern)
    } else {
      candidates.push(path.join(projectRoot, pattern))
    }

    for (const p of candidates) {
      try {
        if (!fs.statSync(p).isFile()) continue
      } catch {
        continue
      }

      if (seen.has(p)) continue

      let rel: string
      try {
        rel = path.relative(projectRoot, p).replace(/\\/g, '/')
      } catch {
        result.skipped.push(`${p} (outside project root)`)
        continue
      }

      try {
        const resolved = path.resolve(p)
        path.relative(rootResolved, resolved)
        if (resolved.includes('..')) {
          result.skipped.push(`${rel} (symlink points outside project root)`)
          continue
        }
      } catch {
        result.skipped.push(`${rel} (symlink points outside project root)`)
        continue
      }

      if (opts.ignore_patterns && matches(rel, opts.ignore_patterns)) {
        continue
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(p)
      } catch {
        result.skipped.push(`${rel} (stat error)`)
        continue
      }

      const size = stat.size
      if (size > maxFileBytes) {
        result.skipped.push(`${rel} (>${Math.floor(maxFileBytes / 1024 / 1024)}MB)`)
        continue
      }

      let lines: number
      let tokens: number
      try {
        const data = fs.readFileSync(p)
        lines = (data.toString('utf8', 0, Math.min(1000, data.length)).match(/\n/g) || []).length + 1
        const text = data.toString('utf8', 0, Math.min(100000, data.length))
        tokens = estimateTokens(text)
      } catch {
        result.skipped.push(`${rel} (unreadable)`)
        continue
      }

      seen.add(p)
      const entry: BudgetEntry = { rel_path: rel, lines, tokens, size_bytes: size }
      result.entries.push(entry)
      result.total_lines += lines
      result.total_tokens += tokens
    }
  }

  result.entries.sort((a, b) => b.tokens - a.tokens)
  return result
}

export function formatBudgetText(result: BudgetResult, contextK?: number): string {
  if (result.entries.length === 0 && result.skipped.length === 0) {
    return 'No files matched.'
  }

  const colW = Math.max(
    4,
    Math.max(...result.entries.map((e) => e.rel_path.length)),
  )
  const lines: string[] = [
    `  ${'File'.padEnd(colW, ' ')}  ${'Lines'.padStart(6, ' ')}  ${'~Tokens'.padStart(8, ' ')}`,
    `  ${'-'.repeat(colW)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}`,
  ]

  for (const e of result.entries) {
    lines.push(`  ${e.rel_path.padEnd(colW, ' ')}  ${String(e.lines).padStart(6, ' ')},  ${String(e.tokens).padStart(8, ' ')},`)
  }

  lines.push(`  ${'-'.repeat(colW)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}`)

  let pct = ''
  if (contextK) {
    pct = `  (${Math.round((result.total_tokens / (contextK * 1000)) * 100)}% of ${contextK}K)`
  }
  lines.push(
    `  ${'Total'.padEnd(colW, ' ')}  ${String(result.total_lines).padStart(6, ' ')},  ${String(result.total_tokens).padStart(8, ' ')},${pct}`,
  )

  if (result.skipped.length > 0) {
    const skipped = result.skipped.slice(0, 5).join(', ')
    const ellipsis = result.skipped.length > 5 ? '...' : ''
    lines.push(`\n  Skipped: ${skipped}${ellipsis}`)
  }

  return lines.join('\n')
}
