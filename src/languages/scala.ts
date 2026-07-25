/**
 * Scala symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, objects, traits, case classes, functions (def),
 * fields (val/var), and `import` directives.
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

// `import scala.util.matching.Regex` or `import java.util._` (wildcard imports)
const IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\._)?)/

// `import foo.bar.{A, B, C}` -- Scala's idiomatic multi-selector import. IMPORT_RE alone can't
// express this: its character class stops at `{`, so it captures only the truncated,
// non-actionable prefix `foo.bar.` and silently drops every selector actually being imported.
const BRACE_IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)\.\{([^}]*)\}/

// `class Foo`, `class Foo[T]`, `class Foo(x: Int)`, `class Foo extends Base`
// Also matches `case class Foo`
const CLASS_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|\[|\(|:|$)/

// `object Singleton`, `object Foo extends Base`
const OBJECT_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*object\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|:|$)/

// `trait Viewable`, `trait Comparable[T]`
const TRAIT_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*trait\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|\[|:|$)/

// Scala function/method: `def foo()`, `def bar[T]()`, `def baz: Int` (no-arg form),
// can also be infix operators like `def +(other: Int)`. Generics come between name and params.
const FUNC_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*def\s+([A-Za-z_][A-Za-z0-9_]*|[+\-*/%=!<>&|^~]+)(?:\s*\[|\s*\(|\s*:)/

// `val x: Int = 5`, `val y = "hello"`, `lazy val config = ...`
// Scala allows `val` to bind multiple names in pattern-match style (`val (a, b) = tuple`),
// but for simplicity we extract only the first word-boundary identifier after `val`.
const VAL_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*val\s+([A-Za-z_][A-Za-z0-9_]*)/

// `var x: Int = 5`, `var y = "hello"` — same pattern as val.
const VAR_RE = /^\s*(?:implicit|lazy|sealed|abstract|final|private|protected|override|covariant|contravariant|case)?\s*var\s+([A-Za-z_][A-Za-z0-9_]*)/

export function extractScala(
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

    // Strip /* */ block-comment spans (state carried across lines via inComment) so braces
    // inside commented-out code are not counted toward braceDepth.
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment so braces/text after it are ignored.
    const line = stripLineComment(blockStripped).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripStringLiterals(line)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // import
    const braceImportM = BRACE_IMPORT_RE.exec(stripped)
    if (braceImportM) {
      const base = braceImportM[1] ?? ''
      // Each selector may itself be a rename (`Old => New`) or the wildcard `_` -- for a rename
      // the imported symbol is the left-hand (original) name, matching what call sites actually
      // reference; a bare `_` means "everything under base", so keep it as base._ rather than
      // emitting a bogus `base._` per underscore.
      const selectors = (braceImportM[2] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
      for (const sel of selectors) {
        const original = sel.split(/\s*=>\s*/)[0]?.trim() ?? sel
        if (original === '') continue
        imports.push({ kind: 'import', target: original === '_' ? `${base}._` : `${base}.${original}`, line: lineNum })
      }
    } else {
      const importM = IMPORT_RE.exec(stripped)
      if (importM) {
        imports.push({ kind: 'import', target: importM[1] ?? '', line: lineNum })
      }
    }

    // class/object/trait — recognized at column 0 (top-level), or indented while
    // one brace level inside another type's body (a real nested type member).
    // Matches kotlin.ts's classDetectionGateOk pattern.
    const outerFrame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    const outerDepthInType = outerFrame !== null ? braceDepth - outerFrame.startDepth : 0
    const typeDetectionGateOk = typeStack.length === 0 || outerDepthInType === 1
    // `matched` tracks whether this line was already classified as a class/object/trait/
    // func/val/var declaration. Unlike an early `continue`, classification must still fall
    // through to the brace-counting block below so a same-line opening `{` (e.g. `class Foo {`
    // or `def foo(): Unit = {`) is counted and can flip `bodyEntered` -- skipping that via
    // `continue` was the original bug: a same-line brace was silently dropped, `bodyEntered`
    // never flipped true, the frame never popped, and `typeDetectionGateOk` stayed false for
    // every subsequent top-level declaration in the file (mirrors kotlin.ts's real pattern,
    // which pushes the frame but does NOT `continue` -- it falls through to brace-counting).
    let matched = false

    const cm = typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? CLASS_RE.exec(stripped) : null
    if (cm) {
      const cname = cm[1] ?? ''
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200), parent))
      typeStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
      matched = true
    }

    const om = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? OBJECT_RE.exec(stripped) : null
    if (om) {
      const oname = om[1] ?? ''
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, oname, 'object', lineNum, stripped.slice(0, 200), parent))
      typeStack.push({ name: oname, startDepth: braceDepth, bodyEntered: false })
      matched = true
    }

    const tm = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? TRAIT_RE.exec(stripped) : null
    if (tm) {
      const tname = tm[1] ?? ''
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, tname, 'trait', lineNum, stripped.slice(0, 200), parent))
      typeStack.push({ name: tname, startDepth: braceDepth, bodyEntered: false })
      matched = true
    }

    // Methods/functions nested inside a type, or top-level functions.
    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    if (!matched && frame !== null) {
      const depthInType = braceDepth - frame.startDepth
      // === 1, not >= 1: a local def inside a method body sits at depthInType 2+
      // (matches kotlin.ts/csharp.ts, which gate the same way).
      if (depthInType === 1) {
        const fm = FUNC_RE.exec(stripped)
        if (fm) {
          symbols.push(makeLineSymbol(filePath, fm[1] ?? '', 'function', lineNum, stripped.slice(0, 200), frame.name))
          matched = true
        }

        const vm = !matched ? VAL_RE.exec(stripped) : null
        if (vm) {
          symbols.push(makeLineSymbol(filePath, vm[1] ?? '', 'val', lineNum, stripped.slice(0, 200), frame.name))
          matched = true
        }

        if (!matched) {
          const varm = VAR_RE.exec(stripped)
          if (varm) {
            symbols.push(makeLineSymbol(filePath, varm[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
          }
        }
      }
    } else if (!matched && frame === null && !isIndented) {
      // Top-level function.
      const fm = FUNC_RE.exec(stripped)
      if (fm) {
        symbols.push(makeLineSymbol(filePath, fm[1] ?? '', 'function', lineNum, stripped.slice(0, 200)))
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
