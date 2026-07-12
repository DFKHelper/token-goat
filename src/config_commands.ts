/**
 * D3 commands: config, project, compact-doc, fetch-image, history.
 *
 * config  <list|get|set|validate> [key] [value] [--json]
 * project <list|exclude|prune>   [path]         [--json]
 * compact-doc <path> [--heading H] [--json]
 * fetch-image <url>  [--out path]  [--json]
 * history [--limit N] [--json]
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse } from 'smol-toml'

import { loadConfig, loadPersistedConfig, buildPersistedConfig, saveConfig, invalidateConfigCache, defaultConfig, CONFIG_KEY_ENV_OVERRIDES } from './config.js'
import { compactDoc, compactPathFor, isCompactFresh, readCompactBody, buildExtractiveCompact, writeCompact } from './doc_compact.js'
import { shrinkImage } from './image_shrink.js'
import { findProject } from './project.js'
import { listBlobs } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from './bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from './web_cache.js'
import { ensureNewline, ensureDirSync, LOCK_WAIT_MS_HARDENED, withFileLock, sleepSync } from './util.js'
import { stripAnsi } from './render/ansi.js'
import { configPath } from './constants.js'
import { performHttpFetch } from './webfetch.js'

function emit(text: string): void {
  const payload = process.stdout.isTTY === true ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/** Ensure the config parent directory exists then call saveConfig. */
function saveConfigSafe(cfg: Parameters<typeof saveConfig>[0]): void {
  ensureDirSync(path.dirname(configPath()))
  saveConfig(cfg)
}

// ── Levenshtein distance (capped at threshold to save time) ─────────────────

function levenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr.push(Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost))
    }
    prev.splice(0, prev.length, ...curr)
  }
  return prev[b.length] ?? cap + 1
}

function closestKeys(unknown: string, known: string[]): string[] {
  return known
    .map((k) => ({ k, d: levenshtein(unknown, k) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.k)
}

/** ` (did you mean: a, b?)` suffix for an unrecognized dotted config key, or '' if no near match. */
function didYouMeanKeySuffix(unknownKey: string): string {
  const knownKeys = flattenConfig(defaultConfig() as unknown as Record<string, unknown>).map(([k]) => k)
  const suggestions = closestKeys(unknownKey, knownKeys)
  return suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : ''
}

// ── Nested path walk helpers ─────────────────────────────────────────────────

/** Walk a dotted path over a plain object, returning the value or null on miss. */
function walkGet(obj: Record<string, unknown>, parts: string[]): { found: true; value: unknown } | { found: false } {
  let cur: unknown = obj
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return { found: false }
    cur = (cur as Record<string, unknown>)[part]
    if (cur === undefined) return { found: false }
  }
  return { found: true, value: cur }
}

/** Walk to the parent of the leaf path, returning a ref and the leaf key. */
function walkParent(obj: Record<string, unknown>, parts: string[]): { parent: Record<string, unknown>; leaf: string } | null {
  if (parts.length === 0) return null
  let cur: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== 'object' || cur === null) return null
    cur = (cur as Record<string, unknown>)[parts[i]!]
    if (typeof cur !== 'object' || cur === null) return null
  }
  const leaf = parts[parts.length - 1]!
  return { parent: cur as Record<string, unknown>, leaf }
}

/** Coerce `raw` string to the same JS type as `existing`. */
function coerce(raw: string, existing: unknown, defaultValue?: unknown): unknown {
  if (typeof existing === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new Error(`expected a boolean ('true', 'false', '1', or '0'), got: ${raw}`)
  }
  if (typeof existing === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`expected a number, got: ${raw}`)
    return n
  }
  if (Array.isArray(existing)) {
    if (raw.trimStart().startsWith('[')) {
      return JSON.parse(raw) as unknown[]
    }
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
    // A non-empty existing array of numbers means this field is a number list (e.g.
    // hints.backoff_thresholds) — parse each comma-separated segment as a number instead of
    // leaving it as a string, or a later load-time validator silently filters the whole list
    // down to an empty array. An empty existing array carries no element-type information of
    // its own (e.g. the field was previously cleared to []), so fall back to the default
    // config's array at this key to recover the declared type.
    const typeSample = existing.length > 0 ? existing : (Array.isArray(defaultValue) ? defaultValue : existing)
    if (typeSample.length > 0 && typeSample.every((x) => typeof x === 'number')) {
      return parts.map((p) => {
        const n = Number(p)
        if (!Number.isFinite(n)) throw new Error(`expected a number in list, got: ${p}`)
        return n
      })
    }
    return parts
  }
  return raw
}

