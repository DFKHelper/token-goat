/**
 * Google Docs section extraction via public export API.
 *
 * Fetches plain-text exports of Google Docs (no auth required for public docs),
 * parses heading structure, and extracts individual sections by heading name.
 */

import { storeWebOutput, getWebOutputByUrl } from './web_cache.js'
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
  return `${GDRIVE_EXPORT_BASE}/${fileId}/export?format=txt`
}

async function fetchDocFromApi(url: string): Promise<string> {
  const response = await globalThis.fetch(url, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Doc: HTTP ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  return text
}

export async function fetchDoc(fileId: string): Promise<string> {
  const url = buildExportUrl(fileId)

  const cached = getWebOutputByUrl(url)
  if (cached !== null) {
    return cached.content
  }

  const text = await fetchDocFromApi(url)

  storeWebOutput(url, text)
  return text
}

function parseDocSections(text: string): GdriveSection[] {
  const lines = text.split(/\r?\n/)
  const sections: GdriveSection[] = []
  let currentSection: GdriveSection | null = null
  let byteOffset = 0

  for (const line of lines) {
    const lineBytes = line.length + 1

    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      if (currentSection !== null) {
        currentSection.content = currentSection.content.trim()
        sections.push(currentSection)
      }
      const level = match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      const heading = match[2]!.trim()
      currentSection = {
        heading,
        level,
        content: '',
        byteStart: byteOffset,
      }
    } else if (currentSection !== null) {
      currentSection.content += (currentSection.content ? '\n' : '') + line
    }

    byteOffset += lineBytes
  }

  if (currentSection !== null) {
    currentSection.content = currentSection.content.trim()
    sections.push(currentSection)
  }

  return sections
}

export async function getDocSections(fileId: string): Promise<GdriveSection[]> {
  const text = await fetchDoc(fileId)
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

export async function getSectionContent(fileId: string, heading: string): Promise<string | null> {
  const sections = await getDocSections(fileId)
  const target = sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())
  return target ? target.content : null
}
