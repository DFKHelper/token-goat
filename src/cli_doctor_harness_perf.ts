/** Diagnostic checks for AI harness session storage bloat and AV/EDR exclusion posture. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { DoctorResult } from './doctor_result.js'
import { displaySafeText } from './paths.js'
import { type OwnedChild, spawnOwned } from './process_tree.js'
import { powerShellTextQueryArgs, windowsPowerShellPath } from './windows_powershell.js'

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

/** How long the Defender exclusion query may run before it is ended and reported as unknown. */
const DEFENDER_QUERY_TIMEOUT_MS = 2500

/** Starts the Defender exclusion query on an owned child and resolves with its paths, or null; it returns at once, so doctor's other checks run meanwhile. */
export function startWindowsDefenderExclusionQuery(): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    const finish = (paths: string[] | null): void => {
      clearTimeout(timer)
      resolve(paths)
    }
    let owned: OwnedChild
    try {
      owned = spawnOwned(
        windowsPowerShellPath(),
        powerShellTextQueryArgs('$ProgressPreference="SilentlyContinue"; (Get-MpPreference).ExclusionPath'),
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch {
      // Non-fatal if PowerShell or MpPreference is restricted
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      owned.kill()
      finish(null)
    }, DEFENDER_QUERY_TIMEOUT_MS)
    owned.child.stdout?.setEncoding('utf-8').on('data', (chunk: string) => {
      out += chunk
    })
    owned.child.once('error', () => finish(null))
    owned.child.once('close', (code) => {
      finish(code === 0 && out ? out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean) : null)
    })
  })
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

/** Checks whether the workspace or harness home directories are excluded in real-time AV; `exclusionsOverride` is the Defender query's answer, and null or undefined (off Windows, or no answer) yields no row. */
export function checkAntivirusExclusionPosture(
  rootDir: string = process.cwd(),
  homeDir: string = os.homedir(),
  exclusionsOverride?: string[] | null
): DoctorResult | null {
  const exclusions = exclusionsOverride ?? null
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
