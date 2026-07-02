/**
 * Persistent store for loaded-skill bodies.
 *
 * Every skill load records the body to a text file under `data_dir() / "skills"`
 * keyed by session ID, skill name, and content hash. After compaction, the agent
 * can recall the full body via the CLI without re-invoking the skill.
 *
 * Why a separate disk store:
 * - Skill bodies can be tens of KB. Inlining into session JSON bloats round trips.
 * - CLI retrieval can stream the file directly without re-parsing JSON.
 * - Retention is simple to bound by total bytes via LRU eviction.
 * - Cross-session dedup: the same skill body reuses the existing file.
 */

import * as fs from 'fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { homedir } from 'os'
import { dataDir } from './constants.js'
import { atomicWriteText, isCodeFenceDelimiter } from './util.js'
import { registerReset } from './reset.js'
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { DEFAULT_MAX_COUNT, DEFAULT_MAX_AGE_MS } from './disk_cache.js'

const COMPACT_END_MARKER = '<!-- COMPACT_END -->'

// The 'skills' subdir name, exported so prune-cache/clean-cache (cache_session_commands.ts)
// can include it in their managed-subdirs list. Unlike the other cache subdirs, entries here
// are plain .txt/.meta/.hits/@compact files rather than disk_cache.ts's JSON blob envelope, so
// eviction is handled by this module's own pruneSkillOutputs rather than the generic pruneBlobs.
export const SKILLS_OUTPUT_SUBDIR = 'skills'

let _skillOutputsDirOverride: string | null = null
let _skillsSourceDirOverride: string | null = null

export function setSkillOutputsDirForTesting(dir: string | null): void {
  _skillOutputsDirOverride = dir
}

export function setSkillsSourceDirForTesting(dir: string | null): void {
  _skillsSourceDirOverride = dir
}

registerReset(() => {
  _skillOutputsDirOverride = null
  _skillsSourceDirOverride = null
})

export interface SkillMeta {
  readonly outputId: string
  readonly skillName: string
  readonly contentSha: string
  readonly bodyBytes: number
  readonly ts: number
  readonly truncated: boolean
  readonly sourcePath?: string
}

export interface CachedSkillInfo {
  readonly name: string
  readonly bodyLen: number
  readonly compactLen: number
  readonly hasMarker: boolean
  readonly compactStale: boolean | null
  readonly hitCount: number
  readonly ageMs: number
}

export function skillOutputsDir(): string {
  if (_skillOutputsDirOverride) return _skillOutputsDirOverride
  return resolve(dataDir(), SKILLS_OUTPUT_SUBDIR)
}

// The on-disk source directory where Claude Code installs skills, one dir per skill containing a SKILL.md. Lazy homedir() so a test override (or spy) takes effect per call. This is the install location, distinct from skillOutputsDir() which is token-goat's body cache.
function skillsSourceDir(): string {
  if (_skillsSourceDirOverride) return _skillsSourceDirOverride
  return resolve(homedir(), '.claude', 'skills')
}

async function ensureSkillsDir(): Promise<void> {
  try {
    await fs.mkdir(skillOutputsDir(), { recursive: true })
  } catch {
    // already exists
  }
}

export function contentHash(content: string): string {
  return createHash('sha256')
    .update(content, 'utf-8')
    .digest('hex')
    .slice(0, 16)
}

function safeSessionFragment(sessionId: string): string {
  let result = ''
  for (const c of sessionId) {
    if (result.length >= 16) break
    if (/[a-zA-Z0-9_-]/.test(c)) {
      result += c
    }
  }
  return result.slice(0, 16)
}

function safeSkillName(skillName: string): string | null {
  if (!skillName || skillName.length > 128) return null
  if (!/^[A-Za-z0-9_:-]+$/.test(skillName)) return null
  return skillName.replace(/[^a-zA-Z0-9_:-]/g, '_')
}

