/**
 * Session manifest generator for compaction assist.
 *
 * Ports key functions from Python's `token_goat.compact` for TypeScript.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { dataDir } from './constants.js'
import { normalizePath } from './paths.js'
import { atomicWriteText } from './util.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTEXT_AUTOCOMPACT_TOKENS = 660_000
export const CATALOG_TOKENS = 10_800
export const CONTEXT_TIER_WARM = 0.5
export const CONTEXT_TIER_HOT = 0.7
export const CONTEXT_TIER_CRITICAL = 0.85

const NOISE_EXTS = new Set([
  '.pyc', '.pyo', '.pyd',
  '.class',
  '.o', '.obj', '.a', '.lib', '.dll', '.so', '.dylib',
  '.log',
  '.jsonl',
  '.tmp', '.temp', '.swp', '.swo',
  '.bak',
  '.pid',
  '.lock',
  '.map',
  '.wasm',
  '.gz', '.zip', '.tar', '.tgz',
  '.db', '.sqlite', '.sqlite3', '.db3',
  '.d.ts',
  '.snap',
  '.eot', '.ttf', '.woff', '.woff2',
  '.ico',
  '.pdb',
  '.exe', '.bin',
])

const NOISE_BASENAMES = new Set([
  '.ds_store', 'thumbs.db', 'desktop.ini',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'uv.lock', 'pdm.lock',
  'cargo.lock',
  'composer.lock', 'gemfile.lock',
  'coverage.xml', '.coverage', 'lcov.info',
])

const NOISE_SEGMENTS = [
  '/__pycache__/', '/.git/', '/node_modules/', '/.venv/', '/venv/',
  '/dist/', '/build/', '/.mypy_cache/', '/.pytest_cache/', '/.ruff_cache/',
  '/appdata/local/temp/', '/appdata/roaming/',
  '/tmp/',
  '/.next/', '/.nuxt/', '/.svelte-kit/', '/.turbo/', '/.parcel-cache/',
  '/.cache/', '/.tox/',
  '/coverage/', '/.nyc_output/',
  '/site-packages/', '.egg-info/',
  '/target/',
  '/__snapshots__/',
  '/dist/', '/.turbo/',
]

const KNOWN_HARNESSES = new Set([
  'claudecode', 'codex', 'opencode', 'gemini', 'hermes', 'generic',
])

const HARNESS_MULTIPLIER_DEFAULTS: Record<string, number> = {
  claudecode: 2.0,
  codex: 1.5,
  opencode: 2.5,
  gemini: 3.0,
  generic: 1.0,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextPressure {
  fillFraction: number
  tier: 'cool' | 'warm' | 'hot' | 'critical'
}

export interface SessionCacheObject {
  loadedSkillTotalTokens?: number
  observedToolTokens?: number
  pressureBaselineTokens?: number
  bashHistory?: Record<string, unknown>
  webHistory?: Record<string, unknown>
  files?: Record<string, unknown>
  editedFiles?: Record<string, unknown>
  symbolAccessCounts?: Record<string, number>
  skillHistory?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple counter for frequency analysis.
 */
class Counter<T> {
  private map = new Map<T, number>()

  increment(key: T, delta: number = 1): void {
    this.map.set(key, (this.map.get(key) ?? 0) + delta)
  }

  get size(): number {
    return this.map.size
  }

  max(): T | undefined {
    if (this.map.size === 0) return undefined
    let maxKey = undefined
    let maxCount = -1
    for (const [key, count] of this.map) {
      if (count > maxCount) {
        maxKey = key
        maxCount = count
      }
    }
    return maxKey
  }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~3 chars/token (conservative vs. the true 3.5 ratio).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 3) + 1)
}

/**
 * Map a context-fill fraction to its qualitative pressure tier.
 */
export function tierForFraction(fill: number): 'cool' | 'warm' | 'hot' | 'critical' {
  if (fill >= CONTEXT_TIER_CRITICAL) return 'critical'
  if (fill >= CONTEXT_TIER_HOT) return 'hot'
  if (fill >= CONTEXT_TIER_WARM) return 'warm'
  return 'cool'
}

