/**
 * Cache and history commands: bash-history, web-history, clean-cache,
 * prune-cache, cache-audit. D2 appends session / cost commands to this file.
 */

import { listBlobs, pruneBlobs, DEFAULT_MAX_COUNT, DEFAULT_MAX_AGE_MS } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from './bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from './web_cache.js'
import { SESSIONS_SUBDIR, AGENT_SALT_MARKER } from './session_store.js'
import { pruneSkillOutputs, SKILLS_OUTPUT_SUBDIR } from './skill_cache.js'
import { isInstalled } from './install.js'
import { cleanupStaleDownloads } from './webfetch.js'
import { buildResumePacket } from './resume.js'
import { getContextPressure, buildManifestWithCount, estimateTokens, findLatestSessionId, loadSessionCache, CONTEXT_AUTOCOMPACT_TOKENS } from './compact.js'
import { runStats } from './cli_stats.js'
import { buildProjectMap, formatProjectMap, formatMemSuggestions, findMemSuggestionCandidates } from './baseline.js'
import { ensureNewline, pad, requireNonNegativeStrictInt, countNoun } from './util.js'
import { loadConfig } from './config.js'

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/**
 * Cap a listing to `limit` rows and say so on stderr when rows were dropped.
 *
 * These listings serialize a bare JSON array under `--json`, so there is nowhere in-band to put a
 * `truncated` flag without breaking every pipeline that consumes the array. stderr is the only
 * channel left. A pipeline that discards stderr still cannot see the notice -- that residual risk is
 * real, and named rather than hidden. What is not acceptable is disclosure on neither channel,
 * which is what all three listings did: `--limit 10` against 200 cached entries printed ten rows
 * that were byte-identical to a complete answer.
 *
 * Shared rather than written out three times because the three callers are the same listing with a
 * different row shape, and a notice that exists in two of them is the failure this fixes.
 */
function capAndNote<T>(rows: readonly T[], limit: number): T[] {
  const shown = rows.slice(0, limit)
  if (shown.length < rows.length) {
    emitErr(`Showing ${shown.length} of ${rows.length} entries (raise --limit to see the rest).`)
  }
  return shown
}

/** Parses a `--limit` option to a positive int, defaulting to `dflt` when unset. Shared by
 * cmdBashHistory/cmdWebHistory/cmdMcpHistory, which all validate --limit the same way.
 *
 * `--limit 0` is rejected rather than accepted-and-sliced-to-empty: each caller's
 * zero-results branch prints an absolute claim ("No bash output entries cached.") that a
 * silently-empty `.slice(0, 0)` result would make even when entries genuinely exist --
 * indistinguishable from a real empty cache. Same false-clean failure mode as runFind's own
 * --limit validation (read_commands.ts) and graph_commands.ts's --top validation. */
function parseLimitOpt(cmdName: string, limitStr: string | undefined, dflt = 30): number {
  if (limitStr === undefined) return dflt
  let n: number
  try {
    n = requireNonNegativeStrictInt('--limit', limitStr)
  } catch (e) {
    emitErr(`${cmdName}: --limit must be a positive number, got: "${limitStr}"`)
    throw new Error(`invalid --limit: ${limitStr}`, { cause: e })
  }
  if (n === 0) {
    emitErr(`${cmdName}: --limit must be a positive number, got: "${limitStr}"`)
    throw new Error(`invalid --limit: ${limitStr}`)
  }
  return n
}

// Confirmed storage subdirs operated on by clean-cache and prune-cache.
const CACHE_SUBDIRS = [BASH_OUTPUT_SUBDIR, WEB_OUTPUT_SUBDIR, SESSIONS_SUBDIR, SKILLS_OUTPUT_SUBDIR] as const

