/** The native hook client as the installers wire it, driven end to end. Each harness gets a sandbox home whose path holds a space, `%x%`, `$y`, single quotes and a non-ASCII letter, and a directory link to this repository inside it, so the bundle entry, the shim and (on Windows) the data-directory copy of tg-hook all sit under that path. The built bundle installs through the link with the shipping default (TOKEN_GOAT_NATIVE_HOOKS unset), then every command it wrote is run the way that harness runs it, against a real hook server started from the built bundle, and must be served (the slot's `served` counter moves by one), answer exactly what the wrapped Node command answers on its own, and fall back to that command when the server is off. The same sandboxes then switch every event to the Node form and back, uninstall, and read `doctor`. Provenance of each harness's shell, FORMAT-DERIVED from the harness's own source: - Claude Code: exec form is spawned directly; string form runs through Git Bash on Windows (it refuses to run hooks without it) and /bin/sh elsewhere (the claude binary's hook runner, strings read out of claude.exe). - Codex: codex-rs/hooks/src/engine/command_runner.rs `build_command` with the session shell's `derive_exec_args`: `powershell -NoProfile -Command <cmd>` on Windows, `<shell> -c <cmd>` elsewhere. - Grok: xai-grok-hooks/src/runner/command.rs (`sh -c` off Windows) and xai-grok-config/src/shell.rs `shell_command_argv` (pwsh, then powershell.exe, with `-NoProfile -NonInteractive -Command`). - Kimi Code: Node `spawn(command, { shell: true })`. - Copilot CLI / VS Code: microsoft/vscode extensions/copilot/src/platform/chat/node/hookExecutor.ts `getShellCommand` (`powershell.exe -ExecutionPolicy Bypass -NoProfile -NoLogo -Command` on Windows) and hookSchema.ts (`bash` field off Windows); the `command` field is what `doctor` launches with `shell: true`. Payloads come from tests/fixtures/harness_hook_payloads.ts, which carries its own per-case provenance. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse as parseToml } from 'smol-toml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeCodexHookHash } from '../src/bridges/codex_install.js'
import { dataDirForHome } from '../src/constants.js'
import { endpointFor, readServerKey, type ServerStatus } from '../src/hook_ipc.js'
import { parseNativeInvocation, splitHookCommand, type HookShell } from '../src/native_hook.js'
import Database from '../src/sqlite_driver.js'
import { HARNESS_HOOK_PAYLOADS, type HookPayloadCase, type PayloadHarness } from './fixtures/harness_hook_payloads.js'
import { ROOT } from './helpers/bundle.js'
import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'
import { slotStatus, waitIdle } from './helpers/hook_server_probe.js'
import { buildNative } from './helpers/native_bin.js'

type Env = Record<string, string>
const WIN = process.platform === 'win32'
/** Platforms this build ships a native hook client for (native_hook.ts NATIVE_TARGETS); elsewhere, macOS, every installer writes the Node form, so there is no native form to drive. */
const NATIVE = WIN || process.platform === 'linux'
/** Every character class that has broken a generated hook command line in some shell: a space, cmd's `%NAME%`, POSIX and PowerShell `$name`, a single quote, and a non-ASCII letter. `x` and `y` are removed from the environment, so neither expands. */
const SPECIAL = `tg %x% $y 'q' é`
/** Grok expands `$VAR` in a hook command itself when it loads the config and refuses to run one naming an unset variable (xai-grok-hooks env_expand.rs `find_unresolved_env_vars`), whatever the quoting, so its sandbox leaves the dollar out. */
const SPECIAL_NO_DOLLAR = `tg %x% 'q' é`
/** Kimi Code runs a hook through cmd.exe on Windows, where install refuses a path holding a `%NAME%` pair (cmd expands one before it reads a quote), so its Windows sandbox leaves the percent pair out. */
const SPECIAL_NO_PERCENT = `tg $y 'q' é`
const specialFor = (harness: PayloadHarness): string => (harness === 'grok' ? SPECIAL_NO_DOLLAR : harness === 'kimi' && WIN ? SPECIAL_NO_PERCENT : SPECIAL)

interface Entry {
  command: string
  args?: string[]
  bash?: string
  powershell?: string
}

interface Sandbox {
  root: string
  home: string
  link: string
  proj: string
  dataDir: string
  entry: string
  env: Env
  key?: Buffer
  endpoint?: string
  server?: ChildProcess
  pids: Set<number>
}

