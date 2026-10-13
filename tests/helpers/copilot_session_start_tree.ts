/** HAND-DERIVED owned-process fixtures; all stores and process IDs are isolated per test. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { copilotHookCommandsFor } from '../../src/bridges/copilot_cli_install.js'
import { nativeHookCommandLine } from '../../src/native_hook.js'
import { endpointFor, readServerKey } from '../../src/hook_ipc.js'
import { slotStatus } from './hook_server_probe.js'
import { buildNative } from './native_bin.js'

export const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
export const ownedRoots: string[] = []
export const ownedPids: number[] = []

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
  writeFileSync(shim, COPILOT_CLI_HOOK_SCRIPT)
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
export function fileAppears(path: string): { appeared: Promise<void>; stop: () => void } {
  let watcher: ReturnType<typeof watch> | undefined
  const appeared = new Promise<void>((resolve) => {
    watcher = watch(dirname(path), () => { if (existsSync(path)) resolve() })
    if (existsSync(path)) resolve()
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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      cwd: fixture.project, windowsHide: true, stdio: 'pipe',
      env: { ...fixture.env, TOKEN_GOAT_HARNESS_OVERRIDE: harness, TOKEN_GOAT_NO_WORKER_SPAWN: '1' },
    })
    if (child.pid !== undefined) ownedPids.push(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.on('error', () => undefined)
    child.once('error', reject)
    child.once('close', (code) => { if (code === 0) resolve(stdout); else reject(new Error(`post_tool_use exited ${String(code)}: ${stderr}`)) })
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: fixture.project, hook_event_name: 'PostToolUse', tool_name: 'TgDeferredProbe', tool_input: {}, tool_response: { output: 'raw' } }))
  })
}

/** The owed path for a start that failed open: the first tool call carries the reminder once and the next carries none. Returns the first call's stdout. */
export async function assertOwedDeliveredOnce(fixture: ReturnType<typeof treeFixture>, harness: 'copilot_cli' | 'vscode', sessionId: string): Promise<string> {
  const first = await runOwedToolCall(fixture, harness, sessionId)
  expect(reminderCount(first), `first tool call after a missed start: ${first}`).toBe(1)
  const second = await runOwedToolCall(fixture, harness, sessionId)
  expect(reminderCount(second), `second tool call: ${second}`).toBe(0)
  return first
}

/** A hung-helper test whose premise files may not exist if the startup deadline fired first: that is a skip only when the start failed open with exactly `{}` and the owed path delivers for this session. */
export async function skipUnlessPremiseReached(
  context: { skip: () => never }, fixture: ReturnType<typeof treeFixture>,
  result: { stdout: string }, premise: string[], sessionId: string,
): Promise<void> {
  if (premise.every((path) => existsSync(path))) return
  expect(result.stdout, `premise ${premise.join(', ')} was not reached and the start did not fail open`).toBe('{}')
  await assertOwedDeliveredOnce(fixture, 'copilot_cli', sessionId)
  context.skip()
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
  const index = spawnSync(process.execPath, [BUNDLE, 'index', '.'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  })
  expect(index.status, index.stderr).toBe(0)
}

export function runTreeShim(options: {
  fixture: ReturnType<typeof treeFixture>; entry: string; delayMs?: number; payload?: Record<string, unknown>; endInput?: boolean; deadline?: number
}): { child: ChildProcessWithoutNullStreams; done: Promise<{ stdout: string; stderr: string; elapsed: number }> } {
  const { fixture, entry } = options
  const started = performance.now()
  const deadlineArgs = options.deadline === undefined ? [] : [`--session-start-deadline=${String(options.deadline)}`]
  const child = spawn(process.execPath, [fixture.shim, 'sessionStart', entry, ...deadlineArgs], {
    cwd: fixture.project, env: fixture.env, stdio: 'pipe', windowsHide: true,
  })
  if (child.pid !== undefined) ownedPids.push(child.pid)
  child.stdin.on('error', () => undefined)
  let stdout = ''
  let stderr = ''
  let inputTimer: ReturnType<typeof setTimeout> | undefined
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<{ stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(inputTimer)
      child.kill()
      reject(new Error('shim exceeded 6000 ms observation limit'))
    }, 6000)
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(inputTimer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(inputTimer)
      if (code !== 0) reject(new Error(`shim exited ${String(code)}: ${stderr}`))
      else resolve({ stdout, stderr, elapsed: performance.now() - started })
    })
  })
  const send = (): void => {
    const input = JSON.stringify(options.payload ?? { sessionId: 'owned-tree', workingDirectory: fixture.project })
    if (options.endInput === false) child.stdin.write(input)
    else child.stdin.end(input)
  }
  if (options.delayMs) inputTimer = setTimeout(send, options.delayMs)
  else send()
  return { child, done }
}

