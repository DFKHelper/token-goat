/**
 * Text-processing and session/index/config CLI commands (Family C2).
 *
 * Commands: todo, trace, logfold, lockdeps (pure text), note, hot, recent, ignores
 * (session/index/config integration).
 */

import * as fs from 'fs'
import * as path from 'path'

import { load as loadYaml } from 'js-yaml'

import { SKIP_DIRS, walkProject } from './baseline.js'
import { loadConfig } from './config.js'
import { tokenGoatHome } from './disk_cache.js'
import { FILTERS } from './filters.js'
import { ALL_SYMBOLS_IN_FILE_LIMIT, enclosingSymbol } from './graph_commands.js'
import { querySymbols } from './index_reader.js'
import { normalizeDarwinSystemAlias, resolveIndexPath, toDisplayPath } from './paths.js'
import { canonicalize, findProject, getDisplayRoot } from './project.js'
import { clearAll, loadEntries, setEntry, unsetEntry } from './project_memory.js'
import { resolveBody } from './read_commands.js'
import { getSessionFiles } from './session.js'
import { foldPath, escapeRegExp, requireNonNegativeStrictInt, suggestPackageNames } from './util.js'
import { detectWalkMode } from './walk_mode.js'

// ── Shared utilities ────────────────────────────────────────────────────────

function readInput(src: string | undefined): string {
  if (src !== undefined) return fs.readFileSync(src, 'utf8')
  return fs.readFileSync(0, 'utf8')
}

// Mirrors cli.ts's/read_commands.ts's requireNonNegativeInt (same regex-only-integer
// validation plus a sign check) so hot/recent/trace/logfold's row/frame/line limits get the
// same error behavior as every other --limit-style flag: a clean thrown error on a non-numeric
// or negative value instead of `Number.parseInt` silently producing NaN or a negative count,
// both of which fail the `> 0` guards these commands used to gate their `.slice()` calls with
// and so fell through to printing every entry unbounded instead of erroring or limiting.
/** Split text into lines, normalizing CRLF. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

// ── todo ────────────────────────────────────────────────────────────────────

const DEFAULT_KINDS = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE']

/** Marker + trailing text captured from a single line. */
interface TodoItem {
  file: string
  line: number
  kind: string
  text: string
}

// Counts quote chars in `text` that are NOT escaped, tracking a running per-char backslash-parity counter rather than a fixed-width regex lookbehind: `(?<!\\)"` only inspects the single char before each quote, so an escaped-backslash-then-quote sequence like `path\\"` (backslash pair, then a real closing quote) undercounts -- it sees the quote preceded by one backslash and treats it as escaped, even though the pair of backslashes means the quote is not actually escaped (even backslash count).
function countUnescapedQuotes(text: string, quoteChar: string): number {
  let count = 0
  let backslashes = 0
  for (const ch of text) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === quoteChar && backslashes % 2 === 0) count++
    backslashes = 0
  }
  return count
}

/**
 * Returns true when markerIndex falls inside an opening double-quoted string literal on the
 * line. Only double quotes are checked - a single quote in a comment or prose line (where TODO
 * markers overwhelmingly live) is almost always an apostrophe (a contraction or possessive), not
 * a string delimiter, so gating on single-quote parity too would flip to "inside a string" on
 * ordinary text like "can't stop now, TODO: fix the parser" and silently drop the marker.
 */
function isInsideStringLiteral(line: string, markerIndex: number): boolean {
  const before = line.slice(0, markerIndex)
  const dqCount = countUnescapedQuotes(before, '"')
  return dqCount % 2 !== 0
}

/**
 * Whether an occurrence of a marker word is actually a marker rather than ordinary prose.
 *
 * The match is case-insensitive because `// todo: fix` is as real a marker as `// TODO: fix`, but
 * "NOTE" and "HACK" are also ordinary English words, and matching them in any case turned every
 * sentence containing "a note for this" or "note that" into a reported marker. On this repo that
 * was 681 of 800 hits, nearly all of them changelog prose, which buries the real markers this
 * command exists to surface. Case alone is not enough either (lowercase `note:` in a comment is a
 * genuine annotation) and the colon alone is not enough (`// TODO fix this` carries none), so a
 * marker is one or the other: written in upper case, or carrying the colon that marks it as a
 * label rather than a word in a sentence.
 */
function isMarkerOccurrence(matched: string, hasColon: boolean): boolean {
  return hasColon || matched === matched.toUpperCase()
}

function scanFileForTodos(filePath: string, kindSet: Set<string>): TodoItem[] {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  // --kinds is documented as a literal, comma-separated list of marker names (TODO, FIXME, ...),
  // not a regex pattern -- escape each value before interpolating so a kind containing
  // regex-special characters (e.g. an unbalanced paren) is matched literally instead of either
  // throwing "Invalid regular expression" or being interpreted as regex syntax.
  const kindPattern = [...kindSet].map(escapeRegExp).join('|')
  // Trailing \b after the kind name prevents a marker from matching as a prefix of a longer
  // identifier/word (e.g. "NOTEBOOK", "TODOLIST", "HACKATHON") -- without it, \s*:?\s* all
  // matches zero-width and the rest of the word gets swallowed into the captured text.
  // The colon is captured rather than skipped because it is half the test for whether a match is
  // a marker at all -- see the isMarkerOccurrence check below.
  const re = new RegExp(`\\b(${kindPattern})\\b(\\s*:)?\\s*(.*)`, 'i')
  const items: TodoItem[] = []
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = re.exec(line)
    if (m === null) continue
    if (!isMarkerOccurrence(m[1] ?? '', m[2] !== undefined)) continue
    const idx = m.index ?? 0
    if (isInsideStringLiteral(line, idx)) continue
    items.push({ file: filePath, line: i + 1, kind: m[1]?.toUpperCase() ?? '', text: (m[3] ?? '').trim() })
  }
  return items
}

function collectTodoFiles(patterns: string[]): string[] {
  if (patterns.length > 0) {
    const results: string[] = []
    for (const p of patterns) {
      const abs = path.resolve(p)
      try {
        const stat = fs.statSync(abs)
        if (stat.isDirectory()) {
          results.push(...walkProject(abs).files)
        } else {
          results.push(abs)
        }
      } catch {
        // skip non-existent paths
      }
    }
    return results
  }
  return walkProject(process.cwd()).files
}

export function cmdTodo(
  patterns: string[],
  opts: { group?: string; kinds?: string; json?: boolean },
): void {
  const kindSet = new Set<string>(
    opts.kinds !== undefined && opts.kinds.length > 0
      ? opts.kinds.split(',').map((k) => k.trim().toUpperCase())
      : DEFAULT_KINDS,
  )
  const files = collectTodoFiles(patterns)
  const items: TodoItem[] = []
  for (const f of files) {
    items.push(...scanFileForTodos(f, kindSet))
  }

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ items }, null, 2) + '\n')
    return
  }

  if (items.length === 0) {
    process.stdout.write('No TODO markers found.\n')
    return
  }

  const groupBy = opts.group ?? 'file'
  if (groupBy === 'kind') {
    const byKind = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byKind.get(item.kind) ?? []
      arr.push(item)
      byKind.set(item.kind, arr)
    }
    for (const [kind, group] of byKind) {
      process.stdout.write(`\n[${kind}]\n`)
      for (const item of group) {
        process.stdout.write(`  ${item.file}:${item.line}  ${item.text}\n`)
      }
    }
  } else {
    const byFile = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byFile.get(item.file) ?? []
      arr.push(item)
      byFile.set(item.file, arr)
    }
    for (const [file, group] of byFile) {
      for (const item of group) {
        process.stdout.write(`${file}:${item.line}  ${item.kind}  ${item.text}\n`)
      }
    }
  }
}

// ── trace ───────────────────────────────────────────────────────────────────

interface TraceFrame {
  file: string
  lineNo: number
  func: string
  context?: string
}

interface TraceBlock {
  frames: TraceFrame[]
  exception: string
}

/**
 * Result of attempting to parse one grammar's block starting at `nextIndex`'s line.
 * `block` is `null` when the grammar's marker matched but nothing should be emitted (Python's
 * zero-frame block immediately superseded by another "Traceback (...)" header) -- the caller
 * still must resume scanning from `nextIndex`, not push anything, and not re-consume the line
 * that ended the (empty) block.
 */
interface TraceParseResult {
  block: TraceBlock | null
  nextIndex: number
}

/**
 * Parses one Python `Traceback (most recent call last):` block starting at `lines[start]`.
 * Returns `null` when `lines[start]` isn't a Python traceback header at all (so the dispatcher
 * can fall through to the other grammars) -- this is the pre-existing Python-only parser,
 * extracted unchanged from the old single-grammar `parseTracebacks` body.
 */
