/**
 * Process table and MCP process health diagnostics for token-goat doctor.
 *
 * Checks running Windows processes, orphan Node processes, duplicate MCP launchers,
 * and the worker daemon state.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DoctorResult } from './doctor_result.js'
import { isWorkerRunning } from './worker.js'

export interface ProcessInfo {
  processId: number
  parentProcessId: number
  name: string
  commandLine: string
}

export function checkMcpProcessHealth(processes: readonly ProcessInfo[] | null): DoctorResult {
  if (processes === null) {
    return {
      name: 'MCP process health',
      status: 'warn',
      message: 'could not read the process list (PowerShell did not answer), so duplicate MCP launchers and orphaned Node processes were not checked',
    }
  }
  const byPid = new Set(processes.map((process) => process.processId))
  const nodeProcesses = processes.filter((process) => process.name.toLowerCase() === 'node.exe')
  const chromeLaunchers = nodeProcesses.filter((process) => /npx-cli\.js.*chrome-devtools-mcp/i.test(process.commandLine))
  const playwrightLaunchers = nodeProcesses.filter((process) => /npx-cli\.js.*@playwright[\\/]mcp/i.test(process.commandLine))
  const orphanedNodeProcesses = nodeProcesses.filter(
    (process) => !byPid.has(process.parentProcessId) && !/--worker-daemon\b/.test(process.commandLine),
  )
  const launchers = chromeLaunchers.length + playwrightLaunchers.length

  if (launchers > 2 || orphanedNodeProcesses.length > 0) {
    const details: string[] = []
    if (chromeLaunchers.length > 1) details.push(`${chromeLaunchers.length} Chrome DevTools MCP launchers`)
    if (playwrightLaunchers.length > 1) details.push(`${playwrightLaunchers.length} Playwright MCP launchers`)
    if (orphanedNodeProcesses.length > 0) details.push(`${orphanedNodeProcesses.length} orphaned Node process${orphanedNodeProcesses.length === 1 ? '' : 'es'}`)
    return {
      name: 'MCP process health',
      status: 'warn',
      message: `${details.join('; ')} detected. These are host-managed processes; close stale Copilot sessions before terminating a specific confirmed orphan.`,
    }
  }

  return { name: 'MCP process health', status: 'ok', message: 'no duplicate MCP launchers or orphaned Node processes detected' }
}

function runProcessListCommand(): string {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(fs.existsSync(shell) ? shell : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  return result.stdout ?? ''
}

/**
 * `null` when the process list could not be read at all, so a caller can tell that apart from an
 * empty machine.
 */
export function readWindowsProcesses(runCommand: () => string = runProcessListCommand): ProcessInfo[] | null {
  if (process.platform !== 'win32') return []
  try {
    const output = runCommand().trim()
    if (output === '') return []
    const parsed: unknown = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row): ProcessInfo[] => {
      if (typeof row !== 'object' || row === null) return []
      const value = row as Record<string, unknown>
      if (typeof value['ProcessId'] !== 'number' || typeof value['ParentProcessId'] !== 'number' || typeof value['Name'] !== 'string') return []
      return [{
        processId: value['ProcessId'],
        parentProcessId: value['ParentProcessId'],
        name: value['Name'],
        commandLine: typeof value['CommandLine'] === 'string' ? value['CommandLine'] : '',
      }]
    })
  } catch {
    return null
  }
}

/**
 * Check if the token-goat worker process is running for `dataDir`.
 */
export function checkWorkerRunning(dataDir?: string): boolean {
  return dataDir !== undefined ? isWorkerRunning(dataDir) : isWorkerRunning()
}
