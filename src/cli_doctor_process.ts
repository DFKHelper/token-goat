/** Process table and MCP process health diagnostics for token-goat doctor. Checks running Windows processes, orphan Node processes, duplicate MCP launchers, and the worker daemon state. */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DoctorResult } from './doctor_result.js'
import { displaySafeText } from './paths.js'
import { isWorkerRunning } from './worker.js'

export interface ProcessInfo {
  processId: number
  parentProcessId: number
  name: string
  commandLine: string
}

/** Why the process list could not be read, in words doctor prints as they are. `transient` marks the one failure that running doctor again later can cure: a query that timed out on a loaded machine. */
export interface ProcessListFailure {
  readonly reason: string
  readonly transient?: true
}

/** The process-list query ran past {@link PROCESS_LIST_TIMEOUT_MS}. */
class ProcessListTimeout extends Error {}

/** How long the process-list query may run. A loaded machine can push Get-CimInstance past it, which is the usual reason the list is missing. */
const PROCESS_LIST_TIMEOUT_MS = 20_000

// Interpreter/shell basenames to skip when picking the token that names the actual script -- a real Windows command line quotes the interpreter's own path first (`"C:\Program Files\nodejs\node.exe" orphan_probe.js`), which itself ends in .exe and would otherwise win as the first match.
const INTERPRETER_BASENAMES = new Set(['node.exe', 'python.exe', 'python3.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe'])

// The basename of the first non-interpreter token in `commandLine` ending in a common script/binary extension, falling back to a truncated command line when nothing script-shaped is found -- a bare PID told a user's agent nothing about what it actually was, and it once reported three of these as "stale token-goat workers" to kill, when they were an unrelated scheduler script this same check already excludes from ever being token-goat's own.
function describeProcess(commandLine: string): string {
  for (const m of commandLine.matchAll(/[^\s"]+\.(?:js|mjs|cjs|ts|py|exe)\b/gi)) {
    const basename = m[0].replace(/\\/g, '/').split('/').pop() ?? m[0]
    if (!INTERPRETER_BASENAMES.has(basename.toLowerCase())) return basename
  }
  const trimmed = commandLine.trim()
  return trimmed.length > 0 ? (trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed) : '(no command line)'
}

export function checkMcpProcessHealth(processes: readonly ProcessInfo[] | ProcessListFailure): DoctorResult {
  if (!Array.isArray(processes)) {
    const failure = processes as ProcessListFailure
    const query = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine`
    const advice = failure.transient === true ? `Run doctor again once the machine is less busy, or list them yourself with: ${query}` : `List them yourself with: ${query}`
    return {
      name: 'MCP process health',
      status: 'warn',
      message: `could not read the process list (${displaySafeText(failure.reason)}), so duplicate MCP launchers and orphaned Node processes were not checked. ${advice}`,
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
    if (chromeLaunchers.length > 1) details.push(`${chromeLaunchers.length} Chrome DevTools MCP launchers (PIDs: ${chromeLaunchers.map((p) => p.processId).join(', ')})`)
    if (playwrightLaunchers.length > 1) details.push(`${playwrightLaunchers.length} Playwright MCP launchers (PIDs: ${playwrightLaunchers.map((p) => p.processId).join(', ')})`)
    if (orphanedNodeProcesses.length > 0) {
      const described = orphanedNodeProcesses.map((p) => `${p.processId} (${describeProcess(p.commandLine)})`).join(', ')
      details.push(`${orphanedNodeProcesses.length} orphaned Node process${orphanedNodeProcesses.length === 1 ? '' : 'es'}: ${described}`)
    }
    return {
      name: 'MCP process health',
      status: 'warn',
      message: `${details.join('; ')} detected. None of these are token-goat's own processes -- they are host-managed Node/MCP processes left by closed terminal or CLI sessions; confirm what each one is (the name shown above is a starting point) before stopping it with Stop-Process -Id <PID>.`,
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
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  return processListOutput(result)
}

/** The process list PowerShell printed, or an error saying why there is none. A non-zero exit with nothing on stdout used to come back as an empty list, which doctor reported as a clean bill of health; a non-zero exit that still printed a list keeps it, because the rows it printed are real. */
export function processListOutput(result: Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'stdout' | 'stderr'>): string {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') throw new ProcessListTimeout(`PowerShell did not finish within ${PROCESS_LIST_TIMEOUT_MS / 1000}s`)
    if (code === 'ENOENT') throw new Error('powershell.exe was not found')
    throw result.error
  }
  const stdout = result.stdout ?? ''
  if (result.status !== 0 && stdout.trim() === '') {
    const firstLine = (result.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    throw new Error(`PowerShell exited with code ${String(result.status)}${firstLine !== undefined ? `: ${firstLine}` : ''}`)
  }
  return stdout
}

/** A {@link ProcessListFailure} when the process list could not be read at all, so a caller can tell that apart from an empty machine. */
export function readWindowsProcesses(runCommand: () => string = runProcessListCommand): ProcessInfo[] | ProcessListFailure {
  if (process.platform !== 'win32') return []
  try {
    const output = runCommand().trim()
    if (output === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      return { reason: 'PowerShell printed something other than the JSON process list' }
    }
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
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return e instanceof ProcessListTimeout ? { reason, transient: true } : { reason }
  }
}

/** Check if the token-goat worker process is running for `dataDir`. */
export function checkWorkerRunning(dataDir?: string): boolean {
  return dataDir !== undefined ? isWorkerRunning(dataDir) : isWorkerRunning()
}
