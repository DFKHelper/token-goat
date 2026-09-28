/** Holds the harness adapters in src/hook_adapters.ts and the per-harness Node shims (src/bridges/{claudecode,codex,grok,kimi,copilot_cli}.ts) to one behaviour. Every harness is installed into a sandbox by the BUILT bundle, and every event its installer wires is driven two ways with the same payload: (a) the installed shim, run exactly as the harness config names it (`node <shim> <event> <entry>`, payload on stdin), and (b) a harness-aware (v2) request to a real `hook-server run` process from the same bundle, through the verifying client in tests/helpers/hook_v2_client.ts, and (c) the built native client (native/tg-hook) run with the flags an installer puts in front of that Node command. All three must print the same bytes and exit with the same code, a v2 response must send the async-detach line as an early frame exactly when the shim prints it first, and every native call must be served by the server, which its per-slot served counter shows: a client that computed the wrong endpoint would fall back to the same Node command and print the same bytes. Payloads come from tests/fixtures/harness_hook_payloads.ts, each with its provenance. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dataDirForHome } from '../src/constants.js'
import { endpointFor, mac, macMatches, nonce, PROTOCOL_VERSION, readFrames, readServerKey, writeFrame, type HarnessHookRequest, type ServerStatus } from '../src/hook_ipc.js'
import { serializeOutput } from '../src/hook_registry.js'
import { nativeHookExecParts, nativeHookFlags } from '../src/native_hook.js'
import { HOOK_EVENTS, type HookOutput } from '../src/types.js'
import { HARNESS_HOOK_PAYLOADS, type HookPayloadCase, type PayloadHarness } from './fixtures/harness_hook_payloads.js'
import { BUNDLE } from './helpers/bundle.js'
import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'
import { slotStatus, waitIdle } from './helpers/hook_server_probe.js'
import { callV2, verifyResponseFrames, type Frame, type V2Served } from './helpers/hook_v2_client.js'
import { buildNative } from './helpers/native_bin.js'

type Env = Record<string, string>

const HARNESSES: readonly PayloadHarness[] = ['claudecode', 'codex', 'grok', 'kimi', 'copilot_cli']
const INSTALL_FLAG: Record<PayloadHarness, string[]> = { claudecode: [], codex: ['--codex'], grok: ['--grok'], kimi: ['--kimi'], copilot_cli: ['--copilot'] }
/** Where each installer writes its hook config under the sandbox home (with CLAUDE_CONFIG_DIR, CODEX_HOME, KIMI_CODE_HOME and COPILOT_HOME pointed inside it). */
const CONFIG_FILE: Record<PayloadHarness, string> = {
  claudecode: path.join('.claude', 'settings.json'),
  codex: path.join('.codex', 'config.toml'),
  grok: path.join('.grok', 'hooks', 'token-goat.json'),
  kimi: path.join('.kimi-code', 'config.toml'),
  copilot_cli: path.join('.copilot', 'hooks', 'token-goat.json'),
}
/** Events each harness's shim is run with that no installer wires, driven on purpose to pin the unknown-event answer. */
const UNWIRED_ON_PURPOSE: Record<PayloadHarness, string> = { claudecode: 'bogus_event', codex: 'bogus_event', grok: 'session_start', kimi: 'bogus_event', copilot_cli: 'notAnEvent' }
const ASYNC_LINE = '{"async":true}\n'

interface Wiring {
  shim: string
  entry: string
}

interface Sandbox {
  base: string
  proj: string
  dataDir: string
  env: Env
  wired: Record<PayloadHarness, Map<string, Wiring>>
  server?: ChildProcess
  pids: Set<number>
}

let sb: Sandbox

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sandboxEnv(base: string, dataDir: string): Env {
  const env: Env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
  const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
  return {
    ...env,
    HOME: base,
    USERPROFILE: base,
    CLAUDE_CONFIG_DIR: path.join(base, '.claude'),
    CODEX_HOME: path.join(base, '.codex'),
    KIMI_CODE_HOME: path.join(base, '.kimi-code'),
    COPILOT_HOME: path.join(base, '.copilot'),
    LOCALAPPDATA: envRoot,
    XDG_DATA_HOME: envRoot,
    APPDATA: path.join(base, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(base, '.config'),
    TOKEN_GOAT_HOME: path.join(base, 'tg-home'),
    TOKEN_GOAT_HOOK_SERVER: '0',
  }
}

function cli(args: string[], env: Env = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: sb.base, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Every string in a parsed JSON config, and each `args` array whole, since Claude Code's entries name the shim, event and entry as three separate arguments. */
function commandLines(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) out.push(value.map((v) => `"${String(v)}"`).join(' '))
    for (const v of value) commandLines(v, out)
  } else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) commandLines(v, out)
  return out
}

