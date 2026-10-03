/** Resolves the real name a deny or read hint's suggested command carries -- a heading, symbol, key or table the file actually holds -- so the command it leads with runs as printed, and sharpens a deny the same call already received once. Measured over 3,692 local Claude Code transcripts, the most frequent token-goat denies named a literal placeholder (`section "file::SectionHeading"`, `config-get "file" KEY_NAME`, `read "file::SymbolName"`), which exits 1 when run verbatim, and after a deny the next call was the named command only 4 times in 39 sampled. A placeholder is still the answer when nothing better is found: the claim is "this command runs", never "this is the part you wanted". */
import { openSync, readSync, closeSync, statSync } from 'node:fs'

import { resolveIndexPath, displaySafeText, hostPathOfIndexKey } from './paths.js'
import { querySymbols } from './index_reader.js'
import { indexMatchesDisk } from './index_freshness.js'
import { commandPathIsTouchable } from './vscode_path_gate.js'
import { extractMarkdownHeadings, formatHeadingTreeParts, type MarkdownHeading } from './hints/markdown_hints.js'
import { extractQuickSymbolSamples } from './hooks_read.js'
import { stripUnsafeSuggestions, leadWithCommand, grepLinesHint } from './hint_suggestion_guard.js'
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
  /** The regex or text a Grep call searched for: a symbol slice then prefers the symbol that pattern names over the file's first one. */
  readonly pattern?: string
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

/** Words a structural Grep pattern leads with, which are never the symbol it targets. */
const DECLARATION_WORDS = /^(?:def|class|function|async|export|default|interface|type|const|enum)$/

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
const SETEXT_UNDERLINE_RE = /\n[ \t]*([=-])\1*[ \t]*$/

/** The heading level a stored heading body shows: the `#` run of an ATX heading, else 1 for an `=` underline and 2 for a `-` underline. */
function headingLevel(body: string): number {
  const atx = HEADING_LEVEL_RE.exec(body)?.[1]?.length
  if (atx !== undefined) return atx
  const underline = SETEXT_UNDERLINE_RE.exec(body)?.[1]
  return underline === '=' ? 1 : underline === '-' ? 2 : 0
}

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

/** True when the character at `i` of `text` would run on into a name written next to it: a word character, or a hyphen or dollar sign joining it to another word character (`Get-Thing`, `a$b`), where a bare `$` is the regex end anchor. `step` is the direction the name would grow, so a name ending at a boundary is tested forward and one starting there backward. */
function continuesName(text: string, i: number, step: 1 | -1): boolean {
  const ch = text[i]
  if (ch === undefined) return false
  if (/\w/.test(ch)) return true
  return (ch === '-' || ch === '$') && /\w/.test(text[i + step] ?? '')
}

/** True when `name` occurs in `text` as a whole name, not as part of a longer one (`Heading 3` is not in `Heading 30`, `Get-Thing` is not in `Get-Thing3`). */
function namedIn(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (!continuesName(text, at - 1, -1) && !continuesName(text, at + name.length, 1)) return true
  }
  return false
}

/** The candidate a Grep pattern targets, or null when the pattern names none the file holds. A dotted pair both of which the file holds (`Box.open`) names the method as the pair, which `read` resolves; otherwise the longest candidate name that occurs whole in the pattern text, so a hyphenated symbol (`Get-Thing3`) or a multi-word heading (`Heading 3`) is matched as the name the file indexes rather than as the words around it. A heading that occurs twice is skipped, since `section` refuses an ambiguous one. */
function pickForPattern(candidates: ReadonlyArray<{ name: string; level: number }>, pattern: string, slice: HintSlice): string | null {
  const section = slice === 'section'
  const held = Array.from(new Set(candidates.flatMap((c) => quotable(c.name) ?? [])))
  const text = pattern.replace(/\\[A-Za-z]/g, ' ')
  if (!section) {
    const heldSet = new Set(held)
    const pair = Array.from(text.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)).find((m) => heldSet.has(m[1]!) && heldSet.has(m[2]!))
    if (pair !== undefined) return pair[1] + '.' + pair[2]
  }
  const counts = new Map<string, number>()
  for (const c of candidates) counts.set(c.name.trim(), (counts.get(c.name.trim()) ?? 0) + 1)
  const named = held.filter((name) => (section || !DECLARATION_WORDS.test(name)) && (!section || counts.get(name) === 1) && namedIn(text, name))
  return named.sort((a, b) => b.length - a.length)[0] ?? null
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

