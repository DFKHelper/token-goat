/**
 * CLI entrypoint (`token-goat ...`).
 *
 * Wires the surgical-read commands (symbol / read / section / skeleton /
 * outline / map / semantic), the hook relay, and the install / worker
 * lifecycle subcommands onto a Commander program. Every command resolves to a
 * small text payload on stdout and an exit code: 0 on success, 1 on a handled
 * error (missing symbol, unreadable file). Unexpected throws also map to 1.
 *
 * This is the TS analogue of `cli.py::main`; it targets the subset of commands
 * exercised by the TS port rather than the full Python surface.
 */

import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'

import { buildProjectMap, formatProjectMap } from './baseline.js'
import { buildCompactMap, formatMap, getTrackedFiles } from './repomap.js'
import { collectWalkIndexFiles } from './walk_index.js'
import { globalDbPath, VERSION } from './constants.js'
import { getSessionFiles } from './session.js'
import { searchSymbolsFts } from './index_reader.js'
import { indexFileSync } from './parser.js'
import { pruneDeletedFiles } from './index_prune.js'
import { detectLanguage } from './parser_types.js'
import { resolveIndexPath } from './paths.js'
import type { SymbolEntry } from './parser_types.js'
import { relay } from './relay.js'
import { installHooks, uninstallHooks } from './install.js'
import type { HookScope } from './install.js'
import { isWorkerRunning, startDetachedWorker, stopWorker } from './worker.js'
import { getBashOutput } from './bash_output_cache.js'
import { getWebOutput } from './web_cache.js'
import * as bashRunner from './bash_runner.js'
import {
  runSymbol,
  runRead,
  runSection,
  runRefs,
  runSkeleton,
  runOutline,
  runChanged,
  runConfigGet,
  runExports,
  runImports,
  runFind,
  runGrep,
} from './read_commands.js'
import { getSkillFilePath, listSkills, storeCompact } from './skill_cache.js'
import { isWindows, ensureNewline, extractErrorMessage } from './util.js'
import { renderStats } from './stats.js'
import { runDoctorAndExit } from './cli_doctor.js'
import { getDocSections, formatSections, getSectionContent } from './gdrive.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. */
class CliError extends Error {}

function out(text: string): void {
  process.stdout.write(ensureNewline(text))
}

