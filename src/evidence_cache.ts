import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dataDir } from './constants.js'
import { normalizePath } from './paths.js'
import { redactSecrets } from './secret_redact.js'

const MAX_ENTRIES = 500
const MAX_TEXT_BYTES = 128 * 1024
const CACHE_FILE = 'workspace-evidence.json'

export type EvidenceRepresentation = 'file' | 'tool-output'

export interface EvidenceEntry {
  id: string
  projectRoot: string
  source: string
  representation: EvidenceRepresentation
  contentHash: string
  text: string
  createdAt: number
}

function cachePath(): string {
  return path.join(dataDir(), CACHE_FILE)
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function load(): EvidenceEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is EvidenceEntry =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as EvidenceEntry).id === 'string' &&
      typeof (entry as EvidenceEntry).projectRoot === 'string' &&
      typeof (entry as EvidenceEntry).source === 'string' &&
      ((entry as EvidenceEntry).representation === 'file' || (entry as EvidenceEntry).representation === 'tool-output') &&
      typeof (entry as EvidenceEntry).contentHash === 'string' &&
      typeof (entry as EvidenceEntry).text === 'string' &&
      typeof (entry as EvidenceEntry).createdAt === 'number',
    )
  } catch {
    return []
  }
}

function save(entries: readonly EvidenceEntry[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify(entries.slice(0, MAX_ENTRIES)), 'utf8')
  } catch {
    // Evidence caching is an optimization and must never block the caller.
  }
}

export function recordEvidence(input: {
  projectRoot: string
  source: string
  representation: EvidenceRepresentation
  text: string
}): EvidenceEntry | null {
  if (Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) return null
  const contentHash = hash(input.text)
  const text = redactSecrets(input.text).text
  const projectRoot = normalizePath(input.projectRoot)
  const source = input.representation === 'file' ? normalizePath(input.source) : input.source
  const id = hash(`${projectRoot}\0${source}\0${input.representation}\0${contentHash}`).slice(0, 24)
  const entry: EvidenceEntry = {
    id,
    projectRoot,
    source,
    representation: input.representation,
    contentHash,
    text,
    createdAt: Date.now(),
  }
  const entries = load().filter((candidate) =>
    candidate.projectRoot !== projectRoot ||
    candidate.source !== source ||
    candidate.representation !== input.representation,
  )
  entries.unshift(entry)
  save(entries)
  return entry
}

export function findVerifiedFileEvidence(projectRoot: string, source: string, currentText: string): EvidenceEntry | null {
  const normalizedRoot = normalizePath(projectRoot)
  const normalizedSource = normalizePath(source)
  const currentHash = hash(currentText)
  return load().find((entry) =>
    entry.projectRoot === normalizedRoot &&
    entry.source === normalizedSource &&
    entry.representation === 'file' &&
    entry.contentHash === currentHash,
  ) ?? null
}

export function searchEvidence(projectRoot: string, query: string, limit = 10): EvidenceEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const root = normalizePath(projectRoot)
  return load()
    .filter((entry) => entry.projectRoot === root)
    .map((entry) => ({ entry, score: tokens.reduce((score, token) => score + Number(entry.text.toLowerCase().includes(token)), 0) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function buildDeltaCapsule(projectRoot: string, limit = 8): string | null {
  const root = normalizePath(projectRoot)
  const changed = load()
    .filter((entry) => entry.projectRoot === root && entry.representation === 'file')
    .filter((entry) => {
      try {
        return hash(fs.readFileSync(entry.source, 'utf8')) !== entry.contentHash
      } catch {
        return true
      }
    })
    .slice(0, limit)
  if (changed.length === 0) return null
  return `Cross-session evidence changed since it was cached:\n${changed.map((entry) => `- ${entry.source} (use a fresh surgical read)`).join('\n')}`
}