function parsePythonBlock(lines: string[], start: number): TraceParseResult | null {
  if (!/^Traceback \(most recent call last\):/.test(lines[start] ?? '')) return null
  let i = start + 1
  const frames: TraceFrame[] = []
  let block: TraceBlock | null = null
  while (i < lines.length) {
    const fl = lines[i] ?? ''
    const fm = /^\s{2}File "([^"]+)", line (\d+), in (\S+)/.exec(fl)
    if (fm !== null) {
      i++
      const peek = lines[i]?.trim()
      // A frame with no printed source line is immediately followed by the next frame's
      // "File ..." header (or the block's Traceback marker) rather than a context line --
      // in that case leave this frame's context empty instead of consuming/borrowing the
      // next frame's header text.
      const hasContext = peek !== undefined && !peek.startsWith('File ') && !peek.startsWith('Traceback')
      if (hasContext) i++
      frames.push({ file: fm[1] ?? '', lineNo: Number.parseInt(fm[2] ?? '0', 10), func: fm[3] ?? '', context: hasContext ? (peek ?? '') : '' })
      continue
    }
    // A "Traceback (most recent call last):" line reached while scanning for this block's
    // exception text marks the start of the NEXT traceback, not this block's exception --
    // hand control back to the dispatcher (without consuming the line) instead of swallowing
    // it as exception text, or a zero-frame block adjacent to a real traceback silently
    // discards the real one.
    if (/^Traceback \(most recent call last\):/.test(fl)) {
      break
    }
    if (!/^\s/.test(fl) && fl.trim() !== '') {
      block = { frames, exception: fl.trim() }
      i++
      break
    }
    i++
  }
  // Scoped to THIS block, not the global blocks array: a later traceback whose frames run to
  // EOF with no exception line must still be flushed even though an earlier block already pushed.
  if (frames.length > 0 && block === null) {
    block = { frames, exception: '' }
  }
  return { block, nextIndex: i }
}

const NODE_FRAME_WITH_FUNC_RE = /^\s+at\s+(.+?)\s+\(([^)]+)\)\s*$/
const NODE_FRAME_ANON_RE = /^\s+at\s+([^\s()][^()]*)\s*$/
const NODE_LOC_RE = /^(.*):(\d+):(\d+)$/

/**
 * Parses one Node/V8 stack-trace frame line, either the named form
 * `at functionName (/path/to/file.js:12:34)` or the anonymous form
 * `at /path/to/file.js:12:34` (no function name, no parens). `col` is discarded --
 * TraceFrame has no column field, matching Python's file+line-only shape.
 */
function parseNodeFrameLine(line: string): TraceFrame | null {
  const withFunc = NODE_FRAME_WITH_FUNC_RE.exec(line)
  if (withFunc !== null) {
    const loc = NODE_LOC_RE.exec(withFunc[2] ?? '')
    if (loc === null) return null
    return { file: loc[1] ?? '', lineNo: Number.parseInt(loc[2] ?? '0', 10), func: withFunc[1] ?? '' }
  }
  const anon = NODE_FRAME_ANON_RE.exec(line)
  if (anon !== null) {
    const loc = NODE_LOC_RE.exec((anon[1] ?? '').trim())
    if (loc === null) return null
    return { file: loc[1] ?? '', lineNo: Number.parseInt(loc[2] ?? '0', 10), func: '' }
  }
  return null
}

/**
 * Parses one Node/V8 stack trace starting at `lines[start]` (the `<ErrorName>: <message>` or
 * bare-message header line). Detection requires the very next line to already match the strict
 * `at <file>:<line>:<col>` / `at <func> (<file>:<line>:<col>)` frame shape -- a bare line
 * starting with whitespace + "at " that DOESN'T carry that exact file:line:col suffix (e.g. a
 * JVM or .NET frame, which only ever have one trailing line number, not two) is deliberately
 * rejected here so grammar detection stays unambiguous per the codebase's per-block-marker
 * dispatch model, rather than misclassifying another language's frame as Node's.
 */
function parseNodeBlock(lines: string[], start: number): TraceParseResult | null {
  const header = (lines[start] ?? '').trim()
  if (header === '') return null
  const firstFrame = parseNodeFrameLine(lines[start + 1] ?? '')
  if (firstFrame === null) return null
  const frames: TraceFrame[] = [firstFrame]
  let i = start + 2
  while (i < lines.length) {
    const f = parseNodeFrameLine(lines[i] ?? '')
    if (f === null) break
    frames.push(f)
    i++
  }
  return { block: { frames, exception: header }, nextIndex: i }
}

const RUST_PANIC_HEADER_RE = /^thread '[^']*' panicked at (.+):(\d+):(\d+):\s*$/
const RUST_BACKTRACE_NOTE_RE = /^note: run with `RUST_BACKTRACE=1`/
const RUST_BACKTRACE_NUM_RE = /^\s*\d+:\s+(.+)$/
const RUST_BACKTRACE_AT_RE = /^\s+at\s+(.+):(\d+):(\d+)\s*$/

/**
 * Parses one Rust panic starting at `lines[start]`'s `thread '<name>' panicked at <file>:<line>:
 * <col>:` header (the modern, current-stable panic format). That header line alone gives the
 * panic site's frame directly. If a `stack backtrace:` section follows (only present when
 * `RUST_BACKTRACE=1` was set), its parsed frames are used instead -- richer/more accurate than
 * the single panic-site frame -- mirroring how a real Rust backtrace supersedes the bare panic
 * line for debugging. rustc-internal (`/rustc/...`) and Cargo-registry dependency frames aren't
 * filtered here; that's `isProjectFrame`'s job, matching how Python's stdlib/site-packages
 * frames are parsed as ordinary frames and filtered downstream rather than dropped at parse time.
 */
function parseRustBlock(lines: string[], start: number): TraceParseResult | null {
  const header = lines[start] ?? ''
  const hm = RUST_PANIC_HEADER_RE.exec(header)
  if (hm === null) return null
  const panicFrame: TraceFrame = { file: hm[1] ?? '', lineNo: Number.parseInt(hm[2] ?? '0', 10), func: '' }

  let i = start + 1
  const msgLines: string[] = []
  while (i < lines.length) {
    const l = lines[i] ?? ''
    if (l.trim() === '') { i++; break }
    if (RUST_BACKTRACE_NOTE_RE.test(l)) { i++; break }
    if (l.trim() === 'stack backtrace:') break
    msgLines.push(l.trim())
    i++
  }
  const exception = msgLines.join(' ')

  if ((lines[i] ?? '').trim() === 'stack backtrace:') {
    i++
    const frames: TraceFrame[] = []
    while (i < lines.length) {
      const numMatch = RUST_BACKTRACE_NUM_RE.exec(lines[i] ?? '')
      if (numMatch === null) break
      const atMatch = RUST_BACKTRACE_AT_RE.exec(lines[i + 1] ?? '')
      if (atMatch === null) {
        // A numbered frame with no `at <file>:<line>:<col>` continuation is normal in real Rust backtraces (e.g. std/core frames compiled without location metadata) and can appear anywhere in the trace, not just at the end -- skip just this one frame and keep scanning, rather than aborting the whole backtrace and silently dropping every deeper (often more diagnostically relevant, project-level) frame after it.
        i += 1
        continue
      }
      frames.push({ file: atMatch[1] ?? '', lineNo: Number.parseInt(atMatch[2] ?? '0', 10), func: (numMatch[1] ?? '').trim() })
      i += 2
    }
    if (frames.length > 0) {
      return { block: { frames, exception }, nextIndex: i }
    }
  }
  return { block: { frames: [panicFrame], exception }, nextIndex: i }
}

const JVM_HEADER_RE = /^(?:Exception in thread "[^"]*" )?(?:Caused by: )?((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*): (.*)$/
const JVM_FRAME_RE = /^\s+at\s+(\S+)\(([^)]*)\)\s*$/
const JVM_MORE_RE = /^\s*\.\.\.\s+\d+\s+more\s*$/

/**
 * Parses one JVM frame line `at <fully.qualified.Method>(<File>.java:<line>)` (also `.kt`,
 * `.scala`, or the no-source-info forms `Native Method`/`Unknown Source`). For the no-source
 * forms `file` becomes the literal parenthesized text and `lineNo` is 0 -- there's nothing to
 * resolve a symbol from, matching the same "no symbol covers this" fallthrough `resolveFrameSymbol`
 * already handles for any unresolvable frame.
 */
function parseJvmFrameLine(line: string): TraceFrame | null {
  const m = JVM_FRAME_RE.exec(line)
  if (m === null) return null
  const func = m[1] ?? ''
  const inner = m[2] ?? ''
  if (inner === 'Native Method' || inner === 'Unknown Source') {
    return { file: inner, lineNo: 0, func }
  }
  const lm = /^(.+):(\d+)$/.exec(inner)
  if (lm === null) return null
  return { file: lm[1] ?? '', lineNo: Number.parseInt(lm[2] ?? '0', 10), func }
}

/**
 * Parses one JVM (Java/Kotlin/Scala) exception starting at `lines[start]`, which may be the
 * top-level `Exception in thread "<thread>" <FQClass>: <message>` form, a bare
 * `<FQClass>: <message>` form, or a chained `Caused by: <FQClass>: <message>` form -- all three
 * share this parser since a `Caused by:` section is just the same grammar starting a new
 * `TraceBlock`, exactly like a second Python `Traceback (...)` block in one input. A trailing
 * `\t... N more` line means further frames are elided (shared with the enclosing exception);
 * parsing simply stops there rather than trying to recover them.
 */
function parseJvmBlock(lines: string[], start: number): TraceParseResult | null {
  const header = lines[start] ?? ''
  if (JVM_HEADER_RE.exec(header) === null) return null
  const firstFrame = parseJvmFrameLine(lines[start + 1] ?? '')
  if (firstFrame === null) return null
  const frames: TraceFrame[] = [firstFrame]
  let i = start + 2
  while (i < lines.length) {
    const l = lines[i] ?? ''
    if (JVM_MORE_RE.test(l)) { i++; break }
    const f = parseJvmFrameLine(l)
    if (f === null) break
    frames.push(f)
    i++
  }
  return { block: { frames, exception: header.trim() }, nextIndex: i }
}

