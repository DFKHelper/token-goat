/** The native hook client as the installers wire it, driven end to end. Each harness gets a sandbox home whose path holds a space, `%x%`, `$y`, single quotes and a non-ASCII letter, and a directory link to this repository inside it, so the bundle entry, the shim and (on Windows) the data-directory copy of tg-hook all sit under that path. The built bundle installs through the link with the shipping default (TOKEN_GOAT_NATIVE_HOOKS unset), then every command it wrote is run the way that harness runs it, against a real hook server started from the built bundle, and must be served (the slot's `served` counter moves by one), answer exactly what the wrapped Node command answers on its own, and fall back to that command when the server is off. The same sandboxes then switch every event to the Node form and back, uninstall, and read `doctor`. Provenance of each harness's shell, FORMAT-DERIVED from the harness's own source: - Claude Code: exec form is spawned directly; string form runs through Git Bash on Windows (it refuses to run hooks without it) and /bin/sh elsewhere (the claude binary's hook runner, strings read out of claude.exe). - Codex: codex-rs/hooks/src/engine/command_runner.rs `build_command` with the session shell's `derive_exec_args`: `powershell -NoProfile -Command <cmd>` on Windows, `<shell> -c <cmd>` elsewhere. - Grok: xai-grok-hooks/src/runner/command.rs (`sh -c` off Windows) and xai-grok-config/src/shell.rs `shell_command_argv` (pwsh, then powershell.exe, with `-NoProfile -NonInteractive -Command`). - Kimi Code: Node `spawn(command, { shell: true })`. - Copilot CLI / VS Code: microsoft/vscode extensions/copilot/src/platform/chat/node/hookExecutor.ts `getShellCommand` (`powershell.exe -ExecutionPolicy Bypass -NoProfile -NoLogo -Command` on Windows) and hookSchema.ts (`bash` field off Windows); the `command` field is what `doctor` launches with `shell: true`. Payloads come from tests/fixtures/harness_hook_payloads.ts, which carries its own per-case provenance. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse as parseToml } from 'smol-toml'
import { expect } from 'vitest'

import { dataDirForHome } from '../../src/constants.js'
import { endpointFor, readServerKey, type ServerStatus } from '../../src/hook_ipc.js'
import { parseNativeInvocation, splitHookCommand, type HookShell } from '../../src/native_hook.js'
import { killProcessTree } from '../../src/process_tree.js'
import Database from '../../src/sqlite_driver.js'
import { HARNESS_HOOK_PAYLOADS, type HookPayloadCase, type PayloadHarness } from '../fixtures/harness_hook_payloads.js'
import { ROOT } from './bundle.js'
import { HARNESS_DETECTION_ENV_KEYS } from './harness-env.js'
import { slotStatus, waitIdle } from './hook_server_probe.js'

export type Env = Record<string, string>
export const WIN = process.platform === 'win32'
/** Platforms this build ships a native hook client for (native_hook.ts NATIVE_TARGETS); elsewhere, macOS, every installer writes the Node form, so there is no native form to drive. */
export const NATIVE = WIN || process.platform === 'linux'
/** Every character class that has broken a generated hook command line in some shell: a space, cmd's `%NAME%`, POSIX and PowerShell `$name`, a single quote, and a non-ASCII letter. `x` and `y` are removed from the environment, so neither expands. */
export const SPECIAL = `tg %x% $y 'q' é`
/** Grok expands `$VAR` in a hook command itself when it loads the config and refuses to run one naming an unset variable (xai-grok-hooks env_expand.rs `find_unresolved_env_vars`), whatever the quoting, so its sandbox leaves the dollar out. */
export const SPECIAL_NO_DOLLAR = `tg %x% 'q' é`
/** Kimi Code runs a hook through cmd.exe on Windows, where install refuses a path holding a `%NAME%` pair (cmd expands one before it reads a quote), so its Windows sandbox leaves the percent pair out. */
export const SPECIAL_NO_PERCENT = `tg $y 'q' é`
export const specialFor = (harness: PayloadHarness): string => (harness === 'grok' ? SPECIAL_NO_DOLLAR : harness === 'kimi' && WIN ? SPECIAL_NO_PERCENT : SPECIAL)

export interface Entry {
  /** Absent on a Copilot CLI entry, which names its command in the bash and powershell fields. */
  command?: string
  exec?: string
  args?: string[]
  bash?: string
  powershell?: string
}

export interface Sandbox {
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
  /** Hook clients launch spawned, kept by handle for stopServer to end. */
  children: ChildProcess[]
}

