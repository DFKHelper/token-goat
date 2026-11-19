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
const NON_ASCII = 'café 日本 \u{1F600}'
const NON_ASCII_LINES = 'über\n日本\n\u{1F600}'

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
  'stdout noise then a signal':
    "require('fs').writeSync(1, 'stdout noise'); process.kill(process.pid, 'SIGKILL')\n",
  'silent exit 2': 'process.exit(2)\n',
  'exit 2 message only': "process.stderr.write('blocked: message only\\n'); process.exit(2)\n",
  'exit 2 whitespace stderr': "process.stderr.write(' \\r\\n\\n'); process.exit(2)\n",
  'exit 2 whitespace stdout': "process.stdout.write('\\n \\r\\n'); process.exit(2)\n",
  // Provenance: HAND-DERIVED. e-acute, CJK and an emoji; LF-joined lines, no final newline.
  'non-ascii answer, exit 0':
    `process.stdout.write(Buffer.from(${JSON.stringify(NON_ASCII)}, 'utf8'))\n`,
  'non-ascii multi-line answer, exit 2':
    `process.stdout.write(Buffer.from(${JSON.stringify(NON_ASCII_LINES)}, 'utf8')); ` +
    "process.stderr.write('blocked\\n'); process.exit(2)\n",
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

function run(
  shell: GuardShell,
  shimText: string | undefined,
  exeText?: string,
  psPrefix = '',
  psProgram?: string,
) {
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
  const p = psProgram === undefined ? prog(shell)! : { program: psProgram, args: powerShellCommandArgs }
  const psDir = path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  const shellDirs = [path.dirname(p.program), psDir]
  const r = spawnSync(p.program, p.args(shell === 'powershell' ? psPrefix + command : command), {
    env: { ...process.env, PATH: shellDirs.join(path.delimiter) },
    encoding: 'buffer',
    timeout: 60_000,
    windowsHide: true,
    cwd: dir,
    input: Buffer.from('{}'),
    windowsVerbatimArguments: p.verbatim === true,
  })
  const [stdout, stderr] = [r.stdout.toString('utf8'), r.stderr.toString('utf8')]
  return { status: r.status, stdout, stderr, bytes: r.stdout, marker }
}

describe('a broken Node shim falls through to the safe answer', () => {
  for (const shell of SHELLS) {
    const broken = [
      'truncated', 'missing entry module', 'exit 13 and stdout noise', 'stdout noise then a signal', 'signal',
      'silent exit 2', 'exit 2 whitespace stdout',
    ]
    // limit: PowerShell 5.1 (cmd form) wraps blank stderr in an error record; revisit-when it is read
    if (shell !== 'cmd') broken.push('exit 2 whitespace stderr')
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
    it(`a non-ascii answer reaches the host byte for byte through ${shell}`, () => {
      const o = run(shell, SHIMS['non-ascii answer, exit 0'])
      expect({ status: o.status, hex: o.bytes.toString('hex') }).toEqual({
        status: 0,
        hex: Buffer.from(NON_ASCII, 'utf8').toString('hex'),
      })
    })
    it(`a non-ascii multi-line block keeps its bytes and lines through ${shell}`, () => {
      const o = run(shell, SHIMS['non-ascii multi-line answer, exit 2'])
      expect({ status: o.status, hex: o.bytes.toString('hex') }).toEqual({
        status: 2,
        hex: Buffer.from(NON_ASCII_LINES, 'utf8').toString('hex'),
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
  // A console code page that cannot carry the bytes (here 7-bit ASCII) must not alter the route's answer.
  it.runIf(SHELLS.includes('powershell'))('a non-ascii answer survives a 7-bit console code page', () => {
    const ascii = '[Console]::OutputEncoding = [Text.Encoding]::ASCII; '
    const o = run('powershell', SHIMS['non-ascii answer, exit 0'], undefined, ascii)
    expect({ status: o.status, hex: o.bytes.toString('hex') }).toEqual({
      status: 0,
      hex: Buffer.from(NON_ASCII, 'utf8').toString('hex'),
    })
  })
  // Provenance: CAPTURE (Windows PowerShell 5.1 on this host): after FreeConsole the assignment throws
  // "The handle is invalid", the state of a host that starts a hook with no console. A direct
  // DETACHED_PROCESS child of Node runs nothing at all here (exit 0, no output), so FreeConsole is the
  // nearest reproducible condition. pwsh does not throw there; the row proves the answer holds on both.
  const NO_CONSOLE =
    "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole();' " +
    '-Name K -Namespace T; [void][T.K]::FreeConsole(); '
  const sysRoot = process.env['SystemRoot'] ?? 'C:/Windows'
  const winPs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const found = WIN ? resolvePowerShell() : ''
  const pwshPs = found.toLowerCase().endsWith('pwsh.exe') ? found : undefined
  // pwsh 7 with no console cannot start any native program ("handle is invalid" while getting the console
  // mode), so no route can run there and the safe answer is the correct one; 5.1 still runs the Node route.
  const consoleless = [
    ['powershell.exe 5.1', winPs, '{"route":"node"}'],
    ['pwsh', pwshPs, SAFE],
  ] as const
  for (const [label, exe, answer] of consoleless) {
    it.runIf(WIN && exe !== undefined && fs.existsSync(exe))(
      `with no console attached the guard still answers through ${label}`,
      () => {
        const o = run('powershell', SHIMS['healthy'], undefined, NO_CONSOLE, exe)
        expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
          status: 0,
          stdout: answer,
          stderr: '',
        })
      },
    )
  }
  // The guard changes the console's output encoding to carry bytes; the host's console must be left as it was.
  for (const [label, exe] of [['powershell.exe 5.1', winPs], ['pwsh', pwshPs]] as const) {
    const name = `the console output encoding is put back through ${label}`
    it.runIf(WIN && exe !== undefined && fs.existsSync(exe))(name, () => {
      const dir = path.join(root, `enc${String(n++)}`)
      fs.mkdirSync(dir)
      const shim = path.join(dir, 'shim.cjs')
      fs.writeFileSync(shim, SHIMS['healthy']!)
      const guard = buildGuardedCommand({
        shell: 'powershell',
        native: [process.execPath, shim],
        safe: SAFE,
        marker: path.join(dir, 'hook-broken.json'),
      })
      const encoded = Buffer.from(guard, 'utf16le').toString('base64')
      // The outer host shares its console with the inner one; a fresh child reads the console's live code page.
      const outer =
        '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(850); ' +
        `& '${exe}' -NoProfile -NonInteractive -EncodedCommand ${encoded} | Out-Null; ` +
        `& '${exe}' -NoProfile -NonInteractive -Command '[Console]::OutputEncoding.CodePage'`
      const r = spawnSync(exe!, powerShellCommandArgs(outer), {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        cwd: dir,
        input: '{}',
      })
      expect({ status: r.status, codePage: r.stdout.trim() }).toEqual({ status: 0, codePage: '850' })
    })
  }
  it('runs on at least the sh form', () => {
    expect(SHELLS).toContain('sh')
  })
})