const DOTNET_HEADER_RE = /^(?:Unhandled exception\. )?((?:[A-Za-z_][\w]*\.)+[A-Za-z_][\w]*): (.*)$/
const DOTNET_FRAME_WITH_LOC_RE = /^\s+at\s+(.+?)\s+in\s+(.+):line\s+(\d+)\s*$/
const DOTNET_FRAME_NO_LOC_RE = /^\s+at\s+(.+)$/

/**
 * Parses one .NET frame line `at <Namespace.Class.Method(args)> in <file>:line <N>`, or, for
 * external/framework frames with no source mapping, the bare `at <Namespace.Class.Method(args)>`
 * form (file becomes empty, lineNo becomes 0). The no-location form is deliberately permissive
 * (matches anything after "at ") -- it's only ever reached once a block has already been
 * confirmed .NET-shaped by its header plus a location-bearing first frame, so it can't
 * misclassify another grammar's frame as .NET on its own.
 */
function parseDotnetFrameLine(line: string): TraceFrame | null {
  const withLoc = DOTNET_FRAME_WITH_LOC_RE.exec(line)
  if (withLoc !== null) {
    return { file: withLoc[2] ?? '', lineNo: Number.parseInt(withLoc[3] ?? '0', 10), func: withLoc[1] ?? '' }
  }
  const noLoc = DOTNET_FRAME_NO_LOC_RE.exec(line)
  if (noLoc !== null) {
    return { file: '', lineNo: 0, func: (noLoc[1] ?? '').trim() }
  }
  return null
}

/**
 * Parses one .NET exception starting at `lines[start]`, either the top-level
 * `Unhandled exception. <FQClass>: <message>` form or a bare `<FQClass>: <message>` form (a
 * caught-and-logged exception). Only the single top-level exception + its frames is required;
 * "Inner exception" chaining (`---> System.XException: ...` / `--- End of inner exception stack
 * trace ---`) isn't parsed into its own chained block here. The first frame must carry a
 * `in <file>:line <N>` location to confirm this is really .NET's grammar (see
 * `parseDotnetFrameLine`'s doc comment for why the no-location form alone isn't a safe detector).
 */
function parseDotnetBlock(lines: string[], start: number): TraceParseResult | null {
  const header = lines[start] ?? ''
  if (DOTNET_HEADER_RE.exec(header) === null) return null
  const firstFrame = DOTNET_FRAME_WITH_LOC_RE.exec(lines[start + 1] ?? '') !== null ? parseDotnetFrameLine(lines[start + 1] ?? '') : null
  if (firstFrame === null) return null
  const frames: TraceFrame[] = [firstFrame]
  let i = start + 2
  while (i < lines.length) {
    const f = parseDotnetFrameLine(lines[i] ?? '')
    if (f === null) break
    frames.push(f)
    i++
  }
  return { block: { frames, exception: header.trim() }, nextIndex: i }
}

/**
 * Dispatches each block-start marker to its grammar-specific parser (Python, Rust, Node, JVM,
 * .NET, in that order) and keeps scanning the rest of the input the same way, producing the
 * same `TraceBlock[]` shape regardless of which grammar(s) a given input mixes (e.g. a CI log
 * containing both a Python traceback and a Node stack trace). Order matters for disambiguation:
 * Node's frame shape (two trailing numbers, `file:line:col`) is stricter than JVM's (one trailing
 * number) which is in turn stricter than .NET's permissive no-location fallback, so trying them
 * loosest-last prevents a stricter grammar's frames from being swallowed by a looser one.
 */
function parseTracebacks(text: string): TraceBlock[] {
  const lines = splitLines(text)
  const blocks: TraceBlock[] = []
  let i = 0
  while (i < lines.length) {
    const result =
      parsePythonBlock(lines, i) ??
      parseRustBlock(lines, i) ??
      parseNodeBlock(lines, i) ??
      parseJvmBlock(lines, i) ??
      parseDotnetBlock(lines, i)
    if (result === null) { i++; continue }
    if (result.block !== null) blocks.push(result.block)
    i = result.nextIndex
  }
  return blocks
}

/**
 * True when `normalPath` is `normalRoot` itself or a real descendant of it (both
 * already normalized/case-folded by the caller). Checks the character right after
 * the prefix match is a path separator (`/` or backslash) so `/tmp/abc-fork` doesn't
 * false-match root `/tmp/abc` on a bare prefix comparison. Handles raw Windows
 * paths (backslash-separated), so it is not a drop-in replacement for util.ts's
 * isUnderBlockedRoot, which only checks `/`.
 */
function isPathUnderRoot(normalPath: string, normalRoot: string): boolean {
  if (!normalPath.startsWith(normalRoot)) return false
  if (normalPath === normalRoot) return true
  const nextChar = normalPath[normalRoot.length]
  return nextChar === '/' || nextChar === '\\'
}

function isProjectFrame(framePath: string, cwd: string): boolean {
  // Node's own internal-module "protocol" paths (node:internal/modules/cjs/loader) have no real
  // file on disk and no leading path separator, so canonicalize()/path.resolve() treat the
  // "node:internal/..." text as a plain relative path and join it under cwd -- landing it
  // (wrongly) inside the project root before the below root-boundary check even runs. Reject it
  // up front, on the raw framePath, before canonicalizing -- excluded the same way Python's
  // stdlib/site-packages frames are excluded below, just earlier because this one can't survive
  // the same ordering.
  if (framePath.startsWith('node:')) return false
  // An empty framePath (.NET's no-location frame form) or JVM's two literal no-source-info
  // markers ("Native Method"/"Unknown Source", from parseJvmFrameLine) are not real paths --
  // canonicalize()/path.resolve() treats an empty string as cwd itself and a bare marker string
  // as a plain relative path, both of which resolve UNDER cwd and would otherwise wrongly pass
  // the root-boundary check below (a frame with no real source location would then be kept as
  // "in the project" instead of correctly falling through to the "no symbol covers this" path
  // resolveFrameSymbol already handles for any unresolvable frame). Reject up front, same as the
  // node: check above.
  if (framePath === '' || framePath === 'Native Method' || framePath === 'Unknown Source') return false
  // Route through canonicalize (project.ts) so a WSL/MSYS-style frame path (e.g.
  // /mnt/c/Projects/token-goat/...) is recognized as the same file as its native
  // Windows drive-letter form, instead of being compared as a raw resolved string.
  // canonicalize only lowercases the drive letter, not the rest of the path, so fold both
  // sides through foldPath (util.ts) to restore case-insensitive comparison on Windows/macOS
  // (matching the platform-gated convention used elsewhere, e.g. isUnderBlockedRoot).
  const normalCwd = normalizeDarwinSystemAlias(foldPath(canonicalize(cwd)))
  const normalAbs = normalizeDarwinSystemAlias(foldPath(canonicalize(framePath, cwd)))
  if (isPathUnderRoot(normalAbs, normalCwd)) {
    return true
  }
  if (framePath.includes('site-packages') || framePath.includes('lib/python')) return false
  // Rust panic backtraces route through the toolchain's own vendored std/core sources
  // (/rustc/<hash>/library/...) and third-party crates fetched into the local Cargo registry
  // cache (~/.cargo/registry/... or its Windows equivalent) -- neither is part of the project,
  // so exclude both the same way Python's site-packages/stdlib frames are excluded above.
  if (framePath.includes('/rustc/')) return false
  if (framePath.includes('.cargo/registry') || framePath.includes('.cargo\\registry')) return false
  if (/^<.+>$/.test(framePath)) return false
  if (!path.isAbsolute(framePath) && !framePath.startsWith('..')) return true
  return false
}

/**
 * Resolves a traceback frame's file:line to its enclosing symbol via the same index-backed
 * mechanism `token-goat scope <file:line>` uses (querySymbols + enclosingSymbol from
 * graph_commands.ts), then formats its body the way `token-goat read`/`token-goat brief` do
 * (resolveBody from read_commands.ts). Returns null when nothing resolves -- a frame into an
 * unindexed third-party file (site-packages, node_modules), a file that no longer exists, or a
 * file:line with no covering symbol all fall through to querySymbols/enclosingSymbol returning
 * no match, so this needs no separate existence check.
 */
function resolveFrameSymbol(frame: TraceFrame, projectRoot: string): { key: string; name: string; kind: string; filePath: string; lineStart: number; lineEnd: number; body: string } | null {
  const filePath = resolveIndexPath(frame.file, projectRoot)
  const syms = querySymbols({ filePath, limit: ALL_SYMBOLS_IN_FILE_LIMIT })
  const match = enclosingSymbol(syms, frame.lineNo)
  if (match === null) return null
  return {
    key: `${match.filePath}::${match.name}`,
    name: match.name,
    kind: match.kind,
    filePath: match.filePath,
    lineStart: match.lineStart,
    lineEnd: match.lineEnd,
    body: resolveBody(match),
  }
}

/**
 * Formats the `--bodies` block for one frame, mirroring `brief`'s `# name  kind  file:start-end`
 * metadata-line convention (read_commands.ts's runBrief) so the body is delimited the same way
 * other commands in this codebase already combine "symbol body + context" into one response.
 * Same file::symbol resolved more than once in the same `--bodies` run (recursion) is shown once
 * and referenced by name on repeats -- printing the identical body text again for every recursive
 * frame would be pure noise, and this codebase has no existing whole-block content-dedup
 * convention for CLI text output to mirror instead (the precedents found, bash_compress's
 * dedupeConsecutiveLines and the read/session re-read hints, both dedupe on "already seen this
 * session" state or consecutive identical *lines*, not a named block repeated non-consecutively
 * within one command's own output).
 */
