/** Wiring of scripts/eval-retrieval.ts around the binary it drives: it must exclude its own fixtures from the eval home's index before asking anything, refuse to score an arm that retrieved them, and report the weak-match line that home has configured rather than the shipped default. The stand-in binary's `semantic --json` payload is FORMAT-DERIVED from src/read_semantic.ts (`items[].filePath/startLine/endLine/distance`); its `config get --json` line is FORMAT-DERIVED from src/config_commands.ts (`get` spreads `{source}` beside `key`/`value`). The queries, distances and expected lines are HAND-DERIVED from the rows written here. The baseline files are FORMAT-DERIVED from evals/retrieval/gate.ts::toBaseline (arms[name] maps query id to rank), and the committed evals/retrieval/baseline.json is read as CAPTURE. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toBaseline } from '../evals/retrieval/gate.js'
import { splitOf } from '../evals/retrieval/metrics.js'
import { assertRan, baselineRanks, findOnPath, fixtureHits, pairWithBaseline, parseConfiguredNumber, resolveBin, shimBundlePath } from '../scripts/eval-retrieval.js'
import { endSurvivors, runOwned, selectSurvivors, SURVIVOR_QUERY_TIMEOUT_MS, type ProcRow, type SurvivorIo } from '../scripts/eval-run-owned.js'

const FAKE_BIN = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_TG_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'config') { process.stdout.write(JSON.stringify({ key: args[2], value: 0.6, source: 'global' }) + '\\n'); process.exit(0) }
if (args[0] === 'semantic' && process.env.FAKE_TG_CRASH === '1') { process.stderr.write('stand-in crashed on purpose\\n'); process.exit(2) }
if (args[0] === 'semantic') {
  const q = args[args.length - 1]
  const file = process.env.FAKE_TG_FIXTURE_HIT === '1' ? 'evals/retrieval/golden.jsonl' : 'doc.md'
  const distance = q.startsWith('absent') ? 0.95 : 0.4
  const payload = { source: 'embeddings', items: [{ filePath: file, name: null, kind: null, startLine: 1, endLine: 3, rank: 1, rrf: 0.01, retrieval: 'dense', distance, preview: '' }], truncated: false, totalCount: 1 }
  process.stdout.write(args.includes('-j') ? JSON.stringify(payload) + '\\n' : file + ':1-3\\n')
}
process.exit(0)
`

let root: string

/** One answerable and one absent query in each split, which is what the weak line needs to be fitted on train and scored on test (a class missing from a split leaves it unscored). Each query costs the harness two spawns of the stand-in binary (JSON, then text), so the least that exercises the wiring keeps the run short on a machine where a spawn is slow. */
function golden(): string {
  const want = new Map<string, number>()
  const lines: string[] = []
  for (let i = 0; lines.length < 4; i++) {
    const id = `q${i}`
    for (const kind of ['doc', 'absent'] as const) {
      const key = `${splitOf(id)}/${kind}`
      if ((want.get(key) ?? 0) >= 1) continue
      want.set(key, (want.get(key) ?? 0) + 1)
      lines.push(JSON.stringify({ id, query: `${kind === 'absent' ? 'absent' : 'alpha'} query ${i}`, kind, relevant: kind === 'absent' ? [] : [{ file: 'doc.md', heading: 'Alpha' }] }))
      break
    }
  }
  return `${lines.join('\n')}\n`
}

