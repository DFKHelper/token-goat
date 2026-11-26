#!/usr/bin/env node
/** `post-merge` / `post-rewrite` hook: automatically synchronize token-goat after git pull/merge/rebase. Automatically: 1. Checks if package-lock.json changed; if so, runs `npm install`. 2. Rebuilds the bundle (`npm run build`). 3. Stops resident hook-servers so fresh code is loaded on the next hook invocation. 4. Restarts the worker daemon. 5. Refreshes shims and instructions for Claude Code, and for Copilot CLI and Codex CLI only where token-goat already installed its shim there. 6. Triggers index update for any files needing re-parsing. In a linked worktree (`git worktree add`) it stops after step 2: steps 3-6 act on the user's real home, so running them from a scratch checkout would point every installed hook at that checkout's build and start a worker from it. It stops there too in a checkout that is not the active install (the global `token-goat` package, from `npm root -g`, resolves elsewhere, e.g. a registry install): the residents it started would run this checkout's build while the hooks run the other. When npm cannot say, or no global package exists, it syncs as before. The run says which of the two it took and why, and TG_POST_MERGE_SYNC=1 forces the full sync without asking npm (it does not lift the linked-worktree stop). */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { writeFileAtomically } from './atomic-write.mjs'
import { isMainModule } from './is-main-module.mjs'

import { npmCommand as resolveNpmCommand } from './dependabot-body.mjs'
import { gitExecutable } from './git-executable.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const npmInvocation = isWin
  ? resolveNpmCommand({ platform: process.platform, env: process.env, execPath: process.execPath, exists: fs.existsSync })
  : { file: 'npm', prefix: [] }
const nodeCmd = process.execPath
const bundlePath = path.join(projectRoot, 'dist', 'token-goat.mjs')
const failedSteps = []
const rawTimeout = Number(process.env.TG_POST_MERGE_STEP_TIMEOUT_MS)
const STEP_TIMEOUT_MS =
  Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(Math.max(1, Math.floor(rawTimeout)), 2_147_483_647)
    : 180_000
const MAX_CAPTURED_BYTES = 64 * 1024
const liveStepStops = new Set()
const OWNER_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const PROCESS_LIST_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'
export const PROCESS_TERMINATE_SCRIPT = [
  "Add-Type -ErrorAction Stop -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class TgWinProc {',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool GetProcessTimes(IntPtr handle, out long createFt, out long exitFt, out long kernelTime, out long userTime);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool TerminateProcess(IntPtr handle, uint exitCode);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool CloseHandle(IntPtr handle);',
  '  public static long KillIfCreatedAt(int pid, long expectedCreatedMs) {',
  '    IntPtr handle = OpenProcess(0x00101001, false, pid);',
  '    if (handle == IntPtr.Zero) return -1L;',
  '    try {',
  '      long createFt, exitFt, kernelTime, userTime;',
  '      if (!GetProcessTimes(handle, out createFt, out exitFt, out kernelTime, out userTime)) return -1L;',
  '      long createdMs = (createFt - 116444736000000000L) / 10000L;',
  '      if (createdMs != expectedCreatedMs) return -1L;',
  '      if (!TerminateProcess(handle, 1) && Marshal.GetLastWin32Error() != 5) return -1L;',
  '      if (WaitForSingleObject(handle, 2000) != 0) return -1L;',
  '      if (!GetProcessTimes(handle, out createFt, out exitFt, out kernelTime, out userTime)) return -1L;',
  '      createdMs = (createFt - 116444736000000000L) / 10000L;',
  '      if (createdMs != expectedCreatedMs || exitFt <= 116444736000000000L) return -1L;',
  '      long exitedMs = (exitFt - 116444736000000000L) / 10000L;',
  '      // Exclude the exit millisecond; process-list timestamps have millisecond precision.',
  '      return exitedMs > 0L ? exitedMs - 1L : -1L;',
  '    } finally {',
  '      CloseHandle(handle);',
  '    }',
  '  }',
  '}',
  "'@",
  '$targets = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())',
  'foreach ($t in @($targets)) {',
  '  $targetPid = [int]$t.pid',
  '  $targetCreatedMs = [long]$t.createdMs',
  '  $cutoffMs = -1L',
  '  try {',
  '    $cutoffMs = [TgWinProc]::KillIfCreatedAt($targetPid, $targetCreatedMs)',
  '  } catch {',
  '    [Console]::Error.WriteLine("[token-goat] post-merge: could not end survivor pid $($targetPid): $($_.Exception.Message)")',
  '  }',
  '  $result = [pscustomobject]@{ pid = $targetPid; createdMs = $targetCreatedMs; verified = ($cutoffMs -ge 0); cutoffMs = $cutoffMs }',
  '  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))',
  '}',
].join('\n')
const ownerSignalHandlers = {
  SIGINT: () => onOwnerSignal('SIGINT'),
  SIGTERM: () => onOwnerSignal('SIGTERM'),
  SIGHUP: () => onOwnerSignal('SIGHUP'),
}
let ownerListenersHooked = false