// ── config ───────────────────────────────────────────────────────────────────

/** Flatten a Config (plain object) into key=value pairs using dot notation. */
function flattenConfig(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      pairs.push(...flattenConfig(v as Record<string, unknown>, full))
    } else {
      pairs.push([full, v])
    }
  }
  return pairs
}

export function cmdConfig(opts: { action: string; key?: string; value?: string; json?: boolean }): void {
  const { action } = opts

  if (action === 'list') {
    const cfg = loadConfig() as unknown as Record<string, unknown>
    if (opts.json === true) {
      emit(JSON.stringify(cfg, null, 2))
      return
    }
    const pairs = flattenConfig(cfg)
    for (const [k, v] of pairs) {
      emit(`${k} = ${JSON.stringify(v)}`)
    }
    return
  }

  if (action === 'get') {
    if (!opts.key) {
      throw new Error('config get requires a key (e.g. compact_assist.enabled)')
    }
    const parts = opts.key.split('.')
    const cfg = loadConfig() as unknown as Record<string, unknown>
    const result = walkGet(cfg, parts)
    if (!result.found) {
      throw new Error(`key not found: ${opts.key}${didYouMeanKeySuffix(opts.key)}`)
    }
    if (opts.json === true) {
      emit(JSON.stringify({ key: opts.key, value: result.value }, null, 2))
      return
    }
    emit(typeof result.value === 'string' ? result.value : JSON.stringify(result.value))
    return
  }

  if (action === 'set') {
    if (!opts.key) {
      throw new Error('config set requires a key (e.g. compact_assist.enabled)')
    }
    if (opts.value === undefined) {
      throw new Error('config set requires a value')
    }
    const key = opts.key
    const value = opts.value
    const parts = key.split('.')
    // The load->mutate->save below is a genuine read-modify-write: two concurrent `config
    // set` calls (even on different keys) can each load the pre-update file, mutate their
    // own in-memory copy, and save -- whichever save lands last silently clobbers the
    // other's change, with no error. A short-lived lockfile around just this section
    // serializes concurrent setters, same pattern as session_store.ts's saveSessionState.
    // Losing the race to acquire the lock in time falls back to the old unprotected
    // read-modify-write instead of dropping the update outright.
    const applySet = (): unknown => {
      const cfg = loadPersistedConfig() as unknown as Record<string, unknown>
      // Test-only seam: widens the load->save window so a regression test can deterministically
      // force a second concurrent `config set` to land its own load+save inside it, instead of
      // relying on OS process-start jitter to (unreliably) produce a collision. No-op unless a
      // test explicitly sets this env var; never set in normal operation.
      const testDelayMs = Number(process.env['TOKEN_GOAT_TEST_RMW_DELAY_MS'] ?? '')
      if (Number.isFinite(testDelayMs) && testDelayMs > 0) sleepSync(testDelayMs)
      const ref = walkParent(cfg, parts)
      if (!ref) {
        throw new Error(`key not found: ${key}${didYouMeanKeySuffix(key)}`)
      }
      const existing = ref.parent[ref.leaf]
      if (existing === undefined) {
        throw new Error(`key not found: ${key}${didYouMeanKeySuffix(key)}`)
      }
      if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
        throw new Error(`config set: '${key}' is a section, not a settable field — set an individual key within it instead (e.g. ${key}.<field>)`)
      }
      const defaultAtKey = walkGet(defaultConfig() as unknown as Record<string, unknown>, parts)
      const coercedValue = coerce(value, existing, defaultAtKey.found ? defaultAtKey.value : undefined)
      ref.parent[ref.leaf] = coercedValue
      if (typeof coercedValue === 'number') {
        // Re-validate the candidate config through the same bounds loadConfig() enforces (no env
        // overlay, so the check reflects the value actually being written). If the field clamps
        // to something else, the input was out of its documented range — reject instead of
        // silently writing an invalid value that only gets clamped (with no feedback) next load.
        const revalidated = buildPersistedConfig(cfg) as unknown as Record<string, unknown>
        const revalidatedResult = walkGet(revalidated, parts)
        if (revalidatedResult.found && revalidatedResult.value !== coercedValue) {
          throw new Error(`config set: ${key} = ${coercedValue} is outside the allowed range (would be clamped to ${String(revalidatedResult.value)}); rejected`)
        }
      }
      saveConfigSafe(cfg as unknown as Parameters<typeof saveConfig>[0])
      return coercedValue
    }
    // Must exist before the lock file itself can be created (writeFileSync 'wx' throws ENOENT,
    // not EEXIST, against a missing directory -- withFileLock treats that as "can't lock at
    // all" and silently falls back to running unprotected, defeating the lock entirely on a
    // machine that has never run `config set` before).
    ensureDirSync(path.dirname(configPath()))
    const lockPath = path.join(path.dirname(configPath()), '.config.lock')
    // Same reasoning and value as session_store.ts's saveSessionState (see LOCK_WAIT_MS_HARDENED's
    // docstring in util.ts): the default withFileLock budget can plausibly be missed under real
    // machine load with no lock holder actually stuck, and falling back to an unprotected write on
    // that miss would reintroduce the exact clobber this lock exists to prevent.
    const lockResult = withFileLock(lockPath, applySet, { waitMs: LOCK_WAIT_MS_HARDENED })
    const coerced = lockResult === undefined ? applySet() : lockResult
    invalidateConfigCache()
    // The write above only ever touches the env-free persisted config, so if an env var
    // currently overrides this same key, loadConfig() (env-layered, same as `get`/`list`)
    // will keep returning the env-forced value instead of what was just saved — surface
    // that shadowing here or the user is told the change succeeded when it has no runtime
    // effect until the env var is unset.
    const envOverrides = CONFIG_KEY_ENV_OVERRIDES[key]
    if (envOverrides !== undefined) {
      const effective = walkGet(loadConfig() as unknown as Record<string, unknown>, parts)
      if (effective.found && effective.value !== coerced) {
        const active = envOverrides.find((name) => {
          const raw = process.env[name]
          return raw !== undefined && raw.trim() !== ''
        })
        const envVar = active ?? envOverrides[0]
        emitErr(`config set: warning: ${key} was saved to config.toml, but ${envVar} is currently set and overrides it at runtime — unset ${envVar} for this change to take effect`)
      }
    }
    if (opts.json === true) {
      emit(JSON.stringify({ key, value: coerced }, null, 2))
      return
    }
    emit(`${key} = ${JSON.stringify(coerced)}`)
    return
  }

  if (action === 'validate') {
    const cfgFile = configPath()
    let raw: Record<string, unknown> = {}
    let parseErr: string | null = null
    try {
      const text = fs.readFileSync(cfgFile, 'utf8')
      raw = parse(text) as Record<string, unknown>
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        parseErr = e instanceof Error ? e.message : String(e)
      }
    }

    const defCfg = defaultConfig() as unknown as Record<string, unknown>
    const findings: Array<{ kind: string; key: string; suggestion?: string }> = []

    if (parseErr !== null) {
      findings.push({ kind: 'parse_error', key: cfgFile, suggestion: parseErr })
    } else {
      for (const section of Object.keys(raw)) {
        const knownSecs = Object.keys(defCfg)
        if (!knownSecs.includes(section)) {
          const suggestions = closestKeys(section, knownSecs)
          const finding: { kind: string; key: string; suggestion?: string } = { kind: 'unknown_section', key: section }
          if (suggestions.length > 0) finding.suggestion = suggestions.join(', ')
          findings.push(finding)
          continue
        }
        const defSection = defCfg[section] as Record<string, unknown>
        const rawSection = raw[section]
        if (typeof rawSection !== 'object' || rawSection === null) continue
        for (const subkey of Object.keys(rawSection as Record<string, unknown>)) {
          const knownKeys = Object.keys(defSection)
          if (!knownKeys.includes(subkey)) {
            const suggestions = closestKeys(subkey, knownKeys)
            const finding: { kind: string; key: string; suggestion?: string } = { kind: 'unknown_key', key: `${section}.${subkey}` }
            if (suggestions.length > 0) finding.suggestion = suggestions.join(', ')
            findings.push(finding)
          }
        }
      }
    }

    if (opts.json === true) {
      emit(JSON.stringify({ findings, ok: findings.length === 0 }, null, 2))
      return
    }
    if (findings.length === 0) {
      emit('config validate: no issues found')
      return
    }
    for (const f of findings) {
      const hint = f.suggestion !== undefined ? ` (did you mean: ${f.suggestion}?)` : ''
      emit(`[${f.kind}] ${f.key}${hint}`)
    }
    emit(`config validate: ${findings.length} issue(s) found`)
    return
  }

  throw new Error(`config: unknown action '${action}'. Use list, get, set, or validate.`)
}