/**
 * Return the raw (pre-baseline-subtraction) context pressure total for a cache.
 */
function pressureRawTotal(cache: SessionCacheObject): number {
  const skillTokens = cache.loadedSkillTotalTokens ?? 0
  const observed = cache.observedToolTokens ?? 0
  if (observed > 0) {
    return skillTokens + CATALOG_TOKENS + observed
  }
  const bashHistory = cache.bashHistory ?? {}
  const bashCount = Object.keys(bashHistory).length
  const webHistory = cache.webHistory ?? {}
  const webCount = Object.keys(webHistory).length
  const files = cache.files ?? {}
  const readCount = Object.keys(files).length
  return (
    skillTokens +
    CATALOG_TOKENS +
    bashCount * 500 +
    webCount * 1_000 +
    readCount * 200
  )
}

/**
 * Return the estimated context fill fraction and pressure tier.
 */
export function getContextPressure(cache?: SessionCacheObject): ContextPressure {
  try {
    if (!cache) {
      return { fillFraction: 0.0, tier: 'cool' }
    }
    const rawTotal = pressureRawTotal(cache)
    const baseline = cache.pressureBaselineTokens ?? 0
    const total = Math.max(0, rawTotal - baseline)
    const window = CONTEXT_AUTOCOMPACT_TOKENS
    const fill = total / window
    return {
      fillFraction: fill,
      tier: tierForFraction(fill),
    }
  } catch {
    return { fillFraction: 0.0, tier: 'cool' }
  }
}

/**
 * Detect the active AI harness from environment variables.
 */
export function detectHarness(configOverride: string = 'auto'): string {
  if (configOverride !== 'auto') {
    if (KNOWN_HARNESSES.has(configOverride)) {
      return configOverride
    }
  }

  const harnessOverride = (process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] ?? '').toLowerCase().trim()
  if (harnessOverride && KNOWN_HARNESSES.has(harnessOverride)) {
    return harnessOverride
  }

  if (process.env['HERMES_SESSION_ID'] || process.env['HERMES_HOME']) {
    return 'hermes'
  }

  if (process.env['CLAUDE_CODE_SESSION_ID'] || process.env['ANTHROPIC_API_KEY']) {
    return 'claudecode'
  }

  if (process.env['CODEX_SESSION']) {
    return 'codex'
  }

  if (process.env['OPENCODE_SESSION']) {
    return 'opencode'
  }

  if (process.env['OPENAI_API_KEY'] && !process.env['ANTHROPIC_API_KEY']) {
    return 'codex'
  }

  if ((process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY']) && !process.env['ANTHROPIC_API_KEY']) {
    return 'gemini'
  }

  return 'generic'
}

/**
 * Get the effective auto_trigger_multiplier for the detected harness.
 */
export function getAutoTriggerMultiplier(opts?: {
  configExplicitMultiplier?: number
  harness?: string
  isConfigDefault?: boolean
}): number {
  const config = opts?.configExplicitMultiplier ?? 2.0
  let isDefault = opts?.isConfigDefault
  if (isDefault === undefined) {
    isDefault = config === 2.0
  }

  if (!isDefault && opts?.configExplicitMultiplier !== undefined) {
    return Math.max(1.0, Math.min(10.0, opts.configExplicitMultiplier))
  }

  const harness = opts?.harness ?? detectHarness()
  return Math.max(1.0, Math.min(10.0, HARNESS_MULTIPLIER_DEFAULTS[harness] ?? 1.0))
}

/**
 * Infer the session's goal from edited files, accessed symbols, and recent bash commands.
 */