/** The (event, shim, entry) triples a harness config runs. FORMAT-DERIVED from the configs these installers write: a quoted shim path, the event, then the quoted entry. TOML basic strings share JSON's escapes, so one decode serves both. */
function wiredEvents(harness: PayloadHarness): Map<string, Wiring> {
  const file = path.join(sb.base, CONFIG_FILE[harness])
  const text = fs.readFileSync(file, 'utf8')
  const lines = file.endsWith('.json') ? commandLines(JSON.parse(text)) : [...text.matchAll(/^command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/gm)].map((m) => JSON.parse(m[1] as string) as string)
  const found = new Map<string, Wiring>()
  const re = /["']([^"']*token-goat-shim\.cjs)["']\s+"?([A-Za-z_]+)"?\s+["']([^"']+)["']/
  for (const line of lines) {
    const m = re.exec(line)
    if (m) found.set(m[2] as string, { shim: m[1] as string, entry: m[3] as string })
  }
  return found
}

async function startServer(): Promise<Buffer> {
  const child = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], { cwd: sb.base, env: { ...sb.env, TOKEN_GOAT_HOOK_SERVER: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
  sb.server = child
  if (child.pid !== undefined) sb.pids.add(child.pid)
  const deadline = Date.now() + 30_000
  for (;;) {
    const res = cli(['hook-server', 'status', '--json'], { TOKEN_GOAT_HOOK_SERVER: '1' })
    const list = res.status === 0 ? (JSON.parse(res.stdout) as ServerStatus[]) : []
    const key = readServerKey(sb.dataDir)
    if (list.some((s) => s.slot === 0) && key !== undefined) return key
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`hook server did not start: ${stderr}`)
    await sleep(100)
  }
}

let key: Buffer
let endpoint: string
let bin = ''

beforeAll(async () => {
  bin = buildNative()
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-v2eq-')))
  const dataDir = dataDirForHome(base)
  const proj = path.join(base, 'proj')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  // HAND-DERIVED project files the payloads name: a markdown file and two TypeScript sources.
  fs.writeFileSync(path.join(proj, 'notes.md'), '# Title\n\nintro\n\n## Alpha\n\nalpha body\n')
  fs.writeFileSync(path.join(proj, 'src', 'index.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(proj, 'src', 'app.ts'), 'export function app(): number {\n  return 1\n}\n')
  sb = { base, proj, dataDir, env: sandboxEnv(base, dataDir), wired: {} as Sandbox['wired'], pids: new Set() }
  for (const h of HARNESSES) {
    const res = cli(['install', ...INSTALL_FLAG[h]])
    expect(res.status, `install ${h}: ${res.stderr}`).toBe(0)
    if (h === 'copilot_cli') {
      // VS Code shares this hooks file at user scope, and while it owns the file the installer adds the keys only VS Code reads (SubagentStart), which the VS Code payload cases drive.
      const vs = cli(['install', '--vscode', '--user'])
      expect(vs.status, `install --vscode --user: ${vs.stderr}`).toBe(0)
    }
    sb.wired[h] = wiredEvents(h)
  }
  key = await startServer()
  endpoint = endpointFor(0, dataDir, fs.realpathSync.native(path.dirname(BUNDLE)))
}, 900_000)

afterAll(async () => {
  try {
    cli(['hook-server', 'stop'], { TOKEN_GOAT_HOOK_SERVER: '1' })
  } catch {
    // the stop by pid below still runs
  }
  const deadline = Date.now() + 5000
  for (const pid of sb.pids) {
    while (pidAlive(pid) && Date.now() < deadline) await sleep(50)
    if (pidAlive(pid)) process.kill(pid)
  }
  fs.rmSync(sb.base, { recursive: true, force: true })
}, 30_000)

function substitute(text: string, sid: string): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1)
  return text.replaceAll('{{PROJ}}', () => esc(sb.proj)).replaceAll('{{SID}}', () => esc(sid))
}