const sandboxes: Sandbox[] = []
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function makeSandbox(dirName: string): Sandbox {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-natinst-')))
  const home = path.join(root, dirName)
  const proj = path.join(home, 'proj')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  // HAND-DERIVED project files the payloads name.
  fs.writeFileSync(path.join(proj, 'notes.md'), '# Title\n\nintro\n\n## Alpha\n\nalpha body\n')
  fs.writeFileSync(path.join(proj, 'src', 'index.ts'), 'export const a = 1\n')
  const link = path.join(home, 'pkg')
  fs.symlinkSync(ROOT, link, WIN ? 'junction' : 'dir')
  const dataDir = dataDirForHome(home)
  const env: Env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
  for (const k of Object.keys(env)) if (['x', 'y', 'q', 'token_goat_native_hooks'].includes(k.toLowerCase())) delete env[k]
  const envRoot = WIN ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'),
    COPILOT_HOME: path.join(home, '.copilot'),
    LOCALAPPDATA: envRoot,
    XDG_DATA_HOME: envRoot,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TOKEN_GOAT_HOME: path.join(home, 'tg-home'),
    TOKEN_GOAT_HOOK_SERVER: '0',
  })
  const sb: Sandbox = { root, home, link, proj, dataDir, entry: path.join(link, 'dist', 'token-goat.mjs'), env, pids: new Set() }
  sandboxes.push(sb)
  return sb
}

function cli(sb: Sandbox, args: string[], env: Env = {}, cwd: string = sb.home): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [sb.entry, ...args], { cwd, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 180_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function install(sb: Sandbox, flags: string[], env: Env = {}, cwd?: string): void {
  const res = cli(sb, ['install', ...flags], env, cwd)
  expect(res.status, `install ${flags.join(' ')}: ${res.stderr}${res.stdout}`).toBe(0)
}

async function startServer(sb: Sandbox): Promise<void> {
  const child = spawn(process.execPath, [sb.entry, 'hook-server', 'run', '--slot', '0'], { cwd: sb.home, env: { ...sb.env, TOKEN_GOAT_HOOK_SERVER: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
  sb.server = child
  if (child.pid !== undefined) sb.pids.add(child.pid)
  const deadline = Date.now() + 30_000
  for (;;) {
    const res = cli(sb, ['hook-server', 'status', '--json'], { TOKEN_GOAT_HOOK_SERVER: '1' })
    const list = res.status === 0 ? (JSON.parse(res.stdout) as ServerStatus[]) : []
    const key = readServerKey(sb.dataDir)
    if (list.some((s) => s.slot === 0) && key !== undefined) {
      sb.key = key
      sb.endpoint = endpointFor(0, sb.dataDir, fs.realpathSync.native(path.dirname(sb.entry)))
      return
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`hook server did not start: ${stderr}`)
    await sleep(100)
  }
}

async function served(sb: Sandbox): Promise<number> {
  await waitIdle(sb.endpoint!)
  const s = await slotStatus(sb.endpoint!, sb.key!)
  if (s === undefined) throw new Error('the hook server did not answer a status request')
  return s.served
}

/** Every object with a string `command` under `value`. */
function entriesIn(value: unknown, out: Entry[] = []): Entry[] {
  if (Array.isArray(value)) for (const v of value) entriesIn(v, out)
  else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o['command'] === 'string') out.push(o as unknown as Entry)
    else for (const v of Object.values(o)) entriesIn(v, out)
  }
  return out
}

/** token-goat's own hook entries in a harness config, or none when the file is gone. */
function tokenGoatEntries(file: string): Entry[] {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const parsed = (file.endsWith('.json') ? JSON.parse(text) : parseToml(text)) as Record<string, unknown>
  return entriesIn(parsed['hooks']).filter((e) => [e.command, ...(e.args ?? [])].join(' ').includes('token-goat-shim'))
}

function wordsOf(e: Entry, shell: HookShell): string[] {
  return e.args !== undefined && e.args.length > 0 ? [e.command, ...e.args] : splitHookCommand(e.command, shell)
}

/** The event argument the entry runs the shim with: the word after the shim path. */
function eventOf(words: readonly string[]): string {
  const i = words.findIndex((w) => /token-goat-shim\.cjs$/.test(w))
  return words[i + 1] ?? ''
}

function substitute(text: string, sb: Sandbox, sid: string): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1)
  return text.replaceAll('{{PROJ}}', () => esc(sb.proj)).replaceAll('{{SID}}', () => esc(sid))
}

interface Run {
  stdout: string
  stderr: string
  exit: number | null
}

/** How a harness launches one command line. */
interface Launch {
  file: string
  args: string[]
  shell?: string | boolean
}

function launch(l: Launch, c: HookPayloadCase, sb: Sandbox, sid: string, env: Env): Promise<Run> {
  const caseEnv: Env = {}
  for (const [k, v] of Object.entries(c.env ?? {})) caseEnv[k] = substitute(v, sb, sid)
  return new Promise((resolve, reject) => {
    const child = spawn(l.file, l.args, { cwd: sb.proj, env: { ...sb.env, ...caseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(l.shell === undefined ? {} : { shell: l.shell }) })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (exit) => resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, exit }))
    child.stdin.end(substitute(c.raw ?? JSON.stringify(c.payload), sb, sid))
  })
}

function whereOnWindows(name: string): string | undefined {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() : undefined
}

/** Git Bash, which Claude Code on Windows runs every string-form hook through. */
function gitBash(): string {
  const candidates = [process.env['CLAUDE_CODE_GIT_BASH_PATH'], 'C:\\Program Files\\Git\\bin\\bash.exe']
  const git = whereOnWindows('git')
  if (git !== undefined) candidates.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'))
  const found = candidates.find((c) => c !== undefined && fs.existsSync(c))
  if (found === undefined) throw new Error('Git Bash not found; Claude Code on Windows cannot run string-form hooks without it either')
  return found
}

