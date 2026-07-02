/**
 * Session manifest generator for compaction assist.
 *
 * Ports key functions from Python's `token_goat.compact` for TypeScript.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { dataDir } from './constants.js'
import { tokenGoatHome } from './disk_cache.js'
import { atomicWriteText, normalizePathForwardSlash } from './util.js'

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

  const p = normalizePathForwardSlash(inputPath, true)

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
    const sessionsDir = path.join(tokenGoatHome(), 'sessions')
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
 * Count tracked events (reads + greps + edits + bash runs + web fetches) for a session.
 */
export function eventCount(cache: SessionCacheObject): number {
  const files = cache.files ?? {}
  const editedFiles = cache.editedFiles ?? {}
  const bashHistory = cache.bashHistory ?? {}
  const webHistory = cache.webHistory ?? {}
  const skillHistory = cache.skillHistory ?? {}

  return (
    Object.keys(files).length +
    Object.keys(editedFiles).length +
    Object.keys(bashHistory).length +
    Object.keys(webHistory).length +
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
    const entryTokens = Math.max(1, Math.floor(relPath.length / 3) + 1)

    if (totalTokens + entryTokens > budgetTokens) {
      break
    }

    result.push(entry)
    totalTokens += entryTokens
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers for computing adaptive budget
// ---------------------------------------------------------------------------

function _editedFileCount(cache: SessionCacheObject): number {
  const edited = cache.editedFiles ?? {}
  return Object.keys(edited).length
}

function _computeActivityMultiplier(ageSecs: number, editedCount: number): number {
  const TEN_MIN_SECS = 600
  const SIXTY_MIN_SECS = 3600
  const EDITS_PER_MIN_DENSITY_THRESHOLD = 0.3

  let tier: 'young' | 'active' | 'mature'
  if (ageSecs < TEN_MIN_SECS) {
    tier = 'young'
  } else if (ageSecs < SIXTY_MIN_SECS) {
    tier = 'active'
  } else {
    tier = 'mature'
  }

  const baseFactor: Record<typeof tier, number> = {
    young: 0.6,
    active: 1.0,
    mature: 1.4,
  }

  let factor = baseFactor[tier]

  if (ageSecs >= TEN_MIN_SECS) {
    const editsPerMin = ageSecs > 0 ? editedCount / (ageSecs / 60) : 0
    if (editsPerMin < EDITS_PER_MIN_DENSITY_THRESHOLD) {
      factor = Math.min(factor, 1.0)
    }
  }

  return factor
}

// ---------------------------------------------------------------------------
// Load session cache from disk
// ---------------------------------------------------------------------------

function _loadSessionCache(sessionId: string): SessionCacheObject | null {
  try {
    const sessionsDir = path.join(tokenGoatHome(), 'sessions')
    const cachePath = path.join(sessionsDir, `${sessionId}.json`)
    if (!fs.existsSync(cachePath)) {
      return null
    }
    const content = fs.readFileSync(cachePath, 'utf8')
    return JSON.parse(content) as SessionCacheObject
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Build manifest from loaded cache
// ---------------------------------------------------------------------------

function _buildManifestText(cache: SessionCacheObject, maxTokens: number): string {
  const lines: string[] = []
  lines.push('# token-goat session manifest')
  lines.push('')

  const editedFiles = Object.keys(cache.editedFiles ?? {})
  const files = cache.files ?? {}
  const readPaths = Object.keys(files).filter((p) => !(cache.editedFiles ?? {})[p])
  const bashHistory = cache.bashHistory ?? {}
  const webHistory = cache.webHistory ?? {}

  const usedTokens = estimateTokens(lines.join('\n'))
  const budgetRemaining = maxTokens - usedTokens

  if (editedFiles.length > 0) {
    lines.push('## Edited files')
    let sectionTokens = estimateTokens('## Edited files\n')
    for (const fpath of editedFiles) {
      if (sectionTokens > budgetRemaining * 0.4) break
      const cleanPath = normalizePathForwardSlash(fpath)
      if (!isNoisePath(cleanPath)) {
        lines.push(`- ${cleanPath}`)
        sectionTokens += estimateTokens(`- ${cleanPath}\n`)
      }
    }
    lines.push('')
  }

  if (readPaths.length > 0) {
    lines.push('## Files read')
    let sectionTokens = estimateTokens('## Files read\n')
    const sortedRead = readPaths.sort((a, b) => {
      // FileEntry uses `readCount`, not `hit_count` (which is the cross-session manifest format field). Using the wrong key meant countA/B were always 0 and files were never prioritised by actual read frequency.
      const countA = (files[a] as Record<string, number>)?.['readCount'] ?? 0
      const countB = (files[b] as Record<string, number>)?.['readCount'] ?? 0
      return countB - countA
    })
    for (const fpath of sortedRead.slice(0, 15)) {
      if (sectionTokens > budgetRemaining * 0.3) break
      const cleanPath = normalizePathForwardSlash(fpath)
      if (!isNoisePath(cleanPath)) {
        lines.push(`- ${cleanPath}`)
        sectionTokens += estimateTokens(`- ${cleanPath}\n`)
      }
    }
    lines.push('')
  }

  if (Object.keys(bashHistory).length > 0) {
    lines.push('## Recent bash')
    lines.push('(bash history recorded)')
    lines.push('')
  }

  if (Object.keys(webHistory).length > 0) {
    lines.push('## Web fetches')
    let sectionTokens = estimateTokens('## Web fetches\n')
    for (const url of Object.keys(webHistory).slice(0, 10)) {
      if (sectionTokens > budgetRemaining * 0.2) break
      lines.push(`- ${url}`)
      sectionTokens += estimateTokens(`- ${url}\n`)
    }
    lines.push('')
  }

  lines.push(`# as-of: ${new Date().toISOString()}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute adaptive token budget for manifest based on session complexity.
 *
 * Returns value in range [200, 800], capped by context pressure tier.
 */
export function computeAdaptiveBudget(
  cache: SessionCacheObject,
  ageSecs: number = 0.0,
  opts?: {
    hasPendingDiff?: boolean
    hasUncommittedChanges?: boolean
    staleCompactFraction?: number
    contextPressure?: ContextPressure
  }
): number {
  const base = 200
  const maxTotal = 800
  const minTotal = 200

  const editedCount = _editedFileCount(cache)
  const editedBonus = Math.min(200, editedCount * 50)

  const files = cache.files ?? {}
  const symbolFiles = Object.values(files).filter((f) => {
    const entry = f as Record<string, unknown>
    return ((entry['symbols_read'] as unknown[]) ?? []).length > 0
  }).length
  const symbolsBonus = Math.min(150, symbolFiles * 30)

  const bashHistory = cache.bashHistory ?? {}
  const bashCount = Object.keys(bashHistory).length
  const bashBonus = bashCount > 0 ? Math.min(100, Math.max(20, bashCount * 5)) : 0

  const webHistory = cache.webHistory ?? {}
  const webBonus = Object.keys(webHistory).length > 0 ? 15 : 0

  const diffBonus = opts?.hasPendingDiff ? 50 : 0
  const uncommittedBonus = opts?.hasUncommittedChanges ? 10 : 0

  const staleFrac = Math.max(0.0, Math.min(1.0, opts?.staleCompactFraction ?? 0.0))
  const staleBonus = Math.min(60, Math.round(staleFrac * 60))

  const rawTotal =
    base + editedBonus + symbolsBonus + bashBonus + webBonus + diffBonus + uncommittedBonus + staleBonus

  const factor = _computeActivityMultiplier(ageSecs, editedCount)
  const total = Math.round(rawTotal * factor)

  let capMax = maxTotal
  if (opts?.contextPressure) {
    if (opts.contextPressure.tier === 'critical') {
      capMax = Math.min(capMax, 300)
    } else if (opts.contextPressure.tier === 'hot') {
      capMax = Math.min(capMax, 500)
    }
  }

  return Math.max(minTotal, Math.min(capMax, total))
}

/**
 * Build a session manifest from a loaded cache.
 */
export function buildManifest(sessionId: string, opts?: { maxTokens?: number }): string {
  const maxTokens = opts?.maxTokens ?? 400
  const cache = _loadSessionCache(sessionId)
  if (!cache) {
    return ''
  }

  return _buildManifestText(cache, maxTokens)
}

/**
 * Build manifest with adaptively-computed budget.
 */
export function buildManifestAdaptive(sessionId: string): string {
  const cache = _loadSessionCache(sessionId)
  if (!cache) {
    return ''
  }

  const createdTs = (cache as unknown as Record<string, unknown>)['created_ts'] as number | undefined
  const ageSecs = createdTs ? Math.max(0, Date.now() / 1000 - createdTs) : 0

  const budget = computeAdaptiveBudget(cache, ageSecs, {
    contextPressure: getContextPressure(cache),
  })

  return _buildManifestText(cache, budget)
}

/**
 * Build manifest and return both text and event count.
 */
export function buildManifestWithCount(
  sessionId: string,
  opts?: { maxTokens?: number }
): [string, number] {
  const cache = _loadSessionCache(sessionId)
  if (!cache) {
    return ['', 0]
  }

  const editedCount = Object.keys(cache.editedFiles ?? {}).length
  const readCount = Object.keys(cache.files ?? {}).length
  const bashCount = Object.keys(cache.bashHistory ?? {}).length
  const webCount = Object.keys(cache.webHistory ?? {}).length
  const skillCount = Object.keys(cache.skillHistory ?? {}).length

  const eventCount = editedCount + readCount + bashCount + webCount + skillCount

  const manifest = buildManifest(sessionId, opts)
  return [manifest, eventCount]
}