function caseInput(c: HookPayloadCase, sid: string): string {
  return substitute(c.raw ?? JSON.stringify(c.payload), sid)
}

function caseEnv(c: HookPayloadCase, sid: string): Env {
  const env: Env = { ...sb.env }
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = substitute(v, sid)
  return env
}

/** The installed wiring for the case's event, or for an event no installer wires, the shim that harness installs with its usual entry. */
function wiringFor(c: HookPayloadCase): Wiring {
  const w = sb.wired[c.harness]
  const direct = w.get(c.event)
  if (direct !== undefined) return direct
  const any = w.values().next().value as Wiring
  return any
}

function runShim(c: HookPayloadCase, sid: string): Promise<{ stdout: string; exit: number | null; stderr: string }> {
  const { shim, entry } = wiringFor(c)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shim, c.event, entry], { cwd: sb.proj, env: caseEnv(c, sid), stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (exit) => resolve({ stdout: Buffer.concat(out).toString('utf8'), exit, stderr }))
    child.stdin.end(caseInput(c, sid))
  })
}

async function runV2(c: HookPayloadCase, sid: string): Promise<{ out: string[]; stdout: string; exit: number }> {
  const { shim } = wiringFor(c)
  const outcome = await callV2(endpoint, key, c.harness, { event: c.event, input: caseInput(c, sid), env: caseEnv(c, sid), cwd: sb.proj, elapsedMs: 0, scriptDir: path.dirname(shim) })
  if (outcome.kind !== 'served') throw new Error(`v2 request not served: ${JSON.stringify(outcome)}`)
  return outcome
}

/** A command after `--` that must never run: the served path leaves it alone, so reaching it means the native client fell back. */
const TRIPWIRE = [process.execPath, '-e', 'process.stdout.write("TRIPWIRE");process.exit(99)']

/** The native client's argv for the case, built by the installers' own builders in src/native_hook.ts from the same wiring the shim runs with: `wired` is the whole command line an installer writes (nativeHookExecParts), `tripwire` the same flags (nativeHookFlags) in front of {@link TRIPWIRE}. */
function nativeArgs(c: HookPayloadCase, tail: 'wired' | 'tripwire'): string[] {
  const { shim, entry } = wiringFor(c)
  if (tail === 'tripwire') return [...nativeHookFlags(c.harness, c.event, entry, shim), '--', ...TRIPWIRE]
  const parts = nativeHookExecParts(bin, c.harness, shim, c.event, entry)
  if (parts === undefined) throw new Error('nativeHookExecParts returned nothing')
  return parts.args
}

function runNative(c: HookPayloadCase, sid: string, args: readonly string[]): Promise<{ stdout: string; exit: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // sb.env turns the server off for the cold shim runs; the native client honours that switch as the Node client does, so it is turned back on here.
    const child = spawn(bin, args, { cwd: sb.proj, env: { ...caseEnv(c, sid), TOKEN_GOAT_HOOK_SERVER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (exit) => resolve({ stdout: Buffer.concat(out).toString('utf8'), exit, stderr }))
    child.stdin.end(caseInput(c, sid))
  })
}

/** Where the shim's stderr and the native client's differ, by case, which the last test in the suite requires to be none. */
const stderrDiffs: Array<{ id: string; shim: string; native: string }> = []

