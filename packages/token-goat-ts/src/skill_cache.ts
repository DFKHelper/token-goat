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
import { dataDir } from './constants.js'
import { atomicWriteText } from './util.js'
import { registerReset } from './reset.js'

const COMPACT_END_MARKER = '<!-- COMPACT_END -->'

let _skillOutputsDirOverride: string | null = null

export function setSkillOutputsDirForTesting(dir: string | null): void {
  _skillOutputsDirOverride = dir
}

registerReset(() => {
  _skillOutputsDirOverride = null
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
}

function skillOutputsDir(): string {
  if (_skillOutputsDirOverride) return _skillOutputsDirOverride
  return resolve(dataDir(), 'skills')
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

export function outputIdFor(sessionId: string, skillName: string, contentSha: string): string {
  const safeSession = safeSessionFragment(sessionId)
  let safeName = skillName.replace(':', '_')
  if (skillName.includes(':')) {
    safeName += 'n'
  }
  return `${safeSession}-${safeName}-${contentSha}`
}

export function extractCompactFromMarker(body: string): string | null {
  if (!body || !body.includes(COMPACT_END_MARKER)) {
    return null
  }

  let inCodeBlock = false
  const lines = body.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim()

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
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

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
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

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
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
  const ordinal = match[2] ? parseInt(match[2], 10) : 1
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

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
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
  for (let j = startIdx; j < n; j++) {
    const stripped = lines[j]!.trim()

    if (stripped.startsWith('## ')) {
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

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
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
  for (let j = bestStart + 1; j < n; j++) {
    const stripped = lines[j]!.trim()
    if (stripped.startsWith('## ')) break
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

async function listOutputs(): Promise<SkillMeta[]> {
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

    const storedBody = truncated ? body.slice(-262144) : body
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
    const fileId = `${safeSession}-${name}-compact`
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
    const fileId = `${safeSession}-${name}-compact`
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

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('-compact')) continue
      if (!entry.name.includes(`${name}-compact`)) continue

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
      const safeSession = safeSessionFragment(meta.outputId.split('-')[0]!)
      const compactFileId = `${safeSession}-${meta.skillName.replace(':', '_')}-compact`

      let compactLen = 0
      try {
        const stat = await fs.stat(resolve(dir, compactFileId))
        compactLen = stat.size
      } catch {
        compactLen = 0
      }

      const hasMarker = extractCompactFromMarker(
        await fs.readFile(resolve(dir, `${meta.outputId}.txt`), 'utf-8').catch(() => '')
      ) !== null

      results.push({
        name: meta.skillName,
        bodyLen: meta.bodyBytes,
        compactLen,
        hasMarker,
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

    return null
  } catch {
    return null
  }
}