/** Return a filename-safe version of a skill name: colons are invalid on Windows and must be replaced. Used for all on-disk compact file paths so store/get/list always agree. Substitutes ':' for '~' rather than '_': '~' falls outside safeSkillName's allowed charset (A-Za-z0-9_:-), so it can never occur in a name that reaches this function, making the substitution truly injective — a literal '_' is left untouched and can never collide with a colon-derived '~'. (A prior '_' + discriminator-suffix scheme was not injective: 'test:a' and 'test_an' both produced 'test_an'.) */
function sanitizeSkillId(name: string): string {
  return name.replace(/:/g, '~')
}

function sessionSkillPrefix(sessionId: string, skillName: string): string {
  const safeSession = safeSessionFragment(sessionId)
  return `${safeSession}-${sanitizeSkillId(skillName)}-`
}

export function outputIdFor(sessionId: string, skillName: string, contentSha: string): string {
  return `${sessionSkillPrefix(sessionId, skillName)}${contentSha}`
}

export function extractCompactFromMarker(body: string): string | null {
  if (!body || !body.includes(COMPACT_END_MARKER)) {
    return null
  }

  let inCodeBlock = false
  const lines = body.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) continue

    if (stripped === COMPACT_END_MARKER) {
      const preMarker = lines.slice(0, i).join('\n').trim()
      return preMarker || null
    }
  }

  return null
}

export function extractH2Headings(body: string): string[] {
  if (!body) return []

  const headings: string[] = []
  let inCodeBlock = false

  for (const line of body.split('\n')) {
    const stripped = line.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inCodeBlock = !inCodeBlock
    } else if (!inCodeBlock && stripped.startsWith('## ') && stripped.length > 3) {
      headings.push(stripped.slice(3).trim())
    }
  }

  return headings
}

export function extractAllHeadings(body: string, maxLevel: number = 3): Array<[level: number, title: string]> {
  if (!body) return []

  const headings: Array<[number, string]> = []
  let inCodeBlock = false

  for (const line of body.split('\n')) {
    const stripped = line.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock || !stripped.startsWith('#')) {
      continue
    }

    const level = stripped.length - stripped.replace(/^#+/, '').length
    if (level < 2 || level > maxLevel) {
      continue
    }

    const title = stripped.slice(level).trim()
    if (title) {
      headings.push([level, title])
    }
  }

  return headings
}

function stripLower(text: string): string {
  return text.trim().toLowerCase()
}

function parseSectionOrdinal(heading: string): [baseHeading: string, ordinal: number] {
  const match = heading.match(/^(.*?)(?:#(\d+))?$/)
  if (!match) return [heading, 1]

  const baseHeading = match[1] || heading
  const ordinal = match[2] ? Math.max(1, parseInt(match[2], 10)) : 1
  return [baseHeading, ordinal]
}

export function extractNamedSection(body: string, heading: string): string | null {
  if (!body || !heading) return null

  const [baseHeading, ordinal] = parseSectionOrdinal(heading)
  const headingLower = stripLower(baseHeading)
  const lines = body.split('\n')
  const n = lines.length

  let matchCount = 0
  let startIdx = -1

  let inCodeBlock = false
  for (let i = 0; i < n; i++) {
    const stripped = lines[i]!.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) continue

    if (stripped.startsWith('## ') && stripped.length > 3) {
      const headingText = stripLower(stripped.slice(3))
      if (headingText.startsWith(headingLower)) {
        matchCount++
        if (matchCount === ordinal) {
          startIdx = i + 1
          break
        }
      }
    }
  }

  if (startIdx === -1) return null

  const bodyLines: string[] = []
  let inBodyCodeBlock = false
  for (let j = startIdx; j < n; j++) {
    const stripped = lines[j]!.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inBodyCodeBlock = !inBodyCodeBlock
    }

    if (!inBodyCodeBlock && stripped.startsWith('## ')) {
      break
    }

    bodyLines.push(lines[j]!)
  }

  const text = bodyLines.join('\n').trim()
  return text || null
}

