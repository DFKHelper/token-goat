/** Remembers a download that could not reach its host, so the next caller waits it out instead of repeating it. Without it nothing was remembered: with the network blocked, a worker draining 30 files asked huggingface.co for the tokenizer 30 times in 25 s and logged 60 lines, each saying only "fetch failed", because Node keeps the reason (ECONNREFUSED, the proxy's address) on the error's `cause` and nothing read it. The record is one JSON file under the data dir, keyed by host, so it holds across the worker, the CLI and the MCP server, which are separate processes. `downloadPinned` in pinned_fetch.ts is the one place that reads and writes it for a download; the worker and the semantic preflight read it to decide whether to try at all. A download the user asked for by name (`semantic --warm`, `doctor --repair`) runs inside `withExplicitDownload` and goes through a held failure, since that is the user saying "try now". Outside EMBED_FINGERPRINT: nothing here changes a vector. */

import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir } from './constants.js'
import { atomicWriteText, ensureDirSync, withFileLock } from './util.js'

/** The host embed_model.ts downloads the model from. tests/model_download_gate.test.ts checks it against the URL a real download requests, so the two cannot drift apart without a failure. */
export const MODEL_DOWNLOAD_HOST = 'huggingface.co'

/** The host embed_runtime_web.ts downloads the onnxruntime-web tarball from, which the WebAssembly runtime needs before the first vector on a machine without the native runtime. tests/embed_runtime_pins.test.ts checks it against the URL that download requests. */
export const RUNTIME_DOWNLOAD_HOST = 'registry.npmjs.org'

const FIRST_HOLD_MS = 10 * 60 * 1000
const MAX_HOLD_MS = 60 * 60 * 1000
/** A failure older than this starts the doubling over: yesterday's outage says nothing about how long today's will last. */
const CONSECUTIVE_WINDOW_MS = 24 * 60 * 60 * 1000
/** A record stamped further in the future than this was written under a different clock. Honouring it could hold downloads for days, so it counts as no record. */
const CLOCK_SKEW_MS = 60 * 1000

export interface DownloadFailure {
  url: string
  message: string
  /** Epoch ms of the most recent failure. */
  at: number
  /** Consecutive failures, which set how long the hold lasts. */
  failures: number
}

export interface DownloadCooldown extends DownloadFailure {
  host: string
  /** Epoch ms at which an automatic download may try again. */
  retryAt: number
}

/** A download that reached no usable answer from its host, now recorded. `failedAt` is the record's timestamp, which lets a caller logging many of these tell a new failure from one it already reported. */
export class DownloadFailedError extends Error {
  readonly failedAt: number
  readonly url: string
  constructor(message: string, url: string, failedAt: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DownloadFailedError'
    this.url = url
    this.failedAt = failedAt
  }
}

/** A download refused without a request because its host failed recently. Carries the failure it is waiting out. */
export class DownloadCooldownError extends Error {
  readonly failedAt: number
  readonly retryAt: number
  readonly lastMessage: string
  readonly url: string
  constructor(url: string, cooldown: DownloadCooldown, now: number = Date.now()) {
    super(`Not downloading ${url} yet: the last try, ${formatAgo(now - cooldown.at)} ago, failed with ${cooldown.message}. It is tried again automatically after ${new Date(cooldown.retryAt).toLocaleTimeString()}.`)
    this.name = 'DownloadCooldownError'
    this.url = url
    this.failedAt = cooldown.at
    this.retryAt = cooldown.retryAt
    this.lastMessage = cooldown.message
  }
}

export function downloadFailureRecordPath(): string {
  return path.join(dataDir(), 'models', 'download-failures.json')
}

/** How long an automatic download waits after `failures` consecutive failures: 10 minutes, doubling, at most an hour. */
export function downloadHoldMs(failures: number): number {
  return Math.min(FIRST_HOLD_MS * 2 ** Math.max(0, failures - 1), MAX_HOLD_MS)
}

function hostOf(hostOrUrl: string): string {
  if (!hostOrUrl.includes('://')) return hostOrUrl.toLowerCase()
  try {
    return new URL(hostOrUrl).host.toLowerCase()
  } catch {
    return hostOrUrl.toLowerCase()
  }
}

function isFailure(value: unknown): value is DownloadFailure {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['url'] === 'string' && typeof v['message'] === 'string' && Number.isFinite(v['at']) && Number.isInteger(v['failures']) && (v['failures'] as number) >= 1
}

/** Every well-formed entry in the record. An unreadable or malformed file is no record: a hold is an optimization, and a corrupt one must never stop a download. */
function readRecord(): Record<string, DownloadFailure> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(downloadFailureRecordPath(), 'utf-8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, DownloadFailure> = {}
  for (const [host, entry] of Object.entries(parsed)) if (isFailure(entry)) out[host] = entry
  return out
}

function writeRecord(record: Record<string, DownloadFailure>): void {
  const file = downloadFailureRecordPath()
  if (Object.keys(record).length === 0) fs.rmSync(file, { force: true })
  else atomicWriteText(file, `${JSON.stringify(record, null, 2)}\n`)
}

