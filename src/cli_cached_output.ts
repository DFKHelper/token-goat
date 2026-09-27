/** The three cached-output recall commands, `bash-output`, `web-output` and `mcp-output`, with the `--file` reader two of them share, and `_applyFiltersAndPrint`, the narrowing and provenance-fencing printer they share with `retrieve` in cli.ts and the document commands in cli_office.ts. */

import * as fs from 'node:fs'

import { getBashOutput } from './bash_output_cache.js'
import { CliError, out } from './cli.js'
import { requireNonNegativeInt } from './cli_dispatch.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { fenceUntrustedContent, UNTRUSTED_TOOL_TAG, UNTRUSTED_WEB_TAG } from './injection_scan.js'
import { queryJson } from './json_query.js'
import { displaySafeJson } from './paths.js'
import { guardJsonRows } from './read_commands.js'
import { extractTranscriptText } from './read_inspect.js'
import { compileGuardedRegex } from './regex_guard.js'
import { redactSecrets } from './secret_redact.js'
import { extractSection } from './section_reader.js'
import { clipLongMatchLine } from './tool_filters/helpers.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'
import { decodeSource, isWindows } from './util.js'
import { getWebOutput, getWebOutputRaw } from './web_cache.js'

export function _applyFiltersAndPrint(
  content: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; full?: boolean },
  fenceByProvenance = false,
  fenceTag: string = UNTRUSTED_WEB_TAG,
): string {
  // Fetched-page recall only. The injection scan is documented as unconditional for fetched pages, and a `web-output <id>` recall puts that same attacker-written text in front of the model -- but only the WebFetch post-hook fenced it, so the copy served from the cache came back bare. Scanning here rather than at store time means the fence wraps exactly what the caller sees, so a --grep/--head slice that keeps the payload is fenced and one that drops it is not. Recall of cached Bash and MCP output is scanned too, under a tag naming tool output rather than a fetched page. Neither is a page token-goat fetched, but both carry text written by a third party -- a dependency's build or test output, a remote MCP server's result -- and the recall channel put it in front of the model unmarked. The fence is decided by provenance -- `fenceByProvenance` -- and not by whether the scan matched: it used to appear only on a positive hit, which meant any payload the eight deliberately-narrow regexes miss was emitted bare. The scan now only decides whether the notice names pattern(s) and whether a stat is recorded.
  const emit = (text: string): string => {
    if (!fenceByProvenance || text === '') {
      out(text)
      return text
    }
    // fenceByProvenance true means this is third-party content (a fetched page, a recalled cache entry, a document the caller only named rather than authored), the same population the injection fence covers -- redact before fencing so a credential pasted into a PDF, a leaked token in a recalled build log, or a signed URL in a doc does not reach the model raw. Idempotent on content already redacted at write time (bash/web/mcp caches), matching the defense-in-depth pass disk_cache.ts's storeBlob already applies on top of a caller's own redaction.
    const redacted = redactSecrets(text).text
    const fenced = fenceUntrusted(redacted, fenceTag)
    out(fenced)
    return fenced
  }
  if (opts.section !== undefined) {
    const sectionResult = extractSection(content, opts.section)
    if (sectionResult === null) {
      throw new CliError(`section '${opts.section}' not found`)
    }
    content = sectionResult.content
  }

  if (opts.grep !== undefined) {
    let pattern = opts.grep
    // Normalize pattern to handle -E or --extended-regexp prefix
    if (pattern.startsWith('-E ') || pattern.startsWith('--extended-regexp ')) {
      pattern = pattern.replace(/^(?:-E\s+|--extended-regexp\s+)/, '')
    }
    // Guarded, not just compiled: a pattern that backtracks unboundedly cannot be interrupted, and this filter runs over cached command output a line at a time. A refused pattern takes the same literal-substring path an uncompilable one already takes.
    const guarded = compileGuardedRegex(pattern)
    if (guarded.ok) {
      const re = guarded.re
      content = content
        .split(/\r?\n/)
        .filter((line) => re.test(line))
        .map((line) => clipLongMatchLine(line, pattern))
        .join('\n')
    } else {
      content = content
        .split(/\r?\n/)
        .filter((line) => line.includes(pattern))
        .map((line) => clipLongMatchLine(line, pattern))
        .join('\n')
    }
  }

  if (opts.grep !== undefined && opts.maxMatches !== undefined) {
    const cap = requireNonNegativeInt('--max-matches', opts.maxMatches)
    const matched = content === '' ? [] : content.split(/\r?\n/)
    if (matched.length > cap) {
      content = [...matched.slice(0, cap), '[token-goat: showing first ' + cap + ' of ' + matched.length + ' matching lines; raise --max-matches for more]'].join('\n')
    }
  }

  const rawLines = content.split(/\r?\n/)
  // --full is the only way to get the stored blob back verbatim. The blob store itself is lossless, but every render path below elides the middle past head+tail, so without this flag an elision marker pointing a reader at `mcp-output <id>` promises a full report the CLI cannot actually produce -- which is exactly what hooks_agent_spawn.ts's envelope compaction relies on. Deliberately bypasses only the elision, not --section/--grep/--max-matches above: those are explicit narrowing the caller asked for.
  if (opts.full === true) {
    return emit(rawLines.join('\n'))
  }
  // Text that ends in a newline splits into a trailing "" that is not a line of output. Counting it made `--tail N` return N-1 real lines (`--tail 1` returned nothing at all) and made the default elision drop the last line of every long capture. `--full` above keeps the raw split so the verbatim blob is unchanged.
  const lines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  const headN = opts.head !== undefined ? requireNonNegativeInt('--head', opts.head) : 30
  const tailN = opts.tail !== undefined ? requireNonNegativeInt('--tail', opts.tail) : 80

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN + 1 ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

  /** Say on stderr how much of the body an explicit --head/--tail dropped. The two-sided paths above leave a `...(elided)...` marker in the body, so a reader can see the middle went missing. The one-sided branches left nothing at all: `web-output <id> --head 3` against a 60-line body returned three lines inside a content fence that looked exactly like a complete short document. Asking for three lines tells the caller how many they get; it does not tell them whether the body held three or sixty thousand, which is the number that decides whether to look again. stderr rather than stdout because stdout here is fenced untrusted content -- a token-goat line inside the fence would read as part of the payload it is describing. */
  const noteLineCap = (which: 'first' | 'last', flag: 'head' | 'tail', shown: number, total: number): void => {
    if (shown >= total) return
    process.stderr.write(`Showing ${which} ${shown} of ${total} lines (raise --${flag}, or --full for the whole body).\n`)
  }

  let result = lines
  if (opts.head === undefined && opts.tail === undefined) {
    // Covers both "no filters at all" and "--grep alone" -- the latter is the single most common recall pattern this CLI's own hint text pushes users toward (bash-output/web-output --grep with no --head/--tail), and left unbounded here it could return an arbitrarily large number of matching lines with no truncation at all.
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
    noteLineCap('first', 'head', result.length, lines.length)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
    noteLineCap('last', 'tail', result.length, lines.length)
  }

  return emit(result.join('\n'))
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
  opts: {
    head?: string
    tail?: string
    grep?: string
    section?: string
    file?: string
    maxMatches?: string
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
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; raw?: boolean },
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

/** Per-field variant for the `mcp-output --json-query --json` output, still gated on a scan hit. The printed form of the same query is fenced whole, by provenance; a fence wrapped around JSON is no longer JSON, and `--json` output is parsed by callers. Same deliberate exception as `fenceFileFieldIfMatched` in cli_office.ts and `fenceGithubFieldIfMatched` in read_commands.ts. */
function fenceToolFieldIfMatched(text: string): string {
  const redacted = redactSecrets(text).text
  const matches = scanAndRecord(redacted)
  if (matches.length === 0) return redacted
  return fenceUntrustedContent(redacted, matches, UNTRUSTED_TOOL_TAG)
}

/** A queried MCP value with every string in it through {@link fenceToolFieldIfMatched}, and every key redacted, which is what the whole-envelope fence this replaced did to both. A key is left unfenced, as every other `--json` envelope leaves its keys, since `displaySafeJson` escapes the fence's own notice in a key. */
function fenceJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') return fenceToolFieldIfMatched(value)
  if (Array.isArray(value)) return value.map(fenceJsonStrings)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactSecrets(k).text, fenceJsonStrings(v)]))
}

