/**
 * Doctor CLI helpers — diagnose token-goat health.
 *
 * Provides check utilities and the runDoctor() entrypoint for the doctor command.
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync, spawnSync } from 'child_process'
import { extractErrorMessage } from './util.js'
import { runContextStats } from './cli_context_stats.js'
import { skillOutputsDir } from './skill_cache.js'

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
  try {
    const output = execSync('tasklist', { encoding: 'utf-8' })
    return output.includes('token-goat') || output.includes('worker')
  } catch {
    return false
  }
}

/**
 * Check if the data directory and database files exist.
 */
export function checkDbExists(dataDir: string): DoctorResult {
  const dbPath = path.join(dataDir, 'index.db')
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'Database',
      status: 'warn',
      message: `index.db not found at ${dbPath}`,
    }
  }
  return {
    name: 'Database',
    status: 'ok',
    message: `index.db exists (${Math.round(fs.statSync(dbPath).size / 1024)} KB)`,
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
    JSON.parse(content)
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
 * Check available disk space in data directory.
 */
export function checkDiskSpace(dataDir: string): DoctorResult {
  try {
    // Use spawnSync with an array argv so dataDir cannot inject shell metacharacters.
    const result = spawnSync('df', ['-h', dataDir], { encoding: 'utf-8' })
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    if (result.error !== undefined || result.status !== 0 || !stdout) {
      return { name: 'Disk Space', status: 'warn', message: 'could not determine' }
    }
    const lines = stdout.trim().split('\n')
    if (lines.length < 2) {
      return { name: 'Disk Space', status: 'warn', message: 'could not determine' }
    }
    const parts = lines[1]!.trim().split(/\s+/)
    const available = parts[3] || 'unknown'
    return { name: 'Disk Space', status: 'ok', message: `${available} available` }
  } catch {
    return { name: 'Disk Space', status: 'warn', message: 'could not determine' }
  }
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
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '~'
  const actualDataDir = dataDir || path.join(homeDir, '.token-goat')
  results.push(checkDbExists(actualDataDir))

  const actualConfigPath = configPath || path.join(actualDataDir, 'config.json')
  results.push(checkConfigValid(actualConfigPath))

  results.push(checkDiskSpace(actualDataDir))

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
