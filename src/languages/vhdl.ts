/**
 * VHDL adapter: entity, architecture, package declaration, package body, function and procedure.
 *
 * VHDL block headers are not terminated by punctuation the way a statement is (`;`): they are
 * terminated by the keyword `is` (`entity foo is`, `architecture rtl of foo is`, `package body p
 * is`, `function f(...) return bit is`, `procedure p(...) is`), after which the block's own
 * declarative items and statements each end with `;` up to the header's matching
 * `end [<kind>] [<name>];`. This adapter tokenizes VHDL as a sequence of statements the way the
 * ABL/SAS/PL/I/RPG/JCL adapters do (`span_collector.ts`), but splits on two different terminators:
 * a top-level `;` for an ordinary statement, and a standalone `is` word for one of the five header
 * keywords above. A statement whose own leading keyword is IF/CASE/LOOP/GENERATE/RECORD/PROCESS/
 * BLOCK/FOR/COMPONENT/UNITS/PROTECTED also uses `is`, `then` or a bare keyword to open, and its own
 * `end <kind>;`/`end;` to close, but this adapter does not open a stack frame for those -- it just
 * recognizes their closing keyword and leaves the real (entity/architecture/package/function/
 * procedure) stack alone, so a `end if;`/`end loop;`/`end case;`/`end generate;`/`end record;`
 * inside a function or process body never pops the function/procedure frame early. A design unit
 * closed the old way, with the keyword omitted (`end foo;` or bare `end;`), also pops the
 * innermost real frame: the LRM makes the keyword optional only for entity/architecture/package/
 * subprogram/process/block, never for if/case/loop/generate, so an unrecognized or absent keyword
 * after `end` is unambiguously one of ours.
 *
 * Per IEEE 1076-2008 clause 15.9, a VHDL-2008 delimited comment (`/* ... *\/`) does NOT nest: the
 * first `*\/` closes it, however many `/*` appeared inside. `--` line comments run to end of line.
 * String literals (`"..."`, with `""` as an escaped quote) and character literals (`'x'`, told
 * apart from the `'` attribute-name tick by requiring a non-identifier character immediately
 * before the opening `'`) are masked to spaces before any keyword matching, so neither can produce
 * a false header or `end`. VHDL keywords and identifiers are case-insensitive throughout.
 *
 * Declarations with no body (a `function`/`procedure` prototype in a package spec, ending `;`
 * with no `is`) produce no symbol, matching this repo's convention elsewhere of only listing a
 * declaration that has a body. Bit-string, based and operator-symbol (`function "+"`) names are
 * out of scope for v1: an operator function's masked `"+"` name resolves to an empty string and is
 * dropped rather than mis-attributed.
 *
 * Imports are `use` clause targets (`use ieee.std_logic_1164.all;` -> `ieee.std_logic_1164.all`).
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine, type AdapterImport } from './common.js'

const HEADER_RE = /^\s*(ENTITY|ARCHITECTURE|PACKAGE(?:\s+BODY)?|FUNCTION|PROCEDURE)\b/i
const ENTITY_RE = /^\s*ENTITY\s+([A-Za-z_]\w*)\s+IS\s*$/i
const ARCH_RE = /^\s*ARCHITECTURE\s+([A-Za-z_]\w*)\s+OF\s+([A-Za-z_]\w*)\s+IS\s*$/i
const PKG_BODY_RE = /^\s*PACKAGE\s+BODY\s+([A-Za-z_]\w*)\s+IS\s*$/i
const PKG_RE = /^\s*PACKAGE\s+([A-Za-z_]\w*)\s+IS\s*$/i
const FUNC_RE = /^\s*(?:IMPURE\s+|PURE\s+)?FUNCTION\s+([A-Za-z_]\w*|"[^"]*")/i
const PROC_RE = /^\s*PROCEDURE\s+([A-Za-z_]\w*|"[^"]*")/i
const USE_RE = /^\s*USE\s+([A-Za-z_][\w.]*)/i
const END_KEYWORD_RE = /^\s*END\b\s*([A-Za-z_]\w*)?/i

// Keywords VHDL also closes with `end <kw>;` that this adapter never opens a frame for. An `end`
// naming one of these is a no-op here rather than a pop of the innermost real (entity/
// architecture/package/function/procedure) frame.
const IGNORED_END_KEYWORDS: ReadonlySet<string> = new Set([
  'IF', 'CASE', 'LOOP', 'GENERATE', 'RECORD', 'PROCESS', 'BLOCK', 'FOR', 'COMPONENT', 'UNITS', 'PROTECTED',
])

type FrameKind = 'entity' | 'architecture' | 'package' | 'package_body' | 'function' | 'procedure'

interface Frame {
  readonly index: number | undefined
  readonly kind: FrameKind
}

interface Stmt {
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
}

/** Masks `--` line comments, non-nesting `/* *\/` block comments, string literals and character
 * literals to spaces (newlines preserved), so keyword/statement scanning never sees their content. */
