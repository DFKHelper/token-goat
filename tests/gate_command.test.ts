import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runGate } from '../src/cli_diagnostics.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Provenance: FORMAT-DERIVED from src/failures.ts (VITEST_BANNER, VITEST_FAIL_HEADER), vitest failure layout.
const RULE_BAR = '\\u23af'.repeat(7)
const VITEST_FAILURE_SCRIPT = [
  "process.stdout.write(' ✓ tests/a.test.ts > passes\\n')",
  "process.stdout.write(' FAIL  tests/b.test.ts > suite > the broken case\\n')",
  "process.stdout.write('AssertionError: expected 1 to be 2\\n')",
  `process.stdout.write(' ${RULE_BAR} Failed Tests 1 ${RULE_BAR}\\n')`,
  "process.stdout.write(' FAIL  tests/b.test.ts > suite > the broken case\\n')",
  "process.stdout.write(' Test Files  1 failed (1)\\n')",
  "process.stdout.write('      Tests  1 failed | 1 passed (2)\\n')",
  'process.exitCode = 1',
].join('\n')

const MARKER = '[REDACTED:anthropic_api_key]'
const SILENT_PASS_SCRIPT = "process.stdout.write('ok\\n')\n"

let dir: string
let stderr: string[]
let stderrSpy: ReturnType<typeof vi.spyOn>

const posixPath = (file: string): string => file.split(path.sep).join('/')

function writeScript(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, 'utf8')
  return posixPath(file)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-'))
  stderr = []
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stderrSpy.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('token-goat gate verdicts', () => {
  it('a failing command exits exactly 2 and stderr names the first failing test', async () => {
    const code = await runGate(`node "${writeScript('fail.js', VITEST_FAILURE_SCRIPT)}"`)
    expect(code, 'a failing wrapped command must exit 2, not the child code 1').toBe(2)
    const named = 'tests/b.test.ts > suite > the broken case'
    expect(stderr.join(''), 'stderr must name the first failing test').toContain(named)
  })

  it('a passing command exits 0 and prints nothing on stderr', async () => {
    const code = await runGate(`node "${writeScript('pass.js', SILENT_PASS_SCRIPT)}"`)
    expect(code, 'a wrapped command that exits 0 must pass the gate').toBe(0)
    expect(stderr.join(''), 'a pass prints nothing on stderr').toBe('')
  })

  it('an unparseable failure prints the exit code and the last 20 lines, and exits 2', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `process.stdout.write('row-${i + 1}\\n')`).join('\n')
    const code = await runGate(`node "${writeScript('rows.js', `${rows}\nprocess.exitCode = 3\n`)}"`)
    const text = stderr.join('')
    expect(code, 'an unparseable failure must still exit 2').toBe(2)
    expect(text, 'the child exit code must be named').toContain('exit 3')
    expect(text, 'the last line of output must be printed').toMatch(/\brow-30\b/)
    expect(text, 'the 20th-from-last line must be the first printed line').toMatch(/\brow-11\b/)
    expect(text, 'a line before the last 20 must not be printed').not.toMatch(/\brow-10\b/)
  })

  it('a timeout exits 2 and the wrapped tree (parent and grandchild) is gone afterwards', async () => {
    const pidFile = path.join(dir, 'pids.json')
    const hang = [
      "const fs = require('fs'); const { spawn } = require('child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)},`,
      'JSON.stringify({ parent: process.pid, grandchild: g.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n')
    const pids: number[] = []
    try {
      const code = await runGate(`node "${writeScript('hang.js', hang)}"`, { timeout: 2 })
      expect(code, 'a timed-out command must exit 2, not the runner\'s 124').toBe(2)
      const recorded = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { parent: number; grandchild: number }
      pids.push(recorded.parent, recorded.grandchild)
      const survivors = pids.filter((pid) => processAlive(pid))
      expect(survivors, `every process the timed-out command started must be ended with its tree; stderr: ${stderr.join('')}`).toEqual([])
    } finally {
      const ours = (line: string): boolean => line.includes('hang.js') || line.includes('setInterval')
      for (const pid of pids) killIfCommandLine(pid, ours, { tree: true })
    }
  })

  it('a command that cannot be started exits 2', async () => {
    const code = await runGate('token-goat-no-such-program-c4 --probe')
    expect(code, 'a command the shell cannot find must exit 2').toBe(2)
  })

  it('no command given exits 2 with a usage line', async () => {
    const code = await runGate('   ')
    expect(code, 'an empty command must exit 2').toBe(2)
    const usage = 'usage: token-goat gate -- <command>'
    expect(stderr.join(''), 'the usage line must name the command form').toContain(usage)
  })

  it('a failing test name carrying a token-shaped string is printed redacted, never raw', async () => {
    const token = 'sk-ant-tgsynthetic0000000000000000'
    const named = VITEST_FAILURE_SCRIPT.replace('the broken case', `the broken case ${token}`)
    const code = await runGate(`node "${writeScript('named.js', named)}"`)
    const text = stderr.join('')
    expect(code, 'a failing command must still exit 2').toBe(2)
    expect(text, 'the raw token in the failing test name must not reach stderr').not.toContain(token)
    expect(text, 'the failing test name must show the redaction marker').toContain(MARKER)
  })

  it('a secret-shaped line inside the last-20-lines tail is printed redacted, never raw', async () => {
    const token = 'sk-ant-tgsynthetic0000000000000000'
    const rows = Array.from({ length: 30 }, (_, i) => `process.stdout.write('row-${i + 1}\\n')`)
    rows[25] = `process.stdout.write('leaked ${token}\\n')`
    const script = writeScript('tail-secret.js', `${rows.join('\n')}\nprocess.exitCode = 3\n`)
    const code = await runGate(`node "${script}"`)
    const text = stderr.join('')
    expect(code, 'an unparseable failure must still exit 2').toBe(2)
    expect(text, 'the secret-shaped tail line must be printed, so redaction is observed').toMatch(/\brow-30\b/)
    expect(text, 'the raw token in the tail must not reach stderr').not.toContain(token)
    expect(text, 'the tail must show the redaction marker').toContain(MARKER)
  })
})