function err(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/** First `n` lines of a body, for the symbol-search preview. */
function previewLines(body: string, n: number): string {
  return body.split(/\r?\n/).slice(0, n).join('\n')
}

/** `name (kind) — file:start-end` header line for a symbol. */
function symbolHeader(s: SymbolEntry): string {
  return `# ${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}-${s.lineEnd}`
}

// --- Command handlers -------------------------------------------------------

function cmdSemantic(query: string, opts: { limit?: string }): void {
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20
  // No embeddings table in this port → fall back to FTS over symbol names/bodies.
  const results = searchSymbolsFts(query, Number.isFinite(limit) ? limit : 20)
  if (results.length === 0) {
    throw new CliError(`no matches for '${query}'`)
  }
  const blocks = results.map((s) => `${symbolHeader(s)}\n${previewLines(s.body, 3)}`)
  out(blocks.join('\n\n'))
}

export function cmdIndex(pathArg?: string, opts: { walk?: boolean; dbPath?: string } = {}): void {
  const root = pathArg ?? process.cwd()
  const dbPath = opts.dbPath ?? globalDbPath()
  let files = getTrackedFiles(root)
  if (files.length === 0) {
    if (opts.walk !== true) {
      throw new CliError(
        `no tracked files found under '${root}' (is it a git repo?). ` +
          `Pass --walk to index a non-git folder.`,
      )
    }
    // Opt-in non-git fallback: a bounded directory walk, guarded against over-broad roots / oversized trees and stripped of .env / generated files.
    files = collectWalkIndexFiles(root)
  }
  let indexed = 0
  for (const f of files) {
    // Key on the same canonical absolute-normalized path every reader resolves to via resolveIndexPath. getTrackedFiles returns path.join(root, rel), so a relative root (the natural `token-goat index .`) yields relative paths; normalizePath alone would store a relative key that no reader can match.
    const key = resolveIndexPath(f)
    if (detectLanguage(key) === 'unknown') continue
    indexFileSync(key, dbPath)
    indexed += 1
  }
  const pruned = pruneDeletedFiles(resolveIndexPath(root), dbPath)
  out(`Indexed ${indexed} files into the symbol index.${pruned > 0 ? ` Pruned ${pruned} deleted file(s).` : ''}`)
}

function cmdMap(opts: { compact?: boolean }): void {
  const compact = opts.compact === true
  if (compact) {
    const entries = buildCompactMap(2000, process.cwd())
    out(formatMap(entries, { compact: true }))
  } else {
    const map = buildProjectMap(process.cwd(), { compact: false })
    out(formatProjectMap(map, false))
  }
}

async function cmdHook(event: string): Promise<void> {
  // relay handles its own stdin read / stdout write and never throws on a malformed/unknown event — it emits `{}` and returns.
  await relay(event)
}

function cmdInstall(opts: { project?: boolean }): void {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const result = installHooks(scope)
  out(`Installed token-goat hooks (${scope}) → ${result.settingsPath}`)
}

function cmdUninstall(opts: { project?: boolean }): void {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const removed = uninstallHooks(scope)
  out(removed ? `Removed token-goat hooks (${scope}).` : `No token-goat hooks to remove (${scope}).`)
}

function cmdWorkerStart(): void {
  if (isWorkerRunning()) {
    out('Worker already running.')
    return
  }
  const pid = startDetachedWorker()
  out(`Worker started (pid ${pid}).`)
}

function cmdWorkerStop(): void {
  const stopped = stopWorker()
  out(stopped ? 'Worker stopped.' : 'No running worker.')
}

function cmdWorkerStatus(): void {
  out(isWorkerRunning() ? 'Worker is running.' : 'Worker is not running.')
}

function cmdStats(): void {
  renderStats({ windowDays: 30 })
}

function cmdDoctor(): void {
  const code = runDoctorAndExit()
  if (code !== 0) {
    throw new CliError('doctor checks failed')
  }
}

function _applyFiltersAndPrint(
  content: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string },
): void {
  if (opts.grep !== undefined) {
    let pattern = opts.grep
    // Normalize pattern to handle -E or --extended-regexp prefix
    if (pattern.startsWith('-E ') || pattern.startsWith('--extended-regexp ')) {
      pattern = pattern.replace(/^(?:-E\s+|--extended-regexp\s+)/, '')
    }
    try {
      const re = new RegExp(pattern)
      content = content
        .split(/\r?\n/)
        .filter((line) => re.test(line))
        .join('\n')
    } catch {
      content = content
        .split(/\r?\n/)
        .filter((line) => line.includes(pattern))
        .join('\n')
    }
  }

  const lines = content.split(/\r?\n/)
  const headN = opts.head ? (() => { const n = Number.parseInt(opts.head, 10); return Number.isFinite(n) && n > 0 ? n : 30 })() : 30
  const tailN = opts.tail ? (() => { const n = Number.parseInt(opts.tail, 10); return Number.isFinite(n) && n > 0 ? n : 80 })() : 80

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN + 1 ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

  let result = lines
  if (opts.head === undefined && opts.tail === undefined && opts.grep === undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
  }

  out(result.join('\n'))
}

function cmdBashOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; file?: string },
): void {
  if (opts.file !== undefined) {
    if (opts.file.includes('\0')) {
      throw new CliError('--file path contains a null byte')
    }
    if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(opts.file) && process.stdin.isTTY) {
      throw new CliError('--file /dev/stdin requires piped input; redirect a file instead')
    }
    let content: string
    try {
      const st = fs.statSync(opts.file)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--file '${opts.file}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      content = fs.readFileSync(opts.file, 'utf-8')
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`cannot read file: ${opts.file}`)
    }
    _applyFiltersAndPrint(content, opts)
    return
  }

  if (id === undefined) {
    throw new CliError('provide an <id> or --file <path>')
  }

  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached bash output for id: ${id}`)
  }

  _applyFiltersAndPrint(entry.output, opts)
}

function cmdWebOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string },
): void {
  if (id === undefined) {
    throw new CliError('provide a web cache <id>')
  }
  const content = getWebOutput(id)
  if (content === null) {
    throw new CliError(`no cached web output for id: ${id}`)
  }
  _applyFiltersAndPrint(content, opts)
}

/**
 * Adapter for read_commands `run*` handlers, which print their own output and
 * return an exit code (0 ok, 1 handled error) rather than throwing a CliError.
 * Maps the return code onto `process.exitCode`; an unexpected throw still maps
 * to a stderr line + exit 1, matching the `guard` contract.
 */
function runExit(fn: () => number): void {
  try {
    process.exitCode = fn()
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

// Sets process.exitCode to the wrapped command's exit code (NOT via `guard`, which forces 0 on success — compress must propagate the real code so shell chaining still sees the original failure/success signal).
function cmdCompress(opts: {
  cmd: string
  filter?: string
  timeout?: string
  compress?: boolean
  profile?: string
  maxTokens?: string
}): void {
  try {
    if (opts.compress === false) {
      // Commander maps `--no-compress` to `opts.compress === false`.
      process.exitCode = bashRunner.runRaw(opts.cmd, parseTimeout(opts.timeout))
      return
    }
    const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) || 0 : 0
    process.exitCode = bashRunner.run(opts.cmd, {
      filterName: opts.filter,
      timeout: parseTimeout(opts.timeout),
      maxTokens,
      ...(opts.profile !== undefined ? { compressionProfile: opts.profile } : {}),
    })
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

/** Resolve the --timeout flag (seconds): 0/absent/invalid → the built-in default. */
function parseTimeout(raw: string | undefined): number {
  const sec = raw ? parseInt(raw, 10) : 0
  return Number.isFinite(sec) && sec > 0 ? sec : bashRunner.DEFAULT_TIMEOUT_SECONDS
}

async function cmdSkillBody(name: string, opts: { compact?: boolean }): Promise<void> {
  const filePath = await getSkillFilePath(name)
  if (filePath === null) {
    throw new CliError(`skill '${name}' not found`)
  }

  const body = fs.readFileSync(filePath, 'utf-8')
  if (opts.compact === true) {
    const lines = body.split('\n')
    const end = lines.findIndex((l) => l.includes('COMPACT_END'))
    if (end !== -1) {
      out(lines.slice(end + 1).join('\n'))
    } else {
      out(body)
    }
  } else {
    out(body)
  }
}

async function cmdSkillCompact(name: string): Promise<void> {
  const filePath = await getSkillFilePath(name)
  if (filePath === null) {
    throw new CliError(`skill '${name}' not found`)
  }

  const body = fs.readFileSync(filePath, 'utf-8')
  const sessionFiles = getSessionFiles()
  const sessionId = Array.from(sessionFiles.keys())[0] ?? 'default'
  await storeCompact(sessionId, name, body)
  out(`Cached compact for skill '${name}'.`)
}

async function cmdSkillList(opts: { json?: boolean; sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  if (opts.json === true) {
    const json = skills.map((s) => ({
      name: s.name,
      body_bytes: s.bodyLen,
      compact_bytes: s.compactLen,
      has_marker: s.hasMarker,
    }))
    out(JSON.stringify(json, null, 2))
  } else {
    const lines = skills.map((s) => {
      const compact = s.compactLen > 0 ? ` (compact: ${s.compactLen})` : ''
      return `${s.name}: ${s.bodyLen} bytes${compact}`
    })
    out(lines.join('\n'))
  }
}

async function cmdSkillSize(opts: { sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  let totalBody = 0
  let totalCompact = 0
  for (const skill of skills) {
    totalBody += skill.bodyLen
    totalCompact += skill.compactLen
  }
  const lines = [
    `# token-goat skill cache (${skills.length} skills)`,
    `Body:    ${totalBody} bytes`,
    `Compact: ${totalCompact} bytes`,
  ]
  out(lines.join('\n'))
}

