/**
 * Stable-doc compact serving for large reference docs.
 *
 * A compact is a user-created or auto-extractive summary of a large reference doc,
 * stored as a sidecar file. Compacts are served instead of full files to save
 * 80-95% of context tokens on first reads.
 */

import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'

import { dataDir } from './constants.js'
import { atomicWriteText } from './util.js'
import { resolveIndexPath } from './paths.js'

const defaultSentencesPerSection = 2
const headerPrefix = '<!-- token-goat doc-compact source-hash:'
const headerRegex = /^<!-- token-goat doc-compact source-hash:(\S+) source:(.+?) -->$/
const compactSubdir = 'doc_compacts'

/**
 * Get the SHA-256 hash of a file's content.
 */
function sourceHash(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(data).digest('hex')
  } catch {
    return ''
  }
}

/**
 * Deterministic filename component: hash prefix + stem slug.
 */
function _compactSlug(absPathStr: string): string {
  const h = crypto
    .createHash('sha256')
    .update(absPathStr.toLowerCase())
    .digest('hex')
    .slice(0, 12)

  const ext = path.extname(absPathStr)
  const stem = path.basename(absPathStr, ext)
  const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)

  return `${h}_${safeStem}`
}

/**
 * Resolve the sidecar path for a source document's extractive compact.
 *
 * Deterministic: the same source path always maps to the same sidecar file,
 * under the token-goat data dir, keyed by a hash of the absolute source path
 * so same-named docs in different projects never collide.
 */
export function compactPathFor(sourcePath: string): string {
  // Use the same absolute filesystem identity as the symbol index so aliases
  // such as macOS /var and /private/var cannot create duplicate sidecars.
  const abs = resolveIndexPath(sourcePath)
  return path.join(dataDir(), compactSubdir, `${_compactSlug(abs)}.md`)
}

/**
 * Parse the header line of a compact file.
 * Returns [sourceHash, sourceRel] or null if invalid/missing.
 */
function readCompactHeader(compactPath: string): [string, string] | null {
  try {
    const text = fs.readFileSync(compactPath, 'utf-8')
    const firstLine = text.split('\n')[0] || ''
    const m = firstLine.match(headerRegex)
    if (!m || !m[1] || !m[2]) return null
    return [m[1], m[2]]
  } catch {
    return null
  }
}

/**
 * Check if a compact's source hash matches the current source file.
 */
export function isCompactFresh(compactPath: string, sourcePath: string): boolean {
  const header = readCompactHeader(compactPath)
  if (!header) return false

  const [storedHash] = header
  if (storedHash === 'STALE') return false

  const currentHash = sourceHash(sourcePath)
  return !!currentHash && currentHash === storedHash
}

/**
 * Mark a compact as stale by replacing its source-hash with 'STALE'.
 * Returns true on success, false on error.
 */
export function markCompactStale(compactPath: string): boolean {
  try {
    if (!fs.existsSync(compactPath)) return false

    const text = fs.readFileSync(compactPath, 'utf-8')
    const lines = text.split('\n')
    if (!lines[0]) return false

    const m = lines[0].match(headerRegex)
    if (!m || m[1] === 'STALE') return false

    const oldHash = m[1]
    lines[0] = lines[0].replace(`source-hash:${oldHash}`, 'source-hash:STALE')
    atomicWriteText(compactPath, lines.join('\n'))
    return true
  } catch {
    return false
  }
}

/**
 * Read the compact body (everything after the header line).
 * Returns null if file cannot be read or has no body.
 */
export function readCompactBody(compactPath: string): string | null {
  try {
    const text = fs.readFileSync(compactPath, 'utf-8')
    const lines = text.split('\n')
    if (lines.length < 2) return null

    const body = lines.slice(1).join('\n').trimStart()
    return body.trim() ? body : null
  } catch {
    return null
  }
}

/**
 * Write a compact sidecar file with the correct header.
 */