export function inferSessionGoal(cache: SessionCacheObject, maxTokens: number = 80): string {
  try {
    const editedFilesRaw = cache.editedFiles ?? {}
    const symbolAccessRaw = cache.symbolAccessCounts ?? {}

    if (Object.keys(editedFilesRaw).length < 2 && Object.keys(symbolAccessRaw).length === 0) {
      return ''
    }

    const dirCounts = new Counter<string>()
    for (const fpath of Object.keys(editedFilesRaw)) {
      try {
        let parent = path.dirname(fpath)
        if (parent === '.') {
          parent = 'root'
        } else if (parent.startsWith('./')) {
          parent = parent.slice(2).replace(/^[\\/]/, '') || 'root'
        }
        if (parent) {
          dirCounts.increment(parent)
        }
      } catch {
        // Skip on parse error
      }
    }

    let topArea: string | undefined = ''
    if (dirCounts.size > 0) {
      topArea = dirCounts.max()
    }

    const topSymbols: string[] = []
    if (Object.keys(symbolAccessRaw).length > 0) {
      const sorted = Object.entries(symbolAccessRaw).sort((a, b) => b[1] - a[1])
      topSymbols.push(...sorted.slice(0, 3).map(([sym]) => sym))
    }

    const parts: string[] = []

    if (topArea && topSymbols.length > 0) {
      parts.push(`Working on ${topArea}, focusing on ${topSymbols.slice(0, 2).join(' and ')}.`)
    } else if (topArea) {
      parts.push(`Working on changes in ${topArea}.`)
    } else if (topSymbols.length > 0) {
      parts.push(`Focusing on ${topSymbols.slice(0, 2).join(' and ')}.`)
    }

    const goal = parts.join(' ')
    const goalTokens = estimateTokens(goal)
    if (goalTokens > maxTokens && parts.length > 1) {
      const first = parts[0]
      if (first !== undefined) return first
    }

    return goal.trim()
  } catch {
    return ''
  }
}

/**
 * Return True when path should be excluded from the manifest as low-value noise.
 */
export function isNoisePath(inputPath: string): boolean {
  if (!inputPath) {
    return false
  }

  const p = normalizePath(inputPath).toLowerCase().replace(/\\/g, '/')

  for (const segment of NOISE_SEGMENTS) {
    if (p.includes(segment)) {
      return true
    }
  }

  const slashIdx = p.lastIndexOf('/')
  const basename = slashIdx >= 0 ? p.slice(slashIdx + 1) : p

  if (NOISE_BASENAMES.has(basename)) {
    return true
  }

  if (basename.startsWith('.improve-state-') || basename.startsWith('improve_commit_msg_')) {
    return true
  }

  const dotIdx = basename.lastIndexOf('.')
  if (dotIdx >= 0) {
    const ext = basename.slice(dotIdx)
    if (NOISE_EXTS.has(ext)) {
      return true
    }
  }

  for (const ext of NOISE_EXTS) {
    if (ext.includes('.') && ext.split('.').length > 2) {
      if (basename.endsWith(ext)) {
        return true
      }
    }
  }

  return false
}

/**
 * Return the session_id of the most-recently-modified session file.
 */
export function findLatestSessionId(): string | null {
  try {
    const sessionsDir = path.join(dataDir(), 'sessions')
    if (!fs.existsSync(sessionsDir)) {
      return null
    }

    const files = fs.readdirSync(sessionsDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
      return null
    }

    const firstFile = jsonFiles[0]
    if (!firstFile) {
      return null
    }

    let latestFile = firstFile
    let latestMtime = fs.statSync(path.join(sessionsDir, firstFile)).mtimeMs

    for (const file of jsonFiles) {
      const mtime = fs.statSync(path.join(sessionsDir, file)).mtimeMs
      if (mtime > latestMtime) {
        latestFile = file
        latestMtime = mtime
      }
    }

    return latestFile.replace(/\.json$/, '')
  } catch {
    return null
  }
}

/**
 * Count tracked events (reads + greps + edits + bash runs) for a session.
 */
export function eventCount(cache: SessionCacheObject): number {
  const files = cache.files ?? {}
  const editedFiles = cache.editedFiles ?? {}
  const bashHistory = cache.bashHistory ?? {}
  const skillHistory = cache.skillHistory ?? {}

  return (
    Object.keys(files).length +
    Object.keys(editedFiles).length +
    Object.keys(bashHistory).length +
    Object.keys(skillHistory).length
  )
}

