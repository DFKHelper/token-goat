/**
 * Stable-doc compact serving for large reference docs.
 *
 * A compact is a user-created or auto-extractive summary of a large reference doc,
 * stored as a sidecar file. Compacts are served instead of full files to save
 * 80-95% of context tokens on first reads.
 */

import * as fs from 'fs'
import * as path from 'path'

import { dataDir } from './constants.js'
import { fingerprintContent } from './fingerprint.js'
import { atomicWriteText, foldPath } from './util.js'
import { resolveIndexPath } from './paths.js'
import { eachUnfencedLine } from './markdown_lines.js'

const defaultSentencesPerSection = 2
const headerPrefix = '<!-- token-goat doc-compact source-hash:'
// \r? tolerates a CRLF-terminated sidecar (external editors, git core.autocrlf, diff
// tools) even though writeCompact always writes LF -- without it, readCompactHeader and
// markCompactStale's own header re-match both silently stop recognizing an otherwise
// valid, current header once the line ending is CRLF instead of LF.
const headerRegex = /^<!-- token-goat doc-compact source-hash:(\S+) source:(.+?) -->\r?$/
const compactSubdir = 'doc_compacts'

/**
 * Get the SHA-256 hash of a file's content.
 */
function sourceHash(filePath: string): string {
  try {
    return fingerprintContent(fs.readFileSync(filePath))
  } catch {
    return ''
  }
}

/**
 * Deterministic filename component: hash prefix + stem slug.
 */
function _compactSlug(absPathStr: string): string {
  const h = fingerprintContent(foldPath(absPathStr)).slice(0, 12)

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
  // Fence state tracked the same way as markdown_lines.ts's eachUnfencedLine (the codebase's
  // canonical CommonMark-correct fence tracker): a fence only closes on a run of the SAME
  // character with length >= the opening run's length, so a mismatched ~~~ can't close a ```
  // block and a shorter nested ``` inside a ```` fence is literal content, not a closer.
  let fence: { ch: string; len: number } | null = null

  while (i < n) {
    const line = lines[i]!
    const stripped = line.trim()

    const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fm !== null && fm[1] !== undefined) {
      const run = fm[1]
      const ch = run[0] ?? ''
      if (fence === null) {
        fence = { ch, len: run.length }
        inCodeBlock = true
        codeBlockLines = 0
        if (currentHeading && sentencesEmitted < max) {
          out.push(line)
          codeBlockLines++
        }
        i++
        continue
      } else if (ch === fence.ch && run.length >= fence.len && (fm[2] ?? '').trim() === '') {
        fence = null
        inCodeBlock = false
        // The closing fence delimiter is structural code-block syntax, not one of the "first N
        // real sentences" this budget tracks -- counting it against sentencesEmitted silently
        // ate one legitimate trailing prose sentence per code block. Gate on codeBlockLines
        // (mirroring the opening-fence branch) so it doesn't touch the sentence budget at all.
        // codeBlockLines > 0 also requires the opener to have actually been emitted -- when the
        // sentence budget was already exhausted before this fence opened, codeBlockLines stayed
        // 0 and the opener/content were suppressed, so the closer must stay suppressed too or it
        // becomes an orphaned, unpaired ``` with no matching opener in the compact output. Unlike
        // the opener/content branches, there is no `< 10` cap here: once the opener was emitted
        // the closer must always be emitted too, even when the 10-line content cap was hit,
        // otherwise a long code block leaves an unterminated fence in the compact output.
        if (currentHeading && codeBlockLines > 0) {
          out.push(line)
          codeBlockLines++
        }
        i++
        continue
      }
      // else: fence-looking line that doesn't close the currently open fence (mismatched
      // character, or a same-char run shorter than the opener) -- falls through to be
      // treated as ordinary code-block content below.
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
    // A `#`-looking line inside a fenced code block (e.g. a doc showing an example `## usage`
    // heading as sample markdown) must never be mistaken for a real heading or a section
    // boundary. Track fence state with the same CommonMark-correct logic as
    // markdown_lines.ts's eachUnfencedLine and only consider lines it yields as candidates.
    const unfencedIdx = new Set<number>()
    for (const [idx] of eachUnfencedLine(lines)) unfencedIdx.add(idx)

    // A plain `line.includes(heading)` matches ANY line containing the heading text as a substring, including ordinary prose that merely mentions it before the real heading appears, and also longer headings that contain the query as a substring (e.g., "Setup Guide" when searching for "Setup"). Require an exact match of the heading text portion instead, so both prose references and similar-but-not-identical headings can't be mistaken for the section boundary.
    const compactIdx = lines.findIndex((line, idx) => {
      if (!unfencedIdx.has(idx)) return false
      // Lazy capture with an optional SPACE-preceded trailing hash run stripped, matching
      // section_reader.ts's heading-match form -- a greedy `(.*)` would swallow a closed-ATX
      // heading's trailing `##` (e.g. `## Setup ##` capturing "Setup ##" instead of "Setup"),
      // failing exact-equality against the target heading text.
      const m = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line.trim())
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
      if (!unfencedIdx.has(i)) continue
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
