/**
 * Doctor CLI helpers — diagnose token-goat health.
 *
 * Provides check utilities and the runDoctor() entrypoint for the doctor command.
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync, spawnSync } from 'child_process'
import { parse } from 'smol-toml'
import { extractErrorMessage, toKB } from './util.js'
import { isWorkerRunning } from './worker.js'
import { getDb } from './db.js'
import { dataDir as defaultDataDir, configPath as defaultConfigPath } from './constants.js'
import { runContextStats } from './cli_context_stats.js'
import { skillOutputsDir } from './skill_cache.js'
import { copilotCliConfigPath, copilotCliScriptPath } from './bridges/copilot_cli_install.js'

/**
 * Result of a single doctor check.
 */
export interface DoctorResult {
  name: string
  status: 'ok' | 'warn' | 'fail'
  message: string
}

/**
 * Check if the token-goat worker process is running.
 */
export function checkWorkerRunning(): boolean {
  return isWorkerRunning()
}

/**
 * Check if the data directory and database files exist.
 */
export function checkDbExists(dataDir: string): DoctorResult {
  const dbPath = path.join(dataDir, 'global.db')
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'Database',
      status: 'warn',
      message: `global.db not found at ${dbPath}`,
    }
  }
  const sizeBytes = fs.statSync(dbPath).size
  const SQLITE_HEADER = 'SQLite format 3\0'
  let header = ''
  try {
    const fd = fs.openSync(dbPath, 'r')
    try {
      const buf = Buffer.alloc(SQLITE_HEADER.length)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      header = buf.toString('latin1', 0, bytesRead)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // treat an unreadable file as invalid below
  }
  if (header !== SQLITE_HEADER) {
    return {
      name: 'Database',
      status: 'fail',
      message: `global.db at ${dbPath} is not a valid SQLite file (${sizeBytes} bytes) — likely truncated or corrupt`,
    }
  }
  return {
    name: 'Database',
    status: 'ok',
    message: `global.db exists (${toKB(sizeBytes)} KB)`,
  }
}

/**
 * Check that the index actually contains symbols when it has indexed files.
 *
 * Guards against the worker-draining-to-a-stub-callback failure mode (see
 * CLAUDE.md's "Critical path" section): a release once shipped with the queue
 * drain wired to a default stub, so files were marked indexed in the `files`
 * table while the parser never ran and `symbols` stayed permanently empty —
 * every surgical-read command (`symbol`, `read`, `skeleton`, `outline`,
 * `semantic`) silently returned nothing, and the test suite stayed green
 * because every worker test injected its own callback. Caller passes the same
 * `dbPath` `checkDbExists` validated; if the database doesn't exist yet (or
 * isn't openable), this check quietly no-ops rather than duplicating that
 * failure.
 */
export function checkSymbolCount(dbPath: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Symbols', status: 'ok', message: 'no database yet' }
  }
  try {
    const db = getDb(dbPath)
    const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c
    const symbolCount = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c
    if (fileCount > 0 && symbolCount === 0) {
      return {
        name: 'Symbols',
        status: 'warn',
        message: `${fileCount} file(s) indexed but 0 symbols extracted — the parser may not be running (check the worker log); try 'token-goat index --force'`,
      }
    }
    return {
      name: 'Symbols',
      status: 'ok',
      message: `${symbolCount} symbol(s) across ${fileCount} indexed file(s)`,
    }
  } catch (err) {
    return {
      name: 'Symbols',
      status: 'warn',
      message: `could not query symbol count: ${extractErrorMessage(err)}`,
    }
  }
}

/**
 * Check if token-goat binary is installed and accessible.
 */
export function checkInstall(): DoctorResult {
  try {
    const output = execSync('token-goat --version', { encoding: 'utf-8' })
    return {
      name: 'Installation',
      status: 'ok',
      message: output.trim(),
    }
  } catch {
    return {
      name: 'Installation',
      status: 'fail',
      message: 'token-goat command not found; run: npm install -g token-goat-ts',
    }
  }
}

/**
 * Check if config file is valid and readable.
 */
