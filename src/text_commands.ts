/**
 * Text-processing and session/index/config CLI commands (Family C2).
 *
 * Commands: todo, trace, logfold, lockdeps (pure text), note, hot, recent, ignores
 * (session/index/config integration).
 */

import * as fs from 'fs'
import * as path from 'path'

import { walkProject } from './baseline.js'
import { loadConfig } from './config.js'
import { tokenGoatHome } from './disk_cache.js'
import { FILTERS } from './filters.js'
import { canonicalize, findProject } from './project.js'
import { clearAll, loadEntries, setEntry, unsetEntry } from './project_memory.js'
import { getSessionFiles } from './session.js'
import { foldPath } from './util.js'

// ── Shared utilities ────────────────────────────────────────────────────────

function readInput(src: string | undefined): string {
  if (src !== undefined) return fs.readFileSync(src, 'utf8')
  return fs.readFileSync(0, 'utf8')
}

/** Split text into lines, normalizing CRLF. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

// ── todo ────────────────────────────────────────────────────────────────────

const DEFAULT_KINDS = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE']

/** Marker + trailing text captured from a single line. */
interface TodoItem {
  file: string
  line: number
  kind: string
  text: string
}

// Counts quote chars in `text` that are NOT escaped, tracking a running per-char backslash-parity counter rather than a fixed-width regex lookbehind: `(?<!\\)"` only inspects the single char before each quote, so an escaped-backslash-then-quote sequence like `path\\"` (backslash pair, then a real closing quote) undercounts -- it sees the quote preceded by one backslash and treats it as escaped, even though the pair of backslashes means the quote is not actually escaped (even backslash count).
function countUnescapedQuotes(text: string, quoteChar: string): number {
  let count = 0
  let backslashes = 0
  for (const ch of text) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === quoteChar && backslashes % 2 === 0) count++
    backslashes = 0
  }
  return count
}

/** Returns true when markerIndex falls inside an opening string literal on the line. */
function isInsideStringLiteral(line: string, markerIndex: number): boolean {
  const before = line.slice(0, markerIndex)
  const dqCount = countUnescapedQuotes(before, '"')
  const sqCount = countUnescapedQuotes(before, "'")
  return dqCount % 2 !== 0 || sqCount % 2 !== 0
}