function npmLaunch(args) {
  if (npmInvocation === null) return null
  return { cmd: npmInvocation.file, args: [...npmInvocation.prefix, ...args] }
}

async function runNpmStep(label, args, options = {}) {
  const launch = npmLaunch(args)
  if (launch === null) return runStep(label, null, [], options)
  return runStep(label, launch.cmd, launch.args, options)
}

function endStepTree(child) {
  if (child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') child.kill('SIGKILL')
  }
}

function parseProcessRows(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const rows = []
  for (const row of Array.isArray(data) ? data : [data]) {
    if (typeof row?.p !== 'number' || typeof row.pp !== 'number' || typeof row.c !== 'number') return null
    rows.push({ pid: row.p, ppid: row.pp, createdMs: row.c })
  }
  return rows
}

export function selectSurvivors(rows, rootPid, spawnedAtMs, rootExitedAtMs, rootExited) {
  const created = new Map()
  const excludedPids = new Set([process.pid, process.ppid])
  const rootRow = rows.find((row) => row.pid === rootPid)
  const rootCreatedMs = rootRow?.createdMs
  if (rootCreatedMs !== undefined && rootCreatedMs < spawnedAtMs) return []
  const rootHasExited = rootExited ?? (rootCreatedMs === undefined || rootCreatedMs > rootExitedAtMs)
  if (
    rootCreatedMs !== undefined &&
    rootCreatedMs >= spawnedAtMs &&
    (!rootHasExited || rootCreatedMs <= rootExitedAtMs) &&
    !excludedPids.has(rootPid)
  ) {
    created.set(rootPid, rootCreatedMs)
  }
  const recycledRootCreatedMs = rootHasExited ? rootCreatedMs : undefined
  const parentCreatedMs = rootHasExited ? spawnedAtMs : Math.max(spawnedAtMs, rootCreatedMs ?? spawnedAtMs)
  for (const row of rows) {
    if (
      row.ppid === rootPid &&
      !excludedPids.has(row.pid) &&
      row.createdMs >= spawnedAtMs &&
      row.createdMs >= parentCreatedMs &&
      row.createdMs <= rootExitedAtMs &&
      (recycledRootCreatedMs === undefined || row.createdMs < recycledRootCreatedMs)
    ) {
      created.set(row.pid, row.createdMs)
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      const parentCreatedMs = created.get(row.ppid)
      if (
        parentCreatedMs === undefined ||
        created.has(row.pid) ||
        excludedPids.has(row.pid) ||
        row.createdMs < parentCreatedMs
      )
        continue
      created.set(row.pid, row.createdMs)
      grew = true
    }
  }
  return [...created].map(([pid, createdMs]) => ({ pid, createdMs }))
}

function isProcessIdentity(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    Number.isSafeInteger(value.createdMs) &&
    value.createdMs >= 0
  )
}

export function shouldKillSurvivor(target, current, excludedPids) {
  if (!isProcessIdentity(target) || !isProcessIdentity(current)) return false
  if (target.pid !== current.pid || target.createdMs !== current.createdMs) return false
  return !excludedPids?.has(target.pid)
}

export function killVerifiedSurvivors(
  targets,
  readCurrent,
  killFn,
  excludedPids = new Set([process.pid, process.ppid]),
) {
  const verifiedTargets = []
  for (const target of targets) {
    if (shouldKillSurvivor(target, readCurrent(target.pid), excludedPids)) verifiedTargets.push(target)
  }
  if (verifiedTargets.length > 0) killFn(verifiedTargets)
  return verifiedTargets
}