/** Use the shipping installer, including its native command and shell quoting. */
export function runInstalledStartup(options: {
  fixture: ReturnType<typeof treeFixture>; entry: string; payload?: Record<string, unknown>
  shell?: 'cmd' | 'powershell'; alias?: boolean; input?: string; delayMs?: number
  endInput?: boolean; event?: 'sessionStart' | 'preToolUse'
}): ReturnType<typeof runTreeShim> {
  const { fixture, entry } = options
  const previousEntry = process.argv[1]
  const previousNative = process.env['TOKEN_GOAT_NATIVE_HOOKS']
  let command: string
  try {
    process.argv[1] = entry
    process.env['TOKEN_GOAT_NATIVE_HOOKS'] = '1'
    const commands = copilotHookCommandsFor(fixture.shim, options.event ?? 'sessionStart')
    command = options.shell === 'powershell' ? commands.powershell : commands.command
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
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<{ stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    let exceeded = false
    const timer = setTimeout(() => {
      exceeded = true
      // Release the pre-correction EOF wait so the red probe also cleans up.
      child.stdin.end()
    }, 6000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(inputTimer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      clearTimeout(inputTimer)
      child.stdin.destroy()
      if (exceeded) reject(new Error(`installed startup exceeded 6000 ms with stdin held open; stdout=${stdout}; stderr=${stderr}`))
      else if (code !== 0) reject(new Error(`installed startup exited ${String(code)}: ${stderr}`))
      else resolve({ stdout, stderr, elapsed: performance.now() - started })
    })
  })
  const send = (): void => {
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

export async function assertInstalledResidentBypass(fixture: ReturnType<typeof treeFixture>): Promise<void> {
  fixture.env['TOKEN_GOAT_HOOK_SERVER'] = '1'
  const server = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], {
    cwd: fixture.project, env: fixture.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  if (server.pid !== undefined) ownedPids.push(server.pid)
  let diagnostics = ''
  server.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  const data = join(fixture.root, 'home', 'dfk-helper', 'token-goat')
  const endpoint = endpointFor(0, data, dirname(BUNDLE))
  const until = performance.now() + 10_000
  let key: Buffer | undefined
  for (;;) {
    key = readServerKey(data)
    if (key && await slotStatus(endpoint, key)) break
    if (performance.now() >= until || server.exitCode !== null) throw new Error(`resident did not start: ${diagnostics}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const initial = await slotStatus(endpoint, key)
  expect(initial).toBeDefined()
  const ordinary = await runInstalledStartup({
    fixture, entry: BUNDLE, event: 'preToolUse', endInput: true,
    payload: { sessionId: 'ordinary-positive-control', workingDirectory: fixture.project, toolName: 'view', toolArgs: { path: 'example.ts' } },
  }).done
  expect(ordinary.stderr).toBe('')
  const before = await slotStatus(endpoint, key)
  expect(before?.served).toBe((initial?.served ?? -1) + 1)
  for (const endInput of [false, true]) {
    const startup = await runInstalledStartup({ fixture, entry: BUNDLE, endInput }).done
    expect(startup.stderr).toBe('')
    expect(startup.stdout).toContain('read \\"file::symbol\\"')
    expect((await slotStatus(endpoint, key))?.served, 'startup was served by the resident').toBe(before?.served)
  }
  const stopped = spawnSync(process.execPath, [BUNDLE, 'hook-server', 'stop'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  expect(stopped.status, stopped.stderr).toBe(0)
}