// skills entries are plain .txt/.meta files, not disk_cache.ts's JSON blob envelope, so
// they need skill_cache.ts's own eviction pass instead of the generic pruneBlobs.
function pruneSubdir(sub: string, maxCount: number, maxAgeMs: number): number {
  return sub === SKILLS_OUTPUT_SUBDIR ? pruneSkillOutputs(maxCount, maxAgeMs) : pruneBlobs(sub, maxCount, maxAgeMs)
}

// Cache-feature env vars: when set to '0' or 'false', the named feature is disabled.
const CACHE_ENV_GATES: Array<{ key: string; what: string }> = [
  { key: 'TOKEN_GOAT_BASH_COMPRESS', what: 'bash output caching and recall' },
  { key: 'TOKEN_GOAT_COMPACT_ASSIST', what: 'compact-assist manifest injection' },
  { key: 'TOKEN_GOAT_INJECTION_ENABLED', what: 'context injection in hooks' },
]

const INDEXING_SKIP_KB_SANITY_FLOOR = 5



/**
 * List session blobs, excluding agent-salted subagent blobs (see
 * {@link AGENT_SALT_MARKER}) and sorted newest-first. Mirrors compact.ts's
 * `findLatestSessionId` filter: a subagent's blob is often the newest file
 * on disk, so an unfiltered "most recent" pick can surface a narrow
 * subagent-scoped ledger where callers expect the genuine parent session.
 */
function listParentSessionBlobs(): Array<{ id: string; mtime: number; value: unknown }> {
  return listBlobs(SESSIONS_SUBDIR)
    .filter((b) => !b.id.includes(AGENT_SALT_MARKER))
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Newest parent session blob's id and its `files` array, normalized against a malformed or
 * missing shape — shared by cmdSessionSummary and cmdCost, which both need exactly this. Returns
 * null when no parent session blob exists at all (callers render their own "no session" message).
 */
function getNewestSessionFiles(): { id: string; sessionCount: number; filesArr: Array<Record<string, unknown>> } | null {
  const blobs = listParentSessionBlobs()
  if (blobs.length === 0) return null
  const newest = blobs[0]!
  const raw = (typeof newest.value === 'object' && newest.value !== null) ? (newest.value as Record<string, unknown>) : {}
  const filesArr = Array.isArray(raw['files']) ? (raw['files'] as Array<Record<string, unknown>>) : []
  return { id: newest.id, sessionCount: blobs.length, filesArr }
}

// ── bash-history ─────────────────────────────────────────────────────────────

export function cmdBashHistory(opts: { limit?: string; json?: boolean }): void {
  const limit = parseLimitOpt('bash-history', opts.limit)
  const blobs = listBlobs(BASH_OUTPUT_SUBDIR)
  const allItems = blobs
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        id,
        command: typeof v['command'] === 'string' ? v['command'] : '',
        storedAt: typeof v['storedAt'] === 'number' ? v['storedAt'] : mtime,
        exitCode: typeof v['exitCode'] === 'number' ? v['exitCode'] : -1,
        sizeBytes: typeof v['sizeBytes'] === 'number' ? v['sizeBytes'] : 0,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.storedAt - a.storedAt)
  const items = capAndNote(allItems, limit)
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return
  }
  if (items.length === 0) {
    process.stdout.write('No bash output entries cached.\n')
    return
  }
  process.stdout.write(`${pad('id', 18)}  ${pad('bytes', 8)}  ${pad('exit', 4)}  command\n`)
  for (const item of items) {
    // A multi-line command (heredoc, chained script) embeds literal newlines/tabs into
    // item.command; printed raw, each embedded line would break this fixed-width table's
    // one-row-per-entry structure. Same defect class already fixed in mcp_compress.ts's
    // cellText and resume.ts's bash-command line.
    const flatCommand = item.command.replace(/[\t\r\n]+/g, ' ')
    const preview = flatCommand.length > 80 ? flatCommand.slice(0, 77) + '...' : flatCommand
    process.stdout.write(`${pad(item.id, 18)}  ${pad(String(item.sizeBytes), 8)}  ${pad(String(item.exitCode), 4)}  ${preview}\n`)
  }
}

