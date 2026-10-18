/** Local, bounded storage for generic compressed text and named handoffs. Content is redacted before compression and persistence, then stored through the shared blob funnel so the existing cache bounds and secret protection remain in force. */
import * as fs from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import * as path from 'node:path'

import { isBlobStale, listBlobIdsWithPrefix, loadBlob, storeBlob } from './disk_cache.js'
import { shortFingerprint } from './fingerprint.js'
import { quotedArg } from './hint_suggestion_guard.js'
import { canonicalize, foldPath } from './path_containment.js'
import { findProject } from './project.js'
import { redactSecrets } from './secret_redact.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { BYTES_PER_TOKEN } from './token_estimate.js'

export const CONTENT_MAX_INPUT_CHARS = 512 * 1024
export const CONTENT_MAX_ITEMS = 256
export const CONTENT_MAX_BYTES = 32 * 1024 * 1024
// JSON escaping can expand a 512 KiB string to nearly 3 MiB (for example, every character being a control character). Keep the advertised input limit valid for all legal text while the directory-wide cache limit still bounds use.
export const CONTENT_MAX_ITEM_BYTES = CONTENT_MAX_INPUT_CHARS * 7
export const CONTENT_SUBDIR = 'content'
// A stored contentId is printed in a shell suggestion and handed to `retrieve`, so only the shape the store itself mints is accepted.
const CONTENT_ID_PATTERN = /^tg_[0-9a-f]{16}$/

interface StoredContent {
  kind: 'content'
  id: string
  text: string
  createdAt: number
}

interface StoredHandoff {
  kind: 'handoff'
  id: string
  name: string
  projectRoot: string
  contentId: string
  text: string
  createdAt: number
}

// The measurement behind these two numbers, and why they must stay apart, is in token_estimate.ts. Re-exported rather than restated: this module measured them, and a second copy of a ratio is how the two drift into disagreeing about the same bytes. Deflate roughly halves the bytes but nearly triples tokens-per-byte, so it usually loses in the unit the product actually bills in -- which is only visible if both sides of that subtraction are priced on their own class.
export const TEXT_BYTES_PER_TOKEN = BYTES_PER_TOKEN.text
export const BASE64URL_BYTES_PER_TOKEN = BYTES_PER_TOKEN.dense

function estimateTextTokens(bytes: number): number {
  return savedTokensFromBytes(bytes, 'text')
}

function estimateBase64urlTokens(bytes: number): number {
  return savedTokensFromBytes(bytes, 'dense')
}

export interface CompressionResult {
  id: string
  compact: string
  encoding: 'deflate-raw-base64url'
  originalBytes: number
  compactBytes: number
  bytesSaved: number
  /** Token delta from inlining `compact` instead of the original text; negative means inlining costs more than it saves. */
  tokensSaved: number
  /** True when inlining `compact` is genuinely cheaper in tokens than the original text. */
  inlineWins: boolean
  recovery: string
}

export interface HandoffResult {
  id: string
  name: string
  contentId: string
  projectRoot: string
  recovery: string
}

function assertInput(text: string): void {
  if (text.length > CONTENT_MAX_INPUT_CHARS) {
    throw new Error(`text exceeds the ${CONTENT_MAX_INPUT_CHARS}-character safety limit`)
  }
}

function contentId(text: string): string {
  return `tg_${shortFingerprint(text)}`
}

// The root's identity is the canonical form the rest of token-goat keys a project by (canonicalize: forward slashes, lower-case drive), not the spelling the caller's cwd happened to arrive in. findProject returns null for a directory it takes for a container of other repos, and the fallback then used path.resolve, whose backslash and upper-case-drive spelling hashed to a different id than the marker-derived root of the same directory.
function normalizeProjectRoot(projectRoot?: string): string {
  const candidate = canonicalize(withoutLongPathPrefix(projectRoot ?? process.cwd()))
  return findProject(candidate)?.root ?? candidate
}

// What identifies a root across spellings: the canonical form, case-folded where the filesystem folds (the same rule projectHash applies).
function handoffRootKey(projectRoot: string): string {
  return foldPath(canonicalize(withoutLongPathPrefix(projectRoot)))
}

// canonicalize leaves a Windows extended-length prefix in place (it becomes //?/C:/x), so one directory would key two ways; the UNC form of the prefix is the extended spelling of a plain //server/share path. Off Windows a backslash is an ordinary file-name character and the string is left alone.
function withoutLongPathPrefix(p: string): string {
  if (process.platform !== 'win32') return p
  return p.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '//').replace(/^[\\/]{2}\?[\\/](?=[a-z]:)/i, '')
}