// ── project ───────────────────────────────────────────────────────────────────

export function cmdProject(opts: { action: string; pathArg?: string; json?: boolean }): void {
  const { action } = opts

  if (action === 'list') {
    const cfg = loadConfig()
    const active = findProject(process.cwd())
    const blocked = cfg.worker.blocked_roots
    if (opts.json === true) {
      emit(JSON.stringify({ active: active ? { root: active.root, hash: active.hash, marker: active.marker } : null, blocked_roots: blocked }, null, 2))
      return
    }
    if (active) {
      emit(`Active project: ${active.root}`)
      emit(`  marker: ${active.marker}`)
    } else {
      emit('Active project: (none — not inside a recognized project root)')
    }
    if (blocked.length === 0) {
      emit('Blocked roots: (none)')
    } else {
      emit('Blocked roots:')
      for (const r of blocked) emit(`  ${r}`)
    }
    return
  }

  if (action === 'exclude') {
    if (!opts.pathArg) {
      emitErr('project exclude requires a path argument')
      throw new Error('missing path')
    }
    const target = path.resolve(opts.pathArg)
    const cfg = loadPersistedConfig()
    if (cfg.worker.blocked_roots.includes(target)) {
      emit(`Already excluded: ${target}`)
      return
    }
    cfg.worker.blocked_roots = [...cfg.worker.blocked_roots, target]
    saveConfigSafe(cfg)
    invalidateConfigCache()
    if (opts.json === true) {
      emit(JSON.stringify({ excluded: target, blocked_roots: cfg.worker.blocked_roots }, null, 2))
      return
    }
    emit(`Excluded: ${target}`)
    return
  }

  if (action === 'prune') {
    const cfg = loadPersistedConfig()
    const before = cfg.worker.blocked_roots
    const after = before.filter((r) => {
      try { return fs.existsSync(r) } catch { return false }
    })
    const removed = before.length - after.length
    cfg.worker.blocked_roots = after
    saveConfigSafe(cfg)
    invalidateConfigCache()
    if (opts.json === true) {
      emit(JSON.stringify({ pruned: removed, blocked_roots: after }, null, 2))
      return
    }
    emit(`Pruned ${removed} stale root(s). Remaining: ${after.length}`)
    return
  }

  emitErr(`project: unknown action '${action}'. Use list, exclude, or prune.`)
  throw new Error(`unknown project action: ${action}`)
}

