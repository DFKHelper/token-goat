/**
 * Session manifest generator for compaction assist.
 *
 * Ports key functions from Python's `token_goat.compact` for TypeScript.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { detectHarness } from './bridges/index.js'
import { isAutoTriggerMultiplierExplicit, loadConfig } from './config.js'
import { dataDir } from './constants.js'
import { tokenGoatHome } from './disk_cache.js'
import { atomicWriteText, normalizePathForwardSlash, sanitizeIdForFilename } from './util.js'
import { stripAnsiCodes } from './bash_compress.js'
import { readSessionStateFile, AGENT_SALT_MARKER } from './session_store.js'
import type { FileEntry } from './session.js'

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
]

// Per-harness auto-trigger multiplier defaults for getAutoTriggerMultiplier().
// 'openclaw', 'pi', and 'hermes' have no dedicated tuning yet, so they match
// 'generic' until there's a clear reason to diverge (see
// bridges/registry.ts::detectHarness for the canonical harness-detection
// implementation this keys off of).
const HARNESS_MULTIPLIER_DEFAULTS: Record<string, number> = {
  claudecode: 2.0,
  codex: 1.5,
  opencode: 2.5,
  gemini: 3.0,
  openclaw: 1.0,
  pi: 1.0,
  hermes: 1.0,
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
  /**
   * Matches the real on-disk shape session_store.ts::SerializedSession
   * actually produces — an array of `[key, id]` pairs (see session.ts's
   * `_webFetches`/`_bashOutputs` maps and their `recordWebFetch`/
   * `recordBashOutput` writers), not a `bashHistory`/`webHistory` dict shape
   * no writer ever populated.
   */
  webFetches?: Array<[string, string]>
  bashOutputs?: Array<[string, string]>
  /**
   * Matches the real on-disk shape session_store.ts::saveSessionState writes
   * (`SerializedSession.files: FileEntry[]`) — a flat array, not a path-keyed
   * dict. Each entry's `wasEdited` flag distinguishes edited from read-only
   * files; there is no separate `editedFiles` collection on disk.
   */
  files?: FileEntry[]
  symbolAccessCounts?: Record<string, number>
  skillHistory?: Record<string, unknown>
  /**
   * Unix time in *seconds* the on-disk session cache was first created (written
   * once by session_store.ts::saveSessionState). buildManifestAdaptive derives
   * the session-age budget multiplier from it; undefined for a cache written
   * before this field existed (age then treated as 0).
   */
  created_ts?: number
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
 * Rough token estimate: ~3 chars/token (conservative vs. the true 3.5 ratio). Strips ANSI color
 * codes before counting (matches overflow_guard.ts's estimateTokens) so colored bash/tool output
 * embedded in transcripts and briefings doesn't inflate the estimate.
 */
export function estimateTokens(text: string): number {
  const stripped = stripAnsiCodes(text)
  return Math.max(1, Math.floor(stripped.length / 3) + 1)
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
  const bashCount = (cache.bashOutputs ?? []).length
  const webCount = (cache.webFetches ?? []).length
  const files = cache.files ?? []
  const readCount = files.length
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
// Effective auto-compact window, scaled by the harness-tuned (or user-overridden)
// multiplier: different harnesses reach their own real auto-compact point at very
// different token counts, so CONTEXT_AUTOCOMPACT_TOKENS (Claude Code's own figure)
// needs scaling before it means anything for other harnesses.
function getEffectiveAutoTriggerWindow(): number {
  const ca = loadConfig().compact_assist
  const isConfigDefault = !isAutoTriggerMultiplierExplicit()
  const multiplier = getAutoTriggerMultiplier(
    ca.harness === 'auto'
      ? { configExplicitMultiplier: ca.auto_trigger_multiplier, isConfigDefault }
      : { configExplicitMultiplier: ca.auto_trigger_multiplier, harness: ca.harness, isConfigDefault },
  )
  return CONTEXT_AUTOCOMPACT_TOKENS * multiplier
}

export function getContextPressure(cache?: SessionCacheObject): ContextPressure {
  try {
    if (!cache) {
      return { fillFraction: 0.0, tier: 'cool' }
    }
    const rawTotal = pressureRawTotal(cache)
    const baseline = cache.pressureBaselineTokens ?? 0
    const total = Math.max(0, rawTotal - baseline)
    const window = getEffectiveAutoTriggerWindow()
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
    const editedPaths = (cache.files ?? []).filter((f) => f.wasEdited).map((f) => f.path)
    const symbolAccessRaw = cache.symbolAccessCounts ?? {}

    if (editedPaths.length < 2 && Object.keys(symbolAccessRaw).length === 0) {
      return ''
    }

    const dirCounts = new Counter<string>()
    for (const fpath of editedPaths) {
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
    if (goalTokens > maxTokens) {
      // Reserve room for the 3-char ellipsis suffix so the truncated result (mirroring
      // estimateTokens's ~length/3 heuristic) actually lands back within maxTokens.
      const maxChars = Math.max(0, (maxTokens - 2) * 3)
      return `${goal.slice(0, maxChars).trimEnd()}...`
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
 *
 * Excludes agent-salted blobs (filenames containing {@link AGENT_SALT_MARKER},
 * the sanitized form of relay.ts's `sessionStateKey` `:agent:` separator): a
 * subagent's blob is frequently the newest file on disk (subagents run after
 * the parent's own last tool call), so without this filter, "latest session"
 * for a caller that gave no explicit session id could resolve to a narrow
 * subagent-scoped ledger instead of the genuine parent/top-level session.
 */
export function findLatestSessionId(): string | null {
  try {
    const sessionsDir = path.join(tokenGoatHome(), 'sessions')
    if (!fs.existsSync(sessionsDir)) {
      return null
    }

    const files = fs.readdirSync(sessionsDir)
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes(AGENT_SALT_MARKER))
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
  const files = cache.files ?? []
  const editedCount = files.filter((f) => f.wasEdited).length
  const bashCount = (cache.bashOutputs ?? []).length
  const webCount = (cache.webFetches ?? []).length
  const skillHistory = cache.skillHistory ?? {}

  return (
    files.length +
    editedCount +
    bashCount +
    webCount +
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
  const safeSessionId = sanitizeIdForFilename(sessionId, 64)
  if (!safeSessionId) return
  const sessionsDir = path.join(dataDir(), 'projects', projectHash, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true })
  }
  const dest = path.join(sessionsDir, `${safeSessionId}.json`)
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
          // Opportunistic cleanup: an expired manifest is never coming back into the
          // TTL window, so delete it here instead of leaving it to accumulate forever.
          // Best-effort -- a delete failure (concurrent access, permissions) must never
          // break the read path itself.
          try {
            fs.unlinkSync(fullPath)
          } catch {
            // ignore cleanup failure
          }
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

// ---------------------------------------------------------------------------
// Helpers for computing adaptive budget
// ---------------------------------------------------------------------------

function _editedFileCount(cache: SessionCacheObject): number {
  return (cache.files ?? []).filter((f) => f.wasEdited).length
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

export function loadSessionCache(sessionId: string): SessionCacheObject | null {
  // Reuse session_store.ts's own read/coercion (readSessionStateFile) instead
  // of re-parsing the JSON here: it already normalizes both the current
  // FileEntry[] array format and the legacy Python path-keyed dict format,
  // and reads from the same tokenGoatHome()-based path saveSessionState
  // writes to.
  const disk = readSessionStateFile(sessionId)
  if (!disk) {
    return null
  }
  return {
    files: disk.files,
    webFetches: disk.webFetches,
    bashOutputs: disk.bashOutputs,
    ...(disk.created_ts !== undefined ? { created_ts: disk.created_ts } : {}),
  }
}

// ---------------------------------------------------------------------------
// Build manifest from loaded cache
// ---------------------------------------------------------------------------

function _buildManifestText(cache: SessionCacheObject, maxTokens: number): string {
  const lines: string[] = []
  lines.push('# token-goat session manifest')
  lines.push('')

  const files = cache.files ?? []
  const editedFiles = files.filter((f) => f.wasEdited)
  const readFiles = files.filter((f) => !f.wasEdited)
  const bashOutputs = cache.bashOutputs ?? []
  const webFetches = cache.webFetches ?? []

  const usedTokens = estimateTokens(lines.join('\n'))
  const budgetRemaining = maxTokens - usedTokens

  if (editedFiles.length > 0) {
    lines.push('## Edited files')
    let sectionTokens = estimateTokens('## Edited files\n')
    for (const entry of editedFiles) {
      if (sectionTokens > budgetRemaining * 0.4) break
      const cleanPath = normalizePathForwardSlash(entry.path)
      if (!isNoisePath(cleanPath)) {
        lines.push(`- ${cleanPath}`)
        sectionTokens += estimateTokens(`- ${cleanPath}\n`)
      }
    }
    lines.push('')
  }

  if (readFiles.length > 0) {
    lines.push('## Files read')
    let sectionTokens = estimateTokens('## Files read\n')
    const sortedRead = [...readFiles].sort((a, b) => b.readCount - a.readCount)
    for (const entry of sortedRead.slice(0, 15)) {
      if (sectionTokens > budgetRemaining * 0.3) break
      const cleanPath = normalizePathForwardSlash(entry.path)
      if (!isNoisePath(cleanPath)) {
        const truncatedTag = entry.wasTruncated ? ' (truncated)' : ''
        lines.push(`- ${cleanPath}${truncatedTag}`)
        sectionTokens += estimateTokens(`- ${cleanPath}${truncatedTag}\n`)
      }
    }
    lines.push('')
  }

  if (bashOutputs.length > 0) {
    lines.push('## Recent bash')
    lines.push('(bash history recorded)')
    lines.push('')
  }

  if (webFetches.length > 0) {
    lines.push('## Web fetches')
    let sectionTokens = estimateTokens('## Web fetches\n')
    // webFetches entries are `[url\x00prompt, cacheId]` pairs (see session.ts's
    // recordWebFetch) — surface the distinct URLs, dropping the prompt suffix.
    const urls = Array.from(new Set(webFetches.map(([key]) => key.split('\x00')[0] ?? key)))
    for (const url of urls.slice(0, 10)) {
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

  const files = cache.files ?? []
  const symbolFiles = files.filter((f) => {
    const entry = f as unknown as Record<string, unknown>
    return ((entry['symbols_read'] as unknown[]) ?? []).length > 0
  }).length
  const symbolsBonus = Math.min(150, symbolFiles * 30)

  const bashCount = (cache.bashOutputs ?? []).length
  const bashBonus = bashCount > 0 ? Math.min(100, Math.max(20, bashCount * 5)) : 0

  const webBonus = (cache.webFetches ?? []).length > 0 ? 15 : 0

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
  const cache = loadSessionCache(sessionId)
  if (!cache) {
    return ''
  }

  return _buildManifestText(cache, maxTokens)
}

/**
 * Build manifest with adaptively-computed budget.
 */
export function buildManifestAdaptive(sessionId: string): string {
  const cache = loadSessionCache(sessionId)
  if (!cache) {
    return ''
  }

  const createdTs = cache.created_ts
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
  const cache = loadSessionCache(sessionId)
  if (!cache) {
    return ['', 0]
  }

  const evCount = eventCount(cache)
  const manifest = buildManifest(sessionId, opts)
  return [manifest, evCount]
}