// What a stored record's projectRoot must equal for the record to belong to this project: the lexical key with every link in the path resolved (a symlink or junction, an 8.3 short name, the on-disk casing), because an id built from the resolved spelling carries a projectRoot whose lexical key is not the as-given one. Whole-path equality, never a prefix test, so a sibling that shares a name prefix is another project. A root that does not exist keeps its lexical key.
function handoffRootIdentity(projectRoot: string): string {
  const plain = withoutLongPathPrefix(projectRoot)
  try {
    return foldPath(canonicalize(fs.realpathSync.native(plain)))
  } catch {
    return handoffRootKey(plain)
  }
}

function handoffIdFromKey(name: string, key: string): string {
  return `tg_handoff_${shortFingerprint(`${key}\x00${name}`)}`
}

function handoffId(name: string, projectRoot: string): string {
  return handoffIdFromKey(name, handoffRootKey(projectRoot))
}

// Every id an earlier release could have stored this handoff under: it hashed the root exactly as spelled, which was the canonical form when a marker was found (c:/x) and path.resolve's form when none was (C:\x, or c:\x). Only the spellings that differ from the current id are returned.
function legacyHandoffIds(name: string, projectRoot: string): string[] {
  const bases = new Set<string>([projectRoot])
  try {
    bases.add(canonicalize(fs.realpathSync.native(projectRoot)))
  } catch {
    // A root that does not exist has no on-disk spelling to add.
  }
  const spellings = new Set<string>()
  for (const base of bases) {
    spellings.add(base)
    if (process.platform !== 'win32') continue
    const upper = base.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    for (const form of [base, upper]) {
      spellings.add(form)
      spellings.add(form.replace(/\//g, path.win32.sep))
    }
  }
  const current = handoffId(name, projectRoot)
  const ids = new Set<string>()
  for (const spelling of spellings) ids.add(handoffIdFromKey(name, spelling))
  ids.delete(current)
  return [...ids]
}

// A handoff already stores the full text it points at, so an id equal to a live handoff's contentId is answered from that record when the blob itself has been evicted or has aged out. Nothing here exempts a blob from the shared cache's age, count or byte rules.
function readLiveHandoffText(id: string): string | null {
  for (const handoff of listBlobIdsWithPrefix(CONTENT_SUBDIR, 'tg_handoff_')) {
    if (isBlobStale(CONTENT_SUBDIR, handoff)) continue
    const entry = loadBlob(CONTENT_SUBDIR, handoff) as Partial<StoredHandoff> | null
    if (entry === null || typeof entry !== 'object' || entry.kind !== 'handoff' || entry.contentId !== id) continue
    if (typeof entry.text === 'string' && contentId(entry.text) === id) return entry.text
  }
  return null
}

function storeContent(text: string): string {
  const id = contentId(text)
  const value: StoredContent = { kind: 'content', id, text, createdAt: Date.now() }
  const ok = storeBlob(CONTENT_SUBDIR, id, value, {
    maxCount: CONTENT_MAX_ITEMS,
    maxBytes: CONTENT_MAX_BYTES,
    maxBytesPerItem: CONTENT_MAX_ITEM_BYTES,
  })
  if (!ok) throw new Error('unable to persist compressed content within the local cache bounds')
  return id
}

function readContent(id: string): string | null {
  if (!CONTENT_ID_PATTERN.test(id)) return null
  const stored = isBlobStale(CONTENT_SUBDIR, id) ? null : loadBlob(CONTENT_SUBDIR, id)
  if (stored !== null && typeof stored === 'object') {
    const entry = stored as Partial<StoredContent>
    if (entry.kind === 'content' && entry.id === id && typeof entry.text === 'string') return entry.text
  }
  return readLiveHandoffText(id)
}

export function compressText(text: string): CompressionResult {
  assertInput(text)
  const safeText = redactSecrets(text).text
  const id = storeContent(safeText)
  const compact = deflateRawSync(Buffer.from(safeText, 'utf8'), { level: 9 }).toString('base64url')
  const originalBytes = Buffer.byteLength(safeText, 'utf8')
  const compactBytes = Buffer.byteLength(compact, 'utf8')
  const bytesSaved = Math.max(0, originalBytes - compactBytes)
  const tokensSaved = estimateTextTokens(originalBytes) - estimateBase64urlTokens(compactBytes)
  const inlineWins = tokensSaved > 0
  // Never book a saving for an operation that costs tokens: a byte delta divided by the ratio of plain text credited a win on nearly every input while the high-entropy payload actually inflated the context.
  recordStat('content_compress', inlineWins ? bytesSaved : 0, inlineWins ? tokensSaved : 0)
  return {
    id,
    compact,
    encoding: 'deflate-raw-base64url',
    originalBytes,
    compactBytes,
    bytesSaved,
    tokensSaved,
    inlineWins,
    recovery: `token-goat retrieve ${id}`,
  }
}

/** True when a blob for `id` is still on disk but older than the cache's age limit, which is the one case where "expired" can be told apart from "never stored" (an evicted blob leaves nothing behind). A handoff that still names `id` serves it, so that is not expired. */
export function isContentExpired(id: string): boolean {
  return CONTENT_ID_PATTERN.test(id) && isBlobStale(CONTENT_SUBDIR, id) && readLiveHandoffText(id) === null
}

export function retrieveText(id: string): string | null {
  const text = readContent(id)
  if (text === null) return null
  recordStat('content_retrieve')
  return text
}

export function createHandoff(name: string, text: string, projectRoot?: string): HandoffResult {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new Error('handoff name must be 1-128 characters using letters, numbers, dot, underscore, or hyphen')
  }
  assertInput(text)
  const root = normalizeProjectRoot(projectRoot)
  const safeText = redactSecrets(text).text
  const contentIdValue = storeContent(safeText)
  const id = handoffId(name, root)
  const value: StoredHandoff = {
    kind: 'handoff',
    id,
    name,
    projectRoot: root,
    contentId: contentIdValue,
    // Keep the handoff independently resolvable if the generic content entry is later evicted from the shared bounded cache.
    text: safeText,
    createdAt: Date.now(),
  }
  const ok = storeBlob(CONTENT_SUBDIR, id, value, {
    maxCount: CONTENT_MAX_ITEMS,
    maxBytes: CONTENT_MAX_BYTES,
    maxBytesPerItem: CONTENT_MAX_ITEM_BYTES,
  })
  if (!ok) throw new Error('unable to persist handoff within the local cache bounds')
  recordStat('handoff_create')
  return { id, name, contentId: contentIdValue, projectRoot: root, recovery: `token-goat handoff-resolve -- ${quotedArg(name)}` }
}

// A handoff found under one id, with the stored timestamp that decides which of several copies wins.
interface FoundHandoff {
  entry: StoredHandoff
  createdAt: number
}

function loadHandoffUnder(id: string, name: string, identity: string): FoundHandoff | null {
  if (isBlobStale(CONTENT_SUBDIR, id)) return null
  const value = loadBlob(CONTENT_SUBDIR, id)
  if (value === null || typeof value !== 'object') return null
  const entry = value as Partial<StoredHandoff>
  if (
    entry.kind !== 'handoff' ||
    entry.name !== name ||
    typeof entry.projectRoot !== 'string' ||
    handoffRootIdentity(entry.projectRoot) !== identity ||
    typeof entry.contentId !== 'string' ||
    !CONTENT_ID_PATTERN.test(entry.contentId) ||
    typeof entry.text !== 'string' ||
    typeof entry.createdAt !== 'number' ||
    !Number.isFinite(new Date(entry.createdAt).getTime())
  ) return null
  return { entry: entry as StoredHandoff, createdAt: entry.createdAt }
}

export interface ResolvedHandoff {
  result: CompressionResult | string
  // Copies of the same handoff kept under a previous root spelling whose text differs from the one returned, newest first. Reading never deletes or rewrites them.
  olderCopies: Array<{ createdAt: number; contentId: string }>
}

// Looks the handoff up under the current id and under every legacy id (lookup of both rather than migrate-on-read: a read that wrote would refresh the old record's age and could overwrite a record the user still wants). When several hold the name, the newer stored timestamp wins and the current id wins a tie.
export function resolveHandoffDetailed(name: string, opts: { projectRoot?: string; full?: boolean } = {}): ResolvedHandoff | null {
  const root = normalizeProjectRoot(opts.projectRoot)
  const key = handoffRootKey(root)
  const identity = handoffRootIdentity(root)
  const found: FoundHandoff[] = []
  for (const id of [handoffIdFromKey(name, key), ...legacyHandoffIds(name, root)]) {
    const hit = loadHandoffUnder(id, name, identity)
    if (hit !== null) found.push(hit)
  }
  if (found.length === 0) return null
  let best = found[0]!
  for (const hit of found) if (hit.createdAt > best.createdAt) best = hit
  const text = best.entry.text
  recordStat('handoff_resolve')
  const olderCopies = found
    .filter((hit) => hit !== best && hit.entry.text !== text)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((hit) => ({ createdAt: hit.createdAt, contentId: hit.entry.contentId }))
  return { result: opts.full === true ? text : compressText(text), olderCopies }
}

export function resolveHandoff(name: string, opts: { projectRoot?: string; full?: boolean } = {}): CompressionResult | string | null {
  return resolveHandoffDetailed(name, opts)?.result ?? null
}