function selectWindowsOwnedTargets(
  rows,
  rootPid,
  spawnedAtMs,
  rootExitedAtMs,
  verifiedOwned,
  rootVerificationFailed,
) {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]))
  const excludedPids = new Set([process.pid, process.ppid])
  for (const [pid, owned] of verifiedOwned) {
    const current = rowsByPid.get(pid)
    if (current === undefined) continue
    if (current.createdMs === owned.createdMs) {
      owned.maxChildCreatedMs = Infinity
    } else {
      owned.maxChildCreatedMs = Math.min(owned.maxChildCreatedMs, current.createdMs - 1)
    }
  }

  const targets = new Map()
  const pending = []
  const addTarget = (row) => {
    if (excludedPids.has(row.pid)) return
    const prior = verifiedOwned.get(row.pid)
    if (prior !== undefined && prior.createdMs !== row.createdMs) return
    if (targets.has(row.pid)) return
    const target = { pid: row.pid, createdMs: row.createdMs }
    targets.set(row.pid, target)
    pending.push(row)
  }

  const rootSurvivors = rootVerificationFailed
    ? []
    : selectSurvivors(rows, rootPid, spawnedAtMs, rootExitedAtMs)
  const ownedRoot = verifiedOwned.get(rootPid)
  for (const target of rootSurvivors) {
    if (target.pid !== rootPid && rowsByPid.get(target.pid)?.ppid !== rootPid) continue
    const row = rowsByPid.get(target.pid)
    if (row === undefined || row.createdMs !== target.createdMs) continue
    if (row.ppid === rootPid && ownedRoot !== undefined) {
      const maxChildCreatedMs = Math.min(ownedRoot.maxChildCreatedMs, rootExitedAtMs)
      if (row.createdMs < ownedRoot.createdMs || row.createdMs > maxChildCreatedMs) continue
    }
    addTarget(row)
  }

  for (const [pid, owned] of verifiedOwned) {
    const current = rowsByPid.get(pid)
    if (current !== undefined && current.createdMs === owned.createdMs) addTarget(current)
    const maxChildCreatedMs =
      pid === rootPid ? Math.min(owned.maxChildCreatedMs, rootExitedAtMs) : owned.maxChildCreatedMs
    for (const row of rows) {
      if (
        row.ppid !== pid ||
        row.createdMs < owned.createdMs ||
        row.createdMs > maxChildCreatedMs
      ) {
        continue
      }
      addTarget(row)
    }
  }

  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index]
    for (const row of rows) {
      if (row.ppid === parent.pid && row.createdMs >= parent.createdMs) addTarget(row)
    }
  }
  return [...targets.values()]
}

export function drainWindowsOwnedTree(
  rootPid,
  spawnedAtMs,
  rootExitedAtMs,
  { snapshotFn, killBatchFn, maxPasses = 4 },
) {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1) {
    throw new RangeError('maxPasses must be a positive safe integer')
  }
  const verifiedOwned = new Map()
  let rootVerificationFailed = false
  for (let pass = 1; pass <= maxPasses; pass++) {
    const rows = snapshotFn()
    if (!Array.isArray(rows)) return { status: 'aborted', passes: pass, reason: 'snapshot' }
    // Selection may widen live-owner bounds; keep only handle-verified bounds between passes.
    const ownersForSelection = new Map(
      [...verifiedOwned].map(([pid, owned]) => [pid, { ...owned }]),
    )
    const targets = selectWindowsOwnedTargets(
      rows,
      rootPid,
      spawnedAtMs,
      rootExitedAtMs,
      ownersForSelection,
      rootVerificationFailed,
    )
    if (targets.length === 0) return { status: 'converged', passes: pass }

    const killResult = killBatchFn(targets)
    if (killResult === false) return { status: 'aborted', passes: pass, reason: 'kill' }
    if (!Array.isArray(killResult) || killResult.length !== targets.length) {
      return { status: 'aborted', passes: pass, reason: 'kill' }
    }
    const cutoffsByPid = new Map()
    for (const result of killResult) {
      if (
        !Number.isSafeInteger(result?.pid) ||
        !Number.isSafeInteger(result?.createdMs) ||
        typeof result?.verified !== 'boolean' ||
        !Number.isSafeInteger(result?.cutoffMs) ||
        (result.verified ? result.cutoffMs < 0 : result.cutoffMs !== -1) ||
        cutoffsByPid.has(result.pid)
      ) {
        return { status: 'aborted', passes: pass, reason: 'kill' }
      }
      cutoffsByPid.set(result.pid, result)
    }
    for (const target of targets) {
      const result = cutoffsByPid.get(target.pid)
      if (result === undefined || result.createdMs !== target.createdMs) {
        return { status: 'aborted', passes: pass, reason: 'kill' }
      }
      if (result.verified) {
        verifiedOwned.set(target.pid, {
          createdMs: target.createdMs,
          maxChildCreatedMs: result.cutoffMs,
        })
      } else if (target.pid === rootPid) {
        rootVerificationFailed = true
      }
    }
  }
  return { status: 'exhausted', passes: maxPasses }
}

