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

import { buildProjectMap, formatProjectMap } from './baseline.js'
import { buildCompactMap, formatMap } from './repomap.js'
import { VERSION } from './constants.js'
import { getSessionFiles } from './session.js'
import { querySymbols, searchSymbolsFts } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { relay } from './relay.js'
import { readSection } from './section_reader.js'
import { installHooks, uninstallHooks } from './install.js'
import type { HookScope } from './install.js'
import { isWorkerRunning, startDetachedWorker, stopWorker } from './worker.js'
import { getBashOutput } from './bash_output_cache.js'
import { getSkillFilePath, listSkills, storeCompact } from './skill_cache.js'
import { loadConfig } from './config.js'
import { runGit } from './util.js'
import { renderStats } from './stats.js'
import { runDoctorAndExit } from './cli_doctor.js'
import { getDocSections, formatSections, getSectionContent } from './gdrive.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. */
class CliError extends Error {}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

/** First `n` lines of a body, for the symbol-search preview. */
function previewLines(body: string, n: number): string {
  return body.split(/\r?\n/).slice(0, n).join('\n')
}

/** `name (kind) — file:start-end` header line for a symbol. */
function symbolHeader(s: SymbolEntry): string {
  return `# ${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}-${s.lineEnd}`
}

/** Split a `file::symbol` (or `file::Class.method`) spec into its two halves. */
function splitFileSpec(spec: string): { file: string; member: string } {
  const idx = spec.indexOf('::')
  if (idx === -1) {
    throw new CliError(`expected '<file>::<name>', got: ${spec}`)
  }
  return { file: spec.slice(0, idx), member: spec.slice(idx + 2) }
}

// --- Command handlers -------------------------------------------------------

