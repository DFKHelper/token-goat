/**
 * Erlang adapter for `.erl` and `.hrl` files. Erlang is written as a sequence of forms, each ending in a period followed by
 * white space, so the adapter reads one form at a time and names it by its head: the `-module` attribute, a function (all of
 * its clauses, which are separated by semicolons, up to the period that ends the last one), a `-record` definition, a
 * `-define` macro, and a `-type` or `-opaque` declaration. `-include`, `-include_lib` and `-import` are the imports.
 *
 * A `%` comment, a "string", a 'quoted atom' and a `$c` character literal never produce a symbol, and a period inside any of
 * them, or inside a float such as `1.5`, does not end a form.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

/** How much of a form's head is classified: enough for the longest attribute name and the symbol name after it. */
const HEAD_CHARS = 512

const MODULE_RE = /^-\s*module\s*\(\s*(?:'([^'\n]*)'|([a-z][A-Za-z0-9_@]*))/
const RECORD_RE = /^-\s*record\s*\(\s*(?:'([^'\n]*)'|([a-z][A-Za-z0-9_@]*))/
const DEFINE_RE = /^-\s*define\s*\(\s*([A-Za-z_][A-Za-z0-9_@]*)/
const TYPE_RE = /^-\s*(?:type|opaque)\s+(?:'([^'\n]*)'|([a-z][A-Za-z0-9_@]*))\s*\(/
const INCLUDE_RE = /^-\s*(include_lib|include)\s*\(\s*"([^"\n]*)"/
const IMPORT_RE = /^-\s*import\s*\(\s*(?:'([^'\n]*)'|([a-z][A-Za-z0-9_@]*))/
const FUNCTION_RE = /^(?:'([^'\n]*)'|([a-z][A-Za-z0-9_@]*))\s*\(/

/** One form of the source: where it starts and ends, and the first {@link HEAD_CHARS} of its text. */
interface Form {
  readonly head: string
  readonly line: number
  readonly endLine: number
}

/**
 * Split `content` into forms at every period that ends one: a `.` at bracket depth zero, outside a comment, string, quoted
 * atom and character literal, and followed by white space or the end of the file. Linear in the length of the file.
 */
function formsOf(content: string): Form[] {
  const out: Form[] = []
  let line = 1
  let startOffset = -1
  let startLine = 1
  let depth = 0

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!
    if (ch === '\n') {
      line++
      continue
    }
    if (ch === '%') {
      const nl = content.indexOf('\n', i)
      i = nl < 0 ? content.length : nl - 1
      continue
    }
    if (ch === '$') {
      // A character literal is `$` then one character, or `$\` then an escape character.
      i += content[i + 1] === '\\' ? 2 : 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const close = ch
      i++
      while (i < content.length && content[i] !== close) {
        if (content[i] === '\n') line++
        if (content[i] === '\\') i++
        i++
      }
      continue
    }
    if (startOffset < 0 && !/\s/.test(ch)) {
      startOffset = i
      startLine = line
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '.' && depth === 0) {
      const next = content[i + 1]
      if (next === undefined || /\s/.test(next)) {
        if (startOffset >= 0) out.push({ head: content.slice(startOffset, startOffset + HEAD_CHARS), line: startLine, endLine: line })
        startOffset = -1
      }
    }
  }
  if (startOffset >= 0) out.push({ head: content.slice(startOffset, startOffset + HEAD_CHARS), line: startLine, endLine: line })
  return out
}

export function extractErlang(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)

  for (const form of formsOf(content)) {
    const head = form.head
    const emit = (name: string, kind: string): void => {
      spans.close(spans.open(name, kind, form.line), form.endLine)
    }
    const include = INCLUDE_RE.exec(head)
    if (include) {
      imports.push({ kind: include[1]!.toLowerCase(), target: include[2]!, line: form.line })
      continue
    }
    const imported = IMPORT_RE.exec(head)
    if (imported) {
      imports.push({ kind: 'import', target: (imported[1] ?? imported[2])!, line: form.line })
      continue
    }
    const named = (re: RegExp): string | undefined => {
      const m = re.exec(head)
      return m === null ? undefined : (m[1] ?? m[2])
    }
    const module = named(MODULE_RE)
    if (module !== undefined) {
      emit(module, 'module')
      continue
    }
    const record = named(RECORD_RE)
    if (record !== undefined) {
      emit(record, 'record')
      continue
    }
    const define = DEFINE_RE.exec(head)
    if (define) {
      emit(define[1]!, 'macro')
      continue
    }
    const type = named(TYPE_RE)
    if (type !== undefined) {
      emit(type, 'type')
      continue
    }
    // Every other attribute (-export, -spec, -behaviour) starts with a hyphen and names nothing this index holds.
    if (head.startsWith('-')) continue
    const fn = named(FUNCTION_RE)
    if (fn !== undefined) emit(fn, 'function')
  }
  return { symbols: spans.finish(rawLines), imports }
}