export function extractChecklistSection(body: string): string | null {
  if (!body) return null

  const checklistHeadings = ['checklist', 'check list', 'to-do', 'todo']
  const lines = body.split('\n')
  const n = lines.length

  let bestPriority = checklistHeadings.length
  let bestStart = -1

  let inCodeBlock = false
  for (let i = 0; i < n; i++) {
    const stripped = lines[i]!.trim()

    if (isCodeFenceDelimiter(stripped)) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) continue

    if (stripped.startsWith('## ') && stripped.length > 3) {
      const headingText = stripLower(stripped.slice(3))
      for (let p = 0; p < checklistHeadings.length; p++) {
        if (headingText.startsWith(checklistHeadings[p]!)) {
          if (p < bestPriority) {
            bestPriority = p
            bestStart = i
          }
          break
        }
      }
    }
  }

  if (bestStart === -1) return null

  const bodyLines: string[] = []
  let inBodyCodeBlock = false
  for (let j = bestStart + 1; j < n; j++) {
    const stripped = lines[j]!.trim()
    if (isCodeFenceDelimiter(stripped)) {
      inBodyCodeBlock = !inBodyCodeBlock
    }
    if (!inBodyCodeBlock && stripped.startsWith('## ')) break
    bodyLines.push(lines[j]!)
  }

  let text = bodyLines.join('\n').trim()
  const maxChars = 2000
  if (text.length > maxChars) {
    const cut = maxChars - 1
    text = text.slice(0, cut).trimEnd() + '…'
  }

  return text || null
}

export async function listOutputs(): Promise<SkillMeta[]> {
  try {
    const dir = skillOutputsDir()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const metas: SkillMeta[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta')) {
        continue
      }

      try {
        const content = await fs.readFile(resolve(dir, entry.name), 'utf-8')
        const meta = JSON.parse(content) as SkillMeta
        metas.push(meta)
      } catch {
        continue
      }
    }

    return metas
  } catch {
    return []
  }
}

/**
 * Return true when a skill body for *skillName* was already cached under
 * *sessionId* earlier this session (a stored outputId carries this session's
 * fragment and name). The pre-skill hook uses this to advise recall over a
 * wasteful full re-load. Cross-session dedup may suppress a same-session meta,
 * so a miss is conservative (no false-positive advisories), never a false hit.
 */
export async function hasSessionOutput(sessionId: string, skillName: string): Promise<boolean> {
  try {
    if (!sessionId) return false
    const name = safeSkillName(skillName)
    if (!name) return false
    // Exact match on the stored skillName field (not a filename-derived prefix): a raw
    // outputId.startsWith(prefix) check let a shorter name (e.g. 'ralph-loop') falsely
    // match a differently-named skill whose outputId happens to start with the same
    // literal text (e.g. 'ralph-loop-extended'). Comparing the structured field instead
    // of the flattened filename eliminates that class of collision entirely.
    const safeSession = safeSessionFragment(sessionId)
    const metas = await listOutputs()
    return metas.some(m => m.skillName === name && m.outputId.startsWith(`${safeSession}-`))
  } catch {
    return false
  }
}

export async function findCrossSessionEntry(skillName: string, contentSha: string): Promise<SkillMeta | null> {
  const name = safeSkillName(skillName)
  if (!name || !contentSha) return null

  try {
    const metas = await listOutputs()
    for (const meta of metas) {
      if (meta.skillName !== name || meta.contentSha !== contentSha) {
        continue
      }

      const dir = skillOutputsDir()
      const bodyPath = resolve(dir, `${meta.outputId}.txt`)
      const gzPath = resolve(dir, `${meta.outputId}.gz`)

      try {
        const bodyExists = await fs
          .access(bodyPath)
          .then(() => true)
          .catch(() => false)
        const gzExists = await fs
          .access(gzPath)
          .then(() => true)
          .catch(() => false)

        if (bodyExists || gzExists) {
          return meta
        }
      } catch {
        continue
      }
    }
  } catch {
    return null
  }

  return null
}

