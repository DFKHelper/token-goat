/**
 * PHP symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, traits, enums, functions,
 * methods, properties, constants, and use/require import directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import { stripBlockCommentSpan, stripStringLiterals } from './common.js'

export interface PhpImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

const NAMESPACE_RE = /^namespace\s+([\w\\]+)\s*;/
const CLASS_RE = /^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
const METHOD_RE = new RegExp(
  '^(?:(?:public|protected|private|static|abstract|final)\\s+)*' +
  'function\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(',
)
const ANON_FN_RE = /^\s*function\s*\(/
const CONST_RE = /^(?:(?:public|protected|private|static)\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)/
const DEFINE_RE = /^define\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/
const PROP_RE = new RegExp(
  '^(?:(?:public|protected|private|static|readonly)\\s+)+' +
  '\\??[A-Za-z_][A-Za-z0-9_|\\\\]*\\s+\\$([A-Za-z_][A-Za-z0-9_]*)',
)
const USE_RE = /^use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/
const REQUIRE_RE = /^(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/

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

export function extractPhp(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: PhpImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: PhpImport[] = []
  const lines = content.split(/\r?\n/)

  // Stack of (className, braceDepthAtEntry)
  const contextStack: Array<[string, number]> = []
  let braceDepth = 0
  let inComment = false

  function currentClass(): string | null {
    return contextStack.length > 0 ? (contextStack[contextStack.length - 1]?.[0] ?? null) : null
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip /* */ block-comment spans (state carried across lines via inComment) and keep the residual code, so a brace or declaration sharing a line with a comment is still counted and parsed - the old line-granular skip dropped them. A `/*` inside an open quote (e.g. glob('src/*.php')) is not treated as a comment opener.
    const { code: codeLine, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment
    const line = codeLine.trimEnd()
    const stripped = line.trimStart()

    if (!stripped || stripped.startsWith('//') || stripped.startsWith('#')) continue

    // Track brace depth. Apply the net delta (opens minus closes) before the pop check so a class's closing brace pops its context on the same line; checking before subtracting closes would leave the stale class on the stack and mis-parent the next top-level declaration.
    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal is never counted as real nesting.
    const braceLine = stripStringLiterals(line)
    const openB = (braceLine.match(/\{/g) ?? []).length
    const closeB = (braceLine.match(/\}/g) ?? []).length
    braceDepth += openB - closeB

    // Pop context when we close the class brace
    while (contextStack.length > 0) {
      const top = contextStack[contextStack.length - 1]
      if (top !== undefined && braceDepth <= top[1]) {
        contextStack.pop()
      } else {
        break
      }
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeSymbol(filePath, nsM[1] ?? '', 'namespace', lineNum, stripped.slice(0, 200)))
      continue
    }

    // use import
    const useM = USE_RE.exec(stripped)
    if (useM) {
      imports.push({ kind: 'import', target: useM[1] ?? '', line: lineNum })
      continue
    }

    // require/include
    const reqM = REQUIRE_RE.exec(stripped)
    if (reqM) {
      imports.push({ kind: 'import', target: reqM[1] ?? '', line: lineNum })
      continue
    }

    // class/interface/trait/enum
    const clsM = CLASS_RE.exec(stripped)
    if (clsM) {
      const name = clsM[1] ?? ''
      const beforeName = stripped.split(name)[0] ?? ''
      const kind = beforeName.includes('interface') ? 'interface'
        : beforeName.includes('trait') ? 'trait'
        : beforeName.includes('enum') ? 'enum'
        : 'class'
      const parent = currentClass()
      symbols.push(makeSymbol(filePath, name, kind, lineNum, stripped.slice(0, 200), parent ?? undefined))
      contextStack.push([name, braceDepth - openB + closeB])
      continue
    }

    // Anonymous function — skip
    if (ANON_FN_RE.test(stripped)) continue

    // method/function
    const methM = METHOD_RE.exec(stripped)
    if (methM) {
      const name = methM[1] ?? ''
      const parent = currentClass()
      const kind = parent ? 'method' : 'function'
      const sigEnd = stripped.indexOf(')')
      const sig = sigEnd >= 0 ? stripped.slice(0, sigEnd + 1) : stripped
      symbols.push(makeSymbol(filePath, name, kind, lineNum, sig.slice(0, 200), parent ?? undefined))
      continue
    }

    // property
    const propM = PROP_RE.exec(stripped)
    if (propM) {
      const name = propM[1] ?? ''
      const parent = currentClass()
      if (parent) {
        symbols.push(makeSymbol(filePath, name, 'var', lineNum, stripped.slice(0, 200), parent))
      }
      continue
    }

    // class constant
    const constM = CONST_RE.exec(stripped)
    if (constM) {
      const name = constM[1] ?? ''
      const parent = currentClass()
      symbols.push(makeSymbol(filePath, name, 'const', lineNum, stripped.slice(0, 200), parent ?? undefined))
      continue
    }

    // global define()
    const defineM = DEFINE_RE.exec(stripped)
    if (defineM) {
      symbols.push(makeSymbol(filePath, defineM[1] ?? '', 'const', lineNum, stripped.slice(0, 200)))
    }
  }

  return { symbols, imports }
}
