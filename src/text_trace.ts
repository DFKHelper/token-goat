import * as fs from 'fs'
import * as path from 'path'
import { ALL_SYMBOLS_IN_FILE_LIMIT, enclosingSymbol } from './graph_commands.js'
import { querySymbols } from './index_reader.js'
import { displaySafeText, normalizeDarwinSystemAlias, resolveIndexPath, displaySafeJson } from './paths.js'
import { canonicalize } from './project.js'
import { resolveBody, warnIfFilesStale } from './read_commands.js'
import { formatSymbolLocation } from './indexed_source.js'
import { foldPath, requireNonNegativeStrictInt } from './util.js'

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

interface TraceParseResult {
  block: TraceBlock | null
  nextIndex: number
}

function readInput(src: string | undefined): string {
  if (src !== undefined) return fs.readFileSync(src, 'utf8')
  return fs.readFileSync(0, 'utf8')
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

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
      const hasContext = peek !== undefined && /^\s/.test(lines[i] ?? '') && !peek.startsWith('File ') && !peek.startsWith('Traceback')
      if (hasContext) i++
      frames.push({ file: fm[1] ?? '', lineNo: Number.parseInt(fm[2] ?? '0', 10), func: fm[3] ?? '', context: hasContext ? (peek ?? '') : '' })
      continue
    }
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
  if (frames.length > 0 && block === null) {
    block = { frames, exception: '' }
  }
  return { block, nextIndex: i }
}

const NODE_FRAME_WITH_FUNC_RE = /^\s+at\s+(.+?)\s+\(([^)]+)\)\s*$/
const NODE_FRAME_ANON_RE = /^\s+at\s+([^\s()][^()]*)\s*$/
const NODE_LOC_RE = /^(.*):(\d+):(\d+)$/

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

const RUST_PANIC_HEADER_RE = /^thread '[^']*' panicked at ([^:\r\n]+):(\d+):(\d+):\s*$/
const RUST_BACKTRACE_NOTE_RE = /^note: run with `RUST_BACKTRACE=1`/
const RUST_BACKTRACE_NUM_RE = /^\s*\d+:\s+(.+)$/
const RUST_BACKTRACE_AT_RE = /^\s+at\s+(.+):(\d+):(\d+)\s*$/

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

const JVM_HEADER_RE = /^(?:Exception in thread "[^"\r\n]*" )?(?:Caused by: )?((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*): (.*)$/
const JVM_FRAME_RE = /^\s+at\s+(\S+)\(([^)]*)\)\s*$/
const JVM_MORE_RE = /^\s*\.\.\.\s+\d+\s+more\s*$/

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

export function isPathUnderRoot(normalPath: string, normalRoot: string): boolean {
  if (!normalPath.startsWith(normalRoot)) return false
  if (normalPath === normalRoot) return true
  const nextChar = normalPath[normalRoot.length]
  return nextChar === '/' || nextChar === '\\'
}

function isProjectFrame(framePath: string, cwd: string): boolean {
  if (framePath.startsWith('node:')) return false
  if (framePath === '' || framePath === 'Native Method' || framePath === 'Unknown Source') return false
  const normalCwd = normalizeDarwinSystemAlias(foldPath(canonicalize(cwd)))
  const normalAbs = normalizeDarwinSystemAlias(foldPath(canonicalize(framePath, cwd)))
  if (isPathUnderRoot(normalAbs, normalCwd)) {
    return true
  }
  if (framePath.includes('site-packages') || framePath.includes('lib/python')) return false
  if (framePath.includes('/rustc/')) return false
  if (framePath.includes('.cargo/registry') || framePath.includes('.cargo\\registry')) return false
  if (/^<.+>$/.test(framePath)) return false
  if (!path.isAbsolute(framePath) && !framePath.startsWith('..')) return true
  return false
}

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

function formatFrameBody(frame: TraceFrame, projectRoot: string, seen: Map<string, boolean>): string[] {
  const resolved = resolveFrameSymbol(frame, projectRoot)
  if (resolved === null) {
    return [`    # body: No symbols enclosing line ${frame.lineNo} in '${frame.file}'`]
  }
  const header = `    # body: ${resolved.name}  ${resolved.kind}  ${formatSymbolLocation(resolved.filePath, resolved.lineStart, resolved.lineEnd)}`
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

  if (opts.bodies === true) {
    warnIfFilesStale(filtered.flatMap((b) => b.frames.map((f) => resolveIndexPath(f.file, cwd))))
  }

  if (opts.json === true) {
    if (opts.bodies !== true) {
      process.stdout.write(displaySafeJson({ tracebacks: filtered }) + '\n')
      return
    }
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
    process.stdout.write(displaySafeJson({ tracebacks: withBodies }) + '\n')
    return
  }

  const seenBodies = new Map<string, boolean>()

  for (const [blockIndex, block] of filtered.entries()) {
    process.stdout.write('Traceback (most recent call last):\n')
    const projectFrameCount = blocks[blockIndex]?.frames.filter((f) => isProjectFrame(f.file, cwd)).length ?? 0
    const droppedByKeep = projectFrameCount - block.frames.length
    if (droppedByKeep > 0) {
      const noun = droppedByKeep === 1 ? 'frame' : 'frames'
      process.stdout.write(`  ...(${droppedByKeep} more ${noun} elided; use a higher --keep to see more)\n`)
    }
    for (const f of block.frames) {
      process.stdout.write(`  File "${displaySafeText(f.file)}", line ${f.lineNo}, in ${displaySafeText(f.func)}\n`)
      if (f.context) process.stdout.write(`    ${displaySafeText(f.context)}\n`)
      if (opts.bodies === true) {
        for (const line of formatFrameBody(f, cwd, seenBodies)) process.stdout.write(`${line}\n`)
      }
    }
    if (block.frames.length === 0) {
      const preFilterCount = blocks[blockIndex]?.frames.length ?? 0
      const noun = preFilterCount === 1 ? 'frame' : 'frames'
      const verb = preFilterCount === 1 ? 'was' : 'were'
      process.stdout.write(`  (all ${preFilterCount} ${noun} ${verb} filtered out as non-project -- this traceback runs entirely through dependency or runtime code)\n`)
    }
    if (block.exception) process.stdout.write(`${displaySafeText(block.exception)}\n`)
    process.stdout.write('\n')
  }
}