function windowsPowerShellPath() {
  const fallback = path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const root of [process.env.SystemRoot, process.env.windir, 'C:\\Windows']) {
    if (root === undefined || !path.win32.isAbsolute(root)) continue
    const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(executable)) return executable
  }
  return fallback
}

function runWindowsPowerShell(script, input) {
  const options = {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }
  if (input !== undefined) options.input = JSON.stringify(input)
  return spawnSync(
    windowsPowerShellPath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
    ],
    options,
  )
}

function powerShellFailure(result) {
  return result.error?.message ?? (result.status === null ? 'no status' : `status ${result.status}`)
}

function endSurvivors(rootPid) {
  if (rootPid === undefined) return
  try {
    process.kill(-rootPid, 0)
    process.kill(-rootPid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      process.stderr.write(`[token-goat] post-merge: could not end process group ${rootPid}: ${error.message}\n`)
    }
  }
}

export function endWindowsOwnedTree(rootPid, spawnedAtMs, rootExitedAtMs, options) {
  if (rootPid === undefined) return
  const { runWindowsPowerShellFn = runWindowsPowerShell, ...drainOptions } = options ?? {}
  const result = drainWindowsOwnedTree(
    rootPid,
    spawnedAtMs,
    rootExitedAtMs,
    {
      snapshotFn: () => {
        const snapshotResult = runWindowsPowerShellFn(PROCESS_LIST_SCRIPT)
        const rows =
          snapshotResult.status === 0 && typeof snapshotResult.stdout === 'string'
            ? parseProcessRows(snapshotResult.stdout)
            : null
        if (rows === null) {
          process.stderr.write(
            `[token-goat] post-merge: could not list survivors of pid ${rootPid}: ${powerShellFailure(snapshotResult)}\n`,
          )
        }
        return rows
      },
      killBatchFn: (targets) => {
        const terminationResult = runWindowsPowerShellFn(PROCESS_TERMINATE_SCRIPT, targets)
        if (typeof terminationResult.stderr === 'string' && terminationResult.stderr.length > 0) {
          process.stderr.write(terminationResult.stderr)
        }
        if (terminationResult.status !== 0) {
          process.stderr.write(
            `[token-goat] post-merge: could not end survivors of pid ${rootPid}: ${powerShellFailure(terminationResult)}\n`,
          )
          return false
        }
        let terminationRows
        try {
          terminationRows = terminationResult.stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        } catch (error) {
          process.stderr.write(
            `[token-goat] post-merge: could not parse termination results for pid ${rootPid}: ${error.message}\n`,
          )
          return false
        }
        const cutoffsByPid = new Map()
        const validCutoffs =
          terminationRows.length === targets.length &&
          terminationRows.every((row) => {
            if (
              row === null ||
              typeof row !== 'object' ||
              !Number.isSafeInteger(row.pid) ||
              !Number.isSafeInteger(row.createdMs) ||
              !Number.isSafeInteger(row.cutoffMs) ||
              typeof row.verified !== 'boolean' ||
              (row.verified ? row.cutoffMs < 0 : row.cutoffMs !== -1) ||
              cutoffsByPid.has(row.pid)
            ) {
              return false
            }
            cutoffsByPid.set(row.pid, row)
            return true
          }) &&
          targets.every((target) => {
            const row = cutoffsByPid.get(target.pid)
            return row !== undefined && row.createdMs === target.createdMs
          })
        if (!validCutoffs) {
          process.stderr.write(
            `[token-goat] post-merge: invalid termination results for survivors of pid ${rootPid}\n`,
          )
          return false
        }
        return terminationRows
      },
      ...drainOptions,
    },
  )
  if (result.status === 'exhausted') {
    process.stderr.write(
      `[token-goat] post-merge: could not confirm process tree of pid ${rootPid} ended after ${result.passes} passes\n`,
    )
  }
  return result
}

function onOwnerExit() {
  for (const stop of [...liveStepStops]) stop()
}

function onOwnerSignal(signal) {
  unhookOwnerListeners()
  for (const stop of [...liveStepStops]) stop()
  if (isWin) {
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129)
  }
  process.kill(process.pid, signal)
}

