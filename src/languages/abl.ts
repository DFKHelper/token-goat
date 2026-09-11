/**
 * Progress OpenEdge ABL adapter: internal PROCEDUREs and FUNCTIONs, CLASS, INTERFACE and ENUM types with their METHODs,
 * CONSTRUCTORs and DESTRUCTORs as children, and DEFINE TEMP-TABLE outside a routine. A statement ends at a period, and a
 * block header at a colon, followed by whitespace; every other colon-ended header (DO:, FOR EACH x:, CASE x:, CATCH, ON ...
 * DO:) is tracked only so each END closes the right block. `/* ... *\/` comments (which nest), `//` comments, quoted strings
 * (with `~` escapes), `{...}` include references and `&` preprocessor lines never produce symbols. Keywords are
 * case-insensitive. Imports are `{file.i}` include references and USING types.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, wordBeforeParen, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  /** Statement text with comments and include references removed and string contents blanked. */
  readonly text: string
  readonly line: number
  readonly endLine: number
  /** `:` for a block header, `.` for a statement. */
  readonly terminator: string
}

interface Scan {
  readonly statements: Statement[]
  readonly includes: AdapterImport[]
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f'
}

function ablStatements(rawLines: readonly string[]): Scan {
  const statements: Statement[] = []
  const includes: AdapterImport[] = []
  let text = ''
  let start = 0
  let quote = ''
  let comment = 0
  let brace = 0
  let braceText = ''
  let braceLine = 0
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!
    if (comment === 0 && quote === '' && brace === 0 && text.trim() === '' && line.trimStart().startsWith('&')) continue
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!
      if (comment > 0) {
        if (ch === '/' && line[j + 1] === '*') {
          comment++
          j++
        } else if (ch === '*' && line[j + 1] === '/') {
          comment--
          j++
        }
        continue
      }
      if (brace > 0) {
        if (ch === '{') brace++
        else if (ch === '}') brace--
        if (brace === 0) {
          const target = braceText.trim().split(/\s+/)[0] ?? ''
          // `{&name}` is a preprocessor name and `{1}` an include argument; only a file reference is an import.
          if (target !== '' && !/^[&\d*]/.test(target)) includes.push({ kind: 'include', target, line: braceLine })
          text += ' '
        } else braceText += ch
        continue
      }
      if (quote !== '') {
        if (ch === '~') {
          text += '  '
          j++
        } else if (ch === quote) {
          quote = ''
          text += ch
        } else text += ' '
        continue
      }
      if (ch === '/' && line[j + 1] === '*') {
        comment = 1
        j++
        continue
      }
      if (ch === '/' && line[j + 1] === '/') break
      if (ch === '{') {
        brace = 1
        braceText = ''
        braceLine = i + 1
        continue
      }
      if ((ch === '.' || ch === ':') && isSpace(line[j + 1])) {
        const t = text.trim()
        if (t !== '') statements.push({ text: t, line: start, endLine: i + 1, terminator: ch })
        text = ''
        start = 0
        continue
      }
      if (ch === '"' || ch === "'") quote = ch
      if (start === 0 && !isSpace(ch)) start = i + 1
      text += ch
    }
    text += ' '
  }
  return { statements, includes }
}