// MCP results are stored in the same bash-output blob store as `mcp_<hash>`-prefixed ids (see mcp_cache.ts's storeMcpOutput), so `token-goat bash-output <id>` already resolves one — this command exists for discoverability (the id printed in a `[token-goat: compressed, full via mcp-output <id>]` label points here) and to fail clearly on a non-MCP id rather than silently serving whatever bash-output happens to be stored under it.
export function cmdMcpOutput(
  id: string | undefined,
  opts: {
    head?: string
    tail?: string
    grep?: string
    section?: string
    maxMatches?: string
    full?: boolean
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
        out(displaySafeJson(fenceJsonStrings(val), 0))
        return
      }
      _applyFiltersAndPrint(displaySafeJson(val), printOpts, true, UNTRUSTED_TOOL_TAG)
      return
    }

    const totalCount = queryResult.items.length
    const limited = head !== undefined ? queryResult.items.slice(0, head) : queryResult.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited.map(fenceJsonStrings))
      out(displaySafeJson({ items: capped.items, truncated: capped.truncated || headTruncated || queryResult.truncated, totalCount }, 0))
    } else {
      const lines = limited.map((item) => displaySafeJson(item, 0))
      if (headTruncated) {
        lines.push(`...(${totalCount - limited.length} more items elided; use --head to see more)`)
      }
      if (queryResult.truncated) {
        lines.push(`...(the search stopped early at this tool's traversal limit; these are not necessarily all the matches. Narrow the path to search less of the document.)`)
      }
      _applyFiltersAndPrint(lines.join('\n'), printOpts, true, UNTRUSTED_TOOL_TAG)
    }
    return
  }

  _applyFiltersAndPrint(content, opts, true, UNTRUSTED_TOOL_TAG)
}
