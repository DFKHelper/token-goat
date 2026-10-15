/** HAND-DERIVED owned-process fixtures; all stores and process IDs are isolated per test. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { nativeHookCommandLine } from '../../src/native_hook.js'
import { endpointFor, readServerKey } from '../../src/hook_ipc.js'
import { startBudgetAtShimStart } from './shim_deadline.js'
import { slotStatus } from './hook_server_probe.js'
import { buildNative } from './native_bin.js'
import { startWatchdog, type Watchdog } from './stall_proof_watchdog.js'

export const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
export const ownedRoots: string[] = []
export const ownedPids: number[] = []
const watchdogs = new Map<string, { watchdog: Watchdog; quietLimitMs: number }>()

/** The one progress watchdog of a fixture's test: created by the first watched runner, shared by every later wait in that test, and stopped by cleanupTrees. */
export function fixtureWatchdog(fixture: { root: string }, quietLimitMs: number, label: string): Watchdog {
  const existing = watchdogs.get(fixture.root)
  if (existing) {
    if (existing.quietLimitMs !== quietLimitMs) throw new Error(`watchdog for ${fixture.root} already started with a quiet limit of ${String(existing.quietLimitMs)} ms, not ${String(quietLimitMs)} ms`)
    return existing.watchdog
  }
  const watchdog = startWatchdog({ quietLimitMs, label })
  watchdogs.set(fixture.root, { watchdog, quietLimitMs })
  return watchdog
}

function watchdogOf(fixture: { root: string }): Watchdog {
  const existing = watchdogs.get(fixture.root)
  if (!existing) throw new Error(`no watchdog started for ${fixture.root}; start one with a watched runner or fixtureWatchdog first`)
  return existing.watchdog
}

export function installStartupOwner(root: string): string {
  const relative = join('native', `win32-${process.arch}`, 'tg-hook.exe')
  const destination = join(root, relative)
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'native', `win32-${process.arch}`), { recursive: true })
    // Mandatory built artifact, never a skipped test or an automatic worker build.
    copyFileSync(buildNative(), destination)
  }
  return destination
}

export function buildWindowsBoundary(root: string): string {
  const destination = join(root, 'git boundary 日本.exe')
  const compiled = spawnSync('rustc', [
    '--edition=2024', '--remap-path-prefix', `${process.cwd()}=/fixture`,
    join(process.cwd(), 'tests', 'helpers', 'session_start_boundary.rs'), '-o', destination,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  expect(compiled.status, compiled.error?.message ?? compiled.stderr).toBe(0)
  return destination
}

export function treeFixture(parent: string = tmpdir()): { root: string; project: string; env: NodeJS.ProcessEnv; shim: string } {
  const root = mkdtempSync(join(parent, 'tg-session-tree-'))
  ownedRoots.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project)
  mkdirSync(home)
  const scratch = Object.fromEntries(['user', 'tmp', 'appdata', 'claude', 'copilot', 'codex', 'xdgconfig'].map((name) => [name, join(root, 'iso', name)]))
  for (const dir of Object.values(scratch)) mkdirSync(dir, { recursive: true })
  const shim = join(root, 'shim.cjs')
  // A slow node boot must not spend the shim's budget before the shim runs; see shim_deadline.ts.
  writeFileSync(shim, startBudgetAtShimStart(COPILOT_CLI_HOOK_SCRIPT))
  installStartupOwner(root)
  return {
    root, project, shim,
    env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home,
      HOME: scratch['user'], USERPROFILE: scratch['user'], APPDATA: scratch['appdata'], XDG_CONFIG_HOME: scratch['xdgconfig'],
      CLAUDE_CONFIG_DIR: scratch['claude'], COPILOT_HOME: scratch['copilot'], CODEX_HOME: scratch['codex'], TEMP: scratch['tmp'], TMP: scratch['tmp'],
      TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0', TOKEN_GOAT_EMBED: '0' },
  }
}

/** Every pid file this fixture wrote names a process that is gone; the invariant holds whether or not the run reached its interesting step. */
export function assertTreeDead(fixture: ReturnType<typeof treeFixture>): void {
  for (const name of readdirSync(fixture.root).filter((entry) => entry.endsWith('.pid'))) {
    const pid = Number(readFileSync(join(fixture.root, name), 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!ownedPids.includes(pid)) ownedPids.push(pid)
    expect(alive(pid), `${name} names pid ${String(pid)}, which survived the run`).toBe(false)
  }
}

/** Resolves when `path` exists, by directory watch rather than a clock; the caller races it against the process closing. */
export function fileAppears(path: string, watchdog?: Watchdog): { appeared: Promise<void>; stop: () => void } {
  let watcher: ReturnType<typeof watch> | undefined
  const appeared = new Promise<void>((resolve) => {
    const found = (): void => { watchdog?.progress(`file appeared: ${path}`); resolve() }
    watcher = watch(dirname(path), () => { if (existsSync(path)) found() })
    if (existsSync(path)) found()
  })
  return { appeared, stop: () => watcher?.close() }
}

const OWED_REMINDER_PHRASE = 'must outlive a compaction'

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into)
  return into
}