function atomicWriteBuffer(dest: string, data: Buffer): void {
  try {
    if (fs.statSync(dest).isDirectory()) {
      const e = Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${dest}'`), { code: 'EISDIR', path: dest }) as NodeJS.ErrnoException
      throw e
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // Place tmp in same directory as dest so rename is always same-device (avoids EXDEV); include random suffix to eliminate PID-reuse collisions.
  const rnd = Math.random().toString(36).slice(2, 8)
  const tmp = path.join(path.dirname(path.resolve(dest)), `.tmp.${process.pid}.${rnd}`)
  try {
    // mode 0o600 applies on POSIX only; on Windows Node.js ignores it and the tmp file inherits the default ACL.
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    try {
      fs.renameSync(tmp, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        // copyFileSync is non-atomic; EXDEV should not occur normally (tmp is same-dir) but can appear on overlay/bind-mount filesystems.
        fs.copyFileSync(tmp, dest)
        try { fs.unlinkSync(tmp) } catch (ue) {
          process.stderr.write(`token-goat write-file: warning: could not remove temp file ${tmp}: ${(ue as NodeJS.ErrnoException).message}\n`)
        }
      } else {
        throw e
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore cleanup failure */ }
    throw e
  }
}

function mapFsError(e: unknown, src?: string, dest?: string): never {
  const fe = e as NodeJS.ErrnoException
  if (fe.code === 'ENOENT') {
    const errPath = fe.path ?? ''
    const isSource = src !== undefined && path.resolve(errPath) === path.resolve(src)
    if (isSource) throw new CliError(`source file not found: ${src}`)
    // Always show the destination directory, never the internal .tmp path
    const destDir = dest ? path.dirname(path.resolve(dest)) : path.dirname(path.resolve(errPath || '.'))
    throw new CliError(`destination directory does not exist: ${destDir}`)
  }
  if (fe.code === 'ENOTDIR') {
    throw new CliError(`destination path contains a file where a directory was expected: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EISDIR') {
    const errPath = fe.path ?? ''
    // Windows: readFileSync on a directory yields e.path===undefined (atomicWriteBuffer always sets e.path=dest); empty errPath with a src arg means the source was the directory.
    const isSource = src !== undefined && (errPath === '' || path.resolve(errPath) === path.resolve(src))
    if (isSource) throw new CliError(`source is a directory, not a file: ${src}`)
    throw new CliError(`destination is a directory, not a file: ${dest ?? (errPath || '(unknown)')}`)
  }
  if (fe.code === 'EACCES' || fe.code === 'EPERM') {
    throw new CliError(`permission denied writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EROFS') {
    throw new CliError(`filesystem is read-only: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENOSPC') {
    throw new CliError(`no space left on device writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ELOOP') {
    throw new CliError(`too many levels of symbolic links resolving: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENAMETOOLONG') {
    throw new CliError(`path is too long: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EMFILE' || fe.code === 'ENFILE') {
    throw new CliError(`too many open files; close other processes or raise the file-descriptor limit and retry`)
  }
  if (fe.code === 'ETXTBSY') {
    throw new CliError(`file is in use by a running process: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EDQUOT') {
    throw new CliError(`disk quota exceeded writing to: ${dest ?? fe.path ?? ''}`)
  }
  throw e
}

// Windows reserved device names — writes to these are silently discarded or misrouted.
const WIN_RESERVED = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
  'CONIN$','CONOUT$',
])

function cmdWriteFile(dest: string, opts: { from?: string; b64?: string }): Promise<void> | void {
  if (!dest || !dest.trim()) {
    throw new CliError('destination path cannot be empty')
  }
  if (dest.includes('\0')) {
    throw new CliError('destination path contains a null byte')
  }
  if (isWindows()) {
    const base = path.basename(dest)
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase()
    if (WIN_RESERVED.has(stem)) {
      throw new CliError(`destination '${base}' is a reserved Windows device name`)
    }
    if (base.endsWith('.') || base.endsWith(' ')) {
      throw new CliError(`destination filename '${base}' ends with '${base.slice(-1)}' — Windows NTFS silently strips trailing dots and spaces, which would clobber a different file`)
    }
  }
  if (opts.from !== undefined && opts.b64 !== undefined) {
    throw new CliError('cannot use --from and --b64 together')
  }
  if (opts.from !== undefined) {
    if (!opts.from.trim()) {
      throw new CliError('--from path cannot be empty')
    }
    if (opts.from.includes('\0')) {
      throw new CliError('--from path contains a null byte')
    }
    // On POSIX, /dev/stdin blocks forever when the process is attached to a TTY.
    if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(opts.from) && process.stdin.isTTY) {
      throw new CliError('--from /dev/stdin requires piped input; use piped stdin mode or --b64 for interactive use')
    }
    try {
      const st = fs.statSync(opts.from)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--from '${opts.from}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      const maxFromMB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
      if (!Number.isFinite(maxFromMB) || maxFromMB <= 0) {
        throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
      }
      const maxFromBytes = maxFromMB * 1024 * 1024
      if (st.size > maxFromBytes) {
        throw new CliError(`--from source exceeds size limit (${Math.round(st.size / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`)
      }
      atomicWriteBuffer(dest, fs.readFileSync(opts.from))
    } catch (e) {
      if (e instanceof CliError) throw e
      mapFsError(e, opts.from, dest)
    }
    return
  }
  if (opts.b64 !== undefined) {
    // Strip whitespace (newlines from openssl/base64 CLI output) before url-safe normalization
    const normalized = opts.b64.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
    if (opts.b64 !== '' && normalized === '') {
      throw new CliError('--b64 payload contains only whitespace — likely a shell expansion error; pass an empty string explicitly for a zero-byte file')
    }
    const maxB64MB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
    if (!Number.isFinite(maxB64MB) || maxB64MB <= 0) {
      throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
    }
    const maxB64Bytes = maxB64MB * 1024 * 1024
    const decodedSize = Math.floor((normalized.replace(/=+$/, '').length * 3) / 4)
    if (decodedSize > maxB64Bytes) {
      throw new CliError(`--b64 payload would decode to ${Math.round(decodedSize / 1024 / 1024)} MB which exceeds size limit; set TOKEN_GOAT_MAX_STDIN_MB to override`)
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new CliError('--b64 payload contains non-base64 characters — check for shell expansion of $VAR or backticks')
    }
    // A single trailing data character (length % 4 === 1 after stripping padding) is always invalid; Buffer.from silently drops it, producing a corrupt or empty file.
    if (normalized.replace(/=+$/, '').length % 4 === 1) {
      throw new CliError('--b64 payload length is invalid (trailing single base64 character cannot decode to any bytes — payload is likely truncated)')
    }
    try {
      atomicWriteBuffer(dest, Buffer.from(normalized, 'base64'))
    } catch (e) {
      mapFsError(e, undefined, dest)
    }
    return
  }
  if (process.stdin.isTTY) {
    throw new CliError('stdin mode requires piped input; use --b64 or --from for interactive use')
  }
  const maxMB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
  if (!Number.isFinite(maxMB) || maxMB <= 0) {
    throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
  }
  const maxBytes = maxMB * 1024 * 1024
  return new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        if (!settled) {
          settled = true
          cleanup()
          process.stdin.destroy()
          reject(new CliError(`stdin input exceeds size limit (${Math.round(maxBytes / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`))
        }
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try { atomicWriteBuffer(dest, Buffer.concat(chunks)); resolve() }
      catch (e) { try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) } }
    }
    const onError = (e: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) }
    }
    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

async function cmdGdriveSections(fileId: string, opts: { heading?: string }): Promise<void> {
  if (opts.heading !== undefined) {
    const content = await getSectionContent(fileId, opts.heading)
    if (content === null) {
      throw new CliError(`section '${opts.heading}' not found in document ${fileId}`)
    }
    out(`# ${opts.heading}\n${content}`)
  } else {
    const sections = await getDocSections(fileId)
    const formatted = formatSections(sections)
    out(formatted)
  }
}

// --- Program assembly -------------------------------------------------------

/** Build the Commander program. Exported so tests can introspect/parse it. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('token-goat')
    .description('Surgical token-reduction companion for AI coding agents')
    .version(VERSION, '-v, --version', 'print the token-goat version')

  // Each action wraps the (possibly sync) handler so any thrown CliError or unexpected error maps to a stderr line + exit code 1, and success to 0.
  const guard =
    (fn: (...a: never[]) => void | Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      try {
        await fn(...(args as never[]))
        process.exitCode = 0
      } catch (e) {
        const msg = extractErrorMessage(e)
        err(`token-goat: ${msg}`)
        process.exitCode = 1
      }
    }

  program
    .command('symbol <name>')
    .description('search for a symbol by name')
    .option('-l, --limit <n>', 'max results')
    .option('-f, --file <path>', 'restrict to one file')
    .option('-k, --kind <kind>', 'restrict to one kind (function, class, ...)')
    .option('-j, --json', 'output as JSON')
    .action((name: string, opts: { limit?: string; file?: string; kind?: string; json?: boolean }) =>
      runExit(() =>
        runSymbol({
          name,
          limit: opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20,
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('read <spec>')
    .description("read one symbol's full body (spec: file::symbol)")
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runRead({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('section <spec>')
    .description('read one section from a file (spec: file::heading)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runSection({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('semantic <query>')
    .description('semantic search (falls back to full-text search)')
    .option('-l, --limit <n>', 'max results')
    .action(guard(cmdSemantic))

  program
    .command('skeleton <file>')
    .description('list all symbols in a file without bodies')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .action((file: string, opts: { json?: boolean; minLines?: string }) =>
      runExit(() =>
        runSkeleton({
          file,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.minLines !== undefined ? { minLines: Number.parseInt(opts.minLines, 10) } : {}),
        }),
      ),
    )

  program
    .command('outline <file>')
    .description('list symbols with line ranges and docstrings')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .action((file: string, opts: { json?: boolean; minLines?: string }) =>
      runExit(() =>
        runOutline({
          file,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.minLines !== undefined ? { minLines: Number.parseInt(opts.minLines, 10) } : {}),
        }),
      ),
    )

  program
    .command('refs <spec>')
    .description('find references to a symbol (spec: file::symbol or symbol)')
    .option('--callers', 'group references by their enclosing caller symbol')
    .option('-l, --limit <n>', 'max results')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { callers?: boolean; limit?: string; json?: boolean }) =>
      runExit(() =>
        runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: Number.parseInt(opts.limit, 10) } : {}),
        }),
      ),
    )

  program
    .command('index [path]')
    .description('parse all git-tracked files and (re)build the symbol index')
    .option('--walk', 'if not a git repo, index a bounded directory walk instead (skips .env / generated / oversized trees)')
    .action(guard(cmdIndex))

  program
    .command('map')
    .description('project overview')
    .option('-c, --compact', 'compact, low-token summary')
    .action(guard(cmdMap))

  program
    .command('hook <event>')
    .description('hook relay entrypoint (reads JSON on stdin)')
    .action(guard(cmdHook))

  program
    .command('install')
    .description('install hooks into Claude Code settings')
    .option('-p, --project', 'install into project scope instead of user scope')
    .action(guard(cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .action(guard(cmdUninstall))

  const worker = program.command('worker').description('background indexer lifecycle')
  worker.command('start').description('start the background indexer').action(guard(cmdWorkerStart))
  worker.command('stop').description('stop the background indexer').action(guard(cmdWorkerStop))
  worker.command('status').description('check if the indexer is running').action(guard(cmdWorkerStatus))

  program.command('stats').description('show session statistics').action(guard(cmdStats))

  program.command('doctor').description('diagnose token-goat health').action(guard(cmdDoctor))

  program
    .command('bash-output [id]')
    .description('retrieve cached bash output by ID or file')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--file <path>', 'read from raw output file instead of cache')
    .action(guard(cmdBashOutput))

  program
    .command('web-output [id]')
    .description('retrieve a cached WebFetch response body by ID')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .action(guard(cmdWebOutput))

  program
    .command('exports <file>')
    .description('list exported (public) symbols in a file')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runExports({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('imports <file>')
    .description('list the modules a file imports')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runImports({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('find <pattern>')
    .description('find files containing a symbol matching a pattern')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results')
    .action((pattern: string, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runFind({
          pattern,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: Number.parseInt(opts.limit, 10) } : {}),
        }),
      ),
    )

  program
    .command('grep <pattern> [path]')
    .description('regex search over files, caching nothing (session-aware grep)')
    .option('-j, --json', 'output as JSON')
    .option('--max-lines <n>', 'max matching lines to print')
    .option('--no-recursive', 'do not descend into subdirectories')
    .action((pattern: string, pathArg: string | undefined, opts: { json?: boolean; maxLines?: string; recursive?: boolean }) =>
      runExit(() =>
        runGrep({
          pattern,
          ...(pathArg !== undefined ? { path: pathArg } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.maxLines !== undefined ? { maxLines: Number.parseInt(opts.maxLines, 10) } : {}),
          ...(opts.recursive === false ? { recursive: false } : {}),
        }),
      ),
    )

  program
    .command('skill-body <name>')
    .description("retrieve a skill's cached body")
    .option('-c, --compact', 'print compact slice instead of full body')
    .action(guard(cmdSkillBody))

  program
    .command('skill-compact <name>')
    .description('regenerate and cache compact slice for a skill')
    .action(guard(cmdSkillCompact))

  program
    .command('skill-list')
    .description('list all cached skills with token counts')
    .option('-j, --json', 'output as JSON')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillList))

  program
    .command('skill-size')
    .description('show body/compact token counts per skill')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillSize))

  program
    .command('changed')
    .description('list files or symbols changed since a git ref')
    .option('--since <ref>', 'git ref to compare against (default: HEAD~5)')
    .option('--symbol', 'list symbols instead of files')
    .option('-j, --json', 'output as JSON')
    .action((opts: { since?: string; symbol?: boolean; json?: boolean }) =>
      runExit(() =>
        runChanged({
          ref: opts.since ?? 'HEAD~5',
          ...(opts.symbol === true ? { symbolMode: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('config-get <file> <key>')
    .description('read one value from a config file (TOML/JSON/YAML/INI)')
    .action((file: string, key: string) => runExit(() => runConfigGet({ file, key })))

  program
    .command('write-file <dest>')
    .description('write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping\n\nModes: --b64 PAYLOAD (base64), --from SOURCE (copy file), or piped stdin')
    .option('--from <source>', 'copy bytes from this source file instead of stdin/base64')
    .option('--b64 <payload>', 'decode base64 payload and write to dest')
    .action(guard(cmdWriteFile))

  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .action(guard(cmdGdriveSections))

  program
    .command('compress')
    .description('run a shell command and emit a compressed view of its output')
    .requiredOption('-c, --cmd <command>', 'the shell command to run, as one string')
    .option('-f, --filter <name>', 'filter name (auto-detected from the command when omitted)')
    .option('--timeout <seconds>', 'wall-clock timeout in seconds (0 = built-in default)')
    .option('--no-compress', 'stream output raw without compression (debug the wrapper)')
    .option('--profile <name>', 'compression profile: aggressive | balanced | minimal')
    .option('--max-tokens <n>', 'post-compress token cap (0 = no cap)')
    .action(cmdCompress)

  program
    .command('version')
    .description('print the token-goat version')
    .action(
      guard(() => {
        out(VERSION)
      }),
    )

  return program
}

/**
 * Parse `argv` and dispatch. Sets `process.exitCode`; callers (main.ts) should
 * let the process exit naturally so buffered stdout flushes first.
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram()
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command) instead of letting it call process.exit() mid-flush.
  program.exitOverride()
  try {
    await program.parseAsync(argv)
  } catch (e) {
    // Help / version requests throw with these codes and are not errors.
    const code = (e as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      process.exitCode = 0
      return
    }
    if (code === 'commander.unknownCommand' || code === 'commander.missingArgument') {
      // Commander already wrote its diagnostic to stderr.
      process.exitCode = 1
      return
    }
    const msg = extractErrorMessage(e)
    err(`token-goat: ${msg}`)
    process.exitCode = 1
  }
}
