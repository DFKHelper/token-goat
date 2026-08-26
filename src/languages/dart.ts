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

// `extension MyExtension on Type`, `extension on Type` (unnamed extensions), and the generic form
// `extension E<T> on List<T>`. The type-parameter list sits between the name and `on` with no space
// before it, so requiring `name` and `on` to be separated by whitespace alone rejected every
// generic extension -- and because no frame was pushed for it, every member inside its body was
// dropped from the index too, not just the extension itself.
const EXTENSION_RE = /^extension\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s+)?on\s+/

// `extension type Meters(int value)`, Dart 3.3's extension type declaration -- a zero-cost
// wrapper over a representation type. It shares the `extension` keyword prefix with EXTENSION_RE
// above but takes a literal `type` keyword and a `(repr)` primary-constructor instead of
// `on Type`, so EXTENSION_RE's `on\s+` requirement never matches it. Left unmatched, the line
// fell through to FUNC_RE, which misread the representation-type constructor's parens as a
// function call and mis-indexed the whole declaration as a plain top-level function named after
// the extension type -- and because no scope frame was pushed for it, every member declared
// inside the body was silently dropped from the index (real data loss, not just a wrong kind).
const EXTENSION_TYPE_RE = /^extension\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/

// `void foo()`, `int bar()`, `String baz()` — requires either `void` keyword or an explicit return type.
// This guards against matching function calls like `print("text")` as function declarations.
const FUNC_RE = /(?:^|\s)(?:static\s+)?(?:(?:void|Future|Stream|async|external)\s+|[A-Za-z_][A-Za-z0-9_<>]*(?:\s*\?)?\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/

// `int get value => 1;`, `String get name { ... }`, `static bool get ok => true`. A getter has no
// parameter list, so FUNC_RE (which anchors on the opening paren) never matched one, while the
// matching `set value(int v)` was picked up incidentally -- `set` reads as a return type to
// FUNC_RE. A class exposing a value through a getter/setter pair therefore indexed the write half
// and dropped the read half.
const GETTER_RE = /^(?:(?:static|external|abstract|covariant)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>,\s]*(?:\s*\?)?\s+)?get\s+([A-Za-z_][A-Za-z0-9_]*)/

// `A.named()`, `const A.from(...)`, `factory A.create() => ...`. The class name is checked against
// the enclosing frame at the call site rather than baked in here, which is what keeps this from
// matching an ordinary call: a call sits deeper than one brace inside the type, and a constructor
// declaration can only appear at exactly that depth. Only the named forms are indexed -- an
// unnamed `A()` carries no name of its own, and indexing it as `A` would make `read "f.dart::A"`
// ambiguous against the class declaration one line above it.
const NAMED_CTOR_RE = /^(?:(?:const|factory|external)\s+)*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/

