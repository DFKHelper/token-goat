/**
 * Kotlin symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, interfaces, objects, data classes, sealed classes,
 * companion objects, top-level functions, methods, and SCREAMING_SNAKE const vals.
 * Import directives are returned as import entries.
 */

import type { SymbolEntry } from '../parser_types.js'

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
  let braceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const stripped = line.trim()

    if (!stripped || stripped.startsWith('//')) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      continue
    }

    const lineNum = i + 1
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

    if (currentClass !== null && braceDepth <= classBraceDepth) {
      currentClass = null
    }
  }

  return { symbols, imports }
}
