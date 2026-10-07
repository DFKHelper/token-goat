/** The three cached-output recall commands, `bash-output`, `web-output` and `mcp-output`, with the `--file` reader two of them share, and `_applyFiltersAndPrint`, the narrowing and provenance-fencing printer they share with `retrieve` in cli.ts and the document commands in cli_office.ts. */

import * as fs from 'node:fs'

import { getBashOutput } from './bash_output_cache.js'
import { CliError, err, formatCommandError, out } from './cli.js'
import { requireNonNegativeInt } from './cli_dispatch.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { UNTRUSTED_TOOL_TAG, UNTRUSTED_WEB_TAG } from './injection_scan.js'
import { quotedArg } from './hint_suggestion_guard.js'
import { noMatchMessage, queryJson } from './json_query.js'
import { displaySafeJson, displaySafeText } from './paths.js'
import { guardJsonRows } from './read_commands.js'
import { headElidedNotice, traversalLimitNotice } from './query_notices.js'
import { extractTranscriptText } from './read_inspect.js'
import { compileGuardedRegex } from './regex_guard.js'
import { stripAnsiEscapes } from './render/ansi.js'
import { redactSecrets } from './secret_redact.js'
import { AMBIGUOUS_HEADING_LIMIT } from './read_section.js'
import { extractSection } from './section_reader.js'
import { clipLongMatchLine } from './tool_filters/helpers.js'
import { fenceIfScanMatched, fenceJsonStrings, fenceUntrusted } from './untrusted_fence.js'
import { countNoun, decodeSource, isWindows } from './util.js'
import { getWebOutput, getWebOutputRaw } from './web_cache.js'

/** The narrowing flags every cached-output recall command shares; the three recall-by-position flags (`--lines`, `-n`, `--context`) are optional so callers that never register them (cli_office.ts) compile unchanged. */
export interface RecallFilterOpts {
  head?: string
  tail?: string
  grep?: string
  section?: string
  maxMatches?: string
  full?: boolean
  lines?: string
  lineNumbers?: boolean
  context?: string
}

/** One printed line: `n` is its 1-based number in the text being filtered, or null for a synthetic row (an elision marker, a `--` group separator, a cap note) that has none. */
interface RecallRow {
  n: number | null
  text: string
}

/** Parse a `--lines A-B` (or single `A`) spec into a 1-based inclusive range. */
function parseLineRange(spec: string): { from: number; to: number } {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (m === null) throw new CliError(`--lines must be a line number or a range like 395-405, got: "${spec}"`)
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  if (from < 1 || to < from) throw new CliError(`--lines must start at 1 or later and not run backwards, got: "${spec}"`)
  return { from, to }
}