/** The text a hook's JSON stdout carries, with JSON escaping removed; `{}` and non-JSON yield an empty string. */
export function contextText(stdout: string): string {
  try { return collectStrings(JSON.parse(stdout), []).join('\n') } catch { return '' }
}

export function reminderCount(stdout: string): number {
  return contextText(stdout).split(OWED_REMINDER_PHRASE).length - 1
}

/** The first post_tool_use of a session on a host whose start may be deferred: the shipping bundle, isolated, no worker. */
export function runOwedToolCall(fixture: ReturnType<typeof treeFixture>, harness: 'copilot_cli' | 'vscode', sessionId: string): Promise<string> {
  const watchdog = watchdogOf(fixture)
  const exited = new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      cwd: fixture.project, windowsHide: true, stdio: 'pipe',
      env: { ...fixture.env, TOKEN_GOAT_HARNESS_OVERRIDE: harness, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0' },
    })
    if (child.pid !== undefined) ownedPids.push(child.pid)
    let stdout = ''
    let stderr = ''
    watchdog.progress('post_tool_use spawned')
    child.stdout.on('data', (chunk: Buffer) => { watchdog.progress('post_tool_use stdout'); stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { watchdog.progress('post_tool_use stderr'); stderr += chunk.toString() })
    child.stdin.on('error', () => undefined)
    child.once('error', reject)
    child.once('close', (code) => { watchdog.progress('post_tool_use closed'); if (code === 0) resolve(stdout); else reject(new Error(`post_tool_use exited ${String(code)}: ${stderr}`)) })
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: fixture.project, hook_event_name: 'PostToolUse', tool_name: 'TgDeferredProbe', tool_input: {}, tool_response: { output: 'raw' } }))
  })
  return Promise.race([exited, watchdog.failed])
}