function formatFrameBody(frame: TraceFrame, projectRoot: string, seen: Map<string, boolean>): string[] {
  const resolved = resolveFrameSymbol(frame, projectRoot)
  if (resolved === null) {
    // Mirrors runScope's exact miss wording (graph_commands.ts) for "no symbol covers this
    // file:line", the same phrasing `token-goat scope` itself reports.
    return [`    # body: No symbols enclosing line ${frame.lineNo} in '${frame.file}'`]
  }
  const header = `    # body: ${resolved.name}  ${resolved.kind}  ${resolved.filePath}:${resolved.lineStart}-${resolved.lineEnd}`
  if (seen.has(resolved.key)) {
    return [`${header} (same as above)`]
  }
  seen.set(resolved.key, true)
  return [header, resolved.body]
}

export function cmdTrace(src: string | undefined, opts: { keep?: string; json?: boolean; bodies?: boolean }): void {
  const text = readInput(src)
  const blocks = parseTracebacks(text)
  if (blocks.length === 0) {
    process.stderr.write('token-goat: no traceback found\n')
    process.exitCode = 0
    return
  }
  const cwd = process.cwd()
  const keepN = opts.keep !== undefined ? requireNonNegativeStrictInt('--keep', opts.keep) : 0

  const filtered = blocks.map((b) => {
    let frames = b.frames.filter((f) => isProjectFrame(f.file, cwd))
    if (keepN > 0 && frames.length > keepN) frames = frames.slice(frames.length - keepN)
    return { ...b, frames }
  })

  if (opts.json === true) {
    if (opts.bodies !== true) {
      process.stdout.write(JSON.stringify({ tracebacks: filtered }, null, 2) + '\n')
      return
    }
    // Same resolution + dedup-by-reference as the text path below, just shaped as JSON fields
    // (bodySymbol/body on first occurrence, bodyDuplicateOf pointing back to it on a repeat)
    // instead of interleaved lines.
    const seenJson = new Map<string, boolean>()
    const withBodies = filtered.map((b) => ({
      ...b,
      frames: b.frames.map((f) => {
        const resolved = resolveFrameSymbol(f, cwd)
        if (resolved === null) return { ...f }
        if (seenJson.has(resolved.key)) {
          return { ...f, bodyDuplicateOf: resolved.key }
        }
        seenJson.set(resolved.key, true)
        return {
          ...f,
          bodySymbol: { name: resolved.name, kind: resolved.kind, filePath: resolved.filePath, lineStart: resolved.lineStart, lineEnd: resolved.lineEnd },
          body: resolved.body,
        }
      }),
    }))
    process.stdout.write(JSON.stringify({ tracebacks: withBodies }, null, 2) + '\n')
    return
  }

  // Dedup state spans the whole command's output (not just one block/frame) so a recursive
  // function that reappears across multiple tracebacks in the same input still only prints its
  // body once, consistent with "the same content already shown this output" rather than
  // "this block".
  const seenBodies = new Map<string, boolean>()

  // Indexed rather than for-of because the pre-filter frame count is read back off the parallel `blocks` array below: `filtered` is a .map of `blocks` so the indices line up, and carrying the count on the mapped object instead would leak a new field into the `--json` payload, which spreads those same objects verbatim.
  for (const [blockIndex, block] of filtered.entries()) {
    process.stdout.write('Traceback (most recent call last):\n')
    // `--keep N` slices the TAIL of the surviving project frames, so what it drops is the OUTER frames -- the call path that led to the failure, which is the single thing `trace` exists to show. Rendered silently, the kept tail reads as the complete project-frame set, so the notice goes ABOVE the frames, where the elision actually happened. Recomputed off the parallel `blocks` array (same indexing rationale as the loop header) rather than carried on the mapped object, because those objects are spread verbatim into the `--json` payload and a new field would change that frozen shape. Wording and shape are the repo's existing cap-elision dialect (see renderTopFilesSummary in read_commands.ts): `...(N more X elided; use a higher --flag to see more)`, with the noun agreeing with the count so "1 more frames elided" can't ship. This cannot collide with the filtered-to-empty notice below: --keep only slices when frames.length > keepN and keepN >= 1, so any block it truncates keeps at least one frame, and any block that reaches zero was zeroed by isProjectFrame alone -- for which droppedByKeep is 0 and this notice stays silent.
    const projectFrameCount = blocks[blockIndex]?.frames.filter((f) => isProjectFrame(f.file, cwd)).length ?? 0
    const droppedByKeep = projectFrameCount - block.frames.length
    if (droppedByKeep > 0) {
      const noun = droppedByKeep === 1 ? 'frame' : 'frames'
      process.stdout.write(`  ...(${droppedByKeep} more ${noun} elided; use a higher --keep to see more)\n`)
    }
    for (const f of block.frames) {
      process.stdout.write(`  File "${f.file}", line ${f.lineNo}, in ${f.func}\n`)
      // parseTracebacks always assigns context a string ('' for "no context line"), never
      // leaves it undefined, so an undefined check here was always true -- printing a
      // fabricated blank indented line for every context-less frame (e.g. a stdlib frame
      // immediately followed by the next "File ..." header) that didn't have one in the
      // original traceback. Match the truthiness check already used for `block.exception`
      // below.
      if (f.context) process.stdout.write(`    ${f.context}\n`)
      if (opts.bodies === true) {
        for (const line of formatFrameBody(f, cwd, seenBodies)) process.stdout.write(`${line}\n`)
      }
    }
    // A block rendered down to its bare header reads exactly like a block that carried nothing, so the reader cannot tell "this failure is entirely in dependency/runtime code" from "trace lost the frames" -- and only the first answer stops them re-reading the raw traceback. Every parser here requires at least one frame before it emits a block (parsePythonBlock and friends all return null otherwise), so a surviving count of zero is always the project filter's doing, never an honestly empty block. --keep never zeroes a block either (it only slices when frames.length > keepN, keeping keepN >= 1), so isProjectFrame is the sole cause worth naming. The verb has to agree with the noun the count already selects: "all 1 frames were filtered out" reads as a typo in the tool rather than as a report about the traceback.
    if (block.frames.length === 0) {
      const preFilterCount = blocks[blockIndex]?.frames.length ?? 0
      const noun = preFilterCount === 1 ? 'frame' : 'frames'
      const verb = preFilterCount === 1 ? 'was' : 'were'
      process.stdout.write(`  (all ${preFilterCount} ${noun} ${verb} filtered out as non-project -- this traceback runs entirely through dependency or runtime code)\n`)
    }
    if (block.exception) process.stdout.write(`${block.exception}\n`)
    process.stdout.write('\n')
  }
}

// ── logfold ─────────────────────────────────────────────────────────────────

const VOLATILE_SUBS: Array<{ re: RegExp; placeholder: string }> = [
  { re: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, placeholder: '[HH:MM:SS]' },
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, placeholder: '[UUID]' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, placeholder: '[IP]' },
  { re: /\b[0-9a-f]{8,}\b/g, placeholder: '[HEX]' },
  // Bare integers (counters, PIDs, ports, line numbers, byte counts, elapsed-ms values). Must run last: it operates on a string that has already had HH:MM:SS/UUID/IP/HEX replaced with their placeholders, so it never competes with those rules for the same digits. The lookbehind/lookahead exclude letters, digits AND underscore (not just \b, which treats underscore as a word character) so a digit run embedded in a longer token like v2, utf8, x86_64, sha256, or test_3_case is left untouched.
  { re: /(?<![A-Za-z0-9_])\d+(?![A-Za-z0-9_])/g, placeholder: '[N]' },
]

function normalizeVolatile(line: string): string {
  let out = line
  for (const sub of VOLATILE_SUBS) {
    out = out.replace(sub.re, sub.placeholder)
  }
  return out
}

interface FoldedLine {
  text: string
  count: number
}

// logfold has no pre-existing line/byte cap of its own (--tail bounds input length, but that's an opt-in slice, not a safety cap), so this is a new bound introduced specifically for --fold-repeats: the seen-key map is capped at this many distinct keys, and lines that would grow it past the cap fall back to consecutive-only folding instead of growing unbounded.
const MAX_FOLD_REPEATS_KEYS = 20_000