// ── compact-doc ───────────────────────────────────────────────────────────────

export function cmdCompactDoc(opts: {
  filePath: string
  heading?: string
  json?: boolean
  force?: boolean
  sentences?: string
  show?: boolean
}): void {
  const resolved = path.resolve(opts.filePath)

  // Legacy mode: extract a named section, or the content after a
  // `<!-- COMPACT_END -->` marker, straight from the source file. This
  // predates and is independent of the extractive-sidecar pipeline below —
  // --force/--sentences/--show don't apply here.
  if (opts.heading !== undefined) {
    const result = compactDoc(resolved, opts.heading)
    if (result === null) {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    if (opts.json === true) {
      emit(JSON.stringify({ path: resolved, compact: result }, null, 2))
      return
    }
    emit(result)
    return
  }

  let sentences: number | undefined
  if (opts.sentences !== undefined) {
    const n = Number.parseInt(opts.sentences, 10)
    if (!Number.isFinite(n) || n <= 0) {
      emitErr(`compact-doc: --sentences must be a positive number, got: "${opts.sentences}"`)
      throw new Error(`invalid --sentences: ${opts.sentences}`)
    }
    sentences = n
  }

  const compactPath = compactPathFor(resolved)
  const fresh = isCompactFresh(compactPath, resolved)
  let rebuilt = false
  let body: string

  if (opts.force === true || !fresh) {
    let sourceText: string
    try {
      sourceText = fs.readFileSync(resolved, 'utf-8')
    } catch {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    body = buildExtractiveCompact(sourceText, sentences)
    writeCompact(compactPath, resolved, body)
    rebuilt = true
  } else {
    const existing = readCompactBody(compactPath)
    if (existing === null) {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    body = existing
  }

  if (opts.json === true) {
    emit(JSON.stringify({ path: resolved, compactPath, rebuilt, compact: body }, null, 2))
    return
  }

  if (opts.show === true) {
    emit(body)
    return
  }

  emit(
    `Compact sidecar ${rebuilt ? 'built' : 'already fresh'} at ${compactPath} ` +
      `(source: ${resolved}). Use --show to print it, --force to rebuild.`,
  )
}

// ── fetch-image ───────────────────────────────────────────────────────────────

const MAX_FETCH_REDIRECTS = 5
const FETCH_IMAGE_TIMEOUT_SEC = 30
const FETCH_IMAGE_MAX_SIZE_BYTES = 50 * 1024 * 1024

/**
 * Fetch a URL's raw bytes for `fetch-image`.
 *
 * Reuses webfetch.ts's hardened fetch primitive instead of duplicating its
 * SSRF/size/timeout handling: performHttpFetch resolves and pins DNS through
 * ssrfPinnedLookup (blocking private/loopback/link-local targets, including
 * on every redirect hop, not just the initial request), caps the response
 * body at FETCH_IMAGE_MAX_SIZE_BYTES while it's still streaming in rather
 * than after buffering it whole, and bounds the whole request — redirects
 * included — by FETCH_IMAGE_TIMEOUT_SEC.
 */
async function fetchBuffer(url: string): Promise<Buffer> {
  const result = await performHttpFetch(url, {
    deadlineAt: Date.now() + FETCH_IMAGE_TIMEOUT_SEC * 1000,
    timeoutSec: FETCH_IMAGE_TIMEOUT_SEC,
    maxSizeBytes: FETCH_IMAGE_MAX_SIZE_BYTES,
    requestHeaders: {},
    redirectsLeft: MAX_FETCH_REDIRECTS,
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status} for ${url}`)
  }
  return result.body
}

export async function cmdFetchImage(opts: { url: string; out?: string; json?: boolean }): Promise<void> {
  const outPath = opts.out ?? path.join(os.tmpdir(), `tg-fetch-${Date.now()}.bin`)
  let buf: Buffer
  try {
    buf = await fetchBuffer(opts.url)
  } catch (e) {
    emitErr(`fetch-image: network error — ${e instanceof Error ? e.message : String(e)}`)
    throw new Error(`fetch failed: ${opts.url}`, { cause: e })
  }
  const originalBytes = buf.length
  let shrunkBytes: number
  let outData: Buffer
  let wasShrunk = false
  try {
    const result = await shrinkImage(buf)
    if (result !== null) {
      outData = result.data
      shrunkBytes = result.shrunkBytes
      wasShrunk = true
    } else {
      outData = buf
      shrunkBytes = originalBytes
    }
  } catch {
    outData = buf
    shrunkBytes = originalBytes
  }
  fs.writeFileSync(outPath, outData)
  if (opts.json === true) {
    emit(JSON.stringify({ url: opts.url, out: outPath, originalBytes, shrunkBytes, wasShrunk }, null, 2))
    return
  }
  const savings = wasShrunk ? ` (saved ${originalBytes - shrunkBytes} bytes)` : ' (not shrunk — already small or unsupported format)'
  emit(`Fetched ${originalBytes} bytes → ${outPath}${savings}`)
}

// ── history ───────────────────────────────────────────────────────────────────

export function cmdHistory(opts: { limit?: string; json?: boolean }): void {
  let limit = 30
  if (opts.limit !== undefined) {
    const n = Number.parseInt(opts.limit, 10)
    if (!Number.isFinite(n)) {
      emitErr(`history: --limit must be a number, got: "${opts.limit}"`)
      throw new Error(`invalid --limit: ${opts.limit}`)
    }
    limit = Math.max(1, n)
  }

  const bashItems = listBlobs(BASH_OUTPUT_SUBDIR)
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        type: 'bash' as const,
        id,
        storedAt: typeof v['storedAt'] === 'number' ? v['storedAt'] : mtime,
        summary: typeof v['command'] === 'string' ? v['command'] : '',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const webItems = listBlobs(WEB_OUTPUT_SUBDIR)
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        type: 'web' as const,
        id,
        storedAt: mtime,
        summary: typeof v['url'] === 'string' ? v['url'] : '',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const items = [...bashItems, ...webItems]
    .sort((a, b) => b.storedAt - a.storedAt)
    .slice(0, limit)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return
  }
  if (items.length === 0) {
    emit('No history entries found (no cached bash outputs or web fetches).')
    return
  }
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
  emit(`${pad('type', 5)}  ${pad('id', 18)}  summary`)
  for (const item of items) {
    const preview = item.summary.length > 80 ? item.summary.slice(0, 77) + '...' : item.summary
    emit(`${pad(item.type, 5)}  ${pad(item.id, 18)}  ${preview}`)
  }
}