/** Escape regex-special characters so a string matches only itself. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scanFileForTodos(filePath: string, kindSet: Set<string>): TodoItem[] {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  // --kinds is documented as a literal, comma-separated list of marker names (TODO, FIXME, ...),
  // not a regex pattern -- escape each value before interpolating so a kind containing
  // regex-special characters (e.g. an unbalanced paren) is matched literally instead of either
  // throwing "Invalid regular expression" or being interpreted as regex syntax.
  const kindPattern = [...kindSet].map(escapeRegExp).join('|')
  const re = new RegExp(`\\b(${kindPattern})\\s*:?\\s*(.*)`, 'i')
  const items: TodoItem[] = []
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = re.exec(line)
    if (m === null) continue
    const idx = m.index ?? 0
    if (isInsideStringLiteral(line, idx)) continue
    items.push({ file: filePath, line: i + 1, kind: m[1]?.toUpperCase() ?? '', text: (m[2] ?? '').trim() })
  }
  return items
}

function collectTodoFiles(patterns: string[]): string[] {
  if (patterns.length > 0) {
    const results: string[] = []
    for (const p of patterns) {
      const abs = path.resolve(p)
      try {
        const stat = fs.statSync(abs)
        if (stat.isDirectory()) {
          results.push(...walkProject(abs).files)
        } else {
          results.push(abs)
        }
      } catch {
        // skip non-existent paths
      }
    }
    return results
  }
  return walkProject(process.cwd()).files
}

export function cmdTodo(
  patterns: string[],
  opts: { group?: string; kinds?: string; json?: boolean },
): void {
  const kindSet = new Set<string>(
    opts.kinds !== undefined && opts.kinds.length > 0
      ? opts.kinds.split(',').map((k) => k.trim().toUpperCase())
      : DEFAULT_KINDS,
  )
  const files = collectTodoFiles(patterns)
  const items: TodoItem[] = []
  for (const f of files) {
    items.push(...scanFileForTodos(f, kindSet))
  }

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ items }, null, 2) + '\n')
    return
  }

  if (items.length === 0) {
    process.stdout.write('No TODO markers found.\n')
    return
  }

  const groupBy = opts.group ?? 'file'
  if (groupBy === 'kind') {
    const byKind = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byKind.get(item.kind) ?? []
      arr.push(item)
      byKind.set(item.kind, arr)
    }
    for (const [kind, group] of byKind) {
      process.stdout.write(`\n[${kind}]\n`)
      for (const item of group) {
        process.stdout.write(`  ${item.file}:${item.line}  ${item.text}\n`)
      }
    }
  } else {
    const byFile = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byFile.get(item.file) ?? []
      arr.push(item)
      byFile.set(item.file, arr)
    }
    for (const [file, group] of byFile) {
      for (const item of group) {
        process.stdout.write(`${file}:${item.line}  ${item.kind}  ${item.text}\n`)
      }
    }
  }
}

// ── trace ───────────────────────────────────────────────────────────────────

interface TraceFrame {
  file: string
  lineNo: number
  func: string
  context?: string
}

interface TraceBlock {
  frames: TraceFrame[]
  exception: string
}

function parseTracebacks(text: string): TraceBlock[] {
  const lines = splitLines(text)
  const blocks: TraceBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^Traceback \(most recent call last\):/.test(lines[i] ?? '')) { i++; continue }
    i++
    const frames: TraceFrame[] = []
    let blockPushed = false
    while (i < lines.length) {
      const fl = lines[i] ?? ''
      const fm = /^\s{2}File "([^"]+)", line (\d+), in (\S+)/.exec(fl)
      if (fm !== null) {
        i++
        const peek = lines[i]?.trim()
        // A frame with no printed source line is immediately followed by the next frame's
        // "File ..." header (or the block's Traceback marker) rather than a context line --
        // in that case leave this frame's context empty instead of consuming/borrowing the
        // next frame's header text.
        const hasContext = peek !== undefined && !peek.startsWith('File ') && !peek.startsWith('Traceback')
        if (hasContext) i++
        frames.push({ file: fm[1] ?? '', lineNo: Number.parseInt(fm[2] ?? '0', 10), func: fm[3] ?? '', context: hasContext ? (peek ?? '') : '' })
        continue
      }
      if (!/^\s/.test(fl) && fl.trim() !== '') {
        blocks.push({ frames, exception: fl.trim() })
        blockPushed = true
        i++
        break
      }
      i++
    }
    // Scoped to THIS block, not the global blocks array: a later traceback whose frames run to
    // EOF with no exception line must still be flushed even though an earlier block already pushed.
    if (frames.length > 0 && !blockPushed) {
      blocks.push({ frames, exception: '' })
    }
  }
  return blocks
}

function isProjectFrame(framePath: string, cwd: string): boolean {
  // Route through canonicalize (project.ts) so a WSL/MSYS-style frame path (e.g.
  // /mnt/c/Projects/token-goat/...) is recognized as the same file as its native
  // Windows drive-letter form, instead of being compared as a raw resolved string.
  // canonicalize only lowercases the drive letter, not the rest of the path, so fold both
  // sides through foldPath (util.ts) to restore case-insensitive comparison on Windows/macOS
  // (matching the platform-gated convention used elsewhere, e.g. isUnderBlockedRoot).
  const normalCwd = foldPath(canonicalize(cwd))
  const normalAbs = foldPath(canonicalize(framePath, cwd))
  if (normalAbs.startsWith(normalCwd)) {
    // Ensure it's a real directory boundary: the path is either exactly the cwd,
    // or the next character after cwd is a path separator. This prevents false matches
    // like /tmp/abc-fork matching /tmp/abc (bug: path-prefix without boundary check).
    if (normalAbs === normalCwd || normalAbs[normalCwd.length] === '/' || normalAbs[normalCwd.length] === '\\') {
      return true
    }
  }
  if (framePath.includes('site-packages') || framePath.includes('lib/python')) return false
  if (/^<.+>$/.test(framePath)) return false
  if (!path.isAbsolute(framePath) && !framePath.startsWith('..')) return true
  return false
}

export function cmdTrace(src: string | undefined, opts: { keep?: string; json?: boolean }): void {
  const text = readInput(src)
  const blocks = parseTracebacks(text)
  if (blocks.length === 0) {
    process.stderr.write('token-goat: no traceback found\n')
    process.exitCode = 0
    return
  }
  const cwd = process.cwd()
  const keepN = opts.keep !== undefined ? Number.parseInt(opts.keep, 10) : 0

  const filtered = blocks.map((b) => {
    let frames = b.frames.filter((f) => isProjectFrame(f.file, cwd))
    if (keepN > 0 && frames.length > keepN) frames = frames.slice(frames.length - keepN)
    return { ...b, frames }
  })

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ tracebacks: filtered }, null, 2) + '\n')
    return
  }

  for (const block of filtered) {
    process.stdout.write('Traceback (most recent call last):\n')
    for (const f of block.frames) {
      process.stdout.write(`  File "${f.file}", line ${f.lineNo}, in ${f.func}\n`)
      if (f.context !== undefined) process.stdout.write(`    ${f.context}\n`)
    }
    if (block.exception) process.stdout.write(`${block.exception}\n`)
    process.stdout.write('\n')
  }
}

// ── logfold ─────────────────────────────────────────────────────────────────

const VOLATILE_SUBS: Array<{ re: RegExp; placeholder: string }> = [
  { re: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, placeholder: '[HH:MM:SS]' },
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, placeholder: '[UUID]' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, placeholder: '[IP]' },
  { re: /\b[0-9a-f]{8,}\b/g, placeholder: '[HEX]' },
]

function normalizeVolatile(line: string): string {
  let out = line
  for (const sub of VOLATILE_SUBS) {
    out = out.replace(sub.re, sub.placeholder)
  }
  return out
}

interface FoldedLine {
  text: string
  count: number
}

function applyFiltersAndFold(lines: string[], noNormalize: boolean): FoldedLine[] {
  const dropped: string[] = []
  for (const raw of lines) {
    let cur: string | null = raw
    for (const filter of FILTERS) {
      if (cur === null) break
      if (filter.pattern !== null && !filter.pattern.test(cur)) continue
      cur = filter.replacer(cur)
      break
    }
    if (cur !== null) dropped.push(cur)
  }

  const folded: FoldedLine[] = []
  let prevKey: string | null = null
  let lastText = ''
  let count = 0

  for (const line of dropped) {
    const key = noNormalize ? line : normalizeVolatile(line)
    if (key === prevKey) {
      count++
    } else {
      if (prevKey !== null) folded.push({ text: lastText, count })
      prevKey = key
      lastText = line
      count = 1
    }
  }
  if (prevKey !== null) folded.push({ text: lastText, count })
  return folded
}

export function cmdLogfold(src: string | undefined, opts: { tail?: string | undefined; noNormalize?: boolean; json?: boolean | undefined }): void {
  const text = readInput(src)
  let lines = splitLines(text)
  if (opts.tail !== undefined) {
    const n = Number.parseInt(opts.tail, 10)
    if (Number.isFinite(n) && n > 0) lines = lines.slice(Math.max(0, lines.length - n))
  }

  const folded = applyFiltersAndFold(lines, opts.noNormalize === true)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ lines: folded }, null, 2) + '\n')
    return
  }

  for (const item of folded) {
    if (item.count > 1) {
      process.stdout.write(`${item.text}  (x${item.count})\n`)
    } else {
      process.stdout.write(`${item.text}\n`)
    }
  }
}

// ── lockdeps ─────────────────────────────────────────────────────────────────

interface DepEntry {
  name: string
  version: string
  kind: 'direct' | 'transitive' | 'unknown'
}

const LOCK_PRIORITY = [
  'package-lock.json',
  'yarn.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
] as const

function findLockfile(startPath: string): { file: string; others: string[] } | null {
  const stat = fs.statSync(startPath, { throwIfNoEntry: false })
  const dir = stat?.isDirectory() !== false && fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath)

  const found: string[] = []
  for (const name of LOCK_PRIORITY) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) found.push(candidate)
  }
  // also look for requirements*.txt
  try {
    const entries = fs.readdirSync(dir)
    for (const e of entries) {
      if (/^requirements.*\.txt$/.test(e)) {
        const p = path.join(dir, e)
        if (!found.includes(p)) found.push(p)
      }
    }
  } catch {
    // ignore
  }

  if (found.length === 0) return null
  const primary = found[0] as string
  return { file: primary, others: found.slice(1) }
}

interface V1PackageLockDependency {
  version?: string
  dev?: boolean
  optional?: boolean
  dependencies?: Record<string, V1PackageLockDependency>
}

// npm v1 lockfiles (lockfileVersion: 1, npm 5/6) have no `packages` map; deps instead
// live in a nested `dependencies` tree. Recursively flatten it into the same DepEntry
// shape the v2/v3 `packages` path produces, so downstream output is format-agnostic.
function collectV1Dependencies(
  deps: Record<string, V1PackageLockDependency>,
  isDirect: boolean,
  out: DepEntry[],
): void {
  for (const [name, val] of Object.entries(deps)) {
    out.push({ name, version: val.version ?? '', kind: isDirect ? 'direct' : 'transitive' })
    if (val.dependencies !== undefined) collectV1Dependencies(val.dependencies, false, out)
  }
}

function parsePackageLockJson(content: string): DepEntry[] {
  const raw = JSON.parse(content) as {
    packages?: Record<string, { version?: string; dev?: boolean; peer?: boolean }>
    name?: string
    dependencies?: Record<string, V1PackageLockDependency>
  }
  if (raw.packages === undefined && raw.dependencies !== undefined) {
    const deps: DepEntry[] = []
    collectV1Dependencies(raw.dependencies, true, deps)
    return deps
  }
  const pkgs = raw.packages ?? {}
  const directDeps = (pkgs[''] as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | undefined) ?? {}
  const allDirect = new Set([
    ...Object.keys(directDeps.dependencies ?? {}),
    ...Object.keys(directDeps.devDependencies ?? {}),
  ])
  const deps: DepEntry[] = []
  for (const [key, val] of Object.entries(pkgs)) {
    if (key === '') continue
    const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key
    const version = (val as { version?: string }).version ?? ''
    deps.push({ name, version, kind: allDirect.has(name) ? 'direct' : 'transitive' })
  }
  return deps
}

function parseYarnLock(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  const headerRe = /^"?(@?[^@"]+)@/
  const versionRe = /^\s{2}version[:\s]+"?([^"\s]+)"?/
  const lines = splitLines(content)
  let pendingName: string | null = null
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) { pendingName = null; continue }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const m = headerRe.exec(line)
      if (m !== null) pendingName = m[1]?.trim() ?? null
      continue
    }
    if (pendingName !== null) {
      const vm = versionRe.exec(line)
      if (vm !== null) {
        deps.push({ name: pendingName, version: vm[1] ?? '', kind: 'unknown' })
        pendingName = null
      }
    }
  }
  return deps
}

function parseTomlPackages(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  const lines = splitLines(content)
  let inPackage = false
  let name = ''
  let version = ''
  for (const line of lines) {
    if (/^\[\[package\]\]/.test(line)) {
      if (inPackage && name) deps.push({ name, version, kind: 'unknown' })
      inPackage = true
      name = ''
      version = ''
      continue
    }
    if (inPackage && /^name\s*=/.test(line)) {
      const m = /=\s*"([^"]+)"/.exec(line)
      if (m !== null) name = m[1] ?? ''
    }
    if (inPackage && /^version\s*=/.test(line)) {
      const m = /=\s*"([^"]+)"/.exec(line)
      if (m !== null) version = m[1] ?? ''
    }
  }
  if (inPackage && name) deps.push({ name, version, kind: 'unknown' })
  return deps
}

function parsePipfileLock(content: string): DepEntry[] {
  const raw = JSON.parse(content) as {
    default?: Record<string, { version?: string }>
    develop?: Record<string, { version?: string }>
  }
  const deps: DepEntry[] = []
  for (const [name, meta] of Object.entries(raw.default ?? {})) {
    deps.push({ name, version: (meta.version ?? '').replace(/^==/, ''), kind: 'direct' })
  }
  for (const [name, meta] of Object.entries(raw.develop ?? {})) {
    deps.push({ name, version: (meta.version ?? '').replace(/^==/, ''), kind: 'direct' })
  }
  return deps
}

function parseRequirementsTxt(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  for (const raw of splitLines(content)) {
    const line = raw.split('#')[0]?.trim() ?? ''
    if (!line || line.startsWith('-')) continue
    const m = /^([A-Za-z0-9_.-]+)\s*(?:[>=!<]+\s*([^\s,;]+))?/.exec(line)
    if (m !== null) {
      deps.push({ name: m[1] ?? '', version: m[2] ?? '', kind: 'unknown' })
    }
  }
  return deps
}

function parseLockFile(filePath: string): { deps: DepEntry[]; format: string } {
  const base = path.basename(filePath)
  const content = fs.readFileSync(filePath, 'utf8')
  if (base === 'package-lock.json') return { format: 'npm', deps: parsePackageLockJson(content) }
  if (base === 'yarn.lock') return { format: 'yarn', deps: parseYarnLock(content) }
  if (base === 'poetry.lock') return { format: 'poetry', deps: parseTomlPackages(content) }
  if (base === 'uv.lock') return { format: 'uv', deps: parseTomlPackages(content) }
  if (base === 'Cargo.lock') return { format: 'cargo', deps: parseTomlPackages(content) }
  if (base === 'Pipfile.lock') return { format: 'pipfile', deps: parsePipfileLock(content) }
  return { format: 'requirements', deps: parseRequirementsTxt(content) }
}

export function cmdLockdeps(filePath: string | undefined, opts: { json?: boolean }): void {
  const target = filePath !== undefined ? path.resolve(filePath) : process.cwd()
  const found = findLockfile(target)
  if (found === null) {
    throw new Error('No lockfile found. Expected one of: ' + LOCK_PRIORITY.join(', ') + ', requirements*.txt')
  }

  const { deps, format } = parseLockFile(found.file)
  const others = found.others

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ file: found.file, format, total: deps.length, others, deps }, null, 2) + '\n')
    return
  }

  process.stdout.write(`Lockfile: ${found.file}  (${format})\n`)
  if (others.length > 0) process.stdout.write(`Other lockfiles found (not parsed): ${others.join(', ')}\n`)
  process.stdout.write(`Total: ${deps.length} packages\n\n`)
  for (const dep of deps) {
    const kindLabel = dep.kind === 'unknown' ? '' : `  (${dep.kind})`
    process.stdout.write(`${dep.name}  ${dep.version}${kindLabel}\n`)
  }
}

// ── note ─────────────────────────────────────────────────────────────────────

function resolveProjectHash(): string {
  const project = findProject(process.cwd())
  if (project === null) throw new Error('No project root found from cwd. Is this inside a project (git repo, package.json, etc.)?')
  return project.hash
}

export function cmdNote(
  action: string,
  key: string | undefined,
  value: string | undefined,
  opts: { json?: boolean },
): void {
  const act = action.toLowerCase()

  if (act === 'list') {
    const hash = resolveProjectHash()
    const entries = loadEntries(hash)
    if (opts.json === true) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n')
    } else {
      const pairs = Object.entries(entries)
      if (pairs.length === 0) {
        process.stdout.write('(no notes set)\n')
      } else {
        for (const [k, v] of pairs) {
          process.stdout.write(`${k} = ${v}\n`)
        }
      }
    }
    return
  }

  if (act === 'clear') {
    const hash = resolveProjectHash()
    clearAll(hash)
    process.stdout.write('Cleared all notes for this project.\n')
    return
  }

  if (act === 'get') {
    if (key === undefined) throw new Error('note get requires a key')
    const hash = resolveProjectHash()
    const entries = loadEntries(hash)
    const v = entries[key]
    if (v === undefined) throw new Error(`Key not found: ${key}`)
    process.stdout.write(v + '\n')
    return
  }

  if (act === 'unset') {
    if (key === undefined) throw new Error('note unset requires a key')
    const hash = resolveProjectHash()
    unsetEntry(hash, key)
    process.stdout.write(`Unset: ${key}\n`)
    return
  }

  if (act === 'set') {
    if (key === undefined) throw new Error('note set requires a key')
    if (value === undefined) throw new Error('note set requires a value')
    const hash = resolveProjectHash()
    setEntry(hash, key, value)
    process.stdout.write(`Set: ${key} = ${value}\n`)
    return
  }

  throw new Error(`Unknown note action: ${action}. Use: set, get, unset, list, clear`)
}

// ── hot ──────────────────────────────────────────────────────────────────────

interface HotEntry {
  path: string
  readCount: number
}

function loadAllSessionReadCounts(): Map<string, number> {
  const sessionsDir = path.join(tokenGoatHome(), 'sessions')
  const totals = new Map<string, number>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return totals
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(sessionsDir, entry.name)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    const files = (raw as Record<string, unknown>)['files']
    if (!Array.isArray(files)) continue
    for (const f of files) {
      if (f === null || typeof f !== 'object') continue
      const fp = (f as Record<string, unknown>)['path']
      const rc = (f as Record<string, unknown>)['readCount']
      if (typeof fp !== 'string' || typeof rc !== 'number') continue
      totals.set(fp, (totals.get(fp) ?? 0) + rc)
    }
  }
  return totals
}

export function cmdHot(opts: { limit?: string; project?: boolean; json?: boolean }): void {
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20
  const totals = loadAllSessionReadCounts()

  let entries: HotEntry[] = [...totals.entries()].map(([p, rc]) => ({ path: p, readCount: rc }))

  if (opts.project === true) {
    const project = findProject(process.cwd())
    if (project !== null) {
      const root = project.root.toLowerCase()
      entries = entries.filter((e) => {
        const normalPath = e.path.toLowerCase()
        // Ensure it's a real directory boundary: the path is either exactly root,
        // or the next character after root is a path separator. This prevents false matches
        // like /tmp/abc-fork matching /tmp/abc (bug: path-prefix without boundary check).
        if (!normalPath.startsWith(root)) return false
        if (normalPath === root) return true
        const nextChar = normalPath[root.length]
        return nextChar === '/' || nextChar === '\\'
      })
    }
  }

  entries.sort((a, b) => b.readCount - a.readCount)
  if (limit > 0) entries = entries.slice(0, limit)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n')
    return
  }

  if (entries.length === 0) {
    process.stdout.write('No session read data found.\n')
    return
  }

  for (const e of entries) {
    process.stdout.write(`${e.readCount}\t${e.path}\n`)
  }
}

// ── recent ──────────────────────────────────────────────────────────────────

interface RecentEntry {
  path: string
  readCount: number
  lastReadAt: number
  wasEdited: boolean
}

export function cmdRecent(nStr: string | undefined, opts: { json?: boolean }): void {
  const n = nStr !== undefined ? Number.parseInt(nStr, 10) : 20
  const sessionFiles = getSessionFiles()

  const entries: RecentEntry[] = [...sessionFiles.values()]
    .map((e) => ({ path: e.path, readCount: e.readCount, lastReadAt: e.lastReadAt, wasEdited: e.wasEdited }))
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
    .slice(0, n > 0 ? n : 20)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ entries, scope: 'current-session' }, null, 2) + '\n')
    return
  }

  process.stdout.write('# Recent files (current session only — use `token-goat hot` for cross-session)\n')
  if (entries.length === 0) {
    process.stdout.write('No files read in this session yet.\n')
    return
  }
  for (const e of entries) {
    const edited = e.wasEdited ? '  [edited]' : ''
    const ts = new Date(e.lastReadAt).toISOString()
    process.stdout.write(`${ts}  ${e.path}${edited}\n`)
  }
}

// ── ignores ──────────────────────────────────────────────────────────────────

interface IgnoresReport {
  walkMode: 'git' | 'non-git'
  gitIgnoreActive: boolean
  nonGitBuiltins: string[]
  blockedRoots: string[]
  excludeTests: boolean
}

function detectWalkMode(cwd: string): 'git' | 'non-git' {
  const project = findProject(cwd)
  if (project?.marker === '.git') return 'git'
  // walk up to see if there's a .git folder
  let cur = cwd
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return 'git'
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return 'non-git'
}

export function cmdIgnores(opts: { json?: boolean }): void {
  const cwd = process.cwd()
  const cfg = loadConfig()
  const walkMode = detectWalkMode(cwd)
  const nonGitBuiltins = ['.env', '.env.*', '*.d.ts']

  const report: IgnoresReport = {
    walkMode,
    gitIgnoreActive: walkMode === 'git',
    nonGitBuiltins: walkMode === 'non-git' ? nonGitBuiltins : [],
    blockedRoots: cfg.worker.blocked_roots,
    excludeTests: cfg.repomap.exclude_tests,
  }

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  process.stdout.write(`Walk mode: ${walkMode}\n`)
  if (walkMode === 'git') {
    process.stdout.write('Git mode: .gitignore exclusions are active (via git ls-files).\n')
  } else {
    process.stdout.write('Non-git walk mode. Built-in exclusions: .env, .env.*, *.d.ts\n')
  }
  if (cfg.worker.blocked_roots.length > 0) {
    process.stdout.write(`Blocked roots (config): ${cfg.worker.blocked_roots.join(', ')}\n`)
  } else {
    process.stdout.write('Blocked roots (config): none\n')
  }
  process.stdout.write(`Exclude tests from repomap: ${cfg.repomap.exclude_tests}\n`)
}
