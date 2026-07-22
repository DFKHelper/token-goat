// Shared helper layer for the bash-output compression filter framework.
//
// This module is the DRY core every tool filter builds on: text normalisation (ANSI / progress / control-char stripping), line/byte/token capping with error-signal preservation, run-length dedupe, command-prefix resolution, and the small line-shaping utilities (head/tail collapse, repeated-prefix trimming, timestamp stripping) that recur across dozens of filters.
//
// Ported faithfully from the Python `bash_compress.py` foundation so the per-tool filters that depend on these primitives compress identically.

import { stripAnsiCodes } from '../bash_compress.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum line count produced by any filter before middle-truncation. */
export const DEFAULT_MAX_LINES = 1000
/** Maximum byte count produced by any filter (~16K tokens). Hard backstop. */
export const DEFAULT_MAX_BYTES = 64 * 1024
/** Max bytes of normalised input a filter inspects before head/tail fallback. */
export const MAX_INSPECT_BYTES = 2 * 1024 * 1024
/** Max bytes of raw input accepted before pre-normalisation truncation. */
export const DEFAULT_MAX_INPUT_BYTES = 500 * 1024
/** Per-line char cap in fallback truncation (minified JS, base64 blobs). */
export const FALLBACK_MAX_LINE_CHARS = 400

/** Effective input cap: env `TOKEN_GOAT_FILTER_MAX_BYTES` override or default. */
export function getMaxInputBytes(): number {
  const raw = process.env['TOKEN_GOAT_FILTER_MAX_BYTES']
  const v = raw ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_INPUT_BYTES
}

/** Trailing compression-summary marker appended by `CompressedOutput.withMarker`. */
export function compressionMarker(filter: string, pct: number): string {
  return `\n[token-goat: ${filter} filter -${Math.round(pct)}%; disable via TOKEN_GOAT_BASH_COMPRESS]`
}

// ---------------------------------------------------------------------------
// Shared regexes
// ---------------------------------------------------------------------------

/** Lines that signal an error/failure worth preserving through truncation. */
export const ERROR_SIGNAL_RE =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i

/** ISO-8601 / datetime / HH:MM:SS line-prefix used by CI logs and kubectl. */
export const TIMESTAMP_PREFIX_RE =
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/

/** A single token that is a shell redirect (`>`, `2>`, `>>`, `<`, `&>`, ...). */
export const REDIRECT_TOKEN_RE = /^(\d*)(>>?|<<?).*$|^&>$|^>&.*$/

/**
 * Replace the contents of single- and double-quoted spans in `cmd` with `x`
 * filler (same length, no quote/escape metacharacters preserved) so control-
 * operator detection on the raw string doesn't false-positive on a literal
 * `&`, `|`, `;`, etc. inside a quoted argument. Malformed/unterminated quotes
 * mask through to the end of the string rather than throwing.
 */
