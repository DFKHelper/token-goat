/** Guard against the "implemented but unregistered" command class. The `refs` subcommand once existed as a handler but was never wired into the Commander program, so it silently did not run. These tests introspect the built program and the src/ tree so that gap (and its siblings) cannot regress: every `cmd*` handler a module exports, or declares in a module that registers commands, must be referenced inside an `.action(...)` call in a module that registers commands, every command intended for users must be registered, and the program's own `--help` must list each registered command. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildProgram } from '../../src/cli.js'
import { allCommandNames } from '../registry.js'
import { pinnedPopulation } from './population.js'
import { codeOnly } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Names of every registered command and subcommand in the program. */
function registeredCommandNames(): Set<string> {
  return new Set(allCommandNames())
}

/** Every module under src/, keyed by its path below src/ in forward slashes, with comments and string contents blanked by codeOnly: a handler named in a comment or a help string cannot vouch for its own wiring, and a parenthesis inside a string cannot unbalance an `.action(` span. */
function srcModules(): Map<string, string> {
  const modules = new Map<string, string>()
  for (const rel of fs.readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })) {
    if (rel.endsWith('.ts')) modules.set(rel.split(path.sep).join('/'), codeOnly(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')))
  }
  return modules
}

/** The text of every `.action(...)` call in `code`, parenthesis-matched, so a handler called inside an arrow, as in `.action((opts) => guard(() => cmdBashHistory(opts))())`, is inside its span. The match this replaced stopped at the first `)`, which is the one closing `(opts)`. */
function actionSpans(code: string): string[] {
  const spans: string[] = []
  for (let at = code.indexOf('.action('); at !== -1; at = code.indexOf('.action(', at + 1)) {
    let depth = 0
    let end = at + '.action'.length
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')' && --depth === 0) break
    }
    spans.push(code.slice(at, end + 1))
  }
  return spans
}

