/** Resolves the real name a deny or read hint's suggested command carries -- a heading, symbol, key or table the file actually holds -- so the command it leads with runs as printed, and sharpens a deny the same call already received once. Measured over 3,692 local Claude Code transcripts, the most frequent token-goat denies named a literal placeholder (`section "file::SectionHeading"`, `config-get "file" KEY_NAME`, `read "file::SymbolName"`), which exits 1 when run verbatim, and after a deny the next call was the named command only 4 times in 39 sampled. A placeholder is still the answer when nothing better is found: the claim is "this command runs", never "this is the part you wanted". */
import { openSync, readSync, closeSync, statSync } from 'node:fs'

import { resolveIndexPath, displaySafeText } from './paths.js'
import { querySymbols } from './index_reader.js'
import { indexMatchesDisk } from './index_freshness.js'
import { commandPathIsTouchable } from './vscode_path_gate.js'
import { extractMarkdownHeadings, type MarkdownHeading } from './hints/markdown_hints.js'
import { extractQuickSymbolSamples } from './hooks_read.js'
import { stripUnsafeSuggestions } from './hint_suggestion_guard.js'
import { getCompactedAt, markHintShown, wasHintShown } from './session.js'
import { shortFingerprint } from './fingerprint.js'
import { sessionStateKey, type HookEvent } from './hook_registry.js'
import { DELIVERS_CONTENT_RE } from './delivering_deny.js'
import type { HookOutput } from './types.js'

/** What a suggested command slices out of a file: a markdown/TOML/INI section, a code symbol, a config key, or a SQL CREATE block. */
export type HintSlice = 'section' | 'symbol' | 'key' | 'table'

/** The name a suggested command carries, and whether it is one the file really holds or the slice's placeholder. */
export interface HintTarget {
  readonly name: string
  readonly real: boolean
  readonly slice: HintSlice
}

/** What the caller already has in hand. `cwd` marks `filePath` as written in a command (resolved against it and gated before any fs touch); without it the path is taken as already resolved by the hook. `placeholder` replaces the slice's default fill-in when a site printed a different one before this module. */
export interface HintTargetSource {
  readonly cwd?: string
  readonly event?: HookEvent
  readonly content?: string | undefined
  readonly headings?: readonly MarkdownHeading[]
  readonly placeholder?: string
}

/** The fill-in-the-blank each slice fell back to before this module, kept as the answer when no real name is found so an unresolvable file reads exactly as it did. */
export const HINT_PLACEHOLDERS: Readonly<Record<HintSlice, string>> = { section: 'SectionHeading', symbol: 'SymbolName', key: 'KEY_NAME', table: 'table_name' }

/** Bytes of a file read to find a name when neither the caller nor the index supplies one: the first headings, keys or CREATE statements sit near the top, and this runs on the hook path. */
const HINT_TARGET_SCAN_BYTES = 32 * 1024

/** Index rows read per lookup. Rows arrive in line order, so a page holds the file's first names; a match past it falls through to the bounded read. */
const HINT_TARGET_INDEX_ROWS = 500

/** Candidates a content scan collects before picking, enough to step past a few unusable names. */
const HINT_TARGET_CANDIDATES = 20

/** A name longer than this is prose caught by a pattern, not a heading or identifier worth pasting. */
const MAX_HINT_NAME_CHARS = 120

const SECTION_PATH_RE = /\.(?:md|mdx|markdown|rst|txt|html?|toml|ini|cfg|conf)$/i
const TABLE_HEADER_PATH_RE = /\.(?:toml|ini|cfg|conf)$/i
const KEY_PATH_RE = /\.(?:jsonc?|ya?ml|properties|env)$/i
const ENV_BASENAME_RE = /(?:^|[\\/])\.env(?:\.[\w.-]+)?$/i

