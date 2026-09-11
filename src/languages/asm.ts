/**
 * Assembly adapter for GNU as (`.s`, `.S`), NASM (`.asm`, `.nasm`) and IBM High Level Assembler, which share `.asm`: one
 * adapter that picks its dialect from the file's own content. GAS and NASM contribute labels written with a colon, `.macro`
 * and `%macro` definitions, and NASM `struc` structures, with `.include` and `%include` as imports. HLASM contributes named
 * control sections (`CSECT`, `DSECT`, `RSECT`, `START`) and `MACRO` definitions named by their prototype statement.
 *
 * A local label (one whose name starts with a period, as GAS `.L1` and NASM `.loop` do) and a colonless NASM label never
 * produce a symbol: a colonless label cannot be told from a directive such as `section .text` without a keyword list, and
 * fewer correct symbols beat more wrong ones. `;`, `#` and `//` line comments, block comments, HLASM `*` comment
 * statements, and everything past the HLASM continuation-indicator column are skipped.
 */

import { lastContentLine, type AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

/**
 * A statement only HLASM writes: an operation field of CSECT, DSECT, RSECT, MACRO or MEND, uppercase as every HLASM source
 * writes them, with an optional name field before it. NASM's `section .text` and GAS's `.macro` do not match.
 */
const HLASM_MARKER_RE = /^(?:[A-Z@#$][A-Z0-9@#$_]*)?[ \t]+(?:CSECT|DSECT|RSECT|MACRO|MEND)(?:[ \t]|$)/

/** Columns 1-71 hold the statement; column 72 is the continuation-indicator field. */
const HLASM_STATEMENT_COLUMNS = 71

/** A label definition: an identifier at the start of a statement followed by a colon. */
const LABEL_RE = /^[ \t]*([A-Za-z_$?.][A-Za-z0-9_$#@~?.]*):/
const GAS_MACRO_RE = /^[ \t]*\.macro[ \t]+([A-Za-z_$.][A-Za-z0-9_$.]*)/
const GAS_ENDM_RE = /^[ \t]*\.endm\b/
const NASM_MACRO_RE = /^[ \t]*%i?macro[ \t]+([A-Za-z_$?.][A-Za-z0-9_$#@~?.]*)/i
const NASM_ENDMACRO_RE = /^[ \t]*%i?endmacro\b/i
const NASM_STRUC_RE = /^[ \t]*struc[ \t]+([A-Za-z_$?.][A-Za-z0-9_$#@~?.]*)/i
const NASM_ENDSTRUC_RE = /^[ \t]*endstruc\b/i
const INCLUDE_RE = /^[ \t]*(?:\.include|%include)[ \t]+"([^"]*)"/i
/** The name field and the operation field of an HLASM statement, both ending at the first blank. */
const HLASM_STATEMENT_RE = /^(\S*)[ \t]+(\S+)/

/** True when the file is IBM High Level Assembler rather than GAS or NASM. */
export function isHlasmSource(content: string): boolean {
  for (const raw of content.split(/\r?\n/)) {
    if (raw.startsWith('*')) continue
    if (HLASM_MARKER_RE.test(raw.slice(0, HLASM_STATEMENT_COLUMNS))) return true
  }
  return false
}

/** A frame on the open-block stack: a macro or structure whose members take its name as their parent. */
interface Frame {
  readonly index: number | undefined
  readonly kind: 'macro' | 'struct'
}

/** Strip the comment part of one GAS or NASM line, carrying block-comment state across lines. */
function stripComment(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = ''
  let block = inBlock
  let i = 0
  let quote = ''
  while (i < line.length) {
    const ch = line[i]!
    if (block) {
      if (ch === '*' && line[i + 1] === '/') {
        block = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (quote !== '') {
      if (ch === '\\') {
        out += '  '
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      out += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && line[i + 1] === '*') {
      block = true
      i += 2
      continue
    }
    if (ch === ';' || ch === '#' || (ch === '/' && line[i + 1] === '/')) break
    out += ch
    i++
  }
  return { code: out, inBlock: block }
}

/** GAS and NASM: labels, macro definitions, NASM structures, and `.include`/`%include` targets. */
function extractGasNasm(rawLines: readonly string[], spans: SpanCollector, imports: AdapterImport[]): void {
  const stack: Frame[] = []
  let label: number | undefined
  let inBlock = false
  const parent = (): string => (stack.length === 0 ? '' : spans.name(stack[stack.length - 1]!.index))
  const endLabel = (end: number): void => {
    spans.close(label, end)
    label = undefined
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = i + 1
    const stripped = stripComment(rawLines[i]!, inBlock)
    inBlock = stripped.inBlock
    const code = stripped.code
    if (code.trim() === '') continue

    const include = INCLUDE_RE.exec(code)
    if (include) {
      imports.push({ kind: 'include', target: include[1]!, line })
      continue
    }

    const open = GAS_MACRO_RE.exec(code) ?? NASM_MACRO_RE.exec(code)
    if (open) {
      endLabel(line - 1)
      stack.push({ index: spans.open(open[1]!, 'macro', line, parent()), kind: 'macro' })
      continue
    }
    const struc = NASM_STRUC_RE.exec(code)
    if (struc) {
      endLabel(line - 1)
      stack.push({ index: spans.open(struc[1]!, 'struct', line, parent()), kind: 'struct' })
      continue
    }
    if (GAS_ENDM_RE.test(code) || NASM_ENDMACRO_RE.test(code) || NASM_ENDSTRUC_RE.test(code)) {
      endLabel(line - 1)
      const frame = stack.pop()
      if (frame !== undefined) spans.close(frame.index, line)
      continue
    }

    const found = LABEL_RE.exec(code)
    if (found) {
      const name = found[1]!
      // A local label (`.L1`, `.loop`) belongs to the label above it and is not a definition of its own.
      if (name.startsWith('.')) continue
      endLabel(line - 1)
      label = spans.open(name, 'label', line, parent())
    }
  }
  endLabel(lastContentLine(rawLines))
  for (const frame of stack) spans.close(frame.index, lastContentLine(rawLines))
}

/** HLASM: named control sections, and macro definitions named by the prototype statement that follows MACRO. */
function extractHlasm(rawLines: readonly string[], spans: SpanCollector): void {
  let section: number | undefined
  let macro: number | undefined
  let macroStart = 0
  let awaitingPrototype = false
  let continued = false

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    const line = i + 1
    const statement = raw.slice(0, HLASM_STATEMENT_COLUMNS)
    const continues = raw.length > HLASM_STATEMENT_COLUMNS && raw[HLASM_STATEMENT_COLUMNS]!.trim() !== ''
    if (continued) {
      continued = continues
      continue
    }
    continued = continues
    // A comment statement carries an asterisk in the begin column; `.*` is the macro-comment form.
    if (statement.startsWith('*') || statement.startsWith('.*')) continue
    if (statement.trim() === '') continue

    const m = HLASM_STATEMENT_RE.exec(statement)
    if (!m) continue
    const name = m[1]!
    const op = m[2]!.toUpperCase()

    if (awaitingPrototype) {
      awaitingPrototype = false
      // The prototype's operation field establishes the name the macro is called by.
      macro = spans.open(op, 'macro', macroStart, spans.name(section))
      continue
    }
    if (op === 'MACRO') {
      awaitingPrototype = true
      macroStart = line
      continue
    }
    if (op === 'MEND') {
      spans.close(macro, line)
      macro = undefined
      continue
    }
    if (macro !== undefined) continue
    if (op === 'CSECT' || op === 'RSECT' || op === 'START' || op === 'DSECT') {
      spans.close(section, line - 1)
      section = name === '' ? undefined : spans.open(name, op === 'DSECT' ? 'dummy section' : 'section', line)
      continue
    }
    if (op === 'END') {
      spans.close(section, line)
      section = undefined
    }
  }
  spans.close(macro, lastContentLine(rawLines))
  spans.close(section, lastContentLine(rawLines))
}

export function extractAsm(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  if (isHlasmSource(content)) extractHlasm(rawLines, spans)
  else extractGasNasm(rawLines, spans, imports)
  return { symbols: spans.finish(rawLines), imports }
}