function hookOwnerListeners() {
  if (ownerListenersHooked) return
  ownerListenersHooked = true
  process.on('exit', onOwnerExit)
  for (const signal of OWNER_SIGNALS) process.on(signal, ownerSignalHandlers[signal])
}

function unhookOwnerListeners() {
  if (!ownerListenersHooked) return
  ownerListenersHooked = false
  process.removeListener('exit', onOwnerExit)
  for (const signal of OWNER_SIGNALS) process.removeListener(signal, ownerSignalHandlers[signal])
}

function registerLiveStepStop(stop) {
  liveStepStops.add(stop)
  hookOwnerListeners()
  return () => {
    liveStepStops.delete(stop)
    if (liveStepStops.size === 0) unhookOwnerListeners()
  }
}

async function runStep(label, cmd, args, options = {}) {
  process.stdout.write(`[token-goat post-merge] ${label}... `)
  const start = Date.now()
  const res =
    cmd === null
      ? { status: null, error: new Error('npm-cli.js was not found in npm_execpath or beside Node'), stderr: null }
      : await new Promise((resolve) => {
          const spawnedAtMs = Date.now()
          const child = spawn(cmd, args, {
            cwd: projectRoot,
            ...options,
            // owner: post-merge runStep owns the step tree; dies when the step exits, times out, or its owner exits or receives SIGINT, SIGTERM, or SIGHUP
            detached: !isWin,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1' },
            windowsHide: true,
          })
          const stderrChunks = []
          let stderrBytes = 0
          let truncatedStderr = false
          let spawnError
          let rootExited = false
          let rootExitedAtMs
          let exitCode = null
          let exitSignal = null
          let timedOut = false
          let timeoutError
          let settled = false
          let timeout
          let removeLiveStepStop = () => {}
          const finish = (status, error, signal = null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            removeLiveStepStop()
            child.stdout?.destroy()
            child.stderr?.destroy()
            const stderrBuf = Buffer.concat(stderrChunks, stderrBytes)
            let stderrStart = 0
            if (truncatedStderr) {
              while (
                stderrStart < 3 &&
                stderrStart < stderrBuf.length &&
                (stderrBuf[stderrStart] & 0xc0) === 0x80
              ) {
                stderrStart++
              }
            }
            resolve({ status, signal, error, stderr: stderrBuf.subarray(stderrStart).toString('utf8') })
          }
          const stopTree = () => {
            if (isWin) {
              endWindowsOwnedTree(
                child.pid,
                spawnedAtMs,
                rootExited ? rootExitedAtMs : Date.now() + 5000,
              )
              if (!rootExited) {
                try {
                  child.kill('SIGKILL')
                } catch (error) {
                  process.stderr.write(
                    `[token-goat] post-merge: could not signal live step pid ${child.pid}: ${error.message}\n`,
                  )
                }
              }
            } else if (!rootExited) {
              endStepTree(child)
            } else {
              endSurvivors(child.pid)
            }
          }
          removeLiveStepStop = registerLiveStepStop(() => {
            stopTree()
            finish(
              rootExited ? exitCode : child.exitCode,
              Object.assign(new Error('owner stopped'), { code: 'ABORT_ERR' }),
              rootExited ? exitSignal : child.signalCode,
            )
          })
          timeout = setTimeout(() => {
            timedOut = true
            timeoutError = Object.assign(new Error('step timed out'), { code: 'ETIMEDOUT' })
            stopTree()
            finish(rootExited ? exitCode : child.exitCode, timeoutError, rootExited ? exitSignal : child.signalCode)
          }, STEP_TIMEOUT_MS)
          child.once('exit', (code, signal) => {
            rootExited = true
            rootExitedAtMs = Date.now()
            exitCode = code
            exitSignal = signal
          })
          child.stdout.on('data', () => {})
          child.stderr.on('data', (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (bytes.length >= MAX_CAPTURED_BYTES) {
              if (stderrBytes > 0 || bytes.length > MAX_CAPTURED_BYTES) truncatedStderr = true
              stderrChunks.splice(0, stderrChunks.length, Buffer.from(bytes.subarray(bytes.length - MAX_CAPTURED_BYTES)))
              stderrBytes = MAX_CAPTURED_BYTES
              return
            }
            stderrChunks.push(Buffer.from(bytes))
            stderrBytes += bytes.length
            while (stderrBytes > MAX_CAPTURED_BYTES) {
              const excess = stderrBytes - MAX_CAPTURED_BYTES
              const first = stderrChunks[0]
              if (first.length <= excess) {
                truncatedStderr = true
                stderrChunks.shift()
                stderrBytes -= first.length
              } else {
                truncatedStderr = true
                stderrChunks[0] = Buffer.from(first.subarray(excess))
                stderrBytes -= excess
              }
            }
          })
          child.on('error', (error) => {
            spawnError = error
            if (child.pid === undefined) finish(null, error)
          })
          child.on('close', (status, signal) => {
            finish(status, timedOut ? timeoutError : spawnError, signal)
          })
        })
  const duration = Date.now() - start
  if (res.status === 0 && !res.error) {
    process.stdout.write(`done (${duration}ms)\n`)
    return true
  }
  process.stdout.write(`failed (${duration}ms)\n`)
  failedSteps.push(label)
  if (res.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`[token-goat] post-merge: ${label} timed out after ${STEP_TIMEOUT_MS}ms\n`)
  } else if (res.error) {
    process.stderr.write(`${res.error.message}\n`)
  }
  if (res.stderr) {
    process.stderr.write(`${res.stderr}\n`)
  }
  return false
}

