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
for (const [name, value] of Object.entries(JSON.parse(process.env.TG_EXPECT_ENV || '{}'))) {
  if (process.env[name] !== value) {
    process.stderr.write('env mismatch: ' + name + '=' + JSON.stringify(process.env[name]) + '\\n')
    process.exit(1)
  }
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

function gateCli(
  argv: string[],
  expected: string[],
  expectedEnv: Record<string, string> = {},
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [BUNDLE, 'gate', '--', ...argv], {
    encoding: 'utf8',
    windowsHide: true,
    env: tgIsolatedEnv(base, {
      TG_EXPECT_ARGV: JSON.stringify(expected),
      TG_EXPECT_ENV: JSON.stringify(expectedEnv),
    }),
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

  it.each([
    ['plain', 'value'],
    ['a space', 'a b'],
    ['a single quote', "it's"],
    ['a double quote', 'say "hi" now'],
  ])('a leading NAME=value word with %s reaches the child byte for byte', (_label, value) => {
    const { status, stderr } = gateCli([`NAME=${value}`, 'node', script(), 'x'], ['x'], { NAME: value })
    expect(status, `the child did not see NAME=${JSON.stringify(value)} (stderr: ${stderr})`).toBe(0)
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

  it('quotes a leading NAME=value word whose value holds a space, keeping NAME= bare', () => {
    const line = gateCommandLine(['NAME=a b', 'node', 'x'], '/bin/sh', 'linux')
    expect(line, 'the value with a space must be quoted, not the whole word').toBe("NAME='a b' node x")
  })

  it('quotes each shell metacharacter of a leading assignment value so the shell reads data', () => {
    const line = gateCommandLine(["NAME=it's $HOME `id`; rm", 'node'], '/bin/sh', 'linux')
    expect(line, 'quote, dollar, backtick and semicolon must stay inside the quotes').toBe(
      `NAME='it'\\''s $HOME \`id\`; rm' node`,
    )
  })

  it('quotes assignments only before the first non-assignment word', () => {
    const line = gateCommandLine(['A=1 2', 'B=x y', 'env', 'C=p q'], '/bin/sh', 'linux')
    expect(line).toBe("A='1 2' B='x y' env 'C=p q'")
  })

  it('treats NAME=a b after the command word as an ordinary argument, quoted whole', () => {
    const line = gateCommandLine(['node', 'NAME=a b'], '/bin/sh', 'linux')
    expect(line).toBe("node 'NAME=a b'")
  })

  it('does not read a non-identifier left of = as an assignment', () => {
    const line = gateCommandLine(['1X=a b', '-Y=c d', 'node'], '/bin/sh', 'linux')
    expect(line).toBe("'1X=a b' '-Y=c d' node")
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