// ── web-history ───────────────────────────────────────────────────────────────

// Web blobs are stored as { url, content } — no status or storedAt field; mtime used for ordering.
export function cmdWebHistory(opts: { limit?: string; json?: boolean }): void {
  const limit = parseLimitOpt('web-history', opts.limit)
  const blobs = listBlobs(WEB_OUTPUT_SUBDIR)
  const allItems = blobs
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        id,
        url: typeof v['url'] === 'string' ? v['url'] : '',
        bytes: typeof v['content'] === 'string' ? Buffer.byteLength(v['content'], 'utf8') : 0,
        storedAt: mtime,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.storedAt - a.storedAt)
  const items = capAndNote(allItems, limit)
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return
  }
  if (items.length === 0) {
    process.stdout.write('No web output entries cached.\n')
    return
  }
  process.stdout.write(`${pad('id', 18)}  ${pad('bytes', 8)}  url\n`)
  for (const item of items) {
    process.stdout.write(`${pad(item.id, 18)}  ${pad(String(item.bytes), 8)}  ${item.url.replace(/[\t\r\n]+/g, ' ')}\n`)
  }
}

// ── mcp-history ───────────────────────────────────────────────────────────────

// MCP results share BASH_OUTPUT_SUBDIR with plain bash-output entries (see
// mcp_cache.ts's storeMcpOutput), distinguished only by the `mcp_` id prefix it
// mints; this listing filters bash-history's underlying blob set down to just
// those. `command` is stored as `mcp:<toolName> <input preview>` (see
// mcp_cache.ts's mcpInputPreview) — split off the `mcp:` marker and first space
// to recover the tool name for its own column instead of the raw label.
export function cmdMcpHistory(opts: { limit?: string; json?: boolean }): void {
  const limit = parseLimitOpt('mcp-history', opts.limit)
  const blobs = listBlobs(BASH_OUTPUT_SUBDIR).filter((b) => b.id.startsWith('mcp_'))
  const allItems = blobs
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      const command = typeof v['command'] === 'string' ? v['command'] : ''
      const toolName = command.startsWith('mcp:') ? command.slice(4).split(' ')[0] || '' : ''
      return {
        id,
        toolName,
        storedAt: typeof v['storedAt'] === 'number' ? v['storedAt'] : mtime,
        sizeBytes: typeof v['sizeBytes'] === 'number' ? v['sizeBytes'] : 0,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.storedAt - a.storedAt)
  const items = capAndNote(allItems, limit)
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return
  }
  if (items.length === 0) {
    process.stdout.write('No mcp output entries cached.\n')
    return
  }
  process.stdout.write(`${pad('id', 18)}  ${pad('bytes', 8)}  tool\n`)
  for (const item of items) {
    process.stdout.write(`${pad(item.id, 18)}  ${pad(String(item.sizeBytes), 8)}  ${item.toolName.replace(/[\t\r\n]+/g, ' ')}\n`)
  }
}

// ── clean-cache ───────────────────────────────────────────────────────────────

export function cmdCleanCache(opts: { json?: boolean }): void {
  const removed: Record<string, number> = {}
  let total = 0
  for (const sub of CACHE_SUBDIRS) {
    const n = pruneSubdir(sub, DEFAULT_MAX_COUNT, DEFAULT_MAX_AGE_MS)
    removed[sub] = n
    total += n
  }
  // web_cache (webfetch's own download cache, distinct from the WEB_OUTPUT_SUBDIR entries
  // pruned above) can accumulate orphaned .tmp files left behind by a process killed mid-download
  // -- cleanupStaleDownloads existed, fully tested, with zero production callers until this wiring.
  const staleDownloads = cleanupStaleDownloads()
  removed['web_cache_tmp'] = staleDownloads
  total += staleDownloads
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ removed, total }, null, 2) + '\n')
    return
  }
  for (const [sub, n] of Object.entries(removed)) {
    process.stdout.write(`${sub}: removed ${n}\n`)
  }
  process.stdout.write(`total: ${total} removed\n`)
}