function maskVhdl(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  let i = 0
  let inBlockComment = false
  while (i < n) {
    const ch = content[i]!
    if (inBlockComment) {
      if (ch === '*' && content[i + 1] === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        inBlockComment = false
        continue
      }
      out[i] = ch === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (ch === '-' && content[i + 1] === '-') {
      while (i < n && content[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      inBlockComment = true
      continue
    }
    if (ch === '"') {
      out[i] = '"'
      i++
      while (i < n) {
        if (content[i] === '"' && content[i + 1] === '"') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (content[i] === '"') {
          out[i] = '"'
          i++
          break
        }
        if (content[i] === '\n') break
        out[i] = ' '
        i++
      }
      continue
    }
    // A character literal is exactly `'x'` (three characters). Told apart from the attribute
    // tick (`clk'event`) by requiring the preceding emitted character not be an identifier char.
    if (ch === "'" && content[i + 2] === "'" && content[i + 1] !== undefined && content[i + 1] !== '\n') {
      const prevEmitted = i > 0 ? out[i - 1] : undefined
      if (prevEmitted === undefined || !/[A-Za-z0-9_]/.test(prevEmitted)) {
        out[i] = "'"
        out[i + 1] = ' '
        out[i + 2] = "'"
        i += 3
        continue
      }
    }
    out[i] = ch
    i++
  }
  return out.join('')
}

/** Splits masked VHDL into `;`-terminated statements plus header statements ending in a standalone
 * `is` after one of the five tracked opening keywords (paren-depth aware, so a parameter list's
 * own `;`/`is` never fires early). */
function splitStatements(masked: string): Stmt[] {
  const stmts: Stmt[] = []
  const n = masked.length
  let depth = 0
  let stmtStart = 0
  let wordStart = -1
  let i = 0
  const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  while (i <= n) {
    const ch = i < n ? masked[i]! : ' '
    if (isWordChar(ch)) {
      if (wordStart < 0) wordStart = i
      i++
      continue
    }
    if (wordStart >= 0) {
      const word = masked.slice(wordStart, i)
      if (depth === 0 && word.length === 2 && /^is$/i.test(word)) {
        const headText = masked.slice(stmtStart, i)
        if (HEADER_RE.test(headText)) {
          stmts.push({ text: headText, startOffset: stmtStart, endOffset: i })
          stmtStart = i
        }
      }
      wordStart = -1
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      stmts.push({ text: masked.slice(stmtStart, i), startOffset: stmtStart, endOffset: i })
      stmtStart = i + 1
    }
    i++
  }
  return stmts
}

function headerFrame(text: string): { kind: FrameKind; name: string } | undefined {
  let m = ENTITY_RE.exec(text)
  if (m) return { kind: 'entity', name: m[1]! }
  m = ARCH_RE.exec(text)
  if (m) return { kind: 'architecture', name: m[1]! }
  m = PKG_BODY_RE.exec(text)
  if (m) return { kind: 'package_body', name: m[1]! }
  m = PKG_RE.exec(text)
  if (m) return { kind: 'package', name: m[1]! }
  m = FUNC_RE.exec(text)
  if (m && !m[1]!.startsWith('"')) return { kind: 'function', name: m[1]! }
  m = PROC_RE.exec(text)
  if (m && !m[1]!.startsWith('"')) return { kind: 'procedure', name: m[1]! }
  return undefined
}

export function extractVhdl(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskVhdl(content)
  const lineIndex = buildLineIndex(masked)
  const lineOf = (offset: number): number => offsetToLine(lineIndex, offset)
  const stmts = splitStatements(masked)
  const spans = new SpanCollector(filePath)
  const imports: AdapterImport[] = []
  const stack: Frame[] = []
  let previous = 0

  const owner = (): string => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const kind = stack[k]!.kind
      if (kind === 'architecture' || kind === 'package' || kind === 'package_body') return spans.name(stack[k]!.index)
    }
    return ''
  }

  for (const st of stmts) {
    const frame = headerFrame(st.text)
    if (frame) {
      const index = spans.open(frame.name, frame.kind === 'package_body' ? 'package body' : frame.kind, lineOf(st.startOffset), owner())
      stack.push({ index, kind: frame.kind })
      previous = lineOf(st.endOffset)
      continue
    }
    const endMatch = END_KEYWORD_RE.exec(st.text)
    if (endMatch) {
      const kw = endMatch[1]?.toUpperCase()
      if (kw === undefined || !IGNORED_END_KEYWORDS.has(kw)) {
        const top = stack.pop()
        if (top) spans.close(top.index, lineOf(st.endOffset))
      }
      previous = lineOf(st.endOffset)
      continue
    }
    const useMatch = USE_RE.exec(st.text)
    if (useMatch) imports.push({ kind: 'use', target: useMatch[1]!, line: lineOf(st.startOffset) })
    previous = lineOf(st.endOffset)
  }
  for (const top of stack) spans.close(top.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}
