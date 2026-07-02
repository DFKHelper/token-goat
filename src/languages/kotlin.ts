/**
 * Kotlin symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, interfaces, objects, data classes, sealed classes,
 * companion objects, top-level functions, methods, and SCREAMING_SNAKE const vals.
 * Import directives are returned as import entries.
 */

import type { SymbolEntry } from '../parser_types.js'
import { stripBlockCommentSpan, stripLineComment } from './common.js'

export interface KotlinImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

const IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/

const FUN_RE = new RegExp(
  '^\\s*(?:(?:public|internal|protected|private|open|override|abstract|' +
  'suspend|inline|infix|operator|external|actual|expect|final|sealed)\\s+)*' +
  'fun\\s+(?:<[^>]*>\\s*)?([A-Za-z_][A-Za-z0-9_]*)\\s*[(<]',
)

const CONST_RE = new RegExp(
  '^\\s*(?:(?:public|internal|protected|private|open|override|abstract|' +
  'final|actual|expect|const|lateinit|companion)\\s+)*' +
  '(?:const\\s+)?val\\s+([A-Z_][A-Z0-9_]*)\\s*(?::|=)',
)

const CLASS_HEADER_RE = new RegExp(
  '^(?:(?:public|internal|protected|private|open|abstract|sealed|data|' +
  'inner|expect|actual|value|annotation)\\s+)*' +
  '(?:class|interface|object|enum\\s+class)\\s+([A-Za-z_][A-Za-z0-9_]*)',
)

const TOP_FUN_RE = new RegExp(
  '^(?:(?:public|internal|private|suspend|inline|infix|operator|' +
  'external|actual|expect)\\s+)*' +
  'fun\\s+(?:<[^>]*>\\s*)?([A-Za-z_][A-Za-z0-9_]*)\\s*[(<]',
)

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  line: number,
  sig?: string,
  parent?: string,
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: line,
    lineEnd: line,
    body: sig ?? '',
    docstring: parent ?? '',
  }
}

export function extractKotlin(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: KotlinImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: KotlinImport[] = []
  const lines = content.split(/\r?\n/)

  let currentClass: string | null = null
  let classBraceDepth = 0
  // True once braceDepth has risen above classBraceDepth at least once, i.e. the class's own
  // opening brace has actually been consumed. Guards the pop check below: for a class whose
  // primary-constructor header spans multiple lines (`class Foo(\n  val x: Int\n) {`),
  // braceDepth still equals classBraceDepth on the header line itself, so an ungated pop check
  // fires immediately and discards the class context before its body is ever seen.
  let classBodyEntered = false
  let braceDepth = 0
  let inComment = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip /* */ block-comment spans (state carried across lines via inComment) so braces
    // inside commented-out code are not counted toward braceDepth. A `/*` inside an open quote
    // is not treated as a comment opener.
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment (quote-aware) so braces/text after it are ignored.
    const line = stripLineComment(blockStripped)
    const stripped = line.trim()

    if (!stripped) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // import
    const importM = IMPORT_RE.exec(stripped)
    if (importM) {
      imports.push({ kind: 'import', target: importM[1] ?? '', line: lineNum })
    }

    // Class/interface/object declaration (must be at column 0)
    const cm = isIndented ? null : CLASS_HEADER_RE.exec(line)
    if (cm) {
      const cname = cm[1] ?? ''
      symbols.push(makeSymbol(filePath, cname, 'class', lineNum, line.trimEnd().slice(0, 200)))
      currentClass = cname
      classBraceDepth = braceDepth
      classBodyEntered = false
    }

    if (currentClass !== null) {
      const depthInClass = braceDepth - classBraceDepth
      if (depthInClass >= 1) {
        const fm = FUN_RE.exec(line)
        if (fm) {
          const fname = fm[1] ?? ''
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trim() : line.trimEnd()
          symbols.push(makeSymbol(filePath, fname, 'method', lineNum, sig.slice(0, 200), currentClass))
        }
        const constM = CONST_RE.exec(line)
        if (constM) {
          symbols.push(makeSymbol(filePath, constM[1] ?? '', 'const', lineNum, stripped.slice(0, 200), currentClass))
        }
      }
    } else if (!isIndented) {
      const tfm = TOP_FUN_RE.exec(line)
      if (tfm) {
        const fname = tfm[1] ?? ''
        const sigEnd = line.indexOf('{')
        const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trim() : line.trimEnd()
        symbols.push(makeSymbol(filePath, fname, 'function', lineNum, sig.slice(0, 200)))
      }
      // Top-level SCREAMING_SNAKE const/val declarations (no parent class).
      const topConstM = CONST_RE.exec(line)
      if (topConstM) {
        symbols.push(makeSymbol(filePath, topConstM[1] ?? '', 'const', lineNum, stripped.slice(0, 200)))
      }
    }

    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length

    if (currentClass !== null && braceDepth > classBraceDepth) {
      classBodyEntered = true
    }
    if (currentClass !== null && classBodyEntered && braceDepth <= classBraceDepth) {
      currentClass = null
    }
  }

  return { symbols, imports }
}
