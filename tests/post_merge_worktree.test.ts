// scripts/post-merge.mjs runs after every pull, merge and rebase, and past the build it acts on the user's real home: hook-server stop, worker restart, install, doctor --repair, prune and index. Run from a linked worktree it re-pointed every installed hook at that worktree's dist and started a worker there, so a linked worktree must stop after the build. CAPTURE: the repositories are real (`git init`, `git commit`, `git worktree add`) and the script is the shipped one, copied beside a stub bundle that only records the arguments it was run with. The same holds for a checkout that is not the active install: with the global token-goat a registry copy, a pull in the checkout started a worker and a hook server from the checkout's dist while the hooks still ran the registry copy.
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  endWindowsOwnedTree,
  PROCESS_TERMINATE_SCRIPT,
  drainWindowsOwnedTree,
  killVerifiedSurvivors,
  selectSurvivors,
  shouldKillSurvivor,
} from '../scripts/post-merge.mjs'
import { codexHookScriptPath } from '../src/bridges/codex_install.js'
import { copilotCliScriptPath } from '../src/bridges/copilot_cli_install.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempDir } from './helpers/temp-config.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'post-merge.mjs')
const WINDOWS_POWERSHELL = path.win32.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

function readProcessCreatedMs(pid: number): number {
  const result = spawnSync(
    WINDOWS_POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `([DateTimeOffset](Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate).ToUnixTimeMilliseconds()`,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  expect(result.status, result.stderr).toBe(0)
  const createdMs = Number(result.stdout.trim())
  expect(Number.isSafeInteger(createdMs)).toBe(true)
  return createdMs
}

function runProcessTerminateScript(target: { pid: number; createdMs: number }) {
  return spawnSync(
    WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TERMINATE_SCRIPT],
    {
      encoding: 'utf8',
      input: JSON.stringify([target]),
      timeout: 15_000,
      windowsHide: true,
    },
  )
}

const STUB_BUILD = [
  "import fs from 'node:fs'",
  "fs.mkdirSync('dist', { recursive: true })",
  "fs.writeFileSync('dist/token-goat.mjs', \"import fs from 'node:fs'; const args = process.argv.slice(2); const delay = Number(process.env.TG_POST_MERGE_TEST_DELAY_MS); if (args[0] === 'doctor' && args[1] === '--repair' && delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); fs.appendFileSync(process.env.TG_POST_MERGE_LOG, args.join(' ') + '\\\\n')\")",
  '',
].join('\n')