/**
 * Strip the trailing "# as-of: ..." line so two manifests built at different
 * wall-clock times from identical session content compare as byte-equal.
 */
export function normalizeForCache(manifestText: string): string {
  const lines = manifestText.trim().split('\n')
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]
    if (lastLine && lastLine.startsWith('# as-of:')) {
      return lines.slice(0, -1).join('\n')
    }
  }
  return manifestText
}

/**
 * Write per-session manifest JSON for cross-session deduplication.
 */
export function writeSessionManifest(
  projectHash: string,
  sessionId: string,
  manifestJson: Record<string, unknown>
): void {
  const sessionsDir = path.join(dataDir(), 'projects', projectHash, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true })
  }
  const dest = path.join(sessionsDir, `${sessionId}.json`)
  atomicWriteText(dest, JSON.stringify(manifestJson))
}

/**
 * Read all session manifest JSON files for projectHash, skipping stale and corrupt entries.
 */
export function readAllSessionManifests(
  projectHash: string,
  maxAgeSecs: number = 3600
): Record<string, unknown>[] {
  const sessionsDir = path.join(dataDir(), 'projects', projectHash, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    return []
  }

  const now = Date.now() / 1000
  const results: Record<string, unknown>[] = []

  try {
    const files = fs.readdirSync(sessionsDir)
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue
      }
      try {
        const fullPath = path.join(sessionsDir, file)
        const stat = fs.statSync(fullPath)
        if (now - stat.mtimeMs / 1000 > maxAgeSecs) {
          continue
        }
        const text = fs.readFileSync(fullPath, 'utf8')
        const data = JSON.parse(text)
        if (typeof data === 'object' && data !== null && 'files' in data) {
          results.push(data)
        }
      } catch {
        // Silently skip corrupt JSON
      }
    }
  } catch {
    // Silently fail if directory not accessible
  }

  return results
}

/**
 * Merge file entries from multiple sessions, deduplicating by rel_path.
 */
export function mergeSessionManifests(
  manifests: Record<string, unknown>[],
  budgetTokens: number
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>()

  for (const manifest of manifests) {
    const files = (manifest['files'] as Record<string, unknown>[]) ?? []
    for (const entry of files) {
      const rel = (entry['rel_path'] as string) ?? ''
      if (!rel) continue

      const existing = merged.get(rel)
      const entryHitCount = (entry['hit_count'] as number) ?? 0
      const existingHitCount = (existing?.['hit_count'] as number) ?? 0

      if (!existing || entryHitCount > existingHitCount) {
        merged.set(rel, entry)
      }
    }
  }

  const sorted = Array.from(merged.values()).sort(
    (a, b) => ((b['hit_count'] as number) ?? 0) - ((a['hit_count'] as number) ?? 0)
  )

  const result: Record<string, unknown>[] = []
  let totalTokens = 0

  for (const entry of sorted) {
    const relPath = (entry['rel_path'] as string) ?? ''
    const entryTokens = Math.max(1, Math.floor(relPath.length / 10))

    if (totalTokens + entryTokens > budgetTokens) {
      break
    }

    result.push(entry)
    totalTokens += entryTokens
  }

  return result
}

// ---------------------------------------------------------------------------
// Stubs for part 2
// ---------------------------------------------------------------------------

/**
 * Build a session manifest (part 2 — stub).
 */
export function buildManifest(_sessionId: string, _opts?: { maxTokens?: number }): string {
  return ''
}

/**
 * Build a manifest with adaptive budget (part 2 — stub).
 */
export function buildManifestAdaptive(_sessionId: string): string {
  return ''
}

/**
 * Compute adaptive budget for manifest (part 2 — stub).
 */
export function computeAdaptiveBudget(
  _cache: object,
  _ageSecs?: number,
  _opts?: object
): number {
  return 400
}

/**
 * Build a manifest and return both text and token count (part 2 — stub).
 */
export function buildManifestWithCount(
  _sessionId: string,
  _opts?: { maxTokens?: number }
): [string, number] {
  return ['', 0]
}