export const sandboxes: Sandbox[] = []
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function makeSandbox(dirName: string): Sandbox {
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
  const sb: Sandbox = { root, home, link, proj, dataDir, entry: path.join(link, 'dist', 'token-goat.mjs'), env, pids: new Set(), children: [] }
  sandboxes.push(sb)
  return sb
}

/** Kill bound for one CLI run; the refusal rows share it with the spawnSync path in cli(). */
export const CLI_TIMEOUT_MS = 180_000

export function cli(sb: Sandbox, args: string[], env: Env = {}, cwd: string = sb.home): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [sb.entry, ...args], { cwd, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** The notice install prints when it wrote the Node form because the native client's copy was held or its self-test got no answer (FORMAT-DERIVED from src/native_hook.ts: the emitErr in nativeHookBinary, COPY_FAILED, nativeSelftest, TRANSIENT_WHY): the two causes a starved machine produces and a second run does not repeat. A binary that ran and failed prints a different reason and is not matched. */
export const TRANSIENT_NATIVE_FALLBACK = /wrote the Node form of the hooks, not the native hook client, because (its copy could not be put in place|its self-test failed: no answer within)/

/** Install, and return what install printed on stderr. Install already tries the copy and the self-test twice in one process; on a machine starved enough that both attempts time out (the self-test's 5 s budget is production's and stays), the notice it prints says to install again, so this does, up to twice more, and only while that notice is the reason. Any other outcome, including the same notice after the last try, is left for the caller's assertions to fail on. */
export function install(sb: Sandbox, flags: string[], env: Env = {}, cwd?: string): string {
  let res = cli(sb, ['install', '--dev', ...flags], env, cwd)
  for (let again = 0; again < 2 && res.status === 0 && TRANSIENT_NATIVE_FALLBACK.test(res.stderr); again++) res = cli(sb, ['install', '--dev', ...flags], env, cwd)
  expect(res.status, `install ${flags.join(' ')}: ${res.stderr}${res.stdout}`).toBe(0)
  return res.stderr
}

export async function startServer(sb: Sandbox): Promise<void> {
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

/** Every shell-command or direct-exec hook entry under `value`. */
export function entriesIn(value: unknown, out: Entry[] = []): Entry[] {
  if (Array.isArray(value)) for (const v of value) entriesIn(v, out)
  else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const named = ['command', 'exec', 'bash', 'powershell'].some((k) => typeof o[k] === 'string')
    if (named) out.push(o as unknown as Entry)
    else for (const v of Object.values(o)) entriesIn(v, out)
  }
  return out
}

/** token-goat's own hook entries in a harness config, or none when the file is gone. */
export function tokenGoatEntries(file: string): Entry[] {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const parsed = (file.endsWith('.json') ? JSON.parse(text) : parseToml(text)) as Record<string, unknown>
  return entriesIn(parsed['hooks']).filter((e) => {
    const own = e.exec ?? e.command ?? (WIN ? e.powershell : e.bash)
    return [own, ...(e.args ?? [])].join(' ').includes('token-goat-shim')
  })
}

export function wordsOf(e: Entry, shell: HookShell): string[] {
  if (e.exec !== undefined) return [e.exec, ...(e.args ?? [])]
  if (e.command === undefined) return splitHookCommand((WIN ? e.powershell : e.bash) ?? '', shell)
  return e.args !== undefined && e.args.length > 0 ? [e.command, ...e.args] : splitHookCommand(e.command, shell)
}

/** The event argument the entry runs the shim with: the word after the shim path. */
export function eventOf(words: readonly string[]): string {
  const i = words.findIndex((w) => /token-goat-shim\.cjs$/.test(w))
  return words[i + 1] ?? ''
}

export function substitute(text: string, sb: Sandbox, sid: string): string {
  const esc = (s: string): string => JSON.stringify(s).slice(1, -1)
  return text.replaceAll('{{PROJ}}', () => esc(sb.proj)).replaceAll('{{SID}}', () => esc(sid))
}

export interface Run {
  stdout: string
  stderr: string
  exit: number | null
}

/** How a harness launches one command line. */
export interface Launch {
  file: string
  args: string[]
  shell?: string | boolean
}

export function launch(l: Launch, c: HookPayloadCase, sb: Sandbox, sid: string, env: Env): Promise<Run> {
  const caseEnv: Env = {}
  for (const [k, v] of Object.entries(c.env ?? {})) caseEnv[k] = substitute(v, sb, sid)
  return new Promise((resolve, reject) => {
    const child = spawn(l.file, l.args, { cwd: sb.proj, env: { ...sb.env, ...caseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(l.shell === undefined ? {} : { shell: l.shell }) })
    sb.children.push(child)
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (exit) => resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, exit }))
    // A client that stopped reading stdin early would fail this write with EPIPE; that is not what these cases test.
    child.stdin.on('error', () => undefined)
    child.stdin.end(substitute(c.raw ?? JSON.stringify(c.payload), sb, sid))
  })
}

