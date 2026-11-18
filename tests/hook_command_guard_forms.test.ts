/** The guarded hook command, run through the real shell each host uses (Git Bash or /bin/sh for the sh form, PowerShell for the other). Rows derive from the wirings: every harness and event the payload fixtures cover, in each shell form, with the safe answer and notice path the builder writes for it. The native client is a stand-in (a copy of node that prints its route), so the route taken is read off stdout; the real client behind the same registered line is driven by native_hook_conformance and native_hook_install_e2e. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildGuardedCommand, GUARD_VERSION, guardedPaths, HookCommandRewriteError, parseGuardedCommand, type GuardShell } from '../src/hook_guard.js'
import { noopFor } from '../src/hook_adapters.js'
import { nativeHookCommandLine, splitHookCommand } from '../src/native_hook.js'
import { powerShellCommandArgs, resolvePowerShell, resolveWindowsBash } from '../src/shell.js'
import { HARNESS_HOOK_PAYLOADS } from './fixtures/harness_hook_payloads.js'

const WIN = process.platform === 'win32'
const SPECIAL_DIR = `tg q'x $y %z% (a) & é`

const STAND_EXE = `const code = process.env.TG_TEST_EXIT === '2' ? 2 : 0
process.stdout.write(JSON.stringify(code === 2 ? { route: 'exe', decision: 'block' } : { route: 'exe' }))
process.exitCode = code
`
const STAND_SHIM = `const code = process.env.TG_TEST_EXIT === '2' ? 2 : 0
process.stdout.write(JSON.stringify(code === 2 ? { route: 'node', decision: 'block' } : { route: 'node' }))
process.exitCode = code
`

function shellProgram(shell: GuardShell): { program: string; args: (command: string) => string[] } | null {
  if (shell === 'sh') {
    const program = WIN ? resolveWindowsBash() : '/bin/sh'
    return program === null ? null : { program, args: (c) => ['-c', c] }
  }
  const program = resolvePowerShell()
  if (!WIN && !fs.existsSync(program)) return null
  return { program, args: powerShellCommandArgs }
}

const shells: GuardShell[] = (['sh', 'powershell'] as const).filter((s) => s === 'sh' || WIN || shellProgram(s) !== null)

interface Row {
  harness: string
  event: string
  shell: GuardShell
}

const wiringRows: Row[] = []
for (const c of HARNESS_HOOK_PAYLOADS) {
  for (const shell of shells) if (!wiringRows.some((r) => r.harness === c.harness && r.event === c.event && r.shell === shell)) wiringRows.push({ harness: c.harness, event: c.event, shell })
}

type ExeState = 'ok' | 'missing' | 'empty' | 'not-executable' | 'garbage'
type Route = 'exe' | 'node' | 'safe'

interface Layout {
  exe: ExeState
  shim: boolean
  nodeAbs: boolean
  nodeOnPath: boolean
  dirName?: string
  exit?: 2
}

let root = ''
let nodeCopy = ''

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-guard-forms-')))
  nodeCopy = path.join(root, WIN ? 'node-copy.exe' : 'node-copy')
  fs.copyFileSync(process.execPath, nodeCopy)
  fs.chmodSync(nodeCopy, 0o755)
})

afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true })
})

interface Outcome {
  status: number | null
  stdout: string
  route: Route
  markerWritten: boolean
  notice: { schema?: number; events?: Array<{ route?: string }> } | undefined
}

let counter = 0

function run(row: Row, layout: Layout): Outcome {
  const prog = shellProgram(row.shell)
  if (prog === null) throw new Error(`no ${row.shell} shell on this machine`)
  const dir = path.join(root, `case-${String(counter++)}`, layout.dirName ?? 'd')
  fs.mkdirSync(dir, { recursive: true })
  const exePath = path.join(dir, WIN ? 'tg-hook.exe' : 'tg-hook')
  const standExe = path.join(dir, 'stand_exe.cjs')
  const shim = path.join(dir, 'token-goat-shim.cjs')
  fs.writeFileSync(standExe, STAND_EXE)
  if (layout.shim) fs.writeFileSync(shim, STAND_SHIM)
  if (layout.exe === 'ok' || layout.exe === 'not-executable') fs.copyFileSync(nodeCopy, exePath)
  if (layout.exe === 'empty') fs.writeFileSync(exePath, '')
  if (layout.exe === 'garbage') fs.writeFileSync(exePath, Buffer.from([0x7f, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x81, 0x90]))
  if (layout.exe === 'not-executable' && !WIN) fs.chmodSync(exePath, 0o644)
  if (layout.exe === 'garbage' && !WIN) fs.chmodSync(exePath, 0o755)
  const nodeAbs = layout.nodeAbs ? process.execPath : path.join(dir, 'no-such-node', WIN ? 'node.exe' : 'node')
  const wired = nativeHookCommandLine(row.shell, exePath, row.harness as never, shim, row.event, path.join(dir, 'token-goat.mjs'))
  const parsed = wired === undefined ? undefined : parseGuardedCommand(wired)
  if (parsed === undefined || parsed.kind !== 'v1') throw new Error(`the wiring row ${JSON.stringify(row)} did not produce a guarded command: ${String(wired)}`)
  const marker = path.join(dir, 'hook-broken.json')
  const safe = noopFor(row.harness as never, row.event)
  expect(parsed.safe).toBe(safe)
  const command = buildGuardedCommand({ shell: row.shell, native: [exePath, standExe, '--', nodeAbs, shim], safe, marker })
  const pathEnv = layout.nodeOnPath ? [path.dirname(process.execPath), path.dirname(prog.program)].join(path.delimiter) : path.dirname(prog.program)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathEnv, ...(layout.exit === 2 ? { TG_TEST_EXIT: '2' } : { TG_TEST_EXIT: '' }) }
  const r = spawnSync(prog.program, prog.args(command), { env, encoding: 'utf8', timeout: 60_000, windowsHide: true, cwd: dir, input: '{}' })
  const out = r.stdout
  const route: Route = out.includes('"route":"exe"') ? 'exe' : out.includes('"route":"node"') ? 'node' : 'safe'
  return { status: r.status, stdout: out, route, markerWritten: fs.existsSync(marker), notice: fs.existsSync(marker) ? parseNotice(fs.readFileSync(marker, 'utf8')) : undefined }
}

function expectedRoute(l: Layout): Route {
  if (l.exe === 'ok') return 'exe'
  if (l.shim && (l.nodeAbs || l.nodeOnPath)) return 'node'
  return 'safe'
}

const CASES: ReadonlyArray<readonly [string, Layout]> = [
  ['exe present', { exe: 'ok', shim: true, nodeAbs: true, nodeOnPath: true }],
  ['exe missing', { exe: 'missing', shim: true, nodeAbs: true, nodeOnPath: true }],
  ['exe and shim missing', { exe: 'missing', shim: false, nodeAbs: true, nodeOnPath: true }],
]

describe('the guarded command on every wiring row, in its own shell', () => {
  it('derives its rows from the wirings', () => {
    expect(wiringRows.length).toBeGreaterThan(10)
    expect(new Set(wiringRows.map((r) => r.harness))).toEqual(new Set(HARNESS_HOOK_PAYLOADS.map((c) => c.harness)))
  })

  for (const row of wiringRows) {
    it(`${row.harness} ${row.event} through ${row.shell}: exe, then Node, then the safe answer, always exit 0`, () => {
      for (const [name, layout] of CASES) {
        const o = run(row, layout)
        const want = expectedRoute(layout)
        expect(o.route, `${name}: ${o.stdout}`).toBe(want)
        expect(o.status, name).toBe(0)
        if (want === 'safe') {
          expect(o.stdout, name).toBe(noopFor(row.harness as never, row.event))
          expect(o.markerWritten, name).toBe(true)
          expect(o.notice?.schema, name).toBe(1)
          expect(o.notice?.events?.[0]?.route, name).toBe('guard')
        } else expect(o.markerWritten, name).toBe(false)
      }
    })
  }
})

describe('the guard on the routes the wiring rows do not cross', () => {
  const rep = (shell: GuardShell): Row => ({ harness: 'claudecode', event: 'pre_tool_use', shell })
  const EXOTIC: ReadonlyArray<readonly [string, Layout]> = [
    ['exe of zero bytes', { exe: 'empty', shim: true, nodeAbs: true, nodeOnPath: false }],
    ['exe not executable (or not a program on Windows)', { exe: WIN ? 'garbage' : 'not-executable', shim: true, nodeAbs: true, nodeOnPath: false }],
    ['exe of garbage bytes', { exe: 'garbage', shim: true, nodeAbs: true, nodeOnPath: false }],
    ['the registered node gone, node on PATH', { exe: 'missing', shim: true, nodeAbs: false, nodeOnPath: true }],
    ['node missing from PATH and from its registered path', { exe: 'missing', shim: true, nodeAbs: false, nodeOnPath: false }],
    ['special characters in every path, exe present', { exe: 'ok', shim: true, nodeAbs: true, nodeOnPath: false, dirName: SPECIAL_DIR }],
    ['special characters in every path, exe missing', { exe: 'missing', shim: true, nodeAbs: true, nodeOnPath: false, dirName: SPECIAL_DIR }],
    ['special characters in every path, nothing runs', { exe: 'missing', shim: false, nodeAbs: true, nodeOnPath: false, dirName: SPECIAL_DIR }],
  ]
  for (const shell of shells) {
    for (const [name, layout] of EXOTIC) {
      it(`${name} through ${shell}`, () => {
        const o = run(rep(shell), layout)
        expect(o.route, o.stdout).toBe(expectedRoute(layout))
        expect(o.status).toBe(0)
        if (o.route === 'safe') expect(o.markerWritten).toBe(true)
      })
    }
    it(`an exit 2 block with its JSON still blocks through ${shell}, on the exe route and on the Node route`, () => {
      const viaExe = run(rep(shell), { exe: 'ok', shim: true, nodeAbs: true, nodeOnPath: false, exit: 2 })
      expect(viaExe.status).toBe(2)
      expect(JSON.parse(viaExe.stdout)).toEqual({ route: 'exe', decision: 'block' })
      const viaNode = run(rep(shell), { exe: 'missing', shim: true, nodeAbs: true, nodeOnPath: false, exit: 2 })
      expect(viaNode.status).toBe(2)
      expect(JSON.parse(viaNode.stdout)).toEqual({ route: 'node', decision: 'block' })
    })
  }
})

function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [..."abcXYZ019 _-./\\:'\"$&()%;|<>!*~`{}[]#=,@^+?é日\u{1F600}‘’‚‛"]

describe('the parser reads back what the builder wrote', () => {
  const rand = prng(20261117)
  const word = (): string => {
    const n = Math.floor(rand() * 14)
    return Array.from({ length: n }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]!).join('')
  }
  for (const shell of shells) {
    it(`round-trips random words through ${shell}`, () => {
      for (let i = 0; i < 300; i++) {
        const native = [word(), '--harness', word(), '--', word(), word(), word()]
        const safe = word()
        const marker = word()
        const line = buildGuardedCommand({ shell, native, safe, marker })
        const back = parseGuardedCommand(line)
        expect(back, JSON.stringify({ native, safe, marker })).toEqual({ kind: 'v1', shell, native, safe, marker })
      }
    })
  }
  it('round-trips the special-character path of every shell in both guard forms', () => {
    for (const shell of ['sh', 'powershell'] as const) {
      const bin = path.join(root || os.tmpdir(), SPECIAL_DIR, 'tg-hook.exe')
      const line = buildGuardedCommand({ shell, native: [bin, '--', 'node', 'shim.cjs'], safe: '{"a":"it\'s"}', marker: bin + '.json' })
      const back = parseGuardedCommand(line)
      expect(back?.kind).toBe('v1')
      if (back?.kind === 'v1') expect(guardedPaths(back)).toEqual([bin, bin + '.json'])
      expect(splitHookCommand(line, shell)[0]).toBe(bin)
    }
  })
  it('refuses a word it cannot quote, and reads a newer version as newer and a damaged one as malformed', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) {
      expect(() => buildGuardedCommand({ shell: 'sh', native: [bad], safe: '{}', marker: 'm' })).toThrow(HookCommandRewriteError)
    }
    expect(parseGuardedCommand(`: tg-guard-v${String(GUARD_VERSION + 1)}; whatever`)).toEqual({ kind: 'newer', version: GUARD_VERSION + 1 })
    expect(parseGuardedCommand(': tg-guard-v1; exit 0')?.kind).toBe('malformed')
    expect(parseGuardedCommand('token-goat hook x')).toBeUndefined()
  })
})

function parseNotice(raw: string): Outcome['notice'] {
  try {
    return JSON.parse(raw) as Outcome['notice']
  } catch (e) {
    throw new Error(`the notice the guard wrote is not JSON (${String(e)}): ${raw}`, { cause: e })
  }
}