function applyFiltersAndFold(lines: string[], noNormalize: boolean, foldRepeats: boolean): FoldedLine[] {
  const dropped: string[] = []
  for (const raw of lines) {
    let cur: string | null = raw
    for (const filter of FILTERS) {
      if (cur === null) break
      if (filter.pattern !== null && !filter.pattern.test(cur)) continue
      cur = filter.replacer(cur)
      break
    }
    if (cur !== null) dropped.push(cur)
  }

  const folded: FoldedLine[] = []

  if (!foldRepeats) {
    // Default: consecutive-only folding. A suppressed line must immediately follow its match.
    let prevKey: string | null = null
    let lastText = ''
    let count = 0
    for (const line of dropped) {
      const key = noNormalize ? line : normalizeVolatile(line)
      if (key === prevKey) {
        count++
      } else {
        if (prevKey !== null) folded.push({ text: lastText, count })
        prevKey = key
        lastText = line
        count = 1
      }
    }
    if (prevKey !== null) folded.push({ text: lastText, count })
    return folded
  }

  // --fold-repeats: a line whose key has already been seen anywhere earlier (not just immediately before) is suppressed, and its count is attributed to the first occurrence.
  const keyIndex = new Map<string, number>()
  let prevKey: string | null = null
  for (const line of dropped) {
    const key = noNormalize ? line : normalizeVolatile(line)
    const seenIdx = keyIndex.get(key)
    if (seenIdx !== undefined) {
      const entry = folded[seenIdx]
      if (entry !== undefined) entry.count++
    } else if (key === prevKey && folded.length > 0) {
      // Past the cap this key isn't tracked in keyIndex, so fall back to folding it against whatever line immediately preceded it (consecutive-only behavior for this key).
      const entry = folded[folded.length - 1]
      if (entry !== undefined) entry.count++
    } else {
      folded.push({ text: line, count: 1 })
      if (keyIndex.size < MAX_FOLD_REPEATS_KEYS) keyIndex.set(key, folded.length - 1)
    }
    prevKey = key
  }
  return folded
}

export function cmdLogfold(
  src: string | undefined,
  opts: { tail?: string | undefined; noNormalize?: boolean; foldRepeats?: boolean | undefined; json?: boolean | undefined },
): void {
  const text = readInput(src)
  let lines = splitLines(text)
  if (opts.tail !== undefined) {
    const n = requireNonNegativeStrictInt('--tail', opts.tail)
    lines = lines.slice(Math.max(0, lines.length - n))
  }

  const folded = applyFiltersAndFold(lines, opts.noNormalize === true, opts.foldRepeats === true)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ lines: folded }, null, 2) + '\n')
    return
  }

  for (const item of folded) {
    if (item.count > 1) {
      process.stdout.write(`${item.text}  (x${item.count})\n`)
    } else {
      process.stdout.write(`${item.text}\n`)
    }
  }
}

// ── lockdeps ─────────────────────────────────────────────────────────────────

interface DepEntry {
  name: string
  version: string
  kind: 'direct' | 'transitive' | 'unknown'
}

const LOCK_PRIORITY = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
] as const

function findLockfile(startPath: string): { file: string; others: string[] } | null {
  const stat = fs.statSync(startPath, { throwIfNoEntry: false })
  if (stat !== undefined && stat.isFile()) {
    // An explicit lockfile path is the caller's actual choice -- honor it
    // directly instead of falling through to a directory-based priority
    // search, which would silently discard it in favor of whatever
    // LOCK_PRIORITY picks from its containing directory.
    return { file: startPath, others: [] }
  }
  const dir = stat !== undefined && stat.isDirectory() ? startPath : path.dirname(startPath)

  const found: string[] = []
  for (const name of LOCK_PRIORITY) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) found.push(candidate)
  }
  // also look for requirements*.txt
  try {
    const entries = fs.readdirSync(dir)
    for (const e of entries) {
      if (/^requirements.*\.txt$/.test(e)) {
        const p = path.join(dir, e)
        if (!found.includes(p)) found.push(p)
      }
    }
  } catch {
    // ignore
  }

  if (found.length === 0) return null
  const primary = found[0] as string
  return { file: primary, others: found.slice(1) }
}

interface V1PackageLockDependency {
  version?: string
  dev?: boolean
  optional?: boolean
  dependencies?: Record<string, V1PackageLockDependency>
}

// npm v1 lockfiles (lockfileVersion: 1, npm 5/6) have no `packages` map; deps instead
// live in a nested `dependencies` tree. Recursively flatten it into the same DepEntry
// shape the v2/v3 `packages` path produces, so downstream output is format-agnostic.
function collectV1Dependencies(
  deps: Record<string, V1PackageLockDependency>,
  isDirect: boolean,
  out: DepEntry[],
): void {
  for (const [name, val] of Object.entries(deps)) {
    out.push({ name, version: val.version ?? '', kind: isDirect ? 'direct' : 'transitive' })
    if (val.dependencies !== undefined) collectV1Dependencies(val.dependencies, false, out)
  }
}

function parsePackageLockJson(content: string): DepEntry[] {
  const raw = JSON.parse(content) as {
    packages?: Record<string, { version?: string; dev?: boolean; peer?: boolean }>
    name?: string
    dependencies?: Record<string, V1PackageLockDependency>
  }
  if (raw.packages === undefined && raw.dependencies !== undefined) {
    const deps: DepEntry[] = []
    collectV1Dependencies(raw.dependencies, true, deps)
    return deps
  }
  const pkgs = raw.packages ?? {}
  // optionalDependencies must count as direct the same as dependencies/devDependencies -- an
  // npm v2/v3 lockfile's root "" entry carries all three sibling maps (mirrors package.json's
  // own three top-level dependency fields), and parsePnpmLock's rootSections handling already
  // folds pnpm's equivalent root optionalDependencies into its direct-version set below. Omitting
  // it here mislabeled any package declared only as optional (e.g. fsevents) as 'transitive'.
  const directDeps =
    (pkgs[''] as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> } | undefined) ?? {}
  const allDirect = new Set([
    ...Object.keys(directDeps.dependencies ?? {}),
    ...Object.keys(directDeps.devDependencies ?? {}),
    ...Object.keys(directDeps.optionalDependencies ?? {}),
  ])
  const deps: DepEntry[] = []
  for (const [key, val] of Object.entries(pkgs)) {
    if (key === '') continue
    const name = key.split('node_modules/').pop() ?? key
    const version = (val as { version?: string }).version ?? ''
    // A package is genuinely direct only when its own key IS the top-level `node_modules/<name>`
    // entry, not merely when its bare name happens to match a direct dependency's name. Checking
    // allDirect.has(name) alone mislabels a nested transitive dependency as direct whenever a
    // deeper package (e.g. node_modules/some-lib/node_modules/semver) pulls in a different
    // version of a package that also happens to be a top-level direct dependency (semver).
    const isTopLevel = key === `node_modules/${name}`
    deps.push({ name, version, kind: isTopLevel && allDirect.has(name) ? 'direct' : 'transitive' })
  }
  return deps
}

function parseYarnLock(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  const headerRe = /^"?(@?[^@"]+)@/
  const versionRe = /^\s{2}version[:\s]+"?([^"\s]+)"?/
  const lines = splitLines(content)
  let pendingName: string | null = null
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) { pendingName = null; continue }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const m = headerRe.exec(line)
      if (m !== null) pendingName = m[1]?.trim() ?? null
      continue
    }
    if (pendingName !== null) {
      const vm = versionRe.exec(line)
      if (vm !== null) {
        deps.push({ name: pendingName, version: vm[1] ?? '', kind: 'unknown' })
        pendingName = null
      }
    }
  }
  return deps
}

function parseTomlPackages(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  const lines = splitLines(content)
  let inPackage = false
  let name = ''
  let version = ''
  for (const line of lines) {
    if (/^\[\[package\]\]/.test(line)) {
      if (inPackage && name) deps.push({ name, version, kind: 'unknown' })
      inPackage = true
      name = ''
      version = ''
      continue
    }
    if (inPackage && /^name\s*=/.test(line)) {
      const m = /=\s*"([^"]+)"/.exec(line)
      if (m !== null) name = m[1] ?? ''
    }
    if (inPackage && /^version\s*=/.test(line)) {
      const m = /=\s*"([^"]+)"/.exec(line)
      if (m !== null) version = m[1] ?? ''
    }
  }
  if (inPackage && name) deps.push({ name, version, kind: 'unknown' })
  return deps
}

function parsePipfileLock(content: string): DepEntry[] {
  const raw = JSON.parse(content) as {
    default?: Record<string, { version?: string }>
    develop?: Record<string, { version?: string }>
  }
  // Pipfile.lock's default/develop sections list the full resolved set (direct and
  // transitive alike) with no dependency-edge data to tell them apart -- same limitation
  // as parseTomlPackages/parseYarnLock/parseRequirementsTxt below, all of which correctly
  // report 'unknown' rather than guessing 'direct' for every entry.
  const deps: DepEntry[] = []
  for (const [name, meta] of Object.entries(raw.default ?? {})) {
    deps.push({ name, version: (meta.version ?? '').replace(/^==/, ''), kind: 'unknown' })
  }
  for (const [name, meta] of Object.entries(raw.develop ?? {})) {
    deps.push({ name, version: (meta.version ?? '').replace(/^==/, ''), kind: 'unknown' })
  }
  return deps
}