export function whereOnWindows(name: string): string | undefined {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() : undefined
}

/** Git Bash, which Claude Code on Windows runs every string-form hook through. */
export function gitBash(): string {
  const candidates = [process.env['CLAUDE_CODE_GIT_BASH_PATH'], 'C:\\Program Files\\Git\\bin\\bash.exe']
  const git = whereOnWindows('git')
  if (git !== undefined) candidates.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'))
  const found = candidates.find((c) => c !== undefined && fs.existsSync(c))
  if (found === undefined) throw new Error('Git Bash not found; Claude Code on Windows cannot run string-form hooks without it either')
  return found
}

export const sh = (cmd: string): Launch => ({ file: '/bin/sh', args: ['-c', cmd] })
export const nodeShell = (cmd: string): Launch => ({ file: cmd, args: [], shell: true })
export const powershell = (exe: string, pre: string[]) => (cmd: string): Launch => ({ file: exe, args: [...pre, cmd] })

export interface Way {
  /** What the row asserts about, e.g. `powershell field via VS Code`. */
  label: string
  /** Which field of the entry this way runs. */
  field: 'command' | 'bash' | 'powershell' | 'exec' | 'directExec'
  /** How the harness splits that field into words, for finding the entry and its wrapped command. */
  split: HookShell
  run: (cmd: string, e: Entry) => Launch
}

/** How each harness runs a hook command on this platform. */
export function waysFor(harness: PayloadHarness, entries: readonly Entry[]): Way[] {
  const pwsh = WIN ? whereOnWindows('pwsh') : undefined
  switch (harness) {
    case 'claudecode':
      // Node form: command and args spawned directly; native form: a guarded string run through the shell.
      if (entries.some((entry) => entry.args !== undefined && entry.args.length > 0))
        return [
          {
            label: 'exec form, spawned directly',
            field: 'exec',
            split: 'sh',
            run: (_c, e) => ({ file: e.command ?? '', args: e.args ?? [] }),
          },
        ]
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
      ]
  }
}

export const INSTALL_FLAG: Record<PayloadHarness, string[]> = { claudecode: [], codex: ['--codex'], grok: ['--grok'], kimi: ['--kimi'], copilot_cli: ['--copilot'] }
export const CONFIG_FILE: Record<PayloadHarness, (sb: Sandbox) => string> = {
  claudecode: (sb) => path.join(sb.home, '.claude', 'settings.json'),
  codex: (sb) => path.join(sb.home, '.codex', 'config.toml'),
  grok: (sb) => path.join(sb.home, '.grok', 'hooks', 'token-goat.json'),
  kimi: (sb) => path.join(sb.home, '.kimi-code', 'config.toml'),
  copilot_cli: (sb) => path.join(sb.home, '.copilot', 'hooks', 'token-goat.json'),
}
/** A case per harness whose answer is not empty (token-goat redirects the command), so equal output cannot come from both sides answering nothing. */
export const CASE: Record<PayloadHarness, string> = {
  claudecode: 'Bash command token-goat redirects (block)',
  codex: 'Bash command token-goat redirects (block)',
  grok: 'run_terminal_command token-goat redirects (deny, exit 2)',
  kimi: 'Bash command token-goat redirects (deny)',
  copilot_cli: 'bash command token-goat redirects (deny)',
}

export function caseFor(harness: PayloadHarness): HookPayloadCase {
  const c = HARNESS_HOOK_PAYLOADS.find((p) => p.harness === harness && p.name === CASE[harness])
  if (c === undefined) throw new Error(`no payload case ${harness}|${CASE[harness]}`)
  return c
}

/** The written entry for `c`'s event, its invocation words, and the command that field launches. */
export function wiredFor(entries: readonly Entry[], c: HookPayloadCase, way: Way): { entry: Entry; words: string[]; cmd: string } {
  for (const entry of entries) {
    const cmd = way.field === 'exec' || way.field === 'command' ? entry.command : way.field === 'directExec' ? entry.exec : entry[way.field]
    if (typeof cmd !== 'string') continue
    const words = way.field === 'exec' || way.field === 'directExec' ? wordsOf(entry, 'sh') : splitHookCommand(cmd, way.split)
    if (eventOf(words) === c.event) return { entry, words, cmd }
  }
  throw new Error(`no ${c.event} entry for ${way.label}`)
}

