/**
 * Google Docs section extraction via public export API.
 *
 * Fetches plain-text exports of Google Docs (no auth required for public docs),
 * parses heading structure, and extracts individual sections by heading name.
 */

import { storeWebOutput, getWebOutputByUrlFromDisk } from './web_cache.js'
import { estimateTokens } from './compact.js'

export interface GdriveSection {
  heading: string
  level: 1 | 2 | 3 | 4 | 5 | 6
  content: string
  byteStart: number
}

const GDRIVE_EXPORT_BASE = 'https://docs.google.com/document/d'

function validateFileId(fileId: string): void {
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new Error('file_id cannot be empty or whitespace-only')
  }
  const stripped = fileId.trim()
  if (stripped.length > 128) {
    throw new Error(`file_id too long (max 128 chars): ${stripped.length}`)
  }
  if (stripped.includes('/') || stripped.includes('\\') || stripped.includes('..')) {
    throw new Error(`file_id contains invalid characters: ${stripped}`)
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(stripped)) {
    throw new Error(`file_id contains invalid characters: ${stripped}`)
  }
}

function buildExportUrl(fileId: string): string {
  validateFileId(fileId)
  return `${GDRIVE_EXPORT_BASE}/${fileId}/export?format=markdown`
}

async function fetchDocFromApi(url: string): Promise<string> {
  const response = await globalThis.fetch(url, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Doc: HTTP ${response.status} ${response.statusText}`)
  }
  // A private/unshared doc's export URL 302-redirects to Google's sign-in page, which
  // resolves as a 200 with content-type text/html. fetch() follows that redirect
  // transparently, so without this check the sign-in page HTML would be treated as real
  // doc content and cached, leaving a misleading "No sections found." result pinned for
  // DEFAULT_MAX_AGE_MS even after the doc is later shared.
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType.includes('text/html')) {
    throw new Error(
      'Failed to fetch Google Doc: doc is private or not shared (got a sign-in page instead of doc content)'
    )
  }
  const text = await response.text()
  return text
}

export interface FetchDocOptions {
  /** Skip the on-disk cache read and force a live fetch. The fresh result is still written
   *  back to cache afterward, same as a normal cache-miss path. */
  fresh?: boolean
}

export async function fetchDoc(fileId: string, opts: FetchDocOptions = {}): Promise<string> {
  const url = buildExportUrl(fileId)

  if (opts.fresh !== true) {
    const cached = getWebOutputByUrlFromDisk(url)
    if (cached !== null) {
      return cached.content
    }
  }

  const text = await fetchDocFromApi(url)

  storeWebOutput(url, text)
  return text
}

function parseDocSections(text: string): GdriveSection[] {
  const sections: GdriveSection[] = []
  let currentSection: GdriveSection | null = null
  let byteOffset = 0
  let i = 0

  while (i < text.length) {
    const newlineMatch = text.slice(i).match(/\r?\n/)
    const lineEndPos = newlineMatch ? i + newlineMatch.index! : text.length
    const line = text.slice(i, lineEndPos)
    const newlineLen = newlineMatch ? newlineMatch[0].length : 0

    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      if (currentSection !== null) {
        currentSection.content = currentSection.content.trim()
        sections.push(currentSection)
      }
      const level = match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      // Google Docs' markdown export renders a heading like "# **Introduction** {#introduction}":
      // the text wrapped in bold markers, followed by a trailing anchor-slug suffix. Strip both
      // so the extracted heading matches the doc's actual visible heading text.
      const heading = match[2]!
        .trim()
        .replace(/\s*\{#[^}]*\}\s*$/, '')
        .replace(/^\*\*(.*)\*\*$/, '$1')
        .trim()
      currentSection = {
        heading,
        level,
        content: '',
        byteStart: byteOffset,
      }
    } else if (currentSection !== null) {
      currentSection.content += (currentSection.content ? '\n' : '') + line
    }

    byteOffset += Buffer.byteLength(line, 'utf8') + newlineLen
    i = lineEndPos + newlineLen
  }

  if (currentSection !== null) {
    currentSection.content = currentSection.content.trim()
    sections.push(currentSection)
  }

  return sections
}

export async function getDocSections(fileId: string, opts: FetchDocOptions = {}): Promise<GdriveSection[]> {
  const text = await fetchDoc(fileId, opts)
  return parseDocSections(text)
}

export function formatSections(sections: GdriveSection[]): string {
  if (sections.length === 0) {
    return 'No sections found.'
  }

  const lines = sections.map((s) => {
    const indent = '  '.repeat(s.level - 1)
    const tokens = estimateTokens(s.content)
    return `${indent}${s.heading} (level ${s.level}, ~${tokens} tokens)`
  })
  return lines.join('\n')
}

export async function getSectionContent(
  fileId: string,
  heading: string,
  opts: FetchDocOptions = {}
): Promise<string | null> {
  const sections = await getDocSections(fileId, opts)
  const target = sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())
  return target ? target.content : null
}