/** True when a token-goat hook shim (current `.cjs` or the older `.js`) sits in `hooksDir`. Only token-goat's own install writes it, so it marks a host token-goat was already wired into; a machine without that host, or one the maintainer never opted in, gets no refresh and no new files. */
function hasShim(hooksDir) {
  return ['token-goat-shim.cjs', 'token-goat-shim.js'].some((name) => fs.existsSync(path.join(hooksDir, name)))
}

/** `$CODEX_HOME` when non-empty, else `~/.codex`: `codexHomeDir` in src/purge.ts, which Codex resolves the same way. */
function codexHomeRoot() {
  const override = process.env.CODEX_HOME
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex')
}

function codexHooksDir() {
  return path.join(codexHomeRoot(), 'hooks')
}

/** `$CLAUDE_CONFIG_DIR` when non-empty, else `~/.claude`: `claudeConfigDir` in src/claude_config_dir.ts. */
function claudeConfigRoot() {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override ? override : path.join(os.homedir(), '.claude')
}

/** The host files holding token-goat's hook entries, keyed by the install step that writes each one. */
function hostConfigFiles() {
  return {
    claudeUser: path.join(claudeConfigRoot(), 'settings.json'),
    claudeProject: path.join(projectRoot, '.claude', 'settings.json'),
    copilotUser: path.join(copilotUserHooksDir(), 'token-goat.json'),
    copilotProject: path.join(projectRoot, '.github', 'hooks', 'token-goat.json'),
    codex: path.join(codexHomeRoot(), 'config.toml'),
  }
}

/** Slash-folded, and case-folded on Windows, so a JSON-escaped or backslash path compares with the bundle path. */
function normalizedPath(text) {
  const folded = text.replace(/[\\/]+/g, '/')
  return isWin ? folded.toLowerCase() : folded
}

/** 'here' when the file holds a token-goat entry naming this checkout's bundle, 'elsewhere' when it names another path, else 'absent'. */
function hookEntryState(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 'absent'
  }
  if (!text.includes('token-goat')) return 'absent'
  return normalizedPath(text).includes(normalizedPath(bundlePath)) ? 'here' : 'elsewhere'
}

/** `--dev` for an install step writing to `file`, only when that file's entry already names this checkout: the gap a sync repairs. */
function devFlagFor(file) {
  return hookEntryState(file) === 'here' ? ['--dev'] : []
}

/** `--dev` for doctor --repair, which repairs every host: only when some entry names this checkout and none names another path. */
function doctorDevFlag() {
  const states = Object.values(hostConfigFiles()).map(hookEntryState)
  return states.includes('here') && !states.includes('elsewhere') ? ['--dev'] : []
}

/** `$COPILOT_HOME` when not blank, else `~/.copilot`: `copilotCliUserRoot` in src/copilot_home.ts. */
function copilotUserHooksDir() {
  const override = process.env.COPILOT_HOME
  return path.join(override && override.trim() !== '' ? path.resolve(override) : path.join(os.homedir(), '.copilot'), 'hooks')
}