// ── prune-cache ───────────────────────────────────────────────────────────────

/** prune-cache lets the caller specify eviction bounds; clean-cache uses the defaults. */
export function cmdPruneCache(opts: { maxCount?: string; maxAgeHours?: string; json?: boolean }): void {
  let maxCount = DEFAULT_MAX_COUNT
  let maxAgeMs = DEFAULT_MAX_AGE_MS

  if (opts.maxCount !== undefined) {
    try {
      maxCount = requireNonNegativeStrictInt('--maxCount', opts.maxCount)
    } catch {
      throw new Error(`--maxCount must be a valid integer, got '${opts.maxCount}'`)
    }
  }

  if (opts.maxAgeHours !== undefined) {
    const parsed = parseFloat(opts.maxAgeHours)
    if (Number.isNaN(parsed)) {
      throw new Error(`--maxAgeHours must be a valid number, got '${opts.maxAgeHours}'`)
    }
    maxAgeMs = Math.max(0, parsed) * 3600 * 1000
  }

  const removed: Record<string, number> = {}
  let total = 0
  for (const sub of CACHE_SUBDIRS) {
    const n = pruneSubdir(sub, maxCount, maxAgeMs)
    removed[sub] = n
    total += n
  }
  // clean-cache (cmdCleanCache above) sweeps orphaned .tmp download files left behind by a
  // process killed mid-download (see cleanupStaleDownloads in webfetch.ts); prune-cache is
  // documented as "clean-cache but with caller-specified eviction bounds", so it must sweep the
  // same web_cache_tmp files -- cleanupStaleDownloads takes no bounds of its own (it always
  // removes every .tmp file, unconditionally), so there's nothing maxCount/maxAgeHours could
  // even apply to here. Regression: this call was added to cmdCleanCache (30e16aee) but never
  // mirrored onto this sibling command, so `token-goat prune-cache` silently left those files
  // behind while `token-goat clean-cache` swept them.
  const staleDownloads = cleanupStaleDownloads()
  removed['web_cache_tmp'] = staleDownloads
  total += staleDownloads
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ removed, total, maxCount, maxAgeMs }, null, 2) + '\n')
    return
  }
  for (const [sub, n] of Object.entries(removed)) {
    process.stdout.write(`${sub}: removed ${n}\n`)
  }
  process.stdout.write(`total: ${total} removed\n`)
}

// ── cache-audit ───────────────────────────────────────────────────────────────

interface AuditFinding {
  check: string
  ok: boolean
  detail: string
}