/** What the shim itself must answer for the cases that carry each adapter's distinctive behaviour, so the equality above cannot pass by both sides collapsing to the same no-op. HAND-DERIVED from each shim's documented contract (the comments in src/bridges/*.ts), not from either run's output. */
const ANCHORS: Record<string, { stdout: string | RegExp; exit?: number }> = {
  'claudecode|Bash command token-goat redirects (block)': { stdout: /^\{"decision":"block","reason":"\[tg\] / },
  'claudecode|own token-goat command (bypass)': { stdout: '{}', exit: 0 },
  'claudecode|Write of a .ts file (async detach)': { stdout: /^\{"async":true\}\n/ },
  'claudecode|Write of a .md file (no detach)': { stdout: /^(?!\{"async":true\})/ },
  'claudecode|short Bash result (async detach)': { stdout: /^\{"async":true\}\n/ },
  'claudecode|long Bash result (no detach)': { stdout: /^(?!\{"async":true\})/ },
  'claudecode|subagent finished (async detach)': { stdout: /^\{"async":true\}\n/ },
  'claudecode|unknown event': { stdout: '{}', exit: 0 },
  'claudecode|payload behind a byte order mark': { stdout: /^\{"decision":"block"/ },
  'codex|Bash command token-goat redirects (block)': { stdout: /^\{"decision":"block"/ },
  'grok|run_terminal_command': { stdout: '{"decision":"allow"}', exit: 0 },
  'grok|run_terminal_command token-goat redirects (deny, exit 2)': { stdout: /^\{"decision":"deny","reason":"\[tg\] /, exit: 2 },
  'grok|session_start, an event Grok\'s shim does not accept': { stdout: '{}', exit: 0 },
  'kimi|Bash command token-goat redirects (deny)': { stdout: /"permissionDecision":"deny"/ },
  'kimi|unknown event': { stdout: '', exit: 0 },
  'copilot_cli|bash command token-goat redirects (deny)': { stdout: /^\{"permissionDecision":"deny"/ },
  'copilot_cli|powershell, remapped to Bash': { stdout: /^\{"permissionDecision":"deny"/ },
  'copilot_cli|bash deny with toolArgs as a JSON string': { stdout: /^\{"permissionDecision":"deny"/ },
  'copilot_cli|the same bash failure twice (repeat notice)': { stdout: /^\{"additionalContext":"\[token-goat\] Bash just failed with the same error/ },
  'copilot_cli|edit failure (old_str not found)': { stdout: /^\{"additionalContext":"\[token-goat\] Edit failed: string not found in notes\.md/ },
  'copilot_cli|view, remapped to Read with path to file_path': { stdout: /notes\.md::/ },
  'copilot_cli|agent stop': { stdout: '{"decision":"allow"}' },
  'copilot_cli|subagent stop with a long report': { stdout: /^\{"modifiedResponse":"Here is what I found\.\\n```\\ngate output line 0/ },
  'copilot_cli|subagent start': { stdout: /^\{"additionalContext":"## Session briefing/ },
  'copilot_cli|VS Code SubagentStart through the Copilot hooks file': { stdout: /^\{"hookSpecificOutput":\{"hookEventName":"SubagentStart","additionalContext":"## Session briefing/ },
  'copilot_cli|VS Code read_file through the Copilot hooks file': { stdout: /^\{"hookSpecificOutput":\{"hookEventName":"PreToolUse"/ },
}

describe('installed wiring', () => {
  it('every event each installer wires has at least one payload, and every payload event is wired or a deliberate unknown', () => {
    for (const h of HARNESSES) {
      const wired = [...sb.wired[h].keys()].sort()
      expect(wired.length, `${h} wires no events`).toBeGreaterThan(0)
      const covered = new Set(HARNESS_HOOK_PAYLOADS.filter((c) => c.harness === h).map((c) => c.event))
      for (const event of wired) expect(covered.has(event), `${h} ${event} has no payload`).toBe(true)
      for (const event of covered) expect(sb.wired[h].has(event) || event === UNWIRED_ON_PURPOSE[h], `${h} payload event ${event} is neither wired nor the deliberate unknown`).toBe(true)
    }
  })

  it('every payload names its provenance', () => {
    for (const c of HARNESS_HOOK_PAYLOADS) expect(c.provenance, `${c.harness} ${c.name}`).toMatch(/^(CAPTURE|FORMAT-DERIVED|HAND-DERIVED)\b/)
  })
})

describe('a v2 request answers exactly as the installed shim', () => {
  let n = 0
  for (const c of HARNESS_HOOK_PAYLOADS) {
    const id = n++
    it(`${c.harness} ${c.event}: ${c.name}`, async () => {
      // Each run gets its own session, so neither sees what the other left in session state (a repeated denial answers with a shorter refusal).
      let shim = { stdout: '', exit: null as number | null, stderr: '' }
      for (let call = 1; call <= (c.repeat ?? 1); call++) {
        shim = await runShim(c, `ref-${c.harness}-${id}`)
        await waitIdle(endpoint)
        const v2 = await runV2(c, `v2-${c.harness}-${id}`)
        expect({ call, stdout: v2.out.join('') + v2.stdout, exit: v2.exit }, shim.stderr).toEqual({ call, stdout: shim.stdout, exit: shim.exit })
        expect(v2.out).toEqual(shim.stdout.startsWith(ASYNC_LINE) ? [ASYNC_LINE] : [])
        // Behind the tripwire a fallback cannot pass for a served call; behind the wired Node command is the exact command line an installer writes.
        for (const label of ['tripwire', 'wired'] as const) {
          // A server finishes a request's after-reply work once the caller has its answer, and a caller arriving meanwhile is told busy.
          await waitIdle(endpoint)
          const before = (await slotStatus(endpoint, key))?.served
          const native = await runNative(c, `nat-${label}-${c.harness}-${id}`, nativeArgs(c, label))
          await waitIdle(endpoint)
          const after = (await slotStatus(endpoint, key))?.served
          expect({ label, call, stdout: native.stdout, exit: native.exit }, native.stderr).toEqual({ label, call, stdout: shim.stdout, exit: shim.exit })
          expect(after, `${label}: the native call was not served`).toBe((before ?? NaN) + 1)
          if (native.stderr !== shim.stderr) stderrDiffs.push({ id: `${c.harness}|${c.name}|${label}|${call}`, shim: shim.stderr, native: native.stderr })
        }
      }
      const anchor = ANCHORS[`${c.harness}|${c.name}`]
      if (anchor !== undefined) {
        if (typeof anchor.stdout === 'string') expect(shim.stdout).toBe(anchor.stdout)
        else expect(shim.stdout).toMatch(anchor.stdout)
        if (anchor.exit !== undefined) expect(shim.exit).toBe(anchor.exit)
      }
    }, 60_000)
  }

  it('every anchor names a payload that exists', () => {
    const names = new Set(HARNESS_HOOK_PAYLOADS.map((c) => `${c.harness}|${c.name}`))
    for (const k of Object.keys(ANCHORS)) expect(names.has(k), k).toBe(true)
  })

  // Neither client relays a handler's stderr from the server, and no case differs today, so a difference is a regression rather than a known divergence to list.
  it('the native client writes the same stderr as the shim for every case', () => {
    expect(stderrDiffs).toEqual([])
  })
})

function fixture(harness: PayloadHarness, name: string, sid: string): string {
  const c = HARNESS_HOOK_PAYLOADS.find((p) => p.harness === harness && p.name === name)
  if (c === undefined) throw new Error(`no ${harness} fixture named ${name}`)
  return caseInput(c, sid)
}

/** A Claude Code post_tool_use the shim detaches from (short Bash output), so its response carries one `out` frame before `done`. */
const detachingInput = (sid: string): string => fixture('claudecode', 'short Bash result (async detach)', sid)
const grokDenyInput = (sid: string): string => fixture('grok', 'run_terminal_command token-goat redirects (deny, exit 2)', sid)

function v2Request(harness: PayloadHarness, event: string, input: string): Omit<HarnessHookRequest, 'kind' | 'harness'> {
  return { event, input, env: { ...sb.env, ...(harness === 'grok' ? { GROK_SESSION_ID: 'v2-proto' } : {}) }, cwd: sb.proj, elapsedMs: 0 }
}

async function served(harness: PayloadHarness, request: Omit<HarnessHookRequest, 'kind' | 'harness'>): Promise<V2Served> {
  const outcome = await callV2(endpoint, key, harness, request)
  if (outcome.kind !== 'served') throw new Error(`not served: ${JSON.stringify(outcome)}`)
  return outcome
}

describe('codex hookEventName', () => {
  it('every hookSpecificOutput the relay can serialize for Codex already names its event, so the adapter adds none', () => {
    // The Codex shim fills a missing hookSpecificOutput.hookEventName; src/hook_adapters.ts does not, because a Codex relay answers either '{}' or serializeOutput's JSON. HAND-DERIVED: every HookOutput variant the type admits, on every event.
    const outputs: HookOutput[] = [
      { hookType: 'deny', message: 'no' },
      { hookType: 'context', context: 'hint' },
      { hookType: 'rewriteInput', updatedInput: { command: 'ls' } },
      { hookType: 'rewriteOutput', updatedOutput: 'out' },
      { hookType: 'rewriteOutput', updatedOutput: 'out', updatedBlocks: [{ type: 'text', text: 'out' }] },
      { hookType: 'pass' },
    ]
    let withHso = 0
    for (const event of HOOK_EVENTS) {
      for (const output of outputs) {
        const parsed: unknown = JSON.parse(serializeOutput(output, event, 'codex'))
        const hso = (parsed as Record<string, unknown>)['hookSpecificOutput']
        if (hso === undefined) continue
        withHso++
        const name = (hso as Record<string, unknown>)['hookEventName']
        expect(typeof name === 'string' && name !== '', `${event} ${output.hookType}`).toBe(true)
      }
    }
    expect(withHso).toBeGreaterThan(HOOK_EVENTS.length)
  })
})

describe('v2 frames', () => {
  it('an early out frame and the done frame carry MACs the client verifies, and done counts the out frames', async () => {
    const res = await served('claudecode', v2Request('claudecode', 'post_tool_use', detachingInput('proto-frames')))
    expect(res.frames.map((f) => f['t'])).toEqual(['out', 'done'])
    expect(res.frames[0]).toEqual({ t: 'out', seq: 0, data: ASYNC_LINE, mac: expect.any(String) })
    expect(res.frames[1]).toEqual({ t: 'done', stdout: res.stdout, exit: 0, n: 1, mac: expect.any(String) })
    expect(verifyResponseFrames(key, res.nc, res.ns, res.frames)).toEqual({ out: [ASYNC_LINE], stdout: res.stdout, exit: 0 })
  })

  it('the verifying client rejects frames reordered, replayed, dropped, altered or lifted from another response', async () => {
    const a = await served('claudecode', v2Request('claudecode', 'post_tool_use', detachingInput('proto-a')))
    const b = await served('claudecode', v2Request('claudecode', 'post_tool_use', detachingInput('proto-b')))
    const [out, done] = a.frames as [Frame, Frame]
    const verify = (frames: Frame[]): unknown => verifyResponseFrames(key, a.nc, a.ns, frames)
    expect(() => verify([done, out])).toThrow(/counts 1 out frames, 0 arrived/)
    expect(() => verify([out, out, done])).toThrow(/seq 0 where 1 was due/)
    expect(() => verify([done])).toThrow(/counts 1 out frames, 0 arrived/)
    expect(() => verify([out])).toThrow(/no done frame/)
    expect(() => verify([out, done, done])).toThrow(/frames after done/)
    expect(() => verify([{ ...out, data: '{}\n' }, done])).toThrow(/out frame 0 MAC mismatch/)
    expect(() => verify([out, { ...done, exit: 2 }])).toThrow(/done frame MAC mismatch/)
    expect(() => verify([out, { ...done, stdout: '{"decision":"block"}' }])).toThrow(/done frame MAC mismatch/)
    // The same frames from another connection are signed over that connection's nonces.
    expect(() => verify(b.frames)).toThrow(/MAC mismatch/)
  })

  it("Grok's deny arrives as done with exit 2 under a verified MAC", async () => {
    const res = await served('grok', v2Request('grok', 'pre_tool_use', grokDenyInput('proto-grok')))
    expect(res.out).toEqual([])
    expect(res.exit).toBe(2)
    expect(res.stdout).toMatch(/^\{"decision":"deny"/)
  })
})

describe('v2 handshake', () => {
  it('a harness this build has no adapter for is refused before the challenge, which the client takes as fall back', async () => {
    expect(await callV2(endpoint, key, 'nosuch', v2Request('claudecode', 'pre_tool_use', '{}'))).toEqual({ kind: 'refused', reason: 'unknown harness' })
  })

  it('the challenge carries the no-op outputs of the harness it names, under the MAC the client verified', async () => {
    const grok = await served('grok', v2Request('grok', 'bogus_event', '{}'))
    // HAND-DERIVED from GROK_HOOK_SCRIPT (src/bridges/grok.ts): '{}' for an event it does not take, and an explicit allow when a pre_tool_use relay is lost.
    expect(grok.noop).toBe('{}')
    expect(grok.noops).toContainEqual(['pre_tool_use', '{"decision":"allow"}'])
    expect(grok.stdout).toBe(grok.noop)
    // KIMI_HOOK_SCRIPT prints nothing at all for an event it does not take.
    const kimi = await served('kimi', v2Request('kimi', 'bogus_event', '{}'))
    expect(kimi.noop).toBe('')
    expect(kimi.stdout).toBe('')
  })

  it('a request whose harness field was altered after signing is dropped without an answer', async () => {
    const tampered = await callV2(endpoint, key, 'grok', v2Request('grok', 'pre_tool_use', grokDenyInput('proto-tamper')), { tamperBody: (body) => body.replace('"harness":"grok"', '"harness":"codex"') })
    expect(tampered).toEqual({ kind: 'closed', frames: [] })
  })

  it('a request signed for another harness than its hello named is dropped', async () => {
    const res = await callV2(endpoint, key, 'grok', v2Request('grok', 'pre_tool_use', grokDenyInput('proto-mac')), { macHarness: 'codex' })
    expect(res).toEqual({ kind: 'closed', frames: [] })
  })

  it('a correctly signed request naming another harness than its hello is dropped', async () => {
    const res = await callV2(endpoint, key, 'codex', v2Request('codex', 'pre_tool_use', grokDenyInput('proto-mismatch')), { helloHarness: 'grok' })
    expect(res).toEqual({ kind: 'closed', frames: [] })
  })

  it('the server still answers after each dropped request', async () => {
    const res = await served('grok', v2Request('grok', 'pre_tool_use', grokDenyInput('proto-after')))
    expect(res.exit).toBe(2)
  })
})

describe('v1 clients', () => {
  it('a v1 hello still gets the v1 challenge, with nothing v2 added to it', async () => {
    const socket = net.connect(endpoint)
    const nc = nonce()
    const challenge = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc }))
      readFrames(socket, resolve, reject)
    })
    socket.destroy()
    expect(Object.keys(challenge).sort()).toEqual(['mac', 'ns', 't', 'v'])
    expect(challenge['v']).toBe(PROTOCOL_VERSION)
    expect(macMatches(mac(key, 'S', nc, String(challenge['ns'])), challenge['mac'])).toBe(true)
  })

  it('the shipped v1 client relays through the server and gets the same bytes as a cold hook run', () => {
    const driver = path.join(sb.base, 'relay-driver.mjs')
    fs.writeFileSync(
      driver,
      [
        "import { readFileSync } from 'node:fs'",
        "import { pathToFileURL } from 'node:url'",
        'const [clientPath, event] = process.argv.slice(2)',
        'const { relayViaServer } = await import(pathToFileURL(clientPath).href)',
        "const out = await relayViaServer(event, readFileSync(0, 'utf8'))",
        'process.stdout.write(JSON.stringify({ out: out ?? null }))',
        '',
      ].join('\n'),
    )
    // HAND-DERIVED payload, the redirect the harness cases above use (tests/hook_server.test.ts bashDenyPayload); each run has its own session, since a repeat in one session gets a shorter refusal.
    const payload = (sid: string): string => JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'find . -name "*.ts" | xargs grep -l TokenGoat' }, session_id: sid })
    const client = path.join(path.dirname(BUNDLE), 'token-goat-hook-client.mjs')
    const relayed = spawnSync(process.execPath, [driver, client, 'pre_tool_use'], { cwd: sb.proj, env: { ...sb.env, TOKEN_GOAT_HOOK_SERVER: '1' }, input: payload('v1-relay'), encoding: 'utf8', timeout: 60_000 })
    expect(relayed.status, relayed.stderr).toBe(0)
    const cold = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: sb.proj, env: sb.env, input: payload('v1-cold'), encoding: 'utf8', timeout: 60_000 })
    expect(cold.status, cold.stderr).toBe(0)
    expect(cold.stdout).toMatch(/^\{"decision":"block"/)
    expect((JSON.parse(relayed.stdout) as { out: string | null }).out).toBe(cold.stdout)
  })
})