// The unnamed form, `A()` / `const A()` / `A(this.x) : super(x)`, matched against the enclosing
// class name the same way. It is recognised only to be suppressed: FUNC_RE otherwise reads the
// leading modifier as a return type and files the constructor as a *function* named after the
// class, so the file ends up with two different symbols spelled `A`, which is exactly the
// collision skipping the unnamed form was meant to avoid.
const UNNAMED_CTOR_RE = /^(?:(?:const|factory|external)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\(/

// `final void Function() cb = ...`, `var x = compute();`, `const y = f();`. FUNC_RE only requires a
// word followed by `(`, so an initialiser call or a function-typed field looked exactly like a
// method declaration and produced a phantom symbol (`Function` for the callback field above). No
// Dart method declaration can begin with `final`, `var` or `const`, so a line that does is a field
// and never a method.
const FIELD_START_RE = /^(?:(?:static|covariant|late|external)\s+)*(?:final|var|const)\s/

// `class A = Object with M;`, a mixin-application class: a complete declaration with no body. It
// was pushed onto the type stack like any other class, and with no braces to close it the frame
// never popped, so the next top-level declaration was silently attributed to it and lost.
const CLASS_ALIAS_RE = /^(?:(?:abstract|base|interface|final|sealed|mixin)\s+)*class\s+[A-Za-z_][A-Za-z0-9_]*(?:<[^>]*>)?\s*=/

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
      const braceLine = stripStringLiterals(line, { tripleQuotes: true })
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
        symbols.push(makeLineSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
        // A mixin-application class has no body, so pushing a frame for it would never pop.
        if (!CLASS_ALIAS_RE.test(stripped)) {
          typeStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
        }
        matched = true
      }

      const em = !matched ? ENUM_RE.exec(stripped) : null
      if (em) {
        const ename = em[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, ename, 'enum', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
        typeStack.push({ name: ename, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      const mm = !matched ? MIXIN_RE.exec(stripped) : null
      if (mm) {
        const mname = mm[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, mname, 'mixin', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
        typeStack.push({ name: mname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      // Extension type checked before the plain `extension ... on` form -- both share the
      // `extension` keyword prefix, but only the extension-type form has a literal `type`
      // keyword next, so trying it first avoids relying on EXTENSION_RE's `on\s+` requirement
      // failing to fall through correctly.
      const etm = !matched ? EXTENSION_TYPE_RE.exec(stripped) : null
      if (etm) {
        const etname = etm[1] ?? ''
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, etname, 'extension_type', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
        typeStack.push({ name: etname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }

      const extm = !matched ? EXTENSION_RE.exec(stripped) : null
      if (extm) {
        const extname = extm[1] ?? 'extension'
        const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
        symbols.push(makeLineSymbol(filePath, extname, 'extension', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
        typeStack.push({ name: extname, startDepth: braceDepth, bodyEntered: false })
        matched = true
      }
    }

    // Methods/functions nested inside a type, or top-level functions
    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    if (!matched && frame !== null) {
      const depthInType = braceDepth - frame.startDepth
      if (depthInType === 1) {
        // Constructor first: `factory A.create() => ...` also satisfies FUNC_RE, which reads
        // `factory` as a return type and would index the declaration under the class name rather
        // than the constructor's own name. As with the type block above, each branch sets a flag
        // instead of `continue`-ing, so a same-line `{` still reaches the brace counter below.
        const cm = NAMED_CTOR_RE.exec(stripped)
        let member = false
        if (cm && cm[1] === frame.name) {
          symbols.push(makeLineSymbol(filePath, cm[2] ?? '', 'constructor', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          member = true
        }

        // Claimed, then deliberately dropped: see UNNAMED_CTOR_RE.
        const um = !member ? UNNAMED_CTOR_RE.exec(stripped) : null
        if (um && um[1] === frame.name) {
          member = true
        }

        // A field can carry an initialiser call that looks just like a declaration to FUNC_RE.
        if (!member && FIELD_START_RE.test(stripped)) {
          member = true
        }

        const gm = !member ? GETTER_RE.exec(stripped) : null
        if (gm) {
          symbols.push(makeLineSymbol(filePath, gm[1] ?? '', 'function', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          member = true
        }

        const fm = !member ? FUNC_RE.exec(stripped) : null
        if (fm) {
          let fname = fm[1] ?? ''
          // Normalize `operator +` to `+`
          fname = fname.replace(/^operator\s+/, '')
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
        }

        // Properties/fields in a class (var/final/etc)
        // For now, we skip property extraction to keep it simple
        // (properties would need complex parsing of multiple declarations per line)
      }
    } else if (!matched && frame === null && !isIndented && !FIELD_START_RE.test(stripped)) {
      // Top-level getter, then top-level function. Dart allows a getter at file scope
      // (`int get version => 1;`) and it was never looked for outside a class body.
      const gm = GETTER_RE.exec(stripped)
      if (gm) {
        symbols.push(makeLineSymbol(filePath, gm[1] ?? '', 'function', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
      }

      const fm = !gm ? FUNC_RE.exec(stripped) : null
      if (fm) {
        let fname = fm[1] ?? ''
        fname = fname.replace(/^operator\s+/, '')
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
      }
    }

    // Brace-count on a string-stripped copy
    const braceLine = stripStringLiterals(line, { tripleQuotes: true })
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