export function _applyFiltersAndPrint(
  content: string,
  opts: RecallFilterOpts,
  fenceByProvenance = false,
  fenceTag: string = UNTRUSTED_WEB_TAG,
): string {
  // Said on stderr after the body: a line inside the content fence is escaped as payload and reads as part of the text it describes.
  let capNotice: string | undefined
  // Fetched-page recall only. The injection scan is documented as unconditional for fetched pages, and a `web-output <id>` recall puts that same attacker-written text in front of the model -- but only the WebFetch post-hook fenced it, so the copy served from the cache came back bare. Scanning here rather than at store time means the fence wraps exactly what the caller sees, so a --grep/--head slice that keeps the payload is fenced and one that drops it is not. Recall of cached Bash and MCP output is scanned too, under a tag naming tool output rather than a fetched page. Neither is a page token-goat fetched, but both carry text written by a third party -- a dependency's build or test output, a remote MCP server's result -- and the recall channel put it in front of the model unmarked. The fence is decided by provenance -- `fenceByProvenance` -- and not by whether the scan matched: it used to appear only on a positive hit, which meant any payload the eight deliberately-narrow regexes miss was emitted bare. The scan now only decides whether the notice names pattern(s) and whether a stat is recorded.
  const emit = (text: string): string => {
    const shown = !fenceByProvenance || text === '' ? text : fenceUntrusted(text, fenceTag)
    out(shown)
    if (capNotice !== undefined) process.stderr.write(capNotice + '\n')
    return shown
  }
  // Cached output keeps its ANSI colour codes and every display path strips them for a non-colour stdout, so a --grep or --section run on the raw text missed a pattern the printed text visibly contained whenever a colour boundary fell inside it (`error TS2322` in tsc --pretty output). Strip before anything narrows the text, and before the redactor so a secret split by a colour code is still one token.
  content = stripAnsiEscapes(content)
  // fenceByProvenance true means this is third-party content (a fetched page, a recalled cache entry, a document the caller only named rather than authored), the same population the injection fence covers -- redact it before any narrowing so --grep's long-line clip can never cut a secret in half and leave a fragment the redactor no longer recognises. Idempotent on content already redacted at write time (bash/web/mcp caches).
  if (fenceByProvenance) content = redactSecrets(content, undefined, { keepLineCount: true }).text
  const render = (rows: RecallRow[]): string => rows.map((r) => (opts.lineNumbers === true && r.n !== null ? `${r.n}:${r.text}` : r.text)).join('\n')
  let firstLine = 1
  if (opts.section !== undefined) {
    const sectionResult = extractSection(content, opts.section)
    if (sectionResult === null) {
      throw new CliError(`section ${quotedArg(opts.section)} not found`)
    }
    // Said as a refusal, like `section` on a duplicated heading: printing the first match alone reads as the only one.
    if (sectionResult.occurrences !== undefined) {
      const picks = sectionResult.occurrences.slice(0, AMBIGUOUS_HEADING_LIMIT).map((line, i) => `line ${line} -> --section ${quotedArg(`${opts.section}#${i + 1}`)}`)
      const more = sectionResult.occurrences.length - AMBIGUOUS_HEADING_LIMIT
      if (more > 0) picks.push(`${more} more not shown`)
      throw new CliError(`Ambiguous heading ${quotedArg(opts.section)}: ${countNoun(sectionResult.occurrences.length, 'heading')} match. Retry with one of: ${picks.join('; ')}`)
    }
    content = sectionResult.content
    // -n numbers stay in the stored output's own coordinates, as they are without --section.
    firstLine = sectionResult.lineStart
  }

  const split = content.split(/\r?\n/)
  // Text that ends in a newline splits into a trailing "" that is not a line of the text. It is dropped here, once, on the whole text: dropping it after a --lines or --grep slice removed a real blank line that happened to end the slice. Counting it made `--tail N` return N-1 real lines and let `--grep '^$'` match a line that is not there.
  const trailingNewline = split.length > 1 && split[split.length - 1] === ''
  let rows: RecallRow[] = (trailingNewline ? split.slice(0, -1) : split).map((text, i) => ({ n: firstLine + i, text }))

  let ranged = false
  if (opts.lines !== undefined) {
    const { from, to } = parseLineRange(opts.lines)
    const total = rows.length
    // The range is in the same numbering -n prints, so after --section it counts from the stored text's first line, not the section's.
    const last = firstLine + total - 1
    if (opts.section !== undefined && (from > last || to < firstLine)) {
      throw new CliError(`--lines ${opts.lines} is outside section '${opts.section}', which covers lines ${firstLine}-${last}`)
    }
    if (from > last) throw new CliError(`--lines ${opts.lines} is past the end: the text has ${total} lines`)
    rows = rows.slice(Math.max(from, firstLine) - firstLine, Math.min(to, last) - firstLine + 1)
    ranged = true
  }

  if (opts.context !== undefined && opts.grep === undefined) {
    throw new CliError('--context needs --grep: it widens each match with the lines around it')
  }

  if (opts.grep !== undefined) {
    let pattern = opts.grep
    // Normalize pattern to handle -E or --extended-regexp prefix
    if (pattern.startsWith('-E ') || pattern.startsWith('--extended-regexp ')) {
      pattern = pattern.replace(/^(?:-E\s+|--extended-regexp\s+)/, '')
    }
    // Guarded, not just compiled: a pattern that backtracks unboundedly cannot be interrupted, and this filter runs over cached command output a line at a time. A refused pattern takes the same literal-substring path an uncompilable one already takes.
    const guarded = compileGuardedRegex(pattern)
    const matches = guarded.ok ? (line: string): boolean => guarded.re.test(line) : (line: string): boolean => line.includes(pattern)
    const hits: number[] = []
    rows.forEach((r, i) => {
      if (matches(r.text)) hits.push(i)
    })
    // Said as an error, like a --section that is not found: an empty line at exit 0 reads the same as an empty cache entry or a failed recall.
    if (hits.length === 0) throw new CliError(`--grep matched no lines of ${rows.length}: "${displaySafeText(opts.grep)}"`)
    const cap = opts.maxMatches !== undefined ? requireNonNegativeInt('--max-matches', opts.maxMatches) : undefined
    const kept = cap !== undefined && hits.length > cap ? hits.slice(0, cap) : hits
    const ctx = opts.context !== undefined ? requireNonNegativeInt('--context', opts.context) : 0
    const lastReal = rows.length - 1
    const wanted = new Set<number>()
    for (const h of kept) {
      for (let i = Math.max(0, h - ctx); i <= Math.min(lastReal, h + ctx); i++) wanted.add(i)
      wanted.add(h)
    }
    const next: RecallRow[] = []
    let previous = -1
    for (const i of [...wanted].sort((a, b) => a - b)) {
      if (ctx > 0 && previous >= 0 && i - previous > 1) next.push({ n: null, text: '--' })
      const r = rows[i]!
      next.push({ n: r.n, text: clipLongMatchLine(r.text, pattern) })
      previous = i
    }
    if (cap !== undefined && hits.length > cap) {
      capNotice = '[token-goat: showing first ' + cap + ' of ' + hits.length + ' matching lines; raise --max-matches for more]'
    }
    rows = next
  }

  // --full is the only way to get the whole stored blob back (colour codes stripped, as on every path here; `retrieve` with no flag bypasses this function for its byte-verbatim contract). The blob store itself is lossless, but every render path below elides the middle past head+tail, so without this flag an elision marker pointing a reader at `mcp-output <id>` promises a full report the CLI cannot actually produce -- which is exactly what hooks_agent_spawn.ts's envelope compaction relies on. Deliberately bypasses only the elision, not --section/--grep/--max-matches above: those are explicit narrowing the caller asked for.
  if (opts.full === true) {
    // The whole text (or --section's) keeps the final newline it ended with, so the verbatim blob is unchanged; a --lines or --grep slice is a set of lines, not the text's end.
    return emit(render(rows) + (trailingNewline && opts.lines === undefined && opts.grep === undefined ? '\n' : ''))
  }
  const lines = rows
  // An explicit --lines range is the caller asking for exactly those lines, so the default head/tail window must not cut into it.
  if (ranged && opts.head === undefined && opts.tail === undefined) {
    return emit(render(lines))
  }
  const headN = opts.head !== undefined ? requireNonNegativeInt('--head', opts.head) : 30
  const tailN = opts.tail !== undefined ? requireNonNegativeInt('--tail', opts.tail) : 80

  // The marker names the cut lines. Unfiltered text is numbered 1..N, so it can hand back the exact `--lines` that fetches them; a --grep/--section view has no such numbering to point at, so it points at --full.
  const elisionMarker = (all: RecallRow[]): RecallRow => {
    const first = headN + 1
    const last = all.length - tailN
    const hint = opts.grep === undefined && opts.section === undefined ? `--lines ${all[headN]?.n}-${all[last - 1]?.n}` : '--full'
    const of = opts.grep === undefined ? `${all.length}` : `${all.length} matching lines`
    return { n: null, text: `...(elided lines ${first}-${last} of ${of}: ${hint})...` }
  }
  const applyElision = (all: RecallRow[]): RecallRow[] => (all.length > headN + tailN + 1 ? [...all.slice(0, headN), elisionMarker(all), ...all.slice(all.length - tailN)] : all)

  /** Say on stderr how much of the body an explicit --head/--tail dropped. The two-sided paths above leave a `...(elided ...)...` marker in the body, so a reader can see the middle went missing. The one-sided branches left nothing at all: `web-output <id> --head 3` against a 60-line body returned three lines inside a content fence that looked exactly like a complete short document. Asking for three lines tells the caller how many they get; it does not tell them whether the body held three or sixty thousand, which is the number that decides whether to look again. stderr rather than stdout because stdout here is fenced untrusted content -- a token-goat line inside the fence would read as part of the payload it is describing. */
  const noteLineCap = (which: 'first' | 'last', flag: 'head' | 'tail', shown: number, total: number): void => {
    if (shown >= total) return
    process.stderr.write(`Showing ${which} ${shown} of ${total} lines (raise --${flag}, or --full for the whole body).\n`)
  }

  let result = lines
  if (opts.head === undefined && opts.tail === undefined) {
    // Covers both "no filters at all" and "--grep alone" -- the latter is the single most common recall pattern this CLI's own hint text pushes users toward (bash-output/web-output --grep with no --head/--tail), and left unbounded here it could return an arbitrarily large number of matching lines with no truncation at all.
    result = applyElision(lines)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
    noteLineCap('first', 'head', result.length, lines.length)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
    noteLineCap('last', 'tail', result.length, lines.length)
  }

  return emit(render(result))
}

/** The text of the file a `bash-output`/`mcp-output --file` recall names: a regular file only, decoded, and with a dotenv file's values redacted, since either command will print a .env it is pointed at and every other path that serves a file's text redacts them (see dotenv_redact.ts). `mtimeMs` is what `--verify-last-write` measures a write's age against. */
function readRecallFile(file: string): { text: string; mtimeMs: number } {
  if (file.includes('\0')) {
    throw new CliError('--file path contains a null byte')
  }
  if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(file) && process.stdin.isTTY) {
    throw new CliError('--file /dev/stdin requires piped input; redirect a file instead')
  }
  try {
    const st = fs.statSync(file)
    if (st.isFIFO() || st.isSocket()) {
      throw new CliError(`--file '${file}' is a special file (FIFO or socket) — only regular files are supported`)
    }
    return { text: redactIfDotenv(file, decodeSource(fs.readFileSync(file))), mtimeMs: st.mtimeMs }
  } catch (e) {
    if (e instanceof CliError) throw e
    throw new CliError((e as NodeJS.ErrnoException).code === 'ENOENT' ? `file not found: ${file}` : `cannot read file: ${file}`)
  }
}