export function writeCompact(
  compactPath: string,
  sourcePath: string,
  compactBody: string,
  sourceRel?: string,
): void {
  const srcPath = path.resolve(sourcePath)
  const sha = sourceHash(srcPath)
  const displayRel = sourceRel || path.basename(srcPath)
  const header = `${headerPrefix}${sha} source:${displayRel} -->\n`
  const fullText = header + compactBody.trimStart()

  const dir = path.dirname(compactPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  atomicWriteText(compactPath, fullText)
}

/**
 * Build an extractive compact from markdown: headings + first N sentences per section.
 *
 * Algorithm:
 *   - Emit every ATX heading verbatim (# / ## / ### etc.).
 *   - After each heading, collect first `maxSentences` non-empty non-heading lines.
 *   - Code blocks (``` fences) are included verbatim up to 10 lines.
 *   - Front-matter (--- fences at top) is skipped.
 */
export function buildExtractiveCompact(text: string, maxSentences?: number): string {
  const max = maxSentences ?? defaultSentencesPerSection
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  const out: string[] = []
  let i = 0
  const n = lines.length

  if (lines[0]?.trim() === '---') {
    let j = 1
    while (j < n && lines[j]?.trim() !== '---') {
      j++
    }
    if (j < n) {
      // Found a closing fence -- skip the front-matter block.
      i = j + 1
    }
    // else: no closing fence anywhere in the document (malformed/truncated front matter,
    // or a bare '---' divider with no match). Leave i at 0 so the whole document is still
    // processed as content instead of being silently discarded.
  }

  let inCodeBlock = false
  let codeBlockLines = 0
  let currentHeading: string | null = null
  let sentencesEmitted = 0

  while (i < n) {
    const line = lines[i]!
    const stripped = line.trim()

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBlockLines = 0
        if (currentHeading && sentencesEmitted < max) {
          out.push(line)
          codeBlockLines++
        }
      } else {
        inCodeBlock = false
        if (currentHeading && sentencesEmitted < max) {
          out.push(line)
          sentencesEmitted++
        }
      }
      i++
      continue
    }

    if (inCodeBlock) {
      if (codeBlockLines < 10 && currentHeading && sentencesEmitted < max) {
        out.push(line)
        codeBlockLines++
      }
      i++
      continue
    }

    const headingMatch = stripped.match(/^(#{1,6})\s+(.*)/)
    if (headingMatch) {
      currentHeading = stripped
      sentencesEmitted = 0
      out.push('')
      out.push(line)
      i++
      continue
    }

    if (currentHeading && sentencesEmitted < max && stripped) {
      out.push(line)
      sentencesEmitted++
    }
    i++
  }

  const resultLines: string[] = []
  let prevBlank = false
  for (const ln of out) {
    const isBlank = !ln.trim()
    if (isBlank && prevBlank) {
      continue
    }
    resultLines.push(ln)
    prevBlank = isBlank
  }

  return resultLines.join('\n').trim() + '\n'
}

/**
 * Extract the compact text from a markdown document.
 * Looks for content after a `<!-- COMPACT_END -->` marker or under a specified heading.
 */
export function extractDocCompact(body: string, heading?: string): string {
  if (heading) {
    const lines = body.split('\n')
    // A plain `line.includes(heading)` matches ANY line containing the heading text as a substring, including ordinary prose that merely mentions it before the real heading appears, and also longer headings that contain the query as a substring (e.g., "Setup Guide" when searching for "Setup"). Require an exact match of the heading text portion instead, so both prose references and similar-but-not-identical headings can't be mistaken for the section boundary.
    const compactIdx = lines.findIndex((line) => {
      const m = /^#{1,6}\s+(.*)$/.exec(line.trim())
      return m !== null && (m[1] ?? '') === heading
    })
    if (compactIdx === -1) return ''

    // Find the level (number of #'s) of the matched heading
    const matchedHeadingLine = lines[compactIdx]!.trim()
    const levelMatch = /^(#+)/.exec(matchedHeadingLine)
    const matchedLevel = levelMatch ? levelMatch[1]!.length : 0

    // Find the end: walk forward until we hit a heading at the same level or higher (fewer #'s)
    let endIdx = lines.length
    for (let i = compactIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i]!.trim()
      const nextLevelMatch = /^(#+)\s/.exec(trimmed)
      if (nextLevelMatch) {
        const nextLevel = nextLevelMatch[1]!.length
        if (nextLevel <= matchedLevel) {
          endIdx = i
          break
        }
      }
    }

    return lines.slice(compactIdx, endIdx).join('\n')
  }

  const compactMarker = '<!-- COMPACT_END -->'
  const idx = body.indexOf(compactMarker)
  if (idx === -1) return ''

  return body.slice(0, idx).trim()
}

/**
 * Read a markdown file and extract its compact slice.
 */
export function compactDoc(filePath: string, heading?: string): string | null {
  try {
    const body = fs.readFileSync(filePath, 'utf-8')
    const compact = extractDocCompact(body, heading)
    return compact || null
  } catch {
    return null
  }
}
