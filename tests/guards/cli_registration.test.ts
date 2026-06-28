/**
 * Guard against the "implemented but unregistered" command class.
 *
 * The `refs` subcommand once existed as a handler but was never wired into the
 * Commander program, so it silently did not run. These tests introspect the
 * built program and the cli.ts source so that gap (and its siblings) cannot
 * regress: every `cmd*` handler defined in cli.ts must be referenced by an
 * `.action(...)`, every command intended for users must be registered, and the
 * program's own `--help` must list each registered command.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildProgram } from '../../src/cli.js'
import { allCommandNames } from '../registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_SRC = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'cli.ts'), 'utf8')

/** Names of every registered command and subcommand in the program. */
function registeredCommandNames(): Set<string> {
  return new Set(allCommandNames())
}

/** Every `function cmd<Name>(` handler declared in cli.ts. */
function declaredCmdHandlers(): string[] {
  const re = /\bfunction\s+(cmd[A-Z]\w*)\s*\(/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(CLI_SRC)) !== null) {
    const name = m[1]
    if (name !== undefined) out.push(name)
  }
  return [...new Set(out)]
}

describe('CLI command registration', () => {
  it('every cmd* handler in cli.ts is wired into an .action()', () => {
    const handlers = declaredCmdHandlers()
    expect(handlers.length).toBeGreaterThan(10)
    const unwired = handlers.filter((name) => {
      // Native handlers are wired as `guard(cmdX)`; allow a bare `(cmdX)` or a
      // direct reference inside an `.action(` call as well.
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
      'symbol', 'read', 'section', 'semantic', 'skeleton', 'outline', 'refs',
      'index', 'map', 'hook', 'install', 'uninstall', 'stats', 'doctor',
      'bash-output', 'web-output', 'skill-body', 'skill-compact', 'skill-list',
      'skill-size', 'changed', 'config-get', 'write-file', 'gdrive-sections',
      'version', 'exports', 'imports', 'find', 'grep',
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
