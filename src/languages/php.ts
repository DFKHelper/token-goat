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
const CLASS_RE = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
const METHOD_RE = new RegExp(
  '^(?:(?:public|protected|private|static|abstract|final)\\s+)*' +
  'function\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(',
)
const ANON_FN_RE = /^\s*function\s*\(/
const CONST_RE = /^(?:(?:public|protected|private|static|final)\s+)*const\s+([A-Za-z_][A-Za-z0-9_]*)/
const DEFINE_RE = /^define\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/
// `var` is PHP's legacy property-visibility declarator (a full synonym for `public`), still valid
// syntax in every current PHP version - without it in the alternation, a `var $foo;` property is
// silently dropped from the index entirely, unlike every other property-declaration style.
const PROP_RE = new RegExp(
  '^(?:(?:public|protected|private|static|readonly|var)\\s+)+' +
  '(?:\\??[A-Za-z_][A-Za-z0-9_|\\\\]*\\s+)?' +
  '\\$([A-Za-z_][A-Za-z0-9_]*)',
)
// `use function Foo\bar;` / `use const Foo\BAR;` -- PHP 7's single-symbol imports for a
// namespaced function or constant, distinct from the class-import form GROUP_USE_RE's own
// `function\s+|const\s+` prefix already handles for the brace-group case. Without the same
// optional prefix here, USE_RE's `([\w\\]+)` captured "function"/"const" as if it were the
// imported name itself, then failed to match the trailing `;` (real target text follows), so
// these single-symbol forms were silently dropped entirely rather than merely mis-captured.
const USE_RE = /^use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*;/
// `use App\{Foo, Bar};` -- PHP 7's group-use declaration, idiomatic when importing several
// classes from one namespace -- never matched USE_RE at all: the char class `[\w\\]+` stops at
// `{`, leaving `{Foo, Bar}` where USE_RE's `(?:\s+as\s+\w+)?\s*;` alternative is anchored, so the
// whole regex failed to match and the entire line was silently dropped (not merely truncated).
const GROUP_USE_RE = /^use\s+(?:function\s+|const\s+)?([\w\\]+)\\\{([^}]*)\}/
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

    // use import -- only at top level. Inside a class/interface/trait body, `use Trait;`
    // is a trait-use declaration (mixing a trait's methods into the class), not a namespace
    // import; every other classifier below already gates on contextStack for this same
    // top-level-vs-class-body distinction.
    if (contextStack.length === 0) {
      const groupUseM = GROUP_USE_RE.exec(stripped)
      if (groupUseM) {
        const base = groupUseM[1] ?? ''
        for (const part of (groupUseM[2] ?? '').split(',')) {
          const trimmed = part.trim().replace(/^(?:function|const)\s+/, '')
          if (trimmed === '') continue
          // A rename (`Foo as Bar`) resolves to the original class name callers reference.
          const name = (trimmed.split(/\s+as\s+/)[0] ?? '').trim()
          if (name === '') continue
          imports.push({ kind: 'import', target: `${base}\\${name}`, line: lineNum })
        }
        continue
      }
      const useM = USE_RE.exec(stripped)
      if (useM) {
        imports.push({ kind: 'import', target: useM[1] ?? '', line: lineNum })
        continue
      }
    }

    // require/include
    const reqM = REQUIRE_RE.exec(stripped)
    if (reqM) {
      imports.push({ kind: 'import', target: reqM[1] ?? '', line: lineNum })
      continue
    }

    // class/interface/trait/enum. Attributed to the enclosing class only when declared directly
    // in that class's own body (pre-line depth exactly one level past its frame's start) - same
    // gate as the method/property/const branches below. PHP has no true nested classes: a class
    // declared inside a method body (a legal idiom for lazy/conditional class definition) is
    // still a standalone global class, not a member of whatever class the method belongs to.
    // Without the gate, currentClass() unconditionally returned the top of the stack regardless
    // of depth, misattributing any function-local class as a real nested member class.
    const clsM = CLASS_RE.exec(stripped)
    if (clsM) {
      const kind = clsM[1] ?? 'class'
      const name = clsM[2] ?? ''
      const preLineDepth = braceDepth - openB + closeB
      const topFrame = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined
      const parent = topFrame !== undefined && preLineDepth === topFrame[1] + 1 ? topFrame[0] : null
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

    // property. Gated on the same "directly inside the class body" pre-line-depth check as the
    // method branch above - PROP_RE's modifier alternation includes `static`, which also matches
    // an ordinary function-local `static $var` declaration inside a method body. Without the
    // gate, that local variable was mistaken for a class property of whatever class happened to
    // still be on top of the context stack.
    const propM = PROP_RE.exec(stripped)
    if (propM) {
      const name = propM[1] ?? ''
      const preLineDepth = braceDepth - openB + closeB
      const topFrame = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined
      if (topFrame !== undefined && preLineDepth === topFrame[1] + 1) {
        symbols.push(makeLineSymbol(filePath, name, 'var', lineNum, stripped.slice(0, 200), topFrame[0]))
      }
      continue
    }

    // class constant. Gated on the same "directly inside the class body" pre-line-depth check as
    // the method and property branches above - an anonymous class body isn't pushed onto the
    // context stack (it never matches CLASS_RE), so a const declared inside one sits at a deeper
    // brace depth while a named outer class frame is still on top of the stack. Without the gate,
    // that const was mistaken for a constant of the enclosing named class.
    const constM = CONST_RE.exec(stripped)
    if (constM) {
      const name = constM[1] ?? ''
      const preLineDepth = braceDepth - openB + closeB
      const topFrame = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined
      const parent = topFrame !== undefined && preLineDepth === topFrame[1] + 1 ? topFrame[0] : undefined
      symbols.push(makeLineSymbol(filePath, name, 'const', lineNum, stripped.slice(0, 200), parent))
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