/** Index kinds that answer each slice; `symbol` takes whatever the file holds. */
const SLICE_KINDS: Readonly<Record<Exclude<HintSlice, 'symbol'>, ReadonlySet<string>>> = {
  section: new Set(['heading', 'section']),
  key: new Set(['property', 'key', 'env_key']),
  table: new Set(['sql_table', 'sql_type', 'sql_view']),
}

const JSON_FIRST_KEY_RE = /^\s*\{\s*"((?:[^"\\\r\n]|\\.)*)"\s*:/
const YAML_KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:/gm
const ENV_KEY_RE = /^(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*[=:]/gm
const TABLE_HEADER_RE = /^[ \t]*\[([^[\]\r\n]+)\]/gm
const SQL_CREATE_RE = /\bCREATE\s+(?:(?:OR\s+REPLACE|TEMP|TEMPORARY|UNLOGGED)\s+)*(?:TABLE|TYPE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"\r\n]+)"|`([^`\r\n]+)`|\[([^\]\r\n]+)\]|([\w.]+))/gi
const HEADING_LEVEL_RE = /^\s*(#{1,6})\s/
const SETEXT_DASH_RE = /\n[ \t]*-{3,}[ \t]*$/

/** The slice a file's own type offers: sections for prose and TOML/INI tables, keys for JSON/YAML/.env/.properties, CREATE blocks for SQL, symbols for everything else. */
export function sliceForPath(filePath: string): HintSlice {
  if (/\.sql$/i.test(filePath)) return 'table'
  if (KEY_PATH_RE.test(filePath) || ENV_BASENAME_RE.test(filePath)) return 'key'
  if (SECTION_PATH_RE.test(filePath)) return 'section'
  return 'symbol'
}

/** `name` when it can be pasted into a double-quoted argument and run verbatim, else null. The relay's own guard is the test, so a name passes exactly when a command carrying it survives stripUnsafeSuggestions; a backslash (which would escape the closing quote), the `::` spec separator, and anything displaySafeText would rewrite (a token-goat marker, a control character) are refused on top, since these names also reach channels the relay does not guard. */
function quotable(raw: string): string | null {
  const name = raw.trim()
  if (name === '' || name.length > MAX_HINT_NAME_CHARS || name.includes('\\') || name.includes('::')) return null
  if (displaySafeText(name) !== name) return null
  const probe = 'token-goat read "' + name + '"'
  return stripUnsafeSuggestions(probe) === probe ? name : null
}

/** First usable name in line order. For sections, a heading that occurs twice is skipped (`section` refuses an ambiguous one) and a lone top-level title is passed over for the heading after it, since the title's section is the whole document the deny just refused. */
function pick(candidates: ReadonlyArray<{ name: string; level: number }>, slice: HintSlice): string | null {
  const usable = candidates.flatMap((c) => {
    const name = quotable(c.name)
    return name === null ? [] : [{ name, level: c.level }]
  })
  if (slice !== 'section') return usable[0]?.name ?? null
  const counts = new Map<string, number>()
  for (const c of candidates) counts.set(c.name.trim(), (counts.get(c.name.trim()) ?? 0) + 1)
  const unique = usable.filter((c) => counts.get(c.name) === 1)
  const first = unique[0]
  if (first === undefined) return null
  const top = Math.min(...unique.map((c) => c.level))
  const loneTitle = first.level === top && unique.filter((c) => c.level === top).length === 1
  return loneTitle && unique.length > 1 ? unique[1]!.name : first.name
}

/** Candidate names read out of `text` for this slice and file type, in file order. */
function scanText(text: string, filePath: string, slice: HintSlice): Array<{ name: string; level: number }> {
  const head = text.length > HINT_TARGET_SCAN_BYTES ? text.slice(0, text.lastIndexOf('\n', HINT_TARGET_SCAN_BYTES)) : text
  const all = (re: RegExp): Array<{ name: string; level: number }> =>
    Array.from(head.matchAll(re), (m) => ({ name: m.slice(1).find((g) => g !== undefined) ?? '', level: 0 })).slice(0, HINT_TARGET_CANDIDATES)
  switch (slice) {
    case 'section': {
      if (TABLE_HEADER_PATH_RE.test(filePath)) return all(TABLE_HEADER_RE)
      const metaEnd = frontMatterEnd(head)
      return extractMarkdownHeadings(head).filter((h) => h.lineNumber > metaEnd).map((h) => ({ name: h.text, level: h.level }))
    }
    case 'table':
      return all(SQL_CREATE_RE)
    case 'key': {
      if (/\.jsonc?$/i.test(filePath)) {
        const first = JSON_FIRST_KEY_RE.exec(head)?.[1]
        return first === undefined ? [] : [{ name: first, level: 0 }]
      }
      return all(/\.ya?ml$/i.test(filePath) ? YAML_KEY_RE : ENV_KEY_RE)
    }
    case 'symbol':
      return extractQuickSymbolSamples(head, filePath, HINT_TARGET_CANDIDATES).map((name) => ({ name, level: 0 }))
  }
}

/** The 1-based line closing a YAML front matter block that opens `text`, or 0 when there is none. The heading scan, and the index built from the same scan, read the block's last `key: value` line as a setext heading over the closing `---` (README.md here indexes `permalink: /` as its first heading), so `section` runs on that name and returns two lines of metadata. */
function frontMatterEnd(text: string): number {
  if (!/^---\r?\n/.test(text)) return 0
  const close = text.split(/\r?\n/).findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line))
  return close === -1 ? 0 : close + 1
}

/** Up to HINT_TARGET_SCAN_BYTES of `resolved`, cut back to the last whole line when the file runs past it. */
function readHead(resolved: string): string {
  const fd = openSync(resolved, 'r')
  try {
    const buf = Buffer.alloc(HINT_TARGET_SCAN_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    return n < buf.length ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  } finally {
    closeSync(fd)
  }
}

/** Index-held names for this slice, in line order, or null when the index cannot vouch for the file as it is on disk (a stale name would print a command that runs and returns the wrong thing). */
function indexedCandidates(resolved: string, slice: HintSlice): Array<{ name: string; level: number }> | null {
  if (!indexMatchesDisk(resolved)) return null
  const kinds = slice === 'symbol' ? null : SLICE_KINDS[slice]
  const rows = querySymbols({ filePath: resolved, limit: HINT_TARGET_INDEX_ROWS }).filter((s) => kinds === null || kinds.has(s.kind))
  // Only a dash-underlined heading can be a front matter line, so the file is read for the block's extent only when the index holds one.
  const metaEnd = slice === 'section' && rows.some((s) => SETEXT_DASH_RE.test(s.body)) ? frontMatterEnd(readHead(resolved)) : 0
  return rows
    .filter((s) => s.lineStart > metaEnd)
    .map((s) => ({ name: s.name, level: s.kind === 'heading' ? (HEADING_LEVEL_RE.exec(s.body)?.[1]?.length ?? 0) : 0 }))
}

/** A real name for `slice` inside `filePath`, else the slice's placeholder. Looks, in order, at what the caller already holds (a heading tree, the text), then the index, then the first HINT_TARGET_SCAN_BYTES of the file. A path as written in a command (`source.cwd` set) is gated with commandPathIsTouchable before resolveIndexPath, which is itself an fs call on Windows (an 8.3 segment expands through realpathSync.native), so a UNC path is refused before anything dials it. */
export function hintTarget(filePath: string, slice: HintSlice, source: HintTargetSource = {}): HintTarget {
  const found = ((): string | null => {
    try {
      if (source.headings !== undefined && slice === 'section') {
        const metaEnd = frontMatterEnd(source.content ?? '')
        const name = pick(source.headings.filter((h) => h.lineNumber > metaEnd).map((h) => ({ name: h.text, level: h.level })), slice)
        if (name !== null) return name
      }
      if (source.content !== undefined) return pick(scanText(source.content, filePath, slice), slice)
      if (source.cwd !== undefined && !commandPathIsTouchable(filePath, source.event)) return null
      const resolved = source.cwd !== undefined ? resolveIndexPath(filePath, source.cwd) : filePath
      if (!statSync(resolved).isFile()) return null
      const indexed = indexedCandidates(resolved, slice)
      const fromIndex = indexed === null ? null : pick(indexed, slice)
      return fromIndex ?? pick(scanText(readHead(resolved), resolved, slice), slice)
    } catch {
      // A name that cannot be resolved is a reason to keep the placeholder, never to guess one.
      return null
    }
  })()
  return found === null ? { name: source.placeholder ?? HINT_PLACEHOLDERS[slice], real: false, slice } : { name: found, real: true, slice }
}

/** The token-goat command that returns `target` out of `shownPath`: `section` for a heading or TOML/INI table, the format's query command for a JSON/YAML key (config-get prints nothing for a YAML mapping, and reads a dot as nesting where the query takes `['a.b']`), config-get for any other key, `read` for a symbol or a SQL CREATE block (`section` finds no headings in a .sql file). */
export function sliceCommand(shownPath: string, target: HintTarget): string {
  switch (target.slice) {
    case 'section':
      return 'token-goat section "' + shownPath + '::' + target.name + '"'
    case 'key': {
      const fmt = /\.(jsonc?|ya?ml)$/i.exec(shownPath)?.[1]?.toLowerCase()
      if (fmt === undefined) return 'token-goat config-get "' + shownPath + '" ' + target.name
      const format = fmt.startsWith('json') ? 'json' : 'yaml'
      if (/^[\w-]+$/.test(target.name)) return 'token-goat ' + format + '-query "' + shownPath + '" "' + target.name + '"'
      if (!target.name.includes("'")) return 'token-goat ' + format + '-query "' + shownPath + '" "[\'' + target.name + '\']"'
      return 'token-goat ' + format + '-outline "' + shownPath + '"'
    }
    case 'symbol':
    case 'table':
      return 'token-goat read "' + shownPath + '::' + target.name + '"'
  }
}

/** The command a deny leads with, as leadWithCommand fenced it, or the first fenced `token-goat` command anywhere in it. */
const LED_COMMAND_RE = /`(token-goat [^`\r\n]+)`/

/** A deny this agent already received for this exact call, since the last compaction, comes back as its command and one line instead of the whole explanation again: 283 of 2,764 measured token-goat denies were a verbatim repeat, and the model that already holds the long version gains nothing from a second copy. Keyed by tool, message and compaction epoch in the per-agent session state relay.ts loads, so a repeat after a compaction (which may have dropped the first) gets the full text again. The session and agent go into the key as well: loadSessionState keeps the previous in-memory state when a session has nothing on disk yet, so a process serving a second session would otherwise read the first one's refusals as its own. */
export function sharpenRepeatedDeny(event: HookEvent, output: HookOutput): HookOutput {
  // A deny that delivers the content (DELIVERS_CONTENT_RE) is the content itself the second time too, so it is never cut down to a pointer.
  if (output.hookType !== 'deny' || !event.sessionId || DELIVERS_CONTENT_RE.test(output.message)) return output
  const key = 'deny-repeat:' + sessionStateKey(event) + ':' + (event.toolName ?? '') + ':' + getCompactedAt() + ':' + shortFingerprint(output.message)
  if (!wasHintShown(key)) {
    markHintShown(key)
    return output
  }
  const command = LED_COMMAND_RE.exec(output.message)?.[1]
  const lead = command === undefined ? '' : 'Run `' + command + '` instead. '
  return { hookType: 'deny', message: '[tg] ' + lead + 'Repeat refusal of this exact call; the earlier refusal this session has the full reason.' }
}