function maskQuotedSpans(cmd: string): string {
  let out = ''
  let i = 0
  const n = cmd.length
  while (i < n) {
    const ch = cmd[i]
    if (ch === '\\') {
      out += i + 1 < n ? 'xx' : 'x'
      i += 2
      continue
    }
    if (ch === "'") {
      i += 1
      const end = cmd.indexOf("'", i)
      const stop = end === -1 ? n : end
      out += 'x'.repeat(stop - i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (ch === '"') {
      i += 1
      const start = i
      while (i < n && cmd[i] !== '"') {
        i += cmd[i] === '\\' && i + 1 < n ? 2 : 1
      }
      out += 'x'.repeat(i - start)
      if (i < n) i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * True when `cmd` contains an embedded newline, or an unquoted bare `&`
 * (the background operator) that is not part of `&&`. Used to gate the
 * bash-compress single-command wrapper: a backgrounded or newline-separated
 * compound command must never be rewritten into `token-goat compress -c
 * '<cmd>'`, since `spawnSync`'s piped stdio blocks on the backgrounded
 * grandchild's inherited stdout until it exits or the wrapper times out,
 * turning a fire-and-forget dev server into a hang.
 */
export function hasBareBackgroundOrNewline(cmd: string): boolean {
  if (cmd.includes('\n') || cmd.includes('\r')) return true
  const masked = maskQuotedSpans(cmd)
  return /(?<!&)&(?!&)/.test(masked)
}

const BYTES_ELIDED_MARKER_RE = /\n\.\.\. \[\d+ bytes elided by token-goat\]$/
const DIGITS_RE = /\d+/g
// C0/C1 control chars except tab (09), newline (0A), carriage return (0D).
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

// ---------------------------------------------------------------------------
// Byte helpers (UTF-8, matching Python's .encode('utf-8'))
// ---------------------------------------------------------------------------

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

// ---------------------------------------------------------------------------
// Encoding + normalisation
// ---------------------------------------------------------------------------

/** Strip null bytes so they never break regex matchers or line splitters. */
export function safeDecode(text: string): string {
  return text.indexOf('\x00') === -1 ? text : text.split('\x00').join('')
}

/** Remove non-printable C0/C1 control chars, preserving tab/newline. */
export function sanitizeControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_RE, '')
}

/**
 * Collapse `\r`-overwrite progress lines to their final rendered state.
 * Keeps only the segment after the last `\r` within each line. A line whose
 * only `\r` is its own trailing character (e.g. curl on Windows emits `\r\n`
 * per verbose line, and the preceding CRLF→LF pass only ever consumes one
 * `\r` of a `\r\r\n` run, leaving a lone trailing `\r`) is real content with
 * leftover line-ending debris, not a terminal overwrite — strip that single
 * trailing `\r` first so it isn't mistaken for an overwrite marker that wipes
 * the whole line to empty.
 */
export function stripProgress(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      return trimmed.includes('\r') ? trimmed.slice(trimmed.lastIndexOf('\r') + 1) : trimmed
    })
    .join('\n')
}

/**
 * Universal pre-filter pipeline: CRLF→LF, progress collapse, ANSI strip,
 * control-char sanitise. Idempotent. Every filter runs its input through this
 * before per-tool logic.
 */
export function normalise(text: string, opts: { skipProgress?: boolean } = {}): string {
  if (!text) return ''
  let t = text.replace(/\r\n/g, '\n')
  if (!opts.skipProgress) t = stripProgress(t)
  t = stripAnsiCodes(t)
  return sanitizeControlChars(t)
}

// ---------------------------------------------------------------------------
// High-entropy token detection (UUID / SHA / JWT / API key)
// ---------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/i
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/

/**
 * Heuristic: does the line carry a high-entropy token (UUID, 32+ hex run, JWT,
 * or a long mixed-class base64/alnum secret)? Such lines are emitted verbatim
 * by `dedupeConsecutive(entropyBypass)` so unique IDs are never collapsed.
 */
export function hasHighEntropyToken(line: string): boolean {
  if (UUID_RE.test(line) || LONG_HEX_RE.test(line) || JWT_RE.test(line)) return true
  // Long token mixing upper, lower, and digits — base64-ish secrets/keys.
  for (const tok of line.split(/[\s"'`,;:()[\]{}<>]+/)) {
    if (tok.length < 24) continue
    if (/[a-z]/.test(tok) && /[A-Z]/.test(tok) && /[0-9]/.test(tok) && /^[A-Za-z0-9+/=_-]+$/.test(tok)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Run-length dedupe
// ---------------------------------------------------------------------------

/**
 * Collapse runs of identical consecutive lines to `line  (×N)`. Runs shorter
 * than `minRun` are emitted verbatim (never adds spurious `(×1)`). With
 * `entropyBypass`, lines carrying high-entropy tokens are always emitted intact.
 */
export function dedupeConsecutive(
  lines: Iterable<string>,
  opts: { minRun?: number; fmt?: (line: string, count: number) => string; entropyBypass?: boolean } = {},
): string[] {
  const minRun = opts.minRun ?? 2
  const fmt = opts.fmt ?? ((line: string, count: number) => `${line}  (×${count})`)
  const entropyBypass = opts.entropyBypass ?? false
  const out: string[] = []
  let prev: string | null = null
  let count = 0
  const flush = (): void => {
    if (prev === null) return
    if (count >= minRun) out.push(fmt(prev, count))
    else for (let i = 0; i < count; i++) out.push(prev)
  }
  for (const line of lines) {
    if (entropyBypass && hasHighEntropyToken(line)) {
      flush()
      prev = null
      count = 0
      out.push(line)
      continue
    }
    if (line === prev) {
      count += 1
      continue
    }
    flush()
    prev = line
    count = 1
  }
  flush()
  return out
}

/**
 * Collapse runs of lines that are identical after normalising digit runs to a
 * placeholder — e.g. repeated diff line numbers or per-item counters that
 * differ only in their numeric component.
 */
export function dedupeNumericRuns(
  lines: Iterable<string>,
  opts: { minRun?: number } = {},
): string[] {
  const minRun = opts.minRun ?? 2
  const arr = Array.from(lines)
  const out: string[] = []
  let i = 0
  while (i < arr.length) {
    const key = arr[i]!.replace(DIGITS_RE, '#')
    let j = i + 1
    while (j < arr.length && arr[j]!.replace(DIGITS_RE, '#') === key) j += 1
    const run = j - i
    if (run >= minRun) {
      out.push(arr[i]!)
      out.push(`... [${run - 1} similar lines collapsed by token-goat]`)
    } else {
      for (let k = i; k < j; k++) out.push(arr[k]!)
    }
    i = j
  }
  return out
}

// ---------------------------------------------------------------------------
// Line / byte / token capping
// ---------------------------------------------------------------------------

/**
 * Cap `lines` at `maxLines` by keeping head + tail with an omission marker.
 * Favours the tail (where summaries/failures live) via `headRatio`. The marker
 * is one extra line, so output length is `maxLines + 1` by design.
 */
export function truncateMiddle(
  lines: string[],
  maxLines: number,
  opts: { headRatio?: number; markerFmt?: (n: number) => string } = {},
): string[] {
  if (lines.length <= maxLines) return lines
  const headRatio = opts.headRatio ?? 0.4
  const markerFmt = opts.markerFmt ?? ((n: number) => `... [${n} lines elided by token-goat]`)
  const headKeep = Math.max(1, Math.floor(maxLines * headRatio))
  const tailKeep = Math.max(1, maxLines - headKeep)
  const elided = lines.length - headKeep - tailKeep
  return [...lines.slice(0, headKeep), markerFmt(elided), ...lines.slice(lines.length - tailKeep)]
}

/**
 * Cap `lines` at `maxLines` while preserving error-signal lines from the
 * middle (a stack trace after 200 progress lines must survive). Falls back to
 * `truncateMiddle` when no error signals are present.
 */
export function truncateMiddleSmart(
  lines: string[],
  maxLines: number,
  opts: {
    headKeep?: number
    tailKeep?: number
    errorContext?: number
    maxErrorLines?: number
    markerFmt?: (n: number) => string
  } = {},
): string[] {
  if (lines.length <= maxLines) return lines
  const headKeep = opts.headKeep ?? 10
  const tailKeep = opts.tailKeep ?? 10
  const errorContext = opts.errorContext ?? 2
  const maxErrorLines = opts.maxErrorLines ?? 10
  const markerFmt = opts.markerFmt ?? ((n: number) => `--- ${n} lines omitted ---`)

  const errorIndices: number[] = []
  for (let i = 0; i < lines.length; i++) if (ERROR_SIGNAL_RE.test(lines[i]!)) errorIndices.push(i)
  if (errorIndices.length === 0) return truncateMiddle(lines, maxLines, { markerFmt })

  const total = lines.length
  const effHead = Math.min(headKeep, Math.floor(total / 4))
  const effTail = Math.min(tailKeep, Math.floor(total / 4))

  const middle = new Set<number>()
  for (let k = 0; k < errorIndices.length && k < maxErrorLines; k++) {
    const ei = errorIndices[k]!
    for (let ci = Math.max(0, ei - errorContext); ci < Math.min(total, ei + errorContext + 1); ci++) {
      middle.add(ci)
    }
  }
  for (let i = 0; i < effHead; i++) middle.delete(i)
  for (let i = total - effTail; i < total; i++) middle.delete(i)

  const budgetForMiddle = Math.max(0, maxLines - effHead - effTail)
  let sortedMiddle = Array.from(middle).sort((a, b) => a - b)
  if (sortedMiddle.length > budgetForMiddle) sortedMiddle = sortedMiddle.slice(0, budgetForMiddle)

  const result: string[] = []
  const appendSection = (indices: number[]): void => {
    for (let pos = 0; pos < indices.length; pos++) {
      const idx = indices[pos]!
      if (pos > 0) {
        const prevIdx = indices[pos - 1]!
        if (idx !== prevIdx + 1) result.push(markerFmt(idx - prevIdx - 1))
      }
      result.push(lines[idx]!)
    }
  }

  const headList = Array.from({ length: effHead }, (_, i) => i)
  const tailList = Array.from({ length: effTail }, (_, i) => total - effTail + i)
  appendSection(headList)
  if (sortedMiddle.length) {
    const gapAfterHead = sortedMiddle[0]! - (headList.length ? headList[headList.length - 1]! : -1) - 1
    if (gapAfterHead > 0) result.push(markerFmt(gapAfterHead))
    appendSection(sortedMiddle)
  }
  if (tailList.length) {
    const lastKept = sortedMiddle.length
      ? sortedMiddle[sortedMiddle.length - 1]!
      : headList.length
        ? headList[headList.length - 1]!
        : -1
    const gapBeforeTail = tailList[0]! - lastKept - 1
    if (gapBeforeTail > 0) result.push(markerFmt(gapBeforeTail))
    appendSection(tailList)
  }
  return result
}

/**
 * Truncate `text` to `maxBytes` UTF-8 bytes, cutting at a line boundary when
 * one exists in budget and never splitting a multibyte code point. Appends a
 * bytes-elided marker.
 */
export function capBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= maxBytes) return text
  const marker = `\n... [${encoded.length - maxBytes} bytes elided by token-goat]`
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8')
  if (budget <= 0) return marker.trim()
  let slice = encoded.subarray(0, budget)
  const nl = slice.lastIndexOf(0x0a)
  if (nl > budget / 2) slice = slice.subarray(0, nl)
  // Never cut inside a multi-byte UTF-8 sequence: if the byte immediately
  // after the slice is a continuation byte (10xxxxxx), the cut landed
  // mid-character, so back up until it doesn't.
  while (slice.length > 0 && (encoded[slice.length]! & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1)
  }
  return slice.toString('utf8') + marker
}

/**
 * Truncate `text` to approximately `maxTokens` tokens, measured on the
 * ANSI-stripped string so escape sequences don't trip the cap early.
 */
export function capTokens(text: string, maxTokens: number): string {
  const clean = stripAnsiCodes(text)
  if (clean.length / 3.5 <= maxTokens) return text
  const maxBytes = Math.floor(maxTokens * 3.5)
  let truncated = capBytes(clean, maxBytes)
  if (!truncated.includes('[token-goat: output capped at')) {
    truncated = truncated.replace(BYTES_ELIDED_MARKER_RE, '')
    truncated += `\n[token-goat: output capped at ~${maxTokens} tokens]`
  }
  return truncated
}

// ---------------------------------------------------------------------------
// Line-shaping utilities shared across filters
// ---------------------------------------------------------------------------

/**
 * Head lines + count marker + tail lines when `lines` exceeds `head + tail`;
 * otherwise the lines joined unchanged.
 */
export function headTailCompress(lines: string[], head: number, tail: number, label = 'items'): string {
  const total = lines.length
  if (total <= head + tail) return lines.join('\n')
  const elided = total - head - tail
  return [...lines.slice(0, head), `... [${elided} more ${label} elided by token-goat]`, ...lines.slice(total - tail)].join(
    '\n',
  )
}

/** Keep only the first `keep` lines matching `pattern`; drop the rest with a count. */
export function trimRepeatedPrefix(lines: string[], pattern: RegExp, keep: number): string[] {
  const out: string[] = []
  let matched = 0
  let dropped = 0
  for (const line of lines) {
    if (pattern.test(line)) {
      matched += 1
      if (matched <= keep) out.push(line)
      else dropped += 1
    } else {
      out.push(line)
    }
  }
  if (dropped) out.push(`[token-goat: +${dropped} more lines matching ${pattern.source}]`)
  return out
}

/** Strip common ISO-8601 / datetime / HH:MM:SS timestamp prefixes from each line. */
export function stripTimestamps(lines: string[]): string[] {
  return lines.map((ln) => ln.replace(TIMESTAMP_PREFIX_RE, ''))
}

/**
 * Split `text` into blocks demarcated by lines matching `blockRe` (the match is
 * the first line of each block). Leading content before the first match is the
 * first block.
 */
export function splitBlocks(text: string, blockRe: RegExp): string[] {
  const blocks: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (blockRe.test(line)) {
      if (current.length) blocks.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) blocks.push(current.join('\n'))
  return blocks
}

/** Append `msg` to `notes` when `value` is truthy. */
export function maybeNote(notes: string[], value: unknown, msg: string): void {
  if (value) notes.push(msg)
}

/** Collapse 3+ consecutive blank lines to a single blank line. */
export function squeezeBlankLines(text: string): string {
  return text.replace(/\n\s*\n\s*\n+/g, '\n\n')
}

/**
 * Combined output when a command failed (non-zero exit) and produced stderr;
 * `null` otherwise (signalling the caller to continue normal compression).
 */
export function preserveStderrOnError(stdout: string, stderr: string, exitCode: number): string | null {
  if (exitCode !== 0 && stderr.trim()) {
    return stdout.trim() ? `${stdout.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}` : stderr
  }
  return null
}

// ---------------------------------------------------------------------------
// Command prefix stripping + argv parsing
// ---------------------------------------------------------------------------

const PASSTHROUGH_PREFIXES = new Set([
  'sudo', 'doas', 'time', 'nice', 'ionice', 'nohup', 'exec', 'env', 'stdbuf', 'unbuffer', 'script',
])

const TWO_TOKEN_PREFIXES: Record<string, ReadonlySet<string>> = {
  python: new Set(['-m']),
  python3: new Set(['-m']),
  py: new Set(['-m']),
  // `tool` is deliberately absent: `uv tool install/upgrade/uninstall/update <bin>`
  // produces uv's own package-management output (handled by UvFilter.matches()'s
  // own `tool` branch on the unstripped argv) -- it must not be consumed here.
  // `uv tool run <bin>` is the one `tool` subcommand that really does execute
  // `<bin>` and stream its output; it gets a dedicated 3-token strip below.
  uv: new Set(['run']),
  uvx: new Set(),
  poetry: new Set(['run']),
  rye: new Set(['run']),
  pdm: new Set(['run']),
  pipenv: new Set(['run']),
  npx: new Set(),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bundle: new Set(['exec']),
  hatch: new Set(['run']),
  // `tox` is deliberately absent: `tox -e py312`'s `-e py312` is an environment
  // selector, not a launcher token, so argv[2] (`py312`) is never a real binary.
  // ToxFilter matches on the unstripped `tox` stem directly (see misc.ts).
}

/** Return the final path segment (basename), normalising backslashes. */
export function pathName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** Path stem: basename with its last extension removed (`py.test` → `py`). */
export function pathStem(p: string): string {
  const name = pathName(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Positional arguments only (drop `-x` / `--xyz` flags). */
export function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'))
}

// `-i` is deliberately absent: for the passthrough wrappers this set gates
// (sudo, env, ...), `-i` takes no value (`sudo -i`, `env -i`), so treating
// it as value-taking would consume the real binary token as its "value".
const SHORT_FLAGS_WITH_VALUE = new Set(['-n', '-c', '-u', '-e'])

/**
 * Strip pass-through wrappers (sudo/env/nice/...) and resolve multi-token
 * launchers (`python -m pytest`, `uv run pytest`, `npx jest`) to the real
 * binary. Returns a new argv whose first element is the resolved binary.
 */
export function stripPrefixes(argv: string[]): string[] {
  if (argv.length === 0) return []
  let out = [...argv]
  // Strip leading env assignments and pass-through prefixes to a fixpoint:
  // each can reveal more of the other (e.g. `env FOO=bar cmd` has an
  // assignment after the wrapper, `FOO=bar sudo cmd` has a wrapper after
  // the assignment), so alternate both passes until neither strips anything.
  for (;;) {
    const before = out.length
    // Strip leading env assignments (FOO=bar BAZ=qux cmd ...).
    while (out.length && out[0]!.includes('=') && !out[0]!.startsWith('-')) {
      const head = out[0]!.split('=', 1)[0]!
      if (head && (/[A-Za-z]/.test(head[0]!) || head[0] === '_') && /^[A-Za-z0-9_]+$/.test(head)) out.shift()
      else break
    }
    // Strip pass-through prefixes plus their short flags.
    while (out.length) {
      if (!PASSTHROUGH_PREFIXES.has(pathStem(out[0]!).toLowerCase())) break
      out.shift()
      while (out.length && out[0]!.startsWith('-')) {
        const flag = out.shift() as string
        if (SHORT_FLAGS_WITH_VALUE.has(flag) && out.length) out.shift()
      }
    }
    if (out.length === before) break
  }
  if (out.length === 0) return out
  // `uv tool run <bin>` (the long form of `uvx <bin>`) really does execute
  // <bin> and stream its output — the real binary sits one token further out
  // than `uv run <bin>`, so it needs its own 3-token strip rather than the
  // generic two-token launcher table below (which deliberately excludes
  // `tool`; see TWO_TOKEN_PREFIXES).
  if (pathStem(out[0]!).toLowerCase() === 'uv' && out[1] === 'tool' && out[2] === 'run' && out.length > 3) {
    return out.slice(3)
  }
  // Resolve two-token launchers (python -m pytest → pytest).
  const stem = pathStem(out[0]!).toLowerCase()
  const triggers = TWO_TOKEN_PREFIXES[stem]
  if (triggers !== undefined && out.length >= 2) {
    const nextTok = out[1]!
    if (triggers.size === 0 || triggers.has(nextTok)) {
      const consume = triggers.size === 0 ? 1 : 2
      if (out.length > consume) out = out.slice(consume)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Minimal POSIX-ish shlex split (for command detection)
// ---------------------------------------------------------------------------

/**
 * Split a command line into tokens, honouring single quotes, double quotes,
 * and backslash escapes — enough for dispatch (binary + subcommand detection).
 * Throws on an unterminated quote, matching Python's `shlex.split`.
 */
export function shlexSplit(cmd: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let i = 0
  const n = cmd.length
  while (i < n) {
    const ch = cmd[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) {
        tokens.push(cur)
        cur = ''
        has = false
      }
      i += 1
      continue
    }
    has = true
    if (ch === '\\') {
      if (i + 1 < n) {
        cur += cmd[i + 1]
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (ch === "'") {
      i += 1
      const end = cmd.indexOf("'", i)
      if (end === -1) throw new Error('No closing quotation')
      cur += cmd.slice(i, end)
      i = end + 1
      continue
    }
    if (ch === '"') {
      i += 1
      let buf = ''
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < n && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
          buf += cmd[i + 1]
          i += 2
        } else {
          buf += cmd[i]
          i += 1
        }
      }
      if (i >= n) throw new Error('No closing quotation')
      cur += buf
      i += 1
      continue
    }
    cur += ch
    i += 1
  }
  if (has) tokens.push(cur)
  return tokens
}

// ---------------------------------------------------------------------------
// Fallback compression pipelines (shared by apply() and structural filters)
// ---------------------------------------------------------------------------

/** Truncate individual lines exceeding `maxChars` with an inline marker. */
export function capLongLines(lines: string[], maxChars = FALLBACK_MAX_LINE_CHARS): string[] {
  return lines.map((line) => {
    if (line.length <= maxChars) return line
    let cut = maxChars
    // Never split a surrogate pair: `maxChars` counts UTF-16 code units, so a
    // cut landing between a high surrogate and its low surrogate (e.g. inside
    // an emoji) leaves a lone surrogate that serializes as U+FFFD on UTF-8
    // output. Back off by one code unit so the pair stays whole.
    const high = line.charCodeAt(cut - 1)
    const low = line.charCodeAt(cut)
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut -= 1
    return `${line.slice(0, cut)}  … [${line.length - cut} chars elided]`
  })
}

/** Head/tail-truncated dump used when a filter cannot run (over budget / raised). */
export function fallbackTruncate(stdout: string, stderr: string, maxLines: number): string {
  const half = Math.floor(maxLines / 2)
  const outLines = truncateMiddle(capLongLines(dedupeConsecutive(stdout.split('\n'))), half)
  const errLines = truncateMiddle(capLongLines(dedupeConsecutive(stderr.split('\n'))), half)
  if (stderr) return `${outLines.join('\n')}\n---\n${errLines.join('\n')}`
  return outLines.join('\n')
}

/** Dedupe consecutive lines in each stream when normalisation alone sufficed. */
export function compressBashOutput(stdout: string, stderr: string): string {
  let body = dedupeConsecutive(stdout.split('\n'), { entropyBypass: true }).join('\n')
  if (stderr.trim()) {
    const err = dedupeConsecutive(stderr.split('\n'), { entropyBypass: true }).join('\n')
    body = `${body.replace(/\s+$/, '')}\n---\n${err.replace(/\s+$/, '')}`
  }
  return body
}

/** Dedupe + squeeze blank lines on combined text (git/cargo/ruby fallback). */
export function dedupeCombinedOutput(text: string): string {
  return squeezeBlankLines(dedupeConsecutive(text.split('\n')).join('\n'))
}

/** Numeric-run dedupe + middle truncation for structured test/diff output. */
export function compressTestOutput(lines: string[], maxLines = 300): string {
  const deduped = dedupeNumericRuns(lines, { minRun: 5 })
  return truncateMiddle(deduped, maxLines).join('\n')
}

/** UTF-8 byte length of a string (matches Python `len(s.encode('utf-8'))`). */
export function byteLength(s: string): number {
  return utf8Len(s)
}
