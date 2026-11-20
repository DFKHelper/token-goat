// `gate -- <argv>` quoting for cmd.exe (no Git Bash). HAND-DERIVED; CAPTURE; FORMAT: MS C++ argv rules.
import { spawnSync } from 'node:child_process'
import type * as BashRunner from '../src/bash_runner.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GATE_FAIL_EXIT, GateArgumentRefused, gateCommandLine, runGateArgv } from '../src/cli_diagnostics.js'

// Counts the calls the gate makes to the runner and forwards each to the real one.
const runner = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/bash_runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof BashRunner>()
  return {
    ...real,
    run: (...args: Parameters<typeof real.run>) => {
      runner.calls += 1
      return real.run(...args)
    },
  }
})

// Prints its own arguments as JSON on stdout, so a row reads back exactly what the child received.
const ARGV_SCRIPT = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg gate cmd-'))
  runner.calls = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

function script(): string {
  const file = path.join(dir, 'argv out.cjs')
  fs.writeFileSync(file, ARGV_SCRIPT, 'utf8')
  return file
}

/** The arguments a real cmd.exe child received, through the same `shell: true` spawn the runner uses. */
function receivedUnderCmd(args: string[]): unknown {
  const line = gateCommandLine([process.execPath, script(), ...args], true, 'win32')
  const result = spawnSync(line, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  expect(result.status, `cmd.exe could not run ${line}: ${result.stderr}`).toBe(0)
  return JSON.parse(result.stdout)
}

const CARRIED = [
  'a b',
  'say "hi" now',
  'a&b',
  'a^b',
  'a|b',
  'a<b>c',
  '(x)',
  'plain',
  'C:\\Program Files\\x\\',
  'two  spaces',
  '',
]

describe.skipIf(process.platform !== 'win32')(
  'gate under the cmd.exe fallback, with a real cmd.exe child',
  () => {
  it.each(CARRIED)('the argument %j reaches the child whole', (arg) => {
    expect(receivedUnderCmd([arg, 'tail']), 'the child saw a different argv').toEqual([arg, 'tail'])
  })

  it.each(['100% done', '50%_off %NOPE_NOT_SET_X%'])('the argument %j with a percent arrives whole', (arg) => {
    expect(receivedUnderCmd([arg]), 'a percent was expanded or refused').toEqual([arg])
  })

  it('an argument holding a defined %NAME% pair is refused, with one line and exit 2', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await runGateArgv([process.execPath, script(), 'a %PATH% b'], true, 'win32')
    expect(code, 'a defined variable was expanded, not refused').toBe(GATE_FAIL_EXIT)
    expect(write.mock.calls.length, 'the refusal is not one line').toBe(1)
    expect(runner.calls, 'the runner was called after the refusal').toBe(0)
  })
})

describe('gateCommandLine picks the quoting of the shell it runs under', () => {
  it('a POSIX shell gets single quotes, whatever the platform', () => {
    expect(
      gateCommandLine(['node', 'a b'], '/usr/bin/bash', 'win32'),
      'a Git Bash line lost its single quotes',
    ).toBe("node 'a b'")
    expect(
      gateCommandLine(['node', 'a b'], true, 'linux'),
      'a /bin/sh line lost its single quotes',
    ).toBe("node 'a b'")
  })

  it('cmd.exe gets double quotes, and never single quotes, which it does not group', () => {
    const line = gateCommandLine(['node', 'a b'], true, 'win32')
    expect(line, 'the cmd.exe line is not double-quoted').toBe('node "a b"')
  })

  it.each([['%PATH%'], ['a %Path% b'], ['a"&b'], ['a\nb']])(
    'cmd.exe refuses %j rather than run a re-split line',
    (arg) => {
    expect(() => gateCommandLine(['node', arg], true, 'win32')).toThrow(GateArgumentRefused)
  })

  it.each([['50%'], ['100% done'], ['%NOPE_NOT_SET_X%'], ['50%_off %NOPE_NOT_SET_X%']])(
    'cmd.exe carries %j quoted, since no variable of that name is defined',
    (arg) => {
    const line = gateCommandLine(['node', arg], true, 'win32', {})
    expect(line, 'a harmless percent was refused').toBe(`node "${arg}"`)
  })

  it('a pair is refused only for a name defined in the env it is given, in any case', () => {
    const words = ['node', 'a %Mine% b']
    expect(() => gateCommandLine(words, true, 'win32', { MINE: 'x' })).toThrow(GateArgumentRefused)
    expect(() => gateCommandLine(['node', 'a %Mine% b'], true, 'win32', {})).not.toThrow()
  })

  it('a POSIX shell is never refused for the same arguments', () => {
    expect(() => gateCommandLine(['node', '%PATH%', 'a"&b'], '/usr/bin/bash', 'win32')).not.toThrow()
  })

  it('one word stays a shell line as typed', () => {
    expect(gateCommandLine(['npm test && echo %X%'], true, 'win32')).toBe('npm test && echo %X%')
  })
})

describe('runGateArgv refuses with one line and exit 2, running nothing', () => {
  it('an argument cmd.exe cannot carry is refused before any child starts', async () => {
    const marker = path.join(dir, 'ran.txt')
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await runGateArgv(
      [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`, '%PATH%'],
      true,
      'win32',
    )
    expect(code, 'a refused line did not exit 2').toBe(GATE_FAIL_EXIT)
    expect(fs.existsSync(marker), 'the command ran despite the refusal').toBe(false)
    expect(runner.calls, 'the runner was called after the refusal').toBe(0)
    const lines = write.mock.calls.map((c) => String(c[0]))
    expect(lines.length, 'the refusal is not one line').toBe(1)
    expect(lines[0], 'the refusal does not give its reason').toMatch(
      /^gate: no Git Bash was found, and cmd\.exe cannot pass an argument with a defined %NAME%.*\n$/,
    )
  })
})