describe('post-merge Windows survivor selection', () => {
  it('excludes children of a recycled root PID and the post-merge process tree', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const spawnedAtMs = 1_000
    const rootExitedAtMs = 2_000
    const originalChild = rootPid + 1
    const originalGrandchild = rootPid + 2
    const recycledChild = rootPid + 3
    const lateChild = rootPid + 4
    const createdBeforeParent = rootPid + 5
    const rows = [
      { pid: rootPid, ppid: 1, createdMs: rootExitedAtMs + 5 },
      { pid: recycledChild, ppid: rootPid, createdMs: rootExitedAtMs + 6 },
      { pid: originalChild, ppid: rootPid, createdMs: rootExitedAtMs - 100 },
      { pid: lateChild, ppid: rootPid, createdMs: rootExitedAtMs + 1 },
      { pid: originalGrandchild, ppid: originalChild, createdMs: rootExitedAtMs + 100 },
      { pid: createdBeforeParent, ppid: originalChild, createdMs: rootExitedAtMs - 101 },
      { pid: process.pid, ppid: rootPid, createdMs: rootExitedAtMs - 100 },
      { pid: process.ppid, ppid: originalChild, createdMs: rootExitedAtMs + 100 },
    ]

    expect(selectSurvivors(rows, rootPid, spawnedAtMs, rootExitedAtMs, true)).toEqual([
      { pid: originalChild, createdMs: rootExitedAtMs - 100 },
      { pid: originalGrandchild, createdMs: rootExitedAtMs + 100 },
    ])
  })

  it('rejects pre-spawn children while retaining same-millisecond descendants', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const spawnedAtMs = 1_000
    const rootExitedAtMs = 2_000
    const beforeSpawn = rootPid + 1
    const sameMillisecondChild = rootPid + 2
    const sameMillisecondGrandchild = rootPid + 3
    const laterDescendant = rootPid + 4
    const rows = [
      { pid: rootPid, ppid: process.ppid, createdMs: spawnedAtMs },
      { pid: beforeSpawn, ppid: rootPid, createdMs: spawnedAtMs - 1 },
      { pid: sameMillisecondChild, ppid: rootPid, createdMs: spawnedAtMs },
      { pid: sameMillisecondGrandchild, ppid: sameMillisecondChild, createdMs: spawnedAtMs },
      { pid: laterDescendant, ppid: sameMillisecondGrandchild, createdMs: spawnedAtMs + 1 },
    ]

    expect(selectSurvivors(rows, rootPid, spawnedAtMs, rootExitedAtMs, false)).toEqual([
      { pid: rootPid, createdMs: spawnedAtMs },
      { pid: sameMillisecondChild, createdMs: spawnedAtMs },
      { pid: sameMillisecondGrandchild, createdMs: spawnedAtMs },
      { pid: laterDescendant, createdMs: spawnedAtMs + 1 },
    ])
  })

  it('only kills the same readable process identity', () => {
    const target = { pid: 12345, createdMs: 2000 }

    expect(shouldKillSurvivor(target, null)).toBe(false)
    expect(shouldKillSurvivor(target, undefined)).toBe(false)
    expect(shouldKillSurvivor(target, { pid: target.pid, createdMs: target.createdMs + 5 })).toBe(false)
    expect(shouldKillSurvivor(target, { pid: target.pid, createdMs: Number.NaN })).toBe(false)
    expect(shouldKillSurvivor({ pid: target.pid, createdMs: Number.NaN }, target)).toBe(false)
    expect(shouldKillSurvivor(target, target)).toBe(true)
    expect(shouldKillSurvivor(target, target, new Set([target.pid]))).toBe(false)
  })

  it('skips a recycled PID between survivor selection and termination', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const spawnedAtMs = 1_000
    const recycledPid = rootPid + 1
    const absentPid = rootPid + 2
    const currentPid = rootPid + 3
    const targets = selectSurvivors(
      [
        { pid: rootPid, ppid: process.ppid, createdMs: spawnedAtMs },
        { pid: recycledPid, ppid: rootPid, createdMs: spawnedAtMs + 1 },
        { pid: absentPid, ppid: rootPid, createdMs: spawnedAtMs + 2 },
        { pid: currentPid, ppid: rootPid, createdMs: spawnedAtMs + 3 },
      ],
      rootPid,
      spawnedAtMs,
      spawnedAtMs + 100,
      false,
    )
    const [root, recycled, , currentSurvivor] = targets
    const currentByPid = new Map([
      [recycled.pid, { pid: recycled.pid, createdMs: recycled.createdMs + 5 }],
      [currentSurvivor.pid, currentSurvivor],
    ])
    const killFn = vi.fn()

    expect(
      killVerifiedSurvivors(
        targets,
        (pid) => currentByPid.get(pid),
        killFn,
        new Set([process.pid, process.ppid, root.pid]),
      ),
    ).toEqual([currentSurvivor])
    expect(killFn).toHaveBeenCalledOnce()
    expect(killFn).toHaveBeenCalledWith([currentSurvivor])
  })

  it('kills a child that appears after its owned parent vanished, then converges', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const firstChildPid = rootPid + 1
    const lateChildPid = rootPid + 2
    const snapshots = [
      [
        { pid: rootPid, ppid: process.ppid, createdMs: 100 },
        { pid: firstChildPid, ppid: rootPid, createdMs: 110 },
      ],
      [{ pid: lateChildPid, ppid: firstChildPid, createdMs: 180 }],
      [],
    ]
    const snapshotFn = vi.fn(() => snapshots.shift() ?? [])
    const killBatches: Array<Array<{ pid: number; createdMs: number }>> = []
    const killBatchFn = vi.fn((targets: readonly { pid: number; createdMs: number }[]) => {
      killBatches.push([...targets])
      return targets.map((target) => ({ ...target, verified: true, cutoffMs: 200 }))
    })

    const result = endWindowsOwnedTree(rootPid, 100, 150, {
      snapshotFn,
      killBatchFn,
    })

    expect(result).toEqual({ status: 'converged', passes: 3 })
    expect(snapshotFn).toHaveBeenCalledTimes(3)
    expect(killBatches).toEqual([
      [
        { pid: rootPid, createdMs: 100 },
        { pid: firstChildPid, createdMs: 110 },
      ],
      [{ pid: lateChildPid, createdMs: 180 }],
    ])
  })

  it('uses the parent cutoff before a slow batch can claim a recycled child', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const parentPid = rootPid + 1
    const laterTargetPid = rootPid + 2
    const recycledChildPid = rootPid + 3
    const parentCutoffMs = 200
    const batchEndMs = 300
    const snapshots = [
      [
        { pid: parentPid, ppid: rootPid, createdMs: 110 },
        { pid: laterTargetPid, ppid: parentPid, createdMs: 120 },
      ],
      [],
    ]
    const snapshotFn = vi.fn(() => snapshots.shift() ?? [])
    let laterTargetSawChild = false
    const killBatchFn = vi.fn((targets: readonly { pid: number; createdMs: number }[]) => {
      const cutoffs: Array<{ pid: number; createdMs: number; verified: boolean; cutoffMs: number }> = []
      for (const target of targets) {
        if (target.pid === parentPid) {
          snapshots[0] = [
            { pid: recycledChildPid, ppid: parentPid, createdMs: parentCutoffMs + 1 },
          ]
        } else if (snapshots[0]?.length === 1) {
          laterTargetSawChild = true
        }
        cutoffs.push({
          pid: target.pid,
          createdMs: target.createdMs,
          verified: true,
          cutoffMs: target.pid === parentPid ? parentCutoffMs : batchEndMs,
        })
      }
      return cutoffs
    })

    const result = drainWindowsOwnedTree(rootPid, 100, 150, {
      snapshotFn,
      killBatchFn,
    })

    expect(laterTargetSawChild).toBe(true)
    expect(killBatchFn).toHaveBeenCalledOnce()
    expect(killBatchFn).toHaveBeenCalledWith([
      { pid: parentPid, createdMs: 110 },
      { pid: laterTargetPid, createdMs: 120 },
    ])
    expect(snapshotFn).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ status: 'converged', passes: 2 })
  })

  it('continues after a handle-verified target exits and kills its later child', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const parentPid = rootPid + 1
    const firstChildPid = rootPid + 2
    const lateChildPid = rootPid + 3
    const snapshots = [
      [
        { pid: parentPid, ppid: rootPid, createdMs: 110 },
        { pid: firstChildPid, ppid: parentPid, createdMs: 120 },
      ],
      [{ pid: lateChildPid, ppid: parentPid, createdMs: 180 }],
      [],
    ]
    let exitedTargetPid: number | undefined
    let snapshotCount = 0
    const snapshotFn = vi.fn(() => {
      const snapshot = snapshots.shift() ?? []
      if (++snapshotCount === 1) exitedTargetPid = parentPid
      return snapshot
    })
    const killBatches: Array<Array<{ pid: number; createdMs: number }>> = []
    const runWindowsPowerShellFn = vi.fn(
      (script: string, targets: readonly { pid: number; createdMs: number }[] = []) => {
        expect(script).toBe(PROCESS_TERMINATE_SCRIPT)
        killBatches.push([...targets])
        return {
          status: 0,
          stdout: targets
            .map((target) =>
              JSON.stringify({
                pid: target.pid,
                createdMs: target.createdMs,
                verified: true,
                cutoffMs: target.pid === exitedTargetPid ? 200 : 300,
              }),
            )
            .join('\n'),
          stderr: '',
        }
      },
    )

    const result = endWindowsOwnedTree(rootPid, 100, 150, {
      snapshotFn,
      runWindowsPowerShellFn,
    })

    expect(exitedTargetPid).toBe(parentPid)
    expect(result).toEqual({ status: 'converged', passes: 3 })
    expect(killBatches).toEqual([
      [
        { pid: parentPid, createdMs: 110 },
        { pid: firstChildPid, createdMs: 120 },
      ],
      [{ pid: lateChildPid, createdMs: 180 }],
    ])
    expect(snapshotFn).toHaveBeenCalledTimes(3)
    expect(runWindowsPowerShellFn).toHaveBeenCalledTimes(2)
  })

  it('does not claim a child after OpenProcess fails for a recycled parent PID', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const parentPid = rootPid + 1
    const recycledChildPid = rootPid + 2
    const snapshots = [
      [{ pid: parentPid, ppid: rootPid, createdMs: 110 }],
      [{ pid: recycledChildPid, ppid: parentPid, createdMs: 190 }],
    ]
    const snapshotFn = vi.fn(() => snapshots.shift() ?? [])
    const killBatches: Array<Array<{ pid: number; createdMs: number }>> = []
    const runWindowsPowerShellFn = vi.fn(
      (script: string, targets: readonly { pid: number; createdMs: number }[] = []) => {
        expect(script).toBe(PROCESS_TERMINATE_SCRIPT)
        killBatches.push([...targets])
        return {
          status: 0,
          stdout: targets
            .map((target) => JSON.stringify({ ...target, verified: false, cutoffMs: -1 }))
            .join('\n'),
          stderr: '',
        }
      },
    )

    const result = endWindowsOwnedTree(rootPid, 100, 150, {
      snapshotFn,
      runWindowsPowerShellFn,
    })

    expect(result).toEqual({ status: 'converged', passes: 2 })
    expect(snapshotFn).toHaveBeenCalledTimes(2)
    expect(runWindowsPowerShellFn).toHaveBeenCalledOnce()
    expect(killBatches).toEqual([[{ pid: parentPid, createdMs: 110 }]])
  })

  it('does not seed a reused live root PID after root verification fails', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const recycledChildPid = rootPid + 1
    const snapshots = [
      [{ pid: rootPid, ppid: process.ppid, createdMs: 110 }],
      [
        { pid: rootPid, ppid: process.ppid, createdMs: 190 },
        { pid: recycledChildPid, ppid: rootPid, createdMs: 200 },
      ],
    ]
    const snapshotFn = vi.fn(() => snapshots.shift() ?? [])
    const killBatches: Array<Array<{ pid: number; createdMs: number }>> = []
    const runWindowsPowerShellFn = vi.fn(
      (script: string, targets: readonly { pid: number; createdMs: number }[] = []) => {
        expect(script).toBe(PROCESS_TERMINATE_SCRIPT)
        killBatches.push([...targets])
        return {
          status: 0,
          stdout: targets
            .map((target) => JSON.stringify({ ...target, verified: false, cutoffMs: -1 }))
            .join('\n'),
          stderr: '',
        }
      },
    )

    const result = endWindowsOwnedTree(rootPid, 100, 250, {
      snapshotFn,
      runWindowsPowerShellFn,
    })

    expect(result).toEqual({ status: 'converged', passes: 2 })
    expect(snapshotFn).toHaveBeenCalledTimes(2)
    expect(runWindowsPowerShellFn).toHaveBeenCalledOnce()
    expect(killBatches).toEqual([[{ pid: rootPid, createdMs: 110 }]])
  })
  it('does not kill a recycled owned PID or its child', () => {
    const rootPid = Math.max(process.pid, process.ppid) + 10_000
    const firstChildPid = rootPid + 1
    const recycledChildPid = rootPid + 2
    const snapshots = [
      [
        { pid: rootPid, ppid: process.ppid, createdMs: 100 },
        { pid: firstChildPid, ppid: rootPid, createdMs: 110 },
      ],
      [
        { pid: firstChildPid, ppid: 1, createdMs: 201 },
        { pid: recycledChildPid, ppid: firstChildPid, createdMs: 202 },
      ],
    ]
    const snapshotFn = vi.fn(() => snapshots.shift() ?? [])
    const killBatchFn = vi.fn((targets: readonly { pid: number; createdMs: number }[]) =>
      targets.map((target) => ({ ...target, verified: true, cutoffMs: 200 })),
    )

    const result = endWindowsOwnedTree(rootPid, 100, 150, {
      snapshotFn,
      killBatchFn,
    })

    expect(result).toEqual({ status: 'converged', passes: 2 })
    expect(snapshotFn).toHaveBeenCalledTimes(2)
    expect(killBatchFn).toHaveBeenCalledOnce()
    expect(killBatchFn).toHaveBeenCalledWith([
      { pid: rootPid, createdMs: 100 },
      { pid: firstChildPid, createdMs: 110 },
    ])
  })
})

