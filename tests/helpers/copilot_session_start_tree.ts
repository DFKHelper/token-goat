/** HAND-DERIVED owned-process fixtures; all stores and process IDs are isolated per test. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { copilotHookCommandsFor } from '../../src/bridges/copilot_cli_install.js'
import { nativeHookCommandLine } from '../../src/native_hook.js'
import { endpointFor, readServerKey } from '../../src/hook_ipc.js'
import { windowsPowerShellPath } from '../../src/windows_powershell.js'
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
  const shim = join(root, 'shim.cjs')
  writeFileSync(shim, COPILOT_CLI_HOOK_SCRIPT)
  installStartupOwner(root)
  return {
    root, project, shim,
    env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home,
      TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0', TOKEN_GOAT_EMBED: '0' },
  }
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

export function cleanupTrees(): void {
  // Also recover PIDs if an observation rejected before the assertion registered
  // them. Only this fixture's own root-level PID files are considered.
  for (const root of ownedRoots) {
    for (const name of readdirSync(root).filter((name) => name.endsWith('.pid'))) {
      const pid = Number(readFileSync(join(root, name), 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && !ownedPids.includes(pid)) ownedPids.push(pid)
    }
  }
  const pids = ownedPids.splice(0).reverse()
  const awaited = new Set(pids)
  for (const pid of pids) {
    if (!alive(pid)) continue
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 2000, windowsHide: true })
      // Each line names the process it acted on as its first number, in any display language.
      for (const line of killed.stdout?.split('\n') ?? []) {
        const match = /[0-9]+/.exec(line)
        if (match) awaited.add(Number(match[0]))
      }
    } else {
      process.kill(pid, 'SIGKILL')
    }
  }
  if (process.platform === 'win32' && awaited.size > 0) awaitExit([...awaited])
  for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** Windows sets a killed process's exit status before the kernel has closed its handles and unmapped its image, and `process.kill(pid, 0)` reads only that status, so `alive` reports the process gone while its executable, working directory and open files still refuse deletion with EPERM. Measured: a copied PING.EXE killed and then probed until `alive` was false left its directory undeletable 100 times in 100, while deleting after the child's own exit event, which fires on the signalled process handle, succeeded 100 times in 100. Process.WaitForExit waits on that handle for PIDs this process did not spawn, including the descendants taskkill /T reached; Wait-Process does not, because it first asks HasExited, which reads the same exit status. */
function awaitExit(pids: readonly number[]): void {
  const waited = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    `foreach ($owned in @(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue)) { if (-not $owned.WaitForExit(10000)) { throw "process $($owned.Id) is still running" } }; exit 0`,
  ], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  if (waited.status !== 0) throw new Error(`owned processes ${pids.join(',')} did not exit (status ${String(waited.status)}): ${waited.error?.message ?? waited.stderr}${waited.stdout}`)
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
  fixture: ReturnType<typeof treeFixture>; entry: string; delayMs?: number; payload?: Record<string, unknown>; endInput?: boolean
}): { child: ChildProcessWithoutNullStreams; done: Promise<{ stdout: string; stderr: string; elapsed: number }> } {
  const { fixture, entry } = options
  const started = performance.now()
  const child = spawn(process.execPath, [fixture.shim, 'sessionStart', entry], {
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
