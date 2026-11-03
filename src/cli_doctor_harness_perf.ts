/** Diagnostic checks for AI harness session storage bloat and AV/EDR exclusion posture. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import type { DoctorResult } from './doctor_result.js'
import { displaySafeText } from './paths.js'

/** Maximum recommended total size in bytes before warning about harness session bloat (5 GB). */
export const DEFAULT_MAX_HARNESS_SESSION_BYTES = 5 * 1024 * 1024 * 1024

/** Maximum files to inspect per directory when checking harness session bloat to ensure fast execution. */
export const MAX_SESSION_SCAN_FILES = 1000

/** Canonical disclaimer regarding the security tradeoff of AV/EDR exclusions. */
export const AV_EXCLUSION_DISCLAIMER =
  '(disclaimer): Exclusions create an antivirus blind spot for downloaded packages, cloned repos, and build artifacts. Only apply exclusions that comply with your organization\'s security policy, and prefer process-scoped rules over broad directory exemptions.'

export interface HarnessDirectoryCandidate {
  readonly harness: string
  readonly dirPath: string
}

/** Returns default harness session/history directory candidates for known AI agents. */
export function getHarnessStorageCandidates(homeDir: string = os.homedir()): HarnessDirectoryCandidate[] {
  return [
    { harness: 'Copilot CLI', dirPath: path.join(homeDir, '.copilot', 'session-state') },
    { harness: 'Claude Code', dirPath: path.join(homeDir, '.claude', 'projects') },
    { harness: 'Codex', dirPath: path.join(homeDir, '.codex', 'sessions') },
  ]
}

/** Recursively measures approximate directory size in bytes, bounded to avoid excessive I/O. */
export function measureDirectoryBytes(dirPath: string, maxFiles: number = MAX_SESSION_SCAN_FILES): { sizeBytes: number; fileCount: number; truncated: boolean } {
  let sizeBytes = 0
  let fileCount = 0
  let truncated = false

  if (!fs.existsSync(dirPath)) {
    return { sizeBytes: 0, fileCount: 0, truncated: false }
  }

  const stack: string[] = [dirPath]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (fileCount >= maxFiles) {
        truncated = true
        break
      }
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        fileCount++
        try {
          const stat = fs.statSync(full)
          sizeBytes += stat.size
        } catch {
          // ignore unreadable/locked file
        }
      }
    }

    if (truncated) break
  }

  return { sizeBytes, fileCount, truncated }
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

/** Checks for large AI harness session state accumulation that causes memory/startup lag. */
export function checkHarnessSessionStorage(
  homeDir: string = os.homedir(),
  thresholdBytes: number = DEFAULT_MAX_HARNESS_SESSION_BYTES
): DoctorResult | null {
  const candidates = getHarnessStorageCandidates(homeDir)
  const bloated: { harness: string; dir: string; sizeBytes: number; fileCount: number }[] = []

  for (const cand of candidates) {
    if (fs.existsSync(cand.dirPath)) {
      const { sizeBytes, fileCount } = measureDirectoryBytes(cand.dirPath)
      if (sizeBytes > thresholdBytes) {
        bloated.push({ harness: cand.harness, dir: cand.dirPath, sizeBytes, fileCount })
      }
    }
  }

  if (bloated.length === 0) {
    return null
  }

  const details = bloated
    .map((b) => `${b.harness} (${formatBytes(b.sizeBytes)}, ${b.fileCount} files at ${displaySafeText(b.dir)})`)
    .join('; ')

  return {
    name: 'Harness session storage',
    status: 'warn',
    message: `High session storage detected: ${details}. Large session archives increase agent startup latency and EDR overhead. Consider pruning sessions older than 30-60 days.`,
  }
}

/** Queries Windows Defender active exclusion paths via PowerShell (returns null if non-Windows or query fails). */
export function getWindowsDefenderExclusionPaths(): string[] | null {
  if (process.platform !== 'win32') return null

  try {
    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$ProgressPreference="SilentlyContinue"; (Get-MpPreference).ExclusionPath'],
      { encoding: 'utf-8', timeout: 2500, windowsHide: true }
    )
    if (res.status === 0 && res.stdout) {
      return res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
    }
  } catch {
    // Non-fatal if PowerShell or MpPreference is restricted
  }
  return null
}

/** Normalizes a Windows or POSIX path for case-insensitive exclusion matching. */
function normalizeForComparison(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/')
}

/** Determines whether targetPath is covered by any path in exclusions. */
export function isPathExcluded(targetPath: string, exclusions: string[]): boolean {
  const targetNorm = normalizeForComparison(targetPath)
  for (const excl of exclusions) {
    const exclNorm = normalizeForComparison(excl)
    if (targetNorm === exclNorm || targetNorm.startsWith(exclNorm.endsWith('/') ? exclNorm : `${exclNorm}/`)) {
      return true
    }
  }
  return false
}

/** Checks whether the workspace or harness home directories are excluded in real-time AV, advising on performance and disclaimer. */
export function checkAntivirusExclusionPosture(
  rootDir: string = process.cwd(),
  homeDir: string = os.homedir(),
  exclusionsOverride?: string[] | null
): DoctorResult | null {
  // Only evaluate on Windows where Defender/EDR CPU overhead on node/git file trees is common
  if (process.platform !== 'win32' && !exclusionsOverride) return null

  const exclusions = exclusionsOverride !== undefined ? exclusionsOverride : getWindowsDefenderExclusionPaths()
  if (!exclusions || exclusions.length === 0) {
    return null
  }

  const workspaceExcluded = isPathExcluded(rootDir, exclusions)
  const copilotDir = path.join(homeDir, '.copilot')
  const claudeDir = path.join(homeDir, '.claude')
  const copilotExcluded = isPathExcluded(copilotDir, exclusions)
  const claudeExcluded = isPathExcluded(claudeDir, exclusions)

  if (workspaceExcluded && (copilotExcluded || claudeExcluded)) {
    return {
      name: 'Antivirus exclusion posture',
      status: 'ok',
      message: `Workspace and agent state directories are excluded from real-time Defender scanning.`,
    }
  }

  const missing: string[] = []
  if (!workspaceExcluded) missing.push(`workspace (${displaySafeText(rootDir)})`)
  if (!copilotExcluded && fs.existsSync(copilotDir)) missing.push(`~/.copilot`)
  if (!claudeExcluded && fs.existsSync(claudeDir)) missing.push(`~/.claude`)

  if (missing.length === 0) return null

  return {
    name: 'Antivirus exclusion posture',
    status: 'warn',
    message: `Not excluded from real-time AV scanning: ${missing.join(', ')}. Heavy process/git activity can cause high scanner CPU and agent lag. ${AV_EXCLUSION_DISCLAIMER}`,
  }
}
