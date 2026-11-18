/** A hook never breaks the host: the built native client and the Node shims, run as real child processes, answer a valid host answer with exit 0 whatever is missing or broken, and a deliberate block still blocks. Rows come from the safe-answer table the client carries and from the harnesses the installers wire (nativeWirings), never a hand list of hosts. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { GROK_HOOK_SCRIPT } from '../src/bridges/grok.js'
import { KIMI_HOOK_SCRIPT } from '../src/bridges/kimi.js'
import { shimFailOpen } from '../src/bridges/shim_fail_open.js'
import { nativeWirings } from '../src/cli_doctor_native.js'
import { dataDirForHome } from '../src/constants.js'
import { ADAPTER_HARNESSES, noopFor, type AdapterHarness } from '../src/hook_adapters.js'
import { hookBrokenPath, hookPointerPath, readHookBroken } from '../src/hook_pointer.js'
import { killProcessTree } from '../src/process_tree.js'
import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'
import { buildNative } from './helpers/native_bin.js'

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''
const SHIMS: Record<AdapterHarness, string> = { claudecode: CLAUDECODE_HOOK_SCRIPT, codex: CODEX_HOOK_SCRIPT, grok: GROK_HOOK_SCRIPT, kimi: KIMI_HOOK_SCRIPT, copilot_cli: COPILOT_CLI_HOOK_SCRIPT }
const TABLE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'native', 'tg-hook', 'safe_answers.json'), 'utf8')) as Record<string, { noop: string; events: Record<string, string> }>

/** The events each harness is run on: every event the safe-answer table singles out, plus one ordinary pre-tool event in the harness's own spelling. */
function eventsFor(harness: AdapterHarness): string[] {
  const ordinary = harness === 'copilot_cli' ? 'preToolUse' : 'pre_tool_use'
  return [...new Set([ordinary, ...Object.keys(TABLE[harness]?.events ?? {})])]
}

const ROWS = ADAPTER_HARNESSES.flatMap((harness) => eventsFor(harness).map((event) => ({ harness, event, safe: noopFor(harness, event) })))

let bin = ''
let base = ''
let dataDir = ''
let env: Record<string, string> = {}
const children: ChildProcess[] = []

beforeAll(() => {
  bin = buildNative()
})

afterEach(() => {
  for (const child of children.splice(0)) killProcessTree(child.pid)
  if (base !== '') fs.rmSync(base, { recursive: true, force: true })
  base = ''
})

