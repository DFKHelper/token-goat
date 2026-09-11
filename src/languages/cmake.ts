/**
 * CMake adapter for `CMakeLists.txt` and `.cmake` files: `function` and `macro` definitions (closed by `endfunction` and
 * `endmacro`), the targets `add_library`, `add_executable` and `add_custom_target` create, and the `project` name. Command
 * names are case-insensitive. `#` line comments, `#[[ ]]` bracket comments, quoted arguments and `[[ ]]` bracket arguments
 * never produce symbols, and a target whose name is computed from a variable (`${name}`) is skipped. Imports are `include`,
 * `add_subdirectory` and `find_package` with a literal argument.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

interface Command {
  /** The command name, lowercased. */
  readonly name: string
  /** The first arguments, up to MAX_ARGS. */
  readonly args: readonly string[]
  readonly line: number
  readonly endLine: number
}

const MAX_ARGS = 2
const TARGET_COMMANDS: ReadonlySet<string> = new Set(['add_library', 'add_executable', 'add_custom_target'])
const IMPORT_KINDS: Readonly<Record<string, string>> = { include: 'include', add_subdirectory: 'subdirectory', find_package: 'package' }

/** Offset of the first character after a `[==[ ... ]==]` bracket opening at `i`, or -1 when `i` does not open one. */
function bracketClose(src: string, i: number): number {
  if (src[i] !== '[') return -1
  let j = i + 1
  while (src[j] === '=') j++
  if (src[j] !== '[') return -1
  const close = `]${'='.repeat(j - i - 1)}]`
  const end = src.indexOf(close, j + 1)
  return end < 0 ? src.length : end + close.length
}

/** Every command invocation in the file, in order. Linear: brackets and comments are closed with one indexOf each. */
function commandsOf(src: string): Command[] {
  const lineStarts = [0]
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1)
  const lineAt = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const out: Command[] = []
  let i = 0
  const n = src.length
  // A `#` comment, bracket or line; returns the offset after it.
  const skipComment = (at: number): number => {
    const b = bracketClose(src, at + 1)
    if (b >= 0) return b
    const nl = src.indexOf('\n', at)
    return nl < 0 ? n : nl
  }
  while (i < n) {
    const ch = src[i]!
    if (ch === '#') {
      i = skipComment(i)
      continue
    }
    if (!/[A-Za-z_]/.test(ch)) {
      i++
      continue
    }
    const start = i
    while (i < n && /\w/.test(src[i]!)) i++
    const name = src.slice(start, i).toLowerCase()
    while (src[i] === ' ' || src[i] === '\t') i++
    if (src[i] !== '(') continue
    i++
    const args: string[] = []
    let depth = 1
    while (i < n && depth > 0) {
      const c = src[i]!
      if (c === '(') {
        depth++
        i++
      } else if (c === ')') {
        depth--
        i++
      } else if (c === '#') {
        i = skipComment(i)
      } else if (c === '"') {
        let j = i + 1
        while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
        if (args.length < MAX_ARGS) args.push(src.slice(i + 1, j))
        i = j + 1
      } else if (c === '[' && bracketClose(src, i) >= 0) {
        const end = bracketClose(src, i)
        if (args.length < MAX_ARGS) args.push('')
        i = end
      } else if (/\s/.test(c)) {
        i++
      } else {
        let j = i
        while (j < n && !/[\s()#"]/.test(src[j]!)) j += src[j] === '\\' ? 2 : 1
        if (args.length < MAX_ARGS) args.push(src.slice(i, j))
        i = j
      }
    }
    out.push({ name, args, line: lineAt(start), endLine: lineAt(Math.max(start, i - 1)) })
  }
  return out
}

interface Frame {
  readonly kind: string
  readonly index: number | undefined
}

export function extractCmake(content: string, filePath: string): StatementAdapterResult {
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const imports: AdapterImport[] = []
  const stack: Frame[] = []
  let last = 0
  const parent = (): string => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.index !== undefined) return spans.name(stack[k]!.index)
    return ''
  }
  for (const cmd of commandsOf(content)) {
    last = cmd.endLine
    const first = cmd.args[0] ?? ''
    const literal = first !== '' && !first.includes('${')
    if (cmd.name === 'function' || cmd.name === 'macro') {
      stack.push({ kind: cmd.name, index: literal ? spans.open(first, cmd.name, cmd.line, parent()) : undefined })
    } else if (cmd.name === 'endfunction' || cmd.name === 'endmacro') {
      const kind = cmd.name.slice(3)
      let k = stack.length - 1
      while (k >= 0 && stack[k]!.kind !== kind) k--
      if (k >= 0) while (stack.length > k) spans.close(stack.pop()!.index, cmd.endLine)
    } else if (TARGET_COMMANDS.has(cmd.name) || cmd.name === 'project') {
      if (literal) spans.close(spans.open(first, cmd.name === 'project' ? 'project' : 'target', cmd.line, parent()), cmd.endLine)
    } else if (IMPORT_KINDS[cmd.name] !== undefined && Object.hasOwn(IMPORT_KINDS, cmd.name)) {
      if (literal) imports.push({ kind: IMPORT_KINDS[cmd.name]!, target: first, line: cmd.line })
    }
  }
  while (stack.length > 0) spans.close(stack.pop()!.index, last)
  return { symbols: spans.finish(rawLines), imports }
}