export async function storeOutput(
  sessionId: string,
  skillName: string,
  body: string,
  opts?: { sourcePath?: string }
): Promise<SkillMeta | null> {
  try {
    await ensureSkillsDir()

    const name = safeSkillName(skillName)
    if (!name) return null

    const sha = contentHash(body)
    const existing = await findCrossSessionEntry(skillName, sha)
    if (existing) {
      return existing
    }

    const outId = outputIdFor(sessionId, skillName, sha)
    const dir = skillOutputsDir()
    const ts = Date.now()
    const bodyBytes = Buffer.byteLength(body, 'utf-8')
    const truncated = bodyBytes > 256 * 1024

    let storedBody = body
    if (truncated) {
      const buf = Buffer.from(body, 'utf-8')
      const truncBuf = buf.slice(Math.max(0, buf.length - 262144))
      storedBody = truncBuf.toString('utf-8')
    }
    await atomicWriteText(resolve(dir, `${outId}.txt`), storedBody)

    const meta: SkillMeta = {
      outputId: outId,
      skillName: name,
      contentSha: sha,
      bodyBytes,
      ts,
      truncated,
      sourcePath: opts?.sourcePath || '',
    }

    await atomicWriteText(resolve(dir, `${outId}.meta`), JSON.stringify(meta, null, 2))

    return meta
  } catch {
    return null
  }
}

export async function storeCompact(
  sessionId: string,
  skillName: string,
  compactText: string,
  sourceSha?: string
): Promise<void> {
  try {
    await ensureSkillsDir()

    const name = safeSkillName(skillName)
    if (!name) return

    const safeSession = safeSessionFragment(sessionId)
    const fileId = `${safeSession}@${sanitizeSkillId(name)}@compact`
    const dir = skillOutputsDir()

    let text = compactText
    if (sourceSha) {
      text = `<!-- source_sha: ${sourceSha.slice(0, 12)} -->\n${text}`
    }

    await atomicWriteText(resolve(dir, fileId), text)
  } catch {
    // fail-soft
  }
}

export async function getCompact(sessionId: string, skillName: string): Promise<string | null> {
  try {
    const name = safeSkillName(skillName)
    if (!name) return null

    const safeSession = safeSessionFragment(sessionId)
    const fileId = `${safeSession}@${sanitizeSkillId(name)}@compact`
    const dir = skillOutputsDir()
    const path = resolve(dir, fileId)

    try {
      const text = await fs.readFile(path, 'utf-8')
      return text.trim() ? text : null
    } catch {
      return null
    }
  } catch {
    return null
  }
}

