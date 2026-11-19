// `token-goat gate -- <argv>` keeps each argument's boundaries; one string stays a shell line.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GATE_FAIL_EXIT, gateCommandLine } from '../src/cli_diagnostics.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

// Prints each argument on its own line behind a marker and exits 0 only when the count is the one expected.
const ARGS_SCRIPT = `
const expected = JSON.parse(process.env.TG_EXPECT_ARGV)
const got = process.argv.slice(2)
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  process.stderr.write('argv mismatch: ' + JSON.stringify(got) + '\\n')
  process.exit(1)
}
`

let dir: string
let base: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg gate argv-'))
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-home-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(base, { recursive: true, force: true })
})

function gateCli(argv: string[], expected: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [BUNDLE, 'gate', '--', ...argv], {
    encoding: 'utf8',
    windowsHide: true,
    env: tgIsolatedEnv(base, { TG_EXPECT_ARGV: JSON.stringify(expected) }),
  })
  return { status: result.status, stderr: result.stderr }
}

function script(): string {
  const file = path.join(dir, 'check args.cjs')
  fs.writeFileSync(file, ARGS_SCRIPT, 'utf8')
  return file.split(path.sep).join('/')
}

describe('gate keeps the argument boundaries of the argv after --', () => {
  it('runs a script whose path holds a space', () => {
    const file = script()
    const { status, stderr } = gateCli(['node', file, 'a b'], ['a b'])
    expect(status, `a script path with a space must run (stderr: ${stderr})`).toBe(0)
  })

  it('passes an argument that contains a double quote unchanged', () => {
    const { status, stderr } = gateCli(['node', script(), 'say "hi" now', "it's"], ['say "hi" now', "it's"])
    expect(status, `a double quote in an argument must survive (stderr: ${stderr})`).toBe(0)
  })

  it('keeps a single string as a shell command line', () => {
    const file = script()
    const { status, stderr } = gateCli([`node "${file}" one "two words"`], ['one', 'two words'])
    expect(status, `one string is read as a shell command (stderr: ${stderr})`).toBe(0)
  })

  it('still exits 2 when the wrapped program fails', () => {
    const { status } = gateCli(['node', script(), 'wrong'], ['right'])
    expect(status).toBe(2)
  })
})

describe('gateCommandLine', () => {
  it('returns a lone argument untouched', () => {
    expect(gateCommandLine(['npm test && echo done'])).toBe('npm test && echo done')
  })

  it('quotes each word of several, leaving plain words bare', () => {
    expect(gateCommandLine(['node', 'a b/c.js', 'x"y', "it's"])).toBe(`node 'a b/c.js' 'x"y' 'it'\\''s'`)
  })

  it('quotes an empty argument and a shell operator word', () => {
    expect(gateCommandLine(['echo', '', '&&'])).toBe("echo '' '&&'")
  })

  it('keeps a leading NAME=value word as an environment prefix, ahead of the command word', () => {
    const line = gateCommandLine(['NAME=value', 'node', 'a b.js'], '/bin/sh', 'linux')
    expect(line).toBe("NAME=value node 'a b.js'")
  })

  it('is empty for no arguments', () => {
    expect(gateCommandLine([])).toBe('')
  })
})

describe('the gate failure status', () => {
  it('is the literal 2 the help text and docs promise', () => {
    expect(GATE_FAIL_EXIT, 'GATE_FAIL_EXIT must be 2').toBe(2)
  })
})