/** Whether the shim read this session's payload and stamped the start as begun; HAND-DERIVED from the sidecar name (session id with non-word characters replaced, cut to 64) the shim and src/session_store.ts both write. A start cut off before its payload was read has no id to stamp, so by the begun-start contract it owes nothing. */
export function startBegan(fixture: ReturnType<typeof treeFixture>, sessionId: string): boolean {
  const home = fixture.env['TOKEN_GOAT_HOME'] as string
  return existsSync(join(home, 'sessions', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}.session-start`))
}

/** The owed path for a start that failed open: when the shim had read the payload, two concurrent first tool calls carry the reminder exactly once between them and the stdout that carried it is returned; when it had not, nothing is owed, no call may carry the reminder, and null is returned. */
export async function assertOwedDeliveredOnce(fixture: ReturnType<typeof treeFixture>, harness: 'copilot_cli' | 'vscode', sessionId: string): Promise<string | null> {
  const began = startBegan(fixture, sessionId)
  const calls = await Promise.all([runOwedToolCall(fixture, harness, sessionId), runOwedToolCall(fixture, harness, sessionId)])
  expect(calls.reduce((sum, call) => sum + reminderCount(call), 0), `tool calls after a missed start (begun=${String(began)}): ${calls.join(' --- ')}`).toBe(began ? 1 : 0)
  return began ? calls.find((call) => reminderCount(call) === 1) as string : null
}

/** What a start that machine load pushed past its own deadline prints on stderr instead of the refusal a row provokes. */
export const DEADLINE_FAIL_OPEN = /overall deadline exceeded|insufficient time for process-tree cleanup|timed out/

/** The two outcomes of a row whose premise (the helper reached its interesting step) load can pre-empt, both asserted and the branch recorded with ctx.annotate. Returns true when the premise files exist (strong branch: the caller runs its full assertions). Otherwise the weak branch is asserted here and false is returned: exactly `{}` on stdout, a deadline fail-open on stderr, every owned pid dead, and the owed path delivering once if the start began. */
export async function premiseBranch(
  context: { annotate: (message: string) => Promise<unknown> }, fixture: ReturnType<typeof treeFixture>,
  result: { stdout: string; stderr: string }, premise: string[], sessionId: string,
): Promise<boolean> {
  if (premise.every((path) => existsSync(path))) {
    await context.annotate('branch: strong (premise reached)')
    return true
  }
  await context.annotate('branch: weak (deadline fired before the premise)')
  expect(result.stdout, `premise ${premise.join(', ')} was not reached and the start did not fail open`).toBe('{}')
  expect(result.stderr, 'premise not reached without a deadline fail-open').toMatch(DEADLINE_FAIL_OPEN)
  assertTreeDead(fixture)
  await assertOwedDeliveredOnce(fixture, 'copilot_cli', sessionId)
  return false
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readOwnedPid(path: string): number {
  const pid = Number(readFileSync(path, 'utf8'))
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  ownedPids.push(pid)
  return pid
}

function removeWhenReleased(root: string): void {
  const deadline = Date.now() + 15_000
  for (;;) {
    try { return rmSync(root, { recursive: true, force: true }) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

export function cleanupTrees(): void {
  for (const { watchdog } of watchdogs.values()) watchdog.stop()
  watchdogs.clear()
  // Also recover PIDs if an observation rejected before the assertion registered them. Only this fixture's own root-level PID files are considered.
  for (const root of ownedRoots) {
    for (const name of readdirSync(root).filter((name) => name.endsWith('.pid'))) {
      const pid = Number(readFileSync(join(root, name), 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && !ownedPids.includes(pid)) ownedPids.push(pid)
    }
  }
  const table = listProcesses()
  const victims = new Map<number, string>()
  const walk = (pid: number): void => {
    if (victims.has(pid)) return
    victims.set(pid, table.get(pid)?.args ?? '')
    for (const [child, entry] of table) if (entry.ppid === pid) walk(child)
  }
  for (const pid of ownedPids.splice(0).reverse()) if (alive(pid)) walk(pid)
  killAndVerify(victims)
  // Sweep what the fixture started that no recorded pid reaches, such as an owner that outlived its dead parent.
  const roots = ownedRoots.map((root) => root.toLowerCase().replaceAll('/', '\\'))
  const strays = new Map<number, string>()
  for (const [pid, entry] of listProcesses()) {
    if (pid !== process.pid && roots.some((root) => entry.args.toLowerCase().replaceAll('/', '\\').includes(root))) strays.set(pid, entry.args)
  }
  killAndVerify(strays)
  // The delete retry covers handle rundown only (12-25 ms measured on a quiet machine); the long EPERM locks came from a time-boxed taskkill that left the worker alive and from an owner orphaned outside the kill list.
  for (const root of ownedRoots.splice(0)) removeWhenReleased(root)
}

function listProcesses(): Map<number, { ppid: number; args: string }> {
  const win = process.platform === 'win32'
  const listing = win
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.ParentProcessId + [char]9 + $_.CommandLine }'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listing.status !== 0) throw new Error(`process listing failed: ${listing.error?.message ?? listing.stderr}`)
  const table = new Map<number, { ppid: number; args: string }>()
  for (const line of listing.stdout.split(/\r?\n/)) {
    const match = win ? /^(\d+)\t(\d+)\t(.*)$/.exec(line) : /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] })
  }
  return table
}

// TerminateProcess/SIGKILL, never a time-boxed taskkill; ESRCH means already dead. A target that stays alive is a defect, reported with its command line.
function killAndVerify(victims: Map<number, string>): void {
  for (const pid of victims.keys()) {
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const gone = Date.now() + 5000
  while ([...victims.keys()].some(alive) && Date.now() < gone) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  const survivors = [...victims].filter(([pid]) => alive(pid)).map(([pid, args]) => `${pid} ${args}`)
  if (survivors.length > 0) throw new Error(`fixture process still alive 5 s after SIGKILL: ${survivors.join('; ')}`)
}

export function indexTreeFixture(fixture: ReturnType<typeof treeFixture>): void {
  writeFileSync(join(fixture.project, 'example.ts'), 'export function ownedExample() { return 1 }\n')
  for (const args of [['init', '-q'], ['add', 'example.ts']]) {
    const result = spawnSync('git', args, { cwd: fixture.project, encoding: 'utf8', windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
  }
  // Prints nothing until it exits, so no limit is set here: the test's own timeout is the hang backstop.
  const index = spawnSync(process.execPath, [BUNDLE, 'index', '.'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true,
  })
  expect(index.status, index.stderr).toBe(0)
}

export function runTreeShim(options: {
  fixture: ReturnType<typeof treeFixture>; entry: string; quietLimitMs: number; delayMs?: number; payload?: Record<string, unknown>; endInput?: boolean; deadline?: number; nodeArgs?: string[]
}): { child: ChildProcessWithoutNullStreams; done: Promise<{ stdout: string; stderr: string; elapsed: number }> } {
  const { fixture, entry } = options
  const watchdog = fixtureWatchdog(fixture, options.quietLimitMs, 'tree shim')
  const started = performance.now()
  const deadlineArgs = options.deadline === undefined ? [] : [`--session-start-deadline=${String(options.deadline)}`]
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), fixture.shim, 'sessionStart', entry, ...deadlineArgs], {
    cwd: fixture.project, env: fixture.env, stdio: 'pipe', windowsHide: true,
  })
  if (child.pid !== undefined) ownedPids.push(child.pid)
  child.stdin.on('error', () => undefined)
  let stdout = ''
  let stderr = ''
  let inputTimer: ReturnType<typeof setTimeout> | undefined
  child.stdout.on('data', (chunk: Buffer) => { watchdog.progress('child stdout'); stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { watchdog.progress('child stderr'); stderr += chunk.toString() })
  child.once('spawn', () => watchdog.progress('child spawned'))
  const closed = new Promise<{ stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(inputTimer); reject(error) })
    child.once('close', (code) => {
      watchdog.progress('child closed')
      clearTimeout(inputTimer)
      if (code !== 0) reject(new Error(`shim exited ${String(code)}: ${stderr}`))
      else resolve({ stdout, stderr, elapsed: performance.now() - started })
    })
  })
  const done = Promise.race([closed, watchdog.failed])
  const send = (): void => {
    watchdog.progress('input sent')
    const input = JSON.stringify(options.payload ?? { sessionId: 'owned-tree', workingDirectory: fixture.project })
    if (options.endInput === false) child.stdin.write(input)
    else child.stdin.end(input)
  }
  if (options.delayMs) inputTimer = setTimeout(send, options.delayMs)
  else send()
  return { child, done }
}

/** Use the shipping installer's native command and shell quoting. */
export function runInstalledStartup(options: {
  fixture: ReturnType<typeof treeFixture>; entry: string; payload?: Record<string, unknown>
  shell?: 'cmd' | 'powershell'; alias?: boolean; input?: string; delayMs?: number
  endInput?: boolean; event?: 'sessionStart' | 'preToolUse'; quietLimitMs: number
}): ReturnType<typeof runTreeShim> {
  const { fixture, entry } = options
  const previousEntry = process.argv[1]
  const previousNative = process.env['TOKEN_GOAT_NATIVE_HOOKS']
  let command: string
  try {
    process.argv[1] = entry
    process.env['TOKEN_GOAT_NATIVE_HOOKS'] = '1'
    // The installer's own command builders around the built client, not its decision to wire the client in: that decision runs `tg-hook --selftest` on a 5 s budget a starved machine misses (install then writes the Node form and says so), and native_hook_install_e2e and native_hook_fallback own it.
    const built = nativeHookCommandLine(options.shell === 'powershell' ? 'powershell' : 'cmd', buildNative(), 'copilot_cli', fixture.shim, options.event ?? 'sessionStart')
    if (built === undefined) throw new Error('native command unavailable')
    command = built
    expect(command).toContain('tg-hook.exe')
    if (options.alias) {
      const alias = nativeHookCommandLine('cmd', installStartupOwner(fixture.root), 'copilot_cli', fixture.shim, 'SessionStart', entry)
      if (alias === undefined) throw new Error('native alias command unavailable')
      command = alias
    }
  } finally {
    process.argv[1] = previousEntry
    if (previousNative === undefined) delete process.env['TOKEN_GOAT_NATIVE_HOOKS']
    else process.env['TOKEN_GOAT_NATIVE_HOOKS'] = previousNative
  }
  const watchdog = fixtureWatchdog(fixture, options.quietLimitMs, 'installed startup')
  const started = performance.now()
  const child = options.shell === 'powershell'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: fixture.project, env: fixture.env, stdio: 'pipe', windowsHide: true,
    })
    : spawn(command, {
      shell: true, cwd: fixture.project, env: fixture.env, stdio: 'pipe', windowsHide: true,
    })
  if (child.pid !== undefined) ownedPids.push(child.pid)
  child.stdin.on('error', () => undefined)
  let stdout = ''
  let stderr = ''
  let inputTimer: ReturnType<typeof setTimeout> | undefined
  child.stdout.on('data', (chunk: Buffer) => { watchdog.progress('child stdout'); stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { watchdog.progress('child stderr'); stderr += chunk.toString() })
  child.once('spawn', () => watchdog.progress('child spawned'))
  const closed = new Promise<{ stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    child.once('error', error => { clearTimeout(inputTimer); reject(error) })
    child.once('close', code => {
      watchdog.progress('child closed')
      clearTimeout(inputTimer)
      child.stdin.destroy()
      if (code !== 0) reject(new Error(`installed startup exited ${String(code)}: ${stderr}`))
      else resolve({ stdout, stderr, elapsed: performance.now() - started })
    })
  })
  const done = Promise.race([closed, watchdog.failed])
  const send = (): void => {
    watchdog.progress('input sent')
    const input = options.input ?? JSON.stringify(options.payload ?? {
      sessionId: 'installed-startup', workingDirectory: fixture.project,
    })
    if (options.endInput) child.stdin.end(input)
    else child.stdin.write(input)
  }
  if (options.delayMs) inputTimer = setTimeout(send, options.delayMs)
  else send()
  return { child, done }
}

export async function assertInstalledResidentBypass(fixture: ReturnType<typeof treeFixture>, quietLimitMs: number): Promise<void> {
  const watchdog = fixtureWatchdog(fixture, quietLimitMs, 'resident bypass')
  fixture.env['TOKEN_GOAT_HOOK_SERVER'] = '1'
  const server = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], {
    cwd: fixture.project, env: fixture.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  if (server.pid !== undefined) ownedPids.push(server.pid)
  let diagnostics = ''
  server.stderr?.on('data', (chunk: Buffer) => { watchdog.progress('resident stderr'); diagnostics += chunk.toString() })
  const data = join(fixture.root, 'home', 'dfk-helper', 'token-goat')
  const endpoint = endpointFor(0, data, dirname(BUNDLE))
  let key: Buffer | undefined
  for (;;) {
    key = readServerKey(data)
    if (key && await slotStatus(endpoint, key)) break
    if (server.exitCode !== null) throw new Error(`resident did not start: ${diagnostics}`)
    await Promise.race([new Promise(resolve => setTimeout(resolve, 20)), watchdog.failed])
  }
  watchdog.progress('resident answered')
  const residentKey: Buffer = key
  // A resident that is busy answers a status request when it comes free, not within a fixed time: ask again, under the watchdog, until it answers.
  const answeredStatus = async (): Promise<NonNullable<Awaited<ReturnType<typeof slotStatus>>>> => {
    for (;;) {
      const status = await slotStatus(endpoint, residentKey)
      if (status) return status
      await Promise.race([new Promise(resolve => setTimeout(resolve, 20)), watchdog.failed])
    }
  }
  const initial = await answeredStatus()
  const ordinary = await runInstalledStartup({
    fixture, entry: BUNDLE, event: 'preToolUse', endInput: true, quietLimitMs,
    payload: { sessionId: 'ordinary-positive-control', workingDirectory: fixture.project, toolName: 'view', toolArgs: { path: 'example.ts' } },
  }).done
  expect(ordinary.stderr).toBe('')
  const before = await answeredStatus()
  expect(before.served).toBe(initial.served + 1)
  // The start runs a helper that never answers until released (it sits beside the bundle, where the shim looks for the native owner), so the 3 s budget ends the start on every machine: the outcome is the same fail-open, the resident serves nothing, and the context owed is delivered by the first tool call. The release file is written when the clients have exited, so no process outlives the case.
  const stubs: string[] = []
  try {
    for (const endInput of [false, true]) {
      // One stub per start, each with its own release file, so the stub that sees its file can delete it without stranding a second stub waiting on the same one. Provenance: HAND-DERIVED, a script written for this case: it records its pid, polls for its release file, deletes it and exits.
      const stub = join(dirname(BUNDLE), `resident-bypass-stub-${String(process.pid)}-${String(endInput)}.cjs`)
      stubs.push(stub)
      writeFileSync(stub, `const fs = require('node:fs')\nconst f = __filename + '.release'\nfs.writeFileSync(__filename + '.pid', String(process.pid))\nsetInterval(() => { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); process.exit(0) } }, 50)\n`)
      const startup = await runInstalledStartup({ fixture, entry: stub, endInput, quietLimitMs }).done
      expect(startup.stdout).toBe('{}')
      expect(startup.stderr).toContain('SessionStart failed open: ')
      expect((await answeredStatus()).served, 'startup was served by the resident').toBe(before.served)
      await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'installed-startup')
    }
  } finally {
    for (const stub of stubs) {
      // The owner usually kills the stub with the rest of the helper tree; one still alive is released and waited for, and either way the files it leaves beside the bundle are removed.
      let pid: number | undefined
      try { pid = Number(readFileSync(`${stub}.pid`, 'utf8')) } catch { /* the stub never ran */ }
      if (pid !== undefined && Number.isInteger(pid) && pid > 0 && alive(pid)) {
        writeFileSync(`${stub}.release`, 'released')
        while (alive(pid)) await Promise.race([new Promise(resolve => setTimeout(resolve, 20)), watchdog.failed])
      }
      rmSync(`${stub}.release`, { force: true })
      rmSync(`${stub}.pid`, { force: true })
      unlinkSync(stub)
    }
  }
  // Prints nothing until it exits and waits for a busy slot on its own, so no limit is set here: the test's own timeout is the hang backstop.
  const stopped = spawnSync(process.execPath, [BUNDLE, 'hook-server', 'stop'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true,
  })
  expect(stopped.status, stopped.stderr).toBe(0)
}