/** Check settings.json hook installation and env-var gates; report what was checked and what was found. */
export function cmdCacheAudit(opts: { json?: boolean }): void {
  const findings: AuditFinding[] = []
  const userOk = isInstalled('user')
  findings.push({
    check: 'hooks:user',
    ok: userOk,
    detail: userOk
      ? 'token-goat hooks installed at user scope (~/.claude/settings.json)'
      : 'hooks not installed at user scope — run: token-goat install',
  })
  const projOk = isInstalled('project')
  findings.push({
    check: 'hooks:project',
    ok: projOk,
    detail: projOk
      ? 'token-goat hooks installed at project scope (./.claude/settings.json)'
      : 'hooks not installed at project scope (optional — user scope is sufficient)',
  })
  for (const { key, what } of CACHE_ENV_GATES) {
    const val = process.env[key]
    const disabled = val === '0' || val === 'false'
    findings.push({
      check: `env:${key}`,
      ok: !disabled,
      detail: disabled ? `${key}=${val} — disables ${what}` : `${key} unset (feature enabled by default)`,
    })
  }
  // A large_file_skip_kb this small silently guts indexing project-wide (nearly every real
  // source file exceeds a few KB, so `token-goat index` would skip almost everything with no
  // error -- exactly what happened when this session's own config.toml was accidentally
  // corrupted to large_file_skip_kb=1, and no existing check surfaced it). 5 KB is well below
  // any file size a legitimate skip-most-large-files config would plausibly choose.
  const skipKb = loadConfig().indexing.large_file_skip_kb
  const skipKbOk = skipKb >= INDEXING_SKIP_KB_SANITY_FLOOR
  findings.push({
    check: 'indexing:large_file_skip_kb',
    ok: skipKbOk,
    detail: skipKbOk
      ? `large_file_skip_kb=${skipKb} (indexing not crippled by an unreasonably small skip threshold)`
      : `large_file_skip_kb=${skipKb} is suspiciously small — most real source files will be skipped from indexing. Reset with: token-goat config set indexing.large_file_skip_kb 2048`,
  })
  const issueCount = findings.filter((f) => !f.ok).length
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ findings, issueCount }, null, 2) + '\n')
    return
  }
  for (const f of findings) {
    const mark = f.ok ? 'ok  ' : 'WARN'
    process.stdout.write(`[${mark}] ${f.check}: ${f.detail}\n`)
  }
  process.stdout.write(issueCount === 0 ? 'cache-audit: no issues found\n' : `cache-audit: ${issueCount} issue(s) found\n`)
}

// ── resume ────────────────────────────────────────────────────────────────────

/** Print a recovery context packet for the given session id. Throws if no session blob found. */
export async function cmdResume(opts: { sessionId: string; json?: boolean }): Promise<void> {
  const packet = await buildResumePacket(opts.sessionId)
  if (packet === null) {
    throw new Error(`no session blob found for '${opts.sessionId}' — list sessions with: token-goat session-summary --json`)
  }
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ sessionId: opts.sessionId, packet }, null, 2) + '\n')
    return
  }
  process.stdout.write(packet + (packet.endsWith('\n') ? '' : '\n'))
}

// ── compact-hint ──────────────────────────────────────────────────────────────

/** Show compact manifest info and context pressure. Reuses compact.ts primitives; never rebuilds the manifest. */
export function cmdCompactHint(opts: { sessionId?: string; trigger?: string; json?: boolean }): void {
  const sessionId = opts.sessionId ?? findLatestSessionId()
  const cache = sessionId !== null ? loadSessionCache(sessionId) : null
  const pressure = getContextPressure(cache ?? undefined)
  const [manifest, eventCount] = sessionId !== null ? buildManifestWithCount(sessionId) : (['', 0] as [string, number])
  const manifestTokens = estimateTokens(manifest)
  const pct = (pressure.fillFraction * 100).toFixed(1)
  if (opts.json === true) {
    const out: Record<string, unknown> = { tier: pressure.tier, fillFraction: pressure.fillFraction, pct: Number(pct), manifestTokens, eventCount }
    if (sessionId !== null) out['sessionId'] = sessionId
    if (opts.trigger !== undefined) out['trigger'] = opts.trigger
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return
  }
  process.stdout.write(`Compact hint — context: ${pressure.tier} (${pct}% full)\n`)
  if (sessionId !== null) process.stdout.write(`Session: ${sessionId}\n`)
  process.stdout.write(`Manifest: ${manifestTokens} tokens, ${countNoun(eventCount, 'event')}\n`)
  if (opts.trigger === 'auto') {
    const remaining = Math.max(0, Math.round((1 - pressure.fillFraction) * CONTEXT_AUTOCOMPACT_TOKENS))
    process.stdout.write(`Auto-compact at ${CONTEXT_AUTOCOMPACT_TOKENS.toLocaleString()} tokens; ~${remaining.toLocaleString()} remaining\n`)
  }
}

// ── session-summary ───────────────────────────────────────────────────────────