describe('post-merge Windows process termination', () => {
  it.skipIf(process.platform !== 'win32')(
    'terminates a live process when its retained handle creation time matches',
    { timeout: 30_000 },
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      if (child.pid === undefined) throw new Error('sleeper process did not start')
      const pid = child.pid

      try {
        const createdMs = readProcessCreatedMs(pid)
        const result = runProcessTerminateScript({ pid, createdMs })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        const row = JSON.parse(result.stdout.trim())
        expect(row).toEqual({
          pid,
          createdMs,
          verified: true,
          cutoffMs: expect.any(Number),
        })
        expect(row.cutoffMs).toBeGreaterThanOrEqual(0)
        expect(await waitForProcessGone(pid, 5_000)).toBeDefined()
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await waitForProcessGone(pid, 5_000)
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'returns an unverified result when a target is absent before OpenProcess',
    { timeout: 30_000 },
    () => {
      const pid = 99_999_999
      const createdMs = 1000
      const result = runProcessTerminateScript({ pid, createdMs })

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const row = JSON.parse(result.stdout.trim())
      expect(row).toEqual({ pid, createdMs, verified: false, cutoffMs: -1 })
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'leaves a live process untouched when its retained handle creation time mismatches',
    { timeout: 30_000 },
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      if (child.pid === undefined) throw new Error('sleeper process did not start')
      const pid = child.pid

      try {
        const createdMs = readProcessCreatedMs(pid)
        const result = runProcessTerminateScript({ pid, createdMs: createdMs - 1 })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout.trim())).toEqual({
          pid,
          createdMs: createdMs - 1,
          verified: false,
          cutoffMs: -1,
        })
        expect(await waitForProcessGone(pid, 100)).toBeUndefined()
        expect(() => process.kill(pid, 0)).not.toThrow()
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await waitForProcessGone(pid, 5_000)
      }
    },
  )
})