export function cmdBashOutput(
  id: string | undefined,
  opts: RecallFilterOpts & {
    file?: string
    transcript?: boolean
    verifyLastWrite?: string | boolean
    strict?: boolean
  },
): void {
  const parseVerifyThreshold = (optVal: string | boolean | undefined): number | undefined => {
    if (optVal === undefined || optVal === false) return undefined
    if (typeof optVal === 'string' && optVal.trim() !== '' && !isNaN(Number(optVal))) {
      const parsed = Number(optVal)
      return parsed >= 0 ? parsed : 60
    }
    return 60
  }

  const verifyThresholdSec = parseVerifyThreshold(opts.verifyLastWrite)

  if (opts.file !== undefined) {
    const { text, mtimeMs } = readRecallFile(opts.file)
    if (verifyThresholdSec !== undefined) {
      const ageSec = Math.round((Date.now() - mtimeMs) / 1000)
      if (ageSec > verifyThresholdSec) {
        const msg = `stale write: '${opts.file}' was modified ${ageSec}s ago (threshold: ${verifyThresholdSec}s). Terminal command may have silently failed or no-op'd.`
        if (opts.strict === true) {
          throw new CliError(msg)
        }
        process.stderr.write(`[tg: stale-write] ${msg}\n`)
      }
    }
    _applyFiltersAndPrint(opts.transcript === true ? extractTranscriptText(text) : text, opts, true, UNTRUSTED_TOOL_TAG)
    return
  }

  if (id === undefined) {
    throw new CliError('provide an <id> or --file <path>')
  }

  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached bash output for id: ${id}. If this id is from a background task, recall its output file directly with: token-goat bash-output --file <path-to-output-file>`)
  }

  if (verifyThresholdSec !== undefined) {
    const ageSec = Math.round((Date.now() - entry.storedAt) / 1000)
    if (ageSec > verifyThresholdSec) {
      const msg = `stale write: cached output '${id}' was recorded ${ageSec}s ago (threshold: ${verifyThresholdSec}s). Terminal command may have silently failed or not re-run.`
      if (opts.strict === true) {
        throw new CliError(msg)
      }
      process.stderr.write(`[tg: stale-write] ${msg}\n`)
    }
  }

  _applyFiltersAndPrint(entry.output, opts, true, UNTRUSTED_TOOL_TAG)
}

export function cmdWebOutput(
  id: string | undefined,
  opts: RecallFilterOpts & { raw?: boolean },
): void {
  if (id === undefined) {
    throw new CliError('provide a web cache <id>')
  }
  // --raw recovers the body as actually fetched, before hooks_fetch.ts's extractCleanText cleaning pass, so a selector/script tag/embedded JSON blob lost from the default cleaned text is still recoverable without re-fetching. Falls back to the cleaned content when no separate raw copy was stored (cleaning never ran for this entry), which is already the raw body in that case.
  const content = opts.raw === true ? getWebOutputRaw(id) : getWebOutput(id)
  if (content === null) {
    throw new CliError(`no cached web output for id: ${id}. The cache may have expired; re-run the WebFetch to repopulate it.`)
  }
  _applyFiltersAndPrint(content, opts, true)
}

function extractJsonFromMcpOutput(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const cleaned = trimmed
      .replace(/^\[token-goat:[^\]]+\]\r?\n?/i, '')
      .replace(/^<untrusted-tool-output[^>]*>\r?\n?/i, '')
      .replace(/\r?\n?<\/untrusted-tool-output>$/i, '')
      .trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      const blockMatch = /```(?:json)?\r?\n([\s\S]*?)```/.exec(trimmed)
      if (blockMatch && blockMatch[1]) {
        try {
          return JSON.parse(blockMatch[1].trim())
        } catch {
          // ignore fallback
        }
      }
      throw new CliError('content is not valid JSON for --json-query')
    }
  }
}

/** Per-field variant for the `mcp-output --json-query --json` output, still gated on a scan hit. The printed form of the same query is fenced whole, by provenance; a fence wrapped around JSON is no longer JSON, and `--json` output is parsed by callers. Same deliberate exception as `fenceFileFieldIfMatched` in untrusted_fence.ts and `fenceGithubFieldIfMatched` in read_commands.ts. */
function fenceToolFieldIfMatched(text: string): string {
  return fenceIfScanMatched(redactSecrets(text).text, UNTRUSTED_TOOL_TAG)
}

// MCP results are stored in the same bash-output blob store as `mcp_<hash>`-prefixed ids (see mcp_cache.ts's storeMcpOutput), so `token-goat bash-output <id>` already resolves one — this command exists for discoverability (the id printed in a `[token-goat: compressed, full via mcp-output <id>]` label points here) and to fail clearly on a non-MCP id rather than silently serving whatever bash-output happens to be stored under it.
export function cmdMcpOutput(
  id: string | undefined,
  opts: RecallFilterOpts & {
    jsonQuery?: string
    file?: string
    json?: boolean
  },
): void {
  let content: string
  if (opts.file !== undefined) {
    content = readRecallFile(opts.file).text
  } else if (id !== undefined) {
    if (!id.startsWith('mcp_')) {
      throw new CliError(`not an mcp-output id: ${id} (expected an id starting with 'mcp_')`)
    }
    const entry = getBashOutput(id)
    if (entry === null) {
      throw new CliError(`no cached mcp output for id: ${id}. The cache may have expired; re-run the MCP tool call to repopulate it.`)
    }
    content = entry.output
  } else {
    throw new CliError('provide an mcp-output <id> or --file <path>')
  }

  if (opts.jsonQuery !== undefined) {
    const data = extractJsonFromMcpOutput(content)
    let head: number | undefined
    if (opts.head !== undefined) {
      head = requireNonNegativeInt('--head', opts.head)
    }
    const queryResult = queryJson(data, opts.jsonQuery)

    const { head: _omittedHead, ...restOpts } = opts
    const printOpts = { ...restOpts, full: true }

    if (!queryResult.fanned) {
      const val = queryResult.items[0]
      if (opts.json === true) {
        out(displaySafeJson(fenceJsonStrings(val, fenceToolFieldIfMatched), 0))
        return
      }
      _applyFiltersAndPrint(displaySafeJson(val), printOpts, true, UNTRUSTED_TOOL_TAG)
      return
    }

    const totalCount = queryResult.items.length
    // Same miss handling as json-query: exit 1 with the reason, and the empty envelope on stdout under --json.
    if (totalCount === 0 && !queryResult.truncated) {
      if (opts.json !== true) throw new CliError(noMatchMessage(opts.jsonQuery, queryResult))
      out(displaySafeJson({ items: [], truncated: false, totalCount: 0 }, 0))
      err(formatCommandError(noMatchMessage(opts.jsonQuery, queryResult)))
      process.exitCode = 1
      return
    }
    const limited = head !== undefined ? queryResult.items.slice(0, head) : queryResult.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited.map((v) => fenceJsonStrings(v, fenceToolFieldIfMatched)))
      out(displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated || queryResult.truncated, totalCount }, 0))
    } else {
      const lines = limited.map((item) => displaySafeJson(item, 0))
      if (headTruncated) {
        lines.push(headElidedNotice(totalCount - limited.length, 'item'))
      }
      if (queryResult.truncated) {
        lines.push(traversalLimitNotice(totalCount))
      }
      _applyFiltersAndPrint(lines.join('\n'), printOpts, true, UNTRUSTED_TOOL_TAG)
    }
    return
  }

  _applyFiltersAndPrint(content, opts, true, UNTRUSTED_TOOL_TAG)
}
