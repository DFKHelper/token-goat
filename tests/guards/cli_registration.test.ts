/** Guard against the "implemented but unregistered" command class. The `refs` subcommand once existed as a handler but was never wired into the Commander program, so it silently did not run. These tests introspect the built program and the cli.ts source so that gap (and its siblings) cannot regress: every `cmd*` handler defined in cli.ts, or in a module cli.ts imports one from, must be referenced by an `.action(...)`, every command intended for users must be registered, and the program's own `--help` must list each registered command. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildProgram } from '../../src/cli.js'
import { allCommandNames } from '../registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')
const CLI_SRC = fs.readFileSync(path.join(SRC_DIR, 'cli.ts'), 'utf8')

/** The modules cli.ts imports a `cmd*` handler from, so that a handler moved out of cli.ts, as the install and cached-output commands were, stays in the population the first test below checks. */
const HANDLER_MODULES = [...CLI_SRC.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w/]+)\.js'/gm)]
  .filter((m) => /\bcmd[A-Z]/.test(m[1] ?? ''))
  .map((m) => `${m[2] ?? ''}.ts`)

/** Names of every registered command and subcommand in the program. */
function registeredCommandNames(): Set<string> {
  return new Set(allCommandNames())
}

/** Every `function cmd<Name>(` handler declared in cli.ts or in one of {@link HANDLER_MODULES}. */
function declaredCmdHandlers(): string[] {
  const re = /\bfunction\s+(cmd[A-Z]\w*)\s*\(/g
  const out: string[] = []
  for (const src of [CLI_SRC, ...HANDLER_MODULES.map((mod) => fs.readFileSync(path.join(SRC_DIR, mod), 'utf8'))]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const name = m[1]
      if (name !== undefined) out.push(name)
    }
  }
  return [...new Set(out)]
}

describe('CLI command registration', () => {
  it('every cmd* handler in cli.ts, or in a module cli.ts imports one from, is wired into an .action()', () => {
    expect(HANDLER_MODULES, 'no module cli.ts imports a cmd* handler from').not.toEqual([])
    const handlers = declaredCmdHandlers()
    expect(handlers.length).toBeGreaterThan(10)
    const unwired = handlers.filter((name) => {
      // Native handlers are wired as `guard(cmdX)`; allow a bare `(cmdX)` or a direct reference inside an `.action(` call as well.
      const wired =
        CLI_SRC.includes(`guard(${name})`) ||
        new RegExp(`\\.action\\([^)]*\\b${name}\\b`).test(CLI_SRC)
      return !wired
    })
    expect(unwired).toEqual([])
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