/** Gives `root` the shipped script plus a package.json whose build writes the recording stub bundle. */
function stageCheckout(root: string): void {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'post-merge.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'atomic-write.mjs'), path.join(root, 'scripts', 'atomic-write.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'dependabot-body.mjs'), path.join(root, 'scripts', 'dependabot-body.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'git-executable.mjs'), path.join(root, 'scripts', 'git-executable.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'is-main-module.mjs'), path.join(root, 'scripts', 'is-main-module.mjs'))
  fs.writeFileSync(path.join(root, 'build.mjs'), STUB_BUILD)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', private: true, scripts: { build: 'node build.mjs' } }))
}

/** Fresh home, CODEX_HOME and COPILOT_HOME, all apart from each other and from the real ones, so the script's host check never sees a developer's own Codex or Copilot install. */
function isolatedHosts(): {
  home: string
  codexHome: string
  copilotHome: string
  npmPrefix: string
  npmCache: string
  localAppData: string
  xdgConfigHome: string
  xdgCacheHome: string
  tokenGoatHome: string
} {
  const base = tempDir()
  return {
    home: path.join(base, 'home'),
    codexHome: path.join(base, 'codex'),
    copilotHome: path.join(base, 'copilot'),
    npmPrefix: path.join(base, 'npm-prefix'),
    npmCache: path.join(base, 'npm-cache'),
    localAppData: path.join(base, 'local-app-data'),
    xdgConfigHome: path.join(base, 'xdg-config'),
    xdgCacheHome: path.join(base, 'xdg-cache'),
    tokenGoatHome: path.join(base, 'token-goat-home'),
  }
}

/** The environment every spawn in this file runs under, `extra` last. `npm test` injects lowercase npm_config_* variables (prefix, cache, userconfig) that npm reads alongside the uppercase key set here, so every npm_config_* spelling is dropped first and the one that decides the global root is NPM_CONFIG_PREFIX. The npm cache is pinned too: npm writes its debug log under it, which would otherwise create a directory under the isolated HOME. */
function isolatedEnv(hosts: ReturnType<typeof isolatedHosts>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase().startsWith('npm_config_')) delete env[key]
  // A developer's exported override would force the full sync in every test; only a test's own `extra` may set it.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'tg_post_merge_sync') delete env[key]
  return {
    ...env,
    HOME: hosts.home,
    USERPROFILE: hosts.home,
    LOCALAPPDATA: hosts.localAppData,
    XDG_DATA_HOME: hosts.localAppData,
    XDG_CONFIG_HOME: hosts.xdgConfigHome,
    XDG_CACHE_HOME: hosts.xdgCacheHome,
    TOKEN_GOAT_HOME: hosts.tokenGoatHome,
    CODEX_HOME: hosts.codexHome,
    COPILOT_HOME: hosts.copilotHome,
    NPM_CONFIG_PREFIX: hosts.npmPrefix,
    NPM_CONFIG_CACHE: hosts.npmCache,
    ...extra,
  }
}

function runPostMerge(root: string, log: string, hosts = isolatedHosts(), extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'post-merge.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedEnv(hosts, { TG_POST_MERGE_LOG: log, ...extra }),
  })
}