function gitChangedFiles() {
  const executable = gitExecutable(projectRoot)
  if (executable === null) return []
  const diff = spawnSync(executable, ['diff-tree', '-r', '--name-only', '--no-commit-id', 'ORIG_HEAD', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (diff.status === 0 && diff.stdout) {
    return diff.stdout.split(/\r?\n/).filter(Boolean)
  }
  return []
}

/** True when `cwd` is a linked worktree rather than the main checkout: a linked worktree's git dir is `.git/worktrees/<name>`, apart from the common dir every checkout of the repository shares. */
function isLinkedWorktree(cwd) {
  const executable = gitExecutable(cwd)
  if (executable === null) return false
  const res = spawnSync(executable, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  })
  if (res.status !== 0 || !res.stdout) return false
  const [gitDir, commonDir] = res.stdout.split(/\r?\n/).filter(Boolean)
  return Boolean(gitDir && commonDir) && path.resolve(gitDir) !== path.resolve(commonDir)
}

/** What npm says about the global token-goat: `{ dir }` with the directory a global `npm install` really lives in, else `{ dir: null, reason }` naming why there is none. `npm install -g .` links the checkout into npm's global root (`npm root -g`), a registry install puts a real copy there, so the realpath says which one the user runs. No dir means npm cannot say or no global token-goat exists: the evidence is missing, not against this checkout. Unbounded in time like `installedLauncher` in src/cli_upgrade.ts: `npm root -g` reads no network and a deadline would only turn a slow machine into a wrong answer. */
function globalInstallDir() {
  const launch = npmLaunch(['root', '-g'])
  if (launch === null) return { dir: null, reason: '`npm root -g` could not run because npm-cli.js was not found' }
  const res = spawnSync(launch.cmd, launch.args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  if (res.status !== 0 || typeof res.stdout !== 'string') {
    return { dir: null, reason: `\`npm root -g\` failed (${res.error ? res.error.message : `exit ${res.status}`})` }
  }
  const root = res.stdout.trim()
  if (!root) return { dir: null, reason: '`npm root -g` printed nothing' }
  try {
    return { dir: fs.realpathSync.native(path.join(root, 'token-goat')) }
  } catch {
    return { dir: null, reason: `no global token-goat package under ${root}` }
  }
}

/** Whether this checkout is the install the hooks run: `{ other, reason }`, with `other` the global install directory when it is somewhere else (build only) and null when the full sync should run, `reason` saying why. TG_POST_MERGE_SYNC=1 forces the full sync without asking npm. Both sides go through realpath, and compare case-folded on Windows, where one directory has several spellings. */
function installDecision() {
  if (process.env.TG_POST_MERGE_SYNC === '1') return { other: null, reason: 'TG_POST_MERGE_SYNC=1 forces it' }
  const found = globalInstallDir()
  if (found.dir === null) return { other: null, reason: `${found.reason}, so nothing says another install is active` }
  const fold = (p) => (isWin ? p.toLowerCase() : p)
  let here
  try {
    here = fs.realpathSync.native(projectRoot)
  } catch {
    return { other: null, reason: 'this checkout\'s own path does not resolve, so nothing says another install is active' }
  }
  if (fold(path.resolve(found.dir)) === fold(path.resolve(here))) return { other: null, reason: 'the global token-goat is this checkout' }
  return { other: found.dir, reason: `the global token-goat is ${found.dir}` }
}

/** Where `node_modules` really lives when it is a symlink or junction resolving outside this checkout (a linked worktree sharing the main checkout's install), else null. lstat sees the link itself and realpath follows it; Node reports a Windows junction as a symbolic link to lstat, which `tests/post_merge_lock_and_links.test.ts` pins. */
function externalNodeModules() {
  const modules = path.join(projectRoot, 'node_modules')
  try {
    if (!fs.lstatSync(modules).isSymbolicLink()) return null
    const target = fs.realpathSync(modules)
    const rel = path.relative(fs.realpathSync(projectRoot), target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? null : target
  } catch {
    return null
  }
}

/** `npm install` on npm 11.6.2 rewrites package-lock.json without its `libc` arrays, so the committed bytes (or the user's own uncommitted edit) are snapshotted before it and written back after it; not `git checkout`, which would discard an uncommitted edit. */
async function installKeepingLock() {
  const lockPath = path.join(projectRoot, 'package-lock.json')
  const before = fs.readFileSync(lockPath)
  const installed = await runNpmStep('Updating dependencies (package-lock.json changed)', ['install', '--prefer-offline'])
  const after = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null
  if (after === null || !before.equals(after)) {
    writeFileAtomically(lockPath, before)
    console.log('[token-goat post-merge] npm install rewrote package-lock.json; restored the bytes it had before the install.')
  }
  return installed
}

async function main() {
  const changed = gitChangedFiles()
  console.log('[token-goat post-merge] Synchronizing token-goat after git pull/merge...')

  // 1. Dependency update if lockfile changed
  if (changed.includes('package-lock.json')) {
    const shared = externalNodeModules()
    if (shared !== null) {
      console.log(`[token-goat post-merge] Skipping npm install: node_modules is a link to ${shared}, outside this checkout, and an install here would change it for every checkout sharing it.`)
    } else {
      if (!(await installKeepingLock())) {
        console.error('[token-goat post-merge] npm install failed; aborting build and synchronization.')
        process.exitCode = 1
        return
      }
    }
  }

  // 2. Build dist/token-goat.mjs
  const built = await runNpmStep('Building token-goat bundle', ['run', 'build'])
  if (!built || !fs.existsSync(bundlePath)) {
    console.error('[token-goat post-merge] Build failed; aborting daemon and shim reload.')
    process.exit(1)
  }

  if (isLinkedWorktree(projectRoot)) {
    console.log(
      '[token-goat post-merge] Linked worktree: built the bundle only. The installed hooks, shims, worker and index belong to the main checkout, so run `npm run sync` there to move them to a new build.' + (process.env.TG_POST_MERGE_SYNC === '1' ? ' TG_POST_MERGE_SYNC=1 does not lift this stop.' : ''),
    )
    return
  }

  const decision = installDecision()
  if (decision.other !== null) {
    console.log(
      `[token-goat post-merge] Build only, not the active install: ${decision.reason}, so left the hooks, shims, worker, index and doctor alone. To make this checkout the active install, run \`npm install -g .\` here, then \`token-goat install\`; \`npm run sync\` keeps it current after that. To run the full sync anyway, set TG_POST_MERGE_SYNC=1.`,
    )
    return
  }
  console.log(`[token-goat post-merge] Full sync: ${decision.reason}.`)

  // 3. Stop resident hook servers (they will respawn with the new build on next hook call)
  await runStep('Stopping resident hook servers', nodeCmd, [bundlePath, 'hook-server', 'stop'])

  // 4. Restart worker daemon
  const workerStopped = await runStep('Restarting worker daemon', nodeCmd, [bundlePath, 'worker', 'stop'])
  if (workerStopped) await runStep('Starting worker daemon', nodeCmd, [bundlePath, 'worker', 'start'])

  // 5. Refresh shims and instructions across harnesses
  await runStep('Refreshing Claude Code hooks & shims', nodeCmd, [bundlePath, 'install', ...devFlagFor(hostConfigFiles().claudeUser)])
  // The other hosts are refreshed only where token-goat's shim already is: `install --codex` or `--copilot` on a machine without that host would create its config directory and wire hooks into a tool the user does not have.
  if (hasShim(copilotUserHooksDir())) {
    await runStep('Refreshing Copilot CLI user hooks & shims', nodeCmd, [bundlePath, 'install', '--copilot', ...devFlagFor(hostConfigFiles().copilotUser)])
  }
  if (hasShim(path.join(projectRoot, '.github', 'hooks'))) {
    await runStep('Refreshing Copilot CLI project hooks & shims', nodeCmd, [bundlePath, 'install', '--copilot', '--local', ...devFlagFor(hostConfigFiles().copilotProject)])
  }
  if (hasShim(codexHooksDir())) {
    await runStep('Refreshing Codex CLI hooks & shims', nodeCmd, [bundlePath, 'install', '--codex', ...devFlagFor(hostConfigFiles().codex)])
  }
  await runStep('Running doctor repairs across configured harnesses', nodeCmd, [bundlePath, 'doctor', '--repair', ...doctorDevFlag()])

  // 6. Prune and index
  await runStep('Pruning stale index entries', nodeCmd, [bundlePath, 'project', 'prune'])
  await runStep('Reindexing updated files', nodeCmd, [bundlePath, 'index'])

  if (failedSteps.length > 0) {
    console.error(`[token-goat post-merge] Synchronization incomplete; failed steps: ${failedSteps.join(', ')}`)
    process.exitCode = 1
    return
  }
  console.log('[token-goat post-merge] ✔️ Synchronization complete. Token-goat is up to date.')
}

if (isMainModule(import.meta.url)) {
  await main()
}