/** Up to HINT_TARGET_SCAN_BYTES of the file at host path `onDisk`, cut back to the last whole line when the file runs past it. */
function readHead(onDisk: string): string {
  const fd = openSync(onDisk, 'r')
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
function indexedCandidates(resolved: string, onDisk: string, slice: HintSlice): Array<{ name: string; level: number }> | null {
  if (!indexMatchesDisk(resolved)) return null
  const kinds = slice === 'symbol' ? null : SLICE_KINDS[slice]
  const rows = querySymbols({ filePath: resolved, limit: HINT_TARGET_INDEX_ROWS }).filter((s) => kinds === null || kinds.has(s.kind))
  // Only a dash-underlined heading can be a front matter line, so the file is read for the block's extent only when the index holds one.
  const metaEnd = slice === 'section' && rows.some((s) => SETEXT_DASH_RE.test(s.body)) ? frontMatterEnd(readHead(onDisk)) : 0
  return rows
    .filter((s) => s.lineStart > metaEnd)
    .map((s) => ({ name: s.name, level: s.kind === 'heading' ? headingLevel(s.body) : 0 }))
}

const MORE_HEADINGS_LINE_RE = /^ {2}\.\.\. \(\d+ more headings\)$/

/** formatHeadingTreeParts over a heading list the display extraction cut short: when `content` holds more H1-H3 headings than `headings`, the guidance says it shows the first N of the true total and the list ends with a count of the rest, instead of presenting the cut list as the whole file. (markdown_hints.ts is an embedding-fingerprinted source, so the true count is applied here.) */
export function headingTreeParts(headings: MarkdownHeading[], filePath: string, content: string): { guidance: string; sectionsList: string } {
  const parts = formatHeadingTreeParts(headings, filePath)
  const total = extractMarkdownHeadings(content, Number.MAX_SAFE_INTEGER).length
  if (total <= headings.length) return parts
  const guidance = parts.guidance.replace(`Large markdown file (${headings.length} headings)`, () => `Large markdown file (showing the first ${headings.length} of ${total} headings)`)
  const lines = parts.sectionsList.split('\n')
  const kept = lines.filter((l) => !MORE_HEADINGS_LINE_RE.test(l))
  return { guidance, sectionsList: [...kept, `  ... (${total - kept.length} more headings)`].join('\n') }
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
      const onDisk = hostPathOfIndexKey(resolved)
      if (!statSync(onDisk).isFile()) return null
      const indexed = indexedCandidates(resolved, onDisk, slice)
      const byPattern = (c: Array<{ name: string; level: number }>): string | null => source.pattern === undefined || (slice !== 'symbol' && slice !== 'section') ? null : pickForPattern(c, source.pattern, slice)
      const fromIndex = indexed === null ? null : byPattern(indexed) ?? pick(indexed, slice)
      if (fromIndex !== null) return fromIndex
      const scanned = scanText(readHead(onDisk), resolved, slice)
      return byPattern(scanned) ?? pick(scanned, slice)
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
      const format = structuredFormat(shownPath)
      if (format === null) return 'token-goat config-get "' + shownPath + '" ' + target.name
      if (/^[\w-]+$/.test(target.name)) return 'token-goat ' + format + '-query "' + shownPath + '" "' + target.name + '"'
      if (!target.name.includes("'")) return 'token-goat ' + format + '-query "' + shownPath + '" "[\'' + target.name + '\']"'
      return 'token-goat ' + format + '-outline "' + shownPath + '"'
    }
    case 'symbol':
    case 'table':
      return 'token-goat read "' + shownPath + '::' + target.name + '"'
  }
}

