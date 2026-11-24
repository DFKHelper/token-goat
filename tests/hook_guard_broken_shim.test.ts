/** A broken shim never breaks the hook: only exit 0 or a deliberate exit 2 is a Node-route answer. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildGuardedCommand, type GuardShell } from '../src/hook_guard.js'
import { powerShellCommandArgs, resolvePowerShell, resolveWindowsBash } from '../src/shell.js'
import { killIfCommandLine, tiedToHandles } from './helpers/kill_if_command_line.js'

// Provenance: HAND-DERIVED. Node's own failure exits are 1 (uncaught error, syntax error), 9, 13 and signals.
const WIN = process.platform === 'win32'
const SAFE = '{"safe":true}'
// An exit-0 answer must be an object now (the guard serves no bare text), so the bytes sit in a JSON string.
const NON_ASCII = '{"say":"café 日本 \u{1F600}"}'
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
  // Ruling: exit 2 blocks only with non-blank stderr, or stdout whose first non-blank character is `{`.
  'exit 2 stdout not json': "process.stdout.write('not json'); process.exit(2)\n",
  'exit 2 decision after a space': "process.stdout.write(' {\"decision\":\"block\"}'); process.exit(2)\n",
  'exit 2 decision only':"process.stdout.write('{\"d\":\"decision only\"}'); process.exit(2)\n",
  'signal': "process.kill(process.pid, 'SIGKILL')\n",
  'exit 2 block':
    "process.stderr.write('blocked: use the other command\\n'); " +
    "process.stdout.write('{\"d\":\"block\"}'); process.exit(2)\n",
  healthy: "process.stdout.write('{\"route\":\"node\"}')\n",
  'multi-line answer': "process.stdout.write('{\"lines\":[\\n\"one\",\\n\"two\"\\n]}')\n",
  // Provenance: HAND-DERIVED. Exit-0 and exit-2 outputs the guard must not serve as a hook answer.
  'exit 0 null': "process.stdout.write('null')\n",
  'exit 0 number': "process.stdout.write('3')\n",
  'exit 0 bare word': "process.stdout.write('ok')\n",
  'exit 0 broken object': "process.stdout.write('{broken')\n",
  'exit 0 empty object': "process.stdout.write('{}')\n",
  'exit 0 decision object': "process.stdout.write('{\"decision\":\"approve\"}')\n",
  'exit 0 no output': 'process.exit(0)\n',
  'exit 2 null': "process.stdout.write('null'); process.exit(2)\n",
  'exit 2 number': "process.stdout.write('3'); process.exit(2)\n",
  'exit 2 bare word': "process.stdout.write('ok'); process.exit(2)\n",
  'exit 2 broken object': "process.stdout.write('{broken'); process.exit(2)\n",
  'exit 2 empty object': "process.stdout.write('{}'); process.exit(2)\n",
  // Provenance: HAND-DERIVED. Echoes the stdin it read; no input is treated as a failed route.
  'echo the payload it read':
    "let d = ''; process.stdin.on('data', (c) => { d += c }); " +
    "process.stdin.on('end', () => { if (d === '') process.exit(1); " +
    "process.stdout.write(JSON.stringify({ route: 'node', got: d })) })\n",
}
const PAYLOAD = '{"tool":"fx9-payload-7c1e"}'

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
  input = '{}',
  extra: { env?: Record<string, string>; pathFirst?: string } = {},
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
  const shellDirs = [
    path.dirname(p.program),
    ...(!WIN && shell === 'sh' ? ['/usr/bin'] : []),
    psDir,
  ]
  const pathDirs = extra.pathFirst === undefined ? shellDirs : [extra.pathFirst, ...shellDirs]
  const r = spawnSync(p.program, p.args(shell === 'powershell' ? psPrefix + command : command), {
    env: { ...process.env, ...extra.env, PATH: pathDirs.join(path.delimiter) },
    encoding: 'buffer',
    timeout: 60_000,
    windowsHide: true,
    cwd: dir,
    input: Buffer.from(input),
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
    broken.push('exit 2 whitespace stderr', 'exit 2 stdout not json')
    broken.push('exit 0 null', 'exit 0 number', 'exit 0 bare word', 'exit 0 broken object')
    broken.push('exit 2 null', 'exit 2 number', 'exit 2 bare word', 'exit 2 broken object')
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
    it(`an exit 2 whose stdout opens with a space then { still blocks through ${shell}`, () => {
      const o = run(shell, SHIMS['exit 2 decision after a space'])
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
        status: 2,
        stdout: ' {"decision":"block"}',
        stderr: '',
      })
    })
    for (const [name, status, stdout] of [
      ['exit 0 empty object', 0, '{}'],
      ['exit 0 decision object', 0, '{"decision":"approve"}'],
      ['exit 2 empty object', 2, '{}'],
    ] as const) {
      it(`${name} is served as it came through ${shell}`, () => {
        const o = run(shell, SHIMS[name])
        expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({ status, stdout, stderr: '' })
      })
    }
    it(`an exit 0 with no output is served as an empty answer through ${shell}`, () => {
      const o = run(shell, SHIMS['exit 0 no output'])
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr })
        .toEqual({ status: 0, stdout: '', stderr: '' })
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
        stdout: '{"lines":[\n"one",\n"two"\n]}',
        stderr: '',
      })
    })
    it(`a native route that fails unread hands the node route its payload through ${shell}`, () => {
      const o = run(shell, SHIMS['echo the payload it read'], 'process.exit(1)\n', '', undefined, PAYLOAD)
      expect({ status: o.status, stderr: o.stderr }).toEqual({ status: 0, stderr: '' })
      expect(JSON.parse(o.stdout)).toEqual({ route: 'node', got: PAYLOAD })
    })
    it(`limit: a route that drains stdin then fails leaves the next route the safe answer, ${shell}`, () => {
      const reads = "require('fs').readFileSync(0); process.exit(1)\n"
      const o = run(shell, SHIMS['echo the payload it read'], reads, '', undefined, PAYLOAD)
      expect({ status: o.status, stdout: o.stdout, stderr: o.stderr })
        .toEqual({ status: 0, stdout: SAFE, stderr: '' })
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
  // Provenance: CAPTURE (Windows PowerShell 5.1 on this host): after FreeConsole the assignment throws "The handle is invalid", the state of a host that starts a hook with no console. A direct DETACHED_PROCESS child of Node runs nothing at all here (exit 0, no output), so FreeConsole is the nearest reproducible condition. pwsh does not throw there; the row proves the answer holds on both.
  const NO_CONSOLE =
    "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole();' " +
    '-Name K -Namespace T; [void][T.K]::FreeConsole(); '
  const sysRoot = process.env['SystemRoot'] ?? 'C:/Windows'
  const winPs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const found = WIN ? resolvePowerShell() : ''
  const pwshPs = found.toLowerCase().endsWith('pwsh.exe') ? found : undefined
  // pwsh 7 with no console cannot start any native program ("handle is invalid" while getting the console mode), so no route can run there and the safe answer is the correct one; 5.1 still runs the Node route.
  const consoleless = [
    ['powershell.exe 5.1', winPs, '{"route":"node"}'],
    ['pwsh', pwshPs, SAFE],
  ] as const
  for (const [label, exe, answer] of consoleless) {
    const claim = answer === SAFE ? 'the safe answer, no route starts there' : 'the node route answer'
    it.runIf(WIN && exe !== undefined && fs.existsSync(exe))(
      `with no console attached ${label} gives ${claim}`,
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
      const state = path.join(dir, 'route-codepage.txt')
      const shim = path.join(dir, 'shim.cjs')
      // The route asks the console for its live code page and writes the answer down before it answers.
      const codePageArgs = ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding.CodePage']
      const probe =
        `require('node:fs').writeFileSync(${JSON.stringify(state)}, require('node:child_process')` +
        `.spawnSync(${JSON.stringify(exe)}, ${JSON.stringify(codePageArgs)}, ` +
        `{ encoding: 'utf8' }).stdout.trim())\n`
      fs.writeFileSync(shim, probe + SHIMS['healthy']!)
      const guard = buildGuardedCommand({
        shell: 'powershell',
        native: [process.execPath, shim],
        safe: SAFE,
        marker: path.join(dir, 'hook-broken.json'),
      })
      const encoded = Buffer.from(guard, 'utf16le').toString('base64')
      // Outer and inner hosts share one console; the separator splits the guard's answer from the code page.
      const outer =
        '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(850); ' +
        `& '${exe}' -NoProfile -NonInteractive -EncodedCommand ${encoded}; Write-Output 'tg-sep'; ` +
        `& '${exe}' -NoProfile -NonInteractive -Command '[Console]::OutputEncoding.CodePage'`
      const r = spawnSync(exe!, powerShellCommandArgs(outer), {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        cwd: dir,
        input: '{}',
      })
      const [answer = '', codePage = ''] = r.stdout.split('tg-sep')
      const routeCodePage = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : 'the route never ran'
      expect({ status: r.status, answer: answer.trim(), routeCodePage, codePage: codePage.trim() }).toEqual({
        status: 0,
        answer: '{"route":"node"}',
        routeCodePage: '28591',
        codePage: '850',
      })
    })
  }
  // Provenance: FORMAT-DERIVED from src/hook_selftest.ts validAnswer: Claude Code reads pre_compact stdout as text.
  for (const shell of SHELLS.filter((s) => s !== 'cmd')) {
    for (const [event, harness, served] of [
      ['pre_compact', undefined, true],
      ['pre_compact', 'claudecode', true],
      ['pre_compact', 'codex', false],
      ['pre_tool_use', undefined, false],
    ] as const) {
      const who = harness ?? 'a Node-only command'
      it(`${shell}: plain text on ${event} for ${who} is ${served ? '' : 'not '}served`, () => {
        const dir = path.join(root, `pc${String(n++)}`)
        fs.mkdirSync(dir)
        const shim = path.join(dir, 'shim.cjs')
        fs.writeFileSync(shim, "process.stdout.write('summarize the session')\n")
        const exe = path.join(dir, WIN ? 'tg-hook.exe' : 'tg-hook')
        fs.copyFileSync(process.execPath, exe)
        fs.chmodSync(exe, 0o755)
        const nodeArgv = [process.execPath, shim, event, 'entry.js']
        const native = harness === undefined ? nodeArgv : [exe, '--harness', harness, '--', ...nodeArgv]
        const marker = path.join(dir, 'hook-broken.json')
        const command = buildGuardedCommand({ shell, native, safe: SAFE, marker })
        const p = prog(shell)!
        const r = spawnSync(p.program, p.args(command), {
          encoding: 'utf8', cwd: dir, input: '{}', windowsHide: true,
        })
        expect({ status: r.status, stdout: r.stdout }).toEqual({
          status: 0,
          stdout: served ? 'summarize the session' : SAFE,
        })
      })
    }
  }
  it('runs on at least the sh form', () => {
    expect(SHELLS).toContain('sh')
  })
})

describe('the sh guard with no hold files runs no route', () => {
  const sh = it.runIf(SHELLS.includes('sh'))
  sh('a mktemp that always fails gives the safe answer, exit 0, and the route never ran', () => {
    const dir = path.join(root, `nm${String(n++)}`)
    fs.mkdirSync(dir)
    const invoked = path.join(dir, 'mktemp.called')
    fs.writeFileSync(path.join(dir, 'mktemp'), '#!/bin/sh\n: > "$0.called"\nexit 1\n', { mode: 0o755 })
    const ran = path.join(dir, 'ran')
    const route =
      `require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran'); ` +
      `process.stdout.write('not json'); process.exit(2)\n`
    const o = run('sh', route, undefined, '', undefined, '{}', { pathFirst: dir })
    const mktempCalled = fs.existsSync(invoked)
    expect({
      status: o.status,
      stdout: o.stdout,
      stderr: o.stderr,
      ran: fs.existsSync(ran),
      mktempCalled,
    }, 'the fake mktemp was not invoked').toEqual({
      status: 0,
      stdout: SAFE,
      stderr: '',
      ran: false,
      mktempCalled: true,
    })
  })
  sh('a TMPDIR naming a missing directory still serves the route answer', () => {
    const env = { TMPDIR: path.join(root, 'no-such-dir') }
    const o = run('sh', SHIMS['healthy'], undefined, '', undefined, '{}', { env })
    expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
      status: 0,
      stdout: '{"route":"node"}',
      stderr: '',
    })
  })
  sh('a TMPDIR naming a missing directory still judges a broken route', () => {
    const o = run('sh', SHIMS['exit 13 and stdout noise'], undefined, '', undefined, '{}', {
      env: { TMPDIR: path.join(root, 'no-such-dir') },
    })
    expect({ status: o.status, stdout: o.stdout, stderr: o.stderr }).toEqual({
      status: 0,
      stdout: SAFE,
      stderr: '',
    })
  })
})

// Provenance: HAND-DERIVED. The marker bytes are what src/bridges/claudecode.ts prints (`{"async":true}` + LF).
const MARKER_LINE = '{"async":true}\n'
// A route waits this long for its release only on a failing path: a guard that forwards the marker at once releases it within the event that carried the marker, so a passing run never waits any of it out.
const RELEASE_BOUND_MS = 15_000
// An event the guard never forwards for holds the marker, so nothing releases the route: it ends by its bound.
const HELD_BOUND_MS = 1_500

// Ends the guard's shell and its descendants while the handle holds it and its command line names `program`.
function endTree(child: ChildProcess, program: string): void {
  if (child.pid === undefined) return
  const named = (line: string): boolean => line.toLowerCase().includes(path.basename(program).toLowerCase())
  killIfCommandLine(child.pid, named, { tree: true, tied: tiedToHandles([child]) })
}

interface MarkerRun {
  status: number | null
  stdout: string
  stderr: string
  state: string
  runs: number
  tmpLeft: string[]
}

// The route's own helpers: `out` writes bytes at once, `hold` waits (bounded) for the release the row gives on seeing the marker on the guard's stdout and records whether it came, `run` counts this route's starts.
const SHIM_HELPERS = (dir: string, boundMs: number): string =>
  `const fs = require('fs'); const buf = new Int32Array(new SharedArrayBuffer(4))\n` +
  `const wait = (ms) => Atomics.wait(buf, 0, 0, ms)\n` +
  `const runsFile = ${JSON.stringify(path.join(dir, 'runs'))}; fs.appendFileSync(runsFile, 'x')\n` +
  `const run = fs.readFileSync(runsFile).length; const out = (s) => fs.writeSync(1, s)\n` +
  `const hold = () => { const end = Date.now() + ${String(boundMs)}; let yes = false\n` +
  `  const rel = ${JSON.stringify(path.join(dir, 'release'))}\n` +
  `  while (Date.now() < end) { if (fs.existsSync(rel)) { yes = true; break }\n` +
  `    wait(20) }\n` +
  `  fs.writeFileSync(${JSON.stringify(path.join(dir, 'state'))}, yes ? 'released=yes' : 'released=no') }\n`

interface MarkerOptions {
  readonly event?: string
  readonly boundMs?: number
  readonly input?: string
}

// Runs the guard round a route written by `body`; releases the route on reading the marker line on stdout.
async function runMarkerShim(shell: GuardShell, body: string, opts: MarkerOptions = {}): Promise<MarkerRun> {
  const dir = path.join(root, `m${String(n++)}`)
  fs.mkdirSync(dir)
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  const shim = path.join(dir, 'shim.cjs')
  fs.writeFileSync(shim, SHIM_HELPERS(dir, opts.boundMs ?? RELEASE_BOUND_MS) + body)
  const command = buildGuardedCommand({
    shell,
    native: [process.execPath, shim, opts.event ?? 'subagent_stop'],
    safe: SAFE,
    marker: path.join(dir, 'hook-broken.json'),
  })
  const p = prog(shell)!
  const child = spawn(p.program, p.args(command), {
    cwd: dir,
    env: { ...process.env, TMPDIR: tmp },
    windowsHide: true,
    windowsVerbatimArguments: p.verbatim === true,
    detached: !WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
      if (stdout.includes(MARKER_LINE)) fs.writeFileSync(path.join(dir, 'release'), '')
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    // A shell that ends before reading its payload closes the pipe early; that is not a failure of the row.
    child.stdin.on('error', () => undefined)
    child.stdin.end(opts.input ?? '{}')
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve))
    const read = (f: string): string => {
      const file = path.join(dir, f)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    }
    return {
      status,
      stdout,
      stderr,
      state: read('state') === '' ? 'route never held' : read('state'),
      runs: read('runs').length,
      tmpLeft: fs.readdirSync(tmp),
    }
  } finally {
    endTree(child, p.program)
  }
}

const ANSWER = "out('{}')\n"

describe('the async marker through the guard is forwarded at once', () => {
  for (const shell of SHELLS) {
    it(`${shell}: a leading marker is on the guard's stdout while the route still runs`, async () => {
      const o = await runMarkerShim(shell, `out(${JSON.stringify(MARKER_LINE)}); hold(); ${ANSWER}`)
      const seen = { state: o.state, status: o.status, stdout: o.stdout, stderr: o.stderr, tmpLeft: o.tmpLeft }
      expect(seen).toEqual({
        state: 'released=yes',
        status: 0,
        stdout: `${MARKER_LINE}{}`,
        stderr: '',
        tmpLeft: [],
      })
    })

    it(`${shell}: a marker written in two parts is forwarded as one whole line`, async () => {
      const o = await runMarkerShim(
        shell,
        `out('{"async":'); wait(100); out('true}\\n'); hold(); ${ANSWER}`,
      )
      expect({ state: o.state, status: o.status, stdout: o.stdout }).toEqual({
        state: 'released=yes',
        status: 0,
        stdout: `${MARKER_LINE}{}`,
      })
    })

    it(`${shell}: a route failing after the marker gives the marker alone, exit 0, no next route`, async () => {
      const body =
        `out(${JSON.stringify(MARKER_LINE)}); out('part'); process.stderr.write('noise\\n'); process.exit(13)\n`
      const o = await runMarkerShim(shell, body)
      const seen = { status: o.status, stdout: o.stdout, stderr: o.stderr, runs: o.runs, tmpLeft: o.tmpLeft }
      expect(seen).toEqual({
        status: 0,
        stdout: MARKER_LINE,
        stderr: '',
        runs: 1,
        tmpLeft: [],
      })
    })

    it(`${shell}: a route that fails before any marker falls through to the next route`, async () => {
      const body = `if (run === 1) process.exit(1)\nout(${JSON.stringify(MARKER_LINE)}); hold(); ${ANSWER}`
      const o = await runMarkerShim(shell, body)
      expect({ state: o.state, status: o.status, stdout: o.stdout, runs: o.runs }).toEqual({
        state: 'released=yes',
        status: 0,
        stdout: `${MARKER_LINE}{}`,
        runs: 2,
      })
    })

    it(`${shell}: two routes that would both print a marker give one marker`, async () => {
      const body =
        `if (run === 1) { out('{"first":1}\\n'); out(${JSON.stringify(MARKER_LINE)}); process.exit(1) }\n` +
        `out(${JSON.stringify(MARKER_LINE)}); ${ANSWER}`
      const o = await runMarkerShim(shell, body)
      expect({ status: o.status, stdout: o.stdout, runs: o.runs }).toEqual({
        status: 0,
        stdout: `${MARKER_LINE}{}`,
        runs: 2,
      })
    })

    it(`${shell}: a route whose first line is not the marker is held and replayed whole`, async () => {
      const text = `{"a":1}\n${MARKER_LINE}{}`
      const o = await runMarkerShim(shell, `out(${JSON.stringify(text)})\n`)
      expect({ status: o.status, stdout: o.stdout }).toEqual({ status: 0, stdout: text })
    })

    it(`${shell}: the payload on stdin still reaches a route that forwards the marker`, async () => {
      const body =
        `out(${JSON.stringify(MARKER_LINE)}); let d = ''; process.stdin.on('data', (c) => { d += c })\n` +
        "process.stdin.on('end', () => out(JSON.stringify({ got: d })))\n"
      const o = await runMarkerShim(shell, body, { input: PAYLOAD })
      expect({ status: o.status, stdout: o.stdout }).toEqual({
        status: 0,
        stdout: `${MARKER_LINE}${JSON.stringify({ got: PAYLOAD })}`,
      })
    })

    it(`${shell}: an event that is never eligible holds the marker as ordinary output`, async () => {
      const body = `out(${JSON.stringify(MARKER_LINE)}); hold(); ${ANSWER}`
      const o = await runMarkerShim(shell, body, { event: 'pre_tool_use', boundMs: HELD_BOUND_MS })
      expect({ state: o.state, status: o.status, stdout: o.stdout }).toEqual({
        state: 'released=no',
        status: 0,
        stdout: `${MARKER_LINE}{}`,
      })
    })
  }
})