/** The handlers `modules` declares and no `.action(...)` span references. The population is every exported `cmd*` function, wherever it lives, plus every `cmd*` declared in a module that registers commands (one with an `.action(` call). A module-private `cmd*` anywhere else is a helper its own module's handler calls, as text_commands.ts's cmdLockdepsPackage is for cmdLockdeps, and no command runs it directly. */
function unwiredHandlers(modules: ReadonlyMap<string, string>): { registering: string[]; handlers: string[]; unwired: string[] } {
  const registering = [...modules].filter(([, code]) => code.includes('.action(')).map(([mod]) => mod)
  const spans = registering.flatMap((mod) => actionSpans(modules.get(mod) ?? ''))
  const handlers = new Set<string>()
  for (const [mod, code] of modules) {
    for (const m of code.matchAll(/(\bexport\s+)?(?:async\s+)?function\s+(cmd[A-Z]\w*)\s*\(/g)) {
      const name = m[2]
      if (name !== undefined && (m[1] !== undefined || registering.includes(mod))) handlers.add(name)
    }
  }
  const unwired = [...handlers].filter((name) => !spans.some((span) => new RegExp(`\\b${name}\\b`).test(span)))
  return { registering, handlers: [...handlers], unwired }
}

describe('CLI command registration', () => {
  it('every cmd* handler a module exports, or declares where commands are registered, is wired into an .action()', () => {
    const { registering, handlers, unwired } = unwiredHandlers(srcModules())
    pinnedPopulation({
      what: 'src modules that register CLI commands with .action(',
      items: registering,
      floor: 4,
      mustIncludeExact: ['cli.ts', 'cli_cmd_analysis.ts', 'cli_cmd_formats.ts', 'cli_cmd_session.ts'],
    })
    // One anchor per way a handler reaches a registering module: declared in cli.ts, imported by name, re-exported through cli.ts, and loaded by a dynamic import inside the action itself.
    pinnedPopulation({
      what: 'cmd* handlers checked for .action() wiring',
      items: handlers,
      floor: 110,
      mustIncludeExact: ['cmdDoctor', 'cmdBashHistory', 'cmdPdfMeta', 'cmdUpgrade'],
    })
    expect(unwired).toEqual([])
  })

  // Calibration, HAND-DERIVED from the census that widened this guard: cmdPdfMeta lives in cli_office.ts, reaches the program only through an `export { ... } from` in cli.ts and an import in cli_cmd_formats.ts, and was outside the 29 handlers the old population (cli.ts plus the modules cli.ts imports a handler from) held, so deleting its wiring left that guard green.
  it('names a handler the old population could not see once its .action() wiring is removed', () => {
    const modules = srcModules()
    const formats = modules.get('cli_cmd_formats.ts') ?? ''
    const wiring = '.action(guard(cmdPdfMeta))'
    expect(formats.split(wiring).length - 1, 'the calibration wiring moved; point this at another handler registered outside cli.ts').toBe(1)
    modules.set('cli_cmd_formats.ts', formats.replace(wiring, ''))
    expect(unwiredHandlers(modules).unwired).toEqual(['cmdPdfMeta'])
  })

  it('registers every command intended for users', () => {
    const names = registeredCommandNames()
    const required = [
      'symbol', 'read', 'section', 'semantic', 'search', 'skeleton', 'outline', 'refs',
      'index', 'map', 'hook', 'install', 'uninstall', 'stats', 'doctor',
      'bash-output', 'web-output', 'mcp-output', 'mcp-history', 'skill-body', 'skill-compact', 'skill-list',
      'skill-size', 'skill-history', 'skill-diff', 'skill-section', 'changed', 'config-get', 'write-file', 'replace', 'gdrive-sections',
      'version', 'exports', 'imports', 'find', 'locate', 'grep', 'memory', 'waste', 'mcp-audit', 'recall', 'hint-stats', 'statusline', 'commands',
      'worker start', 'worker stop', 'worker status',
    ]
    const missing = required.filter((name) => !names.has(name))
    expect(missing).toEqual([])
  })

  it('lists every top-level registered command in --help', () => {
    const program = buildProgram()
    const help = program.helpInformation()
    const missing = program.commands
      .map((c) => c.name())
      .filter((name) => !help.includes(name))
    expect(missing).toEqual([])
  })

  it('gives every registered command a description', () => {
    const program = buildProgram()
    const undocumented = program.commands
      .filter((c) => c.description().trim() === '')
      .map((c) => c.name())
    expect(undocumented).toEqual([])
  })
})

describe('CLI command registration - README contract', () => {
  // Every command documented in README must be registered, or explicitly listed in PENDING below while it is still being built. PENDING is the live worklist for the "implement all documented commands" effort: a command may sit here only while unbuilt - once registered it MUST be removed (the first assertion enforces that), and a newly-documented command that is neither built nor pending fails the second assertion. When PENDING empties, README and the CLI are provably in sync and can never silently diverge again.
  const PENDING = new Set<string>([])

  const README = fs.readFileSync(path.join(HERE, '..', '..', 'README.md'), 'utf8')

  // First word of every `token-goat <cmd>` backtick span in README. The leading [a-z] guard skips flag spans (--pi) and placeholders (<name>).
  function documentedCommands(): Set<string> {
    const re = /`token-goat\s+([a-z][a-z-]*)/g
    const out = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(README)) !== null) {
      const name = m[1]
      if (name !== undefined) out.add(name)
    }
    return out
  }

  function registeredTopLevel(): Set<string> {
    return new Set(buildProgram().commands.map((c) => c.name()))
  }

  it('keeps PENDING honest: nothing pending is already registered', () => {
    const registered = registeredTopLevel()
    const builtButStillPending = [...PENDING].filter((n) => registered.has(n))
    expect(builtButStillPending).toEqual([])
  })

  it('every command documented in README is registered (or pending)', () => {
    const registered = registeredTopLevel()
    const documented = documentedCommands()
    const gap = [...documented].filter((n) => !registered.has(n) && !PENDING.has(n))
    expect(gap).toEqual([])
  })
})
