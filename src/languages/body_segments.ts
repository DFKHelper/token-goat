/** Splitting one source line into the declarations a type body written on that line holds, for the line-at-a-time adapters whose member matchers anchor at the start of a line: `class Single { function alpha() { return 1; } private $x = 1; const K = 2; }` declares three members, and a matcher run on the whole line sees only the class. Shared by every adapter with that shape, so where one member ends is decided once. */

import type { SymbolEntry } from '../parser_types.js'

/** One declaration's slice of a line: `code.slice(start, end)`. `open` is set on the last slice when a block it opened is still open at the end of the line, so the member's body runs on into later lines. */
export interface BodySegment {
  readonly start: number
  readonly end: number
  readonly open: boolean
}

/** The declarations in `code` from `from` on, where `from` sits just inside a body's opening brace or at the start of a line that is already inside one. A declaration ends at a `;`, or at the `}` closing a block it opened, outside every parenthesis and bracket; the scan stops at the `}` that closes the body itself. `code` must have its string literals and comments blanked, offset for offset, so a brace or `;` inside one is text. stripStringLiterals keeps the quotes and the code of an interpolation hole (`"a${x}b"` becomes `" ${x} "`), so everything between a `"` and the next one is skipped: the hole's `}` would otherwise end the declaration inside its own string. Slices holding nothing but whitespace and `;` are left out. */
export function bodySegments(code: string, from: number): BodySegment[] {
  const out: BodySegment[] = []
  let braces = 0
  let nest = 0
  let inString = false
  let start = from
  const cut = (end: number): void => {
    if (/[^\s;]/.test(code.slice(start, end))) out.push({ start, end, open: false })
    start = end
  }
  for (let i = from; i < code.length; i++) {
    const ch = code[i]
    if (ch === '"') inString = !inString
    else if (inString) continue
    else if (ch === '(' || ch === '[') nest++
    else if (ch === ')' || ch === ']') nest = Math.max(0, nest - 1)
    else if (ch === '{') braces++
    else if (ch === '}') {
      if (braces === 0) {
        cut(i)
        return out
      }
      braces--
      if (braces === 0 && nest === 0) cut(i + 1)
    } else if (ch === ';' && braces === 0 && nest === 0) cut(i + 1)
  }
  if (/[^\s;]/.test(code.slice(start))) out.push({ start, end: code.length, open: braces > 0 })
  return out
}

/** The offset of the `{` opening the body of the declaration that starts at `from` in `code`, a string-blanked line: the first one outside every parenthesis before `to`, so a lambda default in a constructor parameter is not taken for the body. -1 when the body does not open there. */
export function bodyBraceAt(code: string, from: number, to: number): number {
  let parens = 0
  for (let i = from; i < to; i++) {
    const ch = code[i]
    if (ch === '(') parens++
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (ch === '{' && parens === 0) return i
  }
  return -1
}

/** A member whose block was still open at the end of its line, and the brace depth inside that block: it ends on the first later line that brings the depth back below. */
export interface OpenMember {
  readonly sym: SymbolEntry
  readonly depth: number
}

/** Ends `open` on `lineNum`: its row in `symbols` and in `settled` is replaced by one running through that line, with the lines after its own appended to its body. */
export function endOpenMember(symbols: SymbolEntry[], settled: Set<SymbolEntry>, open: OpenMember, lineNum: number, lines: readonly string[]): void {
  const { sym } = open
  const ended: SymbolEntry = { ...sym, lineEnd: lineNum, body: [sym.body, ...lines.slice(sym.lineStart, lineNum)].join('\n') }
  symbols[symbols.indexOf(sym)] = ended
  settled.delete(sym)
  settled.add(ended)
}

/** `symbols` with the brace-span pass `span` run over every row not in `settled`, in the same order. A member found after the first declaration on its line already carries its real span, and the pass, searching from the start of that line, would reach the type's `{` or an earlier member's and stretch the member over that block instead. */
export function spanUnsettled(symbols: readonly SymbolEntry[], settled: ReadonlySet<SymbolEntry>, span: (rest: SymbolEntry[]) => SymbolEntry[]): SymbolEntry[] {
  const spanned = span(symbols.filter((s) => !settled.has(s)))
  let next = 0
  return symbols.map((s) => (settled.has(s) ? s : spanned[next++]!))
}

/** The offset in `code`, a string-blanked line, just past the `}` that closes the last of the `depthInside` blocks the line starts inside a type body (0 when it starts at the body's own level, -1 when the line never gets back out): where {@link bodySegments} resumes for a line like `return 1; } function g() {}`, whose first half belongs to a member opened on an earlier line. */
export function bodyResumeAt(code: string, depthInside: number): number {
  if (depthInside <= 0) return 0
  let depth = depthInside
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return -1
}

/** A block a line leaves open, found by a one-line-body adapter: `sym` is its row, `level` how many type bodies deeper than the slices scanned it sits (0 for a slice of the line's own body), and `isType` whether it is a nested class, struct or the like, whose later lines hold members of their own. */
export interface OpenBlock {
  readonly sym: SymbolEntry
  readonly level: number
  readonly isType: boolean
}

/** `blocks` as the {@link OpenMember}s that end them, given the brace depth `bodyDepth` of the body the scanned slices sit in. */
export function openMembersOf(blocks: readonly OpenBlock[], bodyDepth: number): OpenMember[] {
  return blocks.map((b) => ({ sym: b.sym, depth: bodyDepth + b.level + 1 }))
}

/** Ends each member of `open` whose block the brace depth `braceDepth` has left, on line `lineNum`, and returns the ones still open. */
export function endOpenMembers(symbols: SymbolEntry[], settled: Set<SymbolEntry>, open: readonly OpenMember[], braceDepth: number, lineNum: number, lines: readonly string[]): OpenMember[] {
  const still: OpenMember[] = []
  for (const m of open) {
    if (braceDepth < m.depth) endOpenMember(symbols, settled, m, lineNum, lines)
    else still.push(m)
  }
  return still
}