function parseRequirementsTxt(content: string): DepEntry[] {
  const deps: DepEntry[] = []
  for (const raw of splitLines(content)) {
    // A whole-line comment (line starts with '#', ignoring leading whitespace) is never a
    // requirement spec, even when its text happens to mention "#egg=" -- e.g. a doc comment
    // giving a VCS-install example. Skip it before the egg-fragment recovery below gets a
    // chance to treat that mention as a real dependency (regression from the #104 fix, which
    // applied the recovery unconditionally to every raw line).
    if (/^\s*#/.test(raw)) continue
    // A VCS direct reference (git+https://..., hg+..., etc.) legally uses '#' as a URL-fragment
    // delimiter for '#egg=<name>', not a comment marker -- stripping at the first '#' truncates
    // the URL and leaves the name-capture regex below matching the URL scheme ("git") instead of
    // the real package name. Recover the name from the fragment before the generic comment-strip
    // would otherwise discard it.
    // Only apply the egg-fragment recovery when the line itself IS the VCS spec (starts
    // with a VCS scheme, optionally behind pip's editable-install flag). An ordinary pinned
    // dependency with a trailing inline comment that merely mentions "#egg=" (e.g. documenting
    // an alternate install method) must not have its real spec discarded and replaced by a
    // fabricated dependency parsed from the comment.
    // The optional `-e `/`--editable[= ]` prefix covers pip's editable-install form
    // (`-e git+https://github.com/x/y.git#egg=y`) -- pip's own documentation recommends this
    // exact shape for a VCS dependency, making it at least as common as the non-editable form
    // already handled above. Without it, the line falls through to the generic `line.startsWith('-')`
    // guard below (added to skip pip flag lines like `-r other.txt`), which also matches `-e ...`
    // and silently drops the whole dependency -- not just its egg name, the entry itself never
    // appears in `lockdeps`'s output at all.
    const eggMatch = /^\s*(?:-e\s+|--editable[\s=]+)?(?:git|hg|svn|bzr)\+.*#egg=([A-Za-z0-9_.-]+)/.exec(raw)
    if (eggMatch !== null) {
      deps.push({ name: eggMatch[1] ?? '', version: '', kind: 'unknown' })
      continue
    }
    const line = raw.split('#')[0]?.trim() ?? ''
    if (!line || line.startsWith('-')) continue
    // The optional `[extras]` (e.g. `requests[security]`, `celery[redis]`, `uvicorn[standard]`)
    // sits between the name and the version operator, so it must be consumed explicitly or the
    // version-capture group never reaches the `==`/`>=` that follows -- dropping the version for
    // every extras-qualified requirement. The operator class must also include `~` for PEP 440's
    // `~=` compatible-release operator, another idiomatic form whose version was silently lost.
    const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[>=!~<]+\s*([^\s,;]+))?/.exec(line)
    if (m !== null) {
      deps.push({ name: m[1] ?? '', version: m[2] ?? '', kind: 'unknown' })
    }
  }
  return deps
}

// A pnpm-lock.yaml `packages` key is `name@version` (scoped: `@scope/name@version`), optionally
// prefixed with a leading `/` (lockfileVersion < 9's key style) and/or suffixed with one or more
// `(peerName@peerVersion)` parenthetical groups recording which peer-dependency resolution this
// particular package variant was built against (e.g. `react-redux@8.1.0(react@18.2.0)`). Both
// must be stripped before splitting on the version-separating `@`, and a scoped name's own
// leading `@` must be skipped over when searching for that separator or `@scope/name@1.0.0`
// mis-splits at the scope's `@` instead of the real one.
//
// lockfileVersion 9 NESTS peer suffixes when a peer itself has peers, e.g.
// `@testing-library/react@13.4.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)`. A single
// `/(\([^()]*\))+$/` regex can't strip that -- `[^()]*` cannot span the inner `(`, so it removed
// only the last group and left `(react-dom@18.2.0(react@18.2.0))` fused into the version. Walk
// the trailing balanced parenthetical groups from the end instead: a semver version never
// contains parens, so every back-to-back balanced `(...)` group at the tail is peer metadata.
function stripPnpmPeerSuffix(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === ')') {
    let depth = 0
    let i = end - 1
    for (; i >= 0; i--) {
      const ch = value[i]
      if (ch === ')') depth++
      else if (ch === '(') {
        depth--
        if (depth === 0) break
      }
    }
    // Unbalanced (stray ')') -- leave the string untouched rather than truncate real content.
    if (depth !== 0 || i < 0) break
    end = i
  }
  return value.slice(0, end)
}

// Legacy pnpm (`lockfileVersion` < 6) suffixes a resolved version with `_<peerSpec>` instead of
// the modern `(peerName@peerVersion)` parenthetical form, e.g. `1.0.0_react@16.0.0`. Semver
// versions never contain `_`, so truncating at the first one is safe.
function stripPnpmLegacyPeerHash(value: string): string {
  const idx = value.indexOf('_')
  return idx === -1 ? value : value.slice(0, idx)
}

function splitPnpmPackageKey(rawKey: string): { name: string; version: string } | null {
  const key = stripPnpmPeerSuffix(rawKey.startsWith('/') ? rawKey.slice(1) : rawKey)
  const scoped = key.startsWith('@')
  const nameSearchStart = scoped ? key.indexOf('/') : 0
  if (scoped && nameSearchStart === -1) return null
  // Legacy (lockfileVersion < 6) keys are slash-separated (`/lodash/4.17.21`,
  // `/@babel/core/7.12.10_@babel+core@7.12.10`) rather than `@`-separated, and their optional
  // `_<peerSpec>` suffix can itself contain an `@` -- so an `@`-first search can mis-split a
  // legacy key at that embedded `@` instead of falling through to the slash-based parse below.
  // Checking for an *additional* `/` past the scope's own first `/` (or, for an unscoped name,
  // any `/` at all) distinguishes the two styles unambiguously: neither modern key style ever
  // contains a second `/` before its version.
  const additionalSlashIdx = key.indexOf('/', nameSearchStart + 1)
  if (additionalSlashIdx !== -1) {
    const name = key.slice(0, additionalSlashIdx)
    const version = stripPnpmLegacyPeerHash(key.slice(additionalSlashIdx + 1))
    if (!name || !version) return null
    return { name, version }
  }
  const versionSepIdx = key.indexOf('@', nameSearchStart + 1)
  if (versionSepIdx === -1) return null
  const name = key.slice(0, versionSepIdx)
  const version = key.slice(versionSepIdx + 1)
  if (!name || !version) return null
  return { name, version }
}

// Collects name -> resolved version (peer-suffix stripped, matching splitPnpmPackageKey's own
// stripping of `packages` keys) from one importer dependency section
// (`dependencies`/`devDependencies`/`optionalDependencies`). lockfileVersion 6+ shapes each entry
// as `{ specifier: '^1.0.0', version: '1.0.0' }`; legacy (`lockfileVersion` < 6) root dependency
// sections instead use a bare resolved-version string directly, e.g. `{ lodash: '4.17.21' }`.
function collectPnpmDirectVersions(section: unknown, out: Map<string, string>): void {
  if (section === null || typeof section !== 'object') return
  for (const [name, val] of Object.entries(section as Record<string, unknown>)) {
    if (typeof val === 'string' && val) {
      out.set(name, stripPnpmLegacyPeerHash(stripPnpmPeerSuffix(val)))
      continue
    }
    const version = (val as { version?: unknown } | undefined)?.version
    if (typeof version === 'string' && version) out.set(name, stripPnpmPeerSuffix(version))
  }
}

// pnpm-lock.yaml has real edge data (unlike yarn.lock/TOML/Pipfile.lock's flat resolved sets),
// so direct-vs-transitive is derived precisely: a `packages` entry counts as 'direct' only when
// its own name AND resolved version match a root-project dependency, not merely by name -- a
// package can legitimately appear at one resolved version as a direct dependency and at another
// as a transitive one (e.g. via peer-dependency-driven duplicate resolution), and a name-only
// match would mislabel the transitive variant too.
// lockfileVersion >= 9 nests every workspace project's dependency sections under `importers`,
// keyed by project path relative to the lockfile ('.' for the root/only project in a
// non-workspace repo); lockfileVersion < 9 has `dependencies`/`devDependencies` directly at the
// document root instead, with no `importers` wrapper at all.
function parsePnpmLock(content: string): DepEntry[] {
  let raw: unknown
  try {
    raw = loadYaml(content)
  } catch {
    return []
  }
  if (raw === null || typeof raw !== 'object') return []
  const doc = raw as {
    importers?: Record<string, { dependencies?: unknown; devDependencies?: unknown; optionalDependencies?: unknown }>
    dependencies?: unknown
    devDependencies?: unknown
    optionalDependencies?: unknown
    packages?: Record<string, unknown>
  }

  const directVersions = new Map<string, string>()
  const rootSections = doc.importers !== undefined ? doc.importers['.'] : doc
  collectPnpmDirectVersions(rootSections?.dependencies, directVersions)
  collectPnpmDirectVersions(rootSections?.devDependencies, directVersions)
  collectPnpmDirectVersions(rootSections?.optionalDependencies, directVersions)

  const deps: DepEntry[] = []
  for (const key of Object.keys(doc.packages ?? {})) {
    const parsed = splitPnpmPackageKey(key)
    if (parsed === null) continue
    const isDirect = directVersions.get(parsed.name) === parsed.version
    deps.push({ name: parsed.name, version: parsed.version, kind: isDirect ? 'direct' : 'transitive' })
  }
  return deps
}

function parseLockFile(filePath: string): { deps: DepEntry[]; format: string } {
  const base = path.basename(filePath)
  const content = fs.readFileSync(filePath, 'utf8')
  if (base === 'package-lock.json') return { format: 'npm', deps: parsePackageLockJson(content) }
  if (base === 'yarn.lock') return { format: 'yarn', deps: parseYarnLock(content) }
  if (base === 'pnpm-lock.yaml') return { format: 'pnpm', deps: parsePnpmLock(content) }
  if (base === 'poetry.lock') return { format: 'poetry', deps: parseTomlPackages(content) }
  if (base === 'uv.lock') return { format: 'uv', deps: parseTomlPackages(content) }
  if (base === 'Cargo.lock') return { format: 'cargo', deps: parseTomlPackages(content) }
  if (base === 'Pipfile.lock') return { format: 'pipfile', deps: parsePipfileLock(content) }
  return { format: 'requirements', deps: parseRequirementsTxt(content) }
}