const isWordChar = (ch: string): boolean => /[\w#$%&-]/.test(ch)

/** True when `word` is `full` or an abbreviation of it at least `min` characters long. */
function keyword(word: string, full: string, min: number): boolean {
  return word.length >= min && full.startsWith(word)
}

// Single words that open a block by themselves; any other lone word before a colon is a block label.
const LONE_BLOCK_WORDS: ReadonlySet<string> = new Set(['DO', 'REPEAT', 'FINALLY', 'GET', 'SET'])
const TYPE_KINDS: ReadonlyMap<string, string> = new Map([
  ['CLASS', 'class'],
  ['INTERFACE', 'interface'],
  ['ENUM', 'enum'],
])
const MEMBER_KINDS: ReadonlyMap<string, string> = new Map([
  ['METHOD', 'method'],
  ['CONSTRUCTOR', 'constructor'],
  ['DESTRUCTOR', 'destructor'],
])
const DEFINE_MODIFIERS: ReadonlySet<string> = new Set(['NEW', 'GLOBAL', 'SHARED', 'PRIVATE', 'PROTECTED', 'PACKAGE-PRIVATE', 'PACKAGE-PROTECTED', 'PUBLIC', 'STATIC', 'SERIALIZABLE', 'NON-SERIALIZABLE'])

interface Open {
  readonly index: number | undefined
  /** `type` for a class, interface or enum; `routine` for a procedure, function, method, constructor or destructor. */
  readonly role: 'type' | 'routine' | 'block'
}

/** The last dotted segment of a type name: `acme.inventory.Item` is looked up as `Item`. */
function typeName(word: string): string {
  const dot = word.lastIndexOf('.')
  return dot >= 0 ? word.slice(dot + 1) : word
}

export function extractAbl(content: string, filePath: string): StatementAdapterResult {
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const { statements, includes } = ablStatements(rawLines)
  const imports: AdapterImport[] = [...includes]
  const stack: Open[] = []
  let previous = 0

  const owner = (): string => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.role === 'type') return spans.name(stack[k]!.index)
    return ''
  }
  const inRoutine = (): boolean => stack.some((o) => o.role === 'routine')

  for (const st of statements) {
    const words = st.text.split(/\s+/)
    const upper = words.map((w) => w.toUpperCase())
    const w0 = upper[0]!
    if (st.terminator === ':') {
      if (words.length === 1 && !LONE_BLOCK_WORDS.has(w0.replace(/\(.*$/, ''))) continue
      if (keyword(w0, 'PROCEDURE', 5)) {
        stack.push({ index: spans.open(words[1] ?? '', 'procedure', st.line), role: 'routine' })
      } else if (w0 === 'FUNCTION') {
        stack.push({ index: spans.open(wordBeforeParen(words[1] ?? '', isWordChar) || (words[1] ?? ''), 'function', st.line), role: 'routine' })
      } else if (TYPE_KINDS.has(w0)) {
        stack.push({ index: spans.open(typeName(words[1] ?? ''), TYPE_KINDS.get(w0)!, st.line), role: 'type' })
      } else if (MEMBER_KINDS.has(w0)) {
        stack.push({ index: spans.open(wordBeforeParen(st.text, isWordChar), MEMBER_KINDS.get(w0)!, st.line, owner()), role: 'routine' })
      } else {
        stack.push({ index: undefined, role: 'block' })
      }
    } else if (w0 === 'END') {
      const o = stack.pop()
      if (o) spans.close(o.index, st.endLine)
    } else if (MEMBER_KINDS.has(w0) && owner() !== '' && !inRoutine()) {
      // An abstract or interface method: one statement, no body.
      spans.open(wordBeforeParen(st.text, isWordChar), MEMBER_KINDS.get(w0)!, st.line, owner())
    } else if (keyword(w0, 'DEFINE', 3) && !inRoutine()) {
      let k = 1
      while (k < upper.length && DEFINE_MODIFIERS.has(upper[k]!)) k++
      if (upper[k] === 'TEMP-TABLE' && words[k + 1] !== undefined) spans.close(spans.open(words[k + 1]!, 'temp_table', st.line, owner()), st.endLine)
    } else if (w0 === 'USING' && words[1] !== undefined) {
      imports.push({ kind: 'import', target: words[1], line: st.line })
    }
    previous = st.endLine
  }
  for (const o of stack) spans.close(o.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}

// The ABL sniff lives in sniff.ts so language detection on the hook path does not load this adapter.
export { ABL_SNIFF_CHARS, isAblSource } from './sniff.js'
