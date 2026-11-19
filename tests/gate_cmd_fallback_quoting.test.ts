// `gate -- <argv>` quotes for the shell actually chosen: with no Git Bash on Windows the line runs under cmd.exe. Provenance: HAND-DERIVED argument sets; cmd.exe behaviour is CAPTURE from a real child on Windows (the rows below run one), and the quoting rules are FORMAT-DERIVED from Microsoft's "Parsing C++ command-line arguments" (backslash runs before a quote are doubled).
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GATE_FAIL_EXIT, GateArgumentRefused, gateCommandLine, runGateArgv } from '../src/cli_diagnostics.js'

// Prints its own arguments as JSON on stdout, so a row reads back exactly what the child received.
const ARGV_SCRIPT = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg gate cmd-'))
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

describe.skipIf(process.platform !== 'win32')('gate under the cmd.exe fallback, with a real cmd.exe child', () => {
  it.each(CARRIED)('the argument %j reaches the child whole', (arg) => {
    expect(receivedUnderCmd([arg, 'tail']), 'the child saw a different argv').toEqual([arg, 'tail'])
  })
})

describe('gateCommandLine picks the quoting of the shell it runs under', () => {
  it('a POSIX shell gets single quotes, whatever the platform', () => {
    expect(gateCommandLine(['node', 'a b'], '/usr/bin/bash', 'win32'), 'a Git Bash line lost its single quotes').toBe("node 'a b'")
    expect(gateCommandLine(['node', 'a b'], true, 'linux'), 'a /bin/sh line lost its single quotes').toBe("node 'a b'")
  })

  it('cmd.exe gets double quotes, and never single quotes, which it does not group', () => {
    const line = gateCommandLine(['node', 'a b'], true, 'win32')
    expect(line, 'the cmd.exe line is not double-quoted').toBe('node "a b"')
  })

  it.each([['%PATH%'], ['50%'], ['a"&b'], ['a\nb']])('cmd.exe refuses %j rather than run a re-split line', (arg) => {
    expect(() => gateCommandLine(['node', arg], true, 'win32')).toThrow(GateArgumentRefused)
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
    const code = await runGateArgv([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`, '%PATH%'], true, 'win32')
    expect(code, 'a refused line did not exit 2').toBe(GATE_FAIL_EXIT)
    expect(fs.existsSync(marker), 'the command ran despite the refusal').toBe(false)
    const lines = write.mock.calls.map((c) => String(c[0]))
    expect(lines.length, 'the refusal is not one line').toBe(1)
    expect(lines[0], 'the refusal does not name gate').toMatch(/^gate: .*\n$/)
  })
})