/** One-screen summary of the latest cached session: file counts, top files, session id. */
export function cmdSessionSummary(opts: { json?: boolean }): void {
  const session = getNewestSessionFiles()
  if (session === null) {
    if (opts.json === true) {
      process.stdout.write(JSON.stringify({ sessionCount: 0, message: 'no session blobs found' }, null, 2) + '\n')
      return
    }
    process.stdout.write('No session blobs found.\n')
    return
  }
  const { id, sessionCount, filesArr } = session
  const filesEdited = filesArr.filter((f) => f['wasEdited'] === true).length
  const filesRead = filesArr.filter((f) => f['wasEdited'] !== true).length
  const topFiles = [...filesArr]
    .sort((a, b) => (typeof b['readCount'] === 'number' ? b['readCount'] : 0) - (typeof a['readCount'] === 'number' ? a['readCount'] : 0))
    .slice(0, 5)
    .map((f) => (typeof f['path'] === 'string' ? f['path'] : ''))
    .filter(Boolean)
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ sessionId: id, sessionCount, filesRead, filesEdited, topFiles }, null, 2) + '\n')
    return
  }
  process.stdout.write(`Session: ${id}\n`)
  process.stdout.write(`Sessions cached: ${sessionCount}\n`)
  process.stdout.write(`Files read: ${filesRead}, edited: ${filesEdited}\n`)
  if (topFiles.length > 0) {
    process.stdout.write('Top files:\n')
    for (const f of topFiles) process.stdout.write(`  ${f}\n`)
  }
}

// ── cost ──────────────────────────────────────────────────────────────────────

/** Tokens-saved / cost breakdown. Thin framing over runStats from cli_stats.ts. */
export function cmdCost(opts: { session?: boolean; json?: boolean }): void {
  if (opts.session === true) {
    const session = getNewestSessionFiles()
    if (session === null) {
      if (opts.json === true) {
        process.stdout.write(JSON.stringify({ session: true, message: 'no session blobs found' }, null, 2) + '\n')
        return
      }
      process.stdout.write('No session data found.\n')
      return
    }
    const { id, filesArr } = session
    const totalFiles = filesArr.length
    const totalReads = filesArr.reduce((sum, f) => sum + (typeof f['readCount'] === 'number' ? f['readCount'] : 0), 0)
    const totalBytes = filesArr.reduce((sum, f) => sum + (typeof f['sizeBytes'] === 'number' ? f['sizeBytes'] : 0), 0)
    if (opts.json === true) {
      process.stdout.write(JSON.stringify({ session: true, sessionId: id, totalFiles, totalReads, totalBytes }, null, 2) + '\n')
      return
    }
    process.stdout.write(`Session: ${id}\n`)
    process.stdout.write(`Files touched: ${totalFiles}, total reads: ${totalReads}, bytes scanned: ${totalBytes}\n`)
    return
  }
  runStats(opts.json === true ? { json: true } : {})
}

// ── baseline ──────────────────────────────────────────────────────────────────

/** Emit the project baseline map. --subagent = terser compact variant. */
export function cmdBaseline(opts: { subagent?: boolean; json?: boolean; suggestMem?: boolean }): void {
  const map = buildProjectMap(process.cwd(), { compact: opts.subagent === true })
  const suggestMem = opts.suggestMem === true
  if (opts.json === true) {
    const jsonOut: Record<string, unknown> = { ...map }
    if (suggestMem) jsonOut['memSuggestions'] = findMemSuggestionCandidates(process.cwd())
    process.stdout.write(JSON.stringify(jsonOut, null, 2) + String.fromCharCode(10))
    return
  }
  let out = formatProjectMap(map, map.compact)
  if (suggestMem) {
    const suggestions = formatMemSuggestions(process.cwd())
    if (suggestions !== '') out = out + String.fromCharCode(10) + suggestions
  }
  process.stdout.write(out + String.fromCharCode(10))
}