export async function getCompactAnySession(skillName: string): Promise<string | null> {
  try {
    const name = safeSkillName(skillName)
    if (!name) return null

    const dir = skillOutputsDir()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    // Match the exact '@'-delimited suffix, not a raw substring: '@' cannot occur in a
    // sanitized name (outside safeSkillName's charset), so this can never match a
    // differently-named skill whose sanitized name merely ends with this one's text
    // (e.g. name 'loop' must not match a stored file for 'ralph-loop').
    const suffix = `@${sanitizeSkillId(name)}@compact`

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('@compact')) continue
      if (!entry.name.endsWith(suffix)) continue

      try {
        const text = await fs.readFile(resolve(dir, entry.name), 'utf-8')
        if (text.trim()) return text
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

// Synchronous sibling of getCompactAnySession for the hot pre-read path: first non-empty cached compact body for a skill across sessions, or null.
export function getCompactAnySessionSync(skillName: string): string | null {
  try {
    const name = safeSkillName(skillName)
    if (!name) return null
    const dir = skillOutputsDir()
    const entries = readdirSync(dir, { withFileTypes: true })
    const suffix = `@${sanitizeSkillId(name)}@compact`
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('@compact')) continue
      if (!entry.name.endsWith(suffix)) continue
      try {
        const text = readFileSync(resolve(dir, entry.name), 'utf-8')
        if (text.trim()) return text
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

// Extract the source SHA from a cached compact's embedded comment (<!-- source_sha: <sha12> -->), returning the 12-char hex string or null if not found.
export function extractSourceShaFromCompact(compactText: string): string | null {
  if (!compactText) return null
  const match = compactText.match(/<!--\s*source_sha:\s*([a-f0-9]{12})\s*-->/)
  return match ? match[1]! : null
}

// Determine staleness: return true if compact is stale, false if fresh, null if indeterminate (no compact, no source SHA in it, or body can't be resolved).
export function isCompactStale(compactText: string | null, skillName: string, currentBodySha: string): boolean | null {
  if (!compactText) return null
  const embeddedSha = extractSourceShaFromCompact(compactText)
  if (!embeddedSha) return null
  const currentSha = currentBodySha.slice(0, 12)
  return embeddedSha !== currentSha
}

// Read or create hit count sidecar for a skill (<skillOutputsDir>/<sanitizeSkillId(name)>.hits), returning {count, lastTs}. Routes skillName through safeSkillName like every other cache-writing path in this file, so a name with characters unsafe for a filename (or a scoped name like 'apps/web:deploy') can't bypass validation and produce a cache key inconsistent with storeOutput/storeCompact.
export async function readSkillHits(skillName: string): Promise<{ count: number; lastTs: number }> {
  try {
    const name = safeSkillName(skillName)
    if (!name) return { count: 0, lastTs: 0 }
    const dir = skillOutputsDir()
    const hitsFile = resolve(dir, `${sanitizeSkillId(name)}.hits`)
    const content = await fs.readFile(hitsFile, 'utf-8').catch(() => null)
    if (content) {
      const parsed = JSON.parse(content) as { count: number; lastTs: number }
      return parsed
    }
  } catch {
    // ignore
  }
  return { count: 0, lastTs: 0 }
}

// Increment hit count sidecar for a skill. Same safeSkillName routing as readSkillHits.
export async function incrementSkillHit(skillName: string): Promise<void> {
  try {
    const name = safeSkillName(skillName)
    if (!name) return
    await ensureSkillsDir()
    const hits = await readSkillHits(name)
    hits.count++
    hits.lastTs = Date.now()
    const dir = skillOutputsDir()
    const hitsFile = resolve(dir, `${sanitizeSkillId(name)}.hits`)
    await atomicWriteText(hitsFile, JSON.stringify(hits, null, 2))
  } catch {
    // fail-soft
  }
}

// Format age in milliseconds as human-readable string (e.g., "5m", "2h", "1d").
export function formatAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export async function listSkills(sessionId?: string): Promise<CachedSkillInfo[]> {
  try {
    const metas = await listOutputs()
    const results: CachedSkillInfo[] = []
    const seen = new Set<string>()

    for (const meta of metas) {
      if (sessionId && !meta.outputId.startsWith(safeSessionFragment(sessionId))) {
        continue
      }

      if (seen.has(meta.skillName)) continue
      seen.add(meta.skillName)

      const dir = skillOutputsDir()
      // Recover the session fragment by stripping the known '-<name>-<sha>' suffix from
      // the tail of outputId, rather than splitting on the first hyphen: a session id's
      // safe fragment (up to 16 chars of [a-zA-Z0-9_-]) commonly contains its own hyphens
      // (e.g. a UUID), so splitting on the first '-' truncated the fragment early and
      // desynced compactFileId from the path storeCompact actually wrote.
      const sanitizedName = sanitizeSkillId(meta.skillName)
      const outputSuffix = `-${sanitizedName}-${meta.contentSha}`
      const safeSession = meta.outputId.endsWith(outputSuffix)
        ? meta.outputId.slice(0, meta.outputId.length - outputSuffix.length)
        : safeSessionFragment(meta.outputId.split('-')[0]!)
      const compactFileId = `${safeSession}@${sanitizedName}@compact`

      let compactLen = 0
      let compactText = ''
      try {
        const stat = await fs.stat(resolve(dir, compactFileId))
        compactLen = stat.size
        compactText = await fs.readFile(resolve(dir, compactFileId), 'utf-8').catch(() => '')
      } catch {
        compactLen = 0
      }

      const hasMarker = extractCompactFromMarker(
        await fs.readFile(resolve(dir, `${meta.outputId}.txt`), 'utf-8').catch(() => '')
      ) !== null

      const compactStale = isCompactStale(compactText, meta.skillName, meta.contentSha)
      const { count: hitCount } = await readSkillHits(meta.skillName)
      const ageMs = Date.now() - meta.ts

      results.push({
        name: meta.skillName,
        bodyLen: meta.bodyBytes,
        compactLen,
        hasMarker,
        compactStale,
        hitCount,
        ageMs,
      })
    }

    return results
  } catch {
    return []
  }
}

export async function getAllCachedSkills(sessionId?: string): Promise<CachedSkillInfo[]> {
  return listSkills(sessionId)
}

export async function getSkillFilePath(skillName: string): Promise<string | null> {
  try {
    const name = safeSkillName(skillName)
    if (!name) return null

    const metas = await listOutputs()
    for (const meta of metas) {
      if (meta.skillName === name && meta.sourcePath) {
        return meta.sourcePath
      }
    }

    // Cache miss: fall back to the on-disk skill install at ~/.claude/skills/<name>/SKILL.md, so skill-compact/skill-body resolve for any installed skill even when it was never loaded via the Skill hook this session.
    return await installedSkillPath(name)
  } catch {
    return null
  }
}

// Resolve the on-disk install path of a skill (~/.claude/skills/<name>/SKILL.md) if it exists, else null. `name` is sanitized by safeSkillName (no slash or dot), so there is no path-traversal risk. Shared by getSkillFilePath's cache-miss fallback and the Skill hook's sourcePath resolution.
export async function installedSkillPath(skillName: string): Promise<string | null> {
  const name = safeSkillName(skillName)
  if (!name) return null
  const diskPath = resolve(skillsSourceDir(), name, 'SKILL.md')
  try {
    await fs.access(diskPath)
    return diskPath
  } catch {
    return null
  }
}

/**
 * Evict skill-output entries (paired .meta/.txt/.gz files, keyed by each entry's
 * stored `ts`) beyond maxCount or older than maxAgeMs. Sync, matching prune-cache /
 * clean-cache's synchronous CLI path (mirrors getCompactAnySessionSync's sync sibling
 * pattern for the same reason).
 *
 * This directory doesn't use disk_cache.ts's generic pruneBlobs: that helper only
 * recognizes single self-contained '<id>.json' blobs, but a skill output is a group
 * of related files (.meta metadata + .txt body, occasionally .gz) that must be
 * evicted together, so it needs its own eviction pass. Sidecar .hits/@compact files
 * are left in place — they're small and self-heal via storeCompact/incrementSkillHit's
 * own atomic writes on next access.
 *
 * Returns the number of evicted entries (not the number of files removed).
 */
export function pruneSkillOutputs(
  maxCount: number = DEFAULT_MAX_COUNT,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): number {
  const dir = skillOutputsDir()
  let removed = 0
  try {
    if (!existsSync(dir)) return 0
    const cutoff = Date.now() - maxAgeMs
    const entries: Array<{ outputId: string; ts: number }> = []

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.meta')) continue
      const outputId = file.slice(0, -'.meta'.length)
      let ts: number
      try {
        const parsed = JSON.parse(readFileSync(resolve(dir, file), 'utf-8')) as SkillMeta
        ts = parsed.ts
      } catch {
        try {
          ts = statSync(resolve(dir, file)).mtimeMs
        } catch {
          continue
        }
      }
      entries.push({ outputId, ts })
    }

    const removeEntry = (outputId: string): void => {
      for (const ext of ['.meta', '.txt', '.gz']) {
        try {
          unlinkSync(resolve(dir, `${outputId}${ext}`))
        } catch {
          // already gone or never existed
        }
      }
      removed++
    }

    const kept: Array<{ outputId: string; ts: number }> = []
    for (const entry of entries) {
      if (entry.ts < cutoff) {
        removeEntry(entry.outputId)
      } else {
        kept.push(entry)
      }
    }

    if (kept.length > maxCount) {
      kept.sort((a, b) => a.ts - b.ts)
      for (const entry of kept.slice(0, kept.length - maxCount)) {
        removeEntry(entry.outputId)
      }
    }
  } catch {
    return removed
  }
  return removed
}