export function checkConfigValid(configPath: string): DoctorResult {
  if (!fs.existsSync(configPath)) {
    return {
      name: 'Config',
      status: 'warn',
      message: `config file not found at ${configPath}`,
    }
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    parse(content)
    return {
      name: 'Config',
      status: 'ok',
      message: `config file valid (${content.length} bytes)`,
    }
  } catch (err) {
    return {
      name: 'Config',
      status: 'fail',
      message: `config invalid: ${extractErrorMessage(err, 'unknown error')}`,
    }
  }
}

/**
 * Format a byte count as a human-readable disk-space string (e.g. "650.0 GB").
 */
function formatDiskSpace(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Check available disk space in data directory.
 *
 * Prefers Node's built-in `fs.statfsSync` (Node 18.15+): no subprocess, and it works on
 * stock Windows where there is no `df` binary. Falls back to shelling out to `df` on
 * platforms/Node versions where `statfsSync` isn't available. If neither path works --
 * notably plain Windows without Git Bash/WSL on PATH and an old Node -- reports that
 * explicitly instead of silently claiming "could not determine" every single time.
 */
export function checkDiskSpace(dataDir: string): DoctorResult {
  if (typeof fs.statfsSync === 'function') {
    try {
      const stats = fs.statfsSync(dataDir)
      const availableBytes = stats.bavail * stats.bsize
      return { name: 'Disk Space', status: 'ok', message: `${formatDiskSpace(availableBytes)} available` }
    } catch {
      // Fall through to the df-based check below.
    }
  }

  if (process.platform !== 'win32') {
    try {
      // Use spawnSync with an array argv so dataDir cannot inject shell metacharacters.
      const result = spawnSync('df', ['-h', dataDir], { encoding: 'utf-8' })
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      if (result.error === undefined && result.status === 0 && stdout) {
        const lines = stdout.trim().split('\n')
        if (lines.length >= 2) {
          const parts = lines[1]!.trim().split(/\s+/)
          const available = parts[3] || 'unknown'
          return { name: 'Disk Space', status: 'ok', message: `${available} available` }
        }
      }
    } catch {
      // Fall through to the explicit "unavailable" result below.
    }
  }

  return { name: 'Disk Space', status: 'warn', message: 'disk space check unavailable on this platform' }
}

/**
 * Checks the installed Copilot CLI hook end-to-end: config is valid JSON with a preToolUse
 * entry, the node binary baked into that entry's command still exists on disk (it goes stale
 * after an nvm/fnm/volta node upgrade removes the old version -- a silent deny-all trigger,
 * since Copilot's command hooks fail closed on a process that never launches), and running
 * the exact command Copilot itself would run -- through a shell, the same win32 cmd.exe path
 * Copilot uses -- against a synthetic preToolUse payload returns exit 0 and parseable JSON.
 *
 * Returns null (not a result) when Copilot CLI integration isn't installed: this is an
 * opt-in feature, not a core component, so silence rather than a permanent 'warn' entry is
 * correct for users who have never touched `--copilot`.
 */
export function checkCopilotCli(configPath: string, scriptPath: string): DoctorResult | null {
  if (!fs.existsSync(configPath) || !fs.existsSync(scriptPath)) {
    return null
  }

  let config: { hooks?: Partial<Record<string, Array<{ command?: string }>>> }
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (err) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook config at ${configPath} is not valid JSON: ${extractErrorMessage(err, 'unknown error')}`,
    }
  }

  const preToolUseCommand = config.hooks?.['preToolUse']?.[0]?.command
  if (typeof preToolUseCommand !== 'string' || preToolUseCommand === '') {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook config at ${configPath} has no preToolUse entry; run: token-goat install --copilot`,
    }
  }

  // The command string's first quoted segment is the baked process.execPath (see
  // hookCommandFor in copilot_cli_install.ts).
  const bakedExecPath = /^"([^"]+)"/.exec(preToolUseCommand)?.[1]
  if (bakedExecPath !== undefined && !fs.existsSync(bakedExecPath)) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook points at a node binary that no longer exists (${bakedExecPath}) -- likely stale after an nvm/fnm/volta node upgrade. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI (renaming/reinstalling the hook has no effect on an already-running session -- Copilot caches hook configs at startup).`,
    }
  }

  const synthetic = JSON.stringify({
    sessionId: 'doctor-check',
    cwd: process.cwd(),
    toolName: 'view',
    toolArgs: { path: 'doctor-check.txt' },
  })
  const res = spawnSync(preToolUseCommand, {
    input: synthetic,
    encoding: 'utf-8',
    shell: true,
    windowsHide: true,
    timeout: 15000,
  })
  if (res.error) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook failed to launch: ${extractErrorMessage(res.error, 'unknown error')}. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI.`,
    }
  }
  if (res.status !== 0) {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: `hook exited with status ${res.status} -- Copilot's preToolUse fails closed on a non-zero exit and denies every tool call for the rest of the session. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI (a live session won't pick up the fix).`,
    }
  }
  try {
    JSON.parse(res.stdout ?? '')
  } catch {
    return {
      name: 'Copilot CLI',
      status: 'fail',
      message: 'hook did not return valid JSON -- Copilot treats this as a hook error and denies every tool call. Recovery: run "token-goat install --copilot", then fully restart Copilot CLI.',
    }
  }

  return { name: 'Copilot CLI', status: 'ok', message: 'preToolUse hook invokes cleanly and returns valid JSON' }
}

