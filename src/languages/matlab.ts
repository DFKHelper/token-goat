/**
 * MATLAB and Octave adapter: functions (nested and local ones too), classdef classes with their properties, methods, events and
 * enumeration members. Only the first word of a statement is read as a keyword, so an `end` used as an index (`x(end)`,
 * `c{end}`) never closes a block. A function file whose functions have no closing `end` is detected by counting openers
 * against closers: each function then runs to the next `function` or the end of the file. `%` and `#` start comments,
 * `%{ ... %}` blocks (alone on their lines) nest, `...` continues a line, and a `'` directly after a name, bracket or
 * another quote is a transpose rather than a string. Keywords are case-sensitive. Imports are `import` statements.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  readonly text: string
  readonly line: number
  readonly endLine: number
}

const FUNCTION_RE = /^function\b\s*(?:(?:\[[^\]]*\]|[A-Za-z]\w*)\s*=\s*)?([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)/
const CLASSDEF_RE = /^classdef\b\s*(?:\([^)]*\)\s*)?([A-Za-z]\w*)/
const BLOCK_RE = /^(properties|methods|events|enumeration)\s*(?:\(.*\))?$/
const ARGUMENTS_RE = /^arguments\s*(?:\(.*\))?$/
const IMPORT_RE = /^import\s+([A-Za-z]\w*(?:\.(?:[A-Za-z]\w*|\*))*)/

const CONTROL_OPENERS: ReadonlySet<string> = new Set(['if', 'for', 'parfor', 'while', 'switch', 'try', 'spmd', 'do', 'unwind_protect'])
const CLOSERS: ReadonlySet<string> = new Set([
  'end', 'endfunction', 'endif', 'endfor', 'endparfor', 'endwhile', 'endswitch', 'end_try_catch', 'end_unwind_protect',
  'endclassdef', 'endproperties', 'endmethods', 'endevents', 'endenumeration', 'endspmd', 'until',
])

// The MATLAB sniff lives in sniff.ts so language detection on the hook path does not load this adapter.
export { isMatlabSource } from './sniff.js'

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w.)\]}']/.test(ch)
}

/** Splits the file into statements with comments removed and string contents blanked. Linear in the file size. */
function statementsOf(lines: readonly string[]): Statement[] {
  const out: Statement[] = []
  let text = ''
  let start = 0
  let brackets = 0
  let parens = 0
  let blockComment = 0
  const flush = (end: number): void => {
    const t = text.trim()
    if (t !== '') out.push({ text: t, line: start, endLine: end })
    text = ''
    parens = 0
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    const trimmed = line.trim()
    if (trimmed === '%{' || trimmed === '#{') {
      blockComment++
      continue
    }
    if (blockComment > 0) {
      if (trimmed === '%}' || trimmed === '#}') blockComment--
      continue
    }
    if (text === '') start = lineNo
    let continued = false
    let quote = ''
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!
      if (quote !== '') {
        if (ch === quote) {
          if (line[j + 1] === quote) {
            text += '  '
            j++
            continue
          }
          quote = ''
          text += ch
          continue
        }
        text += ' '
        continue
      }
      if (ch === '%' || ch === '#') break
      if (ch === '.' && line.startsWith('...', j)) {
        continued = true
        break
      }
      if (ch === '"' || (ch === "'" && !isNameChar(line[j - 1]))) {
        quote = ch
        text += ch
        continue
      }
      if (ch === '[' || ch === '{') brackets++
      else if (ch === ']' || ch === '}') brackets = Math.max(0, brackets - 1)
      else if (ch === '(') parens++
      else if (ch === ')') parens = Math.max(0, parens - 1)
      else if ((ch === ',' || ch === ';') && brackets === 0 && parens === 0) {
        flush(lineNo)
        start = lineNo
        continue
      }
      text += ch
    }
    // A string never runs past the end of its line, and a newline inside `[]` or `{}` separates rows, not statements.
    if (continued || brackets > 0) {
      text += ' '
      continue
    }
    flush(lineNo)
  }
  flush(lines.length)
  return out
}

function firstWord(text: string): string {
  return /^[A-Za-z_]\w*/.exec(text)?.[0] ?? ''
}

