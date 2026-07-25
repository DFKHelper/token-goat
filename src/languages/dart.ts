/**
 * Dart symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, enums, mixins, extensions, methods, properties,
 * top-level functions and variables.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripStringLiterals,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface TypeFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
}

// `class Foo`, `class Foo<T>`, `class Foo extends Base`, `class Foo implements Interface`.
// A class declaration can carry leading modifiers: the long-standing `abstract`, and Dart 3's
// `base`/`interface`/`final`/`sealed` class modifiers, plus `mixin class` (a class usable as a
// mixin), in any legal combination (`abstract base class`, `abstract interface class`, ...).
// Anchoring on a bare `^class` dropped every one of these -- most importantly the ubiquitous
// `abstract class Foo` -- from the index entirely (the type AND every member nested in it),
// the same modifier-alternation gap already fixed for the C# and PHP extractors. `mixin` is
// included here so `mixin class Foo` resolves as a class; a plain `mixin Foo` has no `class`
// keyword after it, so it falls through to MIXIN_RE below instead.
const CLASS_RE = /^(?:(?:abstract|base|interface|final|sealed|mixin)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/

// `enum Color { red, green, blue }` (Dart enums take no class modifiers, so no prefix here).
const ENUM_RE = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/

// `mixin MyMixin`, `mixin MyMixin on BaseClass`, and Dart 3's `base mixin MyMixin`.
const MIXIN_RE = /^(?:base\s+)?mixin\s+([A-Za-z_][A-Za-z0-9_]*)/

// `extension MyExtension on Type`, `extension on Type` (unnamed extensions)
const EXTENSION_RE = /^extension\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?on\s+/

// `void foo()`, `int bar()`, `String baz()` — requires either `void` keyword or an explicit return type.
// This guards against matching function calls like `print("text")` as function declarations.
const FUNC_RE = /(?:^|\s)(?:static\s+)?(?:(?:void|Future|Stream|async|external)\s+|[A-Za-z_][A-Za-z0-9_<>]*(?:\s*\?)?\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/

// Variable declarations not extracted at this time — would need complex parsing of
// multi-variable declarations on a single line (e.g., `var x = 1, y = 2;`)
// or destructuring patterns.

export function extractDart(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const typeStack: TypeFrame[] = []
  let braceDepth = 0
  let inComment = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip /* */ block-comment spans
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment
    const line = stripLineComment(blockStripped).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripStringLiterals(line)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // class/enum/mixin/extension — recognized at column 0 (top-level), or indented
    // while one brace level inside another type's body (a real nested type member).
    const outerFrame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    const outerDepthInType = outerFrame !== null ? braceDepth - outerFrame.startDepth : 0
    const typeDetectionGateOk = typeStack.length === 0 || outerDepthInType === 1

    // `matched` tracks classification without an early `continue`, so a same-line opening
    // `{` (e.g. `class Foo {`) still falls through to the brace-counting block below and can
    // flip `bodyEntered` -- an early `continue` here would silently drop that brace, leave
    // `bodyEntered` false forever, and corrupt `typeDetectionGateOk` for every subsequent
    // top-level declaration in the file (same bug class fixed in scala.ts).
    let matched = false

    if (typeDetectionGateOk && (!isIndented || typeStack.length > 0)) {
      const cm = CLASS_RE.exec(stripped)
      if (cm) {
        const cname = cm[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200), parent))
        typeStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      const em = !matched ? ENUM_RE.exec(stripped) : null
      if (em) {
        const ename = em[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, ename, 'enum', lineNum, stripped.slice(0, 200), parent))
        typeStack.push({ name: ename, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      const mm = !matched ? MIXIN_RE.exec(stripped) : null
      if (mm) {
        const mname = mm[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, mname, 'mixin', lineNum, stripped.slice(0, 200), parent))
        typeStack.push({ name: mname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      const extm = !matched ? EXTENSION_RE.exec(stripped) : null
      if (extm) {
        const extname = extm[1] ?? 'extension'
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, extname, 'extension', lineNum, stripped.slice(0, 200), parent))
        typeStack.push({ name: extname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }
    }

    // Methods/functions nested inside a type, or top-level functions
    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    if (!matched && frame !== null) {
      const depthInType = braceDepth - frame.startDepth
      if (depthInType === 1) {
        const fm = FUNC_RE.exec(stripped)
        if (fm) {
          let fname = fm[1] ?? ''
          // Normalize `operator +` to `+`
          fname = fname.replace(/^operator\s+/, '')
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), frame.name))
        }

        // Properties/fields in a class (var/final/etc)
        // For now, we skip property extraction to keep it simple
        // (properties would need complex parsing of multiple declarations per line)
      }
    } else if (!matched && frame === null && !isIndented) {
      // Top-level function
      const fm = FUNC_RE.exec(stripped)
      if (fm) {
        let fname = fm[1] ?? ''
        fname = fname.replace(/^operator\s+/, '')
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
    }

    // Brace-count on a string-stripped copy
    const braceLine = stripStringLiterals(line)
    for (const ch of braceLine) {
      if (ch === '{') {
        braceDepth++
        if (frame !== null && braceDepth > frame.startDepth) {
          frame.bodyEntered = true
        }
      } else if (ch === '}') {
        braceDepth--
      }
    }

    // Pop finished type frames
    while (typeStack.length > 0) {
      const top = typeStack[typeStack.length - 1]!
      if (top.bodyEntered && braceDepth <= top.startDepth) {
        typeStack.pop()
      } else {
        break
      }
    }
  }

  return { symbols, imports }
}