/** Served, reference and fallback runs of every way `harness` launches its command, with the counts each must leave in `stats`. */
export async function driveHarness(
  sb: Sandbox,
  harness: PayloadHarness,
): Promise<{ native: number; fallback: number }> {
  const c = caseFor(harness)
  const entries = tokenGoatEntries(CONFIG_FILE[harness](sb))
  // The variable Claude Code sets in the processes it starts (tests/helpers/harness-env.ts), so its rows are recorded under its name as a real session's are; the other harnesses' shims and adapters name themselves, or the case carries the harness's own variable.
  const id: Env = harness === 'claudecode' ? { CLAUDE_CODE_SESSION_ID: 'tg-native-e2e' } : {}
  let native = 0
  let fallback = 0
  for (const way of waysFor(harness, entries)) {
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
export async function driveNodeForm(sb: Sandbox, harness: PayloadHarness): Promise<void> {
  const c = caseFor(harness)
  const entries = tokenGoatEntries(CONFIG_FILE[harness](sb))
  const id: Env = harness === 'claudecode' ? { CLAUDE_CODE_SESSION_ID: 'tg-node-e2e' } : {}
  for (const way of waysFor(harness, entries)) {
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
export function detailCounts(sb: Sandbox): Record<string, number> {
  const db = new Database(path.join(sb.dataDir, 'global.db'), { readonly: true })
  try {
    const rows = db.prepare("SELECT COALESCE(detail, 'node') AS d, COUNT(*) AS n FROM stats WHERE kind LIKE 'hook:%' GROUP BY 1").all() as Array<{ d: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.d, r.n]))
  } finally {
    db.close()
  }
}

export function forms(file: string, shell: HookShell): { native: number; node: number } {
  const entries = tokenGoatEntries(file)
  const native = entries.filter((e) => parseNativeInvocation(wordsOf(e, shell)) !== undefined).length
  return { native, node: entries.length - native }
}

/** The words doctor prints for a native hook client whose self-test got no answer inside the 5 s budget (FORMAT-DERIVED from src/native_hook.ts nativeSelftest: `no answer within ${SELFTEST_TIMEOUT_MS} ms`, the reason an ETIMEDOUT spawn gets). A starved machine produces it for a binary that would have answered, and a second run does not repeat it; a binary that ran and failed prints its exit code instead and is not matched. */
export const SELFTEST_NO_ANSWER = /no answer within \d+ ms/

export type DoctorRow = { name: string; status: string; message: string }

/** Doctor's rows, asked again (up to twice more) while a Native hooks row reports a self-test that got no answer, because that row says nothing about the binary. Any other outcome, including the same notice after the last try, is left for the caller's assertions to fail on. */
export function doctorRows(sb: Sandbox, env: Env = {}): DoctorRow[] {
  let list: DoctorRow[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = cli(sb, ['doctor', '--json'], env, sb.proj)
    const parsed = JSON.parse(res.stdout) as unknown
    list = (Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>)['checks'] ?? (parsed as Record<string, unknown>)['results'])) as DoctorRow[]
    if (!list.some((r) => r.name.startsWith('Native hooks') && SELFTEST_NO_ANSWER.test(r.message))) break
  }
  return list
}

/** Ends each still-running launched child's tree; throws once, naming each pid it could not end. */
export function endLaunched(sb: Sandbox): void {
  const failed: number[] = []
  for (const child of sb.children) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue
    const ended = killProcessTree(child.pid)
    if (ended.ok) continue
    child.kill('SIGKILL')
    if (!ended.gone) failed.push(child.pid)
  }
  if (failed.length > 0) throw new Error(`could not end the launched hook client tree of pid ${failed.join(', ')}`)
}

export function stopServer(sb: Sandbox): void {
  endLaunched(sb)
  if (sb.server === undefined) return
  cli(sb, ['hook-server', 'stop'], { TOKEN_GOAT_HOOK_SERVER: '1' })
}

export const SPLIT: Record<PayloadHarness, HookShell> = {
  claudecode: 'sh',
  codex: WIN ? 'powershell' : 'sh',
  grok: WIN ? 'powershell' : 'sh',
  kimi: WIN ? 'cmd' : 'sh',
  copilot_cli: WIN ? 'powershell' : 'sh',
}