const sh = (cmd: string): Launch => ({ file: '/bin/sh', args: ['-c', cmd] })
const nodeShell = (cmd: string): Launch => ({ file: cmd, args: [], shell: true })
const powershell = (exe: string, pre: string[]) => (cmd: string): Launch => ({ file: exe, args: [...pre, cmd] })

interface Way {
  /** What the row asserts about, e.g. `powershell field via VS Code`. */
  label: string
  /** Which field of the entry this way runs. */
  field: 'command' | 'bash' | 'powershell' | 'exec'
  /** How the harness splits that field into words, for finding the entry and its wrapped command. */
  split: HookShell
  run: (cmd: string, e: Entry) => Launch
}

/** How each harness runs a hook command on this platform. */
function waysFor(harness: PayloadHarness, claudeForm: 'exec' | 'string'): Way[] {
  const pwsh = WIN ? whereOnWindows('pwsh') : undefined
  switch (harness) {
    case 'claudecode':
      if (claudeForm === 'exec') return [{ label: 'exec form, spawned directly', field: 'exec', split: 'sh', run: (_c, e) => ({ file: e.command, args: e.args ?? [] }) }]
      return [{ label: WIN ? 'string form through Git Bash' : 'string form through /bin/sh', field: 'command', split: 'sh', run: (c) => (WIN ? { file: c, args: [], shell: gitBash() } : sh(c)) }]
    case 'codex':
      return [{ label: WIN ? 'powershell -NoProfile -Command' : 'sh -c', field: 'command', split: WIN ? 'powershell' : 'sh', run: WIN ? powershell('powershell.exe', ['-NoProfile', '-Command']) : sh }]
    case 'grok':
      if (!WIN) return [{ label: 'sh -c', field: 'command', split: 'sh', run: sh }]
      return [
        { label: 'powershell.exe -NoProfile -NonInteractive -Command', field: 'command', split: 'powershell', run: powershell('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']) },
        ...(pwsh === undefined ? [] : [{ label: 'pwsh -NoProfile -NonInteractive -Command', field: 'command' as const, split: 'powershell' as const, run: powershell(pwsh, ['-NoProfile', '-NonInteractive', '-Command']) }]),
      ]
    case 'kimi':
      return [{ label: WIN ? 'spawn shell: true (cmd.exe)' : 'spawn shell: true (/bin/sh)', field: 'command', split: WIN ? 'cmd' : 'sh', run: nodeShell }]
    case 'copilot_cli':
      return [
        WIN
          ? { label: 'powershell field via VS Code', field: 'powershell', split: 'powershell', run: powershell('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NoLogo', '-Command']) }
          : { label: 'bash field via bash -c', field: 'bash', split: 'sh', run: (c) => ({ file: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', c] }) },
        { label: 'command field via spawn shell: true', field: 'command', split: WIN ? 'cmd' : 'sh', run: nodeShell },
      ]
  }
}

const INSTALL_FLAG: Record<PayloadHarness, string[]> = { claudecode: [], codex: ['--codex'], grok: ['--grok'], kimi: ['--kimi'], copilot_cli: ['--copilot'] }
const CONFIG_FILE: Record<PayloadHarness, (sb: Sandbox) => string> = {
  claudecode: (sb) => path.join(sb.home, '.claude', 'settings.json'),
  codex: (sb) => path.join(sb.home, '.codex', 'config.toml'),
  grok: (sb) => path.join(sb.home, '.grok', 'hooks', 'token-goat.json'),
  kimi: (sb) => path.join(sb.home, '.kimi-code', 'config.toml'),
  copilot_cli: (sb) => path.join(sb.home, '.copilot', 'hooks', 'token-goat.json'),
}
/** A case per harness whose answer is not empty (token-goat redirects the command), so equal output cannot come from both sides answering nothing. */
const CASE: Record<PayloadHarness, string> = {
  claudecode: 'Bash command token-goat redirects (block)',
  codex: 'Bash command token-goat redirects (block)',
  grok: 'run_terminal_command token-goat redirects (deny, exit 2)',
  kimi: 'Bash command token-goat redirects (deny)',
  copilot_cli: 'bash command token-goat redirects (deny)',
}

function caseFor(harness: PayloadHarness): HookPayloadCase {
  const c = HARNESS_HOOK_PAYLOADS.find((p) => p.harness === harness && p.name === CASE[harness])
  if (c === undefined) throw new Error(`no payload case ${harness}|${CASE[harness]}`)
  return c
}

/** The written entry for `c`'s event, the words the harness's shell makes of `way`'s field, and the command that field launches. */
function wiredFor(entries: readonly Entry[], c: HookPayloadCase, way: Way): { entry: Entry; words: string[]; cmd: string } {
  for (const entry of entries) {
    const cmd = way.field === 'exec' ? entry.command : way.field === 'command' ? entry.command : entry[way.field]
    if (typeof cmd !== 'string') continue
    const words = way.field === 'exec' ? wordsOf(entry, 'sh') : splitHookCommand(cmd, way.split)
    if (eventOf(words) === c.event) return { entry, words, cmd }
  }
  throw new Error(`no ${c.event} entry for ${way.label}`)
}

/** Served, reference and fallback runs of every way `harness` launches its command, with the counts each must leave in `stats`. */
async function driveHarness(sb: Sandbox, harness: PayloadHarness, claudeForm: 'exec' | 'string' = 'exec'): Promise<{ native: number; fallback: number }> {
  const c = caseFor(harness)
  const entries = tokenGoatEntries(CONFIG_FILE[harness](sb))
  // The variable Claude Code sets in the processes it starts (tests/helpers/harness-env.ts), so its rows are recorded under its name as a real session's are; the other harnesses' shims and adapters name themselves, or the case carries the harness's own variable.
  const id: Env = harness === 'claudecode' ? { CLAUDE_CODE_SESSION_ID: 'tg-native-e2e' } : {}
  let native = 0
  let fallback = 0
  for (const way of waysFor(harness, claudeForm)) {
    const { entry, words, cmd } = wiredFor(entries, c, way)
    const inv = parseNativeInvocation(words)
    expect(inv, `${way.label}: not the native form: ${cmd}`).toBeDefined()
    expect(inv!.harness).toBe(harness)
    // The paths really do carry the awkward characters, so a pass is not a pass on plain paths.
    expect(words.some((w) => w.includes(specialFor(harness))), words.join(' | ')).toBe(true)
    const ref = await launch({ file: inv!.wrapped[0]!, args: inv!.wrapped.slice(1) }, c, sb, `ref-${harness}-${way.field}`, id)
    expect(ref.stdout.trim() !== '' || ref.exit !== 0, `the reference answered nothing: ${ref.stderr}`).toBe(true)

    const before = await served(sb)
    const nat = await launch(way.run(cmd, entry), c, sb, `nat-${harness}-${way.field}`, { ...id, TOKEN_GOAT_HOOK_SERVER: '1' })
    expect(await served(sb), `${way.label}: not served; stderr: ${nat.stderr}`).toBe(before + 1)
    expect({ stdout: nat.stdout, exit: nat.exit }, `${way.label}: ${nat.stderr}`).toEqual({ stdout: ref.stdout, exit: ref.exit })
    native++

    const fb = await launch(way.run(cmd, entry), c, sb, `fb-${harness}-${way.field}`, { ...id, TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(await served(sb), `${way.label}: a server-off call was served`).toBe(before + 1)
    expect({ stdout: fb.stdout, exit: fb.exit }, `${way.label} fallback: ${fb.stderr}`).toEqual({ stdout: ref.stdout, exit: ref.exit })
    fallback++
  }
  return { native, fallback }
}

/** Every way `harness` launches its Node-form command answers exactly what that Node command answers run directly, exit code included: the line parses in the harness's shell (Grok's Windows Node form once did not, in either PowerShell), and a PowerShell line exits with the hook's own code (Grok's deny exits 2). */
async function driveNodeForm(sb: Sandbox, harness: PayloadHarness): Promise<void> {
  const c = caseFor(harness)
  const entries = tokenGoatEntries(CONFIG_FILE[harness](sb))
  const id: Env = harness === 'claudecode' ? { CLAUDE_CODE_SESSION_ID: 'tg-node-e2e' } : {}
  for (const way of waysFor(harness, 'exec')) {
    const { entry, words, cmd } = wiredFor(entries, c, way)
    expect(parseNativeInvocation(words), `${way.label}: not the Node form: ${cmd}`).toBeUndefined()
    expect(words.some((w) => w.includes(specialFor(harness))), words.join(' | ')).toBe(true)
    const ref = await launch({ file: words[0]!, args: words.slice(1) }, c, sb, `noderef-${harness}-${way.field}`, { ...id, TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(ref.stdout.trim() !== '' || ref.exit !== 0, `the reference answered nothing: ${ref.stderr}`).toBe(true)
    const run = await launch(way.run(cmd, entry), c, sb, `node-${harness}-${way.field}`, { ...id, TOKEN_GOAT_HOOK_SERVER: '0' })
    expect({ stdout: run.stdout, exit: run.exit }, `${way.label} (Node form): ${run.stderr}`).toEqual({ stdout: ref.stdout, exit: ref.exit })
  }
}

/** `stats.detail` counts over the sandbox's `hook:*` rows. */
function detailCounts(sb: Sandbox): Record<string, number> {
  const db = new Database(path.join(sb.dataDir, 'global.db'), { readonly: true })
  try {
    const rows = db.prepare("SELECT COALESCE(detail, 'node') AS d, COUNT(*) AS n FROM stats WHERE kind LIKE 'hook:%' GROUP BY 1").all() as Array<{ d: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.d, r.n]))
  } finally {
    db.close()
  }
}

function forms(file: string, shell: HookShell): { native: number; node: number } {
  const entries = tokenGoatEntries(file)
  const native = entries.filter((e) => parseNativeInvocation(wordsOf(e, shell)) !== undefined).length
  return { native, node: entries.length - native }
}

function doctorRows(sb: Sandbox, env: Env = {}): Array<{ name: string; status: string; message: string }> {
  const res = cli(sb, ['doctor', '--json'], env, sb.proj)
  const parsed = JSON.parse(res.stdout) as unknown
  const list = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>)['checks'] ?? (parsed as Record<string, unknown>)['results'])
  return list as Array<{ name: string; status: string; message: string }>
}

function stopServer(sb: Sandbox): void {
  if (sb.server === undefined) return
  cli(sb, ['hook-server', 'stop'], { TOKEN_GOAT_HOOK_SERVER: '1' })
}

beforeAll(() => {
  buildNative()
}, 900_000)

afterAll(async () => {
  for (const sb of sandboxes) {
    try {
      stopServer(sb)
    } catch {
      // the pid wait below still runs
    }
    const deadline = Date.now() + 5000
    for (const pid of sb.pids) {
      while (pidAlive(pid) && Date.now() < deadline) await sleep(50)
      if (pidAlive(pid)) process.kill(pid)
    }
    // The link first, on its own: removing the tree through it would reach the repository.
    if (WIN) fs.rmdirSync(sb.link)
    else fs.unlinkSync(sb.link)
    fs.rmSync(sb.root, { recursive: true, force: true })
  }
  expect(fs.existsSync(path.join(ROOT, 'package.json'))).toBe(true)
}, 60_000)

const SPLIT: Record<PayloadHarness, HookShell> = { claudecode: 'sh', codex: WIN ? 'powershell' : 'sh', grok: WIN ? 'powershell' : 'sh', kimi: WIN ? 'cmd' : 'sh', copilot_cli: WIN ? 'cmd' : 'sh' }

describe.runIf(NATIVE).each(['claudecode', 'codex', 'grok', 'kimi', 'copilot_cli'] as const)('%s: native hook commands as installed', (harness) => {
  let sb: Sandbox
  let expected = { native: 0, fallback: 0 }

  beforeAll(async () => {
    sb = makeSandbox(specialFor(harness))
    await startServer(sb)
  }, 120_000)

  it('writes the native form for every event and each way the harness runs it is served, matches the Node command, and falls back to it', async () => {
    install(sb, INSTALL_FLAG[harness], harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {})
    const f = forms(CONFIG_FILE[harness](sb), SPLIT[harness])
    expect(f.native).toBeGreaterThan(0)
    expect(f.node).toBe(0)
    const got = await driveHarness(sb, harness, 'exec')
    expected = { native: expected.native + got.native, fallback: expected.fallback + got.fallback }
    if (harness === 'claudecode') {
      install(sb, [], { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '0' })
      const s = forms(CONFIG_FILE[harness](sb), 'sh')
      expect(s).toEqual({ native: f.native, node: 0 })
      expect(tokenGoatEntries(CONFIG_FILE[harness](sb)).every((e) => e.args === undefined)).toBe(true)
      const str = await driveHarness(sb, harness, 'string')
      expected = { native: expected.native + str.native, fallback: expected.fallback + str.fallback }
    }
    // One row per call, each under the path it took: `native` from the server, `native-fallback:server-off` from the Node command tg-hook fell back to, and nothing from the reference run of that Node command alone.
    const counts = detailCounts(sb)
    expect(counts['native']).toBe(expected.native)
    expect(counts['native-fallback:server-off']).toBe(expected.fallback)
    expect(counts['node']).toBe(expected.native)
  }, 240_000)

  it('switches every event to the Node form, which each way the harness runs it answers as the Node command does, and back on reinstall, and uninstall removes the native entries', async () => {
    const file = CONFIG_FILE[harness](sb)
    const before = forms(file, SPLIT[harness])
    const env: Env = harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {}
    install(sb, INSTALL_FLAG[harness], { ...env, TOKEN_GOAT_NATIVE_HOOKS: '0' })
    expect(forms(file, SPLIT[harness])).toEqual({ native: 0, node: before.native + before.node })
    await driveNodeForm(sb, harness)
    install(sb, INSTALL_FLAG[harness], env)
    expect(forms(file, SPLIT[harness])).toEqual({ native: before.native + before.node, node: 0 })
    if (harness === 'codex') {
      // Codex refuses an entry whose trusted_hash does not match its command, so every native entry must carry its own.
      const cfg = parseToml(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> & { state: Record<string, { trusted_hash?: string }> } }
      let checked = 0
      for (const [event, groups] of Object.entries(cfg.hooks)) {
        if (event === 'state' || !Array.isArray(groups)) continue
        groups.forEach((g: { matcher?: string; hooks?: Entry[] }, gi: number) => {
          ;(g.hooks ?? []).forEach((h, hi) => {
            const eventArg = eventOf(splitHookCommand(h.command, SPLIT.codex))
            const stateKey = Object.keys(cfg.hooks.state).find((k) => k.endsWith(`:${eventArg}:${gi}:${hi}`))
            expect(stateKey, `${event} ${gi}:${hi}`).toBeDefined()
            expect(cfg.hooks.state[stateKey!]!.trusted_hash).toBe(computeCodexHookHash(eventArg, h.command, g.matcher))
            checked++
          })
        })
      }
      expect(checked).toBe(before.native + before.node)
    }
    if (harness === 'claudecode' || harness === 'copilot_cli') {
      // The project scope switches the same way.
      const flags = harness === 'claudecode' ? ['--project'] : ['--copilot', '--local']
      const projFile = harness === 'claudecode' ? path.join(sb.proj, '.claude', 'settings.json') : path.join(sb.proj, '.github', 'hooks', 'token-goat.json')
      install(sb, flags, env, sb.proj)
      const n = forms(projFile, SPLIT[harness])
      expect(n.native).toBeGreaterThan(0)
      expect(n.node).toBe(0)
      install(sb, flags, { ...env, TOKEN_GOAT_NATIVE_HOOKS: '0' }, sb.proj)
      expect(forms(projFile, SPLIT[harness])).toEqual({ native: 0, node: n.native })
      install(sb, flags, env, sb.proj)
      expect(forms(projFile, SPLIT[harness])).toEqual(n)
      const un = cli(sb, ['uninstall', ...(harness === 'claudecode' ? ['--project'] : ['--copilot', '--local'])], {}, sb.proj)
      expect(un.status, un.stderr).toBe(0)
      expect(forms(projFile, SPLIT[harness]).native).toBe(0)
    }
  }, 240_000)

  it('doctor reports the wired form, its self-test and the counts; a missing binary is broken, the Node form outdated, and off is quiet', async () => {
    const file = CONFIG_FILE[harness](sb)
    const label = { claudecode: 'Claude Code (user)', codex: 'Codex', grok: 'Grok CLI', kimi: 'Kimi Code', copilot_cli: 'Copilot CLI (user)' }[harness]
    const run = `token-goat install${INSTALL_FLAG[harness].length > 0 ? ` ${INSTALL_FLAG[harness].join(' ')}` : ''}`
    const row = (env: Env = {}): { status: string; message: string } => {
      const r = doctorRows(sb, env).find((x) => x.name === `Native hooks (${label})`)
      expect(r, `no Native hooks (${label}) row`).toBeDefined()
      return r!
    }
    const execEnv: Env = harness === 'claudecode' ? { TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '1' } : {}

    const countsBeforeDoctor = detailCounts(sb)
    const live = row(execEnv)
    expect(detailCounts(sb), 'doctor recorded a hook call of its own').toEqual(countsBeforeDoctor)
    expect(live.status, live.message).toBe('ok')
    expect(live.message).toMatch(/^native, .*tg-hook(\.exe)?, self-test passed; last 7 days: \d+ served natively, \d+ fell back \(server-off \d+\), \d+ through Node$/)
    // Copilot's own doctor check (checkCopilotCli) runs the wired preToolUse command for real, and under this sandbox's TOKEN_GOAT_HOOK_SERVER=0 that call falls back to Node; it marks the call as its own (HOOK_PROBE_ENV), so the counts are the harness's calls alone.
    const fellBack = expected.fallback
    expect(live.message).toContain(`${expected.native} served natively, ${fellBack} fell back (server-off ${fellBack})`)

    install(sb, INSTALL_FLAG[harness], { ...execEnv, TOKEN_GOAT_NATIVE_HOOKS: '0' })
    const outdated = row(execEnv)
    expect(outdated.status, outdated.message).toBe('warn')
    expect(outdated.message).toContain(`Node form while the native hook client is available; run '${run}' to switch`)

    const off = row({ ...execEnv, TOKEN_GOAT_NATIVE_HOOKS: '0' })
    expect(off.status, off.message).toBe('ok')
    expect(off.message).toMatch(/^Node form; native hooks are off \(hooks\.native or TOKEN_GOAT_NATIVE_HOOKS\)/)

    install(sb, INSTALL_FLAG[harness], execEnv)
    // A binary that has gone: every entry now names one that does not exist.
    const text = fs.readFileSync(file, 'utf8')
    const bin = parseNativeInvocation(wordsOf(tokenGoatEntries(file)[0]!, SPLIT[harness]))!.bin
    const gone = path.join(path.dirname(bin), 'gone', path.basename(bin))
    // The path sits in the file as each shell's quoting wrote it (bare in an exec-form entry and cmd.exe's double quotes, `''` in PowerShell, `'\''` in sh), then string-escaped by JSON or TOML, both of which escape a backslash and a double quote the way JSON.stringify does.
    const encode = (s: string): string => JSON.stringify(s).slice(1, -1)
    const quotings = [(s: string): string => s, (s: string): string => s.replaceAll("'", "''"), (s: string): string => s.replaceAll("'", String.raw`'\''`)]
    let rewritten = text
    for (const q of quotings) rewritten = rewritten.split(encode(q(bin))).join(encode(q(gone)))
    fs.writeFileSync(file, rewritten)
    const bins = tokenGoatEntries(file).map((e) => parseNativeInvocation(wordsOf(e, SPLIT[harness]))?.bin)
    expect(bins.length).toBeGreaterThan(0)
    expect(bins.every((b) => b === gone), JSON.stringify(bins)).toBe(true)
    // Run the broken entries the way the harness does: a binary that cannot start must not read as a hook that exited 0 and allowed the call. Through PowerShell this is POWERSHELL_EXIT_SUFFIX's guard, since LASTEXITCODE is never set when the call operator finds nothing to run.
    const c = caseFor(harness)
    for (const way of waysFor(harness, 'exec')) {
      const { entry, cmd } = wiredFor(tokenGoatEntries(file), c, way)
      const r = await launch(way.run(cmd, entry), c, sb, 'tg-native-broken', {}).catch((e: unknown) => ({ stdout: '', stderr: String(e), exit: -1 }))
      expect(r.exit, `${way.label}: ${r.stderr}`).not.toBe(0)
    }
    const broken = row(execEnv)
    expect(broken.status, broken.message).toBe('fail')
    expect(broken.message).toContain('which no longer exists, so those events fail instead of falling back to Node')
    expect(broken.message).toContain(`run '${run}' to rewrite them`)
    if (harness === 'claudecode') {
      const events = doctorRows(sb, execEnv).find((x) => x.name === 'Claude Code hook events')!
      expect(events.status, events.message).toBe('fail')
      expect(events.message).toContain('to a native hook client binary that no longer exists; run: token-goat install')
      // Broken, not outdated: the entry is what this build writes apart from the binary being gone.
      expect(events.message).not.toContain('no longer writes')
    }
    if (harness === 'copilot_cli') {
      // Copilot's own row checks the binary before it runs the command, so it names the cause rather than a launch failure.
      const own = doctorRows(sb, execEnv).find((x) => x.name === 'Copilot CLI')!
      expect(own.status, own.message).toBe('fail')
      expect(own.message).toContain(`native hook client binary that no longer exists (${gone})`)
    }
    install(sb, INSTALL_FLAG[harness], execEnv)
    const reinstalled = row(execEnv)
    expect(reinstalled.status, reinstalled.message).toBe('ok')
    if (WIN) {
      // doctor only reads: with the data-dir copy gone it reports the entries broken and leaves the copy for install to write, rather than writing it while it computes what install would write. Moved rather than deleted: an unlink returns at once but leaves the name in place while anything (a scanner, just after the self-test ran it) still holds the file open, and a rename takes effect regardless.
      fs.renameSync(bin, `${bin}.moved`)
      expect(fs.existsSync(bin), 'moved away before doctor').toBe(false)
      const missing = row(execEnv)
      expect(missing.status, missing.message).toBe('fail')
      expect(fs.existsSync(bin)).toBe(false)
      install(sb, INSTALL_FLAG[harness], execEnv)
      expect(fs.existsSync(bin)).toBe(true)
      const rewritten = row(execEnv)
      expect(rewritten.status, rewritten.message).toBe('ok')
    }

    const un = cli(sb, ['uninstall', ...INSTALL_FLAG[harness]])
    expect(un.status, un.stderr).toBe(0)
    expect(forms(file, SPLIT[harness]).native).toBe(0)
  }, 300_000)
})

describe('install refuses a hook path the harness rewrites before running it', () => {
  /** Installs with the native client on and off (so both command forms are checked), with `x` and `y` set so either span would really change the path, and expects a refusal that writes no hook config. */
  function refuses(dirName: string, flag: string, span: string, file: (sb: Sandbox) => string): void {
    const sb = makeSandbox(dirName)
    for (const native of ['1', '0']) {
      const res = cli(sb, ['install', flag], { TOKEN_GOAT_NATIVE_HOOKS: native, x: 'expanded', y: 'expanded' })
      expect(res.status, `${native}: ${res.stdout}${res.stderr}`).not.toBe(0)
      expect(res.stderr).toContain(`Move the path that contains "${span}"`)
      expect(res.stderr).toContain(`then run 'token-goat install ${flag}' again`)
      // The command it refused is the form that install would have written.
      expect(res.stderr.includes(WIN ? 'tg-hook.exe' : 'tg-hook')).toBe(native === '1' && NATIVE)
      expect(fs.existsSync(file(sb)), 'a hook config was written').toBe(false)
    }
  }

  // HAND-DERIVED paths. Grok substitutes `$NAME` in a hook command itself, with no escape and whatever the quoting (grok-build xai-grok-hooks env_expand.rs `iter_env_var_references`), and refuses to run one naming an unset variable (runner/command.rs `find_unresolved_env_vars`).
  it('Grok CLI: a path holding $NAME, in the native and the Node form', () => {
    refuses('tg $y', '--grok', '$y', CONFIG_FILE.grok)
  }, 120_000)

  // cmd.exe expands `%NAME%` in its first parsing phase, before it reads a quote, and Kimi Code runs a hook with Node's `spawn(command, { shell: true })`, which is cmd.exe on Windows.
  it.runIf(WIN)('Kimi Code on Windows: a path holding %NAME%, in the native and the Node form', () => {
    refuses('tg %x%', '--kimi', '%x%', CONFIG_FILE.kimi)
  }, 120_000)
})

describe.runIf(NATIVE)('doctor on a build whose native hook client is stale, broken or absent', () => {
  /** A binary that starts and exits 1 whatever it is asked, standing in for a native hook client that fails its self-test. CAPTURE: `C:\Windows\System32\where.exe --selftest` prints "INFO: Could not find files for the given pattern(s)." and exits 1 (Windows 11 26200); `/bin/false` exits 1 whatever its arguments (POSIX `false`). */
  const FAILING_BINARY = WIN ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe') : '/bin/false'
  const TARGET = `${process.platform}-${process.arch}`

  /** A sandbox whose package is a real copy of the built one (dist and package.json, with node_modules linked back to this repository), so its native binary can be changed without touching the repository's. */
  function copiedSandbox(dirName: string): Sandbox {
    const sb = makeSandbox(dirName)
    if (WIN) fs.rmdirSync(sb.link)
    else fs.unlinkSync(sb.link)
    const pkg = path.join(sb.home, 'pkg')
    fs.mkdirSync(pkg)
    fs.cpSync(path.join(ROOT, 'dist'), path.join(pkg, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'))
    sb.link = path.join(pkg, 'node_modules')
    fs.symlinkSync(path.join(ROOT, 'node_modules'), sb.link, WIN ? 'junction' : 'dir')
    return sb
  }

  /** Puts `src`'s bytes at `file`, moving the old file aside first: a rename takes effect even while a scanner still holds the file open after the last self-test ran it. */
  function replace(file: string, src: string): void {
    fs.renameSync(file, `${file}.${String(Date.now())}.old`)
    fs.copyFileSync(src, file)
  }

  it('reports a stale copy, a binary that fails its self-test and a build without one, and install moves the entries to what it reports', () => {
    const sb = copiedSandbox('tg native build')
    const packaged = path.join(sb.home, 'pkg', 'dist', 'native', TARGET, WIN ? 'tg-hook.exe' : 'tg-hook')
    const good = path.join(sb.root, 'tg-hook.good')
    fs.copyFileSync(packaged, good)
    const run = 'token-goat install --codex'
    const row = (): { status: string; message: string } => {
      const r = doctorRows(sb).find((x) => x.name === 'Native hooks (Codex)')
      expect(r, 'no Native hooks (Codex) row').toBeDefined()
      return r!
    }
    const wiredBin = (): string | undefined => parseNativeInvocation(wordsOf(tokenGoatEntries(CONFIG_FILE.codex(sb))[0]!, SPLIT.codex))?.bin

    install(sb, ['--codex'])
    const bin = wiredBin()
    expect(bin, 'the native form was not written').toBeDefined()
    expect(row().status).toBe('ok')

    if (WIN) {
      // An upgrade ships different bytes, and the entries still run the data-directory copy of the old ones.
      fs.appendFileSync(packaged, Buffer.from('a later build'))
      const stale = row()
      expect(stale.status, stale.message).toBe('warn')
      expect(stale.message).toContain(`self-test passed, but the copy differs from this build's binary; run '${run}' to refresh it`)
      install(sb, ['--codex'])
      expect(fs.readFileSync(bin!).equals(fs.readFileSync(packaged))).toBe(true)
      expect(row().status).toBe('ok')
      replace(packaged, good)
      install(sb, ['--codex'])
      expect(row().status).toBe('ok')
    }

    // The binary the entries run fails its self-test.
    replace(bin!, FAILING_BINARY)
    const broken = row()
    expect(broken.status, broken.message).toBe('fail')
    expect(broken.message).toContain(`the native hook client at ${bin!} fails its self-test (exit code 1); run '${run}' to rewrite the entries as Node commands`)

    // The binary this build ships fails its self-test: install writes the Node form and doctor says why.
    replace(packaged, FAILING_BINARY)
    install(sb, ['--codex'])
    expect(wiredBin()).toBeUndefined()
    const failing = row()
    expect(failing.status, failing.message).toBe('warn')
    expect(failing.message).toMatch(/^Node form; this build's native hook client fails its self-test \(exit code 1\); last 7 days/)
    replace(packaged, good)
    install(sb, ['--codex'])
    expect(wiredBin()).toBe(bin)
    expect(row().status).toBe('ok')

    // A build that ships no native binary for this machine.
    const nativeDir = path.dirname(path.dirname(packaged))
    fs.renameSync(nativeDir, `${nativeDir}.gone`)
    const absent = row()
    if (WIN) {
      // The entries run the data-directory copy, which still works.
      expect(absent.status, absent.message).toBe('warn')
      expect(absent.message).toContain(`self-test passed, but this build ships no native hook client for ${TARGET}; run '${run}' to switch to the Node form`)
    } else {
      // The entries ran the packaged binary itself, which has gone with it.
      expect(absent.status, absent.message).toBe('fail')
      expect(absent.message).toContain('which no longer exists')
    }
    install(sb, ['--codex'])
    expect(wiredBin()).toBeUndefined()
    const node = row()
    expect(node.status, node.message).toBe('ok')
    expect(node.message.startsWith(`Node form; this build ships no native hook client for ${TARGET}; last 7 days`), node.message).toBe(true)
  }, 300_000)
})