// ── lockdeps --package (single-package query) ────────────────────────────────

// name -> declared direct-dependency names, plus the set of top-level/direct project
// dependency names. Only npm's lockfile (v1 nested `dependencies`, or v2/v3 `packages`)
// actually records edges between packages -- the other formats this file parses
// (yarn.lock, poetry/uv/Cargo's `[[package]]` TOML blocks, Pipfile.lock, requirements.txt)
// are flattened here into name/version/kind only, with no graph data to walk. Returns null
// for any format where edge extraction isn't implemented.
function buildNpmEdges(content: string): { edges: Map<string, string[]>; directNames: Set<string> } | null {
  const raw = JSON.parse(content) as {
    packages?: Record<
      string,
      {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
    >
    dependencies?: Record<string, V1PackageLockDependency>
  }

  if (raw.packages === undefined && raw.dependencies !== undefined) {
    const edges = new Map<string, string[]>()
    const directNames = new Set(Object.keys(raw.dependencies))
    const walk = (deps: Record<string, V1PackageLockDependency>): void => {
      for (const [name, val] of Object.entries(deps)) {
        // First occurrence wins: a name can recur at deeper nesting with a different
        // resolved version (diamond dependency); this query reports one declared edge
        // set per name, not per lockfile path.
        if (!edges.has(name)) edges.set(name, val.dependencies !== undefined ? Object.keys(val.dependencies) : [])
        if (val.dependencies !== undefined) walk(val.dependencies)
      }
    }
    walk(raw.dependencies)
    return { edges, directNames }
  }

  const pkgs = raw.packages
  if (pkgs === undefined) return null
  // Same optionalDependencies gap as parsePackageLockJson's allDirect above: without it, a
  // package declared only as optional at the project root is excluded from directNames and so
  // never appears as a possible source in findReverseDirectDeps's "depended on by direct deps"
  // DFS, even though it is genuinely one of the project's own top-level dependencies.
  const rootEntry = pkgs[''] as
    | { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    | undefined
  const directNames = new Set([
    ...Object.keys(rootEntry?.dependencies ?? {}),
    ...Object.keys(rootEntry?.devDependencies ?? {}),
    ...Object.keys(rootEntry?.optionalDependencies ?? {}),
  ])
  const edges = new Map<string, string[]>()
  for (const [key, val] of Object.entries(pkgs)) {
    if (key === '') continue
    const name = key.split('node_modules/').pop() ?? key
    if (edges.has(name)) continue
    edges.set(name, [
      ...new Set([...Object.keys(val.dependencies ?? {}), ...Object.keys(val.devDependencies ?? {}), ...Object.keys(val.optionalDependencies ?? {})]),
    ])
  }
  return { edges, directNames }
}

// DFS from each top-level/direct project dependency, checking whether `target` is reachable
// through the declared-edge graph. Cycle-safe via a per-source `seen` set.
function findReverseDirectDeps(target: string, edges: Map<string, string[]>, directNames: Set<string>): string[] {
  const result: string[] = []
  for (const direct of directNames) {
    if (direct === target) continue
    const seen = new Set<string>([direct])
    const stack = [...(edges.get(direct) ?? [])]
    let reaches = false
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (seen.has(cur)) continue
      seen.add(cur)
      if (cur === target) {
        reaches = true
        break
      }
      for (const next of edges.get(cur) ?? []) stack.push(next)
    }
    if (reaches) result.push(direct)
  }
  return result.sort()
}

function cmdLockdepsPackage(lockfile: string, format: string, deps: DepEntry[], query: string, json: boolean): void {
  const matches = deps.filter((d) => d.name === query)
  if (matches.length === 0) {
    const suggestions = suggestPackageNames(query, deps.map((d) => d.name))
    const hint = suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : ''
    throw new Error(`Package '${query}' not found in ${lockfile}${hint}`)
  }

  // A package can resolve to more than one version across a lockfile's nested node_modules
  // tree; prefer the top-level/direct pin as "the" version and surface the rest via
  // otherVersions rather than silently picking an arbitrary transitive copy.
  const primary = matches.find((d) => d.kind === 'direct') ?? (matches[0] as DepEntry)
  const otherVersions = [...new Set(matches.filter((d) => d.version !== primary.version).map((d) => d.version))]

  const graph = format === 'npm' ? buildNpmEdges(fs.readFileSync(lockfile, 'utf8')) : null
  const graphAvailable = graph !== null
  const dependsOn = graph !== null ? [...(graph.edges.get(query) ?? [])].sort() : []
  const dependedOnBy = graph !== null ? findReverseDirectDeps(query, graph.edges, graph.directNames) : []

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { file: lockfile, format, package: primary.name, version: primary.version, kind: primary.kind, otherVersions, graphAvailable, dependsOn, dependedOnBy },
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(`Lockfile: ${lockfile}  (${format})\n`)
  process.stdout.write(`Package: ${primary.name}\n`)
  process.stdout.write(`Version: ${primary.version}${primary.kind === 'unknown' ? '' : `  (${primary.kind})`}\n`)
  if (otherVersions.length > 0) process.stdout.write(`Other versions in lockfile: ${otherVersions.join(', ')}\n`)
  if (!graphAvailable) {
    process.stdout.write(`\nDependency graph not available for format '${format}' (only npm package-lock.json exposes package-to-package edges).\n`)
    return
  }
  process.stdout.write(`\nDepends on (${dependsOn.length}):\n`)
  if (dependsOn.length === 0) process.stdout.write('  (none)\n')
  for (const n of dependsOn) process.stdout.write(`  ${n}\n`)
  process.stdout.write(`\nDepended on by direct/top-level deps (${dependedOnBy.length}):\n`)
  if (dependedOnBy.length === 0) process.stdout.write('  (none)\n')
  for (const n of dependedOnBy) process.stdout.write(`  ${n}\n`)
}

export function cmdLockdeps(filePath: string | undefined, opts: { json?: boolean; package?: string }): void {
  const target = filePath !== undefined ? path.resolve(filePath) : process.cwd()
  const found = findLockfile(target)
  if (found === null) {
    throw new Error('No lockfile found. Expected one of: ' + LOCK_PRIORITY.join(', ') + ', requirements*.txt')
  }

  const { deps, format } = parseLockFile(found.file)
  const others = found.others

  if (opts.package !== undefined) {
    cmdLockdepsPackage(found.file, format, deps, opts.package, opts.json === true)
    return
  }

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ file: found.file, format, total: deps.length, others, deps }, null, 2) + '\n')
    return
  }

  process.stdout.write(`Lockfile: ${found.file}  (${format})\n`)
  if (others.length > 0) process.stdout.write(`Other lockfiles found (not parsed): ${others.join(', ')}\n`)
  process.stdout.write(`Total: ${deps.length} packages\n\n`)
  for (const dep of deps) {
    const kindLabel = dep.kind === 'unknown' ? '' : `  (${dep.kind})`
    process.stdout.write(`${dep.name}  ${dep.version}${kindLabel}\n`)
  }
}

// ── note ─────────────────────────────────────────────────────────────────────

function resolveProjectHash(): string {
  const project = findProject(process.cwd())
  if (project === null) throw new Error('No project root found from cwd. Is this inside a project (git repo, package.json, etc.)?')
  return project.hash
}

export function cmdNote(
  action: string,
  key: string | undefined,
  value: string | undefined,
  opts: { json?: boolean },
): void {
  const act = action.toLowerCase()

  if (act === 'list') {
    const hash = resolveProjectHash()
    const entries = loadEntries(hash)
    if (opts.json === true) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n')
    } else {
      const pairs = Object.entries(entries)
      if (pairs.length === 0) {
        process.stdout.write('(no notes set)\n')
      } else {
        for (const [k, v] of pairs) {
          process.stdout.write(`${k} = ${v}\n`)
        }
      }
    }
    return
  }

  if (act === 'clear') {
    const hash = resolveProjectHash()
    clearAll(hash)
    process.stdout.write('Cleared all notes for this project.\n')
    return
  }

  if (act === 'get') {
    if (key === undefined) throw new Error('note get requires a key')
    const hash = resolveProjectHash()
    const entries = loadEntries(hash)
    const v = entries[key]
    if (v === undefined) throw new Error(`Key not found: ${key}`)
    process.stdout.write(v + '\n')
    return
  }

  if (act === 'unset') {
    if (key === undefined) throw new Error('note unset requires a key')
    const hash = resolveProjectHash()
    unsetEntry(hash, key)
    process.stdout.write(`Unset: ${key}\n`)
    return
  }

  if (act === 'set') {
    if (key === undefined) throw new Error('note set requires a key')
    if (value === undefined) throw new Error('note set requires a value')
    const hash = resolveProjectHash()
    setEntry(hash, key, value)
    process.stdout.write(`Set: ${key} = ${value}\n`)
    return
  }

  throw new Error(`Unknown note action: ${action}. Use: set, get, unset, list, clear`)
}

// ── hot ──────────────────────────────────────────────────────────────────────

interface HotEntry {
  path: string
  readCount: number
}

