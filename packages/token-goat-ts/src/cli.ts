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

import { buildProjectMap, formatProjectMap } from './baseline.js'
import { VERSION } from './constants.js'
import { getSessionFiles } from './session.js'
import { querySymbols, searchSymbolsFts } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { relay } from './relay.js'
import { readSection } from './section_reader.js'
import { isInstalled, installHooks, uninstallHooks } from './install.js'
import type { HookScope } from './install.js'
import { isWorkerRunning, startDetachedWorker, stopWorker } from './worker.js'

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
  const map = buildProjectMap(process.cwd(), { compact })
  out(formatProjectMap(map, compact))
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
  const files = getSessionFiles()
  let reads = 0
  let edits = 0
  for (const entry of files.values()) {
    if (entry.readCount > 0) reads += 1
    if (entry.wasEdited) edits += 1
  }
  const installed = isInstalled('user') ? 'yes' : 'no'
  const lines = [
    '# token-goat session stats',
    `Files touched: ${files.size}`,
    `  read:   ${reads}`,
    `  edited: ${edits}`,
    `Hooks installed (user scope): ${installed}`,
    `Worker running: ${isWorkerRunning() ? 'yes' : 'no'}`,
  ]
  out(lines.join('\n'))
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