interface Frame {
  readonly word: string
  readonly index: number | undefined
  // A function in a file whose functions have no `end`: it closes at the next `function` or the end of the file.
  readonly endless: boolean
  sawStatement: boolean
}

/** True when the file's functions lack `end`: without classdef, openers outnumber closers by at least the function count. */
function functionsAreEndless(statements: readonly Statement[]): boolean {
  let opens = 0
  let closes = 0
  let functions = 0
  for (const st of statements) {
    const w = firstWord(st.text)
    if (w === 'classdef') return false
    if (w === 'function' && FUNCTION_RE.test(st.text)) {
      functions++
      opens++
    } else if (CONTROL_OPENERS.has(w) || ARGUMENTS_RE.test(st.text)) {
      opens++
    } else if (CLOSERS.has(w) && st.text === w) {
      closes++
    }
  }
  return functions > 0 && opens - closes >= functions
}

export function extractMatlab(content: string, filePath: string): StatementAdapterResult {
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const statements = statementsOf(rawLines)
  const endless = functionsAreEndless(statements)
  const imports: AdapterImport[] = []
  const stack: Frame[] = []
  let previous = 0

  const top = (): Frame | undefined => stack[stack.length - 1]
  const nearest = (words: ReadonlySet<string>): Frame | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) if (words.has(stack[k]!.word)) return stack[k]
    return undefined
  }
  const push = (word: string, index: number | undefined, isEndless = false): void => {
    stack.push({ word, index, endless: isEndless, sawStatement: false })
  }
  const OWNERS: ReadonlySet<string> = new Set(['function', 'methods'])
  const CLASS: ReadonlySet<string> = new Set(['classdef'])

  for (const st of statements) {
    const w = firstWord(st.text)
    const frame = top()
    if (CLOSERS.has(w) && (st.text === w || w === 'until')) {
      // A stray `end` in an endless-function file must not close the function it sits in.
      if (frame !== undefined && !frame.endless) spans.close(stack.pop()!.index, st.endLine)
      previous = st.endLine
      continue
    }
    if (w === 'function') {
      const m = FUNCTION_RE.exec(st.text)
      if (m !== null) {
        if (endless) {
          while (stack.length > 0) spans.close(stack.pop()!.index, previous)
        }
        const owner = nearest(OWNERS)
        const isMethod = owner?.word === 'methods'
        const parent = isMethod ? spans.name(nearest(CLASS)?.index) : spans.name(owner?.index)
        push('function', spans.open(m[1]!, isMethod ? 'method' : 'function', st.line, parent), endless)
        previous = st.endLine
        continue
      }
    }
    if (w === 'classdef') {
      const m = CLASSDEF_RE.exec(st.text)
      if (m !== null) {
        push('classdef', spans.open(m[1]!, 'class', st.line))
        previous = st.endLine
        continue
      }
    }
    if (frame?.word === 'classdef' && BLOCK_RE.test(st.text)) {
      push(w, undefined)
    } else if (frame?.word === 'function' && !frame.sawStatement && ARGUMENTS_RE.test(st.text)) {
      push('arguments', undefined)
    } else if (CONTROL_OPENERS.has(w) && !/^\w+\s*=[^=]/.test(st.text)) {
      push(w, undefined)
    } else if (frame !== undefined && (frame.word === 'properties' || frame.word === 'events' || frame.word === 'enumeration') && w !== '') {
      const kind = frame.word === 'properties' ? 'property' : frame.word === 'events' ? 'event' : 'enum_member'
      const cls = spans.name(nearest(CLASS)?.index)
      spans.close(spans.open(w, kind, st.line, cls), st.endLine)
    } else if (w === 'import') {
      const m = IMPORT_RE.exec(st.text)
      if (m !== null) imports.push({ kind: 'import', target: m[1]!, line: st.line })
    }
    // A function may open with several arguments blocks (inputs, then outputs), so only other statements end that window.
    if (frame !== undefined && w !== 'arguments') frame.sawStatement = true
    previous = st.endLine
  }
  while (stack.length > 0) spans.close(stack.pop()!.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}