function spawnPostMerge(
  root: string,
  log: string,
  hosts: ReturnType<typeof isolatedHosts>,
  extra: NodeJS.ProcessEnv = {},
  signalBridge = false,
) {
  const script = path.join(root, 'scripts', 'post-merge.mjs')
  const args =
    signalBridge && process.platform === 'win32'
      ? [
          '-e',
          "const { pathToFileURL } = require('node:url'); process.stdin.on('data', (chunk) => process.emit(String(chunk).trim())); import(pathToFileURL(process.argv[1]).href)",
          script,
        ]
      : [script]
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: isolatedEnv(hosts, { TG_POST_MERGE_LOG: log, ...extra }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdin?.on('error', () => {})
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const closed = new Promise<{
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }>((resolve) => {
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
  return { child, closed }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process did not finish within ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<NodeJS.ErrnoException | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      const processError = error as NodeJS.ErrnoException
      if (processError.code === 'ESRCH') return processError
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return undefined
}

function fastNpmEnvironment(root: string): NodeJS.ProcessEnv {
  const bundleDir = path.join(root, 'dist')
  fs.mkdirSync(bundleDir, { recursive: true })
  fs.writeFileSync(
    path.join(bundleDir, 'token-goat.mjs'),
    [
      "import fs from 'node:fs'",
      "import { spawn } from 'node:child_process'",
      'const args = process.argv.slice(2)',
      "const hang = process.env.TG_POST_MERGE_TEST_HANG === '1'",
      "const exitsAfterSpawn = process.env.TG_POST_MERGE_TEST_EXIT_AFTER_SPAWN === '1'",
      "if (args[0] === 'doctor' && args[1] === '--repair' && (hang || exitsAfterSpawn)) {",
      '  const stepPidFile = process.env.TG_POST_MERGE_TEST_STEP_PID',
      '  if (stepPidFile) fs.writeFileSync(stepPidFile, String(process.pid))',
      "  const marker = process.env.TG_POST_MERGE_GRANDCHILD_MARKER ?? 'token-goat-post-merge-grandchild'",
      "  const stdio = process.env.TG_POST_MERGE_TEST_INHERIT_STDIO === '1' ? 'inherit' : 'ignore'",
      "  const detached = process.platform === 'win32' && process.env.TG_POST_MERGE_TEST_INHERIT_STDIO === '1'",
      "  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio, detached })",
      '  fs.writeFileSync(process.env.TG_POST_MERGE_GRANDCHILD_PID, String(sleeper.pid))',
      '  if (exitsAfterSpawn) process.exit(0)',
      '  await new Promise(() => {})',
      '}',
      "if (args[0] === 'worker' && args[1] === 'start' && process.env.TG_POST_MERGE_TEST_RESIDENT_PID) {",
      "  const marker = process.env.TG_POST_MERGE_TEST_RESIDENT_MARKER",
      "  const resident = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore', detached: true })",
      '  resident.unref()',
      '  fs.writeFileSync(process.env.TG_POST_MERGE_TEST_RESIDENT_PID, String(resident.pid))',
      '}',
      "fs.appendFileSync(process.env.TG_POST_MERGE_LOG, args.join(' ') + '\\n')",
    ].join('\n'),
  )
  if (process.platform === 'win32') {
    const npmExecPath = path.join(root, 'npm-cli.js')
    fs.writeFileSync(npmExecPath, 'process.exitCode = 0\n')
    const npmExecPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'npm_execpath') ?? 'npm_execpath'
    return { [npmExecPathKey]: npmExecPath }
  }
  const binDir = path.join(root, 'fast-npm-bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return { [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] ?? ''}` }
}

/** Where npm puts global packages for this prefix, as npm itself says it (`npm root -g`), under the same isolated environment the script runs in, so the fixture does not restate npm's per-platform layout and never reads the developer's own npm configuration. */
function globalRoot(hosts: ReturnType<typeof isolatedHosts>): string {
  const res = spawnSync('npm root -g', { shell: true, encoding: 'utf8', cwd: tempDir(), env: isolatedEnv(hosts) })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout.trim()
}

function writeShim(shimPath: string): void {
  fs.mkdirSync(path.dirname(shimPath), { recursive: true })
  fs.writeFileSync(shimPath, '// shim')
}

function loggedArgs(log: string): string[] {
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean)
}

describe('post-merge sync in a linked worktree', () => {
  it('builds but leaves the real install alone in a linked worktree, and syncs it from the main checkout', () => {
    const main = gitRepoWithCommit()
    const linked = path.join(tempDir(), 'linked')
    const added = spawnSync('git', ['worktree', 'add', '--detach', linked], { cwd: main, encoding: 'utf8' })
    expect(added.status, added.stderr).toBe(0)
    stageCheckout(main)
    stageCheckout(linked)

    const linkedLog = path.join(tempDir(), 'linked.log')
    const fromLinked = runPostMerge(linked, linkedLog)
    expect(fromLinked.status, fromLinked.stderr).toBe(0)
    expect(fs.existsSync(path.join(linked, 'dist', 'token-goat.mjs'))).toBe(true)
    expect(fromLinked.stdout).toContain('Linked worktree: built the bundle only.')
    expect(fs.existsSync(linkedLog)).toBe(false)

    const mainLog = path.join(tempDir(), 'main.log')
    const fromMain = runPostMerge(main, mainLog)
    expect(fromMain.status, fromMain.stderr).toBe(0)
    expect(fromMain.stdout).not.toContain('Linked worktree')
    expect(loggedArgs(mainLog)).toEqual(['hook-server stop', 'worker stop', 'worker start', 'install', 'doctor --repair', 'project prune', 'index'])
  })

  it('TG_POST_MERGE_SYNC=1 does not lift the linked-worktree stop, and the message says so', () => {
    const main = gitRepoWithCommit()
    const linked = path.join(tempDir(), 'linked')
    const added = spawnSync('git', ['worktree', 'add', '--detach', linked], { cwd: main, encoding: 'utf8' })
    expect(added.status, added.stderr).toBe(0)
    stageCheckout(linked)
    const log = path.join(tempDir(), 'linked.log')
    const res = runPostMerge(linked, log, isolatedHosts(), { TG_POST_MERGE_SYNC: '1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Linked worktree: built the bundle only.')
    expect(res.stdout).toContain('TG_POST_MERGE_SYNC=1 does not lift this stop.')
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
    expect(res.stdout).not.toContain('Full sync')
  })
})

describe('post-merge refresh of the Codex and Copilot hosts', () => {
  const BASE = ['hook-server stop', 'worker stop', 'worker start', 'install']
  const TAIL = ['doctor --repair', 'project prune', 'index']

  /** Runs the script in a main checkout after `seed` placed shims where the product's own path functions say they belong, with CODEX_HOME and COPILOT_HOME set to the isolated directories. */
  function run(seed: (root: string) => void): string[] {
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const hosts = isolatedHosts()
    const saved = { codex: process.env['CODEX_HOME'], copilot: process.env['COPILOT_HOME'] }
    process.env['CODEX_HOME'] = hosts.codexHome
    process.env['COPILOT_HOME'] = hosts.copilotHome
    try {
      seed(main)
    } finally {
      for (const [key, value] of [['CODEX_HOME', saved.codex], ['COPILOT_HOME', saved.copilot]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const log = path.join(tempDir(), 'run.log')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    return loggedArgs(log)
  }

  it('skips Codex and Copilot, creating nothing, when no host has a token-goat shim', () => {
    const hosts = isolatedHosts()
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const log = path.join(tempDir(), 'none.log')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(loggedArgs(log)).toEqual([...BASE, ...TAIL])
    expect(res.stdout).not.toContain('Codex')
    expect(res.stdout).not.toContain('Copilot')
    for (const dir of [hosts.home, hosts.codexHome, hosts.copilotHome]) expect(fs.existsSync(dir), dir).toBe(false)
  })

  it('refreshes Codex only, at CODEX_HOME rather than ~/.codex, when its shim is there', () => {
    expect(run(() => writeShim(codexHookScriptPath()))).toEqual([...BASE, 'install --codex', ...TAIL])
  })

  it('refreshes Copilot user scope only, at COPILOT_HOME, when its shim is there', () => {
    expect(run(() => writeShim(copilotCliScriptPath()))).toEqual([...BASE, 'install --copilot', ...TAIL])
  })

  it('refreshes Copilot project scope only when the checkout carries the shim', () => {
    expect(run((root) => writeShim(copilotCliScriptPath({ local: true, projectRoot: root })))).toEqual([...BASE, 'install --copilot --local', ...TAIL])
  })

  it('refreshes every host that has a shim, in the order the install steps are listed', () => {
    const args = run((root) => {
      writeShim(codexHookScriptPath())
      writeShim(copilotCliScriptPath())
      writeShim(copilotCliScriptPath({ local: true, projectRoot: root }))
    })
    expect(args).toEqual([...BASE, 'install --copilot', 'install --copilot --local', 'install --codex', ...TAIL])
  })
})

describe('post-merge sync in a checkout that is not the active install', () => {
  // CAPTURE: the global root is what `npm root -g` prints under a throwaway NPM_CONFIG_PREFIX. FORMAT-DERIVED: a registry install is a real directory named token-goat in that root and `npm install -g .` leaves a link to the checkout there, so the two are built here the way npm's documented global folder layout describes them (https://docs.npmjs.com/cli/v10/configuring-npm/folders). The stub npm in the fallback test is HAND-DERIVED from the one thing the script keys on, a non-zero exit from `npm root -g`; it says nothing about npm's wire format.
  const FULL_SYNC = ['hook-server stop', 'worker stop', 'worker start', 'install', 'doctor --repair', 'project prune', 'index']

  function stageMain(): { main: string; hosts: ReturnType<typeof isolatedHosts>; log: string; globalDir: string } {
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const hosts = isolatedHosts()
    return { main, hosts, log: path.join(tempDir(), 'run.log'), globalDir: path.join(globalRoot(hosts), 'token-goat') }
  }

  function installRegistryCopy(globalDir: string): void {
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'package.json'), JSON.stringify({ name: 'token-goat', version: '2.9.31' }))
  }

  /** A directory holding an npm stub that refuses `root` (exit 1) and runs the stub build for `run build`; Windows names its CLI directly and POSIX finds its launcher on PATH. */
  function failingNpmPath(): NodeJS.ProcessEnv {
    const dir = tempDir()
    fs.mkdirSync(dir, { recursive: true })
    const stub = [
      "import { spawnSync } from 'node:child_process'",
      'const args = process.argv.slice(2)',
      "if (args[0] === 'root') {",
      "  process.stderr.write('stub npm: root refused\\n')",
      '  process.exit(1)',
      '}',
      "if (args[0] === 'run' && args[1] === 'build') process.exit(spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit' }).status ?? 1)",
      'process.exit(2)',
      '',
    ].join('\n')
    const stubPath = path.join(dir, 'npm-stub.mjs')
    fs.writeFileSync(stubPath, stub)
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
      fs.copyFileSync(stubPath, path.join(dir, 'npm-cli.js'))
      fs.writeFileSync(path.join(dir, 'npm.cmd'), `@"${process.execPath}" "%~dp0npm-stub.mjs" %*\r\n`)
    } else {
      fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/npm-stub.mjs" "$@"\n`, { mode: 0o755 })
    }
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const env: NodeJS.ProcessEnv = { [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ''}` }
    if (process.platform === 'win32') {
      const npmExecPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'npm_execpath') ?? 'npm_execpath'
      env[npmExecPathKey] = path.join(dir, 'npm-cli.js')
    }
    return env
  }

  it('builds and touches nothing else when the global token-goat is a registry copy elsewhere', () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(fs.existsSync(path.join(main, 'dist', 'token-goat.mjs'))).toBe(true)
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
    expect(res.stdout).toContain('Build only, not the active install')
    expect(res.stdout).toContain(fs.realpathSync.native(globalDir))
    expect(res.stdout).toContain('npm install -g .')
    expect(res.stdout).toContain('TG_POST_MERGE_SYNC=1')
    expect(res.stdout).not.toContain('Synchronization complete')
    for (const dir of [hosts.home, hosts.codexHome, hosts.copilotHome, hosts.tokenGoatHome]) expect(fs.existsSync(dir), dir).toBe(false)
  })

  it('syncs as before, and says so, when the global token-goat links to this checkout, even through a second link', () => {
    const { main, hosts, log, globalDir } = stageMain()
    const alias = path.join(tempDir(), 'alias')
    fs.symlinkSync(main, alias, 'junction')
    fs.mkdirSync(path.dirname(globalDir), { recursive: true })
    fs.symlinkSync(alias, globalDir, 'junction')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).not.toContain('not the active install')
    expect(res.stdout).toContain('Full sync: the global token-goat is this checkout')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('syncs as before, and says so, when no global token-goat exists to compare with', () => {
    const { main, hosts, log } = stageMain()
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: no global token-goat package under')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('does a full sync, naming the failure, when `npm root -g` fails', () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, failingNpmPath())
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: `npm root -g` failed (exit 1)')
    expect(res.stdout).not.toContain('not the active install')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('TG_POST_MERGE_SYNC=1 forces the full sync past a registry copy, and says why', () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, { TG_POST_MERGE_SYNC: '1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: TG_POST_MERGE_SYNC=1 forces it')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('a TG_POST_MERGE_SYNC value other than 1 does not force the sync', () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, { TG_POST_MERGE_SYNC: '0' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Build only, not the active install')
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
  })

  it('times out a slow sync step and kills its grandchild process', { timeout: 30_000 }, () => {
    const { main, hosts, log } = stageMain()
    const npmEnv = fastNpmEnvironment(main)
    const grandchildPidFile = path.join(main, 'grandchild.pid')
    const grandchildMarker = `token-goat-post-merge-grandchild-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let grandchildPid: number | undefined
    try {
      const res = runPostMerge(main, log, hosts, {
        TG_POST_MERGE_SYNC: '1',
        TG_POST_MERGE_STEP_TIMEOUT_MS: '8000',
        TG_POST_MERGE_TEST_HANG: '1',
        TG_POST_MERGE_GRANDCHILD_PID: grandchildPidFile,
        TG_POST_MERGE_GRANDCHILD_MARKER: grandchildMarker,
        ...npmEnv,
      })

      expect(res.status).toBe(1)
      expect(res.stderr).toContain(
        '[token-goat] post-merge: Running doctor repairs across configured harnesses timed out after 8000ms',
      )
      expect(res.stderr).toContain('Synchronization incomplete; failed steps:')
      expect(loggedArgs(log)).not.toContain('doctor --repair')
      expect(fs.existsSync(grandchildPidFile), `${res.stdout}\n${res.stderr}`).toBe(true)
      grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'))
      expect(Number.isInteger(grandchildPid)).toBe(true)
      let processError: NodeJS.ErrnoException | undefined
      try {
        process.kill(grandchildPid, 0)
      } catch (error) {
        processError = error as NodeJS.ErrnoException
      }
      expect(processError?.code).toBe('ESRCH')
    } finally {
      if (grandchildPid !== undefined && Number.isInteger(grandchildPid)) {
        killIfCommandLine(grandchildPid, (commandLine) => commandLine.includes(grandchildMarker), { tree: true })
      }
    }
  })

  it('leaves a resident started by a normally completed worker step alive', { timeout: 30_000 }, async () => {
    const { main, hosts, log } = stageMain()
    const npmEnv = fastNpmEnvironment(main)
    const residentPidFile = path.join(main, 'resident.pid')
    const residentMarker = `token-goat-post-merge-resident-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const run = spawnPostMerge(main, log, hosts, {
      TG_POST_MERGE_SYNC: '1',
      TG_POST_MERGE_TEST_RESIDENT_PID: residentPidFile,
      TG_POST_MERGE_TEST_RESIDENT_MARKER: residentMarker,
      ...npmEnv,
    })
    let residentPid: number | undefined
    try {
      await waitForFile(residentPidFile, 10_000)
      const pid = Number(fs.readFileSync(residentPidFile, 'utf8'))
      residentPid = pid
      expect(Number.isInteger(pid)).toBe(true)

      const result = await within(run.closed, 10_000)
      expect(result.status).toBe(0)
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      if (residentPid !== undefined && Number.isInteger(residentPid)) {
        killIfCommandLine(residentPid, (commandLine) => commandLine.includes(residentMarker), { tree: true })
      }
      await within(run.closed, 3_000).catch(() => {})
    }
  })

  it('times out an exited step parent that leaves an inherited pipe open', { timeout: 30_000 }, async () => {
    const { main, hosts, log } = stageMain()
    const npmEnv = fastNpmEnvironment(main)
    const childPidFile = path.join(main, 'inherited-pipe-child.pid')
    const childMarker = `token-goat-post-merge-inherited-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const run = spawnPostMerge(main, log, hosts, {
      TG_POST_MERGE_SYNC: '1',
      TG_POST_MERGE_STEP_TIMEOUT_MS: '1500',
      TG_POST_MERGE_TEST_EXIT_AFTER_SPAWN: '1',
      TG_POST_MERGE_TEST_INHERIT_STDIO: '1',
      TG_POST_MERGE_GRANDCHILD_PID: childPidFile,
      TG_POST_MERGE_GRANDCHILD_MARKER: childMarker,
      ...npmEnv,
    })
    let childPid: number | undefined
    try {
      await waitForFile(childPidFile, 10_000)
      const childSpawnedAt = Date.now()
      const pid = Number(fs.readFileSync(childPidFile, 'utf8'))
      childPid = pid
      expect(Number.isInteger(pid)).toBe(true)

      const result = await within(run.closed, 12_000)
      expect(Date.now() - childSpawnedAt).toBeLessThan(12_000)
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(
        '[token-goat] post-merge: Running doctor repairs across configured harnesses timed out after 1500ms',
      )
      expect((await waitForProcessGone(pid, 4_000))?.code).toBe('ESRCH')
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      if (childPid !== undefined && Number.isInteger(childPid)) {
        killIfCommandLine(childPid, (commandLine) => commandLine.includes(childMarker), { tree: true })
      }
      await within(run.closed, 3_000).catch(() => {})
    }
  })

  it('ends an active step tree when the owner receives SIGTERM', { timeout: 30_000 }, async () => {
    const { main, hosts, log } = stageMain()
    const npmEnv = fastNpmEnvironment(main)
    const childPidFile = path.join(main, 'signal-child.pid')
    const stepPidFile = path.join(main, 'signal-step.pid')
    const childMarker = `token-goat-post-merge-signal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const bundleMarker = path.join(main, 'dist', 'token-goat.mjs')
    const run = spawnPostMerge(
      main,
      log,
      hosts,
      {
        TG_POST_MERGE_SYNC: '1',
        TG_POST_MERGE_STEP_TIMEOUT_MS: '60000',
        TG_POST_MERGE_TEST_HANG: '1',
        TG_POST_MERGE_TEST_STEP_PID: stepPidFile,
        TG_POST_MERGE_GRANDCHILD_PID: childPidFile,
        TG_POST_MERGE_GRANDCHILD_MARKER: childMarker,
        ...npmEnv,
      },
      true,
    )
    let childPid: number | undefined
    let stepPid: number | undefined
    try {
      await waitForFile(childPidFile, 10_000)
      const pid = Number(fs.readFileSync(childPidFile, 'utf8'))
      childPid = pid
      const step = Number(fs.readFileSync(stepPidFile, 'utf8'))
      stepPid = step
      expect(Number.isInteger(pid)).toBe(true)
      expect(Number.isInteger(step)).toBe(true)

      if (process.platform === 'win32') run.child.stdin?.write('SIGTERM')
      else expect(run.child.kill('SIGTERM')).toBe(true)

      const result = await within(run.closed, 10_000)
      if (process.platform === 'win32') {
        expect(result.status).toBe(143)
        expect(result.signal).toBeNull()
      } else {
        expect(result.signal).toBe('SIGTERM')
      }
      expect((await waitForProcessGone(pid, 4_000))?.code).toBe('ESRCH')
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      if (stepPid !== undefined && Number.isInteger(stepPid)) {
        killIfCommandLine(stepPid, (commandLine) => commandLine.includes(bundleMarker), { tree: true })
      }
      if (childPid !== undefined && Number.isInteger(childPid)) {
        killIfCommandLine(childPid, (commandLine) => commandLine.includes(childMarker), { tree: true })
      }
      await within(run.closed, 3_000).catch(() => {})
    }
  })

  it('retains only the bounded tail of a failed step stderr', () => {
    const { main, hosts, log } = stageMain()
    const head = 'HEAD_SENTINEL'
    const tail = 'TAIL_SENTINEL'
    fs.writeFileSync(
      path.join(main, 'build.mjs'),
      `process.stderr.write(${JSON.stringify(head)} + '✗'.repeat(60 * 1024) + 'x' + ${JSON.stringify(tail)})\nprocess.exitCode = 1\n`,
    )

    const res = runPostMerge(main, log, hosts, failingNpmPath())

    expect(res.status, res.stderr).toBe(1)
    expect(res.stderr).not.toContain(head)
    expect(res.stderr).toContain(tail)
    expect(res.stderr).not.toContain('\ufffd')
    expect(Buffer.byteLength(res.stderr, 'utf8')).toBeLessThan(70 * 1024)
  })

  it.each(['-1', '0', 'NaN', 'Infinity'])('uses a safe timeout for invalid value %s', (timeoutMs) => {
    const { main, hosts, log } = stageMain()
    const res = runPostMerge(main, log, hosts, {
      TG_POST_MERGE_SYNC: '1',
      TG_POST_MERGE_STEP_TIMEOUT_MS: timeoutMs,
      ...fastNpmEnvironment(main),
    })

    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('ERR_OUT_OF_RANGE')
  })
})
