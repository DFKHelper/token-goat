/**
 * Shared bookkeeping for the statement-scanning adapters (ABAP, SAS, PL/I, RPG, JCL, OpenEdge ABL): a symbol is opened when its
 * header statement is read, closed when its terminator is reached, and every body is sliced from the raw lines at the end.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { AdapterImport } from './common.js'

/** Symbols plus the import targets an adapter read on the same pass, so `imports` and the index agree on comments and strings. */
export interface StatementAdapterResult {
  readonly symbols: SymbolEntry[]
  readonly imports: AdapterImport[]
}

const MAX_SYMBOLS = 10_000
const MAX_NAME_LENGTH = 120

export class SpanCollector {
  private readonly items: SymbolEntry[] = []

  constructor(private readonly filePath: string) {}

  /** Record a symbol that starts and, until {@link close} says otherwise, ends on `line`; undefined when the name is unusable or the cap is reached. */
  open(name: string, kind: string, line: number, parent = ''): number | undefined {
    if (name === '' || name.length > MAX_NAME_LENGTH || this.items.length >= MAX_SYMBOLS) return undefined
    this.items.push({ filePath: this.filePath, name, kind, lineStart: line, lineEnd: line, body: '', docstring: '', parent })
    return this.items.length - 1
  }

  close(index: number | undefined, end: number): void {
    if (index === undefined) return
    const sym = this.items[index]!
    this.items[index] = { ...sym, lineEnd: Math.max(sym.lineStart, end) }
  }

  name(index: number | undefined): string {
    return index === undefined ? '' : this.items[index]!.name
  }

  /** The collected symbols, each with its body sliced from `rawLines`. */
  finish(rawLines: readonly string[]): SymbolEntry[] {
    return this.items.map((s) => ({ ...s, body: rawLines.slice(s.lineStart - 1, s.lineEnd).join('\n') }))
  }
}

/** The identifiers of `text` outside parentheses, in order: `WHEN (a, b) DO` gives WHEN and DO. Linear, no regex. */
export function topLevelWords(text: string, isWordChar: (ch: string) => boolean): string[] {
  const out: string[] = []
  let depth = 0
  let word = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && isWordChar(ch)) {
      word += ch
      continue
    }
    if (word !== '') out.push(word)
    word = ''
  }
  if (word !== '') out.push(word)
  return out
}

/** The identifier immediately before the first `(` in `text`, found by scanning back from that parenthesis rather than with a regex. */
export function wordBeforeParen(text: string, isWordChar: (ch: string) => boolean): string {
  const paren = text.indexOf('(')
  if (paren < 0) return ''
  let end = paren
  while (end > 0 && /\s/.test(text[end - 1]!)) end--
  let start = end
  while (start > 0 && isWordChar(text[start - 1]!)) start--
  return text.slice(start, end)
}