export function lastDownloadFailure(hostOrUrl: string = MODEL_DOWNLOAD_HOST): DownloadFailure | null {
  return readRecord()[hostOf(hostOrUrl)] ?? null
}

/** The hold on `hostOrUrl`'s host, or null when an automatic download may go ahead. */
export function activeDownloadCooldown(hostOrUrl: string = MODEL_DOWNLOAD_HOST, now: number = Date.now()): DownloadCooldown | null {
  const host = hostOf(hostOrUrl)
  const last = lastDownloadFailure(host)
  if (!last || last.at > now + CLOCK_SKEW_MS) return null
  const retryAt = last.at + downloadHoldMs(last.failures)
  return now < retryAt ? { ...last, host, retryAt } : null
}

/** Read, change and write the record holding its lock, returning what `mutate` returns. The worker, the CLI and the MCP server are separate processes that can fail against the same host in the same second, and unlocked, the second write replaced the first: the tokenizer's failure could erase the WebAssembly runtime's. Entries past the consecutive window are dropped on the way through, since nothing reads them any more. A lock that cannot be had still runs the update, because a lost entry costs one early retry and a download that could not record its failure must not fail for that. */
function updateRecord<T>(mutate: (record: Record<string, DownloadFailure>, now: number) => T, now: number): T {
  const file = downloadFailureRecordPath()
  const run = (): { value: T } => {
    const record = readRecord()
    for (const [host, entry] of Object.entries(record)) if (now - entry.at >= CONSECUTIVE_WINDOW_MS) delete record[host]
    const value = mutate(record, now)
    writeRecord(record)
    return { value }
  }
  try {
    ensureDirSync(path.dirname(file))
  } catch {
    // withFileLock reports a lock it cannot create as undefined, which falls through to the unlocked run below.
  }
  // Wrapped in an object because withFileLock answers undefined for a lock it never got, which a mutate returning undefined would be mistaken for.
  return (withFileLock(`${file}.lock`, run) ?? run()).value
}

/** Record a failure against `url`'s host and return the entry written. `err` is the error or an already-described message. `startedAt`, when the attempt began, keeps concurrent attempts from counting one outage several times: a failure another process recorded after this attempt started is the same outage, not an earlier one, so the count stays where that process left it and the hold does not jump to its ceiling because three processes gave up in the same second. */
export function recordDownloadFailure(url: string, err: unknown, now: number = Date.now(), startedAt?: number): DownloadFailure {
  const host = hostOf(url)
  const message = typeof err === 'string' ? err : describeCause(err)
  return updateRecord((record) => {
    const prev = record[host]
    const known = prev !== undefined && prev.at <= now + CLOCK_SKEW_MS && now - prev.at < CONSECUTIVE_WINDOW_MS
    const sameOutage = known && startedAt !== undefined && prev.at >= startedAt
    const entry: DownloadFailure = { url, message, at: now, failures: !known ? 1 : sameOutage ? prev.failures : prev.failures + 1 }
    record[host] = entry
    return entry
  }, now)
}

export function clearDownloadFailure(url: string): void {
  const host = hostOf(url)
  if (!(host in readRecord())) return
  updateRecord((record) => delete record[host], Date.now())
}

function detailOf(value: unknown): string {
  if (value instanceof AggregateError && value.errors.length > 0 && value.message === '') return detailOf(value.errors[0])
  if (value instanceof Error) return value.message !== '' ? value.message : String((value as NodeJS.ErrnoException).code ?? value.name)
  if (value !== null && typeof value === 'object') return String((value as { code?: unknown }).code ?? '')
  return value === undefined ? '' : String(value)
}

/** An error's message with the reasons its `cause` chain adds, e.g. "fetch failed (connect ECONNREFUSED 127.0.0.1:9)". Node's fetch rejects with the bare "fetch failed" and keeps everything a user could act on one level down. */
export function describeCause(err: unknown): string {
  const head = detailOf(err)
  const extra: string[] = []
  let seen = head
  let cursor: unknown = err instanceof Error ? err.cause : undefined
  for (let depth = 0; cursor !== undefined && cursor !== null && depth < 5; depth++) {
    const detail = detailOf(cursor)
    if (detail !== '' && !seen.includes(detail)) {
      extra.push(detail)
      seen += ` ${detail}`
    }
    cursor = cursor instanceof Error ? cursor.cause : undefined
  }
  return extra.length > 0 ? `${head} (${extra.join('; ')})` : head
}

/** The `failedAt` of the recorded failure behind `err`, looking through its cause chain, or null when it carries none. */
export function failedAtOf(err: unknown): number | null {
  let cursor: unknown = err
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const at = (cursor as { failedAt?: unknown }).failedAt
    if (typeof at === 'number') return at
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

function formatAgo(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'moments'
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

const explicit = new AsyncLocalStorage<boolean>()

/** Run `fn` as a download the user asked for, which goes through a held failure. */
export function withExplicitDownload<T>(fn: () => T): T {
  return explicit.run(true, fn)
}

export function isExplicitDownload(): boolean {
  return explicit.getStore() === true
}