function runHarness(env: Record<string, string> = {}, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string; calls: string[][] } {
  const log = path.join(root, 'calls.jsonl')
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--home', path.join(root, 'home'), '--bin', path.join(root, 'fake-tg.mjs'), '--root', path.join(root, 'proj'), '--arms', 'semantic', ...extraArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FAKE_TG_LOG: log, ...env },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eval-wiring-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(path.join(proj, 'evals', 'retrieval'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'doc.md'), '# Alpha\n\nalpha text\n')
  fs.writeFileSync(path.join(proj, 'evals', 'retrieval', 'golden.jsonl'), golden())
  fs.writeFileSync(path.join(root, 'fake-tg.mjs'), FAKE_BIN)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('eval-retrieval harness wiring', () => {
  it('excludes its fixtures before the first query and reports the configured weak line', () => {
    const r = runHarness()
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls[0]).toEqual(['project', 'exclude', path.join(root, 'proj', 'evals', 'retrieval')])
    expect(r.calls.slice(1).some((c) => c[0] === 'project'), 'excluded once, before anything else').toBe(false)
    expect(r.stdout).toContain('weak_distance 0.600 (configured) on test')
    expect(r.stdout).not.toContain('weak_distance 0.850 (configured)')
  }, 60_000)

  it('refuses to score an arm that retrieved its own fixtures', () => {
    const r = runHarness({ FAKE_TG_FIXTURE_HIT: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("semantic retrieved the eval's own fixtures")
    expect(r.stderr).toContain('evals/retrieval/golden.jsonl')
    expect(r.stdout).not.toContain('weak_distance')
  }, 60_000)
})

describe('eval-retrieval crash', () => {
  it('stops with a nonzero exit naming the command and its stderr when an arm exits 2, and prints no scores (HAND-DERIVED: the stand-in exits 2 on purpose)', () => {
    const r = runHarness({ FAKE_TG_CRASH: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('token-goat semantic')
    expect(r.stderr).toContain('exited 2')
    expect(r.stderr).toContain('stand-in crashed on purpose')
    expect(r.stdout).not.toContain('weak_distance')
  }, 60_000)
})

describe('resolveBin', () => {
  // FORMAT-DERIVED: the launch line of an npm global .cmd shim as npm writes it, copied from the shim of the installed token-goat package (%dp0% is the shim's directory).
  const shimText = (rel: string): string => `@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`
  const none = (): string | null => null

  it('runs a .mjs bundle under this Node and a non-Windows binary directly', () => {
    expect(resolveBin('x/dist/token-goat.mjs', 'win32', none)).toEqual({ command: process.execPath, prefix: ['x/dist/token-goat.mjs'] })
    expect(resolveBin('token-goat', 'linux', none)).toEqual({ command: 'token-goat', prefix: [] })
  })

  it('resolves a Windows shim path word against the shim directory with Windows rules on any host', () => {
    expect(shimBundlePath('C:\\npm\\tg.cmd', 'node_modules\\pkg\\dist\\tg.mjs', 'win32')).toBe('C:\\npm\\node_modules\\pkg\\dist\\tg.mjs')
    expect(shimBundlePath('C:\\npm\\tg.cmd', '..\\x\\tg.mjs', 'win32')).toBe('C:\\x\\tg.mjs')
    expect(shimBundlePath('/opt/npm/tg', 'lib/tg.mjs', 'linux')).toBe('/opt/npm/lib/tg.mjs')
  })

  it('finds a name that already carries a PATHEXT extension as written, through the real resolveOnPath fallback', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'bin-')))
    fs.writeFileSync(path.join(dir, 'tool.exe'), '')
    fs.writeFileSync(path.join(dir, 'plain.cmd'), '@ECHO off\r\ntool.exe %*\r\n')
    const saved = { PATH: process.env['PATH'], PATHEXT: process.env['PATHEXT'] }
    process.env['PATH'] = dir
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD;.exe;.cmd'
    try {
      expect(findOnPath('tool.exe')).toBe(path.join(dir, 'tool.exe'))
      expect(resolveBin('tool.exe', 'win32')).toEqual({ command: path.join(dir, 'tool.exe'), prefix: [] })
      expect(() => resolveBin('plain.cmd', 'win32')).toThrow(/resolves to .*plain\.cmd, which names no existing \.mjs bundle/)
      expect(findOnPath('ghost.exe')).toBeNull()
      expect(findOnPath('tool.txt')).toBeNull()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it.skipIf(process.platform !== 'win32')('resolves a .cmd shim, given by path or found on PATH, to the .mjs it launches, never to a shell', () => {
    fs.mkdirSync(path.join(root, 'shim', 'node_modules', 'pkg', 'dist'), { recursive: true })
    const bundle = path.join(root, 'shim', 'node_modules', 'pkg', 'dist', 'tg.mjs')
    fs.writeFileSync(bundle, '')
    const shim = path.join(root, 'shim', 'tg.cmd')
    fs.writeFileSync(shim, shimText('node_modules\\pkg\\dist\\tg.mjs'))
    const want = { command: process.execPath, prefix: [bundle] }
    expect(resolveBin(shim, 'win32', none)).toEqual(want)
    expect(resolveBin(path.join(root, 'shim', 'tg'), 'win32', none)).toEqual(want)
    expect(resolveBin('tg', 'win32', (name) => (name === 'tg' ? shim : null))).toEqual(want)
  })

  it('refuses a shim whose .mjs is missing, a shim naming no .mjs, and a name that is not there', () => {
    const missing = path.join(root, 'missing.cmd')
    fs.writeFileSync(missing, shimText('nowhere\\tg.mjs'))
    expect(() => resolveBin(missing, 'win32', none)).toThrow(/which names no existing \.mjs bundle.*never starts a shell/)
    const plain = path.join(root, 'plain.cmd')
    fs.writeFileSync(plain, '@ECHO off\r\ntoken-goat.exe %*\r\n')
    expect(() => resolveBin(plain, 'win32', none)).toThrow(/names no existing \.mjs bundle/)
    expect(() => resolveBin('ghost', 'win32', none)).toThrow(/--bin "ghost" was not found/)
  })

  it.skipIf(process.platform !== 'win32')('drives the harness through a real .cmd shim with no shell between the eval and the stand-in', () => {
    const shim = path.join(root, 'shim.cmd')
    fs.writeFileSync(shim, shimText('fake-tg.mjs'))
    const log = path.join(root, 'calls.jsonl')
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--home', path.join(root, 'home'), '--bin', shim, '--root', path.join(root, 'proj'), '--arms', 'semantic'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env: { ...process.env, FAKE_TG_LOG: log } })
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).toContain('"semantic"')
  }, 60_000)
})

describe('runOwned', () => {
  // HAND-DERIVED stand-ins: each connects back to the test's TCP server so the test learns of the process's death from the socket closing, an event, never from elapsed time. The echo answers a ping, which only a live process can do.
  const probeJs = (hold: string): string => `import net from 'node:net'\n${hold}\nconst s = net.connect(Number(process.env.PROBE_PORT), '127.0.0.1')\ns.on('error', () => {})\ns.on('data', () => s.write('alive'))\ns.on('close', () => process.exit(0))\nsetInterval(() => {}, 1000)\n`
  let server: net.Server
  let sockets: net.Socket[]
  let port: number
  let connected: Promise<net.Socket>

  beforeEach(async () => {
    sockets = []
    server = net.createServer()
    connected = new Promise((resolve) => server.once('connection', resolve))
    server.on('connection', (s) => {
      s.on('error', () => {})
      sockets.push(s)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as net.AddressInfo).port
  })

  afterEach(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const alive = (sock: net.Socket): Promise<boolean> =>
    new Promise((resolve) => {
      if (sock.destroyed) return resolve(false)
      sock.once('data', () => resolve(true))
      sock.once('close', () => resolve(false))
      sock.write('ping')
    })

  const start = (script: string, ctl: AbortController, timeoutMs = 60_000, maxBytes = 1_000_000): ReturnType<typeof runOwned> => {
    const file = path.join(root, `standin-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, script)
    return runOwned(process.execPath, [file], { cwd: root, env: { ...process.env, PROBE_PORT: String(port) }, timeoutMs, maxBytes, signal: ctl.signal })
  }

  it('ends a detached grandchild together with the child when the run is stopped', async () => {
    const gc = path.join(root, 'grandchild.mjs')
    fs.writeFileSync(gc, probeJs(''))
    const parent = `import { spawn } from 'node:child_process'\nspawn(process.execPath, [${JSON.stringify(gc)}], { detached: true, stdio: 'ignore', env: process.env }).unref()\nsetInterval(() => {}, 1000)\n`
    const ctl = new AbortController()
    const run = start(parent, ctl)
    try {
      const grandchild = await connected
      ctl.abort()
      const r = await run
      expect(r.error?.code).toBe('ABORT_ERR')
      expect(await alive(grandchild), 'the grandchild must be gone once the run has ended').toBe(false)
    } finally {
      ctl.abort()
      await run
    }
  }, 60_000)

  it('ends a survivor that holds the pipe after the root exited, and resolves instead of waiting for the pipe', async () => {
    // The survivor connects only once its stdin pipe, whose other end the root holds, reaches end of file, which happens when the root exits (a pid probe is no use on Windows, where a parent's handle keeps an exited process answering); it is detached only on Windows, because libuv ends a Windows child that is not when its parent exits, while on POSIX detached means setsid, which would put the survivor outside the root's process group that the stop signals; so the stop below always meets an exited root, and the survivor dies when the test's socket closes.
    const gc = path.join(root, 'survivor.mjs')
    fs.writeFileSync(gc, `import net from 'node:net'\nprocess.stdin.on('data', () => {})\nprocess.stdin.on('end', () => {\n  const s = net.connect(Number(process.env.PROBE_PORT), '127.0.0.1')\n  s.on('error', () => {})\n  s.on('data', () => s.write('alive'))\n  s.on('close', () => process.exit(0))\n})\nsetInterval(() => {}, 1000)\n`)
    const parent = `import { spawn } from 'node:child_process'\nconst c = spawn(process.execPath, [${JSON.stringify(gc)}], { detached: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'], env: process.env })\nc.unref()\nc.stdin.unref()\n`
    const ctl = new AbortController()
    const run = start(parent, ctl)
    let result: Awaited<typeof run> | undefined
    void run.then((r) => {
      result = r
    })
    const survivor = await connected
    // The round trip also lets the run observe the root's exit, which was queued before the survivor even connected.
    expect(await alive(survivor), 'the survivor must be running before the stop').toBe(true)
    ctl.abort()
    // One event-loop turn: the stop ends the survivors and resolves synchronously, so a run that is still pending after it is waiting on the pipe.
    await new Promise((resolve) => setImmediate(resolve))
    expect(result?.error?.code, 'a stop after the root exited must resolve the run with the abort').toBe('ABORT_ERR')
    expect(await alive(survivor), 'the survivor holding the pipe must be gone').toBe(false)
  }, 60_000)

  it('stops a run whose output passes the limit with ENOBUFS and keeps no more than the limit', async () => {
    const ctl = new AbortController()
    const r = await start("process.stdout.write('x'.repeat(5000), () => process.exit(0))\n", ctl, 60_000, 1000)
    expect(r.error?.code).toBe('ENOBUFS')
    expect(r.stdout.length).toBeLessThanOrEqual(1000)
  }, 60_000)

  it('stops an overflowing child at the overflow instead of waiting for it to exit', async () => {
    // The stand-in flushes 5000 bytes, tells the test over the socket, and exits only on release, so the run can end before release only by ending the child itself; no step waits on time.
    const script = `import net from 'node:net'\nconst s = net.connect(Number(process.env.PROBE_PORT), '127.0.0.1')\ns.on('error', () => {})\ns.on('connect', () => process.stdout.write('x'.repeat(5000), () => s.write('flushed')))\ns.on('data', (d) => {\n  if (String(d).includes('release')) process.exit(0)\n  s.write('alive')\n})\ns.on('close', () => process.exit(0))\nsetInterval(() => {}, 1000)\n`
    const ctl = new AbortController()
    const run = start(script, ctl, 60_000, 1000)
    const sock = await connected
    await new Promise<void>((resolve) => {
      const on = (d: Buffer): void => {
        if (!String(d).includes('flushed')) return
        sock.off('data', on)
        resolve()
      }
      sock.on('data', on)
      sock.once('close', () => resolve())
    })
    const endedEarly = !(await alive(sock))
    if (!endedEarly) sock.write('release')
    const r = await run
    expect(r.error?.code, 'an output overflow must stop the run with ENOBUFS').toBe('ENOBUFS')
    expect(endedEarly, 'the overflowing child must be ended without needing release').toBe(true)
  }, 60_000)

  it('runs without any deadline when none is given', async () => {
    const file = path.join(root, 'quick.mjs')
    fs.writeFileSync(file, "process.stdout.write('done')\n")
    const r = await runOwned(process.execPath, [file], { cwd: root, env: process.env, maxBytes: 1000 })
    expect(r).toMatchObject({ stdout: 'done', status: 0 })
    expect(r.error).toBeUndefined()
  }, 60_000)

  it('ends a child that ignores SIGTERM instead of staying blocked on it', async () => {
    const ctl = new AbortController()
    const run = start(probeJs("process.on('SIGTERM', () => {})"), ctl)
    try {
      const child = await connected
      ctl.abort()
      const r = await run
      expect(r.error?.code).toBe('ABORT_ERR')
      expect(await alive(child), 'a child that ignores SIGTERM must still be gone').toBe(false)
    } finally {
      ctl.abort()
      await run
    }
  }, 60_000)

  it('reports the deadline as ETIMEDOUT through assertRan, and returns output and exit code of a run that ends by itself', async () => {
    const ctl = new AbortController()
    const hung = await start('setInterval(() => {}, 1000)\n', ctl, 200)
    expect(hung.error?.code).toBe('ETIMEDOUT')
    expect(() => assertRan(hung, ['semantic', 'q'])).toThrow(/token-goat semantic q timed out after 60000 ms/)
    const done = await start("process.stdout.write('hi')\nprocess.stderr.write('lo')\nprocess.exit(3)\n", ctl)
    expect(done).toMatchObject({ stdout: 'hi', stderr: 'lo', status: 3 })
    expect(done.error).toBeUndefined()
  }, 60_000)
})

describe('survivors of an exited root', () => {
  // HAND-DERIVED: a process table written out by hand for the rule under test, creation times in epoch milliseconds; no wire format is claimed.
  const row = (pid: number, ppid: number, createdMs: number): ProcRow => ({ pid, ppid, createdMs })

  it('takes the first generation inside the root window and descendants created no earlier than their parent', () => {
    const rows = [row(200, 100, 1000), row(300, 200, 1200), row(400, 300, 1300), row(210, 100, 5000), row(220, 100, 50)]
    expect(selectSurvivors(rows, 100, 900, 2000).sort()).toEqual([200, 300, 400])
  })

  it('never takes a descendant that is older than the parent it names, which is a recycled pid', () => {
    const rows = [row(200, 100, 1000), row(300, 200, 500), row(310, 200, 1500)]
    expect(selectSurvivors(rows, 100, 900, 2000).sort(), 'pid 300 predates pid 200, so it only reuses the number').toEqual([200, 310])
  })

  const killsOf = (platform: NodeJS.Platform, query: SurvivorIo['query'], throwOnProbe = false): { calls: Array<[number, NodeJS.Signals | 0]>; io: SurvivorIo } => {
    const calls: Array<[number, NodeJS.Signals | 0]> = []
    const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
      calls.push([pid, signal])
      if (throwOnProbe && signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }
    return { calls, io: { platform, query, kill } }
  }
  const noQuery: SurvivorIo['query'] = () => ({ status: 0, stdout: '', error: undefined })

  it('probes the process group on POSIX and sends SIGKILL only to a group that still exists', () => {
    const live = killsOf('linux', noQuery)
    endSurvivors(4321, 0, 1, live.io)
    expect(live.calls).toEqual([[-4321, 0], [-4321, 'SIGKILL']])
    const gone = killsOf('linux', noQuery, true)
    endSurvivors(4321, 0, 1, gone.io)
    expect(gone.calls, 'a group that failed the probe must not be sent SIGKILL').toEqual([[-4321, 0]])
  })

  it('kills only the survivors the listed table selects on Windows', () => {
    const table = JSON.stringify([{ p: 200, pp: 100, c: 1000 }, { p: 300, pp: 200, c: 500 }, { p: 400, pp: 999, c: 1000 }])
    const k = killsOf('win32', () => ({ status: 0, stdout: table, error: undefined }))
    endSurvivors(100, 900, 2000, k.io)
    expect(k.calls).toEqual([[200, 'SIGKILL']])
  })

  it('reports a timed-out table query with the bounded timeout and kills nothing', () => {
    let seen: number | undefined
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const k = killsOf('win32', (_file, _args, options) => {
        seen = options.timeout
        return { status: null, stdout: '', error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
      })
      endSurvivors(100, 900, 2000, k.io)
      expect(seen, 'the query must carry the survivor query bound').toBe(SURVIVOR_QUERY_TIMEOUT_MS)
      expect(k.calls, 'a query that timed out selects nobody').toEqual([])
      expect(stderr.mock.calls.map((c) => String(c[0])).join(''), 'the failure must be named, not swallowed').toMatch(/could not list the survivors of pid 100: .*ETIMEDOUT/)
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('assertRan', () => {
  // HAND-DERIVED from the spawnSync return shape in the Node child_process docs: a timeout sets error (code ETIMEDOUT) with a null status and a signal, a kill sets only signal, a clean run sets status.
  const timedOut = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' })

  it('names the command and the timeout when the run reports ETIMEDOUT', () => {
    expect(() => assertRan({ error: timedOut, signal: 'SIGTERM', status: null }, ['semantic', 'q'])).toThrow(/token-goat semantic q timed out after 60000 ms/)
  })

  it('names the signal when the child was killed, even though allowFail would take any exit code', () => {
    expect(() => assertRan({ error: undefined, signal: 'SIGKILL', status: null }, ['answer', 'q'])).toThrow(/token-goat answer q was killed by SIGKILL/)
  })

  it('refuses a null status with no signal and a start failure, and lets any numeric exit code through', () => {
    expect(() => assertRan({ error: undefined, signal: null, status: null }, ['x'])).toThrow(/ended with no exit code/)
    expect(() => assertRan({ error: Object.assign(new Error('spawnSync nope ENOENT'), { code: 'ENOENT' }), signal: null, status: null }, ['x'])).toThrow(/could not run: spawnSync nope ENOENT/)
    for (const status of [0, 1, 2]) expect(() => assertRan({ error: undefined, signal: null, status }, ['x'])).not.toThrow()
  })
})

describe('pairWithBaseline', () => {
  const row = (id: string): { id: string } => ({ id })

  it('returns the current rows when both sides ask the same queries, accepting baseline ids that are absent-kind rows of the current split', () => {
    const now = [row('a'), row('b')]
    expect(pairWithBaseline('semantic', 'train', now, [...now, row('gap')], new Map([['a', 1], ['b', null], ['gap', null]]))).toEqual(now)
  })

  it('throws naming each current query the baseline lacks', () => {
    const all = [row('a'), row('b'), row('c')]
    expect(() => pairWithBaseline('semantic', 'test', all, all, new Map([['a', 1]]))).toThrow(/arm "semantic" split test does not pair.*2 queries of this run are missing from the baseline \(b, c\)/)
  })

  it('throws naming each baseline query this run did not ask', () => {
    expect(() => pairWithBaseline('semantic', 'train', [row('a')], [row('a')], new Map([['a', 1], ['old1', 2], ['old2', null]]))).toThrow(/2 baseline queries were not asked this run \(old1, old2\)/)
  })
})

describe('eval-retrieval --baseline', () => {
  const goldenIds = (): string[] => golden().trim().split('\n').map((l) => (JSON.parse(l) as { id: string }).id)
  const writeBaseline = (value: unknown): string => {
    const file = path.join(root, 'baseline.json')
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }

  it('compares against a baseline in the shape toBaseline writes and prints the paired delta its ranks give for both splits', () => {
    const rows = goldenIds().map((id) => ({ id, kind: 'doc', rank: 2 }))
    const file = writeBaseline(toBaseline({ semantic: rows }, 0))
    const r = runHarness({}, ['--baseline', file])
    expect(r.status, r.stderr).toBe(0)
    // HAND-DERIVED: the stand-in ranks the one answerable query of each split first (reciprocal rank 1) and the baseline recorded rank 2 (0.5), so each split's one paired query moves by exactly +0.500.
    expect(r.stdout).toMatch(/^delta semantic\s+train\s+MRR@10 \+0\.500 \[0\.500, 0\.500\]\s{2}improved$/m)
    expect(r.stdout).toMatch(/^delta semantic\s+test\s+MRR@10 \+0\.500 \[0\.500, 0\.500\]\s{2}improved$/m)
  }, 60_000)

  it('exits nonzero naming the id when the baseline lacks an answerable query, and when it ranks one the run never asked', () => {
    const answerable = golden().trim().split('\n').map((l) => JSON.parse(l) as { id: string; kind: string }).filter((g) => g.kind !== 'absent').map((g) => g.id)
    const allRows = goldenIds().map((id) => ({ id, kind: 'doc', rank: 2 }))
    const dropped = answerable[0]
    const lacking = runHarness({}, ['--baseline', writeBaseline(toBaseline({ semantic: allRows.filter((x) => x.id !== dropped) }, 0))])
    expect(lacking.status).not.toBe(0)
    expect(lacking.stderr).toContain(`missing from the baseline (${dropped})`)
    const extra = runHarness({}, ['--baseline', writeBaseline(toBaseline({ semantic: [...allRows, { id: 'zz-never-asked', kind: 'doc', rank: 1 }] }, 0))])
    expect(extra.status).not.toBe(0)
    expect(extra.stderr).toContain('baseline queries were not asked this run (zz-never-asked)')
  }, 60_000)

  it('exits 1 naming the arm when a baseline arm is neither a row list nor a rank map', () => {
    const r = runHarness({}, ['--baseline', writeBaseline({ schema: 1, distractors: 0, arms: { semantic: 'oops' } })])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('baseline arm "semantic" is neither a list of report rows nor a map of query id to rank')
  }, 60_000)
})

describe('baselineRanks', () => {
  const ids = ['id-a', 'id-b', 'id-c', 'id-d', 'id-e', 'id-f']

  it('keeps only the asked split from a list of report rows', () => {
    const rows = ids.map((id) => ({ id, split: splitOf(id), kind: 'doc', rank: 3 }))
    for (const split of ['train', 'test'] as const) {
      expect([...baselineRanks(rows, split, 'a').keys()]).toEqual(ids.filter((id) => splitOf(id) === split))
    }
  })

  it('keeps only the asked split from a rank map, deriving the split from the id', () => {
    const arm = Object.fromEntries(ids.map((id, i) => [id, i % 2 === 0 ? null : i]))
    for (const split of ['train', 'test'] as const) {
      const got = baselineRanks(arm, split, 'a')
      expect([...got.keys()]).toEqual(ids.filter((id) => splitOf(id) === split))
      for (const [id, rank] of got) expect(rank).toBe(arm[id])
    }
  })

  it('reads every arm of the committed baseline.json (CAPTURE: the file as committed)', () => {
    const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals', 'retrieval', 'baseline.json'), 'utf8')) as { arms: Record<string, Record<string, number | null>> }
    for (const [name, arm] of Object.entries(base.arms)) {
      const n = baselineRanks(arm, 'train', name).size + baselineRanks(arm, 'test', name).size
      expect(n, name).toBe(Object.keys(arm).length)
    }
  })

  it('throws on a row that is not a report row, a non-rank value, and a non-container', () => {
    expect(() => baselineRanks([{ id: 'x', rank: 1 }], 'train', 'a')).toThrow(/not a report row/)
    expect(() => baselineRanks({ x: '1' }, 'train', 'a')).toThrow(/not a rank/)
    expect(() => baselineRanks(7, 'train', 'a')).toThrow(/neither a list of report rows nor a map/)
    expect(() => baselineRanks(null, 'train', 'a')).toThrow(/neither a list of report rows nor a map/)
  })
})

describe('fixtureHits', () => {
  it('names every top-K file inside evals/retrieval and nothing outside it', () => {
    const rows = [
      { id: 'a', topFiles: ['src/x.ts', 'evals/retrieval/golden.jsonl'] },
      { id: 'b', topFiles: ['evals/retrieval.md', 'evals/other/golden.jsonl'] },
      { id: 'c', topFiles: ['evals/retrieval/answer.jsonl', 'evals/retrieval/labels.ts'] },
    ]
    expect(fixtureHits(rows)).toEqual(['a: evals/retrieval/golden.jsonl', 'c: evals/retrieval/answer.jsonl', 'c: evals/retrieval/labels.ts'])
  })
})

describe('parseConfiguredNumber', () => {
  it('returns the effective value config get printed', () => {
    expect(parseConfiguredNumber('{"key":"semantic.weak_distance","value":0.72,"source":"project"}\n', 'semantic.weak_distance')).toBe(0.72)
  })

  it('throws on another key, a non-number, or a non-finite value', () => {
    expect(() => parseConfiguredNumber('{"key":"semantic.max_distance","value":0.9}', 'semantic.weak_distance')).toThrow(/printed no number/)
    expect(() => parseConfiguredNumber('{"key":"semantic.weak_distance","value":"0.9"}', 'semantic.weak_distance')).toThrow(/printed no number/)
    expect(() => parseConfiguredNumber('{"key":"semantic.weak_distance","value":null}', 'semantic.weak_distance')).toThrow(/printed no number/)
  })
})