/**
 * Run all doctor checks and return results.
 */
export function runDoctor(dataDir?: string, configPath?: string): DoctorResult[] {
  const results: DoctorResult[] = []

  // Basic checks
  results.push(checkInstall())
  results.push(checkWorkerRunning() ? { name: 'Worker', status: 'ok', message: 'running' } : { name: 'Worker', status: 'warn', message: 'not running' })

  // File checks
  const actualDataDir = dataDir || defaultDataDir()
  results.push(checkDbExists(actualDataDir))
  results.push(checkSymbolCount(path.join(actualDataDir, 'global.db')))

  const actualConfigPath = configPath || defaultConfigPath()
  results.push(checkConfigValid(actualConfigPath))

  results.push(checkDiskSpace(actualDataDir))

  const copilotResult = checkCopilotCli(copilotCliConfigPath(), copilotCliScriptPath())
  if (copilotResult) results.push(copilotResult)

  return results
}

/**
 * Format and print doctor results to stdout.
 */
export function printDoctorResults(results: DoctorResult[]): void {
  console.log('\ntoken-goat doctor\n')

  const grouped = new Map<string, DoctorResult[]>()
  for (const result of results) {
    const key = result.name.split(' ')[0]!
    if (!grouped.has(key)) {
      grouped.set(key, [])
    }
    grouped.get(key)!.push(result)
  }

  for (const [, items] of grouped) {
    for (const item of items) {
      const prefix = item.status === 'ok' ? '  ' : `  [${item.status.toUpperCase()}] `
      console.log(`${prefix}${item.name}: ${item.message}`)
    }
  }

  const hasFailures = results.some((r) => r.status === 'fail')
  console.log(hasFailures ? '\nFAILURES DETECTED' : '\nAll checks passed')
  console.log()
}

/**
 * Run doctor and return exit code (0 for success, 1 for failures).
 */
export function runDoctorAndExit(opts?: { dataDir?: string; configPath?: string; context?: boolean }): number {
  const results = runDoctor(opts?.dataDir, opts?.configPath)
  printDoctorResults(results)

  if (opts?.context === true) {
    console.log('\n## Context footprint\n')
    // Call runContextStats to show the context breakdown.
    runContextStats({})
    console.log()

    // Add pregen-gap check: if pregen.json exists, check for skills on disk missing from pregen names.
    try {
      const dir = skillOutputsDir()
      const pregenPath = path.join(dir, 'pregen.json')
      if (fs.existsSync(pregenPath)) {
        const content = JSON.parse(fs.readFileSync(pregenPath, 'utf-8')) as { names?: string[] }
        const pregenNames = new Set(content.names || [])
        const skills = [] as string[]
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.meta')) continue
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8')) as { skillName: string }
              if (meta.skillName && !pregenNames.has(meta.skillName)) {
                skills.push(meta.skillName)
              }
            } catch {
              // skip
            }
          }
        } catch {
          // skip
        }
        if (skills.length > 0) {
          console.log(`Missing from pregen.json: ${skills.join(', ')}`)
          console.log(`Remediation: token-goat skill-compact --all\n`)
        }
      }
    } catch {
      // skip pregen check
    }
  }

  return results.some((r) => r.status === 'fail') ? 1 : 0
}
