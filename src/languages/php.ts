/**
 * PHP symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, traits, enums, functions,
 * methods, properties, constants, and use/require import directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripMultilineStringSpan,
  stripStringLiterals,
  type MultilineStringState,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

const NAMESPACE_RE = /^namespace\s+([\w\\]+)\s*;/
const CLASS_RE = /^(?:(?:abstract|final)\s+)?(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
const METHOD_RE = new RegExp(
  '^(?:(?:public|protected|private|static|abstract|final)\\s+)*' +
  'function\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(',
)
const ANON_FN_RE = /^\s*function\s*\(/
const CONST_RE = /^(?:(?:public|protected|private|static|final)\s+)*const\s+([A-Za-z_][A-Za-z0-9_]*)/
const DEFINE_RE = /^define\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/
const PROP_RE = new RegExp(
  '^(?:(?:public|protected|private|static|readonly)\\s+)+' +
  '(?:\\??[A-Za-z_][A-Za-z0-9_|\\\\]*\\s+)?' +
  '\\$([A-Za-z_][A-Za-z0-9_]*)',
)
const USE_RE = /^use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/
const REQUIRE_RE = /^(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/

export function extractPhp(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  // Stack of (className, braceDepthAtEntry, bodyEntered)
  const contextStack: Array<[string, number, boolean]> = []
  let braceDepth = 0
  let inComment = false
  let mlState: MultilineStringState | null = null

  function currentClass(): string | null {
    return contextStack.length > 0 ? (contextStack[contextStack.length - 1]?.[0] ?? null) : null
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line PHP heredoc/nowdoc string spans first, state carried across lines, so
    // braces inside one of those can never desync braceDepth. Skipped on lines that start
    // already inside a block comment (mlState null) to avoid misreading comment prose that
    // happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || !inComment) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'php')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (state carried across lines via inComment) and keep the residual code, so a brace or declaration sharing a line with a comment is still counted and parsed - the old line-granular skip dropped them. A `/*` inside an open quote (e.g. glob('src/*.php')) is not treated as a comment opener.
    const { code: codeLine, inComment: nextInComment } = stripBlockCommentSpan(mlLine, inComment)
    inComment = nextInComment
    const line = codeLine.trimEnd()
    const stripped = line.trimStart()

    if (!stripped || stripped.startsWith('//') || stripped.startsWith('#')) continue

    // Track brace depth. Apply the net delta (opens minus closes) before the pop check so a class's closing brace pops its context on the same line; checking before subtracting closes would leave the stale class on the stack and mis-parent the next top-level declaration.
    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal is never counted as real nesting.
    const braceLine = stripStringLiterals(stripLineComment(line, ['//', '#']))
    const openB = (braceLine.match(/\{/g) ?? []).length
    const closeB = (braceLine.match(/\}/g) ?? []).length
    braceDepth += openB - closeB

    // Mark the current frame's body as entered once brace depth has actually risen above its
    // start depth, so a header line with zero net braces (e.g. a multi-line `implements`
    // clause) can't be mistaken for "back down to start" before the class body is ever opened.
    const topFrame = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined
    if (topFrame !== undefined && braceDepth > topFrame[1]) {
      topFrame[2] = true
    }

    // Pop context when we close the class brace. Only pop once bodyEntered is true - this
    // guards multi-line class headers (`class Foo`, `implements Bar, Baz`, `{` each on their
    // own line), where brace depth still equals the frame's start depth on the header line.
    while (contextStack.length > 0) {
      const top = contextStack[contextStack.length - 1]
      if (top !== undefined && top[2] && braceDepth <= top[1]) {
        contextStack.pop()
      } else {
        break
      }
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeLineSymbol(filePath, nsM[1] ?? '', 'namespace', lineNum, stripped.slice(0, 200)))
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
      const kind = clsM[1] ?? 'class'
      const name = clsM[2] ?? ''
      const parent = currentClass()
      symbols.push(makeLineSymbol(filePath, name, kind, lineNum, stripped.slice(0, 200), parent ?? undefined))
      contextStack.push([name, braceDepth - openB + closeB, false])
      if (openB > 0 && openB === closeB) {
        // Self-contained one-liner (`class Foo {}`) - body opens and closes on the declaration
        // line itself, so braceDepth never rises above the frame's start depth and the
        // bodyEntered-gated pop above would never fire. Pop it immediately instead.
        contextStack.pop()
      }
      continue
    }

    // Anonymous function — skip
    if (ANON_FN_RE.test(stripped)) continue

    // method/function
    const methM = METHOD_RE.exec(stripped)
    if (methM) {
      const name = methM[1] ?? ''
      // Depth of this line before its own brace delta is applied (matches the "start depth"
      // convention used when pushing a class frame): a method is directly in the class body
      // only when that pre-line depth is exactly one level deeper than the class frame's own
      // entry depth, not merely nested somewhere inside the class at large.
      const preLineDepth = braceDepth - openB + closeB
      const topFrame = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined
      const parent = topFrame !== undefined && preLineDepth === topFrame[1] + 1 ? topFrame[0] : null
      const kind = parent ? 'method' : 'function'
      const sigEnd = stripped.indexOf(')')
      const sig = sigEnd >= 0 ? stripped.slice(0, sigEnd + 1) : stripped
      symbols.push(makeLineSymbol(filePath, name, kind, lineNum, sig.slice(0, 200), parent ?? undefined))
      continue
    }

    // property
    const propM = PROP_RE.exec(stripped)
    if (propM) {
      const name = propM[1] ?? ''
      const parent = currentClass()
      if (parent) {
        symbols.push(makeLineSymbol(filePath, name, 'var', lineNum, stripped.slice(0, 200), parent))
      }
      continue
    }

    // class constant
    const constM = CONST_RE.exec(stripped)
    if (constM) {
      const name = constM[1] ?? ''
      const parent = currentClass()
      symbols.push(makeLineSymbol(filePath, name, 'const', lineNum, stripped.slice(0, 200), parent ?? undefined))
      continue
    }

    // global define()
    const defineM = DEFINE_RE.exec(stripped)
    if (defineM) {
      symbols.push(makeLineSymbol(filePath, defineM[1] ?? '', 'const', lineNum, stripped.slice(0, 200)))
    }
  }

  return { symbols, imports }
}
