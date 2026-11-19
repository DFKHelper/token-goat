/** A broken shim never breaks the hook: only exit 0 or a deliberate exit 2 is a Node-route answer. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildGuardedCommand, type GuardShell } from '../src/hook_guard.js'
import { powerShellCommandArgs, resolvePowerShell, resolveWindowsBash } from '../src/shell.js'

// Provenance: HAND-DERIVED. Node's own failure exits are 1 (uncaught error, syntax error), 9, 13 and signals.
const WIN = process.platform === 'win32'
const SAFE = '{"safe":true}'

interface Prog {
  program: string
  args: (c: string) => string[]
  verbatim?: boolean
}

function prog(shell: GuardShell): Prog | null {
  if (shell === 'cmd') {
    if (!WIN) return null
    const program = process.env['ComSpec'] ?? 'cmd.exe'
    return { program, args: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true }
  }
  if (shell === 'sh') {
    const program = WIN ? resolveWindowsBash() : '/bin/sh'
    return program === null ? null : { program, args: (c) => ['-c', c] }
  }
  const program = resolvePowerShell()
  return !WIN && !fs.existsSync(program) ? null : { program, args: powerShellCommandArgs }
}

const SHELLS = (['sh', 'powershell', 'cmd'] as const).filter((s) => prog(s) !== null)

const SHIMS: Record<string, string> = {
  truncated: 'const x = ;\n',
  'missing entry module': "require('./no-such-entry-module.cjs')\n",
  'exit 13 and stdout noise':
    "require('fs').writeSync(1, 'stdout noise'); process.stderr.write('loader noise\\n'); process.exit(13)\n",
  'stdout noise then a signal': "require('fs').writeSync(1, 'stdout noise'); process.kill(process.pid, 'SIGKILL')\n",
  'silent exit 2': 'process.exit(2)\n',
  'exit 2 message only': "process.stderr.write('blocked: message only\\n'); process.exit(2)\n",
  'exit 2 decision only': "process.stdout.write('{\"d\":\"decision only\"}'); process.exit(2)\n",
  'signal': "process.kill(process.pid, 'SIGKILL')\n",
  'exit 2 block':
    "process.stderr.write('blocked: use the other command\\n'); " +
    "process.stdout.write('{\"d\":\"block\"}'); process.exit(2)\n",
  healthy: "process.stdout.write('{\"route\":\"node\"}')\n",
  'multi-line answer': "process.stdout.write('line one\\nline two\\nline three')\n",
}

let root = ''
let n = 0
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-broken-shim-')))
})
afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true })
})

function run(shell: GuardShell, shimText: string | undefined, exeText?: string) {
  const dir = path.join(root, `c${String(n++)}`)
  fs.mkdirSync(dir)
  const shim = path.join(dir, 'shim.cjs')
  if (shimText !== undefined) fs.writeFileSync(shim, shimText)
  const exe = path.join(dir, WIN ? 'tg-hook.exe' : 'tg-hook')
  const exeJs = path.join(dir, 'exe.cjs')
  if (exeText !== undefined) {
    fs.copyFileSync(process.execPath, exe)
    fs.chmodSync(exe, 0o755)
    fs.writeFileSync(exeJs, exeText)
  }
  const marker = path.join(dir, 'hook-broken.json')
  const command = buildGuardedCommand({
    shell,
    native: [exe, ...(exeText !== undefined ? [exeJs] : []), '--', process.execPath, shim],
    safe: SAFE,
    marker,
  })
  const p = prog(shell)!
  const psDir = path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  const shellDirs = [path.dirname(p.program), psDir]
  const r = spawnSync(p.program, p.args(command), {
    env: { ...process.env, PATH: shellDirs.join(path.delimiter) },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    cwd: dir,
    input: '{}',
    windowsVerbatimArguments: p.verbatim === true,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, marker }
}

describe('a broken Node shim falls through to the safe answer', () => {
  for (const shell of SHELLS) {
    const broken = [
      'truncated', 'missing entry module', 'exit 13 and stdout noise', 'stdout noise then a signal', 'signal',
      'silent exit 2',
    ]
    for (const name of broken) {
      it(`${name} through ${shell}: safe answer, exit 0, empty stderr`, () => {
        const o = run(shell, SHIMS[name])
        expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
          status: 0,
          stdout: SAFE,
          stderr: '',
        })
        expect(fs.existsSync(o.marker), 'the guard leaves its notice').toBe(true)
      })
    }
    it(`a deliberate exit 2 passes its stderr and stdout through ${shell}`, () => {
      const o = run(shell, SHIMS['exit 2 block'])
      expect(o.status).toBe(2)
      expect(o.stdout).toBe('{"d":"block"}')
      expect(o.stderr).toContain('blocked: use the other command')
    })
    it(`an exit 2 with only a message still blocks through ${shell}`, () => {
      const o = run(shell, SHIMS['exit 2 message only'])
      expect({ status: o.status, stdout: o.stdout }).toEqual({ status: 2, stdout: '' })
      expect(o.stderr).toContain('blocked: message only')
    })
    it(`an exit 2 with only a decision on stdout still blocks through ${shell}`, () => {
      const o = run(shell, SHIMS['exit 2 decision only'])
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
        status: 2,
        stdout: '{"d":"decision only"}',
        stderr: '',
      })
    })
    it(`a healthy shim answers through ${shell}`, () => {
      const o = run(shell, SHIMS['healthy'])
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
        status: 0,
        stdout: '{"route":"node"}',
        stderr: '',
      })
    })
    it(`an answer of several lines reaches the host whole through ${shell}`, () => {
      const o = run(shell, SHIMS['multi-line answer'])
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
        status: 0,
        stdout: 'line one\nline two\nline three',
        stderr: '',
      })
    })
    it(`a native client that crashes with exit 1 falls to the Node route through ${shell}`, () => {
      const o = run(shell, SHIMS['healthy'], "process.stderr.write('boom\\n'); process.exit(1)\n")
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
        status: 0,
        stdout: '{"route":"node"}',
        stderr: '',
      })
    })
  }
  it('runs on at least the sh form', () => {
    expect(SHELLS).toContain('sh')
  })
})
