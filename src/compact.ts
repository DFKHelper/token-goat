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
import { ensureDirSync, atomicWriteText, normalizePathForwardSlash } from './util.js'
import { estimateTokens } from './overflow_guard.js'
import { displaySafeText } from './paths.js'
import { readSessionStateFile, sessionFileStem, AGENT_SALT_MARKER } from './session_store.js'
import { WEB_FETCH_KEY_SEP } from './session.js'
import type { FileEntry } from './session.js'
import { readTranscriptTail } from './resident_context.js'

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

// estimateTokens is re-exported from overflow_guard.ts (single canonical implementation) so
// existing `import { estimateTokens } from './compact.js'` call sites keep working.
export { estimateTokens }

/**
 * Map a context-fill fraction to its qualitative pressure tier.
 */
export function tierForFraction(fill: number): 'cool' | 'warm' | 'hot' | 'critical' {
  if (fill >= CONTEXT_TIER_CRITICAL) return 'critical'
  if (fill >= CONTEXT_TIER_HOT) return 'hot'
  if (fill >= CONTEXT_TIER_WARM) return 'warm'
  return 'cool'
}

/** Return the estimated (never-measured) context pressure total for a cache. Used only when no real transcript measurement is available (see {@link measurePromptTokens}) -- e.g. a non-Claude-Code harness that never delivers a `transcript_path`, or a transcript that is missing/unreadable/carries no `usage` record yet. */
function pressureRawTotal(cache: SessionCacheObject): number {
  const skillTokens = cache.loadedSkillTotalTokens ?? 0
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

/** Tail window read for {@link measurePromptTokens}. Sized against a live 445 MB transcript on this machine: 275,377 records, largest single record 792,353 bytes, 11 records over 256 KB. A 256 KB window could therefore land entirely inside one record and find nothing, falling back to the fabricated estimate; 1 MiB clears the observed maximum with room to spare and still costs about half a millisecond per call, measured. It stays a bounded tail read, never a whole-file read. */
const PROMPT_MEASURE_TAIL_BYTES = 1_048_576

/** Pull the `usage` object out of one parsed transcript JSONL record, if present. Claude Code assistant records nest it at `message.usage` (verified against real transcript output from Claude Code 2.1.270 -- see `tests/fixtures/transcript_usage_capture.jsonl`), not at the record's top level. */
function extractUsageTotal(record: unknown): number | null {
  if (record === null || typeof record !== 'object') return null
  // Name the record being measured rather than taking any record that happens to carry a usage object. Scanned all 275,377 records of a live 445 MB transcript: every usage-bearing record is `type: "assistant"` and none is a sidechain. Re-checked on a second live transcript from a session that spawned many subagents: 59,883 usage records, still zero carrying `isSidechain`, so a subagent's usage does not land in its parent's transcript and no lane selector is needed here.
  if ((record as Record<string, unknown>)['type'] !== 'assistant') return null
  const message = (record as Record<string, unknown>)['message']
  if (message === null || typeof message !== 'object') return null
  const usage = (message as Record<string, unknown>)['usage']
  if (usage === null || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const input = u['input_tokens']
  const cacheCreation = u['cache_creation_input_tokens']
  const cacheRead = u['cache_read_input_tokens']
  const output = u['output_tokens']
  if (
    typeof input !== 'number' ||
    typeof cacheCreation !== 'number' ||
    typeof cacheRead !== 'number' ||
    typeof output !== 'number'
  ) {
    return null
  }
  // The three input fields describe the prompt of the request that *produced* this record; the reply it produced is resident in the next one. `output_tokens` is required alongside them rather than defaulted to zero: it is present on all 59,900 usage records of a live transcript, so a record missing it is a shape this reader has never seen and should decline rather than silently under-report. Measured across 31,758 consecutive record pairs of a live transcript: 31,430 (99.0%) have the next total at or above this total plus this record's output, and the 328 below it are compactions and branch resets, where the whole total drops. Omitting output therefore reports a prompt one reply short of the real one -- typically 424 tokens, but up to 20,276 observed, which is 3% of the auto-compact window at the moment the tier matters most.
  return input + cacheCreation + cacheRead + output
}

/** Measure the current prompt size (in tokens) from the harness's own transcript, rather than fabricating it from cumulative tool-call counts (see {@link pressureRawTotal}). Reads a bounded tail of `transcriptPath` (see {@link PROMPT_MEASURE_TAIL_BYTES}) and returns the sum of `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` from the *last* parseable `usage` record found there -- that sum already reflects every compaction that has happened in the session, so no baseline subtraction is needed on top of it. Returns null (never throws) when the file is missing, empty, unreadable, or carries no usage record in the tail window. */
export function measurePromptTokens(transcriptPath: string): number | null {
  try {
    const lines = readTranscriptTail(transcriptPath, PROMPT_MEASURE_TAIL_BYTES)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line === undefined) continue
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const total = extractUsageTotal(parsed)
      if (total !== null) return total
    }
    return null
  } catch {
    return null
  }
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

export function getContextPressure(cache?: SessionCacheObject, transcriptPath?: string): ContextPressure {
  try {
    const window = getEffectiveAutoTriggerWindow()
    // A real measurement from the harness's own transcript IS the total: it already reflects every compaction and every loaded skill/catalog, so nothing is added or subtracted on top of it. Only fall back to the fabricated estimate below when no measurement is available at all (no transcript path given, file unreadable, no usage record in the tail window) -- that keeps non-Claude-Code harnesses and cache-only unit tests working.
    if (transcriptPath) {
      const measured = measurePromptTokens(transcriptPath)
      if (measured !== null) {
        const fill = measured / window
        return { fillFraction: fill, tier: tierForFraction(fill) }
      }
    }
    if (!cache) {
      return { fillFraction: 0.0, tier: 'cool' }
    }
    const total = pressureRawTotal(cache)
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
/** Most-read files listed in the manifest before the rest are folded into an "and N more" line. */
const READ_SECTION_MAX_ROWS = 15

/** Distinct fetched URLs listed in the manifest before the rest are folded into an "and N more" line. */
const WEB_SECTION_MAX_ROWS = 10

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
  // Spell the filename with session_store's stem builder rather than a bare 64-char slice. The key passed in is sessionStateKey(event), so for a subagent it is `<sessionId>:agent:<agentId>`, and slicing that at 64 cuts the agent id -- or, once the session id reaches 58 sanitized characters, the `_agent_` marker itself -- so sibling subagents collapse onto one manifest. sessionFileStem hashes the agent id instead, which is the fix session_store.ts already carries for its own blobs.
  const safeSessionId = sessionFileStem(sessionId)
  if (!safeSessionId) return
  const sessionsDir = path.join(dataDir(), 'projects', projectHash, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    ensureDirSync(sessionsDir)
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
    // Noise filtered ahead of the loop for the same reason as the files-read section below: it
    // separates "excluded by design" from "dropped by the budget", which is what the count reports.
    const eligibleEdited = editedFiles.filter((e) => !isNoisePath(normalizePathForwardSlash(e.path)))
    let shownEdited = 0
    for (const entry of eligibleEdited) {
      if (sectionTokens > budgetRemaining * 0.4) break
      // The manifest is token-goat's own document and reaches the compacting model as a systemMessage, so the repo-chosen paths listed in it are escaped. Computed once so the budget accounting below measures the string actually emitted.
      const shownPath = displaySafeText(normalizePathForwardSlash(entry.path))
      lines.push(`- ${shownPath}`)
      sectionTokens += estimateTokens(`- ${shownPath}\n`)
      shownEdited += 1
    }
    // This section has no row cap -- only the budget break -- and a break drops rows exactly as
    // silently as a slice does. "Edited files" reading as complete when it is not is the worst of
    // the three: it is the list a reader is most likely to treat as the record of what changed.
    if (shownEdited < eligibleEdited.length) lines.push(`- ...and ${eligibleEdited.length - shownEdited} more`)
    lines.push('')
  }

  if (readFiles.length > 0) {
    lines.push('## Files read')
    let sectionTokens = estimateTokens('## Files read\n')
    const sortedRead = [...readFiles].sort((a, b) => b.readCount - a.readCount)
    // Noise paths are filtered BEFORE the cap, not inside the loop. Filtering inside meant the
    // slice spent its 15 places on entries that were then dropped, so a session whose most-read
    // paths were all noise rendered "## Files read" with nothing under it -- a heading asserting
    // that the list below is what was read.
    const eligibleRead = sortedRead.filter((e) => !isNoisePath(normalizePathForwardSlash(e.path)))
    let shownRead = 0
    for (const entry of eligibleRead.slice(0, READ_SECTION_MAX_ROWS)) {
      if (sectionTokens > budgetRemaining * 0.3) break
      const cleanPath = displaySafeText(normalizePathForwardSlash(entry.path))
      const truncatedTag = entry.wasTruncated ? ' (truncated)' : ''
      lines.push(`- ${cleanPath}${truncatedTag}`)
      sectionTokens += estimateTokens(`- ${cleanPath}${truncatedTag}\n`)
      shownRead += 1
    }
    // Counted from what was actually emitted, so it covers the row cap and the budget break
    // alike -- the break drops rows just as silently as the slice does, and reporting only
    // `eligible - cap` would understate it. Noise paths are excluded by design rather than
    // omitted by a cap, so they are not in this count.
    if (shownRead < eligibleRead.length) lines.push(`- ...and ${eligibleRead.length - shownRead} more`)
    lines.push('')
  }

  // Ported from Python's _build_manifest_from_cache (compact.py, section "6b.5. Session
  // Goal"), which wired infer_session_goal into the manifest so the compaction LLM gets
  // immediate context about what the session was trying to accomplish. The TS port carried
  // over inferSessionGoal itself (fully implemented, unit-tested in isolation) but never
  // called it from here, so `## Session goal` never appeared in any real manifest -- the
  // same "dead field" shape already fixed for symbolsBonus/created_ts above.
  const sessionGoal = inferSessionGoal(cache)
  if (sessionGoal) {
    lines.push('## Session goal')
    lines.push(sessionGoal)
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
    // webFetches keys are redactedUrl + redactedPrompt + digest composites (see webFetchKey in
    // session.ts) — surface the distinct URLs, dropping the prompt and digest fields.
    const urls = Array.from(new Set(webFetches.map(([key]) => key.split(WEB_FETCH_KEY_SEP)[0] ?? key)))
    let shownUrls = 0
    for (const url of urls.slice(0, WEB_SECTION_MAX_ROWS)) {
      if (sectionTokens > budgetRemaining * 0.2) break
      const shownUrl = displaySafeText(url)
      lines.push(`- ${shownUrl}`)
      sectionTokens += estimateTokens(`- ${shownUrl}\n`)
      shownUrls += 1
    }
    // Same accounting as the files section above: emitted-vs-eligible, so the budget break is
    // disclosed and not just the row cap.
    if (shownUrls < urls.length) lines.push(`- ...and ${urls.length - shownUrls} more`)
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