// Aggregates by foldPath(path) (a no-op on case-sensitive filesystems, see util.ts), not the raw
// path string -- normalizePath (paths.ts) only lowercases the drive-letter prefix, so the same
// physical file read under two different literal casings across separate sessions (e.g. a Read
// tool call typed with different capitalization) would otherwise land in two distinct map entries
// on a case-insensitive filesystem, splitting/undercounting its true readCount and potentially
// dropping it out of the --limit-bounded top-N results entirely. The first-seen raw casing is
// kept as the display path, matching cmdHot's --project filter's existing foldPath usage below.
function loadAllSessionReadCounts(): Map<string, { path: string; readCount: number }> {
  const sessionsDir = path.join(tokenGoatHome(), 'sessions')
  const totals = new Map<string, { path: string; readCount: number }>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return totals
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(sessionsDir, entry.name)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    const files = (raw as Record<string, unknown>)['files']
    if (!Array.isArray(files)) continue
    for (const f of files) {
      if (f === null || typeof f !== 'object') continue
      const fp = (f as Record<string, unknown>)['path']
      const rc = (f as Record<string, unknown>)['readCount']
      if (typeof fp !== 'string' || typeof rc !== 'number') continue
      const key = foldPath(fp)
      const existing = totals.get(key)
      totals.set(key, { path: existing?.path ?? fp, readCount: (existing?.readCount ?? 0) + rc })
    }
  }
  return totals
}

export function cmdHot(opts: { limit?: string; project?: boolean; json?: boolean }): void {
  const limit = opts.limit !== undefined ? requireNonNegativeStrictInt('--limit', opts.limit) : 20
  // --limit 0 would slice the sorted entries list down to zero and print "No session read data
  // found." -- an absolute claim about the cache's contents -- even when read history genuinely
  // exists. Reject explicitly instead of silently rendering that false-clean result, matching
  // runFind's own --limit validation (read_commands.ts) and graph_commands.ts's --top validation
  // for the same failure mode.
  if (opts.limit !== undefined && limit === 0) {
    throw new Error(`--limit must be a positive number, got: "${opts.limit}"`)
  }
  const totals = loadAllSessionReadCounts()

  let entries: HotEntry[] = [...totals.values()].map(({ path: p, readCount: rc }) => ({ path: p, readCount: rc }))
  const preProjectCount = entries.length

  if (opts.project === true) {
    const project = findProject(process.cwd())
    if (project !== null) {
      // foldPath (not a bare .toLowerCase()) so the case-fold is gated on isCaseInsensitiveFs()
      // and respects the TOKEN_GOAT_CASE_INSENSITIVE_FS test override, matching isProjectFrame's
      // own case handling above -- a raw .toLowerCase() always folds regardless of platform,
      // wrongly treating two differently-cased directories as the same path on a case-sensitive
      // filesystem (e.g. this project's own Linux CI runner).
      const root = foldPath(project.root)
      entries = entries.filter((e) => isPathUnderRoot(foldPath(e.path), root))
    }
  }

  entries.sort((a, b) => b.readCount - a.readCount)
  entries = entries.slice(0, limit)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n')
    return
  }

  if (entries.length === 0) {
    // Distinguish "read data exists but none of it falls under this project root" from "no read
    // data recorded at all" -- same empty-vs-filtered-store distinction runNoteList makes for
    // --stale-only, so --project finding nothing doesn't read as "no session read data exists"
    // when data just lives elsewhere.
    if (opts.project === true && preProjectCount > 0) {
      const noun = preProjectCount === 1 ? 'file' : 'files'
      process.stdout.write(`No session read data under this project root (${preProjectCount} ${noun} recorded outside it).\n`)
      return
    }
    process.stdout.write('No session read data found.\n')
    return
  }

  const hotDisplayRoot = getDisplayRoot()
  for (const e of entries) {
    process.stdout.write(`${e.readCount}\t${toDisplayPath(hotDisplayRoot, e.path)}\n`)
  }
}

// ── recent ──────────────────────────────────────────────────────────────────

interface RecentEntry {
  path: string
  readCount: number
  lastReadAt: number
  wasEdited: boolean
}

export function cmdRecent(nStr: string | undefined, opts: { json?: boolean }): void {
  const n = nStr !== undefined ? requireNonNegativeStrictInt('recent', nStr) : 20
  // A limit of 0 would slice the sorted entries list down to zero and print "No files read in
  // this session yet." -- an absolute claim about the session's contents -- even when files were
  // genuinely read. Reject explicitly instead of silently rendering that false-clean result,
  // matching runFind's own --limit validation (read_commands.ts) and graph_commands.ts's --top
  // validation for the same failure mode.
  if (nStr !== undefined && n === 0) {
    throw new Error(`recent: limit must be a positive number, got: "${nStr}"`)
  }
  const sessionFiles = getSessionFiles()

  const entries: RecentEntry[] = [...sessionFiles.values()]
    .map((e) => ({ path: e.path, readCount: e.readCount, lastReadAt: e.lastReadAt, wasEdited: e.wasEdited }))
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
    .slice(0, n)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ entries, scope: 'current-session' }, null, 2) + '\n')
    return
  }

  process.stdout.write('# Recent files (current session only — use `token-goat hot` for cross-session)\n')
  if (entries.length === 0) {
    process.stdout.write('No files read in this session yet.\n')
    return
  }
  const recentDisplayRoot = getDisplayRoot()
  for (const e of entries) {
    const edited = e.wasEdited ? '  [edited]' : ''
    const ts = new Date(e.lastReadAt).toISOString()
    process.stdout.write(`${ts}  ${toDisplayPath(recentDisplayRoot, e.path)}${edited}\n`)
  }
}

// ── ignores ──────────────────────────────────────────────────────────────────

interface IgnoresReport {
  walkMode: 'git' | 'non-git'
  // Scoped to `token-goat index` specifically -- it alone resolves files via getTrackedFiles()
  // (git ls-files in git mode, so .gitignore is genuinely honored there). `map`/`todo`/
  // `conflicts`/`hot --project` all resolve files via baseline.ts's walkProject instead, which
  // never shells out to git and so never consults .gitignore regardless of walkMode -- see
  // skipDirs below for what those commands actually exclude.
  indexRespectsGitignore: boolean
  // Scoped to `token-goat index --walk` specifically (walk_index.ts's isWalkExcluded) -- the
  // only place `.env`/`.d.ts` filtering is wired in. `map`/`todo`/`conflicts`/`hot --project`
  // never call it and so never exclude these files, in git mode or non-git mode alike.
  walkIndexBuiltinExclusions: string[]
  // The one exclusion genuinely shared by every walkProject-based command (map/todo/conflicts/
  // hot --project), in git mode and non-git mode alike -- baseline.ts's SKIP_DIRS plus hidden
  // (dot-prefixed) directories, neither of which is gitignore- or git-status-aware.
  skipDirs: string[]
  // Enforced only by `token-goat index`/`index --walk` (cli.ts's cmdIndex) and the worker's
  // drain loop (worker.ts), both via isUnderBlockedRoot -- never consulted by walkProject, so
  // map/todo/conflicts/hot --project ignore it entirely.
  blockedRoots: string[]
  excludeTests: boolean
}

export function cmdIgnores(opts: { json?: boolean }): void {
  const cwd = process.cwd()
  const cfg = loadConfig()
  const walkMode = detectWalkMode(cwd)
  const walkIndexBuiltinExclusions = ['.env', '.env.*', '*.d.ts']

  const report: IgnoresReport = {
    walkMode,
    indexRespectsGitignore: walkMode === 'git',
    walkIndexBuiltinExclusions,
    skipDirs: [...SKIP_DIRS].sort(),
    blockedRoots: cfg.worker.blocked_roots,
    excludeTests: cfg.repomap.exclude_tests,
  }

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  process.stdout.write(`Walk mode: ${walkMode}\n`)
  if (walkMode === 'git') {
    process.stdout.write('token-goat index: .gitignore exclusions are active (via git ls-files).\n')
  } else {
    process.stdout.write(
      `token-goat index --walk: built-in exclusions ${walkIndexBuiltinExclusions.join(', ')}.\n`,
    )
  }
  // map/todo/conflicts/hot --project all resolve files via a raw filesystem walk (baseline.ts's
  // walkProject), never via git ls-files -- they never see .gitignore or the index --walk
  // exclusions above, in git mode or non-git mode alike. The only exclusion they genuinely share
  // is SKIP_DIRS plus hidden (dot-prefixed) directories.
  process.stdout.write(
    `map/todo/conflicts (and hot --project) ignore neither .gitignore nor ${walkIndexBuiltinExclusions.join(', ')} in either mode -- ` +
      `they only skip: ${report.skipDirs.join(', ')} (and hidden directories).\n`,
  )
  // worker.blocked_roots is only ever consulted by `token-goat index`/`index --walk` (cli.ts's
  // cmdIndex) and the worker's drain loop (worker.ts), both via isUnderBlockedRoot -- baseline.ts's
  // walkProject (and so map/todo/conflicts/hot --project) never checks it. Name the enforcing
  // commands explicitly so this line can't be misread as applying to the walk-based commands
  // described immediately above it.
  if (cfg.worker.blocked_roots.length > 0) {
    process.stdout.write(`Blocked roots (config, enforced by token-goat index / index --walk / worker only): ${cfg.worker.blocked_roots.join(', ')}\n`)
  } else {
    process.stdout.write('Blocked roots (config, enforced by token-goat index / index --walk / worker only): none\n')
  }
  process.stdout.write(`Exclude tests from repomap: ${cfg.repomap.exclude_tests}\n`)
}