/** Lock files whose bytes are a JSON or YAML document under an extension the format commands would not infer. */
const JSON_LOCK_BASENAMES: ReadonlySet<string> = new Set(['package-lock.json', 'pipfile.lock', 'composer.lock', 'package.resolved'])
const YAML_LOCK_BASENAMES: ReadonlySet<string> = new Set(['pnpm-lock.yaml', 'pubspec.lock'])

/** The format whose `-query`/`-outline` commands read this file, by extension or by the well-known lock file name. */
function structuredFormat(shownPath: string): 'json' | 'yaml' | null {
  const base = (shownPath.split('/').pop() ?? '').toLowerCase()
  if (JSON_LOCK_BASENAMES.has(base) || /\.jsonc?$/.test(base)) return 'json'
  if (YAML_LOCK_BASENAMES.has(base) || /\.ya?ml$/.test(base)) return 'yaml'
  return null
}

/** The runnable command that reads one value out of a whole file `section` cannot slice (it finds headings only): the format's outline/query pair for JSON and YAML (lock files included), config-get for TOML/INI, xml-outline for XML, and a grep for any line format. `reason` is the sentence the hook adds after the command. */
export function fileQueryHint(shownPath: string, reason = '', grepSubject = 'pattern'): string {
  const format = structuredFormat(shownPath)
  if (format !== null) {
    return leadWithCommand('token-goat ' + format + '-outline "' + shownPath + '"', 'to list the top-level keys, then `token-goat ' + format + '-query "' + shownPath + '" "<key>"` to read one value', reason)
  }
  if (/\.(toml|ini|cfg)$/i.test(shownPath)) return leadWithCommand('token-goat config-get "' + shownPath + '" "<key>"', 'to read one value', reason)
  if (/\.(xml|csproj)$/i.test(shownPath)) return leadWithCommand('token-goat xml-outline "' + shownPath + '"', 'to see the element structure, then `token-goat xml-query "' + shownPath + '" "<path>"` to read one element', reason)
  return grepLinesHint('<' + grepSubject + '>', shownPath, reason)
}

/** The command a deny leads with, as leadWithCommand fenced it, or the first fenced `token-goat` command anywhere in it. */
const LED_COMMAND_RE = /`(token-goat [^`\r\n]+)`/

/** A deny this agent already received for this exact call, since the last compaction, comes back as its command and one line instead of the whole explanation again: 283 of 2,764 measured token-goat denies were a verbatim repeat, and the model that already holds the long version gains nothing from a second copy. Keyed by tool, tool input, message and compaction epoch (two different calls can draw the same refusal text, a webfetch.deny pattern names no URL, and only a verbatim repeat may be cut) in the per-agent session state relay.ts loads, so a repeat after a compaction (which may have dropped the first) gets the full text again. The session and agent go into the key as well: loadSessionState keeps the previous in-memory state when a session has nothing on disk yet, so a process serving a second session would otherwise read the first one's refusals as its own. */
export function sharpenRepeatedDeny(event: HookEvent, output: HookOutput): HookOutput {
  // A deny that delivers the content (DELIVERS_CONTENT_RE) is the content itself the second time too, so it is never cut down to a pointer.
  if (output.hookType !== 'deny' || !event.sessionId || DELIVERS_CONTENT_RE.test(output.message)) return output
  const key = 'deny-repeat:' + sessionStateKey(event) + ':' + (event.toolName ?? '') + ':' + getCompactedAt() + ':' + shortFingerprint(output.message) + ':' + shortFingerprint(JSON.stringify(event.toolInput))
  if (!wasHintShown(key)) {
    markHintShown(key)
    return output
  }
  const command = LED_COMMAND_RE.exec(output.message)?.[1]
  const lead = command === undefined ? '' : 'Run `' + command + '` instead. '
  return { hookType: 'deny', message: '[tg] ' + lead + 'Repeat refusal of this exact call; the earlier refusal this session has the full reason.' }
}