/** A fresh sandbox per test: every redirect variable the repo's isolation sets points under one scratch directory. */
function sandbox(): string {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-open-')))
  dataDir = dataDirForHome(base)
  fs.mkdirSync(dataDir, { recursive: true })
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) clean[k] = v
  for (const k of HARNESS_DETECTION_ENV_KEYS) delete clean[k]
  const tmp = path.join(base, 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  env = {
    ...clean,
    HOME: base,
    USERPROFILE: base,
    LOCALAPPDATA: WIN ? path.dirname(path.dirname(dataDir)) : base,
    XDG_DATA_HOME: path.dirname(dataDir),
    APPDATA: path.join(base, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(base, '.config'),
    CLAUDE_CONFIG_DIR: path.join(base, '.claude'),
    CODEX_HOME: path.join(base, '.codex'),
    KIMI_CODE_HOME: path.join(base, '.kimi-code'),
    COPILOT_HOME: path.join(base, '.copilot'),
    TOKEN_GOAT_HOME: path.join(base, 'tg-home'),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    TOKEN_GOAT_HOOK_SERVER: '0',
  }
  return base
}

interface Run {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Runs a real child to its end with `input` on stdin; every child is tree-killed in afterEach, and the end is awaited on the child's own exit, never a sleep. */
function run(file: string, args: string[], input: string, overrides: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: base, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function write(rel: string, text: string): string {
  const p = path.join(base, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}

/** The client's command line: the harness, the event, then the wrapped Node command after `--`. */
function clientArgs(harness: string, event: string, entry: string, wrapped: string[]): string[] {
  return ['--harness', harness, '--event', event, '--entry', entry, '--script-dir', base, '--', ...wrapped]
}

function expectAnswer(res: Run, safe: string): void {
  expect(res.status, res.stderr).toBe(0)
  expect(res.signal).toBeNull()
  expect(res.stdout).toBe(safe)
  if (safe !== '') expect(() => JSON.parse(res.stdout) as unknown).not.toThrow()
}

function notice(): ReturnType<typeof readHookBroken> {
  return readHookBroken(dataDir)
}

function noticeText(): string {
  return JSON.stringify(notice()?.events ?? [])
}

/** A pointer file naming a bundle, a node and (optionally) a shim under `base`. */
function writePointer(over: Record<string, unknown> = {}, shim: string | null = null): string {
  const slash = (p: string): string => p.split(path.sep).join('/')
  const entry = path.join(base, 'bundle', 'token-goat.mjs')
  const pointer = {
    schema: 1,
    version: '9.9.9',
    bundleDir: slash(path.dirname(entry)),
    entry: slash(entry),
    node: slash(process.execPath),
    shim: shim === null ? null : slash(shim),
    nativeBin: slash(path.join(base, 'native', `tg-hook${EXE}`)),
    writtenAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
  const file = hookPointerPath(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(pointer))
  return file
}

describe('the rows are derived, not listed by hand', () => {
  it('cover every harness the installers wire and every harness in the safe-answer table', () => {
    const wired = new Set(nativeWirings().flatMap((w) => w.harnesses))
    for (const harness of ADAPTER_HARNESSES) expect(wired.has(harness), `${harness} is not wired by any installer scope`).toBe(true)
    expect(Object.keys(TABLE).sort()).toEqual([...ADAPTER_HARNESSES].sort())
    expect(ADAPTER_HARNESSES.length).toBeGreaterThanOrEqual(5)
    expect(ROWS.length).toBeGreaterThanOrEqual(ADAPTER_HARNESSES.length + 2)
  })
})

describe.each(ROWS)('native client, $harness $event', ({ harness, event, safe }) => {
  it('node missing from the command (cannot be started): the safe answer, exit 0, a notice naming it', async () => {
    sandbox()
    const missing = path.join(base, 'no-such-node')
    const res = await run(bin, clientArgs(harness, event, path.join(base, 'bundle', 'token-goat.mjs'), [missing, 'x', event]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('no-such-node')
  })

  it('entry file missing (node exits non-zero): the safe answer, exit 0, a notice naming the entry', async () => {
    sandbox()
    const entry = path.join(base, 'bundle', 'token-goat.mjs')
    const res = await run(bin, clientArgs(harness, event, entry, [process.execPath, entry, 'hook', event]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('token-goat.mjs')
  })

  it('bundle directory missing: the safe answer, exit 0', async () => {
    sandbox()
    const entry = path.join(base, 'gone-dir', 'dist', 'token-goat.mjs')
    const res = await run(bin, clientArgs(harness, event, entry, [process.execPath, path.join(base, 'gone-dir', 'shim.cjs'), event, entry]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('gone-dir')
  })

  it('the command prints garbage: the safe answer, exit 0, and the garbage never reaches the host', async () => {
    sandbox()
    const script = write('garbage.cjs', "process.stdout.write('this is not json at all')")
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expectAnswer(res, safe)
    expect(res.stdout).not.toContain('not json')
    expect(noticeText()).toContain('not JSON')
  })

  it('the command crashes with a non-zero code: the safe answer, exit 0', async () => {
    sandbox()
    const script = write('crash.cjs', "process.stdout.write('{}'); process.exit(3)")
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('exited 3')
  })

  it.skipIf(WIN)('the command dies of a signal: the safe answer, exit 0, never a signal death', async () => {
    sandbox()
    const script = write('signal.cjs', "process.kill(process.pid, 'SIGKILL')")
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('signal')
  })

  it('the command prints nothing: the safe answer, exit 0', async () => {
    sandbox()
    const script = write('silent.cjs', '')
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expectAnswer(res, safe)
  })

  it('no command at all after the separator: the safe answer, exit 0', async () => {
    sandbox()
    const res = await run(bin, ['--harness', harness, '--event', event, '--entry', 'x', '--'], '{}')
    expectAnswer(res, safe)
  })

  it('a healthy first route is relayed whole and clears an old notice', async () => {
    sandbox()
    fs.writeFileSync(hookBrokenPath(dataDir), JSON.stringify({ schema: 1, first: 'a', last: 'b', count: 1, events: [] }))
    const script = write('ok.cjs', 'process.stdout.write(\'{"relayed":true}\')')
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe('{"relayed":true}')
    expect(fs.existsSync(hookBrokenPath(dataDir))).toBe(false)
  })

  it('a deliberate block (exit 2 with a JSON answer) still blocks, exit 2 and the answer intact', async () => {
    sandbox()
    const deny = '{"decision":"block","reason":"deliberate"}'
    const script = write('block.cjs', `process.stdout.write(${JSON.stringify(deny)}); process.exitCode = 2`)
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}')
    expect(res.status, res.stderr).toBe(2)
    expect(res.stdout).toBe(deny)
  })

  it('a broken first route is repaired by the pointer: node, shim (or the entry directly), event, entry', async () => {
    sandbox()
    const hit = path.join(base, 'pointer-hit')
    const record = `writeFileSync(${JSON.stringify(hit)}, process.argv.slice(2).join(' ')); process.stdout.write('{"via":"pointer"}')`
    write('bundle/token-goat.mjs', `import { writeFileSync } from 'node:fs'\n${record}\n`)
    const shim = write('hooks/token-goat-shim.cjs', `const { writeFileSync } = require('node:fs')\n${record}\n`)
    writePointer({}, harness === 'claudecode' ? null : shim)
    const res = await run(bin, clientArgs(harness, event, path.join(base, 'old', 'token-goat.mjs'), [process.execPath, path.join(base, 'old', 'token-goat.mjs'), 'hook', event]), '{}')
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe('{"via":"pointer"}')
    expect(fs.readFileSync(hit, 'utf8')).toContain(event)
    expect(noticeText()).toContain('old')
  })

  it.each([
    ['missing', undefined],
    ['truncated', '{"schema":1,"version":"9.9.9","bundleDir":'],
    ['of another schema', JSON.stringify({ schema: 2 })],
    ['not an object', '[1,2,3]'],
  ])('a pointer that is %s: the safe answer, exit 0, a notice naming the pointer', async (_name, text) => {
    sandbox()
    if (text !== undefined) fs.writeFileSync(hookPointerPath(dataDir), text)
    const entry = path.join(base, 'old', 'token-goat.mjs')
    const res = await run(bin, clientArgs(harness, event, entry, [process.execPath, entry, 'hook', event]), '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('hook-entry.json')
  })

  it('a pointer naming files outside any bundle (UNC, parent references, wrong names): the safe answer, never a run of them', async () => {
    sandbox()
    const hit = path.join(base, 'must-not-run')
    write('evil/token-goat.mjs', `require('node:fs').writeFileSync(${JSON.stringify(hit)}, 'x'); process.stdout.write('{}')`)
    const bad = [
      { entry: '//evil-host/share/token-goat.mjs', bundleDir: '//evil-host/share' },
      { entry: `${base.split(path.sep).join('/')}/evil/../evil/token-goat.mjs`, bundleDir: `${base.split(path.sep).join('/')}/evil/../evil` },
      { entry: `${base.split(path.sep).join('/')}/evil/other.mjs`, bundleDir: `${base.split(path.sep).join('/')}/evil` },
      { entry: 'relative/token-goat.mjs', bundleDir: 'relative' },
    ]
    for (const over of bad) {
      writePointer(over)
      const entry = path.join(base, 'old', 'token-goat.mjs')
      const res = await run(bin, clientArgs(harness, event, entry, [process.execPath, entry, 'hook', event]), '{}')
      expectAnswer(res, safe)
    }
    expect(fs.existsSync(hit)).toBe(false)
  })

  it('a worker that is absent changes nothing: with no server at all the wrapped Node command still answers', async () => {
    sandbox()
    const script = write('answer.cjs', 'process.stdout.write(\'{"node":"answered"}\')')
    const res = await run(bin, clientArgs(harness, event, script, [process.execPath, script]), '{}', { TOKEN_GOAT_HOOK_SERVER: '1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe('{"node":"answered"}')
  })

  it('an internal panic answers the safe no-op with exit 0, never an abort', async () => {
    sandbox()
    const res = await run(bin, ['--selftest-panic', harness, event], '{}')
    expectAnswer(res, safe)
    expect(noticeText()).toContain('panic')
  })
})

describe('Grok pre_tool_use, the one event whose safe answer is allow', () => {
  it('is allow when every route fails, and a Grok block still blocks', async () => {
    sandbox()
    const failed = await run(bin, clientArgs('grok', 'pre_tool_use', 'x', [path.join(base, 'no-such-node')]), '{}')
    expectAnswer(failed, '{"decision":"allow"}')
    const deny = '{"decision":"block","reason":"deliberate"}'
    const script = write('grok-block.cjs', `process.stdout.write(${JSON.stringify(deny)}); process.exitCode = 2`)
    const blocked = await run(bin, clientArgs('grok', 'pre_tool_use', script, [process.execPath, script]), '{}')
    expect(blocked.status).toBe(2)
    expect(blocked.stdout).toBe(deny)
  })
})

describe('the Node shims', () => {
  /** A bundle entry that records it ran and prints an answer; the shim finds it through the pointer when the baked path is gone. */
  function fakeEntry(): { entry: string; hit: string } {
    const hit = path.join(base, 'entry-ran')
    const entry = write('bundle/token-goat.mjs', `import * as fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(hit)}, 'x')\nprocess.stdout.write('{}')\n`)
    return { entry, hit }
  }

  describe.each(ADAPTER_HARNESSES)('%s shim', (harness) => {
    const event = harness === 'copilot_cli' ? 'preToolUse' : 'pre_tool_use'

    it('a baked entry that is gone and no pointer: the safe answer, exit 0', async () => {
      sandbox()
      const shim = write('hooks/token-goat-shim.cjs', SHIMS[harness])
      const res = await run(process.execPath, [shim, event, path.join(base, 'old', 'token-goat.mjs')], '{}')
      expectAnswer(res, noopFor(harness, event))
    })

    it('a baked entry that is gone but a pointer names the live bundle: the live entry runs', async () => {
      sandbox()
      const { hit } = fakeEntry()
      writePointer()
      const shim = write('hooks/token-goat-shim.cjs', SHIMS[harness])
      fs.copyFileSync(hookPointerPath(dataDir), path.join(path.dirname(shim), 'hook-entry.json'))
      const res = await run(process.execPath, [shim, event, path.join(base, 'old', 'token-goat.mjs')], '{}')
      expect(res.status, res.stderr).toBe(0)
      expect(fs.existsSync(hit), `the pointer's entry never ran; stdout ${res.stdout}`).toBe(true)
    })

    it('a pointer outside the allowed shapes is not followed', async () => {
      sandbox()
      const { hit } = fakeEntry()
      writePointer({ entry: '//evil-host/share/token-goat.mjs', bundleDir: '//evil-host/share' })
      const shim = write('hooks/token-goat-shim.cjs', SHIMS[harness])
      fs.copyFileSync(hookPointerPath(dataDir), path.join(path.dirname(shim), 'hook-entry.json'))
      const res = await run(process.execPath, [shim, event, path.join(base, 'old', 'token-goat.mjs')], '{}')
      expectAnswer(res, noopFor(harness, event))
      expect(fs.existsSync(hit)).toBe(false)
    })

    it('a truncated pointer is ignored: the safe answer, exit 0', async () => {
      sandbox()
      fs.writeFileSync(hookPointerPath(dataDir), '{"schema":1,"entry":')
      const shim = write('hooks/token-goat-shim.cjs', SHIMS[harness])
      fs.copyFileSync(hookPointerPath(dataDir), path.join(path.dirname(shim), 'hook-entry.json'))
      const res = await run(process.execPath, [shim, event, path.join(base, 'old', 'token-goat.mjs')], '{}')
      expectAnswer(res, noopFor(harness, event))
    })
  })

  describe.each(ADAPTER_HARNESSES)('%s shim fail-open handlers', (harness) => {
    const event = harness === 'copilot_cli' ? 'agentStop' : 'pre_tool_use'
    const safe = noopFor(harness, event)
    const expr = harness === 'grok' ? "(process.argv[2] === 'pre_tool_use' ? '{\"decision\":\"allow\"}' : '{}')" : harness === 'kimi' ? "''" : harness === 'copilot_cli' ? '(process.argv[2] === \'agentStop\' ? \'{"decision":"allow"}\' : \'{}\')' : "'{}'"

    it.each([
      ['an uncaught exception', 'setTimeout(() => { throw new Error("boom") }, 0)'],
      ['an unhandled rejection', 'Promise.reject(new Error("boom"))'],
    ])('%s becomes the safe answer and exit 0', async (_name, trigger) => {
      sandbox()
      const script = write('fail.cjs', `${shimFailOpen(expr)}\n${trigger}\n`)
      const res = await run(process.execPath, [script, event], '')
      expectAnswer(res, safe)
    })

    it('adds nothing once an answer is already out', async () => {
      sandbox()
      const script = write('late.cjs', `${shimFailOpen(expr)}\nprocess.stdout.write('{"first":1}', () => { throw new Error("late") })\n`)
      const res = await run(process.execPath, [script, event], '')
      expect(res.status, res.stderr).toBe(0)
      expect(res.stdout).toBe('{"first":1}')
    })
  })
})
