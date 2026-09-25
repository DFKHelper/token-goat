#!/usr/bin/env node
/** Opt-in latency benchmark of one hook call, spawn to exit, four ways: `node -e 0` (the floor any Node command pays), the Node shim served by a resident hook server, the native client (native/tg-hook) served by the same server, and the native client falling back to the Node shim with the server switched off, beside the Node shim run the same way, which is what every call cost before the server existed. Everything runs in a scratch sandbox under the temp directory (data, config and harness homes), against the built bundle and the native binary scripts/build-native.mjs installs; the server it starts is stopped with the client's own stop query before it exits. Variants run round-robin so a burst of machine load lands on all of them alike, and the report leads with the fastest warmed run of each, since one sample under load is a coin flip. Usage: node scripts/bench-native-hook.mjs [--runs N] [--warmup N] [--json] */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')
const WIN = process.platform === 'win32'

function flag(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const RUNS = flag('--runs', 30)
const WARMUP = flag('--warmup', 5)
const JSON_OUT = process.argv.includes('--json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(BUNDLE)) throw new Error(`${BUNDLE} is missing; run npm run build first`)
const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-native.mjs')], { cwd: ROOT, encoding: 'utf8' })
if (built.status !== 0) throw new Error(`scripts/build-native.mjs failed:\n${built.stderr}`)
const bin = built.stdout.trim().split(/\r?\n/).pop()

// The sandbox, laid out the way tests/native_hook_client.test.ts lays out its own: every directory token-goat or a harness would write to is inside it.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-native-')))
const dataDir = WIN ? path.join(base, 'AppData', 'Local', 'dfk-helper', 'token-goat') : process.platform === 'darwin' ? path.join(base, 'Library', 'Application Support', 'token-goat') : path.join(base, '.local', 'share', 'token-goat')
const envRoot = WIN ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
const proj = path.join(base, 'proj')
fs.mkdirSync(proj, { recursive: true })
const env = { ...process.env }
for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX|GROK|KIMI|COPILOT|OPENCODE|CURSOR|GEMINI)_|^CLAUDECODE$|^TERM_PROGRAM$|^TOKEN_GOAT_/.test(k)) delete env[k]
Object.assign(env, {
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
  TOKEN_GOAT_NO_WORKER_SPAWN: '1',
  TOKEN_GOAT_HOOK_SERVER: '1',
})

function cli(args, extra = {}) {
  return spawnSync(process.execPath, [BUNDLE, ...args], { cwd: base, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 })
}

function statuses() {
  const r = cli(['hook-server', 'status', '--json'])
  return r.status === 0 ? JSON.parse(r.stdout) : []
}

let server
async function main() {
  const installed = cli(['install'])
  if (installed.status !== 0) throw new Error(`install failed:\n${installed.stderr}`)
  const shim = path.join(base, '.claude', 'hooks', 'token-goat-shim.cjs')
  if (!fs.existsSync(shim)) throw new Error(`no shim at ${shim}`)

  server = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], { cwd: base, env, stdio: 'ignore' })
  const deadline = Date.now() + 30_000
  while (!statuses().some((s) => s.slot === 0)) {
    if (Date.now() > deadline || server.exitCode !== null) throw new Error('the hook server did not start')
    await sleep(100)
  }

  // A Bash call the pre_tool_use handler lets through: the handler's own cost is small next to process start, which is what is being measured.
  const payload = JSON.stringify({ session_id: 'bench', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } })
  const wired = [process.execPath, shim, 'pre_tool_use', BUNDLE]
  const nativeArgs = ['--harness', 'claudecode', '--event', 'pre_tool_use', '--entry', BUNDLE, '--script-dir', path.dirname(shim), '--', ...wired]
  const off = { TOKEN_GOAT_HOOK_SERVER: '0' }
  const variants = [
    { name: 'node -e 0', argv: [process.execPath, '-e', '0'] },
    { name: 'Node shim, served', argv: wired, served: true },
    { name: 'native, served', argv: [bin, ...nativeArgs], served: true },
    { name: 'Node shim, server off (before the server)', argv: wired, env: off },
    { name: 'native, fallback (server off)', argv: [bin, ...nativeArgs], env: off },
  ]
  const expected = new Map()
  const times = new Map(variants.map((v) => [v.name, []]))
  const servedBefore = statuses().find((s) => s.slot === 0)?.served ?? 0
  let servedCalls = 0
  for (let round = 0; round < WARMUP + RUNS; round++) {
    for (const v of variants) {
      // A server finishes a request's after-reply work after answering and says busy meanwhile, which would turn the next call into a fallback.
      if (v.served) await sleep(60)
      const t0 = performance.now()
      const r = spawnSync(v.argv[0], v.argv.slice(1), { cwd: proj, env: { ...env, ...v.env }, input: payload, encoding: 'utf8' })
      const ms = performance.now() - t0
      if (r.status !== 0) throw new Error(`${v.name} exited ${r.status}: ${r.stderr}`)
      if (v.name !== 'node -e 0') {
        if (!expected.has('out')) expected.set('out', r.stdout)
        else if (r.stdout !== expected.get('out')) throw new Error(`${v.name} printed ${JSON.stringify(r.stdout)}, not ${JSON.stringify(expected.get('out'))}`)
      }
      if (v.served) servedCalls++
      if (round >= WARMUP) times.get(v.name).push(ms)
    }
  }
  await sleep(200)
  const servedDelta = (statuses().find((s) => s.slot === 0)?.served ?? 0) - servedBefore

  const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]
  const rows = variants.map((v) => {
    const xs = [...times.get(v.name)].sort((a, b) => a - b)
    return { variant: v.name, min: +xs[0].toFixed(1), median: +q(xs, 0.5).toFixed(1), p90: +q(xs, 0.9).toFixed(1) }
  })
  const report = { platform: `${process.platform}-${process.arch}`, node: process.version, runs: RUNS, warmup: WARMUP, binaryBytes: fs.statSync(bin).size, servedCalls, servedDelta, output: expected.get('out'), rows }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`${report.platform}, Node ${report.node}, ${RUNS} measured runs per variant after ${WARMUP} warm-up rounds, spawn to exit in ms`)
    console.log(`native binary ${report.binaryBytes} bytes; ${servedDelta} of ${servedCalls} served-variant calls counted by the server`)
    for (const r of rows) console.log(`${r.variant.padEnd(44)} min ${String(r.min).padStart(6)}  median ${String(r.median).padStart(6)}  p90 ${String(r.p90).padStart(6)}`)
  }
  if (servedDelta !== servedCalls) process.exitCode = 1
}

try {
  await main()
} finally {
  cli(['hook-server', 'stop'])
  const deadline = Date.now() + 10_000
  while (statuses().length > 0 && Date.now() < deadline) await sleep(100)
  if (server !== undefined && server.exitCode === null) server.kill()
  fs.rmSync(base, { recursive: true, force: true })
}