function cmdSymbol(name: string, opts: { limit?: string; file?: string; kind?: string }): void {
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20
  const results = querySymbols({
    name,
    ...(opts.file !== undefined ? { filePath: opts.file } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    limit: Number.isFinite(limit) ? limit : 20,
  })

  if (results.length === 0) {
    throw new CliError(`no symbol named '${name}' in the index`)
  }

  const blocks = results.map((s) => `${symbolHeader(s)}\n${previewLines(s.body, 5)}`)
  out(blocks.join('\n\n'))
}

function cmdRead(spec: string): void {
  const { file, member } = splitFileSpec(spec)
  // Match on bare name or trailing member (`Class.method` → `method`).
  const bare = member.includes('.') ? member.slice(member.lastIndexOf('.') + 1) : member

  const candidates = querySymbols({ name: bare, limit: 50 })
  const inFile = candidates.filter(
    (s) => s.filePath === file || s.filePath.endsWith(file) || file.endsWith(s.filePath),
  )
  const pick = inFile[0] ?? candidates[0]

  if (pick === undefined) {
    throw new CliError(`symbol '${member}' not found in '${file}'`)
  }
  out(`${symbolHeader(pick)}\n${pick.body}`)
}

function cmdSection(spec: string): void {
  const { file, member } = splitFileSpec(spec)
  const result = readSection(file, member)
  if (result === null) {
    throw new CliError(`section '${member}' not found in '${file}'`)
  }
  out(`# ${result.heading} — ${file}:${result.lineStart}-${result.lineEnd}\n${result.content}`)
}

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

function cmdSkeleton(file: string): void {
  const symbols = querySymbols({ filePath: file, limit: 1000 })
  if (symbols.length === 0) {
    throw new CliError(`no indexed symbols for '${file}' (is it indexed?)`)
  }
  const ordered = [...symbols].sort((a, b) => a.lineStart - b.lineStart)
  const lines = ordered.map((s) => {
    const lineNo = String(s.lineStart).padStart(6)
    const kind = s.kind.padEnd(10)
    const sig = previewLines(s.body, 1).trim()
    return `${lineNo}  ${kind}  ${s.name}  ${sig}`
  })
  out(lines.join('\n'))
}

function cmdOutline(file: string): void {
  const symbols = querySymbols({ filePath: file, limit: 1000 })
  if (symbols.length === 0) {
    throw new CliError(`no indexed symbols for '${file}' (is it indexed?)`)
  }
  const ordered = [...symbols].sort((a, b) => a.lineStart - b.lineStart)
  const lines = ordered.map((s) => {
    const span = `${s.lineStart}-${s.lineEnd}`.padEnd(11)
    const kind = s.kind.padEnd(10)
    const doc = s.docstring !== '' ? `  # ${previewLines(s.docstring, 1).trim()}` : ''
    return `${span} ${kind} ${s.name}${doc}`
  })
  out(lines.join('\n'))
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
  // relay handles its own stdin read / stdout write and never throws on a
  // malformed/unknown event — it emits `{}` and returns.
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

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

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
    let content: string
    try {
      content = fs.readFileSync(opts.file, 'utf-8')
    } catch {
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
      out(lines.slice(0, end).join('\n'))
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

function cmdChanged(opts: { since?: string; symbol?: boolean }): void {
  const since = opts.since ?? 'HEAD~5'
  const result = runGit(['diff', since, '--name-only'])

  if (result.exitCode !== 0) {
    throw new CliError(`git diff failed: ${result.stderr}`)
  }

  const files = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  if (files.length === 0) {
    out('No files changed.')
    return
  }

  if (opts.symbol === true) {
    const allSymbols: SymbolEntry[] = []
    for (const file of files) {
      const symbols = querySymbols({ filePath: file, limit: 1000 })
      allSymbols.push(...symbols)
    }

    if (allSymbols.length === 0) {
      out('No symbols changed.')
      return
    }

    const lines = allSymbols.map((s) => `${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}`)
    out(lines.join('\n'))
  } else {
    out(files.join('\n'))
  }
}

function cmdConfigGet(file: string, key: string): void {
  const config = loadConfig()
  const keys = key.split('.')
  let value: unknown = config

  for (const k of keys) {
    if (typeof value === 'object' && value !== null && k in value) {
      value = (value as Record<string, unknown>)[k]
    } else {
      throw new CliError(`key '${key}' not found in '${file}'`)
    }
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out(String(value))
  } else if (typeof value === 'object') {
    out(JSON.stringify(value, null, 2))
  } else {
    out(String(value))
  }
}

function cmdWriteFile(dest: string, opts: { from?: string; b64?: string }): void {
  if (opts.from !== undefined) {
    fs.copyFileSync(opts.from, dest)
  } else if (opts.b64 !== undefined) {
    fs.writeFileSync(dest, Buffer.from(opts.b64, 'base64'))
  } else {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => fs.writeFileSync(dest, Buffer.concat(chunks)))
    process.stdin.resume()
  }
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

  // Each action wraps the (possibly sync) handler so any thrown CliError or
  // unexpected error maps to a stderr line + exit code 1, and success to 0.
  const guard =
    (fn: (...a: never[]) => void | Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      try {
        await fn(...(args as never[]))
        process.exitCode = 0
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
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
    .action(guard(cmdSymbol))

  program
    .command('read <spec>')
    .description("read one symbol's full body (spec: file::symbol)")
    .action(guard(cmdRead))

  program
    .command('section <spec>')
    .description('read one section from a file (spec: file::heading)')
    .action(guard(cmdSection))

  program
    .command('semantic <query>')
    .description('semantic search (falls back to full-text search)')
    .option('-l, --limit <n>', 'max results')
    .action(guard(cmdSemantic))

  program
    .command('skeleton <file>')
    .description('list all symbols in a file without bodies')
    .action(guard(cmdSkeleton))

  program
    .command('outline <file>')
    .description('list symbols with line ranges and docstrings')
    .action(guard(cmdOutline))

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
    .action(guard(cmdChanged))

  program
    .command('config-get <file> <key>')
    .description('read one value from a config file (TOML/JSON/YAML/INI)')
    .action(guard(cmdConfigGet))

  program
    .command('write-file <dest>')
    .description('write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping')
    .option('--from <source>', 'copy bytes from this source file instead of stdin/base64')
    .option('--b64 <payload>', 'decode base64 payload and write to dest')
    .action(guard(cmdWriteFile))

  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .action(guard(cmdGdriveSections))

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
  // Commander's exitOverride lets us catch its internal exits (help, version,
  // unknown command) instead of letting it call process.exit() mid-flush.
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
    const msg = e instanceof Error ? e.message : String(e)
    err(`token-goat: ${msg}`)
    process.exitCode = 1
  }
}
